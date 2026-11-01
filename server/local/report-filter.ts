import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import type { LocalReportEvidence, LocalReportFilter, LocalReportFilterResult, Report } from '../../src/contracts/domain-models.js'
import { EVENTS_CSV_HEADER } from '../../src/contracts/domain-models.js'
import type { AfsimEventLog } from '../../src/features/data-exchange/afsim-event-log.js'
import { parseCsvLine } from '../../src/features/data-exchange/csv-contract.js'
import { isLocalReport, parseLocalReportFilter } from '../../src/features/reports/local-report.js'
import type { LocalReplaySnapshot } from '../../src/features/replays/local-replay.js'
import type { MissionResultRecord, MissionResultSnapshot } from '../../src/features/results/mission-result.js'
import { readStableUtf8Lines } from './afsim-log-reader.js'

interface IndexedEvent { time: number; type: string; id: string; subject?: string; target?: string; device?: string; linkId?: string; stage?: string; scope?: 'INTERNAL' | 'INTER_PLATFORM'; sourceDeviceId?: string; targetDeviceId?: string }
interface LinkBinding { id: string; nodes: string[] }
interface IndexManifest { version: 1; resultId: string; reportId: string; sourceSha256: string; positionSha256: string; rowCount: number; sha256: string; links: LinkBinding[]; bindingsSha256: string }
interface BuildOptions { devices: unknown; canonicalEventsPath?: string }
const DEVICE_TYPES = /^(COMM_TURNED_(ON|OFF)|WEAPON_TURNED_(ON|OFF)|WEAPON_MODE_(ACTIVATED|DEACTIVATED)|JAMMING_REQUEST_(INITIATED|UPDATED|CANCELED))$/
const DETAIL_LIMIT = 500
const indexPath = (directory: string, id: string) => join(directory, `${id}.report-index.ndjson`)
const manifestPath = (directory: string, id: string) => join(directory, `${id}.report-index.json`)
const value = (fields: Record<string, string>, ...names: string[]) => names.map(name => fields[name]).find((item): item is string => typeof item === 'string' && item.length > 0)

function bindings(raw: unknown): { byDevice: Map<string, string>; links: LinkBinding[] } {
  if (!Array.isArray(raw)) return { byDevice: new Map(), links: [] }
  const byDevice = new Map<string, string>(), links: LinkBinding[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>, id = row.linkId, source = row.source as Record<string, unknown> | undefined, target = row.target as Record<string, unknown> | undefined, relay = row.relay as Record<string, unknown> | null | undefined
    if (typeof id !== 'string' || !source || !target || typeof source.platformId !== 'string' || typeof target.platformId !== 'string') continue
    links.push({ id, nodes: [source.platformId, target.platformId, ...(relay && typeof relay.platformId === 'string' ? [relay.platformId] : [])] })
    for (const endpoint of [source, target, relay ?? {}]) if (typeof endpoint.platformId === 'string') for (const key of ['deviceId', 'ingressDeviceId', 'egressDeviceId']) if (typeof endpoint[key] === 'string') byDevice.set(`${endpoint.platformId}\0${endpoint[key]}`, id)
  }
  return { byDevice, links: [...new Map(links.map(link => [link.id, link])).values()] }
}

function eventRow(event: AfsimEventLog['events'][number], byDevice: Map<string, string>): IndexedEvent {
  const target = value(event.fields, 'target_platform', 'TargetPlatform', 'destination_platform'), subject = (value(event.fields, 'source_platform') ?? event.subject) || undefined
  const sourceDeviceId = value(event.fields, 'source_comm', 'source_device', 'comm', 'Comm', 'system'), targetDeviceId = value(event.fields, 'destination_comm', 'target_comm', 'target_device')
  const linkId = value(event.fields, 'link_id', 'linkId', 'LinkId') ?? (subject && sourceDeviceId ? byDevice.get(`${subject}\0${sourceDeviceId}`) : undefined) ?? (target && targetDeviceId ? byDevice.get(`${target}\0${targetDeviceId}`) : undefined)
  const stage = value(event.fields, 'stage', 'Stage', 'task_stage')
  const row: IndexedEvent = { time: event.time, type: event.type, id: event.id, ...(subject ? { subject } : {}), ...(target ? { target } : {}), ...(sourceDeviceId ? { device: sourceDeviceId, sourceDeviceId } : {}), ...(targetDeviceId ? { targetDeviceId } : {}), ...(linkId ? { linkId } : {}), ...(stage ? { stage } : {}) }
  if (event.type === 'LINK_ADDED_TO_MANAGER' && subject && target) row.scope = subject === target ? 'INTERNAL' : 'INTER_PLATFORM'
  return row
}

function canonicalRow(line: string, headers: string[], byDevice: Map<string, string>): IndexedEvent {
  const cells = parseCsvLine(line); if (!cells || cells.length !== headers.length) throw new Error('连续事件索引行无效。')
  const data = Object.fromEntries(headers.map((key, index) => [key, cells[index] ?? ''])), time = Number(data.Time)
  if (!Number.isFinite(time) || time < 0 || !data.EventType) throw new Error('连续事件索引时刻无效。')
  let parameters: Record<string, unknown> = {}; try { parameters = data.Parameters ? JSON.parse(data.Parameters) as Record<string, unknown> : {} } catch { throw new Error('连续事件索引参数无效。') }
  const fields = parameters.fields && typeof parameters.fields === 'object' && !Array.isArray(parameters.fields) ? parameters.fields as Record<string, string> : {}
  if (!fields.target_platform && data.TargetPlatform) fields.target_platform = data.TargetPlatform
  return eventRow({ time, type: data.EventType, id: typeof parameters.eventId === 'string' ? parameters.eventId : `CANONICAL-${parameters.sourceLine ?? time}`, sourceLine: 0, endLine: 0, subject: data.SourcePlatform, fields }, byDevice)
}

/** Publish a source-bound sidecar. Large canonical input is streamed, never materialised as an event array. */
export async function publishReportFilterIndex(directory: string, record: MissionResultRecord, report: Report, replay: LocalReplaySnapshot, log: AfsimEventLog & { source: { sha256: string } }, options: BuildOptions): Promise<void> {
  if (!isLocalReport(report) || !log.valid || report.localEvidence.eventFile.sha256 !== log.source.sha256 || report.localEvidence.positionFile.sha256 !== replay.sha256) throw new Error('报告筛选索引的来源不一致。')
  const { byDevice, links } = bindings(options.devices), path = indexPath(directory, record.resultId), manifestFile = manifestPath(directory, record.resultId), pending = `${path}.pending`, pendingManifest = `${manifestFile}.pending`, writer = createWriteStream(pending, { encoding: 'utf8', flags: 'wx' }), hash = createHash('sha256')
  const writerFinished = finished(writer, { cleanup: true })
  // 读取输入期间也捕获异步文件错误，防止写盘失败成为未处理事件。
  void writerFinished.catch(() => undefined)
  let rows = 0
  const write = async (row: IndexedEvent) => { const line = `${JSON.stringify(row)}\n`; hash.update(line); rows += 1; if (!writer.write(line)) await Promise.race([once(writer, 'drain'), writerFinished]) }
  try {
    if ('messageDetailsComplete' in log && log.messageDetailsComplete === false) {
      if (!options.canonicalEventsPath) throw new Error('大型事件缺少已核验的连续归档。')
      const headers = EVENTS_CSV_HEADER.split(','), canonical = await readStableUtf8Lines(options.canonicalEventsPath, async (line, lineNumber) => { if (lineNumber === 1) { if (line !== EVENTS_CSV_HEADER) throw new Error('连续事件索引表头不正确。'); return } await write(canonicalRow(line, headers, byDevice)) }, 2 * 1024 * 1024 * 1024)
      if (canonical.waitingForLine) throw new Error('连续事件索引含未完成尾行。')
    } else for (const event of log.events) await write(eventRow(event, byDevice))
    writer.end(); await writerFinished
    if (rows !== report.localEvidence.eventCount) throw new Error('筛选索引缺少完整事件记录。')
    const manifest: IndexManifest = { version: 1, resultId: record.resultId, reportId: report.reportId, sourceSha256: log.source.sha256, positionSha256: replay.sha256, rowCount: rows, sha256: hash.digest('hex'), links, bindingsSha256: createHash('sha256').update(JSON.stringify(links)).digest('hex') }
    await writeFile(pendingManifest, JSON.stringify(manifest), { encoding: 'utf8', flag: 'wx' }); await rename(pending, path); await rename(pendingManifest, manifestFile)
  } catch (error) { writer.destroy(); await writerFinished.catch(() => undefined); throw error }
}

async function manifestFor(directory: string, snapshot: MissionResultSnapshot): Promise<IndexManifest> {
  const report = snapshot.report; if (!isLocalReport(report)) throw new Error('FILTER_UNSUPPORTED')
  const path = manifestPath(directory, snapshot.record.resultId)
  let manifest: IndexManifest; try { const state = await lstat(path); if (!state.isFile() || state.isSymbolicLink() || state.size > 1024 * 1024) throw new Error('invalid'); manifest = JSON.parse(await readFile(path, 'utf8')) as IndexManifest } catch { throw new Error('FILTER_UNSUPPORTED') }
  if (Object.keys(manifest).length !== 9 || !['version', 'resultId', 'reportId', 'sourceSha256', 'positionSha256', 'rowCount', 'sha256', 'links', 'bindingsSha256'].every(key => Object.hasOwn(manifest, key)) || manifest.version !== 1 || manifest.resultId !== snapshot.record.resultId || manifest.reportId !== report.reportId || manifest.sourceSha256 !== report.localEvidence.eventFile.sha256 || manifest.positionSha256 !== report.localEvidence.positionFile.sha256 || !Number.isSafeInteger(manifest.rowCount) || manifest.rowCount < 0 || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !/^[a-f0-9]{64}$/.test(manifest.bindingsSha256) || !Array.isArray(manifest.links) || manifest.links.length > 10_000 || manifest.links.some(link => !link || typeof link.id !== 'string' || !link.id || !Array.isArray(link.nodes) || !link.nodes.length || link.nodes.length > 3 || link.nodes.some(node => typeof node !== 'string' || !node)) || createHash('sha256').update(JSON.stringify(manifest.links)).digest('hex') !== manifest.bindingsSha256) throw new Error('FILTER_UNSUPPORTED')
  return manifest
}

/** Scan the index once with fixed-size accumulators. No event array is sent to the browser or assembled in memory. */
export async function filterMissionReport(directory: string, snapshot: MissionResultSnapshot, input: LocalReportFilter): Promise<LocalReportFilterResult> {
  const filter = parseLocalReportFilter(input), report = snapshot.report
  if (!filter || !isLocalReport(report)) throw new Error('FILTER_UNSUPPORTED')
  const phases = snapshot.parameters?.phases ?? [], phase = filter.stage ? phases.find(item => item.id === filter.stage) : undefined
  if (filter.stage && !phases.length) throw new Error('FILTER_UNSUPPORTED')
  if (filter.stage && !phase) throw new Error('FILTER_INVALID')
  const manifest = await manifestFor(directory, snapshot), nodeIds = new Set(report.localEvidence.nodes.map(node => node.platformId)), link = filter.linkId ? manifest.links.find(item => item.id === filter.linkId) : undefined
  if ((filter.nodeId && !nodeIds.has(filter.nodeId)) || (filter.linkId && !link)) throw new Error('FILTER_INVALID')
  if (filter.nodeId && link && !link.nodes.includes(filter.nodeId)) throw new Error('FILTER_INVALID')
  if ((filter.from !== undefined && (filter.from < report.localEvidence.startTimeS || filter.from > report.localEvidence.endTimeS)) || (filter.to !== undefined && (filter.to < report.localEvidence.startTimeS || filter.to > report.localEvidence.endTimeS))) throw new Error('FILTER_INVALID')
  const rangeStart = Math.max(filter.from ?? report.localEvidence.startTimeS, phase?.startTimeS ?? report.localEvidence.startTimeS)
  const rangeEnd = Math.min(filter.to ?? report.localEvidence.endTimeS, phase?.endTimeS ?? report.localEvidence.endTimeS)
  if (rangeStart > rangeEnd) throw new Error('FILTER_INVALID')
  const includePhaseEnd = phase?.endTimeS === report.localEvidence.endTimeS && !phases.some(item => item.startTimeS === phase?.endTimeS)
  const inRange = (time: number) => time >= rangeStart && time <= rangeEnd
    && (!phase || time < phase.endTimeS || includePhaseEnd)
  const allowedNodes = new Set(filter.nodeId ? [filter.nodeId] : link ? link.nodes : nodeIds), counts = new Map<string, number>(), relatedNodeIds = new Set<string>(), timeline: LocalReportFilterResult['timeline'] = [], connections: LocalReportEvidence['connections'] = [], deviceEvents: LocalReportEvidence['deviceEvents'] = []
  let rows = 0, selected = 0, totalTimeline = 0; const hash = createHash('sha256')
  let source: Awaited<ReturnType<typeof readStableUtf8Lines>>
  try { source = await readStableUtf8Lines(indexPath(directory, snapshot.record.resultId), line => {
    hash.update(`${line}\n`); rows += 1; let row: IndexedEvent; try { row = JSON.parse(line) as IndexedEvent } catch { throw new Error('FILTER_UNSUPPORTED') }
    if (!Number.isFinite(row.time) || row.time < 0 || typeof row.id !== 'string' || !row.id || typeof row.type !== 'string' || !row.type) throw new Error('FILTER_UNSUPPORTED')
    const touches = !filter.nodeId || row.subject === filter.nodeId || row.target === filter.nodeId
    if (!touches || (filter.linkId && row.linkId !== filter.linkId) || !inRange(row.time)) return
    selected += 1; counts.set(row.type, (counts.get(row.type) ?? 0) + 1); totalTimeline += 1
    if (timeline.length < 500) timeline.push({ id: row.id, time: row.time, type: row.type, subject: row.subject ?? '未提供', ...(row.target ? { target: row.target } : {}), ...(row.device ? { device: row.device } : {}), ...(row.stage ? { stage: row.stage } : {}) })
    if (connections.length < DETAIL_LIMIT && row.type === 'LINK_ADDED_TO_MANAGER' && row.subject && row.target) { if (!allowedNodes.has(row.subject)) relatedNodeIds.add(row.subject); if (!allowedNodes.has(row.target)) relatedNodeIds.add(row.target); connections.push({ eventId: row.id, time: row.time, scope: row.scope ?? (row.subject === row.target ? 'INTERNAL' : 'INTER_PLATFORM'), sourcePlatformId: row.subject, sourceDeviceId: row.sourceDeviceId ?? row.device ?? '未提供', targetPlatformId: row.target, targetDeviceId: row.targetDeviceId ?? '未提供' }) }
    if (deviceEvents.length < DETAIL_LIMIT && DEVICE_TYPES.test(row.type) && row.subject && allowedNodes.has(row.subject)) deviceEvents.push({ eventId: row.id, type: row.type, time: row.time, platformId: row.subject, deviceId: row.device ?? '未提供' })
  }, 2 * 1024 * 1024 * 1024) } catch { throw new Error('FILTER_UNSUPPORTED') }
  if (source.waitingForLine || rows !== manifest.rowCount || hash.digest('hex') !== manifest.sha256) throw new Error('FILTER_UNSUPPORTED')
  const tracks = new Map(snapshot.replay.tracks.map(track => [track.platformId, track.positions]))
  const nodes = report.localEvidence.nodes.filter(node => allowedNodes.has(node.platformId)).map(node => { const points = (tracks.get(node.platformId) ?? []).filter(point => inRange(point.time)); return { ...node, positionCount: points.length, firstTimeS: points[0]?.time ?? rangeStart, lastTimeS: points.at(-1)?.time ?? rangeStart } })
  const messageEvidence = report.localEvidence.messageDetailsComplete === false
    ? { messageDetailsComplete: false as const, messageDetailEventCount: [...counts].filter(([type]) => type.startsWith('MESSAGE_')).reduce((sum, [, count]) => sum + count, 0) }
    : {}
  // 侦测规范事件按同一时间与节点范围收窄；事件类型须仍在筛选后的分类计数中，避免引用已排除的记录。
  const detectionEvents = report.localEvidence.detectionEvents?.filter(row => inRange(row.time) && counts.has(row.type)
    && allowedNodes.has(row.platformId) && (!filter.nodeId || row.platformId === filter.nodeId || row.targetPlatformId === filter.nodeId))
  const { detectionEvents: _unfiltered, ...baseEvidence } = report.localEvidence
  const evidence: LocalReportEvidence = { ...baseEvidence, ...messageEvidence, startTimeS: rangeStart, endTimeS: rangeEnd, simulationComplete: counts.has('SIMULATION_COMPLETE'), nodes, ...(relatedNodeIds.size ? { relatedNodeIds: [...relatedNodeIds].sort() } : {}), positionCount: nodes.reduce((sum, node) => sum + node.positionCount, 0), eventCount: selected, eventCounts: [...counts].sort(([type], [other]) => type.localeCompare(other)).map(([type, count]) => ({ type, count })), connections, deviceEvents,
    ...(detectionEvents?.length ? { detectionEvents } : {}) }
  const filtered: Report = { ...report, localEvidence: evidence }; if (!isLocalReport(filtered)) throw new Error('FILTER_UNSUPPORTED')
  timeline.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
  return { report: filtered, filter, timeline, timelineTotal: totalTimeline, stages: phases.map(item => item.id), links: manifest.links.map(item => item.id).sort() }
}

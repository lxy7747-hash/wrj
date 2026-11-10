import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { EngineFrameArchiveEventRow, EngineFrameArchiveSegmentRow, EngineFrameArchiveSummary, EngineFrameArchiveSwitchRow, EngineFrameSnapshot } from '../../src/contracts/domain-models.js'
import { isEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot.js'
import { readStableUtf8Lines } from './afsim-log-reader.js'
import { createEngineCsvSession, getEngineCsvFile, publishEngineCsv, type EngineCsvEvidence, type EngineLinkBinding } from './engine-frame-csv.js'
import type { LinkType } from '../../src/contracts/domain-models.js'
import type { EngineFrameSqliteStorage } from './engine-frame-sqlite.js'
import type { EngineReplaySnapshot } from '../../src/features/replays/engine-replay.js'

const safeRunId = (value: string) => /^RUN-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const MAX_PENDING_WRITES = 512
const SYNC_EVERY_FRAMES = 32
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
/** Browser report evidence is bounded; the complete JSONL generation remains hash-addressable on disk. */
const MAX_REPORT_ROWS = 50_000

export interface EngineFrameArchiveScope {
  taskId: string
  runId: string
  scenarioId: string
  revision: number
  startedAt: string
}

export interface EngineFrameArchiveSession {
  append(frame: EngineFrameSnapshot): Promise<void>
  close(): Promise<void>
  failure(): Error | null
}

export interface EngineFrameArchive {
  begin(scope: EngineFrameArchiveScope, linkBindings?: Readonly<Record<string, EngineLinkBinding>>): Promise<EngineFrameArchiveSession>
  load(runId: string, expectedScope?: EngineFrameArchiveScope, selection?: { start: number; end: number; nodeId?: string; linkId?: string }): Promise<EngineFrameArchiveSummary | null>
  getFile(runId: string, sourceSha256: string): Promise<string | null>
  finalizeCsv(runId: string, expectedScope: EngineFrameArchiveScope, linkBindings: Readonly<Record<string, EngineLinkBinding>>): Promise<EngineCsvEvidence | null>
  getCsvFile(runId: string, sourceSha256: string, fileName: string): Promise<string | null>
  replay(runId: string, expectedScope: EngineFrameArchiveScope, time: number, engineEpoch?: number): Promise<EngineReplaySnapshot | null>
  aggregate(runId: string, expectedScope: EngineFrameArchiveScope, linkBindings: Readonly<Record<string, EngineLinkBinding>>, selection?: { start: number; end: number; nodeId?: string; linkId?: string }): Promise<{ uniqueSingleSegmentCount: number; averageGxbDb?: number; averageBer?: number; switchCount: number; missing: string[] } | null>
}

type Manifest = {
  schemaVersion: '1.0'
  scope: EngineFrameArchiveScope
  sourceSha256: string
  frameCount: number
  firstSimulationTime: number | null
  lastSimulationTime: number | null
  missingFieldNames: string[]
  completedAt: string
  fileName: string
  linkBindings?: Record<string, EngineLinkBinding>
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const linkTypes = new Set<LinkType>(['SAT', 'MICROWAVE', 'DATALINK', 'LASER', 'FIBER'])
function isLinkBindings(value: unknown): value is Record<string, EngineLinkBinding> {
  return isObject(value) && Object.entries(value).every(([id, binding]) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)
    && isObject(binding) && Object.keys(binding).every(key => ['type', 'sourcePlatformId', 'targetPlatformId', 'relayPlatformId'].includes(key))
    && typeof binding.type === 'string' && linkTypes.has(binding.type as LinkType)
    && typeof binding.sourcePlatformId === 'string' && binding.sourcePlatformId.length > 0
    && typeof binding.targetPlatformId === 'string' && binding.targetPlatformId.length > 0
    && (binding.relayPlatformId === undefined || binding.relayPlatformId === null || (typeof binding.relayPlatformId === 'string' && binding.relayPlatformId.length > 0)))
}
function isManifest(value: unknown, runId: string): value is Manifest {
  return isObject(value) && value.schemaVersion === '1.0' && isObject(value.scope) && value.scope.runId === runId
    && typeof value.sourceSha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sourceSha256)
    && typeof value.frameCount === 'number' && Number.isSafeInteger(value.frameCount) && value.frameCount >= 0
    && (value.firstSimulationTime === null || (typeof value.firstSimulationTime === 'number' && Number.isFinite(value.firstSimulationTime)))
    && (value.lastSimulationTime === null || (typeof value.lastSimulationTime === 'number' && Number.isFinite(value.lastSimulationTime)))
    && Array.isArray(value.missingFieldNames) && value.missingFieldNames.every(field => typeof field === 'string')
    && typeof value.completedAt === 'string' && typeof value.fileName === 'string' && /^engine-[0-9a-f-]{36}\.jsonl$/u.test(value.fileName) && (value.linkBindings === undefined || isLinkBindings(value.linkBindings))
}

function isCsvEvidence(value: unknown, sourceSha256: string): value is EngineCsvEvidence {
  if (!isObject(value) || value.sourceSha256 !== sourceSha256 || !Array.isArray(value.files) || !Array.isArray(value.missing)) return false
  return value.files.every(file => isObject(file) && Object.keys(file).every(key => ['fileName', 'rowCount', 'sha256', 'status', 'skippedCount', 'reason'].includes(key))
    && typeof file.fileName === 'string' && /^([a-f0-9]{64})$/u.test(String(file.sha256)) && Number.isSafeInteger(file.rowCount) && Number(file.rowCount) > 0
    && (file.status === 'COMPLETE' || file.status === 'PARTIAL') && Number.isSafeInteger(file.skippedCount) && Number(file.skippedCount) >= 0
    && (file.reason === undefined || (typeof file.reason === 'string' && file.reason.length > 0)))
    && value.missing.every(file => isObject(file) && Object.keys(file).every(key => ['fileName', 'status', 'reason'].includes(key)) && typeof file.fileName === 'string' && file.status === 'SOURCE_MISSING' && typeof file.reason === 'string' && file.reason.length > 0)
}

async function regularFile(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('引擎帧归档必须是普通文件。')
}

/**
 * Persists accepted engine frames outside the bounded WebSocket journal.  Each run receives
 * an immutable JSONL generation and a pointer that is published only after the writer flushes.
 */
export function createEngineFrameArchive(directory: string, now: () => string, limits: { maxReportRows?: number; database?: EngineFrameSqliteStorage } = {}): EngineFrameArchive {
  const root = resolve(directory)
  const maxReportRows = limits.maxReportRows ?? MAX_REPORT_ROWS
  if (!Number.isSafeInteger(maxReportRows) || maxReportRows < 1) throw new RangeError('引擎帧报告明细上限无效。')
  const runDirectory = (runId: string) => {
    if (!safeRunId(runId)) return null
    const candidate = resolve(root, runId)
    const outside = relative(root, candidate)
    return outside === '..' || outside.startsWith(`..${sep}`) ? null : candidate
  }

  return {
    async begin(scope, linkBindings = {}) {
      const runRoot = runDirectory(scope.runId)
      if (!runRoot) throw new Error('引擎帧归档运行标识无效。')
      await mkdir(runRoot, { recursive: true })
      const run = await lstat(runRoot)
      if (!run.isDirectory() || run.isSymbolicLink()) throw new Error('引擎帧归档运行目录必须为普通目录。')
      await limits.database?.begin(scope, linkBindings)
      const id = randomUUID()
      const pending = join(runRoot, `.engine-${id}.pending`)
      const target = join(runRoot, `engine-${id}.jsonl`)
      const handle = await open(pending, 'wx')
      let csv: Awaited<ReturnType<typeof createEngineCsvSession>>
      try { csv = await createEngineCsvSession(join(runRoot, 'csv'), scope.taskId, linkBindings) }
      catch (error) { await handle.close().catch(() => undefined); await unlink(pending).catch(() => undefined); throw error }
      const hash = createHash('sha256')
      const seen = new Set<string>()
      const missing = new Set<string>()
      let frameCount = 0
      let first: number | null = null
      let last: number | null = null
      let closed = false
      let closePromise: Promise<void> | undefined
      const queue: Array<{ frame: EngineFrameSnapshot; line: string }> = []
      let draining: Promise<void> | undefined
      let failure: Error | null = null
      let invalid: Error | null = null
      let position = 0
      let handleClosed = false
      let rawPublished = false
      let csvPublished = false
      let rebuildCsv = false
      let manifest: Manifest | undefined
      let sinceSync = 0
      const fail = (error: unknown) => {
        if (!failure) failure = error instanceof Error ? error : new Error(String(error))
      }
      const writeAll = async (text: string) => {
        const bytes = Buffer.from(text, 'utf8')
        let offset = 0
        while (offset < bytes.length) {
          // Retry overwrites a partial line at its original offset, never appends a duplicate.
          const written = await handle.write(bytes, offset, bytes.length - offset, position + offset)
          if (!Number.isSafeInteger(written.bytesWritten) || written.bytesWritten <= 0) throw new Error('引擎帧归档写入未完成。')
          offset += written.bytesWritten
        }
      }
      const noteMissing = (frame: EngineFrameSnapshot) => {
        // The external frame's per-segment payload deliberately has no SNR contract.  The
        // remaining entries are observed field availability, never values inferred locally.
        missing.add('snrDb')
        if (frame.links.some(link => link.quality.gxbDb === null)) missing.add('gxbDb')
        if (frame.links.some(link => link.quality.ber === null)) missing.add('ber')
        if (frame.links.some(link => link.quality.rxPowerDbm === null && link.quality.rxPowerDbw === null)) missing.add('receivedPower')
        if (frame.links.some(link => link.inputTrace.frequencyGHz === null)) missing.add('frequency')
        if (frame.links.some(link => link.inputTrace.dataRateMbps === null)) missing.add('dataRate')
      }
      const drain = (): Promise<void> => {
        if (draining) return draining
        draining = (async () => {
          while (queue.length) {
            const { frame, line } = queue[0]!
            await writeAll(line)
            await limits.database?.append(scope, frame)
            position += Buffer.byteLength(line, 'utf8')
            hash.update(line); frameCount += 1; noteMissing(frame)
            first = first === null ? frame.simulationTime : Math.min(first, frame.simulationTime)
            last = last === null ? frame.simulationTime : Math.max(last, frame.simulationTime)
            queue.shift()
            if (!rebuildCsv) {
              try { await csv.append(frame) }
              catch (error) { rebuildCsv = true; throw error }
            }
            sinceSync += 1
            if (sinceSync >= SYNC_EVERY_FRAMES) { await handle.sync(); sinceSync = 0 }
          }
        })().catch(fail).finally(() => { draining = undefined })
        return draining
      }
      return {
        async append(frame) {
          if (closed) { fail(new Error('引擎帧归档已关闭，拒绝追加帧。')); return }
          if (failure) return
          if (frame.runId !== scope.runId || !Number.isSafeInteger(frame.engineEpoch) || frame.engineEpoch < 0 || !Number.isSafeInteger(frame.frameId) || frame.frameId < 0) {
            invalid = new Error('引擎帧归档作用域、轮次或帧号无效。'); fail(invalid)
            return
          }
          const key = `${frame.engineEpoch}:${frame.frameId}`
          if (seen.has(key)) return
          // Callers must await append; the upstream stream applies TCP backpressure.
          if (queue.length >= MAX_PENDING_WRITES) {
            invalid = new Error('引擎帧写入调用未等待背压，已停止接收；已接收数据保留。'); fail(invalid); return
          }
          const snapshot = structuredClone(frame)
          seen.add(key)
          queue.push({ frame: snapshot, line: `${JSON.stringify(snapshot)}\n` })
          await drain()
        },
        async close() {
          if (closePromise) return closePromise
          closed = true
          closePromise = (async () => {
            let pendingPointer: string | undefined
            try {
              await draining
              if (invalid) {
                if (!handleClosed) { await handle.close(); handleClosed = true }
                await csv.abort()
                throw invalid
              }
              failure = null
              await drain()
              if (failure) throw failure
              if (!handleClosed) { await handle.sync(); await handle.close(); handleClosed = true }
              manifest ??= {
                schemaVersion: '1.0', scope, sourceSha256: hash.copy().digest('hex'), frameCount,
                firstSimulationTime: first, lastSimulationTime: last, missingFieldNames: [...missing].sort(), completedAt: now(), fileName: `engine-${id}.jsonl`, linkBindings: structuredClone(linkBindings),
              }
              if (!rawPublished) { await rename(pending, target); rawPublished = true }
              await limits.database?.complete(scope, manifest.sourceSha256, frameCount)
              if (!csvPublished) {
                if (rebuildCsv) {
                  await csv.abort()
                  await publishEngineCsv(join(runRoot, 'csv'), target, scope.taskId, manifest.sourceSha256, linkBindings, frameCount)
                } else {
                  try { await csv.close(manifest.sourceSha256) }
                  catch (error) { rebuildCsv = true; throw error }
                }
                csvPublished = true
              }
              const pointer = join(runRoot, 'current.json')
              pendingPointer = join(runRoot, `.current-${randomUUID()}.json`)
              await writeFile(pendingPointer, JSON.stringify(manifest), { encoding: 'utf8', flag: 'wx' })
              await rename(pendingPointer, pointer)
            } catch (error) {
              if (pendingPointer) await unlink(pendingPointer).catch(() => undefined)
              fail(error)
              throw failure
            }
            return undefined
          })()
          try { await closePromise }
          catch (error) { closePromise = undefined; throw error }
        },
        failure: () => failure,
      }
    },
    async load(runId, expectedScope, selection) {
      const runRoot = runDirectory(runId)
      if (!runRoot) return null
      const pointer = join(runRoot, 'current.json')
      try { await regularFile(pointer) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
      let manifest: unknown
      try { manifest = JSON.parse(await readFile(pointer, 'utf8')) } catch { throw new Error('引擎帧归档清单不是有效 JSON。') }
      if (!isManifest(manifest, runId)) throw new Error('引擎帧归档清单无效。')
      if (expectedScope && ['taskId', 'runId', 'scenarioId', 'revision', 'startedAt'].some(key => manifest.scope[key as keyof EngineFrameArchiveScope] !== expectedScope[key as keyof EngineFrameArchiveScope])) throw new Error('引擎帧归档作用域与运行结果不一致。')
      if (selection && (!Number.isFinite(selection.start) || !Number.isFinite(selection.end) || selection.start < 0 || selection.end < selection.start)) throw new Error('引擎帧归档筛选时间范围无效。')
      return readSummary(runRoot, manifest, selection, maxReportRows)
    },
    async replay(runId, expectedScope, time, engineEpoch) {
      if (!Number.isFinite(time) || time < 0 || (engineEpoch !== undefined && (!Number.isSafeInteger(engineEpoch) || engineEpoch < 0))) throw new Error('引擎回放时间或轮次无效。')
      const runRoot = runDirectory(runId); if (!runRoot) return null
      const pointer = join(runRoot, 'current.json')
      try { await regularFile(pointer) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
      const manifest: unknown = JSON.parse(await readFile(pointer, 'utf8'))
      if (!isManifest(manifest, runId) || ['taskId', 'runId', 'scenarioId', 'revision', 'startedAt'].some(key => manifest.scope[key as keyof EngineFrameArchiveScope] !== expectedScope[key as keyof EngineFrameArchiveScope])) throw new Error('引擎回放归档与所选运行不一致。')
      if (!limits.database) throw new Error('引擎历史数据库未配置。')
      const raw = join(runRoot, manifest.fileName); await regularFile(raw)
      await limits.database.ensureLegacy(expectedScope, manifest.linkBindings ?? {}, raw, manifest.sourceSha256, manifest.frameCount)
      return limits.database.replay(expectedScope, time, engineEpoch)
    },
    async getFile(runId, sourceSha256) {
      const runRoot = runDirectory(runId)
      if (!runRoot || !/^[a-f0-9]{64}$/u.test(sourceSha256)) return null
      const pointer = join(runRoot, 'current.json')
      try { await regularFile(pointer) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
      let manifest: unknown
      try { manifest = JSON.parse(await readFile(pointer, 'utf8')) } catch { throw new Error('引擎帧归档清单不是有效 JSON。') }
      if (!isManifest(manifest, runId) || manifest.sourceSha256 !== sourceSha256) return null
      const framePath = join(runRoot, manifest.fileName)
      await regularFile(framePath)
      return framePath
    },
    async finalizeCsv(runId, expectedScope, _linkBindings) {
      const runRoot = runDirectory(runId); if (!runRoot) return null
      const pointer = join(runRoot, 'current.json')
      try { await regularFile(pointer) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
      const manifest: unknown = JSON.parse(await readFile(pointer, 'utf8'))
      if (!isManifest(manifest, runId) || ['taskId', 'runId', 'scenarioId', 'revision', 'startedAt'].some(key => manifest.scope[key as keyof EngineFrameArchiveScope] !== expectedScope[key as keyof EngineFrameArchiveScope])) throw new Error('引擎帧归档作用域与运行结果不一致。')
      const csvRoot = join(runRoot, 'csv')
      try {
        const current = join(csvRoot, 'current.json'); await regularFile(current)
        const pointer = JSON.parse(await readFile(current, 'utf8')) as { generation?: unknown; sourceSha256?: unknown }
        if (pointer.sourceSha256 === manifest.sourceSha256 && typeof pointer.generation === 'string' && /^engine-csv-[0-9a-f-]{36}$/u.test(pointer.generation)) {
          const csvManifest = join(csvRoot, pointer.generation, 'manifest.json'); await regularFile(csvManifest)
          const evidence: unknown = JSON.parse(await readFile(csvManifest, 'utf8'))
          if (isCsvEvidence(evidence, manifest.sourceSha256)) return evidence
        }
      } catch { /* legacy archive: generate once from immutable JSONL below */ }
      const raw = join(runRoot, manifest.fileName); await regularFile(raw)
      return publishEngineCsv(csvRoot, raw, manifest.scope.taskId, manifest.sourceSha256, manifest.linkBindings ?? {}, manifest.frameCount)
    },
    async getCsvFile(runId, sourceSha256, fileName) {
      const runRoot = runDirectory(runId); return runRoot ? getEngineCsvFile(join(runRoot, 'csv'), sourceSha256, fileName) : null
    },
    async aggregate(runId, expectedScope, linkBindings, selection) {
      const runRoot = runDirectory(runId); if (!runRoot) return null
      const pointer = join(runRoot, 'current.json'); await regularFile(pointer)
      const manifest: unknown = JSON.parse(await readFile(pointer, 'utf8'))
      if (!isManifest(manifest, runId) || ['taskId', 'runId', 'scenarioId', 'revision', 'startedAt'].some(key => manifest.scope[key as keyof EngineFrameArchiveScope] !== expectedScope[key as keyof EngineFrameArchiveScope])) throw new Error('引擎帧归档作用域与运行结果不一致。')
      if (selection && (!Number.isFinite(selection.start) || !Number.isFinite(selection.end) || selection.start < 0 || selection.end < selection.start)) throw new Error('引擎帧归档筛选时间范围无效。')
      linkBindings = manifest.linkBindings ?? {}; let count = 0, gxb = 0, ber = 0, switches = 0
      const raw = join(runRoot, manifest.fileName); await regularFile(raw)
      let rows = 0; const source = await readStableUtf8Lines(raw, line => { const frame: unknown = JSON.parse(line); if (!isEngineFrameSnapshot(frame)) throw new Error('引擎帧归档包含不符合契约的记录。'); rows += 1; if (selection && (frame.simulationTime < selection.start || frame.simulationTime > selection.end)) return; for (const route of frame.routing.switches) if ((!selection?.nodeId || route.sourcePlatformId === selection.nodeId || route.targetPlatformId === selection.nodeId || route.nodes.some(node => node.platformId === selection.nodeId) || route.oldNodes.some(node => node.platformId === selection.nodeId)) && (!selection?.linkId || route.reasons.some(reason => reason.linkId === selection.linkId || frame.links.some(link => link.linkId === reason.linkId && link.linkIds.includes(selection.linkId!))))) switches += 1; for (const link of frame.links) { const id = link.linkIds.length === 1 ? link.linkIds[0]! : undefined, binding = id ? linkBindings[id] : undefined; if (binding && !binding.relayPlatformId && binding.sourcePlatformId === link.sourcePlatformId && binding.targetPlatformId === link.targetPlatformId && link.error === null && frame.links.filter(item => item.linkIds.includes(id!)).length === 1 && (!selection?.nodeId || link.sourcePlatformId === selection.nodeId || link.targetPlatformId === selection.nodeId) && (!selection?.linkId || id === selection.linkId) && link.quality.gxbDb !== null && link.quality.ber !== null) { count += 1; gxb += link.quality.gxbDb; ber += link.quality.ber } } }, MAX_ARCHIVE_BYTES)
      if (source.waitingForLine || source.source.sha256 !== manifest.sourceSha256 || rows !== manifest.frameCount) throw new Error('引擎帧归档来源校验失败。')
      return { uniqueSingleSegmentCount: count, ...(count ? { averageGxbDb: gxb / count, averageBer: ber / count } : {}), switchCount: switches, missing: ['connectivityDurationS', 'interferenceDurationS'] }
    },
  }
}

/** Reads the immutable JSONL generation once, verifies its digest, and projects only received segment/event values. */
async function readSummary(runRoot: string, manifest: Manifest, selection?: { start: number; end: number; nodeId?: string; linkId?: string }, maxReportRows = MAX_REPORT_ROWS): Promise<EngineFrameArchiveSummary> {
  const framePath = join(runRoot, manifest.fileName)
  await regularFile(framePath)
  const segmentRows: EngineFrameArchiveSegmentRow[] = []
  const switchRows: EngineFrameArchiveSwitchRow[] = []
  const eventRows: EngineFrameArchiveEventRow[] = []
  let rows = 0
  let detailTruncated = false
  const source = await readStableUtf8Lines(framePath, line => {
    let frame: unknown
    try { frame = JSON.parse(line) } catch { throw new Error('引擎帧归档包含无效 JSON 记录。') }
    if (!isEngineFrameSnapshot(frame)) throw new Error('引擎帧归档包含不符合契约的记录。')
    rows += 1
    if (selection && (frame.simulationTime < selection.start || frame.simulationTime > selection.end)) return
    const common = { engineEpoch: frame.engineEpoch, frameId: frame.frameId, simulationTime: frame.simulationTime }
    const selectedLinkId = selection?.linkId
    const segmentRowsForFrame = frame.links.filter(link => (!selection?.nodeId || link.sourcePlatformId === selection.nodeId || link.targetPlatformId === selection.nodeId)
      && (!selectedLinkId || link.linkId === selectedLinkId || link.linkIds.includes(selectedLinkId)))
    const switchRowsForFrame = frame.routing.switches.filter(route => (!selection?.nodeId || route.sourcePlatformId === selection.nodeId || route.targetPlatformId === selection.nodeId
      || route.nodes.some(node => node.platformId === selection.nodeId) || route.oldNodes.some(node => node.platformId === selection.nodeId))
      && (!selectedLinkId || route.reasons.some(reason => reason.linkId === selectedLinkId
        || frame.links.some(link => link.linkId === reason.linkId && link.linkIds.includes(selectedLinkId)))))
    // Engine events have no link membership; link-filtered reports omit them rather than cross-associate a frame.
    const eventRowsForFrame = selectedLinkId ? [] : frame.events.filter(event => !selection?.nodeId || event.uavIds.includes(selection.nodeId) || event.jammerIds.includes(selection.nodeId))
    const added = segmentRowsForFrame.length + switchRowsForFrame.length + eventRowsForFrame.length
    if (segmentRows.length + switchRows.length + eventRows.length + added > maxReportRows) { detailTruncated = true; return }
    segmentRows.push(...segmentRowsForFrame.map(segment => ({ ...common, segment })))
    switchRows.push(...switchRowsForFrame.map(value => ({ ...common, value })))
    eventRows.push(...eventRowsForFrame.map(value => ({ ...common, value })))
  }, MAX_ARCHIVE_BYTES)
  if (source.waitingForLine || source.source.sha256 !== manifest.sourceSha256 || rows !== manifest.frameCount) throw new Error('引擎帧归档来源校验失败。')
  return { sourceSha256: manifest.sourceSha256, frameCount: manifest.frameCount, firstSimulationTime: manifest.firstSimulationTime,
    lastSimulationTime: manifest.lastSimulationTime, missingFieldNames: manifest.missingFieldNames, segmentRows, switchRows, eventRows,
    ...(detailTruncated ? { detailTruncated: true, retainedDetailRows: segmentRows.length + switchRows.length + eventRows.length } : {}) }
}

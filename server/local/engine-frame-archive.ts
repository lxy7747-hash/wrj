import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { MAX_LOCAL_REPORT_TREND_POINTS, type EngineFrameArchiveEventRow, type EngineFrameArchiveSegmentRow, type EngineFrameArchiveSummary, type EngineFrameArchiveSwitchRow, type EngineFrameSnapshot, type LocalReportTrendPoint } from '../../src/contracts/domain-models.js'
import { readEngineCsvSource } from './engine-csv-report.js'
import type { EvidenceSource } from '../../src/features/reports/report-evidence.js'
import { isEngineFrameId, isEngineFrameSnapshot, ENGINE_FRAME_ID_STEP } from '../../src/features/data-exchange/engine-frame-snapshot.js'
import { readStableUtf8Lines } from './afsim-log-reader.js'
import { ENGINE_CSV_PROJECTION_VERSION, createEngineCsvSession, CSV_CAPACITY_MESSAGE, ENGINE_JSONL_LINE_LIMIT_BYTES, getEngineCsvFile, isEngineCsvCapacityError, publishEngineCsv, publishTaskEngineCsv, type EngineCsvEvidence, type EngineCsvPublication, type EngineLinkBinding } from './engine-frame-csv.js'
import type { LinkType } from '../../src/contracts/domain-models.js'
import type { EngineFrameSqliteStorage } from './engine-frame-sqlite.js'
import type { EngineReplaySnapshot } from '../../src/features/replays/engine-replay.js'
import { EXPORT_CURVE_MAX_POINTS, StreamingCurveReservoir } from './report-curve-downsample.js'

const safeRunId = (value: string) => /^RUN-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
/** 半开阶段末点由 includeEnd 显式决定；缺省保持闭区间，兼容旧调用。 */
type ArchiveSelection = { start: number; end: number; includeEnd?: boolean; nodeId?: string; linkId?: string }
const inSelection = (selection: ArchiveSelection | undefined, time: number): boolean =>
  selection === undefined || (time >= selection.start && (selection.includeEnd === false ? time < selection.end : time <= selection.end))
const MAX_PENDING_WRITES = 512
const SYNC_EVERY_FRAMES = 32
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
/** Browser report evidence is bounded; the complete JSONL generation remains hash-addressable on disk. */
const MAX_REPORT_ROWS = 50_000
/** 50,000 行明细摘要与全量 CSV 证据源占用堆内存较高，限制驻留份数防止长时间运行 OOM。 */
const LARGE_OBJECT_CACHE_LIMIT = 2

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

export interface EngineAggregateSummary {
  uniqueSingleSegmentCount: number
  averageGxbDb?: number
  averageBer?: number
  switchCount: number
  /** 由引擎帧 link.status / jammer.deviceStatus 的连续帧区间计算；单帧不推算。 */
  averageConnectedDurationS?: number
  jammingDurationS?: number
  switchCountTrend?: LocalReportTrendPoint[]
  jammingDurationTrend?: LocalReportTrendPoint[]
  missing: string[]
}

export interface EngineFrameArchive {
  begin(scope: EngineFrameArchiveScope, linkBindings?: Readonly<Record<string, EngineLinkBinding>>): Promise<EngineFrameArchiveSession>
  load(runId: string, expectedScope?: EngineFrameArchiveScope, selection?: { start: number; end: number; includeEnd?: boolean; nodeId?: string; linkId?: string }): Promise<EngineFrameArchiveSummary | null>
  /** Single-pass summary + aggregate computation for initial report loading and filtering. */
  loadWithAggregate?(runId: string, expectedScope?: EngineFrameArchiveScope, selection?: { start: number; end: number; includeEnd?: boolean; nodeId?: string; linkId?: string }): Promise<{ summary: EngineFrameArchiveSummary; aggregate: EngineAggregateSummary } | null>
  /** D3 完整读取：按字节上限流式读取全部命中的段/切换/事件明细（不按 50000 行截断），可按固定 sourceSha256 读取不可变历史批次。 */
  loadComplete(runId: string, expectedScope?: EngineFrameArchiveScope, selection?: { start: number; end: number; includeEnd?: boolean; nodeId?: string; linkId?: string }, sourceSha256?: string): Promise<EngineFrameArchiveSummary | null>
  getFile(runId: string, sourceSha256: string): Promise<string | null>
  finalizeCsv(runId: string, expectedScope: EngineFrameArchiveScope, linkBindings: Readonly<Record<string, EngineLinkBinding>>): Promise<EngineCsvEvidence | null>
  getCsvFile(runId: string, sourceSha256: string, fileName: string): Promise<string | null>
  publishTaskCsv(runId: string, directory: string, evidence: EngineCsvEvidence): Promise<void>
  loadCsvSource(runId: string, expectedScope: EngineFrameArchiveScope, sourceSha256?: string): Promise<EvidenceSource | null>
  replay(runId: string, expectedScope: EngineFrameArchiveScope, time: number, engineEpoch?: number): Promise<EngineReplaySnapshot | null>
  aggregate(runId: string, expectedScope: EngineFrameArchiveScope, linkBindings: Readonly<Record<string, EngineLinkBinding>>, selection?: { start: number; end: number; includeEnd?: boolean; nodeId?: string; linkId?: string }): Promise<EngineAggregateSummary | null>
  /** D3 有界：各 kind 全量计数（不保留明细数组）。 */
  queryCounts(runId: string, expectedScope?: EngineFrameArchiveScope, selection?: NativeSelection, sourceSha256?: string): Promise<NativeCounts | null>
  /** D3 有界：按 epoch→frameId→帧内序号分页，total 来自全量扫描，仅保留当前页。 */
  queryRows(runId: string, expectedScope: EngineFrameArchiveScope | undefined, options: { selection?: NativeSelection; kind: NativeKind; offset: number; limit: number }, sourceSha256?: string): Promise<{ total: number; rows: NativeRow[] } | null>
  /** D3 有界：原生曲线身份目录（distinct，通常与链路数同阶）。 */
  querySeriesCatalog(runId: string, expectedScope?: EngineFrameArchiveScope, selection?: NativeSelection, sourceSha256?: string): Promise<NativeSeriesMetaOut[] | null>
  /** D3 有界：单条原生命中曲线，两遍扫描只保留有界展示点。 */
  querySeriesPoints(runId: string, expectedScope: EngineFrameArchiveScope | undefined, seriesId: string, selection: NativeSelection | undefined, maxPoints: number, sourceSha256?: string, cursorOffset?: number): Promise<NativeSeriesPoints | null>
  /** D3 导出优化：单遍流式扫描全部命中曲线并按极值保真降采样，避免多曲线反复全量扫盘与 OOM。 */
  queryAllSeriesDownsampled?(runId: string, expectedScope: EngineFrameArchiveScope | undefined, selection: NativeSelection | undefined, maxPointsPerSeries?: number, sourceSha256?: string): Promise<Array<{ meta: NativeSeriesMetaOut; rawCount: number; sampling: 'FULL' | 'DOWNSAMPLED'; points: Array<{ time: number; value: number; breakBefore?: boolean }> }> | null>
}

export type NativeKind = 'segments' | 'switches' | 'events'
export interface NativeSelection { start: number; end: number; includeEnd?: boolean; nodeId?: string; linkId?: string }
export interface NativeRow { id: string; time: number; engineEpoch: number; frameId: number; seq: number; kind: NativeKind; [key: string]: unknown }
export interface NativeSeriesIdentity { engineEpoch: number; linkId: string | null; sourcePlatformId: string | null; targetPlatformId: string | null; sourceName: string | null; sourcePort: string | null; targetName: string | null; targetPort: string | null; frameStep: number }
export interface NativeSeriesMetaOut { seriesId: string; unit: string; identity: NativeSeriesIdentity }
export interface NativeSeriesPoints { rawCount: number; sampling: 'FULL' | 'DOWNSAMPLED'; points: Array<{ time: number; value: number; breakBefore?: boolean }>; nextOffset: number | null }
export interface NativeCounts { segments: number; switches: number; events: number; sourceSha256: string }

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
    && typeof file.fileName === 'string' && /^([a-f0-9]{64})$/u.test(String(file.sha256)) && Number.isSafeInteger(file.rowCount) && Number(file.rowCount) >= 0
    && (file.status === 'COMPLETE' || file.status === 'PARTIAL') && Number.isSafeInteger(file.skippedCount) && Number(file.skippedCount) >= 0
    && (file.reason === undefined || (typeof file.reason === 'string' && file.reason.length > 0)))
    && value.missing.every(file => isObject(file) && Object.keys(file).every(key => ['fileName', 'status', 'reason'].includes(key)) && typeof file.fileName === 'string' && file.status === 'SOURCE_MISSING' && typeof file.reason === 'string' && file.reason.length > 0)
}

async function regularFile(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('引擎帧归档必须是普通文件。')
}

async function regularFileSig(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('引擎帧归档必须是普通文件。')
  return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.birthtimeNs}`
}

function lruCacheSet<K, V>(cache: Map<K, V>, key: K, value: V, limit = 8): void {
  if (cache.has(key)) cache.delete(key)
  else if (cache.size >= limit) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

function selectionCacheKey(selection?: ArchiveSelection): string {
  if (!selection) return ''
  return `${selection.start}:${selection.end}:${selection.includeEnd === false ? '0' : '1'}:${selection.nodeId ?? ''}:${selection.linkId ?? ''}`
}

function accumulateFrameSummary(
  frame: EngineFrameSnapshot,
  selection: ArchiveSelection | undefined,
  maxReportRows: number,
  state: {
    segmentRows: EngineFrameArchiveSegmentRow[]
    switchRows: EngineFrameArchiveSwitchRow[]
    eventRows: EngineFrameArchiveEventRow[]
    detailTruncated: boolean
  },
): void {
  if (!inSelection(selection, frame.simulationTime)) return
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
  if (state.segmentRows.length + state.switchRows.length + state.eventRows.length + added > maxReportRows) {
    state.detailTruncated = true
    return
  }
  state.segmentRows.push(...segmentRowsForFrame.map(segment => ({ ...common, segment })))
  state.switchRows.push(...switchRowsForFrame.map(value => ({ ...common, value })))
  state.eventRows.push(...eventRowsForFrame.map(value => ({ ...common, value })))
}

type TrendChanges<T> = { changes: Map<number, T>; omittedFrom?: number }
type JammingBoundary = { known: number; active: number }

function recordTrendChange<T>(trend: TrendChanges<T>, time: number, value: T, merge: (left: T, right: T) => T | undefined): void {
  if (trend.omittedFrom !== undefined && time >= trend.omittedFrom) return
  const existing = trend.changes.get(time)
  if (existing !== undefined) {
    const combined = merge(existing, value)
    if (combined === undefined) trend.changes.delete(time)
    else trend.changes.set(time, combined)
    return
  }
  // 留出实际首帧基准和最终点的位置，省略区间不画连线。
  if (trend.changes.size < MAX_LOCAL_REPORT_TREND_POINTS - 2) trend.changes.set(time, value)
  else trend.omittedFrom = time
}

function orderedTrendChanges<T>(trend: TrendChanges<T>): Array<[number, T]> {
  return [...trend.changes].filter(([time]) => trend.omittedFrom === undefined || time < trend.omittedFrom)
    .sort(([left], [right]) => left - right)
}

function addJammingBoundary(left: JammingBoundary, right: JammingBoundary): JammingBoundary | undefined {
  const known = left.known + right.known, active = left.active + right.active
  return known === 0 && active === 0 ? undefined : { known, active }
}

type EngineAggregateState = {
  count: number
  gxb: number
  ber: number
  switches: number
  linkDurations: Map<string, number>
  observedLinks: Set<string>
  previousLinkStatuses?: Map<string, boolean | null>
  previousSimulationTime?: number
  previousFrameId?: number
  jammingDuration: number
  previousJammingOn?: boolean
  previousJammingKnown?: boolean
  intervalObserved: boolean
  switchChanges: TrendChanges<number>
  jammingBoundaries: TrendChanges<JammingBoundary>
  firstObservedTime?: number
  lastObservedTime?: number
  lastKnownJammingTime?: number
}

function createAggregateState(): EngineAggregateState {
  return { count: 0, gxb: 0, ber: 0, switches: 0, linkDurations: new Map(), observedLinks: new Set(),
    jammingDuration: 0, intervalObserved: false,
    switchChanges: { changes: new Map() }, jammingBoundaries: { changes: new Map() } }
}

function scopedJammerStatus(frame: EngineFrameSnapshot, selection: ArchiveSelection): boolean | undefined {
  const { linkId, nodeId } = selection
  // 链路必须有本帧归档输入关联，不能以同一帧出现的其他设备替代。
  const jammerIds = linkId
    ? new Set(frame.links.filter(link => segmentMatches(link, selection) && link.linkIds.includes(linkId))
      .flatMap(link => link.inputTrace.jammers.flatMap(jammer => jammer.platformId === null ? [] : [jammer.platformId])))
    : new Set([nodeId])
  if (jammerIds.size === 0) return undefined
  const off = new Set<string>()
  for (const jammer of frame.jammers) {
    if (jammer.platformId === null || !jammerIds.has(jammer.platformId)) continue
    if (jammer.deviceStatus === 'ON') return true
    if (jammer.deviceStatus === 'OFF') off.add(jammer.platformId)
  }
  return off.size === jammerIds.size ? false : undefined
}

function accumulateFrameAggregate(
  frame: EngineFrameSnapshot,
  linkBindings: Readonly<Record<string, EngineLinkBinding>>,
  selection: ArchiveSelection | undefined,
  state: EngineAggregateState,
): void {
  if (!inSelection(selection, frame.simulationTime)) return
  const nodeId = selection?.nodeId
  const selectedLinkId = selection?.linkId
  const scoped = !!(nodeId || selectedLinkId)
  const time = frame.simulationTime
  state.firstObservedTime = Math.min(state.firstObservedTime ?? time, time)
  state.lastObservedTime = Math.max(state.lastObservedTime ?? time, time)
  // 只有连续帧之间才累计状态持续时间；单帧、断帧或筛选空洞不推算。
  if (state.previousSimulationTime !== undefined) {
    const deltaSeconds = frame.simulationTime - state.previousSimulationTime
    const deltaFrames = frame.frameId - (state.previousFrameId ?? frame.frameId)
    if (deltaSeconds > 0 && deltaFrames > 0 && deltaFrames <= ENGINE_FRAME_ID_STEP) {
      state.intervalObserved = true
      for (const [linkId, up] of state.previousLinkStatuses ?? []) {
        if (up === null) continue
        if (scoped) state.observedLinks.add(linkId)
        if (up) state.linkDurations.set(linkId, (state.linkDurations.get(linkId) ?? 0) + deltaSeconds)
      }
      if (state.previousJammingOn) state.jammingDuration += deltaSeconds
      if (state.previousJammingKnown) {
        const active = state.previousJammingOn ? 1 : 0
        recordTrendChange(state.jammingBoundaries, state.previousSimulationTime, { known: 1, active }, addJammingBoundary)
        recordTrendChange(state.jammingBoundaries, time, { known: -1, active: -active }, addJammingBoundary)
        state.lastKnownJammingTime = Math.max(state.lastKnownJammingTime ?? time, time)
      }
    }
  }
  const currentLinkStatuses = new Map<string, boolean | null>()
  const nodeLinkIds = nodeId
    ? new Set(frame.links.filter(link => segmentMatches(link, selection)).flatMap(link => link.linkIds))
    : undefined
  for (const link of frame.links) {
    for (const linkId of new Set(link.linkIds)) {
      if (selectedLinkId && linkId !== selectedLinkId) continue
      const binding = nodeId && Object.hasOwn(linkBindings, linkId) ? linkBindings[linkId] : undefined
      // 节点筛选定位逻辑链路，再按该链路的全部已归档设备段累计。
      if (nodeId && (binding
        ? binding.sourcePlatformId !== nodeId && binding.targetPlatformId !== nodeId && binding.relayPlatformId !== nodeId
        : !nodeLinkIds?.has(linkId))) continue
      if (!scoped) state.observedLinks.add(linkId)
      const up = scoped && link.status === 'UNKNOWN' ? null : link.status === 'UP'
      const previous = currentLinkStatuses.get(linkId)
      currentLinkStatuses.set(linkId, previous === false || up === false ? false : previous === null || up === null ? null : true)
    }
  }
  state.previousLinkStatuses = currentLinkStatuses
  state.previousSimulationTime = frame.simulationTime
  state.previousFrameId = frame.frameId
  if (scoped) {
    state.previousJammingOn = scopedJammerStatus(frame, selection!)
    state.previousJammingKnown = state.previousJammingOn !== undefined
  } else {
    state.previousJammingOn = frame.jammers.some(jammer => jammer.deviceStatus === 'ON')
    state.previousJammingKnown = state.previousJammingOn
      || (frame.jammers.length > 0 && frame.jammers.every(jammer => jammer.deviceStatus === 'OFF'))
  }
  let switches = 0
  for (const route of frame.routing.switches) {
    if (switchMatches(frame, route, selection)) switches += 1
  }
  if (switches > 0) {
    state.switches += switches
    recordTrendChange(state.switchChanges, time, switches, (left, right) => left + right)
  }
  const linkIdCounts = new Map<string, number>()
  for (const item of frame.links) {
    const uniqueIds = item.linkIds.length <= 1 ? item.linkIds : [...new Set(item.linkIds)]
    for (const lid of uniqueIds) linkIdCounts.set(lid, (linkIdCounts.get(lid) ?? 0) + 1)
  }
  for (const link of frame.links) {
    const id = link.linkIds.length === 1 ? link.linkIds[0]! : undefined
    const binding = id ? linkBindings[id] : undefined
    if (binding && !binding.relayPlatformId && binding.sourcePlatformId === link.sourcePlatformId && binding.targetPlatformId === link.targetPlatformId
      && link.error === null && (linkIdCounts.get(id!) ?? 0) === 1
      && (!selection?.nodeId || link.sourcePlatformId === selection.nodeId || link.targetPlatformId === selection.nodeId)
      && (!selection?.linkId || id === selection.linkId) && link.quality.gxbDb !== null && link.quality.ber !== null) {
      state.count += 1; state.gxb += link.quality.gxbDb; state.ber += link.quality.ber
    }
  }
}

/**
 * 把指针文件恢复到其先前内容；先前不存在时删除指针，使整组发布回到“未发布”状态。
 * 尽力而为：回滚失败不掩盖触发回滚的原始错误，也不删除已写好的不可变代文件。
 */
async function restorePointer(path: string, previous: string | null): Promise<void> {
  try {
    if (previous === null) { await unlink(path).catch(() => undefined); return }
    const temporary = `${path}.restore-${randomUUID()}`
    await writeFile(temporary, previous, 'utf8')
    await rename(temporary, path)
  } catch { /* 回滚尽力而为 */ }
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
  const summaryCache = new Map<string, { fileSig: string; result: EngineFrameArchiveSummary }>()
  const aggregateCache = new Map<string, { fileSig: string; result: EngineAggregateSummary }>()
  const countsCache = new Map<string, { fileSig: string; result: NativeCounts }>()
  const catalogCache = new Map<string, { fileSig: string; result: NativeSeriesMetaOut[] }>()
  const csvSourceCache = new Map<string, { fileSigs: string[]; result: EvidenceSource | null }>()
  const readCurrentManifest = async (runId: string, expectedScope?: EngineFrameArchiveScope): Promise<{ runRoot: string; manifest: Manifest } | null> => {
    const runRoot = runDirectory(runId)
    if (!runRoot) return null
    const pointer = join(runRoot, 'current.json')
    try { await regularFile(pointer) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    let manifest: unknown
    try { manifest = JSON.parse(await readFile(pointer, 'utf8')) } catch { throw new Error('引擎帧归档清单不是有效 JSON。') }
    if (!isManifest(manifest, runId)) throw new Error('引擎帧归档清单无效。')
    if (expectedScope && ['taskId', 'runId', 'scenarioId', 'revision', 'startedAt'].some(key => manifest.scope[key as keyof EngineFrameArchiveScope] !== expectedScope[key as keyof EngineFrameArchiveScope])) throw new Error('引擎帧归档作用域与运行结果不一致。')
    return { runRoot, manifest }
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
      // 容量超限是确定性失败：不重建，也不在后续关闭中再次发布派生 CSV。
      let csvCapacityFailed = false
      let csvPublication: EngineCsvPublication | null = null
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
            if (!rebuildCsv && !csvCapacityFailed) {
              try { await csv.append(frame) }
              catch (error) {
                if (isEngineCsvCapacityError(error)) csvCapacityFailed = true
                else rebuildCsv = true
                throw error
              }
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
          if (frame.runId !== scope.runId || !Number.isSafeInteger(frame.engineEpoch) || frame.engineEpoch < 0 || !isEngineFrameId(frame.frameId)) {
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
          const json = JSON.stringify(snapshot)
          if (Buffer.byteLength(json, 'utf8') > ENGINE_JSONL_LINE_LIMIT_BYTES) {
            invalid = new Error('引擎归档单帧超过 8MiB 上限，未写入不可重读的数据。'); fail(invalid); return
          }
          seen.add(key)
          queue.push({ frame: snapshot, line: `${json}\n` })
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
              // 派生 CSV 确定性容量超限：明确失败、保留已接收原始数据，但绝不切换原始指针伪装整组成功。
              if (csvCapacityFailed) {
                if (!handleClosed) { await handle.sync().catch(() => undefined); await handle.close().catch(() => undefined); handleClosed = true }
                if (!rawPublished) { await rename(pending, target); rawPublished = true }
                await csv.abort()
                fail(new Error(CSV_CAPACITY_MESSAGE))
                throw failure
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
              // 每代保存独立清单，供按固定 sourceSha256 读取时校验该代自有作用域（不借 current）。
              await writeFile(join(runRoot, `engine-${id}.json`), JSON.stringify(manifest), { encoding: 'utf8' })
              await limits.database?.complete(scope, manifest.sourceSha256, frameCount)
              if (!csvPublished && !csvPublication) {
                if (rebuildCsv) {
                  await csv.abort()
                  try { csvPublication = await publishEngineCsv(join(runRoot, 'csv'), target, scope.taskId, manifest.sourceSha256, linkBindings, frameCount, { deferPointer: true }) }
                  catch (error) {
                    // 重建时确认容量超限属确定性失败：置终止标志，后续 close 直接失败、不再重复读取原文重建；临时 I/O 错误保持可重试。
                    if (isEngineCsvCapacityError(error)) csvCapacityFailed = true
                    else rebuildCsv = true
                    throw error
                  }
                } else {
                  try { csvPublication = await csv.close(manifest.sourceSha256, { deferPointer: true }) }
                  catch (error) {
                    if (isEngineCsvCapacityError(error)) csvCapacityFailed = true
                    else rebuildCsv = true
                    throw error
                  }
                }
                csvPublished = true
              }
              // 原始指针切换前先记录旧值，供 CSV 指针提交失败时整组回滚，杜绝 raw=B/CSV=A 的两级混代。
              const pointer = join(runRoot, 'current.json')
              let previousRawPointer: string | null = null
              try { previousRawPointer = await readFile(pointer, 'utf8') } catch { previousRawPointer = null }
              pendingPointer = join(runRoot, `.current-${randomUUID()}.json`)
              await writeFile(pendingPointer, JSON.stringify(manifest), { encoding: 'utf8', flag: 'wx' })
              await rename(pendingPointer, pointer)
              pendingPointer = undefined
              if (csvPublication) {
                try { await csvPublication.commitPointer() }
                catch (error) {
                  // 任一级指针提交失败都必须让两级指针回到同一旧代，避免 raw=B 而 CSV=A。
                  await csvPublication.restorePreviousPointer().catch(() => undefined)
                  await restorePointer(pointer, previousRawPointer)
                  throw error
                }
                csvPublication = null
              }
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
      const resolved = await readCurrentManifest(runId, expectedScope)
      if (!resolved) return null
      if (selection && (!Number.isFinite(selection.start) || !Number.isFinite(selection.end) || selection.start < 0 || selection.end < selection.start)) throw new Error('引擎帧归档筛选时间范围无效。')
      const { runRoot, manifest } = resolved
      const framePath = join(runRoot, manifest.fileName)
      const fileSig = await regularFileSig(framePath)
      const cacheKey = `${runRoot}\0${manifest.fileName}\0${manifest.sourceSha256}\0${maxReportRows}\0${selectionCacheKey(selection)}`
      const cached = summaryCache.get(cacheKey)
      if (cached?.fileSig === fileSig) {
        lruCacheSet(summaryCache, cacheKey, cached, LARGE_OBJECT_CACHE_LIMIT)
        return cached.result
      }
      const result = await readSummary(runRoot, manifest, selection, maxReportRows)
      lruCacheSet(summaryCache, cacheKey, { fileSig, result }, LARGE_OBJECT_CACHE_LIMIT)
      return result
    },
    async loadWithAggregate(runId, expectedScope, selection) {
      const resolved = await readCurrentManifest(runId, expectedScope)
      if (!resolved) return null
      if (selection && (!Number.isFinite(selection.start) || !Number.isFinite(selection.end) || selection.start < 0 || selection.end < selection.start)) throw new Error('引擎帧归档筛选时间范围无效。')
      const { runRoot, manifest } = resolved
      const framePath = join(runRoot, manifest.fileName)
      const fileSig = await regularFileSig(framePath)
      const effectiveBindings = manifest.linkBindings ?? {}
      const selKey = selectionCacheKey(selection)
      const bindingsKey = JSON.stringify(effectiveBindings)
      const sumKey = `${runRoot}\0${manifest.fileName}\0${manifest.sourceSha256}\0${maxReportRows}\0${selKey}`
      const aggKey = `${runRoot}\0${manifest.fileName}\0${manifest.sourceSha256}\0${bindingsKey}\0${selKey}`
      const cachedSum = summaryCache.get(sumKey)
      const cachedAgg = aggregateCache.get(aggKey)
      if (cachedSum?.fileSig === fileSig && cachedAgg?.fileSig === fileSig) {
        lruCacheSet(summaryCache, sumKey, cachedSum, LARGE_OBJECT_CACHE_LIMIT)
        lruCacheSet(aggregateCache, aggKey, cachedAgg)
        return { summary: cachedSum.result, aggregate: cachedAgg.result }
      }
      const sumState = {
        segmentRows: [] as EngineFrameArchiveSegmentRow[],
        switchRows: [] as EngineFrameArchiveSwitchRow[],
        eventRows: [] as EngineFrameArchiveEventRow[],
        detailTruncated: false,
      }
      const aggState = createAggregateState()
      const nativeCounts: NativeCounts = { segments: 0, switches: 0, events: 0, sourceSha256: manifest.sourceSha256 }
      const nativeIdentities = new Map<string, NativeSeriesIdentity>()
      let rows = 0
      const source = await readStableUtf8Lines(framePath, line => {
        let frame: unknown
        try { frame = JSON.parse(line) } catch { throw new Error('引擎帧归档包含无效 JSON 记录。') }
        if (!isEngineFrameSnapshot(frame)) throw new Error('引擎帧归档包含不符合契约的记录。')
        rows += 1
        nativeCounts.segments += frame.links.length
        nativeCounts.switches += frame.routing.switches.length
        nativeCounts.events += frame.events.length
        for (const link of frame.links) {
          const identity = identityOf(frame, link)
          const key = seriesKey(identity)
          if (!nativeIdentities.has(key)) nativeIdentities.set(key, identity)
        }
        accumulateFrameSummary(frame, selection, maxReportRows, sumState)
        accumulateFrameAggregate(frame, effectiveBindings, selection, aggState)
      }, MAX_ARCHIVE_BYTES, ENGINE_JSONL_LINE_LIMIT_BYTES)
      if (source.waitingForLine || source.source.sha256 !== manifest.sourceSha256 || rows !== manifest.frameCount) throw new Error('引擎帧归档来源校验失败。')
      const summary: EngineFrameArchiveSummary = {
        sourceSha256: manifest.sourceSha256,
        frameCount: manifest.frameCount,
        firstSimulationTime: manifest.firstSimulationTime,
        lastSimulationTime: manifest.lastSimulationTime,
        missingFieldNames: manifest.missingFieldNames,
        segmentRows: sumState.segmentRows,
        switchRows: sumState.switchRows,
        eventRows: sumState.eventRows,
        ...(sumState.detailTruncated ? { detailTruncated: true, retainedDetailRows: sumState.segmentRows.length + sumState.switchRows.length + sumState.eventRows.length } : {}),
      }
      const aggregate = aggregateSummary(aggState)
      const catalogMetas: NativeSeriesMetaOut[] = []
      for (const identity of [...nativeIdentities.values()].sort((left, right) => seriesKey(left).localeCompare(seriesKey(right)))) {
        catalogMetas.push({ seriesId: seriesIdOf(identity, 'gxb'), unit: 'dB', identity }, { seriesId: seriesIdOf(identity, 'ber'), unit: 'BER', identity })
      }
      lruCacheSet(summaryCache, sumKey, { fileSig, result: summary }, LARGE_OBJECT_CACHE_LIMIT)
      lruCacheSet(aggregateCache, aggKey, { fileSig, result: aggregate })
      const nativeBaseKey = `${runRoot}\0${manifest.fileName}\0${manifest.sourceSha256}\0`
      lruCacheSet(countsCache, nativeBaseKey, { fileSig, result: nativeCounts })
      lruCacheSet(catalogCache, nativeBaseKey, { fileSig, result: catalogMetas })
      return { summary, aggregate }
    },
    async loadComplete(runId, expectedScope, selection, sourceSha256) {
      const runRoot = runDirectory(runId)
      if (!runRoot) return null
      if (selection && (!Number.isFinite(selection.start) || !Number.isFinite(selection.end) || selection.start < 0 || selection.end < selection.start)) throw new Error('引擎帧归档筛选时间范围无效。')
      const resolved = await resolveEvidenceFile(runRoot, runId, expectedScope, sourceSha256)
      if (!resolved) return null
      return readCompleteEvidence(runRoot, resolved.fileName, selection, resolved.expectedSha)
    },
    async queryCounts(runId, expectedScope, selection, sourceSha256) {
      const runRoot = runDirectory(runId); if (!runRoot) return null
      const resolved = await resolveEvidenceFile(runRoot, runId, expectedScope, sourceSha256); if (!resolved) return null
      const fileSig = await regularFileSig(join(runRoot, resolved.fileName))
      const cacheKey = `${runRoot}\0${resolved.fileName}\0${resolved.expectedSha ?? ''}\0${selectionCacheKey(selection)}`
      const cached = countsCache.get(cacheKey)
      if (cached?.fileSig === fileSig) {
        lruCacheSet(countsCache, cacheKey, cached)
        return cached.result
      }
      const result = await countNative(runRoot, resolved.fileName, selection, resolved.expectedSha)
      lruCacheSet(countsCache, cacheKey, { fileSig, result })
      return result
    },
    async queryRows(runId, expectedScope, options, sourceSha256) {
      const runRoot = runDirectory(runId); if (!runRoot) return null
      if (!Number.isSafeInteger(options.offset) || options.offset < 0 || !Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error('引擎帧归档分页参数无效。')
      const resolved = await resolveEvidenceFile(runRoot, runId, expectedScope, sourceSha256); if (!resolved) return null
      return pageNative(runRoot, resolved.fileName, options, resolved.expectedSha)
    },
    async querySeriesCatalog(runId, expectedScope, selection, sourceSha256) {
      const runRoot = runDirectory(runId); if (!runRoot) return null
      const resolved = await resolveEvidenceFile(runRoot, runId, expectedScope, sourceSha256); if (!resolved) return null
      const fileSig = await regularFileSig(join(runRoot, resolved.fileName))
      const cacheKey = `${runRoot}\0${resolved.fileName}\0${resolved.expectedSha ?? ''}\0${selectionCacheKey(selection)}`
      const cached = catalogCache.get(cacheKey)
      if (cached?.fileSig === fileSig) {
        lruCacheSet(catalogCache, cacheKey, cached)
        return cached.result
      }
      const result = await catalogNative(runRoot, resolved.fileName, selection, resolved.expectedSha)
      lruCacheSet(catalogCache, cacheKey, { fileSig, result })
      return result
    },
    async querySeriesPoints(runId, expectedScope, seriesId, selection, maxPoints, sourceSha256, cursorOffset) {
      const runRoot = runDirectory(runId); if (!runRoot) return null
      if (!Number.isSafeInteger(maxPoints) || maxPoints < 1) throw new Error('引擎帧归档曲线点数无效。')
      if (cursorOffset !== undefined && (!Number.isSafeInteger(cursorOffset) || cursorOffset < 0)) throw new Error('EVIDENCE_CURSOR_INVALID')
      const resolved = await resolveEvidenceFile(runRoot, runId, expectedScope, sourceSha256); if (!resolved) return null
      return pointsNative(runRoot, resolved.fileName, seriesId, selection, maxPoints, resolved.expectedSha, cursorOffset ?? 0)
    },
    async queryAllSeriesDownsampled(runId, expectedScope, selection, maxPointsPerSeries = EXPORT_CURVE_MAX_POINTS, sourceSha256) {
      const runRoot = runDirectory(runId); if (!runRoot) return null
      if (!Number.isSafeInteger(maxPointsPerSeries) || maxPointsPerSeries < 16) throw new Error('引擎帧归档曲线点数无效。')
      const resolved = await resolveEvidenceFile(runRoot, runId, expectedScope, sourceSha256); if (!resolved) return null
      return allSeriesDownsampledNative(runRoot, resolved.fileName, selection, maxPointsPerSeries, resolved.expectedSha)
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
        const pointer = JSON.parse(await readFile(current, 'utf8')) as { generation?: unknown; sourceSha256?: unknown; projectionVersion?: unknown }
        if (pointer.projectionVersion === ENGINE_CSV_PROJECTION_VERSION && pointer.sourceSha256 === manifest.sourceSha256 && typeof pointer.generation === 'string' && /^engine-csv-[0-9a-f-]{36}$/u.test(pointer.generation)) {
          const csvManifest = join(csvRoot, pointer.generation, 'manifest.json'); await regularFile(csvManifest)
          const evidence: unknown = JSON.parse(await readFile(csvManifest, 'utf8'))
          if (isCsvEvidence(evidence, manifest.sourceSha256)) return evidence
        }
      } catch { /* legacy archive: generate once from immutable JSONL below */ }
      const raw = join(runRoot, manifest.fileName); await regularFile(raw)
      // 原始归档已发布：先延迟生成，再立即提交派生 CSV 指针，保持旧读取路径可见。
      const publication = await publishEngineCsv(csvRoot, raw, manifest.scope.taskId, manifest.sourceSha256, manifest.linkBindings ?? {}, manifest.frameCount, { deferPointer: true })
      await publication.commitPointer()
      return publication.evidence
    },
    async getCsvFile(runId, sourceSha256, fileName) {
      const runRoot = runDirectory(runId); return runRoot ? getEngineCsvFile(join(runRoot, 'csv'), sourceSha256, fileName) : null
    },
    publishTaskCsv(runId, directory, evidence) {
      return publishTaskEngineCsv(directory, evidence, name => this.getCsvFile(runId, evidence.sourceSha256, name))
    },
    async loadCsvSource(runId, expectedScope, sourceSha256) {
      const evidence = await this.finalizeCsv(runId, expectedScope, {})
      if (!evidence) return null
      const runRoot = runDirectory(runId)!
      const manifest: unknown = JSON.parse(await readFile(join(runRoot, 'current.json'), 'utf8'))
      if (!isManifest(manifest, runId) || manifest.sourceSha256 !== evidence.sourceSha256
        || ['taskId', 'runId', 'scenarioId', 'revision', 'startedAt'].some(key => manifest.scope[key as keyof EngineFrameArchiveScope] !== expectedScope[key as keyof EngineFrameArchiveScope])) throw new Error('任务 CSV 与运行归档来源不一致。')
      const csvRoot = join(runRoot, 'csv')
      const relevantFiles = evidence.files.filter(file => file.fileName === 'link_state.csv' || file.fileName === 'link_loss.csv' || file.fileName === 'link_switch.csv')
      if (!relevantFiles.length) return null
      const bindings = manifest.linkBindings ?? {}
      const resolvedPaths = await Promise.all(relevantFiles.map(file => getEngineCsvFile(csvRoot, evidence.sourceSha256, file.fileName, { skipContentValidation: true })))
      const cacheKey = `${runRoot}\0${expectedScope.taskId}\0${evidence.sourceSha256}\0${JSON.stringify(bindings)}\0${JSON.stringify(relevantFiles.map(f => [f.fileName, f.sha256, f.rowCount]))}`
      const matchRequested = (source: EvidenceSource | null) =>
        source && (sourceSha256 === undefined || source.sourceSha256 === sourceSha256) ? source : null
      if (resolvedPaths.every((p): p is string => p !== null)) {
        try {
          const fileSigs = await Promise.all([regularFileSig(join(csvRoot, 'current.json')), ...resolvedPaths.map(p => regularFileSig(p))])
          const cached = csvSourceCache.get(cacheKey)
          if (cached && cached.fileSigs.length === fileSigs.length && cached.fileSigs.every((s, idx) => s === fileSigs[idx])) {
            lruCacheSet(csvSourceCache, cacheKey, cached, LARGE_OBJECT_CACHE_LIMIT)
            return matchRequested(cached.result)
          }
          const result = await readEngineCsvSource(evidence, expectedScope.taskId, bindings,
            name => getEngineCsvFile(csvRoot, evidence.sourceSha256, name, { skipContentValidation: true }))
          lruCacheSet(csvSourceCache, cacheKey, { fileSigs, result }, LARGE_OBJECT_CACHE_LIMIT)
          return matchRequested(result)
        } catch (error) {
          if (error instanceof Error && (error.message.includes('任务 CSV') || error.message.includes('引擎帧归档'))) throw error
        }
      }
      return readEngineCsvSource(evidence, expectedScope.taskId, bindings,
        name => getEngineCsvFile(csvRoot, evidence.sourceSha256, name, { skipContentValidation: true }), sourceSha256)
    },
    async aggregate(runId, expectedScope, linkBindings, selection) {
      const resolved = await readCurrentManifest(runId, expectedScope)
      if (!resolved) return null
      if (selection && (!Number.isFinite(selection.start) || !Number.isFinite(selection.end) || selection.start < 0 || selection.end < selection.start)) throw new Error('引擎帧归档筛选时间范围无效。')
      const { runRoot, manifest } = resolved
      linkBindings = manifest.linkBindings ?? {}
      const raw = join(runRoot, manifest.fileName)
      const fileSig = await regularFileSig(raw)
      const cacheKey = `${runRoot}\0${manifest.fileName}\0${manifest.sourceSha256}\0${JSON.stringify(linkBindings)}\0${selectionCacheKey(selection)}`
      const cached = aggregateCache.get(cacheKey)
      if (cached?.fileSig === fileSig) {
        lruCacheSet(aggregateCache, cacheKey, cached)
        return cached.result
      }
      const aggState = createAggregateState()
      let rows = 0
      const source = await readStableUtf8Lines(raw, line => {
        const frame: unknown = JSON.parse(line)
        if (!isEngineFrameSnapshot(frame)) throw new Error('引擎帧归档包含不符合契约的记录。')
        rows += 1
        accumulateFrameAggregate(frame, linkBindings, selection, aggState)
      }, MAX_ARCHIVE_BYTES, ENGINE_JSONL_LINE_LIMIT_BYTES)
      if (source.waitingForLine || source.source.sha256 !== manifest.sourceSha256 || rows !== manifest.frameCount) throw new Error('引擎帧归档来源校验失败。')
      const result = aggregateSummary(aggState)
      lruCacheSet(aggregateCache, cacheKey, { fileSig, result })
      return result
    },
  }
}

function switchCountTrend(state: EngineAggregateState): LocalReportTrendPoint[] {
  const { firstObservedTime, lastObservedTime, switchChanges } = state
  if (firstObservedTime === undefined || lastObservedTime === undefined) return []
  const changes = orderedTrendChanges(switchChanges)
  const points: LocalReportTrendPoint[] = []
  if ((changes[0]?.[0] ?? Infinity) > firstObservedTime && (switchChanges.omittedFrom ?? Infinity) > firstObservedTime) {
    points.push({ time: firstObservedTime, value: 0 })
  }
  let value = 0
  for (const [time, count] of changes) {
    value += count
    points.push({ time, value })
  }
  if (points.at(-1)?.time !== lastObservedTime) points.push({
    time: lastObservedTime, value: state.switches,
    ...(switchChanges.omittedFrom !== undefined ? { breakBefore: true } : {}),
  })
  return points
}

function jammingDurationTrend(state: EngineAggregateState): LocalReportTrendPoint[] {
  if (state.lastKnownJammingTime === undefined) return []
  const points: LocalReportTrendPoint[] = []
  let known = 0, active = 0, value = 0
  for (const [time, boundary] of orderedTrendChanges(state.jammingBoundaries)) {
    const previous = points.at(-1)
    if (previous && known > 0) value = Math.min(state.jammingDuration, value + (time - previous.time) * active)
    const discontinuous = known === 0 && previous !== undefined
    known += boundary.known
    active += boundary.active
    points.push({ time, value, ...(discontinuous ? { breakBefore: true } : {}) })
  }
  const last = points.at(-1)
  if (last && last.time === state.lastKnownJammingTime) last.value = state.jammingDuration
  else points.push({
    time: state.lastKnownJammingTime, value: state.jammingDuration,
    ...(last || state.jammingBoundaries.omittedFrom !== undefined ? { breakBefore: true } : {}),
  })
  return points
}

function aggregateSummary(state: EngineAggregateState): EngineAggregateSummary {
  const connected = state.intervalObserved && state.observedLinks.size > 0
    ? [...state.linkDurations.values()].reduce((sum, value) => sum + value, 0) / state.observedLinks.size
    : undefined
  const jamming = state.lastKnownJammingTime === undefined ? undefined : state.jammingDuration
  const switchTrend = switchCountTrend(state)
  const jammingTrend = jamming === undefined ? [] : jammingDurationTrend(state)
  return {
    uniqueSingleSegmentCount: state.count,
    ...(state.count ? { averageGxbDb: state.gxb / state.count, averageBer: state.ber / state.count } : {}),
    switchCount: state.switches,
    ...(connected === undefined ? {} : { averageConnectedDurationS: connected }),
    ...(jamming === undefined ? {} : { jammingDurationS: jamming }),
    ...(switchTrend.length ? { switchCountTrend: switchTrend } : {}),
    ...(jammingTrend.length ? { jammingDurationTrend: jammingTrend } : {}),
    missing: [...(connected === undefined ? ['connectivityDurationS'] : []), ...(jamming === undefined ? ['interferenceDurationS'] : [])],
  }
}

/** Reads the immutable JSONL generation once, verifies its digest, and projects only received segment/event values. */
async function readSummary(runRoot: string, manifest: Manifest, selection?: ArchiveSelection, maxReportRows = MAX_REPORT_ROWS): Promise<EngineFrameArchiveSummary> {
  const framePath = join(runRoot, manifest.fileName)
  await regularFile(framePath)
  const segmentRows: EngineFrameArchiveSegmentRow[] = []
  const switchRows: EngineFrameArchiveSwitchRow[] = []
  const eventRows: EngineFrameArchiveEventRow[] = []
  let rows = 0
  let detailTruncated = false
  const summaryState = { segmentRows, switchRows, eventRows, detailTruncated }
  const source = await readStableUtf8Lines(framePath, line => {
    let frame: unknown
    try { frame = JSON.parse(line) } catch { throw new Error('引擎帧归档包含无效 JSON 记录。') }
    if (!isEngineFrameSnapshot(frame)) throw new Error('引擎帧归档包含不符合契约的记录。')
    rows += 1
    accumulateFrameSummary(frame, selection, maxReportRows, summaryState)
  }, MAX_ARCHIVE_BYTES, ENGINE_JSONL_LINE_LIMIT_BYTES)
  detailTruncated = summaryState.detailTruncated
  if (source.waitingForLine || source.source.sha256 !== manifest.sourceSha256 || rows !== manifest.frameCount) throw new Error('引擎帧归档来源校验失败。')
  return { sourceSha256: manifest.sourceSha256, frameCount: manifest.frameCount, firstSimulationTime: manifest.firstSimulationTime,
    lastSimulationTime: manifest.lastSimulationTime, missingFieldNames: manifest.missingFieldNames, segmentRows, switchRows, eventRows,
    ...(detailTruncated ? { detailTruncated: true, retainedDetailRows: segmentRows.length + switchRows.length + eventRows.length } : {}) }
}

/**
 * D3 完整读取：受 MAX_ARCHIVE_BYTES 字节上限约束（不按 50000 行截断），返回全部命中的段/切换/事件明细。
 * 以来源摘要校验完整内容，保持旧 readSummary（50000 行保护）不变。
 */
async function readCompleteEvidence(runRoot: string, fileName: string, selection?: ArchiveSelection, expectedSha256?: string): Promise<EngineFrameArchiveSummary> {
  const framePath = join(runRoot, fileName)
  await regularFile(framePath)
  const segmentRows: EngineFrameArchiveSegmentRow[] = []
  const switchRows: EngineFrameArchiveSwitchRow[] = []
  const eventRows: EngineFrameArchiveEventRow[] = []
  let frameCount = 0
  let first: number | null = null
  let last: number | null = null
  const missing = new Set<string>()
  const selectedLinkId = selection?.linkId
  const source = await readStableUtf8Lines(framePath, line => {
    let frame: unknown
    try { frame = JSON.parse(line) } catch { throw new Error('引擎帧归档包含无效 JSON 记录。') }
    if (!isEngineFrameSnapshot(frame)) throw new Error('引擎帧归档包含不符合契约的记录。')
    frameCount += 1
    first = first === null ? frame.simulationTime : Math.min(first, frame.simulationTime)
    last = last === null ? frame.simulationTime : Math.max(last, frame.simulationTime)
    missing.add('snrDb')
    if (frame.links.some(link => link.quality.gxbDb === null)) missing.add('gxbDb')
    if (frame.links.some(link => link.quality.ber === null)) missing.add('ber')
    if (frame.links.some(link => link.quality.rxPowerDbm === null && link.quality.rxPowerDbw === null)) missing.add('receivedPower')
    if (!inSelection(selection, frame.simulationTime)) return
    const common = { engineEpoch: frame.engineEpoch, frameId: frame.frameId, simulationTime: frame.simulationTime }
    const segmentRowsForFrame = frame.links.filter(link => (!selection?.nodeId || link.sourcePlatformId === selection.nodeId || link.targetPlatformId === selection.nodeId)
      && (!selectedLinkId || link.linkId === selectedLinkId || link.linkIds.includes(selectedLinkId)))
    const switchRowsForFrame = frame.routing.switches.filter(route => (!selection?.nodeId || route.sourcePlatformId === selection.nodeId || route.targetPlatformId === selection.nodeId
      || route.nodes.some(node => node.platformId === selection.nodeId) || route.oldNodes.some(node => node.platformId === selection.nodeId))
      && (!selectedLinkId || route.reasons.some(reason => reason.linkId === selectedLinkId
        || frame.links.some(link => link.linkId === reason.linkId && link.linkIds.includes(selectedLinkId)))))
    const eventRowsForFrame = selectedLinkId ? [] : frame.events.filter(event => !selection?.nodeId || event.uavIds.includes(selection.nodeId) || event.jammerIds.includes(selection.nodeId))
    segmentRows.push(...segmentRowsForFrame.map(segment => ({ ...common, segment })))
    switchRows.push(...switchRowsForFrame.map(value => ({ ...common, value })))
    eventRows.push(...eventRowsForFrame.map(value => ({ ...common, value })))
  }, MAX_ARCHIVE_BYTES, ENGINE_JSONL_LINE_LIMIT_BYTES)
  if (source.waitingForLine) throw new Error('引擎帧归档来源存在未完成尾行。')
  if (expectedSha256 && source.source.sha256 !== expectedSha256) throw new Error('引擎帧归档来源摘要不一致。')
  return { sourceSha256: source.source.sha256, frameCount, firstSimulationTime: first, lastSimulationTime: last, missingFieldNames: [...missing].sort(), segmentRows, switchRows, eventRows }
}

// —— D3 有界原生查询（流式、只保留当前页/计数/有界曲线点）——
const idPart = (value: unknown) => value === null || value === undefined ? '∅' : String(value)
function segmentMatches(link: EngineFrameSnapshot['links'][number], selection: NativeSelection | undefined): boolean {
  return (!selection?.nodeId || link.sourcePlatformId === selection.nodeId || link.targetPlatformId === selection.nodeId)
    && (!selection?.linkId || link.linkId === selection.linkId || link.linkIds.includes(selection.linkId))
}
function switchMatches(frame: EngineFrameSnapshot, route: EngineFrameSnapshot['routing']['switches'][number], selection: NativeSelection | undefined): boolean {
  if (!selection) return true
  const nodeOk = !selection.nodeId || route.sourcePlatformId === selection.nodeId || route.targetPlatformId === selection.nodeId
    || route.nodes.some(node => node.platformId === selection.nodeId) || route.oldNodes.some(node => node.platformId === selection.nodeId)
  const linkOk = !selection.linkId || route.reasons.some(reason => reason.linkId === selection.linkId || frame.links.some(link => link.linkId === reason.linkId && link.linkIds.includes(selection.linkId!)))
  return nodeOk && linkOk
}
function eventMatches(event: EngineFrameSnapshot['events'][number], selection: NativeSelection | undefined): boolean {
  if (selection?.linkId) return false
  return !selection?.nodeId || event.uavIds.includes(selection.nodeId) || event.jammerIds.includes(selection.nodeId)
}

/** 解析证据文件（current 或固定 sha 的不可变代），并在固定 sha 时用该代自有清单校验作用域。 */
async function resolveEvidenceFile(runRoot: string, runId: string, expectedScope: EngineFrameArchiveScope | undefined, sourceSha256: string | undefined): Promise<{ fileName: string; expectedSha?: string } | null> {
  const pointer = join(runRoot, 'current.json')
  let manifest: Manifest | undefined
  try { await regularFile(pointer); const raw: unknown = JSON.parse(await readFile(pointer, 'utf8')); if (isManifest(raw, runId)) manifest = raw } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const checkScope = (scope: EngineFrameArchiveScope) => {
    if (expectedScope && ['taskId', 'runId', 'scenarioId', 'revision', 'startedAt'].some(key => scope[key as keyof EngineFrameArchiveScope] !== expectedScope[key as keyof EngineFrameArchiveScope])) throw new Error('引擎帧归档作用域与运行结果不一致。')
  }
  if (sourceSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/u.test(sourceSha256)) return null
    if (manifest?.sourceSha256 === sourceSha256) { checkScope(manifest.scope); return { fileName: manifest.fileName, expectedSha: sourceSha256 } }
    const candidates = (await readdir(runRoot)).filter(name => /^engine-[0-9a-f-]{36}\.jsonl$/u.test(name))
    for (const name of candidates) {
      if (manifest && name === manifest.fileName) continue
      const probe = await readStableUtf8Lines(join(runRoot, name), () => undefined, MAX_ARCHIVE_BYTES, ENGINE_JSONL_LINE_LIMIT_BYTES)
      if (probe.source.sha256 !== sourceSha256) continue
      const id = name.replace(/^engine-(.*)\.jsonl$/u, '$1')
      let own: unknown
      try { const ownPath = join(runRoot, `engine-${id}.json`); await regularFile(ownPath); own = JSON.parse(await readFile(ownPath, 'utf8')) } catch { throw new Error('EVIDENCE_ARCHIVE_EVIDENCE_INSUFFICIENT') }
      if (!isManifest(own, runId) || own.sourceSha256 !== sourceSha256 || own.fileName !== name) throw new Error('引擎帧归档历史清单无效。')
      checkScope(own.scope)
      return { fileName: name, expectedSha: sourceSha256 }
    }
    return null
  }
  if (!manifest) return null
  checkScope(manifest.scope)
  return { fileName: manifest.fileName, expectedSha: manifest.sourceSha256 }
}

async function countNative(runRoot: string, fileName: string, selection: NativeSelection | undefined, expectedSha256?: string): Promise<NativeCounts> {
  const counts: NativeCounts = { segments: 0, switches: 0, events: 0, sourceSha256: '' }
  const source = await readStableUtf8Lines(join(runRoot, fileName), line => {
    const frame: unknown = JSON.parse(line)
    if (!isEngineFrameSnapshot(frame) || !inSelection(selection, frame.simulationTime)) return
    counts.segments += frame.links.filter(link => segmentMatches(link, selection)).length
    counts.switches += frame.routing.switches.filter(route => switchMatches(frame, route, selection)).length
    counts.events += frame.events.filter(event => eventMatches(event, selection)).length
  }, MAX_ARCHIVE_BYTES, ENGINE_JSONL_LINE_LIMIT_BYTES)
  if (source.waitingForLine) throw new Error('引擎帧归档来源存在未完成尾行。')
  if (expectedSha256 && source.source.sha256 !== expectedSha256) throw new Error('引擎帧归档来源摘要不一致。')
  counts.sourceSha256 = source.source.sha256
  return counts
}

function nativeRow(kind: NativeKind, frame: EngineFrameSnapshot, localIndex: number, value: unknown): NativeRow {
  const base = { engineEpoch: frame.engineEpoch, frameId: frame.frameId, seq: localIndex, kind, time: frame.simulationTime }
  return { ...base, ...(value as Record<string, unknown>), id: `${kind === 'segments' ? 'seg' : kind === 'switches' ? 'sw' : 'ev'}:${frame.engineEpoch}:${frame.frameId}:${localIndex}` } as NativeRow
}
function segmentRowValue(link: EngineFrameSnapshot['links'][number]) {
  return { linkId: link.linkId, linkIds: link.linkIds, sourcePlatformId: link.sourcePlatformId, targetPlatformId: link.targetPlatformId, sourceName: link.sourceName, sourcePort: link.sourcePort, targetName: link.targetName, targetPort: link.targetPort, gxbDb: link.quality.gxbDb, ber: link.quality.ber, rxPowerDbm: link.quality.rxPowerDbm, rxPowerDbw: link.quality.rxPowerDbw, totalDb: link.losses.totalDb }
}
function switchRowValue(route: EngineFrameSnapshot['routing']['switches'][number]) {
  return { linkId: route.reasons[0]?.linkId ?? null, linkIds: route.reasons.map(reason => reason.linkId).filter((id): id is string => typeof id === 'string'), sourcePlatformId: route.sourcePlatformId, targetPlatformId: route.targetPlatformId, direction: route.direction, pathId: route.pathId }
}

async function pageNative(runRoot: string, fileName: string, options: { selection?: NativeSelection; kind: NativeKind; offset: number; limit: number }, expectedSha256?: string): Promise<{ total: number; rows: NativeRow[] }> {
  const rows: NativeRow[] = []
  let matched = 0
  const source = await readStableUtf8Lines(join(runRoot, fileName), line => {
    const frame: unknown = JSON.parse(line)
    if (!isEngineFrameSnapshot(frame) || !inSelection(options.selection, frame.simulationTime)) return
    const values: unknown[] = options.kind === 'segments' ? frame.links.filter(link => segmentMatches(link, options.selection)).map(segmentRowValue)
      : options.kind === 'switches' ? frame.routing.switches.filter(route => switchMatches(frame, route, options.selection)).map(switchRowValue)
        : frame.events.filter(event => eventMatches(event, options.selection)).map(event => ({ type: event.type, sourcePlatformId: event.uavIds[0] ?? null, targetPlatformId: null }))
    for (let index = 0; index < values.length; index += 1) {
      if (matched >= options.offset && matched < options.offset + options.limit) rows.push(nativeRow(options.kind, frame, index, values[index]))
      matched += 1
    }
  }, MAX_ARCHIVE_BYTES, ENGINE_JSONL_LINE_LIMIT_BYTES)
  if (source.waitingForLine) throw new Error('引擎帧归档来源存在未完成尾行。')
  if (expectedSha256 && source.source.sha256 !== expectedSha256) throw new Error('引擎帧归档来源摘要不一致。')
  return { total: matched, rows }
}

function identityOf(frame: EngineFrameSnapshot, link: EngineFrameSnapshot['links'][number]): NativeSeriesIdentity {
  return { engineEpoch: frame.engineEpoch, linkId: link.linkId, sourcePlatformId: link.sourcePlatformId ?? null, targetPlatformId: link.targetPlatformId ?? null,
    sourceName: link.sourceName ?? null, sourcePort: link.sourcePort ?? null, targetName: link.targetName ?? null, targetPort: link.targetPort ?? null, frameStep: ENGINE_FRAME_ID_STEP }
}
function seriesKey(identity: NativeSeriesIdentity): string {
  return [identity.engineEpoch, idPart(identity.linkId), idPart(identity.sourcePlatformId), idPart(identity.sourceName), idPart(identity.sourcePort), idPart(identity.targetPlatformId), idPart(identity.targetName), idPart(identity.targetPort)].join('\u0000')
}
function seriesIdOf(identity: NativeSeriesIdentity, metric: 'gxb' | 'ber'): string {
  return `segments:${Buffer.from(JSON.stringify(identity)).toString('base64url')}:${metric}`
}
function parseSeriesId(seriesId: string): { identity: NativeSeriesIdentity; metric: string } | null {
  const match = /^segments:([A-Za-z0-9_-]+):(gxb|ber)$/u.exec(seriesId)
  if (!match) return null
  try { return { identity: JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')) as NativeSeriesIdentity, metric: match[2]! } } catch { return null }
}

async function catalogNative(runRoot: string, fileName: string, selection: NativeSelection | undefined, expectedSha256?: string): Promise<NativeSeriesMetaOut[]> {
  const identities = new Map<string, NativeSeriesIdentity>()
  const source = await readStableUtf8Lines(join(runRoot, fileName), line => {
    const frame: unknown = JSON.parse(line)
    if (!isEngineFrameSnapshot(frame) || !inSelection(selection, frame.simulationTime)) return
    for (const link of frame.links) if (segmentMatches(link, selection)) { const identity = identityOf(frame, link); const key = seriesKey(identity); if (!identities.has(key)) identities.set(key, identity) }
  }, MAX_ARCHIVE_BYTES, ENGINE_JSONL_LINE_LIMIT_BYTES)
  if (source.waitingForLine) throw new Error('引擎帧归档来源存在未完成尾行。')
  if (expectedSha256 && source.source.sha256 !== expectedSha256) throw new Error('引擎帧归档来源摘要不一致。')
  const metas: NativeSeriesMetaOut[] = []
  for (const identity of [...identities.values()].sort((left, right) => seriesKey(left).localeCompare(seriesKey(right)))) {
    metas.push({ seriesId: seriesIdOf(identity, 'gxb'), unit: 'dB', identity }, { seriesId: seriesIdOf(identity, 'ber'), unit: 'BER', identity })
  }
  return metas
}

async function pointsNative(runRoot: string, fileName: string, seriesId: string, selection: NativeSelection | undefined, maxPoints: number, expectedSha256?: string, offset = 0): Promise<NativeSeriesPoints> {
  const parsed = parseSeriesId(seriesId)
  if (!parsed) throw new Error('引擎帧证据曲线标识无效。')
  const key = seriesKey(parsed.identity)
  const metric = parsed.metric
  const valueOf = (frame: EngineFrameSnapshot, link: EngineFrameSnapshot['links'][number]) => metric === 'ber' ? link.quality.ber : link.quality.gxbDb
  // Pass1: 计数、首/末、内部极值索引、强制点集合（≤预算时保存，超预算只记溢出）与缺测断点。
  let count = 0, minValue = Infinity, maxValue = -Infinity, minIndex = 0, maxIndex = 0
  const forced = new Set<number>()
  let overflow = false
  let prevFrameId: number | null = null
  let gap = false
  const pass1 = await readStableUtf8Lines(join(runRoot, fileName), line => {
    const frame: unknown = JSON.parse(line)
    if (!isEngineFrameSnapshot(frame) || !inSelection(selection, frame.simulationTime)) return
    for (const link of frame.links) {
      if (!segmentMatches(link, selection) || seriesKey(identityOf(frame, link)) !== key) continue
      const value = valueOf(frame, link)
      const isBreak = prevFrameId !== null && (frame.frameId !== prevFrameId + ENGINE_FRAME_ID_STEP || gap)
      if (value === null) { gap = true; prevFrameId = frame.frameId; continue }
      if (!overflow) {
        if (count === 0) forced.add(0)
        if (isBreak) { forced.add(count); if (count > 0) forced.add(count - 1) }
        if (forced.size > maxPoints) { overflow = true; forced.clear() }
      }
      if (value < minValue) { minValue = value; minIndex = count }
      if (value > maxValue) { maxValue = value; maxIndex = count }
      count += 1; prevFrameId = frame.frameId; gap = false
    }
  }, MAX_ARCHIVE_BYTES, ENGINE_JSONL_LINE_LIMIT_BYTES)
  if (pass1.waitingForLine) throw new Error('引擎帧归档来源存在未完成尾行。')
  if (expectedSha256 && pass1.source.sha256 !== expectedSha256) throw new Error('引擎帧归档来源摘要不一致。')
  if (count === 0) { if (offset !== 0) throw new Error('EVIDENCE_CURSOR_INVALID'); return { rawCount: 0, sampling: 'FULL', points: [], nextOffset: null } }
  // 全量不超预算：返回全部有效点（首尾与所有内部点）。
  if (count <= maxPoints) {
    if (offset !== 0) throw new Error('EVIDENCE_CURSOR_INVALID')
    const points = await emitNativePoints(runRoot, fileName, key, selection, valueOf, () => true)
    return { rawCount: count, sampling: 'FULL', points, nextOffset: null }
  }
  // 是否分页依据“完整强制点集合”：首/末、内部极值、断点及断点前一点。
  // 末点与极值索引在 pass1 结束后才确定，必须在此一并计入，避免“先判定不溢出、再补必要点后超预算”。
  const essentials = new Set<number>([0, count - 1, minIndex, maxIndex])
  const forcedTotal = forced.size + [...essentials].filter(index => !forced.has(index)).length
  if (!overflow && forcedTotal <= maxPoints) {
    if (offset !== 0) throw new Error('EVIDENCE_CURSOR_INVALID')
    const chosen = new Set<number>(essentials); for (const index of forced) chosen.add(index)
    const room = maxPoints - chosen.size
    const step = count / (room + 1)
    for (let n = 1; n <= room; n += 1) chosen.add(Math.min(count - 1, Math.round(step * n)))
    const points = await emitNativePoints(runRoot, fileName, key, selection, valueOf, index => chosen.has(index))
    return { rawCount: count, sampling: 'DOWNSAMPLED', points, nextOffset: null }
  }
  // 强制点超预算：按稳定顺序流式分页续取（首/末/极值/断点及前一点，不抽样丢强制点）。
  const page: Array<{ time: number; value: number; breakBefore?: boolean }> = []
  let forcedCount = 0, index = 0
  let prevFrameId2: number | null = null, gap2 = false
  let pending: { index: number; time: number; value: number; isBreak: boolean } | null = null
  const emit = (point: { index: number; time: number; value: number; isBreak: boolean }) => {
    const position = forcedCount; forcedCount += 1
    if (position >= offset && position < offset + maxPoints) page.push({ time: point.time, value: point.value, ...(point.isBreak ? { breakBefore: true } : {}) })
  }
  const pass2 = await readStableUtf8Lines(join(runRoot, fileName), line => {
    const frame: unknown = JSON.parse(line)
    if (!isEngineFrameSnapshot(frame) || !inSelection(selection, frame.simulationTime)) return
    for (const link of frame.links) {
      if (!segmentMatches(link, selection) || seriesKey(identityOf(frame, link)) !== key) continue
      const value = valueOf(frame, link)
      const isBreak = prevFrameId2 !== null && (frame.frameId !== prevFrameId2 + ENGINE_FRAME_ID_STEP || gap2)
      if (value === null) { gap2 = true; prevFrameId2 = frame.frameId; continue }
      const current = { index, time: frame.simulationTime, value, isBreak }
      if (pending && (essentials.has(pending.index) || pending.isBreak || isBreak)) emit(pending)
      pending = current; index += 1; prevFrameId2 = frame.frameId; gap2 = false
    }
  }, MAX_ARCHIVE_BYTES, ENGINE_JSONL_LINE_LIMIT_BYTES)
  if (pass2.waitingForLine) throw new Error('引擎帧归档来源存在未完成尾行。')
  if (pending) emit(pending)
  if (offset !== 0 && (offset % maxPoints !== 0 || offset >= forcedCount)) throw new Error('EVIDENCE_CURSOR_INVALID')
  const nextOffset = offset + page.length < forcedCount ? offset + page.length : null
  return { rawCount: count, sampling: 'DOWNSAMPLED', points: page, nextOffset }
}

/** 第三遍：按选择谓词（以有效点序号）发射点，计算与首遍一致的 breakBefore。 */
async function emitNativePoints(runRoot: string, fileName: string, key: string, selection: NativeSelection | undefined, valueOf: (frame: EngineFrameSnapshot, link: EngineFrameSnapshot['links'][number]) => number | null, selected: (index: number) => boolean): Promise<Array<{ time: number; value: number; breakBefore?: boolean }>> {
  const points: Array<{ time: number; value: number; breakBefore?: boolean }> = []
  let index = 0
  let prevFrameId: number | null = null, gap = false
  const source = await readStableUtf8Lines(join(runRoot, fileName), line => {
    const frame: unknown = JSON.parse(line)
    if (!isEngineFrameSnapshot(frame) || !inSelection(selection, frame.simulationTime)) return
    for (const link of frame.links) {
      if (!segmentMatches(link, selection) || seriesKey(identityOf(frame, link)) !== key) continue
      const value = valueOf(frame, link)
      const isBreak = prevFrameId !== null && (frame.frameId !== prevFrameId + ENGINE_FRAME_ID_STEP || gap)
      if (value === null) { gap = true; prevFrameId = frame.frameId; continue }
      if (selected(index)) points.push({ time: frame.simulationTime, value, ...(isBreak ? { breakBefore: true } : {}) })
      index += 1; prevFrameId = frame.frameId; gap = false
    }
  }, MAX_ARCHIVE_BYTES, ENGINE_JSONL_LINE_LIMIT_BYTES)
  if (source.waitingForLine) throw new Error('引擎帧归档来源存在未完成尾行。')
  return points
}

/** 单遍流式扫描并按极值保真分桶输出所有曲线，内存 O(曲线数 × maxPointsPerSeries)。 */
async function allSeriesDownsampledNative(
  runRoot: string,
  fileName: string,
  selection: NativeSelection | undefined,
  maxPointsPerSeries: number,
  expectedSha256?: string,
): Promise<Array<{ meta: NativeSeriesMetaOut; rawCount: number; sampling: 'FULL' | 'DOWNSAMPLED'; points: Array<{ time: number; value: number; breakBefore?: boolean }> }>> {
  type MetricTrack = { prevFrameId: number | null; gap: boolean; reservoir: StreamingCurveReservoir }
  type PairState = { key: string; identity: NativeSeriesIdentity; gxb: MetricTrack; ber: MetricTrack }
  const states = new Map<string, PairState>()
  const feed = (track: MetricTrack, frameId: number, time: number, value: number | null) => {
    const isBreak = track.prevFrameId !== null && (frameId !== track.prevFrameId + ENGINE_FRAME_ID_STEP || track.gap)
    if (value === null || !Number.isFinite(value)) {
      track.gap = true
      track.prevFrameId = frameId
      return
    }
    track.reservoir.push(time, value, isBreak)
    track.prevFrameId = frameId
    track.gap = false
  }
  const source = await readStableUtf8Lines(join(runRoot, fileName), line => {
    const frame: unknown = JSON.parse(line)
    if (!isEngineFrameSnapshot(frame) || !inSelection(selection, frame.simulationTime)) return
    for (const link of frame.links) {
      if (!segmentMatches(link, selection)) continue
      const identity = identityOf(frame, link)
      const key = seriesKey(identity)
      let state = states.get(key)
      if (!state) {
        state = {
          key,
          identity,
          gxb: { prevFrameId: null, gap: false, reservoir: new StreamingCurveReservoir(maxPointsPerSeries) },
          ber: { prevFrameId: null, gap: false, reservoir: new StreamingCurveReservoir(maxPointsPerSeries) },
        }
        states.set(key, state)
      }
      feed(state.gxb, frame.frameId, frame.simulationTime, link.quality.gxbDb)
      feed(state.ber, frame.frameId, frame.simulationTime, link.quality.ber)
    }
  }, MAX_ARCHIVE_BYTES, ENGINE_JSONL_LINE_LIMIT_BYTES)
  if (source.waitingForLine) throw new Error('引擎帧归档来源存在未完成尾行。')
  if (expectedSha256 && source.source.sha256 !== expectedSha256) throw new Error('引擎帧归档来源摘要不一致。')

  const ordered = [...states.values()].sort((left, right) => left.key.localeCompare(right.key))
  const results: Array<{ meta: NativeSeriesMetaOut; rawCount: number; sampling: 'FULL' | 'DOWNSAMPLED'; points: Array<{ time: number; value: number; breakBefore?: boolean }> }> = []
  for (const state of ordered) {
    const gxbOut = state.gxb.reservoir.finalize()
    if (gxbOut.points.length) {
      results.push({
        meta: { seriesId: seriesIdOf(state.identity, 'gxb'), unit: 'dB', identity: state.identity },
        ...gxbOut,
      })
    }
    const berOut = state.ber.reservoir.finalize()
    if (berOut.points.length) {
      results.push({
        meta: { seriesId: seriesIdOf(state.identity, 'ber'), unit: 'BER', identity: state.identity },
        ...berOut,
      })
    }
  }
  return results
}

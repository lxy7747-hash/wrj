import type { EngineFrameArchiveSummary, LocalReportFilter, QualityDataset, TaskPhase } from '../../contracts/domain-models'
import { ENGINE_FRAME_ID_STEP } from '../data-exchange/engine-frame-snapshot'
import { resolvePhaseRange, type PhaseRange } from './local-report'

/**
 * 09/D3 独立报告证据查询（06/09 共用本地 DTO、校验与投影）。
 * 这里只做纯投影：把文件集或原生帧归档转成按 kind 的稳定行与曲线，再做「先筛选后游标分页」。
 * 不读取 current 指针、不混合来源、不把抽样值冒充精确统计。
 */

export const EVIDENCE_KINDS = ['quality', 'state', 'loss', 'switch', 'segments', 'switches', 'events'] as const
export type EvidenceKind = typeof EVIDENCE_KINDS[number]
const FILE_SET_KINDS: EvidenceKind[] = ['quality', 'state', 'loss', 'switch']
const NATIVE_KINDS: EvidenceKind[] = ['segments', 'switches', 'events']

export type EvidenceSourceKind = 'FILE_SET' | 'NATIVE_ARCHIVE'
export interface EvidenceRow { id: string; time: number; seq?: number; [key: string]: unknown }
/** 曲线身份：原生含 epoch + 链路 + 设备端点/端口；CSV 含链路与冻结步长。 */
export interface EvidenceSeriesMeta {
  seriesId: string; kind: EvidenceKind; unit: string
  linkId?: string
  engineEpoch?: number
  sourcePlatformId?: string | null; targetPlatformId?: string | null
  sourceName?: string | null; sourcePort?: string | null; targetName?: string | null; targetPort?: string | null
  /** 原生帧号步长（ENGINE_FRAME_ID_STEP）。 */
  frameStep?: number
  /** CSV 冻结秒步长（expectedStepS）；缺省表示连续性不可确定。 */
  timeStepS?: number
}
export interface EvidenceSourceInfo {
  sourceSha256: string
  sourceKind: EvidenceSourceKind
  capabilities: EvidenceKind[]
  totals: Record<string, number>
  series: EvidenceSeriesMeta[]
  label: string
}
export interface EvidenceSource extends EvidenceSourceInfo {
  rowsByKind: Record<EvidenceKind, EvidenceRow[]>
}

export const EVIDENCE_ROWS_DEFAULT = 200
export const EVIDENCE_ROWS_MAX = 1000
export const EVIDENCE_SERIES_DEFAULT = 1000
export const EVIDENCE_SERIES_MAX = 5000

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const num = (value: unknown): number | null => isFiniteNumber(value) ? value : null

/** 规范化筛选：固定键顺序，供游标绑定与 effectiveFilter 展示。 */
export function normalizeEvidenceFilter(filter: LocalReportFilter | undefined): LocalReportFilter {
  const out: LocalReportFilter = {}
  for (const key of ['nodeId', 'linkId', 'stage'] as const) if (filter?.[key] !== undefined) out[key] = filter[key] as string
  for (const key of ['from', 'to'] as const) if (typeof filter?.[key] === 'number') out[key] = filter[key] as number
  return out
}
export const evidenceFilterKey = (filter: LocalReportFilter | undefined): string => JSON.stringify(normalizeEvidenceFilter(filter))

// —— base64url（浏览器与 Node 通用的 btoa/atob）——
const toBase64Url = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
const fromBase64Url = (value: string): string => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/gu, '+').replace(/_/gu, '/')), char => char.charCodeAt(0)))

export interface EvidenceCursorIdentity { reportId: string; resultId: string; runId: string; sourceSha256: string; filterKey: string; kind: string; seriesId?: string; seriesMaxPoints?: number }
interface CursorPayload extends EvidenceCursorIdentity { v: 1; pos: number; posKind: 'ROW' | 'SERIES' }

/** 游标绑定结果/报告/运行/源摘要/规范化 filter/kind（曲线另含 seriesId 与首次 maxPoints）与稳定位置。 */
export function encodeEvidenceCursor(identity: EvidenceCursorIdentity, pos: number, posKind: 'ROW' | 'SERIES'): string {
  const payload: CursorPayload = { v: 1, ...identity, pos, posKind }
  return toBase64Url(JSON.stringify(payload))
}
export function decodeEvidenceCursor(value: string, identity: EvidenceCursorIdentity, posKind: 'ROW' | 'SERIES'): number {
  let payload: unknown
  try { payload = JSON.parse(fromBase64Url(value)) } catch { throw new Error('EVIDENCE_CURSOR_INVALID') }
  const row = payload as Partial<CursorPayload>
  if (!row || row.v !== 1 || row.posKind !== posKind || !Number.isSafeInteger(row.pos) || (row.pos as number) < 0
    || row.reportId !== identity.reportId || row.resultId !== identity.resultId || row.runId !== identity.runId
    || row.sourceSha256 !== identity.sourceSha256 || row.filterKey !== identity.filterKey
    || row.kind !== identity.kind || row.seriesId !== identity.seriesId
    || (posKind === 'SERIES' && row.seriesMaxPoints !== identity.seriesMaxPoints)) throw new Error('EVIDENCE_CURSOR_INVALID')
  return row.pos as number
}

/** 时间窗口 + 节点/链路筛选；窗口本身由 04 的半开阶段规则经 resolvePhaseRange 产出。 */
export function evidenceWindow(evidence: { startTimeS: number; endTimeS: number }, filter: LocalReportFilter | undefined, phases: TaskPhase[] | undefined, reportEndTimeS?: number): PhaseRange {
  return resolvePhaseRange(evidence, filter, phases, reportEndTimeS ?? evidence.endTimeS)
}
function inWindow(window: PhaseRange, time: number): boolean {
  if (time < window.start || time > window.end) return false
  if (window.phase === undefined) return true
  if (time < window.phase.endTimeS) return true
  if (time > window.phase.endTimeS) return false
  return window.includeEnd
}
function nodeIdsOf(row: EvidenceRow): string[] {
  const direct = [row.sourcePlatformId, row.targetPlatformId, row.platformId, row.sourcePlatform, row.destPlatform]
    .filter((item): item is string => typeof item === 'string')
  const related = Array.isArray(row.nodes) ? row.nodes.map(node => (node as { platformId?: unknown }).platformId).filter((item): item is string => typeof item === 'string') : []
  return [...direct, ...related]
}
function linkIdsOf(row: EvidenceRow): string[] {
  return [row.linkId, ...(Array.isArray(row.linkIds) ? row.linkIds : [])].filter((item): item is string => typeof item === 'string')
}
function rowMatches(row: EvidenceRow, filter: LocalReportFilter | undefined, window: PhaseRange): boolean {
  if (!inWindow(window, row.time)) return false
  if (filter?.nodeId !== undefined && !nodeIdsOf(row).includes(filter.nodeId)) return false
  if (filter?.linkId !== undefined && !linkIdsOf(row).includes(filter.linkId)) return false
  return true
}

/** 稳定排序：原生按 epoch→frameId→帧内序号；CSV 按时刻→行序号（不用字符串 id 字典序）。 */
function compareRows(left: EvidenceRow, right: EvidenceRow): number {
  const leftNative = typeof left.engineEpoch === 'number', rightNative = typeof right.engineEpoch === 'number'
  if (leftNative && rightNative) {
    if (left.engineEpoch !== right.engineEpoch) return (left.engineEpoch as number) - (right.engineEpoch as number)
    const leftFrame = typeof left.frameId === 'number' ? left.frameId : left.time
    const rightFrame = typeof right.frameId === 'number' ? right.frameId : right.time
    if (leftFrame !== rightFrame) return leftFrame - rightFrame
  } else if (left.time !== right.time) return left.time - right.time
  return (left.seq ?? 0) - (right.seq ?? 0)
}

/** 过滤后按稳定排序保证分页无重漏。 */
export function filteredRows(rows: readonly EvidenceRow[], filter: LocalReportFilter | undefined, window: PhaseRange): EvidenceRow[] {
  return rows.filter(row => rowMatches(row, filter, window)).slice().sort(compareRows)
}

export interface RowsPage { rows: EvidenceRow[]; total: number; nextCursor: string | null }
export function paginateRows(rows: readonly EvidenceRow[], limit: number, identity: EvidenceCursorIdentity, cursor?: string): RowsPage {
  const offset = cursor === undefined ? 0 : decodeEvidenceCursor(cursor, identity, 'ROW')
  if (offset > rows.length) throw new Error('EVIDENCE_CURSOR_INVALID')
  const page = rows.slice(offset, offset + limit)
  const next = offset + page.length < rows.length ? encodeEvidenceCursor(identity, offset + page.length, 'ROW') : null
  return { rows: page, total: rows.length, nextCursor: next }
}

// —— 文件集来源投影 ——
export interface FileSetStateRecord { time: number; linkId: string | null; linkStatus: string; gxbDb: number | null; ber: number | null; receivedPower: number | null; sourcePlatformId?: string | null; targetPlatformId?: string | null }
export interface FileSetLossRecord { time: number; linkId: string | null; freeSpaceLossDb: number | null; seaMultipathLossDb: number | null; atmosphericLossDb: number | null; cloudRainLossDb: number | null; jammingLossDb: number | null; totalLossDb: number | null; sourcePlatformId?: string | null; targetPlatformId?: string | null }
export interface FileSetSwitchRecord { time: number; sourcePlatform: string; destPlatform: string; direction: string; oldLinkType: string; newLinkType: string; oldBer: number | null; newBer: number | null; reason: string }
export interface FileSetInput {
  quality?: QualityDataset
  state: FileSetStateRecord[]
  loss: FileSetLossRecord[]
  switch: FileSetSwitchRecord[]
  bundleSha256: string
  capabilities: EvidenceKind[]
  /** 冻结步长（CSV 秒）；缺省表示连续性不可确定，不臆造断点。 */
  expectedStepS?: number
}

/** 把文件集批次投影成稳定行与曲线定义：state/loss/switch 不补值，quality 才提供 SNR；保留已验证端点。 */
export function buildFileSetSource(input: FileSetInput): EvidenceSource {
  const rowsByKind = { quality: [] as EvidenceRow[], state: [] as EvidenceRow[], loss: [] as EvidenceRow[], switch: [] as EvidenceRow[], segments: [], switches: [], events: [] } as unknown as Record<EvidenceKind, EvidenceRow[]>
  const series: EvidenceSeriesMeta[] = []
  const timeStepS = typeof input.expectedStepS === 'number' && input.expectedStepS > 0 ? input.expectedStepS : undefined
  if (input.quality) {
    const qualityStep = input.quality.expectedStepS > 0 ? input.quality.expectedStepS : timeStepS
    input.quality.samples.forEach((sample, index) => rowsByKind.quality.push({ id: `q:${sample.linkId}:${sample.time}:${sample.frameId}:${index}`, time: sample.time, seq: index, linkId: sample.linkId, sourcePlatformId: sample.sourcePlatform, targetPlatformId: sample.destPlatform, linkStatus: sample.linkStatus, gxbDb: sample.jsrDb, snrDb: sample.snr, ber: sample.ber, receivedPower: sample.receivedPower, frameId: sample.frameId }))
    for (const linkId of [...new Set(input.quality.samples.map(sample => sample.linkId))].sort()) {
      series.push({ seriesId: `quality:${linkId}:gxb`, kind: 'quality', unit: 'dB', linkId, timeStepS: qualityStep }, { seriesId: `quality:${linkId}:snr`, kind: 'quality', unit: 'dB', linkId, timeStepS: qualityStep }, { seriesId: `quality:${linkId}:ber`, kind: 'quality', unit: 'BER', linkId, timeStepS: qualityStep })
    }
  }
  input.state.forEach((row, index) => rowsByKind.state.push({ id: `s:${row.linkId}:${row.time}:${index}`, time: row.time, seq: index, linkId: row.linkId, sourcePlatformId: row.sourcePlatformId ?? null, targetPlatformId: row.targetPlatformId ?? null, linkStatus: row.linkStatus, gxbDb: row.gxbDb, ber: row.ber, receivedPower: row.receivedPower }))
  for (const linkId of [...new Set(input.state.map(row => row.linkId).filter((id): id is string => id !== null))].sort()) series.push({ seriesId: `state:${linkId}:gxb`, kind: 'state', unit: 'dB', linkId, ...(timeStepS ? { timeStepS } : {}) }, { seriesId: `state:${linkId}:ber`, kind: 'state', unit: 'BER', linkId, ...(timeStepS ? { timeStepS } : {}) }, { seriesId: `state:${linkId}:receivedPower`, kind: 'state', unit: 'dBm', linkId, ...(timeStepS ? { timeStepS } : {}) })
  input.loss.forEach((row, index) => rowsByKind.loss.push({ ...row, id: `l:${row.linkId}:${row.time}:${index}`, seq: index }))
  input.switch.forEach((row, index) => rowsByKind.switch.push({ id: `w:${row.time}:${index}`, time: row.time, seq: index, sourcePlatformId: row.sourcePlatform, targetPlatformId: row.destPlatform, sourcePlatform: row.sourcePlatform, destPlatform: row.destPlatform, direction: row.direction, oldLinkType: row.oldLinkType, newLinkType: row.newLinkType, oldBer: row.oldBer, newBer: row.newBer, reason: row.reason }))
  const capabilities = FILE_SET_KINDS.filter(kind => input.capabilities.includes(kind))
  return { sourceSha256: input.bundleSha256, sourceKind: 'FILE_SET', capabilities, totals: Object.fromEntries(FILE_SET_KINDS.map(kind => [kind, rowsByKind[kind].length])), series, label: `文件集 ${input.bundleSha256.slice(0, 12)}…`, rowsByKind }
}

const segmentIdentity = (row: EngineFrameArchiveSummary['segmentRows'][number]): string => {
  const seg = row.segment
  const part = (value: unknown) => value === null || value === undefined ? '∅' : String(value)
  return [row.engineEpoch, part(seg.linkId), part(seg.sourceName), part(seg.sourcePort), part(seg.targetName), part(seg.targetPort), part(seg.sourcePlatformId), part(seg.targetPlatformId)].join(':')
}

/** 原生帧归档投影：段/切换/事件各自成行，保持 epoch/帧/稳定序号；snr 缺测不补；曲线携带完整身份。 */
export function buildNativeArchiveSource(archive: EngineFrameArchiveSummary): EvidenceSource {
  const rowsByKind: Record<string, EvidenceRow[]> = { quality: [], state: [], loss: [], switch: [], segments: [], switches: [], events: [] }
  const series: EvidenceSeriesMeta[] = []
  archive.segmentRows.forEach((row, index) => {
    const seg = row.segment
    rowsByKind.segments!.push({ id: `seg:${row.engineEpoch}:${row.frameId}:${index}`, time: row.simulationTime, seq: index, engineEpoch: row.engineEpoch, frameId: row.frameId,
      linkId: seg.linkId, linkIds: seg.linkIds, sourcePlatformId: seg.sourcePlatformId, targetPlatformId: seg.targetPlatformId,
      sourceName: seg.sourceName, sourcePort: seg.sourcePort, targetName: seg.targetName, targetPort: seg.targetPort,
      gxbDb: seg.quality.gxbDb, ber: seg.quality.ber, rxPowerDbm: seg.quality.rxPowerDbm, rxPowerDbw: seg.quality.rxPowerDbw, totalDb: seg.losses.totalDb })
  })
  archive.switchRows.forEach((row, index) => rowsByKind.switches!.push({ id: `sw:${row.engineEpoch}:${row.frameId}:${index}`, time: row.simulationTime, seq: index, engineEpoch: row.engineEpoch, frameId: row.frameId, linkId: row.value.reasons[0]?.linkId ?? null, linkIds: row.value.reasons.map(reason => reason.linkId).filter((id): id is string => typeof id === 'string'), sourcePlatformId: row.value.sourcePlatformId, targetPlatformId: row.value.targetPlatformId, direction: row.value.direction, pathId: row.value.pathId }))
  archive.eventRows.forEach((row, index) => rowsByKind.events!.push({ id: `ev:${row.engineEpoch}:${row.frameId}:${index}`, time: row.simulationTime, seq: index, engineEpoch: row.engineEpoch, frameId: row.frameId, type: row.value.type ?? null, sourcePlatformId: row.value.uavIds[0] ?? null, targetPlatformId: null }))
  const identities = new Map<string, EngineFrameArchiveSummary['segmentRows'][number]>()
  for (const row of archive.segmentRows) { const id = segmentIdentity(row); if (!identities.has(id)) identities.set(id, row) }
  for (const [identity, row] of [...identities].sort(([left], [right]) => left.localeCompare(right))) {
    const seg = row.segment
    const common = { linkId: seg.linkId, engineEpoch: row.engineEpoch, sourcePlatformId: seg.sourcePlatformId, targetPlatformId: seg.targetPlatformId,
      sourceName: seg.sourceName, sourcePort: seg.sourcePort, targetName: seg.targetName, targetPort: seg.targetPort, frameStep: ENGINE_FRAME_ID_STEP }
    series.push({ seriesId: `segments:${identity}:gxb`, kind: 'segments', unit: 'dB', ...common }, { seriesId: `segments:${identity}:ber`, kind: 'segments', unit: 'BER', ...common })
  }
  return { sourceSha256: archive.sourceSha256, sourceKind: 'NATIVE_ARCHIVE', capabilities: NATIVE_KINDS.filter(kind => (rowsByKind[kind]?.length ?? 0) > 0), totals: Object.fromEntries(NATIVE_KINDS.map(kind => [kind, rowsByKind[kind]!.length])), series, label: `原生帧归档 ${archive.sourceSha256.slice(0, 12)}…`, rowsByKind: rowsByKind as Record<EvidenceKind, EvidenceRow[]> }
}

export function sourceInfo(source: EvidenceSource): EvidenceSourceInfo {
  return { sourceSha256: source.sourceSha256, sourceKind: source.sourceKind, capabilities: source.capabilities, totals: source.totals, series: source.series, label: source.label }
}

// —— 曲线 ——
export interface EvidenceSeriesPoint { time: number; value: number; breakBefore?: boolean }
export interface SeriesPage { seriesId: string; rawCount: number; pointCount: number; sampling: 'FULL' | 'DOWNSAMPLED'; points: EvidenceSeriesPoint[]; nextCursor: string | null }

function seriesMetric(meta: EvidenceSeriesMeta): string { return meta.seriesId.slice(meta.seriesId.lastIndexOf(':') + 1) }
function valueFor(row: EvidenceRow, metric: string): number | null {
  const key = metric === 'gxb' ? 'gxbDb' : metric === 'snr' ? 'snrDb' : metric === 'ber' ? 'ber' : metric === 'receivedPower' ? 'receivedPower' : metric
  return num(row[key])
}
function identityMatch(meta: EvidenceSeriesMeta, row: EvidenceRow): boolean {
  if (meta.linkId !== undefined && row.linkId !== meta.linkId) return false
  if (meta.engineEpoch !== undefined && row.engineEpoch !== meta.engineEpoch) return false
  // undefined=不属于身份(通配)；null=要求实际值也缺失(null/undefined)，绝不匹配任意非空。
  const same = (expected: string | null | undefined, actual: unknown) => expected === undefined
    ? true
    : expected === null ? (actual === null || actual === undefined) : actual === expected
  return same(meta.sourcePlatformId, row.sourcePlatformId) && same(meta.targetPlatformId, row.targetPlatformId)
    && same(meta.sourceName, row.sourceName) && same(meta.sourcePort, row.sourcePort)
    && same(meta.targetName, row.targetName) && same(meta.targetPort, row.targetPort)
}
/** 同一曲线相邻记录的连续判定：原生用帧号步长，CSV 用秒步长；缺可靠步长返回 null（不确定）。 */
function continuity(meta: EvidenceSeriesMeta, previous: EvidenceRow, current: EvidenceRow): boolean | null {
  if (meta.frameStep !== undefined) {
    return typeof previous.frameId === 'number' && typeof current.frameId === 'number' && current.frameId === previous.frameId + meta.frameStep
  }
  if (meta.timeStepS !== undefined && meta.timeStepS > 0) {
    const delta = current.time - previous.time
    return delta > 0 && delta <= meta.timeStepS * (1 + 1e-9)
  }
  return null
}
export function seriesContinuityReliable(meta: EvidenceSeriesMeta): boolean {
  return meta.frameStep !== undefined || (meta.timeStepS !== undefined && meta.timeStepS > 0)
}

/** 生成某条曲线的原始点（按窗口/节点/链路筛选，并按完整身份隔离；只比较同一曲线相邻记录）。 */
export function seriesRawPoints(source: EvidenceSource, meta: EvidenceSeriesMeta, filter: LocalReportFilter | undefined, window: PhaseRange): EvidenceSeriesPoint[] {
  const metric = seriesMetric(meta)
  const rows = filteredRows(source.rowsByKind[meta.kind] ?? [], filter, window)
  const points: EvidenceSeriesPoint[] = []
  let previous: EvidenceRow | undefined
  let gap = false
  for (const row of rows) {
    if (!identityMatch(meta, row)) continue
    const value = valueFor(row, metric)
    if (value === null) { gap = true; previous = row; continue }
    const continuous = previous === undefined ? true : continuity(meta, previous, row)
    const breakBefore = gap || continuous === false
    previous = row; gap = false
    points.push({ time: row.time, value, ...(breakBefore ? { breakBefore: true } : {}) })
  }
  return points
}

/**
 * 有界采样：保首尾、极值、断点（含断点前一点）；超预算时按稳定顺序分段续取，不伪连。
 * 任何分支在携带游标时都校验（绑定 maxPoints / filter / 来源 / 位置）。
 */
export function sampleSeries(points: readonly EvidenceSeriesPoint[], maxPoints: number, identity: EvidenceCursorIdentity, cursor?: string): SeriesPage {
  const rawCount = points.length
  const sampling = (rawCount > maxPoints ? 'DOWNSAMPLED' : 'FULL') as 'FULL' | 'DOWNSAMPLED'
  const offset = cursor === undefined ? 0 : decodeEvidenceCursor(cursor, identity, 'SERIES')
  if (offset > rawCount) throw new Error('EVIDENCE_CURSOR_INVALID')
  if (rawCount === 0) {
    if (offset !== 0) throw new Error('EVIDENCE_CURSOR_INVALID')
    return { seriesId: identity.seriesId!, rawCount, sampling, pointCount: 0, points: [], nextCursor: null }
  }
  if (rawCount <= maxPoints) {
    if (offset !== 0) throw new Error('EVIDENCE_CURSOR_INVALID')
    return { seriesId: identity.seriesId!, rawCount, sampling, pointCount: rawCount, points: [...points], nextCursor: null }
  }
  const forced = new Set<number>([0, rawCount - 1])
  let min = 0, max = 0
  points.forEach((point, index) => {
    if (point.value < points[min]!.value) min = index
    if (point.value > points[max]!.value) max = index
    if (point.breakBefore) { forced.add(index); if (index > 0) forced.add(index - 1) }
  })
  forced.add(min); forced.add(max)
  const forcedOrdered = [...forced].filter(index => index >= 0 && index < rawCount).sort((left, right) => left - right)
  if (forcedOrdered.length > maxPoints) {
    // 位置必须落在实际续页序列：为 maxPoints 的倍数且小于必要点总数；越界不得返回伪成功空页。
    if (offset !== 0 && (offset % maxPoints !== 0 || offset >= forcedOrdered.length)) throw new Error('EVIDENCE_CURSOR_INVALID')
    const slice = forcedOrdered.slice(offset, offset + maxPoints)
    if (slice.length === 0) throw new Error('EVIDENCE_CURSOR_INVALID')
    const next = offset + slice.length < forcedOrdered.length ? encodeEvidenceCursor(identity, offset + slice.length, 'SERIES') : null
    return { seriesId: identity.seriesId!, rawCount, sampling, pointCount: slice.length, points: slice.map(index => points[index]!), nextCursor: next }
  }
  if (offset !== 0) throw new Error('EVIDENCE_CURSOR_INVALID')
  const chosen = new Set(forcedOrdered)
  const remaining = maxPoints - chosen.size
  if (remaining > 0) {
    const step = rawCount / (remaining + 1)
    for (let n = 1; n <= remaining; n += 1) chosen.add(Math.min(rawCount - 1, Math.round(step * n)))
  }
  const ordered = [...chosen].sort((left, right) => left - right)
  return { seriesId: identity.seriesId!, rawCount, sampling, pointCount: ordered.length, points: ordered.map(index => points[index]!), nextCursor: null }
}

/** 导出用：循环游标消费全部必要续页，得到完整有界投影点（不丢弃 necesary 断点）。 */
export function collectSeriesPages(points: readonly EvidenceSeriesPoint[], maxPoints: number, identity: EvidenceCursorIdentity): EvidenceSeriesPoint[] {
  const collected: EvidenceSeriesPoint[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < 10_000; guard += 1) {
    const page = sampleSeries(points, maxPoints, identity, cursor)
    collected.push(...page.points)
    if (page.nextCursor === null) return collected
    cursor = page.nextCursor
  }
  throw new Error('EVIDENCE_SERIES_PAGE_LIMIT')
}

export interface EvidenceOverviewSource extends EvidenceSourceInfo {}

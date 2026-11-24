import { MAX_LOCAL_REPORT_TREND_POINTS, type LocalQualityKpis, type LocalReportEvidence, type LocalReportFilter, type LocalReportTrendPoint, type QualityDataset, type QualitySample, type Report, type TaskPhase } from '../../contracts/domain-models'
import { consecutiveQualitySamples, isQualityDataset, isQualityDatasetProjection } from '../data-exchange/quality-records'
import { isLocalReport, resolvePhaseRange, withinPhaseRange, type PhaseRange } from './local-report'

export interface QualityCurvePoint { time: number; value: number; breakBefore?: boolean }
export interface QualityLinkCurves { linkId: string; gxbCurve: QualityCurvePoint[]; berCurve: QualityCurvePoint[]; snrCurve: QualityCurvePoint[] }
export interface QualityReportView {
  dataset: QualityDataset
  samples: QualitySample[]
  kpis: LocalQualityKpis
  jammingDurationTrend?: LocalReportTrendPoint[]
  gxbCurve: QualityCurvePoint[]
  berCurve: QualityCurvePoint[]
  series: QualityLinkCurves[]
  connectivityRates: Array<{ linkId: string; value: number }>
  range: { start: number; end: number }
}

const QUALITY_REPORT_SUFFIX = /-Q-([a-f0-9]{64})$/
export const baseQualityReportId = (reportId: string): string => reportId.replace(QUALITY_REPORT_SUFFIX, '')
export const qualityReportSha256 = (reportId: string): string | undefined => reportId.match(QUALITY_REPORT_SUFFIX)?.[1]
export const qualityReportId = (reportId: string, sha256: string): Report['reportId'] => `${baseQualityReportId(reportId)}-Q-${sha256}` as Report['reportId']

type Range = { start: number; end: number }

const finite = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value)

const endpointsKnown = (sample: QualitySample, knownNodes: ReadonlySet<string>): boolean =>
  knownNodes.has(sample.sourcePlatform) && knownNodes.has(sample.destPlatform)

function samplesFor(dataset: QualityDataset, knownNodes: ReadonlySet<string>, filter: LocalReportFilter | undefined, selection: PhaseRange): QualitySample[] {
  if (filter?.nodeId && !knownNodes.has(filter.nodeId)) throw new Error('报告质量数据的节点筛选无效。')
  // 链路由运行索引校验，质量文件可以只覆盖部分链路。
  const selected = dataset.samples.filter(item => withinPhaseRange(selection, item.time)
    && (filter?.linkId === undefined || item.linkId === filter.linkId)
    && (filter?.nodeId === undefined || item.sourcePlatform === filter.nodeId || item.destPlatform === filter.nodeId))
  if (selected.some(item => !endpointsKnown(item, knownNodes))) throw new Error('质量数据引用了当前报告范围外的节点。')
  // 筛选会移除某些帧的首个链路样本，使剩余样本的首现帧序不再递增；此处按全局帧序（时间、帧号）稳定排序，
  // 只重排筛选结果的引用顺序，不改数值、来源摘要、帧身份，也不修改传入的 dataset。每条曲线仍按链路独立分组排序。
  return selected.sort((left, right) => left.time - right.time || left.frameId - right.frameId)
}

interface ObservedInterval { start: number; end: number; left: QualitySample }

/**
 * A source sample is a discrete frame state. Its state applies from that frame
 * until the next contiguous sample for the same link; it never extends past a
 * final frame or across a frame/time gap.
 */
function observedIntervals(dataset: QualityDataset, knownNodes: ReadonlySet<string>, filter: LocalReportFilter | undefined, range: Range): Map<string, ObservedInterval[]> {
  const eligible = dataset.samples.filter(item => (filter?.linkId === undefined || item.linkId === filter.linkId)
    && (filter?.nodeId === undefined || item.sourcePlatform === filter.nodeId || item.destPlatform === filter.nodeId))
  const byLink = new Map<string, QualitySample[]>()
  for (const sample of eligible) byLink.set(sample.linkId, [...(byLink.get(sample.linkId) ?? []), sample])
  const result = new Map<string, ObservedInterval[]>()
  for (const [linkId, samples] of byLink) {
    const ordered = samples.slice().sort((left, right) => left.time - right.time || left.frameId - right.frameId)
    const intervals: ObservedInterval[] = []
    for (let index = 1; index < ordered.length; index += 1) {
      const left = ordered[index - 1]!, right = ordered[index]!
      const continuous = consecutiveQualitySamples(left, right, dataset.expectedStepS)
      if (!continuous || !endpointsKnown(left, knownNodes) || !endpointsKnown(right, knownNodes)) continue
      const start = Math.max(left.time, range.start), end = Math.min(right.time, range.end)
      if (end > start) intervals.push({ start, end, left })
    }
    if (intervals.length) result.set(linkId, intervals)
  }
  return result
}

function connectedDurations(intervalsByLink: ReadonlyMap<string, readonly ObservedInterval[]>): { observed: boolean; durations: number[] } {
  const durations: number[] = []
  for (const intervals of intervalsByLink.values()) {
    let start: number | undefined
    let end: number | undefined
    const finish = () => {
      if (start !== undefined && end !== undefined) durations.push(end - start)
      start = undefined; end = undefined
    }
    for (const interval of intervals) {
      if (interval.left.linkStatus !== 'UP') { finish(); continue }
      if (end !== undefined && interval.start !== end) finish()
      if (start === undefined) start = interval.start
      end = interval.end
    }
    finish()
  }
  return { observed: intervalsByLink.size > 0, durations }
}

function includeRange(ranges: Range[], { start, end }: Range): void {
  const last = ranges.at(-1)
  if (last && start <= last.end) last.end = Math.max(last.end, end)
  else ranges.push({ start, end })
}

function measuredInterference(intervalsByLink: ReadonlyMap<string, readonly ObservedInterval[]>): { duration: number; trend: LocalReportTrendPoint[] } | undefined {
  const intervals: ObservedInterval[] = []
  for (const rows of intervalsByLink.values()) for (const interval of rows) {
    // 每个有效区间都要有显式状态，避免把未知当作未干扰。
    if (typeof interval.left.interferenceActive !== 'boolean') return undefined
    intervals.push(interval)
  }
  if (!intervals.length) return undefined
  intervals.sort((left, right) => left.start - right.start || left.end - right.end)
  const observed: Range[] = [], active: Range[] = []
  for (const interval of intervals) {
    includeRange(observed, interval)
    if (interval.left.interferenceActive) includeRange(active, interval)
  }

  const trend: LocalReportTrendPoint[] = []
  let duration = 0, activeIndex = 0
  const addPoint = (time: number, breakBefore = false) => {
    if (trend.at(-1)?.time === time) return
    const point = { time, value: duration, ...(breakBefore ? { breakBefore: true } : {}) }
    if (trend.length < MAX_LOCAL_REPORT_TREND_POINTS) trend.push(point)
    else trend[MAX_LOCAL_REPORT_TREND_POINTS - 1] = { ...point, breakBefore: true }
  }
  for (const coverage of observed) {
    addPoint(coverage.start, trend.length > 0)
    while (active[activeIndex] && active[activeIndex]!.start < coverage.end) {
      const interval = active[activeIndex++]!
      addPoint(interval.start)
      duration += interval.end - interval.start
      addPoint(interval.end)
    }
    addPoint(coverage.end)
  }
  return { duration, trend }
}

/** Pure projection of imported measurements. No scene defaults, dBm inference, or gap extrapolation is used. */
export function qualityReportView(dataset: QualityDataset, evidence: LocalReportEvidence, filter?: LocalReportFilter, phases?: TaskPhase[], reportEndTimeS?: number, sourceEvidence = evidence): QualityReportView {
  if (!isQualityDatasetProjection(dataset)) throw new Error('质量数据格式无效。')
  const selection = resolvePhaseRange(evidence, filter, phases, reportEndTimeS ?? evidence.endTimeS)
  const range: Range = { start: selection.start, end: selection.end }
  // 运行日志筛选后的节点列表可能缺少仍有质量测量的历史对端。
  const knownNodes = new Set([...sourceEvidence.nodes.map(node => node.platformId), ...(sourceEvidence.relatedNodeIds ?? [])])
  const samples = samplesFor(dataset, knownNodes, filter, selection)
  const intervals = observedIntervals(dataset, knownNodes, filter, range)
  const connected = connectedDurations(intervals)
  const gxb = samples.map(item => item.jsrDb).filter(finite)
  const ber = samples.map(item => item.ber).filter(finite)
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined
  const interference = measuredInterference(intervals)
  const connectivityRates = [...intervals].map(([linkId, rows]) => {
    const duration = rows.reduce((sum, interval) => sum + interval.end - interval.start, 0)
    const connectedDuration = rows.filter(interval => interval.left.linkStatus === 'UP').reduce((sum, interval) => sum + interval.end - interval.start, 0)
    return { linkId, value: connectedDuration / duration * 100 }
  })
  return {
    dataset, samples,
    kpis: {
      ...(connected.durations.length ? { averageConnectedDurationS: average(connected.durations) } : connected.observed ? { averageConnectedDurationS: 0 } : {}),
      ...(average(gxb) === undefined ? {} : { averageJsrDb: average(gxb) }),
      ...(average(ber) === undefined ? {} : { averageBer: average(ber) }),
      ...(interference === undefined ? {} : { jammingDurationS: interference.duration }),
    },
    ...(interference === undefined ? {} : { jammingDurationTrend: interference.trend }),
    gxbCurve: samples.map(item => ({ time: item.time, value: item.jsrDb })),
    berCurve: samples.map(item => ({ time: item.time, value: item.ber })),
    series: [...new Set(samples.map(item => item.linkId))].map(linkId => {
      const rows = samples.filter(item => item.linkId === linkId).sort((left, right) => left.time - right.time || left.frameId - right.frameId)
      const curve = (value: (sample: QualitySample) => number) => rows.map((item, index) => {
        const previous = rows[index - 1]
        const breakBefore = previous !== undefined && !consecutiveQualitySamples(previous, item, dataset.expectedStepS)
        return { time: item.time, value: value(item), ...(breakBefore ? { breakBefore: true } : {}) }
      })
      return { linkId, gxbCurve: curve(item => item.jsrDb), berCurve: curve(item => item.ber), snrCurve: curve(item => item.snr) }
    }),
    connectivityRates,
    range,
  }
}

/** Attach a filtered, source-preserving quality projection to a report returned by the local result pipeline. */
export function attachQualityReport(report: Report, dataset: QualityDataset, filter?: LocalReportFilter, phases?: TaskPhase[], reportEndTimeS?: number, sourceEvidence?: LocalReportEvidence, includeMetricTrends = false): Report {
  if (!isLocalReport(report)) throw new Error('只有本地真实报告可附加质量测量。')
  if (!isQualityDataset(dataset)) throw new Error('原始质量数据格式无效。')
  const view = qualityReportView(dataset, report.localEvidence, filter, phases, reportEndTimeS, sourceEvidence)
  const selection = resolvePhaseRange(report.localEvidence, filter, phases, reportEndTimeS ?? report.localEvidence.endTimeS)
  const selectedLinks = new Set(view.samples.map(item => item.linkId))
  const quality: QualityDataset = { ...dataset, samples: view.samples, switchEvents: dataset.switchEvents.filter(item => withinPhaseRange(selection, item.time)
    && (filter?.linkId === undefined || item.oldLinkId === filter.linkId || item.newLinkId === filter.linkId)
    && (filter?.nodeId === undefined || selectedLinks.has(item.oldLinkId) || selectedLinks.has(item.newLinkId))) }
  const retainedNodes = new Set(report.localEvidence.nodes.map(node => node.platformId))
  const relatedNodeIds = new Set(report.localEvidence.relatedNodeIds)
  const originalRelatedCount = relatedNodeIds.size
  for (const sample of view.samples) {
    if (!retainedNodes.has(sample.sourcePlatform)) relatedNodeIds.add(sample.sourcePlatform)
    if (!retainedNodes.has(sample.destPlatform)) relatedNodeIds.add(sample.destPlatform)
  }
  const { qualityJammingDurationTrend: _previousTrend, ...baseEvidence } = report.localEvidence
  const localEvidence: LocalReportEvidence = { ...baseEvidence, quality, qualityKpis: view.kpis, qualityConnectivityRates: view.connectivityRates,
    ...(includeMetricTrends && view.jammingDurationTrend ? { qualityJammingDurationTrend: view.jammingDurationTrend } : {}),
    ...(relatedNodeIds.size > originalRelatedCount ? { relatedNodeIds: [...relatedNodeIds].sort() } : {}) }
  const attached: Report = { ...report, reportId: qualityReportId(report.reportId, dataset.source.sha256), localEvidence }
  if (!isLocalReport(attached)) throw new Error('附加后的质量报告未通过边界校验。')
  return attached
}

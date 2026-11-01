import type { LocalQualityKpis, LocalReportEvidence, LocalReportFilter, QualityDataset, QualitySample, Report, TaskPhase } from '../../contracts/domain-models'
import { consecutiveQualitySamples, isQualityDataset, isQualityDatasetProjection } from '../data-exchange/quality-records'
import { isLocalReport } from './local-report'

export interface QualityCurvePoint { time: number; value: number; breakBefore?: boolean }
export interface QualityLinkCurves { linkId: string; gxbCurve: QualityCurvePoint[]; berCurve: QualityCurvePoint[] }
export interface QualityReportView {
  dataset: QualityDataset
  samples: QualitySample[]
  kpis: LocalQualityKpis
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

function selectedRange(evidence: LocalReportEvidence, filter: LocalReportFilter | undefined, phases: TaskPhase[] | undefined): Range {
  const phase = filter?.stage === undefined ? undefined : phases?.find(item => item.id === filter.stage)
  if (filter?.stage !== undefined && !phase) throw new Error('报告质量数据的任务阶段无效。')
  const start = Math.max(evidence.startTimeS, filter?.from ?? evidence.startTimeS, phase?.startTimeS ?? evidence.startTimeS)
  const end = Math.min(evidence.endTimeS, filter?.to ?? evidence.endTimeS, phase?.endTimeS ?? evidence.endTimeS)
  if (start > end) throw new Error('报告质量数据的筛选时间范围无效。')
  return { start, end }
}

function samplesFor(dataset: QualityDataset, evidence: LocalReportEvidence, filter: LocalReportFilter | undefined, range: Range): QualitySample[] {
  const knownNodes = new Set([...evidence.nodes.map(item => item.platformId), ...(evidence.relatedNodeIds ?? [])])
  if (filter?.nodeId && !knownNodes.has(filter.nodeId)) throw new Error('报告质量数据的节点筛选无效。')
  const links = new Set(dataset.samples.map(item => item.linkId))
  if (filter?.linkId && !links.has(filter.linkId)) throw new Error('报告质量数据的链路筛选无效。')
  const selected = dataset.samples.filter(item => item.time >= range.start && item.time <= range.end
    && (filter?.linkId === undefined || item.linkId === filter.linkId)
    && (filter?.nodeId === undefined || item.sourcePlatform === filter.nodeId || item.destPlatform === filter.nodeId))
    .slice().sort((left, right) => left.linkId.localeCompare(right.linkId) || left.time - right.time || left.frameId - right.frameId)
  if (selected.some(item => !knownNodes.has(item.sourcePlatform) || !knownNodes.has(item.destPlatform))) throw new Error('质量数据引用了当前报告范围外的节点。')
  return selected
}

interface ObservedInterval { start: number; end: number; left: QualitySample }

/**
 * A source sample is a discrete frame state. Its state applies from that frame
 * until the next contiguous sample for the same link; it never extends past a
 * final frame or across a frame/time gap.
 */
function observedIntervals(dataset: QualityDataset, filter: LocalReportFilter | undefined, range: Range): Map<string, ObservedInterval[]> {
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
      if (!continuous) continue
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

function mergedDuration(intervalsByLink: ReadonlyMap<string, readonly ObservedInterval[]>): number | undefined {
  const intervals: Array<{ start: number; end: number }> = []
  let covered = false
  for (const rows of intervalsByLink.values()) for (const interval of rows) {
    // `false` is an explicit measured inactive state; absent is unknown, not zero.
    if (typeof interval.left.interferenceActive !== 'boolean') return undefined
    covered = true
    if (interval.left.interferenceActive) intervals.push(interval)
  }
  if (!covered) return undefined
  intervals.sort((left, right) => left.start - right.start || left.end - right.end)
  let total = 0, end = -Infinity
  for (const interval of intervals) {
    if (interval.end <= end) continue
    total += interval.end - Math.max(interval.start, end)
    end = interval.end
  }
  return total
}

/** Pure projection of imported measurements. No scene defaults, dBm inference, or gap extrapolation is used. */
export function qualityReportView(dataset: QualityDataset, evidence: LocalReportEvidence, filter?: LocalReportFilter, phases?: TaskPhase[]): QualityReportView {
  if (!isQualityDatasetProjection(dataset)) throw new Error('质量数据格式无效。')
  const range = selectedRange(evidence, filter, phases)
  const samples = samplesFor(dataset, evidence, filter, range)
  const intervals = observedIntervals(dataset, filter, range)
  const connected = connectedDurations(intervals)
  const gxb = samples.map(item => item.jsrDb).filter(finite)
  const ber = samples.map(item => item.ber).filter(finite)
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined
  const interference = mergedDuration(intervals)
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
      ...(interference === undefined ? {} : { jammingDurationS: interference }),
    },
    gxbCurve: samples.map(item => ({ time: item.time, value: item.jsrDb })),
    berCurve: samples.map(item => ({ time: item.time, value: item.ber })),
    series: [...new Set(samples.map(item => item.linkId))].map(linkId => {
      const rows = samples.filter(item => item.linkId === linkId).sort((left, right) => left.time - right.time || left.frameId - right.frameId)
      const curve = (value: (sample: QualitySample) => number) => rows.map((item, index) => {
        const previous = rows[index - 1]
        const breakBefore = previous !== undefined && !consecutiveQualitySamples(previous, item, dataset.expectedStepS)
        return { time: item.time, value: value(item), ...(breakBefore ? { breakBefore: true } : {}) }
      })
      return { linkId, gxbCurve: curve(item => item.jsrDb), berCurve: curve(item => item.ber) }
    }),
    connectivityRates,
    range,
  }
}

/** Attach a filtered, source-preserving quality projection to a report returned by the local result pipeline. */
export function attachQualityReport(report: Report, dataset: QualityDataset, filter?: LocalReportFilter, phases?: TaskPhase[]): Report {
  if (!isLocalReport(report)) throw new Error('只有本地真实报告可附加质量测量。')
  if (!isQualityDataset(dataset)) throw new Error('原始质量数据格式无效。')
  const view = qualityReportView(dataset, report.localEvidence, filter, phases)
  const selectedLinks = new Set(view.samples.map(item => item.linkId))
  const quality: QualityDataset = { ...dataset, samples: view.samples, switchEvents: dataset.switchEvents.filter(item => item.time >= view.range.start && item.time <= view.range.end
    && (filter?.linkId === undefined || item.oldLinkId === filter.linkId || item.newLinkId === filter.linkId)
    && (filter?.nodeId === undefined || selectedLinks.has(item.oldLinkId) || selectedLinks.has(item.newLinkId))) }
  const localEvidence: LocalReportEvidence = { ...report.localEvidence, quality, qualityKpis: view.kpis, qualityConnectivityRates: view.connectivityRates }
  const attached: Report = { ...report, reportId: qualityReportId(report.reportId, dataset.source.sha256), localEvidence }
  if (!isLocalReport(attached)) throw new Error('附加后的质量报告未通过边界校验。')
  return attached
}

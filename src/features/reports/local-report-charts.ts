import type { LocalReportEvidence, LocalReportTrendPoint } from '../../contracts/domain-models'
import { ENGINE_FRAME_ID_STEP } from '../data-exchange/engine-frame-snapshot'
import { consecutiveQualitySamples } from '../data-exchange/quality-records'
import { localReportMetrics, reportTime } from './local-report'
import { qualityReportView } from './quality-report'

type ReportMetrics = ReturnType<typeof localReportMetrics>
type QualityView = ReturnType<typeof qualityReportView>
type TrendFrame<T> = { time: number; rows: T[] }

/** 雷达图五项指标的统一 0–100 归一化口径。 */
const RADAR_KPI = {
  maxAcceptableSwitches: 20,
  minGxbDb: 6,
  maxGxbDb: 40,
  maxBer: 1e-5,
  minBer: 1e-9,
} as const

export function localReportRadarRows(evidence: LocalReportEvidence, metrics = localReportMetrics(evidence)) {
  const durationS = evidence.endTimeS - evidence.startTimeS || 1
  const score = {
    connected: (value: number) => value / durationS * 100,
    switches: (value: number) => 100 - value / RADAR_KPI.maxAcceptableSwitches * 100,
    jsr: (value: number) => (value - RADAR_KPI.minGxbDb) / (RADAR_KPI.maxGxbDb - RADAR_KPI.minGxbDb) * 100,
    ber: (value: number) => (Math.log10(RADAR_KPI.maxBer) - Math.log10(Math.max(value, RADAR_KPI.minBer)))
      / (Math.log10(RADAR_KPI.maxBer) - Math.log10(RADAR_KPI.minBer)) * 100,
    jamming: (value: number) => 100 - value / durationS * 100,
  }
  return metrics.flatMap(({ key, label, value }) => value === undefined ? [] : [{ label, value: Math.max(0, Math.min(100, score[key](value))) }])
}

export function localReportMetricBars(metrics: ReportMetrics) {
  return metrics.map(metric => ({
    ...metric,
    rows: metric.value === undefined ? [] : [{ label: metric.label, value: metric.value, displayValue: metric.display }],
  }))
}

function trendFrames<T>(evidence: LocalReportEvidence, rows: readonly T[], timeOf: (row: T) => number): TrendFrame<T>[] {
  const frames = new Map<number, T[]>()
  for (const row of rows) {
    const time = timeOf(row)
    if (!Number.isFinite(time) || time < evidence.startTimeS || time > evidence.endTimeS) continue
    const atTime = frames.get(time)
    if (atTime) atTime.push(row)
    else frames.set(time, [row])
  }
  return [...frames].sort(([left], [right]) => left - right).map(([time, rows]) => ({ time, rows }))
}

function trendPoints<T>(frames: readonly TrendFrame<T>[],
  valueAt: (frame: TrendFrame<T>, next?: TrendFrame<T>) => number | undefined,
  continuous: (left: TrendFrame<T>, right: TrendFrame<T>) => boolean) {
  let previousIndex: number | undefined
  return frames.flatMap((frame, index) => {
    const next = frames[index + 1]
    const value = valueAt(frame, next && continuous(frame, next) ? next : undefined)
    if (value === undefined || !Number.isFinite(value)) return []
    const breakBefore = previousIndex !== undefined && (previousIndex + 1 !== index || !continuous(frames[previousIndex]!, frame))
    previousIndex = index
    return [{ label: reportTime(frame.time), time: frame.time, value, ...(breakBefore ? { breakBefore: true } : {}) }]
  })
}

const mean = (values: readonly number[]): number | undefined =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined
const chartTrendRows = (points: readonly LocalReportTrendPoint[]) =>
  points.map(point => ({ ...point, label: reportTime(point.time) }))
type TrendRows = ReturnType<typeof chartTrendRows>

function switchTrend(evidence: LocalReportEvidence, total: number | undefined): TrendRows {
  const archive = evidence.engineFrameArchive
  if (archive?.aggregate?.switchCountTrend?.length) return chartTrendRows(archive.aggregate.switchCountTrend)
  const quality = evidence.quality
  const times = archive && (archive.aggregate || archive.switchRows.length)
    ? archive.switchRows.map(row => row.simulationTime)
    : quality && (quality.source.switchEventsProvided === true || quality.switchEvents.length)
      ? quality.switchEvents.filter(row => row.decision === 'ACCEPTED').map(row => row.time)
      : (evidence.switchEvents ?? []).map(row => row.time)
  const frames = trendFrames(evidence, times, time => time)
  const observed = frames.reduce((count, frame) => count + frame.rows.length, 0)
  // 旧摘要如果截断了事件，仍显示卡片的完整计数，不能用残缺明细补出累计曲线。
  if (total === undefined ? observed === 0 : observed !== total) return []
  let count = 0
  const points: LocalReportTrendPoint[] = [{ time: evidence.startTimeS, value: 0 }]
  for (const frame of frames) {
    count += frame.rows.length
    if (points.at(-1)?.time === frame.time) points[points.length - 1] = { time: frame.time, value: count }
    else points.push({ time: frame.time, value: count })
  }
  if (points.at(-1)!.time !== evidence.endTimeS) points.push({ time: evidence.endTimeS, value: count })
  return chartTrendRows(points)
}

function jammingTrend(evidence: LocalReportEvidence, view: QualityView | null): TrendRows {
  const duration = evidence.qualityKpis?.jammingDurationS
  if (duration === undefined) return chartTrendRows(evidence.engineFrameArchive?.aggregate?.jammingDurationTrend ?? [])
  if (evidence.qualityJammingDurationTrend) return chartTrendRows(evidence.qualityJammingDurationTrend)
  const points = view?.jammingDurationTrend
  const last = points?.at(-1)
  // 旧版本投影的样本可能不包含被边界裁剪区间的证据。
  return points && last && Math.abs(last.value - duration) <= 1e-9 ? chartTrendRows(points) : []
}

function qualityTrends(evidence: LocalReportEvidence, view: QualityView) {
  const frames = trendFrames(evidence, view.samples, sample => sample.time)
  const step = view.dataset.expectedStepS
  const continuous = (left: { time: number }, right: { time: number }) => right.time - left.time <= step * 1.5
  const intervals = frames.flatMap((frame, index) => {
    const next = frames[index + 1]
    if (!next || !continuous(frame, next)) return []
    const nextByLink = new Map(next.rows.map(row => [row.linkId, row]))
    const observed = frame.rows.filter(row => {
      const later = nextByLink.get(row.linkId)
      return later !== undefined && consecutiveQualitySamples(row, later, step)
    })
    if (!observed.length) return []
    const duration = next.time - frame.time
    const connected = duration * observed.filter(row => row.linkStatus === 'UP').length / observed.length
    return [{ time: frame.time, rows: [{ connected }] }]
  })
  return {
    connected: trendPoints(intervals, frame => frame.rows[0]!.connected, continuous),
    jsr: trendPoints(frames, frame => mean(frame.rows.map(row => row.jsrDb).filter(value => Number.isFinite(value) && value !== -999)), continuous),
    ber: trendPoints(frames, frame => mean(frame.rows.map(row => row.ber).filter(Number.isFinite)), continuous),
  }
}

function engineTrends(evidence: LocalReportEvidence) {
  const frames = trendFrames(evidence, evidence.engineFrameArchive?.segmentRows ?? [], row => row.simulationTime)
  const continuous = (left: typeof frames[number], right: typeof frames[number]) => {
    const previous = left.rows[0]!, current = right.rows[0]!
    const frameDelta = current.frameId - previous.frameId
    return previous.engineEpoch === current.engineEpoch && frameDelta > 0 && frameDelta <= ENGINE_FRAME_ID_STEP
  }
  return {
    connected: trendPoints(frames, (frame, next) => {
      if (!next) return undefined
      const continuing = new Set(next.rows.flatMap(row => row.segment.linkIds))
      const states = new Map<string, boolean | null>()
      for (const { segment } of frame.rows) {
        const up = segment.status === 'UNKNOWN' ? null : segment.status === 'UP'
        for (const id of segment.linkIds) if (continuing.has(id)) {
          const previous = states.get(id)
          states.set(id, previous === false || up === false ? false : previous === null || up === null ? null : true)
        }
      }
      const observed = [...states.values()].filter(state => state !== null)
      return observed.length ? (next.time - frame.time) * observed.filter(Boolean).length / observed.length : undefined
    }, continuous),
    jsr: trendPoints(frames, frame => mean(frame.rows.map(row => row.segment.quality.gxbDb)
      .filter((value): value is number => value !== null && Number.isFinite(value) && value !== -999)), continuous),
    ber: trendPoints(frames, frame => mean(frame.rows.map(row => row.segment.quality.ber)
      .filter((value): value is number => value !== null && Number.isFinite(value))), continuous),
  }
}

const TREND_TITLES = {
  connected: '连通时长随时间变化',
  switches: '切换次数随时间变化',
  jsr: '干信比随时间变化',
  ber: '误码率随时间变化',
  jamming: '干扰持续时长随时间变化',
} as const

export function localReportMetricCharts(
  evidence: LocalReportEvidence,
  view = evidence.quality === undefined ? null : qualityReportView(evidence.quality, evidence),
  metrics = localReportMetrics(evidence),
) {
  const switches = switchTrend(evidence, metrics.find(metric => metric.key === 'switches')?.value)
  const jamming = jammingTrend(evidence, view)
  if (!view?.samples.length && !evidence.engineFrameArchive?.segmentRows.length && !switches.length && !jamming.length) return []
  const trends = view?.samples.length ? qualityTrends(evidence, view) : engineTrends(evidence)
  const rows = { ...trends, switches, jamming }
  return metrics.map(({ key, unit, display }) => ({ key, title: TREND_TITLES[key], unit, rows: rows[key], scopeSummary: display }))
}

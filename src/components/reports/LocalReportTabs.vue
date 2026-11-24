<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { LocalReportEvidence, LocalReportFilter, LocalReportTrendPoint } from '../../contracts/domain-models'
import type { MissionResultParameterComparison } from '../../features/results/mission-result'
import { EVENT_LABELS, localReportTables, localReportChartRange, localReportMetrics, reportTime } from '../../features/reports/local-report'
import { qualityReportView } from '../../features/reports/quality-report'
import { compareRunParameters, type RunParameterComparisonRow } from '../../features/reports/run-parameter-diff'
import { ENGINE_FRAME_ID_STEP } from '../../features/data-exchange/engine-frame-snapshot'
import { consecutiveQualitySamples } from '../../features/data-exchange/quality-records'
import { formatDateTime } from '../../features/shared/date-time'
import { reportLinkLabel } from '../../features/reports/report-link-label'
import ReportChart from './ReportChart.vue'

const props = withDefaults(defineProps<{ evidence: LocalReportEvidence; generatedTime?: string; filter?: LocalReportFilter; comparison?: MissionResultParameterComparison[]; currentResultId?: string; comparisonLoading?: boolean; filterPending?: boolean; preciseFilter?: boolean; timeline?: Array<{ id: string; time: number; type: string; subject: string; target?: string }>; timelineTotal?: number; hasQualityEvidence?: boolean }>(), { comparison: () => [], comparisonLoading: false, preciseFilter: false, timeline: () => [], timelineTotal: 0, hasQualityEvidence: false })
const emit = defineEmits<{ (event: 'load-comparisons'): void; (event: 'load-quality-evidence'): void; (event: 'load-engine-segments'): void }>()
const tables = computed(() => localReportTables(props.evidence))
const qualityView = computed(() => props.evidence.quality === undefined ? null : qualityReportView(props.evidence.quality, props.evidence))
const engineArchive = computed(() => props.evidence.engineFrameArchive)
/** 评估指标卡片严格按 V1.2 测试大纲 GNZB-04 表 18：五项，不含实现额外指标。 */
const metricRows = computed(() => localReportMetrics(props.evidence))
const metricByKey = computed(() => new Map(metricRows.value.map(metric => [metric.key, metric])))
const summaryTable = computed(() => ({ ...tables.value[0]!, rows: tables.value[0]!.rows.filter(row => ['统计范围', '结束事件', '登记节点', '事件记录', '消息发送记录', '消息接收记录', '通信设备关闭记录', '干扰请求发起记录'].includes(row[0]!)) }))
function matchesSelectedConnection(sourcePlatformId: string | null, targetPlatformId: string | null): boolean {
  if (!connectionId.value) return true
  return !!connection.value && sourcePlatformId === connection.value.sourcePlatformId && targetPlatformId === connection.value.targetPlatformId
}
const engineSwitches = computed(() => (engineArchive.value?.switchRows ?? []).filter(row => {
  if (!inRange(row.simulationTime)) return false
  const nodes = [...row.value.oldNodes, ...row.value.nodes]
  if (nodeId.value && row.value.sourcePlatformId !== nodeId.value && row.value.targetPlatformId !== nodeId.value
    && !nodes.some(node => node.platformId === nodeId.value)) return false
  return matchesSelectedConnection(row.value.sourcePlatformId, row.value.targetPlatformId)
}))
const engineEvents = computed(() => (engineArchive.value?.eventRows ?? []).filter(row => inRange(row.simulationTime)
  && (!nodeId.value || row.value.uavIds.includes(nodeId.value) || row.value.jammerIds.includes(nodeId.value))
  // 引擎事件没有通信关联端点时，不把它猜成所选关联。
  && !connectionId.value))
const engineSegments = computed(() => (engineArchive.value?.segmentRows ?? []).filter(row => inRange(row.simulationTime)
  && (!nodeId.value || row.segment.sourcePlatformId === nodeId.value || row.segment.targetPlatformId === nodeId.value)
  && matchesSelectedConnection(row.segment.sourcePlatformId, row.segment.targetPlatformId)))
const enginePath = (nodes: { platformId: string | null; inPort: string | null; outPort: string | null }[]) => nodes.length
  ? nodes.map(node => `${nodeName(node.platformId ?? '未提供')}（入:${node.inPort ?? '未提供'}；出:${node.outPort ?? '未提供'}）`).join(' → ') : '暂无数据'
/** 雷达图五项指标的统一 0–100 归一化口径。 */
const RADAR_KPI = {
  maxAcceptableSwitches: 20,
  minGxbDb: 6,
  maxGxbDb: 40,
  maxBer: 1e-5,
  minBer: 1e-9,
} as const
const clampScore = (value: number): number => Math.max(0, Math.min(100, value))
const radarMetricRows = computed(() => {
  const durationS = props.evidence.endTimeS - props.evidence.startTimeS || 1
  const score = {
    connected: (value: number) => value / durationS * 100,
    switches: (value: number) => 100 - value / RADAR_KPI.maxAcceptableSwitches * 100,
    jsr: (value: number) => (value - RADAR_KPI.minGxbDb) / (RADAR_KPI.maxGxbDb - RADAR_KPI.minGxbDb) * 100,
    ber: (value: number) => (Math.log10(RADAR_KPI.maxBer) - Math.log10(Math.max(value, RADAR_KPI.minBer)))
      / (Math.log10(RADAR_KPI.maxBer) - Math.log10(RADAR_KPI.minBer)) * 100,
    jamming: (value: number) => 100 - value / durationS * 100,
  }
  return metricRows.value.flatMap(({ key, label, value }) => value === undefined ? [] : [{ label, value: clampScore(score[key](value)) }])
})
const metricBars = computed(() => metricRows.value.map(metric => ({
  ...metric,
  rows: metric.value === undefined ? [] : [{ label: metric.label, value: metric.value, displayValue: metric.display }],
})))
const qualitySourceRange = computed(() => localReportChartRange(props.evidence, props.evidence.quality?.source.fileName ?? '质量数据', props.filter))
function trendFrames<T>(rows: readonly T[], timeOf: (row: T) => number) {
  const frames = new Map<number, T[]>()
  for (const row of rows) {
    const time = timeOf(row)
    if (!Number.isFinite(time) || time < props.evidence.startTimeS || time > props.evidence.endTimeS) continue
    const atTime = frames.get(time)
    if (atTime) atTime.push(row)
    else frames.set(time, [row])
  }
  return [...frames].sort(([left], [right]) => left - right).map(([time, rows]) => ({ time, rows }))
}
type TrendFrame<T> = ReturnType<typeof trendFrames<T>>[number]
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
const switchTrend = computed(() => {
  const archive = engineArchive.value
  if (archive?.aggregate?.switchCountTrend?.length) return chartTrendRows(archive.aggregate.switchCountTrend)
  const quality = props.evidence.quality
  const times = archive && (archive.aggregate || archive.switchRows.length)
    ? archive.switchRows.map(row => row.simulationTime)
    : quality && (quality.source.switchEventsProvided === true || quality.switchEvents.length)
      ? quality.switchEvents.filter(row => row.decision === 'ACCEPTED').map(row => row.time)
      : (props.evidence.switchEvents ?? []).map(row => row.time)
  const frames = trendFrames(times, time => time)
  const total = metricByKey.value.get('switches')?.value
  const observed = frames.reduce((count, frame) => count + frame.rows.length, 0)
  // 旧摘要如果截断了事件，仍显示卡片的完整计数，不能用残缺明细补出累计曲线。
  if (total === undefined ? observed === 0 : observed !== total) return []
  let count = 0
  const points: LocalReportTrendPoint[] = [{ time: props.evidence.startTimeS, value: 0 }]
  for (const frame of frames) {
    count += frame.rows.length
    if (points.at(-1)?.time === frame.time) points[points.length - 1] = { time: frame.time, value: count }
    else points.push({ time: frame.time, value: count })
  }
  if (points.at(-1)!.time !== props.evidence.endTimeS) points.push({ time: props.evidence.endTimeS, value: count })
  return chartTrendRows(points)
})
const jammingTrend = computed(() => {
  const duration = props.evidence.qualityKpis?.jammingDurationS
  if (duration === undefined) return chartTrendRows(engineArchive.value?.aggregate?.jammingDurationTrend ?? [])
  if (props.evidence.qualityJammingDurationTrend) return chartTrendRows(props.evidence.qualityJammingDurationTrend)
  const points = qualityView.value?.jammingDurationTrend
  const last = points?.at(-1)
  // An older server's projected samples can omit the evidence for a clipped boundary interval.
  return points && last && Math.abs(last.value - duration) <= 1e-9 ? chartTrendRows(points) : []
})
const qualityMetricCharts = computed(() => {
  const view = qualityView.value
  if (!view?.samples.length) return []
  const frames = trendFrames(view.samples, sample => sample.time)
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
  return [
    { key: 'connected' as const, title: '连通时长随时间变化', unit: '秒', rows: trendPoints(intervals, frame => frame.rows[0]!.connected, continuous) },
    { key: 'switches' as const, title: '切换次数随时间变化', unit: '次', rows: switchTrend.value },
    { key: 'jsr' as const, title: '干信比随时间变化', unit: 'dB', rows: trendPoints(frames, frame => mean(frame.rows.map(row => row.jsrDb).filter(value => Number.isFinite(value) && value !== -999)), continuous) },
    { key: 'ber' as const, title: '误码率随时间变化', unit: '比率', rows: trendPoints(frames, frame => mean(frame.rows.map(row => row.ber).filter(Number.isFinite)), continuous) },
    { key: 'jamming' as const, title: '干扰持续时长随时间变化', unit: '秒', rows: jammingTrend.value },
  ]
})
const engineMetricCharts = computed(() => {
  const segments = engineArchive.value?.segmentRows ?? []
  if (!segments.length && !switchTrend.value.length && !jammingTrend.value.length) return []
  const frames = trendFrames(segments, row => row.simulationTime)
  const continuous = (left: typeof frames[number], right: typeof frames[number]) => {
    const previous = left.rows[0]!, current = right.rows[0]!
    const frameDelta = current.frameId - previous.frameId
    return previous.engineEpoch === current.engineEpoch && frameDelta > 0 && frameDelta <= ENGINE_FRAME_ID_STEP
  }
  return [
    { key: 'connected' as const, title: '连通时长随时间变化', unit: '秒', rows: trendPoints(frames, (frame, next) => {
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
    }, continuous) },
    { key: 'switches' as const, title: '切换次数随时间变化', unit: '次', rows: switchTrend.value },
    { key: 'jsr' as const, title: '干信比随时间变化', unit: 'dB', rows: trendPoints(frames, frame => mean(frame.rows.map(row => row.segment.quality.gxbDb)
      .filter((value): value is number => value !== null && Number.isFinite(value) && value !== -999)), continuous) },
    { key: 'ber' as const, title: '误码率随时间变化', unit: '比率', rows: trendPoints(frames, frame => mean(frame.rows.map(row => row.segment.quality.ber)
      .filter((value): value is number => value !== null && Number.isFinite(value))), continuous) },
    { key: 'jamming' as const, title: '干扰持续时长随时间变化', unit: '秒', rows: jammingTrend.value },
  ]
})
const chartMetricRows = computed(() => (qualityMetricCharts.value.length ? qualityMetricCharts.value : engineMetricCharts.value)
  .map(chart => ({ ...chart, scopeSummary: metricByKey.value.get(chart.key)?.display })))
const activeTab = ref('汇总')
watch([activeTab, () => props.evidence, () => props.filterPending], ([tab, , filterPending]) => {
  if (!filterPending && (tab === '折线图' || tab === '雷达图')) {
    // 引擎归档结果直接加载完整段明细；只有普通质量证据报告才加载 evidence 曲线。
    if (engineArchive.value) {
      if (engineArchive.value.detailDeferred) emit('load-engine-segments')
    } else emit('load-quality-evidence')
  }
})
const filterTab = ref('汇总')
const isEventTab = computed(() => filterTab.value === '事件时间线')
const showFilters = computed(() => !props.preciseFilter && isEventTab.value)
const nodeId = ref('')
const connectionId = ref('')
const from = ref<number | null>(null)
const to = ref<number | null>(null)
const page = ref(1)
const rangeError = computed(() => from.value !== null && to.value !== null && from.value > to.value)
const connection = computed(() => props.evidence.connections.find(row => row.eventId === connectionId.value))
const availableConnections = computed(() => props.evidence.connections.filter(row => !nodeId.value
  || [row.sourcePlatformId, row.targetPlatformId].includes(nodeId.value)))
const nodeNames = computed(() => new Map(props.evidence.nodes.map(node => [node.platformId, node.name])))
const connectionOptions = computed(() => availableConnections.value.map(row => ({
  value: row.eventId,
  label: `${nodeName(row.sourcePlatformId)} → ${nodeName(row.targetPlatformId)} · ${row.eventId}`,
})))
const inRange = (time: number) => !rangeError.value && (from.value === null || time >= from.value) && (to.value === null || time <= to.value)
const connections = computed(() => props.evidence.connections.filter(row => inRange(row.time)
  && (!nodeId.value || [row.sourcePlatformId, row.targetPlatformId].includes(nodeId.value))
  && (!connectionId.value || row.eventId === connectionId.value)))
const deviceEvents = computed(() => props.evidence.deviceEvents.filter(row => inRange(row.time)
  && (!nodeId.value || row.platformId === nodeId.value)
  && (!connectionId.value || (connection.value && ((row.platformId === connection.value.sourcePlatformId && row.deviceId === connection.value.sourceDeviceId)
    || (row.platformId === connection.value.targetPlatformId && row.deviceId === connection.value.targetDeviceId))))))
const switches = computed(() => (props.evidence.switchEvents ?? []).filter(row => inRange(row.time)))
const switchTable = computed(() => localReportTables({ ...props.evidence, switchEvents: switches.value })[6]!)
// 规范质量文件中的切换记录与运行日志来源不同，不能用前端遥测缓存替代。
// 在同一时间线中保留其判定方向、原因和文件来源，以便与引擎日志事件区分。
const qualitySwitches = computed(() => (props.evidence.quality?.switchEvents ?? []).filter(row => {
  if (!inRange(row.time)) return false
  if (!nodeId.value && !connectionId.value) return true
  // SwitchEvent only has link ids.  Its node/connection scope is established only from
  // measurements for either recorded link; missing endpoint evidence is not guessed.
  const endpoints = props.evidence.quality!.samples.filter(sample => sample.linkId === row.oldLinkId || sample.linkId === row.newLinkId)
  if (!endpoints.length) return false
  if (nodeId.value && !endpoints.some(sample => sample.sourcePlatform === nodeId.value || sample.destPlatform === nodeId.value)) return false
  if (connectionId.value && connection.value && !endpoints.some(sample => sample.sourcePlatform === connection.value!.sourcePlatformId
    && sample.destPlatform === connection.value!.targetPlatformId)) return false
  return true
}))
const timeline = computed(() => {
  const runtime = props.preciseFilter
    ? props.timeline.map(row => ({ id: `RUNTIME:${row.id}`, time: row.time, text: `${EVENT_LABELS[row.type] ?? row.type} · ${nodeName(row.subject)}${row.target ? ` → ${nodeName(row.target)}` : ''}` }))
    : [
      ...connections.value.map(row => ({ id: `RUNTIME:${row.eventId}`, time: row.time, text: `通信关联登记 · ${nodeName(row.sourcePlatformId)} → ${nodeName(row.targetPlatformId)}` })),
      ...deviceEvents.value.map(row => ({ id: `RUNTIME:${row.eventId}`, time: row.time, text: `${EVENT_LABELS[row.type] ?? row.type} · ${nodeName(row.platformId)} · ${row.deviceId}` })),
      ...switches.value.map(row => ({ id: `RUNTIME:${row.eventId}`, time: row.time, text: `链路切换 · ${row.demandId} · ${row.fromLinkId ?? row.fromDeviceId} → ${row.toLinkId ?? row.toDeviceId}` })),
    ]
  const quality = qualitySwitches.value.map(row => ({
    id: `QUALITY:${row.eventId}`,
    time: row.time,
    text: `质量链路切换 · ${row.direction} · ${row.oldLinkId} → ${row.newLinkId} · ${row.decision} · ${row.reason} · 来源 ${props.evidence.quality!.source.fileName}`,
  }))
  const engine = [
    ...engineSwitches.value.map((row, index) => ({
      // 同帧同路径的前/返向或重复上游事件都必须保留，索引对应摘要中的原始行序。
      id: `ENGINE_SWITCH:${row.engineEpoch}:${row.frameId}:${row.value.pathId}:${row.value.direction}:${index}`,
      time: row.simulationTime,
      text: `引擎路径切换 · ${row.value.direction} · ${row.value.pathId}`,
      detail: `源轮次/帧/时刻：${row.engineEpoch}/${row.frameId}/${row.simulationTime}；旧路径 ${row.value.oldPathId ?? '暂无数据'} · ${enginePath(row.value.oldNodes)}；新路径 ${row.value.pathId} · ${enginePath(row.value.nodes)}；原因 ${row.value.reasons.map(reason => `${reason.linkId ?? '未提供'}:${reason.reasons.join('、') || '暂无数据'}`).join('；') || '暂无数据'}`,
    })),
    ...engineEvents.value.map((row, index) => ({
      id: `ENGINE_EVENT:${row.engineEpoch}:${row.frameId}:${row.value.pathId ?? '无路径'}:${row.value.type ?? '未提供'}:${row.value.uavIds.join(',')}:${row.value.jammerIds.join(',')}:${index}`,
      time: row.simulationTime,
      text: `引擎事件 · ${row.value.type ?? '未提供'} · 路径 ${row.value.pathId ?? '暂无数据'}`,
      detail: `源轮次/帧/时刻：${row.engineEpoch}/${row.frameId}/${row.simulationTime}；任务节点 ${row.value.uavIds.map(nodeName).join('、') || '暂无数据'}；干扰节点 ${row.value.jammerIds.map(nodeName).join('、') || '暂无数据'}`,
    })),
  ]
  const seen = new Set<string>()
  return [...runtime, ...quality, ...engine].filter(event => seen.has(event.id) ? false : (seen.add(event.id), true))
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
})
const bars = computed(() => props.evidence.eventCounts.map(row => ({ label: EVENT_LABELS[row.type] ?? row.type, value: row.count })))
const comparisonOpen = ref(false)
const referenceResultId = ref('')
const currentComparison = computed(() => props.comparison.find(row => row.record.resultId === props.currentResultId))
const comparisonHistory = computed(() => {
  const current = currentComparison.value
  if (!current) return []
  return props.comparison
    .filter(row => row.record.resultId !== current.record.resultId && row.parameters.scenarioId === current.parameters.scenarioId)
    .sort((a, b) => Date.parse(b.record.completedAt) - Date.parse(a.record.completedAt))
})
const referenceComparison = computed(() => comparisonHistory.value.find(row => row.record.resultId === referenceResultId.value) ?? comparisonHistory.value[0])
const showAllComparison = ref(false)
const comparisonSides = ['reference', 'current'] as const
const comparisonRows = computed(() => {
  const current = currentComparison.value
  const reference = referenceComparison.value
  return current && reference ? compareRunParameters(reference.parameters, current.parameters) : []
})
const comparisonDifferences = computed(() => comparisonRows.value.filter(row => row.changed))
const visibleComparisonRows = computed(() => showAllComparison.value ? comparisonRows.value : comparisonDifferences.value)
function comparisonRunLabel(row: MissionResultParameterComparison): string {
  const source = row.parameters.source === 'PROJECT_REFERENCE' ? '项目参考配置' : '运行时保存的配置'
  return `${formatDateTime(row.record.completedAt)} · 修订 ${row.parameters.revision} · ${source}`
}
function openComparison(): void {
  showAllComparison.value = false
  comparisonOpen.value = true
  emit('load-comparisons')
}
function comparisonJammerName(id: string, index: number): string {
  const ground = /^(?:ground_jammer|jammer_station)(?:_(\d+))?$/i.exec(id)
  if (ground) return ground[1] ? `地面干扰机 ${ground[1]}` : '地面干扰机'
  const airborne = /^(?:airborne_jammer|jammer_airborne)(?:_(\d+))?$/i.exec(id)
  if (airborne) return airborne[1] ? `机载干扰机 ${airborne[1]}` : '机载干扰机'
  return `干扰机 ${index + 1}`
}
function comparisonRowName(row: RunParameterComparisonRow): string {
  if (row.id === undefined) return row.group
  return row.group === '链路'
    ? reportLinkLabel(row.id, row.index ?? 0, row.type)
    : comparisonJammerName(row.id, row.index ?? 0)
}
function nodeName(id: string): string { return nodeNames.value.get(id) ?? id }
function resetFilters(): void { nodeId.value = ''; connectionId.value = ''; from.value = null; to.value = null; page.value = 1 }
watch(() => props.evidence, resetFilters)
watch(nodeId, () => {
  if (connectionId.value && !availableConnections.value.some(row => row.eventId === connectionId.value)) connectionId.value = ''
})
watch([nodeId, connectionId, from, to], () => { page.value = 1 })
</script>

<template>
  <section class="local-report" data-testid="local-report" aria-label="本地运行数据报告">
    <p v-if="preciseFilter && timelineTotal > 0" class="scope-note">通信关联、设备事件和时间线各最多显示 500 条，事件统计包含全部匹配记录。</p>
    <el-alert v-if="evidence.positionIssueCount || evidence.eventWarningCount || evidence.waitingForPositionLine || !evidence.simulationComplete || evidence.messageDetailsComplete === false" type="warning" :closable="false" :title="evidence.messageDetailsComplete === false ? `${evidence.messageDetailEventCount} 条消息已计入统计，但本次回放不显示逐条动画。` : '部分记录异常或未完成，或未记录仿真结束。请在汇总中核对统计范围。'" />
    <el-alert v-if="engineArchive?.detailTruncated" type="warning" :closable="false" data-testid="engine-archive-truncated" :title="`明细、曲线和时间线可能不完整。${engineArchive.aggregate ? '汇总仍包含完整归档。' : ''}请下载完整归档核对。`" />
    <section class="engine-metric-cards" data-testid="report-metric-cards" aria-label="评估指标">
      <el-card v-for="metric in metricRows" :key="metric.key" shadow="never" class="engine-metric-card"><h4>{{ metric.label }}</h4><p>{{ metric.display }}</p></el-card>
    </section>
    <el-form v-if="showFilters" inline class="report-filters" aria-label="报告明细筛选">
      <el-form-item label="节点"><el-select v-model="nodeId" clearable placeholder="全部节点" data-testid="report-filter-node"><el-option v-for="node in evidence.nodes" :key="node.platformId" :value="node.platformId" :label="node.name" /></el-select></el-form-item>
      <el-form-item v-if="isEventTab" label="通信关联"><el-select-v2 v-model="connectionId" :options="connectionOptions" clearable filterable placeholder="全部关联" data-testid="report-filter-link" /></el-form-item>
      <el-form-item v-if="isEventTab" label="开始时刻（秒）"><el-input-number v-model="from" :min="0" :max="evidence.endTimeS" data-testid="report-filter-from" /></el-form-item>
      <el-form-item v-if="isEventTab" label="结束时刻（秒）"><el-input-number v-model="to" :min="0" :max="evidence.endTimeS" data-testid="report-filter-to" /></el-form-item>
      <el-form-item><el-button @click="resetFilters">重置筛选</el-button></el-form-item>
    </el-form>
    <el-alert v-if="isEventTab && rangeError" type="error" title="开始时刻不得晚于结束时刻。" :closable="false" />
    <div v-if="activeTab === '汇总'" class="report-summary-actions">
      <el-button plain data-testid="report-parameter-comparison" aria-haspopup="dialog" @click="openComparison">运行参数对比</el-button>
    </div>
    <el-tabs v-model="activeTab" @tab-click="filterTab = String($event.paneName)">
      <el-tab-pane v-for="table in [summaryTable, switchTable, ...tables.slice(8)]" :key="table.title" :label="table.title" :name="table.title" :class="{ 'report-table-pane': table.title !== '汇总' }" lazy>
        <el-table class="report-data-table" :data="table.rows" stripe :height="table.title === '汇总' ? undefined : '100%'" :aria-label="table.title" empty-text="暂无数据">
          <el-table-column v-for="(label, index) in table.columns" :key="index" :prop="String(index)" :label="label" min-width="140" />
        </el-table>
      </el-tab-pane>
      <el-tab-pane label="折线图" name="折线图" lazy>
        <template v-if="chartMetricRows.length">
          <ReportChart v-for="chart in chartMetricRows" :key="chart.key" :title="chart.title" :unit="chart.unit" :rows="chart.rows"
            line use-echarts hide-source :show-point-list="false" :invalid-value="-999" :x-min="evidence.startTimeS" :x-max="evidence.endTimeS"
            :step-end="chart.key === 'switches'" :scope-summary="chart.scopeSummary" :source-range="qualitySourceRange" :generated-time="generatedTime" />
        </template>
        <el-empty v-if="!chartMetricRows.length" description="暂无数据" data-testid="report-quality-curves" />
      </el-tab-pane>
      <el-tab-pane label="柱状图" name="柱状图" lazy>
        <section data-testid="report-bar-charts" class="report-metric-bars">
          <h4>五项评估指标</h4>
          <div class="report-metric-bar-grid">
            <ReportChart v-for="metric in metricBars" :key="metric.key" :title="metric.label" :unit="metric.unit" :rows="metric.rows" use-echarts hide-source />
          </div>
        </section>
      </el-tab-pane>
      <el-tab-pane label="雷达图" name="雷达图" lazy>
        <div data-testid="report-radar-chart">
          <ReportChart v-if="radarMetricRows.length" title="五项评估指标" unit="" :rows="radarMetricRows" radar use-echarts hide-source :source-range="qualitySourceRange" :generated-time="generatedTime" />
          <el-empty v-else description="暂无数据" />
        </div>
      </el-tab-pane>
      <el-tab-pane label="事件时间线" name="事件时间线" lazy>
        <el-timeline v-if="timeline.length" data-testid="report-event-timeline">
          <el-timeline-item v-for="event in timeline.slice((page - 1) * 50, page * 50)" :key="event.id" :timestamp="reportTime(event.time)"><strong>{{ event.text }}</strong><details><summary>查看事件详情</summary><p>{{ event.id }}</p><p v-if="event.detail">{{ event.detail }}</p></details></el-timeline-item>
        </el-timeline>
        <p v-if="preciseFilter && timelineTotal > timeline.length" class="scope-note">运行日志共 {{ timelineTotal }} 条，时间线仅展示部分记录。</p>
        <el-empty v-if="!timeline.length" description="暂无符合条件的数据" />
        <el-pagination v-if="timeline.length > 50" v-model:current-page="page" :page-size="50" :total="timeline.length" layout="prev, pager, next" />
      </el-tab-pane>
    </el-tabs>
    <el-dialog v-model="comparisonOpen" title="运行参数对比" width="min(1280px, calc(100vw - 2rem))" top="6vh" append-to-body destroy-on-close>
      <div v-loading="comparisonLoading" :aria-busy="comparisonLoading">
        <p v-if="comparisonLoading" role="status" data-testid="run-parameter-difference-status">正在读取历史运行参数…</p>
        <template v-else-if="currentComparison && referenceComparison">
          <div class="comparison-toolbar">
            <p role="status" data-testid="run-parameter-difference-status">
              {{ comparisonDifferences.length ? '共 ' + comparisonDifferences.length + ' 项差异' : '两次运行的参数对比项一致。' }}
            </p>
            <el-checkbox v-model="showAllComparison">显示全部参数</el-checkbox>
          </div>
          <p v-if="currentComparison.parameters.source === 'PROJECT_REFERENCE' || referenceComparison.parameters.source === 'PROJECT_REFERENCE'" class="comparison-meta">
            对比含项目参考配置，未确认引擎实际执行版本。
          </p>
          <div class="comparison-scroll">
            <table class="comparison-pair" aria-label="运行参数左右对照" data-testid="run-parameter-differences">
              <thead>
                <tr>
                  <th scope="col" class="comparison-reference-column" data-testid="run-parameter-reference">
                    <h3>对照运行</h3>
                    <el-select :model-value="referenceComparison.record.resultId" aria-label="对照运行" data-testid="run-parameter-history"
                      @update:model-value="referenceResultId = $event">
                      <el-option v-for="entry in comparisonHistory" :key="entry.record.resultId" :value="entry.record.resultId" :label="comparisonRunLabel(entry)" />
                    </el-select>
                    <span class="comparison-meta">{{ referenceComparison.record.scenarioName }} · 编号 {{ referenceComparison.record.resultId }}</span>
                  </th>
                  <th scope="col" class="comparison-current-column" data-testid="run-parameter-current">
                    <h3>本次运行</h3>
                    <div class="comparison-run-time">{{ comparisonRunLabel(currentComparison) }}</div>
                    <span class="comparison-meta">{{ currentComparison.record.scenarioName }} · 编号 {{ currentComparison.record.resultId }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in visibleComparisonRows" :key="row.key" :class="{ 'comparison-changed': row.changed }">
                  <td v-for="side in comparisonSides" :key="side" :class="'comparison-' + side + '-column'">
                    <div class="comparison-field">
                      <div>
                        <div>{{ comparisonRowName(row) }} · {{ row.field }}</div>
                        <span v-if="row.id" class="comparison-meta">编号 {{ row.id }}</span>
                      </div>
                      <strong class="comparison-value">{{ row[side] }}</strong>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <p v-else-if="comparison.length" role="status" data-testid="run-parameter-difference-status">
          {{ currentComparison ? '没有同场景的历史参数快照可对比。' : '本次运行未保存参数快照，无法对比。' }}
        </p>
        <details v-if="comparison.length && !referenceComparison" :open="!comparisonLoading" class="comparison-full" data-testid="run-parameter-full">
          <summary>查看完整参数</summary>
          <el-table :data="comparison" row-key="record.resultId" stripe max-height="60vh" data-testid="completed-result-parameter-comparison">
            <el-table-column label="运行结果" min-width="172">
              <template #default="{ row }">
                <strong>{{ row.record.resultId === currentResultId ? '本次运行' : '历史运行' }}</strong>
                <span class="comparison-meta">{{ row.record.scenarioName }}</span>
                <span class="comparison-meta" :title="row.record.resultId">编号 {{ row.record.resultId }}</span>
              </template>
            </el-table-column>
            <el-table-column label="完成时刻" min-width="168">
              <template #default="{ row }">{{ formatDateTime(row.record.completedAt) }}</template>
            </el-table-column>
            <el-table-column label="配置来源" min-width="168">
              <template #default="{ row }">
                <strong>{{ row.parameters.source === 'PROJECT_REFERENCE' ? '项目参考配置' : '运行时保存的配置' }}</strong>
                <span class="comparison-meta">场景编号 {{ row.parameters.scenarioId }}</span>
                <span v-if="row.parameters.source === 'PROJECT_REFERENCE'" class="comparison-meta">未确认引擎实际执行版本</span>
              </template>
            </el-table-column>
            <el-table-column prop="parameters.revision" label="修订" width="64" />
            <el-table-column prop="parameters.platformCount" label="节点数" width="70" />
            <el-table-column prop="parameters.linkCount" label="链路数" width="70" />
            <el-table-column prop="parameters.jammerCount" label="干扰机数" width="80" />
            <el-table-column label="链路参数" min-width="220">
              <template #default="{ row }">
                <ul v-if="row.parameters.links.length" class="comparison-items">
                  <li v-for="(link, index) in row.parameters.links" :key="link.id">
                    <strong>{{ reportLinkLabel(link.id, index, link.type) }}</strong>
                    <span class="comparison-meta">编号 {{ link.id }}</span>
                    <div>频率 {{ link.frequencyMHz }} MHz</div>
                    <div>带宽 {{ link.bandwidthMHz }} MHz</div>
                    <div>发射功率 {{ link.txPowerW }} W</div>
                  </li>
                </ul>
                <span v-else class="comparison-meta">无链路参数</span>
              </template>
            </el-table-column>
            <el-table-column label="干扰机参数" min-width="220">
              <template #default="{ row }">
                <ul v-if="row.parameters.jammers.length" class="comparison-items">
                  <li v-for="(jammer, index) in row.parameters.jammers" :key="jammer.id">
                    <strong>{{ comparisonJammerName(jammer.id, index) }}</strong>
                    <span class="comparison-meta">编号 {{ jammer.id }}</span>
                    <div>频率 {{ jammer.frequencyMHz }} MHz</div>
                    <div>带宽 {{ jammer.bandwidthMHz }} MHz</div>
                    <div>默认功率 {{ jammer.defaultPowerW }} W</div>
                  </li>
                </ul>
                <span v-else class="comparison-meta">无干扰机参数</span>
              </template>
            </el-table-column>
          </el-table>
        </details>
        <el-empty v-else-if="!comparisonLoading && !comparison.length" description="当前历史快照未保存可比较参数" />
      </div>
      <template #footer><el-button @click="comparisonOpen = false">关闭</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.local-report { --report-tabs-bar-height: 40px; --report-comparison-button-width: 7.5rem; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.engine-metric-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin: 12px 0; }
.engine-metric-card h4 { margin: 0; font-size: 13px; color: var(--el-text-color-secondary); }
.engine-metric-card p { margin: 8px 0 0; font-size: 16px; font-weight: 600; }
.report-filters :deep(.el-select), .report-filters :deep(.el-select-v2) { width: 180px; }
.local-report :deep(.report-table-pane) { display: flex; flex-direction: column; min-height: 0; }
.report-data-table { flex: 1; min-height: 0; }
.report-metric-bars > h4 { margin: 0 0 0.75rem; }
.report-metric-bar-grid { display: flex; flex-wrap: wrap; gap: 0.75rem; }
.report-metric-bar-grid > .report-chart { flex: 1 1 min(100%, 22rem); }
.local-report > .el-tabs { --el-tabs-header-height: var(--report-tabs-bar-height); }
.report-summary-actions { position: relative; z-index: 1; height: 0; }
.report-summary-actions > .el-button {
  position: absolute;
  inset-inline-end: 0;
  inset-block-start: calc(var(--report-tabs-bar-height) / 2);
  width: var(--report-comparison-button-width);
  transform: translateY(-50%);
}
.report-summary-actions + .el-tabs :deep(.el-tabs__header) { padding-inline-end: calc(var(--report-comparison-button-width) + 0.75rem); }
.comparison-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0 1rem; }
.comparison-toolbar p { margin: 0.5rem 0; }
.comparison-scroll { max-height: 60vh; overflow: auto; }
.comparison-pair { width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 0.75rem 0; }
.comparison-pair th, .comparison-pair td { text-align: start; vertical-align: top; padding: 0.75rem; overflow-wrap: anywhere; }
.comparison-pair th { position: sticky; top: 0; z-index: 1; background: var(--el-bg-color-overlay); border-top: 2px solid var(--el-border-color); }
.comparison-pair th.comparison-current-column { border-top-color: var(--el-color-primary); }
.comparison-pair h3 { margin: 0 0 0.5rem; color: var(--el-text-color-primary); }
.comparison-pair th .comparison-meta { margin-top: 0.375rem; font-weight: normal; }
.comparison-run-time { min-height: 32px; display: flex; align-items: center; font-weight: normal; }
.comparison-pair td { background: var(--el-fill-color-light); border-bottom: 1px solid var(--el-border-color-lighter); }
.comparison-field { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.25rem 0.75rem; }
.comparison-value { color: var(--el-text-color-primary); }
.comparison-changed .comparison-current-column .comparison-value { color: var(--el-color-primary); }
.comparison-full { margin-top: 0.75rem; }
.comparison-full > summary { cursor: pointer; padding: 0.5rem 0; }
.comparison-meta { display: block; color: var(--el-text-color-secondary); font-size: var(--el-font-size-small); overflow-wrap: anywhere; }
.comparison-items { margin: 0; padding: 0; list-style: none; }
.comparison-items > li + li { margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--el-border-color-lighter); }
.connection-pagination { flex: 0 0 auto; padding-top: 12px; }
.scope-note { color: var(--el-text-color-secondary); font-size: 12px; text-align: center;}
</style>

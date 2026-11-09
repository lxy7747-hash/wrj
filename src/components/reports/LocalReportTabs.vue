<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { LocalReportEvidence, LocalReportFilter } from '../../contracts/domain-models'
import type { MissionResultParameterComparison } from '../../features/results/mission-result'
import { engineAggregateSummary, EVENT_LABELS, localReportTables, localReportChartRange, reportTime } from '../../features/reports/local-report'
import { qualityReportView } from '../../features/reports/quality-report'
import { ENGINE_FRAME_ID_STEP } from '../../features/data-exchange/engine-frame-snapshot'
import ReportChart from './ReportChart.vue'

const props = withDefaults(defineProps<{ evidence: LocalReportEvidence; generatedTime?: string; filter?: LocalReportFilter; comparison?: MissionResultParameterComparison[]; preciseFilter?: boolean; timeline?: Array<{ id: string; time: number; type: string; subject: string; target?: string }>; timelineTotal?: number }>(), { comparison: () => [], preciseFilter: false, timeline: () => [], timelineTotal: 0 })
const tables = computed(() => localReportTables(props.evidence))
const qualityView = computed(() => props.evidence.quality === undefined ? null : qualityReportView(props.evidence.quality, props.evidence))
const engineArchive = computed(() => props.evidence.engineFrameArchive)
const engineCsv = computed(() => props.evidence.engineCsv)
const engineAggregateRows = computed(() => engineAggregateSummary(props.evidence))
function matchesSelectedConnection(sourcePlatformId: string | null, targetPlatformId: string | null): boolean {
  if (!connectionId.value) return true
  return !!connection.value && sourcePlatformId === connection.value.sourcePlatformId && targetPlatformId === connection.value.targetPlatformId
}
const engineSegments = computed(() => (engineArchive.value?.segmentRows ?? []).filter(row => inRange(row.simulationTime)
  && (!nodeId.value || row.segment.sourcePlatformId === nodeId.value || row.segment.targetPlatformId === nodeId.value)
  && matchesSelectedConnection(row.segment.sourcePlatformId, row.segment.targetPlatformId)))
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
const enginePath = (nodes: { platformId: string | null; inPort: string | null; outPort: string | null }[]) => nodes.length
  ? nodes.map(node => `${nodeName(node.platformId ?? '未提供')}（入:${node.inPort ?? '未提供'}；出:${node.outPort ?? '未提供'}）`).join(' → ') : '暂无数据'
const engineCurves = computed(() => {
  const groups = new Map<string, typeof engineSegments.value>()
  for (const row of engineSegments.value) {
    const identity = `${row.engineEpoch}:${row.segment.linkId}:${row.segment.sourceName ?? '未提供'}:${row.segment.sourcePort ?? '未提供'}→${row.segment.targetName ?? '未提供'}:${row.segment.targetPort ?? '未提供'}`
    const rows = groups.get(identity)
    if (rows) rows.push(row)
    else groups.set(identity, [row])
  }
  return [...groups].map(([identity, rows]) => ({ identity, rows: [...rows].sort((left, right) => left.simulationTime - right.simulationTime || left.frameId - right.frameId) }))
})
const qualityConnectivityRates = computed(() => props.evidence.qualityConnectivityRates ?? qualityView.value?.connectivityRates ?? [])
const barSourceRange = computed(() => localReportChartRange(props.evidence, props.evidence.eventFile.fileName, props.filter))
const qualitySourceRange = computed(() => localReportChartRange(props.evidence, props.evidence.quality?.source.fileName ?? '质量数据', props.filter))
const activeTab = ref('汇总')
const isNodeTab = computed(() => activeTab.value === '节点与位置')
const isEventTab = computed(() => ['通信关联登记', '设备与干扰请求', '事件时间线'].includes(activeTab.value))
const showFilters = computed(() => !props.preciseFilter && (isNodeTab.value || isEventTab.value))
const nodeId = ref('')
const connectionId = ref('')
const from = ref<number | null>(null)
const to = ref<number | null>(null)
const page = ref(1)
const connectionPage = ref(1)
const connectionPageSize = ref(50)
const engineSegmentPage = ref(1)
const engineSegmentPageSize = ref(50)
const rangeError = computed(() => from.value !== null && to.value !== null && from.value > to.value)
const connection = computed(() => props.evidence.connections.find(row => row.eventId === connectionId.value))
const availableConnections = computed(() => props.evidence.connections.filter(row => !nodeId.value
  || [row.sourcePlatformId, row.targetPlatformId].includes(nodeId.value)))
const nodeNames = computed(() => new Map(props.evidence.nodes.map(node => [node.platformId, node.name])))
const connectionOptions = computed(() => availableConnections.value.map(row => ({
  value: row.eventId,
  label: `${nodeName(row.sourcePlatformId)} → ${nodeName(row.targetPlatformId)} · ${row.eventId}`,
})))
const nodes = computed(() => props.evidence.nodes.filter(row => !nodeId.value || row.platformId === nodeId.value))
const nodeTable = computed(() => localReportTables({ ...props.evidence, nodes: nodes.value })[1]!)
const inRange = (time: number) => !rangeError.value && (from.value === null || time >= from.value) && (to.value === null || time <= to.value)
const connections = computed(() => props.evidence.connections.filter(row => inRange(row.time)
  && (!nodeId.value || [row.sourcePlatformId, row.targetPlatformId].includes(nodeId.value))
  && (!connectionId.value || row.eventId === connectionId.value)))
const deviceEvents = computed(() => props.evidence.deviceEvents.filter(row => inRange(row.time)
  && (!nodeId.value || row.platformId === nodeId.value)
  && (!connectionId.value || (connection.value && ((row.platformId === connection.value.sourcePlatformId && row.deviceId === connection.value.sourceDeviceId)
    || (row.platformId === connection.value.targetPlatformId && row.deviceId === connection.value.targetDeviceId))))))
const detailTables = computed(() => localReportTables({ ...props.evidence, connections: connections.value, deviceEvents: deviceEvents.value }).slice(2, 4))
const detections = computed(() => (props.evidence.detectionEvents ?? []).filter(row => inRange(row.time)
  && (!nodeId.value || row.platformId === nodeId.value || row.targetPlatformId === nodeId.value)))
const detectionTable = computed(() => localReportTables({ ...props.evidence, detectionEvents: detections.value })[5]!)
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
const connectionRows = computed(() => detailTables.value[0]!.rows.slice(
  (connectionPage.value - 1) * connectionPageSize.value, connectionPage.value * connectionPageSize.value,
))
const engineSegmentRows = computed(() => engineSegments.value.slice(
  (engineSegmentPage.value - 1) * engineSegmentPageSize.value, engineSegmentPage.value * engineSegmentPageSize.value,
))
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
const parameterRows = computed(() => props.comparison.map(({ record, parameters }) => ({
  resultId: record.resultId, completedAt: record.completedAt, revision: parameters.revision, platformCount: parameters.platformCount, linkCount: parameters.linkCount, jammerCount: parameters.jammerCount,
  links: parameters.links.map(link => `${link.id} ${link.type} ${link.frequencyMHz}MHz/${link.bandwidthMHz}MHz/${link.txPowerW}W`).join('； ') || '无',
  jammers: parameters.jammers.map(jammer => `${jammer.id} ${jammer.frequencyMHz}MHz/${jammer.bandwidthMHz}MHz/${jammer.defaultPowerW}W`).join('； ') || '无',
})))
function nodeName(id: string): string { return nodeNames.value.get(id) ?? id }
function resetFilters(): void { nodeId.value = ''; connectionId.value = ''; from.value = null; to.value = null; page.value = 1; connectionPage.value = 1; engineSegmentPage.value = 1 }
watch(() => props.evidence, resetFilters)
watch(nodeId, () => {
  if (connectionId.value && !availableConnections.value.some(row => row.eventId === connectionId.value)) connectionId.value = ''
})
watch([nodeId, connectionId, from, to], () => { page.value = 1; connectionPage.value = 1; engineSegmentPage.value = 1 })
watch(connectionPageSize, () => { connectionPage.value = 1 })
watch(engineSegmentPageSize, () => { engineSegmentPage.value = 1 })
</script>

<template>
  <section class="local-report" data-testid="local-report" aria-label="本地运行数据报告">
    <p v-if="preciseFilter && timelineTotal > 0" class="scope-note">精确筛选的通信关联、设备事件和时间线每类最多展示前 500 条；事件分类统计覆盖全部匹配记录。</p>
    <el-alert v-if="evidence.positionIssueCount || evidence.eventWarningCount || evidence.waitingForPositionLine || !evidence.simulationComplete || evidence.messageDetailsComplete === false" type="warning" :closable="false" :title="evidence.messageDetailsComplete === false ? `当前大型事件来源的 ${evidence.messageDetailEventCount} 条消息已完整计入分类统计和来源摘要，但逐消息动画未装入本次回放快照。` : '当前来源存在警告、跳过记录、未完成行或未记录仿真结束；统计仅覆盖已解析快照，请核对汇总说明。'" />
    <el-descriptions :column="1" border class="local-report-sources">
      <el-descriptions-item label="事件来源">{{ evidence.eventFile.fileName }} · SHA-256 {{ evidence.eventFile.sha256 }}</el-descriptions-item>
      <el-descriptions-item label="位置来源">{{ evidence.positionFile.fileName }} · SHA-256 {{ evidence.positionFile.sha256 }}</el-descriptions-item>
    </el-descriptions>
    <section v-if="engineAggregateRows.length" class="engine-metric-cards" data-testid="engine-aggregate-cards" aria-label="引擎完整归档汇总">
      <p class="scope-note">以下指标由完整已验证引擎归档流按已应用筛选聚合；不从当前保留的明细、曲线或时间线重算。来源 SHA-256：{{ engineArchive?.sourceSha256 }}。</p>
      <el-card v-for="row in engineAggregateRows" :key="row[0]" shadow="never" class="engine-metric-card"><h4>{{ row[0] }}</h4><p>{{ row[1] }}</p></el-card>
    </section>
    <el-form v-if="showFilters" inline class="report-filters" aria-label="报告明细筛选">
      <el-form-item label="节点"><el-select v-model="nodeId" clearable placeholder="全部节点" data-testid="report-filter-node"><el-option v-for="node in evidence.nodes" :key="node.platformId" :value="node.platformId" :label="node.name" /></el-select></el-form-item>
      <el-form-item v-if="isEventTab" label="通信关联"><el-select-v2 v-model="connectionId" :options="connectionOptions" clearable filterable placeholder="全部关联" data-testid="report-filter-link" /></el-form-item>
      <el-form-item v-if="isEventTab" label="开始时刻（秒）"><el-input-number v-model="from" :min="0" :max="evidence.endTimeS" data-testid="report-filter-from" /></el-form-item>
      <el-form-item v-if="isEventTab" label="结束时刻（秒）"><el-input-number v-model="to" :min="0" :max="evidence.endTimeS" data-testid="report-filter-to" /></el-form-item>
      <el-form-item><el-button @click="resetFilters">重置筛选</el-button></el-form-item>
    </el-form>
    <el-alert v-if="isEventTab && rangeError" type="error" title="开始时刻不得晚于结束时刻。" :closable="false" />
    <el-tabs v-model="activeTab">
      <el-tab-pane v-for="table in [tables[0]!, nodeTable, ...detailTables, tables[4]!, ...(evidence.detectionEvents?.length ? [detectionTable] : []), switchTable, ...tables.slice(7)]" :key="table.title" :label="table.title" :name="table.title" class="report-table-pane" lazy>
        <el-table class="report-data-table" :data="table.title === '通信关联登记' ? connectionRows : table.rows" stripe height="100%" :aria-label="table.title" :empty-text="['节点与位置', '通信关联登记', '设备与干扰请求', 'ESM 侦测事件'].includes(table.title) ? '暂无符合条件的数据' : '暂无数据'">
          <el-table-column v-for="(label, index) in table.columns" :key="index" :prop="String(index)" :label="label" min-width="140" />
        </el-table>
        <el-pagination
          v-if="table.title === '通信关联登记' && connections.length > 20"
          v-model:current-page="connectionPage"
          v-model:page-size="connectionPageSize"
          class="connection-pagination"
          data-testid="report-connection-pagination"
          :page-sizes="[20, 50, 100]"
          :total="connections.length"
          layout="sizes, prev, pager, next"
        />
      </el-tab-pane>
      <el-tab-pane label="链路质量与曲线" name="链路质量与曲线" lazy>
        <template v-if="qualityView && qualityView.samples.length">
          <p class="scope-note">数据源：{{ qualityView.dataset.source.fileName }} · SHA-256 {{ qualityView.dataset.source.sha256 }}；仅显示已导入的实际测量值。</p>
          <template v-for="series in qualityView.series" :key="series.linkId">
            <ReportChart :title="`GXB 随时间变化 · ${series.linkId}`" unit="dB" :rows="series.gxbCurve.map(point => ({ label: `${reportTime(point.time)}`, time: point.time, value: point.value, breakBefore: point.breakBefore }))" line :source-range="qualitySourceRange" :generated-time="generatedTime" />
            <ReportChart :title="`误码率随时间变化 · ${series.linkId}`" unit="BER" :rows="series.berCurve.map(point => ({ label: `${reportTime(point.time)}`, time: point.time, value: point.value, breakBefore: point.breakBefore }))" line :source-range="qualitySourceRange" :generated-time="generatedTime" />
          </template>
        </template>
        <el-empty v-else description="暂无数据" data-testid="report-quality-curves" />
      </el-tab-pane>
      <el-tab-pane label="引擎链路段实测" name="引擎链路段实测" lazy>
        <template v-if="engineArchive">
          <p class="scope-note">引擎帧归档 SHA-256：{{ engineArchive.sourceSha256 }}；帧 {{ engineArchive.frameCount }}；仿真时刻 {{ engineArchive.firstSimulationTime ?? '暂无' }}～{{ engineArchive.lastSimulationTime ?? '暂无' }} 秒。仅列出引擎实际给出的段指标，不合成为逻辑链路或规范质量样本。</p>
          <el-alert v-if="engineArchive.detailTruncated" type="warning" :closable="false" data-testid="engine-archive-truncated" :title="engineArchive.aggregate ? `归档明细不完整：报告仅保留 ${engineArchive.retainedDetailRows ?? '部分'} 条明细行；上方完整归档流汇总仍有效，但明细、明细曲线和时间线可能截断，请下载完整归档核对。` : `归档明细不完整：报告仅保留 ${engineArchive.retainedDetailRows ?? '部分'} 条明细行；明细、曲线和时间线不代表完整 JSONL，请下载完整归档核对。`" />
          <el-alert v-if="engineArchive.missingFieldNames.length" type="warning" :closable="false" :title="`缺少字段：${engineArchive.missingFieldNames.join('、')}；缺失值不以 0 补齐。`" />
          <el-descriptions v-if="engineCsv" :column="1" border class="local-report-sources" data-testid="engine-csv-status">
            <el-descriptions-item label="规范CSV来源">SHA-256 {{ engineCsv.sourceSha256 }}</el-descriptions-item>
            <el-descriptions-item v-for="file in engineCsv.files" :key="file.fileName" :label="file.fileName">{{ file.status }} · {{ file.rowCount }} 行{{ file.skippedCount ? `；跳过 ${file.skippedCount} 行：${file.reason ?? '字段缺失或歧义'}` : '' }}</el-descriptions-item>
            <el-descriptions-item v-for="file in engineCsv.missing" :key="file.fileName" :label="file.fileName">{{ file.status }} · {{ file.reason }}</el-descriptions-item>
          </el-descriptions>
          <el-table :data="engineSegmentRows" stripe height="280" aria-label="引擎链路段实测明细" empty-text="暂无接收到的链路段">
            <el-table-column label="轮次/帧/时刻" min-width="150"><template #default="{ row }">{{ row.engineEpoch }}/{{ row.frameId }}/{{ row.simulationTime }}</template></el-table-column>
            <el-table-column label="链路段" min-width="210"><template #default="{ row }">{{ row.segment.linkId }} · {{ row.segment.sourceName ?? '未提供' }}:{{ row.segment.sourcePort ?? '未提供' }} → {{ row.segment.targetName ?? '未提供' }}:{{ row.segment.targetPort ?? '未提供' }}</template></el-table-column>
            <el-table-column label="GXB dB" min-width="100"><template #default="{ row }">{{ row.segment.quality.gxbDb ?? '暂无' }}</template></el-table-column>
            <el-table-column label="BER" min-width="100"><template #default="{ row }">{{ row.segment.quality.ber ?? '暂无' }}</template></el-table-column>
            <el-table-column label="接收功率 dBm/dBW" min-width="140"><template #default="{ row }">{{ row.segment.quality.rxPowerDbm ?? '暂无' }} / {{ row.segment.quality.rxPowerDbw ?? '暂无' }}</template></el-table-column>
            <el-table-column label="总损耗 dB" min-width="110"><template #default="{ row }">{{ row.segment.losses.totalDb ?? '暂无' }}</template></el-table-column>
          </el-table>
          <el-pagination v-if="engineSegments.length > 50" v-model:current-page="engineSegmentPage" v-model:page-size="engineSegmentPageSize" class="connection-pagination" data-testid="engine-segment-pagination" :page-sizes="[50, 100]" :total="engineSegments.length" layout="sizes, prev, pager, next" />
          <template v-for="curve in engineCurves" :key="curve.identity">
            <ReportChart v-if="curve.rows.some(row => row.segment.quality.gxbDb !== null)" :title="`引擎段 GXB · ${curve.identity}`" unit="dB" :rows="curve.rows.filter(row => row.segment.quality.gxbDb !== null).map((row, index, rows) => ({ label: `${reportTime(row.simulationTime)} · 帧 ${row.frameId}`, time: row.simulationTime, value: row.segment.quality.gxbDb!, breakBefore: index > 0 && (row.frameId !== rows[index - 1]!.frameId + ENGINE_FRAME_ID_STEP) }))" line :source-range="`引擎帧归档 · SHA-256 ${engineArchive.sourceSha256}`" :generated-time="generatedTime" />
            <ReportChart v-if="curve.rows.some(row => row.segment.quality.ber !== null)" :title="`引擎段 BER · ${curve.identity}`" unit="BER" :rows="curve.rows.filter(row => row.segment.quality.ber !== null).map((row, index, rows) => ({ label: `${reportTime(row.simulationTime)} · 帧 ${row.frameId}`, time: row.simulationTime, value: row.segment.quality.ber!, breakBefore: index > 0 && (row.frameId !== rows[index - 1]!.frameId + ENGINE_FRAME_ID_STEP) }))" line :source-range="`引擎帧归档 · SHA-256 ${engineArchive.sourceSha256}`" :generated-time="generatedTime" />
          </template>
          <p class="scope-note">当前筛选下已保留引擎切换 {{ engineSwitches.length }} 条；已保留引擎事件 {{ engineEvents.length }} 条{{ engineArchive.detailTruncated ? '（非全量统计）' : '' }}。筛选仅按能够从原始段、路由或事件明确关联的字段执行。</p>
        </template>
        <template v-else-if="engineCsv">
          <el-descriptions :column="1" border class="local-report-sources" data-testid="engine-csv-status">
            <el-descriptions-item label="规范CSV来源">SHA-256 {{ engineCsv.sourceSha256 }}</el-descriptions-item>
            <el-descriptions-item v-for="file in engineCsv.files" :key="file.fileName" :label="file.fileName">{{ file.status }} · {{ file.rowCount }} 行{{ file.skippedCount ? `；跳过 ${file.skippedCount} 行：${file.reason ?? '字段缺失或歧义'}` : '' }}</el-descriptions-item>
            <el-descriptions-item v-for="file in engineCsv.missing" :key="file.fileName" :label="file.fileName">{{ file.status }} · {{ file.reason }}</el-descriptions-item>
          </el-descriptions>
          <el-empty description="暂无已归档的引擎帧" />
        </template>
        <el-empty v-else description="暂无已归档的引擎帧" />
      </el-tab-pane>
      <el-tab-pane label="柱状图" name="柱状图" lazy>
        <ReportChart data-testid="report-bar-charts" :title="preciseFilter ? '筛选范围事件记录数' : '完整快照事件记录数'" unit="条" :rows="bars" :source-range="barSourceRange" :generated-time="generatedTime" />
      </el-tab-pane>
      <el-tab-pane label="雷达图" name="雷达图" lazy>
        <div data-testid="report-radar-chart">
          <ReportChart v-if="qualityView && qualityView.samples.length" title="各链路有效观测区间连通率" unit="%" :rows="qualityConnectivityRates.map(row => ({ label: row.linkId, value: row.value }))" radar :source-range="qualitySourceRange" :generated-time="generatedTime" />
          <el-empty v-else description="暂无数据" />
        </div>
      </el-tab-pane>
      <el-tab-pane label="事件时间线" name="事件时间线" lazy>
        <el-timeline v-if="timeline.length" data-testid="report-event-timeline">
          <el-timeline-item v-for="event in timeline.slice((page - 1) * 50, page * 50)" :key="event.id" :timestamp="reportTime(event.time)"><strong>{{ event.text }}</strong> · {{ event.id }}<details v-if="event.detail"><summary>查看源字段明细</summary><p>{{ event.detail }}</p></details></el-timeline-item>
        </el-timeline>
        <p v-if="preciseFilter && timelineTotal > timeline.length" class="scope-note">运行日志时间线仅显示前 {{ timeline.length }} 条，共 {{ timelineTotal }} 条；已导入质量切换按同一筛选范围另行合并，导出使用同一来源。</p>
        <el-empty v-if="!timeline.length" description="暂无符合条件的数据" />
        <el-pagination v-if="timeline.length > 50" v-model:current-page="page" :page-size="50" :total="timeline.length" layout="prev, pager, next" />
      </el-tab-pane>
      <el-tab-pane label="已完成运行参数对比" name="已完成运行参数对比" class="report-table-pane" lazy>
        <el-table v-if="parameterRows.length" :data="parameterRows" stripe height="100%" data-testid="completed-result-parameter-comparison" empty-text="暂无数据">
          <el-table-column prop="resultId" label="运行结果" min-width="180" />
          <el-table-column prop="completedAt" label="完成时刻" min-width="170" />
          <el-table-column prop="revision" label="修订" width="80" />
          <el-table-column prop="platformCount" label="节点数" width="90" />
          <el-table-column prop="linkCount" label="链路数" width="90" />
          <el-table-column prop="jammerCount" label="干扰机数" width="100" />
          <el-table-column prop="links" label="链路参数（频率/带宽/功率）" min-width="280" />
          <el-table-column prop="jammers" label="干扰机参数（频率/带宽/默认功率）" min-width="280" />
        </el-table>
        <el-empty v-else description="当前历史快照未保存可比较参数" />
        <p class="scope-note">仅比较完成时冻结的已保存配置；当前输出未提供实测 BER、SNR、连通率或干扰效果，质量指标仍为暂无数据。</p>
      </el-tab-pane>
    </el-tabs>
  </section>
</template>

<style scoped>
.local-report { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.local-report-sources { margin: 12px 0; overflow-wrap: anywhere; }
.engine-metric-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin: 12px 0; }
.engine-metric-card h4 { margin: 0; font-size: 13px; color: var(--el-text-color-secondary); }
.engine-metric-card p { margin: 8px 0 0; font-size: 16px; font-weight: 600; }
.report-filters :deep(.el-select), .report-filters :deep(.el-select-v2) { width: 180px; }
.local-report :deep(.report-table-pane) { display: flex; flex-direction: column; min-height: 0; }
.report-data-table { flex: 1; min-height: 0; }
.connection-pagination { flex: 0 0 auto; padding-top: 12px; }
.scope-note { color: var(--el-text-color-secondary); font-size: 12px; text-align: center;}
</style>

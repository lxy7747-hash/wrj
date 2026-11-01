<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { LocalReportEvidence } from '../../contracts/domain-models'
import type { MissionResultParameterComparison } from '../../features/results/mission-result'
import { EVENT_LABELS, localReportTables, reportTime } from '../../features/reports/local-report'
import { qualityReportView } from '../../features/reports/quality-report'
import ReportChart from './ReportChart.vue'

const props = withDefaults(defineProps<{ evidence: LocalReportEvidence; comparison?: MissionResultParameterComparison[]; preciseFilter?: boolean; timeline?: Array<{ id: string; time: number; type: string; subject: string; target?: string }>; timelineTotal?: number }>(), { comparison: () => [], preciseFilter: false, timeline: () => [], timelineTotal: 0 })
const tables = computed(() => localReportTables(props.evidence))
const qualityView = computed(() => props.evidence.quality === undefined ? null : qualityReportView(props.evidence.quality, props.evidence))
const qualityConnectivityRates = computed(() => props.evidence.qualityConnectivityRates ?? qualityView.value?.connectivityRates ?? [])
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
const connectionRows = computed(() => detailTables.value[0]!.rows.slice(
  (connectionPage.value - 1) * connectionPageSize.value, connectionPage.value * connectionPageSize.value,
))
const timeline = computed(() => props.preciseFilter ? props.timeline.map(row => ({ id: row.id, time: row.time, text: `${EVENT_LABELS[row.type] ?? row.type} · ${nodeName(row.subject)}${row.target ? ` → ${nodeName(row.target)}` : ''}` })) : [
  ...connections.value.map(row => ({ id: row.eventId, time: row.time, text: `通信关联登记 · ${nodeName(row.sourcePlatformId)} → ${nodeName(row.targetPlatformId)}` })),
  ...deviceEvents.value.map(row => ({ id: row.eventId, time: row.time, text: `${EVENT_LABELS[row.type] ?? row.type} · ${nodeName(row.platformId)} · ${row.deviceId}` })),
  ...switches.value.map(row => ({ id: row.eventId, time: row.time, text: `链路切换 · ${row.demandId} · ${row.fromLinkId ?? row.fromDeviceId} → ${row.toLinkId ?? row.toDeviceId}` })),
].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)))
const bars = computed(() => props.evidence.eventCounts.map(row => ({ label: EVENT_LABELS[row.type] ?? row.type, value: row.count })))
const parameterRows = computed(() => props.comparison.map(({ record, parameters }) => ({
  resultId: record.resultId, completedAt: record.completedAt, revision: parameters.revision, platformCount: parameters.platformCount, linkCount: parameters.linkCount, jammerCount: parameters.jammerCount,
  links: parameters.links.map(link => `${link.id} ${link.type} ${link.frequencyMHz}MHz/${link.bandwidthMHz}MHz/${link.txPowerW}W`).join('； ') || '无',
  jammers: parameters.jammers.map(jammer => `${jammer.id} ${jammer.frequencyMHz}MHz/${jammer.bandwidthMHz}MHz/${jammer.defaultPowerW}W`).join('； ') || '无',
})))
function nodeName(id: string): string { return nodeNames.value.get(id) ?? id }
function resetFilters(): void { nodeId.value = ''; connectionId.value = ''; from.value = null; to.value = null; page.value = 1; connectionPage.value = 1 }
watch(() => props.evidence, resetFilters)
watch(nodeId, () => {
  if (connectionId.value && !availableConnections.value.some(row => row.eventId === connectionId.value)) connectionId.value = ''
})
watch([nodeId, connectionId, from, to], () => { page.value = 1; connectionPage.value = 1 })
watch(connectionPageSize, () => { connectionPage.value = 1 })
</script>

<template>
  <section class="local-report" data-testid="local-report" aria-label="本地运行数据报告">
    <p v-if="preciseFilter && timelineTotal > 0" class="scope-note">精确筛选的通信关联、设备事件和时间线每类最多展示前 500 条；事件分类统计覆盖全部匹配记录。</p>
    <el-alert v-if="evidence.positionIssueCount || evidence.eventWarningCount || evidence.waitingForPositionLine || !evidence.simulationComplete || evidence.messageDetailsComplete === false" type="warning" :closable="false" :title="evidence.messageDetailsComplete === false ? `当前大型事件来源的 ${evidence.messageDetailEventCount} 条消息已完整计入分类统计和来源摘要，但逐消息动画未装入本次回放快照。` : '当前来源存在警告、跳过记录、未完成行或未记录仿真结束；统计仅覆盖已解析快照，请核对汇总说明。'" />
    <el-descriptions :column="1" border class="local-report-sources">
      <el-descriptions-item label="事件来源">{{ evidence.eventFile.fileName }} · SHA-256 {{ evidence.eventFile.sha256 }}</el-descriptions-item>
      <el-descriptions-item label="位置来源">{{ evidence.positionFile.fileName }} · SHA-256 {{ evidence.positionFile.sha256 }}</el-descriptions-item>
    </el-descriptions>
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
          <ReportChart title="各链路有效观测区间连通率" unit="%" :rows="qualityConnectivityRates.map(row => ({ label: row.linkId, value: row.value }))" radar />
          <template v-for="series in qualityView.series" :key="series.linkId">
            <ReportChart :title="`GXB 随时间变化 · ${series.linkId}`" unit="dB" :rows="series.gxbCurve.map(point => ({ label: `${reportTime(point.time)}`, time: point.time, value: point.value, breakBefore: point.breakBefore }))" line />
            <ReportChart :title="`误码率随时间变化 · ${series.linkId}`" unit="BER" :rows="series.berCurve.map(point => ({ label: `${reportTime(point.time)}`, time: point.time, value: point.value, breakBefore: point.breakBefore }))" line />
          </template>
        </template>
        <el-empty v-else description="暂无数据" data-testid="report-quality-curves" />
      </el-tab-pane>
      <el-tab-pane label="柱状图" name="柱状图" lazy><ReportChart :title="preciseFilter ? '筛选范围事件记录数' : '完整快照事件记录数'" unit="条" :rows="bars" /></el-tab-pane>
      <el-tab-pane label="事件时间线" name="事件时间线" lazy>
        <el-timeline v-if="timeline.length" data-testid="report-event-timeline">
          <el-timeline-item v-for="event in timeline.slice((page - 1) * 50, page * 50)" :key="event.id" :timestamp="reportTime(event.time)">{{ event.text }} · {{ event.id }}</el-timeline-item>
        </el-timeline>
        <p v-if="preciseFilter && timelineTotal > timeline.length" class="scope-note">时间线仅显示前 {{ timeline.length }} 条，共 {{ timelineTotal }} 条；导出使用同一筛选范围。</p>
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
.report-filters :deep(.el-select), .report-filters :deep(.el-select-v2) { width: 180px; }
.local-report :deep(.report-table-pane) { display: flex; flex-direction: column; min-height: 0; }
.report-data-table { flex: 1; min-height: 0; }
.connection-pagination { flex: 0 0 auto; padding-top: 12px; }
.scope-note { color: var(--el-text-color-secondary); font-size: 12px; text-align: center;}
</style>

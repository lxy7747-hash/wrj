<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ReportChart from './ReportChart.vue'
import { reportTime } from '../../features/reports/local-report'
import type {
  BatchRunResult,
  DetectionEvent,
  Report,
  ReportKpis,
  ReportTimeSeriesPoint,
  SwitchEvent,
  TelemetryFrame,
} from '../../contracts/domain-models'
import { formatBer } from '../../features/situation/situation-model'
import { formatDateTime } from '../../features/shared/date-time'

const props = withDefaults(defineProps<{
  report: Report
  batchRuns?: BatchRunResult[]
  frame?: TelemetryFrame | null
  events?: Array<DetectionEvent | SwitchEvent>
}>(), { batchRuns: () => [], frame: null, events: () => [] })

const isBatch = computed(() => props.report.batchId !== undefined)
const batchRuns = computed(() => isBatch.value ? props.batchRuns : [])
const ordinaryFrame = computed(() => isBatch.value ? null : props.frame)
const node = ref('')
const linkId = ref('')
const from = ref<number | null>(null)
const to = ref<number | null>(null)
const nodes = computed(() => [...new Set((props.report.timeSeries ?? []).flatMap(row => [row.sourcePlatformId, row.targetPlatformId]).concat(ordinaryFrame.value?.platforms.map(row => row.platformId) ?? []))])
const rangeError = computed(() => from.value !== null && to.value !== null && from.value > to.value)
const inRange = (time: number) => !rangeError.value && (from.value === null || time >= from.value) && (to.value === null || time <= to.value)
const series = computed(() => (props.report.timeSeries ?? []).filter(row => (!node.value || [row.sourcePlatformId, row.targetPlatformId].includes(node.value)) && (!linkId.value || row.linkId === linkId.value))
  .map(row => ({ ...row, points: row.points.filter(point => inRange(point.time)) })).filter(row => row.points.length))
const summaries = computed(() => (ordinaryFrame.value?.linkSummaries ?? []).filter(row => (!node.value || [row.sourcePlatform, row.destPlatform].includes(node.value)) && inRange(row.updatedAt)
  && (!linkId.value || (props.report.timeSeries ?? []).some(link => link.linkId === linkId.value && link.sourcePlatformId === row.sourcePlatform && link.targetPlatformId === row.destPlatform))))
function clearFilters(): void { node.value = ''; linkId.value = ''; from.value = null; to.value = null }
watch(() => props.report.reportId, clearFilters)
const ordinarySwitchEvents = computed(() => isBatch.value
  ? []
  : props.events.filter((event): event is SwitchEvent => event.type === 'LINK_SWITCH' && inRange(event.time)
    && (!node.value || (props.report.timeSeries ?? []).some(link => [event.newLinkId, event.oldLinkId].includes(link.linkId) && [link.sourcePlatformId, link.targetPlatformId].includes(node.value)))
    && (!linkId.value || event.newLinkId === linkId.value || event.oldLinkId === linkId.value)))

/** 计算一组数值的平均值，并在空集合时返回 0。 */
function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

/** 从批量运行夹具生成聚合 KPI，避免混入单次 RUN-001 报告数据。 */
const kpis = computed<ReportKpis | null>(() => {
  if (!isBatch.value) return props.report.kpis ?? null
  const runs = batchRuns.value
  if (runs.length === 0) return null
  return {
    connectivityRate: Number(average(runs.map((run) => run.connectivityRate)).toFixed(2)),
    switchCount: runs.reduce((sum, run) => sum + run.switchCount, 0),
    avgBer: average(runs.map((run) => run.avgBer)),
    avgSnrDb: Number(average(runs.map((run) => run.avgSnrDb)).toFixed(2)),
    interferenceDurationS: runs.reduce((sum, run) => sum + run.interferenceDurationS, 0),
    avgConnectivityDurationS: Number(average(runs.map((run) => run.connectivityDurationS)).toFixed(2)),
    minSnrDb: Math.min(...runs.map((run) => run.minSnrDb)),
    maxBer: Math.max(...runs.map((run) => run.maxBer)),
  }
})

const sourceRange = computed(() => {
  if (isBatch.value) return `${props.report.batchId} · ${batchRuns.value.length} 次已加载运行`
  const times = (props.report.timeSeries ?? []).flatMap(row => row.points.map(point => point.time))
  if (times.length) return `${props.report.runId} · ${reportTime(Math.min(...times))}～${reportTime(Math.max(...times))}`
  return ordinaryFrame.value ? `${props.report.runId} · ${reportTime(ordinaryFrame.value.simulationTime)}` : '暂无数据'
})

type CurveMetric = 'snrDb' | 'ber' | 'interferencePowerDbm'
const CURVE_METRICS: readonly CurveMetric[] = ['snrDb', 'ber', 'interferencePowerDbm']

/** 将正式时序点按当前指标缩放为 SVG 折线坐标。 */
function curvePoints(points: ReportTimeSeriesPoint[], metric: CurveMetric): string {
  const values = points.map((point) => point[metric])
  const minimum = Math.min(...values)
  const span = Math.max(Number.EPSILON, Math.max(...values) - minimum)
  const startTime = points[0]?.time ?? 0
  const timeSpan = Math.max(Number.EPSILON, (points.at(-1)?.time ?? startTime) - startTime)
  return points.map((point) => {
    const x = 4 + (point.time - startTime) / timeSpan * 92
    const y = 92 - (point[metric] - minimum) / span * 84
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
}
</script>

<template>
  <section class="report-tabs" data-testid="report-tabs" :data-report-id="report.reportId">
    <header class="report-tabs__meta">
      <div><span>可用证据范围</span><strong>{{ sourceRange }}</strong></div>
      <div><span>数据来源</span><strong>{{ isBatch ? '批量聚合报告' : '单次仿真报告' }}</strong></div>
      <div><span>生成时刻</span><strong>{{ formatDateTime(report.generatedTime) }}</strong></div>
      <div><span>数据分级</span><strong>{{ report.classification === 'LEVEL_III' ? '三级' : '二级' }}</strong></div>
    </header>

    <el-form inline aria-label="质量报告筛选">
      <el-form-item label="节点"><el-select v-model="node" clearable style="width: 150px" placeholder="全部节点"><el-option v-for="id in nodes" :key="id" :value="id" :label="id" /></el-select></el-form-item>
      <el-form-item label="链路"><el-select v-model="linkId" clearable style="width: 150px" placeholder="全部链路"><el-option v-for="link in report.timeSeries ?? []" :key="link.linkId" :value="link.linkId" :label="link.linkId" /></el-select></el-form-item>
      <el-form-item label="起始时刻（秒）"><el-input-number v-model="from" :min="0" /></el-form-item><el-form-item label="结束时刻（秒）"><el-input-number v-model="to" :min="0" /></el-form-item>
      <el-form-item label="任务阶段"><el-select disabled placeholder="暂无数据" style="width: 140px" /></el-form-item><el-form-item><el-button @click="clearFilters">重置筛选</el-button></el-form-item>
    </el-form>
    <el-alert v-if="rangeError" title="开始时刻不得晚于结束时刻。" type="error" :closable="false" />
    <el-tabs class="report-tabs__body" data-testid="report-content-tabs">
      <el-tab-pane label="汇总" name="summary">
        <div v-if="kpis" class="report-kpis">
          <article><span>连通率</span><strong>{{ kpis.connectivityRate.toFixed(1) }}%</strong><small>单位：%</small></article>
          <article><span>平均 SNR</span><strong>{{ kpis.avgSnrDb.toFixed(2) }}</strong><small>单位：dB</small></article>
          <article><span>平均 BER</span><strong>{{ formatBer(kpis.avgBer) }}</strong><small>单位：比率</small></article>
          <article><span>切换次数</span><strong>{{ kpis.switchCount }}</strong><small>单位：次</small></article>
          <article><span>干扰持续时间</span><strong>{{ kpis.interferenceDurationS }}</strong><small>单位：s</small></article>
          <article><span>平均连通时长</span><strong>{{ kpis.avgConnectivityDurationS }}</strong><small>单位：s</small></article>
        </div>
        <el-empty v-else description="暂无数据" :image-size="72" />
      </el-tab-pane>

      <el-tab-pane label="分链路" name="links" class="report-table-pane">
        <el-table v-if="ordinaryFrame" :data="summaries" height="100%" stripe empty-text="暂无数据">
          <el-table-column prop="linkKey" label="链路" min-width="120" />
          <el-table-column prop="sourcePlatform" label="源节点" min-width="118" />
          <el-table-column prop="destPlatform" label="目标节点" min-width="118" />
          <el-table-column prop="linkType" label="体制" width="96" />
          <el-table-column label="SNR（dB）" width="110">
            <template #default="scope">{{ scope.row.currentSnr.toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="BER（比率）" width="120">
            <template #default="scope">{{ formatBer(scope.row.currentBer) }}</template>
          </el-table-column>
          <el-table-column prop="updatedAt" label="源时刻（s）" width="110" />
        </el-table>
        <el-empty v-else description="暂无数据" :image-size="72" />
      </el-tab-pane>

      <el-tab-pane label="干扰影响" name="interference" :class="{ 'report-table-pane': isBatch }">
        <el-descriptions v-if="ordinaryFrame" :column="3" border>
          <el-descriptions-item label="干扰设备">{{ ordinaryFrame.evidence.jammerExecution.jammerId }}</el-descriptions-item>
          <el-descriptions-item label="目标节点">{{ ordinaryFrame.evidence.jammerExecution.targetPlatformId }}</el-descriptions-item>
          <el-descriptions-item label="功率">{{ ordinaryFrame.evidence.jammerExecution.power }} W</el-descriptions-item>
          <el-descriptions-item label="频率">{{ ordinaryFrame.evidence.jammerExecution.frequency }} MHz</el-descriptions-item>
          <el-descriptions-item label="带宽">{{ ordinaryFrame.evidence.jammerExecution.bandwidth }} MHz</el-descriptions-item>
          <el-descriptions-item label="持续时间">{{ ordinaryFrame.evidence.jammerExecution.duration }} s</el-descriptions-item>
        </el-descriptions>
        <el-table v-else :data="batchRuns" height="100%" stripe empty-text="暂无数据">
          <el-table-column prop="runId" label="运行" min-width="110" />
          <el-table-column prop="powerW" label="功率（W）" width="110" />
          <el-table-column prop="distanceKm" label="距离（km）" width="120" />
          <el-table-column prop="interferenceDurationS" label="干扰时长（s）" min-width="130" />
          <el-table-column prop="connectivityRate" label="连通率（%）" width="120" />
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="切换事件" name="switches" class="report-table-pane">
        <el-table v-if="ordinaryFrame" :data="ordinarySwitchEvents" height="100%" stripe empty-text="暂无数据">
          <el-table-column prop="eventId" label="事件" min-width="110" />
          <el-table-column prop="oldLinkId" label="原链路" min-width="110" />
          <el-table-column prop="newLinkId" label="新链路" min-width="110" />
          <el-table-column prop="decision" label="决策" width="100" />
          <el-table-column prop="reason" label="原因" min-width="180" />
          <el-table-column prop="time" label="源时刻（s）" width="110" />
        </el-table>
        <el-table v-else :data="batchRuns" height="100%" stripe empty-text="暂无数据">
          <el-table-column prop="runId" label="运行" min-width="110" />
          <el-table-column prop="powerW" label="功率（W）" width="110" />
          <el-table-column prop="distanceKm" label="距离（km）" width="120" />
          <el-table-column prop="switchCount" label="切换次数（次）" min-width="130" />
          <el-table-column prop="status" label="状态" width="110" />
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="批量对比" name="batch" class="report-table-pane">
        <el-table v-if="isBatch" :data="batchRuns" height="100%" stripe empty-text="暂无数据" data-testid="batch-report-table">
          <el-table-column prop="runId" label="运行" min-width="105" />
          <el-table-column prop="reportId" label="报告" min-width="105" />
          <el-table-column prop="powerW" label="功率（W）" width="100" />
          <el-table-column prop="distanceKm" label="距离（km）" width="110" />
          <el-table-column prop="connectivityRate" label="连通率（%）" width="115" />
          <el-table-column label="平均 BER" width="115"><template #default="scope">{{ formatBer(scope.row.avgBer) }}</template></el-table-column>
          <el-table-column prop="avgSnrDb" label="平均 SNR（dB）" min-width="130" />
        </el-table>
        <el-empty v-else description="暂无数据" :image-size="72" />
      </el-tab-pane>

      <el-tab-pane label="时序曲线" name="timeline">
        <div v-if="series.length" class="report-series">
          <article v-for="series in series" :key="series.linkId" data-testid="report-time-series">
            <h4>{{ series.linkId }} · {{ series.sourcePlatformId }} → {{ series.targetPlatformId }}</h4>
            <div class="report-curves">
              <figure v-for="metric in CURVE_METRICS" :key="metric">
                <figcaption>{{ metric === 'snrDb' ? 'SNR（dB）' : metric === 'ber' ? 'BER（比率）' : '干扰功率（dBm）' }}</figcaption>
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" :aria-label="`${series.linkId} ${metric} 时序曲线`">
                  <path d="M4 8 V92 H96" class="report-curve__axis" />
                  <polyline :points="curvePoints(series.points, metric)" class="report-curve__line" />
                </svg>
                <small>{{ series.points[0]?.time }} s → {{ series.points.at(-1)?.time }} s</small>
              </figure>
            </div>
            <el-table :data="series.points" size="small" stripe data-testid="report-time-series-table">
              <el-table-column prop="time" label="仿真时刻（s）" />
              <el-table-column prop="snrDb" label="SNR（dB）" />
              <el-table-column label="BER（比率）"><template #default="scope">{{ formatBer(scope.row.ber) }}</template></el-table-column>
              <el-table-column prop="interferencePowerDbm" label="干扰功率（dBm）" />
            </el-table>
          </article>
        </div>
        <el-empty v-else description="暂无数据" :image-size="72" />
      </el-tab-pane>
      <el-tab-pane label="柱状图" lazy><ReportChart title="批次切换次数" unit="次" :rows="batchRuns.map(row => ({ label: row.runId, value: row.switchCount }))" /></el-tab-pane>
      <el-tab-pane label="雷达图" lazy><ReportChart title="批次连通率对比" unit="%" :rows="batchRuns.map(row => ({ label: row.runId, value: row.connectivityRate }))" radar /></el-tab-pane>
      <el-tab-pane label="事件时间线" lazy>
        <el-timeline v-if="ordinarySwitchEvents.length"><el-timeline-item v-for="event in ordinarySwitchEvents" :key="event.eventId" :timestamp="reportTime(event.time)">{{ event.oldLinkId }} → {{ event.newLinkId }} · {{ event.reason }} · {{ event.decision }}</el-timeline-item></el-timeline>
        <el-empty v-else description="暂无数据" />
      </el-tab-pane>
    </el-tabs>
  </section>
</template>

<style scoped>
.report-tabs {
  min-height: 0;
}

.report-tabs__meta {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.65rem;
  margin-bottom: 0.75rem;
}

.report-tabs__meta div,
.report-kpis article {
  display: grid;
  gap: 0.25rem;
  padding: 0.75rem;
  border: 1px solid var(--console-border);
  border-radius: 7px;
  background: rgba(11, 29, 45, 0.72);
}

.report-tabs__meta span,
.report-kpis span,
.report-kpis small {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.report-tabs__meta strong {
  overflow: hidden;
  color: var(--console-text);
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.report-kpis {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
}

.report-kpis strong {
  color: var(--console-cyan);
  font-family: Consolas, monospace;
  font-size: 1.4rem;
}

.report-series,
.report-series article {
  display: grid;
  gap: 0.75rem;
}

.report-series h4,
.report-curves figure {
  margin: 0;
}

.report-curves {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
}

.report-curves figure {
  padding: 0.75rem;
  border: 1px solid var(--console-border);
  border-radius: 7px;
  background: rgba(11, 29, 45, 0.72);
}

.report-curves svg {
  width: 100%;
  height: 8rem;
}

.report-curve__axis {
  fill: none;
  stroke: var(--console-border);
  stroke-width: 1;
}

.report-curve__line {
  fill: none;
  stroke: var(--console-cyan);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

.report-curves figcaption,
.report-curves small {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.report-tabs__body :deep(.el-tabs__item),
.report-tabs__body :deep(.el-table),
.report-tabs__body :deep(.el-descriptions) {
  font-size: 12px;
}

@media (max-width: 1000px) {
  .report-tabs__meta,
  .report-kpis,
  .report-curves {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

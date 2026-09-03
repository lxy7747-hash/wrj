<script setup lang="ts">
import { computed } from 'vue'
import type {
  BatchRunResult,
  DetectionEvent,
  Report,
  ReportKpis,
  SwitchEvent,
  TelemetryFrame,
} from '../../contracts/domain-models'
import { formatBer } from '../../features/situation/situation-model'
import fixtureSource from '../../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'

const props = defineProps<{ report: Report }>()

const fixture = fixtureSource as unknown as {
  frame: TelemetryFrame
  events: Array<DetectionEvent | SwitchEvent>
  batchRuns: BatchRunResult[]
}

const isBatch = computed(() => props.report.batchId !== undefined)
const batchRuns = computed(() => isBatch.value ? fixture.batchRuns : [])
const ordinaryFrame = computed(() => isBatch.value ? null : fixture.frame)
const ordinarySwitchEvents = computed(() => isBatch.value
  ? []
  : fixture.events.filter((event): event is SwitchEvent => event.type === 'LINK_SWITCH'))

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

const sourceRange = computed(() => isBatch.value
  ? `${props.report.batchId} · ${batchRuns.value.length} 次确定性运行`
  : `${props.report.runId} · T+0～7200 s`)
</script>

<template>
  <section class="report-tabs" data-testid="report-tabs" :data-report-id="report.reportId">
    <header class="report-tabs__meta">
      <div><span>统计范围</span><strong>{{ sourceRange }}</strong></div>
      <div><span>数据来源</span><strong>{{ isBatch ? '批量聚合报告' : '单次仿真报告' }}</strong></div>
      <div><span>生成时刻</span><strong>{{ report.generatedTime }}</strong></div>
      <div><span>数据分级</span><strong>{{ report.classification === 'LEVEL_III' ? '三级' : '二级' }}</strong></div>
    </header>

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
        <el-empty v-else description="当前报告没有汇总指标" :image-size="72" />
      </el-tab-pane>

      <el-tab-pane label="分链路" name="links">
        <el-table v-if="ordinaryFrame" :data="ordinaryFrame.linkSummaries" height="350" stripe>
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
        <el-empty v-else description="批量聚合报告不包含单链路明细" :image-size="72" />
      </el-tab-pane>

      <el-tab-pane label="干扰影响" name="interference">
        <el-descriptions v-if="ordinaryFrame" :column="3" border>
          <el-descriptions-item label="干扰设备">{{ ordinaryFrame.evidence.jammerExecution.jammerId }}</el-descriptions-item>
          <el-descriptions-item label="目标节点">{{ ordinaryFrame.evidence.jammerExecution.targetPlatformId }}</el-descriptions-item>
          <el-descriptions-item label="功率">{{ ordinaryFrame.evidence.jammerExecution.power }} W</el-descriptions-item>
          <el-descriptions-item label="频率">{{ ordinaryFrame.evidence.jammerExecution.frequency }} MHz</el-descriptions-item>
          <el-descriptions-item label="带宽">{{ ordinaryFrame.evidence.jammerExecution.bandwidth }} MHz</el-descriptions-item>
          <el-descriptions-item label="持续时间">{{ ordinaryFrame.evidence.jammerExecution.duration }} s</el-descriptions-item>
        </el-descriptions>
        <el-table v-else :data="batchRuns" height="350" stripe>
          <el-table-column prop="runId" label="运行" min-width="110" />
          <el-table-column prop="powerW" label="功率（W）" width="110" />
          <el-table-column prop="distanceKm" label="距离（km）" width="120" />
          <el-table-column prop="interferenceDurationS" label="干扰时长（s）" min-width="130" />
          <el-table-column prop="connectivityRate" label="连通率（%）" width="120" />
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="切换事件" name="switches">
        <el-table v-if="ordinaryFrame" :data="ordinarySwitchEvents" height="350" stripe>
          <el-table-column prop="eventId" label="事件" min-width="110" />
          <el-table-column prop="oldLinkId" label="原链路" min-width="110" />
          <el-table-column prop="newLinkId" label="新链路" min-width="110" />
          <el-table-column prop="decision" label="决策" width="100" />
          <el-table-column prop="reason" label="原因" min-width="180" />
          <el-table-column prop="time" label="源时刻（s）" width="110" />
        </el-table>
        <el-table v-else :data="batchRuns" height="350" stripe>
          <el-table-column prop="runId" label="运行" min-width="110" />
          <el-table-column prop="powerW" label="功率（W）" width="110" />
          <el-table-column prop="distanceKm" label="距离（km）" width="120" />
          <el-table-column prop="switchCount" label="切换次数（次）" min-width="130" />
          <el-table-column prop="status" label="状态" width="110" />
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="批量对比" name="batch">
        <el-table v-if="isBatch" :data="batchRuns" height="350" stripe data-testid="batch-report-table">
          <el-table-column prop="runId" label="运行" min-width="105" />
          <el-table-column prop="reportId" label="报告" min-width="105" />
          <el-table-column prop="powerW" label="功率（W）" width="100" />
          <el-table-column prop="distanceKm" label="距离（km）" width="110" />
          <el-table-column prop="connectivityRate" label="连通率（%）" width="115" />
          <el-table-column label="平均 BER" width="115"><template #default="scope">{{ formatBer(scope.row.avgBer) }}</template></el-table-column>
          <el-table-column prop="avgSnrDb" label="平均 SNR（dB）" min-width="130" />
        </el-table>
        <el-empty v-else description="当前为单次仿真报告，无批量参数组合" :image-size="72" />
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

.report-tabs__body :deep(.el-tabs__item),
.report-tabs__body :deep(.el-table),
.report-tabs__body :deep(.el-descriptions) {
  font-size: 12px;
}

@media (max-width: 1000px) {
  .report-tabs__meta,
  .report-kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'
import ReportTabs from '../../components/reports/ReportTabs.vue'
import LocalReportTabs from '../../components/reports/LocalReportTabs.vue'
import MissionResults from '../../components/situation/MissionResults.vue'
import { ElMessage } from 'element-plus'
import type { LocalReportFilter, ReportExportRequest } from '../../contracts/domain-models'
import { useReportStore } from '../../stores/report'
import { useTelemetryStore } from '../../stores/telemetry'
import { formatDateTime } from '../../features/shared/date-time'

const reportStore = useReportStore()
const telemetryStore = useTelemetryStore()
const route = useRoute()
const archiveId = computed(() => typeof route.query.archiveId === 'string' ? route.query.archiveId : undefined)
const resultId = computed(() => typeof route.query.resultId === 'string' ? route.query.resultId : undefined)
const { reports, selectedReport, capabilityState, resultMessage, exportResult, resultComparisons, localFilterResult, resultSource } = storeToRefs(reportStore)
const exportFormat = ref<ReportExportRequest['format']>('HTML')
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(capabilityState.value))
const filterNode = ref(''), filterLink = ref(''), filterStage = ref(''), filterFrom = ref<number | null>(null), filterTo = ref<number | null>(null)
const filterRangeError = computed(() => filterFrom.value !== null && filterTo.value !== null && filterFrom.value > filterTo.value)
const localEvidence = computed(() => localFilterResult.value?.report.localEvidence ?? selectedReport.value?.localEvidence)
const appliedFilterLabel = computed(() => {
  const filter = localFilterResult.value?.filter
  return filter && Object.keys(filter).length ? [filter.nodeId && `节点 ${filter.nodeId}`, filter.linkId && `链路 ${filter.linkId}`,
    filter.stage && `阶段 ${filter.stage}`,
    (filter.from !== undefined || filter.to !== undefined) && `${filter.from ?? selectedReport.value?.localEvidence?.startTimeS}～${filter.to ?? selectedReport.value?.localEvidence?.endTimeS} 秒`].filter(Boolean).join('；') : '全部数据'
})
function clearFilterInputs(): void { filterNode.value = ''; filterLink.value = ''; filterStage.value = ''; filterFrom.value = null; filterTo.value = null }

/** 加载当前报告所引用的遥测证据。 */
async function loadEvidence(): Promise<void> {
  const report = selectedReport.value
  if (report?.localEvidence) {
    telemetryStore.resetToSafeEmpty()
    exportFormat.value = 'HTML'
    clearFilterInputs()
    if (resultSource.value) await reportStore.applyLocalFilter({})
    return
  }
  if (report?.runId !== undefined) {
    await telemetryStore.loadFrame(report.runId, 'F-00042')
  }
}

onMounted(async () => {
  if (archiveId.value !== undefined || resultId.value !== undefined) { await reload(); return }
  const requestedReportId = typeof route.query.reportId === 'string' ? route.query.reportId : undefined
  if (await reportStore.load(requestedReportId)) await loadEvidence()
})
watch([archiveId, resultId], () => { void reload() })
onBeforeUnmount(() => {
  reportStore.resetToSafeEmpty()
  telemetryStore.resetToSafeEmpty()
})

/**
 * 切换当前报告来源。
 * @param reportId 报告目录中选中的编号。
 * @returns 报告加载完成后兑现且不返回值。
 * @sideEffects 通过 reportStore 原子替换当前报告，并清除上一来源的导出状态。
 */
async function changeReport(reportId: string): Promise<void> {
  if (await reportStore.selectReport(reportId)) await loadEvidence()
}

async function reload(): Promise<void> {
  if (resultId.value !== undefined) {
    if (archiveId.value !== undefined) { reportStore.resetToSafeEmpty(); reportStore.showError(undefined, '不能同时选择归档和运行结果。'); return }
    if (await reportStore.loadResult(resultId.value)) await loadEvidence()
    return
  }
  if (await (archiveId.value === undefined ? reportStore.load() : reportStore.loadArchive(archiveId.value))) await loadEvidence()
}

/** 发起当前格式的导出，由服务端区分真实文件与纯 Mock 验证。 */
async function requestExport(): Promise<void> {
  const local = !!reportStore.selectedReport?.localEvidence
  const ok = await reportStore.requestExport(exportFormat.value)
  if (local) { if (ok) ElMessage.success(reportStore.resultMessage); else ElMessage.error(reportStore.resultMessage) }
}

async function applyLocalFilter(reset = false): Promise<void> {
  if (!resultSource.value || (!reset && filterRangeError.value)) return
  if (reset) clearFilterInputs()
  const filter: LocalReportFilter = { ...(filterNode.value ? { nodeId: filterNode.value } : {}), ...(filterLink.value ? { linkId: filterLink.value } : {}), ...(filterStage.value ? { stage: filterStage.value } : {}), ...(filterFrom.value === null ? {} : { from: filterFrom.value }), ...(filterTo.value === null ? {} : { to: filterTo.value }) }
  await reportStore.applyLocalFilter(filter)
}

</script>

<template>
  <section class="reports-page" aria-label="评估报表">
    <div>
    <MissionResults view="report" />
    <p v-if="!archiveId && !resultId">当前查看配置文件报告；可在上方选择一次已完成的仿真。</p>
    <header class="reports-page__header">
      <div class="reports-page__actions">
        <el-select
          :model-value="selectedReport?.reportId ?? ''"
          aria-label="报告来源"
          data-testid="report-source"
          :disabled="pending || reports.length === 0"
          placeholder="选择报告"
          @update:model-value="changeReport"
        >
          <el-option
            v-for="report in reports"
            :key="report.reportId"
            :value="report.reportId"
            :label="report.localEvidence ? `本地文件报告 · ${report.reportId.slice(-12)}` : `${report.reportId} · 单次仿真`"
          />
        </el-select>
        <el-select v-model="exportFormat" aria-label="导出格式" :disabled="pending || selectedReport === null">
          <el-option value="HTML" label="HTML" />
          <el-option value="PDF" label="PDF" />
          <el-option value="CSV" label="CSV" />
        </el-select>
        <el-button
          type="primary"
          data-testid="report-export"
          :loading="capabilityState === 'EXECUTING'"
          :disabled="pending || selectedReport === null"
          @click="requestExport"
        >{{ selectedReport?.localEvidence ? (appliedFilterLabel === '全部数据' ? '导出完整报告' : '导出筛选报告') : '验证导出' }}</el-button>
        <el-button :disabled="pending" @click="reload">重新加载</el-button>
      </div>
    </header>
    </div>

    <main class="reports-page__content">
      <p v-if="archiveId" data-testid="report-archive-source">归档：{{ archiveId }} · 未绑定场景或运行</p>
      <p v-if="selectedReport?.localEvidence">报告编号：{{ selectedReport.reportId }} · 统计生成：{{ formatDateTime(selectedReport.generatedTime) }}</p>
      <el-skeleton v-if="capabilityState === 'LOADING' || capabilityState === 'VALIDATING'" :rows="8" animated />
      <template v-else-if="selectedReport?.localEvidence">
        <el-alert v-if="resultSource && (capabilityState === 'ERROR' || !localFilterResult)" type="warning" :closable="false" :title="resultMessage || '该历史结果没有完整筛选索引，请重新生成结果。'" />
        <p v-if="resultSource" data-testid="report-applied-filter">当前图表与导出范围：{{ appliedFilterLabel }}</p>
        <el-form v-if="resultSource" inline class="local-report-filter" aria-label="报告统一筛选">
          <el-form-item label="节点"><el-select v-model="filterNode" clearable style="width: 160px" placeholder="全部节点"><el-option v-for="node in selectedReport.localEvidence.nodes" :key="node.platformId" :value="node.platformId" :label="node.name" /></el-select></el-form-item>
          <el-form-item label="链路"><el-select v-model="filterLink" clearable style="width: 180px" :disabled="!localFilterResult" placeholder="全部链路"><el-option v-for="link in localFilterResult?.links ?? []" :key="link" :value="link" :label="link" /></el-select></el-form-item>
          <el-form-item label="任务阶段"><el-select v-model="filterStage" clearable :disabled="!localFilterResult?.stages.length" style="width: 220px" :placeholder="localFilterResult?.stages.length ? '全部阶段' : '本次运行未设置任务阶段'"><el-option v-for="stage in localFilterResult?.stages ?? []" :key="stage" :label="stage" :value="stage" /></el-select></el-form-item>
          <el-form-item label="开始时刻（秒）"><el-input-number v-model="filterFrom" :min="0" :max="selectedReport.localEvidence.endTimeS" /></el-form-item><el-form-item label="结束时刻（秒）"><el-input-number v-model="filterTo" :min="0" :max="selectedReport.localEvidence.endTimeS" /></el-form-item>
          <el-form-item><el-button type="primary" :disabled="filterRangeError || !localFilterResult" @click="applyLocalFilter()">应用精确筛选</el-button><el-button :disabled="!localFilterResult" @click="applyLocalFilter(true)">重置</el-button></el-form-item>
        </el-form>
        <el-alert v-if="filterRangeError" type="error" :closable="false" title="开始时刻不得晚于结束时刻。" />
        <LocalReportTabs :evidence="localEvidence!" :generated-time="localFilterResult?.report.generatedTime ?? selectedReport.generatedTime" :filter="localFilterResult?.filter" :comparison="resultComparisons" :precise-filter="!!resultSource" :timeline="localFilterResult?.timeline" :timeline-total="localFilterResult?.timelineTotal" />
      </template>
      <ReportTabs
        v-else-if="selectedReport"
        :report="selectedReport"
        :frame="telemetryStore.frame"
        :events="telemetryStore.events"
      />
      <el-result v-else-if="capabilityState === 'ERROR'" icon="error" title="报告加载失败" :sub-title="resultMessage">
        <template #extra><el-button type="primary" @click="reload">重新加载</el-button></template>
      </el-result>
      <el-empty v-else description="暂无可用报告" />
    </main>

    <el-alert
      v-if="exportResult"
      class="reports-page__export-result"
      type="success"
      show-icon
      :closable="false"
      :title="`${exportResult.watermark} · 验证时刻 ${formatDateTime(exportResult.verifiedAt)}`"
    />
    <el-descriptions v-if="exportResult?.generated" :column="1" border data-testid="local-report-export-result">
      <el-descriptions-item label="文件保存路径">{{ exportResult.filePath }}</el-descriptions-item>
      <el-descriptions-item label="格式">{{ exportResult.format }}</el-descriptions-item>
      <el-descriptions-item label="文件 SHA-256">{{ exportResult.sha256 }}</el-descriptions-item>
    </el-descriptions>

  </section>
</template>

<style scoped>
.reports-page {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  gap: 0.75rem;
  padding: 1rem;
  overflow: hidden;
  color: var(--console-text);
  background: var(--console-bg-elevated);
}

.reports-page__header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 0.85rem;
  border-bottom: 1px solid var(--console-border);
}

.reports-page__header span {
  color: var(--console-cyan);
  font-size: var(--console-font-size-min);
}

.reports-page__header h2 {
  margin: 0.15rem 0 0;
  font-size: 1.25rem;
}

.reports-page__header p {
  margin: 0.3rem 0 0;
  color: var(--console-text-muted);
  font-size: 12px;
}

.reports-page__actions{
  display: flex;
  flex-wrap: wrap;
  min-width: 0;
  align-items: center;
  gap: 0.6rem;
}

.reports-page__actions :deep(.el-select:first-child) {
  width: 15rem;
}

.reports-page__actions :deep(.el-select:nth-child(2)) {
  width: 7rem;
}

.reports-page__content {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  padding: 0.85rem;
  border: 1px solid var(--console-border);
  border-radius: 8px;
  background: rgba(7, 23, 37, 0.82);
}

.reports-page__content :deep(.el-tabs),
.reports-page__content :deep(.el-tabs__content),
.reports-page__content :deep(.el-tab-pane) {
  min-width: 0;
  max-width: 100%;
}

.reports-page__content > p {
  flex: 0 0 auto;
}

.reports-page__content :deep(.local-report),
.reports-page__content :deep(.report-tabs) {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.reports-page__content :deep(.local-report > :not(.el-tabs)),
.reports-page__content :deep(.report-tabs > :not(.el-tabs)) {
  flex: 0 0 auto;
}

.reports-page__content :deep(.el-tabs) {
  flex: 1;
  min-height: 0;
}

.reports-page__content :deep(.el-tabs__header) {
  flex: 0 0 auto;
}

.reports-page__content :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.reports-page__content :deep(.el-tab-pane) {
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
}

.reports-page__content :deep(.report-table-pane) {
  overflow: hidden;
}

.reports-page__export-result {
  flex: 0 0 auto;
}

@media (max-width: 900px) {
  .reports-page__header {
    align-items: stretch;
    flex-direction: column;
  }

  .reports-page__actions {
    flex-wrap: wrap;
  }
}
</style>

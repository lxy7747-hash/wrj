<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'
import ReportTabs from '../../components/reports/ReportTabs.vue'
import type { ReportExportRequest } from '../../contracts/domain-models'
import { useBatchStore } from '../../stores/batch'
import { useReportStore } from '../../stores/report'
import { useTelemetryStore } from '../../stores/telemetry'

const reportStore = useReportStore()
const batchStore = useBatchStore()
const telemetryStore = useTelemetryStore()
const route = useRoute()
const { reports, selectedReport, capabilityState, resultMessage, confirmation, exportResult } = storeToRefs(reportStore)
const exportFormat = ref<ReportExportRequest['format']>('HTML')
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(capabilityState.value))

/** 加载当前报告所引用的正式批次或遥测证据。 */
async function loadEvidence(): Promise<void> {
  const report = selectedReport.value
  if (report?.batchId !== undefined) {
    telemetryStore.resetToSafeEmpty()
    await batchStore.loadComparison(report.batchId)
  } else if (report?.runId !== undefined) {
    batchStore.resetToSafeEmpty()
    await telemetryStore.loadFrame(report.runId, 'F-00042')
  }
}

onMounted(async () => {
  const requestedReportId = typeof route.query.reportId === 'string' ? route.query.reportId : undefined
  if (await reportStore.load(requestedReportId)) await loadEvidence()
})
onBeforeUnmount(() => {
  reportStore.resetToSafeEmpty()
  batchStore.resetToSafeEmpty()
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

/** 发起当前格式的无文件导出验证。 */
async function requestExport(): Promise<void> {
  await reportStore.requestExport(exportFormat.value)
}

/** 完成三级批量报告的一次性确认和导出验证。 */
async function confirmExport(): Promise<void> {
  await reportStore.confirmExport()
}
</script>

<template>
  <section class="reports-page" aria-label="报告分析">
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
            :label="report.runId ? `${report.reportId} · 单次仿真` : `${report.reportId} · 批量聚合`"
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
        >验证导出</el-button>
      </div>
    </header>

    <main class="reports-page__content">
      <el-skeleton v-if="capabilityState === 'LOADING' || capabilityState === 'VALIDATING'" :rows="8" animated />
      <ReportTabs
        v-else-if="selectedReport"
        :report="selectedReport"
        :batch-runs="batchStore.runs"
        :frame="telemetryStore.frame"
        :events="telemetryStore.events"
      />
      <el-result v-else-if="capabilityState === 'ERROR'" icon="error" title="报告加载失败" :sub-title="resultMessage">
        <template #extra><el-button type="primary" @click="reportStore.load()">重新加载</el-button></template>
      </el-result>
      <el-empty v-else description="暂无可用报告" />
    </main>

    <el-alert
      v-if="exportResult"
      class="reports-page__export-result"
      type="success"
      show-icon
      :closable="false"
      :title="`${exportResult.watermark} · 验证时刻 ${exportResult.verifiedAt}`"
    />

    <el-dialog
      :model-value="confirmation !== null"
      title="确认验证三级批量报告导出"
      width="min(28rem, calc(100vw - 2rem))"
      :close-on-click-modal="false"
      @update:model-value="!$event && reportStore.cancelConfirmation()"
    >
      <p>当前报告属于三级数据。确认后仅验证导出权限、格式和水印，不会生成或下载文件。</p>
      <template #footer>
        <el-button :disabled="pending" @click="reportStore.cancelConfirmation()">取消</el-button>
        <el-button type="primary" data-testid="confirm-report-export" :loading="pending" @click="confirmExport">确认验证</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.reports-page {
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  gap: 0.75rem;
  padding: 1rem;
  overflow: auto;
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
  min-height: 0;
  padding: 0.85rem;
  border: 1px solid var(--console-border);
  border-radius: 8px;
  background: rgba(7, 23, 37, 0.82);
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

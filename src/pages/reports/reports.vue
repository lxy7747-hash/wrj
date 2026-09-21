<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'
import ReportTabs from '../../components/reports/ReportTabs.vue'
import LocalReportTabs from '../../components/reports/LocalReportTabs.vue'
import type { ReportExportRequest } from '../../contracts/domain-models'
import { useBatchStore } from '../../stores/batch'
import { useReportStore } from '../../stores/report'
import { useAuthStore } from '../../stores/auth'
import { useTelemetryStore } from '../../stores/telemetry'
import { formatDateTime } from '../../features/shared/date-time'

const reportStore = useReportStore()
const authStore = useAuthStore()
const canPrint = computed(() => authStore.principal !== null && authStore.permissions.includes('ORDINARY_REPORT_EXPORT'))
const batchStore = useBatchStore()
const telemetryStore = useTelemetryStore()
const route = useRoute()
const archiveId = computed(() => typeof route.query.archiveId === 'string' ? route.query.archiveId : undefined)
const { reports, selectedReport, capabilityState, resultMessage, confirmation, exportResult } = storeToRefs(reportStore)
const exportFormat = ref<ReportExportRequest['format']>('HTML')
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(capabilityState.value))

/** 加载当前报告所引用的正式批次或遥测证据。 */
async function loadEvidence(): Promise<void> {
  const report = selectedReport.value
  if (report?.localEvidence) {
    telemetryStore.resetToSafeEmpty()
    batchStore.resetToSafeEmpty()
    exportFormat.value = 'HTML'
    return
  }
  if (report?.batchId !== undefined) {
    telemetryStore.resetToSafeEmpty()
    await batchStore.loadComparison(report.batchId)
  } else if (report?.runId !== undefined) {
    batchStore.resetToSafeEmpty()
    await telemetryStore.loadFrame(report.runId, 'F-00042')
  }
}

onMounted(async () => {
  if (archiveId.value !== undefined) { await reload(); return }
  const requestedReportId = typeof route.query.reportId === 'string' ? route.query.reportId : undefined
  if (await reportStore.load(requestedReportId)) await loadEvidence()
})
watch(archiveId, () => { void reload() })
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

async function reload(): Promise<void> {
  if (await (archiveId.value === undefined ? reportStore.load() : reportStore.loadArchive(archiveId.value))) await loadEvidence()
}

/** 发起当前格式的导出，由服务端区分真实文件与纯 Mock 验证。 */
async function requestExport(): Promise<void> {
  await reportStore.requestExport(exportFormat.value)
}

/** 完成三级批量报告的一次性确认和导出验证。 */
async function confirmExport(): Promise<void> {
  await reportStore.confirmExport()
}

/** 使用浏览器打印当前真实报告视图，不声称服务端已生成 PDF 文件。 */
function printReport(): void {
  if (!pending.value && canPrint.value && selectedReport.value?.localEvidence) window.print()
}
</script>

<template>
  <section class="reports-page" aria-label="评估报表">
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
            :label="report.localEvidence ? `本地文件报告 · ${report.reportId.slice(-12)}` : report.runId ? `${report.reportId} · 单次仿真` : `${report.reportId} · 批量聚合`"
          />
        </el-select>
        <el-select v-model="exportFormat" aria-label="导出格式" :disabled="pending || selectedReport === null">
          <el-option value="HTML" label="HTML" />
          <el-option v-if="!selectedReport?.localEvidence" value="PDF" label="PDF" />
          <el-option value="CSV" label="CSV" />
        </el-select>
        <el-button
          type="primary"
          data-testid="report-export"
          :loading="capabilityState === 'EXECUTING'"
          :disabled="pending || selectedReport === null"
          @click="requestExport"
        >{{ selectedReport?.localEvidence ? '导出完整报告' : '验证导出' }}</el-button>
        <el-button :disabled="pending" @click="reload">重新加载</el-button>
        <el-button v-if="selectedReport?.localEvidence" :disabled="pending || !canPrint" data-testid="report-print-pdf" @click="printReport">打印当前视图／另存 PDF</el-button>
      </div>
    </header>

    <main class="reports-page__content">
      <p v-if="archiveId" data-testid="report-archive-source">归档：{{ archiveId }} · 未绑定场景或运行</p>
      <p v-if="selectedReport?.localEvidence">报告编号：{{ selectedReport.reportId }} · 统计生成：{{ formatDateTime(selectedReport.generatedTime) }}</p>
      <el-skeleton v-if="capabilityState === 'LOADING' || capabilityState === 'VALIDATING'" :rows="8" animated />
      <LocalReportTabs v-else-if="selectedReport?.localEvidence" :evidence="selectedReport.localEvidence" />
      <ReportTabs
        v-else-if="selectedReport"
        :report="selectedReport"
        :batch-runs="batchStore.runs"
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

<style>
@media print {
  body * { visibility: hidden; }
  .reports-page, .reports-page * { visibility: visible; }
  .reports-page { position: absolute; inset: 0; height: auto !important; overflow: visible !important; background: white !important; color: black !important; --console-text: #111; --console-text-muted: #444; --console-cyan: #087f9c; --console-border: #ccc; --el-text-color-primary: #111; --el-text-color-regular: #111; --el-text-color-secondary: #444; --el-fill-color-blank: white; --el-bg-color: white; }
  .reports-page__header, .reports-page .el-tabs__header, .reports-page .report-filters, .reports-page .el-pagination { display: none !important; }
  .reports-page .el-scrollbar__wrap { max-height: none !important; overflow: visible !important; }
  .reports-page .el-table, .reports-page .el-table__inner-wrapper, .reports-page .el-table__body-wrapper, .reports-page .el-scrollbar, .reports-page .el-scrollbar__wrap { height: auto !important; max-height: none !important; }
  .reports-page .reports-page__content { border: 0; background: white !important; }
  .reports-page .reports-page__content, .reports-page .local-report, .reports-page .report-tabs, .reports-page .el-tabs, .reports-page .el-tabs__content, .reports-page .el-tab-pane { height: auto !important; overflow: visible !important; flex: none !important; }
}
</style>

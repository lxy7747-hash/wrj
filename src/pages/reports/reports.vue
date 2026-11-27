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
import { reportLinkLabel } from '../../features/reports/report-link-label'
import { formatDateTime } from '../../features/shared/date-time'
import { apiFetch } from '../../features/shared/api-fetch'
import { saveDownload } from '../../features/shared/download'
import { resolveMockOrigin, useAuthStore } from '../../stores/auth'

const reportStore = useReportStore()
const auth = useAuthStore()
const telemetryStore = useTelemetryStore()
const route = useRoute()
const archiveId = computed(() => typeof route.query.archiveId === 'string' ? route.query.archiveId : undefined)
const resultId = computed(() => typeof route.query.resultId === 'string' ? route.query.resultId : undefined)
const { reports, selectedReport, capabilityState, resultMessage, exportResult, resultComparisons, localFilterResult, resultSource } = storeToRefs(reportStore)
const exportFormat = ref<ReportExportRequest['format']>('HTML')
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(capabilityState.value))
const localFilterPending = computed(() => capabilityState.value === 'LOADING' && !!resultSource.value && !!localFilterResult.value)
const filterNode = ref(''), filterLink = ref(''), filterFrom = ref<number | null>(null), filterTo = ref<number | null>(null)
const evidenceSeriesId = ref('')
const filterRangeError = computed(() => filterFrom.value !== null && filterTo.value !== null && filterFrom.value > filterTo.value)
const localEvidence = computed(() => localFilterResult.value?.report.localEvidence ?? selectedReport.value?.localEvidence)
const engineArchive = computed(() => localEvidence.value?.engineFrameArchive)
const engineCsv = computed(() => localEvidence.value?.engineCsv)
const engineArchiveDownloading = ref(false)
const engineCsvDownloading = ref<string | null>(null)
const hasQualityEvidence = computed(() => Boolean(
  resultSource.value && reportStore.evidenceOverview?.selectedSourceSha256
  && ((reportStore.evidenceOverview.series?.length ?? 0) > 0 || reportStore.evidenceSeries),
))
function handleDataExportCommand(command: string): void {
  if (command === 'summary-csv') { void requestExport('CSV'); return }
  if (command === 'engine-frames') { void downloadEngineFrames(); return }
  if (command.startsWith('csv:')) void downloadEngineCsv(command.slice(4))
}
const filterLinkOptions = computed(() => {
  const currentLinks = resultComparisons.value.find(row => row.record.resultId === resultSource.value?.resultId)?.parameters.links
  const types = new Map(currentLinks?.map(link => [link.id, link.type]))
  const options = (localFilterResult.value?.links ?? []).map((value, index) => ({ value, label: reportLinkLabel(value, index, types.get(value)) }))
  const counts = new Map<string, number>()
  for (const { label } of options) counts.set(label, (counts.get(label) ?? 0) + 1)
  return options.map((option, index) => (counts.get(option.label) ?? 0) > 1
    ? { ...option, label: `${option.label}（第 ${index + 1} 条）` } : option)
})
const appliedFilterLabel = computed(() => {
  const filter = localFilterResult.value?.filter
  return filter && Object.keys(filter).length ? [filter.nodeId && `节点 ${filter.nodeId}`, filter.linkId && (filterLinkOptions.value.find(link => link.value === filter.linkId)?.label ?? '指定链路'),
    (filter.from !== undefined || filter.to !== undefined) && `${filter.from ?? selectedReport.value?.localEvidence?.startTimeS}～${filter.to ?? selectedReport.value?.localEvidence?.endTimeS} 秒`].filter(Boolean).join('；') : '全部数据'
})
function clearFilterInputs(): void { filterNode.value = ''; filterLink.value = ''; filterFrom.value = null; filterTo.value = null }

/** 证据一律使用“已应用筛选”（localFilterResult.filter），不使用未提交表单。 */
const appliedEvidenceFilter = (): LocalReportFilter | undefined => localFilterResult.value?.filter
/** D3 证据来源切换：清空旧分页/曲线并按新来源重新加载，旧响应由 store epoch 丢弃。 */
async function selectEvidenceSource(sourceSha256: string): Promise<void> {
  evidenceSeriesId.value = ''
  if (!await reportStore.loadEvidenceOverview(sourceSha256)) return
  const meta = reportStore.evidenceOverview?.series?.[0]
  evidenceSeriesId.value = meta?.seriesId ?? ''
  if (meta) void reportStore.loadEvidenceSeries(meta.seriesId, { filter: appliedEvidenceFilter() })
}


async function ensureEngineSegments(): Promise<void> {
  if (!resultSource.value || !engineArchive.value?.detailDeferred) return
  await reportStore.loadEngineSegments(appliedEvidenceFilter() ?? {})
}

async function ensureQualityEvidence(): Promise<void> {
  if (!resultSource.value || reportStore.evidenceSeries || evidenceSeriesId.value) return
  if (!reportStore.evidenceOverview && !await reportStore.loadEvidenceOverview()) return
  const source = reportStore.evidenceOverview?.sources.find(item => item.label.startsWith('任务 CSV')) ?? reportStore.evidenceOverview?.sources[0]
  if (source && source.sourceSha256 !== reportStore.evidenceOverview?.selectedSourceSha256) {
    await selectEvidenceSource(source.sourceSha256)
    return
  }
  // 简化后的页签只展示折线图：默认加载第一条可用曲线，不再显示曲线选择器。
  const meta = reportStore.evidenceOverview?.series?.[0]
  if (meta) {
    evidenceSeriesId.value = meta.seriesId
    void reportStore.loadEvidenceSeries(meta.seriesId, { filter: appliedEvidenceFilter() })
  }
}

async function loadComparisons(): Promise<void> {
  const source = resultSource.value
  if (source && !await reportStore.loadResultComparisons() && resultSource.value === source) {
    ElMessage.warning('历史运行参数加载失败，可重新打开对比页签重试。')
  }
}
async function loadEvidence(): Promise<void> {
  const report = selectedReport.value
  if (report?.localEvidence) {
    telemetryStore.resetToSafeEmpty()
    exportFormat.value = 'HTML'
    evidenceSeriesId.value = ''
    clearFilterInputs()
    if (resultSource.value) {
      await reportStore.applyLocalFilter({})
      if (engineCsv.value?.files.some(file => ['link_state.csv', 'link_loss.csv', 'link_switch.csv'].includes(file.fileName))
        && await reportStore.loadEvidenceOverview()) {
        const csvSource = reportStore.evidenceOverview?.sources.find(source => source.label.startsWith('任务 CSV'))
        if (csvSource) await selectEvidenceSource(csvSource.sourceSha256)
      }
    }
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
async function requestExport(format = exportFormat.value): Promise<void> {
  const local = !!reportStore.selectedReport?.localEvidence
  const ok = await reportStore.requestExport(format)
  if (local) { if (ok) ElMessage.success(reportStore.resultMessage); else ElMessage.error(reportStore.resultMessage) }
}

async function applyLocalFilter(reset = false): Promise<void> {
  if (!resultSource.value || (!reset && filterRangeError.value)) return
  if (reset) clearFilterInputs()
  const filter: LocalReportFilter = { ...(filterNode.value ? { nodeId: filterNode.value } : {}), ...(filterLink.value ? { linkId: filterLink.value } : {}), ...(filterFrom.value === null ? {} : { from: filterFrom.value }), ...(filterTo.value === null ? {} : { to: filterTo.value }) }
  if (await reportStore.applyLocalFilter(filter) && reportStore.evidenceOverview?.selectedSourceSha256) {
    // 已应用筛选变化：失效旧请求并清旧游标/段，按新筛选刷新当前来源/kind/曲线。
    if (evidenceSeriesId.value) void reportStore.loadEvidenceSeries(evidenceSeriesId.value, { filter: appliedEvidenceFilter() })
  }
}

/** 下载当前结果绑定的完整已验证 JSONL；摘要截断时不把内存明细冒充全量。 */
async function downloadEngineFrames(): Promise<void> {
  const source = resultSource.value
  const sha256 = engineArchive.value?.sourceSha256
  if (!source || !sha256 || engineArchiveDownloading.value) return
  engineArchiveDownloading.value = true
  try {
    const response = await apiFetch(`${resolveMockOrigin()}/api/v1/mission-results/${encodeURIComponent(source.resultId)}/engine-frames/${encodeURIComponent(sha256)}`, {
      headers: { 'X-Demo-Role': useAuthStore().role },
    })
    if (!await saveDownload(response, `engine-frames-${sha256}.jsonl`, () => resultSource.value?.resultId === source.resultId
      && engineArchive.value?.sourceSha256 === sha256)) return
    ElMessage.success('已发起完整引擎帧 JSONL 下载。')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '引擎帧归档下载失败。') } finally { engineArchiveDownloading.value = false }
}

/** Downloads only a report-attached canonical CSV; the server rechecks result permission and source SHA. */
async function downloadEngineCsv(fileName: string): Promise<void> {
  const source = resultSource.value
  const sha256 = engineCsv.value?.sourceSha256
  if (!source || !sha256 || engineCsvDownloading.value !== null) return
  engineCsvDownloading.value = fileName
  try {
    const response = await apiFetch(`${resolveMockOrigin()}/api/v1/mission-results/${encodeURIComponent(source.resultId)}/engine-csv/${encodeURIComponent(fileName)}`, {
      headers: { 'X-Demo-Role': useAuthStore().role },
    })
    if (!await saveDownload(response, fileName, () => resultSource.value?.resultId === source.resultId && engineCsv.value?.sourceSha256 === sha256)) return
    ElMessage.success(`已发起 ${fileName} 下载。`)
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '引擎规范 CSV 下载失败。') } finally { engineCsvDownloading.value = null }
}

</script>

<template>
  <section class="reports-page" aria-label="评估报表">
    <header class="reports-page__header">
      <MissionResults view="report" :refreshing="pending" @refresh="reload" />
      <div class="reports-page__actions" :class="{ 'reports-page__actions--export': localEvidence }">
        <template v-if="localEvidence">
          <el-select v-model="exportFormat" aria-label="导出格式" :disabled="pending || selectedReport === null">
            <el-option value="HTML" label="HTML" />
            <el-option value="PDF" label="PDF" />
          </el-select>
          <el-button
            type="primary"
            data-testid="report-export"
            :loading="capabilityState === 'EXECUTING'"
            :disabled="pending || selectedReport === null"
            @click="requestExport()"
          >{{ appliedFilterLabel === '全部数据' ? '导出报告' : '导出筛选报告' }}</el-button>
          <el-dropdown trigger="click" :disabled="pending" @command="handleDataExportCommand">
            <el-button data-testid="report-data-export" :disabled="pending">数据导出</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="summary-csv" data-testid="export-summary-csv" :disabled="pending">导出统计 CSV</el-dropdown-item>
                <el-dropdown-item
                  v-if="resultSource && engineArchive"
                  command="engine-frames"
                  data-testid="engine-frame-archive-download"
                  :disabled="pending || engineArchiveDownloading"
                >下载完整引擎帧 JSONL</el-dropdown-item>
                <template v-if="resultSource && engineCsv">
                  <el-dropdown-item
                    v-for="file in engineCsv.files"
                    :key="file.fileName"
                    :command="`csv:${file.fileName}`"
                    data-testid="engine-csv-download"
                    :disabled="pending || engineCsvDownloading !== null"
                    :title="file.reason || undefined"
                  >下载 {{ file.fileName }}</el-dropdown-item>
                </template>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
        <template v-else-if="auth.runtimeMode !== 'LOCAL'">
          <el-select
            v-if="!resultId && !archiveId"
            :model-value="selectedReport?.reportId ?? ''"
            aria-label="报告来源"
            data-testid="report-source"
            class="reports-page__source-select"
            :disabled="pending || reports.length === 0"
            placeholder="选择报告"
            @update:model-value="changeReport"
          >
            <el-option
              v-for="report in reports"
              :key="report.reportId"
              :value="report.reportId"
              :label="`${report.reportId} · 单次仿真`"
            />
          </el-select>
          <el-select v-model="exportFormat" aria-label="验证导出格式" :disabled="pending || !selectedReport">
            <el-option value="HTML" label="HTML" />
            <el-option value="PDF" label="PDF" />
            <el-option value="CSV" label="CSV" />
          </el-select>
          <el-button data-testid="report-export" :loading="capabilityState === 'EXECUTING'" :disabled="pending || !selectedReport" @click="requestExport()">验证导出</el-button>
        </template>
        <el-button v-if="auth.runtimeMode !== 'LOCAL'" :disabled="pending" @click="reload">重新加载</el-button>
      </div>
      <p v-if="!archiveId && !resultId">可选择已完成的仿真查看评估结果；当前显示配置文件报告。</p>
    </header>

    <main class="reports-page__content">
      <p style="margin: 0;" v-if="archiveId" data-testid="report-archive-source">归档：{{ archiveId }} · 未绑定场景或运行</p>
      <p style="margin: 0;" v-if="selectedReport?.localEvidence">报告编号：{{ selectedReport.reportId }} · 统计生成：{{ formatDateTime(selectedReport.generatedTime) }}</p>
      <el-skeleton v-if="!localFilterPending && (capabilityState === 'LOADING' || capabilityState === 'VALIDATING')" :rows="8" animated />
      <template v-else-if="selectedReport?.localEvidence">
        <p v-if="resultSource?.executionSource === 'REMOTE_WS'">数据接收已结束，未确认引擎已停止。指标来自归档，事件和轨迹来自回放文件。</p>
        <p v-if="resultComparisons.some(item => item.record.resultId === resultSource?.resultId && item.parameters.source === 'PROJECT_REFERENCE')" data-testid="report-reference-parameters">参数以项目参考配置为准，未确认引擎实际执行版本。</p>
        <el-alert v-if="resultSource && (capabilityState === 'ERROR' || !localFilterResult)" type="warning" :closable="false" :title="resultMessage || '该历史结果无法筛选，请重新生成结果。'" />
        <p tyle="margin: 0;" v-if="resultSource" data-testid="report-applied-filter">当前图表与导出范围：{{ appliedFilterLabel }}</p>
        <el-form v-if="resultSource" inline class="local-report-filter" aria-label="报告统一筛选">
          <el-form-item label="节点"><el-select v-model="filterNode" clearable style="width: 160px" placeholder="全部节点"><el-option v-for="node in selectedReport.localEvidence.nodes" :key="node.platformId" :value="node.platformId" :label="node.name" /></el-select></el-form-item>
          <el-form-item label="链路"><el-select v-model="filterLink" clearable style="width: 180px" :disabled="!localFilterResult" placeholder="全部链路"><el-option v-for="link in filterLinkOptions" :key="link.value" :value="link.value" :label="link.label" /></el-select></el-form-item>
          <el-form-item label="开始时刻（秒）"><el-input-number v-model="filterFrom" :min="0" :max="selectedReport.localEvidence.endTimeS" /></el-form-item><el-form-item label="结束时刻（秒）"><el-input-number v-model="filterTo" :min="0" :max="selectedReport.localEvidence.endTimeS" /></el-form-item>
          <el-form-item><el-button type="primary" :loading="localFilterPending" :disabled="filterRangeError || !localFilterResult" @click="applyLocalFilter()">应用精确筛选</el-button><el-button :disabled="!localFilterResult || localFilterPending" @click="applyLocalFilter(true)">重置</el-button></el-form-item>
        </el-form>
        <el-alert v-if="filterRangeError" type="error" :closable="false" title="开始时刻不得晚于结束时刻。" />
        <LocalReportTabs
          v-loading="localFilterPending"
          :filter-pending="localFilterPending"
          :evidence="localEvidence!"
          :generated-time="localFilterResult?.report.generatedTime ?? selectedReport.generatedTime"
          :filter="localFilterResult?.filter"
          :comparison="resultComparisons"
          :current-result-id="resultSource?.resultId"
          :comparison-loading="reportStore.comparisonsLoading"
          :precise-filter="!!resultSource && !!localFilterResult"
          :timeline="localFilterResult?.timeline"
          :timeline-total="localFilterResult?.timelineTotal"
          :has-quality-evidence="hasQualityEvidence"
          @load-comparisons="loadComparisons"
          @load-quality-evidence="ensureQualityEvidence"
          @load-engine-segments="ensureEngineSegments"
        />
      </template>
      <ReportTabs
        v-else-if="selectedReport"
        :report="selectedReport"
        :frame="telemetryStore.frame"
        :events="telemetryStore.events"
      />
      <el-result v-else-if="capabilityState === 'ERROR'" icon="error" title="报告加载失败" :sub-title="resultMessage" />
      <el-empty v-else description="暂无可用报告" />
      <el-alert
        v-if="!localEvidence && exportResult && !exportResult.generated"
        class="reports-page__export-result"
        type="success"
        show-icon
        :closable="false"
        :title="`${exportResult.watermark} · 验证时刻 ${formatDateTime(exportResult.verifiedAt)}`"
      />
    </main>
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
  grid-template-rows: auto minmax(0, 1fr);
  gap: 0.75rem;
  padding: 1rem;
  overflow: hidden;
  color: var(--console-text);
  background: var(--console-bg-elevated);
}

.reports-page__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  padding-bottom: 0.85rem;
  border-bottom: 1px solid var(--console-border);
}

.reports-page__header p {
  flex-basis: 100%;
  margin: 0;
  color: var(--console-text-muted);
  font-size: 12px;
}

.reports-page__actions {
  display: flex;
  flex-wrap: wrap;
  min-width: 0;
  align-items: center;
  gap: 0.6rem;
}

.reports-page__actions--export {
  margin-inline-start: auto;
}

.reports-page__actions :deep(.el-select) {
  width: 7rem;
}

.reports-page__actions :deep(.reports-page__source-select.el-select) {
  width: 14rem;
  max-width: 100%;
}

.reports-page__content {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: auto;
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

/* 来源与归档汇总较多时允许整页滚动，避免把明细页签压到零高度。 */
.reports-page__content :deep(.local-report) { flex: 1 0 auto; }
.reports-page__content :deep(.local-report > .el-tabs) { flex: 1 0 28rem; }

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

.report-evidence__bar { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; margin: 0.75rem 0; }

.reports-page__export-result {
  flex: 0 0 auto;
}
</style>

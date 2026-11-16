import { apiFetch } from '../features/shared/api-fetch'
import { saveDownload } from '../features/shared/download'
import { isMissionResultRecord, isMissionResultSnapshot, isMissionResultParameterSnapshot, type MissionResultParameterComparison, type MissionResultRecord } from '../features/results/mission-result'
import { defineStore } from 'pinia'
import type {
  CapabilityState,
  Report,
  ReportExportRequest,
  ReportExportResult,
  LocalReportExportResult,
  LocalReportFilter,
  LocalReportFilterResult,
} from '../contracts/domain-models'
import { resolveMockOrigin, useAuthStore } from './auth'
import { readApiFailure, unwrapSuccessData } from './api-envelope'
import { isLocalReport, isLocalReportExport, parseLocalReportFilter } from '../features/reports/local-report'
import { isLocalArchiveSnapshot } from '../features/admin/local-archive'

type ExportFormat = ReportExportRequest['format']

/** 校验报表 KPI 的闭合数值字段。 */
function isReportKpis(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = [
    'connectivityRate', 'switchCount', 'avgBer', 'avgSnrDb', 'interferenceDurationS',
    'avgConnectivityDurationS', 'minSnrDb', 'maxBer',
  ]
  return Object.keys(value).length === keys.length
    && keys.every((key) => typeof (value as Record<string, unknown>)[key] === 'number'
      && Number.isFinite((value as Record<string, number>)[key]))
}

/** 校验单条正式报告时序曲线及严格递增的仿真时刻。 */
function isReportTimeSeries(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const series = value as Record<string, unknown>
  if (Object.keys(series).length !== 4
    || !['linkId', 'sourcePlatformId', 'targetPlatformId'].every(
      (key) => typeof series[key] === 'string' && series[key].length > 0,
    )
    || !Array.isArray(series.points)
    || series.points.length < 2) return false
  return series.points.every((point, index) => {
    if (typeof point !== 'object' || point === null || Array.isArray(point)) return false
    const values = point as Record<string, unknown>
    return Object.keys(values).length === 4
      && ['time', 'snrDb', 'ber', 'interferencePowerDbm'].every(
        (key) => typeof values[key] === 'number' && Number.isFinite(values[key]),
      )
      && Number(values.time) >= 0
      && Number(values.ber) >= 0 && Number(values.ber) <= 1
      && (index === 0 || Number(values.time) > Number((series.points as Array<Record<string, unknown>>)[index - 1]!.time))
  })
}

/** 校验服务端返回的单次报告。 */
export function isReport(value: unknown): value is Report {
  if (isLocalReport(value)) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const report = value as Partial<Report>
  const keys = Object.keys(value)
  return keys.every((key) => ['reportId', 'runId', 'classification', 'generatedTime', 'status', 'kpis', 'timeSeries'].includes(key))
    && typeof report.reportId === 'string' && report.reportId.startsWith('RPT-')
    && (report.runId === undefined || (typeof report.runId === 'string' && report.runId.startsWith('RUN-')))
    && (report.classification === 'LEVEL_II' || report.classification === 'LEVEL_III')
    && typeof report.generatedTime === 'string'
    && report.status === 'READY'
    && (report.kpis === undefined || isReportKpis(report.kpis))
    && (report.timeSeries === undefined || (Array.isArray(report.timeSeries)
      && report.timeSeries.length > 0 && report.timeSeries.every(isReportTimeSeries)))
    && report.runId !== undefined && report.timeSeries !== undefined
}

/** 区分真实本地文件导出与纯 Mock 合同验证结果。 */
function isExportResult(value: unknown): value is ReportExportResult | LocalReportExportResult {
  if (isLocalReportExport(value)) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Partial<ReportExportResult>
  return typeof result.reportId === 'string'
    && result.reportId.startsWith('RPT-')
    && result.generated === false
    && result.status === 'FIXTURE_SUCCESS'
    && typeof result.watermark === 'string'
    && typeof result.verifiedAt === 'string'
}

function isLocalReportFilterResult(value: unknown): value is LocalReportFilterResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Partial<LocalReportFilterResult>
  const filter = result.filter
  const validFilter = filter !== undefined && parseLocalReportFilter(filter) !== null
  return Object.keys(result).every(key => ['report', 'filter', 'timeline', 'timelineTotal', 'stages', 'links'].includes(key))
    && isLocalReport(result.report) && validFilter
    && Array.isArray(result.timeline) && result.timeline.length <= 500 && result.timeline.every(event => event && typeof event === 'object'
      && ['id', 'type', 'subject'].every(key => typeof (event as unknown as Record<string, unknown>)[key] === 'string' && String((event as unknown as Record<string, unknown>)[key]).length > 0)
      && Number.isFinite(event.time) && event.time >= 0
      && ['target', 'device', 'stage'].every(key => (event as unknown as Record<string, unknown>)[key] === undefined || typeof (event as unknown as Record<string, unknown>)[key] === 'string'))
    && Number.isSafeInteger(result.timelineTotal) && Number(result.timelineTotal) >= result.timeline.length
    && Array.isArray(result.stages) && result.stages.every(item => typeof item === 'string')
    && Array.isArray(result.links) && result.links.every(item => typeof item === 'string')
}

// —— D3 报告证据（独立响应，不复用旧 Report.localEvidence 合同）——
export interface EvidenceSeriesMetaView { seriesId: string; kind: string; unit: string; linkId?: string }
export interface EvidenceSourceView { sourceSha256: string; sourceKind: string; capabilities: string[]; totals: Record<string, number>; series: EvidenceSeriesMetaView[]; label: string }
export interface EvidenceOverviewView { reportId: string; resultId: string; runId: string; generatedTime: string; effectiveFilter: Record<string, unknown>; sources: EvidenceSourceView[]; selectedSourceSha256: string | null; capabilities?: string[]; totals?: Record<string, number>; missing?: string[]; series?: EvidenceSeriesMetaView[] }
export interface EvidenceRowsView { reportId: string; resultId: string; runId: string; sourceSha256: string; kind: string; effectiveFilter: Record<string, unknown>; total: number; rows: Array<{ id: string; time: number } & Record<string, unknown>>; nextCursor: string | null }
export interface EvidenceSeriesView { reportId: string; resultId: string; runId: string; sourceSha256: string; seriesId: string; kind: string; unit: string; continuityReliable?: boolean; effectiveFilter: Record<string, unknown>; rawCount: number; pointCount: number; sampling: string; points: Array<{ time: number; value: number; breakBefore?: boolean }>; nextCursor: string | null }

const isObjectLike = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isEvidenceSourceView = (value: unknown): value is EvidenceSourceView => isObjectLike(value) && typeof value.sourceSha256 === 'string'
  && typeof value.sourceKind === 'string' && Array.isArray(value.capabilities) && isObjectLike(value.totals) && Array.isArray(value.series) && typeof value.label === 'string'
const isEvidenceOverviewView = (value: unknown): value is EvidenceOverviewView => isObjectLike(value) && typeof value.reportId === 'string' && typeof value.resultId === 'string'
  && typeof value.runId === 'string' && typeof value.generatedTime === 'string' && Array.isArray(value.sources) && value.sources.every(isEvidenceSourceView)
  && (value.selectedSourceSha256 === null || typeof value.selectedSourceSha256 === 'string')
/** 合并来源目录：保留既有条目顺序，命中同一 sourceSha256 时用较新的元信息覆盖。 */
function mergeEvidenceSources(base: EvidenceSourceView[], incoming: EvidenceSourceView[]): EvidenceSourceView[] {
  const byId = new Map<string, EvidenceSourceView>()
  for (const item of base) byId.set(item.sourceSha256, item)
  for (const item of incoming) byId.set(item.sourceSha256, item)
  return [...byId.values()]
}

const isEvidenceRowsView = (value: unknown): value is EvidenceRowsView => isObjectLike(value) && typeof value.kind === 'string' && Number.isSafeInteger(value.total)
  && Array.isArray(value.rows) && (value.nextCursor === null || typeof value.nextCursor === 'string')
const isEvidenceSeriesView = (value: unknown): value is EvidenceSeriesView => isObjectLike(value) && typeof value.seriesId === 'string' && typeof value.unit === 'string'
  && Number.isSafeInteger(value.rawCount) && Number.isSafeInteger(value.pointCount) && typeof value.sampling === 'string'
  && Array.isArray(value.points) && (value.nextCursor === null || typeof value.nextCursor === 'string')

/** 读取统一成功信封并按调用方提供的规则校验业务数据。 */
async function readSuccess<T>(response: Response, validate: (value: unknown) => value is T): Promise<T> {  const payload = await response.json() as unknown
  if (!response.ok) throw readApiFailure(payload) ?? new Error('报表服务响应错误。')
  const data = unwrapSuccessData(payload)
  if (!validate(data)) throw new Error('报表数据格式不正确。')
  return data
}

export const useReportStore = defineStore('report', {
  state: () => ({
    reports: [] as Report[],
    selectedReport: null as Report | null,
    capabilityState: 'EMPTY' as CapabilityState,
    resultCode: 'EMPTY',
    resultMessage: '尚未加载报告。',
    exportResult: null as ReportExportResult | LocalReportExportResult | null,
    requestEpoch: 0,
    archiveId: null as string | null,
    resultSource: null as MissionResultRecord | null,
    resultComparisons: [] as MissionResultParameterComparison[],
    comparisonsLoading: false,
    comparisonsLoaded: false,
    comparisonsEpoch: 0,
    localFilterResult: null as LocalReportFilterResult | null,
    evidenceOverview: null as EvidenceOverviewView | null,
    /** 当前 report/result 的完整可选来源目录；选中来源的详情响应不能把它缩成单项。 */
    evidenceSourcesCatalog: [] as EvidenceSourceView[],
    evidenceRows: null as EvidenceRowsView | null,
    evidenceSeries: null as EvidenceSeriesView | null,
    evidenceSeriesSegments: [] as Array<Array<{ time: number; value: number; breakBefore?: boolean }>>,
    evidenceLoading: false,
    /** 活跃证据请求令牌：以 id:slot:epoch:代际 标识。 */
    evidenceActiveTokens: [] as string[],
    evidenceNextRequestId: 0,
    /** 活跃证据请求数量镜像，供既有断言/调试。 */
    evidenceActiveRequests: 0,
    evidenceLoadingEpoch: 0,
    evidenceMessage: '',
    evidenceEpoch: 0,
    evidenceSeriesEpoch: 0,
    /** 明细请求令牌：同源切换 kind 时旧 rows 迟到不能覆盖新 kind。 */
    evidenceRowsEpoch: 0,
    evidenceSeriesMaxPoints: 1000,
    evidenceFilter: undefined as LocalReportFilter | undefined,
    evidenceRowsFilter: undefined as LocalReportFilter | undefined,
    /**
     * 曲线首段的不可变上下文：续页只使用该快照，并行 rows/其它曲线响应不能改写它。
     * 字段覆盖 report/result/run/sourceSha256/series/kind/unit/filter/maxPoints。
     */
    evidenceSeriesContext: null as null | {
      reportId: string
      resultId: string
      runId: string
      sourceSha256: string
      seriesId: string
      kind: string
      unit: string
      filter?: LocalReportFilter
      maxPoints: number
      cursor?: string
    },
    /** 已成功追加的分页游标，防止同一游标重复 append。 */
    evidenceSeriesLastCursor: null as string | null,
    /** 正在请求中的曲线续页游标；同一游标并发只允许一个 HTTP。 */
    evidenceSeriesInflightCursor: null as string | null,
    /** 在途续页游标所属曲线代际；旧代际 finally 不得清除新代际标记。 */
    evidenceSeriesInflightGen: 0,
  }),

  actions: {
    /** 清空所有证据分页/曲线/上下文并使在途证据请求失效（切换报告/来源时使用）。 */
    clearEvidenceState(): void {
      this.evidenceOverview = null
      this.evidenceRows = null
      this.evidenceSeries = null
      this.evidenceSeriesSegments = []
      this.evidenceFilter = undefined
      this.evidenceRowsFilter = undefined
      this.evidenceSeriesContext = null
      this.evidenceSeriesLastCursor = null
      this.evidenceSeriesInflightCursor = null
      this.evidenceSeriesInflightGen = 0
      this.evidenceSourcesCatalog = []
      this.evidenceMessage = ''
      this.evidenceActiveTokens = []
      this.evidenceActiveRequests = 0
      this.evidenceLoading = false
      this.evidenceEpoch += 1
      this.evidenceRowsEpoch += 1
      this.evidenceSeriesEpoch += 1
      this.evidenceLoadingEpoch = this.evidenceEpoch
    },

    async loadResult(resultId: string): Promise<boolean> {
      this.resetToSafeEmpty()
      const epoch = this.requestEpoch
      this.capabilityState = 'LOADING'
      try {
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/mission-results/${encodeURIComponent(resultId)}`, { headers: { 'X-Demo-Role': useAuthStore().role } })
        const snapshot = await readSuccess(response, isMissionResultSnapshot)
        if (epoch !== this.requestEpoch) return false
        if (snapshot.record.resultId !== resultId) throw new Error('运行结果与请求不一致。')
        this.resultSource = snapshot.record
        this.localFilterResult = null
        this.resultComparisons = snapshot.parameters === undefined ? [] : [{ record: snapshot.record, parameters: snapshot.parameters }]
        this.reports = [snapshot.report]
        this.selectedReport = snapshot.report
        this.capabilityState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = '本次运行报告已加载。'
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.showError(error, '运行报告加载失败。')
        return false
      }
    },
    /** 历史参数只在打开对比页签时读取，不阻塞当前报告与 CSV 明细。 */
    async loadResultComparisons(): Promise<boolean> {
      const source = this.resultSource
      if (!source) return false
      if (this.comparisonsLoading || this.comparisonsLoaded) return true
      const epoch = this.comparisonsEpoch
      const current = this.resultComparisons.filter(row => row.record.resultId === source.resultId)
      this.comparisonsLoading = true
      try {
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/mission-results`, { headers: { 'X-Demo-Role': useAuthStore().role } })
        const records = await readSuccess(response, (value): value is MissionResultRecord[] => Array.isArray(value) && value.every(isMissionResultRecord))
        if (epoch !== this.comparisonsEpoch) return false
        const ids = [...new Set(records.filter(record => record.scenarioId === source.scenarioId && record.resultId !== source.resultId).map(record => record.resultId))].slice(0, 11)
        const comparisons = await Promise.all(ids.map(async id => {
          const response = await apiFetch(`${resolveMockOrigin()}/api/v1/mission-results/${encodeURIComponent(id)}/parameters`, { headers: { 'X-Demo-Role': useAuthStore().role } })
          const snapshot = await readSuccess(response, isMissionResultParameterSnapshot)
          // 历史结果必须同时匹配请求编号和当前场景，不能混入其他运行来源。
          return snapshot.record.resultId === id && snapshot.record.scenarioId === source.scenarioId && snapshot.parameters !== undefined
            ? { record: snapshot.record, parameters: snapshot.parameters } : null
        }))
        if (epoch !== this.comparisonsEpoch) return false
        this.resultComparisons = [...current, ...comparisons.filter((row): row is MissionResultParameterComparison => row !== null)]
        this.comparisonsLoaded = true
        return true
      } catch {
        return false
      } finally {
        if (epoch === this.comparisonsEpoch) this.comparisonsLoading = false
      }
    },
    async loadArchive(archiveId: string): Promise<boolean> {
      this.resetToSafeEmpty()
      const epoch = this.requestEpoch
      this.archiveId = archiveId
      this.localFilterResult = null
      this.capabilityState = 'LOADING'
      try {
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/archives/${encodeURIComponent(archiveId)}`, {
          headers: { 'X-Demo-Role': useAuthStore().role },
        })
        const archived = await readSuccess(response, isLocalArchiveSnapshot)
        if (epoch !== this.requestEpoch) return false
        if (archived.record.archiveId !== archiveId) throw new Error('归档来源与请求不一致。')
        this.reports = [archived.report]
        this.selectedReport = archived.report
        this.capabilityState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = ''
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.showError(error, '归档报告加载失败。')
        return false
      }
    },
    /**
     * 加载报告目录并选择第一份报告。
     * @param preferredReportId 可选的预选报告编号，不在目录中时回退首份报告。
     * @returns 目录和首份报告均有效时返回 `true`，否则返回 `false`。
     * @sideEffects 原子替换报告目录和当前来源；失败时清空旧报告，避免来源混用。
     */
    async load(preferredReportId?: string): Promise<boolean> {
      this.resultSource = null
      this.archiveId = null
      this.resultComparisons = []
      this.comparisonsEpoch += 1
      this.comparisonsLoading = false
      this.comparisonsLoaded = false
      this.localFilterResult = null
      this.clearEvidenceState()
      // 从历史归档切回当前文件时，迟到的归档响应不能恢复旧来源。
      const epoch = ++this.requestEpoch
      this.capabilityState = 'LOADING'
      try {
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/reports`, {
          headers: { 'X-Demo-Role': useAuthStore().role },
        })
        if (epoch !== this.requestEpoch) return false
        const reports = await readSuccess(response, (value): value is Report[] => Array.isArray(value) && value.every(isReport))
        if (epoch !== this.requestEpoch) return false
        if (reports.length === 0) {
          this.resetToSafeEmpty()
          return true
        }
        this.reports = structuredClone(reports)
        const selectedId = reports.some((report) => report.reportId === preferredReportId)
          ? preferredReportId!
          : reports[0]!.reportId
        return await this.selectReport(selectedId)
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.showError(error, '报告加载失败。')
        return false
      }
    },

    /**
     * 切换报告来源并在完整响应通过校验后一次性替换当前数据。
     * @param reportId 报告目录中的目标编号。
     * @returns 目标报告加载成功时返回 `true`。
     * @sideEffects 清除旧导出结果；失败时清空当前报告，避免不同来源的数据混用。
     */
    async selectReport(reportId: string): Promise<boolean> {
      if (this.resultSource !== null) return this.loadResult(this.resultSource.resultId)
      if (this.archiveId !== null) return this.loadArchive(this.archiveId)
      const epoch = this.requestEpoch
      this.capabilityState = 'LOADING'
      this.exportResult = null
      try {
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/reports/${encodeURIComponent(reportId)}`, {
          headers: { 'X-Demo-Role': useAuthStore().role },
        })
        if (epoch !== this.requestEpoch) return false
        this.capabilityState = 'VALIDATING'
        const report = await readSuccess(response, isReport)
        if (epoch !== this.requestEpoch) return false
        if (report.reportId !== reportId) throw new Error('报告来源与请求不一致。')
        this.selectedReport = structuredClone(report)
        this.capabilityState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = '报告已加载。'
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.showError(error, '报告加载失败。')
        return false
      }
    },

    /** 发起普通报告导出验证。 */
    async requestExport(format: ExportFormat): Promise<boolean> {
      const report = this.selectedReport
      if (report === null) {
        this.showError(undefined, '请先选择报告。', 'EMPTY')
        return false
      }
      if (report.classification === 'LEVEL_III') {
        this.showError(undefined, '三级报告导出已下线。', 'PERMISSION_DENIED')
        return false
      }
      return this.exportNow(format)
    },

    /**
     * 调用导出接口；本地报告生成文件，纯 Mock 只验证合同。
     * @param format 需要验证的格式。
     * @returns 固定验证结果有效时返回 `true`。
     */
    async exportNow(format: ExportFormat): Promise<boolean> {
      const report = this.selectedReport
      if (report === null) return false
      const epoch = this.requestEpoch
      this.capabilityState = 'EXECUTING'
      try {
        const params = new URLSearchParams()
        if (this.archiveId !== null) params.set('archiveId', this.archiveId)
        if (this.resultSource !== null) params.set('resultId', this.resultSource.resultId)
        if (report.localEvidence) params.set('download', '1')
        const query = params.size ? `?${params}` : ''
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/reports/${encodeURIComponent(report.reportId)}/export${query}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': useAuthStore().role },
          body: JSON.stringify({ reportId: report.reportId, format,
            ...(report.localEvidence?.quality === undefined ? {} : { qualitySha256: report.localEvidence.quality.source.sha256 }),
            ...(this.localFilterResult?.filter === undefined ? {} : { filter: this.localFilterResult.filter }) }),
        })
        if (report.localEvidence) {
          if (!await saveDownload(response, `${this.resultSource?.resultId ?? report.reportId}.${format.toLowerCase()}`, () => epoch === this.requestEpoch)) return false
          this.exportResult = null
          this.capabilityState = 'SUCCESS'
          this.resultCode = 'SUCCESS'
          this.resultMessage = '已发起报告下载，请在浏览器下载记录中查看。'
          return true
        }
        const result = await readSuccess(response, isExportResult)
        if (epoch !== this.requestEpoch) return false
        if (result.reportId !== report.reportId || result.generated) throw new Error('导出结果与当前报告不一致。')
        this.exportResult = result
        this.capabilityState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = result.generated ? '报告文件已由本机服务生成。' : '导出合同验证通过，未生成文件。'
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.showError(error, '导出验证失败。')
        return false
      }
    },

    /** Request a result-bound aggregate; stale replies cannot replace a newer report or filter. */
    async applyLocalFilter(filter: LocalReportFilter): Promise<boolean> {
      const source = this.resultSource, report = this.selectedReport
      if (!source || !report?.localEvidence) { this.showError(undefined, '当前报告不支持精确筛选。', 'FILTER_UNSUPPORTED'); return false }
      const epoch = ++this.requestEpoch
      this.capabilityState = 'LOADING'
      try {
        const params = new URLSearchParams({ resultId: source.resultId })
        for (const [key, value] of Object.entries(filter)) if (value !== undefined) params.set(key, String(value))
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/reports/${encodeURIComponent(report.reportId)}/filter?${params}`, { headers: { 'X-Demo-Role': useAuthStore().role } })
        const result = await readSuccess(response, isLocalReportFilterResult)
        if (epoch !== this.requestEpoch) return false
        if (result.report.reportId !== report.reportId || result.report.runId !== report.runId
          || result.report.localEvidence?.eventFile.sha256 !== report.localEvidence.eventFile.sha256
          || result.report.localEvidence?.positionFile.sha256 !== report.localEvidence.positionFile.sha256
          || (['nodeId', 'linkId', 'stage', 'from', 'to'] as const).some(key => result.filter[key] !== filter[key])) throw new Error('筛选结果与当前报告或请求条件不一致。')
        this.localFilterResult = result
        // 应用筛选成功：使旧证据上下文/分页/曲线全部失效，防止迟到响应续用旧筛选。
        this.evidenceEpoch += 1
        this.evidenceRowsEpoch += 1
        this.evidenceSeriesEpoch += 1
        this.evidenceActiveTokens = []
        this.evidenceActiveRequests = 0
        this.evidenceLoading = false
        this.evidenceLoadingEpoch = this.evidenceEpoch
        this.evidenceRows = null
        this.evidenceSeries = null
        this.evidenceSeriesSegments = []
        this.evidenceFilter = undefined
        this.evidenceRowsFilter = undefined
        this.evidenceSeriesContext = null
        this.evidenceSeriesLastCursor = null
        this.evidenceSeriesInflightCursor = null
        this.exportResult = null
        this.capabilityState = 'SUCCESS'; this.resultCode = 'SUCCESS'; this.resultMessage = '已应用精确筛选。'
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        const failure = readApiFailure(error)
        this.capabilityState = 'ERROR'
        this.resultCode = failure?.error.code ?? 'FILTER_UNSUPPORTED'
        this.resultMessage = failure?.error.message ?? '精确筛选不可用，请重新生成结果。'
        return false
      }
    },

    /** 标记一个证据请求开始，返回 id:slot:epoch:代际 令牌；loading 只统计当前有效代际。 */
    beginEvidenceRequest(slot: 'overview' | 'rows' | 'series' | 'next' | 'export', gen: number): string {
      const id = ++this.evidenceNextRequestId
      const token = `${id}:${slot}:${this.evidenceEpoch}:${gen}`
      this.evidenceActiveTokens = [...this.evidenceActiveTokens, token]
      this.refreshEvidenceLoading()
      return token
    },
    /** 标记一个证据请求结束；过期请求不改变当前 loading（新代际请求仍占用时保持 true）。 */
    endEvidenceRequest(token: string): void {
      this.evidenceActiveTokens = this.evidenceActiveTokens.filter(item => item !== token)
      this.refreshEvidenceLoading()
    },
    /** 更新有效计数与 loading 状态：清理已过期令牌，确保计数与 loading 逻辑一致。 */
    refreshEvidenceLoading(): void {
      const epoch = this.evidenceEpoch
      this.evidenceActiveTokens = this.evidenceActiveTokens.filter(token => {
        const [, slot, tokenEpoch, tokenGen] = token.split(':')
        if (Number(tokenEpoch) !== epoch) return false
        if (slot === 'rows') return Number(tokenGen) === this.evidenceRowsEpoch
        if (slot === 'series' || slot === 'next') return Number(tokenGen) === this.evidenceSeriesEpoch
        return true
      })
      this.evidenceActiveRequests = this.evidenceActiveTokens.length
      this.evidenceLoading = this.evidenceActiveRequests > 0
    },

    /** D3：加载报告证据概览（未选来源返回 sources）。切换报告/来源递增 epoch，旧响应丢弃。 */
    async loadEvidenceOverview(sourceSha256?: string): Promise<boolean> {
      const source = this.resultSource, report = this.selectedReport
      if (!source || !report?.localEvidence) { this.showError(undefined, '当前报告不支持证据查询。', 'FILTER_UNSUPPORTED'); return false }
      const epoch = ++this.evidenceEpoch
      this.evidenceMessage = ''
      this.evidenceRows = null; this.evidenceSeries = null; this.evidenceSeriesSegments = []; this.evidenceFilter = undefined
      this.evidenceRowsFilter = undefined
      this.evidenceSeriesContext = null; this.evidenceSeriesLastCursor = null; this.evidenceSeriesInflightCursor = null; this.evidenceSeriesInflightGen = 0
      const requestToken = this.beginEvidenceRequest('overview', epoch)
      try {
        const params = new URLSearchParams({ resultId: source.resultId })
        if (sourceSha256 !== undefined) params.set('sourceSha256', sourceSha256)
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/reports/${encodeURIComponent(report.reportId)}/evidence?${params}`, { headers: { 'X-Demo-Role': useAuthStore().role } })
        const overview = await readSuccess(response, isEvidenceOverviewView)
        if (epoch !== this.evidenceEpoch) return false
        if (overview.resultId !== source.resultId) throw new Error('证据来源与当前结果不一致。')
        // 维持完整来源目录：未选中时以响应为目录；选中时保留既有目录、更新命中项，避免下拉缩成单项。
        const catalog = mergeEvidenceSources(sourceSha256 === undefined ? [] : this.evidenceSourcesCatalog, overview.sources)
        this.evidenceSourcesCatalog = catalog
        this.evidenceOverview = { ...overview, sources: catalog }
        return true
      } catch (error) {
        if (epoch !== this.evidenceEpoch) return false
        this.evidenceMessage = error instanceof Error ? error.message : '报告证据概览读取失败。'
        return false
      } finally {
        this.endEvidenceRequest(requestToken)
      }
    },

    /** D3：加载指定 kind 的游标分页明细；错源/错筛选游标由服务端 422，不静默回首页。 */
    async loadEvidenceRows(kind: string, options: { cursor?: string; limit?: number; filter?: LocalReportFilter } = {}): Promise<boolean> {
      const source = this.resultSource, report = this.selectedReport, sha = this.evidenceOverview?.selectedSourceSha256
      if (!source || !report?.localEvidence || !sha) return false
      const epoch = this.evidenceEpoch
      const ownRowsEpoch = ++this.evidenceRowsEpoch
      const requestToken = this.beginEvidenceRequest('rows', ownRowsEpoch)
      try {
        const params = new URLSearchParams({ resultId: source.resultId, sourceSha256: sha, kind })
        for (const [key, value] of Object.entries(options.filter ?? {})) if (value !== undefined) params.set(key, String(value))
        if (options.limit !== undefined) params.set('limit', String(options.limit))
        if (options.cursor !== undefined) params.set('cursor', options.cursor)
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/reports/${encodeURIComponent(report.reportId)}/evidence/rows?${params}`, { headers: { 'X-Demo-Role': useAuthStore().role } })
        const rows = await readSuccess(response, isEvidenceRowsView)
        if (epoch !== this.evidenceEpoch || ownRowsEpoch !== this.evidenceRowsEpoch) return false
        if (rows.sourceSha256 !== sha || rows.resultId !== source.resultId) throw new Error('证据明细来源与当前选择不一致。')
        // 明细只更新自身过滤快照，绝不改写曲线首段上下文。
        this.evidenceRows = rows
        this.evidenceRowsFilter = options.filter
        return true
      } catch (error) {
        if (epoch !== this.evidenceEpoch || ownRowsEpoch !== this.evidenceRowsEpoch) return false
        this.evidenceMessage = error instanceof Error ? error.message : '报告证据明细读取失败。'
        return false
      } finally {
        this.endEvidenceRequest(requestToken)
      }
    },

    /** D3：加载有界曲线首段；固化不可变上下文，续页只用该快照。 */
    async loadEvidenceSeries(seriesId: string, options: { maxPoints?: number; cursor?: string; filter?: LocalReportFilter } = {}): Promise<boolean> {
      const source = this.resultSource, report = this.selectedReport, sha = this.evidenceOverview?.selectedSourceSha256
      if (!source || !report?.localEvidence || !sha) return false
      const epoch = this.evidenceEpoch
      const maxPoints = options.maxPoints ?? this.evidenceSeriesMaxPoints
      this.evidenceSeriesMaxPoints = maxPoints
      this.evidenceSeriesEpoch += 1
      const ownSeriesEpoch = this.evidenceSeriesEpoch
      // 新的首段重置续页去重状态，旧曲线请求因 epoch 变化失效。
      this.evidenceSeriesLastCursor = null
      this.evidenceSeriesInflightCursor = null
      this.evidenceSeriesInflightGen = 0
      const requestToken = this.beginEvidenceRequest('series', ownSeriesEpoch)
      try {
        const params = new URLSearchParams({ resultId: source.resultId, sourceSha256: sha, seriesId })
        for (const [key, value] of Object.entries(options.filter ?? {})) if (value !== undefined) params.set(key, String(value))
        params.set('maxPoints', String(maxPoints))
        if (options.cursor !== undefined) params.set('cursor', options.cursor)
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/reports/${encodeURIComponent(report.reportId)}/evidence/series?${params}`, { headers: { 'X-Demo-Role': useAuthStore().role } })
        const series = await readSuccess(response, isEvidenceSeriesView)
        if (epoch !== this.evidenceEpoch || ownSeriesEpoch !== this.evidenceSeriesEpoch) return false
        if (series.sourceSha256 !== sha || series.resultId !== source.resultId) throw new Error('证据曲线来源与当前选择不一致。')
        this.evidenceSeries = series
        this.evidenceSeriesSegments = [series.points]
        this.evidenceFilter = options.filter
        this.evidenceSeriesContext = {
          reportId: report.reportId, resultId: source.resultId, runId: source.runId ?? '',
          sourceSha256: sha, seriesId: series.seriesId, kind: series.kind, unit: series.unit,
          filter: options.filter, maxPoints, cursor: options.cursor,
        }
        return true
      } catch (error) {
        if (epoch !== this.evidenceEpoch || ownSeriesEpoch !== this.evidenceSeriesEpoch) return false
        this.evidenceMessage = error instanceof Error ? error.message : '报告证据曲线读取失败。'
        return false
      } finally {
        this.endEvidenceRequest(requestToken)
      }
    },

    /**
     * D3：加载曲线下一段并追加；只存当前页（≤预算），分段保留完整顺序。
     * 同一游标在途时阻断第二个 HTTP，不提前关闭 loading；成功后该游标不会重复追加。
     */
    async loadNextEvidenceSeries(): Promise<boolean> {
      const context = this.evidenceSeriesContext
      const current = this.evidenceSeries
      if (!context || !current || current.nextCursor === null) return false
      if (current.seriesId !== context.seriesId) return false
      const cursor = current.nextCursor
      // 同一有效游标并发：第二个调用不再发 HTTP，也不改动 loading。
      if (this.evidenceSeriesLastCursor === cursor) return false
      // 同一有效代际的相同在途游标才去重；旧代际在途标记不阻止新代际请求。
      if (this.evidenceSeriesInflightCursor === cursor && this.evidenceSeriesInflightGen === this.evidenceSeriesEpoch) return false
      const epoch = this.evidenceEpoch
      const seriesEpoch = this.evidenceSeriesEpoch
      this.evidenceSeriesInflightCursor = cursor
      this.evidenceSeriesInflightGen = seriesEpoch
      const requestToken = this.beginEvidenceRequest('next', seriesEpoch)
      try {
        const params = new URLSearchParams({
          resultId: context.resultId, sourceSha256: context.sourceSha256, seriesId: context.seriesId,
          maxPoints: String(context.maxPoints), cursor,
        })
        for (const [key, value] of Object.entries(context.filter ?? {})) if (value !== undefined) params.set(key, String(value))
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/reports/${encodeURIComponent(context.reportId)}/evidence/series?${params}`, { headers: { 'X-Demo-Role': useAuthStore().role } })
        const next = await readSuccess(response, isEvidenceSeriesView)
        if (epoch !== this.evidenceEpoch || seriesEpoch !== this.evidenceSeriesEpoch) return false
        if (next.seriesId !== context.seriesId || next.sourceSha256 !== context.sourceSha256 || next.resultId !== context.resultId) {
          throw new Error('证据曲线续页与当前选择不一致。')
        }
        // 二次去重：即便同一游标再次到达也不追加第二份相同分段。
        if (this.evidenceSeriesLastCursor === cursor) return false
        this.evidenceSeries = next // 只存当前页(≤预算)，不累计扁平数组
        this.evidenceSeriesSegments = [...this.evidenceSeriesSegments, next.points]
        this.evidenceSeriesLastCursor = cursor
        return true
      } catch (error) {
        if (epoch !== this.evidenceEpoch || seriesEpoch !== this.evidenceSeriesEpoch) return false
        this.evidenceMessage = error instanceof Error ? error.message : '报告证据曲线续页读取失败。'
        return false
      } finally {
        if (this.evidenceSeriesInflightCursor === cursor && this.evidenceSeriesInflightGen === seriesEpoch) this.evidenceSeriesInflightCursor = null
        this.endEvidenceRequest(requestToken)
      }
    },

    /** D3：导出全部筛选时段证据（HTML/PDF），download=1 走受控文件响应，真实浏览器下载；失败不返回伪成功文件。 */
    async exportEvidence(format: 'HTML' | 'PDF', filter?: LocalReportFilter): Promise<boolean> {
      const source = this.resultSource, report = this.selectedReport, sha = this.evidenceOverview?.selectedSourceSha256
      if (!source || !report?.localEvidence || !sha) { this.showError(undefined, '请先选择证据来源。', 'EMPTY'); return false }
      const epoch = this.evidenceEpoch
      const requestToken = this.beginEvidenceRequest('export', 0)
      try {
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/reports/${encodeURIComponent(report.reportId)}/evidence/export?download=1`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Role': useAuthStore().role },
          body: JSON.stringify({ resultId: source.resultId, sourceSha256: sha, format, filter: filter ?? {} }),
        })
        if (epoch !== this.evidenceEpoch) return false
        // 复用普通报告受控下载：仅接受带 Content-Disposition: attachment 的认证附件，不接受服务端磁盘路径。
        if (!await saveDownload(response, `${source.resultId}.evidence.${format.toLowerCase()}`, () => epoch === this.evidenceEpoch)) return false
        this.evidenceMessage = `证据已导出并开始下载：${format}`
        return true
      } catch (error) {
        if (epoch !== this.evidenceEpoch) return false
        this.evidenceMessage = error instanceof Error ? error.message : '报告证据导出失败。'
        return false
      } finally {
        this.endEvidenceRequest(requestToken)
      }
    },

    /** 将错误转换为安全中文反馈并清除可能过期的当前报告内容。 */
    showError(error: unknown, fallback: string, code?: string): void {
      const failure = readApiFailure(error)
      this.selectedReport = null
      this.exportResult = null
      this.capabilityState = 'ERROR'
      this.resultCode = code ?? failure?.error.code ?? 'REPORT_ERROR'
      this.resultMessage = failure?.error.message ?? (error instanceof Error ? error.message : fallback)
    },

    /** 全局重置前阻止旧导出响应回写。 */
    invalidateConfirmation(): void {
      this.requestEpoch += 1
      this.exportResult = null
    },

    /** 清除报告和导出结果，恢复安全空态。 */
    resetToSafeEmpty(): void {
      this.resultSource = null
      this.archiveId = null
      this.resultComparisons = []
      this.comparisonsEpoch += 1
      this.comparisonsLoading = false
      this.comparisonsLoaded = false
      this.localFilterResult = null
      this.requestEpoch += 1
      this.reports = []
      this.selectedReport = null
      this.capabilityState = 'EMPTY'
      this.resultCode = 'EMPTY'
      this.resultMessage = '尚未加载报告。'
      this.exportResult = null
      this.evidenceOverview = null
      this.evidenceRows = null
      this.evidenceSeries = null
      this.evidenceSeriesSegments = []
      this.evidenceFilter = undefined
      this.evidenceRowsFilter = undefined
      this.evidenceSeriesContext = null
      this.evidenceSeriesLastCursor = null
      this.evidenceSeriesInflightCursor = null
      this.evidenceSourcesCatalog = []
      this.evidenceActiveTokens = []
      this.evidenceActiveRequests = 0
      this.evidenceLoading = false
      this.evidenceMessage = ''
      this.evidenceEpoch += 1
      this.evidenceRowsEpoch += 1
      this.evidenceSeriesEpoch += 1
      this.evidenceLoadingEpoch = this.evidenceEpoch
    },
  },
})

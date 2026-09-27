import { apiFetch } from '../features/shared/api-fetch'
import { saveDownload } from '../features/shared/download'
import { isMissionResultSnapshot, type MissionResultRecord } from '../features/results/mission-result'
import { defineStore } from 'pinia'
import type {
  CapabilityState,
  ConfirmationContext,
  Report,
  ReportExportRequest,
  ReportExportResult,
  LocalReportExportResult,
} from '../contracts/domain-models'
import { resolveMockOrigin, useAuthStore } from './auth'
import { readApiFailure, unwrapSuccessData } from './api-envelope'
import { isLocalReport, isLocalReportExport } from '../features/reports/local-report'
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

/** 校验服务端返回的单次或批量聚合报告。 */
export function isReport(value: unknown): value is Report {
  if (isLocalReport(value)) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const report = value as Partial<Report>
  const keys = Object.keys(value)
  return keys.every((key) => ['reportId', 'runId', 'batchId', 'classification', 'generatedTime', 'status', 'kpis', 'timeSeries'].includes(key))
    && typeof report.reportId === 'string' && report.reportId.startsWith('RPT-')
    && (report.runId === undefined || (typeof report.runId === 'string' && report.runId.startsWith('RUN-')))
    && (report.batchId === undefined || (typeof report.batchId === 'string' && report.batchId.length > 0))
    && (report.classification === 'LEVEL_II' || report.classification === 'LEVEL_III')
    && typeof report.generatedTime === 'string'
    && report.status === 'READY'
    && (report.kpis === undefined || isReportKpis(report.kpis))
    && (report.timeSeries === undefined || (Array.isArray(report.timeSeries)
      && report.timeSeries.length > 0 && report.timeSeries.every(isReportTimeSeries)))
    && ((report.runId !== undefined) !== (report.batchId !== undefined))
    && (report.runId === undefined || report.timeSeries !== undefined)
}

/** 校验一次性确认上下文的关键字段。 */
function isConfirmation(value: unknown, state: ConfirmationContext['state']): value is ConfirmationContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const context = value as Partial<ConfirmationContext>
  return typeof context.confirmationId === 'string' && context.confirmationId.length > 0
    && context.state === state
    && (context.role === 'ADMIN' || context.role === 'OPERATOR')
    && typeof context.actor === 'string'
    && typeof context.createdAt === 'string'
    && typeof context.expiresAt === 'string'
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

/** 读取统一成功信封并按调用方提供的规则校验业务数据。 */
async function readSuccess<T>(response: Response, validate: (value: unknown) => value is T): Promise<T> {
  const payload = await response.json() as unknown
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
    confirmation: null as ConfirmationContext | null,
    pendingFormat: null as ExportFormat | null,
    exportResult: null as ReportExportResult | LocalReportExportResult | null,
    requestEpoch: 0,
    archiveId: null as string | null,
    resultSource: null as MissionResultRecord | null,
  }),

  actions: {
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
    async loadArchive(archiveId: string): Promise<boolean> {
      this.resetToSafeEmpty()
      const epoch = this.requestEpoch
      this.archiveId = archiveId
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
     * @sideEffects 清除旧导出确认和结果；失败时清空当前报告，杜绝单次与批量数据混用。
     */
    async selectReport(reportId: string): Promise<boolean> {
      if (this.resultSource !== null) return this.loadResult(this.resultSource.resultId)
      if (this.archiveId !== null) return this.loadArchive(this.archiveId)
      const epoch = this.requestEpoch
      this.capabilityState = 'LOADING'
      this.confirmation = null
      this.pendingFormat = null
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

    /**
     * 发起导出验证；三级报告先创建一次性确认，二级报告直接验证。
     * @param format 用户选择的导出格式。
     * @returns 请求进入确认或直接验证成功时返回 `true`。
     * @sideEffects 本地报告由服务端生成文件；纯 Mock 只更新导出验证结果。
     */
    async requestExport(format: ExportFormat): Promise<boolean> {
      const report = this.selectedReport
      if (report === null) {
        this.showError(undefined, '请先选择报告。', 'EMPTY')
        return false
      }
      if (report.classification === 'LEVEL_II') return this.exportNow(format)
      if (useAuthStore().role !== 'ADMIN') {
        this.showError(undefined, '当前账号没有三级批量报告导出权限。', 'PERMISSION_DENIED')
        return false
      }

      const epoch = this.requestEpoch
      this.capabilityState = 'EXECUTING'
      try {
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/confirmations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': 'ADMIN' },
          body: JSON.stringify({ action: 'BATCH_LEVEL_III_EXPORT', objectId: report.reportId }),
        })
        const confirmation = await readSuccess(response, (value): value is ConfirmationContext => (
          isConfirmation(value, 'AWAITING_CONFIRMATION') && value.role === 'ADMIN'
        ))
        if (epoch !== this.requestEpoch) return false
        this.confirmation = confirmation
        this.pendingFormat = format
        this.capabilityState = 'SUCCESS'
        this.resultCode = 'CONFIRMATION_REQUIRED'
        this.resultMessage = '三级批量报告需要二次确认。'
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.showError(error, '导出确认创建失败。')
        return false
      }
    },

    /**
     * 确认并消费当前三级报告的一次性确认。
     * @returns 确认和导出验证均成功时返回 `true`。
     * @sideEffects 更新确认状态、导出结果和中文反馈，不生成文件。
     */
    async confirmExport(): Promise<boolean> {
      if (this.confirmation === null || this.pendingFormat === null) return false
      const epoch = this.requestEpoch
      this.capabilityState = 'EXECUTING'
      try {
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/confirmations/${encodeURIComponent(this.confirmation.confirmationId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': 'ADMIN' },
          body: JSON.stringify({ confirm: true }),
        })
        const confirmation = await readSuccess(response, (value): value is ConfirmationContext => (
          isConfirmation(value, 'CONFIRMED') && value.role === 'ADMIN'
        ))
        if (epoch !== this.requestEpoch) return false
        this.confirmation = confirmation
        return await this.exportNow(this.pendingFormat, this.confirmation.confirmationId)
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.showError(error, '导出确认失败。')
        return false
      }
    },

    /** 取消当前导出确认并清除未完成的格式选择。 */
    cancelConfirmation(): void {
      this.confirmation = null
      this.pendingFormat = null
      this.resultCode = 'CANCELLED'
      this.resultMessage = '已取消导出验证。'
    },

    /**
     * 调用导出接口；本地报告生成文件，纯 Mock 只验证合同。
     * @param format 需要验证的格式。
     * @param confirmationId 三级报告已确认的一次性编号。
     * @returns 固定验证结果有效时返回 `true`。
     */
    async exportNow(format: ExportFormat, confirmationId?: string): Promise<boolean> {
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
          body: JSON.stringify({ reportId: report.reportId, format, ...(confirmationId === undefined ? {} : { confirmationId }) }),
        })
        if (report.localEvidence) {
          if (!await saveDownload(response, `${this.resultSource?.resultId ?? report.reportId}.${format.toLowerCase()}`, () => epoch === this.requestEpoch)) return false
          this.exportResult = null
          this.confirmation = null
          this.pendingFormat = null
          this.capabilityState = 'SUCCESS'
          this.resultCode = 'SUCCESS'
          this.resultMessage = '已发起报告下载，请在浏览器下载记录中查看。'
          return true
        }
        const result = await readSuccess(response, isExportResult)
        if (epoch !== this.requestEpoch) return false
        if (result.reportId !== report.reportId || result.generated) throw new Error('导出结果与当前报告不一致。')
        this.exportResult = result
        this.confirmation = null
        this.pendingFormat = null
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

    /** 将错误转换为安全中文反馈并清除可能过期的当前报告内容。 */
    showError(error: unknown, fallback: string, code?: string): void {
      const failure = readApiFailure(error)
      this.selectedReport = null
      this.confirmation = null
      this.pendingFormat = null
      this.exportResult = null
      this.capabilityState = 'ERROR'
      this.resultCode = code ?? failure?.error.code ?? 'REPORT_ERROR'
      this.resultMessage = failure?.error.message ?? (error instanceof Error ? error.message : fallback)
    },

    /** 全局重置前取消确认，并阻止旧导出响应回写。 */
    invalidateConfirmation(): void {
      this.requestEpoch += 1
      this.confirmation = null
      this.pendingFormat = null
      this.exportResult = null
    },

    /** 清除报告、确认和导出结果，恢复安全空态。 */
    resetToSafeEmpty(): void {
      this.resultSource = null
      this.archiveId = null
      this.requestEpoch += 1
      this.reports = []
      this.selectedReport = null
      this.capabilityState = 'EMPTY'
      this.resultCode = 'EMPTY'
      this.resultMessage = '尚未加载报告。'
      this.confirmation = null
      this.pendingFormat = null
      this.exportResult = null
    },
  },
})

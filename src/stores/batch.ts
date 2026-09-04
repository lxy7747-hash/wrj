import { defineStore } from 'pinia'
import type {
  ApiFailure,
  Batch,
  BatchCommand,
  BatchRequest,
  BatchRunResult,
  CapabilityState,
  Report,
} from '../contracts/domain-models'
import { resolveMockOrigin, useAuthStore } from './auth'
import { isReport } from './report'

export interface BatchDetail {
  batch: Batch
  runs: BatchRunResult[]
  aggregateReport: Report
}

const BATCH_STATES = new Set<Batch['state']>([
  'DRAFT', 'VALIDATING', 'QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL_FAILURE', 'CANCELLED', 'ERROR',
])
const FROZEN_POWERS_W = [50, 100, 150, 200]
const FROZEN_DISTANCES_KM = [80, 100, 120]

/** 判断输入是否为当前固定证据支持的参数矩阵。 */
function sameNumbers(actual: number[], expected: number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

/** 从未知载荷中读取 API 失败信封。 */
function readFailure(value: unknown): ApiFailure | undefined {
  if (typeof value !== 'object' || value === null || (value as { ok?: unknown }).ok !== false) return undefined
  const error = (value as { error?: { code?: unknown; message?: unknown } }).error
  return typeof error?.code === 'string' && typeof error.message === 'string' ? value as ApiFailure : undefined
}

/** 校验批次基础信息的闭合字段和运行/报告编号。 */
export function isBatch(value: unknown): value is Batch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const batch = value as Partial<Batch>
  return Object.keys(value).length === 5
    && typeof batch.batchId === 'string' && batch.batchId.startsWith('BATCH-')
    && typeof batch.state === 'string' && BATCH_STATES.has(batch.state as Batch['state'])
    && Array.isArray(batch.runIds) && batch.runIds.every((id) => typeof id === 'string' && id.startsWith('RUN-'))
    && Array.isArray(batch.reportIds) && batch.reportIds.every((id) => typeof id === 'string' && id.startsWith('RPT-'))
    && new Set(batch.runIds).size === batch.runIds.length
    && new Set(batch.reportIds).size === batch.reportIds.length
    && typeof batch.aggregateReportId === 'string' && batch.aggregateReportId.startsWith('RPT-')
}

/** 校验一行批量运行结果及其单位边界。 */
export function isBatchRunResult(value: unknown): value is BatchRunResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  const numberKeys = [
    'powerW', 'distanceKm', 'connectivityDurationS', 'connectivityRate', 'switchCount',
    'avgBer', 'maxBer', 'avgSnrDb', 'minSnrDb', 'interferenceDurationS',
  ]
  return Object.keys(value).length === 13
    && typeof result.runId === 'string' && result.runId.startsWith('RUN-')
    && typeof result.reportId === 'string' && result.reportId.startsWith('RPT-')
    && numberKeys.every((key) => typeof result[key] === 'number' && Number.isFinite(result[key]))
    && Number(result.powerW) >= 0 && Number(result.distanceKm) >= 0
    && Number(result.connectivityDurationS) >= 0
    && Number(result.connectivityRate) >= 0 && Number(result.connectivityRate) <= 100
    && Number.isInteger(result.switchCount) && Number(result.switchCount) >= 0
    && Number(result.avgBer) >= 0 && Number(result.avgBer) <= 1
    && Number(result.maxBer) >= 0 && Number(result.maxBer) <= 1
    && Number(result.interferenceDurationS) >= 0
    && (result.status === 'COMPLETED' || result.status === 'ERROR')
}

/** 校验 BATCH-001 详情中的 12 个运行/报告一一对应关系。 */
export function isBatchDetail(value: unknown): value is BatchDetail {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const detail = value as Partial<BatchDetail>
  if (Object.keys(value).length !== 3 || !isBatch(detail.batch) || !Array.isArray(detail.runs)
    || detail.runs.length !== 12 || !detail.runs.every(isBatchRunResult) || !isReport(detail.aggregateReport)) return false
  const hasCompleted = detail.runs.some((run) => run.status === 'COMPLETED')
  const hasError = detail.runs.some((run) => run.status === 'ERROR')
  const stateMatchesRuns = detail.batch.state === 'COMPLETED' ? !hasError
    : detail.batch.state === 'PARTIAL_FAILURE' && hasCompleted && hasError
  return stateMatchesRuns
    && detail.batch.runIds.length === 12
    && detail.batch.reportIds.length === 12
    && detail.runs.every((run, index) => run.runId === detail.batch!.runIds[index]
      && run.reportId === detail.batch!.reportIds[index])
    && detail.aggregateReport.reportId === detail.batch.aggregateReportId
    && detail.aggregateReport.batchId === detail.batch.batchId
    && detail.aggregateReport.classification === 'LEVEL_III'
}

/** 读取统一成功信封并校验业务数据。 */
async function readSuccess<T>(response: Response, validate: (value: unknown) => value is T): Promise<T> {
  const payload = await response.json() as unknown
  if (!response.ok) throw readFailure(payload) ?? new Error('批量仿真服务响应错误。')
  const data = typeof payload === 'object' && payload !== null && (payload as { ok?: unknown }).ok === true
    ? (payload as { data?: unknown }).data
    : undefined
  if (!validate(data)) throw new Error('批量仿真数据格式不正确。')
  return data
}

export const useBatchStore = defineStore('batch', {
  state: () => ({
    form: {
      scenarioId: 'SCN-001',
      powersW: [50, 100, 150, 200],
      distancesKm: [80, 100, 120],
      deterministicOrder: true,
    } as BatchRequest,
    batch: null as Batch | null,
    runs: [] as BatchRunResult[],
    aggregateReport: null as Report | null,
    selectedRunId: null as string | null,
    capabilityState: 'EMPTY' as CapabilityState,
    resultCode: 'EMPTY',
    resultMessage: '尚未加载批量仿真。',
    validationIssues: [] as string[],
    requestEpoch: 0,
  }),

  actions: {
    /**
     * 校验批量参数矩阵。
     * @returns 场景编号、非负参数和 12 个组合均有效时返回 `true`。
     */
    validate(): boolean {
      this.capabilityState = 'VALIDATING'
      const issues: string[] = []
      if (!this.form.scenarioId.startsWith('SCN-')) issues.push('场景编号必须以 SCN- 开头。')
      for (const [label, values] of [['发射功率', this.form.powersW], ['通信距离', this.form.distancesKm]] as const) {
        if (values.length === 0) issues.push(`${label}至少填写一项。`)
        if (values.some((value) => !Number.isFinite(value) || value < 0)) issues.push(`${label}必须为非负数值。`)
      }
      if (this.form.powersW.length * this.form.distancesKm.length !== 12) issues.push('当前批次必须形成 12 个参数组合。')
      if (!sameNumbers(this.form.powersW, FROZEN_POWERS_W)
        || !sameNumbers(this.form.distancesKm, FROZEN_DISTANCES_KM)) {
        issues.push('本阶段只支持固定的 50/100/150/200 W × 80/100/120 km 参数矩阵。')
      }
      this.validationIssues = issues
      this.capabilityState = issues.length === 0 ? 'SUCCESS' : 'ERROR'
      this.resultCode = issues.length === 0 ? 'VALID' : 'VALIDATION_FAILED'
      this.resultMessage = issues.length === 0 ? '批量参数校验通过。' : '批量参数校验未通过。'
      return issues.length === 0
    },

    /**
     * 创建通过本地校验的确定性批次。
     * @returns 服务端接受请求时返回 `true`。
     */
    async create(): Promise<boolean> {
      if (!this.validate()) return false
      const epoch = this.requestEpoch
      this.capabilityState = 'EXECUTING'
      try {
        const response = await fetch(`${resolveMockOrigin()}/api/v1/batches`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': useAuthStore().role },
          body: JSON.stringify(this.form),
        })
        const batch = await readSuccess(response, isBatch)
        if (epoch !== this.requestEpoch) return false
        this.batch = structuredClone(batch)
        this.runs = []
        this.aggregateReport = null
        this.selectedRunId = null
        this.capabilityState = 'SUCCESS'
        this.resultCode = 'QUEUED'
        this.resultMessage = '批量任务已创建并进入排队状态。'
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.showError(error, '批量任务创建失败。')
        return false
      }
    },

    /**
     * 执行 START 或 CANCEL 命令。
     * @param command 冻结合同允许的批量控制命令。
     * @returns 命令成功并完成必要详情刷新时返回 `true`。
     */
    async command(command: BatchCommand['command']): Promise<boolean> {
      if (this.batch === null) return false
      const epoch = this.requestEpoch
      this.capabilityState = 'EXECUTING'
      try {
        const response = await fetch(`${resolveMockOrigin()}/api/v1/batches/${encodeURIComponent(this.batch.batchId)}/commands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': useAuthStore().role },
          body: JSON.stringify({ command }),
        })
        const batch = await readSuccess(response, isBatch)
        if (epoch !== this.requestEpoch) return false
        this.batch = structuredClone(batch)
        if (batch.state === 'COMPLETED') return await this.loadComparison(batch.batchId)
        this.capabilityState = 'SUCCESS'
        this.resultCode = batch.state
        this.resultMessage = batch.state === 'CANCELLED' ? '批量任务已取消。' : '批量任务状态已更新。'
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.showError(error, '批量任务控制失败。')
        return false
      }
    },

    /**
     * 加载批次目录和 12 行对比数据。
     * @param batchId 可选的目标编号；缺省时选择目录首项。
     * @returns 批次详情及一一对应关系有效时返回 `true`。
     */
    async loadComparison(batchId?: string): Promise<boolean> {
      const epoch = this.requestEpoch
      this.capabilityState = 'LOADING'
      try {
        let selectedId = batchId
        let listedBatch: Batch | undefined
        if (selectedId === undefined) {
          const listResponse = await fetch(`${resolveMockOrigin()}/api/v1/batches`, {
            headers: { 'X-Demo-Role': useAuthStore().role },
          })
          const batches = await readSuccess(listResponse, (value): value is Batch[] => Array.isArray(value) && value.every(isBatch))
          if (epoch !== this.requestEpoch) return false
          if (batches.length === 0) {
            this.resetToSafeEmpty()
            return true
          }
          listedBatch = batches[0]!
          selectedId = listedBatch.batchId
        }
        if (listedBatch !== undefined && listedBatch.state !== 'COMPLETED' && listedBatch.state !== 'PARTIAL_FAILURE') {
          this.batch = structuredClone(listedBatch)
          this.runs = []
          this.aggregateReport = null
          this.selectedRunId = null
          this.capabilityState = 'SUCCESS'
          this.resultCode = listedBatch.state
          this.resultMessage = '批次尚未形成可读取的运行结果。'
          return true
        }
        const detailResponse = await fetch(`${resolveMockOrigin()}/api/v1/batches/${encodeURIComponent(selectedId)}`, {
          headers: { 'X-Demo-Role': useAuthStore().role },
        })
        if (epoch !== this.requestEpoch) return false
        this.capabilityState = 'VALIDATING'
        const detail = await readSuccess(detailResponse, isBatchDetail)
        if (epoch !== this.requestEpoch) return false
        if (detail.batch.batchId !== selectedId) throw new Error('批次详情与请求编号不一致。')
        this.batch = structuredClone(detail.batch)
        this.runs = structuredClone(detail.runs)
        this.aggregateReport = structuredClone(detail.aggregateReport)
        this.selectedRunId = detail.runs[0]?.runId ?? null
        this.capabilityState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = '已加载 12 个运行与报告的一一对应结果。'
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.showError(error, '批量结果加载失败。')
        return false
      }
    },

    /** 将错误转换为中文反馈并清空不可信结果。 */
    showError(error: unknown, fallback: string): void {
      const failure = readFailure(error)
      this.batch = null
      this.runs = []
      this.aggregateReport = null
      this.selectedRunId = null
      this.capabilityState = 'ERROR'
      this.resultCode = failure?.error.code ?? 'BATCH_ERROR'
      this.resultMessage = failure?.error.message ?? (error instanceof Error ? error.message : fallback)
    },

    /** 清除批次运行结果并恢复默认参数矩阵。 */
    resetToSafeEmpty(): void {
      this.requestEpoch += 1
      this.form = { scenarioId: 'SCN-001', powersW: [50, 100, 150, 200], distancesKm: [80, 100, 120], deterministicOrder: true }
      this.batch = null
      this.runs = []
      this.aggregateReport = null
      this.selectedRunId = null
      this.capabilityState = 'EMPTY'
      this.resultCode = 'EMPTY'
      this.resultMessage = '尚未加载批量仿真。'
      this.validationIssues = []
    },
  },
})

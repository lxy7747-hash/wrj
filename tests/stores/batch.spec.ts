import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ApiFailure, Batch, Principal } from '../../src/contracts/domain-models'
import { isBatch, isBatchDetail, isBatchRunResult, useBatchStore } from '../../src/stores/batch'
import { useAuthStore } from '../../src/stores/auth'

const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR',
  permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'],
}

/** 创建批量 Store 测试使用的成功响应。 */
function success(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

/** 创建批量 Store 测试使用的失败响应。 */
function failure(): Response {
  const body: ApiFailure = {
    ok: false,
    error: { code: 'INVALID_TRANSITION', message: '当前状态不允许操作。', retryable: false, correlationId: 'CORR-P6-BATCH' },
    meta: { requestId: 'REQ-P6-BATCH', generatedAt: '2026-08-06T08:00:00Z' },
  }
  return { ok: false, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}

const detail = {
  batch: fixtureSource.batch,
  runs: fixtureSource.batchRuns,
  aggregateReport: fixtureSource.batchAggregateReport,
}

describe('P6 批量仿真 Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('校验批次、运行行与 12 对详情合同', () => {
    expect(isBatch(fixtureSource.batch)).toBe(true)
    expect(isBatchRunResult(fixtureSource.batchRuns[0])).toBe(true)
    expect(isBatchDetail(detail)).toBe(true)
    for (const invalid of [null, {}, { ...fixtureSource.batch, batchId: 'BAD' }, {
      ...fixtureSource.batch, runIds: [...fixtureSource.batch.runIds, fixtureSource.batch.runIds[0]],
    }, { ...fixtureSource.batch, state: 'BAD' }]) expect(isBatch(invalid)).toBe(false)
    for (const invalid of [null, {}, { ...fixtureSource.batchRuns[0], runId: 'BAD' }, {
      ...fixtureSource.batchRuns[0], connectivityRate: 101,
    }, { ...fixtureSource.batchRuns[0], switchCount: 1.5 }, { ...fixtureSource.batchRuns[0], status: 'RUNNING' }]) {
      expect(isBatchRunResult(invalid)).toBe(false)
    }
    expect(isBatchDetail({ ...detail, runs: detail.runs.slice(1) })).toBe(false)
    expect(isBatchDetail({ ...detail, runs: detail.runs.map((run, index) => index === 0 ? { ...run, reportId: 'RPT-WRONG' } : run) })).toBe(false)
    expect(isBatchDetail({ ...detail, aggregateReport: { ...detail.aggregateReport, classification: 'LEVEL_II' } })).toBe(false)
    const runsWithFailure = detail.runs.map((run, index) => index === 0 ? { ...run, status: 'ERROR' as const } : run)
    expect(isBatchDetail({ ...detail, runs: runsWithFailure })).toBe(false)
    expect(isBatchDetail({ ...detail, batch: { ...detail.batch, state: 'PARTIAL_FAILURE' } })).toBe(false)
    expect(isBatchDetail({ ...detail, batch: { ...detail.batch, state: 'PARTIAL_FAILURE' }, runs: runsWithFailure })).toBe(true)
  })

  it('校验默认 12 组合并拒绝空、负数和错误场景', () => {
    const store = useBatchStore()
    expect(store.validate()).toBe(true)
    expect(store.resultCode).toBe('VALID')

    store.form.powersW = [1, 2, 3]
    store.form.distancesKm = [4, 5, 6, 7]
    expect(store.validate()).toBe(false)
    expect(store.validationIssues.join()).toContain('本阶段只支持固定')

    store.form.scenarioId = 'BAD' as `SCN-${string}`
    store.form.powersW = []
    store.form.distancesKm = [-1, -1]
    expect(store.validate()).toBe(false)
    expect(store.validationIssues.join()).toMatch(/场景编号|至少填写|非负|12 个/)
  })

  it('加载固定批次、选择首行并处理空目录和损坏数据', async () => {
    const store = useBatchStore()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(success([fixtureSource.batch]))
      .mockResolvedValueOnce(success(detail))
      .mockResolvedValueOnce(success([]))
      .mockResolvedValueOnce(success([fixtureSource.batch]))
      .mockResolvedValueOnce(success({ ...detail, runs: detail.runs.slice(1) })))

    await expect(store.loadComparison()).resolves.toBe(true)
    expect(store).toMatchObject({ selectedRunId: 'RUN-B01', capabilityState: 'SUCCESS' })
    expect(store.runs).toHaveLength(12)
    await expect(store.loadComparison()).resolves.toBe(true)
    expect(store.capabilityState).toBe('EMPTY')
    await expect(store.loadComparison()).resolves.toBe(false)
    expect(store).toMatchObject({ batch: null, runs: [], capabilityState: 'ERROR', resultCode: 'BATCH_ERROR' })
  })

  it('非终态批次不请求或展示运行结果', async () => {
    const store = useBatchStore()
    const queued = { ...fixtureSource.batch, state: 'QUEUED' } as Batch
    const fetchSpy = vi.fn().mockResolvedValueOnce(success([queued]))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(store.loadComparison()).resolves.toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(store).toMatchObject({ batch: queued, runs: [], aggregateReport: null, resultCode: 'QUEUED' })
  })

  it('创建、启动并刷新完成结果，也支持取消和服务错误', async () => {
    const store = useBatchStore()
    const queued = { ...fixtureSource.batch, state: 'QUEUED' } as Batch
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(success(queued))
      .mockResolvedValueOnce(success(fixtureSource.batch))
      .mockResolvedValueOnce(success(detail))
      .mockResolvedValueOnce(success(queued))
      .mockResolvedValueOnce(success({ ...queued, state: 'CANCELLED' }))
      .mockResolvedValueOnce(failure()))

    await expect(store.create()).resolves.toBe(true)
    expect(store.batch?.state).toBe('QUEUED')
    await expect(store.command('START')).resolves.toBe(true)
    expect(store.runs).toHaveLength(12)
    await expect(store.create()).resolves.toBe(true)
    await expect(store.command('CANCEL')).resolves.toBe(true)
    expect(store.batch?.state).toBe('CANCELLED')
    await expect(store.create()).resolves.toBe(false)
    expect(store.resultCode).toBe('INVALID_TRANSITION')
  })

  it('不在无批次时发命令，并忽略重置前的迟到响应', async () => {
    const store = useBatchStore()
    await expect(store.command('START')).resolves.toBe(false)
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveResponse = resolve })))
    const pending = store.loadComparison('BATCH-001')
    store.resetToSafeEmpty()
    resolveResponse(success(detail))
    await expect(pending).resolves.toBe(false)
    expect(store.capabilityState).toBe('EMPTY')
  })
})

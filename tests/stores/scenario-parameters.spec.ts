import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiFailure, ApiSuccess, EquipmentParameter, MasterData, ScenarioParameterCatalog } from '../../src/contracts/domain-models'
import { useScenarioStore } from '../../src/stores/scenario'

const META = { requestId: 'REQ-PARAMETERS', generatedAt: '2026-10-29T00:00:00Z', page: 1, pageSize: 1, total: 1 }

function success<T>(data: T): ApiSuccess<T> {
  return { ok: true, data, meta: META }
}

function failure(): ApiFailure {
  return { ok: false, error: { code: 'NOT_FOUND', message: '场景不存在。', retryable: false, correlationId: 'CORR-PARAMETERS' },
    meta: { requestId: META.requestId, generatedAt: META.generatedAt } }
}

function response(payload: unknown, ok = true, status = 200): Response {
  return { ok, status, json: vi.fn().mockResolvedValue(payload) } as unknown as Response
}

function equipment(change: Partial<EquipmentParameter> = {}): EquipmentParameter {
  return { equipmentId: 'EQ-1', type: '通信设备', frequencyMinMHz: 100, frequencyMaxMHz: 200,
    modulation: 'QPSK', berThreshold: 0.001, active: true, readOnly: false, version: 1, ...change }
}

function master(change: Partial<MasterData> = {}): MasterData {
  return { dataId: 'MD-1', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true, ...change }
}

function catalog(change: Partial<ScenarioParameterCatalog> = {}): ScenarioParameterCatalog {
  return { equipment: [equipment()], masterData: [master()], ...change }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('场景参数目录加载', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it('接受合法目录；空目录保留快照但显示为空态', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(success(catalog())))
      .mockResolvedValueOnce(response(success(catalog({ equipment: [], masterData: [] }))))
    vi.stubGlobal('fetch', fetchSpy)
    const store = useScenarioStore()

    expect(await store.loadParameterCatalog()).toBe(true)
    expect(store).toMatchObject({ parameterCatalog: catalog(), parameterCatalogState: 'SUCCESS', parameterCatalogMessage: '' })
    expect(fetchSpy.mock.calls[0]![0]).toContain('/api/v1/scenarios/parameter-catalog')
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'X-Demo-Role': 'OPERATOR' })

    expect(await store.loadParameterCatalog()).toBe(true)
    expect(store).toMatchObject({ parameterCatalog: { equipment: [], masterData: [] }, parameterCatalogState: 'EMPTY', parameterCatalogMessage: '' })
  })

  it.each([
    ['额外字段', { ...catalog(), extra: true }],
    ['重复装备编号', catalog({ equipment: [equipment(), equipment()] })],
    ['非法装备', catalog({ equipment: [equipment({ version: 0 })] })],
    ['非法通用数据', catalog({ masterData: [master({ version: 0 })] })],
  ])('拒绝%s的正式成功信封', async (_name, data) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(success(data))))
    const store = useScenarioStore()

    expect(await store.loadParameterCatalog()).toBe(false)
    expect(store).toMatchObject({ parameterCatalog: null, parameterCatalogState: 'ERROR', parameterCatalogMessage: '基础数据响应格式不正确。' })
  })

  it.each(['request', 'body'] as const)('请求或响应体超过五秒后超时（%s）', async phase => {
    vi.useFakeTimers()
    const body = deferred<unknown>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(phase === 'request'
      ? new Promise<Response>(() => undefined)
      : Promise.resolve({ ok: true, status: 200, json: vi.fn(() => body.promise) } as unknown as Response)))
    const store = useScenarioStore()
    const pending = store.loadParameterCatalog()

    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toBe(false)
    expect(store).toMatchObject({ parameterCatalog: null, parameterCatalogState: 'ERROR', parameterCatalogMessage: '基础数据加载超时，请重试。' })
  })

  it('重试成功后忽略旧请求的迟到成功响应', async () => {
    const oldResponse = deferred<Response>()
    const newest = catalog({ equipment: [equipment({ equipmentId: 'EQ-NEW' })] })
    vi.stubGlobal('fetch', vi.fn()
      .mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValueOnce(response(success(newest))))
    const store = useScenarioStore()
    const old = store.loadParameterCatalog()

    expect(await store.loadParameterCatalog()).toBe(true)
    oldResponse.resolve(response(success(catalog())))
    await expect(old).resolves.toBe(false)
    expect(store).toMatchObject({ parameterCatalog: newest, parameterCatalogState: 'SUCCESS' })
  })

  it.each(['clear', 'reset'] as const)('%s 会取消在途目录并拒绝迟到响应', async action => {
    const late = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(late.promise))
    const store = useScenarioStore()
    const pending = store.loadParameterCatalog()

    if (action === 'clear') store.clearParameterCatalog()
    else store.resetToSafeEmpty()
    late.resolve(response(success(catalog())))

    await expect(pending).resolves.toBe(false)
    expect(store).toMatchObject({ parameterCatalog: null, parameterCatalogState: 'EMPTY', parameterCatalogMessage: '' })
  })

  it('切换场景前清空已加载目录', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(success(catalog())))
      .mockResolvedValueOnce(response(failure(), false, 404)))
    const store = useScenarioStore()

    expect(await store.loadParameterCatalog()).toBe(true)
    expect(await store.loadScenario('SCN-NEXT')).toBe(false)
    expect(store).toMatchObject({ parameterCatalog: null, parameterCatalogState: 'EMPTY', parameterCatalogMessage: '' })
  })
})

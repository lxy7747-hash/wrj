import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type {
  ApiFailure,
  ApiSuccess,
  PageMeta,
  Principal,
  ScenarioConfig,
  ScenarioDraft,
} from '../../src/contracts/domain-models'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'

const META: PageMeta = {
  requestId: 'REQ-P2-TEST',
  generatedAt: '2026-08-06T08:00:00Z',
  page: 1,
  pageSize: 1,
  total: 1,
}
const OPERATOR: Principal = {
  userId: 'USR-OPERATOR',
  username: 'operator',
  role: 'OPERATOR',
  permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'],
}

/** 创建与服务端基线一致、可独立修改的场景草稿。 */
function scenarioDraft(revision = 4): ScenarioDraft {
  return {
    config: structuredClone(fixtureSource.scenario) as ScenarioConfig,
    uiExtensions: { jammers: [], sensors: [] },
    revision,
    officialLibraryChanged: false,
    locked: false,
  }
}

/** 创建测试使用的成功 API 信封。 */
function success<T>(data: T): ApiSuccess<T> {
  return { ok: true, data, meta: META }
}

/** 创建测试使用的 JSON Response。 */
function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}

/** 创建带可选字段路径的失败 API 信封。 */
function apiFailure(message: string, fieldPath?: string): ApiFailure {
  return {
    ok: false,
    error: {
      code: 'VALIDATION_FAILED',
      message,
      ...(fieldPath === undefined ? {} : { fieldPath }),
      retryable: false,
      correlationId: 'CORR-P2-TEST',
    },
    meta: { requestId: META.requestId, generatedAt: META.generatedAt },
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('P2-1 场景 Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it('从 Node.js Mock 加载并校验场景草稿', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(success(scenarioDraft())))
    vi.stubGlobal('fetch', fetchSpy)
    const scenario = useScenarioStore()

    await expect(scenario.loadScenario()).resolves.toBe(true)

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4173/api/v1/scenarios/SCN-001',
      { headers: { 'X-Demo-Role': 'OPERATOR' } },
    )
    expect(scenario.draft?.config.scenario.name).toBe('跨海通联演示')
    expect(scenario.panelState).toBe('SUCCESS')
    expect(scenario.dirty).toBe(false)
  })

  it('保存有效修改并使用服务端返回的修订号', async () => {
    const saved = scenarioDraft(5)
    saved.config.scenario.name = '台海通联验证场景'
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(success(saved)))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    scenario.draft = scenarioDraft()
    scenario.draft.config.scenario.name = saved.config.scenario.name
    scenario.markDirty()

    await expect(scenario.saveScenario()).resolves.toBe(true)

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4173/api/v1/scenarios/SCN-001',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(scenarioDraft().config).replace('跨海通联演示', '台海通联验证场景') }),
    )
    expect(scenario.draft?.revision).toBe(5)
    expect(scenario.dirty).toBe(false)
    expect(scenario.resultMessage).toContain('修订号为 5')
  })

  it('在无权限、空草稿和本地字段错误时拒绝保存且不发请求', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    const scenario = useScenarioStore()

    await expect(scenario.saveScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('PERMISSION_DENIED')

    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    await expect(scenario.saveScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('EMPTY')

    scenario.draft = scenarioDraft()
    scenario.draft.config.scenario.environment.humidityPercent = 101
    await expect(scenario.saveScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('VALIDATION_FAILED')
    expect(scenario.validation.errors[0]?.fieldPath).toBe('scenario.environment.humidityPercent')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('显示服务端字段错误并拒绝无效成功响应', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(apiFailure('场景名称已存在。', 'scenario.name'), false))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { revision: 1 }, meta: META }))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    scenario.draft = scenarioDraft()

    await expect(scenario.saveScenario()).resolves.toBe(false)
    expect(scenario.resultMessage).toBe('场景名称已存在。')
    expect(scenario.validation.errors[0]?.fieldPath).toBe('scenario.name')

    scenario.markDirty()
    expect(scenario.panelState).toBe('SUCCESS')
    expect(scenario.resultCode).toBe('EMPTY')
    expect(scenario.resultMessage).toBe('')
    expect(scenario.validation).toEqual({ valid: true, errors: [], warnings: [] })

    await expect(scenario.loadScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('INVALID_RESPONSE')

    await expect(scenario.loadScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('NETWORK_ERROR')
  })

  it('在加载和保存响应无法解析时安全失败', async () => {
    const badJsonResponse = { ok: true, json: vi.fn().mockRejectedValue(new Error('bad json')) } as unknown as Response
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(badJsonResponse))
    const auth = useAuthStore()
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()

    await expect(scenario.loadScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('INVALID_RESPONSE')

    scenario.draft = scenarioDraft()
    await expect(scenario.saveScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('INVALID_RESPONSE')
  })

  it('拒绝损坏的草稿外壳并可恢复安全空态', async () => {
    const valid = scenarioDraft()
    const malformed = [
      null,
      { ...valid, extra: true },
      { ...valid, revision: -1 },
      { ...valid, uiExtensions: { jammers: null, sensors: [] } },
      { ...valid, config: { ...valid.config, schemaVersion: '2.0' } },
    ]
    const fetchSpy = vi.fn()
    malformed.forEach((data) => fetchSpy.mockResolvedValueOnce(jsonResponse(success(data))))
    vi.stubGlobal('fetch', fetchSpy)
    const scenario = useScenarioStore()

    for (const _data of malformed) {
      await expect(scenario.loadScenario()).resolves.toBe(false)
      expect(scenario.resultCode).toBe('INVALID_RESPONSE')
    }

    scenario.markDirty()
    expect(scenario.dirty).toBe(false)
    scenario.resetToSafeEmpty()
    expect(scenario.$state).toMatchObject({ draft: null, panelState: 'EMPTY', dirty: false })
  })

  it.each(['load', 'save'] as const)('会话 reset 后忽略延迟 %s 异常', async (operation) => {
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise))
    const auth = useAuthStore()
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    if (operation === 'save') scenario.$patch({ draft: scenarioDraft(), panelState: 'SUCCESS', dirty: true })

    const pending = operation === 'load' ? scenario.loadScenario() : scenario.saveScenario()
    scenario.resetToSafeEmpty()
    response.reject(new Error('late failure'))

    await expect(pending).resolves.toBe(false)
    expect(scenario.$state).toMatchObject({
      draft: null,
      panelState: 'EMPTY',
      dirty: false,
      resultCode: 'EMPTY',
      resultMessage: '尚未加载场景草稿。',
    })
  })
})

describe('P2-1 场景基础字段校验', () => {
  it('定位基础、时序和环境参数错误', () => {
    const cases: Array<[string, (config: ScenarioConfig) => void]> = [
      ['scenario.id', (config) => { config.scenario.id = 'BAD' as ScenarioConfig['scenario']['id'] }],
      ['scenario.name', (config) => { config.scenario.name = ' ' }],
      ['scenario.description', (config) => { config.scenario.description = 'x'.repeat(513) }],
      ['scenario.startTime', (config) => { config.scenario.startTime = '2026-02-30T08:00:00Z' }],
      ['scenario.duration', (config) => { config.scenario.duration = 0 }],
      ['scenario.timeStep', (config) => { config.scenario.timeStep = -1 }],
      ['scenario.environment.seaState', (config) => { config.scenario.environment.seaState = -1 }],
      ['scenario.environment.temperatureC', (config) => { config.scenario.environment.temperatureC = Number.NaN }],
      ['scenario.environment.humidityPercent', (config) => { config.scenario.environment.humidityPercent = 101 }],
      ['scenario.environment.rainRateMmPerHour', (config) => { config.scenario.environment.rainRateMmPerHour = -1 }],
      ['scenario.environment.rainLossDbPerKm', (config) => { config.scenario.environment.rainLossDbPerKm = -1 }],
      ['scenario.environment.multipathEnabled', (config) => { config.scenario.environment.multipathEnabled = 'yes' as never }],
    ]

    for (const [fieldPath, mutate] of cases) {
      const config = scenarioDraft().config
      mutate(config)
      expect(inspectScenarioConfig(config).result.errors.map((issue) => issue.fieldPath)).toContain(fieldPath)
    }
  })

  it('拒绝损坏配置外壳并接受有效闰日', () => {
    expect(inspectScenarioConfig(null).result.errors[0]?.fieldPath).toBe('config')
    expect(inspectScenarioConfig({ ...scenarioDraft().config, extra: true }).result.valid).toBe(false)

    const invalidScenario = { ...scenarioDraft().config, scenario: null }
    expect(inspectScenarioConfig(invalidScenario).result.errors[0]?.fieldPath).toBe('scenario')

    const invalidEnvironment = scenarioDraft().config
    invalidEnvironment.scenario.environment = null as never
    expect(inspectScenarioConfig(invalidEnvironment).result.errors.some((issue) => issue.fieldPath === 'scenario.environment')).toBe(true)

    const valid = scenarioDraft().config
    valid.scenario.startTime = '2024-02-29t08:00:00z'
    const inspected = inspectScenarioConfig(valid)
    expect(inspected.result.valid).toBe(true)
    expect(inspected.identity?.startTime).toBe(valid.scenario.startTime)
  })
})

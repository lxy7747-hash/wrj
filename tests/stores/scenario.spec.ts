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
import { inspectScenarioConfig, inspectScenarioUiExtensions } from '../../src/features/scenarios/scenario-validation'
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
    uiExtensions: {
      jammers: [
        { jammerId: 'JAM-WB-01-TX', direction: 360, duration: 120, enabled: true },
        { jammerId: 'JAM-SPOT-01-TX', direction: 45, duration: 60, enabled: false },
      ],
      sensors: [],
    },
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
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          config: { ...scenarioDraft().config, scenario: { ...scenarioDraft().config.scenario, name: '台海通联验证场景' } },
          uiExtensions: scenarioDraft().uiExtensions,
        }),
      }),
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
      { ...valid, uiExtensions: { ...valid.uiExtensions, jammers: [valid.uiExtensions.jammers[0]!] } },
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

describe('P2-2 平台与航点字段校验', () => {
  it('接受 50 个业务信息节点并拒绝第 51 个', () => {
    const config = scenarioDraft().config
    const source = structuredClone(config.platforms[3]!)
    for (let index = 0; index < 44; index += 1) {
      config.platforms.push({
        ...structuredClone(source),
        id: `CAPACITY-${String(index + 1).padStart(3, '0')}`,
        name: `容量测试节点 ${index + 1}`,
        linkIds: [],
        sensorIds: [],
        jammerIds: [],
      })
    }

    expect(inspectScenarioConfig(config).result.valid).toBe(true)
    config.platforms.push({
      ...structuredClone(source),
      id: 'CAPACITY-045',
      name: '第 51 个业务信息节点',
      linkIds: [],
      sensorIds: [],
      jammerIds: [],
    })
    expect(inspectScenarioConfig(config).result.errors).toContainEqual(expect.objectContaining({
      code: 'NODE_LIMIT_EXCEEDED',
      fieldPath: 'platforms',
    }))
  })

  it('定位平台、坐标、航点和关联错误', () => {
    const cases: Array<[string, (config: ScenarioConfig) => void]> = [
      ['platforms', (config) => { config.platforms[1]!.id = config.platforms[0]!.id }],
      ['platforms[0].name', (config) => { config.platforms[0]!.name = ' ' }],
      ['platforms[0].type', (config) => { config.platforms[0]!.type = 'UNKNOWN' as never }],
      ['platforms[0].category', (config) => { config.platforms[0]!.category = 'sea' as never }],
      ['platforms[0].initialPosition.longitude', (config) => { config.platforms[0]!.initialPosition.longitude = 181 }],
      ['platforms[1].waypoints[0].speed', (config) => { config.platforms[1]!.waypoints[0]!.speed = -1 }],
      ['platforms[0].linkIds', (config) => { config.platforms[0]!.linkIds.push('L-NOT-FOUND') }],
      ['links[0].sourcePlatformId', (config) => { config.links[0]!.sourcePlatformId = 'P-NOT-FOUND' }],
    ]

    for (const [fieldPath, mutate] of cases) {
      const config = scenarioDraft().config
      mutate(config)
      expect(inspectScenarioConfig(config).result.errors.map((issue) => issue.fieldPath)).toContain(fieldPath)
    }
  })

  it('至少保留一个业务信息节点且支撑实体不计入容量', () => {
    const config = scenarioDraft().config
    config.platforms = config.platforms.filter((platform) => (
      platform.type === 'COMMUNICATION_SATELLITE' || platform.type === 'GROUND_JAMMER_DETECTION_STATION'
    ))

    expect(inspectScenarioConfig(config).result.errors).toContainEqual(expect.objectContaining({
      code: 'MINIMUM_BUSINESS_NODE',
      fieldPath: 'platforms',
    }))
  })

  it.each([
    {
      name: '倒序到达时间',
      mutate: (config: ScenarioConfig) => {
        config.platforms[1]!.waypoints.push({ longitude: 119.6, latitude: 24.9, altitude: 3100, speed: 45, arrivalTime: 599 })
      },
      code: 'ARRIVAL_TIME_NOT_INCREASING',
      fieldPath: 'platforms[1].waypoints[1].arrivalTime',
    },
    {
      name: '相等到达时间',
      mutate: (config: ScenarioConfig) => {
        config.platforms[1]!.waypoints.push({ longitude: 119.6, latitude: 24.9, altitude: 3100, speed: 45, arrivalTime: 600 })
      },
      code: 'ARRIVAL_TIME_NOT_INCREASING',
      fieldPath: 'platforms[1].waypoints[1].arrivalTime',
    },
    {
      name: '到达时间超过场景时长',
      mutate: (config: ScenarioConfig) => {
        config.platforms[1]!.waypoints[0]!.arrivalTime = config.scenario.duration + 1
      },
      code: 'ARRIVAL_TIME_EXCEEDS_DURATION',
      fieldPath: 'platforms[1].waypoints[0].arrivalTime',
    },
  ])('拒绝$name并定位到对应航点', ({ mutate, code, fieldPath }) => {
    const config = scenarioDraft().config
    mutate(config)

    expect(inspectScenarioConfig(config).result.errors).toContainEqual(expect.objectContaining({ code, fieldPath }))
  })

  it.each([
    { name: '链路', field: 'linkIds' as const, id: 'L-MW-01' },
    { name: '传感器', field: 'sensorIds' as const, id: 'ESM-01' },
    { name: '干扰器', field: 'jammerIds' as const, id: 'JAM-WB-01-TX' },
  ])('拒绝归属于其他平台的$name关联', ({ field, id }) => {
    const config = scenarioDraft().config
    config.platforms[0]![field].push(id)

    expect(inspectScenarioConfig(config).result.errors).toContainEqual({
      severity: 'ERROR',
      code: 'REFERENCE_OWNERSHIP_MISMATCH',
      message: '关联对象不属于当前场景实体。',
      fieldPath: `platforms[0].${field}`,
    })
  })
})

describe('P2-3 链路字段校验', () => {
  it('覆盖四类链路并允许没有链路的场景', () => {
    const config = scenarioDraft().config
    expect(new Set(config.links.map((link) => link.type))).toEqual(new Set(['SAT', 'MICROWAVE', 'DATALINK', 'LASER']))

    config.links = []
    config.platforms.forEach((platform) => { platform.linkIds = [] })
    expect(inspectScenarioConfig(config).result.valid).toBe(true)
  })

  it('频率和带宽接受任意有限正数，0.001 仅作为输入步长', () => {
    const positive = scenarioDraft().config
    positive.links[0]!.frequency = 0.0001
    positive.links[0]!.bandwidth = Number.MIN_VALUE
    expect(inspectScenarioConfig(positive).result.valid).toBe(true)

    for (const field of ['frequency', 'bandwidth'] as const) {
      const invalid = scenarioDraft().config
      invalid.links[0]![field] = 0
      expect(inspectScenarioConfig(invalid).result.errors.map((issue) => issue.fieldPath)).toContain(`links[0].${field}`)
    }
  })

  it('定位链路标识、端点和全参数错误', () => {
    const cases: Array<[string, (config: ScenarioConfig) => void]> = [
      ['links', (config) => { config.links[1]!.id = config.links[0]!.id }],
      ['links[0]', (config) => { delete (config.links[0] as unknown as Record<string, unknown>).frequency }],
      ['links[0].id', (config) => { config.links[0]!.id = ' ' }],
      ['links[0].type', (config) => { config.links[0]!.type = 'UNKNOWN' as never }],
      ['links[0].sourcePlatformId', (config) => { config.links[0]!.sourcePlatformId = 'NOT-FOUND' }],
      ['links[0].targetPlatformId', (config) => { config.links[0]!.targetPlatformId = 'NOT-FOUND' }],
      ['links[0].targetPlatformId', (config) => { config.links[0]!.targetPlatformId = config.links[0]!.sourcePlatformId }],
      ['links[0].frequency', (config) => { config.links[0]!.frequency = 0 }],
      ['links[0].bandwidth', (config) => { config.links[0]!.bandwidth = 0 }],
      ['links[0].txPower', (config) => { config.links[0]!.txPower = -1 }],
      ['links[0].antennaGain', (config) => { config.links[0]!.antennaGain = { tx: 1 } as never }],
      ['links[0].antennaGain.tx', (config) => { config.links[0]!.antennaGain.tx = Number.NaN }],
      ['links[0].antennaGain.rx', (config) => { config.links[0]!.antennaGain.rx = Number.NaN }],
      ['links[0].modulation', (config) => { config.links[0]!.modulation = '16QAM' as never }],
      ['links[0].berThreshold', (config) => { config.links[0]!.berThreshold = 1.1 }],
      ['links[0].dataRate', (config) => { config.links[0]!.dataRate = -1 }],
      ['links[0].direction', (config) => { config.links[0]!.direction = 'BOTH' as never }],
    ]

    for (const [fieldPath, mutate] of cases) {
      const config = scenarioDraft().config
      mutate(config)
      expect(inspectScenarioConfig(config).result.errors.map((issue) => issue.fieldPath)).toContain(fieldPath)
    }
  })
})

describe('P2-4 干扰设备字段校验', () => {
  it('覆盖两类干扰设备并允许没有干扰设备的场景', () => {
    const config = scenarioDraft().config
    expect(new Set(config.jammers.map((jammer) => jammer.type))).toEqual(new Set(['BARRAGE', 'SPOT']))

    config.jammers = []
    config.platforms.forEach((platform) => { platform.jammerIds = [] })
    expect(inspectScenarioConfig(config).result.valid).toBe(true)
  })

  it('频率和带宽接受任意有限正数，功率和检测范围接受 0', () => {
    const valid = scenarioDraft().config
    valid.jammers[0]!.frequency = 0.0001
    valid.jammers[0]!.bandwidth = Number.MIN_VALUE
    valid.jammers[0]!.defaultPower = 0
    valid.jammers[0]!.detectionRange = 0
    expect(inspectScenarioConfig(valid).result.valid).toBe(true)
  })

  it('定位干扰设备标识、归属和全参数错误', () => {
    const cases: Array<[string, (config: ScenarioConfig) => void]> = [
      ['jammers', (config) => { config.jammers[1]!.id = config.jammers[0]!.id }],
      ['jammers[0]', (config) => { delete (config.jammers[0] as unknown as Record<string, unknown>).frequency }],
      ['jammers[0].id', (config) => { config.jammers[0]!.id = ' ' }],
      ['jammers[0].platformId', (config) => { config.jammers[0]!.platformId = 'NOT-FOUND' }],
      ['jammers[0].type', (config) => { config.jammers[0]!.type = 'UNKNOWN' as never }],
      ['jammers[0].defaultPower', (config) => { config.jammers[0]!.defaultPower = -1 }],
      ['jammers[0].frequency', (config) => { config.jammers[0]!.frequency = 0 }],
      ['jammers[0].bandwidth', (config) => { config.jammers[0]!.bandwidth = 0 }],
      ['jammers[0].autoDetect', (config) => { config.jammers[0]!.autoDetect = 'true' as never }],
      ['jammers[0].detectionRange', (config) => { config.jammers[0]!.detectionRange = -1 }],
    ]

    for (const [fieldPath, mutate] of cases) {
      const config = scenarioDraft().config
      mutate(config)
      expect(inspectScenarioConfig(config).result.errors.map((issue) => issue.fieldPath)).toContain(fieldPath)
    }
  })

  it('按 jammerId 校验一一对应的 UI 扩展边界', () => {
    const { config, uiExtensions } = scenarioDraft()
    expect(inspectScenarioUiExtensions(uiExtensions, config.jammers.map((jammer) => jammer.id)).result.valid).toBe(true)

    const cases = [
      ['uiExtensions.jammers', [{ ...uiExtensions.jammers[0] }, { ...uiExtensions.jammers[0] }]],
      ['uiExtensions.jammers[0].jammerId', [{ ...uiExtensions.jammers[0], jammerId: '' }, uiExtensions.jammers[1]]],
      ['uiExtensions.jammers[0].direction', [{ ...uiExtensions.jammers[0], direction: 361 }, uiExtensions.jammers[1]]],
      ['uiExtensions.jammers[0].duration', [{ ...uiExtensions.jammers[0], duration: -1 }, uiExtensions.jammers[1]]],
      ['uiExtensions.jammers[0].enabled', [{ ...uiExtensions.jammers[0], enabled: 'yes' }, uiExtensions.jammers[1]]],
    ] as const
    for (const [fieldPath, jammers] of cases) {
      expect(inspectScenarioUiExtensions({ jammers, sensors: [] }, config.jammers.map((jammer) => jammer.id)).result.errors
        .map((issue) => issue.fieldPath)).toContain(fieldPath)
    }

    expect(inspectScenarioUiExtensions(null, config.jammers.map((jammer) => jammer.id)).result.errors[0]?.fieldPath).toBe('uiExtensions')
    expect(inspectScenarioUiExtensions({ jammers: [null, uiExtensions.jammers[1]], sensors: [] }, config.jammers.map((jammer) => jammer.id)).result.errors
      .map((issue) => issue.fieldPath)).toContain('uiExtensions.jammers[0]')
    expect(inspectScenarioUiExtensions({ jammers: [], sensors: null }, []).result.errors[0]?.fieldPath).toBe('uiExtensions')
  })
})

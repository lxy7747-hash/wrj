import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type {
  ApiFailure,
  ApiErrorCode,
  ApiSuccess,
  ConfirmationContext,
  DeleteResult,
  PageMeta,
  Principal,
  ScenarioConfig,
  ScenarioDraft,
  ScenarioTemplate,
  ScriptContract,
  ValidationResult,
} from '../../src/contracts/domain-models'
import { inspectScenarioConfig, inspectScenarioUiExtensions } from '../../src/features/scenarios/scenario-validation'
import { withScenarioBasicDefaults } from '../../src/features/scenarios/scenario-basic'
import { getLinkExclusionReason, isConfiguredLinkEnabled, readLinkEnabled, readLinkSettings } from '../../src/features/scenarios/link-settings'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'
import { useUiStore } from '../../src/stores/ui'

const META: PageMeta = {
  requestId: 'REQ-P2-TEST',
  generatedAt: '2026-08-06T08:00:00Z',
  page: 1,
  pageSize: 1,
  total: 1,
}

describe('链路新增参数边界', () => {
  it('旧双选或均未选使用天通默认值，参与原因优先显示链路停用', () => {
    const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
    const tiantong = config.platforms.find(p => p.satelliteType === 'TIANTONG')!
    const shentong = { ...structuredClone(tiantong), id: 'SAT-ST', satelliteType: 'SHENTONG' as const }
    config.platforms.push(shentong)
    config.linkSettings = readLinkSettings(config)
    for (const enabled of [true, false]) {
      config.linkSettings.enabledSatellites = { TIANTONG: enabled, SHENTONG: enabled }
      expect(readLinkSettings(config).enabledSatellites).toEqual({ TIANTONG: true, SHENTONG: false })
      expect(config.linkSettings.enabledSatellites).toEqual({ TIANTONG: enabled, SHENTONG: enabled })
    }
    const link = { ...config.links.find(l => l.type === 'SAT')!, sourcePlatformId: tiantong.id, targetPlatformId: 'UAV-01', enabled: true }
    const settings = readLinkSettings(config)
    expect(getLinkExclusionReason(link, settings, config.platforms)).toBeNull()
    expect(getLinkExclusionReason({ ...link, sourcePlatformId: shentong.id }, settings, config.platforms)).toBe('神通卫星')
    settings.enabledSatellites = { TIANTONG: false, SHENTONG: true }
    expect(getLinkExclusionReason(link, settings, config.platforms)).toBe('天通卫星')
    expect(isConfiguredLinkEnabled(link, settings, config.platforms)).toBe(false)
    expect(getLinkExclusionReason({ ...link, enabled: false }, settings, config.platforms)).toBe('链路停用')
    expect(getLinkExclusionReason({ ...link, type: 'MICROWAVE', sourcePlatformId: 'CMD-01' }, settings, config.platforms)).toBeNull()
  })

  it('中继卫星默认选择天通，显式开关原样保留，无实体时不启用', () => {
    const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
    config.platforms.push({ ...structuredClone(config.platforms.find(p => p.satelliteType === 'TIANTONG')!), id: 'SAT-ST', satelliteType: 'SHENTONG' })
    expect(readLinkSettings(config).enabledSatellites).toEqual({ TIANTONG: true, SHENTONG: false })
    expect(readLinkSettings({ platforms: [] }).enabledSatellites).toEqual({ TIANTONG: false, SHENTONG: false })
    config.linkSettings = readLinkSettings(config)
    config.linkSettings.enabledSatellites = { TIANTONG: false, SHENTONG: true }
    const settings = readLinkSettings(config)
    expect(settings.enabledSatellites).toEqual({ TIANTONG: false, SHENTONG: true })
    settings.enabledSatellites.SHENTONG = false
    expect(config.linkSettings.enabledSatellites.SHENTONG).toBe(true)
  })

  it('兼容旧场景，拒绝非法数值、编码、卫星开关及重复优先级', () => {
    const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
    expect(inspectScenarioConfig(config).result.valid).toBe(true)
    config.linkSettings = readLinkSettings(config)
    config.linkSettings.enabledSatellites.SHENTONG = true
    config.linkSettings.enabledTypes = { SAT: 'true' as never, MICROWAVE: true, DATALINK: true, LASER: true }
    config.linkSettings.switchCooldownS = -1
    config.linkSettings.priority = ['SAT', 'SAT', 'LASER', 'MICROWAVE']
    Object.assign(config.links[0]!, { enabled: 'true', antennaGainCorrectionDb: NaN, antiJammingGainDb: -1, spatialIsolationDb: Infinity, coding: 'bad\nscript' })
    const paths = inspectScenarioConfig(config).result.errors.map(e => e.fieldPath)
    expect(paths).toEqual(expect.arrayContaining([
      'linkSettings.enabledSatellites.SHENTONG', 'linkSettings.enabledTypes.SAT', 'linkSettings.switchCooldownS', 'linkSettings.priority',
      'links[0].enabled', 'links[0].antennaGainCorrectionDb', 'links[0].antiJammingGainDb', 'links[0].spatialIsolationDb', 'links[0].coding',
    ]))
  })
})
it('单条启停优先于历史类型开关，同类型链路独立且不改写原快照', () => {
  const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
  const settings = readLinkSettings(config)
  expect(settings.enabledTypes).toBeUndefined()
  const [first, second] = config.links.filter(link => link.type === 'MICROWAVE')
  expect(readLinkEnabled(first!)).toBe(true)
  settings.enabledTypes = { SAT: true, MICROWAVE: false, DATALINK: true, LASER: true }
  expect(isConfiguredLinkEnabled(first!, settings, config.platforms)).toBe(false)
  first!.enabled = true
  expect(isConfiguredLinkEnabled(first!, settings, config.platforms)).toBe(true)
  expect(isConfiguredLinkEnabled(second!, settings, config.platforms)).toBe(false)
  first!.enabled = false
  second!.enabled = true
  expect(isConfiguredLinkEnabled(first!, settings, config.platforms)).toBe(false)
  expect(isConfiguredLinkEnabled(second!, settings, config.platforms)).toBe(true)
  expect(settings.enabledTypes.MICROWAVE).toBe(false)
  expect(config.linkSettings).toBeUndefined()
})

const OPERATOR: Principal = {
  userId: 'USR-OPERATOR',
  username: 'operator',
  role: 'OPERATOR',
  permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'],
}
const ADMIN: Principal = {
  userId: 'USR-ADMIN',
  username: 'admin',
  role: 'ADMIN',
  permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE', 'OFFICIAL_TEMPLATE_MAINTAIN'],
}

/** 创建与服务端基线一致、可独立修改的场景草稿。 */
function scenarioDraft(revision = 4): ScenarioDraft {
  const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
  config.jammers.push({ ...config.jammers[0]!, id: 'JAM-SPOT-01-TX', type: 'SPOT', autoDetect: false })
  config.platforms.find(platform => platform.id === 'STN-01')!.jammerIds.push('JAM-SPOT-01-TX')
  return {
    config,
    uiExtensions: {
      jammers: [
        { jammerId: 'JAM-WB-01-TX', direction: 360, duration: 120, enabled: true },
        { jammerId: 'JAM-SPOT-01-TX', direction: 45, duration: 60, enabled: false },
      ],
      sensors: [{ sensorId: 'ESM-01', type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true }],
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

it('旧干扰归属可读取但写入必须选择专用节点，检查不改绑原数据', () => {
  const config = scenarioDraft().config
  const jammer = config.jammers[0]!
  jammer.platformId = 'CMD-01'
  config.platforms.forEach(platform => { platform.jammerIds = config.jammers.filter(item => item.platformId === platform.id).map(item => item.id) })
  expect(inspectScenarioConfig(config).result.valid).toBe(true)
  expect(inspectScenarioConfig(config, 'write').result.errors).toContainEqual(expect.objectContaining({ code: 'JAMMER_PLATFORM_TYPE_INVALID', fieldPath: 'jammers[0].platformId' }))
  expect(jammer.platformId).toBe('CMD-01')
})

/** 创建带可选字段路径的失败 API 信封。 */
function apiFailure(message: string, fieldPath?: string, code: ApiErrorCode = 'VALIDATION_FAILED'): ApiFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(fieldPath === undefined ? {} : { fieldPath }),
      retryable: false,
      correlationId: 'CORR-P2-TEST',
    },
    meta: { requestId: META.requestId, generatedAt: META.generatedAt },
  }
}

/** 创建模板 Store 测试使用的完整官方模板。 */
function template(templateId = 'TPL-SCN-001', version = '4', referenceCount = 2): ScenarioTemplate {
  return {
    templateId,
    name: templateId === 'TPL-SCN-001' ? '跨海通联演示官方基线' : '台海验证模板',
    version,
    official: true,
    config: scenarioDraft().config,
    referenceCount,
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
    expect(scenario.draft?.config.scenario.duration).toBe(7200)
    expect(scenario.draft?.config.platforms).toEqual(scenarioDraft().config.platforms)
    expect(scenario.draft?.config.scenario.environment).toMatchObject({
      simClockSpeed: 2, transmissionDistance: 300, rainCloudAttenuation: 'lightRain',
    })
    expect(scenario.panelState).toBe('SUCCESS')
    expect(scenario.dirty).toBe(false)
  })

  it('保存有效修改并使用服务端返回的修订号', async () => {
    const saved = scenarioDraft(5)
    saved.config.scenario.name = '台海通联验证场景'
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(success(saved)))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    auth.$patch({ principal: { ...OPERATOR, permissions: [...OPERATOR.permissions] }, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
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

    auth.$patch({ principal: { ...OPERATOR, permissions: [...OPERATOR.permissions] }, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    await expect(scenario.saveScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('EMPTY')

    scenario.draft = scenarioDraft()
    scenario.draft.config.scenario.environment.humidityPercent = 101
    await expect(scenario.saveScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('VALIDATION_FAILED')
    expect(scenario.validation.errors[0]?.fieldPath).toBe('scenario.environment.humidityPercent')

    scenario.draft.config.scenario.environment.humidityPercent = 80
    scenario.draft.uiExtensions.jammers[0]!.enabled = 'yes' as unknown as boolean
    await expect(scenario.saveScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('VALIDATION_FAILED')
    expect(scenario.validation.errors[0]?.fieldPath).toBe('uiExtensions.jammers[0].enabled')

    scenario.draft.uiExtensions.jammers[0]!.enabled = true
    scenario.draft.locked = true
    await expect(scenario.saveScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('CONFIG_LOCKED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('显示服务端字段错误并拒绝无效成功响应', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(apiFailure('场景名称已存在。', 'scenario.name'), false))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { revision: 1 }, meta: META }))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    auth.$patch({ principal: { ...OPERATOR, permissions: [...OPERATOR.permissions] }, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
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

  it('通过整体校验接口处理通过、警告、错误和配置锁', async () => {
    const validDraft = scenarioDraft()
    validDraft.config.scenario.environment.rainLossDbPerKm = 0.08
    const validResult = inspectScenarioConfig(validDraft.config).result
    const warningDraft = scenarioDraft()
    const warningResult = inspectScenarioConfig(warningDraft.config).result
    const invalidDraft = scenarioDraft()
    invalidDraft.config.links[0]!.txPower = -1
    const invalidResult = inspectScenarioConfig(invalidDraft.config).result
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(success<ValidationResult>(validResult)))
      .mockResolvedValueOnce(jsonResponse(success<ValidationResult>(warningResult)))
      .mockResolvedValueOnce(jsonResponse(success<ValidationResult>(invalidResult)))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    const scenario = useScenarioStore()

    await expect(scenario.validateScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('PERMISSION_DENIED')
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    await expect(scenario.validateScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('EMPTY')

    scenario.draft = validDraft
    await expect(scenario.validateScenario()).resolves.toBe(true)
    expect(scenario.resultCode).toBe('VALIDATION_SUCCESS')
    expect(scenario.validation).toEqual({ valid: true, errors: [], warnings: [] })

    scenario.draft = warningDraft
    await expect(scenario.validateScenario()).resolves.toBe(true)
    expect(scenario.resultCode).toBe('VALIDATION_WARNING')
    expect(scenario.validation.warnings[0]?.fieldPath).toBe('scenario.environment.rainLossDbPerKm')

    scenario.draft = invalidDraft
    await expect(scenario.validateScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('VALIDATION_FAILED')
    expect(scenario.validation.errors[0]?.fieldPath).toBe('links[0].txPower')
    expect(fetchSpy).toHaveBeenLastCalledWith(
      'http://127.0.0.1:4173/api/v1/scenarios/SCN-001/validate',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ config: invalidDraft.config }) }),
    )

    scenario.draft.locked = true
    await expect(scenario.validateScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('CONFIG_LOCKED')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('拒绝不一致的整体校验成功信封', async () => {
    const malformedResults = [
      null,
      { valid: true, errors: [], warnings: [], extra: true },
      { valid: true, errors: null, warnings: [] },
      { valid: false, errors: [{ severity: 'WARNING', code: 'BAD', message: '错误级别不正确。', fieldPath: 'scenario' }], warnings: [] },
      { valid: true, errors: [], warnings: [{ severity: 'ERROR', code: 'BAD', message: '警告级别不正确。', fieldPath: 'scenario' }] },
      { valid: true, errors: [{ severity: 'ERROR', code: 'BAD', message: '有效性不一致。', fieldPath: 'scenario' }], warnings: [] },
    ]
    const fetchSpy = vi.fn()
    malformedResults.forEach((data) => fetchSpy.mockResolvedValueOnce(jsonResponse(success(data))))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    scenario.draft = scenarioDraft()

    for (const _result of malformedResults) {
      await expect(scenario.validateScenario()).resolves.toBe(false)
      expect(scenario.resultCode).toBe('INVALID_RESPONSE')
    }
  })
})

describe('P2-6 场景模板 Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it('加载模板列表和单个模板详情', async () => {
    const fixtureTemplate = template()
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(success([fixtureTemplate])))
      .mockResolvedValueOnce(jsonResponse(success(fixtureTemplate)))
    vi.stubGlobal('fetch', fetchSpy)
    const scenario = useScenarioStore()

    await expect(scenario.loadTemplates()).resolves.toBe(true)
    expect(scenario.templates).toEqual([fixtureTemplate])
    expect(scenario.templateResultCode).toBe('TEMPLATES_LOADED')
    await expect(scenario.loadTemplate(fixtureTemplate.templateId)).resolves.toEqual(fixtureTemplate)
    expect(scenario.selectedTemplate).toEqual(fixtureTemplate)
    expect(scenario.templateResultMessage).toContain('版本 4')
  })

  it('拒绝损坏的模板列表和详情响应', async () => {
    const malformedTemplate = { ...template(), referenceCount: -1 }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(success([malformedTemplate])))
      .mockResolvedValueOnce(jsonResponse(success({ ...template(), extra: true })))
      .mockResolvedValueOnce(jsonResponse(success(null)))
    vi.stubGlobal('fetch', fetchSpy)
    const scenario = useScenarioStore()

    await expect(scenario.loadTemplates()).resolves.toBe(false)
    expect(scenario.templateResultCode).toBe('INVALID_RESPONSE')
    await expect(scenario.loadTemplate('TPL-SCN-001')).resolves.toBeUndefined()
    expect(scenario.templateResultCode).toBe('INVALID_RESPONSE')
    await expect(scenario.loadTemplates()).resolves.toBe(false)
  })

  it('关闭校验模板字段、空列表和损坏 JSON 响应', async () => {
    const valid = template()
    const invalidTemplates = [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, templateId: 1 },
      { ...valid, templateId: '' },
      { ...valid, name: 1 },
      { ...valid, name: '' },
      { ...valid, version: 1 },
      { ...valid, version: '' },
      { ...valid, official: 'yes' },
      { ...valid, referenceCount: 1.5 },
      { ...valid, referenceCount: -1 },
      { ...valid, config: { ...valid.config, schemaVersion: '2.0' } },
    ]
    const fetchSpy = vi.fn()
    invalidTemplates.forEach((data) => fetchSpy.mockResolvedValueOnce(jsonResponse(success(data))))
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(success([])))
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(new Error('broken json')) } as unknown as Response)
    vi.stubGlobal('fetch', fetchSpy)
    const scenario = useScenarioStore()

    for (const _invalid of invalidTemplates) {
      await expect(scenario.loadTemplate('TPL-SCN-001')).resolves.toBeUndefined()
      expect(scenario.templateResultCode).toBe('INVALID_RESPONSE')
    }
    await expect(scenario.loadTemplates()).resolves.toBe(true)
    expect(scenario.templateState).toBe('EMPTY')
    expect(scenario.templateResultMessage).toBe('模板库暂无数据。')
    await expect(scenario.loadTemplates()).resolves.toBe(false)
    expect(scenario.templateResultCode).toBe('INVALID_RESPONSE')
  })

  it('管理员新建、导入、更新和导出模板，操作员被拒绝维护官方库', async () => {
    const created = template('TPL-SCN-002', '1', 0)
    const imported = { ...template('TPL-SCN-003', '1', 0), name: '导入模板' }
    const updated = { ...created, version: '2' }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(success(created)))
      .mockResolvedValueOnce(jsonResponse(success(imported)))
      .mockResolvedValueOnce(jsonResponse(success(updated)))
      .mockResolvedValueOnce(jsonResponse(success(updated)))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    const scenario = useScenarioStore()
    scenario.draft = scenarioDraft()

    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    await expect(scenario.createTemplate('越权模板')).resolves.toBe(false)
    expect(scenario.templateResultCode).toBe('PERMISSION_DENIED')

    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    await expect(scenario.createTemplate(created.name)).resolves.toBe(true)
    await expect(scenario.importTemplate(JSON.stringify({ name: imported.name, config: imported.config }))).resolves.toBe(true)
    await expect(scenario.updateTemplate(created.templateId, created.name)).resolves.toBe(true)
    await expect(scenario.exportTemplate(created.templateId)).resolves.toContain('"name": "台海验证模板"')
    expect(scenario.templates).toEqual([updated, imported])
    expect(scenario.templateResultMessage).toContain('未写入真实文件')
  })

  it('保留 API 失败代码并拒绝无效失败信封', async () => {
    const typedFailure = jsonResponse(apiFailure('模板操作冲突。', 'name', 'CONFLICT'), false)
    const malformedFailure = jsonResponse({ ok: false }, false)
    const fetchSpy = vi.fn()
    for (let index = 0; index < 6; index += 1) {
      fetchSpy.mockResolvedValueOnce(typedFailure).mockResolvedValueOnce(malformedFailure)
    }
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    const scenario = useScenarioStore()
    scenario.draft = scenarioDraft()

    for (const operation of [
      () => scenario.loadTemplates(),
      () => scenario.loadTemplate('TPL-SCN-001'),
      () => scenario.createTemplate('模板'),
      () => scenario.updateTemplate('TPL-SCN-001', '模板'),
      () => scenario.copyTemplate('TPL-SCN-001', '副本'),
      () => scenario.deleteTemplate('TPL-SCN-001'),
    ]) {
      await operation()
      expect(scenario.templateResultCode).toBe('CONFLICT')
      await operation()
      expect(scenario.templateResultCode).toBe('INVALID_RESPONSE')
    }
  })

  it('更新未缓存模板并在导出详情失败时停止', async () => {
    const updated = template('TPL-SCN-009', '2', 0)
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(success(updated)))
      .mockResolvedValueOnce(jsonResponse(apiFailure('模板不存在。', undefined, 'NOT_FOUND'), false))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    const scenario = useScenarioStore()
    scenario.draft = scenarioDraft()

    await expect(scenario.updateTemplate(updated.templateId, updated.name)).resolves.toBe(true)
    expect(scenario.templates).toEqual([updated])
    await expect(scenario.exportTemplate('TPL-NOT-FOUND')).resolves.toBeUndefined()
    expect(scenario.templateResultCode).toBe('NOT_FOUND')
  })

  it('拒绝非法导入文本并把模板复制为临时工作场景', async () => {
    const copiedDraft = scenarioDraft(5)
    copiedDraft.config.scenario.name = '模板副本'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(success(copiedDraft))))
    const auth = useAuthStore()
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()

    await expect(scenario.importTemplate('{')).resolves.toBe(false)
    expect(scenario.templateResultCode).toBe('INVALID_REQUEST')
    await expect(scenario.importTemplate(JSON.stringify({ name: '缺少配置' }))).resolves.toBe(false)
    expect(scenario.templateResultCode).toBe('VALIDATION_FAILED')
    await expect(scenario.copyTemplate('TPL-SCN-001', '模板副本')).resolves.toBe(true)
    expect(scenario.draft?.config.scenario.name).toBe('模板副本')
    expect(scenario.dirty).toBe(false)
  })

  it('在客户端阻断模板越权、空草稿和空名称', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    auth.$patch({
      principal: { ...OPERATOR, permissions: ['BUSINESS_READ'] },
      role: 'OPERATOR',
      permissions: ['BUSINESS_READ'],
    })
    const scenario = useScenarioStore()

    await expect(scenario.createTemplate('模板')).resolves.toBe(false)
    await expect(scenario.updateTemplate('TPL-SCN-001', '模板')).resolves.toBe(false)
    await expect(scenario.copyTemplate('TPL-SCN-001', '副本')).resolves.toBe(false)
    await expect(scenario.exportTemplate('TPL-SCN-001')).resolves.toBeUndefined()
    await expect(scenario.deleteTemplate('TPL-SCN-001')).resolves.toBe(false)

    auth.$patch({ principal: { ...ADMIN, permissions: [...ADMIN.permissions] }, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    await expect(scenario.createTemplate('模板')).resolves.toBe(false)
    expect(scenario.templateResultMessage).toBe('请先加载场景草稿。')
    await expect(scenario.updateTemplate('TPL-SCN-001', '模板')).resolves.toBe(false)
    expect(scenario.templateResultCode).toBe('EMPTY')
    scenario.draft = scenarioDraft()
    await expect(scenario.createTemplate('  ')).resolves.toBe(false)
    expect(scenario.templateResultMessage).toBe('模板名称不能为空。')
    auth.$patch({ principal: { ...OPERATOR, permissions: ['BUSINESS_READ'] }, role: 'OPERATOR', permissions: ['BUSINESS_READ'] })
    await expect(scenario.updateTemplate('TPL-SCN-001', '模板')).resolves.toBe(false)
    expect(scenario.templateResultCode).toBe('PERMISSION_DENIED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('经一次性确认删除未引用模板并保留引用冲突反馈', async () => {
    const removable = template('TPL-SCN-002', '1', 0)
    const awaiting: ConfirmationContext = {
      confirmationId: 'CONF-P2-001',
      state: 'AWAITING_CONFIRMATION',
      actor: 'admin',
      role: 'ADMIN',
      createdAt: META.generatedAt,
      expiresAt: '2026-08-06T08:05:00Z',
    }
    const confirmed = { ...awaiting, state: 'CONFIRMED' as const }
    const deleted: DeleteResult = { deleted: true, objectId: removable.templateId }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(success(awaiting)))
      .mockResolvedValueOnce(jsonResponse(success(confirmed)))
      .mockResolvedValueOnce(jsonResponse(success(deleted)))
      .mockResolvedValueOnce(jsonResponse(success(awaiting)))
      .mockResolvedValueOnce(jsonResponse(success(confirmed)))
      .mockResolvedValueOnce(jsonResponse(apiFailure('模板仍被历史记录引用，不能删除。', 'referenceCount', 'CONFLICT'), false))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    const scenario = useScenarioStore()
    scenario.$patch({ templates: [template(), removable], selectedTemplate: removable })

    await expect(scenario.deleteTemplate(removable.templateId)).resolves.toBe(true)
    expect(scenario.templates).toEqual([template()])
    expect(scenario.selectedTemplate).toBeNull()
    expect(scenario.lastConfirmation).toEqual({ ...confirmed, state: 'CLOSED' })
    expect(fetchSpy).toHaveBeenNthCalledWith(3,
      'http://127.0.0.1:4173/api/v1/templates/TPL-SCN-002',
      { method: 'DELETE', headers: { 'X-Demo-Role': 'ADMIN', 'X-Confirmation-Id': awaiting.confirmationId } },
    )

    await expect(scenario.deleteTemplate('TPL-SCN-001')).resolves.toBe(false)
    expect(scenario.templateResultCode).toBe('CONFLICT')
    expect(scenario.templates).toEqual([template()])
    expect(scenario.lastConfirmation).toEqual({ ...confirmed, state: 'CLOSED' })
  })

  it('确认已过期时保留已确认记录并显示失效状态', async () => {
    const removable = template('TPL-SCN-002', '1', 0)
    const awaiting: ConfirmationContext = {
      confirmationId: 'CONF-P2-001',
      state: 'AWAITING_CONFIRMATION',
      actor: 'admin',
      role: 'ADMIN',
      createdAt: META.generatedAt,
      expiresAt: '2026-08-06T08:05:00Z',
    }
    const confirmed = { ...awaiting, state: 'CONFIRMED' as const }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(success(awaiting)))
      .mockResolvedValueOnce(jsonResponse(success(confirmed)))
      .mockResolvedValueOnce(jsonResponse(apiFailure('二次确认已失效。', undefined, 'CONFIRMATION_EXPIRED'), false)))
    const auth = useAuthStore()
    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    const scenario = useScenarioStore()
    scenario.templates = [removable]

    await expect(scenario.deleteTemplate(removable.templateId)).resolves.toBe(false)
    expect(scenario.templateResultCode).toBe('CONFIRMATION_EXPIRED')
    expect(scenario.lastConfirmation).toEqual(confirmed)
    expect(scenario.templates).toEqual([removable])
  })

  it('拒绝损坏的确认上下文和删除结果', async () => {
    const base: ConfirmationContext = {
      confirmationId: 'CONF-P2-001',
      state: 'AWAITING_CONFIRMATION',
      actor: 'admin',
      role: 'ADMIN',
      createdAt: META.generatedAt,
      expiresAt: '2026-08-06T08:05:00Z',
    }
    const invalidAwaiting = [
      null,
      [],
      { ...base, extra: true },
      { ...base, confirmationId: '' },
      { ...base, state: 'CONFIRMED' },
      { ...base, actor: 1 },
      { ...base, role: 'UNKNOWN' },
      { ...base, createdAt: 1 },
      { ...base, expiresAt: 1 },
    ]
    const confirmed = { ...base, state: 'CONFIRMED' as const }
    const invalidConfirmed = [{ ...confirmed, state: 'AWAITING_CONFIRMATION' }, { ...confirmed, role: 'UNKNOWN' }]
    const invalidDeletes = [null, [], { deleted: false, objectId: 'TPL-SCN-002' }, { deleted: true, objectId: '' }, { deleted: true, objectId: 'OTHER' }]
    const fetchSpy = vi.fn()
    invalidAwaiting.forEach((data) => fetchSpy.mockResolvedValueOnce(jsonResponse(success(data))))
    invalidConfirmed.forEach((data) => fetchSpy
      .mockResolvedValueOnce(jsonResponse(success(base)))
      .mockResolvedValueOnce(jsonResponse(success(data))))
    invalidDeletes.forEach((data) => fetchSpy
      .mockResolvedValueOnce(jsonResponse(success(base)))
      .mockResolvedValueOnce(jsonResponse(success(confirmed)))
      .mockResolvedValueOnce(jsonResponse(success(data))))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    const scenario = useScenarioStore()
    scenario.templates = [template('TPL-SCN-002', '1', 0)]

    for (const _invalid of [...invalidAwaiting, ...invalidConfirmed, ...invalidDeletes]) {
      await expect(scenario.deleteTemplate('TPL-SCN-002')).resolves.toBe(false)
      expect(scenario.templateResultCode).toBe('INVALID_RESPONSE')
      expect(scenario.templates).toHaveLength(1)
    }
  })

  it('删除最后一个模板后进入空态且不清除其他选中模板', async () => {
    const removable = template('TPL-SCN-002', '1', 0)
    const awaiting: ConfirmationContext = {
      confirmationId: 'CONF-P2-001',
      state: 'AWAITING_CONFIRMATION',
      actor: 'admin',
      role: 'ADMIN',
      createdAt: META.generatedAt,
      expiresAt: '2026-08-06T08:05:00Z',
    }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(success(awaiting)))
      .mockResolvedValueOnce(jsonResponse(success({ ...awaiting, state: 'CONFIRMED' })))
      .mockResolvedValueOnce(jsonResponse(success<DeleteResult>({ deleted: true, objectId: removable.templateId })))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    const scenario = useScenarioStore()
    scenario.$patch({ templates: [removable], selectedTemplate: template() })

    await expect(scenario.deleteTemplate(removable.templateId)).resolves.toBe(true)
    expect(scenario.templateState).toBe('EMPTY')
    expect(scenario.selectedTemplate?.templateId).toBe('TPL-SCN-001')
  })

  it('安全重置会清空模板投影并忽略延迟响应', async () => {
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise))
    const scenario = useScenarioStore()
    scenario.templates = [template()]
    const pending = scenario.loadTemplates()

    scenario.resetToSafeEmpty()
    response.resolve(jsonResponse(success([template()])))

    await expect(pending).resolves.toBe(false)
    expect(scenario.$state).toMatchObject({ templates: [], selectedTemplate: null, templateState: 'EMPTY', lastConfirmation: null })
  })
})

describe('P2-7/P2-8 场景快照与脚本 Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it('导入完整场景快照并依次撤销和重置', async () => {
    const imported = scenarioDraft(5)
    imported.config.scenario.name = '导入场景'
    const undone = scenarioDraft(6)
    const reset = scenarioDraft(7)
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(success({ imported: 1, rejected: 0, drafts: [imported] })))
      .mockResolvedValueOnce(jsonResponse(success(undone)))
      .mockResolvedValueOnce(jsonResponse(success(reset)))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    scenario.draft = scenarioDraft()

    await expect(scenario.importScenarioSnapshot(JSON.stringify(imported.config))).resolves.toBe(true)
    expect(scenario.draft?.config.scenario.name).toBe('导入场景')
    await expect(scenario.undoScenario()).resolves.toBe(true)
    await expect(scenario.resetScenario()).resolves.toBe(true)
    expect(scenario.draft?.revision).toBe(7)
    expect(fetchSpy).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:4173/api/v1/scenarios/import', expect.objectContaining({ method: 'POST' }))
    expect(fetchSpy).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:4173/api/v1/scenarios/SCN-001/undo', expect.objectContaining({ body: JSON.stringify({ expectedRevision: 5 }) }))
    expect(fetchSpy).toHaveBeenNthCalledWith(3, 'http://127.0.0.1:4173/api/v1/scenarios/SCN-001/reset', expect.objectContaining({ body: JSON.stringify({ expectedRevision: 6 }) }))
  })

  it('ERROR 阻断脚本，WARNING 一次确认后生成并预检', async () => {
    const invalidDraft = scenarioDraft()
    invalidDraft.config.output.directory = ''
    const blocked = inspectScenarioConfig(invalidDraft.config).result
    const warning = inspectScenarioConfig(scenarioDraft().config).result
    const awaiting: ConfirmationContext = {
      confirmationId: 'CONF-P2-SCRIPT', state: 'AWAITING_CONFIRMATION', actor: 'operator', role: 'OPERATOR',
      createdAt: META.generatedAt, expiresAt: '2026-08-06T08:05:00Z',
    }
    const script: ScriptContract = {
      scriptId: 'SCRIPT-P2-001', taskId: 'TASK-001', scenarioId: 'SCN-001', configVersion: 'SCN-001-v4',
      target: 'AFSIM 2.9.0', checksum: 'FNV1A-MOCK-12345678', preview: '# AFSIM 2.9.0 场景脚本预览；仅内存生成', generatedTime: META.generatedAt,
    }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(success(blocked)))
      .mockResolvedValueOnce(jsonResponse(success(warning)))
      .mockResolvedValueOnce(jsonResponse(apiFailure('场景存在校验警告，生成脚本前需要一次性确认。', undefined, 'CONFIRMATION_REQUIRED'), false))
      .mockResolvedValueOnce(jsonResponse(success(warning)))
      .mockResolvedValueOnce(jsonResponse(success(awaiting)))
      .mockResolvedValueOnce(jsonResponse(success({ ...awaiting, state: 'CONFIRMED' })))
      .mockResolvedValueOnce(jsonResponse(success(script)))
      .mockResolvedValueOnce(jsonResponse(success({ valid: true, errors: [], warnings: [] })))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    scenario.draft = invalidDraft

    await expect(scenario.generateScriptPreview()).resolves.toBe(false)
    expect(scenario.scriptResultCode).toBe('VALIDATION_FAILED')
    expect(scenario.script).toBeNull()
    scenario.draft = scenarioDraft()

    await expect(scenario.generateScriptPreview()).resolves.toBe(false)
    expect(scenario.scriptResultCode).toBe('CONFIRMATION_REQUIRED')
    await expect(scenario.generateScriptPreview(true)).resolves.toBe(true)
    expect(scenario.script).toEqual(script)
    expect(scenario.lastConfirmation?.state).toBe('CLOSED')
    await expect(scenario.preflightScript()).resolves.toBe(true)
    expect(scenario.scriptResultCode).toBe('PREFLIGHT_SUCCESS')

    scenario.markDirty()
    await expect(scenario.generateScriptPreview()).resolves.toBe(false)
    expect(scenario.scriptResultCode).toBe('UNSAVED_CHANGES')
    expect(fetchSpy).toHaveBeenCalledTimes(8)
  })

  it('拒绝损坏快照响应、非法文本和越权场景操作', async () => {
    const auth = useAuthStore()
    auth.$patch({ principal: { ...OPERATOR, permissions: [...OPERATOR.permissions] }, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    scenario.draft = scenarioDraft()
    await expect(scenario.importScenarioSnapshot('{')).resolves.toBe(false)
    expect(scenario.resultCode).toBe('VALIDATION_FAILED')
    await expect(scenario.importScenarioSnapshot(JSON.stringify([scenario.draft.config]))).resolves.toBe(false)
    expect(scenario.resultCode).toBe('VALIDATION_FAILED')

    const invalidResults = [
      null,
      [],
      {},
      { imported: 1, rejected: 0, drafts: [], extra: true },
      { imported: 1.5, rejected: 0, drafts: [] },
      { imported: 0, rejected: 0.5, drafts: [] },
      { imported: 1, rejected: 0, drafts: null },
      { imported: 1, rejected: 0, drafts: [] },
      { imported: 0, rejected: 1, drafts: [] },
      { imported: 1, rejected: 0, drafts: [{}] },
      { imported: 0, rejected: 0, drafts: [] },
    ]
    const fetchSpy = vi.fn()
    invalidResults.forEach((data) => fetchSpy.mockResolvedValueOnce(jsonResponse(success(data))))
    fetchSpy.mockResolvedValueOnce(jsonResponse(apiFailure('导入冲突。', 'items', 'CONFLICT'), false))
    vi.stubGlobal('fetch', fetchSpy)
    for (const _data of invalidResults) {
      await expect(scenario.importScenarioSnapshot(JSON.stringify(scenario.draft.config))).resolves.toBe(false)
      expect(scenario.resultCode).toBe('INVALID_RESPONSE')
    }
    await expect(scenario.importScenarioSnapshot(JSON.stringify(scenario.draft.config))).resolves.toBe(false)
    expect(scenario.resultCode).toBe('CONFLICT')

    scenario.draft = null
    await expect(scenario.undoScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('NOT_FOUND')
    scenario.draft = scenarioDraft()
    auth.$patch({ principal: { ...OPERATOR, permissions: ['BUSINESS_READ'] }, permissions: ['BUSINESS_READ'] })
    await expect(scenario.resetScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('PERMISSION_DENIED')
  })

  it('拒绝损坏脚本合同并展示预检失败和请求错误', async () => {
    const auth = useAuthStore()
    auth.$patch({ principal: { ...OPERATOR, permissions: [...OPERATOR.permissions] }, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    const config = scenarioDraft()
    config.config.scenario.environment.rainLossDbPerKm = 0.08
    scenario.draft = config
    const cleanValidation: ValidationResult = { valid: true, errors: [], warnings: [] }
    const validScript: ScriptContract = {
      scriptId: 'SCRIPT-P2-002', taskId: 'TASK-001', scenarioId: 'SCN-001', configVersion: 'SCN-001-v4',
      target: 'AFSIM 2.9.0', checksum: 'FNV1A-MOCK-87654321', preview: 'preview', generatedTime: META.generatedAt,
    }
    const malformedScripts = [
      null,
      [],
      {},
      { ...validScript, extra: true },
      { ...validScript, scriptId: '' },
      { ...validScript, taskId: 1 },
      { ...validScript, target: 'AFSIM 3.0' },
    ]
    for (const malformed of malformedScripts) {
      auth.$patch({ principal: { ...OPERATOR, permissions: [...OPERATOR.permissions] }, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(jsonResponse(success(cleanValidation)))
        .mockResolvedValueOnce(jsonResponse(success(malformed))))
      await expect(scenario.generateScriptPreview()).resolves.toBe(false)
      expect(scenario.scriptResultCode).toBe('INVALID_RESPONSE')
    }

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(success(cleanValidation)))
      .mockResolvedValueOnce(jsonResponse(success(validScript))))
    await expect(scenario.generateScriptPreview()).resolves.toBe(true)
    expect(scenario.lastConfirmation).toBeNull()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(success({
      valid: false,
      errors: [{ severity: 'ERROR', code: 'SCRIPT_VERSION_INVALID', message: '第 2 行，第 1 列：版本错误。', fieldPath: 'preview[2:1]' }],
      warnings: [],
    }))))
    await expect(scenario.preflightScript()).resolves.toBe(false)
    expect(scenario.scriptResultCode).toBe('PREFLIGHT_FAILED')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(apiFailure('校验和不匹配。', 'checksum'), false)))
    await expect(scenario.preflightScript()).resolves.toBe(false)
    expect(scenario.scriptResultMessage).toBe('校验和不匹配。')
    scenario.script = null
    await expect(scenario.preflightScript()).resolves.toBe(false)
  })

  it('处理场景操作和脚本端点的失败分支', async () => {
    const auth = useAuthStore()
    auth.$patch({ principal: { ...OPERATOR, permissions: [...OPERATOR.permissions] }, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    scenario.draft = scenarioDraft()
    const imported = scenarioDraft(5)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(success({ imported: 1, rejected: 0, drafts: [imported] }))))
    await expect(scenario.importScenarioSnapshot(JSON.stringify(imported.config))).resolves.toBe(true)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(apiFailure('修订冲突。', 'expectedRevision', 'CONFLICT'), false)))
    await expect(scenario.undoScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('CONFLICT')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(success(null))))
    await expect(scenario.resetScenario()).resolves.toBe(false)
    expect(scenario.resultCode).toBe('INVALID_RESPONSE')

    scenario.draft = null
    await expect(scenario.generateScriptPreview()).resolves.toBe(false)
    expect(scenario.scriptResultCode).toBe('EMPTY')
    scenario.draft = scenarioDraft()
    auth.$patch({ principal: { ...OPERATOR, permissions: ['BUSINESS_READ'] }, permissions: ['BUSINESS_READ'] })
    await expect(scenario.generateScriptPreview()).resolves.toBe(false)
    expect(scenario.scriptResultCode).toBe('PERMISSION_DENIED')

    auth.$patch({ principal: OPERATOR, permissions: [...OPERATOR.permissions] })
    const warning = inspectScenarioConfig(scenario.draft.config).result
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(success(warning)))
      .mockResolvedValueOnce(jsonResponse(apiFailure('确认创建失败。', undefined, 'CONFLICT'), false)))
    await expect(scenario.generateScriptPreview(true)).resolves.toBe(false)
    expect(scenario.scriptResultCode).toBe('CONFLICT')

    const cleanDraft = scenarioDraft()
    cleanDraft.config.scenario.environment.rainLossDbPerKm = 0.08
    scenario.draft = cleanDraft
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(success({ valid: true, errors: [], warnings: [] })))
      .mockResolvedValueOnce(jsonResponse(apiFailure('预览服务失败。', undefined, 'CONFLICT'), false)))
    await expect(scenario.generateScriptPreview()).resolves.toBe(false)
    expect(scenario.scriptResultCode).toBe('CONFLICT')

    scenario.script = {
      scriptId: 'SCRIPT-P2-FAIL', taskId: 'TASK-001', scenarioId: 'SCN-001', configVersion: 'SCN-001-v4',
      target: 'AFSIM 2.9.0', checksum: 'FNV1A-MOCK-FAIL', preview: 'preview', generatedTime: META.generatedAt,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(success(null))))
    await expect(scenario.preflightScript()).resolves.toBe(false)
    expect(scenario.scriptResultCode).toBe('INVALID_RESPONSE')
  })

  it.each(['logout', 'reset'].flatMap((operation) => ['create', 'confirm'].flatMap((stage) =>
    ['response', 'json'].map((boundary) => ({ operation, stage, boundary })),
  )))('确认 $stage/$boundary 在途时 $operation 不得恢复旧确认或继续预览', async ({ operation, stage, boundary }) => {
    const auth = useAuthStore()
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const confirmation = deferred<unknown>()
    const entered = deferred<void>()
    const resetResponse = deferred<Response>()
    const awaiting: ConfirmationContext = {
      confirmationId: 'CONF-P2-LATE', state: 'AWAITING_CONFIRMATION', actor: 'operator', role: 'OPERATOR',
      createdAt: META.generatedAt, expiresAt: '2026-08-06T08:05:00Z',
    }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(success(scenarioDraft())))
      .mockResolvedValueOnce(jsonResponse(success(inspectScenarioConfig(scenarioDraft().config).result)))
    if (stage === 'confirm') fetchSpy.mockResolvedValueOnce(jsonResponse(success(awaiting)))
    const pendingResponse = { ok: true, json: () => { entered.resolve(); return confirmation.promise } } as Response
    if (boundary === 'json') fetchSpy.mockResolvedValueOnce(pendingResponse)
    else fetchSpy.mockImplementationOnce(() => { entered.resolve(); return confirmation.promise })
    fetchSpy.mockReturnValueOnce(resetResponse.promise)
    vi.stubGlobal('fetch', fetchSpy)
    const scenario = useScenarioStore()
    await scenario.loadScenario()
    const pending = scenario.generateScriptPreview(true)
    await entered.promise
    const callsBeforeReset = fetchSpy.mock.calls.length
    const ui = useUiStore()
    let reset: Promise<boolean> | undefined
    if (operation === 'logout') {
      auth.resetToSafeEmpty()
      ui.cancelReset()
    } else {
      reset = ui.resetAllProjections()
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(callsBeforeReset + 1))
    }
    const payload = success(stage === 'confirm' ? { ...awaiting, state: 'CONFIRMED' } : awaiting)
    confirmation.resolve(boundary === 'json' ? payload : jsonResponse(payload))
    await expect(pending).resolves.toBe(false)
    expect(scenario).toMatchObject({ draft: null, lastConfirmation: null, script: null, scriptState: 'EMPTY' })
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/scripts/preview'))).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(callsBeforeReset + (operation === 'reset' ? 1 : 0))
    if (reset) {
      resetResponse.resolve(jsonResponse(apiFailure('受控重置失败。'), false))
      await expect(reset).resolves.toBe(false)
    }
  })

  it.each(['preview-success', 'preview-failure', 'preflight-success', 'preflight-failure'].flatMap((stage) =>
    ['response', 'json'].map((boundary) => ({ stage, boundary })),
  ))('编辑草稿后丢弃迟到的 $stage/$boundary', async ({ stage, boundary }) => {
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const cleanDraft = scenarioDraft()
    cleanDraft.config.scenario.environment.rainLossDbPerKm = 0.08
    const script: ScriptContract = {
      scriptId: 'SCRIPT-P2-LATE', taskId: 'TASK-001', scenarioId: 'SCN-001', configVersion: 'SCN-001-v4',
      target: 'AFSIM 2.9.0', checksum: 'FNV1A-MOCK-LATE', preview: 'preview', generatedTime: META.generatedAt,
    }
    const response = deferred<unknown>()
    const entered = deferred<void>()
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(success(cleanDraft)))
      .mockResolvedValueOnce(jsonResponse(success({ valid: true, errors: [], warnings: [] })))
    const preflight = stage.startsWith('preflight')
    if (preflight) fetchSpy.mockResolvedValueOnce(jsonResponse(success(script)))
    if (boundary === 'json') fetchSpy.mockResolvedValueOnce({ ok: true, json: () => { entered.resolve(); return response.promise } })
    else fetchSpy.mockImplementationOnce(() => { entered.resolve(); return response.promise })
    vi.stubGlobal('fetch', fetchSpy)
    const scenario = useScenarioStore()
    await scenario.loadScenario()
    if (preflight) await expect(scenario.generateScriptPreview()).resolves.toBe(true)
    const pending = preflight ? scenario.preflightScript() : scenario.generateScriptPreview()
    await entered.promise
    scenario.draft!.config.scenario.name = '已编辑的新草稿'
    scenario.markDirty()
    const cleared = JSON.parse(JSON.stringify(scenario.$state))
    if (stage.endsWith('failure')) response.reject(new Error('迟到的网络失败'))
    else {
      const payload = success(preflight ? { valid: true, errors: [], warnings: [] } : script)
      response.resolve(boundary === 'json' ? payload : jsonResponse(payload))
    }
    await expect(pending).resolves.toBe(false)
    expect(scenario.$state).toEqual(cleared)
    expect(scenario.dirty).toBe(true)
  })

  it.each(['edit', 'reset'] as const)('脚本生成的整体校验在途时 %s 不得回写或继续确认', async (operation) => {
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const response = deferred<Response>()
    const fetchSpy = vi.fn().mockResolvedValueOnce(jsonResponse(success(scenarioDraft()))).mockReturnValueOnce(response.promise)
    vi.stubGlobal('fetch', fetchSpy)
    const scenario = useScenarioStore()
    await scenario.loadScenario()
    const pending = scenario.generateScriptPreview(true)
    if (operation === 'edit') scenario.markDirty()
    else scenario.resetToSafeEmpty()
    const cleared = JSON.parse(JSON.stringify(scenario.$state))
    response.resolve(jsonResponse(success(inspectScenarioConfig(scenarioDraft().config).result)))
    await expect(pending).resolves.toBe(false)
    expect(scenario.$state).toEqual(cleared)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('全局重置后丢弃在途脚本预检结果', async () => {
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveResponse = resolve })))
    const scenario = useScenarioStore()
    scenario.script = {
      scriptId: 'SCRIPT-P2-PENDING', taskId: 'TASK-001', scenarioId: 'SCN-001', configVersion: 'SCN-001-v4',
      target: 'AFSIM 2.9.0', checksum: 'FNV1A-MOCK-PENDING', preview: 'preview', generatedTime: META.generatedAt,
    }

    const pending = scenario.preflightScript()
    scenario.resetToSafeEmpty()
    resolveResponse(jsonResponse(success({ valid: true, errors: [], warnings: [] })))

    await expect(pending).resolves.toBe(false)
    expect(scenario.scriptState).toBe('EMPTY')
    expect(scenario.script).toBeNull()
  })
})

describe('P2-1 场景基础字段校验', () => {
  it('兼容旧环境字段并保留已配置值，不修改源对象', () => {
    const original = scenarioDraft().config
    const normalized = withScenarioBasicDefaults(original)
    expect(original.scenario.environment).not.toHaveProperty('simClockSpeed')
    expect(normalized.scenario.duration).toBe(original.scenario.duration)
    expect(normalized.scenario.environment.rainLossDbPerKm).toBe(original.scenario.environment.rainLossDbPerKm)
    normalized.scenario.environment.simClockSpeed = 15
    normalized.scenario.environment.transmissionDistance = 410
    normalized.scenario.environment.rainCloudAttenuation = 'none'
    normalized.scenario.environment.multipathEnabled = false
    expect(withScenarioBasicDefaults(normalized)).toEqual(normalized)
    expect(inspectScenarioConfig(normalized).result.valid).toBe(true)
    expect(inspectScenarioConfig(normalized).identity?.environment).toEqual(normalized.scenario.environment)
    normalized.scenario.environment.transmissionDistance = 150
    expect(inspectScenarioConfig(normalized).result.valid).toBe(true)
  })

  it('按文档检查海峡宽度、倍速和气象档位，拒绝未知字段', () => {
    const cases: Array<[string, unknown[]]> = [
      ['simClockSpeed', [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]],
      ['transmissionDistance', [149, 411, Number.NaN, null]],
      ['rainCloudAttenuation', ['snow', '', null]],
    ]
    for (const [key, values] of cases) {
      for (const value of values) {
        const config = withScenarioBasicDefaults(scenarioDraft().config)
        Object.assign(config.scenario.environment, { [key]: value })
        expect(inspectScenarioConfig(config).result.errors).toContainEqual(expect.objectContaining({
          fieldPath: `scenario.environment.${key}`,
        }))
      }
    }
    const extra = withScenarioBasicDefaults(scenarioDraft().config)
    Object.assign(extra.scenario.environment, { simTotalTime: 20 })
    expect(inspectScenarioConfig(extra).result.valid).toBe(false)
  })

  it('按原型规则返回可定位警告且不影响有效性', () => {
    const defaultResult = inspectScenarioConfig(scenarioDraft().config).result
    expect(defaultResult.valid).toBe(true)
    expect(defaultResult.errors).toEqual([])
    expect(defaultResult.warnings).toContainEqual(expect.objectContaining({
      severity: 'WARNING',
      code: 'RAIN_LOSS_DEFAULT_MISMATCH',
      fieldPath: 'scenario.environment.rainLossDbPerKm',
    }))

    const incompleteCoverage = scenarioDraft().config
    incompleteCoverage.scenario.environment.rainLossDbPerKm = 0.08
    incompleteCoverage.platforms = incompleteCoverage.platforms.filter((platform) => platform.type !== 'FORWARD_RELAY_NODE')
    expect(inspectScenarioConfig(incompleteCoverage).result.warnings).toContainEqual(expect.objectContaining({
      code: 'CAPABILITY_COVERAGE_NOTICE',
      fieldPath: 'platforms',
    }))
  })

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

describe('P2-7 传感器、输出与信息需求字段校验', () => {
  it('定位三个数据域的全部字段错误', () => {
    const cases: Array<[string, (config: ScenarioConfig) => void]> = [
      ['sensors[0]', (config) => { config.sensors[0] = null as never }],
      ['sensors[0].id', (config) => { config.sensors[0]!.id = '' }],
      ['sensors[0].platformId', (config) => { config.sensors[0]!.platformId = 'MISSING' }],
      ['sensors[0].frequencyRange', (config) => { config.sensors[0]!.frequencyRange = null as never }],
      ['sensors[0].frequencyRange.min', (config) => { config.sensors[0]!.frequencyRange.min = 0 }],
      ['sensors[0].frequencyRange.max', (config) => { config.sensors[0]!.frequencyRange.max = 0 }],
      ['sensors[0].frequencyRange.max', (config) => { config.sensors[0]!.frequencyRange = { min: 2, max: 1 } }],
      ['sensors[0].detectionRange', (config) => { config.sensors[0]!.detectionRange = -1 }],
      ['output', (config) => { config.output = null as never }],
      ['output.directory', (config) => { config.output.directory = ' ' }],
      ['output.writeInterval', (config) => { config.output.writeInterval = 0 }],
      ['output.writeInterval', (config) => { config.output.writeInterval = config.scenario.timeStep / 2 }],
      ['output.linkQualityEnabled', (config) => { config.output.linkQualityEnabled = 'yes' as never }],
      ['output.eventsEnabled', (config) => { config.output.eventsEnabled = 'yes' as never }],
      ['output.linkSwitchEnabled', (config) => { config.output.linkSwitchEnabled = 'yes' as never }],
      ['informationDemand[0]', (config) => { config.informationDemand[0] = null as never }],
      ['informationDemand[0].id', (config) => { config.informationDemand[0]!.id = '' }],
      ['informationDemand[0].sourcePlatformId', (config) => { config.informationDemand[0]!.sourcePlatformId = 'MISSING' }],
      ['informationDemand[0].destinationPlatformIds', (config) => { config.informationDemand[0]!.destinationPlatformIds = [] }],
      ['informationDemand[0].destinationPlatformIds', (config) => { const id = config.platforms[0]!.id; config.informationDemand[0]!.destinationPlatformIds = [id, id] }],
      ['informationDemand[0].informationType', (config) => { config.informationDemand[0]!.informationType = 1 as never }],
      ['informationDemand[0].volumeMb', (config) => { config.informationDemand[0]!.volumeMb = -1 }],
      ['informationDemand[0].frequencyHz', (config) => { config.informationDemand[0]!.frequencyHz = -1 }],
      ['informationDemand[0].priority', (config) => { config.informationDemand[0]!.priority = 'LOW' as never }],
      ['informationDemand[0].maxLatencyMs', (config) => { config.informationDemand[0]!.maxLatencyMs = -1 }],
      ['informationDemand[0].minDataRateMbps', (config) => { config.informationDemand[0]!.minDataRateMbps = -1 }],
    ]

    for (const [fieldPath, mutate] of cases) {
      const config = scenarioDraft().config
      mutate(config)
      expect(inspectScenarioConfig(config).result.errors.map((issue) => issue.fieldPath)).toContain(fieldPath)
    }
  })

  it('定位传感器界面扩展的闭合字段和一一对应错误', () => {
    const { config, uiExtensions } = scenarioDraft()
    const jammerIds = config.jammers.map((jammer) => jammer.id)
    const sensorIds = config.sensors.map((sensor) => sensor.id)
    const cases: Array<[string, unknown]> = [
      ['uiExtensions.sensors[0]', [null]],
      ['uiExtensions.sensors[0]', [{ ...uiExtensions.sensors[0], extra: true }]],
      ['uiExtensions.sensors[0].sensorId', [{ ...uiExtensions.sensors[0], sensorId: '' }]],
      ['uiExtensions.sensors[0].type', [{ ...uiExtensions.sensors[0], type: 'RADAR' }]],
      ['uiExtensions.sensors[0].direction', [{ ...uiExtensions.sensors[0], direction: 361 }]],
      ['uiExtensions.sensors[0].probability', [{ ...uiExtensions.sensors[0], probability: 2 }]],
      ['uiExtensions.sensors[0].enabled', [{ ...uiExtensions.sensors[0], enabled: 'yes' }]],
      ['uiExtensions.sensors', [{ ...uiExtensions.sensors[0] }, { ...uiExtensions.sensors[0] }]],
      ['uiExtensions.sensors', []],
    ]
    for (const [fieldPath, sensors] of cases) {
      expect(inspectScenarioUiExtensions({ jammers: uiExtensions.jammers, sensors }, jammerIds, sensorIds).result.errors
        .map((issue) => issue.fieldPath)).toContain(fieldPath)
    }
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
      id: 'CAPACITY-051',
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

  it('校验节点类型数量上限及通信卫星子类型', () => {
    const duplicateRear = scenarioDraft().config
    const source = structuredClone(duplicateRear.platforms[0]!)
    duplicateRear.platforms.push({ ...source, id: 'CMD-02', name: '重复后方指挥节点', linkIds: [], sensorIds: [], jammerIds: [] })
    expect(inspectScenarioConfig(duplicateRear).result.errors).toContainEqual(expect.objectContaining({
      code: 'NODE_TYPE_LIMIT_EXCEEDED',
      fieldPath: 'platforms',
    }))

    const invalidSatellite = scenarioDraft().config
    invalidSatellite.platforms.find((platform) => platform.type === 'COMMUNICATION_SATELLITE')!.satelliteType = 'UNKNOWN' as never
    expect(inspectScenarioConfig(invalidSatellite).result.errors).toContainEqual(expect.objectContaining({
      code: 'SATELLITE_TYPE_INVALID',
      fieldPath: 'platforms[6].satelliteType',
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

  it('拒绝与场景实体类型不一致的部署域', () => {
    const config = scenarioDraft().config
    config.platforms[0]!.category = 'air'

    expect(inspectScenarioConfig(config).result.errors).toContainEqual(expect.objectContaining({
      code: 'PLATFORM_CATEGORY_MISMATCH',
      fieldPath: 'platforms[0].category',
    }))
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
  it('时长非法只跳过触发时间上限，仍拒绝非法触发值', () => {
    const config = scenarioDraft().config
    for (const duration of [Number.NaN, 0, -1]) {
      config.scenario.duration = duration
      config.jammers[0]!.triggerTimeS = 50
      const errors = inspectScenarioConfig(config, 'write').result.errors
      expect(errors).toContainEqual(expect.objectContaining({ fieldPath: 'scenario.duration' }))
      expect(errors.some(issue => issue.fieldPath === 'jammers[0].triggerTimeS')).toBe(false)
    }
    for (const triggerTimeS of [-1, Number.NaN, Infinity]) {
      config.jammers[0]!.triggerTimeS = triggerTimeS
      expect(inspectScenarioConfig(config, 'write').result.errors).toContainEqual(expect.objectContaining({ fieldPath: 'jammers[0].triggerTimeS' }))
    }
  })

  it('敌方干扰支持扫频与总开关，写入限制海里范围和触发时刻且旧读取不改值', () => {
    const config = scenarioDraft().config
    config.jammingEnabled = false
    config.jammers[0]!.type = 'SWEEP'
    config.jammers[0]!.triggerTimeS = 300
    for (const range of [1852, 44448]) {
      config.jammers[0]!.detectionRange = range
      expect(inspectScenarioConfig(config, 'write').result.valid).toBe(true)
    }
    for (const range of [0, 1851, 44449, Number.NaN]) {
      config.jammers[0]!.detectionRange = range
      expect(inspectScenarioConfig(config, 'write').result.errors.map(issue => issue.fieldPath)).toContain('jammers[0].detectionRange')
    }
    config.jammers[0]!.detectionRange = 150000
    expect(inspectScenarioConfig(config, 'read').result.valid).toBe(true)
    expect(config.jammers[0]!.detectionRange).toBe(150000)
    config.jammers[0]!.detectionRange = 44448
    for (const trigger of [-1, config.scenario.duration + 1, Number.NaN]) {
      config.jammers[0]!.triggerTimeS = trigger
      expect(inspectScenarioConfig(config, 'write').result.errors.map(issue => issue.fieldPath)).toContain('jammers[0].triggerTimeS')
    }
    for (const trigger of [0, config.scenario.duration]) {
      config.jammers[0]!.triggerTimeS = trigger
      expect(inspectScenarioConfig(config, 'write').result.valid).toBe(true)
    }
    config.jammingEnabled = 'false' as never
    expect(inspectScenarioConfig(config, 'write').result.errors.map(issue => issue.fieldPath)).toContain('jammingEnabled')
  })
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
    const jammerIds = config.jammers.map((jammer) => jammer.id)
    const sensorIds = config.sensors.map((sensor) => sensor.id)
    expect(inspectScenarioUiExtensions(uiExtensions, jammerIds, sensorIds).result.valid).toBe(true)

    const cases = [
      ['uiExtensions.jammers', [{ ...uiExtensions.jammers[0] }, { ...uiExtensions.jammers[0] }]],
      ['uiExtensions.jammers[0].jammerId', [{ ...uiExtensions.jammers[0], jammerId: '' }, uiExtensions.jammers[1]]],
      ['uiExtensions.jammers[0].direction', [{ ...uiExtensions.jammers[0], direction: 361 }, uiExtensions.jammers[1]]],
      ['uiExtensions.jammers[0].duration', [{ ...uiExtensions.jammers[0], duration: -1 }, uiExtensions.jammers[1]]],
      ['uiExtensions.jammers[0].enabled', [{ ...uiExtensions.jammers[0], enabled: 'yes' }, uiExtensions.jammers[1]]],
    ] as const
    for (const [fieldPath, jammers] of cases) {
      expect(inspectScenarioUiExtensions({ jammers, sensors: uiExtensions.sensors }, jammerIds, sensorIds).result.errors
        .map((issue) => issue.fieldPath)).toContain(fieldPath)
    }

    expect(inspectScenarioUiExtensions(null, jammerIds, sensorIds).result.errors[0]?.fieldPath).toBe('uiExtensions')
    expect(inspectScenarioUiExtensions({ jammers: [null, uiExtensions.jammers[1]], sensors: uiExtensions.sensors }, jammerIds, sensorIds).result.errors
      .map((issue) => issue.fieldPath)).toContain('uiExtensions.jammers[0]')
    expect(inspectScenarioUiExtensions({ jammers: [], sensors: null }, []).result.errors[0]?.fieldPath).toBe('uiExtensions')
  })
})

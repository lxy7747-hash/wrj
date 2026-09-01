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
  ValidationResult,
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
const ADMIN: Principal = {
  userId: 'USR-ADMIN',
  username: 'admin',
  role: 'ADMIN',
  permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE', 'OFFICIAL_TEMPLATE_MAINTAIN'],
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

    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
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

describe('P2-1 场景基础字段校验', () => {
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

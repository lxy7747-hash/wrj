import { RELAY_DEFAULT_ROUTE } from '../../src/features/scenarios/platform-position-rules'
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, toRaw } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ApiSuccess, ConfirmationContext, PageMeta, Principal, ScenarioConfig, ScenarioDraft, ScenarioTemplate, ScriptContract, ValidationResult } from '../../src/contracts/domain-models'
import { INFORMATION_NODE_LIMIT, inspectScenarioConfig, isBusinessInformationNodeType, LINK_MHZ_MINIMUM_STEP } from '../../src/features/scenarios/scenario-validation'
import { scenarioPlatformLabel, SCENARIO_BASIC_DEFAULTS, withScenarioBasicDefaults } from '../../src/features/scenarios/scenario-basic'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'
import AdminPage from '../../src/pages/admin/admin.vue'
import ScenariosPage from '../../src/pages/scenarios/scenarios.vue'
import { createAppRouter } from '../../src/router'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'

enableAutoUnmount(afterEach)
vi.mock('../../src/features/scenarios/script-file', () => ({ saveScriptText: vi.fn().mockResolvedValue('H:\\output\\SCN-001-r5.txt') }))

function mockGeneratedScript(store: ReturnType<typeof useScenarioStore>): void {
  vi.spyOn(ElMessageBox, 'alert').mockResolvedValue('confirm' as never)
  vi.spyOn(store, 'generateScriptPreview').mockImplementation(async () => {
    const current = store.draft!
    store.script = { scriptId: 'SCRIPT-TEST', taskId: 'TASK-001', scenarioId: current.config.scenario.id,
      configVersion: `${current.config.scenario.id}-v${current.revision}`, target: 'AFSIM 2.9.0',
      checksum: 'FNV1A-MOCK-TEST', preview: '# 组件流程测试', generatedTime: META.generatedAt }
    return true
  })
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
const META: PageMeta = {
  requestId: 'REQ-P2-COMPONENT',
  generatedAt: '2026-08-06T08:00:00Z',
  page: 1,
  pageSize: 1,
  total: 1,
}

/** 创建组件测试使用的独立场景草稿。 */
function draft(revision = 4): ScenarioDraft {
  // 多设备交互用例自行创建合规的第二台设备，不恢复已删除的默认旧归属。
  const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
  // V1.2 写入夹具采用合法档位；D6 同类参数共用，瞄准式挂到另一类机载平台。
  Object.assign(config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
  const station = config.platforms.find(platform => platform.id === 'STN-01')!
  config.platforms.push({ ...structuredClone(station), id: 'STN-02', name: '机载干扰平台 2', type: 'AIRBORNE_JAMMER_PLATFORM', category: 'air', sensorIds: [], jammerIds: ['JAM-SPOT-01-TX'],
    initialPosition: { ...station.initialPosition, longitude: station.initialPosition.longitude + 0.05 } })
  config.jammers.push({ ...config.jammers[0]!, id: 'JAM-SPOT-01-TX', platformId: 'STN-02', type: 'SPOT', bandwidth: 5 })
  return {
    config,
    uiExtensions: {
      jammers: [
        { jammerId: 'JAM-WB-01-TX', direction: 0, enabled: true },
        { jammerId: 'JAM-SPOT-01-TX', direction: 0, enabled: false },
      ],
      sensors: [{ sensorId: 'ESM-01', type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true }],
    },
    revision,
    officialLibraryChanged: false,
    locked: false,
  }
}

/** 创建场景成功响应。 */
function response(data: ScenarioDraft): Response {
  const body: ApiSuccess<ScenarioDraft> = { ok: true, data, meta: META }
  return { ok: true, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}

/** 创建整体场景校验成功信封。 */
function validationResponse(data: ValidationResult): Response {
  const body: ApiSuccess<ValidationResult> = { ok: true, data, meta: META }
  return { ok: true, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}

/** 创建模板库组件测试使用的官方模板。 */
function template(): ScenarioTemplate {
  return {
    templateId: 'TPL-SCN-001',
    name: '跨海通联演示官方基线',
    version: '4',
    official: true,
    config: draft().config,
    referenceCount: 2,
  }
}

function confirmation(): ConfirmationContext {
  return {
    confirmationId: 'CONF-P2-001',
    state: 'CLOSED',
    actor: 'admin',
    role: 'ADMIN',
    createdAt: META.generatedAt,
    expiresAt: '2026-08-06T08:05:00Z',
  }
}

describe('P2-1 场景管理页面', () => {
  it('关联资源只在节点详情展示，查看不修改草稿，锁定仍可查看且切换草稿关闭详情', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore()
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS', dirty: false })
    const original = JSON.stringify(scenario.draft)
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await wrapper.get('#tab-platforms').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="detail-platform-0"]').trigger('click')
    await flushPromises()
    const details = () => document.querySelector<HTMLElement>('[data-testid="platform-details"]')!
    expect(details().textContent).toContain(scenario.draft!.config.platforms[0]!.name)
    expect(details().querySelector('[data-testid="platform-link-ids"]')!.textContent)
      .toContain(`${scenario.draft!.config.platforms[0]!.linkIds.length} 条关联链路`)
    expect(details().querySelector('[data-testid="platform-sensor-ids"]')!.textContent).toBe('暂无关联传感器')
    expect(details().querySelector('input')).toBeNull()
    expect(JSON.stringify(scenario.draft)).toBe(original)
    expect(scenario.dirty).toBe(false)
    document.querySelector<HTMLElement>('[data-testid="close-platform-details"]')!.click()
    await flushPromises()
    await wrapper.get('[data-testid="show-scenario-ids"] input').setValue(true)
    await wrapper.get('[data-testid="detail-platform-7"]').trigger('click')
    await flushPromises()
    const station = scenario.draft!.config.platforms[7]!
    expect(details().querySelector('[data-testid="platform-sensor-ids"]')!.textContent).toContain('ESM-01')
    expect(details().querySelector('[data-testid="platform-jammer-ids"]')!.textContent).toBe(station.jammerIds.join('、'))
    expect(details().querySelector('[data-testid="platform-link-ids"]')!.textContent).toBe('暂无关联链路')
    scenario.projectRuntimeLock(scenario.draft!.config.scenario.id, true)
    document.querySelector<HTMLElement>('[data-testid="close-platform-details"]')!.click()
    await flushPromises()
    expect(wrapper.get('[data-testid="detail-platform-0"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="detail-platform-0"]').trigger('click')
    await flushPromises()
    expect(details().querySelector('[data-testid="platform-link-ids"]')!.textContent)
      .toBe(scenario.draft!.config.platforms[0]!.linkIds.join('、'))
    scenario.draft!.config.platforms[0]!.linkIds = []
    await nextTick()
    expect(details().querySelector('[data-testid="platform-link-ids"]')!.textContent).toBe('暂无关联链路')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(draft(5))))
    await expect(scenario.loadScenario()).resolves.toBe(true)
    await flushPromises()
    expect(document.querySelector('[data-testid="platform-details"]')).toBeNull()
    wrapper.unmount()
  })

  it('新增和编辑节点弹框不再包含关联资源', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore()
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await wrapper.get('#tab-platforms').trigger('click')
    for (const action of ['add-platform', 'edit-platform-3']) {
      await wrapper.get(`[data-testid="${action}"]`).trigger('click')
      await flushPromises()
      const editor = document.querySelector<HTMLElement>('[data-testid="platform-dialog"]')!
      expect(editor.textContent).not.toContain('关联资源')
      expect(editor.querySelector('[data-testid="platform-link-ids"]')).toBeNull()
      document.querySelector<HTMLElement>('[data-testid="cancel-platform"]')!.click()
      await flushPromises()
    }
    wrapper.unmount()
  })

  it('默认显示参数界面，无配置参数按钮，辅助面板仍可通过页签返回', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const store = useScenarioStore()
    store.createScenario()
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="workflow-config"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="open-scenario-templates"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="scenario-name"]').isVisible()).toBe(true)
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    expect(wrapper.get('#tab-scenario').isVisible()).toBe(true)
    expect(wrapper.get('.scenario-tabs').classes()).toContain('scenario-tabs--navigation-only')
    await wrapper.get('#tab-scenario').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="scenario-name"]').isVisible()).toBe(true)
    expect(wrapper.get('.scenario-tabs').classes()).not.toContain('scenario-tabs--navigation-only')
  })

  it('新建只显示必填标记，编辑或失焦后按字段提示，保存仍拦截全部错误且新草稿不继承提示', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const store = useScenarioStore()
    expect(store.createScenario()).toBe(true)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    const nameField = () => wrapper.get('[data-field-path="scenario.name"]')
    const timeField = () => wrapper.get('[data-field-path="scenario.startTime"]')
    expect(wrapper.find('[data-testid="scenario-live-validation"]').exists()).toBe(false)
    expect(wrapper.findAll('.el-form-item.is-error')).toHaveLength(0)
    expect(nameField().classes()).toContain('is-required')
    await wrapper.get('[data-testid="scenario-name"]').trigger('focusout')
    await vi.waitFor(() => expect(nameField().text()).toContain('场景名称为必填项'))
    expect(timeField().find('.el-form-item__error').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scenario-live-validation"]').exists()).toBe(false)
    await wrapper.get('[data-testid="scenario-name"]').setValue('新场景')
    await vi.waitFor(() => expect(nameField().find('.el-form-item__error').exists()).toBe(false))
    await wrapper.get('[data-testid="scenario-name"]').setValue('')
    await vi.waitFor(() => expect(nameField().text()).toContain('场景名称为必填项'))
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="scenario-live-validation"]').text()).toContain('不能保存')
    expect(store.validation.valid).toBe(false)
    expect(wrapper.get('[data-testid="validation-panel"]').text()).toContain('场景名称为必填项')
    expect(wrapper.get('[data-testid="validation-panel"]').text()).toContain('基本信息 · 场景名称')
    expect(wrapper.get('[data-testid="validation-panel"]').text()).not.toContain('scenario.name')
    expect(wrapper.find('[data-testid="workflow-script"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="preflight-script"]').exists()).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(store.draft!.revision).toBe(0)
    store.resetToSafeEmpty()
    expect(store.createScenario()).toBe(true)
    await flushPromises()
    expect(wrapper.find('[data-testid="scenario-live-validation"]').exists()).toBe(false)
    await vi.waitFor(() => expect(wrapper.findAll('.el-form-item__error')).toHaveLength(0))
    wrapper.unmount()
  })

  it('加载零速度航点后立即显示问题，未点击保存也能定位；保存不发出写请求', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const value = draft()
    const platform = value.config.platforms[3]!
    platform.waypoints = [{ ...platform.initialPosition, speed: 0, arrivalTime: 0 }]
    const fetchSpy = vi.fn().mockResolvedValue(response(value))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    expect(wrapper.get('[data-testid="scenario-live-validation"]').text()).toContain('platforms[3].waypoints[0].speed')
    expect(wrapper.get('[data-testid="scenario-live-validation"]').text()).toContain('至少为 1 m/s')
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    expect(fetchSpy.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
    expect(useScenarioStore().draft!.revision).toBe(value.revision)
    await wrapper.get('[data-testid="scenario-name"]').setValue('')
    await flushPromises()
    expect(wrapper.text()).toContain('场景名称为必填项')
    wrapper.unmount()
  })

  it('管理员从已保存场景另存完整模板，原场景不变；取消和修改后禁止误存', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: structuredClone(ADMIN), role: 'ADMIN', permissions: [...ADMIN.permissions] })
    const initial = draft()
    const fetchSpy = vi.fn().mockResolvedValueOnce(response(initial))
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: {
        ...template(), name: '另存测试', config: initial.config, uiExtensions: initial.uiExtensions,
      }, meta: META }) })
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    const store = useScenarioStore()
    const before = JSON.stringify(store.draft)
    const saved = JSON.parse(before) as ScenarioDraft
    const prompt = vi.spyOn(ElMessageBox, 'prompt').mockResolvedValue({ value: '另存测试' } as never)
    await wrapper.get('[data-testid="save-as-template"]').trigger('click')
    await flushPromises()
    expect(fetchSpy.mock.calls.at(-1)![0]).toContain('/api/v1/templates')
    expect(JSON.parse(fetchSpy.mock.calls.at(-1)![1].body)).toEqual({ name: '另存测试', config: saved.config, uiExtensions: saved.uiExtensions })
    expect(JSON.stringify(store.draft)).toBe(before)
    expect(store.dirty).toBe(false)
    prompt.mockRejectedValueOnce('cancel')
    await wrapper.get('[data-testid="save-as-template"]').trigger('click')
    await flushPromises()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    await wrapper.get('[data-testid="scenario-name"]').setValue('未保存修改')
    expect(wrapper.get('[data-testid="save-as-template"]').attributes('disabled')).toBeDefined()
    useAuthStore().$patch({ principal: structuredClone(OPERATOR), role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    await nextTick()
    expect(wrapper.find('[data-testid="save-as-template"]').exists()).toBe(false)
  })

  it('另存模板确认期间登出，迟到确认不创建模板', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    const fetchSpy = vi.fn().mockResolvedValue(response(draft()))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    let confirm!: (value: { value: string }) => void
    vi.spyOn(ElMessageBox, 'prompt').mockImplementation(() => new Promise(resolve => { confirm = resolve as typeof confirm }) as never)
    await wrapper.get('[data-testid="save-as-template"]').trigger('click')
    useScenarioStore().resetToSafeEmpty()
    confirm({ value: '过期模板' })
    await flushPromises()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(useScenarioStore().templates).toEqual([])
  })

  it('非默认场景重新加载失败后连续重试，恢复后仍显示原场景', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const original = draft()
    original.config.scenario.id = 'SCN-B'
    original.config.scenario.name = '场景 B'
    const fetchSpy = vi.fn().mockResolvedValueOnce(response(original))
      .mockRejectedValueOnce(new Error('暂时不可用'))
      .mockRejectedValueOnce(new Error('仍不可用'))
      .mockResolvedValueOnce(response(original))
    vi.stubGlobal('fetch', fetchSpy)
    const store = useScenarioStore()
    expect(await store.loadScenario('SCN-B')).toBe(true)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await store.loadScenario('SCN-B')
    await flushPromises()
    for (const expected of ['ERROR', 'SUCCESS']) {
      await wrapper.findAll('button').find(button => button.text() === '重新加载')!.trigger('click')
      await flushPromises()
      expect(store.panelState).toBe(expected)
    }
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual(Array(4).fill('http://127.0.0.1:4173/api/v1/scenarios/SCN-B'))
    expect(store.draft?.config.scenario.id).toBe('SCN-B')
    expect(wrapper.get('[data-testid="scenario-name"]').element).toHaveProperty('value', '场景 B')
  })

  it('默认隐藏编号，显示编号开关不改变草稿和关联；弹框仍保留自动编号', { timeout: 30_000 }, async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const initial = draft()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(initial)))
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    const store = useScenarioStore()
    const original = JSON.stringify(store.draft)
    const toggle = wrapper.get('[data-testid="show-scenario-ids"] input')
    expect(wrapper.get('[data-testid="scenario-id"]').isVisible()).toBe(false)
    await toggle.setValue(true)
    expect(wrapper.get('[data-testid="scenario-id"]').isVisible()).toBe(true)
    await toggle.setValue(false)
    for (const [tab, kind, header] of [
      ['platforms', 'platform', '节点 ID'], ['links', 'link', '链路 ID'], ['jammers', 'jammer', '设备 ID'],
    ]) {
      await wrapper.get(`#tab-${tab}`).trigger('click')
      await flushPromises()
      expect(wrapper.get(`[data-testid="${kind}-table"]`).text()).not.toContain(header)
      await wrapper.get(`[data-testid="edit-${kind}-0"]`).trigger('click')
      await flushPromises()
      if (kind === 'platform') expect(document.querySelector('[data-testid="platform-dialog"] .el-dialog__title')?.textContent).toBe('编辑节点')
      const id = document.querySelector<HTMLInputElement>(`[data-testid="${kind}-id"]`)!
      expect(id.closest('.el-form-item')?.getAttribute('style')).toContain('display: none')
      const value = id.value
      await toggle.setValue(true)
      expect(wrapper.get(`[data-testid="${kind}-table"]`).text()).toContain(header)
      expect(id.closest('.el-form-item')?.getAttribute('style')).not.toContain('display: none')
      expect(id.value).toBe(value)
      document.querySelector<HTMLElement>(`[data-testid="cancel-${kind}"]`)!.click()
      await flushPromises()
      await toggle.setValue(false)
    }
    // 传感器页已并入“干扰设备”，不再提供独立的传感器表格。
    expect(wrapper.find('#tab-data').exists()).toBe(false)
    expect(wrapper.find('[data-testid="sensor-table"]').exists()).toBe(false)
    expect(JSON.stringify(store.draft)).toBe(original)
    expect(store.dirty).toBe(false)
    expect(scenarioPlatformLabel([{ id: 'A', name: '节点' }], 'A')).toBe('节点')
    expect(scenarioPlatformLabel([{ id: 'A', name: '节点' }, { id: 'B', name: '节点' }], 'A')).toBe('节点（A）')
    expect(scenarioPlatformLabel([], 'MISSING')).toBe('MISSING')
  })

  it('空态点击新建后显示空白配置表单，不自动请求保存且不带入演示节点', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({
      ok: false, error: { code: 'NOT_FOUND', message: '暂无场景。', retryable: false, correlationId: 'CORR-EMPTY' },
      meta: { requestId: META.requestId, generatedAt: META.generatedAt },
    }) })
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    await wrapper.get('[data-testid="create-scenario"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="scenario-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scenario-editor"]').exists()).toBe(true)
    expect(wrapper.get<HTMLInputElement>('[data-testid="scenario-name"]').element.value).toBe('')
    expect(wrapper.get<HTMLInputElement>('[data-testid="scenario-start-time"] input').element.value).toBe('')
    expect(useScenarioStore().draft!.config.platforms).toEqual([])
    expect(useScenarioStore().dirty).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    expect(useScenarioStore().validation.errors.length).toBeGreaterThan(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('空库保持空态，不再提供场景操作或快照导入入口', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({
        ok: false, error: { code: 'NOT_FOUND', message: '暂无场景。', retryable: false, correlationId: 'CORR-EMPTY' },
        meta: { requestId: META.requestId, generatedAt: META.generatedAt },
      }) })
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    expect(wrapper.get('[data-testid="scenario-empty"]').text()).toContain('暂无场景')
    expect(wrapper.find('[data-testid="scenario-editor"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeDefined()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="import-scenario-snapshot"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="open-scenario-operations"]').exists()).toBe(false)
  })

  it('空库编辑页不再显示场景模板入口，可直接新建场景', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const fetchSpy = vi.fn().mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({
      ok: false, error: { code: 'NOT_FOUND', message: '暂无场景。', retryable: false, correlationId: 'CORR-EMPTY' },
      meta: { requestId: META.requestId, generatedAt: META.generatedAt },
    }) })
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="open-scenario-templates"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scenario-empty"]').exists()).toBe(true)
    await wrapper.get('[data-testid="create-scenario"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="scenario-editor"]').exists()).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('机载干扰平台作为空中支撑实体新增、保存回读且可作为干扰归属平台', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    let persisted = draft()
    const businessCount = persisted.config.platforms.filter(p => isBusinessInformationNodeType(p.type)).length
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body))
        persisted = { ...persisted, config: body.config, uiExtensions: body.uiExtensions, revision: persisted.revision + 1 }
      }
      return response(structuredClone(persisted))
    }))
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    await wrapper.get('#tab-platforms').trigger('click')
    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await flushPromises()
    const type = wrapper.findAllComponents({ name: 'ElSelect' }).find(c => c.attributes('data-testid') === 'platform-type')!
    expect(type.findAllComponents({ name: 'ElOptionGroup' }).find(c => c.props('label').startsWith('支撑实体'))!
      .findAllComponents({ name: 'ElOption' }).map(c => c.props('label'))).toContain('机载干扰设备')
    type.vm.$emit('update:modelValue', 'AIRBORNE_JAMMER_PLATFORM')
    type.vm.$emit('change', 'AIRBORNE_JAMMER_PLATFORM')
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('[data-testid="platform-name"]')!
    input.value = '机载干扰测试'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelector<HTMLInputElement>('[data-testid="platform-category"]')!.value).toBe('空中')
    const numbers = wrapper.findAllComponents({ name: 'ElInputNumber' })
    for (const [field, value] of [['longitude', 120.5], ['latitude', 26], ['altitude', 5000]] as const) {
      const number = numbers.find(c => c.attributes('data-testid') === `platform-${field}`)!
      expect(number.get('input').attributes('disabled')).toBeUndefined()
      number.vm.$emit('update:modelValue', value)
    }
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(scenario.draft!.config.platforms.at(-1)).toMatchObject({ name: '机载干扰测试', type: 'AIRBORNE_JAMMER_PLATFORM', category: 'air' })
    expect(scenario.draft!.config.platforms.filter(p => isBusinessInformationNodeType(p.type))).toHaveLength(businessCount)
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    expect(persisted.revision).toBe(5)
    expect(await scenario.loadScenario()).toBe(true)
    await flushPromises()
    await wrapper.get('#tab-platforms').trigger('click')
    expect(wrapper.get('[data-testid="platform-table"]').text()).toContain('机载干扰设备')
    expect(scenario.draft!.config.platforms.at(-1)).toMatchObject({ type: 'AIRBORNE_JAMMER_PLATFORM', initialPosition: { longitude: 120.5, latitude: 26, altitude: 5000 } })
    await wrapper.get('#tab-jammers').trigger('click')
    await wrapper.get('[data-testid="add-jammer"]').trigger('click')
    await flushPromises()
    const owner = wrapper.findAllComponents({ name: 'ElSelect' }).find(c => c.attributes('data-testid') === 'jammer-platform')!
    expect(owner.props('modelValue')).toBe('')
    document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('干扰设备必须归属于当前节点。')
    expect(scenario.draft!.config.jammers).toHaveLength(2)
    expect(owner.findAllComponents({ name: 'ElOption' }).some(c => c.props('label').startsWith('机载干扰测试'))).toBe(true)
  })

  afterEach(() => {
    ElMessage.closeAll()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('场景卫星仅在列表上方展示一次，不作为逐链路中继，选择不改变链路独立状态', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    const current = draft()
    const tiantong = current.config.platforms.find(p => p.satelliteType === 'TIANTONG')!
    current.config.platforms.push({ ...structuredClone(tiantong), id: 'SAT-ST', satelliteType: 'SHENTONG' })
    const satelliteLink = current.config.links.find(link => link.type === 'SAT')!
    current.config.links = [
      { ...satelliteLink, id: 'L-TT', sourcePlatformId: tiantong.id, targetPlatformId: 'UAV-01', enabled: true },
      { ...satelliteLink, id: 'L-ST', sourcePlatformId: 'SAT-ST', targetPlatformId: 'UAV-01', enabled: true },
      { ...satelliteLink, id: 'L-OFF', sourcePlatformId: tiantong.id, targetPlatformId: 'UAV-01', enabled: false },
      { ...satelliteLink, id: 'L-NONE', type: 'MICROWAVE', sourcePlatformId: 'CMD-01', targetPlatformId: 'UAV-01', relayPlatformId: undefined, enabled: true },
      { ...satelliteLink, id: 'L-RELAY', sourcePlatformId: 'CMD-01', targetPlatformId: 'UAV-01', relayPlatformId: 'SAT-ST', enabled: true },
    ]
    scenario.$patch({ draft: current, panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await wrapper.get('#tab-links').trigger('click')
    const labels = () => wrapper.get('[data-testid="link-table"]').findAll('.el-tag').map(tag => tag.text())
    expect(labels()).toEqual(['启用', '启用', '停用', '启用', '启用'])
    const table = wrapper.get('[data-testid="link-table"]')
    expect(table.text()).not.toContain('参与场景')
    expect(table.text()).toContain('链路状态')
    const headers = table.findAll('th').map(cell => cell.text())
    expect(headers).not.toContain('中继卫星')
    expect(headers).toContain('中继节点')
    expect(headers).not.toContain('业务')
    const relayColumnIndex = headers.indexOf('中继节点')
    const sat01Label = scenarioPlatformLabel(scenario.draft!.config.platforms, 'SAT-01', false)
    const satStLabel = scenarioPlatformLabel(scenario.draft!.config.platforms, 'SAT-ST', false)
    expect(table.findAll('tbody tr').map(row => row.findAll('td')[relayColumnIndex]?.text())).toEqual([
      sat01Label,
      sat01Label,
      sat01Label,
      '不经中继',
      satStLabel,
    ])
    const selectedSatellite = () => wrapper.get('[data-testid="scenario-selected-satellite"]')
    expect(wrapper.findAll('[data-testid="scenario-selected-satellite"]')).toHaveLength(1)
    expect(table.find('[data-testid="scenario-selected-satellite"]').exists()).toBe(false)
    expect(selectedSatellite().text()).toBe('选用卫星：天通卫星')
    const settings = readLinkSettings(current.config)
    settings.enabledSatellites = { TIANTONG: false, SHENTONG: true }
    wrapper.findComponent({ name: 'LinkSettingsPanel' }).vm.$emit('update:modelValue', settings)
    await nextTick()
    expect(labels()).toEqual(['启用', '启用', '停用', '启用', '启用'])
    expect(selectedSatellite().text()).toBe('选用卫星：神通卫星')
    expect(scenario.dirty).toBe(true)
    expect(scenario.draft!.config.links.map(link => link.enabled)).toEqual([true, true, false, true, true])
  })

  it('不展示旧业务入口，链路参数可新增、保存重载和删除且不改历史数据', { timeout: 30_000 }, async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    let persisted = draft()
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body))
        persisted = { ...persisted, config: body.config, uiExtensions: body.uiExtensions, revision: persisted.revision + 1 }
      }
      return response(structuredClone(persisted))
    }))
    const scenario = useScenarioStore()
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    const original = structuredClone(toRaw(scenario.draft!.config))
    await wrapper.get('#tab-links').trigger('click')
    expect(wrapper.findAll('.scenario-tabs > .el-tabs__header [role="tab"]')).toHaveLength(4)
    expect(wrapper.find('[data-testid="add-information-demand"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="information-demand-table"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('未关联的旧业务')
    await wrapper.get('[data-testid="add-link"]').trigger('click')
    await flushPromises()
    const dialog = wrapper.findComponent({ name: 'LinkEditorDialog' })
    expect(document.querySelector('[data-testid="link-legacy-demand"]')).toBeNull()
    expect(document.querySelector('[data-testid="business-dialog"]')).toBeNull()
    expect(dialog.props('demand')).toMatchObject({ direction: 'FORWARD', informationType: '态势信息', volumeMb: 0.000256 })
    expect(document.querySelector('[data-testid="demand-direction"]')).toBeNull()
    expect(document.querySelector('[data-testid="demand-source"]')).toBeNull()
    const direction = dialog.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'link-direction')!
    direction.vm.$emit('update:modelValue', 'REVERSE')
    await flushPromises()
    expect(dialog.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'demand-volume-unit')!.props('modelValue')).toBe('MB')
    expect(dialog.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'demand-volume')!.props('modelValue')).toBe(2)
    document.querySelector<HTMLElement>('[data-testid="cancel-link"]')!.click()
    await flushPromises()
    expect(scenario.draft!.config).toEqual(original)
    expect(scenario.dirty).toBe(false)

    await wrapper.get('[data-testid="add-link"]').trigger('click')
    await flushPromises()
    const selector = (id: string) => dialog.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === id)!
    const initialDemand = structuredClone(toRaw(dialog.props('demand')!))
    selector('demand-volume-unit').vm.$emit('update:modelValue', 'MB')
    await flushPromises()
    const volume = dialog.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'demand-volume')!
    volume.vm.$emit('update:modelValue', -1)
    document.querySelector<HTMLElement>('[data-testid="apply-link"]')!.click()
    await flushPromises()
    expect(document.querySelector('.el-message--warning')?.textContent).toContain('数据量不能小于')
    expect(dialog.props('error')).toBe('')
    expect(scenario.draft!.config).toEqual(original)
    volume.vm.$emit('update:modelValue', 3)
    selector('link-direction').vm.$emit('update:modelValue', 'REVERSE')
    // 新模板微波端口为“后方指挥节点 ↔ 任务/中继无人机”，目标选任务无人机 AIR-01。
    selector('link-target').vm.$emit('update:modelValue', 'AIR-01')
    await flushPromises()
    document.querySelector<HTMLElement>('[data-testid="apply-link"]')!.click()
    await flushPromises()
    const savedDemand = { ...initialDemand, linkId: 'L-CFG-001', direction: 'REVERSE', informationType: '侦察信息', frequencyHz: 30, minDataRateMbps: 2, volumeMb: 3, destinationPlatformIds: ['AIR-01'] }
    expect(scenario.draft!.config.informationDemand).toEqual([...original.informationDemand, savedDemand])
    expect(scenario.draft!.config.links.at(-1)).toMatchObject({ id: 'L-CFG-001', direction: 'REVERSE', targetPlatformId: 'AIR-01' })
    expect(wrapper.find('[data-testid="information-demand-table"]').exists()).toBe(false)
    expect(await scenario.saveScenario()).toBe(true)
    expect(await scenario.loadScenario()).toBe(true)
    expect(scenario.draft!.config.informationDemand).toEqual([...original.informationDemand, savedDemand])
    await flushPromises()
    await wrapper.get(`[data-testid="edit-link-${original.links.length}"]`).trigger('click')
    await flushPromises()
    expect(dialog.props('demand')).toEqual(savedDemand)
    dialog.vm.$emit('update:modelValue', false)
    await nextTick()
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    wrapper.findComponent({ name: 'ValidationPanel' }).vm.$emit('locate', {
      severity: 'ERROR', code: 'TEST', message: '请检查通信方向', fieldPath: `informationDemand[${original.informationDemand.length}].direction`,
    })
    await flushPromises()
    expect(dialog.props('modelValue')).toBe(true)
    expect(dialog.props('error')).toBe('请检查通信方向')
    dialog.vm.$emit('opened')
    await flushPromises()
    await vi.waitFor(() => expect(document.activeElement?.closest('[data-testid="link-direction"]')).not.toBeNull())
    const snapshot = structuredClone(toRaw(scenario.draft!.config))
    scenario.draft!.locked = true
    document.querySelector<HTMLElement>('[data-testid="apply-link"]')!.click()
    await flushPromises()
    expect(scenario.draft!.config).toEqual(snapshot)
    scenario.draft!.locked = false
    dialog.vm.$emit('update:modelValue', false)
    await nextTick()
    const deletion = wrapper.findAllComponents({ name: 'ElPopconfirm' }).find(item => item.find(`[data-testid="delete-link-${original.links.length}"]`).exists())!
    deletion.vm.$emit('confirm', new MouseEvent('click'))
    await nextTick()
    expect(scenario.draft!.config.informationDemand).toEqual(original.informationDemand)
    expect(scenario.draft!.config.links).toEqual(original.links)
  })
  it('缩短场景时长后旧触发时间仅提示不阻止保存，弹框不再提供触发时间', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    let persisted = draft()
    persisted.config.jammers.forEach(jammer => { jammer.triggerTimeS = 300 })
    // 本例仅验证触发时间；避免既有航点超过缩短后的总时长。
    persisted.config.platforms.forEach(platform => { platform.waypoints = [] })
    const fetchSpy = vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body))
        persisted = { ...persisted, config: body.config, uiExtensions: body.uiExtensions, revision: persisted.revision + 1 }
      }
      return response(structuredClone(persisted))
    })
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    const duration = wrapper.get('[data-testid="scenario-duration"] input')
    await duration.setValue(String(100 / 60))
    await duration.trigger('change')
    expect(scenario.draft!.config.scenario.duration).toBeCloseTo(100)
    await wrapper.get('#tab-jammers').trigger('click')
    await wrapper.get('[data-testid="edit-jammer-0"]').trigger('click')
    await flushPromises()
    // 触发时间不参与仿真，弹框已不再提供配置。
    expect(document.querySelector('[data-testid="jammer-trigger-time"]')).toBeNull()
    document.querySelector<HTMLElement>('[data-testid="cancel-jammer"]')!.click()
    await flushPromises()
    const inspected = inspectScenarioConfig(scenario.draft!.config, 'write').result
    expect(inspected.errors.some(issue => String(issue.fieldPath).endsWith('.triggerTimeS'))).toBe(false)
    expect(inspected.warnings).toContainEqual(expect.objectContaining({ code: 'JAMMER_TRIGGER_TIME_INVALID', fieldPath: 'jammers[1].triggerTimeS' }))
    expect(await scenario.saveScenario()).toBe(true)
    expect(fetchSpy.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1)
    expect(await scenario.loadScenario()).toBe(true)
    // 旧触发时间原样保留，不被界面改写。
    expect(scenario.draft!.config.jammers.map(jammer => jammer.triggerTimeS)).toEqual([300, 300])
  })

  it('仍保护存量配置引用，服务端解除引用后可删除最后一颗已选卫星并保存回读', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    let persisted = draft()
    const satellite = persisted.config.platforms.find(p => p.type === 'COMMUNICATION_SATELLITE')!
    satellite.satelliteType = 'TIANTONG'
    persisted.config.linkSettings = readLinkSettings(persisted.config)
    persisted.config.links = persisted.config.links.filter(link => ![link.sourcePlatformId, link.targetPlatformId, link.relayPlatformId].includes(satellite.id))
    persisted.config.platforms.forEach(platform => { platform.linkIds = persisted.config.links.filter(link => [link.sourcePlatformId, link.targetPlatformId].includes(platform.id)).map(link => link.id) })
    persisted.config.informationDemand[0]!.destinationPlatformIds.push(satellite.id)
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body))
        persisted = { ...persisted, config: body.config, uiExtensions: body.uiExtensions, revision: persisted.revision + 1 }
      }
      return response(structuredClone(persisted))
    }))
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus],
      stubs: { ElPopconfirm: { emits: ['confirm'], template: '<div @click="$emit(\'confirm\')"><slot name="reference" /></div>' } },
    } })
    await flushPromises()
    await wrapper.get('#tab-platforms').trigger('click')
    const index = scenario.draft!.config.platforms.findIndex(p => p.id === satellite.id)
    const original = structuredClone(toRaw(scenario.draft!.config))
    await wrapper.get(`[data-testid="delete-platform-${index}"]`).trigger('click')
    expect(scenario.draft!.config).toEqual(original)
    expect(document.body.textContent).toContain('仍被链路、设备或信息需求引用')
    persisted.config.informationDemand[0]!.destinationPlatformIds = persisted.config.informationDemand[0]!.destinationPlatformIds.filter(id => id !== satellite.id)
    expect(await scenario.loadScenario()).toBe(true)
    await flushPromises()
    await wrapper.get('#tab-platforms').trigger('click')
    await wrapper.get(`[data-testid="delete-platform-${index}"]`).trigger('click')
    expect(scenario.draft!.config.platforms.some(p => p.id === satellite.id)).toBe(false)
    expect(scenario.draft!.config.linkSettings!.enabledSatellites).toEqual({ TIANTONG: false, SHENTONG: false })
    expect(await scenario.saveScenario()).toBe(true)
    expect(await scenario.loadScenario()).toBe(true)
    await wrapper.get('#tab-links').trigger('click')
    expect(wrapper.get('[data-testid="scenario-selected-satellite"]').text()).toBe('选用卫星：未选择')
    await wrapper.get('[data-testid="open-link-settings"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'link-relay-satellite')!.props('modelValue')).toBeUndefined()
    expect(wrapper.get('[data-testid="link-table"]').text()).not.toMatch(/天通卫星|神通卫星/)
  })

  it('敌方干扰总开关与弹框默认值生效，旧超界距离可逐台修正', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    const current = draft()
    // 同类干扰节点的探测距离须一致（D6）；第二台所在节点改为机载，才能逐台修正旧超界距离。
    Object.assign(current.config.platforms.find(platform => platform.id === 'STN-02')!, { type: 'AIRBORNE_JAMMER_PLATFORM', category: 'air' })
    current.config.jammers.forEach(jammer => { jammer.detectionRange = 150000 })
    scenario.$patch({ draft: current, panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await wrapper.get('#tab-jammers').trigger('click')
    const totalSwitch = wrapper.findAllComponents({ name: 'ElSwitch' }).find(item => item.attributes('data-testid') === 'jamming-enabled')!
    expect(totalSwitch.props('modelValue')).toBe(false)
    const switches = scenario.draft!.uiExtensions.jammers.map(item => item.enabled)
    totalSwitch.vm.$emit('update:modelValue', true)
    await nextTick()
    expect(scenario.draft!.config.jammingEnabled).toBe(true)
    expect(scenario.draft!.uiExtensions.jammers.map(item => item.enabled)).toEqual(switches)
    await wrapper.get('[data-testid="add-jammer"]').trigger('click')
    const dialog = wrapper.findComponent({ name: 'JammerEditorDialog' })
    expect(dialog.props('jammer')).toMatchObject({ type: 'BARRAGE', defaultPower: 1, frequency: 2400, bandwidth: 200, detectionRange: 55560, jammingRange: 55560, releaseRange: 64820 })
    expect(dialog.props('jammer')).not.toHaveProperty('triggerTimeS')
    expect(dialog.props('jammerTypeOptions')).toContainEqual({ value: 'SWEEP', label: '扫频' })
    dialog.vm.$emit('update:modelValue', false)
    await nextTick()
    expect(scenario.draft!.config.jammers).toHaveLength(2)
    await wrapper.get('[data-testid="edit-jammer-0"]').trigger('click')
    const range = dialog.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'jammer-range')!
    expect(range.props('modelValue')).toBe(150)
    range.vm.$emit('update:modelValue', 101)
    await nextTick()
    document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
    await flushPromises()
    expect(document.querySelector('.el-message--warning')?.textContent).toContain('1～100 km')
    expect(dialog.props('error')).toBe('')
    expect(scenario.draft!.config.jammers[0]!.detectionRange).toBe(150000)
    range.vm.$emit('update:modelValue', 24)
    dialog.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'jammer-type')!.vm.$emit('update:modelValue', 'SWEEP')
    await nextTick()
    document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
    await flushPromises()
    expect(scenario.draft!.config.jammers[0]).toMatchObject({ type: 'SWEEP', detectionRange: 24000 })
    expect(scenario.draft!.config.jammers[1]!.detectionRange).toBe(150000)
    expect(inspectScenarioConfig(scenario.draft!.config, 'write').result.valid).toBe(false)
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    wrapper.findComponent({ name: 'ValidationPanel' }).vm.$emit('locate', { severity: 'ERROR', code: 'TEST', message: '请检查探测范围', fieldPath: 'jammers[0].detectionRange' })
    await flushPromises()
    dialog.vm.$emit('opened')
    await vi.waitFor(() => expect(document.activeElement?.closest('[data-testid="jammer-range"]')).not.toBeNull())
    scenario.draft!.locked = true
    totalSwitch.vm.$emit('update:modelValue', false)
    await nextTick()
    expect(scenario.draft!.config.jammingEnabled).toBe(true)
  })

  it('三个参数页签的新增按钮位于表格顶部标签栏内，新增数据后顺序不变', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(draft())))
    const scenario = useScenarioStore()
    expect(await scenario.loadScenario()).toBe(true)
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    const pairs = [
      ['platforms', 'add-platform', 'platform-table'],
      ['links', 'add-link', 'link-table'],
      ['jammers', 'add-jammer', 'jammer-table'],
    ] as const
    const checkPosition = async () => {
      for (const [tab, buttonId, tableId] of pairs) {
        await wrapper.get(`#tab-${tab}`).trigger('click')
        const buttons = wrapper.findAll(`[data-testid="${buttonId}"]`)
        expect(buttons).toHaveLength(1)
        const heading = buttons[0]!.element.closest('.platform-actions')?.parentElement
        expect(heading?.classList.contains('section-heading')).toBe(true)
        expect(heading?.querySelector('.el-tag')).not.toBeNull()
        expect(heading?.nextElementSibling)
          .toBe(wrapper.get(`[data-testid="${tableId}"]`).element)
      }
    }
    await checkPosition()
    // 传感器页已并入“干扰设备”，不再提供新增传感器入口。
    expect(wrapper.find('#tab-data').exists()).toBe(false)
    expect(wrapper.find('[data-testid="add-sensor"]').exists()).toBe(false)
    const previousCount = scenario.draft!.config.links.length
    scenario.draft!.config.links.push({ ...structuredClone(toRaw(scenario.draft!.config.links[0]!)), id: 'L-ORDER-NEW' })
    await nextTick()
    expect(scenario.draft!.config.links).toHaveLength(previousCount + 1)
    await checkPosition()
  })

  it('展示完整基础、时序和环境字段并保存中文草稿', async () => {
    const messageSpy = vi.spyOn(ElMessage, 'success')
    const warningSpy = vi.spyOn(ElMessage, 'warning')
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })

    const saved = draft(5)
    saved.config.scenario.name = '台海通联验证场景'
    mockGeneratedScript(scenario)
    const fetchSpy = vi.fn().mockResolvedValue(response(saved))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })

    expect(wrapper.get('.scenario-page').attributes('aria-label')).toBe('场景配置')
    expect(wrapper.text()).toContain('场景基础')
    expect(wrapper.find('[data-testid="scenario-duration"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="scenario-sea-state"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="scenario-editor"]').exists()).toBe(true)
    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      '场景基础', '节点配置', '链路配置', '干扰设备',
    ])
    expect(wrapper.find('.scenario-workflow-hint').exists()).toBe(false)
    expect(wrapper.get('.scenario-workflow-bar').text()).toContain('已就绪')
    expect(wrapper.get('.scenario-workflow-bar .scenario-required-hint').text()).toContain('* 为必填项')
    expect(wrapper.find('.scenario-workflow-bar [data-testid="save-scenario"]').exists()).toBe(true)

    await wrapper.get('[data-testid="scenario-name"]').setValue(saved.config.scenario.name)
    expect(scenario.dirty).toBe(true)
    expect(wrapper.get('[data-testid="save-scenario"]').text()).toBe('保存')
    expect(wrapper.find('[data-testid="validate-scenario"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workflow-validation"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="next-validation"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="next-script"]').exists()).toBe(false)
    expect(wrapper.get('.scenario-workflow-bar').text()).toContain('未保存')
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(scenario.draft?.revision).toBe(5)
    expect(messageSpy).toHaveBeenCalledExactlyOnceWith('场景已保存，TXT 已生成。')
    expect(ElMessageBox.alert).not.toHaveBeenCalled()
    expect(warningSpy).not.toHaveBeenCalled()
    expect(wrapper.find('.platform-feedback').exists()).toBe(false)
    expect(wrapper.text()).toContain('修订 5')
    expect(wrapper.text()).toContain('已就绪')
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT' })
    expect(wrapper.find('[data-testid="validation-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workflow-script"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="script-preview-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="preflight-script"]').exists()).toBe(false)
  })

  it('按文档展示五项环境配置，分钟换算后保存且不提交重复时长字段', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    const initial = draft()
    initial.config = withScenarioBasicDefaults(initial.config)
    initial.config.scenario.duration = SCENARIO_BASIC_DEFAULTS.duration
    scenario.$patch({ draft: initial, panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    const fields = wrapper.get('.form-grid--scenario')
    const labels = (root: ReturnType<typeof wrapper.get>) => root.findAll('.el-form-item__label').map((item) => item.text())
    expect(labels(fields)).toEqual([
      '场景编号', '场景名称', '开始时间', '时间步长（秒）',
      '仿真总时长（min）', '仿真倍速', '场景描述',
    ])
    expect(fields.text()).not.toMatch(/clock_rate|不写入脚本/)
    // 环境参数按《与前端字段确认说明》“环境参数（全局）”的五个小标题分组。
    const environment = wrapper.get('[data-testid="scenario-environment"]')
    expect(environment.get('.environment-section__title').text()).toBe('环境参数（全局）')
    expect(environment.findAll('.environment-group__title').map(item => item.text())).toEqual([
      '降雨参数', '云雾参数', '大气参数', '极化失配', '海况参数',
    ])
    // 固定雨衰兜底值经插件实测不生效，界面不展示（仍按默认值写入脚本）。
    expect(labels(environment.get('[data-testid="environment-rain"]'))).toEqual(['是否开启', '雨强档位', '降雨强度（mm/h）', '雨区顶部高度（m）'])
    expect(labels(environment.get('[data-testid="environment-cloud"]'))).toEqual(['是否开启', '云层底边高度（m）', '云层顶边高度（m）', '云中含水量（g/m³）'])
    expect(labels(environment.get('[data-testid="environment-atmosphere"]'))).toEqual(['衰减模型', '简化衰减率（dB/km）'])
    expect(labels(environment.get('[data-testid="environment-misc"]'))).toEqual(['极化失配损耗（dB）', '指向误差损耗（dB）'])
    expect(labels(environment.get('[data-testid="environment-sea"]'))).toEqual(['海况等级', '海面多径衰落', '损耗计算模式', '反射系数极化',
      '贴海飞行高度阈值（m）', '跨海距离阈值（km）', '海水温度（℃）', '海面高度标准差（m）'])
    // 旧场景缺省的 link_calc 环境参数按文档默认值补齐；ITU 模型下简化衰减率不可编辑。
    expect(environment.get('[data-testid="scenario-env-seaLowAltitudeThresholdM"] input').attributes('aria-valuenow')).toBe('100')
    expect(environment.get('[data-testid="scenario-env-seaWaterTempC"] input').attributes('aria-valuenow')).toBe('20')
    expect(environment.get('[data-testid="scenario-env-simplifiedAttenuationDbPerKm"] input').attributes('disabled')).toBeDefined()
    // 经验模型（coarse）下多径模型专属参数不参与插件计算：禁用并提示仅多径模型生效。
    expect(environment.get('[data-testid="scenario-env-seaWaterTempC"] input').attributes('disabled')).toBeDefined()
    expect(environment.get('[data-testid="scenario-env-seaSurfaceRoughnessM"] input').attributes('disabled')).toBeDefined()
    expect(environment.get('[data-testid="sea-polarization-hint"]').text()).toBe('仅多径模型（fine）生效')
    // 海面多径衰落启用时可框选海面区域；未框选时脚本不写坐标。
    expect(environment.get('[data-testid="sea-area-summary"]').text()).toBe('未框选海面区域')
    expect(environment.find('[data-testid="open-sea-area"]').exists()).toBe(true)
    // 旧场景缺省云层参数时按对接示例典型值补齐。
    expect(environment.get('[data-testid="scenario-cloud-min"] input').attributes('aria-valuenow')).toBe('500')
    expect(environment.get('[data-testid="scenario-cloud-max"] input').attributes('aria-valuenow')).toBe('2000')
    expect(environment.get('[data-testid="scenario-cloud-water"] input').attributes('aria-valuenow')).toBe('0.5')
    expect(wrapper.findAll('[data-testid="scenario-duration"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="scenario-sim-total-time"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="scenario-multipath"]')).toHaveLength(1)
    const duration = fields.get('[data-testid="scenario-duration"] input')
    expect((duration.element as HTMLInputElement).value).toBe('20')
    const simSpeed = fields.findAllComponents({ name: 'ElSelect' })
      .find((item: { attributes: (name: string) => string | undefined }) => item.attributes('data-testid') === 'scenario-sim-speed')!
    // 旧场景缺省倍速按文档默认值回显 x2；回显本身不写 simClockSpeed。
    expect(simSpeed.props('modelValue')).toBe('x2')
    delete scenario.draft!.config.scenario.environment.simClockSpeed
    await nextTick()
    expect(simSpeed.props('modelValue')).toBe('x2')
    expect(scenario.draft!.config.scenario.environment).not.toHaveProperty('simClockSpeed')
    // 全速=非实时 + clock_rate 32；x32=实时 + clock_rate 32；x8=实时 + clock_rate 8。
    simSpeed.vm.$emit('update:modelValue', 'full')
    await nextTick()
    expect(scenario.draft!.config.scenario.realtime).toBe(false)
    expect(scenario.draft!.config.scenario.environment.simClockSpeed).toBe(32)
    simSpeed.vm.$emit('update:modelValue', 'x32')
    await nextTick()
    expect(scenario.draft!.config.scenario).not.toHaveProperty('realtime')
    expect(scenario.draft!.config.scenario.environment.simClockSpeed).toBe(32)
    simSpeed.vm.$emit('update:modelValue', 'x8')
    await nextTick()
    expect(scenario.draft!.config.scenario).not.toHaveProperty('realtime')
    expect(scenario.draft!.config.scenario.environment.simClockSpeed).toBe(8)
    expect(scenario.dirty).toBe(true)
    expect(fields.find('[data-testid="scenario-trans-distance"]').exists()).toBe(false)
    expect(scenario.draft!.config.scenario.environment).not.toHaveProperty('transmissionDistance')
    const rainTier = environment.findAllComponents({ name: 'ElSelect' }).find((item: { attributes: (name: string) => string | undefined }) => item.attributes('data-testid') === 'scenario-rain-cloud-atten')!
    const multipath = environment.findAllComponents({ name: 'ElSwitch' }).find((item: { attributes: (name: string) => string | undefined }) => item.attributes('data-testid') === 'scenario-multipath')!
    expect(rainTier.props('modelValue')).toBe('lightRain')
    expect(multipath.props('modelValue')).toBe(true)

    await duration.setValue('20.5')
    await duration.trigger('change')
    rainTier.vm.$emit('update:modelValue', 'heavyRain')
    multipath.vm.$emit('update:modelValue', false)
    await nextTick()

    const saved = structuredClone(initial)
    saved.revision = 5
    saved.config.scenario.duration = 1230
    Object.assign(saved.config.scenario.environment, {
      // 选择雨强档位时同步降雨强度（大雨 50 mm/h）。
      simClockSpeed: 8, rainCloudAttenuation: 'heavyRain', rainRateMmPerHour: 50, multipathEnabled: false,
    })
    const fetchSpy = vi.fn().mockResolvedValue(response(saved))
    vi.stubGlobal('fetch', fetchSpy)
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    const submitted = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as { config: ScenarioConfig }
    expect(submitted.config.scenario).toEqual(saved.config.scenario)
    expect(submitted.config.scenario.environment).not.toHaveProperty('simTotalTime')
    expect((duration.element as HTMLInputElement).value).toBe('20.5')
    expect(scenario.dirty).toBe(false)

    await duration.setValue('')
    await duration.trigger('change')
    expect(inspectScenarioConfig(scenario.draft?.config).result.errors).toContainEqual(expect.objectContaining({
      fieldPath: 'scenario.duration',
    }))
  })

  it('已保存草稿点击保存只检查；失败展示结果，通过后自动生成且没有脚本入口，不重复写入', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    mockGeneratedScript(scenario)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const fetchSpy = vi.fn().mockRejectedValueOnce(new Error('校验服务不可用。'))
      .mockResolvedValue(validationResponse({ valid: true, errors: [], warnings: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })

    expect(wrapper.find('[data-testid="workflow-validation"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workflow-script"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="validation-panel"]').exists()).toBe(false)
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="validation-panel"]').text()).toContain('校验服务不可用。')
    expect(wrapper.find('[data-testid="workflow-script"]').exists()).toBe(false)
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls.every(([url, options]) => String(url).endsWith('/validate') && options.method === 'POST')).toBe(true)
    expect(scenario.draft?.revision).toBe(4)
    expect(wrapper.find('[data-testid="validation-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workflow-script"]').exists()).toBe(false)
    scenario.projectRuntimeLock(scenario.draft!.config.scenario.id, true)
    await nextTick()
    expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeDefined()
    scenario.projectRuntimeLock(scenario.draft!.config.scenario.id, false)
    await nextTick()
    expect(wrapper.find('[data-testid="script-preview-panel"]').exists()).toBe(false)
    await wrapper.get('#tab-scenario').trigger('click')
    await wrapper.get('[data-testid="scenario-name"]').setValue('校验后修改')
    expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="workflow-script"]').exists()).toBe(false)
  })

  it('编辑完整数据域，不再提供场景操作或独立脚本操作', { timeout: 15_000 }, async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    const script: ScriptContract = {
      scriptId: 'SCRIPT-P2-001', taskId: 'TASK-001', scenarioId: 'SCN-001', configVersion: 'SCN-001-v4',
      target: 'AFSIM 2.9.0' as const, checksum: 'FNV1A-MOCK-12345678', preview: 'preview', generatedTime: META.generatedAt,
    }
    scenario.$patch({
      // 与 store 加载一致：注入前按系统输出设置归一化（原先由传感器编辑间接触发）。
      draft: { ...draft(), config: withScenarioBasicDefaults(draft().config) }, panelState: 'SUCCESS', script, scriptState: 'SUCCESS',
      preflight: {
        valid: false,
        errors: [
          { severity: 'ERROR', code: 'SCRIPT_VERSION_INVALID', message: '版本错误。', fieldPath: 'preview[2:3]' },
          { severity: 'ERROR', code: 'CHECKSUM_INVALID', message: '校验和错误。', fieldPath: 'checksum' },
        ],
        warnings: [],
      },
    })
    const preflightSpy = vi.spyOn(scenario, 'preflightScript').mockResolvedValue(true)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await nextTick()
    // 传感器页已并入“干扰设备”，不再提供传感器编辑入口。
    expect(wrapper.find('#tab-data').exists()).toBe(false)
    expect(wrapper.find('[data-testid="sensor-table"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="add-sensor"]').exists()).toBe(false)

    expect(wrapper.find('[data-testid="output-directory"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="output-write-interval"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="output-link-quality"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('输出参数')
    expect(scenario.draft?.config.output).toEqual(withScenarioBasicDefaults(scenario.draft!.config).output)
    expect(wrapper.find('#pane-data').exists()).toBe(false)
    expect(wrapper.find('[data-testid="information-demand-table"]').exists()).toBe(false)
    await wrapper.get('#tab-links').trigger('click')
    await wrapper.get('[data-testid="edit-link-0"]').trigger('click')
    const editorDialog = wrapper.findComponent({ name: 'LinkEditorDialog' })
    editorDialog.vm.$emit('apply', editorDialog.props('link'), { ...structuredClone(toRaw(editorDialog.props('demand')!)), informationType: '目标指令' })
    await nextTick()
    await wrapper.get('[data-testid="add-link"]').trigger('click')
    await nextTick()
    const linkDialog = wrapper.findComponent({ name: 'LinkEditorDialog' })
    linkDialog.vm.$emit('apply', linkDialog.props('link'), linkDialog.props('demand'))
    await nextTick()
    const lastDelete = wrapper.findAllComponents({ name: 'ElPopconfirm' }).find(item => item.find(`[data-testid="delete-link-${scenario.draft!.config.links.length - 1}"]`).exists())!
    lastDelete.vm.$emit('confirm', new MouseEvent('click'))
    expect(scenario.dirty).toBe(true)

    expect(wrapper.find('[data-testid="workflow-script"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="script-preview-panel"]').exists()).toBe(false)

    expect(wrapper.find('[data-testid="open-scenario-operations"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scenario-json-preview"]').exists()).toBe(false)

    scenario.scriptResultCode = 'CONFIRMATION_REQUIRED'
    scenario.scriptResultMessage = '存在警告。'
    scenario.script = script
    scenario.scriptState = 'SUCCESS'
    scenario.preflight = {
      valid: false,
      errors: [
        { severity: 'ERROR', code: 'SCRIPT_VERSION_INVALID', message: '版本错误。', fieldPath: 'preview[2:3]' },
        { severity: 'ERROR', code: 'CHECKSUM_INVALID', message: '校验和错误。', fieldPath: 'checksum' },
      ],
      warnings: [],
    }
    await nextTick()
    expect(preflightSpy).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="script-preview-panel"]').exists()).toBe(false)
    expect(scenario.script?.generatedTime).toBe(META.generatedAt)
    expect(wrapper.find('[data-testid="preflight-issues"]').exists()).toBe(false)

    scenario.scriptResultCode = 'PREFLIGHT_SUCCESS'
    scenario.preflight = { valid: true, errors: [], warnings: [] }
    await nextTick()
    expect(wrapper.find('[data-testid="script-next-step"]').exists()).toBe(false)
    await wrapper.get('#tab-scenario').trigger('click')
    await wrapper.get('[data-testid="scenario-name"]').setValue('重新编辑场景')
    expect(wrapper.get('.scenario-workflow-bar').text()).toContain('未保存')
    expect(wrapper.find('[data-testid="script-preview"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workflow-script"]').exists()).toBe(false)
  })

  it.each([
    OPERATOR,
    ADMIN,
  ])('场景编辑页对 $role 不再提供场景模板按钮和冗余场景操作，管理员保留另存为模板', async (principal) => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal, role: principal.role, permissions: [...principal.permissions] })
    const scenario = useScenarioStore(pinia)
    scenario.$patch({
      draft: draft(),
      panelState: 'SUCCESS',
    })
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await nextTick()
    expect(wrapper.find('[data-testid="open-scenario-templates"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="template-library"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="save-as-template"]').exists()).toBe(principal.role === 'ADMIN')
    for (const id of ['open-scenario-operations', 'import-scenario-snapshot', 'open-local-scene-import', 'undo-scenario', 'reset-scenario', 'scenario-config-export', 'scenario-json-preview']) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false)
    }
  })

  it('另存为模板后进入系统管理场景模板维护仍会拉取完整模板列表', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    const scenario = useScenarioStore(pinia)
    const created = { ...template(), templateId: 'TPL-NEW-001', name: '新建另存模板' }
    const existing = { ...template(), templateId: 'TPL-EXISTING-002', name: '已有基线模板' }
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: created, meta: META }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: [existing, created], meta: { ...META, total: 2 } }) })
    vi.stubGlobal('fetch', fetchSpy)

    expect(await scenario.createTemplate('新建另存模板')).toBe(true)
    expect(scenario.templates).toHaveLength(1)
    expect(scenario.templatesLoaded).toBe(false)

    const router = createAppRouter(createMemoryHistory(), pinia)
    await router.push({ path: '/admin', query: { section: 'scenario-templates' } })
    const wrapper = mount(AdminPage, { global: { plugins: [pinia, router, ElementPlus] } })
    await flushPromises()
    expect(scenario.templatesLoaded).toBe(true)
    expect(scenario.templates).toHaveLength(2)
    expect(wrapper.get('[data-testid="template-library"]').text()).toContain('已有基线模板')
    expect(wrapper.get('[data-testid="template-library"]').text()).toContain('新建另存模板')
    wrapper.unmount()
  })

  it('在系统管理中完成场景模板维护，成功仅浮层提示，历史结果不重播', { timeout: 15_000 }, async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    const scenario = useScenarioStore(pinia)
    const source = { ...template(), referenceCount: 0 }
    const referenced = { ...template(), templateId: 'TPL-SCN-009', name: '引用中的模板' }
    const savedScene = draft(8)
    savedScene.config.scenario.name = '已保存的模板来源'
    scenario.$patch({
      draft: null,
      panelState: 'SUCCESS',
      templates: [source, referenced],
      templatesLoaded: true,
      templateState: 'SUCCESS',
      templateResultMessage: '场景模板“已有模板”版本 1 已新建。',
    })
    const messageSpy = vi.spyOn(ElMessage, 'success')
    const errorSpy = vi.spyOn(ElMessage, 'error')
    const promptSpy = vi.spyOn(ElMessageBox, 'prompt')
    const scenesSpy = vi.spyOn(scenario, 'loadScenes').mockImplementation(async () => {
      scenario.$patch({ scenes: [savedScene], listState: 'SUCCESS' })
      return true
    })
    const createSpy = vi.spyOn(scenario, 'createTemplate').mockResolvedValue(true)
    const importSpy = vi.spyOn(scenario, 'importTemplate').mockResolvedValue(true)
    const updateSpy = vi.spyOn(scenario, 'updateTemplate').mockResolvedValue(true)
    const exportSpy = vi.spyOn(scenario, 'exportTemplate').mockResolvedValue('{"name":"跨海通联演示官方基线"}')
    const deleteSpy = vi.spyOn(scenario, 'deleteTemplate').mockResolvedValue(true)
    const loadSpy = vi.spyOn(scenario, 'loadTemplate').mockResolvedValue(source)
    const router = createAppRouter(createMemoryHistory(), pinia)
    await router.push({ path: '/admin', query: { section: 'scenario-templates' } })
    const wrapper = mount(AdminPage, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router, ElementPlus],
        stubs: {
          ElPopconfirm: {
            emits: ['confirm'],
            template: '<div @click="$emit(\'confirm\')"><slot name="reference" /></div>',
          },
        },
      },
    })
    await flushPromises()
    const panel = wrapper.get('[data-testid="template-library"]')
    expect(wrapper.get('.admin-page').attributes('aria-label')).toBe('场景模板维护')
    expect(panel.text()).not.toContain('场景模板维护')
    expect(panel.text()).not.toContain('请在场景配置中打开场景后新建或更新模板。')
    expect(panel.get('[data-testid="delete-template-TPL-SCN-009"]').element).toHaveProperty('disabled', true)
    const table = () => panel.get('[data-testid="template-table"]')
    const search = panel.get('[data-testid="template-search"]')
    expect(table().findAll('th').map(header => header.text())).not.toContain('模板 ID')
    expect(table().findAll('th').map(header => header.text())).not.toContain('类型')
    await search.setValue('跨海通联')
    expect(table().text()).toContain(source.name)
    expect(table().text()).not.toContain(referenced.name)
    await search.setValue('tpl-scn-009')
    expect(table().text()).toContain(referenced.name)
    expect(table().text()).not.toContain(source.name)
    await search.setValue('没有此模板')
    expect(panel.text()).toContain('没有匹配的模板')
    await search.setValue('')
    expect(panel.text()).not.toContain('官方模板')
    expect(panel.find('[data-testid="template-feedback"]').exists()).toBe(false)
    expect(messageSpy).not.toHaveBeenCalled()
    expect(panel.text()).not.toContain('应用到当前场景')
    function sourceButton(): HTMLButtonElement {
      return document.querySelector<HTMLButtonElement>('[data-testid="save-template-source"]')!
    }

    async function chooseSavedScene(): Promise<void> {
      const select = wrapper.findAllComponents({ name: 'ElSelect' })
        .find(component => component.attributes('data-testid') === 'template-source-select')!
      const selected = `saved:${savedScene.config.scenario.id}`
      expect(select.findAllComponents({ name: 'ElOption' }).map(option => option.props('value'))).toContain(selected)
      select.vm.$emit('update:modelValue', selected)
      select.vm.$emit('change', selected)
      await nextTick()
    }

    const createButton = panel.get('[data-testid="create-template"]')
    expect(createButton.element).toHaveProperty('disabled', false)
    await createButton.trigger('click')
    await flushPromises()
    expect(scenesSpy).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="template-source-dialog"]')).not.toBeNull()
    expect(sourceButton().disabled).toBe(true)
    await chooseSavedScene()
    await new DOMWrapper(document.querySelector<HTMLInputElement>('input[data-testid="template-source-name"], [data-testid="template-source-name"] input')!).setValue('新建模板')
    await nextTick()
    expect(sourceButton().disabled).toBe(false)
    sourceButton().click()
    await flushPromises()
    const templateFile = wrapper.get<HTMLInputElement>('[data-testid="template-import-file"]')
    const chooseFile = vi.spyOn(templateFile.element, 'click').mockImplementation(() => {})
    await panel.get('[data-testid="import-template"]').trigger('click')
    expect(chooseFile).toHaveBeenCalledOnce()
    expect(templateFile.attributes('accept')).toBe('.json,application/json')

    async function selectFile(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
      const file = new File([bytes], name, { type: 'application/json' })
      Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
      Object.defineProperty(templateFile.element, 'files', { configurable: true, value: [file] })
      await templateFile.trigger('change')
      await flushPromises()
    }

    const importJson = JSON.stringify({ name: '导入模板', config: source.config })
    await selectFile('导入模板.json', new TextEncoder().encode(importJson))
    expect(messageSpy).toHaveBeenCalledWith('已导入模板文件“导入模板.json”。')
    await selectFile('编码错误.json', new Uint8Array([0xff]))
    expect(errorSpy).toHaveBeenCalledWith('“编码错误.json”不是有效的 UTF-8 文件。')
    expect(importSpy).toHaveBeenCalledExactlyOnceWith(importJson)

    await panel.get('[data-testid="load-template-TPL-SCN-001"]').trigger('click')
    await flushPromises()
    const detail = document.querySelector('[data-testid="template-detail"]')!
    expect(detail.textContent).toContain(source.templateId)
    expect(detail.textContent).toContain(source.config.scenario.name)
    const tabs = Array.from(detail.querySelectorAll<HTMLElement>('[role="tab"]'))
    expect(tabs.map(tab => tab.textContent)).toEqual(['概况', '节点', '链路', '设备'])
    tabs[1]!.click()
    await flushPromises()
    expect(detail.textContent).toContain(source.config.platforms[0]!.name)
    document.querySelector<HTMLElement>('[data-testid="close-template-detail"]')!.click()
    await flushPromises()
    const updateButton = panel.get('[data-testid="update-template-TPL-SCN-001"]')
    expect(updateButton.element).toHaveProperty('disabled', false)
    await updateButton.trigger('click')
    await flushPromises()
    expect(sourceButton().disabled).toBe(true)
    await chooseSavedScene()
    expect(sourceButton().disabled).toBe(false)
    sourceButton().click()
    await flushPromises()
    await panel.get('[data-testid="export-template-TPL-SCN-001"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="template-export-preview"]')?.textContent).toContain(source.name)
    document.querySelector<HTMLElement>('[data-testid="close-template-export"]')!.click()
    await flushPromises()
    await panel.get('[data-testid="delete-template-TPL-SCN-001"]').trigger('click')
    await flushPromises()

    expect(promptSpy).not.toHaveBeenCalled()
    expect(createSpy).toHaveBeenCalledWith('新建模板', savedScene.config, savedScene.uiExtensions)
    expect(loadSpy).toHaveBeenCalledWith('TPL-SCN-001')
    expect(updateSpy).toHaveBeenCalledWith('TPL-SCN-001', '跨海通联演示官方基线', savedScene)
    expect(scenario.draft).toBeNull()
    expect(exportSpy).toHaveBeenCalledWith('TPL-SCN-001')
    expect(deleteSpy).toHaveBeenCalledWith('TPL-SCN-001')
    expect(messageSpy).toHaveBeenCalledTimes(4)
    expect(messageSpy).toHaveBeenCalledWith(scenario.templateResultMessage)
    expect(panel.find('[data-testid="template-feedback"]').exists()).toBe(false)

    // 复制读取源模板完整配置另存为新模板，不使用当前草稿。
    promptSpy.mockResolvedValueOnce({ value: '模板副本' } as never)
    await panel.get('[data-testid="duplicate-template-TPL-SCN-001"]').trigger('click')
    await flushPromises()
    expect(createSpy).toHaveBeenLastCalledWith('模板副本', source.config, source.uiExtensions)
    expect(messageSpy).toHaveBeenCalledTimes(5)
  })

  it('首次进入时自动加载，并允许编辑全部 P2-1 参数', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    let resolveResponse!: (value: Response) => void
    const responsePromise = new Promise<Response>((resolve) => { resolveResponse = resolve })
    const fetchSpy = vi.fn().mockReturnValue(responsePromise)
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })

    await nextTick()
    expect(wrapper.text()).toContain('正在加载场景草稿')
    resolveResponse(response(draft()))
    await flushPromises()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="scenario-editor"]').exists()).toBe(true)

    await wrapper.get('[data-testid="scenario-description"]').setValue('更新后的场景描述')
    const startTimePicker = wrapper.getComponent({ name: 'ElDatePicker' })
    startTimePicker.vm.$emit('update:modelValue', '')
    await nextTick()
    startTimePicker.vm.$emit('update:modelValue', '2026-08-07T09:30')
    await nextTick()
    // 按字段定位既有 P2-1 参数，避免新增表单项改变输入框顺序或总数。
    const numericFields = [
      ['scenario-duration', '120.5'], ['scenario-time-step', '2'], ['scenario-sea-state', '4'],
      ['scenario-rain-rate', '10'],
    ]
    for (const [testId, value] of numericFields) {
      await wrapper.get(`[data-testid="${testId}"] input[type="number"]`).setValue(value)
    }
    expect(wrapper.find('[data-testid="scenario-temperature"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scenario-humidity"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scenario-rain-loss"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scenario-time-step"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="scenario-rain-rate"]').exists()).toBe(true)
    await wrapper.get('[data-testid="scenario-multipath"]').trigger('click')

    expect(scenario.draft?.config.scenario).toMatchObject({
      description: '更新后的场景描述',
      startTime: '2026-08-07T01:30:00Z',
      duration: 7230,
      timeStep: 2,
      environment: {
        seaState: 4,
        rainRateMmPerHour: 10,
        multipathEnabled: false,
      },
    })
    expect(scenario.dirty).toBe(true)
  })

  it('在非 UTC+8 时区以北京时间展示 UTC 并按北京时间写回', async () => {
    vi.stubEnv('TZ', 'America/New_York')
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York')
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    scenario.draft!.config.scenario.startTime = '2026-08-06t08:00:00z'
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    const startTime = () => wrapper.get('[data-testid="scenario-start-time"] input')

    expect(wrapper.text()).toContain('开始时间')
    expect((startTime().element as HTMLInputElement).value).toBe('2026-08-06 16:00')

    scenario.draft!.config.scenario.startTime = '0000-01-01T00:00:00Z'
    await nextTick()
    expect(wrapper.findComponent({ name: 'ElDatePicker' }).exists()).toBe(false)
    expect((startTime().element as HTMLInputElement).value).toBe('0000-01-01T08:00')
    await startTime().setValue('2026-01-01T08:00')
    await nextTick()
    expect(wrapper.findComponent({ name: 'ElDatePicker' }).exists()).toBe(true)
    expect((startTime().element as HTMLInputElement).value).toBe('2026-01-01 08:00')

    scenario.draft!.config.scenario.startTime = '9999-12-31T23:59:59Z'
    await nextTick()
    expect(wrapper.findComponent({ name: 'ElDatePicker' }).exists()).toBe(false)
    expect((startTime().element as HTMLInputElement).value).toBe('10000-01-01T07:59')

    await startTime().setValue('2026-08-07T09:30')
    expect(scenario.draft?.config.scenario.startTime).toBe('2026-08-07T01:30:00Z')
  })

  it('保留无效非空文本和不合法日历输入供字段校验', async () => {
    vi.stubEnv('TZ', 'Pacific/Honolulu')
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })

    scenario.draft!.config.scenario.startTime = 'not-a-date'
    await nextTick()
    const startTime = () => wrapper.get('[data-testid="scenario-start-time"] input')
    expect(wrapper.findComponent({ name: 'ElDatePicker' }).exists()).toBe(false)
    expect((startTime().element as HTMLInputElement).value).toBe('not-a-date')
    expect(scenario.draft?.config.scenario.startTime).toBe('not-a-date')

    await startTime().setValue('2026-02-30T09:30')
    await nextTick()
    expect(wrapper.findComponent({ name: 'ElDatePicker' }).exists()).toBe(false)
    expect((startTime().element as HTMLInputElement).value).toBe('2026-02-30T09:30')
    expect(scenario.draft?.config.scenario.startTime).toBe('2026-02-30T09:30')

    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('开始时间必须是有效时间。')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('将本地校验错误定位到对应字段', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS', dirty: true })
    scenario.draft!.config.scenario.name = ' '
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })

    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('场景名称为必填项，且不能超过 128 个字符。')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="validation-panel"]').exists()).toBe(true)
    await wrapper.get('[data-testid="locate-validation-issue-0"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="scenario-name"]').exists()).toBe(true)

    await wrapper.get('[data-testid="scenario-name"]').setValue('系统输出间隔验证')
    await wrapper.get('[data-testid="scenario-time-step"] input').setValue('6')
    expect(scenario.draft?.config.output.writeInterval).toBe(6)
    expect(inspectScenarioConfig(scenario.draft?.config, 'write').result.errors.some((issue) => issue.fieldPath === 'output.writeInterval')).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('汇总整体校验问题并定位到链路编辑字段', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS', dirty: true })
    scenario.draft!.config.links[0]!.txPower = -1
    const result = inspectScenarioConfig(scenario.draft!.config).result
    const fetchSpy = vi.fn().mockResolvedValue(validationResponse(result))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })

    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="validation-panel"]').text()).toContain('错误 1')
    expect(wrapper.get('[data-testid="validation-panel"]').text()).toContain('第 1 条链路')
    expect(wrapper.get('[data-testid="validation-panel"]').text()).toContain('发射功率')
    expect(wrapper.get('[data-testid="validation-panel"]').text()).not.toContain('links[0].txPower')
    expect(wrapper.get('[data-testid="validation-panel"]').text()).toContain('链路发射功率不能小于 0 W。')

    await wrapper.get('[data-testid="locate-validation-issue-0"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="link-dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('链路发射功率不能小于 0 W。')
    expect(document.querySelector('[data-testid="link-dialog"] .el-alert')?.textContent).toContain('链路发射功率不能小于 0 W。')
    wrapper.unmount()
  })

  it.each(['enabled', 'cooldown'])('链路校验问题定位到对应弹框（字段=%s）', async (field) => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS', dirty: true })
    scenario.draft!.config.linkSettings = readLinkSettings(scenario.draft!.config)
    if (field === 'enabled') scenario.draft!.config.links[0]!.enabled = '非法值' as never
    else scenario.draft!.config.linkSettings.switchCooldownS = -1
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(validationResponse(inspectScenarioConfig(scenario.draft!.config).result)))
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    const fieldLabel = field === 'enabled' ? '第 1 条链路' : '全局链路设置 · 切换冷却时间'
    expect(wrapper.get('[data-testid="validation-panel"]').text()).toContain(fieldLabel)
    const expectedWarning = { name: 'ElementPlusError', message: '[ElSwitch] model-value must be active-value or inactive-value' }
    const originalWarn = console.warn.bind(console)
    const warningSpy = field === 'enabled' ? vi.spyOn(console, 'warn').mockImplementation((...args) => {
      if (args.length === 1 && args[0]?.name === expectedWarning.name && args[0]?.message === expectedWarning.message) return
      originalWarn(...args)
    }) : undefined
    try {
      await wrapper.get('[data-testid="locate-validation-issue-0"]').trigger('click')
      await flushPromises()
      if (warningSpy) expect(warningSpy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(expectedWarning))
    } finally { warningSpy?.mockRestore() }
    const dialog = document.querySelector(`[data-testid="${field === 'enabled' ? 'link-dialog' : 'link-settings-dialog'}"]`)
    expect(dialog).not.toBeNull()
    const target = field === 'enabled' ? '[data-testid="link-enabled"] input'
      : '[data-testid="link-switch-cooldown"] input'
    expect(dialog!.querySelector(target)).not.toBeNull()
    expect(wrapper.get('#tab-links').attributes('aria-selected')).toBe('true')
    expect(wrapper.find('section[aria-label="链路配置"] > .section-heading [data-testid="open-link-settings"]').exists()).toBe(true)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('在没有本地问题时展示整体校验请求级失败', async () => {
    const cases = [
      {
        name: '网络拒绝',
        reply: () => Promise.reject(new Error('网络连接已中断。')),
        message: '网络连接已中断。',
      },
      {
        name: 'HTTP 500',
        reply: () => Promise.resolve({
          ok: false,
          status: 500,
          json: vi.fn().mockResolvedValue({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: '场景校验服务暂时不可用。' },
            meta: META,
          }),
        } as unknown as Response),
        message: '场景校验服务暂时不可用。',
      },
      {
        name: '成功信封合同错误',
        reply: () => Promise.resolve({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({
            ok: true,
            data: { valid: true, errors: [], warnings: [], extra: true },
            meta: META,
          }),
        } as unknown as Response),
        message: '场景数据格式不正确。',
      },
    ]

    for (const failure of cases) {
      const pinia = createPinia()
      setActivePinia(pinia)
      const auth = useAuthStore(pinia)
      auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
      const scenario = useScenarioStore(pinia)
      const currentDraft = draft()
      // 激光链路不写入新模板脚本会给出本地警告；本用例需要“没有本地问题”，去掉激光链路。
      currentDraft.config.links = currentDraft.config.links.filter(link => link.type !== 'LASER')
      // 基准场景启用了海面多径；框选海面区域，避免“未框选”提示成为本地问题。
      currentDraft.config.scenario.environment.seaPolygon = [{ longitude: 118, latitude: 24 }, { longitude: 119, latitude: 24 }, { longitude: 119, latitude: 25 }]
      currentDraft.config.platforms.forEach(platform => { platform.linkIds = platform.linkIds.filter(id => currentDraft.config.links.some(link => link.id === id)) })
      scenario.$patch({ draft: currentDraft, panelState: 'SUCCESS' })
      vi.stubGlobal('fetch', vi.fn().mockImplementation(failure.reply))
      const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })

      await wrapper.get('[data-testid="save-scenario"]').trigger('click')
      await flushPromises()

      const panel = wrapper.get('[data-testid="validation-panel"]')
      expect(scenario.validation, failure.name).toEqual({ valid: true, errors: [], warnings: [] })
      expect(panel.get('[data-testid="validation-request-error"]').text(), failure.name).toContain(failure.message)
      expect(panel.find('.el-empty').exists(), failure.name).toBe(false)
      wrapper.unmount()
    }
  })

  it('将平台、干扰、基础和高级链路问题分别定位到对应编辑区', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({
      draft: draft(),
      panelState: 'ERROR',
      resultCode: 'VALIDATION_FAILED',
      validation: {
        valid: false,
        errors: [
          { severity: 'ERROR', code: 'LONGITUDE_INVALID', message: '经度超出范围。', fieldPath: 'platforms[0].initialPosition.longitude' },
          { severity: 'ERROR', code: 'JAMMER_FREQUENCY_INVALID', message: '干扰频率不正确。', fieldPath: 'jammers[0].frequency' },
          { severity: 'ERROR', code: 'TIME_STEP_INVALID', message: '时间步长不正确。', fieldPath: 'scenario.timeStep' },
          { severity: 'ERROR', code: 'LINK_CALC_INVALID', message: '链路计算更新周期不正确。', fieldPath: 'linkSettings.linkCalc.updateIntervalS' },
        ],
        warnings: [],
      },
    })
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    vi.spyOn(scenario, 'saveScenario').mockResolvedValue(false)
    const openValidationTab = async (): Promise<void> => {
      await wrapper.get('[data-testid="save-scenario"]').trigger('click')
      await flushPromises()
    }

    await openValidationTab()
    await wrapper.get('[data-testid="locate-validation-issue-0"]').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('经度超出范围。')
    document.querySelector<HTMLElement>('[data-testid="cancel-platform"]')!.click()

    await openValidationTab()
    await wrapper.get('[data-testid="locate-validation-issue-1"]').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('干扰频率不正确。')
    document.querySelector<HTMLElement>('[data-testid="cancel-jammer"]')!.click()

    await openValidationTab()
    await wrapper.get('[data-testid="locate-validation-issue-2"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-testid="scenario-time-step"] input')))

    await openValidationTab()
    await wrapper.get('[data-testid="locate-validation-issue-3"]').trigger('click')
    await vi.waitFor(() => {
      const input = document.querySelector('[data-testid="link-calc-updateIntervalS"] input')
      expect(input).not.toBeNull()
      expect(document.activeElement).toBe(input)
      expect(input!.closest('details')).toBeNull()
    })
    expect(document.querySelector('[data-testid="hot-link-end-type"]')).toBeNull()
    wrapper.unmount()
  })

  it('新增中继使用模板起飞点，初始位置可编辑且确认前不污染草稿', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const original = structuredClone(toRaw(scenario.draft!))
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await wrapper.get('#tab-platforms').trigger('click')
    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await flushPromises()
    const dialog = wrapper.findComponent({ name: 'PlatformEditorDialog' })
    const type = dialog.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'platform-type')!
    type.vm.$emit('update:modelValue', 'FORWARD_RELAY_NODE')
    type.vm.$emit('change', 'FORWARD_RELAY_NODE')
    await flushPromises()
    for (const [field, expected] of [['longitude', 119.55], ['latitude', 24.66], ['altitude', 3200]] as const) {
      const input = document.querySelector<HTMLInputElement>(`[data-testid="platform-${field}"] input`)
      expect(input).not.toBeNull()
      expect(input!.value).toBe(String(expected))
      expect(input!.disabled).toBe(false)
    }
    expect(scenario.draft).toEqual(original)
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(scenario.draft!.config.platforms.at(-1)).toMatchObject({ type: 'FORWARD_RELAY_NODE',
      initialPosition: { longitude: 119.55, latitude: 24.66, altitude: 3200 },
      waypoints: RELAY_DEFAULT_ROUTE.waypoints, loiterWaypoints: RELAY_DEFAULT_ROUTE.loiterWaypoints })
    expect(scenario.draft!.config.platforms.at(-1)!.returnPlan).toBeUndefined()
    expect(scenario.dirty).toBe(true)
    wrapper.unmount()
  })

  it('使用平台对话框新增业务信息节点和航点且确认前不污染草稿', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const originalCount = scenario.draft!.config.platforms.length
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })

    expect(wrapper.text()).toContain(`信息节点 6 / ${INFORMATION_NODE_LIMIT}`)
    expect(wrapper.text()).toContain('信息节点类型 4 / 4')
    expect(wrapper.text()).toContain('支撑实体 3')
    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await nextTick()
    // 弹框标题与“新增节点”入口一致，界面不再使用“场景实体”这一旧称。
    expect(document.querySelector('[data-testid="platform-dialog"] .el-dialog__title')?.textContent).toBe('新增节点')
    expect(document.querySelector('[data-testid="platform-dialog"]')?.textContent).not.toContain('场景实体')
    expect(scenario.draft?.config.platforms).toHaveLength(originalCount)
    const nameInput = document.querySelector<HTMLInputElement>('[data-testid="platform-name"]')!
    nameInput.value = '新增空中无人作业集群'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLElement>('[data-testid="add-waypoint"]')!.click()
    await flushPromises()
    wrapper.getComponent({ name: 'WaypointMapPicker' }).vm.$emit('confirm-route', [{ longitude: 117, latitude: 21, altitude: 0, speed: 1 }])
    await flushPromises()
    expect(document.querySelector('[data-testid="waypoint-table"]')?.textContent).toContain('经度')
    // 新增航点默认速度为 1 m/s；输入框最小值为 1，清空速度（必填）后确认应被拦下。
    wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'waypoint-speed-0')!.vm.$emit('update:modelValue', undefined)
    await flushPromises()
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="apply-platform"]')!.disabled).toBe(false)
    expect(scenario.draft?.config.platforms).toHaveLength(originalCount)
    wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'waypoint-speed-0')!.vm.$emit('update:modelValue', 20)
    await flushPromises()
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await nextTick()

    expect(document.body.textContent).toContain('节点已新增，保存草稿后生效。')
    expect(wrapper.find('[aria-label="节点配置"] .platform-feedback').exists()).toBe(false)
    expect(scenario.draft?.config.platforms).toHaveLength(originalCount + 1)
    expect(scenario.draft?.config.platforms.at(-1)).toMatchObject({
      name: '新增空中无人作业集群',
      type: 'AIRBORNE_MISSION_CLUSTER',
      waypoints: [{ longitude: 117, latitude: 21, altitude: 0, speed: 20 }],
    })
    expect(scenario.dirty).toBe(true)
    wrapper.unmount()
  })

  it('新增按钮直接批量选点，取消不产生航点，确认按序追加且逐行微调保留其他参数', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    const points = [
      { longitude: 120.5, latitude: 24.4, altitude: 1500, speed: 20 },
      { longitude: 120.7, latitude: 24.6, altitude: 1500, speed: 20 },
    ]
    const openMap = async (id: string) => {
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click()
      await nextTick()
      const picker = wrapper.getComponent({ name: 'WaypointMapPicker' })
      expect(picker.props('modelValue')).toBe(true)
      return picker
    }

    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await flushPromises()
    const picker = await openMap('add-waypoint')
    expect(picker.props('existingNodes')).toEqual(scenario.draft!.config.platforms)
    picker.vm.$emit('update:modelValue', false)
    await flushPromises()
    expect(document.querySelector('[data-testid="waypoint-altitude-0"]')).toBeNull()
    await openMap('add-waypoint')
    picker.vm.$emit('confirm-route', points)
    await flushPromises()
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()

    expect(scenario.draft?.config.platforms.at(-1)?.waypoints).toEqual(points.map((point, arrivalTime) => ({ ...point, arrivalTime })))

    await wrapper.get('#tab-platforms').trigger('click')
    await nextTick()
    await wrapper.get('[data-testid="edit-platform-3"]').trigger('click')
    await flushPromises()
    const original = scenario.draft!.config.platforms[3]!.waypoints.map(point => ({ ...point }))
    const editPicker = await openMap('add-waypoint')
    expect(editPicker.props('route')).toMatchObject({ points: original, loiter: false })
    expect(editPicker.props('existingNodes')).toEqual(scenario.draft!.config.platforms.filter((_, index) => index !== 3))
    editPicker.vm.$emit('confirm-route', [points[0]])
    await flushPromises()
    await openMap('pick-waypoint-0')
    const adjustment = { longitude: 120.654321, latitude: 24.456789 }
    editPicker.vm.$emit('confirm', adjustment)
    await flushPromises()
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()

    expect(scenario.draft?.config.platforms[3]?.waypoints).toEqual([
      { ...original[0], ...adjustment }, ...original.slice(1),
      { ...points[0], arrivalTime: original.at(-1)!.arrivalTime + 1 },
    ])
    wrapper.unmount()
  })

  it('新增节点弹框不在节点类型下显示整场景业务类型覆盖警告', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    const current = draft()
    // 缺少一类业务信息节点时，整场景校验会给出 WARNING；它不应落到节点类型字段。
    current.config.platforms = current.config.platforms.filter(platform => platform.type !== 'FORWARD_RELAY_NODE')
    scenario.$patch({ draft: current, panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await flushPromises()
    const form = document.querySelector('.platform-editor-form')
    expect(form).not.toBeNull()
    expect(form!.textContent).not.toContain('未覆盖全部四类业务信息节点')
    expect(document.querySelector('[data-testid="platform-type"]')!.closest('.el-form-item')!.textContent)
      .not.toContain('未覆盖全部四类业务信息节点')
    wrapper.unmount()
  })

  it('删除未被引用的支撑实体并拒绝第 51 个业务信息节点', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    const currentDraft = draft()
    currentDraft.config.platforms.push({
      id: 'SUP-UNUSED',
      name: '未引用支撑实体',
      type: 'COMMUNICATION_SATELLITE',
      category: 'space',
      initialPosition: { longitude: 0, latitude: 0, altitude: 550000 },
      waypoints: [],
      linkIds: [],
      sensorIds: [],
      jammerIds: [],
    })
    scenario.$patch({ draft: currentDraft, panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, {
      global: {
        plugins: [pinia, ElementPlus],
        stubs: { ElPopconfirm: { emits: ['confirm'], template: '<div @click="$emit(\'confirm\')"><slot name="reference" /></div>' } },
      },
    })

    await wrapper.get('#tab-platforms').trigger('click')
    await nextTick()
    await wrapper.get(`[data-testid="delete-platform-${currentDraft.config.platforms.length - 1}"]`).trigger('click')
    await nextTick()
    expect(scenario.draft?.config.platforms.some((platform) => platform.id === 'SUP-UNUSED')).toBe(false)

    const source = structuredClone(fixtureSource.scenario.platforms[3]!) as ScenarioConfig['platforms'][number]
    scenario.draft!.config.platforms = Array.from({ length: 50 }, (_, index) => ({
      ...structuredClone(source),
      id: `LIMIT-${String(index + 1).padStart(3, '0')}`,
      name: `容量测试节点 ${index + 1}`,
      linkIds: [],
      sensorIds: [],
      jammerIds: [],
    }))
    await nextTick()
    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="platform-dialog"]')).not.toBeNull()
    document.querySelector<HTMLElement>('[data-testid="cancel-platform"]')!.click()

    scenario.draft!.config.platforms = Array.from({ length: INFORMATION_NODE_LIMIT }, (_, index) => ({
      ...structuredClone(source),
      id: `LIMIT-${String(index + 1).padStart(3, '0')}`,
      name: `容量测试节点 ${index + 1}`,
      linkIds: [],
      sensorIds: [],
      jammerIds: [],
    }))
    await nextTick()
    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await flushPromises()

    expect(scenario.draft?.config.platforms).toHaveLength(INFORMATION_NODE_LIMIT)
    expect(document.body.textContent).toContain(`信息节点已达 ${INFORMATION_NODE_LIMIT} 个上限，当前可新增支撑实体。`)
  })

  it.each([1, 2])('地图选择编队原点后按 %s km 平铺新增，并保存重载保持坐标', async spacingKm => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    let persisted = draft()
    const originalCount = persisted.config.platforms.length
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body))
        persisted = { ...persisted, config: body.config, uiExtensions: body.uiExtensions, revision: persisted.revision + 1 }
      }
      return response(structuredClone(persisted))
    }))
    expect(await scenario.loadScenario()).toBe(true)
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await flushPromises()
    const dialog = wrapper.findComponent({ name: 'PlatformEditorDialog' })
    const input = (id: string) => dialog.findAllComponents({ name: 'ElInputNumber' }).find(component => component.attributes('data-testid') === id)!
    expect(input('platform-spacing')).toBeUndefined()
    input('platform-quantity').vm.$emit('update:modelValue', 4)
    input('platform-altitude').vm.$emit('update:modelValue', 1500)
    document.querySelector<HTMLElement>('[data-testid="pick-initial-position"]')!.click()
    await nextTick()
    const originPicker = wrapper.getComponent({ name: 'WaypointMapPicker' })
    expect(originPicker.props()).toMatchObject({ modelValue: true, title: '地图选取编队原点', fitExistingNodes: true })
    originPicker.vm.$emit('confirm', { longitude: 119.5, latitude: 25 })
    await nextTick()
    expect(input('platform-spacing').props('modelValue')).toBe(1)
    input('platform-spacing').vm.$emit('update:modelValue', 0)
    await nextTick()
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="apply-platform"]')!.disabled).toBe(false)
    expect(scenario.draft!.config.platforms).toHaveLength(originalCount)
    input('platform-spacing').vm.$emit('update:modelValue', spacingKm)
    input('platform-spacing').vm.$emit('update:modelValue', 50000)
    await nextTick()
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('平铺范围超出经纬度边界')
    expect(scenario.draft!.config.platforms).toHaveLength(originalCount)
    input('platform-spacing').vm.$emit('update:modelValue', spacingKm)
    const before = JSON.stringify(scenario.draft)
    for (const [longitude, latitude] of [[117, 25], [122, 25], [119.5, 21], [119.5, 26]]) {
      input('platform-longitude').vm.$emit('update:modelValue', longitude)
      input('platform-latitude').vm.$emit('update:modelValue', latitude)
      await nextTick()
      document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
      await flushPromises()
      expect(document.body.textContent).toContain('无人机集群编队原点')
      expect(JSON.stringify(scenario.draft)).toBe(before)
      expect(scenario.dirty).toBe(false)
    }
    input('platform-longitude').vm.$emit('update:modelValue', 119.5)
    input('platform-latitude').vm.$emit('update:modelValue', 25)
    await nextTick()
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    const positions = scenario.draft!.config.platforms.slice(originalCount).map(p => ({ ...p.initialPosition }))
    expect(positions).toHaveLength(4)
    expect(new Set(positions.map(p => p.longitude)).size).toBe(2)
    expect(new Set(positions.map(p => p.latitude)).size).toBe(2)
    expect(positions.every(p => p.altitude === 1500)).toBe(true)
    expect((positions[0]!.longitude + positions[1]!.longitude) / 2).toBeCloseTo(119.5, 10)
    expect((positions[0]!.latitude + positions[2]!.latitude) / 2).toBeCloseTo(25, 10)
    expect((positions[0]!.latitude - positions[2]!.latitude) * Math.PI / 180 * 6371).toBeCloseTo(spacingKm, 8)
    expect(scenario.dirty).toBe(true)
    expect(await scenario.saveScenario()).toBe(true)
    expect(await scenario.loadScenario()).toBe(true)
    expect(scenario.draft!.config.platforms.slice(originalCount).map(p => p.initialPosition)).toEqual(positions)
  })

  it('批量新增复制盘旋航点和返航路线，逐个调整后保存重载', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    let persisted = draft()
    const originalCount = persisted.config.platforms.length
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body))
        persisted = { ...persisted, config: body.config, uiExtensions: body.uiExtensions, revision: persisted.revision + 1 }
      }
      return response(structuredClone(persisted))
    }))
    expect(await scenario.loadScenario()).toBe(true)
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    const click = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click()
    const setNumber = (id: string, value: number) => wrapper.getComponent({ name: 'PlatformEditorDialog' })
      .findAllComponents({ name: 'ElInputNumber' }).find(component => component.attributes('data-testid') === id)!
      .vm.$emit('update:modelValue', value)
    await wrapper.get('#tab-platforms').trigger('click')
    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await flushPromises()
    setNumber('platform-quantity', 2)
    setNumber('platform-longitude', 119.5)
    setNumber('platform-latitude', 25)
    await nextTick()

    click('loiter-enabled')
    await flushPromises()
    setNumber('loiter-longitude-0', 119.5)
    setNumber('loiter-latitude-0', 25)
    setNumber('loiter-speed-0', 30)
    await flushPromises()
    const loiterEntryField = () => wrapper.findAllComponents({ name: 'ElFormItem' })
      .find(component => component.find('[data-testid="loiter-longitude-0"]').exists())!
    expect(loiterEntryField().props('error')).toBe('')
    setNumber('platform-quantity', 1)
    await nextTick()
    expect(loiterEntryField().props('error')).toContain('盘旋首点与初始位置重合')
    setNumber('platform-quantity', 2)
    await nextTick()
    expect(loiterEntryField().props('error')).toBe('')
    click('return-enabled')
    await nextTick()
    setNumber('return-time', 600)
    click('add-return-waypoint')
    await nextTick()
    click('apply-platform')
    await flushPromises()

    const newPlatforms = () => scenario.draft!.config.platforms.slice(originalCount)
    const returnPlan = { timeS: 600, waypoints: [{ longitude: 119.5, latitude: 25, altitude: 3000, speed: 200 }] }
    expect(newPlatforms()).toHaveLength(2)
    expect(newPlatforms()[0]!.loiterWaypoints).toHaveLength(8)
    expect(newPlatforms()[1]!.loiterWaypoints).toEqual(newPlatforms()[0]!.loiterWaypoints)
    expect(newPlatforms().map(platform => platform.returnPlan)).toEqual([returnPlan, returnPlan])

    await wrapper.get(`[data-testid="edit-platform-${originalCount}"]`).trigger('click')
    await flushPromises()
    setNumber('loiter-speed-0', 40)
    setNumber('return-time', 800)
    await nextTick()
    click('apply-platform')
    await flushPromises()
    expect(await scenario.saveScenario()).toBe(true)
    expect(await scenario.loadScenario()).toBe(true)
    expect(newPlatforms().map(platform => platform.loiterWaypoints?.[0]?.speed)).toEqual([40, 30])
    expect(newPlatforms().map(platform => platform.returnPlan?.timeS)).toEqual([800, 600])
  })

  it('按剩余数量批量新增空中无人作业集群并阻止类型超额', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })

    await wrapper.get('#tab-platforms').trigger('click')
    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await flushPromises()
    const quantity = wrapper.findAllComponents({ name: 'ElInputNumber' })
      .find((component) => component.attributes('data-testid') === 'platform-quantity')!
    expect(quantity.props('max')).toBe(58)
    quantity.vm.$emit('update:modelValue', 58)
    for (const [id, value] of [['platform-longitude', 119.5], ['platform-latitude', 25]] as const) {
      wrapper.findAllComponents({ name: 'ElInputNumber' }).find(component => component.attributes('data-testid') === id)!.vm.$emit('update:modelValue', value)
    }
    await nextTick()
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()

    const businessNodes = scenario.draft!.config.platforms.filter((platform) => isBusinessInformationNodeType(platform.type))
    expect(businessNodes).toHaveLength(INFORMATION_NODE_LIMIT)
    expect(businessNodes.filter((platform) => platform.type === 'AIRBORNE_MISSION_CLUSTER')).toHaveLength(61)
    expect(new Set(scenario.draft!.config.platforms.map((platform) => platform.id)).size).toBe(scenario.draft!.config.platforms.length)
    expect(wrapper.text()).toContain(`信息节点 ${INFORMATION_NODE_LIMIT} / ${INFORMATION_NODE_LIMIT}`)

    await wrapper.get('[data-testid="edit-platform-3"]').trigger('click')
    await flushPromises()
    const typeSelect = wrapper.findAllComponents({ name: 'ElSelect' })
      .find((component) => component.attributes('data-testid') === 'platform-type')!
    typeSelect.vm.$emit('update:modelValue', 'REAR_COMMAND_NODE')
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('后方指挥节点当前场景不能超过 1 个')
    wrapper.unmount()
  })

  it('旧场景可读取零功率与零侦测距离，新写入拒绝零功率，旧传感器距离仅提示', () => {
    const legacy = draft()
    legacy.config.jammers[0]!.defaultPower = 0
    legacy.config.sensors[0]!.detectionRange = 0
    expect(inspectScenarioConfig(legacy.config, 'read').result.valid).toBe(true)
    const { errors, warnings } = inspectScenarioConfig(legacy.config, 'write').result
    expect(errors).toContainEqual(expect.objectContaining({ fieldPath: 'jammers[0].defaultPower' }))
    // config.sensors 仅为兼容旧场景保留，不参与仿真：数值异常只提示，不阻止保存。
    expect(errors).not.toContainEqual(expect.objectContaining({ fieldPath: 'sensors[0].detectionRange' }))
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'SENSOR_RANGE_INVALID', fieldPath: 'sensors[0].detectionRange' }))
  })

  it('兼容读取旧卫星但编辑时必须主动选择子类型才能确认', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const legacy = draft()
    const index = legacy.config.platforms.findIndex(({ type }) => type === 'COMMUNICATION_SATELLITE')
    delete legacy.config.platforms[index]!.satelliteType
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(legacy)))
    const scenario = useScenarioStore()
    await expect(scenario.loadScenario()).resolves.toBe(true)
    expect(inspectScenarioConfig(legacy.config).result.valid).toBe(true)
    expect(inspectScenarioConfig(legacy.config, 'write').result.errors).toContainEqual(expect.objectContaining({ fieldPath: `platforms[${index}].satelliteType` }))
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await wrapper.get('#tab-scenario').trigger('click')
    await wrapper.get('#tab-platforms').trigger('click')
    await wrapper.get(`[data-testid="edit-platform-${index}"]`).trigger('click')
    await flushPromises()
    const satellite = wrapper.findAllComponents({ name: 'ElSelect' }).find((component) => component.attributes('data-testid') === 'platform-satellite-type')!
    expect(satellite.props('modelValue')).toBeUndefined()
    expect(scenario.draft!.config.platforms[index]!.satelliteType).toBeUndefined()
    expect(document.body.textContent).not.toContain('请选择天通卫星或神通卫星。')
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    await vi.waitFor(() => expect(document.body.textContent).toContain('请选择天通卫星或神通卫星。'))
    expect(scenario.draft!.config.platforms[index]!.satelliteType).toBeUndefined()
    satellite.vm.$emit('update:modelValue', 'SHENTONG')
    await nextTick()
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(scenario.draft!.config.platforms[index]).toMatchObject({ satelliteType: 'SHENTONG', category: 'space' })
  })

  it('在支撑实体弹框选择天通或神通卫星并阻止同类重复', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })

    await wrapper.get('#tab-platforms').trigger('click')
    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await flushPromises()
    const typeSelect = wrapper.findAllComponents({ name: 'ElSelect' })
      .find((component) => component.attributes('data-testid') === 'platform-type')!
    typeSelect.vm.$emit('update:modelValue', 'COMMUNICATION_SATELLITE')
    typeSelect.vm.$emit('change', 'COMMUNICATION_SATELLITE')
    await flushPromises()
    const satelliteSelect = wrapper.findAllComponents({ name: 'ElSelect' })
      .find((component) => component.attributes('data-testid') === 'platform-satellite-type')!
    satelliteSelect.vm.$emit('update:modelValue', 'SHENTONG')
    satelliteSelect.vm.$emit('change', 'SHENTONG')
    await flushPromises()
    expect(satelliteSelect.props('modelValue')).toBe('SHENTONG')
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.platforms.at(-1)).toMatchObject({
      type: 'COMMUNICATION_SATELLITE',
      satelliteType: 'SHENTONG',
    })
    expect(wrapper.text()).toContain('神通卫星')

    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await flushPromises()
    const typeSelect2 = wrapper.findAllComponents({ name: 'ElSelect' })
      .find((component) => component.attributes('data-testid') === 'platform-type')!
    typeSelect2.vm.$emit('update:modelValue', 'COMMUNICATION_SATELLITE')
    typeSelect2.vm.$emit('change', 'COMMUNICATION_SATELLITE')
    await flushPromises()
    const satelliteSelect2 = wrapper.findAllComponents({ name: 'ElSelect' })
      .find((component) => component.attributes('data-testid') === 'platform-satellite-type')!
    satelliteSelect2.vm.$emit('update:modelValue', 'SHENTONG')
    satelliteSelect2.vm.$emit('change', 'SHENTONG')
    await flushPromises()
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('天通卫星和神通卫星各只能配置一颗。')
    wrapper.unmount()
  })

  it('编辑平台、删除航点并覆盖全部对话框字段绑定', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await wrapper.get('[data-testid="show-scenario-ids"] input').setValue(true)

    await wrapper.get('#tab-platforms').trigger('click')
    await nextTick()
    await wrapper.get('[data-testid="edit-platform-3"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="platform-link-ids"]')).toBeNull()
    expect(document.querySelector('[data-testid="platform-jammer-ids"]')).toBeNull()
    document.querySelector<HTMLElement>('[data-testid="delete-waypoint-0"]')!.click()
    const editName = document.querySelector<HTMLInputElement>('[data-testid="platform-name"]')!
    editName.value = '空中无人作业集群（编辑）'
    editName.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.platforms[3]).toMatchObject({ name: '空中无人作业集群（编辑）', waypoints: [] })

    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await flushPromises()
    const typeSelect = wrapper.findAllComponents({ name: 'ElSelect' })
      .find((component) => component.attributes('data-testid') === 'platform-type')!
    typeSelect.vm.$emit('update:modelValue', 'GROUND_JAMMER_DETECTION_STATION')
    typeSelect.vm.$emit('change', 'GROUND_JAMMER_DETECTION_STATION')
    await nextTick()
    const categoryInput = document.querySelector<HTMLInputElement>('[data-testid="platform-category"]')!
    expect(categoryInput.value).toBe('地面')
    expect(categoryInput.readOnly).toBe(true)
    const dialogNumbers = wrapper.findAllComponents({ name: 'ElInputNumber' }).slice(-3)
    dialogNumbers[0]!.vm.$emit('update:modelValue', 119)
    dialogNumbers[1]!.vm.$emit('update:modelValue', 24)
    dialogNumbers[2]!.vm.$emit('update:modelValue', 15)
    const idInput = document.querySelector<HTMLInputElement>('[data-testid="platform-id"]')!
    idInput.value = 'SUP-TEST'
    idInput.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLElement>('[data-testid="cancel-platform"]')!.click()
    await flushPromises()

    expect(scenario.draft?.config.platforms.some((platform) => platform.id === 'SUP-TEST')).toBe(false)
    wrapper.unmount()
  })

  it('链路编辑弹窗不再展示已移除的链路级信道编码输入', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    const persisted = draft()
    const fetchSpy = vi.fn(async () => response(structuredClone(persisted)))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    await wrapper.get('#tab-links').trigger('click')
    await wrapper.get('[data-testid="edit-link-0"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="link-coding"]')).toBeNull()
    expect(scenario.draft?.config.links[0]).not.toHaveProperty('coding')
  })

  it.each(['EQUIPMENT', 'MASTER_DATA'] as const)('引用 %s 的链路取消引用并保存前不得删除', async kind => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    let persisted = draft()
    persisted.config.links[0]!.parameterSource = { kind, sourceId: 'SOURCE-LINK', sourceVersion: 1, fields: ['bandwidth'] }
    const fetchSpy = vi.fn<typeof fetch>().mockImplementation(async (input, options) => {
      if (String(input).endsWith('/parameter-catalog')) {
        return { ok: true, json: async () => ({ ok: true, data: { equipment: [], masterData: [] }, meta: META }) } as Response
      }
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body))
        persisted = { ...persisted, config: body.config, uiExtensions: body.uiExtensions, revision: persisted.revision + 1 }
      }
      return response(structuredClone(persisted))
    })
    vi.stubGlobal('fetch', fetchSpy)
    expect(await scenario.loadScenario(persisted.config.scenario.id)).toBe(true)
    const error = vi.spyOn(ElMessage, 'error')
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: {
      plugins: [pinia, ElementPlus],
      stubs: { ElPopconfirm: { emits: ['confirm'], template: '<div @click="$emit(\'confirm\')"><slot name="reference" /></div>' } },
    } })
    await wrapper.get('#tab-links').trigger('click')
    await flushPromises()
    const before = JSON.stringify(scenario.draft)
    await wrapper.get('[data-testid="delete-link-0"]').trigger('click')
    expect(error).toHaveBeenCalledExactlyOnceWith('该链路仍引用基础数据，请先编辑链路，取消引用并保存后再删除。')
    expect(JSON.stringify(scenario.draft)).toBe(before)
    expect(scenario.dirty).toBe(false)
    expect(fetchSpy.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0)
    await wrapper.get('[data-testid="edit-link-0"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLElement>('[data-testid="link-parameter-clear"]')!.click()
    await flushPromises()
    document.querySelector<HTMLElement>('[data-testid="apply-link"]')!.click()
    await flushPromises()
    expect(persisted.config.links[0]!.parameterSource).toBeUndefined()
    expect(scenario.draft!.config.links[0]!.parameterSource).toBeUndefined()
    expect(fetchSpy.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1)
    await wrapper.get('[data-testid="delete-link-0"]').trigger('click')
    await flushPromises()
    expect(scenario.draft!.config.links.some(link => link.id === persisted.config.links[0]!.id)).toBe(false)
    expect(scenario.dirty).toBe(true)
    wrapper.unmount()
  })

  it('新增、编辑和删除链路时同步端点平台关联', async () => {
    const messageSpy = vi.spyOn(ElMessage, 'success')
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, {
      attachTo: document.body,
      global: {
        plugins: [pinia, ElementPlus],
        stubs: { ElPopconfirm: { emits: ['confirm'], template: '<div @click="$emit(\'confirm\')"><slot name="reference" /></div>' } },
      },
    })

    await wrapper.get('#tab-links').trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('已配置 5 / 5 类')
    const originalCount = scenario.draft!.config.links.length
    await wrapper.get('[data-testid="add-link"]').trigger('click')
    await flushPromises()
    const select = (testId: string) => wrapper.findAllComponents({ name: 'ElSelect' })
      .find((component) => component.attributes('data-testid') === testId)!
    const inputNumber = (testId: string) => wrapper.findAllComponents({ name: 'ElInputNumber' })
      .find((component) => component.attributes('data-testid') === testId)!
    expect(document.querySelector('[data-testid="link-frequency"]')).toBeNull()
    expect(document.querySelector('[data-testid="link-bandwidth"]')).toBeNull()
    document.querySelector<HTMLElement>('[data-testid="link-enabled"]')!.click()
    select('link-type').vm.$emit('update:modelValue', 'LASER')
    select('link-type').vm.$emit('change', 'LASER')
    select('link-source').vm.$emit('update:modelValue', 'CMD-01')
    select('link-target').vm.$emit('update:modelValue', 'UAV-01')
    select('link-direction').vm.$emit('update:modelValue', 'REVERSE')
    await nextTick()
    expect(inputNumber('link-frequency').props()).toMatchObject({ step: LINK_MHZ_MINIMUM_STEP })
    expect(inputNumber('link-frequency').props('min')).toBeLessThan(0)
    expect(inputNumber('link-bandwidth').props()).toMatchObject({ step: LINK_MHZ_MINIMUM_STEP })
    expect(inputNumber('link-bandwidth').props('min')).toBeLessThan(0)
    inputNumber('link-frequency').vm.$emit('input', 0)
    inputNumber('link-frequency').vm.$emit('update:modelValue', LINK_MHZ_MINIMUM_STEP)
    document.querySelector<HTMLElement>('[data-testid="apply-link"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.links).toHaveLength(originalCount)
    expect(document.querySelector('[data-testid="link-dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('链路频率必须大于 0 MHz。')
    expect(scenario.draft?.config.linkSettings).toBeUndefined()
    inputNumber('link-frequency').vm.$emit('input', 193500000)
    inputNumber('link-frequency').vm.$emit('update:modelValue', 193500000)
    inputNumber('link-bandwidth').vm.$emit('input', 0)
    inputNumber('link-bandwidth').vm.$emit('update:modelValue', LINK_MHZ_MINIMUM_STEP)
    document.querySelector<HTMLElement>('[data-testid="apply-link"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.links).toHaveLength(originalCount)
    expect(document.querySelector('[data-testid="link-dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('链路带宽必须大于 0 MHz。')
    inputNumber('link-frequency').vm.$emit('update:modelValue', 193500000)
    inputNumber('link-bandwidth').vm.$emit('input', 1000)
    inputNumber('link-bandwidth').vm.$emit('update:modelValue', 1000)
    inputNumber('link-power').vm.$emit('update:modelValue', 20)
    inputNumber('link-data-rate').vm.$emit('update:modelValue', 100)
    document.querySelector<HTMLElement>('[data-testid="apply-link"]')!.click()
    await flushPromises()

    expect(scenario.draft?.config.links).toHaveLength(originalCount + 1)
    expect(scenario.draft?.config.links.at(-1)?.enabled).toBe(false)
    expect(scenario.draft?.config.links.find(link => link.type === 'LASER')?.enabled).toBeUndefined()
    expect(scenario.draft?.config.links.at(-1)).toMatchObject({
      id: 'L-CFG-001',
      type: 'LASER',
      sourcePlatformId: 'CMD-01',
      targetPlatformId: 'UAV-01',
      frequency: 193500000,
      modulation: 'BPSK',
      direction: 'REVERSE',
    })
    expect(scenario.draft?.config.platforms[0]?.linkIds).toContain('L-CFG-001')
    expect(scenario.draft?.config.platforms[1]?.linkIds).toContain('L-CFG-001')
    expect(messageSpy).toHaveBeenCalledExactlyOnceWith('链路已新增，保存草稿后生效。')
    expect(document.querySelector('.el-message--success')?.textContent).toContain('链路已新增，保存草稿后生效。')
    expect(wrapper.find('.platform-feedback').exists()).toBe(false)

    await wrapper.get('[data-testid="edit-link-0"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLElement>('[data-testid="link-enabled"]')!.click()
    document.querySelector<HTMLElement>('[data-testid="cancel-link"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.links[0]?.enabled).toBeUndefined()
    await wrapper.get('[data-testid="edit-link-0"]').trigger('click')
    await flushPromises()
    // 微波端口为“无人机 ↔ 后方指挥节点”：把源端从 UAV-01 改为任务无人机 AIR-03。
    select('link-source').vm.$emit('update:modelValue', 'AIR-03')
    document.querySelector<HTMLElement>('[data-testid="apply-link"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.links[0]?.sourcePlatformId).toBe('AIR-03')
    expect(messageSpy).toHaveBeenLastCalledWith('链路已更新，保存草稿后生效。')
    expect(scenario.draft?.config.links[0]?.enabled).toBe(true)
    expect(scenario.draft?.config.links.at(-1)?.enabled).toBe(false)
    expect(scenario.draft?.config.platforms.find((platform) => platform.id === 'UAV-01')?.linkIds).not.toContain('L-MW-01')
    expect(scenario.draft?.config.platforms.find((platform) => platform.id === 'AIR-03')?.linkIds).toContain('L-MW-01')

    await wrapper.get('[data-testid="delete-link-0"]').trigger('click')
    await nextTick()
    expect(scenario.draft?.config.links.some((link) => link.id === 'L-MW-01')).toBe(false)
    expect(messageSpy).toHaveBeenLastCalledWith('链路已删除，保存草稿后生效。')
    expect(messageSpy).toHaveBeenCalledTimes(3)
    expect(scenario.draft?.config.platforms.every((platform) => !platform.linkIds.includes('L-MW-01'))).toBe(true)
    wrapper.unmount()
  })

  it('节点不足时以浮层消息提示，且不打开链路或干扰弹框', async () => {
    const messageSpy = vi.spyOn(ElMessage, 'error')
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    const singlePlatform = draft()
    singlePlatform.config.links = []
    singlePlatform.config.platforms = [singlePlatform.config.platforms[0]!]
    singlePlatform.config.platforms[0]!.linkIds = []
    scenario.$patch({ draft: singlePlatform, panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })

    await wrapper.get('#tab-links').trigger('click')
    await wrapper.get('[data-testid="add-link"]').trigger('click')
    await nextTick()

    expect(messageSpy).toHaveBeenCalledExactlyOnceWith('至少需要两个节点才能新增链路。')
    expect(wrapper.find('.platform-feedback').exists()).toBe(false)
    expect(document.querySelector('[data-testid="link-dialog"]')).toBeNull()

    scenario.draft!.config.platforms = []
    await wrapper.get('#tab-jammers').trigger('click')
    await wrapper.get('[data-testid="add-jammer"]').trigger('click')
    await nextTick()
    expect(wrapper.get('[data-testid="add-jammer"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="jammer-node-required"]').text()).toBe('请先在节点配置中新增干扰节点。')
    expect(wrapper.find('.platform-feedback').exists()).toBe(false)
    expect(document.querySelector('[data-testid="jammer-dialog"]')).toBeNull()
  })

  it('新增、编辑和删除干扰设备时同步归属平台关联', async () => {
    const messageSpy = vi.spyOn(ElMessage, 'success')
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, {
      attachTo: document.body,
      global: {
        plugins: [pinia, ElementPlus],
        stubs: { ElPopconfirm: { emits: ['confirm'], template: '<div @click="$emit(\'confirm\')"><slot name="reference" /></div>' } },
      },
    })

    // 每个干扰节点只允许一台干扰设备：新增设备挂到尚无设备的机载干扰平台。
    const station = scenario.draft!.config.platforms.find(p => p.id === 'STN-01')!
    scenario.draft!.config.platforms.push({ ...structuredClone(toRaw(station)), id: 'AJ-002', name: '机载干扰平台 2', type: 'AIRBORNE_JAMMER_PLATFORM', category: 'air', jammerIds: [], sensorIds: [] })
    await wrapper.get('#tab-jammers').trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('已配置 2 / 3 种手段')
    const originalCount = scenario.draft!.config.jammers.length
    await wrapper.get('[data-testid="add-jammer"]').trigger('click')
    await flushPromises()
    const select = (testId: string) => wrapper.findAllComponents({ name: 'ElSelect' })
      .find((component) => component.attributes('data-testid') === testId)!
    const inputNumber = (testId: string) => wrapper.findAllComponents({ name: 'ElInputNumber' })
      .find((component) => component.attributes('data-testid') === testId)!
    expect(inputNumber('jammer-frequency').props()).toMatchObject({ min: Number.MIN_VALUE, step: LINK_MHZ_MINIMUM_STEP })
    select('jammer-type').vm.$emit('update:modelValue', 'SWEEP')
    select('jammer-type').vm.$emit('change', 'SWEEP')
    await flushPromises()
    expect(inputNumber('jammer-bandwidth').props()).toMatchObject({ min: Number.MIN_VALUE, step: LINK_MHZ_MINIMUM_STEP })
    expect(document.querySelector('[data-testid="jammer-auto-detect"]')).toBeNull()
    // 干扰指向不参与仿真，弹框已不再提供配置。
    expect(document.querySelector('[data-testid="jammer-direction"]')).toBeNull()
    expect(document.querySelector('[data-testid="jammer-trigger-time"]')).toBeNull()
    expect(document.querySelector('[data-testid="jammer-duration"]')).toBeNull()

    inputNumber('jammer-frequency').vm.$emit('input', 0)
    inputNumber('jammer-frequency').vm.$emit('update:modelValue', LINK_MHZ_MINIMUM_STEP)
    document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.jammers).toHaveLength(originalCount)
    expect(document.body.textContent).toContain('干扰频率必须大于 0 MHz。')

    select('jammer-platform').vm.$emit('update:modelValue', 'AJ-002')
    inputNumber('jammer-power').vm.$emit('update:modelValue', 30)
    inputNumber('jammer-range').vm.$emit('update:modelValue', 44.448)
    inputNumber('jammer-frequency').vm.$emit('input', 2200)
    inputNumber('jammer-frequency').vm.$emit('update:modelValue', 2200)
    inputNumber('jammer-bandwidth').vm.$emit('input', 0)
    inputNumber('jammer-bandwidth').vm.$emit('update:modelValue', LINK_MHZ_MINIMUM_STEP)
    document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.jammers).toHaveLength(originalCount)
    expect(document.body.textContent).toContain('干扰带宽必须大于 0 MHz。')
    expect(document.querySelector('[data-testid="jammer-enabled"]')).toBeNull()
    inputNumber('jammer-frequency').vm.$emit('input', undefined)
    inputNumber('jammer-bandwidth').vm.$emit('input', 5)
    inputNumber('jammer-bandwidth').vm.$emit('update:modelValue', 5)
    inputNumber('jammer-bandwidth').vm.$emit('input', undefined)
    document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
    await flushPromises()

    expect(scenario.draft?.config.jammers).toHaveLength(originalCount + 1)
    expect(messageSpy).toHaveBeenCalledExactlyOnceWith('干扰设备已新增，保存草稿后生效。')
    expect(wrapper.find('.platform-feedback').exists()).toBe(false)
    expect(scenario.draft?.config.jammers.at(-1)).toEqual({
      radarFrequency: 2400, radarBandwidth: 1, radarPower: 1000, noiseFigureDb: 3,
      // 功率 30 dBm 按 功率(dBm)-30+增益-损耗 联动得 0 dBW。
      gtDbk: -12, eirpDbw: 0, antennaGainDbi: 0, txLossDb: 0, sweepDutyCycle: 0.1,
      id: 'JAM-CFG-001',
      platformId: 'AJ-002',
      type: 'SWEEP',
      defaultPower: 1,
      frequency: 2200,
      bandwidth: 5,
      weaponBands: [{ frequency: 2200, bandwidth: 5, mode: 'SWEEP', spotBandwidthMHz: 0, sweepDutyCycle: 0.1 }],
      // 探测范围按 km 输入；干扰与释放范围取文档默认的 30、35 海里。
      detectionRange: 44448,
      jammingRange: 55560,
      releaseRange: 64820,
    })
    expect(scenario.draft?.config.platforms.find((platform) => platform.id === 'AJ-002')?.jammerIds).toContain('JAM-CFG-001')
    expect(scenario.draft?.uiExtensions.jammers.find((extension) => extension.jammerId === 'JAM-CFG-001')).toEqual({
      jammerId: 'JAM-CFG-001', direction: 0, enabled: true,
    })

    wrapper.findAllComponents({ name: 'ElSwitch' })
      .find((component) => component.attributes('data-testid') === 'toggle-jammer-JAM-SPOT-01-TX')!
      .vm.$emit('update:modelValue', true)
    await nextTick()
    expect(scenario.draft?.uiExtensions.jammers.find((extension) => extension.jammerId === 'JAM-WB-01-TX')?.enabled).toBe(true)
    expect(scenario.draft?.uiExtensions.jammers.find((extension) => extension.jammerId === 'JAM-SPOT-01-TX')?.enabled).toBe(true)

    await wrapper.get('[data-testid="edit-jammer-0"]').trigger('click')
    await flushPromises()
    // 改挂到新的地面干扰站：同类地面站的设备参数一致，不触发 D6 冲突。
    scenario.draft!.config.platforms.push({ ...structuredClone(toRaw(scenario.draft!.config.platforms.find(p => p.id === 'STN-01')!)),
      id: 'STN-03', name: '地面干扰侦测站 3', jammerIds: [], sensorIds: [] })
    select('jammer-platform').vm.$emit('update:modelValue', 'STN-03')
    document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.jammers[0]?.platformId).toBe('STN-03')
    expect(messageSpy).toHaveBeenLastCalledWith('干扰设备已更新，保存草稿后生效。')
    expect(scenario.draft?.config.platforms.find((platform) => platform.id === 'STN-01')?.jammerIds).not.toContain('JAM-WB-01-TX')
    expect(scenario.draft?.config.platforms.find((platform) => platform.id === 'STN-03')?.jammerIds).toContain('JAM-WB-01-TX')

    await wrapper.get('[data-testid="delete-jammer-0"]').trigger('click')
    await nextTick()
    expect(scenario.draft?.config.jammers.some((jammer) => jammer.id === 'JAM-WB-01-TX')).toBe(false)
    expect(messageSpy).toHaveBeenLastCalledWith('干扰设备已删除，保存草稿后生效。')
    expect(messageSpy).toHaveBeenCalledTimes(3)
    expect(scenario.draft?.config.platforms.every((platform) => !platform.jammerIds.includes('JAM-WB-01-TX'))).toBe(true)
    expect(scenario.draft?.uiExtensions.jammers.some((extension) => extension.jammerId === 'JAM-WB-01-TX')).toBe(false)
    wrapper.unmount()
  })
})

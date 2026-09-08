import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, toRaw } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ApiSuccess, ConfirmationContext, PageMeta, Principal, ScenarioConfig, ScenarioDraft, ScenarioTemplate, ScriptContract, ValidationResult } from '../../src/contracts/domain-models'
import { inspectScenarioConfig, isBusinessInformationNodeType, LINK_MHZ_MINIMUM_STEP } from '../../src/features/scenarios/scenario-validation'
import { SCENARIO_BASIC_DEFAULTS, withScenarioBasicDefaults } from '../../src/features/scenarios/scenario-basic'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'
import AdminPage from '../../src/pages/admin/admin.vue'
import ScenariosPage from '../../src/pages/scenarios/scenarios.vue'
import { createAppRouter } from '../../src/router'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'

enableAutoUnmount(afterEach)

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
  return {
    config: structuredClone(fixtureSource.scenario) as ScenarioConfig,
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
  it('机载干扰设备作为空中支撑实体新增、保存回读且可作为干扰归属平台', async () => {
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
    await wrapper.get('[data-testid="add-supporting-platform"]').trigger('click')
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
      expect(number.props('disabled')).toBe(false)
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
    expect(wrapper.get('[data-testid="platform-table"]').text()).toContain('机载干扰设备')
    expect(scenario.draft!.config.platforms.at(-1)).toMatchObject({ type: 'AIRBORNE_JAMMER_PLATFORM', initialPosition: { longitude: 120.5, latitude: 26, altitude: 5000 } })
    await wrapper.get('#tab-jammers').trigger('click')
    await wrapper.get('[data-testid="add-jammer"]').trigger('click')
    await flushPromises()
    const owner = wrapper.findAllComponents({ name: 'ElSelect' }).find(c => c.attributes('data-testid') === 'jammer-platform')!
    expect(owner.findAllComponents({ name: 'ElOption' }).some(c => c.props('label').startsWith('机载干扰测试'))).toBe(true)
  })

  afterEach(() => {
    ElMessage.closeAll()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('链路状态与中继卫星分列展示，卫星选择不改变链路独立状态', async () => {
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
    expect(table.text()).toContain('中继卫星')
    const satellites = () => table.findAll('.el-table__body tbody tr').map(row => row.findAll('td')[3]!.text())
    expect(satellites()).toEqual(Array(5).fill('天通卫星'))
    const settings = readLinkSettings(current.config)
    settings.enabledSatellites = { TIANTONG: false, SHENTONG: true }
    wrapper.findComponent({ name: 'LinkSettingsPanel' }).vm.$emit('update:modelValue', settings)
    await nextTick()
    expect(labels()).toEqual(['启用', '启用', '停用', '启用', '启用'])
    expect(satellites()).toEqual(Array(5).fill('神通卫星'))
    expect(scenario.dirty).toBe(true)
    expect(scenario.draft!.config.links.map(link => link.enabled)).toEqual([true, true, false, true, true])
  })

  it('业务与链路保持五个页签，业务默认值、取消、非法输入和定位生效', async () => {
    const message = vi.spyOn(ElMessage, 'success')
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const original = structuredClone(fixtureSource.scenario.informationDemand)
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(5)
    await wrapper.get('#tab-links').trigger('click')
    expect(wrapper.get('#pane-links').find('[data-testid="information-demand-table"]').exists()).toBe(true)
    expect(wrapper.get('#pane-data').find('[data-testid="information-demand-table"]').exists()).toBe(false)
    await wrapper.get('[data-testid="add-information-demand"]').trigger('click')
    const dialog = wrapper.findComponent({ name: 'BusinessEditorDialog' })
    expect(dialog.props('demand')).toMatchObject({ direction: 'FORWARD', enabled: true, informationType: '目标指令', volumeMb: 0.000256, frequencyHz: 1, minDataRateMbps: 0.0256 })
    dialog.vm.$emit('update:modelValue', false)
    await nextTick()
    expect(scenario.draft!.config.informationDemand).toEqual(original)
    expect(scenario.dirty).toBe(false)
    expect(wrapper.get('[data-testid="add-information-demand"]').text()).toBe('新增业务')
    expect(wrapper.find('[data-testid="add-reverse-business"]').exists()).toBe(false)
    await wrapper.get('[data-testid="add-information-demand"]').trigger('click')
    const reverse = { ...structuredClone(toRaw(dialog.props('demand')!)), direction: 'REVERSE', informationType: '视频', volumeMb: 2, frequencyHz: 30, minDataRateMbps: 2 }
    expect(reverse).toMatchObject({ direction: 'REVERSE', informationType: '视频', volumeMb: 2, frequencyHz: 30, minDataRateMbps: 2 })
    dialog.vm.$emit('apply', { ...reverse, destinationPlatformIds: [] })
    await nextTick()
    expect(dialog.props('error')).toContain('目标平台')
    expect(scenario.draft!.config.informationDemand).toEqual(original)
    dialog.vm.$emit('apply', { ...reverse, enabled: false })
    await nextTick()
    expect(scenario.draft!.config.informationDemand.at(-1)).toMatchObject({ direction: 'REVERSE', enabled: false })
    expect(message).toHaveBeenLastCalledWith('业务已新增，保存草稿后生效。')
    expect(scenario.draft!.config.informationDemand[0]).toEqual(original[0])
    await wrapper.get('[data-testid="edit-business-0"]').trigger('click')
    dialog.vm.$emit('apply', { ...structuredClone(toRaw(dialog.props('demand')!)), frequencyHz: 2 })
    await nextTick()
    expect(message).toHaveBeenLastCalledWith('业务已更新，保存草稿后生效。')
    await wrapper.get('[data-testid="next-validation"]').trigger('click')
    wrapper.findComponent({ name: 'ValidationPanel' }).vm.$emit('locate', { severity: 'ERROR', code: 'TEST', message: '请检查业务信息量', fieldPath: 'informationDemand[0].volumeMb' })
    await flushPromises()
    expect(wrapper.get('#tab-links').attributes('aria-selected')).toBe('true')
    expect(dialog.props('modelValue')).toBe(true)
    expect(dialog.props('error')).toBe('请检查业务信息量')
    dialog.vm.$emit('opened')
    expect(document.activeElement?.closest('[data-testid="demand-volume"]')).not.toBeNull()
    scenario.draft!.locked = true
    const count = scenario.draft!.config.informationDemand.length
    dialog.vm.$emit('apply', reverse)
    await nextTick()
    expect(scenario.draft!.config.informationDemand).toHaveLength(count)
    expect(dialog.props('disabled')).toBe(true)
  })

  it('缩短场景时长后可逐台修正触发时间，全部修正前禁止保存', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore()
    let persisted = draft()
    persisted.config.jammers.forEach(jammer => { jammer.triggerTimeS = 300 })
    // 本例仅验证触发时间；避免既有航点超过缩短后的总时长。
    persisted.config.platforms.forEach(platform => { platform.waypoints = [] })
    const fetchSpy = vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.method === 'PUT') persisted = { ...persisted, ...JSON.parse(String(options.body)), revision: persisted.revision + 1 }
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
    for (const index of [0, 1]) {
      await wrapper.get(`[data-testid="edit-jammer-${index}"]`).trigger('click')
      await flushPromises()
      const dialog = wrapper.findComponent({ name: 'JammerEditorDialog' })
      dialog.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'jammer-trigger-time')!.vm.$emit('update:modelValue', 50)
      await nextTick()
      document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
      await flushPromises()
      expect(dialog.props('modelValue')).toBe(false)
      expect(scenario.draft!.config.jammers[index]!.triggerTimeS).toBe(50)
      if (index === 0) {
        expect(scenario.draft!.config.jammers[1]!.triggerTimeS).toBe(300)
        expect(await scenario.saveScenario()).toBe(false)
        expect(scenario.validation.errors).toContainEqual(expect.objectContaining({ fieldPath: 'jammers[1].triggerTimeS' }))
        expect(fetchSpy.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0)
      }
    }
    expect(await scenario.saveScenario()).toBe(true)
    expect(await scenario.loadScenario()).toBe(true)
    expect(scenario.draft!.config.jammers.map(jammer => jammer.triggerTimeS)).toEqual([50, 50])
  })

  it('删除最后一颗已选卫星清理选择并可保存回读，仍保护业务引用', async () => {
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
      if (options?.method === 'PUT') persisted = { ...persisted, ...JSON.parse(String(options.body)), revision: persisted.revision + 1 }
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
    await wrapper.get('#tab-links').trigger('click')
    await wrapper.get('[data-testid="edit-business-0"]').trigger('click')
    const businessDialog = wrapper.findComponent({ name: 'BusinessEditorDialog' })
    const demand = structuredClone(toRaw(businessDialog.props('demand')!))
    demand.destinationPlatformIds = demand.destinationPlatformIds.filter((id: string) => id !== satellite.id)
    businessDialog.vm.$emit('apply', demand)
    await nextTick()
    await wrapper.get('#tab-platforms').trigger('click')
    await wrapper.get(`[data-testid="delete-platform-${index}"]`).trigger('click')
    expect(scenario.draft!.config.platforms.some(p => p.id === satellite.id)).toBe(false)
    expect(scenario.draft!.config.linkSettings!.enabledSatellites).toEqual({ TIANTONG: false, SHENTONG: false })
    expect(await scenario.saveScenario()).toBe(true)
    expect(await scenario.loadScenario()).toBe(true)
    await wrapper.get('#tab-links').trigger('click')
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
    expect(dialog.props('jammer')).toMatchObject({ type: 'BARRAGE', defaultPower: 100, bandwidth: 20, triggerTimeS: 300, detectionRange: 44448 })
    expect(dialog.props('jammerTypeOptions')).toContainEqual({ value: 'SWEEP', label: '扫频' })
    dialog.vm.$emit('update:modelValue', false)
    await nextTick()
    expect(scenario.draft!.config.jammers).toHaveLength(2)
    await wrapper.get('[data-testid="edit-jammer-0"]').trigger('click')
    const range = dialog.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'jammer-range')!
    expect(range.props('modelValue')).toBe(150000 / 1852)
    range.vm.$emit('update:modelValue', 25)
    await nextTick()
    document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
    await flushPromises()
    expect(dialog.props('error')).toContain('1～24 海里')
    expect(scenario.draft!.config.jammers[0]!.detectionRange).toBe(150000)
    range.vm.$emit('update:modelValue', 24)
    dialog.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'jammer-type')!.vm.$emit('update:modelValue', 'SWEEP')
    dialog.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'jammer-trigger-time')!.vm.$emit('update:modelValue', 300)
    await nextTick()
    document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
    await flushPromises()
    expect(scenario.draft!.config.jammers[0]).toMatchObject({ type: 'SWEEP', detectionRange: 44448, triggerTimeS: 300 })
    expect(scenario.draft!.config.jammers[1]!.detectionRange).toBe(150000)
    expect(inspectScenarioConfig(scenario.draft!.config, 'write').result.valid).toBe(false)
    await wrapper.get('[data-testid="next-validation"]').trigger('click')
    wrapper.findComponent({ name: 'ValidationPanel' }).vm.$emit('locate', { severity: 'ERROR', code: 'TEST', message: '请检查触发时间', fieldPath: 'jammers[0].triggerTimeS' })
    await flushPromises()
    dialog.vm.$emit('opened')
    expect(document.activeElement?.closest('[data-testid="jammer-trigger-time"]')).not.toBeNull()
    scenario.draft!.locked = true
    totalSwitch.vm.$emit('update:modelValue', false)
    await nextTick()
    expect(scenario.draft!.config.jammingEnabled).toBe(true)
  })

  it('展示完整基础、时序和环境字段并保存中文草稿', async () => {
    const messageSpy = vi.spyOn(ElMessage, 'success')
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })

    const saved = draft(5)
    saved.config.scenario.name = '台海通联验证场景'
    const fetchSpy = vi.fn().mockResolvedValue(response(saved))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })

    expect(wrapper.get('.scenario-page').attributes('aria-label')).toBe('场景配置')
    expect(wrapper.text()).toContain('场景基础')
    expect(wrapper.find('[data-testid="scenario-duration"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="scenario-sea-state"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="scenario-editor"]').exists()).toBe(true)
    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      '场景基础', '平台与航点', '业务与链路', '干扰设备', '传感器与输出',
    ])
    expect(wrapper.get('[data-testid="scenario-next-step"]').text()).toContain('当前草稿已保存')

    await wrapper.get('[data-testid="scenario-name"]').setValue(saved.config.scenario.name)
    expect(scenario.dirty).toBe(true)
    expect(wrapper.get('[data-testid="save-scenario"]').text()).toBe('校验并保存')
    expect(wrapper.get('[data-testid="next-validation"]').text()).toBe('下一步：校验与保存')
    expect(wrapper.find('[data-testid="next-script"]').exists()).toBe(false)
    await wrapper.get('[data-testid="next-validation"]').trigger('click')
    expect(wrapper.get('[data-testid="scenario-next-step"]').text()).toContain('无需先单独执行整体校验')
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(scenario.draft?.revision).toBe(5)
    expect(messageSpy).toHaveBeenCalledExactlyOnceWith('场景草稿已保存。')
    expect(wrapper.find('.platform-feedback').exists()).toBe(false)
    expect(wrapper.text()).toContain('修订 5')
    expect(wrapper.text()).toContain('已就绪')
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT' })
    expect(wrapper.get('[data-testid="next-script"]').text()).toBe('下一步：脚本预览')
    await wrapper.get('[data-testid="next-script"]').trigger('click')
    expect(wrapper.find('[data-testid="script-preview-panel"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="scenario-next-step"]').text()).toContain('点击下方“生成脚本预览”')
    expect(wrapper.get('[data-testid="script-next-step"]').text()).toContain('最后执行预检')
    expect(wrapper.get('[data-testid="preflight-script"]').attributes('disabled')).toBeDefined()
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
    expect(fields.findAll('.el-form-item__label').map((item) => item.text())).toEqual([
      '场景编号', '场景名称', '开始时间', '时间步长（秒）',
      '仿真总时长（min）', '仿真时钟倍速（倍）', '海峡宽度（km）', '云雨气象衰减', '海面多径衰落',
      '海况等级', '温度（℃）', '相对湿度（%）', '降雨率（mm/h）', '雨衰（dB/km）', '场景描述',
    ])
    expect(wrapper.findAll('[data-testid="scenario-duration"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="scenario-sim-total-time"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="scenario-multipath"]')).toHaveLength(1)
    const duration = fields.get('[data-testid="scenario-duration"] input')
    expect((duration.element as HTMLInputElement).value).toBe('20')
    expect(fields.get('[data-testid="scenario-sim-clock-speed"] input').attributes('aria-valuenow')).toBe('2')
    expect(fields.get('[data-testid="scenario-trans-distance"] input').attributes('aria-valuenow')).toBe('300')
    expect(fields.findComponent({ name: 'ElSelect' }).props('modelValue')).toBe('lightRain')
    expect(fields.findComponent({ name: 'ElSwitch' }).props('modelValue')).toBe(true)

    await duration.setValue('20.5')
    await duration.trigger('change')
    await fields.get('[data-testid="scenario-sim-clock-speed"] input').setValue('3')
    await fields.get('[data-testid="scenario-sim-clock-speed"] input').trigger('change')
    await fields.get('[data-testid="scenario-trans-distance"] input').setValue('350')
    await fields.get('[data-testid="scenario-trans-distance"] input').trigger('change')
    fields.findComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', 'heavyRain')
    fields.findComponent({ name: 'ElSwitch' }).vm.$emit('update:modelValue', false)
    await nextTick()

    const saved = structuredClone(initial)
    saved.revision = 5
    saved.config.scenario.duration = 1230
    Object.assign(saved.config.scenario.environment, {
      simClockSpeed: 3, transmissionDistance: 350, rainCloudAttenuation: 'heavyRain', multipathEnabled: false,
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

  it('已保存草稿先进入校验阶段，校验通过才开放脚本且不重复保存', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const fetchSpy = vi.fn().mockRejectedValueOnce(new Error('校验服务不可用。'))
      .mockResolvedValue(validationResponse({ valid: true, errors: [], warnings: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })

    expect(wrapper.get('[data-testid="next-validation"]').text()).toBe('下一步：校验与保存')
    expect(wrapper.get('[data-testid="workflow-script"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="workflow-script"]').trigger('click')
    expect(wrapper.find('[data-testid="script-preview-panel"]').exists()).toBe(false)
    await wrapper.get('[data-testid="next-validation"]').trigger('click')
    expect(wrapper.get('[data-testid="next-script"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="validate-scenario"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="next-script"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="validate-scenario"]').trigger('click')
    await flushPromises()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls.every(([url, options]) => String(url).endsWith('/validate') && options.method === 'POST')).toBe(true)
    expect(scenario.draft?.revision).toBe(4)
    expect(wrapper.get('[data-testid="next-script"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="next-script"]').trigger('click')
    expect(wrapper.find('[data-testid="script-preview-panel"]').exists()).toBe(true)
    await wrapper.get('[data-testid="workflow-config"]').trigger('click')
    await wrapper.get('[data-testid="scenario-name"]').setValue('校验后修改')
    expect(wrapper.get('[data-testid="workflow-script"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="next-validation"]').trigger('click')
    expect(wrapper.get('[data-testid="next-script"]').attributes('disabled')).toBeDefined()
  })

  it('编辑完整数据域并进入场景快照和脚本操作', { timeout: 15_000 }, async () => {
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
      draft: draft(), panelState: 'SUCCESS', script, scriptState: 'SUCCESS',
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
    await wrapper.get('#tab-data').trigger('click')
    await nextTick()

    const component = (name: string, testId: string) => wrapper.findAllComponents({ name })
      .find((item) => item.attributes('data-testid') === testId)!
    component('ElSelect', 'sensor-platform-0').vm.$emit('change', 'UAV-01')
    component('ElInputNumber', 'sensor-frequency-min-0').vm.$emit('update:modelValue', 1200)
    component('ElInputNumber', 'sensor-frequency-max-0').vm.$emit('update:modelValue', 6200)
    component('ElInputNumber', 'sensor-range-0').vm.$emit('update:modelValue', 120000)
    component('ElSelect', 'sensor-direction-mode-0').vm.$emit('change', 'DIRECTIONAL')
    await nextTick()
    component('ElInputNumber', 'sensor-direction-0').vm.$emit('update:modelValue', 90)
    component('ElInputNumber', 'sensor-probability-0').vm.$emit('update:modelValue', 0.8)
    component('ElSwitch', 'sensor-enabled-0').vm.$emit('change', false)
    await wrapper.get('[data-testid="add-sensor"]').trigger('click')
    await nextTick()
    await wrapper.get('[data-testid="delete-sensor-1"]').trigger('click')

    await wrapper.get('[data-testid="output-directory"]').setValue('./edited-output')
    component('ElInputNumber', 'output-write-interval').vm.$emit('update:modelValue', 2)
    for (const testId of ['output-link-quality', 'output-events', 'output-link-switch']) {
      component('ElSwitch', testId).vm.$emit('change', false)
    }
    expect(wrapper.get('#pane-data').find('[data-testid="information-demand-table"]').exists()).toBe(false)
    await wrapper.get('#tab-links').trigger('click')
    await wrapper.get('[data-testid="edit-business-0"]').trigger('click')
    const businessDialog = wrapper.findComponent({ name: 'BusinessEditorDialog' })
    businessDialog.vm.$emit('apply', { ...structuredClone(fixtureSource.scenario.informationDemand[0]), informationType: '目标指令', direction: 'FORWARD', enabled: true })
    await nextTick()
    await wrapper.get('[data-testid="add-information-demand"]').trigger('click')
    await nextTick()
    businessDialog.vm.$emit('apply', businessDialog.props('demand'))
    await nextTick()
    const lastDelete = wrapper.findAllComponents({ name: 'ElPopconfirm' }).find(item => item.find('[data-testid="delete-information-demand-1"]').exists())!
    lastDelete.vm.$emit('confirm', new MouseEvent('click'))
    expect(scenario.dirty).toBe(true)

    await wrapper.get('[data-testid="workflow-script"]').trigger('click')
    await nextTick()
    expect(wrapper.get('[data-testid="workflow-script"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="script-preview-panel"]').exists()).toBe(false)

    scenario.dirty = false
    const messageSpy = vi.spyOn(ElMessage, 'success')
    const promptSpy = vi.spyOn(ElMessageBox, 'prompt').mockResolvedValue({ value: JSON.stringify(scenario.draft!.config) } as never)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue(true as never)
    const importSpy = vi.spyOn(scenario, 'importScenarioSnapshot').mockImplementation(async () => {
      scenario.resultMessage = '已导入 1 个完整场景快照。'
      return true
    })
    const undoSpy = vi.spyOn(scenario, 'undoScenario').mockImplementation(async () => {
      scenario.resultMessage = '场景操作已撤销。'
      return true
    })
    const resetSpy = vi.spyOn(scenario, 'resetScenario').mockImplementation(async () => {
      scenario.resultMessage = '当前场景已重置。'
      return true
    })
    await wrapper.get('[data-testid="open-scenario-operations"]').trigger('click')
    await wrapper.get('[data-testid="import-scenario-snapshot"]').trigger('click')
    await wrapper.get('[data-testid="undo-scenario"]').trigger('click')
    await wrapper.get('[data-testid="reset-scenario"]').trigger('click')
    await flushPromises()
    expect(promptSpy).toHaveBeenCalled()
    expect(importSpy).toHaveBeenCalledOnce()
    expect(undoSpy).toHaveBeenCalledOnce()
    expect(resetSpy).toHaveBeenCalledOnce()
    expect(messageSpy.mock.calls).toEqual([
      ['已导入 1 个完整场景快照。'], ['场景操作已撤销。'], ['当前场景已重置。'],
    ])
    expect(wrapper.find('.platform-feedback').exists()).toBe(false)

    vi.spyOn(scenario, 'validateScenario').mockResolvedValue(true)
    await wrapper.get('[data-testid="validate-scenario"]').trigger('click')
    await flushPromises()

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
    const generateSpy = vi.spyOn(scenario, 'generateScriptPreview').mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await wrapper.get('[data-testid="workflow-script"]').trigger('click')
    await wrapper.get('[data-testid="generate-script"]').trigger('click')
    await wrapper.get('[data-testid="preflight-script"]').trigger('click')
    await flushPromises()
    expect(generateSpy).toHaveBeenNthCalledWith(2, true)
    expect(preflightSpy).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('2:3')
    expect(wrapper.text()).toContain('—')

    scenario.scriptResultCode = 'PREFLIGHT_SUCCESS'
    scenario.preflight = { valid: true, errors: [], warnings: [] }
    await nextTick()
    expect(wrapper.get('[data-testid="scenario-next-step"]').text()).toContain('本页流程已完成')
    expect(wrapper.get('[data-testid="script-next-step"]').text()).toContain('不会写入本地文件或启动真实 AFSIM')
    await wrapper.get('[data-testid="workflow-config"]').trigger('click')
    await wrapper.get('[data-testid="scenario-name"]').setValue('重新编辑场景')
    expect(wrapper.get('[data-testid="scenario-next-step"]').text()).toContain('未保存修改')
    await wrapper.get('[data-testid="workflow-script"]').trigger('click')
    expect(wrapper.find('[data-testid="script-preview"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="workflow-script"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="next-validation"]').trigger('click')
    expect(wrapper.get('[data-testid="next-script"]').attributes('disabled')).toBeDefined()
  })

  it.each([
    OPERATOR,
    ADMIN,
  ])('场景配置对 $role 仅提供模板查看和应用', async (principal) => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal, role: principal.role, permissions: [...principal.permissions] })
    const scenario = useScenarioStore(pinia)
    scenario.$patch({
      draft: draft(),
      panelState: 'SUCCESS',
      templates: [template()],
      selectedTemplate: template(),
      templateState: 'SUCCESS',
      templateResultMessage: '已加载 1 个场景模板。',
      lastConfirmation: confirmation(),
    })
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await wrapper.get('[data-testid="open-scenario-templates"]').trigger('click')
    await nextTick()
    const panel = wrapper.get('[data-testid="template-library"]')

    expect(panel.text()).toContain('场景配置使用')
    expect(panel.text()).toContain('跨海通联演示官方基线')
    expect(panel.text()).toContain('查看详情')
    expect(panel.text()).toContain('应用到当前场景')
    expect(panel.find('[data-testid="create-template"]').exists()).toBe(false)
    expect(panel.find('[data-testid="import-template"]').exists()).toBe(false)
    expect(panel.text()).not.toMatch(/更新|导出|删除/)
    expect(panel.get('[data-testid="latest-confirmation"]').text()).toContain('CONF-P2-001')
    expect(panel.get('[data-testid="latest-confirmation"]').text()).toContain('已完成')
  })

  it('在场景配置中查看并应用模板', { timeout: 15_000 }, async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS', templates: [template()], templateState: 'SUCCESS' })
    const promptSpy = vi.spyOn(ElMessageBox, 'prompt').mockResolvedValue({ value: '模板场景' } as never)
    const copySpy = vi.spyOn(scenario, 'copyTemplate').mockResolvedValue(true)
    const loadSpy = vi.spyOn(scenario, 'loadTemplate').mockResolvedValue(template())
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await wrapper.get('[data-testid="open-scenario-templates"]').trigger('click')
    await nextTick()
    const panel = wrapper.get('[data-testid="template-library"]')
    await panel.get('[data-testid="load-template-TPL-SCN-001"]').trigger('click')
    await panel.get('[data-testid="copy-template-TPL-SCN-001"]').trigger('click')
    await flushPromises()

    expect(promptSpy).toHaveBeenCalledOnce()
    expect(promptSpy).toHaveBeenCalledWith('应用后将替换当前临时工作场景。', '应用场景模板', expect.objectContaining({ confirmButtonText: '应用' }))
    expect(loadSpy).toHaveBeenCalledWith('TPL-SCN-001')
    expect(copySpy).toHaveBeenCalledWith('TPL-SCN-001', '模板场景')
  })

  it('在系统管理中完成官方模板维护动作', { timeout: 15_000 }, async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    const scenario = useScenarioStore(pinia)
    scenario.$patch({
      draft: draft(),
      panelState: 'SUCCESS',
      templates: [template()],
      templateState: 'SUCCESS',
    })
    const promptSpy = vi.spyOn(ElMessageBox, 'prompt')
      .mockResolvedValueOnce({ value: '新建模板' } as never)
      .mockResolvedValueOnce({ value: '{"name":"导入模板","config":{}}' } as never)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    vi.spyOn(ElMessageBox, 'alert').mockResolvedValue('confirm' as never)
    const createSpy = vi.spyOn(scenario, 'createTemplate').mockResolvedValue(true)
    const importSpy = vi.spyOn(scenario, 'importTemplate').mockResolvedValue(true)
    const updateSpy = vi.spyOn(scenario, 'updateTemplate').mockResolvedValue(true)
    const exportSpy = vi.spyOn(scenario, 'exportTemplate').mockResolvedValue('{"name":"跨海通联演示官方基线"}')
    const deleteSpy = vi.spyOn(scenario, 'deleteTemplate').mockResolvedValue(true)
    const loadSpy = vi.spyOn(scenario, 'loadTemplate').mockResolvedValue(template())
    const router = createAppRouter(createMemoryHistory(), pinia)
    await router.push({ path: '/admin', query: { section: 'scenario-templates' } })
    const wrapper = mount(AdminPage, {
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
    await nextTick()
    const panel = wrapper.get('[data-testid="template-library"]')
    expect(wrapper.get('.admin-page').attributes('aria-label')).toBe('场景模板维护')
    expect(panel.text()).toContain('管理员维护')
    expect(panel.text()).not.toContain('应用到当前场景')
    await panel.get('[data-testid="create-template"]').trigger('click')
    await flushPromises()
    await panel.get('[data-testid="import-template"]').trigger('click')
    await flushPromises()
    await panel.get('[data-testid="load-template-TPL-SCN-001"]').trigger('click')
    await panel.get('[data-testid="update-template-TPL-SCN-001"]').trigger('click')
    await flushPromises()
    await panel.get('[data-testid="export-template-TPL-SCN-001"]').trigger('click')
    await flushPromises()
    await panel.get('[data-testid="delete-template-TPL-SCN-001"]').trigger('click')
    await flushPromises()

    expect(promptSpy).toHaveBeenCalledTimes(2)
    expect(createSpy).toHaveBeenCalledWith('新建模板')
    expect(importSpy).toHaveBeenCalledWith('{"name":"导入模板","config":{}}')
    expect(loadSpy).toHaveBeenCalledWith('TPL-SCN-001')
    expect(updateSpy).toHaveBeenCalledWith('TPL-SCN-001', '跨海通联演示官方基线')
    expect(exportSpy).toHaveBeenCalledWith('TPL-SCN-001')
    expect(deleteSpy).toHaveBeenCalledWith('TPL-SCN-001')
  })

  it('取消应用模板时保持当前场景不变并展示模板错误反馈', { timeout: 15_000 }, async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    scenario.$patch({
      draft: draft(),
      panelState: 'SUCCESS',
      templates: [template()],
      templateState: 'ERROR',
      templateResultMessage: '模板服务不可用。',
    })
    vi.spyOn(ElMessageBox, 'prompt').mockRejectedValue(new Error('cancelled'))
    const copySpy = vi.spyOn(scenario, 'copyTemplate')
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })

    await wrapper.get('[data-testid="open-scenario-templates"]').trigger('click')
    await nextTick()
    const panel = wrapper.get('[data-testid="template-library"]')
    expect(panel.get('[data-testid="template-feedback"]').text()).toContain('模板服务不可用')
    await panel.get('[data-testid="copy-template-TPL-SCN-001"]').trigger('click')
    await flushPromises()

    expect(copySpy).not.toHaveBeenCalled()
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
      ['scenario-temperature', '27'], ['scenario-humidity', '75'],
      ['scenario-rain-rate', '10'], ['scenario-rain-loss', '0.08'],
    ]
    for (const [testId, value] of numericFields) {
      await wrapper.get(`[data-testid="${testId}"] input[type="number"]`).setValue(value)
    }
    await wrapper.get('[data-testid="scenario-multipath"]').trigger('click')

    expect(scenario.draft?.config.scenario).toMatchObject({
      description: '更新后的场景描述',
      startTime: '2026-08-07T01:30:00Z',
      duration: 7230,
      timeStep: 2,
      environment: {
        seaState: 4,
        temperatureC: 27,
        humidityPercent: 75,
        rainRateMmPerHour: 10,
        rainLossDbPerKm: 0.08,
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
    expect(wrapper.text()).toContain('开始时间必须是有效的 RFC 3339 时间。')
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
    expect(wrapper.get('[data-testid="workflow-validation"]').attributes('aria-current')).toBe('step')
    await wrapper.get('[data-testid="locate-validation-issue-0"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="scenario-name"]').exists()).toBe(true)

    const originalWriteInterval = scenario.draft!.config.output.writeInterval
    await wrapper.get('[data-testid="scenario-name"]').setValue('输出间隔定位验证')
    await wrapper.get('[data-testid="scenario-time-step"] input').setValue('6')
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    const outputIssueIndex = scenario.validation.errors.findIndex((issue) => issue.fieldPath === 'output.writeInterval')
    expect(outputIssueIndex).toBeGreaterThanOrEqual(0)
    await wrapper.get(`[data-testid="locate-validation-issue-${outputIssueIndex}"]`).trigger('click')
    await flushPromises()
    expect(scenario.draft?.config.output.writeInterval).toBe(originalWriteInterval)
    expect(scenario.validation.errors.some((issue) => issue.fieldPath === 'output.writeInterval')).toBe(true)
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

    await wrapper.get('[data-testid="validate-scenario"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="validation-panel"]').text()).toContain('错误 1')
    expect(wrapper.get('[data-testid="validation-panel"]').text()).toContain('links[0].txPower')
    expect(wrapper.get('[data-testid="validation-panel"]').text()).toContain('链路发射功率不能小于 0 W。')

    await wrapper.get('[data-testid="locate-validation-issue-0"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="link-dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('链路发射功率不能小于 0 W。')
    expect(document.querySelector('[data-testid="link-power"] input')).not.toBeNull()
    wrapper.unmount()
  })

  it.each(['enabled', 'cooldown', 'priority'])('链路校验问题定位到对应弹框（字段=%s）', async (field) => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS', dirty: true })
    scenario.draft!.config.linkSettings = readLinkSettings(scenario.draft!.config)
    if (field === 'enabled') scenario.draft!.config.links[0]!.enabled = '非法值' as never
    else if (field === 'priority') scenario.draft!.config.linkSettings.priority.pop()
    else scenario.draft!.config.linkSettings.switchCooldownS = -1
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(validationResponse(inspectScenarioConfig(scenario.draft!.config).result)))
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await wrapper.get('[data-testid="validate-scenario"]').trigger('click')
    await flushPromises()
    const fieldPath = field === 'enabled' ? 'links[0].enabled' : field === 'priority' ? 'linkSettings.priority' : 'linkSettings.switchCooldownS'
    expect(wrapper.get('[data-testid="validation-panel"]').text()).toContain(fieldPath)
    await wrapper.get('[data-testid="locate-validation-issue-0"]').trigger('click')
    await flushPromises()
    const dialog = document.querySelector(`[data-testid="${field === 'enabled' ? 'link-dialog' : 'link-settings-dialog'}"]`)
    expect(dialog).not.toBeNull()
    const target = field === 'enabled' ? '[data-testid="link-enabled"] input'
      : field === 'priority' ? '[data-testid="link-priority-0"]' : '[data-testid="link-switch-cooldown"] input'
    expect(dialog!.querySelector(target)).not.toBeNull()
    expect(wrapper.get('#tab-links').attributes('aria-selected')).toBe('true')
    expect(wrapper.find('section[aria-label="链路配置"] > .section-heading [data-testid="open-link-settings"]').exists()).toBe(true)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain('/validate')
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
      currentDraft.config.scenario.environment.rainLossDbPerKm = 0.08
      scenario.$patch({ draft: currentDraft, panelState: 'SUCCESS' })
      vi.stubGlobal('fetch', vi.fn().mockImplementation(failure.reply))
      const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })

      await wrapper.get('[data-testid="validate-scenario"]').trigger('click')
      await flushPromises()

      const panel = wrapper.get('[data-testid="validation-panel"]')
      expect(scenario.validation, failure.name).toEqual({ valid: true, errors: [], warnings: [] })
      expect(panel.get('[data-testid="validation-request-error"]').text(), failure.name).toContain(failure.message)
      expect(panel.find('.el-empty').exists(), failure.name).toBe(false)
      wrapper.unmount()
    }
  })

  it('将平台、干扰和基础问题分别定位到对应编辑区', async () => {
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
        ],
        warnings: [],
      },
    })
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    const openValidationTab = async (): Promise<void> => {
      await wrapper.get('[data-testid="workflow-validation"]').trigger('click')
      await nextTick()
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
    expect(document.activeElement).toBe(document.querySelector('[data-testid="scenario-time-step"] input'))
    wrapper.unmount()
  })

  it('使用平台对话框新增业务信息节点和航点且确认前不污染草稿', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const originalCount = scenario.draft!.config.platforms.length
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })

    expect(wrapper.text()).toContain('信息节点 6 / 50')
    expect(wrapper.text()).toContain('节点类型 4 / 4')
    expect(wrapper.text()).toContain('支撑实体 2')
    await wrapper.get('[data-testid="add-business-platform"]').trigger('click')
    await nextTick()
    expect(scenario.draft?.config.platforms).toHaveLength(originalCount)
    const nameInput = document.querySelector<HTMLInputElement>('[data-testid="platform-name"]')!
    nameInput.value = '新增空中无人作业集群'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLElement>('[data-testid="add-waypoint"]')!.click()
    await flushPromises()
    expect(document.querySelector('[data-testid="waypoint-table"]')?.textContent).toContain('经度')
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await nextTick()

    expect(document.body.textContent).toContain('场景实体已新增，保存草稿后生效。')
    expect(wrapper.find('[aria-label="平台与航点"] .platform-feedback').exists()).toBe(false)
    expect(scenario.draft?.config.platforms).toHaveLength(originalCount + 1)
    expect(scenario.draft?.config.platforms.at(-1)).toMatchObject({
      name: '新增空中无人作业集群',
      type: 'AIRBORNE_MISSION_CLUSTER',
      waypoints: [{ longitude: 0, latitude: 0, altitude: 0, speed: 0, arrivalTime: 0 }],
    })
    expect(scenario.dirty).toBe(true)
    wrapper.unmount()
  })

  it('新增和编辑场景实体时通过地图选点回填航点并将高度设为零', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, {
      attachTo: document.body,
      global: {
        plugins: [pinia, ElementPlus],
        stubs: {
          WaypointMapPicker: {
            props: ['modelValue', 'longitude', 'latitude'],
            emits: ['update:modelValue', 'confirm'],
            template: '<button v-if="modelValue" data-testid="confirm-map-point" @click="$emit(\'confirm\', { longitude: 120.654321, latitude: 24.456789 })">确认模拟选点</button>',
          },
        },
      },
    })

    await wrapper.get('[data-testid="add-business-platform"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLElement>('[data-testid="add-waypoint"]')!.click()
    await nextTick()
    const newAltitude = wrapper.findAllComponents({ name: 'ElInputNumber' })
      .find((component) => component.attributes('data-testid') === 'waypoint-altitude-0')!
    newAltitude.vm.$emit('update:modelValue', 1500)
    document.querySelector<HTMLElement>('[data-testid="pick-waypoint-0"]')!.click()
    await nextTick()
    await wrapper.get('[data-testid="confirm-map-point"]').trigger('click')
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()

    expect(scenario.draft?.config.platforms.at(-1)?.waypoints[0]).toMatchObject({
      longitude: 120.654321,
      latitude: 24.456789,
      altitude: 0,
    })

    await wrapper.get('#tab-platforms').trigger('click')
    await nextTick()
    await wrapper.get('[data-testid="edit-platform-3"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="pick-waypoint-0"]')).not.toBeNull()
    document.querySelector<HTMLElement>('[data-testid="pick-waypoint-0"]')!.click()
    await nextTick()
    await wrapper.get('[data-testid="confirm-map-point"]').trigger('click')
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()

    expect(scenario.draft?.config.platforms[3]?.waypoints[0]).toMatchObject({
      longitude: 120.654321,
      latitude: 24.456789,
      altitude: 0,
    })
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
    await wrapper.get('[data-testid="add-business-platform"]').trigger('click')

    expect(scenario.draft?.config.platforms).toHaveLength(50)
    expect(document.body.textContent).toContain('信息节点已达 50 个，不能继续新增。')
  })

  it('按剩余数量批量新增空中无人作业集群并阻止类型超额', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })

    await wrapper.get('[data-testid="add-business-platform"]').trigger('click')
    await flushPromises()
    const quantity = wrapper.findAllComponents({ name: 'ElInputNumber' })
      .find((component) => component.attributes('data-testid') === 'platform-quantity')!
    expect(quantity.props('max')).toBe(44)
    quantity.vm.$emit('update:modelValue', 44)
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()

    const businessNodes = scenario.draft!.config.platforms.filter((platform) => isBusinessInformationNodeType(platform.type))
    expect(businessNodes).toHaveLength(50)
    expect(businessNodes.filter((platform) => platform.type === 'AIRBORNE_MISSION_CLUSTER')).toHaveLength(47)
    expect(new Set(scenario.draft!.config.platforms.map((platform) => platform.id)).size).toBe(scenario.draft!.config.platforms.length)
    expect(wrapper.text()).toContain('信息节点 50 / 50')

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
    await wrapper.get('[data-testid="workflow-config"]').trigger('click')
    await wrapper.get('#tab-platforms').trigger('click')
    await wrapper.get(`[data-testid="edit-platform-${index}"]`).trigger('click')
    await flushPromises()
    const satellite = wrapper.findAllComponents({ name: 'ElSelect' }).find((component) => component.attributes('data-testid') === 'platform-satellite-type')!
    expect(satellite.props('modelValue')).toBeUndefined()
    expect(scenario.draft!.config.platforms[index]!.satelliteType).toBeUndefined()
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('请选择天通卫星或神通卫星。')
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

    await wrapper.get('[data-testid="add-supporting-platform"]').trigger('click')
    await flushPromises()
    const satelliteSelect = wrapper.findAllComponents({ name: 'ElSelect' })
      .find((component) => component.attributes('data-testid') === 'platform-satellite-type')!
    expect(satelliteSelect.props('modelValue')).toBe('SHENTONG')
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.platforms.at(-1)).toMatchObject({
      type: 'COMMUNICATION_SATELLITE',
      satelliteType: 'SHENTONG',
    })
    expect(wrapper.text()).toContain('神通卫星')

    await wrapper.get('[data-testid="add-supporting-platform"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('神通卫星当前场景只能配置 1 个')
    wrapper.unmount()
  })

  it('编辑平台、删除航点并覆盖全部对话框字段绑定', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })

    await wrapper.get('#tab-platforms').trigger('click')
    await nextTick()
    await wrapper.get('[data-testid="edit-platform-3"]').trigger('click')
    await flushPromises()
    const linkIds = document.querySelector<HTMLInputElement>('[data-testid="platform-link-ids"]')!
    expect(linkIds.readOnly).toBe(true)
    expect(linkIds.value).toContain('L-MW-05')
    const jammerIds = document.querySelector<HTMLInputElement>('[data-testid="platform-jammer-ids"]')!
    expect(jammerIds.readOnly).toBe(true)
    document.querySelector<HTMLElement>('[data-testid="delete-waypoint-0"]')!.click()
    const editName = document.querySelector<HTMLInputElement>('[data-testid="platform-name"]')!
    editName.value = '空中无人作业集群（编辑）'
    editName.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLElement>('[data-testid="apply-platform"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.platforms[3]).toMatchObject({ name: '空中无人作业集群（编辑）', waypoints: [] })

    await wrapper.get('[data-testid="add-supporting-platform"]').trigger('click')
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

  it('选择信道编码后点击清空，确认、保存和重新加载均保持 null', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    const scenario = useScenarioStore(pinia)
    let persisted = draft()
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
    await wrapper.get('#tab-links').trigger('click')
    await wrapper.get('[data-testid="edit-link-0"]').trigger('click')
    await flushPromises()
    const coding = wrapper.findAllComponents({ name: 'ElSelect' }).find(c => c.attributes('data-testid') === 'link-coding')!
    await coding.get('.el-select__wrapper').trigger('click')
    await flushPromises()
    Array.from(document.querySelectorAll<HTMLElement>('.el-select-dropdown__item')).find(option => option.textContent === '无编码')!.click()
    await flushPromises()
    expect(coding.props('modelValue')).toBe('UNCODED')
    await coding.trigger('mouseenter')
    await coding.get('.el-select__clear').trigger('click')
    await flushPromises()
    expect(coding.props('modelValue')).toBe('')
    document.querySelector<HTMLElement>('[data-testid="apply-link"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.links[0]?.coding).toBeNull()
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    expect(fetchSpy.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true)
    expect(persisted.config.links[0]?.coding).toBeNull()
    expect(scenario.dirty).toBe(false)
    expect(await scenario.loadScenario()).toBe(true)
    expect(scenario.draft?.config.links[0]?.coding).toBeNull()
    await wrapper.get('[data-testid="edit-link-0"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAllComponents({ name: 'ElSelect' }).find(c => c.attributes('data-testid') === 'link-coding')!.props('modelValue')).toBe('')
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
    expect(wrapper.text()).toContain('已配置 4 / 4 类')
    const originalCount = scenario.draft!.config.links.length
    await wrapper.get('[data-testid="add-link"]').trigger('click')
    await flushPromises()
    const select = (testId: string) => wrapper.findAllComponents({ name: 'ElSelect' })
      .find((component) => component.attributes('data-testid') === testId)!
    const inputNumber = (testId: string) => wrapper.findAllComponents({ name: 'ElInputNumber' })
      .find((component) => component.attributes('data-testid') === testId)!
    expect(inputNumber('link-frequency').props()).toMatchObject({ min: Number.MIN_VALUE, step: LINK_MHZ_MINIMUM_STEP })
    expect(inputNumber('link-bandwidth').props()).toMatchObject({ min: Number.MIN_VALUE, step: LINK_MHZ_MINIMUM_STEP })
    document.querySelector<HTMLElement>('[data-testid="link-enabled"]')!.click()
    await nextTick()
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
    select('link-type').vm.$emit('update:modelValue', 'LASER')
    select('link-source').vm.$emit('update:modelValue', 'CMD-01')
    select('link-target').vm.$emit('update:modelValue', 'UAV-01')
    select('link-modulation').vm.$emit('update:modelValue', 'BPSK')
    select('link-direction').vm.$emit('update:modelValue', 'REVERSE')
    inputNumber('link-bandwidth').vm.$emit('input', 1000)
    inputNumber('link-bandwidth').vm.$emit('update:modelValue', 1000)
    inputNumber('link-power').vm.$emit('update:modelValue', 20)
    inputNumber('link-data-rate').vm.$emit('update:modelValue', 100)
    inputNumber('link-tx-gain').vm.$emit('update:modelValue', 30)
    inputNumber('link-rx-gain').vm.$emit('update:modelValue', 30)
    inputNumber('link-ber-threshold').vm.$emit('update:modelValue', 0.000001)
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
    select('link-target').vm.$emit('update:modelValue', 'AIR-03')
    document.querySelector<HTMLElement>('[data-testid="apply-link"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.links[0]?.targetPlatformId).toBe('AIR-03')
    expect(messageSpy).toHaveBeenLastCalledWith('链路已更新，保存草稿后生效。')
    expect(scenario.draft?.config.links[0]?.enabled).toBe(true)
    expect(scenario.draft?.config.links.at(-1)?.enabled).toBe(false)
    expect(scenario.draft?.config.platforms.find((platform) => platform.id === 'GCC-01')?.linkIds).not.toContain('L-MW-01')
    expect(scenario.draft?.config.platforms.find((platform) => platform.id === 'AIR-03')?.linkIds).toContain('L-MW-01')

    await wrapper.get('[data-testid="delete-link-0"]').trigger('click')
    await nextTick()
    expect(scenario.draft?.config.links.some((link) => link.id === 'L-MW-01')).toBe(false)
    expect(messageSpy).toHaveBeenLastCalledWith('链路已删除，保存草稿后生效。')
    expect(messageSpy).toHaveBeenCalledTimes(3)
    expect(scenario.draft?.config.platforms.every((platform) => !platform.linkIds.includes('L-MW-01'))).toBe(true)
    wrapper.unmount()
  })

  it('场景实体不足时以浮层消息提示，且不打开链路或干扰弹框', async () => {
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

    expect(messageSpy).toHaveBeenCalledExactlyOnceWith('至少需要两个场景实体才能新增链路。')
    expect(wrapper.find('.platform-feedback').exists()).toBe(false)
    expect(document.querySelector('[data-testid="link-dialog"]')).toBeNull()

    scenario.draft!.config.platforms = []
    await wrapper.get('#tab-jammers').trigger('click')
    await wrapper.get('[data-testid="add-jammer"]').trigger('click')
    await nextTick()
    expect(messageSpy).toHaveBeenLastCalledWith('至少需要一个场景实体才能新增干扰设备。')
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
    const autoDetect = wrapper.findAllComponents({ name: 'ElSwitch' })
      .find((component) => component.attributes('data-testid') === 'jammer-auto-detect')!
    expect(inputNumber('jammer-frequency').props()).toMatchObject({ min: Number.MIN_VALUE, step: LINK_MHZ_MINIMUM_STEP })
    expect(inputNumber('jammer-bandwidth').props()).toMatchObject({ min: Number.MIN_VALUE, step: LINK_MHZ_MINIMUM_STEP })

    inputNumber('jammer-frequency').vm.$emit('input', 0)
    inputNumber('jammer-frequency').vm.$emit('update:modelValue', LINK_MHZ_MINIMUM_STEP)
    document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.jammers).toHaveLength(originalCount)
    expect(document.body.textContent).toContain('干扰频率必须大于 0 MHz。')

    select('jammer-type').vm.$emit('update:modelValue', 'SPOT')
    select('jammer-platform').vm.$emit('update:modelValue', 'CMD-01')
    autoDetect.vm.$emit('update:modelValue', true)
    inputNumber('jammer-power').vm.$emit('update:modelValue', 60)
    inputNumber('jammer-range').vm.$emit('update:modelValue', 24)
    inputNumber('jammer-frequency').vm.$emit('input', 3200)
    inputNumber('jammer-frequency').vm.$emit('update:modelValue', 3200)
    inputNumber('jammer-bandwidth').vm.$emit('input', 0)
    inputNumber('jammer-bandwidth').vm.$emit('update:modelValue', LINK_MHZ_MINIMUM_STEP)
    document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.jammers).toHaveLength(originalCount)
    expect(document.body.textContent).toContain('干扰带宽必须大于 0 MHz。')
    inputNumber('jammer-direction').vm.$emit('update:modelValue', 270)
    inputNumber('jammer-duration').vm.$emit('update:modelValue', 90)
    wrapper.findAllComponents({ name: 'ElSwitch' })
      .find((component) => component.attributes('data-testid') === 'jammer-enabled')!
      .vm.$emit('update:modelValue', false)
    inputNumber('jammer-frequency').vm.$emit('input', undefined)
    inputNumber('jammer-bandwidth').vm.$emit('input', 15)
    inputNumber('jammer-bandwidth').vm.$emit('update:modelValue', 15)
    inputNumber('jammer-bandwidth').vm.$emit('input', undefined)
    document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
    await flushPromises()

    expect(scenario.draft?.config.jammers).toHaveLength(originalCount + 1)
    expect(messageSpy).toHaveBeenCalledExactlyOnceWith('干扰设备已新增，保存草稿后生效。')
    expect(wrapper.find('.platform-feedback').exists()).toBe(false)
    expect(scenario.draft?.config.jammers.at(-1)).toEqual({
      id: 'JAM-CFG-001',
      platformId: 'CMD-01',
      type: 'SPOT',
      defaultPower: 60,
      frequency: 3200,
      bandwidth: 15,
      autoDetect: true,
      detectionRange: 44448,
      triggerTimeS: 300,
    })
    expect(scenario.draft?.config.platforms.find((platform) => platform.id === 'CMD-01')?.jammerIds).toContain('JAM-CFG-001')
    expect(scenario.draft?.uiExtensions.jammers.find((extension) => extension.jammerId === 'JAM-CFG-001')).toEqual({
      jammerId: 'JAM-CFG-001',
      direction: 270,
      duration: 90,
      enabled: false,
    })

    wrapper.findAllComponents({ name: 'ElSwitch' })
      .find((component) => component.attributes('data-testid') === 'toggle-jammer-JAM-SPOT-01-TX')!
      .vm.$emit('update:modelValue', true)
    await nextTick()
    expect(scenario.draft?.uiExtensions.jammers.find((extension) => extension.jammerId === 'JAM-WB-01-TX')?.enabled).toBe(true)
    expect(scenario.draft?.uiExtensions.jammers.find((extension) => extension.jammerId === 'JAM-SPOT-01-TX')?.enabled).toBe(true)

    await wrapper.get('[data-testid="edit-jammer-0"]').trigger('click')
    await flushPromises()
    select('jammer-platform').vm.$emit('update:modelValue', 'AIR-01')
    document.querySelector<HTMLElement>('[data-testid="apply-jammer"]')!.click()
    await flushPromises()
    expect(scenario.draft?.config.jammers[0]?.platformId).toBe('AIR-01')
    expect(messageSpy).toHaveBeenLastCalledWith('干扰设备已更新，保存草稿后生效。')
    expect(scenario.draft?.config.platforms.find((platform) => platform.id === 'STN-01')?.jammerIds).not.toContain('JAM-WB-01-TX')
    expect(scenario.draft?.config.platforms.find((platform) => platform.id === 'AIR-01')?.jammerIds).toContain('JAM-WB-01-TX')

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

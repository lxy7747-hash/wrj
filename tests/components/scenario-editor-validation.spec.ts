import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toRaw } from 'vue'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ScenarioConfig, ScenarioDraft } from '../../src/contracts/domain-models'
import ScenariosPage from '../../src/pages/scenarios/scenarios.vue'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'

enableAutoUnmount(afterEach)
afterEach(() => { ElMessage.closeAll(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

function expectValidationMessage(message: string): void {
  expect(document.querySelector('.el-message-box')).toBeNull()
  const messages = document.querySelectorAll('.el-message--warning')
  expect(messages.item(messages.length - 1)?.textContent).toContain(message)
}

async function loadPage() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ principal: {
    userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR',
    permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'],
  }, role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'] })
  const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
  const current: ScenarioDraft = { config, revision: 4, locked: false, officialLibraryChanged: false,
    uiExtensions: {
      jammers: config.jammers.map(jammer => ({ jammerId: jammer.id, direction: 0, duration: 60, enabled: true })),
      sensors: config.sensors.map(sensor => ({ sensorId: sensor.id, type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true })),
    },
  }
  const fetch = vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ ok: true, data: structuredClone(current) }) }))
  vi.stubGlobal('fetch', fetch)
  const wrapper = mount(ScenariosPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
  await flushPromises()
  const store = useScenarioStore()
  expect(store.draft?.config.scenario.id).toBe(current.config.scenario.id)
  const select = (id: string, value: string) => {
    const control = wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === id)!
    control.vm.$emit('update:modelValue', value)
    control.vm.$emit('change', value)
  }
  const number = (id: string, value: number | undefined) => {
    wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === id)!.vm.$emit('update:modelValue', value)
  }
  const confirm = async (id: string) => {
    document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click()
    await flushPromises()
  }
  return { wrapper, store, fetch, select, number, confirm }
}

describe('场景实体弹框确认校验', () => {
  it('切换页签只挂载当前列表，传感器数字输入保留实例及待修正值', async () => {
    const { wrapper, store } = await loadPage()
    for (const [tab, table] of [['platforms', 'platform-table'], ['links', 'link-table'], ['jammers', 'jammer-table']] as const) {
      expect(wrapper.find(`[data-testid="${table}"]`).exists()).toBe(false)
      await wrapper.get(`#tab-${tab}`).trigger('click')
      await flushPromises()
      expect(wrapper.find(`[data-testid="${table}"]`).exists()).toBe(true)
      await wrapper.get('#tab-scenario').trigger('click')
      expect(wrapper.find(`[data-testid="${table}"]`).exists()).toBe(false)
    }
    await wrapper.get('#tab-data').trigger('click')
    await flushPromises()
    const frequency = wrapper.findAllComponents({ name: 'ElInputNumber' })
      .find(item => item.attributes('data-testid') === 'sensor-frequency-min-0')!
    await frequency.get('input').setValue('')
    await frequency.get('input').trigger('blur')
    await flushPromises()
    expect(store.draft!.config.sensors[0]!.frequencyRange.min).toBeNull()
    const before = structuredClone(toRaw(store.draft!))
    await wrapper.get('#tab-links').trigger('click')
    await wrapper.get('#tab-data').trigger('click')
    await flushPromises()
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' })
      .find(item => item.attributes('data-testid') === 'sensor-frequency-min-0')!.vm).toBe(frequency.vm)
    expect(store.draft).toEqual(before)
  })

  it.each(['source', 'target'])('卫星链路两端非卫星时阻止新增；选择%s端卫星后才写入草稿，编辑同样校验', async endpoint => {
    const { wrapper, store, fetch, select, confirm } = await loadPage()
    const original = structuredClone(toRaw(store.draft!))
    await wrapper.get('#tab-links').trigger('click')
    await wrapper.get('[data-testid="add-link"]').trigger('click')
    await flushPromises()
    select('link-type', 'SAT')
    await flushPromises()
    await confirm('apply-link')
    expect(wrapper.findComponent({ name: 'LinkEditorDialog' }).props('modelValue')).toBe(true)
    expectValidationMessage('卫星链路的源平台或目标平台至少有一端必须选择通信卫星。')
    expect(document.querySelector('.el-message--warning .el-message__closeBtn')).not.toBeNull()
    expect(wrapper.findComponent({ name: 'LinkEditorDialog' }).props('error')).toBe('')
    expect(store.draft).toEqual(original)
    expect(store.dirty).toBe(false)

    select(`link-${endpoint}`, 'SAT-01')
    await flushPromises()
    await confirm('apply-link')
    expect(wrapper.findComponent({ name: 'LinkEditorDialog' }).props('modelValue')).toBe(false)
    expect(store.draft!.config.links.at(-1)).toMatchObject({ type: 'SAT', [`${endpoint}PlatformId`]: 'SAT-01' })
    const added = structuredClone(toRaw(store.draft!))
    const index = store.draft!.config.links.length - 1
    await wrapper.get(`[data-testid="edit-link-${index}"]`).trigger('click')
    await flushPromises()
    select(`link-${endpoint}`, endpoint === 'source' ? 'CMD-01' : 'UAV-01')
    await flushPromises()
    await confirm('apply-link')
    expect(wrapper.findComponent({ name: 'LinkEditorDialog' }).props('modelValue')).toBe(true)
    expect(store.draft).toEqual(added)
    expect(fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })

  it('非卫星链路仍可连接两个普通节点，确认不自动保存到服务端', async () => {
    const { wrapper, store, fetch, confirm } = await loadPage()
    const count = store.draft!.config.links.length
    await wrapper.get('#tab-links').trigger('click')
    await wrapper.get('[data-testid="add-link"]').trigger('click')
    await flushPromises()
    await confirm('apply-link')
    expect(store.draft!.config.links).toHaveLength(count + 1)
    expect(store.draft!.config.links.at(-1)).toMatchObject({ type: 'MICROWAVE', sourcePlatformId: 'CMD-01', targetPlatformId: 'UAV-01' })
    expect(fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })

  it('节点初始位置缺失、航点速度无效或到达时间超长均在确认时阻止；修正后才新增', async () => {
    const { wrapper, store, fetch, number, confirm } = await loadPage()
    const original = structuredClone(toRaw(store.draft!))
    await wrapper.get('#tab-platforms').trigger('click')
    await wrapper.get('[data-testid="add-platform"]').trigger('click')
    await flushPromises()
    number('platform-longitude', undefined)
    await flushPromises()
    await confirm('apply-platform')
    expectValidationMessage('经度必须在 -180 至 180 之间。')
    expect(store.draft).toEqual(original)
    number('platform-longitude', 120)
    document.querySelector<HTMLElement>('[data-testid="add-waypoint"]')!.click()
    await flushPromises()
    await confirm('apply-platform')
    expectValidationMessage('航点速度必填且必须大于 0 m/s')
    expect(store.draft).toEqual(original)
    number('waypoint-speed-0', 20)
    number('waypoint-arrival-0', original.config.scenario.duration + 1)
    await flushPromises()
    await confirm('apply-platform')
    expectValidationMessage('航点到达时间不能超过场景仿真时长。')
    expect(store.draft).toEqual(original)
    expect(store.dirty).toBe(false)
    number('waypoint-arrival-0', 10)
    await flushPromises()
    await confirm('apply-platform')
    expect(wrapper.findComponent({ name: 'PlatformEditorDialog' }).props('modelValue')).toBe(false)
    expect(store.draft!.config.platforms).toHaveLength(original.config.platforms.length + 1)
    expect(fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })

  it('干扰设备缺少归属、功率或范围/触发时间异常均在确认时阻止，修正后才新增', async () => {
    const { wrapper, store, fetch, select, number, confirm } = await loadPage()
    const original = structuredClone(toRaw(store.draft!))
    await wrapper.get('#tab-jammers').trigger('click')
    await wrapper.get('[data-testid="add-jammer"]').trigger('click')
    await flushPromises()
    await confirm('apply-jammer')
    expectValidationMessage('干扰设备必须归属于当前场景实体。')
    expect(store.draft).toEqual(original)
    select('jammer-platform', 'STN-01')
    number('jammer-power', undefined)
    await flushPromises()
    await confirm('apply-jammer')
    expectValidationMessage('默认功率必须大于 0 W。')
    expect(store.draft).toEqual(original)
    number('jammer-power', 200)
    number('jammer-range', 101)
    await flushPromises()
    await confirm('apply-jammer')
    expectValidationMessage('干扰探测范围必须在 1～100 km 之间。')
    expect(store.draft).toEqual(original)
    number('jammer-range', 24)
    number('jammer-jamming-range', 101)
    await flushPromises()
    await confirm('apply-jammer')
    expectValidationMessage('干扰范围必须在 1～100 km 之间。')
    expect(store.draft).toEqual(original)
    number('jammer-jamming-range', 24)
    number('jammer-trigger-time', original.config.scenario.duration + 1)
    await flushPromises()
    await confirm('apply-jammer')
    expectValidationMessage('干扰触发时间须在 0 秒至仿真总时长之间。')
    expect(store.draft).toEqual(original)
    expect(store.dirty).toBe(false)
    number('jammer-trigger-time', 10)
    await flushPromises()
    await confirm('apply-jammer')
    expect(wrapper.findComponent({ name: 'JammerEditorDialog' }).props('modelValue')).toBe(false)
    expect(store.draft!.config.jammers).toHaveLength(original.config.jammers.length + 1)
    expect(fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })
})

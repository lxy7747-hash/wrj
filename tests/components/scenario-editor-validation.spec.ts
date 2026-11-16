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
import { readDeviceParameters } from '../../src/features/scenarios/template-defaults'

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
  Object.assign(config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
  const current: ScenarioDraft = { config, revision: 4, locked: false, officialLibraryChanged: false,
    uiExtensions: {
      jammers: config.jammers.map(jammer => ({ jammerId: jammer.id, direction: 0, enabled: true })),
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

describe('节点弹框确认校验', () => {
  it('定位折叠区内的历史端口错误会展开高级区并切换到对应平台', async () => {
    const { wrapper, store } = await loadPage()
    const parameters = readDeviceParameters({})
    parameters.ports.TIAN_TONG_SAT!.sat_link!.eirpDbw = Number.NaN
    store.draft!.config.deviceParameters = parameters
    store.markDirty()
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '定位首个问题')!.trigger('click')
    await flushPromises()
    expect((wrapper.get('[data-testid="scenario-device-advanced"]').element as HTMLDetailsElement).open).toBe(true)
    const input = wrapper.get('[data-testid="port-TIAN_TONG_SAT-sat_link-eirpDbw"] input')
    await vi.waitFor(() => expect(document.activeElement).toBe(input.element))
    expect(store.draft!.config.deviceParameters!.ports!.TIAN_TONG_SAT!.sat_link!.eirpDbw).toBeNaN()
  })

  it('参数入口合并后折叠和切换不改草稿，隐藏的历史值与传感器配置保留', async () => {
    const { wrapper, store } = await loadPage()
    const original = structuredClone(toRaw(store.draft!))
    expect(wrapper.find('#tab-devices').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scenario-trans-distance"]').exists()).toBe(false)
    await wrapper.get('#tab-links').trigger('click')
    await flushPromises()
    const advanced = wrapper.get('[data-testid="scenario-device-advanced"]').element as HTMLDetailsElement
    expect(advanced.open).toBe(false)
    advanced.open = true
    await wrapper.get('#tab-data').trigger('click')
    await flushPromises()
    const planning = wrapper.get('[data-testid="sensor-planning-0"]').element as HTMLDetailsElement
    expect(planning.open).toBe(false)
    planning.open = true
    await wrapper.get('#tab-scenario').trigger('click')
    await flushPromises()
    expect(store.draft).toEqual(original)
    expect(store.dirty).toBe(false)
  })

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
    expectValidationMessage('卫星链路的一端或中继须选择通信卫星。')
    expect(document.querySelector('.el-message--warning .el-message__closeBtn')).not.toBeNull()
    expect(wrapper.findComponent({ name: 'LinkEditorDialog' }).props('error')).toBe('')
    expect(store.draft).toEqual(original)
    expect(store.dirty).toBe(false)

    select(`link-${endpoint}`, 'SAT-01')
    // 新模板卫通端口为“后方指挥节点 ↔ 卫星”：卫星作源端时目标改为后方节点。
    if (endpoint === 'source') select('link-target', 'CMD-01')
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

  it('节点初始位置缺失或航点速度无效均在确认时阻止；修正后才新增', async () => {
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
    number('waypoint-speed-0', undefined)
    await flushPromises()
    await confirm('apply-platform')
    expectValidationMessage('航点速度必填且必须至少为 1 m/s')
    expect(store.draft).toEqual(original)
    expect(store.dirty).toBe(false)
    number('waypoint-speed-0', 20)
    await flushPromises()
    await confirm('apply-platform')
    expect(wrapper.findComponent({ name: 'PlatformEditorDialog' }).props('modelValue')).toBe(false)
    expect(store.draft!.config.platforms).toHaveLength(original.config.platforms.length + 1)
    expect(fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })

  it('新增盘旋和开启返航不提前报错，确认后定位错误，逐项修正即时消失', async () => {
    const { wrapper, store, fetch, number, confirm } = await loadPage()
    const original = structuredClone(toRaw(store.draft!))
    await wrapper.get('#tab-platforms').trigger('click')
    await wrapper.get('[data-testid="edit-platform-3"]').trigger('click')
    await flushPromises()
    const dialog = wrapper.findComponent({ name: 'PlatformEditorDialog' })
    const click = async (id: string) => {
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click()
      await flushPromises()
    }
    const listError = (list: string) => document.querySelector(`[data-testid="${list}-list-error"]`)
    const fieldError = (id: string) => document.querySelector(`[data-testid="${id}"]`)!
      .closest('.el-form-item')!.querySelector('.el-form-item__error')?.textContent ?? ''

    await click('add-loiter-waypoint')
    await click('return-enabled')
    expect(listError('loiter')).toBeNull()
    expect(listError('return')).toBeNull()
    expect(fieldError('return-time')).toBe('')
    // 编辑当前字段才显示该字段错误，仍不提前报整条路线的点数不足。
    number('return-time', 0)
    await vi.waitFor(() => expect(fieldError('return-time')).toContain('返航时刻必须大于 0'))
    expect(listError('loiter')).toBeNull()
    expect(listError('return')).toBeNull()
    number('return-time', undefined)
    await confirm('apply-platform')
    expect(dialog.props('modelValue')).toBe(true)
    expect(store.draft).toEqual(original)
    expect(listError('loiter')?.textContent).toContain('至少需要两个位置点')
    expect(listError('return')?.textContent).toContain('至少需要一个位置点')
    expect(fieldError('return-time')).toContain('返航时刻必须大于 0')

    await click('add-loiter-waypoint')
    expect(listError('loiter')).toBeNull()
    expect(listError('return')).not.toBeNull()
    expect(fieldError('return-time')).toContain('返航时刻必须大于 0')
    number('return-time', original.config.scenario.duration)
    await vi.waitFor(() => expect(fieldError('return-time')).toContain('早于仿真结束时刻'))
    number('return-time', original.config.scenario.duration / 2)
    await vi.waitFor(() => expect(fieldError('return-time')).toBe(''))
    expect(listError('return')).not.toBeNull()
    await click('add-return-waypoint')
    expect(listError('return')).toBeNull()

    number('return-speed-0', undefined)
    await vi.waitFor(() => expect(fieldError('return-speed-0')).not.toBe(''))
    await confirm('apply-platform')
    expect(dialog.props('modelValue')).toBe(true)
    expect(store.draft).toEqual(original)
    number('return-speed-0', 1)
    await vi.waitFor(() => expect(fieldError('return-speed-0')).toBe(''))
    expect(store.draft).toEqual(original)
    await confirm('apply-platform')
    expect(dialog.props('modelValue')).toBe(false)
    expect(store.draft!.config.platforms[3]!.loiterWaypoints).toHaveLength(2)
    expect(store.draft!.config.platforms[3]!.returnPlan).toMatchObject({
      timeS: original.config.scenario.duration / 2, waypoints: [expect.objectContaining({ speed: 1 })],
    })
    expect(fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })

  it('干扰设备缺少归属、功率或范围/触发时间异常均在确认时阻止，修正后才新增', async () => {
    const { wrapper, store, fetch, select, number, confirm } = await loadPage()
    // 每个干扰节点只允许一台干扰设备：新增设备挂到尚无设备的机载干扰平台。
    const station = store.draft!.config.platforms.find(platform => platform.id === 'STN-01')!
    store.draft!.config.platforms.push({ ...structuredClone(toRaw(station)), id: 'AJ-T01', name: '机载干扰平台', type: 'AIRBORNE_JAMMER_PLATFORM', category: 'air', jammerIds: [], sensorIds: [] })
    const original = structuredClone(toRaw(store.draft!))
    await wrapper.get('#tab-jammers').trigger('click')
    await wrapper.get('[data-testid="add-jammer"]').trigger('click')
    await flushPromises()
    await confirm('apply-jammer')
    expectValidationMessage('干扰设备必须归属于当前节点。')
    expect(store.draft).toEqual(original)
    select('jammer-platform', 'AJ-T01')
    number('jammer-power', undefined)
    await flushPromises()
    await confirm('apply-jammer')
    expect(store.draft).toEqual(original)
    number('jammer-power', 30)
    number('jammer-range', 101)
    await flushPromises()
    await confirm('apply-jammer')
    expectValidationMessage('干扰探测范围必须在 1～100 km 之间。')
    expect(store.draft).toEqual(original)
    number('jammer-range', 24)
    number('jammer-jamming-range', 101)
    await flushPromises()
    await confirm('apply-jammer')
    expectValidationMessage('干扰范围必须在 0～100 km 之间，0 表示不触发。')
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


describe('5.2.2 输入时字段下即时校验', () => {
  function errorFor(id: string): string {
    return document.querySelector(`[data-testid="${id}"]`)?.closest('.el-form-item')
      ?.querySelector('.el-form-item__error')?.textContent ?? ''
  }

  async function input(id: string, value: string) {
    const element = document.querySelector<HTMLInputElement>(`[data-testid="${id}"] input`)
    expect(element).not.toBeNull()
    element!.value = value
    element!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 120))
  }

  it('隐藏的旧参数异常时显示修复入口，其他环境字段仍即时校验', async () => {
    const { store, wrapper } = await loadPage()
    expect(wrapper.find('[data-testid="scenario-trans-distance"]').exists()).toBe(false)
    store.draft!.config.scenario.environment.transmissionDistance = 500
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(errorFor('scenario-trans-distance')).toContain('150～410')
    await input('scenario-trans-distance', '200')
    expect(errorFor('scenario-trans-distance')).toBe('')
    expect(wrapper.find('[data-testid="scenario-trans-distance"]').exists()).toBe(false)
    expect(store.draft!.config.scenario.environment.transmissionDistance).toBe(200)
    await input('scenario-env-rainAltitudeLimitM', '30001')
    expect(errorFor('scenario-env-rainAltitudeLimitM')).toContain('30000')
    await input('scenario-env-rainAltitudeLimitM', '1000')
    expect(errorFor('scenario-env-rainAltitudeLimitM')).toBe('')
  })

  it('干扰范围和功率越界未确认即红字，修正清除，取消不写入草稿', async () => {
    const { wrapper, store, confirm } = await loadPage()
    const original = structuredClone(toRaw(store.draft!))
    await wrapper.get('#tab-jammers').trigger('click')
    await wrapper.get('[data-testid="edit-jammer-0"]').trigger('click')
    await flushPromises()
    await input('jammer-range', '101')
    expect(errorFor('jammer-range')).toContain('1～100 km')
    expect(store.draft).toEqual(original)
    await input('jammer-range', '80')
    expect(errorFor('jammer-range')).toBe('')
    await input('jammer-power', '2')
    expect(errorFor('jammer-power')).toContain('-10～30 dBm')
    await input('jammer-power', '30')
    expect(errorFor('jammer-power')).toBe('')
    await confirm('cancel-jammer')
    expect(store.draft).toEqual(original)
  })

  it('编辑冲突两端中任意链路即时提示频段警告，修正消失且草稿未变', async () => {
    const { wrapper, store, confirm } = await loadPage()
    const original = structuredClone(toRaw(store.draft!))
    // L-DL-06（数传）与 L-MW-05（微波）都到达 AIR-01：把数传频率调到微波频点即同频互扰。
    const index = store.draft!.config.links.findIndex(link => link.id === 'L-DL-06')
    const microwave = store.draft!.config.links.find(link => link.id === 'L-MW-05')!
    await wrapper.get('#tab-links').trigger('click')
    await wrapper.get(`[data-testid="edit-link-${index}"]`).trigger('click')
    await flushPromises()
    await input('link-frequency', String(microwave.frequency))
    expect(errorFor('link-frequency')).toContain('警告：')
    expect(errorFor('link-frequency')).toContain('同频互扰')
    expect(store.draft).toEqual(original)
    await input('link-frequency', String(original.config.links[index]!.frequency))
    expect(errorFor('link-frequency')).toBe('')
    await confirm('cancel-link')
    expect(store.draft).toEqual(original)
  })

  it('传感器清空必填/负值和原生ESM参数实时定位对应字段', async () => {
    const { wrapper, store } = await loadPage()
    const sensorId = store.draft!.config.sensors[0]!.id
    await wrapper.get('#tab-data').trigger('click')
    await flushPromises()
    await input('sensor-frequency-min-0', '')
    expect(errorFor('sensor-frequency-min-0')).toContain('最低频率必须大于 0')
    await input('sensor-frequency-min-0', '2000')
    expect(errorFor('sensor-frequency-min-0')).toBe('')
    await input('sensor-probability-0', '')
    expect(errorFor('sensor-probability-0')).toContain('0 至 1')
    await input('sensor-probability-0', '0.5')
    expect(errorFor('sensor-probability-0')).toBe('')
    store.draft!.uiExtensions.sensors[0]!.esm = { sensitivityDbw: -200, detectionThresholdDb: 0, dwellTimeS: 1, revisitTimeS: 1 }
    await flushPromises()
    await input(`native-esm-dwell-${sensorId}`, '0')
    expect(errorFor(`native-esm-dwell-${sensorId}`)).toContain('驻留时间必须大于 0')
    await input(`native-esm-dwell-${sensorId}`, '2')
    expect(errorFor(`native-esm-dwell-${sensorId}`)).toBe('')
  })
})


it('到达时间超长在确认时阻止，修正后才更新草稿', async () => {
  const { wrapper, store, fetch, number, confirm } = await loadPage()
  const original = structuredClone(toRaw(store.draft!))
  await wrapper.get('#tab-platforms').trigger('click')
  await wrapper.get('[data-testid="edit-platform-3"]').trigger('click')
  await flushPromises()
  number('waypoint-arrival-0', original.config.scenario.duration + 1)
  await confirm('apply-platform')
  expectValidationMessage('航点到达时间不能超过场景仿真时长。')
  expect(store.draft).toEqual(original)
  number('waypoint-arrival-0', 500)
  await confirm('apply-platform')
  expect(store.draft!.config.platforms[3]!.waypoints[0]!.arrivalTime).toBe(500)
  expect(fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('干扰方向越界时原位报错且阻止确认，修正后保存方向', async () => {
  const { wrapper, store, number, confirm } = await loadPage()
  const original = structuredClone(toRaw(store.draft!))
  await wrapper.get('#tab-jammers').trigger('click')
  await wrapper.get('[data-testid="edit-jammer-0"]').trigger('click')
  await flushPromises()
  number('jammer-direction', 361)
  await confirm('apply-jammer')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="jammer-direction"]')!.closest('.el-form-item')!.textContent).toContain('干扰方向必须在 0 至 360 度之间。'))
  expect(store.draft).toEqual(original)
  number('jammer-direction', 90)
  await confirm('apply-jammer')
  expect(store.draft!.uiExtensions.jammers[0]!.direction).toBe(90)
})

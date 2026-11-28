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
import { readDeviceParameters, resolveTemplateLinkPorts } from '../../src/features/scenarios/template-defaults'
import { effectiveLinkFromPorts } from '../../src/features/scenarios/link-port-parameters'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'

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
  it('高级配置默认折叠，已有阵营随节点保留并且展开后可以修改，不再展示通信范围', async () => {
    const { wrapper, store, select, confirm } = await loadPage()
    Object.assign(store.draft!.config.platforms[0]!, { faction: 'RED' })
    const platform = () => store.draft!.config.platforms[0]!
    const openEditor = async () => {
      await wrapper.get('#tab-platforms').trigger('click')
      await wrapper.get('[data-testid="edit-platform-0"]').trigger('click')
      await flushPromises()
      return document.querySelector<HTMLDetailsElement>('[data-testid="platform-advanced"]')!
    }

    const original = structuredClone(toRaw(platform()))
    expect((await openEditor()).open).toBe(false)
    await confirm('apply-platform')
    expect(platform()).toEqual(original)

    const advanced = await openEditor()
    expect(advanced.open).toBe(false)
    advanced.querySelector('summary')!.click()
    expect(advanced.open).toBe(true)
    expect(advanced.textContent).toContain('所属阵营')
    expect(advanced.querySelector('[data-testid="platform-communication-range"]')).toBeNull()
    select('platform-faction', '')
    await flushPromises()
    expect(advanced.textContent).toContain('默认（按节点类型推断）')
    await confirm('apply-platform')
    expect(platform()).not.toHaveProperty('faction')

    const reopened = await openEditor()
    expect(reopened.open).toBe(false)
    reopened.querySelector('summary')!.click()
    select('platform-faction', 'BLUE')
    await confirm('apply-platform')
    expect(platform().faction).toBe('BLUE')
  })

  it('定位节点阵营错误时展开高级配置并聚焦字段', async () => {
    const { wrapper, store } = await loadPage()
    Object.assign(store.draft!.config.platforms[0]!, { faction: 'INVALID' })
    store.markDirty()
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '定位首个问题')!.trigger('click')
    await vi.waitFor(() => {
      const advanced = document.querySelector<HTMLDetailsElement>('[data-testid="platform-advanced"]')
      expect(advanced?.open).toBe(true)
      expect(advanced?.textContent).toContain('所属阵营请选择蓝方、红方或中立。')
    })
  })

  it.each([
    { field: 'waypoint-acceleration-0', group: null, invalidate: (config: ScenarioConfig) => { config.platforms[3]!.waypoints[0]!.acceleration = Number.NaN } },
    { field: 'link-rx-bandwidth', group: '接收参数', invalidate: (config: ScenarioConfig) => { config.links.find(link => link.type === 'LASER')!.rxBandwidth = -1 } },
    { field: 'link-modulation', group: null, invalidate: (config: ScenarioConfig) => { Object.assign(config.links[0]!, { modulation: 'INVALID' }) } },
  ])('定位 $field 校验错误时聚焦字段，并展开所属折叠区', async ({ field, group, invalidate }) => {
    const { wrapper, store } = await loadPage()
    invalidate(store.draft!.config)
    store.markDirty()
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '定位首个问题')!.trigger('click')
    await vi.waitFor(() => {
      const owner = document.querySelector(`[data-testid="${field}"]`)
      const details = owner?.closest('details')
      expect(details?.open ?? false).toBe(group !== null)
      expect(details?.querySelector('summary')?.textContent?.trim() ?? null).toBe(group)
      expect(document.activeElement).toBe(owner?.matches('input') ? owner : owner?.querySelector('input'))
    })
  })

  it('定位历史端口错误会打开端口参数弹窗、展示隐藏列并切换到对应平台', async () => {
    const { wrapper, store } = await loadPage()
    const parameters = readDeviceParameters({})
    parameters.ports.TIAN_TONG_SAT!.sat_link!.eirpDbw = Number.NaN
    store.draft!.config.deviceParameters = parameters
    store.markDirty()
    await wrapper.get('#tab-links').trigger('click')
    expect(document.querySelector('[data-testid="port-parameters-dialog"]')).toBeNull()
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '定位首个问题')!.trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="port-parameters-dialog"]')).not.toBeNull()
    await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="port-TIAN_TONG_SAT-sat_link-eirpDbw"] input')
      expect(input).not.toBeNull()
      expect(document.activeElement).toBe(input)
    })
    expect(store.draft!.config.deviceParameters!.ports!.TIAN_TONG_SAT!.sat_link!.eirpDbw).toBeNaN()
  })

  it('端口参数设置内含天线增益且打开保存不改已同步草稿，隐藏的历史值与传感器配置保留', async () => {
    const { wrapper, store } = await loadPage()
    await wrapper.get('#tab-links').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="open-port-parameters"]').trigger('click')
    await flushPromises()
    await wrapper.findAllComponents({ name: 'ElButton' }).find(btn => btn.attributes('data-testid') === 'close-port-parameters')!.trigger('click')
    await flushPromises()
    store.dirty = false
    const original = structuredClone(toRaw(store.draft!))
    expect(wrapper.find('#tab-devices').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scenario-trans-distance"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scenario-device-advanced"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scenario-device-parameters"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="open-antenna-parameters"]').exists()).toBe(false)
    await wrapper.get('[data-testid="open-port-parameters"]').trigger('click')
    await flushPromises()
    const portDialog = document.querySelector('[data-testid="port-parameters-dialog"]')!
    expect(portDialog).not.toBeNull()
    expect(portDialog.querySelector('[data-testid="antenna-gain-table"]')).not.toBeNull()
    expect(portDialog.querySelector('[data-testid="port-MISSION_UAV_PLATFORM-microwave_link-eirpDbw"]')).not.toBeNull()
    expect(portDialog.querySelector('[data-testid="port-MISSION_UAV_PLATFORM-microwave_link-gtDbk"]')).not.toBeNull()
    expect(portDialog.querySelector('[data-testid="port-MISSION_UAV_PLATFORM-microwave_link-peakGainDb"]')).not.toBeNull()
    await wrapper.findAllComponents({ name: 'ElButton' }).find(btn => btn.attributes('data-testid') === 'close-port-parameters')!.trigger('click')
    await flushPromises()
    // 传感器页已并入“干扰设备”：不再渲染传感器配置，但 config.sensors 原样保留。
    expect(wrapper.find('#tab-data').exists()).toBe(false)
    expect(wrapper.find('[data-testid="sensor-planning-0"]').exists()).toBe(false)
    expect(store.draft!.config.sensors.length).toBeGreaterThan(0)
    await wrapper.get('#tab-scenario').trigger('click')
    await flushPromises()
    expect(store.draft).toEqual(original)
    expect(store.dirty).toBe(false)
  })

  it('链路分页保留全局序号、编辑目标及校验定位，删除末页唯一一行后回到上一页', async () => {
    const { wrapper, store } = await loadPage()
    const config = store.draft!.config
    const firstLink = structuredClone(toRaw(config.links[0]!))
    config.links.push(...Array.from({ length: 31 - config.links.length }, (_, index) => ({
      ...structuredClone(firstLink), id: `L-PAGE-${index + 1}`,
    })))
    const targetId = config.links[30]!.id
    await wrapper.get('#tab-links').trigger('click')
    await flushPromises()

    const rows = () => wrapper.get('[data-testid="link-table"]').findAll('tbody .el-table__row')
    expect(rows()).toHaveLength(30)
    expect(rows()[0]!.get('td').text()).toBe('1')
    const pagination = wrapper.findAllComponents({ name: 'ElPagination' }).find(item => item.attributes('data-testid') === 'link-pagination')!
    expect(pagination.props('pageSize')).toBe(30)
    pagination.vm.$emit('update:current-page', 2)
    await flushPromises()
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.get('td').text()).toBe('31')

    await wrapper.get('[data-testid="edit-link-30"]').trigger('click')
    const dialog = wrapper.findComponent({ name: 'LinkEditorDialog' })
    expect(dialog.props('link')).toMatchObject({ id: targetId })
    dialog.vm.$emit('apply', { ...structuredClone(toRaw(dialog.props('link'))), enabled: false }, dialog.props('demand'))
    await flushPromises()
    expect(store.draft!.config.links[0]).toEqual(firstLink)
    expect(store.draft!.config.links[30]).toMatchObject({ id: targetId, enabled: false })
    expect(dialog.props('modelValue')).toBe(false)

    pagination.vm.$emit('update:current-page', 1)
    store.draft!.config.links[30]!.txPower = -1
    await wrapper.get('[data-testid="save-scenario"]').trigger('click')
    await flushPromises()
    const issue = wrapper.findAll('[data-testid^="locate-validation-issue-"]').find(item => item.attributes('data-field-path') === 'links[30].txPower')!
    expect(issue.text()).toContain('第 31 条链路')
    expect(issue.text()).toContain('发射功率')
    await issue.trigger('click')
    await flushPromises()
    expect(rows()[0]!.get('td').text()).toBe('31')
    expect(dialog.props('link')).toMatchObject({ id: targetId, txPower: -1 })
    dialog.vm.$emit('update:modelValue', false)
    await flushPromises()

    const deletion = wrapper.findAllComponents({ name: 'ElPopconfirm' }).find(item => item.find('[data-testid="delete-link-30"]').exists())!
    deletion.vm.$emit('confirm', new MouseEvent('click'))
    await flushPromises()
    expect(store.draft!.config.links[0]).toEqual(firstLink)
    expect(store.draft!.config.links.some(link => link.id === targetId)).toBe(false)
    expect(rows()).toHaveLength(30)
    expect(rows()[0]!.get('td').text()).toBe('1')
    expect(wrapper.find('[data-testid="link-pagination"]').exists()).toBe(false)
  })

  it('切换页签只挂载当前列表，不再提供传感器页签且切换不改草稿', async () => {
    const { wrapper, store } = await loadPage()
    const before = structuredClone(toRaw(store.draft!))
    expect(wrapper.find('#tab-data').exists()).toBe(false)
    for (const [tab, table] of [['platforms', 'platform-table'], ['links', 'link-table'], ['jammers', 'jammer-table']] as const) {
      expect(wrapper.find(`[data-testid="${table}"]`).exists()).toBe(false)
      await wrapper.get(`#tab-${tab}`).trigger('click')
      await flushPromises()
      expect(wrapper.find(`[data-testid="${table}"]`).exists()).toBe(true)
      await wrapper.get('#tab-scenario').trigger('click')
      expect(wrapper.find(`[data-testid="${table}"]`).exists()).toBe(false)
    }
    expect(wrapper.find('[data-testid="sensor-frequency-min-0"]').exists()).toBe(false)
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

  it('微波端点不匹配时提示挂在两端，新增打开时不先报', async () => {
    const { wrapper, select } = await loadPage()
    const formError = (testId: string) => document.querySelector(`[data-testid="${testId}"]`)
      ?.closest('.el-form-item')?.querySelector('.el-form-item__error')?.textContent ?? ''
    await wrapper.get('#tab-links').trigger('click')
    await wrapper.get('[data-testid="add-link"]').trigger('click')
    await flushPromises()
    expect(formError('link-type')).not.toContain('微波链路仅支持')
    expect(formError('link-source')).not.toContain('微波链路仅支持')
    expect(formError('link-target')).not.toContain('微波链路仅支持')
    select('link-target', 'GCC-01')
    await flushPromises()
    const message = '微波链路仅支持任务/中继无人机之间或与公共服务平台后方节点之间。'
    expect(formError('link-type')).not.toContain(message)
    await vi.waitFor(() => {
      expect(formError('link-source')).toContain(message)
      expect(formError('link-target')).toContain(message)
    })
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
    wrapper.getComponent({ name: 'WaypointMapPicker' }).vm.$emit('confirm-route', [{ longitude: 120.1, latitude: 24.1, altitude: 0, speed: 1 }])
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

    const secondLoiter = { longitude: 120.2, latitude: 24.1, altitude: 1000, speed: 1 }
    await click('loiter-enabled')
    document.querySelector<HTMLDetailsElement>('[data-testid="loiter-details"]')!.open = true
    const pointCount = document.querySelectorAll('[data-testid^="delete-loiter-"]').length
    expect(pointCount).toBeGreaterThanOrEqual(2)
    for (let index = pointCount - 1; index > 0; index -= 1) await click('delete-loiter-' + index)
    const picker = wrapper.getComponent({ name: 'WaypointMapPicker' })
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
    picker.vm.$emit('confirm-route', [secondLoiter])
    await flushPromises()
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

  it('干扰设备缺少归属、功率或范围异常均在确认时阻止，修正后才新增', async () => {
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
    await flushPromises()
    // 触发时间不参与仿真，弹框已不再提供配置。
    expect(document.querySelector('[data-testid="jammer-trigger-time"]')).toBeNull()
    expect(store.draft).toEqual(original)
    expect(store.dirty).toBe(false)
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

  it('已废弃的传输距离字段不再显示或阻断，其他环境字段仍即时校验', async () => {
    const { store, wrapper } = await loadPage()
    expect(wrapper.find('[data-testid="scenario-trans-distance"]').exists()).toBe(false)
    Object.assign(store.draft!.config.scenario.environment, { transmissionDistance: 500 })
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(wrapper.find('[data-testid="scenario-trans-distance"]').exists()).toBe(false)
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
    await input('jammer-power', '0')
    expect(errorFor('jammer-power')).toContain('大于 0 W')
    await input('jammer-power', '200')
    expect(errorFor('jammer-power')).toBe('')
    await confirm('cancel-jammer')
    expect(store.draft).toEqual(original)
  })

  it('修改源端的频率后继承链路即时显示同频互扰警告，修正后清除', async () => {
    const { wrapper, store, confirm, number } = await loadPage()
    // L-DL-06（数传）与 L-MW-05（微波）都到达 AIR-01。
    const index = store.draft!.config.links.findIndex(link => link.id === 'L-DL-06')
    const link = store.draft!.config.links[index]!
    link.inheritPortParameters = true
    const resolution = resolveTemplateLinkPorts(store.draft!.config, link)
    if (resolution.status !== 'MAPPED') throw new Error('缺少测试链路的端口映射')
    const { platformType, portName } = resolution.source
    await wrapper.get('#tab-links').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="open-port-parameters"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLElement>(`[id="tab-${platformType}"]`)!.click()
    await flushPromises()
    const microwaveFrequency = readDeviceParameters(store.draft!.config).ports.MISSION_UAV_PLATFORM!.microwave_link!.txFrequency
    const portFrequency = `port-${platformType}-${portName}-txFrequency`
    number(portFrequency, microwaveFrequency)
    await confirm('close-port-parameters')
    await wrapper.get(`[data-testid="edit-link-${index}"]`).trigger('click')
    await flushPromises()
    const portWarning = document.querySelector('[data-testid="link-port-validation"]')?.textContent ?? ''
    expect(portWarning).toContain('警告：')
    expect(portWarning).toContain('同频互扰')
    await confirm('cancel-link')
    await wrapper.get('[data-testid="open-port-parameters"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLElement>(`[id="tab-${platformType}"]`)!.click()
    await flushPromises()
    number(portFrequency, 4400)
    await confirm('close-port-parameters')
    await wrapper.get(`[data-testid="edit-link-${index}"]`).trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="link-port-validation"]')).toBeNull()
    await confirm('cancel-link')
    expect(store.draft!.config.links[index]!.frequency).toBe(4400)
  })

  it('旧链路直接强制使用端口参数设置的值，不再保留历史差异或提示冲突', async () => {
    const { wrapper, store, confirm, number } = await loadPage()
    const config = store.draft!.config
    const legacy = structuredClone(toRaw(config.links[0]!))
    const resolution = resolveTemplateLinkPorts(config, legacy)
    if (resolution.status !== 'MAPPED') throw new Error('缺少测试链路的端口映射')
    const { platformType, portName } = resolution.source
    const target = resolution.target
    const defaults = readDeviceParameters(config).ports
    const tx = defaults[platformType]![portName]!
    const rx = defaults[target.platformType]![target.portName]!
    config.deviceParameters = { ports: {
      [platformType]: { [portName]: { ...tx, txPower: legacy.txPower + 1 } },
      [target.platformType]: { [target.portName]: { ...rx, rxFrequency: 8325 } },
    } }

    await wrapper.get('#tab-links').trigger('click')
    const openEditor = async () => {
      await wrapper.get('[data-testid="edit-link-0"]').trigger('click')
      await flushPromises()
    }
    await openEditor()
    expect(document.querySelector('[data-testid="link-port-conflict"]')).toBeNull()
    expect(document.querySelector('[data-testid="inherit-link-port-parameters"]')).toBeNull()
    expect(document.querySelector('[data-testid="keep-link-port-parameters"]')).toBeNull()
    expect(document.querySelector('[data-testid="link-power"]')).toBeNull()
    expect(document.querySelector('[data-testid="link-rx-frequency"]')).toBeNull()
    await confirm('apply-link')
    expect(store.draft!.config.links[0]).toMatchObject({ inheritPortParameters: true, txPower: legacy.txPower + 1, rxFrequency: 8325 })

    await wrapper.get('[data-testid="open-port-parameters"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="close-port-parameters"]')?.textContent?.trim()).toBe('完成')
    document.querySelector<HTMLElement>(`[id="tab-${platformType}"]`)!.click()
    await flushPromises()
    number(`port-${platformType}-${portName}-txPower`, legacy.txPower + 2)
    await confirm('close-port-parameters')
    expect(store.draft!.config.links[0]).toMatchObject({ txPower: legacy.txPower + 2, rxFrequency: 8325 })
    await openEditor()
    expect(document.querySelector('[data-testid="link-port-conflict"]')).toBeNull()
    expect(document.querySelector('[data-testid="link-power"]')).toBeNull()
  })

  it('未单独修改端口默认值时，点击端口参数保存也会将旧链路强制覆盖为默认值', async () => {
    const { wrapper, store, confirm } = await loadPage()
    const config = store.draft!.config
    const legacy = config.links[0]!
    delete config.deviceParameters
    delete legacy.inheritPortParameters
    const resolution = resolveTemplateLinkPorts(config, legacy)
    if (resolution.status !== 'MAPPED') throw new Error('缺少测试链路的端口映射')
    const expected = readDeviceParameters(config).ports[resolution.source.platformType]![resolution.source.portName]!
    legacy.bandwidth = expected.txBandwidth + 17

    await wrapper.get('#tab-links').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="open-port-parameters"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="port-parameters-dialog"] [role="alert"]')).toBeNull()
    await confirm('close-port-parameters')
    expect(store.draft!.config.links[0]).toMatchObject({
      inheritPortParameters: true,
      bandwidth: expected.txBandwidth,
      frequency: expected.txFrequency,
    })
  })

  it('端口参数设置里的数值直接覆盖匹配旧链路的参数', async () => {
    const { wrapper, store, confirm, number } = await loadPage()
    const config = store.draft!.config
    const legacy = config.links[0]!
    delete legacy.inheritPortParameters
    const resolution = resolveTemplateLinkPorts(config, legacy)
    if (resolution.status !== 'MAPPED') throw new Error('缺少测试链路的端口映射')
    const { platformType, portName } = resolution.source
    const originalPower = legacy.txPower
    const originalFrequency = legacy.frequency

    await wrapper.get('#tab-links').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="open-port-parameters"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLElement>(`[id="tab-${platformType}"]`)!.click()
    await flushPromises()
    number(`port-${platformType}-${portName}-txFrequency`, originalFrequency + 25)
    await flushPromises()
    number(`port-${platformType}-${portName}-txPower`, originalPower + 5)
    await flushPromises()
    await confirm('close-port-parameters')

    expect(store.draft!.config.links[0]).toMatchObject({
      inheritPortParameters: true,
      frequency: originalFrequency + 25,
      txPower: originalPower + 5,
    })
    await wrapper.get('[data-testid="edit-link-0"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="link-port-conflict"]')).toBeNull()
    expect(document.querySelector('[data-testid="link-frequency"]')).toBeNull()
    expect(document.querySelector('[data-testid="link-power"]')).toBeNull()
  })

  it('修改卫星中继端口参数时也会覆盖经过该中继的旧卫星链路，消除端口冲突提示', async () => {
    const { wrapper, store, confirm, number } = await loadPage()
    const config = store.draft!.config
    const satLink = config.links.find(link => link.type === 'SAT' && link.relayPlatformId)!
    delete satLink.inheritPortParameters
    satLink.frequency = 12500

    await wrapper.get('#tab-links').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="open-port-parameters"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLElement>('[id="tab-TIAN_TONG_SAT"]')!.click()
    await flushPromises()
    number('port-TIAN_TONG_SAT-sat_link-txFrequency', 20000)
    await flushPromises()
    expect(document.querySelector('[data-testid="port-parameters-dialog"] [role="alert"]')).toBeNull()
    await confirm('close-port-parameters')
    expect(store.draft!.config.links.find(link => link.id === satLink.id)!.inheritPortParameters).toBe(true)
  })

  it('传感器页已并入干扰设备，各页签均不再渲染传感器及原生ESM输入', async () => {
    const { wrapper, store } = await loadPage()
    const sensorId = store.draft!.config.sensors[0]!.id
    expect(wrapper.find('#tab-data').exists()).toBe(false)
    for (const tab of ['scenario', 'platforms', 'links', 'jammers'] as const) {
      await wrapper.get(`#tab-${tab}`).trigger('click')
      await flushPromises()
      expect(document.querySelector('[data-testid="sensor-frequency-min-0"]')).toBeNull()
      expect(document.querySelector('[data-testid="sensor-probability-0"]')).toBeNull()
      expect(document.querySelector(`[data-testid="native-esm-dwell-${sensorId}"]`)).toBeNull()
    }
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

it('干扰弹框不再提供干扰方向，确认后保留原方向', async () => {
  const { wrapper, store, confirm } = await loadPage()
  const original = structuredClone(toRaw(store.draft!))
  await wrapper.get('#tab-jammers').trigger('click')
  await wrapper.get('[data-testid="edit-jammer-0"]').trigger('click')
  await flushPromises()
  // 干扰指向不参与仿真，弹框已不再提供配置。
  expect(document.querySelector('[data-testid="jammer-direction"]')).toBeNull()
  await confirm('apply-jammer')
  expect(wrapper.findComponent({ name: 'JammerEditorDialog' }).props('modelValue')).toBe(false)
  expect(store.draft!.uiExtensions.jammers[0]!.direction).toEqual(original.uiExtensions.jammers[0]!.direction)
})

it('端口参数存在校验错误时，点击弹窗保存会阻止关闭、切换到出错页签并聚焦字段，修正后可保存关闭', async () => {
  const { wrapper, number, confirm } = await loadPage()
  await wrapper.get('#tab-links').trigger('click')
  await flushPromises()
  await wrapper.get('[data-testid="open-port-parameters"]').trigger('click')
  await flushPromises()

  document.querySelector<HTMLElement>('[id="tab-TIAN_TONG_SAT"]')!.click()
  await flushPromises()
  number('port-TIAN_TONG_SAT-sat_link-txFrequency', 0)

  // 切回其他标签页后再点弹窗「保存」，应自动切回天通卫星页签、阻止关闭并提示中文错误。
  document.querySelector<HTMLElement>('[id="tab-COMMAND_VEHICLE_PLATFORM"]')!.click()
  await flushPromises()
  await confirm('close-port-parameters')

  const overlay = () => document.querySelector('[data-testid="port-parameters-dialog"]')?.closest<HTMLElement>('.el-overlay')
  expect(overlay()?.style.display).not.toBe('none')
  const alertText = document.querySelector('[data-testid="port-parameters-error"]')?.textContent ?? ''
  expect(alertText).toContain('端口参数（天通卫星 · 卫通） · 发射频率')
  expect(alertText).toContain('发射频率必须大于 0。')
  await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="port-TIAN_TONG_SAT-sat_link-txFrequency"] input')
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
  })

  number('port-TIAN_TONG_SAT-sat_link-txFrequency', 1626.5)
  await flushPromises()
  await vi.waitFor(() => expect(document.querySelector('[data-testid="port-parameters-error"]')).toBeNull())
  await confirm('close-port-parameters')
  await vi.waitFor(() => expect(overlay()?.style.display).toBe('none'))
})

it('端口托管链路的同频互扰警告在校验面板显示对应端口，点击定位直接打开端口参数设置并聚焦发射频率', async () => {
  const { wrapper, store, fetch } = await loadPage()
  const config = store.draft!.config
  const ports = readDeviceParameters(config)
  // L-MW-01（任务无人机微波 → 后方指挥节点）与 L-SAT-05（天通卫星 → 后方指挥节点）共用同一接收端，将发射频率设至重叠。
  ports.ports.MISSION_UAV_PLATFORM!.microwave_link!.txFrequency = ports.ports.TIAN_TONG_SAT!.sat_link!.txFrequency
  ports.ports.MISSION_UAV_PLATFORM!.microwave_link!.txBandwidth = ports.ports.TIAN_TONG_SAT!.sat_link!.txBandwidth
  config.deviceParameters = ports
  const effectiveConfig = { ...config, links: config.links.map(link => effectiveLinkFromPorts(config, link)) }
  config.links = effectiveConfig.links
  const inspection = inspectScenarioConfig(effectiveConfig, 'write')
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      ok: true,
      data: inspection.result,
    }),
  })

  await wrapper.get('[data-testid="save-scenario"]').trigger('click')
  await flushPromises()

  const panelText = wrapper.get('[data-testid="validation-panel"]').text()
  expect(panelText).toContain('第 1 条链路')
  expect(panelText).toContain('发射频率（端口：任务无人机（含中继） · 微波）')

  await wrapper.get('[data-testid^="locate-validation-issue-"][data-field-path="links[0].frequency"]').trigger('click')
  await flushPromises()

  expect(document.querySelector('[data-testid="link-dialog"]')).toBeNull()
  const portOverlay = document.querySelector('[data-testid="port-parameters-dialog"]')?.closest<HTMLElement>('.el-overlay')
  expect(portOverlay).not.toBeNull()
  expect(portOverlay?.style.display).not.toBe('none')
  expect(document.querySelector('[data-testid="port-parameters-warning"]')?.textContent).toContain('频段重叠')
  await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="port-MISSION_UAV_PLATFORM-microwave_link-txFrequency"] input')
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
  })
})

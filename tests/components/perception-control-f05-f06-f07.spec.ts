import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import EsmSensorPanel from '../../src/components/interactions/EsmSensorPanel.vue'
import JammerSyncPanel from '../../src/components/interactions/JammerSyncPanel.vue'
import RfJammerPanel from '../../src/components/interactions/RfJammerPanel.vue'
import type {
  DetectionEvent, JammerPlanSaved, JammerRuntimeParameters, Principal, ScenarioDraft, SensorUiExtension, TelemetryFrame,
} from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'
import { useTelemetryStore } from '../../src/stores/telemetry'

const fixtureFrame = fixtureSource.frame as unknown as TelemetryFrame
const fixtureEvents = fixtureSource.events as unknown as Array<DetectionEvent>
const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'],
}
const sensorExtension: SensorUiExtension = { sensorId: 'ESM-01', type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true }

/** 统一成功响应信封。 */
function successResponse(data: unknown): Response {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

/** 以当前固定场景为基线构造草稿；可覆盖干扰设备带宽与追加设备。 */
function buildDraft(overrides: { jammerBandwidth?: number; extraJammers?: ScenarioDraft['config']['jammers'] } = {}): ScenarioDraft {
  const config = structuredClone(fixtureSource.scenario) as ScenarioDraft['config']
  if (overrides.jammerBandwidth !== undefined) {
    config.jammers[0]!.bandwidth = overrides.jammerBandwidth
    config.jammers[0]!.defaultPower = 1
  }
  if (overrides.extraJammers !== undefined) config.jammers = [...config.jammers, ...overrides.extraJammers]
  return {
    config,
    uiExtensions: {
      jammers: config.jammers.map(jammer => ({ jammerId: jammer.id, direction: 0, enabled: true, elevation: 0 })),
      sensors: [structuredClone(sensorExtension)],
    },
    revision: 4,
    officialLibraryChanged: false,
    locked: false,
  }
}

/** 克隆固定帧，并让干扰执行证据与所选设备带宽/功率一致（避免历史 72 W 回显阻断）。 */
function buildFrame(overrides: { jammerBandwidth?: number } = {}): TelemetryFrame {
  const clone = structuredClone(fixtureFrame)
  if (overrides.jammerBandwidth !== undefined) {
    clone.evidence.jammerExecution = { ...clone.evidence.jammerExecution, power: 1, bandwidth: overrides.jammerBandwidth }
  }
  return clone
}

function runtimeParams(overrides: Partial<JammerRuntimeParameters> = {}): JammerRuntimeParameters {
  return { taskId: 'TASK-001', jammerId: 'JAM-WB-01-TX', version: 4, detectionRangeM: 44448, ...overrides }
}

function planSaved(overrides: Partial<JammerPlanSaved> = {}): JammerPlanSaved {
  return {
    taskId: 'TASK-001', jammerId: 'JAM-WB-01-TX', style: 'BARRAGE', elevation: 0,
    plannedStartFrame: 300, plannedStopFrame: 900, storage: 'LOCAL_RUN', ...overrides,
  }
}

/** 同步结果形状（含实际接受探测范围）。 */
function syncResult(bandwidth: number, detectionRangeM: number, power = 1): Record<string, unknown> {
  return {
    taskId: 'TASK-001', jammerId: 'JAM-WB-01-TX', parameterVersion: 5,
    configParameterVersion: 5, nodeParameterVersion: 5, engineSync: 'NOT_CONNECTED', uiParameterVersion: 5,
    effectiveFrameId: 'F-00042', effectiveSimulationTime: 42, status: 'LOCAL_ACCEPTED', detectionRangeM,
    jammerStatus: { time: 42, jammerId: 'JAM-WB-01-TX', platformId: 'STN-01', targetPlatform: 'UAV-01', power, frequency: 2200, bandwidth, active: true },
  }
}

/** 按方法/路径路由的 fetch 桩，覆盖 GET 参数读取、POST 同步与 PUT 计划保存。 */
function installFetch(routes: {
  getParams?: unknown
  postParams?: unknown
  plan?: unknown
} = {}) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.endsWith('/plan') && method === 'PUT') return successResponse(routes.plan ?? planSaved())
    if (url.includes('/parameters') && method === 'POST') return successResponse(routes.postParams ?? {})
    if (url.includes('/parameters') && method === 'GET') return successResponse(routes.getParams ?? runtimeParams())
    return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: '未找到。' } }) } as unknown as Response
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

function inputByTestId(wrapper: VueWrapper, testId: string) {
  return wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === testId)
}

function detection(extra: Partial<DetectionEvent> = {}): DetectionEvent {
  return { ...structuredClone(fixtureEvents[0]!), ...extra }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('F05 ESM 侦测详情（目标位置/平台类型/实际频率/接收强度）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function mountEsm(event: DetectionEvent) {
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    scenarioStore.$patch({ draft: buildDraft(), panelState: 'SUCCESS' })
    telemetryStore.$patch({ frame: structuredClone(fixtureFrame), events: [event], capabilityState: 'SUCCESS' })
    return mount(EsmSensorPanel, { global: { plugins: [ElementPlus] } })
  }

  it('完整遥测：展示目标平台类型、同帧平台位置、ESM 测得位置、实际工作频率与接收强度', () => {
    const wrapper = mountEsm(detection({
      measuredLongitude: 119.36, measuredLatitude: 24.71, measuredAltitude: 2950,
      actualFrequencyMHz: 2250, receivedSignalStrengthDbm: -64,
    }))
    const block = wrapper.get('[data-testid="esm-target-detail"]')
    expect(block.text()).toContain('高空前出中继节点')
    expect(block.text()).toContain('119.3500°')
    expect(block.text()).toContain('119.3600°')
    expect(block.text()).toContain('2250 MHz')
    expect(block.text()).toContain('-64 dBm')
    wrapper.unmount()
  })

  it('缺测：ESM 位置/实际频率/接收强度显示“暂无数据”，不用同帧平台位置冒充 ESM 位置', () => {
    const wrapper = mountEsm(detection())
    const block = wrapper.get('[data-testid="esm-target-detail"]')
    expect(block.text()).toContain('119.3500°')
    expect((block.text().match(/暂无数据/g) ?? []).length).toBeGreaterThanOrEqual(3)
    wrapper.unmount()
  })

  it('目标丢失：目标不在当前帧平台表中时判为数据错误，不残留为当前探测结果', () => {
    const wrapper = mountEsm(detection({ targetPlatformId: 'UNKNOWN-TARGET' }))
    expect(wrapper.get('[data-testid="esm-state"]').text()).toBe('数据错误')
    expect(wrapper.text()).toContain('侦测目标不存在')
    expect(wrapper.find('[data-testid="esm-target-detail"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('跨运行/同帧不一致：侦测事件帧与当前帧不符判为数据错误', () => {
    const wrapper = mountEsm(detection({ frameId: 'F-OTHER' }))
    expect(wrapper.get('[data-testid="esm-state"]').text()).toBe('数据错误')
    expect(wrapper.text()).toContain('侦测事件与当前帧不一致')
    wrapper.unmount()
  })
})

describe('F06 RF 运行面板（样式/俯仰/计划帧/状态分级）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function setup(bandwidth: number) {
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    scenarioStore.$patch({ draft: buildDraft({ jammerBandwidth: bandwidth }), panelState: 'SUCCESS' })
    telemetryStore.$patch({ frame: buildFrame({ jammerBandwidth: bandwidth }), capabilityState: 'SUCCESS' })
  }

  it('样式切换按带宽档位联动：宽带压制 200 MHz ↔ 瞄准式 5 MHz', async () => {
    setup(200)
    const wrapper = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })
    const bandwidthInput = () => wrapper.findAllComponents({ name: 'ElInputNumber' })[1]!
    expect(bandwidthInput().props('modelValue')).toBe(200)
    wrapper.findComponent({ name: 'ElRadioGroup' }).vm.$emit('change', 'SPOT')
    await nextTick()
    expect(bandwidthInput().props('modelValue')).toBe(5)
    wrapper.findComponent({ name: 'ElRadioGroup' }).vm.$emit('change', 'BARRAGE')
    await nextTick()
    expect(bandwidthInput().props('modelValue')).toBe(200)
    wrapper.unmount()
  })

  it('计划帧真实保存：300/900 原值留存，顺序非法被拒绝，保存后可从读取层回填', async () => {
    setup(200)
    installFetch({
      plan: planSaved({ plannedStartFrame: 300, plannedStopFrame: 900 }),
      getParams: runtimeParams({ version: 4, detectionRangeM: 44448, style: 'BARRAGE', elevation: 0, plannedStartFrame: 300, plannedStopFrame: 900 }),
    })
    const wrapper = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const startInput = () => inputByTestId(wrapper, 'rf-plan-start')
    const stopInput = () => inputByTestId(wrapper, 'rf-plan-stop')
    const saveButton = () => wrapper.findAll('button').find(button => button.text().includes('保存计划'))!
    if (startInput() === undefined || stopInput() === undefined) throw new Error('计划帧控件缺失')

    startInput()!.vm.$emit('update:modelValue', 900)
    stopInput()!.vm.$emit('update:modelValue', 300)
    await nextTick()
    await saveButton().trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="rf-plan-status"]').text()).toContain('计划：未保存')
    expect(wrapper.text()).toContain('计划停止帧必须大于计划启动帧。')

    startInput()!.vm.$emit('update:modelValue', 300)
    stopInput()!.vm.$emit('update:modelValue', 900)
    await nextTick()
    await saveButton().trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="rf-plan-status"]').text()).toContain('计划：已保存（本地）'))

    // 验证实际写入运行期读取层（不是仅文案）。
    const cached = useTelemetryStore().jammerRuntimeParameters['RUN-001|JAM-WB-01-TX']
    expect(cached).toMatchObject({ style: 'BARRAGE', elevation: 0, plannedStartFrame: 300, plannedStopFrame: 900 })
    expect(startInput()!.props('modelValue')).toBe(300)
    expect(stopInput()!.props('modelValue')).toBe(900)
    wrapper.unmount()

    // 清空本地缓存（等价重建/重进页面），重新挂载后从服务端读取层回填样式/俯仰/计划帧与已保存状态。
    useTelemetryStore().jammerRuntimeParameters = {}
    const reloaded = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(inputByTestId(reloaded, 'rf-plan-start')!.props('modelValue')).toBe(300)
    expect(inputByTestId(reloaded, 'rf-plan-stop')!.props('modelValue')).toBe(900)
    expect(reloaded.get('[data-testid="rf-plan-status"]').text()).toContain('计划：已保存（本地）')
    reloaded.unmount()
  })

  it('计划保存失败保留输入可重试，不标记已保存', async () => {
    setup(200)
    installFetch({ plan: null })
    // 强制 PUT 返回失败信封。
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (
      String(input).endsWith('/plan') && (init?.method ?? 'GET').toUpperCase() === 'PUT'
        ? { ok: false, status: 422, json: async () => ({ ok: false, error: { code: 'OUT_OF_RANGE', message: '计划保存失败。' } }) } as unknown as Response
        : successResponse(runtimeParams())
    )))
    const wrapper = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    inputByTestId(wrapper, 'rf-plan-start')!.vm.$emit('update:modelValue', 300)
    inputByTestId(wrapper, 'rf-plan-stop')!.vm.$emit('update:modelValue', 900)
    await nextTick()
    await wrapper.findAll('button').find(button => button.text().includes('保存计划'))!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="rf-plan-status"]').text()).toContain('计划：未保存')
    expect(wrapper.text()).toContain('计划保存失败，请重试')
    // 输入保留，允许重试。
    expect(inputByTestId(wrapper, 'rf-plan-start')!.props('modelValue')).toBe(300)
    expect(inputByTestId(wrapper, 'rf-plan-stop')!.props('modelValue')).toBe(900)
    wrapper.unmount()
  })

  it('保存期间的新编辑不被标记已保存：提交快照与服务端一致，页面保留新编辑', async () => {
    setup(200)
    let resolvePlan!: (value: Response) => void
    const planBodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith('/plan') && method === 'PUT') {
        planBodies.push(String((init as RequestInit).body))
        return new Promise<Response>((resolve) => { resolvePlan = resolve })
      }
      if (url.includes('/parameters') && method === 'GET') {
        return successResponse(runtimeParams({ version: 4, detectionRangeM: 44448, style: 'BARRAGE', elevation: 0, plannedStartFrame: 300, plannedStopFrame: 900 }))
      }
      return successResponse({})
    }))
    const wrapper = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const startInput = () => inputByTestId(wrapper, 'rf-plan-start')!
    const stopInput = () => inputByTestId(wrapper, 'rf-plan-stop')!
    const saveButton = () => wrapper.findAll('button').find(button => button.text().includes('保存计划'))!

    // 提交 300/900，请求未返回前改为 450/900。
    startInput().vm.$emit('update:modelValue', 300)
    stopInput().vm.$emit('update:modelValue', 900)
    await nextTick()
    await saveButton().trigger('click')
    await nextTick()
    startInput().vm.$emit('update:modelValue', 450)
    await nextTick()

    // 服务端按提交快照 300/900 保存；页面保留 450/900 并显示未保存。
    resolvePlan(successResponse(planSaved({ plannedStartFrame: 300, plannedStopFrame: 900 })))
    await flushPromises()
    await nextTick()
    expect(JSON.parse(planBodies[0]!)).toMatchObject({ plannedStartFrame: 300, plannedStopFrame: 900 })
    expect(useTelemetryStore().jammerRuntimeParameters['RUN-001|JAM-WB-01-TX'])
      .toMatchObject({ plannedStartFrame: 300, plannedStopFrame: 900 })
    expect(startInput().props('modelValue')).toBe(450)
    expect(wrapper.get('[data-testid="rf-plan-status"]').text()).toContain('计划：未保存')

    // 再保存当前 450/900 成功后才显示已保存。
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith('/plan') && method === 'PUT') return successResponse(planSaved({ plannedStartFrame: 450, plannedStopFrame: 900 }))
      if (url.includes('/parameters') && method === 'GET') {
        return successResponse(runtimeParams({ version: 4, detectionRangeM: 44448, style: 'BARRAGE', elevation: 0, plannedStartFrame: 450, plannedStopFrame: 900 }))
      }
      return successResponse({})
    }))
    await saveButton().trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="rf-plan-status"]').text()).toContain('计划：已保存（本地）'))
    expect(startInput().props('modelValue')).toBe(450)
    wrapper.unmount()
  })

  it('保存期间切换设备：晚返回的旧保存不污染当前设备', async () => {
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    scenarioStore.$patch({
      draft: buildDraft({
        jammerBandwidth: 200,
        extraJammers: [{
          id: 'JAM-SPOT-01-TX', platformId: 'STN-01', type: 'SPOT', defaultPower: 1,
          frequency: 2200, bandwidth: 5, detectionRange: 44448, jammingRange: 44448,
        }],
      }),
      panelState: 'SUCCESS',
    })
    telemetryStore.$patch({ frame: buildFrame({ jammerBandwidth: 200 }), capabilityState: 'SUCCESS' })
    let resolvePlan!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith('/plan') && method === 'PUT') return new Promise<Response>((resolve) => { resolvePlan = resolve })
      if (url.includes('/parameters') && method === 'GET') {
        return successResponse(url.includes('JAM-SPOT-01-TX')
          ? runtimeParams({ taskId: 'TASK-001', jammerId: 'JAM-SPOT-01-TX', version: 4, detectionRangeM: 44448 })
          : runtimeParams({ version: 4, detectionRangeM: 44448, style: 'BARRAGE', elevation: 0, plannedStartFrame: 300, plannedStopFrame: 900 }))
      }
      return successResponse({})
    }))
    const wrapper = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    inputByTestId(wrapper, 'rf-plan-start')!.vm.$emit('update:modelValue', 300)
    inputByTestId(wrapper, 'rf-plan-stop')!.vm.$emit('update:modelValue', 900)
    await nextTick()
    await wrapper.findAll('button').find(button => button.text().includes('保存计划'))!.trigger('click')
    await nextTick()

    // 保存未返回时切换到第二台设备。
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'JAM-SPOT-01-TX')
    await flushPromises()
    resolvePlan(successResponse(planSaved({ jammerId: 'JAM-WB-01-TX', plannedStartFrame: 300, plannedStopFrame: 900 })))
    await flushPromises()
    await nextTick()

    expect(wrapper.get('[data-testid="rf-plan-status"]').text()).toContain('计划：未保存')
    expect(inputByTestId(wrapper, 'rf-plan-start')!.props('modelValue')).toBeUndefined()
    wrapper.unmount()
  })

  it('保存期间切到已有计划的设备 B：B 立即回填已保存计划，A 晚返回不覆盖 B', async () => {
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    scenarioStore.$patch({
      draft: buildDraft({
        jammerBandwidth: 200,
        extraJammers: [{
          id: 'JAM-SPOT-01-TX', platformId: 'STN-01', type: 'SPOT', defaultPower: 1,
          frequency: 2200, bandwidth: 5, detectionRange: 44448, jammingRange: 44448,
        }],
      }),
      panelState: 'SUCCESS',
    })
    telemetryStore.$patch({ frame: buildFrame({ jammerBandwidth: 200 }), capabilityState: 'SUCCESS' })
    let resolvePlan!: (value: Response) => void
    let aPlan: Partial<JammerRuntimeParameters> = {}
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith('/plan') && method === 'PUT') return new Promise<Response>((resolve) => { resolvePlan = resolve })
      if (url.includes('/parameters') && method === 'GET') {
        return successResponse(url.includes('JAM-SPOT-01-TX')
          ? runtimeParams({ jammerId: 'JAM-SPOT-01-TX', style: 'SPOT', elevation: 5, plannedStartFrame: 100, plannedStopFrame: 200 })
          : runtimeParams(aPlan))
      }
      return successResponse({})
    }))
    const wrapper = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const startInput = () => inputByTestId(wrapper, 'rf-plan-start')!
    const stopInput = () => inputByTestId(wrapper, 'rf-plan-stop')!
    const status = () => wrapper.get('[data-testid="rf-plan-status"]').text()

    inputByTestId(wrapper, 'rf-plan-start')!.vm.$emit('update:modelValue', 300)
    inputByTestId(wrapper, 'rf-plan-stop')!.vm.$emit('update:modelValue', 900)
    await nextTick()
    await wrapper.findAll('button').find(button => button.text().includes('保存计划'))!.trigger('click')
    await nextTick()
    // A 保存未返回时切到已有计划的 B：B 应立即回填 100/200 并显示已保存。
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'JAM-SPOT-01-TX')
    await flushPromises()
    expect(startInput().props('modelValue')).toBe(100)
    expect(stopInput().props('modelValue')).toBe(200)
    expect(status()).toContain('计划：已保存（本地）')

    // A 的旧保存晚返回：不得覆盖 B。
    aPlan = { style: 'BARRAGE', elevation: 0, plannedStartFrame: 300, plannedStopFrame: 900 }
    resolvePlan(successResponse(planSaved({ jammerId: 'JAM-WB-01-TX', plannedStartFrame: 300, plannedStopFrame: 900 })))
    await flushPromises()
    await nextTick()
    expect(startInput().props('modelValue')).toBe(100)
    expect(stopInput().props('modelValue')).toBe(200)
    expect(status()).toContain('计划：已保存（本地）')

    // 切回 A：读取层 300/900 显示已保存。
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'JAM-WB-01-TX')
    await flushPromises()
    expect(startInput().props('modelValue')).toBe(300)
    expect(stopInput().props('modelValue')).toBe(900)
    expect(status()).toContain('计划：已保存（本地）')
    wrapper.unmount()
  })

  it('保存期间切到无计划设备 B：A 晚返回不标记 B 已保存，切回 A 显示已保存', async () => {
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    scenarioStore.$patch({
      draft: buildDraft({
        jammerBandwidth: 200,
        extraJammers: [{
          id: 'JAM-SPOT-01-TX', platformId: 'STN-01', type: 'SPOT', defaultPower: 1,
          frequency: 2200, bandwidth: 5, detectionRange: 44448, jammingRange: 44448,
        }],
      }),
      panelState: 'SUCCESS',
    })
    telemetryStore.$patch({ frame: buildFrame({ jammerBandwidth: 200 }), capabilityState: 'SUCCESS' })
    let resolvePlan!: (value: Response) => void
    let aPlan: Partial<JammerRuntimeParameters> = {}
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith('/plan') && method === 'PUT') return new Promise<Response>((resolve) => { resolvePlan = resolve })
      if (url.includes('/parameters') && method === 'GET') {
        return successResponse(url.includes('JAM-SPOT-01-TX')
          ? runtimeParams({ jammerId: 'JAM-SPOT-01-TX' })
          : runtimeParams(aPlan))
      }
      return successResponse({})
    }))
    const wrapper = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const startInput = () => inputByTestId(wrapper, 'rf-plan-start')!
    const stopInput = () => inputByTestId(wrapper, 'rf-plan-stop')!
    const status = () => wrapper.get('[data-testid="rf-plan-status"]').text()

    inputByTestId(wrapper, 'rf-plan-start')!.vm.$emit('update:modelValue', 300)
    inputByTestId(wrapper, 'rf-plan-stop')!.vm.$emit('update:modelValue', 900)
    await nextTick()
    await wrapper.findAll('button').find(button => button.text().includes('保存计划'))!.trigger('click')
    await nextTick()
    // 切到无计划的 B；A 晚返回后 B 仍不应显示已保存。
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'JAM-SPOT-01-TX')
    await flushPromises()
    aPlan = { style: 'BARRAGE', elevation: 0, plannedStartFrame: 300, plannedStopFrame: 900 }
    resolvePlan(successResponse(planSaved({ jammerId: 'JAM-WB-01-TX', plannedStartFrame: 300, plannedStopFrame: 900 })))
    await flushPromises()
    await nextTick()
    // B 手工输入 300/900 + BARRAGE：仍为未保存（旧响应未写入快照）。
    wrapper.findComponent({ name: 'ElRadioGroup' }).vm.$emit('change', 'BARRAGE')
    startInput().vm.$emit('update:modelValue', 300)
    stopInput().vm.$emit('update:modelValue', 900)
    await nextTick()
    expect(status()).toContain('计划：未保存')

    // 切回 A：读取层 300/900 显示已保存。
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'JAM-WB-01-TX')
    await flushPromises()
    expect(startInput().props('modelValue')).toBe(300)
    expect(stopInput().props('modelValue')).toBe(900)
    expect(status()).toContain('计划：已保存（本地）')
    wrapper.unmount()
  })

  it('A 保存中切 B 再切回 A：A 返回后回填 300/900 并显示已保存', async () => {
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    useScenarioStore().$patch({
      draft: buildDraft({
        jammerBandwidth: 200,
        extraJammers: [{
          id: 'JAM-SPOT-01-TX', platformId: 'STN-01', type: 'SPOT', defaultPower: 1,
          frequency: 2200, bandwidth: 5, detectionRange: 44448, jammingRange: 44448,
        }],
      }),
      panelState: 'SUCCESS',
    })
    useTelemetryStore().$patch({ frame: buildFrame({ jammerBandwidth: 200 }), capabilityState: 'SUCCESS' })
    let resolvePlan!: (value: Response) => void
    let aPlan: Partial<JammerRuntimeParameters> = {}
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith('/plan') && method === 'PUT') return new Promise<Response>((resolve) => { resolvePlan = resolve })
      if (url.includes('/parameters') && method === 'GET') {
        return successResponse(url.includes('JAM-SPOT-01-TX')
          ? runtimeParams({ jammerId: 'JAM-SPOT-01-TX', style: 'SPOT', elevation: 5, plannedStartFrame: 100, plannedStopFrame: 200 })
          : runtimeParams(aPlan))
      }
      return successResponse({})
    }))
    const wrapper = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const startInput = () => inputByTestId(wrapper, 'rf-plan-start')!
    const stopInput = () => inputByTestId(wrapper, 'rf-plan-stop')!
    const status = () => wrapper.get('[data-testid="rf-plan-status"]').text()

    startInput().vm.$emit('update:modelValue', 300)
    stopInput().vm.$emit('update:modelValue', 900)
    await nextTick()
    await wrapper.findAll('button').find(button => button.text().includes('保存计划'))!.trigger('click')
    await nextTick()
    // A 保存未返回时切到 B 再切回 A（切回时读取层尚无计划，表单会被清空）。
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'JAM-SPOT-01-TX')
    await flushPromises()
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'JAM-WB-01-TX')
    await flushPromises()

    aPlan = { style: 'BARRAGE', elevation: 0, plannedStartFrame: 300, plannedStopFrame: 900 }
    resolvePlan(successResponse(planSaved({ jammerId: 'JAM-WB-01-TX', plannedStartFrame: 300, plannedStopFrame: 900 })))
    await flushPromises()
    await nextTick()
    // 用服务端响应回填，切回后表单不再为空。
    expect(startInput().props('modelValue')).toBe(300)
    expect(stopInput().props('modelValue')).toBe(900)
    expect(status()).toContain('计划：已保存（本地）')
    expect(useTelemetryStore().jammerRuntimeParameters['RUN-001|JAM-WB-01-TX']?.plannedStartFrame).toBe(300)
    wrapper.unmount()
  })

  it('A 保存中切 B 再切回 A 后改 450：A 返回保留 450 且显示未保存', async () => {
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    useScenarioStore().$patch({
      draft: buildDraft({
        jammerBandwidth: 200,
        extraJammers: [{
          id: 'JAM-SPOT-01-TX', platformId: 'STN-01', type: 'SPOT', defaultPower: 1,
          frequency: 2200, bandwidth: 5, detectionRange: 44448, jammingRange: 44448,
        }],
      }),
      panelState: 'SUCCESS',
    })
    useTelemetryStore().$patch({ frame: buildFrame({ jammerBandwidth: 200 }), capabilityState: 'SUCCESS' })
    let resolvePlan!: (value: Response) => void
    let aPlan: Partial<JammerRuntimeParameters> = {}
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith('/plan') && method === 'PUT') return new Promise<Response>((resolve) => { resolvePlan = resolve })
      if (url.includes('/parameters') && method === 'GET') {
        return successResponse(url.includes('JAM-SPOT-01-TX')
          ? runtimeParams({ jammerId: 'JAM-SPOT-01-TX', style: 'SPOT', elevation: 5, plannedStartFrame: 100, plannedStopFrame: 200 })
          : runtimeParams(aPlan))
      }
      return successResponse({})
    }))
    const wrapper = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const startInput = () => inputByTestId(wrapper, 'rf-plan-start')!
    const stopInput = () => inputByTestId(wrapper, 'rf-plan-stop')!
    const status = () => wrapper.get('[data-testid="rf-plan-status"]').text()

    startInput().vm.$emit('update:modelValue', 300)
    stopInput().vm.$emit('update:modelValue', 900)
    await nextTick()
    await wrapper.findAll('button').find(button => button.text().includes('保存计划'))!.trigger('click')
    await nextTick()
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'JAM-SPOT-01-TX')
    await flushPromises()
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'JAM-WB-01-TX')
    await flushPromises()
    // 切回 A 后、A 返回前用户再次编辑为 450。
    startInput().vm.$emit('update:modelValue', 450)
    await nextTick()

    aPlan = { style: 'BARRAGE', elevation: 0, plannedStartFrame: 300, plannedStopFrame: 900 }
    resolvePlan(successResponse(planSaved({ jammerId: 'JAM-WB-01-TX', plannedStartFrame: 300, plannedStopFrame: 900 })))
    await flushPromises()
    await nextTick()
    expect(startInput().props('modelValue')).toBe(450)
    expect(status()).toContain('计划：未保存')
    wrapper.unmount()
  })

  it('A 保存中切 B 再切回 A；A 返回后强制 GET 失败：仍按响应回填 300/900 已保存', async () => {
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    useScenarioStore().$patch({
      draft: buildDraft({
        jammerBandwidth: 200,
        extraJammers: [{
          id: 'JAM-SPOT-01-TX', platformId: 'STN-01', type: 'SPOT', defaultPower: 1,
          frequency: 2200, bandwidth: 5, detectionRange: 44448, jammingRange: 44448,
        }],
      }),
      panelState: 'SUCCESS',
    })
    useTelemetryStore().$patch({ frame: buildFrame({ jammerBandwidth: 200 }), capabilityState: 'SUCCESS' })
    let resolvePlan!: (value: Response) => void
    let failGet = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith('/plan') && method === 'PUT') return new Promise<Response>((resolve) => { resolvePlan = resolve })
      if (url.includes('/parameters') && method === 'GET') {
        if (failGet && url.includes('JAM-WB-01-TX')) {
          return { ok: false, status: 500, json: vi.fn().mockResolvedValue({ ok: false }) } as unknown as Response
        }
        return successResponse(url.includes('JAM-SPOT-01-TX')
          ? runtimeParams({ jammerId: 'JAM-SPOT-01-TX', style: 'SPOT', elevation: 5, plannedStartFrame: 100, plannedStopFrame: 200 })
          : runtimeParams())
      }
      return successResponse({})
    }))
    const wrapper = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const startInput = () => inputByTestId(wrapper, 'rf-plan-start')!
    const stopInput = () => inputByTestId(wrapper, 'rf-plan-stop')!
    const status = () => wrapper.get('[data-testid="rf-plan-status"]').text()

    startInput().vm.$emit('update:modelValue', 300)
    stopInput().vm.$emit('update:modelValue', 900)
    await nextTick()
    await wrapper.findAll('button').find(button => button.text().includes('保存计划'))!.trigger('click')
    await nextTick()
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'JAM-SPOT-01-TX')
    await flushPromises()
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'JAM-WB-01-TX')
    await flushPromises()

    failGet = true
    resolvePlan(successResponse(planSaved({ jammerId: 'JAM-WB-01-TX', plannedStartFrame: 300, plannedStopFrame: 900 })))
    await flushPromises()
    await nextTick()
    // 强制 GET 失败也不能把表单留空：按服务端响应回填。
    expect(startInput().props('modelValue')).toBe(300)
    expect(stopInput().props('modelValue')).toBe(900)
    expect(status()).toContain('计划：已保存（本地）')
    wrapper.unmount()
  })

  it('俯仰范围校验阻止非法值；成功后区分“命令已发送”与“引擎未执行”', async () => {
    setup(200)
    const wrapper = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })
    const elevationInput = inputByTestId(wrapper, 'rf-elevation')
    if (elevationInput === undefined) throw new Error('俯仰角控件缺失')

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    elevationInput.vm.$emit('update:modelValue', 61)
    await nextTick()
    const executeButton = wrapper.findAll('button').find(button => button.text().includes('执行命令'))
    if (executeButton === undefined) throw new Error('执行按钮缺失')
    await executeButton.trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('俯仰角必须在 -10～60° 之间。')
    expect(fetchSpy).not.toHaveBeenCalled()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse({
      taskId: 'TASK-001', jammerId: 'JAM-WB-01-TX', enabled: true, frequency: 2200, bandwidth: 200,
      power: 1, direction: 0, duration: 1, executionStatus: 'SUCCESS', effectiveFrameId: 'F-00042', reason: '任务手动启扰',
    })))
    elevationInput.vm.$emit('update:modelValue', -5)
    await nextTick()
    await executeButton.trigger('click')
    await vi.waitFor(() => expect(useTelemetryStore().jammerControlState).toBe('SUCCESS'))
    const strip = wrapper.get('[data-testid="rf-plan-status"]').text()
    expect(strip).toContain('命令：已发送（本地投影）')
    expect(strip).toContain('引擎：未接入（无执行回执）')
    expect(strip).not.toContain('引擎已执行')
    wrapper.unmount()
  })
})

describe('F07 干扰参数同步（探测范围/编辑保护/读取层归属）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function setup(jammerBandwidth = 40) {
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    scenarioStore.$patch({ draft: buildDraft({ jammerBandwidth }), panelState: 'SUCCESS' })
    telemetryStore.$patch({ frame: buildFrame({ jammerBandwidth }), capabilityState: 'SUCCESS' })
  }

  it('探测范围：编辑/校验失败/提交失败不改已接受值；只有成功响应才更新为 25000 并在后续帧/重新加载保持', async () => {
    setup(40)
    const telemetryStore = useTelemetryStore()
    let currentRuntime = runtimeParams({ version: 4, detectionRangeM: 44448 })
    let postFails = false
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/parameters') && method === 'POST') {
        if (postFails) return { ok: false, status: 422, json: vi.fn().mockResolvedValue({ ok: false, error: { code: 'OUT_OF_RANGE', message: '探测范围非法。' } }) } as unknown as Response
        currentRuntime = runtimeParams({ version: 5, detectionRangeM: 25000 })
        return successResponse(syncResult(40, 25000))
      }
      if (url.includes('/parameters') && method === 'GET') return successResponse(currentRuntime)
      return successResponse({})
    })
    vi.stubGlobal('fetch', spy)
    const wrapper = mount(JammerSyncPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    // 首挂载/空缓存从读取接口恢复：已接受 44448 m = 44.448 km。
    await telemetryStore.loadJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX', { force: true })
    await nextTick()
    const label = () => wrapper.get('[data-testid="sync-detection-range"]').text()
    expect(label()).toContain('44.448 km')
    wrapper.findAllComponents({ name: 'ElSelect' })[1]!.vm.$emit('update:modelValue', 30)
    const rangeInput = inputByTestId(wrapper, 'jammer-sync-detection-range')
    if (rangeInput === undefined) throw new Error('探测范围控件缺失')
    const syncButton = wrapper.findAll('button').find(button => button.text().includes('同步参数'))!
    const posts = () => spy.mock.calls.filter(call => ((call[1] as RequestInit | undefined)?.method ?? 'GET') === 'POST')

    // 仅编辑（未提交）不改变“本地已接受”回显。
    rangeInput.vm.$emit('update:modelValue', 25)
    await nextTick()
    expect(label()).toContain('44.448 km')

    // 客户端非法校验被拒绝：不提交、已接受值不变。
    rangeInput.vm.$emit('update:modelValue', 150)
    await nextTick()
    await syncButton.trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('探测范围必须在 1～100 km 之间。')
    expect(posts()).toHaveLength(0)
    expect(label()).toContain('44.448 km')

    // 服务端提交失败：不改变已接受值，输入保留可重试。
    rangeInput.vm.$emit('update:modelValue', 25)
    await nextTick()
    postFails = true
    await syncButton.trigger('click')
    await vi.waitFor(() => expect(telemetryStore.syncState).toBe('ERROR'))
    expect(label()).toContain('44.448 km')
    expect(rangeInput.props('modelValue')).toBe(25)

    // 重试成功：只有成功响应才把已接受值更新为 25000（25 km）。
    postFails = false
    await syncButton.trigger('click')
    await vi.waitFor(() => expect(telemetryStore.syncState).toBe('SUCCESS'))
    const body = JSON.parse((posts().at(-1)![1] as RequestInit).body as string) as { detectionRangeM?: number }
    expect(body.detectionRangeM).toBe(25000)
    expect(telemetryStore.jammerRuntimeParameters['RUN-001|JAM-WB-01-TX']?.detectionRangeM).toBe(25000)
    expect(label()).toContain('25 km')

    // 后续帧（同运行不同帧）仍按读取层回显，不被覆盖。
    telemetryStore.$patch({ frame: { ...structuredClone(fixtureFrame), frameId: 'F-00043' } })
    await nextTick()
    expect(label()).toContain('25 km')

    // 重新加载读取层（GET）返回 25000 而非场景 44448。
    const reloaded = await telemetryStore.loadJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX', { force: true })
    expect(reloaded?.detectionRangeM).toBe(25000)
    wrapper.unmount()
  })

  it('旧请求不含探测范围仍兼容（版本检查保留）', async () => {
    setup(40)
    const telemetryStore = useTelemetryStore()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse(syncResult(40, 44448))))
    const legacySet = {
      version: 5, effectiveFrameId: 'F-00042' as const,
      parameters: { enabled: true, frequency: 2200, bandwidth: 40, power: 1, direction: 0, duration: 1 },
    }
    await expect(telemetryStore.synchronizeJammerParameters('TASK-001', 'JAM-WB-01-TX', legacySet)).resolves.toBe(true)
  })

  it('编辑期间来新帧不覆盖正在编辑的值，失焦后再同步', async () => {
    setup(40)
    const telemetryStore = useTelemetryStore()
    const wrapper = mount(JammerSyncPanel, { global: { plugins: [ElementPlus] } })
    const frequencyInput = () => wrapper.findAllComponents({ name: 'ElInputNumber' })[1]!
    frequencyInput().vm.$emit('update:modelValue', 999)
    await nextTick()
    expect(frequencyInput().props('modelValue')).toBe(999)

    await wrapper.get('form').trigger('focusin')
    telemetryStore.$patch({ frame: { ...structuredClone(fixtureFrame), frameId: 'F-00043' } })
    await nextTick()
    expect(frequencyInput().props('modelValue')).toBe(999)

    await wrapper.get('form').trigger('focusout')
    telemetryStore.$patch({ frame: { ...structuredClone(fixtureFrame), frameId: 'F-00044' } })
    await nextTick()
    expect(frequencyInput().props('modelValue')).toBe(2200)
    wrapper.unmount()
  })

  it('切换设备后旧请求晚返回不污染当前选择（显示待同步，而非完成）', async () => {
    setup(40)
    const scenarioStore = useScenarioStore()
    scenarioStore.$patch({ draft: buildDraft({
      extraJammers: [{
        id: 'JAM-SPOT-01-TX', platformId: 'STN-01', type: 'SPOT', defaultPower: 1,
        frequency: 2200, bandwidth: 5, detectionRange: 44448, jammingRange: 44448,
      }],
    }) })
    let resolveFetch!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (String(input).includes('/parameters') && method === 'POST') return new Promise<Response>((resolve) => { resolveFetch = resolve })
      if (String(input).includes('/parameters')) return Promise.resolve(successResponse(runtimeParams()))
      return Promise.resolve(successResponse({}))
    }))
    const wrapper = mount(JammerSyncPanel, { global: { plugins: [ElementPlus] } })
    wrapper.findAllComponents({ name: 'ElSelect' })[1]!.vm.$emit('update:modelValue', 30)
    inputByTestId(wrapper, 'jammer-sync-detection-range')!.vm.$emit('update:modelValue', 25)
    await nextTick()
    await wrapper.findAll('button').find(button => button.text().includes('同步参数'))!.trigger('click')
    await nextTick()

    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'JAM-SPOT-01-TX')
    await nextTick()
    resolveFetch(successResponse(syncResult(40, 44448)))
    await flushPromises()
    await nextTick()

    expect(wrapper.get('[data-testid="jammer-sync-state"]').text()).toBe('待同步')
    wrapper.unmount()
  })
})

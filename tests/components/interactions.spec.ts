import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import CompositeLossExample from '../../src/components/interactions/CompositeLossExample.vue'
import EsmSensorPanel from '../../src/components/interactions/EsmSensorPanel.vue'
import RfJammerPanel from '../../src/components/interactions/RfJammerPanel.vue'
import SnrBerExample from '../../src/components/interactions/SnrBerExample.vue'
import InteractionsPage from '../../src/pages/interactions/interactions.vue'
import type { DetectionEvent, Principal, ScenarioDraft, Sensor, SensorUiExtension, SwitchEvent, TelemetryFrame } from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'
import { useSimulationStore } from '../../src/stores/simulation'
import { useTelemetryStore } from '../../src/stores/telemetry'

const frame = fixtureSource.frame as unknown as TelemetryFrame
const events = fixtureSource.events as unknown as Array<DetectionEvent | SwitchEvent>
const scenarioDraft: ScenarioDraft = {
  config: structuredClone(fixtureSource.scenario) as ScenarioDraft['config'],
  uiExtensions: {
    jammers: [],
    sensors: [{ sensorId: 'ESM-01', type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true }],
  },
  revision: 4,
  officialLibraryChanged: false,
  locked: false,
}
const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'],
}

/** 创建统一成功响应。 */
function successResponse(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

describe('感知、干扰与选路页面', () => {
  it('保留控制、参数同步及诊断入口，页面标注本地演示/校验来源且不显示 Mock 文案', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    useScenarioStore().$patch({ draft: structuredClone(scenarioDraft), panelState: 'SUCCESS' })
    useTelemetryStore().$patch({ frame: structuredClone(frame), events: structuredClone(events), capabilityState: 'SUCCESS' })
    const wrapper = mount(InteractionsPage, { global: { plugins: [pinia, ElementPlus], stubs: { RouterLink: true } } })
    try {
      await flushPromises()
      expect(wrapper.get('[data-testid="rf-jammer-panel"]').text()).toContain('RF 干扰机控制')
      expect(wrapper.text()).toContain('干扰参数同步')
      expect(wrapper.text()).toContain('状态示例与错误目录')
      expect(wrapper.find('[aria-label="界面状态示例"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="error-catalog"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('频率边界')
      expect(wrapper.text()).toContain('默认功率')
      expect(wrapper.text()).toContain('时长上限')
      expect(wrapper.text()).not.toContain('Mock')
      expect(wrapper.get('[data-testid="interactions-source-note"]').text()).toContain('本地演示/校验投影')
      expect(wrapper.text()).toContain('真实引擎执行')
      expect(wrapper.find('.rf-panel__boundary').exists()).toBe(false)
    } finally { wrapper.unmount() }
  })
})

describe('P4-1 ESM 传感器与侦测', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('展示配置、侦测事件和固定证据五态反馈', async () => {
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    scenarioStore.$patch({ draft: structuredClone(scenarioDraft), panelState: 'SUCCESS' })
    telemetryStore.$patch({
      frame: structuredClone(frame),
      events: structuredClone(events),
      capabilityState: 'SUCCESS',
    })
    const wrapper = mount(EsmSensorPanel, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="esm-state"]').text()).toBe('已发现')
    expect(wrapper.text()).toContain('2000–5000 MHz')
    expect(wrapper.text()).toContain('150 km')
    expect(wrapper.text()).toContain('高空前出中继节点（UAV-01）')
    expect(wrapper.text()).toContain('95%')
    expect(wrapper.text()).toContain('42 s')

    for (const [state, label] of [
      ['LOADING', '加载中'], ['VALIDATING', '校验中'],
    ] as const) {
      telemetryStore.capabilityState = state
      await nextTick()
      expect(wrapper.get('[data-testid="esm-state"]').text()).toBe(label)
    }

    telemetryStore.$patch({ capabilityState: 'SUCCESS', events: [] })
    await nextTick()
    // 没有任何侦测事件时不得写“未检出”，只有可信 detected=false 才是未检出。
    expect(wrapper.get('[data-testid="esm-state"]').text()).toBe('暂无数据')
    expect(wrapper.text()).toContain('当前帧暂无该传感器侦测数据')

    telemetryStore.$patch({ capabilityState: 'SUCCESS', events: [{ ...structuredClone(events[0] as DetectionEvent), detected: false }] })
    await nextTick()
    expect(wrapper.get('[data-testid="esm-state"]').text()).toBe('未检出')
    expect(wrapper.text()).toContain('未发现')

    telemetryStore.events = [{ ...structuredClone(events[0] as DetectionEvent), targetPlatformId: 'UNKNOWN' }]
    await nextTick()
    expect(wrapper.get('[data-testid="esm-state"]').text()).toBe('数据错误')
    expect(wrapper.text()).toContain('侦测目标不存在')

    telemetryStore.$patch({
      events: [structuredClone(events[0] as DetectionEvent)],
      resultCode: 'DUPLICATE_EVENT',
    })
    await nextTick()
    expect(wrapper.text()).toContain('重复侦测事件已忽略')
  })

  it('通过实时入口追加同传感器事件并展示最新侦测', async () => {
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    scenarioStore.$patch({ draft: structuredClone(scenarioDraft), panelState: 'SUCCESS' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      successResponse(String(input).endsWith('/events') ? fixtureSource.events : frame),
    )))
    await expect(telemetryStore.loadFrame()).resolves.toBe(true)
    const latest = {
      ...structuredClone(events[0] as DetectionEvent),
      eventId: 'DET-NEW',
      dedupeKey: 'DET-NEW',
    }
    const wrapper = mount(EsmSensorPanel, { global: { plugins: [ElementPlus] } })

    expect(telemetryStore.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'jammer.event', taskId: 'TASK-001', sequence: 1,
      simulationTime: 42, frameId: 'F-00042', payload: latest,
    })).toBe(true)
    await nextTick()

    expect(wrapper.get('[data-testid="esm-state"]').text()).toBe('已发现')
    expect(wrapper.text()).toContain('DET-NEW')
    expect(wrapper.text()).not.toContain('存在重复侦测事件')
  })
})

describe('P4-2 RF 干扰机控制', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('展示设备能力并在执行后显示确认与生效帧', async () => {
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    const draft: ScenarioDraft = {
      ...structuredClone(scenarioDraft),
      config: structuredClone(fixtureSource.scenario) as ScenarioDraft['config'],
      uiExtensions: {
        ...scenarioDraft.uiExtensions,
        jammers: [
          { jammerId: 'JAM-WB-01-TX', direction: 0, enabled: true },
          { jammerId: 'JAM-SPOT-01-TX', direction: 0, enabled: false },
        ],
      },
    }
    scenarioStore.$patch({ draft, panelState: 'SUCCESS' })
    telemetryStore.$patch({ frame: structuredClone(frame), capabilityState: 'SUCCESS' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse({
      taskId: 'TASK-001',
      jammerId: 'JAM-WB-01-TX',
      enabled: true,
      frequency: 2200,
      bandwidth: 40,
      power: 1,
      direction: 0,
      duration: 1,
      executionStatus: 'SUCCESS',
      effectiveFrameId: 'F-00042',
      reason: '任务手动启扰',
    })))

    const wrapper = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })
    expect(wrapper.text()).toContain('2180–2220 MHz')
    expect(wrapper.text()).toContain('72 W')
    // 历史回显 72 W 超出受控档位，仅提示；选择合法档位 +30 dBm（1 W）后再执行。
    expect(wrapper.find('[data-testid="rf-power-legacy-warning"]').exists()).toBe(true)
    const selects = wrapper.findAllComponents({ name: 'ElSelect' })
    selects[1]?.vm.$emit('update:modelValue', 30)
    await nextTick()
    const executeButton = wrapper.findAll('button').find((button) => button.text().includes('执行命令'))
    if (executeButton === undefined) throw new Error('未找到 RF 干扰控制执行按钮')
    await executeButton.trigger('click')
    await vi.waitFor(() => expect(telemetryStore.jammerControlState).toBe('SUCCESS'))

    expect(wrapper.get('[data-testid="rf-state"]').text()).toBe('命令已发送')
    expect(wrapper.text()).toContain('任务手动启扰，生效帧 F-00042。')
    expect(wrapper.text()).toContain('1 W / 2200 MHz / 1 s')
    expect(wrapper.get('[data-testid="rf-result-source"]').text()).toContain('本地演示/校验投影')
    expect(wrapper.get('[data-testid="rf-result-source"]').text()).toContain('真实设备执行未接入')
    const sentBody = JSON.parse(
      vi.mocked(fetch).mock.calls.find((call) => ((call[1] as RequestInit | undefined)?.method ?? 'GET') === 'POST')![1]!.body as string,
    ) as { power: number; direction: number; duration: number }
    expect(sentBody).toMatchObject({ direction: 0, duration: 1 })
    expect(sentBody.power).toBeCloseTo(1, 10)
  })

  it('覆盖六态并优先显示加载错误且不展示其他设备的旧结果', async () => {
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    scenarioStore.$patch({ draft: null, panelState: 'ERROR', resultMessage: '场景配置加载失败。' })
    const wrapper = mount(RfJammerPanel, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="rf-state"]').text()).toBe('执行失败')
    expect(wrapper.text()).toContain('场景配置加载失败。')
    expect(wrapper.text()).not.toContain('暂无可配置的干扰设备')

    const draft: ScenarioDraft = {
      ...structuredClone(scenarioDraft),
      config: structuredClone(fixtureSource.scenario) as ScenarioDraft['config'],
      uiExtensions: {
        ...scenarioDraft.uiExtensions,
        jammers: [
          { jammerId: 'JAM-WB-01-TX', direction: 0, enabled: true },
          { jammerId: 'JAM-SPOT-01-TX', direction: 0, enabled: false },
        ],
      },
    }
    scenarioStore.$patch({ draft, panelState: 'LOADING' })
    await nextTick()
    expect(wrapper.get('[data-testid="rf-state"]').text()).toBe('加载中')

    scenarioStore.panelState = 'SUCCESS'
    for (const [state, label] of [
      ['EMPTY', '待执行'],
      ['VALIDATING', '校验中'],
      ['EXECUTING', '执行中'],
      ['ERROR', '执行失败'],
    ] as const) {
      telemetryStore.jammerControlState = state
      telemetryStore.jammerResultMessage = state === 'ERROR' ? '命令校验失败。' : ''
      await nextTick()
      expect(wrapper.get('[data-testid="rf-state"]').text()).toBe(label)
    }
    expect(wrapper.text()).toContain('命令校验失败。')

    telemetryStore.$patch({
      jammerControlState: 'SUCCESS',
      jammerResultMessage: '任务手动启扰，生效帧 F-00042。',
      jammerState: {
        taskId: 'TASK-001',
        jammerId: 'JAM-WB-01-TX',
        enabled: true,
        frequency: 2200,
        bandwidth: 40,
        power: 72,
        direction: 360,
        duration: 1470,
        executionStatus: 'SUCCESS',
        effectiveFrameId: 'F-00042',
        reason: '任务手动启扰',
      },
    })
    await nextTick()
    // F06：真实调度与回执未接入时不得显示“执行成功”，仅表示命令已发送（本地投影）。
    expect(wrapper.get('[data-testid="rf-state"]').text()).toBe('命令已发送')
    const options = wrapper.findAllComponents({ name: 'ElOption' })
    expect(options[0]?.props('label')).toContain('宽带压制')

    wrapper.getComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', 'JAM-SPOT-01-TX')
    await nextTick()
    expect(wrapper.get('[data-testid="rf-state"]').text()).toBe('待执行')
    expect(wrapper.find('.el-result').exists()).toBe(false)
  })
})

describe('P3-4 传播损耗固定算例', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('展示四项损耗合计、模型版本和同帧链路结果', () => {
    const telemetryStore = useTelemetryStore()
    telemetryStore.$patch({ frame: structuredClone(frame), capabilityState: 'SUCCESS' })

    const wrapper = mount(CompositeLossExample, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="composite-loss-state"]').text()).toBe('算例通过')
    expect(wrapper.text()).toContain('120 + 12 + 5 + 5.5 = 142.5 dB')
    expect(wrapper.text()).toContain('COMPOSITE-LOSS-1.0')
    expect(wrapper.text()).toContain('F-00042 @ 42 s')
    expect(wrapper.text()).toContain('链路路径损耗142.5 dB')
  })

  it('覆盖实际五态并拒绝损耗分量合计错误', async () => {
    const telemetryStore = useTelemetryStore()
    telemetryStore.$patch({ frame: structuredClone(frame), capabilityState: 'SUCCESS' })
    const wrapper = mount(CompositeLossExample, { global: { plugins: [ElementPlus] } })

    const expected = {
      LOADING: '加载中', VALIDATING: '校验中',
      SUCCESS: '算例通过', EMPTY: '暂无数据', ERROR: '证据错误',
    } as const
    for (const [state, label] of Object.entries(expected)) {
      telemetryStore.capabilityState = state as keyof typeof expected
      await nextTick()
      expect(wrapper.get('[data-testid="composite-loss-state"]').text()).toBe(label)
    }

    const invalidFrame = structuredClone(frame)
    const target = invalidFrame.evidence.losses.find((item) => item.linkId === 'L-MW-01')
    if (target === undefined) throw new Error('测试固定帧缺少 L-MW-01 损耗证据')
    target.obstructionLossDb += 1
    telemetryStore.$patch({ frame: invalidFrame, capabilityState: 'SUCCESS' })
    await nextTick()

    expect(wrapper.get('[data-testid="composite-loss-state"]').text()).toBe('证据错误')
    expect(wrapper.text()).toContain('损耗分量合计与总路径损耗不一致')
  })

  it('拒绝链路损耗不一致和非同帧证据', async () => {
    const telemetryStore = useTelemetryStore()
    const mismatchedLinkFrame = structuredClone(frame)
    const link = mismatchedLinkFrame.links.find((item) => item.linkId === 'L-MW-01')
    if (link === undefined) throw new Error('测试固定帧缺少 L-MW-01 链路')
    link.pathLoss += 1
    telemetryStore.$patch({ frame: mismatchedLinkFrame, capabilityState: 'SUCCESS' })
    const wrapper = mount(CompositeLossExample, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="composite-loss-state"]').text()).toBe('证据错误')
    expect(wrapper.text()).toContain('链路结果与损耗证据不一致')

    const mismatchedFrame = structuredClone(frame)
    mismatchedFrame.evidence.synchronization.effectiveFrameId = 'F-00041'
    telemetryStore.$patch({ frame: mismatchedFrame, capabilityState: 'SUCCESS' })
    await nextTick()

    expect(wrapper.get('[data-testid="composite-loss-state"]').text()).toBe('证据错误')
    expect(wrapper.text()).toContain('损耗证据与当前帧不一致')
  })

  it('证据缺失进入空态，初始空态复用固定帧加载', async () => {
    const telemetryStore = useTelemetryStore()
    const missingFrame = structuredClone(frame)
    missingFrame.evidence.losses = missingFrame.evidence.losses.filter((item) => item.linkId !== 'L-MW-01')
    telemetryStore.$patch({ frame: missingFrame, capabilityState: 'SUCCESS' })
    const wrapper = mount(CompositeLossExample, { global: { plugins: [ElementPlus] } })
    expect(wrapper.get('[data-testid="composite-loss-state"]').text()).toBe('暂无数据')

    wrapper.unmount()
    telemetryStore.resetToSafeEmpty()
    const loadFrame = vi.spyOn(telemetryStore, 'loadFrame').mockResolvedValue(true)
    mount(CompositeLossExample, { global: { plugins: [ElementPlus] } })
    expect(loadFrame).toHaveBeenCalledWith()
  })
})

describe('P3-5 SNR/BER 固定算例', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('展示接收功率、噪声、带宽、调制编码、SNR、BER 和模型版本', () => {
    const telemetryStore = useTelemetryStore()
    telemetryStore.$patch({ frame: structuredClone(frame), capabilityState: 'SUCCESS' })

    const wrapper = mount(SnrBerExample, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="snr-ber-state"]').text()).toBe('算例通过')
    expect(wrapper.text()).toContain('-84 dBm')
    expect(wrapper.text()).toContain('-104 dBm')
    expect(wrapper.text()).toContain('20 MHz')
    expect(wrapper.text()).toContain('QPSK')
    expect(wrapper.text()).toContain('UNCODED')
    expect(wrapper.text()).toContain('18.62 dB')
    expect(wrapper.text()).toContain('3.2e-7')
    expect(wrapper.text()).toContain('SNBER-1.2')
  })

  it('通过固定帧公开加载动作保持校验态并完成算例', async () => {
    const telemetryStore = useTelemetryStore()
    let resolveEvents!: (value: unknown) => void
    const eventsPayload = new Promise<unknown>((resolve) => { resolveEvents = resolve })
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      String(input).endsWith('/events')
        ? { ok: true, json: vi.fn().mockReturnValue(eventsPayload) } as unknown as Response
        : successResponse(frame),
    )))

    const wrapper = mount(SnrBerExample, { global: { plugins: [ElementPlus] } })
    await vi.waitFor(() => expect(telemetryStore.capabilityState).toBe('VALIDATING'))
    await nextTick()
    expect(wrapper.get('[data-testid="snr-ber-state"]').text()).toBe('校验中')

    resolveEvents({ ok: true, data: fixtureSource.events })
    await vi.waitFor(() => expect(telemetryStore.capabilityState).toBe('SUCCESS'))
    expect(wrapper.get('[data-testid="snr-ber-state"]').text()).toBe('算例通过')
  })

  it('通过真实加载结果展示调制、编码和模型版本字段错误', async () => {
    for (const [field, value, code] of [
      ['coding', 'LDPC', 'UNSUPPORTED_CODING'],
      ['modulation', '16QAM', 'UNSUPPORTED_MODULATION'],
      ['qualityModelVersion', '', 'QUALITY_MODEL_VERSION_MISMATCH'],
    ] as const) {
      setActivePinia(createPinia())
      const invalidFrame = structuredClone(frame)
      const index = invalidFrame.links.findIndex((link) => link.linkId === 'L-MW-01')
      if (index < 0) throw new Error('测试固定帧缺少 L-MW-01 链路')
      Reflect.set(invalidFrame.links[index]!, field, value)
      vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
        successResponse(String(input).endsWith('/events') ? fixtureSource.events : invalidFrame),
      )))

      const telemetryStore = useTelemetryStore()
      const wrapper = mount(SnrBerExample, { global: { plugins: [ElementPlus] } })
      await vi.waitFor(() => expect(telemetryStore.capabilityState).toBe('ERROR'))

      expect(telemetryStore.frame).toBeNull()
      expect(wrapper.get('[data-testid="snr-ber-state"]').text()).toBe('证据错误')
      expect(wrapper.text()).toContain(code)
      expect(wrapper.text()).toContain(`links[${index}].${field}`)
      wrapper.unmount()
    }
  })

  it('拒绝 SNR 结果或生效帧不一致', async () => {
    const telemetryStore = useTelemetryStore()
    const invalidSnrFrame = structuredClone(frame)
    const target = invalidSnrFrame.links.find((item) => item.linkId === 'L-MW-01')
    if (target === undefined) throw new Error('测试固定帧缺少 L-MW-01 链路')
    target.snr += 1
    telemetryStore.$patch({ frame: invalidSnrFrame, capabilityState: 'SUCCESS' })
    const wrapper = mount(SnrBerExample, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="snr-ber-state"]').text()).toBe('证据错误')
    expect(wrapper.text()).toContain('接收功率、等效噪声与 SNR 不一致')

    const invalidFrame = structuredClone(frame)
    invalidFrame.evidence.synchronization.effectiveFrameId = 'F-00041'
    telemetryStore.$patch({ frame: invalidFrame, capabilityState: 'SUCCESS' })
    await nextTick()
    expect(wrapper.text()).toContain('质量证据与当前帧不一致')
  })

  it('链路缺失进入空态，初始空态复用固定帧加载', () => {
    const telemetryStore = useTelemetryStore()
    const missingFrame = structuredClone(frame)
    missingFrame.links = missingFrame.links.filter((item) => item.linkId !== 'L-MW-01')
    telemetryStore.$patch({ frame: missingFrame, capabilityState: 'SUCCESS' })
    const wrapper = mount(SnrBerExample, { global: { plugins: [ElementPlus] } })
    expect(wrapper.get('[data-testid="snr-ber-state"]').text()).toBe('暂无数据')

    wrapper.unmount()
    telemetryStore.resetToSafeEmpty()
    const loadFrame = vi.spyOn(telemetryStore, 'loadFrame').mockResolvedValue(true)
    mount(SnrBerExample, { global: { plugins: [ElementPlus] } })
    expect(loadFrame).toHaveBeenCalledWith()
  })
})

describe('P4-1b ESM 按当前场景选择传感器', () => {
  const sensorA: Sensor = { id: 'ESM-01', platformId: 'STN-01', frequencyRange: { min: 2000, max: 5000 }, detectionRange: 150000 }
  const sensorB: Sensor = { id: 'ESM-02', platformId: 'STN-01', frequencyRange: { min: 1000, max: 2000 }, detectionRange: 80000 }
  const sensorC: Sensor = { id: 'ESM-03', platformId: 'STN-01', frequencyRange: { min: 300, max: 900 }, detectionRange: 60000 }
  const extension = (sensorId: string, overrides: Partial<SensorUiExtension> = {}): SensorUiExtension => ({
    sensorId, type: 'ESM', direction: 'OMNI', probability: 0.9, enabled: true, ...overrides,
  })
  /** 用当前场景草稿构造多传感器配置，不依赖后端。 */
  function draftWith(sensorList: Sensor[], extensions: SensorUiExtension[], scenarioId: ScenarioDraft['config']['scenario']['id'] = 'SCN-001'): ScenarioDraft {
    const config = structuredClone(fixtureSource.scenario) as ScenarioDraft['config']
    config.scenario.id = scenarioId
    config.sensors = sensorList
    return { config, uiExtensions: { jammers: [], sensors: extensions }, revision: 4, officialLibraryChanged: false, locked: false }
  }
  const detectionFor = (sensorId: string, eventId: string, extra: Partial<DetectionEvent> = {}): DetectionEvent => ({
    ...structuredClone(events[0] as DetectionEvent), sensorId, eventId, dedupeKey: eventId, ...extra,
  })

  beforeEach(() => { setActivePinia(createPinia()) })

  it('默认选当前有效项，切换选择与场景变化后保留有效选择或选第一项', async () => {
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    const both = [detectionFor('ESM-01', 'DET-ESM01'), detectionFor('ESM-02', 'DET-ESM02')]
    scenarioStore.$patch({ draft: draftWith([sensorA, sensorB], [extension('ESM-01'), extension('ESM-02')]), panelState: 'SUCCESS' })
    telemetryStore.$patch({ frame: structuredClone(frame), events: both, capabilityState: 'SUCCESS' })
    const wrapper = mount(EsmSensorPanel, { global: { plugins: [ElementPlus] } })
    const select = () => wrapper.findAllComponents({ name: 'ElSelect' })[0]!
    expect(select().props('modelValue')).toBe('ESM-01')
    expect(wrapper.text()).toContain('2000–5000 MHz')
    select().vm.$emit('update:modelValue', 'ESM-02')
    await nextTick()
    expect(select().props('modelValue')).toBe('ESM-02')
    expect(wrapper.text()).toContain('1000–2000 MHz')
    scenarioStore.$patch({ draft: draftWith([sensorB, sensorC], [extension('ESM-02'), extension('ESM-03')]) })
    await nextTick()
    expect(select().props('modelValue')).toBe('ESM-02')
    scenarioStore.$patch({ draft: draftWith([sensorC], [extension('ESM-03')]) })
    await nextTick()
    expect(select().props('modelValue')).toBe('ESM-03')
    wrapper.unmount()
  })

  it('无传感器、停用、缺扩展分别给出明确空态', async () => {
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    telemetryStore.$patch({ frame: structuredClone(frame), events: structuredClone(events), capabilityState: 'SUCCESS' })
    const cases: Array<[ScenarioDraft, string, string]> = [
      [draftWith([], []), '无传感器', '当前场景未配置 ESM 传感器'],
      [draftWith([sensorA], [extension('ESM-01', { enabled: false })]), '已停用', '该 ESM 传感器已停用'],
      [draftWith([sensorA], []), '缺扩展', '该 ESM 传感器缺少界面扩展配置'],
    ]
    for (const [draft, label, text] of cases) {
      scenarioStore.$patch({ draft, panelState: 'SUCCESS' })
      const wrapper = mount(EsmSensorPanel, { global: { plugins: [ElementPlus] } })
      await nextTick()
      expect(wrapper.get('[data-testid="esm-state"]').text()).toBe(label)
      expect(wrapper.text()).toContain(text)
      wrapper.unmount()
    }
  })

  it('普通运行无固定帧显示未接入，reload 不回退默认编号也不触发 resetProjection', async () => {
    const scenarioStore = useScenarioStore()
    const simulationStore = useSimulationStore()
    const telemetryStore = useTelemetryStore()
    scenarioStore.$patch({ draft: draftWith([sensorA], [extension('ESM-01')], 'SCN-CUSTOM'), panelState: 'SUCCESS' })
    simulationStore.run = { runId: 'RUN-REAL', taskId: 'TASK-001', scenarioId: 'SCN-CUSTOM', executionSource: 'REMOTE_WS' } as unknown as typeof simulationStore.run
    telemetryStore.$patch({ frame: null, events: [], capabilityState: 'EMPTY' })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const resetSpy = vi.spyOn(simulationStore, 'resetProjection')
    const wrapper = mount(EsmSensorPanel, { global: { plugins: [ElementPlus] } })
    await nextTick()
    expect(wrapper.get('[data-testid="esm-state"]').text()).toBe('未接入')
    expect(wrapper.text()).toContain('当前运行暂无固定 ESM 侦测数据（未接入真实 ESM 遥测）')
    await wrapper.findAll('button').find((button) => button.text().includes('重新加载'))?.trigger('click')
    await nextTick()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(resetSpy).not.toHaveBeenCalled()
    wrapper.unmount()
    vi.unstubAllGlobals()
  })

  it('切换传感器清空旧侦测结果，帧不一致报证据错误', async () => {
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    const both = [detectionFor('ESM-01', 'DET-ESM01'), detectionFor('ESM-02', 'DET-ESM02')]
    scenarioStore.$patch({ draft: draftWith([sensorA, sensorB], [extension('ESM-01'), extension('ESM-02')]), panelState: 'SUCCESS' })
    telemetryStore.$patch({ frame: structuredClone(frame), events: both, capabilityState: 'SUCCESS' })
    const wrapper = mount(EsmSensorPanel, { global: { plugins: [ElementPlus] } })
    expect(wrapper.text()).toContain('DET-ESM01')
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'ESM-02')
    await nextTick()
    expect(wrapper.text()).toContain('DET-ESM02')
    expect(wrapper.text()).not.toContain('DET-ESM01')
    telemetryStore.$patch({ events: [detectionFor('ESM-02', 'DET-ESM02', { frameId: 'F-OTHER' })] })
    await nextTick()
    expect(wrapper.get('[data-testid="esm-state"]').text()).toBe('数据错误')
    expect(wrapper.text()).toContain('侦测事件与当前帧不一致')
    wrapper.unmount()
  })

  it('父页面挂载不覆盖当前草稿，也不加载 SCN-001', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenarioStore = useScenarioStore()
    const telemetryStore = useTelemetryStore()
    scenarioStore.$patch({ draft: draftWith([sensorA], [extension('ESM-01')], 'SCN-CUSTOM'), panelState: 'SUCCESS' })
    telemetryStore.$patch({ frame: structuredClone(frame), events: structuredClone(events), capabilityState: 'SUCCESS' })
    const loadSpy = vi.spyOn(scenarioStore, 'loadScenario')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(InteractionsPage, { global: { plugins: [pinia, ElementPlus], stubs: { RouterLink: true } } })
    await flushPromises()
    expect(loadSpy).not.toHaveBeenCalled()
    // 首挂载会按设备读取运行期本地参数（GET /jammers/.../parameters），但不得加载 SCN-001 场景。
    expect(fetchSpy.mock.calls.every((call) => String(call[0]).includes('/jammers/'))).toBe(true)
    expect(scenarioStore.draft?.config.scenario.id).toBe('SCN-CUSTOM')
    wrapper.unmount()
    vi.unstubAllGlobals()
  })
})

import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import L from 'leaflet'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAP_CONFIG } from '../../src/config/map.config'
import type { ConfirmationContext, Principal, SimulationRun } from '../../src/contracts/domain-models'
import type { SituationLinkView } from '../../src/features/situation/situation-model'
import type { InitialNodeSnapshot, SituationMapNode } from '../../src/features/situation/initial-nodes'
import type { PositionSnapshot } from '../../src/features/situation/position-updates'
import {
  SITUATION_EVENTS_F00042,
  SITUATION_FRAME_F00042,
  SITUATION_LINKS_F00042,
} from '../../src/features/situation/situation-model'
import { useAuthStore } from '../../src/stores/auth'
import { useTelemetryStore } from '../../src/stores/telemetry'

type SituationMapControllerOptions = {
  frame: unknown
  initialNodes?: SituationMapNode[]
  onSelectNode: (platformId: string) => void
  onSelectLink: (link: SituationLinkView) => void
}

const mapControllerMock = vi.hoisted(() => {
  const controller = {
    setFrame: vi.fn(),
    setNodes: vi.fn(),
    setLinks: vi.fn(),
    setSelectedNodeId: vi.fn(),
    focusTarget: vi.fn(),
    setLayerVisible: vi.fn(),
    setTheme: vi.fn(),
    setBasemap: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    reset: vi.fn(),
    destroy: vi.fn(),
  }

  return {
    controller,
    latestOptions: null as SituationMapControllerOptions | null,
    createSituationMapController: vi.fn((options: SituationMapControllerOptions) => {
      mapControllerMock.latestOptions = options
      return controller
    }),
  }
})

const offlineLabelLayerMock = vi.hoisted(() => ({
  create: vi.fn(),
  latestLayer: null as (L.Layer & {
    setTheme: (theme: 'dark' | 'light', redraw?: boolean) => void
  }) | null,
  setTheme: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('leaflet.vectorgrid', () => ({}))

vi.mock('../../src/components/situation/offline-vector-label-layer', () => ({
  createOfflineVectorLabelLayer: offlineLabelLayerMock.create,
}))

vi.mock('../../src/components/situation/situation-map-controller', () => ({
  createSituationMapController: mapControllerMock.createSituationMapController,
}))

import SituationPage from '../../src/pages/situation/situation.vue'

const OPERATOR: Principal = {
  userId: 'USR-OPERATOR',
  username: 'operator',
  role: 'OPERATOR',
  permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'],
}

const INITIAL_NODES: InitialNodeSnapshot = {
  fileName: 'sample.csv', sha256: 'a'.repeat(64),
  nodes: [
    { platformId: 'A', name: 'A', type: 'HIGH_ALT_COMMS_PLATFORM', longitude: -77.9617,
      latitude: 30.0024, altitude: 0, speed: 223.52, time: 0, sourceEventId: 'LOG-L7' },
    { platformId: 'B', name: 'B', type: 'Drone_MISSION_AIRCRAFT', longitude: 118.7321,
      latitude: 25.1026, altitude: 4000, speed: 0, time: 0, sourceEventId: 'LOG-L10' },
  ],
}

/** 创建组件测试使用的仿真运行投影。 */
function simulationRun(uiStatus: SimulationRun['uiStatus'], configLocked: boolean): SimulationRun {
  return {
    runId: 'RUN-001',
    taskId: 'TASK-001',
    scenarioId: 'SCN-001',
    uiStatus,
    canonical: {
      status: uiStatus === 'STOPPED' ? 'IDLE' : uiStatus,
      currentTime: 0,
      totalDuration: 7200,
      processId: uiStatus === 'RUNNING' || uiStatus === 'PAUSED' ? 2900 : null,
      progress: 0,
    },
    configLocked,
    ...(uiStatus === 'RUNNING' || uiStatus === 'PAUSED' ? { startedAt: '2026-08-06T08:05:00Z' } : {}),
  }
}

/** 创建组件测试使用的成功响应。 */
function successResponse(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

/** 为态势页提供按 URL 区分的确定性接口响应。 */
function situationFetch(fallbacks: unknown[] = [[]]) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/situation/initial-nodes')) return Promise.resolve(successResponse(null))
    if (url.includes('/frames/')) return Promise.resolve(successResponse(SITUATION_FRAME_F00042))
    if (url.endsWith('/events')) return Promise.resolve(successResponse(SITUATION_EVENTS_F00042))
    return Promise.resolve(successResponse(fallbacks.shift() ?? []))
  })
}

class SilentWebSocket {
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readonly readyState = SilentWebSocket.CONNECTING
  addEventListener(): void {}
  send(): void {}
  close(): void {}
}

describe('态势主界面', () => {
  let mountedWrapper: ReturnType<typeof mount> | null = null

  /**
   * 挂载态势主界面并登记为当前测试的待清理实例。
   * @returns 已挂载的态势页面包装器。
   * @sideeffect 向 document.body 添加页面及 Element Plus 的关联 DOM。
   */
  async function mountSituationPage() {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: OPERATOR, role: OPERATOR.role, permissions: [...OPERATOR.permissions] })
    useTelemetryStore(pinia).$patch({
      frame: structuredClone(SITUATION_FRAME_F00042),
      events: structuredClone(SITUATION_EVENTS_F00042),
      capabilityState: 'SUCCESS',
    })
    mountedWrapper = mount(SituationPage, {
      attachTo: document.body,
      global: {
        plugins: [pinia, ElementPlus],
        stubs: { RouterLink: { template: '<a><slot /></a>' } },
      },
    })
    await flushPromises()
    return mountedWrapper
  }

  beforeEach(() => {
    mapControllerMock.latestOptions = null
    vi.clearAllMocks()
    vi.stubGlobal('fetch', situationFetch())
    vi.stubGlobal('WebSocket', SilentWebSocket)
  })

  afterEach(() => {
    mountedWrapper?.unmount()
    mountedWrapper = null
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('呈现原型要求的关键区域并只读取运行快照', async () => {
    const fetchSpy = situationFetch()
    const webSocketSpy = vi.fn(function WebSocketMock() { return new SilentWebSocket() })
    Object.assign(webSocketSpy, { OPEN: 1, CONNECTING: 0 })
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('WebSocket', webSocketSpy)

    const wrapper = await mountSituationPage()
    await flushPromises()

    expect(wrapper.get('#situation-title').text()).toBe('态势主界面')
    expect(wrapper.get('[aria-label="仿真控制"]')).toBeTruthy()
    expect(wrapper.get('[aria-label="场景配置"]')).toBeTruthy()
    expect(wrapper.get('[aria-label="Leaflet 离线态势图"]')).toBeTruthy()
    expect(wrapper.get('[data-testid="leaflet-situation-map"]')).toBeTruthy()
    expect(wrapper.find('.offline-map__frame').exists()).toBe(false)
    expect(wrapper.get('.offline-map').text()).not.toContain('数据时刻')
    expect(wrapper.get('[aria-label="链路、干扰与事件"]')).toBeTruthy()
    expect(wrapper.findAll('tr[data-link-id]')).toHaveLength(10)
    expect(wrapper.get('.link-table thead').text()).toBe('链路体制SNRBER状态')
    expect(wrapper.get('tr[data-link-id="L-DL-03"] td:nth-child(2)').text()).toBe('数传')
    expect(wrapper.findAll('.link-table tbody tr.is-exception')).toHaveLength(1)
    expect(wrapper.findAll('[data-frame-id="F-00042"]').length).toBeGreaterThanOrEqual(3)
    expect(wrapper.get('[data-testid="frame-freshness"]').text()).toBe('最大数据年龄 0 ms · 新鲜')
    const footer = wrapper.get('.situation-footer')
    expect(footer.text()).not.toContain('固定帧')
    expect(footer.text()).not.toContain('数据时刻')
    expect(footer.get('.situation-footer__sequence').text()).toBe('帧序号 42')
    expect(footer.attributes('data-frame-id')).toBe('F-00042')
    expect(wrapper.get('.node-jammer-count').text()).toBe('6 / 50')
    expect(wrapper.findAll('[data-testid^="focus-node-"]')).toHaveLength(8)
    expect(wrapper.get('[aria-label="链路类型图例"]').text()).toBe(
      '卫星链路微波链路新一代数传链路激光链路受干扰 / 失效链路',
    )
    expect(wrapper.text()).toContain('4 类业务信息节点')
    expect(wrapper.text()).toContain('4 类链路')
    expect(wrapper.text()).toContain('2 种干扰设备')
    expect(wrapper.text()).toContain('空中无人作业节点 U01')
    expect(wrapper.text()).toContain('空中无人作业节点 U02')
    expect(wrapper.text()).toContain('空中无人作业节点 U03')
    expect(wrapper.text()).not.toContain('机载瞄准式干扰设备')
    expect(wrapper.text()).toContain('地面宽带压制干扰设备')
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect(fetchSpy).toHaveBeenNthCalledWith(2,
      'http://127.0.0.1:4173/api/v1/simulations',
      expect.objectContaining({ headers: { 'X-Demo-Role': 'OPERATOR' } }),
    )
    expect(webSocketSpy).toHaveBeenCalledOnce()
  })

  it('真实初始节点共享列表与地图数据，不请求 Mock 帧或启动模拟引擎', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(successResponse(INITIAL_NODES))
      .mockResolvedValue(successResponse(null))
    const webSocketSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('WebSocket', webSocketSpy)
    const wrapper = await mountSituationPage()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(webSocketSpy).not.toHaveBeenCalled()
    expect(useTelemetryStore().frame).toBeNull()
    expect(wrapper.findAll('.summary-focus-button')).toHaveLength(2)
    expect(wrapper.get('.node-jammer-count').text()).toBe('2 个')
    expect(wrapper.find('.telemetry-panel').exists()).toBe(false)
    expect(wrapper.find('.metric-panel').exists()).toBe(false)
    expect(wrapper.find('.offline-map__legend').exists()).toBe(false)
    expect(mapControllerMock.latestOptions).toMatchObject({ frame: null, initialNodes: INITIAL_NODES.nodes })
    await wrapper.get('[data-testid="focus-node-A"]').trigger('click')
    expect(mapControllerMock.controller.focusTarget).toHaveBeenCalledWith({ kind: 'node', targetId: 'A' })
    mapControllerMock.latestOptions?.onSelectNode('A')
    await flushPromises()
    expect(document.querySelector('.selected-node-dialog')?.textContent).toContain('77.9617°W')
    expect(document.querySelector('.selected-node-dialog')?.textContent).toContain('HIGH_ALT_COMMS_PLATFORM')
    expect(document.querySelector('.selected-node-dialog')?.textContent).toContain('离线底图覆盖范围之外')
    expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('真实日志读取失败不回显预置 Mock 数据，允许重新加载', async () => {
    const fetchSpy = vi.fn().mockRejectedValueOnce(new Error('读取失败'))
      .mockResolvedValueOnce(successResponse(INITIAL_NODES))
      .mockResolvedValue(successResponse(null))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage()
    expect(wrapper.text()).toContain('初始节点读取失败')
    expect(wrapper.find('.offline-map').exists()).toBe(false)
    expect(wrapper.find('.telemetry-panel').exists()).toBe(false)
    await wrapper.get('.telemetry-empty button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.summary-focus-button')).toHaveLength(2)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('追加位置持续同步地图与详情，失败保留位置，换代复位，卸载后停止轮询', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const snapshot: PositionSnapshot = {
      fileName: 'positions.csv', generation: 1, recordCount: 1, issueCount: 0, issues: [],
      waitingForLine: false, hasMore: false,
      nodes: [{ platformId: 'A', time: 1, longitude: -78, latitude: 31, altitude: 10, speed: 220, heading: -1 }],
    }
    const fetchSpy = vi.fn().mockResolvedValueOnce(successResponse(INITIAL_NODES))
      .mockResolvedValueOnce(successResponse(snapshot))
      .mockRejectedValueOnce(new Error('临时读取失败'))
      .mockResolvedValueOnce(successResponse({ ...snapshot, generation: 2, recordCount: 0, nodes: [] }))
      .mockResolvedValue(successResponse(null))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage()
    expect(wrapper.text()).toContain('位置已同步，等待追加')
    expect(wrapper.findAll('.summary-focus-button')).toHaveLength(2)
    expect(mapControllerMock.controller.setNodes).toHaveBeenLastCalledWith([
      expect.objectContaining({ platformId: 'A', longitude: -78, latitude: 31 }), INITIAL_NODES.nodes[1],
    ])
    mapControllerMock.latestOptions?.onSelectNode('A')
    await flushPromises()
    expect(document.querySelector('.selected-node-dialog')?.textContent).toContain('78°W / 31°N')
    const updates = mapControllerMock.controller.setNodes.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(wrapper.text()).toContain('保留最后位置')
    expect(mapControllerMock.controller.setNodes).toHaveBeenCalledTimes(updates)
    expect(document.querySelector('.selected-node-dialog')?.textContent).toContain('78°W / 31°N')
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(mapControllerMock.controller.setNodes).toHaveBeenLastCalledWith(INITIAL_NODES.nodes)
    expect(wrapper.get('[data-testid="focus-node-A"]').attributes('aria-pressed')).toBe('true')
    expect(mapControllerMock.createSituationMapController).toHaveBeenCalledOnce()
    wrapper.unmount()
    mountedWrapper = null
    const requests = fetchSpy.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchSpy).toHaveBeenCalledTimes(requests)
  })

  it('支持开始、暂停并在确认后停止', async () => {
    const awaiting: ConfirmationContext = {
      confirmationId: 'CONF-P2-001',
      state: 'AWAITING_CONFIRMATION',
      actor: 'operator',
      role: 'OPERATOR',
      createdAt: '2026-08-06T08:00:00Z',
      expiresAt: '2026-08-06T08:05:00Z',
    }
    const fetchSpy = situationFetch([
      [simulationRun('COMPLETED', false)],
      simulationRun('IDLE', true),
      simulationRun('RUNNING', true),
      simulationRun('PAUSED', true),
      awaiting,
      { ...awaiting, state: 'CONFIRMED' },
      simulationRun('STOPPED', false),
    ])
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage()
    await flushPromises()

    expect(wrapper.text()).not.toContain('配置可查看')
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('运行中')
    expect(wrapper.text()).toContain('场景配置已锁定')
    expect(wrapper.get('[data-testid="engine-resource"]').text()).toContain('模拟进程 2900')

    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已暂停')

    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    await flushPromises()
    const confirmButton = document.querySelector<HTMLElement>('[data-testid="confirm-stop"]')
    expect(confirmButton).not.toBeNull()
    confirmButton?.click()
    await flushPromises()

    expect(wrapper.get('[data-testid="simulation-clock"]').text()).toBe('T+ 00:00:00')
    expect(wrapper.text()).toContain('场景配置未锁定')
    expect(wrapper.get('[data-testid="engine-resource"]').text()).toContain('模拟进程资源已释放')
    expect(fetchSpy).toHaveBeenCalledTimes(10)
  })

  it('移除指标筛选框后地图、表格和计数均使用全部链路', async () => {
    const wrapper = await mountSituationPage()
    await flushPromises()

    expect(wrapper.find('.metric-panel select').exists()).toBe(false)
    expect(wrapper.findAll('tr[data-link-id]')).toHaveLength(10)
    expect(wrapper.get('tr[data-link-id="L-DL-03"]')).toBeTruthy()
    expect(wrapper.findAll('.metric-panel__item span').map((label) => label.text())).toEqual([
      '在线业务信息节点', '正常链路', '劣化链路', '中断链路',
    ])
    expect(wrapper.get('[aria-label="当前帧指标"]').text()).toContain('劣化链路1')
    expect(wrapper.get('[aria-label="当前帧指标"]').text()).toContain('正常链路9')
    expect(wrapper.get('tr[data-link-id="L-DL-03"]').text()).toContain('7.10')
    const mapLinks = mapControllerMock.controller.setLinks.mock.lastCall?.[0]
    expect(mapLinks).toHaveLength(10)
    expect(mapLinks).toEqual(expect.arrayContaining([expect.objectContaining({ linkId: 'L-DL-03' })]))
  })

  it('从左侧摘要重复定位节点、链路和干扰设备并恢复对应图层', async () => {
    const wrapper = await mountSituationPage()
    const layerButtons = wrapper.findAll('[aria-label="态势图层"] button')

    await layerButtons[0]?.trigger('click')
    await wrapper.get('[data-testid="focus-node-UAV-01"]').trigger('click')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenNthCalledWith(1, 'nodes', false)
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenNthCalledWith(2, 'nodes', true)
    expect(mapControllerMock.controller.setSelectedNodeId).not.toHaveBeenCalled()
    expect(mapControllerMock.controller.focusTarget).toHaveBeenNthCalledWith(1, {
      kind: 'node',
      targetId: 'UAV-01',
    })

    await wrapper.get('[data-testid="focus-node-UAV-01"]').trigger('click')
    expect(mapControllerMock.controller.focusTarget).toHaveBeenNthCalledWith(2, {
      kind: 'node',
      targetId: 'UAV-01',
    })

    await wrapper.findAll('.scene-summary__tabs button')[1]?.trigger('click')
    await layerButtons[1]?.trigger('click')
    await wrapper.get('[data-testid="focus-link-L-MW-01"]').trigger('click')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenCalledWith('links', false)
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenCalledWith('links', true)
    expect(mapControllerMock.controller.focusTarget).toHaveBeenNthCalledWith(3, {
      kind: 'link',
      targetId: 'L-MW-01',
    })

    await wrapper.findAll('.scene-summary__tabs button')[2]?.trigger('click')
    await layerButtons[2]?.trigger('click')
    await wrapper.get('[data-testid="focus-interference-JAM-WB-01-TX"]').trigger('click')
    expect(mapControllerMock.controller.setSelectedNodeId).not.toHaveBeenCalled()
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenCalledWith('interference', false)
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenCalledWith('interference', true)
    expect(mapControllerMock.controller.focusTarget).toHaveBeenNthCalledWith(4, {
      kind: 'interference',
      targetId: 'JAM-WB-01-TX',
    })
    expect(mapControllerMock.controller.setSelectedNodeId).not.toHaveBeenCalled()
    expect(mapControllerMock.controller.focusTarget).toHaveBeenCalledTimes(4)
    expect(mapControllerMock.latestOptions).not.toBeNull()
    mapControllerMock.latestOptions?.onSelectNode('SAT-01')
    await flushPromises()
    expect(mapControllerMock.controller.setSelectedNodeId).toHaveBeenCalledOnce()
    expect(mapControllerMock.controller.setSelectedNodeId).toHaveBeenCalledWith('SAT-01')
    expect(mapControllerMock.controller.focusTarget).toHaveBeenCalledTimes(4)
  })

  it('左右悬浮面板可独立折叠并重新展开', async () => {
    const wrapper = await mountSituationPage()
    const workspace = wrapper.get('.situation-page__workspace')
    const scenePanel = wrapper.get('[aria-label="场景配置"]')
    const telemetryPanel = wrapper.get('[aria-label="链路、干扰与事件"]')
    const sceneToggle = wrapper.get('[data-testid="toggle-scene-summary"]')
    const telemetryToggle = wrapper.get('[data-testid="toggle-telemetry-panel"]')

    expect(sceneToggle.attributes('aria-expanded')).toBe('true')
    expect(telemetryToggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-testid="situation-center"]')).toBeTruthy()

    await sceneToggle.trigger('click')
    expect(scenePanel.attributes('data-collapsed')).toBe('true')
    expect(scenePanel.classes()).toContain('is-collapsed')
    expect(workspace.classes()).toContain('situation-page__workspace--scene-collapsed')
    expect(sceneToggle.attributes('aria-label')).toBe('展开场景配置')

    await telemetryToggle.trigger('click')
    expect(telemetryPanel.attributes('data-collapsed')).toBe('true')
    expect(telemetryPanel.classes()).toContain('is-collapsed')
    expect(workspace.classes()).toContain('situation-page__workspace--telemetry-collapsed')
    expect(telemetryToggle.attributes('aria-label')).toBe('展开链路、干扰与事件')

    await sceneToggle.trigger('click')
    await telemetryToggle.trigger('click')
    expect(scenePanel.attributes('data-collapsed')).toBe('false')
    expect(telemetryPanel.attributes('data-collapsed')).toBe('false')
  })

  it('展示 L-DL-03 的劣化详情并区分只有摘要的链路', async () => {
    const wrapper = await mountSituationPage()

    const degradedBadge = wrapper.get('tr[data-link-id="L-DL-03"] .link-status')
    expect(degradedBadge.text()).toBe('劣化')
    expect(degradedBadge.attributes('data-canonical-status')).toBe('DOWN')
    expect(degradedBadge.attributes('data-threshold-version')).toBe('LLZT-1.0')
    await wrapper.get('tr[data-link-id="L-DL-03"]').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('界面状态劣化')
    expect(document.body.textContent).toContain('规范状态中断')
    expect(document.body.textContent).toContain('阈值版本LLZT-1.0')
    expect(document.body.textContent).toContain('稳定帧数3')
    expect(document.body.textContent).toContain('判定依据误码率超过阈值并满足稳定帧条件')
    expect(document.body.textContent).toContain('接收功率-91.6 dBm')
    expect(document.body.textContent).toContain('误码率阈值1.0e-5')
    expect(document.body.textContent).toContain('数据年龄0 ms')
    expect(document.body.textContent).toContain('数据新鲜度新鲜')

    const telemetry = useTelemetryStore()
    const updatedSummaries = structuredClone(SITUATION_FRAME_F00042.linkSummaries)
    const updatedLink = updatedSummaries.find((link) => link.currentSnr === 7.1)
    expect(updatedLink).toBeDefined()
    updatedLink!.currentSnr = 9.25
    updatedLink!.currentBer = 0.00012
    expect(telemetry.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: 'TASK-001', sequence: 1,
      simulationTime: 42, frameId: 'F-00042', payload: updatedSummaries,
    })).toBe(true)
    await flushPromises()
    expect(document.body.textContent).toContain('信噪比 SNR9.25 dB')
    expect(document.body.textContent).toContain('误码率 BER1.2e-4')

    const closeButton = document.querySelector<HTMLElement>('.el-dialog__headerbtn')
    closeButton?.click()
    await flushPromises()
    await wrapper.get('tr[data-link-id="L-SAT-02"]').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('当前帧仅提供摘要')
  })

  it('展示同帧候选快照并识别空集合和过期结果', async () => {
    const wrapper = await mountSituationPage()
    await flushPromises()
    const telemetry = useTelemetryStore()

    await wrapper.get('[data-testid="open-link-candidates"]').trigger('click')
    await flushPromises()
    expect(document.querySelectorAll('[data-candidate-id]')).toHaveLength(4)
    expect(document.body.textContent).toContain('TASK-001 · F-00042 · 42 s')
    expect(document.querySelector('[data-candidate-id="L-MW-01"]')?.textContent).toContain('前向')
    expect(document.querySelector('[data-candidate-id="L-MW-01"]')?.textContent).toContain('连续 5 帧')
    expect(document.querySelector('[data-candidate-id="L-DL-03"]')?.textContent).toContain('返向')
    expect(document.querySelector('[data-candidate-id="L-DL-03"]')?.textContent).toContain('不可用')

    for (const [state, message] of [
      ['LOADING', '正在加载链路质量数据'],
      ['VALIDATING', '正在校验候选快照'],
    ] as const) {
      telemetry.capabilityState = state
      await flushPromises()
      expect(document.querySelector(`[data-state="${state}"]`)).not.toBeNull()
      expect(document.body.textContent).toContain(message)
    }
    telemetry.capabilityState = 'SUCCESS'

    const emptyFrame = structuredClone(SITUATION_FRAME_F00042)
    emptyFrame.evidence.routeCandidates = []
    telemetry.frame = emptyFrame
    await flushPromises()
    expect(document.body.textContent).toContain('当前帧没有候选链路')
    expect(document.querySelectorAll('[data-candidate-id]')).toHaveLength(0)

    telemetry.frame = structuredClone(SITUATION_FRAME_F00042)
    await flushPromises()
    const updatedSummaries = structuredClone(SITUATION_FRAME_F00042.linkSummaries)
    const microwave = updatedSummaries.find((link) => link.currentBer === 3.2e-7)
    if (microwave === undefined) throw new Error('测试固定帧缺少 L-MW-01 链路摘要')
    microwave.currentBer = 4.6e-7
    expect(telemetry.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: 'TASK-001', sequence: 1,
      simulationTime: 42, frameId: 'F-00042', payload: updatedSummaries,
    })).toBe(true)
    await flushPromises()
    expect(document.body.textContent).toContain('候选快照不可用')
    expect(document.body.textContent).toContain('候选链路 L-MW-01 的质量快照已经过期。')
    expect(document.querySelector('[data-testid="candidate-error-code"]')?.textContent)
      .toBe('CANDIDATE_METRIC_MISMATCH')
    expect(document.querySelector('[data-testid="candidate-error-path"]')?.textContent)
      .toBe('evidence.routeCandidates[0].ber')
    expect(document.querySelectorAll('[data-candidate-id]')).toHaveLength(0)

    const reload = document.querySelector<HTMLElement>('[data-testid="candidate-reload"]')
    expect(reload).not.toBeNull()
    reload?.click()
    await flushPromises()
    expect(document.querySelectorAll('[data-candidate-id]')).toHaveLength(4)
  })

  it('链路状态徽标同步展示正常、劣化和中断三态', async () => {
    const wrapper = await mountSituationPage()
    await flushPromises()
    const telemetry = useTelemetryStore()
    const nextFrame = structuredClone(SITUATION_FRAME_F00042)
    const target = nextFrame.uiLinks.find((link) => link.linkId === 'L-MW-01')
    if (target === undefined) throw new Error('测试固定帧缺少 L-MW-01 状态投影')
    target.status = 'DOWN'
    target.canonicalStatus = 'DOWN'
    telemetry.frame = nextFrame
    await flushPromises()

    expect(wrapper.findAll('.link-status--up').length).toBeGreaterThan(0)
    expect(wrapper.get('tr[data-link-id="L-DL-03"] .link-status--degraded').text()).toBe('劣化')
    expect(wrapper.get('tr[data-link-id="L-MW-01"] .link-status--down').text()).toBe('中断')
  })

  it('link.metric 将 L-MW-01 规范状态实时更新为中断', async () => {
    const wrapper = await mountSituationPage()
    await flushPromises()
    const telemetry = useTelemetryStore()
    const updatedSummaries = structuredClone(SITUATION_FRAME_F00042.linkSummaries)
    const target = updatedSummaries.find((summary) => (
      summary.sourcePlatform === 'UAV-01'
      && summary.destPlatform === 'GCC-01'
      && summary.linkType === 'MICROWAVE'
    ))
    if (target === undefined) throw new Error('测试固定帧缺少 L-MW-01 链路摘要')
    target.status = 'DOWN'

    expect(telemetry.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: 'TASK-001', sequence: 1,
      simulationTime: 42, frameId: 'F-00042', payload: updatedSummaries,
    })).toBe(true)
    await wrapper.get('tr[data-link-id="L-MW-01"]').trigger('click')
    await flushPromises()

    expect(document.body.textContent).toContain('规范状态中断')
  })

  it('所选链路从当前帧消失时显示缺失态且不回显历史数据', async () => {
    const wrapper = await mountSituationPage()
    await wrapper.get('tr[data-link-id="L-DL-03"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('.link-quality-dialog')).not.toBeNull()

    const telemetry = useTelemetryStore()
    telemetry.frame = {
      ...structuredClone(SITUATION_FRAME_F00042),
      linkSummaries: SITUATION_FRAME_F00042.linkSummaries.filter((summary) => summary.currentSnr !== 7.1),
    }
    await flushPromises()

    expect(document.querySelector('[data-testid="link-detail-missing"]')).not.toBeNull()
    expect(document.body.textContent).toContain('未找到所选链路，未显示历史数据')
  })

  it('所选链路过期时阻止显示历史质量值', async () => {
    const wrapper = await mountSituationPage()
    await wrapper.get('tr[data-link-id="L-DL-03"]').trigger('click')
    await flushPromises()

    const telemetry = useTelemetryStore()
    const staleFrame = structuredClone(SITUATION_FRAME_F00042)
    const projection = staleFrame.uiLinks.find((link) => link.linkId === 'L-DL-03')
    if (projection === undefined) throw new Error('测试固定帧缺少 L-DL-03 状态投影')
    projection.ageMs = 1_000
    telemetry.frame = staleFrame
    await flushPromises()

    expect(document.querySelector('[data-testid="link-detail-stale"]')).not.toBeNull()
    expect(document.body.textContent).toContain('链路数据已过期 1000 ms')
    expect(document.body.textContent).not.toContain('接收功率-91.6 dBm')
  })

  it('通过 Leaflet 控制器同步图层、视图、选择和销毁', async () => {
    const wrapper = await mountSituationPage()
    const options = mapControllerMock.latestOptions

    expect(options).not.toBeNull()
    const layerbar = wrapper.get('[aria-label="态势图层"]')
    const layerButtons = layerbar.findAll('button')
    expect(layerButtons).toHaveLength(4)
    expect(layerButtons.map((button) => button.text())).toEqual(['节点', '链路', '干扰范围', '经纬网'])
    const gridButton = layerButtons[3]
    expect(gridButton.attributes('aria-pressed')).toBe('false')
    expect(gridButton.classes()).not.toContain('active')
    await gridButton.trigger('click')
    expect(gridButton.attributes('aria-pressed')).toBe('true')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('grid', true)
    await gridButton.trigger('click')
    expect(gridButton.attributes('aria-pressed')).toBe('false')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('grid', false)
    expect(layerbar.get('span').text()).toBe('离线矢量 · Z10')
    await layerButtons[0].trigger('click')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenCalledWith('nodes', false)

    const viewControls = wrapper.get('[aria-label="态势图视图控制"]')
    const viewButtons = viewControls.findAll('button')
    expect(viewButtons).toHaveLength(5)
    expect(viewButtons.map((button) => button.text())).toEqual(['', '', '＋', '－', ''])
    expect(viewButtons.map((button) => button.attributes('title'))).toEqual([
      '切换为深色地图',
      '切换为卫星底图',
      '放大态势图',
      '缩小态势图',
      '重置视图',
    ])

    const mapSection = wrapper.get('[aria-label="Leaflet 离线态势图"]')
    const themeButton = wrapper.get('[aria-label="切换为深色地图"]')
    const basemapButton = wrapper.get('[aria-label="切换为卫星底图"]')
    const resetButton = wrapper.get('[aria-label="重置视图"]')
    expect(mapSection.attributes('data-map-theme')).toBe('light')
    expect(mapSection.attributes('data-map-basemap')).toBe('vector')
    for (const iconButton of [themeButton, basemapButton, resetButton]) {
      expect(iconButton.text()).toBe('')
      expect(iconButton.get('svg').attributes('aria-hidden')).toBe('true')
      expect(iconButton.get('svg').attributes('focusable')).toBe('false')
    }
    expect(themeButton.attributes('title')).toBe(themeButton.attributes('aria-label'))
    expect(basemapButton.attributes('title')).toBe(basemapButton.attributes('aria-label'))
    const satelliteIconMarkup = basemapButton.get('svg').html()
    expect(wrapper.get('[aria-label="态势图层"]').text()).toContain('离线矢量')
    expect(wrapper.get('[aria-label="态势图层"]').text()).toContain('Z10')

    await basemapButton.trigger('click')
    expect(mapControllerMock.controller.setBasemap).toHaveBeenNthCalledWith(1, 'satellite')
    expect(mapSection.attributes('data-map-basemap')).toBe('satellite')
    const vectorBasemapButton = wrapper.get('[aria-label="切换为矢量底图"]')
    expect(vectorBasemapButton.attributes('title')).toBe('切换为矢量底图')
    expect(vectorBasemapButton.attributes('title')).toBe(vectorBasemapButton.attributes('aria-label'))
    expect(vectorBasemapButton.text()).toBe('')
    expect(vectorBasemapButton.get('svg').html()).not.toBe(satelliteIconMarkup)
    expect(wrapper.get('[aria-label="态势图层"]').text()).toContain('离线卫星')

    await wrapper.get('[aria-label="切换为矢量底图"]').trigger('click')
    expect(mapControllerMock.controller.setBasemap).toHaveBeenNthCalledWith(2, 'vector')
    expect(mapSection.attributes('data-map-basemap')).toBe('vector')
    const satelliteBasemapButton = wrapper.get('[aria-label="切换为卫星底图"]')
    expect(satelliteBasemapButton.attributes('title')).toBe('切换为卫星底图')
    expect(satelliteBasemapButton.attributes('title')).toBe(satelliteBasemapButton.attributes('aria-label'))

    await themeButton.trigger('click')
    expect(mapControllerMock.controller.setTheme).toHaveBeenNthCalledWith(1, 'dark')
    expect(mapSection.attributes('data-map-theme')).toBe('dark')
    const lightThemeButton = wrapper.get('[aria-label="切换为浅色地图"]')
    expect(lightThemeButton.attributes('title')).toBe('切换为浅色地图')
    expect(lightThemeButton.attributes('title')).toBe(lightThemeButton.attributes('aria-label'))
    expect(lightThemeButton.text()).toBe('')
    expect(lightThemeButton.find('svg').exists()).toBe(true)

    await wrapper.get('[aria-label="切换为浅色地图"]').trigger('click')
    expect(mapControllerMock.controller.setTheme).toHaveBeenNthCalledWith(2, 'light')
    expect(mapSection.attributes('data-map-theme')).toBe('light')
    const darkThemeButton = wrapper.get('[aria-label="切换为深色地图"]')
    expect(darkThemeButton.attributes('title')).toBe('切换为深色地图')
    expect(darkThemeButton.attributes('title')).toBe(darkThemeButton.attributes('aria-label'))
    expect(darkThemeButton.text()).toBe('')

    await wrapper.get('[aria-label="放大态势图"]').trigger('click')
    await wrapper.get('[aria-label="缩小态势图"]').trigger('click')
    await resetButton.trigger('click')
    expect(mapControllerMock.controller.zoomIn).toHaveBeenCalledOnce()
    expect(mapControllerMock.controller.zoomOut).toHaveBeenCalledOnce()
    expect(mapControllerMock.controller.reset).toHaveBeenCalledOnce()

    expect(document.querySelector('[data-testid="selected-node-dialog"]')).toBeNull()
    options?.onSelectNode('SAT-01')
    await flushPromises()
    expect(mapControllerMock.controller.setSelectedNodeId).toHaveBeenCalledWith('SAT-01')
    const satelliteDialog = document.querySelector<HTMLElement>('.selected-node-dialog')
    expect(document.querySelector('[data-testid="selected-node-dialog"]')).not.toBeNull()
    expect(satelliteDialog?.textContent).toContain('节点详情')
    expect(satelliteDialog?.textContent).toContain('通信卫星')
    expect(satelliteDialog?.textContent).toContain('类型通信卫星')
    expect(satelliteDialog?.textContent).toContain('遥测位置121.25°E / 25.75°N')
    expect(satelliteDialog?.textContent).toContain('高度35786000 m')
    expect(satelliteDialog?.textContent).toContain('速度0 m/s')
    expect(satelliteDialog?.textContent).toContain('二维地图按卫星遥测经纬度显示，高度不按地图比例呈现。')

    document.querySelector<HTMLElement>('.selected-node-dialog .el-dialog__headerbtn')?.click()
    await flushPromises()
    const dialogOverlay = document.querySelector<HTMLElement>('.selected-node-dialog')
      ?.closest<HTMLElement>('.el-overlay')
    expect(dialogOverlay?.style.display).toBe('none')

    options?.onSelectLink(SITUATION_LINKS_F00042[0])
    await flushPromises()
    expect(document.querySelector('.link-quality-dialog')).not.toBeNull()
    expect(document.body.textContent).toContain('链路质量详情')

    wrapper.unmount()
    mountedWrapper = null
    expect(mapControllerMock.controller.destroy).toHaveBeenCalledOnce()
  })
})

describe('Leaflet 控制器回归', () => {
  type MockVectorGridLayer = L.Layer & {
    options: L.LayerOptions & { vectorTileLayerStyles: Record<string, unknown> }
    redraw: ReturnType<typeof vi.fn>
  }

  type LeafletWithVectorGrid = typeof L & {
    canvas: typeof L.canvas & { tile: unknown }
    vectorGrid: { protobuf: ReturnType<typeof vi.fn> }
  }

  const leaflet = L as LeafletWithVectorGrid
  let container: HTMLDivElement | null = null
  let vectorGridLayer: MockVectorGridLayer | null = null
  const activeControllers = new Set<{ destroy: () => void }>()

  async function createController(options: {
    initialNodes?: SituationMapNode[]
    onSelectNode?: (platformId: string) => void
    onSelectLink?: (link: SituationLinkView) => void
    onZoomChange?: (zoom: number) => void
  } = {}) {
    vi.resetModules()
    vi.doUnmock('../../src/components/situation/situation-map-controller')
    const { createSituationMapController } = await import('../../src/components/situation/situation-map-controller')

    container = document.createElement('div')
    container.style.width = '800px'
    container.style.height = '500px'
    document.body.append(container)

    const controller = createSituationMapController({
      container,
      frame: options.initialNodes ? null : reactive(structuredClone(SITUATION_FRAME_F00042)),
      initialNodes: options.initialNodes,
      links: options.initialNodes ? [] : SITUATION_LINKS_F00042,
      selectedNodeId: 'CMD-01',
      onSelectNode: options.onSelectNode ?? vi.fn(),
      onSelectLink: options.onSelectLink ?? vi.fn(),
      onZoomChange: options.onZoomChange ?? vi.fn(),
    })
    activeControllers.add(controller)
    return controller
  }

  beforeEach(() => {
    leaflet.canvas.tile = {}
    leaflet.vectorGrid = {
      protobuf: vi.fn((_url: string, options: MockVectorGridLayer['options']) => {
        const layer = L.layerGroup() as unknown as MockVectorGridLayer
        layer.options = { ...options }
        layer.redraw = vi.fn(() => layer)
        vectorGridLayer = layer
        return layer
      }),
    }
    vectorGridLayer = null
    offlineLabelLayerMock.latestLayer = null
    offlineLabelLayerMock.setTheme = vi.fn()
    offlineLabelLayerMock.removeListener = vi.fn()
    offlineLabelLayerMock.create.mockImplementation(() => {
      const layer = L.layerGroup() as unknown as L.Layer & {
        setTheme: (theme: 'dark' | 'light', redraw?: boolean) => void
      }
      layer.setTheme = offlineLabelLayerMock.setTheme
      layer.on('remove', offlineLabelLayerMock.removeListener)
      offlineLabelLayerMock.latestLayer = layer
      return layer
    })
  })

  afterEach(() => {
    activeControllers.forEach((controller) => controller.destroy())
    activeControllers.clear()
    container?.remove()
    container = null
    vectorGridLayer = null
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('无遥测帧时按真实坐标创建节点，保留西经并支持定位高亮', async () => {
    const markerSpy = vi.spyOn(L, 'marker')
    const circleSpy = vi.spyOn(L, 'circle')
    const setViewSpy = vi.spyOn(L.Map.prototype, 'setView')
    const onSelectNode = vi.fn()
    const controller = await createController({ initialNodes: INITIAL_NODES.nodes, onSelectNode })
    const nodeMarkers = markerSpy.mock.calls.filter(([, options]) => options?.title?.startsWith('选择节点'))
    expect(nodeMarkers.map(([point]) => point)).toEqual([[30.0024, -77.9617], [25.1026, 118.7321]])
    expect(circleSpy).not.toHaveBeenCalled()
    const tileBounds = leaflet.vectorGrid.protobuf.mock.calls.at(-1)?.[1].bounds as L.LatLngBounds
    expect(tileBounds.contains([30.0024, -77.9617])).toBe(false)
    expect(tileBounds.contains([25.1026, 118.7321])).toBe(true)
    controller.focusTarget({ kind: 'node', targetId: 'A' })
    expect(setViewSpy).toHaveBeenLastCalledWith([30.0024, -77.9617], MAP_CONFIG.defaults.zoom, expect.objectContaining({ animate: true, duration: 0.45 }))
    expect(container?.querySelectorAll('.situation-map-node-marker--selected')).toHaveLength(1)
    markerSpy.mock.results.at(-1)?.value.fire('click')
    expect(onSelectNode).toHaveBeenCalledWith('B')
    expect(container?.querySelectorAll('.situation-map-node-marker--selected')).toHaveLength(1)
  })

  it('更新文件节点时保留地图实例、视图和选中项，后续定位使用最新坐标', async () => {
    const markerSpy = vi.spyOn(L, 'marker')
    const setViewSpy = vi.spyOn(L.Map.prototype, 'setView')
    const removeSpy = vi.spyOn(L.Map.prototype, 'remove')
    const controller = await createController({ initialNodes: INITIAL_NODES.nodes })
    controller.focusTarget({ kind: 'node', targetId: 'A' })
    setViewSpy.mockClear()
    markerSpy.mockClear()
    controller.setNodes(INITIAL_NODES.nodes.map((node) => node.platformId === 'A'
      ? { ...node, longitude: -78, latitude: 31 } : node))
    expect(setViewSpy).not.toHaveBeenCalled()
    expect(removeSpy).not.toHaveBeenCalled()
    expect(markerSpy.mock.calls.filter(([, options]) => options?.title?.startsWith('选择节点'))
      .map(([point]) => point)).toEqual([[31, -78], [25.1026, 118.7321]])
    expect(container?.querySelectorAll('.situation-map-node-marker--selected')).toHaveLength(1)
    controller.focusTarget({ kind: 'node', targetId: 'A' })
    expect(setViewSpy).toHaveBeenLastCalledWith([31, -78], MAP_CONFIG.defaults.zoom, expect.objectContaining({ animate: true }))
  })

  it('链路 props 筛选和重排后保持几何与交互绑定', async () => {
    const onSelectLink = vi.fn()
    const polylineSpy = vi.spyOn(L, 'polyline')
    const controller = await createController({ onSelectLink })
    const [firstLink, secondLink] = SITUATION_LINKS_F00042
    const filteredLinks = [secondLink, firstLink]

    polylineSpy.mockClear()
    controller.setLinks([firstLink, secondLink])
    const originalCurves = polylineSpy.mock.calls.map(([points]) => points)

    polylineSpy.mockClear()
    controller.setLinks(filteredLinks)
    const reorderedCurves = polylineSpy.mock.calls.map(([points]) => points)
    const reorderedLines = polylineSpy.mock.results.map(({ value }) => value as L.Polyline)

    expect(reorderedCurves).toHaveLength(2)
    expect(reorderedCurves[0]).toEqual(originalCurves[1])
    expect(reorderedCurves[1]).toEqual(originalCurves[0])

    reorderedLines[0]?.fire('click')
    reorderedLines[1]?.fire('click')
    expect(onSelectLink).toHaveBeenNthCalledWith(1, secondLink)
    expect(onSelectLink).toHaveBeenNthCalledWith(2, firstLink)

    controller.destroy()
  })

  it('按原型图例绘制四类链路并用红色标记异常链路', async () => {
    const polylineSpy = vi.spyOn(L, 'polyline')
    const controller = await createController()
    const lineOptions = polylineSpy.mock.calls
      .filter(([, options]) => options?.interactive === true)
      .map(([, options]) => options)

    expect(lineOptions).toHaveLength(10)
    expect(lineOptions[0]).toEqual(expect.objectContaining({ color: '#409eff', dashArray: '8 5' }))
    expect(lineOptions[1]).toEqual(expect.objectContaining({ color: '#f56c6c' }))
    expect(lineOptions[1]?.dashArray).toBeUndefined()
    expect(lineOptions[2]).toEqual(expect.objectContaining({ color: '#67c23a' }))
    expect(lineOptions[3]).toEqual(expect.objectContaining({ color: '#b37feb' }))

    controller.destroy()
  })

  it('直接点击地图节点和链路时更新唯一高亮', async () => {
    const onSelectNode = vi.fn()
    const onSelectLink = vi.fn()
    const markerSpy = vi.spyOn(L, 'marker')
    const polylineSpy = vi.spyOn(L, 'polyline')
    const controller = await createController({ onSelectNode, onSelectLink })

    const satelliteMarker = markerSpy.mock.results.find((_, index) => (
      markerSpy.mock.calls[index]?.[1]?.title === '选择节点 通信卫星（轨道示意）'
    ))?.value as L.Marker | undefined
    satelliteMarker?.fire('click')
    expect(onSelectNode).toHaveBeenCalledWith('SAT-01')
    expect(container?.querySelector('.situation-map-node-marker--selected')?.textContent).toContain('SAT-01')

    const currentLinkLines = polylineSpy.mock.results
      .map((result, index) => ({
        line: result.value as L.Polyline,
        options: polylineSpy.mock.calls[index]?.[1],
      }))
      .filter(({ options }) => options?.interactive === true)
      .slice(-SITUATION_LINKS_F00042.length)
    currentLinkLines[0]?.line.fire('click')
    expect(onSelectLink).toHaveBeenCalledWith(SITUATION_LINKS_F00042[0])
    expect(container?.querySelector('.situation-map-node-marker--selected')).toBeNull()
    expect(polylineSpy.mock.calls
      .filter(([, options]) => options?.interactive === true)
      .slice(-SITUATION_LINKS_F00042.length)[0]?.[1])
      .toEqual(expect.objectContaining({
        className: 'situation-map-link--selected',
        weight: 6,
        opacity: 1,
      }))

    controller.destroy()
  })

  it('初始和重置视图均使用台海区域与配置的缩放范围', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const fitBoundsSpy = vi.spyOn(L.Map.prototype, 'fitBounds')
    const controller = await createController()

    expect(mapSpy).toHaveBeenCalledWith(
      container,
      expect.objectContaining({
        minZoom: MAP_CONFIG.zoom.min,
        maxZoom: MAP_CONFIG.zoom.max,
        zoomSnap: MAP_CONFIG.zoom.snap,
      }),
    )
    expect(MAP_CONFIG.defaults).toEqual({ theme: 'light', basemap: 'vector', zoom: 10, gridVisible: false })
    expect(MAP_CONFIG.taskBounds).toEqual([[21.8, 117], [26.4, 123]])
    expect(MAP_CONFIG.fitPadding).toEqual([24, 24])
    expect(MAP_CONFIG.gridIntervalDegrees).toBe(0.5)
    expect(fitBoundsSpy).toHaveBeenCalledOnce()

    controller.reset()
    expect(fitBoundsSpy).toHaveBeenCalledTimes(2)
    const boundsCalls = fitBoundsSpy.mock.calls.map(([bounds]) => bounds as L.LatLngBounds)
    boundsCalls.forEach((bounds) => {
      expect(bounds.getSouth()).toBe(21.8)
      expect(bounds.getWest()).toBe(117)
      expect(bounds.getNorth()).toBe(26.4)
      expect(bounds.getEast()).toBe(123)
    })
    fitBoundsSpy.mock.calls.forEach(([, fitOptions]) => {
      expect(fitOptions).toEqual(expect.objectContaining({ padding: [24, 24], animate: false }))
    })

    controller.destroy()
  })

  it('按摘要目标定位节点、链路以及活动和待机干扰设备', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const polylineSpy = vi.spyOn(L, 'polyline')
    const circleSpy = vi.spyOn(L, 'circle')
    const controller = await createController()
    const map = mapSpy.mock.results[0]?.value as L.Map
    const setViewSpy = vi.spyOn(map, 'setView').mockReturnValue(map)
    const fitBoundsSpy = vi.spyOn(map, 'fitBounds').mockReturnValue(map)

    controller.focusTarget({ kind: 'node', targetId: 'UAV-01' })
    expect(setViewSpy).toHaveBeenNthCalledWith(1, [24.70, 119.35], 10, {
      animate: true,
      duration: 0.45,
    })
    expect(container?.querySelector('.situation-map-node-marker--selected')?.textContent).toContain('UAV-01')

    polylineSpy.mockClear()
    controller.focusTarget({ kind: 'link', targetId: 'L-MW-01' })
    const linkBounds = fitBoundsSpy.mock.calls[0]?.[0] as L.LatLngBounds
    expect(linkBounds.contains([24.70, 119.35])).toBe(true)
    expect(linkBounds.contains([23.55, 118.65])).toBe(true)
    expect(fitBoundsSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      padding: [24, 24],
      maxZoom: 10,
      animate: true,
      duration: 0.45,
    }))
    expect(polylineSpy.mock.calls.find(([, options]) => (
      options?.className === 'situation-map-link--selected'
    ))?.[1]).toEqual(expect.objectContaining({ weight: 6, opacity: 1 }))
    expect(container?.querySelector('.situation-map-node-marker--selected')).toBeNull()

    circleSpy.mockClear()
    controller.focusTarget({ kind: 'interference', targetId: 'JAM-WB-01-TX' })
    const interferenceBounds = fitBoundsSpy.mock.calls[1]?.[0] as L.LatLngBounds
    expect(interferenceBounds.contains([25.25, 119.55])).toBe(true)
    expect(fitBoundsSpy.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      animate: true,
      duration: 0.45,
    }))
    const selectedInterferenceOptions = circleSpy.mock.calls
      .map((call) => call[1] as unknown as L.CircleMarkerOptions)
      .find((options) => options.className === 'situation-map-interference--selected')
    expect(selectedInterferenceOptions).toEqual(expect.objectContaining({
      color: '#f5b942',
      weight: 4,
      fillOpacity: 0.2,
    }))
    expect(container?.querySelector('.situation-map-node-marker--selected')?.textContent).toContain('STN-01')

    circleSpy.mockClear()
    const standbyFrame = structuredClone(SITUATION_FRAME_F00042)
    const station = standbyFrame.platforms.find(platform => platform.platformId === 'STN-01')!
    station.jammers.push({ ...station.jammers[0]!, jammerId: 'JAM-TEST-STANDBY', active: false })
    controller.setFrame(standbyFrame)
    circleSpy.mockClear()
    controller.focusTarget({ kind: 'interference', targetId: 'JAM-TEST-STANDBY' })
    expect(setViewSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      lat: 25.25,
      lng: 119.55,
    }), 10, { animate: true, duration: 0.45 })
    expect(container?.querySelector('.situation-map-node-marker--selected')?.textContent).toContain('STN-01')
    expect(circleSpy.mock.calls.some((call) => (
      (call[1] as unknown as L.CircleMarkerOptions).className === 'situation-map-interference--selected'
    ))).toBe(false)

    controller.focusTarget({ kind: 'node', targetId: 'AIR-03' })
    expect(setViewSpy).toHaveBeenNthCalledWith(3, [24.43, 119.99], 10, {
      animate: true,
      duration: 0.45,
    })
    expect(container?.querySelector('.situation-map-node-marker--selected')?.textContent).toContain('U03')

    controller.focusTarget({ kind: 'node', targetId: 'NODE-NOT-FOUND' })
    controller.focusTarget({ kind: 'link', targetId: 'LINK-NOT-FOUND' })
    controller.focusTarget({ kind: 'interference', targetId: 'JAMMER-NOT-FOUND' })
    expect(setViewSpy).toHaveBeenCalledTimes(3)
    expect(fitBoundsSpy).toHaveBeenCalledTimes(2)

    controller.destroy()
  })

  it('整数缩放在同一 VectorGrid 上幂等重绘且保持视图与关闭的经纬网状态', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const layerGroupSpy = vi.spyOn(L, 'layerGroup')
    const controller = await createController()
    const map = mapSpy.mock.results[0]?.value as L.Map
    const gridGroup = layerGroupSpy.mock.results[3]?.value as L.LayerGroup
    expect(map.hasLayer(gridGroup)).toBe(false)
    controller.setLayerVisible('grid', true)
    expect(map.hasLayer(gridGroup)).toBe(true)
    controller.setLayerVisible('grid', false)
    expect(map.hasLayer(gridGroup)).toBe(false)
    const vectorLayer = vectorGridLayer as MockVectorGridLayer
    const labelLayer = offlineLabelLayerMock.latestLayer as L.Layer
    const vectorRemoveSpy = vi.spyOn(vectorLayer, 'removeFrom')
    const labelRemoveSpy = vi.spyOn(labelLayer, 'removeFrom')
    const originalStyles = vectorGridLayer?.options.vectorTileLayerStyles
    map.setView([24.1, 119.2], 9, { animate: false })
    const originalCenter = map.getCenter()
    const originalZoom = map.getZoom()

    expect(leaflet.vectorGrid.protobuf).toHaveBeenCalledOnce()
    expect((originalStyles?.ocean as L.PathOptions).fillColor).toBe('#cfe8f3')
    expect(offlineLabelLayerMock.create).toHaveBeenCalledWith('light')
    controller.setTheme('light')
    expect(vectorGridLayer?.redraw).not.toHaveBeenCalled()
    expect(offlineLabelLayerMock.setTheme).not.toHaveBeenCalled()

    controller.setLayerVisible('grid', false)
    expect(map.hasLayer(gridGroup)).toBe(false)
    controller.setTheme('dark')

    expect(leaflet.vectorGrid.protobuf).toHaveBeenCalledOnce()
    expect(vectorGridLayer?.options.vectorTileLayerStyles).not.toBe(originalStyles)
    expect(vectorGridLayer?.redraw).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.setTheme).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.setTheme).toHaveBeenCalledWith('dark')
    expect(vectorRemoveSpy).not.toHaveBeenCalled()
    expect(labelRemoveSpy).not.toHaveBeenCalled()
    expect(vectorGridLayer?.redraw.mock.invocationCallOrder[0])
      .toBeLessThan(offlineLabelLayerMock.setTheme.mock.invocationCallOrder[0] as number)
    expect(map.getCenter()).toEqual(originalCenter)
    expect(map.getZoom()).toBe(originalZoom)
    expect(map.hasLayer(gridGroup)).toBe(false)

    const darkGridLine = gridGroup.getLayers().find((layer) => layer instanceof L.Polyline) as L.Polyline
    const darkGridLabel = gridGroup.getLayers().find((layer) => layer instanceof L.Marker) as L.Marker
    const darkGridLabelElement = (darkGridLabel.options.icon as L.DivIcon).options.html as HTMLElement
    expect(darkGridLine.options.color).toBe('#31506a')
    expect(darkGridLabelElement.style.color).toBe('rgb(102, 132, 154)')
    expect(darkGridLabelElement.style.textShadow).toContain('#06111d')

    controller.setTheme('light')
    expect(vectorGridLayer?.redraw).toHaveBeenCalledTimes(2)
    expect(offlineLabelLayerMock.setTheme).toHaveBeenCalledTimes(2)
    expect(offlineLabelLayerMock.setTheme).toHaveBeenLastCalledWith('light')
    expect(map.getCenter()).toEqual(originalCenter)
    expect(map.getZoom()).toBe(originalZoom)
    expect(map.hasLayer(gridGroup)).toBe(false)

    const lightGridLine = gridGroup.getLayers().find((layer) => layer instanceof L.Polyline) as L.Polyline
    const lightGridLabel = gridGroup.getLayers().find((layer) => layer instanceof L.Marker) as L.Marker
    const gridLabelElement = (lightGridLabel.options.icon as L.DivIcon).options.html as HTMLElement
    expect(lightGridLine.options.color).toBe('#667f91')
    expect(gridLabelElement.style.color).toBe('rgb(66, 92, 109)')
    expect(gridLabelElement.style.textShadow).toContain('#f7fbfd')

    const lightStyles = vectorGridLayer?.options.vectorTileLayerStyles as Record<
      string,
      L.PathOptions | ((properties: Record<string, unknown>, zoom: number) => L.PathOptions)
    >
    const streetStyle = lightStyles.streets as (
      properties: Record<string, unknown>,
      zoom: number,
    ) => L.PathOptions
    expect(streetStyle({ kind: 'motorway' }, 12).color).toBe('#d98b18')
    expect(streetStyle({ kind: 'trunk' }, 12).color).toBe('#e5a536')
    expect(streetStyle({ kind: 'primary' }, 12).color).toBe('#efbd63')
    expect(streetStyle({ kind: 'residential' }, 12).color).toBe('#8d969b')
    expect(streetStyle({ kind: 42 }, 9)).toMatchObject({
      color: '#a7adb0',
      weight: 0.75,
      opacity: 0.7,
    })
    expect(streetStyle({}, 11)).toMatchObject({
      color: '#a7adb0',
      weight: 0.75,
      opacity: 0.9,
    })

    controller.setTheme('dark')
    const darkStyles = vectorGridLayer?.options.vectorTileLayerStyles as Record<
      string,
      L.PathOptions | ((properties: Record<string, unknown>, zoom: number) => L.PathOptions)
    >
    const darkStreetStyle = darkStyles.streets as (
      properties: Record<string, unknown>,
      zoom: number,
    ) => L.PathOptions
    expect(darkStreetStyle({}, 12)).toMatchObject({
      color: '#496579',
      weight: 1.35,
      opacity: 0.8,
    })
    expect(darkStreetStyle({}, 9)).toMatchObject({
      color: '#354f63',
      weight: 0.75,
      opacity: 0.55,
    })

    controller.setTheme('dark')
    expect(vectorGridLayer?.redraw).toHaveBeenCalledTimes(3)
    expect(offlineLabelLayerMock.setTheme).toHaveBeenCalledTimes(3)

    controller.destroy()
  })

  it('分数缩放换肤重挂同一可见瓦片层且保持中心和缩放不变', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const controller = await createController()
    const map = mapSpy.mock.results[0]?.value as L.Map
    const vectorLayer = vectorGridLayer as MockVectorGridLayer
    const labelLayer = offlineLabelLayerMock.latestLayer as L.Layer & {
      setTheme: (theme: 'dark' | 'light', redraw?: boolean) => void
    }
    const vectorRemoveSpy = vi.spyOn(vectorLayer, 'removeFrom')
    const vectorAddSpy = vi.spyOn(vectorLayer, 'addTo')
    const labelRemoveSpy = vi.spyOn(labelLayer, 'removeFrom')
    const labelAddSpy = vi.spyOn(labelLayer, 'addTo')
    map.setView([24.15, 119.25], 8, { animate: false })
    vi.spyOn(map, 'getZoom').mockReturnValue(7.5)
    const originalCenter = map.getCenter()
    const originalZoom = map.getZoom()
    vectorLayer.redraw.mockClear()
    vectorRemoveSpy.mockClear()
    vectorAddSpy.mockClear()
    labelRemoveSpy.mockClear()
    labelAddSpy.mockClear()

    controller.setTheme('dark')

    expect(originalZoom).toBe(7.5)
    expect(vectorLayer.redraw).not.toHaveBeenCalled()
    expect(offlineLabelLayerMock.setTheme).toHaveBeenCalledWith('dark', false)
    expect(vectorRemoveSpy).toHaveBeenCalledOnce()
    expect(vectorAddSpy).toHaveBeenCalledOnce()
    expect(labelRemoveSpy).toHaveBeenCalledOnce()
    expect(labelAddSpy).toHaveBeenCalledOnce()
    expect(map.hasLayer(vectorLayer)).toBe(true)
    expect(map.hasLayer(labelLayer)).toBe(true)
    expect(map.getCenter()).toEqual(originalCenter)
    expect(map.getZoom()).toBe(originalZoom)

    controller.destroy()
  })

  it('复用唯一底图实例切换并保持视图、隐藏业务层和卫星期间更新的主题', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const tileLayerSpy = vi.spyOn(L, 'tileLayer')
    const layerGroupSpy = vi.spyOn(L, 'layerGroup')
    const fitBoundsSpy = vi.spyOn(L.Map.prototype, 'fitBounds')
    const controller = await createController()
    const map = mapSpy.mock.results[0]?.value as L.Map
    const vectorLayer = vectorGridLayer as MockVectorGridLayer
    const labelLayer = offlineLabelLayerMock.latestLayer as L.Layer & {
      setTheme: (theme: 'dark' | 'light', redraw?: boolean) => void
    }
    const satelliteLayer = tileLayerSpy.mock.results[0]?.value as L.TileLayer
    const interferenceGroup = layerGroupSpy.mock.results[2]?.value as L.LayerGroup
    const vectorRemoveSpy = vi.spyOn(vectorLayer, 'removeFrom')
    const vectorAddSpy = vi.spyOn(vectorLayer, 'addTo')
    const labelRemoveSpy = vi.spyOn(labelLayer, 'removeFrom')
    const labelAddSpy = vi.spyOn(labelLayer, 'addTo')
    const satelliteRemoveSpy = vi.spyOn(satelliteLayer, 'removeFrom')
    const satelliteAddSpy = vi.spyOn(satelliteLayer, 'addTo')

    expect(mapSpy).toHaveBeenCalledOnce()
    expect(leaflet.vectorGrid.protobuf).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.create).toHaveBeenCalledOnce()
    expect(tileLayerSpy).toHaveBeenCalledOnce()
    expect(tileLayerSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4174/tiles/taiwan-strait-satellite/{z}/{x}/{y}',
      {
        bounds: L.latLngBounds([...MAP_CONFIG.resources.satellite.bounds[0]], [...MAP_CONFIG.resources.satellite.bounds[1]]),
        minZoom: MAP_CONFIG.zoom.min,
        maxNativeZoom: MAP_CONFIG.resources.satellite.maxNativeZoom,
        maxZoom: MAP_CONFIG.zoom.max,
        pane: 'tilePane',
        attribution: 'VersaTiles - Satellite + Orthophotos',
      },
    )
    expect(map.hasLayer(vectorLayer)).toBe(true)
    expect(map.hasLayer(labelLayer)).toBe(true)
    expect(map.hasLayer(satelliteLayer)).toBe(false)

    map.setView([24.1, 119.2], 9, { animate: false })
    vi.spyOn(map, 'getZoom').mockReturnValue(9.25)
    controller.setLayerVisible('interference', false)
    const originalCenter = map.getCenter()
    const originalZoom = map.getZoom()

    controller.setBasemap('vector')
    expect(vectorRemoveSpy).not.toHaveBeenCalled()
    expect(satelliteAddSpy).not.toHaveBeenCalled()

    controller.setBasemap('satellite')
    controller.setBasemap('satellite')
    expect(vectorRemoveSpy).toHaveBeenCalledOnce()
    expect(labelRemoveSpy).toHaveBeenCalledOnce()
    expect(satelliteAddSpy).toHaveBeenCalledOnce()
    expect(map.hasLayer(vectorLayer)).toBe(false)
    expect(map.hasLayer(labelLayer)).toBe(false)
    expect(map.hasLayer(satelliteLayer)).toBe(true)

    vectorRemoveSpy.mockClear()
    vectorAddSpy.mockClear()
    labelRemoveSpy.mockClear()
    labelAddSpy.mockClear()

    controller.setTheme('dark')
    expect(vectorLayer.redraw).not.toHaveBeenCalled()
    expect(offlineLabelLayerMock.setTheme).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.setTheme).toHaveBeenCalledWith('dark', false)
    expect((vectorLayer.options.vectorTileLayerStyles.ocean as L.PathOptions).fillColor).toBe('#06111d')
    expect(vectorRemoveSpy).not.toHaveBeenCalled()
    expect(vectorAddSpy).not.toHaveBeenCalled()
    expect(labelRemoveSpy).not.toHaveBeenCalled()
    expect(labelAddSpy).not.toHaveBeenCalled()

    controller.setBasemap('vector')
    controller.setBasemap('vector')
    expect(satelliteRemoveSpy).toHaveBeenCalledOnce()
    expect(vectorAddSpy).toHaveBeenCalledOnce()
    expect(labelAddSpy).toHaveBeenCalledOnce()
    expect(map.hasLayer(vectorLayer)).toBe(true)
    expect(map.hasLayer(labelLayer)).toBe(true)
    expect(map.hasLayer(satelliteLayer)).toBe(false)
    expect(map.getCenter()).toEqual(originalCenter)
    expect(map.getZoom()).toBe(originalZoom)
    expect(map.hasLayer(interferenceGroup)).toBe(false)
    expect(mapSpy).toHaveBeenCalledOnce()
    expect(leaflet.vectorGrid.protobuf).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.create).toHaveBeenCalledOnce()
    expect(tileLayerSpy).toHaveBeenCalledOnce()
    expect(fitBoundsSpy).toHaveBeenCalledOnce()

    controller.destroy()
  })

  it('在卫星底图模式下销毁可重复调用且只清理一次地图', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const tileLayerSpy = vi.spyOn(L, 'tileLayer')
    const controller = await createController()
    const map = mapSpy.mock.results[0]?.value as L.Map
    const satelliteLayer = tileLayerSpy.mock.results[0]?.value as L.TileLayer
    const mapRemoveSpy = vi.spyOn(map, 'remove')
    const satelliteRemoveListener = vi.fn()
    satelliteLayer.on('remove', satelliteRemoveListener)

    controller.setBasemap('satellite')
    controller.destroy()
    controller.destroy()

    expect(mapRemoveSpy).toHaveBeenCalledOnce()
    expect(satelliteRemoveListener).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.removeListener).toHaveBeenCalledOnce()
  })

  it('用固定帧 API 遥测坐标生成代表平台、链路端点与命中点和干扰圈', async () => {
    const markerSpy = vi.spyOn(L, 'marker')
    const polylineSpy = vi.spyOn(L, 'polyline')
    const circleSpy = vi.spyOn(L, 'circle')
    const controller = await createController()
    const expectedPoints = Object.fromEntries(
      SITUATION_FRAME_F00042.platforms.map((platform) => [
        platform.platformId,
        [platform.latitude, platform.longitude] as L.LatLngTuple,
      ]),
    ) as Readonly<Record<string, L.LatLngTuple>>
    expect('displayProjection' in MAP_CONFIG).toBe(false)

    const nodeCalls = markerSpy.mock.calls.filter(([, options]) => (
      typeof options?.title === 'string' && options.title.startsWith('选择节点 ')
    ))
    const visiblePlatforms = SITUATION_FRAME_F00042.platforms
    expect(nodeCalls).toHaveLength(visiblePlatforms.length)
    visiblePlatforms.forEach((platform) => {
      const call = nodeCalls.find(([, options]) => options?.title?.includes(platform.name))
      expect(call?.[0]).toEqual(expectedPoints[platform.platformId])
    })
    expect(nodeCalls.some(([, options]) => options?.title?.includes('空中无人作业节点 U03'))).toBe(true)

    const linkCurves = polylineSpy.mock.calls
      .filter(([, options]) => options?.interactive === true)
      .map(([points]) => points as L.LatLngTuple[])
    const linkKeyboardCalls = markerSpy.mock.calls.filter(([, options]) => (
      typeof options?.title === 'string' && !options.title.startsWith('选择节点 ')
    ))
    const controlOffsets = [-0.18, -0.06, 0.06, 0.18] as const
    expect(MAP_CONFIG.linkCurveOffsets).toEqual(controlOffsets)
    expect(MAP_CONFIG.curveSampleCount).toBe(32)
    expect(linkCurves).toHaveLength(SITUATION_FRAME_F00042.linkSummaries.length)
    expect(linkKeyboardCalls).toHaveLength(SITUATION_FRAME_F00042.linkSummaries.length)
    SITUATION_FRAME_F00042.linkSummaries.forEach((summary, index) => {
      const curve = linkCurves[index] as L.LatLngTuple[]
      const source = expectedPoints[summary.sourcePlatform] as L.LatLngTuple
      const destination = expectedPoints[summary.destPlatform] as L.LatLngTuple
      expect(curve[0]).toEqual(source)
      expect(curve[curve.length - 1]).toEqual(destination)
      expect(linkKeyboardCalls[index]?.[0]).toEqual(curve[16])
      const offset = controlOffsets[index] ?? 0
      expect(curve[16]?.[0]).toBeCloseTo((source[0] + destination[0]) / 2 + offset / 2)
      expect(curve[16]?.[1]).toBeCloseTo((source[1] + destination[1]) / 2 + offset / 2)
    })

    const activePlatforms = SITUATION_FRAME_F00042.platforms
      .filter((platform) => platform.jammers.some((jammer) => jammer.active))
    expect(circleSpy).toHaveBeenCalledTimes(activePlatforms.length)
    activePlatforms.forEach((platform, index) => {
      expect(circleSpy.mock.calls[index]?.[0]).toEqual(expectedPoints[platform.platformId])
      const circleOptions = circleSpy.mock.calls[index]?.[1] as unknown as L.CircleOptions
      expect(circleOptions.radius).toBe(12000)
    })
    expect(MAP_CONFIG.activeInterferenceRadiusMeters).toBe(12000)

    controller.destroy()
  })

  it('按底图、离线标注和业务图层的顺序挂载，并在销毁时清理标注图层', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const controller = await createController()
    const map = mapSpy.mock.results[0]?.value as L.Map
    const tilePane = map.getPane('tilePane')
    const labelPane = map.getPane('offline-label-pane')
    const overlayPane = map.getPane('overlayPane')

    expect(tilePane).not.toBeNull()
    expect(labelPane).not.toBeNull()
    expect(overlayPane).not.toBeNull()
    expect(labelPane?.style.zIndex).toBe('350')
    expect(Number(tilePane?.style.zIndex || '200')).toBeLessThan(Number(labelPane?.style.zIndex || '350'))
    expect(Number(labelPane?.style.zIndex || '350')).toBeLessThan(Number(overlayPane?.style.zIndex || '400'))
    expect(labelPane?.style.pointerEvents).toBe('none')
    expect(offlineLabelLayerMock.create).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.latestLayer).not.toBeNull()
    expect(leaflet.vectorGrid.protobuf).toHaveBeenCalledWith(
      'http://127.0.0.1:4174/tiles/china-taiwan-260823/{z}/{x}/{y}',
      expect.objectContaining({
        maxNativeZoom: MAP_CONFIG.resources.vector.maxNativeZoom,
        maxZoom: MAP_CONFIG.zoom.max,
        pane: 'tilePane',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }),
    )

    controller.setLayerVisible('nodes', false)
    controller.setLayerVisible('links', false)
    controller.setLayerVisible('interference', false)
    controller.setLayerVisible('grid', false)
    controller.setLayerVisible('nodes', true)
    controller.setLayerVisible('links', true)
    controller.setLayerVisible('interference', true)
    controller.setLayerVisible('grid', true)

    controller.destroy()
    controller.destroy()
    expect(offlineLabelLayerMock.removeListener).toHaveBeenCalledOnce()
  })

  it('节点 Enter 和空格键各选择一次', async () => {
    const onSelectNode = vi.fn()
    const markerSpy = vi.spyOn(L, 'marker')
    const controller = await createController({ onSelectNode })
    let node = container?.querySelector<HTMLElement>('[title="选择节点 高空前出中继节点"]')
    const nodeMarker = markerSpy.mock.results.find(({ value }) => (
      (value as L.Marker).options.title === '选择节点 高空前出中继节点'
    ))?.value as L.Marker | undefined

    expect(node).not.toBeNull()
    nodeMarker?.fire('click')
    expect(onSelectNode).toHaveBeenCalledOnce()
    expect(onSelectNode).toHaveBeenCalledWith('UAV-01')

    node = container?.querySelector<HTMLElement>('[title="选择节点 高空前出中继节点"]')
    onSelectNode.mockClear()
    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    node?.dispatchEvent(escapeEvent)
    expect(escapeEvent.defaultPrevented).toBe(false)
    expect(onSelectNode).not.toHaveBeenCalled()

    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    node?.dispatchEvent(enterEvent)
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(onSelectNode).toHaveBeenCalledOnce()
    expect(onSelectNode).toHaveBeenCalledWith('UAV-01')

    node = container?.querySelector<HTMLElement>('[title="选择节点 高空前出中继节点"]')
    onSelectNode.mockClear()
    const spaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    node?.dispatchEvent(spaceEvent)
    expect(spaceEvent.defaultPrevented).toBe(true)
    expect(onSelectNode).toHaveBeenCalledOnce()
    expect(onSelectNode).toHaveBeenCalledWith('UAV-01')

    controller.destroy()
  })

  it('链路 Enter 和空格键各选择一次且焦点可见', async () => {
    const onSelectLink = vi.fn()
    const markerSpy = vi.spyOn(L, 'marker')
    const controller = await createController({ onSelectLink })
    let link = container?.querySelector<HTMLElement>('.situation-map-link-keyboard-hit[title]')
    const linkMarker = markerSpy.mock.results.find(({ value }) => (
      (value as L.Marker).options.title === link?.title
    ))?.value as L.Marker | undefined

    expect(link).not.toBeNull()
    expect(link?.style.opacity).not.toBe('0')
    link?.focus()
    expect(document.activeElement).toBe(link)

    linkMarker?.fire('click')
    expect(onSelectLink).toHaveBeenCalledOnce()
    expect(onSelectLink).toHaveBeenCalledWith(SITUATION_LINKS_F00042[0])

    link = container?.querySelector<HTMLElement>('.situation-map-link-keyboard-hit[title]')
    onSelectLink.mockClear()
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    link?.dispatchEvent(enterEvent)
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(onSelectLink).toHaveBeenCalledOnce()
    expect(onSelectLink).toHaveBeenCalledWith(SITUATION_LINKS_F00042[0])

    link = container?.querySelector<HTMLElement>('.situation-map-link-keyboard-hit[title]')
    onSelectLink.mockClear()
    const spaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    link?.dispatchEvent(spaceEvent)
    expect(spaceEvent.defaultPrevented).toBe(true)
    expect(onSelectLink).toHaveBeenCalledOnce()
    expect(onSelectLink).toHaveBeenCalledWith(SITUATION_LINKS_F00042[0])

    controller.destroy()
  })

  it('通过 ResizeObserver 刷新尺寸、上报缩放并清理观察器', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    const observe = vi.fn()
    const disconnect = vi.fn()
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
      }

      observe = observe
      unobserve = vi.fn()
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const invalidateSizeSpy = vi.spyOn(L.Map.prototype, 'invalidateSize')
    const mapSpy = vi.spyOn(L, 'map')
    const onZoomChange = vi.fn()
    const controller = await createController({ onZoomChange })
    const map = mapSpy.mock.results[0]?.value as L.Map
    const resizeCallback = resizeCallbacks[0]

    expect(observe).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledWith(container)
    expect(resizeCallback).toBeTypeOf('function')
    if (!resizeCallback) throw new Error('ResizeObserver callback was not registered')
    invalidateSizeSpy.mockClear()
    resizeCallback([] as ResizeObserverEntry[], {} as ResizeObserver)
    expect(invalidateSizeSpy).toHaveBeenCalledOnce()
    expect(invalidateSizeSpy).toHaveBeenCalledWith({ pan: false })

    map.fire('zoomend')
    expect(onZoomChange).toHaveBeenLastCalledWith(map.getZoom())

    controller.destroy()
    expect(disconnect).toHaveBeenCalledOnce()
    resizeCallback([] as ResizeObserverEntry[], {} as ResizeObserver)
    expect(invalidateSizeSpy).toHaveBeenCalledOnce()
  })

  it('在缺少 ResizeObserver 时使用并移除窗口尺寸监听', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const invalidateSizeSpy = vi.spyOn(L.Map.prototype, 'invalidateSize')
    const controller = await createController()
    const resizeRegistrations = addEventListenerSpy.mock.calls.filter(([type]) => type === 'resize')
    const resizeHandler = resizeRegistrations[resizeRegistrations.length - 1]?.[1] as EventListener

    invalidateSizeSpy.mockClear()
    resizeHandler(new Event('resize'))
    expect(invalidateSizeSpy).toHaveBeenCalledOnce()

    controller.destroy()
    expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', resizeHandler)
    resizeHandler(new Event('resize'))
    expect(invalidateSizeSpy).toHaveBeenCalledOnce()
  })

  it('同值更新与销毁后的全部控制命令保持无副作用', async () => {
    const markerSpy = vi.spyOn(L, 'marker')
    const polylineSpy = vi.spyOn(L, 'polyline')
    const layerGroupSpy = vi.spyOn(L, 'layerGroup')
    const mapSpy = vi.spyOn(L, 'map')
    const controller = await createController()
    const map = mapSpy.mock.results[0]?.value as L.Map
    const nodesGroup = layerGroupSpy.mock.results[0]?.value as L.LayerGroup
    const nodesAddSpy = vi.spyOn(nodesGroup, 'addTo')

    markerSpy.mockClear()
    controller.setSelectedNodeId('CMD-01')
    controller.setLayerVisible('nodes', true)
    expect(markerSpy).not.toHaveBeenCalled()
    expect(nodesAddSpy).not.toHaveBeenCalled()

    const zoomInSpy = vi.spyOn(map, 'zoomIn')
    const zoomOutSpy = vi.spyOn(map, 'zoomOut')
    const fitBoundsSpy = vi.spyOn(map, 'fitBounds')
    controller.destroy()
    markerSpy.mockClear()
    polylineSpy.mockClear()

    expect(() => {
      controller.setLinks(SITUATION_LINKS_F00042)
      controller.setSelectedNodeId('UAV-01')
      controller.focusTarget({ kind: 'node', targetId: 'UAV-01' })
      controller.setLayerVisible('nodes', false)
      controller.setTheme('dark')
      controller.setBasemap('satellite')
      controller.zoomIn()
      controller.zoomOut()
      controller.reset()
      controller.destroy()
    }).not.toThrow()
    expect(markerSpy).not.toHaveBeenCalled()
    expect(polylineSpy).not.toHaveBeenCalled()
    expect(zoomInSpy).not.toHaveBeenCalled()
    expect(zoomOutSpy).not.toHaveBeenCalled()
    expect(fitBoundsSpy).not.toHaveBeenCalled()
  })

  it('按名称回退匹配链路并安全忽略无法解析的链路', async () => {
    const onSelectLink = vi.fn()
    const polylineSpy = vi.spyOn(L, 'polyline')
    const markerSpy = vi.spyOn(L, 'marker')
    const controller = await createController({ onSelectLink })
    const firstLink = SITUATION_LINKS_F00042[0]
    const fallbackLink: SituationLinkView = {
      ...firstLink,
      linkId: 'fallback-by-name',
      detailed: SITUATION_LINKS_F00042[1]?.detailed ?? null,
    }
    const unresolvedLink: SituationLinkView = {
      ...fallbackLink,
      linkId: 'unresolved-link',
      sourceName: '不存在的源节点',
      destinationName: '不存在的目标节点',
    }

    polylineSpy.mockClear()
    markerSpy.mockClear()
    controller.setLinks([fallbackLink, unresolvedLink])
    const interactiveLines = polylineSpy.mock.results
      .map(({ value }) => value as L.Polyline)
      .filter((line) => line.options.interactive === true)
    const linkMarkers = markerSpy.mock.results
      .map(({ value }) => value as L.Marker)
      .filter((marker) => marker.options.title?.includes(fallbackLink.sourceName))

    expect(interactiveLines).toHaveLength(1)
    expect(linkMarkers).toHaveLength(1)
    interactiveLines[0]?.fire('click')
    expect(onSelectLink).toHaveBeenCalledOnce()
    expect(onSelectLink).toHaveBeenCalledWith(fallbackLink)

    controller.destroy()
  })
})

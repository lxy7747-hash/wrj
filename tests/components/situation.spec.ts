import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElSelect } from 'element-plus'
import L from 'leaflet'
import { createPinia, setActivePinia } from 'pinia'
import { h, reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAP_CONFIG, isSatellitePlatform, resolvePlatformCoordinates } from '../../src/config/map.config'
import type { ConfirmationContext, Link, Principal, SimulationRun } from '../../src/contracts/domain-models'
import type { SituationLinkView } from '../../src/features/situation/situation-model'
import type { InitialNodeSnapshot, SituationMapNode } from '../../src/features/situation/initial-nodes'
import { selectFileCommunicationLinks, type FileCommunicationConnection, type FileCommunicationLink } from '../../src/features/situation/file-communication-links'
import { buildFileDeviceEvents, selectFileDeviceStates, type FileDeviceEvent } from '../../src/features/situation/file-device-events'
import type { FileMessageLink } from '../../src/features/situation/file-message-links'
import { selectFileMessageLinks } from '../../src/features/situation/file-message-links'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log'
import {
  SITUATION_EVENTS_F00042,
  SITUATION_FRAME_F00042,
  SITUATION_LINKS_F00042,
  selectSituationLinks,
} from '../../src/features/situation/situation-model'
import { useAuthStore } from '../../src/stores/auth'
import { useTelemetryStore } from '../../src/stores/telemetry'
import { useSimulationStore } from '../../src/stores/simulation'
import { useReplayStore } from '../../src/stores/replay'
import { LOCAL_REPLAY } from '../fixtures/local-replay'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'

type SituationMapControllerOptions = {
  frame: unknown
  initialNodes?: SituationMapNode[]
  fileLinks?: FileCommunicationLink[]
  fileMessageLinks?: FileMessageLink[]
  fileDeviceStates?: FileDeviceEvent[]
  configuredLinks?: Link[]
  onSelectConfiguredLink?: (link: Link) => void
  onSelectFileLink?: (link: FileCommunicationLink) => void
  onSelectFileMessageLink?: (link: FileMessageLink) => void
  onSelectNode: (platformId: string) => void
  onSelectLink: (link: SituationLinkView) => void
}

/** 由消息证据推导的一条业务链路：卫星一跳，投递时延等于 GEO 单程光时；活跃窗口 1.5–2805 秒。 */
const MESSAGE_LINK: FileMessageLink = {
  id: JSON.stringify(['SAT', 'A', 'sat_link', 'B', 'sat_link']),
  type: 'SAT',
  sourcePlatformId: 'A',
  targetPlatformId: 'B',
  sourceDeviceId: 'sat_link',
  targetDeviceId: 'sat_link',
  records: [{
    sourceEventId: 'LOG-L20', transmitEventId: 'LOG-L19', time: 1.5,
    source: { platformName: 'A', communicationName: 'sat_link' },
    target: { platformName: 'B', communicationName: 'sat_link' },
    messageType: 'CMD_ORDER', messageSizeBits: 512, delayS: 0.121,
  }, {
    sourceEventId: 'LOG-L99', transmitEventId: 'LOG-L98', time: 2805,
    source: { platformName: 'A', communicationName: 'sat_link' },
    target: { platformName: 'B', communicationName: 'sat_link' },
    messageType: 'CMD_ORDER', messageSizeBits: 512, delayS: 0.122,
  }],
  firstTimeS: 1.5,
  lastTimeS: 2805,
  activeIntervals: [{ startTimeS: 1.5, endTimeS: 2805 }],
  messageCount: 2,
  messageTypes: ['CMD_ORDER'],
  direction: 'FORWARD',
  medianDelayS: 0.121,
}

const mapControllerMock = vi.hoisted(() => {
  const controller = {
    setFrame: vi.fn(),
    setNodes: vi.fn(),
    setLinks: vi.fn(),
    setFileLinks: vi.fn(),
    setFileMessageLinks: vi.fn(),
    setFileDeviceStates: vi.fn(),
    setConfiguredLinks: vi.fn(),
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
      // 记录初始化及后续 setter 实际送入的数据，不再依赖重建地图同步 props。
      mapControllerMock.latestOptions = { ...options }
      controller.setFrame.mockImplementation(value => { mapControllerMock.latestOptions!.frame = value })
      controller.setNodes.mockImplementation(value => { mapControllerMock.latestOptions!.initialNodes = value })
      controller.setFileLinks.mockImplementation(value => { mapControllerMock.latestOptions!.fileLinks = value })
      controller.setFileMessageLinks.mockImplementation(value => { mapControllerMock.latestOptions!.fileMessageLinks = value })
      controller.setFileDeviceStates.mockImplementation(value => { mapControllerMock.latestOptions!.fileDeviceStates = value })
      controller.setConfiguredLinks.mockImplementation(value => { mapControllerMock.latestOptions!.configuredLinks = value })
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
import LinkCandidatePanel from '../../src/components/situation/LinkCandidatePanel.vue'
import OfflineSituationMap from '../../src/components/situation/OfflineSituationMap.vue'
import ScenarioWorkspace from '../../src/pages/scenarios/ScenarioWorkspace.vue'

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

const FILE_CONNECTIONS: FileCommunicationConnection[] = [
  { sourceEventId: 'LOG-L20', time: 0, scope: 'INTER_PLATFORM', sourceType: 'satcom_1', targetType: 'satcom_2',
    source: { platformName: 'A', communicationName: 'sat-a', address: '0.1.0.1' },
    target: { platformName: 'B', communicationName: 'sat-b', address: '0.1.0.2' } },
  { sourceEventId: 'LOG-L21', time: 5, scope: 'INTER_PLATFORM', sourceType: 'microwave', targetType: 'c_band_relay_down',
    source: { platformName: 'B', communicationName: 'mw-b', address: '0.1.0.3' },
    target: { platformName: 'A', communicationName: 'c-a', address: '0.1.0.4' } },
]
const SATELLITE_FILE_NODES = INITIAL_NODES.nodes.map((node, index) => ({
  ...node, type: index === 0 ? 'SHEN_TONG_SAT' : 'MISSION_UAV_PLATFORM',
}))

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

/** 只断言链路身份被送入地图；聚合值随游标截断，不在此处比较完整明细。 */
const messageLinkId = expect.objectContaining({ id: MESSAGE_LINK.id })

describe('态势主界面', () => {
  let mountedWrapper: ReturnType<typeof mount> | null = null

  /**
   * 挂载态势主界面并登记为当前测试的待清理实例。
   * @returns 已挂载的态势页面包装器。
   * @sideeffect 向 document.body 添加页面及 Element Plus 的关联 DOM。
   */
  async function mountSituationPage(sceneId?: string) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal: OPERATOR, role: OPERATOR.role, permissions: [...OPERATOR.permissions] })
    useTelemetryStore(pinia).$patch({
      frame: structuredClone(SITUATION_FRAME_F00042),
      events: structuredClone(SITUATION_EVENTS_F00042),
      capabilityState: 'SUCCESS',
    })
    if (sceneId) expect(await useSimulationStore(pinia).selectScene(sceneId)).toBe(true)
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
    ;(MAP_CONFIG as { showLinkQualityColumns: boolean }).showLinkQualityColumns = false
    sessionStorage.clear()
    mapControllerMock.latestOptions = null
    vi.clearAllMocks()
    vi.stubGlobal('fetch', situationFetch())
    vi.stubGlobal('WebSocket', SilentWebSocket)
  })

  afterEach(() => {
    ;(MAP_CONFIG as { useSatelliteDataPosition: boolean }).useSatelliteDataPosition = false
    ;(MAP_CONFIG as { showLinkQualityColumns: boolean }).showLinkQualityColumns = false
    mountedWrapper?.unmount()
    mountedWrapper = null
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.useRealTimers()
    sessionStorage.clear()
  })

  it('质量指标位于右侧页签而非弹框，联动选中链路且来回切换保留筛选', async () => {
    const wrapper = await mountSituationPage()
    const panel = wrapper.get('.telemetry-panel')
    const tabs = panel.findAll('[role="tab"]')
    expect(tabs.map(tab => tab.text())).toEqual(['链路状态', '质量指标'])
    expect(tabs[0]!.attributes('aria-selected')).toBe('true')
    mapControllerMock.latestOptions!.onSelectLink(SITUATION_LINKS_F00042[0]!)
    await flushPromises()
    // 关闭既有链路详情；质量页签本身不得创建遮挡地图的弹框。
    const close = document.querySelector<HTMLButtonElement>('.link-quality-dialog .el-dialog__headerbtn')
    close?.click()
    await tabs[1]!.trigger('click')
    await flushPromises()
    const quality = panel.get('[data-testid="quality-metric-panel"]')
    expect(quality.isVisible()).toBe(true)
    expect(document.querySelector('[role="dialog"][aria-label="实时质量指标"]')).toBeNull()
    expect(quality.findAllComponents(ElSelect)[1]!.props('modelValue')).toBe(SITUATION_LINKS_F00042[0]!.linkId)
    quality.findAllComponents(ElSelect)[2]!.vm.$emit('update:modelValue', 5000)
    await tabs[0]!.trigger('click')
    expect(panel.get('.telemetry-section--links').isVisible()).toBe(true)
    await tabs[1]!.trigger('click')
    expect(quality.findAllComponents(ElSelect)[2]!.props('modelValue')).toBe(5000)
    await panel.get('[data-testid="toggle-telemetry-panel"]').trigger('click')
    await panel.get('[data-testid="toggle-telemetry-panel"]').trigger('click')
    expect(tabs[1]!.attributes('aria-selected')).toBe('true')
  })

  it.each(['SCN-001', 'SCN-B'])('刷新恢复 %s 的地图、两行节点和右侧抽屉，不切回本机文件', async id => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    scene.config.scenario.id = id
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/simulations')) return successResponse([])
      if (url.endsWith(`/scenarios/${id}`)) return successResponse(scene)
      if (url.endsWith('/initial-nodes')) return successResponse(INITIAL_NODES)
      throw new Error(`Unexpected request ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    await mountSituationPage(id)
    mountedWrapper!.unmount()
    mountedWrapper = null
    scene.revision += 1
    scene.config.platforms[0]!.name = '服务端最新节点名称'
    const wrapper = await mountSituationPage()
    expect(useSimulationStore().selectedScene?.config.scenario.id).toBe(id)
    expect(mapControllerMock.latestOptions?.initialNodes?.[0]?.name).toBe('服务端最新节点名称')
    const panel = wrapper.get('.telemetry-panel')
    expect(panel.findAll('.panel-heading strong').map(item => item.text())).toEqual(['全链路状态', '干扰 / 侦测设备', '同帧事件'])
    expect(panel.findAll('tr[data-link-id]')).toHaveLength(scene.config.links.length)
    expect(wrapper.get('.summary-focus-button').findAll('span, small')).toHaveLength(2)
    await panel.get('[data-testid="toggle-telemetry-panel"]').trigger('click')
    expect(panel.attributes('data-collapsed')).toBe('true')
    await panel.get('[data-testid="toggle-telemetry-panel"]').trigger('click')
    expect(panel.attributes('data-collapsed')).toBe('false')
    await panel.get('tr[data-link-id="L-MW-01"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="link-detail-configured"]')?.textContent).toContain('规范状态暂无数据')
    expect(fetcher.mock.calls.some(([url]) => /initial-nodes|positions|frames|events/.test(url))).toBe(false)
  })

  it('刷新加载失败可连续重试原场景，未恢复前不展示旧配置或切换文件数据', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    scene.config.scenario.id = 'SCN-B'
    let failed = false
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/simulations')) return successResponse([])
      if (url.endsWith('/scenarios/SCN-B')) return failed
        ? new Response(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: '场景读取失败。' } }), { status: 404 })
        : successResponse(scene)
      throw new Error(`Unexpected request ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    await mountSituationPage('SCN-B')
    mountedWrapper!.unmount()
    mountedWrapper = null
    failed = true
    const wrapper = await mountSituationPage()
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(wrapper.text()).toContain('场景 SCN-B 加载失败')
      expect(wrapper.find('.telemetry-panel').exists()).toBe(false)
      expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeDefined()
      await wrapper.get('.telemetry-empty button').trigger('click')
      await flushPromises()
    }
    failed = false
    await wrapper.get('.telemetry-empty button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.telemetry-panel').exists()).toBe(true)
    expect(useSimulationStore().selectedScene?.config.scenario.id).toBe('SCN-B')
    expect(fetcher.mock.calls.every(([url]) => url.endsWith('/simulations') || url.endsWith('/scenarios/SCN-B'))).toBe(true)
  })

  it.each(['离页', '退出', '重置'])('场景恢复在途时%s，迟到响应不恢复场景或缓存', async action => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    scene.config.scenario.id = 'SCN-B'
    let late = false
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/simulations')) return successResponse([])
      if (late) return new Promise<Response>(resolve => { finish = resolve })
      return successResponse(scene)
    }))
    await mountSituationPage('SCN-B')
    mountedWrapper!.unmount()
    mountedWrapper = null
    late = true
    const wrapper = await mountSituationPage()
    expect(finish).toBeDefined()
    if (action === '退出') useAuthStore().resetToSafeEmpty()
    if (action !== '离页') useSimulationStore().resetToSafeEmpty()
    wrapper.unmount()
    mountedWrapper = null
    finish(successResponse(scene))
    await flushPromises()
    expect(useSimulationStore().selectedScene).toBeNull()
    expect(useSimulationStore().selectingScene).toBe(false)
    expect(useSimulationStore().readSelectedSceneId()).toBe(action === '离页' ? 'SCN-B' : null)
  })

  it('选用场景请求跨页迟到时维持初始文件模式，不轮询末帧位置', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scenes = new ScenarioProjection()
    const scene = scenes.list()[0]!
    scene.config.scenario.id = 'SCN-B'
    let finish!: (response: Response) => void
    const fetcher = vi.fn((url: string, _init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/scenarios')) return Promise.resolve(successResponse([scene]))
      if (url.endsWith('/simulations')) return Promise.resolve(successResponse([fixtureSource.run]))
      if (url.endsWith('/scenarios/SCN-B')) return new Promise(resolve => { finish = resolve })
      if (url.endsWith('/initial-nodes')) return Promise.resolve(successResponse(INITIAL_NODES))
      throw new Error(`Unexpected request ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ principal: OPERATOR, role: OPERATOR.role, permissions: [...OPERATOR.permissions] })
    const socket = vi.fn(function () { return new SilentWebSocket() })
    vi.stubGlobal('WebSocket', socket)
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/scenarios', component: ScenarioWorkspace }, { path: '/situation', component: SituationPage },
      { path: '/other', component: { template: '<div>other</div>' } },
    ] })
    await router.push('/scenarios')
    await router.isReady()
    mountedWrapper = mount({ template: '<router-view />' }, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus] } })
    const wrapper = mountedWrapper
    await flushPromises()
    await wrapper.get('[data-testid="scene-select-SCN-B"]').trigger('click')
    await flushPromises()
    expect(finish).toBeDefined()
    await router.push('/situation')
    await flushPromises()
    expect(fetcher.mock.calls.find(([url]) => url.endsWith('/scenarios/SCN-B'))![1]?.signal?.aborted).toBe(true)
    finish(successResponse(scene))
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/situation')
    expect(useSimulationStore().selectedScene).toBeNull()
    expect(wrapper.find('[data-testid="saved-scene-preview"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="simulation-start"]').text()).toContain('播放')
    expect(mapControllerMock.latestOptions?.initialNodes?.map(node => node.platformId)).toEqual(['A', 'B'])
    expect(socket).not.toHaveBeenCalled()
    const polls = () => fetcher.mock.calls.filter(([url]) => url.endsWith('/positions')).length
    expect(polls()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(polls()).toBe(0)
    await router.push('/other')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3000)
    expect(polls()).toBe(0)
  })

  it.each([false, true])('全链路状态质量列开关为 %s，名称完整且不再显示编号小字', async show => {
    ;(MAP_CONFIG as { showLinkQualityColumns: boolean }).showLinkQualityColumns = show
    const wrapper = await mountSituationPage()
    expect(wrapper.findAll('.link-table th').map(item => item.text())).toEqual(show
      ? ['链路', '体制', 'SNR', 'BER', '状态'] : ['链路', '体制', '状态'])
    const row = wrapper.get('tr[data-link-id="L-MW-01"]')
    const link = SITUATION_LINKS_F00042.find(item => item.linkId === 'L-MW-01')!
    expect(row.get('td strong').text()).toBe(`${link.sourceName}→${link.destinationName}`)
    expect(row.find('small').exists()).toBe(false)
    expect(row.findAll('td')).toHaveLength(show ? 5 : 3)
    if (show) expect(row.findAll('td')[2]!.text()).toBe(link.snrDb.toFixed(2))
  })

  it('全链路状态按 CSV 设备启停变化，单端关闭、恢复、倒退及重载不残留未来状态', async () => {
    const snapshot = structuredClone(LOCAL_REPLAY)
    snapshot.initial.connections = structuredClone(FILE_CONNECTIONS.slice(0, 1))
    const csv = [
      '! COMM_TURNED_ON,time<time>,event<string>,platform<string>,system<string>',
      '! COMM_TURNED_OFF,time<time>,event<string>,platform<string>,system<string>',
      '0,COMM_TURNED_ON,A,sat-a',
      '1,COMM_TURNED_ON,B,sat-b',
      '2,COMM_TURNED_OFF,A,sat-a',
      '3,COMM_TURNED_ON,A,sat-a',
    ].join('\n')
    snapshot.initial.deviceEvents = buildFileDeviceEvents(parseAfsimEventLog(csv).events, new Set(['A', 'B']))
    const fetchSpy = vi.fn().mockResolvedValueOnce(successResponse(snapshot.initial))
      .mockImplementation(() => Promise.resolve(successResponse(snapshot)))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage()
    const badge = () => wrapper.get('.link-table .link-device-status').text()
    expect(badge()).toBe('干扰')
    expect(wrapper.get('.link-table .link-device-status').attributes('title')).toContain('设备启停证据：未知')
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    const playback = useReplayStore()
    await playback.pause()
    for (const [time, status, evidence] of [[1, '正常', '开启'], [2, '切换', '关闭'], [3, '正常', '开启'], [2, '切换', '关闭'], [0, '干扰', '未知']] as const) {
      expect(await playback.seek(time)).toBe(true)
      await flushPromises()
      expect(badge()).toBe(status)
      expect(wrapper.get('.link-table .link-device-status').attributes('data-status')).toBe(evidence)
      expect(wrapper.findAll('.link-table tbody tr')).toHaveLength(1)
    }
    await playback.seek(2)
    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    expect(badge()).toBe('干扰')
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    expect(badge()).toBe('干扰')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
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
    expect(wrapper.get('.link-table thead').text()).toBe('链路体制状态')
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
      '卫星链路微波链路新一代数传链路激光链路受干扰 / 失效链路光纤链路',
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
    const initial = structuredClone(INITIAL_NODES)
    initial.nodes[0]!.name = '高空中继节点'
    const fetchSpy = vi.fn().mockResolvedValueOnce(successResponse(initial))
      .mockResolvedValue(successResponse(null))
    const webSocketSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('WebSocket', webSocketSpy)
    const wrapper = await mountSituationPage()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(webSocketSpy).not.toHaveBeenCalled()
    expect(useTelemetryStore().frame).toBeNull()
    expect(wrapper.findAll('.summary-focus-button')).toHaveLength(2)
    expect(wrapper.get('.node-jammer-count').text()).toBe('2 个')
    const panel = wrapper.get('.telemetry-panel')
    expect(panel.findAll('.panel-heading strong').map(item => item.text())).toEqual(['全链路状态', '干扰 / 侦测设备', '同帧事件'])
    expect(panel.text()).toContain('当前时刻暂无通信关联')
    expect(panel.text()).toContain('暂无干扰 / 侦测设备运行数据')
    expect(panel.text()).toContain('暂无当前运行事件')
    expect(panel.findAll('.telemetry-empty-state.el-empty')).toHaveLength(2)
    expect(panel.find('.jammer-list').exists()).toBe(false)
    expect(panel.find('.event-list').exists()).toBe(false)
    expect(panel.findAll('tr[data-link-id]')).toHaveLength(0)
    expect(panel.find('[data-testid="open-link-candidates"]').exists()).toBe(false)
    expect(panel.get('.telemetry-section--links .panel-heading').text()).toBe('全链路状态')
    expect(wrapper.get('.situation-page__workspace').classes()).not.toContain('situation-page__workspace--telemetry-collapsed')
    await panel.get('[data-testid="toggle-telemetry-panel"]').trigger('click')
    expect(panel.attributes('data-collapsed')).toBe('true')
    await panel.get('[data-testid="toggle-telemetry-panel"]').trigger('click')
    expect(panel.attributes('data-collapsed')).toBe('false')
    expect(wrapper.get('.situation-page__workspace').classes()).not.toContain('situation-page__workspace--telemetry-collapsed')
    expect(wrapper.find('.metric-panel').exists()).toBe(false)
    expect(wrapper.get('[aria-label="链路类型图例"]').text()).toBe(
      '卫星链路微波链路新一代数传链路激光链路受干扰 / 失效链路光纤链路',
    )
    expect(wrapper.find('[data-testid="file-message-selector"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('选择消息查看实际路径')
    expect(mapControllerMock.latestOptions).toMatchObject({ frame: null, initialNodes: initial.nodes })
    expect(wrapper.get('[data-testid="focus-node-A"]').text()).toContain('高空中继节点')
    await wrapper.get('[data-testid="focus-node-A"]').trigger('click')
    expect(mapControllerMock.controller.focusTarget).toHaveBeenCalledWith({ kind: 'node', targetId: 'A' })
    mapControllerMock.latestOptions?.onSelectNode('A')
    await flushPromises()
    expect(document.querySelector('.selected-node-dialog')?.textContent).toContain('高空中继节点')
    expect(document.querySelector('.selected-node-dialog')?.textContent).toContain('77.9617°W')
    expect(document.querySelector('.selected-node-dialog')?.textContent).toContain('HIGH_ALT_COMMS_PLATFORM')
    expect(document.querySelector('.selected-node-dialog')?.textContent).toContain('离线底图覆盖范围之外')
    expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="simulation-start"]').text()).toContain('播放')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('主界面文件播放共用同一游标，位置、关联与设备按流程同步，控制不调用 mission 或 Mock', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const snapshot = structuredClone(LOCAL_REPLAY)
    snapshot.initial.connections = FILE_CONNECTIONS
    // 第一条业务投递在 1.5 秒，因此游标 1 秒还没有业务链路、游标 2 秒已经有。
    snapshot.initial.messageLinks = [MESSAGE_LINK]
    snapshot.initial.deviceEvents = [
      { sourceEventId: 'OFF-1', time: 1.439932, platformId: 'A', deviceId: 'microwave_link', kind: 'COMMUNICATION', active: false },
      { sourceEventId: 'JAM-ON', time: 1666.178, platformId: 'B', deviceId: 'prophet_jammer', kind: 'JAMMING', active: true, frequencyHz: 2.4e9, bandwidthHz: 5e7 },
      { sourceEventId: 'ON-1', time: 2300, platformId: 'A', deviceId: 'microwave_link', kind: 'COMMUNICATION', active: true },
      { sourceEventId: 'OFF-2', time: 2302.44, platformId: 'A', deviceId: 'microwave_link', kind: 'COMMUNICATION', active: false },
      { sourceEventId: 'JAM-OFF', time: 2806.178, platformId: 'B', deviceId: 'prophet_jammer', kind: 'JAMMING', active: false },
      { sourceEventId: 'ON-2', time: 2806.44, platformId: 'A', deviceId: 'microwave_link', kind: 'COMMUNICATION', active: true },
    ]
    snapshot.tracks[1]!.positions.push({ ...snapshot.tracks[1]!.positions[1]!, time: 5400 })
    snapshot.recordCount += 1
    snapshot.durationS = 5400
    const fetchSpy = vi.fn().mockResolvedValueOnce(successResponse(snapshot.initial)).mockResolvedValue(successResponse(snapshot))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage()
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    const playback = useReplayStore()
    expect(playback.state).toBe('PLAYING')
    expect(wrapper.find('[aria-label="运行模式"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="simulation-step"]').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(playback.replay?.currentTimeS).toBe(1)
    expect(mapControllerMock.controller.setNodes).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ platformId: 'A', longitude: -78 })]))
    // 游标 1 秒尚未到达首次投递：业务链路为空，登记关联仍在兜底。
    expect(mapControllerMock.controller.setFileMessageLinks).toHaveBeenLastCalledWith([])
    expect(wrapper.get('[aria-label="态势图层"]').text()).not.toContain('登记关联')
    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    await vi.advanceTimersByTimeAsync(2000)
    expect(playback.replay?.currentTimeS).toBe(1)
    wrapper.findComponent({ name: 'ElSlider' }).vm.$emit('change', 2)
    await flushPromises()
    expect(playback.replay?.currentTimeS).toBe(2)
    // 游标 2 秒已越过首次投递：业务链路出现并让位，登记关联自动关闭。
    expect(mapControllerMock.controller.setFileMessageLinks).toHaveBeenLastCalledWith([messageLinkId])
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('potential', false)
    expect(mapControllerMock.controller.setFileDeviceStates).toHaveBeenLastCalledWith([expect.objectContaining({ active: false, deviceId: 'microwave_link' })])
    // 业务链路活跃窗口为 1.5–2805 秒：干扰窗口内存在，干扰结束（2806）后随之消失。
    for (const [time, jammerActive, microwaveActive, businessActive] of [
      [1666.178, true, false, true], [2300, true, true, true], [2302.44, true, false, true],
      [2806.178, false, false, false], [2806.44, false, true, false],
    ] as const) {
      wrapper.findComponent({ name: 'ElSlider' }).vm.$emit('change', time)
      await flushPromises()
      expect(wrapper.findComponent(OfflineSituationMap).props()).toMatchObject({ fileTime: time })
      expect(mapControllerMock.controller.setFileDeviceStates).toHaveBeenLastCalledWith(expect.arrayContaining([
        expect.objectContaining({ deviceId: 'prophet_jammer', active: jammerActive }),
        expect.objectContaining({ deviceId: 'microwave_link', active: microwaveActive }),
      ]))
      expect(mapControllerMock.controller.setFileLinks).toHaveBeenLastCalledWith(selectFileCommunicationLinks(FILE_CONNECTIONS, time))
      expect(mapControllerMock.controller.setFileMessageLinks)
        .toHaveBeenLastCalledWith(businessActive ? [messageLinkId] : [])
      // 登记关联始终与业务链路相反：有业务时让位，无业务时兜底。
      expect(mapControllerMock.controller.setLayerVisible)
        .toHaveBeenLastCalledWith('potential', !businessActive)
    }
    expect(wrapper.text()).toContain('46分46秒')
    wrapper.findComponent({ name: 'ElSlider' }).vm.$emit('change', 0)
    await flushPromises()
    expect(mapControllerMock.controller.setFileDeviceStates).toHaveBeenLastCalledWith([])
    // 退回 0 秒后业务链路消失，登记关联自动恢复兜底。
    expect(mapControllerMock.controller.setFileMessageLinks).toHaveBeenLastCalledWith([])
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('potential', true)
    expect(mapControllerMock.controller.setNodes).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ platformId: 'A', longitude: -77 })]))
    await wrapper.get('[aria-label="仿真倍速"]').setValue('4')
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await vi.advanceTimersByTimeAsync(1000)
    expect(playback.replay?.currentTimeS).toBe(4)
    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    expect(playback.localSnapshot).toBeNull()
    expect(wrapper.findComponent(OfflineSituationMap).props()).toMatchObject({ fileTime: 0 })
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    expect(playback.state).toBe('PLAYING')
    useAuthStore().resetToSafeEmpty()
    await flushPromises()
    expect(playback.localSnapshot).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:4173/api/v1/situation/initial-nodes',
      'http://127.0.0.1:4173/api/v1/replays/local-file',
      'http://127.0.0.1:4173/api/v1/replays/local-file',
    ])
  })

  it('文件模式下左右抽屉完整展示链路、干扰与时序，支持切页定位与同帧事件联动', async () => {
    const initial = structuredClone(INITIAL_NODES)
    initial.nodes[0]!.name = '指挥节点A'
    initial.nodes[1]!.name = '干扰平台B'
    initial.connections = FILE_CONNECTIONS
    initial.deviceEvents = [
      { sourceEventId: 'JAM-1', platformId: 'B', deviceId: 'prophet_jammer', kind: 'JAMMING', time: 0, active: true, frequencyHz: 2.4e9, bandwidthHz: 5e7 },
    ]
    const fetchSpy = vi.fn().mockResolvedValue(successResponse(initial))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage()

    // 1. 左侧抽屉各 Tab 全部可用（非 disabled）
    const tabs = wrapper.findAll('.scene-summary__tabs button')
    expect(tabs).toHaveLength(4)
    for (const tab of tabs) {
      expect(tab.attributes('disabled')).toBeUndefined()
    }

    // 2. 切换至链路 Tab，展示文件通信链路，支持点击定位
    await tabs[1]!.trigger('click')
    expect(wrapper.get('.scene-summary').text()).toContain('指挥节点A → 干扰平台B')
    expect(wrapper.findAll('.scene-summary .summary-focus-button')).toHaveLength(1)
    await wrapper.findAll('.scene-summary .summary-focus-button')[0]!.trigger('click')
    expect(mapControllerMock.controller.focusTarget).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'link' }),
    )

    // 3. 切换至干扰 Tab，展示干扰设备
    await tabs[2]!.trigger('click')
    expect(wrapper.get('.scene-summary').text()).toContain('机载干扰设备')
    expect(wrapper.get('.scene-summary').text()).toContain('活动')

    // 4. 切换至时序 Tab，展示文件回放时序
    await tabs[3]!.trigger('click')
    expect(wrapper.get('.scene-summary').text()).toContain('文件回放时序')
    expect(wrapper.get('.scene-summary').text()).toContain('sample.csv')

    // 5. 右侧面板展示全链路状态、干扰卡片与同帧事件
    const panel = wrapper.get('.telemetry-panel')
    expect(panel.findAll('tr[data-link-id]')).toHaveLength(1)
    expect(panel.text()).toContain('指挥节点A→干扰平台B')
    expect(panel.get('.link-device-status').text()).toBe('干扰')

    // 点击表格行定位链路
    await panel.find('tr[data-link-id]').trigger('click')
    expect(mapControllerMock.controller.focusTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'link' }),
    )

    // 干扰设备卡片
    expect(panel.findAll('.jammer-list article')).toHaveLength(1)
    expect(panel.text()).toContain('机载干扰设备')
    expect(panel.text()).toContain('2400 MHz')

    // 同帧事件
    expect(panel.findAll('.event-list li')).toHaveLength(1)
    expect(panel.text()).toContain('启动 prophet_jammer')
  })

  it.each(['离页', '登出'])('文件播放加载在途%s，迟到响应不得启动播放或恢复数据', async reason => {
    let finish!: (response: Response) => void
    const fetchSpy = vi.fn().mockResolvedValueOnce(successResponse(LOCAL_REPLAY.initial))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage()
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    const signal = fetchSpy.mock.calls[1]![1].signal as AbortSignal
    if (reason === '离页') { wrapper.unmount(); mountedWrapper = null }
    else useAuthStore().resetToSafeEmpty()
    expect(signal.aborted).toBe(true)
    finish(successResponse(LOCAL_REPLAY))
    await flushPromises()
    expect(useReplayStore().localSnapshot).toBeNull()
    expect(useReplayStore().state).toBe('EMPTY')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('文件播放快照加载失败显示错误，不继续显示旧位置或启动引擎', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(successResponse(LOCAL_REPLAY.initial)).mockRejectedValue(new Error('位置文件读取失败'))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage()
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('位置文件读取失败')
    expect(wrapper.findComponent(OfflineSituationMap).exists()).toBe(true)
    expect(mapControllerMock.latestOptions).toMatchObject({ frame: null, initialNodes: [], links: [] })
    expect(mapControllerMock.latestOptions?.fileLinks ?? []).toEqual([])
    expect(mapControllerMock.latestOptions?.fileMessageLinks ?? []).toEqual([])
    expect(useReplayStore().localSnapshot).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('文件干扰节点晚于地图加载时开启图层，位置刷新保留用户关闭选择', async () => {
    mountedWrapper = mount(OfflineSituationMap, {
      props: { frame: null, initialNodes: [], links: [], selectedNodeId: '', focusTarget: null,
        fileDeviceEvents: [{ sourceEventId: 'JAM-1', platformId: 'jammer_station_01', deviceId: 'prophet_jammer', kind: 'JAMMING', time: 0, active: true, frequencyHz: 2.4e9, bandwidthHz: 5e7 }] },
      global: { plugins: [ElementPlus] },
    })
    const wrapper = mountedWrapper
    const button = wrapper.findAll('[aria-label="态势图层"] button').find(b => b.text() === '干扰范围')!
    expect(button.attributes('disabled')).toBeDefined()
    const nodes = [{ ...INITIAL_NODES.nodes[0]!, platformId: 'jammer_station_01', name: '地面干扰站01' }]
    await wrapper.setProps({ initialNodes: nodes })
    expect(button.attributes('disabled')).toBeUndefined()
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('interference', true)
    await button.trigger('click')
    await wrapper.setProps({ initialNodes: nodes.map(node => ({ ...node, latitude: 25.1 })) })
    expect(button.attributes('aria-pressed')).toBe('false')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('interference', false)
    await wrapper.setProps({ initialNodes: [] })
    await wrapper.setProps({ initialNodes: nodes })
    expect(button.attributes('aria-pressed')).toBe('true')
  })


  it.each([
    ['jammer_station_01', '地面干扰站01', true],
    ['jammer_airborne_01', '机载干扰平台01', true],
    ['UNKNOWN', '地面干扰站01', false],
  ] as const)('文件节点 %s 按原始身份显示指定干扰范围，公里标注不伪造运行状态', async (id, name, hasRange) => {
    const initial = structuredClone(INITIAL_NODES)
    initial.nodes[0] = { ...initial.nodes[0]!, platformId: id, name }
    if (hasRange) initial.deviceEvents = [{ sourceEventId: 'JAM-1', platformId: id, deviceId: 'prophet_jammer', kind: 'JAMMING', time: 0, active: true, frequencyHz: 2.4e9, bandwidthHz: 5e7 }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse(initial)))
    const wrapper = await mountSituationPage()
    const button = wrapper.findAll('[aria-label="态势图层"] button').find(b => b.text() === '干扰范围')!
    expect(button.attributes('disabled') !== undefined).toBe(!hasRange)
    expect(button.attributes('aria-pressed')).toBe(String(hasRange))
    mapControllerMock.latestOptions?.onSelectNode(id)
    await flushPromises()
    const detail = document.querySelector('[data-testid="selected-node-dialog"]')?.textContent ?? ''
    expect(detail.includes('44.448 公里（指定范围）')).toBe(hasRange)
    expect(detail).not.toContain('活动干扰')
    if (hasRange) {
      await button.trigger('click')
      expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('interference', false)
    }
  })

  it('流向动画默认跟随系统的减少动态效果偏好，并把初值同步给地图控制器', async () => {
    const mountWith = async (reduced: boolean) => {
      vi.stubGlobal('matchMedia', () => ({ matches: reduced }))
      mapControllerMock.controller.setLayerVisible.mockClear()
      mountedWrapper = mount(OfflineSituationMap, {
        props: {
          frame: null, initialNodes: SATELLITE_FILE_NODES, fileLinks: [], fileMessageLinks: [MESSAGE_LINK],
          fileDeviceEvents: [], fileTime: 2000, links: [], selectedNodeId: '', focusTarget: null,
        },
        global: { plugins: [ElementPlus] },
      })
      return mountedWrapper
    }
    try {
      // 允许动效：流向动画默认开启，不需要额外同步。
      const animated = await mountWith(false)
      const animatedButton = animated.get('[aria-label="态势图层"] button:nth-child(3)')
      expect(animatedButton.text()).toBe('流向动画')
      expect(animatedButton.attributes('aria-pressed')).toBe('true')
      expect(mapControllerMock.controller.setLayerVisible).not.toHaveBeenCalledWith('flow', false)
      animated.unmount()

      // 要求减少动效：按钮默认关闭，并且必须把关闭状态同步给控制器，否则按钮与实际图层不一致。
      const reduced = await mountWith(true)
      const reducedButton = reduced.get('[aria-label="态势图层"] button:nth-child(3)')
      expect(reducedButton.attributes('aria-pressed')).toBe('false')
      expect(mapControllerMock.controller.setLayerVisible).toHaveBeenCalledWith('flow', false)
      // 按钮仍可用，用户可手动打开。
      expect(reducedButton.attributes('disabled')).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('流向动画的关键帧声明在组件 scoped 样式内，控制器不写行内动画名', async () => {
    const fsModule = 'node:fs'
    const { readFileSync } = await import(fsModule)
    const component = readFileSync('src/components/situation/OfflineSituationMap.vue', 'utf8')
    const controller = readFileSync('src/components/situation/situation-map-controller.ts', 'utf8')
    // Vue 会给 scoped @keyframes 加哈希重命名，只有同一 scoped 块里的 animation-name 会被一起改写。
    // 行内动画名不会被改写，会指向不存在的关键帧（曾导致动画完全不生效），因此动画名必须由 CSS 提供。
    expect(component).toMatch(/@keyframes situation-map-link-flow\s*\{/)
    expect(component).toMatch(/animation-name:\s*situation-map-link-flow;/)
    expect(component).toMatch(/:deep\(\.situation-map-link-flow\)/)
    expect(controller).toMatch(/className: 'situation-map-link-flow'/)
    expect(controller).not.toMatch(/style\.animation\b/)
    expect(controller).not.toMatch(/style\.animationName/)
    // 行内只允许覆盖时长与滚动位移量。
    expect(controller).toMatch(/style\.animationDuration/)
    expect(controller).toMatch(/setProperty\('--situation-link-flow-shift'/)
    // 路径归一化保证长短链路和缩放后都只有一颗流星。
    expect(controller).toMatch(/setAttribute\('pathLength'/)
    expect(controller).toContain('MAP_CONFIG.linkFlowTrailRatio')
  })

  it('业务链路详情展示业务类型、活跃窗口与投递时延，并在游标早于首次投递时不显示', async () => {
    // 经 mountedWrapper 持有组件以获得宽松的 setProps 类型，与页内其他用例一致。
    mountedWrapper = mount(OfflineSituationMap, {
      props: {
        frame: null, initialNodes: SATELLITE_FILE_NODES, fileMessageLinks: [MESSAGE_LINK],
        fileDeviceEvents: [], fileTime: 2, links: [], selectedNodeId: '', focusTarget: null,
      },
      global: { plugins: [ElementPlus] },
    })
    const wrapper = mountedWrapper
    expect(mapControllerMock.latestOptions?.fileMessageLinks).toHaveLength(1)
    expect(typeof mapControllerMock.latestOptions?.onSelectFileMessageLink).toBe('function')
    // 图例只描述链路类别；此刻已有业务链路，额外出现投递方向说明。
    expect(wrapper.get('[aria-label="链路类型图例"]').text()).toContain('消息投递方向')
    mapControllerMock.latestOptions?.onSelectFileMessageLink?.(MESSAGE_LINK)
    await flushPromises()
    const details = wrapper.find('[data-testid="message-link-details"]')
    expect(details.exists()).toBe(true)
    const text = details.text()
    expect(text).toContain('卫星通信业务链路')
    expect(text).toContain('sat_link')
    expect(text).toContain('1.5 – 1.5 秒')
    expect(text).toContain('CMD_ORDER')
    expect(text).toContain('121.000 毫秒（0.121 秒）')
    expect(text).toContain('不提供 SNR、BER、丢包率')
    expect(text).toContain('LOG-L20')
    // 游标早于首次投递时不显示任何业务链路，也不泄露未来投递。
    mapControllerMock.controller.setFileMessageLinks.mockClear()
    await wrapper.setProps({ fileTime: 1.4 })
    expect(mapControllerMock.controller.setFileMessageLinks).toHaveBeenLastCalledWith([])
    await wrapper.setProps({ fileTime: 1.5 })
    expect(mapControllerMock.controller.setFileMessageLinks).toHaveBeenLastCalledWith([messageLinkId])
  })

  it('静止状态（游标 0）没有业务链路，但登记关联仍在，地图不会一条连线都没有', async () => {
    const fileLinks = selectFileCommunicationLinks(FILE_CONNECTIONS, 0)
    expect(fileLinks.length).toBeGreaterThan(0)
    // 第一条消息在 t=2 才投递，因此游标 0 的业务链路集合必须为空。
    expect(selectFileMessageLinks([MESSAGE_LINK], 0)).toEqual([])
    const wrapper = mount(OfflineSituationMap, {
      props: {
        frame: null, initialNodes: SATELLITE_FILE_NODES, fileLinks, fileMessageLinks: [MESSAGE_LINK],
        fileDeviceEvents: [], fileTime: 0, links: [], selectedNodeId: '', focusTarget: null,
      },
      global: { plugins: [ElementPlus] },
    })
    mountedWrapper = wrapper
    // 游标未变化时不会触发 watcher，业务链路在构造时通过 options 传入。
    expect(mapControllerMock.latestOptions?.fileMessageLinks).toEqual([])
    const layerBar = wrapper.get('[aria-label="态势图层"]')
    // 此刻没有业务链路，链路按钮禁用；登记关联按钮已移除，登记关联在底层自动兜底。
    expect(layerBar.get('button:nth-child(2)').attributes('disabled')).toBeDefined()
    expect(layerBar.text()).not.toContain('登记关联')
    expect(mapControllerMock.latestOptions?.fileLinks).toEqual(fileLinks)
  })

  it('业务链路出现时登记关联自动让位，回到无业务时刻自动恢复', async () => {
    // 第一条投递在 1.5 秒，游标 0 与 1.4 秒都没有业务链路。
    const fileLinks = selectFileCommunicationLinks(FILE_CONNECTIONS, 0)
    mountedWrapper = mount(OfflineSituationMap, {
      props: {
        frame: null, initialNodes: SATELLITE_FILE_NODES, fileLinks, fileMessageLinks: [MESSAGE_LINK],
        fileDeviceEvents: [], fileTime: 0, links: [], selectedNodeId: '', focusTarget: null,
      },
      global: { plugins: [ElementPlus] },
    })
    const wrapper = mountedWrapper
    const linksButton = () => wrapper.get('[aria-label="态势图层"] button:nth-child(2)')
    expect(wrapper.get('[aria-label="态势图层"]').text()).not.toContain('登记关联')
    // 静止时刻没有业务链路：登记关联显示兜底，链路按钮不可用。
    expect(mapControllerMock.latestOptions?.fileMessageLinks).toEqual([])
    expect(linksButton().attributes('disabled')).toBeDefined()

    // 游标仍未到达首次投递：登记关联必须继续兜底，否则地图会一条连线都没有。
    await wrapper.setProps({ fileTime: 1.4 })

    // 第一条投递到达：业务链路出现，登记关联自动关闭让位。
    await wrapper.setProps({ fileTime: 1.5 })
    expect(mapControllerMock.controller.setFileMessageLinks).toHaveBeenLastCalledWith([messageLinkId])
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('potential', false)
    expect(linksButton().attributes('disabled')).toBeUndefined()

    // 游标退回无业务时刻：登记关联自动恢复兜底。
    await wrapper.setProps({ fileTime: 1.4 })
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('potential', true)
  })

  it('地图详情消费当前时刻的设备事件，回退与重载移除旧状态，通信关闭不改变登记关联', async () => {
    const links = selectFileCommunicationLinks(FILE_CONNECTIONS, 0)
    const events: FileDeviceEvent[] = [
      { sourceEventId: 'LOG-L1', platformId: 'A', deviceId: 'sat-a', kind: 'COMMUNICATION', time: 0, active: true },
      { sourceEventId: 'LOG-L2', platformId: 'A', deviceId: 'sat-a', kind: 'COMMUNICATION', time: 2301.17, active: false },
      { sourceEventId: 'LOG-L3', platformId: 'A', deviceId: 'prophet_jammer', kind: 'JAMMING', time: 1666.44, active: true, frequencyHz: 2.4e9, bandwidthHz: 5e7 },
    ]
    mountedWrapper = mount(OfflineSituationMap, {
      props: { frame: null, initialNodes: INITIAL_NODES.nodes, fileLinks: links, fileDeviceEvents: events, fileTime: 0, links: [], selectedNodeId: 'A', focusTarget: null },
      global: { plugins: [ElementPlus] }, attachTo: document.body,
    })
    const wrapper = mountedWrapper
    mapControllerMock.latestOptions?.onSelectNode('A')
    await flushPromises()
    const list = document.querySelector('[data-testid="node-file-associations"]')!
    expect(list.textContent).toContain('卫星通信')
    const viewButton = list.querySelector('button') as HTMLButtonElement
    viewButton.click()
    await flushPromises()
    const details = () => document.querySelector('[data-testid="selected-node-dialog"]')?.textContent ?? ''
    const association = () => document.querySelector('[data-testid="file-link-details"]')?.textContent ?? ''
    expect(details()).toContain('已开启')
    expect(details()).not.toContain('干扰请求进行中')
    await wrapper.setProps({ fileTime: 1666.44 })
    await flushPromises()
    expect(details()).toContain('干扰请求进行中')
    expect(details()).toContain('2400 MHz')
    expect(details()).toContain('50 MHz')
    expect(details()).toContain('LOG-L3')
    await wrapper.setProps({ fileTime: 2301.17 })
    await flushPromises()
    expect(details()).toContain('已关闭')
    expect(association()).toContain('已关闭 · 2301.17 秒 · LOG-L2')
    expect(association()).toContain('启停未知（无对应事件）')
    expect(association()).toContain('LOG-L20')
    expect(association()).toContain('不表示当前正在转发')
    expect(association()).not.toMatch(/正常|劣化|中断/)
    expect(mapControllerMock.latestOptions?.fileLinks).toEqual(links)
    expect(mapControllerMock.controller.setFileDeviceStates).toHaveBeenLastCalledWith(selectFileDeviceStates(events, 2301.17))
    const stopped = buildFileDeviceEvents(parseAfsimEventLog([
      '! WEAPON_TURNED_OFF,time<time>,event<string>,platform<string>,side<string>,type<string>,system_platform<string>,system_type<string>',
      '2806.178,WEAPON_TURNED_OFF,A,red,Weapon,prophet_jammer,WSF_RF_JAMMER',
    ].join('\n')).events, new Set(['A', 'B']))
    await wrapper.setProps({ fileDeviceEvents: [...events, ...stopped], fileTime: 2806.178 })
    await flushPromises()
    expect(details()).toContain('干扰已停止')
    expect(details()).not.toContain('NaN')
    expect(details()).not.toContain('2400 MHz')
    await wrapper.setProps({ fileTime: 0 })
    await flushPromises()
    expect(details()).toContain('已开启')
    expect(details()).not.toContain('已关闭')
    expect(details()).not.toContain('干扰请求进行中')
    await wrapper.setProps({ fileDeviceEvents: [] })
    await flushPromises()
    expect(details()).toContain('当前时刻无设备启停或干扰请求记录，状态未知')
    expect(mapControllerMock.controller.setFileDeviceStates).toHaveBeenLastCalledWith([])
  })

  it('态势页通过正式初始快照加载设备事件，仅投影零秒而不泄露未来干扰请求', async () => {
    const initial = structuredClone(INITIAL_NODES)
    initial.nodes[0]!.platformId = 'jammer_airborne_01'
    initial.nodes[1]!.platformId = 'jammer_station_01'
    initial.deviceEvents = initial.nodes.map((node, index) => ({
      sourceEventId: `LOG-L${index + 1}`, platformId: node.platformId, deviceId: `jammer-${index}`,
      kind: 'JAMMING', time: index === 0 ? 0 : 1666.44, active: true, frequencyHz: 2.4e9, bandwidthHz: 2e7,
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse(initial)))
    const wrapper = await mountSituationPage()
    expect(mapControllerMock.latestOptions?.fileDeviceStates).toEqual([initial.deviceEvents[0]])
    expect(wrapper.get('.telemetry-panel').text()).toContain('文件设备启停与干扰请求请在地图节点详情查看')
    mapControllerMock.latestOptions?.onSelectNode('jammer_airborne_01')
    await flushPromises()
    expect(document.querySelector('[data-testid="selected-node-dialog"]')?.textContent).toContain('干扰请求进行中')
    expect(document.querySelector('[data-testid="selected-node-dialog"]')?.textContent).not.toContain('1666.44')
  })

  it.each([['无人机01', '无人机02'], ['A', 'B']])('真实通信关联只展示零秒登记，端点复用节点名称 %s/%s 并保留原始标识', async (sourceName, targetName) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const initial = structuredClone(INITIAL_NODES)
    initial.nodes[0]!.name = sourceName
    initial.nodes[1]!.name = targetName
    const fetchSpy = vi.fn().mockResolvedValueOnce(successResponse({ ...initial, connections: FILE_CONNECTIONS }))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage()
    expect(wrapper.get('[aria-label="链路类型图例"]').text()).toBe(
      '卫星链路微波链路新一代数传链路激光链路受干扰 / 失效链路光纤链路',
    )
    expect(wrapper.find('[aria-label="通信关联图例"]').exists()).toBe(false)
    expect(mapControllerMock.latestOptions?.fileLinks?.map(link => link.type)).toEqual(['SAT'])
    // 登记关联按钮已移除；真实业务链路按钮此时没有消息证据而是禁用的。
    expect(wrapper.get('[aria-label="态势图层"]').text()).not.toContain('登记关联')
    expect(wrapper.get('[aria-label="态势图层"] button:nth-child(2)').attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    const links = selectFileCommunicationLinks(FILE_CONNECTIONS, 0)
    expect(mapControllerMock.latestOptions?.fileLinks).toEqual(links)
    // 图例只保留六类链路样式，不描述登记关联兜底。
    expect(wrapper.get('[aria-label="链路类型图例"]').findAll('i')).toHaveLength(6)
    mapControllerMock.latestOptions?.onSelectFileLink?.(links[0]!)
    await flushPromises()
    const details = document.querySelector('[data-testid="file-link-details"]')
    const sourceLabel = sourceName === 'A' ? 'A' : `${sourceName}（A）`
    const targetLabel = targetName === 'B' ? 'B' : `${targetName}（B）`
    expect(details?.querySelector('p')?.textContent).toContain(`${sourceLabel} — ${targetLabel}`)
    const row = details?.querySelector('.el-table__body tbody tr')
    expect(row?.textContent).toContain(`${sourceLabel} / sat-a`)
    expect(row?.textContent).toContain(`${targetLabel} / sat-b`)
    expect(row?.textContent).toContain('0.1.0.1')
    expect(row?.textContent).toContain('0.1.0.2')
    expect(initial.nodes.map(node => node.platformId)).toEqual(['A', 'B'])
    expect(details?.textContent).toContain('卫星通信')
    expect(details?.textContent).toContain('状态未知')
    expect(details?.textContent).toContain('satcom_1')
    expect(details?.textContent).toContain('LOG-L20')
    expect(details?.textContent).not.toMatch(/正常|劣化|中断/)
    expect(wrapper.find('.metric-panel').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(mapControllerMock.latestOptions?.fileLinks).toEqual(links)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('进入已选场景后展示配置节点、使用该编号开始 Mock，移除页内选择入口且不混入固定遥测', async () => {
    const config = structuredClone(fixtureSource.scenario)
    config.scenario.id = 'SCN-B'
    config.scenario.name = '选择的场景 B'
    config.platforms[0]!.name = '场景 B 指挥节点'
    const scene = { config, revision: 3, officialLibraryChanged: false, locked: false,
      uiExtensions: { jammers: config.jammers.map(item => ({ jammerId: item.id, direction: 360, duration: 60, enabled: true })),
        sensors: config.sensors.map(item => ({ sensorId: item.id, type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true })) } }
    let current = structuredClone(fixtureSource.run) as SimulationRun
    const confirmation: ConfirmationContext = { confirmationId: 'CONF-SELECTED', state: 'AWAITING_CONFIRMATION', actor: 'operator', role: 'OPERATOR',
      createdAt: '2026-08-06T08:00:00Z', expiresAt: '2026-08-06T08:05:00Z' }
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/situation/initial-nodes')) return successResponse(null)
      if (url.includes('/frames/')) return successResponse(SITUATION_FRAME_F00042)
      if (url.endsWith('/events')) return successResponse(SITUATION_EVENTS_F00042)
      if (url.endsWith('/scenarios')) return successResponse([scene])
      if (url.endsWith('/scenarios/SCN-B')) return successResponse(scene)
      if (url.endsWith('/simulations') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body)).scenarioId).toBe('SCN-B')
        current = { ...current, scenarioId: 'SCN-B', uiStatus: 'IDLE', configLocked: true }
        current.canonical = { ...current.canonical, status: 'IDLE', currentTime: 0, progress: 0 }
        return successResponse(current)
      }
      if (url.endsWith('/confirmations')) return successResponse(confirmation)
      if (url.endsWith('/confirmations/CONF-SELECTED')) return successResponse({ ...confirmation, state: 'CONFIRMED' })
      if (url.endsWith('/commands')) {
        const command = JSON.parse(String(init?.body)).command
        const status = command === 'STOP' ? 'STOPPED' : command === 'PAUSE' || command === 'STEP' ? 'PAUSED' : 'RUNNING'
        current = { ...current, uiStatus: status, configLocked: command !== 'STOP', canonical: { ...current.canonical,
          status: status === 'STOPPED' ? 'IDLE' : status,
          currentTime: command === 'STEP' ? current.canonical.currentTime + config.scenario.timeStep : command === 'STOP' ? 0 : current.canonical.currentTime } }
        return successResponse(current)
      }
      return successResponse([current])
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = await mountSituationPage('SCN-B')
    const savedConfig = JSON.stringify(useSimulationStore().selectedScene?.config)
    expect(wrapper.find('.scenario-selection').exists()).toBe(false)
    expect(wrapper.find('[data-testid="situation-scene-select"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('用于态势与 Mock 运行的场景')
    const summary = wrapper.get('.scene-summary')
    const nodeButton = summary.get(`[data-testid="focus-node-${config.platforms[0]!.id}"]`)
    expect(Array.from(nodeButton.element.children).map(element => element.tagName)).toEqual(['SPAN', 'SMALL'])
    expect(nodeButton.get('span').text()).toBe(config.platforms[0]!.id)
    expect(nodeButton.get('small').text()).toBe('后方指挥节点')
    expect(nodeButton.text()).not.toContain('场景 B 指挥节点')
    expect(summary.text()).toContain('信息节点')
    expect(summary.text()).toContain('支撑实体')
    await summary.get(`[data-testid="focus-node-${config.platforms[0]!.id}"]`).trigger('click')
    expect(mapControllerMock.controller.focusTarget).toHaveBeenLastCalledWith({ kind: 'node', targetId: config.platforms[0]!.id })
    mapControllerMock.latestOptions!.onSelectNode(config.platforms[1]!.id)
    await flushPromises()
    expect(summary.get(`[data-testid="focus-node-${config.platforms[1]!.id}"]`).attributes('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-testid="selected-node-dialog"]')?.textContent).toContain('暂无运行数据')
    expect(wrapper.find('.saved-scene__config').exists()).toBe(false)
    expect(wrapper.get('.situation-page__workspace .situation-center').find('[data-testid="saved-scene-preview"]').exists()).toBe(true)
    expect(summary.findAll('[role="tab"]').map(tab => tab.text())).toEqual(['节点', '链路', '干扰', '时序'])
    await summary.findAll('[role="tab"]')[1]!.trigger('click')
    const linkButton = summary.get('[data-testid="focus-link-L-MW-01"]')
    expect(Array.from(linkButton.element.children).map(element => element.tagName)).toEqual(['SPAN', 'SMALL'])
    expect(linkButton.get('span').text()).toBe('L-MW-01')
    expect(linkButton.get('small').text()).toBe('微波链路')
    const configured = mapControllerMock.latestOptions!.configuredLinks!
    expect(configured.map(link => link.id)).toEqual(config.links.map(link => link.id))
    await summary.get('[data-testid="focus-link-L-MW-01"]').trigger('click')
    expect(mapControllerMock.controller.focusTarget).toHaveBeenLastCalledWith({ kind: 'link', targetId: 'L-MW-01' })
    mapControllerMock.latestOptions!.onSelectConfiguredLink!(configured.find(link => link.id === 'L-MW-01')!)
    await flushPromises()
    const detail = document.querySelector('[data-testid="link-detail-configured"]')
    expect(detail?.textContent).toContain('尚无当前运行结果')
    expect(detail?.textContent).toContain(`${config.links.find(link => link.id === 'L-MW-01')!.frequency} MHz`)
    expect(detail?.textContent).toContain('规范状态暂无数据')
    expect(detail?.textContent).not.toMatch(/固定帧|正常|劣化|中断/)
    const telemetryPanel = wrapper.get('.telemetry-panel')
    expect(telemetryPanel.findAll('.panel-heading strong').map(item => item.text())).toEqual(['全链路状态', '干扰 / 侦测设备', '同帧事件'])
    expect(telemetryPanel.findAll('th').map(item => item.text())).toEqual(['链路', '体制', '状态'])
    expect(telemetryPanel.findAll('tr[data-link-id]')).toHaveLength(config.links.length)
    const linkRow = telemetryPanel.get('tr[data-link-id="L-MW-01"]')
    expect(linkRow.findAll('td').slice(2).map(item => item.text())).toEqual(['暂无数据'])
    expect(telemetryPanel.find('.link-state-badge').exists()).toBe(false)
    expect(telemetryPanel.find('[data-testid="open-link-candidates"]').exists()).toBe(false)
    expect(telemetryPanel.get('.telemetry-section--links .panel-heading').text()).toBe('全链路状态')
    await linkRow.trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="link-detail-configured"]')).not.toBeNull()
    await linkRow.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(document.querySelector('[data-testid="link-detail-configured"]')?.textContent).toContain('规范状态暂无数据')
    expect(telemetryPanel.findAll('.jammer-list article')).toHaveLength(config.jammers.length)
    expect(telemetryPanel.findAll('.jammer-list article > div > span').map(item => item.text())).toEqual(config.jammers.map(() => '暂无数据'))
    expect(telemetryPanel.text()).toContain('已保存配置；暂无当前运行数据')
    expect(telemetryPanel.find('.detection-state').exists()).toBe(false)
    expect(telemetryPanel.findAll('.event-list li')).toHaveLength(0)
    expect(telemetryPanel.text()).toContain('暂无当前运行事件')
    expect(telemetryPanel.attributes('data-collapsed')).toBe('false')
    expect(wrapper.get('.situation-page__workspace').classes()).not.toContain('situation-page__workspace--telemetry-collapsed')
    await telemetryPanel.get('[data-testid="toggle-telemetry-panel"]').trigger('click')
    expect(telemetryPanel.attributes('data-collapsed')).toBe('true')
    expect(telemetryPanel.get('[data-testid="toggle-telemetry-panel"]').attributes('aria-expanded')).toBe('false')
    await telemetryPanel.get('[data-testid="toggle-telemetry-panel"]').trigger('click')
    expect(telemetryPanel.attributes('data-collapsed')).toBe('false')
    expect(telemetryPanel.get('[data-testid="toggle-telemetry-panel"]').attributes('aria-expanded')).toBe('true')
    await summary.findAll('[role="tab"]')[2]!.trigger('click')
    expect(summary.findAll('.summary-focus-button')).toHaveLength(config.jammers.length)
    expect(summary.text()).toContain('暂无数据')
    await summary.get(`[data-testid="focus-interference-${config.jammers[0]!.id}"]`).trigger('click')
    expect(mapControllerMock.controller.focusTarget).toHaveBeenLastCalledWith({ kind: 'node', targetId: config.jammers[0]!.platformId })
    await summary.findAll('[role="tab"]')[3]!.trigger('click')
    expect(summary.text()).toContain('运行时序')
    expect(summary.findAll('dt').map(item => item.text())).toEqual(['帧标识', '任务 / 运行', '仿真时刻', '帧序号'])
    expect(summary.text()).toContain('暂无数据')
    expect(summary.text()).not.toContain('F-00042')
    await summary.get('[data-testid="toggle-scene-summary"]').trigger('click')
    expect(summary.attributes('data-collapsed')).toBe('true')
    expect(summary.get('[data-testid="toggle-scene-summary"]').attributes('aria-expanded')).toBe('false')
    await summary.get('[data-testid="toggle-scene-summary"]').trigger('click')
    expect(summary.attributes('data-collapsed')).toBe('false')
    expect(wrapper.find('.simulation-toolbar__runtime').exists()).toBe(false)
    expect(wrapper.find('.telemetry-panel').exists()).toBe(true)
    expect(wrapper.find('[data-frame-id="F-00042"]').exists()).toBe(false)
    expect(mapControllerMock.latestOptions?.frame).toBeNull()
    expect(mapControllerMock.latestOptions?.initialNodes?.[0]?.name).toBe('场景 B 指挥节点')
    const telemetryCalls = fetcher.mock.calls.filter(([url]) => /frames|events|initial-nodes|positions/.test(url)).length
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    expect(useSimulationStore().run?.scenarioId).toBe('SCN-B')
    expect(useSimulationStore().uiStatus).toBe('RUNNING')
    expect(useSimulationStore().run?.configLocked).toBe(true)
    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    await flushPromises()
    expect(useSimulationStore().uiStatus).toBe('PAUSED')
    expect(wrapper.find('[data-testid="simulation-step"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="运行模式"]').exists()).toBe(false)
    expect(useSimulationStore().currentTime).toBe(0)
    expect(mapControllerMock.latestOptions?.initialNodes?.[0]?.longitude).toBe(config.platforms[0]!.initialPosition.longitude)
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    expect(useSimulationStore().uiStatus).toBe('RUNNING')
    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLElement>('[data-testid="confirm-stop"]')!.click()
    await flushPromises()
    expect(useSimulationStore().uiStatus).toBe('STOPPED')
    expect(useSimulationStore().run?.configLocked).toBe(false)
    expect(JSON.stringify(useSimulationStore().selectedScene?.config)).toBe(savedConfig)
    expect(wrapper.find('[data-testid="saved-scene-preview"]').exists()).toBe(true)
    expect(fetcher.mock.calls.filter(([url]) => /frames|events|initial-nodes|positions/.test(url))).toHaveLength(telemetryCalls)
  })

  it('真实日志读取失败保留空底图，不回显预置 Mock 数据，重试成功后显示节点', async () => {
    const fetchSpy = vi.fn().mockRejectedValueOnce(new Error('读取失败'))
      .mockResolvedValueOnce(successResponse(INITIAL_NODES))
      .mockResolvedValue(successResponse(null))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage()
    expect(wrapper.text()).toContain('初始节点读取失败')
    expect(wrapper.find('[data-testid="leaflet-situation-map"]').exists()).toBe(true)
    const status = wrapper.get('[role="status"][aria-label="态势数据加载状态"]')
    expect(status.element.previousElementSibling?.querySelector('.offline-map')).not.toBeNull()
    expect(status.element.closest('.el-dialog, .el-overlay')).toBeNull()
    expect(status.get('button').classes()).toContain('is-link')
    expect(mapControllerMock.latestOptions).toMatchObject({ frame: null, initialNodes: [], links: [] })
    expect(mapControllerMock.latestOptions?.fileLinks ?? []).toEqual([])
    expect(mapControllerMock.latestOptions?.fileMessageLinks ?? []).toEqual([])
    expect(wrapper.find('.telemetry-panel').exists()).toBe(false)
    await wrapper.get('.telemetry-empty button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.summary-focus-button')).toHaveLength(2)
    expect(wrapper.find('.telemetry-empty').exists()).toBe(false)
    expect(mapControllerMock.latestOptions?.initialNodes).toEqual(INITIAL_NODES.nodes)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('节点请求挂起时底图已挂载，非法响应只显示错误且可重试', async () => {
    let resolveRequest!: (response: Response) => void
    const fetchSpy = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { resolveRequest = resolve }))
      .mockResolvedValueOnce(successResponse(INITIAL_NODES))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage()
    expect(wrapper.find('[data-testid="leaflet-situation-map"]').exists()).toBe(true)
    expect(wrapper.get('.telemetry-empty').text()).toContain('正在读取初始节点位置')
    expect(mapControllerMock.latestOptions).toMatchObject({ frame: null, initialNodes: [], links: [] })
    const mapElement = wrapper.get('[data-testid="leaflet-situation-map"]').element
    await wrapper.get('[aria-label="切换为深色地图"]').trigger('click')
    resolveRequest(successResponse({ nodes: 'invalid' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="leaflet-situation-map"]').exists()).toBe(true)
    expect(wrapper.get('.telemetry-empty').text()).toContain('初始节点读取失败')
    expect(mapControllerMock.createSituationMapController).toHaveBeenCalledOnce()
    await wrapper.get('.telemetry-empty button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.summary-focus-button')).toHaveLength(2)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="leaflet-situation-map"]').element).toBe(mapElement)
    expect(wrapper.find('[aria-label="切换为浅色地图"]').exists()).toBe(true)
    expect(mapControllerMock.createSituationMapController).toHaveBeenCalledOnce()
    expect(mapControllerMock.controller.destroy).not.toHaveBeenCalled()
  })

  it('文件含末帧位置时仍停留零秒，未来节点不显示，重新进入仍从初始位置显示', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const snapshot = {
      fileName: 'positions.csv', generation: 1, recordCount: 1, issueCount: 0, issues: [],
      waitingForLine: false, hasMore: false,
      nodes: [{ platformId: 'A', time: 5400, longitude: -78, latitude: 31, altitude: 10, speed: 220, heading: -1 }],
    }
    const initial = structuredClone(INITIAL_NODES)
    initial.nodes.push({ ...initial.nodes[0]!, platformId: 'FUTURE', name: '未来节点', time: 5 })
    const fetchSpy = vi.fn((url: string) => Promise.resolve(successResponse(
      url.endsWith('/positions') ? snapshot : initial,
    )))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage()
    expect(wrapper.text()).toContain('0分0秒 · 节点 2 个')
    expect(wrapper.findAll('.summary-focus-button')).toHaveLength(2)
    expect(mapControllerMock.latestOptions?.initialNodes).toEqual(INITIAL_NODES.nodes)
    mapControllerMock.latestOptions?.onSelectNode('A')
    await flushPromises()
    expect(document.querySelector('.selected-node-dialog')?.textContent).toContain('77.9617°W')
    const updates = mapControllerMock.controller.setNodes.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(mapControllerMock.controller.setNodes).toHaveBeenCalledTimes(updates)
    expect(document.querySelector('.selected-node-dialog')?.textContent).toContain('77.9617°W')
    expect(fetchSpy.mock.calls.some(([url]) => url.endsWith('/positions'))).toBe(false)
    expect(wrapper.get('[data-testid="focus-node-A"]').attributes('aria-pressed')).toBe('true')
    // 空底图加载业务数据时原地更新，只有离页才销毁。
    expect(mapControllerMock.createSituationMapController).toHaveBeenCalledOnce()
    expect(mapControllerMock.controller.destroy).not.toHaveBeenCalled()
    wrapper.unmount()
    mountedWrapper = null
    const requests = fetchSpy.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchSpy).toHaveBeenCalledTimes(requests)
    await mountSituationPage()
    expect(mapControllerMock.latestOptions?.initialNodes).toEqual(INITIAL_NODES.nodes)
    expect(fetchSpy).toHaveBeenCalledTimes(requests + 1)
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
    expect(useSimulationStore().run).toMatchObject({ uiStatus: 'RUNNING', configLocked: true, canonical: { processId: 2900 } })
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.simulation-toolbar__runtime').exists()).toBe(false)

    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    await flushPromises()
    expect(useSimulationStore().uiStatus).toBe('PAUSED')
    expect(wrapper.get('[data-testid="simulation-start"]').text()).toContain('继续')

    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    await flushPromises()
    const confirmButton = document.querySelector<HTMLElement>('[data-testid="confirm-stop"]')
    expect(confirmButton).not.toBeNull()
    confirmButton?.click()
    await flushPromises()

    expect(useSimulationStore().run).toMatchObject({ uiStatus: 'STOPPED', configLocked: false, canonical: { currentTime: 0, processId: null } })
    expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.simulation-toolbar__runtime').exists()).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(10)
  })

  it('删除常驻运行说明后，开始失败仍显示具体错误', async () => {
    const fetchSpy = situationFetch([
      [simulationRun('COMPLETED', false)],
      simulationRun('IDLE', true),
    ])
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage()
    fetchSpy.mockRejectedValueOnce(new Error('启动服务不可用'))
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.simulation-toolbar [role="alert"]').text()).toContain('启动服务不可用')
    expect(wrapper.find('[data-testid="engine-resource"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="simulation-clock"]').exists()).toBe(false)
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
    expect(wrapper.get('tr[data-link-id="L-DL-03"]').text()).not.toContain('7.10')
    const mapLinks = mapControllerMock.controller.setLinks.mock.lastCall?.[0]
    expect(mapLinks).toHaveLength(10)
    expect(mapLinks).toEqual(expect.arrayContaining([expect.objectContaining({ linkId: 'L-DL-03', snrDb: 7.1 })]))
  })

  it('从左侧摘要重复定位节点、链路和干扰设备并恢复对应图层', async () => {
    const wrapper = await mountSituationPage()
    const layerButtons = wrapper.findAll('[aria-label="态势图层"] button')
    // 本用例统计用户图层交互，不包含加载期空底图的初始化。
    mapControllerMock.controller.setLayerVisible.mockClear()
    mapControllerMock.controller.setSelectedNodeId.mockClear()

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
    await layerButtons.find(b => b.text() === '干扰范围')?.trigger('click')
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
    const pinia = createPinia()
    setActivePinia(pinia)
    const telemetry = useTelemetryStore()
    expect(await telemetry.loadFrame()).toBe(true)
    // 页面入口已移除，保留候选组件自身的数据与错误呈现回归。
    mountedWrapper = mount({ render: () => h(LinkCandidatePanel, {
      modelValue: true,
      frame: telemetry.frame,
      links: telemetry.frame ? selectSituationLinks(telemetry.frame) : [],
      capabilityState: telemetry.capabilityState,
      feedback: telemetry.resultMessage,
      onReload: () => { void telemetry.loadFrame() },
    }) }, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
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

  it.each([
    [false, false], [true, false], [false, true], [true, true],
  ])('卫星详情区分原始与示意坐标（真实模式=%s，配置来源=%s）', async (realPosition, configured) => {
    ;(MAP_CONFIG as { useSatelliteDataPosition: boolean }).useSatelliteDataPosition = realPosition
    const frame = structuredClone(SITUATION_FRAME_F00042)
    const satellite = frame.platforms.find(node => node.platformId === 'SAT-01')!
    satellite.longitude = 120.5
    satellite.latitude = 25.5
    const original = JSON.stringify(frame)
    mountedWrapper = mount(OfflineSituationMap, {
      attachTo: document.body,
      props: { frame: configured ? null : frame, initialNodes: configured ? frame.platforms : undefined,
        configuredLinks: configured ? [] : undefined, links: [], selectedNodeId: 'SAT-01', focusTarget: null },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    mapControllerMock.latestOptions!.onSelectNode('SAT-01')
    await flushPromises()
    const text = document.querySelector('[data-testid="selected-node-dialog"]')!.textContent!
    expect(text).toContain(`${configured ? '节点位置' : '遥测位置'}120.5°E / 25.5°N`)
    if (realPosition) {
      expect(text).not.toContain('地图临时示意位置')
      expect(text).not.toContain('120.82767°E / 26.018571°N')
      expect(text).toContain(`二维地图按卫星${configured ? '配置' : '遥测'}经纬度显示`)
    } else {
      expect(text).toContain('地图临时示意位置120.82767°E / 26.018571°N')
      expect(text).toContain('不是遥测或配置原值')
      expect(text).not.toContain('二维地图按卫星')
    }
    expect(JSON.stringify(frame)).toBe(original)
  })

  it('通过 Leaflet 控制器同步图层、视图、选择和销毁', async () => {
    const wrapper = await mountSituationPage()
    const options = mapControllerMock.latestOptions

    expect(options).not.toBeNull()
    const layerbar = wrapper.get('[aria-label="态势图层"]')
    const layerButtons = layerbar.findAll('button')
    expect(layerButtons).toHaveLength(5)
    expect(layerButtons.map((button) => button.text())).toEqual(['节点', '链路', '流向动画', '干扰范围', '经纬网'])
    const gridButton = layerButtons[4]
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
    const originalSatellite = SITUATION_FRAME_F00042.platforms.find(node => node.platformId === 'SAT-01')!
    expect(satelliteDialog?.textContent).toContain(`遥测位置${originalSatellite.longitude}°E / ${originalSatellite.latitude}°N`)
    expect(satelliteDialog?.textContent).toContain('地图临时示意位置120.82767°E / 26.018571°N')
    expect(satelliteDialog?.textContent).toContain('高度35786000 m')
    expect(satelliteDialog?.textContent).toContain('速度0 m/s')
    expect(satelliteDialog?.textContent).toContain('地图临时示意位置仅用于展示，不是遥测或配置原值；高度不按地图比例呈现。')

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
    expect(mapControllerMock.createSituationMapController).toHaveBeenCalledOnce()
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
    fileDeviceStates?: FileDeviceEvent[]
    configuredLinks?: Link[]
    onSelectConfiguredLink?: (link: Link) => void
    fileLinks?: FileCommunicationLink[]
    fileMessageLinks?: FileMessageLink[]
    onSelectFileLink?: (link: FileCommunicationLink) => void
    /** 登记关联图层默认关闭；需要检查其渲染的用例显式开启。 */
    showPotentialLayer?: boolean
    onSelectNode?: (platformId: string) => void
    onSelectLink?: (link: SituationLinkView) => void
    onZoomChange?: (zoom: number) => void
    useSatelliteDataPosition?: boolean
  } = {}) {
    vi.resetModules()
    vi.doUnmock('../../src/components/situation/situation-map-controller')
    const { MAP_CONFIG: activeConfig } = await import('../../src/config/map.config')
    if (options.useSatelliteDataPosition !== undefined) {
      ;(activeConfig as any).useSatelliteDataPosition = options.useSatelliteDataPosition
    }
    const { createSituationMapController } = await import('../../src/components/situation/situation-map-controller')

    container = document.createElement('div')
    container.style.width = '800px'
    container.style.height = '500px'
    document.body.append(container)

    const controller = createSituationMapController({
      container,
      frame: options.initialNodes ? null : reactive(structuredClone(SITUATION_FRAME_F00042)),
      initialNodes: options.initialNodes,
      fileDeviceStates: options.fileDeviceStates,
      configuredLinks: options.configuredLinks,
      onSelectConfiguredLink: options.onSelectConfiguredLink,
      fileLinks: options.fileLinks,
      fileMessageLinks: options.fileMessageLinks,
      onSelectFileLink: options.onSelectFileLink,
      links: options.initialNodes ? [] : SITUATION_LINKS_F00042,
      selectedNodeId: 'CMD-01',
      onSelectNode: options.onSelectNode ?? vi.fn(),
      onSelectLink: options.onSelectLink ?? vi.fn(),
      onZoomChange: options.onZoomChange ?? vi.fn(),
    })
    activeControllers.add(controller)
    if (options.showPotentialLayer) controller.setLayerVisible('potential', true)
    return controller
  }


  it('文件范围按干扰事件启停并随回放移动，回退和重载清除未来范围，不推断通信关联通断', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const circles = vi.spyOn(L, 'circle')
    const nodes: SituationMapNode[] = [
      { ...INITIAL_NODES.nodes[0]!, platformId: 'jammer_station_01', name: '地面干扰站01' },
      { ...INITIAL_NODES.nodes[1]!, platformId: 'jammer_airborne_01', name: '机载干扰平台01' },
      { ...INITIAL_NODES.nodes[1]!, platformId: 'UNKNOWN', name: '地面干扰站01' },
    ]
    const controller = await createController({ initialNodes: nodes })
    const interferenceGroup = groups.mock.results[4]!.value as L.LayerGroup
    expect(circles).not.toHaveBeenCalled()
    const events: FileDeviceEvent[] = nodes.slice(0, 2).map((node, index) => ({
      platformId: node.platformId, deviceId: `jammer-${index}`, kind: 'JAMMING', active: true,
      sourceEventId: `LOG-L${index + 1}`, time: index === 0 ? 1666.44 : 0, frequencyHz: 2.4e9, bandwidthHz: 2e7,
    }))
    controller.setFileDeviceStates(selectFileDeviceStates(events, 0))
    expect(interferenceGroup.getLayers()).toHaveLength(1)
    expect(circles.mock.results[0]!.value.getLatLng()).toEqual(L.latLng(nodes[1]!.latitude, nodes[1]!.longitude))
    controller.setFileDeviceStates(selectFileDeviceStates(events, 1666.439))
    expect(interferenceGroup.getLayers()).toHaveLength(1)
    controller.setFileDeviceStates(selectFileDeviceStates(events, 1666.44))
    expect(circles).toHaveBeenCalledTimes(2)
    const ranges = circles.mock.results.map(result => result.value as L.Circle)
    ranges.forEach((circle, index) => {
      expect(circle.getRadius()).toBe(44448)
      expect(circle.getLatLng()).toEqual(L.latLng(nodes[1 - index]!.latitude, nodes[1 - index]!.longitude))
      expect(circle.getTooltip()).toBeUndefined()
    })
    const off = buildFileDeviceEvents(parseAfsimEventLog([
      '! WEAPON_TURNED_OFF,time<time>,event<string>,platform<string>,side<string>,type<string>,system_platform<string>,system_type<string>',
      '2806.178,WEAPON_TURNED_OFF,jammer_station_01,red,Weapon,jammer-0,WSF_RF_JAMMER',
    ].join('\n')).events, new Set(nodes.map(node => node.platformId)))
    controller.setFileDeviceStates(selectFileDeviceStates([...events, ...off], 2806.178))
    expect(interferenceGroup.getLayers()).toEqual([ranges[0]])
    controller.setFileDeviceStates(selectFileDeviceStates([...events, ...off], 2806.177))
    expect(interferenceGroup.getLayers()).toHaveLength(2)
    expect(interferenceGroup.getLayers()).toContain(ranges[0])
    circles.mockClear()
    controller.setNodes(nodes.map(node => ({ ...node, latitude: node.latitude + 0.1 })))
    expect(circles).not.toHaveBeenCalled()
    expect(ranges[0]!.getLatLng().lat).toBe(nodes[1]!.latitude + 0.1)
    controller.setFileDeviceStates(selectFileDeviceStates(events, 0))
    expect(interferenceGroup.getLayers()).toEqual([ranges[0]])
    controller.setFileDeviceStates(selectFileDeviceStates([...events, { ...events[1]!, sourceEventId: 'LOG-L3', time: 1700, active: false }], 1700))
    expect(interferenceGroup.getLayers()).toHaveLength(1)
    expect(interferenceGroup.getLayers()).not.toContain(ranges[0])
    controller.setFileDeviceStates([])
    expect(interferenceGroup.getLayers()).toHaveLength(0)
    controller.setFileDeviceStates(selectFileDeviceStates(events, 1666.44))
    controller.setNodes([])
    expect(interferenceGroup.getLayers()).toHaveLength(0)
    controller.destroy()
  })

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

  afterEach(async () => {
    activeControllers.forEach((controller) => controller.destroy())
    activeControllers.clear()
    container?.remove()
    container = null
    vectorGridLayer = null
    ;(MAP_CONFIG as any).useSatelliteDataPosition = false
    const { MAP_CONFIG: activeConfig } = await import('../../src/config/map.config')
    ;(activeConfig as any).useSatelliteDataPosition = false
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('卫星识别以明确类型为准，仅缺少类型时兼容已知 ID', () => {
    for (const type of ['COMMUNICATION_SATELLITE', 'TIAN_TONG_SAT', 'SHEN_TONG_SAT']) {
      expect(isSatellitePlatform({ type, id: 'OTHER', name: '普通名称' })).toBe(true)
    }
    for (const id of ['tiantong_sat', 'shentong_sat']) {
      expect(isSatellitePlatform({ id })).toBe(true)
      expect(isSatellitePlatform({ platformId: id })).toBe(true)
      expect(isSatellitePlatform({ type: 'REAR_COMMAND_NODE', id })).toBe(false)
      expect(isSatellitePlatform({ type: 'UNKNOWN', id })).toBe(false)
    }
    expect(isSatellitePlatform({ name: '卫星地面站' })).toBe(false)
    expect(isSatellitePlatform({ id: 'SATCOM-01' })).toBe(false)
    expect(isSatellitePlatform(null)).toBe(false)
  })

  it('地面节点名称含卫星或使用卫星 ID 时仍保持原坐标与普通图标', async () => {
    const nodes = ['SATCOM-01', 'tiantong_sat'].map(platformId => ({
      ...INITIAL_NODES.nodes[1]!, platformId, name: '卫星地面站', type: 'REAR_COMMAND_NODE',
    }))
    const original = JSON.stringify(nodes)
    const markers = vi.spyOn(L, 'marker')
    await createController({ initialNodes: nodes })
    expect(markers.mock.calls.filter(([, options]) => options?.title?.startsWith('选择节点')).map(([point]) => point))
      .toEqual(nodes.map(node => [node.latitude, node.longitude]))
    expect([...container!.querySelectorAll('.situation-map-node__glyph')].map(glyph => glyph.textContent)).toEqual(['●', '●'])
    expect(container!.textContent).not.toContain('轨道示意')
    expect(JSON.stringify(nodes)).toBe(original)
  })

  it('临时模式下单卫星居中，多卫星等距环绕且不受输入顺序影响，真实模式保留原值', async () => {
    const satellites = ['D', 'B', 'A', 'C'].map(platformId => ({
      ...SATELLITE_FILE_NODES[0]!, platformId,
    }))
    const ground = SATELLITE_FILE_NODES[1]!
    const original = JSON.stringify(satellites)
    const center = MAP_CONFIG.temporarySatellitePosition
    expect(center).toEqual({ longitude: 120.827670, latitude: 26.018571 })
    expect(resolvePlatformCoordinates(satellites[0]!, [satellites[0]!, ground])).toEqual(center)
    expect(resolvePlatformCoordinates(ground, satellites)).toEqual({ longitude: ground.longitude, latitude: ground.latitude })
    for (const count of [2, 3, 4]) {
      const nodes = satellites.slice(0, count)
      const points = nodes.map(node => resolvePlatformCoordinates(node, nodes))
      expect(new Set(points.map(point => JSON.stringify(point))).size).toBe(count)
      expect(points.reduce((sum, point) => sum + point.longitude, 0) / count).toBeCloseTo(center.longitude, 10)
      expect(points.reduce((sum, point) => sum + point.latitude, 0) / count).toBeCloseTo(center.latitude, 10)
      points.forEach((point, index) => {
        const x = (point.longitude - center.longitude) * Math.cos(center.latitude * Math.PI / 180)
        const y = point.latitude - center.latitude
        expect(Math.hypot(x, y)).toBeCloseTo(0.05, 10)
        expect(resolvePlatformCoordinates(nodes[index]!, [...nodes].reverse())).toEqual(point)
      })
    }
    ;(MAP_CONFIG as any).useSatelliteDataPosition = true
    satellites.forEach(node => expect(resolvePlatformCoordinates(node, satellites)).toEqual({ longitude: node.longitude, latitude: node.latitude }))
    expect(JSON.stringify(satellites)).toBe(original)
  })

  it('多卫星的节点、配置连线和定位使用同一示意坐标，减为单卫星后回到中心', async () => {
    const markers = vi.spyOn(L, 'marker')
    const lines = vi.spyOn(L, 'polyline')
    const setView = vi.spyOn(L.Map.prototype, 'setView')
    const select = vi.fn()
    const nodes = [...structuredClone(SATELLITE_FILE_NODES), { ...SATELLITE_FILE_NODES[0]!, platformId: 'C', name: '天通卫星' }]
    const original = JSON.stringify(nodes)
    const links = ['A', 'C'].map(id => ({ ...fixtureSource.scenario.links[0]!, id: `link-${id}`, sourcePlatformId: id, targetPlatformId: 'B' })) as Link[]
    const controller = await createController({ initialNodes: nodes, configuredLinks: links, onSelectNode: select })
    const nodeMarkers = markers.mock.results.map(result => result.value as L.Marker).filter(marker => marker.options.title?.startsWith('选择节点'))
    const connectionLines = lines.mock.results.map(result => result.value as L.Polyline).filter(line => line.options.className === 'situation-map-configured-link')
    for (const [index, id] of ['A', 'C'].entries()) {
      const nodeIndex = nodes.findIndex(node => node.platformId === id)
      const point = resolvePlatformCoordinates(nodes[nodeIndex]!, nodes)
      const expected = L.latLng(point.latitude, point.longitude)
      expect(nodeMarkers[nodeIndex]!.getLatLng()).toEqual(expected)
      expect((connectionLines[index]!.getLatLngs() as L.LatLng[])[0]).toEqual(expected)
      nodeMarkers[nodeIndex]!.fire('click')
      expect(select).toHaveBeenLastCalledWith(id)
      controller.focusTarget({ kind: 'node', targetId: id })
      expect(setView).toHaveBeenLastCalledWith([point.latitude, point.longitude], MAP_CONFIG.defaults.zoom, expect.any(Object))
    }
    controller.setNodes([...nodes].reverse())
    expect(nodeMarkers[0]!.getLatLng()).not.toEqual(nodeMarkers[2]!.getLatLng())
    controller.setNodes(nodes.slice(0, 2))
    expect(nodeMarkers[0]!.getLatLng()).toEqual(L.latLng(MAP_CONFIG.temporarySatellitePosition.latitude, MAP_CONFIG.temporarySatellitePosition.longitude))
    expect((connectionLines[0]!.getLatLngs() as L.LatLng[])[0]).toEqual(nodeMarkers[0]!.getLatLng())
    expect(JSON.stringify(nodes)).toBe(original)
  })

  it('所选场景配置链路可点击和定位，不生成状态、质量或干扰圈，切换配置清除旧线', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const polyline = vi.spyOn(L, 'polyline')
    const marker = vi.spyOn(L, 'marker')
    const circle = vi.spyOn(L, 'circle')
    const fit = vi.spyOn(L.Map.prototype, 'fitBounds')
    const nodes = fixtureSource.scenario.platforms.map(platform => ({ platformId: platform.id, name: platform.name,
      type: platform.type, ...platform.initialPosition, speed: 0 }))
    const links = structuredClone(fixtureSource.scenario.links) as Link[]
    links[0]!.enabled = false
    const selected = vi.fn()
    const controller = await createController({ initialNodes: nodes, configuredLinks: links, onSelectConfiguredLink: selected })
    const lines = () => polyline.mock.calls.filter(([, options]) => options?.className === 'situation-map-configured-link')
    expect(lines()).toHaveLength(links.length)
    expect(lines()[0]![1]).toMatchObject({ color: '#8496a3', opacity: 0.35 })
    expect(circle).not.toHaveBeenCalled()
    const hitIndex = marker.mock.calls.findIndex(([, options]) => options?.title?.includes(`${links[0]!.id} ·`))
    expect(marker.mock.calls[hitIndex]![1]?.title).toContain('配置停用；暂无运行数据')
    const hit = marker.mock.results[hitIndex]!.value as L.Marker
    hit.fire('click')
    expect(selected).toHaveBeenLastCalledWith(links[0])
    const fitCount = fit.mock.calls.length
    controller.focusTarget({ kind: 'link', targetId: links[0]!.id })
    expect(fit).toHaveBeenCalledTimes(fitCount + 1)
    controller.focusTarget({ kind: 'link', targetId: 'MISSING' })
    expect(fit).toHaveBeenCalledTimes(fitCount + 1)
    const linkGroup = groups.mock.results[1]!.value as L.LayerGroup
    expect(linkGroup.getLayers().length).toBeGreaterThan(0)
    controller.setConfiguredLinks([])
    expect(linkGroup.getLayers()).toHaveLength(0)
    const count = lines().length
    controller.setConfiguredLinks([{ ...links[0]!, sourcePlatformId: 'MISSING' }])
    expect(lines()).toHaveLength(count)
    controller.setConfiguredLinks(undefined)
    controller.destroy()
    controller.setConfiguredLinks(links)
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
    const markers = markerSpy.mock.results.map(result => result.value as L.Marker)
    controller.focusTarget({ kind: 'node', targetId: 'A' })
    setViewSpy.mockClear()
    markerSpy.mockClear()
    controller.setNodes(INITIAL_NODES.nodes.map((node) => node.platformId === 'A'
      ? { ...node, longitude: -78, latitude: 31 } : node))
    expect(setViewSpy).not.toHaveBeenCalled()
    expect(removeSpy).not.toHaveBeenCalled()
    expect(markerSpy).not.toHaveBeenCalled()
    expect(markers.filter(marker => marker.options.title?.startsWith('选择节点'))
      .map(marker => [marker.getLatLng().lat, marker.getLatLng().lng])).toEqual([[31, -78], [25.1026, 118.7321]])
    expect(container?.querySelectorAll('.situation-map-node-marker--selected')).toHaveLength(1)
    controller.focusTarget({ kind: 'node', targetId: 'A' })
    expect(setViewSpy).toHaveBeenLastCalledWith([31, -78], MAP_CONFIG.defaults.zoom, expect.objectContaining({ animate: true }))
  })

  it('文件关联连线取最新端点，支持点击与键盘查看，图层关闭后位置更新不会重新开启', async () => {
    const lineSpy = vi.spyOn(L, 'polyline')
    const markerSpy = vi.spyOn(L, 'marker')
    const onSelectFileLink = vi.fn()
    const links = selectFileCommunicationLinks(FILE_CONNECTIONS, 5)
    const controller = await createController({ initialNodes: SATELLITE_FILE_NODES, fileLinks: links, onSelectFileLink, showPotentialLayer: true })
    const calls = () => lineSpy.mock.calls.filter(([, options]) => options?.className === 'situation-map-file-link')
    expect(calls()).toHaveLength(2)
    const points = calls()[0]?.[0] as L.LatLngTuple[]
    expect([points[0], points.at(-1)]).toEqual([[26.018571, 120.827670], [25.1026, 118.7321]])
    expect(calls()[0]?.[0]).not.toEqual(calls()[1]?.[0])
    expect(calls().map(([, options]) => options?.color)).toEqual(['#67c23a', '#409eff'])
    // 登记关联统一降级为半透明点线，与业务链路的实线区分。
    expect(calls().map(([, options]) => options?.dashArray)).toEqual(['2 6', '2 6'])
    expect(calls().every(([, options]) => options?.opacity === 0.5 && options?.weight === 2)).toBe(true)
    const index = lineSpy.mock.calls.findIndex(([, options]) => options?.className === 'situation-map-file-link')
    const line = lineSpy.mock.results[index]?.value as L.Polyline
    expect((line.getTooltip()?.getContent() as HTMLElement).textContent).toContain('状态未知')
    line.fire('click')
    expect(onSelectFileLink).toHaveBeenLastCalledWith(links[0])
    const hit = container?.querySelector<HTMLElement>('.situation-map-file-link-hit')
    hit?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onSelectFileLink).toHaveBeenCalledTimes(2)
    controller.setLayerVisible('potential', false)
    lineSpy.mockClear()
    controller.setNodes(SATELLITE_FILE_NODES.map(node => node.platformId === 'B' ? { ...node, latitude: 26, longitude: 119 } : node))
    expect(lineSpy).not.toHaveBeenCalled()
    const updated = (line.getLatLngs() as L.LatLng[]).map(point => [point.lat, point.lng])
    expect([updated[0], updated.at(-1)]).toEqual([[26.018571, 120.827670], [26, 119]])
    expect(container?.querySelector('.situation-map-file-link-hit')).toBeNull()
    controller.setLayerVisible('potential', true)
    expect(container?.querySelectorAll('.situation-map-file-link-hit')).toHaveLength(2)
    controller.setNodes(INITIAL_NODES.nodes.slice(0, 1))
    expect(container?.querySelector('.situation-map-file-link-hit')).toBeNull()
    controller.setFileLinks([])
    controller.destroy()
    expect(container?.querySelector('.situation-map-file-link-hit')).toBeNull()
    expect(markerSpy).toHaveBeenCalled()
  })

  it('卫星只绘制已有的星地登记，端到端、星间、未知类型不画，其他类别与原始明细不变', async () => {
    const types = ['MISSION_UAV_PLATFORM', 'REAR_COMM_PLATFORM', 'SHEN_TONG_SAT', 'TIAN_TONG_SAT', 'UNKNOWN']
    const nodes = types.map((type, index) => ({ ...INITIAL_NODES.nodes[0]!, platformId: `N${index}`, name: `节点${index}`, type }))
    const records: FileCommunicationConnection[] = [[0, 1], [0, 2], [2, 1], [3, 0], [1, 3], [2, 3], [4, 2]].map(([source, target], index) => ({
      ...FILE_CONNECTIONS[0]!, sourceEventId: `REG-${index}`, sourceType: 'WSF_RADIO_TRANSCEIVER', targetType: 'WSF_RADIO_TRANSCEIVER',
      source: { platformName: `N${source}`, communicationName: 'sat_link', address: `0.1.0.${source}` },
      target: { platformName: `N${target}`, communicationName: 'sat_link', address: `0.1.0.${target}` },
    }))
    const links = selectFileCommunicationLinks(records, 0)
    const original = structuredClone(links)
    const otherLinks: FileCommunicationLink[] = ['MICROWAVE', 'DATALINK', 'FIBER'].map(type => ({
      ...links[0]!, id: type, type: type as FileCommunicationLink['type'],
    }))
    const onSelectFileLink = vi.fn()
    const controller = await createController({ initialNodes: nodes, fileLinks: [...links, ...otherLinks], onSelectFileLink, showPotentialLayer: true })
    const visible = () => container!.querySelectorAll<HTMLElement>('.situation-map-file-link-hit')
    expect(visible()).toHaveLength(7)
    for (const element of visible()) element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onSelectFileLink.mock.calls.map(([link]) => link.id)).toEqual([...links.slice(1, 5), ...otherLinks].map(link => link.id))
    expect(container?.textContent).toContain('不表示当前正在转发')
    controller.setFileLinks([links[0]!])
    expect(visible()).toHaveLength(0)
    // 即使已知卫星节点存在，也不能根据端到端关联自行补两跳。
    expect(links).toEqual(original)
    controller.setFileLinks([links[1]!])
    expect(visible()).toHaveLength(1)
    controller.setFileDeviceStates([{ sourceEventId: 'OFF', platformId: 'N2', deviceId: 'sat_link', kind: 'COMMUNICATION', time: 1, active: false }])
    expect(visible()).toHaveLength(0)
    controller.setFileDeviceStates([])
    expect(visible()).toHaveLength(1)
  })

  it('当前 CSV 的卫星和微波设备映射为连线，并按实际启停时刻隐藏及恢复', async () => {
    const nodes = ['rear_comm_vehicle', 'mission_uav_02', 'mission_uav_03', 'shentong_sat'].map((platformId, index) => ({
      ...INITIAL_NODES.nodes[0]!, platformId, name: platformId, latitude: 25 + index * 0.1,
      type: index === 0 ? 'REAR_COMM_PLATFORM' : index === 3 ? 'SHEN_TONG_SAT' : 'MISSION_UAV_PLATFORM',
    }))
    const records: FileCommunicationConnection[] = [
      ['mission_uav_03', 'microwave_link', 'rear_comm_vehicle', 'microwave_link'],
      ['mission_uav_02', 'sat_link', 'shentong_sat', 'sat_link'],
      ['mission_uav_02', 'c_band_downlink', 'mission_uav_03', 'c_band_downlink'],
    ].map(([source, sourceComm, target, targetComm], index) => ({
      sourceEventId: `REG-${index}`, time: 0, scope: 'INTER_PLATFORM',
      sourceType: 'WSF_RADIO_TRANSCEIVER', targetType: 'WSF_RADIO_TRANSCEIVER',
      source: { platformName: source!, communicationName: sourceComm!, address: `0.1.0.${index * 2 + 1}` },
      target: { platformName: target!, communicationName: targetComm!, address: `0.1.0.${index * 2 + 2}` },
    }))
    const events: FileDeviceEvent[] = [
      { sourceEventId: 'LOG-L806', platformId: 'mission_uav_03', deviceId: 'microwave_link', kind: 'COMMUNICATION', time: 2.436506, active: false },
      { sourceEventId: 'LOG-L5361', platformId: 'mission_uav_03', deviceId: 'microwave_link', kind: 'COMMUNICATION', time: 2300, active: true },
      { sourceEventId: 'LOG-L5362', platformId: 'mission_uav_03', deviceId: 'microwave_link', kind: 'COMMUNICATION', time: 2300.437, active: false },
      { sourceEventId: 'LOG-L5363', platformId: 'mission_uav_02', deviceId: 'sat_link', kind: 'COMMUNICATION', time: 2301.17, active: false },
    ]
    const links = selectFileCommunicationLinks(records, 0)
    expect(links.map(link => link.type)).toEqual(['MICROWAVE', 'SAT', 'DATALINK'])
    const onSelectFileLink = vi.fn()
    const controller = await createController({ initialNodes: nodes, fileLinks: links, onSelectFileLink, showPotentialLayer: true })
    const visible = () => container!.querySelectorAll<HTMLElement>('.situation-map-file-link-hit')
    for (const [time, count] of [[0, 3], [2.436506, 2], [2300, 3], [2300.437, 2], [2301.17, 1]]) {
      controller.setFileDeviceStates(selectFileDeviceStates(events, time!))
      expect(visible()).toHaveLength(count!)
    }
    visible()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onSelectFileLink).toHaveBeenLastCalledWith(links[2])
    controller.setFileDeviceStates(selectFileDeviceStates(events, 0))
    expect(visible()).toHaveLength(3)
    expect(links.flatMap(link => link.records)).toEqual(records)
  })

  it('设备关闭仅隐藏全部关联不可用的合并连线，开启、倒退及重载恢复且不删除登记明细', async () => {
    const alternate = structuredClone(FILE_CONNECTIONS[0]!)
    alternate.sourceEventId = 'LOG-ALTERNATE'
    alternate.source.communicationName = 'sat-a-2'
    alternate.target.communicationName = 'sat-b-2'
    const links = selectFileCommunicationLinks([...FILE_CONNECTIONS, alternate], 5)
    const original = structuredClone(links)
    const onSelectFileLink = vi.fn()
    const events: FileDeviceEvent[] = [
      { sourceEventId: 'OFF-A', platformId: 'A', deviceId: 'sat-a', kind: 'COMMUNICATION', time: 10, active: false },
      { sourceEventId: 'OFF-B2', platformId: 'B', deviceId: 'sat-b-2', kind: 'COMMUNICATION', time: 20, active: false },
      { sourceEventId: 'ON-A', platformId: 'A', deviceId: 'sat-a', kind: 'COMMUNICATION', time: 30, active: true },
      { sourceEventId: 'OFF-B', platformId: 'B', deviceId: 'sat-b', kind: 'COMMUNICATION', time: 40, active: false },
      // 同名但不同节点，以及干扰设备的事件，都不能关闭通信设备。
      { sourceEventId: 'OTHER', platformId: 'B', deviceId: 'c-a', kind: 'COMMUNICATION', time: 0, active: false },
      { sourceEventId: 'JAMMER', platformId: 'A', deviceId: 'c-a', kind: 'JAMMING', time: 0, active: false, frequencyHz: 1, bandwidthHz: 1 },
    ]
    const controller = await createController({ initialNodes: SATELLITE_FILE_NODES, fileLinks: links, onSelectFileLink, showPotentialLayer: true })
    const visible = () => container!.querySelectorAll<HTMLElement>('.situation-map-file-link-hit')
    const seek = (time: number) => controller.setFileDeviceStates(selectFileDeviceStates(events, time))
    expect(visible()).toHaveLength(2)
    seek(10)
    expect(visible()).toHaveLength(2)
    seek(20)
    expect(visible()).toHaveLength(1)
    visible()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onSelectFileLink).toHaveBeenLastCalledWith(links.find(link => link.type === 'MICROWAVE'))
    seek(30)
    expect(visible()).toHaveLength(2)
    visible()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onSelectFileLink).toHaveBeenLastCalledWith(links.find(link => link.type === 'SAT'))
    expect(links.find(link => link.type === 'SAT')?.records).toHaveLength(2)
    seek(40)
    expect(visible()).toHaveLength(1)
    seek(10)
    expect(visible()).toHaveLength(2)
    seek(20)
    controller.setLayerVisible('potential', false)
    seek(30)
    expect(visible()).toHaveLength(0)
    controller.setLayerVisible('potential', true)
    expect(visible()).toHaveLength(2)
    seek(40)
    controller.setFileDeviceStates([])
    expect(visible()).toHaveLength(2)
    expect(links).toEqual(original)
  })

  it('文件连线按节点对区分类别：单类直线，多类小幅分离，重排反向与无关节点不影响几何', async () => {
    const lineSpy = vi.spyOn(L, 'polyline')
    const nodes = SATELLITE_FILE_NODES.map((node, index) => ({ ...node, latitude: 25 + index * 0.01, longitude: 119 + index * 0.01 }))
    nodes.push({ ...nodes[1]!, platformId: 'C', longitude: 119.02 })
    const links = selectFileCommunicationLinks(FILE_CONNECTIONS, 5)
    const other = { ...links[0]!, id: 'other', targetPlatformId: 'C' }
    const controller = await createController({ initialNodes: nodes, fileLinks: [links[0]!, other], useSatelliteDataPosition: true })
    const lines = lineSpy.mock.results.map(result => result.value as L.Polyline)
      .filter(line => line.options.className === 'situation-map-file-link')
    const points = (line: L.Polyline) => (line.getLatLngs() as L.LatLng[]).map(point => [point.lat, point.lng])
    const straight = points(lines[0]!)
    straight.forEach(([lat, lon], index) => {
      expect(lat).toBeCloseTo(25 + 0.01 * index / 32)
      expect(lon).toBeCloseTo(119 + 0.01 * index / 32)
    })
    controller.setFileLinks([...links, other])
    const curved = points(lines[0]!)
    const delta = Math.hypot(curved[16]![0]! - 25.005, curved[16]![1]! - 119.005)
    expect(delta).toBeGreaterThan(0)
    expect(delta).toBeCloseTo(Math.hypot(0.01, 0.01) * 0.04)
    expect(curved[0]).toEqual(straight[0])
    expect(curved.at(-1)).toEqual(straight.at(-1))
    controller.setFileLinks([other, links[1]!, links[0]!])
    expect(points(lines[0]!)).toEqual(curved)
    controller.setFileLinks(links.map(link => ({ ...link, sourcePlatformId: link.targetPlatformId, targetPlatformId: link.sourcePlatformId })))
    points(lines[0]!).reverse().forEach((point, index) => {
      expect(point[0]).toBeCloseTo(curved[index]![0]!)
      expect(point[1]).toBeCloseTo(curved[index]![1]!)
    })
    controller.setFileLinks([links[0]!, { ...links[0]!, id: 'same-type' }])
    expect(points(lines[0]!)).toEqual(straight)
    controller.setFileLinks([links[0]!])
    expect(points(lines[0]!)).toEqual(straight)
    controller.destroy()
  })

  it('C/L 波段复用数传线型，光纤使用独立颜色，两者均只展示登记关联', async () => {
    const lineSpy = vi.spyOn(L, 'polyline')
    const records = [
      ['c_band_uplink', 'l_band_downlink', 'WSF_RADIO_TRANSCEIVER'],
      ['fiber_link', 'fiber_link', 'WSF_COMM_TRANSCEIVER'],
    ].map(([sourceName, targetName, type], index) => ({
      ...FILE_CONNECTIONS[0]!, sourceEventId: `LOG-L${30 + index}`, sourceType: type!, targetType: type!,
      source: { ...FILE_CONNECTIONS[0]!.source, communicationName: sourceName! },
      target: { ...FILE_CONNECTIONS[0]!.target, communicationName: targetName! },
    }))
    const links = selectFileCommunicationLinks(records, 0)
    expect(links.map(link => link.type)).toEqual(['DATALINK', 'FIBER'])
    await createController({ initialNodes: INITIAL_NODES.nodes, fileLinks: links, showPotentialLayer: true })
    const drawings = lineSpy.mock.calls.filter(([, options]) => options?.className === 'situation-map-file-link')
    expect(drawings.map(([, options]) => [options?.color, options?.dashArray])).toEqual([
      ['#e6a23c', '2 6'], ['#20b2aa', '2 6'],
    ])
    expect(container?.textContent).toContain('新一代数传链路登记关联')
    expect(container?.textContent).toContain('光纤链路登记关联')
    expect(container?.textContent).toContain('状态未知')
  })

  it.each(['场景', '遥测'])('同一地图切到%s清除文件专属图层，返回文件后可重新绘制', async source => {
    const groups = vi.spyOn(L, 'layerGroup')
    const mapSpy = vi.spyOn(L, 'map')
    const controller = await createController({ initialNodes: SATELLITE_FILE_NODES,
      fileLinks: selectFileCommunicationLinks(FILE_CONNECTIONS, 5), fileMessageLinks: [MESSAGE_LINK] })
    const flow = groups.mock.results[2]!.value as L.LayerGroup
    const potential = groups.mock.results[3]!.value as L.LayerGroup
    expect(flow.getLayers().length).toBeGreaterThan(0)
    expect(potential.getLayers().length).toBeGreaterThan(0)
    if (source === '场景') controller.setConfiguredLinks([])
    else controller.setFrame(structuredClone(SITUATION_FRAME_F00042))
    expect(flow.getLayers()).toHaveLength(0)
    expect(potential.getLayers()).toHaveLength(0)
    if (source === '场景') controller.setConfiguredLinks(undefined)
    else controller.setFrame(null)
    expect(flow.getLayers().length).toBeGreaterThan(0)
    expect(potential.getLayers().length).toBeGreaterThan(0)
    expect(mapSpy).toHaveBeenCalledOnce()
  })

  it('业务链路与登记关联分层渲染：业务链路实线带方向箭头，登记关联默认开启且为点线', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const mapSpy = vi.spyOn(L, 'map')
    const fileLinks = selectFileCommunicationLinks(FILE_CONNECTIONS, 5)
    await createController({ initialNodes: SATELLITE_FILE_NODES, fileLinks, fileMessageLinks: [MESSAGE_LINK] })
    const map = mapSpy.mock.results[0]?.value as L.Map
    const businessGroup = groups.mock.results[1]!.value as L.LayerGroup
    const potentialGroup = groups.mock.results[3]!.value as L.LayerGroup
    // 业务链路：连线、命中点、方向箭头与业务方向标记；登记关联：两条连线和两个命中点，两者都在地图上。
    expect(businessGroup.getLayers()).toHaveLength(4)
    expect(potentialGroup.getLayers()).toHaveLength(4)
    expect(map.hasLayer(potentialGroup)).toBe(true)
    expect(container?.querySelectorAll('.situation-map-link-arrow')).toHaveLength(1)
    expect(container?.querySelectorAll('.situation-map-file-link-hit')).toHaveLength(2)
    const sourcePoint = L.latLng(SATELLITE_FILE_NODES[0]!.latitude, SATELLITE_FILE_NODES[0]!.longitude)
    const targetPoint = L.latLng(SATELLITE_FILE_NODES[1]!.latitude, SATELLITE_FILE_NODES[1]!.longitude)
    const glyph = container!.querySelector<HTMLElement>('.situation-map-link-arrow__glyph')!
    expect(glyph.textContent).toBe('▲')
    expect(glyph.style.transform).toMatch(/^rotate\(/)
    // 方向箭头落在靠近目标端的位置，而不是曲线中点之前。
    const arrow = (businessGroup.getLayers() as L.Marker[]).find(layer => layer.options.icon instanceof L.DivIcon
      && (layer.options.icon.options.html as HTMLElement)?.className === 'situation-map-link-arrow__glyph')!
    expect(arrow.getLatLng().distanceTo(targetPoint)).toBeLessThan(arrow.getLatLng().distanceTo(sourcePoint))
    // 业务方向用中文单字单独标注。
    const markText = container!.querySelector<HTMLElement>('.situation-map-link-direction__text')!
    expect(markText.textContent).toBe('前')
    const directionMark = (businessGroup.getLayers() as L.Marker[]).find(layer => layer.options.icon instanceof L.DivIcon
      && (layer.options.icon.options.html as HTMLElement)?.className === 'situation-map-link-direction__text')!
    // 业务链路用实线，登记关联用半透明点线。
    const businessLine = (businessGroup.getLayers() as L.Polyline[]).find(layer => layer instanceof L.Polyline)!
    // 标记落在曲线几何中点（第 16 个采样点），与偏后的箭头错开。
    expect(directionMark.getLatLng().equals((businessLine.getLatLngs() as L.LatLng[])[16]!)).toBe(true)
    expect(businessLine.options).toMatchObject({ color: '#67c23a', weight: 3, opacity: 0.95 })
    expect(businessLine.options.dashArray).toBeUndefined()
  })

  it('方向箭头朝向链路方向：图标默认朝正北，按顺时针旋转到目标方向', async () => {
    const rotationOf = (element: Element | null): number => {
      const matched = /rotate\((-?[\d.]+)deg\)/.exec((element as HTMLElement | null)?.style.transform ?? '')
      return matched ? Number(matched[1]) : NaN
    }
    const origin = { ...INITIAL_NODES.nodes[0]!, platformId: 'O', name: 'O', latitude: 25, longitude: 119 }
    for (const [name, latitude, longitude, expected] of [
      ['正东', 25, 119.02, 90],
      ['正北', 25.02, 119, 0],
      ['正西', 25, 118.98, -90],
      ['正南', 24.98, 119, 180],
    ] as const) {
      const target = { ...origin, platformId: 'T', name: 'T', latitude, longitude }
      await createController({
        initialNodes: [origin, target],
        fileMessageLinks: [{ ...MESSAGE_LINK, sourcePlatformId: 'O', targetPlatformId: 'T' }],
      })
      const glyph = container!.querySelector('.situation-map-link-arrow__glyph')
      expect(glyph, `${name} 未生成方向箭头`).not.toBeNull()
      expect(rotationOf(glyph), `${name} 箭头朝向错误`).toBeCloseTo(expected, 4)
      container?.remove()
    }
  })

  it('同节点对的两个投递方向各占一条车道，单方向时仍是直线', async () => {
    const nodes = SATELLITE_FILE_NODES
    const forward = { ...MESSAGE_LINK, sourcePlatformId: nodes[0]!.platformId, targetPlatformId: nodes[1]!.platformId }
    const backward = { ...MESSAGE_LINK, id: 'reverse', sourcePlatformId: nodes[1]!.platformId, targetPlatformId: nodes[0]!.platformId }
    const groups = vi.spyOn(L, 'layerGroup')
    const controller = await createController({ initialNodes: nodes, fileMessageLinks: [forward] })
    const businessGroup = groups.mock.results[1]!.value as L.LayerGroup
    const curves = (): L.LatLng[][] => (businessGroup.getLayers() as L.Polyline[])
      .filter(layer => layer instanceof L.Polyline)
      .map(layer => layer.getLatLngs() as L.LatLng[])

    // 单方向：没有反向链路分道，控制点落在两端中点，曲线退化为直线。
    expect(curves()).toHaveLength(1)
    const straight = curves()[0]!
    expect(straight[16]!.lat).toBeCloseTo((straight[0]!.lat + straight.at(-1)!.lat) / 2, 9)
    expect(straight[16]!.lng).toBeCloseTo((straight[0]!.lng + straight.at(-1)!.lng) / 2, 9)

    // 同一节点对出现反向链路后，两条线必须向相反一侧弯曲，不再互相压盖。
    controller.setFileMessageLinks([forward, backward])
    const both = curves()
    expect(both).toHaveLength(2)
    const offsets = both.map(points => points[16]!.lat - (points[0]!.lat + points.at(-1)!.lat) / 2)
    expect(Math.abs(offsets[0]!)).toBeGreaterThan(0)
    // 两个方向落在几何中点的两侧，符号相反且幅度相同。
    expect(Math.sign(offsets[0]!) * Math.sign(offsets[1]!)).toBe(-1)
    expect(offsets[0]).toBeCloseTo(-offsets[1]!, 9)

    // 回到单方向后再次退化为直线。
    controller.setFileMessageLinks([forward])
    expect(curves()).toHaveLength(1)
    expect(curves()[0]![16]!.lat).toBeCloseTo((curves()[0]![0]!.lat + curves()[0]!.at(-1)!.lat) / 2, 9)
    controller.destroy()
  })

  it('单颗流星沿主线移动，亮头暗尾首尾不重叠，几何更新与图层开关不残留', async () => {
    const lineSpy = vi.spyOn(L, 'polyline')
    const groups = vi.spyOn(L, 'layerGroup')
    const nodes = SATELLITE_FILE_NODES
    const link = { ...MESSAGE_LINK, sourcePlatformId: nodes[0]!.platformId, targetPlatformId: nodes[1]!.platformId }
    const controller = await createController({ initialNodes: nodes, fileMessageLinks: [link] })
    const flowGroup = groups.mock.results[2]!.value as L.LayerGroup
    const flowLines = () => lineSpy.mock.results.map(result => result.value as L.Polyline)
      .filter(line => line.options.className === 'situation-map-link-flow')
    expect(flowLines()).toHaveLength(4)
    expect(flowGroup.getLayers()).toHaveLength(4)
    const pathLength = 1000
    const trailLength = pathLength * MAP_CONFIG.linkFlowTrailRatio
    const travel = pathLength + trailLength
    const period = 2 * travel
    const length = trailLength / 4
    flowLines().forEach((line, index) => {
      expect(line.options).toMatchObject({ dashArray: `${length} ${period - length}`, interactive: false, lineCap: 'butt', pane: 'linkFlowPane', color: '#e8fcff' })
      const path = line.getElement() as SVGPathElement
      expect(path.getAttribute('pathLength')).toBe(`${pathLength}`)
      const start = Number(path.style.getPropertyValue('--situation-link-flow-start'))
      const end = Number(path.style.getPropertyValue('--situation-link-flow-shift'))
      expect(start).toBe(trailLength - index * length)
      expect(end - start).toBe(-travel)
      expect(path.style.animationDuration).toBe(`${MAP_CONFIG.linkFlowCycleSeconds}s`)
      if (index > 0) {
        expect(line.options.opacity!).toBeGreaterThan(flowLines()[index - 1]!.options.opacity!)
        expect(line.options.weight!).toBeGreaterThan(flowLines()[index - 1]!.options.weight!)
      }
    })
    // 一个循环的起止均完全在路径外，途中只允许一组连续尾迹，不出现第二颗流星。
    for (const progress of [0, 0.01, 0.1, 0.5, 0.9, 0.99, 1]) {
      const visible = flowLines().flatMap(line => {
        const path = line.getElement() as SVGPathElement
        const start = Number(path.style.getPropertyValue('--situation-link-flow-start'))
        const end = Number(path.style.getPropertyValue('--situation-link-flow-shift'))
        const offset = start + (end - start) * progress
        return [-1, 0, 1].map(repeat => [Math.max(0, repeat * period - offset), Math.min(pathLength, repeat * period - offset + length)])
          .filter(([from, to]) => to! > from!)
      }).sort((a, b) => a[0]! - b[0]!)
      if (progress === 0 || progress === 1) expect(visible).toHaveLength(0)
      else {
        expect(visible.length).toBeGreaterThan(0)
        expect(visible.length).toBeLessThanOrEqual(4)
        visible.slice(1).forEach((part, index) => expect(part[0]).toBeCloseTo(visible[index]![1]!, 8))
        expect(visible.at(-1)![1]! - visible[0]![0]!).toBeLessThanOrEqual(trailLength)
      }
    }
    const flowElement = flowLines()[0]!.getElement() as SVGPathElement
    expect(flowElement.style.getPropertyValue('--situation-link-flow-shift'))
      .toBe(`-${pathLength}`)
    // 动画名由组件 scoped 样式提供（jsdom 不加载 SFC 样式），此处只断言行内覆盖的时长与类名。
    expect(flowElement.style.animationDuration).toBe(`${MAP_CONFIG.linkFlowCycleSeconds}s`)
    expect(flowLines()[0]!.options.className).toBe('situation-map-link-flow')
    const pane = flowLines()[0]!.getPane()!
    expect(pane.style.zIndex).toBe('450')
    expect(pane.style.pointerEvents).toBe('none')
    // 叠加线与主连线几何完全一致。
    const mainLine = lineSpy.mock.results.map(result => result.value as L.Polyline)
      .find(line => line.options.opacity === 0.95 && line.options.className === undefined)!
    flowLines().forEach(line => expect(line.getLatLngs()).toEqual(mainLine.getLatLngs()))

    // 图层关闭只影响挂载，叠加线本身保留。
    controller.setLayerVisible('flow', false)
    expect(container?.querySelectorAll('.situation-map-link-flow')).toHaveLength(0)
    controller.setLayerVisible('flow', true)
    expect(container?.querySelectorAll('.situation-map-link-flow')).toHaveLength(4)
    controller.setLayerVisible('links', false)
    controller.setLayerVisible('links', true)
    expect(pane.querySelectorAll('.situation-map-link-flow')).toHaveLength(4)

    // 节点移动复用整束路径；反向投递从新发送端出发，换体制只更新样式。
    controller.setNodes(nodes.map(node => ({ ...node, latitude: node.latitude + 0.1 })))
    expect(flowLines()).toHaveLength(4)
    flowLines().forEach(line => expect(line.getLatLngs()).toEqual(mainLine.getLatLngs()))
    controller.setFileMessageLinks([{ ...link, sourcePlatformId: link.targetPlatformId, targetPlatformId: link.sourcePlatformId, type: 'MICROWAVE' }])
    expect(flowLines()).toHaveLength(4)
    flowLines().forEach(line => {
      expect(line.getLatLngs()).toEqual(mainLine.getLatLngs())
      expect(line.options.color).toBe('#e8fcff')
      expect((line.getLatLngs() as L.LatLng[])[0]!.lat).toBeCloseTo(nodes[1]!.latitude + 0.1)
    })
    expect(mainLine.options.color).toBe('#409eff')

    // 链路消失后叠加线一并移除，不留残留。
    controller.setFileMessageLinks([])
    expect(flowGroup.getLayers()).toHaveLength(0)
    expect(container?.querySelectorAll('.situation-map-link-flow')).toHaveLength(0)
    controller.destroy()
    expect(container?.querySelectorAll('.situation-map-link-flow')).toHaveLength(0)
  })

  it('地图按阵营区分节点配色：红方红色、蓝方青色，未标注或未知阵营回退默认色，提示里说明阵营', async () => {
    const nodes: SituationMapNode[] = [
      { ...INITIAL_NODES.nodes[0]!, platformId: 'B1', name: '蓝方一', side: 'blue' },
      { ...INITIAL_NODES.nodes[0]!, platformId: 'R1', name: '红方一', side: 'red' },
      { ...INITIAL_NODES.nodes[0]!, platformId: 'U1', name: '未标注' },
      { ...INITIAL_NODES.nodes[0]!, platformId: 'X1', name: '未知阵营', side: 'green' },
    ]
    const markerSpy = vi.spyOn(L, 'marker')
    await createController({ initialNodes: nodes })
    const markerNamed = (name: string): L.Marker => markerSpy.mock.results
      .map(result => result.value as L.Marker)
      .find(marker => marker.options.title?.startsWith('选择节点') && marker.options.title.includes(name))!
    // 强调色写在根节点上的行内样式，jsdom 下直接读它最稳。
    const colorOf = (name: string): string => {
      const iconContent = markerNamed(name).getElement()!.firstElementChild as HTMLElement
      return iconContent.style.color
    }
    expect(colorOf('红方一')).toBe('rgb(245, 108, 108)')
    expect(colorOf('蓝方一')).toBe('rgb(66, 216, 255)')
    // 没有阵营信息、或出现未识别的阵营时都不得臆造红蓝。
    expect(colorOf('未标注')).toBe('rgb(66, 216, 255)')
    expect(colorOf('未知阵营')).toBe('rgb(66, 216, 255)')
    // 悬停提示说明阵营，因此不需要额外图例。
    const tooltipOf = (name: string): string => (markerNamed(name).getTooltip()?.getContent() as HTMLElement).textContent ?? ''
    expect(tooltipOf('红方一')).toContain('红方')
    expect(tooltipOf('蓝方一')).toContain('蓝方')
    expect(tooltipOf('未标注')).not.toContain('方')
  })

  it('链路 props 筛选和重排后保持几何与交互绑定', async () => {
    const onSelectLink = vi.fn()
    const polylineSpy = vi.spyOn(L, 'polyline')
    const controller = await createController({ onSelectLink })
    const [firstLink, secondLink] = SITUATION_LINKS_F00042
    const filteredLinks = [secondLink, firstLink]

    const lines = polylineSpy.mock.results.map(({ value }) => value as L.Polyline).filter(line => line.options.interactive)
    const originalCurves = lines.slice(0, 2).map(line => line.getLatLngs())
    polylineSpy.mockClear()
    controller.setLinks([firstLink, secondLink])
    controller.setLinks(filteredLinks)
    expect(polylineSpy).not.toHaveBeenCalled()
    expect(lines.slice(0, 2).map(line => line.getLatLngs())).toEqual(originalCurves)
    expect(container?.querySelectorAll('.situation-map-link-keyboard-hit')).toHaveLength(2)

    lines[1]?.fire('click')
    lines[0]?.fire('click')
    expect(onSelectLink).toHaveBeenNthCalledWith(1, secondLink)
    expect(onSelectLink).toHaveBeenNthCalledWith(2, firstLink)

    controller.destroy()
  })

  it('同身份更新复用图层和键盘焦点，刷新最新状态与回调，切换数据源移除旧图层', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const markerSpy = vi.spyOn(L, 'marker')
    const lineSpy = vi.spyOn(L, 'polyline')
    const circleSpy = vi.spyOn(L, 'circle')
    const selected = vi.fn()
    const controller = await createController({ onSelectLink: selected })
    const linkGroup = groups.mock.results[1]!.value as L.LayerGroup
    const nodeGroup = groups.mock.results[0]!.value as L.LayerGroup
    const interferenceGroup = groups.mock.results[4]!.value as L.LayerGroup
    const original = linkGroup.getLayers()
    const line = original[0] as L.Polyline
    const hit = original[1] as L.Marker
    const element = hit.getElement()!
    const frame = structuredClone(SITUATION_FRAME_F00042)
    const links = SITUATION_LINKS_F00042.map(link => ({ ...link }))
    links[0]!.status = 'DOWN'
    element.focus()
    markerSpy.mockClear(); lineSpy.mockClear(); circleSpy.mockClear()
    controller.setFrame(frame)
    controller.setLinks(links)
    expect(linkGroup.getLayers()).toEqual(original)
    expect(hit.getElement()).toBe(element)
    expect(document.activeElement).toBe(element)
    expect(line.options.color).toBe('#f56c6c')
    expect(element.title).toContain('中断')
    element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(selected).toHaveBeenLastCalledWith(links[0])
    expect(selected.mock.calls.at(-1)?.[0]).toBe(links[0])
    expect(line.options.weight).toBe(6)
    controller.setSelectedNodeId('CMD-01')
    expect(line.options.className).toBe('')
    expect(line.getElement()?.classList.contains('situation-map-link--selected')).not.toBe(true)
    const node = (nodeGroup.getLayers() as L.Marker[]).find(marker => marker.options.title?.includes('通信卫星'))!
    const satellite = frame.platforms.find(platform => platform.platformId === 'SAT-01')!
    satellite.name = '重命名卫星'
    satellite.latitude += 0.1
    const circle = interferenceGroup.getLayers()[0] as L.Circle
    const station = frame.platforms.find(platform => platform.jammers.some(jammer => jammer.active))!
    station.latitude += 0.1
    controller.setFrame(frame)
    expect(node.getElement()?.title).toBe('选择节点 重命名卫星（轨道示意）')
    expect(node.getLatLng().lat).toBe(MAP_CONFIG.temporarySatellitePosition.latitude)
    const { MAP_CONFIG: activeMapConfig } = await import('../../src/config/map.config')
    ;(activeMapConfig as any).useSatelliteDataPosition = true
    try {
      controller.setFrame({ ...frame, frameId: 'F-MUTATED-DATA' })
      expect(node.getLatLng().lat).toBe(satellite.latitude)
    } finally {
      ;(activeMapConfig as any).useSatelliteDataPosition = false
      controller.setFrame(frame)
    }
    expect(circle.getLatLng().lat).toBe(station.latitude)
    expect(markerSpy).not.toHaveBeenCalled()
    expect(lineSpy).not.toHaveBeenCalled()
    expect(circleSpy).not.toHaveBeenCalled()
    satellite.name = '通信卫星'
    controller.setFrame(null)
    expect(linkGroup.getLayers()).toHaveLength(0)
    expect(interferenceGroup.getLayers()).toHaveLength(0)
    expect(nodeGroup.getLayers()).toHaveLength(0)
    controller.setFrame(frame)
    expect(linkGroup.getLayers()).toHaveLength(links.length * 2)
    expect(linkGroup.getLayers()[0]).not.toBe(line)
    controller.destroy()
    expect(linkGroup.getLayers()).toHaveLength(0)
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
    expect(currentLinkLines[0]?.line.options)
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
    const lines = polylineSpy.mock.results.map(result => result.value as L.Polyline)
    const circles = circleSpy.mock.results.map(result => result.value as L.Circle)

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
    expect(polylineSpy).not.toHaveBeenCalled()
    expect(lines.find(line => line.options.className === 'situation-map-link--selected')?.options)
      .toEqual(expect.objectContaining({ weight: 6, opacity: 1 }))
    expect(container?.querySelector('.situation-map-node-marker--selected')).toBeNull()

    circleSpy.mockClear()
    controller.focusTarget({ kind: 'interference', targetId: 'JAM-WB-01-TX' })
    const interferenceBounds = fitBoundsSpy.mock.calls[1]?.[0] as L.LatLngBounds
    expect(interferenceBounds.contains([25.25, 119.55])).toBe(true)
    expect(fitBoundsSpy.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      animate: true,
      duration: 0.45,
    }))
    expect(circleSpy).not.toHaveBeenCalled()
    const selectedInterferenceOptions = circles
      .map(circle => circle.options)
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
    expect(circleSpy).not.toHaveBeenCalled()
    expect(circles.some(circle => circle.options.className === 'situation-map-interference--selected')).toBe(false)

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
    const gridGroup = layerGroupSpy.mock.results[5]?.value as L.LayerGroup
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
    expect(offlineLabelLayerMock.create).toHaveBeenCalledWith('light', expect.objectContaining({ load: expect.any(Function), clear: expect.any(Function) }))
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
    const interferenceGroup = layerGroupSpy.mock.results[4]?.value as L.LayerGroup
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
    const controller = await createController({ useSatelliteDataPosition: true })
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
    expect(MAP_CONFIG.linkCurveSeparationRatio).toBe(0.16)
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
      const middle = [(source[0] + destination[0]) / 2, (source[1] + destination[1]) / 2]
      if (index > 1) {
        expect(curve[16]?.[0]).toBeCloseTo(middle[0]!)
        expect(curve[16]?.[1]).toBeCloseTo(middle[1]!)
      } else {
        const deviation = Math.hypot(curve[16]![0] - middle[0]!, curve[16]![1] - middle[1]!)
        expect(deviation).toBeGreaterThan(0)
        expect(deviation).toBeCloseTo(Math.hypot(destination[0] - source[0], destination[1] - source[1]) * 0.04)
      }
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

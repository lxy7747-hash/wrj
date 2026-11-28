import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElSelect } from 'element-plus'
import L from 'leaflet'
import { createPinia, setActivePinia } from 'pinia'
import { h, reactive, toRaw } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAP_CONFIG, isSatellitePlatform, nodeCategory, nodeGlyph, nodeIconUrl, resolvePlatformCoordinates } from '../../src/config/map.config'
import type { ConfirmationContext, Environment, Link, Principal, SimulationRun, ScenarioDraft } from '../../src/contracts/domain-models'
import type { PositionUpdate } from '../../src/features/situation/position-updates'
import type { SituationLinkView } from '../../src/features/situation/situation-model'
import type { SituationMapLink } from '../../src/components/situation/situation-map-controller'
import type { InitialNodeSnapshot, SituationMapNode } from '../../src/features/situation/initial-nodes'
import type { ConfiguredJammerRange } from '../../src/features/situation/interference-ranges'
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
import { useRuntimeQualityStore } from '../../src/stores/runtime-quality'
import { useSimulationStore } from '../../src/stores/simulation'
import { useReplayStore } from '../../src/stores/replay'
import { LOCAL_REPLAY } from '../fixtures/local-replay'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import engineSample from '../fixtures/engine-frame/params_check.json'
import jammerSample from '../fixtures/engine-frame/websocket-new/fream_chenge2.json'
import { LINK_CALC_DEFAULTS } from '../../src/features/scenarios/link-calc-defaults'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'
import { playbackFileSource, fileReceptionScenarioId } from '../../src/features/situation/file-reception'

type SituationMapControllerOptions = {
  frame: unknown
  initialNodes?: SituationMapNode[]
  fileLinks?: FileCommunicationLink[]
  fileMessageLinks?: FileMessageLink[]
  fileDeviceStates?: FileDeviceEvent[]
  configuredLinks?: SituationMapLink[]
  configuredLinkStatuses?: ReadonlyMap<string, 'UP' | 'DEGRADED' | 'DOWN'>
  configuredJammers?: ConfiguredJammerRange[]
  configuredEnvironment?: Environment
  onSelectConfiguredLink?: (link: Link, reverse?: Link) => void
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
    setViewportKey: vi.fn(),
    setFrame: vi.fn(),
    setEngineFrame: vi.fn(),
    setNodeTrails: vi.fn(),
    setNodes: vi.fn(),
    setLinks: vi.fn(),
    setFileLinks: vi.fn(),
    setFileMessageLinks: vi.fn(),
    setFilePlayback: vi.fn(),
    setFileDeviceStates: vi.fn(),
    setConfiguredLinks: vi.fn(),
    setFocusLinks: vi.fn(),
    setConfiguredLinkStatuses: vi.fn(),
    setConfiguredJammers: vi.fn(),
    setConfiguredEnvironment: vi.fn(),
    setLiveMessageFlows: vi.fn(),
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
      controller.setConfiguredLinkStatuses.mockImplementation(value => { mapControllerMock.latestOptions!.configuredLinkStatuses = value })
      controller.setConfiguredJammers.mockImplementation(value => { mapControllerMock.latestOptions!.configuredJammers = value })
      controller.setConfiguredEnvironment.mockImplementation(value => { mapControllerMock.latestOptions!.configuredEnvironment = value })
      controller.setLiveMessageFlows.mockImplementation((flows, opts) => {
        ;(mapControllerMock.latestOptions as any).liveMessageFlows = flows
        ;(mapControllerMock.latestOptions as any).liveFlowPlaying = opts?.playing
        ;(mapControllerMock.latestOptions as any).liveFlowKey = opts?.runKey
      })
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

const SCENE_ENVIRONMENT: Environment = {
  rainEnabled: true, rainRateMmPerHour: 10,
  cloudEnabled: true, cloudAltitudeMinM: 500, cloudAltitudeMaxM: 2000, cloudWaterDensityGM3: 0.5,
  multipathEnabled: true, seaState: 3,
  seaPolygon: [{ latitude: 1, longitude: 2 }, { latitude: 1, longitude: 3 }, { latitude: 2, longitude: 3 }],
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

  it('配置范围按每台干扰设备显示并刷新，切换空场景清除范围', async () => {
    const node = { ...INITIAL_NODES.nodes[0]!, platformId: 'JAM-NODE', name: '干扰站' }
    const jammers = [
      { id: 'JAM-ONE', platformId: node.platformId, jammingRange: 5000 },
      { id: 'JAM-TWO', platformId: node.platformId, jammingRange: 17000 },
    ]
    mountedWrapper = mount(OfflineSituationMap, {
      props: { frame: null, initialNodes: [node], configuredLinks: [], configuredJammers: jammers,
        links: [], selectedNodeId: node.platformId, focusTarget: null },
      global: { plugins: [ElementPlus] }, attachTo: document.body,
    })
    const button = mountedWrapper.findAll('[aria-label="态势图层"] button').find(b => b.text() === '干扰范围')!
    expect(button.attributes('disabled')).toBeUndefined()
    expect(button.attributes('aria-pressed')).toBe('true')
    mapControllerMock.latestOptions!.onSelectNode(node.platformId)
    await flushPromises()
    const ranges = () => [...document.querySelectorAll('[data-testid="configured-jammer-range"]')].map(el => el.textContent)
    expect(ranges()).toEqual([
      expect.stringContaining('干扰设备 1 干扰范围（半径）5 公里（配置范围，非实测覆盖）'),
      expect.stringContaining('干扰设备 2 干扰范围（半径）17 公里（配置范围，非实测覆盖）'),
    ])
    const updated = [{ ...jammers[0]!, jammingRange: 9000 }]
    await mountedWrapper.setProps({ configuredJammers: updated })
    expect(mapControllerMock.controller.setConfiguredJammers).toHaveBeenLastCalledWith(updated)
    expect(ranges()).toEqual([expect.stringContaining('9 公里（配置范围，非实测覆盖）')])
    await mountedWrapper.setProps({ sourceKey: 'empty', initialNodes: [], configuredJammers: [] })
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('aria-pressed')).toBe('false')
  })


  /**
   * 挂载态势主界面并登记为当前测试的待清理实例。
   * @returns 已挂载的态势页面包装器。
   * @sideeffect 向 document.body 添加页面及 Element Plus 的关联 DOM。
   */
  async function mountSituationPage(sceneId?: string, runtimeMode: 'MOCK' | 'LOCAL' | 'UNKNOWN' = 'MOCK', principal: Principal = OPERATOR) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({ principal, role: principal.role, permissions: [...principal.permissions], runtimeMode })
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
        stubs: { RouterLink: { template: '<a><slot /></a>' }, MissionResults: true },
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

  it('当前运行拒收详情默认展开，完整显示诊断文字且不混入其他运行或执行原值中的 HTML', async () => {
    const wrapper = await mountSituationPage()
    const simulation = useSimulationStore()
    simulation.run = simulationRun('STOPPED', false)
    await flushPromises()
    const telemetry = useTelemetryStore()
    const message = '已拒绝上游引擎数据（帧头无效）：frame_id：引擎帧号必须为非负整数。（原始值="<img src=x onerror=alert(1)>",数据类型=string）；link_calc.links：引擎链路段必须为数组。（原始值=undefined，数据类型=undefined（字段缺失））'
    const envelope = { type: 'event', schemaVersion: '1.0', topic: 'mission.log', taskId: 'TASK-001', sequence: 1,
      payload: { kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: 'RUN-001', state: 'REJECTED', message } }
    expect(telemetry.acceptEnvelope(envelope)).toBe(true)
    await flushPromises()
    const details = wrapper.get('[data-testid="engine-rejection-detail"]')
    expect(details.attributes('open')).toBeDefined()
    expect(details.get('pre').text()).toBe(message)
    expect(details.find('img').exists()).toBe(false)
    expect(telemetry.acceptEnvelope({ ...envelope, sequence: 2, payload: { ...envelope.payload, runId: 'RUN-OTHER' } })).toBe(false)
    expect(details.get('pre').text()).toBe(message)
    telemetry.disconnectAndReset()
    await flushPromises()
    expect(wrapper.find('[data-testid="engine-rejection-detail"]').exists()).toBe(false)
  })

  it('仿真运行中显示进度条，停止后隐藏', async () => {
    const wrapper = await mountSituationPage()
    const simulation = useSimulationStore()
    simulation.applyRun({
      ...simulationRun('RUNNING', true),
      canonical: { ...simulationRun('RUNNING', true).canonical, currentTime: 2880, totalDuration: 7200, progress: 40 },
    })
    await flushPromises()
    const bar = wrapper.get('[data-testid="simulation-progress"]')
    expect(bar.attributes('aria-valuenow')).toBe('40')
    expect(bar.text()).toContain('48分0秒')
    expect(bar.text()).toContain('120分0秒')
    simulation.applyRun(simulationRun('STOPPED', false))
    await flushPromises()
    expect(wrapper.find('[data-testid="simulation-progress"]').exists()).toBe(false)
  })

  it('没有 simulation.frame 也能通过 link.metric 在现有页签展示引擎证据与缺测值', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    const run = { ...simulationRun('COMPLETED', false), startedAt: '2026-11-07T01:00:00Z' }
    let finishLoad!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/simulations')) return successResponse([run])
      if (url.endsWith('/positions')) return successResponse({ runId: run.runId, scenarioId: run.scenarioId, revision: scene.revision, positions: null })
      if (url.endsWith('/scenarios/SCN-001')) return successResponse(scene)
      if (url.endsWith('/quality')) return new Promise<Response>(resolve => { finishLoad = resolve })
      throw new Error(`Unexpected request ${url}`)
    }))
    const wrapper = await mountSituationPage('SCN-001', 'LOCAL')
    const payload = { ...adaptEngineFrameSnapshot(engineSample).data!, runId: run.runId }
    payload.links[0]!.quality.gxbDb = null
    payload.links.push({ ...payload.links[0]!, linkId: 'segment-error', error: '计算输入缺失' })
    const telemetry = useTelemetryStore()
    expect(telemetry.frame).toBeNull()
    expect(wrapper.find('[data-testid="engine-map-source"]').exists()).toBe(false)
    expect(telemetry.acceptEnvelope({ type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: run.taskId, sequence: 1,
      frameId: `F-ENGINE-${payload.frameId}`, simulationTime: payload.simulationTime, payload })).toBe(true)
    await flushPromises()
    const mapStatus = wrapper.get('.offline-map__layer-status')
    expect(mapStatus.text()).toContain('离线矢量 · Z')
    expect(mapStatus.get('[data-testid="engine-map-source"]').text()).toBe('历史数据')
    expect(wrapper.get('[data-testid="engine-jammers"]').text()).toContain('探测概率 92%')
    expect(wrapper.get('[data-testid="engine-jammers"]').text()).toContain('经度 118.5°')
    expect(wrapper.get('[data-testid="engine-jammers"]').text()).toContain('宽带压制')
    expect(wrapper.get('[data-testid="engine-events"]').text()).toContain('进入探测圈')
    const tab = (label: string) => wrapper.get('.telemetry-panel').findAll('.el-tabs__item').find(t => t.text() === label)!
    await tab('质量指标').trigger('click'); await flushPromises()
    const panel = wrapper.get('[data-testid="engine-quality"]')
    expect(panel.get('.engine-evidence__source').text()).toContain('数据时刻：')
    expect(wrapper.findAll('[data-testid="quality-source"]')).toHaveLength(1)
    expect(panel.get('.engine-evidence__source').text()).not.toContain(`帧 ${payload.frameId}`)
    expect(panel.text()).toContain('正常'); expect(panel.text()).toContain('暂无数据')
    expect(panel.text()).toContain('异常（状态未知）')
    expect(panel.text()).toContain('异常'); expect(panel.get('[role="alert"]').text()).toBe('计算输入缺失')
    const losses = panel.get<HTMLDetailsElement>('.quality-card-details')
    expect(losses.get('summary').text()).toBe('分项损耗')
    expect(losses.element.open).toBe(false)
    await tab('选路判定').trigger('click'); await flushPromises()
    const decisions = wrapper.get('[data-testid="engine-decisions"]')
    for (const label of ['历史引擎数据（运行已结束）', '初始热链', '切换记录', '旧路径', '新路径', '链路劣化切换', '告警']) expect(decisions.text()).toContain(label)
    finishLoad(successResponse(null)); await flushPromises()
    expect(useRuntimeQualityStore().source).toBe('ENGINE_FRAME')
    expect(wrapper.get('[data-testid="quality-source"]').text()).toContain('已结束')
  })

  it('本次运行质量驱动连续帧状态、面板与详情，错误或离页同步清空判定', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    const run = { ...simulationRun('COMPLETED', false), startedAt: '2026-10-31T01:00:00Z' }
    run.canonical.currentTime = 65.5
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/simulations')) return successResponse([run])
      if (url.endsWith('/positions')) return successResponse({ runId: run.runId, scenarioId: run.scenarioId, revision: scene.revision, positions: null })
      if (url.endsWith('/scenarios/SCN-001')) return successResponse(scene)
      throw new Error(`Unexpected request ${url}`)
    }))
    const wrapper = await mountSituationPage('SCN-001', 'LOCAL')
    const quality = useRuntimeQualityStore()
    expect(quality.scope?.runId).toBe(run.runId)
    const stateRow = wrapper.get('tr[data-link-id="L-MW-01"]')
    expect(stateRow.get('td:last-child').text()).toBe('关闭')
    expect(mapControllerMock.latestOptions?.configuredLinks).toEqual([])
    expect(quality.bindLinks(quality.epoch, [{ linkId: 'L-MW-01', sourceLinkId: 'ENGINE-MW', sourcePlatformId: 'TX', destinationPlatformId: 'RX', sourcePortId: 'TX-PORT', destinationPortId: 'RX-PORT' }])).toBe(true)
    const epoch = quality.epoch
    const input = { links: [{ link_id: 'ENGINE-MW', tx_platform: 'TX', rx_platform: 'RX', tx_port: 'TX-PORT', rx_port: 'RX-PORT',
      losses: { total_composite_db: 107 }, quality: { ber: 1.2e-4, rx_power_dbw: -110, gxb_db: -7.5 } }] }
    expect(quality.acceptFrame(epoch, { frameId: 10, simulationTime: 65.5 }, input)).toBe(true)
    await flushPromises()
    await wrapper.get('.telemetry-panel').findAll('.el-tabs__item').find(tab => tab.text() === '质量指标')!.trigger('click')
    await flushPromises()
    const panel = wrapper.get('[data-testid="quality-metric-panel"]')
    const row = panel.findAll('.quality-card').find(row => row.text().includes('1.2e-4'))!
    expect(row).toBeDefined()
    expect(row.find('.quality-card-details').exists()).toBe(false)
    const metrics = Object.fromEntries(row.findAll('.quality-card-metrics > div').map(item => [item.get('dt').text(), item.get('dd').text()]))
    expect(['干信比(GXB)（dB）', '误码率(BER)', '发射辐射功率（dBW）', '距离（m）'].map(label => metrics[label])).toEqual(['-7.50', '1.2e-4', '暂无数据', '暂无数据'])
    await stateRow.trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="link-detail-runtime"]')).toBeNull()
    await stateRow.trigger('dblclick')
    await flushPromises()
    expect(document.querySelector('[data-testid="link-detail-runtime"]')?.textContent).toContain('1.2e-4')
    expect(document.querySelector('[data-testid="link-detail-runtime"]')?.textContent).toContain('发射辐射功率暂无数据')
    expect(document.querySelector('[data-testid="link-detail-runtime"]')?.textContent).toContain('107.00 dB')
    expect(stateRow.findAll('td').at(-1)!.text()).toBe('待判定')
    expect(wrapper.get('tr[data-link-id="L-DL-03"] td:last-child').text()).toBe('关闭')
    expect(mapControllerMock.latestOptions?.configuredLinkStatuses?.size).toBe(0)
    expect(quality.acceptFrame(epoch, { frameId: 11, simulationTime: 65.75 }, input)).toBe(true)
    expect(quality.acceptFrame(epoch, { frameId: 12, simulationTime: 66 }, input)).toBe(true)
    await flushPromises()
    expect(stateRow.findAll('td').at(-1)!.text()).toBe('中断')
    expect(mapControllerMock.latestOptions?.configuredLinkStatuses?.get('L-MW-01')).toBe('DOWN')
    expect(document.querySelector('[data-testid="link-detail-runtime"]')?.textContent).toContain('稳定帧数3')
    expect(mapControllerMock.latestOptions?.frame).toBeNull()
    expect(mapControllerMock.latestOptions?.configuredLinks?.map(link => link.id)).toEqual(['L-MW-01'])
    const bad = structuredClone(input)
    bad.links[0]!.quality.ber = 2
    expect(quality.acceptFrame(epoch, { frameId: 13, simulationTime: 66.25 }, bad)).toBe(false)
    await flushPromises()
    expect(wrapper.get('[data-testid="runtime-quality-error"]').text()).toContain('link_calc.links[0].quality.ber')
    expect(panel.text()).not.toContain('1.2e-4')
    expect(document.querySelector('[data-testid="link-detail-runtime"]')).toBeNull()
    expect(stateRow.get('td:last-child').text()).toBe('关闭')
    expect(mapControllerMock.latestOptions?.configuredLinkStatuses?.size).toBe(0)
    expect(mapControllerMock.latestOptions?.configuredLinks).toEqual([])
    expect(quality.acceptFrame(epoch, { frameId: 14, simulationTime: 67 }, input)).toBe(true)
    await flushPromises()
    wrapper.unmount()
    mountedWrapper = null
    expect(quality.scope).toBeNull()
    expect(quality.snapshot).toBeNull()
    expect(quality.acceptFrame(epoch, { frameId: 15, simulationTime: 68 }, input)).toBe(false)
  })

  it('地图显示启用且正常、劣化或中断的链路，缺测、停用、待判定及歧义段隐藏，列表保留全部数据', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    const base: Link = scene.config.links.find((link: Link) => link.type === 'MICROWAVE')!
    scene.config.linkSettings = { ...readLinkSettings(scene.config), linkCalc: { ...LINK_CALC_DEFAULTS, warningThreshold: 0.1, emergencyThreshold: 0.9 } }
    const links = Array.from({ length: 8 }, (_, index) => ({ ...base, id: `VISIBLE-${index}`, enabled: index !== 5 }))
    const run = { ...simulationRun('COMPLETED', false), startedAt: '2026-11-15T01:00:00Z' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/simulations')) return successResponse([run])
      if (url.endsWith('/positions')) return successResponse({ runId: run.runId, scenarioId: run.scenarioId, revision: scene.revision, positions: null })
      if (url.endsWith('/scenarios/SCN-001')) return successResponse(scene)
      if (url.endsWith('/quality')) return successResponse(null)
      throw new Error(`Unexpected request ${url}`)
    }))
    const wrapper = await mountSituationPage('SCN-001', 'LOCAL')
    useSimulationStore().selectedScene!.config.links = links
    const quality = useRuntimeQualityStore()
    const visibleIds = () => mapControllerMock.latestOptions?.configuredLinks?.map(link => link.id)
    const statusCells = () => wrapper.findAll('tr[data-link-id] td:last-child')
    await flushPromises()
    expect(statusCells().map(cell => cell.text())).toEqual(links.map(link => link.enabled ? '关闭' : '已停用'))
    expect(visibleIds()).toEqual([])
    const payload = { ...adaptEngineFrameSnapshot(engineSample).data!, runId: run.runId }
    const segment = payload.links[0]!
    payload.links = links.flatMap((link, index) => index === 4 ? [] : [{ ...segment,
      linkId: `SEGMENT-${index}`, linkIds: [link.id],
      status: (['UP', 'UP', 'UP', 'UNKNOWN', 'UP', 'DOWN', 'DOWN', 'UP'] as const)[index]!,
      quality: { ...segment.quality, ber: [0.099, 0.1, 0.9][index] ?? 0 },
      error: index === 6 ? '参数缺失' : null,
    }])
    payload.links.push({ ...payload.links.at(-1)!, linkId: 'AMBIGUOUS-SEGMENT' })
    expect(quality.acceptEngineFrame(quality.epoch, payload)).toBe(true)
    await flushPromises()
    expect(visibleIds()).toEqual(['VISIBLE-0', 'VISIBLE-1', 'VISIBLE-2'])
    expect(statusCells().map(cell => cell.text())).toEqual(['正常', '劣化', '中断', '待判定', '关闭', '已停用', '待判定', '待判定'])
    expect(statusCells()[4]!.get('.el-tag').classes()).toContain('el-tag--info')
    expect(wrapper.findAll('.link-table .el-tag--danger').map(tag => tag.text())).toEqual(['中断'])

    // 中断恢复后重新出现；选中或切换高亮不应让已停用的链路重新出现。
    useSimulationStore().selectedScene!.config.links[0]!.enabled = false
    payload.frameId += 1
    payload.links[2]!.quality.ber = 0.099
    expect(quality.acceptEngineFrame(quality.epoch, payload)).toBe(true)
    await wrapper.get('tr[data-link-id="VISIBLE-0"]').trigger('click')
    await flushPromises()
    expect(visibleIds()).toEqual(['VISIBLE-1', 'VISIBLE-2'])
    expect(statusCells()[2]!.text()).toBe('正常')
    payload.frameId += 1
    payload.links = []
    expect(quality.acceptEngineFrame(quality.epoch, payload)).toBe(true)
    await flushPromises()
    expect(visibleIds()).toEqual([])
    expect(statusCells().map(cell => cell.text())).toEqual(['已停用', '关闭', '关闭', '关闭', '关闭', '已停用', '关闭', '关闭'])
  })

  it('映射共享干线两跳中继、半中继忽略与中继绕过直连段（含前返向不对称共享干线）', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    const basePlatform = scene.config.platforms[0]!
    const extraPlatforms = ['CMD', 'RELAY', 'UAV-1', 'UAV-2', 'UAV-3'].map(id => ({ ...basePlatform, id, name: id }))
    const baseLink: Link = scene.config.links.find((link: Link) => link.type === 'MICROWAVE')!
    const links: Link[] = [
      { ...baseLink, id: 'L-FWD-1', sourcePlatformId: 'CMD', targetPlatformId: 'UAV-1', relayPlatformId: 'RELAY', enabled: true },
      { ...baseLink, id: 'L-FWD-2', sourcePlatformId: 'CMD', targetPlatformId: 'UAV-2', relayPlatformId: 'RELAY', enabled: true },
      { ...baseLink, id: 'L-FWD-INACTIVE', sourcePlatformId: 'CMD', targetPlatformId: 'UAV-3', relayPlatformId: 'RELAY', enabled: true },
      { ...baseLink, id: 'L-RET-1', sourcePlatformId: 'UAV-1', targetPlatformId: 'CMD', relayPlatformId: 'RELAY', enabled: true },
      { ...baseLink, id: 'L-RET-2', sourcePlatformId: 'UAV-2', targetPlatformId: 'CMD', relayPlatformId: 'RELAY', enabled: true },
    ]
    const run = { ...simulationRun('COMPLETED', false), startedAt: '2026-11-15T01:00:00Z' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/simulations')) return successResponse([run])
      if (url.endsWith('/positions')) return successResponse({ runId: run.runId, scenarioId: run.scenarioId, revision: scene.revision, positions: null })
      if (url.endsWith('/scenarios/SCN-001')) return successResponse(scene)
      if (url.endsWith('/quality')) return successResponse(null)
      throw new Error(`Unexpected request ${url}`)
    }))
    const wrapper = await mountSituationPage('SCN-001', 'LOCAL')
    useSimulationStore().selectedScene!.config.platforms = [...scene.config.platforms, ...extraPlatforms]
    useSimulationStore().selectedScene!.config.links = links
    const quality = useRuntimeQualityStore()
    const visibleLinks = () => mapControllerMock.latestOptions?.configuredLinks ?? []
    const payload = { ...adaptEngineFrameSnapshot(engineSample).data!, runId: run.runId }
    const template = payload.links[0]!
    const seg = (linkId: string, linkIds: string[], sourcePlatformId: string, targetPlatformId: string, status: 'UP' | 'DEGRADED' | 'DOWN') => ({
      ...template, linkId, linkIds, sourcePlatformId, targetPlatformId, status, error: null, distanceM: 1250,
    })

    // 帧 1：前/返向均通过 RELAY 两跳连通；共享干线 linkIds 包含未启用的 UAV-3，但因缺第二跳保持隐藏。
    payload.links = [
      seg('FWD-TRUNK', ['L-FWD-1', 'L-FWD-2', 'L-FWD-INACTIVE'], 'CMD', 'RELAY', 'UP'),
      seg('FWD-H2-1', ['L-FWD-1'], 'RELAY', 'UAV-1', 'UP'),
      seg('FWD-H2-2', ['L-FWD-2'], 'RELAY', 'UAV-2', 'DEGRADED'),
      seg('RET-H1-1', ['L-RET-1'], 'UAV-1', 'RELAY', 'UP'),
      seg('RET-H1-2', ['L-RET-2'], 'UAV-2', 'RELAY', 'UP'),
      seg('RET-TRUNK', ['L-RET-1', 'L-RET-2'], 'RELAY', 'CMD', 'UP'),
    ]
    payload.initRouting = [{
      pathId: 'ACTIVE-PATH', direction: 'FORWARD', sourceName: 'CMD', targetName: 'UAV-1',
      sourcePlatformId: 'CMD', targetPlatformId: 'UAV-1', transTypes: [],
      nodes: [
        { platformName: 'CMD', platformId: 'CMD', inPort: null, outPort: template.sourcePort },
        { platformName: 'RELAY', platformId: 'RELAY', inPort: template.targetPort, outPort: template.sourcePort },
        { platformName: 'UAV-1', platformId: 'UAV-1', inPort: template.targetPort, outPort: null },
      ],
    }]
    payload.pathQuality = [{ pathId: 'ACTIVE-PATH', delayMs: 5, rateBps: 2000, gxbDb: 3, ber: 0, marginDb: 4 }]
    expect(quality.acceptEngineFrame(quality.epoch, payload)).toBe(true)
    await flushPromises()
    expect(visibleLinks().map(item => [item.id, item.relayPlatformId])).toEqual([
      ['L-FWD-1', 'RELAY'], ['L-FWD-2', 'RELAY'], ['L-RET-1', 'RELAY'], ['L-RET-2', 'RELAY'],
    ])
    expect(visibleLinks()[0]?.distanceM).toBe(2500)
    expect(wrapper.get('tr[data-link-id="L-FWD-INACTIVE"] td:last-child').text()).toBe('待判定')
    expect(visibleLinks()[0]?.hover?.path).toMatchObject({
      platformIds: ['CMD', 'RELAY', 'UAV-1'], distanceM: 2500, quality: { pathId: 'ACTIVE-PATH', delayMs: 5 },
    })
    expect(visibleLinks()[1]?.hover?.path).toBeUndefined()
    expect(wrapper.get('tr[data-link-id="L-FWD-2"]').text()).toContain('劣化')

    // 帧 2：UAV-1 切换为绕过中继的直连微波；UAV-2 仍在走中继且前向第二跳 DOWN；共享干线仍为兄弟链路存在。
    payload.frameId += 1
    payload.links = [
      seg('FWD-TRUNK', ['L-FWD-1', 'L-FWD-2', 'L-FWD-INACTIVE'], 'CMD', 'RELAY', 'UP'),
      seg('FWD-H2-2', ['L-FWD-2'], 'RELAY', 'UAV-2', 'DOWN'),
      seg('FWD-BYPASS-1', ['L-FWD-1'], 'CMD', 'UAV-1', 'UP'),
      seg('RET-BYPASS-1', ['L-RET-1'], 'UAV-1', 'CMD', 'UP'),
      seg('RET-H1-2', ['L-RET-2'], 'UAV-2', 'RELAY', 'UP'),
      seg('RET-TRUNK', ['L-RET-1', 'L-RET-2'], 'RELAY', 'CMD', 'UP'),
    ]
    expect(quality.acceptEngineFrame(quality.epoch, payload)).toBe(true)
    await flushPromises()
    expect(visibleLinks().map(item => [item.id, item.relayPlatformId])).toEqual([
      ['L-FWD-1', null], ['L-FWD-2', 'RELAY'], ['L-RET-1', null], ['L-RET-2', 'RELAY'],
    ])
    expect(visibleLinks()[0]?.distanceM).toBe(1250)
    expect(wrapper.get('tr[data-link-id="L-FWD-2"]').text()).toContain('中断')
  })

  it('切换高亮只保留最近一次前后路径，无新切换时保留，下次切换及新运行清除旧高亮', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    const base: Link = scene.config.links.find((link: Link) => link.type === 'MICROWAVE')!
    const links = Array.from({ length: 3 }, (_, index) => ({ ...base, id: `SWITCH-${index}`, enabled: true }))
    const run = { ...simulationRun('COMPLETED', false), startedAt: '2026-11-15T01:00:00Z' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/simulations')) return successResponse([run])
      if (url.endsWith('/positions')) return successResponse({ runId: run.runId, scenarioId: run.scenarioId, revision: scene.revision, positions: null })
      if (url.endsWith('/scenarios/SCN-001')) return successResponse(scene)
      if (url.endsWith('/quality')) return successResponse(null)
      throw new Error(`Unexpected request ${url}`)
    }))
    const wrapper = await mountSituationPage('SCN-001', 'LOCAL')
    useSimulationStore().selectedScene!.config.links = links
    const quality = useRuntimeQualityStore()
    const highlights = () => Object.fromEntries(wrapper.findComponent({ name: 'OfflineSituationMap' }).props('configuredLinkSwitches'))
    const payload = { ...adaptEngineFrameSnapshot(engineSample).data!, runId: run.runId }
    const segment = payload.links[0]!
    payload.links = links.map((link, index) => ({ ...segment,
      linkId: `SEGMENT-${index}`, linkIds: [link.id], status: 'UP', error: null,
      sourcePlatformId: link.sourcePlatformId, targetPlatformId: link.targetPlatformId,
      sourcePort: `tx-${index}`, targetPort: `rx-${index}`,
    }))
    const nodes = (index: number) => {
      const link = payload.links[index]!
      return [
        { platformName: link.sourceName, platformId: link.sourcePlatformId, inPort: null, outPort: link.sourcePort },
        { platformName: link.targetName, platformId: link.targetPlatformId, inPort: link.targetPort, outPort: null },
      ]
    }
    const route = payload.routing.switches[0]!
    payload.routing.switches = [{ ...route, oldNodes: nodes(0), nodes: nodes(1) }]
    expect(quality.acceptEngineFrame(quality.epoch, payload)).toBe(true)
    await flushPromises()
    expect(highlights()).toEqual({ 'SWITCH-0': 'BEFORE', 'SWITCH-1': 'AFTER' })
    payload.frameId += 1
    payload.routing.switches = [{ ...route, oldNodes: nodes(1), nodes: nodes(2) }]
    expect(quality.acceptEngineFrame(quality.epoch, payload)).toBe(true)
    await flushPromises()
    expect(highlights()).toEqual({ 'SWITCH-1': 'BEFORE', 'SWITCH-2': 'AFTER' })
    expect(quality.engineSwitches).toHaveLength(2)
    expect(wrapper.get('tr[data-link-id="SWITCH-0"]').classes()).not.toContain('is-switch-before')
    expect(wrapper.get('tr[data-link-id="SWITCH-1"]').text()).toContain('最近一次切换：前路径')
    expect(wrapper.get('tr[data-link-id="SWITCH-1"] td:last-child').text()).toBe('正常')
    expect(wrapper.get('tr[data-link-id="SWITCH-2"] small').text()).toBe('最近一次切换：后路径')

    payload.frameId += 1
    payload.routing.switches = []
    payload.links[1]!.status = 'DOWN'
    expect(quality.acceptEngineFrame(quality.epoch, payload)).toBe(true)
    await flushPromises()
    expect(highlights()).toEqual({ 'SWITCH-1': 'BEFORE', 'SWITCH-2': 'AFTER' })
    expect(mapControllerMock.latestOptions?.configuredLinks?.map(link => link.id)).toEqual(['SWITCH-0', 'SWITCH-1', 'SWITCH-2'])
    expect(mapControllerMock.latestOptions?.configuredLinkStatuses?.get('SWITCH-1')).toBe('DOWN')
    expect(wrapper.get('tr[data-link-id="SWITCH-1"] td:last-child').text()).toBe('中断')
    expect(wrapper.get('tr[data-link-id="SWITCH-1"] small').text()).toBe('最近一次切换：前路径')

    payload.frameId += 1
    expect(quality.acceptEngineFrame(quality.epoch, { ...payload, links: [] })).toBe(true)
    await flushPromises()
    expect(wrapper.get('tr[data-link-id="SWITCH-1"] td:last-child').text()).toBe('关闭')
    expect(wrapper.get('tr[data-link-id="SWITCH-1"] small').text()).toBe('最近一次切换：前路径')

    // 最新切换无法解析时，也不能继续显示上一条切换的高亮。
    payload.frameId += 1
    payload.routing.switches = [{ ...route, oldNodes: [], nodes: [] }]
    expect(quality.acceptEngineFrame(quality.epoch, payload)).toBe(true)
    await flushPromises()
    expect(highlights()).toEqual({})
    expect(quality.engineSwitches).toHaveLength(3)
    payload.frameId += 1
    payload.routing.switches = [{ ...route, oldNodes: nodes(2), nodes: nodes(2) }]
    expect(quality.acceptEngineFrame(quality.epoch, payload)).toBe(true)
    await flushPromises()
    expect(highlights()).toEqual({ 'SWITCH-2': 'BOTH' })
    payload.engineEpoch += 1
    payload.frameId = 0
    payload.routing.switches = []
    expect(quality.acceptEngineFrame(quality.epoch, payload)).toBe(true)
    await flushPromises()
    expect(highlights()).toEqual({})
    expect(quality.engineSwitches).toEqual([])
  })

  it('质量页无手动导入入口，仍自动读取已有质量数据并下载规范文件', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    const run = { ...simulationRun('COMPLETED', false), startedAt: '2026-10-31T01:00:00Z' }
    const scope = { taskId: run.taskId, runId: run.runId, scenarioId: run.scenarioId, revision: scene.revision, startedAt: run.startedAt }
    const dataset = {
      schemaVersion: '1.0', scope,
      source: { kind: 'FILE_IMPORT', fileName: 'quality.json', sha256: 'a'.repeat(64), importedAt: '2026-10-31T01:02:00Z', frameIdKind: 'PROVIDED' },
      expectedStepS: 1,
      samples: [{ time: 5, frameId: 7, linkId: 'L-MW-01', sourcePlatform: 'UAV-01', destPlatform: 'CMD-01', linkType: 'MICROWAVE',
        frequency: 4500, bandwidth: 20, distance: 12_500, txPower: 100, txAntennaGain: 18, rxAntennaGain: 12,
        pathLoss: 100, jammingPower: -95, receivedPower: -70, snr: 11, modulation: 'QPSK', ber: 1e-6,
        linkStatus: 'UP', berThreshold: 1e-5, dataRate: 20, jsrDb: 8 }],
      switchEvents: [],
    }
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/simulations')) return successResponse([run])
      if (url.endsWith('/positions')) return successResponse({ runId: run.runId, scenarioId: run.scenarioId, revision: scene.revision, positions: null })
      if (url.endsWith('/scenarios/SCN-001')) return successResponse(scene)
      if (url.endsWith(`/simulations/${run.runId}/quality`)) return successResponse(dataset)
      if (url.includes(`/simulations/${run.runId}/quality/files/manifest.json?`)) return {
        ok: true, headers: new Headers({ 'Content-Disposition': 'attachment; filename="manifest.json"', 'X-Quality-Source-Sha256': 'a'.repeat(64) }),
        blob: vi.fn().mockResolvedValue(new Blob(['{}'], { type: 'application/json' })),
      } as unknown as Response
      throw new Error(`Unexpected request ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = await mountSituationPage('SCN-001', 'LOCAL')
    await wrapper.get('.telemetry-panel').findAll('.el-tabs__item').find(tab => tab.text() === '质量指标')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="quality-import-button"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="evidence-import-button"]').exists()).toBe(false)
    expect(wrapper.find('input[type="file"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('选择当前运行的规范质量')
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    expect(useRuntimeQualityStore().snapshot?.source).toBe('FILE_IMPORT')
    expect(wrapper.get('[data-testid="quality-source"]').text()).toContain('文件导入 · quality.json · 来源帧号')
    expect(useRuntimeQualityStore().snapshot?.data.links[0]).toMatchObject({ sourcePortId: null, destinationPortId: null, quality: { snrDb: 11, interferencePowerDbm: -95 } })
    const createObjectUrl = vi.fn().mockReturnValue('blob:test')
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    await wrapper.get('[data-testid="quality-download-button"]').trigger('click')
    const manifest = [...document.querySelectorAll<HTMLElement>('.el-dropdown-menu__item')].find(item => item.textContent?.includes('manifest.json'))!
    await manifest.click()
    await flushPromises()
    expect(fetcher.mock.calls.map(([url]) => String(url))).toContain(`http://127.0.0.1:4173/api/v1/simulations/${run.runId}/quality/files/manifest.json?sourceSha256=${'a'.repeat(64)}`)
  })

  it('本机态势页不再显示运行结果栏或请求运行结果目录', async () => {
    const fetchSpy = situationFetch()
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage(undefined, 'LOCAL')
    expect(wrapper.find('mission-results-stub').exists()).toBe(false)
    expect(wrapper.find('[aria-label="仿真运行结果"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('刷新结果')
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/mission-results'))).toBe(false)
  })

  it('本地模式未配置数据源且无运行时显示空态，不加载固定遥测帧', async () => {
    const fetchSpy = situationFetch()
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = await mountSituationPage(undefined, 'LOCAL')
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/frames/'))).toBe(false)
    expect(useTelemetryStore().frame).toBeNull()
    const empty = wrapper.get('.telemetry-empty')
    expect(empty.text()).toContain('暂无可用态势遥测')
    expect(empty.text()).toContain('未配置态势数据源')
    expect(empty.text()).not.toContain('F-00042')
    expect(empty.find('button').text()).toBe('重新加载')
    expect(wrapper.find('.situation-footer').exists()).toBe(false)
  })

  it('地图左上角按降雨强度更新图标，清除场景后移除天气标注', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    scene.config.scenario.environment = SCENE_ENVIRONMENT
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/simulations')) return successResponse([])
      if (url.endsWith(`/scenarios/${scene.config.scenario.id}`)) return successResponse(scene)
      throw new Error(`Unexpected request ${url}`)
    }))
    const wrapper = await mountSituationPage(scene.config.scenario.id)
    const environment = wrapper.get('[data-testid="scene-map-environment"]')
    const rainIcon = () => wrapper.get('.offline-map__topbar > [data-testid="scene-map-rain-indicator"]:first-child')
    expect(mapControllerMock.latestOptions?.configuredEnvironment).toMatchObject(SCENE_ENVIRONMENT)
    expect(rainIcon().attributes('title')).toBe('小雨 · 降雨强度 10 mm/h')
    expect(environment.find('[data-testid="scene-map-rain-label"]').exists()).toBe(false)
    expect(environment.get('[data-testid="scene-map-cloud-label"]').text()).toMatch(/500.*2000\s*m/)
    expect(environment.get('[data-testid="scene-map-sea-label"]').text()).toMatch(/3\s*级/)
    const profile = environment.get('[data-testid="scene-map-cloud-profile"]')
    expect(profile.element.closest('details')?.open).toBe(false)
    expect(profile.text()).toContain('0.5 g/m³')

    const simulation = useSimulationStore()
    for (const [rate, tier, label, drops] of [
      [0, 'none', '无雨', 0], [10, 'lightRain', '小雨', 1], [12.5, 'moderateRain', '中雨', 2],
      [25, 'moderateRain', '中雨', 2], [50, 'heavyRain', '大雨', 3], [100, 'stormRain', '暴雨', 4],
    ] as const) {
      simulation.selectedScene!.config.scenario.environment = { ...SCENE_ENVIRONMENT, rainRateMmPerHour: rate }
      await flushPromises()
      expect(rainIcon().attributes('data-rain-tier')).toBe(tier)
      expect(rainIcon().attributes('aria-label')).toBe(`${label} · 降雨强度 ${rate} mm/h`)
      expect(rainIcon().findAll('.offline-map__rain-drops i')).toHaveLength(drops)
    }
    simulation.selectedScene!.config.scenario.environment = { ...SCENE_ENVIRONMENT, rainEnabled: false }
    await flushPromises()
    expect(rainIcon().attributes('title')).toBe('降雨模型关闭')
    expect(rainIcon().find('.offline-map__rain-drops').exists()).toBe(false)

    expect(await simulation.selectScene('')).toBe(true)
    await flushPromises()
    expect(wrapper.find('[data-testid="scene-map-environment"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="scene-map-rain-indicator"]').exists()).toBe(false)
    expect(mapControllerMock.latestOptions?.configuredEnvironment).toBeUndefined()
  })

  async function mountLiveMission(readPositions: (scene: ScenarioDraft, init?: RequestInit) => Promise<Response>) {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    let current = simulationRun('RUNNING', true)
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (/\/simulations\/[^/]+\/positions$/.test(input)) return readPositions(scene, init)
      if (/\/simulations\/[^/]+\/messages(?:\?|$)/.test(input)) {
        return successResponse({
          runId: current.runId, scenarioId: scene.config.scenario.id, revision: scene.revision,
          generation: 0, cursor: 0, hasMore: false, sourceAvailable: false, latestSimTime: null,
          waitingForLine: false, messageDetailsComplete: true, issueCount: 0,
          issues: { undelivered: 0, ambiguous: 0, unclassified: 0 },
          totalTransmits: 0, totalReceives: 0, totalPaired: 0, unconfirmedCount: 0,
          deliveries: [], unconfirmedTransmits: [],
        })
      }
      if (input.endsWith('/simulations')) return successResponse([current])
      if (input.endsWith(`/scenarios/${scene.config.scenario.id}`)) return successResponse(scene)
      throw new Error(`Unexpected request ${input}`)
    })
    vi.stubGlobal('fetch', fetcher)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const wrapper = await mountSituationPage(scene.config.scenario.id, 'LOCAL')
    return { wrapper, scene, fetcher, setRun(run: SimulationRun) { current = run; useSimulationStore().run = run } }
  }

  function livePositions(scene: ScenarioDraft, time: number | null, runId = 'RUN-001', hasMore = false) {
    const platform = scene.config.platforms[0]!
    const node: PositionUpdate = { platformId: platform.id, time: time ?? 0, longitude: 121 + (time ?? 0) / 100,
      latitude: 25, altitude: 2000, speed: 100, heading: 90 }
    return { runId, scenarioId: scene.config.scenario.id, revision: scene.revision,
      positions: time === null ? null : { fileName: 'position.csv', generation: 1, nodes: [node], recordCount: 1,
        issueCount: 0, issues: [], waitingForLine: false, hasMore } }
  }

  it('本机 mission 订阅当前任务，结束后收齐 TXT 尾帧，离开页面仍关闭订阅', async () => {
    const socket = Object.assign(new EventTarget(), { readyState: 0, send: vi.fn<(data: string) => void>(), close: vi.fn() })
    const connect = Object.assign(vi.fn(function () { return socket }), { OPEN: 1, CONNECTING: 0 })
    vi.stubGlobal('WebSocket', connect)
    const { wrapper, setRun } = await mountLiveMission(async scene => successResponse(livePositions(scene, null)))
    const run = useSimulationStore().run!
    expect(run.executionSource).not.toBe('REMOTE_WS')
    expect(connect).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledWith(expect.stringContaining('missionRunId=' + run.runId))
    expect(socket.close).not.toHaveBeenCalled()
    socket.readyState = 1
    socket.dispatchEvent(new Event('open'))
    const subscription = JSON.parse(socket.send.mock.calls[0]![0])
    expect(subscription).toMatchObject({ type: 'subscribe', taskId: run.taskId })
    expect(subscription.topics).toEqual(expect.arrayContaining(['link.metric', 'mission.log', 'position.update']))
    const receive = (value: unknown) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
    receive({ ...subscription, type: 'subscribed', lastSequence: 0, nextSequence: 1 })
    expect(useTelemetryStore().connectionState).toBe('SUBSCRIBED')

    const { readMockFrames } = await import('../../scripts/websocketData/' + 'read-frames.mjs')
    const quality = useRuntimeQualityStore()
    let lastEnvelope: unknown
    for (const [index, raw] of readMockFrames('scripts/websocketData/frame_snap.txt').slice(0, 2).entries()) {
      const payload = { ...adaptEngineFrameSnapshot(raw).data!, runId: run.runId }
      lastEnvelope = { type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: run.taskId, sequence: index + 1,
        frameId: 'F-ENGINE-' + payload.frameId, simulationTime: payload.simulationTime, payload }
      receive(lastEnvelope)
      await vi.advanceTimersByTimeAsync(100)
      await flushPromises()
      expect(quality.engineFrame).toEqual(payload)
      expect(quality.engineFrame!.frameId).toBe(index * 5)
    }
    await wrapper.get('[id$="tab-quality"]').trigger('click')
    expect(wrapper.get('[data-testid="quality-source"]').text()).toBe('数据时刻：00:00:05 · 连接中断')
    expect(wrapper.findAll('[data-testid="engine-quality"] .quality-card')).toHaveLength(quality.engineFrame!.links.length)
    expect(connect).toHaveBeenCalledOnce()

    setRun({ ...run, uiStatus: 'STOPPED', configLocked: false })
    await flushPromises()
    expect(socket.close).not.toHaveBeenCalled()
    const payload = { ...structuredClone(quality.engineFrame!), frameId: 450, simulationTime: 450 }
    receive({ type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: run.taskId, sequence: 3,
      frameId: 'F-ENGINE-450', simulationTime: 450, payload })
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()
    expect(quality.engineFrame).toEqual(payload)
    expect(useTelemetryStore().topicSequences['link.metric']).toBe(3)
    expect(wrapper.get('[data-testid="quality-source"]').text()).toBe('数据时刻：00:07:30 · 已结束')
    wrapper.unmount()
    mountedWrapper = null
    expect(socket.close).toHaveBeenCalledOnce()
    expect(useTelemetryStore().connectionState).toBe('DISCONNECTED')
    receive(lastEnvelope)
    await vi.advanceTimersByTimeAsync(5000)
    expect(connect).toHaveBeenCalledOnce()
    expect(useTelemetryStore().topicSequences['link.metric']).toBe(0)
  })

  it('真实运行等待本次CSV后持续更新地图，配置位置和旧input文件不被当成运行位置', async () => {
    let time: number | null = null
    const { wrapper, scene, fetcher } = await mountLiveMission(async scene => successResponse(livePositions(scene, time)))
    const platform = scene.config.platforms[0]!
    const initialPosition = { ...platform.initialPosition }
    const satellite = useSimulationStore().selectedScene!.config.platforms.find(node => node.type === 'COMMUNICATION_SATELLITE')!
    satellite.satelliteType = 'SHENTONG'
    await flushPromises()
    const mapSatellite = mapControllerMock.latestOptions!.initialNodes!.find(node => node.platformId === satellite.id)!
    expect(mapSatellite.satelliteType).toBe('SHENTONG')
    expect(nodeIconUrl(mapSatellite)).toBe(MAP_CONFIG.nodeTypeImages.SHENTONG)
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject(platform.initialPosition)
    await wrapper.get('.scene-summary__tabs button:last-child').trigger('click')
    expect(wrapper.text()).toContain('等待本次仿真写入位置数据')
    time = 5
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject({ platformId: platform.id, longitude: 121.05, time: 5 })
    time = 10
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject({ longitude: 121.1, time: 10 })
    expect(wrapper.text()).toContain('本次位置已更新至 10 s')
    expect(useSimulationStore().selectedScene!.config.platforms[0]!.initialPosition).toEqual(initialPosition)
    expect(fetcher.mock.calls.some(([url]) => /situation\/(initial-nodes|positions)/.test(url))).toBe(false)
  })

  it('真实位置 WS 实际更新地图节点；引擎干扰和切换主题各自驱动可见状态且不混入同帧事件列表', async () => {
    const { wrapper, scene } = await mountLiveMission(async scene => successResponse(livePositions(scene, null)))
    const platform = scene.config.platforms[0]!
    const telemetry = useTelemetryStore()
    telemetry.missionPositionUpdate = {
      kind: 'MISSION_POSITION', runId: 'RUN-001', scenarioId: scene.config.scenario.id, revision: scene.revision,
      sourceGeneration: 9, sourceRecordCount: 12, waitingForLine: false,
      nodes: [{ platformId: platform.id, time: 11, longitude: 122, latitude: 26, altitude: 50, speed: 6, heading: 45 }],
    }
    telemetry.engineJammerUpdates = [{ kind: 'ENGINE_JAMMER_FRAME', runId: 'RUN-001', engineEpoch: 0, sourceFrameId: 21, simulationTime: 8, jammers: [], events: [] }]
    telemetry.engineSwitchUpdates = [{ kind: 'ENGINE_SWITCH_FRAME', runId: 'RUN-001', engineEpoch: 0, sourceFrameId: 21, simulationTime: 8, switches: [] }]
    await flushPromises()
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject({ platformId: platform.id, longitude: 122, latitude: 26, time: 11, heading: 45 })
    expect(wrapper.get('[data-testid="engine-jammer-topic-status"]').text()).toContain('帧 21')
    expect(wrapper.get('[data-testid="engine-switch-topic-status"]').text()).toContain('帧 21')
    expect(wrapper.findAll('.event-list li')).toHaveLength(0)
  })

  it('链路帧落后或位置先到时不展示未来坐标，尾帧到齐后展示最后位置', async () => {
    const { scene, setRun, wrapper } = await mountLiveMission(async scene => successResponse(livePositions(scene, 10)))
    const run = useSimulationStore().run!
    const quality = useRuntimeQualityStore()
    const base = { ...adaptEngineFrameSnapshot(engineSample).data!, runId: run.runId }
    quality.acceptEngineFrame(quality.epoch, { ...base, frameId: 10, simulationTime: 10 })
    const node = (time: number) => ({ ...livePositions(scene, time).positions!.nodes[0]! })
    useTelemetryStore().missionPositionUpdate = { kind: 'MISSION_POSITION', runId: run.runId, scenarioId: scene.config.scenario.id,
      revision: scene.revision, sourceGeneration: 1, sourceRecordCount: 2, waitingForLine: false, nodes: [node(20)] }
    await flushPromises()
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject(node(10))
    const comparisonPositions = () => wrapper.getComponent({ name: 'LinkQualityDialog' }).props('nodePositions')
    expect(comparisonPositions()).toEqual([node(10)])
    quality.acceptEngineFrame(quality.epoch, { ...base, frameId: 15, simulationTime: 15 })
    await flushPromises()
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject(node(10))
    expect(quality.engineFrame?.simulationTime).toBe(10)
    quality.acceptEngineFrame(quality.epoch, { ...base, frameId: 20, simulationTime: 20 })
    await flushPromises()
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject(node(20))
    expect(quality.engineFrame?.simulationTime).toBe(20)
    setRun({ ...run, uiStatus: 'COMPLETED', configLocked: false })
    quality.acceptEngineFrame(quality.epoch, { ...base, frameId: 25, simulationTime: 25 })
    await flushPromises()
    expect(quality.engineFrame?.simulationTime).toBe(25)
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject(node(20))
    expect(comparisonPositions()).toEqual([node(20)])
  })

  it('本机暂停立即固定小数秒时钟、地图和质量，超过位置缓存的积压在继续时对齐', async () => {
    const time = 10.25
    const { scene, wrapper, setRun, fetcher } = await mountLiveMission(async scene => successResponse(livePositions(scene, time)))
    const run = useSimulationStore().run!
    setRun({ ...run, engineControl: { action: null, delivery: 'IDLE', connected: true } })
    const quality = useRuntimeQualityStore()
    const base = { ...adaptEngineFrameSnapshot(engineSample).data!, runId: run.runId }
    const accept = (t: number) => quality.acceptEngineFrame(quality.epoch, { ...base, frameId: t, simulationTime: t })
    accept(time)
    await flushPromises()
    const respond = fetcher.getMockImplementation()!
    let finishPause!: () => void
    const pauseResponse = new Promise<void>(resolve => { finishPause = resolve })
    fetcher.mockImplementation(async (url, init) => {
      if (!url.endsWith('/commands')) return respond(url, init)
      const pause = JSON.parse(String(init?.body)).command === 'PAUSE'
      if (pause) await pauseResponse
      return new Response(JSON.stringify({ ok: true, data: { ...run, engineControl: { connected: true, delivery: 'SENT', action: pause ? 'pause' : 'resume' } } }), { status: 202 })
    })
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    expect(quality.presentationPaused).toBe(true)
    const assertDisplay = (t: number) => {
      expect(wrapper.get('[data-testid="simulation-progress"]').text()).toContain(`${Math.floor(t / 60)}分${t % 60}秒`)
      expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject({ time: t })
      expect(quality.engineFrame).toMatchObject({ frameId: t, simulationTime: t })
    }
    for (let i = 1; i <= 205; i++) {
      const t = time + i
      useTelemetryStore().missionPositionUpdate = { kind: 'MISSION_POSITION', runId: run.runId,
        scenarioId: scene.config.scenario.id, revision: scene.revision, sourceGeneration: 1, sourceRecordCount: i + 1,
        waitingForLine: false, nodes: livePositions(scene, t).positions!.nodes }
      accept(t)
    }
    await flushPromises()
    assertDisplay(time)
    finishPause()
    await flushPromises()
    assertDisplay(time)
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    assertDisplay(time + 205)
  })

  it('迟到的位置 HTTP 快照不会覆盖更新后的同源 WebSocket 记录', async () => {
    let resolveResponse!: (response: Response) => void
    const { scene } = await mountLiveMission(scene => new Promise<Response>(resolve => { resolveResponse = resolve }))
    await flushPromises()
    const platform = scene.config.platforms[0]!
    const telemetry = useTelemetryStore()
    telemetry.missionPositionUpdate = {
      kind: 'MISSION_POSITION', runId: 'RUN-001', scenarioId: scene.config.scenario.id, revision: scene.revision,
      sourceGeneration: 3, sourceRecordCount: 8, waitingForLine: false,
      nodes: [{ platformId: platform.id, time: 12, longitude: 122, latitude: 26, altitude: 50, speed: 6, heading: 45 }],
    }
    await flushPromises()
    resolveResponse(successResponse(livePositions(scene, 2)))
    await flushPromises()
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject({ platformId: platform.id, longitude: 122, latitude: 26, time: 12 })
  })

  it.each([100, 0])('节点详情仅在收到该节点本次位置后显示实际速度 %s m/s', async speed => {
    let received = false
    const { scene } = await mountLiveMission(async scene => {
      const data = livePositions(scene, received ? 0 : null)
      if (data.positions) data.positions.nodes[0]!.speed = speed
      return successResponse(data)
    })
    const detailValue = (name: string) => Array.from(document.querySelectorAll('[data-testid="selected-node-dialog"] dt'))
      .find(label => label.textContent === name)?.nextElementSibling?.textContent
    const selectNode = async (platformId: string) => {
      mapControllerMock.latestOptions!.onSelectNode(platformId)
      await flushPromises()
    }
    await selectNode(scene.config.platforms[0]!.id)
    expect(detailValue('速度')).toBe('暂无运行数据')
    expect(detailValue('位置数据来源')).toBe('场景初始配置')
    expect(detailValue('位置仿真时刻')).toBe('暂无数据')
    received = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(detailValue('速度')).toBe(`${speed} m/s`)
    expect(detailValue('位置数据来源')).toBe('本次运行位置记录')
    expect(detailValue('位置仿真时刻')).toBe('0分0秒')
    expect(detailValue('位置来源帧')).toBeUndefined()
    await selectNode(scene.config.platforms[1]!.id)
    expect(detailValue('速度')).toBe('暂无运行数据')
    expect(detailValue('位置数据来源')).toBe('场景初始配置')
    await selectNode(scene.config.platforms[0]!.id)
    expect(detailValue('速度')).toBe(`${speed} m/s`)
    received = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(detailValue('速度')).toBe('暂无运行数据')
  })

  it('结束时读取最后位置并排空增量，完成后停止轮询且保留最终坐标', async () => {
    let time = 5
    let hasMore = false
    const { scene, fetcher, setRun } = await mountLiveMission(async scene => successResponse(livePositions(scene, time, 'RUN-001', hasMore)))
    time = 20
    hasMore = true
    setRun({ ...simulationRun('COMPLETED', false), startedAt: '2026-08-06T08:05:00Z' })
    await flushPromises()
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject({ time: 20 })
    hasMore = false
    time = 25
    await vi.advanceTimersByTimeAsync(50)
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject({ platformId: scene.config.platforms[0]!.id, time: 25 })
    fetcher.mockClear()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('本机手动停止后地图恢复场景初始位置，迟到的尾帧不再覆盖地图', async () => {
    let time = 5
    let stopped = false
    let finishTail!: (response: Response) => void
    let finishArchive!: () => void
    const archiving = new Promise<void>(resolve => { finishArchive = resolve })
    const { wrapper, scene, fetcher } = await mountLiveMission(async scene => stopped
      ? new Promise(resolve => { finishTail = resolve })
      : successResponse(livePositions(scene, time)))
    const run = useSimulationStore().run!
    const position = scene.config.platforms[0]!.initialPosition
    const firstNode = () => mapControllerMock.latestOptions!.initialNodes![0]
    expect(firstNode()).toMatchObject({ time: 5 })
    time = 10
    await vi.advanceTimersByTimeAsync(1_000)
    expect(firstNode()).toMatchObject({ time: 10 })
    expect(mapControllerMock.controller.setNodeTrails).toHaveBeenLastCalledWith([expect.objectContaining({
      platformId: scene.config.platforms[0]!.id,
    })])

    const confirmation: ConfirmationContext = { confirmationId: 'CONF-LOCAL-STOP', state: 'AWAITING_CONFIRMATION',
      actor: 'operator', role: 'OPERATOR', createdAt: '2026-08-06T08:00:00Z', expiresAt: '2026-08-06T08:05:00Z' }
    const respond = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (url, init) => {
      if (url.endsWith('/confirmations')) return successResponse(confirmation)
      if (url.endsWith(`/confirmations/${confirmation.confirmationId}`)) return successResponse({ ...confirmation, state: 'CONFIRMED' })
      if (url.endsWith(`/simulations/${run.runId}/commands`)) {
        expect(JSON.parse(String(init?.body))).toEqual({ command: 'STOP', confirmationId: confirmation.confirmationId })
        stopped = true
        await archiving
        expect(init?.signal?.aborted).toBe(false)
        return successResponse({ ...simulationRun('STOPPED', false), startedAt: run.startedAt })
      }
      if (url.endsWith(`/simulations/${run.runId}`)) return successResponse({ ...run, canonical: { ...run.canonical, processId: null } })
      return respond(url, init)
    })
    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="mission-stop-progress"]').text()).toContain('正在停止')
    expect(useTelemetryStore().acceptEnvelope({ type: 'event', schemaVersion: '1.0', topic: 'runtime.state', taskId: run.taskId,
      sequence: 1, payload: { ...run.canonical, processId: null } })).toBe(true)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(wrapper.get('[data-testid="mission-stop-progress"]').text()).toContain('进程已退出')
    expect(useSimulationStore().run?.configLocked).toBe(true)
    finishArchive()
    await flushPromises()
    expect(useSimulationStore().run?.uiStatus).toBe('STOPPED')
    expect(firstNode()).toMatchObject(position)
    expect(firstNode()).not.toHaveProperty('time')
    expect(mapControllerMock.controller.setNodeTrails).toHaveBeenLastCalledWith([])

    finishTail(successResponse(livePositions(scene, 20)))
    await flushPromises()
    expect(firstNode()).toMatchObject(position)
    expect(firstNode()).not.toHaveProperty('time')
  })

  it('更换运行立即清除旧位置，迟到的旧任务响应不覆盖新任务', async () => {
    let finish!: (response: Response) => void
    let first = true
    const { scene, setRun } = await mountLiveMission(async scene => {
      if (first) { first = false; return new Promise(resolve => { finish = resolve }) }
      return successResponse(livePositions(scene, null, 'RUN-002'))
    })
    setRun({ ...simulationRun('RUNNING', true), runId: 'RUN-002' })
    await flushPromises()
    finish(successResponse(livePositions(scene, 100)))
    await flushPromises()
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject(scene.config.platforms[0]!.initialPosition)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mapControllerMock.latestOptions!.initialNodes![0]).not.toHaveProperty('time', 100)
  })

  it.each(['离页', '登出', '换场景'])('位置请求在途时%s会取消请求并拒绝迟到坐标', async action => {
    let finish!: (response: Response) => void
    let signal: AbortSignal | null | undefined
    const { wrapper, scene, fetcher } = await mountLiveMission(async (_, init) => {
      signal = init?.signal
      return new Promise(resolve => { finish = resolve })
    })
    if (action === '离页') { wrapper.unmount(); mountedWrapper = null }
    else if (action === '登出') useAuthStore().resetToSafeEmpty()
    else useSimulationStore().selectedScene = { ...scene, config: { ...scene.config, scenario: { ...scene.config.scenario, id: 'SCN-OTHER' } } }
    await flushPromises()
    expect(signal?.aborted).toBe(true)
    finish(successResponse(livePositions(scene, 100)))
    await flushPromises()
    if (action !== '离页') expect(mapControllerMock.latestOptions!.initialNodes?.[0]).not.toHaveProperty('time', 100)
    fetcher.mockClear()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/positions'))).toBe(false)
  })

  it('错运行或错修订的响应不进入地图；读取失败重试并恢复', async () => {
    let kind: 'wrong-run' | 'wrong-revision' | 'failed' | 'ready' = 'wrong-run'
    const { wrapper, scene } = await mountLiveMission(async scene => {
      if (kind === 'failed') throw new Error('connection failed')
      const data = livePositions(scene, 40, kind === 'wrong-run' ? 'RUN-OTHER' : 'RUN-001')
      if (kind === 'wrong-revision') data.revision += 1
      return successResponse(data)
    })
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject(scene.config.platforms[0]!.initialPosition)
    kind = 'wrong-revision'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mapControllerMock.latestOptions!.initialNodes![0]).not.toHaveProperty('time', 40)
    kind = 'failed'
    await vi.advanceTimersByTimeAsync(1_000)
    kind = 'ready'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject({ time: 40 })
    await wrapper.get('.scene-summary__tabs button:last-child').trigger('click')
    expect(wrapper.text()).toContain('本次位置已更新至 40 s')
  })

  it('请求超时会取消并重试，不阻塞后续位置读取', async () => {
    let waiting = true
    let signal: AbortSignal | null | undefined
    const { wrapper } = await mountLiveMission(async (scene, init) => {
      if (!waiting) return successResponse(livePositions(scene, 15))
      waiting = false
      signal = init?.signal
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('timeout'))))
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(signal?.aborted).toBe(true)
    expect(wrapper.get('.situation-footer').text()).toContain('本次位置读取失败')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mapControllerMock.latestOptions!.initialNodes![0]).toMatchObject({ time: 15 })
  })

  it('质量指标位于右侧页签而非弹框，联动选中链路且来回切换保留筛选', async () => {
    const wrapper = await mountSituationPage()
    const panel = wrapper.get('.telemetry-panel')
    const tabs = panel.findAll('[role="tab"]')
    expect(tabs.map(tab => tab.text())).toEqual(['链路状态', '干扰侦测', '质量指标'])
    expect(tabs[0]!.attributes('aria-selected')).toBe('true')
    mapControllerMock.latestOptions!.onSelectLink(SITUATION_LINKS_F00042[0]!)
    await flushPromises()
    // 关闭既有链路详情；质量页签本身不得创建遮挡地图的弹框。
    const close = document.querySelector<HTMLButtonElement>('.link-quality-dialog .el-dialog__headerbtn')
    close?.click()
    await tabs[2]!.trigger('click')
    await flushPromises()
    const quality = panel.get('[data-testid="quality-metric-panel"]')
    expect(quality.isVisible()).toBe(true)
    expect(document.querySelector('[role="dialog"][aria-label="实时质量指标"]')).toBeNull()
    expect(quality.findAllComponents(ElSelect)[2]!.props('modelValue')).toBe(SITUATION_LINKS_F00042[0]!.linkId)
    quality.findAllComponents(ElSelect)[3]!.vm.$emit('update:modelValue', 5000)
    await tabs[0]!.trigger('click')
    expect(panel.get('.telemetry-section--links').isVisible()).toBe(true)
    await tabs[2]!.trigger('click')
    expect(quality.findAllComponents(ElSelect)[3]!.props('modelValue')).toBe(5000)
    await panel.get('[data-testid="toggle-telemetry-panel"]').trigger('click')
    await panel.get('[data-testid="toggle-telemetry-panel"]').trigger('click')
    expect(tabs[2]!.attributes('aria-selected')).toBe('true')
  })

  it('干扰侦测页签不再提供本地干扰控制入口与弹框', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    scene.config.jammers[0]!.defaultPower = 0.1
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/simulations')) return successResponse([])
      if (url.endsWith(`/scenarios/${scene.config.scenario.id}`)) return successResponse(scene)
      throw new Error(`Unexpected request ${url}`)
    }))
    const wrapper = await mountSituationPage(scene.config.scenario.id)
    const panel = wrapper.get('.telemetry-panel')
    const jammersTab = panel.findAll('[role="tab"]').find(tab => tab.text() === '干扰侦测')!
    await jammersTab.trigger('click')
    await flushPromises()
    expect(panel.find('[data-testid="open-rf-jammer-control"]').exists()).toBe(false)
    expect(document.querySelector('[data-testid="rf-jammer-dialog"]')).toBeNull()
  })

  it.each([false, true])('关闭 mission 后重新打开不恢复运行，仅保留场景选择=%s', async hasSelection => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    scene.locked = false
    const stopped = { ...simulationRun('STOPPED', false), scenarioId: scene.config.scenario.id }
    if (hasSelection) sessionStorage.setItem('wrj.simulation.selectedScene', JSON.stringify({ userId: OPERATOR.userId, scenarioId: scene.config.scenario.id }))
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/simulations')) return successResponse([stopped])
      if (url.endsWith('/scenarios/' + scene.config.scenario.id)) return successResponse(scene)
      if (url.endsWith('/initial-nodes')) return successResponse(INITIAL_NODES)
      throw new Error('Unexpected request ' + url)
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = await mountSituationPage(undefined, 'LOCAL')
    expect(useSimulationStore().selectedScene?.config.scenario.id).toBe(hasSelection ? scene.config.scenario.id : undefined)
    expect(useSimulationStore().run?.configLocked).toBe(false)
    expect(wrapper.get('[data-testid="simulation-stop"]').attributes('disabled')).toBeDefined()
    expect(useTelemetryStore().connectionState).toBe('DISCONNECTED')
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
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
    expect(mountedWrapper!.findComponent({ name: 'SimulationToolbar' }).props('realMission')).toBe(false)
    mountedWrapper!.unmount()
    mountedWrapper = null
    scene.revision += 1
    scene.config.scenario.name = '服务端最新场景名称'
    scene.config.platforms[0]!.name = '服务端最新节点名称'
    const wrapper = await mountSituationPage()
    expect(useSimulationStore().selectedScene?.config.scenario.id).toBe(id)
    expect(wrapper.get('.simulation-toolbar__title').text()).toContain('当前场景：服务端最新场景名称')
    expect(mapControllerMock.latestOptions?.initialNodes?.[0]?.name).toBe('服务端最新节点名称')
    const panel = wrapper.get('.telemetry-panel')
    expect(panel.findAll('.panel-heading strong').map(item => item.text())).toEqual(['全链路状态', '同帧事件', '干扰 / 侦测设备'])
    expect(panel.findAll('tr[data-link-id]')).toHaveLength(scene.config.links.length)
    expect(wrapper.get('.summary-focus-button').findAll('span, small')).toHaveLength(2)
    await panel.get('[data-testid="toggle-telemetry-panel"]').trigger('click')
    expect(panel.attributes('data-collapsed')).toBe('true')
    await panel.get('[data-testid="toggle-telemetry-panel"]').trigger('click')
    expect(panel.attributes('data-collapsed')).toBe('false')
    await panel.get('tr[data-link-id="L-MW-01"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="link-detail-configured"]')).toBeNull()
    await panel.get('tr[data-link-id="L-MW-01"]').trigger('dblclick')
    await flushPromises()
    expect(document.querySelector('[data-testid="link-detail-configured"]')?.textContent).toContain('规范状态暂无数据')
    expect(fetcher.mock.calls.some(([url]) => /initial-nodes|positions|frames|events/.test(url))).toBe(false)
  })

  it('远端播放连接，暂停后点播放恢复，停止合并保存且无额外按钮', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    let running: SimulationRun = { ...simulationRun('RUNNING', true), executionSource: 'REMOTE_WS', startedAt: '2026-11-09T01:00:00Z', engineControl: { connected: true, action: null, delivery: 'IDLE' } }
    running.canonical.processId = null
    const fetcher = vi.fn(async (url: string) => url.endsWith('/simulations') ? successResponse([running]) : successResponse(scene))
    vi.stubGlobal('fetch', fetcher)
    const connect = vi.fn(function () { return new SilentWebSocket() })
    Object.assign(connect, { OPEN: SilentWebSocket.OPEN, CONNECTING: SilentWebSocket.CONNECTING })
    vi.stubGlobal('WebSocket', connect)
    const wrapper = await mountSituationPage('SCN-001', 'LOCAL')
    expect(connect).toHaveBeenCalledOnce()
    const store = useSimulationStore()
    const pause = vi.spyOn(store, 'pause').mockImplementation(async () => {
      running = { ...running, engineControl: { connected: true, action: 'pause', delivery: 'SENT' } }
      store.applyRun(running)
      return true
    })
    const resume = vi.spyOn(store, 'resume').mockImplementation(async () => {
      running = { ...running, engineControl: { connected: true, action: 'resume', delivery: 'SENT' } }
      store.applyRun(running)
      return true
    })
    const stop = vi.spyOn(store, 'stop').mockImplementation(async () => {
      running = { ...running, uiStatus: 'STOPPED', configLocked: false,
        engineControl: { connected: false, action: 'stop', delivery: 'SENT' } }
      store.applyRun(running)
      return true
    })
    const polls = () => fetcher.mock.calls.filter(([url]) => url.endsWith('/simulations')).length
    const initialPolls = polls()
    await vi.advanceTimersByTimeAsync(1000)
    expect(polls()).toBe(initialPolls + 1)
    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    await flushPromises()
    expect(pause).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(3000)
    expect(polls()).toBe(initialPolls + 1)
    expect(wrapper.get('[data-testid="simulation-start"]').text()).toContain('播放')
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    expect(resume).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(polls()).toBe(initialPolls + 2)
    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    await flushPromises()
    expect(stop).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(3000)
    expect(polls()).toBe(initialPolls + 2)
    expect(document.querySelector('[data-testid="confirm-stop"]')).toBeNull()
    expect(fetcher.mock.calls.some(([url]) => /positions|console|\/quality$/.test(url))).toBe(false)
    expect(connect).toHaveBeenCalledOnce()
    expect(wrapper.find('[data-testid="simulation-disconnect"]').exists()).toBe(false)
  })

  it('本机 SQLite 场景将真实 mission 模式传给工具栏', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/simulations')
      ? successResponse([]) : successResponse(scene)))

    await mountSituationPage('SCN-001', 'LOCAL')
    expect(mountedWrapper!.findComponent({ name: 'SimulationToolbar' }).props('realMission')).toBe(true)
    useSimulationStore().applyRun(simulationRun('RUNNING', true))
    const stop = vi.spyOn(useSimulationStore(), 'stop').mockResolvedValue(true)
    await flushPromises()
    await mountedWrapper!.get('[data-testid="simulation-stop"]').trigger('click')
    await flushPromises()
    expect(stop).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-testid="confirm-stop"]')).toBeNull()
  })

  it('本机 Mission 的暂停和继续发送到同一次运行，发送后仍轮询引擎状态', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    let run: SimulationRun = { ...simulationRun('RUNNING', true), engineControl: { connected: true, action: null, delivery: 'IDLE' } }
    const commands: Array<{ url: string; command: string }> = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/commands') && init?.method === 'POST') {
        const { command } = JSON.parse(String(init.body))
        commands.push({ url, command })
        run = { ...run, engineControl: { connected: true, action: command === 'PAUSE' ? 'pause' : 'resume', delivery: 'SENT' } }
        return new Response(JSON.stringify({ ok: true, data: run }), { status: 202 })
      }
      if (url.endsWith('/simulations')) return successResponse([run])
      if (url.endsWith('/scenarios/SCN-001')) return successResponse(scene)
      return successResponse(null)
    })
    vi.stubGlobal('fetch', fetcher)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const wrapper = await mountSituationPage('SCN-001', 'LOCAL')

    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="simulation-start"]').text()).toContain('继续')
    expect(wrapper.get('[data-testid="engine-control-status"]').text()).toContain('待确认')
    expect(useSimulationStore().run).toMatchObject({ uiStatus: 'RUNNING', runId: 'RUN-001', configLocked: true })
    const polls = () => fetcher.mock.calls.filter(([url]) => url.endsWith('/simulations')).length
    const pausedPolls = polls()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(polls()).toBe(pausedPolls + 1)

    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    expect(commands.map(({ url, command }) => [url.split('/').slice(-3).join('/'), command])).toEqual([
      ['simulations/RUN-001/commands', 'PAUSE'], ['simulations/RUN-001/commands', 'RESUME'],
    ])
    expect(wrapper.get('[data-testid="simulation-start"]').text()).toContain('开始')
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeUndefined()
  })

  it.each(['MOCK', 'LOCAL', 'UNKNOWN'] as const)('延迟后台同步时 %s 工具栏保持对应能力，不随轮询禁用', async mode => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    const running = simulationRun('RUNNING', true)
    const fetcher = vi.fn(async (url: string) => url.endsWith('/simulations')
      ? successResponse([running]) : successResponse(scene))
    vi.stubGlobal('fetch', fetcher)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const wrapper = await mountSituationPage('SCN-001', mode)
    let finish!: (response: Response) => void
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(useSimulationStore().runtimeSyncing).toBe(true)
    expect(useSimulationStore().pending).toBe(false)
    const pause = wrapper.get('[data-testid="simulation-pause"]')
    expect(wrapper.find('.simulation-toolbar select').exists()).toBe(false)
    expect(pause.element).toHaveProperty('disabled', mode !== 'MOCK')
    finish(successResponse([running]))
    await flushPromises()
  })

  it.each(['完成', '离页', '登出', '暂停'])('所选场景通过正式运行接口同步 mission，%s后停止轮询', async action => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    let current = simulationRun('RUNNING', true)
    const fetcher = vi.fn(async (url: string) => url.endsWith('/simulations')
      ? successResponse([current]) : successResponse(scene))
    vi.stubGlobal('fetch', fetcher)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const wrapper = await mountSituationPage('SCN-001')
    fetcher.mockClear()
    if (action === '完成') {
      current = simulationRun('COMPLETED', false)
      await vi.advanceTimersByTimeAsync(1_000)
      await flushPromises()
      expect(useSimulationStore().uiStatus).toBe('COMPLETED')
      expect(useSimulationStore().configurationLockState).toBe('UNLOCKED')
      expect(fetcher).toHaveBeenCalledTimes(1)
    } else if (action === '暂停') {
      current = simulationRun('PAUSED', true)
      useSimulationStore().applyRun(current)
      await flushPromises()
    } else if (action === '登出') {
      useAuthStore().resetToSafeEmpty()
      useSimulationStore().resetToSafeEmpty()
      await flushPromises()
    } else {
      wrapper.unmount()
      mountedWrapper = null
    }
    fetcher.mockClear()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetcher).not.toHaveBeenCalled()
    if (action === '暂停') {
      current = simulationRun('RUNNING', true)
      useSimulationStore().applyRun(current)
      await flushPromises()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it.each([true, false])('恢复态势数据后，场景快捷入口遵循菜单授权：%s', async allowed => {
    const principal: Principal = { ...OPERATOR, menuPaths: allowed ? ['/situation', '/scenarios'] : ['/situation'] }
    const wrapper = await mountSituationPage(undefined, 'MOCK', principal)
    expect(wrapper.find('.scene-summary').exists()).toBe(true)
    expect(wrapper.find('.telemetry-panel').exists()).toBe(true)
    expect(wrapper.findAll('.scene-summary a').filter(link => link.text() === '进入场景配置')).toHaveLength(allowed ? 1 : 0)
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
      ? ['链路', '体制', 'SNR', '误码率(BER)', '状态'] : ['链路', '体制', '状态'])
    const row = wrapper.get('tr[data-link-id="L-MW-01"]')
    const link = SITUATION_LINKS_F00042.find(item => item.linkId === 'L-MW-01')!
    expect(row.get('td strong').text()).toBe(`${link.sourceName}→${link.destinationName}`)
    expect(row.find('small').exists()).toBe(false)
    expect(row.findAll('td')).toHaveLength(show ? 5 : 3)
    if (show) expect(row.findAll('td')[2]!.text()).toBe(link.snrDb.toFixed(2))
  })

  it('全链路状态在仅有 CSV 设备启停时显示关闭，启停证据随游标和重载更新', async () => {
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
    const badge = () => wrapper.get('.link-table td:last-child .el-tag')
    expect(badge().text()).toBe('关闭')
    expect(badge().attributes('title')).toContain('设备启停证据：未知')
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    const playback = useReplayStore()
    await playback.pause()
    for (const [time, evidence] of [[1, '开启'], [2, '关闭'], [3, '开启'], [2, '关闭'], [0, '未知']] as const) {
      expect(await playback.seek(time)).toBe(true)
      await flushPromises()
      expect(badge().text()).toBe('关闭')
      expect(badge().attributes('title')).toContain(`设备启停证据：${evidence}`)
      expect(wrapper.findAll('.link-table tbody tr')).toHaveLength(1)
    }
    await playback.seek(2)
    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    expect(badge().attributes('title')).toContain('设备启停证据：未知')
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    expect(badge().attributes('title')).toContain('设备启停证据：未知')
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
    expect(wrapper.get('tr[data-link-id="L-DL-03"] td:last-child').text()).toBe('劣化')
    expect(wrapper.findAll('.link-table tbody tr.is-exception')).toHaveLength(0)
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
    expect(footer.text()).not.toContain('4 类业务信息节点')
    expect(footer.text()).not.toContain('4 类链路')
    expect(footer.text()).not.toContain('2 种干扰设备')
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
    expect(panel.findAll('.panel-heading strong').map(item => item.text())).toEqual(['全链路状态', '同帧事件', '干扰 / 侦测设备'])
    expect(panel.text()).toContain('当前时刻暂无通信关联')
    // 干扰 / 侦测与同帧事件均无数据时统一显示“暂无数据”。
    expect(panel.findAll('.telemetry-empty-state').map(item => item.text())).toEqual(['暂无数据', '暂无数据'])
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
    expect(document.querySelector('.selected-node-dialog .selected-node-dialog__notice')).toBeNull()
    expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="simulation-start"]').text()).toContain('播放')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('本机文件与 WebSocket 并行，直接停止防重入，保存失败可重试且成功后归零', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    const snapshot = structuredClone(LOCAL_REPLAY)
    snapshot.initial.connections = FILE_CONNECTIONS
    snapshot.durationS = 60
    snapshot.tracks[1]!.positions.push({ ...snapshot.tracks[1]!.positions[1]!, time: 60 })
    snapshot.recordCount += 1
    const source = playbackFileSource(snapshot)
    const idle = { ...simulationRun('STOPPED', false), executionSource: 'REMOTE_WS' as const }
    const fetcher = vi.fn(async (url: string) => successResponse(url.endsWith('/simulations') ? [structuredClone(toRaw(useSimulationStore().run ?? idle))]
      : url.endsWith(`/scenarios/${scene.config.scenario.id}`) ? scene : url.endsWith('/initial-nodes') ? snapshot.initial : snapshot))
    vi.stubGlobal('fetch', fetcher)
    const polls = () => fetcher.mock.calls.filter(([url]) => url.endsWith('/simulations')).length
    const wrapper = await mountSituationPage(scene.config.scenario.id, 'LOCAL')
    expect(wrapper.get('.simulation-toolbar__title').text()).toContain(`文件数据 · 已选场景：${scene.config.scenario.name}`)
    expect(wrapper.find('.simulation-toolbar select').exists()).toBe(false)
    const store = useSimulationStore()
    const connect = vi.spyOn(useTelemetryStore(), 'connect')
    const referencePicker = wrapper.get('[data-testid="file-parameter-reference"]').getComponent(ElSelect)
    expect(referencePicker.props('modelValue')).toBe('')
    expect(referencePicker.props('disabled')).toBe(false)
    referencePicker.vm.$emit('update:modelValue', 'SCN-001')
    await flushPromises()
    const start = vi.spyOn(store, 'start').mockImplementation(async (fileSource, referenceScenarioId) => {
      expect(fileSource).toEqual(source)
      expect(referenceScenarioId).toBe('SCN-001')
      store.applyRun({ ...simulationRun('RUNNING', true), fileSource, scenarioId: fileReceptionScenarioId(source),
        runId: `RUN-${start.mock.calls.length}`,
        canonical: { ...simulationRun('RUNNING', true).canonical, processId: null },
        executionSource: 'REMOTE_WS', startedAt: '2026-11-09T01:00:00Z',
        engineControl: { connected: true, action: null, delivery: 'IDLE' } })
      return true
    })
    const pause = vi.spyOn(store, 'pause').mockImplementation(async () => {
      store.applyRun({ ...structuredClone(toRaw(store.$state.run!)), engineControl: { connected: true, action: 'pause', delivery: 'SENT' } })
      return true
    })
    const resume = vi.spyOn(store, 'resume').mockImplementation(async () => {
      store.applyRun({ ...structuredClone(toRaw(store.$state.run!)), engineControl: { connected: true, action: 'resume', delivery: 'SENT' } })
      return true
    })
    const stop = vi.spyOn(store, 'stop').mockImplementation(async () => {
      store.applyRun({ ...structuredClone(toRaw(store.$state.run!)), uiStatus: 'STOPPED', configLocked: false,
        engineControl: { connected: false, action: 'stop', delivery: 'SENT' } })
      return true
    })
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    expect(start).toHaveBeenCalledOnce()
    expect(referencePicker.props('disabled')).toBe(true)
    useTelemetryStore().connectionState = 'SUBSCRIBED'
    const playback = useReplayStore(), quality = useRuntimeQualityStore()
    expect(quality.scope?.scenarioId).toBe(fileReceptionScenarioId(source))
    await vi.advanceTimersByTimeAsync(1000)
    expect(playback.replay!.currentTimeS).toBeGreaterThan(0.9)
    const frame = { ...adaptEngineFrameSnapshot(engineSample).data!, runId: store.run!.runId, frameId: 5, simulationTime: 5 }
    frame.links = [{ ...frame.links[0]!, linkIds: ['FILE-LINK-1'], status: 'DOWN', error: null }]
    expect(quality.acceptEngineFrame(quality.epoch, frame)).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(wrapper.get('tr[data-link-id="FILE-LINK-1"] td:last-child').text()).toBe('中断')
    expect(playback.replay!.currentTimeS).toBeGreaterThan(9.9)
    expect(playback.replay!.currentTimeS).toBeLessThanOrEqual(10)
    const frozenTime = playback.replay!.currentTimeS
    const playingPolls = polls()
    expect(playingPolls).toBeGreaterThan(1)
    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    await flushPromises()
    expect(pause).toHaveBeenCalledOnce()
    expect(quality.acceptEngineFrame(quality.epoch, { ...frame, frameId: 10, simulationTime: 10 })).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(polls()).toBe(playingPolls)
    expect(playback.replay?.currentTimeS).toBe(frozenTime)
    expect(quality.engineFrame?.frameId).toBe(5)
    expect(wrapper.get('[data-testid="simulation-start"]').text()).toContain('播放')
    expect(wrapper.findComponent({ name: 'ElSlider' }).props('disabled')).toBe(true)
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    expect(resume).toHaveBeenCalledOnce()
    expect(playback.replay?.currentTimeS).toBe(frozenTime)
    expect(quality.engineFrame?.frameId).toBe(10)
    expect(quality.acceptEngineFrame(quality.epoch, { ...frame, frameId: 15, simulationTime: 15 })).toBe(true)
    expect(playback.replay?.currentTimeS).toBe(15)
    await vi.advanceTimersByTimeAsync(1000)
    expect(polls()).toBe(playingPolls + 1)
    // 失联也能暂停本地画面和停止收尾，不将未发送命令报告为成功。
    store.applyRun({ ...structuredClone(toRaw(store.$state.run!)), engineControl: { connected: false, action: 'resume', delivery: 'SENT' } })
    const disconnectedTime = playback.replay!.currentTimeS
    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    expect(pause).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(3000)
    expect(polls()).toBe(playingPolls + 1)
    const previousEpoch = quality.epoch
    expect(quality.acceptEngineFrame(previousEpoch, { ...frame, frameId: 20, simulationTime: 20 })).toBe(true)
    let finishStop!: (saved: boolean) => void
    stop.mockImplementationOnce(() => new Promise<boolean>(resolve => { finishStop = resolve }))
    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="confirm-stop"]')).toBeNull()
    expect(stop).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-testid="simulation-stop"]').attributes('disabled')).toBeDefined()
    // 直接触发组件事件也不能绕过停止中的防重入。
    wrapper.findComponent({ name: 'SimulationToolbar' }).vm.$emit('stop')
    await flushPromises()
    expect(stop).toHaveBeenCalledOnce()
    store.$patch({ capabilityState: 'ERROR', resultMessage: '停止时数据保存失败，配置保持锁定，可再次点击停止重试保存：磁盘写入失败' })
    finishStop(false)
    await flushPromises()
    expect(store.run?.configLocked).toBe(true)
    expect(playback.replay?.currentTimeS).toBe(disconnectedTime)
    expect(playback.state).toBe('PAUSED')
    expect(wrapper.text()).toContain('磁盘写入失败')
    expect(wrapper.get('[data-testid="simulation-stop"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    await flushPromises()
    expect(stop).toHaveBeenCalledTimes(2)
    expect(playback.replay?.currentTimeS).toBe(0)
    expect(playback.state).toBe('PAUSED')
    expect(quality.engineFrame).toBeNull()
    expect(wrapper.find('[data-testid="simulation-disconnect"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(3000)
    expect(polls()).toBe(playingPolls + 1)
    expect(quality.engineEvents).toEqual([])
    expect(quality.engineSwitches).toEqual([])
    expect(quality.engineAlarms).toEqual([])

    // 停止后允许拖动查看文件，但新一轮播放仍须从零开始。
    wrapper.findComponent({ name: 'ElSlider' }).vm.$emit('change', 2)
    await flushPromises()
    expect(playback.replay?.currentTimeS).toBe(2)
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    expect(start).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenCalledTimes(2)
    useTelemetryStore().connectionState = 'SUBSCRIBED'
    expect(store.run?.runId).not.toBe(frame.runId)
    expect(playback.replay?.currentTimeS).toBe(0)
    expect(quality.engineFrame).toBeNull()
    expect(quality.acceptEngineFrame(previousEpoch, frame)).toBe(false)
    expect(quality.acceptEngineFrame(quality.epoch, frame)).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(playback.replay!.currentTimeS).toBeGreaterThan(0.9)
    const nextFrame = { ...frame, runId: store.run!.runId, events: [],
      routing: { ...frame.routing, switches: [], alarms: [] } }
    expect(quality.acceptEngineFrame(quality.epoch, nextFrame)).toBe(true)
    expect(playback.replay?.currentTimeS).toBe(5)
    expect(quality.engineEvents).toEqual([])
    expect(quality.engineSwitches).toEqual([])
    expect(quality.engineAlarms).toEqual([])
  })

  it.each(['超时', '断线'] as const)('首帧前连接失败仍连续播放，暂停冻结可恢复，接入后%s冻结且新帧校时', async failure => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    const snapshot = structuredClone(LOCAL_REPLAY)
    snapshot.durationS = 120
    snapshot.tracks[1]!.positions = [{ ...snapshot.tracks[1]!.positions[0]!, time: 0, longitude: 0 },
      { ...snapshot.tracks[1]!.positions[0]!, time: 120, longitude: 120 }]
    const idle = { ...simulationRun('STOPPED', false), executionSource: 'REMOTE_WS' as const }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => successResponse(url.endsWith('/simulations') ? [structuredClone(toRaw(useSimulationStore().run ?? idle))]
      : url.endsWith('/initial-nodes') ? snapshot.initial : snapshot)))
    const wrapper = await mountSituationPage(undefined, 'LOCAL')
    const store = useSimulationStore(), telemetry = useTelemetryStore(), quality = useRuntimeQualityStore(), playback = useReplayStore()
    vi.spyOn(store, 'start').mockImplementation(async fileSource => {
      store.applyRun({ ...simulationRun('RUNNING', true), fileSource, scenarioId: fileReceptionScenarioId(fileSource!),
        canonical: { ...simulationRun('RUNNING', true).canonical, processId: null, currentTime: 0 },
        executionSource: 'REMOTE_WS', engineControl: { connected: false, action: null, delivery: 'IDLE' } })
      return true
    })
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    telemetry.connectionState = 'SUBSCRIBED'
    telemetry.engineDiagnostics.push({ kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: store.run!.runId, state: 'DISCONNECTED', message: '首次连接失败' })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(playback.replay!.currentTimeS).toBeGreaterThan(11.9)
    expect(mapControllerMock.latestOptions!.initialNodes![0]!.longitude).toBeCloseTo(playback.replay!.currentTimeS, 6)
    expect(quality.engineFrame).toBeNull()
    expect(quality.engineAlarms).toEqual([])
    expect(wrapper.text()).toContain('播放中 · 等待数据')
    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    const paused = playback.replay!.currentTimeS
    await vi.advanceTimersByTimeAsync(3000)
    expect(playback.replay!.currentTimeS).toBe(paused)
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await vi.advanceTimersByTimeAsync(1000)
    expect(playback.replay!.currentTimeS).toBeGreaterThan(paused + 0.9)
    telemetry.engineDiagnostics.push({ kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: store.run!.runId, state: 'CONNECTED', message: '首次接入' })
    const connectedAt = playback.replay!.currentTimeS
    if (failure === '超时') {
      await vi.advanceTimersByTimeAsync(10_500)
      expect(playback.replay!.currentTimeS).toBeCloseTo(connectedAt + 10, 1)
      expect(wrapper.text()).toContain('数据超时 · 画面冻结')
    } else {
      telemetry.connectionState = 'RETRYING'
      await vi.advanceTimersByTimeAsync(2000)
      expect(playback.replay!.currentTimeS).toBe(connectedAt)
      telemetry.connectionState = 'SUBSCRIBED'
    }
    const frozen = playback.replay!.currentTimeS
    await vi.advanceTimersByTimeAsync(2000)
    expect(playback.replay!.currentTimeS).toBe(frozen)
    const frame = { ...adaptEngineFrameSnapshot(engineSample).data!, runId: store.run!.runId, frameId: 5, simulationTime: 5 }
    expect(quality.acceptEngineFrame(quality.epoch, frame)).toBe(true)
    expect(playback.replay!.currentTimeS).toBe(5)
    await vi.advanceTimersByTimeAsync(1000)
    expect(playback.replay!.currentTimeS).toBeGreaterThan(5.9)
  })

  it.each([false, true])('本地暂停刷新后保留时刻、地图和停止轮询，恢复后继续，停止重播不继承暂停（已接入 %s）', async attached => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    const snapshot = structuredClone(LOCAL_REPLAY)
    snapshot.durationS = 60
    snapshot.tracks[1]!.positions.push({ ...snapshot.tracks[1]!.positions[1]!, time: 60 })
    snapshot.recordCount += 1
    const fileSource = playbackFileSource(snapshot)
    let running: SimulationRun = { ...simulationRun('RUNNING', true), executionSource: 'REMOTE_WS', fileSource,
      scenarioId: fileReceptionScenarioId(fileSource), canonical: { ...simulationRun('RUNNING', true).canonical, processId: null, currentTime: 0 },
      engineControl: { connected: attached, action: null, delivery: 'IDLE' } }
    const fetcher = vi.fn(async (url: string) => successResponse(url.endsWith('/simulations') ? [structuredClone(running)]
      : url.endsWith('/initial-nodes') ? snapshot.initial : snapshot))
    vi.stubGlobal('fetch', fetcher)
    let wrapper = await mountSituationPage(undefined, 'LOCAL')
    vi.spyOn(useSimulationStore(), 'pause').mockResolvedValue(false)
    const frame = { ...adaptEngineFrameSnapshot(engineSample).data!, runId: running.runId, frameId: 5, simulationTime: 5 }
    if (attached) {
      useTelemetryStore().connectionState = 'SUBSCRIBED'
      const quality = useRuntimeQualityStore()
      expect(quality.acceptEngineFrame(quality.epoch, frame)).toBe(true)
    }
    await vi.advanceTimersByTimeAsync(2500)
    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    const pausedAt = useReplayStore().replay!.currentTimeS
    const pausedNodes = structuredClone(mapControllerMock.latestOptions!.initialNodes!)
    expect(pausedAt).toBeGreaterThan(2.4)
    expect(useSimulationStore().run?.engineControl?.action).toBeNull()
    wrapper.unmount(); mountedWrapper = null
    wrapper = await mountSituationPage(undefined, 'LOCAL')
    expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeDefined()
    expect(useReplayStore().replay!.currentTimeS).toBe(pausedAt)
    expect(mapControllerMock.latestOptions!.initialNodes).toEqual(pausedNodes)
    expect(useRuntimeQualityStore().presentationPaused).toBe(true)
    const polls = () => fetcher.mock.calls.filter(([url]) => url.endsWith('/simulations')).length
    const pausedPolls = polls()
    await vi.advanceTimersByTimeAsync(3000)
    expect(polls()).toBe(pausedPolls)
    expect(useReplayStore().replay!.currentTimeS).toBe(pausedAt)
    if (attached) useTelemetryStore().connectionState = 'SUBSCRIBED'
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await vi.advanceTimersByTimeAsync(1000)
    if (attached) {
      expect(useReplayStore().replay!.currentTimeS).toBe(pausedAt)
      const quality = useRuntimeQualityStore()
      expect(quality.acceptEngineFrame(quality.epoch, { ...frame, frameId: 10, simulationTime: 10 })).toBe(true)
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(useReplayStore().replay!.currentTimeS).toBeGreaterThan(pausedAt + 0.9)
    expect(useRuntimeQualityStore().presentationPaused).toBe(false)
    expect(sessionStorage.getItem('wrj.situation.paused-file-playback')).toBeNull()
    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    const stop = vi.spyOn(useSimulationStore(), 'stop').mockResolvedValueOnce(false).mockImplementationOnce(async () => {
      useSimulationStore().applyRun({ ...running, uiStatus: 'STOPPED', configLocked: false })
      return true
    })
    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    await flushPromises()
    expect(sessionStorage.getItem('wrj.situation.paused-file-playback')).not.toBeNull()
    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    await flushPromises()
    expect(stop).toHaveBeenCalledTimes(2)
    expect(sessionStorage.getItem('wrj.situation.paused-file-playback')).toBeNull()
    expect(useReplayStore().replay!.currentTimeS).toBe(0)
    wrapper.unmount(); mountedWrapper = null
    running = { ...running, runId: 'RUN-RESTARTED', startedAt: '2026-11-09T12:00:00Z' }
    wrapper = await mountSituationPage(undefined, 'LOCAL')
    expect(useReplayStore().replay!.currentTimeS).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(useReplayStore().replay!.currentTimeS).toBeGreaterThan(0.9)
  })

  it('刷新文件接收任务时在数据源初始化后订阅，初始化清理不会取消有效连接', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    const snapshot = structuredClone(LOCAL_REPLAY)
    snapshot.durationS = 60
    snapshot.tracks[1]!.positions.push({ ...snapshot.tracks[1]!.positions[1]!, time: 60 })
    snapshot.recordCount += 1
    const fileSource = playbackFileSource(snapshot)
    const running: SimulationRun = { ...simulationRun('RUNNING', true), executionSource: 'REMOTE_WS', fileSource,
      scenarioId: fileReceptionScenarioId(fileSource), canonical: { ...simulationRun('RUNNING', true).canonical, processId: null, currentTime: 0 },
      engineControl: { connected: true, action: null, delivery: 'IDLE' } }
    let connect: ReturnType<typeof vi.spyOn> | undefined
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/simulations')) {
        const telemetry = useTelemetryStore()
        connect ??= vi.spyOn(telemetry, 'connect').mockImplementation(() => { telemetry.connectionState = 'SUBSCRIBED' })
        return successResponse([running])
      }
      return successResponse(url.endsWith('/initial-nodes') ? snapshot.initial : snapshot)
    }))
    await mountSituationPage(undefined, 'LOCAL')
    expect(connect).toHaveBeenCalledOnce()
    expect(useTelemetryStore().connectionState).toBe('SUBSCRIBED')
    const quality = useRuntimeQualityStore()
    const frame = { ...adaptEngineFrameSnapshot(engineSample).data!, runId: running.runId, frameId: 5, simulationTime: 5 }
    expect(quality.acceptEngineFrame(quality.epoch, frame)).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(useReplayStore().replay!.currentTimeS).toBeGreaterThan(5.4)
  })

  it.each(['账号', '运行', '文件', '损坏'] as const)('刷新时忽略%s不匹配的本地暂停记录', async change => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    const snapshot = structuredClone(LOCAL_REPLAY)
    const fileSource = playbackFileSource(snapshot)
    let running: SimulationRun = { ...simulationRun('RUNNING', true), executionSource: 'REMOTE_WS', fileSource,
      scenarioId: fileReceptionScenarioId(fileSource), canonical: { ...simulationRun('RUNNING', true).canonical, processId: null, currentTime: 0 },
      engineControl: { connected: false, action: null, delivery: 'IDLE' } }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => successResponse(url.endsWith('/simulations') ? [structuredClone(running)]
      : url.endsWith('/initial-nodes') ? snapshot.initial : snapshot)))
    let wrapper = await mountSituationPage(undefined, 'LOCAL')
    await vi.advanceTimersByTimeAsync(500)
    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    expect(sessionStorage.getItem('wrj.situation.paused-file-playback')).not.toBeNull()
    wrapper.unmount(); mountedWrapper = null
    if (change === '运行') running = { ...running, startedAt: '2026-11-09T12:01:00Z' }
    if (change === '文件') {
      snapshot.sha256 = 'd'.repeat(64)
      running = { ...running, fileSource: playbackFileSource(snapshot), scenarioId: fileReceptionScenarioId(playbackFileSource(snapshot)) }
    }
    if (change === '损坏') sessionStorage.setItem('wrj.situation.paused-file-playback', '{')
    wrapper = await mountSituationPage(undefined, 'LOCAL', change === '账号' ? { ...OPERATOR, userId: 'USR-OTHER' } : OPERATOR)
    expect(sessionStorage.getItem('wrj.situation.paused-file-playback')).toBeNull()
    expect(useRuntimeQualityStore().presentationPaused).toBe(false)
    expect(useReplayStore().replay!.currentTimeS).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(useReplayStore().replay!.currentTimeS).toBeGreaterThan(0.9)
  })

  it('五秒推送之间连续展示，质量保持真实帧，超时和两段连接中断冻结并等待新帧', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    const snapshot = structuredClone(LOCAL_REPLAY)
    snapshot.durationS = 60
    snapshot.tracks[1]!.positions = [{ ...snapshot.tracks[1]!.positions[0]!, time: 0, longitude: 0 },
      { ...snapshot.tracks[1]!.positions[0]!, time: 60, longitude: 60 }]
    const fileSource = playbackFileSource(snapshot)
    const running: SimulationRun = { ...simulationRun('RUNNING', true), executionSource: 'REMOTE_WS', fileSource,
      scenarioId: fileReceptionScenarioId(fileSource), canonical: { ...simulationRun('RUNNING', true).canonical, processId: null },
      engineControl: { connected: true, action: null, delivery: 'IDLE' } }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => successResponse(url.endsWith('/simulations') ? [running]
      : url.endsWith('/initial-nodes') ? snapshot.initial : snapshot)))
    const wrapper = await mountSituationPage(undefined, 'LOCAL')
    const playback = useReplayStore(), quality = useRuntimeQualityStore(), telemetry = useTelemetryStore()
    const frame = { ...adaptEngineFrameSnapshot(engineSample).data!, runId: running.runId, frameId: 0, simulationTime: 0 }
    const push = (frameId: number, time = frameId) => expect(quality.acceptEngineFrame(quality.epoch, { ...frame, frameId, simulationTime: time })).toBe(true)
    push(0)
    expect(playback.replay!.currentTimeS).toBe(0)
    telemetry.connectionState = 'SUBSCRIBED'
    const alarms = JSON.stringify(quality.engineAlarms)
    await vi.advanceTimersByTimeAsync(2500)
    expect(playback.replay!.currentTimeS).toBeGreaterThan(2.4)
    expect(playback.replay!.currentTimeS).toBeLessThanOrEqual(2.5)
    expect(mapControllerMock.latestOptions!.initialNodes![0]!.longitude).toBeCloseTo(playback.replay!.currentTimeS, 6)
    expect(quality.engineFrame?.simulationTime).toBe(0)
    expect(JSON.stringify(quality.engineAlarms)).toBe(alarms)
    await vi.advanceTimersByTimeAsync(2500)
    push(5)
    await vi.advanceTimersByTimeAsync(2500)
    expect(playback.replay!.currentTimeS).toBeGreaterThan(7.4)
    expect(playback.replay!.currentTimeS).toBeLessThanOrEqual(7.5)
    expect(quality.engineFrame?.simulationTime).toBe(5)
    expect(wrapper.find('[data-testid="engine-map-source"]').exists()).toBe(false)
    await wrapper.get('[id$="tab-quality"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="quality-source"]').text()).toContain('实时更新')
    await vi.advanceTimersByTimeAsync(8000)
    const timedOut = playback.replay!.currentTimeS
    expect(timedOut).toBeCloseTo(15)
    expect(wrapper.text()).toContain('数据超时 · 画面冻结')
    expect(wrapper.findComponent(OfflineSituationMap).props()).toMatchObject({ filePlaying: false })
    await vi.advanceTimersByTimeAsync(2000)
    expect(playback.replay!.currentTimeS).toBe(timedOut)
    push(20)
    await vi.advanceTimersByTimeAsync(1000)
    expect(playback.replay!.currentTimeS).toBeGreaterThan(20.9)
    telemetry.engineDiagnostics.push({ kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: running.runId, state: 'DISCONNECTED', message: '测试断线' })
    const disconnected = playback.replay!.currentTimeS
    await vi.advanceTimersByTimeAsync(2000)
    expect(playback.replay!.currentTimeS).toBe(disconnected)
    expect(wrapper.find('[data-testid="engine-map-source"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="quality-source"]').text()).toContain('连接中断')
    expect(wrapper.getComponent({ name: 'LinkQualityDialog' }).props('engineSourceLabel')).toContain('连接中断')
    telemetry.engineDiagnostics.push({ kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: running.runId, state: 'CONNECTED', message: '测试重连' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(playback.replay!.currentTimeS).toBe(disconnected)
    expect(wrapper.find('[data-testid="engine-map-source"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="quality-source"]').text()).toContain('等待更新')
    push(25)
    telemetry.connectionState = 'RETRYING'
    await vi.advanceTimersByTimeAsync(2000)
    expect(playback.replay!.currentTimeS).toBe(25)
    telemetry.connectionState = 'SUBSCRIBED'
    await vi.advanceTimersByTimeAsync(1000)
    expect(playback.replay!.currentTimeS).toBe(25)
    push(30)
    await vi.advanceTimersByTimeAsync(1000)
    expect(playback.replay!.currentTimeS).toBeGreaterThan(30.9)
    expect(wrapper.find('[data-testid="engine-map-source"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="quality-source"]').text()).toContain('实时更新')
    quality.setPresentationPaused(true)
    await flushPromises()
    expect(wrapper.find('[data-testid="engine-map-source"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="quality-source"]').text()).toContain('已暂停')
    await vi.advanceTimersByTimeAsync(20000)
    expect(wrapper.getComponent({ name: 'LinkQualityDialog' }).props('engineSourceLabel')).toBe('暂停展示的引擎数据')
    wrapper.unmount(); mountedWrapper = null
    await vi.advanceTimersByTimeAsync(5000)
    expect(playback.replay).toBeNull()
  })

  it.each(['暂停', '离页'] as const)('%s后在途轮询返回不重新启动定时器', async action => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const fileSource = playbackFileSource(LOCAL_REPLAY)
    const running: SimulationRun = { ...simulationRun('RUNNING', true), executionSource: 'REMOTE_WS',
      canonical: { ...simulationRun('RUNNING', true).canonical, processId: null },
      fileSource, scenarioId: fileReceptionScenarioId(fileSource),
      engineControl: { connected: false, action: null, delivery: 'IDLE' } }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => successResponse(url.endsWith('/simulations') ? [running]
      : url.endsWith('/initial-nodes') ? LOCAL_REPLAY.initial : LOCAL_REPLAY)))
    const wrapper = await mountSituationPage(undefined, 'LOCAL')
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeUndefined()
    let finishPoll!: (value: boolean) => void
    const poll = vi.spyOn(useSimulationStore(), 'synchronizeRuntimeState')
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { finishPoll = resolve }))
      .mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(poll).toHaveBeenCalledOnce()
    if (action === '暂停') await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    else { wrapper.unmount(); mountedWrapper = null }
    finishPoll(true)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3000)
    expect(poll).toHaveBeenCalledOnce()
    if (action === '暂停') {
      await wrapper.get('[data-testid="simulation-start"]').trigger('click')
      await vi.advanceTimersByTimeAsync(1000)
      expect(poll).toHaveBeenCalledTimes(2)
    }
  })

  it('并行启动失败不遗留文件计时器，错误能在页面看见', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const idle = { ...simulationRun('STOPPED', false), executionSource: 'REMOTE_WS' as const }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => successResponse(url.endsWith('/simulations') ? [idle]
      : url.endsWith('/initial-nodes') ? LOCAL_REPLAY.initial : LOCAL_REPLAY)))
    const wrapper = await mountSituationPage(undefined, 'LOCAL')
    vi.spyOn(useSimulationStore(), 'start').mockImplementation(async () => {
      useSimulationStore().$patch({ capabilityState: 'ERROR', resultMessage: '归档服务不可用，启动失败。' })
      return false
    })
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5000)
    expect(useReplayStore().replay?.currentTimeS).toBe(0)
    expect(useReplayStore().state).toBe('PAUSED')
    expect(wrapper.text()).toContain('归档服务不可用，启动失败。')
  })

  it('正在接收的文件更换后禁止串用新轨迹，仍可停止旧接收任务', async () => {
    const fileSource = playbackFileSource(LOCAL_REPLAY)
    const running = { ...simulationRun('RUNNING', true), executionSource: 'REMOTE_WS' as const,
      canonical: { ...simulationRun('RUNNING', true).canonical, processId: null },
      fileSource, scenarioId: fileReceptionScenarioId(fileSource), startedAt: '2026-11-09T01:00:00Z',
      engineControl: { connected: true, action: null, delivery: 'IDLE' as const } }
    const changed = { ...LOCAL_REPLAY, sha256: 'c'.repeat(64) }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => successResponse(url.endsWith('/simulations') ? [running]
      : url.endsWith('/initial-nodes') ? changed.initial : changed)))
    const wrapper = await mountSituationPage(undefined, 'LOCAL')
    expect(wrapper.text()).toContain('当前文件已变更')
    expect(wrapper.findComponent(OfflineSituationMap).props()).toMatchObject({ initialNodes: [], fileLinks: [], fileMessageLinks: [] })
    expect(wrapper.get('[data-testid="simulation-stop"]').attributes('disabled')).toBeUndefined()
    expect(useRuntimeQualityStore().scope).toBeNull()
    expect(useReplayStore().state).toBe('PAUSED')
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
    expect(wrapper.text()).toContain('46分46.44秒')
    wrapper.findComponent({ name: 'ElSlider' }).vm.$emit('change', 0)
    await flushPromises()
    expect(mapControllerMock.controller.setFileDeviceStates).toHaveBeenLastCalledWith([])
    // 退回 0 秒后业务链路消失，登记关联自动恢复兜底。
    expect(mapControllerMock.controller.setFileMessageLinks).toHaveBeenLastCalledWith([])
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('potential', true)
    expect(mapControllerMock.controller.setNodes).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ platformId: 'A', longitude: -77 })]))
    await wrapper.get('[aria-label="文件回放倍速"]').setValue('4')
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
    expect(panel.get('.link-table td:last-child').text()).toBe('关闭')

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
    expect(detail.includes('44.448 公里（示意范围，缺少设备配置）')).toBe(hasRange)
    expect(detail).not.toContain('活动干扰')
    if (hasRange) {
      await button.trigger('click')
      expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('interference', false)
    }
  })

  it('节点类型图例列出真实文件中出现的全部类型，未识别类型归入其他节点', () => {
    const types = ['REAR_COMM_PLATFORM', 'COMMAND_VEHICLE_PLATFORM', 'TIAN_TONG_SAT', 'SHEN_TONG_SAT', 'MISSION_UAV_PLATFORM',
      'GROUND_JAMMER_STATION', 'AIRBORNE_JAMMER_PLATFORM', 'SOMETHING_NEW']
    const nodes = types.map((type, index) => ({ ...INITIAL_NODES.nodes[0]!, platformId: `N-${index}`, name: `节点${index}`, type }))
    const wrapper = mount(OfflineSituationMap, {
      props: { frame: null, initialNodes: nodes, fileDeviceEvents: [], fileTime: 0, links: [], selectedNodeId: '', focusTarget: null },
      global: { plugins: [ElementPlus] }, attachTo: document.body,
    })
    mountedWrapper = wrapper
    const items = wrapper.get('[data-testid="node-type-legend"]').findAll(':scope > div').map(item => item.text())
    expect(items).toEqual(['公共服务平台后方节点', '无人集群指挥车节点', '天通卫星', '神通卫星', '无人机集群', '地面干扰设备', '机载干扰设备', '○其他节点'])
    expect(wrapper.get('[data-testid="node-type-legend"]').findAll('img').map(image => image.attributes('src')))
      .toEqual(nodes.slice(0, 7).map(node => nodeIconUrl(node)))
  })

  it.each(['jammer_station_01', 'jammer_airborne_01', 'UNKNOWN'])('文件节点 %s 的指定探测范围独立于干扰事件，详情显示 50 公里且可单独开关', async (id) => {
    const nodes = [{ ...INITIAL_NODES.nodes[0]!, platformId: id, name: '地面干扰站01' }]
    const wrapper = mount(OfflineSituationMap, {
      props: { frame: null, initialNodes: nodes, fileDeviceEvents: [], fileTime: 0, links: [], selectedNodeId: id, focusTarget: null },
      global: { plugins: [ElementPlus] }, attachTo: document.body,
    })
    mountedWrapper = wrapper
    const button = wrapper.findAll('[aria-label="态势图层"] button').find(b => b.text() === '探测范围')!
    expect(button.attributes('disabled') !== undefined).toBe(id === 'UNKNOWN')
    expect(wrapper.find('.legend-line--detection').exists()).toBe(id !== 'UNKNOWN')
    mapControllerMock.latestOptions?.onSelectNode(id)
    await flushPromises()
    const detail = document.querySelector('[data-testid="selected-node-dialog"]')!.textContent!
    expect(detail.includes('探测范围（半径）50 公里（指定范围）')).toBe(id !== 'UNKNOWN')
    expect(detail).not.toContain('干扰范围（半径）')
    if (id !== 'UNKNOWN') {
      expect(button.attributes('aria-pressed')).toBe('true')
      await button.trigger('click')
      expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('detection', false)
      await button.trigger('click')
      expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('detection', true)
    }
    await mountedWrapper.setProps({ configuredLinks: [] })
    expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.legend-line--detection').exists()).toBe(false)
  })

  it('场景与仿真模式下地面干扰站和机载干扰平台启用探测范围图层、图例及详情展示', async () => {
    const groundNode: SituationMapNode = {
      ...INITIAL_NODES.nodes[0]!, platformId: 'jammer_station_01', name: '地面干扰站',
      type: 'GROUND_JAMMER_DETECTION_STATION', longitude: 121.55, latitude: 25.15, altitude: 0, speed: 0,
    }
    const airborneNode: SituationMapNode = {
      ...INITIAL_NODES.nodes[1]!, platformId: 'jammer_airborne_01', name: '机载干扰平台',
      type: 'AIRBORNE_JAMMER_PLATFORM', longitude: 121.56, latitude: 25.0345, altitude: 3000, speed: 0,
    }
    const jammers = [
      { id: 'ground_jammer', platformId: groundNode.platformId, jammingRange: 44448, detectionRange: 55560 },
      { id: 'airborne_jammer', platformId: airborneNode.platformId, jammingRange: 30000, detectionRange: 65000 },
    ]
    const wrapper = mount(OfflineSituationMap, {
      props: {
        frame: null, initialNodes: [groundNode, airborneNode], configuredLinks: [], configuredJammers: jammers,
        links: [], selectedNodeId: groundNode.platformId, focusTarget: null,
      },
      global: { plugins: [ElementPlus] }, attachTo: document.body,
    })
    mountedWrapper = wrapper

    const button = wrapper.findAll('[aria-label="态势图层"] button').find(b => b.text() === '探测范围')!
    expect(button.attributes('disabled')).toBeUndefined()
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('.legend-line--detection').exists()).toBe(true)

    mapControllerMock.latestOptions?.onSelectNode(groundNode.platformId)
    await flushPromises()
    const groundText = document.querySelector('[data-testid="selected-node-dialog"]')!.textContent!
    expect(groundText).toContain('探测范围（半径）55.56 公里（配置范围，非实测覆盖）')
    expect(groundText).not.toContain('ground_jammer')

    mapControllerMock.latestOptions?.onSelectNode(airborneNode.platformId)
    await wrapper.setProps({ selectedNodeId: airborneNode.platformId } as never)
    await flushPromises()
    const airborneText = document.querySelector('[data-testid="selected-node-dialog"]')!.textContent!
    expect(airborneText).toContain('探测范围（半径）65 公里（配置范围，非实测覆盖）')
    expect(airborneText).not.toContain('airborne_jammer')

    const engineFrame = adaptEngineFrameSnapshot(jammerSample).data!
    await wrapper.setProps({ selectedNodeId: groundNode.platformId, engineFrame } as never)
    mapControllerMock.latestOptions?.onSelectNode(groundNode.platformId)
    await flushPromises()
    const engineGroundText = document.querySelector('[data-testid="selected-node-dialog"]')!.textContent!
    expect(engineGroundText).toContain('探测范围（半径）22.224 公里（引擎报告范围）')
    expect(engineGroundText).not.toContain('ground_jammer')

    await button.trigger('click')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('detection', false)
    await button.trigger('click')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('detection', true)

    await wrapper.setProps({
      selectedNodeId: airborneNode.platformId,
      engineFrame: null,
      configuredJammers: [{ id: 'airborne_jammer', platformId: airborneNode.platformId, jammingRange: 30000 }],
    } as never)
    mapControllerMock.latestOptions?.onSelectNode(airborneNode.platformId)
    await flushPromises()
    const fallbackAirborneText = document.querySelector('[data-testid="selected-node-dialog"]')!.textContent!
    expect(fallbackAirborneText).toContain('探测范围（半径）48.52 公里（默认范围（干扰范围 + 10 海里））')
    expect(fallbackAirborneText).not.toContain('airborne_jammer')
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
      expect(animated.find('[data-testid="more-layers-menu"]').exists()).toBe(false)
      expect(mapControllerMock.controller.setLayerVisible).not.toHaveBeenCalledWith('flow', false)
      await animated.get('[data-testid="more-layers-toggle"]').trigger('click')
      const animatedButton = animated.findAll('[data-testid="more-layers-menu"] button').find(b => b.text() === '流向动画')!
      expect(animatedButton.text()).toBe('流向动画')
      expect(animatedButton.attributes('aria-pressed')).toBe('true')
      animated.unmount()

      // 要求减少动效：按钮默认关闭，并且必须把关闭状态同步给控制器，否则按钮与实际图层不一致。
      const reduced = await mountWith(true)
      expect(mapControllerMock.controller.setLayerVisible).toHaveBeenCalledWith('flow', false)
      await reduced.get('[data-testid="more-layers-toggle"]').trigger('click')
      const reducedButton = reduced.findAll('[data-testid="more-layers-menu"] button').find(b => b.text() === '流向动画')!
      expect(reducedButton.attributes('aria-pressed')).toBe('false')
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
    expect(component).toMatch(/animation-iteration-count:\s*1;/)
    expect(component).toMatch(/animation-fill-mode:\s*both;/)
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

  it('文件播放时钟携带暂停、倍速和定位版本，消息先更新再驱动脉冲', async () => {
    mountedWrapper = mount(OfflineSituationMap, {
      props: { frame: null, initialNodes: SATELLITE_FILE_NODES, fileMessageLinks: [MESSAGE_LINK],
        fileTime: 0, filePlaying: false, fileSpeed: 1, sourceKey: 'source-a',
        links: [], selectedNodeId: '', focusTarget: null },
      global: { plugins: [ElementPlus] },
    })
    expect(mapControllerMock.controller.setFilePlayback).toHaveBeenLastCalledWith({
      time: 0, playing: false, speed: 1, key: 'source-a:0',
    }, [MESSAGE_LINK])
    await mountedWrapper.setProps({ fileTime: 2, filePlaying: true, fileSpeed: 2 })
    expect(mapControllerMock.controller.setFilePlayback).toHaveBeenLastCalledWith({
      time: 2, playing: true, speed: 2, key: 'source-a:0',
    }, [MESSAGE_LINK])
    expect(mapControllerMock.controller.setFileMessageLinks.mock.invocationCallOrder.at(-1))
      .toBeLessThan(mapControllerMock.controller.setFilePlayback.mock.invocationCallOrder.at(-1)!)
    await mountedWrapper.setProps({ filePlaying: false })
    expect(mapControllerMock.controller.setFilePlayback).toHaveBeenLastCalledWith(expect.objectContaining({ playing: false }), [MESSAGE_LINK])
    await mountedWrapper.setProps({ fileTime: 2000, fileSeekRevision: 1 })
    expect(mapControllerMock.controller.setFilePlayback).toHaveBeenLastCalledWith(expect.objectContaining({ time: 2000, key: 'source-a:1' }), [MESSAGE_LINK])
    await mountedWrapper.setProps({ sourceKey: 'source-b' })
    expect(mapControllerMock.controller.setFilePlayback).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'source-b:1' }), [MESSAGE_LINK])
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
    expect(text).not.toContain('不提供 SNR、BER、丢包率')
    expect(document.querySelector('[data-testid="message-link-details"] .selected-node-dialog__notice')).toBeNull()
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
    expect(association()).toContain('已开启')
    expect(association()).toContain('未知')
    expect(association()).not.toContain('LOG-L20')
    ;(document.querySelector('[data-testid="file-link-details"] .el-table__expand-icon') as HTMLElement).click()
    await flushPromises()
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
    expect(association()).not.toContain('登记关联，不代表当前正在传输')
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
    expect(association()).toContain('已开启 · 0 秒 · LOG-L1')
    expect(association()).not.toContain('已关闭 · 2301.17 秒 · LOG-L2')
    expect(details()).not.toContain('干扰请求进行中')
    await wrapper.setProps({ fileDeviceEvents: [] })
    await flushPromises()
    expect(details()).toContain('设备事件：暂无数据')
    expect(association()).not.toContain('已开启')
    expect(association()).toContain('启停未知（无对应事件）')
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
    expect(details?.querySelector('.selected-node-dialog__notice')).toBeNull()
    expect(details?.querySelector('thead')?.textContent).toBe('详情源节点目标节点通信类型源端设备目标端设备')
    const row = details?.querySelector('.el-table__body tbody tr')
    expect(row?.textContent).toContain(sourceName)
    expect(row?.textContent).toContain(targetName)
    expect(row?.textContent).toContain('卫星通信')
    expect(row?.textContent).toContain('未知')
    expect(row?.textContent).not.toMatch(/sat-a|sat-b|satcom_1|0\.1\.0\.[12]|LOG-L20|（A）|（B）/)
    expect(details?.querySelector('[data-testid="file-association-evidence"]')).toBeNull()
    ;(row?.querySelector('.el-table__expand-icon') as HTMLElement).click()
    await flushPromises()
    const evidence = details?.querySelector('[data-testid="file-association-evidence"]')
    expect(evidence?.textContent).toContain('源节点编号A')
    expect(evidence?.textContent).toContain('目标节点编号B')
    expect(evidence?.textContent).toContain('sat-a')
    expect(evidence?.textContent).toContain('sat-b')
    expect(evidence?.textContent).toContain('0.1.0.1')
    expect(evidence?.textContent).toContain('0.1.0.2')
    expect(evidence?.textContent).toContain('登记时间（秒）0')
    expect(initial.nodes.map(node => node.platformId)).toEqual(['A', 'B'])
    expect(details?.textContent).toContain('卫星通信')
    expect(details?.textContent).toContain('启停未知')
    expect(details?.textContent).toContain('satcom_1')
    expect(details?.textContent).toContain('LOG-L20')
    expect(details?.textContent).not.toMatch(/正常|劣化|中断/)
    ;(row?.querySelector('.el-table__expand-icon') as HTMLElement).click()
    await flushPromises()
    expect(details?.querySelector('[data-testid="file-association-evidence"]')).toBeNull()
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
    expect(wrapper.get('.simulation-toolbar__title').text()).toContain('当前场景：选择的场景 B')
    expect(wrapper.find('.scenario-selection').exists()).toBe(false)
    expect(wrapper.find('[data-testid="situation-scene-select"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('用于态势与 Mock 运行的场景')
    const summary = wrapper.get('.scene-summary')
    const nodeButton = summary.get(`[data-testid="focus-node-${config.platforms[0]!.id}"]`)
    expect(Array.from(nodeButton.element.children).map(element => element.tagName)).toEqual(['SPAN', 'SMALL'])
    expect(nodeButton.get('span').text()).toBe('场景 B 指挥节点')
    expect(nodeButton.get('small').text()).toBe('公共服务平台后方节点C1')
    expect(nodeButton.text()).not.toContain(config.platforms[0]!.id)
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
    const mwLink = config.links.find(link => link.id === 'L-MW-01')!
    const linkButton = summary.get('[data-testid="focus-link-L-MW-01"]')
    expect(Array.from(linkButton.element.children).map(element => element.tagName)).toEqual(['SPAN', 'SMALL'])
    expect(linkButton.get('span').text()).toBe('高空前出中继节点 → 场景 B 指挥节点')
    expect(linkButton.get('small').text()).toBe(`微波链路 · ${mwLink.direction === 'FORWARD' ? '前向' : '返向'}`)
    expect(mapControllerMock.latestOptions!.configuredJammers).toEqual(scene.config.jammers)
    expect(mapControllerMock.latestOptions!.configuredLinks).toEqual([])
    await summary.get('[data-testid="focus-link-L-MW-01"]').trigger('click')
    expect(mapControllerMock.controller.focusTarget).toHaveBeenLastCalledWith({ kind: 'link', targetId: 'L-MW-01' })
    mapControllerMock.controller.focusTarget.mockClear()
    await wrapper.get('tr[data-link-id="L-MW-01"]').trigger('click')
    expect(mapControllerMock.controller.focusTarget).toHaveBeenCalledWith({ kind: 'link', targetId: 'L-MW-01' })
    await flushPromises()
    expect(document.querySelector('[data-testid="link-detail-configured"]')).toBeNull()
    await wrapper.get('tr[data-link-id="L-MW-01"]').trigger('dblclick')
    await flushPromises()
    const detail = document.querySelector('[data-testid="link-detail-configured"]')
    expect(detail?.textContent).not.toContain('尚无当前运行结果')
    expect(detail?.querySelector('.link-quality-dialog__notice')).toBeNull()
    expect(detail?.textContent).toContain(`${mwLink.frequency} MHz`)
    expect(detail?.textContent).toContain('规范状态暂无数据')
    expect(detail?.textContent).not.toMatch(/固定帧|正常|劣化|中断/)
    const telemetryPanel = wrapper.get('.telemetry-panel')
    expect(telemetryPanel.findAll('.panel-heading strong').map(item => item.text())).toEqual(['全链路状态', '同帧事件', '干扰 / 侦测设备'])
    expect(telemetryPanel.findAll('th').map(item => item.text())).toEqual(['链路', '体制', '状态'])
    expect(telemetryPanel.findAll('tr[data-link-id]')).toHaveLength(config.links.length)
    const linkRow = telemetryPanel.get('tr[data-link-id="L-MW-01"]')
    expect(linkRow.get('td:last-child').text()).toBe('关闭')
    expect(telemetryPanel.find('.link-state-badge').exists()).toBe(false)
    expect(telemetryPanel.find('[data-testid="open-link-candidates"]').exists()).toBe(false)
    expect(telemetryPanel.get('.telemetry-section--links .panel-heading').text()).toBe('全链路状态')
    await linkRow.trigger('dblclick')
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
    expect(telemetryPanel.find('.telemetry-section--events .telemetry-empty-state').text()).toBe('暂无数据')
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
    expect(document.querySelector('[data-testid="confirm-stop"]')).toBeNull()
    expect(useSimulationStore().uiStatus).toBe('STOPPED')
    expect(useSimulationStore().run?.configLocked).toBe(false)
    expect(JSON.stringify(useSimulationStore().selectedScene?.config)).toBe(savedConfig)
    expect(wrapper.find('[data-testid="saved-scene-preview"]').exists()).toBe(true)
    expect(fetcher.mock.calls.filter(([url]) => /frames|events|initial-nodes|positions/.test(url))).toHaveLength(telemetryCalls)
  })

  it('已选场景存在中继链路时在链路表和配置详情弹框展示中继节点', async () => {
    const config = structuredClone(fixtureSource.scenario)
    config.scenario.id = 'SCN-REL'
    const scene = {
      config,
      revision: 3,
      officialLibraryChanged: false,
      locked: false,
      uiExtensions: {
        jammers: config.jammers.map(item => ({ jammerId: item.id, direction: 360, duration: 60, enabled: true })),
        sensors: config.sensors.map(item => ({ sensorId: item.id, type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true })),
      },
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/situation/initial-nodes')) return successResponse(null)
      if (url.endsWith('/scenarios')) return successResponse([scene])
      if (url.endsWith('/scenarios/SCN-REL')) return successResponse(scene)
      return successResponse([])
    }))
    const wrapper = await mountSituationPage('SCN-REL')
    const telemetryPanel = wrapper.get('.telemetry-panel')
    expect(telemetryPanel.get('tr[data-link-id="L-SAT-02"] td').text()).toBe('后方指挥节点→通信卫星→高空前出中继节点')
    expect(telemetryPanel.get('tr[data-link-id="L-MW-01"] td').text()).toBe('高空前出中继节点→后方指挥节点')

    const satRelayLink = config.links.find(link => link.id === 'L-SAT-02')!
    const directLink = config.links.find(link => link.id === 'L-MW-01')!
    mapControllerMock.latestOptions!.onSelectConfiguredLink!(satRelayLink as Link)
    await flushPromises()
    let detail = document.querySelector('[data-testid="link-detail-configured"]')
    expect(detail?.textContent).toContain('后方指挥节点 → 通信卫星 → 高空前出中继节点')
    expect([...detail!.querySelectorAll('div')].map(div => [div.querySelector('dt')?.textContent, div.querySelector('dd')?.textContent]))
      .toContainEqual(['中继节点', '通信卫星'])

    mapControllerMock.latestOptions!.onSelectConfiguredLink!(directLink as Link)
    await flushPromises()
    detail = document.querySelector('[data-testid="link-detail-configured"]')
    expect(detail?.textContent).toContain('高空前出中继节点 → 后方指挥节点')
    expect([...detail!.querySelectorAll('div')].map(div => [div.querySelector('dt')?.textContent, div.querySelector('dd')?.textContent]))
      .toContainEqual(['中继节点', '不经中继'])

    const forward = directLink as Link
    const reverse: Link = { ...forward, id: 'L-MW-RETURN', direction: 'REVERSE',
      sourcePlatformId: forward.targetPlatformId, targetPlatformId: forward.sourcePlatformId }
    useSimulationStore().selectedScene!.config.links.push(reverse)
    mapControllerMock.latestOptions!.onSelectConfiguredLink!(forward, reverse)
    await flushPromises()
    const directions = document.querySelector('[data-testid="link-detail-directions"]')
    expect(directions?.textContent).toContain('前向')
    expect(directions?.textContent).toContain('返向')
    expect(directions?.querySelector<HTMLInputElement>(`input[value="${forward.id}"]`)?.checked).toBe(true)
    directions!.querySelector<HTMLInputElement>(`input[value="${reverse.id}"]`)!.click()
    await flushPromises()
    expect(document.querySelector('.link-quality-dialog__header strong')?.getAttribute('title')).toBe(reverse.id)
    expect(document.querySelector('[data-testid="link-detail-configured"]')?.textContent).toContain('后方指挥节点 → 高空前出中继节点')
    mapControllerMock.latestOptions!.onSelectConfiguredLink!(forward)
    await flushPromises()
    expect(document.querySelector('[data-testid="link-detail-directions"]')).toBeNull()
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
    await wrapper.get('[aria-label="切换为浅色地图"]').trigger('click')
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
    expect(wrapper.find('[aria-label="切换为深色地图"]').exists()).toBe(true)
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
    expect(document.querySelector('[data-testid="confirm-stop"]')).toBeNull()

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

  it('遥测链路中断时只从地图移除，恢复正常后重新显示，状态列表始终保留', async () => {
    const wrapper = await mountSituationPage()
    const frame = structuredClone(SITUATION_FRAME_F00042)
    const link = frame.uiLinks[0]!
    link.status = 'DOWN'
    useTelemetryStore().$patch({ frame })
    await flushPromises()
    const mapLinks = () => mapControllerMock.controller.setLinks.mock.lastCall?.[0] as SituationLinkView[]
    expect(mapLinks().some(item => item.linkId === link.linkId)).toBe(false)
    expect(wrapper.get(`tr[data-link-id="${link.linkId}"]`).text()).toContain('中断')
    link.status = 'UP'
    useTelemetryStore().$patch({ frame: structuredClone(frame) })
    await flushPromises()
    expect(mapLinks().some(item => item.linkId === link.linkId)).toBe(true)
  })

  it('从左侧摘要重复定位节点、链路和干扰设备并恢复对应图层', async () => {
    const wrapper = await mountSituationPage()
    const layerButtons = wrapper.findAll('[aria-label="态势图层"] button')
    // 本用例统计用户图层交互，不包含加载期空底图的初始化。
    mapControllerMock.controller.setLayerVisible.mockClear()
    mapControllerMock.controller.setSelectedNodeId.mockClear()

    const uavSummaryButton = wrapper.get('[data-testid="focus-node-UAV-01"]')
    expect(uavSummaryButton.get('span').text()).toBe('高空前出中继节点')
    expect(uavSummaryButton.get('small').text()).toBe('公共服务平台前出节点R1')
    expect(uavSummaryButton.text()).not.toContain('UAV-01')
    const satSummaryButton = wrapper.get('[data-testid="focus-node-SAT-01"]')
    expect(satSummaryButton.get('span').text()).toBe('通信卫星')
    expect(satSummaryButton.get('small').text()).toBe('通信卫星S1')

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
    expect(document.querySelector('.link-quality-dialog')).toBeNull()
    await wrapper.get('tr[data-link-id="L-DL-03"]').trigger('dblclick')
    await flushPromises()
    expect(document.body.textContent).toContain('界面状态劣化')
    expect(document.body.textContent).toContain('规范状态中断')
    expect(document.body.textContent).toContain('阈值版本LLZT-1.0')
    expect(document.body.textContent).toContain('稳定帧数3')
    expect(document.body.textContent).toContain('判定依据误码率超过阈值并满足稳定帧条件')
    expect(document.body.textContent).not.toContain('接收功率')
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
    expect(document.body.textContent).toContain('误码率(BER)1.2e-4')

    const closeButton = document.querySelector<HTMLElement>('.el-dialog__headerbtn')
    closeButton?.click()
    await flushPromises()
    await wrapper.get('tr[data-link-id="L-SAT-02"]').trigger('dblclick')
    await flushPromises()
    expect(document.body.textContent).not.toContain('当前帧仅提供摘要')
    expect(document.querySelector('.link-quality-dialog__notice')).toBeNull()
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
      && summary.destPlatform === 'CMD-01'
      && summary.linkType === 'MICROWAVE'
    ))
    if (target === undefined) throw new Error('测试固定帧缺少 L-MW-01 链路摘要')
    target.status = 'DOWN'

    expect(telemetry.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: 'TASK-001', sequence: 1,
      simulationTime: 42, frameId: 'F-00042', payload: updatedSummaries,
    })).toBe(true)
    await wrapper.get('tr[data-link-id="L-MW-01"]').trigger('dblclick')
    await flushPromises()

    expect(document.body.textContent).toContain('规范状态中断')
  })

  it('所选链路从当前帧消失时显示缺失态且不回显历史数据', async () => {
    const wrapper = await mountSituationPage()
    await wrapper.get('tr[data-link-id="L-DL-03"]').trigger('dblclick')
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
    await wrapper.get('tr[data-link-id="L-DL-03"]').trigger('dblclick')
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
    } else {
      expect(text).toContain('地图临时示意位置120.82767°E / 26.018571°N')
      expect(text).not.toContain('二维地图按卫星')
    }
    expect(JSON.stringify(frame)).toBe(original)
  })

  it('WS位置和范围进入节点详情及控制器，轨迹可关闭且换运行清理', async () => {
    const frame = adaptEngineFrameSnapshot(jammerSample).data!
    const jammer = frame.jammers[0]!
    const nodes = [{ ...INITIAL_NODES.nodes[0]!, platformId: jammer.platformId!, type: 'GROUND' }]
    mountedWrapper = mount(OfflineSituationMap, {
      props: { frame: null, engineFrame: frame, engineSourceLabel: '历史引擎数据',
        trailSourceKey: 'run-a', initialNodes: nodes, configuredJammers: [{ id: 'J-1', platformId: jammer.platformId!, jammingRange: 1000 }],
        links: [], selectedNodeId: jammer.platformId!, focusTarget: null },
      attachTo: document.body, global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    expect(mountedWrapper.get('[data-testid="engine-map-source"]').text()).toBe(`历史引擎数据 · 帧 ${frame.frameId}`)
    mapControllerMock.latestOptions!.onSelectNode(jammer.platformId!)
    await flushPromises()
    expect(document.querySelector('[data-testid="selected-node-dialog"]')!.textContent).toContain('引擎位置121.55°E / 25.15°N')
    expect(document.querySelector('[data-testid="selected-node-dialog"]')!.textContent).toContain('位置数据来源历史引擎数据')
    expect(document.querySelector('[data-testid="selected-node-dialog"]')!.textContent).toContain(`位置来源帧${frame.frameId}`)
    expect(document.querySelector('[data-testid="configured-jammer-range"]')!.textContent).toContain('18.52 公里（引擎报告范围）')
    const next = { ...frame, frameId: frame.frameId + 5, simulationTime: frame.simulationTime + 5,
      jammers: [{ ...jammer, rangeM: 20000, position: { longitude: 121.6, latitude: 25.2, altitudeM: 0 } }] }
    await mountedWrapper.setProps({ engineFrame: next })
    expect(mapControllerMock.controller.setEngineFrame).toHaveBeenLastCalledWith(next)
    expect(mapControllerMock.controller.setNodeTrails.mock.calls.at(-1)![0][0].points).toHaveLength(2)
    expect(document.querySelector('[data-testid="configured-jammer-range"]')!.textContent).toContain('20 公里')
    const toggle = mountedWrapper.findAll('[aria-label="态势图层"] button').find(button => button.text() === '运动轨迹')!
    expect(toggle.attributes('aria-pressed')).toBe('false')
    expect(toggle.classes()).not.toContain('active')
    await toggle.trigger('click')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('trails', true)
    expect(toggle.attributes('aria-pressed')).toBe('true')
    await mountedWrapper.setProps({ trailSourceKey: 'run-b' })
    expect(mapControllerMock.controller.setNodeTrails).toHaveBeenLastCalledWith([])
    expect(toggle.attributes('aria-pressed')).toBe('true')
    await toggle.trigger('click')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('trails', false)
    expect(toggle.attributes('aria-pressed')).toBe('false')
    await mountedWrapper.setProps({ engineFrame: { ...next, simulationTime: next.simulationTime + 5,
      jammers: [{ ...jammer, position: { longitude: 121.8, latitude: 25.4, altitudeM: 0 } }] } })
    expect(mapControllerMock.controller.setNodeTrails.mock.calls.at(-1)![0][0].points).toHaveLength(2)
    await mountedWrapper.setProps({ engineFrame: { ...next, runId: 'another-engine-run', simulationTime: next.simulationTime + 10 } })
    expect(mapControllerMock.controller.setNodeTrails).toHaveBeenLastCalledWith([])
  })

  it('通过 Leaflet 控制器同步图层、视图、选择和销毁', async () => {
    const wrapper = await mountSituationPage()
    const options = mapControllerMock.latestOptions

    expect(options).not.toBeNull()
    const layerbar = wrapper.get('[aria-label="态势图层"]')
    const layerButtons = layerbar.findAll('button')
    expect(layerButtons).toHaveLength(6)
    expect(layerButtons.map((button) => button.text())).toEqual(['节点', '链路', '干扰范围', '探测范围', '运动轨迹', '更多图层'])
    const trailsButton = layerButtons[4]!
    expect(trailsButton.attributes('aria-pressed')).toBe('false')
    expect(trailsButton.classes()).not.toContain('active')
    const moreButton = layerbar.get('[data-testid="more-layers-toggle"]')
    expect(moreButton.attributes('aria-expanded')).toBe('false')
    expect(layerbar.find('[data-testid="more-layers-menu"]').exists()).toBe(false)
    await moreButton.trigger('click')
    expect(moreButton.attributes('aria-expanded')).toBe('true')
    const moreButtons = layerbar.findAll('[data-testid="more-layers-menu"] button')
    expect(moreButtons.map((button) => button.text())).toEqual(['经纬网', '流向动画'])
    const gridButton = moreButtons[0]!
    expect(gridButton.attributes('aria-pressed')).toBe('false')
    expect(gridButton.classes()).not.toContain('active')
    await gridButton.trigger('click')
    expect(gridButton.attributes('aria-pressed')).toBe('true')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('grid', true)
    await gridButton.trigger('click')
    expect(gridButton.attributes('aria-pressed')).toBe('false')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenLastCalledWith('grid', false)
    // 点击更多图层外部关闭弹窗，再打开后按 Escape 关闭
    document.body.click()
    await flushPromises()
    expect(moreButton.attributes('aria-expanded')).toBe('false')
    expect(layerbar.find('[data-testid="more-layers-menu"]').exists()).toBe(false)
    await moreButton.trigger('click')
    expect(layerbar.find('[data-testid="more-layers-menu"]').exists()).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(moreButton.attributes('aria-expanded')).toBe('false')
    expect(layerbar.find('[data-testid="more-layers-menu"]').exists()).toBe(false)
    expect(layerbar.get('span').text()).toBe('离线矢量 · Z10')
    await layerButtons[0].trigger('click')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenCalledWith('nodes', false)

    const viewControls = wrapper.get('[aria-label="态势图视图控制"]')
    const viewButtons = viewControls.findAll('button')
    expect(viewButtons).toHaveLength(6)
    expect(viewButtons.map((button) => button.text())).toEqual(['', '', '＋', '－', '', ''])
    expect(viewButtons.map((button) => button.attributes('title'))).toEqual([
      '切换为浅色地图',
      '切换为卫星底图',
      '放大态势图',
      '缩小态势图',
      '重置视图',
      '全屏放大',
    ])

    const mapSection = wrapper.get('[aria-label="Leaflet 离线态势图"]')
    const pageRoot = wrapper.get('.situation-page')
    const fullscreenToggle = viewControls.get('[data-testid="map-fullscreen-toggle"]')
    expect(fullscreenToggle.attributes('aria-pressed')).toBe('false')
    await fullscreenToggle.trigger('click')
    expect(fullscreenToggle.attributes('aria-pressed')).toBe('true')
    expect(pageRoot.classes()).toContain('situation-page--map-fullscreen')
    await fullscreenToggle.trigger('click')
    expect(fullscreenToggle.attributes('aria-pressed')).toBe('false')
    expect(pageRoot.classes()).not.toContain('situation-page--map-fullscreen')
    const themeButton = wrapper.get('[aria-label="切换为浅色地图"]')
    const basemapButton = wrapper.get('[aria-label="切换为卫星底图"]')
    const resetButton = wrapper.get('[aria-label="重置视图"]')
    expect(mapSection.attributes('data-map-theme')).toBe('dark')
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
    expect(mapControllerMock.controller.setTheme).toHaveBeenNthCalledWith(1, 'light')
    expect(mapSection.attributes('data-map-theme')).toBe('light')
    const lightThemeButton = wrapper.get('[aria-label="切换为深色地图"]')
    expect(lightThemeButton.attributes('title')).toBe('切换为深色地图')
    expect(lightThemeButton.attributes('title')).toBe(lightThemeButton.attributes('aria-label'))
    expect(lightThemeButton.text()).toBe('')
    expect(lightThemeButton.find('svg').exists()).toBe(true)

    await wrapper.get('[aria-label="切换为深色地图"]').trigger('click')
    expect(mapControllerMock.controller.setTheme).toHaveBeenNthCalledWith(2, 'dark')
    expect(mapSection.attributes('data-map-theme')).toBe('dark')
    const darkThemeButton = wrapper.get('[aria-label="切换为浅色地图"]')
    expect(darkThemeButton.attributes('title')).toBe('切换为浅色地图')
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
    expect(satelliteDialog?.querySelector('.selected-node-dialog__notice')).toBeNull()
    expect(satelliteDialog?.style.getPropertyValue('--el-dialog-margin-top')).toBe('5vh')

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

  it('同作用域刷新及链路重排保留质量上下文，重复链路ID仍拒绝激活', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    const run = { ...simulationRun('COMPLETED', false), startedAt: '2026-10-31T01:00:00Z' }
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/simulations')) return successResponse([run])
      if (url.endsWith('/positions')) return successResponse({ runId: run.runId, scenarioId: run.scenarioId, revision: scene.revision, positions: null })
      if (url.endsWith('/scenarios/SCN-001')) return successResponse(scene)
      if (url.includes('/quality')) return successResponse(null)
      return successResponse([])
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = await mountSituationPage('SCN-001', 'LOCAL')
    await wrapper.get('.telemetry-panel').findAll('.el-tabs__item').find(tab => tab.text() === '质量指标')!.trigger('click')
    useSimulationStore().$patch({ run })
    await flushPromises()
    const qualityStore = useRuntimeQualityStore()
    const epochBefore = qualityStore.epoch
    // 1) 同作用域真实刷新（新对象、同五字段与同链路集合）→ epoch 不变
    const before = useSimulationStore().selectedScene!
    expect(await useSimulationStore().selectScene(before.config.scenario.id)).toBe(true)
    await flushPromises()
    expect(qualityStore.epoch).toBe(epochBefore)
    // 2) 纯链路重排（顺序变化、集合相同）→ epoch 不变
    const reordered = { ...before, config: { ...before.config, links: [...before.config.links].reverse() } }
    useSimulationStore().selectedScene = reordered
    await flushPromises()
    expect(qualityStore.epoch).toBe(epochBefore)
    // 3) 新增重复链路ID → activate 既有拒绝（scope 置空、epoch 递增）
    const duplicateLinks = [...reordered.config.links, reordered.config.links[0]!]
    useSimulationStore().selectedScene = { ...reordered, config: { ...reordered.config, links: duplicateLinks } }
    await flushPromises()
    expect(useRuntimeQualityStore().scope).toBeNull()
    expect(useRuntimeQualityStore().epoch).toBeGreaterThan(epochBefore)
  })

  it('未接入真实报文流向时流向动画开关不可操作；接入实时配对增量后可开关、暂停冻结并展示详情', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    const link = scene.config.links[0]!
    let currentRun: SimulationRun = {
      ...simulationRun('IDLE', false),
      runId: 'RUN-LIVE-1',
      scenarioId: scene.config.scenario.id,
    }
    let messageSeq = 0
    let snapResponse = {
      runId: 'RUN-LIVE-1',
      scenarioId: scene.config.scenario.id,
      revision: scene.revision,
      generation: 1,
      cursor: 0,
      hasMore: false,
      sourceAvailable: false,
      latestSimTime: null as number | null,
      waitingForLine: false,
      messageDetailsComplete: true,
      issueCount: 0,
      issues: { undelivered: 0, ambiguous: 0, unclassified: 0 },
      totalTransmits: 0,
      totalReceives: 0,
      totalPaired: 0,
      unconfirmedCount: 0,
      deliveries: [] as any[],
      unconfirmedTransmits: [] as any[],
    }
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (/\/simulations\/[^/]+\/positions$/.test(input)) {
        return successResponse({ runId: currentRun.runId, scenarioId: scene.config.scenario.id, revision: scene.revision, positions: null })
      }
      if (/\/simulations\/[^/]+\/messages(?:\?|$)/.test(input)) {
        const result = successResponse(structuredClone(snapResponse))
        snapResponse = { ...snapResponse, deliveries: [] }
        return result
      }
      if (input.endsWith('/simulations')) return successResponse([currentRun])
      if (input.endsWith(`/scenarios/${scene.config.scenario.id}`)) return successResponse(scene)
      if (input.endsWith(`/simulations/${currentRun.runId}/commands`)) {
        const cmd = JSON.parse(String(init?.body ?? '{}')).command
        if (cmd === 'START') {
          currentRun = { ...simulationRun('RUNNING', true), runId: 'RUN-LIVE-1', scenarioId: scene.config.scenario.id }
        } else if (cmd === 'PAUSE') {
          currentRun = { ...simulationRun('PAUSED', true), runId: 'RUN-LIVE-1', scenarioId: scene.config.scenario.id }
        } else if (cmd === 'RESUME') {
          currentRun = { ...simulationRun('RUNNING', true), runId: 'RUN-LIVE-1', scenarioId: scene.config.scenario.id }
        }
        return successResponse(currentRun)
      }
      throw new Error(`Unexpected request ${input}`)
    })
    vi.stubGlobal('fetch', fetcher)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const wrapper = await mountSituationPage(scene.config.scenario.id, 'LOCAL')
    // 场景空闲、仅有配置链路时，流向动画按钮应禁用且图例不误出现
    await wrapper.get('[data-testid="more-layers-toggle"]').trigger('click')
    const flowBtn = () => wrapper.findAll('[data-testid="more-layers-menu"] button').find(btn => btn.text() === '流向动画')!
    expect(flowBtn().attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="flow-direction-legend"]').exists()).toBe(false)

    // 启动本次仿真后到达真实配对报文：打开流向开关、更新实时流向与方向图例
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    await flushPromises()
    messageSeq += 1
    snapResponse = {
      ...snapResponse,
      sourceAvailable: true,
      latestSimTime: 2.12,
      totalTransmits: 2,
      totalReceives: 1,
      totalPaired: 1,
      unconfirmedCount: 1,
      cursor: messageSeq,
      deliveries: [{
        sequence: messageSeq,
        sourceEventId: 'ev-rx-1',
        transmitEventId: 'ev-tx-1',
        type: link.type,
        time: 2.12,
        delayS: 0.12,
        source: { platformName: link.sourcePlatformId, communicationName: 'sat_link_a' },
        target: { platformName: link.relayPlatformId ?? link.targetPlatformId, communicationName: 'sat_link' },
        messageType: 'kForwardSituation',
        messageSizeBits: 512,
        direction: 'FORWARD',
      }],
      unconfirmedTransmits: [{
        eventId: 'ev-tx-unconf',
        transmitTime: 1.5,
        platformName: link.sourcePlatformId,
        communicationName: 'sat_link_a',
        messageType: 'kForwardTarget',
        direction: 'FORWARD',
      }],
    }
    await vi.advanceTimersByTimeAsync(1_050)
    await flushPromises()

    await wrapper.get('[data-testid="more-layers-toggle"]').trigger('click')
    expect(flowBtn().attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="flow-direction-legend"]').exists()).toBe(false)
    expect((mapControllerMock.latestOptions as any).liveMessageFlows).toHaveLength(1)
    expect((mapControllerMock.latestOptions as any).liveMessageFlows[0]).toMatchObject({
      sourcePlatformId: link.sourcePlatformId,
      targetPlatformId: link.relayPlatformId ?? link.targetPlatformId,
      direction: 'FORWARD',
      pulseId: 'RUN-LIVE-1:1:ev-rx-1',
    })
    expect((mapControllerMock.latestOptions as any).liveFlowPlaying).toBe(true)

    // 暂停冻结、继续恢复（本地实时任务由仿真状态切换驱动冻结与恢复）
    await useSimulationStore().pause()
    await flushPromises()
    expect((mapControllerMock.latestOptions as any).liveFlowPlaying).toBe(false)
    await useSimulationStore().resume()
    await flushPromises()
    expect((mapControllerMock.latestOptions as any).liveFlowPlaying).toBe(true)

    // 报文流向层开启时仍可打开链路详情。
    mapControllerMock.latestOptions!.onSelectConfiguredLink?.(link)
    await flushPromises()
    expect(document.querySelector('[data-testid="link-detail-configured"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="configured-link-message-evidence"]')).toBeNull()
    expect((mapControllerMock.latestOptions as any).liveMessageFlows).toHaveLength(1)

    // 停止后不再产生新脉冲
    currentRun = { ...simulationRun('COMPLETED', false), runId: 'RUN-LIVE-1', scenarioId: scene.config.scenario.id }
    useSimulationStore().run = currentRun
    messageSeq += 1
    snapResponse = {
      ...snapResponse,
      cursor: messageSeq,
      deliveries: [{
        sequence: messageSeq,
        sourceEventId: 'ev-rx-after-stop',
        transmitEventId: 'ev-tx-after-stop',
        type: link.type,
        time: 4.1,
        delayS: 0.05,
        source: { platformName: link.sourcePlatformId, communicationName: 'sat_link_a' },
        target: { platformName: link.relayPlatformId ?? link.targetPlatformId, communicationName: 'sat_link' },
        messageType: 'kReturnReconStatus',
        messageSizeBits: 256,
        direction: 'REVERSE',
      }],
    }
    await flushPromises()
    const postStopFlows = (mapControllerMock.latestOptions as any).liveMessageFlows as any[]
    expect(postStopFlows.some(item => item.pulseId === 'RUN-LIVE-1:1:ev-rx-after-stop')).toBe(false)
  })

  it('中途载入已运行实例的历史积压报文时不全部冒充实时脉冲，随后到达的新报文才触发动画', async () => {
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    const link = scene.config.links[0]!
    const existingRun = simulationRun('RUNNING', true)
    let call = 0
    const fetcher = vi.fn(async (input: string) => {
      if (/\/simulations\/[^/]+\/positions$/.test(input)) {
        return successResponse({ runId: existingRun.runId, scenarioId: scene.config.scenario.id, revision: scene.revision, positions: null })
      }
      if (/\/simulations\/[^/]+\/messages(?:\?|$)/.test(input)) {
        call += 1
        if (call === 1) {
          return successResponse({
            runId: existingRun.runId, scenarioId: scene.config.scenario.id, revision: scene.revision,
            generation: 1, cursor: 2, hasMore: false, sourceAvailable: true, latestSimTime: 10,
            waitingForLine: false, messageDetailsComplete: true, issueCount: 0,
            issues: { undelivered: 0, ambiguous: 0, unclassified: 0 },
            totalTransmits: 2, totalReceives: 2, totalPaired: 2, unconfirmedCount: 0,
            deliveries: [{
              sequence: 1, sourceEventId: 'hist-1', transmitEventId: 'hist-tx-1', type: link.type, time: 1.5, delayS: 0.12,
              source: { platformName: link.sourcePlatformId, communicationName: 'sat_link_a' },
              target: { platformName: link.relayPlatformId ?? link.targetPlatformId, communicationName: 'sat_link' },
              messageType: 'kForwardSituation', messageSizeBits: 256, direction: 'FORWARD',
            }],
            unconfirmedTransmits: [],
          })
        }
        return successResponse({
          runId: existingRun.runId, scenarioId: scene.config.scenario.id, revision: scene.revision,
          generation: 1, cursor: 3, hasMore: false, sourceAvailable: true, latestSimTime: 11.2,
          waitingForLine: false, messageDetailsComplete: true, issueCount: 0,
          issues: { undelivered: 0, ambiguous: 0, unclassified: 0 },
          totalTransmits: 3, totalReceives: 3, totalPaired: 3, unconfirmedCount: 0,
          deliveries: [{
            sequence: 3, sourceEventId: 'live-after-1', transmitEventId: 'live-tx-1', type: link.type, time: 11.2, delayS: 0.12,
            source: { platformName: link.sourcePlatformId, communicationName: 'sat_link_a' },
            target: { platformName: link.relayPlatformId ?? link.targetPlatformId, communicationName: 'sat_link' },
            messageType: 'kForwardSituation', messageSizeBits: 256, direction: 'FORWARD',
          }],
          unconfirmedTransmits: [],
        })
      }
      if (input.endsWith('/simulations')) return successResponse([existingRun])
      if (input.endsWith(`/scenarios/${scene.config.scenario.id}`)) return successResponse(scene)
      throw new Error(`Unexpected request ${input}`)
    })
    vi.stubGlobal('fetch', fetcher)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    await mountSituationPage(scene.config.scenario.id, 'LOCAL')
    // 历史积压脉冲应保持 undefined，不冒充刚发送的传输
    expect((mapControllerMock.latestOptions as any).liveMessageFlows).toHaveLength(1)
    expect((mapControllerMock.latestOptions as any).liveMessageFlows[0].pulseId).toBeUndefined()

    // 后续实时到达才激活实时脉冲
    await vi.advanceTimersByTimeAsync(1_050)
    await flushPromises()
    expect((mapControllerMock.latestOptions as any).liveMessageFlows[0].pulseId).toBe(`${existingRun.runId}:1:live-after-1`)
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

  it('四类配置和文件业务链路均使用不同颜色及线型', async () => {
    const lineSpy = vi.spyOn(L, 'polyline')
    const types = ['SAT', 'MICROWAVE', 'DATALINK', 'LASER'] as const
    const nodes = INITIAL_NODES.nodes.slice(0, 2).map((node, index) => ({ ...node, platformId: index ? 'B' : 'A' }))
    const links = types.map(type => ({ ...fixtureSource.scenario.links[0]!, id: type, type,
      sourcePlatformId: 'A', targetPlatformId: 'B' })) as Link[]
    const controller = await createController({ initialNodes: nodes, configuredLinks: links })
    const styles = () => lineSpy.mock.calls.filter(([, options]) => options?.interactive === true)
      .map(([, options]) => [options?.color, options?.dashArray])
    const expected = [['#67c23a', undefined], ['#409eff', '8 5'], ['#e6a23c', '2 5'], ['#b37feb', '12 4 2 4']]
    expect(styles()).toEqual(expected)
    controller.setConfiguredLinks(undefined)
    lineSpy.mockClear()
    controller.setFileMessageLinks(types.map(type => ({ ...MESSAGE_LINK, id: type, type })))
    expect(styles()).toEqual(expected)
    controller.destroy()
  })


  it('按设备配置绘制独立范围，更新复用圆圈，定位和换场景清理使用同一半径', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const fit = vi.spyOn(L.Map.prototype, 'fitBounds')
    const node = { ...INITIAL_NODES.nodes[0]!, platformId: 'JAM-NODE' }
    const jammers = [
      { id: 'JAM-ONE', platformId: node.platformId, jammingRange: 5000 },
      { id: 'JAM-TWO', platformId: node.platformId, jammingRange: 17000 },
    ]
    const controller = await createController({ initialNodes: [node], configuredLinks: [], configuredJammers: jammers })
    const group = groups.mock.results[4]!.value as L.LayerGroup
    const circles = group.getLayers() as L.Circle[]
    expect(circles.map(circle => circle.getRadius())).toEqual([5000, 17000])
    expect((circles[0]!.getTooltip()?.getContent() as HTMLElement).textContent).toContain('配置范围，非实测覆盖')
    controller.setConfiguredJammers([{ ...jammers[0]!, jammingRange: 9000 }, jammers[1]!])
    expect(group.getLayers()).toEqual(circles)
    expect(circles[0]!.getRadius()).toBe(9000)
    const moved = { ...node, latitude: node.latitude + 0.1 }
    controller.setNodes([moved])
    expect(circles.map(circle => circle.getLatLng().lat)).toEqual([moved.latitude, moved.latitude])
    controller.focusTarget({ kind: 'interference', targetId: 'JAM-TWO' })
    const bounds = fit.mock.calls.at(-1)![0] as L.LatLngBounds
    expect(bounds.equals(L.latLng(moved.latitude, moved.longitude).toBounds(34000))).toBe(true)
    expect(circles[1]!.options.className).toBe('situation-map-interference--selected')
    controller.setConfiguredJammers([])
    expect(group.getLayers()).toHaveLength(0)
    controller.destroy()
  })


  async function createController(options: {
    initialNodes?: SituationMapNode[]
    fileDeviceStates?: FileDeviceEvent[]
    configuredLinks?: SituationMapLink[]
    configuredJammers?: ConfiguredJammerRange[]
    configuredEnvironment?: Environment
    liveMessageFlows?: import('../../src/features/situation/live-message-flows').LiveMessageFlowLane[]
    liveFlowPlaying?: boolean
    liveFlowKey?: string
    selectNearbyLinks?: boolean
    separateLinkDirections?: boolean
    onSelectConfiguredLink?: (link: Link, reverse?: Link) => void
    fileLinks?: FileCommunicationLink[]
    fileMessageLinks?: FileMessageLink[]
    onSelectFileLink?: (link: FileCommunicationLink) => void
    /** 登记关联图层默认关闭；需要检查其渲染的用例显式开启。 */
    showPotentialLayer?: boolean
    onSelectNode?: (platformId: string) => void
    onSelectLink?: (link: SituationLinkView) => void
    onZoomChange?: (zoom: number) => void
    useSatelliteDataPosition?: boolean
    basemapLabelsVisible?: boolean
    initialTheme?: 'dark' | 'light'
  } = {}) {
    vi.resetModules()
    vi.doUnmock('../../src/components/situation/situation-map-controller')
    const { MAP_CONFIG: activeConfig } = await import('../../src/config/map.config')
    if (options.basemapLabelsVisible !== undefined) {
      Object.assign(activeConfig.defaults, { basemapLabelsVisible: options.basemapLabelsVisible })
    }
    if (options.initialTheme !== undefined) {
      Object.assign(activeConfig.defaults, { theme: options.initialTheme })
    }
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
      configuredJammers: options.configuredJammers,
      configuredEnvironment: options.configuredEnvironment,
      liveMessageFlows: options.liveMessageFlows,
      liveFlowPlaying: options.liveFlowPlaying,
      liveFlowKey: options.liveFlowKey,
      selectNearbyLinks: options.selectNearbyLinks,
      separateLinkDirections: options.separateLinkDirections,
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

  it('各种降雨设置均不创建雨纹图层，海面多径范围继续按有效配置更新', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const polygons = vi.spyOn(L, 'polygon')
    const controller = await createController({ configuredEnvironment: SCENE_ENVIRONMENT })
    const map = mapSpy.mock.results[0]!.value as L.Map
    const seaPane = map.getPane('scenario-sea')!
    const seaArea = polygons.mock.results.find(({ value }) => value.options.pane === 'scenario-sea')!.value as L.Polygon
    expect(map.getPane('scenario-rain')).toBeUndefined()
    expect(seaPane.style.pointerEvents).toBe('none')
    expect(Number(seaPane.style.zIndex)).toBeLessThan(400)
    expect(seaArea.options.interactive).toBe(false)
    expect(seaArea.getTooltip()?.getContent()).toBe('海面多径区域')
    expect(map.hasLayer(seaArea)).toBe(true)

    controller.setConfiguredEnvironment({ ...SCENE_ENVIRONMENT, rainRateMmPerHour: 0 })
    expect(map.getPane('scenario-rain')).toBeUndefined()
    expect(map.hasLayer(seaArea)).toBe(true)

    controller.setConfiguredEnvironment({ ...SCENE_ENVIRONMENT, rainEnabled: false, multipathEnabled: false })
    expect(map.hasLayer(seaArea)).toBe(false)
    controller.setConfiguredEnvironment({ ...SCENE_ENVIRONMENT, rainRateMmPerHour: 0, seaPolygon: SCENE_ENVIRONMENT.seaPolygon!.slice(0, 2) })
    expect(seaPane.querySelector('path')).toBeNull()
    controller.setConfiguredEnvironment(SCENE_ENVIRONMENT)
    expect(map.getPane('scenario-rain')).toBeUndefined()
    controller.setConfiguredEnvironment(undefined)
    expect(seaPane.querySelector('path')).toBeNull()
  })

  it('保留聚合数量和航向，逐架展开显示配置名称和编号', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const groups = vi.spyOn(L, 'layerGroup')
    const onSelectNode = vi.fn()
    const base = INITIAL_NODES.nodes[0]!
    const nodes: SituationMapNode[] = [
      { ...base, platformId: 'BLUE-A', name: '蓝方无人机一', type: 'AIRBORNE_MISSION_CLUSTER', side: 'blue', latitude: 24, longitude: 119, heading: 0, speed: 100 },
      { ...base, platformId: 'BLUE-B', name: '蓝方无人机二', type: 'Drone_MISSION_AIRCRAFT', side: 'blue', latitude: 24.5, longitude: 119.5, heading: 180, speed: 100 },
      { ...base, platformId: 'RED-A', name: '红方无人机一', type: 'AIRBORNE_MISSION_CLUSTER', side: 'red' },
      { ...base, platformId: 'RELAY', name: '高空中继', type: 'FORWARD_RELAY_NODE', side: 'blue' },
      { ...base, platformId: 'FILE-UAV', name: '文件节点', type: 'MISSION_UAV_PLATFORM', side: 'blue' },
    ]
    const controller = await createController({ initialNodes: nodes, onSelectNode })
    controller.setSelectedNodeId(nodes[0]!.platformId)
    const map = mapSpy.mock.results[0]!.value as L.Map
    const group = groups.mock.results[0]!.value as L.LayerGroup
    const markers = () => group.getLayers() as L.Marker[]
    const markerAt = (title: string) => markers().find(marker => marker.options.title === title)
    const nameLabel = (marker: L.Marker) => marker.getElement()!.querySelector<HTMLElement>('.situation-map-node__name')!
    const idLabel = (marker: L.Marker) => marker.getElement()!.querySelector<HTMLElement>('.situation-map-node__id')!
    const zoomTo = (level: number) => {
      // jsdom 下 Leaflet 会把 setZoom 的小数缩放吸附为整数。
      const zoom = vi.spyOn(map, 'getZoom').mockReturnValue(level)
      map.fire('zoomend')
      zoom.mockRestore()
    }

    zoomTo(10)
    const cluster = markerAt('展开无人机群（2 架）')!
    expect(markers()).toHaveLength(4)
    expect(idLabel(cluster).textContent).toBe('×2')
    expect(nameLabel(cluster).style.display).toBe('none')
    const clusterImage = cluster.getElement()!.querySelector('img')!
    expect(clusterImage.style.transform).toBe('')
    expect(cluster.getLatLng()).toEqual(L.latLng(24.25, 119.25))
    expect(markerAt('选择节点 高空中继')).toBeDefined()
    expect(markerAt('选择节点 文件节点')).toBeDefined()
    const singleUav = markerAt('选择节点 红方无人机一')!
    expect(nameLabel(singleUav).style.display).toBe('none')
    const singleUavId = idLabel(singleUav).textContent

    const moved = { ...nodes[1]!, latitude: 25, longitude: 120 }
    controller.setNodes([{ ...nodes[0]!, heading: 350 }, { ...moved, heading: 10 }, ...nodes.slice(2)])
    expect(markerAt('展开无人机群（2 架）')).toBe(cluster)
    expect(cluster.getLatLng()).toEqual(L.latLng(24.5, 119.5))
    expect(cluster.getElement()?.querySelector('img')).toBe(clusterImage)
    expect(Number.parseFloat(clusterImage.style.transform.slice('rotate('.length))).toBeCloseTo(-90)

    controller.setNodes([{ ...nodes[0]!, speed: 40 }, { ...moved, speed: 120 }, ...nodes.slice(2)])
    expect(Number.parseFloat(clusterImage.style.transform.slice('rotate('.length))).toBeCloseTo(90)

    zoomTo(10.25)
    expect(markers()).toHaveLength(5)
    const expandedUav = markerAt('选择节点 蓝方无人机一')!
    expect(nameLabel(expandedUav).textContent).toBe('蓝方无人机一')
    expect(nameLabel(expandedUav).style.display).toBe('block')
    expect(idLabel(expandedUav).textContent).toMatch(/^无人机集群U\d+$/u)
    expect(idLabel(expandedUav).style.display).not.toBe('none')
    expect(markerAt('选择节点 红方无人机一')).toBe(singleUav)
    expect(nameLabel(singleUav).style.display).toBe('block')
    expect(idLabel(singleUav).textContent).toBe(singleUavId)
    expect(markerAt('选择节点 蓝方无人机二')?.getLatLng()).toEqual(L.latLng(25, 120))
    expect(markerAt('选择节点 蓝方无人机二')?.getElement()?.querySelector('img')?.style.transform).toBe('rotate(90deg)')
    markerAt('选择节点 蓝方无人机二')!.fire('click')
    expect(onSelectNode).toHaveBeenCalledWith('BLUE-B')

    zoomTo(10)
    expect(markers()).toHaveLength(4)
    expect(nameLabel(singleUav).style.display).toBe('none')
    expect(idLabel(markerAt('展开无人机群（2 架）')!).textContent).toBe('×2')
    const setView = vi.spyOn(map, 'setView')
    markerAt('展开无人机群（2 架）')!.fire('click')
    expect(setView).toHaveBeenCalledWith(L.latLng(24.5, 119.5), 11)
    expect(onSelectNode).toHaveBeenCalledOnce()
    controller.destroy()
  })


  it('引擎干扰范围随位置和半径更新，空数组仅回退配置，明确关闭才移除覆盖', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const frame = adaptEngineFrameSnapshot(jammerSample).data!, jammer = frame.jammers[0]!
    const nodes = [{ ...INITIAL_NODES.nodes[0]!, platformId: jammer.platformId!, type: 'GROUND' }]
    const controller = await createController({ initialNodes: nodes,
      configuredJammers: [{ id: 'J-1', platformId: jammer.platformId!, jammingRange: 1000 }] })
    const ranges = groups.mock.results[4]!.value as L.LayerGroup
    controller.setEngineFrame(frame)
    const circle = ranges.getLayers()[0] as L.Circle
    expect(circle.getRadius()).toBe(18520)
    expect(circle.getLatLng()).toEqual(L.latLng(25.15, 121.55))
    expect((circle.getTooltip()!.getContent() as HTMLElement).textContent).toContain('引擎报告范围')
    controller.setEngineFrame({ ...frame, jammers: [{ ...jammer, deviceStatus: null }] })
    expect(ranges.getLayers()).toEqual([circle])
    expect((circle.getTooltip()!.getContent() as HTMLElement).textContent).toContain('启停未确认')
    controller.setEngineFrame({ ...frame, jammers: [{ ...jammer, rangeM: 21000, position: { longitude: 121.7, latitude: 25.3, altitudeM: 0 } }] })
    expect(ranges.getLayers()).toEqual([circle])
    expect(circle.getRadius()).toBe(21000)
    expect(circle.getLatLng()).toEqual(L.latLng(25.3, 121.7))
    const markers = (groups.mock.results[0]!.value as L.LayerGroup).getLayers() as L.Marker[]
    expect(markers[0]!.getLatLng()).toEqual(L.latLng(25.3, 121.7))
    controller.setEngineFrame({ ...frame, jammers: [] })
    const fallback = ranges.getLayers()[0] as L.Circle
    expect(fallback.getRadius()).toBe(1000)
    expect((fallback.getTooltip()!.getContent() as HTMLElement).textContent).toContain('配置范围，非实测覆盖')
    controller.setEngineFrame({ ...frame, jammers: [{ ...jammer, deviceStatus: 'OFF' }] })
    expect(ranges.getLayers()).toEqual([])
  })

  it('轨迹使用独立图层，默认关闭且更新复用折线，显隐不丢点，清空移除旧轨迹', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const groups = vi.spyOn(L, 'layerGroup')
    const nodes = [{ ...INITIAL_NODES.nodes[0]!, type: 'AIR' }]
    const controller = await createController({ initialNodes: nodes })
    const map = mapSpy.mock.results[0]!.value as L.Map
    const trails = groups.mock.results[7]!.value as L.LayerGroup
    expect(map.hasLayer(trails)).toBe(false)
    const points = [{ longitude: 120, latitude: 25, time: 0 }, { longitude: 121, latitude: 26, time: 1 }]
    controller.setNodeTrails([{ platformId: nodes[0]!.platformId, points }])
    const line = trails.getLayers()[0] as L.Polyline
    expect(line.getLatLngs()).toEqual([L.latLng(25, 120), L.latLng(26, 121)])
    expect(line.options.interactive).toBe(false)
    expect(map.hasLayer(trails)).toBe(false)
    controller.setLayerVisible('trails', true)
    expect(map.hasLayer(trails)).toBe(true)
    expect((line as any)._map).toBe(map)
    controller.setLayerVisible('trails', false)
    expect((line as any)._map).toBeNull()
    controller.setNodeTrails([{ platformId: nodes[0]!.platformId, points: [...points, { longitude: 122, latitude: 27, time: 2 }] }])
    expect(trails.getLayers()).toEqual([line])
    controller.setLayerVisible('trails', true)
    expect(line.getLatLngs()).toHaveLength(3)
    controller.setNodeTrails([])
    expect(trails.getLayers()).toEqual([])
  })

  it('两类指定节点的探测圈半径为 50 公里，移动和倒退复用圆，切换数据源移除，其他节点不冒用范围', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const nodes: SituationMapNode[] = ['jammer_station_01', 'jammer_airborne_01', 'UNKNOWN'].map(platformId => ({
      ...INITIAL_NODES.nodes[0]!, platformId, name: '地面干扰站01',
    }))
    const controller = await createController({ initialNodes: nodes })
    const detection = groups.mock.results[6]!.value as L.LayerGroup
    const ranges = detection.getLayers() as L.Circle[]
    expect(ranges).toHaveLength(2)
    for (const circle of ranges) {
      expect(circle.getRadius()).toBe(50_000)
      expect(circle.options).toMatchObject({ color: '#f5c542', dashArray: '8 6', fill: true, fillColor: '#f5c542', fillOpacity: 0.08, interactive: false })
      expect(circle.getTooltip()).toBeUndefined()
    }
    controller.setNodes(nodes.map(node => ({ ...node, latitude: node.latitude + 0.2 })))
    expect(detection.getLayers()).toEqual(ranges)
    expect(ranges[1]!.getLatLng().lat).toBe(nodes[1]!.latitude + 0.2)
    controller.setNodes(nodes)
    expect(ranges[1]!.getLatLng().lat).toBe(nodes[1]!.latitude)
    controller.setFileDeviceStates([])
    expect(detection.getLayers()).toEqual(ranges)
    controller.setNodes(nodes.slice(1))
    expect(detection.getLayers()).toEqual([ranges[1]])
    controller.setFrame(structuredClone(SITUATION_FRAME_F00042))
    expect(detection.getLayers()).toHaveLength(0)
    controller.setFrame(null)
    controller.setNodes(nodes)
    expect(detection.getLayers()).toHaveLength(2)
    controller.setConfiguredLinks([])
    expect(detection.getLayers()).toHaveLength(0)
    controller.destroy()
    expect(detection.getLayers()).toHaveLength(0)
  })

  it('场景与仿真地图上地面干扰站和机载干扰平台绘制探测范围圈，随平台移动和引擎更新复用图层', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const groundNode: SituationMapNode = {
      ...INITIAL_NODES.nodes[0]!, platformId: 'jammer_station_01', name: '地面干扰站',
      type: 'GROUND_JAMMER_DETECTION_STATION', longitude: 121.55, latitude: 25.15, altitude: 0, speed: 0,
    }
    const airborneNode: SituationMapNode = {
      ...INITIAL_NODES.nodes[1]!, platformId: 'jammer_airborne_01', name: '机载干扰平台',
      type: 'AIRBORNE_JAMMER_PLATFORM', longitude: 121.56, latitude: 25.0345, altitude: 3000, speed: 120,
    }
    const uavNode: SituationMapNode = {
      ...INITIAL_NODES.nodes[0]!, platformId: 'UAV-1', name: '任务无人机',
      type: 'AIRBORNE_MISSION_CLUSTER', longitude: 120.8, latitude: 24.5, altitude: 4000, speed: 80,
    }
    const jammers = [
      { id: 'ground_jammer', platformId: 'jammer_station_01', jammingRange: 44448, detectionRange: 55560 },
      { id: 'airborne_jammer', platformId: 'jammer_airborne_01', jammingRange: 30000, detectionRange: 65000 },
    ]
    const controller = await createController({
      initialNodes: [groundNode, airborneNode, uavNode],
      configuredLinks: [],
      configuredJammers: jammers,
    })
    const detection = groups.mock.results[6]!.value as L.LayerGroup
    const initialCircles = detection.getLayers() as L.Circle[]
    expect(initialCircles).toHaveLength(2)
    expect(initialCircles.map(circle => circle.getRadius())).toEqual([55560, 65000])
    for (const circle of initialCircles) {
      expect(circle.options).toMatchObject({ color: '#f5c542', dashArray: '8 6', fill: true, fillColor: '#f5c542', fillOpacity: 0.08, interactive: false })
    }

    const movedAirborne = { ...airborneNode, latitude: airborneNode.latitude + 0.15, longitude: airborneNode.longitude + 0.1 }
    controller.setNodes([groundNode, movedAirborne, uavNode])
    expect(detection.getLayers()).toEqual(initialCircles)
    expect(initialCircles[1]!.getLatLng()).toEqual(L.latLng(movedAirborne.latitude, movedAirborne.longitude))

    const engineFrame = adaptEngineFrameSnapshot(jammerSample).data!
    controller.setEngineFrame(engineFrame)
    const updatedCircles = detection.getLayers() as L.Circle[]
    expect(updatedCircles.map(circle => circle.getRadius()).sort((a, b) => a - b)).toEqual([22224, 65000])

    controller.setEngineFrame(null)
    expect((detection.getLayers() as L.Circle[]).map(circle => circle.getRadius()).sort((a, b) => a - b)).toEqual([55560, 65000])

    controller.setConfiguredJammers([{ id: 'airborne_jammer', platformId: 'jammer_airborne_01', jammingRange: 30000 }])
    expect((detection.getLayers() as L.Circle[]).map(circle => circle.getRadius())).toEqual([48520])

    controller.setConfiguredJammers([])
    expect(detection.getLayers()).toHaveLength(0)
    controller.destroy()
  })

  it('干扰机微标随目标进出探测圈与干扰圈切换：侦测中 → 开启压制 → 关闭压制', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const jammerNode: SituationMapNode = {
      platformId: 'jammer_station_01', name: '地面干扰站', type: 'GROUND_JAMMER_DETECTION_STATION',
      longitude: 121.55, latitude: 25.15, altitude: 0, speed: 0,
    }
    const makeUav = (longitude: number, latitude: number): SituationMapNode => ({
      platformId: 'mission_uav_02', name: '作业无人机 2', type: 'AIRBORNE_MISSION_CLUSTER',
      longitude, latitude, altitude: 3600, speed: 40,
    })
    const configuredJammers: ConfiguredJammerRange[] = [
      { id: 'prophet_jammer', platformId: 'jammer_station_01', jammingRange: 18_520, detectionRange: 37_040 },
    ]
    const controller = await createController({
      initialNodes: [jammerNode, makeUav(119.5, 24.8)],
      configuredLinks: [],
      configuredJammers,
    })
    const effectsGroup = groups.mock.results[8]!.value as L.LayerGroup
    const tagTexts = () => (effectsGroup.getLayers() as L.Marker[])
      .map(marker => String((marker.options.icon as L.DivIcon | undefined)?.options.html ?? ''))

    // 1) 目标在范围外 → 无状态微标
    expect(tagTexts()).toEqual([])

    // 2) 目标进入探测圈（~25 km）→ 显示「侦测中」
    controller.setNodes([jammerNode, makeUav(121.3, 25.15)])
    expect(tagTexts()).toHaveLength(1)
    expect(tagTexts()[0]).toContain('侦测中')

    // 3) 目标进入干扰圈（~10 km）→ 切换为「开启压制」
    controller.setNodes([jammerNode, makeUav(121.45, 25.15)])
    expect(tagTexts()).toHaveLength(1)
    expect(tagTexts()[0]).toContain('开启压制')

    // 4) 目标飞出干扰圈（回到 ~25 km 外环及更远）→ 切换为「关闭压制」
    controller.setNodes([jammerNode, makeUav(121.3, 25.15)])
    expect(tagTexts()).toHaveLength(1)
    expect(tagTexts()[0]).toContain('关闭压制')
    controller.setNodes([jammerNode, makeUav(119.5, 24.8)])
    expect(tagTexts()).toHaveLength(1)
    expect(tagTexts()[0]).toContain('关闭压制')

    // 5) 切换场景视图重置记忆后，远端目标不再残留「关闭压制」
    controller.setViewportKey('scene:reset-check')
    controller.setNodes([jammerNode, makeUav(119.5, 24.8)])
    expect(tagTexts()).toEqual([])
    controller.destroy()
  })

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
    // 固定探测示意圈不依赖干扰事件，以下仅检查原有干扰圈。
    expect(circles).toHaveBeenCalledTimes(2)
    circles.mockClear()
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
      expect((circle.getTooltip()?.getContent() as HTMLElement).textContent).toContain('示意范围，缺少设备配置')
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
    expect([...container!.querySelectorAll<HTMLImageElement>('.situation-map-node__image')].map(image => image.src)).toEqual([nodeIconUrl(nodes[0]!), nodeIconUrl(nodes[1]!)])
    expect(container!.textContent).not.toContain('轨道示意')
    expect(JSON.stringify(nodes)).toBe(original)
  })

  it('七张俯视图按节点类型渲染，中继复用无人机图，未知类型与旧卫星保留通用符号', async () => {
    const definitions = [
      { type: 'REAR_COMMAND_NODE', file: 'rear.png', rotation: 'rotate(90deg)' },
      { type: 'FORWARD_RELAY_NODE', file: 'UAV.png', rotation: 'rotate(-90deg)' },
      { type: 'GROUND_CLUSTER_COMMAND_NODE', file: 'comand_vehical1.png', rotation: 'rotate(-90deg)' },
      { type: 'AIRBORNE_MISSION_CLUSTER', file: 'UAV.png', rotation: 'rotate(-90deg)' },
      { type: 'COMMUNICATION_SATELLITE', satelliteType: 'TIANTONG' as const, file: 'tiantong_sat.png' },
      { type: 'COMMUNICATION_SATELLITE', satelliteType: 'SHENTONG' as const, file: 'shentong_sat.png' },
      { type: 'GROUND_JAMMER_DETECTION_STATION', file: 'jammer_station.png', rotation: 'rotate(-90deg)' },
      { type: 'AIRBORNE_JAMMER_PLATFORM', file: 'jammer_airbround.png', rotation: 'rotate(90deg)' },
      { type: 'UNKNOWN_FILE_TYPE', glyph: '○' },
      { type: 'COMMUNICATION_SATELLITE', glyph: '▲' },
    ]
    const nodes = definitions.map((item, index) => ({ ...INITIAL_NODES.nodes[1]!, platformId: 'N-' + index, name: '节点' + index, type: item.type, satelliteType: item.satelliteType, heading: 0 }))
    await createController({ initialNodes: nodes })
    const glyphs = [...container!.querySelectorAll<HTMLElement>('.situation-map-node__glyph')]
    definitions.forEach((item, index) => {
      const image = glyphs[index]!.querySelector<HTMLImageElement>('img')
      if (item.file) {
        expect(image?.src).toBe(nodeIconUrl(nodes[index]!))
        expect(image?.src.endsWith('/' + item.file)).toBe(true)
        expect(image?.style.transform).toBe(item.rotation ?? '')
        expect(image?.alt).toBe('')
        expect(glyphs[index]!.getAttribute('aria-hidden')).toBe('true')
      } else {
        expect(image).toBeNull()
        expect(glyphs[index]!.textContent).toBe(item.glyph)
      }
    })
    glyphs[0]!.querySelector('img')!.dispatchEvent(new Event('error'))
    expect(glyphs[0]!.textContent).toBe('■')
  })

  it('图标按新航向原位旋转，缺少航向时使用已到达的轨迹段', async () => {
    const node: SituationMapNode = {
      ...INITIAL_NODES.nodes[1]!, type: 'FORWARD_RELAY_NODE', time: 2, longitude: 179.9, latitude: 0,
    }
    const controller = await createController({ initialNodes: [node] })
    controller.setSelectedNodeId(node.platformId)
    const image = container!.querySelector<HTMLImageElement>('.situation-map-node__image')!
    const marker = image.closest<HTMLElement>('.leaflet-marker-icon')!
    marker.focus()
    expect(image.style.transform).toBe('')

    controller.setNodeTrails([{ platformId: node.platformId, points: [
      { time: 1, longitude: -179.9, latitude: 0 }, { time: 2, longitude: 179.9, latitude: 0 },
    ] }])
    expect(image.style.transform).toBe('rotate(-180deg)')

    controller.setNodes([{ ...node, heading: -30 }])
    expect(container!.querySelector('.situation-map-node__image')).toBe(image)
    expect(image.style.transform).toBe('rotate(-120deg)')
    expect(marker.querySelector<HTMLElement>('.situation-map-node__name')?.style.transform).toBe('')
    expect(document.activeElement).toBe(marker)

    controller.setNodes([{ ...node, time: 1 }])
    expect(image.style.transform).toBe('')
  })

  it('卫星按明确子类型选图，不受自定义编号和名称误导，换子类型更新图而移动复用图', async () => {
    const node: SituationMapNode = { ...INITIAL_NODES.nodes[0]!, platformId: 'SUP-001', name: '自定义卫星', type: 'COMMUNICATION_SATELLITE', satelliteType: 'TIANTONG' }
    const original = JSON.stringify(node)
    const onSelectNode = vi.fn()
    const markers = vi.spyOn(L, 'marker')
    const controller = await createController({ initialNodes: [node], onSelectNode, useSatelliteDataPosition: true })
    controller.setSelectedNodeId(node.platformId)
    const firstImage = container!.querySelector<HTMLImageElement>('.situation-map-node__image')!
    expect(firstImage.src).toBe(MAP_CONFIG.nodeTypeImages.TIANTONG)
    const marker = markers.mock.results.map(result => result.value as L.Marker).find(value => value.options.title?.startsWith('选择节点'))!
    expect(marker.options.icon?.options.iconAnchor).toEqual([80, 24])
    expect(marker.options.icon?.options.iconSize).toEqual([160, 88])
    controller.setNodes([{ ...node, longitude: node.longitude + 0.1 }])
    expect(container!.querySelector('.situation-map-node__image')).toBe(firstImage)
    expect(marker.getLatLng().lng).toBe(node.longitude + 0.1)
    controller.setNodes([{ ...node, satelliteType: 'SHENTONG' }])
    expect(container!.querySelector<HTMLImageElement>('.situation-map-node__image')!.src).toBe(MAP_CONFIG.nodeTypeImages.SHENTONG)
    controller.setSelectedNodeId(node.platformId)
    const selected = container!.querySelector<HTMLElement>('.situation-map-node-marker--selected')!
    expect(selected.querySelector('img')!.src).toBe(MAP_CONFIG.nodeTypeImages.SHENTONG)
    expect(selected.querySelector<HTMLElement>('.situation-map-node')!.style.color).toBe('rgb(245, 185, 66)')
    selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(onSelectNode).toHaveBeenCalledExactlyOnceWith(node.platformId)
    expect(JSON.stringify(node)).toBe(original)
    expect(nodeIconUrl({ type: 'UNKNOWN', id: 'tiantong_sat', name: '天通卫星' })).toBeUndefined()
    expect(nodeIconUrl({ type: 'REAR_COMMAND_NODE', id: 'tiantong_sat', satelliteType: 'TIANTONG' })).toBe(MAP_CONFIG.nodeTypeImages.REAR_COMMAND_NODE)
    expect(nodeIconUrl({ type: 'COMMUNICATION_SATELLITE', id: 'tiantong_sat', satelliteType: 'SHENTONG' })).toBe(MAP_CONFIG.nodeTypeImages.SHENTONG)
    expect(nodeIconUrl({ id: 'tiantong_sat' })).toBe(MAP_CONFIG.nodeTypeImages.TIANTONG)
    expect(nodeIconUrl({ id: 'shentong_sat' })).toBe(MAP_CONFIG.nodeTypeImages.SHENTONG)
  })

  it('真实文件的参考模型名按对应场景类型显示图标与图例，未知类型归入其他节点', () => {
    const cases = [
      ['REAR_COMM_PLATFORM', '■'], ['COMMAND_VEHICLE_PLATFORM', '▼'], ['MISSION_UAV_PLATFORM', '●'],
      ['TIAN_TONG_SAT', '▲'], ['SHEN_TONG_SAT', '▲'], ['GROUND_JAMMER_STATION', '★'], ['AIRBORNE_JAMMER_PLATFORM', '☆'],
    ] as const
    for (const [type, glyph] of cases) expect(nodeGlyph({ type, platformId: type }), type).toBe(glyph)
    const images = ['rear.png', 'comand_vehical1.png', 'UAV.png', 'tiantong_sat.png', 'shentong_sat.png', 'jammer_station.png', 'jammer_airbround.png']
    cases.forEach(([type], index) => expect(nodeIconUrl({ type, platformId: 'CUSTOM-ID' })?.endsWith('/' + images[index])).toBe(true))
    expect(nodeCategory({ type: 'MISSION_UAV_PLATFORM' })).toBe('AIRBORNE_MISSION_CLUSTER')
    expect(nodeCategory({ type: 'SOMETHING_NEW' })).toBeUndefined()
    expect(nodeGlyph({ type: 'SOMETHING_NEW' })).toBe(MAP_CONFIG.nodeFallbackGlyph)
  })

  it.each([
    ['REAR_COMMAND_NODE', 'GROUND_CLUSTER_COMMAND_NODE'],
    ['REAR_COMM_PLATFORM', 'COMMAND_VEHICLE_PLATFORM'],
  ])('指挥节点的地图标签与类型图例一致（%s、%s）', async (rearType, commandType) => {
    const nodes = [
      { ...INITIAL_NODES.nodes[0]!, name: '后方通信车', type: rearType },
      { ...INITIAL_NODES.nodes[1]!, name: '指挥车', type: commandType },
    ]
    const markerSpy = vi.spyOn(L, 'marker')
    await createController({ initialNodes: nodes })
    const markers = markerSpy.mock.results.map(result => result.value as L.Marker)
    const labels = ['公共服务平台后方节点', '无人集群指挥车节点']
    for (const [index, label] of labels.entries()) {
      const marker = markers.find(candidate => candidate.options.title === `选择节点 ${label}`)!
      expect(marker.getElement()?.querySelector('.situation-map-node__name')?.textContent).toBe(label)
      expect(marker.getElement()?.querySelector('img')?.src).toBe(nodeIconUrl(nodes[index]!))
      expect((marker.getTooltip()?.getContent() as HTMLElement).textContent).toBe(`${label} · ${nodes[index]!.name}`)
    }
  })

  it('态势地图节点下方显示中文编码标识而非英文平台 ID', async () => {
    const base = INITIAL_NODES.nodes[0]!
    const nodes = [
      { ...base, platformId: 'rear_comm_vehicle', name: '后方通信车', type: 'REAR_COMMAND_NODE' },
      { ...base, platformId: 'mission_uav_01', name: '中继无人机', type: 'FORWARD_RELAY_NODE' },
      { ...base, platformId: 'command_vehicle', name: '指挥车', type: 'GROUND_CLUSTER_COMMAND_NODE' },
      { ...base, platformId: 'mission_uav_02', name: '任务无人机 U01', type: 'AIRBORNE_MISSION_CLUSTER' },
      { ...base, platformId: 'mission_uav_03', name: '任务无人机 B', type: 'AIRBORNE_MISSION_CLUSTER' },
      { ...base, platformId: 'tiantong_sat', name: '天通卫星', type: 'COMMUNICATION_SATELLITE', satelliteType: 'TIANTONG' as const },
      { ...base, platformId: 'jammer_station_01', name: '地面干扰站', type: 'GROUND_JAMMER_DETECTION_STATION' },
    ]
    const markerSpy = vi.spyOn(L, 'marker')
    await createController({ initialNodes: nodes })
    const markers = markerSpy.mock.results.map(result => result.value as L.Marker)
    const sublabels = markers.map(marker => marker.getElement()?.querySelector('.situation-map-node__id')?.textContent).filter(Boolean)
    expect(sublabels).toEqual([
      '公共服务平台后方节点C1',
      '公共服务平台前出节点R1',
      '无人集群指挥车节点G1',
      '无人机集群U1',
      '无人机集群U2',
      '通信卫星S1',
      '地面干扰站J1',
    ])
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
      // 两颗卫星时需同时在水平（经度）与垂直（纬度）方向拉开距离。
      if (count === 2) {
        expect(Math.abs(points[0]!.latitude - points[1]!.latitude)).toBeGreaterThan(0)
        expect(Math.abs(points[0]!.longitude - points[1]!.longitude)).toBeGreaterThan(0)
      }
      expect(points.reduce((sum, point) => sum + point.longitude, 0) / count).toBeCloseTo(center.longitude, 10)
      expect(points.reduce((sum, point) => sum + point.latitude, 0) / count).toBeCloseTo(center.latitude, 10)
      points.forEach((point, index) => {
        const x = (point.longitude - center.longitude) * Math.cos(center.latitude * Math.PI / 180)
        const y = point.latitude - center.latitude
        expect(Math.hypot(x, y)).toBeCloseTo(MAP_CONFIG.temporarySatelliteSpreadRadiusDegrees, 10)
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

  it.each([
    ['BEFORE', '已切出', 3, 0.55], ['AFTER', '已切入', 5, 0.85], ['BOTH', '', 3, 0.85],
  ] as const)('切换标记 %s 保留体制颜色和线型，共用段照常显示', async (switching, label, weight, opacity) => {
    const polyline = vi.spyOn(L, 'polyline')
    const nodes = fixtureSource.scenario.platforms.map(platform => ({ platformId: platform.id, name: platform.name,
      type: platform.type, ...platform.initialPosition, speed: 0 }))
    const link = structuredClone(fixtureSource.scenario.links.find(link => link.type === 'MICROWAVE')!) as Link
    const controller = await createController({ initialNodes: nodes, configuredLinks: [link] })
    const line = polyline.mock.results.map(result => result.value as L.Polyline)
      .find(line => line.options.className === 'situation-map-configured-link')!
    const element = line.getElement()! as SVGElement
    controller.setConfiguredLinkSwitches(new Map([[link.id, switching]]))
    const badge = () => container!.querySelector('.situation-map-link-badge')?.textContent ?? ''
    expect(badge()).toBe(label)
    expect(line.options).toMatchObject({ color: '#409eff', dashArray: '8 5', weight, opacity })
    expect(element.getAttribute('stroke')).toBe('#409eff')
    controller.setConfiguredLinkStatuses(new Map([[link.id, 'DOWN']]))
    expect(line.getElement()).toBe(element)
    expect(badge()).toBe(label ? `中断 · ${label}` : '中断')
    expect(element.getAttribute('stroke')).toBe('#8b1515')
    controller.setConfiguredLinkStatuses(new Map([[link.id, 'UP']]))
    expect(element.getAttribute('stroke')).toBe('#409eff')
    controller.setConfiguredLinkSwitches(undefined)
    expect(badge()).toBe('')
    expect(line.options).toMatchObject({ color: '#409eff', weight: 3, opacity: 0.85, dashArray: '8 5' })
  })

  function linkTooltipDistances(group: L.LayerGroup): string[] {
    return group.getLayers().flatMap(layer => {
      if (!(layer instanceof L.Polyline)) return []
      const content = layer.getTooltip()?.getContent()
      const row = content instanceof HTMLElement ? content.textContent?.split('\n').find(line => line.startsWith('全程距离：')) : undefined
      return row && row !== '全程距离：暂无数据' ? [row] : []
    }).sort()
  }

  it('悬停连线或点击热区时依次展示链路段和全程指标，移开鼠标即关闭', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const onSelectConfiguredLink = vi.fn()
    const nodes = ['A', 'B', 'C', 'D'].map((platformId, index) => ({
      ...INITIAL_NODES.nodes[1]!, platformId, name: ['后方通信车', '中继机', '无人机U01', '节点D'][index]!,
      type: platformId === 'B' ? 'FORWARD_RELAY_NODE' : 'REAR_COMMAND_NODE', longitude: 120 + index * 0.1,
    }))
    const link: Link = { ...fixtureSource.scenario.links[0]! as Link, id: 'DISTANCE', sourcePlatformId: 'A', targetPlatformId: 'C', relayPlatformId: null, direction: 'FORWARD' }
    const other = { ...link, id: 'OTHER', sourcePlatformId: 'C', targetPlatformId: 'D', distanceM: 810 }
    const controller = await createController({ initialNodes: nodes, configuredLinks: [{ ...link, distanceM: 940 }, other], onSelectConfiguredLink })
    const linkGroup = groups.mock.results[1]!.value as L.LayerGroup
    const line = linkGroup.getLayers()[0] as L.Polyline
    const hit = linkGroup.getLayers()[1] as L.Marker
    const tooltip = () => container!.querySelector('.leaflet-tooltip')
    const hoverLine = () => line.fire('mouseover', { latlng: hit.getLatLng() })

    expect(tooltip()).toBeNull()
    hoverLine()
    const hoverTooltip = tooltip()
    expect(hoverTooltip?.textContent).toContain('全程距离：940 m')
    expect(hoverTooltip?.textContent).not.toContain('810 m')
    const sample = adaptEngineFrameSnapshot(engineSample).data!.links[0]!
    controller.setConfiguredLinks([{
      ...link, relayPlatformId: 'B', distanceM: 940,
      hover: {
        segments: [
          { ...sample, quality: { ...sample.quality, marginDb: 0, delayMs: 1.369 } },
          { ...sample, quality: { ...sample.quality, marginDb: 8 } },
        ],
        path: {
          platformIds: ['A', 'B', 'C'], distanceM: 12530,
          quality: { pathId: 'PATH-1', delayMs: 1.26, rateBps: 2356, gxbDb: 9.5, ber: 1.2e-7, marginDb: 26.3 },
        },
      },
    }, other])
    expect(tooltip()).toBe(hoverTooltip)
    expect(tooltip()?.querySelector('.situation-map-link-tooltip')?.textContent?.split('\n')).toEqual([
      expect.stringMatching(/^链路名称：DISTANCE · /),
      '传输方向：前向',
      '链路段抗干扰余量：',
      '后方通信车 → 中继机  0 dB',
      '中继机 → 无人机U01  8 dB',
      '链路段时延：',
      '后方通信车 → 中继机  1.369 ms',
      '中继机 → 无人机U01  暂无数据',
      '链路延迟：1.26 ms',
      '链路速率：2356 bit/s',
      '干信比(GXB)：9.5 dB',
      '误码率(BER)：1.2e-7',
      '干扰余量：26.3 dB',
      '全程距离：12.53 km',
      '链路走向：后方通信车 → 中继机 → 无人机U01',
      '干扰损耗：4.8 dB',
      '干扰来源：地面干扰站 1（距 18.30 km · EIRP 12.3 dBW）、机载干扰平台 1（距 18.30 km · EIRP 12.3 dBW）',
    ])
    line.fire('mouseout')
    expect(tooltip()).toBeNull()

    hit.fire('mouseover')
    expect(tooltip()?.textContent).toContain('全程距离：12.53 km')
    hit.fire('mouseout')
    expect(tooltip()).toBeNull()
    hit.fire('mouseover')
    controller.setLayerVisible('links', false)
    expect(tooltip()).toBeNull()
    controller.setLayerVisible('links', true)
    expect(tooltip()).toBeNull()
    expect(hit.getElement()?.getAttribute('aria-label')).toContain('DISTANCE')
    expect(hit.getElement()?.hasAttribute('title')).toBe(false)

    hoverLine()
    controller.setConfiguredLinks([{ ...link, sourcePlatformId: 'C', targetPlatformId: 'A', direction: 'REVERSE' }, other])
    expect(tooltip()?.textContent).toContain('DISTANCE')
    expect(tooltip()?.textContent).toContain('传输方向：反向')
    expect(tooltip()?.textContent).toContain('全程距离：暂无数据')
    expect(tooltip()?.textContent).toContain('链路延迟：暂无数据')
    expect(tooltip()?.textContent).toContain('链路段抗干扰余量：暂无数据')
    expect(tooltip()?.textContent).toContain('链路走向：无人机U01 → 后方通信车')
    controller.setConfiguredLinks([other])
    expect(tooltip()).toBeNull()
    expect(onSelectConfiguredLink).not.toHaveBeenCalled()
  })

  it('机群内部链路在聚合和展开时都可悬停查看距离', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const groups = vi.spyOn(L, 'layerGroup')
    const base = INITIAL_NODES.nodes[1]!
    const nodes: SituationMapNode[] = [
      { ...base, platformId: 'UAV-A', type: 'AIRBORNE_MISSION_CLUSTER', side: 'blue', longitude: 119.1 },
      { ...base, platformId: 'UAV-B', type: 'AIRBORNE_MISSION_CLUSTER', side: 'blue', longitude: 119.2 },
      { ...base, platformId: 'UAV-C', type: 'AIRBORNE_MISSION_CLUSTER', side: 'red', longitude: 119.3 },
      { ...base, platformId: 'UAV-D', type: 'AIRBORNE_MISSION_CLUSTER', side: 'red', longitude: 119.35 },
      { ...base, platformId: 'RELAY', type: 'FORWARD_RELAY_NODE', longitude: 119.38 },
      { ...base, platformId: 'GROUND-A', type: 'REAR_COMMAND_NODE', longitude: 119.4 },
      { ...base, platformId: 'GROUND-B', type: 'GROUND_CLUSTER_COMMAND_NODE', longitude: 119.5 },
    ]
    const link = { ...fixtureSource.scenario.links[0]! as Link, relayPlatformId: null }
    const links = [
      { ...link, id: 'GROUP-OUT', sourcePlatformId: 'UAV-A', targetPlatformId: 'GROUND-A', distanceM: 1200 },
      { ...link, id: 'GROUP-IN', sourcePlatformId: 'GROUND-B', targetPlatformId: 'UAV-B', distanceM: 2400 },
      { ...link, id: 'CROSS-GROUP', sourcePlatformId: 'UAV-A', targetPlatformId: 'UAV-C', distanceM: 3600 },
      { ...link, id: 'INTERNAL', sourcePlatformId: 'UAV-A', targetPlatformId: 'UAV-B', distanceM: 900 },
      { ...link, id: 'RELAYED', sourcePlatformId: 'UAV-A', targetPlatformId: 'UAV-B', relayPlatformId: 'RELAY', distanceM: 6100 },
      { ...link, id: 'GROUND', sourcePlatformId: 'GROUND-A', targetPlatformId: 'GROUND-B', distanceM: 500 },
    ]
    const controller = await createController({ initialNodes: nodes, configuredLinks: links })
    const map = mapSpy.mock.results[0]!.value as L.Map
    const clusterZoom = MAP_CONFIG.zoom.uavClusterMax
    const linkGroup = groups.mock.results[1]!.value as L.LayerGroup
    const values = () => linkTooltipDistances(linkGroup)
    const lines = () => Array.from(container!.querySelectorAll('.situation-map-configured-link'))

    map.setZoom(clusterZoom, { animate: false })
    const displayedDistances = ['全程距离：1.20 km', '全程距离：2.40 km', '全程距离：3.60 km',
      '全程距离：500 m', '全程距离：6.10 km', '全程距离：900 m']
    expect(values()).toEqual(displayedDistances)
    const internalLine = linkGroup.getLayers().find((layer): layer is L.Polyline => layer instanceof L.Polyline
      && (layer.getTooltip()?.getContent() as HTMLElement).textContent?.includes('INTERNAL ·') === true)!
    const verifyInternalHover = () => {
      const tooltip = () => container!.querySelector('.leaflet-tooltip')
      expect(tooltip()).toBeNull()
      internalLine.fire('mouseover', { latlng: internalLine.getCenter() })
      expect(tooltip()?.textContent).toContain('全程距离：900 m')
      internalLine.fire('mouseout')
      expect(tooltip()).toBeNull()
    }
    verifyInternalHover()
    const originalLines = lines()
    expect(originalLines).toHaveLength(links.length)
    controller.setConfiguredLinks([{ ...links[0]!, distanceM: 1600 }, ...links.slice(1)])
    displayedDistances[0] = '全程距离：1.60 km'
    expect(values()).toEqual(displayedDistances)

    map.setZoom(clusterZoom + 1, { animate: false })
    expect(values()).toEqual(displayedDistances)
    expect(lines()).toEqual(originalLines)
    verifyInternalHover()
  })

  it('遥测帧更新机群内外链路悬浮提示的距离', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const groups = vi.spyOn(L, 'layerGroup')
    const controller = await createController()
    const map = mapSpy.mock.results[0]!.value as L.Map
    const clusterZoom = MAP_CONFIG.zoom.uavClusterMax
    const frame = structuredClone(SITUATION_FRAME_F00042)
    frame.platforms.find(node => node.platformId === 'UAV-01')!.type = 'AIRBORNE_MISSION_CLUSTER'
    const internalLink = frame.links.find(link => link.linkId === 'L-MW-01')!
    const summary = frame.linkSummaries.find(link => link.sourcePlatform === internalLink.sourcePlatform
      && link.destPlatform === internalLink.destPlatform && link.linkType === internalLink.linkType)!
    internalLink.destPlatform = 'AIR-01'
    summary.destPlatform = 'AIR-01'
    const links = selectSituationLinks(frame)
    const linkGroup = groups.mock.results[1]!.value as L.LayerGroup
    const values = () => linkTooltipDistances(linkGroup)
    const tooltipFor = (id: string) => linkGroup.getLayers()
      .filter((layer): layer is L.Polyline => layer instanceof L.Polyline)
      .map(layer => (layer.getTooltip()?.getContent() as HTMLElement | undefined)?.textContent)
      .find(text => text?.includes(`链路名称：${id} ·`))
    expect(tooltipFor('L-MW-01')).toContain('传输方向：前向')
    expect(tooltipFor('L-DL-03')).toContain('传输方向：反向')

    map.setZoom(clusterZoom, { animate: false })
    controller.setFrame(frame)
    controller.setLinks(links)
    expect(tooltipFor('L-MW-01')).toContain('传输方向：暂无数据')
    expect(values()).toEqual(['全程距离：45.00 km', '全程距离：45.00 km'])
    controller.setLinks(links.map(link => link.detailed
      ? { ...link, detailed: { ...link.detailed, distance: 3000 } } : link))
    expect(values()).toEqual(['全程距离：3.00 km', '全程距离：3.00 km'])
    map.setZoom(clusterZoom + 1, { animate: false })
    expect(values()).toEqual(['全程距离：3.00 km', '全程距离：3.00 km'])
  })

  it('所选场景配置链路可点击和定位，不生成状态、质量或干扰圈，切换配置清除旧线', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const polyline = vi.spyOn(L, 'polyline')
    const marker = vi.spyOn(L, 'marker')
    const circle = vi.spyOn(L, 'circle')
    const fit = vi.spyOn(L.Map.prototype, 'fitBounds')
    const nodes = fixtureSource.scenario.platforms.map(platform => ({ platformId: platform.id, name: platform.name,
      type: platform.type, ...platform.initialPosition, speed: 0 }))
    const overlappingIds = ['L-SAT-05', 'L-MW-05', 'L-MW-06']
    const links = structuredClone(fixtureSource.scenario.links).filter(link => !overlappingIds.includes(link.id)) as Link[]
    links[0]!.enabled = false
    const selected = vi.fn()
    const controller = await createController({ initialNodes: nodes, configuredLinks: links, onSelectConfiguredLink: selected })
    const lines = () => polyline.mock.calls.filter(([, options]) => options?.className === 'situation-map-configured-link')
    expect(lines()).toHaveLength(links.length)
    // 配置连线沿用体制图例样式；停用只降低透明度，不使用红色异常配色。
    const typeColors: Record<string, string> = { SAT: '#67c23a', MICROWAVE: '#409eff', DATALINK: '#e6a23c', LASER: '#b37feb', FIBER: '#20b2aa' }
    expect(lines()[0]![1]).toMatchObject({ color: typeColors[links[0]!.type], opacity: 0.35 })
    for (const [index, link] of links.entries()) expect(lines()[index]![1]?.color).toBe(typeColors[link.type])
    expect(lines().find(([, options]) => options?.dashArray === '8 5') !== undefined).toBe(links.some(link => link.type === 'MICROWAVE'))
    expect(circle).not.toHaveBeenCalled()
    const hitIndex = marker.mock.calls.findIndex(([, options]) => options?.title?.includes(`${links[0]!.id} ·`))
    expect(marker.mock.calls[hitIndex]![1]?.title).toContain('配置停用；暂无运行数据')
    const rendered = polyline.mock.results.map(result => result.value as L.Polyline)
      .filter(line => line.options.className === 'situation-map-configured-link')
    controller.setConfiguredLinkStatuses(new Map([[links[0]!.id, 'DEGRADED']]))
    expect(rendered[0]!.options.color).toBe('#f56c6c')
    controller.setConfiguredLinkStatuses(new Map([[links[0]!.id, 'DOWN']]))
    expect(rendered[0]!.options.color).toBe('#8b1515')
    controller.setConfiguredLinkStatuses(undefined)
    expect(rendered[0]!.options.color).toBe(typeColors[links[0]!.type])
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

  it('配置链路指定中继平台时按源-中继-目标分段连线，点击与定位覆盖中继节点', async () => {
    const polyline = vi.spyOn(L, 'polyline')
    const marker = vi.spyOn(L, 'marker')
    const fit = vi.spyOn(L.Map.prototype, 'fitBounds')
    const nodes: SituationMapNode[] = [
      { ...INITIAL_NODES.nodes[1]!, platformId: 'REAR', name: '后方通信车', type: 'REAR_COMMAND_NODE', longitude: 117.72, latitude: 24.01 },
      { ...INITIAL_NODES.nodes[0]!, platformId: 'SAT', name: '天通卫星', type: 'COMMUNICATION_SATELLITE', satelliteType: 'TIANTONG', longitude: 125.0, latitude: 0.0 },
      { ...INITIAL_NODES.nodes[1]!, platformId: 'RELAY', name: '中继无人机01', type: 'FORWARD_RELAY_NODE', longitude: 118.80, latitude: 24.30 },
      { ...INITIAL_NODES.nodes[1]!, platformId: 'UAV', name: '任务无人机02', type: 'AIRBORNE_MISSION_CLUSTER', longitude: 119.41, latitude: 24.08 },
    ]
    const baseLink = fixtureSource.scenario.links[0]! as Link
    const relayLinks: Link[] = [
      { ...baseLink, id: 'L-SAT-RELAY', type: 'SAT', sourcePlatformId: 'REAR', targetPlatformId: 'UAV', relayPlatformId: 'SAT', enabled: true },
      { ...baseLink, id: 'L-DL-RELAY', type: 'DATALINK', sourcePlatformId: 'REAR', targetPlatformId: 'UAV', relayPlatformId: 'RELAY', enabled: true },
    ]
    const selected = vi.fn()
    const controller = await createController({ initialNodes: nodes, configuredLinks: relayLinks, onSelectConfiguredLink: selected })
    const lineCalls = polyline.mock.calls.filter(([, options]) => options?.className === 'situation-map-configured-link')
    expect(lineCalls).toHaveLength(2)

    const toTuple = (node: SituationMapNode): L.LatLngTuple => {
      const coords = resolvePlatformCoordinates(node, nodes)
      return [coords.latitude, coords.longitude]
    }
    const rearPoint = toTuple(nodes[0]!)
    const satPoint = toTuple(nodes[1]!)
    const relayPoint = toTuple(nodes[2]!)
    const uavPoint = toTuple(nodes[3]!)

    const satPoints = lineCalls[0]![0] as L.LatLngTuple[]
    expect(satPoints[0]).toEqual(rearPoint)
    expect(satPoints[satPoints.length - 1]).toEqual(uavPoint)
    expect(satPoints).toContainEqual(satPoint)

    const dlPoints = lineCalls[1]![0] as L.LatLngTuple[]
    expect(dlPoints[0]).toEqual(rearPoint)
    expect(dlPoints[dlPoints.length - 1]).toEqual(uavPoint)
    expect(dlPoints).toContainEqual(relayPoint)

    const satHitCall = marker.mock.calls.find(([, options]) => options?.title?.includes('L-SAT-RELAY ·'))
    expect(satHitCall?.[1]?.title).toContain('后方通信车 → 天通卫星 → 任务无人机02')
    expect(satHitCall?.[0]).not.toEqual(satPoint)
    const dlHitCall = marker.mock.calls.find(([, options]) => options?.title?.includes('L-DL-RELAY ·'))
    expect(dlHitCall?.[1]?.title).toContain('后方通信车 → 中继无人机01 → 任务无人机02')
    expect(dlHitCall?.[0]).not.toEqual(relayPoint)

    const hitIndex = marker.mock.calls.indexOf(satHitCall!)
    ;(marker.mock.results[hitIndex]!.value as L.Marker).fire('click')
    expect(selected).toHaveBeenCalledWith(relayLinks[0])

    fit.mockClear()
    controller.focusTarget({ kind: 'link', targetId: 'L-SAT-RELAY' })
    expect(fit).toHaveBeenCalledOnce()
    const satBounds = fit.mock.calls[0]![0] as L.LatLngBounds
    expect(satBounds.contains(rearPoint)).toBe(true)
    expect(satBounds.contains(satPoint)).toBe(true)
    expect(satBounds.contains(uavPoint)).toBe(true)

    fit.mockClear()
    controller.focusTarget({ kind: 'link', targetId: 'L-DL-RELAY' })
    expect(fit).toHaveBeenCalledOnce()
    const dlBounds = fit.mock.calls[0]![0] as L.LatLngBounds
    expect(dlBounds.contains(rearPoint)).toBe(true)
    expect(dlBounds.contains(relayPoint)).toBe(true)
    expect(dlBounds.contains(uavPoint)).toBe(true)

    controller.destroy()
  })

  it('合并同制式双向重合线段，保留分支、其他制式和选中链路高亮', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const nodes: SituationMapNode[] = [
      { ...INITIAL_NODES.nodes[1]!, platformId: 'GROUND', longitude: 117.72, latitude: 24.01 },
      { ...INITIAL_NODES.nodes[1]!, platformId: 'RELAY', longitude: 118.80, latitude: 24.30 },
      { ...INITIAL_NODES.nodes[1]!, platformId: 'A', longitude: 119.41, latitude: 24.08 },
      { ...INITIAL_NODES.nodes[1]!, platformId: 'B', longitude: 119.51, latitude: 24.38 },
    ]
    const base = { ...fixtureSource.scenario.links[0]! as Link, enabled: true }
    const links: Link[] = [
      { ...base, id: 'A-FORWARD', type: 'DATALINK', sourcePlatformId: 'GROUND', relayPlatformId: 'RELAY', targetPlatformId: 'A', direction: 'FORWARD' },
      { ...base, id: 'A-RETURN', type: 'DATALINK', sourcePlatformId: 'A', relayPlatformId: 'RELAY', targetPlatformId: 'GROUND', direction: 'REVERSE' },
      { ...base, id: 'B-FORWARD', type: 'DATALINK', sourcePlatformId: 'GROUND', relayPlatformId: 'RELAY', targetPlatformId: 'B', direction: 'FORWARD' },
      { ...base, id: 'B-RETURN', type: 'DATALINK', sourcePlatformId: 'B', relayPlatformId: 'RELAY', targetPlatformId: 'GROUND', direction: 'REVERSE' },
      { ...base, id: 'DIRECT-MW', type: 'MICROWAVE', sourcePlatformId: 'GROUND', relayPlatformId: null, targetPlatformId: 'RELAY' },
    ]
    const selected = vi.fn()
    const controller = await createController({ initialNodes: nodes, configuredLinks: links, onSelectConfiguredLink: selected })
    const linkGroup = groups.mock.results[1]!.value as L.LayerGroup
    const linesBetween = (from: string, to: string) => linkGroup.getLayers().filter((layer): layer is L.Polyline => {
      if (!(layer instanceof L.Polyline)) return false
      const endpoints = (layer.getLatLngs() as L.LatLng[]).flatMap(point => {
        const node = nodes.find(candidate => point.equals([candidate.latitude, candidate.longitude]))
        return node ? [node.platformId] : []
      })
      return endpoints.some((id, index) => (id === from && endpoints[index + 1] === to) || (id === to && endpoints[index + 1] === from))
    })

    expect(linesBetween('GROUND', 'RELAY').map(line => line.options.color).sort()).toEqual(['#409eff', '#e6a23c'])
    expect(linesBetween('RELAY', 'A')).toHaveLength(1)
    expect(linesBetween('RELAY', 'B')).toHaveLength(1)
    linesBetween('RELAY', 'B')[0]!.fire('click')
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(/^B-/u) }))

    controller.focusTarget({ kind: 'link', targetId: 'A-RETURN' })
    expect(linesBetween('GROUND', 'RELAY').filter(line => line.options.color === '#e6a23c').map(line => line.options.weight)).toEqual([5])
    expect(linesBetween('RELAY', 'A').map(line => line.options.weight)).toEqual([5])
    expect(linesBetween('RELAY', 'B')).toHaveLength(1)
  })

  it('态势地图前向与返向始终合并为一条线，任一方向受扰或中断时直接变红并保留双方向弹窗入口', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const selected = vi.fn()
    const nodes = [
      { ...INITIAL_NODES.nodes[1]!, platformId: 'A', latitude: 25, longitude: 118.92 },
      { ...INITIAL_NODES.nodes[1]!, platformId: 'B', latitude: 25, longitude: 119.08 },
    ]
    const forward: Link = { ...fixtureSource.scenario.links[0]! as Link, id: 'MW-FORWARD', type: 'MICROWAVE',
      sourcePlatformId: 'A', targetPlatformId: 'B', direction: 'FORWARD', relayPlatformId: null }
    const reverse: Link = { ...forward, id: 'MW-REVERSE', direction: 'REVERSE', sourcePlatformId: 'B', targetPlatformId: 'A' }
    const controller = await createController({ initialNodes: nodes, configuredLinks: [forward, reverse],
      separateLinkDirections: true, selectNearbyLinks: true, onSelectConfiguredLink: selected })
    const linkGroup = groups.mock.results[1]!.value as L.LayerGroup
    const currentLines = () => linkGroup.getLayers().filter((layer): layer is L.Polyline => layer instanceof L.Polyline)
    // 初始未收到运行状态时，前向/返向也合并为一条线。
    expect(currentLines().map(line => [line.options.color, line.options.weight])).toEqual([['#409eff', 3]])
    currentLines()[0]!.fire('click')
    expect(selected).toHaveBeenCalledExactlyOnceWith(forward, reverse)
    selected.mockClear()

    controller.setSelectedNodeId('A')
    controller.setConfiguredLinkStatuses(new Map([[forward.id, 'UP'], [reverse.id, 'UP']]))
    expect(currentLines().map(line => [line.options.color, line.options.weight])).toEqual([['#409eff', 3]])
    currentLines()[0]!.fire('click')
    expect(selected).toHaveBeenCalledExactlyOnceWith(forward, reverse)
    const badge = () => container!.querySelector('.situation-map-link-badge')?.textContent ?? ''
    controller.setConfiguredLinkSwitches(new Map([[forward.id, 'BEFORE'], [reverse.id, 'AFTER']]))
    expect(badge()).toBe('前向切出 · 返向切入')
    controller.setConfiguredLinkSwitches(new Map([[forward.id, 'BOTH'], [reverse.id, 'BEFORE']]))
    expect(badge()).toBe('返向切出')
    controller.setConfiguredLinkSwitches(new Map([[forward.id, 'BOTH'], [reverse.id, 'BOTH']]))
    expect(badge()).toBe('')
    controller.setConfiguredLinkSwitches(undefined)
    selected.mockClear()

    // 仅前向中断时不再拆出第二条线，直接将合并链路染深红并标「前向中断」。
    controller.setSelectedNodeId('A')
    controller.setConfiguredLinkStatuses(new Map([[forward.id, 'DOWN'], [reverse.id, 'UP']]))
    expect(currentLines().map(line => [line.options.color, line.options.weight])).toEqual([['#8b1515', 3]])
    expect(badge()).toBe('前向中断')
    expect(currentLines()[0]!.getElement()?.classList.contains('situation-map-configured-link--directional')).toBe(true)
    currentLines()[0]!.fire('click')
    expect(selected).toHaveBeenLastCalledWith(forward, reverse)

    // 仅返向劣化时仍为一条线并染浅红，点击优先定位异常的返向，同时携带前向供弹窗切换。
    controller.setSelectedNodeId('A')
    controller.setConfiguredLinkStatuses(new Map([[forward.id, 'UP'], [reverse.id, 'DEGRADED']]))
    expect(currentLines().map(line => [line.options.color, line.options.weight])).toEqual([['#f56c6c', 3]])
    expect(badge()).toBe('返向劣化')
    currentLines()[0]!.fire('click')
    expect(selected).toHaveBeenLastCalledWith(reverse, forward)

    // 双方向均中断时合为一条深红线并标「中断」。
    controller.setSelectedNodeId('A')
    controller.setConfiguredLinkStatuses(new Map([[forward.id, 'DOWN'], [reverse.id, 'DOWN']]))
    expect(currentLines().map(line => [line.options.color, line.options.weight])).toEqual([['#8b1515', 3]])
    expect(badge()).toBe('中断')
    currentLines()[0]!.fire('click')
    expect(selected).toHaveBeenLastCalledWith(forward, reverse)

    controller.setConfiguredLinks([forward])
    expect(currentLines()[0]!.getElement()?.classList.contains('situation-map-configured-link--directional')).toBe(false)
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
    // 登记关联使用半透明细线，保留各体制颜色和线型。
    expect(calls().map(([, options]) => options?.dashArray)).toEqual([undefined, '8 5'])
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
      ['#e6a23c', '2 5'], ['#20b2aa', undefined],
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

  it.each(['FORWARD', 'REVERSE'] as const)('业务链路与登记关联分层渲染：%s 不显示方向文字，保留实线箭头和登记点线', async (direction) => {
    const groups = vi.spyOn(L, 'layerGroup')
    const mapSpy = vi.spyOn(L, 'map')
    const fileLinks = selectFileCommunicationLinks(FILE_CONNECTIONS, 5)
    const messageLink = { ...MESSAGE_LINK, direction }
    const controller = await createController({ initialNodes: SATELLITE_FILE_NODES, fileLinks, fileMessageLinks: [messageLink] })
    const map = mapSpy.mock.results[0]?.value as L.Map
    const businessGroup = groups.mock.results[1]!.value as L.LayerGroup
    const potentialGroup = groups.mock.results[3]!.value as L.LayerGroup
    // 业务链路仅保留连线、命中点和方向箭头；登记关联为两条连线和两个命中点。
    expect(businessGroup.getLayers()).toHaveLength(3)
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
    expect(container!.querySelector('.situation-map-link-direction')).toBeNull()
    controller.setFileMessageLinks([messageLink])
    expect(container!.querySelector('.situation-map-link-direction__text')).toBeNull()
    expect(businessGroup.getLayers()).toHaveLength(3)
    expect(messageLink.direction).toBe(direction)
    // 业务链路用实线，登记关联用半透明点线。
    const businessLine = (businessGroup.getLayers() as L.Polyline[]).find(layer => layer instanceof L.Polyline)!
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

  it('各链路只按新的消息投递触发脉冲，无新消息、重复刷新和位置更新不重复播放', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const makeLink = (id: string, times: number[]): FileMessageLink => ({ ...MESSAGE_LINK, id,
      records: times.map((time, index) => ({ ...MESSAGE_LINK.records[0]!, time,
        sourceEventId: `${id}-receive-${index}`, transmitEventId: `${id}-send-${index}` })),
    })
    const links = [makeLink('frequent', [0.5, 2.5, 2.6, 4.5]), makeLink('sparse', [3.5])]
    const groups = vi.spyOn(L, 'layerGroup')
    const controller = await createController({ initialNodes: SATELLITE_FILE_NODES, fileMessageLinks: links })
    const flows = groups.mock.results[2]!.value as L.LayerGroup
    const path = (index: number) => (flows.getLayers()[index] as L.Polyline).getElement() as SVGPathElement
    const clock = (time: number) => controller.setFilePlayback({ time, playing: true, speed: 1, key: 'a' })
    clock(0)
    expect(path(0).style.visibility).toBe('hidden')
    expect(path(4).style.visibility).toBe('hidden')
    now = 1000
    clock(1)
    expect(path(0).style.visibility).toBe('')
    expect(path(4).style.visibility).toBe('hidden')
    const restart = vi.spyOn(path(0), 'getBoundingClientRect')
    controller.setFileMessageLinks(structuredClone(links))
    controller.setNodes(SATELLITE_FILE_NODES.map(node => ({ ...node, latitude: node.latitude + 0.01 })))
    clock(1)
    now = 2000
    clock(2)
    expect(restart).not.toHaveBeenCalled()
    now = 3000
    clock(3)
    expect(restart).toHaveBeenCalledTimes(1) // 同一刷新区间的两条消息合并为一颗。
    expect(path(4).style.visibility).toBe('hidden')
    now = 4000
    clock(4)
    expect(path(4).style.visibility).toBe('')
    expect(restart).toHaveBeenCalledTimes(1)
    now = 5000
    clock(5)
    expect(restart).toHaveBeenCalledTimes(2)
    now = 7000
    clock(7)
    expect(restart).toHaveBeenCalledTimes(2)
    expect(links[0]!.records).toHaveLength(4)
    controller.destroy()
  })

  it.each([16, 32])('%s 倍播放只加快事件触发，流星仍用固定现实时间且密集消息不堆积', async speed => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const groups = vi.spyOn(L, 'layerGroup')
    const link = { ...MESSAGE_LINK, records: [1, speed + 1, speed * 2 + 1].map((time, index) => ({
      ...MESSAGE_LINK.records[0]!, time, transmitEventId: `send-${index}`, sourceEventId: `receive-${index}`,
    })) }
    const controller = await createController({ initialNodes: SATELLITE_FILE_NODES, fileMessageLinks: [link] })
    const clock = (time: number, rate = speed) => controller.setFilePlayback({ time, speed: rate, playing: true, key: 'a' })
    clock(0)
    now = 1000
    clock(speed)
    const flow = groups.mock.results[2]!.value as L.LayerGroup
    const path = (flow.getLayers()[0] as L.Polyline).getElement() as SVGPathElement
    expect(path.style.animationDuration).toBe('1.4s')
    expect(path.style.animationDelay).toBe('0ms') // 不能用十几秒的数据年龄跳过整颗流星。
    const restart = vi.spyOn(path, 'getBoundingClientRect')
    now = 1200
    clock(speed, 1)
    clock(speed, speed)
    expect(restart).not.toHaveBeenCalled() // 在途切换倍速不改变流星进度。
    clock(speed * 2)
    expect(path.style.animationDuration).toBe('1.4s')
    expect(path.style.animationDelay).toBe('0ms') // 合并投递时由浏览器接续播放，不重写动画。
    expect(restart).not.toHaveBeenCalled()
    expect(flow.getLayers()).toHaveLength(4)
    now = 2600
    clock(speed * 3)
    expect(path.style.animationDelay).toBe('0ms')
    expect(path.style.animationDuration).toBe('1.4s')
    expect(link.records).toHaveLength(3)
    controller.destroy()
  })

  it('消息脉冲取配对证据的发送时刻，接收记录跨刷新边界不漏播也不重复触发', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const groups = vi.spyOn(L, 'layerGroup')
    const earlier = { ...MESSAGE_LINK.records[0]!, time: 0.2, delayS: 0.1 }
    const later = { ...earlier, time: 1.021, delayS: 0.121, transmitEventId: 'next-send', sourceEventId: 'next-receive' }
    const visible = { ...MESSAGE_LINK, records: [earlier] }
    const evidence = [{ ...visible, records: [earlier, later] }]
    const controller = await createController({ initialNodes: SATELLITE_FILE_NODES, fileMessageLinks: [visible] })
    controller.setFilePlayback({ time: 0.5, playing: true, speed: 1, key: 'a' }, evidence)
    controller.setFilePlayback({ time: 1, playing: true, speed: 1, key: 'a' }, evidence)
    const flow = groups.mock.results[2]!.value as L.LayerGroup
    const path = (flow.getLayers()[0] as L.Polyline).getElement() as SVGPathElement
    expect(path.style.visibility).toBe('')
    expect(parseFloat(path.style.animationDelay)).toBe(0) // 0.9 的发送已触发；展示从起点开始，不等待 1.021 的接收。
    const restart = vi.spyOn(path, 'getBoundingClientRect')
    controller.setFileMessageLinks(evidence)
    controller.setFilePlayback({ time: 1.1, playing: true, speed: 1, key: 'a' }, evidence)
    expect(restart).not.toHaveBeenCalled()
    controller.destroy()
  })

  it('消息脉冲暂停冻结、恢复与倍速不重置进度，关闭再开启不补播已完成脉冲', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const groups = vi.spyOn(L, 'layerGroup')
    const controller = await createController({ initialNodes: SATELLITE_FILE_NODES, fileMessageLinks: [MESSAGE_LINK] })
    const clock = (time: number, playing = true, speed = 1) => controller.setFilePlayback({ time, playing, speed, key: 'a' })
    clock(0)
    now = 2000
    clock(2)
    const flow = groups.mock.results[2]!.value as L.LayerGroup
    const path = () => (flow.getLayers()[0] as L.Polyline).getElement() as SVGPathElement
    now = 2300
    clock(2, false)
    expect(path().style.animationPlayState).toBe('paused')
    expect(parseFloat(path().style.animationDelay)).toBeCloseTo(-300)
    now = 8000
    clock(2, true, 2)
    expect(path().style.animationPlayState).toBe('running')
    expect(path().style.animationDuration).toBe('1.4s')
    expect(parseFloat(path().style.animationDelay)).toBeCloseTo(-300)
    controller.setLayerVisible('flow', false)
    now = 10000
    controller.setLayerVisible('flow', true)
    expect(path().style.animationDelay).toBe('-1400ms') // 已播完，重挂载仍在不可见的尾帧。
    controller.destroy()
  })

  it('定位、倒退、换源和暂停加载不补播旧消息，重新播放仅触发后续事件', async () => {
    const groups = vi.spyOn(L, 'layerGroup')
    const controller = await createController({ initialNodes: SATELLITE_FILE_NODES, fileMessageLinks: [MESSAGE_LINK] })
    const flow = groups.mock.results[2]!.value as L.LayerGroup
    const hidden = () => ((flow.getLayers()[0] as L.Polyline).getElement() as SVGPathElement).style.visibility === 'hidden'
    const clock = (time: number, playing: boolean, key = 'a') => controller.setFilePlayback({ time, playing, key, speed: 1 })
    clock(2, false)
    expect(hidden()).toBe(true)
    clock(2, true)
    expect(hidden()).toBe(true)
    clock(0, true)
    clock(2, true)
    expect(hidden()).toBe(false)
    clock(2805, true, 'a:seek-1')
    expect(hidden()).toBe(true)
    clock(0, false)
    expect(hidden()).toBe(true)
    clock(0, true)
    clock(2, true)
    expect(hidden()).toBe(false)
    clock(2, true, 'b')
    expect(hidden()).toBe(true)
    controller.setFileMessageLinks([])
    expect(flow.getLayers()).toHaveLength(0)
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
    expect(line.options.color).toBe('#8b1515')
    expect(element.getAttribute('aria-label')).toContain('中断')
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
    expect(lineOptions[3]?.dashArray).toBe('12 4 2 4')

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
    expect(container?.querySelector('.situation-map-node-marker--selected')?.textContent).toContain('通信卫星S1')

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
    expect((currentLinkLines[0]?.line.getElement() as SVGElement)?.style.getPropertyValue('--situation-link-color')).toBe(currentLinkLines[0]?.line.options.color)

    controller.destroy()
  })

  it('态势地图仅在点击时选择容差内最近的可见链路，直点链路与节点优先', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const lineSpy = vi.spyOn(L, 'polyline')
    const distanceCheck = vi.spyOn(L.Polyline.prototype, 'closestLayerPoint')
    const selected = vi.fn()
    const selectedNode = vi.fn()
    const base = INITIAL_NODES.nodes[0]!
    const node = (platformId: string, latitude: number, longitude: number) => ({
      ...base, platformId, latitude, longitude, type: 'REAR_COMMAND_NODE',
    })
    const nodes = [node('A', 25, 118.9), node('B', 25, 119.1), node('C', 25.01, 118.9), node('D', 25.01, 119.1)]
    const baseLink = fixtureSource.scenario.links[0]! as Link
    const link = (id: string, sourcePlatformId: string, targetPlatformId: string): Link => ({
      ...baseLink, id, sourcePlatformId, targetPlatformId, type: 'MICROWAVE', relayPlatformId: null,
    })
    const links = [link('AB', 'A', 'B'), link('CD', 'C', 'D')]
    const controller = await createController({ initialNodes: nodes, configuredLinks: links, selectNearbyLinks: true,
      onSelectConfiguredLink: selected, onSelectNode: selectedNode })
    const map = mapSpy.mock.results[0]!.value as L.Map
    const surface = map.getContainer()
    Object.defineProperties(surface, { clientWidth: { value: 800 }, clientHeight: { value: 500 } })
    map.invalidateSize({ pan: false })
    map.setView([25, 119], 10)
    const dispatchClick = (target: Element, point: L.Point) => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: point.x, clientY: point.y }))
    }
    const near = map.latLngToContainerPoint([25.01, 118.95]).add([0, 3])
    const [lower, upper] = Array.from(surface.querySelectorAll('.situation-map-configured-link'))
    expect(lineSpy.mock.calls.filter(([, options]) => options?.className === 'situation-map-configured-link')).toHaveLength(2)
    expect(upper?.getAttribute('stroke-width')).toBe('3')
    surface.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: near.x, clientY: near.y }))
    expect(distanceCheck).not.toHaveBeenCalled()
    expect(selected).not.toHaveBeenCalled()
    dispatchClick(surface, near)
    expect(selected).toHaveBeenCalledExactlyOnceWith(links[1])

    selected.mockClear()
    dispatchClick(lower!, map.latLngToContainerPoint([25, 118.95]))
    expect(selected).toHaveBeenCalledExactlyOnceWith(links[0])
    selected.mockClear()
    dispatchClick(surface.querySelector('.situation-map-node-marker')!, map.latLngToContainerPoint([25, 118.9]))
    expect(selectedNode).toHaveBeenCalledExactlyOnceWith('A')
    expect(selected).not.toHaveBeenCalled()
    dispatchClick(surface, near.add([0, 25]))
    expect(selected).not.toHaveBeenCalled()

    const keyboardTarget = surface.querySelector('.situation-map-configured-link-hit')!
    expect(keyboardTarget.classList.contains('leaflet-interactive')).toBe(false)
    keyboardTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(selected).toHaveBeenCalledExactlyOnceWith(links[0])
    selected.mockClear()

    const belowLink = (pixels: number) => map.latLngToContainerPoint([25, 118.95]).add([0, pixels])
    dispatchClick(surface, belowLink(10))
    expect(selected).not.toHaveBeenCalled()
    map.setView([25, 119], 12, { animate: false })
    dispatchClick(surface, belowLink(10))
    expect(selected).toHaveBeenCalledExactlyOnceWith(links[0])
    selected.mockClear()
    dispatchClick(surface, belowLink(13))
    expect(selected).not.toHaveBeenCalled()

    controller.setLayerVisible('links', false)
    dispatchClick(surface, belowLink(10))
    expect(selected).not.toHaveBeenCalled()
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
    expect(MAP_CONFIG.defaults).toEqual({ theme: 'dark', basemap: 'vector', basemapLabelsVisible: false, zoom: 10, gridVisible: false, trailsVisible: false })
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
    expect(container?.querySelector('.situation-map-node-marker--selected')?.textContent).toContain('公共服务平台前出节点R1')

    polylineSpy.mockClear()
    controller.focusTarget({ kind: 'link', targetId: 'L-MW-01' })
    const linkBounds = fitBoundsSpy.mock.calls[0]?.[0] as L.LatLngBounds
    expect(linkBounds.contains([24.70, 119.35])).toBe(true)
    // L-MW-01 按新模板为高空前出中继节点 → 后方指挥节点（CMD-01）。
    expect(linkBounds.contains([24.45, 118.15])).toBe(true)
    expect(fitBoundsSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      padding: [24, 24],
      maxZoom: MAP_CONFIG.zoom.linkFocusMax,
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
    expect(container?.querySelector('.situation-map-node-marker--selected')?.textContent).toContain('地面干扰站J1')

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
    expect(container?.querySelector('.situation-map-node-marker--selected')?.textContent).toContain('地面干扰站J1')
    expect(circleSpy).not.toHaveBeenCalled()
    expect(circles.some(circle => circle.options.className === 'situation-map-interference--selected')).toBe(false)

    controller.focusTarget({ kind: 'node', targetId: 'AIR-03' })
    expect(setViewSpy).toHaveBeenNthCalledWith(3, [24.43, 119.99], 10, {
      animate: true,
      duration: 0.45,
    })
    expect(container?.querySelector('.situation-map-node-marker--selected')?.textContent).toContain('无人机集群U3')

    controller.focusTarget({ kind: 'node', targetId: 'NODE-NOT-FOUND' })
    controller.focusTarget({ kind: 'link', targetId: 'LINK-NOT-FOUND' })
    controller.focusTarget({ kind: 'interference', targetId: 'JAMMER-NOT-FOUND' })
    expect(setViewSpy).toHaveBeenCalledTimes(3)
    expect(fitBoundsSpy).toHaveBeenCalledTimes(2)

    controller.destroy()
  })

  it.each(['dark', 'light'] as const)('%s 主题默认隐藏底图文字，切换底图和缩放换肤不恢复文字，保留节点名称', async (initialTheme) => {
    const mapSpy = vi.spyOn(L, 'map')
    const node = { ...INITIAL_NODES.nodes[0]!, platformId: 'LABEL-TEST', name: '测试节点' }
    const controller = await createController({ initialNodes: [node], initialTheme })
    const { MAP_CONFIG: activeConfig } = await import('../../src/config/map.config')
    const map = mapSpy.mock.results[0]!.value as L.Map
    expect(activeConfig.defaults.basemapLabelsVisible).toBe(false)
    expect(offlineLabelLayerMock.create).not.toHaveBeenCalled()
    expect(container?.querySelector('[title="选择节点 测试节点"]')?.textContent).toContain('测试节点')

    map.setView([24, 119], 9, { animate: false })
    const alternateTheme = initialTheme === 'dark' ? 'light' : 'dark'
    controller.setTheme(alternateTheme)
    controller.setBasemap('satellite')
    controller.setTheme(initialTheme)
    controller.setBasemap('vector')
    vi.spyOn(map, 'getZoom').mockReturnValue(7.5)
    controller.setTheme(alternateTheme)

    expect(offlineLabelLayerMock.create).not.toHaveBeenCalled()
    expect(offlineLabelLayerMock.setTheme).not.toHaveBeenCalled()
    expect(map.hasLayer(vectorGridLayer as MockVectorGridLayer)).toBe(true)
    expect(container?.querySelector('[title="选择节点 测试节点"]')?.textContent).toContain('测试节点')
    controller.destroy()
    controller.destroy()
  })

  it('整数缩放在同一 VectorGrid 上幂等重绘且保持视图与关闭的经纬网状态', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const layerGroupSpy = vi.spyOn(L, 'layerGroup')
    const controller = await createController({ basemapLabelsVisible: true, initialTheme: 'light' })
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
    const controller = await createController({ basemapLabelsVisible: true, initialTheme: 'light' })
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
    const controller = await createController({ basemapLabelsVisible: true, initialTheme: 'light' })
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
    const controller = await createController({ basemapLabelsVisible: true })
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
      const displayName = platform.type === 'REAR_COMMAND_NODE'
        ? '公共服务平台后方节点'
        : platform.type === 'GROUND_CLUSTER_COMMAND_NODE'
          ? '无人集群指挥车节点'
          : platform.name
      const call = nodeCalls.find(([, options]) => options?.title?.includes(displayName))
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
      // UAV-01 与 CMD-01 之间有激光、微波、卫星三种制式：按类型排序后微波居中保持直线，
      // 激光（L-LASER-04）与卫星（L-SAT-02）向两侧分离；其余节点对只有一种制式，保持直线。
      if (summary.sourcePlatform !== 'CMD-01' || summary.destPlatform !== 'UAV-01') {
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
    const controller = await createController({ basemapLabelsVisible: true })
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
    let link = container?.querySelector<HTMLElement>('.situation-map-link-keyboard-hit[aria-label]')
    const linkMarker = markerSpy.mock.results.find(({ value }) => (
      (value as L.Marker).getElement() === link
    ))?.value as L.Marker | undefined

    expect(link).not.toBeNull()
    expect(link?.style.opacity).not.toBe('0')
    link?.focus()
    expect(document.activeElement).toBe(link)

    linkMarker?.fire('click')
    expect(onSelectLink).toHaveBeenCalledOnce()
    expect(onSelectLink).toHaveBeenCalledWith(SITUATION_LINKS_F00042[0])

    link = container?.querySelector<HTMLElement>('.situation-map-link-keyboard-hit[aria-label]')
    onSelectLink.mockClear()
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    link?.dispatchEvent(enterEvent)
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(onSelectLink).toHaveBeenCalledOnce()
    expect(onSelectLink).toHaveBeenCalledWith(SITUATION_LINKS_F00042[0])

    link = container?.querySelector<HTMLElement>('.situation-map-link-keyboard-hit[aria-label]')
    onSelectLink.mockClear()
    const spaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    link?.dispatchEvent(spaceEvent)
    expect(spaceEvent.defaultPrevented).toBe(true)
    expect(onSelectLink).toHaveBeenCalledOnce()
    expect(onSelectLink).toHaveBeenCalledWith(SITUATION_LINKS_F00042[0])

    controller.destroy()
  })

  it('同一场景修订恢复地图中心与缩放，另一修订使用任务视野', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const controller = await createController()
    const map = mapSpy.mock.results[0]!.value as L.Map
    controller.setViewportKey('user:scene:1')
    map.setView([25, 119], 10, { animate: false })
    const center = map.getCenter()
    controller.setViewportKey(undefined)
    controller.setViewportKey('user:scene:1')
    expect(map.getZoom()).toBe(10)
    expect(map.getCenter().equals(center)).toBe(true)
    controller.setViewportKey('user:scene:2')
    expect(map.getCenter().equals(center)).toBe(false)
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

  it('实时配对共用一张流向画布，保留分道、暂停续播、去重和开关行为', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(L.Map.prototype, 'getSize').mockReturnValue(L.point(1024, 768))
    const context = { setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    const scheduled = new Map<number, FrameRequestCallback>()
    let callbackId = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      scheduled.set(++callbackId, callback)
      return callbackId
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { scheduled.delete(id) })
    const paint = (time: number) => {
      now = time
      const queued = [...scheduled.values()]
      scheduled.clear()
      context.moveTo.mockClear()
      for (const callback of queued) callback(time)
      return context.moveTo.mock.calls
    }
    const nodes = ['CMD-01', 'SAT-01', 'AIR-01', 'AIR-02'].map((platformId, index) => ({
      ...SATELLITE_FILE_NODES[index % 2]!,
      platformId,
      name: ['后方车', '天通卫星', '无人机1', '无人机2'][index]!,
      longitude: 118.5 + index * 0.6,
      latitude: 24.5 + (index % 2) * 0.5,
    }))
    const configured: Link[] = [
      {
        id: 'LNK-SAT-01', type: 'SAT', sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', relayPlatformId: 'SAT-01',
        frequency: 12000, bandwidth: 20, txPower: 50, antennaGain: { tx: 30, rx: 30 }, direction: 'FORWARD', modulation: 'QPSK', berThreshold: 1e-6, dataRate: 20, enabled: true,
      },
      {
        id: 'LNK-MW-01', type: 'MICROWAVE', sourcePlatformId: 'AIR-01', targetPlatformId: 'AIR-02',
        frequency: 5000, bandwidth: 10, txPower: 20, antennaGain: { tx: 15, rx: 15 }, direction: 'REVERSE', modulation: 'QPSK', berThreshold: 1e-5, dataRate: 10, enabled: true,
      },
    ]
    const controller = await createController({
      initialNodes: nodes,
      configuredLinks: configured,
    })
    controller.setConfiguredLinkStatuses(new Map([['LNK-SAT-01', 'UP'], ['LNK-MW-01', 'UP']]))
    // 只有配置与 UP 状态时没有流向脉冲。
    const canvas = () => container!.querySelectorAll('canvas.situation-map-live-flow')
    expect(canvas()).toHaveLength(0)

    // 混合前向、返向与未知业务方向，以及一跳转发、多接收端（AIR-01 / AIR-02）
    const baseLanes: import('../../src/features/situation/live-message-flows').LiveMessageFlowLane[] = [
      {
        id: 'hop-cmd-sat-fwd', type: 'SAT', sourcePlatformId: 'CMD-01', targetPlatformId: 'SAT-01',
        sourceDeviceId: 'sat_link_a', targetDeviceId: 'sat_link', direction: 'FORWARD',
        messageTypes: ['kForwardSituation'], records: [], firstTimeS: 1, lastTimeS: 1,
        messageCount: 1, pulseId: 'RUN-1:1:ev-1', latestDeliveryTimeS: 1.12, latestDelayS: 0.12,
      },
      {
        id: 'hop-cmd-sat-rev', type: 'SAT', sourcePlatformId: 'CMD-01', targetPlatformId: 'SAT-01',
        sourceDeviceId: 'sat_link_a', targetDeviceId: 'sat_link', direction: 'REVERSE',
        messageTypes: ['kReturnReconStatus'], records: [], firstTimeS: 1, lastTimeS: 1,
        messageCount: 1, pulseId: 'RUN-1:1:ev-2', latestDeliveryTimeS: 1.13, latestDelayS: 0.12,
      },
      {
        id: 'hop-sat-cmd-unk', type: 'SAT', sourcePlatformId: 'SAT-01', targetPlatformId: 'CMD-01',
        sourceDeviceId: 'sat_link', targetDeviceId: 'sat_link_a', direction: undefined,
        messageTypes: ['CUSTOM_RAW'], records: [], firstTimeS: 1, lastTimeS: 1,
        messageCount: 1, pulseId: 'RUN-1:1:ev-3', latestDeliveryTimeS: 1.14, latestDelayS: 0.12,
      },
      {
        id: 'hop-air-1-2', type: 'MICROWAVE', sourcePlatformId: 'AIR-01', targetPlatformId: 'AIR-02',
        sourceDeviceId: 'mw_1', targetDeviceId: 'mw_2', direction: 'FORWARD',
        messageTypes: ['CMD_ORDER'], records: [], firstTimeS: 1, lastTimeS: 1,
        messageCount: 1, pulseId: 'RUN-1:1:ev-4', latestDeliveryTimeS: 1.01, latestDelayS: 0.01,
      },
    ]

    now = 1000
    controller.setLiveMessageFlows?.(baseLanes, { playing: true, runKey: 'RUN-1' })
    const laneHeads = paint(1500)
    expect(canvas()).toHaveLength(1)
    expect(container!.querySelectorAll('.situation-map-link-flow, .situation-map-flow-direction')).toHaveLength(0)
    expect(laneHeads).toHaveLength(4)
    expect(new Set(laneHeads.slice(0, 3).map(point => point.join(','))).size).toBe(3)

    // 暂停时保持相位。位置更新会用新坐标重绘，恢复后才继续前进。
    controller.setLiveMessageFlows?.(baseLanes, { playing: false, runKey: 'RUN-1' })
    const paused = paint(1500)
    expect(paint(3200)).toHaveLength(0)
    controller.setNodes(nodes.map(n => ({ ...n, latitude: n.latitude + 0.1 })))
    const moved = paint(3200)
    expect(moved).not.toEqual(paused)
    expect(moved).toHaveLength(4)
    controller.setLiveMessageFlows?.(structuredClone(baseLanes), { playing: true, runKey: 'RUN-1' })
    expect(paint(3200)).toEqual(moved)
    expect(paint(3300)).not.toEqual(moved)

    // 同一脉冲尚在途中时合并新投递，保持当前相位。
    const beforeBurst = paint(3400)
    const burstLanes = baseLanes.map((lane, index) => index === 0 ? { ...lane, pulseId: 'RUN-1:1:ev-99' } : lane)
    controller.setLiveMessageFlows?.(burstLanes, { playing: true, runKey: 'RUN-1' })
    expect(paint(3400)).toEqual(beforeBurst)

    controller.setLayerVisible('flow', false)
    expect(canvas()).toHaveLength(0)
    expect(paint(5200)).toHaveLength(0)
    controller.setLayerVisible('flow', true)
    expect(paint(5200)).toHaveLength(0)
    expect(canvas()).toHaveLength(0)

    // 换运行会清空去重状态，相同的投递标识可在新运行播放。
    controller.setLiveMessageFlows?.(burstLanes, { playing: true, runKey: 'RUN-2' })
    expect(paint(5400)).toHaveLength(4)
    controller.setLiveMessageFlows?.([], { playing: false, runKey: 'RUN-3' })
    expect(canvas()).toHaveLength(0)
    expect(paint(5500)).toHaveLength(0)
    controller.destroy()
  })

  it('文件回放同一链路混合前返向时分别绘制脉冲，不显示方向徽标', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const mixedLink: FileMessageLink = {
      ...MESSAGE_LINK,
      direction: undefined,
      messageTypes: ['CMD_ORDER', 'STATUS_REPORT'],
      records: [
        { ...MESSAGE_LINK.records[0]!, time: 1.5, messageType: 'CMD_ORDER', sourceEventId: 'R-1', transmitEventId: 'T-1' },
        { ...MESSAGE_LINK.records[0]!, time: 1.6, messageType: 'STATUS_REPORT', sourceEventId: 'R-2', transmitEventId: 'T-2' },
      ],
      firstTimeS: 1.5,
      lastTimeS: 1.6,
      activeIntervals: [{ startTimeS: 1.5, endTimeS: 1.6 }],
    }
    const groups = vi.spyOn(L, 'layerGroup')
    const controller = await createController({ initialNodes: SATELLITE_FILE_NODES, fileMessageLinks: [mixedLink] })
    const flowGroup = groups.mock.results[2]!.value as L.LayerGroup
    const clock = (time: number, key = 'mixed') => controller.setFilePlayback({ time, playing: true, speed: 1, key }, [mixedLink])
    clock(0)
    now = 2000
    clock(2)
    expect(flowGroup.getLayers()).toHaveLength(8)
    expect(container!.querySelector('.situation-map-flow-direction')).toBeNull()
    controller.destroy()
  })
})

import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Principal } from '../../src/contracts/domain-models'

vi.mock('../../src/components/situation/OfflineSituationMap.vue', () => ({
  default: {
    name: 'OfflineSituationMap',
    props: [
      'sourceKey', 'frame', 'engineFrame', 'engineSourceLabel', 'positionReplay',
      'initialNodes', 'configuredLinks', 'focusLinks', 'configuredLinkStatuses',
      'configuredLinkSwitches', 'configuredJammers', 'configuredEnvironment',
      'liveMessageFlows', 'liveFlowPlaying', 'liveFlowKey',
      'fileLinks', 'fileMessageLinks', 'fileDeviceEvents', 'fileTime',
      'filePlaying', 'fileSpeed', 'fileSeekRevision', 'links',
      'selectedNodeId', 'focusTarget', 'selectNearbyLinks', 'separateLinkDirections',
    ],
    emits: ['select-node', 'select-configured-link', 'fullscreen-change'],
    template: '<div data-testid="offline-map-stub" />',
  },
}))

import ReplaysPage from '../../src/pages/replays/replays.vue'
import { createAppRouter } from '../../src/router'
import { useAuthStore } from '../../src/stores/auth'
import { useReplayStore } from '../../src/stores/replay'
import { useSimulationStore } from '../../src/stores/simulation'
import { LINK_CALC_DEFAULTS } from '../../src/features/scenarios/link-calc-defaults'
import { snapshotReplayMap } from '../../src/features/replays/replay-map-config'
import { createTemplateScenario } from '../fixtures/template-scenario'
import { LOCAL_REPLAY } from '../fixtures/local-replay'
import { ENGINE_RESULT, ENGINE_RESULT_ID, engineReplayAt } from '../fixtures/engine-frame/replay'
import detected from '../fixtures/engine-frame/websocket-new/fream_chenge2.json'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'

const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR',
  permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL', 'ORDINARY_REPORT_EXPORT'],
}
/** 创建页面测试使用的成功响应。 */
function success(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

/** 创建带登录身份和工作区路由的页面挂载环境。 */
async function mountPage(component: typeof ReplaysPage, path: string, selectedScene?: ReturnType<typeof createTemplateScenario>) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore(pinia).$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
  if (selectedScene) {
    useAuthStore(pinia).runtimeMode = 'LOCAL'
    useSimulationStore(pinia).selectedScene = selectedScene
  }
  const router = createAppRouter(createMemoryHistory(), pinia)
  await router.push(path)
  const wrapper = mount(component, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus] } })
  await flushPromises()
  return { wrapper, router }
}

describe('P6 历史回放页面', () => {
  it('从主导航进入回放只读取所选场景的运行，直接进入文件回放时仍按日志读取', async () => {
    const scene = createTemplateScenario()
    const record = { ...ENGINE_RESULT.record, scenarioId: scene.config.scenario.id, executionSource: undefined }
    const other = { ...record, resultId: 'RESULT-22222222-2222-4222-8222-222222222222', scenarioId: 'SCN-OTHER' }
    const replayMap = snapshotReplayMap(scene.config)
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname
      if (path.endsWith('/mission-results')) return success([other, record])
      if (path.endsWith('/engine-replay')) return success(engineReplayAt(0, record.runId, record.scenarioId))
      if (path.endsWith(record.resultId)) {
        expect(init.headers).toMatchObject({ 'X-Mission-Result-View': 'replay' })
        return success({ record, replay: LOCAL_REPLAY, replayMap })
      }
      if (path.endsWith('/replays/local-file')) return success(LOCAL_REPLAY)
      throw new Error(path)
    })
    vi.stubGlobal('fetch', fetcher)
    const { wrapper, router } = await mountPage(ReplaysPage, '/replays', scene)
    try {
      await vi.waitFor(() => expect(useReplayStore().state).toBe('PAUSED'))
      expect(router.currentRoute.value.query).toEqual({ resultId: record.resultId })
      expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
        '/api/v1/mission-results', `/api/v1/mission-results/${record.resultId}`, `/api/v1/mission-results/${record.resultId}/engine-replay`,
      ])
      expect(wrapper.getComponent({ name: 'OfflineSituationMap' }).props('fileMessageLinks')).toEqual([])
      await router.push('/replays?source=file')
      await flushPromises()
      expect(fetcher.mock.calls.at(-1)![0]).toContain('/replays/local-file')
      expect(wrapper.getComponent({ name: 'OfflineSituationMap' }).props('configuredLinks')).toBeUndefined()
    } finally { wrapper.unmount() }
  })

  it.each([true, false])('场景结果缺少历史配置时不把投递画成链路（有归档帧=%s）', async hasFrames => {
    const record = { ...ENGINE_RESULT.record, executionSource: undefined }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/engine-replay?')) return success(hasFrames ? engineReplayAt(0) : null)
      return success({ record, replay: LOCAL_REPLAY })
    }))
    const { wrapper } = await mountPage(ReplaysPage, `/replays?resultId=${record.resultId}`)
    try {
      const map = wrapper.getComponent({ name: 'OfflineSituationMap' })
      expect(map.props('configuredLinks')).toEqual([])
      expect(map.props('fileMessageLinks')).toEqual([])
      expect(map.props('initialNodes')).toHaveLength(2)
      expect(wrapper.text()).toContain('该次运行缺少对应修订的地图配置')
    } finally { wrapper.unmount() }
  })

  it('运行结果按态势主界面相同的时刻渲染节点、链路、切换、流向与环境', async () => {
    const resultSnapshot = structuredClone(ENGINE_RESULT)
    resultSnapshot.replay.durationS = 10
    resultSnapshot.replay.initial.platformDeletions = [{ sourceEventId: 'DEL-1', time: 10, platformId: 'B' }]
    resultSnapshot.replay.initial.messageLinks = [{
      id: 'MSG-A-B',
      type: 'MICROWAVE',
      sourcePlatformId: 'A',
      targetPlatformId: 'B',
      sourceDeviceId: 'microwave_link',
      targetDeviceId: 'microwave_link',
      records: [{
        sourceEventId: 'RX-1',
        transmitEventId: 'TX-1',
        time: 5,
        source: { platformName: 'A', communicationName: 'microwave_link' },
        target: { platformName: 'B', communicationName: 'microwave_link' },
        messageType: 'kForwardSituation',
        messageSizeBits: 1024,
        delayS: 0.01,
      }],
      firstTimeS: 5,
      lastTimeS: 5,
      activeIntervals: [{ startTimeS: 5, endTimeS: 5 }],
      messageCount: 1,
      messageTypes: ['kForwardSituation'],
      direction: 'FORWARD',
      medianDelayS: 0.01,
    }]
    const scenarioDetail = {
      revision: 1,
      config: {
        scenario: {
          id: 'SCN-HISTORY',
          name: '历史场景',
          startTime: '2026-11-10T00:00:00Z',
          duration: 60,
          environment: { rainEnabled: true, rainRateMmPerHour: 12 },
        },
        platforms: [
          {
            id: 'A', name: '前出中继 1 号', type: 'FORWARD_RELAY_NODE', side: 'BLUE',
            initialPosition: { longitude: -77, latitude: 30, altitude: 5000 },
          },
          {
            id: 'B', name: '集群指挥车', type: 'GROUND_CLUSTER_COMMAND_NODE', side: 'BLUE',
            initialPosition: { longitude: 117, latitude: 25, altitude: 0 },
          },
        ],
        linkSettings: { enabledSatellites: { TIANTONG: false, SHENTONG: false }, switchCooldownS: 0,
          linkCalc: { ...LINK_CALC_DEFAULTS, warningThreshold: 0.1, emergencyThreshold: 0.9 } },
        links: [
          {
            id: 'LNK-MW-1', type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B',
            direction: 'FORWARD', enabled: true,
          },
          {
            id: 'LNK-DL-2', type: 'DATALINK', sourcePlatformId: 'A', targetPlatformId: 'B',
            enabled: true,
          },
          { id: 'LNK-MW-R', type: 'MICROWAVE', sourcePlatformId: 'B', targetPlatformId: 'A', direction: 'REVERSE', enabled: true },
        ],
        jammers: [
          { id: 'JAM-1', platformId: 'B', jammingRange: 30_000, detectionRange: 48_520 },
        ],
      },
    }

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/v1/scenarios/')) return success(scenarioDetail)
      if (url.endsWith('/mission-results')) return success([resultSnapshot.record])
      if (!url.includes('/engine-replay?')) return success(resultSnapshot)
      const time = Number(new URL(url).searchParams.get('time'))
      const history = engineReplayAt(time)
      if (history.engineFrame?.frameId === 5) history.engineFrame.simulationTime = 5.25
      if (history.engineFrame) {
        const sample = history.engineFrame.links[0]!
        history.engineFrame.links = [
          {
            ...structuredClone(sample),
            linkId: 'LNK-MW-1',
            linkIds: ['LNK-MW-1'],
            sourcePlatformId: 'A',
            targetPlatformId: 'B',
            sourcePort: 'microwave_link',
            targetPort: 'microwave_link',
            status: 'UP',
            quality: { ...sample.quality, ber: time >= 10 ? 0.9 : 0.1 },
            distanceM: 12000,
            error: null,
          },
          {
            ...structuredClone(sample),
            linkId: 'LNK-DL-2',
            linkIds: ['LNK-DL-2'],
            sourcePlatformId: 'A',
            targetPlatformId: 'B',
            sourcePort: 'c_band_uplink',
            targetPort: 'c_band_uplink',
            status: 'UP',
            quality: { ...sample.quality, ber: 0.05 },
            distanceM: 12000,
            error: null,
          },
        ]
        history.engineFrame.links.push({
          ...history.engineFrame.links[0]!, linkId: 'LNK-MW-R', linkIds: ['LNK-MW-R'], sourcePlatformId: 'B', targetPlatformId: 'A',
        })
        if (time >= 10) {
          const sampleSwitch = history.engineFrame.routing.switches[0]!
          const route = {
            ...structuredClone(sampleSwitch),
            pathId: 'PATH-1',
            oldNodes: [
              { platformId: 'A', platformName: 'A', outPort: 'microwave_link', inPort: null },
              { platformId: 'B', platformName: 'B', outPort: null, inPort: 'microwave_link' },
            ],
            nodes: [
              { platformId: 'A', platformName: 'A', outPort: 'c_band_uplink', inPort: null },
              { platformId: 'B', platformName: 'B', outPort: null, inPort: 'c_band_uplink' },
            ],
          }
          history.engineFrame.routing.switches = [route]
          history.engineSwitches = [{ frameId: 10, simulationTime: 10, route }]
        }
      }
      return success(history)
    }))

    const { wrapper } = await mountPage(ReplaysPage, `/replays?resultId=${ENGINE_RESULT_ID}`)
    try {
      const store = useReplayStore()
      const map = wrapper.getComponent({ name: 'OfflineSituationMap' })

      // t=0 首帧前：与态势主界面一致，配置链路为空、不绘制文件灰线、透传气象与干扰配置
      expect([true, '']).toContain(map.props('separateLinkDirections'))
      expect([true, '']).toContain(map.props('selectNearbyLinks'))
      expect(map.props('configuredLinks')).toEqual([])
      expect(map.props('configuredEnvironment')).toEqual({ rainEnabled: true, rainRateMmPerHour: 12 })
      expect(map.props('configuredJammers')).toEqual([{ id: 'JAM-1', platformId: 'B', jammingRange: 30_000, detectionRange: 48_520 }])
      expect(map.props('fileLinks')).toEqual([])
      expect(map.props('fileMessageLinks')).toEqual([])
      expect(map.props('initialNodes')[0]).toMatchObject({ platformId: 'A', name: '前出中继 1 号', type: 'FORWARD_RELAY_NODE', side: 'blue' })
      expect(wrapper.text()).not.toContain('图中通信关联不代表链路已接通')

      // t=2 首个引擎帧前：只显示已记录的位置，不能借用第 3 秒的未来样本。
      await store.seek(2); await flushPromises()
      expect(map.props('initialNodes')[0].longitude).toBe(-78)

      // 到达小数秒引擎帧后，链路和流向同步到该帧。
      await store.seek(5.25); await flushPromises()
      expect(map.props('configuredLinks').map((l: { id: string }) => l.id)).toEqual(['LNK-MW-1', 'LNK-DL-2', 'LNK-MW-R'])
      expect(map.props('configuredLinkStatuses').get('LNK-MW-1')).toBe('DEGRADED')
      expect(map.props('configuredLinkStatuses').get('LNK-DL-2')).toBe('UP')
      expect(map.props('liveMessageFlows')).toHaveLength(1)

      // 两个引擎帧之间，地图位置及轨迹停在已显示的帧，时间轴可以继续前进。
      const nodesAtFive = map.props('initialNodes')
      await store.seek(7); await flushPromises()
      expect(map.props('fileTime')).toBe(5.25)
      expect(wrapper.get('.replay-view__badge').text()).toContain('00:00:05.25')
      expect(map.props('initialNodes')).toEqual(nodesAtFive)
      map.vm.$emit('select-configured-link', scenarioDetail.config.links[0], scenarioDetail.config.links[2])
      await flushPromises()
      const pairedDialog = wrapper.getComponent({ name: 'LinkQualityDialog' })
      expect(pairedDialog.props('directions').map((link: { id: string }) => link.id)).toEqual(['LNK-MW-1', 'LNK-MW-R'])
      pairedDialog.vm.$emit('select-direction', 'LNK-MW-R')
      await flushPromises()
      expect(pairedDialog.props('configuredLink').id).toBe('LNK-MW-R')
      expect(pairedDialog.props('engineSegments')[0].sourcePlatformId).toBe('B')

      // t=10 链路中断 + 切换高亮 + 平台删除不回退初始坐标
      await store.seek(10); await flushPromises()
      expect(map.props('configuredLinkStatuses').get('LNK-MW-1')).toBe('DOWN')
      expect(map.props('configuredLinkSwitches').get('LNK-MW-1')).toBe('BEFORE')
      expect(map.props('configuredLinkSwitches').get('LNK-DL-2')).toBe('AFTER')
      expect(map.props('initialNodes').map((n: { platformId: string }) => n.platformId)).toEqual(['A'])

      // 点击地图上的配置链路弹出链路质量详情弹窗
      map.vm.$emit('select-configured-link', scenarioDetail.config.links[0])
      await flushPromises()
      const dialog = wrapper.getComponent({ name: 'LinkQualityDialog' })
      expect(dialog.props('modelValue')).toBe(true)
      expect(dialog.props('configuredLink')).toMatchObject({ id: 'LNK-MW-1', enabled: true })
      expect(dialog.props('directions')).toEqual([])
      expect(dialog.props('engineSegments')).toHaveLength(1)
    } finally { wrapper.unmount() }
  })

  it('历史干扰与探测随游标显示，回退到空帧时不残留后续设备状态', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (!url.includes('/engine-replay?')) return success(url.endsWith('/mission-results') ? [ENGINE_RESULT.record] : ENGINE_RESULT)
      const time = Number(new URL(url).searchParams.get('time')), history = engineReplayAt(time)
      if (time >= 10) history.engineFrame!.jammers = adaptEngineFrameSnapshot(detected).data!.jammers
      return success(history)
    }))
    const { wrapper } = await mountPage(ReplaysPage, `/replays?resultId=${ENGINE_RESULT_ID}`)
    try {
      const store = useReplayStore()
      await store.seek(10); await flushPromises()
      const tab = wrapper.findAll('[role="tab"]').find(tab => tab.text() === '干扰与探测')!
      expect(tab).toBeDefined(); await tab.trigger('click')
      const panel = wrapper.get('[data-testid="engine-jammers"]')
      expect(panel.isVisible()).toBe(true)
      for (const value of ['历史引擎数据 · 帧 10', '200 W', '18.52 km', '已侦测']) expect(panel.text()).toContain(value)
      await store.seek(5); await flushPromises()
      expect(panel.text()).toContain('帧 5')
      expect(panel.text()).toContain('暂无数据')
      expect(panel.findAll('article')).toHaveLength(0)
      await store.seek(0); await flushPromises()
      expect(wrapper.find('[data-testid="engine-jammers"]').exists()).toBe(false)
    } finally { wrapper.unmount() }
  })
  it('选择历史运行后展示质量、选路和告警，回退不保留未来记录', async () => {
    const fetchSpy = vi.fn(async (url: string) => success(url.includes('/engine-replay?') ? engineReplayAt(Number(new URL(url).searchParams.get('time')))
      : url.endsWith('/mission-results') ? [ENGINE_RESULT.record] : ENGINE_RESULT))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountPage(ReplaysPage, `/replays?resultId=${ENGINE_RESULT_ID}`)
    try {
      const store = useReplayStore()
      expect(wrapper.get('[data-testid="replay-engine-history"]').text()).toContain('当前时刻尚未收到引擎帧')
      await store.seek(10); await flushPromises()
      expect(wrapper.get('[data-testid="quality-source"]').text()).toBe('数据时刻：00:00:10 · 历史回放')
      expect(wrapper.get('[data-testid="engine-decisions"]').text()).toContain('历史链路告警')
      expect(wrapper.getComponent({ name: 'OfflineSituationMap' }).props('fileTime')).toBe(10)
      await store.seek(5); await flushPromises()
      expect(wrapper.get('[data-testid="quality-source"]').text()).toBe('数据时刻：00:00:05 · 历史回放')
      expect(wrapper.get('[data-testid="engine-decisions"]').text()).not.toContain('历史链路告警')
      await store.seek(0); await flushPromises()
      expect(wrapper.find('[data-testid="engine-quality"]').exists()).toBe(false)
      expect(fetchSpy.mock.calls.every(([url]) => url.includes('/mission-results') || url.includes('/scenarios/'))).toBe(true)
    } finally { wrapper.unmount() }
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each([16, 32])('历史回放 %s 倍每秒推进对应游标并在末尾停止', async speed => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const snapshot = structuredClone(LOCAL_REPLAY)
    snapshot.tracks[1]!.positions[1]!.time = 64
    snapshot.durationS = 64
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success(snapshot)))
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    try {
      const select = wrapper.get('.replay-controls__toolbar').getComponent({ name: 'ElSelect' })
      expect(select.findAllComponents({ name: 'ElOption' }).some(option => option.props('value') === speed)).toBe(true)
      select.vm.$emit('update:modelValue', speed)
      await flushPromises()
      await wrapper.get('[data-testid="replay-play"]').trigger('click')
      await vi.advanceTimersByTimeAsync(1000)
      const map = wrapper.findComponent({ name: 'OfflineSituationMap' })
      expect(useReplayStore().replay?.currentTimeS).toBe(speed)
      expect(map.props('fileSpeed')).toBe(speed)
      expect(map.props('fileTime')).toBe(speed)
      await vi.advanceTimersByTimeAsync(4000)
      expect(useReplayStore().replay?.currentTimeS).toBe(64)
      expect(useReplayStore().state).toBe('COMPLETED')
    } finally {
      wrapper.unmount()
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('真实文件回放保持现有控制，按播放和拖动时刻更新地图，不加载模拟帧或事件', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const fetchSpy = vi.fn().mockResolvedValue(success(structuredClone(LOCAL_REPLAY)))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    const map = wrapper.findComponent({ name: 'OfflineSituationMap' })
    expect(useReplayStore().localSnapshot?.fileName).toBe('positions.csv')
    expect(wrapper.find('.replays-page__source').exists()).toBe(false)
    expect(wrapper.get('.replays-page__header').find('.replay-controls').exists()).toBe(true)
    expect(wrapper.get('.replays-page__body').find('.replay-controls').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('F-00042')
    expect(wrapper.text()).not.toContain('SW-004')
    expect(map.props('frame')).toBeNull()
    expect(map.props('filePlaying')).toBe(false)
    expect(map.props('fileSpeed')).toBe(1)
    expect(map.props('links')).toEqual([])
    expect(map.props('initialNodes')).toHaveLength(2)
    expect(map.props('initialNodes')[0].longitude).toBe(-77)
    await wrapper.get('.replay-node-location button').trigger('click')
    expect(map.props('focusTarget')).toEqual({ kind: 'node', targetId: 'A' })
    await wrapper.get('[data-testid="replay-play"]').trigger('click')
    expect(map.props('filePlaying')).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(map.props('initialNodes')[0].longitude).toBe(-78)
    const nodeSelect = wrapper.get('.replay-event-detail').getComponent({ name: 'ElSelect' })
    nodeSelect.vm.$emit('update:modelValue', 'B')
    await flushPromises()
    expect(map.props('focusTarget')).toEqual({ kind: 'node', targetId: 'B' })
    await wrapper.get('[role="slider"]').trigger('keydown', { key: 'End', code: 'End' })
    await flushPromises()
    expect(map.props('initialNodes')[0].longitude).toBe(-79)
    expect(map.props('selectedNodeId')).toBe('B')
    expect(map.props('filePlaying')).toBe(false)
    expect(map.props('fileSeekRevision')).toBe(1)
    await wrapper.get('[role="slider"]').trigger('keydown', { key: 'Home', code: 'Home' })
    await flushPromises()
    expect(map.props('initialNodes')[0].longitude).toBe(-77)
    expect(fetchSpy).toHaveBeenCalledOnce()
    await wrapper.get('.replays-page__reload').trigger('click')
    await flushPromises()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(useReplayStore().replay?.currentTimeS).toBe(0)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('文件回放按游标展示卫星与微波关联，回退隐藏未来登记，重载清理旧关联', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const snapshot = structuredClone(LOCAL_REPLAY)
    const satellite = {
      sourceEventId: 'LOG-L10', time: 0, scope: 'INTER_PLATFORM' as const,
      source: { platformName: 'A', communicationName: 'sat-a', address: '0.1.0.1' },
      target: { platformName: 'B', communicationName: 'sat-b', address: '0.1.0.2' },
      sourceType: 'satcom_1', targetType: 'satcom_2',
    }
    snapshot.initial.connections = [satellite, {
      ...satellite, sourceEventId: 'LOG-L11', time: 1,
      source: satellite.target, target: satellite.source,
      sourceType: satellite.targetType, targetType: satellite.sourceType,
    }, {
      ...satellite, sourceEventId: 'LOG-L12', time: 3,
      source: { ...satellite.source, communicationName: 'mw-a' },
      target: { ...satellite.target, communicationName: 'mw-b' },
      sourceType: 'microwave', targetType: 'microwave',
    }]
    const fetchSpy = vi.fn().mockResolvedValueOnce(success(snapshot))
      .mockResolvedValueOnce(success(structuredClone(LOCAL_REPLAY)))
      .mockRejectedValueOnce(new Error('文件暂不可读'))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    try {
      const map = wrapper.getComponent({ name: 'OfflineSituationMap' })
      expect(map.props('fileLinks')).toEqual([expect.objectContaining({
        type: 'SAT', sourcePlatformId: 'A', targetPlatformId: 'B', records: [satellite],
      })])
      expect(map.props('links')).toEqual([])
      expect(map.props('frame')).toBeNull()
      await wrapper.get('[data-testid="replay-play"]').trigger('click')
      await vi.advanceTimersByTimeAsync(1000)
      await flushPromises()
      expect(map.props('fileLinks')).toHaveLength(1)
      expect(map.props('fileLinks')[0].records).toHaveLength(2)
      expect(map.props('initialNodes')[0].longitude).toBe(-78)
      await wrapper.get('[role="slider"]').trigger('keydown', { key: 'End', code: 'End' })
      await flushPromises()
      expect(map.props('fileLinks').map((link: { type: string }) => link.type)).toEqual(['SAT', 'MICROWAVE'])
      expect(map.props('initialNodes')[0].longitude).toBe(-79)
      await wrapper.get('[role="slider"]').trigger('keydown', { key: 'Home', code: 'Home' })
      await flushPromises()
      expect(map.props('fileLinks')).toHaveLength(1)
      expect(map.props('fileLinks')[0].records).toEqual([satellite])
      expect(map.props('initialNodes')[0].longitude).toBe(-77)
      expect(fetchSpy).toHaveBeenCalledOnce()
      await wrapper.get('.replays-page__reload').trigger('click')
      await flushPromises()
      expect(wrapper.getComponent({ name: 'OfflineSituationMap' }).props('fileLinks')).toEqual([])
      await wrapper.get('.replays-page__reload').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(false)
    } finally {
      wrapper.unmount()
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('真实文件设备事件传入地图，游标前进和后退同步时刻，重载不保留前一份事件', async () => {
    const snapshot = structuredClone(LOCAL_REPLAY)
    snapshot.initial.deviceEvents = [
      { sourceEventId: 'LOG-L10', platformId: 'A', deviceId: 'tx', kind: 'COMMUNICATION', time: 0, active: true },
      { sourceEventId: 'LOG-L11', platformId: 'A', deviceId: 'tx', kind: 'COMMUNICATION', time: 3, active: false },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(success(snapshot)).mockResolvedValueOnce(success(structuredClone(LOCAL_REPLAY))))
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    try {
      const map = wrapper.getComponent({ name: 'OfflineSituationMap' })
      expect(map.props('fileDeviceEvents')).toEqual(snapshot.initial.deviceEvents)
      expect(map.props('fileTime')).toBe(0)
      await wrapper.get('[role="slider"]').trigger('keydown', { key: 'End', code: 'End' })
      await flushPromises()
      expect(map.props('fileTime')).toBe(3)
      await wrapper.get('[role="slider"]').trigger('keydown', { key: 'Home', code: 'Home' })
      await flushPromises()
      expect(map.props('fileTime')).toBe(0)
      await wrapper.get('.replays-page__reload').trigger('click')
      await flushPromises()
      expect(wrapper.getComponent({ name: 'OfflineSituationMap' }).props('fileDeviceEvents')).toBeUndefined()
    } finally { wrapper.unmount() }
  })

  it('末条位置在3秒、关联在10秒时可回放到登记时刻，回退隐藏关联且保持末条位置', async () => {
    const snapshot = structuredClone(LOCAL_REPLAY)
    snapshot.durationS = 10
    snapshot.initial.connections = [{
      sourceEventId: 'LOG-L10', time: 10, scope: 'INTER_PLATFORM',
      source: { platformName: 'A', communicationName: 'mw-a', address: '1' },
      target: { platformName: 'B', communicationName: 'mw-b', address: '2' },
      sourceType: 'microwave', targetType: 'microwave',
    }]
    const fetchSpy = vi.fn().mockResolvedValue(success(snapshot))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    try {
      const map = wrapper.getComponent({ name: 'OfflineSituationMap' })
      expect(map.props('fileLinks')).toEqual([])
      await wrapper.get('[role="slider"]').trigger('keydown', { key: 'End', code: 'End' })
      await flushPromises()
      expect(useReplayStore().replay?.currentTimeS).toBe(10)
      expect(map.props('fileLinks')).toEqual([expect.objectContaining({ records: snapshot.initial.connections })])
      const lastNodes = structuredClone(map.props('initialNodes'))
      expect(lastNodes[0]).toMatchObject({ longitude: -79, latitude: 32, altitude: 20, time: 3 })
      expect(map.props('frame')).toBeNull()
      expect(map.props('links')).toEqual([])
      await useReplayStore().seek(9)
      await flushPromises()
      expect(useReplayStore().replay?.currentTimeS).toBe(9)
      expect(map.props('fileLinks')).toEqual([])
      expect(map.props('initialNodes')).toEqual(lastNodes)
      expect(fetchSpy).toHaveBeenCalledOnce()
    } finally { wrapper.unmount() }
  })

  it('真实文件读取失败展示中文错误，不回退旧地图', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('文件暂不可读'))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    expect(wrapper.text()).toContain('历史回放不可用')
    expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(false)
    expect(fetchSpy).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('未配置本地数据时只显示空态，重新加载可恢复真实文件，不请求演示接口', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(success(null))
      .mockResolvedValueOnce(success(structuredClone(LOCAL_REPLAY)))
      .mockResolvedValueOnce(success(null))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    try {
      expect(wrapper.text()).toContain('暂无本地回放数据，请配置数据文件后重新加载。')
      expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="replay-play"]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('F-00042')
      expect(fetchSpy).toHaveBeenCalledOnce()
      await wrapper.get('.replays-page__reload').trigger('click')
      await flushPromises()
      expect(useReplayStore().localSnapshot?.fileName).toBe('positions.csv')
      expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(true)
      await wrapper.get('.replays-page__reload').trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('暂无本地回放数据')
      expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(false)
      expect(useReplayStore().localSnapshot).toBeNull()
      expect(fetchSpy).toHaveBeenCalledTimes(3)
      expect(fetchSpy.mock.calls.every(([url]) => String(url).endsWith('/api/v1/replays/local-file'))).toBe(true)
    } finally { wrapper.unmount() }
  })

  it('本地文件加载期间离页，迟到响应不能恢复数据或启动播放', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    let finishLoad!: (response: Response) => void
    const fetchSpy = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { finishLoad = resolve }))
    vi.stubGlobal('fetch', fetchSpy)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/replays', component: ReplaysPage }] })
    await router.push('/replays')
    const wrapper = mount(ReplaysPage, { global: { plugins: [pinia, ElementPlus, router] } })
    await flushPromises()
    expect(wrapper.find('.el-skeleton').exists()).toBe(true)
    wrapper.unmount()
    finishLoad(success(structuredClone(LOCAL_REPLAY)))
    await flushPromises()
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(useReplayStore().state).toBe('EMPTY')
    expect(useReplayStore().replay).toBeNull()
    expect(useReplayStore().localSnapshot).toBeNull()
    expect(fetchSpy.mock.calls[0]?.[1].signal.aborted).toBe(true)
  })

  it('本地数据校验失败清除旧地图并提示错误，重试恢复后仍只加载本地文件', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(success(structuredClone(LOCAL_REPLAY)))
      .mockResolvedValueOnce(success({ ...structuredClone(LOCAL_REPLAY), durationS: -1 }))
      .mockResolvedValueOnce(success(structuredClone(LOCAL_REPLAY)))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    try {
      await wrapper.get('.replays-page__reload').trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('回放数据损坏')
      expect(wrapper.text()).toContain('历史回放数据格式不正确。')
      expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="replay-play"]').exists()).toBe(false)
      expect(useReplayStore().localSnapshot).toBeNull()
      await wrapper.get('.el-result button').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(true)
      expect(fetchSpy).toHaveBeenCalledTimes(3)
      expect(fetchSpy.mock.calls.every(([url]) => String(url).endsWith('/api/v1/replays/local-file'))).toBe(true)
    } finally { wrapper.unmount() }
  })
})

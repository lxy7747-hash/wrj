import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import ClosedLoopStepper from '../../src/components/interactions/ClosedLoopStepper.vue'
import JammerSyncPanel from '../../src/components/interactions/JammerSyncPanel.vue'
import RouteRankingPanel from '../../src/components/interactions/RouteRankingPanel.vue'
import SwitchDecisionPanel from '../../src/components/interactions/SwitchDecisionPanel.vue'
import type { DetectionEvent, Principal, ScenarioDraft, SwitchEvent, TelemetryFrame } from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'
import { useTelemetryStore } from '../../src/stores/telemetry'

const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'],
}

/** 创建统一成功响应。 */
function successResponse(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

describe('P4 剩余交互能力', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    useTelemetryStore().$patch({
      frame: structuredClone(fixtureSource.frame) as unknown as TelemetryFrame,
      events: structuredClone(fixtureSource.events) as unknown as Array<DetectionEvent | SwitchEvent>,
      capabilityState: 'SUCCESS',
    })
    useScenarioStore().$patch({
      panelState: 'SUCCESS',
      draft: {
        config: structuredClone(fixtureSource.scenario),
        uiExtensions: {
          sensors: [{ sensorId: 'ESM-01', type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true }],
          jammers: [
            { jammerId: 'JAM-WB-01-TX', direction: 360, duration: 1470, enabled: true },
            { jammerId: 'JAM-SPOT-01-TX', direction: 45, duration: 60, enabled: false },
          ],
        },
        revision: 4,
        officialLibraryChanged: false,
        locked: false,
      } as unknown as ScenarioDraft,
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('在遥测帧加载前显示参数同步空态', () => {
    useTelemetryStore().resetToSafeEmpty()

    const wrapper = mount(JammerSyncPanel, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="jammer-sync-state"]').text()).toContain('待同步')
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  })

  it('执行同帧闭环并显示完整三步证据', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse({
      decisionId: 'DEC-DET-042', runId: 'RUN-001', frameId: 'F-00042', detectionEventId: 'DET-042',
      targetPlatformId: 'UAV-01', jammerId: 'JAM-WB-01-TX', affectedLinkId: 'L-DL-03', action: 'START',
      linkStatus: 'DEGRADED', effectiveFrameId: 'F-00042', reason: 'AUTO_DETECTION_DET-042',
    })))
    const wrapper = mount(ClosedLoopStepper, { global: { plugins: [ElementPlus] } })
    expect(wrapper.text()).toContain('DET-042 · F-00042')
    expect(wrapper.text()).toContain('JAM-WB-01-TX · 72 W')
    expect(wrapper.text()).toContain('L-DL-03 · 劣化')
    await wrapper.get('button').trigger('click')
    await vi.waitFor(() => expect(useTelemetryStore().closedLoopState).toBe('SUCCESS'))
    expect(wrapper.get('[data-testid="closed-loop-state"]').text()).toBe('闭环完成')
  })

  it('展示四端同步、正反向排名以及接受和拒绝切换记录', async () => {
    // 当前场景时长与历史固定帧不同，发送当前场景扩展中的持续时间。
    useScenarioStore().draft!.config.scenario.duration = 1200
    useScenarioStore().draft!.uiExtensions.jammers[0]!.duration = 120
    const syncResult = {
      taskId: 'TASK-001', jammerId: 'JAM-WB-01-TX', parameterVersion: 5,
      configParameterVersion: 5, nodeParameterVersion: 5, engineParameterVersion: 5, uiParameterVersion: 5,
      effectiveFrameId: 'F-00042', effectiveSimulationTime: 42, status: 'SYNCHRONIZED',
      jammerStatus: { time: 42, jammerId: 'JAM-WB-01-TX', platformId: 'STN-01', targetPlatform: 'UAV-01', power: 72, frequency: 2200, bandwidth: 40, active: true },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse(syncResult)))
    const sync = mount(JammerSyncPanel, { global: { plugins: [ElementPlus] } })
    await sync.findAll('button').find((button) => button.text().includes('同步参数'))?.trigger('click')
    await vi.waitFor(() => expect(useTelemetryStore().syncState).toBe('SUCCESS'))
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toMatchObject({ parameters: { duration: 120 } })
    expect(sync.text()).toContain('配置端')
    expect(sync.text()).toContain('AFSIM 引擎')
    expect(sync.text()).toContain('v5')
    expect(sync.text()).toContain('F-00042')

    const forward = mount(RouteRankingPanel, { props: { direction: 'FORWARD', requirementId: 'T-XQ-019' }, global: { plugins: [ElementPlus] } })
    const reverse = mount(RouteRankingPanel, { props: { direction: 'REVERSE', requirementId: 'T-XQ-020' }, global: { plugins: [ElementPlus] } })
    expect(forward.text()).toContain('L-MW-01')
    expect(forward.text()).toContain('干扰影响最小')
    expect(reverse.text()).toContain('L-LASER-04')
    expect(reverse.getComponent({ name: 'ElTable' }).props('data')).toEqual(expect.arrayContaining([
      expect.objectContaining({ linkId: 'L-DL-03', eligible: false, eliminationReason: 'LINK_UNAVAILABLE' }),
    ]))

    const switches = mount(SwitchDecisionPanel, { global: { plugins: [ElementPlus] } })
    expect(switches.text()).toContain('接受 1')
    expect(switches.text()).toContain('拒绝 1')
    expect(switches.getComponent({ name: 'ElTable' }).props('data')).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: 'SW-003', decision: 'ACCEPTED', cooldownRemainingS: 0 }),
      expect.objectContaining({ eventId: 'SW-004', decision: 'REJECTED', cooldownRemainingS: 18 }),
    ]))

    sync.getComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', 'JAM-SPOT-01-TX')
    await nextTick()
    expect(useTelemetryStore()).toMatchObject({ syncResult: null, syncState: 'EMPTY' })
    expect(sync.text()).toContain('v4')

    sync.getComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', 'JAM-WB-01-TX')
    await nextTick()
    await sync.findAll('button').find((button) => button.text().includes('同步参数'))?.trigger('click')
    await vi.waitFor(() => expect(useTelemetryStore().syncState).toBe('SUCCESS'))
    sync.findAllComponents({ name: 'ElInputNumber' })[1]?.vm.$emit('update:modelValue', 71)
    await nextTick()
    expect(useTelemetryStore()).toMatchObject({ syncResult: null, syncState: 'EMPTY' })
    expect(sync.text()).toContain('v5')
  })

  it('固定选路与切换证据覆盖无 EXECUTING 的五态', async () => {
    const telemetryStore = useTelemetryStore()
    const forward = mount(RouteRankingPanel, { props: { direction: 'FORWARD', requirementId: 'T-XQ-019' }, global: { plugins: [ElementPlus] } })
    const switches = mount(SwitchDecisionPanel, { global: { plugins: [ElementPlus] } })

    for (const [state, routeLabel, switchLabel] of [
      ['LOADING', '加载中', '加载中'],
      ['VALIDATING', '校验中', '校验中'],
      ['ERROR', '决策错误', '记录错误'],
    ] as const) {
      telemetryStore.capabilityState = state
      await nextTick()
      expect(forward.text()).toContain(routeLabel)
      expect(switches.text()).toContain(switchLabel)
    }

    const emptyFrame = structuredClone(fixtureSource.frame) as unknown as TelemetryFrame
    emptyFrame.evidence.routeCandidates = []
    emptyFrame.evidence.routeDecisions = []
    telemetryStore.$patch({ frame: emptyFrame, events: [], capabilityState: 'SUCCESS' })
    await nextTick()
    expect(forward.text()).toContain('无候选')
    expect(switches.text()).toContain('无切换')
  })

  it('加载失败优先显示闭环和参数同步错误', () => {
    const telemetryStore = useTelemetryStore()
    const scenarioStore = useScenarioStore()
    telemetryStore.$patch({
      frame: null,
      capabilityState: 'ERROR',
      closedLoopState: 'ERROR',
      closedLoopResultMessage: '闭环证据加载失败。',
      syncState: 'ERROR',
      syncResultMessage: '参数设备加载失败。',
    })
    scenarioStore.$patch({ draft: null, panelState: 'ERROR' })

    const loop = mount(ClosedLoopStepper, { global: { plugins: [ElementPlus] } })
    const sync = mount(JammerSyncPanel, { global: { plugins: [ElementPlus] } })
    expect(loop.text()).toContain('闭环证据加载失败。')
    expect(loop.text()).not.toContain('当前帧缺少闭环证据')
    expect(sync.text()).toContain('参数设备加载失败。')
    expect(sync.text()).not.toContain('暂无可同步的干扰设备')
  })
})

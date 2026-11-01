import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Principal, SimulationRun } from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
import { useRuntimeQualityStore, type RuntimeQualityBinding, type RuntimeQualityScope } from '../../src/stores/runtime-quality'
import { useSimulationStore } from '../../src/stores/simulation'

const OPERATOR: Principal = { userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'] }
const scope = (): RuntimeQualityScope => ({ taskId: 'TASK-001', runId: 'RUN-001', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-10-31T01:00:00Z' })
const binding = (): RuntimeQualityBinding => ({
  linkId: 'L-001', sourceLinkId: 'source-link-001', sourcePlatformId: 'UAV-001', destinationPlatformId: 'SAT-001', sourcePortId: 'comm_l001_src', destinationPortId: 'comm_l001_dst',
})

function sourceCalc(overrides: Record<string, unknown> = {}) {
  const bind = binding()
  return {
    links: [{ link_id: bind.sourceLinkId, tx_platform: bind.sourcePlatformId, rx_platform: bind.destinationPlatformId, tx_port: bind.sourcePortId, rx_port: bind.destinationPortId, distance_km: 12.5,
      losses: { free_space_db: 12, sea_multipath_db: 0, atmospheric_db: 1, cloud_rain_db: 0, jamming_loss_db: 2, total_composite_db: 15 },
      quality: { ber: 1e-6, gxb_db: 3, rx_power_dbw: -100, input_trace: { data_rate_bps: 1e6 }, error_msg: '' },
    }], ...overrides,
  }
}

function prepare(activeScope = scope()) {
  const auth = useAuthStore()
  const simulation = useSimulationStore()
  auth.$patch({ principal: structuredClone(OPERATOR), role: OPERATOR.role, permissions: [...OPERATOR.permissions], runtimeMode: 'LOCAL' })
  simulation.$patch({
    run: { taskId: activeScope.taskId, runId: activeScope.runId, scenarioId: activeScope.scenarioId, startedAt: activeScope.startedAt } as SimulationRun,
    selectedScene: { config: { scenario: { id: activeScope.scenarioId }, links: [{ id: 'L-001' }] }, revision: activeScope.revision } as any,
  })
  const store = useRuntimeQualityStore()
  const activationEpoch = store.activate(activeScope, ['L-001'])
  expect(store.bindLinks(activationEpoch, [binding()])).toBe(true)
  return store
}

describe('运行质量 Store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('通过公开动作接收已绑定快照，并按源帧和源时刻隔离重复或过期帧', () => {
    const store = prepare()
    const epoch = store.epoch
    expect(store.acceptFrame(epoch, { frameId: 10, simulationTime: 50 }, sourceCalc())).toBe(true)
    expect(store).toMatchObject({ state: 'SUCCESS', errors: [], snapshot: { frameId: 10, simulationTime: 50, data: { links: [{ quality: { snrDb: null, receivedPowerDbm: -70 } }] } } })
    const snapshot = store.snapshot
    expect(store.acceptFrame(epoch, { frameId: 10, simulationTime: 51 }, sourceCalc({ model_version: 'late' }))).toBe(false)
    expect(store.acceptFrame(epoch, { frameId: 11, simulationTime: 50 }, sourceCalc({ model_version: 'late' }))).toBe(false)
    expect(store.snapshot).toBe(snapshot)
    expect(store.acceptFrame(epoch, { frameId: 11, simulationTime: 51 }, sourceCalc({ model_version: 'new' }))).toBe(true)
    expect(store.snapshot?.data.modelVersion).toBe('new')
  })

  it('运行时钟刷新不作废质量域，但认证或选中场景身份不匹配会拒绝激活', async () => {
    const store = prepare()
    const epoch = store.epoch
    expect(store.acceptFrame(epoch, { frameId: 10, simulationTime: 50 }, sourceCalc())).toBe(true)
    useSimulationStore().$patch({ run: { ...(useSimulationStore().run as SimulationRun), canonical: { ...(useSimulationStore().run as SimulationRun).canonical, currentTime: 10 } } })
    await nextTick()
    expect(store.snapshot?.frameId).toBe(10)

    useSimulationStore().$patch({ selectedScene: { config: { scenario: { id: 'SCN-OTHER' } }, revision: 1 } as any })
    await nextTick()
    expect(store.scope).toBeNull()
    expect(store.activate(scope(), ['L-001'])).toBe(store.epoch)
    expect(store.scope).toBeNull()
  })

  it('只接受当前会话、运行及已保存场景对应的 scope', async () => {
    const store = prepare()
    const currentEpoch = store.epoch
    expect(store.activate({ ...scope(), taskId: 'TASK-OTHER' }, ['L-001'])).not.toBe(currentEpoch)
    expect(store.scope).toBeNull()
    const next = prepare()
    expect(next.acceptFrame(next.epoch - 1, { frameId: 1, simulationTime: 1 }, sourceCalc())).toBe(false)
    useSimulationStore().$patch({ run: { ...(useSimulationStore().run as SimulationRun), taskId: 'TASK-OTHER' } })
    await nextTick()
    expect(next.snapshot).toBeNull()
    expect(next.acceptFrame(next.epoch, { frameId: 1, simulationTime: 1 }, sourceCalc())).toBe(false)
  })

  it('激活集合只能包含当前已保存场景链路，不能由调用方伪造', () => {
    const store = prepare()
    const rejectedEpoch = store.activate(scope(), ['L-NOT-IN-SCENE'])
    expect(store).toMatchObject({ scope: null, bindings: [], snapshot: null, state: 'EMPTY', epoch: rejectedEpoch })
    expect(store.bindLinks(rejectedEpoch, [{ ...binding(), linkId: 'L-NOT-IN-SCENE' }])).toBe(false)
  })

  it('认证主体、会话 epoch 或运行模式变化均使旧质量帧失效；同会话权限刷新保留结果', async () => {
    const store = prepare()
    const token = store.epoch
    expect(store.acceptFrame(token, { frameId: 1, simulationTime: 1 }, sourceCalc())).toBe(true)
    useAuthStore().$patch({ permissions: ['BUSINESS_READ'] })
    await nextTick()
    expect(store.snapshot?.frameId).toBe(1)

    const auth = useAuthStore()
    auth.$patch({ requestEpoch: auth.requestEpoch + 1 })
    await nextTick()
    expect(store.scope).toBeNull()
    expect(store.acceptFrame(token, { frameId: 2, simulationTime: 2 }, sourceCalc())).toBe(false)

    prepare()
    auth.$patch({ principal: { ...OPERATOR, userId: 'USR-OTHER' } })
    await nextTick()
    expect(store.scope).toBeNull()

    prepare()
    auth.$patch({ runtimeMode: 'MOCK' })
    await nextTick()
    expect(store.scope).toBeNull()
  })

  it('运行实例、场景修订和会话改变都会清空质量结果并淘汰旧 token', async () => {
    const store = prepare()
    const firstEpoch = store.epoch
    expect(store.acceptFrame(firstEpoch, { frameId: 1, simulationTime: 1 }, sourceCalc())).toBe(true)
    useSimulationStore().$patch({ run: { ...(useSimulationStore().run as SimulationRun), startedAt: '2026-10-31T02:00:00Z' } })
    await nextTick()
    expect(store).toMatchObject({ scope: null, bindings: [], snapshot: null, state: 'EMPTY' })
    expect(store.acceptFrame(firstEpoch, { frameId: 2, simulationTime: 2 }, sourceCalc())).toBe(false)

    const secondScope = { ...scope(), startedAt: '2026-10-31T02:00:00Z' }
    const activated = store.activate(secondScope, ['L-001'])
    expect(store.bindLinks(activated, [binding()])).toBe(true)
    expect(store.acceptFrame(store.epoch, { frameId: 1, simulationTime: 1 }, sourceCalc())).toBe(true)
    useSimulationStore().$patch({ selectedScene: { ...(useSimulationStore().selectedScene as any), revision: 2 } })
    await nextTick()
    expect(store.snapshot).toBeNull()

    const thirdScope = { ...secondScope, revision: 2 }
    const thirdEpoch = store.activate(thirdScope, ['L-001'])
    expect(store.bindLinks(thirdEpoch, [binding()])).toBe(true)
    expect(store.acceptFrame(store.epoch, { frameId: 1, simulationTime: 1 }, sourceCalc())).toBe(true)
    useAuthStore().resetToSafeEmpty()
    await nextTick()
    expect(store.scope).toBeNull()
    expect(store.acceptFrame(store.epoch - 1, { frameId: 2, simulationTime: 2 }, sourceCalc())).toBe(false)
    useAuthStore().$patch({ principal: structuredClone(OPERATOR), role: OPERATOR.role, permissions: [...OPERATOR.permissions], runtimeMode: 'LOCAL' })
    await nextTick()
    expect(store.snapshot).toBeNull()
  })

  it('绑定只能来自当前保存场景，源身份和场景链路均不可重复；合法绑定变化淘汰旧帧', () => {
    const store = prepare()
    const oldEpoch = store.epoch
    expect(store.acceptFrame(oldEpoch, { frameId: 1, simulationTime: 1 }, sourceCalc())).toBe(true)
    expect(store.bindLinks(oldEpoch, [{ ...binding(), linkId: 'L-OTHER' }])).toBe(false)
    expect(store.snapshot).not.toBeNull()
    expect(store.bindLinks(oldEpoch, [binding(), { ...binding(), linkId: 'L-001' }])).toBe(false)
    expect(store.bindLinks(oldEpoch, [{ ...binding(), linkId: 'L-001', sourcePortId: 'new_port' }])).toBe(true)
    expect(store.epoch).toBeGreaterThan(oldEpoch)
    expect(store.snapshot).toBeNull()
    expect(store.acceptFrame(oldEpoch, { frameId: 2, simulationTime: 2 }, sourceCalc())).toBe(false)

    useSimulationStore().$patch({ selectedScene: { config: { scenario: { id: scope().scenarioId }, links: [{ id: 'L-001' }, { id: 'L-002' }] }, revision: scope().revision } as any })
    const twoLinkEpoch = store.activate(scope(), ['L-001', 'L-002'])
    expect(store.bindLinks(twoLinkEpoch, [binding(), { ...binding(), linkId: 'L-002' }])).toBe(false)
  })

  it('非法新帧与未绑定链路清除旧成功结果，下一有效帧可恢复', () => {
    const store = prepare()
    const epoch = store.epoch
    expect(store.acceptFrame(epoch, { frameId: 1, simulationTime: 1 }, sourceCalc())).toBe(true)
    expect(store.acceptFrame(epoch, { frameId: 2, simulationTime: 2 }, { links: 'invalid' })).toBe(false)
    expect(store).toMatchObject({ snapshot: null, state: 'ERROR', errors: [{ fieldPath: 'link_calc.links' }] })
    expect(store.acceptFrame(epoch, { frameId: 3, simulationTime: 3 }, { links: [{ ...sourceCalc().links[0], tx_port: 'unbound' }] })).toBe(false)
    expect(store.errors[0]).toMatchObject({ code: 'RUNTIME_QUALITY_UNBOUND_LINK', fieldPath: 'link_calc.links[0]' })
    expect(store.acceptFrame(epoch, { frameId: 4, simulationTime: 4 }, sourceCalc())).toBe(true)
    expect(store).toMatchObject({ state: 'SUCCESS', errors: [], snapshot: { frameId: 4 } })
  })

  it('较新非法帧保留处理水位，迟到的旧成功帧不能覆盖 ERROR', () => {
    const store = prepare()
    const epoch = store.epoch
    expect(store.acceptFrame(epoch, { frameId: 10, simulationTime: 65.5 }, sourceCalc())).toBe(true)
    expect(store.acceptFrame(epoch, { frameId: 11, simulationTime: 66 }, { links: 'invalid' })).toBe(false)
    expect(store).toMatchObject({ state: 'ERROR', snapshot: null })
    expect(store.acceptFrame(epoch, { frameId: 10, simulationTime: 65.5 }, sourceCalc())).toBe(false)
    expect(store).toMatchObject({ state: 'ERROR', snapshot: null })
    expect(store.acceptFrame(epoch, { frameId: 12, simulationTime: 67 }, sourceCalc())).toBe(true)
  })

  it('合法空集合是 EMPTY 快照；非法元信息清除旧数据并保留定位错误', () => {
    const store = prepare()
    const epoch = store.epoch
    expect(store.acceptFrame(epoch, { frameId: 1, simulationTime: 1 }, sourceCalc())).toBe(true)
    expect(store.acceptFrame(epoch, { frameId: -1, simulationTime: 2 }, sourceCalc())).toBe(false)
    expect(store).toMatchObject({ state: 'ERROR', snapshot: null, errors: [{ code: 'RUNTIME_QUALITY_META_INVALID', fieldPath: 'meta' }] })
    expect(store.acceptFrame(epoch, { frameId: 2, simulationTime: 2 }, { links: [] })).toBe(true)
    expect(store).toMatchObject({ state: 'EMPTY', errors: [], snapshot: { frameId: 2, simulationTime: 2, data: { links: [] } } })
  })

  it('将已绑定质量身份映射到场景链路，维护本地状态但不把缺失的干扰功率伪造成前向选路结果', () => {
    const store = prepare()
    const scene = useSimulationStore().selectedScene as any
    scene.config.platforms = []
    scene.config.links = [{
      id: 'L-001', type: 'MICROWAVE', sourcePlatformId: 'UAV-001', targetPlatformId: 'SAT-001', enabled: true,
      frequency: 8200, bandwidth: 40, txPower: 20, antennaGain: { tx: 10, rx: 10 }, modulation: 'BPSK', berThreshold: 1e-5, dataRate: 1, direction: 'FORWARD',
    }]
    scene.config.linkSettings = {
      enabledSatellites: { TIANTONG: false, SHENTONG: false }, switchCooldownS: 0, switchStableChecks: 3,
      priority: ['SAT', 'MICROWAVE', 'DATALINK', 'LASER', 'FIBER'], switchCooldownFrames: 0,
      minimumGxbDb: 6, maximumBer: 1e-5, minimumGxbImprovementDb: 3, minimumBerImprovementFactor: 10, minimumSpatialIsolationDb: 0,
    }
    const calc = () => {
      const result = sourceCalc()
      ;(result.links[0]!.quality as any).gxb_db = 9
      ;(result.links[0]!.quality as any).ber = 1e-7
      return result
    }
    for (const frameId of [1, 2, 3]) expect(store.acceptFrame(store.epoch, { frameId, simulationTime: frameId }, calc())).toBe(true)
    expect(store.linkStatuses).toMatchObject([{ linkId: 'L-001', status: 'UP', available: true }])
    expect(store.routeCandidates).toMatchObject([{ linkId: 'L-001', eligible: false, eliminationReason: 'INTERFERENCE_POWER_MISSING' }])
    expect(store.routeDecisions).toMatchObject([{ selectedLinkId: null, execution: 'LOCAL_DECISION' }])
    expect(store.decisionEvents).toEqual([])
  })

  it('同一 scope 和已保存链路集合保留结果；重置后不接受迟到帧', () => {
    const store = prepare()
    const epoch = store.epoch
    expect(store.acceptFrame(epoch, { frameId: 1, simulationTime: 1 }, sourceCalc())).toBe(true)
    expect(store.activate(scope(), ['L-001'])).toBe(epoch)
    expect(store.snapshot).not.toBeNull()
    store.resetToSafeEmpty()
    expect(store).toMatchObject({ scope: null, bindings: [], snapshot: null, errors: [], state: 'EMPTY' })
    expect(store.acceptFrame(epoch, { frameId: 2, simulationTime: 2 }, sourceCalc())).toBe(false)
  })

  it('不同 Pinia 的质量域和 token 不互相污染', () => {
    const firstPinia = createPinia()
    setActivePinia(firstPinia)
    const first = prepare()
    expect(first.acceptFrame(first.epoch, { frameId: 1, simulationTime: 1 }, sourceCalc())).toBe(true)

    const secondPinia = createPinia()
    setActivePinia(secondPinia)
    const second = prepare()
    expect(second.snapshot).toBeNull()
    expect(second.acceptFrame(second.epoch, { frameId: 2, simulationTime: 2 }, sourceCalc())).toBe(true)

    setActivePinia(firstPinia)
    expect(first.snapshot?.frameId).toBe(1)
  })

  it('另一个 Pinia 活跃时，原实例的会话变化仍清空原实例，不能误读另一账号', () => {
    const firstPinia = createPinia()
    setActivePinia(firstPinia)
    const first = prepare()
    const firstAuth = useAuthStore()
    const oldEpoch = first.epoch
    expect(first.acceptFrame(oldEpoch, { frameId: 1, simulationTime: 1 }, sourceCalc())).toBe(true)
    setActivePinia(createPinia())
    const second = prepare()
    expect(second.acceptFrame(second.epoch, { frameId: 2, simulationTime: 2 }, sourceCalc())).toBe(true)
    firstAuth.$patch({ principal: { ...OPERATOR, userId: 'USR-OTHER' } })
    expect(first.snapshot).toBeNull()
    expect(first.scope).toBeNull()
    expect(second.snapshot?.frameId).toBe(2)
    expect(first.acceptFrame(oldEpoch, { frameId: 3, simulationTime: 3 }, sourceCalc())).toBe(false)
  })
})

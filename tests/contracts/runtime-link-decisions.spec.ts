import { describe, expect, it } from 'vitest'
import type { Link, ScenarioConfig } from '../../src/contracts/domain-models'
import { RuntimeLinkDecisionTracker } from '../../src/features/data-exchange/runtime-link-decisions'
import { LINK_CALC_DEFAULTS } from '../../src/features/scenarios/link-calc-defaults'
import type { RuntimeLinkQuality, RuntimeLinkQualityData } from '../../src/features/data-exchange/runtime-link-quality'

function link(id: string, type: Link['type'] = 'MICROWAVE'): Link {
  return {
    id, type, sourcePlatformId: 'SRC', targetPlatformId: 'DST', enabled: true,
    frequency: 8200, bandwidth: 40, txPower: 20, antennaGain: { tx: 10, rx: 10 },
    modulation: 'BPSK', berThreshold: 1e-5, dataRate: 1, direction: 'FORWARD',
  }
}

function config(links: Link[], values: Record<string, number> = {}) {
  return {
    platforms: [], links,
    linkSettings: {
      enabledSatellites: { TIANTONG: false, SHENTONG: false },
      switchCooldownS: 0, switchStableChecks: 3,
      switchCooldownFrames: 0, minimumGxbDb: 6, maximumBer: 1e-5,
      minimumGxbImprovementDb: 3, minimumBerImprovementFactor: 10, minimumSpatialIsolationDb: 0,
      ...values,
    },
  } as unknown as ScenarioConfig
}

function quality(linkId: string, gxbDb = 9, ber = 1e-7, interferencePowerDbm: number | null = -80): RuntimeLinkQuality {
  return {
    linkId, sourcePlatformId: 'SRC', destinationPlatformId: 'DST', sourcePortId: `${linkId}-tx`, destinationPortId: `${linkId}-rx`, distanceMeters: 1000,
    losses: { freeSpaceLossDb: 1, seaMultipathLossDb: 0, atmosphericLossDb: 0, cloudRainLossDb: 0, jammingLossDb: 0, totalLossDb: 1 },
    quality: { gxbDb, snrDb: null, ber, receivedPowerDbm: -90, interferencePowerDbm, modelVersion: 'test', modulation: 'BPSK',
      inputTrace: { eirpDbw: 1, gOverTDbK: 1, dataRateMbps: 1, jammerIds: [] } },
  }
}

function frame(frameId: number, links: RuntimeLinkQuality[]) {
  const data: RuntimeLinkQualityData = { modelVersion: 'test', modulation: 'BPSK', links }
  return { frameId, simulationTime: frameId, data }
}

describe('运行时链路状态与本地选路', () => {
  it.each([
    [undefined, [0, 9.99e-7, 1e-6, 9.99e-6, 1e-5, 1]],
    [{ warningThreshold: 0.1, emergencyThreshold: 0.9 }, [0, 0.099, 0.1, 0.899, 0.9, 1]],
  ] as const)('按当前场景的告警、紧急阈值分级，等号归入较严重一级', (thresholds, samples) => {
    const scene = config([link('L-1')], { switchStableChecks: 1 })
    if (thresholds) scene.linkSettings!.linkCalc = { ...LINK_CALC_DEFAULTS, ...thresholds }
    const tracker = new RuntimeLinkDecisionTracker()
    const statuses = samples.map((ber, i) => tracker.accept(frame(i, [quality('L-1', 9, ber)]), scene).statuses[0]?.status)
    expect(statuses).toEqual(['UP', 'UP', 'DEGRADED', 'DEGRADED', 'DOWN', 'DOWN'])
  })

  it('以连续三帧抑制状态抖动，缺失测量立即回到未知', () => {
    const tracker = new RuntimeLinkDecisionTracker()
    const scene = config([link('L-1')])
    for (const id of [1, 2]) expect(tracker.accept(frame(id, [quality('L-1')]), scene).statuses[0]).toMatchObject({ status: 'UNKNOWN', reason: 'STABILITY_PENDING', stableFrames: id })
    expect(tracker.accept(frame(3, [quality('L-1')]), scene).statuses[0]).toMatchObject({ status: 'UP', available: true, stableFrames: 3 })
    for (const id of [4, 5]) expect(tracker.accept(frame(id, [quality('L-1', 5, 2e-6)]), scene).statuses[0]).toMatchObject({ status: 'UP', reason: 'DEGRADED_PENDING' })
    expect(tracker.accept(frame(6, [quality('L-1', 5, 2e-6)]), scene).statuses[0]).toMatchObject({ status: 'DEGRADED', available: false })
    expect(tracker.accept(frame(7, []), scene).statuses[0]).toMatchObject({ status: 'UNKNOWN', reason: 'MEASUREMENT_MISSING', stableFrames: 0 })
  })

  it('前向同体制按干扰功率、再按 GXB 选择，并对质量改善和稳定窗口后才切换', () => {
    const tracker = new RuntimeLinkDecisionTracker()
    const scene = config([link('L-A'), link('L-B')])
    for (const id of [1, 2, 3]) tracker.accept(frame(id, [quality('L-A', 8, 5e-7, -80), quality('L-B', 8, 5e-7, -70)]), scene)
    expect(tracker.accept(frame(4, [quality('L-A', 8, 5e-7, -80), quality('L-B', 8, 5e-7, -70)]), scene).decisions[0]).toMatchObject({ selectedLinkId: 'L-A', state: 'HELD' })
    for (const id of [5, 6]) expect(tracker.accept(frame(id, [quality('L-A', 8, 5e-7, -60), quality('L-B', 11, 5e-7, -80)]), scene).decisions[0]).toMatchObject({ selectedLinkId: 'L-A', reason: 'STABILITY_PENDING' })
    expect(tracker.accept(frame(7, [quality('L-A', 8, 5e-7, -60), quality('L-B', 11, 5e-7, -80)]), scene).decisions[0]).toMatchObject({ previousLinkId: 'L-A', selectedLinkId: 'L-B', state: 'SWITCHED', reason: 'QUALITY_IMPROVEMENT_THRESHOLD_MET', execution: 'LOCAL_DECISION' })
  })

  it('保留自定义硬失效门限，要求接收功率而缺测时保持未知', () => {
    const down = new RuntimeLinkDecisionTracker()
    const failureScene = config([link('L-1')], { failureGxbDb: 4 })
    for (const id of [1, 2]) expect(down.accept(frame(id, [quality('L-1', 3)]), failureScene).statuses[0]?.status).toBe('UNKNOWN')
    expect(down.accept(frame(3, [quality('L-1', 3)]), failureScene).statuses[0]).toMatchObject({ status: 'DOWN', reason: 'FAILURE_THRESHOLD_REACHED' })
    const hardBer = config([link('L-1')], { failureBer: 5e-7, switchStableChecks: 1 })
    expect(down.accept(frame(4, [quality('L-1', 9, 4.99e-7)]), hardBer).statuses[0]?.status).toBe('UP')
    expect(down.accept(frame(5, [quality('L-1', 9, 5e-7)]), hardBer).statuses[0]?.status).toBe('DOWN')
    const powerRequired = new RuntimeLinkDecisionTracker()
    const powerScene = config([link('L-1')], { minimumReceivedPowerDbm: -100 })
    expect(powerRequired.accept(frame(1, [{ ...quality('L-1'), quality: { ...quality('L-1').quality, receivedPowerDbm: null } }]), powerScene).statuses[0])
      .toMatchObject({ status: 'UNKNOWN', reason: 'RECEIVED_POWER_MISSING' })
  })

  it('旧链路排序不参与本地选路，前向缺少接收干扰功率时仍排除', () => {
    const tracker = new RuntimeLinkDecisionTracker()
    const sat = link('L-SAT', 'SAT')
    const microwave = link('L-MW', 'MICROWAVE')
    const scene = config([sat, microwave])
    Object.assign(scene.linkSettings!, { priority: ['SAT', 'MICROWAVE', 'DATALINK', 'LASER', 'FIBER'] })
    for (const id of [1, 2, 3]) tracker.accept(frame(id, [quality('L-SAT', 7, 9e-6, -30), quality('L-MW', 15, 1e-7, -80)]), scene)
    expect(tracker.accept(frame(4, [quality('L-SAT', 7, 9e-6, -30), quality('L-MW', 15, 1e-7, -80)]), scene).decisions[0]?.selectedLinkId).toBe('L-MW')
    const withoutPower = new RuntimeLinkDecisionTracker()
    for (const id of [1, 2, 3]) withoutPower.accept(frame(id, [quality('L-MW', 15, 1e-7, null)]), config([microwave]))
    const result = withoutPower.accept(frame(4, [quality('L-MW', 15, 1e-7, null)]), config([microwave]))
    expect(result.candidates[0]).toMatchObject({ eligible: false, eliminationReason: 'INTERFERENCE_POWER_MISSING' })
    expect(result.decisions[0]).toMatchObject({ selectedLinkId: null, state: 'HELD', reason: 'NO_ELIGIBLE_CANDIDATE' })
    const tie = new RuntimeLinkDecisionTracker()
    const tieScene = config([link('L-B'), link('L-A')])
    for (const id of [1, 2, 3]) tie.accept(frame(id, [quality('L-B'), quality('L-A')]), tieScene)
    expect(tie.accept(frame(4, [quality('L-B'), quality('L-A')]), tieScene).decisions[0]?.selectedLinkId).toBe('L-A')
  })

  it('反向仅按 BER 再按 GXB 排序，帧号跳变清除稳定计数', () => {
    const tracker = new RuntimeLinkDecisionTracker()
    const first = { ...link('L-1'), direction: 'REVERSE' as const }
    const second = { ...link('L-2'), direction: 'REVERSE' as const }
    const scene = config([first, second], { switchStableChecks: 2 })
    tracker.accept(frame(1, [quality('L-1', 8, 1e-7), quality('L-2', 12, 5e-7)]), scene)
    const skipped = tracker.accept(frame(3, [quality('L-1', 8, 1e-7), quality('L-2', 12, 5e-7)]), scene)
    expect(skipped.decisions[0]).toMatchObject({ selectedLinkId: null, reason: 'NO_ELIGIBLE_CANDIDATE' })
    expect(tracker.accept(frame(4, [quality('L-1', 8, 1e-7), quality('L-2', 12, 5e-7)]), scene).decisions[0]).toMatchObject({ selectedLinkId: 'L-1', state: 'INITIALIZED' })
  })

  it('正 BER 改善为零仍满足倍数门限，零到零不会伪造改善', () => {
    const tracker = new RuntimeLinkDecisionTracker()
    const first = { ...link('L-1'), direction: 'REVERSE' as const }
    const second = { ...link('L-2'), direction: 'REVERSE' as const }
    const scene = config([first, second], { switchStableChecks: 1 })
    expect(tracker.accept(frame(1, [quality('L-1', 10, 5e-7), quality('L-2', 10, 1e-3)]), scene).decisions[0]?.selectedLinkId).toBe('L-1')
    expect(tracker.accept(frame(2, [quality('L-1', 10, 5e-7), quality('L-2', 10, 0)]), scene).decisions[0])
      .toMatchObject({ previousLinkId: 'L-1', selectedLinkId: 'L-2', state: 'SWITCHED', reason: 'QUALITY_IMPROVEMENT_THRESHOLD_MET' })
    const zero = new RuntimeLinkDecisionTracker()
    expect(zero.accept(frame(1, [quality('L-1', 10, 0), quality('L-2', 10, 1e-3)]), scene).decisions[0]?.selectedLinkId).toBe('L-1')
    expect(zero.accept(frame(2, [quality('L-1', 10, 0), quality('L-2', 11, 0)]), scene).decisions[0])
      .toMatchObject({ selectedLinkId: 'L-1', reason: 'QUALITY_IMPROVEMENT_NOT_MET' })
  })

  it('整组测量缺失会清空当前路由，恢复后仍须遵守上次切换的冷却时间', () => {
    const tracker = new RuntimeLinkDecisionTracker()
    const scene = config([link('L-A'), link('L-B')], { switchStableChecks: 1, switchCooldownFrames: 10, switchCooldownS: 10 })
    expect(tracker.accept(frame(1, [quality('L-A', 8, 5e-7, -80), quality('L-B', 8, 5e-7, -70)]), scene).decisions[0]?.selectedLinkId).toBe('L-A')
    expect(tracker.accept(frame(2, [quality('L-A', 8, 5e-7, -60), quality('L-B', 11, 5e-7, -80)]), scene).decisions[0])
      .toMatchObject({ selectedLinkId: 'L-B', state: 'SWITCHED' })
    expect(tracker.accept(frame(3, []), scene).decisions[0]).toMatchObject({ previousLinkId: 'L-B', selectedLinkId: null, state: 'UNAVAILABLE', reason: 'MEASUREMENT_MISSING' })
    expect(tracker.accept(frame(4, [quality('L-A', 12, 1e-7, -80), quality('L-B', 8, 5e-7, -60)]), scene).decisions[0])
      .toMatchObject({ selectedLinkId: null, state: 'HELD', reason: 'COOLDOWN_ACTIVE' })
  })

  it('无效质量帧清空候选但保留已切换路由的冷却锁', () => {
    const tracker = new RuntimeLinkDecisionTracker()
    const scene = config([link('L-A'), link('L-B')], { switchStableChecks: 1, switchCooldownFrames: 10, switchCooldownS: 10 })
    expect(tracker.accept(frame(1, [quality('L-A', 8, 5e-7, -80), quality('L-B', 8, 5e-7, -70)]), scene).decisions[0]?.selectedLinkId).toBe('L-A')
    expect(tracker.accept(frame(2, [quality('L-A', 8, 5e-7, -60), quality('L-B', 11, 5e-7, -80)]), scene).decisions[0]?.state).toBe('SWITCHED')
    // Store 在适配/绑定失败时调用 invalidate，而非完全 reset。
    tracker.invalidate()
    expect(tracker.accept(frame(3, [quality('L-A', 12, 1e-7, -80), quality('L-B', 8, 5e-7, -60)]), scene).decisions[0])
      .toMatchObject({ selectedLinkId: null, state: 'HELD', reason: 'COOLDOWN_ACTIVE' })
  })

  it('候选展示顺序和一基顺位与实际选路一致，剔除项排在最后', () => {
    const tracker = new RuntimeLinkDecisionTracker()
    const scene = config([link('L-A'), link('L-B'), link('L-C')], { switchStableChecks: 1 })
    const result = tracker.accept(frame(1, [quality('L-A', 9, 5e-7, -70), quality('L-B', 10, 1e-7, -80), quality('L-C', 3, 1e-3, -100)]), scene)
    expect(result.candidates.map(item => [item.linkId, item.rank, item.eligible])).toEqual([['L-B', 1, true], ['L-A', 2, true], ['L-C', 3, false]])
    expect(result.decisions[0]?.selectedLinkId).toBe(result.candidates[0]!.linkId)
  })
})

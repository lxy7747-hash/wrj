import type { Link, LinkDirection, LinkType, Platform, ScenarioLinkSettings } from '../../contracts/domain-models'
import { LINK_DECISION_DEFAULTS, isConfiguredLinkEnabled, readLinkSettings } from '../scenarios/link-settings'
import type { RuntimeLinkQuality, RuntimeLinkQualityData } from './runtime-link-quality'

/** 本地质量判定版本；仅说明前端按同一帧质量快照作出的判断，不是引擎执行回执。 */
export const RUNTIME_LINK_DECISION_THRESHOLD_VERSION = 'LOCAL-V1.2' as const

export type RuntimeLinkStatusState = 'UNKNOWN' | 'UP' | 'DEGRADED' | 'DOWN'
export type RuntimeRouteDecisionState = 'INITIALIZED' | 'SWITCHED' | 'HELD' | 'UNAVAILABLE'

export interface RuntimeLinkStatus {
  linkId: string
  frameId: number
  simulationTime: number
  status: RuntimeLinkStatusState
  available: boolean
  reason: string
  stableFrames: number
  thresholdVersion: typeof RUNTIME_LINK_DECISION_THRESHOLD_VERSION
  gxbDb: number | null
  ber: number | null
  receivedPowerDbm: number | null
}

export interface RuntimeRouteCandidate {
  routeKey: string
  linkId: string
  direction: LinkDirection
  type: LinkType
  rank: number
  eligible: boolean
  eliminationReason: string | null
  gxbDb: number | null
  ber: number | null
  interferencePowerDbm: number | null
  stableFrames: number
}

/**
 * 只记录已由本地质量快照得出的建议。execution 为 LOCAL_DECISION 时不得视为引擎完成了切换。
 */
export interface RuntimeRouteDecision {
  routeKey: string
  direction: LinkDirection
  frameId: number
  simulationTime: number
  previousLinkId: string | null
  selectedLinkId: string | null
  state: RuntimeRouteDecisionState
  reason: string
  execution: 'LOCAL_DECISION'
  gxbDb: number | null
  ber: number | null
}

export interface RuntimeLinkDecisionSnapshot {
  statuses: RuntimeLinkStatus[]
  candidates: RuntimeRouteCandidate[]
  decisions: RuntimeRouteDecision[]
}

export interface RuntimeLinkDecisionFrame {
  frameId: number
  simulationTime: number
  data: RuntimeLinkQualityData
}

interface DecisionSettings {
  switchStableChecks: number
  switchCooldownS: number
  switchCooldownFrames: number
  minimumGxbDb: number
  maximumBer: number
  minimumGxbImprovementDb: number
  minimumBerImprovementFactor: number
  minimumSpatialIsolationDb: number
  minimumReceivedPowerDbm: number | null
  failureGxbDb: number | null
  failureBer: number | null
  priority: readonly LinkType[]
}

interface StatusMemory {
  committed: Exclude<RuntimeLinkStatusState, 'UNKNOWN'> | null
  pending: Exclude<RuntimeLinkStatusState, 'UNKNOWN'> | null
  streak: number
  lastFrameId: number | null
}

interface RouteMemory {
  selectedLinkId: string | null
  candidateLinkId: string | null
  candidateStreak: number
  lastSwitchFrameId: number | null
  lastSwitchTime: number | null
  lastFrameId: number | null
}

interface MeasuredLink {
  link: Link
  quality: RuntimeLinkQuality
  routeKey: string
  enabled: boolean
  spatiallyIsolated: boolean
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : fallback
}

function nonNegative(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function configuredDecisionSettings(settings: ScenarioLinkSettings): DecisionSettings {
  const raw = settings as ScenarioLinkSettings & Record<string, unknown>
  return {
    switchStableChecks: positiveInteger(raw.switchStableChecks, LINK_DECISION_DEFAULTS.switchStableChecks),
    switchCooldownS: nonNegative(raw.switchCooldownS, LINK_DECISION_DEFAULTS.switchCooldownS),
    switchCooldownFrames: nonNegative(raw.switchCooldownFrames, LINK_DECISION_DEFAULTS.switchCooldownFrames),
    minimumGxbDb: finiteOrNull(raw.minimumGxbDb) ?? LINK_DECISION_DEFAULTS.minimumGxbDb,
    maximumBer: finiteOrNull(raw.maximumBer) ?? LINK_DECISION_DEFAULTS.maximumBer,
    minimumGxbImprovementDb: nonNegative(raw.minimumGxbImprovementDb, LINK_DECISION_DEFAULTS.minimumGxbImprovementDb),
    minimumBerImprovementFactor: nonNegative(raw.minimumBerImprovementFactor, LINK_DECISION_DEFAULTS.minimumBerImprovementFactor),
    minimumSpatialIsolationDb: nonNegative(raw.minimumSpatialIsolationDb, LINK_DECISION_DEFAULTS.minimumSpatialIsolationDb),
    minimumReceivedPowerDbm: finiteOrNull(raw.minimumReceivedPowerDbm),
    failureGxbDb: finiteOrNull(raw.failureGxbDb),
    failureBer: finiteOrNull(raw.failureBer),
    priority: Array.isArray(settings.priority) ? settings.priority : [],
  }
}

function routeKey(link: Pick<Link, 'sourcePlatformId' | 'targetPlatformId' | 'direction'>): string {
  return JSON.stringify([link.sourcePlatformId, link.targetPlatformId, link.direction])
}

function rawStatus(quality: RuntimeLinkQuality, settings: DecisionSettings): { status: Exclude<RuntimeLinkStatusState, 'UNKNOWN'> | null; reason: string } {
  const gxb = quality.quality.gxbDb
  const ber = quality.quality.ber
  const power = quality.quality.receivedPowerDbm
  if (gxb === null || ber === null) return { status: null, reason: 'GXB_OR_BER_MISSING' }
  if (settings.minimumReceivedPowerDbm !== null && power === null) return { status: null, reason: 'RECEIVED_POWER_MISSING' }
  if ((settings.failureGxbDb !== null && gxb < settings.failureGxbDb)
    || (settings.failureBer !== null && ber > settings.failureBer)
    || (settings.minimumReceivedPowerDbm !== null && power! < settings.minimumReceivedPowerDbm)) {
    return { status: 'DOWN', reason: 'FAILURE_THRESHOLD_REACHED' }
  }
  if (gxb >= settings.minimumGxbDb && ber <= settings.maximumBer) return { status: 'UP', reason: 'AVAILABLE' }
  return { status: 'DEGRADED', reason: 'AVAILABILITY_THRESHOLD_NOT_MET' }
}

function rawAvailable(quality: RuntimeLinkQuality, settings: DecisionSettings): boolean {
  return quality.quality.gxbDb !== null && quality.quality.ber !== null
    && quality.quality.gxbDb >= settings.minimumGxbDb && quality.quality.ber <= settings.maximumBer
    && (settings.minimumReceivedPowerDbm === null
      || (quality.quality.receivedPowerDbm !== null && quality.quality.receivedPowerDbm >= settings.minimumReceivedPowerDbm))
}

function advanceStatus(memory: StatusMemory, frameId: number, quality: RuntimeLinkQuality, settings: DecisionSettings): RuntimeLinkStatus {
  const raw = rawStatus(quality, settings)
  const continuous = memory.lastFrameId === null || frameId === memory.lastFrameId + 1
  memory.lastFrameId = frameId
  if (raw.status === null) {
    memory.committed = null
    memory.pending = null
    memory.streak = 0
    return { linkId: '', frameId, simulationTime: 0, status: 'UNKNOWN', available: false, reason: raw.reason, stableFrames: 0,
      thresholdVersion: RUNTIME_LINK_DECISION_THRESHOLD_VERSION, gxbDb: quality.quality.gxbDb, ber: quality.quality.ber, receivedPowerDbm: quality.quality.receivedPowerDbm }
  }
  if (!continuous || memory.pending !== raw.status) {
    memory.pending = raw.status
    memory.streak = 1
  } else {
    memory.streak += 1
  }
  if (memory.committed === null) {
    if (memory.streak >= settings.switchStableChecks) memory.committed = raw.status
  } else if (memory.committed !== raw.status && memory.streak >= settings.switchStableChecks) {
    memory.committed = raw.status
  }
  const status = memory.committed ?? 'UNKNOWN'
  return { linkId: '', frameId, simulationTime: 0, status, available: status === 'UP',
    reason: status === 'UNKNOWN' ? 'STABILITY_PENDING' : status === raw.status ? raw.reason : `${raw.status}_PENDING`, stableFrames: memory.streak,
    thresholdVersion: RUNTIME_LINK_DECISION_THRESHOLD_VERSION, gxbDb: quality.quality.gxbDb, ber: quality.quality.ber, receivedPowerDbm: quality.quality.receivedPowerDbm }
}

function mediaRank(type: LinkType, priority: readonly LinkType[]): number {
  const rank = priority.indexOf(type)
  return rank >= 0 ? rank : priority.length
}

function eligibleCandidate(candidate: RuntimeRouteCandidate): boolean {
  return candidate.eligible
}

function compareCandidates(direction: LinkDirection, left: RuntimeRouteCandidate, right: RuntimeRouteCandidate, priority: readonly LinkType[]): number {
  // 场景配置的体制优先级先约束候选类型；同优先级体制内再按大纲的质量指标选择。
  const priorityDifference = mediaRank(left.type, priority) - mediaRank(right.type, priority)
  if (priorityDifference !== 0) return priorityDifference
  if (direction === 'FORWARD') {
    const lp = left.interferencePowerDbm!
    const rp = right.interferencePowerDbm!
    if (lp !== rp) return lp - rp
  } else if (left.ber !== right.ber) return left.ber! - right.ber!
  if (left.gxbDb !== right.gxbDb) return right.gxbDb! - left.gxbDb!
  // 不使用 localeCompare，避免 Windows 与国产 Linux 的区域设置改变同指标时的可复现顺序。
  return left.linkId < right.linkId ? -1 : left.linkId > right.linkId ? 1 : 0
}

function improvementSatisfied(current: RuntimeRouteCandidate | undefined, candidate: RuntimeRouteCandidate, settings: DecisionSettings): boolean {
  if (!current) return true
  const candidateGxb = candidate.gxbDb
  const currentGxb = current.gxbDb
  const candidateBer = candidate.ber
  const currentBer = current.ber
  const gxbImproved = candidateGxb !== null && currentGxb !== null
    && candidateGxb >= currentGxb + settings.minimumGxbImprovementDb
  // 0 BER cannot demonstrate a factor improvement; do not manufacture a gain from 0 / 0.
  // BER=0 是有效的理想测量：只要当前 BER 为正，0 也满足改善倍数；唯独 0→0 不能伪造改善。
  const berImproved = candidateBer !== null && currentBer !== null && currentBer > 0
    && candidateBer <= currentBer / settings.minimumBerImprovementFactor
  return gxbImproved || berImproved
}

export class RuntimeLinkDecisionTracker {
  private readonly statuses = new Map<string, StatusMemory>()
  private readonly routes = new Map<string, RouteMemory>()

  reset(): void {
    this.statuses.clear()
    this.routes.clear()
  }

  /**
   * 当前帧无效时丢弃状态与候选，保留同一运行已经发生的切换冷却锁，
   * 避免一条坏质量帧让下一次重获测量绕过防乒乓约束。
   */
  invalidate(): void {
    this.statuses.clear()
    for (const route of this.routes.values()) {
      route.selectedLinkId = null
      route.candidateLinkId = null
      route.candidateStreak = 0
      route.lastFrameId = null
    }
  }

  /**
   * 将已经过 scope、绑定及单调性校验的单帧快照投影为本地状态和选路建议。
   * 不写回引擎、不发布切换消息，也不把本地选择伪装成实际执行成功。
   */
  accept(frame: RuntimeLinkDecisionFrame, config: Pick<{ links: Link[]; platforms: Platform[]; linkSettings?: ScenarioLinkSettings }, 'links' | 'platforms' | 'linkSettings'>): RuntimeLinkDecisionSnapshot {
    const sceneSettings = readLinkSettings(config)
    const settings = configuredDecisionSettings(sceneSettings)
    const configuredById = new Map(config.links.map(link => [link.id, link]))
    const measurementByLinkId = new Map<string, RuntimeLinkQuality>()
    for (const measurement of frame.data.links) {
      const configured = configuredById.get(measurement.linkId)
      // 原始 link_calc 标识通常并非场景链路 ID，由 Store 的显式绑定映射在外层改写为场景 ID。
      if (!configured) continue
      measurementByLinkId.set(configured.id, measurement)
    }
    const statuses: RuntimeLinkStatus[] = []
    for (const configured of config.links) {
      const measurement = measurementByLinkId.get(configured.id)
      const memory = this.statuses.get(configured.id) ?? { committed: null, pending: null, streak: 0, lastFrameId: null }
      this.statuses.set(configured.id, memory)
      if (!measurement) {
        memory.committed = null
        memory.pending = null
        memory.streak = 0
        memory.lastFrameId = frame.frameId
        statuses.push({ linkId: configured.id, frameId: frame.frameId, simulationTime: frame.simulationTime, status: 'UNKNOWN', available: false,
          reason: 'MEASUREMENT_MISSING', stableFrames: 0, thresholdVersion: RUNTIME_LINK_DECISION_THRESHOLD_VERSION,
          gxbDb: null, ber: null, receivedPowerDbm: null })
        continue
      }
      statuses.push({ ...advanceStatus(memory, frame.frameId, measurement, settings), linkId: configured.id, simulationTime: frame.simulationTime })
    }

    const statusById = new Map(statuses.map(status => [status.linkId, status]))
    const measured: MeasuredLink[] = []
    for (const link of config.links) {
      const quality = measurementByLinkId.get(link.id)
      if (!quality) continue
      const enabled = isConfiguredLinkEnabled(link, sceneSettings, config.platforms)
      const spatiallyIsolated = (link.spatialIsolationDb ?? 0) >= settings.minimumSpatialIsolationDb
      measured.push({ link, quality, routeKey: routeKey(link), enabled, spatiallyIsolated })
    }

    const candidates: RuntimeRouteCandidate[] = []
    const grouped = new Map<string, MeasuredLink[]>()
    const configuredRoutes = new Map<string, LinkDirection>()
    for (const link of config.links) configuredRoutes.set(routeKey(link), link.direction)
    for (const item of measured) grouped.set(item.routeKey, [...(grouped.get(item.routeKey) ?? []), item])
    for (const [key, items] of grouped) {
      for (const item of items) {
        const status = statusById.get(item.link.id)
        let eliminationReason: string | null = null
        if (!item.enabled) eliminationReason = 'LINK_DISABLED'
        else if (!item.spatiallyIsolated) eliminationReason = 'SPATIAL_ISOLATION_NOT_MET'
        // 已提交的 UP 在劣化去抖窗口内只用于显示，不可让当前原始阈值已失效的链路进入候选集。
        else if (status?.status !== 'UP' || !rawAvailable(item.quality, settings)) eliminationReason = status?.reason ?? 'AVAILABILITY_THRESHOLD_NOT_MET'
        else if (item.link.direction === 'FORWARD' && item.quality.quality.interferencePowerDbm === null) eliminationReason = 'INTERFERENCE_POWER_MISSING'
        candidates.push({ routeKey: key, linkId: item.link.id, direction: item.link.direction, type: item.link.type,
          rank: 0, eligible: eliminationReason === null, eliminationReason,
          gxbDb: item.quality.quality.gxbDb, ber: item.quality.quality.ber, interferencePowerDbm: item.quality.quality.interferencePowerDbm,
          stableFrames: status?.stableFrames ?? 0 })
      }
    }

    // 展示顺位与实际选路共用同一排序，剔除项放在各自路由组末尾。
    candidates.sort((left, right) => {
      if (left.routeKey !== right.routeKey) return left.routeKey < right.routeKey ? -1 : 1
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1
      if (left.eligible) return compareCandidates(left.direction, left, right, settings.priority)
      return left.linkId < right.linkId ? -1 : left.linkId === right.linkId ? 0 : 1
    })
    const ranks = new Map<string, number>()
    for (const candidate of candidates) {
      candidate.rank = (ranks.get(candidate.routeKey) ?? 0) + 1
      ranks.set(candidate.routeKey, candidate.rank)
    }
    const decisions: RuntimeRouteDecision[] = []
    for (const [key, items] of grouped) {
      const routeCandidates = candidates.filter(candidate => candidate.routeKey === key)
      const direction = items[0]!.link.direction
      const memory = this.routes.get(key) ?? { selectedLinkId: null, candidateLinkId: null, candidateStreak: 0, lastSwitchFrameId: null, lastSwitchTime: null, lastFrameId: null }
      this.routes.set(key, memory)
      const continuous = memory.lastFrameId === null || frame.frameId === memory.lastFrameId + 1
      memory.lastFrameId = frame.frameId
      const eligible = routeCandidates.filter(eligibleCandidate)
      const proposed = eligible[0] ?? null
      if (!continuous || proposed?.linkId !== memory.candidateLinkId) {
        memory.candidateLinkId = proposed?.linkId ?? null
        memory.candidateStreak = proposed ? 1 : 0
      } else if (proposed) memory.candidateStreak += 1

      const current = routeCandidates.find(candidate => candidate.linkId === memory.selectedLinkId)
      const cooldownFramesPassed = memory.lastSwitchFrameId === null || frame.frameId - memory.lastSwitchFrameId >= settings.switchCooldownFrames
      const cooldownSecondsPassed = memory.lastSwitchTime === null || frame.simulationTime - memory.lastSwitchTime >= settings.switchCooldownS
      // 首次选路复用同一链路状态的连续帧计数，避免状态判定与选路各等一次稳定窗。
      const stable = proposed !== null && (memory.selectedLinkId === null
        ? proposed.stableFrames >= settings.switchStableChecks
        : memory.candidateStreak >= settings.switchStableChecks)
      const canSwitch = stable && cooldownFramesPassed && cooldownSecondsPassed
      const proposedChanged = proposed?.linkId !== memory.selectedLinkId
      let state: RuntimeRouteDecisionState = 'HELD'
      let reason = proposed ? 'CURRENT_ROUTE_RETAINED' : 'NO_ELIGIBLE_CANDIDATE'
      let previousLinkId = memory.selectedLinkId
      if (memory.selectedLinkId === null && proposed && stable) {
        if (cooldownFramesPassed && cooldownSecondsPassed) {
          memory.selectedLinkId = proposed.linkId
          state = 'INITIALIZED'
          reason = 'STABLE_CANDIDATE_SELECTED'
        } else reason = 'COOLDOWN_ACTIVE'
      } else if (proposedChanged && proposed && canSwitch) {
        if (!current || !current.eligible || improvementSatisfied(current, proposed, settings)) {
          memory.selectedLinkId = proposed.linkId
          memory.lastSwitchFrameId = frame.frameId
          memory.lastSwitchTime = frame.simulationTime
          state = 'SWITCHED'
          reason = !current || !current.eligible ? 'CURRENT_ROUTE_UNAVAILABLE' : 'QUALITY_IMPROVEMENT_THRESHOLD_MET'
        } else reason = 'QUALITY_IMPROVEMENT_NOT_MET'
      } else if (proposedChanged && proposed && !stable) reason = 'STABILITY_PENDING'
      else if (proposedChanged && proposed && (!cooldownFramesPassed || !cooldownSecondsPassed)) reason = 'COOLDOWN_ACTIVE'
      if (!proposed && current && !current.eligible) {
        memory.selectedLinkId = null
        state = 'UNAVAILABLE'
        reason = 'NO_ELIGIBLE_CANDIDATE'
      }
      const selected = routeCandidates.find(candidate => candidate.linkId === memory.selectedLinkId) ?? null
      decisions.push({ routeKey: key, direction, frameId: frame.frameId, simulationTime: frame.simulationTime,
        previousLinkId, selectedLinkId: selected?.linkId ?? null, state, reason, execution: 'LOCAL_DECISION',
        gxbDb: selected?.gxbDb ?? null, ber: selected?.ber ?? null })
    }
    // 本帧未收到某一路由组的任何测量时，不能保留上帧的主用链路或稳定计数。
    for (const [key, direction] of configuredRoutes) {
      if (grouped.has(key)) continue
      const memory = this.routes.get(key) ?? { selectedLinkId: null, candidateLinkId: null, candidateStreak: 0, lastSwitchFrameId: null, lastSwitchTime: null, lastFrameId: null }
      this.routes.set(key, memory)
      const previousLinkId = memory.selectedLinkId
      memory.lastFrameId = frame.frameId
      memory.candidateLinkId = null
      memory.candidateStreak = 0
      memory.selectedLinkId = null
      decisions.push({ routeKey: key, direction, frameId: frame.frameId, simulationTime: frame.simulationTime,
        previousLinkId, selectedLinkId: null, state: previousLinkId === null ? 'HELD' : 'UNAVAILABLE', reason: 'MEASUREMENT_MISSING',
        execution: 'LOCAL_DECISION', gxbDb: null, ber: null })
    }
    return { statuses, candidates, decisions }
  }
}

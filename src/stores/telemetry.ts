import { defineStore } from 'pinia'
import type {
  ApiFailure,
  CapabilityState,
  ClosedLoopContext,
  DetectionEvent,
  JammingDecision,
  JammingCommand,
  JammingParameterSet,
  JammerStatusData,
  JammerState,
  LinkStatusSummary,
  RealtimeEnvelope,
  SimulationState,
  SwitchEvent,
  SyncResult,
  TelemetryFrame,
  TaskId,
  WsConnectionState,
  WsTopic,
} from '../contracts/domain-models'
import { resolveLinkId, validateCandidateSnapshot, type CandidateSnapshotIssue } from '../features/situation/situation-model'
import { resolveMockOrigin, useAuthStore } from './auth'
import { useSimulationStore } from './simulation'

type SituationEvent = DetectionEvent | SwitchEvent

const TOPICS: WsTopic[] = ['simulation.frame', 'runtime.state', 'link.metric', 'jammer.event', 'switch.event']
const RETRY_DELAYS = [250, 500, 1_000, 2_000] as const
const PLATFORM_TYPES = new Set([
  'REAR_COMMAND_NODE', 'FORWARD_RELAY_NODE', 'GROUND_CLUSTER_COMMAND_NODE',
  'AIRBORNE_MISSION_CLUSTER', 'COMMUNICATION_SATELLITE', 'GROUND_JAMMER_DETECTION_STATION',
  'AIRBORNE_JAMMER_PLATFORM',
])
const LINK_TYPES = new Set(['SAT', 'MICROWAVE', 'DATALINK', 'LASER'])
const MAX_TELEMETRY_AGE_SECONDS = 5
const MAX_TELEMETRY_AGE_MS = MAX_TELEMETRY_AGE_SECONDS * 1_000

interface TelemetryRuntime {
  socket: WebSocket | null
  retryTimer: ReturnType<typeof setTimeout> | null
  retryAttempt: number
  manuallyClosed: boolean
}

const runtimes = new WeakMap<object, TelemetryRuntime>()

/** 返回指定 Store 实例独享的非响应式连接资源。 */
function runtimeFor(store: object): TelemetryRuntime {
  const existing = runtimes.get(store)
  if (existing !== undefined) return existing
  const runtime: TelemetryRuntime = { socket: null, retryTimer: null, retryAttempt: 0, manuallyClosed: false }
  runtimes.set(store, runtime)
  return runtime
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验对象的一组字段均为字符串。 */
function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'string')
}

/** 校验对象的一组字段均为非空字符串。 */
function hasNonEmptyStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'string' && value[key].length > 0)
}

/** 校验对象的一组字段均为有限数值。 */
function hasFiniteNumbers(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
}

/** 校验平台内嵌的干扰设备遥测。 */
function isJammerStatus(value: unknown): value is JammerStatusData {
  if (!isRecord(value)) return false
  const hasTarget = Object.prototype.hasOwnProperty.call(value, 'targetPlatform')
  return Object.keys(value).length === (hasTarget ? 8 : 7)
    && hasNonEmptyStrings(value, ['jammerId', 'platformId'])
    && (!hasTarget || (typeof value.targetPlatform === 'string' && value.targetPlatform.length > 0))
    && hasFiniteNumbers(value, ['time', 'power', 'frequency', 'bandwidth'])
    && Number(value.time) >= 0
    && Number(value.power) >= 0
    && Number(value.frequency) > 0
    && Number(value.bandwidth) > 0
    && typeof value.active === 'boolean'
}

/** 校验态势页会读取的平台状态字段。 */
function isPlatform(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.keys(value).length === 10
    && hasNonEmptyStrings(value, ['platformId'])
    && hasStrings(value, ['name'])
    && PLATFORM_TYPES.has(String(value.type))
    && hasFiniteNumbers(value, ['longitude', 'latitude', 'altitude', 'speed', 'updatedAt'])
    && Number(value.longitude) >= -180 && Number(value.longitude) <= 180
    && Number(value.latitude) >= -90 && Number(value.latitude) <= 90
    && Number(value.altitude) >= 0
    && Number(value.speed) >= 0
    && Number(value.updatedAt) >= 0
    && Array.isArray(value.linkIds)
    && value.linkIds.every((linkId) => typeof linkId === 'string' && linkId.length > 0)
    && new Set(value.linkIds).size === value.linkIds.length
    && Array.isArray(value.jammers) && value.jammers.every(isJammerStatus)
}

/** 校验态势页会读取的链路摘要字段。 */
function isLinkSummary(value: unknown): value is LinkStatusSummary {
  if (!isRecord(value)) return false
  return Object.keys(value).length === 8
    && hasNonEmptyStrings(value, ['linkKey', 'sourcePlatform', 'destPlatform'])
    && LINK_TYPES.has(String(value.linkType))
    && hasFiniteNumbers(value, ['currentSnr', 'currentBer', 'updatedAt'])
    && Number(value.currentBer) >= 0 && Number(value.currentBer) <= 1
    && Number(value.updatedAt) >= 0
    && (value.status === 'UP' || value.status === 'DOWN')
}

/** 校验链路详情面板会读取的完整遥测成员。 */
function isTelemetryLink(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.keys(value).length === 22
    && hasNonEmptyStrings(value, ['linkId', 'sourcePlatform', 'destPlatform'])
    && LINK_TYPES.has(String(value.linkType))
    && hasFiniteNumbers(value, [
      'time', 'frequency', 'bandwidth', 'distance', 'txPower', 'txAntennaGain', 'rxAntennaGain',
      'pathLoss', 'jammingPower', 'receivedPower', 'snr', 'ber', 'berThreshold', 'dataRate',
    ])
    && Number(value.time) >= 0
    && Number(value.frequency) > 0
    && Number(value.bandwidth) > 0
    && Number(value.distance) >= 0
    && Number(value.txPower) >= 0
    && Number(value.ber) >= 0 && Number(value.ber) <= 1
    && Number(value.berThreshold) >= 0 && Number(value.berThreshold) <= 1
    && Number(value.dataRate) >= 0
    && (value.modulation === 'BPSK' || value.modulation === 'QPSK')
    && value.coding === 'UNCODED'
    && value.qualityModelVersion === 'SNBER-1.2'
    && (value.linkStatus === 'UP' || value.linkStatus === 'DOWN')
}

/** 校验界面链路状态投影成员。 */
function isUiLink(value: unknown): value is TelemetryFrame['uiLinks'][number] {
  if (!isRecord(value)) return false
  return Object.keys(value).length === 8
    && hasNonEmptyStrings(value, ['linkId'])
    && typeof value.frameId === 'string' && value.frameId.startsWith('F-')
    && typeof value.reason === 'string' && value.reason.length > 0
    && value.thresholdVersion === 'LLZT-1.0'
    && (value.status === 'UP' || value.status === 'DEGRADED' || value.status === 'DOWN')
    && (value.canonicalStatus === 'UP' || value.canonicalStatus === 'DOWN')
    && Number.isInteger(value.consecutiveFrames) && Number(value.consecutiveFrames) >= 0
    && typeof value.ageMs === 'number' && Number.isFinite(value.ageMs)
    && value.ageMs >= 0 && value.ageMs <= MAX_TELEMETRY_AGE_MS
}

/** 校验链路候选面板会读取的完整候选证据。 */
function isRouteCandidate(value: unknown): value is TelemetryFrame['evidence']['routeCandidates'][number] {
  if (!isRecord(value)) return false
  return Object.keys(value).length === 8
    && typeof value.linkId === 'string' && value.linkId.length > 0
    && (value.direction === 'FORWARD' || value.direction === 'REVERSE')
    && typeof value.eligible === 'boolean'
    && hasFiniteNumbers(value, ['jamImpactDb', 'ber', 'stabilityFrames', 'rank'])
    && Number(value.ber) >= 0 && Number(value.ber) <= 1
    && Number.isInteger(value.stabilityFrames) && Number(value.stabilityFrames) >= 0
    && Number.isInteger(value.rank) && Number(value.rank) >= 1
    && (value.eliminationReason === null || (typeof value.eliminationReason === 'string' && value.eliminationReason.length > 0))
    && (value.eligible ? value.eliminationReason === null : value.eliminationReason !== null)
}

/** 校验逐帧选路结果所需的完整决策证据。 */
function isRouteDecision(value: unknown): value is TelemetryFrame['evidence']['routeDecisions'][number] {
  if (!isRecord(value) || Object.keys(value).length !== 12) return false
  return hasNonEmptyStrings(value, ['taskId', 'runId', 'frameId', 'selectedLinkId', 'previousLinkId', 'reason'])
    && (value.direction === 'FORWARD' || value.direction === 'REVERSE')
    && (value.strategy === 'MIN_JAM_IMPACT' || value.strategy === 'MIN_BER_WITH_HYSTERESIS')
    && hasFiniteNumbers(value, ['simulationTime', 'metric', 'minimumStableFrames'])
    && Number(value.simulationTime) >= 0
    && Number.isInteger(value.minimumStableFrames) && Number(value.minimumStableFrames) >= 1
    && (value.hysteresisThreshold === null
      || (typeof value.hysteresisThreshold === 'number' && Number.isFinite(value.hysteresisThreshold)
        && value.hysteresisThreshold >= 0 && value.hysteresisThreshold <= 1))
}

/** 校验固定帧中的候选排名和最终选路语义。 */
function hasValidRouteDecisions(frame: TelemetryFrame): boolean {
  if (frame.evidence.routeCandidates.length === 0) return frame.evidence.routeDecisions.length === 0
  if (frame.evidence.routeDecisions.length !== 2) return false

  return (['FORWARD', 'REVERSE'] as const).every((direction) => {
    const candidates = frame.evidence.routeCandidates
      .filter((candidate) => candidate.direction === direction)
      .slice()
      .sort((left, right) => left.rank - right.rank)
    const decision = frame.evidence.routeDecisions.find((item) => item.direction === direction)
    if (decision === undefined || candidates.length === 0
      || candidates.some((candidate, index) => candidate.rank !== index + 1)
      || candidates.some((candidate, index) => !candidate.eligible && candidates.slice(index + 1).some((item) => item.eligible))) {
      return false
    }

    const eligible = candidates.filter((candidate) => candidate.eligible)
    const metric = direction === 'FORWARD' ? 'jamImpactDb' : 'ber'
    if (eligible.length === 0
      || eligible.some((candidate, index) => index > 0 && candidate[metric] < eligible[index - 1]![metric])) return false

    const selected = eligible[0]
    if (decision.selectedLinkId !== selected.linkId
      || decision.metric !== selected[metric]
      || selected.stabilityFrames < decision.minimumStableFrames
      || !frame.links.some((link) => link.linkId === decision.previousLinkId)) return false

    return direction === 'FORWARD'
      ? decision.strategy === 'MIN_JAM_IMPACT'
        && decision.hysteresisThreshold === null
        && decision.reason === 'MINIMUM_JAM_IMPACT'
      : decision.strategy === 'MIN_BER_WITH_HYSTERESIS'
        && decision.hysteresisThreshold !== null
        && selected.ber <= decision.hysteresisThreshold
        && decision.reason === 'MINIMUM_BER_AND_STABLE'
  })
}

/** 校验传播损耗页面会读取的完整分量证据。 */
function isCompositeLossEvidence(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 9) return false
  return typeof value.linkId === 'string' && value.linkId.length > 0
    && hasFiniteNumbers(value, [
      'freeSpaceLossDb', 'systemLossDb', 'obstructionLossDb', 'interferenceLossDb',
      'totalPathLossDb', 'noisePowerDbm', 'effectiveNoiseAndInterferenceDbm',
    ])
    && value.modelVersion === 'COMPOSITE-LOSS-1.0'
}

/** 校验固定帧采用的完整同步证据。 */
function isSynchronizationEvidence(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 5) return false
  return value.configVersion === 'SCN-001-v4'
    && value.engineVersion === 'AFSIM-2.9.0-FIXTURE'
    && value.uiVersion === 'FRAME-1.0'
    && typeof value.effectiveFrameId === 'string' && value.effectiveFrameId.startsWith('F-')
    && typeof value.effectiveSimulationTime === 'number'
    && Number.isFinite(value.effectiveSimulationTime)
    && value.effectiveSimulationTime >= 0
}

/** 校验固定帧内的干扰执行证据。 */
function isJammerExecutionEvidence(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 8) return false
  return hasNonEmptyStrings(value, ['jammerId', 'targetPlatformId', 'reason'])
    && hasFiniteNumbers(value, ['power', 'frequency', 'bandwidth', 'startTime', 'duration'])
    && Number(value.power) >= 0
    && Number(value.frequency) > 0
    && Number(value.bandwidth) > 0
    && Number(value.startTime) >= 0
    && Number(value.duration) >= 0
}

/** 在其余帧字段尚未完成校验时读取可定位的候选快照问题。 */
function candidateSnapshotIssue(value: Record<string, unknown>): CandidateSnapshotIssue | null {
  if (typeof value.frameId !== 'string'
    || typeof value.simulationTime !== 'number'
    || !Array.isArray(value.linkSummaries)
    || !value.linkSummaries.every(isLinkSummary)
    || !isRecord(value.evidence)
    || !Array.isArray(value.evidence.routeCandidates)
    || !value.evidence.routeCandidates.every(isRouteCandidate)
    || !isSynchronizationEvidence(value.evidence.synchronization)) return null
  return validateCandidateSnapshot(value as unknown as TelemetryFrame)
}

/** 返回地图图层相对当前仿真时刻的首个坐标或数据新鲜度错误。 */
function frameConsistencyIssue(value: Record<string, unknown>): CandidateSnapshotIssue | null {
  if (typeof value.simulationTime !== 'number' || !Number.isFinite(value.simulationTime)) return null
  const simulationTime = value.simulationTime
  if (Array.isArray(value.platforms)) {
    for (const [index, platform] of value.platforms.entries()) {
      if (!isRecord(platform)) continue
      if (typeof platform.longitude === 'number' && typeof platform.latitude === 'number'
        && (platform.longitude < -180 || platform.longitude > 180 || platform.latitude < -90 || platform.latitude > 90)) {
        return {
          code: 'COORDINATE_INVALID',
          fieldPath: `platforms[${index}].longitude`,
          message: '节点坐标超出二维地图有效范围。',
        }
      }
      if (typeof platform.updatedAt === 'number'
        && (platform.updatedAt > simulationTime || simulationTime - platform.updatedAt > MAX_TELEMETRY_AGE_SECONDS)) {
        return {
          code: 'STALE_FRAME_DATA',
          fieldPath: `platforms[${index}].updatedAt`,
          message: '节点状态不在当前或最近 5 秒的数据窗口内。',
        }
      }
      if (Array.isArray(platform.jammers)) {
        const jammerIndex = platform.jammers.findIndex((jammer) => isRecord(jammer) && jammer.time !== simulationTime)
        if (jammerIndex >= 0) {
          return {
            code: 'STALE_FRAME_DATA',
            fieldPath: `platforms[${index}].jammers[${jammerIndex}].time`,
            message: '干扰状态与当前仿真时刻不一致。',
          }
        }
      }
    }
  }
  if (Array.isArray(value.links)) {
    const index = value.links.findIndex((link) => isRecord(link) && link.time !== simulationTime)
    if (index >= 0) {
      return { code: 'STALE_FRAME_DATA', fieldPath: `links[${index}].time`, message: '链路详情与当前仿真时刻不一致。' }
    }
  }
  if (Array.isArray(value.linkSummaries)) {
    const index = value.linkSummaries.findIndex((link) => isRecord(link)
      && typeof link.updatedAt === 'number'
      && (link.updatedAt > simulationTime || simulationTime - link.updatedAt > MAX_TELEMETRY_AGE_SECONDS))
    if (index >= 0) {
      return { code: 'STALE_FRAME_DATA', fieldPath: `linkSummaries[${index}].updatedAt`, message: '链路状态不在当前或最近 5 秒的数据窗口内。' }
    }
  }
  if (Array.isArray(value.uiLinks)) {
    const index = value.uiLinks.findIndex((link) => isRecord(link)
      && typeof link.ageMs === 'number' && (link.ageMs < 0 || link.ageMs > MAX_TELEMETRY_AGE_MS))
    if (index >= 0) {
      return { code: 'STALE_FRAME_DATA', fieldPath: `uiLinks[${index}].ageMs`, message: '链路界面投影不在当前或最近 5 秒的数据窗口内。' }
    }
    if (Array.isArray(value.linkSummaries) && Array.isArray(value.links)) {
      const frame = value as unknown as TelemetryFrame
      const linkSummaries = value.linkSummaries
      const mismatchIndex = value.uiLinks.findIndex((link) => {
        if (!isUiLink(link)) return false
        const summary = linkSummaries.find((item) => (
          isLinkSummary(item) && resolveLinkId(item, frame) === link.linkId
        ))
        return summary !== undefined
          && Math.abs(link.ageMs - (simulationTime - summary.updatedAt) * 1_000) > 1e-6
      })
      if (mismatchIndex >= 0) {
        return { code: 'LINK_AGE_MISMATCH', fieldPath: `uiLinks[${mismatchIndex}].ageMs`, message: '链路界面投影的数据年龄与链路摘要不一致。' }
      }
    }
  }
  return null
}

/** 校验 REST 或实时通道返回的完整遥测帧。 */
export function isTelemetryFrame(value: unknown): value is TelemetryFrame {
  if (!isRecord(value)) return false
  const structurallyValid = Object.keys(value).length === 11
    && typeof value.frameId === 'string' && value.frameId.startsWith('F-')
    && typeof value.taskId === 'string' && value.taskId.startsWith('TASK-')
    && typeof value.runId === 'string' && value.runId.startsWith('RUN-')
    && typeof value.simulationTime === 'number' && Number.isFinite(value.simulationTime) && value.simulationTime >= 0
    && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0
    && Array.isArray(value.platforms) && value.platforms.every(isPlatform)
    && Array.isArray(value.links) && value.links.every(isTelemetryLink)
    && Array.isArray(value.linkSummaries) && value.linkSummaries.every(isLinkSummary)
    && Array.isArray(value.uiLinks)
    && value.uiLinks.every((uiLink) => isUiLink(uiLink) && uiLink.frameId === value.frameId)
    && Array.isArray(value.eventIds)
    && value.eventIds.every((eventId) => typeof eventId === 'string' && eventId.length > 0)
    && new Set(value.eventIds).size === value.eventIds.length
    && isRecord(value.evidence) && Object.keys(value.evidence).length === 5
    && Array.isArray(value.evidence.losses) && value.evidence.losses.every(isCompositeLossEvidence)
    && Array.isArray(value.evidence.routeCandidates) && value.evidence.routeCandidates.every(isRouteCandidate)
    && Array.isArray(value.evidence.routeDecisions)
    && (value.evidence.routeDecisions.length === 0 || (value.evidence.routeDecisions.length === 2
      && value.evidence.routeDecisions.every((decision) => isRouteDecision(decision)
        && decision.taskId === value.taskId
        && decision.runId === value.runId
        && decision.frameId === value.frameId
        && decision.simulationTime === value.simulationTime
        && (value.evidence as TelemetryFrame['evidence']).routeCandidates.some((candidate) => candidate.direction === decision.direction
          && candidate.linkId === decision.selectedLinkId && candidate.eligible))
      && new Set(value.evidence.routeDecisions.map((decision) => decision.direction)).size === 2))
    && isSynchronizationEvidence(value.evidence.synchronization)
    && isJammerExecutionEvidence(value.evidence.jammerExecution)
  if (!structurallyValid) return false

  const frame = value as unknown as TelemetryFrame
  return frameConsistencyIssue(value) === null
    && validateCandidateSnapshot(value as unknown as TelemetryFrame) === null
    && hasValidRouteDecisions(frame)
}

/** 校验同帧侦测或链路切换事件的公共身份字段。 */
export function isSituationEvent(value: unknown): value is SituationEvent {
  if (!isRecord(value)) return false
  const hasRegistryTime = Object.prototype.hasOwnProperty.call(value, 'sourceRegistryTime')
  const common = typeof value.eventId === 'string' && value.eventId.length > 0
    && typeof value.frameId === 'string' && value.frameId.startsWith('F-')
    && typeof value.time === 'number' && Number.isFinite(value.time) && value.time >= 0
    && typeof value.dedupeKey === 'string' && value.dedupeKey.length > 0
    && (!hasRegistryTime || (typeof value.sourceRegistryTime === 'number'
      && Number.isFinite(value.sourceRegistryTime) && value.sourceRegistryTime >= 0))
  if (!common) return false
  if (value.type === 'DETECTION') {
    return Object.keys(value).length === (hasRegistryTime ? 9 : 8)
      && typeof value.sensorId === 'string' && value.sensorId.length > 0
      && typeof value.targetPlatformId === 'string' && value.targetPlatformId.length > 0
      && typeof value.detectionProbability === 'number'
      && Number.isFinite(value.detectionProbability)
      && value.detectionProbability >= 0
      && value.detectionProbability <= 1
  }
  return Object.keys(value).length === (hasRegistryTime ? 17 : 16)
    && value.type === 'LINK_SWITCH'
    && (value.direction === 'FORWARD' || value.direction === 'REVERSE')
    && typeof value.oldLinkId === 'string' && value.oldLinkId.length > 0
    && typeof value.newLinkId === 'string' && value.newLinkId.length > 0
    && hasFiniteNumbers(value, ['oldBer', 'newBer', 'stabilityFrames', 'minimumStableFrames', 'cooldownRemainingS'])
    && Number(value.oldBer) >= 0 && Number(value.oldBer) <= 1
    && Number(value.newBer) >= 0 && Number(value.newBer) <= 1
    && Number.isInteger(value.stabilityFrames) && Number(value.stabilityFrames) >= 0
    && Number.isInteger(value.minimumStableFrames) && Number(value.minimumStableFrames) >= 1
    && typeof value.hysteresisSatisfied === 'boolean'
    && Number(value.cooldownRemainingS) >= 0
    && (value.decision === 'ACCEPTED' || value.decision === 'REJECTED')
    && typeof value.reason === 'string' && value.reason.length > 0
}

/** 校验链路切换结论与当前帧指标、稳定性、滞回和冷却证据一致。 */
function isSwitchEventConsistent(event: SwitchEvent, frame: TelemetryFrame): boolean {
  const routeDecision = frame.evidence.routeDecisions.find((decision) => decision.direction === event.direction)
  const oldSummary = frame.linkSummaries.find((summary) => resolveLinkId(summary, frame) === event.oldLinkId)
  const newSummary = frame.linkSummaries.find((summary) => resolveLinkId(summary, frame) === event.newLinkId)
  if (routeDecision === undefined || oldSummary === undefined || newSummary === undefined
    || event.oldLinkId === event.newLinkId
    || event.oldBer !== oldSummary.currentBer
    || event.newBer !== newSummary.currentBer) return false

  if (event.decision === 'ACCEPTED') {
    return event.oldLinkId === routeDecision.previousLinkId
      && event.newLinkId === routeDecision.selectedLinkId
      && event.cooldownRemainingS === 0
      && event.stabilityFrames >= event.minimumStableFrames
      && event.hysteresisSatisfied
      && event.newBer < event.oldBer
      && event.reason === 'BER_THRESHOLD_AND_HYSTERESIS'
  }
  return event.reason === 'COOLDOWN_ACTIVE' && event.cooldownRemainingS > 0
}

/** 校验实时规范仿真状态。 */
function isSimulationState(value: unknown): value is SimulationState {
  if (!isRecord(value)) return false
  const hasErrorMessage = Object.prototype.hasOwnProperty.call(value, 'errorMessage')
  return Object.keys(value).length === (hasErrorMessage ? 6 : 5)
    && ['IDLE', 'RUNNING', 'PAUSED', 'COMPLETED', 'ERROR'].includes(String(value.status))
    && typeof value.currentTime === 'number' && Number.isFinite(value.currentTime) && value.currentTime >= 0
    && typeof value.totalDuration === 'number' && Number.isFinite(value.totalDuration) && value.totalDuration >= 0
    && (value.processId === null || (Number.isInteger(value.processId) && Number(value.processId) > 0))
    && typeof value.progress === 'number' && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 100
    && (!hasErrorMessage || typeof value.errorMessage === 'string')
}

class TelemetryFieldError extends Error {
  constructor(
    readonly code: string,
    readonly fieldPath: string,
    message: string,
  ) {
    super(message)
  }
}

class CapabilityRequestError extends Error {
  constructor(
    readonly code: string,
    readonly fieldPath: string | null,
    message: string,
  ) {
    super(message)
  }
}

/** 校验 RF 干扰控制命令的闭合结构和基础数值类型。 */
function isJammingCommand(value: unknown): value is JammingCommand {
  return isRecord(value)
    && Object.keys(value).length === 6
    && ['enabled', 'frequency', 'bandwidth', 'power', 'direction', 'duration'].every((key) => Object.hasOwn(value, key))
    && typeof value.enabled === 'boolean'
    && hasFiniteNumbers(value, ['frequency', 'bandwidth', 'power', 'direction', 'duration'])
    && Number(value.frequency) > 0
    && Number(value.bandwidth) > 0
    && Number(value.power) >= 0
    && Number(value.direction) >= 0 && Number(value.direction) <= 360
    && Number(value.duration) > 0
}

/** 校验服务端返回的 RF 干扰机执行状态。 */
function isJammerState(value: unknown, taskId: TaskId, jammerId: string): value is JammerState {
  return isRecord(value)
    && Object.keys(value).length === 11
    && hasNonEmptyStrings(value, ['taskId', 'jammerId', 'effectiveFrameId', 'reason'])
    && value.taskId === taskId
    && value.jammerId === jammerId
    && String(value.effectiveFrameId).startsWith('F-')
    && value.executionStatus === 'SUCCESS'
    && isJammingCommand({
      enabled: value.enabled,
      frequency: value.frequency,
      bandwidth: value.bandwidth,
      power: value.power,
      direction: value.direction,
      duration: value.duration,
    })
}

/** 从统一信封读取 RF 干扰机状态，并保留类型化拒绝原因。 */
async function readJammerState(response: Response, taskId: TaskId, jammerId: string): Promise<JammerState> {
  const payload = await response.json() as unknown
  if (!response.ok) {
    if (isRecord(payload) && isRecord(payload.error)
      && typeof payload.error.code === 'string' && typeof payload.error.message === 'string') {
      throw new CapabilityRequestError(
        payload.error.code,
        typeof payload.error.fieldPath === 'string' ? payload.error.fieldPath : null,
        payload.error.message,
      )
    }
    throw new CapabilityRequestError('JAMMER_CONTROL_FAILED', null, '干扰控制请求失败。')
  }
  if (!isRecord(payload) || payload.ok !== true || !isJammerState(payload.data, taskId, jammerId)) {
    throw new CapabilityRequestError('INVALID_RESPONSE', null, '干扰控制响应格式不正确。')
  }
  return payload.data
}

/** 从统一信封读取类型化能力结果，并保留服务端的字段级错误。 */
async function readCapabilityResult<T>(
  response: Response,
  validate: (value: unknown) => value is T,
  fallbackCode: string,
  fallbackMessage: string,
): Promise<T> {
  const payload = await response.json() as unknown
  if (!response.ok) {
    if (isRecord(payload) && isRecord(payload.error)
      && typeof payload.error.code === 'string' && typeof payload.error.message === 'string') {
      throw new CapabilityRequestError(
        payload.error.code,
        typeof payload.error.fieldPath === 'string' ? payload.error.fieldPath : null,
        payload.error.message,
      )
    }
    throw new CapabilityRequestError(fallbackCode, null, fallbackMessage)
  }
  if (!isRecord(payload) || payload.ok !== true || !validate(payload.data)) {
    throw new CapabilityRequestError('INVALID_RESPONSE', null, '服务响应格式不正确。')
  }
  return payload.data
}

/** 校验逐帧闭环输入的闭合结构。 */
function isClosedLoopContext(value: unknown): value is ClosedLoopContext {
  return isRecord(value)
    && Object.keys(value).length === 4
    && hasNonEmptyStrings(value, ['frameId', 'detectionEventId', 'targetPlatformId', 'affectedLinkId'])
}

/** 校验服务端返回的闭环干扰决策。 */
function isJammingDecision(
  value: unknown,
  runId: string,
  context: ClosedLoopContext,
  frame: TelemetryFrame,
): value is JammingDecision {
  return isRecord(value)
    && Object.keys(value).length === 11
    && hasNonEmptyStrings(value, [
      'decisionId', 'runId', 'frameId', 'detectionEventId', 'targetPlatformId',
      'jammerId', 'affectedLinkId', 'effectiveFrameId', 'reason',
    ])
    && value.action === 'START'
    && (value.linkStatus === 'UP' || value.linkStatus === 'DEGRADED' || value.linkStatus === 'DOWN')
    && value.runId === runId
    && value.frameId === context.frameId
    && value.detectionEventId === context.detectionEventId
    && value.targetPlatformId === context.targetPlatformId
    && value.affectedLinkId === context.affectedLinkId
    && value.effectiveFrameId === frame.frameId
    && value.jammerId === frame.evidence.jammerExecution.jammerId
    && value.linkStatus === frame.uiLinks.find((link) => link.linkId === context.affectedLinkId)?.status
}

/** 校验带版本和生效帧的干扰参数集。 */
function isJammingParameterSet(value: unknown): value is JammingParameterSet {
  return isRecord(value)
    && Object.keys(value).length === 3
    && Number.isSafeInteger(value.version) && Number(value.version) > 0
    && typeof value.effectiveFrameId === 'string' && value.effectiveFrameId.startsWith('F-')
    && isJammingCommand(value.parameters)
}

/** 校验四端版本一致的干扰参数同步结果。 */
function isSyncResult(
  value: unknown,
  taskId: TaskId,
  jammerId: string,
  parameterSet: JammingParameterSet,
  frame: TelemetryFrame,
): value is SyncResult {
  if (!isRecord(value) || Object.keys(value).length !== 11) return false
  const versions = [
    value.parameterVersion, value.configParameterVersion, value.nodeParameterVersion,
    value.engineParameterVersion, value.uiParameterVersion,
  ]
  const jammerStatus = value.jammerStatus
  return hasNonEmptyStrings(value, ['taskId', 'jammerId', 'effectiveFrameId'])
    && versions.every((version) => Number.isSafeInteger(version) && Number(version) > 0)
    && new Set(versions).size === 1
    && typeof value.effectiveSimulationTime === 'number' && Number.isFinite(value.effectiveSimulationTime)
    && value.effectiveSimulationTime >= 0
    && value.status === 'SYNCHRONIZED'
    && isJammerStatus(jammerStatus)
    && value.taskId === taskId
    && value.taskId === frame.taskId
    && value.jammerId === jammerId
    && value.parameterVersion === parameterSet.version
    && value.effectiveFrameId === parameterSet.effectiveFrameId
    && value.effectiveFrameId === frame.frameId
    && value.effectiveSimulationTime === frame.simulationTime
    && jammerStatus.time === frame.simulationTime
    && jammerStatus.jammerId === jammerId
    && jammerStatus.active === parameterSet.parameters.enabled
    && jammerStatus.frequency === parameterSet.parameters.frequency
    && jammerStatus.bandwidth === parameterSet.parameters.bandwidth
    && jammerStatus.power === parameterSet.parameters.power
    && frame.platforms.some((platform) => platform.platformId === jammerStatus.platformId
      && platform.jammers.some((jammer) => jammer.jammerId === jammerId))
}

/** 返回事件集合相对当前遥测帧的首个可定位错误。 */
function findEventCollectionError(frame: TelemetryFrame, events: SituationEvent[]): TelemetryFieldError | null {
  const eventIds = events.map((event) => event.eventId)
  const duplicateEventIndex = eventIds.findIndex((eventId, index) => eventIds.indexOf(eventId) !== index)
  if (duplicateEventIndex >= 0) {
    return new TelemetryFieldError('DUPLICATE_EVENT', `events[${duplicateEventIndex}].eventId`, '存在重复事件。')
  }

  const dedupeKeys = events.map((event) => event.dedupeKey)
  const duplicateKeyIndex = dedupeKeys.findIndex((dedupeKey, index) => dedupeKeys.indexOf(dedupeKey) !== index)
  if (duplicateKeyIndex >= 0) {
    return new TelemetryFieldError('DUPLICATE_EVENT', `events[${duplicateKeyIndex}].dedupeKey`, '存在重复事件。')
  }

  const mismatchedIndex = events.findIndex((event) => (
    event.frameId !== frame.frameId || event.time !== frame.simulationTime
  ))
  if (mismatchedIndex >= 0) {
    return new TelemetryFieldError('EVENT_FRAME_MISMATCH', `events[${mismatchedIndex}].frameId`, '事件与遥测帧不属于同一帧。')
  }

  const invalidTargetIndex = events.findIndex((event) => (
    event.type === 'DETECTION'
    && !frame.platforms.some((platform) => platform.platformId === event.targetPlatformId)
  ))
  if (invalidTargetIndex >= 0) {
    return new TelemetryFieldError('TARGET_NOT_FOUND', `events[${invalidTargetIndex}].targetPlatformId`, '侦测目标不存在。')
  }

  const invalidSwitchIndex = events.findIndex((event) => (
    event.type === 'LINK_SWITCH' && !isSwitchEventConsistent(event, frame)
  ))
  if (invalidSwitchIndex >= 0) {
    return new TelemetryFieldError('SWITCH_DECISION_INVALID', `events[${invalidSwitchIndex}].decision`, '链路切换结论与当前帧决策证据不一致。')
  }

  const eventIdSet = new Set(eventIds)
  if (frame.eventIds.length !== eventIds.length
    || new Set(frame.eventIds).size !== frame.eventIds.length
    || frame.eventIds.some((eventId) => !eventIdSet.has(eventId))) {
    return new TelemetryFieldError('EVENT_SET_MISMATCH', 'eventIds', '遥测帧与事件集合不一致。')
  }
  return null
}

/** 返回固定帧质量映射中可定位的字段错误。 */
function findTelemetryFieldError(value: unknown): TelemetryFieldError | null {
  if (!isRecord(value) || !Array.isArray(value.links)) return null
  if (typeof value.frameId === 'string' && Array.isArray(value.uiLinks)) {
    const index = value.uiLinks.findIndex((uiLink) => (
      isRecord(uiLink) && typeof uiLink.frameId === 'string' && uiLink.frameId !== value.frameId
    ))
    if (index >= 0) {
      return new TelemetryFieldError(
        'FRAME_ID_MISMATCH',
        `uiLinks[${index}].frameId`,
        '链路状态投影与遥测帧不属于同一帧。',
      )
    }
  }
  const frameIssue = frameConsistencyIssue(value)
  if (frameIssue !== null) return new TelemetryFieldError(frameIssue.code, frameIssue.fieldPath, frameIssue.message)
  const issue = candidateSnapshotIssue(value)
  if (issue !== null) return new TelemetryFieldError(issue.code, issue.fieldPath, issue.message)
  for (const [index, link] of value.links.entries()) {
    if (!isRecord(link)) continue
    if (link.modulation !== 'BPSK' && link.modulation !== 'QPSK') {
      return new TelemetryFieldError('UNSUPPORTED_MODULATION', `links[${index}].modulation`, '不支持的调制方式。')
    }
    if (link.coding !== 'UNCODED') {
      return new TelemetryFieldError('UNSUPPORTED_CODING', `links[${index}].coding`, '不支持的编码方式。')
    }
    if (link.qualityModelVersion !== 'SNBER-1.2') {
      return new TelemetryFieldError(
        'QUALITY_MODEL_VERSION_MISMATCH',
        `links[${index}].qualityModelVersion`,
        '质量模型版本与调制编码映射不一致。',
      )
    }
  }
  return null
}

/** 从统一成功信封读取并校验业务数据。 */
async function readSuccess<T>(
  response: Response,
  validate: (value: unknown) => value is T,
  findFieldError?: (value: unknown) => TelemetryFieldError | null,
): Promise<T> {
  const payload = await response.json() as unknown
  if (!response.ok) throw payload as ApiFailure
  if (!isRecord(payload) || payload.ok !== true) throw new Error('遥测响应格式不正确。')
  const fieldError = findFieldError?.(payload.data)
  if (fieldError !== undefined && fieldError !== null) throw fieldError
  if (!validate(payload.data)) throw new Error('遥测响应格式不正确。')
  return payload.data
}

/** 将 HTTP Mock 地址转换为同源 WebSocket 地址。 */
function resolveRealtimeUrl(role: 'ADMIN' | 'OPERATOR'): string {
  const origin = new URL(resolveMockOrigin())
  origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
  origin.pathname = '/ws/v1'
  origin.search = new URLSearchParams({ role }).toString()
  return origin.toString()
}

export const useTelemetryStore = defineStore('telemetry', {
  state: () => ({
    frame: null as TelemetryFrame | null,
    events: [] as SituationEvent[],
    topicSequences: {
      'simulation.frame': 0,
      'runtime.state': 0,
      'link.metric': 0,
      'jammer.event': 0,
      'switch.event': 0,
    } as Record<WsTopic, number>,
    connectionState: 'DISCONNECTED' as WsConnectionState,
    connectionBlocked: false,
    capabilityState: 'EMPTY' as CapabilityState,
    resultCode: 'EMPTY',
    resultMessage: '尚未加载态势遥测。',
    resultFieldPath: null as string | null,
    jammerState: null as JammerState | null,
    jammerControlState: 'EMPTY' as CapabilityState,
    jammerResultCode: 'EMPTY',
    jammerResultMessage: '尚未执行干扰控制命令。',
    jammerResultFieldPath: null as string | null,
    closedLoopDecision: null as JammingDecision | null,
    closedLoopState: 'EMPTY' as CapabilityState,
    closedLoopResultCode: 'EMPTY',
    closedLoopResultMessage: '尚未执行逐帧干扰闭环。',
    closedLoopResultFieldPath: null as string | null,
    syncResult: null as SyncResult | null,
    syncVersions: {} as Record<string, number>,
    syncState: 'EMPTY' as CapabilityState,
    syncResultCode: 'EMPTY',
    syncResultMessage: '尚未同步干扰参数。',
    syncResultFieldPath: null as string | null,
    requestEpoch: 0,
  }),

  actions: {
    /**
     * 执行任务级 RF 干扰机命令。
     * @param taskId 命令所属任务编号。
     * @param jammerId 目标干扰设备编号。
     * @param command 启停、频段、功率、方向和持续时间参数。
     * @returns 服务端确认命令并返回生效帧时返回 `true`。
     * @sideEffects 更新干扰控制六态、执行结果与可定位的中文失败原因。
     */
    async controlJammer(taskId: TaskId, jammerId: string, command: JammingCommand): Promise<boolean> {
      const auth = useAuthStore()
      this.jammerState = null
      this.jammerResultFieldPath = null
      if (!auth.authorize('SIMULATION_CONTROL').allowed) {
        this.jammerControlState = 'ERROR'
        this.jammerResultCode = 'PERMISSION_DENIED'
        this.jammerResultMessage = '当前账号没有干扰控制权限。'
        return false
      }

      this.jammerControlState = 'VALIDATING'
      if (!isJammingCommand(command)) {
        this.jammerControlState = 'ERROR'
        this.jammerResultCode = 'INVALID_REQUEST'
        this.jammerResultMessage = '干扰控制参数格式不正确。'
        return false
      }

      this.jammerControlState = 'EXECUTING'
      try {
        const response = await fetch(
          `${resolveMockOrigin()}/api/v1/tasks/${encodeURIComponent(taskId)}/jammers/${encodeURIComponent(jammerId)}/commands`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
            body: JSON.stringify(command),
          },
        )
        const state = await readJammerState(response, taskId, jammerId)
        this.jammerState = structuredClone(state)
        this.jammerControlState = 'SUCCESS'
        this.jammerResultCode = 'SUCCESS'
        this.jammerResultMessage = `${state.reason}，生效帧 ${state.effectiveFrameId}。`
        return true
      } catch (error) {
        const failure = error instanceof CapabilityRequestError ? error : null
        this.jammerControlState = 'ERROR'
        this.jammerResultCode = failure?.code ?? 'NETWORK_ERROR'
        this.jammerResultMessage = failure?.message ?? '干扰控制服务暂时不可用。'
        this.jammerResultFieldPath = failure?.fieldPath ?? null
        return false
      }
    },

    /**
     * 执行同目标同帧的侦测、启扰与链路劣化闭环。
     * @param runId 闭环所属仿真运行编号。
     * @param context 侦测事件、目标、帧和受影响链路上下文。
     * @returns 服务端首次接受该状态迁移时返回 `true`。
     * @sideEffects 更新闭环六态、决策证据和重复事件拒绝原因。
     */
    async runClosedLoop(runId: string, context: ClosedLoopContext): Promise<boolean> {
      const auth = useAuthStore()
      const frame = this.frame
      this.closedLoopDecision = null
      this.closedLoopResultFieldPath = null
      if (!auth.authorize('SIMULATION_CONTROL').allowed) {
        this.closedLoopState = 'ERROR'
        this.closedLoopResultCode = 'PERMISSION_DENIED'
        this.closedLoopResultMessage = '当前账号没有闭环控制权限。'
        return false
      }
      this.closedLoopState = 'VALIDATING'
      if (!isClosedLoopContext(context)) {
        this.closedLoopState = 'ERROR'
        this.closedLoopResultCode = 'INVALID_REQUEST'
        this.closedLoopResultMessage = '闭环上下文格式不正确。'
        return false
      }
      this.closedLoopState = 'EXECUTING'
      try {
        const response = await fetch(`${resolveMockOrigin()}/api/v1/simulations/${encodeURIComponent(runId)}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify(context),
        })
        const decision = await readCapabilityResult(
          response,
          (value): value is JammingDecision => frame !== null
            && this.frame?.frameId === frame.frameId
            && isJammingDecision(value, runId, context, frame),
          'CLOSED_LOOP_FAILED',
          '闭环控制请求失败。',
        )
        this.closedLoopDecision = structuredClone(decision)
        this.closedLoopState = 'SUCCESS'
        this.closedLoopResultCode = 'SUCCESS'
        this.closedLoopResultMessage = `闭环已在 ${decision.effectiveFrameId} 完成一次状态迁移。`
        return true
      } catch (error) {
        const failure = error instanceof CapabilityRequestError ? error : null
        this.closedLoopState = 'ERROR'
        this.closedLoopResultCode = failure?.code ?? 'NETWORK_ERROR'
        this.closedLoopResultMessage = failure?.message ?? '闭环控制服务暂时不可用。'
        this.closedLoopResultFieldPath = failure?.fieldPath ?? null
        return false
      }
    },

    /**
     * 将一版干扰参数同步到配置端、Node.js、引擎和界面投影。
     * @param taskId 参数所属任务编号。
     * @param jammerId 目标干扰设备编号。
     * @param parameterSet 单调递增版本、生效帧及控制参数。
     * @returns 四端版本一致并在指定帧生效时返回 `true`。
     * @sideEffects 更新同步六态、结果证据；服务端同时发布干扰设备状态。
     */
    async synchronizeJammerParameters(
      taskId: TaskId,
      jammerId: string,
      parameterSet: JammingParameterSet,
    ): Promise<boolean> {
      const auth = useAuthStore()
      const frame = this.frame
      this.syncResult = null
      this.syncResultFieldPath = null
      if (!auth.authorize('SIMULATION_CONTROL').allowed) {
        this.syncState = 'ERROR'
        this.syncResultCode = 'PERMISSION_DENIED'
        this.syncResultMessage = '当前账号没有干扰参数同步权限。'
        return false
      }
      this.syncState = 'VALIDATING'
      if (!isJammingParameterSet(parameterSet)) {
        this.syncState = 'ERROR'
        this.syncResultCode = 'INVALID_REQUEST'
        this.syncResultMessage = '干扰参数同步格式不正确。'
        return false
      }
      if (frame === null) {
        this.syncState = 'ERROR'
        this.syncResultCode = 'FRAME_MISMATCH'
        this.syncResultMessage = '请先加载当前遥测帧。'
        this.syncResultFieldPath = 'effectiveFrameId'
        return false
      }
      if (taskId !== frame.taskId) {
        this.syncState = 'ERROR'
        this.syncResultCode = 'INVALID_REQUEST'
        this.syncResultMessage = '参数同步任务与当前遥测任务不一致。'
        this.syncResultFieldPath = 'taskId'
        return false
      }
      if (parameterSet.effectiveFrameId !== frame.frameId) {
        this.syncState = 'ERROR'
        this.syncResultCode = 'FRAME_MISMATCH'
        this.syncResultMessage = '参数只能在当前遥测帧边界生效。'
        this.syncResultFieldPath = 'effectiveFrameId'
        return false
      }
      this.syncState = 'EXECUTING'
      try {
        const response = await fetch(
          `${resolveMockOrigin()}/api/v1/tasks/${encodeURIComponent(taskId)}/jammers/${encodeURIComponent(jammerId)}/parameters`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
            body: JSON.stringify(parameterSet),
          },
        )
        const result = await readCapabilityResult(
          response,
          (value): value is SyncResult => frame !== null
            && this.frame?.frameId === frame.frameId
            && isSyncResult(value, taskId, jammerId, parameterSet, frame),
          'JAMMER_SYNC_FAILED',
          '干扰参数同步请求失败。',
        )
        this.syncResult = structuredClone(result)
        this.syncVersions[jammerId] = result.parameterVersion
        this.syncState = 'SUCCESS'
        this.syncResultCode = 'SUCCESS'
        this.syncResultMessage = `参数版本 ${result.parameterVersion} 已在 ${result.effectiveFrameId} 同步。`
        return true
      } catch (error) {
        const failure = error instanceof CapabilityRequestError ? error : null
        this.syncState = 'ERROR'
        this.syncResultCode = failure?.code ?? 'NETWORK_ERROR'
        this.syncResultMessage = failure?.message ?? '干扰参数同步服务暂时不可用。'
        this.syncResultFieldPath = failure?.fieldPath ?? null
        return false
      }
    },

    /** 清除与当前设备或参数不再匹配的同步结果。 */
    clearSyncResult(): void {
      this.syncResult = null
      this.syncState = 'EMPTY'
      this.syncResultCode = 'EMPTY'
      this.syncResultMessage = '尚未同步干扰参数。'
      this.syncResultFieldPath = null
    },

    /**
     * 原子加载固定帧及其事件。
     * @param runId 仿真运行编号，默认 RUN-001。
     * @param frameId 遥测帧编号，默认 F-00042。
     * @returns 两个接口均成功且同帧时返回 `true`。
     * @sideEffects 成功时替换帧和事件；失败时清空旧数据，避免展示过期结果。
     */
    async loadFrame(runId = 'RUN-001', frameId = 'F-00042'): Promise<boolean> {
      const epoch = this.requestEpoch
      this.capabilityState = 'LOADING'
      this.resultFieldPath = null
      try {
        const headers = { 'X-Demo-Role': useAuthStore().role }
        const [frameResponse, eventResponse] = await Promise.all([
          fetch(`${resolveMockOrigin()}/api/v1/simulations/${encodeURIComponent(runId)}/frames/${encodeURIComponent(frameId)}`, { headers }),
          fetch(`${resolveMockOrigin()}/api/v1/simulations/${encodeURIComponent(runId)}/events`, { headers }),
        ])
        if (epoch !== this.requestEpoch) return false
        this.capabilityState = 'VALIDATING'
        const frame = await readSuccess(frameResponse, isTelemetryFrame, findTelemetryFieldError)
        if (epoch !== this.requestEpoch) return false
        const events = await readSuccess(
          eventResponse,
          (value): value is SituationEvent[] => Array.isArray(value) && value.every(isSituationEvent),
        )
        if (epoch !== this.requestEpoch) return false
        if (frame.runId !== runId || frame.frameId !== frameId) throw new Error('返回的遥测帧与请求不一致。')
        const eventError = findEventCollectionError(frame, events)
        if (eventError !== null) throw eventError
        this.frame = structuredClone(frame)
        this.events = structuredClone(events)
        this.capabilityState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = '同帧态势遥测已加载。'
        this.resultFieldPath = null
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.frame = null
        this.events = []
        this.capabilityState = 'ERROR'
        this.resultCode = error instanceof TelemetryFieldError ? error.code : 'TELEMETRY_LOAD_FAILED'
        this.resultMessage = error instanceof Error ? error.message : '态势遥测加载失败。'
        this.resultFieldPath = error instanceof TelemetryFieldError ? error.fieldPath : null
        return false
      }
    },

    /**
     * 接收一条实时信封并按主题原子投影。
     * @param value WebSocket 解析出的未受信任值。
     * @returns 信封有效且被应用或判定为重复时返回 `true`。
     * @sideEffects 更新主题序号、遥测帧、链路摘要或仿真状态；断档时触发 REST 补偿。
     */
    acceptEnvelope(value: unknown): boolean {
      if (!isRecord(value)
        || value.type !== 'event'
        || value.schemaVersion !== '1.0'
        || !TOPICS.includes(value.topic as WsTopic)
        || typeof value.taskId !== 'string'
        || !Number.isSafeInteger(value.sequence)
        || Number(value.sequence) <= 0) return false

      const envelope = value as unknown as RealtimeEnvelope<unknown>
      if (envelope.topic === 'simulation.frame') {
        if (!isTelemetryFrame(envelope.payload)
          || envelope.taskId !== envelope.payload.taskId
          || (this.frame !== null && envelope.taskId !== this.frame.taskId)) return false
      } else if (envelope.topic === 'runtime.state') {
        const currentTaskId = useSimulationStore().run?.taskId ?? this.frame?.taskId
        if (currentTaskId === undefined || envelope.taskId !== currentTaskId) return false
      } else if (this.frame === null || envelope.taskId !== this.frame.taskId) return false

      const previous = this.topicSequences[envelope.topic]
      if (envelope.sequence <= previous) return true
      if (previous > 0 && envelope.sequence > previous + 1) {
        this.resultCode = 'SEQUENCE_GAP'
        this.resultMessage = '实时消息序号不连续，正在重新同步。'
        this.resultFieldPath = null
        void this.recoverFromGap()
        return false
      }

      if (envelope.topic === 'simulation.frame') {
        const payload = envelope.payload as TelemetryFrame
        if (envelope.frameId !== payload.frameId || envelope.simulationTime !== payload.simulationTime) return false
        this.frame = structuredClone(payload)
        this.events = this.events.filter((event) => event.frameId === payload.frameId)
      } else if (envelope.topic === 'link.metric') {
        const frame = this.frame
        if (frame === null
          || envelope.frameId !== frame.frameId
          || envelope.simulationTime !== frame.simulationTime
          || !Array.isArray(envelope.payload)
          || !envelope.payload.every(isLinkSummary)) return false
        const linkSummaries = envelope.payload
        if (frameConsistencyIssue({ simulationTime: frame.simulationTime, linkSummaries }) !== null) return false
        const uiLinks = frame.uiLinks.map((projection) => {
          const summary = linkSummaries.find((item) => resolveLinkId(item, frame) === projection.linkId)
          return summary === undefined
            ? null
            : { ...projection, ageMs: (frame.simulationTime - summary.updatedAt) * 1_000 }
        })
        if (uiLinks.some((projection) => projection === null)) return false
        this.frame = {
          ...frame,
          linkSummaries: structuredClone(linkSummaries),
          uiLinks: uiLinks as TelemetryFrame['uiLinks'],
        }
      } else if (envelope.topic === 'runtime.state') {
        if (!isSimulationState(envelope.payload)) return false
        void this.applyRuntimeState(envelope.sequence, previous)
      } else if (envelope.topic === 'jammer.event') {
        const payload = envelope.payload
        if (this.frame === null || envelope.frameId !== this.frame.frameId
          || envelope.simulationTime !== this.frame.simulationTime) return false
        if (isJammerStatus(payload)) {
          if (payload.time !== this.frame.simulationTime) return false
          const platformIndex = this.frame.platforms.findIndex((platform) => platform.platformId === payload.platformId)
          if (platformIndex < 0) return false
          const jammerIndex = this.frame.platforms[platformIndex].jammers.findIndex((jammer) => jammer.jammerId === payload.jammerId)
          if (jammerIndex < 0) return false
          const platforms = this.frame.platforms.map((platform, index) => index === platformIndex
            ? { ...platform, jammers: platform.jammers.map((jammer, nestedIndex) => nestedIndex === jammerIndex ? { ...payload } : jammer) }
            : platform)
          this.frame = { ...this.frame, platforms }
        } else {
          if (!isSituationEvent(payload)
            || payload.type !== 'DETECTION'
            || payload.frameId !== this.frame.frameId
            || payload.time !== this.frame.simulationTime
            || !this.frame.platforms.some((platform) => platform.platformId === payload.targetPlatformId)) return false
          if (this.frame.eventIds.includes(payload.eventId)
            || this.events.some((event) => event.eventId === payload.eventId || event.dedupeKey === payload.dedupeKey)) {
            this.resultCode = 'DUPLICATE_EVENT'
            this.resultMessage = '重复侦测事件已忽略。'
            this.resultFieldPath = 'dedupeKey'
          } else {
            const event = structuredClone(payload)
            this.frame = { ...this.frame, eventIds: [...this.frame.eventIds, event.eventId] }
            this.events = [...this.events, event]
            this.resultCode = 'SUCCESS'
            this.resultMessage = '侦测事件已接收。'
            this.resultFieldPath = null
          }
        }
      } else if (envelope.topic === 'switch.event') {
        const payload = envelope.payload
        if (this.frame === null
          || !isSituationEvent(payload)
          || payload.type !== 'LINK_SWITCH'
          || envelope.frameId !== this.frame.frameId
          || envelope.simulationTime !== this.frame.simulationTime
          || payload.frameId !== this.frame.frameId
          || payload.time !== this.frame.simulationTime
          || !isSwitchEventConsistent(payload, this.frame)) return false
        if (!this.events.some((event) => event.eventId === payload.eventId || event.dedupeKey === payload.dedupeKey)) {
          const event = structuredClone(payload)
          this.frame = { ...this.frame, eventIds: [...this.frame.eventIds, event.eventId] }
          this.events = [...this.events, event]
        }
      }

      this.topicSequences[envelope.topic] = envelope.sequence
      return true
    },

    /**
     * 读取实时通知对应的完整运行，失败时保留可重放序号并执行完整重同步。
     * @param sequence 当前实时通知序号。
     * @param previous 同步前已确认的主题序号。
     * @returns 同步流程完成后兑现且不返回值的 Promise。
     * @sideEffects 可能更新运行锁、显示错误、回退主题序号并重建实时订阅。
     */
    async applyRuntimeState(sequence: number, previous: number): Promise<void> {
      if (await useSimulationStore().synchronizeRuntimeState()) return
      if (this.topicSequences['runtime.state'] !== sequence) return
      this.topicSequences['runtime.state'] = previous
      this.resultCode = 'RUNTIME_STATE_SYNC_FAILED'
      this.resultMessage = '仿真运行状态同步失败，正在重新同步。'
      this.resultFieldPath = null
      await this.recoverFromGap()
    },

    /**
     * 建立本机实时连接并订阅态势与侦测所需的四个主题。
     * @returns 无返回值。
     * @sideEffects 创建 WebSocket，更新连接状态，并在断线时按固定退避重试。
     */
    connect(): void {
      if (this.connectionBlocked || typeof WebSocket === 'undefined') return
      const runtime = runtimeFor(this)
      if (runtime.socket?.readyState === WebSocket.OPEN || runtime.socket?.readyState === WebSocket.CONNECTING) return
      runtime.manuallyClosed = false
      this.connectionState = runtime.retryAttempt === 0 ? 'CONNECTING' : 'RETRYING'
      const socket = new WebSocket(resolveRealtimeUrl(useAuthStore().role))
      runtime.socket = socket

      socket.addEventListener('open', () => {
        if (runtime.socket !== socket) return
        socket.send(JSON.stringify({
          type: 'subscribe',
          schemaVersion: '1.0',
          taskId: this.frame?.taskId ?? 'TASK-001',
          topics: TOPICS,
          lastSequence: 0,
        }))
      })
      socket.addEventListener('message', (event) => {
        if (runtime.socket !== socket) return
        let message: unknown
        try {
          message = JSON.parse(String(event.data)) as unknown
        } catch {
          return
        }
        if (isRecord(message) && message.type === 'subscribed') {
          runtime.retryAttempt = 0
          this.connectionState = 'SUBSCRIBED'
          return
        }
        if (isRecord(message) && message.type === 'rejected' && message.code === 'SEQUENCE_GAP') {
          void this.recoverFromGap()
          return
        }
        this.acceptEnvelope(message)
      })
      socket.addEventListener('close', () => {
        if (runtime.socket !== socket) return
        runtime.socket = null
        if (!runtime.manuallyClosed) this.scheduleReconnect()
      })
      socket.addEventListener('error', () => {
        if (runtime.socket !== socket) return
        this.resultCode = 'REALTIME_CONNECTION_FAILED'
        this.resultMessage = '实时连接暂时不可用。'
        this.resultFieldPath = null
      })
    },

    /**
     * 在实时序号断档后用 REST 恢复完整快照并重新订阅。
     * @returns 补偿流程完成后兑现且不返回值的 Promise。
     * @sideEffects 关闭旧连接、重置主题游标、加载完整帧并重新连接。
     */
    async recoverFromGap(): Promise<void> {
      const runtime = runtimeFor(this)
      const recoveryEpoch = this.requestEpoch
      runtime.manuallyClosed = true
      runtime.socket?.close()
      runtime.socket = null
      Object.keys(this.topicSequences).forEach((topic) => { this.topicSequences[topic as WsTopic] = 0 })
      if (await this.loadFrame()) {
        runtime.manuallyClosed = false
        this.connect()
      } else if (this.requestEpoch === recoveryEpoch) {
        this.scheduleReconnect(true)
      }
    },

    /**
     * 安排下一次固定退避重连。
     * @param recoverFrame 是否先重新加载完整帧再连接。
     * @returns 无返回值。
     * @sideEffects 最多创建四次定时重连，耗尽后进入 FAILED 状态。
     */
    scheduleReconnect(recoverFrame = false): void {
      const runtime = runtimeFor(this)
      const delay = RETRY_DELAYS[runtime.retryAttempt]
      if (delay === undefined) {
        runtime.manuallyClosed = false
        this.connectionState = 'FAILED'
        return
      }
      runtime.retryAttempt += 1
      this.connectionState = 'RETRYING'
      runtime.retryTimer = setTimeout(() => {
        runtime.retryTimer = null
        if (recoverFrame) void this.recoverFromGap()
        else this.connect()
      }, delay)
    },

    /**
     * 断开实时连接并清空遥测安全态。
     * @returns 无返回值。
     * @sideEffects 取消重连、关闭 WebSocket、使在途请求失效并清空帧和事件。
     */
    disconnectAndReset(): void {
      const runtime = runtimeFor(this)
      runtime.manuallyClosed = true
      if (runtime.retryTimer !== null) clearTimeout(runtime.retryTimer)
      runtime.retryTimer = null
      runtime.retryAttempt = 0
      runtime.socket?.close()
      runtime.socket = null
      this.resetToSafeEmpty()
    },

    /**
     * 将遥测 Store 恢复为无过期数据的安全空态。
     * @returns 无返回值。
     * @sideEffects 使在途加载失效并清空帧、事件、主题序号和连接反馈。
     */
    resetToSafeEmpty(): void {
      this.requestEpoch += 1
      this.frame = null
      this.events = []
      Object.keys(this.topicSequences).forEach((topic) => { this.topicSequences[topic as WsTopic] = 0 })
      this.connectionState = 'DISCONNECTED'
      this.capabilityState = 'EMPTY'
      this.resultCode = 'EMPTY'
      this.resultMessage = '尚未加载态势遥测。'
      this.resultFieldPath = null
      this.jammerState = null
      this.jammerControlState = 'EMPTY'
      this.jammerResultCode = 'EMPTY'
      this.jammerResultMessage = '尚未执行干扰控制命令。'
      this.jammerResultFieldPath = null
      this.closedLoopDecision = null
      this.closedLoopState = 'EMPTY'
      this.closedLoopResultCode = 'EMPTY'
      this.closedLoopResultMessage = '尚未执行逐帧干扰闭环。'
      this.closedLoopResultFieldPath = null
      this.syncResult = null
      this.syncVersions = {}
      this.syncState = 'EMPTY'
      this.syncResultCode = 'EMPTY'
      this.syncResultMessage = '尚未同步干扰参数。'
      this.syncResultFieldPath = null
    },
  },
})

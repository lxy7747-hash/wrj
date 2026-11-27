import { apiFetch } from '../features/shared/api-fetch'
import { defineStore } from 'pinia'
import { toRaw, watch } from 'vue'
import { isEngineFrameId, isEngineFrameSnapshot } from '../features/data-exchange/engine-frame-snapshot'
import { useRuntimeQualityStore } from './runtime-quality'
import type {
  CapabilityState,
  ClosedLoopContext,
  DetectionEvent,
  JammingDecision,
  JammingCommand,
  JammingParameterSet,
  JammerPlanSaveRequest,
  JammerPlanSaved,
  JammerRuntimeParameters,
  JammerStatusData,
  JammerState,
  LinkStatusSummary,
  EngineConnectionDiagnostic,
  EngineFrameTick,
  EngineJammerFrameUpdate,
  EngineSwitchFrameUpdate,
  MissionLogUpdate,
  MissionPositionUpdate,
  QualityDatasetUpdate,
  RealtimeEnvelope,
  SimulationState,
  SensorStatusData,
  SwitchEvent,
  SyncResult,
  TelemetryFrame,
  TaskId,
  RunId,
  WsConnectionState,
  WsTopic,
} from '../contracts/domain-models'
import { resolveLinkId, validateCandidateSnapshot, type CandidateSnapshotIssue } from '../features/situation/situation-model'
import { ERROR_GUIDANCE } from '../features/diagnostics'
import { frameJammerExecutions } from '../features/situation/frame-evidence'
import { isControlledPowerWatts } from '../features/scenarios/jammer-settings'
import { resolveMockOrigin, useAuthStore } from './auth'
import { useScenarioStore } from './scenario'
import { useSimulationStore } from './simulation'

type SituationEvent = DetectionEvent | SwitchEvent

/** 能力结果的证据来源：本地固定投影/校验通过，或尚未确认（真实引擎未接入）。 */
export type CapabilityEvidenceSource = 'LOCAL_PROJECTION' | 'UNCONFIRMED'

export interface WsMessageHeaderSnapshot {
  topic: WsTopic
  type: string
  schemaVersion: string
  taskId: TaskId
  sequence: number
  simulationTime?: number
  frameId?: string
  receivedAt: string
}

export interface WsConnectionEvent {
  at: string
  state: WsConnectionState
  detail: string
}

function formatClockNow(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

const TOPICS: WsTopic[] = ['simulation.frame', 'runtime.state', 'link.metric', 'jammer.event', 'switch.event', 'mission.log', 'position.update']
const BUSINESS_HEADER_TOPICS = new Set<WsTopic>(['simulation.frame', 'runtime.state', 'link.metric', 'jammer.event', 'switch.event'])
const RETRY_DELAYS = [250, 500, 1_000, 2_000] as const

function maxBusinessSequence(sequences: Record<WsTopic, number>): number {
  let max = 0
  for (const topic of BUSINESS_HEADER_TOPICS) {
    const seq = sequences[topic] ?? 0
    if (seq > max) max = seq
  }
  return max
}
const PLATFORM_TYPES = new Set([
  'REAR_COMMAND_NODE', 'FORWARD_RELAY_NODE', 'GROUND_CLUSTER_COMMAND_NODE',
  'AIRBORNE_MISSION_CLUSTER', 'COMMUNICATION_SATELLITE', 'GROUND_JAMMER_DETECTION_STATION',
  'AIRBORNE_JAMMER_PLATFORM',
])
// 与契约 LinkStatusSummary / TelemetryLinkRecord 的 linkType 枚举一致；新模板中指挥车与后方指挥节点之间为光纤链路。
const LINK_TYPES = new Set(['SAT', 'MICROWAVE', 'DATALINK', 'LASER', 'FIBER'])
const MAX_TELEMETRY_AGE_SECONDS = 5
const MAX_TELEMETRY_AGE_MS = MAX_TELEMETRY_AGE_SECONDS * 1_000

interface TelemetryRuntime {
  socket: WebSocket | null
  retryTimer: ReturnType<typeof setTimeout> | null
  retryAttempt: number
  manuallyClosed: boolean
  closeWithPageRunId?: string
  subscribedRunId?: RunId
  pendingGap?: { topic: WsTopic; through: number }
  pageProbe?: ReturnType<typeof setInterval>
  incoming: unknown[]
  incomingTimer: ReturnType<typeof setTimeout> | null
}

const runtimes = new WeakMap<object, TelemetryRuntime>()

function stopPageProbe(runtime: TelemetryRuntime): void {
  if (runtime.pageProbe !== undefined) clearInterval(runtime.pageProbe)
  delete runtime.pageProbe
}

/** 仅在拥有本机运行的页面失去订阅时确认页面存活，浏览器关闭后由服务端宽限期收尾。 */
function maintainPageDuringReconnect(runtime: TelemetryRuntime): void {
  const runId = runtime.closeWithPageRunId
  if (runtime.pageProbe !== undefined || !runId || runId !== runtime.subscribedRunId
    || useAuthStore().runtimeMode !== 'LOCAL' || useSimulationStore().run?.runId !== runId) return
  let busy = false
  const probe = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      const response = await apiFetch(`${resolveMockOrigin()}/api/v1/simulations/${encodeURIComponent(runId)}?pageOwner=1`, {
        headers: { 'X-Demo-Role': useAuthStore().role }, signal: AbortSignal.timeout(2_000),
      })
      const run = response.ok ? (await response.json()).data : null
      const ended = run?.runId === runId && run.configLocked === false
      if (runtime.pageProbe === timer && (ended || [401, 403, 404].includes(response.status))) {
        delete runtime.closeWithPageRunId
        stopPageProbe(runtime)
      }
    } catch { /* HTTP 也断开时由服务端按关页处理。 */ }
    finally { busy = false }
  }
  const timer = setInterval(() => { void probe() }, 2_000)
  runtime.pageProbe = timer
  void probe()
}

/** 返回指定 Store 实例独享的非响应式连接资源。 */
function runtimeFor(store: object): TelemetryRuntime {
  // 开发工具为每次 action 包装不同代理，连接资源必须绑定同一个原始 Store。
  store = toRaw(store)
  const existing = runtimes.get(store)
  if (existing !== undefined) return existing
  const runtime: TelemetryRuntime = { socket: null, retryTimer: null, retryAttempt: 0, manuallyClosed: false, incoming: [], incomingTimer: null }
  runtimes.set(store, runtime)
  return runtime
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isQualityDatasetUpdate(value: unknown): value is QualityDatasetUpdate {
  if (!isRecord(value) || value.kind !== 'QUALITY_UPDATED' || typeof value.sourceSha256 !== 'string'
    || value.sourceSha256.length === 0 || typeof value.sampleCount !== 'number' || !Number.isSafeInteger(value.sampleCount) || value.sampleCount < 0
    || !isRecord(value.scope)) return false
  const scope = value.scope
  return Object.keys(scope).length === 5
    && typeof scope.taskId === 'string' && scope.taskId.length > 0
    && typeof scope.runId === 'string' && scope.runId.length > 0
    && typeof scope.scenarioId === 'string' && scope.scenarioId.length > 0
    && typeof scope.revision === 'number' && Number.isSafeInteger(scope.revision) && scope.revision > 0
    && typeof scope.startedAt === 'string' && scope.startedAt.length > 0
}

function isMissionLogUpdate(value: unknown): value is MissionLogUpdate {
  return isRecord(value) && Object.keys(value).length === 10
    && value.kind === 'MISSION_LOG' && typeof value.runId === 'string' && value.runId.length > 0
    && typeof value.text === 'string' && typeof value.replace === 'boolean'
    && Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0 && typeof value.truncated === 'boolean'
    && Number.isSafeInteger(value.chunkIndex) && Number.isSafeInteger(value.chunkCount)
    && Number(value.chunkIndex) >= 0 && Number(value.chunkCount) > 0 && Number(value.chunkIndex) < Number(value.chunkCount)
    && Number.isSafeInteger(value.startByteOffset) && Number.isSafeInteger(value.endByteOffset)
    && Number(value.startByteOffset) >= 0 && Number(value.endByteOffset) >= Number(value.startByteOffset)
    && Number(value.endByteOffset) === Number(value.bytes)
}

function isEngineConnectionDiagnostic(value: unknown): value is EngineConnectionDiagnostic {
  if (!isRecord(value) || value.kind !== 'ENGINE_CONNECTION_DIAGNOSTIC'
    || typeof value.runId !== 'string' || value.runId.length === 0
    || !['CONNECTING', 'CONNECTED', 'DISCONNECTED', 'REJECTED', 'FRAME_ADVANCE_OBSERVED'].includes(String(value.state))
    || typeof value.message !== 'string' || value.message.length === 0) return false
  const allowed = new Set(['kind', 'runId', 'state', 'message', 'previousFrameId', 'observedFrameId'])
  return Object.keys(value).every(key => allowed.has(key))
    && ['previousFrameId', 'observedFrameId'].every(key => value[key] === undefined || (isEngineFrameId(value[key])))
}

function isMissionPositionUpdate(value: unknown): value is MissionPositionUpdate {
  if (!isRecord(value) || Object.keys(value).length !== 8 || value.kind !== 'MISSION_POSITION'
    || typeof value.runId !== 'string' || typeof value.scenarioId !== 'string'
    || !Number.isSafeInteger(value.revision) || Number(value.revision) <= 0
    || !Number.isSafeInteger(value.sourceGeneration) || Number(value.sourceGeneration) < 0
    || !Number.isSafeInteger(value.sourceRecordCount) || Number(value.sourceRecordCount) < 0
    || typeof value.waitingForLine !== 'boolean' || !Array.isArray(value.nodes)) return false
  return value.nodes.every(node => isRecord(node) && Object.keys(node).length === 7 && typeof node.platformId === 'string' && node.platformId.length > 0
    && ['time', 'longitude', 'latitude', 'altitude', 'speed', 'heading'].every(key => typeof node[key] === 'number' && Number.isFinite(node[key])))
}

function isEngineFrameTick(value: unknown): value is EngineFrameTick {
  return isRecord(value) && Object.keys(value).length === 5 && value.kind === 'ENGINE_FRAME_TICK'
    && typeof value.runId === 'string' && Number.isSafeInteger(value.engineEpoch) && Number(value.engineEpoch) >= 0
    && isEngineFrameId(value.sourceFrameId) && typeof value.simulationTime === 'number' && Number.isFinite(value.simulationTime) && value.simulationTime >= 0
}

function isEngineJammerFrameUpdate(value: unknown): value is EngineJammerFrameUpdate {
  return isRecord(value) && Object.keys(value).length === 7 && value.kind === 'ENGINE_JAMMER_FRAME'
    && typeof value.runId === 'string' && Number.isSafeInteger(value.engineEpoch) && Number(value.engineEpoch) >= 0
    && isEngineFrameId(value.sourceFrameId)
    && typeof value.simulationTime === 'number' && Number.isFinite(value.simulationTime) && Number(value.simulationTime) >= 0
    && Array.isArray(value.jammers) && Array.isArray(value.events)
}

function isEngineSwitchFrameUpdate(value: unknown): value is EngineSwitchFrameUpdate {
  return isRecord(value) && Object.keys(value).length === 6 && value.kind === 'ENGINE_SWITCH_FRAME'
    && typeof value.runId === 'string' && Number.isSafeInteger(value.engineEpoch) && Number(value.engineEpoch) >= 0
    && isEngineFrameId(value.sourceFrameId)
    && typeof value.simulationTime === 'number' && Number.isFinite(value.simulationTime) && Number(value.simulationTime) >= 0
    && Array.isArray(value.switches)
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
/** 引擎可选提供的质量扩展字段；缺省时界面显示“暂无数据”。 */
const OPTIONAL_LINK_METRICS = ['jsrDb', 'latencyMs', 'availabilityPercent'] as const

function isTelemetryLink(value: unknown): boolean {
  if (!isRecord(value)) return false
  const optional = OPTIONAL_LINK_METRICS.filter(key => Object.hasOwn(value, key))
  return Object.keys(value).length === 22 + optional.length + Number(Object.hasOwn(value, 'issues'))
    && (!Object.hasOwn(value, 'issues') || (Array.isArray(value.issues) && value.issues.every(isValidationIssue)))
    && optional.every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))
    && (!Object.hasOwn(value, 'latencyMs') || Number(value.latencyMs) >= 0)
    && (!Object.hasOwn(value, 'availabilityPercent') || (Number(value.availabilityPercent) >= 0 && Number(value.availabilityPercent) <= 100))
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
    && hasNonEmptyStrings(value, ['qualityModelVersion'])
    && (value.linkStatus === 'UP' || value.linkStatus === 'DOWN')
}

function isValidationIssue(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 4
    && (value.severity === 'ERROR' || value.severity === 'WARNING')
    && hasStrings(value, ['code', 'message', 'fieldPath'])
}

/** 校验界面链路状态投影成员。 */
function isUiLink(value: unknown): value is TelemetryFrame['uiLinks'][number] {
  if (!isRecord(value)) return false
  const optional = ['jsrThresholdDb', 'warningBerThreshold', 'emergencyBerThreshold', 'jitterSuppressed'].filter(key => Object.hasOwn(value, key))
  return Object.keys(value).length === 8 + optional.length
    && optional.every(key => key === 'jitterSuppressed'
      ? typeof value[key] === 'boolean'
      : typeof value[key] === 'number' && Number.isFinite(value[key])
        && (key === 'jsrThresholdDb' || (Number(value[key]) >= 0 && Number(value[key]) <= 1)))
    && hasNonEmptyStrings(value, ['linkId'])
    && typeof value.frameId === 'string' && value.frameId.startsWith('F-')
    && typeof value.reason === 'string' && value.reason.length > 0
    && hasNonEmptyStrings(value, ['thresholdVersion'])
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
  if (!isRecord(value)) return false
  const optional = ['seaMultipathLossDb', 'atmosphericLossDb', 'cloudRainLossDb'].filter(key => Object.hasOwn(value, key))
  if (Object.keys(value).length !== 9 + optional.length || !hasFiniteNumbers(value, optional)) return false
  return typeof value.linkId === 'string' && value.linkId.length > 0
    && hasFiniteNumbers(value, [
      'freeSpaceLossDb', 'systemLossDb', 'obstructionLossDb', 'interferenceLossDb',
      'totalPathLossDb', 'noisePowerDbm', 'effectiveNoiseAndInterferenceDbm',
    ])
    && hasNonEmptyStrings(value, ['modelVersion'])
}

/** 校验固定帧采用的完整同步证据。 */
function isSynchronizationEvidence(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 5) return false
  return hasNonEmptyStrings(value, ['configVersion', 'engineVersion', 'uiVersion'])
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
    && isRecord(value.evidence)
    && Object.keys(value.evidence).length === 5 + Number(Object.hasOwn(value.evidence, 'jammerExecutions'))
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
    && (!Object.hasOwn(value.evidence, 'jammerExecutions')
      || (Array.isArray(value.evidence.jammerExecutions) && value.evidence.jammerExecutions.length > 0
        && value.evidence.jammerExecutions.every(isJammerExecutionEvidence)
        // 执行证据为闭合的标量对象，按字段比较，不依赖 JSON 属性顺序。
        && Object.entries(value.evidence.jammerExecution as Record<string, unknown>).every(([key, item]) =>
          (value.evidence as TelemetryFrame['evidence']).jammerExecutions![0]![key as keyof TelemetryFrame['evidence']['jammerExecution']] === item)))
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
    // 可选：侦测频段/是否检出，以及 ESM 实测位置、实际工作频率、接收强度（A 落地，缺省即缺测）。
    const optionalKeys = [
      'frequencyMinMHz', 'frequencyMaxMHz', 'detected',
      'measuredLongitude', 'measuredLatitude', 'measuredAltitude',
      'actualFrequencyMHz', 'receivedSignalStrengthDbm',
    ] as const
    const present = optionalKeys.filter(key => Object.hasOwn(value, key))
    return Object.keys(value).length === (hasRegistryTime ? 9 : 8) + present.length
      && Object.hasOwn(value, 'frequencyMinMHz') === Object.hasOwn(value, 'frequencyMaxMHz')
      && (!Object.hasOwn(value, 'frequencyMinMHz') || (hasFiniteNumbers(value, ['frequencyMinMHz', 'frequencyMaxMHz'])
        && Number(value.frequencyMinMHz) > 0 && Number(value.frequencyMaxMHz) >= Number(value.frequencyMinMHz)))
      && (!Object.hasOwn(value, 'detected') || typeof value.detected === 'boolean')
      && Object.hasOwn(value, 'measuredLongitude') === Object.hasOwn(value, 'measuredLatitude')
      && (!Object.hasOwn(value, 'measuredLongitude') || (hasFiniteNumbers(value, ['measuredLongitude', 'measuredLatitude'])
        && Math.abs(Number(value.measuredLongitude)) <= 180 && Math.abs(Number(value.measuredLatitude)) <= 90))
      && (!Object.hasOwn(value, 'measuredAltitude')
        || (typeof value.measuredAltitude === 'number' && Number.isFinite(value.measuredAltitude) && Number(value.measuredAltitude) >= 0))
      && (!Object.hasOwn(value, 'actualFrequencyMHz')
        || (typeof value.actualFrequencyMHz === 'number' && Number.isFinite(value.actualFrequencyMHz) && Number(value.actualFrequencyMHz) > 0))
      && (!Object.hasOwn(value, 'receivedSignalStrengthDbm')
        || (typeof value.receivedSignalStrengthDbm === 'number' && Number.isFinite(value.receivedSignalStrengthDbm)))
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

  if (event.reason === 'COOLDOWN_ACTIVE') return event.decision === 'REJECTED' && event.cooldownRemainingS > 0
  if (event.decision !== 'ACCEPTED'
    || event.oldLinkId !== routeDecision.previousLinkId || event.newLinkId !== routeDecision.selectedLinkId
    || event.cooldownRemainingS !== 0 || event.stabilityFrames < event.minimumStableFrames
    || event.stabilityFrames < routeDecision.minimumStableFrames) return false
  if (event.reason === 'INTERFERENCE') return true
  if (event.reason === 'LINK_DOWN') return oldSummary.status === 'DOWN'
  return event.reason === 'BER_THRESHOLD_AND_HYSTERESIS' && event.hysteresisSatisfied && event.newBer < event.oldBer
}

/** 校验实时规范仿真状态。 */
function isSimulationState(value: unknown): value is SimulationState {
  if (!isRecord(value)) return false
  const hasErrorMessage = Object.prototype.hasOwnProperty.call(value, 'errorMessage')
  return Object.keys(value).length === 5 + ['errorMessage', 'mode', 'speedMultiplier'].filter(key => Object.hasOwn(value, key)).length
    && (!Object.hasOwn(value, 'mode') || ['INTERACTIVE_SINGLE', 'PARAMETER_SCAN', 'HISTORICAL_REPLAY'].some(mode => mode === value.mode))
    && (!Object.hasOwn(value, 'speedMultiplier') || (typeof value.speedMultiplier === 'number' && Number.isFinite(value.speedMultiplier) && value.speedMultiplier > 0))
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

/** 自动启扰与关扰共用的闭合结构。REST 闭环另行限制 START 和请求上下文。 */
function isJammingDecision(value: unknown): value is JammingDecision {
  return isRecord(value) && Object.keys(value).length === 11
    && hasNonEmptyStrings(value, ['decisionId', 'runId', 'frameId', 'detectionEventId', 'targetPlatformId',
      'jammerId', 'affectedLinkId', 'effectiveFrameId', 'reason'])
    && String(value.runId).startsWith('RUN-') && String(value.frameId).startsWith('F-') && String(value.effectiveFrameId).startsWith('F-')
    && (value.action === 'START' || value.action === 'STOP')
    && (value.linkStatus === 'UP' || value.linkStatus === 'DEGRADED' || value.linkStatus === 'DOWN')
}

function isClosedLoopDecision(value: unknown, runId: string, context: ClosedLoopContext, frame: TelemetryFrame): value is JammingDecision {
  return isJammingDecision(value) && value.action === 'START'
    && value.runId === runId && value.frameId === context.frameId
    && value.detectionEventId === context.detectionEventId && value.targetPlatformId === context.targetPlatformId
    && value.affectedLinkId === context.affectedLinkId && value.effectiveFrameId === frame.frameId
    && frameJammerExecutions(frame).some(execution => execution.jammerId === value.jammerId
      && execution.targetPlatformId === context.targetPlatformId)
    && value.linkStatus === frame.uiLinks.find(link => link.linkId === context.affectedLinkId)?.status
}

function isSensorStatus(value: unknown): value is SensorStatusData {
  return isRecord(value) && Object.keys(value).length === 5 + Number(Object.hasOwn(value, 'scanCoveragePercent'))
    && value.type === 'SENSOR_STATUS' && hasNonEmptyStrings(value, ['sensorId', 'platformId'])
    && hasFiniteNumbers(value, ['time']) && Number(value.time) >= 0 && typeof value.active === 'boolean'
    && (!Object.hasOwn(value, 'scanCoveragePercent') || (typeof value.scanCoveragePercent === 'number'
      && Number.isFinite(value.scanCoveragePercent) && value.scanCoveragePercent >= 0 && value.scanCoveragePercent <= 100))
}

/** 校验带版本和生效帧的干扰参数集；探测范围为本项目扩展的可选顶层字段，旧请求缺省兼容。 */
function isJammingParameterSet(value: unknown): value is JammingParameterSet {
  if (!isRecord(value)) return false
  const hasDetectionRange = Object.hasOwn(value, 'detectionRangeM')
  return Object.keys(value).length === 3 + Number(hasDetectionRange)
    && Number.isSafeInteger(value.version) && Number(value.version) > 0
    && typeof value.effectiveFrameId === 'string' && value.effectiveFrameId.startsWith('F-')
    && (!hasDetectionRange
      || (typeof value.detectionRangeM === 'number' && Number.isFinite(value.detectionRangeM) && value.detectionRangeM > 0))
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
  if (!isRecord(value)) return false
  const hasDetectionRange = Object.hasOwn(value, 'detectionRangeM')
  if (Object.keys(value).length !== 11 + Number(hasDetectionRange)) return false
  if (hasDetectionRange && !(typeof value.detectionRangeM === 'number' && Number.isFinite(value.detectionRangeM) && value.detectionRangeM > 0)) return false
  if (hasDetectionRange && parameterSet.detectionRangeM !== undefined && value.detectionRangeM !== parameterSet.detectionRangeM) return false
  const versions = [
    value.parameterVersion, value.configParameterVersion, value.nodeParameterVersion,
    value.uiParameterVersion,
  ]
  const jammerStatus = value.jammerStatus
  const baseValid = hasNonEmptyStrings(value, ['taskId', 'jammerId', 'effectiveFrameId'])
    && versions.every((version) => Number.isSafeInteger(version) && Number(version) > 0)
    && new Set(versions).size === 1
    && typeof value.effectiveSimulationTime === 'number' && Number.isFinite(value.effectiveSimulationTime)
    && value.effectiveSimulationTime >= 0
    && value.status === 'LOCAL_ACCEPTED'
    && value.engineSync === 'NOT_CONNECTED'
    && isJammerStatus(jammerStatus)
    && value.taskId === taskId
    && value.jammerId === jammerId
    && value.parameterVersion === parameterSet.version
    && value.effectiveFrameId === parameterSet.effectiveFrameId
    && jammerStatus.jammerId === jammerId
    && jammerStatus.active === parameterSet.parameters.enabled
    && jammerStatus.frequency === parameterSet.parameters.frequency
    && jammerStatus.bandwidth === parameterSet.parameters.bandwidth
    && jammerStatus.power === parameterSet.parameters.power
  if (!baseValid) return false
  // 非固定/远端运行的本地接受：帧号为本地记录，不宣称引擎帧生效，也不要求与当前帧时刻/平台一致。
  if (frame.frameId.startsWith('F-ENGINE-')) {
    return value.taskId === frame.taskId
      && value.effectiveSimulationTime === jammerStatus.time
  }
  return value.taskId === frame.taskId
    && value.effectiveFrameId === frame.frameId
    && value.effectiveSimulationTime === frame.simulationTime
    && jammerStatus.time === frame.simulationTime
    && frame.platforms.some((platform) => platform.platformId === jammerStatus.platformId
      && platform.jammers.some((jammer) => jammer.jammerId === jammerId))
}

/** 校验运行期本地参数读取结果（版本 + 已接受探测范围 + 可选计划字段）。 */
function isJammerRuntimeParameters(value: unknown): value is JammerRuntimeParameters {
  if (!isRecord(value)) return false
  const optional = ['style', 'elevation', 'plannedStartFrame', 'plannedStopFrame'].filter(key => Object.hasOwn(value, key))
  return Object.keys(value).length === 4 + optional.length
    && hasNonEmptyStrings(value, ['taskId', 'jammerId'])
    && Number.isSafeInteger(value.version) && Number(value.version) >= 0
    && typeof value.detectionRangeM === 'number' && Number.isFinite(value.detectionRangeM) && value.detectionRangeM >= 0
    && (!Object.hasOwn(value, 'style') || value.style === 'BARRAGE' || value.style === 'SPOT')
    && (!Object.hasOwn(value, 'elevation') || (typeof value.elevation === 'number' && Number.isFinite(value.elevation)))
    && (!Object.hasOwn(value, 'plannedStartFrame') || (Number.isInteger(value.plannedStartFrame) && Number(value.plannedStartFrame) >= 0))
    && (!Object.hasOwn(value, 'plannedStopFrame') || (Number.isInteger(value.plannedStopFrame) && Number(value.plannedStopFrame) >= 0))
}

/** 校验运行期干扰计划保存结果（storage 仅本地留存）。 */
function isJammerPlanSaved(value: unknown): value is JammerPlanSaved {
  if (!isRecord(value)) return false
  const optional = ['plannedStartFrame', 'plannedStopFrame'].filter(key => Object.hasOwn(value, key))
  return Object.keys(value).length === 5 + optional.length
    && hasNonEmptyStrings(value, ['taskId', 'jammerId'])
    && (value.style === 'BARRAGE' || value.style === 'SPOT')
    && typeof value.elevation === 'number' && Number.isFinite(value.elevation)
    && value.storage === 'LOCAL_RUN'
    && (!Object.hasOwn(value, 'plannedStartFrame') || (Number.isInteger(value.plannedStartFrame) && Number(value.plannedStartFrame) >= 0))
    && (!Object.hasOwn(value, 'plannedStopFrame') || (Number.isInteger(value.plannedStopFrame) && Number(value.plannedStopFrame) >= 0))
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
    if (!hasNonEmptyStrings(link, ['qualityModelVersion'])) {
      return new TelemetryFieldError(
        'QUALITY_MODEL_VERSION_MISMATCH',
        `links[${index}].qualityModelVersion`,
        '质量模型版本不能为空。',
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
  if (!response.ok) {
    if (isRecord(payload) && payload.ok === false && isRecord(payload.error)
      && typeof payload.error.code === 'string' && Object.hasOwn(ERROR_GUIDANCE, payload.error.code)
      && typeof payload.error.message === 'string' && payload.error.message.trim().length > 0
      && (payload.error.fieldPath === undefined || typeof payload.error.fieldPath === 'string')) {
      throw new TelemetryFieldError(payload.error.code, typeof payload.error.fieldPath === 'string' ? payload.error.fieldPath : '', payload.error.message)
    }
    throw new Error('遥测请求失败。')
  }
  if (!isRecord(payload) || payload.ok !== true) throw new Error('遥测响应格式不正确。')
  const fieldError = findFieldError?.(payload.data)
  if (fieldError !== undefined && fieldError !== null) throw fieldError
  if (!validate(payload.data)) throw new Error('遥测响应格式不正确。')
  return payload.data
}

/** 将当前 HTTP 服务入口转换为对应的 WebSocket 地址。 */
export function resolveRealtimeUrl(role: 'ADMIN' | 'OPERATOR'): string {
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
    sensorStatuses: [] as SensorStatusData[],
    jammingDecisions: [] as JammingDecision[],
    /** Bounded WS reference; the situation page fetches and validates the full dataset. */
    qualityUpdate: null as QualityDatasetUpdate | null,
    /** HTTP initializes/recovers the console; this is the WS incremental update. */
    missionLogUpdate: null as MissionLogUpdate | null,
    /** Bounded append-only delivery queue so synchronous WS fragments cannot be coalesced by Vue watchers. */
    missionLogUpdates: [] as MissionLogUpdate[],
    /** Objective upstream connection observations, not simulation-time evidence. */
    engineDiagnostics: [] as EngineConnectionDiagnostic[],
    missionPositionUpdate: null as MissionPositionUpdate | null,
    engineJammerUpdates: [] as EngineJammerFrameUpdate[],
    engineSwitchUpdates: [] as EngineSwitchFrameUpdate[],
    // A runtime-only task may have no telemetry frame; retain the task chosen
    // for the socket so reconnects cannot silently fall back to TASK-001.
    realtimeTaskId: null as TaskId | null,
    engineFrameTick: null as EngineFrameTick | null,
    topicSequences: {
      'simulation.frame': 0,
      'runtime.state': 0,
      'link.metric': 0,
      'jammer.event': 0,
      'switch.event': 0,
      'mission.log': 0,
      'position.update': 0,
    } as Record<WsTopic, number>,
    connectionState: 'DISCONNECTED' as WsConnectionState,
    retryAttemptCount: 0,
    disconnectedAtSequence: null as number | null,
    lastMessageHeader: null as WsMessageHeaderSnapshot | null,
    recentMessageHeaders: [] as WsMessageHeaderSnapshot[],
    connectionHistory: [] as WsConnectionEvent[],
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
    /** 本地投影/校验来源，不代表真实设备执行回执。 */
    jammerResultSource: null as CapabilityEvidenceSource | null,
    closedLoopDecision: null as JammingDecision | null,
    closedLoopState: 'EMPTY' as CapabilityState,
    closedLoopResultCode: 'EMPTY',
    closedLoopResultMessage: '尚未执行逐帧干扰闭环。',
    closedLoopResultFieldPath: null as string | null,
    closedLoopResultSource: null as CapabilityEvidenceSource | null,
    syncResult: null as SyncResult | null,
    syncVersions: {} as Record<string, number>,
    /** 运行期本地参数读取缓存：key=`${runId}|${jammerId}`，由 GET 读取层与同步/计划结果填充。 */
    jammerRuntimeParameters: {} as Record<string, JammerRuntimeParameters>,
    syncState: 'EMPTY' as CapabilityState,
    syncResultCode: 'EMPTY',
    syncResultMessage: '尚未同步干扰参数。',
    syncResultFieldPath: null as string | null,
    syncResultSource: null as CapabilityEvidenceSource | null,
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
      const epoch = this.requestEpoch
      const frameRunId = this.frame?.runId
      this.jammerState = null
      this.jammerResultFieldPath = null
      this.jammerResultSource = null
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
      // GNZB-15：启扰功率必须落在 -10～30 dBm、5 dB 档位；停扰只要求有限非负，允许 0 W 安全停止。
      if (command.enabled && !isControlledPowerWatts(command.power)) {
        this.jammerControlState = 'ERROR'
        this.jammerResultCode = 'INVALID_REQUEST'
        this.jammerResultMessage = '启扰功率必须为 -10～30 dBm 且按 5 dB 档位设置。'
        this.jammerResultFieldPath = 'power'
        return false
      }

      this.jammerControlState = 'EXECUTING'
      try {
        const response = await apiFetch(
          `${resolveMockOrigin()}/api/v1/tasks/${encodeURIComponent(taskId)}/jammers/${encodeURIComponent(jammerId)}/commands`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
            body: JSON.stringify(command),
          },
        )
        const state = await readJammerState(response, taskId, jammerId)
        // 运行切换或重置后，晚返回的旧请求不得污染当前结果，也不让界面停留在“执行中”。
        if (epoch !== this.requestEpoch || this.frame?.runId !== frameRunId) {
          this.jammerControlState = 'EMPTY'
          this.jammerResultCode = 'EMPTY'
          this.jammerResultMessage = '尚未执行干扰控制命令。'
          this.jammerResultFieldPath = null
          return false
        }
        this.jammerState = structuredClone(state)
        this.jammerControlState = 'SUCCESS'
        this.jammerResultCode = 'SUCCESS'
        this.jammerResultSource = 'LOCAL_PROJECTION'
        this.jammerResultMessage = `${state.reason}，生效帧 ${state.effectiveFrameId}。`
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
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
      const epoch = this.requestEpoch
      const auth = useAuthStore()
      const frame = this.frame
      this.closedLoopDecision = null
      this.closedLoopResultFieldPath = null
      this.closedLoopResultSource = null
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
      if (this.events.some(event => event.type === 'DETECTION' && event.eventId === context.detectionEventId && event.detected === false)) {
        this.closedLoopState = 'ERROR'
        this.closedLoopResultCode = 'TARGET_NOT_DETECTED'
        this.closedLoopResultFieldPath = 'detectionEventId'
        this.closedLoopResultMessage = '未发现目标的侦测事件不能触发闭环。'
        return false
      }
      this.closedLoopState = 'EXECUTING'
      try {
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/simulations/${encodeURIComponent(runId)}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify(context),
        })
        const decision = await readCapabilityResult(
          response,
          (value): value is JammingDecision => frame !== null
            && this.frame?.frameId === frame.frameId
            && this.frame?.runId === frame.runId
            && isClosedLoopDecision(value, runId, context, frame),
          'CLOSED_LOOP_FAILED',
          '闭环控制请求失败。',
        )
        if (epoch !== this.requestEpoch || this.frame?.frameId !== frame?.frameId || this.frame?.runId !== frame?.runId) return false
        this.rememberJammingDecision(decision)
        this.closedLoopDecision = structuredClone(decision)
        this.closedLoopState = 'SUCCESS'
        this.closedLoopResultCode = 'SUCCESS'
        this.closedLoopResultSource = 'LOCAL_PROJECTION'
        this.closedLoopResultMessage = `闭环已在 ${decision.effectiveFrameId} 完成一次状态迁移。`
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
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
      const epoch = this.requestEpoch
      const frameRunId = this.frame?.runId
      this.syncResult = null
      this.syncResultFieldPath = null
      this.syncResultSource = null
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
      // 固定演示帧要求严格同帧；非固定/远端运行（引擎帧）允许把请求帧号作为本地记录。
      if (!frame.frameId.startsWith('F-ENGINE-') && parameterSet.effectiveFrameId !== frame.frameId) {
        this.syncState = 'ERROR'
        this.syncResultCode = 'FRAME_MISMATCH'
        this.syncResultMessage = '参数只能在当前遥测帧边界生效。'
        this.syncResultFieldPath = 'effectiveFrameId'
        return false
      }
      this.syncState = 'EXECUTING'
      try {
        const response = await apiFetch(
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
        if (epoch !== this.requestEpoch || this.frame?.runId !== frameRunId) {
          // 晚返回的旧请求不污染当前设备/运行，也不让界面停留在“同步中”。
          this.syncResult = null
          this.syncState = 'EMPTY'
          this.syncResultCode = 'EMPTY'
          this.syncResultMessage = '尚未同步干扰参数。'
          this.syncResultFieldPath = null
          return false
        }
        this.syncVersions[jammerId] = result.parameterVersion
        // 同步成功且响应回显了实际接受的探测范围时，写入运行期本地参数读取层；旧响应缺省不改既有值。
        if (result.detectionRangeM !== undefined) {
          const runtimeKey = `${frameRunId ?? ''}|${jammerId}`
          const previousRuntime = this.jammerRuntimeParameters[runtimeKey]
          const runtime: JammerRuntimeParameters = {
            taskId,
            jammerId,
            version: result.parameterVersion,
            detectionRangeM: result.detectionRangeM,
          }
          if (previousRuntime?.style !== undefined) runtime.style = previousRuntime.style
          if (previousRuntime?.elevation !== undefined) runtime.elevation = previousRuntime.elevation
          if (previousRuntime?.plannedStartFrame !== undefined) runtime.plannedStartFrame = previousRuntime.plannedStartFrame
          if (previousRuntime?.plannedStopFrame !== undefined) runtime.plannedStopFrame = previousRuntime.plannedStopFrame
          this.jammerRuntimeParameters[runtimeKey] = runtime
        }
        this.syncState = 'SUCCESS'
        this.syncResultCode = 'SUCCESS'
        this.syncResultSource = 'LOCAL_PROJECTION'
        this.syncResultMessage = `参数版本 ${result.parameterVersion} 已在 ${result.effectiveFrameId} 同步。`
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
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
     * 读取运行期本地参数（版本 + 本地已接受探测范围 + 计划）；仅本地投影，不代表引擎确认。
     * @param taskId 参数所属任务编号。
     * @param jammerId 目标干扰设备编号。
     * @param options.force 为 true 时强制重读，忽略缓存。
     * @returns 读取到的运行期参数，失败时返回已有缓存或 null。
     */
    async loadJammerRuntimeParameters(
      taskId: TaskId,
      jammerId: string,
      options: { force?: boolean } = {},
    ): Promise<JammerRuntimeParameters | null> {
      const auth = useAuthStore()
      const runId = this.frame?.runId ?? ''
      const key = `${runId}|${jammerId}`
      const cached = this.jammerRuntimeParameters[key]
      if (cached !== undefined && options.force !== true) return cached
      try {
        const response = await apiFetch(
          `${resolveMockOrigin()}/api/v1/tasks/${encodeURIComponent(taskId)}/jammers/${encodeURIComponent(jammerId)}/parameters`,
          { headers: { 'X-Demo-Role': auth.role } },
        )
        const payload = await response.json() as unknown
        if (!response.ok || !isRecord(payload) || payload.ok !== true
          || !isJammerRuntimeParameters(payload.data)
          || payload.data.taskId !== taskId || payload.data.jammerId !== jammerId) return cached ?? null
        // 归属：读取期间运行已切换则丢弃本次结果，避免污染当前设备/运行。
        if ((this.frame?.runId ?? '') !== runId) return cached ?? null
        const value = structuredClone(payload.data)
        this.jammerRuntimeParameters[key] = value
        return value
      } catch {
        return cached ?? null
      }
    },

    /**
     * 保存运行期干扰计划与新增控制字段（仅本地留存，storage=LOCAL_RUN，不改场景、不代表引擎执行）。
     * @param taskId 计划所属任务编号。
     * @param jammerId 目标干扰设备编号。
     * @param request 样式、俯仰角与计划启停帧（原值，不乘 5）。
     * @returns 保存成功结果；失败返回 null 以便面板保留输入重试。
     */
    async saveJammerPlan(
      taskId: TaskId,
      jammerId: string,
      request: JammerPlanSaveRequest,
    ): Promise<JammerPlanSaved | null> {
      const auth = useAuthStore()
      const runId = this.frame?.runId ?? ''
      try {
        const response = await apiFetch(
          `${resolveMockOrigin()}/api/v1/tasks/${encodeURIComponent(taskId)}/jammers/${encodeURIComponent(jammerId)}/plan`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
            body: JSON.stringify(request),
          },
        )
        const payload = await response.json() as unknown
        if (!response.ok || !isRecord(payload) || payload.ok !== true
          || !isJammerPlanSaved(payload.data)
          || payload.data.taskId !== taskId || payload.data.jammerId !== jammerId) return null
        // 归属：保存期间运行/设备已切换则丢弃结果。
        if ((this.frame?.runId ?? '') !== runId) return null
        // 以服务端读取层为准刷新运行期参数（含计划与本地接受探测范围）。
        await this.loadJammerRuntimeParameters(taskId, jammerId, { force: true })
        return structuredClone(payload.data)
      } catch {
        return null
      }
    },

    /**
     * 原子加载固定帧及其事件。
     * @param runId 仿真运行编号，默认当前运行（尚未加载运行时先请求冻结 RUN-001）。
     * @param frameId 遥测帧编号，默认 F-00042。
     * @returns 两个接口均成功且同帧时返回 `true`。
     * @sideEffects 成功时替换帧和事件；失败时清空旧数据，避免展示过期结果。
     */
    async loadFrame(runId?: string, frameId = 'F-00042'): Promise<boolean> {
      const epoch = this.requestEpoch
      const currentRunId = runId ?? useSimulationStore().run?.runId ?? 'RUN-001'
      this.sensorStatuses = []
      this.jammingDecisions = []
      this.capabilityState = 'LOADING'
      this.resultFieldPath = null
      try {
        const headers = { 'X-Demo-Role': useAuthStore().role }
        const [frameResponse, eventResponse] = await Promise.all([
          apiFetch(`${resolveMockOrigin()}/api/v1/simulations/${encodeURIComponent(currentRunId)}/frames/${encodeURIComponent(frameId)}`, { headers }),
          apiFetch(`${resolveMockOrigin()}/api/v1/simulations/${encodeURIComponent(currentRunId)}/events`, { headers }),
        ])
        if (epoch !== this.requestEpoch) return false
        if (runId === undefined && useSimulationStore().run === null && frameResponse.status === 404) {
          const restored = await useSimulationStore().resetProjection()
          if (epoch !== this.requestEpoch) return false
          const restoredRunId = useSimulationStore().run?.runId
          if (restored && restoredRunId && restoredRunId !== currentRunId) return this.loadFrame(restoredRunId, frameId)
        }
        this.capabilityState = 'VALIDATING'
        const frame = await readSuccess(frameResponse, isTelemetryFrame, findTelemetryFieldError)
        if (epoch !== this.requestEpoch) return false
        const events = await readSuccess(
          eventResponse,
          (value): value is SituationEvent[] => Array.isArray(value) && value.every(isSituationEvent),
        )
        if (epoch !== this.requestEpoch) return false
        if (frame.runId !== currentRunId || frame.frameId !== frameId) throw new Error('返回的遥测帧与请求不一致。')
        const eventError = findEventCollectionError(frame, events)
        if (eventError !== null) throw eventError
        this.frame = structuredClone(frame)
        this.events = structuredClone(events)
        this.capabilityState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = '同帧态势遥测已加载。'
        this.resultFieldPath = null
        // 重新加载/首帧后按归属预取运行期本地参数，供面板读取已接受探测范围与计划（失败不影响帧加载）。
        const jammerIds = useScenarioStore().draft?.config.jammers.map((item) => item.id) ?? []
        if (jammerIds.length > 0) {
          await Promise.all(jammerIds.map((id) => this.loadJammerRuntimeParameters(frame.taskId, id)))
        }
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.frame = null
        this.events = []
        this.capabilityState = 'ERROR'
        this.resultCode = error instanceof TelemetryFieldError ? error.code : 'TELEMETRY_LOAD_FAILED'
        this.resultMessage = error instanceof Error ? error.message : '态势遥测加载失败。'
        this.resultFieldPath = error instanceof TelemetryFieldError ? error.fieldPath || null : null
        return false
      }
    },

    /**
     * 接收一条实时信封并按主题原子投影。
     * @param value WebSocket 解析出的未受信任值。
     * @returns 信封有效且被应用或判定为重复时返回 `true`。
     * @sideEffects 更新相应主题的投影和游标，跳号时从已接收的位置续传。
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
      const tick = envelope.topic === 'simulation.frame' && isEngineFrameTick(envelope.payload) ? envelope.payload : null
      if (tick) {
        const run = useSimulationStore().run
        if (!run || envelope.taskId !== run.taskId || tick.runId !== run.runId
          || envelope.frameId !== `F-ENGINE-${tick.sourceFrameId}` || envelope.simulationTime !== tick.simulationTime) return false
      } else if (envelope.topic === 'simulation.frame') {
        if (!isTelemetryFrame(envelope.payload)
          || envelope.taskId !== envelope.payload.taskId
          || (this.frame !== null && envelope.taskId !== this.frame.taskId)) return false
      } else if (envelope.topic === 'runtime.state') {
        const currentTaskId = useSimulationStore().run?.taskId ?? this.frame?.taskId
        if (currentTaskId === undefined || envelope.taskId !== currentTaskId) return false
      } else if (envelope.topic === 'link.metric' && isEngineFrameSnapshot(envelope.payload)) {
        const run = useSimulationStore().run
        if (!run || envelope.taskId !== run.taskId || envelope.payload.runId !== run.runId
          || envelope.frameId !== `F-ENGINE-${envelope.payload.frameId}` || envelope.simulationTime !== envelope.payload.simulationTime) return false
      } else if (envelope.topic === 'link.metric' && isQualityDatasetUpdate(envelope.payload)) {
        const taskId = useSimulationStore().run?.taskId ?? this.frame?.taskId
        if (taskId === undefined || envelope.taskId !== taskId || envelope.payload.scope.taskId !== taskId) return false
      } else if (envelope.topic === 'mission.log') {
        const run = useSimulationStore().run
        if (!run || envelope.taskId !== run.taskId || envelope.simulationTime !== undefined || envelope.frameId !== undefined
          || (!isMissionLogUpdate(envelope.payload) && !isEngineConnectionDiagnostic(envelope.payload))
          || envelope.payload.runId !== run.runId) return false
      } else if (envelope.topic === 'position.update') {
        const run = useSimulationStore().run
        if (!run || envelope.taskId !== run.taskId || envelope.simulationTime !== undefined || envelope.frameId !== undefined
          || !isMissionPositionUpdate(envelope.payload) || envelope.payload.runId !== run.runId || envelope.payload.scenarioId !== run.scenarioId) return false
      } else if (envelope.topic === 'jammer.event' && isEngineJammerFrameUpdate(envelope.payload)) {
        const run = useSimulationStore().run
        if (!run || envelope.taskId !== run.taskId || envelope.payload.runId !== run.runId
          || envelope.frameId !== `F-ENGINE-${envelope.payload.sourceFrameId}` || envelope.simulationTime !== envelope.payload.simulationTime) return false
      } else if (envelope.topic === 'switch.event' && isEngineSwitchFrameUpdate(envelope.payload)) {
        const run = useSimulationStore().run
        if (!run || envelope.taskId !== run.taskId || envelope.payload.runId !== run.runId
          || envelope.frameId !== `F-ENGINE-${envelope.payload.sourceFrameId}` || envelope.simulationTime !== envelope.payload.simulationTime) return false
      } else if (this.frame === null || envelope.taskId !== this.frame.taskId) return false

      const previous = this.topicSequences[envelope.topic]
      if (envelope.sequence <= previous) return true
      if (previous > 0 && envelope.sequence > previous + 1) {
        this.resultCode = 'SEQUENCE_GAP'
        this.resultMessage = `${envelope.topic} 缺少序号 ${previous + 1} 至 ${envelope.sequence - 1}，正在续传。`
        this.resultFieldPath = null
        runtimeFor(this).pendingGap = { topic: envelope.topic, through: envelope.sequence }
        void this.recoverFromGap('resume')
        return false
      }

      const commitEnvelope = (): true => {
        this.topicSequences[envelope.topic] = envelope.sequence
        const header: WsMessageHeaderSnapshot = {
          topic: envelope.topic,
          type: envelope.type,
          schemaVersion: envelope.schemaVersion,
          taskId: envelope.taskId,
          sequence: envelope.sequence,
          ...(envelope.simulationTime !== undefined ? { simulationTime: envelope.simulationTime } : {}),
          ...(envelope.frameId !== undefined ? { frameId: envelope.frameId } : {}),
          receivedAt: formatClockNow(),
        }
        if (BUSINESS_HEADER_TOPICS.has(envelope.topic)) {
          this.lastMessageHeader = header
          this.recentMessageHeaders = [header, ...this.recentMessageHeaders].slice(0, 5)
        } else if (this.lastMessageHeader === null) {
          this.lastMessageHeader = header
        }
        return true
      }

      if (tick) {
        // 时钟和地图仍跟随已接收的完整质量帧，先到的时标只用于对帧。
        this.engineFrameTick = tick
      } else if (envelope.topic === 'simulation.frame') {
        const payload = envelope.payload as TelemetryFrame
        if (envelope.frameId !== payload.frameId || envelope.simulationTime !== payload.simulationTime) return false
        if (this.frame?.frameId !== payload.frameId || this.frame?.runId !== payload.runId || this.frame?.simulationTime !== payload.simulationTime) {
          this.sensorStatuses = []
          this.jammingDecisions = []
        }
        this.frame = structuredClone(payload)
        this.events = this.events.filter((event) => event.frameId === payload.frameId)
      } else if (envelope.topic === 'link.metric') {
        if (isEngineFrameSnapshot(envelope.payload)) {
          const quality = useRuntimeQualityStore()
          if (!quality.acceptEngineFrame(quality.epoch, envelope.payload)) return false
          return commitEnvelope()
        }
        if (isQualityDatasetUpdate(envelope.payload)) {
          this.qualityUpdate = structuredClone(envelope.payload)
          return commitEnvelope()
        }
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
        if (envelope.payload.processId === null) void useSimulationStore().confirmStoppingProcessExit()
        void this.applyRuntimeState(envelope.sequence, previous)
      } else if (envelope.topic === 'mission.log') {
        if (isMissionLogUpdate(envelope.payload)) {
          const update = structuredClone(envelope.payload)
          this.missionLogUpdate = update
          this.missionLogUpdates = [...this.missionLogUpdates, update].slice(-128)
        }
        else if (isEngineConnectionDiagnostic(envelope.payload)) {
          const diagnostics = [...this.engineDiagnostics, structuredClone(envelope.payload)]
          const connection = diagnostics.slice().reverse().find(item => ['CONNECTED', 'CONNECTING', 'DISCONNECTED'].includes(item.state))
          this.engineDiagnostics = diagnostics.slice(-20)
          // 连接状态不能被高频帧诊断挤掉，否则仍在收帧的页面会误报断线。
          if (connection && !this.engineDiagnostics.includes(connection)) {
            this.engineDiagnostics = [connection, ...this.engineDiagnostics.slice(-19)]
          }
        }
        else return false
      } else if (envelope.topic === 'position.update') {
        if (!isMissionPositionUpdate(envelope.payload)) return false
        this.missionPositionUpdate = structuredClone(envelope.payload)
      } else if (envelope.topic === 'jammer.event') {
        const payload = envelope.payload
        if (isEngineJammerFrameUpdate(payload)) {
          this.engineJammerUpdates = [...this.engineJammerUpdates, structuredClone(payload)].slice(-200)
          return commitEnvelope()
        }
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
        } else if (isRecord(payload) && payload.type === 'SENSOR_STATUS') {
          if (!isSensorStatus(payload) || payload.time !== this.frame.simulationTime
            || !this.frame.platforms.some(platform => platform.platformId === payload.platformId)) return false
          this.sensorStatuses = [...this.sensorStatuses.filter(status => status.sensorId !== payload.sensorId), structuredClone(payload)]
        } else if (isRecord(payload) && payload.type === 'JAMMING_DECISION') {
          const decision = payload.decision
          if (Object.keys(payload).length !== 2 || !isJammingDecision(decision)
            || decision.runId !== this.frame.runId || decision.frameId !== this.frame.frameId
            || decision.effectiveFrameId !== this.frame.frameId
            || !this.frame.platforms.some(platform => platform.platformId === decision.targetPlatformId)
            || !frameJammerExecutions(this.frame).some(item => item.jammerId === decision.jammerId)
            || !this.frame.linkSummaries.some(summary => resolveLinkId(summary, this.frame!) === decision.affectedLinkId)
            || (decision.action === 'START' && this.events.some(event => event.type === 'DETECTION'
              && event.eventId === decision.detectionEventId && event.detected === false))) return false
          this.rememberJammingDecision(decision)
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
        if (isEngineSwitchFrameUpdate(payload)) {
          this.engineSwitchUpdates = [...this.engineSwitchUpdates, structuredClone(payload)].slice(-200)
          return commitEnvelope()
        }
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

      return commitEnvelope()
    },

    /**
     * 读取实时通知对应的完整运行，失败时保留可重放序号并执行完整重同步。
     * @param sequence 当前实时通知序号。
     * @param previous 同步前已确认的主题序号。
     * @returns 同步流程完成后兑现且不返回值的 Promise。
     * @sideEffects 可能更新运行锁、显示错误、回退主题序号并重建实时订阅。
     */
    async applyRuntimeState(sequence: number, previous: number): Promise<void> {
      const simulation = useSimulationStore()
      const epoch = this.requestEpoch
      if (simulation.runtimeSyncing) {
        // 在途 HTTP 快照可能早于新通知，只让最后一条通知在它完成后再查一次。
        await new Promise<void>(resolve => watch(() => simulation.runtimeSyncing, () => resolve(), { once: true, flush: 'sync' }))
        if (epoch !== this.requestEpoch || this.topicSequences['runtime.state'] !== sequence) return
      }
      if (await simulation.synchronizeRuntimeState()) {
        if (epoch === this.requestEpoch && this.resultCode === 'RUNTIME_STATE_SYNC_FAILED') {
          this.resultCode = 'SUCCESS'
          this.resultMessage = '仿真运行状态已同步。'
        }
        return
      }
      if (epoch !== this.requestEpoch || this.topicSequences['runtime.state'] !== sequence) return
      this.topicSequences['runtime.state'] = previous
      this.resultCode = 'RUNTIME_STATE_SYNC_FAILED'
      this.resultMessage = '仿真运行状态同步失败，正在重新同步。'
      this.resultFieldPath = null
      await this.recoverFromGap('resume')
    },

    recordConnectionEvent(state: WsConnectionState, detail: string): void {
      this.connectionHistory = [{ at: formatClockNow(), state, detail }, ...this.connectionHistory].slice(0, 12)
    },

    /**
     * 建立实时连接并逐主题订阅态势数据。
     * @returns 无返回值。
     * @sideEffects 创建 WebSocket，更新连接状态，并在断线时按固定退避重试。
     */
    connect(closeWithPageRunId?: string): void {
      if (this.connectionBlocked || typeof WebSocket === 'undefined') return
      const runtime = runtimeFor(this)
      if (runtime.socket?.readyState === WebSocket.OPEN || runtime.socket?.readyState === WebSocket.CONNECTING) return
      runtime.manuallyClosed = false
      this.connectionState = runtime.retryAttempt === 0 ? 'CONNECTING' : 'RETRYING'
      this.retryAttemptCount = runtime.retryAttempt
      this.recordConnectionEvent(
        this.connectionState,
        runtime.retryAttempt === 0 ? '正在建立 WebSocket 连接' : `正在进行第 ${runtime.retryAttempt} 次自动重连`,
      )
      const taskId = useSimulationStore().run?.taskId ?? this.frame?.taskId ?? this.realtimeTaskId ?? 'TASK-001'
      this.realtimeTaskId = taskId
      if (closeWithPageRunId) runtime.closeWithPageRunId = closeWithPageRunId
      const url = new URL(resolveRealtimeUrl(useAuthStore().role))
      if (runtime.closeWithPageRunId) url.searchParams.set('missionRunId', runtime.closeWithPageRunId)
      const socket = new WebSocket(url.toString())
      runtime.socket = socket

      socket.addEventListener('open', () => {
        if (runtime.socket !== socket) return
        socket.send(JSON.stringify({
          type: 'subscribe',
          schemaVersion: '1.0',
          taskId,
          topics: TOPICS,
          lastSequences: { ...this.topicSequences },
          ...(runtime.subscribedRunId && { resumeRunId: runtime.subscribedRunId }),
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
          const subscribedTopics = message.topics
          if (message.schemaVersion === '1.0'
            && message.taskId === taskId
            && Array.isArray(subscribedTopics)
            && subscribedTopics.length === TOPICS.length
            && TOPICS.every((topic) => subscribedTopics.includes(topic))
            && Number.isSafeInteger(message.lastSequence)
            && Number.isSafeInteger(message.nextSequence)) {
            runtime.retryAttempt = 0
            this.retryAttemptCount = 0
            stopPageProbe(runtime)
            const activeRunId = useSimulationStore().run?.runId ?? this.frame?.runId
            runtime.subscribedRunId = message.runId === activeRunId ? activeRunId : undefined
            this.connectionState = 'SUBSCRIBED'
            const curSeq = Math.max(Number(message.lastSequence), maxBusinessSequence(this.topicSequences))
            if (this.disconnectedAtSequence !== null) {
              const fromSeq = this.disconnectedAtSequence
              this.disconnectedAtSequence = null
              this.recordConnectionEvent('SUBSCRIBED', `已恢复连接并续传（断前序号 #${fromSeq} → 当前 #${curSeq}）`)
            } else {
              this.recordConnectionEvent('SUBSCRIBED', `已连接并订阅 ${TOPICS.length} 个主题（当前序号 #${curSeq}）`)
            }
            if (this.resultCode === 'REALTIME_CONNECTION_FAILED' && !runtime.pendingGap) {
              this.resultCode = 'SUCCESS'
              this.resultMessage = '实时连接已恢复。'
            }
          }
          return
        }
        if (isRecord(message) && message.type === 'rejected' && message.code === 'SEQUENCE_GAP') {
          this.flushIncoming()
          if (runtime.socket !== socket) return
          const gap = message.gap
          if (isRecord(gap) && runtime.subscribedRunId && gap.runId === runtime.subscribedRunId && TOPICS.includes(gap.topic as WsTopic)
            && Number.isSafeInteger(gap.missingFrom) && Number.isSafeInteger(gap.missingThrough)) {
            const topic = gap.topic as WsTopic
            const from = Number(gap.missingFrom), through = Number(gap.missingThrough)
            const previous = this.topicSequences[topic]
            if (from > 0 && (previous === 0 || from === previous + 1) && through >= from) {
              this.resultCode = 'SEQUENCE_GAP'
              this.resultMessage = `${topic} 序号 ${from} 至 ${through} 已超出保留窗口，从 ${through + 1} 继续。`
              delete runtime.pendingGap
              this.topicSequences[topic] = through
              void this.recoverFromGap('resume')
              return
            }
          }
          if (runtime.subscribedRunId && message.runChanged !== true) {
            this.resultCode = 'SEQUENCE_GAP'
            this.resultMessage = `实时记录暂不可续传，各主题保留原序号。${typeof message.message === 'string' ? message.message : ''}`
            void this.recoverFromGap('resume')
          } else {
            void this.recoverFromGap(message.runChanged === true ? 'runChanged' : 'snapshot')
          }
          return
        }
        // 顺序消费全部消息，只合并 Vue 渲染，避免加速运行时逐帧重绘阻塞接收。
        runtime.incoming.push(message)
        if (runtime.incoming.length >= 128) this.flushIncoming()
        else if (runtime.incomingTimer === null) runtime.incomingTimer = setTimeout(() => this.flushIncoming(), 100)
      })
      socket.addEventListener('close', () => {
        if (runtime.socket !== socket) return
        this.flushIncoming()
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
     * 可补发的跳号保留各主题游标，运行替换或手动重同步再取新快照。
     * @returns 补偿流程完成后兑现且不返回值的 Promise。
     * @sideEffects 关闭旧连接，按恢复方式续传或重新获取快照。
     */
    async recoverFromGap(mode: 'resume' | 'snapshot' | 'runChanged' = 'snapshot'): Promise<void> {
      const runtime = runtimeFor(this)
      if (runtime.incomingTimer !== null) clearTimeout(runtime.incomingTimer)
      runtime.incomingTimer = null
      runtime.incoming = []
      const recoveryEpoch = this.requestEpoch
      const simulation = useSimulationStore()
      runtime.manuallyClosed = true
      const previousSocket = runtime.socket
      runtime.socket = null
      previousSocket?.close()
      if (mode === 'resume') {
        runtime.manuallyClosed = false
        if (runtime.retryTimer === null) this.scheduleReconnect()
        return
      }
      delete runtime.subscribedRunId
      delete runtime.pendingGap
      stopPageProbe(runtime)
      if (mode === 'runChanged') delete runtime.closeWithPageRunId
      this.engineFrameTick = null
      Object.keys(this.topicSequences).forEach((topic) => { this.topicSequences[topic as WsTopic] = 0 })
      // 真实运行没有固定 REST 遥测帧；重新订阅已有 journal 即可恢复引擎整帧。
      const localMission = useAuthStore().runtimeMode === 'LOCAL' && this.frame === null && !!simulation.run?.startedAt
      // 其他页面可能已替换当前运行，先同步编号再读取它的快照。
      if (simulation.run && (!localMission || mode === 'runChanged')) {
        const synchronized = !simulation.pending && await simulation.synchronizeRuntimeState()
        if (this.requestEpoch !== recoveryEpoch) return
        if (!synchronized || simulation.pending) {
          this.scheduleReconnect(true)
          return
        }
      }
      if (localMission || await this.loadFrame(simulation.run?.runId)) {
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
     * @sideEffects 拥有本机运行的页面在故障期间以最多两秒的间隔重试。
     */
    scheduleReconnect(recoverFrame = false): void {
      const runtime = runtimeFor(this)
      if (!recoverFrame) maintainPageDuringReconnect(runtime)
      const delay = RETRY_DELAYS[runtime.retryAttempt] ?? (runtime.pageProbe !== undefined ? RETRY_DELAYS[3] : undefined)
      if (this.disconnectedAtSequence === null) {
        const seq = maxBusinessSequence(this.topicSequences)
        if (seq > 0) this.disconnectedAtSequence = seq
      }
      if (delay === undefined) {
        runtime.manuallyClosed = false
        this.connectionState = 'FAILED'
        this.recordConnectionEvent('FAILED', '连接中断且达到最大重试次数，请手动重连')
        return
      }
      runtime.retryAttempt += 1
      this.retryAttemptCount = runtime.retryAttempt
      this.connectionState = 'RETRYING'
      this.recordConnectionEvent('RETRYING', `连接已中断，${Math.round(delay / 1000)} 秒后第 ${runtime.retryAttempt} 次重连`)
      runtime.retryTimer = setTimeout(() => {
        runtime.retryTimer = null
        if (recoverFrame) void this.recoverFromGap()
        else this.connect()
      }, delay)
    },

    /** 手动暂时断开前端 WebSocket 连接，保留当前帧与各主题序号以便后续恢复续传；同时维持页面存活探针避免本机仿真被判为关页中止。 */
    pauseConnection(): void {
      const runtime = runtimeFor(this)
      runtime.manuallyClosed = true
      if (runtime.retryTimer !== null) clearTimeout(runtime.retryTimer)
      runtime.retryTimer = null
      runtime.retryAttempt = 0
      this.retryAttemptCount = 0
      const previous = runtime.socket
      runtime.socket = null
      previous?.close()
      maintainPageDuringReconnect(runtime)
      const seq = maxBusinessSequence(this.topicSequences)
      this.disconnectedAtSequence = seq > 0 ? seq : null
      this.connectionState = 'DISCONNECTED'
      this.recordConnectionEvent(
        'DISCONNECTED',
        seq > 0
          ? `已手动断开前端 WebSocket（停在序号 #${seq}，仿真继续运行）`
          : '已手动断开前端 WebSocket（仿真继续运行）',
      )
    },

    /** 立即手动重新建立 WebSocket 连接并沿原主题序号续传。 */
    reconnectNow(): void {
      const runtime = runtimeFor(this)
      if (runtime.retryTimer !== null) clearTimeout(runtime.retryTimer)
      runtime.retryTimer = null
      runtime.retryAttempt = 0
      this.retryAttemptCount = 0
      this.connect()
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
      delete runtime.closeWithPageRunId
      runtime.socket?.close()
      runtime.socket = null
      this.resetToSafeEmpty()
    },

    flushIncoming(): void {
      const runtime = runtimeFor(this)
      if (runtime.incomingTimer !== null) clearTimeout(runtime.incomingTimer)
      runtime.incomingTimer = null
      const messages = runtime.incoming
      runtime.incoming = []
      const socket = runtime.socket
      const epoch = this.requestEpoch
      for (const message of messages) {
        if (runtime.socket !== socket || this.requestEpoch !== epoch) break
        const applied = this.acceptEnvelope(message)
        const gap = runtime.pendingGap
        if (applied && gap && this.topicSequences[gap.topic] >= gap.through) {
          delete runtime.pendingGap
          this.resultCode = 'SUCCESS'
          this.resultMessage = `${gap.topic} 已续传。`
        }
      }
    },

    rememberJammingDecision(decision: JammingDecision): void {
      if (!this.jammingDecisions.some(item => item.decisionId === decision.decisionId)) this.jammingDecisions.push(structuredClone(decision))
    },

    /**
     * 将遥测 Store 恢复为无过期数据的安全空态。
     * @returns 无返回值。
     * @sideEffects 使在途加载失效并清空帧、事件、主题序号和连接反馈。
     */
    resetToSafeEmpty(): void {
      const runtime = runtimeFor(this)
      if (runtime.incomingTimer !== null) clearTimeout(runtime.incomingTimer)
      runtime.incomingTimer = null
      runtime.incoming = []
      this.requestEpoch += 1
      this.realtimeTaskId = null
      stopPageProbe(runtime)
      delete runtime.subscribedRunId
      delete runtime.pendingGap
      this.engineFrameTick = null
      this.frame = null
      this.events = []
      this.sensorStatuses = []
      this.jammingDecisions = []
      this.qualityUpdate = null
      this.missionLogUpdate = null
      this.missionLogUpdates = []
      this.engineDiagnostics = []
      this.missionPositionUpdate = null
      this.engineJammerUpdates = []
      this.engineSwitchUpdates = []
      Object.keys(this.topicSequences).forEach((topic) => { this.topicSequences[topic as WsTopic] = 0 })
      this.connectionState = 'DISCONNECTED'
      this.retryAttemptCount = 0
      this.disconnectedAtSequence = null
      this.lastMessageHeader = null
      this.recentMessageHeaders = []
      this.connectionHistory = []
      this.capabilityState = 'EMPTY'
      this.resultCode = 'EMPTY'
      this.resultMessage = '尚未加载态势遥测。'
      this.resultFieldPath = null
      this.jammerState = null
      this.jammerControlState = 'EMPTY'
      this.jammerResultCode = 'EMPTY'
      this.jammerResultMessage = '尚未执行干扰控制命令。'
      this.jammerResultFieldPath = null
      this.jammerResultSource = null
      this.closedLoopDecision = null
      this.closedLoopState = 'EMPTY'
      this.closedLoopResultCode = 'EMPTY'
      this.closedLoopResultMessage = '尚未执行逐帧干扰闭环。'
      this.closedLoopResultFieldPath = null
      this.closedLoopResultSource = null
      this.syncResult = null
      this.syncVersions = {}
      this.jammerRuntimeParameters = {}
      this.syncState = 'EMPTY'
      this.syncResultCode = 'EMPTY'
      this.syncResultMessage = '尚未同步干扰参数。'
      this.syncResultFieldPath = null
      this.syncResultSource = null
    },
  },
})

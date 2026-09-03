import { defineStore } from 'pinia'
import type {
  ApiFailure,
  CapabilityState,
  DetectionEvent,
  LinkStatusSummary,
  RealtimeEnvelope,
  SimulationState,
  SwitchEvent,
  TelemetryFrame,
  WsConnectionState,
  WsTopic,
} from '../contracts/domain-models'
import { resolveMockOrigin, useAuthStore } from './auth'
import { useSimulationStore } from './simulation'

type SituationEvent = DetectionEvent | SwitchEvent

const TOPICS: WsTopic[] = ['simulation.frame', 'runtime.state', 'link.metric']
const RETRY_DELAYS = [250, 500, 1_000, 2_000] as const
const PLATFORM_TYPES = new Set([
  'REAR_COMMAND_NODE', 'FORWARD_RELAY_NODE', 'GROUND_CLUSTER_COMMAND_NODE',
  'AIRBORNE_MISSION_CLUSTER', 'COMMUNICATION_SATELLITE', 'GROUND_JAMMER_DETECTION_STATION',
])
const LINK_TYPES = new Set(['SAT', 'MICROWAVE', 'DATALINK', 'LASER'])

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

/** 校验对象的一组字段均为有限数值。 */
function hasFiniteNumbers(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
}

/** 校验平台内嵌的干扰设备遥测。 */
function isJammerStatus(value: unknown): boolean {
  if (!isRecord(value)) return false
  return hasStrings(value, ['jammerId', 'platformId'])
    && (value.targetPlatform === undefined || typeof value.targetPlatform === 'string')
    && hasFiniteNumbers(value, ['time', 'power', 'frequency', 'bandwidth'])
    && typeof value.active === 'boolean'
}

/** 校验态势页会读取的平台状态字段。 */
function isPlatform(value: unknown): boolean {
  if (!isRecord(value)) return false
  return hasStrings(value, ['platformId', 'name'])
    && PLATFORM_TYPES.has(String(value.type))
    && hasFiniteNumbers(value, ['longitude', 'latitude', 'altitude', 'speed', 'updatedAt'])
    && Array.isArray(value.linkIds) && value.linkIds.every((linkId) => typeof linkId === 'string')
    && Array.isArray(value.jammers) && value.jammers.every(isJammerStatus)
}

/** 校验态势页会读取的链路摘要字段。 */
function isLinkSummary(value: unknown): value is LinkStatusSummary {
  if (!isRecord(value)) return false
  return hasStrings(value, ['linkKey', 'sourcePlatform', 'destPlatform'])
    && LINK_TYPES.has(String(value.linkType))
    && hasFiniteNumbers(value, ['currentSnr', 'currentBer', 'updatedAt'])
    && (value.status === 'UP' || value.status === 'DOWN')
}

/** 校验链路详情面板会读取的完整遥测成员。 */
function isTelemetryLink(value: unknown): boolean {
  if (!isRecord(value)) return false
  return hasStrings(value, ['linkId', 'sourcePlatform', 'destPlatform'])
    && LINK_TYPES.has(String(value.linkType))
    && hasFiniteNumbers(value, [
      'time', 'frequency', 'bandwidth', 'distance', 'txPower', 'txAntennaGain', 'rxAntennaGain',
      'pathLoss', 'jammingPower', 'receivedPower', 'snr', 'ber', 'berThreshold', 'dataRate',
    ])
    && (value.modulation === 'BPSK' || value.modulation === 'QPSK')
    && value.coding === 'UNCODED'
    && value.qualityModelVersion === 'SNBER-1.2'
    && (value.linkStatus === 'UP' || value.linkStatus === 'DOWN')
}

/** 校验界面链路状态投影成员。 */
function isUiLink(value: unknown): value is TelemetryFrame['uiLinks'][number] {
  if (!isRecord(value)) return false
  return hasStrings(value, ['linkId', 'frameId'])
    && typeof value.reason === 'string' && value.reason.length > 0
    && value.thresholdVersion === 'LLZT-1.0'
    && (value.status === 'UP' || value.status === 'DEGRADED' || value.status === 'DOWN')
    && (value.canonicalStatus === 'UP' || value.canonicalStatus === 'DOWN')
    && Number.isInteger(value.consecutiveFrames) && Number(value.consecutiveFrames) >= 0
    && typeof value.ageMs === 'number' && Number.isFinite(value.ageMs) && value.ageMs >= 0
}

/** 校验链路标识解析和状态回退会读取的候选链路证据。 */
function isRouteCandidate(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.linkId === 'string'
    && (value.direction === 'FORWARD' || value.direction === 'REVERSE')
    && typeof value.eligible === 'boolean'
    && hasFiniteNumbers(value, ['jamImpactDb', 'ber', 'stabilityFrames', 'rank'])
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

/** 校验 REST 或实时通道返回的完整遥测帧。 */
export function isTelemetryFrame(value: unknown): value is TelemetryFrame {
  if (!isRecord(value)) return false
  return typeof value.frameId === 'string'
    && typeof value.taskId === 'string'
    && typeof value.runId === 'string'
    && typeof value.simulationTime === 'number' && Number.isFinite(value.simulationTime)
    && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0
    && Array.isArray(value.platforms) && value.platforms.every(isPlatform)
    && Array.isArray(value.links) && value.links.every(isTelemetryLink)
    && Array.isArray(value.linkSummaries) && value.linkSummaries.every(isLinkSummary)
    && Array.isArray(value.uiLinks)
    && value.uiLinks.every((uiLink) => isUiLink(uiLink) && uiLink.frameId === value.frameId)
    && Array.isArray(value.eventIds) && value.eventIds.every((eventId) => typeof eventId === 'string')
    && isRecord(value.evidence)
    && Array.isArray(value.evidence.losses) && value.evidence.losses.every(isCompositeLossEvidence)
    && Array.isArray(value.evidence.routeCandidates) && value.evidence.routeCandidates.every(isRouteCandidate)
    && isSynchronizationEvidence(value.evidence.synchronization)
}

/** 校验同帧侦测或链路切换事件的公共身份字段。 */
function isSituationEvent(value: unknown): value is SituationEvent {
  if (!isRecord(value)) return false
  const common = typeof value.eventId === 'string'
    && typeof value.frameId === 'string'
    && typeof value.time === 'number'
    && typeof value.dedupeKey === 'string'
  if (!common) return false
  if (value.type === 'DETECTION') {
    return typeof value.sensorId === 'string'
      && typeof value.targetPlatformId === 'string'
      && typeof value.detectionProbability === 'number'
  }
  return value.type === 'LINK_SWITCH'
    && typeof value.oldLinkId === 'string'
    && typeof value.newLinkId === 'string'
    && (value.decision === 'ACCEPTED' || value.decision === 'REJECTED')
    && typeof value.reason === 'string'
}

/** 校验实时规范仿真状态。 */
function isSimulationState(value: unknown): value is SimulationState {
  if (!isRecord(value)) return false
  return ['IDLE', 'RUNNING', 'PAUSED', 'COMPLETED', 'ERROR'].includes(String(value.status))
    && typeof value.currentTime === 'number' && value.currentTime >= 0
    && typeof value.totalDuration === 'number' && value.totalDuration >= 0
    && (value.processId === null || (Number.isInteger(value.processId) && Number(value.processId) > 0))
    && typeof value.progress === 'number' && value.progress >= 0 && value.progress <= 100
    && (value.errorMessage === undefined || typeof value.errorMessage === 'string')
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
    capabilityState: 'EMPTY' as CapabilityState,
    resultCode: 'EMPTY',
    resultMessage: '尚未加载态势遥测。',
    resultFieldPath: null as string | null,
    requestEpoch: 0,
  }),

  actions: {
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
        const eventIds = events.map((event) => event.eventId)
        const eventIdSet = new Set(eventIds)
        if (frame.runId !== runId
          || frame.frameId !== frameId
          || events.some((event) => event.frameId !== frame.frameId || event.time !== frame.simulationTime)
          || frame.eventIds.length !== eventIds.length
          || new Set(frame.eventIds).size !== frame.eventIds.length
          || eventIdSet.size !== eventIds.length
          || frame.eventIds.some((eventId) => !eventIdSet.has(eventId))) {
          throw new Error('遥测帧与事件不属于同一帧。')
        }
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
        const payload = envelope.payload
        if (!isTelemetryFrame(payload)
          || envelope.frameId !== payload.frameId
          || envelope.simulationTime !== payload.simulationTime) return false
        this.frame = structuredClone(payload)
        this.events = this.events.filter((event) => event.frameId === payload.frameId)
      } else if (envelope.topic === 'link.metric') {
        if (this.frame === null
          || envelope.frameId !== this.frame.frameId
          || envelope.simulationTime !== this.frame.simulationTime
          || !Array.isArray(envelope.payload)
          || !envelope.payload.every(isLinkSummary)) return false
        this.frame = { ...this.frame, linkSummaries: structuredClone(envelope.payload) }
      } else if (envelope.topic === 'runtime.state') {
        if (!isSimulationState(envelope.payload)) return false
        void this.applyRuntimeState(envelope.sequence, previous)
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
     * 建立本机实时连接并订阅态势所需的三个主题。
     * @returns 无返回值。
     * @sideEffects 创建 WebSocket，更新连接状态，并在断线时按固定退避重试。
     */
    connect(): void {
      if (typeof WebSocket === 'undefined') return
      const runtime = runtimeFor(this)
      if (runtime.socket?.readyState === WebSocket.OPEN || runtime.socket?.readyState === WebSocket.CONNECTING) return
      runtime.manuallyClosed = false
      this.connectionState = runtime.retryAttempt === 0 ? 'CONNECTING' : 'RETRYING'
      const socket = new WebSocket(resolveRealtimeUrl(useAuthStore().role))
      runtime.socket = socket

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          type: 'subscribe',
          schemaVersion: '1.0',
          taskId: this.frame?.taskId ?? 'TASK-001',
          topics: TOPICS,
          lastSequence: 0,
        }))
      })
      socket.addEventListener('message', (event) => {
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
        if (runtime.socket === socket) runtime.socket = null
        if (!runtime.manuallyClosed) this.scheduleReconnect()
      })
      socket.addEventListener('error', () => {
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
    },
  },
})

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

/** 校验态势页会读取的平台状态字段。 */
function isPlatform(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.platformId === 'string'
    && typeof value.name === 'string'
    && typeof value.type === 'string'
    && typeof value.longitude === 'number'
    && typeof value.latitude === 'number'
    && typeof value.altitude === 'number'
    && typeof value.speed === 'number'
    && Array.isArray(value.linkIds)
    && Array.isArray(value.jammers)
}

/** 校验态势页会读取的链路摘要字段。 */
function isLinkSummary(value: unknown): value is LinkStatusSummary {
  if (!isRecord(value)) return false
  return typeof value.linkKey === 'string'
    && typeof value.sourcePlatform === 'string'
    && typeof value.destPlatform === 'string'
    && ['SAT', 'MICROWAVE', 'DATALINK', 'LASER'].includes(String(value.linkType))
    && typeof value.currentSnr === 'number'
    && typeof value.currentBer === 'number'
    && (value.status === 'UP' || value.status === 'DOWN')
    && typeof value.updatedAt === 'number'
}

/** 校验 REST 或实时通道返回的完整遥测帧。 */
export function isTelemetryFrame(value: unknown): value is TelemetryFrame {
  if (!isRecord(value)) return false
  return typeof value.frameId === 'string'
    && typeof value.taskId === 'string'
    && typeof value.runId === 'string'
    && typeof value.simulationTime === 'number'
    && Number.isSafeInteger(value.sequence)
    && Array.isArray(value.platforms) && value.platforms.every(isPlatform)
    && Array.isArray(value.links)
    && Array.isArray(value.linkSummaries) && value.linkSummaries.every(isLinkSummary)
    && Array.isArray(value.uiLinks)
    && Array.isArray(value.eventIds)
    && isRecord(value.evidence)
    && Array.isArray(value.evidence.routeCandidates)
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

/** 从统一成功信封读取并校验业务数据。 */
async function readSuccess<T>(response: Response, validate: (value: unknown) => value is T): Promise<T> {
  const payload = await response.json() as unknown
  if (!response.ok) throw payload as ApiFailure
  if (!isRecord(payload) || payload.ok !== true || !validate(payload.data)) throw new Error('遥测响应格式不正确。')
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
      try {
        const headers = { 'X-Demo-Role': useAuthStore().role }
        const [frameResponse, eventResponse] = await Promise.all([
          fetch(`${resolveMockOrigin()}/api/v1/simulations/${encodeURIComponent(runId)}/frames/${encodeURIComponent(frameId)}`, { headers }),
          fetch(`${resolveMockOrigin()}/api/v1/simulations/${encodeURIComponent(runId)}/events`, { headers }),
        ])
        if (epoch !== this.requestEpoch) return false
        this.capabilityState = 'VALIDATING'
        const [frame, events] = await Promise.all([
          readSuccess(frameResponse, isTelemetryFrame),
          readSuccess(eventResponse, (value): value is SituationEvent[] => Array.isArray(value) && value.every(isSituationEvent)),
        ])
        if (epoch !== this.requestEpoch) return false
        if (frame.runId !== runId || frame.frameId !== frameId || events.some((event) => event.frameId !== frame.frameId)) {
          throw new Error('遥测帧与事件不属于同一帧。')
        }
        this.frame = structuredClone(frame)
        this.events = structuredClone(events)
        this.capabilityState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = '同帧态势遥测已加载。'
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.frame = null
        this.events = []
        this.capabilityState = 'ERROR'
        this.resultCode = 'TELEMETRY_LOAD_FAILED'
        this.resultMessage = error instanceof Error ? error.message : '态势遥测加载失败。'
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
        useSimulationStore().projectRuntimeState(envelope.payload)
      }

      this.topicSequences[envelope.topic] = envelope.sequence
      return true
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
      })
    },

    /**
     * 在实时序号断档后用 REST 恢复完整快照并重新订阅。
     * @returns 补偿流程完成后兑现且不返回值的 Promise。
     * @sideEffects 关闭旧连接、重置主题游标、加载完整帧并重新连接。
     */
    async recoverFromGap(): Promise<void> {
      const runtime = runtimeFor(this)
      runtime.manuallyClosed = true
      runtime.socket?.close()
      runtime.socket = null
      Object.keys(this.topicSequences).forEach((topic) => { this.topicSequences[topic as WsTopic] = 0 })
      if (await this.loadFrame()) {
        runtime.manuallyClosed = false
        this.connect()
      }
    },

    /**
     * 安排下一次固定退避重连。
     * @returns 无返回值。
     * @sideEffects 最多创建四次定时重连，耗尽后进入 FAILED 状态。
     */
    scheduleReconnect(): void {
      const runtime = runtimeFor(this)
      const delay = RETRY_DELAYS[runtime.retryAttempt]
      if (delay === undefined) {
        this.connectionState = 'FAILED'
        return
      }
      runtime.retryAttempt += 1
      this.connectionState = 'RETRYING'
      runtime.retryTimer = setTimeout(() => {
        runtime.retryTimer = null
        this.connect()
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
    },
  },
})

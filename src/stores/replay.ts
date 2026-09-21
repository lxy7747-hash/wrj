import { apiFetch } from '../features/shared/api-fetch'
import { defineStore } from 'pinia'
import { markRaw, toRaw } from 'vue'
import type {
  DetectionEvent,
  Replay,
  ReplayCommand,
  ReplayState,
  SwitchEvent,
} from '../contracts/domain-models'
import { resolveMockOrigin, useAuthStore } from './auth'
import { readApiFailure, unwrapSuccessData } from './api-envelope'
import { isSituationEvent, useTelemetryStore } from './telemetry'
import { isLocalReplaySnapshot, type LocalReplaySnapshot } from '../features/replays/local-replay'
import { isLocalArchiveSnapshot } from '../features/admin/local-archive'

type ReplayEvent = DetectionEvent | SwitchEvent

interface ReplayRuntime {
  timer: ReturnType<typeof setInterval> | null
  pendingCommand: number | null
  fileRequest: AbortController | null
}

const runtimes = new WeakMap<object, ReplayRuntime>()
const REPLAY_STATES = new Set<ReplayState>([
  'EMPTY', 'LOADING', 'PAUSED', 'PLAYING', 'SEEKING', 'COMPLETED', 'CORRUPT', 'ERROR',
])

/** 返回 Store 实例独享的非响应式播放计时器。 */
function runtimeFor(store: object): ReplayRuntime {
  // 开发工具会为不同 action 创建不同代理；用原始 Store 保证计时器和请求可被正确取消。
  const owner = toRaw(store)
  const existing = runtimes.get(owner)
  if (existing !== undefined) return existing
  const runtime = { timer: null, pendingCommand: null, fileRequest: null }
  runtimes.set(owner, runtime)
  return runtime
}

/** 校验回放编号、状态、时长、游标与事件引用。 */
export function isReplay(value: unknown): value is Replay {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const replay = value as Partial<Replay>
  return Object.keys(value).length === 6
    && typeof replay.replayId === 'string' && replay.replayId.startsWith('REPLAY-')
    && typeof replay.runId === 'string' && replay.runId.startsWith('RUN-')
    && typeof replay.state === 'string' && REPLAY_STATES.has(replay.state as ReplayState)
    && typeof replay.durationS === 'number' && Number.isFinite(replay.durationS) && replay.durationS >= 0
    && typeof replay.currentTimeS === 'number' && Number.isFinite(replay.currentTimeS)
    && replay.currentTimeS >= 0 && replay.currentTimeS <= replay.durationS
    && Array.isArray(replay.eventIds)
    && replay.eventIds.every((id) => typeof id === 'string' && id.length > 0)
    && new Set(replay.eventIds).size === replay.eventIds.length
}

/** 读取统一成功信封并校验业务数据。 */
async function readSuccess<T>(response: Response, validate: (value: unknown) => value is T): Promise<T> {
  const payload = await response.json() as unknown
  if (!response.ok) throw readApiFailure(payload) ?? new Error('历史回放服务响应错误。')
  const data = unwrapSuccessData(payload)
  if (!validate(data)) throw new TypeError('历史回放数据格式不正确。')
  return data
}

/** 返回事件在历史回放注册表中的时刻。 */
export function replayEventTime(event: ReplayEvent): number {
  return event.sourceRegistryTime ?? event.time
}

export const useReplayStore = defineStore('replay', {
  state: () => ({
    replays: [] as Replay[],
    replay: null as Replay | null,
    events: [] as ReplayEvent[],
    state: 'EMPTY' as ReplayState,
    speed: 1,
    selectedEventId: null as string | null,
    resultCode: 'EMPTY',
    resultMessage: '尚未加载历史回放。',
    requestEpoch: 0,
    localSnapshot: null as LocalReplaySnapshot | null,
  }),

  actions: {
    /**
     * 读取本机文件回放快照；true 为已加载，null 为未配置，false 为读取失败。
     * 未配置时显示空态，读取失败显示错误，页面不回退演示数据。
     */
    async loadLocalFile(archiveId?: string): Promise<boolean | null> {
      this.resetToSafeEmpty()
      const epoch = this.requestEpoch
      const request = new AbortController()
      runtimeFor(this).fileRequest = request
      const timeout = setTimeout(() => request.abort(), 10_000)
      this.state = 'LOADING'
      try {
        const path = archiveId === undefined ? 'replays/local-file' : `archives/${encodeURIComponent(archiveId)}`
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/${path}`, {
          headers: { 'X-Demo-Role': useAuthStore().role }, signal: request.signal,
        })
        const archived = archiveId === undefined ? null : await readSuccess(response, isLocalArchiveSnapshot)
        if (archived && archived.record.archiveId !== archiveId) throw new Error('归档来源与请求不一致。')
        const snapshot = archived ? archived.replay : await readSuccess(response, isLocalReplaySnapshot)
        if (epoch !== this.requestEpoch) return false
        if (snapshot === null) {
          this.state = 'EMPTY'
          return null
        }
        this.localSnapshot = markRaw(snapshot)
        // 只供既有时间轴使用的本地游标，不代表 mission 引擎运行，不发送到 Mock 命令接口。
        this.replay = { replayId: 'REPLAY-LOCAL-FILE', runId: 'RUN-LOCAL-FILE', state: 'PAUSED',
          durationS: snapshot.durationS, currentTimeS: 0, eventIds: [] }
        this.state = 'PAUSED'
        this.resultCode = 'SUCCESS'
        this.resultMessage = '真实文件回放已加载；重新加载可读取新增记录。'
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.showError(error)
        return false
      } finally {
        clearTimeout(timeout)
        if (runtimeFor(this).fileRequest === request) runtimeFor(this).fileRequest = null
      }
    },

    /**
     * 加载回放目录、REPLAY-001 详情和 RUN-001 事件。
     * @returns 三份响应及交叉引用有效时返回 `true`；空目录进入 EMPTY。
     */
    async load(): Promise<boolean> {
      this.localSnapshot = null
      const epoch = ++this.requestEpoch
      this.stopPlaybackTimer()
      runtimeFor(this).pendingCommand = null
      this.state = 'LOADING'
      try {
        const listResponse = await apiFetch(`${resolveMockOrigin()}/api/v1/replays`, {
          headers: { 'X-Demo-Role': useAuthStore().role },
        })
        const replays = await readSuccess(listResponse, (value): value is Replay[] => Array.isArray(value) && value.every(isReplay))
        if (epoch !== this.requestEpoch) return false
        if (replays.length === 0) {
          this.resetToSafeEmpty()
          return true
        }
        const listed = replays[0]!
        const detailResponse = await apiFetch(`${resolveMockOrigin()}/api/v1/replays/${encodeURIComponent(listed.replayId)}`, {
          headers: { 'X-Demo-Role': useAuthStore().role },
        })
        const replay = await readSuccess(detailResponse, isReplay)
        if (epoch !== this.requestEpoch) return false
        const telemetry = useTelemetryStore()
        let events = telemetry.frame?.runId === listed.runId
          ? telemetry.events.map((event) => ({ ...event })) as ReplayEvent[]
          : undefined
        if (events === undefined) {
          const eventsResponse = await apiFetch(`${resolveMockOrigin()}/api/v1/simulations/${encodeURIComponent(listed.runId)}/events`, {
            headers: { 'X-Demo-Role': useAuthStore().role },
          })
          events = await readSuccess(eventsResponse, (value): value is ReplayEvent[] => Array.isArray(value) && value.every(isSituationEvent))
        }
        if (epoch !== this.requestEpoch) return false
        const eventsById = new Map(events.map((event) => [event.eventId, event]))
        if (replay.replayId !== listed.replayId || replay.runId !== listed.runId
          || eventsById.size !== events.length
          || replay.eventIds.some((eventId) => !eventsById.has(eventId))) {
          throw new TypeError('回放与运行事件引用不一致。')
        }
        const replayEvents = replay.eventIds.map((eventId) => eventsById.get(eventId)!)
        this.replays = structuredClone(replays)
        this.replay = structuredClone(replay)
        this.events = structuredClone(replayEvents).sort((left, right) => replayEventTime(left) - replayEventTime(right))
        this.state = replay.state
        this.selectedEventId = this.events.slice().reverse().find((event) => replayEventTime(event) <= replay.currentTimeS)?.eventId
          ?? null
        this.resultCode = 'SUCCESS'
        this.resultMessage = '历史回放已加载。'
        if (this.state === 'PLAYING') this.startPlaybackTimer()
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.showError(error)
        return false
      }
    },

    /** 播放当前回放并启动服务端游标推进计时器。 */
    async play(): Promise<boolean> {
      return this.executeCommand({ command: 'PLAY' })
    },

    /** 暂停当前回放并停止游标计时器。 */
    async pause(): Promise<boolean> {
      this.stopPlaybackTimer()
      return this.executeCommand({ command: 'PAUSE' })
    },

    /**
     * 将回放定位到指定秒数。
     * @param seconds 从回放起点计算的目标秒数。
     */
    async seek(seconds: number): Promise<boolean> {
      this.stopPlaybackTimer()
      if (this.state === 'PLAYING' && !await this.executeCommand({ command: 'PAUSE' })) return false
      return this.executeCommand({ command: 'SEEK', value: seconds })
    },

    /**
     * 将回放单步前进或后退一秒。
     * @param direction 前进或后退方向。
     */
    async step(direction: 'forward' | 'back'): Promise<boolean> {
      this.stopPlaybackTimer()
      return this.executeCommand({ command: direction === 'forward' ? 'STEP_FORWARD' : 'STEP_BACK' })
    },

    /**
     * 设置正数回放倍速。
     * @param speed 新倍速；服务端校验通过后才应用。
     */
    async setSpeed(speed: number): Promise<boolean> {
      const succeeded = await this.executeCommand({ command: 'SPEED', value: speed })
      if (succeeded) this.speed = speed
      return succeeded
    },

    /**
     * 发送回放命令并原子应用服务端投影。
     * @param command 已按调用方法构造的回放命令。
     */
    async executeCommand(command: ReplayCommand): Promise<boolean> {
      if (this.replay === null) return false
      if (this.localSnapshot !== null) return this.executeLocalCommand(command)
      // 新控制优先于旧响应；自动 SEEK 不抢占正在执行的手动控制。
      const epoch = ++this.requestEpoch
      const runtime = runtimeFor(this)
      runtime.pendingCommand = epoch
      if (command.command === 'SEEK' && this.state !== 'PLAYING') this.state = 'SEEKING'
      try {
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/replays/${encodeURIComponent(this.replay.replayId)}/commands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': useAuthStore().role },
          body: JSON.stringify(command),
        })
        if (epoch !== this.requestEpoch) return false
        const replay = await readSuccess(response, isReplay)
        if (epoch !== this.requestEpoch) return false
        if (replay.replayId !== this.replay.replayId || replay.runId !== this.replay.runId) {
          throw new TypeError('回放命令结果与当前来源不一致。')
        }
        this.replay = structuredClone(replay)
        this.state = replay.state
        this.selectEventAtCursor()
        this.resultCode = 'SUCCESS'
        this.resultMessage = '回放状态已更新。'
        // SPEED 也可能先返回 PLAYING，由最新有效投影统一维护计时器。
        if (this.state !== 'PLAYING') this.stopPlaybackTimer()
        else if (runtime.timer === null) this.startPlaybackTimer()
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.showError(error)
        return false
      } finally {
        if (runtime.pendingCommand === epoch) runtime.pendingCommand = null
      }
    },

    /**
     * 操作文件回放的本地游标，不调用真实引擎或 Mock 命令接口。
     * @param command 复用页面已有的播放、暂停、定位、单步及倍速操作。
     */
    executeLocalCommand(command: ReplayCommand): boolean {
      const replay = this.replay
      if (!replay || !this.localSnapshot) return false
      if ((command.command === 'SEEK' && (!Number.isFinite(command.value) || command.value! < 0 || command.value! > replay.durationS))
        || (command.command === 'SPEED' && (!Number.isFinite(command.value) || command.value! <= 0))) {
        this.resultMessage = '回放时间或倍速超出有效范围。'
        return false
      }
      if (command.command === 'PLAY') {
        if (replay.durationS === 0) return false
        if (replay.currentTimeS === replay.durationS) replay.currentTimeS = 0
        replay.state = 'PLAYING'
      } else if (command.command === 'PAUSE') replay.state = 'PAUSED'
      else if (command.command === 'SPEED') this.speed = command.value!
      else if (command.command === 'SEEK') {
        replay.currentTimeS = command.value!
        replay.state = replay.currentTimeS === replay.durationS ? 'COMPLETED'
          : this.state === 'PLAYING' ? 'PLAYING' : 'PAUSED'
      } else if (command.command === 'STEP_FORWARD' || command.command === 'STEP_BACK') {
        replay.currentTimeS = Math.min(replay.durationS, Math.max(0,
          replay.currentTimeS + (command.command === 'STEP_FORWARD' ? 1 : -1)))
        replay.state = replay.currentTimeS === replay.durationS ? 'COMPLETED' : 'PAUSED'
      } else return false
      this.state = replay.state
      if (this.state === 'PLAYING') this.startPlaybackTimer()
      else this.stopPlaybackTimer()
      return true
    },

    /** 每秒按倍速推进游标；真实文件只操作本地状态，Mock 继续使用服务端命令。 */
    startPlaybackTimer(): void {
      this.stopPlaybackTimer()
      if (this.state !== 'PLAYING' || this.replay === null) return
      runtimeFor(this).timer = setInterval(() => { void this.advancePlayback() }, 1_000)
    },

    /** 按当前倍速推进游标，到达末尾时进入 COMPLETED。 */
    async advancePlayback(): Promise<void> {
      if (this.replay === null || this.state !== 'PLAYING' || runtimeFor(this).pendingCommand !== null) return
      const nextTime = Math.min(this.replay.durationS, this.replay.currentTimeS + this.speed)
      if (!await this.executeCommand({ command: 'SEEK', value: nextTime })) return
      if (nextTime === this.replay.durationS) this.stopPlaybackTimer()
    },

    /** 选择不晚于当前游标的最近事件。 */
    selectEventAtCursor(): void {
      if (this.replay === null) return
      this.selectedEventId = this.events.slice().reverse().find((event) => replayEventTime(event) <= this.replay!.currentTimeS)?.eventId
        ?? null
    },

    /** 清除当前 Store 实例的播放计时器。 */
    stopPlaybackTimer(): void {
      const runtime = runtimeFor(this)
      if (runtime.timer !== null) clearInterval(runtime.timer)
      runtime.timer = null
    },

    /** 将异常分为损坏数据和服务错误，并清空旧回放内容。 */
    showError(error: unknown): void {
      const failure = readApiFailure(error)
      this.stopPlaybackTimer()
      this.replays = []
      this.replay = null
      this.localSnapshot = null
      this.events = []
      this.selectedEventId = null
      this.state = error instanceof TypeError ? 'CORRUPT' : 'ERROR'
      this.resultCode = failure?.error.code ?? (this.state === 'CORRUPT' ? 'CORRUPT_FIXTURE' : 'REPLAY_ERROR')
      this.resultMessage = failure?.error.message ?? (error instanceof Error ? error.message : '历史回放加载失败。')
    },

    /** 停止计时器并恢复安全空态。 */
    resetToSafeEmpty(): void {
      this.requestEpoch += 1
      this.stopPlaybackTimer()
      runtimeFor(this).pendingCommand = null
      runtimeFor(this).fileRequest?.abort()
      runtimeFor(this).fileRequest = null
      this.replays = []
      this.replay = null
      this.localSnapshot = null
      this.events = []
      this.state = 'EMPTY'
      this.speed = 1
      this.selectedEventId = null
      this.resultCode = 'EMPTY'
      this.resultMessage = '尚未加载历史回放。'
    },
  },
})

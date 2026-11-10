import { createWebSocketStream, WebSocket } from 'ws'
import type { EngineConnectionDiagnostic, EngineControlAction, EngineControlState, EngineFrameSnapshot, EnginePathNode, EngineRoute, SimulationRun } from '../../src/contracts/domain-models.js'
import { adaptEngineFrameSnapshot, ENGINE_FRAME_ID_STEP } from '../../src/features/data-exchange/engine-frame-snapshot.js'
import { canSendEngineControl } from '../../src/features/situation/engine-control.js'
import { engineNameMap, toScenarioId } from './engine-name-mapping.js'

const BACKOFF_MS = [1000, 2000, 5000, 10000] as const
const routeKey = (route: EngineRoute, pathId = route.pathId) => JSON.stringify([route.direction, route.sourceName, route.targetName, pathId])

function describeInvalidField(input: object, fieldPath: string): string {
  let value: unknown = input
  let present = true
  for (const key of fieldPath.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      value = undefined; present = false; break
    }
    value = (value as Record<string, unknown>)[key]
  }
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  let raw: string
  try { raw = typeof value === 'number' ? String(value) : JSON.stringify(value) ?? 'undefined' }
  catch { raw = '[无法序列化]' }
  // 只输出失败字段的有界预览，JSON 转义保留字符串空白而不伪造日志换行。
  return `原始值=${raw.slice(0, 256)}${raw.length > 256 ? '…（已截断）' : ''}，数据类型=${type}${present ? '' : '（字段缺失）'}`
}

export function readLinkEngineWsUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('LINK_ENGINE_WS_URL 必须为完整的 ws:// 或 wss:// 地址。') }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('LINK_ENGINE_WS_URL 只允许不含凭据或片段的 WebSocket 地址。')
  return url.href
}

/** 使用本次执行包的实例名和端口映射；同一段可属于多条场景链路。 */
function frameBinder(manifest: unknown): (frame: EngineFrameSnapshot) => void {
  const names = engineNameMap(manifest)
  const id = (name: string | null) => name === null ? null : toScenarioId(names, name)
  const segments = new Map<string, string[]>()
  const key = (source: unknown, sourcePort: unknown, target: unknown, targetPort: unknown) => JSON.stringify([source, sourcePort, target, targetPort])
  const devices = manifest && typeof manifest === 'object' && 'devices' in manifest && Array.isArray(manifest.devices) ? manifest.devices : []
  for (const device of devices) {
    if (!device || typeof device.linkId !== 'string' || !device.source || !device.target) continue
    const add = (source: string, sourcePort: string, target: string, targetPort: string) => {
      if (![source, sourcePort, target, targetPort].every(value => typeof value === 'string' && value.length)) return
      const identity = key(id(source), sourcePort, id(target), targetPort)
      segments.set(identity, [...new Set([...(segments.get(identity) ?? []), device.linkId])])
    }
    if (device.relayPlatformId && device.relayDeviceId) {
      add(device.source.platformId, device.source.deviceId, device.relayPlatformId, device.relayDeviceId)
      add(device.relayPlatformId, device.relayDeviceId, device.target.platformId, device.target.deviceId)
    } else add(device.source.platformId, device.source.deviceId, device.target.platformId, device.target.deviceId)
  }
  const bindNodes = (nodes: EnginePathNode[]) => nodes.forEach(node => { node.platformId = id(node.platformName) })
  const bindRoute = (route: EngineRoute) => {
    route.sourcePlatformId = id(route.sourceName); route.targetPlatformId = id(route.targetName); bindNodes(route.nodes)
  }
  return frame => {
    for (const link of frame.links) {
      link.sourcePlatformId = id(link.sourceName); link.targetPlatformId = id(link.targetName)
      link.linkIds = [...(segments.get(key(link.sourcePlatformId, link.sourcePort, link.targetPlatformId, link.targetPort)) ?? [])]
      for (const jammer of link.inputTrace.jammers) jammer.platformId = id(jammer.jammerName)
    }
    for (const jammer of frame.jammers) {
      jammer.platformId = id(jammer.name)
      for (const detection of jammer.detections) {
        detection.targetIds = detection.targetNames.map(name => toScenarioId(names, name))
        detection.targets.forEach(target => { target.platformId = id(target.name) })
      }
      jammer.actions.forEach(action => { action.targetPlatformId = id(action.targetName) })
    }
    frame.initRouting?.forEach(bindRoute)
    frame.routing.switches.forEach(route => { bindRoute(route); bindNodes(route.oldNodes) })
    frame.events.forEach(event => {
      event.uavIds = event.uavNames.map(name => toScenarioId(names, name))
      event.jammerIds = event.jammerNames.map(name => toScenarioId(names, name))
    })
  }
}

/** 一个服务只绑定一个真实运行；外部帧不能声明或切换当前 task/run。 */
export class EngineSnapshotClient {
  private owner: Pick<SimulationRun, 'runId' | 'taskId'> | undefined
  private socket: WebSocket | undefined
  private incoming: ReturnType<typeof createWebSocketStream> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private retry = 0
  private control: Pick<EngineControlState, 'action' | 'delivery'> = { action: null, delivery: 'IDLE' }
  private cancelControl: (() => void) | undefined
  private lastFrameId = -1
  private engineEpoch = 0
  private initRouting: EngineFrameSnapshot['initRouting'] = null
  private readonly routeHistory = new Map<string, EnginePathNode[]>()
  private readonly discardLogs = new Map<string, { count: number; loggedAt: number }>()
  readonly diagnostics = { rejected: 0, stale: 0, lastError: '', connected: false }

  constructor(private readonly url: string, private readonly publish: (runId: SimulationRun['runId'], frame: EngineFrameSnapshot) => void | Promise<void>,
    private readonly report: (message: string) => void = message => console.warn(message),
    private readonly diagnose: (run: Pick<SimulationRun, 'runId' | 'taskId'>, diagnostic: EngineConnectionDiagnostic) => void = () => {}) {}

  start(run: Pick<SimulationRun, 'runId' | 'taskId'>, manifest: unknown): boolean {
    if (this.owner) {
      if (this.owner.runId === run.runId && this.owner.taskId === run.taskId) return true
      this.report('引擎链路推送只支持单任务运行')
      return false
    }
    let bind: ReturnType<typeof frameBinder>
    try { bind = frameBinder(manifest) } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.diagnostics.rejected += 1
      this.diagnostics.lastError = message
      this.report(`引擎帧已丢弃（场景映射无效，累计 ${this.diagnostics.rejected}）：${message}`)
      this.diagnose(run, { kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: run.runId, state: 'REJECTED', message: `已拒绝上游引擎接入（场景映射无效）：${message}` })
      return false
    }
    this.owner = { runId: run.runId, taskId: run.taskId }
    this.control = { action: null, delivery: 'IDLE' }
    this.lastFrameId = -1; this.engineEpoch = 0; this.initRouting = null; this.retry = 0
    this.routeHistory.clear()
    this.discardLogs.clear()
    Object.assign(this.diagnostics, { rejected: 0, stale: 0, lastError: '', connected: false })
    const generation = ++this.generation
    const current = () => generation === this.generation && this.owner?.runId === run.runId
    const connect = () => {
      if (!current()) return
      this.timer = undefined
      this.diagnose(run, { kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: run.runId, state: 'CONNECTING', message: '正在连接上游引擎 WebSocket。' })
      const socket = this.socket = new WebSocket(this.url, { handshakeTimeout: 10_000, maxPayload: 4 * 1024 * 1024 })
      // Preserve message boundaries and stop reading the socket while disk writes catch up.
      const incoming = this.incoming = createWebSocketStream(socket, { readableObjectMode: true, highWaterMark: 1 })
      let firstFrame = true
      socket.on('open', () => {
        if (!current()) return
        this.diagnostics.connected = true
        this.diagnose(run, { kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: run.runId, state: 'CONNECTED', message: '已连接上游引擎 WebSocket。' })
      })
      const receive = async (raw: string | Buffer) => {
        if (!current()) return
        let reason = 'JSON 格式错误'
        try {
          if (typeof raw !== 'string') throw new Error('引擎帧必须为 JSON 文本。')
          const input: unknown = JSON.parse(raw.toString())
          reason = '消息类型错误'
          if (!input || typeof input !== 'object' || !('msg_type' in input) || input.msg_type !== 'frame_snapshot') throw new Error('引擎消息类型不是 frame_snapshot。')
          reason = '帧头无效'
          const adapted = adaptEngineFrameSnapshot(input)
          if (!adapted.data) throw new Error(adapted.errors.map(error => `${error.fieldPath}：${error.message}（${describeInvalidField(input, error.fieldPath)}）`).join('；'))
          const frame = adapted.data
          // 初次连接 lastFrameId 为 -1；坏消息不消耗重连后的首个有效帧判断。
          const restarted = (frame.frameId === 0 && this.lastFrameId > 0) || (firstFrame && frame.frameId < this.lastFrameId)
          firstFrame = false
          if (restarted) {
            this.engineEpoch += 1; this.lastFrameId = -1; this.initRouting = null
            this.routeHistory.clear()
          }
          if (frame.frameId <= this.lastFrameId) {
            this.diagnostics.stale += 1
            this.logDiscard('帧号重复或倒退', `engineEpoch=${this.engineEpoch}，frameId=${frame.frameId}，上一帧=${this.lastFrameId}`)
            return
          }
          if (this.lastFrameId >= 0 && frame.frameId !== this.lastFrameId + ENGINE_FRAME_ID_STEP) {
            this.diagnose(run, {
              kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: run.runId, state: 'FRAME_ADVANCE_OBSERVED',
              previousFrameId: this.lastFrameId, observedFrameId: frame.frameId,
              message: `上游帧号由 ${this.lastFrameId} 变为 ${frame.frameId}；与约定步长 ${ENGINE_FRAME_ID_STEP}（5 秒）不一致，仅记录帧号间隔异常，不推定上游补发能力。`,
            })
          }
          reason = '帧处理失败'
          bind(frame)
          frame.runId = run.runId
          frame.engineEpoch = this.engineEpoch
          for (const route of frame.initRouting ?? []) this.rememberRoute(route)
          for (const route of frame.routing.switches) {
            if (!route.oldNodes.length && route.oldPathId) route.oldNodes = structuredClone(this.routeHistory.get(routeKey(route, route.oldPathId)) ?? [])
            this.rememberRoute(route)
          }
          if (frame.initRouting !== null) this.initRouting = structuredClone(frame.initRouting)
          frame.initRouting = structuredClone(this.initRouting)
          await this.publish(run.runId, frame)
          if (!current()) return
          this.lastFrameId = frame.frameId
          this.retry = 0
        } catch (error) { if (current()) this.reject(error, reason) }
      }
      socket.on('error', error => {
        if (!current()) return
        this.cancelControl?.()
        if (this.control.action) this.control.delivery = 'UNKNOWN'
        this.diagnostics.lastError = error.message
        this.report(`引擎链路推送连接失败：${error.message}`)
        this.diagnose(run, { kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: run.runId, state: 'DISCONNECTED', message: `上游引擎连接错误：${error.message}` })
      })
      socket.on('close', () => {
        if (!current()) return
        this.cancelControl?.()
        if (this.control.action) this.control.delivery = 'UNKNOWN'
        this.socket = undefined; this.diagnostics.connected = false
        this.diagnose(run, { kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: run.runId, state: 'DISCONNECTED', message: '上游引擎 WebSocket 已断开，正在按退避策略重连。' })
      })
      void (async () => {
        try { for await (const raw of incoming) { if (!current()) break; await receive(raw) } }
        catch { /* socket error handler publishes the connection diagnostic */ }
        finally {
          incoming.destroy()
          if (current()) this.timer = setTimeout(connect, BACKOFF_MS[Math.min(this.retry++, BACKOFF_MS.length - 1)])
        }
      })()
    }
    connect()
    return true
  }

  controlState(runId: string): EngineControlState | undefined {
    if (this.owner?.runId !== runId) return undefined
    return { connected: this.socket?.readyState === WebSocket.OPEN, ...this.control }
  }

  async sendControl(runId: string, action: EngineControlAction): Promise<void> {
    const state = this.controlState(runId), socket = this.socket, generation = this.generation
    if (!['pause', 'resume', 'stop'].includes(action) || !state || !socket || !canSendEngineControl(state, action)) {
      throw new Error('引擎连接、运行归属或控制发送状态不允许此操作；未发送命令。')
    }
    this.control = { action, delivery: 'SENDING' }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.cancelControl = undefined
        const sameRun = this.generation === generation && this.owner?.runId === runId
        const failure = error ?? (!sameRun || this.socket !== socket || socket.readyState !== WebSocket.OPEN
          ? new Error('控制发送期间引擎连接或运行已改变。') : undefined)
        if (sameRun) this.control = { action, delivery: failure ? 'UNKNOWN' : 'SENT' }
        if (failure) reject(new Error(`${failure.message} 控制发送结果待核实，不自动重发。`))
        else resolve()
      }
      const timer = setTimeout(() => finish(new Error('引擎控制发送超时。')), 3_000)
      this.cancelControl = () => finish(new Error('引擎控制发送连接已关闭。'))
      // shortcut: 后台尚未确认回执，send 回调仅证明写入连接；接入真实回执后再确认运行状态。
      try { socket.send(JSON.stringify({ msg_type: 'sim_control', action }), finish) }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  private logDiscard(reason: string, message: string): void {
    const log = this.discardLogs.get(reason) ?? { count: 0, loggedAt: -Infinity }
    log.count += 1
    this.discardLogs.set(reason, log)
    const now = Date.now()
    if (now - log.loggedAt < 10_000) return
    log.loggedAt = now
    this.report(`引擎帧已丢弃（${reason}，累计 ${log.count}）：${message}`)
  }

  private rememberRoute(route: EngineRoute): void {
    if (!route.nodes.length) return
    const key = routeKey(route)
    this.routeHistory.delete(key)
    this.routeHistory.set(key, structuredClone(route.nodes))
    // shortcut: 只恢复本次运行最近 1024 条已收到路径；缺失历史等待上游补发，不猜旧路径。
    if (this.routeHistory.size > 1024) this.routeHistory.delete(this.routeHistory.keys().next().value!)
  }

  private reject(error: unknown, reason = '帧处理失败'): void {
    this.diagnostics.rejected += 1
    this.diagnostics.lastError = error instanceof Error ? error.message : String(error)
    this.logDiscard(reason, this.diagnostics.lastError)
    if (this.owner) this.diagnose(this.owner, {
      kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: this.owner.runId, state: 'REJECTED',
      message: `已拒绝上游引擎数据（${reason}）：${this.diagnostics.lastError}`,
    })
  }

  stop(runId?: string): void {
    if (runId !== undefined && runId !== this.owner?.runId) return
    this.cancelControl?.()
    ++this.generation
    clearTimeout(this.timer); this.timer = undefined
    const socket = this.socket
    this.incoming?.destroy(); this.incoming = undefined
    this.socket = undefined; this.owner = undefined; this.diagnostics.connected = false
    this.lastFrameId = -1; this.engineEpoch = 0; this.initRouting = null
    this.routeHistory.clear()
    if (socket) {
      // CONNECTING 时终止也会异步发出 error；等 close 后再移除最后的保护监听。
      socket.on('error', () => {})
      socket.once('close', () => socket.removeAllListeners())
      socket.terminate()
    }
  }
}

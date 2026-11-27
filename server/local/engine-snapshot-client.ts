import { createWebSocketStream, WebSocket } from 'ws'
import type { Socket } from 'node:net'
import { isMissionWebSocketPeer } from './mission-process-inspection.js'
import { createMissionConnectionLog } from './mission-startup-diagnostics.js'
import type { EngineConnectionDiagnostic, EngineControlAction, EngineControlState, EngineFrameSnapshot, EnginePathNode, EngineRoute, SimulationRun } from '../../src/contracts/domain-models.js'
import { adaptEngineFrameSnapshot, ENGINE_FRAME_ID_STEP } from '../../src/features/data-exchange/engine-frame-snapshot.js'
import { canSendEngineControl } from '../../src/features/situation/engine-control.js'
import { engineNameMap, toScenarioId } from './engine-name-mapping.js'

const BACKOFF_MS = [1000, 1000, 1000, 2000, 5000, 10000] as const
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
  const directFallback = new Map<string, string[]>()
  const key = (source: unknown, sourcePort: unknown, target: unknown, targetPort: unknown) => JSON.stringify([source, sourcePort, target, targetPort])
  const devices = manifest && typeof manifest === 'object' && 'devices' in manifest && Array.isArray(manifest.devices) ? manifest.devices : []
  for (const device of devices) {
    if (!device || typeof device.linkId !== 'string' || !device.source || !device.target) continue
    const add = (bucket: Map<string, string[]>, source: string, sourcePort: string, target: string, targetPort: string) => {
      if (![source, sourcePort, target, targetPort].every(value => typeof value === 'string' && value.length)) return
      const identity = key(id(source), sourcePort, id(target), targetPort)
      bucket.set(identity, [...new Set([...(bucket.get(identity) ?? []), device.linkId])])
    }
    if (device.relayPlatformId && device.relayDeviceId) {
      add(segments, device.source.platformId, device.source.deviceId, device.relayPlatformId, device.relayDeviceId)
      add(segments, device.relayPlatformId, device.relayDeviceId, device.target.platformId, device.target.deviceId)
      // 引擎在直连模式下可能绕过配置中继，此时兜底按端到端端口绑定原链路 ID
      add(directFallback, device.source.platformId, device.source.deviceId, device.target.platformId, device.target.deviceId)
    } else add(segments, device.source.platformId, device.source.deviceId, device.target.platformId, device.target.deviceId)
  }
  const bindNodes = (nodes: EnginePathNode[]) => nodes.forEach(node => { node.platformId = id(node.platformName) })
  const bindRoute = (route: EngineRoute) => {
    route.sourcePlatformId = id(route.sourceName); route.targetPlatformId = id(route.targetName); bindNodes(route.nodes)
  }
  return frame => {
    for (const link of frame.links) {
      link.sourcePlatformId = id(link.sourceName); link.targetPlatformId = id(link.targetName)
      const identity = key(link.sourcePlatformId, link.sourcePort, link.targetPlatformId, link.targetPort)
      link.linkIds = [...(segments.get(identity) ?? directFallback.get(identity) ?? [])]
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
  private localMissionPid: number | undefined
  private localControlSocket: WebSocket | undefined
  private hasVerifiedLocalPeer = false
  private incoming: ReturnType<typeof createWebSocketStream> | undefined
  private consumer?: Promise<void>
  private finishing = false
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
    private readonly diagnose: (run: Pick<SimulationRun, 'runId' | 'taskId'>, diagnostic: EngineConnectionDiagnostic) => void = () => {},
    private readonly verifyMissionPeer = isMissionWebSocketPeer) {}

  start(run: Pick<SimulationRun, 'runId' | 'taskId'>, manifest: unknown, localMissionPid?: number, reportStartup = this.report): boolean {
    if (this.owner) {
      if (this.owner.runId === run.runId && this.owner.taskId === run.taskId && this.localMissionPid === localMissionPid) return true
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
    this.localMissionPid = localMissionPid
    this.control = { action: null, delivery: 'IDLE' }
    this.lastFrameId = -1; this.engineEpoch = 0; this.initRouting = null; this.retry = 0
    this.routeHistory.clear()
    this.discardLogs.clear()
    Object.assign(this.diagnostics, { rejected: 0, stale: 0, lastError: '', connected: false })
    const generation = ++this.generation
    const current = () => generation === this.generation && this.owner?.runId === run.runId
    const endpoint = new URL(this.url)
    const displayUrl = endpoint.origin + endpoint.pathname
    const logMission = localMissionPid === undefined ? undefined
      : createMissionConnectionLog(run, localMissionPid, endpoint, reportStartup, () => current() && !this.finishing)
    let attempts = 0
    const connect = () => {
      if (!current()) return
      this.timer = undefined
      const attempt = ++attempts
      logMission?.(attempt, attempt === 1 ? '开始连接' : '开始重试 WebSocket')
      this.diagnose(run, { kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: run.runId, state: 'CONNECTING', message: `正在连接上游引擎 WebSocket（${displayUrl}）。` })
      const socket = this.socket = new WebSocket(this.url, { handshakeTimeout: 10_000, maxPayload: 4 * 1024 * 1024 })
      let socketFailed = false
      let waitTimer: ReturnType<typeof setTimeout> | undefined
      const watchStartup = (message: string) => {
        clearTimeout(waitTimer)
        if (!logMission) return
        const waiting = () => {
          if (!current() || this.finishing || this.socket !== socket) return
          logMission(attempt, message, {}, true)
          // 刚重连时前一次失败采样可能仍在限频窗口，持续等首帧时重新检查。
          waitTimer = setTimeout(waiting, 10_000).unref()
        }
        waitTimer = setTimeout(waiting, 5_000).unref()
      }
      watchStartup('仍在等待 WebSocket 握手')
      // Preserve message boundaries and stop reading the socket while disk writes catch up.
      const incoming = this.incoming = createWebSocketStream(socket, { readableObjectMode: true, highWaterMark: 1 })
      let firstFrame = true
      // shortcut: 当前插件两包连续发送，只缓存同连接的一帧；若跨帧交错发送，再扩为有界多帧缓存。
      let pending: { frameId: number; input: Record<string, unknown> } | undefined
      let peer: Socket | undefined
      if (localMissionPid !== undefined) socket.once('upgrade', response => { peer = response.socket })
      socket.on('open', async () => {
        if (!current() || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
        this.diagnostics.connected = true
        logMission?.(attempt, 'WebSocket 已连接')
        watchStartup('已连接，仍在等待首个完整帧')
        this.diagnose(run, { kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: run.runId, state: 'CONNECTED', message: `已连接上游引擎 WebSocket（${displayUrl}）。` })
        if (peer && localMissionPid !== undefined) {
          let owned = false
          try { owned = await this.verifyMissionPeer(peer, localMissionPid) }
          catch { /* 无法确认对端时仍可接收数据。 */ }
          if (!current() || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
          if (owned) {
            this.localControlSocket = socket
            this.hasVerifiedLocalPeer = true
            this.diagnose(run, { kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: run.runId, state: 'CONNECTED', message: '已确认本机仿真控制通道。' })
          }
        }
      })
      const receive = async (raw: string | Buffer) => {
        if (!current()) return
        let reason = 'JSON 格式错误'
        try {
          if (typeof raw !== 'string') throw new Error('引擎帧必须为 JSON 文本。')
          let input: unknown = JSON.parse(raw.toString())
          reason = '消息类型错误'
          if (!input || typeof input !== 'object' || !('msg_type' in input) || input.msg_type !== 'frame_snapshot') throw new Error('引擎消息类型不是 frame_snapshot。')
          reason = '帧头无效'
          let adapted = adaptEngineFrameSnapshot(input)
          const part = input as Record<string, unknown>
          const calcPart = Object.hasOwn(part, 'link_calc') && Object.hasOwn(part, 'jammer_params')
            && !Object.hasOwn(part, 'link_manager') && !Object.hasOwn(part, 'events')
          const routePart = !Object.hasOwn(part, 'link_calc') && Object.hasOwn(part, 'link_manager') && Object.hasOwn(part, 'events')
          const partFrame = routePart ? adaptEngineFrameSnapshot({ ...part, link_calc: { links: [] } }).data : adapted.data
          if ((calcPart || routePart) && partFrame) {
            if (pending && pending.frameId !== partFrame.frameId) {
              if (partFrame.frameId < pending.frameId && partFrame.frameId !== 0) {
                this.logDiscard('分包帧号倒退', `frameId=${partFrame.frameId}，等待帧=${pending.frameId}`)
                return
              }
              this.reject(new Error(`frameId=${pending.frameId} 缺少配对分包，未发布不完整帧。`), '分包不完整')
              pending = undefined
            }
            if (!pending) { pending = { frameId: partFrame.frameId, input: part }; return }
            if (Object.hasOwn(pending.input, 'link_calc') === calcPart) {
              this.logDiscard('重复分包', `frameId=${partFrame.frameId}`)
              return
            }
            input = { ...pending.input, ...part }
            pending = undefined
            adapted = adaptEngineFrameSnapshot(input)
          } else if (adapted.data) {
            // 完整重发帧可替代尚未配对的同帧分包。
            if (pending && pending.frameId !== adapted.data.frameId) this.reject(new Error(`frameId=${pending.frameId} 缺少配对分包。`), '分包不完整')
            pending = undefined
          }
          if (!adapted.data) throw new Error(adapted.errors.map(error => `${error.fieldPath}：${error.message}（${describeInvalidField(input as object, error.fieldPath)}）`).join('；'))
          const frame = adapted.data
          // 初次连接 lastFrameId 为 -1；坏消息不消耗重连后的首个有效帧判断。
          const restarted = (frame.frameId === 0 && this.lastFrameId > 0) || (firstFrame && frame.frameId < this.lastFrameId)
          if (firstFrame) {
            clearTimeout(waitTimer)
            logMission?.(attempt, '已收到首个完整帧')
          }
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
        socketFailed = true
        this.cancelControl?.()
        if (this.control.action) this.control.delivery = 'UNKNOWN'
        const detail = error instanceof AggregateError && error.errors.length
          ? error.errors.slice(0, 4).map(cause => cause instanceof Error ? cause.message : String(cause)).join(' | ') : error.message
        const code = (error as NodeJS.ErrnoException).code
        const message = (detail || code || error.name).replaceAll(this.url, displayUrl).slice(0, 1024)
        this.diagnostics.lastError = message
        if (logMission) logMission(attempt, '引擎链路推送连接失败', { code: code ?? null, error: message }, true)
        else this.report(`引擎链路推送连接失败：${message}`)
        this.diagnose(run, { kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: run.runId, state: 'DISCONNECTED', message: `上游引擎连接错误：${message}` })
      })
      socket.on('close', (code, reason) => {
        clearTimeout(waitTimer)
        if (!current()) return
        if (!socketFailed) logMission?.(attempt, 'WebSocket 已关闭', { code, reason: reason.toString().replaceAll(this.url, displayUrl).slice(0, 256) }, firstFrame)
        this.cancelControl?.()
        if (this.control.action) this.control.delivery = 'UNKNOWN'
        this.localControlSocket = undefined
        this.socket = undefined; this.diagnostics.connected = false
        this.diagnose(run, { kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId: run.runId, state: 'DISCONNECTED', message: '上游引擎 WebSocket 已断开，正在按退避策略重连。' })
      })
      this.consumer = (async () => {
        try { for await (const raw of incoming) { if (!current()) break; await receive(raw) } }
        catch { /* socket error handler publishes the connection diagnostic */ }
        finally {
          if (current() && pending) this.reject(new Error(`frameId=${pending.frameId} 在断连前未收到配对分包。`), '分包不完整')
          pending = undefined
          incoming.destroy()
          if (current() && !this.finishing) this.timer = setTimeout(connect, BACKOFF_MS[Math.min(this.retry++, BACKOFF_MS.length - 1)])
        }
      })()
    }
    connect()
    return true
  }

  controlState(runId: string): EngineControlState | undefined {
    const localMission = this.localMissionPid !== undefined
    if (this.owner?.runId !== runId || (localMission && !this.hasVerifiedLocalPeer)) return undefined
    const connected = this.socket?.readyState === WebSocket.OPEN && (!localMission || this.socket === this.localControlSocket)
    return { connected, ...this.control }
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

  /** 进程退出后读完当前连接已收到的消息，慢盘仍按原顺序写入最后一个完整帧。 */
  async drainAndStop(runId: string): Promise<void> {
    if (this.owner?.runId !== runId) return
    const generation = this.generation
    this.finishing = true
    clearTimeout(this.timer)
    if (this.socket?.readyState === WebSocket.CONNECTING) this.socket.terminate()
    else if (this.socket?.readyState === WebSocket.OPEN) this.socket.close()
    await this.consumer
    if (generation === this.generation) this.stop(runId)
  }

  stop(runId?: string): void {
    if (runId !== undefined && runId !== this.owner?.runId) return
    this.cancelControl?.()
    ++this.generation
    clearTimeout(this.timer); this.timer = undefined
    const socket = this.socket
    this.incoming?.destroy(); this.incoming = undefined
    this.consumer = undefined; this.finishing = false
    this.socket = undefined; this.owner = undefined; this.diagnostics.connected = false
    this.localMissionPid = undefined; this.localControlSocket = undefined; this.hasVerifiedLocalPeer = false
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

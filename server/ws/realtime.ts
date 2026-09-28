import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type {
  RealtimeEnvelope,
  FrameId,
  JammerStatusData,
  ResetResult,
  SimulationRun,
  SimulationState,
  TaskId,
  WsRejection,
  WsSubscribeRequest,
  WsTopic,
} from '../../src/contracts/domain-models.js'
import { assertLoopbackRequest, assertLanRequest } from '../http/loopback.js'
import type { MockProjection } from '../state/projection.js'
import { fixedFrameForRun, ownsFixedEvidence } from '../simulations/projection.js'

const CANONICAL_TOPICS = new Set<WsTopic>([
  'simulation.frame',
  'runtime.state',
  'link.metric',
  'jammer.event',
  'switch.event',
])
const MAX_SUBSCRIPTION_BYTES = 16_384
const MAX_TRANSPORT_PAYLOAD_BYTES = 65_536
const MAX_CLIENTS = 64
const MAX_CLIENTS_PER_SOURCE = 8
const HEARTBEAT_MS = 30_000
const MAX_BUFFERED_BYTES = 1_048_576

export interface RealtimeController {
  activeClientCount(): number
  publishRuntimeState(run: SimulationRun): void
  publishJammerStatus(status: JammerStatusData, frameId: FrameId): void
  invalidateForReset(): void
  revalidateSessions(): void
  reset(): ResetResult
  close(): Promise<void>
}

interface SubscriptionAcknowledgement {
  type: 'subscribed'
  schemaVersion: '1.0'
  taskId: TaskId
  topics: WsTopic[]
  lastSequence: number
  nextSequence: number
}

function isDemoRole(value: string | undefined): boolean {
  return value === 'ADMIN' || value === 'OPERATOR'
}

function parseSubscription(data: RawData, isBinary: boolean):
  | { accepted: true; request: WsSubscribeRequest }
  | { accepted: false; code: WsRejection['code']; message: string } {
  const byteLength = Buffer.byteLength(data.toString())
  if (byteLength > MAX_SUBSCRIPTION_BYTES) {
    return { accepted: false, code: 'INVALID_ENVELOPE', message: 'The subscription exceeds 16384 bytes.' }
  }

  if (isBinary) {
    return { accepted: false, code: 'INVALID_ENVELOPE', message: 'Binary subscriptions are not accepted.' }
  }

  let value: unknown
  try {
    value = JSON.parse(data.toString()) as unknown
  } catch {
    return { accepted: false, code: 'INVALID_ENVELOPE', message: 'The subscription must be valid JSON.' }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { accepted: false, code: 'INVALID_ENVELOPE', message: 'The subscription must be an object.' }
  }

  const record = value as Record<string, unknown>
  const allowedKeys = new Set(['type', 'schemaVersion', 'taskId', 'topics', 'lastSequence'])
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return { accepted: false, code: 'INVALID_ENVELOPE', message: 'The subscription contains unknown fields.' }
  }

  if (
    record.type !== 'subscribe'
    || record.schemaVersion !== '1.0'
    || typeof record.taskId !== 'string'
    || !/^TASK-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(record.taskId)
    || !Array.isArray(record.topics)
    || record.topics.length === 0
  ) {
    return { accepted: false, code: 'INVALID_ENVELOPE', message: 'The subscription envelope is invalid.' }
  }

  const topics = record.topics
  if (topics.some((topic) => typeof topic !== 'string' || !CANONICAL_TOPICS.has(topic as WsTopic))) {
    return { accepted: false, code: 'TOPIC_FORBIDDEN', message: 'The subscription contains a forbidden topic.' }
  }

  if (new Set(topics).size !== topics.length) {
    return { accepted: false, code: 'INVALID_ENVELOPE', message: 'Subscription topics must be unique.' }
  }

  if (
    record.lastSequence !== undefined
    && (!Number.isSafeInteger(record.lastSequence) || (record.lastSequence as number) < 0)
  ) {
    return { accepted: false, code: 'INVALID_ENVELOPE', message: 'lastSequence must be a nonnegative safe integer.' }
  }

  return {
    accepted: true,
    request: {
      type: 'subscribe',
      schemaVersion: '1.0',
      taskId: record.taskId as TaskId,
      topics: topics as WsTopic[],
      ...(record.lastSequence === undefined ? {} : { lastSequence: record.lastSequence as number }),
    },
  }
}

function reject(client: WebSocket, code: WsRejection['code'], message: string): void {
  const rejection: WsRejection = {
    type: 'rejected',
    code,
    message,
    closeCode: 1008,
  }

  client.send(JSON.stringify(rejection))
  client.close(1008, code)
}

function trackClient(
  client: WebSocket,
  clients: Map<WebSocket, Set<WsTopic>>,
  projection: MockProjection,
  replayTopic: (client: WebSocket, topic: WsTopic) => void,
  send: (client: WebSocket, message: string) => void,
): void {
  client.on('error', () => clients.delete(client))
  clients.set(client, new Set())
  client.once('close', () => clients.delete(client))

  let subscribed = false
  client.on('message', (data, isBinary) => {
    if (subscribed) {
      reject(client, 'INVALID_ENVELOPE', 'Only one subscription is accepted per connection.')
      return
    }

    const parsed = parseSubscription(data, isBinary)
    if (!parsed.accepted) {
      reject(client, parsed.code, parsed.message)
      return
    }

    if (parsed.request.taskId !== projection.snapshot().task.taskId) {
      reject(client, 'INVALID_ENVELOPE', 'The subscription task is not owned by this projection.')
      return
    }

    const lastSequence = parsed.request.lastSequence ?? 0
    // P0 owns no historical event log, so only a fresh cursor can be resumed without inventing data.
    if (lastSequence > 0) {
      reject(client, 'SEQUENCE_GAP', 'P0 can resume only from lastSequence 0.')
      return
    }

    subscribed = true
    clients.set(client, new Set(parsed.request.topics))
    const acknowledgement: SubscriptionAcknowledgement = {
      type: 'subscribed',
      schemaVersion: '1.0',
      taskId: parsed.request.taskId,
      topics: [...parsed.request.topics],
      lastSequence,
      nextSequence: lastSequence + 1,
    }
    send(client, JSON.stringify(acknowledgement))

    parsed.request.topics.forEach((topic) => replayTopic(client, topic))
  })
}

/**
 * 创建一条具有新主题序号的规范实时信封。
 * @param projection 提供任务标识和分主题序号的 Mock 投影。
 * @param topic 当前消息主题。
 * @param payload 主题对应的已校验载荷。
 * @param simulationTime 当前仿真时刻。
 * @param frameId 同帧主题使用的帧标识。
 * @returns 可缓存、重放或广播的实时信封。
 */
function createEnvelope<T>(
  projection: MockProjection,
  topic: WsTopic,
  payload: T,
  simulationTime: number,
  frameId?: FrameId,
): RealtimeEnvelope<T> {
  const taskId = projection.snapshot().task.taskId
  return {
    type: 'event',
    schemaVersion: '1.0',
    topic,
    taskId,
    sequence: projection.nextSequence(taskId, topic),
    simulationTime,
    ...(frameId === undefined ? {} : { frameId }),
    payload,
  }
}

export function attachRealtimeServer(
  httpServer: HttpServer,
  projection: MockProjection,
  currentRun: () => SimulationRun | undefined = () => projection.snapshot().run,
  authorize?: (request: IncomingMessage) => boolean,
  publicOrigin?: string,
  limits: { maxClients: number; maxPerSource: number; heartbeatMs: number; maxBufferedBytes?: number } = {
    maxClients: MAX_CLIENTS,
    maxPerSource: MAX_CLIENTS_PER_SOURCE,
    heartbeatMs: HEARTBEAT_MS,
  },
): RealtimeController {
  const clients = new Map<WebSocket, Set<WsTopic>>()
  const requests = new Map<WebSocket, IncomingMessage>()
  const alive = new Map<WebSocket, boolean>()
  const send = (client: WebSocket, message: string): void => {
    if (client.readyState !== WebSocket.OPEN) return
    if (client.bufferedAmount + Buffer.byteLength(message) > (limits.maxBufferedBytes ?? MAX_BUFFERED_BYTES)) {
      clients.delete(client)
      requests.delete(client)
      alive.delete(client)
      client.terminate()
      return
    }
    client.send(message)
  }
  const sourceFor = (request: IncomingMessage) => request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown'
  const heartbeat = setInterval(() => {
    for (const client of clients.keys()) {
      if (client.readyState !== WebSocket.OPEN || !alive.get(client)) {
        clients.delete(client)
        requests.delete(client)
        alive.delete(client)
        client.terminate()
        continue
      }
      alive.set(client, false)
      client.ping()
    }
  }, limits.heartbeatMs)
  heartbeat.unref()
  function revalidateSessions(): void {
    if (!authorize) return
    for (const [client, request] of requests) {
      if (!authorize(request)) { clients.delete(client); requests.delete(client); alive.delete(client); client.close(1008, 'SESSION_EXPIRED') }
    }
  }
  const currentEnvelopes = new Map<WsTopic, string>()
  let publishedRunId = currentRun()?.runId
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_TRANSPORT_PAYLOAD_BYTES,
  })

  const replayTopic = (client: WebSocket, topic: WsTopic): void => {
    revalidateSessions()
    if (!clients.has(client)) return
    // 自选场景只有 Mock 控制状态，不能重放固定样例的链路与事件作为它的结果。
    // 没有运行时仍按无运行处理：依赖运行的主题各自缺失，静态链路摘要照常返回。
    const run = currentRun()
    if (topic !== 'runtime.state' && run !== undefined && !ownsFixedEvidence(run)) return
    let message = currentEnvelopes.get(topic)
    if (message === undefined) {
      const snapshot = projection.snapshot()
      let envelope: RealtimeEnvelope<unknown> | undefined
      if (topic === 'simulation.frame') {
        const frame = fixedFrameForRun(run?.runId ?? snapshot.frame.runId)
        envelope = createEnvelope(projection, topic, frame, frame.simulationTime, frame.frameId)
      } else if (topic === 'link.metric') {
        envelope = createEnvelope(projection, topic, snapshot.frame.linkSummaries, snapshot.frame.simulationTime, snapshot.frame.frameId)
      } else if (topic === 'runtime.state') {
        const run = currentRun()
        if (run !== undefined) envelope = createEnvelope(projection, topic, run.canonical, run.canonical.currentTime)
      } else if (topic === 'jammer.event') {
        const event = snapshot.events.find((item) => item.type === 'DETECTION')
        if (event !== undefined) envelope = createEnvelope(projection, topic, event, event.time, event.frameId)
      } else if (topic === 'switch.event') {
        const event = snapshot.events.find((item) => item.type === 'LINK_SWITCH')
        if (event !== undefined) envelope = createEnvelope(projection, topic, event, event.time, event.frameId)
      }
      if (envelope === undefined) return
      message = JSON.stringify(envelope)
      currentEnvelopes.set(topic, message)
    }
    send(client, message)
  }

  webSocketServer.on('connection', (client, request) => {
    requests.set(client, request)
    alive.set(client, true)
    client.on('pong', () => alive.set(client, true))
    client.once('close', () => { requests.delete(client); alive.delete(client) })
    trackClient(client, clients, projection, replayTopic, send)
  })

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const requestUrl = new URL(request.url ?? '/', 'ws://127.0.0.1')
    if (requestUrl.pathname !== '/ws/v1') {
      socket.destroy()
      return
    }

    const loopback = publicOrigin ? assertLanRequest(request, publicOrigin, true) : assertLoopbackRequest(request)
    const role = request.headers['x-demo-role']
    const roleValue = (Array.isArray(role) ? undefined : role) ?? requestUrl.searchParams.get('role') ?? undefined

    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      if (!loopback.allowed) {
        reject(client, 'LOOPBACK_ONLY', loopback.message)
        return
      }

      if (authorize ? !authorize(request) : !isDemoRole(roleValue)) {
        reject(client, 'INVALID_ENVELOPE', 'A valid demo role is required.')
        return
      }
      const source = sourceFor(request)
      if (clients.size >= limits.maxClients
        || [...requests.values()].filter(item => sourceFor(item) === source).length >= limits.maxPerSource) {
        reject(client, 'INVALID_ENVELOPE', 'The realtime connection limit has been reached.')
        return
      }
      webSocketServer.emit('connection', client, request)
    })
  })

  function invalidateForReset(): void {
    // Clear ownership before reset so no old connection can remain part of the new projection epoch.
    for (const client of clients.keys()) {
      client.close(1008, 'RESET')
    }
    clients.clear()
    requests.clear()
    alive.clear()
    currentEnvelopes.clear()
  }

  return {
    activeClientCount: () => clients.size,
    revalidateSessions,
    publishRuntimeState: (run): void => {
      revalidateSessions()
      const runChanged = publishedRunId !== run.runId
      if (runChanged) {
        publishedRunId = run.runId
        currentEnvelopes.clear()
      }
      const subscribers = [...clients].filter(([, topics]) => topics.has('runtime.state'))
      if (subscribers.length === 0) currentEnvelopes.delete('runtime.state')
      else {
        const envelope: RealtimeEnvelope<SimulationState> = createEnvelope(
          projection,
          'runtime.state',
          run.canonical,
          run.canonical.currentTime,
        )
        const message = JSON.stringify(envelope)
        currentEnvelopes.set('runtime.state', message)
        subscribers.forEach(([client]) => send(client, message))
      }
      if (runChanged) {
        for (const [client, topics] of clients) {
          for (const topic of topics) {
            if (topic !== 'runtime.state') replayTopic(client, topic)
          }
        }
      }
    },
    publishJammerStatus: (status, frameId): void => {
      revalidateSessions()
      if (!ownsFixedEvidence(currentRun())) return
      const envelope: RealtimeEnvelope<JammerStatusData> = createEnvelope(
        projection,
        'jammer.event',
        status,
        status.time,
        frameId,
      )
      const message = JSON.stringify(envelope)
      currentEnvelopes.set('jammer.event', message)
      for (const [client, topics] of clients) {
        if (topics.has('jammer.event')) send(client, message)
      }
    },
    invalidateForReset,
    reset: () => {
      invalidateForReset()
      return projection.reset()
    },
    close: () => new Promise<void>((resolve, rejectClose) => {
      clearInterval(heartbeat)
      for (const client of clients.keys()) {
        client.terminate()
      }
      clients.clear()
      requests.clear()
      alive.clear()
      webSocketServer.close((error) => {
        if (error === undefined) {
          resolve()
        } else {
          rejectClose(error)
        }
      })
    }),
  }
}

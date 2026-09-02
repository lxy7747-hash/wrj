import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type {
  RealtimeEnvelope,
  FrameId,
  ResetResult,
  SimulationRun,
  SimulationState,
  TaskId,
  WsRejection,
  WsSubscribeRequest,
  WsTopic,
} from '../../src/contracts/domain-models.js'
import { assertLoopbackRequest } from '../http/loopback.js'
import type { MockProjection } from '../state/projection.js'

const CANONICAL_TOPICS = new Set<WsTopic>([
  'simulation.frame',
  'runtime.state',
  'link.metric',
  'jammer.event',
  'switch.event',
])
const MAX_SUBSCRIPTION_BYTES = 16_384
const MAX_TRANSPORT_PAYLOAD_BYTES = 65_536

export interface RealtimeController {
  activeClientCount(): number
  publishRuntimeState(run: SimulationRun): void
  invalidateForReset(): void
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
  const byteLength = Array.isArray(data)
    ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
    : data.byteLength
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
    client.send(JSON.stringify(acknowledgement))

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
  simulationTime?: number,
  frameId?: FrameId,
): RealtimeEnvelope<T> {
  const taskId = projection.snapshot().task.taskId
  return {
    type: 'event',
    schemaVersion: '1.0',
    topic,
    taskId,
    sequence: projection.nextSequence(taskId, topic),
    ...(simulationTime === undefined ? {} : { simulationTime }),
    ...(frameId === undefined ? {} : { frameId }),
    payload,
  }
}

export function attachRealtimeServer(
  httpServer: HttpServer,
  projection: MockProjection,
  currentRun: () => SimulationRun | undefined = () => projection.snapshot().run,
): RealtimeController {
  const clients = new Map<WebSocket, Set<WsTopic>>()
  const currentEnvelopes = new Map<WsTopic, string>()
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_TRANSPORT_PAYLOAD_BYTES,
  })

  const replayTopic = (client: WebSocket, topic: WsTopic): void => {
    let message = currentEnvelopes.get(topic)
    if (message === undefined) {
      const snapshot = projection.snapshot()
      let envelope: RealtimeEnvelope<unknown> | undefined
      if (topic === 'simulation.frame') {
        envelope = createEnvelope(projection, topic, snapshot.frame, snapshot.frame.simulationTime, snapshot.frame.frameId)
      } else if (topic === 'link.metric') {
        envelope = createEnvelope(projection, topic, snapshot.frame.linkSummaries, snapshot.frame.simulationTime, snapshot.frame.frameId)
      } else if (topic === 'runtime.state') {
        const run = currentRun()
        if (run !== undefined) envelope = createEnvelope(projection, topic, run.canonical, run.canonical.currentTime)
      }
      if (envelope === undefined) return
      message = JSON.stringify(envelope)
      currentEnvelopes.set(topic, message)
    }
    client.send(message)
  }

  webSocketServer.on('connection', (client) => trackClient(client, clients, projection, replayTopic))

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const requestUrl = new URL(request.url ?? '/', 'ws://127.0.0.1')
    if (requestUrl.pathname !== '/ws/v1') {
      socket.destroy()
      return
    }

    const loopback = assertLoopbackRequest(request)
    const role = request.headers['x-demo-role']
    const roleValue = (Array.isArray(role) ? undefined : role) ?? requestUrl.searchParams.get('role') ?? undefined

    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request)

      if (!loopback.allowed) {
        reject(client, 'LOOPBACK_ONLY', loopback.message)
        return
      }

      if (!isDemoRole(roleValue)) {
        reject(client, 'INVALID_ENVELOPE', 'A valid demo role is required.')
      }
    })
  })

  function invalidateForReset(): void {
    // Clear ownership before reset so no old connection can remain part of the new projection epoch.
    for (const client of clients.keys()) {
      client.close(1008, 'RESET')
    }
    clients.clear()
    currentEnvelopes.clear()
  }

  return {
    activeClientCount: () => clients.size,
    publishRuntimeState: (run): void => {
      const subscribers = [...clients].filter(([, topics]) => topics.has('runtime.state'))
      if (subscribers.length === 0) {
        currentEnvelopes.delete('runtime.state')
        return
      }
      const envelope: RealtimeEnvelope<SimulationState> = createEnvelope(
        projection,
        'runtime.state',
        run.canonical,
        run.canonical.currentTime,
      )
      const message = JSON.stringify(envelope)
      currentEnvelopes.set('runtime.state', message)
      subscribers.forEach(([client]) => client.send(message))
    },
    invalidateForReset,
    reset: () => {
      invalidateForReset()
      return projection.reset()
    },
    close: () => new Promise<void>((resolve, rejectClose) => {
      for (const client of clients.keys()) {
        client.terminate()
      }
      clients.clear()
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

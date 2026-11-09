import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type {
  RealtimeEnvelope,
  EngineFrameSnapshot,
  EngineConnectionDiagnostic,
  EngineJammerFrameUpdate,
  EngineSwitchFrameUpdate,
  FrameId,
  JammerStatusData,
  JammingDecision,
  JammingDecisionEvent,
  QualityDataset,
  QualityDatasetUpdate,
  MissionLogUpdate,
  MissionPositionUpdate,
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
import { MemoryRealtimeJournal, type RealtimeJournalStore } from './realtime-journal.js'

const CANONICAL_TOPICS = new Set<WsTopic>([
  'simulation.frame',
  'runtime.state',
  'link.metric',
  'jammer.event',
  'switch.event',
  'mission.log',
  'position.update',
])
const MAX_SUBSCRIPTION_BYTES = 16_384
const MAX_TRANSPORT_PAYLOAD_BYTES = 65_536
const MAX_CLIENTS = 64
const MAX_CLIENTS_PER_SOURCE = 8
const HEARTBEAT_MS = 30_000
const MAX_BUFFERED_BYTES = 1_048_576
const MAX_RETAINED_EVENTS = 128

export interface RealtimeController {
  activeClientCount(): number
  publishRuntimeState(run: SimulationRun): void
  publishJammerStatus(status: JammerStatusData, frameId: FrameId): void
  publishJammingDecision(decision: JammingDecision, frameId: FrameId, simulationTime: number): void
  /**
   * Publishes only a bounded reference to an imported quality dataset.  Clients
   * fetch the checked dataset from REST, so an arbitrary CSV history never
   * becomes a websocket payload or journal entry.
   */
  publishQualityDataset(dataset: QualityDataset): void
  publishEngineFrame(runId: SimulationRun['runId'], snapshot: EngineFrameSnapshot): void
  publishMissionPositions(run: Pick<SimulationRun, 'runId' | 'taskId'>, update: MissionPositionUpdate): void
  /** Process output is not frame-timed; the envelope intentionally omits simulationTime/frameId. */
  publishMissionLog(run: Pick<SimulationRun, 'runId' | 'taskId'>, update: MissionLogUpdate): void
  publishEngineDiagnostic(run: Pick<SimulationRun, 'runId' | 'taskId'>, diagnostic: EngineConnectionDiagnostic): void
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
  lastSequences?: Partial<Record<WsTopic, number>>
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
  const allowedKeys = new Set(['type', 'schemaVersion', 'taskId', 'topics', 'lastSequence', 'lastSequences'])
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

  if (record.lastSequence !== undefined && record.lastSequences !== undefined) {
    return { accepted: false, code: 'INVALID_ENVELOPE', message: 'Use either lastSequence or lastSequences, not both.' }
  }

  let lastSequences: Partial<Record<WsTopic, number>> | undefined
  if (record.lastSequences !== undefined) {
    if (typeof record.lastSequences !== 'object' || record.lastSequences === null || Array.isArray(record.lastSequences)) {
      return { accepted: false, code: 'INVALID_ENVELOPE', message: 'lastSequences must be an object keyed by subscribed topic.' }
    }
    const cursors = record.lastSequences as Record<string, unknown>
    const cursorTopics = Object.keys(cursors)
    if (cursorTopics.length !== topics.length
      || cursorTopics.some((topic) => !topics.includes(topic) || !Number.isSafeInteger(cursors[topic]) || (cursors[topic] as number) < 0)) {
      return { accepted: false, code: 'INVALID_ENVELOPE', message: 'lastSequences must contain a nonnegative cursor for every subscribed topic.' }
    }
    lastSequences = Object.fromEntries(cursorTopics.map((topic) => [topic, cursors[topic] as number])) as Partial<Record<WsTopic, number>>
  }

  return {
    accepted: true,
    request: {
      type: 'subscribe',
      schemaVersion: '1.0',
      taskId: record.taskId as TaskId,
      topics: topics as WsTopic[],
      ...(record.lastSequence === undefined ? {} : { lastSequence: record.lastSequence as number }),
      ...(lastSequences === undefined ? {} : { lastSequences }),
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

interface ClientSubscription { taskId?: TaskId; topics: Set<WsTopic> }
interface RealtimeJournalOptions { journal?: RealtimeJournalStore; replayPageSize?: number }

export function attachRealtimeServer(
  httpServer: HttpServer,
  projection: MockProjection,
  currentRun: (taskId?: TaskId) => SimulationRun | undefined = () => projection.snapshot().run,
  authorize?: (request: IncomingMessage) => boolean,
  publicOrigin?: string,
  limits: { maxClients: number; maxPerSource: number; heartbeatMs: number; maxBufferedBytes?: number; maxRetainedEvents?: number } = {
    maxClients: MAX_CLIENTS,
    maxPerSource: MAX_CLIENTS_PER_SOURCE,
    heartbeatMs: HEARTBEAT_MS,
  },
  journalOptions?: RealtimeJournalOptions,
): RealtimeController {
  const clients = new Map<WebSocket, ClientSubscription>()
  const requests = new Map<WebSocket, IncomingMessage>()
  const alive = new Map<WebSocket, boolean>()
  const replaying = new Map<WebSocket, Set<WsTopic>>()
  const send = (client: WebSocket, message: string, onFlushed?: () => void): boolean => {
    if (client.readyState !== WebSocket.OPEN) return false
    if (client.bufferedAmount + Buffer.byteLength(message) > (limits.maxBufferedBytes ?? MAX_BUFFERED_BYTES)) {
      clients.delete(client)
      requests.delete(client)
      alive.delete(client)
      replaying.delete(client)
      client.terminate()
      return false
    }
    client.send(message, (error) => { if (error == null) onFlushed?.() })
    return true
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
  const retainedEventLimit = Number.isSafeInteger(limits.maxRetainedEvents) && limits.maxRetainedEvents! > 0
    ? Math.min(limits.maxRetainedEvents!, MAX_RETAINED_EVENTS)
    : MAX_RETAINED_EVENTS
  const journal = journalOptions?.journal ?? new MemoryRealtimeJournal(retainedEventLimit)
  const replayPageSize = Math.max(1, Math.min(journalOptions?.replayPageSize ?? 64, 512))
  const currentEnvelopes = new Map<string, string>()
  const runIds = new Map<TaskId, string>()
  const keyFor = (taskId: TaskId, topic: WsTopic): string => `${taskId}\u0000${topic}`
  const forgetTask = (taskId: TaskId): void => {
    for (const topic of CANONICAL_TOPICS) currentEnvelopes.delete(keyFor(taskId, topic))
  }
  const ownsTask = (taskId: TaskId): boolean => {
    const run = currentRun(taskId)
    return run?.taskId === taskId || taskId === projection.snapshot().task.taskId
  }
  const createEnvelope = <T>(taskId: TaskId, topic: WsTopic, payload: T, simulationTime?: number, frameId?: FrameId): RealtimeEnvelope<T> => {
    // Keep the projection counter advancing for existing in-process observers;
    // durable ordering itself is owned by the journal so it survives restart.
    projection.nextSequence(taskId, topic)
    return {
      type: 'event', schemaVersion: '1.0', topic, taskId,
      sequence: journal.next(taskId, topic),
      ...(simulationTime === undefined ? {} : { simulationTime }),
      ...(frameId === undefined ? {} : { frameId }), payload,
    }
  }
  const retain = (envelope: RealtimeEnvelope<unknown>): string | undefined => {
    const message = JSON.stringify(envelope)
    try {
      journal.append(envelope.taskId, envelope.topic, { sequence: envelope.sequence, message })
      currentEnvelopes.set(keyFor(envelope.taskId, envelope.topic), message)
      return message
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      for (const [client, subscription] of clients) {
        if (subscription.taskId === envelope.taskId) reject(client, 'SEQUENCE_GAP', reason)
      }
      return undefined
    }
  }
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_TRANSPORT_PAYLOAD_BYTES,
  })

  const replayTopic = (client: WebSocket, taskId: TaskId, topic: WsTopic, lastSequence: number, replayZeroCursorEvents: boolean): void => {
    revalidateSessions()
    if (!clients.has(client)) return
    // 自选场景不能重放固定样例的链路与事件作为它的结果。
    // 没有运行时仍按无运行处理：依赖运行的主题各自缺失，静态链路摘要照常返回。
    const run = currentRun(taskId)
    const fixedEvidence = run === undefined || ownsFixedEvidence(run)
    if (!['runtime.state', 'link.metric', 'mission.log', 'position.update', 'jammer.event', 'switch.event'].includes(topic) && !fixedEvidence) return
    const ownsRunScopedMessage = (message: string): boolean => {
      if (fixedEvidence || !['link.metric', 'mission.log', 'position.update', 'jammer.event', 'switch.event'].includes(topic)) return true
      try {
        const { payload } = JSON.parse(message)
        const active = currentRun(taskId)
        if (active === undefined) return false
        if (['mission.log', 'position.update', 'jammer.event', 'switch.event'].includes(topic)) return payload?.runId === active.runId
        return payload?.kind === 'ENGINE_FRAME' && payload.runId === active.runId
          || payload?.kind === 'QUALITY_UPDATED' && payload.scope?.runId === active.runId
            && payload.scope?.taskId === taskId && payload.scope?.scenarioId === active.scenarioId
      } catch { return false }
    }
    if (lastSequence > 0 || replayZeroCursorEvents) {
      let cursor = lastSequence
      let page: Array<{ sequence: number; message: string }> = []
      const activeTopics = replaying.get(client) ?? new Set<WsTopic>()
      if (activeTopics.has(topic)) return
      activeTopics.add(topic)
      replaying.set(client, activeTopics)
      const finish = (): void => {
        const topics = replaying.get(client)
        topics?.delete(topic)
        if (topics?.size === 0) replaying.delete(client)
      }
      const continueReplay = (): void => {
        if (!clients.has(client)) { finish(); return }
        if (page.length === 0) {
          const read = journal.readAfter(taskId, topic, cursor, replayPageSize)
          if (!read.ok) { finish(); reject(client, 'SEQUENCE_GAP', read.reason); return }
          page = read.events
        }
        const event = page.shift()
        if (event === undefined) { finish(); return }
        if (!ownsRunScopedMessage(event.message)) { finish(); reject(client, 'SEQUENCE_GAP', 'Retained realtime record does not belong to the current run.'); return }
        if (!send(client, event.message, () => { cursor = event.sequence; continueReplay() })) finish()
      }
      continueReplay()
      return
    }
    let message = currentEnvelopes.get(keyFor(taskId, topic))
    if (message !== undefined && !ownsRunScopedMessage(message)) return
    if (message === undefined) {
      // 真实运行可重放引擎帧/质量引用，但没有缓存时不能补固定样例摘要。
      if (topic !== 'runtime.state' && !fixedEvidence) return
      const snapshot = projection.snapshot()
      let envelope: RealtimeEnvelope<unknown> | undefined
      if (topic === 'simulation.frame') {
        const frame = fixedFrameForRun(run?.runId ?? snapshot.frame.runId)
        envelope = createEnvelope(taskId, topic, frame, frame.simulationTime, frame.frameId)
      } else if (topic === 'link.metric') {
        envelope = createEnvelope(taskId, topic, snapshot.frame.linkSummaries, snapshot.frame.simulationTime, snapshot.frame.frameId)
      } else if (topic === 'runtime.state') {
        if (run !== undefined) {
          // A first subscription establishes the current run without creating a
          // boundary.  A later different run is what invalidates old cursors.
          runIds.set(taskId, run.runId)
          envelope = createEnvelope(taskId, topic, run.canonical, run.canonical.currentTime)
        }
      } else if (topic === 'jammer.event') {
        const event = snapshot.events.find((item) => item.type === 'DETECTION')
        if (event !== undefined) envelope = createEnvelope(taskId, topic, event, event.time, event.frameId)
      } else if (topic === 'switch.event') {
        const event = snapshot.events.find((item) => item.type === 'LINK_SWITCH')
        if (event !== undefined) envelope = createEnvelope(taskId, topic, event, event.time, event.frameId)
      }
      if (envelope === undefined) return
      message = retain(envelope)
    }
    if (message !== undefined) send(client, message)
  }

  const canResume = (taskId: TaskId, topics: WsTopic[], cursors: Partial<Record<WsTopic, number>>, resumesAnyTopic: boolean): string | undefined => {
    for (const topic of topics) {
      const read = journal.canResume(taskId, topic, cursors[topic] ?? 0, resumesAnyTopic)
      if (!read.ok) return read.reason
    }
    return undefined
  }

  const trackClient = (client: WebSocket): void => {
    client.on('error', () => { clients.delete(client); replaying.delete(client) })
    clients.set(client, { topics: new Set() })
    client.once('close', () => { clients.delete(client); replaying.delete(client) })
    let subscribed = false
    client.on('message', (data, isBinary) => {
      if (subscribed) { reject(client, 'INVALID_ENVELOPE', 'Only one subscription is accepted per connection.'); return }
      const parsed = parseSubscription(data, isBinary)
      if (!parsed.accepted) { reject(client, parsed.code, parsed.message); return }
      const taskId = parsed.request.taskId
      if (!ownsTask(taskId)) { reject(client, 'INVALID_ENVELOPE', 'The subscription task is not owned by this realtime server.'); return }
      const run = currentRun(taskId)
      try {
        if (run !== undefined && journal.prepareRun(taskId, run.runId)) forgetTask(taskId)
      } catch (error) { reject(client, 'SEQUENCE_GAP', error instanceof Error ? error.message : String(error)); return }
      const lastSequence = parsed.request.lastSequence ?? 0
      const lastSequences = parsed.request.lastSequences ?? (Object.fromEntries(parsed.request.topics.map(topic => [topic, lastSequence])) as Partial<Record<WsTopic, number>>)
      const resumesAnyTopic = parsed.request.topics.some(topic => (lastSequences[topic] ?? 0) > 0)
      const gap = canResume(taskId, parsed.request.topics, lastSequences, resumesAnyTopic)
      if (gap !== undefined) { reject(client, 'SEQUENCE_GAP', `The requested sequence is outside the retained realtime event window: ${gap}`); return }
      subscribed = true
      clients.set(client, { taskId, topics: new Set(parsed.request.topics) })
      send(client, JSON.stringify({ type: 'subscribed', schemaVersion: '1.0', taskId, topics: [...parsed.request.topics], lastSequence, nextSequence: lastSequence + 1, ...(parsed.request.lastSequences === undefined ? {} : { lastSequences }) } satisfies SubscriptionAcknowledgement))
      for (const topic of parsed.request.topics) replayTopic(client, taskId, topic, lastSequences[topic] ?? 0, resumesAnyTopic && (lastSequences[topic] ?? 0) === 0)
    })
  }

  webSocketServer.on('connection', (client, request) => {
    requests.set(client, request)
    alive.set(client, true)
    client.on('pong', () => alive.set(client, true))
    client.once('close', () => { requests.delete(client); alive.delete(client) })
    trackClient(client)
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
    replaying.clear()
    journal.clear()
  }

  return {
    activeClientCount: () => clients.size,
    revalidateSessions,
    publishRuntimeState: (run): void => {
      revalidateSessions()
      const taskId = run.taskId
      const runChanged = runIds.get(taskId) !== run.runId
      if (runChanged) {
        runIds.set(taskId, run.runId)
        forgetTask(taskId)
        try { journal.prepareRun(taskId, run.runId) } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          for (const [client, subscription] of clients) if (subscription.taskId === taskId) reject(client, 'SEQUENCE_GAP', reason)
          return
        }
      }
      const envelope: RealtimeEnvelope<SimulationState> = createEnvelope(
        taskId,
        'runtime.state',
        run.canonical,
        run.canonical.currentTime,
      )
      const message = retain(envelope)
      if (message === undefined) return
      const subscribers = [...clients].filter(([, subscription]) => subscription.taskId === taskId && subscription.topics.has('runtime.state'))
      if (subscribers.length > 0) {
        subscribers.forEach(([client]) => {
          if (!replaying.get(client)?.has('runtime.state')) send(client, message)
        })
      }
      if (runChanged) {
        for (const [client, subscription] of clients) {
          if (subscription.taskId !== taskId) continue
          for (const topic of subscription.topics) {
            if (topic !== 'runtime.state') replayTopic(client, taskId, topic, 0, false)
          }
        }
      }
    },
    publishJammerStatus: (status, frameId): void => {
      revalidateSessions()
      const taskId = projection.snapshot().task.taskId
      if (!ownsFixedEvidence(currentRun(taskId))) return
      const envelope: RealtimeEnvelope<JammerStatusData> = createEnvelope(
        taskId,
        'jammer.event',
        status,
        status.time,
        frameId,
      )
      const message = retain(envelope)
      if (message === undefined) return
      for (const [client, subscription] of clients) {
        if (subscription.taskId === taskId && subscription.topics.has('jammer.event') && !replaying.get(client)?.has('jammer.event')) send(client, message)
      }
    },
    publishJammingDecision: (decision, frameId, simulationTime): void => {
      revalidateSessions()
      const taskId = projection.snapshot().task.taskId
      const run = currentRun(taskId)
      if (!ownsFixedEvidence(run) || run?.runId !== decision.runId) return
      const envelope: RealtimeEnvelope<JammingDecisionEvent> = createEnvelope(
        taskId, 'jammer.event', { type: 'JAMMING_DECISION', decision }, simulationTime, frameId,
      )
      const message = retain(envelope)
      if (message === undefined) return
      for (const [client, subscription] of clients) {
        if (subscription.taskId === taskId && subscription.topics.has('jammer.event') && !replaying.get(client)?.has('jammer.event')) send(client, message)
      }
    },
    publishEngineFrame: (runId, payload): void => {
      revalidateSessions()
      const taskId = [...runIds].find(([, id]) => id === runId)?.[0]
      const run = taskId === undefined ? undefined : currentRun(taskId)
      if (!run || run.runId !== runId || payload.runId !== runId) return
      const envelope = createEnvelope(run.taskId, 'link.metric', payload, payload.simulationTime, `F-ENGINE-${payload.frameId}`)
      const message = retain(envelope)
      if (message === undefined) return
      for (const [client, subscription] of clients) {
        if (subscription.taskId === run.taskId && subscription.topics.has('link.metric') && !replaying.get(client)?.has('link.metric')) send(client, message)
      }
      const publishFrameTopic = <T>(topic: 'jammer.event' | 'switch.event', framePayload: T): void => {
        const event = createEnvelope(run.taskId, topic, framePayload, payload.simulationTime, `F-ENGINE-${payload.frameId}`)
        const serialized = retain(event)
        if (serialized === undefined) return
        for (const [client, subscription] of clients) {
          if (subscription.taskId === run.taskId && subscription.topics.has(topic) && !replaying.get(client)?.has(topic)) send(client, serialized)
        }
      }
      if (payload.jammers.length || payload.events.length) {
        const jammerUpdate: EngineJammerFrameUpdate = {
          kind: 'ENGINE_JAMMER_FRAME', runId: payload.runId, engineEpoch: payload.engineEpoch,
          sourceFrameId: payload.frameId, simulationTime: payload.simulationTime,
          jammers: structuredClone(payload.jammers), events: structuredClone(payload.events),
        }
        publishFrameTopic('jammer.event', jammerUpdate)
      }
      if (payload.routing.switches.length) {
        const switchUpdate: EngineSwitchFrameUpdate = {
          kind: 'ENGINE_SWITCH_FRAME', runId: payload.runId, engineEpoch: payload.engineEpoch,
          sourceFrameId: payload.frameId, simulationTime: payload.simulationTime,
          switches: structuredClone(payload.routing.switches),
        }
        publishFrameTopic('switch.event', switchUpdate)
      }
    },
    publishMissionPositions: (run, payload): void => {
      revalidateSessions()
      const active = currentRun(run.taskId)
      if (!active || active.taskId !== run.taskId || active.runId !== run.runId || payload.runId !== run.runId || payload.scenarioId !== active.scenarioId) return
      const envelope = createEnvelope(run.taskId, 'position.update', payload)
      const message = retain(envelope)
      if (message === undefined) return
      for (const [client, subscription] of clients) {
        if (subscription.taskId === run.taskId && subscription.topics.has('position.update') && !replaying.get(client)?.has('position.update')) send(client, message)
      }
    },
    publishMissionLog: (run, payload): void => {
      revalidateSessions()
      const active = currentRun(run.taskId)
      if (!active || active.taskId !== run.taskId || active.runId !== run.runId || payload.runId !== run.runId) return
      const envelope = createEnvelope(run.taskId, 'mission.log', payload)
      const message = retain(envelope)
      if (message === undefined) return
      for (const [client, subscription] of clients) {
        if (subscription.taskId === run.taskId && subscription.topics.has('mission.log') && !replaying.get(client)?.has('mission.log')) send(client, message)
      }
    },
    publishEngineDiagnostic: (run, diagnostic): void => {
      revalidateSessions()
      const active = currentRun(run.taskId)
      if (!active || active.taskId !== run.taskId || active.runId !== run.runId || diagnostic.runId !== run.runId) return
      const envelope = createEnvelope(run.taskId, 'mission.log', diagnostic)
      const message = retain(envelope)
      if (message === undefined) return
      for (const [client, subscription] of clients) {
        if (subscription.taskId === run.taskId && subscription.topics.has('mission.log') && !replaying.get(client)?.has('mission.log')) send(client, message)
      }
    },
    publishQualityDataset: (dataset): void => {
      revalidateSessions()
      const { scope } = dataset
      const taskId = scope.taskId as TaskId
      const run = currentRun(taskId)
      // The HTTP import already validates its scope.  Keep this second guard at
      // the transport boundary so a stale async completion cannot notify a new
      // task/run after it has been replaced.
      if (!run || run.taskId !== scope.taskId || run.runId !== scope.runId) return
      const simulationTime = dataset.samples.length
        ? Math.max(...dataset.samples.map(sample => sample.time))
        : run.canonical.currentTime
      const payload: QualityDatasetUpdate = {
        kind: 'QUALITY_UPDATED', scope: { ...scope }, sourceSha256: dataset.source.sha256,
        sampleCount: dataset.samples.length,
      }
      const envelope: RealtimeEnvelope<QualityDatasetUpdate> = createEnvelope(
        run.taskId, 'link.metric', payload, simulationTime,
      )
      const message = retain(envelope)
      if (message === undefined) return
      for (const [client, subscription] of clients) {
        if (subscription.taskId === run.taskId && subscription.topics.has('link.metric') && !replaying.get(client)?.has('link.metric')) send(client, message)
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
      replaying.clear()
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

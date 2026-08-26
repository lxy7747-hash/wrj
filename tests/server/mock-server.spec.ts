import { afterEach, beforeAll, describe, expect, it } from 'vitest'

const ORIGIN = 'http://127.0.0.1:5173'

interface MockProjectionInstance {
  snapshot(): unknown
  reset(): unknown
  nextSequence(taskId: string, topic: string): number
}

interface ListenerAddress {
  address: string
  family: string
  port: number
}

interface HttpServerInstance {
  listening: boolean
  once(event: string, listener: (...args: unknown[]) => void): unknown
  address(): ListenerAddress | string | null
}

interface MockServerInstance {
  httpServer: HttpServerInstance
  projection: MockProjectionInstance
  close(): Promise<void>
}

interface HttpResponse {
  body: unknown
  headers: Record<string, string | string[] | undefined>
}

interface RequestChain {
  set(name: string, value: string): this
  send(body: unknown): this
  expect(status: number): Promise<HttpResponse>
}

interface RequestClient {
  get(path: string): RequestChain
  options(path: string): RequestChain
  post(path: string): RequestChain
}

interface WebSocketClient {
  once(event: string, listener: (...args: unknown[]) => void): this
  send(data: string): void
  close(): void
}

interface WebSocketConstructor {
  new (url: string, options: { origin: string; headers?: Record<string, string> }): WebSocketClient
}

type LoopbackDecision =
  | { allowed: true; peerAddress: '127.0.0.1' }
  | { allowed: false; code: 'LOOPBACK_ONLY'; message: string }

let createMockServer: (options?: { port?: number }) => MockServerInstance
let assertLoopbackRequest: (request: {
  headers: { host?: string; origin?: string }
  socket: { remoteAddress?: string }
}) => LoopbackDecision
let request: (baseUrl: string) => RequestClient
let WebSocket: WebSocketConstructor
let currentServer: MockServerInstance | undefined

beforeAll(async () => {
  const appModulePath = '../../server/' + 'app.js'
  const loopbackModulePath = '../../server/http/' + 'loopback.js'
  const supertestModulePath = 'super' + 'test'
  const wsModulePath = 'w' + 's'
  const appModule = await import(appModulePath) as { createMockServer: typeof createMockServer }
  const loopbackModule = await import(loopbackModulePath) as {
    assertLoopbackRequest: typeof assertLoopbackRequest
  }
  const supertestModule = await import(supertestModulePath) as { default: typeof request }
  const wsModule = await import(wsModulePath) as { WebSocket: WebSocketConstructor }

  ;({ createMockServer } = appModule)
  ;({ assertLoopbackRequest } = loopbackModule)
  ;({ default: request } = supertestModule)
  ;({ WebSocket } = wsModule)
})

function waitForEvent(target: HttpServerInstance | WebSocketClient, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.once(event, () => resolve())
    target.once('error', (error) => reject(error))
  })
}

async function startServer(): Promise<{ server: MockServerInstance; baseUrl: string; wsUrl: string }> {
  const server = createMockServer({ port: 0 })
  currentServer = server
  if (!server.httpServer.listening) {
    await waitForEvent(server.httpServer, 'listening')
  }

  const address = server.httpServer.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP listener address.')
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws/v1`,
  }
}

async function openWebSocket(
  wsUrl: string,
  options: { origin?: string; role?: string } = {},
): Promise<WebSocketClient> {
  const headers = options.role === undefined ? undefined : { 'X-Demo-Role': options.role }
  const client = new WebSocket(wsUrl, {
    origin: options.origin ?? ORIGIN,
    ...(headers === undefined ? {} : { headers }),
  })
  await waitForEvent(client, 'open')
  return client
}

function nextJsonMessage(client: WebSocketClient): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    client.once('message', (...args) => {
      try {
        resolve(JSON.parse(String(args[0])) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    client.once('error', reject)
  })
}

function nextClose(client: WebSocketClient): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    client.once('close', (...args) => resolve({ code: args[0] as number, reason: String(args[1]) }))
  })
}

async function expectRejected(
  wsUrl: string,
  expectedCode: string,
  options: { origin?: string; role?: string; payload?: unknown },
): Promise<void> {
  const client = new WebSocket(wsUrl, {
    origin: options.origin ?? ORIGIN,
    ...(options.role === undefined ? {} : { headers: { 'X-Demo-Role': options.role } }),
  })
  const messagePromise = nextJsonMessage(client)
  const closePromise = nextClose(client)
  await waitForEvent(client, 'open')
  if (options.payload !== undefined) {
    client.send(typeof options.payload === 'string' ? options.payload : JSON.stringify(options.payload))
  }

  const [message, closed] = await Promise.all([messagePromise, closePromise])
  expect(message).toMatchObject({
    type: 'rejected',
    code: expectedCode,
    closeCode: 1008,
  })
  expect(closed.code).toBe(1008)
}

afterEach(async () => {
  const server = currentServer
  currentServer = undefined
  if (server !== undefined) {
    await server.close()
  }
})

describe('P0 deterministic mock server', () => {
  it('binds its listener explicitly to 127.0.0.1', async () => {
    const { server } = await startServer()
    const address = server.httpServer.address()
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP listener address.')
    }

    expect(address.address).toBe('127.0.0.1')
    expect(address.family).toBe('IPv4')
  })

  it('normalizes only the IPv4-mapped loopback peer', () => {
    const headers = { host: '127.0.0.1:4173', origin: ORIGIN }

    expect(assertLoopbackRequest({ headers, socket: { remoteAddress: '::ffff:127.0.0.1' } })).toEqual({
      allowed: true,
      peerAddress: '127.0.0.1',
    })
    expect(assertLoopbackRequest({ headers, socket: { remoteAddress: '::1' } })).toMatchObject({
      allowed: false,
      code: 'LOOPBACK_ONLY',
    })
  })

  it('returns deterministic reset envelopes across repeated cycles', async () => {
    const { baseUrl } = await startServer()
    const sendReset = () => request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ confirm: true })

    const first = await sendReset().expect(200)
    const second = await sendReset().expect(200)

    expect(first.body).toEqual({
      ok: true,
      data: {
        requestId: 'REQ-RESET-001',
        generatedAt: '2026-08-06T08:00:00Z',
        nextSequence: 1,
      },
      meta: {
        requestId: 'REQ-RESET-001',
        generatedAt: '2026-08-06T08:00:00Z',
        page: 1,
        pageSize: 1,
        total: 1,
      },
    })
    expect(second.body).toEqual(first.body)
  })

  it('returns typed errors for invalid reset requests and unmatched API routes', async () => {
    const { baseUrl } = await startServer()

    const invalidBody = await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send({ confirm: false })
      .expect(400)
    expect(invalidBody.body).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })

    const missingRole = await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .send({ confirm: true })
      .expect(403)
    expect(missingRole.body).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })

    const invalidOrigin = await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', 'http://example.test')
      .set('X-Demo-Role', 'ADMIN')
      .send({ confirm: true })
      .expect(403)
    expect(invalidOrigin.body).toMatchObject({ ok: false, error: { code: 'LOOPBACK_ONLY' } })

    const missingRoute = await request(baseUrl)
      .get('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .expect(404)
    expect(missingRoute.body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('allows only the canonical Vite origin to preflight reset', async () => {
    const { baseUrl } = await startServer()

    const allowed = await request(baseUrl)
      .options('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-demo-role')
      .expect(204)
    expect(allowed.headers).toMatchObject({
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'Content-Type, X-Demo-Role',
    })

    const rejected = await request(baseUrl)
      .options('/api/v1/reset')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .expect(403)
    expect(rejected.body).toMatchObject({ ok: false, error: { code: 'LOOPBACK_ONLY' } })
  })

  it('accepts one canonical WebSocket subscription and emits no feature stream', async () => {
    const { wsUrl } = await startServer()
    const client = await openWebSocket(wsUrl, { role: 'ADMIN' })
    const messagePromise = nextJsonMessage(client)

    client.send(JSON.stringify({
      type: 'subscribe',
      schemaVersion: '1.0',
      taskId: 'TASK-001',
      topics: ['simulation.frame', 'runtime.state'],
      lastSequence: 0,
    }))

    await expect(messagePromise).resolves.toEqual({
      type: 'subscribed',
      schemaVersion: '1.0',
      taskId: 'TASK-001',
      topics: ['simulation.frame', 'runtime.state'],
      lastSequence: 0,
      nextSequence: 1,
    })
    const closePromise = nextClose(client)
    client.close()
    await closePromise
  })

  it('rejects invalid WebSocket origin, role, topic, and envelope with close 1008', async () => {
    const { wsUrl } = await startServer()

    await expectRejected(wsUrl, 'LOOPBACK_ONLY', { origin: 'http://localhost:5173', role: 'ADMIN' })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', { role: 'VIEWER' })
    await expectRejected(wsUrl, 'TOPIC_FORBIDDEN', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe',
        schemaVersion: '1.0',
        taskId: 'TASK-001',
        topics: ['node.state'],
      },
    })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe',
        schemaVersion: '2.0',
        taskId: 'TASK-001',
        topics: ['simulation.frame'],
      },
    })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe',
        schemaVersion: '1.0',
        taskId: 'TASK- ',
        topics: ['simulation.frame'],
      },
    })
  })

  it('rejects unknown tasks, unsupported resume gaps, and unsafe sequences', async () => {
    const { wsUrl } = await startServer()

    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe',
        schemaVersion: '1.0',
        taskId: 'TASK-NOT-IN-FIXTURE',
        topics: ['simulation.frame'],
      },
    })
    await expectRejected(wsUrl, 'SEQUENCE_GAP', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe',
        schemaVersion: '1.0',
        taskId: 'TASK-001',
        topics: ['simulation.frame'],
        lastSequence: 1,
      },
    })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe',
        schemaVersion: '1.0',
        taskId: 'TASK-001',
        topics: ['simulation.frame'],
        lastSequence: 9_007_199_254_740_992,
      },
    })
  })

  it('rejects oversized subscriptions without terminating the server', async () => {
    const { baseUrl, wsUrl } = await startServer()

    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'OPERATOR',
      payload: 'x'.repeat(16_385),
    })

    const transportLimitedClient = await openWebSocket(wsUrl, { role: 'OPERATOR' })
    const transportClosePromise = nextClose(transportLimitedClient)
    transportLimitedClient.send('x'.repeat(65_537))
    await expect(transportClosePromise).resolves.toMatchObject({ code: 1009 })

    await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send({ confirm: true })
      .expect(200)
  })

  it('invalidates old WebSockets and resets projection sequence ownership', async () => {
    const { server, baseUrl, wsUrl } = await startServer()
    const client = await openWebSocket(wsUrl, { role: 'OPERATOR' })
    const acknowledgementPromise = nextJsonMessage(client)
    client.send(JSON.stringify({
      type: 'subscribe',
      schemaVersion: '1.0',
      taskId: 'TASK-001',
      topics: ['simulation.frame'],
    }))
    await acknowledgementPromise

    expect(server.projection.nextSequence('TASK-001', 'simulation.frame')).toBe(1)
    expect(server.projection.nextSequence('TASK-001', 'simulation.frame')).toBe(2)

    const closePromise = nextClose(client)
    await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send({ confirm: true })
      .expect(200)

    await expect(closePromise).resolves.toMatchObject({ code: 1008, reason: 'RESET' })
    expect(server.projection.nextSequence('TASK-001', 'simulation.frame')).toBe(1)
  })
})

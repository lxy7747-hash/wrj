import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ApiSuccess, AuditRecord, ConfirmationContext, Report, ScenarioDraft, ScenarioTemplate, ScriptContract, ValidationResult } from '../../src/contracts/domain-models'

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
  close(callback: (error?: Error) => void): this
}

interface IsolatedHttpServerInstance extends HttpServerInstance {
  listen(port: number, host: string): this
  removeAllListeners(): this
}

interface MockServerInstance {
  httpServer: HttpServerInstance
  projection: MockProjectionInstance
  auditSnapshot(): AuditRecord[]
  close(): Promise<void>
}

interface HttpResponse {
  body: unknown
  headers: Record<string, string | string[] | undefined>
}

interface RequestChain {
  set(name: string, value: string): this
  set(fields: Record<string, string>): this
  send(body: unknown): this
  expect(status: number): Promise<HttpResponse>
}

interface RequestClient {
  delete(path: string): RequestChain
  get(path: string): RequestChain
  options(path: string): RequestChain
  post(path: string): RequestChain
  put(path: string): RequestChain
}

interface WebSocketClient {
  once(event: string, listener: (...args: unknown[]) => void): this
  send(data: string | Uint8Array): void
  close(): void
}

interface WebSocketConstructor {
  new (url: string, options: { origin: string; headers?: Record<string, string> }): WebSocketClient
}

interface RealtimeControllerInstance {
  activeClientCount(): number
  invalidateForReset(): void
  close(): Promise<void>
}

type LoopbackDecision =
  | { allowed: true; peerAddress: '127.0.0.1'; origin: string }
  | { allowed: false; code: 'LOOPBACK_ONLY'; message: string }

let createMockServer: (options?: {
  port?: number
  confirmationClock?: { now(): string; expiresAt(createdAt: string): string }
}) => MockServerInstance
let assertLoopbackRequest: (request: {
  headers: { host?: string; origin?: string }
  socket: { remoteAddress?: string }
}) => LoopbackDecision
let request: (baseUrl: string) => RequestClient
let WebSocket: WebSocketConstructor
let createHttpServer: () => IsolatedHttpServerInstance
let MockProjectionConstructor: new () => MockProjectionInstance
let attachRealtimeServer: (
  httpServer: IsolatedHttpServerInstance,
  projection: MockProjectionInstance,
) => RealtimeControllerInstance
let currentServer: MockServerInstance | undefined

beforeAll(async () => {
  const appModulePath = '../../server/' + 'app.js'
  const loopbackModulePath = '../../server/http/' + 'loopback.js'
  const projectionModulePath = '../../server/state/' + 'projection.js'
  const realtimeModulePath = '../../server/ws/' + 'realtime.js'
  const httpModulePath = 'node:' + 'http'
  const supertestModulePath = 'super' + 'test'
  const wsModulePath = 'w' + 's'
  const appModule = await import(appModulePath) as { createMockServer: typeof createMockServer }
  const loopbackModule = await import(loopbackModulePath) as {
    assertLoopbackRequest: typeof assertLoopbackRequest
  }
  const projectionModule = await import(projectionModulePath) as {
    MockProjection: typeof MockProjectionConstructor
  }
  const realtimeModule = await import(realtimeModulePath) as {
    attachRealtimeServer: typeof attachRealtimeServer
  }
  const httpModule = await import(httpModulePath) as { createServer: typeof createHttpServer }
  const supertestModule = await import(supertestModulePath) as { default: typeof request }
  const wsModule = await import(wsModulePath) as { WebSocket: WebSocketConstructor }

  ;({ createMockServer } = appModule)
  ;({ assertLoopbackRequest } = loopbackModule)
  ;({ MockProjection: MockProjectionConstructor } = projectionModule)
  ;({ attachRealtimeServer } = realtimeModule)
  ;({ createServer: createHttpServer } = httpModule)
  ;({ default: request } = supertestModule)
  ;({ WebSocket } = wsModule)
})

function waitForEvent(target: HttpServerInstance | WebSocketClient, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.once(event, () => resolve())
    target.once('error', (error) => reject(error))
  })
}

async function startServer(options: {
  confirmationClock?: { now(): string; expiresAt(createdAt: string): string }
} = {}): Promise<{ server: MockServerInstance; baseUrl: string; wsUrl: string }> {
  const server = createMockServer({ port: 0, ...options })
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

/** 收集指定数量的连续 WebSocket JSON 消息。 */
function nextJsonMessages(client: WebSocketClient, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = []
    const listen = (): void => {
      client.once('message', (...args) => {
        try {
          messages.push(JSON.parse(String(args[0])) as Record<string, unknown>)
          if (messages.length === count) {
            resolve(messages)
          } else {
            listen()
          }
        } catch (error) {
          reject(error)
        }
      })
    }
    listen()
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
  it.each([-1, 0.5, 65_536])('rejects invalid listener port %s', (port) => {
    expect(() => createMockServer({ port })).toThrow(RangeError)
    expect(() => createMockServer({ port })).toThrow(
      'Mock server port must be an integer from 0 through 65535.',
    )
  })

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
      origin: ORIGIN,
    })
    expect(assertLoopbackRequest({ headers, socket: { remoteAddress: '::1' } })).toMatchObject({
      allowed: false,
      code: 'LOOPBACK_ONLY',
    })

    expect(assertLoopbackRequest({
      headers: { host: '127.0.0.1', origin: ORIGIN },
      socket: { remoteAddress: '127.0.0.1' },
    })).toEqual({ allowed: true, peerAddress: '127.0.0.1', origin: ORIGIN })
    for (const host of ['127.0.0.1:0', '127.0.0.1:65536']) {
      expect(assertLoopbackRequest({
        headers: { host, origin: ORIGIN },
        socket: { remoteAddress: '127.0.0.1' },
      })).toMatchObject({ allowed: false, code: 'LOOPBACK_ONLY' })
    }
  })

  it('memoizes close across repeated calls', async () => {
    const { server } = await startServer()

    const firstClose = server.close()
    const secondClose = server.close()

    expect(secondClose).toBe(firstClose)
    await expect(firstClose).resolves.toBeUndefined()
  })

  it('rejects close when the underlying HTTP listener is already closed', async () => {
    const { server } = await startServer()
    await new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => error === undefined ? resolve() : reject(error))
    })

    try {
      await expect(server.close()).rejects.toThrow('Server is not running')
    } finally {
      currentServer = undefined
    }
  })

  it('surfaces a repeated realtime close callback error without leaking listeners', async () => {
    const httpServer = createHttpServer()
    const controller = attachRealtimeServer(httpServer, new MockProjectionConstructor())

    try {
      await expect(controller.close()).resolves.toBeUndefined()
      await expect(controller.close()).rejects.toThrow('The server is not running')
    } finally {
      httpServer.removeAllListeners()
    }
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
      .get('/api/v1/not-found')
      .set('Origin', ORIGIN)
      .expect(404)
    expect(missingRoute.body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('加载、校验、完整保存并全局重置场景草稿', async () => {
    const { server, baseUrl } = await startServer()
    const load = () => request(baseUrl)
      .get('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')

    const loaded = await load().expect(200)
    const original = (loaded.body as { data: ScenarioDraft }).data
    expect(original).toMatchObject({
      revision: 4,
      config: { scenario: { name: '跨海通联演示' } },
      uiExtensions: {
        jammers: [{ jammerId: 'JAM-WB-01-TX' }, { jammerId: 'JAM-SPOT-01-TX' }],
        sensors: [{ sensorId: 'ESM-01', type: 'ESM' }],
      },
    })

    const changed = structuredClone(original.config)
    changed.scenario.name = '台海通联验证场景'
    changed.scenario.environment.humidityPercent = 75
    const saved = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: changed, uiExtensions: original.uiExtensions })
      .expect(200)
    expect((saved.body as { data: ScenarioDraft }).data).toMatchObject({
      revision: 5,
      config: { scenario: { name: '台海通联验证场景', environment: { humidityPercent: 75 } } },
    })

    const invalid = structuredClone(changed)
    invalid.scenario.environment.humidityPercent = 101
    const rejected = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send({ config: invalid, uiExtensions: original.uiExtensions })
      .expect(422)
    expect(rejected.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'scenario.environment.humidityPercent' },
    })

    const platformMutation = structuredClone(changed)
    platformMutation.platforms[0]!.name = '后方指挥节点（更新）'
    const platformSaved = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: platformMutation, uiExtensions: original.uiExtensions })
      .expect(200)
    const platformSavedDraft = (platformSaved.body as { data: ScenarioDraft }).data
    expect(platformSavedDraft.revision).toBe(6)
    expect(platformSavedDraft.config.platforms[0]?.name).toBe('后方指挥节点（更新）')

    const linkMutation = structuredClone(platformSavedDraft.config)
    linkMutation.links[0]!.frequency = 4600
    const linkSaved = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: linkMutation, uiExtensions: original.uiExtensions })
      .expect(200)
    const linkSavedDraft = (linkSaved.body as { data: ScenarioDraft }).data
    expect(linkSavedDraft.revision).toBe(7)
    expect(linkSavedDraft.config.links[0]?.frequency).toBe(4600)

    const jammerMutation = structuredClone(linkSavedDraft.config)
    jammerMutation.jammers[0]!.defaultPower = 0
    jammerMutation.jammers[0]!.detectionRange = 0
    jammerMutation.jammers[0]!.frequency = 0.0001
    jammerMutation.jammers[0]!.bandwidth = Number.MIN_VALUE
    const jammerSaved = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: jammerMutation, uiExtensions: original.uiExtensions })
      .expect(200)
    const jammerSavedDraft = (jammerSaved.body as { data: ScenarioDraft }).data
    expect(jammerSavedDraft.revision).toBe(8)
    expect(jammerSavedDraft.config.jammers[0]).toMatchObject({
      defaultPower: 0,
      detectionRange: 0,
      frequency: 0.0001,
      bandwidth: Number.MIN_VALUE,
    })

    const invalidJammer = structuredClone(jammerMutation)
    invalidJammer.jammers[0]!.detectionRange = -1
    const invalidJammerRejected = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: invalidJammer, uiExtensions: original.uiExtensions })
      .expect(422)
    expect(invalidJammerRejected.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'jammers[0].detectionRange' },
    })

    const invalidPower = structuredClone(jammerMutation)
    invalidPower.jammers[0]!.defaultPower = -1
    const invalidPowerRejected = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: invalidPower, uiExtensions: original.uiExtensions })
      .expect(422)
    expect(invalidPowerRejected.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'jammers[0].defaultPower' },
    })

    const invalidLink = structuredClone(linkMutation)
    invalidLink.links[0]!.bandwidth = 0
    const invalidLinkRejected = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: invalidLink, uiExtensions: original.uiExtensions })
      .expect(422)
    expect(invalidLinkRejected.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'links[0].bandwidth' },
    })

    const overLimit = structuredClone(linkMutation)
    const sourcePlatform = structuredClone(overLimit.platforms[3]!)
    for (let index = 0; index < 45; index += 1) {
      overLimit.platforms.push({
        ...structuredClone(sourcePlatform),
        id: `LIMIT-${String(index + 1).padStart(3, '0')}`,
        name: `容量测试节点 ${index + 1}`,
        linkIds: [],
        sensorIds: [],
        jammerIds: [],
      })
    }
    const limitRejected = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: overLimit, uiExtensions: original.uiExtensions })
      .expect(422)
    expect(limitRejected.body).toMatchObject({
      ok: false,
      error: { code: 'NODE_LIMIT_EXCEEDED', fieldPath: 'platforms' },
    })

    const completeMutation = structuredClone(jammerSavedDraft.config)
    completeMutation.sensors[0]!.detectionRange = 120000
    completeMutation.output.directory = './scene-output'
    completeMutation.informationDemand[0]!.maxLatencyMs = 800
    const completeExtensions = structuredClone(original.uiExtensions)
    completeExtensions.sensors[0]!.probability = 0.8
    const completeSaved = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: completeMutation, uiExtensions: completeExtensions })
      .expect(200)
    expect((completeSaved.body as { data: ScenarioDraft }).data).toMatchObject({
      revision: 9,
      config: {
        sensors: [{ detectionRange: 120000 }],
        output: { directory: './scene-output' },
        informationDemand: [{ maxLatencyMs: 800 }],
      },
      uiExtensions: { sensors: [{ probability: 0.8 }] },
    })

    expect(server.auditSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: 'operator', module: 'SCENARIO_CONFIGURATION', action: 'SCENARIO_UPDATE', result: 'SUCCESS' }),
      expect.objectContaining({ actor: 'admin', module: 'SCENARIO_CONFIGURATION', action: 'SCENARIO_UPDATE', result: 'ERROR' }),
    ]))

    await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send({ confirm: true })
      .expect(200)
    const reset = await load().expect(200)
    expect((reset.body as { data: ScenarioDraft }).data).toMatchObject({
      revision: 4,
      config: { scenario: { name: '跨海通联演示', environment: { humidityPercent: 80 } } },
    })
  })

  it('原子导入完整场景快照并支持场景级撤销和重置', async () => {
    const { baseUrl } = await startServer()
    const load = (scenarioId = 'SCN-001') => request(baseUrl)
      .get(`/api/v1/scenarios/${scenarioId}`)
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
    const original = ((await load().expect(200)).body as { data: ScenarioDraft }).data
    const importedConfig = structuredClone(original.config)
    importedConfig.scenario.id = 'SCN-IMPORT'
    importedConfig.scenario.name = '导入快照场景'

    const importedResponse = await request(baseUrl)
      .post('/api/v1/scenarios/import')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ items: [importedConfig] })
      .expect(200)
    const imported = (importedResponse.body as { data: { imported: number; rejected: number; drafts: ScenarioDraft[] } }).data
    expect(imported).toMatchObject({ imported: 1, rejected: 0, drafts: [{ config: { scenario: { id: 'SCN-IMPORT' } } }] })

    const undone = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-IMPORT/undo')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ expectedRevision: imported.drafts[0]!.revision })
      .expect(200)
    const undoneDraft = (undone.body as { data: ScenarioDraft }).data
    expect(undoneDraft.config.scenario.id).toBe('SCN-001')

    const changed = structuredClone(undoneDraft.config)
    changed.scenario.name = '待重置场景'
    const saved = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: changed, uiExtensions: undoneDraft.uiExtensions })
      .expect(200)
    const savedDraft = (saved.body as { data: ScenarioDraft }).data
    const reset = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-001/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ expectedRevision: savedDraft.revision })
      .expect(200)
    expect((reset.body as { data: ScenarioDraft }).data.config.scenario.name).toBe(original.config.scenario.name)

    const invalidConfig = structuredClone(original.config)
    invalidConfig.output.directory = ''
    await request(baseUrl)
      .post('/api/v1/scenarios/import')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ items: [importedConfig, invalidConfig] })
      .expect(422)
    expect(((await load().expect(200)).body as { data: ScenarioDraft }).data.config.scenario.id).toBe('SCN-001')
  })

  it('按 T-XQ-008 阻断错误、一次确认警告并执行脚本预检', async () => {
    const { server, baseUrl } = await startServer()
    const roleHeaders = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }

    const blocked = await request(baseUrl)
      .post('/api/v1/scripts/preview')
      .set(roleHeaders)
      .send({ scenarioId: 'SCN-001' })
      .expect(428)
    expect(blocked.body).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } })

    const awaitingResponse = await request(baseUrl)
      .post('/api/v1/confirmations')
      .set(roleHeaders)
      .send({ action: 'SCENARIO_WARNING_CONTINUE', objectId: 'SCN-001' })
      .expect(201)
    const awaiting = (awaitingResponse.body as { data: ConfirmationContext }).data
    await request(baseUrl)
      .post(`/api/v1/confirmations/${awaiting.confirmationId}`)
      .set(roleHeaders)
      .send({ confirm: true })
      .expect(200)

    const previewResponse = await request(baseUrl)
      .post('/api/v1/scripts/preview')
      .set(roleHeaders)
      .send({ scenarioId: 'SCN-001', warningConfirmationId: awaiting.confirmationId })
      .expect(200)
    const script = (previewResponse.body as { data: ScriptContract }).data
    expect(script).toMatchObject({ target: 'AFSIM 2.9.0', scenarioId: 'SCN-001', configVersion: 'SCN-001-v4' })
    expect(script.preview).toContain(`output path=`)

    const preflight = await request(baseUrl)
      .post(`/api/v1/scripts/${script.scriptId}/preflight`)
      .set(roleHeaders)
      .send({ checksum: script.checksum })
      .expect(200)
    expect(preflight.body).toMatchObject({ ok: true, data: { valid: true, errors: [], warnings: [] } })
    await request(baseUrl)
      .post(`/api/v1/scripts/${script.scriptId}/preflight`)
      .set(roleHeaders)
      .send({ checksum: 'FNV1A-MOCK-WRONG' })
      .expect(422)
    await request(baseUrl)
      .post('/api/v1/scripts/preview')
      .set(roleHeaders)
      .send({ scenarioId: 'SCN-001', warningConfirmationId: awaiting.confirmationId })
      .expect(409)
    expect(server.auditSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: 'SCRIPT_GENERATION', action: 'SCRIPT_PREVIEW', result: 'SUCCESS' }),
      expect.objectContaining({ module: 'SCRIPT_GENERATION', action: 'SCRIPT_PREVIEW', result: 'ERROR' }),
      expect.objectContaining({ module: 'SCRIPT_GENERATION', action: 'SCRIPT_PREFLIGHT', result: 'SUCCESS' }),
      expect.objectContaining({ module: 'SCRIPT_GENERATION', action: 'SCRIPT_PREFLIGHT', result: 'ERROR' }),
    ]))
  })

  it('拒绝场景快照和脚本端点的损坏请求、冲突及未知对象', async () => {
    const { baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }
    const original = ((await request(baseUrl).get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body as { data: ScenarioDraft }).data

    await request(baseUrl).post('/api/v1/scenarios/SCN-001/undo').set(headers).send({}).expect(422)
    await request(baseUrl).post('/api/v1/scenarios/SCN-001/undo').set(headers).send({ expectedRevision: original.revision }).expect(409)
    await request(baseUrl).post('/api/v1/scenarios/SCN-MISSING/undo').set(headers).send({ expectedRevision: 1 }).expect(404)
    await request(baseUrl).post('/api/v1/scenarios/SCN-001/reset').set(headers).send({ expectedRevision: 0 }).expect(409)
    await request(baseUrl).post('/api/v1/scenarios/SCN-MISSING/reset').set(headers).send({ expectedRevision: 1 }).expect(404)
    await request(baseUrl).post('/api/v1/scenarios/import').set(headers).send({}).expect(422)
    await request(baseUrl).post('/api/v1/scenarios/import').set(headers).send({ items: [] }).expect(422)
    await request(baseUrl).post('/api/v1/scenarios/import').set(headers).send({ items: [{ ...original.config, output: null }] }).expect(422)
    const secondConfig = structuredClone(original.config)
    secondConfig.scenario.id = 'SCN-SECOND'
    await request(baseUrl).post('/api/v1/scenarios/import').set(headers).send({ items: [original.config, secondConfig] }).expect(422)
    await request(baseUrl).post('/api/v1/scripts/preview').set(headers).send({}).expect(422)
    await request(baseUrl).post('/api/v1/scripts/preview').set(headers).send({ scenarioId: 'SCN-MISSING' }).expect(422)
    await request(baseUrl).post('/api/v1/scripts/SCRIPT-MISSING/preflight').set(headers).send({}).expect(422)
    await request(baseUrl).post('/api/v1/scripts/SCRIPT-MISSING/preflight').set(headers).send({ checksum: 'FNV1A-MOCK-MISSING' }).expect(422)
  })

  it('拒绝未携带角色的场景撤销、脚本预览和预检', async () => {
    const { baseUrl } = await startServer()
    await request(baseUrl).post('/api/v1/scenarios/SCN-001/undo').set('Origin', ORIGIN).send({ expectedRevision: 4 }).expect(403)
    await request(baseUrl).post('/api/v1/scripts/preview').set('Origin', ORIGIN).send({ scenarioId: 'SCN-001' }).expect(403)
    await request(baseUrl).post('/api/v1/scripts/SCRIPT-MISSING/preflight').set('Origin', ORIGIN).send({ checksum: 'FNV1A-MOCK-MISSING' }).expect(403)
  })

  it('返回完整场景校验结果且不修改草稿', async () => {
    const { baseUrl } = await startServer()
    const loaded = await request(baseUrl)
      .get('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .expect(200)
    const original = (loaded.body as { data: ScenarioDraft }).data

    const warningResponse = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-001/validate')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: original.config })
      .expect(200)
    expect((warningResponse.body as { data: ValidationResult }).data).toMatchObject({
      valid: true,
      errors: [],
      warnings: [{ severity: 'WARNING', fieldPath: 'scenario.environment.rainLossDbPerKm' }],
    })

    const invalid = structuredClone(original.config)
    invalid.links[0]!.txPower = -1
    const invalidResponse = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-001/validate')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send({ config: invalid })
      .expect(200)
    expect((invalidResponse.body as { data: ValidationResult }).data).toMatchObject({
      valid: false,
      errors: [{ severity: 'ERROR', fieldPath: 'links[0].txPower' }],
    })

    const malformed = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-001/validate')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: original.config, extra: true })
      .expect(422)
    expect(malformed.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', fieldPath: 'request' } })

    const mismatchedConfig = structuredClone(original.config)
    mismatchedConfig.scenario.id = 'SCN-OTHER'
    const mismatched = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-001/validate')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: mismatchedConfig })
      .expect(200)
    expect((mismatched.body as { data: ValidationResult }).data).toMatchObject({
      valid: false,
      errors: [{ code: 'SCENARIO_ID_MISMATCH', fieldPath: 'scenario.id' }],
    })

    const missing = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-UNKNOWN/validate')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: original.config })
      .expect(404)
    expect(missing.body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })

    const afterValidation = await request(baseUrl)
      .get('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .expect(200)
    expect((afterValidation.body as { data: ScenarioDraft }).data).toEqual(original)
  })

  it('按角色完成模板七类动作并保护被引用模板', async () => {
    const { baseUrl } = await startServer()
    const operator = (chain: RequestChain) => chain.set('Origin', ORIGIN).set('X-Demo-Role', 'OPERATOR')
    const admin = (chain: RequestChain) => chain.set('Origin', ORIGIN).set('X-Demo-Role', 'ADMIN')
    const originalDraft = ((await operator(request(baseUrl).get('/api/v1/scenarios/SCN-001')).expect(200)).body as { data: ScenarioDraft }).data

    await request(baseUrl).get('/api/v1/templates').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).get('/api/v1/templates/TPL-SCN-001').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).post('/api/v1/templates/TPL-SCN-001/copy').set('Origin', ORIGIN).send({ name: '副本' }).expect(403)
    await operator(request(baseUrl).put('/api/v1/templates/TPL-SCN-001'))
      .send({ name: '越权更新', config: originalDraft.config })
      .expect(403)
    await operator(request(baseUrl).post('/api/v1/confirmations'))
      .send({ action: 'OFFICIAL_TEMPLATE_DELETE', objectId: 'TPL-SCN-001' })
      .expect(403)
    await operator(request(baseUrl).post('/api/v1/confirmations/CONF-NOT-FOUND')).send({ confirm: true }).expect(409)
    await admin(request(baseUrl).post('/api/v1/confirmations/CONF-NOT-FOUND')).send({ confirm: true }).expect(409)
    await operator(request(baseUrl).delete('/api/v1/templates/TPL-SCN-001')).expect(403)
    await admin(request(baseUrl).delete('/api/v1/templates/TPL-NOT-FOUND')).expect(404)

    const listed = await operator(request(baseUrl).get('/api/v1/templates')).expect(200)
    expect((listed.body as { data: ScenarioTemplate[] }).data).toMatchObject([
      { templateId: 'TPL-SCN-001', version: '4', official: true, referenceCount: 2 },
    ])
    await operator(request(baseUrl).post('/api/v1/templates'))
      .send({ name: '操作员越权模板', config: originalDraft.config })
      .expect(403)

    const operatorConfirmationResponse = await operator(request(baseUrl).post('/api/v1/confirmations'))
      .send({ action: 'SCENARIO_WARNING_CONTINUE', objectId: 'SCN-001' })
      .expect(201)
    const operatorConfirmation = (operatorConfirmationResponse.body as { data: ConfirmationContext }).data
    expect(operatorConfirmation.role).toBe('OPERATOR')
    await operator(request(baseUrl).post(`/api/v1/confirmations/${operatorConfirmation.confirmationId}`))
      .send({ confirm: true })
      .expect(200)

    const createdResponse = await admin(request(baseUrl).post('/api/v1/templates'))
      .send({ name: '台海验证模板', config: originalDraft.config })
      .expect(201)
    const created = (createdResponse.body as { data: ScenarioTemplate }).data
    expect(created).toMatchObject({ templateId: 'TPL-SCN-002', version: '1', referenceCount: 0 })
    await admin(request(baseUrl).post('/api/v1/templates'))
      .send({ name: created.name, config: originalDraft.config })
      .expect(409)
    await admin(request(baseUrl).post('/api/v1/templates'))
      .send({ name: '', config: originalDraft.config })
      .expect(422)
    await admin(request(baseUrl).post('/api/v1/templates'))
      .send({ name: '多余字段模板', config: originalDraft.config, extra: true })
      .expect(422)
    const invalidTemplateConfig = structuredClone(originalDraft.config)
    invalidTemplateConfig.links[0]!.txPower = -1
    await admin(request(baseUrl).post('/api/v1/templates'))
      .send({ name: '非法配置模板', config: invalidTemplateConfig })
      .expect(422)

    const updatedResponse = await admin(request(baseUrl).put(`/api/v1/templates/${created.templateId}`))
      .send({ name: '台海验证模板 V2', config: originalDraft.config })
      .expect(200)
    expect((updatedResponse.body as { data: ScenarioTemplate }).data).toMatchObject({ version: '2', name: '台海验证模板 V2' })
    await admin(request(baseUrl).put(`/api/v1/templates/${created.templateId}`))
      .send({ name: '跨海通联演示官方基线', config: originalDraft.config })
      .expect(409)
    await admin(request(baseUrl).put('/api/v1/templates/TPL-NOT-FOUND'))
      .send({ name: '不存在', config: originalDraft.config })
      .expect(404)

    const copiedResponse = await operator(request(baseUrl).post(`/api/v1/templates/${created.templateId}/copy`))
      .send({ name: '操作员临时场景' })
      .expect(201)
    expect((copiedResponse.body as { data: ScenarioDraft }).data.config.scenario.name).toBe('操作员临时场景')
    expect(((await operator(request(baseUrl).get('/api/v1/scenarios/SCN-001')).expect(200)).body as { data: ScenarioDraft }).data.config.scenario.name)
      .toBe('操作员临时场景')
    await operator(request(baseUrl).post(`/api/v1/templates/${created.templateId}/copy`)).send({ name: '' }).expect(422)
    await operator(request(baseUrl).post('/api/v1/templates/TPL-NOT-FOUND/copy')).send({ name: '临时场景' }).expect(404)

    await admin(request(baseUrl).delete(`/api/v1/templates/${created.templateId}`)).expect(428)
    await admin(request(baseUrl).delete(`/api/v1/templates/${created.templateId}`))
      .set('X-Confirmation-Id', 'CONF-NOT-FOUND')
      .expect(409)
    await admin(request(baseUrl).post('/api/v1/confirmations')).send({ action: 'UNKNOWN', objectId: created.templateId }).expect(400)
    const confirmationResponse = await admin(request(baseUrl).post('/api/v1/confirmations'))
      .send({ action: 'OFFICIAL_TEMPLATE_DELETE', objectId: created.templateId })
      .expect(201)
    const confirmation = (confirmationResponse.body as { data: ConfirmationContext }).data
    expect(confirmation.state).toBe('AWAITING_CONFIRMATION')
    await admin(request(baseUrl).post(`/api/v1/confirmations/${confirmation.confirmationId}`)).send({ confirm: false }).expect(400)
    await operator(request(baseUrl).post(`/api/v1/confirmations/${confirmation.confirmationId}`)).send({ confirm: true }).expect(403)
    await admin(request(baseUrl).post(`/api/v1/confirmations/${confirmation.confirmationId}`)).send({ confirm: true }).expect(200)
    await admin(request(baseUrl).post(`/api/v1/confirmations/${confirmation.confirmationId}`)).send({ confirm: true }).expect(409)
    await admin(request(baseUrl).delete('/api/v1/templates/TPL-SCN-001'))
      .set('X-Confirmation-Id', confirmation.confirmationId)
      .expect(409)
    await admin(request(baseUrl).delete(`/api/v1/templates/${created.templateId}`))
      .set('X-Confirmation-Id', confirmation.confirmationId)
      .expect(200)
    await admin(request(baseUrl).get(`/api/v1/templates/${created.templateId}`)).expect(404)

    const referencedConfirmationResponse = await admin(request(baseUrl).post('/api/v1/confirmations'))
      .send({ action: 'OFFICIAL_TEMPLATE_DELETE', objectId: 'TPL-SCN-001' })
      .expect(201)
    const referencedConfirmation = (referencedConfirmationResponse.body as { data: ConfirmationContext }).data
    await admin(request(baseUrl).post(`/api/v1/confirmations/${referencedConfirmation.confirmationId}`)).send({ confirm: true }).expect(200)
    const rejectedDelete = await admin(request(baseUrl).delete('/api/v1/templates/TPL-SCN-001'))
      .set('X-Confirmation-Id', referencedConfirmation.confirmationId)
      .expect(409)
    expect(rejectedDelete.body).toMatchObject({ error: { code: 'CONFLICT', fieldPath: 'referenceCount' } })
    expect((await admin(request(baseUrl).get('/api/v1/templates/TPL-SCN-001')).expect(200)).body)
      .toMatchObject({ data: { referenceCount: 2 } })
  })

  it('确认上下文到期后接口拒绝继续确认', async () => {
    let now = '2026-08-06T08:00:00Z'
    const { baseUrl } = await startServer({
      confirmationClock: { now: () => now, expiresAt: () => '2026-08-06T08:05:00Z' },
    })
    const create = await request(baseUrl).post('/api/v1/confirmations')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ action: 'SCENARIO_WARNING_CONTINUE', objectId: 'SCN-001' })
      .expect(201)
    const context = (create.body as { data: ConfirmationContext }).data

    now = context.expiresAt
    const expired = await request(baseUrl).post(`/api/v1/confirmations/${context.confirmationId}`)
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ confirm: true })
      .expect(409)
    expect(expired.body).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } })
  })

  it('直接 PUT 忽略客户端链路和干扰设备反向关联并持久化规范结果', async () => {
    const { baseUrl } = await startServer()
    const load = () => request(baseUrl)
      .get('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
    const original = (await load().expect(200)).body as { data: ScenarioDraft }
    const inconsistent = structuredClone(original.data.config)
    inconsistent.links[0]!.targetPlatformId = 'AIR-02'
    inconsistent.jammers[0]!.platformId = 'AIR-01'
    inconsistent.platforms.forEach((platform) => {
      platform.linkIds = ['CLIENT-OWNED']
      platform.jammerIds = ['CLIENT-OWNED']
    })

    const response = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: inconsistent, uiExtensions: original.data.uiExtensions })
      .expect(200)
    const saved = (response.body as { data: ScenarioDraft }).data
    expect(saved.revision).toBe(original.data.revision + 1)
    saved.config.platforms.forEach((platform) => {
      expect(platform.linkIds).toEqual(saved.config.links
        .filter((link) => link.sourcePlatformId === platform.id || link.targetPlatformId === platform.id)
        .map((link) => link.id))
      expect(platform.jammerIds).toEqual(saved.config.jammers
        .filter((jammer) => jammer.platformId === platform.id)
        .map((jammer) => jammer.id))
    })
    expect((await load().expect(200)).body).toMatchObject({ data: saved })

    const malformed = structuredClone(saved.config)
    delete (malformed.platforms[0] as unknown as Record<string, unknown>).name
    const rejected = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: malformed, uiExtensions: saved.uiExtensions })
      .expect(422)
    expect(rejected.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'platforms[0]' },
    })
    expect((await load().expect(200)).body).toMatchObject({ data: saved })
  })

  it('按设备 ID 原子保存界面扩展并拒绝不匹配和越界字段', async () => {
    const { baseUrl } = await startServer()
    const load = () => request(baseUrl)
      .get('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
    const original = ((await load().expect(200)).body as { data: ScenarioDraft }).data

    const malformedWrapper = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: original.config })
      .expect(422)
    expect(malformedWrapper.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'request' },
    })

    const mismatchedIdConfig = structuredClone(original.config)
    mismatchedIdConfig.scenario.id = 'SCN-OTHER'
    const mismatchedId = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: mismatchedIdConfig, uiExtensions: original.uiExtensions })
      .expect(422)
    expect(mismatchedId.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'scenario.id' },
    })
    expect(((await load().expect(200)).body as { data: ScenarioDraft }).data).toEqual(original)

    const changedExtensions = structuredClone(original.uiExtensions)
    changedExtensions.jammers.reverse()
    changedExtensions.jammers.find((extension) => extension.jammerId === 'JAM-SPOT-01-TX')!.direction = 360
    changedExtensions.jammers.find((extension) => extension.jammerId === 'JAM-WB-01-TX')!.enabled = false
    changedExtensions.sensors[0]!.probability = 0.8

    const savedResponse = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: original.config, uiExtensions: changedExtensions })
      .expect(200)
    const saved = (savedResponse.body as { data: ScenarioDraft }).data
    expect(saved.revision).toBe(original.revision + 1)
    expect(saved.uiExtensions).toEqual(changedExtensions)

    const invalidCases = [
      {
        fieldPath: 'uiExtensions.jammers',
        uiExtensions: { ...changedExtensions, jammers: [changedExtensions.jammers[0]] },
      },
      {
        fieldPath: 'uiExtensions.jammers[0].duration',
        uiExtensions: {
          ...changedExtensions,
          jammers: [{ ...changedExtensions.jammers[0]!, duration: -1 }, changedExtensions.jammers[1]],
        },
      },
      {
        fieldPath: 'uiExtensions.sensors[0]',
        uiExtensions: { ...changedExtensions, sensors: [{ sensorId: 'ESM-01' }] },
      },
    ]
    for (const invalid of invalidCases) {
      const rejected = await request(baseUrl)
        .put('/api/v1/scenarios/SCN-001')
        .set('Origin', ORIGIN)
        .set('X-Demo-Role', 'OPERATOR')
        .send({ config: saved.config, uiExtensions: invalid.uiExtensions })
        .expect(422)
      expect(rejected.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', fieldPath: invalid.fieldPath } })
      expect(((await load().expect(200)).body as { data: ScenarioDraft }).data).toEqual(saved)
    }
  })

  it('rejects missing roles and unknown scenario identifiers', async () => {
    const { baseUrl } = await startServer()

    const denied = await request(baseUrl)
      .get('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .expect(403)
    expect(denied.body).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })

    const missing = await request(baseUrl)
      .get('/api/v1/scenarios/SCN-NOT-FOUND')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .expect(404)
    expect(missing.body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('returns a typed error with parser details for malformed strict JSON', async () => {
    const { baseUrl } = await startServer()

    const response = await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400)

    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', details: expect.any(String) },
    })
  })

  it('accepts JSON bodies above 16KB and reaches reset validation', async () => {
    const { baseUrl } = await startServer()
    const body = { confirm: false, padding: 'x'.repeat(17_000) }
    const bodyLength = JSON.stringify(body).length
    expect(bodyLength).toBeGreaterThan(16 * 1024)
    expect(bodyLength).toBeLessThan(256 * 1024)

    const response = await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send(body)
      .expect(400)

    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', fieldPath: 'confirm' },
    })
  })

  it.each(['GET', 'PUT', 'DELETE'] as const)(
    'preflights arbitrary API paths for %s',
    async (method) => {
      const { baseUrl } = await startServer()

      const response = await request(baseUrl)
        .options(`/api/arbitrary/${method.toLowerCase()}/path`)
        .set('Origin', ORIGIN)
        .set('Access-Control-Request-Method', method)
        .set('Access-Control-Request-Headers', 'content-type,x-demo-role')
        .expect(204)

      expect(response.headers['access-control-allow-origin']).toBe(ORIGIN)
      expect(response.headers['access-control-allow-methods']).toBe(
        'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      )
      expect(response.headers['access-control-allow-headers']).toBe('Content-Type, X-Demo-Role, X-Confirmation-Id')
      expect(response.headers.vary).toBe('Origin')
    },
  )

  it('rejects invalid-origin preflight before setting CORS headers', async () => {
    const { baseUrl } = await startServer()

    const rejected = await request(baseUrl)
      .options('/api/arbitrary/delete/path')
      .set('Origin', 'http://127.0.0.1:5174')
      .set('Access-Control-Request-Method', 'DELETE')
      .expect(403)
    expect(rejected.body).toMatchObject({ ok: false, error: { code: 'LOOPBACK_ONLY' } })
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined()
    expect(rejected.headers['access-control-allow-methods']).toBeUndefined()
  })

  it('accepts one canonical WebSocket subscription and emits initial topic snapshots', async () => {
    const { wsUrl } = await startServer()
    const client = await openWebSocket(wsUrl, { role: 'ADMIN' })
    const messagePromise = nextJsonMessages(client, 4)

    client.send(JSON.stringify({
      type: 'subscribe',
      schemaVersion: '1.0',
      taskId: 'TASK-001',
      topics: ['simulation.frame', 'runtime.state', 'jammer.event'],
      lastSequence: 0,
    }))

    const messages = await messagePromise
    expect(messages[0]).toEqual({
      type: 'subscribed',
      schemaVersion: '1.0',
      taskId: 'TASK-001',
      topics: ['simulation.frame', 'runtime.state', 'jammer.event'],
      lastSequence: 0,
      nextSequence: 1,
    })
    expect(messages[1]).toMatchObject({
      type: 'event', topic: 'simulation.frame', sequence: 1, frameId: 'F-00042', payload: { frameId: 'F-00042' },
    })
    expect(messages[2]).toMatchObject({
      type: 'event', topic: 'runtime.state', sequence: 1, payload: { status: 'COMPLETED' },
    })
    expect(messages[3]).toMatchObject({
      type: 'event', topic: 'jammer.event', sequence: 1, frameId: 'F-00042',
      simulationTime: 42, payload: { eventId: 'DET-042', type: 'DETECTION', sensorId: 'ESM-01' },
    })
    const closePromise = nextClose(client)
    client.close()
    await closePromise
  })

  it('replays one cached topic envelope to later clients without creating a sequence gap', async () => {
    const { baseUrl, wsUrl } = await startServer()
    const firstClient = await openWebSocket(wsUrl, { role: 'OPERATOR' })
    const firstInitial = nextJsonMessages(firstClient, 2)
    firstClient.send(JSON.stringify({
      type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['runtime.state'], lastSequence: 0,
    }))
    const firstMessages = await firstInitial

    const secondClient = await openWebSocket(wsUrl, { role: 'OPERATOR' })
    const secondInitial = nextJsonMessages(secondClient, 2)
    secondClient.send(JSON.stringify({
      type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['runtime.state'], lastSequence: 0,
    }))
    const secondMessages = await secondInitial

    expect(firstMessages[1]).toMatchObject({ topic: 'runtime.state', sequence: 1, payload: { status: 'COMPLETED' } })
    expect(secondMessages[1]).toEqual(firstMessages[1])

    const firstBroadcast = nextJsonMessage(firstClient)
    const secondBroadcast = nextJsonMessage(secondClient)
    await request(baseUrl)
      .post('/api/v1/simulations')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
      .expect(201)
    await expect(firstBroadcast).resolves.toMatchObject({ topic: 'runtime.state', sequence: 2, payload: { status: 'IDLE' } })
    await expect(secondBroadcast).resolves.toMatchObject({ topic: 'runtime.state', sequence: 2, payload: { status: 'IDLE' } })

    firstClient.close()
    secondClient.close()
  })

  it('accepts the native-browser role query adapter on the canonical WebSocket path', async () => {
    const { wsUrl } = await startServer()
    const client = await openWebSocket(`${wsUrl}?role=OPERATOR`)
    const messagesPromise = nextJsonMessages(client, 2)
    client.send(JSON.stringify({
      type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['link.metric'], lastSequence: 0,
    }))
    const messages = await messagesPromise
    expect(messages[0]).toMatchObject({ type: 'subscribed', topics: ['link.metric'] })
    expect(messages[1]).toMatchObject({ topic: 'link.metric', frameId: 'F-00042' })
    expect((messages[1]?.payload as Array<{ linkType: string }>)[0]).toMatchObject({ linkType: 'MICROWAVE' })
    client.close()
  })

  it('publishes runtime.state after a successful REST control mutation', async () => {
    const { baseUrl, wsUrl } = await startServer()
    const client = await openWebSocket(wsUrl, { role: 'OPERATOR' })
    const initialMessages = nextJsonMessages(client, 2)
    client.send(JSON.stringify({
      type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['runtime.state'], lastSequence: 0,
    }))
    await initialMessages

    const runtimeMessage = nextJsonMessage(client)
    await request(baseUrl)
      .post('/api/v1/simulations')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
      .expect(201)
    await expect(runtimeMessage).resolves.toMatchObject({
      topic: 'runtime.state', sequence: 2, payload: { status: 'IDLE' },
    })
    client.close()
  })

  it('destroys upgrades for non-canonical WebSocket paths', async () => {
    const { wsUrl } = await startServer()
    const client = new WebSocket(wsUrl.replace('/ws/v1', '/ws/not-canonical'), {
      origin: ORIGIN,
      headers: { 'X-Demo-Role': 'ADMIN' },
    })
    const closePromise = nextClose(client)
    const errorPromise = new Promise<void>((resolve, reject) => {
      client.once('error', () => resolve())
      client.once('open', () => reject(new Error('Non-canonical WebSocket path opened.')))
    })

    await expect(errorPromise).resolves.toBeUndefined()
    await expect(closePromise).resolves.toMatchObject({ code: 1006 })
  })

  it('tracks active clients through reset invalidation', async () => {
    const httpServer = createHttpServer()
    const controller = attachRealtimeServer(httpServer, new MockProjectionConstructor())

    try {
      httpServer.listen(0, '127.0.0.1')
      await waitForEvent(httpServer, 'listening')

      const address = httpServer.address()
      if (address === null || typeof address === 'string') {
        throw new Error('Expected a TCP listener address.')
      }

      expect(controller.activeClientCount()).toBe(0)
      const client = await openWebSocket(`ws://127.0.0.1:${address.port}/ws/v1`, { role: 'ADMIN' })
      expect(controller.activeClientCount()).toBe(1)
      const initialMessages = nextJsonMessages(client, 2)
      client.send(JSON.stringify({
        type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['runtime.state'], lastSequence: 0,
      }))
      await expect(initialMessages).resolves.toEqual([
        expect.objectContaining({ type: 'subscribed' }),
        expect.objectContaining({ topic: 'runtime.state', sequence: 1, payload: expect.objectContaining({ status: 'COMPLETED' }) }),
      ])
      const closePromise = nextClose(client)

      controller.invalidateForReset()
      expect(controller.activeClientCount()).toBe(0)
      await expect(closePromise).resolves.toMatchObject({ code: 1008, reason: 'RESET' })
    } finally {
      try {
        await controller.close()
      } finally {
        if (httpServer.listening) {
          await new Promise<void>((resolve, reject) => {
            httpServer.close((error) => error === undefined ? resolve() : reject(error))
          })
        }
        httpServer.removeAllListeners()
      }
    }
  })

  it('rejects a second subscription on an already subscribed client', async () => {
    const { wsUrl } = await startServer()
    const client = await openWebSocket(wsUrl, { role: 'OPERATOR' })
    const firstMessagePromise = nextJsonMessage(client)
    const subscription = {
      type: 'subscribe',
      schemaVersion: '1.0',
      taskId: 'TASK-001',
      topics: ['simulation.frame'],
    }

    client.send(JSON.stringify(subscription))
    await expect(firstMessagePromise).resolves.toMatchObject({ type: 'subscribed' })

    const secondMessagePromise = nextJsonMessage(client)
    const closePromise = nextClose(client)
    client.send(JSON.stringify(subscription))

    await expect(secondMessagePromise).resolves.toMatchObject({
      type: 'rejected',
      code: 'INVALID_ENVELOPE',
      closeCode: 1008,
    })
    await expect(closePromise).resolves.toMatchObject({ code: 1008 })
  })

  it('rejects binary subscriptions and duplicate topics', async () => {
    const { wsUrl } = await startServer()
    const binaryClient = await openWebSocket(wsUrl, { role: 'ADMIN' })
    const binaryMessagePromise = nextJsonMessage(binaryClient)
    const binaryClosePromise = nextClose(binaryClient)
    binaryClient.send(new Uint8Array([1, 2, 3]))

    await expect(binaryMessagePromise).resolves.toMatchObject({
      type: 'rejected',
      code: 'INVALID_ENVELOPE',
    })
    await expect(binaryClosePromise).resolves.toMatchObject({ code: 1008 })

    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'ADMIN',
      payload: {
        type: 'subscribe',
        schemaVersion: '1.0',
        taskId: 'TASK-001',
        topics: ['simulation.frame', 'simulation.frame'],
      },
    })
  })

  it('rejects invalid WebSocket origin, role, topic, and envelope with close 1008', async () => {
    const { wsUrl } = await startServer()

    await expectRejected(wsUrl, 'LOOPBACK_ONLY', { origin: 'http://127.0.0.1:5174', role: 'ADMIN' })
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
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', { role: 'OPERATOR', payload: null })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', { role: 'OPERATOR', payload: [] })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['simulation.frame'], extra: true,
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

    expect(server.projection.nextSequence('TASK-001', 'simulation.frame')).toBe(2)
    expect(server.projection.nextSequence('TASK-001', 'simulation.frame')).toBe(3)

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

  it('returns P3 same-frame telemetry and events through role-protected REST routes', async () => {
    const { baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }
    const frame = await request(baseUrl)
      .get('/api/v1/simulations/RUN-001/frames/F-00042')
      .set(headers)
      .expect(200)
    expect(frame.body).toMatchObject({ ok: true, data: { frameId: 'F-00042', runId: 'RUN-001', simulationTime: 42 } })

    const events = await request(baseUrl)
      .get('/api/v1/simulations/RUN-001/events')
      .set(headers)
      .expect(200)
    expect(events.body).toMatchObject({ ok: true, data: [{ frameId: 'F-00042' }, { frameId: 'F-00042' }], meta: { total: 2 } })

    await request(baseUrl).get('/api/v1/simulations/RUN-001/frames/F-MISSING').set(headers).expect(404)
    await request(baseUrl).get('/api/v1/simulations/RUN-MISSING/events').set(headers).expect(404)
    await request(baseUrl).get('/api/v1/simulations/RUN-001/events').set('Origin', ORIGIN).expect(403)
  })

  it('executes P3 simulation commands and keeps the scenario lock lifecycle consistent', async () => {
    const { server, baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }

    const initialRuns = await request(baseUrl).get('/api/v1/simulations').set(headers).expect(200)
    expect((initialRuns.body as { data: Array<{ uiStatus: string }> }).data[0]?.uiStatus).toBe('COMPLETED')

    const created = await request(baseUrl)
      .post('/api/v1/simulations')
      .set(headers)
      .send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
      .expect(201)
    expect(created.body).toMatchObject({ data: { runId: 'RUN-001', uiStatus: 'IDLE', configLocked: true } })

    const lockedScenario = await request(baseUrl).get('/api/v1/scenarios/SCN-001').set(headers).expect(200)
    expect((lockedScenario.body as { data: ScenarioDraft }).data.locked).toBe(true)
    await request(baseUrl)
      .post('/api/v1/scenarios/SCN-001/validate')
      .set(headers)
      .send({ config: (lockedScenario.body as { data: ScenarioDraft }).data.config })
      .expect(409)

    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'START', mode: 'INTERACTIVE_SINGLE' })
      .expect(200)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'PAUSE' })
      .expect(200)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'STEP', stepCount: 1 })
      .expect(200)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'STOP' })
      .expect(428)

    const awaitingResponse = await request(baseUrl)
      .post('/api/v1/confirmations')
      .set(headers)
      .send({ action: 'SIMULATION_STOP', objectId: 'RUN-001' })
      .expect(201)
    const awaiting = (awaitingResponse.body as { data: ConfirmationContext }).data
    await request(baseUrl)
      .post(`/api/v1/confirmations/${awaiting.confirmationId}`)
      .set(headers)
      .send({ confirm: true })
      .expect(200)
    const stopped = await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'STOP', confirmationId: awaiting.confirmationId })
      .expect(200)
    expect(stopped.body).toMatchObject({
      data: {
        uiStatus: 'STOPPED',
        configLocked: false,
        canonical: { status: 'IDLE', currentTime: 0, progress: 0 },
      },
    })

    const unlockedScenario = await request(baseUrl).get('/api/v1/scenarios/SCN-001').set(headers).expect(200)
    expect((unlockedScenario.body as { data: ScenarioDraft }).data.locked).toBe(false)

    await request(baseUrl)
      .post('/api/v1/simulations')
      .set({ Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' })
      .send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
      .expect(201)
    expect(server.auditSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: 'SIMULATION_CONTROL', action: 'SIMULATION_CREATE', result: 'SUCCESS' }),
      expect.objectContaining({ module: 'SIMULATION_CONTROL', action: 'SIMULATION_COMMAND', result: 'SUCCESS' }),
      expect.objectContaining({ module: 'SIMULATION_CONTROL', action: 'SIMULATION_COMMAND', result: 'ERROR' }),
    ]))
  })

  it('returns typed P3 simulation permission, request, lookup, transition and confirmation errors', async () => {
    const { baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }

    await request(baseUrl).get('/api/v1/simulations').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).post('/api/v1/simulations').set('Origin', ORIGIN).send({}).expect(403)
    await request(baseUrl).get('/api/v1/simulations/RUN-001').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).post('/api/v1/simulations/RUN-001/commands').set('Origin', ORIGIN).send({ command: 'PAUSE' }).expect(403)

    await request(baseUrl).post('/api/v1/simulations').set(headers).send({}).expect(422)
    await request(baseUrl).get('/api/v1/simulations/RUN-MISSING').set(headers).expect(404)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-MISSING/commands')
      .set(headers)
      .send({ command: 'PAUSE' })
      .expect(404)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'PAUSE' })
      .expect(409)

    await request(baseUrl)
      .post('/api/v1/simulations')
      .set(headers)
      .send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
      .expect(201)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'START', mode: 'INTERACTIVE_SINGLE' })
      .expect(200)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'STOP', confirmationId: 'CONF-MISSING' })
      .expect(409)
  })

  it('提供 P3 单次与批量报告读取，并执行分级导出验证', async () => {
    const { baseUrl } = await startServer()
    const operatorHeaders = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }
    const adminHeaders = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }

    const list = await request(baseUrl).get('/api/v1/reports').set(operatorHeaders).expect(200)
    expect(list.body).toMatchObject({
      ok: true,
      data: [{ reportId: 'RPT-001', classification: 'LEVEL_II' }, { reportId: 'RPT-BATCH-001', classification: 'LEVEL_III' }],
      meta: { total: 2 },
    })
    const report = await request(baseUrl).get('/api/v1/reports/RPT-001').set(operatorHeaders).expect(200)
    const reportBody = report.body as ApiSuccess<Report>
    expect(reportBody.data.timeSeries).toMatchObject([
      { linkId: 'L-MW-01', sourcePlatformId: 'UAV-01', targetPlatformId: 'GCC-01' },
    ])
    expect(reportBody.data.timeSeries?.[0].points).toHaveLength(3)
    await request(baseUrl).get('/api/v1/reports/RPT-BATCH-001').set(operatorHeaders).expect(200)
    await request(baseUrl).get('/api/v1/reports/RPT-MISSING').set(operatorHeaders).expect(404)
    await request(baseUrl).get('/api/v1/reports').set('Origin', ORIGIN).expect(403)

    const ordinary = await request(baseUrl)
      .post('/api/v1/reports/RPT-001/export')
      .set(operatorHeaders)
      .send({ reportId: 'RPT-001', format: 'HTML' })
      .expect(200)
    expect(ordinary.body).toMatchObject({
      data: { reportId: 'RPT-001', generated: false, status: 'FIXTURE_SUCCESS', verifiedAt: '2026-08-06T10:06:30Z' },
    })

    await request(baseUrl)
      .post('/api/v1/reports/RPT-BATCH-001/export')
      .set(operatorHeaders)
      .send({ reportId: 'RPT-BATCH-001', format: 'CSV' })
      .expect(403)
    await request(baseUrl)
      .post('/api/v1/reports/RPT-BATCH-001/export')
      .set(adminHeaders)
      .send({ reportId: 'RPT-BATCH-001', format: 'PDF' })
      .expect(428)

    const awaitingResponse = await request(baseUrl)
      .post('/api/v1/confirmations')
      .set(adminHeaders)
      .send({ action: 'BATCH_LEVEL_III_EXPORT', objectId: 'RPT-BATCH-001' })
      .expect(201)
    const awaiting = (awaitingResponse.body as { data: ConfirmationContext }).data
    await request(baseUrl)
      .post(`/api/v1/confirmations/${awaiting.confirmationId}`)
      .set(adminHeaders)
      .send({ confirm: true })
      .expect(200)
    const aggregate = await request(baseUrl)
      .post('/api/v1/reports/RPT-BATCH-001/export')
      .set(adminHeaders)
      .send({ reportId: 'RPT-BATCH-001', format: 'PDF', confirmationId: awaiting.confirmationId })
      .expect(200)
    expect(aggregate.body).toMatchObject({
      data: { reportId: 'RPT-BATCH-001', generated: false, verifiedAt: '2026-08-06T10:08:00Z' },
    })
    await request(baseUrl)
      .post('/api/v1/reports/RPT-BATCH-001/export')
      .set(adminHeaders)
      .send({ reportId: 'RPT-BATCH-001', format: 'PDF', confirmationId: awaiting.confirmationId })
      .expect(409)
  })

  it('拒绝 P3 报告导出的无角色、无效请求和未知报告', async () => {
    const { baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }
    await request(baseUrl)
      .post('/api/v1/reports/RPT-001/export')
      .set('Origin', ORIGIN)
      .send({ reportId: 'RPT-001', format: 'HTML' })
      .expect(403)
    for (const body of [
      {},
      { reportId: 'RPT-WRONG', format: 'HTML' },
      { reportId: 'RPT-001', format: 'DOCX' },
      { reportId: 'RPT-001', format: 'HTML', confirmationId: '' },
      { reportId: 'RPT-001', format: 'HTML', extra: true },
    ]) {
      await request(baseUrl).post('/api/v1/reports/RPT-001/export').set(headers).send(body).expect(422)
    }
    await request(baseUrl)
      .post('/api/v1/reports/RPT-MISSING/export')
      .set(headers)
      .send({ reportId: 'RPT-MISSING', format: 'CSV' })
      .expect(404)
  })

  it('filters immutable audit records for ADMIN and rejects invalid roles and filters', async () => {
    const { baseUrl } = await startServer()
    const adminHeaders = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }
    const records = await request(baseUrl).get('/api/v1/admin/audit').set(adminHeaders).expect(200)
    expect(records.body).toMatchObject({
      data: [{
        auditId: 'AUD-001',
        actor: 'admin',
        role: 'ADMIN',
        module: 'SCENARIO_CONFIGURATION',
        result: 'SUCCESS',
        immutableFixture: true,
      }],
      meta: { total: 1 },
    })

    const filtered = await request(baseUrl)
      .get('/api/v1/admin/audit?actor=admin&role=ADMIN&module=SCENARIO_CONFIGURATION&result=SUCCESS&from=2026-08-06T08%3A00%3A00Z&to=2026-08-06T09%3A00%3A00Z')
      .set(adminHeaders)
      .expect(200)
    expect((filtered.body as { data: unknown[] }).data).toHaveLength(1)
    const empty = await request(baseUrl).get('/api/v1/admin/audit?module=REPORTING').set(adminHeaders).expect(200)
    expect(empty.body).toMatchObject({ data: [], meta: { total: 0, pageSize: 1 } })

    await request(baseUrl).get('/api/v1/admin/audit').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).get('/api/v1/admin/audit').set({ Origin: ORIGIN, 'X-Demo-Role': 'ROOT' }).expect(403)
    await request(baseUrl).get('/api/v1/admin/audit').set({ Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }).expect(403)
    await request(baseUrl).get('/api/v1/admin/audit?role=ROOT').set(adminHeaders).expect(400)
    await request(baseUrl).get('/api/v1/admin/audit?from=invalid').set(adminHeaders).expect(400)
    await request(baseUrl)
      .get('/api/v1/admin/audit?from=2026-08-07T00%3A00%3A00Z&to=2026-08-06T00%3A00%3A00Z')
      .set(adminHeaders)
      .expect(400)
  })

  it('consumes AUDIT_EXPORT confirmation once and returns read-only classification evidence', async () => {
    const { baseUrl } = await startServer()
    const adminHeaders = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }
    await request(baseUrl)
      .post('/api/v1/admin/audit/export')
      .set(adminHeaders)
      .send({ export: true })
      .expect(428)
    await request(baseUrl)
      .post('/api/v1/admin/audit/export')
      .set({ Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' })
      .send({ export: true })
      .expect(403)
    await request(baseUrl)
      .post('/api/v1/admin/audit/export')
      .set({ Origin: ORIGIN, 'X-Demo-Role': 'ROOT' })
      .send({ export: true })
      .expect(403)
    await request(baseUrl)
      .post('/api/v1/admin/audit/export')
      .set(adminHeaders)
      .send({ export: false })
      .expect(400)

    const created = await request(baseUrl)
      .post('/api/v1/confirmations')
      .set(adminHeaders)
      .send({ action: 'AUDIT_EXPORT', objectId: 'AUDIT-LOG' })
      .expect(201)
    const context = (created.body as { data: ConfirmationContext }).data
    await request(baseUrl)
      .post(`/api/v1/confirmations/${context.confirmationId}`)
      .set(adminHeaders)
      .send({ confirm: true })
      .expect(200)
    const exported = await request(baseUrl)
      .post('/api/v1/admin/audit/export')
      .set(adminHeaders)
      .send({ export: true, confirmationId: context.confirmationId, module: 'SCENARIO_CONFIGURATION' })
      .expect(200)
    expect(exported.body).toMatchObject({
      data: {
        objectId: 'AUDIT-LOG',
        generated: false,
        classification: 'INTERNAL',
        watermark: '内部使用 · admin · AUDIT-LOG',
        verifiedAt: '2026-08-06T08:00:00Z',
      },
    })
    await request(baseUrl)
      .post('/api/v1/admin/audit/export')
      .set(adminHeaders)
      .send({ export: true, confirmationId: context.confirmationId })
      .expect(409)
  })
})

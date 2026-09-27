// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
const { createServer } = await import('node:' + 'http')
const { once } = await import('node:' + 'events')
const { WebSocket, WebSocketServer } = await import('w' + 's')
const { MockProjection } = await import('../../server/state/' + 'projection.js')
const { attachRealtimeServer } = await import('../../server/ws/' + 'realtime.js')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function setup(missing = false, authorize?: () => boolean, limits?: { maxClients: number; maxPerSource: number; heartbeatMs: number; maxBufferedBytes?: number }) {
  const projection = new MockProjection()
  if (missing) {
    const snapshot = projection.snapshot()
    snapshot.events = []
    vi.spyOn(projection, 'snapshot').mockReturnValue(snapshot)
  }
  const http = createServer()
  const realtime = attachRealtimeServer(http, projection, () => missing ? undefined : projection.snapshot().run, authorize, undefined, limits)
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const clients: InstanceType<typeof WebSocket>[] = []
  cleanups.push(async () => {
    for (const client of clients) client.terminate()
    await realtime.close()
    await new Promise<void>((resolve, reject) => http.close((error?: Error) => error ? reject(error) : resolve()))
  })
  async function connect(topics: string[]) {
    const client = new WebSocket(`ws://127.0.0.1:${http.address().port}/ws/v1?role=OPERATOR`, { origin: 'http://127.0.0.1:5173' })
    clients.push(client)
    const messages: any[] = []
    client.on('message', (raw: { toString(): string }) => messages.push(JSON.parse(raw.toString())))
    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics }))
    return { client, messages }
  }
  return { realtime, projection, connect, port: http.address().port, clients }
}

it('缺失运行与事件时不伪造信封，仍返回可用的链路摘要；新订阅重放缓存快照', async () => {
  const { connect } = await setup(true)
  // link.metric 排在末尾；收到它说明前面的缺失主题已经处理，不靠 sleep 判定没有消息。
  const topics = ['runtime.state', 'jammer.event', 'switch.event', 'link.metric']
  const first = await connect(topics)
  await vi.waitFor(() => expect(first.messages).toHaveLength(2))
  expect(first.messages[0].type).toBe('subscribed')
  expect(first.messages[1]).toMatchObject({ type: 'event', topic: 'link.metric', sequence: 1 })
  const second = await connect(topics)
  await vi.waitFor(() => expect(second.messages).toHaveLength(2))
  expect(second.messages[1]).toEqual(first.messages[1])
})

it('回放存在的干扰和切换事件，分别保留真实事件类型', async () => {
  const { connect } = await setup()
  const { messages } = await connect(['jammer.event', 'switch.event'])
  await vi.waitFor(() => expect(messages).toHaveLength(3))
  expect(messages[1]).toMatchObject({ topic: 'jammer.event', payload: { type: 'DETECTION' } })
  expect(messages[2]).toMatchObject({ topic: 'switch.event', payload: { type: 'LINK_SWITCH' } })
})

it('握手后会话失效，订阅阶段关闭连接，不发送任何业务快照', async () => {
  let checks = 0
  const { connect, realtime } = await setup(false, () => ++checks === 1)
  const { client, messages } = await connect(['simulation.frame'])
  const [code, reason] = await once(client, 'close')
  expect(code).toBe(1008)
  expect(reason.toString()).toBe('SESSION_EXPIRED')
  expect(messages.filter(message => message.type === 'event')).toEqual([])
  expect(realtime.activeClientCount()).toBe(0)
})

it('单来源与全局连接限额明确拒绝，关闭后释放名额', async () => {
  const { connect, realtime, port, clients } = await setup(false, undefined, { maxClients: 2, maxPerSource: 1, heartbeatMs: 30_000 })
  const first = await connect(['link.metric'])
  await vi.waitFor(() => expect(first.messages.some(message => message.type === 'subscribed')).toBe(true))
  const rejected = new WebSocket(`ws://127.0.0.1:${port}/ws/v1?role=OPERATOR`, { origin: 'http://127.0.0.1:5173' })
  clients.push(rejected)
  const messages: any[] = []
  rejected.on('message', (raw: { toString(): string }) => messages.push(JSON.parse(raw.toString())))
  await once(rejected, 'close')
  expect(messages).toMatchObject([{ type: 'rejected', code: 'INVALID_ENVELOPE', message: expect.stringContaining('limit') }])
  expect(realtime.activeClientCount()).toBe(1)
  first.client.close()
  await vi.waitFor(() => expect(realtime.activeClientCount()).toBe(0))
  const next = await connect(['link.metric'])
  await vi.waitFor(() => expect(next.messages.some(message => message.type === 'subscribed')).toBe(true))
  expect(realtime.activeClientCount()).toBe(1)

  const global = await setup(false, undefined, { maxClients: 1, maxPerSource: 3, heartbeatMs: 30_000 })
  await global.connect(['link.metric'])
  const excess = new WebSocket(`ws://127.0.0.1:${global.port}/ws/v1?role=OPERATOR`, { origin: 'http://127.0.0.1:5173' })
  global.clients.push(excess)
  const globalMessages: any[] = []
  excess.on('message', (raw: { toString(): string }) => globalMessages.push(JSON.parse(raw.toString())))
  await once(excess, 'close')
  expect(globalMessages[0]).toMatchObject({ type: 'rejected', message: expect.stringContaining('limit') })
})

it('心跳清理失活连接，健康连接继续占用名额', async () => {
  const { connect, realtime } = await setup(false, undefined, { maxClients: 2, maxPerSource: 2, heartbeatMs: 50 })
  const healthy = await connect(['link.metric'])
  const stale = await connect(['link.metric'])
  await vi.waitFor(() => expect(realtime.activeClientCount()).toBe(2))
  ;(stale.client as WebSocket & { _socket: { pause(): void } })._socket.pause()
  await vi.waitFor(() => expect(realtime.activeClientCount()).toBe(1), { timeout: 1000 })
  expect(healthy.client.readyState).toBe(WebSocket.OPEN)
})

it('慢连接缓冲超限后断开，健康订阅者仍收到广播', async () => {
  const serverClients: InstanceType<typeof WebSocket>[] = []
  const emit = WebSocketServer.prototype.emit
  vi.spyOn(WebSocketServer.prototype, 'emit').mockImplementation(function (this: InstanceType<typeof WebSocketServer>, event, ...args) {
    if (event === 'connection') serverClients.push(args[0] as InstanceType<typeof WebSocket>)
    return emit.call(this, event, ...args)
  })
  const { connect, realtime, projection } = await setup(false, undefined,
    { maxClients: 2, maxPerSource: 2, heartbeatMs: 30_000, maxBufferedBytes: 1_000 })
  const slow = await connect(['runtime.state'])
  const healthy = await connect(['runtime.state'])
  await vi.waitFor(() => expect(serverClients).toHaveLength(2))
  await vi.waitFor(() => expect(healthy.messages.some(message => message.topic === 'runtime.state')).toBe(true))
  Object.defineProperty(serverClients[0], 'bufferedAmount', { configurable: true, value: 1_000 })
  const before = healthy.messages.length
  realtime.publishRuntimeState(projection.snapshot().run!)
  await once(slow.client, 'close')
  await vi.waitFor(() => expect(healthy.messages.length).toBe(before + 1))
  expect(healthy.messages.at(-1)).toMatchObject({ topic: 'runtime.state' })
  expect(healthy.client.readyState).toBe(WebSocket.OPEN)
  expect(realtime.activeClientCount()).toBe(1)
})

// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
const { createServer } = await import('node:' + 'http')
const { once } = await import('node:' + 'events')
const { mkdtemp, rm } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { WebSocket, WebSocketServer } = await import('w' + 's')
const { MockProjection } = await import('../../server/state/' + 'projection.js')
const { attachRealtimeServer } = await import('../../server/ws/' + 'realtime.js')
const { DiskRealtimeJournal } = await import('../../server/local/' + 'realtime-journal.js')
const { MemoryRealtimeJournal } = await import('../../server/ws/' + 'realtime-journal.js')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function setup(
  missing = false,
  authorize?: () => boolean,
  limits?: { maxClients: number; maxPerSource: number; heartbeatMs: number; maxBufferedBytes?: number; maxRetainedEvents?: number },
  journal?: { journal?: any; replayPageSize?: number },
) {
  const projection = new MockProjection()
  if (missing) {
    const snapshot = projection.snapshot()
    snapshot.events = []
    vi.spyOn(projection, 'snapshot').mockReturnValue(snapshot)
  }
  const http = createServer()
  let selectedRun = missing ? undefined : projection.snapshot().run
  const realtime = attachRealtimeServer(http, projection, () => selectedRun, authorize, undefined, limits, journal)
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const clients: InstanceType<typeof WebSocket>[] = []
  cleanups.push(async () => {
    for (const client of clients) client.terminate()
    await realtime.close()
    await new Promise<void>((resolve, reject) => http.close((error?: Error) => error ? reject(error) : resolve()))
  })
  async function connect(topics: string[], cursor?: number | Record<string, number>) {
    const client = new WebSocket(`ws://127.0.0.1:${http.address().port}/ws/v1?role=OPERATOR`, { origin: 'http://127.0.0.1:5173' })
    clients.push(client)
    const messages: any[] = []
    client.on('message', (raw: { toString(): string }) => messages.push(JSON.parse(raw.toString())))
    await once(client, 'open')
    client.send(JSON.stringify({
      type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics,
      ...(typeof cursor === 'number' ? { lastSequence: cursor } : cursor === undefined ? {} : { lastSequences: cursor }),
    }))
    return { client, messages }
  }
  return { realtime, projection, connect, setRun: (run: typeof selectedRun) => { selectedRun = run }, port: http.address().port, clients }
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

it('断线后保留离线期间的真实运行状态，并按主题游标有序续传', async () => {
  const { connect, realtime, projection } = await setup()
  const first = await connect(['runtime.state'])
  await vi.waitFor(() => expect(first.messages).toHaveLength(2))
  const run = projection.snapshot().run!
  const closed = once(first.client, 'close')
  first.client.close()
  await closed
  await vi.waitFor(() => expect(realtime.activeClientCount()).toBe(0))
  realtime.publishRuntimeState({ ...run, canonical: { ...run.canonical, currentTime: 43, progress: 1 } })
  realtime.publishRuntimeState({ ...run, canonical: { ...run.canonical, currentTime: 44, progress: 2 } })

  const resumed = await connect(['runtime.state'], { 'runtime.state': 1 })
  await vi.waitFor(() => expect(resumed.messages).toHaveLength(3))
  expect(resumed.messages[0]).toMatchObject({ type: 'subscribed', lastSequences: { 'runtime.state': 1 } })
  expect(resumed.messages.slice(1).map(message => message.sequence)).toEqual([2, 3])
  expect(resumed.messages.slice(1).map(message => message.simulationTime)).toEqual([43, 44])
})

it('不等速主题以独立游标续传，旧式单游标仍保持兼容的严格窗口校验', async () => {
  const { connect, realtime, projection } = await setup(false, undefined,
    { maxClients: 2, maxPerSource: 2, heartbeatMs: 30_000, maxRetainedEvents: 2 })
  const first = await connect(['runtime.state', 'link.metric'])
  await vi.waitFor(() => expect(first.messages).toHaveLength(3))
  const run = projection.snapshot().run!
  for (const currentTime of [43, 44, 45]) {
    realtime.publishRuntimeState({ ...run, canonical: { ...run.canonical, currentTime, progress: currentTime - 42 } })
  }
  const closed = once(first.client, 'close')
  first.client.close()
  await closed

  const resumed = await connect(['runtime.state', 'link.metric'], { 'runtime.state': 3, 'link.metric': 1 })
  await vi.waitFor(() => expect(resumed.messages).toHaveLength(2))
  expect(resumed.messages[1]).toMatchObject({ topic: 'runtime.state', sequence: 4, simulationTime: 45 })

  const legacy = await connect(['runtime.state', 'link.metric'], 1)
  await once(legacy.client, 'close')
  expect(legacy.messages).toEqual([expect.objectContaining({ type: 'rejected', code: 'SEQUENCE_GAP' })])
})

it('混合逐主题游标会补齐零游标事件主题的离线保留事件', async () => {
  const { connect, realtime } = await setup()
  const first = await connect(['runtime.state'])
  await vi.waitFor(() => expect(first.messages).toHaveLength(2))
  const closed = once(first.client, 'close')
  first.client.close()
  await closed
  await vi.waitFor(() => expect(realtime.activeClientCount()).toBe(0))

  const status = { time: 42, jammerId: 'JAM-WB-01-TX', platformId: 'STN-01', power: 70, frequency: 2200, bandwidth: 40, active: true }
  realtime.publishJammerStatus(status, 'F-00042')
  realtime.publishJammerStatus({ ...status, power: 71 }, 'F-00042')

  const resumed = await connect(['runtime.state', 'jammer.event'], { 'runtime.state': 1, 'jammer.event': 0 })
  await vi.waitFor(() => expect(resumed.messages).toHaveLength(3))
  expect(resumed.messages.slice(1)).toMatchObject([
    { topic: 'jammer.event', sequence: 1, payload: { power: 70 } },
    { topic: 'jammer.event', sequence: 2, payload: { power: 71 } },
  ])
})

it('质量文件更新只通过 link.metric 发送有界引用，不把采样历史写进 WS', async () => {
  const { connect, realtime } = await setup()
  const { messages } = await connect(['link.metric'])
  await vi.waitFor(() => expect(messages).toHaveLength(2))
  realtime.publishQualityDataset({
    schemaVersion: '1.0',
    scope: { taskId: 'TASK-001', runId: 'RUN-001', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-10-31T01:00:00Z' },
    source: { kind: 'FILE_IMPORT', fileName: 'quality.csv', sha256: 'a'.repeat(64), importedAt: '2026-10-31T01:01:00Z', frameIdKind: 'IMPORT_SEQUENCE' },
    expectedStepS: 1,
    samples: [],
    switchEvents: [],
  })
  await vi.waitFor(() => expect(messages).toHaveLength(3))
  expect(messages[2]).toMatchObject({ topic: 'link.metric', payload: {
    kind: 'QUALITY_UPDATED', sourceSha256: 'a'.repeat(64), sampleCount: 0,
    scope: { runId: 'RUN-001' },
  } })
  expect(JSON.stringify(messages[2])).not.toContain('quality.csv')
  expect(JSON.stringify(messages[2])).not.toContain('samples')
})

it('混合重连的零游标事件主题越出保留窗口时明确拒绝', async () => {
  const { connect, realtime } = await setup(false, undefined,
    { maxClients: 2, maxPerSource: 2, heartbeatMs: 30_000, maxRetainedEvents: 2 })
  const first = await connect(['runtime.state'])
  await vi.waitFor(() => expect(first.messages).toHaveLength(2))
  const closed = once(first.client, 'close')
  first.client.close()
  await closed
  await vi.waitFor(() => expect(realtime.activeClientCount()).toBe(0))

  const status = { time: 42, jammerId: 'JAM-WB-01-TX', platformId: 'STN-01', power: 70, frequency: 2200, bandwidth: 40, active: true }
  for (const power of [70, 71, 72]) realtime.publishJammerStatus({ ...status, power }, 'F-00042')

  const stale = await connect(['runtime.state', 'jammer.event'], { 'runtime.state': 1, 'jammer.event': 0 })
  await vi.waitFor(() => expect(stale.messages).toEqual([expect.objectContaining({
    type: 'rejected', code: 'SEQUENCE_GAP', message: expect.stringContaining('retained realtime event window'),
  })]))
})

it('续传游标早于有限保留窗口时明确拒绝，不回放不完整事件流', async () => {
  const { connect, realtime, projection } = await setup(false, undefined,
    { maxClients: 2, maxPerSource: 2, heartbeatMs: 30_000, maxRetainedEvents: 2 })
  const first = await connect(['runtime.state'])
  await vi.waitFor(() => expect(first.messages).toHaveLength(2))
  const run = projection.snapshot().run!
  for (const currentTime of [43, 44, 45]) {
    realtime.publishRuntimeState({ ...run, canonical: { ...run.canonical, currentTime, progress: currentTime - 42 } })
  }
  await vi.waitFor(() => expect(first.messages.filter(message => message.type === 'event')).toHaveLength(4))
  first.client.close()

  const stale = await connect(['runtime.state'], { 'runtime.state': 1 })
  const [code, reason] = await once(stale.client, 'close')
  expect(code).toBe(1008)
  expect(reason.toString()).toBe('SEQUENCE_GAP')
  expect(stale.messages).toEqual([expect.objectContaining({
    type: 'rejected', code: 'SEQUENCE_GAP', message: expect.stringContaining('retained realtime event window'),
  })])
})

it('运行切换清空历史后拒绝旧游标，并允许清零游标从新运行快照恢复', async () => {
  const { connect, realtime, projection, setRun } = await setup()
  const first = await connect(['runtime.state', 'jammer.event'])
  await vi.waitFor(() => expect(first.messages).toHaveLength(3))
  const closed = once(first.client, 'close')
  first.client.close()
  await closed
  await vi.waitFor(() => expect(realtime.activeClientCount()).toBe(0))

  const previous = projection.snapshot().run!
  const switched = { ...previous, runId: 'RUN-CHANGED-001' as const, canonical: { ...previous.canonical, currentTime: 43, progress: 1 } }
  setRun(switched)
  realtime.publishRuntimeState(switched)

  const stale = await connect(['runtime.state', 'jammer.event'], { 'runtime.state': 1, 'jammer.event': 1 })
  await vi.waitFor(() => expect(stale.messages).toEqual([expect.objectContaining({ type: 'rejected', code: 'SEQUENCE_GAP' })]))
  await vi.waitFor(() => expect(stale.client.readyState).toBe(WebSocket.CLOSED))

  const recovered = await connect(['runtime.state', 'jammer.event'], { 'runtime.state': 0, 'jammer.event': 0 })
  await vi.waitFor(() => expect(recovered.messages).toHaveLength(3))
  expect(recovered.messages[1]).toMatchObject({ topic: 'runtime.state', sequence: 2, simulationTime: 43 })
  expect(recovered.messages[2]).toMatchObject({ topic: 'jammer.event', sequence: 2 })
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

it('磁盘 journal 在热缓存之外逐页重放离线运行状态，且序号连续不重复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-ws-journal-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const { connect, realtime, projection } = await setup(false, undefined,
    { maxClients: 2, maxPerSource: 2, heartbeatMs: 30_000, maxRetainedEvents: 2 },
    { journal: new DiskRealtimeJournal(directory, 2), replayPageSize: 7 })
  const first = await connect(['runtime.state'])
  await vi.waitFor(() => expect(first.messages).toHaveLength(2))
  const closed = once(first.client, 'close')
  first.client.close()
  await closed
  const run = projection.snapshot().run!
  for (let time = 43; time <= 172; time += 1) {
    realtime.publishRuntimeState({ ...run, canonical: { ...run.canonical, currentTime: time, progress: time - 42 } })
  }

  const resumed = await connect(['runtime.state'], { 'runtime.state': 1 })
  await vi.waitFor(() => expect(resumed.messages).toHaveLength(131))
  const events = resumed.messages.slice(1)
  expect(events.map(message => message.sequence)).toEqual(Array.from({ length: 130 }, (_, index) => index + 2))
  expect(events.map(message => message.simulationTime)).toEqual(Array.from({ length: 130 }, (_, index) => index + 43))
})

it.each([new Error('journal unavailable'), 'journal unavailable'])('journal 准备代际失败%j时拒绝订阅且不发送确认或旧快照', async failure => {
  const journal = new MemoryRealtimeJournal(2)
  const { connect } = await setup(false, undefined, undefined, {
    journal: {
      next: journal.next.bind(journal), append: journal.append.bind(journal), canResume: journal.canResume.bind(journal), readAfter: journal.readAfter.bind(journal), clear: journal.clear.bind(journal),
      prepareRun: () => { throw failure },
    },
  })
  const client = await connect(['runtime.state'])
  await once(client.client, 'close')
  expect(client.messages).toEqual([expect.objectContaining({ type: 'rejected', code: 'SEQUENCE_GAP', message: expect.stringContaining('journal unavailable') })])
})

it('journal 写入或重放读取失败时明确拒绝，不把部分流当作成功', async () => {
  const base = new MemoryRealtimeJournal(8)
  let appendFailure = true
  const journal = {
    next: base.next.bind(base), prepareRun: base.prepareRun.bind(base), canResume: base.canResume.bind(base), clear: base.clear.bind(base),
    append: (...args: Parameters<typeof base.append>) => { if (appendFailure) throw new Error('disk full'); base.append(...args) },
    readAfter: base.readAfter.bind(base),
  }
  const { connect, realtime, projection } = await setup(false, undefined, undefined, { journal })
  const first = await connect(['runtime.state'])
  await once(first.client, 'close')
  expect(first.messages.at(-1)).toMatchObject({ type: 'rejected', code: 'SEQUENCE_GAP', message: expect.stringContaining('disk full') })
  appendFailure = false
  realtime.publishRuntimeState(projection.snapshot().run!)
  const readFailure = { ...journal, readAfter: () => ({ ok: false as const, reason: 'bad index page' }) }
  const replay = await setup(false, undefined, undefined, { journal: readFailure })
  const resumed = await replay.connect(['runtime.state'], { 'runtime.state': 1 })
  await once(resumed.client, 'close')
  expect(resumed.messages.at(-1)).toMatchObject({ type: 'rejected', code: 'SEQUENCE_GAP', message: 'bad index page' })
})

it.each([new Error('boundary write failed'), 'boundary write failed'])('严格拒绝歧义或不完整的逐主题游标，发布代际失败%j关闭已有订阅', async failure => {
  const { port, clients } = await setup()
  for (const cursor of [
    { lastSequence: 0, lastSequences: { 'runtime.state': 0 } },
    { lastSequences: [] },
    { lastSequences: { 'runtime.state': -1 } },
    { lastSequences: { 'runtime.state': 0, unknown: 0 } },
  ]) {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/v1?role=OPERATOR`, { origin: 'http://127.0.0.1:5173' })
    clients.push(client); const messages: any[] = []; client.on('message', (raw: { toString(): string }) => messages.push(JSON.parse(raw.toString())))
    await once(client, 'open'); client.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['runtime.state'], ...cursor }))
    await once(client, 'close'); expect(messages[0]).toMatchObject({ type: 'rejected', code: 'INVALID_ENVELOPE' })
  }
  const journal = new MemoryRealtimeJournal(4); let calls = 0
  const broken = { next: journal.next.bind(journal), append: journal.append.bind(journal), canResume: journal.canResume.bind(journal), readAfter: journal.readAfter.bind(journal), clear: journal.clear.bind(journal), prepareRun: (...args: Parameters<typeof journal.prepareRun>) => { calls += 1; if (calls > 1) throw failure; return journal.prepareRun(...args) } }
  const second = await setup(false, undefined, undefined, { journal: broken })
  const subscribed = await second.connect(['runtime.state']); await vi.waitFor(() => expect(subscribed.messages[0]).toMatchObject({ type: 'subscribed' }))
  const run = second.projection.snapshot().run!
  second.realtime.publishRuntimeState({ ...run, runId: 'RUN-BOUNDARY-FAIL' as typeof run.runId })
  await once(subscribed.client, 'close'); expect(subscribed.messages.at(-1)).toMatchObject({ type: 'rejected', code: 'SEQUENCE_GAP', message: expect.stringContaining('boundary write failed') })
})

it('冷启动新控制器在订阅确认前拒绝上一运行的持久游标', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrj-cold-ws-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const first = await setup(false, undefined, undefined, { journal: new DiskRealtimeJournal(root, 2) })
  const original = first.projection.snapshot().run!
  first.setRun({ ...original, runId: 'RUN-A' as typeof original.runId })
  const previous = await first.connect(['runtime.state'])
  await vi.waitFor(() => expect(previous.messages).toHaveLength(2))
  const previousClosed = once(previous.client, 'close')
  previous.client.close()
  await previousClosed
  const restarted = await setup(false, undefined, undefined, { journal: new DiskRealtimeJournal(root, 2) })
  restarted.setRun({ ...original, runId: 'RUN-B' as typeof original.runId })
  const oldCursor = await restarted.connect(['runtime.state'], 1)
  await once(oldCursor.client, 'close')
  expect(oldCursor.messages).toEqual([expect.objectContaining({ type: 'rejected', code: 'SEQUENCE_GAP' })])
})

it('离线重复状态发布不依赖订阅者，缺失固定运行时不伪造干扰事件', async () => {
  const { realtime, projection, setRun } = await setup()
  const run = projection.snapshot().run!
  realtime.publishRuntimeState(run)
  realtime.publishRuntimeState({ ...run, canonical: { ...run.canonical, currentTime: 43 } })
  setRun(undefined)
  realtime.publishJammerStatus({ time: 42, jammerId: 'JAM-WB-01-TX', platformId: 'STN-01', power: 70, frequency: 2200, bandwidth: 40, active: true }, 'F-00042')
  expect(realtime.activeClientCount()).toBe(0)
})

it('运行态广播落盘失败时不向订阅者发布未持久化消息', async () => {
  const base = new MemoryRealtimeJournal(4); let appends = 0
  const journal = { next: base.next.bind(base), prepareRun: base.prepareRun.bind(base), canResume: base.canResume.bind(base), readAfter: base.readAfter.bind(base), clear: base.clear.bind(base), append: (...args: Parameters<typeof base.append>) => { appends += 1; if (appends > 1) throw new Error('write lost'); base.append(...args) } }
  const { connect, realtime, projection } = await setup(false, undefined, undefined, { journal })
  const client = await connect(['runtime.state'])
  await vi.waitFor(() => expect(client.messages).toHaveLength(2))
  realtime.publishRuntimeState({ ...projection.snapshot().run!, canonical: { ...projection.snapshot().run!.canonical, currentTime: 43 } })
  await vi.waitFor(() => expect(client.messages.at(-1)).toMatchObject({ type: 'rejected', code: 'SEQUENCE_GAP' }))
})

// @vitest-environment node
import { expect, it } from 'vitest'
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const { once } = await import('node:' + 'events')
const { WebSocket } = await import('w' + 's')
const { createServer } = await import('node:' + 'http')
const { MockProjection } = await import('../../server/state/' + 'projection.js')
const { attachRealtimeServer } = await import('../../server/ws/' + 'realtime.js')
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }

it('已保存非默认场景创建单实例 Mock：时长/步长/锁一致，不提供冻结遥测与事件', async () => {
  const server = createMockServer()
  let socket: InstanceType<typeof WebSocket> | undefined
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    const api = request(origin)
    const draft = (await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data
    draft.config.scenario.id = 'SCN-B'
    draft.config.scenario.name = '已选场景 B'
    draft.config.scenario.duration = 8000
    draft.config.scenario.timeStep = 2
    for (const platform of draft.config.platforms) if (platform.type === 'COMMUNICATION_SATELLITE') platform.satelliteType = 'TIANTONG'
    await api.post('/api/v1/scenarios').set(headers).send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: 0 }).expect(201)
    await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-MISSING' }).expect(404)
    const created = (await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-B' }).expect(201)).body.data
    const runId = created.runId
    expect(created).toMatchObject({ scenarioId: 'SCN-B', configLocked: true, canonical: { totalDuration: 8000 } })
    await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(409)
    expect((await api.get('/api/v1/scenarios/SCN-B').set(headers).expect(200)).body.data.locked).toBe(true)
    await api.get(`/api/v1/simulations/${runId}/frames/F-00042`).set(headers).expect(404)
    await api.get(`/api/v1/simulations/${runId}/events`).set(headers).expect(404)
    const parameters = { enabled: true, frequency: 2200, bandwidth: 40, power: 72, direction: 360, duration: 1200 }
    for (const [path, body] of [
      [`/api/v1/simulations/${runId}/events`, { frameId: 'F-00042', detectionEventId: 'DET-042', targetPlatformId: 'UAV-01', affectedLinkId: 'L-DL-03' }],
      ['/api/v1/tasks/TASK-001/jammers/JAM-WB-01-TX/commands', parameters],
      ['/api/v1/tasks/TASK-001/jammers/JAM-WB-01-TX/parameters', { version: 5, effectiveFrameId: 'F-00042', parameters }],
    ] as const) {
      const rejected = await api.post(path).set(headers).send(body).expect(404)
      expect(rejected.body.ok).toBe(false)
      expect(rejected.body.data).toBeUndefined()
    }
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws/v1?role=OPERATOR', { headers: { Origin: headers.Origin } })
    const messages: any[] = []
    const received = new Promise<void>(resolve => socket!.on('message', (raw: { toString(): string }) => {
      const value = JSON.parse(raw.toString())
      messages.push(value)
      if (value.topic === 'runtime.state') resolve()
    }))
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['simulation.frame', 'link.metric', 'jammer.event', 'switch.event', 'runtime.state'] }))
    await received
    expect(messages.filter(value => value.type === 'event').map(value => value.topic)).toEqual(['runtime.state'])
    for (const command of [{ command: 'START', mode: 'INTERACTIVE_SINGLE' }, { command: 'PAUSE' }, { command: 'STEP', stepCount: 1 }]) {
      await api.post(`/api/v1/simulations/${runId}/commands`).set(headers).send(command).expect(200)
    }
    expect((await api.get(`/api/v1/simulations/${runId}`).set(headers).expect(200)).body.data.canonical.currentTime).toBe(2)
    const confirmation = (await api.post('/api/v1/confirmations').set(headers).send({ action: 'SIMULATION_STOP', objectId: runId }).expect(201)).body.data
    await api.post(`/api/v1/confirmations/${confirmation.confirmationId}`).set(headers).send({ confirm: true }).expect(200)
    await api.post(`/api/v1/simulations/${runId}/commands`).set(headers).send({ command: 'STOP', confirmationId: confirmation.confirmationId }).expect(200)
    expect((await api.get('/api/v1/scenarios/SCN-B').set(headers).expect(200)).body.data.locked).toBe(false)
  } finally {
    socket?.terminate()
    await server.close()
  }
}, 15000)

it('错误任务编号返回可定位的 422，不替换运行也不锁定场景', async () => {
  const server = createMockServer()
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(server.httpServer)
    const before = (await api.get('/api/v1/simulations').set(headers).expect(200)).body.data
    const rejected = await api.post('/api/v1/simulations').set(headers)
      .send({ taskId: 'TASK-OTHER', scenarioId: 'SCN-001' }).expect(422)
    expect(rejected.body.error).toMatchObject({ fieldPath: 'taskId', message: expect.stringContaining('任务编号') })
    expect((await api.get('/api/v1/simulations').set(headers).expect(200)).body.data).toEqual(before)
    expect((await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data.locked).toBe(false)
  } finally { await server.close() }
})

it('切换场景后已有订阅不接收固定发布，新订阅不重放缓存；默认场景仍可发布', async () => {
  const projection = new MockProjection()
  let run = projection.snapshot().run
  const http = createServer()
  const realtime = attachRealtimeServer(http, projection, () => run)
  const sockets: InstanceType<typeof WebSocket>[] = []
  const barrier = async (socket: InstanceType<typeof WebSocket>) => {
    const pong = once(socket, 'pong')
    socket.ping()
    await pong
  }
  try {
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    const subscribe = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${(http.address() as { port: number }).port}/ws/v1?role=OPERATOR`, { headers: { Origin: headers.Origin } })
      sockets.push(socket)
      const messages: any[] = []
      socket.on('message', (raw: { toString(): string }) => messages.push(JSON.parse(raw.toString())))
      await once(socket, 'open')
      socket.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['simulation.frame', 'link.metric', 'jammer.event', 'switch.event', 'runtime.state'] }))
      await barrier(socket)
      return { socket, messages }
    }
    const first = await subscribe()
    expect(first.messages.filter(value => value.type === 'event')).toHaveLength(5)
    const status = { time: 42, jammerId: 'JAM-WB-01-TX', platformId: 'STN-01', power: 70, frequency: 2200, bandwidth: 40, active: true }
    realtime.publishJammerStatus(status, 'F-00042')
    await barrier(first.socket)
    expect(first.messages.at(-1)).toMatchObject({ topic: 'jammer.event', payload: { power: 70 } })
    const before = first.messages.length
    run = { ...run, scenarioId: 'SCN-B' }
    realtime.publishJammerStatus({ ...status, power: 71 }, 'F-00042')
    await barrier(first.socket)
    expect(first.messages).toHaveLength(before)
    const second = await subscribe()
    expect(second.messages.filter(value => value.type === 'event').map(value => value.topic)).toEqual(['runtime.state'])
    run = projection.snapshot().run
    realtime.publishJammerStatus({ ...status, power: 72 }, 'F-00042')
    await barrier(first.socket)
    await barrier(second.socket)
    for (const client of [first, second]) expect(client.messages.at(-1)).toMatchObject({ topic: 'jammer.event', sequence: 3, payload: { power: 72 } })
  } finally {
    sockets.forEach(socket => socket.terminate())
    await realtime.close()
    await new Promise<void>((resolve, reject) => http.close((error?: Error) => error ? reject(error) : resolve()))
  }
})

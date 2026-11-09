// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import type { EngineConnectionDiagnostic, EngineControlAction, EngineFrameSnapshot, SimulationRun } from '../../src/contracts/domain-models'
const { once } = await import('node:' + 'events')
const { WebSocket, WebSocketServer } = await import('w' + 's')
const { EngineSnapshotClient } = await import('../../server/local/' + 'engine-snapshot-client.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')

const cleanups: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }

async function setup() {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(upstream, 'listening')
  cleanups.push(async () => { for (const peer of upstream.clients) peer.terminate(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const messages: unknown[] = [], peers: InstanceType<typeof WebSocket>[] = []
  upstream.on('connection', (peer: InstanceType<typeof WebSocket>) => { peers.push(peer); peer.on('message', (raw: { toString(): string }) => messages.push(JSON.parse(raw.toString()))) })
  let complete!: (outcome: { code: number | null; completedAt?: string }) => void
  const completed = new Promise<{ code: number | null; completedAt?: string }>(resolve => { complete = resolve })
  const stop = vi.fn(async () => { complete({ code: null }) })
  let engine!: InstanceType<typeof EngineSnapshotClient>
  const app = createMockServer({ port: 0,
    linkEngineWsUrl: `ws://127.0.0.1:${upstream.address().port}`,
    createEngineSnapshotClient: (url: string, publish: (runId: SimulationRun['runId'], frame: EngineFrameSnapshot) => void,
      diagnose?: (run: Pick<SimulationRun, 'runId' | 'taskId'>, diagnostic: EngineConnectionDiagnostic) => void) => engine = new EngineSnapshotClient(url, publish, vi.fn(), diagnose),
    missionExecution: { start: async () => ({ pid: 777, startedAt: '2026-11-09T01:00:00Z', entryPath: 'mission.txt', completed, stop }) },
  })
  cleanups.push(() => app.close())
  if (!app.httpServer.listening) await once(app.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${app.httpServer.address().port}`)
  const created = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
  const runId: string = created.body.data.runId
  const command = (body: object) => api.post(`/api/v1/simulations/${runId}/commands`).set(headers).send(body)
  const read = async () => (await api.get(`/api/v1/simulations/${runId}`).set(headers).expect(200)).body.data
  await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
  await vi.waitFor(async () => expect((await read()).engineControl).toEqual({ connected: true, action: null, delivery: 'IDLE' }))
  return { api, runId, command, read, engine, messages, peers, stop, complete }
}

it('REST 到真实 WS 发送精确两字段；暂停、恢复、停止均保留真实状态与配置锁，进程退出才收尾', async () => {
  const { api, runId, command, read, messages, peers, stop, complete } = await setup()
  for (const [cmd, action] of [['PAUSE', 'pause'], ['RESUME', 'resume']] as const) {
    const response = await command({ command: cmd }).expect(202)
    expect(response.body.data).toMatchObject({ uiStatus: 'RUNNING', canonical: { status: 'RUNNING', processId: 777 }, configLocked: true,
      engineControl: { connected: true, action, delivery: 'SENT' } })
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({ msg_type: 'sim_control', action }))
    await command({ command: cmd }).expect(409)
  }
  await command({ command: 'STEP', stepCount: 1 }).expect(409)
  await command({ command: 'SET_SPEED', speedMultiplier: 2 }).expect(409)
  await command({ command: 'STOP' }).expect(428)
  expect(messages).toHaveLength(2)
  const context = await api.post('/api/v1/confirmations').set(headers).send({ action: 'SIMULATION_STOP', objectId: runId }).expect(201)
  const confirmationId = context.body.data.confirmationId
  await api.post(`/api/v1/confirmations/${confirmationId}`).set(headers).send({ confirm: true }).expect(200)
  const stopped = await command({ command: 'STOP', confirmationId }).expect(202)
  expect(stopped.body.data).toMatchObject({ uiStatus: 'RUNNING', configLocked: true, engineControl: { action: 'stop', delivery: 'SENT' } })
  await vi.waitFor(() => expect(messages).toEqual(['pause', 'resume', 'stop'].map(action => ({ msg_type: 'sim_control', action }))))
  expect(stop).not.toHaveBeenCalled()
  expect(peers[0]!.readyState).toBe(WebSocket.OPEN)
  expect((await read()).configLocked).toBe(true)
  await command({ command: 'RESUME' }).expect(409)
  // 尚未确认的建议回执绝不能解除锁或伪造成功状态。
  peers[0]!.send(JSON.stringify({ msg_type: 'sim_control_ack', action: 'stop', success: true, state: 'STOPPED' }))
  await new Promise(resolve => setTimeout(resolve, 30))
  expect((await read()).uiStatus).toBe('RUNNING')
  complete({ code: 0, completedAt: '2026-11-09T01:01:00Z' })
  await vi.waitFor(async () => expect(await read()).toMatchObject({ uiStatus: 'STOPPED', configLocked: false, canonical: { status: 'IDLE', processId: null } }))
  expect(await read()).not.toHaveProperty('engineControl')
})

it('发送错误保留 UNKNOWN 和锁；不回退杀进程，不自动重发', async () => {
  const { command, read, messages, stop } = await setup()
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (_data: unknown, callback: unknown) {
    ;(callback as (error?: Error) => void)(new Error('write failed'))
  })
  const response = await command({ command: 'PAUSE' }).expect(503)
  expect(response.body.error.message).toContain('待核实')
  expect(await read()).toMatchObject({ uiStatus: 'RUNNING', configLocked: true, engineControl: { action: 'pause', delivery: 'UNKNOWN' } })
  await command({ command: 'RESUME' }).expect(409)
  expect(messages).toHaveLength(0)
  expect(stop).not.toHaveBeenCalled()
})

it('校验运行归属和动作；发送中不并发；超时和迟到 send 回调不冒充成功', async () => {
  const { engine, runId, messages } = await setup()
  await expect(engine.sendControl('RUN-OTHER', 'pause')).rejects.toThrow('未发送')
  await expect(engine.sendControl(runId, 'invalid' as EngineControlAction)).rejects.toThrow('未发送')
  let callback!: (error?: Error) => void
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (_data: unknown, cb: unknown) { callback = cb as typeof callback })
  vi.useFakeTimers()
  const sending = engine.sendControl(runId, 'pause')
  const rejected = expect(sending).rejects.toThrow('超时')
  expect(engine.controlState(runId)).toMatchObject({ action: 'pause', delivery: 'SENDING' })
  await expect(engine.sendControl(runId, 'resume')).rejects.toThrow('未发送')
  await vi.advanceTimersByTimeAsync(3_001)
  await rejected
  callback()
  expect(engine.controlState(runId)).toMatchObject({ action: 'pause', delivery: 'UNKNOWN' })
  expect(messages).toHaveLength(0)
})

it('断线后标记待核实；自动重连只恢复数据连接，不补发控制命令', async () => {
  const { command, read, messages, peers } = await setup()
  await command({ command: 'PAUSE' }).expect(202)
  await vi.waitFor(() => expect(messages).toHaveLength(1))
  peers[0]!.terminate()
  await vi.waitFor(async () => expect((await read()).engineControl).toMatchObject({ connected: false, delivery: 'UNKNOWN' }))
  await vi.waitFor(async () => expect((await read()).engineControl).toMatchObject({ connected: true, delivery: 'UNKNOWN' }), { timeout: 2_500 })
  expect(peers).toHaveLength(2)
  expect(messages).toHaveLength(1)
  await command({ command: 'RESUME' }).expect(409)
})

// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import type { EngineConnectionDiagnostic, EngineControlAction, EngineFrameSnapshot, SimulationRun } from '../../src/contracts/domain-models'
import sample from '../fixtures/engine-frame/websocket-new/fream001.json'
import latestSamples from '../fixtures/engine-frame/websocket-latest.json'
import { LOCAL_REPLAY } from '../fixtures/local-replay'
import { playbackFileSource, fileReceptionScenarioId } from '../../src/features/situation/file-reception'
const { once } = await import('node:' + 'events')
const { WebSocket, WebSocketServer } = await import('w' + 's')
const { EngineSnapshotClient } = await import('../../server/local/' + 'engine-snapshot-client.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const { mkdtemp, rm, readFile, readdir, mkdir, open } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createEngineFrameArchive } = await import('../../server/local/' + 'engine-frame-archive.js')

const cleanups: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
const receptionStartedAt = '2026-11-09T02:00:00Z'
const receptionCompletedAt = '2026-11-09T02:01:00Z'

async function setup(file = false, saveFileReception?: (run: SimulationRun, completedAt: string, lastFrameTime: number) => Promise<void>) {
  const replay = structuredClone(LOCAL_REPLAY)
  replay.initial.connections = [{ sourceEventId: 'LOG-L9', time: 0, scope: 'INTER_PLATFORM',
    source: { platformName: 'rear_comm_vehicle', communicationName: 'fiber_link', address: '10.0.0.1' },
    target: { platformName: 'command_vehicle', communicationName: 'fiber_link', address: '10.0.0.2' },
    sourceType: 'WSF_COMM_TRANSCEIVER', targetType: 'WSF_COMM_TRANSCEIVER' }]
  const fileSource = playbackFileSource(replay)
  const root = await mkdtemp(join(tmpdir(), 'wrj-remote-control-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const archive = createEngineFrameArchive(root, () => new Date().toISOString())
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(upstream, 'listening')
  cleanups.push(async () => { for (const peer of upstream.clients) peer.terminate(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const messages: unknown[] = [], peers: InstanceType<typeof WebSocket>[] = []
  upstream.on('connection', (peer: InstanceType<typeof WebSocket>) => { peers.push(peer); peer.on('message', (raw: { toString(): string }) => messages.push(JSON.parse(raw.toString()))) })
  let complete!: (outcome: { code: number | null; completedAt?: string }) => void
  const completed = new Promise<{ code: number | null; completedAt?: string }>(resolve => { complete = resolve })
  const stop = vi.fn(async () => { complete({ code: null }) })
  const start = vi.fn(async () => ({ pid: 777, startedAt: '2026-11-09T01:00:00Z', entryPath: 'mission.txt', completed, stop }))
  let engine!: InstanceType<typeof EngineSnapshotClient>
  let diagnoseEngine!: (run: Pick<SimulationRun, 'runId' | 'taskId'>, diagnostic: EngineConnectionDiagnostic) => void
  const app = createMockServer({ port: 0,
    saveFileReception,
    loadLocalReplay: file ? async () => replay : undefined,
    engineFrameArchive: archive,
    linkEngineWsUrl: `ws://127.0.0.1:${upstream.address().port}`,
    remoteEngineNow: vi.fn(() => receptionCompletedAt).mockReturnValueOnce(receptionStartedAt),
    createEngineSnapshotClient: (url: string, publish: (runId: SimulationRun['runId'], frame: EngineFrameSnapshot) => void,
      diagnose?: (run: Pick<SimulationRun, 'runId' | 'taskId'>, diagnostic: EngineConnectionDiagnostic) => void) => {
        diagnoseEngine = diagnose!
        return engine = new EngineSnapshotClient(url, publish, vi.fn(), diagnose)
      },
    missionExecution: { start, safetyStatus: () => ({ message: '本机没有 mission.exe，也不应阻止远端连接。' }) },
  })
  cleanups.push(() => app.close())
  if (!app.httpServer.listening) await once(app.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${app.httpServer.address().port}`)
  const sceneBefore = (await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data
  const createBody = file ? { taskId: 'TASK-001', scenarioId: fileReceptionScenarioId(fileSource), fileSource } : { taskId: 'TASK-001', scenarioId: 'SCN-001' }
  if (file) {
    await api.post('/api/v1/simulations').set(headers).send({ ...createBody, fileSource: { ...fileSource, positionSha256: 'c'.repeat(64) } }).expect(409)
    await api.post('/api/v1/simulations').set(headers).send({ ...createBody, fileSource: { ...fileSource, extra: true } }).expect(422)
    await api.post('/api/v1/simulations').set(headers).send({ ...createBody, scenarioId: 'SCN-001' }).expect(409)
  }
  const created = await api.post('/api/v1/simulations').set(headers).send(createBody).expect(201)
  const runId: SimulationRun['runId'] = created.body.data.runId
  const command = (body: object) => api.post(`/api/v1/simulations/${runId}/commands`).set(headers).send(body)
  const read = async () => (await api.get(`/api/v1/simulations/${runId}`).set(headers).expect(200)).body.data
  await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
  await vi.waitFor(async () => expect((await read()).engineControl).toEqual({ connected: true, action: null, delivery: 'IDLE' }))
  expect(start).not.toHaveBeenCalled()
  expect(await read()).toMatchObject({ executionSource: 'REMOTE_WS', startedAt: receptionStartedAt, canonical: { processId: null } })
  const confirmed = async (action: 'STOP') => {
    const context = await api.post('/api/v1/confirmations').set(headers).send({ action: 'SIMULATION_STOP', objectId: runId }).expect(201)
    const confirmationId = context.body.data.confirmationId
    await api.post(`/api/v1/confirmations/${confirmationId}`).set(headers).send({ confirm: true }).expect(200)
    return command({ command: action, confirmationId })
  }
  return { api, runId, command, read, engine, messages, peers, stop, complete, start, archive, root, confirmed, app, fileSource, sceneBefore, diagnoseEngine }
}

it('暂停后重复断线诊断不触发运行状态查询，真实控制状态变化仍通知', async () => {
  const { app, runId, command, read, engine, diagnoseEngine } = await setup(true)
  await command({ command: 'PAUSE' }).expect(202)
  const run = await read() as SimulationRun
  const browser = new WebSocket(`ws://127.0.0.1:${app.httpServer.address().port}/ws/v1?role=OPERATOR`, { origin: headers.Origin })
  cleanups.push(() => browser.terminate())
  const received: Array<{ topic?: string; type?: string }> = []
  browser.on('message', (raw: { toString(): string }) => received.push(JSON.parse(raw.toString())))
  await once(browser, 'open')
  browser.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: run.taskId, topics: ['runtime.state', 'mission.log'] }))
  await vi.waitFor(() => expect(received.some(message => message.type === 'subscribed')).toBe(true))
  const flush = async () => { const pong = once(browser, 'pong'); browser.ping(); await pong }
  await flush()
  const count = () => received.filter(message => message.topic === 'runtime.state').length
  const baseline = count()
  const control = vi.spyOn(engine, 'controlState').mockReturnValue({ connected: false, action: 'pause', delivery: 'UNKNOWN' })
  const diagnose = (state: EngineConnectionDiagnostic['state']) => diagnoseEngine({ runId, taskId: run.taskId }, {
    kind: 'ENGINE_CONNECTION_DIAGNOSTIC', runId, state, message: '上游连接诊断',
  })
  diagnose('DISCONNECTED')
  await flush()
  expect(count()).toBe(baseline + 1)
  for (let attempt = 0; attempt < 5; attempt++) { diagnose('CONNECTING'); diagnose('DISCONNECTED') }
  await flush()
  expect(count()).toBe(baseline + 1)
  expect(await read()).toMatchObject({ configLocked: true, engineControl: { connected: false, action: 'pause', delivery: 'UNKNOWN' } })
  control.mockReturnValue({ connected: true, action: 'pause', delivery: 'UNKNOWN' })
  diagnose('CONNECTED')
  await flush()
  expect(count()).toBe(baseline + 2)
})

it('文件与远端接收使用原始端口，校验两份文件指纹，不修改已保存场景，停止完成归档', async () => {
  const { api, runId, peers, read, archive, confirmed, fileSource, sceneBefore, start } = await setup(true)
  expect(await read()).toMatchObject({ fileSource, scenarioId: fileReceptionScenarioId(fileSource), configLocked: true })
  peers[0]!.send(JSON.stringify({ ...sample, frame_id: 5, sim_time_s: undefined }))
  await vi.waitFor(async () => expect((await read()).canonical.currentTime).toBe(5))
  expect((await confirmed('STOP')).status).toBe(200)
  const saved = await archive.load(runId)
  expect(saved?.frameCount).toBe(1)
  const path = await archive.getFile(runId, saved!.sourceSha256)
  const frame = JSON.parse((await readFile(path!, 'utf8')).trim())
  expect(frame.links[0]).toMatchObject({ sourcePlatformId: 'rear_comm_vehicle', targetPlatformId: 'command_vehicle', linkIds: ['FILE-LINK-1'] })
  expect(frame.simulationTime).toBe(5)
  expect((await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data).toEqual(sceneBefore)
  expect(start).not.toHaveBeenCalled()
})

it('独立远端播放发送精确两字段；暂停可恢复，停止发送后完成本地归档并解锁', async () => {
  const { api, runId, command, read, messages, peers, stop, complete, confirmed, start } = await setup()
  for (const [cmd, action] of [['PAUSE', 'pause'], ['RESUME', 'resume']] as const) {
    const response = await command({ command: cmd }).expect(202)
    expect(response.body.data).toMatchObject({ uiStatus: 'RUNNING', canonical: { status: 'RUNNING', processId: null }, configLocked: true,
      engineControl: { connected: true, action, delivery: 'SENT' } })
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({ msg_type: 'sim_control', action }))
    await command({ command: cmd }).expect(409)
  }
  await command({ command: 'STEP', stepCount: 1 }).expect(409)
  await command({ command: 'SET_SPEED', speedMultiplier: 2 }).expect(409)
  // 未确认的建议回执和无关本机进程不能改变远端播放会话。
  peers[0]!.send(JSON.stringify({ msg_type: 'sim_control_ack', action: 'stop', success: true, state: 'STOPPED' }))
  complete({ code: 0, completedAt: '2026-11-09T01:01:00Z' })
  expect((await read()).uiStatus).toBe('RUNNING')
  await command({ command: 'STOP' }).expect(428)
  expect(messages).toHaveLength(2)
  const context = await api.post('/api/v1/confirmations').set(headers).send({ action: 'SIMULATION_STOP', objectId: runId }).expect(201)
  const confirmationId = context.body.data.confirmationId
  await api.post(`/api/v1/confirmations/${confirmationId}`).set(headers).send({ confirm: true }).expect(200)
  const stopped = await command({ command: 'STOP', confirmationId }).expect(200)
  expect(stopped.body.data).toMatchObject({ uiStatus: 'STOPPED', completedAt: receptionCompletedAt, configLocked: false, engineControl: { connected: false, action: 'stop', delivery: 'SENT' } })
  await vi.waitFor(() => expect(messages).toEqual(['pause', 'resume', 'stop'].map(action => ({ msg_type: 'sim_control', action }))))
  expect(stop).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(peers[0]!.readyState).toBe(WebSocket.CLOSED))
  await command({ command: 'RESUME' }).expect(409)
  expect((await confirmed('STOP')).status).toBe(409)
  await vi.waitFor(async () => expect(await read()).toMatchObject({ uiStatus: 'STOPPED', configLocked: false, canonical: { status: 'IDLE', processId: null } }))
  expect(await read()).toHaveProperty('engineControl.delivery', 'SENT')
  expect(messages).toHaveLength(3)
  expect(start).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
})

it.each([false, true])('远端帧经场景映射推送页面并留存 JSONL/CSV；停止后可重新播放，不混入旧帧（文件模式 %s）', async fileMode => {
  const { api, app, runId, peers, read, root, archive, confirmed, messages, fileSource } = await setup(fileMode)
  const browser = new WebSocket(`ws://127.0.0.1:${app.httpServer.address().port}/ws/v1?role=OPERATOR`, { origin: headers.Origin })
  cleanups.push(() => browser.terminate())
  const received: any[] = []
  browser.on('message', (raw: { toString(): string }) => received.push(JSON.parse(raw.toString())))
  await once(browser, 'open')
  browser.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['link.metric', 'runtime.state', 'simulation.frame'] }))
  await vi.waitFor(() => expect(received.some(message => message.type === 'subscribed')).toBe(true))
  const sent = { ...sample, frame_id: 5, sim_time_s: undefined }
  peers[0]!.send(JSON.stringify(sent))
  await vi.waitFor(() => expect(received.some(message => message.topic === 'link.metric' && message.payload.frameId === 5)).toBe(true))
  expect(received.some(message => message.topic === 'simulation.frame')).toBe(false)
  expect(await read()).toMatchObject({ canonical: { currentTime: 5, processId: null } })
  const frame = received.find(message => message.topic === 'link.metric').payload
  expect(frame.simulationTime).toBe(5)
  expect(frame.runId).toBe(runId)
  expect(frame.jammers).toHaveLength(sample.jammer_params.length)
  peers[0]!.send(JSON.stringify(sent))
  expect((await confirmed('STOP')).status).toBe(200)
  const persisted = await archive.load(runId)
  expect(persisted?.frameCount).toBe(1)
  const file = await archive.getFile(runId, persisted!.sourceSha256)
  expect(JSON.parse((await readFile(file!, 'utf8')).trim())).toEqual(frame)
  expect((await readdir(join(root, runId, 'csv'))).length).toBeGreaterThan(0)
  expect(messages).toEqual([{ msg_type: 'sim_control', action: 'stop' }])
  const next = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001',
    scenarioId: fileMode ? fileReceptionScenarioId(fileSource) : 'SCN-001', ...(fileMode ? { fileSource } : {}) }).expect(201)
  expect(next.body.data.runId).not.toBe(runId)
  expect(next.body.data).not.toHaveProperty('engineControl')
  await api.post(`/api/v1/simulations/${next.body.data.runId}/commands`).set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
  await vi.waitFor(() => expect(peers).toHaveLength(2))
  await vi.waitFor(() => expect(peers[0]!.readyState).toBe(WebSocket.CLOSED))
  const nextRunId: string = next.body.data.runId
  expect((await api.get(`/api/v1/simulations/${nextRunId}`).set(headers).expect(200)).body.data)
    .toMatchObject({ canonical: { currentTime: 0 }, engineControl: { action: null, delivery: 'IDLE' } })
  peers[1]!.send(JSON.stringify({ ...sample, frame_id: 0, sim_time_s: undefined }))
  await vi.waitFor(() => expect(received.some(message => message.payload?.runId === nextRunId && message.payload.frameId === 0)).toBe(true))
  const context = await api.post('/api/v1/confirmations').set(headers).send({ action: 'SIMULATION_STOP', objectId: nextRunId }).expect(201)
  const confirmationId = context.body.data.confirmationId
  await api.post(`/api/v1/confirmations/${confirmationId}`).set(headers).send({ confirm: true }).expect(200)
  await api.post(`/api/v1/simulations/${nextRunId}/commands`).set(headers).send({ command: 'STOP', confirmationId }).expect(200)
  const nextSaved = await archive.load(nextRunId)
  expect(nextSaved?.frameCount).toBe(1)
  const nextFile = await archive.getFile(nextRunId, nextSaved!.sourceSha256)
  const nextFrame = JSON.parse((await readFile(nextFile!, 'utf8')).trim())
  expect(nextFrame).toMatchObject({ runId: nextRunId, frameId: 0, simulationTime: 0 })
  expect(nextFile).not.toBe(file)
  expect(await readFile(file!, 'utf8')).toBe(`${JSON.stringify(frame)}\n`)
  expect((await archive.load(runId))?.frameCount).toBe(1)
  await vi.waitFor(() => expect(messages).toEqual([
    { msg_type: 'sim_control', action: 'stop' }, { msg_type: 'sim_control', action: 'stop' },
  ]))
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

it('停止保持权限和确认保护，归档失败不解锁，再点停止只重试保存且不重发', async () => {
  const { api, runId, archive, confirmed, read, messages, command } = await setup()
  await api.post(`/api/v1/simulations/${runId}/commands`).set({ ...headers, 'X-Demo-Role': 'OBSERVER' })
    .send({ command: 'STOP', confirmationId: 'made-up' }).expect(403)
  await command({ command: 'STOP', confirmationId: 'made-up' }).expect(409)
  const finalize = vi.spyOn(archive, 'finalizeCsv').mockRejectedValueOnce(new Error('磁盘暂不可用'))
  expect((await confirmed('STOP')).status).toBe(503)
  expect(await read()).toMatchObject({ uiStatus: 'ERROR', configLocked: true })
  expect((await confirmed('STOP')).status).toBe(200)
  expect(await read()).toMatchObject({ uiStatus: 'STOPPED', configLocked: false })
  expect(finalize).toHaveBeenCalledTimes(2)
  expect(messages).toEqual([{ msg_type: 'sim_control', action: 'stop' }])
})

it('断线时停止仍完成本地收尾，不声称发送成功', async () => {
  const { engine, confirmed, read, messages } = await setup()
  engine.stop()
  expect((await confirmed('STOP')).status).toBe(200)
  expect(await read()).toMatchObject({ uiStatus: 'STOPPED', configLocked: false, engineControl: { connected: false, action: null, delivery: 'IDLE' } })
  expect(messages).toEqual([])
})

it('实际归档发布失败保留两帧和时间，停止重试成功后才发布报表并解锁', async () => {
  const save = vi.fn<NonNullable<Parameters<typeof setup>[1]>>().mockResolvedValue(undefined)
  const { confirmed, read, messages, peers, runId, root, archive, command } = await setup(true, save)
  peers[0]!.send(JSON.stringify(latestSamples[0]))
  await vi.waitFor(async () => expect((await read()).canonical.currentTime).toBe(3775))
  await command({ command: 'PAUSE' }).expect(202)
  expect(await read()).toMatchObject({ engineControl: { action: 'pause', delivery: 'SENT' } })
  await command({ command: 'RESUME' }).expect(202)
  peers[0]!.send(JSON.stringify(latestSamples[1]))
  await vi.waitFor(async () => expect((await read()).canonical.currentTime).toBe(3780))
  const blocked = join(root, runId, 'current.json')
  await mkdir(blocked)
  expect((await confirmed('STOP')).status).toBe(503)
  expect(await read()).toMatchObject({ uiStatus: 'ERROR', configLocked: true, canonical: { currentTime: 3780 } })
  expect(save).not.toHaveBeenCalled()
  const files = await readdir(join(root, runId))
  const raw = files.find((name: string) => name.endsWith('.jsonl'))!
  const before = await readFile(join(root, runId, raw), 'utf8')
  expect(before.trim().split('\n').map((line: string) => JSON.parse(line).frameId)).toEqual([3775, 3780])
  await rm(blocked, { recursive: true })
  expect((await confirmed('STOP')).status).toBe(200)
  expect(await read()).toMatchObject({ uiStatus: 'STOPPED', configLocked: false, canonical: { currentTime: 3780 } })
  expect(await archive.load(runId)).toMatchObject({ frameCount: 2 })
  expect(await readFile(join(root, runId, raw), 'utf8')).toBe(before)
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId }), receptionCompletedAt, 3780)
  expect(messages).toEqual(['pause', 'resume', 'stop'].map(action => ({ msg_type: 'sim_control', action })))
})

it('停止等待正在写入的帧，不提前成功、不把最后一帧留在报表外', async () => {
  const { confirmed, read, peers, runId, root, archive } = await setup(true)
  const probe = await open(join(root, 'probe'), 'wx'), prototype = Object.getPrototypeOf(probe)
  await probe.close()
  const original = prototype.write
  let release!: () => void, entered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(prototype, 'write').mockImplementation(async function (this: any, ...args: any[]) {
    if (args[0].toString().includes('ENGINE_FRAME')) { entered = true; await gate }
    return original.apply(this, args)
  })
  try {
    peers[0]!.send(JSON.stringify(latestSamples[0]))
    await vi.waitFor(() => expect(entered).toBe(true))
    let finished = false
    const stopping = confirmed('STOP').then(response => { finished = true; return response })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(finished).toBe(false)
    expect((await read()).configLocked).toBe(true)
    release()
    expect((await stopping).status).toBe(200)
    expect(await archive.load(runId)).toMatchObject({ frameCount: 1, lastSimulationTime: 3775 })
    expect(await read()).toMatchObject({ uiStatus: 'STOPPED', canonical: { currentTime: 3775 } })
  } finally { release() }
})

it('首帧写盘失败立即锁定并保留待写数据，磁盘恢复后停止可保存该帧', async () => {
  const { confirmed, read, peers, runId, root, archive } = await setup(true)
  const probe = await open(join(root, 'probe'), 'wx'), prototype = Object.getPrototypeOf(probe)
  await probe.close()
  const original = prototype.write
  const write = vi.spyOn(prototype, 'write').mockImplementation(async function (this: any, ...args: any[]) {
    if (args[0].toString().includes('ENGINE_FRAME')) throw new Error('模拟磁盘暂不可用')
    return original.apply(this, args)
  })
  peers[0]!.send(JSON.stringify(latestSamples[0]))
  await vi.waitFor(async () => expect(await read()).toMatchObject({ uiStatus: 'ERROR', configLocked: true }))
  expect((await confirmed('STOP')).status).toBe(503)
  expect((await read()).configLocked).toBe(true)
  write.mockRestore()
  expect((await confirmed('STOP')).status).toBe(200)
  const saved = (await archive.load(runId))!
  expect(saved).toMatchObject({ frameCount: 1, lastSimulationTime: 3775 })
  const restored = JSON.parse((await readFile((await archive.getFile(runId, saved.sourceSha256))!, 'utf8')).trim())
  expect(restored.links[1].quality.ber).toBe(latestSamples[0]!.link_calc.links[1]!.quality.ber)
  expect(await read()).toMatchObject({ uiStatus: 'STOPPED', configLocked: false })
})

it('停止等待报表发布；发布失败保留锁，重试不重发 stop', async () => {
  const save = vi.fn<NonNullable<Parameters<typeof setup>[1]>>().mockRejectedValueOnce(new Error('报表写盘失败')).mockResolvedValue(undefined)
  const { confirmed, read, messages, peers, runId } = await setup(true, save)
  peers[0]!.send(JSON.stringify({ ...sample, frame_id: 3780, sim_time_s: undefined }))
  await vi.waitFor(async () => expect((await read()).canonical.currentTime).toBe(3780))
  expect((await confirmed('STOP')).status).toBe(503)
  expect(await read()).toMatchObject({ uiStatus: 'ERROR', configLocked: true })
  expect((await confirmed('STOP')).status).toBe(200)
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ runId }), receptionCompletedAt, 3780)
  expect(save).toHaveBeenCalledTimes(2)
  expect(await read()).toMatchObject({ uiStatus: 'STOPPED', configLocked: false })
  expect(messages).toEqual([{ msg_type: 'sim_control', action: 'stop' }])
})

it('停止发送失败后标记 UNKNOWN 并保存本地数据，不自动重发', async () => {
  const { engine, confirmed, read, messages } = await setup()
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (_data: unknown, callback: unknown) {
    ;(callback as (error?: Error) => void)(new Error('write failed'))
  })
  expect((await confirmed('STOP')).status).toBe(200)
  expect(await read()).toMatchObject({ uiStatus: 'STOPPED', configLocked: false, engineControl: { connected: false, action: 'stop', delivery: 'UNKNOWN' } })
  expect(engine.controlState((await read()).runId)).toBeUndefined()
  expect(messages).toEqual([])
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

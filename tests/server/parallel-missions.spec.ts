// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioDraft, SimulationRun } from '../../src/contracts/domain-models'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { createTemplateScenario } from '../fixtures/template-scenario'
vi.mock('node:child_process', { spy: true })
const { createMockServer } = await import('../../server/' + 'app.js')
const { LocalMissionPool, readMissionConcurrency } = await import('../../server/local/' + 'mission-pool.js')
const { LocalMissionRunner } = await import('../../server/local/' + 'mission-runner.js')
const { MissionGuard } = await import('../../server/local/' + 'mission-guard.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { default: request } = await import('super' + 'test')
const { mkdtemp, rm, readdir, writeFile, appendFile, readFile } = await import('node:fs/' + 'promises')
const { once, EventEmitter } = await import('node:' + 'events')
const childProcess = await import('node:' + 'child_process')
const { createHash } = await import('node:' + 'crypto')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
const admin = { ...headers, 'X-Demo-Role': 'ADMIN' }
const missionClock = {
  now: Date.now,
  schedule(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}
const servers: Array<ReturnType<typeof createMockServer>> = []
const roots: string[] = []
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function handle(pid: number) {
  const done = deferred<{ code: number | null; errorMessage?: string }>()
  return { done, process: { pid, startedAt: '2026-10-27T04:00:00Z', entryPath: `owned/${pid}/mission.txt`, completed: done.promise,
    readPositions: async () => ({ runId: `RUN-${pid}`, scenarioId: `SCN-${pid}`, revision: 1, positions: null }),
    stop: vi.fn(async () => { done.resolve({ code: null }) }) } }
}
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function rootDirectory() { const root = await mkdtemp(join(tmpdir(), 'wrj-parallel-')); roots.push(root); return root }
const childPath = (root: string, taskId: string) => join(root, 'parallel-tasks', `TASK-${createHash('sha256').update(taskId).digest('hex')}`)
async function apiFor(start: (...args: any[]) => Promise<any>, capacity = 2) {
  const server = createMockServer({ port: 0, missionClock, missionExecution: { start, maxParallelTasks: capacity } }); servers.push(server)
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(server.httpServer)
  const current = (await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data
  // 1112 固定模板只接受模板实例范围内的场景；把 SCN-001 替换为模板兼容配置，另存一份 SCN-PARALLEL。
  const template = createTemplateScenario()
  template.config.scenario.id = 'SCN-001'
  template.config.jammers.forEach(jammer => { jammer.frequency = 4500 })
  await api.put('/api/v1/scenarios/SCN-001').set(headers)
    .send({ config: template.config, uiExtensions: template.uiExtensions, expectedRevision: current.revision }).expect(200)
  const draft = structuredClone(template)
  draft.config.scenario.id = 'SCN-PARALLEL'
  await api.post('/api/v1/scenarios').set(headers).send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: 0 }).expect(201)
  const create = async (taskId: string, scenarioId: string) => (await api.post('/api/v1/simulations').set(headers).send({ taskId, scenarioId }).expect(201)).body.data
  const command = (id: string, body: object) => api.post(`/api/v1/simulations/${id}/commands`).set(headers).send(body)
  const read = async (id: string) => (await api.get(`/api/v1/simulations/${id}`).set(headers).expect(200)).body.data
  return { api, server, create, command, read }
}

describe('多任务API：重叠执行而非顺序任务', () => {
  it.each(['close', 'terminate'] as const)('订阅 %s 后及时重连不停止 mission；最后页面离开后仍停止并解锁', async method => {
    const mission = handle(405)
    const { api, server, create, command, read } = await apiFor(async () => mission.process)
    const run = await create('TASK-001', 'SCN-001')
    await command(run.runId, { command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    const { WebSocket } = await import('w' + 's')
    const connect = async () => {
      const client = new WebSocket('ws://127.0.0.1:' + server.httpServer.address().port + '/ws/v1?role=OPERATOR&missionRunId=' + run.runId, { origin: headers.Origin })
      await once(client, 'open')
      const subscribed = once(client, 'message')
      client.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: run.taskId, topics: ['runtime.state'] }))
      await subscribed
      return client
    }
    const original = await connect()
    const closed = once(original, 'close'); original[method](); await closed
    if (method === 'terminate') {
      await new Promise(resolve => setTimeout(resolve, 3_000))
      await api.get(`/api/v1/simulations/${run.runId}?pageOwner=1`).set(headers).expect(200)
      await new Promise(resolve => setTimeout(resolve, 2_300))
      expect(mission.process.stop).not.toHaveBeenCalled()
    }
    const resumed = await connect()
    try {
      if (method === 'close') await new Promise(resolve => setTimeout(resolve, 5_200))
      expect(mission.process.stop).not.toHaveBeenCalled()
      expect(await read(run.runId)).toMatchObject({ uiStatus: 'RUNNING', configLocked: true })
    } finally { resumed.terminate() }
    await expect.poll(async () => (await api.get(`/api/v1/simulations/${run.runId}?pageOwner=1`).set(admin)).body.data,
      { timeout: 7_000 }).toMatchObject({ uiStatus: 'STOPPED', configLocked: false })
    expect(mission.process.stop).toHaveBeenCalledOnce()
    expect((await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data.locked).toBe(false)
  }, 15_000)

  it('启动尚未完成时重连接管页面，取消已经到期的离开停止请求', async () => {
    const mission = handle(406), launch = deferred<typeof mission.process>()
    const start = vi.fn(async () => launch.promise)
    const { server, create, command, read } = await apiFor(start)
    const run = await create('TASK-001', 'SCN-001')
    const { WebSocket } = await import('w' + 's')
    const connect = async () => {
      const client = new WebSocket('ws://127.0.0.1:' + server.httpServer.address().port + '/ws/v1?role=OPERATOR&missionRunId=' + run.runId, { origin: headers.Origin })
      await once(client, 'open')
      const subscribed = once(client, 'message')
      client.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: run.taskId, topics: ['runtime.state'] }))
      await subscribed
      return client
    }
    const original = await connect()
    const pending = command(run.runId, { command: 'START', mode: 'INTERACTIVE_SINGLE' }).then((response: any) => response)
    await expect.poll(() => start.mock.calls.length).toBe(1)
    const closed = once(original, 'close'); original.terminate(); await closed
    await new Promise(resolve => setTimeout(resolve, 5_200))
    const resumed = await connect()
    try {
      launch.resolve(mission.process)
      expect((await pending).status).toBe(200)
      expect(await read(run.runId)).toMatchObject({ uiStatus: 'RUNNING', configLocked: true })
      expect(mission.process.stop).not.toHaveBeenCalled()
      mission.done.resolve({ code: 0 })
      await expect.poll(() => read(run.runId)).toMatchObject({ uiStatus: 'COMPLETED', configLocked: false })
    } finally { resumed.terminate() }
  }, 15_000)

  it('两任务同时启动，位置/状态/停止/场景锁独立，重置受全部活动任务保护', async () => {
    const first = handle(101), second = handle(102)
    const start = vi.fn(async (_draft: ScenarioDraft, runId: string, taskId: string) => {
      const run = taskId === 'TASK-001' ? first : second
      run.process.readPositions = async () => ({ runId, scenarioId: _draft.config.scenario.id, revision: _draft.revision, positions: null })
      return run.process
    })
    const { api, create, command, read } = await apiFor(start)
    const a = await create('TASK-001', 'SCN-001'), b = await create('TASK-B', 'SCN-PARALLEL')
    expect(a.runId).not.toBe(b.runId)
    await Promise.all([command(a.runId, { command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200), command(b.runId, { command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)])
    expect(start).toHaveBeenCalledTimes(2)
    expect(await read(a.runId)).toMatchObject({ taskId: 'TASK-001', uiStatus: 'RUNNING', canonical: { processId: 101 } })
    expect(await read(b.runId)).toMatchObject({ taskId: 'TASK-B', uiStatus: 'RUNNING', canonical: { processId: 102 } })
    for (const run of [a, b]) expect((await api.get(`/api/v1/simulations/${run.runId}/positions`).set(headers).expect(200)).body.data).toMatchObject({ runId: run.runId, scenarioId: run.scenarioId })
    await api.post('/api/v1/reset').set(admin).send({ confirm: true }).expect(409)
    await api.get(`/api/v1/simulations/${b.runId}/frames/F-00042`).set(headers).expect(404)
    const confirmation = (await api.post('/api/v1/confirmations').set(headers).send({ action: 'SIMULATION_STOP', objectId: a.runId }).expect(201)).body.data
    await api.post(`/api/v1/confirmations/${confirmation.confirmationId}`).set(headers).send({ confirm: true }).expect(200)
    await command(a.runId, { command: 'STOP', confirmationId: confirmation.confirmationId }).expect(200)
    expect(second.process.stop).not.toHaveBeenCalled()
    expect((await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data.locked).toBe(false)
    expect((await api.get('/api/v1/scenarios/SCN-PARALLEL').set(headers)).body.data.locked).toBe(true)
    expect((await read(b.runId)).uiStatus).toBe('RUNNING')
    second.done.resolve({ code: 0 })
    await expect.poll(() => read(b.runId)).toMatchObject({ uiStatus: 'COMPLETED', configLocked: false })
    await api.post('/api/v1/reset').set(admin).send({ confirm: true }).expect(200)
  })

  it('启动中的任务不阻塞另一个任务，重复/超量/同场景创建拒绝，关闭等待全部任务', async () => {
    const a = handle(201), b = handle(202), launch = deferred<typeof a.process>()
    const start = vi.fn(async (_draft: ScenarioDraft, _runId: string, taskId: string) => taskId === 'TASK-001' ? launch.promise : b.process)
    const { api, server, create, command, read } = await apiFor(start)
    const first = await create('TASK-001', 'SCN-001')
    await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-B', scenarioId: 'SCN-001' }).expect(409)
    const second = await create('TASK-B', 'SCN-PARALLEL')
    const pending = command(first.runId, { command: 'START', mode: 'INTERACTIVE_SINGLE' }).then((response: { status: number }) => response)
    await expect.poll(() => start.mock.calls.length).toBe(1)
    await command(first.runId, { command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(409)
    await command(second.runId, { command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-C', scenarioId: 'SCN-001' }).expect(409)
    expect((await read(second.runId)).uiStatus).toBe('RUNNING')
    launch.resolve(a.process)
    expect((await pending).status).toBe(200)
    await server.close()
    expect(a.process.stop).toHaveBeenCalledOnce(); expect(b.process.stop).toHaveBeenCalledOnce()
  })
})

describe('本地多任务运行池保护', () => {
  it.each([false, true])('两个运行器持续写各自CSV，故障仅停止本任务=%s，状态与清单独立', async failFirst => {
    const root = await rootDirectory()
    const children: Array<{ child: any; directory: string }> = []
    const execFile = vi.spyOn(childProcess, 'execFile').mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, out: string, err: string) => void
      if (args[0] === 'taskkill') {
        const pid = Number((args[1] as string[])[1])
        const child = children.find(item => item.child.pid === pid)?.child
        queueMicrotask(() => { callback(null, '', ''); child?.emit('close', null) })
      } else queueMicrotask(() => callback(null, 'probe complete', ''))
      return new EventEmitter() as never
    })
    vi.spyOn(childProcess, 'spawn').mockImplementation((...args: unknown[]) => {
      const directory = (args[2] as { cwd: string }).cwd
      const child = Object.assign(new EventEmitter(), { pid: 600 + children.length,
        kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true }) })
      children.push({ child, directory })
      queueMicrotask(() => child.emit('spawn'))
      return child as never
    })
    const execution = new LocalMissionPool(join(root, 'mission.exe'), root, undefined, 2)
    const server = createMockServer({ port: 0, missionExecution: execution }); servers.push(server)
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(server.httpServer)
    const current = (await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data
    const template = createTemplateScenario()
    template.config.scenario.id = 'SCN-001'
    template.config.jammers.forEach(jammer => { jammer.frequency = 4500 })
    await api.put('/api/v1/scenarios/SCN-001').set(headers)
      .send({ config: template.config, uiExtensions: template.uiExtensions, expectedRevision: current.revision }).expect(200)
    const live = structuredClone(template)
    live.config.scenario.id = 'SCN-LIVE'
    await api.post('/api/v1/scenarios').set(headers).send({ config: live.config, uiExtensions: live.uiExtensions, expectedRevision: 0 }).expect(201)
    const runs: SimulationRun[] = []
    for (const [taskId, scenarioId] of [['TASK-001', 'SCN-001'], ['TASK-LIVE', 'SCN-LIVE']]) {
      runs.push((await api.post('/api/v1/simulations').set(headers).send({ taskId, scenarioId }).expect(201)).body.data)
    }
    await Promise.all(runs.map(run => api.post(`/api/v1/simulations/${run.runId}/commands`).set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)))
    expect(children).toHaveLength(2)
    expect(new Set(children.map(item => item.directory)).size).toBe(2)
    const archives: Array<{ directory: string; taskId: string; runDirectory: string; rawPath: string }> = []
    for (const run of runs) {
      const taskRoot = childPath(root, run.taskId)
      const directories = await readdir(taskRoot)
      const directory = join(taskRoot, directories.find((name: string) => name.startsWith('mission-'))!)
      const mapping = JSON.parse(await readFile(join(directory, 'mapping.json'), 'utf8'))
      const rawPath = join(directory, mapping.output.resolvedDirectory, 'scenario_events.csv')
      await writeFile(rawPath, REPORT_EVENT_CSV)
      await appendFile(join(directory, 'mission-console.log'), 'Simulation complete\n')
      const archiveRoot = join(taskRoot, 'time-series', run.taskId)
      const archive = join(archiveRoot, (await readdir(archiveRoot))[0]!)
      archives.push({ directory: archive, taskId: run.taskId, runDirectory: directory, rawPath })
      await expect.poll(async () => await readFile(join(archive, 'events.csv'), 'utf8')).toContain(`${run.taskId},1.1,`)
      await expect(readFile(join(archive, 'manifest.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
    if (failFirst) {
      await appendFile(archives[0]!.rawPath, '\nnot-a-supported-event\n')
      await expect.poll(async () => (await api.get(`/api/v1/simulations/${runs[0].runId}`).set(headers)).body.data).toMatchObject({ uiStatus: 'ERROR', configLocked: false })
      const failedChild = children.find(item => item.directory === archives[0]!.runDirectory)!.child
      const treeKills = execFile.mock.calls.filter(call => call[0] === 'taskkill')
      expect(treeKills).toHaveLength(1)
      expect(treeKills[0]).toEqual(expect.arrayContaining(['taskkill', ['/PID', String(failedChild.pid), '/T', '/F']]))
      expect(failedChild.kill).not.toHaveBeenCalled()
      expect(children.find(item => item.directory === archives[1]!.runDirectory)!.child.kill).not.toHaveBeenCalled()
      expect((await api.get(`/api/v1/simulations/${runs[1].runId}`).set(headers)).body.data.uiStatus).toBe('RUNNING')
    }
    for (const child of children) if (!failFirst || child.directory !== archives[0]!.runDirectory) child.child.emit('close', 0)
    for (const [index, run] of runs.entries()) await expect.poll(async () => (await api.get(`/api/v1/simulations/${run.runId}`).set(headers)).body.data.uiStatus).toBe(failFirst && index === 0 ? 'ERROR' : 'COMPLETED')
    for (const archive of archives) {
      expect(JSON.parse(await readFile(join(archive.directory, 'manifest.json'), 'utf8'))).toMatchObject({ taskId: archive.taskId, status: failFirst && archive === archives[0] ? 'FAILED' : 'COMPLETED' })
      const rows: string[] = (await readFile(join(archive.directory, 'events.csv'), 'utf8')).trimEnd().split('\r\n').slice(1)
      expect(rows.every(row => row.startsWith(`${archive.taskId},`))).toBe(true)
    }
    expect(execution.safetyStatus()).toBeNull()
  })

  it.each(['close', 'terminate'] as const)('关闭浏览器 %s 后停止本机 mission，确认退出再解锁，不恢复旧运行', async closeMethod => {
    const root = await rootDirectory()
    let directory = ''
    const child = Object.assign(new EventEmitter(), { pid: 7654, kill: vi.fn(() => { child.emit('close', null); return true }) })
    vi.spyOn(childProcess, 'spawn').mockImplementation((...args: unknown[]) => {
      directory = (args[2] as { cwd: string }).cwd
      queueMicrotask(() => child.emit('spawn'))
      return child as never
    })
    vi.spyOn(childProcess, 'execFile').mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, out: string, err: string) => void
      queueMicrotask(() => callback(null, '', ''))
      return new EventEmitter() as never
    })
    const pool = new LocalMissionPool(join(root, 'mission.exe'), root, undefined, 1, 0, undefined, true)
    const server = createMockServer({ port: 0, missionClock, missionExecution: pool }); servers.push(server)
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(server.httpServer)
    const current = (await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data
    const draft = createTemplateScenario()
    draft.config.scenario.id = 'SCN-001'
    draft.config.jammers.forEach(jammer => { jammer.frequency = 4500 })
    await api.put('/api/v1/scenarios/SCN-001').set(headers)
      .send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: current.revision }).expect(200)
    const run = (await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)).body.data
    await api.post('/api/v1/simulations/' + run.runId + '/commands').set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    const { WebSocket } = await import('w' + 's')
    const browser = new WebSocket('ws://127.0.0.1:' + server.httpServer.address().port + '/ws/v1?role=OPERATOR&missionRunId=' + run.runId, { origin: headers.Origin })
    await once(browser, 'open')
    const subscribed = once(browser, 'message')
    browser.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: run.taskId, topics: ['runtime.state'] }))
    await subscribed
    const secondPage = new WebSocket('ws://127.0.0.1:' + server.httpServer.address().port + '/ws/v1?role=OPERATOR&missionRunId=' + run.runId, { origin: headers.Origin })
    await once(secondPage, 'open')
    const secondSubscribed = once(secondPage, 'message')
    secondPage.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: run.taskId, topics: ['runtime.state'] }))
    await secondSubscribed
    const monitor = new WebSocket('ws://127.0.0.1:' + server.httpServer.address().port + '/ws/v1?role=OPERATOR', { origin: headers.Origin })
    await once(monitor, 'open')
    const monitorSubscribed = once(monitor, 'message')
    monitor.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: run.taskId, topics: ['runtime.state'] }))
    await monitorSubscribed
    const firstClosed = once(browser, 'close'); browser[closeMethod](); await firstClosed
    expect(childProcess.execFile).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    expect((await api.get('/api/v1/simulations/' + run.runId).set(headers)).body.data.configLocked).toBe(true)
    const closed = once(secondPage, 'close'); secondPage[closeMethod](); await closed
    await expect.poll(() => vi.mocked(childProcess.execFile).mock.calls.length + child.kill.mock.calls.length, { timeout: 7_000 }).toBe(1)
    // 进程尚未报告退出，不能只清锁；再次打开也不能重复启动。
    expect((await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data.locked).toBe(true)
    await api.post('/api/v1/simulations/' + run.runId + '/commands').set(headers)
      .send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(409)
    expect(childProcess.spawn).toHaveBeenCalledOnce()
    child.emit('close', null)
    await expect.poll(async () => (await api.get('/api/v1/simulations/' + run.runId).set(headers)).body.data)
      .toMatchObject({ uiStatus: 'STOPPED', configLocked: false, canonical: { processId: null } })
    monitor.terminate()
    expect((await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data.locked).toBe(false)
    expect(pool.safetyStatus()).toBeNull()
    await api.post('/api/v1/simulations').set(headers).send({ taskId: run.taskId, scenarioId: 'SCN-001' }).expect(201)
  }, 15_000)

  it('启动响应前浏览器强制断开，启动完成后停止；其他任务不受影响', async () => {
    const first = handle(401), second = handle(402), launch = deferred<typeof first.process>()
    const start = vi.fn(async (_draft: ScenarioDraft, _runId: string, taskId: string) => taskId === 'TASK-001' ? launch.promise : second.process)
    const { server, create, command, read } = await apiFor(start)
    const a = await create('TASK-001', 'SCN-001'), b = await create('TASK-B', 'SCN-PARALLEL')
    await command(b.runId, { command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    const { WebSocket } = await import('w' + 's')
    const browser = new WebSocket('ws://127.0.0.1:' + server.httpServer.address().port + '/ws/v1?role=OPERATOR&missionRunId=' + a.runId, { origin: headers.Origin })
    await once(browser, 'open')
    const subscribed = once(browser, 'message')
    browser.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: a.taskId, topics: ['runtime.state'] }))
    await subscribed
    const pending = command(a.runId, { command: 'START', mode: 'INTERACTIVE_SINGLE' }).then((response: any) => response)
    await expect.poll(() => start.mock.calls.length).toBe(2)
    const closed = once(browser, 'close'); browser.terminate(); await closed
    launch.resolve(first.process)
    expect((await pending).status).toBe(200)
    await expect.poll(() => read(a.runId), { timeout: 7_000 }).toMatchObject({ uiStatus: 'STOPPED', configLocked: false })
    expect(first.process.stop).toHaveBeenCalledOnce()
    expect(second.process.stop).not.toHaveBeenCalled()
    expect(await read(b.runId)).toMatchObject({ uiStatus: 'RUNNING', configLocked: true })
  }, 15_000)

  it('START 响应前关闭浏览器且尚未订阅，仍停止已启动的本机进程', async () => {
    const mission = handle(404), launch = deferred<typeof mission.process>()
    const start = vi.fn(async () => launch.promise)
    const { server, create, read } = await apiFor(start)
    const run = await create('TASK-001', 'SCN-001')
    const responseClosed = deferred<void>()
    server.httpServer.once('request', (_req: unknown, res: any) => res.once('close', () => responseClosed.resolve()))
    const { request: httpRequest } = await import('node:' + 'http')
    const browser = httpRequest({ host: '127.0.0.1', port: server.httpServer.address().port,
      path: '/api/v1/simulations/' + run.runId + '/commands', method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } })
    browser.on('error', () => undefined)
    browser.end(JSON.stringify({ command: 'START', mode: 'INTERACTIVE_SINGLE' }))
    await expect.poll(() => start.mock.calls.length).toBe(1)
    browser.destroy()
    await responseClosed.promise
    launch.resolve(mission.process)
    await expect.poll(() => read(run.runId)).toMatchObject({ uiStatus: 'STOPPED', configLocked: false })
    expect(mission.process.stop).toHaveBeenCalledOnce()
  })

  it('浏览器断开后停止失败，不伪造退出或解除场景锁', async () => {
    const mission = handle(403)
    mission.process.stop.mockRejectedValueOnce(new Error('owned process has not exited'))
    const { api, server, create, command, read } = await apiFor(async () => mission.process)
    const run = await create('TASK-001', 'SCN-001')
    await command(run.runId, { command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    const { WebSocket } = await import('w' + 's')
    const browser = new WebSocket('ws://127.0.0.1:' + server.httpServer.address().port + '/ws/v1?role=OPERATOR&missionRunId=' + run.runId, { origin: headers.Origin })
    await once(browser, 'open')
    const subscribed = once(browser, 'message')
    browser.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: run.taskId, topics: ['runtime.state'] }))
    await subscribed
    const closed = once(browser, 'close'); browser.terminate(); await closed
    await expect.poll(() => read(run.runId), { timeout: 7_000 }).toMatchObject({ uiStatus: 'ERROR', configLocked: true, canonical: { processId: 403, errorMessage: 'owned process has not exited' } })
    expect((await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data.locked).toBe(true)
    expect(mission.process.stop).toHaveBeenCalledOnce()
    mission.done.resolve({ code: 0 })
    await expect.poll(() => read(run.runId)).toMatchObject({ configLocked: false })
  }, 15_000)

  it('配置限1至4，非法标识和容量拒绝', async () => {
    expect(readMissionConcurrency()).toBe(1); expect(readMissionConcurrency('4')).toBe(4)
    for (const value of ['0', '5', '2.0', 'NaN', ' 2']) expect(() => readMissionConcurrency(value)).toThrow()
    const root = await rootDirectory()
    expect(() => new LocalMissionPool(join(root, 'mission.exe'), root, undefined, 0)).toThrow()
    expect(() => new LocalMissionPool('relative.exe', root, undefined, 2)).toThrow()
    const pool = new LocalMissionPool(join(root, 'mission.exe'), root, undefined, 2)
    await expect(pool.start({} as ScenarioDraft, '../RUN', '../TASK')).rejects.toThrow('编号')
  })

  it('任务目录隔离且启动先占容量；异常完成/启动失败后可复用，停止未完成时不提前释放', async () => {
    const root = await rootDirectory(), a = handle(301), b = handle(302)
    const launch = deferred<typeof a.process>()
    const calls: string[] = []
    const start = vi.spyOn(LocalMissionRunner.prototype, 'start').mockImplementation(async function(this: any, ...args: unknown[]) {
      const taskId = args[2] as string
      calls.push(this.directory)
      return taskId === 'TASK-a' ? launch.promise : b.process
    })
    const pool = new LocalMissionPool(join(root, 'mission.exe'), root, undefined, 2)
    const draft = new ScenarioProjection().get('SCN-001').data as ScenarioDraft
    const pending = pool.start(draft, 'RUN-1', 'TASK-a')
    await expect.poll(() => start.mock.calls.length).toBe(1)
    await expect(pool.start(draft, 'RUN-2', 'TASK-a')).rejects.toThrow('容量')
    await pool.start(draft, 'RUN-2', 'TASK-A')
    expect(new Set(calls).size).toBe(2)
    expect(calls).toEqual(expect.arrayContaining([childPath(root, 'TASK-a'), childPath(root, 'TASK-A')]))
    await expect(pool.start(draft, 'RUN-3', 'TASK-c')).rejects.toThrow('容量')
    launch.resolve(a.process); await pending
    a.done.resolve({ code: 1 }); await a.process.completed; await Promise.resolve()
    start.mockRejectedValueOnce(new Error('spawn failed'))
    await expect(pool.start(draft, 'RUN-3', 'TASK-c')).rejects.toThrow('spawn failed')
    await pool.start(draft, 'RUN-4', 'TASK-c')
    b.done.resolve({ code: 0 })
  })

  it('旧全局锁、未结清任务锁和损坏目录均阻断，其他任务的正常结束不解除未结清记录', async () => {
    const root = await rootDirectory()
    const pool = new LocalMissionPool(join(root, 'mission.exe'), root, undefined, 2)
    expect(pool.safetyStatus()).toBeNull()
    const guard = new MissionGuard(root)
    await guard.claim(root, { runId: 'RUN-1', scenarioId: 'SCN-001', revision: 1 })
    expect(pool.safetyStatus()).toMatchObject({ scenarioId: 'SCN-001' })
    await guard.clearAfterClose()
    const directory = childPath(root, 'TASK-OLD')
    await new MissionGuard(directory).claim(directory, { runId: 'RUN-OLD', scenarioId: 'SCN-OLD', revision: 1 })
    expect(pool.safetyStatus()).toMatchObject({ scenarioId: 'SCN-OLD' })
    expect(new LocalMissionPool(join(root, 'mission.exe'), root, undefined, 1).safetyStatus()).toMatchObject({ scenarioId: 'SCN-OLD' })
    expect(pool.safetyStatus('TASK-OTHER')).toBeNull()
    await expect(pool.start({} as ScenarioDraft, 'RUN-2', 'TASK-NEW')).rejects.toThrow()
    expect(await readdir(join(directory, '.mission-active'))).toContain('record.json')
    await new MissionGuard(directory).clearAfterClose()
    await writeFile(join(root, 'parallel-tasks', 'unexpected'), 'bad')
    expect(pool.safetyStatus()).toMatchObject({ message: expect.stringContaining('未确认安全') })
  })
})

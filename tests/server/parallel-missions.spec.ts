// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioDraft, SimulationRun } from '../../src/contracts/domain-models'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
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
  const server = createMockServer({ port: 0, missionExecution: { start, maxParallelTasks: capacity } }); servers.push(server)
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(server.httpServer)
  const draft = (await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data
  Object.assign(draft.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
  draft.config.scenario.id = 'SCN-PARALLEL'
  for (const platform of draft.config.platforms) if (platform.type === 'COMMUNICATION_SATELLITE') platform.satelliteType = 'TIANTONG'
  await api.post('/api/v1/scenarios').set(headers).send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: 0 }).expect(201)
  const create = async (taskId: string, scenarioId: string) => (await api.post('/api/v1/simulations').set(headers).send({ taskId, scenarioId }).expect(201)).body.data
  const command = (id: string, body: object) => api.post(`/api/v1/simulations/${id}/commands`).set(headers).send(body)
  const read = async (id: string) => (await api.get(`/api/v1/simulations/${id}`).set(headers).expect(200)).body.data
  return { api, server, create, command, read }
}

describe('多任务API：重叠执行而非顺序任务', () => {
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
    const source = (await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data
    Object.assign(source.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
    await api.put('/api/v1/scenarios/SCN-001').set(headers)
      .send({ config: source.config, uiExtensions: source.uiExtensions, expectedRevision: source.revision }).expect(200)
    source.config.scenario.id = 'SCN-LIVE'
    for (const platform of source.config.platforms) if (platform.type === 'COMMUNICATION_SATELLITE') platform.satelliteType = 'TIANTONG'
    await api.post('/api/v1/scenarios').set(headers).send({ config: source.config, uiExtensions: source.uiExtensions, expectedRevision: 0 }).expect(201)
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

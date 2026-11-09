// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioDraft } from '../../src/contracts/domain-models'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { createTemplateScenario } from '../fixtures/template-scenario'

vi.mock('node:child_process', { spy: true })

const { createMockServer } = await import('../../server/' + 'app.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { LocalMissionRunner, engineHasLinkCalc, resolveMissionOutputDirectory, readConsoleLogTail, readMissionRunTimeout } = await import('../../server/local/' + 'mission-runner.js')
const { MissionGuard } = await import('../../server/local/' + 'mission-guard.js')
const { ScenarioSqliteStorage } = await import('../../server/local/' + 'scenario-sqlite.js')
const { writeScriptText, withoutLinkCalc } = await import('../../server/local/' + 'script-file.js')
const { MissionGenerationError } = await import('../../server/scripts/' + 'mission-generator.js')
const { APP_CONFIG } = await import('../../src/config/' + 'app.config.js')
const { default: request } = await import('super' + 'test')
const { once, EventEmitter } = await import('node:' + 'events')
const { mkdtemp, mkdir, readFile, readdir, rm, appendFile, writeFile } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join, dirname } = await import('node:' + 'path')
const childProcess = await import('node:' + 'child_process')
const { env } = await import('node:' + 'process')
const { default: nodeProcess } = await import('node:' + 'process')
const { setTimeout: delay } = await import('node:' + 'timers/promises')
type MissionOutcome = { code: number | null; completedAt?: string; errorMessage?: string }
type MissionControl = { command: 'PAUSE' | 'RESUME' | 'STEP' } | { command: 'SET_SPEED'; speedMultiplier: number }
type MissionProcess = { pid: number; startedAt: string; entryPath: string; completed: Promise<MissionOutcome>; control?(command: MissionControl): Promise<void>; stop(): Promise<void>
  readConsoleLog?(): Promise<{ text: string; bytes: number; truncated: boolean }>; timeoutMs?: number }

// 对接示例拆分：平台定义分布在公共定义与 5 个平台类型文件中。
const TYPE_FILES = ['comm_PerDefinition.txt', 'comm_platform_COMMAND_VEHICLE.txt', 'comm_platform_MISSION_UAV.txt',
  'comm_platform_JAMMER.txt', 'comm_platform_REAR.txt', 'comm_platform_SAT.txt']
async function readTypeFiles(directory: string): Promise<string> {
  return (await Promise.all(TYPE_FILES.map(name => readFile(join(directory, name), 'utf8')))).join(String.fromCharCode(10))
}
/** 去掉本地运行包的兼容改动及保留定义，还原为保存给对接方的 TXT 写法。 */
async function readDeliveredTypeFiles(directory: string): Promise<string> {
  return (await Promise.all(TYPE_FILES.map(async name => {
    let text = (await readFile(join(directory, name), 'utf8')).replace(/UAV_MESH_MEDIUM__\S+/gu, 'UAV_MESH_MEDIUM')
    if (name === 'comm_PerDefinition.txt') {
      text = text.slice(0, text.indexOf('// 本地运行包：'))
      // /23 为本地 mesh 容量修正；保存给对接方的模板没有该地址行。
      text = text.replace('network COM_MESH_NET WSF_COMM_NETWORK_MESH\n  network_address 10.0.0.0/23\n', 'network COM_MESH_NET WSF_COMM_NETWORK_MESH\n')
      for (const antenna of ['MICRO_UAV_OMNI_ANTENNA', 'MICRO_REAR_PLATFORM_DIR_ANTENNA', 'OMNI_ANTENNA_HIGHGAIN']) {
        text = text.replace(new RegExp(`antenna_pattern ${antenna}[\\s\\S]*?end_antenna_pattern\\n\\n`, 'u'), '')
      }
    }
    if (name === 'comm_platform_JAMMER.txt') text = text.replace(/\n {2}weapon prophet_jammer[\s\S]*?\n {2}end_weapon\n/u, '\n')
    return text.replace(/\n {2}processor local_link_stub WSF_SCRIPT_PROCESSOR[\s\S]*?\n {2}end_processor/u, '')
  }))).join(String.fromCharCode(10))
}
function eventRecords(csv: string): string[][] {
  return csv.split(/\r?\n/).filter((line: string) => !line.startsWith('!')).map((line: string) => line.split(','))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function processHandle() {
  const result = deferred<MissionOutcome>()
  const handle: MissionProcess = { pid: 7654, startedAt: '2026-09-23T00:00:00Z', entryPath: 'generated/mission.txt',
    completed: result.promise, stop: vi.fn(async () => { result.resolve({ code: null }) }) }
  return { handle, result }
}
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
const servers: Array<ReturnType<typeof createMockServer>> = []
let activeRunId = ''
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); vi.mocked(childProcess.spawn).mockReset(); vi.restoreAllMocks() })
async function apiFor(start: (draft: ScenarioDraft) => Promise<MissionProcess>) {
  const server = createMockServer({ port: 0, missionExecution: { start } })
  servers.push(server)
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  const created = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
  activeRunId = created.body.data.runId
  const command = (body: object) => api.post(`/api/v1/simulations/${activeRunId}/commands`).set(headers).send(body)
  const run = async () => (await api.get(`/api/v1/simulations/${activeRunId}`).set(headers).expect(200)).body.data
  return { api, command, run, server }
}

describe('真实 mission 命令边界', () => {
  it('使用服务端保存快照和真实 PID；完成后解锁，不用 Mock PID 或浏览器计时器', async () => {
    const { handle, result } = processHandle()
    const start = vi.fn(async () => handle)
    const { api, command, run, server } = await apiFor(start)
    const draft = (await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data
    await command({ command: 'START', mode: 'PARAMETER_SCAN' }).expect(409)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'SIMULATION_COMMAND', objectId: activeRunId, result: 'ERROR' })
    expect((await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)).body.data)
      .toMatchObject({ uiStatus: 'RUNNING', canonical: { processId: 7654 }, configLocked: true })
    expect(start).toHaveBeenCalledExactlyOnceWith(draft, activeRunId, 'TASK-001')
    await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(409)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'SIMULATION_COMMAND', objectId: activeRunId, result: 'ERROR' })
    await command({ command: 'PAUSE' }).expect(409)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'SIMULATION_COMMAND', objectId: activeRunId, result: 'ERROR' })
    await command({ command: 'SET_SPEED', speedMultiplier: 2 }).expect(409)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'SIMULATION_COMMAND', objectId: activeRunId, result: 'ERROR' })
    await api.post('/api/v1/reset').set({ ...headers, 'X-Demo-Role': 'ADMIN' }).send({ confirm: true }).expect(409)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'SCENARIO_RESET', result: 'ERROR' })
    expect((await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data.locked).toBe(true)
    await api.post('/api/v1/admin/restore').set({ ...headers, 'X-Demo-Role': 'ADMIN' })
      .send({ operation: 'RESTORE', backupId: 'BACKUP-001' }).expect(409)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'BACKUP_RESTORE', result: 'ERROR' })
    result.resolve({ code: 0, completedAt: '2026-09-23T00:01:00Z' })
    await expect.poll(run).toMatchObject({ uiStatus: 'COMPLETED', configLocked: false,
      canonical: { processId: null, progress: 100 } })
    expect((await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data.locked).toBe(false)
  })

  it('引擎归档初始化失败后停止已启动 mission，不遗留活动进程', async () => {
    const { handle } = processHandle()
    const archive = { begin: vi.fn(async () => { throw new Error('archive disk unavailable') }), load: async () => null, getFile: async () => null }
    const server = createMockServer({ port: 0, missionExecution: { start: async () => handle }, engineFrameArchive: archive as any })
    servers.push(server)
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    const created = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
    const response = await api.post(`/api/v1/simulations/${created.body.data.runId}/commands`).set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(503)
    expect(response.body.error.message).toContain('archive disk unavailable')
    expect(handle.stop).toHaveBeenCalledOnce()
    expect((await api.get(`/api/v1/simulations/${created.body.data.runId}`).set(headers).expect(200)).body.data.uiStatus).toBe('ERROR')
  })

  it('只在真实执行器确认运行中命令后更新暂停、继续、单步和倍速投影', async () => {
    const { handle } = processHandle()
    handle.control = vi.fn(async () => undefined)
    const { command } = await apiFor(async () => handle)
    await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    await command({ command: 'PAUSE' }).expect(200)
    await command({ command: 'STEP', stepCount: 1 }).expect(200)
    await command({ command: 'RESUME' }).expect(200)
    await command({ command: 'SET_SPEED', speedMultiplier: 2 }).expect(200)
    expect(handle.control).toHaveBeenNthCalledWith(1, { command: 'PAUSE' })
    expect(handle.control).toHaveBeenNthCalledWith(2, { command: 'STEP', stepCount: 1 })
    expect(handle.control).toHaveBeenNthCalledWith(3, { command: 'RESUME' })
    expect(handle.control).toHaveBeenNthCalledWith(4, { command: 'SET_SPEED', speedMultiplier: 2 })
  })

  it('控制台日志接口返回本次运行日志与超时设置，结束后仍可读，拒绝查询参数和未关联运行', async () => {
    const { handle, result } = processHandle()
    handle.readConsoleLog = vi.fn(async () => ({ text: 'Simulation complete\n', bytes: 20, truncated: false }))
    handle.timeoutMs = 60_000
    const { api, command } = await apiFor(async () => handle)
    await api.get(`/api/v1/simulations/${activeRunId}/console`).set(headers).expect(409)
    await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    const log = await api.get(`/api/v1/simulations/${activeRunId}/console`).set(headers).expect(200)
    expect(log.body.data).toEqual({ text: 'Simulation complete\n', bytes: 20, truncated: false, timeoutMs: 60_000 })
    expect(log.headers['cache-control']).toBe('no-store')
    await api.get(`/api/v1/simulations/${activeRunId}/console?path=C:/x`).set(headers).expect(400)
    result.resolve({ code: 0, completedAt: '2026-09-23T00:01:00Z' })
    await expect.poll(async () => (await api.get(`/api/v1/simulations/${activeRunId}`).set(headers)).body.data.uiStatus).toBe('COMPLETED')
    await api.get(`/api/v1/simulations/${activeRunId}/console`).set(headers).expect(200)
  })

  it('真实执行器拒绝运行中命令时不伪造投影状态', async () => {
    const { handle } = processHandle()
    handle.control = vi.fn(async () => { throw new Error('引擎未确认暂停') })
    const { command, run } = await apiFor(async () => handle)
    await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    await command({ command: 'PAUSE' }).expect(503)
    expect(await run()).toMatchObject({ uiStatus: 'RUNNING', canonical: { status: 'RUNNING' } })
  })

  it('等待引擎控制确认时拒绝并发命令，确认前状态不变；非Error失败也保持原状态', async () => {
    const { handle } = processHandle(), ack = deferred<void>()
    handle.control = vi.fn(() => ack.promise)
    const { command, run } = await apiFor(async () => handle)
    await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    const pending = command({ command: 'PAUSE' }).then((response: { status: number }) => response)
    await expect.poll(() => vi.mocked(handle.control!).mock.calls.length).toBe(1)
    expect((await run()).uiStatus).toBe('RUNNING')
    await command({ command: 'SET_SPEED', speedMultiplier: 2 }).expect(409)
    ack.resolve(); expect((await pending).status).toBe(200)
    expect((await run()).uiStatus).toBe('PAUSED')
    handle.control = vi.fn(async () => { throw 'missing acknowledgement' })
    const failure = await command({ command: 'RESUME' }).expect(503)
    expect(failure.body.error.message).toContain('未确认')
    expect((await run()).uiStatus).toBe('PAUSED')
  })

  it.each(['generation', 'spawn', 'exit'])('%s 失败不假报运行成功，保留错误并解锁', async kind => {
    const { handle, result } = processHandle()
    const { command, run } = await apiFor(async () => {
      if (kind === 'generation') throw new MissionGenerationError('jammers', '尚未接通。')
      if (kind === 'spawn') throw new Error('找不到 mission.exe')
      return handle
    })
    const response = await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(kind === 'generation' ? 422 : kind === 'spawn' ? 503 : 200)
    if (kind === 'generation') expect(response.body.error.fieldPath).toBe('jammers')
    if (kind === 'exit') result.resolve({ code: 1, errorMessage: '解析失败，请查看日志。' })
    await expect.poll(run).toMatchObject({ uiStatus: 'ERROR', configLocked: false, canonical: { processId: null, errorMessage: expect.any(String) } })
  })

  it('启动等待期间拒绝重复命令和重置；停止先确认再结束拥有的进程', async () => {
    const { handle } = processHandle()
    const launch = deferred<MissionProcess>()
    const start = vi.fn(() => launch.promise)
    const { api, command, run } = await apiFor(start)
    const pending = command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).then((response: { status: number }) => response)
    await expect.poll(() => start.mock.calls.length).toBe(1)
    await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(409)
    await api.post('/api/v1/reset').set({ ...headers, 'X-Demo-Role': 'ADMIN' }).send({ confirm: true }).expect(409)
    launch.resolve(handle)
    expect((await pending).status).toBe(200)
    await command({ command: 'STOP' }).expect(428)
    expect(handle.stop).not.toHaveBeenCalled()
    const context = (await api.post('/api/v1/confirmations').set(headers).send({ action: 'SIMULATION_STOP', objectId: activeRunId }).expect(201)).body.data
    await api.post(`/api/v1/confirmations/${context.confirmationId}`).set(headers).send({ confirm: true }).expect(200)
    await command({ command: 'STOP', confirmationId: context.confirmationId }).expect(200)
    expect(handle.stop).toHaveBeenCalledTimes(1)
    expect(await run()).toMatchObject({ uiStatus: 'STOPPED', configLocked: false, canonical: { processId: null } })
  })

  it('关闭服务只停止本次拥有的进程', async () => {
    const { handle } = processHandle()
    const { command, server } = await apiFor(async () => handle)
    await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    await server.close()
    expect(handle.stop).toHaveBeenCalledTimes(1)
  })

  it('停止超时的失败结果进入 ERROR 并解除配置锁，不回报 STOP 成功', async () => {
    const { handle, result } = processHandle()
    handle.stop = vi.fn(async () => {
      result.resolve({ code: null, errorMessage: 'mission 停止超时，已请求强制终止。' })
      throw new Error('mission 停止超时，已请求强制终止。')
    })
    const { api, command, run, server } = await apiFor(async () => handle)
    await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    const context = (await api.post('/api/v1/confirmations').set(headers).send({ action: 'SIMULATION_STOP', objectId: activeRunId }).expect(201)).body.data
    await api.post(`/api/v1/confirmations/${context.confirmationId}`).set(headers).send({ confirm: true }).expect(200)
    await command({ command: 'STOP', confirmationId: context.confirmationId }).expect(503)
    expect(await run()).toMatchObject({ uiStatus: 'ERROR', configLocked: false,
      canonical: { processId: null, errorMessage: expect.stringContaining('停止超时') } })
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'SIMULATION_COMMAND', result: 'ERROR' })
  })

  it('强制终止后仍无进程关闭证据时保留锁和进程，拒绝再次创建或开始', async () => {
    const { handle, result } = processHandle()
    handle.stop = vi.fn(async () => { throw new Error('强制终止后仍未关闭，可能残留进程') })
    const { api, command, run } = await apiFor(async () => handle)
    await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    const context = (await api.post('/api/v1/confirmations').set(headers)
      .send({ action: 'SIMULATION_STOP', objectId: activeRunId }).expect(201)).body.data
    await api.post(`/api/v1/confirmations/${context.confirmationId}`).set(headers).send({ confirm: true }).expect(200)
    await command({ command: 'STOP', confirmationId: context.confirmationId }).expect(503)
    expect(await run()).toMatchObject({ uiStatus: 'ERROR', configLocked: true,
      canonical: { processId: 7654, errorMessage: expect.stringContaining('仍未关闭') } })
    expect((await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data.locked).toBe(true)
    await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(409)
    await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(409)
    result.resolve({ code: null, errorMessage: '进程最终关闭' })
    await expect.poll(run).toMatchObject({ uiStatus: 'ERROR', configLocked: false, canonical: { processId: null } })
  })
})

function draftForMission(): ScenarioDraft {
  const draft: ScenarioDraft = new ScenarioProjection().get('SCN-001').data
  const c = draft.config
  c.platforms = c.platforms.filter(p => ['CMD-01', 'AIR-01'].includes(p.id))
  c.links = [{ ...c.links[0]!, id: 'L-A', sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', enabled: true }]
  for (const p of c.platforms) { p.waypoints = []; p.linkIds = ['L-A']; p.jammerIds = []; p.sensorIds = [] }
  c.jammers = []; c.sensors = []
  c.informationDemand = [{ ...c.informationDemand[0]!, linkId: 'L-A', sourcePlatformId: 'CMD-01', destinationPlatformIds: ['AIR-01'], direction: 'FORWARD', enabled: false }]
  c.scenario.duration = 3
  c.output.writeInterval = 1
  c.output.directory = 'output'
  c.output.linkQualityEnabled = false
  c.output.linkSwitchEnabled = false
  delete c.linkSettings
  draft.uiExtensions = { jammers: [], sensors: [] }
  return draft
}

describe('本机 mission 执行器', () => {
  it('连续留存只接受生成包 mapping 中的包内相对输出目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-output-mapping-'))
    const entry = join(root, 'comm_SimSetup.txt')
    try {
      await writeFile(entry, '')
      await writeFile(join(root, 'mapping.json'), JSON.stringify({ output: { resolvedDirectory: 'custom/nested/output' } }))
      await expect(resolveMissionOutputDirectory(entry)).resolves.toBe(join(root, 'custom', 'nested', 'output'))
      await writeFile(join(root, 'mapping.json'), JSON.stringify({ output: { resolvedDirectory: '../outside' } }))
      await expect(resolveMissionOutputDirectory(entry)).rejects.toThrow('越出运行目录')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each([
    ['正常完成', 'Simulation complete', '', null, true],
    ['标准输出明确缺少插件', 'Could not find processor WSF_LINK_CALC_PROCESSOR', '', null, false],
    ['错误输出明确缺少插件', '', 'Could not find processor WSF_LINK_CALC_PROCESSOR', new Error('exit 1'), false],
    ['其他引擎错误', '', 'FATAL: unrelated script error', new Error('exit 1'), true],
    ['启动失败', '', '', new Error('spawn ENOENT'), true],
  ] as const)('插件探测：%s；未知失败不擅自裁剪脚本且清理临时目录', async (_, stdout, stderr, error, supported) => {
    let directory = ''
    let script = ''
    const probe = vi.spyOn(childProcess, 'execFile').mockImplementationOnce((...args: unknown[]) => {
      const options = args[2] as { cwd: string }
      directory = options.cwd
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
      void readFile(join(directory, 'probe.txt'), 'utf8').then((content: string) => {
        script = content
        callback(error, stdout, stderr)
      }, (readError: Error) => callback(readError, '', ''))
      return new EventEmitter() as never
    })
    try {
      const executable = join(tmpdir(), 'mission probe 中文', 'mission.exe')
      expect(await engineHasLinkCalc(executable)).toBe(supported)
      expect(probe).toHaveBeenCalledExactlyOnceWith(executable, ['-es', 'probe.txt'],
        expect.objectContaining({ cwd: directory, shell: false, windowsHide: true, timeout: 15_000 }), expect.any(Function))
      expect(script).toContain('add processor link_calc WSF_LINK_CALC_PROCESSOR')
      expect(script).toContain('end_time 1 sec')
      await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { probe.mockRestore() }
  })

  it('spawn 前记录场景和修订，spawn 后补记 PID；真实 close 后才解除拦截', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-guard-'))
    const child = Object.assign(new EventEmitter(), { pid: 8765, kill: vi.fn(() => true) })
    vi.mocked(childProcess.spawn).mockImplementation(() => child)
    try {
      const runner = new LocalMissionRunner(join(root, 'mission.exe'), root)
      const draft = draftForMission()
      const pending = runner.start(draft, 'RUN-123')
      await expect.poll(() => vi.mocked(childProcess.spawn).mock.calls.length).toBe(1)
      const marker = join(root, '.mission-active', 'record.json')
      expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ runId: 'RUN-123', scenarioId: 'SCN-001', revision: draft.revision })
      expect(new LocalMissionRunner(join(root, 'mission.exe'), root).safetyStatus()?.scenarioId).toBe('SCN-001')
      child.emit('spawn')
      const process = await pending
      expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ pid: 8765, startedAt: process.startedAt, runDirectory: dirname(process.entryPath) })
      child.emit('close', 1)
      await process.completed
      expect(runner.safetyStatus()).toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('运行超时后按停止流程终止本次进程并记录超时原因；控制台日志可读尾部', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-timeout-'))
    const child = Object.assign(new EventEmitter(), { pid: 8766, kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true }) })
    vi.mocked(childProcess.spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
    vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null) => void
      queueMicrotask(() => { child.emit('close', null); callback(null) })
      return new EventEmitter() as never
    })
    try {
      const runner = new LocalMissionRunner(join(root, 'mission.exe'), root, undefined, async () => true, 50)
      const process = await runner.start(draftForMission(), 'RUN-TIMEOUT')
      expect(process.timeoutMs).toBe(50)
      await appendFile(join(dirname(process.entryPath), 'mission-console.log'), '第一行\nlast line\n')
      const log = await process.readConsoleLog!()
      expect(log).toEqual({ text: '第一行\nlast line\n', bytes: new TextEncoder().encode('第一行\nlast line\n').length, truncated: false })
      const outcome = await process.completed
      expect(outcome.errorMessage).toContain('超时上限')
      expect(JSON.parse(await readFile(join(dirname(process.entryPath), 'execution.json'), 'utf8')).errorMessage).toContain('超时上限')
      expect(runner.safetyStatus()).toBeNull()
    } finally { vi.mocked(childProcess.execFile).mockReset(); await rm(root, { recursive: true, force: true }) }
  })

  it('控制台日志超过上限时只读末尾并丢弃首个不完整行；超时配置拒绝非法值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-console-'))
    try {
      const path = join(root, 'mission-console.log')
      await writeFile(path, `${'x'.repeat(100)}\n中文行\n末行\n`)
      // 末尾 20 字节含 3 个 x 的残行，残行被丢弃，中文多字节行保持完整。
      const tail = await readConsoleLogTail(path, 20)
      expect(tail.truncated).toBe(true)
      expect(tail.text).toBe('中文行\n末行\n')
      expect((await readConsoleLogTail(path, 17)).text).toBe('末行\n')
      expect(readMissionRunTimeout(undefined)).toBe(0)
      expect(readMissionRunTimeout('0')).toBe(0)
      expect(readMissionRunTimeout('120')).toBe(120_000)
      for (const invalid of ['-1', '1.5', 'abc', '86401']) expect(() => readMissionRunTimeout(invalid)).toThrow(RangeError)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each([[true, true], [false, false]])('引擎有 WSF_LINK_CALC_PROCESSOR=%s 时运行包保留 link_calc=%s，探测只做一次', async (supported, kept) => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-link-calc-'))
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { pid: 8765, kill: vi.fn(() => true) })
      queueMicrotask(() => { child.emit('spawn'); child.emit('close', 1) })
      return child
    })
    const probe = vi.fn(async () => supported)
    try {
      const runner = new LocalMissionRunner(join(root, 'mission.exe'), root, undefined, probe)
      // 种子场景含后方节点，会生成 link_calc；激光与首条业务不可生成，先停用。
      const draft = draftForMission()
      for (let index = 0; index < 2; index++) {
        const process = await runner.start(draft, `RUN-${index}`)
        await process.completed
        const rear = await readFile(join(dirname(process.entryPath), 'comm_platform_REAR.txt'), 'utf8')
        expect(rear.includes('WSF_LINK_CALC_PROCESSOR')).toBe(kept)
        expect(rear.includes('processor local_link_stub WSF_SCRIPT_PROCESSOR')).toBe(!kept)
        expect(rear).not.toMatch(/add medium UAV_MESH_MEDIUM$/mu)
        expect(rear).toContain('end_platform_type')
        expect(JSON.parse(await readFile(join(dirname(process.entryPath), 'execution.json'), 'utf8')))
          .toMatchObject({ runId: `RUN-${index}`, taskId: 'TASK-LOCAL',
            linkCalcCompatibility: supported ? 'PRESERVED' : 'MISSING_PROCESSOR_STUBBED' })
      }
      expect(probe).toHaveBeenCalledOnce()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎探测 WSF_LINK_CALC_PROCESSOR 不抛错且不残留临时目录', async () => {
    expect(typeof await engineHasLinkCalc(env.MISSION_SMOKE_EXECUTABLE!)).toBe('boolean')
  })

  it('探测异常仅本次保留插件，下次启动重新探测而不缓存未知结论', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-probe-retry-'))
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { pid: 8765, kill: vi.fn(() => true) })
      queueMicrotask(() => { child.emit('spawn'); child.emit('close', 1) })
      return child
    })
    const probe = vi.fn().mockRejectedValueOnce(new Error('temporary probe failure')).mockResolvedValueOnce(false)
    try {
      const runner = new LocalMissionRunner(join(root, 'mission.exe'), root, undefined, probe)
      const draft = draftForMission()
      for (const [index, kept] of [true, false].entries()) {
        const process = await runner.start(draft, `RUN-PROBE-${index}`)
        await process.completed
        const rear = await readFile(join(dirname(process.entryPath), 'comm_platform_REAR.txt'), 'utf8')
        expect(rear.includes('WSF_LINK_CALC_PROCESSOR')).toBe(kept)
      }
      expect(probe).toHaveBeenCalledTimes(2)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('未结清记录写入失败不得 spawn；损坏记录也保持拦截', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-guard-fail-'))
    try {
      const marker = join(root, '.mission-active')
      await mkdir(marker)
      await writeFile(join(marker, 'record.json'), '{invalid')
      const runner = new LocalMissionRunner(join(root, 'mission.exe'), root)
      expect(runner.safetyStatus()).toMatchObject({ message: expect.stringContaining('未结清') })
      await expect(runner.start(draftForMission(), 'RUN-123')).rejects.toThrow()
      expect(childProcess.spawn).not.toHaveBeenCalled()
      const server = createMockServer({ port: 0, missionExecution: runner })
      try {
        if (!server.httpServer.listening) await once(server.httpServer, 'listening')
        const api = request(server.httpServer)
        await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(409)
        await api.put('/api/v1/scenarios/SCN-001').set(headers).send({}).expect(409)
      } finally { await server.close() }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('准备启动记录写入失败时不启动进程且保留保守拦截', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-guard-write-'))
    const guard = MissionGuard.prototype as unknown as { write: (record: unknown) => Promise<void> }
    vi.spyOn(guard, 'write').mockRejectedValueOnce(new Error('disk full'))
    try {
      const runner = new LocalMissionRunner(join(root, 'mission.exe'), root)
      await expect(runner.start(draftForMission(), 'RUN-123')).rejects.toThrow('disk full')
      expect(childProcess.spawn).not.toHaveBeenCalled()
      expect(runner.safetyStatus()).toMatchObject({ message: expect.stringContaining('未结清') })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('新的服务实例拒绝未结清 Mission 的 CREATE/START 和关联场景写入，关闭后恢复', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-restart-'))
    const db = join(root, 'scenarios.db')
    const child = Object.assign(new EventEmitter(), { pid: 8765, kill: vi.fn(() => { child.emit('close', null); return true }) })
    vi.mocked(childProcess.spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
    const storageA = new ScenarioSqliteStorage(db)
    const storageB = new ScenarioSqliteStorage(db)
    const runnerA = new LocalMissionRunner(join(root, 'mission.exe'), join(root, 'runs'))
    const first = createMockServer({ port: 0, scenarioStorage: storageA, missionExecution: runnerA })
    try {
      if (!first.httpServer.listening) await once(first.httpServer, 'listening')
      const firstApi = request(first.httpServer)
      const draft = draftForMission()
      const createdScene = await firstApi.post('/api/v1/scenarios').set(headers)
        .send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: 0 }).expect(201)
      const run = await firstApi.post('/api/v1/simulations').set(headers)
        .send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
      await firstApi.post(`/api/v1/simulations/${run.body.data.runId}/commands`).set(headers)
        .send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)

      const second = createMockServer({ port: 0, scenarioStorage: storageB,
        missionExecution: new LocalMissionRunner(join(root, 'mission.exe'), join(root, 'runs')) })
      try {
        if (!second.httpServer.listening) await once(second.httpServer, 'listening')
        const api = request(second.httpServer)
        expect((await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data.locked).toBe(true)
        await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(409)
        await api.post('/api/v1/simulations/RUN-001/commands').set(headers)
          .send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(409)
        await api.put('/api/v1/scenarios/SCN-001').set(headers).send({ config: draft.config,
          uiExtensions: draft.uiExtensions, expectedRevision: createdScene.body.data.revision }).expect(409)
        await api.delete(`/api/v1/scenarios/SCN-001?expectedRevision=${createdScene.body.data.revision}`).set(headers).expect(409)
      } finally { await second.close() }
      child.emit('close', 1)
      await expect.poll(() => runnerA.safetyStatus()).toBeNull()
      expect((await firstApi.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data.locked).toBe(false)
    } finally { await first.close(); storageA.close(); storageB.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE).each(['./tasks/TASK-001/output', 'custom/nested/results'])(
    '真实引擎：旧草稿目录 %s 不覆盖系统托管输出，重复运行相互隔离', async directory => {
      const root = await mkdtemp(join(tmpdir(), 'wrj-mission-output-'))
      try {
        const draft = draftForMission()
        draft.config.output.directory = directory
        const runner = new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root)
        const first = await runner.start(draft)
        const firstOutcome = await first.completed
        expect(firstOutcome.code).toBe(0)
        expect(firstOutcome.errorMessage).toBeUndefined()
        const firstDirectory = dirname(first.entryPath)
        const firstMapping = JSON.parse(await readFile(join(firstDirectory, 'mapping.json'), 'utf8'))
        expect(firstMapping.output.resolvedDirectory).toBe('output')
        const output = join(firstDirectory, firstMapping.output.resolvedDirectory, 'scenario_events.csv')
        const original = await readFile(output, 'utf8')
        expect(original).toContain('SIMULATION_COMPLETE')
        const second = await runner.start(draft)
        const secondOutcome = await second.completed
        expect(secondOutcome.code).toBe(0)
        expect(secondOutcome.errorMessage).toBeUndefined()
        expect(second.entryPath).not.toBe(first.entryPath)
        expect(await readFile(output, 'utf8')).toBe(original)
        const secondDirectory = dirname(second.entryPath)
        const secondMapping = JSON.parse(await readFile(join(secondDirectory, 'mapping.json'), 'utf8'))
        expect(await readFile(join(secondDirectory, secondMapping.output.resolvedDirectory, 'scenario_events.csv'), 'utf8')).toContain('SIMULATION_COMPLETE')
      } finally { await rm(root, { recursive: true, force: true }) }
    },
  )

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE).each(['FORWARD_RELAY_NODE', 'COMMUNICATION_SATELLITE'] as const)(
    '真实引擎：经 %s 中继的前向业务按模板转发规则执行', async type => {
      const root = await mkdtemp(join(tmpdir(), 'wrj-mission-relay-'))
      try {
        const draft = draftForMission()
        draft.config.scenario.duration = 8
        const [source, target] = draft.config.platforms
        // 后方车定向微波默认朝北、仰角 0：中继放在正北低仰角处，目标再往北。
        source!.initialPosition = { longitude: 120.8, latitude: 25.49, altitude: 0 }
        target!.initialPosition = { longitude: 120.8, latitude: 25.52, altitude: 50 }
        const relay = { ...structuredClone(target!), id: 'RELAY-01', type,
          category: type === 'COMMUNICATION_SATELLITE' ? 'space' as const : 'air' as const,
          initialPosition: { longitude: 120.8, latitude: 25.5, altitude: 50 },
          ...(type === 'COMMUNICATION_SATELLITE' ? { satelliteType: 'TIANTONG' as const } : {}),
        }
        draft.config.platforms.push(relay)
        Object.assign(draft.config.links[0]!, { relayPlatformId: relay.id, type: type === 'COMMUNICATION_SATELLITE' ? 'SAT' : 'MICROWAVE' })
        Object.assign(draft.config.informationDemand[0]!, { enabled: true, informationType: '目标指令', frequencyHz: 1, volumeMb: 0.000256 })
        const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root).start(draft)
        const outcome = await process.completed
        expect(outcome, await readFile(join(dirname(process.entryPath), 'mission-console.log'), 'utf8')).toMatchObject({ code: 0 })
        expect(outcome.errorMessage).toBeUndefined()
        const records = eventRecords(await readFile(join(dirname(process.entryPath), 'output/scenario_events.csv'), 'utf8'))
        const rows = (event: string, id: string) => records.filter((cells: string[]) => cells[1] === event && cells[2] === id)
        const port = type === 'COMMUNICATION_SATELLITE' ? 'sat_link_a' : 'microwave_link'
        expect(rows('MESSAGE_TRANSMITTED', 'rear_comm_vehicle').every((cells: string[]) => cells[4] === port && cells[7] === 'kForwardTarget')).toBe(true)
        expect(rows('MESSAGE_TRANSMITTED', 'rear_comm_vehicle').length).toBeGreaterThan(0)
        if (type === 'FORWARD_RELAY_NODE') {
          // 中继读取真实业务类型和目的地的 AuxData，消息保持原始业务类型。
          const chain = [rows('MESSAGE_TRANSMITTED', 'rear_comm_vehicle'), rows('MESSAGE_RECEIVED', 'mission_uav_01'), rows('MESSAGE_TRANSMITTED', 'mission_uav_01'), rows('MESSAGE_RECEIVED', 'mission_uav_02')]
          chain.forEach(items => expect(items.length, JSON.stringify(chain)).toBeGreaterThan(0))
          const times = chain.map(items => Number(items[0]![0]))
          expect(times).toEqual([...times].sort((a, b) => a - b))
        } else {
          // 天通仍按模板保留空 processor；这里只核对后方车按主路由发出。
          expect(rows('MESSAGE_TRANSMITTED', 'tiantong_sat')).toHaveLength(0)
        }
      } finally { await rm(root, { recursive: true, force: true }) }
    },
  )

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎：两个目标按各自主路由发送，不遗漏目标', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-targets-'))
    try {
      const draft = draftForMission()
      const source = draft.config.platforms[0]!
      const target = draft.config.platforms[1]!
      // 两个目标都放在后方车定向微波波束内（正北、低仰角）。
      target.initialPosition = { ...source.initialPosition, latitude: source.initialPosition.latitude + 0.01, altitude: 20 }
      draft.config.platforms.push({ ...structuredClone(target), id: 'AIR-02', linkIds: ['L-B'],
        initialPosition: { ...source.initialPosition, latitude: source.initialPosition.latitude + 0.02, altitude: 20 } })
      source.linkIds.push('L-B')
      draft.config.links.push({ ...structuredClone(draft.config.links[0]!), id: 'L-B', targetPlatformId: 'AIR-02' })
      const demand = draft.config.informationDemand[0]!
      delete demand.linkId
      Object.assign(demand, { enabled: true, destinationPlatformIds: ['AIR-01', 'AIR-02'], informationType: '态势信息', frequencyHz: 1, volumeMb: 0.000256 })
      const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root).start(draft)
      const outcome = await process.completed
      expect(outcome, await readFile(join(dirname(process.entryPath), 'mission-console.log'), 'utf8')).toMatchObject({ code: 0 })
      expect(outcome.errorMessage).toBeUndefined()
      const records = eventRecords(await readFile(join(dirname(process.entryPath), 'output/scenario_events.csv'), 'utf8'))
      // 3 秒仿真内后方车发送一轮：每个目标一条。
      for (const id of ['mission_uav_01', 'mission_uav_02']) expect(records.filter((cells: string[]) => cells[1] === 'MESSAGE_RECEIVED' && cells[2] === id)).toHaveLength(1)
      expect(records.filter((cells: string[]) => cells[1] === 'MESSAGE_TRANSMITTED' && cells[2] === 'rear_comm_vehicle')).toHaveLength(2)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE).each(['FORWARD', 'REVERSE'] as const)('真实引擎：%s 业务按模板端口、类型、位数与 5 秒周期发送', async direction => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-business-'))
    try {
      const draft = draftForMission()
      draft.config.scenario.duration = 12
      // 后方车微波为不带指向的 12°×12° 定向天线（默认朝北、仰角 0），无人机放在正北低仰角处。
      draft.config.platforms[1]!.initialPosition = { ...draft.config.platforms[0]!.initialPosition, latitude: draft.config.platforms[0]!.initialPosition.latitude + 0.01, altitude: 20 }
      const link = draft.config.links[0]!
      const demand = draft.config.informationDemand[0]!
      if (direction === 'REVERSE') {
        link.sourcePlatformId = 'AIR-01'
        link.targetPlatformId = 'CMD-01'
      }
      link.direction = direction
      const messageType = direction === 'FORWARD' ? 'kForwardTarget' : 'kReturnReconVideo'
      Object.assign(demand, { enabled: true, informationType: direction === 'FORWARD' ? '目标指令' : '侦察信息', volumeMb: 0.000256, frequencyHz: 2, direction,
        sourcePlatformId: link.sourcePlatformId, destinationPlatformIds: [link.targetPlatformId] })
      const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root).start(draft)
      const outcome = await process.completed
      expect(outcome).toMatchObject({ code: 0 })
      expect(outcome.errorMessage).toBeUndefined()
      const records = eventRecords(await readFile(join(dirname(process.entryPath), 'output', 'scenario_events.csv'), 'utf8'))
      const transmitted = records.filter((cells: string[]) => cells[1] === 'MESSAGE_TRANSMITTED')
      const received = records.filter((cells: string[]) => cells[1] === 'MESSAGE_RECEIVED')
      expect(transmitted.length).toBeGreaterThanOrEqual(2)
      expect(received).toHaveLength(transmitted.length)
      // 模板 script_proc 固定 5 秒发送一次，trans_freq 只写入 link_calc JSON。
      expect(Number(transmitted[1]![0]) - Number(transmitted[0]![0])).toBeCloseTo(5, 5)
      transmitted.forEach((cells: string[]) => {
        expect(cells[2]).toBe(direction === 'FORWARD' ? 'rear_comm_vehicle' : 'mission_uav_01')
        expect(cells[4]).toBe('microwave_link')
        expect(cells[7]).toBe(messageType)
        expect(cells[8]).toBe('2048')
      })
      received.forEach((cells: string[]) => {
        expect(cells[2]).toBe(direction === 'FORWARD' ? 'mission_uav_01' : 'rear_comm_vehicle')
        expect(cells[4]).toBe('microwave_link')
      })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎：干扰延迟、持续时长及释放前不再触发', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-jammer-timing-'))
    try {
      // 模板未启用关机日志；仅为本用例开启观察项，不改变生成器输出或执行逻辑。
      const scriptFiles = await import('../../server/local/' + 'script-file.js')
      const writePackage = scriptFiles.writeMissionPackage
      vi.spyOn(scriptFiles, 'writeMissionPackage').mockImplementation(async (...args: Parameters<typeof writePackage>) => {
        const entry = await writePackage(...args)
        const setup = await readFile(entry, 'utf8')
        await writeFile(entry, setup.replace('  enable WEAPON_TURNED_ON', '  enable WEAPON_TURNED_OFF\n  enable WEAPON_TURNED_ON'), 'utf8')
        return entry
      })
      const draft = draftForMission()
      draft.config.scenario.duration = 30
      draft.config.scenario.realtime = false
      draft.config.platforms[1]!.initialPosition = { longitude: 120.1, latitude: 23.5, altitude: 8000 }
      draft.config.platforms[1]!.waypoints = []
      const station = structuredClone(draft.config.platforms[0]!)
      Object.assign(station, { id: 'STN-01', name: '地面干扰站', type: 'GROUND_JAMMER_DETECTION_STATION', category: 'ground',
        initialPosition: { longitude: 120.15, latitude: 23.5, altitude: 15 }, waypoints: [], linkIds: [], jammerIds: ['JAM-TIMED'] })
      draft.config.platforms.push(station)
      draft.config.jammers = [{ id: 'JAM-TIMED', platformId: 'STN-01', type: 'BARRAGE', defaultPower: 1,
        frequency: 2200, bandwidth: 200, detectionRange: 44448, jammingRange: 44448, releaseRange: 50000,
        detectionDelayS: 6, jammingDurationS: 9 }]
      draft.config.jammingEnabled = true
      draft.uiExtensions.jammers = [{ jammerId: 'JAM-TIMED', direction: 0, enabled: true }]
      const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root, undefined, async () => false).start(draft)
      const outcome = await process.completed
      expect(outcome).toMatchObject({ code: 0 })
      expect(outcome.errorMessage).toBeUndefined()
      const records = eventRecords(await readFile(join(dirname(process.entryPath), 'output', 'scenario_events.csv'), 'utf8'))
      const on = records.filter((cells: string[]) => cells[1] === 'WEAPON_TURNED_ON' && cells[2] === 'jammer_station_01')
      expect(on).toHaveLength(1)
      const onAt = Number(on[0]![0])
      expect(onAt).toBeGreaterThanOrEqual(6)
      expect(onAt).toBeLessThanOrEqual(9)
      const off = records.filter((cells: string[]) => cells[1] === 'WEAPON_TURNED_OFF' && cells[2] === 'jammer_station_01' && Number(cells[0]) > onAt)
      expect(off).toHaveLength(1)
      expect(Number(off[0]![0]) - onAt).toBeGreaterThanOrEqual(9)
      expect(Number(off[0]![0]) - onAt).toBeLessThanOrEqual(12)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 30_000)

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎：航点路线、按距离触发干扰与时钟写入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-route-jammer-'))
    try {
      const draft = draftForMission()
      draft.config.scenario.duration = 8
      const uav = draft.config.platforms[1]!
      uav.initialPosition = { longitude: 120.1, latitude: 23.5, altitude: 8000 }
      uav.waypoints = [
        { longitude: 120.2, latitude: 23.6, altitude: 8100, speed: 200, arrivalTime: 0 },
        { longitude: 120.3, latitude: 23.7, altitude: 8200, speed: 250, arrivalTime: 1 },
      ]
      const station = structuredClone(draft.config.platforms[0]!)
      Object.assign(station, { id: 'STN-01', name: '地面干扰站', type: 'GROUND_JAMMER_DETECTION_STATION', category: 'ground',
        initialPosition: { longitude: 120.15, latitude: 23.5, altitude: 15 }, waypoints: [], linkIds: [], jammerIds: ['JAM-WB-01-TX'] })
      draft.config.platforms.push(station)
      draft.config.jammers = [{ id: 'JAM-WB-01-TX', platformId: 'STN-01', type: 'BARRAGE', defaultPower: 1,
        frequency: 2200, bandwidth: 200, detectionRange: 44448, jammingRange: 44448 }]
      draft.config.jammingEnabled = true
      draft.uiExtensions.jammers = [{ jammerId: 'JAM-WB-01-TX', direction: 0, enabled: true }]
      draft.config.scenario.environment.simClockSpeed = 4
      draft.config.scenario.startTime = '2026-03-05T06:07:08.000Z'
      const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root, undefined, async () => false).start(draft)
      const outcome = await process.completed
      expect(outcome).toMatchObject({ code: 0 })
      expect(outcome.errorMessage).toBeUndefined()
      const directory = dirname(process.entryPath)
      const entry = await readFile(process.entryPath, 'utf8')
      expect(entry).toContain('clock_rate 4')
      expect(entry).toContain('start_date mar 05 2026')
      expect(entry).toContain('start_time 06:07:08')
      const records = eventRecords(await readFile(join(directory, 'output', 'scenario_events.csv'), 'utf8'))
      const starting = records.find((cells: string[]) => cells[1] === 'SIMULATION_STARTING')!
      expect(starting.slice(2, 8).map(Number)).toEqual([2026, 3, 5, 6, 7, 8])
      // 补丁每 3 秒检查一次：任务机在触发半径内，地面站开机并切到宽带干扰模式。
      const on = records.filter((cells: string[]) => cells[1] === 'WEAPON_TURNED_ON' && cells[2] === 'jammer_station_01')
      expect(on).toHaveLength(1)
      expect(records.some((cells: string[]) => cells[1] === 'WEAPON_MODE_ACTIVATED' && cells[2] === 'jammer_station_01' && cells[4] === 'broadband_jamming')).toBe(true)
      const positions = (await readFile(join(directory, 'output', 'position.csv'), 'utf8'))
        .split(/\r?\n/).filter(Boolean).slice(1).map((line: string) => line.split(','))
      const uavPositions = positions.filter((cells: string[]) => cells[1] === 'mission_uav_01')
      expect(uavPositions.length).toBeGreaterThan(1)
      expect(uavPositions[0]![2]).toBe('120.1')
      expect(uavPositions[uavPositions.length - 1]![2]).not.toBe('120.1')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎：通信卫星按候选轨道模板初始化并启用卫星设备', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-satellite-'))
    try {
      const draft = draftForMission()
      draft.config.scenario.duration = 10
      draft.config.scenario.startTime = '2026-08-06T08:00:00.000Z'
      draft.config.platforms[1]!.linkIds = []
      const satellite = structuredClone(draft.config.platforms[1]!)
      satellite.id = 'SAT-01'
      satellite.name = '天通通信卫星'
      satellite.type = 'COMMUNICATION_SATELLITE'
      satellite.category = 'space'
      satellite.satelliteType = 'TIANTONG'
      satellite.initialPosition = { longitude: 121.55, latitude: 25.15, altitude: 0 }
      satellite.waypoints = []
      satellite.linkIds = ['L-SAT']
      draft.config.platforms.push(satellite)
      draft.config.platforms[0]!.linkIds = ['L-SAT']
      draft.config.links = [{ ...draft.config.links[0]!, id: 'L-SAT', type: 'SAT',
        sourcePlatformId: 'CMD-01', targetPlatformId: 'SAT-01' }]
      Object.assign(draft.config.informationDemand[0]!, { linkId: 'L-SAT', sourcePlatformId: 'CMD-01',
        destinationPlatformIds: ['SAT-01'], enabled: false })
      const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root).start(draft)
      const outcome = await process.completed
      expect(outcome).toMatchObject({ code: 0 })
      expect(outcome.errorMessage).toBeUndefined()
      const directory = dirname(process.entryPath)
      const platforms = await readTypeFiles(directory)
      expect(platforms).toContain('mover WSF_SPACE_MOVER')
      expect(platforms).toContain('      epoch_date_time aug 06 2026 08:00:00')
      expect(platforms).toContain('      semi_major_axis 42164 km')
      const csv = await readFile(join(directory, 'output', 'scenario_events.csv'), 'utf8')
      const records = csv.split(/\r?\n/).filter((line: string) => !line.startsWith('!')).map((line: string) => line.split(','))
      expect(records.some((cells: string[]) => cells[1] === 'COMM_TURNED_ON' && cells[2] === 'tiantong_sat')).toBe(true)
      const positions = (await readFile(join(directory, 'output', 'position.csv'), 'utf8'))
        .split(/\r?\n/).filter(Boolean).slice(1).map((line: string) => line.split(','))
      const satellitePositions = positions.filter((cells: string[]) => cells[1] === 'tiantong_sat')
      expect(satellitePositions.length).toBeGreaterThan(0)
      // 天通是 GEO：实际轨道高度约 35786 km，与候选模型的 42164 km 半长轴一致，倾角 0 使纬度接近 0。
      const altitude = Number(satellitePositions[0]![4])
      expect(altitude).toBeGreaterThan(35_000_000)
      expect(altitude).toBeLessThan(36_500_000)
      expect(Math.abs(Number(satellitePositions[0]![3]))).toBeLessThan(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  // E7：对照夹具的本地运行包在本机引擎上完整运行，并产生消息与干扰事件。
  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎：模板夹具本地包完整运行并产生消息与干扰事件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-local-runtime-engine-'))
    try {
      const draft = createTemplateScenario()
      draft.config.scenario.duration = 2400
      draft.config.scenario.realtime = false
      draft.config.output.directory = 'output'
      const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root, undefined, async () => false).start(draft)
      const outcome = await process.completed
      expect(outcome).toMatchObject({ code: 0 })
      expect(outcome.errorMessage).toBeUndefined()
      const directory = dirname(process.entryPath)
      expect(await readFile(join(directory, 'mission-console.log'), 'utf8')).not.toContain('Medium is shared')
      const csv = await readFile(join(directory, 'output', 'scenario_events.csv'), 'utf8')
      for (const event of ['MESSAGE_TRANSMITTED', 'MESSAGE_RECEIVED', 'WEAPON_TURNED_ON']) expect(csv).toMatch(new RegExp(`^[\\d.e+-]+,${event},`, 'mu'))
      expect(csv).toMatch(/^[\d.e+-]+,MESSAGE_TRANSMITTED,mission_uav_02,[^,]*,c_band_downlink,/mu)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 300_000)

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎：保存配置 → START → mission 完成 → 独立 CSV 与运行记录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-native-'))
    const server = createMockServer({ port: 0,
      missionExecution: new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, join(root, 'runs')),
      writeScriptText: (script: unknown, revision: number, draft: ScenarioDraft) => writeScriptText(join(root, 'saved'), script, revision, draft),
    })
    try {
      if (!server.httpServer.listening) await once(server.httpServer, 'listening')
      const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
      const draft = draftForMission()
      // 后方车微波为不带指向的 12°×12° 定向天线（默认朝北、仰角 0），无人机放在正北低仰角处。
      draft.config.platforms[1]!.initialPosition = { ...draft.config.platforms[0]!.initialPosition, latitude: draft.config.platforms[0]!.initialPosition.latitude + 0.01, altitude: 20 }
      Object.assign(draft.config.informationDemand[0]!, { enabled: true, frequencyHz: 1, volumeMb: 0.000256, informationType: '目标指令' })
      const saved = (await api.put('/api/v1/scenarios/SCN-001').set(headers)
        .send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: draft.revision }).expect(200)).body.data
      const confirmation = (await api.post('/api/v1/confirmations').set(headers)
        .send({ action: 'SCENARIO_WARNING_CONTINUE', objectId: 'SCN-001' }).expect(201)).body.data
      await api.post(`/api/v1/confirmations/${confirmation.confirmationId}`).set(headers).send({ confirm: true }).expect(200)
      const script = (await api.post('/api/v1/scripts/preview').set(headers)
        .send({ scenarioId: 'SCN-001', warningConfirmationId: confirmation.confirmationId }).expect(200)).body.data
      const generated = (await api.post(`/api/v1/scripts/${script.scriptId}/local-file`).set(headers)
        .send({ checksum: script.checksum }).expect(200)).body.data
      const savedPlatforms = await readTypeFiles(dirname(generated.path))
      expect(savedPlatforms).toContain('SendMessage')
      const created = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
      const runId = created.body.data.runId
      const started = (await api.post(`/api/v1/simulations/${runId}/commands`).set(headers)
        .send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)).body.data
      expect(started.canonical.processId).toBeGreaterThan(0)
      await expect.poll(async () => (await api.get(`/api/v1/simulations/${runId}`).set(headers)).body.data,
        { timeout: 10_000 }).toMatchObject({ uiStatus: 'COMPLETED', configLocked: false, canonical: { processId: null, currentTime: 3, progress: 100 } })
      const directory = join(root, 'runs', (await readdir(join(root, 'runs')))[0]!)
      const receipt = JSON.parse(await readFile(join(directory, 'execution.json'), 'utf8'))
      expect(receipt).toMatchObject({ code: 0, scenarioId: 'SCN-001', revision: saved.revision, pid: started.canonical.processId })
      expect(receipt.linkCalcCompatibility).toMatch(/^(PRESERVED|MISSING_PROCESSOR_STUBBED)$/)
      expect(await readTypeFiles(directory)).toContain('network COM_MESH_NET WSF_COMM_NETWORK_MESH\n  network_address 10.0.0.0/23\n')
      expect(savedPlatforms).not.toContain('network_address 10.0.0.0/23')
      // 本地包保留独立介质与 mesh 容量修正，以及缺少 link_calc 时的 local_link_stub。
      expect(await readDeliveredTypeFiles(directory)).toBe(receipt.linkCalcCompatibility === 'PRESERVED'
        ? savedPlatforms
        : withoutLinkCalc(savedPlatforms))
      expect(await readFile(join(directory, 'mission-console.log'), 'utf8')).toContain('Simulation complete')
      expect(await readFile(join(directory, 'output', 'position.csv'), 'utf8')).toContain('3,mission_uav_01,')
      const events = await readFile(join(directory, 'output', 'scenario_events.csv'), 'utf8')
      expect(events).toContain('COMM_TURNED_ON')
      // 模板后方车 script_proc 每 5 秒发送一次，3 秒仿真内首发约在 t≈3 s。
      expect(events.split(/\r?\n/).filter((line: string) => /^\d.*?,MESSAGE_RECEIVED,mission_uav_01,/.test(line))).toHaveLength(1)
    } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.each([
    [0, 'Simulation complete\n', false],
    [2, '***** FATAL: input failed\n', true],
    [0, '***** ERROR: Script Exception:\nSimulation complete\n', true],
    [0, 'Starting simulation.\n', true],
  ] as const)('退出码 %s 与日志 %s 共同验证实际完成', async (code, log, failed) => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-runner-'))
    const child = Object.assign(new EventEmitter(), { pid: 8765, kill: vi.fn(() => { child.emit('close', null); return true }) })
    const spawn = vi.mocked(childProcess.spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    try {
      const capture = vi.fn(async () => {})
      const runner = new LocalMissionRunner(join(root, 'mission.exe'), root, { capture })
      const process = await runner.start(draftForMission())
      expect(spawn).toHaveBeenCalledWith(join(root, 'mission.exe'), ['-es', 'comm_SimSetup.txt'], expect.objectContaining({
        cwd: dirname(process.entryPath), shell: false, windowsHide: true,
      }))
      expect(JSON.parse(await readFile(join(dirname(process.entryPath), 'input.json'), 'utf8'))).toEqual(draftForMission())
      await appendFile(join(dirname(process.entryPath), 'mission-console.log'), log)
      child.emit('close', code)
      const outcome = await process.completed
      expect(outcome.code).toBe(code)
      expect(Boolean(outcome.errorMessage)).toBe(failed)
      expect(capture).toHaveBeenCalledTimes(failed ? 0 : 1)
      expect(JSON.parse(await readFile(join(dirname(process.entryPath), 'execution.json'), 'utf8'))).toMatchObject({ pid: 8765, code })
      await process.stop()
      expect(child.kill).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎：外部强杀本次 PID 后写非完成记录、清除 guard 并可再次启动', async () => {
    const evidenceParent = join(nodeProcess.cwd(), 'output', 'local-remediation-20261027', 'process')
    await mkdir(evidenceParent, { recursive: true })
    const root = await mkdtemp(join(evidenceParent, 'native-abnormal-exit-'))
    const runner = new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root)
    const draft = draftForMission()
    draft.config.scenario.duration = 3_600
    draft.config.output.writeInterval = 60
    const process = await runner.start(draft, 'RUN-NATIVE-KILL', 'TASK-NATIVE-KILL')
    nodeProcess.kill(process.pid, 'SIGKILL')
    const outcome = await Promise.race([
      process.completed,
      delay(10_000).then(() => { throw new Error(`mission PID ${process.pid} did not close after owned external kill`) }),
    ])
    expect(outcome.code).not.toBe(0)
    expect(outcome.errorMessage).toContain('mission 执行失败')
    expect(() => nodeProcess.kill(process.pid, 0)).toThrow()
    expect(runner.safetyStatus()).toBeNull()
    const receipt = JSON.parse(await readFile(join(dirname(process.entryPath), 'execution.json'), 'utf8'))
    expect(receipt.errorMessage).toContain('mission 执行失败')
    const restarted = await runner.start(draft, 'RUN-NATIVE-KILL-RESTART', 'TASK-NATIVE-KILL')
    await restarted.stop()
    expect(runner.safetyStatus()).toBeNull()
    await writeFile(join(root, 'evidence.json'), JSON.stringify({
      kind: 'owned-native-external-kill', pid: process.pid, entryPath: process.entryPath, outcome, restartPid: restarted.pid,
      guardCleared: true, verifiedAt: new Date().toISOString(),
    }, null, 2))
  }, 30_000)

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎：runner STOP 清理本次 PID、写非完成归档并可再次启动', async () => {
    const evidenceParent = join(nodeProcess.cwd(), 'output', 'local-remediation-20261027', 'process')
    await mkdir(evidenceParent, { recursive: true })
    const root = await mkdtemp(join(evidenceParent, 'native-runner-stop-'))
    const runner = new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root)
    const draft = draftForMission()
    draft.config.scenario.duration = 3_600
    draft.config.output.writeInterval = 60
    const process = await runner.start(draft, 'RUN-NATIVE-STOP', 'TASK-NATIVE-STOP')
    await process.stop()
    const outcome = await Promise.race([
      process.completed,
      delay(10_000).then(() => { throw new Error(`runner STOP did not close mission PID ${process.pid}`) }),
    ])
    expect(outcome.code).not.toBe(0)
    expect(() => nodeProcess.kill(process.pid, 0)).toThrow()
    expect(runner.safetyStatus()).toBeNull()
    const restarted = await runner.start(draft, 'RUN-NATIVE-STOP-RESTART', 'TASK-NATIVE-STOP')
    await restarted.stop()
    expect(runner.safetyStatus()).toBeNull()
    await writeFile(join(root, 'evidence.json'), JSON.stringify({
      kind: 'owned-native-runner-stop', pid: process.pid, entryPath: process.entryPath, outcome, restartPid: restarted.pid,
      guardCleared: true, verifiedAt: new Date().toISOString(),
    }, null, 2))
  }, 30_000)

  it('运行期间从自定义输出目录分块连续留存，关闭前已落盘且收尾无重复', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-continuous-'))
    const child = Object.assign(new EventEmitter(), { pid: 8788, kill: vi.fn(() => true) })
    vi.mocked(childProcess.spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
    const originalOutput = { ...APP_CONFIG.scenarioOutput }
    try {
      const draft = draftForMission()
      APP_CONFIG.scenarioOutput.directory = 'custom/continuous-output'
      const process = await new LocalMissionRunner(join(root, 'mission.exe'), root).start(draft)
      const output = join(dirname(process.entryPath), 'custom', 'continuous-output', 'scenario_events.csv')
      const bytes = new TextEncoder().encode(REPORT_EVENT_CSV)
      await writeFile(output, bytes.subarray(0, Math.floor(bytes.length / 2)))
      await appendFile(output, bytes.subarray(Math.floor(bytes.length / 2)))
      const taskArchives = join(root, 'time-series', 'TASK-LOCAL')
      const archive = join(taskArchives, (await readdir(taskArchives))[0]!)
      await expect.poll(async () => {
        try { return (await readFile(join(archive, 'events.csv'), 'utf8')).includes('TASK-LOCAL,1.1,') }
        catch { return false }
      }).toBe(true)
      const duringRun = await readFile(join(archive, 'events.csv'), 'utf8')
      await appendFile(join(dirname(process.entryPath), 'mission-console.log'), 'Simulation complete\n')
      child.emit('close', 0)
      await expect(process.completed).resolves.toMatchObject({ code: 0 })
      const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))
      expect(manifest).toMatchObject({ mode: 'CONTINUOUS', status: 'COMPLETED', completed: true, contractsComplete: false })
      expect(manifest.files).toEqual(expect.arrayContaining([expect.objectContaining({ fileName: 'events.csv', rowCount: expect.any(Number) })]))
      const completedCsv = await readFile(join(archive, 'events.csv'), 'utf8')
      // close还会提交末尾无换行记录；已落盘前缀不变，最终每个源事件恰好一条。
      expect(completedCsv.startsWith(duringRun)).toBe(true)
      const rows = completedCsv.trimEnd().split('\r\n').slice(1)
      expect(new Set(rows).size).toBe(rows.length)
      expect(rows).toHaveLength(manifest.files.find((file: { fileName: string }) => file.fileName === 'events.csv').rowCount)
      expect(completedCsv).toContain(',SIMULATION_COMPLETE,')
    } finally { Object.assign(APP_CONFIG.scenarioOutput, originalOutput); await rm(root, { recursive: true, force: true }) }
  })

  it('停止的任务不发布结果；旧草稿关闭事件输出不覆盖系统配置', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-cancel-'))
    const capture = vi.fn(async () => {})
    const child = Object.assign(new EventEmitter(), { pid: 8765, kill: vi.fn(() => { child.emit('close', 0); return true }) })
    vi.mocked(childProcess.spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
    try {
      const runner = new LocalMissionRunner(join(root, 'mission.exe'), root, { capture })
      const disabled = draftForMission()
      disabled.config.output.eventsEnabled = false
      const process = await runner.start(disabled)
      expect(JSON.parse(await readFile(join(dirname(process.entryPath), 'mapping.json'), 'utf8')).output.eventsEnabled).toBe(true)
      await appendFile(join(dirname(process.entryPath), 'mission-console.log'), 'Simulation complete\n')
      await process.stop()
      expect(capture).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('进程已退出但 close 尚未触发时停止不误判 kill false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-exit-window-'))
    const child = Object.assign(new EventEmitter(), { pid: 8765, kill: vi.fn(() => false) })
    vi.mocked(childProcess.spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
    try {
      const process = await new LocalMissionRunner(join(root, 'mission.exe'), root).start(draftForMission())
      child.emit('exit', 0)
      const stopping = process.stop()
      child.emit('close', 0)
      await expect(stopping).resolves.toBeUndefined()
      expect(child.kill).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('Windows runner STOP 终止本次父子进程树，close 后才解除 guard', async () => {
    if (nodeProcess.platform !== 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-stop-tree-'))
    const childSource = 'setInterval(() => {}, 1000)'
    const parentSource = [
      "const { spawn } = require('node:child_process')",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'ignore', windowsHide: true })`,
      'console.log(child.pid)',
      'setInterval(() => {}, 1000)',
    ].join(';')
    const external = childProcess.spawn(nodeProcess.execPath, ['-e', parentSource], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    try {
      const [chunk] = await once(external.stdout!, 'data')
      const descendantPid = Number(String(chunk).trim())
      expect(Number.isSafeInteger(descendantPid)).toBe(true)
      const facade = Object.assign(new EventEmitter(), { pid: external.pid, kill: vi.fn(() => true) })
      external.once('exit', (code: number | null) => facade.emit('exit', code))
      external.once('close', (code: number | null) => facade.emit('close', code))
      vi.mocked(childProcess.spawn).mockImplementationOnce(() => { queueMicrotask(() => facade.emit('spawn')); return facade as never })
      const runner = new LocalMissionRunner(join(root, 'unused.exe'), root)
      const process = await runner.start(draftForMission())
      await expect(process.stop()).resolves.toBeUndefined()
      await expect(process.completed).resolves.toEqual(expect.objectContaining({}))
      expect(runner.safetyStatus()).toBeNull()
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try { nodeProcess.kill(descendantPid, 0) }
        catch { return }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error(`owned descendant ${descendantPid} remained after runner STOP`)
    } finally {
      if (external.pid) {
        try { nodeProcess.kill(external.pid, 'SIGKILL') } catch { /* 已由本次 runner stop 清理。 */ }
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('正常终止信号被忽略时限时强制终止，失败写入运行记录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-stop-timeout-'))
    const child = Object.assign(new EventEmitter(), { pid: 8765, kill: vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null))
      return true
    }) })
    vi.mocked(childProcess.spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
    try {
      const process = await new LocalMissionRunner(join(root, 'mission.exe'), root).start(draftForMission())
      let taskkillCalls = 0
      const taskkill = vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
        const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
        taskkillCalls += 1
        queueMicrotask(() => {
          if (taskkillCalls === 1) callback(new Error('first taskkill did not terminate the process'), '', '')
          else { callback(null, '', ''); child.emit('close', null) }
        })
        return new EventEmitter() as never
      })
      taskkill.mockClear()
      vi.useFakeTimers()
      const stopping = process.stop()
      const rejection = expect(stopping).rejects.toThrow('停止超时')
      await vi.advanceTimersByTimeAsync(5_001)
      await rejection
      expect(child.kill).toHaveBeenNthCalledWith(1)
      if (nodeProcess.platform === 'win32') {
        expect(taskkill).toHaveBeenCalledTimes(2)
        expect(taskkill).toHaveBeenCalledWith('taskkill', ['/PID', '8765', '/T', '/F'], { windowsHide: true, timeout: 1_000 }, expect.any(Function))
        expect(child.kill).toHaveBeenCalledTimes(1)
      } else expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
      expect((await process.completed).errorMessage).toContain('停止超时')
      expect(JSON.parse(await readFile(join(dirname(process.entryPath), 'execution.json'), 'utf8')).errorMessage).toContain('停止超时')
    } finally { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) }
  })

  it('强制终止后缺少 close 时不伪造 completed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-stop-open-'))
    const child = Object.assign(new EventEmitter(), { pid: 8766, kill: vi.fn(() => true) })
    vi.mocked(childProcess.spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
    try {
      const runner = new LocalMissionRunner(join(root, 'mission.exe'), root)
      const process = await runner.start(draftForMission())
      let taskkillCalls = 0
      const taskkill = vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
        const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
        taskkillCalls += 1
        queueMicrotask(() => callback(taskkillCalls === 1 ? new Error('first taskkill did not terminate the process') : null, '', ''))
        return new EventEmitter() as never
      })
      taskkill.mockClear()
      let completed = false
      void process.completed.then(() => { completed = true })
      vi.useFakeTimers()
      const stopping = process.stop()
      const rejection = expect(stopping).rejects.toThrow('仍未关闭')
      await vi.advanceTimersByTimeAsync(10_002)
      await rejection
      expect(completed).toBe(false)
      expect(runner.safetyStatus()?.scenarioId).toBe('SCN-001')
      if (nodeProcess.platform === 'win32') {
        expect(taskkill).toHaveBeenCalledTimes(2)
        expect(taskkill).toHaveBeenCalledWith('taskkill', ['/PID', '8766', '/T', '/F'], { windowsHide: true, timeout: 1_000 }, expect.any(Function))
        expect(child.kill).toHaveBeenCalledTimes(1)
      } else expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
      child.emit('close', null)
      expect((await process.completed).errorMessage).toContain('仍未关闭')
      expect(runner.safetyStatus()).toBeNull()
    } finally { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) }
  })

  it('进程已关闭但结果捕获失败时标记 ERROR 并解除进程拦截', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-capture-fail-'))
    const child = Object.assign(new EventEmitter(), { pid: 8765, kill: vi.fn(() => true) })
    vi.mocked(childProcess.spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
    try {
      const runner = new LocalMissionRunner(join(root, 'mission.exe'), root, { capture: async () => { throw new Error('result write failed') } })
      const process = await runner.start(draftForMission())
      await appendFile(join(dirname(process.entryPath), 'mission-console.log'), 'Simulation complete\n')
      child.emit('close', 0)
      expect((await process.completed).errorMessage).toContain('结果保存失败')
      expect(runner.safetyStatus()).toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('缺少可执行文件时保留诊断，拒绝相对路径；不触碰既有输出', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-missing-'))
    try {
      expect(() => new LocalMissionRunner('mission.exe', root)).toThrow('绝对路径')
      await expect(new LocalMissionRunner(join(root, 'missing.exe'), root).start(draftForMission())).rejects.toThrow('mission 执行失败')
      const owned = (await readdir(root))[0]!
      expect(JSON.parse(await readFile(join(root, owned, 'execution.json'), 'utf8')).errorMessage).toContain('ENOENT')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})


it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎：11-06 中继和神通按目的地转发，地面干扰进入后开启、离开后关闭', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrj-template-1106-routes-'))
  try {
    // 仅开启额外观察事件，核实关闭时刻；不改变生成器的模板事件清单。
    const scriptFiles = await import('../../server/local/' + 'script-file.js')
    const writePackage = scriptFiles.writeMissionPackage
    vi.spyOn(scriptFiles, 'writeMissionPackage').mockImplementation(async (...args: Parameters<typeof writePackage>) => {
      const entry = await writePackage(...args)
      const setup = await readFile(entry, 'utf8')
      await writeFile(entry, setup.replace('  enable WEAPON_TURNED_ON', '  enable WEAPON_TURNED_OFF\n  enable WEAPON_TURNED_ON'), 'utf8')
      return entry
    })
    const draft = createTemplateScenario(), config = draft.config
    config.scenario.duration = 80; config.scenario.realtime = false
    for (const platform of config.platforms) delete platform.returnPlan
    config.linkSettings!.enabledSatellites = { TIANTONG: false, SHENTONG: true }
    const find = (id: string) => config.platforms.find(p => p.id === id)!
    find('mission_uav_01').initialPosition = { longitude: 120.9, latitude: 25.0, altitude: 8000 }
    find('mission_uav_01').waypoints = []; delete find('mission_uav_01').loiterWaypoints
    const moving = find('mission_uav_02')
    moving.initialPosition = { longitude: 121.54, latitude: 25.15, altitude: 3200 }
    moving.waypoints = [{ longitude: 121.8, latitude: 25.15, altitude: 3200, speed: 500, arrivalTime: 0 }]
    delete moving.loiterWaypoints; delete moving.returnPlan
    config.links.find(link => link.id === 'c_forward_uav2')!.relayPlatformId = 'mission_uav_01'
    const returnLink = config.links.find(link => link.id === 'c_return_uav2')!
    Object.assign(returnLink, { type: 'SAT', targetPlatformId: 'rear_comm_vehicle', relayPlatformId: 'shentong_sat', frequency: 14200 })
    delete returnLink.band
    config.linkSettings!.hotLinks!.reverse[0] = ['c_return_uav2']
    for (const platform of config.platforms) platform.linkIds = config.links.filter(link => [link.sourcePlatformId, link.targetPlatformId, link.relayPlatformId].includes(platform.id)).map(link => link.id)
    Object.assign(config.jammers[0]!, { jammingRange: 5000, releaseRange: 6000 })
    for (const jammer of config.jammers) delete jammer.triggerTimeS
    draft.uiExtensions.jammers[1]!.enabled = false
    const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root, undefined, async () => false).start(draft)
    const outcome = await process.completed, directory = dirname(process.entryPath)
    const log = await readFile(join(directory, 'mission-console.log'), 'utf8')
    expect(outcome, log.slice(-6000)).toMatchObject({ code: 0 })
    expect(log).not.toContain('FATAL')
    const records = eventRecords(await readFile(join(directory, 'output', 'scenario_events.csv'), 'utf8'))
    for (const platform of ['mission_uav_01', 'shentong_sat']) {
      expect(records.some(row => row[1] === 'MESSAGE_RECEIVED' && row[2] === platform), `${platform} 接收`).toBe(true)
      expect(records.some(row => row[1] === 'MESSAGE_TRANSMITTED' && row[2] === platform), `${platform} 转发`).toBe(true)
    }
    expect(log).toContain('mission_uav_01 kForwardSituation Forward Message')
    expect(records.some(row => row[1] === 'MESSAGE_RECEIVED' && row[2] === 'rear_comm_vehicle')).toBe(true)
    const on = records.find(row => row[1] === 'WEAPON_TURNED_ON' && row[2] === 'jammer_station_01')
    expect(on).toBeDefined()
    expect(records.some(row => row[1] === 'WEAPON_TURNED_OFF' && row[2] === 'jammer_station_01' && Number(row[0]) > Number(on![0]))).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 120_000)

it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎：11-06 无返向业务的空数组合法，不产生返向消息', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrj-template-1106-empty-'))
  try {
    const draft = createTemplateScenario()
    draft.config.scenario.duration = 30; draft.config.scenario.realtime = false
    for (const platform of draft.config.platforms) delete platform.returnPlan
    draft.config.informationDemand = draft.config.informationDemand.filter(item => item.direction !== 'REVERSE')
    draft.config.jammingEnabled = false
    const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root, undefined, async () => false).start(draft)
    const outcome = await process.completed, directory = dirname(process.entryPath)
    const log = await readFile(join(directory, 'mission-console.log'), 'utf8')
    expect(outcome, log.slice(-4000)).toMatchObject({ code: 0 })
    expect(log).not.toContain('FATAL')
    const uav = await readFile(join(directory, 'comm_platform_MISSION_UAV.txt'), 'utf8')
    expect(uav).toContain('rt_video_dsts  = {  };')
    expect(uav).toContain('int    rt_video_size = 0;')
    const csv = await readFile(join(directory, 'output', 'scenario_events.csv'), 'utf8')
    expect(csv).not.toMatch(/,kReturnRecon(Video|Status),/u)
    expect(csv).toContain('MESSAGE_TRANSMITTED')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60_000)

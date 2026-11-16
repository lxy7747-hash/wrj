// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../server/local/mission-process-inspection.js', async importOriginal => ({
  ...await importOriginal<object>(), readMissionProcesses: vi.fn(), stopVerifiedMission: vi.fn(),
}))
vi.mock('../../server/local/mission-runner.js', { spy: true })
const { readMissionProcesses, stopVerifiedMission } = await import('../../server/local/' + 'mission-process-inspection.js')
const { MissionGuard } = await import('../../server/local/' + 'mission-guard.js')
const { LocalMissionPool } = await import('../../server/local/' + 'mission-pool.js')
const { LocalMissionRunner } = await import('../../server/local/' + 'mission-runner.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const { mkdtemp, readdir, readFile, rm, writeFile } = await import('node:fs/' + 'promises')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { once } = await import('node:' + 'events')
const { createHash } = await import('node:' + 'crypto')

const roots: string[] = []
const servers: ReturnType<typeof createMockServer>[] = []
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
const startedAt = '2026-11-14T04:00:00.000Z'
beforeEach(() => { vi.mocked(readMissionProcesses).mockReset().mockResolvedValue([]); vi.mocked(stopVerifiedMission).mockReset() })
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})
async function setup(parallel = false) {
  const root = await mkdtemp(join(tmpdir(), 'wrj-recovery-')); roots.push(root)
  const directory = parallel ? join(root, 'parallel-tasks', `TASK-${createHash('sha256').update('TASK-OLD').digest('hex')}`) : root
  const executable = join(root, 'mission.exe')
  const record = { runId: 'RUN-OLD', scenarioId: 'SCN-001', revision: 1, pid: 876543, startedAt, runDirectory: join(directory, 'mission-old') }
  const guard = new MissionGuard(directory)
  await guard.claim(directory, record)
  const pool = new LocalMissionPool(executable, root, undefined, 2)
  const identity = { pid: record.pid, parentPid: 123, startedAt: Date.parse(startedAt) + 20, executable, commandLine: `"${executable}" -es scenario.txt` }
  return { root, directory, executable, record, guard, pool, identity }
}
async function apiFor(pool: InstanceType<typeof LocalMissionPool>) {
  const server = createMockServer({ port: 0, missionExecution: pool }); servers.push(server)
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  return request(server.httpServer)
}

it('恢复查询用本机注入的时钟缓存两秒，到期后重新核实', async () => {
  let now = Date.parse(startedAt)
  const recover = vi.fn(async () => [])
  const start = vi.fn()
  const server = createMockServer({
    port: 0,
    missionExecution: { start, recover },
    missionClock: { now: () => now, schedule: vi.fn() },
  })
  servers.push(server)
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const read = () => request(server.httpServer).get('/api/v1/scenarios/SCN-001').set(headers).expect(200)
  await read()
  now += 1999
  await read()
  expect(recover).toHaveBeenCalledOnce()
  now += 1
  await read()
  expect(recover).toHaveBeenCalledTimes(2)
  expect(start).not.toHaveBeenCalled()
})

it.each([false, true])('部署机旧锁自动解除，归档记录但不删除运行结果（并行目录=%s）', async parallel => {
  const { root, directory, pool, guard } = await setup(parallel)
  await writeFile(join(root, 'keep-result.json'), 'old output')
  const api = await apiFor(pool)
  expect((await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data.locked).toBe(false)
  expect((await api.get('/api/v1/simulations/recovery').set(headers).expect(200)).body.data).toEqual([])
  expect(guard.status()).toBeNull()
  const archive = (await readdir(directory)).find((name: string) => name.startsWith('.mission-recovered-'))!
  expect(JSON.parse(await readFile(join(directory, archive, 'record.json'), 'utf8')).runId).toBe('RUN-OLD')
  expect(await readFile(join(root, 'keep-result.json'), 'utf8')).toBe('old output')
  await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
  expect(stopVerifiedMission).not.toHaveBeenCalled()
})

it('后台重启后可停止仍在运行的旧 Mission，确认关闭后才能解锁，留下审计', async () => {
  const { pool, guard, identity } = await setup(true)
  vi.mocked(readMissionProcesses).mockResolvedValue([identity])
  const api = await apiFor(pool)
  expect((await api.get('/api/v1/simulations/recovery').set(headers).expect(200)).body.data).toEqual([
    expect.objectContaining({ runId: 'RUN-OLD', scenarioId: 'SCN-001', canStop: true, pid: identity.pid }),
  ])
  expect((await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data.locked).toBe(true)
  await api.post('/api/v1/simulations/recovery/stop').set({ ...headers, 'X-Demo-Role': 'OPERATOR' }).send({ runId: 'RUN-OLD' }).expect(403)
  await api.post('/api/v1/simulations/recovery/stop').set(headers).send({ runId: 'RUN-OLD', pid: 1 }).expect(422)
  let release!: () => void
  vi.mocked(stopVerifiedMission).mockImplementation(() => new Promise<void>(resolve => { release = () => { vi.mocked(readMissionProcesses).mockResolvedValue([]); resolve() } }))
  const stopping = api.post('/api/v1/simulations/recovery/stop').set(headers).send({ runId: 'RUN-OLD' }).then((response: {status:number}) => response)
  await expect.poll(() => Boolean(release)).toBe(true)
  expect(guard.status()).not.toBeNull()
  release()
  expect((await stopping).status).toBe(200)
  expect(guard.status()).toBeNull()
  expect((await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data.locked).toBe(false)
  const audit = await api.get('/api/v1/admin/audit').set(headers).expect(200)
  expect(audit.body.data.some((row: { action: string }) => row.action === 'MISSION_RECOVERY_STOP')).toBe(true)
})

it.each(['failure', 'reused', 'child', 'query', 'missing'])('无法确认结束时保留锁且不误杀其他进程：%s', async reason => {
  const { pool, guard, identity, directory, record } = await setup()
  vi.mocked(readMissionProcesses).mockResolvedValue([identity])
  if (reason === 'failure') vi.mocked(stopVerifiedMission).mockRejectedValue(new Error('停止失败'))
  if (reason === 'reused') vi.mocked(readMissionProcesses).mockResolvedValue([{ ...identity, executable: join(directory, 'another.exe') }])
  if (reason === 'child') vi.mocked(readMissionProcesses).mockResolvedValue([{ ...identity, pid: identity.pid + 1, parentPid: identity.pid }])
  if (reason === 'query') vi.mocked(readMissionProcesses).mockRejectedValue(new Error('access denied'))
  if (reason === 'missing') await writeFile(join(directory, '.mission-active', 'record.json'), JSON.stringify({ ...record, pid: undefined }))
  await expect(pool.stopRecovered('RUN-OLD')).rejects.toThrow()
  expect(guard.status()).not.toBeNull()
  if (reason !== 'failure') expect(stopVerifiedMission).not.toHaveBeenCalled()
})

it('同一遗留运行并发停止只终止一次', async () => {
  const { pool, identity, guard } = await setup()
  vi.mocked(readMissionProcesses).mockResolvedValue([identity])
  vi.mocked(stopVerifiedMission).mockImplementation(async () => { vi.mocked(readMissionProcesses).mockResolvedValue([]) })
  await Promise.all([pool.stopRecovered('RUN-OLD'), pool.stopRecovered('RUN-OLD')])
  expect(stopVerifiedMission).toHaveBeenCalledOnce()
  expect(guard.status()).toBeNull()
})

it('旧全局记录和任务记录同时存在时逐项核实，只释放已退出的一项', async () => {
  const { root, record, guard, pool, identity } = await setup()
  const directory = join(root, 'parallel-tasks', `TASK-${createHash('sha256').update('TASK-LIVE').digest('hex')}`)
  const live = new MissionGuard(directory)
  await live.claim(directory, { ...record, runId: 'RUN-LIVE', scenarioId: 'SCN-LIVE', pid: record.pid + 1, runDirectory: join(directory, 'mission-live') })
  vi.mocked(readMissionProcesses).mockResolvedValue([{ ...identity, pid: record.pid + 1 }])
  expect(await pool.recover()).toEqual([expect.objectContaining({ runId: 'RUN-LIVE', canStop: true })])
  expect(guard.status()).toBeNull()
  expect(live.status()).not.toBeNull()
  vi.mocked(readMissionProcesses).mockResolvedValue([])
  expect(await pool.recover()).toEqual([])
})

it('当前服务拥有的运行不被遗留恢复逻辑误清理', async () => {
  const { root, pool, guard, record } = await setup()
  await guard.clearAfterClose()
  const taskId = 'TASK-OWNED'
  const directory = join(root, 'parallel-tasks', `TASK-${createHash('sha256').update(taskId).digest('hex')}`)
  const owned = new MissionGuard(directory)
  let finish!: (value: { code: number }) => void
  const completed = new Promise<{ code: number }>(resolve => { finish = resolve })
  const start = vi.spyOn(LocalMissionRunner.prototype, 'start').mockImplementation(async () => {
    await owned.claim(directory, { ...record, runDirectory: join(directory, 'mission-owned') })
    return { pid: record.pid, startedAt, entryPath: join(directory, 'scenario.txt'), completed, stop: async () => {} }
  })
  try {
    await pool.start({} as never, 'RUN-OWNED', taskId)
    expect(await pool.recover()).toEqual([])
    expect(owned.status()).not.toBeNull()
    expect(readMissionProcesses).not.toHaveBeenCalled()
    await owned.clearAfterClose()
    finish({ code: 0 })
  } finally { start.mockRestore() }
})

it('已识别的遗留记录变得不可读时仍保留场景锁', async () => {
  const { pool, directory, identity } = await setup()
  vi.mocked(readMissionProcesses).mockResolvedValue([identity])
  const api = await apiFor(pool)
  expect((await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data.locked).toBe(true)
  await writeFile(join(directory, '.mission-active', 'record.json'), '{invalid')
  await api.post('/api/v1/simulations/recovery/stop').set(headers).send({ runId: 'RUN-OLD' }).expect(409)
  expect((await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data.locked).toBe(true)
  expect(stopVerifiedMission).not.toHaveBeenCalled()
})

it('PID 已被更晚启动的其他进程复用时只解除旧锁，不停止该进程', async () => {
  const { pool, directory, record, identity, guard } = await setup()
  await writeFile(join(directory, '.mission-active', 'record.json'), JSON.stringify({ ...record, spawnedAt: startedAt }))
  vi.mocked(readMissionProcesses).mockResolvedValue([{ ...identity, startedAt: Date.parse(startedAt) + 60000 }])
  expect(await pool.recover()).toEqual([])
  expect(guard.status()).toBeNull()
  expect(stopVerifiedMission).not.toHaveBeenCalled()
})

it('旧版记录的启动准备超过 30 秒仍可核实和停止', async () => {
  const { pool, identity } = await setup()
  vi.mocked(readMissionProcesses).mockResolvedValue([{ ...identity, startedAt: Date.parse(startedAt) + 120000 }])
  expect(await pool.recover()).toEqual([expect.objectContaining({ runId: 'RUN-OLD', canStop: true })])
})

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioDraft } from '../../src/contracts/domain-models'

vi.mock('node:child_process', { spy: true })

const { createMockServer } = await import('../../server/' + 'app.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { LocalMissionRunner } = await import('../../server/local/' + 'mission-runner.js')
const { writeScriptText } = await import('../../server/local/' + 'script-file.js')
const { MissionGenerationError } = await import('../../server/scripts/' + 'mission-generator.js')
const { default: request } = await import('super' + 'test')
const { once, EventEmitter } = await import('node:' + 'events')
const { mkdtemp, readFile, readdir, rm, appendFile } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join, dirname } = await import('node:' + 'path')
const childProcess = await import('node:' + 'child_process')
const { env } = await import('node:' + 'process')
type MissionOutcome = { code: number | null; completedAt?: string; errorMessage?: string }
type MissionProcess = { pid: number; startedAt: string; entryPath: string; completed: Promise<MissionOutcome>; stop(): Promise<void> }

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
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); vi.mocked(childProcess.spawn).mockReset(); vi.restoreAllMocks() })
async function apiFor(start: (draft: ScenarioDraft) => Promise<MissionProcess>) {
  const server = createMockServer({ port: 0, missionExecution: { start } })
  servers.push(server)
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
  const command = (body: object) => api.post('/api/v1/simulations/RUN-001/commands').set(headers).send(body)
  const run = async () => (await api.get('/api/v1/simulations/RUN-001').set(headers).expect(200)).body.data
  return { api, command, run, server }
}

describe('真实 mission 命令边界', () => {
  it('使用服务端保存快照和真实 PID；完成后解锁，不用 Mock PID 或浏览器计时器', async () => {
    const { handle, result } = processHandle()
    const start = vi.fn(async () => handle)
    const { api, command, run, server } = await apiFor(start)
    const draft = (await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data
    await command({ command: 'START', mode: 'PARAMETER_SCAN' }).expect(409)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'SIMULATION_COMMAND', objectId: 'RUN-001', result: 'ERROR' })
    expect((await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)).body.data)
      .toMatchObject({ uiStatus: 'RUNNING', canonical: { processId: 7654 }, configLocked: true })
    expect(start).toHaveBeenCalledExactlyOnceWith(draft)
    await command({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(409)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'SIMULATION_COMMAND', objectId: 'RUN-001', result: 'ERROR' })
    await command({ command: 'PAUSE' }).expect(409)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'SIMULATION_COMMAND', objectId: 'RUN-001', result: 'ERROR' })
    await command({ command: 'SET_SPEED', speedMultiplier: 2 }).expect(409)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'SIMULATION_COMMAND', objectId: 'RUN-001', result: 'ERROR' })
    await api.post('/api/v1/reset').set(headers).send({ confirm: true }).expect(409)
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
    await api.post('/api/v1/reset').set(headers).send({ confirm: true }).expect(409)
    launch.resolve(handle)
    expect((await pending).status).toBe(200)
    await command({ command: 'STOP' }).expect(428)
    expect(handle.stop).not.toHaveBeenCalled()
    const context = (await api.post('/api/v1/confirmations').set(headers).send({ action: 'SIMULATION_STOP', objectId: 'RUN-001' }).expect(201)).body.data
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
    const context = (await api.post('/api/v1/confirmations').set(headers).send({ action: 'SIMULATION_STOP', objectId: 'RUN-001' }).expect(201)).body.data
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
      .send({ action: 'SIMULATION_STOP', objectId: 'RUN-001' }).expect(201)).body.data
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
  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE).each(['./tasks/TASK-001/output', 'custom/nested/results'])(
    '真实引擎：输出目录 %s 可用，重复运行不覆盖旧结果', async directory => {
      const root = await mkdtemp(join(tmpdir(), 'wrj-mission-output-'))
      try {
        const draft = draftForMission()
        draft.config.output.directory = directory
        const runner = new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root)
        const first = await runner.start(draft)
        const firstOutcome = await first.completed
        expect(firstOutcome.code).toBe(0)
        expect(firstOutcome.errorMessage).toBeUndefined()
        const output = join(dirname(first.entryPath), directory, 'scenario_events.csv')
        const original = await readFile(output, 'utf8')
        expect(original).toContain('SIMULATION_COMPLETE')
        const second = await runner.start(draft)
        const secondOutcome = await second.completed
        expect(secondOutcome.code).toBe(0)
        expect(secondOutcome.errorMessage).toBeUndefined()
        expect(second.entryPath).not.toBe(first.entryPath)
        expect(await readFile(output, 'utf8')).toBe(original)
        expect(await readFile(join(dirname(second.entryPath), directory, 'scenario_events.csv'), 'utf8')).toContain('SIMULATION_COMPLETE')
      } finally { await rm(root, { recursive: true, force: true }) }
    },
  )

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE).each(['FORWARD_RELAY_NODE', 'COMMUNICATION_SATELLITE'] as const)(
    '真实引擎：%s 完成源发送、中继接收、中继发送和目标接收', async type => {
      const root = await mkdtemp(join(tmpdir(), 'wrj-mission-relay-'))
      try {
        const draft = draftForMission()
        draft.config.output.directory = 'output'
        draft.config.output.linkQualityEnabled = false
        draft.config.output.linkSwitchEnabled = false
        const [source, target] = draft.config.platforms
        source!.initialPosition = { longitude: 120.79, latitude: 25.49, altitude: 0 }
        target!.initialPosition = { longitude: 120.81, latitude: 25.51, altitude: 8000 }
        const relay = { ...structuredClone(target!), id: 'RELAY-01', type,
          category: type === 'COMMUNICATION_SATELLITE' ? 'space' as const : 'air' as const,
          initialPosition: { longitude: 120.8, latitude: 25.5, altitude: 8000 },
          ...(type === 'COMMUNICATION_SATELLITE' ? { satelliteType: 'TIANTONG' as const } : {}),
        }
        draft.config.platforms.push(relay)
        Object.assign(draft.config.links[0]!, { relayPlatformId: relay.id,
          type: type === 'COMMUNICATION_SATELLITE' ? 'SAT' : 'MICROWAVE', txPower: 1000, antennaGain: { tx: 50, rx: 50 } })
        Object.assign(draft.config.informationDemand[0]!, { enabled: true, informationType: '状态信息', frequencyHz: 1, volumeMb: 0.000256 })
        const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root).start(draft)
        const outcome = await process.completed
        expect(outcome, await readFile(join(dirname(process.entryPath), 'mission-console.log'), 'utf8')).toMatchObject({ code: 0 })
        expect(outcome.errorMessage).toBeUndefined()
        const records = (await readFile(join(dirname(process.entryPath), 'output/scenario_events.csv'), 'utf8'))
          .split(/\r?\n/).map((line: string) => line.split(','))
        const chain = [
          ['MESSAGE_TRANSMITTED', source!.id], ['MESSAGE_RECEIVED', relay.id],
          ['MESSAGE_TRANSMITTED', relay.id], ['MESSAGE_RECEIVED', target!.id],
        ].map(([event, id]) => records.filter((cells: string[]) => cells[1] === event && cells[2] === id))
        for (const rows of chain) expect(rows, JSON.stringify(chain)).toHaveLength(3)
        for (let index = 0; index < 3; index += 1) {
          const times = chain.map(rows => Number(rows[index]![0]))
          expect(times).toEqual([...times].sort((a, b) => a - b))
        }
      } finally { await rm(root, { recursive: true, force: true }) }
    },
  )

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE).each(['两个目标', '同目标备选链路'])(
    '真实引擎：%s 按各目标主路由发送，不遗漏目标或重复广播', async kind => {
      const root = await mkdtemp(join(tmpdir(), 'wrj-mission-targets-'))
      try {
        const draft = draftForMission()
        draft.config.output.directory = 'output'
        draft.config.output.linkQualityEnabled = false
        draft.config.output.linkSwitchEnabled = false
        const source = draft.config.platforms[0]!
        const target = draft.config.platforms[1]!
        target.initialPosition = { ...source.initialPosition, longitude: source.initialPosition.longitude + 0.01, altitude: 500 }
        const targets = [target.id]
        if (kind === '两个目标') {
          draft.config.platforms.push({ ...structuredClone(target), id: 'AIR-02', linkIds: ['L-B'] })
          targets.push('AIR-02')
        } else target.linkIds.push('L-B')
        source.linkIds.push('L-B')
        draft.config.links.push({ ...structuredClone(draft.config.links[0]!), id: 'L-B', targetPlatformId: targets.at(-1)!, type: 'DATALINK' })
        const demand = draft.config.informationDemand[0]!
        delete demand.linkId
        Object.assign(demand, { enabled: true, destinationPlatformIds: targets, informationType: '态势信息', frequencyHz: 1, volumeMb: 0.000256 })
        const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root).start(draft)
        const outcome = await process.completed
        expect(outcome, await readFile(join(dirname(process.entryPath), 'mission-console.log'), 'utf8')).toMatchObject({ code: 0 })
        expect(outcome.errorMessage).toBeUndefined()
        const records = (await readFile(join(dirname(process.entryPath), 'output/scenario_events.csv'), 'utf8'))
          .split(/\r?\n/).map((line: string) => line.split(','))
        for (const id of targets) expect(records.filter((cells: string[]) => cells[1] === 'MESSAGE_RECEIVED' && cells[2] === id)).toHaveLength(3)
        expect(records.filter((cells: string[]) => cells[1] === 'MESSAGE_TRANSMITTED')).toHaveLength(3 * targets.length)
        if (kind === '同目标备选链路') {
          const manifest = JSON.parse(await readFile(join(dirname(process.entryPath), 'mapping.json'), 'utf8'))
          const chosen = manifest.devices.find((device: { linkId: string }) => device.linkId === 'L-B')
          expect(records.filter((cells: string[]) => cells[1] === 'MESSAGE_TRANSMITTED').every((cells: string[]) => cells[4] === chosen.source.deviceId)).toBe(true)
        }
      } finally { await rm(root, { recursive: true, force: true }) }
    },
  )

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE).each([
    ['FORWARD', 2], ['REVERSE', 3], ['FORWARD', 0],
  ] as const)('真实引擎：%s 业务频次 %s，核对实际消息端点、位数、时间及零频次', async (direction, frequencyHz) => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-business-'))
    try {
      const draft = draftForMission()
      draft.config.platforms[1]!.initialPosition = { ...draft.config.platforms[0]!.initialPosition, longitude: 118.16, altitude: 500 }
      const link = draft.config.links[0]!
      const demand = draft.config.informationDemand[0]!
      if (direction === 'REVERSE') {
        link.sourcePlatformId = 'AIR-01'
        link.targetPlatformId = 'CMD-01'
      }
      link.direction = direction
      Object.assign(demand, { enabled: true, informationType: '侦察信息', volumeMb: 0.000256, frequencyHz, direction,
        sourcePlatformId: link.sourcePlatformId, destinationPlatformIds: [link.targetPlatformId] })
      const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root).start(draft)
      const outcome = await process.completed
      expect(outcome).toMatchObject({ code: 0 })
      expect(outcome.errorMessage).toBeUndefined()
      const csv = await readFile(join(dirname(process.entryPath), 'output', 'scenario_events.csv'), 'utf8')
      const records = csv.split(/\r?\n/).filter((line: string) => !line.startsWith('!')).map((line: string) => line.split(','))
      const transmitted = records.filter((cells: string[]) => cells[1] === 'MESSAGE_TRANSMITTED')
      const received = records.filter((cells: string[]) => cells[1] === 'MESSAGE_RECEIVED')
      expect(transmitted).toHaveLength(3 * frequencyHz)
      expect(received).toHaveLength(3 * frequencyHz)
      transmitted.forEach((cells: string[], index: number) => {
        expect(Number(cells[0])).toBeCloseTo(index / frequencyHz, 5)
        expect(cells[2]).toBe(link.sourcePlatformId)
        expect(cells[4]).toMatch(/_src$/)
        expect(cells[7]).toBe('侦察信息')
        expect(cells[8]).toBe('2048')
      })
      received.forEach((cells: string[]) => {
        expect(cells[2]).toBe(link.targetPlatformId)
        expect(cells[4]).toMatch(/_dst$/)
      })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎：普通业务字符串原值保留且正常退出', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-business-string-'))
    try {
      const draft = draftForMission()
      const demand = draft.config.informationDemand[0]!
      Object.assign(demand, { enabled: true, id: 'INFO-001', informationType: '状态信息', volumeMb: 0.000256, frequencyHz: 1 })
      const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root).start(draft)
      const outcome = await process.completed
      expect(outcome).toMatchObject({ code: 0 })
      expect(outcome.errorMessage).toBeUndefined()
      const csv = await readFile(join(dirname(process.entryPath), 'output', 'scenario_events.csv'), 'utf8')
      const records = csv.split(/\r?\n/).filter((line: string) => !line.startsWith('!')).map((line: string) => line.split(','))
      const transmitted = records.filter((cells: string[]) => cells[1] === 'MESSAGE_TRANSMITTED')
      expect(transmitted[0]?.[7]).toBe(demand.informationType)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎：航点路线、定时干扰完整启停与环境/时钟写入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-route-jammer-'))
    try {
      const draft = draftForMission()
      const uav = draft.config.platforms[1]!
      uav.initialPosition = { longitude: 120.1, latitude: 23.5, altitude: 8000 }
      uav.waypoints = [
        { longitude: 120.2, latitude: 23.6, altitude: 8100, speed: 200, arrivalTime: 1 },
        { longitude: 120.3, latitude: 23.7, altitude: 8200, speed: 250, arrivalTime: 2 },
      ]
      const station = structuredClone(draft.config.platforms[0]!)
      station.id = 'STN-01'
      station.name = '地面干扰站'
      station.type = 'GROUND_JAMMER_DETECTION_STATION'
      station.category = 'ground'
      station.initialPosition = { longitude: 121.55, latitude: 25.15, altitude: 15 }
      station.waypoints = []
      station.linkIds = []
      station.jammerIds = ['JAM-WB-01-TX']
      draft.config.platforms.push(station)
      draft.config.jammers = [{ id: 'JAM-WB-01-TX', platformId: 'STN-01', type: 'BARRAGE', defaultPower: 72,
        frequency: 2200, bandwidth: 40, autoDetect: false, detectionRange: 44448, jammingRange: 44448, triggerTimeS: 1 }]
      draft.config.jammingEnabled = true
      draft.uiExtensions.jammers = [{ jammerId: 'JAM-WB-01-TX', direction: 360, duration: 1, enabled: true }]
      draft.config.scenario.environment.seaState = 3
      draft.config.scenario.environment.rainRateMmPerHour = 12.5
      draft.config.scenario.environment.simClockSpeed = 4
      draft.config.scenario.startTime = '2026-03-05T06:07:08.000Z'
      const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root).start(draft)
      const outcome = await process.completed
      expect(outcome).toMatchObject({ code: 0 })
      expect(outcome.errorMessage).toBeUndefined()
      const directory = dirname(process.entryPath)
      const entry = await readFile(process.entryPath, 'utf8')
      expect(entry).toContain('clock_rate 4')
      expect(entry).toContain('  sea_state 3')
      expect(entry).toContain('  rain_rate 12.5 mm/hr')
      expect(entry).toContain('  route\n')
      expect(entry).toContain('start_date mar 05 2026')
      expect(entry).toContain('start_time 06:07:08.000')
      const csv = await readFile(join(directory, 'output', 'scenario_events.csv'), 'utf8')
      const records = csv.split(/\r?\n/).filter((line: string) => !line.startsWith('!')).map((line: string) => line.split(','))
      const at = (name: string) => records.filter((cells: string[]) => cells[1] === name).map((cells: string[]) => Number(cells[0]))
      // 引擎起止事件回显的年月日时分秒必须等于配置的开始时刻，证明 start_date/start_time 真正生效。
      const starting = records.find((cells: string[]) => cells[1] === 'SIMULATION_STARTING')!
      expect(starting.slice(2, 8).map(Number)).toEqual([2026, 3, 5, 6, 7, 8])
      // 定时触发：t=1 开启并选模发起干扰请求，t=2 关闭并取消请求，形成完整启停。
      expect(at('WEAPON_TURNED_ON')).toEqual([1])
      expect(at('WEAPON_MODE_ACTIVATED')).toEqual([1])
      expect(at('JAMMING_REQUEST_INITIATED')).toEqual([1])
      expect(at('JAMMING_REQUEST_CANCELED')).toEqual([2])
      // 本机引擎对 WEAPON_TURNED_OFF 会重复输出同一时刻的记录，只核对发生时刻不核对条数。
      expect(new Set(at('WEAPON_TURNED_OFF'))).toEqual(new Set([2]))
      const positions = (await readFile(join(directory, 'output', 'position.csv'), 'utf8'))
        .split(/\r?\n/).filter(Boolean).slice(1).map((line: string) => line.split(','))
      const uavPositions = positions.filter((cells: string[]) => cells[1] === 'AIR-01')
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
      const platforms = await readFile(join(directory, 'platforms.txt'), 'utf8')
      expect(platforms).toContain('mover WSF_SPACE_MOVER')
      expect(platforms).toContain('      epoch_date_time aug 06 2026 08:00:00')
      expect(platforms).toContain('      semi_major_axis 42164 km')
      const csv = await readFile(join(directory, 'output', 'scenario_events.csv'), 'utf8')
      const records = csv.split(/\r?\n/).filter((line: string) => !line.startsWith('!')).map((line: string) => line.split(','))
      expect(records.some((cells: string[]) => cells[1] === 'COMM_TURNED_ON' && cells[2] === 'SAT-01')).toBe(true)
      const positions = (await readFile(join(directory, 'output', 'position.csv'), 'utf8'))
        .split(/\r?\n/).filter(Boolean).slice(1).map((line: string) => line.split(','))
      const satellitePositions = positions.filter((cells: string[]) => cells[1] === 'SAT-01')
      expect(satellitePositions.length).toBeGreaterThan(0)
      // 天通是 GEO：实际轨道高度约 35786 km，与候选模型的 42164 km 半长轴一致，倾角 0 使纬度接近 0。
      const altitude = Number(satellitePositions[0]![4])
      expect(altitude).toBeGreaterThan(35_000_000)
      expect(altitude).toBeLessThan(36_500_000)
      expect(Math.abs(Number(satellitePositions[0]![3]))).toBeLessThan(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('真实引擎：夹具场景在停用激光链路后完整生成并运行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-fixture-'))
    try {
      const draft: ScenarioDraft = new ScenarioProjection().get('SCN-001').data
      // 夹具含一条激光链路，激光尚无可用设备；INFO-001 的 CMD-01→UAV-01 又只能走这条链路。
      // 停用两者后，其余全部平台、设备、传感器与链路都应能生成并真实执行。
      draft.config.links.find(link => link.type === 'LASER')!.enabled = false
      draft.config.informationDemand[0]!.enabled = false
      draft.config.output.linkQualityEnabled = false
      draft.config.output.linkSwitchEnabled = false
      draft.config.output.directory = 'output'
      const process = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root).start(draft)
      const outcome = await process.completed
      expect(outcome).toMatchObject({ code: 0 })
      expect(outcome.errorMessage).toBeUndefined()
      const directory = dirname(process.entryPath)
      const platforms = await readFile(join(directory, 'platforms.txt'), 'utf8')
      expect(platforms).toContain('sensor radar_')
      expect(platforms).toContain('WSF_RADAR_SENSOR')
      expect(platforms).toContain('    bit_error_probability 0.00001')
      expect(platforms).toContain('mover WSF_SPACE_MOVER')
      expect(platforms).toContain('mover WSF_AIR_MOVER')
      const manifest = JSON.parse(await readFile(join(directory, 'mapping.json'), 'utf8'))
      expect(manifest.excludedLinkIds).toEqual(['L-LASER-04'])
      expect(manifest.devices.filter((item: { linkType: string }) => item.linkType === 'DATALINK')).toHaveLength(4)
      expect(manifest.devices.filter((item: { linkType: string }) => item.linkType === 'SAT')).toHaveLength(2)
      expect(manifest.devices.filter((item: { linkType: string }) => item.linkType === 'MICROWAVE')).toHaveLength(3)
      expect(manifest.sensors).toHaveLength(1)
      expect(manifest.platforms.filter((item: { relayRole: boolean }) => item.relayRole)).toHaveLength(1)
      const csv = await readFile(join(directory, 'output', 'scenario_events.csv'), 'utf8')
      expect(csv).toContain('COMM_TURNED_ON')
      expect(csv).toContain('SAT-01')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

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
      draft.config.platforms[1]!.initialPosition = { ...draft.config.platforms[0]!.initialPosition, longitude: 118.16, altitude: 500 }
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
      const savedPlatforms = await readFile(join(dirname(generated.path), 'platforms.txt'), 'utf8')
      expect(savedPlatforms).toContain('SendMessage')
      await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
      const started = (await api.post('/api/v1/simulations/RUN-001/commands').set(headers)
        .send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)).body.data
      expect(started.canonical.processId).toBeGreaterThan(0)
      await expect.poll(async () => (await api.get('/api/v1/simulations/RUN-001').set(headers)).body.data,
        { timeout: 10_000 }).toMatchObject({ uiStatus: 'COMPLETED', configLocked: false, canonical: { processId: null, currentTime: 3, progress: 100 } })
      const directory = join(root, 'runs', (await readdir(join(root, 'runs')))[0]!)
      expect(await readFile(join(directory, 'platforms.txt'), 'utf8')).toBe(savedPlatforms)
      const receipt = JSON.parse(await readFile(join(directory, 'execution.json'), 'utf8'))
      expect(receipt).toMatchObject({ code: 0, scenarioId: 'SCN-001', revision: saved.revision, pid: started.canonical.processId })
      expect(await readFile(join(directory, 'mission-console.log'), 'utf8')).toContain('Simulation complete')
      expect(await readFile(join(directory, 'output', 'position.csv'), 'utf8')).toContain('3,AIR-01,')
      const events = await readFile(join(directory, 'output', 'scenario_events.csv'), 'utf8')
      expect(events).toContain('COMM_TURNED_ON')
      expect(events.split(/\r?\n/).filter((line: string) => /^\d.*?,MESSAGE_RECEIVED,/.test(line))).toHaveLength(3)
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
      expect(spawn).toHaveBeenCalledWith(join(root, 'mission.exe'), ['-es', 'mission.txt'], expect.objectContaining({
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

  it('停止的任务不发布结果；关闭事件输出时启动前明确阻断', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-cancel-'))
    const capture = vi.fn(async () => {})
    const child = Object.assign(new EventEmitter(), { pid: 8765, kill: vi.fn(() => { child.emit('close', 0); return true }) })
    vi.mocked(childProcess.spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
    try {
      const runner = new LocalMissionRunner(join(root, 'mission.exe'), root, { capture })
      const disabled = draftForMission()
      disabled.config.output.eventsEnabled = false
      await expect(runner.start(disabled)).rejects.toThrow('启用事件输出')
      const process = await runner.start(draftForMission())
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

  it('正常终止信号被忽略时限时强制终止，失败写入运行记录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-stop-timeout-'))
    const child = Object.assign(new EventEmitter(), { pid: 8765, kill: vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null))
      return true
    }) })
    vi.mocked(childProcess.spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
    try {
      const process = await new LocalMissionRunner(join(root, 'mission.exe'), root).start(draftForMission())
      vi.useFakeTimers()
      const stopping = process.stop()
      const rejection = expect(stopping).rejects.toThrow('停止超时')
      await vi.advanceTimersByTimeAsync(5_001)
      await rejection
      expect(child.kill).toHaveBeenNthCalledWith(1)
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
      expect((await process.completed).errorMessage).toContain('停止超时')
      expect(JSON.parse(await readFile(join(dirname(process.entryPath), 'execution.json'), 'utf8')).errorMessage).toContain('停止超时')
    } finally { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) }
  })

  it('强制终止后缺少 close 时不伪造 completed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-stop-open-'))
    const child = Object.assign(new EventEmitter(), { pid: 8766, kill: vi.fn(() => true) })
    vi.mocked(childProcess.spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
    try {
      const process = await new LocalMissionRunner(join(root, 'mission.exe'), root).start(draftForMission())
      let completed = false
      void process.completed.then(() => { completed = true })
      vi.useFakeTimers()
      const stopping = process.stop()
      const rejection = expect(stopping).rejects.toThrow('仍未关闭')
      await vi.advanceTimersByTimeAsync(10_002)
      await rejection
      expect(completed).toBe(false)
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
      child.emit('close', null)
      expect((await process.completed).errorMessage).toContain('仍未关闭')
    } finally { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) }
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

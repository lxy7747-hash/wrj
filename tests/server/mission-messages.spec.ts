// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { ScenarioDraft } from '../../src/contracts/domain-models.js'
import { isMissionMessageSnapshot } from '../../src/features/situation/mission-messages.js'

const { createMockServer } = await import('../../server/' + 'app.js')
const { MissionMessageReader } = await import('../../server/local/' + 'mission-message-reader.js')
const { default: request } = await import('super' + 'test')
const { appendFile, mkdtemp, mkdir, rm, symlink, writeFile } = await import('node:' + 'fs/promises')
const { once } = await import('node:' + 'events')
const { tmpdir } = await import('node:' + 'os')
const { dirname, join } = await import('node:' + 'path')

type MissionProcess = {
  pid: number
  startedAt: string
  entryPath: string
  readMessages(afterCursor?: number, options?: { simulationEnded?: boolean }): Promise<unknown>
  completed: Promise<{ code: number | null }>
  stop(): Promise<void>
}

const DECLARATIONS = [
  '! SIMULATION_COMPLETE,time<time>,event<string>,Year<int>,Month<int>,Day<int>,Hour<int>,Minute<int>,Second<double>',
  '! COMM_TURNED_ON,time<time>,event<string>,platform<string>,side<string>,type<string>,system<string>,system_type<string>',
  '! MESSAGE_TRANSMITTED,time<time>,event<string>,platform<string>,side<string>,comm<string>,message_serial_number<int>,data_tag<double>,message_type<string>,message_size<int>',
  '! MESSAGE_RECEIVED,time<time>,event<string>,platform<string>,side<string>,comm<string>,message_serial_number<int>,data_tag<double>,message_type<string>,message_size<int>',
  '! LOCAL_TRACK_UPDATED,time<time>,event<string>,platform<string>,side<string>',
].join('\n')

const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function startLocalMessageMission(
  initialEvents: string | false,
  platforms = [
    { platformId: 'CMD-01', name: 'rear_comm_vehicle' },
    { platformId: 'SAT-01', name: 'tiantong_sat' },
    { platformId: 'AIR-01', name: 'mission_uav_01' },
    { platformId: 'AIR-02', name: 'mission_uav_02' },
  ],
  resolvedDirectory = 'output',
) {
  const root = await mkdtemp(join(tmpdir(), 'wrj-mission-messages-'))
  const entryPath = join(root, 'mission-1', 'comm_SimSetup.txt')
  const messages = new MissionMessageReader()
  const eventPath = join(dirname(entryPath), resolvedDirectory, 'scenario_events.csv')
  let ended = false
  let process: MissionProcess | undefined
  const server = createMockServer({
    port: 0,
    missionExecution: {
      start: async (draft: ScenarioDraft, runId: string) => {
        await mkdir(dirname(entryPath), { recursive: true })
        await writeFile(entryPath, 'entry')
        await writeFile(join(dirname(entryPath), 'mapping.json'), JSON.stringify({
          scenarioId: draft.config.scenario.id,
          revision: draft.revision,
          output: { resolvedDirectory },
          platformNaming: 'TEMPLATE_INSTANCE',
          platforms,
        }))
        if (initialEvents !== false) {
          await mkdir(join(dirname(entryPath), resolvedDirectory), { recursive: true })
          await writeFile(eventPath, initialEvents)
        }
        messages.attach(runId, draft, entryPath)
        process = {
          pid: 8101,
          startedAt: '2026-10-22T00:00:00Z',
          entryPath,
          readMessages: (cursor = 0, options) => messages.read(runId, cursor, {
            simulationEnded: options?.simulationEnded ?? ended,
          }),
          completed: new Promise(() => {}),
          stop: async () => { ended = true },
        }
        return process
      },
    },
  })
  cleanups.push(async () => { await server.close(); await rm(root, { recursive: true, force: true }) })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(server.httpServer)
  const created = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
  const runId = created.body.data.runId as string
  await api.post(`/api/v1/simulations/${runId}/commands`).set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
  return { api, runId, root, eventPath, server, messages, setEnded: (value: boolean) => { ended = value } }
}

describe('本次 mission 增量消息读取接口', () => {
  it('日志文件尚未写入时返回可用为空态，按 cursor 增量读取且不重复返还历史记录', async () => {
    const { api, runId, eventPath } = await startLocalMessageMission(false)
    const missing = await api.get(`/api/v1/simulations/${runId}/messages`).set(headers).expect(200)
    expect(missing.headers['cache-control']).toBe('no-store')
    expect(isMissionMessageSnapshot(missing.body.data)).toBe(true)
    expect(missing.body.data).toMatchObject({
      runId, sourceAvailable: false, cursor: 0, totalPaired: 0, deliveries: [],
    })

    await mkdir(dirname(eventPath), { recursive: true })
    await writeFile(eventPath, [
      DECLARATIONS,
      '0,COMM_TURNED_ON,rear_comm_vehicle,blue,Comm,sat_link_a,WSF_RADIO_TRANSCEIVER',
      '0,COMM_TURNED_ON,tiantong_sat,blue,Comm,sat_link,WSF_RADIO_TRANSCEIVER',
      '0,COMM_TURNED_ON,mission_uav_01,blue,Comm,sat_link_a,WSF_RADIO_TRANSCEIVER',
      '1.000,MESSAGE_TRANSMITTED,rear_comm_vehicle,blue,sat_link_a,101,0,kForwardSituation,256',
      '1.120,MESSAGE_RECEIVED,tiantong_sat,blue,sat_link,101,0,kForwardSituation,256',
      '1.120,MESSAGE_TRANSMITTED,tiantong_sat,blue,sat_link,101,0,kForwardSituation,256',
      '1.240,MESSAGE_RECEIVED,mission_uav_01,blue,sat_link_a,101,0,kForwardSituation,256',
      '',
    ].join('\n'))

    const first = await api.get(`/api/v1/simulations/${runId}/messages?cursor=0`).set(headers).expect(200)
    expect(isMissionMessageSnapshot(first.body.data)).toBe(true)
    expect(first.body.data.deliveries).toHaveLength(2)
    expect(first.body.data.issues).toEqual({ undelivered: 0, ambiguous: 0, unclassified: 0 })
    expect(first.body.data.deliveries.map((d: { source: { platformName: string }; target: { platformName: string }; direction: string }) => `${d.source.platformName}->${d.target.platformName}:${d.direction}`)).toEqual([
      'CMD-01->SAT-01:FORWARD',
      'SAT-01->AIR-01:FORWARD',
    ])

    // 同一 cursor 无新数据时不新增投递，带新 cursor 时返回空增量
    const cursor = first.body.data.cursor
    const emptyNext = await api.get(`/api/v1/simulations/${runId}/messages?cursor=${cursor}`).set(headers).expect(200)
    expect(emptyNext.body.data.deliveries).toHaveLength(0)

    await appendFile(eventPath, [
      '2.000,MESSAGE_TRANSMITTED,mission_uav_01,blue,sat_link_a,102,0,kReturnReconVideo,512',
      '2.120,MESSAGE_RECEIVED,tiantong_sat,blue,sat_link,102,0,kReturnReconVideo,512',
      '2.500,MESSAGE_TRANSMITTED,rear_comm_vehicle,blue,sat_link_a,103,0,MYSTERY_CUSTOM,128',
      '2.600,MESSAGE_RECEIVED,tiantong_sat,blue,sat_link,103,0,MYSTERY_CUSTOM,128',
      '',
    ].join('\n'))

    const second = await api.get(`/api/v1/simulations/${runId}/messages?cursor=${cursor}`).set(headers).expect(200)
    expect(second.body.data.deliveries).toHaveLength(2)
    expect(second.body.data.deliveries[0]).toMatchObject({
      source: { platformName: 'AIR-01' }, target: { platformName: 'SAT-01' }, direction: 'REVERSE',
    })
    expect(second.body.data.deliveries[1].direction).toBeUndefined()
  })

  it('跨读取块处理大日志，并在下次轮询补齐未换行的记录', async () => {
    const { api, runId, eventPath } = await startLocalMessageMission([
      DECLARATIONS,
      '0,COMM_TURNED_ON,rear_comm_vehicle,blue,Comm,sat_link_a,WSF_RADIO_TRANSCEIVER',
      '0,COMM_TURNED_ON,tiantong_sat,blue,Comm,sat_link,WSF_RADIO_TRANSCEIVER',
      '0,LOCAL_TRACK_UPDATED,rear_comm_vehicle,blue\n'.repeat(25_000)
        + '1.000,MESSAGE_TRANSMITTED,rear_comm_vehicle,blue,sat_link_a,101,0,kForwardSituation,256',
      '1.120,MESSAGE_RECEIVED,tiantong_sat,blue,sat_link,101,0,kForwardSituation',
    ].join('\n'))

    const url = `/api/v1/simulations/${runId}/messages`
    const first = await api.get(url).set(headers).expect(200)
    expect(first.body.data).toMatchObject({
      totalTransmits: 1, totalPaired: 0, waitingForLine: true, messageDetailsComplete: true,
    })

    await appendFile(eventPath, ',256\n')
    const second = await api.get(`${url}?cursor=${first.body.data.cursor}`).set(headers).expect(200)
    expect(second.body.data).toMatchObject({
      totalTransmits: 1, totalReceives: 1, totalPaired: 1, waitingForLine: false, messageDetailsComplete: true,
    })
    expect(second.body.data.deliveries).toHaveLength(1)
    expect(second.body.data.deliveries[0]).toMatchObject({
      source: { platformName: 'CMD-01' }, target: { platformName: 'SAT-01' }, direction: 'FORWARD',
    })
  })

  it.each(['\n', ''])('拒绝单条超出字节限制的记录（后缀 %j）', async (suffix) => {
    const { api, runId } = await startLocalMessageMission(
      `${DECLARATIONS}\n0,LOCAL_TRACK_UPDATED,${'测'.repeat(44_000)},blue${suffix}`,
    )
    await api.get(`/api/v1/simulations/${runId}/messages`).set(headers).expect(503)
  })

  it('严格保持 0.15s 配对边界、区分多播接收端、迟到接收、未确认发送与日志不完整状态', async () => {
    const initial = [
      DECLARATIONS,
      '0,COMM_TURNED_ON,rear_comm_vehicle,blue,Comm,c_band_uplink,WSF_RADIO_TRANSCEIVER',
      '0,COMM_TURNED_ON,mission_uav_01,blue,Comm,c_band_uplink,WSF_RADIO_TRANSCEIVER',
      '0,COMM_TURNED_ON,mission_uav_02,blue,Comm,c_band_uplink,WSF_RADIO_TRANSCEIVER',
      // 超出 0.15s 窗口：不强行配对，计入 undelivered 与 unconfirmedTransmits
      '1.000,MESSAGE_TRANSMITTED,rear_comm_vehicle,blue,c_band_uplink,11,0,CMD_ORDER,128',
      '1.200,MESSAGE_RECEIVED,mission_uav_01,blue,c_band_uplink,11,0,CMD_ORDER,128',
      // 一发多收广播：两个接收方必须分别产生独立投递，不合并
      '2.000,MESSAGE_TRANSMITTED,rear_comm_vehicle,blue,c_band_uplink,12,0,CMD_ORDER,256',
      '2.010,MESSAGE_RECEIVED,mission_uav_01,blue,c_band_uplink,12,0,CMD_ORDER,256',
      '2.020,MESSAGE_RECEIVED,mission_uav_02,blue,c_band_uplink,12,0,CMD_ORDER,256',
      // 迟到配对测试：先写入发送和 0.2s 后的轨迹行，接收行在下一批才刷盘
      '3.000,MESSAGE_TRANSMITTED,rear_comm_vehicle,blue,c_band_uplink,13,0,kForwardTarget,256',
      '3.200,LOCAL_TRACK_UPDATED,rear_comm_vehicle,blue',
      '',
    ].join('\n')

    const { api, runId, eventPath } = await startLocalMessageMission(initial)
    const snap1 = await api.get(`/api/v1/simulations/${runId}/messages?cursor=0`).set(headers).expect(200)
    expect(snap1.body.data.deliveries).toHaveLength(2)
    expect(snap1.body.data.deliveries.map((d: { target: { platformName: string } }) => d.target.platformName).sort()).toEqual(['AIR-01', 'AIR-02'])
    expect(snap1.body.data.issues.undelivered).toBe(1)
    expect(snap1.body.data.unconfirmedCount).toBe(2)

    // 迟到的 MESSAGE_RECEIVED 到达后配对一次，并将该发送移出 unconfirmed
    await appendFile(eventPath, [
      '3.050,MESSAGE_RECEIVED,mission_uav_01,blue,c_band_uplink,13,0,kForwardTarget,256',
      '3.300,MESSAGE_TRANSMITTED,rear_comm_vehicle,blue,c_band_uplink',
    ].join('\n'))
    const snap2 = await api.get(`/api/v1/simulations/${runId}/messages?cursor=${snap1.body.data.cursor}`).set(headers).expect(200)
    expect(snap2.body.data.deliveries).toHaveLength(1)
    expect(snap2.body.data.deliveries[0]).toMatchObject({
      source: { platformName: 'CMD-01' }, target: { platformName: 'AIR-01' }, direction: 'FORWARD',
    })
    expect(snap2.body.data.deliveries[0].delayS).toBeCloseTo(0.05, 9)
    expect(snap2.body.data.unconfirmedCount).toBe(1)
    // 尾部未换行半行保持 waitingForLine，不把截断尾巴当作异常或补造投递
    expect(snap2.body.data.waitingForLine).toBe(true)
    expect(snap2.body.data.messageDetailsComplete).toBe(true)

    // 坏格式行明确标记不完整信息（不崩溃、不补造）
    await appendFile(eventPath, ',99\n4.000,UNKNOWN_UNDECLARED,bad\n')
    const snap3 = await api.get(`/api/v1/simulations/${runId}/messages?cursor=${snap2.body.data.cursor}`).set(headers).expect(200)
    expect(snap3.body.data.messageDetailsComplete).toBe(false)
    expect(snap3.body.data.issueCount).toBeGreaterThan(0)
  })

  it('校验查询参数、运行隔离与路径越界边界', async () => {
    const { api, runId, root, eventPath } = await startLocalMessageMission(DECLARATIONS + '\n')
    await api.get(`/api/v1/simulations/${runId}/messages?path=C%3A%5Cevil.csv`).set(headers).expect(400)
    await api.get(`/api/v1/simulations/${runId}/messages?cursor=-1`).set(headers).expect(400)
    await api.get('/api/v1/simulations/RUN-MISSING/messages').set(headers).expect(404)

    // 文件重建时 generation 自增并清空旧计数
    await writeFile(eventPath, [
      DECLARATIONS,
      '0,COMM_TURNED_ON,rear_comm_vehicle,blue,Comm,c_band_uplink,WSF_RADIO_TRANSCEIVER',
      '0,COMM_TURNED_ON,mission_uav_01,blue,Comm,c_band_uplink,WSF_RADIO_TRANSCEIVER',
      '1,MESSAGE_TRANSMITTED,rear_comm_vehicle,blue,c_band_uplink,5,0,CMD_ORDER,64',
      '1.01,MESSAGE_RECEIVED,mission_uav_01,blue,c_band_uplink,5,0,CMD_ORDER,64',
      '',
    ].join('\n'))
    const first = await api.get(`/api/v1/simulations/${runId}/messages`).set(headers).expect(200)
    expect(first.body.data.generation).toBe(1)
    expect(first.body.data.totalPaired).toBe(1)

    await writeFile(eventPath, DECLARATIONS + '\n')
    const truncated = await api.get(`/api/v1/simulations/${runId}/messages?cursor=0`).set(headers).expect(200)
    expect(truncated.body.data.generation).toBe(2)
    expect(truncated.body.data.totalPaired).toBe(0)

    // 符号链接越界文件必须被拒绝且不泄露真实路径
    const outside = join(root, 'outside.csv')
    await writeFile(outside, DECLARATIONS + '\n')
    await rm(eventPath)
    await symlink(outside, eventPath)
    const rejected = await api.get(`/api/v1/simulations/${runId}/messages`).set(headers).expect(503)
    expect(JSON.stringify(rejected.body)).not.toContain(root)
  })
})

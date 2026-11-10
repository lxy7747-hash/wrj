// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import sample from '../fixtures/engine-frame/params_check.json'
import initialNew from '../fixtures/engine-frame/websocket-new/fream001.json'
import switchNew from '../fixtures/engine-frame/websocket-new/fream_chenge1.json'
import detectedNew from '../fixtures/engine-frame/websocket-new/fream_chenge2.json'
import alarmNew from '../fixtures/engine-frame/websocket-new/fream_chenge3.json'
import latestSamples from '../fixtures/engine-frame/websocket-latest.json'
import type { EngineConnectionDiagnostic, EngineFrameArchiveSegmentRow, EngineFrameSnapshot, MissionLogUpdate } from '../../src/contracts/domain-models'
const { once } = await import('node:' + 'events')
const { createServer } = await import('node:' + 'http')
const { WebSocket, WebSocketServer } = await import('w' + 's')
const { EngineSnapshotClient, readLinkEngineWsUrl } = await import('../../server/local/' + 'engine-snapshot-client.js')
const { MissionLogStreamer } = await import('../../server/local/' + 'mission-log-stream.js')
const { MockProjection } = await import('../../server/state/' + 'projection.js')
const { attachRealtimeServer } = await import('../../server/ws/' + 'realtime.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createEngineFrameArchive } = await import('../../server/local/' + 'engine-frame-archive.js')
const cleanups: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })

const manifest = {
  platformNaming: 'TEMPLATE_INSTANCE', platforms: [{ platformId: 'PLAT-001', name: 'UAV1' }, { platformId: 'SUP-001', name: 'shentong_sat' }, { platformId: 'PLAT-002', name: 'relay' }, { platformId: 'PLAT-JAM', name: 'jammer_station_01' }],
  devices: [
    { linkId: 'L-DIRECT', source: { platformId: 'UAV1', deviceId: 'sat_link_a' }, target: { platformId: 'shentong_sat', deviceId: 'sat_link' } },
    ...['L-RELAY', 'L-SHARED'].map(linkId => ({ linkId, source: { platformId: 'UAV1', deviceId: 'c_up' }, target: { platformId: 'shentong_sat', deviceId: 'c_up' }, relayPlatformId: 'relay', relayDeviceId: 'c_up' })),
  ],
}
async function upstream() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  cleanups.push(async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { server, url: `ws://127.0.0.1:${server.address().port}/ws/v1` }
}
const run = { runId: 'RUN-ENGINE' as const, taskId: 'TASK-001' as const }

it('突发 600 帧随写盘背压顺序接收，不并发堆积或丢帧', async () => {
  const { server, url } = await upstream()
  const root = await mkdtemp(join(tmpdir(), 'wrj-burst-frame-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const archive = createEngineFrameArchive(root, () => '2026-11-10T00:00:00Z')
  const session = await archive.begin({ ...run, scenarioId: 'SCN-LATEST', revision: 1, startedAt: '2026-11-10T00:00:00Z' })
  let release!: () => void
  const slowDisk = new Promise<void>(resolve => { release = resolve })
  let active = 0, peak = 0, saved = 0
  const client = new EngineSnapshotClient(url, async (_: string, frame: EngineFrameSnapshot) => {
    peak = Math.max(peak, ++active)
    await slowDisk
    await session.append(frame)
    active--; saved++
  }, vi.fn())
  cleanups.push(async () => { release(); client.stop(); await session.close() })
  const connected = once(server, 'connection'); client.start(run, manifest); const [socket] = await connected
  for (let i = 0; i < 600; i++) socket.send(JSON.stringify({ ...latestSamples[i % 2], frame_id: i * 5 }))
  await vi.waitFor(() => expect(active).toBeGreaterThan(0))
  await new Promise(resolve => setTimeout(resolve, 50))
  release()
  await vi.waitFor(() => expect(saved).toBe(600), { timeout: 15000 })
  expect(peak).toBe(1)
  expect(session.failure()).toBeNull()
  client.stop(); await session.close()
  const summary = (await archive.load(run.runId))!
  expect(summary).toMatchObject({ frameCount: 600, firstSimulationTime: 0, lastSimulationTime: 2995 })
  expect(summary.segmentRows).toHaveLength(3000)
}, 20000)

it('最新两条无时间字段报文经 WS 接收与 JSONL 往返保留全部指标，规范 CSV 缺测不伪造', async () => {
  const { server, url } = await upstream(), frames: EngineFrameSnapshot[] = []
  const root = await mkdtemp(join(tmpdir(), 'wrj-latest-frame-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const archive = createEngineFrameArchive(root, () => '2026-11-10T00:00:00Z')
  const scope = { ...run, scenarioId: 'SCN-LATEST', revision: 1, startedAt: '2026-11-10T00:00:00Z' }
  const session = await archive.begin(scope)
  const diagnostics: EngineConnectionDiagnostic[] = []
  const client = new EngineSnapshotClient(url, (_run: string, frame: EngineFrameSnapshot) => { frames.push(frame); session.append(frame) }, vi.fn(), (_run: unknown, diagnostic: EngineConnectionDiagnostic) => diagnostics.push(diagnostic))
  cleanups.push(() => client.stop())
  const connected = once(server, 'connection'); client.start(run, manifest); const [socket] = await connected
  latestSamples.forEach(raw => socket.send(JSON.stringify(raw)))
  await vi.waitFor(() => expect(frames).toHaveLength(2))
  expect(client.diagnostics.rejected).toBe(0)
  expect(diagnostics.some(item => item.state === 'FRAME_ADVANCE_OBSERVED')).toBe(false)
  expect(frames.map(frame => frame.simulationTime)).toEqual([3775, 3780])
  expect(frames.every(frame => frame.links.length === 5 && !frame.jammers.length && !frame.events.length)).toBe(true)
  expect(frames[0]!.links[0]!.quality).toMatchObject({ gxbDb: 0, ber: latestSamples[0]!.link_calc.links[0]!.quality.ber, rxPowerDbm: null })
  expect(frames[0]!.links[1]!.inputTrace.jammers[0]!.lossDb).toBe(latestSamples[0]!.link_calc.links[1]!.quality.input_trace.jammers[0]!.Loss_dB)
  await session.close()
  const saved = (await archive.load(run.runId))!
  expect(saved).toMatchObject({ frameCount: 2, firstSimulationTime: 3775, lastSimulationTime: 3780, switchRows: [], eventRows: [] })
  expect(saved.segmentRows.map((row: EngineFrameArchiveSegmentRow) => row.segment)).toEqual(frames.flatMap(frame => frame.links))
  const { readFile } = await import('node:fs/' + 'promises')
  const restored = (await readFile((await archive.getFile(run.runId, saved.sourceSha256))!, 'utf8')).trim().split('\n').map((line: string) => JSON.parse(line))
  expect(restored).toEqual(frames)
  const csv = (await archive.finalizeCsv(run.runId, scope, {}))!
  expect(csv.files).toEqual([])
  expect(csv.missing.map((file: { fileName: string }) => file.fileName)).toHaveLength(5)
})

it('websocketNew 四帧经本地 WS 转发保留新增字段、统一秒值，仅从本轮历史恢复旧路径', async () => {
  const { server, url } = await upstream(), frames: EngineFrameSnapshot[] = []
  const projection = new MockProjection(), http = createServer()
  const active = { ...projection.snapshot().run!, ...run, scenarioId: 'SCN-ENGINE', startedAt: '2026-11-09T00:00:00Z' }
  const realtime = attachRealtimeServer(http, projection, () => active)
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  cleanups.push(async () => { await realtime.close(); await new Promise<void>(resolve => http.close(() => resolve())) })
  realtime.publishRuntimeState(active)
  const browser = new WebSocket(`ws://127.0.0.1:${http.address().port}/ws/v1?role=OPERATOR`, { origin: 'http://127.0.0.1:5173' })
  cleanups.push(() => browser.terminate())
  const messages: any[] = []; browser.on('message', (v: any) => messages.push(JSON.parse(v.toString())))
  await once(browser, 'open'); browser.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: run.taskId, topics: ['link.metric', 'jammer.event', 'switch.event'] }))
  await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0))
  const client = new EngineSnapshotClient(url, (id: string, frame: EngineFrameSnapshot) => { frames.push(frame); realtime.publishEngineFrame(id, frame) })
  cleanups.push(() => client.stop())
  const connected = once(server, 'connection'); client.start(run, manifest); const [socket] = await connected
  for (const raw of [initialNew, switchNew, detectedNew, alarmNew]) socket.send(JSON.stringify({ ...raw, sim_time_s: undefined }))
  const delivered = () => messages.filter(message => message.payload?.kind === 'ENGINE_FRAME')
  await vi.waitFor(() => expect(delivered()).toHaveLength(4))
  expect(frames[1]!.routing.switches[0]!.oldNodes.map(node => node.platformName)).toEqual(['rear_comm_vehicle', 'command_vehicle', 'mission_uav_03'])
  expect(frames[1]!.routing.switches[1]!.oldNodes.map(node => node.platformName)).toEqual(['mission_uav_03', 'command_vehicle', 'rear_comm_vehicle'])
  expect(frames[3]!.routing.switches[0]!.oldNodes).toEqual([])
  expect(delivered()[2]).toMatchObject({ taskId: run.taskId, simulationTime: 375,
    payload: { simulationTime: 375, frameId: 375, jammers: [{ platformId: 'PLAT-JAM', frequencyHz: 2400000000, detections: [{ frequencyHz: 2400000000 }], position: { longitude: 121.55 } }] } })
  expect(messages.find(message => message.payload?.kind === 'ENGINE_JAMMER_FRAME' && message.payload.sourceFrameId === 375)).toMatchObject({ simulationTime: 375, payload: { simulationTime: 375 } })
  expect(messages.find(message => message.payload?.kind === 'ENGINE_SWITCH_FRAME' && message.payload.sourceFrameId === 254)).toMatchObject({ simulationTime: 254, payload: { switches: [{ parameters: { transFrequency: 10 } }, { parameters: { transFrequency: 10 } }] } })
  socket.send(JSON.stringify(alarmNew)); await vi.waitFor(() => expect(client.diagnostics.stale).toBe(1))
  expect(frames).toHaveLength(4)
  socket.send(JSON.stringify({ ...switchNew, frame_id: 0, sim_time_s: 0 }))
  await vi.waitFor(() => expect(frames).toHaveLength(5))
  expect(frames[4]).toMatchObject({ engineEpoch: 1, simulationTime: 0 })
  expect(frames[4]!.routing.switches.every(route => !route.oldNodes.length)).toBe(true)
})

it('本地上游 → link.metric → 订阅端，绑定实例、共享段和中继，缓存初始热链并重放', async () => {
  const { server, url } = await upstream()
  const projection = new MockProjection(), http = createServer()
  const active = { ...projection.snapshot().run!, ...run, scenarioId: 'SCN-ENGINE', startedAt: '2026-11-07T00:00:00Z' }
  const realtime = attachRealtimeServer(http, projection, () => active)
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  cleanups.push(async () => { await realtime.close(); await new Promise<void>(resolve => http.close(() => resolve())) })
  realtime.publishRuntimeState(active)
  const browser = new WebSocket(`ws://127.0.0.1:${http.address().port}/ws/v1?role=OPERATOR`, { origin: 'http://127.0.0.1:5173' })
  cleanups.push(() => browser.terminate())
  const messages: any[] = []; browser.on('message', (v: any) => messages.push(JSON.parse(v.toString())))
  await once(browser, 'open'); browser.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: run.taskId, topics: ['link.metric'] }))
  await vi.waitFor(() => expect(messages).toHaveLength(1))
  const client = new EngineSnapshotClient(url, (id: any, frame: EngineFrameSnapshot) => realtime.publishEngineFrame(id, frame))
  cleanups.push(() => client.stop())
  const connected = once(server, 'connection'); expect(client.start(run, manifest)).toBe(true)
  const [socket] = await connected
  const raw = structuredClone(sample)
  raw.link_calc.links.push({ ...raw.link_calc.links[0]!, link_id: 'hop1', tx_port: 'c_up', rx_platform: 'relay', rx_port: 'c_up' },
    { ...raw.link_calc.links[0]!, link_id: 'hop2', tx_platform: 'relay', tx_port: 'c_up', rx_port: 'c_up' },
    { ...raw.link_calc.links[0]!, link_id: 'unbound', tx_platform: 'unknown' })
  socket.send(JSON.stringify({ ...raw, runId: 'RUN-ATTACK', taskId: 'TASK-OTHER' }))
  await vi.waitFor(() => expect(messages).toHaveLength(2))
  expect(messages[1]).toMatchObject({ taskId: 'TASK-001', frameId: 'F-ENGINE-4800', payload: { kind: 'ENGINE_FRAME', runId: 'RUN-ENGINE', engineEpoch: 0, links: [
    { sourcePlatformId: 'PLAT-001', targetPlatformId: 'SUP-001', linkIds: ['L-DIRECT'] },
    { linkIds: ['L-RELAY','L-SHARED'] }, { linkIds: ['L-RELAY','L-SHARED'] }, { sourceName: 'unknown', linkIds: [] },
  ] } })
  const next: any = structuredClone(raw); next.frame_id++; delete next.link_manager.init_routing_result
  socket.send(JSON.stringify(next)); await vi.waitFor(() => expect(messages).toHaveLength(3))
  expect(messages[2].payload.initRouting).toEqual(messages[1].payload.initRouting)
  const closed = once(browser, 'close'); browser.close(); await closed
  const resumed = new WebSocket(`ws://127.0.0.1:${http.address().port}/ws/v1?role=OPERATOR`, { origin: 'http://127.0.0.1:5173' })
  cleanups.push(() => resumed.terminate())
  const replay: any[] = []; resumed.on('message', (v: any) => replay.push(JSON.parse(v.toString())))
  await once(resumed, 'open'); resumed.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: run.taskId, topics: ['link.metric'], lastSequences: { 'link.metric': 1 } }))
  await vi.waitFor(() => expect(replay).toHaveLength(2))
  expect(replay[1]).toEqual(messages[2])
})

it('归零帧递增 engineEpoch 并清空热链；递增帧重连保留缓存，新运行从 epoch 0 开始', async () => {
  const { server, url } = await upstream(), report = vi.fn(), frames: EngineFrameSnapshot[] = []
  const client = new EngineSnapshotClient(url, (_: string, frame: EngineFrameSnapshot) => frames.push(frame), report)
  cleanups.push(() => client.stop())
  const connected = once(server, 'connection'); client.start(run, manifest); const [socket] = await connected
  socket.send('{bad json'); socket.send(JSON.stringify({ ...sample, frame_id: null })); socket.send(JSON.stringify(sample))
  await vi.waitFor(() => expect(frames).toHaveLength(1)); expect(client.diagnostics.rejected).toBe(2)
  expect(frames[0]!.initRouting?.length).toBeGreaterThan(0)
  const reset = { ...sample, frame_id: 0, sim_time_s: 0, link_manager: {} }
  socket.send(JSON.stringify(reset))
  await vi.waitFor(() => expect(frames).toHaveLength(2))
  expect(frames[1]).toMatchObject({ engineEpoch: 1, frameId: 0, initRouting: null })
  socket.send(JSON.stringify(reset))
  await vi.waitFor(() => expect(client.diagnostics.stale).toBe(1))
  socket.send(JSON.stringify({ ...sample, frame_id: 1 }))
  await vi.waitFor(() => expect(frames).toHaveLength(3))
  expect(frames[2]).toMatchObject({ engineEpoch: 1, frameId: 1, initRouting: frames[0]!.initRouting })
  expect(client.start({ ...run, runId: 'RUN-OTHER' }, manifest)).toBe(false)
  expect(report).toHaveBeenCalledWith('引擎链路推送只支持单任务运行')
  const reconnect = once(server, 'connection'); socket.close(); const [second] = await reconnect
  const next = { ...sample, frame_id: 2, link_manager: {} }; second.send(JSON.stringify(next))
  await vi.waitFor(() => expect(frames).toHaveLength(4))
  expect(frames[3]).toMatchObject({ engineEpoch: 1, frameId: 2, initRouting: frames[2]!.initRouting })
  client.stop('RUN-OTHER'); expect(client.diagnostics.connected).toBe(true)
  client.stop(run.runId); await vi.waitFor(() => expect(server.clients.size).toBe(0))
  const newConnection = once(server, 'connection'); client.start({ ...run, runId: 'RUN-NEW' }, manifest); const [third] = await newConnection
  third.send(JSON.stringify({ ...next, frame_id: 0 })); await vi.waitFor(() => expect(frames).toHaveLength(5))
  expect(frames[4]).toMatchObject({ runId: 'RUN-NEW', engineEpoch: 0, initRouting: null, frameId: 0 })
  client.stop(); await vi.waitFor(() => expect(server.clients.size).toBe(0))
})

it('同一 engineEpoch 内重复或非零倒序帧丢弃，不修改初始热链', async () => {
  const { server, url } = await upstream(), frames: EngineFrameSnapshot[] = []
  const client = new EngineSnapshotClient(url, (_: string, frame: EngineFrameSnapshot) => frames.push(frame), vi.fn())
  cleanups.push(() => client.stop())
  const connected = once(server, 'connection'); client.start(run, manifest); const [socket] = await connected
  socket.send(JSON.stringify(sample))
  await vi.waitFor(() => expect(frames).toHaveLength(1))
  for (const frame_id of [4800, 4799]) socket.send(JSON.stringify({ ...sample, frame_id, link_manager: { init_routing_result: {} } }))
  socket.send(JSON.stringify({ ...sample, frame_id: 4801, link_manager: {} }))
  await vi.waitFor(() => expect(frames).toHaveLength(2))
  expect(client.diagnostics.stale).toBe(2)
  expect(frames[1]).toMatchObject({ engineEpoch: 0, frameId: 4801, initRouting: frames[0]!.initRouting })
})

it('上游连接、拒绝与非5步长的帧号变化发布诊断，不推定补发能力', async () => {
  const { server, url } = await upstream(), diagnostics: any[] = []
  const client = new EngineSnapshotClient(url, vi.fn(), vi.fn(), (_run: { runId: string; taskId: string }, diagnostic: EngineConnectionDiagnostic) => diagnostics.push(diagnostic))
  cleanups.push(() => client.stop())
  const connected = once(server, 'connection'); client.start(run, manifest); const [socket] = await connected
  await vi.waitFor(() => expect(diagnostics.map(item => item.state)).toEqual(expect.arrayContaining(['CONNECTING', 'CONNECTED'])))
  socket.send(JSON.stringify(sample)); socket.send(JSON.stringify({ ...sample, frame_id: sample.frame_id + 3, link_manager: {} })); socket.send('{bad json')
  await vi.waitFor(() => expect(diagnostics.map(item => item.state)).toEqual(expect.arrayContaining(['FRAME_ADVANCE_OBSERVED', 'REJECTED'])))
  const advance = diagnostics.find(item => item.state === 'FRAME_ADVANCE_OBSERVED')
  expect(advance).toMatchObject({ previousFrameId: sample.frame_id, observedFrameId: sample.frame_id + 3 })
  expect(advance.message).toContain('约定步长 5（5 秒）')
  expect(advance.message).toContain('不推定上游补发能力')
})

it('5→10 为正常连续帧，10→20 提示间隔异常且不补造帧，后续25正常接收', async () => {
  const { server, url } = await upstream(), diagnostics: EngineConnectionDiagnostic[] = [], frames: EngineFrameSnapshot[] = []
  const client = new EngineSnapshotClient(url, (_: string, frame: EngineFrameSnapshot) => frames.push(frame), vi.fn(),
    (_run: { runId: string; taskId: string }, diagnostic: EngineConnectionDiagnostic) => diagnostics.push(diagnostic))
  cleanups.push(() => client.stop())
  const connected = once(server, 'connection'); client.start(run, manifest); const [socket] = await connected
  for (const frame_id of [5, 10]) socket.send(JSON.stringify({ ...sample, frame_id, sim_time_s: undefined }))
  await vi.waitFor(() => expect(frames).toHaveLength(2))
  expect(diagnostics.filter(item => item.state === 'FRAME_ADVANCE_OBSERVED')).toEqual([])
  for (const frame_id of [20, 25]) socket.send(JSON.stringify({ ...sample, frame_id, sim_time_s: undefined }))
  await vi.waitFor(() => expect(frames).toHaveLength(4))
  expect(frames.map(frame => [frame.frameId, frame.simulationTime])).toEqual([[5, 5], [10, 10], [20, 20], [25, 25]])
  expect(diagnostics.filter(item => item.state === 'FRAME_ADVANCE_OBSERVED')).toEqual([
    expect.objectContaining({ previousFrameId: 10, observedFrameId: 20 }),
  ])
})

it.each([7, 4800])('重连首帧 %s：回退则重启，重复则丢弃；后续非零倒序不再重启', async firstId => {
  const { server, url } = await upstream(), frames: EngineFrameSnapshot[] = []
  const client = new EngineSnapshotClient(url, (_: string, frame: EngineFrameSnapshot) => frames.push(frame), vi.fn())
  cleanups.push(() => client.stop())
  const connected = once(server, 'connection'); client.start(run, manifest); const [socket] = await connected
  socket.send(JSON.stringify(sample)); await vi.waitFor(() => expect(frames).toHaveLength(1))
  const reconnect = once(server, 'connection'); socket.close(); const [second] = await reconnect
  second.send('{bad json')
  for (const frame_id of [firstId, firstId - 1, firstId + 1]) second.send(JSON.stringify({ ...sample, frame_id, link_manager: {} }))
  const restarted = firstId < 4800
  await vi.waitFor(() => expect(frames).toHaveLength(restarted ? 3 : 2))
  expect(client.diagnostics.rejected).toBe(1)
  expect(client.diagnostics.stale).toBe(restarted ? 1 : 2)
  if (restarted) expect(frames[1]).toMatchObject({ engineEpoch: 1, frameId: firstId, initRouting: null })
  expect(frames.at(-1)).toMatchObject({ engineEpoch: restarted ? 1 : 0, frameId: firstId + 1, initRouting: restarted ? null : frames[0]!.initRouting })
})

it.each([
  [undefined, 'undefined', 'undefined（字段缺失）'],
  [null, 'null', 'null'],
  [-1, '-1', 'number'],
  ['', '""', 'string'],
  ['2026-11-09T12:00:00Z', '"2026-11-09T12:00:00Z"', 'string'],
  ['5000ms', '"5000ms"', 'string'],
  [false, 'false', 'boolean'],
  [[5000], '[5000]', 'array'],
  [{ value: 5000 }, '{"value":5000}', 'object'],
] as const)('无效帧号 %j 在日志和页面诊断中保留原值 %s 与类型 %s', async (value, original, type) => {
  const { server, url } = await upstream(), report = vi.fn(), publish = vi.fn(), diagnostics: EngineConnectionDiagnostic[] = []
  const client = new EngineSnapshotClient(url, publish, report, (_run: unknown, diagnostic: EngineConnectionDiagnostic) => diagnostics.push(diagnostic))
  cleanups.push(() => client.stop())
  const connected = once(server, 'connection'); client.start(run, manifest); const [socket] = await connected
  socket.send(JSON.stringify({ ...sample, frame_id: value }))
  await vi.waitFor(() => expect(client.diagnostics.rejected).toBe(1))
  const detail = `原始值=${original}，数据类型=${type}`
  expect(client.diagnostics.lastError).toContain(detail)
  expect(report).toHaveBeenCalledWith(expect.stringContaining(detail))
  expect(diagnostics.find(item => item.state === 'REJECTED')?.message).toContain(`已拒绝上游引擎数据（帧头无效）：frame_id：`)
  expect(diagnostics.find(item => item.state === 'REJECTED')?.message).toContain(detail)
  expect(publish).not.toHaveBeenCalled()
  socket.send(JSON.stringify({ ...sample, frame_id: 5, sim_time_s: undefined }))
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(run.runId, expect.objectContaining({ frameId: 5, simulationTime: 5 })))
})

it.each([
  [{ frame_id: 'bad-id' }, ['frame_id：引擎帧号必须为非负整数。（原始值="bad-id"，数据类型=string）']],
  [{ frame_id: null, sim_time_s: false, link_calc: { links: { unexpected: true } } }, [
    'frame_id：引擎帧号必须为非负整数。（原始值=null，数据类型=null）',
    'link_calc.links：引擎链路段必须为数组。（原始值={"unexpected":true}，数据类型=object）',
  ]],
  [{ frame_id: undefined, sim_time_s: undefined, link_calc: undefined }, [
    'frame_id：引擎帧号必须为非负整数。（原始值=undefined，数据类型=undefined（字段缺失））',
    'link_calc.links：引擎链路段必须为数组。（原始值=undefined，数据类型=undefined（字段缺失））',
  ]],
  [{ link_calc: { links: '[]' } }, ['link_calc.links：引擎链路段必须为数组。（原始值="[]"，数据类型=string）']],
] as const)('帧头诊断逐项输出所有失败字段的原值和类型：%j', async (invalid, details) => {
  const { server, url } = await upstream(), report = vi.fn(), publish = vi.fn(), diagnostics: EngineConnectionDiagnostic[] = []
  const client = new EngineSnapshotClient(url, publish, report, (_run: unknown, diagnostic: EngineConnectionDiagnostic) => diagnostics.push(diagnostic))
  cleanups.push(() => client.stop())
  const connected = once(server, 'connection'); client.start(run, manifest); const [socket] = await connected
  socket.send(JSON.stringify({ ...sample, ...invalid, unrelated: 'DO_NOT_LOG_WHOLE_FRAME' }))
  await vi.waitFor(() => expect(client.diagnostics.rejected).toBe(1))
  const message = diagnostics.find(item => item.state === 'REJECTED')!.message
  for (const detail of details) {
    expect(message).toContain(detail)
    expect(report).toHaveBeenCalledWith(expect.stringContaining(detail))
  }
  expect(message).not.toContain('DO_NOT_LOG_WHOLE_FRAME')
  expect(publish).not.toHaveBeenCalled()
  socket.send(JSON.stringify(sample))
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1))
})

it('无效帧号的日志转义换行并限制原值长度，不输出整帧其他字段', async () => {
  const { server, url } = await upstream(), report = vi.fn(), diagnostics: EngineConnectionDiagnostic[] = []
  const client = new EngineSnapshotClient(url, vi.fn(), report, (_run: unknown, diagnostic: EngineConnectionDiagnostic) => diagnostics.push(diagnostic))
  cleanups.push(() => client.stop())
  const connected = once(server, 'connection'); client.start(run, manifest); const [socket] = await connected
  socket.send(JSON.stringify({ ...sample, frame_id: `bad\r\n${'x'.repeat(2000)}`, unrelated: 'DO_NOT_LOG_WHOLE_FRAME' }))
  await vi.waitFor(() => expect(client.diagnostics.rejected).toBe(1))
  const message = diagnostics.find(item => item.state === 'REJECTED')!.message
  expect(message).toContain('原始值="bad\\r\\n')
  expect(message).toContain('…（已截断），数据类型=string')
  expect(message).not.toMatch(/[\r\n]/u)
  expect(message).not.toContain('DO_NOT_LOG_WHOLE_FRAME')
  expect(message.length).toBeLessThan(400)
  expect(report).toHaveBeenCalledWith(expect.stringContaining('…（已截断），数据类型=string'))
})

it('坏帧和过期帧按原因分别限流，10 秒内累计但不刷屏，下一条日志包含累计数', async () => {
  const { server, url } = await upstream(), report = vi.fn(), frames: EngineFrameSnapshot[] = []
  const client = new EngineSnapshotClient(url, (_: string, frame: EngineFrameSnapshot) => frames.push(frame), report)
  cleanups.push(() => client.stop())
  const connected = once(server, 'connection'); client.start(run, manifest); const [socket] = await connected
  const now = Date.now; let elapsed = 0
  vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed)
  socket.send(JSON.stringify(sample)); await vi.waitFor(() => expect(frames).toHaveLength(1))
  const discard = () => { socket.send('{bad json'); socket.send(JSON.stringify({ ...sample, frame_id: 4799 })) }
  for (let i = 0; i < 3; i++) discard()
  await vi.waitFor(() => expect(client.diagnostics).toMatchObject({ rejected: 3, stale: 3 }))
  expect(report).toHaveBeenCalledTimes(2)
  expect(report).toHaveBeenCalledWith(expect.stringContaining('JSON 格式错误，累计 1'))
  expect(report).toHaveBeenCalledWith(expect.stringContaining('帧号重复或倒退，累计 1'))
  elapsed = 10_000; discard()
  await vi.waitFor(() => expect(client.diagnostics).toMatchObject({ rejected: 4, stale: 4 }))
  expect(report).toHaveBeenCalledTimes(4)
  expect(report).toHaveBeenCalledWith(expect.stringContaining('JSON 格式错误，累计 4'))
  expect(report).toHaveBeenCalledWith(expect.stringContaining('帧号重复或倒退，累计 4'))
  expect(frames).toHaveLength(1); expect(client.diagnostics.connected).toBe(true)
})

it('停止清除重连 timer 和监听，不能在运行结束后重建连接', async () => {
  const { server, url } = await upstream()
  const client = new EngineSnapshotClient(url, vi.fn(), vi.fn()); cleanups.push(() => client.stop())
  const connected = once(server, 'connection'); client.start(run, manifest); const [socket] = await connected
  await vi.waitFor(() => expect(client.diagnostics.connected).toBe(true))
  socket.close(); await vi.waitFor(() => expect(client.diagnostics.connected).toBe(false))
  const clear = vi.spyOn(globalThis, 'clearTimeout'), reconnect = vi.fn(); server.on('connection', reconnect)
  client.stop(); expect(clear).toHaveBeenCalledWith(expect.anything())
  await new Promise(resolve => setTimeout(resolve, 1100)); expect(reconnect).not.toHaveBeenCalled()
})

it('可选配置只接受 ws/wss 地址，不含凭据与片段', () => {
  expect(readLinkEngineWsUrl(undefined)).toBeUndefined(); expect(readLinkEngineWsUrl('  ')).toBeUndefined()
  expect(readLinkEngineWsUrl('ws://127.0.0.1:8080/ws/v1')).toBe('ws://127.0.0.1:8080/ws/v1')
  for (const value of ['broken','https://host/ws','ws://u:p@host/ws','ws://host/ws#secret']) expect(() => readLinkEngineWsUrl(value)).toThrow('LINK_ENGINE_WS_URL')
})

it.each(['STOP', 'close'])('远端接收独立连接；%s 后正确收尾', async end => {
  const { server: upstreamServer, url } = await upstream()
  const root = await mkdtemp(join(tmpdir(), 'wrj-remote-snapshot-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  let finish!: (value: { code: number | null }) => void
  const completed = new Promise<{ code: number | null }>(resolve => { finish = resolve })
  const server = createMockServer({ port: 0, linkEngineWsUrl: url,
    engineFrameArchive: createEngineFrameArchive(root, () => new Date().toISOString()),
    createEngineSnapshotClient: (url: string, publish: any, diagnose: any) => new EngineSnapshotClient(url, publish, undefined, diagnose), missionExecution: { start: async () => ({
    pid: 123, startedAt: '2026-11-07T01:00:00Z', entryPath: 'test/scenario.txt', engineManifest: manifest, completed,
    stop: async () => { finish({ code: 0 }) },
  }) } })
  cleanups.push(() => server.close())
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
  const created = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
  expect(upstreamServer.clients.size).toBe(0)
  const connected = once(upstreamServer, 'connection')
  await api.post(`/api/v1/simulations/${created.body.data.runId}/commands`).set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
  const [socket] = await connected
  const closed = once(socket, 'close')
  if (end === 'STOP') {
    await vi.waitFor(async () => expect((await api.get(`/api/v1/simulations/${created.body.data.runId}`).set(headers)).body.data.engineControl.connected).toBe(true))
    const context = (await api.post('/api/v1/confirmations').set(headers).send({ action: 'SIMULATION_STOP', objectId: created.body.data.runId }).expect(201)).body.data
    await api.post(`/api/v1/confirmations/${context.confirmationId}`).set(headers).send({ confirm: true }).expect(200)
    const message = once(socket, 'message')
    await api.post(`/api/v1/simulations/${created.body.data.runId}/commands`).set(headers).send({ command: 'STOP', confirmationId: context.confirmationId }).expect(200)
    expect(JSON.parse((await message)[0].toString())).toEqual({ msg_type: 'sim_control', action: 'stop' })
  }
  if (end === 'close') await server.close()
  await closed
  expect(upstreamServer.clients.size).toBe(0)
})

it('mission 运行日志在 HTTP 初始读取后通过 mission.log 增量推送', async () => {
  let text = '启动完成\n'
  let finish!: (value: { code: number | null }) => void
  const completed = new Promise<{ code: number | null }>(resolve => { finish = resolve })
  const readConsoleLog = async () => ({ text, bytes: new TextEncoder().encode(text).byteLength, truncated: false })
  const server = createMockServer({
    port: 0,
    createMissionLogStreamer: (read: typeof readConsoleLog, publish: (update: MissionLogUpdate) => void, runId: MissionLogUpdate['runId']) => new MissionLogStreamer(read, publish, runId),
    missionExecution: { start: async () => ({
      pid: 123, startedAt: '2026-11-07T01:00:00Z', entryPath: 'test/scenario.txt', completed,
      readConsoleLog,
      stop: async () => { finish({ code: 0 }) },
    }) },
  })
  cleanups.push(() => server.close())
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
  const created = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
  const browser = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}/ws/v1?role=OPERATOR`, { origin: 'http://127.0.0.1:5173' })
  cleanups.push(() => browser.terminate())
  const messages: any[] = []; browser.on('message', (value: any) => messages.push(JSON.parse(value.toString()))); await once(browser, 'open')
  browser.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['mission.log'] }))
  await vi.waitFor(() => expect(messages).toHaveLength(1))
  await api.post(`/api/v1/simulations/${created.body.data.runId}/commands`).set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
  text += '实时追加🙂\n'
  await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({ topic: 'mission.log', payload: expect.objectContaining({
    kind: 'MISSION_LOG', runId: created.body.data.runId, text: '实时追加🙂\n', replace: false,
  }) })), { timeout: 3_000 })
  const message = messages.find(item => item.topic === 'mission.log')
  expect(message).not.toHaveProperty('simulationTime')
  expect(message).not.toHaveProperty('frameId')
  finish({ code: 0 })
})

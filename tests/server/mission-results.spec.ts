// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { POSITION_CSV } from '../fixtures/local-replay'
import { fileReceptionScenarioId, playbackFileSource } from '../../src/features/situation/file-reception'
import type { ScenarioDraft, AccessControlConfig, Report, LocalReportFilterResult } from '../../src/contracts/domain-models'
import type { MissionResultParameterComparison, MissionResultRecord, MissionResultSnapshot } from '../../src/features/results/mission-result'
const { mkdtemp, mkdir, readFile, writeFile, rm, readdir } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { createHash } = await import('node:' + 'crypto')
const { default: request } = await import('super' + 'test')
const { LocalMissionResults } = await import('../../server/local/' + 'mission-results.js')
const { LocalMissionRunner } = await import('../../server/local/' + 'mission-runner.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { AuthSqliteStorage } = await import('../../server/local/' + 'auth-sqlite.js')
const { exportLocalReport } = await import('../../server/local/' + 'report-file.js')
const { readAfsimLogFile } = await import('../../server/local/' + 'afsim-log-reader.js')
const { readLocalReplay } = await import('../../server/local/' + 'afsim-replay-reader.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { env } = await import('node:' + 'process')
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
const start = '2026-09-24T00:00:00Z', end = '2026-09-24T00:00:01Z'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'wrj-results-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, 'execution'), output = join(entry, 'nested')
  await mkdir(output, { recursive: true })
  const draft: ScenarioDraft = new ScenarioProjection().get('SCN-001').data
  await writeFile(join(entry, 'mapping.json'), JSON.stringify({ scenarioId: draft.config.scenario.id, revision: draft.revision, output: { resolvedDirectory: 'nested' },
    devices: [{ linkId: 'L-FILE', source: { platformId: 'A', deviceId: 'tx' }, target: { platformId: 'B', deviceId: 'rx' }, relay: null }] }))
  await writeFile(join(output, 'scenario_events.csv'), REPORT_EVENT_CSV + '\n')
  await writeFile(join(output, 'position.csv'), POSITION_CSV)
  const results = new LocalMissionResults(join(root, 'results'))
  return { root, entry, output, draft, results }
}

describe('真实仿真结果闭环', () => {
  it.each([true, false])('文件与 WS 接收可发布可筛选快照，重建后仍保留来源；文件变化不能混入（源文件结束标记 %s）', async complete => {
    const { root, output, results } = await setup()
    const eventPath = join(output, 'scenario_events.csv'), positionPath = join(output, 'position.csv')
    if (!complete) await writeFile(eventPath, REPORT_EVENT_CSV.split('\n').filter(line => !line.startsWith('10,SIMULATION_COMPLETE')).join('\n') + '\n')
    const fileSource = playbackFileSource(await readLocalReplay(eventPath, positionPath))
    const run = { runId: 'RUN-WS' as const, taskId: 'TASK-001' as const, scenarioId: fileReceptionScenarioId(fileSource), startedAt: start, fileSource }
    await results.captureFileReception(eventPath, positionPath, run, end, 3780)
    const record = (await results.list())[0]!
    expect(record).toMatchObject({ runId: run.runId, executionSource: 'REMOTE_WS' })
    const reopened = new LocalMissionResults(join(root, 'results'))
    const snapshot = (await reopened.get(record.resultId))!
    expect(snapshot.report.localEvidence!.simulationComplete).toBe(complete)
    expect(snapshot.report.localEvidence!.endTimeS).toBe(3780)
    expect(snapshot.replay.initial.sha256).toBe(fileSource.eventSha256)
    expect((await reopened.filter(record.resultId, snapshot.report.reportId, { from: 3775, to: 3780 })).report.localEvidence!.endTimeS).toBe(3780)
    await writeFile(positionPath, POSITION_CSV + '4,A,-79,32,20,20,175\n')
    await expect(results.captureFileReception(eventPath, positionPath, { ...run, runId: 'RUN-NEW' }, end, 3780)).rejects.toThrow('播放文件已变化')
    expect(await reopened.list()).toHaveLength(1)
    expect(await reopened.get(record.resultId)).toEqual(snapshot)
  })
  it.each([true, false])('入库统一回映射、中文名称与筛选闭合，源 CSV 不变；新包=%s', async marked => {
    const { entry, output, draft, results } = await setup()
    const csvIds = marked ? ['rear_comm_vehicle', 'mission_uav_01'] : ['CMD-01', 'AIR-01']
    const replaceIds = (text: string) => text.replace(/\bA\b/g, csvIds[0]!).replace(/\bB\b/g, csvIds[1]!)
    const events = replaceIds(REPORT_EVENT_CSV).replace(/satcom_[12]/g, 'WSF_RADIO_TRANSCEIVER') + '\n'
    const positions = replaceIds(POSITION_CSV)
    await writeFile(join(output, 'scenario_events.csv'), events)
    await writeFile(join(output, 'position.csv'), positions)
    const manifest = { scenarioId: draft.config.scenario.id, revision: draft.revision, output: { resolvedDirectory: 'nested' },
      ...(marked ? { platformNaming: 'TEMPLATE_INSTANCE' } : {}),
      platforms: [{ platformId: 'CMD-01', name: 'rear_comm_vehicle' }, { platformId: 'AIR-01', name: 'mission_uav_01' }],
      devices: [{ linkId: 'L-FILE', linkType: 'SAT', source: { platformId: csvIds[0], deviceId: 'tx' }, target: { platformId: csvIds[1], deviceId: 'rx' }, relay: null }] }
    const mappingText = JSON.stringify(manifest)
    await writeFile(join(entry, 'mapping.json'), mappingText)
    await results.capture(entry, draft, start, end, () => true, { taskId: 'TASK-MAPPING', runId: 'RUN-MAPPING' })
    const result: MissionResultSnapshot = (await results.get((await results.list())[0]!.resultId))!
    const sortedIds = ['AIR-01', 'CMD-01']
    expect(result.replay.initial.nodes.map(node => node.platformId).sort()).toEqual(sortedIds)
    expect(result.replay.tracks.map(track => track.platformId).sort()).toEqual(sortedIds)
    expect(result.replay.tracks.flatMap(track => track.positions.map(position => position.platformId)).sort()).toEqual(['AIR-01', 'CMD-01', 'CMD-01'])
    expect(result.replay.initial.connections).toEqual([expect.objectContaining({ resolvedType: 'SAT', source: expect.objectContaining({ platformName: 'CMD-01' }), target: expect.objectContaining({ platformName: 'AIR-01' }) })])
    expect(result.replay.initial.deviceEvents?.every(event => sortedIds.includes(event.platformId))).toBe(true)
    expect(result.report.localEvidence!.nodes.map(node => node.platformId).sort()).toEqual(sortedIds)
    if (marked) for (const node of result.report.localEvidence!.nodes) expect(node.name).toBe(draft.config.platforms.find(platform => platform.id === node.platformId)!.name)
    expect(result.report.localEvidence!.connections[0]).toMatchObject({ sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01' })
    const filtered: LocalReportFilterResult = await results.filter(result.record.resultId, result.report.reportId, { nodeId: 'AIR-01', linkId: 'L-FILE' })
    expect(filtered.report.localEvidence!.nodes.map(node => node.platformId)).toEqual(['AIR-01'])
    expect(filtered.timeline.length).toBeGreaterThan(0)
    expect(filtered.timeline.every(event => ['AIR-01', 'CMD-01'].includes(event.subject))).toBe(true)
    const eventHash = createHash('sha256').update(events).digest('hex'), positionHash = createHash('sha256').update(positions).digest('hex')
    expect(result.replay.initial.sha256).toBe(eventHash)
    expect(result.report.localEvidence!.eventFile.sha256).toBe(eventHash)
    expect(result.replay.sha256).toBe(positionHash)
    expect(await readFile(join(output, 'scenario_events.csv'), 'utf8')).toBe(events)
    expect(await readFile(join(output, 'position.csv'), 'utf8')).toBe(positions)
    expect(await readFile(join(entry, 'mapping.json'), 'utf8')).toBe(mappingText)
    const archive = (await readdir(output)).find((name: string) => name.startsWith('time-series-'))!
    const canonical = await readFile(join(output, archive, 'events.csv'), 'utf8')
    expect(canonical).toContain(',CMD-01,')
    expect(canonical).toContain(',AIR-01,')
    expect(canonical).not.toMatch(/rear_comm_vehicle|mission_uav_01/)
  })

  it('完成任务自动留存带 task_id 的事件 CSV，并明确标记缺少的引擎质量文件', async () => {
    const { entry, output, draft, results } = await setup()
    await results.capture(entry, draft, start, end, () => true, { taskId: 'TASK-CAPTURE', runId: 'RUN-CAPTURE' })
    const published = (await readdir(output)).find((name: string) => name.startsWith('time-series-'))!
    expect(published).toBeTruthy()
    const manifest = JSON.parse(await readFile(join(output, published, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ taskId: 'TASK-CAPTURE', runId: 'RUN-CAPTURE', contractsComplete: false })
    expect(manifest.files[0]).toMatchObject({ fileName: 'events.csv', rowCount: 9 })
    expect(await readFile(join(output, published, 'events.csv'), 'utf8')).toContain('TASK-CAPTURE,1.1,')
    expect(await results.list()).toHaveLength(1)
  })

  it('重复执行独立编号；源文件变化、服务重建后仍读取已绑定快照', async () => {
    const { root, entry, output, draft, results } = await setup()
    expect(await results.list()).toEqual([])
    await results.capture(entry, draft, start, end)
    const first = (await results.list())[0]!
    const original = await results.get(first.resultId)
    await writeFile(join(output, 'position.csv'), POSITION_CSV + '4,A,-79,32,20,20,175\n')
    await results.capture(entry, draft, start, end)
    expect(await results.list()).toHaveLength(2)
    expect(new Set((await results.list()).map((r: { resultId: string }) => r.resultId)).size).toBe(2)
    await rm(entry, { recursive: true, force: true })
    expect(await new LocalMissionResults(join(root, 'results')).get(first.resultId)).toEqual(original)
    expect(original.record).toMatchObject({ scenarioId: draft.config.scenario.id, revision: draft.revision, startedAt: start, completedAt: end })
    expect(await results.get('../scenarios.db')).toBeNull()
    await writeFile(join(root, 'results', `${first.resultId}.json`), '{}')
    await expect(results.get(first.resultId)).rejects.toThrow('完整性')
  })

  it('筛选索引与结果来源绑定，按节点和仿真时间精确重算事件及冻结位置', async () => {
    const { root, entry, draft, results } = await setup()
    await results.capture(entry, draft, start, end)
    const record = (await results.list())[0]!, snapshot = (await results.get(record.resultId))!
    const filtered = await results.filter(record.resultId, snapshot.report.reportId, { nodeId: 'A', from: 1, to: 3 })
    expect(filtered.report.localEvidence).toMatchObject({ positionCount: 2, eventCount: filtered.timelineTotal, simulationComplete: false })
    expect(filtered.report.localEvidence?.nodes).toHaveLength(1)
    expect(filtered.report.localEvidence?.nodes[0]?.platformId).toBe('A')
    expect(filtered.timeline.every((event: { time: number; subject: string }) => event.time >= 1 && event.time <= 3 && event.subject === 'A')).toBe(true)
    const nodeOnly = await results.filter(record.resultId, snapshot.report.reportId, { nodeId: 'A' })
    expect(nodeOnly.report.localEvidence?.connections).toEqual([expect.objectContaining({ sourcePlatformId: 'A', targetPlatformId: 'B' })])
    const noPosition = await results.filter(record.resultId, snapshot.report.reportId, { nodeId: 'B', from: 1, to: 3 })
    expect(noPosition.report.localEvidence?.nodes[0]).toMatchObject({ positionCount: 0, firstTimeS: 1, lastTimeS: 1 })
    await expect(results.filter(record.resultId, snapshot.report.reportId, { from: 99 })).rejects.toThrow('FILTER_INVALID')
    const linkFiltered = await results.filter(record.resultId, snapshot.report.reportId, { linkId: 'L-FILE' })
    expect(linkFiltered.links).toEqual(['L-FILE'])
    expect(linkFiltered.report.localEvidence?.nodes.map((node: { platformId: string }) => node.platformId).sort()).toEqual(['A', 'B'])
    const exported = await exportLocalReport(join(root, 'exports'), filtered.report, 'HTML', 'operator', undefined, [], filtered.filter)
    expect(await readFile(exported.filePath, 'utf8')).toContain('已应用筛选')
    expect(await readFile(exported.filePath, 'utf8')).toContain('<svg')
    await writeFile(join(root, 'results', `${record.resultId}.report-index.ndjson`), '{}\n')
    await expect(results.filter(record.resultId, snapshot.report.reportId, {})).rejects.toThrow('FILTER_UNSUPPORTED')
    expect((await results.get(record.resultId))?.report.reportId).toBe(snapshot.report.reportId)
  })

  it('完成时冻结已保存参数；旧三字段快照仍可读且不补造参数', async () => {
    const { root, entry, draft, results } = await setup()
    await results.capture(entry, draft, start, end)
    const first = (await results.list())[0]!, initial = await results.get(first.resultId)
    expect(initial?.parameters).toMatchObject({ scenarioId: draft.config.scenario.id, revision: draft.revision, platformCount: draft.config.platforms.length,
      links: expect.arrayContaining([expect.objectContaining({ id: draft.config.links[0]!.id, txPowerW: draft.config.links[0]!.txPower })]) })
    draft.revision += 1
    draft.config.links[0]!.txPower += 25
    draft.config.jammers[0]!.bandwidth += 5
    await writeFile(join(entry, 'mapping.json'), JSON.stringify({ scenarioId: draft.config.scenario.id, revision: draft.revision, output: { resolvedDirectory: 'nested' } }))
    await results.capture(entry, draft, start, end)
    const snapshots = await Promise.all((await results.list()).map((record: MissionResultRecord) => results.get(record.resultId)))
    const changed = snapshots.find(item => item?.record.revision === draft.revision)
    expect(changed?.parameters).toMatchObject({ revision: draft.revision,
      links: expect.arrayContaining([expect.objectContaining({ txPowerW: initial!.parameters!.links[0]!.txPowerW + 25 })]),
      jammers: expect.arrayContaining([expect.objectContaining({ bandwidthMHz: initial!.parameters!.jammers[0]!.bandwidthMHz + 5 })]) })
    const stored = JSON.parse(await readFile(join(root, 'results', `${first.resultId}.json`), 'utf8'))
    const legacy = JSON.parse(stored.payload); delete legacy.parameters
    const payload = JSON.stringify(legacy)
    await writeFile(join(root, 'results', `${first.resultId}.json`), JSON.stringify({ sha256: createHash('sha256').update(payload).digest('hex'), payload }))
    const legacySnapshot = await new LocalMissionResults(join(root, 'results')).get(first.resultId)
    expect(legacySnapshot).toMatchObject({ record: first })
    expect(legacySnapshot?.parameters).toBeUndefined()
  })

  it('缺失、未完成、跨目录及版本不匹配的结果不发布', async () => {
    const { entry, output, draft, results } = await setup()
    await writeFile(join(output, 'scenario_events.csv'), REPORT_EVENT_CSV.replace(/10,SIMULATION_COMPLETE[^\n]*/, '') + '\n')
    await expect(results.capture(entry, draft, start, end)).rejects.toThrow()
    await writeFile(join(entry, 'mapping.json'), JSON.stringify({ scenarioId: draft.config.scenario.id, revision: draft.revision, output: { resolvedDirectory: '..' } }))
    await expect(results.capture(entry, draft, start, end)).rejects.toThrow('超出')
    await writeFile(join(entry, 'mapping.json'), JSON.stringify({ scenarioId: 'SCN-WRONG', revision: draft.revision, output: { resolvedDirectory: 'nested' } }))
    await expect(results.capture(entry, draft, start, end)).rejects.toThrow('版本')
    expect(await results.list()).toEqual([])
  })

  it.each([
    ['缺失', null],
    ['零字节', ''],
    ['只有表头', 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n'],
    ['全部节点无效', 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n3,UNKNOWN,-79,32,20,20,175\n'],
  ])('已完成 Mission 的位置文件%s时不发布结果或 READY 报告', async (_case, content) => {
    const { output, entry, draft, results } = await setup()
    const position = join(output, 'position.csv')
    if (content === null) await rm(position)
    else await writeFile(position, content)
    await expect(results.capture(entry, draft, start, end)).rejects.toThrow()
    await expect((await import('../../server/local/' + 'report-file.js')).readLocalReport(join(output, 'scenario_events.csv'), position)).rejects.toThrow()
    expect(await results.list()).toEqual([])
  })

  it('已完成 Mission 至少一条合法位置记录时正常发布', async () => {
    const { output, entry, draft, results } = await setup()
    await writeFile(join(output, 'position.csv'), 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n3,A,-79,32,20,20,175\n3,UNKNOWN,-79,32,20,20,175\n')
    await results.capture(entry, draft, start, end)
    const records = await results.list()
    expect(records).toHaveLength(1)
    const snapshot = await results.get(records[0]!.resultId)
    expect(snapshot?.replay).toMatchObject({ recordCount: 1, issueCount: 1 })
    expect(snapshot?.report).toMatchObject({ status: 'READY', localEvidence: { positionCount: 1 } })
  })

  it('认证读取与 HTML/CSV 附件下载绑定同一次结果；拒绝错报告、错来源和无权限', async () => {
    const { root, entry, draft, results } = await setup()
    await results.capture(entry, draft, start, end)
    const first = (await results.list())[0]!
    draft.revision += 1
    draft.config.links[0]!.txPower += 25
    await writeFile(join(entry, 'mapping.json'), JSON.stringify({ scenarioId: draft.config.scenario.id, revision: draft.revision, output: { resolvedDirectory: 'nested' } }))
    await results.capture(entry, draft, start, end)
    const record = (await results.list()).find((item: MissionResultRecord) => item.revision === draft.revision)!
    const snapshot = await results.get(record.resultId)
    const auth = new AuthSqliteStorage(join(root, 'scenarios.db'), 'Results-test-1234')
    cleanup.push(() => auth.close())
    const access: AccessControlConfig = { version: 1, profiles: [], assignments: [] }
    const server = createMockServer({ port: 0, authStorage: auth, missionResults: results,
      accessControlStorage: { load: () => access, save: () => true },
      exportLocalReport: (report: Report, format: 'HTML' | 'PDF' | 'CSV', actor: string, source?: MissionResultRecord, comparisons?: MissionResultParameterComparison[]) => exportLocalReport(join(root, 'exports'), report, format, actor, source, comparisons),
    })
    cleanup.push(() => server.close())
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(server.httpServer)
    const url = `/api/v1/reports/${snapshot.report.reportId}/export?resultId=${record.resultId}&download=1`
    await api.get('/api/v1/mission-results').set(headers).expect(401)
    await api.post(url).set(headers).send({ reportId: snapshot.report.reportId, format: 'HTML' }).expect(401)
    const login = await api.post('/api/v1/auth/login').set(headers).send({ username: 'admin', passwordFixture: 'Results-test-1234' }).expect(200)
    const cookie = login.headers['set-cookie']
    expect((await api.get(`/api/v1/mission-results/${record.resultId}`).set(headers).set('Cookie', cookie).expect(200)).body.data).toEqual(snapshot)
    expect((await api.get(`/api/v1/reports/${snapshot.report.reportId}/filter?resultId=${record.resultId}&nodeId=A`).set(headers).set('Cookie', cookie).expect(200)).body.data.report.localEvidence.nodes).toHaveLength(1)
    await api.get(`/api/v1/reports/${snapshot.report.reportId}/filter?resultId=${record.resultId}&nodeId=A&nodeId=B`).set(headers).set('Cookie', cookie).expect(422)
    for (const format of ['HTML', 'CSV']) {
      const response = await api.post(url).set(headers).set('Cookie', cookie).send({ reportId: snapshot.report.reportId, format }).expect(200)
      expect(response.headers['content-disposition']).toContain(`${record.resultId}.${format.toLowerCase()}`)
      // 跨源 UI 需读取附件头才能确认下载；暴露头须由服务端给出。
      expect(response.headers['access-control-expose-headers']).toBe('Content-Disposition')
      expect(response.text).toContain(record.resultId)
      expect(response.text).toContain(first.resultId)
      expect(response.text).toContain('同场景已完成运行参数对比')
      expect(response.text).toContain(draft.config.scenario.id)
      expect(response.text).toContain(snapshot.replay.sha256)
    }
    await api.post(url + '&archiveId=bad').set(headers).set('Cookie', cookie).send({ reportId: snapshot.report.reportId, format: 'HTML' }).expect(422)
    const wrongReport = `RPT-LOCAL-${'a'.repeat(64)}`
    await api.post(`/api/v1/reports/${wrongReport}/export?resultId=${record.resultId}&download=1`).set(headers).set('Cookie', cookie).send({ reportId: wrongReport, format: 'HTML' }).expect(409)
    await api.get('/api/v1/mission-results/RESULT-00000000-0000-0000-0000-000000000000').set(headers).set('Cookie', cookie).expect(404)
    access.profiles = [{ profileId: 'limited', name: '只读报告', baseRole: 'ADMIN', permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'], menuPaths: ['/reports', '/admin'] }]
    access.assignments = [{ userId: login.body.data.principal.userId, profileId: 'limited' }]
    await api.post(url).set(headers).set('Cookie', cookie).send({ reportId: snapshot.report.reportId, format: 'HTML' }).expect(403)
    access.profiles[0]!.menuPaths = ['/admin']
    await api.get(`/api/v1/mission-results/${record.resultId}`).set(headers).set('Cookie', cookie).expect(403)
    await api.post('/api/v1/auth/logout').set(headers).set('Cookie', cookie).send({ confirm: true }).expect(200)
    await api.post(url).set(headers).set('Cookie', cookie).send({ reportId: snapshot.report.reportId, format: 'HTML' }).expect(401)
  })

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE)('实际引擎 → 结果 → 回放/报告 → 浏览器附件接口', async () => {
    const { root, draft, results } = await setup()
    const c = draft.config
    c.platforms = c.platforms.filter(p => ['CMD-01', 'AIR-01'].includes(p.id))
    c.links = [{ ...c.links[0]!, id: 'L-A', sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', enabled: true }]
    for (const p of c.platforms) { p.waypoints = []; p.linkIds = ['L-A']; p.jammerIds = []; p.sensorIds = [] }
    c.jammers = []; c.sensors = []
    c.informationDemand = [{ ...c.informationDemand[0]!, linkId: 'L-A', sourcePlatformId: 'CMD-01', destinationPlatformIds: ['AIR-01'], direction: 'FORWARD', enabled: false }]
    c.scenario.duration = 3; c.output.writeInterval = 1; c.output.directory = 'custom/results'; c.output.eventsEnabled = true
    c.output.linkQualityEnabled = false; c.output.linkSwitchEnabled = false
    delete c.linkSettings
    draft.uiExtensions = { jammers: [], sensors: [] }
    const server = createMockServer({ port: 0, missionResults: results,
      missionExecution: new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, join(root, 'runs'), results),
      exportLocalReport: (report: unknown, format: string, actor: string, source: unknown) => exportLocalReport(join(root, 'exports'), report, format, actor, source),
    })
    cleanup.push(() => server.close())
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(server.httpServer)
    const saved = (await api.put('/api/v1/scenarios/SCN-001').set(headers).send({ config: c, uiExtensions: draft.uiExtensions, expectedRevision: draft.revision }).expect(200)).body.data
    const created = (await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)).body.data
    const started = (await api.post(`/api/v1/simulations/${created.runId}/commands`).set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)).body.data
    await expect.poll(async () => (await api.get(`/api/v1/simulations/${created.runId}`).set(headers)).body.data.uiStatus, { timeout: 10000 }).not.toBe('RUNNING')
    const finished = (await api.get(`/api/v1/simulations/${created.runId}`).set(headers)).body.data
    const directory = join(root, 'runs', (await readdir(join(root, 'runs')))[0])
    const mapping = JSON.parse(await readFile(join(directory, 'mapping.json'), 'utf8'))
    const parsed = await readAfsimLogFile(join(directory, mapping.output.resolvedDirectory, 'scenario_events.csv'))
    expect(finished, JSON.stringify({ finished, issues: parsed.issues })).toMatchObject({ uiStatus: 'COMPLETED' })
    const records = (await api.get('/api/v1/mission-results').set(headers).expect(200)).body.data
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ revision: saved.revision, startedAt: started.startedAt })
    const snapshot = (await api.get(`/api/v1/mission-results/${records[0].resultId}`).set(headers).expect(200)).body.data
    expect(parsed.nodes.map((node: { name: string }) => node.name).sort()).toEqual(['mission_uav_01', 'rear_comm_vehicle'])
    expect(snapshot.replay.initial.nodes.map((node: { platformId: string }) => node.platformId).sort()).toEqual(['AIR-01', 'CMD-01'])
    expect(snapshot.report.localEvidence.nodes.map((node: { platformId: string }) => node.platformId).sort()).toEqual(['AIR-01', 'CMD-01'])
    expect(snapshot.replay.tracks.length).toBeGreaterThan(0)
    expect(snapshot.report.localEvidence.simulationComplete).toBe(true)
    expect(snapshot.report.localEvidence.positionFile.sha256).toBe(snapshot.replay.sha256)
    const download = await api.post(`/api/v1/reports/${snapshot.report.reportId}/export?resultId=${records[0].resultId}&download=1`).set(headers).send({ reportId: snapshot.report.reportId, format: 'HTML' }).expect(200)
    expect(download.text).toContain(records[0].resultId)
    expect(download.text).toContain('CMD-01')
  })
})

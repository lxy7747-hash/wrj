// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { POSITION_CSV } from '../fixtures/local-replay'
import type { ScenarioDraft, AccessControlConfig } from '../../src/contracts/domain-models'
const { mkdtemp, mkdir, readFile, writeFile, rm, readdir } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { default: request } = await import('super' + 'test')
const { LocalMissionResults } = await import('../../server/local/' + 'mission-results.js')
const { LocalMissionRunner } = await import('../../server/local/' + 'mission-runner.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { AuthSqliteStorage } = await import('../../server/local/' + 'auth-sqlite.js')
const { exportLocalReport } = await import('../../server/local/' + 'report-file.js')
const { readAfsimLogFile } = await import('../../server/local/' + 'afsim-log-reader.js')
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
  await writeFile(join(entry, 'mapping.json'), JSON.stringify({ scenarioId: draft.config.scenario.id, revision: draft.revision, output: { resolvedDirectory: 'nested' } }))
  await writeFile(join(output, 'scenario_events.csv'), REPORT_EVENT_CSV + '\n')
  await writeFile(join(output, 'position.csv'), POSITION_CSV)
  const results = new LocalMissionResults(join(root, 'results'))
  return { root, entry, output, draft, results }
}

describe('真实仿真结果闭环', () => {
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
    const record = (await results.list())[0]!
    const snapshot = await results.get(record.resultId)
    const auth = new AuthSqliteStorage(join(root, 'scenarios.db'), 'Results-test-1234')
    cleanup.push(() => auth.close())
    const access: AccessControlConfig = { version: 1, profiles: [], assignments: [] }
    const server = createMockServer({ port: 0, authStorage: auth, missionResults: results,
      accessControlStorage: { load: () => access, save: () => true },
      exportLocalReport: (report: unknown, format: string, actor: string, source: unknown) => exportLocalReport(join(root, 'exports'), report, format, actor, source),
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
    for (const format of ['HTML', 'CSV']) {
      const response = await api.post(url).set(headers).set('Cookie', cookie).send({ reportId: snapshot.report.reportId, format }).expect(200)
      expect(response.headers['content-disposition']).toContain(`${record.resultId}.${format.toLowerCase()}`)
      expect(response.text).toContain(record.resultId)
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
    expect(snapshot.replay.tracks.length).toBeGreaterThan(0)
    expect(snapshot.report.localEvidence.simulationComplete).toBe(true)
    expect(snapshot.report.localEvidence.positionFile.sha256).toBe(snapshot.replay.sha256)
    const download = await api.post(`/api/v1/reports/${snapshot.report.reportId}/export?resultId=${records[0].resultId}&download=1`).set(headers).send({ reportId: snapshot.report.reportId, format: 'HTML' }).expect(200)
    expect(download.text).toContain(records[0].resultId)
    expect(download.text).toContain('CMD-01')
  })
})

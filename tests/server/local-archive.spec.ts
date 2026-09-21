// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { INITIAL_LOG, POSITION_CSV } from '../fixtures/local-replay'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import type { Report, AuditRecord } from '../../src/contracts/domain-models'
const { mkdtemp, writeFile, rm, readFile } = await import('node:fs/' + 'promises')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { DatabaseSync } = await import('node:' + 'sqlite')
const { once } = await import('node:' + 'events')
const { default: request } = await import('super' + 'test')
const { ArchiveSqliteStorage } = await import('../../server/local/' + 'archive-sqlite.js')
const { readLocalReplay } = await import('../../server/local/' + 'afsim-replay-reader.js')
const { readLocalReport, exportLocalReport } = await import('../../server/local/' + 'report-file.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const dirs: string[] = []
const stores: InstanceType<typeof ArchiveSqliteStorage>[] = []
const servers: ReturnType<typeof createMockServer>[] = []
const admin = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'wrj-archive-test-')); dirs.push(dir)
  const event = join(dir, 'events.csv'), position = join(dir, 'position.csv'), path = join(dir, 'archives.db')
  await writeFile(event, INITIAL_LOG); await writeFile(position, POSITION_CSV)
  const store = new ArchiveSqliteStorage(path); stores.push(store)
  return { dir, event, position, path, store }
}
describe('真实归档独立持久化', () => {
  it('新事件 CSV 的登记、设备和消息证据可持久化重读', async () => {
    const { event, position, store } = await setup()
    await writeFile(event, REPORT_EVENT_CSV)
    const replay = await readLocalReplay(event, position)
    const report = (await readLocalReport(event, position))!
    const record = store.register('新格式快照', 'admin', replay, report)
    const archived = store.get(record.archiveId)!
    expect(archived.replay).toEqual(replay)
    expect(archived.replay.initial.connections).toHaveLength(1)
    expect(archived.replay.initial.deviceEvents).toHaveLength(2)
    expect(archived.report.localEvidence?.eventCounts).toContainEqual({ type: 'MESSAGE_RECEIVED', count: 1 })
  })
  it('空库、原子登记、幂等、两份来源隔离、源文件覆盖及重启后保持', async () => {
    const { event, position, path, store } = await setup()
    expect(store.list()).toEqual([])
    const replay = await readLocalReplay(event, position), report = (await readLocalReport(event, position))!
    const a = store.register('快照甲', 'admin', replay, report)
    expect(store.register('重复名称', 'admin', replay, report)).toEqual(a)
    await writeFile(position, POSITION_CSV + '10,A,-80,33,21,20,175\n')
    const b = store.register('快照乙', 'admin', await readLocalReplay(event, position), (await readLocalReport(event, position))!)
    expect(b.archiveId).not.toBe(a.archiveId)
    expect(b.durationS).toBe(10)
    await writeFile(event, 'broken'); await rm(position)
    expect(store.get(a.archiveId)?.replay).toEqual(replay)
    expect(store.get(a.archiveId)?.report).toEqual(report)
    expect(store.get(a.archiveId)?.record).not.toHaveProperty('scenarioId')
    const reopened = new ArchiveSqliteStorage(path); stores.push(reopened)
    expect(reopened.list()).toEqual([b, a])
    expect(reopened.get(b.archiveId)?.replay.durationS).toBe(10)
    expect(reopened.get('bad')).toBeNull()
    expect(reopened.get(`ARCH-LOCAL-${'0'.repeat(64)}`)).toBeNull()
  })
  it('跨文件版本拒绝、损坏拒绝、不产生假成功', async () => {
    const { event, position, path, store } = await setup()
    const replay = await readLocalReplay(event, position), report = (await readLocalReport(event, position))!
    const wrong = structuredClone(replay); wrong.sha256 = 'f'.repeat(64)
    expect(() => store.register('bad', 'admin', wrong, report)).toThrow()
    expect(store.list()).toEqual([])
    const row = store.register('完整', 'admin', replay, report)
    const db = new DatabaseSync(path)
    try { db.prepare('UPDATE local_archives SET payload=?').run('{}') } finally { db.close() }
    expect(() => store.get(row.archiveId)).toThrow('完整性')
    expect(() => store.list()).toThrow()
  })
  it('真实 API 登记、权限、归档读取和导出不再访问最新源', async () => {
    const { dir, event, position, store } = await setup()
    const server = createMockServer({ port: 0, archiveStorage: store,
      loadLocalReplay: () => readLocalReplay(event, position), loadLocalReport: () => readLocalReport(event, position),
      exportLocalReport: (report: Report, format: 'HTML' | 'CSV', actor: string) => exportLocalReport(dir, report, format, actor) })
    servers.push(server)
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(server.httpServer), base = '/api/v1/admin/local-archives'
    expect((await api.get(base).set(admin)).body.data).toEqual([])
    for (const role of ['OPERATOR', 'INVALID']) {
      expect((await api.post(base).set({ ...admin, 'X-Demo-Role': role }).send({ name: '拒绝' })).status).toBe(403)
      expect((await api.get(base).set({ ...admin, 'X-Demo-Role': role })).status).toBe(403)
    }
    for (const body of [{ name: '' }, { name: ' ' }, { name: 'a'.repeat(81) }, { name: '伪造', scenarioId: 'SCN-001' }]) expect((await api.post(base).set(admin).send(body)).status).toBe(422)
    const created = await api.post(base).set(admin).send({ name: '归档甲' })
    expect(created.status).toBe(201)
    const record = created.body.data
    const archived = (await api.get(`/api/v1/archives/${record.archiveId}`).set({ ...admin, 'X-Demo-Role': 'OPERATOR' })).body.data
    expect(archived.record).toEqual(record)
    await writeFile(event, 'broken')
    expect((await api.get(`/api/v1/archives/${record.archiveId}`).set(admin)).body.data).toEqual(archived)
    const exported = await api.post(`/api/v1/reports/${record.reportId}/export?archiveId=${record.archiveId}`).set(admin).send({ reportId: record.reportId, format: 'HTML' })
    expect(exported.status).toBe(200)
    expect(await readFile(exported.body.data.filePath, 'utf8')).toContain(record.reportId)
    expect((await api.post(base).set(admin).send({ name: '失败' })).status).toBe(503)
    expect(store.list()).toHaveLength(1)
    expect((await api.get('/api/v1/archives/bad').set(admin)).status).toBe(422)
    expect((await api.get(`/api/v1/archives/ARCH-LOCAL-${'0'.repeat(64)}`).set(admin)).status).toBe(404)
    expect(server.auditSnapshot().some((row: AuditRecord) => row.action === 'ARCHIVE_CREATE' && row.result === 'SUCCESS')).toBe(true)
  })
  it('未配置真实存储时空目录，登记失败；相对路径拒绝', async () => {
    expect(() => new ArchiveSqliteStorage('relative.db')).toThrow('绝对路径')
    const server = createMockServer({ port: 0 }); servers.push(server)
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(server.httpServer)
    expect((await api.get('/api/v1/admin/local-archives').set(admin)).body.data).toEqual([])
    expect((await api.post('/api/v1/admin/local-archives').set(admin).send({ name: 'test' })).status).toBe(503)
  })
})

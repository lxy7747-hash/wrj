// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import type { AuditRecord } from '../../src/contracts/domain-models'
const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { DatabaseSync } = await import('node:' + 'sqlite')
const { default: request } = await import('super' + 'test')
const { createMockServer } = await import('../../server/' + 'app.js')
const { AuthSqliteStorage } = await import('../../server/local/' + 'auth-sqlite.js')

const origin = 'http://127.0.0.1:5173'
const password = 'Test-only-password-2026!'
const closers: Array<() => Promise<void>> = []

afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })

async function mockServer() {
  const server = createMockServer({ port: 0 })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  closers.push(() => server.close())
  return { server, api: request(server.httpServer), admin: { Origin: origin, 'X-Demo-Role': 'ADMIN' } }
}

async function sqliteServer(directory: string) {
  const storage = new AuthSqliteStorage(join(directory, 'audit.db'), password, () => Date.parse('2026-09-12T03:04:05Z'))
  const server = createMockServer({ port: 0, authStorage: storage })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  closers.push(async () => { await server.close(); storage.close() })
  const api = request(server.httpServer)
  const login = await api.post('/api/v1/auth/login').set('Origin', origin).send({ username: 'admin', passwordFixture: password }).expect(200)
  return { storage, api, admin: { Origin: origin, Cookie: login.headers['set-cookie'][0].split(';')[0] } }
}

it('sorts and pages filtered mock audit rows, and rejects invalid deletion without partial mutation', async () => {
  const { server, api, admin } = await mockServer()
  await api.get('/api/v1/admin/health').set(admin).expect(200)
  await api.get('/api/v1/admin/equipment').set(admin).expect(200)
  const defaultPage = await api.get('/api/v1/admin/audit').set(admin).expect(200)
  const expectedDescending = [...server.auditSnapshot() as AuditRecord[]].sort((left, right) => {
    const byTime = Date.parse(right.occurredAt as string) - Date.parse(left.occurredAt as string)
    return byTime === 0 ? String(right.auditId).localeCompare(String(left.auditId)) : byTime
  })
  expect(defaultPage.body.meta).toMatchObject({ page: 1, pageSize: 20, total: expectedDescending.length })
  expect(defaultPage.body.data.map((row: { auditId: string }) => row.auditId)).toEqual(expectedDescending.slice(0, 20).map(row => row.auditId))
  const descending = await api.get('/api/v1/admin/audit').set(admin).query({ pageSize: 1 }).expect(200)
  const ascending = await api.get('/api/v1/admin/audit').set(admin).query({ page: 1, pageSize: 1, sortOrder: 'asc' }).expect(200)
  expect(descending.body.meta).toMatchObject({ page: 1, pageSize: 1, total: expect.any(Number) })
  const secondAscending = await api.get('/api/v1/admin/audit').set(admin).query({ page: 2, pageSize: 1, sortOrder: 'asc' }).expect(200)
  const expectedAscending = [...expectedDescending].reverse()
  expect([ascending.body.data[0].auditId, secondAscending.body.data[0].auditId]).toEqual(expectedAscending.slice(0, 2).map(row => row.auditId))
  const filtered = await api.get('/api/v1/admin/audit').set(admin).query({ action: 'HEALTH_READ', sortOrder: 'asc' }).expect(200)
  expect(filtered.body.data.every((row: { action: string }) => row.action === 'HEALTH_READ')).toBe(true)
  const target = descending.body.data[0].auditId as string
  const before = server.auditSnapshot()
  await api.post('/api/v1/admin/audit/delete').set(admin).send({ auditIds: [target, 'AUD-MISSING'] }).expect(404)
  expect(server.auditSnapshot()).toEqual(before)
  for (const auditIds of [[], [' '], [target, target], Array.from({ length: 101 }, (_, index) => `AUD-${index}`)]) {
    await api.post('/api/v1/admin/audit/delete').set(admin).send({ auditIds }).expect(400)
  }
  await api.post('/api/v1/admin/audit/delete').set(admin).send({ auditIds: [target], extra: true }).expect(400)
  await api.post('/api/v1/admin/audit/delete').set({ ...admin, 'X-Demo-Role': 'OPERATOR' }).send({ auditIds: [target] }).expect(403)
  for (const query of [{ page: 0 }, { page: '1.5' }, { pageSize: 101 }, { sortOrder: 'sideways' }, { action: ['HEALTH_READ', 'AUDIT_LIST'] }, { unexpected: 'x' }]) {
    await api.get('/api/v1/admin/audit').set(admin).query(query).expect(400)
  }
})

it('atomically deletes persisted audit rows and retains the deletion evidence after reopening SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-audit-management-'))
  try {
    const first = await sqliteServer(directory)
    first.storage.appendAudit({ actor: 'admin', role: 'ADMIN', module: 'AUDIT', action: 'AUDIT_TEST_A', result: 'SUCCESS', occurredAt: first.storage.time(), immutableFixture: true })
    first.storage.appendAudit({ actor: 'admin', role: 'ADMIN', module: 'AUDIT', action: 'AUDIT_TEST_B', result: 'SUCCESS', occurredAt: first.storage.time(), immutableFixture: true })
    const ids = (first.storage.readAudit() as AuditRecord[]).filter(row => row.action.startsWith('AUDIT_TEST')).map(row => row.auditId)
    const firstId = ids[0]
    if (firstId === undefined) throw new Error('test setup did not write audit records')
    const normalizedMismatch = firstId.replace(/(\d+)$/, '0$1')
    await first.api.post('/api/v1/admin/audit/delete').set(first.admin).send({ auditIds: [normalizedMismatch] }).expect(404)
    await first.api.post('/api/v1/admin/audit/delete').set(first.admin).send({ auditIds: [firstId, 'AUD-LOCAL-999999'] }).expect(404)
    expect((first.storage.readAudit() as AuditRecord[]).filter(row => ids.includes(row.auditId))).toHaveLength(ids.length)
    const deleted = await first.api.post('/api/v1/admin/audit/delete').set(first.admin).send({ auditIds: ids }).expect(200)
    expect(deleted.body.data).toEqual({ deletedIds: ids })
    expect((first.storage.readAudit() as AuditRecord[]).some(row => ids.includes(row.auditId))).toBe(false)
    expect(first.storage.readAudit().at(-1)).toMatchObject({ action: 'AUDIT_DELETE', objectId: 'AUDIT-LOG', result: 'SUCCESS' })
    const evidenceId = (first.storage.readAudit() as AuditRecord[]).at(-1)?.auditId
    if (evidenceId === undefined) throw new Error('test setup did not retain deletion evidence')
    const db = new DatabaseSync(join(directory, 'audit.db'))
    db.exec("CREATE TRIGGER reject_audit_delete BEFORE INSERT ON audit_logs WHEN NEW.action = 'AUDIT_DELETE' BEGIN SELECT RAISE(ABORT, 'test-only'); END")
    db.close()
    await first.api.post('/api/v1/admin/audit/delete').set(first.admin).send({ auditIds: [evidenceId] }).expect(500)
    expect((first.storage.readAudit() as AuditRecord[]).some(row => row.auditId === evidenceId)).toBe(true)
    expect((first.storage.readAudit() as AuditRecord[]).filter(row => row.action === 'AUDIT_DELETE')).toHaveLength(1)
    for (const close of closers.splice(0).reverse()) await close()
    const reopened = new AuthSqliteStorage(join(directory, 'audit.db'), password)
    try {
      expect((reopened.readAudit() as AuditRecord[]).some(row => ids.includes(row.auditId))).toBe(false)
      expect(reopened.readAudit().at(-1)).toMatchObject({ action: 'AUDIT_DELETE', result: 'SUCCESS' })
    } finally { reopened.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

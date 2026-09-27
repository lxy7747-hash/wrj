// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditRecord } from '../../src/contracts/domain-models'

const storagePath = '../../server/local/' + 'auth-sqlite.js'
const serverPath = '../../server/' + 'app.js'
const { AuthSqliteStorage } = await import(storagePath)
const projectionPath = '../../server/auth/' + 'projection.js'
const { AuthProjection } = await import(projectionPath)
const { createMockServer } = await import(serverPath)
const { mkdtemp, rm, readFile } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { DatabaseSync } = await import('node:' + 'sqlite')
const { default: request } = await import('super' + 'test')
const { WebSocket } = await import('w' + 's')
const PASSWORD = 'Test-only-password-2026!'
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
let directory = ''
let path = ''
const cleanups: Array<() => void | Promise<void>> = []
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'wrj-auth-test-')); path = join(directory, 'app.db') })
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); await rm(directory, { recursive: true, force: true }) })

async function start(now?: () => number, extra: NonNullable<Parameters<typeof createMockServer>[0]> = {}) {
  const storage = new AuthSqliteStorage(path, PASSWORD, now)
  cleanups.push(() => storage.close())
  const server = createMockServer({ ...extra, authStorage: storage })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  cleanups.push(() => server.close())
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  const api = request(base)
  const login = async (username = 'admin', password = PASSWORD) => {
    const result = await api.post('/api/v1/auth/login').set(headers).send({ username, passwordFixture: password })
    expect(result.status).toBe(200)
    expect(result.headers['x-auth-mode']).toBe('sqlite')
    expect(result.headers['access-control-expose-headers']).toBe('X-Auth-Mode')
    expect(result.body.data.sessionCreated).toBe(true)
    expect(result.headers['set-cookie'][0]).toContain('HttpOnly')
    expect(result.headers['set-cookie'][0]).toContain('SameSite=Strict')
    return result.headers['set-cookie'][0].split(';')[0] as string
  }
  return { storage, server, api, login, base }
}

describe('SQLite authentication', () => {
  it('用户名写入拒绝空值、超长和首尾空格，不触碰已有账号', async () => {
    const { api, login, storage } = await start()
    const cookie = await login()
    const admin = { ...headers, Cookie: cookie }
    const user = { userId: 'USR-NAME', username: 'valid-name', role: 'OPERATOR', status: 'ACTIVE' }
    await api.post('/api/v1/admin/users').set(admin).send({ operation: 'CREATE', user, password: PASSWORD }).expect(201)
    const before = storage.list()
    for (const username of ['', ' leading', 'trailing ', 'x'.repeat(65)]) {
      const invalid = { ...user, username }
      const created = await api.post('/api/v1/admin/users').set(admin)
        .send({ operation: 'CREATE', user: { ...invalid, userId: 'USR-INVALID' }, password: PASSWORD }).expect(400)
      expect(created.body.error.fieldPath).toBe('user.username')
      const updated = await api.put('/api/v1/admin/users/USR-NAME').set(admin)
        .send({ operation: 'UPDATE', user: invalid }).expect(400)
      expect(updated.body.error.fieldPath).toBe('user.username')
      expect(storage.list()).toEqual(before)
    }
  })

  it('管理请求不能改写最后登录时间，成功登录才更新服务端字段', async () => {
    const { api, login, storage } = await start(() => Date.parse('2026-09-27T10:00:00Z'))
    const admin = { ...headers, Cookie: await login() }
    const user = { userId: 'USR-TIME', username: 'time-user', role: 'OPERATOR', status: 'ACTIVE', lastLoginAt: '2000-01-01T00:00:00Z' }
    const created = await api.post('/api/v1/admin/users').set(admin)
      .send({ operation: 'CREATE', user, password: PASSWORD }).expect(201)
    expect(created.body.data.lastLoginAt).toBeUndefined()
    expect(storage.list().find((item: { userId: string }) => item.userId === user.userId)?.lastLoginAt).toBeUndefined()
    await login('time-user')
    const loggedInAt = storage.list().find((item: { userId: string }) => item.userId === user.userId)?.lastLoginAt
    expect(loggedInAt).toBe('2026-09-27T10:00:00.000Z')
    const updated = await api.put('/api/v1/admin/users/USR-TIME').set(admin)
      .send({ operation: 'UPDATE', user: { ...user, lastLoginAt: '2001-01-01T00:00:00Z' } }).expect(200)
    expect(updated.body.data.lastLoginAt).toBe(loggedInAt)
    expect(storage.list().find((item: { userId: string }) => item.userId === user.userId)?.lastLoginAt).toBe(loggedInAt)
  })

  it('交错完成的两个账号请求分别归属审计和一次性确认', async () => {
    let releaseWrite!: (path: string) => void
    let enteredWrite!: () => void
    const entered = new Promise<void>(resolve => { enteredWrite = resolve })
    const pendingWrite = new Promise<string>(resolve => { releaseWrite = resolve })
    const { api, login, storage } = await start(undefined, {
      writeScriptText: async () => { enteredWrite(); return pendingWrite },
    })
    storage.save({ userId: 'USR-SECOND-ADMIN', username: 'second-admin', role: 'ADMIN', status: 'ACTIVE' }, PASSWORD)
    const firstCookie = await login()
    const secondCookie = await login('second-admin')
    const asUser = (cookie: string) => ({ ...headers, Cookie: cookie })
    const draft = (await api.get('/api/v1/scenarios/SCN-001').set(asUser(firstCookie)).expect(200)).body.data
    draft.config.scenario.environment.rainLossDbPerKm = 0.08
    for (const platform of draft.config.platforms) if (platform.type === 'COMMUNICATION_SATELLITE') platform.satelliteType = 'TIANTONG'
    await api.put('/api/v1/scenarios/SCN-001').set(asUser(firstCookie))
      .send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: draft.revision }).expect(200)
    const script = (await api.post('/api/v1/scripts/preview').set(asUser(firstCookie))
      .send({ scenarioId: 'SCN-001' }).expect(200)).body.data
    const writing = api.post(`/api/v1/scripts/${script.scriptId}/local-file`).set(asUser(firstCookie))
      .send({ checksum: script.checksum }).then((response: { status: number }) => response)
    await entered
    await api.get('/api/v1/admin/users').set(asUser(secondCookie)).expect(200)
    expect(storage.readAudit().find((record: AuditRecord) => record.action === 'USER_LIST')?.actor).toBe('second-admin')
    const second = (await api.post('/api/v1/confirmations').set(asUser(secondCookie))
      .send({ action: 'AUDIT_EXPORT', objectId: 'AUDIT-LOG' }).expect(201)).body.data
    releaseWrite('C:/test-only/mission.txt')
    await expect(writing).resolves.toMatchObject({ status: 200 })
    expect(storage.readAudit().find((record: AuditRecord) => record.action === 'SCRIPT_FILE_WRITE' && record.result === 'SUCCESS')?.actor).toBe('admin')
    expect(second.actor).toBe('second-admin')

    const first = (await api.post('/api/v1/confirmations').set(asUser(firstCookie))
      .send({ action: 'AUDIT_EXPORT', objectId: 'AUDIT-LOG' }).expect(201)).body.data
    await api.post(`/api/v1/confirmations/${first.confirmationId}`).set(asUser(secondCookie)).send({ confirm: true }).expect(403)
    await api.post(`/api/v1/confirmations/${first.confirmationId}`).set(asUser(firstCookie)).send({ confirm: true }).expect(200)
    await api.post('/api/v1/admin/audit/export').set(asUser(secondCookie))
      .send({ export: true, confirmationId: first.confirmationId }).expect(403)
    await api.post('/api/v1/admin/audit/export').set(asUser(firstCookie))
      .send({ export: true, confirmationId: first.confirmationId }).expect(200)
    expect(storage.readAudit().filter((record: AuditRecord) => record.action === 'AUDIT_EXPORT').map((record: AuditRecord) => [record.actor, record.result]))
      .toEqual(expect.arrayContaining([['second-admin', 'DENIED'], ['admin', 'SUCCESS']]))
  })
  it('验证兼容既有哈希且不阻塞事件循环，最多两个在途验证并在完成后释放容量', async () => {
    const { storage, api } = await start()
    let completed = false
    const first = storage.verify('admin', PASSWORD).then((value: boolean) => { completed = true; return value })
    const second = storage.verify('admin', 'wrong')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(completed).toBe(false)
    expect(storage.allowLogin()).toBe(false)
    expect(await storage.verify('admin', PASSWORD)).toBe(false)
    await api.post('/api/v1/auth/login').set(headers).send({ username: 'admin', passwordFixture: PASSWORD }).expect(429)
    expect(await Promise.all([first, second])).toEqual([true, false])
    expect(storage.allowLogin()).toBe(true)
    expect(await storage.verify('missing-user', PASSWORD)).toBe(false)
    expect(await storage.verify('admin', PASSWORD)).toBe(true)
  })

  it.each(['disable', 'delete', 'revoke', 'restore', 'rename', 'password'])('在途登录遇到 %s 后不能签发会话或写回旧账号', async action => {
    const { storage, api } = await start()
    const verify = storage.verify.bind(storage)
    const spy = vi.spyOn(storage, 'verify').mockImplementation((username, password) => {
      const pending = verify(username, password)
      const user = storage.list()[0]
      if (action === 'disable') storage.save({ ...user, status: 'DISABLED' })
      if (action === 'delete') storage.delete(user.userId)
      if (action === 'revoke') storage.revokeUser(user.userId)
      if (action === 'restore') storage.revokeAllSessions()
      if (action === 'rename') storage.save({ ...user, username: 'renamed' })
      if (action === 'password') {
        const db = new DatabaseSync(path)
        try { db.prepare('UPDATE users SET password_hash=? WHERE user_id=?').run('00'.repeat(32), user.userId) }
        finally { db.close() }
      }
      return pending
    })
    try {
      const result = await api.post('/api/v1/auth/login').set(headers).send({ username: 'admin', passwordFixture: PASSWORD })
      expect(result.status).toBe(401)
      expect(result.headers['set-cookie']).toBeUndefined()
      expect(storage.list()[0]?.lastLoginAt).toBeUndefined()
      if (action === 'disable') expect(storage.list()[0].status).toBe('DISABLED')
      if (action === 'delete') expect(storage.list()).toHaveLength(0)
    } finally { spy.mockRestore() }
  })

  it('关闭数据库后在途验证安全失效，不读取已关闭连接', async () => {
    const storage = new AuthSqliteStorage(path, PASSWORD)
    const pending = storage.verify('admin', PASSWORD)
    storage.close()
    expect(await pending).toBe(false)
    expect(await storage.verify('admin', PASSWORD)).toBe(false)
  })

  it('投影重置使在途登录失效，但不修改已有账号', async () => {
    const { storage } = await start()
    const projection = new AuthProjection(storage)
    const pending = projection.login({ username: 'admin', passwordFixture: PASSWORD })
    projection.reset()
    expect(await pending).toMatchObject({ ok: false, status: 401 })
    expect(storage.list()[0].lastLoginAt).toBeUndefined()
  })

  it('rejects whitespace passwords at initialization, storage and HTTP creation without adding accounts', async () => {
    expect(() => { const unexpected = new AuthSqliteStorage(path, ' '.repeat(12)); unexpected.close() }).toThrow(/不能全为空白/)
    const { api, login, storage } = await start()
    const cookie = await login()
    const before = storage.list()
    const user = { userId: 'USR-BLANK', username: 'blank', role: 'OPERATOR', status: 'ACTIVE' }
    for (const password of ['      ', '\t\n    ']) {
      const result = await api.post('/api/v1/admin/users').set(headers).set('Cookie', cookie).send({ operation: 'CREATE', user, password })
      expect(result.status).toBe(400)
      expect(result.body.error).toMatchObject({ fieldPath: 'password', message: expect.stringContaining('不能全为空白') })
      expect(() => storage.save(user, password)).toThrow(/不能全为空白/)
      expect(new AuthProjection(storage).create({ operation: 'CREATE', user, password })).toMatchObject({ ok: false, code: 'INVALID_REQUEST', fieldPath: 'password' })
      expect(storage.list()).toEqual(before)
    }
  })

  it('preserves leading and trailing spaces for bootstrap and new-account passwords', async () => {
    const bootstrap = '  bootstrap-password  '
    const initial = new AuthSqliteStorage(path, bootstrap)
    initial.close()
    const { api, login, storage } = await start()
    const cookie = await login('admin', bootstrap)
    const user = { userId: 'USR-SPACED', username: 'spaced', role: 'OPERATOR', status: 'ACTIVE' }
    const password = '  secret  '
    await api.post('/api/v1/admin/users').set(headers).set('Cookie', cookie).send({ operation: 'CREATE', user, password }).expect(201)
    await login(user.username, password)
    expect(await storage.verify(user.username, password.trim())).toBe(false)
  })

  it.each([5, 6, 32, 33, 128])('enforces the new-account password boundary at %i characters', async (length) => {
    const { api, login, storage } = await start()
    const cookie = await login()
    const before = storage.list()
    const user = { userId: 'USR-BOUNDARY', username: 'boundary-user', role: 'OPERATOR', status: 'ACTIVE' }
    const password = 'x'.repeat(length)
    const allowed = length >= 6 && length <= 32
    await api.post('/api/v1/admin/users').set(headers).set('Cookie', cookie)
      .send({ operation: 'CREATE', user, password }).expect(allowed ? 201 : 400)
    if (allowed) {
      expect(await storage.verify(user.username, password)).toBe(true)
      await login(user.username, password)
    } else {
      expect(() => storage.save(user, password)).toThrow('密码须为 6–32 位。')
      expect(storage.list()).toEqual(before)
    }
  })

  it('keeps an existing 128-character password usable after reopening', async () => {
    const previousPassword = 'p'.repeat(128)
    const previous = new AuthSqliteStorage(path, previousPassword)
    previous.close()
    const { login, storage } = await start()
    await login('admin', previousPassword)
    expect(await storage.verify('admin', previousPassword)).toBe(true)
  })

  it('rejects deletion of the authenticated account even with two active administrators', async () => {
    const { api, login, storage } = await start()
    const firstCookie = await login()
    const first = storage.list()[0]
    const second = { userId: 'USR-SECOND', username: 'second-admin', role: 'ADMIN', status: 'ACTIVE' }
    await api.post('/api/v1/admin/users').set(headers).set('Cookie', firstCookie)
      .send({ operation: 'CREATE', user: second, password: PASSWORD }).expect(201)
    const secondCookie = await login(second.username)
    const before = storage.list()
    for (const [cookie, userId] of [[firstCookie, first.userId], [secondCookie, second.userId]]) {
      const result = await api.delete(`/api/v1/admin/users/${userId}`).set(headers).set('Cookie', cookie).expect(409)
      expect(result.body.error.code).toBe('LAST_ADMIN_GUARD')
      expect(storage.list()).toEqual(before)
    }
    await api.delete(`/api/v1/admin/users/${second.userId}`).set(headers).set('Cookie', firstCookie).expect(200)
    expect(storage.list()).toHaveLength(1)
  })

  it('exports filtered SQLite records with current identity/time, an empty result, and a persisted export audit', async () => {
    const { api, login, storage } = await start(() => Date.parse('2026-09-11T06:01:57.327Z'))
    const cookie = await login()
    await api.post('/api/v1/auth/login').set(headers).send({ username: 'admin', passwordFixture: 'wrong' }).expect(401)
    const records = storage.readAudit()
    const confirm = async () => {
      const created = await api.post('/api/v1/confirmations').set(headers).set('Cookie', cookie)
        .send({ action: 'AUDIT_EXPORT', objectId: 'AUDIT-LOG' }).expect(201)
      const id = created.body.data.confirmationId
      await api.post(`/api/v1/confirmations/${id}`).set(headers).set('Cookie', cookie).send({ confirm: true }).expect(200)
      return id
    }
    const id = await confirm()
    const result = await api.post('/api/v1/admin/audit/export').set(headers).set('Cookie', cookie)
      .send({ export: true, confirmationId: id, actor: 'admin', role: 'ADMIN', module: 'AUTHENTICATION', result: 'ERROR',
        from: '2026-09-11T06:00:00Z', to: '2026-09-11T06:02:00Z' }).expect(200)
    expect(result.body.data).toMatchObject({ generated: true, recordCount: 1, verifiedAt: '2026-09-11T06:01:57.327Z', watermark: '内部使用 · admin · AUDIT-LOG' })
    expect(result.body.data.content).toContain(records[1].auditId)
    expect(result.body.data.content).not.toContain(records[0].auditId)
    expect(result.body.data.content).not.toContain('THRESHOLD_UPDATE')
    expect(result.body.data.content).not.toContain(PASSWORD)
    expect(result.body.data.content).toContain('2026-09-11 14:01:57')
    expect(storage.readAudit().at(-1)).toMatchObject({ action: 'AUDIT_EXPORT', result: 'SUCCESS', actor: 'admin' })
    expect(storage.readAudit().slice(0, records.length)).toEqual(records)
    await api.post('/api/v1/admin/audit/export').set(headers).set('Cookie', cookie).send({ export: true, confirmationId: id }).expect(409)
    expect(storage.readAudit().at(-1)).toMatchObject({ action: 'AUDIT_EXPORT', result: 'DENIED' })
    const emptyId = await confirm()
    const empty = await api.post('/api/v1/admin/audit/export').set(headers).set('Cookie', cookie)
      .send({ export: true, confirmationId: emptyId, actor: 'does-not-exist' }).expect(200)
    expect(empty.body.data.recordCount).toBe(0)
    expect(empty.body.data.content).toContain('记录数量：0')
    const failId = await confirm()
    const read = vi.spyOn(storage, 'readAudit').mockImplementationOnce(() => { throw new Error('db unavailable') })
    const failed = await api.post('/api/v1/admin/audit/export').set(headers).set('Cookie', cookie)
      .send({ export: true, confirmationId: failId }).expect(400)
    expect(failed.body.data).toBeUndefined()
    read.mockRestore()
    expect(storage.readAudit().at(-1)).toMatchObject({ action: 'AUDIT_EXPORT', result: 'ERROR' })
  })

  it('starts with no demonstration audit and retains real records and unique IDs across reset and restart', async () => {
    const first = await start()
    expect(first.server.auditSnapshot()).toEqual([])
    const cookie = await first.login()
    expect((await first.api.post('/api/v1/auth/login').set(headers).send({ username: 'admin', passwordFixture: 'wrong' })).status).toBe(401)
    const initial = first.server.auditSnapshot()
    expect(initial.map((row: { result: string }) => row.result)).toEqual(['SUCCESS', 'ERROR'])
    const filtered = await first.api.get('/api/v1/admin/audit').query({ actor: 'admin', module: 'AUTHENTICATION', result: 'ERROR' }).set(headers).set('Cookie', cookie)
    expect(filtered.status).toBe(200)
    expect(filtered.body.data).toEqual([initial[1]])
    expect((await first.api.post('/api/v1/reset').set(headers).set('Cookie', cookie).send({ confirm: true })).status).toBe(200)
    expect(first.server.auditSnapshot()).toEqual(expect.arrayContaining(initial))
    const beforeRestart = first.server.auditSnapshot()
    await first.server.close()
    const second = await start()
    expect(second.server.auditSnapshot()).toEqual(beforeRestart)
    const currentCookie = await second.login()
    await second.api.post('/api/v1/auth/logout').set(headers).set('Cookie', currentCookie).send({ confirm: true })
    const audit = second.server.auditSnapshot()
    expect(audit.at(-1)).toMatchObject({ actor: 'admin', action: 'AUTH_LOGOUT', objectId: 'USR-ADMIN', result: 'SUCCESS' })
    expect(new Set(audit.map((row: { auditId: string }) => row.auditId)).size).toBe(audit.length)
    expect(audit.every((row: { auditId: string }) => row.auditId.startsWith('AUD-LOCAL-'))).toBe(true)
    expect(JSON.stringify(audit)).not.toContain(PASSWORD)
  })

  it('persists malformed login, logout, session, role and rate-limit denials without trusting client identity', async () => {
    const { api, login, server, storage } = await start()
    const cookie = await login()
    const operator = { userId: 'USR-W', username: 'worker', role: 'OPERATOR', status: 'ACTIVE' }
    await api.post('/api/v1/admin/users').set(headers).set('Cookie', cookie).send({ operation: 'CREATE', user: operator, password: PASSWORD })
    const worker = await login('worker')
    await api.get('/api/v1/auth/permissions').set(headers).set('Cookie', worker).expect(200)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ actor: 'worker', role: 'OPERATOR', action: 'AUTH_PERMISSIONS', result: 'SUCCESS' })
    expect((await api.get('/api/v1/admin/audit').set(headers).set('Cookie', worker)).status).toBe(403)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ actor: 'worker', role: 'OPERATOR', result: 'DENIED', action: 'AUDIT_LIST' })
    await api.post('/api/v1/auth/logout').set(headers).set('Cookie', worker).send({ confirm: true })
    expect(server.auditSnapshot().at(-1)).toMatchObject({ actor: 'worker', objectId: 'USR-W', action: 'AUTH_LOGOUT', result: 'SUCCESS' })
    expect((await api.get('/api/v1/admin/users').set(headers).set('Cookie', worker)).status).toBe(401)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ actor: 'anonymous', role: 'OPERATOR', action: 'AUTH_SESSION_DENIED', result: 'DENIED' })
    await api.post('/api/v1/auth/logout').set(headers).send({ confirm: true })
    expect(server.auditSnapshot().at(-1)).toMatchObject({ actor: 'anonymous', action: 'AUTH_LOGOUT', result: 'DENIED' })
    await api.post('/api/v1/auth/login').set(headers).send({ username: 'admin' })
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'AUTH_LOGIN', result: 'ERROR' })
    await api.post('/api/v1/auth/login').set(headers).set('Content-Type', 'application/json').send('{')
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'AUTH_LOGIN', result: 'ERROR' })
    await api.post('/api/v1/auth/login').set(headers).send({ padding: 'x'.repeat(256 * 1024) }).expect(400)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ actor: 'anonymous', action: 'AUTH_LOGIN', result: 'ERROR' })
    await api.post('/api/v1/auth/logout').set(headers).set('Cookie', cookie)
      .set('Content-Type', 'application/json').send('{').expect(400)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ actor: 'admin', action: 'AUTH_LOGOUT', result: 'ERROR' })
    await api.post('/api/v1/auth/logout').set(headers).set('Cookie', cookie)
      .send({ padding: 'x'.repeat(256 * 1024) }).expect(400)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ actor: 'admin', action: 'AUTH_LOGOUT', result: 'ERROR' })
    await api.post('/api/v1/auth/logout').set(headers).set('Cookie', cookie).send({ confirm: false })
    expect(server.auditSnapshot().at(-1)).toMatchObject({ actor: 'admin', action: 'AUTH_LOGOUT', result: 'ERROR' })
    await api.get('/api/v1/admin/audit').set({ ...headers, Origin: 'https://evil.example' })
    expect(server.auditSnapshot().at(-1)).toMatchObject({ actor: 'anonymous', action: 'AUTH_LOOPBACK_DENIED', result: 'DENIED' })
    for (let index = 0; index < 30; index++) storage.allowLogin()
    expect((await api.post('/api/v1/auth/login').set(headers).send({ username: 'admin', passwordFixture: PASSWORD })).status).toBe(429)
    expect(server.auditSnapshot().at(-1)).toMatchObject({ action: 'AUTH_LOGIN_RATE_LIMITED', result: 'DENIED' })
    const db = new DatabaseSync(path)
    expect(Number(db.prepare('SELECT count(*) AS count FROM audit_logs').get().count)).toBe(server.auditSnapshot().length)
    db.close()
  })

  it('does not return success or fixture data when audit storage fails', async () => {
    const { api, login, storage } = await start()
    const cookie = await login()
    const db = new DatabaseSync(path)
    db.exec("CREATE TRIGGER deny_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'test-only storage failure'); END")
    const rejected = await api.post('/api/v1/auth/login').set(headers).send({ username: 'admin', passwordFixture: PASSWORD })
    expect(rejected.status).toBe(500)
    expect(rejected.body.ok).toBe(false)
    expect(JSON.stringify(rejected.body)).not.toContain('test-only storage failure')
    expect(rejected.headers['set-cookie']).toBeUndefined()
    expect(storage.readAudit()).toHaveLength(1)
    db.exec('DROP TABLE audit_logs')
    const unreadable = await api.get('/api/v1/admin/audit').set(headers).set('Cookie', cookie)
    expect(unreadable.status).toBe(500)
    expect(unreadable.body.ok).toBe(false)
    expect(unreadable.body.data).toBeUndefined()
    expect(JSON.stringify(unreadable.body)).not.toContain('SQLITE_ERROR')
    db.close()
  })

  it('persists salted hashes and account changes without touching existing scenes/templates; restart requires login', async () => {
    const existing = new DatabaseSync(path)
    existing.exec("CREATE TABLE scenarios(id TEXT); INSERT INTO scenarios VALUES('keep-scene'); CREATE TABLE scenario_templates(id TEXT); INSERT INTO scenario_templates VALUES('keep-template')")
    existing.close()
    const first = await start()
    const cookie = await first.login()
    const user = { userId: 'USR-NEW', username: 'new-admin', role: 'ADMIN', status: 'ACTIVE' }
    expect((await first.api.post('/api/v1/admin/users').set(headers).set('Cookie', cookie).send({ operation: 'CREATE', user, password: PASSWORD })).status).toBe(201)
    const nextCookie = await first.login('new-admin')
    expect((await first.api.get('/api/v1/auth/session').set(headers).set('Cookie', nextCookie)).body.data.principal.username).toBe('new-admin')
    await first.server.close()
    const second = await start()
    expect((await second.api.get('/api/v1/admin/users').set(headers).set('Cookie', nextCookie)).status).toBe(401)
    await second.login('new-admin')
    const db = new DatabaseSync(path)
    expect(db.prepare('SELECT id FROM scenarios').get().id).toBe('keep-scene')
    expect(db.prepare('SELECT id FROM scenario_templates').get().id).toBe('keep-template')
    const rows = db.prepare('SELECT * FROM users').all()
    expect(rows[0].password_hash).not.toBe(rows[1].password_hash)
    expect(rows[0].password_salt).not.toBe(rows[1].password_salt)
    expect(rows.every((row: Record<string, unknown>) => typeof row.last_login_at === 'string')).toBe(true)
    db.close()
    expect((await readFile(path)).includes(PASSWORD)).toBe(false)
  })

  it('rejects role spoofing for HTTP and WebSocket; logout revokes both transports', async () => {
    const { api, login, base, server } = await start()
    expect((await api.get('/api/v1/admin/users').set(headers)).status).toBe(401)
    expect((await api.get('/api/v1/auth/session').set(headers)).body.data.authenticated).toBe(false)
    const cookie = await login()
    const operator = { userId: 'USR-OP', username: 'worker', role: 'OPERATOR', status: 'ACTIVE' }
    await api.post('/api/v1/admin/users').set(headers).set('Cookie', cookie).send({ operation: 'CREATE', user: operator, password: PASSWORD })
    const worker = await login('worker')
    expect((await api.get('/api/v1/admin/users').set(headers).set('Cookie', worker)).status).toBe(403)
    const anonymous = new WebSocket(base.replace('http:', 'ws:') + '/ws/v1?role=ADMIN', { headers })
    const rejected = once(anonymous, 'message')
    expect(JSON.parse(String((await rejected)[0])).type).toBe('rejected')
    expect(server.auditSnapshot().at(-1)).toMatchObject({ actor: 'anonymous', action: 'AUTH_WS_DENIED', result: 'DENIED' })
    anonymous.terminate()
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws/v1?role=ADMIN', { headers: { ...headers, Cookie: worker } })
    await once(socket, 'open')
    const closed = once(socket, 'close')
    expect((await api.post('/api/v1/auth/logout').set(headers).set('Cookie', worker).send({ confirm: true })).status).toBe(200)
    expect((await closed)[0]).toBe(1008)
    expect((await api.get('/api/v1/scenarios').set(headers).set('Cookie', worker)).status).toBe(401)
    const listing = await api.get('/api/v1/admin/users').set(headers).set('Cookie', cookie)
    expect(JSON.stringify(listing.body)).not.toContain('password')
  })

  it('rejects wrong passwords, disabled/locked users and expired sessions; keeps last admin protected', async () => {
    let time = 1_800_000_000_000
    const { api, login, storage } = await start(() => time)
    expect((await api.post('/api/v1/auth/login').set(headers).send({ username: 'admin', passwordFixture: 'wrong' })).status).toBe(401)
    const cookie = await login()
    const admin = storage.list()[0]
    expect((await api.delete(`/api/v1/admin/users/${admin.userId}`).set(headers).set('Cookie', cookie)).status).toBe(409)
    const user = { userId: 'USR-A', username: 'another', role: 'OPERATOR', status: 'ACTIVE' }
    const create = (password?: string) => api.post('/api/v1/admin/users').set(headers).set('Cookie', cookie).send({ operation: 'CREATE', user, ...(password ? { password } : {}) })
    expect((await create()).status).toBe(400)
    expect((await create('short')).status).toBe(400)
    expect((await create(PASSWORD)).status).toBe(201)
    expect((await create(PASSWORD)).status).toBe(409)
    const previous = await login('another')
    expect((await api.put('/api/v1/admin/users/USR-A').set(headers).set('Cookie', cookie).send({ operation: 'DISABLE', user })).status).toBe(200)
    expect((await api.get('/api/v1/scenarios').set(headers).set('Cookie', previous)).status).toBe(401)
    expect((await api.post('/api/v1/auth/login').set(headers).send({ username: 'another', passwordFixture: PASSWORD })).status).toBe(401)
    await api.put('/api/v1/admin/users/USR-A').set(headers).set('Cookie', cookie).send({ operation: 'UPDATE', user: { ...user, status: 'LOCKED' } })
    expect((await api.post('/api/v1/auth/login').set(headers).send({ username: 'another', passwordFixture: PASSWORD })).status).toBe(423)
    await api.post('/api/v1/reset').set(headers).set('Cookie', cookie).send({ confirm: true })
    expect(storage.list().find((item: { userId: string }) => item.userId === 'USR-A').status).toBe('LOCKED')
    time += 8 * 60 * 60 * 1000
    expect((await api.get('/api/v1/admin/users').set(headers).set('Cookie', cookie)).status).toBe(401)
  })

  it('bounds login attempts, rejects foreign origins, and never falls back on invalid bootstrap', async () => {
    expect(() => new AuthSqliteStorage(path)).toThrow(/AUTH_BOOTSTRAP_PASSWORD/)
    const { api, storage } = await start()
    expect((await api.post('/api/v1/auth/login').set({ ...headers, Origin: 'https://evil.example' }).send({ username: 'admin', passwordFixture: PASSWORD })).status).toBe(403)
    for (let index = 0; index < 30; index++) expect(storage.allowLogin()).toBe(true)
    expect((await api.post('/api/v1/auth/login').set(headers).send({ username: 'admin', passwordFixture: PASSWORD })).status).toBe(429)
    expect((await api.post('/api/v1/auth/logout').set(headers).send({ confirm: false })).status).toBe(400)
  })
})

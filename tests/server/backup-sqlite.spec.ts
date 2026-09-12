// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { BackupSqliteStorage } = await import('../../server/local/' + 'backup-sqlite.js')
const { AuthSqliteStorage } = await import('../../server/local/' + 'auth-sqlite.js')
const { ScenarioSqliteStorage } = await import('../../server/local/' + 'scenario-sqlite.js')
const { TemplateSqliteStorage } = await import('../../server/local/' + 'template-sqlite.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { TemplateProjection } = await import('../../server/templates/' + 'projection.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { DatabaseSync } = await import('node:' + 'sqlite')
const { createHash } = await import('node:' + 'crypto')
const { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } = await import('node:' + 'fs')
const { default: fs } = await import('node:' + 'fs')
const { syncBuiltinESMExports } = await import('node:' + 'module')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { once } = await import('node:' + 'events')
const { default: request } = await import('super' + 'test')
const password = 'Backup-test-only-2026!'
const headers = { Origin: 'http://127.0.0.1:5173' }
let directory = ''
const cleanup: Array<() => void | Promise<void>> = []
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'wrj-backup-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const close of cleanup.splice(0).reverse()) await close()
  rmSync(directory, { recursive: true, force: true })
})

function setup() {
  const path = join(directory, 'app.db')
  const auth = new AuthSqliteStorage(path, password)
  const scenes = new ScenarioSqliteStorage(path)
  const templates = new TemplateSqliteStorage(path)
  const draft = new ScenarioProjection().get('SCN-001').data
  const template = new TemplateProjection().list()[0]
  scenes.save(draft, undefined)
  // 固定旧模板兼容读取，不经当前写入校验修改夹具。
  const db = new DatabaseSync(path)
  db.prepare('INSERT INTO scenario_templates VALUES (?, ?, ?, ?, ?, ?, ?)').run(template.templateId, template.name, Number(template.version), 1, JSON.stringify(template.config), null, 0)
  const backups = new BackupSqliteStorage(path)
  cleanup.push(() => auth.close(), () => scenes.close(), () => templates.close(), () => db.close(), () => backups.close())
  return { path, auth, scenes, templates, db, backups }
}

it('快照校验失败清理本次未登记文件，修复数据后同 ID 可重试', () => {
  const { db, backups } = setup()
  const file = join(backups.directory, 'RETRY.db')
  db.exec('CREATE TABLE unexpected (id TEXT)')
  expect(backups.backup('RETRY')).toMatchObject({ ok: false, status: 503 })
  expect(existsSync(file)).toBe(false)
  expect(backups.listBackups()).toEqual([])
  db.exec('DROP TABLE unexpected')
  expect(backups.backup('RETRY')).toMatchObject({ ok: true, data: { backupId: 'RETRY' } })
})

it('目录登记被锁时清理孤儿文件，解锁后同 ID 重试成功', () => {
  const { backups } = setup()
  const writer = new DatabaseSync(join(backups.directory, 'catalog.db'))
  writer.exec('BEGIN IMMEDIATE')
  try {
    expect(backups.backup('RETRY')).toMatchObject({ ok: false, status: 503 })
    expect(existsSync(join(backups.directory, 'RETRY.db'))).toBe(false)
    expect(backups.listBackups()).toEqual([])
  } finally { writer.exec('ROLLBACK'); writer.close() }
  expect(backups.backup('RETRY')).toMatchObject({ ok: true, data: { backupId: 'RETRY', status: 'VALID' } })
  expect(backups.listBackups()).toHaveLength(1)
})

it.each([true, false])('已有同名文件（已登记=%s）不被清理或覆盖', registered => {
  const { backups } = setup()
  const file = join(backups.directory, 'EXISTING.db')
  if (registered) expect(backups.backup('EXISTING').ok).toBe(true)
  else writeFileSync(file, 'existing unregistered backup')
  const before = readFileSync(file)
  const unlink = vi.spyOn(fs, 'unlinkSync')
  syncBuiltinESMExports()
  expect(backups.backup('EXISTING')).toMatchObject({ ok: false, status: 409 })
  const writer = new DatabaseSync(join(backups.directory, 'catalog.db'))
  writer.exec('BEGIN EXCLUSIVE')
  try { expect(backups.backup('EXISTING')).toMatchObject({ ok: false, status: 503 }) }
  finally { writer.exec('ROLLBACK'); writer.close() }
  expect(readFileSync(file)).toEqual(before)
  expect(unlink).not.toHaveBeenCalled()
})

it('补偿删除失败明确报告残留编号与处置提示，不假报成功', () => {
  const { db, backups } = setup()
  const file = join(backups.directory, 'RESIDUAL.db')
  db.exec('CREATE TABLE unexpected (id TEXT)')
  const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw new Error('file busy') })
  syncBuiltinESMExports()
  expect(backups.backup('RESIDUAL')).toMatchObject({ ok: false, status: 503,
    message: expect.stringMatching(/RESIDUAL\.db.*残留.*核对/) })
  expect(unlink).toHaveBeenCalledExactlyOnceWith(file)
  expect(existsSync(file)).toBe(true)
  expect(backups.listBackups()).toEqual([])
})

it('真实备份含所有表、SHA-256、WAL 已提交数据，目录重开后保留且不导入演示记录', () => {
  const { path, db, backups } = setup()
  db.exec('PRAGMA journal_mode = WAL')
  expect(backups.listBackups()).toEqual([])
  const result = backups.backup('CHECKPOINT')
  expect(result).toMatchObject({ ok: true, data: { backupId: 'CHECKPOINT', status: 'VALID', checksum: expect.stringMatching(/^[A-F0-9]{64}$/) } })
  const file = join(backups.directory, 'CHECKPOINT.db')
  expect(readFileSync(file).subarray(0, 16).toString()).toBe('SQLite format 3\0')
  const snapshot = new DatabaseSync(file, { readOnly: true })
  try {
    expect(snapshot.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok')
    for (const table of ['scenarios', 'scenario_templates', 'users', 'audit_logs']) {
      expect(snapshot.prepare(`SELECT * FROM ${table}`).all()).toEqual(db.prepare(`SELECT * FROM ${table}`).all())
    }
  } finally { snapshot.close() }
  const reopened = new BackupSqliteStorage(path)
  try { expect(reopened.listBackups()).toEqual([result.data]) } finally { reopened.close() }
  expect(backups.backup('CHECKPOINT')).toMatchObject({ ok: false, status: 409 })
  expect(backups.backup('../outside')).toMatchObject({ ok: false, status: 422 })
  expect(existsSync(join(directory, 'outside.db'))).toBe(false)
})

it('恢复真实场景、模板和账号，保留当前审计及恢复前快照；已打开连接读取恢复结果', () => {
  const { db, auth, scenes, templates, backups } = setup()
  const original = Object.fromEntries(['scenarios', 'scenario_templates', 'users'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]))
  expect(backups.backup('SOURCE').ok).toBe(true)
  db.exec('DELETE FROM scenarios; DELETE FROM scenario_templates')
  auth.save({ userId: 'USR-NEW', username: 'new-user', role: 'OPERATOR', status: 'ACTIVE' }, '123456')
  auth.appendAudit({ actor: 'admin', role: 'ADMIN', module: 'BACKUP_RESTORE', action: 'AFTER_BACKUP', result: 'SUCCESS', occurredAt: auth.time(), immutableFixture: true })
  const audit = auth.readAudit()
  const result = backups.restore('SOURCE')
  expect(result).toMatchObject({ ok: true, data: { result: 'SUCCESS', integrityValid: true, generated: true, rolledBack: false, progress: 100 } })
  for (const table of ['scenarios', 'scenario_templates', 'users']) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(original[table])
  expect(scenes.list()).toHaveLength(1)
  expect(templates.load()).toHaveLength(1)
  expect(auth.verify('admin', password)).toBe(true)
  expect(auth.readAudit()).toEqual(audit)
  const prebackup = new DatabaseSync(join(backups.directory, `${result.data.prebackupId}.db`), { readOnly: true })
  try { expect(prebackup.prepare('SELECT count(*) AS n FROM scenarios').get().n).toBe(0) } finally { prebackup.close() }
  expect(backups.listBackups()).toHaveLength(2)
})

it.each(['corrupt', 'missing', 'schema', 'no-admin'])('%s 备份拒绝恢复，先创建真实预备份且数据库不变', mode => {
  const { db, backups } = setup()
  backups.backup('SOURCE')
  const path = join(backups.directory, 'SOURCE.db')
  if (mode === 'corrupt') writeFileSync(path, 'corrupt')
  if (mode === 'missing') rmSync(path)
  if (mode === 'schema' || mode === 'no-admin') {
    const snapshot = new DatabaseSync(path)
    snapshot.exec(mode === 'schema' ? 'ALTER TABLE users ADD COLUMN unexpected TEXT' : "UPDATE users SET status = 'DISABLED'")
    snapshot.close()
    // 同步摘要模拟结构不兼容的历史目录，确保不只依赖文件哈希拒绝。
    const catalog = new DatabaseSync(join(backups.directory, 'catalog.db'))
    catalog.prepare('UPDATE backups SET checksum = ?').run(createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase())
    catalog.close()
  }
  const before = db.prepare('SELECT * FROM users').all()
  expect(backups.restore('SOURCE')).toMatchObject({ ok: true, data: { result: 'FAILURE', integrityValid: false, rolledBack: false, generated: true } })
  expect(db.prepare('SELECT * FROM users').all()).toEqual(before)
  expect(backups.listBackups()).toHaveLength(2)
  expect(backups.restore('UNKNOWN')).toMatchObject({ ok: false, status: 404 })
})

it.each(['INSERT INTO main.users SELECT * FROM restore_source.users', 'COMMIT'])('%s 失败时事务回滚，所有表和预备份保留，可重试成功', failedSql => {
  const { db, backups } = setup()
  backups.backup('SOURCE')
  db.exec('DELETE FROM scenarios')
  const before = db.prepare('SELECT * FROM users').all()
  const exec = DatabaseSync.prototype.exec
  const fail = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof DatabaseSync>, ...args: unknown[]) {
    const sql = args[0]
    if (sql === failedSql) throw new Error('disk failure')
    return exec.call(this, sql)
  })
  expect(backups.restore('SOURCE')).toMatchObject({ ok: true, data: { result: 'FAILURE', integrityValid: true, rolledBack: true } })
  expect(db.prepare('SELECT * FROM scenarios').all()).toEqual([])
  expect(db.prepare('SELECT * FROM users').all()).toEqual(before)
  expect(backups.listBackups()).toHaveLength(2)
  fail.mockRestore()
  expect(backups.restore('SOURCE')).toMatchObject({ ok: true, data: { result: 'SUCCESS' } })
})

it('预备份失败及外部写锁拒绝恢复，不触及业务数据', () => {
  const { path, db, backups } = setup()
  backups.backup('SOURCE')
  const before = db.prepare('SELECT * FROM scenarios').all()
  const prebackup = vi.spyOn(backups, 'backup').mockReturnValueOnce({ ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: 'disk full' })
  expect(backups.restore('SOURCE')).toMatchObject({ ok: false, status: 503 })
  prebackup.mockRestore()
  const writer = new DatabaseSync(path)
  writer.exec('BEGIN EXCLUSIVE')
  try { expect(backups.restore('SOURCE')).toMatchObject({ ok: false, status: 503 }) }
  finally { writer.exec('ROLLBACK'); writer.close() }
  expect(db.prepare('SELECT * FROM scenarios').all()).toEqual(before)
})

it('HTTP 管理员真实备份/恢复需一次性确认，操作员及匿名拒绝，恢复后旧会话失效', async () => {
  const { auth, scenes, templates, backups, db } = setup()
  auth.save({ userId: 'USR-OP', username: 'operator', role: 'OPERATOR', status: 'ACTIVE' }, '123456')
  const server = createMockServer({ authStorage: auth, scenarioStorage: scenes, templateStorage: templates, backupStorage: backups })
  cleanup.push(() => server.close())
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(server.httpServer)
  const login = async (username: string, secret: string) => {
    const response = await api.post('/api/v1/auth/login').set(headers).send({ username, passwordFixture: secret }).expect(200)
    return response.headers['set-cookie'][0].split(';')[0]
  }
  const cookie = await login('admin', password)
  const operator = await login('operator', '123456')
  for (const path of ['backups', 'backup', 'restore']) {
    const call = (cookie?: string) => {
      const req = path === 'backups' ? api.get(`/api/v1/admin/${path}`) : api.post(`/api/v1/admin/${path}`).send({ operation: path.toUpperCase(), backupId: 'SOURCE' })
      req.set(headers)
      if (cookie) req.set('Cookie', cookie)
      return req
    }
    await call().expect(401)
    await call(operator).expect(403)
  }
  expect((await api.get('/api/v1/admin/backups').set(headers).set('Cookie', cookie)).body.data).toEqual([])
  await api.post('/api/v1/admin/backup').set(headers).set('Cookie', cookie).send({ operation: 'BACKUP' }).expect(428)
  const confirm = async (objectId: string) => {
    const created = await api.post('/api/v1/confirmations').set(headers).set('Cookie', cookie).send({ action: 'BACKUP_RESTORE', objectId }).expect(201)
    const id = created.body.data.confirmationId
    await api.post(`/api/v1/confirmations/${id}`).set(headers).set('Cookie', cookie).send({ confirm: true }).expect(200)
    return id
  }
  const confirmationId = await confirm('BACKUP:SOURCE')
  const command = { operation: 'BACKUP', backupId: 'SOURCE', confirmationId }
  await api.post('/api/v1/admin/backup').set(headers).set('Cookie', cookie).send(command).expect(200)
  await api.post('/api/v1/admin/backup').set(headers).set('Cookie', cookie).send(command).expect(409)
  db.exec('DELETE FROM scenarios')
  await api.post('/api/v1/admin/restore').set(headers).set('Cookie', cookie).send({ operation: 'RESTORE', backupId: 'SOURCE' }).expect(428)
  const restored = await api.post('/api/v1/admin/restore').set(headers).set('Cookie', cookie).send({ operation: 'RESTORE', backupId: 'SOURCE', confirmationId: await confirm('RESTORE:SOURCE') }).expect(200)
  expect(restored.body.data).toMatchObject({ generated: true, result: 'SUCCESS' })
  expect(scenes.list()).toHaveLength(1)
  await api.get('/api/v1/admin/backups').set(headers).set('Cookie', cookie).expect(401)
  expect(auth.readAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'BACKUP_RESTORE', result: 'SUCCESS' })]))
})

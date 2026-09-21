// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { createBackupFixture } from '../fixtures/system-backup'
const { DatabaseSync } = await import('node:' + 'sqlite')
const { join } = await import('node:' + 'path')
const { existsSync, readFileSync, writeFileSync } = await import('node:' + 'fs')
const { createHash } = await import('node:' + 'crypto')
const { RuntimeConfigSqliteStorage } = await import('../../server/local/' + 'runtime-config-sqlite.js')
const { SystemBackupSqliteStorage } = await import('../../server/local/' + 'system-backup-sqlite.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const { once } = await import('node:' + 'events')

let fixture: ReturnType<typeof createBackupFixture> | undefined
afterEach(() => { fixture?.close(); fixture = undefined; vi.restoreAllMocks(); vi.useRealTimers() })
const setup = () => (fixture = createBackupFixture())

it('六库备份恢复真实内容、历史、引用、归档和白名单配置，现有连接可重载；审计不回退', () => {
  const f = setup()
  expect(f.backup.backup('ALL', '全部业务备份')).toMatchObject({ ok: true, data: { name: '全部业务备份', format: 'SYSTEM_SQLITE_V1' } })
  const master = f.master.load()[0]!
  expect(f.master.save({ ...master, version: 2, content: { ...master.content!, name: '新名称' } }, 1)).toBe(true)
  const radio = f.equipment.load()[0]!
  expect(f.equipment.save({ ...radio, version: 2, modulation: 'QPSK' }, 1)).toBe(true)
  const originalConfig = f.settings.load()
  const configDb = new DatabaseSync(join(f.directory, 'runtime-config.db'))
  configDb.prepare('UPDATE runtime_config SET value=?').run(JSON.stringify({ eventPath: null, positionPath: null }))
  configDb.close()
  f.auth.save({ userId: 'USER-LATER', username: 'later', role: 'OPERATOR', status: 'ACTIVE' }, '123456')
  const archiveDb = new DatabaseSync(join(f.directory, 'archives.db'))
  archiveDb.exec('DELETE FROM local_archives'); archiveDb.close()
  f.auth.appendAudit({ actor: 'admin', role: 'ADMIN', module: 'BACKUP_RESTORE', action: 'AFTER', result: 'SUCCESS', occurredAt: f.auth.time(), immutableFixture: true })
  const audit = f.auth.readAudit()
  expect(f.backup.restore('ALL')).toMatchObject({ ok: true, data: { result: 'SUCCESS', generated: true, integrityValid: true, progress: 100 } })
  expect(f.master.load()[0]?.version).toBe(1)
  expect(f.master.details('DICT-TEST').history).toHaveLength(1)
  expect(f.master.details('DICT-TEST').references).toHaveLength(1)
  expect(f.equipment.load()[0]?.version).toBe(1)
  expect(f.archive.get(f.archived.archiveId)?.record.name).toBe('测试归档')
  expect(f.settings.load()).toEqual(originalConfig)
  expect(f.auth.readAudit()).toEqual(audit)
  expect(f.backup.listBackups()).toHaveLength(2)
  const reopened = new SystemBackupSqliteStorage(f.path)
  try { expect(reopened.listBackups()).toHaveLength(2) } finally { reopened.close() }
})

it('同名备份不覆盖，非法编号或名称拒绝，现有文件不删除', () => {
  const f = setup()
  expect(f.backup.backup('../bad')).toMatchObject({ ok: false, status: 422 })
  expect(f.backup.backup('A', '  ')).toMatchObject({ ok: false, status: 422 })
  const file = join(f.backup.directory, 'A.system.db')
  writeFileSync(file, 'existing')
  expect(f.backup.backup('A')).toMatchObject({ ok: false, status: 409 })
  expect(readFileSync(file, 'utf8')).toBe('existing')
  expect(f.backup.backup('B').ok).toBe(true)
  expect(f.backup.backup('B')).toMatchObject({ ok: false, status: 409 })
})

it('目录登记失败补偿本次文件，解锁后同编号重试成功', () => {
  const f = setup()
  const catalog = new DatabaseSync(join(f.backup.directory, 'catalog.db'))
  catalog.exec('BEGIN IMMEDIATE')
  try {
    expect(f.backup.backup('RETRY')).toMatchObject({ ok: false, status: 503 })
    expect(existsSync(join(f.backup.directory, 'RETRY.system.db'))).toBe(false)
  } finally { catalog.exec('ROLLBACK'); catalog.close() }
  expect(f.backup.backup('RETRY').ok).toBe(true)
})

it('损坏备份不可恢复，保留恢复前备份和当前数据；未知编号明确拒绝', () => {
  const f = setup()
  f.backup.backup('CORRUPT')
  writeFileSync(join(f.backup.directory, 'CORRUPT.system.db'), 'broken')
  expect(f.backup.listBackups()[0]?.status).toBe('INVALID')
  expect(f.backup.restore('CORRUPT')).toMatchObject({ ok: true, data: { result: 'FAILURE', integrityValid: false, rolledBack: false } })
  expect(f.master.load()[0]?.content?.name).toBe('测试字典')
  expect(f.backup.listBackups()).toHaveLength(2)
  expect(f.backup.restore('UNKNOWN')).toMatchObject({ ok: false, status: 404 })
})

it('恢复中后序库插入失败，前序库修改一起回滚', () => {
  const f = setup()
  f.backup.backup('ROLLBACK')
  const master = f.master.load()[0]!
  f.master.save({ ...master, version: 2 }, 1)
  const db = new DatabaseSync(join(f.directory, 'runtime-config.db'))
  db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON runtime_config BEGIN SELECT RAISE(ABORT, 'test-only'); END")
  try { expect(f.backup.restore('ROLLBACK')).toMatchObject({ ok: true, data: { result: 'FAILURE', integrityValid: true, rolledBack: true } }) }
  finally { db.exec('DROP TRIGGER fail_restore'); db.close() }
  expect(f.master.load()[0]?.version).toBe(2)
  expect(f.backup.restore('ROLLBACK')).toMatchObject({ ok: true, data: { result: 'SUCCESS' } })
})

it('WAL 数据可以一致性备份，但拒绝无跨库断电保证的恢复；占用时不假成功', () => {
  const f = setup()
  const db = new DatabaseSync(join(f.directory, 'equipment.db'))
  db.exec('PRAGMA journal_mode=WAL')
  expect(f.backup.backup('WAL').ok).toBe(true)
  expect(f.backup.restore('WAL')).toMatchObject({ ok: false, status: 503, message: expect.stringContaining('WAL') })
  db.exec('BEGIN IMMEDIATE')
  try { expect(f.backup.backup('BUSY')).toMatchObject({ ok: false, status: 503 }) }
  finally { db.exec('ROLLBACK'); db.close() }
})

it.each(['missing', 'schema', 'master', 'access', 'secret', 'archive', 'equipment', 'scenario', 'account'])('摘要合法但业务内容 %s 损坏也拒绝恢复', mode => {
  const f = setup()
  f.backup.backup('EDITED')
  const path = join(f.backup.directory, 'EDITED.system.db')
  const snapshot = new DatabaseSync(path)
  const tables = JSON.parse(String(snapshot.prepare('SELECT payload FROM snapshot').get()?.payload))
  if (mode === 'missing') tables.pop()
  if (mode === 'schema') tables[0].sql = 'CREATE TABLE evil(x)'
  if (mode === 'master') tables.find((row: { table: string }) => row.table === 'master_data').rows[0].data_json = '{}'
  if (mode === 'access') tables.find((row: { table: string }) => row.table === 'access_control').rows[0].config = '{}'
  if (mode === 'secret') tables.find((row: { table: string }) => row.table === 'runtime_config').rows[0].value = '{"AUTH_BOOTSTRAP_PASSWORD":"bad"}'
  if (mode === 'archive') tables.find((row: { table: string }) => row.table === 'local_archives').rows[0].checksum = 'bad'
  if (mode === 'equipment') tables.find((row: { table: string }) => row.table === 'equipment_parameters').rows[0].parameters_json = '{}'
  if (mode === 'scenario') tables.find((row: { table: string }) => row.table === 'scenarios').rows[0].config_json = '{}'
  if (mode === 'account') tables.find((row: { table: string }) => row.table === 'users').rows[0].password_hash = 'invalid'
  snapshot.prepare('UPDATE snapshot SET payload=?').run(JSON.stringify(tables)); snapshot.close()
  const catalog = new DatabaseSync(join(f.backup.directory, 'catalog.db'))
  catalog.prepare('UPDATE system_backups SET checksum=? WHERE backup_id=?').run(createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase(), 'EDITED'); catalog.close()
  expect(f.backup.restore('EDITED')).toMatchObject({ ok: true, data: { result: 'FAILURE', integrityValid: false } })
  expect(f.master.load()).toHaveLength(1)
})

it('装备历史引用及账号角色分配随完整备份恢复，不接受孤立角色分配', () => {
  const f = setup()
  const equipment = f.equipment.load()[0]!
  f.equipment.setReference({ equipmentId: equipment.equipmentId, equipmentVersion: 1, scenarioId: 'SCN-001', linkId: 'L-MW-01' }, false)
  f.auth.save({ userId: 'TEST-USER', username: 'testuser', role: 'OPERATOR', status: 'ACTIVE' }, '123456')
  const access = { version: 2, profiles: [{ profileId: 'TEST-ROLE', name: '测试角色', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: ['/situation'] }], assignments: [{ userId: 'TEST-USER', profileId: 'TEST-ROLE' }] }
  expect(f.access.save(access, 1)).toBe(true)
  expect(f.backup.backup('REFERENCES').ok).toBe(true)
  f.equipment.setReference({ equipmentId: equipment.equipmentId, equipmentVersion: 1, scenarioId: 'SCN-001', linkId: 'L-MW-01' }, true)
  f.access.save({ version: 3, profiles: [], assignments: [] }, 2)
  expect(f.backup.restore('REFERENCES')).toMatchObject({ ok: true, data: { result: 'SUCCESS' } })
  expect(f.equipment.details(equipment.equipmentId).references).toHaveLength(1)
  expect(f.access.load()).toEqual(access)
  f.access.save({ ...access, version: 3, assignments: [{ userId: 'MISSING', profileId: 'TEST-ROLE' }] }, 2)
  expect(f.backup.backup('ORPHAN')).toMatchObject({ ok: false, status: 503 })
  expect(existsSync(join(f.backup.directory, 'ORPHAN.system.db'))).toBe(false)
})

it('计划默认关闭，启用后按间隔执行，重启补一次、失败可见、停用不删除历史', () => {
  const f = setup()
  expect(f.backup.planStatus()).toMatchObject({ plan: { enabled: false, version: 1 }, nextRunAt: null, executions: [] })
  f.backup.tick()
  expect(f.backup.listBackups()).toEqual([])
  const plan = { ...f.backup.planStatus().plan, enabled: true, intervalMinutes: 60 }
  expect(f.backup.savePlan({ ...plan, intervalMinutes: 0 })).toMatchObject({ ok: false, status: 422 })
  expect(f.backup.savePlan(plan).ok).toBe(true)
  expect(f.backup.savePlan(plan)).toMatchObject({ ok: false, status: 409 })
  f.backup.tick(); expect(f.backup.listBackups()).toHaveLength(0)
  f.advance(4 * 3600000); f.backup.tick(); f.backup.tick()
  expect(f.backup.listBackups()).toHaveLength(1)
  expect(f.backup.planStatus().executions[0]?.result).toBe('SUCCESS')
  const db = new DatabaseSync(join(f.directory, 'master-data.db'))
  db.exec("UPDATE master_data SET data_json='{}'")
  f.advance(3600000); f.backup.tick()
  expect(f.backup.planStatus().executions[0]).toMatchObject({ result: 'FAILURE', backupId: null })
  db.close()
  expect(f.backup.savePlan({ ...f.backup.planStatus().plan, enabled: false }).ok).toBe(true)
  f.advance(3600000); f.backup.tick()
  expect(f.backup.planStatus().executions).toHaveLength(2)
  vi.useFakeTimers()
  f.backup.start(); f.backup.start()
  expect(vi.getTimerCount()).toBe(1)
  vi.advanceTimersByTime(60000)
})

it('配置白名单拒绝凭据，恢复值重启保留，管理员修改环境路径后采用新路径', () => {
  const f = setup()
  const path = join(f.directory, 'runtime-config.db')
  const before = f.settings.load()
  const db = new DatabaseSync(path)
  db.prepare('UPDATE runtime_config SET value=?').run(JSON.stringify({ eventPath: null, positionPath: null })); db.close()
  const reopened = new RuntimeConfigSqliteStorage(path, before)
  expect(reopened.load()).toEqual({ eventPath: null, positionPath: null }); reopened.close()
  const changed = new RuntimeConfigSqliteStorage(path, { eventPath: join(f.directory, 'other.csv'), positionPath: null })
  expect(changed.load().eventPath).toContain('other.csv'); changed.close()
  expect(() => new RuntimeConfigSqliteStorage(path, { ...before, password: 'bad' } as typeof before)).toThrow()
})

it('正式计划 API 校验权限、参数、版本和存储故障', async () => {
  const f = setup()
  const server = createMockServer({ port: 0, backupStorage: f.backup })
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
    const path = '/api/v1/admin/backup-plan'
    const plan = (await api.get(path).set(headers).expect(200)).body.data.plan
    await api.get(path).set({ ...headers, 'X-Demo-Role': 'OPERATOR' }).expect(403)
    await api.put(path).set({ ...headers, 'X-Demo-Role': 'BAD' }).send(plan).expect(403)
    await api.put(path).set(headers).send({ ...plan, extra: true }).expect(422)
    await api.put(path).set(headers).send({ ...plan, enabled: true }).expect(200)
    await api.put(path).set(headers).send(plan).expect(409)
    vi.spyOn(f.backup, 'planStatus').mockImplementation(() => { throw new Error('test-only') })
    await api.get(path).set(headers).expect(503)
    await api.put(path).set(headers).send(plan).expect(503)
  } finally { await server.close() }
})

import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { BackupRecord, BackupPlan, BackupPlanStatus, BackupExecution, RestoreResult } from '../../src/contracts/domain-models.js'
import type { AdminResult, BackupStorage } from '../admin/projection.js'
import { isBackupPlan, isBackupPlanStatus } from '../../src/features/admin/backup-plan.js'
import { BackupSqliteStorage } from './backup-sqlite.js'
import { SYSTEM_SCOPES, SYSTEM_TABLES, validateSystemSnapshot, type BackupScope } from './system-backup-validation.js'

type TableSnapshot = { scope: BackupScope; table: string; sql: string; rows: Record<string, SQLInputValue>[] }
const files = { equipment: 'equipment.db', access: 'access-control.db', master: 'master-data.db', archives: 'archives.db', settings: 'runtime-config.db' }
const validId = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id)
const validName = (name: string) => typeof name === 'string' && name.trim().length > 0 && name.length <= 80
const unavailable = (message = '备份存储不可用或被占用，操作未成功；请检查磁盘和数据库后重试。'): AdminResult<never> => ({ ok: false, status: 503, code: 'ATOMIC_REPLACE_FAILED', message })
const schemaQuery = "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"

/** 一个受控 SQLite 包保存所有业务库；恢复只复制表数据，不替换正在使用的数据库文件。 */
export class SystemBackupSqliteStorage implements BackupStorage {
  private readonly db: DatabaseSync
  private readonly catalog: DatabaseSync
  private readonly legacy: BackupSqliteStorage
  readonly directory: string
  private readonly schema = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(path: string, private readonly now: () => Date = () => new Date()) {
    this.legacy = new BackupSqliteStorage(path)
    this.directory = this.legacy.directory
    this.db = new DatabaseSync(path)
    let catalog: DatabaseSync | undefined
    try {
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF')
      for (const [scope, file] of Object.entries(files)) {
        const target = join(dirname(realpathSync(path)), file)
        this.requireRegularFile(target)
        this.db.prepare(`ATTACH DATABASE ? AS ${scope}`).run(target)
      }
      for (const scope of SYSTEM_SCOPES) {
        const rows = this.db.prepare(schemaQuery.replace('sqlite_master', `${scope}.sqlite_master`)).all()
        if (rows.length !== SYSTEM_TABLES[scope].length || rows.some(row => row.type !== 'table' || !(SYSTEM_TABLES[scope] as readonly string[]).includes(String(row.name)))) throw new Error('业务库结构不兼容。')
        for (const row of rows) this.schema.set(`${scope}.${row.name}`, String(row.sql))
        this.db.exec(`PRAGMA ${scope}.synchronous=FULL`)
      }
      catalog = new DatabaseSync(join(this.directory, 'catalog.db'))
      this.catalog = catalog
      catalog.exec(`PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS system_backups (backup_id TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS backup_plan (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL, next_run TEXT) STRICT;
        CREATE TABLE IF NOT EXISTS backup_executions (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;`)
      catalog.prepare('INSERT OR IGNORE INTO backup_plan VALUES (1, ?, NULL)').run(JSON.stringify({ version: 1, enabled: false, name: '定时备份', intervalMinutes: 1440 }))
      this.planStatus()
    } catch (error) { catalog?.close(); this.db.close(); this.legacy.close(); throw error }
  }

  private requireRegularFile(path: string): void {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)) throw new Error('备份对象必须是受控普通文件。')
  }
  private file(id: string): string {
    if (!validId(id)) throw new Error('备份编号不合法。')
    return join(this.directory, `${id}.system.db`)
  }
  private checksum(path: string): string { this.requireRegularFile(path); return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase() }

  listBackups(): BackupRecord[] {
    const records: BackupRecord[] = this.catalog.prepare('SELECT * FROM system_backups ORDER BY created_at, backup_id').all().map(row => {
      const record: BackupRecord = { backupId: String(row.backup_id), name: String(row.name), checksum: String(row.checksum), createdAt: String(row.created_at), status: 'INVALID', format: 'SYSTEM_SQLITE_V1' }
      try { if (this.checksum(this.file(record.backupId)) === record.checksum) record.status = 'VALID' } catch { /* 保留损坏或缺失目录记录，不能当成有效备份。 */ }
      return record
    })
    return [...this.legacy.listBackups().map(row => ({ ...row, format: 'MAIN_SQLITE_V1' as const })), ...records]
  }

  private capture(): TableSnapshot[] {
    return [...this.schema].map(([key, sql]) => {
      const [scope, table] = key.split('.') as [BackupScope, string]
      const actual = this.db.prepare(`SELECT sql FROM ${scope}.sqlite_master WHERE type='table' AND name=?`).get(table)
      if (actual?.sql !== sql) throw new Error('数据库结构已变化。')
      return { scope, table, sql, rows: this.db.prepare(`SELECT * FROM ${key}`).all() as Record<string, SQLInputValue>[] }
    })
  }

  private insertRows(db: DatabaseSync, key: string, rows: Record<string, SQLInputValue>[]): void {
    const [scope, table] = key.split('.')
    const columns = db.prepare(`PRAGMA ${scope}.table_info(${table})`).all().map(row => String(row.name))
    const statement = db.prepare(`INSERT INTO ${key} (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    for (const row of rows) {
      if (typeof row !== 'object' || row === null || Array.isArray(row) || Object.keys(row).length !== columns.length || !columns.every(column => Object.hasOwn(row, column))) throw new Error('备份字段不完整。')
      statement.run(...columns.map(column => row[column]!))
    }
  }

  private validate(tables: TableSnapshot[]): void {
    if (!Array.isArray(tables) || tables.length !== this.schema.size || new Set(tables.map(row => `${row.scope}.${row.table}`)).size !== this.schema.size) throw new Error('备份范围不完整。')
    const scratch = new DatabaseSync(':memory:')
    try {
      for (const scope of SYSTEM_SCOPES.filter(scope => scope !== 'main')) scratch.exec(`ATTACH DATABASE ':memory:' AS ${scope}`)
      for (const table of tables) {
        const key = `${table.scope}.${table.table}`
        const sql = this.schema.get(key)
        if (!sql || table.sql !== sql || !Array.isArray(table.rows)) throw new Error('备份结构不兼容。')
        // 只执行当前程序从现有白名单表读取且完全匹配的 DDL，不执行备份提供的任意 SQL。
        scratch.exec(sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?\S+\s*\(/i, `CREATE TABLE ${key} (`))
        this.insertRows(scratch, key, table.rows)
      }
      validateSystemSnapshot(scratch)
    } finally { scratch.close() }
  }

  /** 恢复前备份与随后恢复写入必须属于同一锁定时点。 */
  private writeLocked(backupId: string, name: string): AdminResult<BackupRecord> {
    return this.writeSnapshot(backupId, name, this.capture())
  }

  private writeSnapshot(backupId: string, name: string, tables: TableSnapshot[]): AdminResult<BackupRecord> {
    let created = false
    const path = this.file(backupId)
    try {
      if (this.catalog.prepare('SELECT 1 FROM system_backups WHERE backup_id=? UNION ALL SELECT 1 FROM backups WHERE backup_id=?').get(backupId, backupId)) return { ok: false, code: 'CONFLICT', status: 409, message: '备份编号已存在，未覆盖原备份。' }
      this.validate(tables)
      // 独占创建确保补偿只会删除本次创建的文件，已有同名文件绝不覆盖。
      try { closeSync(openSync(path, 'wx')); created = true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, code: 'CONFLICT', status: 409, message: '备份文件已存在，未覆盖。' }; throw error }
      const snapshot = new DatabaseSync(path)
      try {
        snapshot.exec('CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK(id=1), format TEXT NOT NULL, payload TEXT NOT NULL) STRICT;')
        snapshot.prepare('INSERT INTO snapshot VALUES (1, ?, ?)').run('SYSTEM_SQLITE_V1', JSON.stringify(tables))
      } finally { snapshot.close() }
      const checksum = this.checksum(path)
      this.readSnapshot(path)
      const record: BackupRecord = { backupId, name, status: 'VALID', checksum, createdAt: this.now().toISOString(), format: 'SYSTEM_SQLITE_V1' }
      this.catalog.prepare('INSERT INTO system_backups VALUES (?, ?, ?, ?)').run(backupId, name, checksum, record.createdAt)
      return { ok: true, data: record }
    } catch {
      if (created) {
        try { if (!this.catalog.prepare('SELECT 1 FROM system_backups WHERE backup_id=?').get(backupId)) unlinkSync(path) }
        catch { return unavailable(`备份失败，${backupId}.system.db 可能残留；请核对目录登记后仅处理未登记文件。`) }
      }
      return unavailable()
    }
  }

  backup(backupId = `BACKUP-${randomUUID()}`, name = '手动备份'): AdminResult<BackupRecord> {
    if (!validId(backupId) || !validName(name)) return { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '备份编号或名称不正确。', fieldPath: 'name' }
    let transaction = false
    let tables: TableSnapshot[]
    try {
      // 在同一写事务内物化所有业务库快照；耗时校验和文件 I/O 在释放写锁后进行。
      this.db.exec('BEGIN IMMEDIATE'); transaction = true
      tables = this.capture()
      this.db.exec('ROLLBACK'); transaction = false
    } catch { return unavailable() }
    finally { if (transaction) this.db.exec('ROLLBACK') }
    return this.writeSnapshot(backupId, name, tables)
  }

  private readSnapshot(path: string): TableSnapshot[] {
    this.requireRegularFile(path)
    const snapshot = new DatabaseSync(path, { readOnly: true })
    try {
      const integrity = snapshot.prepare('PRAGMA integrity_check').all()
      const rows = snapshot.prepare('SELECT * FROM snapshot').all()
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || rows.length !== 1 || rows[0]?.id !== 1 || rows[0]?.format !== 'SYSTEM_SQLITE_V1') throw new Error('备份包不正确。')
      const tables = JSON.parse(String(rows[0].payload)) as TableSnapshot[]
      this.validate(tables)
      return tables
    } finally { snapshot.close() }
  }

  restore(backupId: string): AdminResult<RestoreResult> {
    let transaction = false
    try {
      const record = this.catalog.prepare('SELECT * FROM system_backups WHERE backup_id=?').get(backupId)
      if (!record) return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到完整系统备份；旧主库备份仅保留查看，不可作为多库恢复来源。', fieldPath: 'backupId' }
      // 跨库断电原子性依赖 rollback journal，WAL/MEMORY/OFF 明确拒绝，不能暗改用户日志模式。
      for (const scope of SYSTEM_SCOPES) if (!['delete', 'truncate', 'persist'].includes(String(this.db.prepare(`PRAGMA ${scope}.journal_mode`).get()?.journal_mode))) return unavailable('多库恢复要求所有业务库使用回滚日志模式；检测到 WAL 或不安全模式，未执行恢复。')
      this.db.exec('BEGIN IMMEDIATE'); transaction = true
      const prebackup = this.writeLocked(`PREBACKUP-${randomUUID()}`, '恢复前自动备份')
      if (!prebackup.ok) return prebackup
      const result: RestoreResult = { prebackupId: prebackup.data.backupId, integrityValid: false, progress: 0, result: 'FAILURE', rolledBack: false, generated: true }
      let tables: TableSnapshot[]
      try {
        const path = this.file(backupId)
        if (this.checksum(path) !== record.checksum) return { ok: true, data: result }
        tables = this.readSnapshot(path)
        if (this.checksum(path) !== record.checksum) return { ok: true, data: result }
      } catch { return { ok: true, data: result } }
      result.integrityValid = true
      const environment = this.db.prepare('SELECT environment FROM settings.runtime_config WHERE id=1').get()?.environment
      try {
        // 历史与引用一起恢复；延迟到提交时检查外键，不在中间删除历史时误判悬空引用。
        this.db.exec('PRAGMA defer_foreign_keys=ON')
        for (const table of tables) {
          if (table.scope === 'main' && table.table === 'audit_logs') continue
          const key = `${table.scope}.${table.table}`
          this.db.exec(`DELETE FROM ${key}`)
          this.insertRows(this.db, key, table.rows)
        }
        // 保留当前部署的环境基线，恢复值立即生效且不会在下次同配置启动时被覆盖。
        this.db.prepare('UPDATE settings.runtime_config SET environment=? WHERE id=1').run(environment as string)
        validateSystemSnapshot(this.db)
        this.db.exec('COMMIT'); transaction = false
        result.result = 'SUCCESS'; result.progress = 100
      } catch { this.db.exec('ROLLBACK'); transaction = false; result.rolledBack = true }
      return { ok: true, data: result }
    } catch { return unavailable() }
    finally { if (transaction) this.db.exec('ROLLBACK') }
  }

  planStatus(): BackupPlanStatus {
    const row = this.catalog.prepare('SELECT * FROM backup_plan WHERE id=1').get()
    const status = { plan: JSON.parse(String(row?.value)), nextRunAt: row?.next_run ?? null,
      executions: this.catalog.prepare('SELECT value FROM backup_executions ORDER BY id DESC LIMIT 20').all().map(item => JSON.parse(String(item.value))) }
    if (!isBackupPlanStatus(status)) throw new Error('备份计划或执行记录损坏。')
    return status
  }
  savePlan(plan: BackupPlan): AdminResult<BackupPlanStatus> {
    if (!isBackupPlan(plan)) return { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '备份计划参数不正确。', fieldPath: 'plan' }
    try {
      const current = this.planStatus().plan
      if (current.version !== plan.version) return { ok: false, code: 'VERSION_CONFLICT', status: 409, message: '备份计划已变化，请刷新后重试。', fieldPath: 'version' }
      const saved = this.catalog.prepare("UPDATE backup_plan SET value=?, next_run=? WHERE id=1 AND json_extract(value, '$.version')=?").run(JSON.stringify({ ...plan, version: plan.version + 1 }), plan.enabled ? new Date(this.now().getTime() + plan.intervalMinutes * 60000).toISOString() : null, plan.version)
      if (saved.changes !== 1) return { ok: false, code: 'VERSION_CONFLICT', status: 409, message: '备份计划已变化，请刷新后重试。', fieldPath: 'version' }
      return { ok: true, data: this.planStatus() }
    } catch { return unavailable('备份计划保存失败，请刷新核实。') }
  }
  tick(): void {
    // 先持久化认领和失败记录；进程中断不会把未完成任务显示成功，也不会无限补跑错过的周期。
    this.catalog.exec('BEGIN IMMEDIATE')
    let executionId: number | bigint
    let plan: BackupPlan
    let startedAt: string
    try {
      const current = this.planStatus()
      const now = this.now()
      if (!current.plan.enabled || current.nextRunAt === null || Date.parse(current.nextRunAt) > now.getTime()) { this.catalog.exec('ROLLBACK'); return }
      plan = current.plan; startedAt = now.toISOString()
      this.catalog.prepare('UPDATE backup_plan SET next_run=? WHERE id=1').run(new Date(now.getTime() + plan.intervalMinutes * 60000).toISOString())
      executionId = this.catalog.prepare('INSERT INTO backup_executions(value) VALUES (?)').run(JSON.stringify({ startedAt, completedAt: startedAt, result: 'FAILURE', backupId: null, message: '执行中断或结果未确认，请检查服务日志。' })).lastInsertRowid
      this.catalog.exec('COMMIT')
    } catch (error) { this.catalog.exec('ROLLBACK'); throw error }
    const result = this.backup(undefined, plan.name)
    const execution: BackupExecution = { startedAt, completedAt: this.now().toISOString(), result: result.ok ? 'SUCCESS' : 'FAILURE', backupId: result.ok ? result.data.backupId : null, message: result.ok ? '计划备份完成并通过完整性校验。' : result.message }
    this.catalog.prepare('UPDATE backup_executions SET value=? WHERE id=?').run(JSON.stringify(execution), executionId)
  }
  start(): void {
    if (this.timer) return
    const run = () => { try { this.tick() } catch (error) { console.error('备份计划检查失败，未确认执行成功。', error) } }
    run()
    this.timer = setInterval(run, 60_000)
    this.timer.unref()
  }
  close(): void { if (this.timer) clearInterval(this.timer); this.catalog.close(); this.db.close(); this.legacy.close() }
}

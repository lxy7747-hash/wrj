import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { BackupRecord, RestoreResult } from '../../src/contracts/domain-models.js'
import type { AdminResult, BackupStorage } from '../admin/projection.js'
import { inspectScenarioConfig, inspectScenarioUiExtensions, isRfc3339DateTime } from '../../src/features/scenarios/scenario-validation.js'

const RESTORED_TABLES = ['scenarios', 'scenario_templates', 'users'] as const
const ALL_TABLES = [...RESTORED_TABLES, 'audit_logs']
const validId = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id)
const unavailable = (): AdminResult<never> => ({ ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503,
  message: '备份存储不可用或数据库被占用，未确认操作成功。请检查磁盘与数据库后重试。' })

/** 同步操作与 SQLite 写事务串行化本进程请求；普通 SQLite 文件仅用于非敏感开发数据。 */
export class BackupSqliteStorage implements BackupStorage {
  private readonly db: DatabaseSync
  private readonly catalog: DatabaseSync
  readonly directory: string

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('备份数据库路径必须为绝对路径。')
    const databasePath = realpathSync(path)
    this.directory = join(dirname(databasePath), 'backups')
    mkdirSync(this.directory, { recursive: true })
    if (lstatSync(this.directory).isSymbolicLink() || realpathSync(this.directory) !== resolve(this.directory)) {
      throw new Error('备份目录不得是链接。')
    }
    this.db = new DatabaseSync(databasePath)
    let catalog: DatabaseSync | undefined
    try {
      this.db.exec('PRAGMA busy_timeout = 1000; PRAGMA trusted_schema = OFF')
      const catalogPath = join(this.directory, 'catalog.db')
      try {
        if (!lstatSync(catalogPath).isFile() || lstatSync(catalogPath).isSymbolicLink()) throw new Error('备份目录索引不得是链接。')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      catalog = new DatabaseSync(catalogPath)
      this.catalog = catalog
      this.catalog.exec(`PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS backups (
          backup_id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, created_at TEXT NOT NULL
        ) STRICT;`)
    } catch (error) { catalog?.close(); this.db.close(); throw error }
  }

  private file(id: string): string {
    if (!validId(id)) throw new Error('备份编号不合法。')
    const path = join(this.directory, `${id}.db`)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)) throw new Error('备份文件不是受控普通文件。')
    return path
  }

  private checksum(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase()
  }

  listBackups(): BackupRecord[] {
    return this.catalog.prepare('SELECT * FROM backups ORDER BY created_at, backup_id').all().map(row => {
      const record: BackupRecord = { backupId: String(row.backup_id), createdAt: String(row.created_at), checksum: String(row.checksum), status: 'INVALID' }
      try { if (this.checksum(this.file(record.backupId)) === record.checksum) record.status = 'VALID' } catch { /* 缺失或损坏的文件保留目录记录，不能展示为可恢复。 */ }
      return record
    })
  }

  backup(backupId = `BACKUP-${randomUUID()}`): AdminResult<BackupRecord> {
    if (!validId(backupId)) return { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '备份编号仅支持字母、数字、下划线和短横线，最长 80 位。', fieldPath: 'backupId' }
    let createdPath: string | undefined
    try {
      if (this.catalog.prepare('SELECT 1 FROM backups WHERE backup_id = ?').get(backupId)) {
        return { ok: false, code: 'CONFLICT', status: 409, message: '备份编号已存在，未覆盖原文件。', fieldPath: 'backupId' }
      }
      // VACUUM INTO 生成一致性快照，包含 WAL 已提交内容；目标存在时 SQLite 拒绝覆盖。
      const path = join(this.directory, `${backupId}.db`)
      try { lstatSync(path); return { ok: false, code: 'CONFLICT', status: 409, message: '备份文件已存在，未覆盖。', fieldPath: 'backupId' } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      this.db.prepare('VACUUM main INTO ?').run(path)
      createdPath = path
      const snapshot = new DatabaseSync(path, { readOnly: true })
      try { this.validate(snapshot) } finally { snapshot.close() }
      const record: BackupRecord = { backupId, status: 'VALID', checksum: this.checksum(path), createdAt: new Date().toISOString() }
      this.catalog.prepare('INSERT INTO backups VALUES (?, ?, ?)').run(backupId, record.checksum, record.createdAt)
      return { ok: true, data: record }
    } catch {
      // 仅补偿本次已创建且未登记的快照；无法核对目录时保留文件，避免删除已有备份。
      if (createdPath !== undefined) {
        try {
          if (!this.catalog.prepare('SELECT 1 FROM backups WHERE backup_id = ?').get(backupId)) {
            try { unlinkSync(createdPath) }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          }
        } catch {
          return { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503,
            message: `备份失败，${backupId}.db 清理未确认，可能残留。请管理员核对备份目录与登记记录，仅处理未登记文件后重试。` }
        }
      }
      return unavailable()
    }
  }

  private validate(snapshot: DatabaseSync): void {
    snapshot.exec('PRAGMA trusted_schema = OFF')
    const integrity = snapshot.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok'
      || snapshot.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('备份完整性校验失败。')
    const schemaSql = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    const expected = this.db.prepare(schemaSql).all()
    if (expected.some(row => row.type !== 'table' || !ALL_TABLES.includes(String(row.name)))
      || expected.length !== ALL_TABLES.length
      || JSON.stringify(snapshot.prepare(schemaSql).all()) !== JSON.stringify(expected)) throw new Error('备份结构与当前版本不兼容。')
    if (!snapshot.prepare("SELECT 1 FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'").get()) throw new Error('备份缺少启用的管理员。')
    for (const user of snapshot.prepare('SELECT * FROM users').all()) {
      if (typeof user.user_id !== 'string' || !user.user_id.trim()
        || !/^[a-f0-9]{32}$/i.test(String(user.password_salt)) || !/^[a-f0-9]{64}$/i.test(String(user.password_hash))
        || (user.last_login_at !== null && !isRfc3339DateTime(user.last_login_at))) throw new Error('备份账号数据无效。')
    }
    for (const table of ['scenarios', 'scenario_templates']) {
      for (const row of snapshot.prepare(`SELECT * FROM ${table}`).all()) {
        const config: unknown = JSON.parse(String(row.config_json))
        const check = inspectScenarioConfig(config, 'read')
        if (!check.result.valid || !check.identity || !check.jammers || !check.sensors
          || (table === 'scenarios' && (check.identity.id !== row.id || check.identity.name !== row.name))) throw new Error('备份场景数据无效。')
        if (row.ui_extensions_json !== null) {
          const ui = inspectScenarioUiExtensions(JSON.parse(String(row.ui_extensions_json)), check.jammers.map(item => item.id), check.sensors.map(item => item.id))
          if (!ui.result.valid) throw new Error('备份扩展数据无效。')
        }
      }
    }
  }

  restore(backupId: string): AdminResult<RestoreResult> {
    let attached = false
    let inTransaction = false
    try {
      const record = this.catalog.prepare('SELECT checksum FROM backups WHERE backup_id = ?').get(backupId)
      if (!record) return { ok: false, code: 'NOT_FOUND', status: 404, message: '备份记录不存在。', fieldPath: 'backupId' }
      const version = this.db.prepare('PRAGMA data_version').get()!.data_version
      const prebackup = this.backup(`PREBACKUP-${randomUUID()}`)
      if (!prebackup.ok) return prebackup
      const result: RestoreResult = { prebackupId: prebackup.data.backupId, integrityValid: false, progress: 0, result: 'FAILURE', rolledBack: false, generated: true }
      let path: string
      try {
        path = this.file(backupId)
        if (this.checksum(path) !== record.checksum) return { ok: true, data: result }
        const snapshot = new DatabaseSync(path, { readOnly: true })
        try { this.validate(snapshot) } finally { snapshot.close() }
      } catch { return { ok: true, data: result } }
      this.db.prepare('ATTACH DATABASE ? AS restore_source').run(path)
      attached = true
      this.db.exec('BEGIN IMMEDIATE')
      inTransaction = true
      // 外部连接在预备份后写入时拒绝恢复，避免预备份遗漏刚提交的数据。
      if (this.db.prepare('PRAGMA data_version').get()!.data_version !== version || this.checksum(path) !== record.checksum) {
        this.db.exec('ROLLBACK'); inTransaction = false
        return { ok: false, code: 'CONFLICT', status: 409, message: '数据库或备份已变化，请重新确认恢复。' }
      }
      result.integrityValid = true
      try {
        // 审计日志保留当前历史；整组数据在一个事务内替换，已有连接无需重开或替换数据库文件。
        for (const table of RESTORED_TABLES) {
          this.db.exec(`DELETE FROM main.${table}`)
          this.db.exec(`INSERT INTO main.${table} SELECT * FROM restore_source.${table}`)
        }
        this.validate(this.db)
        this.db.exec('COMMIT')
        inTransaction = false
        result.result = 'SUCCESS'
        result.progress = 100
      } catch {
        this.db.exec('ROLLBACK')
        inTransaction = false
        result.rolledBack = true
      }
      return { ok: true, data: result }
    } catch { return unavailable() }
    finally {
      if (inTransaction) {
        try { this.db.exec('ROLLBACK') }
        catch (error) { console.error('恢复事务清理失败，请检查数据库连接。', error) }
      }
      if (attached) {
        try { this.db.exec('DETACH DATABASE restore_source') }
        catch (error) { console.error('恢复来源连接清理失败，请检查数据库连接。', error) }
      }
    }
  }

  close(): void { this.catalog.close(); this.db.close() }
}

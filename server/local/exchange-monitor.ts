import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'
import type { FileReadRecord, LocalMonitorSnapshot } from '../../src/features/data-exchange/local-monitor.js'

export class LocalExchangeMonitor {
  private readonly recordsDb: DatabaseSync
  private writeFailed = false
  private closed = false

  constructor(private readonly databasePath: string) {
    if (!isAbsolute(databasePath)) throw new Error('监控数据库路径必须为绝对路径。')
    // 独立记录库不改变主库冻结结构，也不随场景恢复回退历史。
    const path = join(dirname(realpathSync(databasePath)), 'exchange-records.db')
    if (realpathSync(databasePath) === path) throw new Error('交换记录库不能作为场景主库。')
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('交换记录库必须为普通文件。')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.recordsDb = new DatabaseSync(path)
    try {
      this.recordsDb.exec(`PRAGMA busy_timeout = 250; PRAGMA trusted_schema = OFF;
        CREATE TABLE IF NOT EXISTS exchange_records (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence BETWEEN 1 AND 9007199254740991),
          operation TEXT NOT NULL CHECK(operation IN ('INITIAL_NODES','POSITIONS','LOCAL_REPLAY')),
          file_name TEXT NOT NULL CHECK(length(trim(file_name)) > 0),
          completed_at TEXT NOT NULL,
          duration_ms REAL NOT NULL CHECK(duration_ms >= 0),
          status TEXT NOT NULL CHECK(status IN ('SUCCESS','ERROR')),
          record_count INTEGER CHECK(record_count >= 0),
          issue_count INTEGER CHECK(issue_count >= 0),
          error_code TEXT,
          CHECK((status = 'SUCCESS' AND error_code IS NULL AND record_count IS NOT NULL AND issue_count IS NOT NULL)
            OR (status = 'ERROR' AND error_code IS NOT NULL AND error_code = 'LOCAL_READ_FAILED' AND record_count IS NULL AND issue_count IS NULL))
        ) STRICT;`)
    } catch (error) { this.recordsDb.close(); throw error }
  }

  async read<T>(operation: FileReadRecord['operation'], filePath: string, read: () => Promise<T>, counts: (value: T) => { recordCount: number; issueCount: number }): Promise<T> {
    const started = performance.now()
    let result: Pick<FileReadRecord, 'status' | 'recordCount' | 'issueCount' | 'errorCode'> = {
      status: 'ERROR', recordCount: null, issueCount: null, errorCode: 'LOCAL_READ_FAILED',
    }
    try {
      const value = await read()
      result = { ...counts(value), status: 'SUCCESS', errorCode: null }
      return value
    } finally {
      const completedAt = new Date().toISOString()
      const durationMs = performance.now() - started
      try {
        this.recordsDb.prepare(`INSERT INTO exchange_records
          (operation,file_name,completed_at,duration_ms,status,record_count,issue_count,error_code) VALUES(?,?,?,?,?,?,?,?)`)
          .run(operation, basename(filePath), completedAt, durationMs, result.status, result.recordCount, result.issueCount, result.errorCode)
        this.writeFailed = false
      } catch {
        // 文件读取可能已经推进游标，记录失败不能改写其结果或覆盖原始异常。
        this.writeFailed = true
      }
    }
  }

  snapshot(): LocalMonitorSnapshot {
    let database: LocalMonitorSnapshot['database'] = 'ERROR'
    let db: DatabaseSync | undefined
    try {
      // 每次只读打开现有文件，文件丢失不能创建空库并误报健康。
      db = new DatabaseSync(this.databasePath, { readOnly: true })
      db.exec('PRAGMA busy_timeout = 250; PRAGMA trusted_schema = OFF')
      for (const table of ['scenarios', 'scenario_templates', 'users', 'audit_logs']) db.prepare(`SELECT * FROM ${table} LIMIT 0`).all()
      const checks = db.prepare('PRAGMA quick_check').all()
      if (checks.length === 1 && checks[0]?.quick_check === 'ok') database = 'HEALTHY'
    } catch { /* 服务可达与数据库可读是独立状态；不返回底层路径或 SQL 错误。 */ }
    finally { db?.close() }
    let records: FileReadRecord[] = []
    let recordStorage: LocalMonitorSnapshot['recordStorage'] = this.writeFailed ? 'ERROR' : 'HEALTHY'
    try {
      records = this.recordsDb.prepare(`SELECT sequence, operation, file_name AS fileName, completed_at AS completedAt,
        duration_ms AS durationMs, status, record_count AS recordCount, issue_count AS issueCount, error_code AS errorCode
        FROM exchange_records ORDER BY sequence DESC LIMIT 50`).all() as unknown as FileReadRecord[]
    } catch { recordStorage = 'ERROR' }
    return { service: 'HEALTHY', database, recordStorage, checkedAt: new Date().toISOString(), records }
  }

  close(): void {
    if (this.closed) return
    this.recordsDb.close()
    this.closed = true
  }
}

import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import type { MasterData, MasterDataDetails, MasterDataReference } from '../../src/contracts/domain-models.js'
import { isMasterData, isMasterDetails, isMasterReference, isMasterWrite } from '../../src/features/admin/admin-contract.js'
import type { MasterDataStorage } from '../admin/projection.js'

/** 独立空库：只持久化管理员实际录入的主数据，不导入或覆盖冻结示例。 */
export class MasterDataSqliteStorage implements MasterDataStorage {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('主数据数据库路径必须为绝对路径。')
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS master_data (
          id TEXT PRIMARY KEY NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          data_json TEXT NOT NULL CHECK (json_valid(data_json))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS master_data_history (
          id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          data_json TEXT NOT NULL CHECK (json_valid(data_json)),
          PRIMARY KEY (id, version)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS master_data_references (
          data_id TEXT NOT NULL,
          data_version INTEGER NOT NULL CHECK (data_version >= 1),
          target_type TEXT NOT NULL CHECK (target_type IN ('SCENARIO', 'TEMPLATE')),
          target_id TEXT NOT NULL,
          target_version TEXT NOT NULL,
          PRIMARY KEY (data_id, data_version, target_type, target_id, target_version),
          FOREIGN KEY (data_id, data_version) REFERENCES master_data_history(id, version)
        ) STRICT;`)
      this.load()
    } catch {
      this.db.close()
      throw new Error('主数据存储无效，未覆盖已有数据。')
    }
  }

  load(): MasterData[] {
    return this.db.prepare('SELECT id, version, data_json FROM master_data ORDER BY id').all().map(row => this.readRecord(row))
  }

  private readRecord(row: Record<string, unknown>): MasterData {
    if (typeof row.id !== 'string' || !Number.isSafeInteger(row.version) || typeof row.data_json !== 'string') throw new Error('主数据存储结构不正确。')
    const value: unknown = JSON.parse(row.data_json)
    if (!isMasterData(value) || value.dataId !== row.id || value.version !== row.version) throw new Error('主数据记录格式不正确。')
    return { ...value, referenceCount: this.referenceCount(value.dataId) }
  }

  private referenceCount(dataId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM master_data_references WHERE data_id = ?').get(dataId)
    if (!row || (typeof row.count !== 'number' && typeof row.count !== 'bigint')) throw new Error('主数据引用计数读取失败。')
    return Number(row.count)
  }

  save(record: MasterData, expectedVersion?: number): boolean {
    if (!isMasterWrite(record) || record.version !== (expectedVersion ?? 0) + 1) throw new Error('主数据写入无效。')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const referenceCount = this.referenceCount(record.dataId)
      // 版本保存与引用计数读取处于同一写事务，避免旧表单覆盖并发登记后的计数。
      if (record.referenceCount !== referenceCount) {
        this.db.exec('ROLLBACK')
        return false
      }
      const json = JSON.stringify({ ...record, referenceCount })
      let changed: number
      if (expectedVersion === undefined) {
        // 历史编号永久保留，删除当前项后不能用同一编号覆盖旧版本快照。
        changed = Number(this.db.prepare(`INSERT INTO master_data (id, version, data_json)
          SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM master_data_history WHERE id = ?)`)
          .run(record.dataId, record.version, json, record.dataId).changes)
      } else {
        changed = Number(this.db.prepare('UPDATE master_data SET version = ?, data_json = ? WHERE id = ? AND version = ?')
          .run(record.version, json, record.dataId, expectedVersion).changes)
      }
      if (changed !== 1) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.db.prepare('INSERT INTO master_data_history (id, version, data_json) VALUES (?, ?, ?)')
        .run(record.dataId, record.version, json)
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  delete(dataId: string, expectedVersion: number): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const deleted = this.db.prepare(`DELETE FROM master_data
        WHERE id = ? AND version = ? AND NOT EXISTS (
          SELECT 1 FROM master_data_references WHERE data_id = master_data.id
        )`).run(dataId, expectedVersion).changes === 1
      if (!deleted) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  details(dataId: string): MasterDataDetails {
    const value = {
      dataId,
      history: this.db.prepare('SELECT id, version, data_json FROM master_data_history WHERE id = ? ORDER BY version DESC').all(dataId)
        .map(row => this.readHistory(row)),
      references: this.db.prepare(`SELECT data_id, data_version, target_type, target_id, target_version
        FROM master_data_references WHERE data_id = ? ORDER BY data_version DESC, target_type, target_id, target_version`).all(dataId)
        .map(row => ({ dataId: String(row.data_id), dataVersion: Number(row.data_version), targetType: String(row.target_type),
          targetId: String(row.target_id), targetVersion: String(row.target_version) })),
    }
    if (!isMasterDetails(value)) throw new Error('主数据历史或引用格式不正确。')
    return value
  }

  private readHistory(row: Record<string, unknown>): MasterData {
    if (typeof row.id !== 'string' || !Number.isSafeInteger(row.version) || typeof row.data_json !== 'string') throw new Error('主数据历史结构不正确。')
    const value: unknown = JSON.parse(row.data_json)
    if (!isMasterData(value) || value.dataId !== row.id || value.version !== row.version) throw new Error('主数据历史记录格式不正确。')
    return { ...value, referenceCount: this.referenceCount(value.dataId) }
  }

  addReference(reference: MasterDataReference): boolean {
    if (!isMasterReference(reference)) throw new Error('主数据引用无效。')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.db.prepare(`SELECT 1 FROM master_data WHERE id = ?
        AND json_extract(data_json, '$.active') = 1`).get(reference.dataId)
      const version = this.db.prepare(`SELECT 1 FROM master_data_history WHERE id = ? AND version = ?
        AND json_extract(data_json, '$.active') = 1`).get(reference.dataId, reference.dataVersion)
      if (!current || !version) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.db.prepare(`INSERT INTO master_data_references (data_id, data_version, target_type, target_id, target_version)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(data_id, data_version, target_type, target_id, target_version) DO NOTHING`)
        .run(reference.dataId, reference.dataVersion, reference.targetType, reference.targetId, reference.targetVersion)
      this.db.exec('COMMIT')
      // 重复登记是幂等成功；同一事务内已确认当前项和选定版本仍可用。
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void { this.db.close() }
}

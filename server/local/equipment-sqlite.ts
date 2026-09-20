import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import type { EquipmentParameter } from '../../src/contracts/domain-models.js'
import { isEquipmentParameter } from '../../src/features/admin/equipment-contract.js'
import type { EquipmentStorage } from '../admin/projection.js'

/** 独立装备数据库；空库不植入示例，不覆盖已有表或数据。 */
export class EquipmentSqliteStorage implements EquipmentStorage {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('装备数据库路径必须为绝对路径。')
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS equipment_parameters (
          id TEXT PRIMARY KEY NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json))
        ) STRICT;`)
      this.load()
    } catch {
      this.db.close()
      throw new Error('装备参数存储无效，未覆盖已有数据。')
    }
  }

  load(): EquipmentParameter[] {
    return this.db.prepare('SELECT * FROM equipment_parameters ORDER BY id').all().map(row => {
      const value: unknown = JSON.parse(String(row.parameters_json))
      if (!isEquipmentParameter(value) || value.equipmentId !== row.id || value.version !== row.version) throw new Error('装备参数存储格式不正确。')
      return value
    })
  }

  save(record: EquipmentParameter, expectedVersion?: number): boolean {
    if (!isEquipmentParameter(record) || record.readOnly || record.version !== (expectedVersion ?? 0) + 1) throw new Error('装备参数写入无效。')
    if (expectedVersion === undefined) {
      return this.db.prepare('INSERT INTO equipment_parameters (id, version, parameters_json) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
        .run(record.equipmentId, record.version, JSON.stringify(record)).changes === 1
    }
    // 条件更新原子检查版本和只读状态，避免另一连接写入后被旧表单覆盖。
    return this.db.prepare(`UPDATE equipment_parameters SET version = ?, parameters_json = ?
      WHERE id = ? AND version = ? AND json_extract(parameters_json, '$.readOnly') = 0`)
      .run(record.version, JSON.stringify(record), record.equipmentId, expectedVersion).changes === 1
  }

  close(): void { this.db.close() }
}

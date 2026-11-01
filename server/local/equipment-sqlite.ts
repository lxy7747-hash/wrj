import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import type { EquipmentDetails, EquipmentParameter, EquipmentReference } from '../../src/contracts/domain-models.js'
import { equipmentIssue, isEquipmentDetails, isEquipmentParameter } from '../../src/features/admin/equipment-contract.js'
import type { EquipmentStorage } from '../admin/projection.js'
import type { EquipmentSceneUpdate } from '../admin/equipment-sync.js'

/** 独立装备数据库；空库不植入示例，不覆盖已有表或数据。 */
export class EquipmentSqliteStorage implements EquipmentStorage {
  private readonly db: DatabaseSync

  constructor(path: string, private readonly scenarioPath?: string) {
    if (!isAbsolute(path)) throw new Error('装备数据库路径必须为绝对路径。')
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS equipment_parameters (
          id TEXT PRIMARY KEY NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS equipment_history (id TEXT NOT NULL, version INTEGER NOT NULL, parameters_json TEXT NOT NULL, PRIMARY KEY(id, version)) STRICT;
        CREATE TABLE IF NOT EXISTS equipment_references (scenario_id TEXT NOT NULL, link_id TEXT NOT NULL, equipment_id TEXT NOT NULL, equipment_version INTEGER NOT NULL, PRIMARY KEY(scenario_id, link_id)) STRICT;`)
      this.load()
      if (scenarioPath) {
        if (!isAbsolute(scenarioPath) || !statSync(scenarioPath).isFile()) throw new Error('引用场景数据库不存在。')
        this.db.prepare('ATTACH DATABASE ? AS scenes').run(scenarioPath)
        this.db.exec('PRAGMA main.synchronous=FULL; PRAGMA scenes.synchronous=FULL')
      }
    } catch {
      this.db.close()
      throw new Error('装备参数存储无效，未覆盖已有数据。')
    }
  }

  load(): EquipmentParameter[] {
    return this.db.prepare('SELECT * FROM equipment_parameters ORDER BY id').all().map(row => {
      const value: unknown = JSON.parse(String(row.parameters_json))
      if (!isEquipmentParameter(value) || value.equipmentId !== row.id || value.version !== row.version) throw new Error('装备参数存储格式不正确。')
      return this.withDefaultActive(value)
    })
  }

  /** 保持旧 JSON 记录兼容：历史上没有 active 的装备默认仍可用。 */
  private withDefaultActive(value: EquipmentParameter): EquipmentParameter {
    return value.active === undefined ? { ...value, active: true } : value
  }

  /** 有既有引用时，仅启停元数据允许不触碰场景；其他参数必须提供完整场景同步。 */
  private isMetadataOnlyUpdate(previous: EquipmentParameter, next: EquipmentParameter): boolean {
    const { version: _previousVersion, active: _previousActive, ...previousParameters } = previous
    const { version: _nextVersion, active: _nextActive, ...nextParameters } = next
    return isDeepStrictEqual(previousParameters, nextParameters)
  }

  save(record: EquipmentParameter, expectedVersion?: number, updates: EquipmentSceneUpdate[] = [], references: EquipmentReference[] = []): boolean {
    if (equipmentIssue(record, 'write') || record.readOnly || record.version !== (expectedVersion ?? 0) + 1) throw new Error('装备参数写入无效。')
    record = this.withDefaultActive(record)
    if (updates.length) {
      if (!this.scenarioPath) throw new Error('未接入可原子更新的场景数据库。')
      // 与完整恢复相同：WAL 不保证跨库断电原子性，不偷偷修改现用日志模式。
      for (const scope of ['main', 'scenes']) {
        const mode = Object.values(this.db.prepare(`PRAGMA ${scope}.journal_mode`).get()!)[0]
        if (!['delete', 'truncate', 'persist'].includes(String(mode))) throw new Error('装备同步需要两库均使用回滚日志模式。')
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const currentReferences = this.details(record.equipmentId).references
      const synchronizeReferences = updates.length > 0
      const current = this.db.prepare('SELECT parameters_json FROM equipment_parameters WHERE id = ?').get(record.equipmentId)
      const previous = current === undefined ? undefined : this.withDefaultActive(JSON.parse(String(current.parameters_json)) as EquipmentParameter)
      if (!synchronizeReferences && currentReferences.length && (!previous || !this.isMetadataOnlyUpdate(previous, record))) {
        this.db.exec('ROLLBACK')
        return false
      }
      if (synchronizeReferences && (currentReferences.length !== references.length || currentReferences.some(current => !references.some(reference => isDeepStrictEqual(current, reference))))) {
        this.db.exec('ROLLBACK')
        return false
      }
      if (synchronizeReferences && (updates.length !== new Set(references.map(item => item.scenarioId)).size
        || references.some(reference => !updates.some(update => update.before.config.scenario.id === reference.scenarioId)))) throw new Error('场景更新范围不完整。')
      for (const { before, after } of updates) {
        const row = this.db.prepare('SELECT config_json, revision FROM scenes.scenarios WHERE id = ?').get(before.config.scenario.id)
        if (!row || row.revision !== before.revision || !isDeepStrictEqual(JSON.parse(String(row.config_json)), before.config)) {
          this.db.exec('ROLLBACK')
          return false
        }
        if (after.config.scenario.id !== before.config.scenario.id || after.revision !== before.revision + 1) throw new Error('场景同步版本不正确。')
      }
      // 仅归档实际存在的旧版本，不为历史缺口构造记录；与参数更新同一事务。
      this.db.prepare('INSERT OR IGNORE INTO equipment_history SELECT id, version, parameters_json FROM equipment_parameters WHERE id = ?').run(record.equipmentId)
      const saved = this.saveRecord(record, expectedVersion)
      if (saved && expectedVersion === undefined) this.db.prepare('DELETE FROM equipment_history WHERE id = ?').run(record.equipmentId)
      if (saved) this.db.prepare('INSERT INTO equipment_history VALUES (?, ?, ?)').run(record.equipmentId, record.version, JSON.stringify(record))
      if (saved) {
        for (const { before, after } of updates) this.db.prepare('UPDATE scenes.scenarios SET config_json = ?, revision = ? WHERE id = ? AND revision = ?')
          .run(JSON.stringify(after.config), after.revision, before.config.scenario.id, before.revision)
        // 仅在场景已随参数成功同步时推进引用版本；单独启停不改写既有引用。
        if (updates.length) this.db.prepare('UPDATE equipment_references SET equipment_version = ? WHERE equipment_id = ?').run(record.version, record.equipmentId)
      }
      this.db.exec(saved ? 'COMMIT' : 'ROLLBACK')
      return saved
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private saveRecord(record: EquipmentParameter, expectedVersion?: number): boolean {
    if (expectedVersion === undefined) {
      return this.db.prepare('INSERT INTO equipment_parameters (id, version, parameters_json) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
        .run(record.equipmentId, record.version, JSON.stringify(record)).changes === 1
    }
    // 条件更新原子检查版本和只读状态，避免另一连接写入后被旧表单覆盖。
    return this.db.prepare(`UPDATE equipment_parameters SET version = ?, parameters_json = ?
      WHERE id = ? AND version = ? AND json_extract(parameters_json, '$.readOnly') = 0`)
      .run(record.version, JSON.stringify(record), record.equipmentId, expectedVersion).changes === 1
  }

  delete(equipmentId: string, expectedVersion: number): boolean {
    return this.db.prepare(`DELETE FROM equipment_parameters
      WHERE id = ? AND version = ? AND json_extract(parameters_json, '$.readOnly') = 0
      AND NOT EXISTS (SELECT 1 FROM equipment_references WHERE equipment_id = equipment_parameters.id)`)
      .run(equipmentId, expectedVersion).changes === 1
  }

  details(equipmentId: string): EquipmentDetails {
    const value = {
      history: this.db.prepare('SELECT parameters_json FROM equipment_history WHERE id = ? ORDER BY version DESC').all(equipmentId)
        .map(row => this.withDefaultActive(JSON.parse(String(row.parameters_json)) as EquipmentParameter)),
      references: this.db.prepare('SELECT * FROM equipment_references WHERE equipment_id = ? ORDER BY scenario_id, link_id').all(equipmentId).map(row => ({
        equipmentId: String(row.equipment_id), scenarioId: String(row.scenario_id), linkId: String(row.link_id), equipmentVersion: Number(row.equipment_version),
      })),
    }
    if (!isEquipmentDetails(value)) throw new Error('装备历史或引用数据不正确。')
    return value
  }

  setReference(reference: EquipmentReference, remove: boolean): void {
    if (remove) this.db.prepare('DELETE FROM equipment_references WHERE scenario_id = ? AND link_id = ? AND equipment_id = ?')
      .run(reference.scenarioId, reference.linkId, reference.equipmentId)
    else {
      const saved = this.db.prepare(`INSERT INTO equipment_references SELECT ?, ?, id, version FROM equipment_parameters WHERE id = ? AND version = ?
        AND COALESCE(json_extract(parameters_json, '$.active'), 1) = 1
        ON CONFLICT(scenario_id, link_id) DO UPDATE SET equipment_id=excluded.equipment_id, equipment_version=excluded.equipment_version`)
        .run(reference.scenarioId, reference.linkId, reference.equipmentId, reference.equipmentVersion)
      if (saved.changes !== 1) throw new Error('装备版本已变化，请重新加载。')
    }
  }

  close(): void { this.db.close() }
}

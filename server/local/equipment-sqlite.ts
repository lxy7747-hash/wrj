import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import type { EquipmentDetails, EquipmentParameter, EquipmentReference } from '../../src/contracts/domain-models.js'
import { equipmentIssue, isEquipmentDetails, isEquipmentParameter } from '../../src/features/admin/equipment-contract.js'
import {
  isEquipmentHistoryDetails, isEquipmentLifecycleEvent, isEquipmentPublishedReference, isEquipmentVerificationRecord,
  type EquipmentHistoryDetails, type EquipmentLifecycleEvent, type EquipmentLifecycleEventType,
  type EquipmentPublishedReference, type EquipmentRecreateParameters, type EquipmentVerificationRecord,
} from '../../src/features/admin/equipment-history-contract.js'
import type { EquipmentStorage, EquipmentRecreateOutcome } from '../admin/projection.js'
import type { EquipmentSceneUpdate } from '../admin/equipment-sync.js'

const SCHEMA = `PRAGMA busy_timeout = 1000;
  CREATE TABLE IF NOT EXISTS equipment_parameters (
    id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS equipment_history (id TEXT NOT NULL, version INTEGER NOT NULL, parameters_json TEXT NOT NULL, PRIMARY KEY(id, version)) STRICT;
  CREATE TABLE IF NOT EXISTS equipment_references (scenario_id TEXT NOT NULL, link_id TEXT NOT NULL, equipment_id TEXT NOT NULL, equipment_version INTEGER NOT NULL, PRIMARY KEY(scenario_id, link_id)) STRICT;
  CREATE TABLE IF NOT EXISTS equipment_published_references (
    equipment_id TEXT NOT NULL,
    equipment_version INTEGER NOT NULL CHECK (equipment_version >= 1),
    target_type TEXT NOT NULL CHECK (target_type IN ('RUN','TEMPLATE','ARCHIVE','SCENARIO')),
    target_id TEXT NOT NULL,
    target_version TEXT NOT NULL,
    source_summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (equipment_id, equipment_version, target_type, target_id, target_version, source_summary)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS equipment_lifecycle_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipment_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('DELETE','RECREATE')),
    version INTEGER NOT NULL CHECK (version >= 1),
    occurred_at TEXT NOT NULL,
    operator TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS equipment_verification (
    equipment_id TEXT PRIMARY KEY NOT NULL,
    covered_targets TEXT NOT NULL,
    evidence_summary TEXT NOT NULL,
    conclusion TEXT NOT NULL,
    operator TEXT NOT NULL,
    verified_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS equipment_legacy_unverified (
    equipment_id TEXT PRIMARY KEY NOT NULL,
    marked_at TEXT NOT NULL
  ) STRICT;`

/** 独立装备数据库；空库不植入示例，不覆盖已有表或数据。 */
export class EquipmentSqliteStorage implements EquipmentStorage {
  private readonly db: DatabaseSync

  constructor(path: string, private readonly scenarioPath?: string, private readonly now: () => string = () => new Date().toISOString()) {
    if (!isAbsolute(path)) throw new Error('装备数据库路径必须为绝对路径。')
    this.db = new DatabaseSync(path)
    try {
      // 升级前旧库没有发布引用/生命周期/核验表；只在首次升级时把既有设备标记为“历史引用待核验”。
      const existing = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)))
      const legacyUpgrade = existing.has('equipment_parameters') && !existing.has('equipment_published_references')
      this.db.exec(SCHEMA)
      if (legacyUpgrade) {
        const now = this.now()
        const insert = this.db.prepare('INSERT OR IGNORE INTO equipment_legacy_unverified (equipment_id, marked_at) VALUES (?, ?)')
        for (const row of this.db.prepare('SELECT id FROM equipment_parameters').all()) insert.run(String(row.id), now)
      }
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
      // 编号已有删除历史时普通新建必须拒绝，历史不被清空；显式重建走独立入口。
      if (expectedVersion === undefined && this.db.prepare('SELECT 1 FROM equipment_history WHERE id = ? LIMIT 1').get(record.equipmentId)) {
        this.db.exec('ROLLBACK')
        return false
      }
      const saved = this.saveRecord(record, expectedVersion)
      if (saved) this.db.prepare('INSERT OR IGNORE INTO equipment_history VALUES (?, ?, ?)').run(record.equipmentId, record.version, JSON.stringify(record))
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

  /** 删除当前记录并在同一事务追加 DELETE 事件；历史参数、发布引用和核验保持原样。 */
  delete(equipmentId: string, expectedVersion: number, operator = 'system'): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const changes = this.db.prepare(`DELETE FROM equipment_parameters
        WHERE id = ? AND version = ? AND json_extract(parameters_json, '$.readOnly') = 0
        AND NOT EXISTS (SELECT 1 FROM equipment_references WHERE equipment_id = equipment_parameters.id)
        AND NOT EXISTS (SELECT 1 FROM equipment_published_references WHERE equipment_id = equipment_parameters.id)
        AND (EXISTS (SELECT 1 FROM equipment_verification WHERE equipment_id = equipment_parameters.id)
          OR NOT EXISTS (SELECT 1 FROM equipment_legacy_unverified WHERE equipment_id = equipment_parameters.id))`)
        .run(equipmentId, expectedVersion).changes === 1
      if (changes) this.appendLifecycle(equipmentId, 'DELETE', expectedVersion, operator)
      this.db.exec(changes ? 'COMMIT' : 'ROLLBACK')
      return changes
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  details(equipmentId: string): EquipmentDetails {
    const value = {
      history: this.db.prepare('SELECT parameters_json FROM equipment_history WHERE id = ? ORDER BY version DESC').all(equipmentId)
        .map(row => this.withDefaultActive(JSON.parse(String(row.parameters_json)) as EquipmentParameter)),
      references: this.references(equipmentId),
    }
    if (!isEquipmentDetails(value)) throw new Error('装备历史或引用数据不正确。')
    return value
  }

  private references(equipmentId: string): EquipmentReference[] {
    return this.db.prepare('SELECT * FROM equipment_references WHERE equipment_id = ? ORDER BY scenario_id, link_id').all(equipmentId).map(row => ({
      equipmentId: String(row.equipment_id), scenarioId: String(row.scenario_id), linkId: String(row.link_id), equipmentVersion: Number(row.equipment_version),
    }))
  }

  /** 扩展本地详情：兼容冻结 EquipmentDetails，并补充发布引用、生命周期与核验状态。 */
  historyDetails(equipmentId: string): EquipmentHistoryDetails {
    const history = this.details(equipmentId).history
    const currentRow = this.db.prepare('SELECT parameters_json FROM equipment_parameters WHERE id = ?').get(equipmentId)
    const current = currentRow === undefined ? null : this.withDefaultActive(JSON.parse(String(currentRow.parameters_json)) as EquipmentParameter)
    const value: EquipmentHistoryDetails = {
      equipmentId,
      deleted: current === null,
      current,
      history,
      references: this.references(equipmentId),
      publishedReferences: this.publishedReferences(equipmentId),
      lifecycle: this.lifecycleEvents(equipmentId),
      verification: this.verification(equipmentId),
      pendingVerification: this.pendingVerification(equipmentId),
    }
    if (!isEquipmentHistoryDetails(value)) throw new Error('装备历史详情数据不正确。')
    return value
  }

  publishedReferences(equipmentId: string): EquipmentPublishedReference[] {
    return this.db.prepare('SELECT * FROM equipment_published_references WHERE equipment_id = ? ORDER BY target_type, target_id, target_version').all(equipmentId).map(row => {
      const value = {
        equipmentId: String(row.equipment_id), equipmentVersion: Number(row.equipment_version),
        targetType: String(row.target_type), targetId: String(row.target_id), targetVersion: String(row.target_version),
        sourceSummary: String(row.source_summary), createdAt: String(row.created_at),
      }
      if (!isEquipmentPublishedReference(value)) throw new Error('发布引用数据不正确。')
      return value
    })
  }

  lifecycleEvents(equipmentId: string): EquipmentLifecycleEvent[] {
    return this.db.prepare('SELECT * FROM equipment_lifecycle_events WHERE equipment_id = ? ORDER BY id').all(equipmentId).map(row => {
      const value = { eventType: String(row.event_type), version: Number(row.version), occurredAt: String(row.occurred_at), operator: String(row.operator) }
      if (!isEquipmentLifecycleEvent(value)) throw new Error('生命周期事件数据不正确。')
      return value
    })
  }

  verification(equipmentId: string): EquipmentVerificationRecord | null {
    const row = this.db.prepare('SELECT * FROM equipment_verification WHERE equipment_id = ?').get(equipmentId)
    if (!row) return null
    const value = {
      equipmentId: String(row.equipment_id), coveredTargets: String(row.covered_targets), evidenceSummary: String(row.evidence_summary),
      conclusion: String(row.conclusion), operator: String(row.operator), verifiedAt: String(row.verified_at),
    }
    if (!isEquipmentVerificationRecord(value)) throw new Error('核验记录数据不正确。')
    return value
  }

  pendingVerification(equipmentId: string): boolean {
    if (this.db.prepare('SELECT 1 FROM equipment_verification WHERE equipment_id = ?').get(equipmentId)) return false
    return this.db.prepare('SELECT 1 FROM equipment_legacy_unverified WHERE equipment_id = ?').get(equipmentId) !== undefined
  }

  /** 登记发布目标的历史引用；必须指向当前或历史存在的设备版本，重复登记返回 `false`。 */
  addPublishedReference(reference: EquipmentPublishedReference): boolean {
    if (!isEquipmentPublishedReference(reference)) throw new Error('发布引用参数不正确。')
    const exists = this.db.prepare(`SELECT 1 FROM equipment_parameters WHERE id = ? AND version = ?
      UNION SELECT 1 FROM equipment_history WHERE id = ? AND version = ?`).get(reference.equipmentId, reference.equipmentVersion, reference.equipmentId, reference.equipmentVersion)
    if (!exists) throw new Error('发布引用的装备版本不存在。')
    // 身份是完整主键，含来源摘要；先按完整主键预查，避免 INSERT OR IGNORE 掩盖已存在引用。
    const duplicate = this.db.prepare(`SELECT 1 FROM equipment_published_references
      WHERE equipment_id = ? AND equipment_version = ? AND target_type = ? AND target_id = ? AND target_version = ? AND source_summary = ?`)
      .get(reference.equipmentId, reference.equipmentVersion, reference.targetType, reference.targetId, reference.targetVersion, reference.sourceSummary)
    if (duplicate) return false
    const info = this.db.prepare(`INSERT INTO equipment_published_references
      (equipment_id, equipment_version, target_type, target_id, target_version, source_summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(reference.equipmentId, reference.equipmentVersion, reference.targetType,
      reference.targetId, reference.targetVersion, reference.sourceSummary, reference.createdAt ?? this.now())
    return info.changes === 1
  }

  /** 按完整主键撤销一条发布引用；缺失时静默，供发布失败回滚使用。 */
  removePublishedReference(reference: EquipmentPublishedReference): void {
    if (!isEquipmentPublishedReference(reference)) throw new Error('发布引用参数不正确。')
    this.db.prepare(`DELETE FROM equipment_published_references
      WHERE equipment_id = ? AND equipment_version = ? AND target_type = ? AND target_id = ? AND target_version = ? AND source_summary = ?`)
      .run(reference.equipmentId, reference.equipmentVersion, reference.targetType, reference.targetId, reference.targetVersion, reference.sourceSummary)
  }

  recordVerification(record: EquipmentVerificationRecord): void {
    if (!isEquipmentVerificationRecord(record)) throw new Error('核验记录参数不正确。')
    this.db.prepare(`INSERT INTO equipment_verification (equipment_id, covered_targets, evidence_summary, conclusion, operator, verified_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(equipment_id) DO UPDATE SET covered_targets=excluded.covered_targets, evidence_summary=excluded.evidence_summary,
        conclusion=excluded.conclusion, operator=excluded.operator, verified_at=excluded.verified_at`)
      .run(record.equipmentId, record.coveredTargets, record.evidenceSummary, record.conclusion, record.operator, record.verifiedAt)
  }

  /** 原子重建：有历史、当前不存在、历史最大版本等于预期时，分配 max+1 并追加 RECREATE。 */
  recreate(equipmentId: string, expectedHistoryVersion: number, parameters: EquipmentRecreateParameters, operator: string): EquipmentRecreateOutcome {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.db.prepare('SELECT 1 FROM equipment_parameters WHERE id = ?').get(equipmentId)) { this.db.exec('ROLLBACK'); return { ok: false, code: 'CONFLICT' } }
      const row = this.db.prepare('SELECT MAX(version) AS version FROM equipment_history WHERE id = ?').get(equipmentId)
      const maxVersion = row?.version === null || row?.version === undefined ? undefined : Number(row.version)
      if (maxVersion === undefined) { this.db.exec('ROLLBACK'); return { ok: false, code: 'NOT_FOUND' } }
      if (maxVersion !== expectedHistoryVersion) { this.db.exec('ROLLBACK'); return { ok: false, code: 'CONFLICT' } }
      const record = { equipmentId, ...parameters, active: parameters.active ?? true, readOnly: false, version: maxVersion + 1 } as EquipmentParameter
      if (equipmentIssue(record, 'write') !== null) { this.db.exec('ROLLBACK'); return { ok: false, code: 'VALIDATION_FAILED' } }
      this.db.prepare('INSERT INTO equipment_parameters (id, version, parameters_json) VALUES (?, ?, ?)').run(record.equipmentId, record.version, JSON.stringify(record))
      this.db.prepare('INSERT INTO equipment_history (id, version, parameters_json) VALUES (?, ?, ?)').run(record.equipmentId, record.version, JSON.stringify(record))
      const event = this.appendLifecycle(equipmentId, 'RECREATE', record.version, operator)
      this.db.exec('COMMIT')
      return { ok: true, equipment: record, event }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private appendLifecycle(equipmentId: string, eventType: EquipmentLifecycleEventType, version: number, operator: string): EquipmentLifecycleEvent {
    const occurredAt = this.now()
    this.db.prepare('INSERT INTO equipment_lifecycle_events (equipment_id, event_type, version, occurred_at, operator) VALUES (?, ?, ?, ?, ?)')
      .run(equipmentId, eventType, version, occurredAt, operator)
    return { eventType, version, occurredAt, operator }
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

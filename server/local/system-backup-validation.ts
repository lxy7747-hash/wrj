import { createHash } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { LinkParameterSource, ScenarioConfig } from '../../src/contracts/domain-models.js'
import { portParameterTargets } from '../../src/features/scenarios/port-parameter-source.js'
import { inspectScenarioConfig, inspectScenarioUiExtensions, isRfc3339DateTime, normalizeStoredScenario } from '../../src/features/scenarios/scenario-validation.js'
import { isEquipmentParameter, isEquipmentDetails } from '../../src/features/admin/equipment-contract.js'
import { isEquipmentLifecycleEvent, isEquipmentPublishedReference, isEquipmentVerificationRecord } from '../../src/features/admin/equipment-history-contract.js'
import { isAccessControlConfig } from '../../src/features/admin/access-control.js'
import { isMasterData, isMasterDetails } from '../../src/features/admin/admin-contract.js'
import { isLocalArchiveSnapshot } from '../../src/features/admin/local-archive.js'
import { isRuntimeFileConfig } from './runtime-config-sqlite.js'

export const SYSTEM_TABLES = {
  main: ['scenarios', 'scenario_templates', 'users', 'audit_logs'],
  equipment: ['equipment_parameters', 'equipment_history', 'equipment_references', 'equipment_published_references', 'equipment_lifecycle_events', 'equipment_verification', 'equipment_legacy_unverified'],
  access: ['access_control'],
  master: ['master_data', 'master_data_history', 'master_data_references'],
  archives: ['local_archives'],
  settings: ['runtime_config'],
} as const
export type BackupScope = keyof typeof SYSTEM_TABLES
export const SYSTEM_SCOPES = Object.keys(SYSTEM_TABLES) as BackupScope[]
export const SYSTEM_BACKUP_SCOPES = ['main', 'access', 'archives', 'settings'] as const satisfies readonly BackupScope[]

/** 原始预备份也必须具备完整的 SQLite 结构和外键关系。 */
export function validateSystemSnapshotStructure(db: DatabaseSync, scopes: readonly BackupScope[] = SYSTEM_SCOPES): void {
  for (const scope of scopes) {
    const integrity = db.prepare(`PRAGMA ${scope}.integrity_check`).all()
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || db.prepare(`PRAGMA ${scope}.foreign_key_check`).all().length) throw new Error('数据库完整性校验失败。')
  }
}

/** 校验恢复来源的业务内容及跨表身份。 */
export function validateSystemSnapshot(db: DatabaseSync, scopes: readonly BackupScope[] = SYSTEM_SCOPES): void {
  validateSystemSnapshotStructure(db, scopes)
  const users = db.prepare('SELECT * FROM main.users').all()
  if (!users.some(row => row.role === 'ADMIN' && row.status === 'ACTIVE')) throw new Error('缺少启用的管理员。')
  for (const row of users) {
    if ((row.display_name !== null && (typeof row.display_name !== 'string' || !row.display_name.trim() || row.display_name.length > 64))
      || typeof row.user_id !== 'string' || !row.user_id.trim() || !/^[a-f0-9]{32}$/i.test(String(row.password_salt))
      || !/^[a-f0-9]{64}$/i.test(String(row.password_hash)) || (row.last_login_at !== null && !isRfc3339DateTime(row.last_login_at))) throw new Error('账号内容无效。')
  }
  for (const table of ['scenarios', 'scenario_templates']) for (const row of db.prepare(`SELECT * FROM main.${table}`).all()) {
    if (table === 'scenarios' && row.created_at != null && !isRfc3339DateTime(row.created_at)) throw new Error('场景创建时间无效。')
    // 仅整理校验副本；旧字段在恢复后的正常读取中按同样规则处理。
    const parsedExtensions: unknown = row.ui_extensions_json === null ? undefined : JSON.parse(String(row.ui_extensions_json))
    const { config: stored, uiExtensions } = normalizeStoredScenario(JSON.parse(String(row.config_json)) as unknown, parsedExtensions)
    const config = inspectScenarioConfig(stored, 'read')
    if (!config.result.valid || !config.identity || !config.jammers || !config.sensors
      || (table === 'scenarios' && (config.identity.id !== row.id || config.identity.name !== row.name))) throw new Error('场景内容无效。')
    if (uiExtensions !== undefined && !inspectScenarioUiExtensions(uiExtensions, config.jammers.map(jammer => jammer.id), config.sensors.map(sensor => sensor.id)).result.valid) throw new Error('场景扩展无效。')
  }
  const accessRows = db.prepare('SELECT * FROM access.access_control').all()
  const access: unknown = JSON.parse(String(accessRows[0]?.config))
  if (accessRows.length !== 1 || !isAccessControlConfig(access) || access.version !== accessRows[0]?.version
    || access.assignments.some(assignment => !users.some(user => user.user_id === assignment.userId
      && access.profiles.some(profile => profile.profileId === assignment.profileId && profile.baseRole === user.role)))) throw new Error('角色权限与账号不一致。')
  if (scopes.includes('equipment')) validateEquipment(db)
  if (scopes.includes('master')) validateMasterData(db)
  for (const row of db.prepare('SELECT * FROM archives.local_archives').all()) {
    const value: unknown = JSON.parse(String(row.payload))
    if (!isLocalArchiveSnapshot(value) || value.record.archiveId !== row.archive_id
      || createHash('sha256').update(String(row.payload)).digest('hex') !== row.checksum
      || value.record.archiveId !== `ARCH-LOCAL-${createHash('sha256').update(`${value.replay.initial.sha256}:${value.replay.sha256}`).digest('hex')}`) throw new Error('历史归档内容或来源摘要无效。')
  }
  const settings = db.prepare('SELECT * FROM settings.runtime_config').all()
  if (settings.length !== 1 || !isRuntimeFileConfig(JSON.parse(String(settings[0]?.value))) || !isRuntimeFileConfig(JSON.parse(String(settings[0]?.environment)))) throw new Error('关键配置不在白名单内。')
}

function validateEquipment(db: DatabaseSync): void {
  const equipment = db.prepare('SELECT * FROM equipment.equipment_parameters').all()
  const equipmentHistory = db.prepare('SELECT * FROM equipment.equipment_history').all()
  for (const row of [...equipment, ...equipmentHistory]) {
    const item: unknown = JSON.parse(String(row.parameters_json))
    if (!isEquipmentParameter(item) || item.equipmentId !== row.id || item.version !== row.version) throw new Error('装备版本内容无效。')
  }
  const equipmentReferences = db.prepare('SELECT * FROM equipment.equipment_references').all().map(row => ({ equipmentId: String(row.equipment_id), equipmentVersion: Number(row.equipment_version), scenarioId: String(row.scenario_id), linkId: String(row.link_id) }))
  for (const id of new Set([...equipmentHistory.map(row => String(row.id)), ...equipmentReferences.map(row => row.equipmentId)])) {
    if (!isEquipmentDetails({ history: equipmentHistory.filter(row => row.id === id).map(row => JSON.parse(String(row.parameters_json))), references: equipmentReferences.filter(row => row.equipmentId === id) })) throw new Error('装备历史引用无效。')
  }
  if (equipmentReferences.some(reference => !equipmentHistory.some(row => row.id === reference.equipmentId && row.version === reference.equipmentVersion))) throw new Error('装备引用版本缺失。')
  const equipmentHistoryIds = new Set(equipmentHistory.map(row => String(row.id)))
  const publishedReferences = db.prepare('SELECT * FROM equipment.equipment_published_references').all().map(row => ({
    equipmentId: String(row.equipment_id), equipmentVersion: Number(row.equipment_version), targetType: String(row.target_type),
    targetId: String(row.target_id), targetVersion: String(row.target_version), sourceSummary: String(row.source_summary),
    ...(row.created_at === null || row.created_at === undefined ? {} : { createdAt: String(row.created_at) }),
  }))
  for (const reference of publishedReferences) {
    if (!isEquipmentPublishedReference(reference)) throw new Error('装备发布引用内容无效。')
    if (!equipmentHistoryIds.has(reference.equipmentId) || !equipmentHistory.some(row => String(row.id) === reference.equipmentId && Number(row.version) === reference.equipmentVersion)) throw new Error('装备发布引用版本缺失。')
  }
  for (const row of db.prepare('SELECT * FROM equipment.equipment_lifecycle_events').all()) {
    if (!isEquipmentLifecycleEvent({ eventType: String(row.event_type), version: Number(row.version), occurredAt: String(row.occurred_at), operator: String(row.operator) })) throw new Error('装备生命周期事件无效。')
    if (!equipmentHistoryIds.has(String(row.equipment_id))) throw new Error('装备生命周期事件指向未知设备。')
  }
  for (const row of db.prepare('SELECT * FROM equipment.equipment_verification').all()) {
    if (!isEquipmentVerificationRecord({ equipmentId: String(row.equipment_id), coveredTargets: String(row.covered_targets),
      evidenceSummary: String(row.evidence_summary), conclusion: String(row.conclusion), operator: String(row.operator), verifiedAt: String(row.verified_at) })) throw new Error('装备核验记录无效。')
  }
  for (const row of db.prepare('SELECT * FROM equipment.equipment_legacy_unverified').all()) {
    if (typeof row.equipment_id !== 'string' || !row.equipment_id.trim()) throw new Error('装备待核验记录无效。')
  }
}

function validateMasterData(db: DatabaseSync): void {
  const master = db.prepare('SELECT * FROM master.master_data').all()
  const masterHistory = db.prepare('SELECT * FROM master.master_data_history ORDER BY version DESC').all()
  const references = db.prepare('SELECT * FROM master.master_data_references').all().map(row => ({ dataId: String(row.data_id), dataVersion: Number(row.data_version), targetType: String(row.target_type), targetId: String(row.target_id), targetVersion: String(row.target_version) }))
  for (const row of [...master, ...masterHistory]) {
    const item: unknown = JSON.parse(String(row.data_json))
    if (!isMasterData(item) || item.dataId !== row.id || item.version !== row.version) throw new Error('通用数据版本无效。')
  }
  for (const id of new Set([...masterHistory.map(row => String(row.id)), ...references.map(row => row.dataId)])) {
    if (!isMasterDetails({ dataId: id, history: masterHistory.filter(row => row.id === id).map(row => JSON.parse(String(row.data_json))), references: references.filter(row => row.dataId === id) })) throw new Error('通用数据历史引用无效。')
  }
}

function parameterTargets(configJson: SQLInputValue): Map<string, LinkParameterSource | undefined> {
  const { config } = normalizeStoredScenario(JSON.parse(String(configJson)) as ScenarioConfig)
  return new Map([
    ...config.links.map(link => [link.id, link.parameterSource] as const),
    ...portParameterTargets(config).map(port => [port.id, port.parameters.parameterSource] as const),
  ])
}

/** The restore transaction preserves external master-data libraries; deprecated equipment sources never block restore. */
export function retainedParameterConflict(
  db: DatabaseSync,
  scenes: readonly Record<string, SQLInputValue>[],
  templates: readonly Record<string, SQLInputValue>[],
): string | null {
  const masterVersionQuery = db.prepare(`SELECT data_json AS content FROM master.master_data WHERE id = ? AND version = ?
    UNION ALL SELECT data_json FROM master.master_data_history WHERE id = ? AND version = ? LIMIT 1`)
  function hasMasterVersion(source: LinkParameterSource): boolean {
    const { sourceId, sourceVersion } = source
    const row = masterVersionQuery.get(sourceId, sourceVersion, sourceId, sourceVersion)
    if (typeof row?.content !== 'string') return false
    try {
      const record: unknown = JSON.parse(row.content)
      return isMasterData(record) && record.dataId === sourceId && record.version === sourceVersion
    } catch { return false }
  }

  for (const [label, rows] of [['场景', scenes], ['模板', templates]] as const) {
    for (const row of rows) {
      const id = String(row.id)
      const targets = parameterTargets(row.config_json!)
      for (const [targetId, source] of targets) {
        if (!source || source.kind === 'EQUIPMENT') continue
        const subject = `${label} ${id} 的链路或端口 ${targetId}`
        if (!hasMasterVersion(source)) return `${subject} 的参数来源 ${source.sourceId} v${source.sourceVersion} 在当前基础数据中缺失或无效，无法恢复。`
      }
    }
  }
  return null
}

/**
 * 在恢复事务内同步 equipment.equipment_references 索引，使其与恢复后的场景集合保持一致：
 * - 移除恢复后已不存在的场景/链路或端口的失效引用；
 * - 移除由恢复前场景自身绑定、但备份中未绑定的装备引用；
 * - 保留仍在恢复后场景中存在的纯手工引用；
 * - 若恢复后场景带旧装备 parameterSource 且对应装备版本仍在库中，则对齐引用，否则移除失效引用而不阻断恢复。
 */
export function reconcileEquipmentReferences(
  db: DatabaseSync,
  beforeScenes: readonly Record<string, SQLInputValue>[],
  restoredScenes: readonly Record<string, SQLInputValue>[],
): void {
  const beforeMap = new Map<string, Map<string, LinkParameterSource | undefined>>()
  for (const row of beforeScenes) {
    try { beforeMap.set(String(row.id), parameterTargets(row.config_json!)) }
    catch { beforeMap.set(String(row.id), new Map()) }
  }
  const restoredMap = new Map<string, Map<string, LinkParameterSource | undefined>>()
  for (const row of restoredScenes) {
    restoredMap.set(String(row.id), parameterTargets(row.config_json!))
  }

  const hasEquipmentVersion = db.prepare(`SELECT 1 FROM equipment.equipment_parameters WHERE id = ? AND version = ?
    UNION ALL SELECT 1 FROM equipment.equipment_history WHERE id = ? AND version = ? LIMIT 1`)
  const removeReference = db.prepare('DELETE FROM equipment.equipment_references WHERE scenario_id = ? AND link_id = ?')
  const upsertReference = db.prepare(`INSERT INTO equipment.equipment_references (scenario_id, link_id, equipment_id, equipment_version)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scenario_id, link_id) DO UPDATE SET equipment_id = excluded.equipment_id, equipment_version = excluded.equipment_version`)

  const existingReferences = db.prepare('SELECT scenario_id, link_id FROM equipment.equipment_references').all()
  for (const reference of existingReferences) {
    const sceneId = String(reference.scenario_id)
    const targetId = String(reference.link_id)
    const restoredTargets = restoredMap.get(sceneId)
    if (!restoredTargets?.has(targetId)) {
      removeReference.run(sceneId, targetId)
      continue
    }
    const restoredSource = restoredTargets.get(targetId)
    if (restoredSource?.kind === 'EQUIPMENT') continue
    if (beforeMap.get(sceneId)?.get(targetId)?.kind === 'EQUIPMENT') {
      removeReference.run(sceneId, targetId)
    }
  }

  for (const [sceneId, targets] of restoredMap) {
    for (const [targetId, source] of targets) {
      if (source?.kind !== 'EQUIPMENT') continue
      if (hasEquipmentVersion.get(source.sourceId, source.sourceVersion, source.sourceId, source.sourceVersion)) {
        upsertReference.run(sceneId, targetId, source.sourceId, source.sourceVersion)
      } else {
        removeReference.run(sceneId, targetId)
      }
    }
  }
}

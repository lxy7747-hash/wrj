import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { inspectScenarioConfig, inspectScenarioUiExtensions, isRfc3339DateTime } from '../../src/features/scenarios/scenario-validation.js'
import { isEquipmentParameter, isEquipmentDetails } from '../../src/features/admin/equipment-contract.js'
import { isAccessControlConfig } from '../../src/features/admin/access-control.js'
import { isMasterData, isMasterDetails } from '../../src/features/admin/admin-contract.js'
import { isLocalArchiveSnapshot } from '../../src/features/admin/local-archive.js'
import { isRuntimeFileConfig } from './runtime-config-sqlite.js'

export const SYSTEM_TABLES = {
  main: ['scenarios', 'scenario_templates', 'users', 'audit_logs'],
  equipment: ['equipment_parameters', 'equipment_history', 'equipment_references'],
  access: ['access_control'],
  master: ['master_data', 'master_data_history', 'master_data_references'],
  archives: ['local_archives'],
  settings: ['runtime_config'],
} as const
export type BackupScope = keyof typeof SYSTEM_TABLES
export const SYSTEM_SCOPES = Object.keys(SYSTEM_TABLES) as BackupScope[]

/** 校验备份内的业务内容及跨表身份；不把 SQLite integrity_check 当成业务校验。 */
export function validateSystemSnapshot(db: DatabaseSync): void {
  for (const scope of SYSTEM_SCOPES) {
    const integrity = db.prepare(`PRAGMA ${scope}.integrity_check`).all()
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || db.prepare(`PRAGMA ${scope}.foreign_key_check`).all().length) throw new Error('数据库完整性校验失败。')
  }
  const users = db.prepare('SELECT * FROM main.users').all()
  if (!users.some(row => row.role === 'ADMIN' && row.status === 'ACTIVE')) throw new Error('缺少启用的管理员。')
  for (const row of users) {
    if (typeof row.user_id !== 'string' || !row.user_id.trim() || !/^[a-f0-9]{32}$/i.test(String(row.password_salt))
      || !/^[a-f0-9]{64}$/i.test(String(row.password_hash)) || (row.last_login_at !== null && !isRfc3339DateTime(row.last_login_at))) throw new Error('账号内容无效。')
  }
  for (const table of ['scenarios', 'scenario_templates']) for (const row of db.prepare(`SELECT * FROM main.${table}`).all()) {
    const config = inspectScenarioConfig(JSON.parse(String(row.config_json)), 'read')
    if (!config.result.valid || !config.identity || !config.jammers || !config.sensors
      || (table === 'scenarios' && (config.identity.id !== row.id || config.identity.name !== row.name))) throw new Error('场景内容无效。')
    if (row.ui_extensions_json !== null && !inspectScenarioUiExtensions(JSON.parse(String(row.ui_extensions_json)), config.jammers.map(jammer => jammer.id), config.sensors.map(sensor => sensor.id)).result.valid) throw new Error('场景扩展无效。')
  }
  const accessRows = db.prepare('SELECT * FROM access.access_control').all()
  const access: unknown = JSON.parse(String(accessRows[0]?.config))
  if (accessRows.length !== 1 || !isAccessControlConfig(access) || access.version !== accessRows[0]?.version
    || access.assignments.some(assignment => !users.some(user => user.user_id === assignment.userId
      && access.profiles.some(profile => profile.profileId === assignment.profileId && profile.baseRole === user.role)))) throw new Error('角色权限与账号不一致。')
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
  const master = db.prepare('SELECT * FROM master.master_data').all()
  const masterHistory = db.prepare('SELECT * FROM master.master_data_history ORDER BY version DESC').all()
  const references = db.prepare('SELECT * FROM master.master_data_references').all().map(row => ({ dataId: String(row.data_id), dataVersion: Number(row.data_version), targetType: String(row.target_type), targetId: String(row.target_id), targetVersion: String(row.target_version) }))
  for (const row of [...master, ...masterHistory]) {
    const item: unknown = JSON.parse(String(row.data_json))
    if (!isMasterData(item) || item.dataId !== row.id || item.version !== row.version) throw new Error('主数据版本无效。')
  }
  for (const id of new Set([...masterHistory.map(row => String(row.id)), ...references.map(row => row.dataId)])) {
    if (!isMasterDetails({ dataId: id, history: masterHistory.filter(row => row.id === id).map(row => JSON.parse(String(row.data_json))), references: references.filter(row => row.dataId === id) })) throw new Error('主数据历史引用无效。')
  }
  for (const row of db.prepare('SELECT * FROM archives.local_archives').all()) {
    const value: unknown = JSON.parse(String(row.payload))
    if (!isLocalArchiveSnapshot(value) || value.record.archiveId !== row.archive_id
      || createHash('sha256').update(String(row.payload)).digest('hex') !== row.checksum
      || value.record.archiveId !== `ARCH-LOCAL-${createHash('sha256').update(`${value.replay.initial.sha256}:${value.replay.sha256}`).digest('hex')}`) throw new Error('历史归档内容或来源摘要无效。')
  }
  const settings = db.prepare('SELECT * FROM settings.runtime_config').all()
  if (settings.length !== 1 || !isRuntimeFileConfig(JSON.parse(String(settings[0]?.value))) || !isRuntimeFileConfig(JSON.parse(String(settings[0]?.environment)))) throw new Error('关键配置不在白名单内。')
}

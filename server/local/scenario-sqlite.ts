import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import type { EquipmentParameter, LinkParameterSource, MasterData, ScenarioConfig, ScenarioDraft } from '../../src/contracts/domain-models.js'
import { restoreRequiredMotionFields, dropRetiredScenarioFields, dropRetiredUiExtensionFields, inspectScenarioConfig, inspectScenarioUiExtensions } from '../../src/features/scenarios/scenario-validation.js'
import { prepareLinkEquipment } from '../../src/features/scenarios/link-equipment-parameters.js'
import { prepareLinkMasterData } from '../../src/features/scenarios/link-master-parameters.js'
import type { ScenarioStorage } from '../scenarios/projection.js'
import { ParameterSourceError, portParameterSourceChanges, readLinkParameterSource, validatePortParameterSources } from '../scenarios/parameter-sources.js'
import { portParameterTargets } from '../../src/features/scenarios/port-parameter-source.js'

/** 仅限非敏感开发数据；普通 SQLite 不提供本项目要求的加密或密钥管理。 */
export class ScenarioSqliteStorage implements ScenarioStorage {
  private readonly db: DatabaseSync
  private readonly hasSources: boolean

  constructor(path: string, sources?: { equipmentPath: string; masterDataPath: string }) {
    if (!isAbsolute(path)) throw new Error('SCENARIO_DB_PATH 必须为绝对路径。')
    if (sources && (!isAbsolute(sources.equipmentPath) || !isAbsolute(sources.masterDataPath))) throw new Error('参数来源数据库路径必须为绝对路径。')
    this.db = new DatabaseSync(path)
    this.hasSources = sources !== undefined
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS scenarios (
          id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
          name TEXT NOT NULL CHECK (length(trim(name)) > 0),
          config_json TEXT NOT NULL CHECK (json_valid(config_json)),
          ui_extensions_json TEXT NOT NULL CHECK (json_valid(ui_extensions_json)),
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
        ) STRICT;
      `)
      if (sources) {
        // ATTACH 会创建空库；本机启动随后初始化各自的表，测试只传场景库时保持旧行为。
        this.db.prepare('ATTACH DATABASE ? AS equipment').run(sources.equipmentPath)
        this.db.prepare('ATTACH DATABASE ? AS master').run(sources.masterDataPath)
        this.db.exec('PRAGMA main.synchronous=FULL; PRAGMA equipment.synchronous=FULL; PRAGMA master.synchronous=FULL')
      }
      this.list()
    } catch {
      this.db.close()
      throw new Error('场景数据库结构或数据无效；未覆盖已有数据，请检查数据库。')
    }
  }

  load(id?: string): ScenarioDraft | undefined {
    // 无编号仅供旧开发工具读取单记录；业务入口始终按编号读取，不用修订号选择场景。
    const row = id === undefined
      ? this.db.prepare('SELECT * FROM scenarios ORDER BY id LIMIT 1').get()
      : this.db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id)
    if (!row) return undefined
    return this.readRow(row)
  }

  list(): ScenarioDraft[] {
    return this.db.prepare('SELECT * FROM scenarios ORDER BY id').all().map(row => this.readRow(row))
  }

  private readRow(row: Record<string, unknown>): ScenarioDraft {
    if (typeof row.config_json !== 'string' || typeof row.ui_extensions_json !== 'string'
      || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) throw new Error('场景存储结构不正确。')
    const config: unknown = dropRetiredScenarioFields(JSON.parse(row.config_json))
    const uiExtensions: unknown = dropRetiredUiExtensionFields(JSON.parse(row.ui_extensions_json))
    restoreRequiredMotionFields(config, uiExtensions)
    const inspection = inspectScenarioConfig(config, 'read')
    if (!inspection.result.valid || !inspection.identity || inspection.identity.id !== row.id || inspection.identity.name !== row.name) {
      throw new Error('数据库场景配置校验失败。')
    }
    const extensions = inspectScenarioUiExtensions(uiExtensions, inspection.jammers!.map(item => item.id), inspection.sensors!.map(item => item.id))
    if (!extensions.result.valid) throw new Error('数据库场景界面扩展校验失败。')
    return {
      config: config as ScenarioConfig,
      uiExtensions: { jammers: extensions.jammers!, sensors: extensions.sensors! },
      revision: Number(row.revision),
      // 运行期锁不写入场景库；真实 Mission 的未结清记录由服务启动层恢复保护。
      locked: false,
      officialLibraryChanged: false,
    }
  }

  save(draft: ScenarioDraft, expected: { id: string; revision: number } | undefined): boolean {
    if (!this.hasSources && (draft.config.links.some(link => readLinkParameterSource(link) !== undefined)
      || portParameterTargets(draft.config).some(target => target.parameters.parameterSource))) {
      throw new Error('参数来源需要附加的装备和通用数据存储。')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.load(draft.config.scenario.id)
      if (current?.config.scenario.id !== expected?.id || current?.revision !== expected?.revision) {
        this.db.exec('ROLLBACK')
        return false
      }
      if (!Number.isSafeInteger(draft.revision) || draft.revision <= (current?.revision ?? 0)) {
        throw new Error('场景修订号必须递增。')
      }
      if (this.hasSources) {
        // 仅跨库引用写入要求回滚日志；不修改现有模式，也不阻断旧场景读取或普通保存。
        if ([...(current?.config.links ?? []), ...draft.config.links].some(link => link.parameterSource)
          || [...(current ? portParameterTargets(current.config) : []), ...portParameterTargets(draft.config)].some(target => target.parameters.parameterSource)) {
          for (const scope of ['main', 'equipment', 'master']) {
            const mode = Object.values(this.db.prepare(`PRAGMA ${scope}.journal_mode`).get()!)[0]
            if (!['delete', 'truncate', 'persist'].includes(String(mode))) throw new Error('参数来源保存需要所有数据库使用回滚日志模式。')
          }
        }
        this.syncParameterSources(current?.config, draft)
      }
      this.db.prepare(`
        INSERT INTO scenarios (id, name, config_json, ui_extensions_json, revision)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, config_json = excluded.config_json,
          ui_extensions_json = excluded.ui_extensions_json, revision = excluded.revision
      `).run(draft.config.scenario.id, draft.config.scenario.name, JSON.stringify(dropRetiredScenarioFields(structuredClone(draft.config))), JSON.stringify(dropRetiredUiExtensionFields(structuredClone(draft.uiExtensions))), draft.revision)
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Read only an exact source version; never silently substitute the newest record. */
  private sourceRecord(scope: 'equipment' | 'master', id: string, version: number, currentTable: string, historyTable: string, jsonColumn: string): unknown | undefined {
    const current = this.db.prepare(`SELECT ${jsonColumn} AS json FROM ${scope}.${currentTable} WHERE id = ? AND version = ?`).get(id, version)
    const row = current ?? this.db.prepare(`SELECT ${jsonColumn} AS json FROM ${scope}.${historyTable} WHERE id = ? AND version = ?`).get(id, version)
    return row && typeof row.json === 'string' ? JSON.parse(row.json) : undefined
  }

  private currentSource(scope: 'equipment' | 'master', id: string, table: string, jsonColumn: string): unknown | undefined {
    const row = this.db.prepare(`SELECT ${jsonColumn} AS json FROM ${scope}.${table} WHERE id = ?`).get(id)
    return row && typeof row.json === 'string' ? JSON.parse(row.json) : undefined
  }

  private sameFields(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((field, index) => field === right[index])
  }

  private fieldValue(link: ScenarioConfig['links'][number], field: string): unknown {
    if (field === 'antennaGain.tx') return link.antennaGain.tx
    if (field === 'antennaGain.rx') return link.antennaGain.rx
    return (link as unknown as Record<string, unknown>)[field]
  }

  private matchesPrepared(link: ScenarioConfig['links'][number], prepared: ScenarioConfig['links'][number], fields: readonly string[]): boolean {
    return fields.every(field => Object.is(this.fieldValue(link, field), this.fieldValue(prepared, field)))
  }

  private syncParameterSources(previous: ScenarioConfig | undefined, draft: ScenarioDraft): void {
    validatePortParameterSources(previous, draft, {
      equipment: (id, version, historical) => (historical ? this.sourceRecord('equipment', id, version, 'equipment_parameters', 'equipment_history', 'parameters_json') : this.currentSource('equipment', id, 'equipment_parameters', 'parameters_json')) as EquipmentParameter | undefined,
      master: (id, version, historical) => (historical ? this.sourceRecord('master', id, version, 'master_data', 'master_data_history', 'data_json') : this.currentSource('master', id, 'master_data', 'data_json')) as MasterData | undefined,
    })
    for (const { id, old, source, unchanged, target } of portParameterSourceChanges(previous, draft)) {
      if (old?.kind === 'EQUIPMENT' && (!source || source.kind !== old.kind || source.sourceId !== old.sourceId || source.sourceVersion !== old.sourceVersion)) {
        this.db.prepare('DELETE FROM equipment.equipment_references WHERE scenario_id = ? AND link_id = ? AND equipment_id = ?').run(draft.config.scenario.id, id, old.sourceId)
      }
      if (!source || unchanged) continue
      if (source.kind === 'EQUIPMENT') {
        const saved = this.db.prepare(`INSERT INTO equipment.equipment_references (scenario_id, link_id, equipment_id, equipment_version)
          SELECT ?, ?, id, version FROM equipment.equipment_parameters WHERE id = ? AND version = ? AND COALESCE(json_extract(parameters_json, '$.active'), 1) = 1
          ON CONFLICT(scenario_id, link_id) DO UPDATE SET equipment_id = excluded.equipment_id, equipment_version = excluded.equipment_version`)
          .run(draft.config.scenario.id, id, source.sourceId, source.sourceVersion)
        if (saved.changes !== 1) throw new ParameterSourceError('CONFLICT', `${target!.path}.parameterSource`, '端口装备来源已停用或版本已变化。')
      } else this.db.prepare(`INSERT INTO master.master_data_references (data_id, data_version, target_type, target_id, target_version)
        VALUES (?, ?, 'SCENARIO', ?, ?) ON CONFLICT(data_id, data_version, target_type, target_id, target_version) DO NOTHING`)
        .run(source.sourceId, source.sourceVersion, draft.config.scenario.id, String(draft.revision))
    }
    for (const [index, link] of draft.config.links.entries()) {
      const source = readLinkParameterSource(link)
      const oldLink = previous?.links.find(item => item.id === link.id)
      const oldSource = oldLink && readLinkParameterSource(oldLink)
      if (!source) {
        if (oldSource?.kind === 'EQUIPMENT') this.db.prepare('DELETE FROM equipment.equipment_references WHERE scenario_id = ? AND link_id = ? AND equipment_id = ?')
          .run(draft.config.scenario.id, link.id, oldSource.sourceId)
        continue
      }
      const unchanged = oldSource !== undefined && oldSource.kind === source.kind && oldSource.sourceId === source.sourceId
        && oldSource.sourceVersion === source.sourceVersion && oldSource.entryKey === source.entryKey && this.sameFields(oldSource.fields, source.fields)
      if (source.kind === 'EQUIPMENT') this.validateEquipmentSource(link, source, unchanged, draft.config, index)
      else this.validateMasterSource(link, source, unchanged, draft.config, index)

      if (oldSource?.kind === 'EQUIPMENT' && (source.kind !== 'EQUIPMENT' || oldSource.sourceId !== source.sourceId || oldSource.sourceVersion !== source.sourceVersion)) {
        this.db.prepare('DELETE FROM equipment.equipment_references WHERE scenario_id = ? AND link_id = ? AND equipment_id = ?')
          .run(draft.config.scenario.id, link.id, oldSource.sourceId)
      }
      if (source.kind === 'EQUIPMENT' && !unchanged) {
        const saved = this.db.prepare(`INSERT INTO equipment.equipment_references (scenario_id, link_id, equipment_id, equipment_version)
          SELECT ?, ?, id, version FROM equipment.equipment_parameters WHERE id = ? AND version = ?
          AND COALESCE(json_extract(parameters_json, '$.active'), 1) = 1
          ON CONFLICT(scenario_id, link_id) DO UPDATE SET equipment_id = excluded.equipment_id, equipment_version = excluded.equipment_version`)
          .run(draft.config.scenario.id, link.id, source.sourceId, source.sourceVersion)
        if (saved.changes !== 1) throw new ParameterSourceError('CONFLICT', `links[${index}].parameterSource`, '装备来源已停用或版本已变化，请重新选择。')
      } else if (source.kind === 'MASTER_DATA' && !unchanged) {
        this.db.prepare(`INSERT INTO master.master_data_references (data_id, data_version, target_type, target_id, target_version)
          VALUES (?, ?, 'SCENARIO', ?, ?) ON CONFLICT(data_id, data_version, target_type, target_id, target_version) DO NOTHING`)
          .run(source.sourceId, source.sourceVersion, draft.config.scenario.id, String(draft.revision))
      }
    }
    // Links deleted by a newer editor are not visited above; remove only their source-managed reference.
    for (const oldLink of previous?.links ?? []) {
      if (draft.config.links.some(link => link.id === oldLink.id)) continue
      const oldSource = readLinkParameterSource(oldLink)
      if (oldSource?.kind === 'EQUIPMENT') this.db.prepare('DELETE FROM equipment.equipment_references WHERE scenario_id = ? AND link_id = ? AND equipment_id = ?')
        .run(draft.config.scenario.id, oldLink.id, oldSource.sourceId)
    }
  }

  private validateEquipmentSource(link: ScenarioConfig['links'][number], source: LinkParameterSource, unchanged: boolean, config: ScenarioConfig, index: number): void {
    const raw = unchanged
      ? this.sourceRecord('equipment', source.sourceId, source.sourceVersion, 'equipment_parameters', 'equipment_history', 'parameters_json')
      : this.currentSource('equipment', source.sourceId, 'equipment_parameters', 'parameters_json')
    if (!raw || typeof raw !== 'object') throw new ParameterSourceError('CONFLICT', `links[${index}].parameterSource`, '装备来源不存在或版本已变化，请重新选择。')
    const equipment = raw as EquipmentParameter
    if (!unchanged && (equipment.version !== source.sourceVersion || equipment.active === false || equipment.readOnly)) {
      throw new ParameterSourceError('CONFLICT', `links[${index}].parameterSource`, '装备来源已停用、只读或版本已变化，请重新选择。')
    }
    // Historical records are accepted only for an unchanged source and an exact mapped-value match.
    const prepared = prepareLinkEquipment(link, unchanged ? { ...equipment, active: true, readOnly: false } : equipment, config.platforms, unchanged)
    if (!prepared.ok || !this.sameFields(source.fields, prepared.ok ? prepared.fields : []) || !this.matchesPrepared(link, prepared.ok ? prepared.link : link, source.fields)) {
      throw new ParameterSourceError('VALIDATION_FAILED', `links[${index}].parameterSource`, prepared.ok ? '链路参数与所选装备来源不一致，请清除来源后手动编辑。' : prepared.message)
    }
  }

  private validateMasterSource(link: ScenarioConfig['links'][number], source: LinkParameterSource, unchanged: boolean, config: ScenarioConfig, index: number): void {
    const raw = unchanged
      ? this.sourceRecord('master', source.sourceId, source.sourceVersion, 'master_data', 'master_data_history', 'data_json')
      : this.currentSource('master', source.sourceId, 'master_data', 'data_json')
    if (!raw || typeof raw !== 'object') throw new ParameterSourceError('CONFLICT', `links[${index}].parameterSource`, '通用基础数据不存在或版本已变化，请重新选择。')
    const data = raw as MasterData
    if (!unchanged && (data.version !== source.sourceVersion || !data.active)) {
      throw new ParameterSourceError('CONFLICT', `links[${index}].parameterSource`, '通用基础数据已停用或版本已变化，请重新选择。')
    }
    const prepared = prepareLinkMasterData(link, unchanged ? { ...data, active: true } : data, config.platforms, source.entryKey, unchanged)
    if (!prepared.ok || !this.sameFields(source.fields, prepared.ok ? prepared.fields : []) || !this.matchesPrepared(link, prepared.ok ? prepared.link : link, source.fields)) {
      throw new ParameterSourceError('VALIDATION_FAILED', `links[${index}].parameterSource`, prepared.ok ? '链路参数与所选通用基础数据不一致，请清除来源后手动编辑。' : prepared.message)
    }
  }

  close(): void {
    this.db.close()
  }

  delete(id: string, revision: number): boolean {
    return this.db.prepare('DELETE FROM scenarios WHERE id = ? AND revision = ?').run(id, revision).changes === 1
  }
}

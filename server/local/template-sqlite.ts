import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import type { ScenarioConfig, ScenarioTemplate } from '../../src/contracts/domain-models.js'
import { inspectScenarioConfig, inspectScenarioUiExtensions } from '../../src/features/scenarios/scenario-validation.js'
import { inspectTemplateMutation, type TemplateStorage } from '../templates/projection.js'

/** 与场景共用数据库文件，但独立存表；空库不导入演示模板。仅限非敏感开发数据。 */
export class TemplateSqliteStorage implements TemplateStorage {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('模板数据库路径必须为绝对路径。')
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS scenario_templates (
          id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
          name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
          version INTEGER NOT NULL CHECK (version >= 1),
          official INTEGER NOT NULL CHECK (official IN (0, 1)),
          config_json TEXT NOT NULL CHECK (json_valid(config_json)),
          ui_extensions_json TEXT CHECK (ui_extensions_json IS NULL OR json_valid(ui_extensions_json)),
          reference_count INTEGER NOT NULL CHECK (reference_count >= 0)
        ) STRICT;
      `)
      this.load()
    } catch {
      this.db.close()
      throw new Error('模板数据库结构或数据无效，未覆盖已有数据。')
    }
  }

  load(): ScenarioTemplate[] {
    return this.db.prepare('SELECT * FROM scenario_templates ORDER BY id').all().map(row => {
      if (typeof row.id !== 'string' || !row.id.trim() || typeof row.name !== 'string' || !row.name.trim()
        || !Number.isSafeInteger(row.version) || Number(row.version) < 1
        || !Number.isSafeInteger(row.reference_count) || Number(row.reference_count) < 0
        || (row.official !== 0 && row.official !== 1) || typeof row.config_json !== 'string') throw new Error('模板存储结构不正确。')
      const config: unknown = JSON.parse(row.config_json)
      const inspection = inspectScenarioConfig(config, 'read')
      if (!inspection.result.valid) throw new Error('模板配置无效。')
      const template: ScenarioTemplate = {
        templateId: row.id, name: row.name, version: String(row.version), official: row.official === 1,
        config: config as ScenarioConfig, referenceCount: Number(row.reference_count),
      }
      if (row.ui_extensions_json !== null) {
        if (typeof row.ui_extensions_json !== 'string') throw new Error('模板扩展结构不正确。')
        const extensions: unknown = JSON.parse(row.ui_extensions_json)
        const result = inspectScenarioUiExtensions(extensions, template.config.jammers.map(item => item.id), template.config.sensors.map(item => item.id))
        if (!result.result.valid) throw new Error('模板扩展无效。')
        template.uiExtensions = { jammers: result.jammers!, sensors: result.sensors! }
      }
      return template
    })
  }

  save(template: ScenarioTemplate, expectedVersion?: string): boolean {
    const mutation = inspectTemplateMutation({ name: template.name, config: template.config,
      ...(template.uiExtensions === undefined ? {} : { uiExtensions: template.uiExtensions }) })
    if (!mutation.ok || !Number.isSafeInteger(Number(template.version)) || Number(template.version) < 1) throw new Error('模板写入校验失败。')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.db.prepare('SELECT version FROM scenario_templates WHERE id = ?').get(template.templateId)
      const duplicate = this.db.prepare('SELECT id FROM scenario_templates WHERE name = ? AND id <> ?').get(template.name, template.templateId)
      if ((current ? String(current.version) : undefined) !== expectedVersion || duplicate) {
        this.db.exec('ROLLBACK')
        return false
      }
      if (Number(template.version) !== Number(expectedVersion ?? 0) + 1) throw new Error('模板版本必须递增。')
      this.db.prepare(`
        INSERT INTO scenario_templates (id, name, version, official, config_json, ui_extensions_json, reference_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version,
          official = excluded.official, config_json = excluded.config_json,
          ui_extensions_json = excluded.ui_extensions_json, reference_count = excluded.reference_count
      `).run(template.templateId, template.name, Number(template.version), Number(template.official),
        JSON.stringify(template.config), template.uiExtensions === undefined ? null : JSON.stringify(template.uiExtensions), template.referenceCount)
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  delete(templateId: string, expectedVersion: string): boolean {
    // 单条条件删除原子检查版本和引用数，不能删掉另一连接已更新或已引用的模板。
    return this.db.prepare('DELETE FROM scenario_templates WHERE id = ? AND version = ? AND reference_count = 0')
      .run(templateId, Number(expectedVersion)).changes === 1
  }

  close(): void {
    this.db.close()
  }
}

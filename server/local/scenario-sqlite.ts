import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import type { ScenarioConfig, ScenarioDraft } from '../../src/contracts/domain-models.js'
import { inspectScenarioConfig, inspectScenarioUiExtensions } from '../../src/features/scenarios/scenario-validation.js'
import type { ScenarioStorage } from '../scenarios/projection.js'

/** 仅限非敏感开发数据；普通 SQLite 不提供本项目要求的加密或密钥管理。 */
export class ScenarioSqliteStorage implements ScenarioStorage {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('SCENARIO_DB_PATH 必须为绝对路径。')
    this.db = new DatabaseSync(path)
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
    const config: unknown = JSON.parse(row.config_json)
    const inspection = inspectScenarioConfig(config, 'read')
    if (!inspection.result.valid || !inspection.identity || inspection.identity.id !== row.id || inspection.identity.name !== row.name) {
      throw new Error('数据库场景配置校验失败。')
    }
    const uiExtensions: unknown = JSON.parse(row.ui_extensions_json)
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
      this.db.prepare(`
        INSERT INTO scenarios (id, name, config_json, ui_extensions_json, revision)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, config_json = excluded.config_json,
          ui_extensions_json = excluded.ui_extensions_json, revision = excluded.revision
      `).run(draft.config.scenario.id, draft.config.scenario.name, JSON.stringify(draft.config), JSON.stringify(draft.uiExtensions), draft.revision)
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  delete(id: string, revision: number): boolean {
    return this.db.prepare('DELETE FROM scenarios WHERE id = ? AND revision = ?').run(id, revision).changes === 1
  }
}

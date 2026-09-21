import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'

export interface RuntimeFileConfig { eventPath: string | null; positionPath: string | null }

/** 只允许当前本机入口实际使用的两项路径，不读取或保存任意环境变量。 */
export function isRuntimeFileConfig(value: unknown): value is RuntimeFileConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).length === 2 && ['eventPath', 'positionPath'].every(key => Object.hasOwn(row, key)
    && (row[key] === null || (typeof row[key] === 'string' && row[key].length <= 4096 && isAbsolute(row[key]) && !/[\r\n\0]/.test(row[key]))))
}

export class RuntimeConfigSqliteStorage {
  private readonly db: DatabaseSync
  constructor(path: string, environment: RuntimeFileConfig) {
    if (!isAbsolute(path) || !isRuntimeFileConfig(environment)) throw new Error('受控文件配置不正确。')
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS runtime_config (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL, environment TEXT NOT NULL) STRICT;')
      const previous = this.db.prepare('SELECT environment FROM runtime_config WHERE id=1').get()
      const baseline = JSON.stringify(environment)
      // 恢复值持续生效；管理员随后显式修改 .env.local 路径时，下一次启动采用新配置。
      if (!previous || previous.environment !== baseline) this.db.prepare('INSERT INTO runtime_config VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, environment=excluded.environment').run(baseline, baseline)
      this.load()
    } catch (error) { this.db.close(); throw error }
  }
  load(): RuntimeFileConfig {
    const row = this.db.prepare('SELECT value FROM runtime_config WHERE id=1').get()
    const value: unknown = JSON.parse(String(row?.value))
    if (!isRuntimeFileConfig(value)) throw new Error('受控文件配置损坏，未回退到其他来源。')
    return value
  }
  close(): void { this.db.close() }
}

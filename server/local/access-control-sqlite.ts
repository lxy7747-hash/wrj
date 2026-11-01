import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import type { AccessControlConfig } from '../../src/contracts/domain-models.js'
import { isAccessControlConfig } from '../../src/features/admin/access-control.js'

const RETIRED_BATCH_PERMISSION = 'BATCH_LEVEL_III_EXPORT'
const RETIRED_BATCH_MENU = '/batches'

/** Removes only retired batch grants from a stored config without writing it back. */
function withoutRetiredBatchGrants(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const config = value as Record<string, unknown>
  if (!Array.isArray(config.profiles)) return value
  const profiles = config.profiles.map((profile) => {
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return profile
    const candidate = profile as Record<string, unknown>
    const permissions = Array.isArray(candidate.permissions)
      ? candidate.permissions.filter(permission => permission !== RETIRED_BATCH_PERMISSION)
      : candidate.permissions
    const menuPaths = Array.isArray(candidate.menuPaths)
      ? candidate.menuPaths.filter(path => path !== RETIRED_BATCH_MENU)
      : candidate.menuPaths
    return { ...candidate, permissions, menuPaths }
  })
  return { ...config, profiles }
}

/** 独立扩展库，不 ALTER 原账号表；空配置表示保持所有既有权限。 */
export class AccessControlSqliteStorage {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('角色配置库须使用绝对路径。')
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA busy_timeout = 1000; CREATE TABLE IF NOT EXISTS access_control (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, config TEXT NOT NULL) STRICT;')
      this.db.prepare('INSERT OR IGNORE INTO access_control VALUES (1, 1, ?)').run(JSON.stringify({ version: 1, profiles: [], assignments: [] }))
      this.load()
    } catch (error) { this.db.close(); throw error }
  }
  load(): AccessControlConfig {
    const row = this.db.prepare('SELECT * FROM access_control WHERE id=1').get()
    const value: unknown = withoutRetiredBatchGrants(JSON.parse(String(row?.config)))
    if (!isAccessControlConfig(value, 'read') || value.version !== row?.version) throw new Error('角色配置损坏，禁止回退扩大权限。')
    return value
  }
  save(config: AccessControlConfig, expected: number): boolean {
    if (!isAccessControlConfig(config) || config.version !== expected + 1) throw new Error('角色配置版本不正确。')
    return this.db.prepare('UPDATE access_control SET version=?, config=? WHERE id=1 AND version=?').run(config.version, JSON.stringify(config), expected).changes === 1
  }
  close(): void { this.db.close() }
}

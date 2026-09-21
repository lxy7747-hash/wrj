const { mkdtempSync, rmSync } = await import('node:' + 'fs')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { AuthSqliteStorage } = await import('../../server/local/' + 'auth-sqlite.js')
const { ScenarioSqliteStorage } = await import('../../server/local/' + 'scenario-sqlite.js')
const { TemplateSqliteStorage } = await import('../../server/local/' + 'template-sqlite.js')
const { EquipmentSqliteStorage } = await import('../../server/local/' + 'equipment-sqlite.js')
const { AccessControlSqliteStorage } = await import('../../server/local/' + 'access-control-sqlite.js')
const { MasterDataSqliteStorage } = await import('../../server/local/' + 'master-data-sqlite.js')
const { ArchiveSqliteStorage } = await import('../../server/local/' + 'archive-sqlite.js')
const { RuntimeConfigSqliteStorage } = await import('../../server/local/' + 'runtime-config-sqlite.js')
const { SystemBackupSqliteStorage } = await import('../../server/local/' + 'system-backup-sqlite.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
import { EQUIPMENT } from './equipment'
import { LOCAL_ARCHIVE } from './local-archive'

export const BACKUP_TEST_PASSWORD = 'Backup-test-only-2026!'
export function createBackupFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wrj-system-backup-'))
  const path = join(directory, 'scenarios.db')
  const auth = new AuthSqliteStorage(path, BACKUP_TEST_PASSWORD)
  const scenario = new ScenarioSqliteStorage(path)
  const template = new TemplateSqliteStorage(path)
  const equipment = new EquipmentSqliteStorage(join(directory, 'equipment.db'))
  const access = new AccessControlSqliteStorage(join(directory, 'access-control.db'))
  const master = new MasterDataSqliteStorage(join(directory, 'master-data.db'))
  const archive = new ArchiveSqliteStorage(join(directory, 'archives.db'))
  const settings = new RuntimeConfigSqliteStorage(join(directory, 'runtime-config.db'), { eventPath: join(directory, 'events.csv'), positionPath: join(directory, 'position.csv') })
  let time = Date.parse('2026-09-21T00:00:00Z')
  const backup = new SystemBackupSqliteStorage(path, () => new Date(time))
  const draft = new ScenarioProjection().get('SCN-001')
  if (!draft.ok) throw new Error('测试场景缺失。')
  scenario.save(draft.data, undefined)
  equipment.save(structuredClone(EQUIPMENT))
  master.save({ dataId: 'DICT-TEST', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
    content: { name: '测试字典', description: '', entries: [{ key: 'mode', valueType: 'TEXT', value: '原始值' }] } })
  master.addReference({ dataId: 'DICT-TEST', dataVersion: 1, targetType: 'SCENARIO', targetId: 'SCN-001', targetVersion: '1' })
  const archived = archive.register('测试归档', 'admin', structuredClone(LOCAL_ARCHIVE.replay), structuredClone(LOCAL_ARCHIVE.report))
  return { directory, path, auth, scenario, template, equipment, access, master, archive, settings, backup, archived,
    advance: (milliseconds: number) => { time += milliseconds },
    close: () => { backup.close(); settings.close(); archive.close(); master.close(); access.close(); equipment.close(); template.close(); scenario.close(); auth.close(); rmSync(directory, { recursive: true, force: true }) },
  }
}

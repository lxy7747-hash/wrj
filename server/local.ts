import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeScriptText } from './local/script-file.js'
import { createMockServer } from './app.js'
import { readInitialNodes } from './local/afsim-log-reader.js'
import { createPositionReader } from './local/afsim-position-reader.js'
import { readLocalReplay } from './local/afsim-replay-reader.js'
import { AuthSqliteStorage } from './local/auth-sqlite.js'
import { SystemBackupSqliteStorage } from './local/system-backup-sqlite.js'
import { RuntimeConfigSqliteStorage } from './local/runtime-config-sqlite.js'
import { LocalExchangeMonitor } from './local/exchange-monitor.js'
import { EquipmentSqliteStorage } from './local/equipment-sqlite.js'
import { AccessControlSqliteStorage } from './local/access-control-sqlite.js'
import { readLocalReport, exportLocalReport } from './local/report-file.js'
import { ArchiveSqliteStorage } from './local/archive-sqlite.js'
import { MasterDataSqliteStorage } from './local/master-data-sqlite.js'

// 本机路径从忽略的 .env.local 初始化白名单配置库，不写入共享代码或复制凭据。
try {
  loadEnvFile('.env.local')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
const port = Number(process.env.MOCK_PORT ?? '4173')
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RangeError('MOCK_PORT 必须为有效端口号。')
const logPath = process.env.AFSIM_EVENT_LOG_PATH?.trim()
const positionPath = process.env.AFSIM_POSITION_LOG_PATH?.trim()
const scenarioDbPath = process.env.SCENARIO_DB_PATH?.trim()
if (!scenarioDbPath) throw new Error('本机启动必须配置 SCENARIO_DB_PATH，不允许回退到 Mock 登录。')
const authStorage = new AuthSqliteStorage(scenarioDbPath, process.env.AUTH_BOOTSTRAP_PASSWORD)
delete process.env.AUTH_BOOTSTRAP_PASSWORD
// 动态导入保证未配置 SQLite 的原有 Mock/文件入口不加载数据库驱动。
const scenarioStorage = scenarioDbPath
  ? new (await import('./local/scenario-sqlite.js')).ScenarioSqliteStorage(scenarioDbPath)
  : undefined
let templateStorage: import('./templates/projection.js').TemplateStorage & { close(): void } | undefined
try {
  templateStorage = scenarioDbPath
    ? new (await import('./local/template-sqlite.js')).TemplateSqliteStorage(scenarioDbPath)
    : undefined
} catch (error) {
  scenarioStorage?.close()
  throw error
}
// 独立业务库不植入默认参数，初始化后统一纳入完整系统备份。
const equipmentStorage = new EquipmentSqliteStorage(join(dirname(scenarioDbPath), 'equipment.db'), scenarioDbPath)
const accessControlStorage = new AccessControlSqliteStorage(join(dirname(scenarioDbPath), 'access-control.db'))
const archiveStorage = new ArchiveSqliteStorage(join(dirname(scenarioDbPath), 'archives.db'))
// 主数据独立空库；不写入冻结样例。
const masterDataStorage = new MasterDataSqliteStorage(join(dirname(scenarioDbPath), 'master-data.db'))
const runtimeConfig = new RuntimeConfigSqliteStorage(join(dirname(scenarioDbPath), 'runtime-config.db'), { eventPath: logPath || null, positionPath: positionPath || null })
const backupStorage = new SystemBackupSqliteStorage(scenarioDbPath)
const exchangeMonitor = new LocalExchangeMonitor(scenarioDbPath)
let cachedPositionPath: string | null = null
let positionReader: ReturnType<typeof createPositionReader> | undefined
const server = createMockServer({
  port,
  writeScriptText: (script, revision, draft) => writeScriptText(fileURLToPath(new URL('../output/scripts/', import.meta.url)), script, revision, draft),
  loadInitialNodes: () => {
    const { eventPath } = runtimeConfig.load()
    if (!eventPath) throw new Error('尚未配置事件文件路径。')
    return exchangeMonitor.read('INITIAL_NODES', eventPath, () => readInitialNodes(eventPath), value => ({ recordCount: value.nodes.length, issueCount: 0 }))
  },
  loadPositions: () => {
    const config = runtimeConfig.load()
    if (!config.eventPath || !config.positionPath) throw new Error('尚未配置事件或位置文件路径。')
    if (cachedPositionPath !== config.positionPath || !positionReader) { positionReader = createPositionReader(config.positionPath); cachedPositionPath = config.positionPath }
    return exchangeMonitor.read('POSITIONS', config.positionPath, positionReader, value => ({ recordCount: value.recordCount, issueCount: value.issueCount }))
  },
  loadLocalReplay: () => {
    const { eventPath, positionPath: currentPosition } = runtimeConfig.load()
    if (!eventPath) throw new Error('尚未配置事件文件路径。')
    return exchangeMonitor.read('LOCAL_REPLAY', currentPosition ?? eventPath, () => readLocalReplay(eventPath, currentPosition ?? undefined), value => ({ recordCount: value.recordCount, issueCount: value.issueCount }))
  },
  loadExchangeMonitor: () => exchangeMonitor.snapshot(),
  loadLocalReport: () => { const config = runtimeConfig.load(); return readLocalReport(config.eventPath ?? undefined, config.positionPath ?? undefined) },
  exportLocalReport: (report, format, actor) => exportLocalReport(fileURLToPath(new URL('../output/reports/', import.meta.url)), report, format, actor),
  scenarioStorage,
  templateStorage,
  authStorage,
  backupStorage,
  equipmentStorage,
  accessControlStorage,
  archiveStorage,
  masterDataStorage,
})
function closeStorage(): void {
  exchangeMonitor.close()
  backupStorage.close()
  runtimeConfig.close()
  equipmentStorage.close()
  accessControlStorage.close()
  archiveStorage.close()
  masterDataStorage.close()
  authStorage.close()
  scenarioStorage?.close()
  templateStorage?.close()
}
server.httpServer.once('close', closeStorage)
server.httpServer.once('error', closeStorage)
server.httpServer.once('listening', () => {
  backupStorage.start()
  console.log(`本机接口已启动：http://127.0.0.1:${port}；初始位置来源：${logPath ? '真实日志' : 'Mock'}`)
  if (scenarioStorage) console.log('场景与模板存储：SQLite 开发验证（未加密，仅限非敏感测试数据）。')
})

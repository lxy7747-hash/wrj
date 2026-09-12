import { loadEnvFile } from 'node:process'
import { createMockServer } from './app.js'
import { readInitialNodes } from './local/afsim-log-reader.js'
import { createPositionReader } from './local/afsim-position-reader.js'
import { readLocalReplay } from './local/afsim-replay-reader.js'
import { AuthSqliteStorage } from './local/auth-sqlite.js'
import { BackupSqliteStorage } from './local/backup-sqlite.js'

// 本机文件配置与纯 Mock 入口分离；路径只存于忽略的 .env.local，不写入共享代码。
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
const backupStorage = new BackupSqliteStorage(scenarioDbPath)
const server = createMockServer({
  port,
  loadInitialNodes: logPath ? () => readInitialNodes(logPath) : undefined,
  loadPositions: logPath && positionPath ? createPositionReader(positionPath) : undefined,
  loadLocalReplay: logPath ? () => readLocalReplay(logPath, positionPath) : undefined,
  scenarioStorage,
  templateStorage,
  authStorage,
  backupStorage,
})
function closeStorage(): void {
  backupStorage.close()
  authStorage.close()
  scenarioStorage?.close()
  templateStorage?.close()
}
server.httpServer.once('close', closeStorage)
server.httpServer.once('error', closeStorage)
server.httpServer.once('listening', () => {
  console.log(`本机接口已启动：http://127.0.0.1:${port}；初始位置来源：${logPath ? '真实日志' : 'Mock'}`)
  if (scenarioStorage) console.log('场景与模板存储：SQLite 开发验证（未加密，仅限非敏感测试数据）。')
})

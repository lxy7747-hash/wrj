import { loadEnvFile } from 'node:process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeScriptText } from './local/script-file.js'
import { LocalMissionPool, readMissionConcurrency } from './local/mission-pool.js'
import { readMissionRunTimeout } from './local/mission-runner.js'
import { DiskRealtimeJournal } from './local/realtime-journal.js'
import { LocalMissionResults } from './local/mission-results.js'
import { createRunQualityStore } from './local/run-quality.js'
import { createEngineFrameArchive } from './local/engine-frame-archive.js'
import { EngineSnapshotClient, readLinkEngineWsUrl } from './local/engine-snapshot-client.js'
import { MissionLogStreamer } from './local/mission-log-stream.js'
import { MissionPositionStreamer } from './local/mission-position-stream.js'
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
import { readLanConfig } from './local/lan-config.js'
import { createLanSite } from './local/lan-site.js'

// 本机路径从忽略的 .env.local 初始化白名单配置库，不写入共享代码或复制凭据。
try {
  if (process.env.WRJ_DEPLOYMENT !== 'lan') loadEnvFile('.env.local')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
const lan = process.env.WRJ_DEPLOYMENT === 'lan' ? await readLanConfig(process.env) : undefined
const port = lan?.port ?? Number(process.env.MOCK_PORT ?? '4173')
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RangeError('MOCK_PORT 必须为有效端口号。')
const missionConcurrency = readMissionConcurrency(process.env.MISSION_MAX_PARALLEL_TASKS)
const missionRunTimeoutMs = readMissionRunTimeout(process.env.MISSION_RUN_TIMEOUT_SECONDS)
const logPath = process.env.AFSIM_EVENT_LOG_PATH?.trim()
const positionPath = process.env.AFSIM_POSITION_LOG_PATH?.trim()
const scenarioDbPath = process.env.SCENARIO_DB_PATH?.trim()
if (!scenarioDbPath) throw new Error('本机启动必须配置 SCENARIO_DB_PATH，不允许回退到 Mock 登录。')
const authStorage = new AuthSqliteStorage(scenarioDbPath, process.env.AUTH_BOOTSTRAP_PASSWORD)
delete process.env.AUTH_BOOTSTRAP_PASSWORD
const localDataDirectory = dirname(scenarioDbPath)
const equipmentDbPath = join(localDataDirectory, 'equipment.db')
const masterDataDbPath = join(localDataDirectory, 'master-data.db')
// 动态导入保证未配置 SQLite 的原有 Mock/文件入口不加载数据库驱动。
const scenarioStorage = scenarioDbPath
  ? new (await import('./local/scenario-sqlite.js')).ScenarioSqliteStorage(scenarioDbPath, { equipmentPath: equipmentDbPath, masterDataPath: masterDataDbPath })
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
const equipmentStorage = new EquipmentSqliteStorage(equipmentDbPath, scenarioDbPath)
const accessControlStorage = new AccessControlSqliteStorage(join(localDataDirectory, 'access-control.db'))
const archiveStorage = new ArchiveSqliteStorage(join(localDataDirectory, 'archives.db'))
// 通用数据独立空库；不写入冻结样例。
const masterDataStorage = new MasterDataSqliteStorage(masterDataDbPath)
const runtimeConfig = new RuntimeConfigSqliteStorage(join(localDataDirectory, 'runtime-config.db'), { eventPath: logPath || null, positionPath: positionPath || null })
const backupStorage = new SystemBackupSqliteStorage(scenarioDbPath)
const exchangeMonitor = new LocalExchangeMonitor(scenarioDbPath)
let cachedPositionPath: string | null = null
let positionReader: ReturnType<typeof createPositionReader> | undefined
const missionResults = new LocalMissionResults(lan ? join(lan.outputRoot, 'results') : fileURLToPath(new URL('../output/results/', import.meta.url)))
const runQualityStore = createRunQualityStore(lan ? join(lan.outputRoot, 'quality') : fileURLToPath(new URL('../output/quality/', import.meta.url)), () => new Date().toISOString())
const engineFrameArchive = createEngineFrameArchive(lan ? join(lan.outputRoot, 'engine-frames') : fileURLToPath(new URL('../output/engine-frames/', import.meta.url)), () => new Date().toISOString())
const missionDirectory = lan ? join(lan.outputRoot, 'mission-runs') : fileURLToPath(new URL('../output/mission-runs/', import.meta.url))
const missionExecutable = lan?.executable ?? (process.env.MISSION_EXECUTABLE_PATH?.trim() || fileURLToPath(new URL('../../Release/Release/mission.exe', import.meta.url)))
const linkEngineWsUrl = lan?.linkEngineWsUrl ?? readLinkEngineWsUrl(process.env.LINK_ENGINE_WS_URL)
const missionExecution = linkEngineWsUrl ? undefined : lan?.webOnly
  ? { start: async () => { throw new Error('当前是仅网页部署，仿真引擎尚未部署。') } }
  : new LocalMissionPool(missionExecutable, missionDirectory, missionResults, missionConcurrency, missionRunTimeoutMs)
const server = createMockServer({
  missionResults,
  runQualityStore,
  engineFrameArchive,
  createRunId: () => `RUN-${randomUUID()}`,
  realtimeJournal: new DiskRealtimeJournal(lan ? join(lan.outputRoot, 'ws-journal') : fileURLToPath(new URL('../output/ws-journal/', import.meta.url)), 128),
  port,
  ...(lan ? { publicOrigin: lan.publicOrigin, host: lan.host, site: createLanSite(lan.webRoot, lan.tilePort) } : {}),
  missionExecution,
  createMissionLogStreamer: (...args) => new MissionLogStreamer(...args),
  createMissionPositionStreamer: (...args) => new MissionPositionStreamer(...args),
  linkEngineWsUrl,
  remoteEngineNow: () => new Date().toISOString(),
  createEngineSnapshotClient: (url, publish, diagnose) => new EngineSnapshotClient(url, publish, undefined, diagnose),
  writeScriptText: (script, revision, draft) => writeScriptText(lan ? join(lan.outputRoot, 'scripts') : fileURLToPath(new URL('../output/scripts/', import.meta.url)), script, revision, draft),
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
  exportLocalReport: (report, format, actor, source, comparisons, filter) => exportLocalReport(lan ? join(lan.outputRoot, 'reports') : fileURLToPath(new URL('../output/reports/', import.meta.url)), report, format, actor, source, comparisons, filter),
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
  for (const storage of [exchangeMonitor, backupStorage, runtimeConfig, equipmentStorage,
    accessControlStorage, archiveStorage, masterDataStorage, authStorage, scenarioStorage, templateStorage]) {
    try { storage?.close() } catch (error) {
      console.error('本机存储关闭失败：', error)
      process.exitCode = 1
    }
  }
}
server.httpServer.once('close', closeStorage)
server.httpServer.once('error', error => {
  console.error('本机 HTTP 服务异常：', error)
  void server.close().catch(closeError => { console.error('本机服务停止失败：', closeError); process.exitCode = 1 })
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().catch(error => { console.error('本机服务停止失败：', error); process.exitCode = 1 })
  })
}
// Windows 启动器通过 IPC 请求正常关闭，避免直接终止 Node 后遗留 mission 进程。
if (lan && process.connected) {
  process.on('message', message => {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'shutdown') {
      void server.close().catch(error => { console.error('服务停止失败：', error); process.exitCode = 1 })
        .finally(() => { if (process.connected) process.disconnect() })
    }
  })
}
server.httpServer.once('listening', () => {
  backupStorage.start()
  console.log(`接口已启动：${lan?.publicOrigin ?? `http://127.0.0.1:${port}`}；初始位置来源：${logPath ? '配置的事件文件' : '尚未配置事件文件'}`)
  if (scenarioStorage) console.log('场景与模板存储：SQLite 开发验证（未加密，仅限非敏感测试数据）。')
  if (lan && process.connected) process.send?.({ type: 'ready' }, () => {})
})

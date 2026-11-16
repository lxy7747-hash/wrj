import { loadEnvFile } from 'node:process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeScriptText } from './local/script-file.js'
import { LocalMissionPool, readMissionConcurrency } from './local/mission-pool.js'
import { readMissionRunTimeout } from './local/mission-runner.js'
import { DiskRealtimeJournal } from './local/realtime-journal.js'
import { LocalMissionResults } from './local/mission-results.js'
import { createRunQualityStore } from './local/run-quality.js'
import { createRunEvidenceStore } from './local/run-evidence.js'
import { createEngineFrameArchive } from './local/engine-frame-archive.js'
import { EngineFrameSqliteStorage } from './local/engine-frame-sqlite.js'
import { JammerPlanSqliteStorage } from './local/jammer-plan-sqlite.js'
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
import { registerPublishedParameterSources } from './local/equipment-publish.js'
import { AccessControlSqliteStorage } from './local/access-control-sqlite.js'
import { readLocalReport, exportLocalReport, exportEvidenceReport } from './local/report-file.js'
import { ArchiveSqliteStorage } from './local/archive-sqlite.js'
import { MasterDataSqliteStorage } from './local/master-data-sqlite.js'
import { readLanConfig } from './local/lan-config.js'
import { readDeploymentAccess } from './http/loopback.js'
import { createLanSite } from './local/lan-site.js'
import { readEngineConfig } from './local/engine-config.js'
import { syncLocalLinkCalcConfig } from './local/link-calc-config.js'
import { resolveOutputRoot, resolveScriptOutputRoot } from './local/output-root.js'

// 本机路径和引擎模式统一读取 .env.local；凭据仅通过进程环境提供。
try {
  if (process.env.WRJ_DEPLOYMENT !== 'lan') loadEnvFile('.env.local')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
const lan = process.env.WRJ_DEPLOYMENT === 'lan' ? await readLanConfig(process.env) : undefined
const port = lan?.port ?? Number(process.env.MOCK_PORT ?? '4173')
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RangeError('MOCK_PORT 必须为有效端口号。')
// 离线包启动器读取 deployment.env 后传入；未传入时保持仅 127.0.0.1 访问。
const deploymentAccess = lan ? undefined : readDeploymentAccess(process.env, port)
const missionConcurrency = readMissionConcurrency(process.env.MISSION_MAX_PARALLEL_TASKS)
const missionRunTimeoutMs = readMissionRunTimeout(process.env.MISSION_RUN_TIMEOUT_SECONDS)
// 本地 mission 运行包内的事件/位置输出子目录：必须是包内相对路径；未配置时沿用场景 output.directory（默认 output）。
const missionOutputDirectory = process.env.WRJ_MISSION_OUTPUT_DIR?.trim() || undefined
const logPath = process.env.AFSIM_EVENT_LOG_PATH?.trim()
const positionPath = process.env.AFSIM_POSITION_LOG_PATH?.trim()
const scenarioDbPath = process.env.SCENARIO_DB_PATH?.trim()
if (!scenarioDbPath) throw new Error('本机启动必须配置 SCENARIO_DB_PATH，不允许回退到 Mock 登录。')
const authStorage = new AuthSqliteStorage(scenarioDbPath, process.env.AUTH_BOOTSTRAP_PASSWORD)
delete process.env.AUTH_BOOTSTRAP_PASSWORD
const localDataDirectory = dirname(scenarioDbPath)
const equipmentDbPath = join(localDataDirectory, 'equipment.db')
const masterDataDbPath = join(localDataDirectory, 'master-data.db')
// 输出根目录由启动器按 deployment.env 传入；未配置时保持原有包内输出。
const outputRoot = lan?.outputRoot ?? resolveOutputRoot(process.env.WRJ_OUTPUT_ROOT, fileURLToPath(new URL('../output/', import.meta.url)))
// 生成脚本包目录单独可配，未配置时保持 <输出根>/scripts；运行包仍在 <输出根>/mission-runs。
const scriptOutputRoot = lan?.scriptOutputRoot ?? resolveScriptOutputRoot(process.env.WRJ_SCRIPT_OUTPUT_ROOT, join(outputRoot, 'scripts'))
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
const equipmentStorage = new EquipmentSqliteStorage(equipmentDbPath, scenarioDbPath, () => authStorage.time())
const accessControlStorage = new AccessControlSqliteStorage(join(localDataDirectory, 'access-control.db'))
const archiveStorage = new ArchiveSqliteStorage(join(localDataDirectory, 'archives.db'))
// 通用数据独立空库；不写入冻结样例。
const masterDataStorage = new MasterDataSqliteStorage(masterDataDbPath)
const runtimeConfig = new RuntimeConfigSqliteStorage(join(localDataDirectory, 'runtime-config.db'), { eventPath: logPath || null, positionPath: positionPath || null })
const backupStorage = new SystemBackupSqliteStorage(scenarioDbPath)
const exchangeMonitor = new LocalExchangeMonitor(scenarioDbPath)
let cachedPositionPath: string | null = null
let positionReader: ReturnType<typeof createPositionReader> | undefined
const missionResults = new LocalMissionResults(join(outputRoot, 'results'), (draft, record) => {
  // 归档发布（任务结果快照）时登记装备来源，固定设备版本与归档目标身份；返回本次新增项供提交失败时撤销。
  return registerPublishedParameterSources(draft.config, { targetType: 'ARCHIVE', targetId: record.resultId, targetVersion: String(record.revision) }, new Date().toISOString(),
    reference => equipmentStorage.addPublishedReference(reference), reference => equipmentStorage.removePublishedReference(reference))
}, references => {
  // 结果文件重命名失败：只撤销本次登记，不删除已发布的不可变结果。
  for (const reference of references) equipmentStorage.removePublishedReference(reference)
})
const runQualityStore = createRunQualityStore(join(outputRoot, 'quality'), () => new Date().toISOString())
const runEvidenceStore = createRunEvidenceStore(join(outputRoot, 'evidence'), () => new Date().toISOString())
const engineFrameDatabase = new EngineFrameSqliteStorage(join(localDataDirectory, 'engine-history.db'))
const jammerPlanStorage = new JammerPlanSqliteStorage(join(localDataDirectory, 'jammer-plans.db'))
const engineFrameArchive = createEngineFrameArchive(join(outputRoot, 'engine-frames'), () => new Date().toISOString(), { database: engineFrameDatabase })
const missionDirectory = join(outputRoot, 'mission-runs')
const missionExecutable = lan?.executable ?? (process.env.MISSION_EXECUTABLE_PATH?.trim() || fileURLToPath(new URL('../../Release/Release/mission.exe', import.meta.url)))
// 本机模式点击“开始”必定执行 mission，启动时先确认程序存在，避免点击后才失败；LAN 仅网页模式除外。
if (!lan?.webOnly && !statSync(missionExecutable, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`本机 mission 程序不存在：${missionExecutable}。请检查 MISSION_EXE_PATH 或包内 afsim/Release/mission.exe。`)
}
// useRealEngine 只决定是否连接外部 WebSocket 数据源：true 连接 realUrl/LINK_ENGINE_WS_URL，false 不建立外部连接。
// 任务执行与 WebSocket 无关：非 LAN 部署点击“开始”始终在本机运行 mission.exe；LAN 部署保持原有 .env.server 行为。
const engineConfig = readEngineConfig(lan ? {} : process.env)
const linkEngineWsUrl = lan ? lan.linkEngineWsUrl
  : engineConfig.useRealEngine
    ? readLinkEngineWsUrl(process.env.LINK_ENGINE_WS_URL) ?? engineConfig.realUrl
    : undefined
// 本机 mission 默认使用 local_link_stub，避免依赖部署机外部 LinkCalc 插件及其 WS 地址；设 WRJ_LINK_CALC_MODE=auto 可恢复探测。
const forceLinkStub = !lan && (process.env.WRJ_LINK_CALC_MODE?.trim().toLowerCase() ?? 'stub') !== 'auto'
if (!lan && !forceLinkStub) await syncLocalLinkCalcConfig(missionExecutable, linkEngineWsUrl)
const missionExecution = lan?.webOnly
  ? { start: async () => { throw new Error('当前是仅网页部署，仿真引擎尚未部署。') } }
  : lan && linkEngineWsUrl
    ? undefined
    : new LocalMissionPool(missionExecutable, missionDirectory, missionResults, missionConcurrency, missionRunTimeoutMs, missionOutputDirectory, forceLinkStub)
const server = createMockServer({
  missionResults,
  saveFileReception: async (run, completedAt, lastFrameTime, parameters) => {
    const { eventPath, positionPath } = runtimeConfig.load()
    if (!eventPath || !positionPath) throw new Error('缺少本次播放文件路径。')
    await missionResults.captureFileReception(eventPath, positionPath, run, completedAt, lastFrameTime, parameters)
  },
  runQualityStore,
  runEvidenceStore,
  engineFrameArchive,
  createRunId: () => `RUN-${randomUUID()}`,
  realtimeJournal: new DiskRealtimeJournal(join(outputRoot, 'ws-journal'), 128),
  port,
  ...(lan ? { publicOrigin: lan.publicOrigin, host: lan.host, site: createLanSite(lan.webRoot, lan.tilePort) } : {}),
  ...(deploymentAccess ? { access: deploymentAccess } : {}),
  missionExecution,
  missionClock: {
    now: Date.now,
    schedule(delayMs, callback) {
      const timer = setTimeout(callback, delayMs).unref()
      return () => clearTimeout(timer)
    },
  },
  createMissionLogStreamer: (...args) => new MissionLogStreamer(...args),
  createMissionPositionStreamer: (...args) => new MissionPositionStreamer(...args),
  linkEngineWsUrl,
  remoteEngineNow: () => new Date().toISOString(),
  createEngineSnapshotClient: (url, publish, diagnose) => new EngineSnapshotClient(url, publish, undefined, diagnose),
  writeScriptText: (script, revision, draft) => writeScriptText(scriptOutputRoot, script, revision, draft),
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
  exportLocalReport: (report, format, actor, source, comparisons, filter) => exportLocalReport(join(outputRoot, 'reports'), report, format, actor, source, comparisons, filter),
  exportReportEvidence: (input) => exportEvidenceReport(join(outputRoot, 'reports'), input),
  scenarioStorage,
  templateStorage,
  authStorage,
  backupStorage,
  equipmentStorage,
  accessControlStorage,
  archiveStorage,
  masterDataStorage,
  jammerPlanStorage,
})
function closeStorage(): void {
  for (const storage of [engineFrameDatabase, exchangeMonitor, backupStorage, runtimeConfig, equipmentStorage,
    accessControlStorage, archiveStorage, masterDataStorage, authStorage, scenarioStorage, templateStorage, jammerPlanStorage]) {
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
if ((lan || deploymentAccess) && process.connected) {
  process.on('message', message => {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'shutdown') {
      void server.close().catch(error => { console.error('服务停止失败：', error); process.exitCode = 1 })
        .finally(() => { if (process.connected) process.disconnect() })
    }
  })
}
server.httpServer.once('listening', () => {
  backupStorage.start()
  console.log(`接口已启动：${lan?.publicOrigin ?? `http://${deploymentAccess?.deployHost ?? '127.0.0.1'}:${port}`}；初始位置来源：${logPath ? '配置的事件文件' : '尚未配置事件文件'}`)
  console.log(`输出目录：${outputRoot}；脚本输出目录：${scriptOutputRoot}；任务执行：${linkEngineWsUrl ? (lan?.linkEngineWsUrl ? '远端引擎' : '进程内模拟引擎') : '本机 mission'}${missionExecution && !linkEngineWsUrl ? `（${missionExecutable}）` : ''}`)
  if (scenarioStorage) console.log('场景与模板存储：SQLite 开发验证（未加密，仅限非敏感测试数据）。')
  if ((lan || deploymentAccess) && process.connected) process.send?.({ type: 'ready' }, () => {})
})

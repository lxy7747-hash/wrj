// 离线包一键启动器：读取部署根目录的 deployment.env，依次启动地图、接口和页面服务。
// 所有路径按启动器所在目录解析（<部署根>/frontend/scripts），不依赖当前工作目录或系统 PATH 中的 Node。
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { apiAccessEnv, portEntries, readDeploymentConfig, runtimeConfigBody } from './deployment-config.mjs'
import { upgradeDeploymentConfigV10 } from './deployment-config-upgrade-v10.mjs'

const MAP_SOURCES = ['china-taiwan-260823', 'taiwan-strait-satellite']
const MAP_READY_TIMEOUT_MS = 30_000
const API_READY_TIMEOUT_MS = 180_000
const API_STOP_TIMEOUT_MS = 15_000

/** 部署包内的固定相对布局。 */
export function packageLayout(root) {
  const frontend = join(root, 'frontend')
  return {
    frontend,
    dist: join(frontend, 'dist'),
    versatiles: join(root, '_tools', 'versatiles', 'versatiles.exe'),
    maps: MAP_SOURCES.map(id => join(frontend, 'map', `${id}.pmtiles`)),
    database: join(root, 'data', 'scenarios.db'),
    output: join(frontend, 'output'),
    eventLog: join(root, 'history', 'scenario_events.csv'),
    positionLog: join(root, 'history', 'position.csv'),
    mission: join(root, 'afsim', 'Release', 'mission.exe'),
  }
}

async function isFile(path) {
  try { return (await stat(path)).isFile() } catch { return false }
}

/** 预检目录可用性：不存在则创建，并实际写入一个探针文件后删除。 */
async function ensureWritableDirectory(path, label) {
  try {
    await mkdir(path, { recursive: true })
    const probe = join(path, `.wrj-write-probe-${process.pid}-${Date.now()}`)
    await writeFile(probe, '')
    await rm(probe, { force: true })
  } catch (error) {
    throw new Error(`${label}不可写：${path}（${error.message}）`)
  }
}

/** 以独占方式试绑定端口；占用时只报告原因，不查找或终止占用进程。 */
export function assertPortFree(host, port, label) {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', error => reject(new Error(`${label}端口 ${port} 在 ${host} 上不可用（${error.code ?? error.message}）。请关闭占用该端口的程序或修改 deployment.env；启动器不会终止其他进程。`)))
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolvePort()))
  })
}

/** 0.0.0.0 监听时同时检查回环与部署地址，避免 Windows 上与已占用的具体地址并存。 */
export async function checkPorts(config) {
  const hosts = [...new Set([config.listenHost, ...(config.listenHost === '0.0.0.0' ? ['127.0.0.1', config.deployHost] : [])])]
  for (const { label, port } of portEntries(config)) {
    for (const host of hosts) await assertPortFree(host, port, label)
  }
}

/**
 * 启动部署服务。
 * @param root 部署根目录（deployment.env 与 start.cmd 所在目录）。
 * @returns 停止函数与就绪状态，供测试和信号处理使用。
 */
export async function startDeployment(root, { log = console.log, error: logError = console.error, handleSignals = false } = {}) {
  const children = []
  let ui
  let stopping = false
  let stopPromise
  let rejectStartup = () => {}
  const startupFailure = new Promise((_, reject) => { rejectStartup = reject })
  startupFailure.catch(() => {})

  /** 只停止本次启动器拥有的子进程与页面服务。 */
  const stop = (code) => {
    if (stopPromise) return stopPromise
    stopping = true
    process.exitCode = code
    stopPromise = (async () => {
      try { await ui?.close() } catch (closeError) { logError(`页面服务关闭失败：${closeError.message}`) }
      await Promise.all(children.map(({ child, label }) => new Promise(done => {
        if (child.exitCode !== null || child.signalCode !== null) { done(); return }
        const timer = setTimeout(() => { logError(`${label}未按时退出，执行兜底终止。`); child.kill() }, API_STOP_TIMEOUT_MS)
        child.once('exit', () => { clearTimeout(timer); done() })
        if (child.connected) child.send({ type: 'shutdown' }, sendError => { if (sendError) child.kill() })
        else child.kill()
      })))
    })()
    return stopPromise
  }

  const track = (child, label) => {
    children.push({ child, label })
    child.once('error', spawnError => {
      if (stopping) return
      rejectStartup(new Error(`${label}启动失败：${spawnError.message}`))
      logError(`${label}启动失败：${spawnError.message}`)
      void stop(1)
    })
    child.once('exit', (code, signal) => {
      if (stopping) return
      const message = `${label}已退出（退出码 ${code ?? '无'}${signal ? `，信号 ${signal}` : ''}），停止本次启动的其他服务。`
      rejectStartup(new Error(message))
      logError(message)
      void stop(code || 1)
    })
    return child
  }

  const race = (promise) => Promise.race([promise, startupFailure])
  if (handleSignals) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.once(signal, () => { void stop(0) })
    // 与 start-lan.mjs 一致：由父进程经 IPC 请求正常关闭（Windows 无法向子进程发送 Ctrl+C）。
    if (process.connected) process.on('message', message => {
      if (message?.type === 'shutdown') void stop(0).finally(() => { if (process.connected) process.disconnect() })
    })
  }

  try {
    const config = await readDeploymentConfig(root)
    const layout = packageLayout(root)
    // 可选路径：留空时使用包内默认目录，配置后运行目录/数据库/mission 都可落在包外。
    const database = config.dataDir ? join(config.dataDir, 'scenarios.db') : layout.database
    const mission = config.missionExe ?? layout.mission
    const outputRoot = config.outputRoot ?? layout.output
    // 生成脚本包目录可选；留空时与原来一样落在 <输出根>/scripts。
    const scriptOutputRoot = config.scriptOutputRoot ?? join(outputRoot, 'scripts')
    // 本机 mission 运行包内的事件/位置输出子目录；留空时沿用场景 output.directory（默认 output）。
    const missionOutputDir = config.missionOutputDir
    const required = [
      [join(layout.dist, 'index.html'), '页面构建产物'],
      [layout.versatiles, '地图服务程序'],
      ...layout.maps.map(path => [path, '离线地图文件']),
      [database, '账号与场景数据库'],
      [join(layout.frontend, 'server', 'local.ts'), '接口服务入口'],
      [mission, 'mission 程序'],
    ]
    for (const [path, label] of required) if (!(await isFile(path))) throw new Error(`${label}缺失：${path}`)
    await ensureWritableDirectory(outputRoot, '输出目录')
    await ensureWritableDirectory(scriptOutputRoot, '脚本输出目录')
    await ensureWritableDirectory(dirname(database), '数据库目录')
    await checkPorts(config)
    const tilesEnv = { ...process.env }
    delete tilesEnv.AUTH_BOOTSTRAP_PASSWORD
    log(config.configured
      ? `已读取 ${join(root, 'deployment.env')}：${config.lan ? '局域网' : '仅本机'}模式，部署地址 ${config.deployHost}。`
      : '未找到 deployment.env，按原有方式仅允许本机 127.0.0.1 访问。')
    log(`运行目录：输出 ${outputRoot}；脚本 ${scriptOutputRoot}；数据库 ${database}；任务执行：本机 mission（${mission}）${missionOutputDir ? `；mission 输出子目录 ${missionOutputDir}` : ''}`)

    const contracts = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/validate-contracts.ts'], {
      cwd: layout.frontend, stdio: 'inherit', windowsHide: true, env: tilesEnv,
    })
    if (contracts.error) throw contracts.error
    if (contracts.status !== 0) throw new Error(`合同校验未通过（退出码 ${contracts.status}）。`)
    if (stopping) throw new Error('启动已取消。')

    const configurationBackup = await upgradeDeploymentConfigV10(root)
    if (configurationBackup) log(`v10 配置已自动合并，原配置备份：${configurationBackup}；部署 IP、路径及其他参数保留。`)
    if (stopping) throw new Error('启动已取消。')

    // 地图服务：监听配置地址；TileJSON 的瓦片地址为相对路径，远程客户端不会收到 127.0.0.1。
    track(spawn(layout.versatiles, ['serve', '-i', config.listenHost, '-p', String(config.mapPort), ...layout.maps], {
      cwd: root, env: tilesEnv, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'],
    }), '地图服务')
    await race(waitForMaps(config, () => stopping))

    const apiEnv = {
      ...process.env,
      ...apiAccessEnv(config),
      SCENARIO_DB_PATH: database,
      MISSION_EXECUTABLE_PATH: mission,
      WRJ_OUTPUT_ROOT: outputRoot,
      WRJ_SCRIPT_OUTPUT_ROOT: scriptOutputRoot,
      ...(await isFile(layout.eventLog) ? { AFSIM_EVENT_LOG_PATH: layout.eventLog } : {}),
      ...(await isFile(layout.positionLog) ? { AFSIM_POSITION_LOG_PATH: layout.positionLog } : {}),
    }
    // 已有账号库不重新初始化；部署模式只由本启动器决定。
    delete apiEnv.AUTH_BOOTSTRAP_PASSWORD
    delete apiEnv.WRJ_DEPLOYMENT
    delete apiEnv.WRJ_PUBLIC_ORIGIN
    // 只由启动器决定 mission 输出子目录，避免继承开发机环境变量。
    delete apiEnv.WRJ_MISSION_OUTPUT_DIR
    if (missionOutputDir) apiEnv.WRJ_MISSION_OUTPUT_DIR = missionOutputDir
    const api = track(spawn(process.execPath, ['--import', 'tsx', 'server/local.ts'], {
      cwd: layout.frontend, env: apiEnv, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }), '接口服务')
    // 就绪超时定时器必须随启动失败一起清理，否则失败后进程会滞留到超时结束才退出。
    let apiReadyTimer
    const apiReady = new Promise((ready, reject) => {
      apiReadyTimer = setTimeout(() => reject(new Error('接口服务未在规定时间内就绪。')), API_READY_TIMEOUT_MS)
      api.on('message', message => { if (message?.type === 'ready') { clearTimeout(apiReadyTimer); ready() } })
    })
    try {
      await race(apiReady)
    } catch (readyError) {
      clearTimeout(apiReadyTimer)
      throw readyError
    }

    const { preview } = await import(pathToFileURL(join(layout.frontend, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href)
    const body = runtimeConfigBody(config)
    ui = await race(preview({
      root: layout.frontend,
      configFile: false,
      logLevel: 'warn',
      build: { outDir: 'dist' },
      preview: { host: config.listenHost, port: config.uiPort, strictPort: true, open: false, allowedHosts: [config.deployHost, '127.0.0.1'] },
      plugins: [{
        name: 'wrj-deployment-runtime-config',
        configurePreviewServer(server) {
          server.middlewares.use('/runtime-config.json', (_req, res) => {
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.setHeader('Cache-Control', 'no-store')
            res.end(body)
          })
        },
      }],
    }))
    if (stopping) throw new Error('启动已取消。')

    const urls = []
    if (config.listenHost === '0.0.0.0' || config.listenHost.startsWith('127.')) urls.push(`本机访问：http://${config.listenHost === '0.0.0.0' ? '127.0.0.1' : config.listenHost}:${config.uiPort}`)
    if (config.lan) urls.push(`局域网访问：http://${config.deployHost}:${config.uiPort}`)
    log(['服务已就绪。', ...urls.map(url => `  ${url}`), '保持此窗口打开；按 Ctrl+C 停止本次启动的服务。'].join('\n'))
    return { config, stop: () => stop(0) }
  } catch (startError) {
    logError(`启动失败：${startError.message}`)
    await stop(1)
    // 由父进程经 IPC 启动时，断开通道以便本进程在启动失败后退出。
    if (handleSignals && process.connected) process.disconnect()
    return { config: undefined, stop: () => stop(1) }
  }
}

/** 等待两份地图 TileJSON 就绪，并确认瓦片模板是相对路径。 */
async function waitForMaps(config, cancelled) {
  const deadline = Date.now() + MAP_READY_TIMEOUT_MS
  while (Date.now() < deadline && !cancelled()) {
    try {
      const checks = await Promise.all(MAP_SOURCES.map(async id => {
        const response = await fetch(`http://${config.deployHost}:${config.mapPort}/tiles/${id}/tiles.json`, { signal: AbortSignal.timeout(1000) })
        if (!response.ok) return false
        const metadata = await response.json()
        if (!Array.isArray(metadata?.bounds) || !Array.isArray(metadata?.tiles)) return false
        if (!metadata.tiles.every(tile => typeof tile === 'string' && tile.startsWith('/'))) throw new Error('地图 TileJSON 含绝对瓦片地址，已停止启动。')
        return true
      }))
      if (checks.every(Boolean)) return
    } catch (probeError) {
      if (probeError.message.includes('TileJSON')) throw probeError
    }
    await delay(250)
  }
  throw new Error(cancelled() ? '启动已取消。' : '地图服务未能按时就绪。')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startDeployment(join(import.meta.dirname, '..', '..'), { handleSignals: true })
}

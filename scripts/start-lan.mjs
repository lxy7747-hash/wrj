import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startTiles } from './start-tiles.mjs'

const root = join(import.meta.dirname, '..')
const children = []
let stopping = false

function stopAll(code) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  // 只停止本次直接启动的子进程，不按进程名称或端口查杀其他服务。
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    if (child.connected) {
      child.send({ type: 'shutdown' }, error => { if (error) child.kill() })
      const timeout = setTimeout(() => { console.error('Web 服务未按时退出，执行兜底终止。'); child.kill() }, 15_000)
      timeout.unref()
      child.once('exit', () => clearTimeout(timeout))
    } else child.kill()
  }
}

function track(child, label) {
  children.push(child)
  child.once('error', error => { console.error(`${label}启动失败：${error.message}`); stopAll(1) })
  child.once('exit', code => {
    if (!stopping) { console.error(`${label}已退出（${code}），停止关联服务。`); stopAll(code || 1) }
  })
  return child
}

async function requireFreePort(port, host) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('部署端口必须是 1–65535 的整数。')
  await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(port, host, () => probe.close(error => error ? reject(error) : resolve()))
  })
}

try {
  if (process.env.WRJ_DEPLOYMENT !== 'lan') throw new Error('.env.server 必须设置 WRJ_DEPLOYMENT=lan。')
  const mapPort = Number(process.env.WRJ_MAP_PORT ?? '4174')
  const webPort = Number(process.env.WRJ_PORT ?? '8080')
  if (mapPort === webPort) throw new Error('Web 入口和地图服务不能使用相同端口。')
  await access(join(root, 'server-dist', 'server.mjs'))
  await requireFreePort(webPort, process.env.WRJ_HOST || '0.0.0.0')
  await requireFreePort(mapPort, '127.0.0.1')
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stopAll(0))
  if (process.connected) process.on('message', message => {
    if (message?.type === 'shutdown') { stopAll(0); process.disconnect() }
  })
  track(await startTiles(), '地图服务')
  let ready = false
  for (let attempt = 0; attempt < 30 && !stopping; attempt++) {
    try {
      const sources = ['china-taiwan-260823', 'taiwan-strait-satellite']
      const checks = await Promise.all(sources.map(async source => {
        const response = await fetch(`http://127.0.0.1:${mapPort}/tiles/${source}/tiles.json`, { signal: AbortSignal.timeout(1000) })
        const metadata = response.ok ? await response.json() : null
        return metadata !== null && typeof metadata === 'object' && Array.isArray(metadata.bounds)
      }))
      if (checks.every(Boolean)) { ready = true; break }
    } catch { /* 地图服务可能尚未完成监听。 */ }
    await delay(250)
  }
  if (stopping) throw new Error('部署启动已取消。')
  if (!ready) throw new Error('两份地图资源未能按时就绪。')
  track(spawn(process.execPath, [join(root, 'server-dist', 'server.mjs')], {
    cwd: root, env: process.env, shell: false, windowsHide: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  }), 'Web 服务')
  // 后端已继承所需配置，启动器无需继续保留初始化密码。
  delete process.env.AUTH_BOOTSTRAP_PASSWORD
} catch (error) {
  console.error(`内网部署启动失败：${error.message}`)
  stopAll(1)
}

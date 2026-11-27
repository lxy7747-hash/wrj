import { execFile, type ExecFileException } from 'node:child_process'
import { isIPv4 } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import { promisify } from 'node:util'

const execute = promisify(execFile)
type Run = { runId: string; taskId: string }
type Fields = Record<string, string | number | null>

export function missionStartupMessage({ runId, taskId }: Run, event: string, details: Fields = {}): string {
  return `[Mission启动诊断] ${JSON.stringify({ time: new Date().toISOString(), runId, taskId, event, ...details })}`
}

function pidStatus(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) return '未知（无有效 PID）'
  try { process.kill(pid, 0); return '运行中' }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ESRCH' ? '已退出' : `未知（${code ?? '无法查询'}）`
  }
}

/** 只读取本机 TCP 监听表，额外建立探测连接会干扰插件等待首个客户端的行为。 */
export async function inspectMissionListener(endpoint: URL): Promise<string> {
  const host = endpoint.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = endpoint.port || (endpoint.protocol === 'wss:' ? '443' : '80')
  const local = host === 'localhost' || host === '::1' || (isIPv4(host) && host.startsWith('127.'))
    || host === hostname().toLowerCase() || Object.values(networkInterfaces()).flat().some(entry => entry?.address.toLowerCase() === host)
  if (!local) return `目标未确认为本机地址，无法在本机核实 TCP ${port} 的监听`

  let listeners: string[]
  if (process.platform === 'win32') {
    const { stdout } = await execute('netstat.exe', ['-ano'], { windowsHide: true, timeout: 3_000, maxBuffer: 4 * 1024 * 1024 })
    listeners = stdout.split('\n').flatMap(line => {
      const [protocol, address, peer, state, owner] = line.trim().split(/\s+/)
      // 未连接的对端为零地址，兼容本地化的 LISTENING 状态文字。
      if (protocol !== 'TCP' || !address?.endsWith(`:${port}`) || !/^\d+$/.test(owner ?? '')
        || !(state === 'LISTENING' || peer === '0.0.0.0:0' || peer === '[::]:0')) return []
      return [`${address} PID=${owner}`]
    })
  } else if (process.platform === 'linux') {
    const { stdout } = await execute('ss', ['-H', '-lntp', 'sport', '=', `:${port}`], { timeout: 3_000 })
    listeners = stdout.trim().split('\n').filter(Boolean).map(line => {
      const address = line.trim().split(/\s+/)[3]
      const owners = [...line.matchAll(/\bpid=(\d+)/g)].map(match => match[1])
      return `${address} PID=${owners.join(',') || '未知'}`
    })
  } else return `本系统无法查询 TCP ${port} 的监听`
  return listeners.length ? `本机监听 ${[...new Set(listeners)].join('，')}` : `本机 TCP ${port} 未监听`
}

/** 每次重试保留原始错误；较慢的系统监听表查询在后台单独采样。 */
export function createMissionConnectionLog(run: Run, pid: number, endpoint: URL, report: (message: string) => void,
  active: () => boolean, inspect = inspectMissionListener) {
  let checking = false
  let nextCheckAt = 0
  const ws = endpoint.origin + endpoint.pathname
  return (attempt: number, event: string, fields: Fields = {}, checkListener = false) => {
    if (!active()) return
    const log = (event: string, fields: Fields) => report(missionStartupMessage(run, event, { pid, process: pidStatus(pid), ws, attempt, ...fields }))
    log(event, fields)
    if (!checkListener || checking || Date.now() < nextCheckAt) return
    checking = true
    nextCheckAt = Date.now() + 10_000
    void inspect(endpoint).catch((error: ExecFileException) =>
      `监听状态未知（${error.code ?? (error.killed ? '查询超时或被终止' : error.message)}）`).then(listener => {
      if (active()) log('端口监听采样', { listener })
    }).finally(() => { checking = false })
  }
}

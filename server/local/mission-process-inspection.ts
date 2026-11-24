import { execFile } from 'node:child_process'
import { readlink } from 'node:fs/promises'
import { isIPv4, type Socket } from 'node:net'
import { promisify } from 'node:util'

const execute = promisify(execFile)

type TcpPeer = Pick<Socket, 'localAddress' | 'localPort' | 'remoteAddress' | 'remotePort'>

/** 核对已连接套接字的服务端 TCP 四元组，避免仅凭端口向别的进程发送命令。 */
export async function isMissionWebSocketPeer(socket: TcpPeer, pid: number): Promise<boolean> {
  const { localAddress, localPort, remoteAddress, remotePort } = socket
  if (!localAddress || !isIPv4(localAddress) || !remoteAddress || !isIPv4(remoteAddress)
    || !localPort || !remotePort || !Number.isSafeInteger(pid) || pid <= 0) return false
  const server = `${remoteAddress}:${remotePort}`
  const client = `${localAddress}:${localPort}`
  if (process.platform === 'win32') {
    const { stdout } = await execute('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 3000 })
    return stdout.split('\n').some(line => {
      const [protocol, local, remote, state, owner] = line.trim().split(/\s+/)
      return protocol === 'TCP' && local === server && remote === client && state === 'ESTABLISHED' && owner === String(pid)
    })
  }
  if (process.platform !== 'linux') return false
  const { stdout } = await execute('ss', ['-Hntp', 'state', 'established'], { timeout: 3000 })
  const owner = new RegExp(`\\bpid=${pid}(?=[,)])`)
  return stdout.split('\n').some(line => {
    const fields = line.trim().split(/\s+/)
    const index = fields.indexOf(server)
    return index >= 0 && fields[index + 1] === client && owner.test(fields.slice(index + 2).join(' '))
  })
}

export interface MissionProcessIdentity {
  pid: number
  parentPid: number
  startedAt: number
  executable: string
  commandLine: string
  processGroup?: number
}

/** 查询失败必须保留锁；不能把无权限或查询超时当作进程已退出。 */
export async function readMissionProcesses(): Promise<MissionProcessIdentity[]> {
  if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $p=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;startedAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();executable=$_.ExecutablePath;commandLine=$_.CommandLine} }); ConvertTo-Json -InputObject $p -Compress"
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 })
    const rows: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''))
    if (!Array.isArray(rows) || !rows.some(row => row?.pid === process.pid)
      || !rows.every(row => row && Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.parentPid) && Number.isFinite(row.startedAt))) throw new Error('进程信息不完整。')
    return rows.map(row => ({ ...row, executable: row.executable ?? '', commandLine: row.commandLine ?? '' }))
  }
  const { stdout } = await execute('ps', ['-eo', 'pid=,ppid=,pgid=,lstart=,args='], { env: { ...process.env, LC_ALL: 'C' }, timeout: 10000, maxBuffer: 8 * 1024 * 1024 })
  const processes = await Promise.all(stdout.trim().split('\n').map(async line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/)
    if (!match || !Number.isFinite(Date.parse(match[4]!))) throw new Error('进程信息不完整。')
    const pid = Number(match[1])
    // Linux /proc 提供真实可执行文件路径；无法读取时保留锁，不猜测归属。
    const executable = await readlink(`/proc/${pid}/exe`).catch(() => '')
    return { pid, parentPid: Number(match[2]), processGroup: Number(match[3]), startedAt: Date.parse(match[4]!), executable, commandLine: match[5]! }
  }))
  if (!processes.some(entry => entry.pid === process.pid)) throw new Error('进程信息不完整。')
  return processes
}

export function missionProcessTree(processes: MissionProcessIdentity[], pid: number, startedAt: number): MissionProcessIdentity[] {
  const result: MissionProcessIdentity[] = []
  const parents = new Set([pid])
  for (let changed = true; changed;) {
    changed = false
    for (const entry of processes) {
      if (entry.pid !== pid && !parents.has(entry.pid) && (parents.has(entry.parentPid) || entry.processGroup === pid) && entry.startedAt >= startedAt - 1000) {
        parents.add(entry.pid); result.push(entry); changed = true
      }
    }
  }
  return result
}

export async function stopVerifiedMission(expected: MissionProcessIdentity): Promise<void> {
  const processes = await readMissionProcesses()
  const current = processes.find(entry => entry.pid === expected.pid)
  if (!current) return
  if (current.startedAt !== expected.startedAt || current.executable !== expected.executable || current.commandLine !== expected.commandLine) throw new Error('进程身份已变化，未执行停止。')
  const tree = [current, ...missionProcessTree(processes, current.pid, current.startedAt)]
  if (process.platform === 'win32') {
    await execute('taskkill.exe', ['/PID', String(current.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 })
  } else {
    // 本地运行器在 Unix 中创建独立进程组。
    process.kill(-current.pid, 'SIGKILL')
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const remaining = await readMissionProcesses()
    if (!tree.some(old => remaining.some(entry => entry.pid === old.pid && entry.startedAt === old.startedAt)
      || missionProcessTree(remaining, old.pid, old.startedAt).length > 0)) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('Mission 进程树尚未结束，已保留运行锁，请重试停止。')
}

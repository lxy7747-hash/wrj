import { lstatSync, readFileSync } from 'node:fs'
import { mkdir, open, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MissionSafetyStatus } from '../simulations/mission-execution.js'
import { missionProcessTree, stopVerifiedMission, type MissionProcessIdentity } from './mission-process-inspection.js'

interface MissionGuardRecord {
  runId: string
  scenarioId: string
  revision: number
  pid?: number
  startedAt?: string
  spawnedAt?: string
  runDirectory?: string
  executable?: string
}

const BLOCKED = '检测到遗留 Mission 运行，请通过“停止遗留运行”处理。'

/** 独占目录先于 spawn 创建；即使记录写到一半崩溃，目录本身也阻止再次启动。 */
export class MissionGuard {
  private readonly marker: string

  constructor(private readonly directory: string) { this.marker = join(directory, '.mission-active') }

  status(): MissionSafetyStatus | null {
    try {
      const directory = lstatSync(this.marker)
      if (!directory.isDirectory() || directory.isSymbolicLink()) return { message: BLOCKED }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return { message: BLOCKED }
    }
    try {
      const path = join(this.marker, 'record.json')
      const file = lstatSync(path)
      if (!file.isFile() || file.isSymbolicLink()) return { message: BLOCKED }
      const record: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof record !== 'object' || record === null || Array.isArray(record)) return { message: BLOCKED }
      const value = record as Partial<MissionGuardRecord>
      if (typeof value.runId !== 'string' || !value.runId
        || typeof value.scenarioId !== 'string' || !value.scenarioId
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return { message: BLOCKED }
      return { scenarioId: value.scenarioId, runId: value.runId, message: BLOCKED }
    } catch { return { message: BLOCKED } }
  }

  async reconcile(executable: string, processes: MissionProcessIdentity[], stopRunId?: string): Promise<MissionSafetyStatus | null> {
    const status = this.status()
    if (!status) return null
    const uncertain = (message: string) => ({ ...status, canStop: false, message })
    if (!status.runId) return uncertain('遗留运行记录损坏，无法核实进程身份；请管理员检查运行目录。')
    const text = readFileSync(join(this.marker, 'record.json'), 'utf8')
    const record = JSON.parse(text) as MissionGuardRecord
    const startedAt = Date.parse(record.startedAt ?? '')
    // 旧部署记录没有 spawnedAt，用启动后写入记录的时间作上界，不猜测启动耗时。
    const spawnedAt = record.spawnedAt === undefined ? lstatSync(join(this.marker, 'record.json')).mtimeMs : Date.parse(record.spawnedAt)
    const location = typeof record.runDirectory === 'string' ? relative(resolve(this.directory), resolve(record.runDirectory)) : ''
    if (!Number.isSafeInteger(record.pid) || record.pid! <= 0 || !Number.isFinite(startedAt) || !Number.isFinite(spawnedAt) || spawnedAt < startedAt
      || !record.runDirectory || !isAbsolute(record.runDirectory) || !location || location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) {
      return uncertain('遗留运行记录缺少有效的进程或目录信息，无法自动核实；请管理员检查运行目录。')
    }
    const running = processes.find(entry => entry.pid === record.pid)
    const descendants = missionProcessTree(processes, record.pid!, startedAt)
    if (running && running.startedAt >= startedAt - 1000 && running.startedAt <= spawnedAt + 1000) {
      const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
      if (!running.executable || !samePath(running.executable, record.executable ?? executable)
        || !/(?:^|\s)-es\s+"?scenario\.txt"?(?:\s|$)/.test(running.commandLine)) {
        return uncertain('遗留运行的 PID 当前无法确认属于本次 Mission，未停止其他程序；请管理员核实。')
      }
      if (stopRunId !== record.runId) return { ...status, pid: running.pid, canStop: true, message: '上次 Mission 仍在运行，可停止遗留运行后重新开始。' }
      await stopVerifiedMission(running)
    } else if (descendants.length) {
      return uncertain('Mission 主进程已结束，但仍检测到关联子进程；暂不解除运行锁。')
    }
    // 只归档刚核实的那份记录；历史输出和未完成结果原样保留。
    if (readFileSync(join(this.marker, 'record.json'), 'utf8') !== text) throw new Error('运行记录已变化，请刷新后重试。')
    const archived = join(this.directory, `.mission-recovered-${randomUUID()}`)
    await rename(this.marker, archived)
    await writeFile(join(archived, 'recovery.json'), JSON.stringify({ recoveredAt: new Date().toISOString(), action: stopRunId === record.runId ? 'STOPPED' : 'EXIT_CONFIRMED', runId: record.runId }))
    return null
  }

  async claim(directory: string, record: MissionGuardRecord): Promise<void> {
    await mkdir(directory, { recursive: true })
    await mkdir(this.marker)
    await this.write(record)
  }

  async spawned(record: MissionGuardRecord): Promise<void> { await this.write(record) }

  private async write(record: MissionGuardRecord): Promise<void> {
    const pending = join(this.marker, 'record.pending')
    const handle = await open(pending, 'wx')
    try {
      await handle.writeFile(JSON.stringify(record))
      await handle.sync()
    } finally { await handle.close() }
    await rename(pending, join(this.marker, 'record.json'))
  }

  async clearAfterClose(): Promise<void> {
    try { await unlink(join(this.marker, 'record.pending')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await unlink(join(this.marker, 'record.json'))
    await rmdir(this.marker)
  }
}

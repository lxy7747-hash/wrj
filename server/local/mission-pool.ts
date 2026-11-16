import { lstatSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { ScenarioDraft } from '../../src/contracts/domain-models.js'
import type { MissionExecution, MissionProcess, MissionSafetyStatus } from '../simulations/mission-execution.js'
import type { LocalMissionResults } from './mission-results.js'
import { MissionGuard } from './mission-guard.js'
import { LocalMissionRunner } from './mission-runner.js'
import { readMissionProcesses } from './mission-process-inspection.js'

const TASK_ID = /^TASK-[A-Za-z0-9][A-Za-z0-9._-]*$/
const BLOCKED = '并行任务目录或上次运行记录未确认安全，请管理员核实后重试。'

export function readMissionConcurrency(value?: string): number {
  if (value === undefined || value === '') return 1
  if (!/^[1-4]$/.test(value)) throw new RangeError('MISSION_MAX_PARALLEL_TASKS必须为1至4的整数。')
  return Number(value)
}

/** 不同任务独立运行器/目录/单实例锁；容量预留先于异步启动，停止失败不释放名额。 */
export class LocalMissionPool implements MissionExecution {
  private readonly directory: string
  private readonly tasksDirectory: string
  private readonly runners = new Map<string, LocalMissionRunner>()
  private readonly active = new Set<string>()
  private recovery?: Promise<MissionSafetyStatus[]>

  constructor(private readonly executable: string, directory: string, private readonly results: LocalMissionResults | undefined,
    readonly maxParallelTasks: number, private readonly runTimeoutMs = 0, private readonly outputDirectory?: string,
    /** 强制使用 local_link_stub，不探测/不加载外部 LinkCalc 插件。 */
    private readonly forceLinkStub = false) {
    if (!isAbsolute(executable)) throw new Error('MISSION_EXECUTABLE_PATH必须为绝对路径。')
    if (!Number.isSafeInteger(maxParallelTasks) || maxParallelTasks < 1 || maxParallelTasks > 4) throw new RangeError('并行任务数必须是1至4的整数。')
    this.directory = resolve(directory)
    this.tasksDirectory = join(this.directory, 'parallel-tasks')
  }

  safetyStatus(taskId?: string): MissionSafetyStatus | null {
    const legacy = new MissionGuard(this.directory).status()
    if (legacy) return legacy
    try {
      const stat = lstatSync(this.tasksDirectory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { message: BLOCKED }
      const names = taskId === undefined ? readdirSync(this.tasksDirectory) : [this.taskDirectoryName(taskId)]
      for (const name of names) {
        if (!/^TASK-[a-f0-9]{64}$/.test(name)) return { message: BLOCKED }
        const taskDirectory = join(this.tasksDirectory, name)
        let taskStat
        try { taskStat = lstatSync(taskDirectory) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
        if (!taskStat.isDirectory() || taskStat.isSymbolicLink()) return { message: BLOCKED }
        if ([...this.active].some(id => this.taskDirectoryName(id) === name)) continue
        const status = new MissionGuard(taskDirectory).status()
        if (status) return status
      }
      return null
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : { message: BLOCKED }
    }
  }

  private taskDirectoryName(taskId: string): string {
    // Windows目录不区分大小写且会折叠尾点；目录名用摘要，记录内保留原始task_id。
    return `TASK-${createHash('sha256').update(taskId).digest('hex')}`
  }

  private recoveryGuards(): MissionGuard[] {
    const guards = [new MissionGuard(this.directory)]
    try {
      const root = lstatSync(this.tasksDirectory)
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(BLOCKED)
      for (const name of readdirSync(this.tasksDirectory)) {
        const directory = join(this.tasksDirectory, name)
        const stat = lstatSync(directory)
        if (!/^TASK-[a-f0-9]{64}$/.test(name) || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error(BLOCKED)
        if (![...this.active].some(id => this.taskDirectoryName(id) === name)) guards.push(new MissionGuard(directory))
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return guards.filter(guard => guard.status())
  }

  recover(): Promise<MissionSafetyStatus[]> {
    if (this.recovery) return this.recovery
    const operation = this.reconcile().finally(() => { if (this.recovery === operation) this.recovery = undefined })
    this.recovery = operation
    return operation
  }

  async stopRecovered(runId: string): Promise<void> {
    const operation = (this.recovery ?? Promise.resolve()).then(() => this.reconcile(runId))
    this.recovery = operation
    try {
      const remaining = await operation
      const blocked = remaining.find(entry => entry.runId === runId || !entry.runId)
      if (blocked) throw new Error(blocked.message)
    } finally { if (this.recovery === operation) this.recovery = undefined }
  }

  private async reconcile(stopRunId?: string): Promise<MissionSafetyStatus[]> {
    let guards: MissionGuard[]
    try { guards = this.recoveryGuards() }
    catch { return [{ message: BLOCKED }] }
    if (!guards.length) return []
    try {
      const processes = await readMissionProcesses()
      const result: MissionSafetyStatus[] = []
      for (const guard of guards) {
        const status = await guard.reconcile(this.executable, processes, stopRunId)
        if (status) result.push(status)
      }
      return result
    } catch (error) {
      return guards.flatMap(guard => { const status = guard.status(); return status ? [{ ...status, canStop: false, message: `无法确认 Mission 已结束，保留运行锁：${error instanceof Error ? error.message : '进程查询失败。'}` }] : [] })
    }
  }

  async start(draft: ScenarioDraft, runId: string, taskId = 'TASK-001'): Promise<MissionProcess> {
    if (!TASK_ID.test(taskId) || !/^RUN-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error('任务或运行编号无效。')
    const safety = this.safetyStatus()
    if (safety) throw new Error(safety.message)
    if (this.active.has(taskId) || this.active.size >= this.maxParallelTasks) throw new Error('任务已运行或已达到并行容量。')
    this.active.add(taskId)
    try {
      const directory = join(this.tasksDirectory, this.taskDirectoryName(taskId))
      await mkdir(directory, { recursive: true })
      let runner = this.runners.get(taskId)
      if (!runner) { runner = new LocalMissionRunner(this.executable, directory, this.results, undefined, this.runTimeoutMs, this.outputDirectory, this.forceLinkStub); this.runners.set(taskId, runner) }
      const process = await runner.start(draft, runId, taskId)
      // LocalMissionRunner只在确认进程关闭和写入收尾后完成；不因STOP请求成功返回就提前释放。
      void process.completed.then(() => this.active.delete(taskId), () => this.active.delete(taskId))
      return process
    } catch (error) { this.active.delete(taskId); throw error }
  }
}

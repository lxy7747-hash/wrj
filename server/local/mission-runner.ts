import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { ScenarioDraft } from '../../src/contracts/domain-models.js'
import { configuredScenarioOutput } from '../../src/config/app.config.js'
import type { MissionExecution, MissionOutcome, MissionProcess } from '../simulations/mission-execution.js'
import { writeMissionPackage } from './script-file.js'
import { MissionGenerationError } from '../scripts/mission-generator.js'
import type { LocalMissionResults } from './mission-results.js'
import { MissionGuard } from './mission-guard.js'
import { MissionPositionReader } from './mission-position-reader.js'
import { ContinuousTimeSeriesWriter } from './continuous-time-series.js'

const STOP_WAIT_MS = 5_000
const TASKKILL_WAIT_MS = 1_000
/** 控制台日志尾部的读取上限；只读取最后一段，不随日志增长而全文读取。 */
export const CONSOLE_LOG_TAIL_BYTES = 64 * 1024

/**
 * 解析运行超时（秒）；未设置或 0 表示不启用，范围 1～86400。
 * @remarks 超时按墙钟计时，-es 非实时推进下与仿真时长无对应关系，需按现场运行时间设定。
 */
export function readMissionRunTimeout(value?: string): number {
  if (value === undefined || value.trim() === '' || value.trim() === '0') return 0
  if (!/^[1-9]\d{0,4}$/.test(value.trim()) || Number(value) > 86_400) throw new RangeError('MISSION_RUN_TIMEOUT_SECONDS必须为0至86400的整数秒。')
  return Number(value) * 1000
}

/** 读取控制台日志最后一段 UTF-8 文本；截断处丢弃首个不完整行，避免半个多字节字符。 */
export async function readConsoleLogTail(logPath: string, limit = CONSOLE_LOG_TAIL_BYTES): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const handle = await open(logPath, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, limit)
    const buffer = Buffer.alloc(length)
    if (length > 0) await handle.read(buffer, 0, length, size - length)
    let text = buffer.toString('utf8')
    if (size > length) text = text.slice(text.indexOf('\n') + 1)
    return { text, bytes: size, truncated: size > length }
  } finally { await handle.close() }
}

type OwnedChild = Pick<ReturnType<typeof spawn>, 'pid' | 'kill'>

/**
 * 只按本运行器拿到的 PID 终止进程；Windows 每次停止都先终止该 PID 的子树，
 * Unix 通过独立进程组避免遗留后代。任何失败都回退到直接终止，guard 仍会保留到 close。
 */
export async function terminateOwnedMissionProcess(child: OwnedChild, force = false): Promise<void> {
  const signal = force ? 'SIGKILL' : undefined
  const pid = child.pid
  if (pid !== undefined && pid > 0) {
    if (globalThis.process.platform === 'win32') {
      try {
        const removedTree = await new Promise<boolean>((resolve) => {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: TASKKILL_WAIT_MS }, error => resolve(!error))
        })
        // taskkill 已在父进程仍存活时枚举完本次进程树，不能再抢先单独杀父。
        if (removedTree) return
      } catch { /* taskkill 未启动或失败时，直接终止仍是仅针对本次 child 的安全回退。 */ }
    } else {
      try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); return }
      catch { /* child 尚未形成进程组或已经退出时回退。 */ }
    }
  }
  try {
    if (signal === undefined) child.kill()
    else child.kill(signal)
  } catch { /* close 未到达前保留 guard，禁止错误解锁。 */ }
}

// mission 的脚本异常不一定反映在退出码中，必须同时复核日志，且不整文件读入内存。
async function inspectExecutionLog(path: string): Promise<boolean> {
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let completed = false
  try {
    for await (const line of lines) {
      if (/^\s*\*{5}\s+(ERROR|FATAL):/.test(line)) return false
      if (line.trim() === 'Simulation complete') completed = true
    }
    return completed
  } finally { lines.close(); input.destroy() }
}

const LINK_CALC_PROBE = [
  'platform_type LINK_CALC_PROBE WSF_PLATFORM',
  '  add processor link_calc WSF_LINK_CALC_PROCESSOR',
  '  end_processor',
  'end_platform_type',
  'end_time 1 sec',
  '',
].join('\n')
const LINK_CALC_MISSING = 'Could not find processor WSF_LINK_CALC_PROCESSOR'
const PROBE_TIMEOUT_MS = 15_000

/**
 * 用最小脚本探测引擎是否注册了对接方插件处理器 WSF_LINK_CALC_PROCESSOR。
 * 只有引擎明确报“找不到该处理器”才返回 false；其他失败（超时、启动失败等）按“有”处理，
 * 不擅自删段，让正式运行暴露真实错误。
 */
export async function engineHasLinkCalc(executable: string): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-link-calc-probe-'))
  try {
    await writeFile(join(directory, 'probe.txt'), LINK_CALC_PROBE, 'utf8')
    const output = await new Promise<string>(resolve => {
      execFile(executable, ['-es', 'probe.txt'], { cwd: directory, shell: false, windowsHide: true, timeout: PROBE_TIMEOUT_MS },
        (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`))
    })
    return !output.includes(LINK_CALC_MISSING)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

/** 只信任本次服务端生成包中的相对输出映射，拒绝借 mapping 跳出独占运行目录。 */
export async function resolveMissionOutputDirectory(entryPath: string): Promise<string> {
  const runDirectory = resolve(dirname(entryPath))
  let mapping: unknown
  try { mapping = JSON.parse(await readFile(join(runDirectory, 'mapping.json'), 'utf8')) }
  catch (error) { throw new Error(`无法读取本次生成包的输出映射：${error instanceof Error ? error.message : '未知错误'}。`) }
  const configured = (mapping as { output?: { resolvedDirectory?: unknown } }).output?.resolvedDirectory
  if (typeof configured !== 'string' || !configured || isAbsolute(configured)) throw new Error('本次生成包的输出目录映射无效。')
  const target = resolve(runDirectory, configured)
  const inside = relative(runDirectory, target)
  if (inside === '' || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${String.fromCharCode(92)}`) || inside.startsWith('../')) {
    throw new Error('本次生成包的输出目录映射越出运行目录。')
  }
  return target
}

/** 仅执行服务端生成的独占包；不用 shell，不读取浏览器传入的命令或路径。 */
export class LocalMissionRunner implements MissionExecution {
  private readonly guard: MissionGuard
  private readonly positions = new MissionPositionReader()
  /** 引擎路径在服务进程内不变，探测结果缓存；探测异常时下次重试。 */
  private linkCalcSupport?: Promise<boolean>

  constructor(private readonly executable: string, private readonly directory: string, private readonly results?: LocalMissionResults,
    private readonly probeLinkCalc: (executable: string) => Promise<boolean> = engineHasLinkCalc,
    /** 墙钟运行超时（毫秒），0 为不启用；超时后按停止流程终止本次进程树并记录原因。 */
    private readonly runTimeoutMs = 0) {
    if (!isAbsolute(executable)) throw new Error('MISSION_EXECUTABLE_PATH 必须为绝对路径。')
    this.guard = new MissionGuard(directory)
  }

  safetyStatus() { return this.guard.status() }

  private hasLinkCalc(): Promise<boolean> {
    this.linkCalcSupport ??= this.probeLinkCalc(this.executable).catch(() => { this.linkCalcSupport = undefined; return true })
    return this.linkCalcSupport
  }

  async start(draft: ScenarioDraft, runId = 'RUN-LOCAL', taskId = 'TASK-LOCAL'): Promise<MissionProcess> {
    if (this.results && !configuredScenarioOutput(draft.config.scenario.timeStep).eventsEnabled) throw new MissionGenerationError('output.eventsEnabled', '请启用事件输出，以生成本次仿真的回放和报告。')
    // 引擎有 WSF_LINK_CALC_PROCESSOR 时原样运行；找不到才在本次运行包中去掉 link_calc 段。
    const linkCalcAvailable = await this.hasLinkCalc()
    const entryPath = await writeMissionPackage(this.directory, draft, !linkCalcAvailable)
    this.positions.attach(runId, draft, entryPath)
    const cwd = dirname(entryPath)
    const logPath = join(cwd, 'mission-console.log')
    const log = await open(logPath, 'wx')
    const startedAt = new Date().toISOString()
    const record = { runId, scenarioId: draft.config.scenario.id, revision: draft.revision }
    try { await this.guard.claim(this.directory, record) }
    catch (error) { await log.close(); throw error }
    let continuous: ContinuousTimeSeriesWriter | undefined
    try {
      // 运行中增量留存使用独立 task/run 目录；缺少质量源时不补造数据，close 仍会留下可追溯 manifest。
      continuous = await ContinuousTimeSeriesWriter.create(this.directory, { taskId, runId }, await resolveMissionOutputDirectory(entryPath))
    } catch (error) {
      await log.close()
      await this.guard.clearAfterClose()
      throw error
    }
    // -es 为非实时事件推进：脚本中的 clock_rate / 前端倍速在此模式下不改变墙钟速度；改实时推进需另批确认。
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.executable, ['-es', basename(entryPath)], {
        cwd, shell: false, windowsHide: true, detached: globalThis.process.platform !== 'win32', stdio: ['ignore', log.fd, log.fd],
      })
    } catch (error) {
      await log.close()
      try { await continuous.close('FAILED') } catch { /* 连续归档的失败清单已尝试发布；启动错误优先返回。 */ }
      await this.guard.clearAfterClose()
      throw error
    }
    let exited = false
    let stopped = false
    let stopError: string | undefined
    let timedOut = false
    let processError: Error | undefined
    child.once('error', error => { processError = error })
    child.once('exit', () => { exited = true })
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        void this.guard.spawned({ ...record, pid: child.pid, startedAt, runDirectory: cwd }).then(resolve, reject)
      })
      child.once('error', reject)
    })
    let finish!: (code: number | null) => Promise<void>
    const completed = new Promise<MissionOutcome>(resolve => {
      let finalized = false
      finish = async code => {
        if (finalized) return
        finalized = true
        exited = true
        const outcome: MissionOutcome = { code, completedAt: new Date().toISOString() }
        let continuousArchiveDirectory: string | undefined
        if (code !== 0 || processError) outcome.errorMessage = `mission 执行失败（${processError?.message ?? `退出码 ${code}`}），请查看 ${logPath}`
        if (timedOut && !stopError) stopError = `mission 运行超过 ${this.runTimeoutMs / 1000} 秒超时上限，已自动终止；请查看 ${logPath}`
        if (stopError) outcome.errorMessage = stopError
        try {
          await log.close()
          if (code === 0 && !await inspectExecutionLog(logPath)) {
            outcome.errorMessage = `mission 日志含运行错误或缺少完成证据，请查看 ${logPath}`
          }
          if (stopError) outcome.errorMessage = stopError
          try {
            continuousArchiveDirectory = await continuous.close(code === 0 && !outcome.errorMessage && !stopped ? 'COMPLETED' : 'INCOMPLETE')
          } catch (error) {
            outcome.errorMessage = `连续时序留存失败：${error instanceof Error ? error.message : '未知错误'}；运行目录保留未完成数据。`
          }
          const receipt = {
            taskId, runId, scenarioId: draft.config.scenario.id, revision: draft.revision, entryPath,
            linkCalcCompatibility: linkCalcAvailable ? 'PRESERVED' : 'MISSING_PROCESSOR_STUBBED',
            executable: this.executable, pid: child.pid ?? null, startedAt, ...outcome,
          }
          await writeFile(join(cwd, 'execution.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' })
          if (code === 0 && !outcome.errorMessage && !stopped && this.results) {
            try { await this.results.capture(cwd, draft, startedAt, outcome.completedAt!, () => !stopped, { taskId, runId }, continuousArchiveDirectory) }
            catch (error) {
              outcome.errorMessage = `仿真结果保存失败：${error instanceof Error ? error.message : '未知错误'}；未发布回放和报告。`
              await writeFile(join(cwd, 'execution.json'), JSON.stringify({ ...receipt, ...outcome }, null, 2))
            }
          }
        } catch {
          outcome.errorMessage = stopError ?? `mission 已结束，但运行记录写入失败，请检查 ${cwd}`
        }
        try { await this.guard.clearAfterClose() }
        catch { outcome.errorMessage = `${outcome.errorMessage ?? 'mission 已关闭'}；未结清记录清理失败，请管理员检查 ${cwd}` }
        resolve(outcome)
      }
      child.once('close', code => { void spawned.catch(() => undefined).then(() => finish(code)) })
    })
    try {
      await spawned
    } catch {
      if (!exited) void terminateOwnedMissionProcess(child)
      if (!child.pid) {
        const outcome = await completed
        throw new Error(outcome.errorMessage ?? 'mission 启动失败。')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        completed,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), STOP_WAIT_MS) }),
      ])
      if (timer) clearTimeout(timer)
      if (outcome) throw new Error(outcome.errorMessage ?? 'mission 启动失败。')
      throw new Error('mission 启动未确认；请检查本机进程与未结清记录。')
    }
    const process: MissionProcess = {
      pid: child.pid!, startedAt, entryPath, readPositions: () => this.positions.read(runId), completed,
      readConsoleLog: () => readConsoleLogTail(logPath),
      ...(this.runTimeoutMs > 0 ? { timeoutMs: this.runTimeoutMs } : {}),
      dataFailure: continuous.failed.then(error => `连续时序留存失败：${error.message}；已请求停止本任务。`),
      stop: async () => {
        stopped = true
        if (!exited) await terminateOwnedMissionProcess(child)
        const waitForClose = async (): Promise<boolean> => {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            return await Promise.race([
              completed.then(() => true),
              new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), STOP_WAIT_MS) }),
            ])
          } finally { if (timer) clearTimeout(timer) }
        }
        if (!await waitForClose()) {
          stopError = 'mission 停止超时，已请求强制终止；请检查本机进程与运行记录。'
          if (!exited) await terminateOwnedMissionProcess(child, true)
          if (!await waitForClose()) {
            stopError = 'mission 强制终止后仍未关闭，可能残留进程；请检查本机进程与运行记录。'
            throw new Error(stopError)
          }
        }
        const outcome = await completed
        if (stopError) throw new Error(outcome.errorMessage ?? stopError)
        if (this.safetyStatus()) throw new Error(outcome.errorMessage ?? 'mission 已关闭，但未结清记录未清除。')
      },
    }
    // 数据已不能完整归档时停止本次拥有的进程；停止失败仍保留guard和明确的运行期错误。
    void continuous.failed.then(() => process.stop().catch(() => undefined))
    if (this.runTimeoutMs > 0) {
      const timer = setTimeout(() => {
        if (exited) return
        timedOut = true
        void process.stop().catch(() => undefined)
      }, this.runTimeoutMs)
      timer.unref?.()
      void completed.finally(() => clearTimeout(timer))
    }
    return process
  }
}

import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ScenarioDraft } from '../../src/contracts/domain-models.js'
import { configuredScenarioOutput } from '../../src/config/app.config.js'
import type { MissionExecution, MissionOutcome, MissionProcess } from '../simulations/mission-execution.js'
import { writeMissionPackage } from './script-file.js'
import { MissionGenerationError } from '../scripts/mission-generator.js'
import type { LocalMissionResults } from './mission-results.js'
import { MissionGuard } from './mission-guard.js'
import { MissionPositionReader } from './mission-position-reader.js'

const STOP_WAIT_MS = 5_000

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

/** 仅执行服务端生成的独占包；不用 shell，不读取浏览器传入的命令或路径。 */
export class LocalMissionRunner implements MissionExecution {
  private readonly guard: MissionGuard
  private readonly positions = new MissionPositionReader()
  /** 引擎路径在服务进程内不变，探测结果缓存；探测异常时下次重试。 */
  private linkCalcSupport?: Promise<boolean>

  constructor(private readonly executable: string, private readonly directory: string, private readonly results?: LocalMissionResults,
    private readonly probeLinkCalc: (executable: string) => Promise<boolean> = engineHasLinkCalc) {
    if (!isAbsolute(executable)) throw new Error('MISSION_EXECUTABLE_PATH 必须为绝对路径。')
    this.guard = new MissionGuard(directory)
  }

  safetyStatus() { return this.guard.status() }

  private hasLinkCalc(): Promise<boolean> {
    this.linkCalcSupport ??= this.probeLinkCalc(this.executable).catch(() => { this.linkCalcSupport = undefined; return true })
    return this.linkCalcSupport
  }

  async start(draft: ScenarioDraft, runId = 'RUN-LOCAL'): Promise<MissionProcess> {
    if (this.results && !configuredScenarioOutput(draft.config.scenario.timeStep).eventsEnabled) throw new MissionGenerationError('output.eventsEnabled', '请启用事件输出，以生成本次仿真的回放和报告。')
    // 引擎有 WSF_LINK_CALC_PROCESSOR 时原样运行；找不到才在本次运行包中去掉 link_calc 段。
    const entryPath = await writeMissionPackage(this.directory, draft, !await this.hasLinkCalc())
    this.positions.attach(runId, draft, entryPath)
    const cwd = dirname(entryPath)
    const logPath = join(cwd, 'mission-console.log')
    const log = await open(logPath, 'wx')
    const startedAt = new Date().toISOString()
    const record = { runId, scenarioId: draft.config.scenario.id, revision: draft.revision }
    try { await this.guard.claim(this.directory, record) }
    catch (error) { await log.close(); throw error }
    // -es 为非实时事件推进：脚本中的 clock_rate / 前端倍速在此模式下不改变墙钟速度；改实时推进需另批确认。
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.executable, ['-es', basename(entryPath)], {
        cwd, shell: false, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
      })
    } catch (error) {
      await log.close()
      await this.guard.clearAfterClose()
      throw error
    }
    let exited = false
    let stopped = false
    let stopError: string | undefined
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
        if (code !== 0 || processError) outcome.errorMessage = `mission 执行失败（${processError?.message ?? `退出码 ${code}`}），请查看 ${logPath}`
        if (stopError) outcome.errorMessage = stopError
        try {
          await log.close()
          if (code === 0 && !await inspectExecutionLog(logPath)) {
            outcome.errorMessage = `mission 日志含运行错误或缺少完成证据，请查看 ${logPath}`
          }
          if (stopError) outcome.errorMessage = stopError
          const receipt = {
            scenarioId: draft.config.scenario.id, revision: draft.revision, entryPath,
            executable: this.executable, pid: child.pid ?? null, startedAt, ...outcome,
          }
          await writeFile(join(cwd, 'execution.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' })
          if (code === 0 && !outcome.errorMessage && !stopped && this.results) {
            try { await this.results.capture(cwd, draft, startedAt, outcome.completedAt!, () => !stopped) }
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
      if (!exited) { try { child.kill() } catch { /* 未确认退出时保留未结清记录。 */ } }
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
    return {
      pid: child.pid!, startedAt, entryPath, readPositions: () => this.positions.read(runId), completed,
      stop: async () => {
        stopped = true
        if (!exited) { try { child.kill() } catch { /* 后续强制终止与运行记录仍需完成。 */ } }
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
          if (!exited) { try { child.kill('SIGKILL') } catch { /* 超时后报告可能残留。 */ } }
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
  }
}

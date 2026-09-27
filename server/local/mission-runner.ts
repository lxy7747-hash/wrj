import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ScenarioDraft } from '../../src/contracts/domain-models.js'
import type { MissionExecution, MissionOutcome, MissionProcess } from '../simulations/mission-execution.js'
import { writeMissionPackage } from './script-file.js'
import { MissionGenerationError } from '../scripts/mission-generator.js'
import type { LocalMissionResults } from './mission-results.js'

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

/** 仅执行服务端生成的独占包；不用 shell，不读取浏览器传入的命令或路径。 */
export class LocalMissionRunner implements MissionExecution {
  constructor(private readonly executable: string, private readonly directory: string, private readonly results?: LocalMissionResults) {
    if (!isAbsolute(executable)) throw new Error('MISSION_EXECUTABLE_PATH 必须为绝对路径。')
  }

  async start(draft: ScenarioDraft): Promise<MissionProcess> {
    if (this.results && !draft.config.output.eventsEnabled) throw new MissionGenerationError('output.eventsEnabled', '请启用事件输出，以生成本次仿真的回放和报告。')
    const entryPath = await writeMissionPackage(this.directory, draft)
    const cwd = dirname(entryPath)
    const logPath = join(cwd, 'mission-console.log')
    const log = await open(logPath, 'wx')
    const startedAt = new Date().toISOString()
    // -es 为非实时事件推进：脚本中的 clock_rate / 前端倍速在此模式下不改变墙钟速度；改实时推进需另批确认。
    const child = spawn(this.executable, ['-es', 'mission.txt'], {
      cwd, shell: false, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    })
    let exited = false
    let stopped = false
    let processError: Error | undefined
    child.once('error', error => { processError = error })
    const completed = new Promise<MissionOutcome>(resolve => {
      child.once('close', async code => {
        exited = true
        const outcome: MissionOutcome = { code, completedAt: new Date().toISOString() }
        if (code !== 0 || processError) outcome.errorMessage = `mission 执行失败（${processError?.message ?? `退出码 ${code}`}），请查看 ${logPath}`
        try {
          await log.close()
          if (code === 0 && !await inspectExecutionLog(logPath)) {
            outcome.errorMessage = `mission 日志含运行错误或缺少完成证据，请查看 ${logPath}`
          }
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
          outcome.errorMessage = `mission 已结束，但运行记录写入失败，请检查 ${cwd}`
        }
        resolve(outcome)
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
    } catch {
      const outcome = await completed
      throw new Error(outcome.errorMessage)
    }
    return {
      pid: child.pid!, startedAt, entryPath, completed,
      stop: async () => {
        stopped = true
        if (!exited && !child.kill()) throw new Error('mission 停止失败，请检查本机进程；配置仍保持锁定。')
        await completed
      },
    }
  }
}

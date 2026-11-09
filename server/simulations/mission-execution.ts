import type { ScenarioDraft, SimulationCommand } from '../../src/contracts/domain-models.js'
import type { MissionPositionSnapshot } from '../../src/features/situation/mission-positions.js'

/**
 * 真实执行器只在引擎确认接收后才允许投影切换状态；START/STOP 仍分别由启动和进程树清理负责。
 */
export type MissionRuntimeControl = Extract<SimulationCommand, { command: 'PAUSE' | 'RESUME' | 'STEP' | 'SET_SPEED' }>

export interface MissionOutcome {
  code: number | null
  completedAt?: string
  errorMessage?: string
}

export interface MissionProcess {
  pid: number
  startedAt: string
  entryPath: string
  /** 本次运行包已读取的实例/端口映射，供外部引擎帧绑定使用。 */
  engineManifest?: unknown
  /** 本地运行器登记的本次独占位置输出；未接入本地引擎的实现不提供此入口。 */
  readPositions?(): Promise<MissionPositionSnapshot | null>
  completed: Promise<MissionOutcome>
  /** 运行期间发生归档故障；调用方应显示错误并继续保持进程/场景保护，直至确认关闭。 */
  dataFailure?: Promise<string>
  /** 本次运行独占控制台日志（stdout/stderr）的尾部；仅本地引擎提供。 */
  readConsoleLog?(): Promise<{ text: string; bytes: number; truncated: boolean }>
  /** 已启用的墙钟运行超时（毫秒）；未启用时缺省。 */
  timeoutMs?: number
  /** 由具备运行中控制接口的引擎实现；缺失时调用方必须拒绝命令，不能只改投影状态。 */
  control?(command: MissionRuntimeControl): Promise<void>
  stop(): Promise<void>
}

export interface MissionSafetyStatus {
  scenarioId?: string
  message: string
}

export interface MissionExecution {
  readonly maxParallelTasks?: number
  start(draft: ScenarioDraft, runId: string, taskId?: string): Promise<MissionProcess>
  safetyStatus?(taskId?: string): MissionSafetyStatus | null
}

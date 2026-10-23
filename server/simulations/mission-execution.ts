import type { ScenarioDraft } from '../../src/contracts/domain-models.js'
import type { MissionPositionSnapshot } from '../../src/features/situation/mission-positions.js'

export interface MissionOutcome {
  code: number | null
  completedAt?: string
  errorMessage?: string
}

export interface MissionProcess {
  pid: number
  startedAt: string
  entryPath: string
  /** 本地运行器登记的本次独占位置输出；未接入本地引擎的实现不提供此入口。 */
  readPositions?(): Promise<MissionPositionSnapshot | null>
  completed: Promise<MissionOutcome>
  stop(): Promise<void>
}

export interface MissionSafetyStatus {
  scenarioId?: string
  message: string
}

export interface MissionExecution {
  start(draft: ScenarioDraft, runId: string): Promise<MissionProcess>
  safetyStatus?(): MissionSafetyStatus | null
}

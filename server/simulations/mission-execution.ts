import type { ScenarioDraft } from '../../src/contracts/domain-models.js'

export interface MissionOutcome {
  code: number | null
  completedAt?: string
  errorMessage?: string
}

export interface MissionProcess {
  pid: number
  startedAt: string
  entryPath: string
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

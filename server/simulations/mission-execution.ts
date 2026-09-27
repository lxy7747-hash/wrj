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

export interface MissionExecution {
  start(draft: ScenarioDraft): Promise<MissionProcess>
}

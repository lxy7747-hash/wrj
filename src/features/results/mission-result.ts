import type { Report } from '../../contracts/domain-models'
import { isLocalReplaySnapshot, type LocalReplaySnapshot } from '../replays/local-replay'
import { isLocalReport } from '../reports/local-report'

/** resultId 标识一次真实执行；相同场景、相同输出再次执行也产生新编号。 */
export interface MissionResultRecord {
  resultId: string
  scenarioId: string
  scenarioName: string
  revision: number
  startedAt: string
  completedAt: string
}

export interface MissionResultSnapshot {
  record: MissionResultRecord
  replay: LocalReplaySnapshot
  report: Report
}

export const isMissionResultId = (value: unknown): value is string => typeof value === 'string'
  && /^RESULT-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)

export function isMissionResultRecord(value: unknown): value is MissionResultRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as MissionResultRecord
  return Object.keys(r).length === 6 && isMissionResultId(r.resultId)
    && typeof r.scenarioId === 'string' && r.scenarioId.startsWith('SCN-')
    && typeof r.scenarioName === 'string' && r.scenarioName.trim().length > 0
    && Number.isSafeInteger(r.revision) && r.revision >= 1
    && [r.startedAt, r.completedAt].every(t => typeof t === 'string' && Number.isFinite(Date.parse(t)))
    && Date.parse(r.completedAt) >= Date.parse(r.startedAt)
}

export function isMissionResultSnapshot(value: unknown): value is MissionResultSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3) return false
  const { record, replay, report } = value as MissionResultSnapshot
  if (!isMissionResultRecord(record) || !isLocalReplaySnapshot(replay) || !isLocalReport(report)) return false
  const e = report.localEvidence
  return e.simulationComplete && !replay.waitingForLine && !e.waitingForPositionLine
    && e.eventFile.sha256 === replay.initial.sha256 && e.eventFile.fileName === replay.initial.fileName
    && e.positionFile.sha256 === replay.sha256 && e.positionFile.fileName === replay.fileName
    && e.positionCount === replay.recordCount && e.nodes.length === replay.initial.nodes.length
    && e.endTimeS >= replay.durationS
    && e.nodes.every(node => replay.initial.nodes.some(initial => node.platformId === initial.platformId))
}

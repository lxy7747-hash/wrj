import type { Report, ScenarioDraft, TaskPhase } from '../../contracts/domain-models'
import { isLocalReplaySnapshot, type LocalReplaySnapshot } from '../replays/local-replay'
import { isLocalReport } from '../reports/local-report'
import { taskPhaseIssue } from '../scenarios/task-phases'

/** resultId 标识一次真实执行；相同场景、相同输出再次执行也产生新编号。 */
export interface MissionResultRecord {
  resultId: string
  scenarioId: string
  scenarioName: string
  revision: number
  startedAt: string
  completedAt: string
  runId?: string
  taskId?: string
  executionSource?: 'REMOTE_WS'
}

/**
 * 完成时冻结的配置摘要，只用于比较实际已保存的输入；不包含或推导链路质量、BER、连通率等结果。
 * 保留为快照的可选字段，使旧三字段结果文件仍可读取。
 */
export interface MissionResultParameters {
  scenarioId: string
  revision: number
  platformCount: number
  linkCount: number
  jammerCount: number
  links: Array<{ id: string; type: string; frequencyMHz: number; bandwidthMHz: number; txPowerW: number }>
  jammers: Array<{ id: string; frequencyMHz: number; bandwidthMHz: number; defaultPowerW: number }>
  phases?: TaskPhase[]
}

export interface MissionResultParameterComparison {
  record: MissionResultRecord
  parameters: MissionResultParameters
}

export interface MissionResultSnapshot {
  record: MissionResultRecord
  replay: LocalReplaySnapshot
  report: Report
  parameters?: MissionResultParameters
}

/** 从 capture 时的已保存草稿复制可比输入，绝不由事件/位置 CSV 反推参数。 */
export function snapshotMissionResultParameters(draft: ScenarioDraft): MissionResultParameters {
  return {
    scenarioId: draft.config.scenario.id, revision: draft.revision,
    platformCount: draft.config.platforms.length, linkCount: draft.config.links.length, jammerCount: draft.config.jammers.length,
    ...(draft.config.scenario.phases === undefined ? {} : { phases: structuredClone(draft.config.scenario.phases) }),
    links: draft.config.links.map(link => ({ id: link.id, type: link.type, frequencyMHz: link.frequency, bandwidthMHz: link.bandwidth, txPowerW: link.txPower })),
    jammers: draft.config.jammers.map(jammer => ({ id: jammer.id, frequencyMHz: jammer.frequency, bandwidthMHz: jammer.bandwidth, defaultPowerW: jammer.defaultPower })),
  }
}

export const isMissionResultId = (value: unknown): value is string => typeof value === 'string'
  && /^RESULT-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)

export function isMissionResultRecord(value: unknown): value is MissionResultRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as MissionResultRecord
  return ['resultId', 'scenarioId', 'scenarioName', 'revision', 'startedAt', 'completedAt'].every(key => Object.hasOwn(r, key))
    && Object.keys(r).every(key => ['resultId', 'scenarioId', 'scenarioName', 'revision', 'startedAt', 'completedAt', 'runId', 'taskId', 'executionSource'].includes(key)) && isMissionResultId(r.resultId)
    && (r.executionSource === undefined || r.executionSource === 'REMOTE_WS' && r.runId !== undefined && r.taskId !== undefined)
    && ((r.runId === undefined && r.taskId === undefined) || (typeof r.runId === 'string' && /^RUN-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.runId) && typeof r.taskId === 'string' && /^TASK-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.taskId)))
    && typeof r.scenarioId === 'string' && r.scenarioId.startsWith('SCN-')
    && typeof r.scenarioName === 'string' && r.scenarioName.trim().length > 0
    && Number.isSafeInteger(r.revision) && r.revision >= 1
    && [r.startedAt, r.completedAt].every(t => typeof t === 'string' && Number.isFinite(Date.parse(t)))
    && Date.parse(r.completedAt) >= Date.parse(r.startedAt)
}

function isFiniteNonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }

export function isMissionResultParameters(value: unknown): value is MissionResultParameters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const parameters = value as MissionResultParameters
  if (![7, 8].includes(Object.keys(parameters).length) || !Object.keys(parameters).every(key => ['scenarioId', 'revision', 'platformCount', 'linkCount', 'jammerCount', 'links', 'jammers', 'phases'].includes(key))
    || taskPhaseIssue(parameters.phases) !== null || typeof parameters.scenarioId !== 'string' || !parameters.scenarioId.startsWith('SCN-')
    || !Number.isSafeInteger(parameters.revision) || parameters.revision < 1
    || ![parameters.platformCount, parameters.linkCount, parameters.jammerCount].every(Number.isSafeInteger)
    || ![parameters.platformCount, parameters.linkCount, parameters.jammerCount].every(value => value >= 0)
    || !Array.isArray(parameters.links) || !Array.isArray(parameters.jammers)
    || parameters.links.length !== parameters.linkCount || parameters.jammers.length !== parameters.jammerCount) return false
  const linkIds = new Set<string>(), jammerIds = new Set<string>()
  for (const link of parameters.links) {
    if (!link || typeof link !== 'object' || Object.keys(link).length !== 5 || typeof link.id !== 'string' || !link.id || linkIds.has(link.id)
      || typeof link.type !== 'string' || !link.type || ![link.frequencyMHz, link.bandwidthMHz, link.txPowerW].every(isFiniteNonNegative)) return false
    linkIds.add(link.id)
  }
  for (const jammer of parameters.jammers) {
    if (!jammer || typeof jammer !== 'object' || Object.keys(jammer).length !== 4 || typeof jammer.id !== 'string' || !jammer.id || jammerIds.has(jammer.id)
      || ![jammer.frequencyMHz, jammer.bandwidthMHz, jammer.defaultPowerW].every(isFiniteNonNegative)) return false
    jammerIds.add(jammer.id)
  }
  return true
}

export function isMissionResultSnapshot(value: unknown): value is MissionResultSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![3, 4].includes(Object.keys(value).length) || !Object.keys(value).every(key => ['record', 'replay', 'report', 'parameters'].includes(key))) return false
  const { record, replay, report, parameters } = value as MissionResultSnapshot
  if (!isMissionResultRecord(record) || !isLocalReplaySnapshot(replay) || !isLocalReport(report)) return false
  if (parameters !== undefined && (!isMissionResultParameters(parameters) || parameters.scenarioId !== record.scenarioId || parameters.revision !== record.revision)) return false
  const e = report.localEvidence
  return (e.simulationComplete || record.executionSource === 'REMOTE_WS') && !replay.waitingForLine && !e.waitingForPositionLine
    && e.eventFile.sha256 === replay.initial.sha256 && e.eventFile.fileName === replay.initial.fileName
    && e.positionFile.sha256 === replay.sha256 && e.positionFile.fileName === replay.fileName
    && e.positionCount === replay.recordCount && e.nodes.length === replay.initial.nodes.length
    && e.endTimeS >= replay.durationS
    && e.nodes.every(node => replay.initial.nodes.some(initial => node.platformId === initial.platformId))
}

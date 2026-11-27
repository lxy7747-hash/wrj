import type { Report, ScenarioDraft, TaskPhase } from '../../contracts/domain-models'
import { isReplayMapConfig, type ReplayMapConfig } from '../replays/replay-map-config'
import { isLocalReplaySnapshot, type LocalReplaySnapshot } from '../replays/local-replay'
import { isLocalReport } from '../reports/local-report'
import { taskPhaseIssue } from '../scenarios/task-phases'
import { withDerivedMessageDirections } from '../situation/file-message-links'
import { fileReceptionScenarioId, playbackFileSource } from '../situation/file-reception'

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
 * 本次运行留存的配置摘要，只用于比较已保存的输入；不包含或推导链路质量、BER、连通率等结果。
 * 保留为快照的可选字段，使旧三字段结果文件仍可读取。
 */
export interface MissionResultParameters {
  /** 手动关联的项目参考配置，不代表引擎实际执行版本。 */
  source?: 'PROJECT_REFERENCE'
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
  replayMap?: ReplayMapConfig
  report: Report
  parameters?: MissionResultParameters
}

export type MissionResultReplayView = Pick<MissionResultSnapshot, 'record' | 'replay' | 'replayMap'>

export function isMissionResultReplayView(value: unknown): value is MissionResultReplayView {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.keys(value).every(key => ['record', 'replay', 'replayMap'].includes(key))) return false
  const { record, replay, replayMap } = value as MissionResultReplayView
  return isMissionResultRecord(record) && replay != null && isLocalReplaySnapshot(replay) && !replay.waitingForLine
    && (replayMap === undefined || isReplayMapConfig(replayMap, record.scenarioId))
}

/** 历史对比的轻量响应；旧结果可能未留存参数。 */
export type MissionResultParameterSnapshot = Pick<MissionResultSnapshot, 'record' | 'parameters'>

export function isMissionResultParameterSnapshot(value: unknown): value is MissionResultParameterSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.keys(value).every(key => ['record', 'parameters'].includes(key))) return false
  const { record, parameters } = value as MissionResultParameterSnapshot
  if (!isMissionResultRecord(record)) return false
  return parameters === undefined || isMissionResultParameters(parameters)
    && (parameters.source === 'PROJECT_REFERENCE' ? record.executionSource === 'REMOTE_WS'
      : parameters.scenarioId === record.scenarioId && parameters.revision === record.revision)
}

/** 从已保存草稿复制可比输入，绝不由事件/位置 CSV 反推参数。 */
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
  if (![7, 8, 9].includes(Object.keys(parameters).length) || !Object.keys(parameters).every(key => ['scenarioId', 'revision', 'platformCount', 'linkCount', 'jammerCount', 'links', 'jammers', 'phases', 'source'].includes(key))
    || (parameters.source !== undefined && parameters.source !== 'PROJECT_REFERENCE')
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

/**
 * 兼容旧结果快照：读取磁盘上的历史快照时，为旧版消息链路补出可判定的业务方向。
 * 只在 direction 缺失且承载类型可判定时补值；已存在的方向与无法归类的类型保持不变。
 * 不修改调用方对象，返回新对象；无变化时原样返回。
 */
export function normalizeMissionResultSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const snapshot = value as { replay?: unknown } & Record<string, unknown>
  const replay = snapshot.replay
  if (!replay || typeof replay !== 'object') return value
  const initial = (replay as { initial?: unknown }).initial
  if (!initial || typeof initial !== 'object') return value
  const normalizedInitial = withDerivedMessageDirections(initial)
  if (normalizedInitial === initial) return value
  return { ...snapshot, replay: { ...(replay as object), initial: normalizedInitial } }
}

export function isMissionResultSnapshot(value: unknown): value is MissionResultSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.keys(value).every(key => ['record', 'replay', 'report', 'parameters', 'replayMap'].includes(key))) return false
  const { record, replay, report, parameters, replayMap } = value as MissionResultSnapshot
  if (!isMissionResultRecord(record) || !replay || !isLocalReplaySnapshot(replay) || !isLocalReport(report)) return false
  if (replayMap !== undefined && !isReplayMapConfig(replayMap, record.scenarioId)) return false
  if (parameters !== undefined) {
    if (!isMissionResultParameters(parameters)) return false
    if (parameters.source === 'PROJECT_REFERENCE') {
      if (record.executionSource !== 'REMOTE_WS' || record.scenarioId !== fileReceptionScenarioId(playbackFileSource(replay))) return false
    } else if (parameters.scenarioId !== record.scenarioId || parameters.revision !== record.revision) return false
  }
  const e = report.localEvidence
  return (e.simulationComplete || record.executionSource === 'REMOTE_WS') && !replay.waitingForLine && !e.waitingForPositionLine
    && e.eventFile.sha256 === replay.initial.sha256 && e.eventFile.fileName === replay.initial.fileName
    && e.positionFile.sha256 === replay.sha256 && e.positionFile.fileName === replay.fileName
    && e.positionCount === replay.recordCount && e.nodes.length === replay.initial.nodes.length
    && e.endTimeS >= replay.durationS
    && e.nodes.every(node => replay.initial.nodes.some(initial => node.platformId === initial.platformId))
}

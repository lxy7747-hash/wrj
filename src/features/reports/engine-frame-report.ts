import type { EngineFrameArchiveSummary, LocalReportEvidence, LocalReportFilter, Report, TaskPhase } from '../../contracts/domain-models'
import { isLocalReport } from './local-report'

function rangeFor(evidence: LocalReportEvidence, filter?: LocalReportFilter, phases: TaskPhase[] = []) {
  const phase = filter?.stage === undefined ? undefined : phases.find(item => item.id === filter.stage)
  if (filter?.stage !== undefined && !phase) throw new Error('未知任务阶段，不能筛选引擎帧。')
  const start = Math.max(evidence.startTimeS, filter?.from ?? evidence.startTimeS, phase?.startTimeS ?? evidence.startTimeS)
  const end = Math.min(evidence.endTimeS, filter?.to ?? evidence.endTimeS, phase?.endTimeS ?? evidence.endTimeS)
  if (start > end) throw new Error('引擎帧筛选时间范围无效。')
  return { start, end }
}

/** Applies report filters to received engine rows without turning a segment into a logical link or synthesizing a quality sample. */
export function filterEngineFrameArchive(archive: EngineFrameArchiveSummary, evidence: LocalReportEvidence, filter?: LocalReportFilter, phases?: TaskPhase[]): EngineFrameArchiveSummary {
  const range = rangeFor(evidence, filter, phases)
  const inRange = (time: number) => time >= range.start && time <= range.end
  const segmentMatches = (segment: EngineFrameArchiveSummary['segmentRows'][number]['segment']) => {
    if (filter?.linkId && segment.linkId !== filter.linkId && !segment.linkIds.includes(filter.linkId)) return false
    return !filter?.nodeId || segment.sourcePlatformId === filter.nodeId || segment.targetPlatformId === filter.nodeId
  }
  const switchMatches = (value: EngineFrameArchiveSummary['switchRows'][number]['value']) => {
    if (filter?.nodeId && value.sourcePlatformId !== filter.nodeId && value.targetPlatformId !== filter.nodeId
      && !value.nodes.some(node => node.platformId === filter.nodeId) && !value.oldNodes.some(node => node.platformId === filter.nodeId)) return false
    return true
  }
  const eventMatches = (value: EngineFrameArchiveSummary['eventRows'][number]['value']) => !filter?.nodeId || value.uavIds.includes(filter.nodeId) || value.jammerIds.includes(filter.nodeId)
  const segmentForSwitch = (epoch: number, frameId: number, reasonLinkId: string | null) => reasonLinkId === null ? []
    : archive.segmentRows.filter(row => row.engineEpoch === epoch && row.frameId === frameId && row.segment.linkId === reasonLinkId)
  const matchedSwitches = archive.switchRows.filter(row => {
    if (!inRange(row.simulationTime) || !switchMatches(row.value)) return false
    if (!filter?.linkId) return true
    return row.value.reasons.some(reason => reason.linkId === filter.linkId
      || segmentForSwitch(row.engineEpoch, row.frameId, reason.linkId).some(segment => segment.segment.linkIds.includes(filter.linkId!)))
  })
  return {
    ...archive,
    segmentRows: archive.segmentRows.filter(row => inRange(row.simulationTime) && segmentMatches(row.segment)),
    switchRows: matchedSwitches,
    // Engine frame events have no link membership.  Link-filtered report deliberately omits them rather than guessing.
    eventRows: filter?.linkId ? [] : archive.eventRows.filter(row => inRange(row.simulationTime) && eventMatches(row.value)),
  }
}

/** Adds immutable, source-verified engine archive evidence to a local report.  Older reports remain valid when omitted. */
export function attachEngineFrameArchive(report: Report, archive: EngineFrameArchiveSummary, filter?: LocalReportFilter, phases?: TaskPhase[]): Report {
  if (!isLocalReport(report)) throw new Error('只有本地真实报告可附加引擎帧归档。')
  if (!/^[a-f0-9]{64}$/u.test(archive.sourceSha256)) throw new Error('引擎帧归档来源摘要无效。')
  const localEvidence: LocalReportEvidence = { ...report.localEvidence, engineFrameArchive: filterEngineFrameArchive(archive, report.localEvidence, filter, phases) }
  const attached: Report = { ...report, localEvidence }
  if (!isLocalReport(attached)) throw new Error('附加后的引擎帧归档未通过边界校验。')
  return attached
}

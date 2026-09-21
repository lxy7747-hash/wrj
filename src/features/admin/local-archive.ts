import type { LocalArchiveRecord, Report } from '../../contracts/domain-models'
import { isLocalReport } from '../reports/local-report'
import { isLocalReplaySnapshot, type LocalReplaySnapshot } from '../replays/local-replay'

export interface LocalArchiveSnapshot { record: LocalArchiveRecord; replay: LocalReplaySnapshot; report: Report }

export const isLocalArchiveId = (value: unknown): value is string => typeof value === 'string' && /^ARCH-LOCAL-[a-f0-9]{64}$/.test(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const file = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2 && text((value as Record<string, unknown>).fileName)
  && typeof (value as Record<string, unknown>).sha256 === 'string' && /^[a-f0-9]{64}$/.test(String((value as Record<string, unknown>).sha256))

export function isLocalArchiveRecord(value: unknown): value is LocalArchiveRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as LocalArchiveRecord
  return Object.keys(row).length === 12 && isLocalArchiveId(row.archiveId)
    && text(row.name) && row.name.length <= 80 && text(row.createdBy)
    && typeof row.createdAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(row.createdAt) && Number.isFinite(Date.parse(row.createdAt))
    && row.sourceKind === 'LOCAL_FILE_SNAPSHOT' && row.binding === 'UNBOUND'
    && file(row.eventFile) && file(row.positionFile)
    && typeof row.reportId === 'string' && /^RPT-LOCAL-[a-f0-9]{64}$/.test(row.reportId)
    && Number.isSafeInteger(row.nodeCount) && row.nodeCount > 0
    && Number.isSafeInteger(row.positionCount) && row.positionCount >= 0
    && Number.isFinite(row.durationS) && row.durationS >= 0
}

/** 归档中的报告和回放必须来自同一对文件，不允许拼接两次读取的不同版本。 */
export function isLocalArchiveSnapshot(value: unknown): value is LocalArchiveSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3) return false
  const { record, replay, report } = value as LocalArchiveSnapshot
  if (!isLocalArchiveRecord(record) || !replay || !isLocalReplaySnapshot(replay) || !isLocalReport(report)) return false
  const evidence = report.localEvidence
  return record.eventFile.sha256 === replay.initial.sha256 && record.eventFile.fileName === replay.initial.fileName
    && record.positionFile.sha256 === replay.sha256 && record.positionFile.fileName === replay.fileName
    && evidence.eventFile.sha256 === replay.initial.sha256 && evidence.eventFile.fileName === replay.initial.fileName
    && evidence.positionFile.sha256 === replay.sha256 && evidence.positionFile.fileName === replay.fileName
    && record.reportId === report.reportId && record.positionCount === replay.recordCount
    && evidence.positionCount === replay.recordCount && record.nodeCount === replay.initial.nodes.length
    && evidence.nodes.length === record.nodeCount && record.durationS === replay.durationS
    && evidence.endTimeS >= replay.durationS
    && evidence.nodes.every(node => replay.initial.nodes.some(initial => initial.platformId === node.platformId))
}

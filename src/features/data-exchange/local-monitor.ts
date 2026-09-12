import { isRfc3339DateTime } from '../scenarios/scenario-validation'

export interface FileReadRecord {
  sequence: number
  operation: 'INITIAL_NODES' | 'POSITIONS' | 'LOCAL_REPLAY'
  fileName: string
  completedAt: string
  durationMs: number
  status: 'SUCCESS' | 'ERROR'
  recordCount: number | null
  issueCount: number | null
  errorCode: 'LOCAL_READ_FAILED' | null
}

/** 本机只读扩展，与冻结 Mock SystemHealth 分离；不暴露路径或文件内容。 */
export interface LocalMonitorSnapshot {
  service: 'HEALTHY'
  database: 'HEALTHY' | 'ERROR'
  recordStorage: 'HEALTHY' | 'ERROR'
  checkedAt: string
  records: FileReadRecord[]
}

function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

export function isLocalMonitorSnapshot(value: unknown): value is LocalMonitorSnapshot | null {
  if (value === null) return true
  if (!object(value, ['service', 'database', 'recordStorage', 'checkedAt', 'records']) || value.service !== 'HEALTHY'
    || (value.recordStorage !== 'HEALTHY' && value.recordStorage !== 'ERROR')
    || (value.database !== 'HEALTHY' && value.database !== 'ERROR') || !isRfc3339DateTime(value.checkedAt)
    || !Array.isArray(value.records) || value.records.length > 50) return false
  let previous = Infinity
  return value.records.every(record => {
    if (!object(record, ['sequence', 'operation', 'fileName', 'completedAt', 'durationMs', 'status', 'recordCount', 'issueCount', 'errorCode'])
      || !Number.isSafeInteger(record.sequence) || Number(record.sequence) < 1 || Number(record.sequence) >= previous
      || typeof record.operation !== 'string' || !['INITIAL_NODES', 'POSITIONS', 'LOCAL_REPLAY'].includes(record.operation)
      || typeof record.fileName !== 'string' || !record.fileName.trim() || /[\\/\x00-\x1f]/.test(record.fileName)
      || !isRfc3339DateTime(record.completedAt) || Date.parse(record.completedAt) > Date.parse(value.checkedAt as string)
      || typeof record.durationMs !== 'number' || !Number.isFinite(record.durationMs) || record.durationMs < 0) return false
    previous = Number(record.sequence)
    return record.status === 'SUCCESS'
      ? record.errorCode === null && [record.recordCount, record.issueCount].every(count => Number.isSafeInteger(count) && Number(count) >= 0)
      : record.status === 'ERROR' && record.errorCode === 'LOCAL_READ_FAILED' && record.recordCount === null && record.issueCount === null
  })
}

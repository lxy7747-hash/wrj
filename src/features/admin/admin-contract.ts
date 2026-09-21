import type { ArchiveRecord, BackupRecord, MasterData, MasterDataContent, MasterDataEntry, MasterDataReference, MasterDataTarget, MasterDataDetails, RestoreResult, SystemHealth } from '../../contracts/domain-models'
import { isRfc3339DateTime } from '../scenarios/scenario-validation'

export const MASTER_DATA_KINDS: Record<string, string> = {
  DEVICE: '设备', COMMUNICATION_SYSTEM: '通信体制', PARAMETER_DICTIONARY: '参数字典', ENUMERATION: '枚举',
}

/** 校验对象的必填键和可选键，拒绝数组、空值和额外字段。 */
export function isAdminObject(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
}

/** 判断字段是否为非空文本。 */
export function isAdminText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 校验主数据的闭合结构、正整数版本和非负引用数量；供前后端共用。 */
export function isMasterData(value: unknown): value is MasterData {
  return isAdminObject(value, ['dataId', 'kind', 'version', 'referenceCount', 'active'], ['content'])
    && isAdminText(value.dataId) && isAdminText(value.kind)
    // 点路径段会被浏览器规范化，无法作为可维护资源的编号。
    && value.dataId !== '.' && value.dataId !== '..'
    && Number.isSafeInteger(value.version) && Number(value.version) >= 1
    && Number.isSafeInteger(value.referenceCount) && Number(value.referenceCount) >= 0
    && typeof value.active === 'boolean'
    && (value.content === undefined || isMasterContent(value.content))
}

export function isMasterEntry(value: unknown): value is MasterDataEntry {
  if (!isAdminObject(value, ['key', 'valueType', 'value'], ['unit', 'minimum', 'maximum'])
    || typeof value.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value.key)) return false
  if (value.valueType === 'TEXT') return isAdminText(value.value) && value.value.length <= 1000 && Object.keys(value).length === 3
  if (value.valueType === 'BOOLEAN') return typeof value.value === 'boolean' && Object.keys(value).length === 3
  return value.valueType === 'NUMBER' && typeof value.value === 'number' && Number.isFinite(value.value)
    && (value.unit === undefined || (typeof value.unit === 'string' && value.unit.length <= 24))
    && (value.minimum === undefined || (typeof value.minimum === 'number' && Number.isFinite(value.minimum) && value.value >= value.minimum))
    && (value.maximum === undefined || (typeof value.maximum === 'number' && Number.isFinite(value.maximum) && value.value <= value.maximum))
}

export function isMasterContent(value: unknown): value is MasterDataContent {
  return isAdminObject(value, ['name', 'description', 'entries']) && isAdminText(value.name) && value.name.length <= 80
    && typeof value.description === 'string' && value.description.length <= 1000
    && Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= 100 && value.entries.every(isMasterEntry)
    && new Set(value.entries.map(entry => entry.key)).size === value.entries.length
}

export function isMasterWrite(value: unknown): value is MasterData & { content: MasterDataContent } {
  return isMasterData(value) && isMasterContent(value.content)
    && ['COMMUNICATION_SYSTEM', 'PARAMETER_DICTIONARY', 'ENUMERATION'].includes(value.kind)
    && (value.kind !== 'ENUMERATION' || (value.content.entries.every(entry => entry.valueType === 'TEXT')
      && new Set(value.content.entries.map(entry => entry.value)).size === value.content.entries.length))
}

export function isMasterReference(value: unknown): value is MasterDataReference {
  return isAdminObject(value, ['dataId', 'dataVersion', 'targetType', 'targetId', 'targetVersion'])
    && isAdminText(value.dataId) && value.dataId !== '.' && value.dataId !== '..'
    && Number.isSafeInteger(value.dataVersion) && Number(value.dataVersion) > 0
    && (value.targetType === 'SCENARIO' || value.targetType === 'TEMPLATE') && isAdminText(value.targetId) && isAdminText(value.targetVersion)
}

export function isMasterTarget(value: unknown): value is MasterDataTarget {
  return isAdminObject(value, ['targetType', 'targetId', 'targetVersion', 'name'])
    && (value.targetType === 'SCENARIO' || value.targetType === 'TEMPLATE')
    && isAdminText(value.targetId) && isAdminText(value.targetVersion) && isAdminText(value.name)
}

export function isMasterDetails(value: unknown): value is MasterDataDetails {
  if (!isAdminObject(value, ['dataId', 'history', 'references']) || !isAdminText(value.dataId) || value.dataId === '.' || value.dataId === '..'
    || !Array.isArray(value.history) || !value.history.every(isMasterData) || !Array.isArray(value.references) || !value.references.every(isMasterReference)) return false
  const history = value.history
  return history.every((row, index, all) => row.dataId === value.dataId && (index === 0 || row.version < all[index - 1]!.version))
    && value.references.every(row => row.dataId === value.dataId && history.some(item => item.version === row.dataVersion))
    && new Set(value.references.map(row => JSON.stringify([row.dataVersion, row.targetType, row.targetId, row.targetVersion]))).size === value.references.length
}

/** 校验备份记录；状态与校验和来自接口，不由页面推断。 */
export function isBackupRecord(value: unknown): value is BackupRecord {
  return isAdminObject(value, ['backupId', 'status', 'checksum', 'createdAt'], ['name', 'format'])
    && (value.name === undefined || (isAdminText(value.name) && value.name.length <= 80))
    && (value.format === undefined || value.format === 'SYSTEM_SQLITE_V1' || value.format === 'MAIN_SQLITE_V1')
    && isAdminText(value.backupId) && isAdminText(value.checksum)
    && (value.status === 'VALID_FIXTURE' || value.status === 'INVALID_FIXTURE' || value.status === 'VALID' || value.status === 'INVALID')
    && (!(value.status === 'VALID' || value.status === 'INVALID') || /^[A-F0-9]{64}$/.test(value.checksum))
    && isRfc3339DateTime(value.createdAt)
}

/** 校验恢复结果，并拒绝成功但未完成、校验失败仍回滚等矛盾组合。 */
export function isRestoreResult(value: unknown): value is RestoreResult {
  if (!isAdminObject(value, ['prebackupId', 'integrityValid', 'progress', 'result', 'rolledBack', 'generated'])
    || !isAdminText(value.prebackupId) || typeof value.integrityValid !== 'boolean'
    || typeof value.rolledBack !== 'boolean' || typeof value.generated !== 'boolean'
    || typeof value.progress !== 'number' || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 100) return false
  return value.result === 'SUCCESS'
    ? value.integrityValid && value.progress === 100 && !value.rolledBack
    : value.result === 'FAILURE' && (value.integrityValid ? value.rolledBack : !value.rolledBack && value.progress === 0)
}

/** 校验归档关联编号；不使用页面内的固定编号替代接口记录。 */
export function isArchiveRecord(value: unknown): value is ArchiveRecord {
  return isAdminObject(value, ['archiveId', 'taskId', 'scenarioId', 'runId', 'replayId', 'reportId', 'status'])
    && value.status === 'INDEXED'
    && Object.entries({ archiveId: 'ARCH-', taskId: 'TASK-', scenarioId: 'SCN-', runId: 'RUN-', replayId: 'REPLAY-', reportId: 'RPT-' })
      .every(([key, prefix]) => typeof value[key] === 'string' && (value[key] as string).startsWith(prefix) && (value[key] as string).length > prefix.length)
}

/** 校验当前阶段的系统状态；外部依赖未接入不能被当成健康。 */
export function isSystemHealth(value: unknown): value is SystemHealth {
  return isAdminObject(value, ['ui', 'engine', 'database', 'channel']) && value.ui === 'HEALTHY'
    && value.engine === 'NOT_CONNECTED_BY_DESIGN' && value.database === 'NOT_CONNECTED_BY_DESIGN'
    && value.channel === 'NOT_CONNECTED_BY_DESIGN'
}

import type { ArchiveRecord, BackupRecord, MasterData, RestoreResult, SystemHealth } from '../../contracts/domain-models'
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
  return isAdminObject(value, ['dataId', 'kind', 'version', 'referenceCount', 'active'])
    && isAdminText(value.dataId) && isAdminText(value.kind)
    // 点路径段会被浏览器规范化，无法作为可维护资源的编号。
    && value.dataId !== '.' && value.dataId !== '..'
    && Number.isSafeInteger(value.version) && Number(value.version) >= 1
    && Number.isSafeInteger(value.referenceCount) && Number(value.referenceCount) >= 0
    && typeof value.active === 'boolean'
}

/** 校验备份记录；状态与校验和来自接口，不由页面推断。 */
export function isBackupRecord(value: unknown): value is BackupRecord {
  return isAdminObject(value, ['backupId', 'status', 'checksum', 'createdAt'])
    && isAdminText(value.backupId) && isAdminText(value.checksum)
    && (value.status === 'VALID_FIXTURE' || value.status === 'INVALID_FIXTURE')
    && isRfc3339DateTime(value.createdAt)
}

/** 校验恢复结果，并拒绝成功但未完成、校验失败仍回滚等矛盾组合。 */
export function isRestoreResult(value: unknown): value is RestoreResult {
  if (!isAdminObject(value, ['prebackupId', 'integrityValid', 'progress', 'result', 'rolledBack', 'generated'])
    || !isAdminText(value.prebackupId) || typeof value.integrityValid !== 'boolean'
    || typeof value.rolledBack !== 'boolean' || value.generated !== false
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

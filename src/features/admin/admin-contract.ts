import type { ArchiveRecord, BackupRecord, MasterData, MasterDataContent, MasterDataEntry, MasterDataReference, MasterDataTarget, MasterDataDetails, RestoreResult, SystemHealth } from '../../contracts/domain-models'
import { isRfc3339DateTime } from '../scenarios/scenario-validation'

export const MASTER_DATA_KINDS: Record<string, string> = {
  DEVICE: '设备', COMMUNICATION_SYSTEM: '通信体制', PARAMETER_DICTIONARY: '参数字典', ENUMERATION: '枚举',
}

/** 设备参数已有专用模型；通用字典不再重复保存这些字段的默认值。 */
export const EQUIPMENT_PARAMETER_KEYS: readonly string[] = [
  'frequencyMinMHz', 'frequencyMaxMHz', 'bandwidth', 'bandwidthMHz', 'txPower', 'txPowerW',
  'dataRate', 'dataRateMbps', 'modulation', 'berThreshold',
]

export function masterDataEquipmentFieldIssue(data: MasterData): { fieldPath: string; message: string } | undefined {
  if (data.kind === 'ENUMERATION') return undefined
  const index = data.content?.entries.findIndex(entry => EQUIPMENT_PARAMETER_KEYS.includes(entry.key)) ?? -1
  if (index < 0) return undefined
  return {
    fieldPath: `content.entries[${index}].key`,
    message: `${data.content!.entries[index]!.key} 属于设备固有参数，请在“设备参数”中维护；通用基础数据用于公共参数和枚举。`,
  }
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

/** 校验通用数据的闭合结构、正整数版本和非负引用数量；供前后端共用。 */
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

/** 保留原写入校验作为信任边界，仅为被拒绝的数据定位首个错误。 */
export function masterDataWriteIssue(value: unknown): { fieldPath: string; message: string } | undefined {
  if (isMasterWrite(value)) return undefined
  const issue = (fieldPath: string, message: string) => ({ fieldPath, message })
  if (!isAdminObject(value, [], ['dataId', 'kind', 'version', 'referenceCount', 'active', 'content'])) return issue('data', '通用数据结构不正确或包含不支持的字段，请重新打开编辑弹框。')
  if (!isAdminText(value.dataId)) return issue('dataId', '编号不能为空或全是空格。')
  if (value.dataId === '.' || value.dataId === '..') return issue('dataId', '编号不能为 . 或 ..。')
  if (typeof value.kind !== 'string' || !['COMMUNICATION_SYSTEM', 'PARAMETER_DICTIONARY', 'ENUMERATION'].includes(value.kind)) return issue('kind', '类型必须选择通信体制、参数字典或枚举。')
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 1) return issue('version', '当前版本必须为正整数，请重新加载数据。')
  if (!Number.isSafeInteger(value.referenceCount) || Number(value.referenceCount) < 0) return issue('referenceCount', '引用数量必须为非负整数，请重新加载数据。')
  if (typeof value.active !== 'boolean') return issue('active', '状态必须选择启用或停用。')
  const content = value.content
  if (!isAdminObject(content, [], ['name', 'description', 'entries'])) return issue('content', '请填写通用数据内容，包括名称、说明和参数条目；不能包含其他字段。')
  if (!isAdminText(content.name)) return issue('content.name', '名称不能为空或全是空格。')
  if (content.name.length > 80) return issue('content.name', '名称最多填写 80 字。')
  if (typeof content.description !== 'string' || content.description.length > 1000) return issue('content.description', '说明必须为文本，最多填写 1000 字，可留空。')
  if (!Array.isArray(content.entries) || content.entries.length === 0) return issue('content.entries', '参数条目不能为空，请至少新增并填写一条参数。')
  if (content.entries.length > 100) return issue('content.entries', '参数条目最多填写 100 条。')
  const keys = new Set<string>()
  const enumValues = new Set<string>()
  for (const [index, entry] of content.entries.entries()) {
    const path = `content.entries[${index}]`
    const label = `第 ${index + 1} 条参数`
    if (!isAdminObject(entry, [], ['key', 'valueType', 'value', 'unit', 'minimum', 'maximum'])) return issue(path, `${label}结构不正确或包含不支持的字段。`)
    if (!isAdminText(entry.key)) return issue(`${path}.key`, `${label}：参数键不能为空。`)
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(entry.key)) return issue(`${path}.key`, `${label}：参数键须以英文字母开头，仅允许字母、数字、下划线、点和连字符，最多 64 字符。`)
    if (keys.has(entry.key)) return issue(`${path}.key`, `${label}：参数键 ${entry.key} 重复，请使用不同的参数键。`)
    keys.add(entry.key)
    if (value.kind === 'ENUMERATION' && entry.valueType !== 'TEXT') return issue(`${path}.valueType`, `${label}：枚举类型仅允许 TEXT（文本）。`)
    if (entry.valueType === 'TEXT' || entry.valueType === 'BOOLEAN') {
      const extra = ['unit', 'minimum', 'maximum'].find(key => Object.hasOwn(entry, key))
      if (extra) return issue(`${path}.${extra}`, `${label}：${entry.valueType} 类型不能设置单位、最小值或最大值，请重新选择值类型。`)
      if (entry.valueType === 'TEXT') {
        if (!isAdminText(entry.value)) return issue(`${path}.value`, `${label}：文本值不能为空或全是空格。`)
        if (entry.value.length > 1000) return issue(`${path}.value`, `${label}：文本值最多填写 1000 字。`)
        if (value.kind === 'ENUMERATION' && enumValues.has(entry.value)) return issue(`${path}.value`, `${label}：枚举文本值 ${entry.value} 重复，请填写不同的值。`)
        enumValues.add(entry.value)
      } else if (typeof entry.value !== 'boolean') return issue(`${path}.value`, `${label}：布尔值必须通过开关选择“是”或“否”。`)
    } else if (entry.valueType === 'NUMBER') {
      if (typeof entry.value !== 'number' || !Number.isFinite(entry.value)) return issue(`${path}.value`, `${label}：数值不能为空，且必须为有效的整数或小数。`)
      if (entry.unit !== undefined && (typeof entry.unit !== 'string' || entry.unit.length > 24)) return issue(`${path}.unit`, `${label}：单位必须为文本，最多 24 字符，可留空。`)
      if (entry.minimum !== undefined && (typeof entry.minimum !== 'number' || !Number.isFinite(entry.minimum))) return issue(`${path}.minimum`, `${label}：最小值必须为有效数值，或留空。`)
      if (entry.maximum !== undefined && (typeof entry.maximum !== 'number' || !Number.isFinite(entry.maximum))) return issue(`${path}.maximum`, `${label}：最大值必须为有效数值，或留空。`)
      if (typeof entry.minimum === 'number' && typeof entry.maximum === 'number' && entry.minimum > entry.maximum) return issue(`${path}.maximum`, `${label}：最大值不能小于最小值。`)
      if (typeof entry.minimum === 'number' && entry.value < entry.minimum) return issue(`${path}.value`, `${label}：数值不能小于最小值 ${entry.minimum}。`)
      if (typeof entry.maximum === 'number' && entry.value > entry.maximum) return issue(`${path}.value`, `${label}：数值不能大于最大值 ${entry.maximum}。`)
    } else return issue(`${path}.valueType`, `${label}：值类型必须选择 TEXT、NUMBER 或 BOOLEAN。`)
  }
  return issue('data', '通用数据字段结构不正确，请重新打开编辑弹框。')
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

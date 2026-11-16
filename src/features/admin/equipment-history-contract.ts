import type { EquipmentDetails, EquipmentParameter, EquipmentReference } from '../../contracts/domain-models'
import { isAdminObject, isAdminText } from './admin-contract'
import { equipmentIssue, isEquipmentDetails, isEquipmentParameter, isEquipmentReference } from './equipment-contract'

/**
 * 设备历史与显式重建的独立本地 DTO。
 * 与冻结的 EquipmentParameter / EquipmentDetails 合同分开：普通新建响应和旧详情响应不被放宽。
 */

export type EquipmentTargetType = 'RUN' | 'TEMPLATE' | 'ARCHIVE' | 'SCENARIO'
export const EQUIPMENT_TARGET_TYPES: readonly EquipmentTargetType[] = ['RUN', 'TEMPLATE', 'ARCHIVE', 'SCENARIO']

export type EquipmentLifecycleEventType = 'DELETE' | 'RECREATE'

/** 发布目标的已证实历史引用：固定设备版本与目标身份，解除当前引用后仍保留。 */
export interface EquipmentPublishedReference {
  equipmentId: string
  equipmentVersion: number
  targetType: EquipmentTargetType
  targetId: string
  targetVersion: string
  /** 来源摘要（链路/端口路径与字段列表），用于不接受参数相等猜测来源。 */
  sourceSummary: string
  createdAt?: string
}

/** 删除/重建生命周期事件；不占用参数版本号。 */
export interface EquipmentLifecycleEvent {
  eventType: EquipmentLifecycleEventType
  /** DELETE 为被删除的最后参数版本；RECREATE 为重建后的新版本。 */
  version: number
  occurredAt: string
  operator: string
}

/** 人工核验记录：必须给出覆盖目标、依据摘要、结论、操作者与时间，不能只靠确认按钮。 */
export interface EquipmentVerificationRecord {
  equipmentId: string
  coveredTargets: string
  evidenceSummary: string
  conclusion: string
  operator: string
  verifiedAt: string
}

/** 扩展本地详情：在冻结 EquipmentDetails 之外补充生命周期、发布引用与核验状态。 */
export interface EquipmentHistoryDetails extends EquipmentDetails {
  equipmentId: string
  deleted: boolean
  current: EquipmentParameter | null
  publishedReferences: EquipmentPublishedReference[]
  lifecycle: EquipmentLifecycleEvent[]
  verification: EquipmentVerificationRecord | null
  pendingVerification: boolean
}

/** 重建时客户端只提交可编辑参数；编号取路径、版本由服务端分配，只读属性不可覆盖。 */
export interface EquipmentRecreateParameters {
  type: string
  frequencyMinMHz: number | null
  frequencyMaxMHz: number | null
  modulation: string | null
  berThreshold: number | null
  bandwidthMHz?: number | null
  txPowerW?: number | null
  dataRateMbps?: number | null
  active?: boolean
}

export interface EquipmentRecreateRequest {
  expectedHistoryVersion: number
  parameters: EquipmentRecreateParameters
}

/** 重建响应的独立本地 DTO：保存后的设备与实际生命周期事件。 */
export interface EquipmentRecreateResult {
  equipment: EquipmentParameter
  event: EquipmentLifecycleEvent
}

const RECREATE_REQUIRED = ['type', 'frequencyMinMHz', 'frequencyMaxMHz', 'modulation', 'berThreshold'] as const
const RECREATE_OPTIONAL = ['bandwidthMHz', 'txPowerW', 'dataRateMbps', 'active'] as const

export function isEquipmentRecreateParameters(value: unknown): value is EquipmentRecreateParameters {
  if (!isAdminObject(value, [...RECREATE_REQUIRED], [...RECREATE_OPTIONAL])) return false
  // 校验可编辑参数本身；编号与版本由服务端补全，只读标记不可由客户端提交。
  const record = { equipmentId: 'RECREATE-PLACEHOLDER', version: 1, readOnly: false, ...value }
  return equipmentIssue(record, 'write') === null
}

export function isEquipmentRecreateRequest(value: unknown): value is EquipmentRecreateRequest {
  if (!isAdminObject(value, ['expectedHistoryVersion', 'parameters'])) return false
  const request = value as Partial<EquipmentRecreateRequest>
  return Number.isSafeInteger(request.expectedHistoryVersion) && Number(request.expectedHistoryVersion) >= 1
    && isEquipmentRecreateParameters(request.parameters)
}

export function isEquipmentLifecycleEvent(value: unknown): value is EquipmentLifecycleEvent {
  if (!isAdminObject(value, ['eventType', 'version', 'occurredAt', 'operator'])) return false
  const event = value as Partial<EquipmentLifecycleEvent>
  return (event.eventType === 'DELETE' || event.eventType === 'RECREATE')
    && Number.isSafeInteger(event.version) && Number(event.version) >= 1
    && typeof event.occurredAt === 'string' && Number.isFinite(Date.parse(event.occurredAt))
    && isAdminText(event.operator)
}

export function isEquipmentPublishedReference(value: unknown): value is EquipmentPublishedReference {
  if (!isAdminObject(value, ['equipmentId', 'equipmentVersion', 'targetType', 'targetId', 'targetVersion', 'sourceSummary'], ['createdAt'])) return false
  const reference = value as Partial<EquipmentPublishedReference>
  return isAdminText(reference.equipmentId)
    && Number.isSafeInteger(reference.equipmentVersion) && Number(reference.equipmentVersion) >= 1
    && EQUIPMENT_TARGET_TYPES.includes(reference.targetType as EquipmentTargetType)
    && isAdminText(reference.targetId) && isAdminText(reference.targetVersion) && isAdminText(reference.sourceSummary)
    && (reference.createdAt === undefined || (typeof reference.createdAt === 'string' && Number.isFinite(Date.parse(reference.createdAt))))
}

export function isEquipmentVerificationRecord(value: unknown): value is EquipmentVerificationRecord {
  if (!isAdminObject(value, ['equipmentId', 'coveredTargets', 'evidenceSummary', 'conclusion', 'operator', 'verifiedAt'])) return false
  const record = value as Partial<EquipmentVerificationRecord>
  return isAdminText(record.equipmentId) && isAdminText(record.coveredTargets) && isAdminText(record.evidenceSummary)
    && isAdminText(record.conclusion) && isAdminText(record.operator)
    && typeof record.verifiedAt === 'string' && Number.isFinite(Date.parse(record.verifiedAt))
}

/** 重建请求体里允许出现的可编辑键；服务端拒绝客户端覆盖 equipmentId/version/readOnly。 */
export function isEquipmentRecreateEditableKey(key: string): boolean {
  return (RECREATE_REQUIRED as readonly string[]).includes(key) || (RECREATE_OPTIONAL as readonly string[]).includes(key)
}

export function isEquipmentHistoryDetails(value: unknown): value is EquipmentHistoryDetails {
  if (!isAdminObject(value, ['equipmentId', 'deleted', 'current', 'history', 'references', 'publishedReferences', 'lifecycle', 'verification', 'pendingVerification'])) return false
  const details = value as Partial<EquipmentHistoryDetails>
  return isAdminText(details.equipmentId) && typeof details.deleted === 'boolean' && typeof details.pendingVerification === 'boolean'
    && (details.current === null || isEquipmentParameter(details.current))
    && Array.isArray(details.history) && details.history.every(isEquipmentParameter)
    && Array.isArray(details.references) && details.references.every(isEquipmentReference)
    && Array.isArray(details.publishedReferences) && details.publishedReferences.every(isEquipmentPublishedReference)
    && Array.isArray(details.lifecycle) && details.lifecycle.every(isEquipmentLifecycleEvent)
    && (details.verification === null || isEquipmentVerificationRecord(details.verification))
}

export function isEquipmentRecreateResult(value: unknown): value is EquipmentRecreateResult {
  return isAdminObject(value, ['equipment', 'event']) && isEquipmentParameter(value.equipment) && isEquipmentLifecycleEvent(value.event)
}

/** 现有冻结详情仍按原合同校验；保留显式导出避免调用方误用扩展类型。 */
export { isEquipmentDetails }

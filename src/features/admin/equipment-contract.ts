import type { EquipmentParameter } from '../../contracts/domain-models'
import { isAdminObject, isAdminText } from './admin-contract'

/** 前后端共享写入与响应校验，不解析展示字符串为数值，不接受额外字段。 */
export function equipmentIssue(value: unknown): { fieldPath: string; message: string } | null {
  const issue = (fieldPath: string, message: string) => ({ fieldPath, message })
  if (!isAdminObject(value, ['equipmentId', 'type', 'frequencyMinMHz', 'frequencyMaxMHz', 'modulation', 'berThreshold', 'readOnly', 'version'])) return issue('equipment', '装备参数结构不正确。')
  if (typeof value.equipmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.equipmentId)) return issue('equipmentId', '编号须为 1–64 位字母、数字、下划线或连字符，首位为字母或数字。')
  if (!isAdminText(value.type) || value.type.length > 100) return issue('type', '请填写 1–100 字的装备类型。')
  for (const key of ['frequencyMinMHz', 'frequencyMaxMHz'] as const) {
    const number = value[key]
    if (number !== null && (typeof number !== 'number' || !Number.isFinite(number) || number <= 0)) return issue(key, '频率必须为有限正数，未配置请留空。')
  }
  if ((value.frequencyMinMHz === null) !== (value.frequencyMaxMHz === null)) return issue('frequencyMaxMHz', '频率下限和上限须同时填写或同时留空。')
  if (typeof value.frequencyMinMHz === 'number' && typeof value.frequencyMaxMHz === 'number' && value.frequencyMinMHz > value.frequencyMaxMHz) return issue('frequencyMaxMHz', '频率上限不得小于下限。')
  if (value.modulation !== null && (!isAdminText(value.modulation) || value.modulation.length > 32)) return issue('modulation', '调制名称须为 1–32 字，未配置请留空。')
  if (value.berThreshold !== null && (typeof value.berThreshold !== 'number' || !Number.isFinite(value.berThreshold) || value.berThreshold < 0 || value.berThreshold > 1)) return issue('berThreshold', '误码率失效阈值须在 0～1 之间。')
  if (typeof value.readOnly !== 'boolean') return issue('readOnly', '只读标记不正确。')
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 1) return issue('version', '版本须为正整数。')
  return null
}

export function isEquipmentParameter(value: unknown): value is EquipmentParameter {
  return equipmentIssue(value) === null
}

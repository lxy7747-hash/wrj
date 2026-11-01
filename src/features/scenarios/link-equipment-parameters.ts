import type { EquipmentParameter, Link, Modulation, Platform } from '../../contracts/domain-models'
import { isEquipmentActive, isEquipmentParameter } from '../admin/equipment-contract'
import { equipmentLinkIssues, equipmentTypeIssue, EQUIPMENT_LINK_TYPES } from '../admin/equipment-link-rules'
import { datalinkRateTiers, FIBER_DATA_RATE_MBPS, fixedLinkDataRate, LINK_MODULATIONS, linkPowerMaxW } from './link-calc-defaults'

export { LINK_MODULATIONS } from './link-calc-defaults'
export { EQUIPMENT_LINK_TYPES, equipmentDataRateOptions } from '../admin/equipment-link-rules'

export type LinkEquipmentPreparation =
  | { ok: true; link: Link; fields: string[] }
  | { ok: false; fieldPath: string; message: string }

const failure = (fieldPath: string, message: string): LinkEquipmentPreparation => ({ ok: false, fieldPath, message })

/**
 * Apply only configured, compatible equipment values to a temporary link copy.
 * Frequency remains a user-selected link value; the equipment range is a gate, not a selector.
 */
export function prepareLinkEquipment(link: Link, equipment: EquipmentParameter, platforms: readonly Platform[], allowLegacyType = false): LinkEquipmentPreparation {
  if (!isEquipmentParameter(equipment)) return failure('equipment', '装备参数无效，无法应用。')
  if (!isEquipmentActive(equipment)) return failure('active', '停用装备不可用于链路。')
  // Keep the existing reference-registration policy: read-only equipment cannot be newly applied.
  if (equipment.readOnly) return failure('readOnly', '只读装备不可用于链路。')
  const typeIssue = equipmentTypeIssue(equipment.type, link.type, allowLegacyType)
  if (typeIssue) return failure('type', typeIssue)
  if (!allowLegacyType || EQUIPMENT_LINK_TYPES[equipment.type]) {
    const issue = Object.entries(equipmentLinkIssues(equipment))[0]
    if (issue) return failure(issue[0], issue[1])
  }

  if (equipment.frequencyMinMHz !== null && equipment.frequencyMaxMHz !== null
    && (link.frequency < equipment.frequencyMinMHz || link.frequency > equipment.frequencyMaxMHz)) {
    return failure('frequency', `当前链路频率不在装备支持范围 ${equipment.frequencyMinMHz}～${equipment.frequencyMaxMHz} MHz 内。`)
  }

  if (equipment.txPowerW !== undefined && equipment.txPowerW !== null && equipment.txPowerW > linkPowerMaxW(link.type)) {
    return failure('txPower', `发射功率不能超过 ${linkPowerMaxW(link.type)} W。`)
  }

  if (equipment.modulation !== null && link.type !== 'LASER' && !LINK_MODULATIONS.includes(equipment.modulation as Modulation)) {
    return failure('modulation', '装备调制方式必须为 BPSK 或 QPSK。')
  }

  if (equipment.dataRateMbps !== undefined && equipment.dataRateMbps !== null) {
    const fixedRate = fixedLinkDataRate(link, platforms)
    if (fixedRate !== null && equipment.dataRateMbps !== fixedRate) {
      return failure('dataRate', `该链路数据速率固定为 ${fixedRate} Mbps，与装备参数不一致。`)
    }
    if (link.type === 'DATALINK' && !datalinkRateTiers(link.band ?? 'C', link.direction).includes(equipment.dataRateMbps)) {
      return failure('dataRate', '装备数据速率不在当前数传波段和方向的可用档位内。')
    }
    if (link.type === 'FIBER' && (equipment.dataRateMbps < FIBER_DATA_RATE_MBPS.min || equipment.dataRateMbps > FIBER_DATA_RATE_MBPS.max)) {
      return failure('dataRate', `光纤数据速率必须在 ${FIBER_DATA_RATE_MBPS.min}～${FIBER_DATA_RATE_MBPS.max} Mbps 之间。`)
    }
  }

  const next = structuredClone(link)
  const fields: string[] = []
  if (equipment.bandwidthMHz !== undefined && equipment.bandwidthMHz !== null) {
    next.bandwidth = equipment.bandwidthMHz
    fields.push('bandwidth')
  }
  if (equipment.txPowerW !== undefined && equipment.txPowerW !== null) {
    next.txPower = equipment.txPowerW
    fields.push('txPower')
  }
  if (equipment.dataRateMbps !== undefined && equipment.dataRateMbps !== null) {
    next.dataRate = equipment.dataRateMbps
    fields.push('dataRate')
  }
  if (equipment.modulation !== null && next.type !== 'LASER') {
    next.modulation = equipment.modulation as Modulation
    fields.push('modulation')
  }
  if (equipment.berThreshold !== null) {
    next.berThreshold = equipment.berThreshold
    fields.push('berThreshold')
  }
  return { ok: true, link: next, fields }
}

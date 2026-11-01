import type { EquipmentParameter, LinkType } from '../../contracts/domain-models'
import {
  datalinkRateTiers, FIBER_DATA_RATE_MBPS, formatDataRate, LASER_LINK_MODULATION, LINK_MODULATIONS,
  linkPowerMaxW, MICROWAVE_DATA_RATE_MBPS, SATELLITE_DATA_RATE_MBPS,
} from '../scenarios/link-calc-defaults'

export const EQUIPMENT_LINK_TYPES: Readonly<Record<string, LinkType>> = {
  卫星通信设备: 'SAT', 微波通信设备: 'MICROWAVE', 数传通信设备: 'DATALINK', 激光通信设备: 'LASER', 光纤通信设备: 'FIBER',
}

export function equipmentTypeIssue(type: string, linkType: LinkType, allowLegacyType = false): string | undefined {
  const expected = Object.hasOwn(EQUIPMENT_LINK_TYPES, type) ? EQUIPMENT_LINK_TYPES[type] : undefined
  if (!expected) return allowLegacyType ? undefined : '设备类型尚未明确，请先在设备参数库选择通信设备类型。'
  if (expected !== linkType) return '设备类型与当前链路类型不一致，不能引用。'
  return undefined
}

export function equipmentModulations(type: string): readonly string[] {
  return EQUIPMENT_LINK_TYPES[type] === 'LASER' ? [LASER_LINK_MODULATION] : LINK_MODULATIONS
}

/** 设备未绑定具体卫星、波段或方向，列出原有档位并注明适用条件；引用时仍按目标链路精确校验。 */
export function equipmentDataRateOptions(type: string): Array<{ value: number; label: string }> | null {
  const linkType = EQUIPMENT_LINK_TYPES[type]
  if (linkType === 'MICROWAVE') return [{ value: MICROWAVE_DATA_RATE_MBPS, label: formatDataRate(MICROWAVE_DATA_RATE_MBPS) }]
  if (linkType === 'SAT') return [
    { value: SATELLITE_DATA_RATE_MBPS.TIANTONG, label: `${formatDataRate(SATELLITE_DATA_RATE_MBPS.TIANTONG)}（天通）` },
    { value: SATELLITE_DATA_RATE_MBPS.SHENTONG, label: `${formatDataRate(SATELLITE_DATA_RATE_MBPS.SHENTONG)}（神通）` },
  ]
  if (linkType !== 'DATALINK') return null
  const rates = new Map<number, string[]>()
  for (const band of ['C', 'L'] as const) {
    for (const direction of ['FORWARD', 'REVERSE'] as const) {
      for (const value of datalinkRateTiers(band, direction)) {
        rates.set(value, [...(rates.get(value) ?? []), `${band} 波段${direction === 'FORWARD' ? '前向' : '返向'}`])
      }
    }
  }
  return [...rates].sort(([a], [b]) => a - b).map(([value, contexts]) => ({ value, label: `${formatDataRate(value)}（${contexts.join('、')}）` }))
}

/** 只校验已填写的设备参数，不给旧记录补值；新写入、表单与引用共用。 */
export function equipmentLinkIssues(record: EquipmentParameter): Partial<Record<keyof EquipmentParameter, string>> {
  const errors: Partial<Record<keyof EquipmentParameter, string>> = {}
  const type = Object.hasOwn(EQUIPMENT_LINK_TYPES, record.type) ? EQUIPMENT_LINK_TYPES[record.type] : undefined
  const configured = (value: unknown) => value !== null && value !== undefined
  for (const key of ['frequencyMinMHz', 'frequencyMaxMHz'] as const) {
    const value = record[key]
    if (!configured(value)) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) errors[key] = '频率必须为有限正数，未配置请留空。'
  }
  if (configured(record.frequencyMinMHz) !== configured(record.frequencyMaxMHz)) {
    errors[configured(record.frequencyMinMHz) ? 'frequencyMaxMHz' : 'frequencyMinMHz'] = '频率下限和上限须同时填写或同时留空。'
  } else if (typeof record.frequencyMinMHz === 'number' && typeof record.frequencyMaxMHz === 'number' && record.frequencyMaxMHz < record.frequencyMinMHz) {
    errors.frequencyMaxMHz = '频率上限不得小于下限。'
  }
  if (configured(record.bandwidthMHz)) {
    const value = record.bandwidthMHz!
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) errors.bandwidthMHz = '发射带宽必须为有限正数，未配置请留空。'
  }
  if (configured(record.txPowerW)) {
    const value = record.txPowerW!
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (type === 'LASER' && value === 0)) {
      errors.txPowerW = type === 'LASER' ? '激光光功率必须大于 0 W，未配置请留空。' : '发射功率须为非负有限数值，未配置请留空。'
    } else if (type && value > linkPowerMaxW(type)) errors.txPowerW = `发射功率不能超过 ${linkPowerMaxW(type)} W。`
  }
  if (type && configured(record.modulation) && !equipmentModulations(record.type).includes(record.modulation!)) {
    errors.modulation = type === 'LASER' ? '光调制方式请选择 OOK，未配置请清空。' : '调制方式请选择 BPSK 或 QPSK，未配置请清空。'
  }
  if (configured(record.dataRateMbps)) {
    const value = record.dataRateMbps!
    const options = equipmentDataRateOptions(record.type)
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) errors.dataRateMbps = '数据速率必须大于 0 Mbps，未配置请留空。'
    else if (options && !options.some(option => option.value === value)) errors.dataRateMbps = '数据速率与设备类型不一致，请选择对应的速率档位或清空。'
    else if (type === 'FIBER' && (value < FIBER_DATA_RATE_MBPS.min || value > FIBER_DATA_RATE_MBPS.max)) {
      errors.dataRateMbps = `光纤数据速率必须在 ${FIBER_DATA_RATE_MBPS.min}～${FIBER_DATA_RATE_MBPS.max} Mbps 之间。`
    }
  }
  if (configured(record.berThreshold) && (typeof record.berThreshold !== 'number' || !Number.isFinite(record.berThreshold) || record.berThreshold < 0 || record.berThreshold > 1)) {
    errors.berThreshold = 'BER 阈值必须在 0～1 之间。'
  }
  return errors
}

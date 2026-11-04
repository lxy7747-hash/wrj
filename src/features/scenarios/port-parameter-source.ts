import type { EquipmentParameter, LinkParameterField, MasterData, PortParameters, ScenarioConfig, TemplatePlatformType } from '../../contracts/domain-models'
import { isEquipmentParameter } from '../admin/equipment-contract'
import { EQUIPMENT_PARAMETER_KEYS, isMasterWrite } from '../admin/admin-contract'
import { EQUIPMENT_LINK_TYPES } from '../admin/equipment-link-rules'
import { NUMBER_MAPPINGS } from './link-master-parameters'

export const PORT_SOURCE_FIELDS = {
  frequency: 'txFrequency', bandwidth: 'txBandwidth', txPower: 'txPower', rxFrequency: 'rxFrequency',
  rxBandwidth: 'rxBandwidth', dataRate: 'transferRate', noiseFigureDb: 'noiseFigureDb',
} as const
export interface PortParameterTarget {
  id: string
  path: string
  type: TemplatePlatformType
  port: string
  parameters: PortParameters
}

/** 保留旧链路引用，端口引用使用不会与场景合法链路编号混淆的独立键。 */
export function portParameterTargets(config: ScenarioConfig): PortParameterTarget[] {
  return Object.entries(config.deviceParameters?.ports ?? {}).flatMap(([type, ports]) =>
    Object.entries(ports ?? {}).flatMap(([port, parameters]) => parameters ? [{
      id: `@port:${type}/${port}`, path: `deviceParameters.ports.${type}.${port}`,
      type: type as TemplatePlatformType, port, parameters,
    }] : []))
}

type Preparation = { ok: true; parameters: PortParameters; fields: LinkParameterField[] } | { ok: false; message: string }
const invalid = (message: string): Preparation => ({ ok: false, message })

export function preparePortEquipment(target: PortParameterTarget, equipment: EquipmentParameter): Preparation {
  const expected = target.port.startsWith('sat_link') ? 'SAT' : target.port === 'microwave_link' ? 'MICROWAVE'
    : /^[cl]_band_/.test(target.port) ? 'DATALINK' : null
  if (!expected || !isEquipmentParameter(equipment) || equipment.active === false || equipment.readOnly
    || EQUIPMENT_LINK_TYPES[equipment.type] !== expected) return invalid('装备类型与通信端口不符，或装备不可引用。')
  if (equipment.frequencyMinMHz !== null && equipment.frequencyMaxMHz !== null
    && (target.parameters.txFrequency < equipment.frequencyMinMHz || target.parameters.txFrequency > equipment.frequencyMaxMHz)) {
    return invalid('端口发射频率不在装备支持范围内；不会自动选择频率。')
  }
  const parameters = structuredClone(target.parameters)
  const fields: LinkParameterField[] = []
  for (const [key, field] of [['bandwidthMHz', 'bandwidth'], ['txPowerW', 'txPower'], ['dataRateMbps', 'dataRate']] as const) {
    const value = equipment[key]
    if (value === null || value === undefined) continue
    if (!Number.isFinite(value) || value <= 0) return invalid('装备提供的端口参数必须为正有限数。')
    parameters[PORT_SOURCE_FIELDS[field]] = value
    fields.push(field)
  }
  return fields.length ? { ok: true, parameters, fields } : invalid('装备没有可用于该端口的参数。')
}

export function preparePortMasterData(target: PortParameterTarget, record: MasterData, allowHistorical = false): Preparation {
  if (!isMasterWrite(record) || !record.active || record.kind === 'ENUMERATION' || target.port === 'fiber_link') return invalid('通用数据不可用于该通信端口。')
  const parameters = structuredClone(target.parameters)
  const fields: LinkParameterField[] = []
  for (const entry of record.content!.entries) {
    if (!allowHistorical && EQUIPMENT_PARAMETER_KEYS.includes(entry.key)) continue
    const mapping = NUMBER_MAPPINGS[entry.key]
    if (!mapping || !Object.hasOwn(PORT_SOURCE_FIELDS, mapping.field) || fields.includes(mapping.field)
      || entry.valueType !== 'NUMBER' || typeof entry.value !== 'number' || !Number.isFinite(entry.value)) continue
    if ((mapping.unit === undefined && entry.unit !== undefined)
      || (mapping.unit !== undefined && entry.unit !== undefined && mapping.unit !== entry.unit)
      || (entry.key === mapping.field && mapping.unit !== undefined && entry.unit !== mapping.unit)) continue
    if (entry.value < 0 || (mapping.field !== 'noiseFigureDb' && entry.value === 0)) return invalid('通用数据中的端口参数超出允许范围。')
    parameters[PORT_SOURCE_FIELDS[mapping.field as keyof typeof PORT_SOURCE_FIELDS]] = entry.value
    fields.push(mapping.field)
  }
  return fields.length ? { ok: true, parameters, fields } : invalid('没有可应用到端口的公共数字参数。')
}

export function matchesPortSource(parameters: PortParameters, prepared: PortParameters, fields: readonly string[]): boolean {
  return fields.every(field => Object.hasOwn(PORT_SOURCE_FIELDS, field)
    && Object.is(parameters[PORT_SOURCE_FIELDS[field as keyof typeof PORT_SOURCE_FIELDS]], prepared[PORT_SOURCE_FIELDS[field as keyof typeof PORT_SOURCE_FIELDS]]))
}

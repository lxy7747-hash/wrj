import type { Link, LinkParameterField, MasterData, MasterDataEntry, Platform } from '../../contracts/domain-models'
import { EQUIPMENT_PARAMETER_KEYS, isMasterWrite } from '../admin/admin-contract'
import { datalinkRateTiers, FIBER_DATA_RATE_MBPS, fixedLinkDataRate, linkPowerMaxW } from './link-calc-defaults'

export type LinkMasterDataPreparation =
  | { ok: true; link: Link; fields: LinkParameterField[]; skipped: Array<{ key: string; reason: string }> }
  | { ok: false; fieldPath: string; message: string; skipped?: Array<{ key: string; reason: string }> }

type NumberMapping = { field: Exclude<LinkParameterField, 'modulation' | 'coding' | 'txPolarization' | 'rxPolarization'>; unit?: 'MHz' | 'W' | 'Mbps' | 'dBi' | 'dB' }

export const NUMBER_MAPPINGS: Readonly<Record<string, NumberMapping>> = {
  frequency: { field: 'frequency', unit: 'MHz' }, frequencyMHz: { field: 'frequency', unit: 'MHz' },
  bandwidth: { field: 'bandwidth', unit: 'MHz' }, bandwidthMHz: { field: 'bandwidth', unit: 'MHz' },
  txPower: { field: 'txPower', unit: 'W' }, txPowerW: { field: 'txPower', unit: 'W' },
  dataRate: { field: 'dataRate', unit: 'Mbps' }, dataRateMbps: { field: 'dataRate', unit: 'Mbps' },
  berThreshold: { field: 'berThreshold' },
  rxFrequency: { field: 'rxFrequency', unit: 'MHz' }, rxFrequencyMHz: { field: 'rxFrequency', unit: 'MHz' },
  rxBandwidth: { field: 'rxBandwidth', unit: 'MHz' }, rxBandwidthMHz: { field: 'rxBandwidth', unit: 'MHz' },
  'antennaGain.tx': { field: 'antennaGain.tx', unit: 'dBi' }, txAntennaGainDbi: { field: 'antennaGain.tx', unit: 'dBi' },
  'antennaGain.rx': { field: 'antennaGain.rx', unit: 'dBi' }, rxAntennaGainDbi: { field: 'antennaGain.rx', unit: 'dBi' },
  antennaGainCorrectionDb: { field: 'antennaGainCorrectionDb', unit: 'dB' },
  noiseFigureDb: { field: 'noiseFigureDb', unit: 'dB' },
}
export const PUBLIC_LINK_PARAMETER_OPTIONS = ([
  ['frequencyMHz', '发射频率', 'COMMUNICATION_SYSTEM'],
  ['rxFrequencyMHz', '接收频率', 'COMMUNICATION_SYSTEM'],
  ['rxBandwidthMHz', '接收带宽', 'COMMUNICATION_SYSTEM'],
  ['txAntennaGainDbi', '发射天线增益', 'PARAMETER_DICTIONARY'],
  ['rxAntennaGainDbi', '接收天线增益', 'PARAMETER_DICTIONARY'],
  ['antennaGainCorrectionDb', '天线增益修正', 'PARAMETER_DICTIONARY'],
  ['noiseFigureDb', '接收机噪声系数', 'PARAMETER_DICTIONARY'],
] as const).map(([key, label, kind]) => {
  const mapping = NUMBER_MAPPINGS[key]!
  return { key, label, kind, unit: mapping.unit, aliases: Object.keys(NUMBER_MAPPINGS).filter(alias => NUMBER_MAPPINGS[alias]!.field === mapping.field) }
})
const ENUM_FIELDS = new Set(['modulation', 'coding', 'txPolarization', 'rxPolarization'] as const)

function failure(fieldPath: string, message: string): LinkMasterDataPreparation { return { ok: false, fieldPath, message } }
function skip(skipped: Array<{ key: string; reason: string }>, key: string, reason: string): void { skipped.push({ key, reason }) }

function enumValue(entry: MasterDataEntry, entryKey?: string): { field: LinkParameterField; value: string } | null {
  if (entry.valueType !== 'TEXT' || entry.key !== entryKey) return null
  const [field, value, ...rest] = entry.key.split('.')
  if (rest.length > 0 || !value || !ENUM_FIELDS.has(field as 'modulation')) return null
  if (entry.value !== value) return null
  if ((field === 'modulation' && !['BPSK', 'QPSK'].includes(value))
    || ((field === 'txPolarization' || field === 'rxPolarization') && !['vertical', 'horizontal'].includes(value))) return null
  return { field: field as LinkParameterField, value }
}

function assignNumber(next: Link, field: NumberMapping['field'], value: number): void {
  if (field === 'antennaGain.tx') next.antennaGain.tx = value
  else if (field === 'antennaGain.rx') next.antennaGain.rx = value
  else next[field] = value as never
}

function numericConflict(link: Link, field: NumberMapping['field'], value: number, platforms: readonly Platform[]): string | undefined {
  if ((field === 'frequency' || field === 'bandwidth' || field === 'rxFrequency' || field === 'rxBandwidth') && value <= 0) return '必须大于 0。'
  if (field === 'txPower' && (value < 0 || value > linkPowerMaxW(link.type))) return `必须在 0～${linkPowerMaxW(link.type)} W 之间。`
  if (field === 'dataRate') {
    if (link.type === 'LASER' && value <= 0) return '激光链路数据速率必须大于 0 Mbps。'
    const fixed = fixedLinkDataRate(link, platforms)
    if (fixed !== null && value !== fixed) return `该链路数据速率固定为 ${fixed} Mbps。`
    if (link.type === 'DATALINK' && !datalinkRateTiers(link.band ?? 'C', link.direction).includes(value)) return '不在当前数传波段和方向的可用档位内。'
    if (link.type === 'FIBER' && (value < FIBER_DATA_RATE_MBPS.min || value > FIBER_DATA_RATE_MBPS.max)) return `必须在 ${FIBER_DATA_RATE_MBPS.min}～${FIBER_DATA_RATE_MBPS.max} Mbps 之间。`
  }
  if (field === 'berThreshold' && (value < 0 || value > 1)) return '必须在 0～1 之间。'
  if (field === 'noiseFigureDb' && (value < 0 || value > 100)) return '必须在 0～100 dB 之间。'
  return undefined
}

/** Maps only documented key/unit pairs; unknown or malformed entries remain visible to the caller as skipped. */
export function prepareLinkMasterData(link: Link, data: MasterData, platforms: readonly Platform[], entryKey?: string, allowLegacyEquipmentFields = false): LinkMasterDataPreparation {
  if (!isMasterWrite(data)) return failure('masterData', '通用基础数据无有效内容，无法应用。')
  if (!data.active) return failure('active', '停用通用基础数据不可用于链路。')
  if (entryKey !== undefined && (typeof entryKey !== 'string' || entryKey.trim() === '')) return failure('entryKey', '枚举条目必须明确选择。')

  const next = structuredClone(link)
  const fields: LinkParameterField[] = []
  const skipped: Array<{ key: string; reason: string }> = []
  for (const entry of data.content.entries) {
    if (data.kind === 'ENUMERATION') {
      if (entryKey === undefined || entry.key !== entryKey) continue
      const selected = enumValue(entry, entryKey)
      if (!selected) { skip(skipped, entry.key, '枚举键、文本类型或选项值不受支持。'); continue }
      if (next.type === 'LASER' && selected.field === 'modulation') { skip(skipped, entry.key, '激光链路不映射射频调制方式。'); continue }
      if (fields.includes(selected.field)) { skip(skipped, entry.key, '同一链路字段已由先前条目设置。'); continue }
      if (selected.field === 'modulation') next.modulation = selected.value as Link['modulation']
      else if (selected.field === 'coding') next.coding = selected.value
      else if (selected.field === 'txPolarization') next.txPolarization = selected.value as Link['txPolarization']
      else next.rxPolarization = selected.value as Link['rxPolarization']
      fields.push(selected.field)
      continue
    }

    // 历史来源仍按原值核验；新选用不能用通用字典覆盖设备参数。
    if (!allowLegacyEquipmentFields && EQUIPMENT_PARAMETER_KEYS.includes(entry.key)) {
      skip(skipped, entry.key, '属于设备固有参数，请在“设备参数”中维护。')
      continue
    }
    const mapping = NUMBER_MAPPINGS[entry.key]
    if (!mapping) { skip(skipped, entry.key, '不是受支持的链路参数字段。'); continue }
    if (entry.valueType !== 'NUMBER' || typeof entry.value !== 'number' || !Number.isFinite(entry.value)) { skip(skipped, entry.key, '参数必须是有限 NUMBER。'); continue }
    const isAlias = entry.key !== mapping.field
    if ((mapping.unit === undefined && entry.unit !== undefined) || (mapping.unit !== undefined && entry.unit !== undefined && entry.unit !== mapping.unit)
      || (!isAlias && mapping.unit !== undefined && entry.unit !== mapping.unit)) { skip(skipped, entry.key, '单位与链路字段不一致。'); continue }
    if (fields.includes(mapping.field)) { skip(skipped, entry.key, '同一链路字段已由先前条目设置。'); continue }
    const conflict = numericConflict(next, mapping.field, entry.value, platforms)
    if (conflict) return failure(mapping.field, `通用基础数据 ${entry.key}${conflict}`)
    assignNumber(next, mapping.field, entry.value)
    fields.push(mapping.field)
  }
  return fields.length > 0 ? { ok: true, link: next, fields, skipped }
    : { ...failure('content.entries', '未找到可应用的公共链路参数。'), skipped }
}

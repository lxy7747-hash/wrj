import type { LinkParameterField, LinkParameterSource } from '../../contracts/domain-models'

const FIELDS = [
  'frequency', 'bandwidth', 'txPower', 'dataRate', 'modulation', 'berThreshold', 'coding',
  'rxFrequency', 'rxBandwidth', 'antennaGain.tx', 'antennaGain.rx', 'antennaGainCorrectionDb',
  'noiseFigureDb', 'txPolarization', 'rxPolarization',
] as const satisfies readonly LinkParameterField[]
const EQUIPMENT_FIELDS = new Set<LinkParameterField>(['bandwidth', 'txPower', 'dataRate', 'modulation', 'berThreshold'])

export function isLinkParameterSource(value: unknown): value is LinkParameterSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  const allowed = ['kind', 'sourceId', 'sourceVersion', 'fields', 'entryKey']
  if (!Object.keys(source).every(key => allowed.includes(key))
    || (source.kind !== 'EQUIPMENT' && source.kind !== 'MASTER_DATA')
    || typeof source.sourceId !== 'string' || source.sourceId.trim() === ''
    || typeof source.sourceVersion !== 'number' || !Number.isSafeInteger(source.sourceVersion) || source.sourceVersion <= 0
    || !Array.isArray(source.fields) || source.fields.length < 1 || source.fields.length > FIELDS.length
    || source.fields.some(field => typeof field !== 'string' || !(FIELDS as readonly string[]).includes(field))
    || new Set(source.fields).size !== source.fields.length) return false
  if (source.entryKey !== undefined && (typeof source.entryKey !== 'string' || source.entryKey.trim() === '')) return false
  return source.kind === 'MASTER_DATA' || (source.entryKey === undefined && source.fields.every(field => EQUIPMENT_FIELDS.has(field as LinkParameterField)))
}

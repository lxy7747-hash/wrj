import type { LocalDetectionEvent } from '../../contracts/domain-models'
import type { AfsimLogEvent } from '../data-exchange/afsim-event-log'

/** 原生侦测类事件；ESM 被动侦测产生检测变化和航迹，均按同一规范输出。 */
export const DETECTION_EVENT_TYPES = ['SENSOR_DETECTION_CHANGED', 'SENSOR_TRACK_INITIATED', 'SENSOR_TRACK_UPDATED', 'SENSOR_TRACK_DROPPED'] as const
const DETECTION_TYPE_SET = new Set<string>(DETECTION_EVENT_TYPES)

const finiteOrNull = (text: string | undefined): number | null => {
  if (text === undefined || text.trim() === '') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}
const textOrNull = (text: string | undefined): string | null => text?.trim() ? text.trim() : null

/**
 * 把原生 SENSOR_* 事件映射为规范侦测事件：目标、频段、概率、时刻。
 * @remarks 只读取 AFSIM 声明的列：target_platform、frequency_low_#/frequency_high_#（Hz）、Pd、detected；
 * 列缺失或为空时置 null，不用配置值或默认值补齐，也不推算概率。
 */
export function toDetectionEvent(event: AfsimLogEvent): LocalDetectionEvent | null {
  if (!DETECTION_TYPE_SET.has(event.type)) return null
  const fields = event.fields
  const sensorId = textOrNull(fields.sensor)
  if (!sensorId || !event.subject) return null
  const detectedText = fields.detected?.trim()
  const low = finiteOrNull(fields['frequency_low_#'])
  const high = finiteOrNull(fields['frequency_high_#'])
  const probability = finiteOrNull(fields.Pd)
  return {
    eventId: event.id, time: event.time, type: event.type, platformId: event.subject, sensorId,
    targetPlatformId: textOrNull(fields.target_platform),
    frequencyMinHz: low !== null && low > 0 ? low : null,
    frequencyMaxHz: high !== null && high > 0 ? high : null,
    probability: probability !== null && probability >= 0 && probability <= 1 ? probability : null,
    detected: detectedText === '1' ? true : detectedText === '0' ? false : null,
  }
}

export function isDetectionEvent(value: unknown, platformIds: ReadonlySet<string>): value is LocalDetectionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const keys = ['eventId', 'time', 'type', 'platformId', 'sensorId', 'targetPlatformId', 'frequencyMinHz', 'frequencyMaxHz', 'probability', 'detected']
  if (Object.keys(row).length !== keys.length || !keys.every(key => Object.hasOwn(row, key))) return false
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0
  const hz = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0)
  return text(row.eventId) && typeof row.time === 'number' && Number.isFinite(row.time) && row.time >= 0
    && typeof row.type === 'string' && DETECTION_TYPE_SET.has(row.type)
    && text(row.platformId) && platformIds.has(String(row.platformId)) && text(row.sensorId)
    && (row.targetPlatformId === null || text(row.targetPlatformId))
    && hz(row.frequencyMinHz) && hz(row.frequencyMaxHz)
    && (row.probability === null || (typeof row.probability === 'number' && row.probability >= 0 && row.probability <= 1))
    && (row.detected === null || typeof row.detected === 'boolean')
}

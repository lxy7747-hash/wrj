import type { AfsimLogEvent } from '../data-exchange/afsim-event-log'

/** 文件设备事件只证明启停或请求状态，不证明物理链路通断和干扰效果。 */
export interface FileDeviceEvent {
  sourceEventId: string
  time: number
  platformId: string
  deviceId: string
  kind: 'COMMUNICATION' | 'JAMMING'
  active: boolean
  frequencyHz?: number
  bandwidthHz?: number
}

export function isFileDeviceEvent(value: unknown, platformIds: ReadonlySet<string>): value is FileDeviceEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as FileDeviceEvent
  return [event.sourceEventId, event.platformId, event.deviceId].every(text => typeof text === 'string' && text.trim().length > 0)
    && platformIds.has(event.platformId) && Number.isFinite(event.time) && event.time >= 0
    && ['COMMUNICATION', 'JAMMING'].includes(event.kind) && typeof event.active === 'boolean'
    && (event.kind === 'JAMMING'
      ? (!event.active && event.frequencyHz === undefined && event.bandwidthHz === undefined)
        || [event.frequencyHz, event.bandwidthHz].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
      : event.frequencyHz === undefined && event.bandwidthHz === undefined)
}

/** 仅提取已核对字段的事件；不读取存在表头错位的 WEAPON_TURNED_ON 姿态字段。 */
export function buildFileDeviceEvents(events: AfsimLogEvent[], platformIds: ReadonlySet<string>): FileDeviceEvent[] {
  const result: FileDeviceEvent[] = []
  for (const event of events) {
    const communication = ['COMM_TURNED_ON', 'COMM_TURNED_OFF'].includes(event.type)
    const jamming = ['JAMMING_REQUEST_INITIATED', 'JAMMING_REQUEST_UPDATED', 'JAMMING_REQUEST_CANCELED'].includes(event.type)
    const jammerOff = event.type === 'WEAPON_TURNED_OFF' && event.fields.system_type === 'WSF_RF_JAMMER'
    if (!communication && !jamming && !jammerOff) continue
    const requestText = event.fields['active_requests_(eM_Xmtrs)']
    const requests = requestText?.trim() ? Number(requestText) : NaN
    if (jamming && (!Number.isSafeInteger(requests) || requests < 0)) {
      throw new Error(`第 ${event.sourceLine} 行干扰请求数量无效。`)
    }
    const state: FileDeviceEvent = {
      sourceEventId: event.id, time: event.time, platformId: event.subject,
      deviceId: (communication ? event.fields.system ?? event.fields.Comm
        : jammerOff ? event.fields.system_platform : event.fields.weapon) ?? '',
      kind: communication ? 'COMMUNICATION' : 'JAMMING',
      active: communication ? event.type === 'COMM_TURNED_ON' : !jammerOff && requests > 0,
    }
    // 设备关闭事件没有频率和带宽，不继承旧请求参数伪装成该事件的测量值。
    if (jamming) {
      state.frequencyHz = event.fields.frequency?.trim() ? Number(event.fields.frequency) : NaN
      state.bandwidthHz = event.fields.bandwidth?.trim() ? Number(event.fields.bandwidth) : NaN
    }
    if (!isFileDeviceEvent(state, platformIds)) throw new Error(`第 ${event.sourceLine} 行设备事件身份或参数无效。`)
    result.push(state)
  }
  return result
}

/** 每次从证据重算，回退、重载和切换文件不会保留未来状态；同刻按源文件顺序处理。 */
export function selectFileDeviceStates(events: FileDeviceEvent[], time: number): FileDeviceEvent[] {
  const states = new Map<string, FileDeviceEvent>()
  for (const event of events) {
    if (event.time > time) continue
    const key = JSON.stringify([event.platformId, event.kind, event.deviceId])
    const previous = states.get(key)
    if (!previous || event.time >= previous.time) states.set(key, event)
  }
  return [...states.values()]
}

/**
 * 判断文件节点是否应显示干扰范围圈；以是否存在干扰请求记录为准，不再使用硬编码平台名单。
 * 半径由调用方按显示约定传入，不由距离、功率或频段推算。
 */
export function fileJammerRadiusMeters(platformId: string, events: readonly FileDeviceEvent[], radiusMeters: number): number | undefined {
  return events.some(event => event.kind === 'JAMMING' && event.platformId === platformId)
    ? radiusMeters : undefined
}

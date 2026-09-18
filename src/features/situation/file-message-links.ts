import type { AfsimLogEvent } from '../data-exchange/afsim-event-log'
import { FILE_COMMUNICATION_LABELS, fileCommunicationType, type FileCommunicationType } from './file-communication-links'

/**
 * 收发配对允许的最大时延。
 * 依据：GEO 单程光时为 35 786 km / 299 792.458 km·s⁻¹ ≈ 0.1194 s，真实数据卫星链路实测 0.1210–0.1220 s。
 * 取 0.15 s 既覆盖卫星一跳，又远小于消息间隔（真实数据约每秒 1 条），避免复用的消息序号跨轮次错配。
 */
export const MESSAGE_MAX_DELAY_S = 0.15

/** 消息链路端点；消息事件不提供地址，因此不接受也不补造地址字段。 */
export interface FileMessageEndpoint {
  platformName: string
  communicationName: string
}

const isNonEmptyText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** 校验一个消息链路端点；地址不由消息证据提供，因此不接受多余字段。 */
export function isFileMessageEndpoint(value: unknown, platformIds: ReadonlySet<string>): value is FileMessageEndpoint {
  if (!value || typeof value !== 'object') return false
  const endpoint = value as FileMessageEndpoint
  return isNonEmptyText(endpoint.platformName) && platformIds.has(endpoint.platformName)
    && isNonEmptyText(endpoint.communicationName)
}

/** 一条已被接收记录确认的投递；只陈述收发事实，不推断链路质量、丢包率或容量。 */
export interface FileMessageRecord {
  /** 接收事件的稳定标识，作为本条投递的身份。 */
  sourceEventId: string
  /** 对应发送事件的稳定标识；同一发送可被多个接收引用。 */
  transmitEventId: string
  /** 接收时刻，用于按回放游标截断。 */
  time: number
  source: FileMessageEndpoint
  target: FileMessageEndpoint
  messageType: string
  messageSizeBits: number
  /** 接收时刻减发送时刻；同一时间步内完成时为 0。 */
  delayS: number
}

/**
 * 一段连续活跃期。同一链路可以在整段仿真中多次中断与恢复，
 * 因此活跃状态是区间集合而不是单一的首末窗口。
 */
export interface FileMessageActiveInterval {
  startTimeS: number
  endTimeS: number
}

/** 有向业务链路：由消息收发证据推导，携带首末投递时刻与全部活跃区间。 */
export interface FileMessageLink {
  id: string
  type: FileCommunicationType
  sourcePlatformId: string
  targetPlatformId: string
  sourceDeviceId: string
  targetDeviceId: string
  records: FileMessageRecord[]
  firstTimeS: number
  lastTimeS: number
  /** 按投递间隔切分的连续活跃期；首个区间起点即 firstTimeS，末个区间终点即 lastTimeS。 */
  activeIntervals: FileMessageActiveInterval[]
  messageCount: number
  messageTypes: string[]
  /**
   * 业务方向：前向指指挥端向无人集群下发，返向指无人集群向指挥端回传。
   * 由承载的业务类型判定，与物理投递方向无关（卫星中继上两者恰好相反）。
   * 同一链路同时承载两类、或承载未识别类型时为空，界面不得推断。
   */
  direction?: FileMessageDirection
  /** 投递时延中位数（秒）；用中位数而非平均值，避免个别排队延迟拉偏结论。 */
  medianDelayS: number
}

/** 业务方向取值。 */
export type FileMessageDirection = 'FORWARD' | 'REVERSE'

/** 指令下发类业务类型；其余已识别类型均为回传类。 */
export const FORWARD_MESSAGE_TYPES: ReadonlySet<string> = new Set(['CMD_ORDER'])
/** 状态与侦察回传类业务类型。 */
export const REVERSE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'STATUS_REPORT', 'RECON_DATA', 'FORWARD_STATUS_REPORT', 'FORWARD_RECON_DATA',
])
export const FILE_MESSAGE_DIRECTION_LABELS: Record<FileMessageDirection, string> = {
  FORWARD: '前向', REVERSE: '返向',
}
/** 地图中点使用的单字标记；中文单字自带语义，因此不需要额外图例。 */
export const FILE_MESSAGE_DIRECTION_MARKS: Record<FileMessageDirection, string> = {
  FORWARD: '前', REVERSE: '返',
}

/**
 * 由承载的业务类型判定业务方向。
 * @param messageTypes 该链路出现过的业务类型。
 * @returns 只承载一类时返回对应方向；同时承载两类或都不属于已知类型时返回 undefined。
 * @remarks 两侧都为真或都为假都返回 undefined：前者是语义冲突，后者是无法识别，都不猜测。
 */
export function readFileMessageDirection(messageTypes: readonly string[]): FileMessageDirection | undefined {
  const forward = messageTypes.some((type) => FORWARD_MESSAGE_TYPES.has(type))
  const reverse = messageTypes.some((type) => REVERSE_MESSAGE_TYPES.has(type))
  if (forward === reverse) return undefined
  return forward ? 'FORWARD' : 'REVERSE'
}

/** 无法生成链路的接收条数；用于如实展示证据缺口，而不是静默丢弃。 */
export interface FileMessageLinkIssues {
  /** 找不到任何同序号、同类型且时延落在窗口内的发送记录。 */
  undelivered: number
  /** 候选发送分散在不同平台或设备上，无法确定唯一来源。 */
  ambiguous: number
  /** 收发任一端平台未登记，或设备类型无法归类，无法生成可信链路。 */
  unclassified: number
}

export interface FileMessageLinkResult {
  links: FileMessageLink[]
  issues: FileMessageLinkIssues
}

/** 设备索引键；与 afsim-log-reader 中构建 deviceTypes 的键保持一致。 */
export function fileMessageDeviceKey(platformName: string, communicationName: string): string {
  return JSON.stringify([platformName, communicationName])
}

interface TransmitEndpoint {
  eventId: string
  time: number
  platformName: string
  communicationName: string
  messageType: string
}

interface ReceiveEndpoint extends TransmitEndpoint {
  /** 消息序号；仅用于索引发送侧，不转换为数值。 */
  serial: string
  messageSizeBits: number
}

/** 读取通信设备类型；未登记时返回空串，由调用方判定为不可归类。 */
export function readFileMessageDeviceType(
  deviceTypes: ReadonlyMap<string, string>,
  platformName: string,
  communicationName: string,
): string {
  return deviceTypes.get(fileMessageDeviceKey(platformName, communicationName)) ?? ''
}

/** 按收发两端设备类型判定链路制式；任一端无法归类或两端不一致时返回 null。 */
export function fileMessageLinkType(
  deviceTypes: ReadonlyMap<string, string>,
  source: FileMessageEndpoint,
  target: FileMessageEndpoint,
): FileCommunicationType | null {
  const sourceType = fileCommunicationType(
    readFileMessageDeviceType(deviceTypes, source.platformName, source.communicationName),
    source.communicationName,
  )
  const targetType = fileCommunicationType(
    readFileMessageDeviceType(deviceTypes, target.platformName, target.communicationName),
    target.communicationName,
  )
  if (sourceType === null || targetType === null) return null
  return sourceType === targetType ? sourceType : null
}

/**
 * 判为断开所需的静默时长，取该链路自身投递节奏（相邻投递间隔中位数）的 10 倍，
 * 并设 30 秒下限以保护节奏极快的链路。
 * 倍数取值的依据来自真实数据：无中断链路的「最大间隔/中位间隔」≤ 5.4，
 * 有中断链路的 ≥ 77，两者相差 14 倍，因此 6–70 之间的任何倍数都会得到相同分段；取 10 留足余量。
 */
const OUTAGE_INTERVAL_MULTIPLE = 10
const MIN_OUTAGE_GAP_S = 30

/** 数值集合的中位数；偶数个取中间两个的平均值，空集合返回 0。 */
function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * 按投递间隔把一个链路的全部投递切成连续活跃期。
 * @param records 该链路已按时间排序或未排序的全部投递。
 * @returns 至少一段活跃期；只有单次投递时退化为一个零长区间。
 * @remarks 阈值由链路自身节奏推导，不使用跨链路统一的绝对秒数。
 * 单次投递的链路没有间隔可参考，只能退化为零长区间并在末次投递后立即消失。
 */
function buildActiveIntervals(records: readonly FileMessageRecord[]): FileMessageActiveInterval[] {
  const times = records.map((record) => record.time).sort((left, right) => left - right)
  if (times.length === 0) return []
  if (times.length === 1) return [{ startTimeS: times[0]!, endTimeS: times[0]! }]
  const gaps: number[] = []
  for (let index = 1; index < times.length; index += 1) gaps.push(times[index]! - times[index - 1]!)
  const outageGap = Math.max(medianOf(gaps) * OUTAGE_INTERVAL_MULTIPLE, MIN_OUTAGE_GAP_S)
  const intervals: FileMessageActiveInterval[] = []
  let start = times[0]!
  for (let index = 1; index < times.length; index += 1) {
    if (times[index]! - times[index - 1]! > outageGap) {
      intervals.push({ startTimeS: start, endTimeS: times[index - 1]! })
      start = times[index]!
    }
  }
  intervals.push({ startTimeS: start, endTimeS: times[times.length - 1]! })
  return intervals
}

/** 由投递记录重算链路的时刻范围、活跃区间、条数、业务类型、业务方向与中位时延。 */
function aggregate(id: string, type: FileCommunicationType, records: FileMessageRecord[]): FileMessageLink {
  const activeIntervals = buildActiveIntervals(records)
  const messageTypes = [...new Set(records.map((record) => record.messageType))].sort()
  return {
    id,
    type,
    sourcePlatformId: records[0]!.source.platformName,
    targetPlatformId: records[0]!.target.platformName,
    sourceDeviceId: records[0]!.source.communicationName,
    targetDeviceId: records[0]!.target.communicationName,
    records,
    firstTimeS: activeIntervals[0]!.startTimeS,
    lastTimeS: activeIntervals[activeIntervals.length - 1]!.endTimeS,
    activeIntervals,
    messageCount: records.length,
    messageTypes,
    direction: readFileMessageDirection(messageTypes),
    medianDelayS: medianOf(records.map((record) => record.delayS)),
  }
}

/**
 * 校验一条业务链路及其全部投递记录。
 * @param value 尚未校验的链路数据。
 * @param platformIds 已登记的节点集合；链路两端必须都在其中。
 * @remarks 聚合值必须与明细一致：条数等于记录数，时刻范围等于记录的最小与最大时刻。
 * 这样可以捕获被外部篡改或截断后未重算的链路，而不只是字段类型错误。
 */
export function isFileMessageLink(value: unknown, platformIds: ReadonlySet<string>): value is FileMessageLink {
  if (!value || typeof value !== 'object') return false
  const link = value as FileMessageLink
  if (!isNonEmptyText(link.id)) return false
  if (!Object.hasOwn(FILE_COMMUNICATION_LABELS, link.type)) return false
  if (!platformIds.has(link.sourcePlatformId) || !platformIds.has(link.targetPlatformId)) return false
  if (link.sourcePlatformId === link.targetPlatformId) return false
  if (!isNonEmptyText(link.sourceDeviceId) || !isNonEmptyText(link.targetDeviceId)) return false
  if (![link.firstTimeS, link.lastTimeS, link.medianDelayS].every(Number.isFinite)) return false
  if (link.firstTimeS < 0 || link.lastTimeS < link.firstTimeS || link.medianDelayS < 0) return false
  if (!Array.isArray(link.activeIntervals) || link.activeIntervals.length === 0) return false
  let previousEnd = -Infinity
  for (const interval of link.activeIntervals) {
    if (!interval || typeof interval !== 'object') return false
    if (!Number.isFinite(interval.startTimeS) || !Number.isFinite(interval.endTimeS)) return false
    if (interval.startTimeS < 0 || interval.endTimeS < interval.startTimeS) return false
    // 区间必须严格递增且互不重叠，否则同一时刻的活跃判定会出现二义。
    if (interval.startTimeS <= previousEnd) return false
    previousEnd = interval.endTimeS
  }
  // 首末时刻是活跃区间的汇总投影，必须与区间集合一致。
  if (link.activeIntervals[0]!.startTimeS !== link.firstTimeS) return false
  if (link.activeIntervals[link.activeIntervals.length - 1]!.endTimeS !== link.lastTimeS) return false
  if (!Array.isArray(link.messageTypes) || link.messageTypes.length === 0) return false
  if (!link.messageTypes.every(isNonEmptyText) || new Set(link.messageTypes).size !== link.messageTypes.length) return false
  // 业务方向必须与承载的业务类型自洽，否则界面会展示与证据矛盾的方向。
  if (link.direction !== readFileMessageDirection(link.messageTypes)) return false
  if (!Array.isArray(link.records) || link.records.length === 0) return false
  if (link.messageCount !== link.records.length) return false
  if (new Set(link.records.map((record) => record.sourceEventId)).size !== link.records.length) return false
  let firstTime = Infinity
  let lastTime = -Infinity
  for (const record of link.records) {
    if (!record || typeof record !== 'object') return false
    if (!isNonEmptyText(record.sourceEventId) || !isNonEmptyText(record.transmitEventId)) return false
    if (!Number.isFinite(record.time) || record.time < 0 || !Number.isFinite(record.delayS) || record.delayS < 0) return false
    if (!isNonEmptyText(record.messageType)) return false
    if (!Number.isSafeInteger(record.messageSizeBits) || record.messageSizeBits < 0) return false
    if (!isFileMessageEndpoint(record.source, platformIds) || !isFileMessageEndpoint(record.target, platformIds)) return false
    if (record.source.platformName !== link.sourcePlatformId || record.target.platformName !== link.targetPlatformId) return false
    if (record.source.communicationName !== link.sourceDeviceId || record.target.communicationName !== link.targetDeviceId) return false
    if (!link.messageTypes.includes(record.messageType)) return false
    firstTime = Math.min(firstTime, record.time)
    lastTime = Math.max(lastTime, record.time)
  }
  return firstTime === link.firstTimeS && lastTime === link.lastTimeS
}

/**
 * 按消息序号配对收发记录，推导真实业务链路。
 * @param events 已解析的事件日志事件；只读取 MESSAGE_TRANSMITTED 与 MESSAGE_RECEIVED。
 * @param platformIds 允许出现在链路中的平台集合；不在其中的记录计入 unclassified。
 * @param deviceTypes 通信设备类型索引，键为 fileMessageDeviceKey 的返回值，用于判定链路制式。
 * @returns 有向业务链路以及三类无法配对的接收条数。
 * @remarks 发送事件不携带接收方，因此来源由「候选发送的平台与设备集合是否唯一」决定：
 * 候选落在同一平台同一设备时来源唯一（同一消息发往多个接收方会产生多条同刻同序号发送记录）；
 * 候选分散在不同平台或设备时计入 ambiguous 且不生成链路，绝不猜测来源。
 */
export function buildFileMessageLinks(
  events: readonly AfsimLogEvent[],
  platformIds: ReadonlySet<string>,
  deviceTypes: ReadonlyMap<string, string>,
): FileMessageLinkResult {
  const transmits = new Map<string, TransmitEndpoint[]>()
  const receives: ReceiveEndpoint[] = []

  for (const event of events) {
    // 解析失败的事件保留原文但不参与配对，避免把无效记录当成证据。
    if (event.unparsedText || !event.type.startsWith('MESSAGE_')) continue
    if (event.type !== 'MESSAGE_TRANSMITTED' && event.type !== 'MESSAGE_RECEIVED') continue
    const platformName = event.subject.trim()
    const communicationName = (event.fields.comm ?? '').trim()
    const serial = (event.fields.message_serial_number ?? '').trim()
    const messageType = (event.fields.message_type ?? '').trim()
    if (!platformName || !communicationName || !serial || !messageType) continue
    const endpoint: TransmitEndpoint = {
      eventId: event.id, time: event.time, platformName, communicationName, messageType,
    }
    if (event.type === 'MESSAGE_TRANSMITTED') {
      const bucket = transmits.get(serial)
      if (bucket) bucket.push(endpoint)
      else transmits.set(serial, [endpoint])
      continue
    }
    // 解析阶段已校验 message_size 为纯数字字符串。
    const messageSizeBits = Number(event.fields.message_size)
    if (!Number.isFinite(messageSizeBits)) continue
    receives.push({ ...endpoint, serial, messageSizeBits })
  }
  for (const bucket of transmits.values()) bucket.sort((left, right) => left.time - right.time)

  const issues: FileMessageLinkIssues = { undelivered: 0, ambiguous: 0, unclassified: 0 }
  const grouped = new Map<string, { type: FileCommunicationType; records: FileMessageRecord[] }>()

  for (const receive of [...receives].sort((left, right) => left.time - right.time)) {
    const candidates = (transmits.get(receive.serial) ?? []).filter((candidate) => (
      candidate.messageType === receive.messageType
      && candidate.time <= receive.time
      && receive.time - candidate.time <= MESSAGE_MAX_DELAY_S
    ))
    if (candidates.length === 0) { issues.undelivered += 1; continue }

    // 候选设备集合唯一才认定来源；分散时如实记为无法确定。
    const sources = new Set(candidates.map((candidate) => (
      fileMessageDeviceKey(candidate.platformName, candidate.communicationName)
    )))
    if (sources.size > 1) { issues.ambiguous += 1; continue }
    const transmit = candidates[candidates.length - 1]!

    if (!platformIds.has(transmit.platformName) || !platformIds.has(receive.platformName)) {
      issues.unclassified += 1
      continue
    }
    const source: FileMessageEndpoint = { platformName: transmit.platformName, communicationName: transmit.communicationName }
    const target: FileMessageEndpoint = { platformName: receive.platformName, communicationName: receive.communicationName }
    const type = fileMessageLinkType(deviceTypes, source, target)
    if (type === null) { issues.unclassified += 1; continue }

    const id = JSON.stringify([type, source.platformName, source.communicationName,
      target.platformName, target.communicationName])
    const record: FileMessageRecord = {
      sourceEventId: receive.eventId, transmitEventId: transmit.eventId, time: receive.time,
      source, target, messageType: receive.messageType, messageSizeBits: receive.messageSizeBits,
      delayS: receive.time - transmit.time,
    }
    const entry = grouped.get(id)
    if (entry) entry.records.push(record)
    else grouped.set(id, { type, records: [record] })
  }

  return {
    links: [...grouped].map(([id, entry]) => aggregate(id, entry.type, entry.records)),
    issues,
  }
}

/**
 * 取回放游标当前时刻仍然活跃的业务链路，并重算聚合值。
 * @param links 全量业务链路，携带各自完整的活跃区间。
 * @param time 回放游标秒数。
 * @returns 活跃区间覆盖当前游标的链路；明细只含已发生的投递，不泄露未来数据。
 * @remarks 判定使用链路自身的完整活跃区间，因此链路会在中断后消失、恢复后重新出现，
 * 而不是只按首末投递时刻画成一条跨越中断的连线。
 */
export function selectFileMessageLinks(links: readonly FileMessageLink[], time: number): FileMessageLink[] {
  const visible: FileMessageLink[] = []
  for (const link of links) {
    if (!link.activeIntervals.some((interval) => interval.startTimeS <= time && time <= interval.endTimeS)) continue
    const records = link.records.filter((record) => record.time <= time)
    if (records.length) visible.push(aggregate(link.id, link.type, records))
  }
  return visible
}

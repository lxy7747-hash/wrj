import { FILE_COMMUNICATION_LABELS, type FileCommunicationType } from './file-communication-links'
import {
  isFileMessageEndpoint,
  type FileMessageDirection,
  type FileMessageEndpoint,
  type FileMessageLinkIssues,
  type FileMessageRecord,
} from './file-message-links'

/** 场景仿真实时读取到的单条已确认收发投递事实。 */
export interface MissionMessageDelivery {
  sequence: number
  sourceEventId: string
  transmitEventId: string
  type: FileCommunicationType
  /** 接收端仿真时刻（秒）。 */
  time: number
  /** 收发时延（秒）：接收时刻减发送时刻。 */
  delayS: number
  source: FileMessageEndpoint
  target: FileMessageEndpoint
  messageType: string
  messageSizeBits: number
  /** 按单条消息类型判定的业务方向；未登记类型时为空，由界面展示「业务方向未识别」。 */
  direction?: FileMessageDirection
}

/** 仅有发送记录、超出配对窗口仍无接收确认的报文事实。 */
export interface MissionUnconfirmedTransmit {
  eventId: string
  transmitTime: number
  platformName: string
  communicationName: string
  messageType: string
  direction?: FileMessageDirection
  /** 由真实 COMM_TURNED_ON 记录解析的设备制式（仅用于关联配置链路详情，未知时不猜测）。 */
  linkType?: FileCommunicationType
}

/** 本次场景仿真运行增量消息接口返回体；仅暴露真实日志读取与配对结果。 */
export interface MissionMessageSnapshot {
  runId: string
  scenarioId: string
  revision: number
  generation: number
  cursor: number
  hasMore: boolean
  /** 运行输出中的 scenario_events.csv 是否已出现。 */
  sourceAvailable: boolean
  latestSimTime: number | null
  /** 存在尚未换行的尾部不完整记录。 */
  waitingForLine: boolean
  /** 所有已读日志行均解析正常且未触发安全截断/替换故障时为 true。 */
  messageDetailsComplete: boolean
  issueCount: number
  issues: FileMessageLinkIssues
  totalTransmits: number
  totalReceives: number
  totalPaired: number
  unconfirmedCount: number
  deliveries: MissionMessageDelivery[]
  unconfirmedTransmits: MissionUnconfirmedTransmit[]
}

const isNonEmptyText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const isValidDirection = (value: unknown): value is FileMessageDirection | undefined => (
  value === undefined || value === 'FORWARD' || value === 'REVERSE'
)

export function isMissionMessageDelivery(value: unknown, platformIds?: ReadonlySet<string>): value is MissionMessageDelivery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as MissionMessageDelivery
  const validEndpoint = (endpoint: unknown) => {
    if (platformIds) return isFileMessageEndpoint(endpoint, platformIds)
    if (!endpoint || typeof endpoint !== 'object') return false
    const raw = endpoint as FileMessageEndpoint
    return isNonEmptyText(raw.platformName) && isNonEmptyText(raw.communicationName)
  }
  return Number.isSafeInteger(item.sequence) && item.sequence > 0
    && isNonEmptyText(item.sourceEventId)
    && isNonEmptyText(item.transmitEventId)
    && Object.prototype.hasOwnProperty.call(FILE_COMMUNICATION_LABELS, item.type)
    && typeof item.time === 'number' && Number.isFinite(item.time) && item.time >= 0
    && typeof item.delayS === 'number' && Number.isFinite(item.delayS) && item.delayS >= 0
    && validEndpoint(item.source)
    && validEndpoint(item.target)
    && item.source.platformName !== item.target.platformName
    && isNonEmptyText(item.messageType)
    && Number.isSafeInteger(item.messageSizeBits) && item.messageSizeBits >= 0
    && isValidDirection(item.direction)
}

export function isMissionUnconfirmedTransmit(value: unknown): value is MissionUnconfirmedTransmit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as MissionUnconfirmedTransmit
  return isNonEmptyText(item.eventId)
    && typeof item.transmitTime === 'number' && Number.isFinite(item.transmitTime) && item.transmitTime >= 0
    && isNonEmptyText(item.platformName)
    && isNonEmptyText(item.communicationName)
    && isNonEmptyText(item.messageType)
    && isValidDirection(item.direction)
    && (item.linkType === undefined || Object.prototype.hasOwnProperty.call(FILE_COMMUNICATION_LABELS, item.linkType))
}

export function isMissionMessageSnapshot(value: unknown): value is MissionMessageSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as MissionMessageSnapshot
  if (typeof snapshot.runId !== 'string' || !snapshot.runId.startsWith('RUN-')) return false
  if (typeof snapshot.scenarioId !== 'string' || !snapshot.scenarioId.startsWith('SCN-')) return false
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision <= 0) return false
  if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0) return false
  if (!Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < 0) return false
  if (typeof snapshot.hasMore !== 'boolean' || typeof snapshot.sourceAvailable !== 'boolean') return false
  if (snapshot.latestSimTime !== null && (typeof snapshot.latestSimTime !== 'number' || !Number.isFinite(snapshot.latestSimTime) || snapshot.latestSimTime < 0)) return false
  if (typeof snapshot.waitingForLine !== 'boolean' || typeof snapshot.messageDetailsComplete !== 'boolean') return false
  if (!Number.isSafeInteger(snapshot.issueCount) || snapshot.issueCount < 0) return false
  if (!snapshot.issues || typeof snapshot.issues !== 'object') return false
  const { undelivered, ambiguous, unclassified } = snapshot.issues
  if (!Number.isSafeInteger(undelivered) || undelivered < 0
    || !Number.isSafeInteger(ambiguous) || ambiguous < 0
    || !Number.isSafeInteger(unclassified) || unclassified < 0) return false
  if (!Number.isSafeInteger(snapshot.totalTransmits) || snapshot.totalTransmits < 0
    || !Number.isSafeInteger(snapshot.totalReceives) || snapshot.totalReceives < 0
    || !Number.isSafeInteger(snapshot.totalPaired) || snapshot.totalPaired < 0
    || !Number.isSafeInteger(snapshot.unconfirmedCount) || snapshot.unconfirmedCount < 0) return false
  if (!Array.isArray(snapshot.deliveries) || !snapshot.deliveries.every(item => isMissionMessageDelivery(item))) return false
  if (!Array.isArray(snapshot.unconfirmedTransmits) || !snapshot.unconfirmedTransmits.every(isMissionUnconfirmedTransmit)) return false
  return true
}

/** 将实时消息投递投影为既有的 FileMessageRecord 结构，便于详情弹框复用。 */
export function toFileMessageRecord(delivery: MissionMessageDelivery): FileMessageRecord {
  return {
    sourceEventId: delivery.sourceEventId,
    transmitEventId: delivery.transmitEventId,
    time: delivery.time,
    source: delivery.source,
    target: delivery.target,
    messageType: delivery.messageType,
    messageSizeBits: delivery.messageSizeBits,
    delayS: delivery.delayS,
  }
}

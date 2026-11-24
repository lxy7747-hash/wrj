import { isFileCommunicationConnection, type FileCommunicationConnection } from './file-communication-links'
import { isFileDeviceEvent, type FileDeviceEvent } from './file-device-events'
import { isFileMessageLink, type FileMessageLink } from './file-message-links'
import { isFilePlatformDeletion, type FilePlatformDeletion } from './platform-lifecycle'
import type { Faction, PlatformType } from '../../contracts/domain-models'

/** 干扰类平台在旧场景里按类型推断为红方；其余平台推断为蓝方，与生成器既有 side 推断一致。 */
const RED_FACTION_PLATFORM_TYPES: readonly PlatformType[] = ['GROUND_JAMMER_DETECTION_STATION', 'AIRBORNE_JAMMER_PLATFORM']

/**
 * 计算场景平台在地图上的阵营 side（小写 red/blue，供 situation-map-controller 消费）。
 * 显式 faction 优先；缺失时按平台类型推断（干扰类红、其余蓝），与脚本 side 推断保持一致。
 * 显式中立或无法判定时返回 undefined，地图保持默认色且不标注阵营，不臆造。
 */
export function platformMapSide(platform: { type?: PlatformType | string; faction?: Faction | string }): string | undefined {
  if (platform.faction === 'BLUE') return 'blue'
  if (platform.faction === 'RED') return 'red'
  if (platform.faction === 'NEUTRAL') return undefined
  if (typeof platform.type === 'string' && (RED_FACTION_PLATFORM_TYPES as readonly string[]).includes(platform.type)) return 'red'
  if (typeof platform.type === 'string') return 'blue'
  return undefined
}

/** 地图只需要位置与标识，不要求日志提供链路质量或干扰状态。 */
export interface SituationMapNode {
  platformId: string
  name: string
  type: string
  /** 场景自定义编号的卫星保留子类型，地图不从名称猜测天通/神通。 */
  satelliteType?: 'TIANTONG' | 'SHENTONG'
  /** 阵营标识，取自事件日志的 side 字段；Mock 与场景配置没有该信息时省略，界面不得臆造。 */
  side?: string
  longitude: number
  latitude: number
  altitude: number
  speed: number
  /** 位置记录的航向，单位为度，自北顺时针。 */
  heading?: number
  /** 来源位置的仿真时刻；静态场景配置不提供该值。 */
  time?: number
  positionSource?: 'ENGINE'
}

export interface InitialNodeSnapshot {
  fileName: string
  sha256: string
  nodes: Array<SituationMapNode & { time: number; sourceEventId: string }>
  connections?: FileCommunicationConnection[]
  deviceEvents?: FileDeviceEvent[]
  /** 由消息收发证据推导的业务链路；与仅表示登记关联的 connections 语义不同。 */
  messageLinks?: FileMessageLink[]
  /** 大型事件 CSV 仅在此标记下省略逐消息链路动画；计数仍在报告来源中完整保留。 */
  messageDetailsComplete?: boolean
  messageDetailEventCount?: number
  /** 平台退出时刻；用于回放游标到达后移除节点。 */
  platformDeletions?: FilePlatformDeletion[]
}

/**
 * 校验初始节点接口响应；不为缺失坐标、类型或速度补默认值。
 * @param value 尚未校验的接口数据；null 表示本机没有配置真实日志。
 */
export function isInitialNodeSnapshot(value: unknown): value is InitialNodeSnapshot | null {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const snapshot = value as InitialNodeSnapshot
  if (typeof snapshot.fileName !== 'string' || snapshot.fileName.trim().length === 0
    || typeof snapshot.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sha256)
    || !Array.isArray(snapshot.nodes) || snapshot.nodes.length === 0
    || (snapshot.messageDetailsComplete !== undefined && typeof snapshot.messageDetailsComplete !== 'boolean')
    || (snapshot.messageDetailEventCount !== undefined && (!Number.isSafeInteger(snapshot.messageDetailEventCount) || snapshot.messageDetailEventCount < 0))
    || (snapshot.messageDetailsComplete === false && snapshot.messageDetailEventCount === undefined)) return false
  const ids = new Set<string>()
  const validNodes = snapshot.nodes.every((node) => {
    if (!node || typeof node !== 'object') return false
    if (![node.platformId, node.name, node.type, node.sourceEventId].every(
      (text) => typeof text === 'string' && text.trim().length > 0,
    ) || ids.has(node.platformId)) return false
    ids.add(node.platformId)
    // 阵营可以为空（Mock 与场景配置没有该信息），但一旦给出就必须是非空文本。
    if (node.side !== undefined && (typeof node.side !== 'string' || node.side.trim().length === 0)) return false
    return [node.longitude, node.latitude, node.altitude, node.speed, node.time].every(Number.isFinite)
      && Math.abs(node.longitude) <= 180 && Math.abs(node.latitude) <= 90
      && node.speed >= 0 && node.time >= 0
  })
  return validNodes && (snapshot.connections === undefined || (Array.isArray(snapshot.connections)
    && snapshot.connections.every(record => isFileCommunicationConnection(record, ids))
    && new Set(snapshot.connections.map(record => record.sourceEventId)).size === snapshot.connections.length))
    && (snapshot.deviceEvents === undefined || (Array.isArray(snapshot.deviceEvents)
      && snapshot.deviceEvents.every(event => isFileDeviceEvent(event, ids))
      && new Set(snapshot.deviceEvents.map(event => event.sourceEventId)).size === snapshot.deviceEvents.length))
    && (snapshot.messageLinks === undefined || (Array.isArray(snapshot.messageLinks)
      && snapshot.messageLinks.every(link => isFileMessageLink(link, ids))
      && new Set(snapshot.messageLinks.map(link => link.id)).size === snapshot.messageLinks.length))
    && (snapshot.platformDeletions === undefined || (Array.isArray(snapshot.platformDeletions)
      && snapshot.platformDeletions.every(deletion => isFilePlatformDeletion(deletion, ids))
      && new Set(snapshot.platformDeletions.map(deletion => deletion.platformId)).size === snapshot.platformDeletions.length))
}

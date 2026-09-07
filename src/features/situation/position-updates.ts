import type { InitialNodeSnapshot, SituationMapNode } from './initial-nodes'
import { parseCsvLine } from '../data-exchange/csv-contract'

export const POSITION_HEADER = 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING'

/**
 * 解析并校验一条位置 CSV，供实时追加和历史回放共用。
 * @param line 去除行末换行的完整 CSV 记录；无效时返回 null。
 */
export function parsePositionLine(line: string): PositionUpdate | null {
  const cells = parseCsvLine(line)?.map((cell) => cell.trim())
  if (cells?.length !== 7 || cells.some((cell) => cell === '')) return null
  const update = {
    time: Number(cells[0]), platformId: cells[1]!, longitude: Number(cells[2]), latitude: Number(cells[3]),
    altitude: Number(cells[4]), speed: Number(cells[5]), heading: Number(cells[6]),
  }
  return isPositionUpdate(update) ? update : null
}

/**
 * 判断新增记录是否会造成节点时间倒退或同刻冲突；重复的相同记录允许读取。
 * @param previous 该节点上次接受的记录；undefined 表示首次出现。
 * @param update 本次已通过字段校验的记录。
 */
export function positionOrderIssue(previous: PositionUpdate | undefined, update: PositionUpdate): string {
  if (previous && update.time < previous.time) return '节点时间倒退，已跳过。'
  if (previous && update.time === previous.time && JSON.stringify(update) !== JSON.stringify(previous)) {
    return '同一节点同一时刻的数据冲突，已跳过。'
  }
  return ''
}

/** AFSIM 位置文件的一条完整记录；坐标为十进制度，时间为秒。 */
export interface PositionUpdate {
  platformId: string
  time: number
  longitude: number
  latitude: number
  altitude: number
  speed: number
  heading: number
}

/** 返回各节点的最新位置，便于刷新页面或重新连接后恢复；不返回全部历史。 */
export interface PositionSnapshot {
  fileName: string
  generation: number
  nodes: PositionUpdate[]
  recordCount: number
  issueCount: number
  issues: Array<{ line: number; message: string }>
  waitingForLine: boolean
  hasMore: boolean
}

/**
 * 校验一条位置记录；允许负航向及接近零的负高度，不改变原始数值。
 * @param value 尚未校验的记录对象。
 */
export function isPositionUpdate(value: unknown): value is PositionUpdate {
  if (!value || typeof value !== 'object') return false
  const node = value as PositionUpdate
  return typeof node.platformId === 'string' && node.platformId.trim().length > 0
    && [node.time, node.longitude, node.latitude, node.altitude, node.speed, node.heading].every(Number.isFinite)
    && node.time >= 0 && node.speed >= 0 && Math.abs(node.longitude) <= 180 && Math.abs(node.latitude) <= 90
}

/**
 * 校验本机追加位置响应；null 表示未配置位置文件。
 * @param value 接口返回的原始数据，包含最新节点和异常行信息。
 */
export function isPositionSnapshot(value: unknown): value is PositionSnapshot | null {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const snapshot = value as PositionSnapshot
  if (typeof snapshot.fileName !== 'string' || snapshot.fileName.trim() === ''
    || ![snapshot.generation, snapshot.recordCount, snapshot.issueCount].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    ) || typeof snapshot.waitingForLine !== 'boolean' || typeof snapshot.hasMore !== 'boolean'
    || !Array.isArray(snapshot.nodes) || !snapshot.nodes.every(isPositionUpdate)
    || new Set(snapshot.nodes.map((node) => node.platformId)).size !== snapshot.nodes.length
    || !Array.isArray(snapshot.issues) || snapshot.issues.length > snapshot.issueCount) return false
  return snapshot.issues.every((issue) => issue && Number.isSafeInteger(issue.line) && issue.line > 0
    && typeof issue.message === 'string')
}

/**
 * 将本轮最新位置合并到初始化节点；重建自初始化基线，防止文件换代后遗留旧位置。
 * @param initial 第一个文件中的节点，决定身份、类型和缺失更新时的位置。
 * @param snapshot 第二个文件当前轮次的累计最新位置；未知节点不自动创建。
 */
export function mergePositionNodes(initial: InitialNodeSnapshot, snapshot: PositionSnapshot | null): SituationMapNode[] {
  const updates = new Map(snapshot?.nodes.map((node) => [node.platformId, node]))
  return initial.nodes.map((node) => {
    const update = updates.get(node.platformId)
    return update && update.time >= node.time ? { ...node, ...update } : node
  })
}

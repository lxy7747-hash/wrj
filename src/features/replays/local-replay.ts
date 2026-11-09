import { isInitialNodeSnapshot, type InitialNodeSnapshot, type SituationMapNode } from '../situation/initial-nodes'
import { isPlatformPresentAt } from '../situation/platform-lifecycle'
import { isPositionUpdate, type PositionUpdate } from '../situation/position-updates'

/** 本机文件的只读回放快照，与 Mock 遥测帧和引擎运行编号分离。 */
export interface LocalReplaySnapshot {
  initial: InitialNodeSnapshot
  fileName: string
  sha256: string
  durationS: number
  recordCount: number
  tracks: Array<{ platformId: string; positions: PositionUpdate[] }>
  issueCount: number
  issues: Array<{ line: number; message: string }>
  waitingForLine: boolean
  /** false 表示大型来源的消息分类统计完整，但逐消息动画未装入该回放快照。 */
  messageDetailsComplete?: boolean
  messageDetailEventCount?: number
}

/**
 * 校验回放快照的节点引用和严格递增轨迹，防止错误响应进入时间定位。
 * @param value 未校验的接口响应；null 表示未配置真实文件。
 */
export function isLocalReplaySnapshot(value: unknown): value is LocalReplaySnapshot | null {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const snapshot = value as LocalReplaySnapshot
  if (!snapshot.initial || !isInitialNodeSnapshot(snapshot.initial)
    || typeof snapshot.fileName !== 'string' || !snapshot.fileName.trim()
    || typeof snapshot.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sha256)
    || !Number.isFinite(snapshot.durationS) || snapshot.durationS < 0
    || ![snapshot.recordCount, snapshot.issueCount].every((n) => Number.isSafeInteger(n) && n >= 0)
    || (snapshot.messageDetailsComplete !== undefined && typeof snapshot.messageDetailsComplete !== 'boolean')
    || (snapshot.messageDetailEventCount !== undefined && (!Number.isSafeInteger(snapshot.messageDetailEventCount) || snapshot.messageDetailEventCount < 0))
    || (snapshot.messageDetailsComplete === false && snapshot.messageDetailEventCount === undefined)
    || typeof snapshot.waitingForLine !== 'boolean' || !Array.isArray(snapshot.tracks)
    || !Array.isArray(snapshot.issues) || snapshot.issues.length > snapshot.issueCount
    || !snapshot.issues.every((issue) => issue && Number.isSafeInteger(issue.line) && issue.line > 0 && typeof issue.message === 'string')) return false
  const initialById = new Map(snapshot.initial.nodes.map((node) => [node.platformId, node]))
  const ids = new Set<string>()
  let count = 0
  let duration = Math.max(0, ...snapshot.initial.nodes.map((node) => node.time), ...(snapshot.initial.connections?.map((record) => record.time) ?? []),
    ...(snapshot.initial.deviceEvents?.map(event => event.time) ?? []),
    // 平台删除时刻必须计入总时长，否则回放游标永远到不了删除时刻，节点也就永远不会移除。
    ...(snapshot.initial.platformDeletions?.map(deletion => deletion.time) ?? []))
  for (const track of snapshot.tracks) {
    if (!track || typeof track !== 'object') return false
    const node = initialById.get(track.platformId)
    if (!node || ids.has(track.platformId) || !Array.isArray(track.positions) || track.positions.length === 0) return false
    ids.add(track.platformId)
    let previousTime = -1
    for (const position of track.positions) {
      if (!isPositionUpdate(position) || position.platformId !== track.platformId
        || position.time < node.time || position.time <= previousTime) return false
      previousTime = position.time
      duration = Math.max(duration, position.time)
      count += 1
    }
  }
  return count === snapshot.recordCount && duration === snapshot.durationS
}

/**
 * 二分查找所选时刻的位置；默认返回原始记录，可选在相邻轨迹点之间做展示插值。
 * @param snapshot 本次加载的只读历史快照。
 * @param seconds 回放游标秒数。
 * @param interpolate 态势连续播放可选的展示插值；默认仍返回原始记录，不修改快照或归档。
 * @remarks 平台删除时刻不晚于游标时，该节点从结果中移除；没有删除记录时行为与旧版本一致。
 */
export function selectReplayNodes(snapshot: LocalReplaySnapshot, seconds: number, interpolate = false): SituationMapNode[] {
  const tracks = new Map(snapshot.tracks.map((track) => [track.platformId, track.positions]))
  const deletions = snapshot.initial.platformDeletions ?? []
  return snapshot.initial.nodes
    .filter((node) => node.time <= seconds && isPlatformPresentAt(deletions, node.platformId, seconds))
    .map((node) => {
    const positions = tracks.get(node.platformId) ?? []
    let low = 0
    let high = positions.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (positions[middle]!.time <= seconds) low = middle + 1
      else high = middle
    }
    const latest = positions[low - 1]
    const current = latest ? { ...node, ...latest } : node
    const next = positions[low]
    if (!interpolate || !next || seconds <= current.time || next.time <= current.time) return current
    const ratio = (seconds - current.time) / (next.time - current.time)
    const longitudeDelta = ((next.longitude - current.longitude + 540) % 360) - 180
    return { ...current, time: seconds,
      longitude: ((current.longitude + longitudeDelta * ratio + 540) % 360) - 180,
      latitude: current.latitude + (next.latitude - current.latitude) * ratio,
      altitude: current.altitude + (next.altitude - current.altitude) * ratio,
      speed: current.speed + (next.speed - current.speed) * ratio,
    }
  })
}

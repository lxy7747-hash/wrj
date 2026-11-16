import type { SituationMapNode } from './initial-nodes'
import type { LocalReplaySnapshot } from '../replays/local-replay'

export type TrailPoint = { longitude: number; latitude: number; time: number }
export type NodeTrail = { platformId: string; points: TrailPoint[] }
const validPoint = (point: TrailPoint) => Number.isFinite(point.time) && point.time >= 0
  && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180
  && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90
const moved = (a: TrailPoint, b: TrailPoint) => a.longitude !== b.longitude || a.latitude !== b.latitude

/** 实时位置仅累积已收到的点；换运行、重置或位置时间倒退时不连接旧轨迹。 */
export function createNodeTrailTracker() {
  let sourceKey: string | undefined
  const tracks = new Map<string, { last: TrailPoint; points: TrailPoint[]; source?: 'ENGINE' }>()
  return (key: string, nodes: readonly SituationMapNode[], time?: number): NodeTrail[] => {
    if (key !== sourceKey) { tracks.clear(); sourceKey = key }
    const ids = new Set(nodes.map(node => node.platformId))
    for (const id of tracks.keys()) if (!ids.has(id)) tracks.delete(id)
    for (const node of nodes) {
      const point = { longitude: node.longitude, latitude: node.latitude, time: node.time ?? time ?? NaN }
      if (!validPoint(point)) continue
      const previous = tracks.get(node.platformId)
      if (!previous || point.time < previous.last.time || previous.source !== node.positionSource) {
        tracks.set(node.platformId, { last: point, points: [point], source: node.positionSource })
      } else if (point.time > previous.last.time) {
        if (moved(previous.last, point)) previous.points.push(point)
        previous.last = point
      }
    }
    return [...tracks].filter(([, track]) => track.points.length > 1)
      .map(([platformId, track]) => ({ platformId, points: [...track.points] }))
  }
}

/** 文件回放从原始位置序列按游标截取，跳转不会连接跨越的未来区间。 */
export function replayNodeTrails(snapshot: LocalReplaySnapshot, time: number, nodes: readonly SituationMapNode[]): NodeTrail[] {
  const visible = new Set(nodes.map(node => node.platformId))
  return snapshot.tracks.filter(track => visible.has(track.platformId)).flatMap(track => {
    const initial = snapshot.initial.nodes.find(node => node.platformId === track.platformId)
    const points: TrailPoint[] = []
    for (const point of [...(initial ? [initial] : []), ...track.positions]) {
      if (point.time > time) break
      if (!validPoint(point)) continue
      if (points.at(-1)?.time === point.time) points[points.length - 1] = point
      else if (!points.length || moved(points.at(-1)!, point)) points.push(point)
    }
    return points.length > 1 ? [{ platformId: track.platformId, points }] : []
  })
}

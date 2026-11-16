import { isPositionSnapshot, type PositionSnapshot, type PositionUpdate } from './position-updates'

/** 本次 mission 运行写出的最新位置，不接受浏览器提供文件路径。 */
export interface MissionPositionSnapshot {
  runId: string
  scenarioId: string
  revision: number
  positions: PositionSnapshot | null
}

/** 校验 mission 位置接口的闭合响应；null 表示本次输出文件尚未写入。 */
export function isMissionPositionSnapshot(value: unknown): value is MissionPositionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as MissionPositionSnapshot
  return Object.keys(snapshot).length === 4
    && typeof snapshot.runId === 'string' && snapshot.runId.startsWith('RUN-')
    && typeof snapshot.scenarioId === 'string' && snapshot.scenarioId.startsWith('SCN-')
    && Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0
    && isPositionSnapshot(snapshot.positions)
}

/** 仅缓存展示用位置；按链路帧时刻选原始记录，不改写源时间或外推坐标。 */
export function createMissionPositionTimeline() {
  let generation: number | undefined
  const tracks = new Map<string, PositionUpdate[]>()
  return {
    accept(snapshot: PositionSnapshot | null): void {
      if (snapshot?.generation !== generation) { tracks.clear(); generation = snapshot?.generation }
      for (const node of snapshot?.nodes ?? []) {
        const history = tracks.get(node.platformId) ?? []
        if (!history.length || node.time > history.at(-1)!.time) history.push({ ...node })
        // 与引擎展示缓存一致只留最近 200 条；超出窗口时不拿未来坐标冒充历史位置。
        if (history.length > 200) history.shift()
        tracks.set(node.platformId, history)
      }
    },
    times(): number[] {
      const histories = [...tracks.values()]
      return (histories[0] ?? []).map(node => node.time).filter(time => histories.every(history => history.some(node => Math.abs(node.time - time) < 1e-6)))
    },
    at(time: number): PositionUpdate[] {
      return [...tracks.values()].flatMap(history => {
        for (let index = history.length - 1; index >= 0; index--) {
          if (history[index]!.time <= time + 1e-6) return [history[index]!]
        }
        return []
      })
    },
  }
}

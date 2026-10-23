import { isPositionSnapshot, type PositionSnapshot } from './position-updates'

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

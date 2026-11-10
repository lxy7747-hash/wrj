import type { EngineFrameSnapshot, Link } from '../../contracts/domain-models'
import { isEngineFrameSnapshot } from '../data-exchange/engine-frame-snapshot'

type FrameItem<T> = { frameId: number; simulationTime: number } & T
export interface EngineReplayEvidence {
  engineFrame: EngineFrameSnapshot | null
  engineEvents: FrameItem<{ event: EngineFrameSnapshot['events'][number] }>[]
  engineSwitches: FrameItem<{ route: EngineFrameSnapshot['routing']['switches'][number] }>[]
  engineAlarms: FrameItem<{ alarm: EngineFrameSnapshot['routing']['alarms'][number] }>[]
}
export interface EngineReplaySnapshot extends EngineReplayEvidence {
  runId: string
  scenarioId: string
  sourceSha256: string
  frameCount: number
  epochs: { engineEpoch: number; frameCount: number; firstTime: number; lastTime: number }[]
  engineEpoch: number
  time: number
  nextFrameTime: number | null
  historyTruncated: boolean
  links: Pick<Link, 'id' | 'type' | 'sourcePlatformId' | 'targetPlatformId'>[]
}

export function isEngineReplaySnapshot(value: unknown): value is EngineReplaySnapshot {
  if (!value || typeof value !== 'object') return false
  const v = value as EngineReplaySnapshot
  const number = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  const integer = (n: unknown): n is number => number(n) && Number.isSafeInteger(n)
  if (typeof v.runId !== 'string' || !v.runId.startsWith('RUN-') || typeof v.scenarioId !== 'string'
    || typeof v.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sourceSha256)
    || !integer(v.frameCount) || !integer(v.engineEpoch) || !number(v.time) || typeof v.historyTruncated !== 'boolean'
    || !(v.nextFrameTime === null || number(v.nextFrameTime) && v.nextFrameTime > v.time)
    || !Array.isArray(v.epochs) || !v.epochs.every(e => e && integer(e.engineEpoch) && integer(e.frameCount) && e.frameCount > 0 && number(e.firstTime) && number(e.lastTime) && e.lastTime >= e.firstTime)
    || new Set(v.epochs.map(e => e.engineEpoch)).size !== v.epochs.length
    || v.epochs.reduce((sum, e) => sum + e.frameCount, 0) !== v.frameCount
    || (v.epochs.length > 0 && !v.epochs.some(e => e.engineEpoch === v.engineEpoch))
    || !Array.isArray(v.links) || !v.links.every(l => l && typeof l.id === 'string' && ['SAT', 'MICROWAVE', 'DATALINK', 'LASER', 'FIBER'].includes(l.type) && typeof l.sourcePlatformId === 'string' && typeof l.targetPlatformId === 'string')) return false
  const rows = [v.engineEvents, v.engineSwitches, v.engineAlarms]
  if (!rows.every(items => Array.isArray(items) && items.length <= 200 && items.every(item => item && integer(item.frameId) && number(item.simulationTime) && item.simulationTime <= v.time))) return false
  if (v.engineFrame === null) return rows.every(items => items.length === 0)
  if (!isEngineFrameSnapshot(v.engineFrame) || v.engineFrame.runId !== v.runId || v.engineFrame.engineEpoch !== v.engineEpoch || v.engineFrame.simulationTime > v.time) return false
  // Reuse the frame's nested payload validation for historical event rows.
  return isEngineFrameSnapshot({ ...v.engineFrame, events: v.engineEvents.map(item => item.event),
    routing: { switches: v.engineSwitches.map(item => item.route), alarms: v.engineAlarms.map(item => item.alarm) } })
}

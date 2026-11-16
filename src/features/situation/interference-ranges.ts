import type { EngineFrameSnapshot, EngineJammer, Jammer, TelemetryFrame } from '../../contracts/domain-models'
import { MAP_CONFIG } from '../../config/map.config'
import type { SituationMapNode } from './initial-nodes'
import type { FileDeviceEvent } from './file-device-events'

export type ConfiguredJammerRange = Pick<Jammer, 'id' | 'platformId' | 'jammingRange'>
export interface InterferenceRange {
  id: string
  platformId: string
  jammerId?: string
  radiusMeters: number
  configured: boolean
  sourceLabel?: string
}

/** 只有平台身份唯一的设备才能替换地图上的位置和配置范围。 */
function uniqueEngineJammers(frame?: EngineFrameSnapshot | null): Map<string, EngineJammer> {
  const result = new Map<string, EngineJammer>()
  for (const jammer of frame?.jammers ?? []) {
    if (jammer.platformId && frame!.jammers.filter(item => item.platformId === jammer.platformId).length === 1) result.set(jammer.platformId, jammer)
  }
  return result
}

export function engineJammerNodes(nodes: readonly SituationMapNode[], frame?: EngineFrameSnapshot | null): SituationMapNode[] {
  const jammers = uniqueEngineJammers(frame)
  return nodes.map(node => {
    const position = jammers.get(node.platformId)?.position
    if (!position || typeof position.longitude !== 'number' || !Number.isFinite(position.longitude) || Math.abs(position.longitude) > 180
      || typeof position.latitude !== 'number' || !Number.isFinite(position.latitude) || Math.abs(position.latitude) > 90) return node
    return { ...node, longitude: position.longitude, latitude: position.latitude,
      altitude: typeof position.altitudeM === 'number' && Number.isFinite(position.altitudeM) ? position.altitudeM : node.altitude,
      time: frame!.simulationTime, positionSource: 'ENGINE' }
  })
}

export const interferenceRangeSource = (range: InterferenceRange): string => range.sourceLabel
  ?? (range.configured ? '配置范围，非实测覆盖' : '示意范围，缺少设备配置')

/** 配置范围按设备身份匹配；没有配置的原始日志只提供明确标注的示意圈。 */
export function selectInterferenceRanges(
  nodes: readonly SituationMapNode[], frame: TelemetryFrame | null,
  jammers: readonly ConfiguredJammerRange[] | undefined, states: readonly FileDeviceEvent[] = [],
  engineFrame?: EngineFrameSnapshot | null,
): InterferenceRange[] {
  let ranges: InterferenceRange[] = jammers !== undefined ? jammers.filter(jammer =>
    Number.isFinite(jammer.jammingRange) && jammer.jammingRange > 0
    && nodes.some(node => node.platformId === jammer.platformId)
    && (!frame || frame.platforms.some(platform => platform.platformId === jammer.platformId
      && platform.jammers.some(state => state.jammerId === jammer.id && state.active))),
  ).map(jammer => ({ id: `configured:${jammer.id}`, platformId: jammer.platformId,
    jammerId: jammer.id, radiusMeters: jammer.jammingRange, configured: true }))
  : nodes.filter(node => frame
    ? frame.platforms.some(platform => platform.platformId === node.platformId && platform.jammers.some(jammer => jammer.active))
    : states.some(state => state.platformId === node.platformId && state.kind === 'JAMMING' && state.active),
  ).map(node => ({ id: `illustrative:${node.platformId}`, platformId: node.platformId,
    radiusMeters: frame ? MAP_CONFIG.activeInterferenceRadiusMeters : MAP_CONFIG.fileInterferenceRadiusMeters, configured: false }))
  for (const [platformId, jammer] of uniqueEngineJammers(engineFrame)) {
    if (!nodes.some(node => node.platformId === platformId)) continue
    if (jammer.deviceStatus === 'OFF' || jammer.rangeM === 0) {
      ranges = ranges.filter(range => range.platformId !== platformId)
    } else if (jammer.rangeM !== null && Number.isFinite(jammer.rangeM) && jammer.rangeM > 0) {
      const configured = jammers?.filter(item => item.platformId === platformId) ?? []
      ranges = ranges.filter(range => range.platformId !== platformId)
      ranges.push({ id: `engine:${platformId}`, platformId,
        jammerId: configured.length === 1 ? configured[0]!.id : jammer.name ?? platformId,
        radiusMeters: jammer.rangeM, configured: false,
        sourceLabel: `引擎报告范围${jammer.deviceStatus === 'ON' ? '' : '，启停未确认'}` })
    }
  }
  return ranges
}

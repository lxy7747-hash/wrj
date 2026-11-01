import type { Jammer, TelemetryFrame } from '../../contracts/domain-models'
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
}

/** 配置范围按设备身份匹配；没有配置的原始日志只提供明确标注的示意圈。 */
export function selectInterferenceRanges(
  nodes: readonly SituationMapNode[], frame: TelemetryFrame | null,
  jammers: readonly ConfiguredJammerRange[] | undefined, states: readonly FileDeviceEvent[] = [],
): InterferenceRange[] {
  if (jammers !== undefined) return jammers.filter(jammer =>
    Number.isFinite(jammer.jammingRange) && jammer.jammingRange > 0
    && nodes.some(node => node.platformId === jammer.platformId)
    && (!frame || frame.platforms.some(platform => platform.platformId === jammer.platformId
      && platform.jammers.some(state => state.jammerId === jammer.id && state.active))),
  ).map(jammer => ({ id: `configured:${jammer.id}`, platformId: jammer.platformId,
    jammerId: jammer.id, radiusMeters: jammer.jammingRange, configured: true }))

  return nodes.filter(node => frame
    ? frame.platforms.some(platform => platform.platformId === node.platformId && platform.jammers.some(jammer => jammer.active))
    : states.some(state => state.platformId === node.platformId && state.kind === 'JAMMING' && state.active),
  ).map(node => ({ id: `illustrative:${node.platformId}`, platformId: node.platformId,
    radiusMeters: frame ? MAP_CONFIG.activeInterferenceRadiusMeters : MAP_CONFIG.fileInterferenceRadiusMeters, configured: false }))
}

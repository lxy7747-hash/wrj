import type { EngineFrameSnapshot, EngineJammer, Jammer, TelemetryFrame } from '../../contracts/domain-models'
import { MAP_CONFIG, nodeCategory } from '../../config/map.config'
import type { SituationMapNode } from './initial-nodes'
import type { FileDeviceEvent } from './file-device-events'

export type ConfiguredJammerRange = Pick<Jammer, 'id' | 'platformId' | 'jammingRange'> & Partial<Pick<Jammer, 'detectionRange'>>
export interface InterferenceRange {
  id: string
  platformId: string
  jammerId?: string
  radiusMeters: number
  configured: boolean
  sourceLabel?: string
}

export interface DetectionRange {
  id: string
  platformId: string
  jammerId?: string
  radiusMeters: number
  configured: boolean
  sourceLabel: string
}

const JAMMER_STATION_CATEGORIES = new Set(['GROUND_JAMMER_DETECTION_STATION', 'AIRBORNE_JAMMER_PLATFORM'])

function isJammerStationNode(node: SituationMapNode): boolean {
  const category = nodeCategory(node)
  return category !== undefined && JAMMER_STATION_CATEGORIES.has(category)
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
    const time = frame!.simulationTime
    return { ...node, longitude: position.longitude, latitude: position.latitude,
      altitude: typeof position.altitudeM === 'number' && Number.isFinite(position.altitudeM) ? position.altitudeM : node.altitude,
      heading: node.time === time ? node.heading : undefined,
      time, positionSource: 'ENGINE' }
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

/** 地面干扰站与机载干扰平台探测范围：场景配置读取 detectionRange，引擎探测事件覆盖对应半径；缺省时默认比干扰范围大 10 海里，文件模式保留指定示意圈。 */
export function selectDetectionRanges(
  nodes: readonly SituationMapNode[],
  frame: TelemetryFrame | null,
  jammers?: readonly ConfiguredJammerRange[],
  engineFrame?: EngineFrameSnapshot | null,
  configuredLinks?: readonly unknown[],
): DetectionRange[] {
  const fileMode = !frame && configuredLinks === undefined && jammers === undefined
  const nodeMap = new Map(nodes.map(node => [node.platformId, node]))
  let ranges: DetectionRange[] = fileMode
    ? nodes.flatMap(node => {
      const radiusMeters = MAP_CONFIG.fileDetectionRadiiMeters[node.platformId]
      return radiusMeters !== undefined
        ? [{ id: `file:${node.platformId}`, platformId: node.platformId, radiusMeters, configured: false, sourceLabel: '指定范围' }]
        : []
    })
    : (jammers ?? []).flatMap((jammer): DetectionRange[] => {
      const node = nodeMap.get(jammer.platformId)
      if (!node || !isJammerStationNode(node)) return []
      if (typeof jammer.detectionRange === 'number' && Number.isFinite(jammer.detectionRange) && jammer.detectionRange > 0) {
        return [{
          id: `configured:${jammer.id}`,
          platformId: jammer.platformId,
          jammerId: jammer.id,
          radiusMeters: jammer.detectionRange,
          configured: true,
          sourceLabel: '配置范围，非实测覆盖',
        }]
      }
      if (typeof jammer.jammingRange === 'number' && Number.isFinite(jammer.jammingRange) && jammer.jammingRange > 0) {
        return [{
          id: `configured:${jammer.id}`,
          platformId: jammer.platformId,
          jammerId: jammer.id,
          radiusMeters: jammer.jammingRange + MAP_CONFIG.defaultDetectionMarginMeters,
          configured: false,
          sourceLabel: '默认范围（干扰范围 + 10 海里）',
        }]
      }
      return []
    })

  for (const [platformId, jammer] of uniqueEngineJammers(engineFrame)) {
    const node = nodeMap.get(platformId)
    if (!node || !isJammerStationNode(node)) continue
    if (jammer.detectStatus === 'OFF') {
      ranges = ranges.filter(range => range.platformId !== platformId)
      continue
    }
    const configured = jammers?.filter(item => item.platformId === platformId) ?? []
    const jammerId = configured.length === 1 ? configured[0]!.id : jammer.name ?? platformId
    const reportedRadii = jammer.detections
      .map(detection => detection.rangeM)
      .filter((radius): radius is number => typeof radius === 'number' && Number.isFinite(radius) && radius > 0)
    if (reportedRadii.length) {
      ranges = ranges.filter(range => range.platformId !== platformId)
      ranges.push({
        id: `engine:${platformId}`,
        platformId,
        jammerId,
        radiusMeters: Math.max(...reportedRadii),
        configured: false,
        sourceLabel: '引擎报告范围',
      })
      continue
    }
    const hasExplicitOrFileRange = ranges.some(range =>
      range.platformId === platformId && (range.configured || range.id.startsWith('file:')),
    )
    if (hasExplicitOrFileRange) continue
    if (jammer.deviceStatus !== 'OFF' && typeof jammer.rangeM === 'number' && Number.isFinite(jammer.rangeM) && jammer.rangeM > 0) {
      ranges = ranges.filter(range => range.platformId !== platformId)
      ranges.push({
        id: `engine:${platformId}`,
        platformId,
        jammerId,
        radiusMeters: jammer.rangeM + MAP_CONFIG.defaultDetectionMarginMeters,
        configured: false,
        sourceLabel: '默认范围（干扰范围 + 10 海里）',
      })
    }
  }
  return ranges
}

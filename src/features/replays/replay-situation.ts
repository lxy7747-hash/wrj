import type {
  EngineFrameSnapshot,
  Link,
  Platform,
  ScenarioConfig,
  UiLinkStatus,
} from '../../contracts/domain-models'
import type {
  ConfiguredLinkSwitchState,
  SituationMapLink,
} from '../../components/situation/situation-map-controller'
import { isConfiguredLinkEnabled, readLinkSettings } from '../scenarios/link-settings'
import { createEngineLinkHoverLookup } from '../situation/engine-link-hover'
import { resolveEngineFrameConfiguredLinks, type EngineConfiguredLinkStatus } from '../situation/engine-link-statuses'
import { resolveEngineSwitchHighlights } from '../situation/engine-route-highlights'
import { selectFileMessageLinks, type FileMessageLink } from '../situation/file-message-links'
import { platformMapSide, type SituationMapNode } from '../situation/initial-nodes'
import type { LiveMessageFlowLane } from '../situation/live-message-flows'
import { isPlatformPresentAt } from '../situation/platform-lifecycle'
import type { EngineReplaySnapshot, EngineReplayTimelineMarker } from './engine-replay'
import { selectReplayNodes, type LocalReplaySnapshot } from './local-replay'

export interface ReplayConfiguredLinkView {
  configuredLinks: SituationMapLink[]
  focusLinks: Link[]
  statuses: Map<string, UiLinkStatus>
  switches: Map<string, ConfiguredLinkSwitchState>
  segmentStatuses: Map<string, EngineConfiguredLinkStatus>
}

function isPlatformLike(value: unknown): value is Platform {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<Platform>
  return typeof item.id === 'string' && item.id.length > 0
    && typeof item.name === 'string'
    && typeof item.type === 'string'
    && Boolean(item.initialPosition) && typeof item.initialPosition === 'object'
    && typeof item.initialPosition!.longitude === 'number' && Number.isFinite(item.initialPosition!.longitude)
    && typeof item.initialPosition!.latitude === 'number' && Number.isFinite(item.initialPosition!.latitude)
    && typeof item.initialPosition!.altitude === 'number' && Number.isFinite(item.initialPosition!.altitude)
}

function isLinkLike(value: unknown): value is Link {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<Link>
  return typeof item.id === 'string' && item.id.length > 0
    && typeof item.type === 'string'
    && typeof item.sourcePlatformId === 'string' && item.sourcePlatformId.length > 0
    && typeof item.targetPlatformId === 'string' && item.targetPlatformId.length > 0
}

/** 校验运行结果对应场景中用于态势渲染的最小结构（平台与链路）；不完整时返回 null 以回退文件模式。 */
export function extractReplayScenarioConfig(raw: unknown): ScenarioConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const config = raw as Partial<ScenarioConfig>
  if (!Array.isArray(config.platforms) || config.platforms.length === 0 || !config.platforms.every(isPlatformLike)) return null
  if (!Array.isArray(config.links) || !config.links.every(isLinkLike)) return null
  return config as ScenarioConfig
}

/**
 * 合并场景平台定义与回放轨迹：与态势主界面一致以场景平台类型、名称、阵营与卫星子类型为基座，
 * 叠加当前游标位置；已到平台删除时刻的实体不回退显示初始位置。
 */
export function selectReplayMapNodes(
  snapshot: LocalReplaySnapshot | null,
  sceneConfig: ScenarioConfig | null,
  currentTimeS: number,
  interpolate = false,
): SituationMapNode[] {
  if (!snapshot) return []
  const recordedNodes = selectReplayNodes(snapshot, currentTimeS, interpolate)
  if (!sceneConfig) return recordedNodes

  const deletions = snapshot.initial.platformDeletions ?? []
  const recordedById = new Map(recordedNodes.map(node => [node.platformId, node]))
  const seen = new Set<string>()
  const merged: SituationMapNode[] = []

  for (const platform of sceneConfig.platforms) {
    seen.add(platform.id)
    if (!isPlatformPresentAt(deletions, platform.id, currentTimeS)) continue
    const recorded = recordedById.get(platform.id)
    const fallbackSide = platformMapSide(platform)
    merged.push({
      platformId: platform.id,
      name: platform.name,
      type: platform.type,
      satelliteType: platform.satelliteType,
      side: fallbackSide,
      longitude: platform.initialPosition.longitude,
      latitude: platform.initialPosition.latitude,
      altitude: platform.initialPosition.altitude,
      speed: 0,
      ...(recorded ? {
        ...recorded,
        name: platform.name,
        type: platform.type,
        satelliteType: platform.satelliteType,
        side: recorded.side ?? fallbackSide,
      } : undefined),
    })
  }

  for (const node of recordedNodes) {
    if (!seen.has(node.platformId)) merged.push(node)
  }
  return merged
}

/**
 * 按态势主界面相同规则，由场景配置与历史引擎帧投影配置链路、异常红线与最近一次切换高亮。
 * 当前时刻尚未到达首帧（engineFrame 为空）时返回空链路集合，与态势主界面初始帧前表现一致。
 */
export function selectReplayConfiguredLinks(
  sceneConfig: ScenarioConfig,
  engineHistory: EngineReplaySnapshot,
): ReplayConfiguredLinkView {
  const platformIds = new Set(sceneConfig.platforms.map(platform => platform.id))
  const focusLinks = sceneConfig.links.filter(
    link => platformIds.has(link.sourcePlatformId) && platformIds.has(link.targetPlatformId),
  )
  const frame: EngineFrameSnapshot | null = engineHistory.engineFrame
  if (!frame) {
    return {
      configuredLinks: [],
      focusLinks,
      statuses: new Map(),
      switches: new Map(),
      segmentStatuses: new Map(),
    }
  }

  const segmentStatuses = resolveEngineFrameConfiguredLinks(frame, sceneConfig.links)
  const statuses = new Map<string, UiLinkStatus>(
    [...segmentStatuses.entries()].map(([id, value]) => [id, value.status]),
  )
  const settings = readLinkSettings(sceneConfig)
  const hoverFor = createEngineLinkHoverLookup(
    frame,
    engineHistory.engineSwitches.map(item => item.route),
  )

  const configuredLinks: SituationMapLink[] = sceneConfig.links.flatMap(link => {
    const status = statuses.get(link.id)
    if (!platformIds.has(link.sourcePlatformId) || !platformIds.has(link.targetPlatformId)
      || !isConfiguredLinkEnabled(link, settings, sceneConfig.platforms)
      || (status !== 'UP' && status !== 'DEGRADED' && status !== 'DOWN')) return []
    const engineStatus = segmentStatuses.get(link.id)
    const displayed = engineStatus?.relayBypassed ? { ...link, relayPlatformId: null } : link
    if (!engineStatus) return [displayed]
    const relayId = displayed.relayPlatformId
    const route = relayId
      ? [displayed.sourcePlatformId, relayId, displayed.targetPlatformId]
      : [displayed.sourcePlatformId, displayed.targetPlatformId]
    return [{ ...displayed, distanceM: engineStatus.distanceM ?? undefined, hover: hoverFor(link.id, route) }]
  })

  const switches = new Map<string, ConfiguredLinkSwitchState>()
  const latestSwitch = engineHistory.engineSwitches.at(-1)
  if (latestSwitch && latestSwitch.frameId === frame.frameId) {
    const resolved = resolveEngineSwitchHighlights(frame, latestSwitch.route.oldNodes, latestSwitch.route.nodes)
    const before = new Set(resolved.before.linkIds)
    const after = new Set(resolved.after.linkIds)
    for (const id of new Set([...before, ...after])) {
      switches.set(id, before.has(id) && after.has(id) ? 'BOTH' : before.has(id) ? 'BEFORE' : 'AFTER')
    }
  }

  return { configuredLinks, focusLinks, statuses, switches, segmentStatuses }
}

/**
 * 将历史消息投递记录投影为场景模式地图的流向动画车道；仅在播放中且落在当前推进窗口内时触发脉冲。
 */
export function selectReplayLiveMessageFlows(
  links: readonly FileMessageLink[] | undefined,
  currentTimeS: number,
  speed: number,
  playing: boolean,
): LiveMessageFlowLane[] {
  if (!links?.length) return []
  const pulseWindowS = Math.max(2, Number.isFinite(speed) && speed > 0 ? speed : 1)
  return selectFileMessageLinks(links, currentTimeS).map(link => {
    const latest = link.records[link.records.length - 1]!
    const isFresh = playing && currentTimeS - latest.time <= pulseWindowS
    return {
      id: link.id,
      type: link.type,
      sourcePlatformId: link.sourcePlatformId,
      targetPlatformId: link.targetPlatformId,
      sourceDeviceId: link.sourceDeviceId,
      targetDeviceId: link.targetDeviceId,
      direction: link.direction,
      messageTypes: link.messageTypes,
      records: link.records,
      firstTimeS: link.firstTimeS,
      lastTimeS: link.lastTimeS,
      messageCount: link.messageCount,
      pulseId: isFresh ? latest.sourceEventId : undefined,
      latestDeliveryTimeS: latest.time,
      latestDelayS: latest.delayS,
    }
  })
}

function buildEngineAliasNames(
  sceneConfig: ScenarioConfig | null,
  nodeNames: Readonly<Record<string, string>>,
): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const [id, name] of Object.entries(nodeNames)) {
    if (id && name) aliases.set(id, name)
  }
  const platforms = sceneConfig?.platforms ?? []
  let uav = 0
  let ground = 0
  let airborne = 0
  const pad = (prefix: string, index: number) => `${prefix}_${String(index).padStart(2, '0')}`
  for (const platform of platforms) {
    if (platform.type === 'FORWARD_RELAY_NODE') aliases.set(pad('mission_uav', ++uav), platform.name)
  }
  for (const platform of platforms) {
    switch (platform.type) {
      case 'AIRBORNE_MISSION_CLUSTER': aliases.set(pad('mission_uav', ++uav), platform.name); break
      case 'GROUND_JAMMER_DETECTION_STATION': aliases.set(pad('jammer_station', ++ground), platform.name); break
      case 'AIRBORNE_JAMMER_PLATFORM': aliases.set(pad('jammer_airborne', ++airborne), platform.name); break
      case 'REAR_COMMAND_NODE': aliases.set('rear_comm_vehicle', platform.name); break
      case 'GROUND_CLUSTER_COMMAND_NODE': aliases.set('command_vehicle', platform.name); break
      case 'COMMUNICATION_SATELLITE':
        aliases.set(platform.satelliteType === 'TIANTONG' ? 'tiantong_sat' : 'shentong_sat', platform.name)
        break
    }
  }
  return aliases
}

function formatFallbackEngineIdentifier(token: string): string {
  if (token === 'rear_comm_vehicle') return '后方指挥节点'
  if (token === 'command_vehicle') return '集群指挥车'
  if (token === 'tiantong_sat') return '天通卫星'
  if (token === 'shentong_sat') return '神通卫星'
  const uav = /^mission_uav_(\d+)$/i.exec(token)
  if (uav) return `无人节点 ${Number(uav[1])}`
  const groundJammer = /^jammer_station_(\d+)$/i.exec(token)
  if (groundJammer) return `地面干扰站 ${Number(groundJammer[1])}`
  const airJammer = /^jammer_airborne_(\d+)$/i.exec(token)
  if (airJammer) return `机载干扰平台 ${Number(airJammer[1])}`
  return token
}

/**
 * 将历史时间轴事件明细中的引擎英文平台名与冗长端口名转换为场景中文名与简洁通信体制名。
 */
export function localizeReplayTimelineMarkers(
  markers: readonly EngineReplayTimelineMarker[] | undefined,
  sceneConfig: ScenarioConfig | null,
  nodeNames: Readonly<Record<string, string>>,
): EngineReplayTimelineMarker[] {
  if (!markers?.length) return []
  const aliases = buildEngineAliasNames(sceneConfig, nodeNames)
  return markers.map(marker => {
    let detail = marker.detail
    // 若携带平台 ID，优先用场景中文名替换括号目标或整段参与者
    if (marker.actorIds?.length) {
      const resolvedActors = marker.actorIds.map(id => nodeNames[id] ?? aliases.get(id) ?? formatFallbackEngineIdentifier(id)).filter(Boolean)
      if (marker.kind === 'SWITCH' && resolvedActors[0] && /（[^）]+）$/u.test(detail)) {
        detail = detail.replace(/（[^）]+）$/u, `（${resolvedActors[0]}）`)
      } else if (marker.kind !== 'SWITCH' && resolvedActors.length >= 1 && detail.includes('→')) {
        detail = resolvedActors.join(' → ')
      }
    }
    // 兼容旧服务端响应中仍含原始引擎英文名或冗长端口名
    detail = detail
      .replace(/C\s*波段(?:上行|下行)|L\s*波段(?:上行|下行)/gu, '数传')
      .replace(/卫通\s*[AB]（(?:前向|返向)）|卫通/gu, '卫星')
      .replace(/激光通信/gu, '激光')
      .replace(/\b(?:mission_uav_\d+|jammer_station_\d+|jammer_airborne_\d+|rear_comm_vehicle|command_vehicle|tiantong_sat|shentong_sat)\b/giu, token => (
        aliases.get(token.toLowerCase()) ?? aliases.get(token) ?? formatFallbackEngineIdentifier(token.toLowerCase())
      ))
    // 合并因多波段简化后产生的重复体制名（如「数传/数传」）
    detail = detail.replace(/切至\s+([^（\s]+)/u, (_, mediums: string) => {
      const unique = [...new Set(mediums.split('/').filter(Boolean))]
      return `切至 ${unique.join('/')}`
    })
    return detail === marker.detail ? marker : { ...marker, detail }
  })
}

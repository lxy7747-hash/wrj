import type {
  DetectionEvent,
  LinkStatusSummary,
  PlatformStatus,
  ScenarioConfig,
  SwitchEvent,
  TelemetryFrame,
  TelemetryLinkRecord,
  UiLinkStatus,
} from '../../contracts/domain-models'
import deterministicData from '../../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'

type SituationEvent = DetectionEvent | SwitchEvent

export interface SituationLinkView {
  frameId: TelemetryFrame['frameId']
  linkId: string
  sourceName: string
  destinationName: string
  type: LinkStatusSummary['linkType']
  snrDb: number
  ber: number
  updatedAt: number
  status: UiLinkStatus
  canonicalStatus: LinkStatusSummary['status']
  reason: string
  consecutiveFrames: number | null
  ageMs: number
  detailed: TelemetryLinkRecord | null
}

export interface SituationMetrics {
  frameId: TelemetryFrame['frameId']
  businessNodeCount: number
  supportingEntityCount: number
  upLinkCount: number
  degradedLinkCount: number
  downLinkCount: number
  activeJammerCount: number
  switchEventCount: number
}

export const SITUATION_FRAME_F00042 = deterministicData.frame as unknown as TelemetryFrame

export const SITUATION_EVENTS_F00042 = (deterministicData.events as unknown as SituationEvent[])
  .filter((event) => event.frameId === SITUATION_FRAME_F00042.frameId)

export const PLATFORM_TYPE_LABELS: Record<PlatformStatus['type'], string> = {
  REAR_COMMAND_NODE: '后方指挥节点',
  FORWARD_RELAY_NODE: '高空前出中继节点',
  GROUND_CLUSTER_COMMAND_NODE: '地面无人集群指挥车',
  AIRBORNE_MISSION_CLUSTER: '空中无人作业集群',
  COMMUNICATION_SATELLITE: '通信卫星',
  GROUND_JAMMER_DETECTION_STATION: '地面固定式干扰侦测站',
}

export const LINK_TYPE_LABELS: Record<LinkStatusSummary['linkType'], string> = {
  SAT: '卫星链路',
  MICROWAVE: '微波链路',
  DATALINK: '新一代数传链路',
  LASER: '激光链路',
}

export const JAMMER_TYPE_LABELS: Record<ScenarioConfig['jammers'][number]['type'], string> = {
  BARRAGE: '宽带压制',
  SPOT: '瞄准式',
}

/** 按规范场景中的正式类型读取干扰设备中文名称。 */
export function getJammerTypeLabel(jammerId: string): string {
  const jammer = (deterministicData.scenario as ScenarioConfig).jammers.find((item) => item.id === jammerId)
  return jammer === undefined ? jammerId : JAMMER_TYPE_LABELS[jammer.type]
}

const BUSINESS_NODE_TYPES = new Set<PlatformStatus['type']>([
  'REAR_COMMAND_NODE',
  'FORWARD_RELAY_NODE',
  'GROUND_CLUSTER_COMMAND_NODE',
  'AIRBORNE_MISSION_CLUSTER',
])

/**
 * 获取平台的中文名称。
 * @param platformId 平台唯一标识。
 * @returns 固定帧中的平台名称；找不到时返回平台标识。
 * @sideeffect 无副作用，只读取固定帧。
 */
export function getPlatformName(platformId: string, frame = SITUATION_FRAME_F00042): string {
  return frame.platforms.find((platform) => platform.platformId === platformId)?.name
    ?? platformId
}

/**
 * 从摘要和证据中解析链路标识。
 * @param summary 当前帧链路摘要。
 * @returns 与摘要对应的链路标识。
 * @sideeffect 无副作用，只读取固定帧。
 */
function resolveLinkId(summary: LinkStatusSummary, frame: TelemetryFrame): string {
  const detailed = frame.links.find((link) => (
    link.sourcePlatform === summary.sourcePlatform
    && link.destPlatform === summary.destPlatform
    && link.linkType === summary.linkType
  ))
  if (detailed) return detailed.linkId

  return frame.evidence.routeCandidates.find((candidate) => candidate.ber === summary.currentBer)?.linkId
    ?? summary.linkKey
}

/**
 * 获取链路的界面状态投影。
 * @param linkId 链路唯一标识。
 * @param summary 当前帧链路摘要。
 * @returns 带中文原因和稳定帧数的界面投影。
 * @sideeffect 无副作用，只读取固定帧。
 */
function getProjection(linkId: string, summary: LinkStatusSummary, frame: TelemetryFrame): {
  status: UiLinkStatus
  canonicalStatus: LinkStatusSummary['status']
  reason: string
  consecutiveFrames: number | null
  ageMs: number
} {
  const projection = frame.uiLinks.find((item) => item.linkId === linkId)
  if (projection) return { ...projection, canonicalStatus: summary.status }

  const routeCandidate = frame.evidence.routeCandidates.find(
    (candidate) => candidate.linkId === linkId,
  )
  return {
    status: summary.status,
    canonicalStatus: summary.status,
    reason: summary.status === 'UP' ? '当前帧链路正常' : '当前帧链路中断',
    consecutiveFrames: routeCandidate?.stabilityFrames ?? null,
    ageMs: Math.max(0, (frame.simulationTime - summary.updatedAt) * 1000),
  }
}

/**
 * 构建供地图、表格和详情共同使用的链路视图。
 * @returns 当前固定帧的链路视图列表。
 * @sideeffect 无副作用，只读取固定帧。
 */
export function selectSituationLinks(frame = SITUATION_FRAME_F00042): SituationLinkView[] {
  return frame.linkSummaries.map((summary) => {
    const linkId = resolveLinkId(summary, frame)
    const projection = getProjection(linkId, summary, frame)
    const detailed = frame.links.find((link) => link.linkId === linkId) ?? null

    return {
      frameId: frame.frameId,
      linkId,
      sourceName: getPlatformName(summary.sourcePlatform, frame),
      destinationName: getPlatformName(summary.destPlatform, frame),
      type: summary.linkType,
      snrDb: summary.currentSnr,
      ber: summary.currentBer,
      updatedAt: summary.updatedAt,
      status: projection.status,
      canonicalStatus: projection.canonicalStatus,
      reason: projection.reason,
      consecutiveFrames: projection.consecutiveFrames,
      ageMs: projection.ageMs,
      detailed,
    }
  })
}

/**
 * 汇总固定帧态势指标。
 * @returns 带帧标识的节点、链路、干扰和切换指标。
 * @sideeffect 无副作用，只读取固定帧和同帧事件。
 */
export function selectSituationMetrics(
  frame = SITUATION_FRAME_F00042,
  events: SituationEvent[] = SITUATION_EVENTS_F00042,
): SituationMetrics {
  const links = selectSituationLinks(frame)
  const businessNodeCount = frame.platforms
    .filter((platform) => BUSINESS_NODE_TYPES.has(platform.type)).length
  const activeJammerCount = frame.platforms
    .flatMap((platform) => platform.jammers)
    .filter((jammer) => jammer.active).length

  return {
    frameId: frame.frameId,
    businessNodeCount,
    supportingEntityCount: frame.platforms.length - businessNodeCount,
    upLinkCount: links.filter((link) => link.status === 'UP').length,
    degradedLinkCount: links.filter((link) => link.status === 'DEGRADED').length,
    downLinkCount: links.filter((link) => link.status === 'DOWN').length,
    activeJammerCount,
    switchEventCount: events.filter((event) => event.type === 'LINK_SWITCH').length,
  }
}

export const SITUATION_LINKS_F00042 = selectSituationLinks()
export const SITUATION_METRICS_F00042 = selectSituationMetrics()

/**
 * 将秒数格式化为仿真时钟文本。
 * @param seconds 非负秒数。
 * @returns T+ HH:MM:SS 格式文本。
 * @sideeffect 无副作用。
 */
export function formatSimulationTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safeSeconds / 3600).toString().padStart(2, '0')
  const minutes = Math.floor((safeSeconds % 3600) / 60).toString().padStart(2, '0')
  const remainingSeconds = (safeSeconds % 60).toString().padStart(2, '0')
  return `T+ ${hours}:${minutes}:${remainingSeconds}`
}

/**
 * 将误码率转换为紧凑科学计数法。
 * @param value 误码率数值。
 * @returns 小写 e 的科学计数法文本。
 * @sideeffect 无副作用。
 */
export function formatBer(value: number): string {
  return value.toExponential(1).replace('e+', 'e')
}

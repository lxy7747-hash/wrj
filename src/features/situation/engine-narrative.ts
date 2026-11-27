import type {
  EngineFrameEvent,
  EngineFrameSnapshot,
  EngineJammer,
  EngineLinkSegment,
  EngineRouteAlarm,
  EngineRouteSwitch,
  Link,
  LinkCalcSettings,
} from '../../contracts/domain-models'
import { nodeCategory } from '../../config/map.config'
import type { SituationMapFocusTarget } from '../../components/situation/situation-map-controller'
import { LINK_CALC_DEFAULTS } from '../scenarios/link-calc-defaults'
import type { EngineSwitchEntry } from './engine-route-highlights'
import type { FileDeviceEvent } from './file-device-events'
import { formatCommunicationPortLabel } from './file-message-links'
import type { SituationMapNode } from './initial-nodes'
import type { DetectionRange, InterferenceRange } from './interference-ranges'

export type LinkCalcThresholds = Partial<Pick<LinkCalcSettings, 'emergencyThreshold' | 'warningThreshold' | 'valueThresholdBer'>>

export interface ActiveJammingBeam {
  id: string
  jammerPlatformId: string
  targetPlatformId: string
  jammerName: string
  targetName: string
  lossDb: number | null
  mode: string | null
}

export interface ActiveJammingOverlay {
  activeJammerPlatformIds: ReadonlySet<string>
  beams: ActiveJammingBeam[]
}

export type JammerVisualState = 'IDLE' | 'DETECTING' | 'JAMMING' | 'JAMMING_OFF'

export interface JammerVisualStatus {
  platformId: string
  state: JammerVisualState
  label: string
}

export interface JammerVisualMemory {
  hadJamming: Set<string>
  hadDetectionTarget: Set<string>
}

export const JAMMER_VISUAL_LABELS: Readonly<Record<JammerVisualState, string>> = {
  IDLE: '',
  DETECTING: '侦测中',
  JAMMING: '开启压制',
  JAMMING_OFF: '关闭压制',
}

export function createJammerVisualMemory(): JammerVisualMemory {
  return {
    hadJamming: new Set<string>(),
    hadDetectionTarget: new Set<string>(),
  }
}

export function clearJammerVisualMemory(memory: JammerVisualMemory): void {
  memory.hadJamming.clear()
  memory.hadDetectionTarget.clear()
}

export type MapStoryKind = 'DETECT' | 'JAMMED' | 'JAM_OFF' | 'SWITCH'

export const SWITCH_BANNER_RETENTION_SECONDS = 15
export const SWITCH_BATCH_GAP_SECONDS = 15

export interface MapStoryTargetDetail {
  key: string
  name: string
  /** 简短状态、方向或时刻徽标（如「中断」「前向 · 19:12」）。 */
  badge?: string
  /** 损耗数值或完整切链路径等补充信息。 */
  meta?: string
  /** 该条链路/目标自身对应的触发条件徽标（按链路逐条展示，不汇总混放）。 */
  thresholds?: string[]
  focusTarget?: SituationMapFocusTarget
}

export interface MapStoryItem {
  id: string
  kind: MapStoryKind
  timeS: number
  tag: string
  summary: string
  detail: string
  /** 是否以双行紧凑卡片排版（适用于切换路径）。 */
  stacked?: boolean
  /** 涉及多架无人机/多目标时的逐项明细（用于折叠展开列表，保持主横幅恒定紧凑）。 */
  targets?: MapStoryTargetDetail[]
  /** 触发该切换/事件的阈值依据（完整拼接文本）。 */
  threshold?: string
  /** 拆分后的独立阈值短徽标列表（每项对应一个触发阈值）。 */
  thresholds?: string[]
  focusTarget?: SituationMapFocusTarget
}

export interface SegmentJammerEvidence {
  key: string
  jammerName: string
  distanceKm: number | null
  eirpDbw: number | null
  lossDb: number | null
  frequencyGHz: number | null
  modeLabel: string | null
  freqMatchNote: string | null
}

export interface SegmentJammingEvidence {
  isJammed: boolean
  shouldShow: boolean
  title: string
  summary: string
  linkFrequencyGHz: number | null
  jammingDb: number | null
  jammers: SegmentJammerEvidence[]
}

const JAM_MODE_LABELS: Record<string, string> = {
  BARRAGE: '宽带压制',
  broadband: '宽带压制',
  SPOT: '瞄准干扰',
  spot: '瞄准干扰',
  SWEEP: '扫频干扰',
  sweep: '扫频干扰',
}

function formatJamMode(mode: string | null | undefined): string | null {
  if (!mode) return null
  return JAM_MODE_LABELS[mode] ?? mode
}

function resolveNode(
  nodes: readonly SituationMapNode[],
  platformId: string | null | undefined,
  fallbackName?: string | null,
): SituationMapNode | undefined {
  if (platformId) {
    const byId = nodes.find(node => node.platformId === platformId)
    if (byId) return byId
  }
  if (fallbackName) {
    const byName = nodes.find(node => node.platformId === fallbackName || node.name === fallbackName)
    if (byName) return byName
  }
  return undefined
}

function formatNodeName(
  nodes: readonly SituationMapNode[],
  platformId: string | null | undefined,
  fallbackName?: string | null,
): string {
  const matched = resolveNode(nodes, platformId, fallbackName)
  return matched?.name ?? fallbackName ?? platformId ?? '未知节点'
}

const UNDETECTED_ENGINE_STATUSES = new Set(['OFF', 'NOT_DETECTED', 'UNDETECTED', 'NO_TARGET', 'NONE', 'IDLE'])

function isJammerDetecting(jammer: EngineJammer): boolean {
  return jammer.detectStatus === 'DETECTED'
    || jammer.detections.length > 0
    || (Boolean(jammer.detectStatus) && !UNDETECTED_ENGINE_STATUSES.has(jammer.detectStatus!))
}

/**
 * 判断引擎干扰机对象当前是否处于真实压制态：
 * 真实 LinkCalc 引擎在目标仅进入探测圈时即上报 deviceStatus="ON" + detectStatus="DETECTED" + actions=[]，
 * 此时仅表示设备已上电就绪而非正在压制，需结合闭环 JAM_ON/START 动作或链路干扰损耗判定。
 */
function isJammerActivelySuppressing(jammer: EngineJammer): boolean {
  const hasJamOnAction = jammer.actions.some(action => {
    const code = action.action?.toUpperCase()
    return code === 'JAM_ON' || code === 'START'
  })
  if (hasJamOnAction) return true
  const hasJamOffAction = jammer.actions.some(action => {
    const code = action.action?.toUpperCase()
    return code === 'JAM_OFF' || code === 'STOP'
  })
  if (hasJamOffAction || jammer.deviceStatus !== 'ON') return false
  return !isJammerDetecting(jammer)
}

/**
 * 仅依据引擎帧中的真实干扰机状态、闭环动作与链路干扰损耗提取当前活跃压制源与干扰射线。
 */
export function extractActiveJammingOverlay(
  frame: EngineFrameSnapshot | null | undefined,
  nodes: readonly SituationMapNode[],
): ActiveJammingOverlay {
  const activeJammerPlatformIds = new Set<string>()
  const beamMap = new Map<string, ActiveJammingBeam>()
  if (!frame || nodes.length === 0) return { activeJammerPlatformIds, beams: [] }

  const upsertBeam = (
    jammerNode: SituationMapNode,
    targetNode: SituationMapNode,
    lossDb: number | null,
    mode: string | null,
  ) => {
    if (jammerNode.platformId === targetNode.platformId) return
    const key = `${jammerNode.platformId}->${targetNode.platformId}`
    const existing = beamMap.get(key)
    const nextLoss = lossDb !== null && Number.isFinite(lossDb) && lossDb > 0
      ? (existing?.lossDb !== null && existing?.lossDb !== undefined ? Math.max(existing.lossDb, lossDb) : lossDb)
      : (existing?.lossDb ?? null)
    beamMap.set(key, {
      id: `beam:${key}`,
      jammerPlatformId: jammerNode.platformId,
      targetPlatformId: targetNode.platformId,
      jammerName: jammerNode.name,
      targetName: targetNode.name,
      lossDb: nextLoss,
      mode: existing?.mode ?? mode,
    })
  }

  for (const jammer of frame.jammers) {
    const jammerNode = resolveNode(nodes, jammer.platformId, jammer.name)
    if (!jammerNode) continue
    if (!isJammerActivelySuppressing(jammer)) continue
    activeJammerPlatformIds.add(jammerNode.platformId)

    let addedActionTarget = false
    for (const action of jammer.actions) {
      if (action.action?.toUpperCase() === 'JAM_OFF' || action.action?.toUpperCase() === 'STOP') continue
      const targetNode = resolveNode(nodes, action.targetPlatformId, action.targetName)
      if (!targetNode) continue
      addedActionTarget = true
      upsertBeam(jammerNode, targetNode, null, formatJamMode(action.mode ?? action.engineMode ?? jammer.engineMode))
    }

    if (!addedActionTarget) {
      for (const detection of jammer.detections) {
        const candidates = detection.targets.length
          ? detection.targets.map(item => resolveNode(nodes, item.platformId, item.name))
          : detection.targetIds.map((id, index) => resolveNode(nodes, id, detection.targetNames[index]))
        for (const targetNode of candidates) {
          if (targetNode) upsertBeam(jammerNode, targetNode, null, formatJamMode(jammer.engineMode))
        }
      }
    }
  }

  for (const segment of frame.links) {
    const segmentLoss = segment.losses.jammingDb
    const segmentJammed = typeof segmentLoss === 'number' && Number.isFinite(segmentLoss) && segmentLoss > 0
    if (!segmentJammed && segment.status !== 'DEGRADED' && segment.status !== 'DOWN') continue
    const targetNode = resolveNode(nodes, segment.targetPlatformId, segment.targetName)
    if (!targetNode) continue
    for (const traceJammer of segment.inputTrace.jammers) {
      const jammerNode = resolveNode(nodes, traceJammer.platformId, traceJammer.jammerName)
      if (!jammerNode) continue
      const effectiveLoss = segmentJammed ? segmentLoss : traceJammer.lossDb
      if (effectiveLoss === null || !Number.isFinite(effectiveLoss) || effectiveLoss <= 0) continue
      activeJammerPlatformIds.add(jammerNode.platformId)
      upsertBeam(jammerNode, targetNode, effectiveLoss, null)
    }
  }

  return {
    activeJammerPlatformIds,
    beams: [...beamMap.values()],
  }
}

const EARTH_RADIUS_METERS = 6_371_000
const JAMMER_PLATFORM_CATEGORIES = new Set(['GROUND_JAMMER_DETECTION_STATION', 'AIRBORNE_JAMMER_PLATFORM'])
const JAMMER_TARGET_CATEGORIES = new Set([
  'AIRBORNE_MISSION_CLUSTER',
  'FORWARD_RELAY_NODE',
  'GROUND_CLUSTER_COMMAND_NODE',
  'REAR_COMMAND_NODE',
])

/** 按与 Leaflet CRS.Earth 一致的球面半径计算两点间水平距离（米）。 */
export function haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)))
}

function isReleaseJammingEvent(event: EngineFrameEvent): boolean {
  const raw = (event.type ?? '').toLowerCase()
  return raw.includes('release_jamm') || raw === 'jam_off'
}

function isIntoJammingEvent(event: EngineFrameEvent): boolean {
  const raw = (event.type ?? '').toLowerCase()
  return raw.includes('into_jamm') || raw === 'jam_on'
}

function isReleaseDetectEvent(event: EngineFrameEvent): boolean {
  const raw = (event.type ?? '').toLowerCase()
  return raw.includes('release_detect')
}

function isIntoDetectEvent(event: EngineFrameEvent): boolean {
  const raw = (event.type ?? '').toLowerCase()
  return (raw.includes('into_detect') || raw.includes('esm')) && !raw.includes('release')
}

function eventMatchesJammer(
  event: EngineFrameEvent,
  nodes: readonly SituationMapNode[],
  platformId: string,
): boolean {
  for (let i = 0; i < Math.max(event.jammerIds.length, event.jammerNames.length); i += 1) {
    const resolved = resolveNode(nodes, event.jammerIds[i], event.jammerNames[i])
    if (resolved?.platformId === platformId) return true
    if (event.jammerIds[i] === platformId || event.jammerNames[i] === platformId) return true
  }
  return false
}

/**
 * 综合引擎干扰帧、文件设备状态与当前地图几何范围，计算每台干扰机的态势状态：
 * - 目标进入干扰范围内（或引擎开启压制）→ 「开启压制」
 * - 曾开启压制且目标离开干扰范围（或收到停扰事件）→ 「关闭压制」
 * - 目标进入探测范围且未进入干扰范围 → 「侦测中」
 */
export function resolveJammerVisualStates(
  nodes: readonly SituationMapNode[],
  interferenceRanges: readonly InterferenceRange[],
  detectionRanges: readonly DetectionRange[],
  engineFrame?: EngineFrameSnapshot | null,
  fileDeviceStates: readonly FileDeviceEvent[] = [],
  memory?: JammerVisualMemory,
): Map<string, JammerVisualStatus> {
  const result = new Map<string, JammerVisualStatus>()
  if (nodes.length === 0) return result

  const overlay = extractActiveJammingOverlay(engineFrame, nodes)
  const nodeById = new Map(nodes.map(node => [node.platformId, node]))

  const jammingRadiusByPlatform = new Map<string, number>()
  for (const range of interferenceRanges) {
    if (!Number.isFinite(range.radiusMeters) || range.radiusMeters <= 0) continue
    const prev = jammingRadiusByPlatform.get(range.platformId) ?? 0
    if (range.radiusMeters > prev) jammingRadiusByPlatform.set(range.platformId, range.radiusMeters)
  }

  const detectionRadiusByPlatform = new Map<string, number>()
  for (const range of detectionRanges) {
    if (!Number.isFinite(range.radiusMeters) || range.radiusMeters <= 0) continue
    const prev = detectionRadiusByPlatform.get(range.platformId) ?? 0
    if (range.radiusMeters > prev) detectionRadiusByPlatform.set(range.platformId, range.radiusMeters)
  }

  const engineJammerByPlatform = new Map<string, EngineJammer>()
  for (const jammer of engineFrame?.jammers ?? []) {
    const resolved = resolveNode(nodes, jammer.platformId, jammer.name)
    if (resolved) engineJammerByPlatform.set(resolved.platformId, jammer)
  }

  const jammerPlatformIds = new Set<string>()
  for (const node of nodes) {
    const category = nodeCategory(node)
    if (category && JAMMER_PLATFORM_CATEGORIES.has(category)) jammerPlatformIds.add(node.platformId)
  }
  for (const platformId of jammingRadiusByPlatform.keys()) jammerPlatformIds.add(platformId)
  for (const platformId of detectionRadiusByPlatform.keys()) jammerPlatformIds.add(platformId)
  for (const platformId of engineJammerByPlatform.keys()) jammerPlatformIds.add(platformId)
  for (const platformId of overlay.activeJammerPlatformIds) jammerPlatformIds.add(platformId)

  const targets = nodes.filter(node => {
    const category = nodeCategory(node)
    return category !== undefined && JAMMER_TARGET_CATEGORIES.has(category)
      && Number.isFinite(node.latitude) && Number.isFinite(node.longitude)
  })

  for (const platformId of jammerPlatformIds) {
    const jammerNode = nodeById.get(platformId)
    if (!jammerNode || !Number.isFinite(jammerNode.latitude) || !Number.isFinite(jammerNode.longitude)) continue

    const jamRadius = jammingRadiusByPlatform.get(platformId) ?? 0
    const detectRadius = detectionRadiusByPlatform.get(platformId) ?? 0
    let geoInJamming = false
    let geoInDetection = false
    if (jamRadius > 0 || detectRadius > 0) {
      for (const target of targets) {
        if (target.platformId === platformId) continue
        const distance = haversineDistanceMeters(jammerNode.latitude, jammerNode.longitude, target.latitude, target.longitude)
        if (jamRadius > 0 && distance <= jamRadius) geoInJamming = true
        if (detectRadius > 0 && distance <= detectRadius) geoInDetection = true
        if (geoInJamming && geoInDetection) break
      }
    }

    const engineJammer = engineJammerByPlatform.get(platformId)
    const jammerEvents = (engineFrame?.events ?? []).filter(event => eventMatchesJammer(event, nodes, platformId))
    const hasIntoJammEvent = jammerEvents.some(isIntoJammingEvent)
    const hasReleaseJammEvent = jammerEvents.some(isReleaseJammingEvent)
    const hasIntoDetectEvent = jammerEvents.some(isIntoDetectEvent)
    const hasReleaseDetectEvent = jammerEvents.some(isReleaseDetectEvent)

    const hasJamOnAction = engineJammer?.actions.some(action => {
      const code = action.action?.toUpperCase()
      return code === 'JAM_ON' || code === 'START'
    }) ?? false
    const hasJamOffAction = !hasJamOnAction && (engineJammer?.actions.some(action => {
      const code = action.action?.toUpperCase()
      return code === 'JAM_OFF' || code === 'STOP'
    }) ?? false)

    const engineJamming = overlay.activeJammerPlatformIds.has(platformId) || (hasIntoJammEvent && !hasReleaseJammEvent)
    const engineTurnedOffEvent = !engineJamming && (hasReleaseJammEvent || hasJamOffAction)
    const engineBlockedJamming = !engineJamming && (engineJammer?.deviceStatus === 'OFF' || engineTurnedOffEvent)

    const jammerStillDetecting = engineJammer ? isJammerDetecting(engineJammer) : false
    const engineDetectExplicitOff = engineJammer?.detectStatus === 'OFF'
      || (hasReleaseDetectEvent && !hasIntoDetectEvent && !jammerStillDetecting)
    const engineDetecting = !engineDetectExplicitOff && (jammerStillDetecting || hasIntoDetectEvent)

    const fileStates = fileDeviceStates.filter(state => state.platformId === platformId && state.kind === 'JAMMING')
    const fileJammingOn = fileStates.some(state => state.active)
    const fileJammingOff = !fileJammingOn && fileStates.some(state => !state.active)

    const isJammingNow = !engineBlockedJamming && (engineJamming || geoInJamming || fileJammingOn)
    const isDetectingNow = !engineDetectExplicitOff && (engineDetecting || geoInDetection)

    let state: JammerVisualState
    if (isJammingNow) {
      memory?.hadJamming.add(platformId)
      state = 'JAMMING'
    } else if (memory?.hadJamming.has(platformId) || engineTurnedOffEvent || fileJammingOff) {
      const enteredDetectionFreshly = isDetectingNow && !(memory?.hadDetectionTarget.has(platformId) ?? false)
      if (enteredDetectionFreshly && !engineTurnedOffEvent && !fileJammingOff) {
        memory?.hadJamming.delete(platformId)
        state = 'DETECTING'
      } else {
        state = 'JAMMING_OFF'
      }
    } else if (isDetectingNow) {
      state = 'DETECTING'
    } else {
      state = 'IDLE'
    }

    if (memory) {
      if (isDetectingNow) memory.hadDetectionTarget.add(platformId)
      else memory.hadDetectionTarget.delete(platformId)
    }

    result.set(platformId, {
      platformId,
      state,
      label: JAMMER_VISUAL_LABELS[state],
    })
  }

  return result
}

export const ENGINE_SWITCH_REASON_LABELS: Readonly<Record<string, string>> = {
  beyond_weitch: '超视距切换',
  bey_switch: '超视距切换',
  ber_switch: '链路劣化切换',
  alarm_switch: '链路告警切换',
  into_detect: '进入探测圈',
  into_jamm: '进入干扰圈',
  release_detect: '离开探测圈',
  release_jamm: '离开干扰圈',
  esm_info: '敌方探测消息',
}

export function formatEngineSwitchReason(reason: string): string {
  return ENGINE_SWITCH_REASON_LABELS[reason] ?? reason
}

function formatThresholdSci(value: number): string {
  if (!Number.isFinite(value)) return ''
  if (value === 0) return '0'
  if (Math.abs(value) >= 1e-3 && Math.abs(value) < 1e4) return String(Number(value.toPrecision(3)))
  const exp = value.toExponential(1).replace(/\.0e/u, 'e').replace(/e\+/u, 'e').replace(/e(-?)0+(\d)/u, 'e$1$2')
  return exp
}

type TrafficDistanceRole = 'relay' | 'command' | 'uav' | 'other'

function resolveTrafficDistanceRole(
  nodes: readonly Pick<SituationMapNode, 'platformId' | 'name' | 'type'>[],
  platformId: string | null | undefined,
  engineName: string | null | undefined,
): TrafficDistanceRole {
  const matched = nodes.find(node => (platformId && node.platformId === platformId) || (engineName && node.platformId === engineName))
  const type = matched?.type
  if (type === 'FORWARD_RELAY_NODE') return 'relay'
  if (type === 'GROUND_CLUSTER_COMMAND_NODE' || type === 'REAR_COMMAND_NODE') return 'command'
  if (type === 'AIRBORNE_MISSION_CLUSTER') return 'uav'
  const raw = `${platformId ?? ''} ${engineName ?? ''}`.toLowerCase()
  if (raw.includes('command_vehicle') || raw.includes('rear_comm')) return 'command'
  if (raw.includes('mission_uav_01') || raw.includes('relay')) return 'relay'
  if (raw.includes('mission_uav')) return 'uav'
  return 'other'
}

/** 对应 1112 模板 link_calc 的 traffic_distance 距离上限（km）。 */
export function resolveSegmentDistanceLimitKm(
  segment: Pick<EngineLinkSegment, 'sourcePort' | 'targetPort' | 'sourcePlatformId' | 'targetPlatformId' | 'sourceName' | 'targetName'>,
  nodes: readonly Pick<SituationMapNode, 'platformId' | 'name' | 'type'>[],
): number | null {
  const port = (segment.sourcePort ?? segment.targetPort ?? '').toLowerCase()
  if (!port) return null
  if (port.includes('microwave')) return 200
  if (port.includes('lazer') || port.includes('laser')) return 40
  if (port.includes('c_band') || port.includes('l_band')) {
    const a = resolveTrafficDistanceRole(nodes, segment.sourcePlatformId, segment.sourceName)
    const b = resolveTrafficDistanceRole(nodes, segment.targetPlatformId, segment.targetName)
    if ((a === 'relay' && b === 'uav') || (a === 'uav' && b === 'relay')) return 60
    if (a === 'relay' && b === 'relay') return 200
    if ((a === 'relay' && b === 'command') || (a === 'command' && b === 'relay')) return 240
    if ((a === 'uav' && b === 'command') || (a === 'command' && b === 'uav')) return 240
    return 240
  }
  return null
}

/** EngineLinkSegment 只保存 distanceM（米）；这里换算为公里，非有效数字或小于 0 时返回 null。 */
function segmentDistanceKm(seg: Pick<EngineLinkSegment, 'distanceM'>): number | null {
  const m = seg.distanceM
  return typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m / 1000 : null
}

function findOldRouteCandidateSegments(
  route: EngineRouteSwitch | null | undefined,
  frameLinks: readonly EngineLinkSegment[],
): EngineLinkSegment[] {
  if (!route || route.oldNodes.length < 2 || !frameLinks.length) return []
  const candidates: EngineLinkSegment[] = []
  for (let i = 0; i < route.oldNodes.length - 1; i += 1) {
    const a = route.oldNodes[i]!
    const b = route.oldNodes[i + 1]!
    const port = a.outPort || b.inPort
    const matched = frameLinks.find(seg => {
      const sameSource = (a.platformId && seg.sourcePlatformId === a.platformId) || (a.platformName && seg.sourceName === a.platformName)
      const sameTarget = (b.platformId && seg.targetPlatformId === b.platformId) || (b.platformName && seg.targetName === b.platformName)
      const samePort = !port || seg.sourcePort === port || seg.targetPort === port
      return Boolean(sameSource && sameTarget && samePort)
    })
    if (matched) candidates.push(matched)
  }
  return candidates
}

function findTriggerSegment(
  reasonCode: string,
  linkId: string | null | undefined,
  route: EngineRouteSwitch | null | undefined,
  frameLinks: readonly EngineLinkSegment[],
  nodes: readonly Pick<SituationMapNode, 'platformId' | 'name' | 'type'>[],
): EngineLinkSegment | undefined {
  if (linkId) {
    const exact = frameLinks.find(seg => seg.linkId === linkId || seg.linkIds.includes(linkId))
    if (exact) return exact
  }
  const oldSegments = findOldRouteCandidateSegments(route, frameLinks)
  if (!oldSegments.length) return undefined
  if (reasonCode === 'bey_switch' || reasonCode === 'beyond_weitch') {
    const exceeded = oldSegments.find(seg => {
      const limit = resolveSegmentDistanceLimitKm(seg, nodes)
      const km = segmentDistanceKm(seg)
      return limit !== null && km !== null && km >= limit
    })
    return exceeded ?? [...oldSegments].sort((l, r) => (segmentDistanceKm(r) ?? -1) - (segmentDistanceKm(l) ?? -1))[0]
  }
  if (reasonCode === 'ber_switch' || reasonCode === 'alarm_switch') {
    return [...oldSegments].sort((l, r) => {
      const lScore = (l.quality.ber ?? -1) * 1e6 + (l.losses.jammingDb ?? 0)
      const rScore = (r.quality.ber ?? -1) * 1e6 + (r.losses.jammingDb ?? 0)
      return rScore - lScore
    })[0]
  }
  return oldSegments[0]
}

/** 从旧路径跳点直接推导无线跳的端口名与最大通信距离上限（即使当前帧缺少旧链路段实测也能定位具体体制上限）。 */
function resolveOldRouteDistanceInfo(
  route: EngineRouteSwitch | null | undefined,
  nodes: readonly Pick<SituationMapNode, 'platformId' | 'name' | 'type'>[],
): { portLabel: string; limitKm: number } | null {
  if (!route || route.oldNodes.length < 2) return null
  let best: { portLabel: string; limitKm: number } | null = null
  for (let i = 0; i < route.oldNodes.length - 1; i += 1) {
    const a = route.oldNodes[i]!
    const b = route.oldNodes[i + 1]!
    const port = a.outPort || b.inPort
    if (!port || port.toLowerCase().includes('fiber')) continue
    const limitKm = resolveSegmentDistanceLimitKm({
      sourcePort: port,
      targetPort: b.inPort || port,
      sourcePlatformId: a.platformId,
      targetPlatformId: b.platformId,
      sourceName: a.platformName,
      targetName: b.platformName,
    }, nodes)
    if (limitKm !== null && (!best || limitKm < best.limitKm)) {
      best = { portLabel: formatCommunicationPortLabel(port), limitKm }
    }
  }
  return best
}

function segmentPortPrefix(segment: EngineLinkSegment | undefined, route: EngineRouteSwitch | null | undefined): string {
  const port = segment?.sourcePort ?? segment?.targetPort
  if (port && !port.toLowerCase().includes('fiber')) return formatCommunicationPortLabel(port)
  if (route?.oldNodes.length) {
    const oldPort = route.oldNodes.map(node => node.outPort || node.inPort).find(p => p && !p.toLowerCase().includes('fiber'))
    if (oldPort) return formatCommunicationPortLabel(oldPort)
  }
  return ''
}

/** 根据引擎切换原因码、同帧链路实测值和场景配置门限，生成通俗易懂的「触发阈值依据」。 */
export function describeSwitchReasonThreshold(
  reasonCode: string,
  linkId: string | null | undefined,
  route: EngineRouteSwitch | null | undefined,
  frameLinks: readonly EngineLinkSegment[],
  nodes: readonly Pick<SituationMapNode, 'platformId' | 'name' | 'type'>[],
  thresholds?: LinkCalcThresholds,
  alarms?: readonly EngineRouteAlarm[],
): string | null {
  const emergency = thresholds?.emergencyThreshold ?? LINK_CALC_DEFAULTS.emergencyThreshold
  const warning = thresholds?.warningThreshold ?? LINK_CALC_DEFAULTS.warningThreshold
  const base = thresholds?.valueThresholdBer ?? LINK_CALC_DEFAULTS.valueThresholdBer
  const segment = findTriggerSegment(reasonCode, linkId, route, frameLinks, nodes)
  const portPrefix = segmentPortPrefix(segment, route)

  if (reasonCode === 'bey_switch' || reasonCode === 'beyond_weitch') {
    const segLimitKm = segment ? resolveSegmentDistanceLimitKm(segment, nodes) : null
    const oldInfo = segLimitKm === null ? resolveOldRouteDistanceInfo(route, nodes) : null
    const limitKm = segLimitKm ?? oldInfo?.limitKm ?? null
    const label = portPrefix || oldInfo?.portLabel || ''
    const dist = segment ? segmentDistanceKm(segment) : null
    if (typeof dist === 'number' && Number.isFinite(dist) && limitKm !== null) {
      const target = label ? `${label} ` : ''
      return dist >= limitKm
        ? `超视距 · ${target}${dist.toFixed(1)} > ${limitKm} km`
        : `超视距 · ${target}${dist.toFixed(1)} km（上限 ${limitKm} km）`
    }
    if (limitKm !== null) return `超视距 · ${label ? `${label} ` : ''}> ${limitKm} km`
    if (typeof dist === 'number' && Number.isFinite(dist)) return `超视距 · ${label ? `${label} ` : ''}${dist.toFixed(1)} km 超限`
    return '超视距 · 超出最大通信距离'
  }

  if (reasonCode === 'ber_switch') {
    const ber = segment?.quality.ber
    const jamLoss = segment?.losses.jammingDb
    const jamSuffix = typeof jamLoss === 'number' && Number.isFinite(jamLoss) && jamLoss > 0
      ? ` · 干扰 ${jamLoss.toFixed(1)} dB`
      : ''
    if (typeof ber === 'number' && Number.isFinite(ber) && ber >= 0) {
      if (ber >= emergency) return `误码 ${formatThresholdSci(ber)} ≥ 中断 ${formatThresholdSci(emergency)}${jamSuffix}`
      if (ber >= warning) return `误码 ${formatThresholdSci(ber)} ≥ 劣化 ${formatThresholdSci(warning)}${jamSuffix}`
      if (ber >= base) return `误码 ${formatThresholdSci(ber)} ≥ 质量 ${formatThresholdSci(base)}${jamSuffix}`
      return `误码 ${formatThresholdSci(ber)} · 劣化 ${formatThresholdSci(warning)} / 中断 ${formatThresholdSci(emergency)}${jamSuffix}`
    }
    return `误码超标 · 劣化 ${formatThresholdSci(warning)} / 中断 ${formatThresholdSci(emergency)}`
  }

  if (reasonCode === 'alarm_switch') {
    const ber = segment?.quality.ber
    const jamLoss = segment?.losses.jammingDb
    const jamSuffix = typeof jamLoss === 'number' && Number.isFinite(jamLoss) && jamLoss > 0
      ? ` · 干扰 ${jamLoss.toFixed(1)} dB`
      : ''
    if (typeof ber === 'number' && Number.isFinite(ber) && ber >= emergency) {
      return `误码 ${formatThresholdSci(ber)} ≥ 中断 ${formatThresholdSci(emergency)}${jamSuffix}`
    }
    if (typeof ber === 'number' && Number.isFinite(ber) && ber >= warning) {
      return `误码 ${formatThresholdSci(ber)} ≥ 劣化 ${formatThresholdSci(warning)}${jamSuffix}`
    }
    if (typeof jamLoss === 'number' && Number.isFinite(jamLoss) && jamLoss > 0) {
      return `电磁干扰 ${jamLoss.toFixed(1)} dB · 劣化 ${formatThresholdSci(warning)}`
    }
    const matchedAlarm = alarms?.find(alarm => (linkId && alarm.linkId === linkId)
      || (route?.oldPathId && alarm.pathId === route.oldPathId)
      || (route?.pathId && alarm.pathId === route.pathId))
    if (matchedAlarm?.message?.trim()) {
      return `${matchedAlarm.message.trim()} · 劣化 ${formatThresholdSci(warning)}`
    }
    return `质量告警 · 劣化 ${formatThresholdSci(warning)} / 中断 ${formatThresholdSci(emergency)}`
  }

  return null
}

/** 汇总一条路由切换记录中各原因触发的阈值说明（去重）；当 reason 为空时回退同帧切换事件与旧路径实测指标。 */
export function summarizeSwitchThresholdEvidence(
  route: EngineRouteSwitch,
  frameLinks: readonly EngineLinkSegment[],
  nodes: readonly Pick<SituationMapNode, 'platformId' | 'name' | 'type'>[],
  thresholds?: LinkCalcThresholds,
  alarms?: readonly EngineRouteAlarm[],
  events?: readonly EngineFrameEvent[],
): string[] {
  const details: string[] = []
  for (const item of route.reasons) {
    for (const code of item.reasons) {
      if (!code) continue
      const text = describeSwitchReasonThreshold(code, item.linkId, route, frameLinks, nodes, thresholds, alarms)
      if (text && !details.includes(text)) details.push(text)
    }
  }
  if (details.length > 0) return details

  // 引擎某些帧的 reason_chenge[].reason 为空数组时，回退同帧 events 的切换类型。
  const matchingEvents = (events ?? []).filter(event => {
    const raw = (event.type ?? '').toLowerCase()
    if (!raw.includes('switch')) return false
    return !event.pathId || event.pathId === route.pathId || event.pathId === route.oldPathId
  })
  const firstLinkId = route.reasons.find(item => item.linkId)?.linkId ?? null
  for (const event of matchingEvents) {
    if (!event.type) continue
    const text = describeSwitchReasonThreshold(event.type, firstLinkId, route, frameLinks, nodes, thresholds, alarms)
    if (text && !details.includes(text)) details.push(text)
  }
  if (details.length > 0) return details

  // 若仍无原因码，检查旧路径或 linkId 对应链路的超视距 / 误码 / 干扰实测。
  const candidate = (firstLinkId ? frameLinks.find(seg => seg.linkId === firstLinkId || seg.linkIds.includes(firstLinkId)) : undefined)
    ?? findOldRouteCandidateSegments(route, frameLinks)[0]
  if (candidate) {
    const portLabel = segmentPortPrefix(candidate, route)
    const limitKm = resolveSegmentDistanceLimitKm(candidate, nodes)
    const candidateKm = segmentDistanceKm(candidate)
    if (limitKm !== null && candidateKm !== null && candidateKm >= limitKm) {
      details.push(`超视距 · ${portLabel ? `${portLabel} ` : ''}${candidateKm.toFixed(1)} > ${limitKm} km`)
    } else {
      const emergency = thresholds?.emergencyThreshold ?? LINK_CALC_DEFAULTS.emergencyThreshold
      const warning = thresholds?.warningThreshold ?? LINK_CALC_DEFAULTS.warningThreshold
      const ber = candidate.quality.ber
      const jamLoss = candidate.losses.jammingDb
      if (typeof ber === 'number' && Number.isFinite(ber) && ber >= warning) {
        const label = ber >= emergency ? `中断 ${formatThresholdSci(emergency)}` : `劣化 ${formatThresholdSci(warning)}`
        const jam = typeof jamLoss === 'number' && Number.isFinite(jamLoss) && jamLoss > 0 ? ` · 干扰 ${jamLoss.toFixed(1)} dB` : ''
        details.push(`误码 ${formatThresholdSci(ber)} ≥ ${label}${jam}`)
      } else if (typeof jamLoss === 'number' && Number.isFinite(jamLoss) && jamLoss > 0) {
        details.push(`电磁干扰 ${jamLoss.toFixed(1)} dB · 劣化 ${formatThresholdSci(warning)}`)
      }
    }
  }
  return details
}

/** 提取路径里的核心通信方式（有无线链路时省略地面固定光纤，避免「C 波段 / 光纤 → 微波 / C 波段 / 光纤」冗余）。 */
function summarizePathPorts(pathNodes: EngineRouteSwitch['nodes']): string {
  const ports = [...new Set(pathNodes.map(node => node.outPort || node.inPort).filter((port): port is string => Boolean(port)))]
  if (!ports.length) return ''
  const wireless = ports.filter(port => !port.toLowerCase().includes('fiber'))
  return (wireless.length ? wireless : ports).map(formatCommunicationPortLabel).join(' / ')
}

function summarizeSwitchRoute(
  route: EngineRouteSwitch,
  nodes: readonly SituationMapNode[],
  frameLinks: readonly EngineLinkSegment[],
  thresholds?: LinkCalcThresholds,
  alarms?: readonly EngineRouteAlarm[],
  events?: readonly EngineFrameEvent[],
): { summary: string; detail: string; threshold?: string; thresholds?: string[] } {
  const toLabel = summarizePathPorts(route.nodes) || '新路径'
  const fromLabel = summarizePathPorts(route.oldNodes)
  const pathNames = route.nodes.map(node => formatNodeName(nodes, node.platformId, node.platformName))
  const reasonText = route.reasons.flatMap(item => item.reasons).filter(Boolean).map(formatEngineSwitchReason)
  if (!reasonText.length && events?.length) {
    for (const event of events) {
      if (event.type && event.type.toLowerCase().includes('switch')) reasonText.push(formatEngineSwitchReason(event.type))
    }
  }
  const thresholdEvidence = summarizeSwitchThresholdEvidence(route, frameLinks, nodes, thresholds, alarms, events)
  const summary = fromLabel && fromLabel !== toLabel
    ? `${fromLabel} → ${toLabel}`
    : `切至 ${toLabel}`
  const parts: string[] = []
  if (pathNames.length >= 2) parts.push(`新路径：${pathNames.join(' → ')}`)
  if (!thresholdEvidence.length && reasonText.length) parts.push([...new Set(reasonText)].join('、'))
  const threshold = thresholdEvidence.length ? thresholdEvidence.join('；') : undefined
  return {
    summary,
    detail: parts.join(' · '),
    threshold,
    thresholds: thresholdEvidence.length ? thresholdEvidence : undefined,
  }
}

function classifyEventType(event: EngineFrameEvent): MapStoryKind | null {
  const raw = (event.type ?? '').toLowerCase()
  if (!raw) return null
  if (raw.includes('switch')) return 'SWITCH'
  if (isReleaseJammingEvent(event)) return 'JAM_OFF'
  if (isReleaseDetectEvent(event)) return null
  if (raw.includes('jamm') || raw.includes('alarm')) return 'JAMMED'
  if (raw.includes('esm') || raw.includes('detect')) return 'DETECT'
  return null
}

export interface SwitchFrameEvidence {
  links: readonly EngineLinkSegment[]
  alarms?: readonly EngineRouteAlarm[]
  events?: readonly EngineFrameEvent[]
}

const MAX_INLINE_STORY_TARGETS = 6

const UAV_STORY_CATEGORIES = new Set(['AIRBORNE_MISSION_CLUSTER', 'FORWARD_RELAY_NODE'])

function isUavTargetNode(
  nodes: readonly SituationMapNode[],
  platformId: string | null | undefined,
  fallbackName?: string | null,
): boolean {
  const matched = resolveNode(nodes, platformId, fallbackName)
  if (matched) {
    const category = nodeCategory(matched)
    if (category) return UAV_STORY_CATEGORIES.has(category)
  }
  const text = `${platformId ?? ''} ${fallbackName ?? ''}`
  return /uav|无人机/iu.test(text)
}

function formatTargetGroupUnit(
  nodes: readonly SituationMapNode[],
  targets: ReadonlyArray<{ platformId: string | null | undefined; fallbackName?: string | null }>,
): string {
  return targets.length > 0 && targets.every(item => isUavTargetNode(nodes, item.platformId, item.fallbackName))
    ? '架无人机'
    : '个目标'
}

function collectUniqueStoryTargets(
  nodes: readonly SituationMapNode[],
  entries: ReadonlyArray<{ platformId?: string | null; fallbackName?: string | null }>,
): Array<{ key: string; platformId?: string; name: string; isUav: boolean }> {
  const byKey = new Map<string, { key: string; platformId?: string; name: string; isUav: boolean }>()
  for (const entry of entries) {
    const matched = resolveNode(nodes, entry.platformId, entry.fallbackName)
    const platformId = matched?.platformId ?? entry.platformId ?? undefined
    const name = matched?.name ?? entry.fallbackName ?? entry.platformId ?? ''
    if (!name) continue
    const key = platformId ?? name
    if (byKey.has(key)) continue
    byKey.set(key, {
      key,
      platformId,
      name,
      isUav: isUavTargetNode(nodes, platformId, name),
    })
  }
  return [...byKey.values()]
}

function formatTruncatedList(items: readonly string[], separator: string, totalCount = items.length): string {
  if (items.length <= MAX_INLINE_STORY_TARGETS) return items.join(separator)
  return `${items.slice(0, MAX_INLINE_STORY_TARGETS).join(separator)} 等共 ${totalCount} 项`
}

function segmentStatusRank(status: EngineLinkSegment['status']): number {
  if (status === 'DOWN') return 3
  if (status === 'DEGRADED') return 2
  if (status === 'UP') return 1
  return 0
}

function isPureQualitySwitch(route: EngineRouteSwitch): boolean {
  const reasons = route.reasons.flatMap(item => item.reasons).map(reason => reason.toLowerCase())
  if (reasons.length === 0) return false
  const hasDistanceReason = reasons.some(reason => reason.includes('bey') || reason.includes('beyond'))
  const hasQualityReason = reasons.some(reason => reason.includes('ber') || reason.includes('alarm') || reason.includes('jamm'))
  return hasQualityReason && !hasDistanceReason
}

/** 判断引擎当前帧是否仍处于干扰受扰、压制或侦测活跃期内。 */
export function hasActiveFrameInterferenceOrDetection(frame: EngineFrameSnapshot | null | undefined): boolean {
  if (!frame) return false
  if (frame.routing.alarms.length > 0) return true
  if (frame.links.some(segment => (typeof segment.losses.jammingDb === 'number' && Number.isFinite(segment.losses.jammingDb) && segment.losses.jammingDb > 0)
    || ((segment.status === 'DEGRADED' || segment.status === 'DOWN') && segment.inputTrace.jammers.length > 0))) return true
  if (frame.jammers.some(jammer => isJammerActivelySuppressing(jammer) || isJammerDetecting(jammer))) return true
  return frame.events.some(event => {
    const kind = classifyEventType(event)
    return kind === 'JAMMED' || kind === 'DETECT'
  })
}

export function switchEntryKey(entry: Pick<EngineSwitchEntry, 'frameId' | 'route'>): string {
  return `${entry.frameId}:${entry.route.pathId}`
}

/**
 * 从历史切链记录中提取截至当前时刻且属于最近同一批切换的条目（相邻间隔 ≤ SWITCH_BATCH_GAP_SECONDS），
 * 使编队内多架无人机在数秒内依次切链时能合并展示，同时排除已离圈关闭的旧批次。
 */
export function selectActiveSwitchBatch(
  switches: readonly EngineSwitchEntry[] | null | undefined,
  currentTime: number,
  retiredKeys?: ReadonlySet<string>,
): EngineSwitchEntry[] {
  if (!switches?.length) return []
  const eligible = switches
    .filter(entry => entry.simulationTime <= currentTime && !retiredKeys?.has(switchEntryKey(entry)))
    .sort((left, right) => left.simulationTime - right.simulationTime)
  if (!eligible.length) return []
  const batch: EngineSwitchEntry[] = [eligible[eligible.length - 1]!]
  for (let index = eligible.length - 2; index >= 0; index -= 1) {
    const candidate = eligible[index]!
    const nextInBatch = batch[0]!
    if (nextInBatch.simulationTime - candidate.simulationTime <= SWITCH_BATCH_GAP_SECONDS) {
      batch.unshift(candidate)
    } else {
      break
    }
  }
  return batch
}

function resolveSwitchEndpoint(
  route: EngineRouteSwitch,
  nodes: readonly SituationMapNode[],
): { platformId?: string; name: string; position: 'start' | 'end' } | null {
  const candidates: Array<{ platformId?: string | null; fallbackName?: string | null; position: 'start' | 'end' }> = [
    { platformId: route.sourcePlatformId ?? route.nodes[0]?.platformId, fallbackName: route.sourceName ?? route.nodes[0]?.platformName, position: 'start' },
    { platformId: route.targetPlatformId ?? route.nodes.at(-1)?.platformId, fallbackName: route.targetName ?? route.nodes.at(-1)?.platformName, position: 'end' },
  ]
  const pickByPredicate = (predicate: (platformId?: string | null, fallbackName?: string | null) => boolean) => {
    for (const candidate of candidates) {
      if (!candidate.platformId && !candidate.fallbackName) continue
      if (predicate(candidate.platformId, candidate.fallbackName)) {
        const matched = resolveNode(nodes, candidate.platformId, candidate.fallbackName)
        return {
          platformId: matched?.platformId ?? candidate.platformId ?? undefined,
          name: matched?.name ?? candidate.fallbackName ?? candidate.platformId ?? '',
          position: candidate.position,
        }
      }
    }
    return null
  }
  // 优先识别作业无人机端点，避免把前出中继或指挥车误当成编队成员
  return pickByPredicate((id, name) => nodeCategory(resolveNode(nodes, id, name) ?? { platformId: id ?? '', name: name ?? '' }) === 'AIRBORNE_MISSION_CLUSTER')
    ?? pickByPredicate((id, name) => isUavTargetNode(nodes, id, name))
    ?? pickByPredicate(() => true)
}

function formatBriefClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function summarizeSwitchBatch(
  entries: readonly EngineSwitchEntry[],
  currentFrame: EngineFrameSnapshot,
  nodes: readonly SituationMapNode[],
  thresholds?: LinkCalcThresholds,
  fallbackEvidence?: SwitchFrameEvidence | null,
  evidenceLookup?: ReadonlyMap<string, SwitchFrameEvidence> | null,
): {
  summary: string
  detail: string
  targets?: MapStoryTargetDetail[]
  threshold?: string
  thresholds?: string[]
  focusTarget?: SituationMapFocusTarget
  primary: EngineSwitchEntry
} {
  const primary = entries[entries.length - 1]!
  const getEvidence = (entry: EngineSwitchEntry) => {
    const sameFrame = entry.frameId === currentFrame.frameId
    const cached = evidenceLookup?.get(switchEntryKey(entry)) ?? (entry === primary ? fallbackEvidence : null)
    return {
      links: sameFrame ? currentFrame.links : (cached?.links ?? []),
      alarms: sameFrame ? currentFrame.routing.alarms : (cached?.alarms ?? []),
      events: sameFrame ? currentFrame.events : (cached?.events ?? []),
    }
  }

  const primaryEv = getEvidence(primary)
  const primarySummary = summarizeSwitchRoute(
    primary.route,
    nodes,
    primaryEv.links,
    thresholds,
    primaryEv.alarms,
    primaryEv.events,
  )
  const primaryTargetId = primary.route.targetPlatformId ?? primary.route.nodes.at(-1)?.platformId ?? undefined
  const focusTarget: SituationMapFocusTarget | undefined = primaryTargetId ? { kind: 'node', targetId: primaryTargetId } : undefined

  // 按「目标 + 方向（或 pathId）」逐条整理切链明细，每条链路各自携带自己的触发条件徽标（不混在一起汇总）
  const perRouteEntries = new Map<string, {
    entry: EngineSwitchEntry
    endpoint: ReturnType<typeof resolveSwitchEndpoint>
    summaryResult: ReturnType<typeof summarizeSwitchRoute>
  }>()
  for (const entry of entries) {
    const endpoint = resolveSwitchEndpoint(entry.route, nodes)
    const endpointKey = endpoint ? (endpoint.platformId ?? endpoint.name) : entry.route.pathId
    const routeKey = `${endpointKey}:${entry.route.direction}`
    const ev = getEvidence(entry)
    const summaryResult = entry === primary
      ? primarySummary
      : summarizeSwitchRoute(entry.route, nodes, ev.links, thresholds, ev.alarms, ev.events)
    perRouteEntries.set(routeKey, { entry, endpoint, summaryResult })
  }
  const routeDetails = [...perRouteEntries.values()].sort((left, right) => {
    const leftName = left.endpoint?.name ?? left.entry.route.pathId
    const rightName = right.endpoint?.name ?? right.entry.route.pathId
    const nameDiff = leftName.localeCompare(rightName, 'zh-CN', { numeric: true })
    if (nameDiff !== 0) return nameDiff
    if (left.entry.route.direction === right.entry.route.direction) return 0
    return left.entry.route.direction === 'FORWARD' ? -1 : 1
  })
  const hasMixedDirections = new Set(routeDetails.map(item => item.entry.route.direction)).size > 1
  const targets: MapStoryTargetDetail[] = routeDetails.map(({ entry, endpoint, summaryResult }) => {
    const pathText = entry.route.nodes
      .map(node => formatNodeName(nodes, node.platformId, node.platformName))
      .join(' → ')
    const directionLabel = entry.route.direction === 'FORWARD' ? '前向' : '返向'
    const timeLabel = formatBriefClock(entry.simulationTime)
    const badge = hasMixedDirections ? `${directionLabel} · ${timeLabel}` : timeLabel
    const focusNodeId = endpoint?.platformId ?? entry.route.targetPlatformId ?? entry.route.nodes.at(-1)?.platformId ?? undefined
    return {
      key: `${endpoint?.platformId ?? endpoint?.name ?? entry.route.pathId}:${entry.route.direction}`,
      name: endpoint?.name ?? summaryResult.summary,
      badge,
      meta: pathText || summaryResult.summary,
      thresholds: summaryResult.thresholds?.length ? summaryResult.thresholds : undefined,
      focusTarget: focusNodeId ? { kind: 'node', targetId: focusNodeId } : undefined,
    }
  })

  // 收集本批切链涉及的全部独立目标（去重正反向重复条目，按名称自然排序便于对照）
  const endpointEntries = entries
    .map(entry => ({ entry, endpoint: resolveSwitchEndpoint(entry.route, nodes) }))
    .filter((item): item is { entry: EngineSwitchEntry; endpoint: NonNullable<ReturnType<typeof resolveSwitchEndpoint>> } => item.endpoint !== null)
  const uniqueEndpoints = collectUniqueStoryTargets(
    nodes,
    endpointEntries.map(item => ({ platformId: item.endpoint.platformId, fallbackName: item.endpoint.name })),
  ).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }))

  // 合并同批所有切链的触发条件徽标（保留在 MapStoryItem.thresholds 上供测试/工具提示使用；UI 明细优先按链路逐条展示）
  const mergedThresholds: string[] = []
  const seenThresholds = new Set<string>()
  const addThreshold = (item: string) => {
    if (!item || seenThresholds.has(item)) return
    seenThresholds.add(item)
    mergedThresholds.push(item)
  }
  for (const badge of primarySummary.thresholds ?? []) addThreshold(badge)
  for (const item of routeDetails) {
    for (const badge of item.summaryResult.thresholds ?? []) addThreshold(badge)
  }

  if (uniqueEndpoints.length <= 1) {
    return {
      ...primarySummary,
      targets: targets.length > 1 || mergedThresholds.length > 0 ? targets : undefined,
      threshold: mergedThresholds.length ? mergedThresholds.join('；') : primarySummary.threshold,
      thresholds: mergedThresholds.length ? mergedThresholds : primarySummary.thresholds,
      focusTarget,
      primary,
    }
  }

  const unit = formatTargetGroupUnit(nodes, uniqueEndpoints.map(item => ({ platformId: item.platformId, fallbackName: item.name })))
  const summary = `${uniqueEndpoints.length} ${unit} · ${primarySummary.summary}`

  // 判断同向路径是否共享相同的中继/指挥链路段（如全部 UAV → 前出中继 → 指挥车 → 后方指挥节点）
  const primaryPathNames = primary.route.nodes.map(node => formatNodeName(nodes, node.platformId, node.platformName))
  const primaryEndpoint = resolveSwitchEndpoint(primary.route, nodes)
  const sameDirectionRoutes = entries
    .map(item => item.route)
    .filter(route => route.direction === primary.route.direction)
  const sharedOtherHops = (route: EngineRouteSwitch): string | null => {
    const names = route.nodes.map(node => formatNodeName(nodes, node.platformId, node.platformName))
    if (names.length < 2) return null
    return primaryEndpoint?.position === 'start'
      ? names.slice(1).join(' → ')
      : names.slice(0, -1).join(' → ')
  }
  const primarySharedHops = sharedOtherHops(primary.route)
  const allShareTopology = Boolean(primarySharedHops)
    && sameDirectionRoutes.length > 0
    && sameDirectionRoutes.every(route => sharedOtherHops(route) === primarySharedHops)

  // 主横幅保持恒定紧凑长度，无论 4 架还是 50 架均不撑爆地图；全部单机/单向路径及各自触发条件放入可滚动展开明细。
  let detail = ''
  if (allShareTopology && primarySharedHops) {
    detail = primaryEndpoint?.position === 'start'
      ? `新路径：${uniqueEndpoints.length} ${unit} → ${primarySharedHops}`
      : `新路径：${primarySharedHops} → ${uniqueEndpoints.length} ${unit}`
  } else if (primaryPathNames.length >= 2) {
    detail = `涉及 ${uniqueEndpoints.length} ${unit} · 代表路径：${primaryPathNames.join(' → ')}`
  } else {
    detail = `涉及 ${uniqueEndpoints.length} ${unit}`
  }

  return {
    summary,
    detail,
    targets,
    threshold: mergedThresholds.length ? mergedThresholds.join('；') : primarySummary.threshold,
    thresholds: mergedThresholds.length ? mergedThresholds : primarySummary.thresholds,
    focusTarget,
    primary,
  }
}

/**
 * 为地图内事件浮层提取当前帧的因果链条（侦测/开扰 → 链路受扰 → 路由切换），最多返回 2 条核心胶囊。
 * 传入 latestSwitch / recentSwitches 时，切链帧过去后在干扰/侦测活跃期内（或无干扰场景的短暂保留窗口 SWITCH_BANNER_RETENTION_SECONDS 内）
 * 继续展示最近同一批切换（汇总全部涉及无人机）及其触发条件，离开干扰/侦测圈或超出窗口后自动关闭。
 */
export function extractEngineMapStoryBanner(
  frame: EngineFrameSnapshot | null | undefined,
  nodes: readonly SituationMapNode[],
  configuredLinks?: readonly Link[],
  thresholds?: LinkCalcThresholds,
  latestSwitch?: EngineSwitchEntry | null,
  latestSwitchEvidence?: SwitchFrameEvidence | null,
  recentSwitches?: readonly EngineSwitchEntry[] | null,
  switchEvidenceLookup?: ReadonlyMap<string, SwitchFrameEvidence> | null,
): MapStoryItem[] {
  if (!frame) return []
  const items: MapStoryItem[] = []
  const timeS = frame.simulationTime

  // 1) 受扰/告警（链路出现干扰损耗或显式告警，或进入干扰事件）
  const jammedSegments = frame.links
    .filter(segment => (typeof segment.losses.jammingDb === 'number' && Number.isFinite(segment.losses.jammingDb) && segment.losses.jammingDb > 0)
      || ((segment.status === 'DEGRADED' || segment.status === 'DOWN') && segment.inputTrace.jammers.length > 0))
    .sort((left, right) => {
      const rankDiff = segmentStatusRank(right.status) - segmentStatusRank(left.status)
      if (rankDiff !== 0) return rankDiff
      return (right.losses.jammingDb ?? 0) - (left.losses.jammingDb ?? 0)
    })
  const alarm = frame.routing.alarms[0]
  const jamEvents = frame.events.filter(event => classifyEventType(event) === 'JAMMED')
  const jamEvent = jamEvents[0]
  const suppressingJammers = frame.jammers.filter(isJammerActivelySuppressing)
  const detectingJammers = frame.jammers.filter(isJammerDetecting)
  const detectEvents = frame.events.filter(event => classifyEventType(event) === 'DETECT')
  const hasActiveInterferenceOrDetection = jammedSegments.length > 0
    || Boolean(alarm)
    || jamEvents.length > 0
    || suppressingJammers.length > 0
    || detectingJammers.length > 0
    || detectEvents.length > 0

  if (alarm || jammedSegments.length > 0 || jamEvent) {
    const topSegment = jammedSegments[0]
    const targetLinkId = alarm?.linkId && configuredLinks?.some(link => link.id === alarm.linkId)
      ? alarm.linkId
      : topSegment?.linkIds.find(id => configuredLinks?.some(link => link.id === id))
    const targetNodeId = topSegment?.targetPlatformId ?? jamEvent?.uavIds[0] ?? undefined
    const focusTarget: SituationMapFocusTarget | undefined = targetLinkId
      ? { kind: 'link', targetId: targetLinkId }
      : targetNodeId ? { kind: 'node', targetId: targetNodeId } : undefined

    if (topSegment) {
      // 按目标节点去重汇总所有受扰链路，保留每个目标的最严重状态与最大干扰损耗
      const perTarget = new Map<string, {
        key: string
        platformId: string | null
        name: string
        status: EngineLinkSegment['status']
        lossDb: number | null
        portLabel: string
        linkId?: string
      }>()
      for (const segment of jammedSegments) {
        const matched = resolveNode(nodes, segment.targetPlatformId, segment.targetName)
        const key = matched?.platformId ?? segment.targetPlatformId ?? segment.targetName ?? segment.linkId
        const name = formatNodeName(nodes, segment.targetPlatformId, segment.targetName)
        const portLabel = formatCommunicationPortLabel(segment.sourcePort ?? segment.targetPort ?? '')
        const lossDb = typeof segment.losses.jammingDb === 'number' && Number.isFinite(segment.losses.jammingDb) && segment.losses.jammingDb > 0
          ? segment.losses.jammingDb
          : null
        const matchedLinkId = segment.linkIds.find(id => configuredLinks?.some(link => link.id === id))
        const prev = perTarget.get(key)
        if (!prev
          || segmentStatusRank(segment.status) > segmentStatusRank(prev.status)
          || (segmentStatusRank(segment.status) === segmentStatusRank(prev.status) && (lossDb ?? 0) > (prev.lossDb ?? 0))) {
          perTarget.set(key, {
            key,
            platformId: matched?.platformId ?? segment.targetPlatformId ?? null,
            name,
            status: segment.status,
            lossDb,
            portLabel: portLabel || prev?.portLabel || '',
            linkId: matchedLinkId ?? prev?.linkId,
          })
        }
      }
      const targetEntries = [...perTarget.values()]
      if (targetEntries.length <= 1) {
        const entry = targetEntries[0]!
        const lossText = entry.lossDb !== null ? `干扰损耗 ${entry.lossDb.toFixed(1)} dB` : ''
        const statusText = entry.status === 'DOWN' ? '中断' : entry.status === 'DEGRADED' ? '劣化' : '受扰'
        items.push({
          id: `jammed:${frame.frameId}:${topSegment.linkId}`,
          kind: 'JAMMED',
          timeS,
          tag: entry.status === 'DOWN' ? '受扰中断' : '链路受扰',
          summary: `${entry.portLabel || '通信链路'} → ${entry.name} ${statusText}`,
          detail: [lossText, alarm?.message ?? ''].filter(Boolean).join(' · ') || '检测到电磁压制',
          focusTarget,
        })
      } else {
        const portLabels = [...new Set(targetEntries.map(item => item.portLabel).filter(Boolean))]
        const portPrefix = portLabels.length ? portLabels.join(' / ') : '通信链路'
        const downCount = targetEntries.filter(item => item.status === 'DOWN').length
        const degradedCount = targetEntries.filter(item => item.status === 'DEGRADED').length
        const unit = formatTargetGroupUnit(nodes, targetEntries.map(item => ({ platformId: item.platformId, fallbackName: item.name })))
        const statusPhrase = downCount === targetEntries.length
          ? '中断'
          : downCount > 0
            ? `受扰（${downCount} 中断）`
            : degradedCount === targetEntries.length
              ? '劣化'
              : degradedCount > 0
                ? `受扰（${degradedCount} 劣化）`
                : '受扰'
        const losses = targetEntries.map(item => item.lossDb).filter((value): value is number => value !== null)
        let lossSummary = ''
        if (losses.length > 0) {
          const minLoss = Math.min(...losses)
          const maxLoss = Math.max(...losses)
          lossSummary = maxLoss - minLoss >= 0.05
            ? `干扰损耗 ${minLoss.toFixed(1)}~${maxLoss.toFixed(1)} dB`
            : `干扰损耗 ${maxLoss.toFixed(1)} dB`
        }
        const detailText = [lossSummary, alarm?.message ?? ''].filter(Boolean).join(' · ')
        const targets: MapStoryTargetDetail[] = targetEntries.map(item => ({
          key: item.key,
          name: item.name,
          badge: item.status === 'DOWN' ? '中断' : item.status === 'DEGRADED' ? '劣化' : '受扰',
          meta: item.lossDb !== null ? `${item.lossDb.toFixed(1)} dB` : undefined,
          focusTarget: item.linkId
            ? { kind: 'link', targetId: item.linkId }
            : item.platformId ? { kind: 'node', targetId: item.platformId } : undefined,
        }))
        items.push({
          id: `jammed:${frame.frameId}:${topSegment.linkId}:${targetEntries.length}`,
          kind: 'JAMMED',
          timeS,
          tag: downCount > 0 ? '受扰中断' : '链路受扰',
          summary: `${portPrefix} → ${targetEntries.length} ${unit}${statusPhrase}`,
          detail: detailText || '检测到电磁压制',
          targets,
          focusTarget,
        })
      }
    } else if (alarm) {
      items.push({
        id: `alarm:${frame.frameId}:${alarm.pathId ?? alarm.linkId ?? '0'}`,
        kind: 'JAMMED',
        timeS,
        tag: '受扰告警',
        summary: alarm.message?.trim() || '链路触发受扰告警',
        detail: alarm.linkId ? `关联链路 ${alarm.linkId}` : '',
        focusTarget,
      })
    } else if (jamEvent) {
      const jammerLabel = formatNodeName(nodes, jamEvent.jammerIds[0], jamEvent.jammerNames[0])
      const targets = collectUniqueStoryTargets(
        nodes,
        jamEvents.flatMap(event => {
          const count = Math.max(event.uavIds.length, event.uavNames.length)
          return Array.from({ length: count }, (_, idx) => ({ platformId: event.uavIds[idx], fallbackName: event.uavNames[idx] }))
        }),
      )
      const multi = targets.length > 1
      const unit = formatTargetGroupUnit(nodes, targets.map(t => ({ platformId: t.platformId, fallbackName: t.name })))
      items.push({
        id: `jam-event:${frame.frameId}`,
        kind: 'JAMMED',
        timeS,
        tag: '进入干扰',
        summary: multi
          ? `${jammerLabel} 压制 ${targets.length} ${unit}`
          : `${jammerLabel} 压制 ${targets[0]?.name ?? '目标'}`,
        detail: '目标已进入有效干扰范围',
        targets: multi ? targets.map(t => ({
          key: t.key,
          name: t.name,
          badge: '压制中',
          focusTarget: t.platformId ? { kind: 'node', targetId: t.platformId } : undefined,
        })) : undefined,
        focusTarget,
      })
    }
  } else {
    // 尚无受扰或告警时，按「开启压制 → 关闭压制 → 侦测中」顺序展示干扰机状态
    const suppressingJammer = suppressingJammers[0]
    const activeJammer = suppressingJammer ?? detectingJammers[0]
    const jamOffEvents = frame.events.filter(event => classifyEventType(event) === 'JAM_OFF')
    const jamOffEvent = jamOffEvents[0]
    const jamOffJammer = frame.jammers.find(jammer => !isJammerActivelySuppressing(jammer)
      && jammer.actions.some(action => action.action?.toUpperCase() === 'JAM_OFF' || action.action?.toUpperCase() === 'STOP'))
    const detectEvent = detectEvents[0]
    if (suppressingJammer) {
      const jammerId = suppressingJammer.platformId ?? undefined
      const jammerLabel = formatNodeName(nodes, jammerId, suppressingJammer.name)
      const targetCandidates = suppressingJammers.flatMap(jammer => {
        const jamOnActions = jammer.actions.filter(action => {
          const code = action.action?.toUpperCase()
          return code === 'JAM_ON' || code === 'START'
        })
        if (jamOnActions.length > 0) {
          return jamOnActions.map(action => ({ platformId: action.targetPlatformId, fallbackName: action.targetName }))
        }
        return jammer.detections.flatMap(det => {
          const count = Math.max(det.targetIds.length, det.targetNames.length)
          return Array.from({ length: count }, (_, idx) => ({ platformId: det.targetIds[idx], fallbackName: det.targetNames[idx] }))
        })
      })
      const targets = collectUniqueStoryTargets(nodes, targetCandidates)
      const multi = targets.length > 1
      const unit = formatTargetGroupUnit(nodes, targets.map(t => ({ platformId: t.platformId, fallbackName: t.name })))
      const modeText = formatJamMode(suppressingJammer.engineMode) ?? ''
      items.push({
        id: `detect:${frame.frameId}:${jammerId ?? '0'}`,
        kind: 'JAMMED',
        timeS,
        tag: '开启压制',
        summary: multi
          ? `${jammerLabel} 开启压制 ${targets.length} ${unit}`
          : targets[0] ? `${jammerLabel} 开启压制 ${targets[0].name}` : `${jammerLabel} 已开启电磁压制`,
        detail: modeText,
        targets: multi ? targets.map(t => ({
          key: t.key,
          name: t.name,
          badge: '压制中',
          focusTarget: t.platformId ? { kind: 'node', targetId: t.platformId } : undefined,
        })) : undefined,
        focusTarget: jammerId ? { kind: 'node', targetId: jammerId } : undefined,
      })
    } else if (jamOffEvent || jamOffJammer) {
      const jammerId = jamOffJammer?.platformId ?? jamOffEvent?.jammerIds[0] ?? undefined
      const jammerLabel = formatNodeName(nodes, jammerId, jamOffJammer?.name ?? jamOffEvent?.jammerNames[0])
      const targetCandidates = [
        ...jamOffEvents.flatMap(event => {
          const count = Math.max(event.uavIds.length, event.uavNames.length)
          return Array.from({ length: count }, (_, idx) => ({ platformId: event.uavIds[idx], fallbackName: event.uavNames[idx] }))
        }),
        ...(jamOffJammer?.actions ?? []).map(action => ({ platformId: action.targetPlatformId, fallbackName: action.targetName })),
      ]
      const targets = collectUniqueStoryTargets(nodes, targetCandidates)
      const multi = targets.length > 1
      const unit = formatTargetGroupUnit(nodes, targets.map(t => ({ platformId: t.platformId, fallbackName: t.name })))
      items.push({
        id: `jam-off:${frame.frameId}:${jammerId ?? '0'}`,
        kind: 'JAM_OFF',
        timeS,
        tag: '关闭压制',
        summary: `${jammerLabel} 关闭压制`,
        detail: multi
          ? `${targets.length} ${unit}已离开干扰范围`
          : targets[0] ? `${targets[0].name} 已离开干扰范围` : '目标已离开干扰范围',
        targets: multi ? targets.map(t => ({
          key: t.key,
          name: t.name,
          badge: '已离开',
          focusTarget: t.platformId ? { kind: 'node', targetId: t.platformId } : undefined,
        })) : undefined,
        focusTarget: jammerId ? { kind: 'node', targetId: jammerId } : undefined,
      })
    } else if (activeJammer || detectEvent) {
      const jammerId = activeJammer?.platformId ?? detectEvent?.jammerIds[0] ?? undefined
      const jammerLabel = formatNodeName(nodes, jammerId, activeJammer?.name ?? detectEvent?.jammerNames[0])
      const targetCandidates = [
        ...detectingJammers.flatMap(jammer => jammer.detections.flatMap(det => {
          const count = Math.max(det.targetIds.length, det.targetNames.length)
          return Array.from({ length: count }, (_, idx) => ({ platformId: det.targetIds[idx], fallbackName: det.targetNames[idx] }))
        })),
        ...detectEvents.flatMap(event => {
          const count = Math.max(event.uavIds.length, event.uavNames.length)
          return Array.from({ length: count }, (_, idx) => ({ platformId: event.uavIds[idx], fallbackName: event.uavNames[idx] }))
        }),
      ]
      const targets = collectUniqueStoryTargets(nodes, targetCandidates)
      const multi = targets.length > 1
      const unit = formatTargetGroupUnit(nodes, targets.map(t => ({ platformId: t.platformId, fallbackName: t.name })))
      const modeText = formatJamMode(activeJammer?.engineMode) ?? ''
      items.push({
        id: `detect:${frame.frameId}:${jammerId ?? '0'}`,
        kind: 'DETECT',
        timeS,
        tag: '侦测中',
        summary: multi
          ? `${jammerLabel} 正在侦测 ${targets.length} ${unit}`
          : targets[0] ? `${jammerLabel} 正在侦测 ${targets[0].name}` : `${jammerLabel} 正在侦测目标`,
        detail: modeText,
        targets: multi ? targets.map(t => ({
          key: t.key,
          name: t.name,
          badge: '侦测中',
          focusTarget: t.platformId ? { kind: 'node', targetId: t.platformId } : undefined,
        })) : undefined,
        focusTarget: jammerId ? { kind: 'node', targetId: jammerId } : undefined,
      })
    }
  }

  // 2) 路由切换（同一帧发生切换时与上方受扰胶囊并排形成「受扰 → 切换」因果；
  // 切链帧过去后，在干扰/侦测活跃期内继续保留同批切链条件框并汇总全部无人机，离开干扰/侦测圈后（或无干扰时超过短暂窗口）自动关闭）
  const currentFrameEntries: EngineSwitchEntry[] = frame.routing.switches.map(route => ({
    frameId: frame.frameId,
    simulationTime: timeS,
    route,
  }))
  const candidateHistory = recentSwitches?.length
    ? recentSwitches
    : (latestSwitch ? [latestSwitch] : [])
  if (currentFrameEntries.length > 0) {
    const mergedByKey = new Map<string, EngineSwitchEntry>()
    for (const entry of candidateHistory) {
      if (entry.simulationTime <= timeS) mergedByKey.set(switchEntryKey(entry), entry)
    }
    for (const entry of currentFrameEntries) {
      mergedByKey.set(switchEntryKey(entry), entry)
    }
    const batch = selectActiveSwitchBatch([...mergedByKey.values()], timeS)
    const activeBatch = batch.length ? batch : currentFrameEntries
    const summarized = summarizeSwitchBatch(activeBatch, frame, nodes, thresholds, latestSwitchEvidence, switchEvidenceLookup)
    items.push({
      id: `switch:${frame.frameId}:${summarized.primary.route.pathId}:${activeBatch.length}`,
      kind: 'SWITCH',
      timeS,
      tag: '已切换链路',
      summary: summarized.summary,
      detail: summarized.detail,
      stacked: Boolean(summarized.detail),
      targets: summarized.targets,
      threshold: summarized.threshold,
      thresholds: summarized.thresholds,
      focusTarget: summarized.focusTarget,
    })
  } else {
    const historyBatch = selectActiveSwitchBatch(candidateHistory, timeS)
    const anchorSwitch = historyBatch.at(-1) ?? null
    if (
      anchorSwitch
      && frame.simulationTime - anchorSwitch.simulationTime >= 0
      && (
        hasActiveInterferenceOrDetection
        || (
          frame.simulationTime - anchorSwitch.simulationTime <= SWITCH_BANNER_RETENTION_SECONDS
          && (anchorSwitch.frameId === frame.frameId || !historyBatch.every(entry => isPureQualitySwitch(entry.route)))
        )
      )
    ) {
      const summarized = summarizeSwitchBatch(historyBatch, frame, nodes, thresholds, latestSwitchEvidence, switchEvidenceLookup)
      items.push({
        id: `switch:${anchorSwitch.frameId}:${anchorSwitch.route.pathId}:${historyBatch.length}`,
        kind: 'SWITCH',
        timeS: anchorSwitch.simulationTime,
        tag: '已切换链路',
        summary: summarized.summary,
        detail: summarized.detail,
        stacked: Boolean(summarized.detail),
        targets: summarized.targets,
        threshold: summarized.threshold,
        thresholds: summarized.thresholds,
        focusTarget: summarized.focusTarget,
      })
    } else {
      const switchEvent = frame.events.find(event => classifyEventType(event) === 'SWITCH')
      if (switchEvent) {
        const eventReason = switchEvent.type ? formatEngineSwitchReason(switchEvent.type) : ''
        const eventThreshold = switchEvent.type
          ? describeSwitchReasonThreshold(switchEvent.type, null, null, frame.links, nodes, thresholds, frame.routing.alarms)
          : null
        const eventParts = [
          !eventThreshold ? eventReason : '',
          switchEvent.pathId ? `新路径 ${switchEvent.pathId.slice(0, 8)}` : '',
        ].filter(Boolean)
        items.push({
          id: `switch-event:${frame.frameId}:${switchEvent.pathId ?? '0'}`,
          kind: 'SWITCH',
          timeS,
          tag: '已切换链路',
          summary: '重路由切换',
          detail: eventParts.join(' · '),
          threshold: eventThreshold ?? undefined,
          thresholds: eventThreshold ? [eventThreshold] : undefined,
        })
      }
    }
  }

  return items.slice(0, 2)
}

function translateEngineJammerName(raw: string | null | undefined): string {
  const text = raw?.trim() ?? ''
  if (!text) return '未知干扰源'
  const ground = /^jammer_station_(\d+)$/iu.exec(text)
  if (ground) return `地面干扰站 ${Number(ground[1])}`
  const air = /^jammer_(?:airborne|airbround)_(\d+)$/iu.exec(text)
  if (air) return `机载干扰平台 ${Number(air[1])}`
  return text
}

function formatShortNumber(value: number | null | undefined, digits = 2): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return String(Number(value.toFixed(digits)))
}

/**
 * 依据单条引擎链路段的真实计算输入（inputTrace.jammers、losses、quality）汇总受扰/异常物理依据。
 * 只陈述引擎实际回传的数值，不推算门限或编造结论。
 */
export function summarizeSegmentJammingEvidence(
  segment: EngineLinkSegment,
  resolveJammerName?: (platformId: string | null, engineName: string | null) => string,
  frameJammers?: readonly EngineJammer[],
): SegmentJammingEvidence {
  const linkFrequencyGHz = typeof segment.inputTrace.frequencyGHz === 'number' && Number.isFinite(segment.inputTrace.frequencyGHz)
    ? segment.inputTrace.frequencyGHz
    : null
  const jammingDb = typeof segment.losses.jammingDb === 'number' && Number.isFinite(segment.losses.jammingDb)
    ? segment.losses.jammingDb
    : null

  const jammers: SegmentJammerEvidence[] = segment.inputTrace.jammers.map((item, index) => {
    const resolved = resolveJammerName?.(item.platformId, item.jammerName)?.trim()
    const jammerName = resolved && resolved !== '暂无数据' && !/^jammer_(?:station|airborne|airbround)_\d+$/iu.test(resolved)
      ? resolved
      : translateEngineJammerName(item.jammerName ?? item.platformId)
    const matchedFrameJammer = frameJammers?.find(frameJammer =>
      (item.platformId && frameJammer.platformId === item.platformId)
      || (item.jammerName && frameJammer.name === item.jammerName),
    )
    const rawFreqGHz = typeof item.frequencyGHz === 'number' && Number.isFinite(item.frequencyGHz) && item.frequencyGHz > 0
      ? item.frequencyGHz
      : (typeof matchedFrameJammer?.frequencyHz === 'number' && Number.isFinite(matchedFrameJammer.frequencyHz) && matchedFrameJammer.frequencyHz > 0
        ? matchedFrameJammer.frequencyHz / 1e9
        : null)
    const modeLabel = formatJamMode(matchedFrameJammer?.engineMode ?? matchedFrameJammer?.actions[0]?.mode ?? matchedFrameJammer?.actions[0]?.engineMode)
    let freqMatchNote: string | null = null
    if (linkFrequencyGHz !== null && rawFreqGHz !== null) {
      freqMatchNote = Math.abs(linkFrequencyGHz - rawFreqGHz) <= 0.25 ? '同频/邻频覆盖' : '频段对照'
    }
    return {
      key: `${item.platformId ?? item.jammerName ?? 'jammer'}:${index}`,
      jammerName,
      distanceKm: typeof item.distanceM === 'number' && Number.isFinite(item.distanceM) && item.distanceM >= 0
        ? item.distanceM / 1000
        : null,
      eirpDbw: typeof item.eirpDbw === 'number' && Number.isFinite(item.eirpDbw) ? item.eirpDbw : null,
      lossDb: typeof item.lossDb === 'number' && Number.isFinite(item.lossDb) ? item.lossDb : null,
      frequencyGHz: rawFreqGHz,
      modeLabel,
      freqMatchNote,
    }
  })

  const isJammed = (jammingDb !== null && jammingDb > 0) || jammers.some(item => item.lossDb !== null && item.lossDb > 0)
  const isAbnormal = segment.status === 'DEGRADED' || segment.status === 'DOWN'
  const shouldShow = isJammed || isAbnormal

  if (!shouldShow) {
    return { isJammed: false, shouldShow: false, title: '', summary: '', linkFrequencyGHz, jammingDb, jammers }
  }

  const metricFacts: string[] = []
  const gxb = formatShortNumber(segment.quality.gxbDb, 2)
  if (gxb !== null) metricFacts.push(`干信比 ${gxb} dB`)
  const margin = formatShortNumber(segment.quality.marginDb, 2)
  if (margin !== null) metricFacts.push(`抗干扰余量 ${margin} dB`)
  if (typeof segment.quality.ber === 'number' && Number.isFinite(segment.quality.ber) && segment.quality.ber > 0) {
    metricFacts.push(`误码率 ${segment.quality.ber < 1e-3 ? segment.quality.ber.toExponential(2) : Number(segment.quality.ber.toPrecision(4))}`)
  }

  if (isJammed) {
    const names = [...new Set(jammers.map(item => item.jammerName))].join('、')
    const parts: string[] = []
    if (names) parts.push(`受 ${names} 电磁压制`)
    else parts.push('本帧存在电磁干扰压制')
    if (jammingDb !== null && jammingDb > 0) parts.push(`干扰损耗 ${formatShortNumber(jammingDb, 2)} dB`)
    parts.push(...metricFacts)
    const title = segment.status === 'DOWN' ? '受扰中断依据' : segment.status === 'DEGRADED' ? '受扰劣化依据' : '受扰依据（仍可用）'
    return { isJammed: true, shouldShow: true, title, summary: parts.join('，'), linkFrequencyGHz, jammingDb, jammers }
  }

  // 非干扰导致的劣化/中断：客观列出主要自然传播/气象损耗与距离，帮助区分原因
  const nonJamFacts: string[] = ['本帧未检出干扰损耗（0 dB）']
  const lossCandidates: Array<[string, number | null | undefined]> = [
    ['自由空间损耗', segment.losses.freeSpaceDb],
    ['雨衰损耗', segment.losses.rainDb],
    ['云衰损耗', segment.losses.cloudDb],
    ['海面多径损耗', segment.losses.seaMultipathDb],
    ['大气损耗', segment.losses.atmosphericDb],
  ]
  for (const [label, val] of lossCandidates) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      nonJamFacts.push(`${label} ${formatShortNumber(val, 2)} dB`)
    }
  }
  if (typeof segment.distanceM === 'number' && Number.isFinite(segment.distanceM) && segment.distanceM > 0) {
    nonJamFacts.push(`传输距离 ${formatShortNumber(segment.distanceM / 1000, 2)} km`)
  }
  nonJamFacts.push(...metricFacts)
  if (segment.error) nonJamFacts.push(`引擎提示：${segment.error}`)
  const title = segment.status === 'DOWN' ? '中断依据（非干扰主导）' : '劣化依据（非干扰主导）'
  return { isJammed: false, shouldShow: true, title, summary: nonJamFacts.join('，'), linkFrequencyGHz, jammingDb, jammers }
}

/** 为地图链路悬停提示汇总受扰损耗与干扰源；无受扰时返回 undefined，保持正常链路悬停行不变。 */
export function summarizeHoverJammingLines(
  segments: ReadonlyArray<EngineLinkSegment | null> | undefined,
  resolveName: (platformId: string | null, engineName: string | null) => string,
): { jammingLoss?: string; jammingSource?: string } {
  if (!segments?.length) return {}
  let maxLoss = 0
  const sourceLabels: string[] = []
  const seen = new Set<string>()
  for (const segment of segments) {
    if (!segment) continue
    if (typeof segment.losses.jammingDb === 'number' && Number.isFinite(segment.losses.jammingDb) && segment.losses.jammingDb > maxLoss) {
      maxLoss = segment.losses.jammingDb
    }
    for (const jammer of segment.inputTrace.jammers) {
      const name = resolveName(jammer.platformId, jammer.jammerName)
      const dist = typeof jammer.distanceM === 'number' && Number.isFinite(jammer.distanceM) ? `距 ${(jammer.distanceM / 1000).toFixed(2)} km` : ''
      const eirp = typeof jammer.eirpDbw === 'number' && Number.isFinite(jammer.eirpDbw) ? `EIRP ${Number(jammer.eirpDbw.toFixed(1))} dBW` : ''
      const meta = [dist, eirp].filter(Boolean).join(' · ')
      const entry = meta ? `${name}（${meta}）` : name
      if (!seen.has(entry)) {
        seen.add(entry)
        sourceLabels.push(entry)
      }
    }
  }
  if (maxLoss <= 0 && sourceLabels.length === 0) return {}
  return {
    ...(maxLoss > 0 ? { jammingLoss: `${Number(maxLoss.toFixed(2))} dB` } : {}),
    ...(sourceLabels.length > 0 ? { jammingSource: sourceLabels.join('、') } : {}),
  }
}


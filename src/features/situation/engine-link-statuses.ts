import type { EngineFrameSnapshot, EngineLinkSegment, Link, UiLinkStatus } from '../../contracts/domain-models'

export interface EngineConfiguredLinkStatus {
  source: 'ENGINE_FRAME'
  linkId: string
  frameId: number
  simulationTime: number
  status: UiLinkStatus
  gxbDb: number | null
  ber: number | null
  receivedPowerDbm: number | null
  distanceM: number | null
  relayBypassed: boolean
}

type UsableSegment = EngineLinkSegment & { status: UiLinkStatus }

function isUsableSegment(segment: EngineLinkSegment): segment is UsableSegment {
  return !segment.error && segment.status !== 'UNKNOWN'
}

function aggregateSegmentStatus(first: UsableSegment, second: UsableSegment): UiLinkStatus {
  if (first.status === 'DOWN' || second.status === 'DOWN') return 'DOWN'
  if (first.status === 'DEGRADED' || second.status === 'DEGRADED') return 'DEGRADED'
  return 'UP'
}

function buildEntry(
  frame: EngineFrameSnapshot,
  linkId: string,
  status: UiLinkStatus,
  segment: EngineLinkSegment | null,
  relayBypassed: boolean,
  distanceM = segment?.distanceM ?? null,
): EngineConfiguredLinkStatus {
  return {
    source: 'ENGINE_FRAME',
    linkId,
    frameId: frame.frameId,
    simulationTime: frame.simulationTime,
    status,
    gxbDb: segment?.quality.gxbDb ?? null,
    ber: segment?.quality.ber ?? null,
    receivedPowerDbm: segment?.quality.rxPowerDbm ?? null,
    distanceM: distanceM !== null && Number.isFinite(distanceM) && distanceM >= 0 ? distanceM : null,
    relayBypassed,
  }
}

function resolveDirectLinkStatus(
  frame: EngineFrameSnapshot,
  link: Link,
  candidates: readonly EngineLinkSegment[],
): EngineConfiguredLinkStatus | null {
  if (candidates.length !== 1) return null
  const [segment] = candidates
  if (!segment || segment.linkIds.length !== 1 || !isUsableSegment(segment)) return null
  return buildEntry(frame, link.id, segment.status, segment, false)
}

function isSingleSharedTrunk(segments: readonly EngineLinkSegment[]): boolean {
  return segments.length === 1 && segments[0]!.linkIds.length > 1
}

function resolveRelayedLinkStatus(
  frame: EngineFrameSnapshot,
  link: Link,
  candidates: readonly EngineLinkSegment[],
): EngineConfiguredLinkStatus | null {
  const relayId = link.relayPlatformId
  if (!relayId || candidates.length === 0) return null

  const hop1: EngineLinkSegment[] = []
  const hop2: EngineLinkSegment[] = []
  const direct: EngineLinkSegment[] = []

  for (const segment of candidates) {
    if (segment.sourcePlatformId === link.sourcePlatformId && segment.targetPlatformId === relayId) hop1.push(segment)
    else if (segment.sourcePlatformId === relayId && segment.targetPlatformId === link.targetPlatformId) hop2.push(segment)
    else if (segment.sourcePlatformId === link.sourcePlatformId && segment.targetPlatformId === link.targetPlatformId) direct.push(segment)
    else return null
  }

  // 两跳中继均已生效：允许其中一跳或双跳为共享中继干线，汇总两端状态，不冒充单跳射频指标。
  if (hop1.length === 1 && hop2.length === 1 && direct.length === 0) {
    const [first, second] = [hop1[0]!, hop2[0]!]
    if (!isUsableSegment(first) || !isUsableSegment(second)) return null
    const [firstDistance, secondDistance] = [first.distanceM, second.distanceM]
    const distanceM = firstDistance !== null && firstDistance >= 0 && secondDistance !== null && secondDistance >= 0
      ? firstDistance + secondDistance : null
    return buildEntry(frame, link.id, aggregateSegmentStatus(first, second), null, false, distanceM)
  }

  // 中继绕过直连兜底：仅当存在唯一单链直连段，且未同时形成有效中继或专属未分流单跳冲突时生效；
  // 同源/同宿其余节点仍在走中继产生的共享干线（linkIds.length > 1）允许在单侧共存。
  if (direct.length === 1 && (hop1.length + hop2.length === 0 || (hop1.length === 0 && isSingleSharedTrunk(hop2)) || (hop2.length === 0 && isSingleSharedTrunk(hop1)))) {
    const [segment] = direct
    if (!segment || segment.linkIds.length !== 1 || !isUsableSegment(segment)) return null
    return buildEntry(frame, link.id, segment.status, segment, true)
  }

  return null
}

/**
 * 将引擎帧中的设备段映射为场景配置链路的呈现状态：
 * - 无中继链路：仅在唯一单链段无错且非 UNKNOWN 时映射；
 * - 有中继链路：支持两跳（含共享中继干线）聚合，以及引擎绕过中继时的直连兜底。
 */
export function resolveEngineFrameConfiguredLinks(
  frame: EngineFrameSnapshot | null | undefined,
  links: readonly Link[],
): Map<string, EngineConfiguredLinkStatus> {
  const result = new Map<string, EngineConfiguredLinkStatus>()
  if (!frame || !links.length) return result

  const segmentsByLinkId = new Map<string, EngineLinkSegment[]>()
  for (const segment of frame.links) {
    for (const linkId of new Set(segment.linkIds)) {
      const bucket = segmentsByLinkId.get(linkId)
      if (bucket) bucket.push(segment)
      else segmentsByLinkId.set(linkId, [segment])
    }
  }

  for (const link of links) {
    const candidates = segmentsByLinkId.get(link.id)
    if (!candidates?.length) continue
    const resolved = link.relayPlatformId
      ? resolveRelayedLinkStatus(frame, link, candidates)
      : resolveDirectLinkStatus(frame, link, candidates)
    if (resolved) result.set(link.id, resolved)
  }

  return result
}

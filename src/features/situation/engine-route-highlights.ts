import type { EngineFrameSnapshot, EngineLinkSegment, EnginePathNode } from '../../contracts/domain-models'

export type EngineRouteResolution = {
  linkIds: string[]
  totalHops: number
  resolvedHops: number
}

export type EngineSwitchHighlights = {
  before: EngineRouteResolution
  after: EngineRouteResolution
}

/** 当前源只含一帧时仍按用户给出的闭区间筛选；反向区间明确为空。 */
export function includesEngineSimulationTime(simulationTime: number, start?: number, end?: number): boolean {
  if (!Number.isFinite(simulationTime)) return false
  if (start !== undefined && end !== undefined && start > end) return false
  return (start === undefined || simulationTime >= start) && (end === undefined || simulationTime <= end)
}

/**
 * 将路由相邻节点与本帧设备段严格按平台及端口匹配。
 * 只有一条设备段且其仅关联一条场景链路时才返回场景链路 ID；缺失或歧义都不猜测。
 */
export function resolveEngineRouteLinks(frame: EngineFrameSnapshot | null | undefined, nodes: EnginePathNode[]): EngineRouteResolution {
  const totalHops = Math.max(nodes.length - 1, 0)
  if (!frame || totalHops === 0) return { linkIds: [], totalHops, resolvedHops: 0 }

  const linkIds: string[] = []
  let resolvedHops = 0
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const source = nodes[index]!
    const target = nodes[index + 1]!
    // 路径端口为空或缺失时无法证实为同一设备段，不能仅按平台名推断。
    if (!source.platformId || !source.outPort || !target.platformId || !target.inPort) continue
    const matches = frame.links.filter(segment => segment.sourcePlatformId === source.platformId
      && segment.sourcePort === source.outPort
      && segment.targetPlatformId === target.platformId
      && segment.targetPort === target.inPort)
    // 先要求设备段本身唯一，再要求该段唯一关联场景链路；不能先排除多关联段。
    if (matches.length !== 1 || matches[0]!.linkIds.length !== 1) continue
    const linkId = matches[0]!.linkIds[0]!
    if (!linkIds.includes(linkId)) linkIds.push(linkId)
    resolvedHops += 1
  }
  return { linkIds, totalHops, resolvedHops }
}

/** 同一切换事件的前后路径独立解析，不把未解析的段补成场景链路。 */
export function resolveEngineSwitchHighlights(frame: EngineFrameSnapshot | null | undefined, oldNodes: EnginePathNode[], newNodes: EnginePathNode[]): EngineSwitchHighlights {
  return {
    before: resolveEngineRouteLinks(frame, oldNodes),
    after: resolveEngineRouteLinks(frame, newNodes),
  }
}

/**
 * 单帧的一个跳段证据：键由端点平台与端口确定，值是该跳唯一对应的场景链路，
 * `null` 表示该跳存在设备段但关联多条链路（歧义），缺省表示该帧没有这段。
 */
export type EngineRouteHopEvidence = ReadonlyMap<string, string | null>

export interface EngineRouteEvidenceFrame {
  runId?: string
  engineEpoch?: number
  frameId: number
  simulationTime?: number
  hops: EngineRouteHopEvidence
}

/** 由相邻节点生成跳键；任一端点或端口缺失时返回 undefined，禁止仅按平台名推断。 */
export function engineHopKey(source: EnginePathNode, target: EnginePathNode): string | undefined {
  if (!source.platformId || !source.outPort || !target.platformId || !target.inPort) return undefined
  return JSON.stringify([source.platformId, source.outPort, target.platformId, target.inPort])
}

/** 从一帧设备段构造跳段证据图：同跳唯一设备段且仅关联一条链路才记为唯一映射。 */
export function buildFrameRouteEvidence(frame: EngineFrameSnapshot): EngineRouteHopEvidence {
  const groups = new Map<string, EngineLinkSegment[]>()
  for (const segment of frame.links) {
    if (!segment.sourcePlatformId || !segment.sourcePort || !segment.targetPlatformId || !segment.targetPort) continue
    const key = JSON.stringify([segment.sourcePlatformId, segment.sourcePort, segment.targetPlatformId, segment.targetPort])
    groups.set(key, [...(groups.get(key) ?? []), segment])
  }
  const evidence = new Map<string, string | null>()
  for (const [key, segments] of groups) {
    evidence.set(key, segments.length === 1 && segments[0]!.linkIds.length === 1 ? segments[0]!.linkIds[0]! : null)
  }
  return evidence
}

/** 先用事件帧证据；缺该跳才在同 run/epoch 的事件前证据里按“从新到旧”取首个命中的记录，命中歧义即停止，不回捞更早唯一映射。 */
export function resolveEngineRouteLinksWithEvidence(
  eventFrame: EngineFrameSnapshot | null | undefined,
  nodes: EnginePathNode[],
  priorEvidence: readonly EngineRouteEvidenceFrame[] = [],
): EngineRouteResolution {
  const totalHops = Math.max(nodes.length - 1, 0)
  if (!eventFrame || totalHops === 0) return { linkIds: [], totalHops, resolvedHops: 0 }
  const eventEvidence = buildFrameRouteEvidence(eventFrame)
  const linkIds: string[] = []
  let resolvedHops = 0
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const key = engineHopKey(nodes[index]!, nodes[index + 1]!)
    if (key === undefined) continue
    let value: string | null | undefined
    if (eventEvidence.has(key)) value = eventEvidence.get(key)
    else {
      for (let frameIndex = priorEvidence.length - 1; frameIndex >= 0; frameIndex -= 1) {
        const hops = priorEvidence[frameIndex]!.hops
        if (hops.has(key)) { value = hops.get(key); break }
      }
    }
    if (value === undefined || value === null) continue
    if (!linkIds.includes(value)) linkIds.push(value)
    resolvedHops += 1
  }
  return { linkIds, totalHops, resolvedHops }
}

/** 带历史证据的切换前后解析：事件帧优先，缺旧段才回退同 run/epoch 事件前最近证据。 */
export function resolveEngineSwitchHighlightsWithEvidence(
  eventFrame: EngineFrameSnapshot | null | undefined,
  oldNodes: EnginePathNode[],
  newNodes: EnginePathNode[],
  priorEvidence: readonly EngineRouteEvidenceFrame[] = [],
): EngineSwitchHighlights {
  return {
    before: resolveEngineRouteLinksWithEvidence(eventFrame, oldNodes, priorEvidence),
    after: resolveEngineRouteLinksWithEvidence(eventFrame, newNodes, priorEvidence),
  }
}

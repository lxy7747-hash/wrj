import type { EngineFrameSnapshot, EngineLinkSegment, EnginePathNode, EngineRouteSwitch } from '../../contracts/domain-models'

export type EngineRouteResolution = {
  linkIds: string[]
  totalHops: number
  resolvedHops: number
}

export type EngineSwitchHighlights = {
  before: EngineRouteResolution
  after: EngineRouteResolution
}

export const ROUTE_EVIDENCE_FRAME_LIMIT = 200
export type ConfiguredLinkSwitchState = 'BEFORE' | 'AFTER' | 'BOTH'
export interface EngineSwitchEntry {
  frameId: number
  simulationTime: number
  route: EngineRouteSwitch
  resolution?: EngineSwitchHighlights
}

/** 有事件帧的解析结果时沿用至下次切换；旧响应只允许在事件当帧解析。 */
export function latestMapSwitches(frame: EngineFrameSnapshot | null, latest?: EngineSwitchEntry): Map<string, ConfiguredLinkSwitchState> {
  const states = new Map<string, ConfiguredLinkSwitchState>()
  if (!frame || !latest || latest.frameId > frame.frameId || latest.simulationTime > frame.simulationTime) return states
  const resolved = latest.resolution ?? (latest.frameId === frame.frameId
    ? resolveEngineSwitchHighlights(frame, latest.route.oldNodes, latest.route.nodes) : undefined)
  if (!resolved) return states
  for (const id of resolved.before.linkIds) states.set(id, 'BEFORE')
  for (const id of resolved.after.linkIds) states.set(id, states.has(id) ? 'BOTH' : 'AFTER')
  return states
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
  return resolveRouteFromEvidence(nodes, frame ? buildFrameRouteEvidence(frame) : new Map())
}

/** 同一切换事件的前后路径独立解析，不把未解析的段补成场景链路。 */
export function resolveEngineSwitchHighlights(frame: EngineFrameSnapshot | null | undefined, oldNodes: EnginePathNode[], newNodes: EnginePathNode[]): EngineSwitchHighlights {
  return resolveSwitchFromPriorFrames(frame, oldNodes, newNodes, [])
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

function resolveRouteFromEvidence(nodes: EnginePathNode[], evidence: EngineRouteHopEvidence): EngineRouteResolution {
  const totalHops = Math.max(nodes.length - 1, 0)
  const linkIds: string[] = []
  let resolvedHops = 0
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const key = engineHopKey(nodes[index]!, nodes[index + 1]!)
    if (key === undefined) continue
    const value = evidence.get(key)
    if (value === undefined || value === null) continue
    if (!linkIds.includes(value)) linkIds.push(value)
    resolvedHops += 1
  }
  return { linkIds, totalHops, resolvedHops }
}

/** 历史证据由近及远，找到所需跳段即停止。显式歧义（null）同样终止该跳的回查。 */
export function resolveSwitchFromPriorFrames(
  eventFrame: EngineFrameSnapshot | null | undefined, oldNodes: EnginePathNode[], newNodes: EnginePathNode[],
  previous: Iterable<EngineRouteHopEvidence>,
): EngineSwitchHighlights {
  const evidence = new Map(eventFrame ? buildFrameRouteEvidence(eventFrame) : [])
  const missing = new Set<string>()
  for (const nodes of [oldNodes, newNodes]) {
    for (let i = 1; i < nodes.length; i++) {
      const key = engineHopKey(nodes[i - 1]!, nodes[i]!)
      if (key !== undefined && !evidence.has(key)) missing.add(key)
    }
  }
  if (eventFrame && missing.size) {
    for (const hops of previous) {
      for (const key of missing) {
        const value = hops.get(key)
        if (value === undefined) continue
        evidence.set(key, value)
        missing.delete(key)
      }
      if (!missing.size) break
    }
  }
  return { before: resolveRouteFromEvidence(oldNodes, evidence), after: resolveRouteFromEvidence(newNodes, evidence) }
}

export function resolveEngineSwitchHighlightsWithEvidence(
  eventFrame: EngineFrameSnapshot | null | undefined,
  oldNodes: EnginePathNode[],
  newNodes: EnginePathNode[],
  priorEvidence: readonly EngineRouteEvidenceFrame[] = [],
): EngineSwitchHighlights {
  function* newestFirst() {
    for (let i = priorEvidence.length - 1; i >= 0; i--) yield priorEvidence[i]!.hops
  }
  return resolveSwitchFromPriorFrames(eventFrame, oldNodes, newNodes, newestFirst())
}

export function resolveEngineRouteLinksWithEvidence(
  eventFrame: EngineFrameSnapshot | null | undefined, nodes: EnginePathNode[], priorEvidence: readonly EngineRouteEvidenceFrame[] = [],
): EngineRouteResolution {
  return resolveEngineSwitchHighlightsWithEvidence(eventFrame, nodes, [], priorEvidence).before
}

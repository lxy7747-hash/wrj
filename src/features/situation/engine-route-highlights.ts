import type { EngineFrameSnapshot, EnginePathNode } from '../../contracts/domain-models'

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

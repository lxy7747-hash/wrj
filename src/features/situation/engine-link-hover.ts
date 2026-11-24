import type { EngineFrameSnapshot, EngineLinkSegment, EnginePathQuality, EngineRoute } from '../../contracts/domain-models'
import { engineHopKey } from './engine-route-highlights'

interface EngineHoverPath {
  quality: EnginePathQuality
  platformIds: string[]
  distanceM: number | null
}

export interface EngineLinkHover {
  segments: (EngineLinkSegment | null)[]
  path?: EngineHoverPath
}

function indexUnique<T>(index: Map<string, T | null>, key: string, value: T): void {
  index.set(key, index.has(key) ? null : value)
}

function totalDistance(segments: (EngineLinkSegment | null)[]): number | null {
  let total = 0
  for (const segment of segments) {
    const distance = segment?.distanceM
    if (distance == null || !Number.isFinite(distance) || distance < 0) return null
    total += distance
  }
  return Number.isFinite(total) ? total : null
}

/** 距离和质量只读当前帧，历史路由仅用于还原当前热链 ID 的走向。 */
export function createEngineLinkHoverLookup(
  frame: EngineFrameSnapshot | null | undefined,
  routeHistory: readonly EngineRoute[] = [],
): (linkId: string, platformIds: readonly string[]) => EngineLinkHover {
  const linkedSegments = new Map<string, EngineLinkSegment | null>()
  const portSegments = new Map<string, EngineLinkSegment | null>()
  for (const segment of frame?.links ?? []) {
    const { sourcePlatformId: source, targetPlatformId: target, sourcePort, targetPort } = segment
    if (!source || !target) continue
    for (const linkId of new Set([segment.linkId, ...segment.linkIds])) {
      indexUnique(linkedSegments, JSON.stringify([linkId, source, target]), segment)
    }
    if (sourcePort && targetPort) indexUnique(portSegments, JSON.stringify([source, sourcePort, target, targetPort]), segment)
  }

  const qualityByPathId = new Map<string, EnginePathQuality | null>()
  for (const quality of frame?.pathQuality ?? []) {
    if (quality.pathId?.trim()) indexUnique(qualityByPathId, quality.pathId, quality)
  }
  const routesByPathId = new Map<string, EngineRoute>()
  for (const routes of [frame?.initRouting ?? [], routeHistory, frame?.routing.switches ?? []]) {
    for (const route of routes) {
      if (qualityByPathId.has(route.pathId)) routesByPathId.set(route.pathId, route)
    }
  }

  const pathsBySegment = new Map<EngineLinkSegment, {
    quality: EnginePathQuality | null
    segments: (EngineLinkSegment | null)[]
    platformIds: string[]
  }[]>()
  for (const route of routesByPathId.values()) {
    const platformIds = route.nodes.map(node => node.platformId).filter((id): id is string => Boolean(id))
    if (platformIds.length < 2 || platformIds.length !== route.nodes.length) continue
    const segments = route.nodes.slice(1).map((target, index) => {
      const key = engineHopKey(route.nodes[index]!, target)
      const segment = key === undefined ? null : portSegments.get(key)
      return segment?.error ? null : segment ?? null
    })
    const path = { quality: qualityByPathId.get(route.pathId) ?? null, segments, platformIds }
    for (const segment of new Set(segments)) {
      if (!segment) continue
      const paths = pathsBySegment.get(segment)
      if (paths) paths.push(path)
      else pathsBySegment.set(segment, [path])
    }
  }

  return (linkId, platformIds) => {
    const segments = platformIds.slice(1).map((target, index) => {
      const segment = linkedSegments.get(JSON.stringify([linkId, platformIds[index], target]))
      return segment?.error ? null : segment ?? null
    })
    const first = segments[0]
    if (!first || segments.includes(null)) return { segments }
    const paths = pathsBySegment.get(first) ?? []
    const exact = paths.filter(path => path.segments.length === segments.length && path.segments.every((segment, index) => segment === segments[index]))
    // 多条热链共享同一跳时，缺少唯一匹配就不展示全程指标。
    const candidates = exact.length > 0 || segments.length > 1 ? exact : paths
    const chosen = candidates.length === 1 ? candidates[0] : undefined
    if (!chosen?.quality) return { segments }
    return { segments, path: { quality: chosen.quality, platformIds: chosen.platformIds, distanceM: totalDistance(chosen.segments) } }
  }
}

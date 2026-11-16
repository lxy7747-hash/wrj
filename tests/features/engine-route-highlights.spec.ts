// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { EngineFrameSnapshot } from '../../src/contracts/domain-models'
import { includesEngineSimulationTime, resolveEngineRouteLinks, resolveEngineSwitchHighlights, buildFrameRouteEvidence, resolveEngineRouteLinksWithEvidence, resolveEngineSwitchHighlightsWithEvidence } from '../../src/features/situation/engine-route-highlights'

const segment = (linkId: string, linkIds: string[], sourcePlatformId: string | null, sourcePort: string | null, targetPlatformId: string | null, targetPort: string | null) => ({
  linkId, linkIds, sourceName: sourcePlatformId, sourcePlatformId, sourcePort, targetName: targetPlatformId, targetPlatformId, targetPort,
  status: 'UP' as const, engineStatus: 'AVAILABLE', error: null, distanceM: null,
  losses: { freeSpaceDb: null, seaMultipathDb: null, atmosphericDb: null, cloudRainDb: null, jammingDb: null, totalDb: null },
  quality: { gxbDb: null, ber: null, rxPowerDbw: null, rxPowerDbm: null },
  inputTrace: { eirpDbw: null, gtDbk: null, dataRateMbps: null, frequencyGHz: null, jammers: [] },
})
const frame = (links: ReturnType<typeof segment>[]): EngineFrameSnapshot => ({
  kind: 'ENGINE_FRAME', runId: 'RUN-1', engineEpoch: 0, frameId: 7, simulationTime: 12, modelVersion: null, modulation: null,
  links, jammers: [], routing: { switches: [], alarms: [] }, events: [], initRouting: null,
})
const node = (platformId: string, inPort: string, outPort: string) => ({ platformName: platformId, platformId, inPort, outPort })

describe('引擎切换路径高亮', () => {
  it('时间范围只按当前源仿真时刻过滤，范围外和反向区间均为空', () => {
    expect(includesEngineSimulationTime(12.5, 12, 13)).toBe(true)
    expect(includesEngineSimulationTime(12.5, 13, 14)).toBe(false)
    expect(includesEngineSimulationTime(12.5, 13, 12)).toBe(false)
  })

  it('仅在端点、端口和唯一 linkId 同时吻合时关联场景链路', () => {
    const current = frame([segment('seg-a', ['L-A'], 'A', 'a-out', 'B', 'b-in')])
    expect(resolveEngineRouteLinks(current, [node('A', '', 'a-out'), node('B', 'b-in', '')])).toEqual({ linkIds: ['L-A'], totalHops: 1, resolvedHops: 1 })
    expect(resolveEngineRouteLinks(current, [node('A', '', 'other'), node('B', 'b-in', '')])).toEqual({ linkIds: [], totalHops: 1, resolvedHops: 0 })
  })

  it('多 linkId、重复设备段和缺端口均明确保留为未解析，不猜测路径', () => {
    const route = [node('A', '', 'a-out'), node('B', 'b-in', '')]
    expect(resolveEngineRouteLinks(frame([segment('seg-a', ['L-A', 'L-B'], 'A', 'a-out', 'B', 'b-in')]), route)).toMatchObject({ totalHops: 1, resolvedHops: 0, linkIds: [] })
    // 同端点端口下即使其中一段只有一个场景 ID，另一段多关联也使设备段归属不唯一。
    expect(resolveEngineRouteLinks(frame([
      segment('seg-a', ['L-A'], 'A', 'a-out', 'B', 'b-in'),
      segment('seg-b', ['L-B', 'L-C'], 'A', 'a-out', 'B', 'b-in'),
    ]), route)).toMatchObject({ totalHops: 1, resolvedHops: 0, linkIds: [] })
    expect(resolveEngineRouteLinks(frame([segment('seg-a', ['L-A'], 'A', 'a-out', 'B', 'b-in'), segment('seg-b', ['L-B'], 'A', 'a-out', 'B', 'b-in')]), route)).toMatchObject({ totalHops: 1, resolvedHops: 0, linkIds: [] })
    expect(resolveEngineRouteLinks(frame([segment('seg-a', ['L-A'], 'A', 'a-out', 'B', 'b-in')]), [node('A', '', ''), node('B', 'b-in', '')])).toMatchObject({ totalHops: 1, resolvedHops: 0, linkIds: [] })
  })

  it('切换前后独立解析，不将任一侧未匹配段拼接为整条路径', () => {
    const current = frame([
      segment('old', ['L-OLD'], 'A', 'a-out', 'B', 'b-in'),
      segment('new', ['L-NEW'], 'A', 'a-out', 'C', 'c-in'),
    ])
    const result = resolveEngineSwitchHighlights(current,
      [node('A', '', 'a-out'), node('B', 'b-in', '')],
      [node('A', '', 'a-out'), node('C', 'c-in', '')],
    )
    expect(result.before).toMatchObject({ linkIds: ['L-OLD'], totalHops: 1, resolvedHops: 1 })
    expect(result.after).toMatchObject({ linkIds: ['L-NEW'], totalHops: 1, resolvedHops: 1 })
  })
})

describe('引擎切换前历史路由证据', () => {
  const oldRoute = [node('A', '', 'a-out'), node('B', 'b-in', '')]
  const newRoute = [node('A', '', 'a-out'), node('C', 'c-in', '')]

  it('旧段只在事件前帧出现时仍能用同 run/epoch 前证据解析切换前路线', () => {
    // 事件帧只剩新段：旧段 A→B 已退出当前帧。
    const eventFrame = frame([segment('new', ['L-NEW'], 'A', 'a-out', 'C', 'c-in')])
    const priorEvidence = [{ runId: 'RUN-1', engineEpoch: 0, frameId: 6, hops: buildFrameRouteEvidence(frame([
      segment('old', ['L-OLD'], 'A', 'a-out', 'B', 'b-in'),
    ])) }]
    const result = resolveEngineSwitchHighlightsWithEvidence(eventFrame, oldRoute, newRoute, priorEvidence)
    expect(result.before).toMatchObject({ linkIds: ['L-OLD'], totalHops: 1, resolvedHops: 1 })
    expect(result.after).toMatchObject({ linkIds: ['L-NEW'], totalHops: 1, resolvedHops: 1 })
  })

  it('较新的歧义证据使旧唯一映射失效，不跳过它回捞更早唯一映射', () => {
    const eventFrame = frame([segment('new', ['L-NEW'], 'A', 'a-out', 'C', 'c-in')])
    const olderUnique = { frameId: 5, hops: buildFrameRouteEvidence(frame([segment('old', ['L-OLD'], 'A', 'a-out', 'B', 'b-in')])) }
    const newerAmbiguous = { frameId: 6, hops: buildFrameRouteEvidence(frame([
      segment('x', ['L-A', 'L-B'], 'A', 'a-out', 'B', 'b-in'),
      segment('y', ['L-C'], 'A', 'a-out', 'B', 'b-in'),
    ])) }
    const resolved = resolveEngineRouteLinksWithEvidence(eventFrame, oldRoute, [olderUnique, newerAmbiguous])
    expect(resolved).toMatchObject({ linkIds: [], totalHops: 1, resolvedHops: 0 })
  })

  it('缺端口或无任何证据时明确保持未解析，不猜测', () => {
    const eventFrame = frame([segment('new', ['L-NEW'], 'A', 'a-out', 'C', 'c-in')])
    expect(resolveEngineRouteLinksWithEvidence(eventFrame, [node('A', '', ''), node('B', 'b-in', '')], [])).toMatchObject({ totalHops: 1, resolvedHops: 0 })
    expect(resolveEngineRouteLinksWithEvidence(eventFrame, oldRoute, [])).toMatchObject({ linkIds: [], resolvedHops: 0 })
  })

  it('事件帧唯一映射优先于更早的历史证据', () => {
    const eventFrame = frame([segment('old-current', ['L-CURRENT'], 'A', 'a-out', 'B', 'b-in')])
    const prior = [{ frameId: 6, hops: buildFrameRouteEvidence(frame([segment('old', ['L-OLD'], 'A', 'a-out', 'B', 'b-in')])) }]
    expect(resolveEngineRouteLinksWithEvidence(eventFrame, oldRoute, prior)).toMatchObject({ linkIds: ['L-CURRENT'], resolvedHops: 1 })
  })
})

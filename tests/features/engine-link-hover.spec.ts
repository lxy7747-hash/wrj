// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { EngineFrameSnapshot, EngineLinkSegment, EnginePathQuality, EngineRoute } from '../../src/contracts/domain-models'
import { createEngineLinkHoverLookup } from '../../src/features/situation/engine-link-hover'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'

const baseFrame = adaptEngineFrameSnapshot({ frame_id: 1, link_calc: { links: [{
  status: 'AVAILABLE', quality: { margin_db: 0, delay_ms: 1.25 },
}] } }).data!

function segment(linkId: string, linkIds: string[], source: string, target: string, distanceM: number | null): EngineLinkSegment {
  return {
    ...baseFrame.links[0]!, linkId, linkIds, distanceM,
    sourcePlatformId: source, sourcePort: `${source}-out`, targetPlatformId: target, targetPort: `${target}-in`,
  }
}

function route(pathId: string, platformIds: string[]): EngineRoute {
  return {
    pathId, direction: 'FORWARD', sourceName: null, targetName: null,
    sourcePlatformId: platformIds[0]!, targetPlatformId: platformIds.at(-1)!, transTypes: [],
    nodes: platformIds.map(platformId => ({
      platformId, platformName: platformId, inPort: `${platformId}-in`, outPort: `${platformId}-out`,
    })),
  }
}

function quality(pathId: string | null): EnginePathQuality {
  return { pathId, gxbDb: 4, ber: 0, marginDb: 8, delayMs: 3, rateBps: 2500 }
}

const ab = segment('AB', ['L-AC', 'L-AD'], 'A', 'B', 0)
const bc = segment('BC', ['L-AC'], 'B', 'C', 1250)
const bd = segment('BD', ['L-AD'], 'B', 'D', 2500)
const ac = route('PATH-AC', ['A', 'B', 'C'])
const ad = route('PATH-AD', ['A', 'B', 'D'])
const acQuality = quality(ac.pathId)
const adQuality = quality(ad.pathId)

describe('地图悬浮的引擎链路证据', () => {
  it('按配置链路及有向端点匹配设备段，用完整走向区分共享干线上的热链', () => {
    const current: EngineFrameSnapshot = {
      ...baseFrame, links: [ab, bc, bd], initRouting: [ac, ad], pathQuality: [acQuality, adQuality],
    }
    const lookup = createEngineLinkHoverLookup(current)

    expect(lookup('L-AC', ['A', 'B', 'C'])).toEqual({
      segments: [ab, bc],
      path: { quality: acQuality, platformIds: ['A', 'B', 'C'], distanceM: 1250 },
    })
    expect(lookup('L-AD', ['A', 'B', 'D']).path).toMatchObject({ quality: adQuality, distanceM: 2500 })
    expect(lookup('AB', ['A', 'B'])).toEqual({ segments: [ab] })
    expect(lookup('L-AC', ['C', 'B', 'A'])).toEqual({ segments: [null, null] })
    expect(lookup('UNLINKED', ['B', 'C'])).toEqual({ segments: [null] })
  })

  it('单跳只接受唯一热链，缺少全程距离时保留热链质量且不累加部分距离', () => {
    const current = { ...baseFrame, links: [ab], pathQuality: [acQuality] }
    const lookup = createEngineLinkHoverLookup(current, [ac])
    expect(lookup('AB', ['A', 'B'])).toEqual({
      segments: [ab],
      path: { quality: acQuality, platformIds: ['A', 'B', 'C'], distanceM: null },
    })

    const direct = route('PATH-AB', ['A', 'B'])
    const directQuality = quality(direct.pathId)
    const withExact = createEngineLinkHoverLookup({ ...current, pathQuality: [acQuality, directQuality] }, [ac, direct])
    expect(withExact('AB', ['A', 'B']).path).toEqual({ quality: directQuality, platformIds: ['A', 'B'], distanceM: 0 })
  })

  it('缺失、空白和重复热链 ID 不匹配，缺失报文仍可查看唯一设备段', () => {
    for (const pathQuality of [undefined, [quality('')], [quality('OTHER')], [acQuality, acQuality]]) {
      const lookup = createEngineLinkHoverLookup({ ...baseFrame, links: [ab, bc], pathQuality }, [ac])
      expect(lookup('L-AC', ['A', 'B', 'C'])).toEqual({ segments: [ab, bc] })
    }
  })

  it('设备段端口不匹配、证据重复或计算出错时不借用其它整链质量', () => {
    for (const links of [
      [{ ...ab, sourcePort: 'other-out' }, bc],
      [ab, { ...ab, linkId: 'duplicate' }, bc],
      [{ ...ab, error: 'invalid' }, bc],
    ]) {
      const lookup = createEngineLinkHoverLookup({ ...baseFrame, links, initRouting: [ac], pathQuality: [acQuality] })
      expect(lookup('L-AC', ['A', 'B', 'C']).path).toBeUndefined()
    }
  })
})

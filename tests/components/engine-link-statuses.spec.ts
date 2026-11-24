import { describe, expect, it } from 'vitest'
import type { EngineFrameSnapshot, EngineLinkSegment, Link } from '../../src/contracts/domain-models'
import { resolveEngineFrameConfiguredLinks } from '../../src/features/situation/engine-link-statuses'

function makeLink(id: string, sourcePlatformId: string, targetPlatformId: string, relayPlatformId: string | null = null): Link {
  return {
    id,
    type: 'MICROWAVE',
    sourcePlatformId,
    targetPlatformId,
    relayPlatformId,
    enabled: true,
    frequency: 15000,
    bandwidth: 20,
    txPower: 10,
    antennaGain: { tx: 15, rx: 15 },
    modulation: 'QPSK',
    berThreshold: 1e-5,
    dataRate: 20,
    direction: 'FORWARD',
  }
}

function makeSegment(overrides: Partial<EngineLinkSegment> & Pick<EngineLinkSegment, 'linkId' | 'linkIds' | 'sourcePlatformId' | 'targetPlatformId'>): EngineLinkSegment {
  return {
    sourceName: overrides.sourcePlatformId,
    sourcePort: 'port',
    targetName: overrides.targetPlatformId,
    targetPort: 'port',
    status: 'UP',
    engineStatus: 'NORMAL',
    error: null,
    distanceM: 1000,
    losses: { freeSpaceDb: 90, seaMultipathDb: 0, atmosphericDb: 0, cloudRainDb: 0, jammingDb: 0, totalDb: 90 },
    quality: { gxbDb: 14, ber: 1e-6, rxPowerDbw: -80, rxPowerDbm: -50, delay: 1 },
    inputTrace: { eirpDbw: 40, gtDbk: 0, dataRateMbps: 20, frequencyGHz: 15, jammers: [] },
    ...overrides,
  }
}

function makeFrame(links: EngineLinkSegment[]): EngineFrameSnapshot {
  return {
    kind: 'ENGINE_FRAME',
    runId: 'RUN-TEST',
    engineEpoch: 0,
    frameId: 5,
    simulationTime: 5,
    modelVersion: 'test',
    modulation: null,
    links,
    jammers: [],
    routing: { switches: [], alarms: [] },
    events: [],
    initRouting: null,
  }
}

describe('resolveEngineFrameConfiguredLinks', () => {
  it('聚合正常/劣化/中断两跳中继且不伪造多跳数值，拒绝缺测与错误段', () => {
    const links = [
      makeLink('L-DEG', 'CMD', 'U1', 'RELAY'),
      makeLink('L-DOWN', 'CMD', 'U2', 'RELAY'),
      makeLink('L-UNK', 'CMD', 'U3', 'RELAY'),
      makeLink('L-ERR', 'CMD', 'U4', 'RELAY'),
    ]
    const resolved = resolveEngineFrameConfiguredLinks(makeFrame([
      makeSegment({ linkId: 'TRUNK', linkIds: ['L-DEG', 'L-DOWN', 'L-UNK', 'L-ERR'], sourcePlatformId: 'CMD', targetPlatformId: 'RELAY', status: 'DEGRADED', distanceM: 2400 }),
      makeSegment({ linkId: 'H2-U1', linkIds: ['L-DEG'], sourcePlatformId: 'RELAY', targetPlatformId: 'U1', status: 'UP' }),
      makeSegment({ linkId: 'H2-U2', linkIds: ['L-DOWN'], sourcePlatformId: 'RELAY', targetPlatformId: 'U2', status: 'DOWN', distanceM: null }),
      makeSegment({ linkId: 'H2-U3', linkIds: ['L-UNK'], sourcePlatformId: 'RELAY', targetPlatformId: 'U3', status: 'UNKNOWN' }),
      makeSegment({ linkId: 'H2-U4', linkIds: ['L-ERR'], sourcePlatformId: 'RELAY', targetPlatformId: 'U4', status: 'UP', error: 'missing_snr' }),
    ]), links)

    expect(resolved.get('L-DEG')).toMatchObject({ status: 'DEGRADED', relayBypassed: false, gxbDb: null, ber: null, receivedPowerDbm: null, distanceM: 3400 })
    expect(resolved.get('L-DOWN')).toMatchObject({ status: 'DOWN', relayBypassed: false, gxbDb: null, ber: null, receivedPowerDbm: null, distanceM: null })
    expect(resolved.has('L-UNK')).toBe(false)
    expect(resolved.has('L-ERR')).toBe(false)
  })

  it('在存在专属未分流单跳、同时存在两跳与直连或无中继多链共享时拒绝歧义绑定', () => {
    const links = [
      makeLink('L-CONFLICT', 'CMD', 'U1', 'RELAY'),
      makeLink('L-BOTH', 'CMD', 'U2', 'RELAY'),
      makeLink('L-DIRECT-SHARED', 'CMD', 'U1', null),
      makeLink('L-DIRECT-DUP', 'CMD', 'U2', null),
      makeLink('L-BYPASS-OK', 'CMD', 'U3', 'RELAY'),
    ]
    const resolved = resolveEngineFrameConfiguredLinks(makeFrame([
      makeSegment({ linkId: 'S1', linkIds: ['L-CONFLICT'], sourcePlatformId: 'CMD', targetPlatformId: 'RELAY', status: 'UP' }),
      makeSegment({ linkId: 'S2', linkIds: ['L-CONFLICT'], sourcePlatformId: 'CMD', targetPlatformId: 'U1', status: 'UP' }),
      makeSegment({ linkId: 'B-TRUNK', linkIds: ['L-BOTH', 'L-BYPASS-OK'], sourcePlatformId: 'CMD', targetPlatformId: 'RELAY', status: 'UP' }),
      makeSegment({ linkId: 'B-H2', linkIds: ['L-BOTH'], sourcePlatformId: 'RELAY', targetPlatformId: 'U2', status: 'UP' }),
      makeSegment({ linkId: 'B-DIR', linkIds: ['L-BOTH'], sourcePlatformId: 'CMD', targetPlatformId: 'U2', status: 'UP' }),
      makeSegment({ linkId: 'D-SH', linkIds: ['L-DIRECT-SHARED', 'OTHER'], sourcePlatformId: 'CMD', targetPlatformId: 'U1', status: 'UP' }),
      makeSegment({ linkId: 'D-1', linkIds: ['L-DIRECT-DUP'], sourcePlatformId: 'CMD', targetPlatformId: 'U2', status: 'UP' }),
      makeSegment({ linkId: 'D-2', linkIds: ['L-DIRECT-DUP'], sourcePlatformId: 'CMD', targetPlatformId: 'U2', status: 'UP' }),
      makeSegment({ linkId: 'BYP-OK', linkIds: ['L-BYPASS-OK'], sourcePlatformId: 'CMD', targetPlatformId: 'U3', status: 'DEGRADED' }),
    ]), links)

    expect(resolved.has('L-CONFLICT')).toBe(false)
    expect(resolved.has('L-BOTH')).toBe(false)
    expect(resolved.has('L-DIRECT-SHARED')).toBe(false)
    expect(resolved.has('L-DIRECT-DUP')).toBe(false)
    expect(resolved.get('L-BYPASS-OK')).toMatchObject({ status: 'DEGRADED', relayBypassed: true, gxbDb: 14, ber: 1e-6, receivedPowerDbm: -50, distanceM: 1000 })
  })
})

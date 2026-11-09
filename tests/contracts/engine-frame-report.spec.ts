import { describe, expect, it } from 'vitest'
import { filterEngineFrameArchive } from '../../src/features/reports/engine-frame-report'
import { LOCAL_REPORT } from '../fixtures/local-report'

const segment = { linkId: 'ENGINE-HOP-1', linkIds: ['L-1'], sourceName: 'A', sourcePlatformId: 'A', sourcePort: 'tx', targetName: 'B', targetPlatformId: 'B', targetPort: 'rx', status: 'UP', engineStatus: 'AVAILABLE', error: null, distanceM: null,
  losses: { freeSpaceDb: null, seaMultipathDb: null, atmosphericDb: null, cloudRainDb: null, jammingDb: null, totalDb: null }, quality: { gxbDb: 8, ber: 0.01, rxPowerDbw: null, rxPowerDbm: null }, inputTrace: { eirpDbw: null, gtDbk: null, dataRateMbps: null, frequencyGHz: null, jammers: [] } }

describe('引擎帧报告筛选', () => {
  it('用同帧真实段的 linkIds 将引擎原因段映射到场景链路，且旧路径节点可命中', () => {
    const archive: any = { sourceSha256: 'a'.repeat(64), frameCount: 1, firstSimulationTime: 5, lastSimulationTime: 5, missingFieldNames: ['snrDb'], segmentRows: [{ engineEpoch: 0, frameId: 7, simulationTime: 5, segment }],
      switchRows: [{ engineEpoch: 0, frameId: 7, simulationTime: 5, value: { pathId: 'NEW', direction: 'FORWARD', sourceName: 'A', targetName: 'B', sourcePlatformId: 'A', targetPlatformId: 'B', transTypes: [], nodes: [], oldPathId: 'OLD', oldNodes: [{ platformName: 'legacy', platformId: 'B', inPort: null, outPort: null }], reasons: [{ linkId: 'ENGINE-HOP-1', reasons: ['RISK'] }] } }], eventRows: [] }
    const filtered = filterEngineFrameArchive(archive, LOCAL_REPORT.localEvidence!, { nodeId: 'B', linkId: 'L-1' })
    expect(filtered.switchRows).toHaveLength(1)
    expect(filtered.segmentRows).toHaveLength(1)
  })
})

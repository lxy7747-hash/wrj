import { describe, expect, it } from 'vitest'
import { attachEngineFrameArchive, filterEngineFrameArchive } from '../../src/features/reports/engine-frame-report'
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

  it('引擎段与阶段半开边界一致：边界帧只归后阶段，末阶段仅在等于报告结束时含末点', () => {
    const phases = [{ id: 'A', name: '前段', startTimeS: 0, endTimeS: 10 }, { id: 'B', name: '后段', startTimeS: 10, endTimeS: 20 }]
    const evidence = { ...LOCAL_REPORT.localEvidence!, startTimeS: 0, endTimeS: 20 }
    const rows = [0, 9, 10, 19, 20].map((simulationTime, frameId) => ({ engineEpoch: 0, frameId, simulationTime, segment }))
    const archive: any = { sourceSha256: 'a'.repeat(64), frameCount: 5, firstSimulationTime: 0, lastSimulationTime: 20, missingFieldNames: [], segmentRows: rows, switchRows: [], eventRows: [] }
    expect(filterEngineFrameArchive(archive, evidence, { stage: 'A' }, phases).segmentRows.map(row => row.simulationTime)).toEqual([0, 9])
    expect(filterEngineFrameArchive(archive, evidence, { stage: 'B' }, phases).segmentRows.map(row => row.simulationTime)).toEqual([10, 19, 20])
    // 报告实际结束 25 秒时，B 的 20 秒末点不属于任何阶段。
    expect(filterEngineFrameArchive(archive, { ...evidence, endTimeS: 25 }, { stage: 'B' }, phases).segmentRows.map(row => row.simulationTime)).toEqual([10, 19])
  })

  it.each([0.25, 12.75, 175.25])('真实亚秒帧号 %s 能附加到报表并保留缺测值', (frameId) => {
    const archive: any = { sourceSha256: 'a'.repeat(64), frameCount: 1, firstSimulationTime: 1, lastSimulationTime: 1,
      missingFieldNames: ['receivedPower'], segmentRows: [{ engineEpoch: 0, frameId, simulationTime: 1, segment }], switchRows: [], eventRows: [] }
    const report = attachEngineFrameArchive(LOCAL_REPORT, archive)
    expect(report.localEvidence!.engineFrameArchive!.segmentRows[0]!.frameId).toBe(frameId)
    expect(report.localEvidence!.engineFrameArchive!.segmentRows[0]!.segment.quality.rxPowerDbm).toBeNull()
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '0.25'])('报表仍拒绝非法帧号 %s', (frameId) => {
    const archive: any = { sourceSha256: 'a'.repeat(64), frameCount: 1, firstSimulationTime: 1, lastSimulationTime: 1,
      missingFieldNames: [], segmentRows: [{ engineEpoch: 0, frameId, simulationTime: 1, segment }], switchRows: [], eventRows: [] }
    expect(() => attachEngineFrameArchive(LOCAL_REPORT, archive)).toThrow('附加后的引擎帧归档未通过边界校验。')
  })
})

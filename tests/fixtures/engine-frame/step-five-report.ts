import { LOCAL_REPORT } from '../local-report'
import initial from './websocket-new/fream001.json'
import { adaptEngineFrameSnapshot } from '../../../src/features/data-exchange/engine-frame-snapshot'

/** 正常 5 秒帧及缺少帧 20 的报告，用于页面和导出的一致性回归。 */
export const STEP_FIVE_REPORT = structuredClone(LOCAL_REPORT)
STEP_FIVE_REPORT.localEvidence.endTimeS = 30
STEP_FIVE_REPORT.localEvidence.engineFrameArchive = {
  sourceSha256: 'e'.repeat(64), frameCount: 4, firstSimulationTime: 5, lastSimulationTime: 25, missingFieldNames: [],
  segmentRows: [5, 10, 15, 25].map(frameId => {
    const frame = adaptEngineFrameSnapshot({ ...initial, frame_id: frameId, sim_time_s: frameId * 1000 }).data!
    return { engineEpoch: 0, frameId, simulationTime: frame.simulationTime,
      segment: { ...frame.links[0]!, sourcePlatformId: 'A', targetPlatformId: 'B' } }
  }), switchRows: [], eventRows: [],
}

import { LOCAL_REPORT } from '../local-report'
import samples from './websocket-latest.json'
import { adaptEngineFrameSnapshot } from '../../../src/features/data-exchange/engine-frame-snapshot'

export const LATEST_FRAMES = samples.map(raw => ({ ...adaptEngineFrameSnapshot(raw).data!, runId: 'RUN-LATEST' }))
export const LATEST_FRAME_REPORT = structuredClone(LOCAL_REPORT)
LATEST_FRAME_REPORT.localEvidence.endTimeS = 3780
LATEST_FRAME_REPORT.localEvidence.engineFrameArchive = {
  sourceSha256: 'e'.repeat(64), frameCount: 2, firstSimulationTime: 3775, lastSimulationTime: 3780,
  missingFieldNames: ['snrDb', 'receivedPower'],
  segmentRows: LATEST_FRAMES.flatMap(frame => frame.links.map(segment => ({ engineEpoch: 0, frameId: frame.frameId, simulationTime: frame.simulationTime, segment }))),
  switchRows: [], eventRows: [],
}

import { LOCAL_REPLAY } from '../local-replay'
import { LOCAL_REPORT } from '../local-report'
import latest from './websocket-latest.json'
import alarm from './websocket-new/fream_chenge3.json'
import { adaptEngineFrameSnapshot } from '../../../src/features/data-exchange/engine-frame-snapshot'
import type { EngineReplaySnapshot } from '../../../src/features/replays/engine-replay'
import type { MissionResultSnapshot } from '../../../src/features/results/mission-result'

export const ENGINE_RESULT_ID = 'RESULT-11111111-1111-4111-8111-111111111111'
export const ENGINE_RESULT: MissionResultSnapshot = {
  record: { resultId: ENGINE_RESULT_ID, runId: 'RUN-HISTORY', taskId: 'TASK-001', scenarioId: 'SCN-HISTORY', scenarioName: '历史场景', revision: 1, startedAt: '2026-11-10T00:00:00Z', completedAt: '2026-11-10T00:01:00Z', executionSource: 'REMOTE_WS' },
  replay: structuredClone(LOCAL_REPLAY), report: structuredClone(LOCAL_REPORT),
}
ENGINE_RESULT.report.localEvidence!.eventFile = { fileName: LOCAL_REPLAY.initial.fileName, sha256: LOCAL_REPLAY.initial.sha256 }
ENGINE_RESULT.report.localEvidence!.positionFile = { fileName: LOCAL_REPLAY.fileName, sha256: LOCAL_REPLAY.sha256 }
const first = { ...adaptEngineFrameSnapshot({ ...latest[0], frame_id: 5 }).data!, runId: 'RUN-HISTORY' }
const second = { ...adaptEngineFrameSnapshot({ ...alarm, frame_id: 10 }).data!, runId: 'RUN-HISTORY' }
second.routing.alarms = [{ pathId: 'HISTORY-PATH', linkId: 'HISTORY-LINK', message: '历史链路告警' }]
second.events = [{ type: 'alarm_switch', pathId: 'HISTORY-PATH', uavNames: ['A'], uavIds: ['A'], jammerNames: [], jammerIds: [] }]

export function engineReplayAt(time: number, runId = 'RUN-HISTORY', scenarioId = 'SCN-HISTORY'): EngineReplaySnapshot {
  const engineFrame = time < 5 ? null : { ...structuredClone(time < 10 ? first : second), runId }
  return { runId, scenarioId, sourceSha256: 'e'.repeat(64), frameCount: 2,
    epochs: [{ engineEpoch: 0, frameCount: 2, firstTime: 5, lastTime: 10 }], engineEpoch: 0, time,
    nextFrameTime: time < 5 ? 5 : time < 10 ? 10 : null, historyTruncated: false, links: [], engineFrame,
    engineEvents: time < 10 ? [] : second.events.map(event => ({ frameId: 10, simulationTime: 10, event: structuredClone(event) })),
    engineSwitches: time < 10 ? [] : second.routing.switches.map(route => ({ frameId: 10, simulationTime: 10, route: structuredClone(route) })),
    engineAlarms: time < 10 ? [] : second.routing.alarms.map(item => ({ frameId: 10, simulationTime: 10, alarm: structuredClone(item) })),
  }
}

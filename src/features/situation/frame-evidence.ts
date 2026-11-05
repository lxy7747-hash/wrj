import type { JammerExecutionEvidence, TelemetryFrame } from '../../contracts/domain-models'

/** 兼容旧服务端单台证据；调用方仍须先通过遥测帧校验。 */
export function frameJammerExecutions(frame: TelemetryFrame): JammerExecutionEvidence[] {
  return frame.evidence.jammerExecutions ?? [frame.evidence.jammerExecution]
}

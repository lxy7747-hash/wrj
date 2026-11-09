import type { MissionPositionUpdate, SimulationRun } from '../../src/contracts/domain-models.js'
import type { MissionPositionSnapshot } from '../../src/features/situation/mission-positions.js'

export type ReadMissionPositions = () => Promise<MissionPositionSnapshot | null>

/**
 * Polls only the mission-owned append reader and emits a snapshot when its
 * source generation/record count/latest positions change.  The WebSocket
 * journal sequence orders these source samples; it is deliberately unrelated
 * to an external engine frame id or simulation-frame envelope.
 */
export class MissionPositionStreamer {
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private reading = false
  private previous = ''

  constructor(
    private readonly read: ReadMissionPositions,
    private readonly publish: (update: MissionPositionUpdate) => void,
    private readonly run: Pick<SimulationRun, 'runId' | 'scenarioId'> & { revision: number },
    private readonly intervalMs = 1_000,
  ) {}

  async poll(expectedGeneration = this.generation): Promise<void> {
    if (expectedGeneration !== this.generation) return
    if (this.reading) return
    this.reading = true
    try {
      const snapshot = await this.read()
      // A stopped/restarted stream must never publish the result of its old read.
      if (expectedGeneration !== this.generation) return
      if (snapshot === null || snapshot.runId !== this.run.runId || snapshot.scenarioId !== this.run.scenarioId || snapshot.revision !== this.run.revision || snapshot.positions === null) return
      const source = snapshot.positions
      const fingerprint = JSON.stringify([source.generation, source.recordCount, source.waitingForLine, source.nodes])
      if (fingerprint === this.previous) return
      this.previous = fingerprint
      this.publish({
        kind: 'MISSION_POSITION', runId: this.run.runId, scenarioId: this.run.scenarioId, revision: this.run.revision,
        sourceGeneration: source.generation, sourceRecordCount: source.recordCount, waitingForLine: source.waitingForLine,
        nodes: structuredClone(source.nodes),
      })
    } finally { this.reading = false }
  }

  start(): void {
    if (this.timer !== undefined) return
    const generation = ++this.generation
    const schedule = (): void => {
      this.timer = setTimeout(async () => {
        this.timer = undefined
        if (generation !== this.generation) return
        try { await this.poll(generation) } catch { /* HTTP position endpoint remains the recovery path. */ }
        if (generation === this.generation) schedule()
      }, this.intervalMs)
    }
    // The first read follows the same failure policy as later polls: a failed
    // source is retried by the scheduled poll instead of becoming unhandled.
    void this.poll(generation).catch(() => undefined)
    schedule()
  }

  stop(): void {
    ++this.generation
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.previous = ''
  }
}

import type { MissionLogUpdate, SimulationRun } from '../../src/contracts/domain-models.js'

export interface MissionConsoleTail {
  text: string
  bytes: number
  truncated: boolean
}

export type ReadMissionConsoleTail = () => Promise<MissionConsoleTail>

/** Keeps each websocket record well below the transport message limit. */
const MAX_UPDATE_UTF8_BYTES = 16 * 1024
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength

export function splitUtf8(value: string, maximumBytes = MAX_UPDATE_UTF8_BYTES): string[] {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new RangeError('maximumBytes must be a positive safe integer.')
  if (value.length === 0) return ['']
  const chunks: string[] = []
  let chunk = ''
  let bytes = 0
  for (const character of value) {
    const size = utf8Bytes(character)
    if (bytes > 0 && bytes + size > maximumBytes) {
      chunks.push(chunk)
      chunk = ''
      bytes = 0
    }
    // A single Unicode scalar is at most four UTF-8 bytes.  Keeping it intact
    // is more important than an impossibly tiny caller limit.
    chunk += character
    bytes += size
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

/**
 * Converts complete UTF-8 console-tail snapshots into ordered updates.
 *
 * The HTTP console endpoint remains the initial/recovery source.  The first
 * successful read here is therefore a baseline, not a websocket replay of a
 * potentially large old log.  A rotated, truncated, or otherwise non-prefix
 * snapshot is sent as an explicit replacement so it cannot be appended onto
 * the wrong run's output.
 */
export class MissionLogStreamer {
  private previous: MissionConsoleTail | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private reading = false

  constructor(
    private readonly read: ReadMissionConsoleTail,
    private readonly publish: (update: MissionLogUpdate) => void,
    private readonly runId: SimulationRun['runId'],
    private readonly intervalMs = 1_000,
  ) {}

  async prime(): Promise<void> {
    this.previous = await this.read()
  }

  async poll(): Promise<void> {
    if (this.reading) return
    this.reading = true
    try {
      const current = await this.read()
      const previous = this.previous
      this.previous = current
      if (previous === undefined) return
      if (current.bytes === previous.bytes && current.text === previous.text && current.truncated === previous.truncated) return

      const canAppend = current.bytes >= previous.bytes
        && !current.truncated
        && !previous.truncated
        && current.text.startsWith(previous.text)
      this.publishText(canAppend ? current.text.slice(previous.text.length) : current.text, !canAppend, current, canAppend ? previous.bytes : 0)
    } finally {
      this.reading = false
    }
  }

  async start(): Promise<void> {
    if (this.timer !== undefined) return
    const generation = ++this.generation
    await this.prime()
    if (generation !== this.generation) return
    const schedule = (): void => {
      this.timer = setTimeout(async () => {
        this.timer = undefined
        if (generation !== this.generation) return
        try { await this.poll() } catch { /* REST console remains the recovery path. */ }
        if (generation === this.generation) schedule()
      }, this.intervalMs)
    }
    schedule()
  }

  stop(): void {
    ++this.generation
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.previous = undefined
  }

  private publishText(text: string, replace: boolean, snapshot: MissionConsoleTail, startByteOffset: number): void {
    const chunks = splitUtf8(text)
    chunks.forEach((chunk, index) => this.publish({
      kind: 'MISSION_LOG', runId: this.runId, text: chunk,
      replace: replace && index === 0, bytes: snapshot.bytes, truncated: snapshot.truncated,
      chunkIndex: index, chunkCount: chunks.length,
      startByteOffset, endByteOffset: snapshot.bytes,
    }))
  }
}

import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { TaskId, WsTopic } from '../../src/contracts/domain-models.js'
import type { JournalEvent, JournalRead, RealtimeJournalStore } from '../ws/realtime-journal.js'

interface State { latest?: number; boundary?: number; runId?: string; hot: JournalEvent[]; failure?: string }
interface DiskEvent extends JournalEvent { digest: string }
interface Entry { sequence: number; offset: number; length: number }
interface TopicMeta { boundary?: number; runId: string }

const RECORD_BYTES = 24
const MAX_PAGE_BYTES = 4 * 1024 * 1024
const MAX_PAGE_EVENTS = 512
const TOPICS: WsTopic[] = ['simulation.frame', 'runtime.state', 'link.metric', 'jammer.event', 'switch.event']

/** Local-only durable journal; fixed offsets keep memory independent of historical file size. */
export class DiskRealtimeJournal implements RealtimeJournalStore {
  private readonly states = new Map<string, State>()
  private generation: string | undefined

  constructor(private readonly root: string, private readonly limit = 128) {}

  next(task: TaskId, topic: WsTopic): number { return (this.state(task, topic).latest ?? 0) + 1 }

  append(task: TaskId, topic: WsTopic, event: JournalEvent): void {
    const state = this.state(task, topic)
    if (state.failure) throw new Error(state.failure)
    try {
      if (!Number.isSafeInteger(event.sequence) || event.sequence !== (state.latest ?? 0) + 1
        || typeof event.message !== 'string') throw new Error('invalid or discontinuous event')
      const record: DiskEvent = { ...event, digest: this.digest(event.message) }
      const line = JSON.stringify(record) + '\n'
      const length = Buffer.byteLength(line)
      if (length > MAX_PAGE_BYTES) throw new Error('event exceeds replay record byte limit')
      mkdirSync(this.dir(task, topic), { recursive: true })
      const path = this.events(task, topic)
      const offset = existsSync(path) ? this.regularFileSize(path) : 0
      if (existsSync(this.index(task, topic))) this.regularFileSize(this.index(task, topic))
      const index = Buffer.alloc(RECORD_BYTES)
      index.writeBigUInt64LE(BigInt(event.sequence), 0)
      index.writeBigUInt64LE(BigInt(offset), 8)
      index.writeUInt32LE(length, 16)
      // Publish only after both data and index have been committed.
      appendFileSync(path, line, { encoding: 'utf8', flush: true })
      appendFileSync(this.index(task, topic), index, { flush: true })
      state.latest = event.sequence
      state.hot.push(event)
      if (state.hot.length > this.limit) state.hot.splice(0, state.hot.length - this.limit)
    } catch (error) {
      state.failure = 'Unable to persist realtime event journal for ' + task + '/' + topic + ': ' + this.message(error)
      throw new Error(state.failure)
    }
  }

  prepareRun(task: TaskId, runId: string): boolean {
    const states = TOPICS.map(topic => this.state(task, topic))
    const failed = states.find(state => state.failure)
    if (failed) throw new Error(failed.failure)
    if (states.every(state => state.runId === runId)) return false
    // A partially committed context or old unbound history must fail closed too.
    const changed = states.some(state => state.runId !== undefined || state.latest !== undefined)
    const next: TopicMeta[] = states.map(state => ({
      boundary: changed ? (state.latest ?? 0) + 1 : state.boundary, runId,
    }))
    try {
      TOPICS.forEach((topic, index) => this.atomicJson(this.meta(task, topic), next[index]!))
    } catch (error) {
      const reason = 'Unable to persist realtime run boundary: ' + this.message(error)
      states.forEach(state => { state.failure = reason })
      throw new Error(reason)
    }
    states.forEach((state, index) => {
      state.boundary = next[index]!.boundary
      state.runId = runId
      if (changed) state.hot = []
    })
    return changed
  }

  canResume(task: TaskId, topic: WsTopic, cursor: number, _resumesAny: boolean): JournalRead {
    const state = this.state(task, topic)
    if (state.failure) return { ok: false, reason: state.failure }
    const first = state.latest === undefined ? undefined : state.boundary ?? 1
    if (cursor === 0) return { ok: true, events: [], first, latest: state.latest }
    if (state.latest === undefined) return { ok: false, reason: 'No retained realtime history for ' + topic + '.' }
    const minimum = state.boundary ?? 0
    if (cursor < minimum || cursor > state.latest) {
      return { ok: false, reason: 'Requested sequence ' + cursor + ' is outside the retained realtime range ' + minimum + '..' + state.latest + ' for ' + topic + '.' }
    }
    return { ok: true, events: [], first, latest: state.latest }
  }

  readAfter(task: TaskId, topic: WsTopic, cursor: number, pageSize: number): JournalRead {
    const state = this.state(task, topic)
    if (state.failure) return { ok: false, reason: state.failure }
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_EVENTS) {
      return { ok: false, reason: 'Invalid replay cursor or page size.' }
    }
    // A zero cursor in a mixed subscription may only see this run's events.
    const start = Math.max(cursor, (state.boundary ?? 1) - 1)
    if (!state.latest || start >= state.latest) return { ok: true, events: [], latest: state.latest }
    try {
      const entries = this.entries(task, topic, start, Math.min(pageSize, state.latest - start))
      const selected: Entry[] = []
      let bytes = 0
      for (const entry of entries) {
        if (selected.length > 0 && bytes + entry.length > MAX_PAGE_BYTES) break
        selected.push(entry)
        bytes += entry.length
      }
      return { ok: true, events: selected.map(entry => this.event(task, topic, entry)), first: state.boundary ?? 1, latest: state.latest }
    } catch (error) {
      state.failure = 'Realtime journal is corrupt for ' + task + '/' + topic + ': ' + this.message(error)
      return { ok: false, reason: state.failure }
    }
  }

  clear(): void {
    const generation = randomUUID()
    this.atomicJson(this.active(), { generation })
    this.generation = generation
    this.states.clear()
  }

  private state(task: TaskId, topic: WsTopic): State {
    const key = task + '\u0000' + topic
    const current = this.states.get(key)
    if (current) return current
    const state: State = { hot: [] }
    this.states.set(key, state)
    try {
      this.ensure()
      const indexPath = this.index(task, topic), eventPath = this.events(task, topic)
      const indexBytes = existsSync(indexPath) ? this.regularFileSize(indexPath) : 0
      const eventBytes = existsSync(eventPath) ? this.regularFileSize(eventPath) : 0
      if (indexBytes % RECORD_BYTES !== 0) throw new Error('truncated index')
      const count = indexBytes / RECORD_BYTES
      if (count === 0 && eventBytes !== 0) throw new Error('event data exists without an index')
      if (count > 0) {
        const first = this.entries(task, topic, 0, 1)[0]!
        const last = this.entries(task, topic, count - 1, 1)[0]!
        if (first.offset !== 0 || last.offset + last.length !== eventBytes) throw new Error('unindexed or truncated event data')
        this.event(task, topic, last)
        state.latest = count
      }
      if (existsSync(this.meta(task, topic))) {
        const value = this.readJson(this.meta(task, topic))
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).some(key => key !== 'boundary' && key !== 'runId')) throw new Error('invalid run metadata')
        const meta = value as Partial<TopicMeta>
        if (typeof meta.runId !== 'string' || !/^RUN-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(meta.runId)) throw new Error('invalid run identity')
        if (meta.boundary !== undefined && (!Number.isSafeInteger(meta.boundary) || meta.boundary < 1
          || meta.boundary > (state.latest ?? 0) + 1)) throw new Error('invalid run boundary')
        state.runId = meta.runId
        state.boundary = meta.boundary
      }
    } catch (error) {
      state.failure = 'Realtime journal is corrupt for ' + task + '/' + topic + ': ' + this.message(error)
    }
    return state
  }

  private entries(task: TaskId, topic: WsTopic, start: number, count: number): Entry[] {
    const bytes = count * RECORD_BYTES
    const buffer = Buffer.alloc(bytes)
    const file = openSync(this.index(task, topic), 'r')
    try {
      if (readSync(file, buffer, 0, bytes, start * RECORD_BYTES) !== bytes) throw new Error('truncated index page')
    } finally { closeSync(file) }
    return Array.from({ length: count }, (_, index) => {
      const position = index * RECORD_BYTES
      const sequence = Number(buffer.readBigUInt64LE(position))
      const offset = Number(buffer.readBigUInt64LE(position + 8))
      const length = buffer.readUInt32LE(position + 16)
      if (!Number.isSafeInteger(sequence) || sequence !== start + index + 1 || !Number.isSafeInteger(offset)
        || length < 1 || length > MAX_PAGE_BYTES) throw new Error('invalid index record')
      return { sequence, offset, length }
    })
  }

  private event(task: TaskId, topic: WsTopic, entry: Entry): JournalEvent {
    const buffer = Buffer.alloc(entry.length)
    const file = openSync(this.events(task, topic), 'r')
    try {
      if (readSync(file, buffer, 0, entry.length, entry.offset) !== entry.length) throw new Error('truncated event record')
    } finally { closeSync(file) }
    const item = JSON.parse(buffer.toString('utf8').replace(/\r?\n$/, '')) as Partial<DiskEvent>
    if (item.sequence !== entry.sequence || typeof item.message !== 'string' || item.digest !== this.digest(item.message)) {
      throw new Error('invalid event record')
    }
    return { sequence: item.sequence, message: item.message }
  }

  private ensure(): void {
    if (this.generation) return
    mkdirSync(this.root, { recursive: true })
    if (existsSync(this.active())) {
      const value = this.readJson(this.active()) as { generation?: unknown } | null
      if (!value || typeof value.generation !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.generation)) {
        throw new Error('invalid active generation')
      }
      this.generation = value.generation
    } else {
      const generation = randomUUID()
      this.atomicJson(this.active(), { generation })
      this.generation = generation
    }
  }

  private atomicJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true })
    const pending = path + '.' + randomUUID() + '.pending'
    writeFileSync(pending, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', flush: true })
    renameSync(pending, path)
  }

  private readJson(path: string): unknown {
    if (this.regularFileSize(path) > 32 * 1024) throw new Error('oversized journal metadata')
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  }

  private regularFileSize(path: string): number {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size)) throw new Error('journal source is not a regular file')
    return stat.size
  }
  private task(task: TaskId): string { this.ensure(); return join(this.root, createHash('sha256').update(task).digest('hex'), this.generation!) }
  private dir(task: TaskId, topic: WsTopic): string { return join(this.task(task), topic) }
  private events(task: TaskId, topic: WsTopic): string { return join(this.dir(task, topic), 'events.ndjson') }
  private index(task: TaskId, topic: WsTopic): string { return join(this.dir(task, topic), 'events.idx') }
  private meta(task: TaskId, topic: WsTopic): string { return join(this.dir(task, topic), 'meta.json') }
  private active(): string { return join(this.root, 'active.json') }
  private digest(message: string): string { return createHash('sha256').update(message).digest('hex') }
  private message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
}

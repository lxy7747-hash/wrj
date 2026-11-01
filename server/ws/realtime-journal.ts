import type { TaskId, WsTopic } from '../../src/contracts/domain-models.js'

export interface JournalEvent { sequence: number; message: string }
export type JournalRead = { ok: true; events: JournalEvent[]; first?: number; latest?: number } | { ok: false; reason: string }
export interface RealtimeJournalStore {
  next(taskId: TaskId, topic: WsTopic): number
  append(taskId: TaskId, topic: WsTopic, event: JournalEvent): void
  /** Returns true only when a distinct run invalidated earlier cursors. */
  prepareRun(taskId: TaskId, runId: string): boolean
  canResume(taskId: TaskId, topic: WsTopic, cursor: number, resumesAnyTopic: boolean): JournalRead
  readAfter(taskId: TaskId, topic: WsTopic, cursor: number, pageSize: number): JournalRead
  clear(): void
}

interface State { latest?: number; boundary?: number; hot: JournalEvent[] }
const TOPICS: WsTopic[] = ['simulation.frame', 'runtime.state', 'link.metric', 'jammer.event', 'switch.event']

/** Bounded pure-memory fallback for Mock servers; it has no filesystem capability. */
export class MemoryRealtimeJournal implements RealtimeJournalStore {
  private readonly states = new Map<string, State>()
  private readonly runs = new Map<TaskId, string>()
  constructor(private readonly limit = 128) {}
  next(taskId: TaskId, topic: WsTopic): number { return (this.state(taskId, topic).latest ?? 0) + 1 }
  append(taskId: TaskId, topic: WsTopic, event: JournalEvent): void {
    const state = this.state(taskId, topic)
    const expected = (state.latest ?? 0) + 1
    if (event.sequence !== expected) throw new Error(`Journal sequence discontinuity for ${taskId}/${topic}: expected ${expected}, received ${event.sequence}.`)
    state.latest = event.sequence; state.hot.push(event)
    if (state.hot.length > this.limit) state.hot.splice(0, state.hot.length - this.limit)
  }
  prepareRun(taskId: TaskId, runId: string): boolean {
    const previous = this.runs.get(taskId)
    if (previous === runId) return false
    this.runs.set(taskId, runId)
    if (previous === undefined) return false
    for (const topic of TOPICS) { const state = this.state(taskId, topic); state.boundary = (state.latest ?? 0) + 1; state.hot = [] }
    return true
  }
  canResume(taskId: TaskId, topic: WsTopic, cursor: number, resumesAnyTopic: boolean): JournalRead {
    const state = this.state(taskId, topic); const first = state.hot[0]?.sequence
    if (cursor === 0) return resumesAnyTopic && first !== undefined && first !== 1 && state.boundary === undefined ? { ok: false, reason: `Realtime history for ${topic} starts at ${first}; cursor 0 cannot fill the missing range.` } : { ok: true, events: [], first, latest: state.latest }
    if (state.latest === undefined || first === undefined) return { ok: false, reason: `No retained realtime history for ${topic}.` }
    const minimum = state.boundary ?? first - 1
    return cursor < minimum || cursor > state.latest ? { ok: false, reason: `Requested sequence ${cursor} is outside the retained realtime range ${minimum}..${state.latest} for ${topic}.` } : { ok: true, events: [], first, latest: state.latest }
  }
  readAfter(taskId: TaskId, topic: WsTopic, cursor: number, pageSize: number): JournalRead { const state = this.state(taskId, topic); return { ok: true, events: state.hot.filter(event => event.sequence > cursor).slice(0, pageSize), first: state.hot[0]?.sequence, latest: state.latest } }
  clear(): void { this.states.clear(); this.runs.clear() }
  private state(taskId: TaskId, topic: WsTopic): State { const key = `${taskId}\u0000${topic}`; let state = this.states.get(key); if (!state) { state = { hot: [] }; this.states.set(key, state) }; return state }
}

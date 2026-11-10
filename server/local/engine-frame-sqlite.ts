import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { EngineFrameSnapshot } from '../../src/contracts/domain-models.js'
import { isEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot.js'
import { isEngineReplaySnapshot, type EngineReplaySnapshot } from '../../src/features/replays/engine-replay.js'
import type { EngineFrameArchiveScope } from './engine-frame-archive.js'
import type { EngineLinkBinding } from './engine-frame-csv.js'
import { readStableUtf8Lines } from './afsim-log-reader.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const identity = (s: EngineFrameArchiveScope) => JSON.stringify([s.taskId, s.runId, s.scenarioId, s.revision, s.startedAt])

/** One shared history database; all reads and writes retain the immutable run scope. */
export class EngineFrameSqliteStorage {
  private readonly db: DatabaseSync
  private tail: Promise<unknown> = Promise.resolve()
  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('引擎历史数据库路径必须为绝对路径。')
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS engine_runs (
          run_id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL, scope_json TEXT NOT NULL,
          bindings_json TEXT NOT NULL, source_sha256 TEXT, frame_count INTEGER
        ) STRICT;
        CREATE INDEX IF NOT EXISTS engine_runs_scenario ON engine_runs(scenario_id, run_id);
        CREATE TABLE IF NOT EXISTS engine_frames (
          sequence INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES engine_runs(run_id),
          engine_epoch INTEGER NOT NULL, frame_id INTEGER NOT NULL, simulation_time REAL NOT NULL,
          payload TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(run_id, engine_epoch, frame_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS engine_frames_time ON engine_frames(run_id, engine_epoch, simulation_time, frame_id);
        CREATE TABLE IF NOT EXISTS engine_items (
          frame_sequence INTEGER NOT NULL REFERENCES engine_frames(sequence), kind TEXT NOT NULL,
          item_index INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(frame_sequence, kind, item_index)
        ) STRICT;`)
    } catch (error) { this.db.close(); throw error }
  }

  // Import holds a transaction across file reads; live writes wait instead of joining that transaction.
  private serial<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(action)
    this.tail = result.catch(() => undefined)
    return result
  }
  private scope(scope: EngineFrameArchiveScope) {
    const row = this.db.prepare('SELECT * FROM engine_runs WHERE run_id=?').get(scope.runId)
    if (row && (row.scope_json !== identity(scope) || row.scenario_id !== scope.scenarioId)) throw new Error('引擎历史运行归属与请求不一致。')
    return row
  }
  private beginRun(scope: EngineFrameArchiveScope, bindings: Readonly<Record<string, EngineLinkBinding>>) {
    const row = this.scope(scope)
    if (row) {
      if (row.bindings_json !== JSON.stringify(bindings)) throw new Error('引擎历史绑定与本次运行不一致。')
      return
    }
    this.db.prepare('INSERT INTO engine_runs(run_id,scenario_id,scope_json,bindings_json) VALUES(?,?,?,?)')
      .run(scope.runId, scope.scenarioId, identity(scope), JSON.stringify(bindings))
  }
  begin(scope: EngineFrameArchiveScope, bindings: Readonly<Record<string, EngineLinkBinding>>): Promise<void> {
    return this.serial(() => this.beginRun(scope, bindings))
  }
  private insert(scope: EngineFrameArchiveScope, frame: EngineFrameSnapshot) {
    if (!isEngineFrameSnapshot(frame) || frame.runId !== scope.runId) throw new Error('引擎历史帧格式或运行归属无效。')
    const run = this.scope(scope)
    if (!run) throw new Error('引擎历史运行尚未创建。')
    const payload = JSON.stringify(frame), digest = sha(payload)
    const old = this.db.prepare('SELECT digest FROM engine_frames WHERE run_id=? AND engine_epoch=? AND frame_id=?').get(scope.runId, frame.engineEpoch, frame.frameId)
    if (old) { if (old.digest !== digest) throw new Error('同一运行、轮次和帧号的数据发生冲突。'); return }
    if (run.source_sha256 !== null) throw new Error('已完成的历史运行不可追加。')
    const result = this.db.prepare('INSERT INTO engine_frames(run_id,engine_epoch,frame_id,simulation_time,payload,digest) VALUES(?,?,?,?,?,?)')
      .run(scope.runId, frame.engineEpoch, frame.frameId, frame.simulationTime, payload, digest)
    const item = this.db.prepare('INSERT INTO engine_items VALUES(?,?,?,?)')
    for (const [kind, values] of [['event', frame.events], ['route', frame.routing.switches], ['alarm', frame.routing.alarms]] as const) {
      values.forEach((value, index) => item.run(result.lastInsertRowid, kind, index, JSON.stringify(value)))
    }
  }
  append(scope: EngineFrameArchiveScope, frame: EngineFrameSnapshot): Promise<void> {
    return this.serial(() => {
      this.db.exec('BEGIN IMMEDIATE')
      try { this.insert(scope, frame); this.db.exec('COMMIT') }
      catch (error) { this.db.exec('ROLLBACK'); throw error }
    })
  }
  private finish(scope: EngineFrameArchiveScope, sourceSha256: string, frameCount: number) {
    const run = this.scope(scope)
    if (!run) throw new Error('引擎历史运行不存在。')
    if (run.source_sha256 !== null) {
      if (run.source_sha256 !== sourceSha256 || run.frame_count !== frameCount) throw new Error('引擎历史来源版本冲突。')
      return
    }
    const digest = createHash('sha256'); let count = 0
    for (const row of this.db.prepare('SELECT payload FROM engine_frames WHERE run_id=? ORDER BY sequence').iterate(scope.runId)) {
      digest.update(`${String(row.payload)}\n`); count++
    }
    if (count !== frameCount || digest.digest('hex') !== sourceSha256) throw new Error('引擎数据库与文件归档的帧数或摘要不一致。')
    this.db.prepare('UPDATE engine_runs SET source_sha256=?,frame_count=? WHERE run_id=?').run(sourceSha256, frameCount, scope.runId)
  }
  complete(scope: EngineFrameArchiveScope, sourceSha256: string, frameCount: number): Promise<void> {
    return this.serial(() => this.finish(scope, sourceSha256, frameCount))
  }
  ensureLegacy(scope: EngineFrameArchiveScope, bindings: Readonly<Record<string, EngineLinkBinding>>, rawPath: string, sourceSha256: string, frameCount: number): Promise<void> {
    return this.serial(async () => {
      const current = this.scope(scope)
      if (current?.source_sha256 === sourceSha256 && current.frame_count === frameCount) return
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.beginRun(scope, bindings)
        let count = 0
        const source = await readStableUtf8Lines(rawPath, line => {
          const frame: unknown = JSON.parse(line)
          if (!isEngineFrameSnapshot(frame)) throw new Error('旧引擎归档帧格式无效。')
          this.insert(scope, frame); count++
        }, 2 * 1024 * 1024 * 1024)
        if (source.waitingForLine || source.source.sha256 !== sourceSha256 || count !== frameCount) throw new Error('旧引擎归档摘要或帧数无效，未导入。')
        this.finish(scope, sourceSha256, frameCount)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    })
  }

  replay(scope: EngineFrameArchiveScope, time: number, requestedEpoch?: number): Promise<EngineReplaySnapshot> {
    return this.serial(() => {
      const run = this.scope(scope)
      if (!run?.source_sha256) throw new Error('引擎历史尚未完整保存。')
      const epochs = this.db.prepare('SELECT engine_epoch AS engineEpoch,COUNT(*) AS frameCount,MIN(simulation_time) AS firstTime,MAX(simulation_time) AS lastTime FROM engine_frames WHERE run_id=? GROUP BY engine_epoch ORDER BY engine_epoch').all(scope.runId) as EngineReplaySnapshot['epochs']
      const engineEpoch = requestedEpoch ?? epochs[0]?.engineEpoch ?? 0
      if (epochs.length && !epochs.some(e => e.engineEpoch === engineEpoch)) throw new Error('所选引擎轮次不存在。')
      const row = this.db.prepare('SELECT payload,digest FROM engine_frames WHERE run_id=? AND engine_epoch=? AND simulation_time<=? ORDER BY simulation_time DESC,frame_id DESC LIMIT 1').get(scope.runId, engineEpoch, time)
      if (row && sha(String(row.payload)) !== row.digest) throw new Error('引擎历史帧摘要校验失败。')
      const engineFrame = row ? JSON.parse(String(row.payload)) as EngineFrameSnapshot : null
      const next = this.db.prepare('SELECT MIN(simulation_time) AS time FROM engine_frames WHERE run_id=? AND engine_epoch=? AND simulation_time>?').get(scope.runId, engineEpoch, time)!
      let historyTruncated = false
      const items = (kind: string) => {
        const rows = this.db.prepare(`SELECT f.frame_id AS frameId,f.simulation_time AS simulationTime,i.payload
          FROM engine_frames f JOIN engine_items i ON i.frame_sequence=f.sequence
          WHERE f.run_id=? AND f.engine_epoch=? AND f.simulation_time<=? AND i.kind=?
          ORDER BY f.simulation_time DESC,f.frame_id DESC,i.item_index DESC LIMIT 201`).all(scope.runId, engineEpoch, time, kind)
        if (rows.length > 200) historyTruncated = true
        return rows.slice(0, 200).reverse().map(item => ({ frameId: Number(item.frameId), simulationTime: Number(item.simulationTime), [kind]: JSON.parse(String(item.payload)) }))
      }
      const bindings = JSON.parse(String(run.bindings_json)) as Record<string, EngineLinkBinding>
      const value = { runId: scope.runId, scenarioId: scope.scenarioId, sourceSha256: run.source_sha256,
        frameCount: run.frame_count, epochs, engineEpoch, time, nextFrameTime: next.time, engineFrame,
        engineEvents: items('event'), engineSwitches: items('route'), engineAlarms: items('alarm'), historyTruncated,
        links: Object.entries(bindings).map(([id, binding]) => ({ id, type: binding.type, sourcePlatformId: binding.sourcePlatformId, targetPlatformId: binding.targetPlatformId })) }
      if (!isEngineReplaySnapshot(value)) throw new Error('引擎历史数据不符合回放契约。')
      return value
    })
  }
  close(): void { this.db.close() }
}

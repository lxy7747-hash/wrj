import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { EngineFrameEvent, EngineFrameSnapshot, EngineRouteAlarm, EngineRouteSwitch } from '../../src/contracts/domain-models.js'
import { isEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot.js'
import { formatCommunicationPortLabel } from '../../src/features/situation/file-message-links.js'
import { buildFrameRouteEvidence, resolveSwitchFromPriorFrames, ROUTE_EVIDENCE_FRAME_LIMIT, type EngineSwitchEntry, type EngineSwitchHighlights } from '../../src/features/situation/engine-route-highlights.js'
import { isEngineReplaySnapshot, type EngineReplaySnapshot, type EngineReplayTimelineMarker } from '../../src/features/replays/engine-replay.js'
import type { EngineFrameArchiveScope } from './engine-frame-archive.js'
import type { EngineLinkBinding } from './engine-frame-csv.js'
import { readStableUtf8Lines } from './afsim-log-reader.js'
import { ENGINE_JSONL_LINE_LIMIT_BYTES } from './engine-frame-csv.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const identity = (s: EngineFrameArchiveScope) => JSON.stringify([s.taskId, s.runId, s.scenarioId, s.revision, s.startedAt])

function readVerifiedFrame(row: Record<string, unknown>): EngineFrameSnapshot {
  const payload = String(row.payload)
  if (sha(payload) !== row.digest) throw new Error('引擎历史帧摘要校验失败。')
  return JSON.parse(payload) as EngineFrameSnapshot
}

function compactPortMedium(port: string): string {
  const lower = port.toLowerCase()
  if (lower.startsWith('sat_link')) return '卫星'
  if (lower.includes('microwave')) return '微波'
  if (lower.startsWith('c_band') || lower.startsWith('l_band')) return '数传'
  if (lower.includes('lazer') || lower.includes('laser')) return '激光'
  if (lower.includes('fiber')) return '光纤'
  return formatCommunicationPortLabel(port)
}

function formatEngineActorName(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (trimmed === 'rear_comm_vehicle') return '公共服务平台后方节点'
  if (trimmed === 'command_vehicle') return '无人集群指挥车节点'
  if (trimmed === 'tiantong_sat') return '天通卫星'
  if (trimmed === 'shentong_sat') return '神通卫星'
  const uav = /^mission_uav_(\d+)$/i.exec(trimmed)
  if (uav) return `无人节点 ${Number(uav[1])}`
  const groundJammer = /^jammer_station_(\d+)$/i.exec(trimmed)
  if (groundJammer) return `地面干扰站 ${Number(groundJammer[1])}`
  const airJammer = /^jammer_(?:airborne|airbround)_(\d+)$/i.exec(trimmed)
  if (airJammer) return `机载干扰平台 ${Number(airJammer[1])}`
  return trimmed
}

function buildReplayTimelineMarkers(
  rows: ReadonlyArray<Record<string, unknown>>,
): EngineReplayTimelineMarker[] {
  // 同秒内优先保留结构化 route / alarm 记录，再由 event 补充侦测与进入干扰。
  const priority = (kind: string) => kind === 'route' ? 0 : kind === 'alarm' ? 1 : 2
  const ordered = [...rows].sort((left, right) => {
    const timeDiff = Number(left.simulationTime) - Number(right.simulationTime)
    if (timeDiff !== 0) return timeDiff
    const prioDiff = priority(String(left.kind)) - priority(String(right.kind))
    if (prioDiff !== 0) return prioDiff
    return Number(left.frameId) - Number(right.frameId) || Number(left.itemIndex) - Number(right.itemIndex)
  })
  const markers: EngineReplayTimelineMarker[] = []
  const seen = new Set<string>()
  for (const row of ordered) {
    if (markers.length >= 200) break
    const frameId = Number(row.frameId)
    const time = Number(row.simulationTime)
    const rawKind = String(row.kind)
    let marker: EngineReplayTimelineMarker | null = null
    if (rawKind === 'route') {
      const route = JSON.parse(String(row.payload)) as EngineRouteSwitch
      const mediums = [...new Set(route.nodes.map(node => node.outPort || node.inPort).filter((port): port is string => Boolean(port)).map(compactPortMedium))]
      const mediumText = mediums.length ? mediums.join('/') : '新路径'
      const target = formatEngineActorName(route.targetName ?? route.targetPlatformId ?? '')
      const actorIds = route.targetPlatformId ? [route.targetPlatformId] : undefined
      marker = {
        id: `SWITCH:${frameId}:${row.itemIndex}`,
        kind: 'SWITCH',
        time,
        frameId,
        label: '链路切换',
        detail: target ? `切至 ${mediumText}（${target}）` : `切至 ${mediumText}`,
        ...(actorIds ? { actorIds } : {}),
      }
    } else if (rawKind === 'alarm') {
      const alarm = JSON.parse(String(row.payload)) as EngineRouteAlarm
      marker = {
        id: `ALARM:${frameId}:${row.itemIndex}`,
        kind: 'ALARM',
        time,
        frameId,
        label: '受扰告警',
        detail: alarm.message?.trim() || alarm.linkId || '触发受扰告警',
      }
    } else if (rawKind === 'event') {
      const event = JSON.parse(String(row.payload)) as EngineFrameEvent
      const rawType = (event.type ?? '').toLowerCase()
      const actors = [...event.jammerNames, ...event.uavNames].map(formatEngineActorName).filter(Boolean).slice(0, 2).join(' → ')
      const actorIds = [...event.jammerIds, ...event.uavIds].filter(Boolean).slice(0, 2)
      if (rawType.includes('switch')) {
        marker = {
          id: `EVENT-SWITCH:${frameId}:${row.itemIndex}`,
          kind: 'SWITCH',
          time,
          frameId,
          label: '链路切换',
          detail: actors || '受扰触发重路由',
          ...(actorIds.length ? { actorIds } : {}),
        }
      } else if (rawType.includes('jamm')) {
        marker = {
          id: `EVENT-JAM:${frameId}:${row.itemIndex}`,
          kind: 'JAMMING',
          time,
          frameId,
          label: '进入干扰',
          detail: actors || '目标进入干扰范围',
          ...(actorIds.length ? { actorIds } : {}),
        }
      } else if (rawType.includes('esm') || rawType.includes('detect')) {
        marker = {
          id: `EVENT-DETECT:${frameId}:${row.itemIndex}`,
          kind: 'DETECTION',
          time,
          frameId,
          label: '目标侦测',
          detail: actors || '侦测到通信目标',
          ...(actorIds.length ? { actorIds } : {}),
        }
      } else if (rawType.includes('alarm')) {
        marker = {
          id: `EVENT-ALARM:${frameId}:${row.itemIndex}`,
          kind: 'ALARM',
          time,
          frameId,
          label: '受扰告警',
          detail: actors || '触发链路告警',
          ...(actorIds.length ? { actorIds } : {}),
        }
      }
    }
    if (!marker) continue
    const dedupKey = `${Math.floor(time)}:${marker.kind}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    markers.push(marker)
  }
  return markers
}

/** One shared history database; all reads and writes retain the immutable run scope. */
export class EngineFrameSqliteStorage {
  private readonly db: DatabaseSync
  // Node 22.14 的迭代器不保留 Statement；持有引用，避免扫描大归档时被 GC 提前释放。
  private readonly framePayloads: ReturnType<DatabaseSync['prepare']>
  private lastMapSwitch?: { runId: string; epoch: number; frameId: number; resolution: EngineSwitchHighlights }
  private tail: Promise<unknown> = Promise.resolve()
  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('引擎历史数据库路径必须为绝对路径。')
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS engine_runs (
          run_id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL, scope_json TEXT NOT NULL,
          bindings_json TEXT NOT NULL, source_sha256 TEXT, frame_count INTEGER
        ) STRICT;
        CREATE INDEX IF NOT EXISTS engine_runs_scenario ON engine_runs(scenario_id, run_id);
        CREATE TABLE IF NOT EXISTS engine_frames (
          sequence INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES engine_runs(run_id),
          engine_epoch INTEGER NOT NULL, frame_id REAL NOT NULL, simulation_time REAL NOT NULL,
          payload TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(run_id, engine_epoch, frame_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS engine_frames_time ON engine_frames(run_id, engine_epoch, simulation_time, frame_id);
        CREATE TABLE IF NOT EXISTS engine_items (
          frame_sequence INTEGER NOT NULL REFERENCES engine_frames(sequence), kind TEXT NOT NULL,
          item_index INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(frame_sequence, kind, item_index)
        ) STRICT;`)
      this.migrateFrameIds(path)
      this.framePayloads = this.db.prepare('SELECT payload FROM engine_frames WHERE run_id=? ORDER BY sequence')
    } catch (error) { this.db.close(); throw error }
  }

  /** 旧库先备份，再事务换表；保留序号、载荷、摘要及事件外键。 */
  private migrateFrameIds(path: string): void {
    const column = this.db.prepare('PRAGMA table_info(engine_frames)').all().find(row => row.name === 'frame_id')
    if (column?.type !== 'INTEGER') return
    this.db.prepare('VACUUM INTO ?').run(`${path}.before-fractional-frames-${randomUUID()}.db`)
    this.db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE')
    try {
      this.db.exec(`CREATE TABLE engine_frames_decimal (
        sequence INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES engine_runs(run_id),
        engine_epoch INTEGER NOT NULL, frame_id REAL NOT NULL, simulation_time REAL NOT NULL,
        payload TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(run_id, engine_epoch, frame_id)
      ) STRICT;
      INSERT INTO engine_frames_decimal SELECT * FROM engine_frames;
      DROP TABLE engine_frames;
      ALTER TABLE engine_frames_decimal RENAME TO engine_frames;
      CREATE INDEX engine_frames_time ON engine_frames(run_id, engine_epoch, simulation_time, frame_id);`)
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('引擎历史帧升级后外键校验失败，已回滚。')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    finally { this.db.exec('PRAGMA foreign_keys=ON') }
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
    for (const row of this.framePayloads.iterate(scope.runId)) {
      digest.update(`${String(row.payload)}\n`); count++
    }
    if (count !== frameCount || digest.digest('hex') !== sourceSha256) throw new Error('引擎数据库与文件归档的帧数或摘要不一致。')
    this.db.prepare('UPDATE engine_runs SET source_sha256=?,frame_count=? WHERE run_id=?').run(sourceSha256, frameCount, scope.runId)
  }
  complete(scope: EngineFrameArchiveScope, sourceSha256: string, frameCount: number): Promise<void> {
    return this.serial(() => {
      this.finish(scope, sourceSha256, frameCount)
      try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)') } catch { /* 并发读取时跳过非阻塞 checkpoint，不影响数据一致性。 */ }
    })
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
        }, 2 * 1024 * 1024 * 1024, ENGINE_JSONL_LINE_LIMIT_BYTES)
        if (source.waitingForLine || source.source.sha256 !== sourceSha256 || count !== frameCount) throw new Error('旧引擎归档摘要或帧数无效，未导入。')
        this.finish(scope, sourceSha256, frameCount)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    })
  }

  private *priorRouteEvidence(frame: EngineFrameSnapshot) {
    const frames = this.db.prepare(`SELECT payload,digest FROM engine_frames WHERE run_id=? AND engine_epoch=? AND frame_id<?
      ORDER BY frame_id DESC LIMIT ?`)
    for (const row of frames.iterate(frame.runId, frame.engineEpoch, frame.frameId, ROUTE_EVIDENCE_FRAME_LIMIT)) {
      yield buildFrameRouteEvidence(readVerifiedFrame(row))
    }
  }

  /** 已完成归档的同一轮次、同一帧只有一个末次切换，连续播放时复用它。 */
  private latestSwitchResolution(current: EngineFrameSnapshot, latest: EngineSwitchEntry): EngineSwitchHighlights {
    const { runId, engineEpoch: epoch } = current
    const cached = this.lastMapSwitch
    if (cached && cached.runId === runId && cached.epoch === epoch && cached.frameId === latest.frameId) return cached.resolution
    let eventFrame = current
    if (latest.frameId !== current.frameId) {
      const row = this.db.prepare('SELECT payload,digest FROM engine_frames WHERE run_id=? AND engine_epoch=? AND frame_id=?')
        .get(runId, epoch, latest.frameId)
      if (!row) throw new Error('引擎切换事件缺少对应的历史帧。')
      eventFrame = readVerifiedFrame(row)
    }
    const resolution = resolveSwitchFromPriorFrames(eventFrame, latest.route.oldNodes, latest.route.nodes, this.priorRouteEvidence(eventFrame))
    this.lastMapSwitch = { runId, epoch, frameId: latest.frameId, resolution }
    return resolution
  }

  replay(scope: EngineFrameArchiveScope, time: number, requestedEpoch?: number): Promise<EngineReplaySnapshot> {
    return this.serial(() => {
      const run = this.scope(scope)
      if (!run?.source_sha256) throw new Error('引擎历史尚未完整保存。')
      const epochs = this.db.prepare('SELECT engine_epoch AS engineEpoch,COUNT(*) AS frameCount,MIN(simulation_time) AS firstTime,MAX(simulation_time) AS lastTime FROM engine_frames WHERE run_id=? GROUP BY engine_epoch ORDER BY engine_epoch').all(scope.runId) as EngineReplaySnapshot['epochs']
      const engineEpoch = requestedEpoch ?? epochs[0]?.engineEpoch ?? 0
      if (epochs.length && !epochs.some(e => e.engineEpoch === engineEpoch)) throw new Error('所选引擎轮次不存在。')
      const row = this.db.prepare('SELECT payload,digest FROM engine_frames WHERE run_id=? AND engine_epoch=? AND simulation_time<=? ORDER BY simulation_time DESC,frame_id DESC LIMIT 1').get(scope.runId, engineEpoch, time)
      const engineFrame = row ? readVerifiedFrame(row) : null
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
      const timelineRows = this.db.prepare(`SELECT f.frame_id AS frameId,f.simulation_time AS simulationTime,i.kind,i.item_index AS itemIndex,i.payload
        FROM engine_frames f JOIN engine_items i ON i.frame_sequence=f.sequence
        WHERE f.run_id=? AND f.engine_epoch=?
        ORDER BY f.simulation_time ASC,f.frame_id ASC,i.item_index ASC LIMIT 600`).all(scope.runId, engineEpoch)
      const timelineMarkers = buildReplayTimelineMarkers(timelineRows)
      const bindings = JSON.parse(String(run.bindings_json)) as Record<string, EngineLinkBinding>
      const value: unknown = { runId: scope.runId, scenarioId: scope.scenarioId, sourceSha256: run.source_sha256,
        frameCount: run.frame_count, epochs, engineEpoch, time, nextFrameTime: next.time, engineFrame,
        engineEvents: items('event'), engineSwitches: items('route'), engineAlarms: items('alarm'), historyTruncated,
        timelineMarkers,
        links: Object.entries(bindings).map(([id, binding]) => ({ id, type: binding.type, sourcePlatformId: binding.sourcePlatformId, targetPlatformId: binding.targetPlatformId })) }
      if (!isEngineReplaySnapshot(value)) throw new Error('引擎历史数据不符合回放契约。')
      const latest = value.engineSwitches.at(-1)
      if (engineFrame && latest) latest.resolution = structuredClone(this.latestSwitchResolution(engineFrame, latest))
      return value
    })
  }
  close(): void { this.db.close() }
}

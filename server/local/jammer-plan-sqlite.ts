import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import type { JammerPlanRecord, JammerPlanStorage } from '../simulations/jammer-plan-storage.js'

/**
 * 运行期干扰计划/本地参数的 SQLite 持久化实现。
 * 仅保存本地已接受参数（不代表引擎执行确认）；数据库关闭并重建后同一 (task,run,jammer) 仍可读回。
 */
export class JammerPlanSqliteStorage implements JammerPlanStorage {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('JAMMER_PLAN_DB_PATH 必须为绝对路径。')
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 1000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS jammer_plans (
          task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0),
          run_id TEXT NOT NULL CHECK (length(trim(run_id)) > 0),
          jammer_id TEXT NOT NULL CHECK (length(trim(jammer_id)) > 0),
          record_json TEXT NOT NULL CHECK (json_valid(record_json)),
          PRIMARY KEY (task_id, run_id, jammer_id)
        ) STRICT;
      `)
      this.list()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private readRow(row: Record<string, unknown> | undefined): JammerPlanRecord | undefined {
    if (row === undefined) return undefined
    if (typeof row.record_json !== 'string') throw new Error('干扰计划存储结构不正确。')
    const parsed = JSON.parse(row.record_json) as Partial<JammerPlanRecord>
    if (typeof parsed.version !== 'number' || !Number.isFinite(parsed.version)
      || typeof parsed.detectionRangeM !== 'number' || !Number.isFinite(parsed.detectionRangeM)) {
      throw new Error('干扰计划存储记录无效。')
    }
    const record: JammerPlanRecord = { version: parsed.version, detectionRangeM: parsed.detectionRangeM }
    if (parsed.style === 'BARRAGE' || parsed.style === 'SPOT') record.style = parsed.style
    if (typeof parsed.elevation === 'number' && Number.isFinite(parsed.elevation)) record.elevation = parsed.elevation
    if (Number.isInteger(parsed.plannedStartFrame) && Number(parsed.plannedStartFrame) >= 0) record.plannedStartFrame = Number(parsed.plannedStartFrame)
    if (Number.isInteger(parsed.plannedStopFrame) && Number(parsed.plannedStopFrame) >= 0) record.plannedStopFrame = Number(parsed.plannedStopFrame)
    return record
  }

  load(taskId: string, runId: string, jammerId: string): JammerPlanRecord | undefined {
    const row = this.db.prepare('SELECT record_json FROM jammer_plans WHERE task_id = ? AND run_id = ? AND jammer_id = ?').get(taskId, runId, jammerId) as Record<string, unknown> | undefined
    return this.readRow(row)
  }

  save(taskId: string, runId: string, jammerId: string, record: JammerPlanRecord): void {
    this.db.prepare(`
      INSERT INTO jammer_plans (task_id, run_id, jammer_id, record_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id, run_id, jammer_id) DO UPDATE SET record_json = excluded.record_json
    `).run(taskId, runId, jammerId, JSON.stringify(record))
  }

  deleteRun(runId: string): void {
    this.db.prepare('DELETE FROM jammer_plans WHERE run_id = ?').run(runId)
  }

  /** 只读诊断：返回已持久化记录数量（不参与业务）。 */
  list(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM jammer_plans').get() as { count?: number } | undefined
    return Number(row?.count ?? 0)
  }

  close(): void {
    this.db.close()
  }
}

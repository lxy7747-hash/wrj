import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { lstatSync } from 'node:fs'
import type { LocalArchiveRecord, Report } from '../../src/contracts/domain-models.js'
import { isLocalArchiveId, isLocalArchiveSnapshot, type LocalArchiveSnapshot } from '../../src/features/admin/local-archive.js'
import type { LocalReplaySnapshot } from '../../src/features/replays/local-replay.js'

export interface LocalArchiveStorage {
  list(): LocalArchiveRecord[]
  get(id: string): LocalArchiveSnapshot | null
  register(name: string, actor: string, replay: LocalReplaySnapshot, report: Report): LocalArchiveRecord
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** 独立空库保存解析快照和报告，单行原子提交；不修改原始文件或既有业务库。 */
export class ArchiveSqliteStorage implements LocalArchiveStorage {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('归档库路径必须为绝对路径。')
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('归档库必须为普通文件。')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;
        CREATE TABLE IF NOT EXISTS local_archives (
          archive_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL
        ) STRICT;`)
    } catch (error) { this.db.close(); throw error }
  }

  private decode(row: Record<string, unknown>): LocalArchiveSnapshot {
    if (typeof row.payload !== 'string' || digest(row.payload) !== row.checksum) throw new Error('归档完整性校验失败。')
    const snapshot: unknown = JSON.parse(row.payload)
    if (!isLocalArchiveSnapshot(snapshot) || snapshot.record.archiveId !== row.archive_id
      || snapshot.record.archiveId !== `ARCH-LOCAL-${digest(`${snapshot.replay.initial.sha256}:${snapshot.replay.sha256}`)}`) throw new Error('归档来源或结构不正确。')
    return snapshot
  }

  list(): LocalArchiveRecord[] {
    return this.db.prepare('SELECT * FROM local_archives ORDER BY rowid DESC').all().map(row => this.decode(row).record)
  }

  get(id: string): LocalArchiveSnapshot | null {
    if (!isLocalArchiveId(id)) return null
    const row = this.db.prepare('SELECT * FROM local_archives WHERE archive_id=?').get(id)
    return row ? this.decode(row) : null
  }

  register(name: string, actor: string, replay: LocalReplaySnapshot, report: Report): LocalArchiveRecord {
    const record: LocalArchiveRecord = {
      archiveId: `ARCH-LOCAL-${digest(`${replay.initial.sha256}:${replay.sha256}`)}`, name, createdBy: actor,
      createdAt: new Date().toISOString(), sourceKind: 'LOCAL_FILE_SNAPSHOT', binding: 'UNBOUND',
      eventFile: { fileName: replay.initial.fileName, sha256: replay.initial.sha256 },
      positionFile: { fileName: replay.fileName, sha256: replay.sha256 }, reportId: report.reportId,
      nodeCount: replay.initial.nodes.length, positionCount: replay.recordCount, durationS: replay.durationS,
    }
    const snapshot = { record, replay, report }
    if (!isLocalArchiveSnapshot(snapshot)) throw new Error('归档数据校验失败或来源文件已变化。')
    const payload = JSON.stringify(snapshot)
    // 同一对源文件重复登记返回原记录，保留最初名称与登记人；重试不会创建多份。
    this.db.prepare('INSERT OR IGNORE INTO local_archives VALUES (?, ?, ?)').run(record.archiveId, payload, digest(payload))
    return this.get(record.archiveId)!.record
  }

  close(): void { this.db.close() }
}

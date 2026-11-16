// @vitest-environment node
// A1 第二组：真实 SQLite 分支。区分“数据库原始帧校验完成”与“文件/CSV 整组发布成功”，
// 覆盖 complete 故障与 complete 成功但后续 CSV 指针失败后的重试；保留已完成旧运行不可变、已完成后拒绝不同数据。
import { afterEach, describe, expect, it, vi } from 'vitest'
import latest from '../fixtures/engine-frame/websocket-latest.json'

const fault = vi.hoisted(() => ({ match: (_to: string): boolean => false, remaining: 0 }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises') as { rename: (from: unknown, to: unknown) => Promise<void> } & Record<string, unknown>
  return {
    ...actual,
    rename: async (from: unknown, to: unknown) => {
      if (fault.remaining > 0 && fault.match(String(to))) { fault.remaining -= 1; throw new Error('AUDIT sqlite one-shot pointer rename failure') }
      return actual.rename(from, to)
    },
  }
})

const { adaptEngineFrameSnapshot } = await import('../../src/features/data-exchange/engine-frame-snapshot')
const { EngineFrameSqliteStorage } = await import('../../server/local/' + 'engine-frame-sqlite.js')
const { createEngineFrameArchive } = await import('../../server/local/' + 'engine-frame-archive.js')
const { mkdtemp, rm } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { DatabaseSync } = await import('node:' + 'sqlite')

const roots: string[] = [], databases: InstanceType<typeof EngineFrameSqliteStorage>[] = []
afterEach(async () => {
  fault.match = () => false; fault.remaining = 0
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})
const base = { taskId: 'TASK-001', scenarioId: 'SCN-A', revision: 1, startedAt: '2026-11-10T00:00:00Z' }
const frame = (id: number, runId: string) => ({ ...adaptEngineFrameSnapshot({ ...latest[0], frame_id: id }).data!, runId, engineEpoch: 0 })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'wrj-l01-sqlite-')); roots.push(root)
  const path = join(root, 'engine-history.db'), database = new EngineFrameSqliteStorage(path); databases.push(database)
  const archive = createEngineFrameArchive(join(root, 'frames'), () => base.startedAt, { database })
  return { root, path, database, archive }
}
async function dbState(path: string, runId: string) {
  const db = new DatabaseSync(path)
  try {
    const count = (db.prepare('SELECT COUNT(*) AS n FROM engine_frames WHERE run_id = ?').get(runId) as { n: number }).n
    const row = db.prepare('SELECT source_sha256 AS sha FROM engine_runs WHERE run_id = ?').get(runId) as { sha: string | null } | undefined
    return { frames: count, completedSha: row?.sha ?? null }
  } finally { db.close() }
}

describe('A1 SQLite 分支：数据库完成与整组发布区分', () => {
  it('complete 故障后重试：帧不丢失、不标完成，旧运行不受影响', async () => {
    const { path, archive } = await setup()
    // 已完成旧运行对照
    const old = await archive.begin({ ...base, runId: 'RUN-OLD' }); await old.append(frame(5, 'RUN-OLD')); await old.append(frame(10, 'RUN-OLD')); await old.close()
    const oldSummary = await archive.load('RUN-OLD')
    // 新运行作用域：complete 一次性失败
    const session = await archive.begin({ ...base, runId: 'RUN-NEW' })
    await session.append(frame(5, 'RUN-NEW'))
    const spy = vi.spyOn(databases[0]!, 'complete').mockRejectedValueOnce(new Error('模拟数据库完成失败'))
    await expect(session.close()).rejects.toThrow('数据库完成失败')
    spy.mockRestore()
    // 数据库有真实帧但尚未标完成；文件指针未发布
    const notDone = await dbState(path, 'RUN-NEW')
    expect(notDone.frames).toBe(1)
    expect(notDone.completedSha).toBeNull()
    expect(await archive.load('RUN-NEW')).toBeNull()
    // 旧运行数据与摘要保持不变
    expect((await archive.load('RUN-OLD'))!.sourceSha256).toBe(oldSummary!.sourceSha256)
    // 重试成功发布，旧运行仍不变
    await session.close()
    expect(session.failure()).toBeNull()
    expect(await archive.load('RUN-NEW')).toMatchObject({ frameCount: 1 })
    expect((await dbState(path, 'RUN-NEW')).completedSha).not.toBeNull()
    expect((await archive.load('RUN-OLD'))!.sourceSha256).toBe(oldSummary!.sourceSha256)
  })

  it('数据库 complete 已完成但 CSV 指针发布失败不报告整组成功；重试成功且不解锁已完成运行保护', async () => {
    const { path, archive } = await setup()
    const old = await archive.begin({ ...base, runId: 'RUN-OLD' }); await old.append(frame(5, 'RUN-OLD')); await old.close()
    const oldSha = (await archive.load('RUN-OLD'))!.sourceSha256
    const session = await archive.begin({ ...base, runId: 'RUN-NEW' })
    await session.append(frame(5, 'RUN-NEW')); await session.append(frame(10, 'RUN-NEW'))
    // 数据库 complete 成功，随后 CSV 指针 rename 一次性失败
    fault.match = to => to === join(roots[0]!, 'frames', 'RUN-NEW', 'csv', 'current.json'); fault.remaining = 1
    await expect(session.close()).rejects.toThrow('AUDIT')
    fault.match = () => false; fault.remaining = 0
    // 数据库原始帧已校验完成（source_sha 非空）——但这不等于整组发布成功
    const state = await dbState(path, 'RUN-NEW')
    expect(state.frames).toBe(2)
    expect(state.completedSha).not.toBeNull()
    // 文件组未发布：无 current.json 指针，load 返回 null（不是伪成功）
    expect(await archive.load('RUN-NEW')).toBeNull()
    // 旧运行摘要不变
    expect((await archive.load('RUN-OLD'))!.sourceSha256).toBe(oldSha)
    // 重试成功：两级发布完成，帧数真实，摘要一致
    await session.close()
    expect(session.failure()).toBeNull()
    const summary = (await archive.load('RUN-NEW'))!
    expect(summary.frameCount).toBe(2)
    expect((await archive.getFile('RUN-NEW', summary.sourceSha256))).toBeTruthy()
    expect((await dbState(path, 'RUN-NEW')).completedSha).toBe(summary.sourceSha256)
    // 已完成 SQLite 运行仍拒绝追加不同数据（保护未被解除）
    const reopen = await archive.begin({ ...base, runId: 'RUN-OLD' })
    await reopen.append(frame(99, 'RUN-OLD'))
    expect(reopen.failure()?.message).toContain('已完成')
    await expect(reopen.close()).rejects.toThrow('已完成')
  })
})

// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import sample from '../fixtures/engine-frame/params_check.json'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'
const { mkdtemp, rm } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createEngineFrameArchive } = await import('../../server/local/' + 'engine-frame-archive.js')
const { EngineFrameSqliteStorage } = await import('../../server/local/' + 'engine-frame-sqlite.js')
const { publishEngineCsv, ENGINE_JSONL_LINE_LIMIT_BYTES } = await import('../../server/local/' + 'engine-frame-csv.js')
const { readStableUtf8Lines } = await import('../../server/local/' + 'afsim-log-reader.js')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const scope = { taskId: 'TASK-LARGE', runId: 'RUN-LARGE', scenarioId: 'SCN-LARGE', revision: 1, startedAt: '2026-11-14T00:00:00Z' }
const frame = () => ({ ...adaptEngineFrameSnapshot({ ...sample, frame_id: 0 }).data!, runId: scope.runId, engineEpoch: 0, modelVersion: 'x'.repeat(140 * 1024) })

it('大于普通 CSV 单行限制的合法整帧可重读、重建 CSV 及导入 SQLite；普通 CSV 限制保持', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrj-large-frame-')); roots.push(root)
  const archive = createEngineFrameArchive(join(root, 'frames'), () => scope.startedAt)
  const session = await archive.begin(scope); await session.append(frame()); await session.close()
  const summary = (await archive.load(scope.runId))!
  expect(summary.frameCount).toBe(1)
  const raw = (await archive.getFile(scope.runId, summary.sourceSha256))!
  await expect(readStableUtf8Lines(raw, () => {})).rejects.toThrow('128 KiB')
  await expect(readStableUtf8Lines(raw, () => {}, 256 * 1024 * 1024, 0)).rejects.toThrow('单行读取上限无效')
  const csv = await publishEngineCsv(join(root, 'rebuilt'), raw, scope.taskId, summary.sourceSha256, {}, 1)
  expect(csv.evidence.sourceSha256).toBe(summary.sourceSha256)
  const db = new EngineFrameSqliteStorage(join(root, 'history.db'))
  try {
    await db.ensureLegacy(scope, {}, raw, summary.sourceSha256, 1)
    expect((await db.replay(scope, 0)).engineFrame?.modelVersion).toHaveLength(140 * 1024)
  } finally { db.close() }
})

it('写入前拒绝超过引擎单帧上限的数据，原有归档仍可读取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrj-frame-bound-')); roots.push(root)
  const archive = createEngineFrameArchive(root, () => scope.startedAt)
  const original = await archive.begin(scope); await original.append(frame()); await original.close()
  const before = (await archive.load(scope.runId))!
  const oversized = await archive.begin(scope)
  await oversized.append({ ...frame(), frameId: 5, modelVersion: 'x'.repeat(ENGINE_JSONL_LINE_LIMIT_BYTES) })
  expect(oversized.failure()?.message).toContain('8MiB')
  await expect(oversized.close()).rejects.toThrow('8MiB')
  expect((await archive.load(scope.runId))!.sourceSha256).toBe(before.sourceSha256)
})

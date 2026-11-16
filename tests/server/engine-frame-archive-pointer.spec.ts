// @vitest-environment node
// L01 / GNZB 23/28：文件归档整组发布的两级指针一致性回归。
// 覆盖“先发布 A → 发布 B 时在 CSV 收尾 / CSV 指针替换 / 原始指针替换定点一次性失败”的反例，
// 断言失败后两级指针都回到 A、A 仍可读取、B 原文保留；移除故障后重试发布 B 完整、无重漏。
import { afterEach, describe, expect, it, vi } from 'vitest'
import sample from '../fixtures/engine-frame/params_check.json'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'

const fault = vi.hoisted(() => ({ match: (_to: string): boolean => false, remaining: 0 }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises') as { rename: (from: unknown, to: unknown) => Promise<void> } & Record<string, unknown>
  return {
    ...actual,
    rename: async (from: unknown, to: unknown) => {
      if (fault.remaining > 0 && fault.match(String(to))) { fault.remaining -= 1; throw new Error('AUDIT one-shot pointer rename failure') }
      return actual.rename(from, to)
    },
  }
})

const { mkdtemp, rm, readFile, readdir } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createEngineFrameArchive } = await import('../../server/local/' + 'engine-frame-archive.js')

const roots: string[] = []
afterEach(async () => {
  fault.match = () => false; fault.remaining = 0
  await Promise.all(roots.splice(0).map((root: string) => rm(root, { recursive: true, force: true })))
})

const scope = { taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-10T00:00:00Z' }
const bindings = { 'L-1': { type: 'MICROWAVE' as const, sourcePlatformId: 'A', targetPlatformId: 'B' } }
function frame(frameId: number) {
  const value = { ...adaptEngineFrameSnapshot({ ...sample, frame_id: frameId, sim_time_s: undefined }).data!, runId: 'RUN-ARCHIVE', engineEpoch: 0 }
  const link = value.links[0]!
  Object.assign(link, { linkIds: ['L-1'], sourcePlatformId: 'A', targetPlatformId: 'B', status: 'UP' })
  Object.assign(link.quality, { gxbDb: 2, ber: 0.01, rxPowerDbm: -80 })
  return value
}
async function makeRoot(tag: string) { const root = await mkdtemp(join(tmpdir(), `wrj-l01-${tag}-`)); roots.push(root); return root }
async function pointers(root: string) {
  const raw = JSON.parse(await readFile(join(root, scope.runId, 'current.json'), 'utf8'))
  const csv = JSON.parse(await readFile(join(root, scope.runId, 'csv/current.json'), 'utf8'))
  return { raw: String(raw.sourceSha256), csv: String(csv.sourceSha256) }
}
async function preservedRawFrameIds(root: string): Promise<number[]> {
  const dir = join(root, scope.runId)
  const files = (await readdir(dir) as string[]).filter((name: string) => name.endsWith('.jsonl'))
  const ids: number[] = []
  for (const name of files) for (const line of (await readFile(join(dir, name), 'utf8')).split('\n')) if (line.trim()) ids.push(JSON.parse(line).frameId as number)
  return ids
}

const stages: Array<{ name: string; arm: (root: string) => void }> = [
  // CSV 收尾：派生 CSV 代目录发布（csv.close 内 rename pending → engine-csv-*）一次性失败，发生在原始指针切换之前。
  { name: 'CSV 收尾', arm: () => { fault.match = to => to.replaceAll('\\', '/').includes('/csv/engine-csv-'); fault.remaining = 1 } },
  // CSV 指针替换：原始指针已切到 B 之后，csv/current.json 的 rename 一次性失败。
  { name: 'CSV 指针替换', arm: root => { fault.match = to => to === join(root, scope.runId, 'csv', 'current.json'); fault.remaining = 1 } },
  // 原始指针替换：raw current.json 的 rename 一次性失败，CSV 指针尚未提交。
  { name: '原始指针替换', arm: root => { fault.match = to => to === join(root, scope.runId, 'current.json'); fault.remaining = 1 } },
]

describe('L01 文件归档两级指针一致性', () => {
  it.each(stages)('发布 B 在 $name 阶段失败后两级指针回到 A、A 可读、B 原文保留，重试无重漏', async stage => {
    const root = await makeRoot('ab')
    const archive = createEngineFrameArchive(root, () => scope.startedAt)
    // 先发布 A
    const a = await archive.begin(scope, bindings); await a.append(frame(1)); await a.close()
    const aPointer = await pointers(root)
    expect(await archive.getFile(scope.runId, aPointer.raw)).toBeTruthy()
    expect(await archive.getCsvFile(scope.runId, aPointer.raw, 'link_state.csv')).toBeTruthy()

    // 构造不同的 B 并注入定点一次性故障
    const b = await archive.begin(scope, bindings); await b.append(frame(2))
    stage.arm(root)
    await expect(b.close()).rejects.toThrow('AUDIT')
    fault.match = () => false; fault.remaining = 0

    // 失败后：两级指针都仍是 A，A 的原文下载与 CSV 获取仍可用，B 原文已保留在磁盘
    const afterFailure = await pointers(root)
    expect(afterFailure).toEqual(aPointer)
    expect(await archive.getFile(scope.runId, aPointer.raw)).toBeTruthy()
    expect(await archive.getCsvFile(scope.runId, aPointer.raw, 'link_state.csv')).toBeTruthy()
    expect(await preservedRawFrameIds(root)).toEqual(expect.arrayContaining([2]))

    // 移除故障后重试：B 完整发布，两级摘要一致，无重漏
    await b.close()
    expect(b.failure()).toBeNull()
    const bPointer = await pointers(root)
    expect(bPointer.raw).toBe(bPointer.csv)
    expect(bPointer.raw).not.toBe(aPointer.raw)
    expect(await archive.getFile(scope.runId, bPointer.raw)).toBeTruthy()
    expect(await archive.getCsvFile(scope.runId, bPointer.raw, 'link_state.csv')).toBeTruthy()
    expect(await archive.load(scope.runId)).toMatchObject({ frameCount: 1 })
    // 重复关闭不重复写入或发布
    await b.close()
    expect(await pointers(root)).toEqual(bPointer)
    expect(await archive.load(scope.runId)).toMatchObject({ frameCount: 1 })
  })

  it('没有旧发布时，CSV 指针替换失败不暴露为完整发布成功', async () => {
    const root = await makeRoot('fresh')
    const archive = createEngineFrameArchive(root, () => scope.startedAt)
    const session = await archive.begin(scope, bindings); await session.append(frame(1))
    fault.match = to => to === join(root, scope.runId, 'csv', 'current.json'); fault.remaining = 1
    await expect(session.close()).rejects.toThrow('AUDIT')
    fault.match = () => false; fault.remaining = 0
    // 未产生任何 current.json 指针：不是半发布/伪成功
    expect(await archive.load(scope.runId)).toBeNull()
    await expect(readFile(join(root, scope.runId, 'current.json'), 'utf8')).rejects.toThrow()
    // 原始数据保留，重试后完整发布
    expect(await preservedRawFrameIds(root)).toEqual(expect.arrayContaining([1]))
    await session.close()
    expect(await archive.load(scope.runId)).toMatchObject({ frameCount: 1 })
  })
})

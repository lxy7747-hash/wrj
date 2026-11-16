// @vitest-environment node
// A2 / L01 23/28：派生 CSV 在“重建路径”发现确定性容量超限后必须终止，不得重复读取同代原文重建。
// 迁移自 output/gnzb-close-review-20261112-171450/remaining-audit.spec.ts，使用测试专用小阈值与一次性 I/O 注入。
import { afterEach, describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({ rawReads: 0 }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises') as { open: (path: unknown, flags?: unknown) => Promise<unknown> } & Record<string, unknown>
  return {
    ...actual,
    open: async (...args: unknown[]) => {
      if (String(args[0]).endsWith('.jsonl') && args[1] === 'r') probe.rawReads += 1
      return actual.open(args[0], args[1])
    },
  }
})

import sample from '../fixtures/engine-frame/params_check.json'
import { adaptEngineFrameSnapshot, isEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'
const { createEngineFrameArchive } = await import('../../server/local/' + 'engine-frame-archive.js')
const { __setDerivedCsvLimitBytesForTest } = await import('../../server/local/' + 'engine-frame-csv.js')

const { mkdtemp, rm, readFile, readdir, open } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  probe.rawReads = 0
  __setDerivedCsvLimitBytesForTest(undefined)
  await Promise.all(roots.splice(0).map((root: string) => rm(root, { recursive: true, force: true })))
})

const scope = { taskId: 'TASK-001', runId: 'RUN-REBUILD', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-10T00:00:00Z' }
const singleBindings = { 'L-0': { type: 'MICROWAVE' as const, sourcePlatformId: 'A', targetPlatformId: 'B' } }
function singleFrame(frameId: number) {
  const value = { ...adaptEngineFrameSnapshot({ ...sample, frame_id: frameId, sim_time_s: undefined }).data!, runId: scope.runId, engineEpoch: 0 }
  const link = value.links[0]!
  Object.assign(link, { linkId: 'SEG-0', linkIds: ['L-0'], sourcePlatformId: 'A', targetPlatformId: 'B', status: 'UP', error: null })
  Object.assign(link.quality, { gxbDb: 2, ber: 0.01, rxPowerDbm: -80 })
  return value
}
/** 20 条有效逻辑链路：重建出的 CSV 远超测试小阈值。 */
function wideFrame() {
  const value = singleFrame(5)
  const template = value.links[0]!
  value.links = Array.from({ length: 20 }, (_, i) => {
    const link = structuredClone(template)
    Object.assign(link, { linkId: `SEG-${i}`, linkIds: [`L-${i}`], sourcePlatformId: `A-${i}`, targetPlatformId: 'B', status: 'UP', error: null })
    Object.assign(link.quality, { gxbDb: 2, ber: 0.01, rxPowerDbm: -80 })
    return link
  })
  expect(isEngineFrameSnapshot(value)).toBe(true)
  return value
}
const wideBindings = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`L-${i}`, { type: 'MICROWAVE' as const, sourcePlatformId: `A-${i}`, targetPlatformId: 'B' }]))
async function makeRoot(tag: string) { const root = await mkdtemp(join(tmpdir(), `wrj-l01-rebuild-${tag}-`)); roots.push(root); return root }
async function pointerSha(root: string, name: string) { return String(JSON.parse(await readFile(join(root, scope.runId, name), 'utf8')).sourceSha256) }
async function preservedRaw(root: string): Promise<boolean> {
  const names = await readdir(join(root, scope.runId))
  return names.some((name: string) => name.endsWith('.jsonl') || name.endsWith('.pending'))
}
/** 按文件列出每份原文包含的帧号，用于区分 A 与 B 的独立原文。 */
async function rawFrameIdsByFile(root: string): Promise<Array<{ name: string; ids: number[] }>> {
  const dir = join(root, scope.runId); const out: Array<{ name: string; ids: number[] }> = []
  for (const name of (await readdir(dir) as string[]).filter((n: string) => n.endsWith('.jsonl') || n.endsWith('.pending'))) {
    const ids: number[] = []
    for (const line of (await readFile(join(dir, name), 'utf8')).split('\n')) if (line.trim()) ids.push(Number(JSON.parse(line).frameId))
    out.push({ name, ids })
  }
  return out
}
/** 在写 link_state/link_loss 数据行时注入一次性 I/O 错误（进入 rebuildCsv，而非容量错误）。 */
async function armTransientCsvWriteError() {
  const handle = await open(join(tmpdir(), `wrj-probe-${Math.random().toString(36).slice(2)}`), 'wx')
  const prototype = Object.getPrototypeOf(handle); await handle.close()
  const originalWrite = prototype.write
  const state = { armed: true, injected: false }
  vi.spyOn(prototype, 'write').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const chunk = args[0] as { toString(): string }
    if (state.armed && !state.injected && chunk.toString().startsWith('TASK-001,1.1,')) { state.injected = true; throw new Error('AUDIT transient CSV write') }
    return originalWrite.apply(this, args as never)
  })
  return state
}

describe('A2 重建路径容量超限终止', () => {
  it('有旧 A：重建确认容量超限后重复 close 均拒绝、不重复读原文、两级指针保持 A、B 原文保留', async () => {
    __setDerivedCsvLimitBytesForTest(512)
    const root = await makeRoot('with-a')
    const archive = createEngineFrameArchive(root, () => scope.startedAt)
    const a = await archive.begin(scope, singleBindings); await a.append(singleFrame(1)); await a.close()
    const rawA = await pointerSha(root, 'current.json'), csvA = await pointerSha(root, 'csv/current.json')
    expect(await archive.getFile(scope.runId, rawA)).toBeTruthy()
    expect(await archive.getCsvFile(scope.runId, rawA, 'link_state.csv')).toBeTruthy()

    const state = await armTransientCsvWriteError()
    const b = await archive.begin(scope, wideBindings)
    await b.append(wideFrame())
    expect(b.failure()?.message).toBe('AUDIT transient CSV write')
    await expect(b.close()).rejects.toThrow('256MiB')
    const afterFirst = probe.rawReads
    await expect(b.close()).rejects.toThrow('256MiB')
    // 第二次及后续 close 不再重建同代原文
    expect(probe.rawReads).toBe(afterFirst)
    expect(afterFirst).toBeGreaterThanOrEqual(1)
    state.armed = false
    // 两级指针保持旧 A，可读可下载；B 原文保留
    expect(await pointerSha(root, 'current.json')).toBe(rawA)
    expect(await pointerSha(root, 'csv/current.json')).toBe(csvA)
    expect(await archive.getFile(scope.runId, rawA)).toBeTruthy()
    expect(await archive.getCsvFile(scope.runId, rawA, 'link_state.csv')).toBeTruthy()
    // B 原文保留：B 的原文文件（含独有帧 5）存在且与 A 的原文文件（含帧 1）不同
    const files = await rawFrameIdsByFile(root)
    const bFile = files.find(file => file.ids.includes(5))
    const aFile = files.find(file => file.ids.includes(1))
    expect(bFile).toBeTruthy()
    expect(aFile).toBeTruthy()
    expect(bFile!.name).not.toBe(aFile!.name)
  })

  it('无旧 A：重建确认容量超限后不出现完整发布指针，B 原文保留，重复 close 均拒绝', async () => {
    __setDerivedCsvLimitBytesForTest(512)
    const root = await makeRoot('no-a')
    const archive = createEngineFrameArchive(root, () => scope.startedAt)
    const state = await armTransientCsvWriteError()
    const b = await archive.begin(scope, wideBindings)
    await b.append(wideFrame())
    expect(b.failure()?.message).toBe('AUDIT transient CSV write')
    await expect(b.close()).rejects.toThrow('256MiB')
    const afterFirst = probe.rawReads
    await expect(b.close()).rejects.toThrow('256MiB')
    expect(probe.rawReads).toBe(afterFirst)
    state.armed = false
    expect(await archive.load(scope.runId)).toBeNull()
    await expect(readFile(join(root, scope.runId, 'current.json'), 'utf8')).rejects.toThrow()
    expect(await preservedRaw(root)).toBe(true)
  })

  it('对照：未超限的临时 CSV 写故障恢复后重建成功，再次 close 幂等', async () => {
    __setDerivedCsvLimitBytesForTest(1024 * 1024)
    const root = await makeRoot('transient')
    const archive = createEngineFrameArchive(root, () => scope.startedAt)
    const state = await armTransientCsvWriteError()
    const b = await archive.begin(scope, singleBindings)
    await b.append(singleFrame(1))
    expect(b.failure()?.message).toBe('AUDIT transient CSV write')
    state.armed = false
    await b.close()
    expect(b.failure()).toBeNull()
    const summary = (await archive.load(scope.runId))!
    expect(summary.frameCount).toBe(1)
    expect(await archive.getFile(scope.runId, summary.sourceSha256)).toBeTruthy()
    expect(await archive.getCsvFile(scope.runId, summary.sourceSha256, 'link_state.csv')).toBeTruthy()
    const before = await pointerSha(root, 'current.json')
    await b.close()
    expect(await pointerSha(root, 'current.json')).toBe(before)
    expect(await archive.load(scope.runId)).toMatchObject({ frameCount: 1 })
  })
})

// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log'
const fault = vi.hoisted(() => ({ code: '', remaining: 0, calls: 0, stage: 'generation' }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises') as { rename: (from: unknown, to: unknown) => Promise<void> } & Record<string, unknown>
  return { ...actual, rename: async (from: unknown, to: unknown) => {
    const target = String(to).replaceAll('\\', '/')
    const matches = fault.stage === 'pointer' ? target.endsWith('/current.json')
      : fault.stage === 'time-series' ? /\/time-series-[^/]+$/.test(target) : /\/engine-csv-[^/]+$/.test(target)
    if (fault.code && matches) {
      fault.calls++
      if (fault.remaining-- > 0) throw Object.assign(new Error('injected rename error'), { code: fault.code })
    }
    return actual.rename(from, to)
  } }
})
const { mkdtemp, readFile, readdir, rm } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { platform } = await import('node:' + 'process')
const { createEngineCsvSession } = await import('../../server/local/' + 'engine-frame-csv.js')
const { writeTimeSeries } = await import('../../server/local/' + 'time-series.js')
const roots: string[] = []
afterEach(async () => {
  Object.assign(fault, { code: '', remaining: 0, calls: 0, stage: 'generation' })
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'wrj-csv-rename-')); roots.push(root); return root }

it.skipIf(platform !== 'win32').each(['EPERM', 'EBUSY', 'EACCES'])('Windows 临时 %s 后发布同一代，不提前创建指针', async code => {
  const root = await fixture(), session = await createEngineCsvSession(root, 'TASK-RENAME', {})
  Object.assign(fault, { code, remaining: 2 })
  const closing = session.close('a'.repeat(64))
  await vi.waitFor(() => expect(fault.calls).toBe(1))
  expect(await readdir(root)).not.toContain('current.json')
  await closing
  expect(fault.calls).toBe(3)
  const pointer = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))
  expect(pointer.sourceSha256).toBe('a'.repeat(64))
  expect((await readdir(root)).filter((name: string) => name.startsWith('engine-csv-'))).toHaveLength(1)
})
it.skipIf(platform !== 'win32')('CSV 指针短暂占用同样重试成功', async () => {
  const root = await fixture(), session = await createEngineCsvSession(root, 'TASK-RENAME', {})
  Object.assign(fault, { code: 'EPERM', remaining: 1, stage: 'pointer' })
  await session.close('a'.repeat(64))
  expect(fault.calls).toBe(2)
  expect(JSON.parse(await readFile(join(root, 'current.json'), 'utf8')).sourceSha256).toBe('a'.repeat(64))
})
it.skipIf(platform !== 'win32')('持续占用有界失败，已有指针不被新代覆盖', async () => {
  const root = await fixture(), old = await createEngineCsvSession(root, 'TASK-RENAME', {})
  await old.close('a'.repeat(64))
  const previous = await readFile(join(root, 'current.json'), 'utf8')
  const next = await createEngineCsvSession(root, 'TASK-RENAME', {})
  Object.assign(fault, { code: 'EPERM', remaining: 99 })
  await expect(next.close('b'.repeat(64))).rejects.toMatchObject({ code: 'EPERM' })
  expect(fault.calls).toBe(6)
  expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(previous)
})
it('非临时错误直接失败，不反复重试', async () => {
  const root = await fixture(), session = await createEngineCsvSession(root, 'TASK-RENAME', {})
  Object.assign(fault, { code: 'EIO', remaining: 99 })
  await expect(session.close('a'.repeat(64))).rejects.toMatchObject({ code: 'EIO' })
  expect(fault.calls).toBe(1)
  expect(await readdir(root)).not.toContain('current.json')
})

it.skipIf(platform !== 'win32')('自然结束后的时序结果目录遇到 EPERM 可完成发布', async () => {
  const root = await fixture(), log = parseAfsimEventLog(REPORT_EVENT_CSV)
  Object.assign(fault, { code: 'EPERM', remaining: 2, stage: 'time-series' })
  const published = await writeTimeSeries(root, { taskId: 'TASK-RENAME', runId: 'RUN-RENAME' }, log, 'a'.repeat(64))
  expect(fault.calls).toBe(3)
  expect(JSON.parse(await readFile(join(published, 'manifest.json'), 'utf8')).files[0].rowCount).toBe(log.events.length)
  expect((await readdir(root)).filter((name: string) => name.startsWith('.time-series-'))).toEqual([])
})

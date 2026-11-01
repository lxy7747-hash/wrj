// @vitest-environment node
import { afterEach, expect, it } from 'vitest'

const { mkdtemp, readFile, rm, writeFile } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createHash } = await import('node:' + 'crypto')
const { DiskRealtimeJournal } = await import('../../server/local/' + 'realtime-journal.js')

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wrj-journal-'))
  directories.push(path)
  return path
}

it('disk journal reconstructs a history beyond its bounded hot cache', async () => {
  const path = await directory()
  const writer = new DiskRealtimeJournal(path, 2)
  for (let sequence = 1; sequence <= 130; sequence += 1) {
    writer.append('TASK-001', 'runtime.state', { sequence, message: `event-${sequence}` })
  }
  const restored = new DiskRealtimeJournal(path, 2)
  const available = restored.canResume('TASK-001', 'runtime.state', 1, true)
  expect(available).toMatchObject({ ok: true, first: 1, latest: 130 })
  const page = restored.readAfter('TASK-001', 'runtime.state', 1, 256)
  expect(page).toMatchObject({ ok: true })
  if (page.ok) expect(page.events.map((event: { sequence: number }) => event.sequence)).toEqual(Array.from({ length: 129 }, (_, index) => index + 2))
})

it('run boundaries invalidate only the prior task cursor, preserving other task histories', async () => {
  const path = await directory()
  const writer = new DiskRealtimeJournal(path, 2)
  writer.prepareRun('TASK-001', 'RUN-OLD')
  writer.append('TASK-001', 'runtime.state', { sequence: 1, message: 'task-one-old' })
  writer.prepareRun('TASK-002', 'RUN-TWO')
  writer.append('TASK-002', 'runtime.state', { sequence: 1, message: 'task-two' })
  writer.prepareRun('TASK-001', 'RUN-NEW')
  writer.append('TASK-001', 'runtime.state', { sequence: 2, message: 'task-one-new' })

  const restored = new DiskRealtimeJournal(path, 2)
  expect(restored.canResume('TASK-001', 'runtime.state', 1, true)).toMatchObject({ ok: false })
  expect(restored.canResume('TASK-001', 'runtime.state', 0, false)).toMatchObject({ ok: true })
  expect(restored.canResume('TASK-002', 'runtime.state', 1, true)).toMatchObject({ ok: true, latest: 1 })
})

it('a new controller run binding rejects an old durable cursor before replay', async () => {
  const path = await directory()
  const first = new DiskRealtimeJournal(path, 2)
  first.prepareRun('TASK-001', 'RUN-A')
  first.append('TASK-001', 'runtime.state', { sequence: 1, message: 'run-a' })
  const restarted = new DiskRealtimeJournal(path, 2)
  expect(restarted.prepareRun('TASK-001', 'RUN-B')).toBe(true)
  expect(restarted.canResume('TASK-001', 'runtime.state', 1, true)).toMatchObject({ ok: false })
})

it('reset rotates the active generation without deleting the prior journal evidence', async () => {
  const path = await directory()
  const journal = new DiskRealtimeJournal(path, 2)
  journal.append('TASK-001', 'runtime.state', { sequence: 1, message: 'before-reset' })
  const before = JSON.parse(await readFile(join(path, 'active.json'), 'utf8')) as { generation: string }
  const taskHash = createHash('sha256').update('TASK-001').digest('hex')
  const priorEvent = join(path, taskHash, before.generation, 'runtime.state', 'events.ndjson')
  journal.clear()
  const after = JSON.parse(await readFile(join(path, 'active.json'), 'utf8')) as { generation: string }
  expect(after.generation).not.toBe(before.generation)
  expect(await readFile(priorEvent, 'utf8')).toContain('before-reset')
  journal.append('TASK-001', 'runtime.state', { sequence: 1, message: 'after-reset' })
  expect(new DiskRealtimeJournal(path, 2).readAfter('TASK-001', 'runtime.state', 0, 1)).toMatchObject({ ok: true, events: [{ sequence: 1, message: 'after-reset' }] })
})

it('corrupt persisted records produce an explicit gap instead of a partial replay', async () => {
  const path = await directory()
  const writer = new DiskRealtimeJournal(path, 2)
  writer.append('TASK-001', 'runtime.state', { sequence: 1, message: 'valid' })
  const active = JSON.parse(await readFile(join(path, 'active.json'), 'utf8')) as { generation: string }
  const taskHash = createHash('sha256').update('TASK-001').digest('hex')
  await writeFile(join(path, taskHash, active.generation, 'runtime.state', 'events.ndjson'), `${JSON.stringify({
    sequence: 1,
    message: 'tampered',
    digest: createHash('sha256').update('valid').digest('hex'),
  })}\n`, 'utf8')
  const restored = new DiskRealtimeJournal(path, 2)
  expect(restored.readAfter('TASK-001', 'runtime.state', 0, 1)).toMatchObject({ ok: false, reason: expect.stringContaining('corrupt') })
})

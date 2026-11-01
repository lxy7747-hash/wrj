// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
const { DiskRealtimeJournal } = await import('../../server/local/' + 'realtime-journal.js')
const { mkdtemp, readFile, writeFile, readdir, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createHash } = await import('node:' + 'crypto')
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'wrj-durable-boundary-')); roots.push(root); return { root, journal: new DiskRealtimeJournal(root, 2) } }
async function topicPath(root: string, topic: string) {
  const { generation } = JSON.parse(await readFile(join(root, 'active.json'), 'utf8'))
  return join(root, createHash('sha256').update('TASK-001').digest('hex'), generation, topic)
}

describe('持久WS的代际、损坏及有界页', () => {
  it('混合订阅中的零游标也只读取当前运行，不泄漏上一运行的链路消息', async () => {
    const { journal } = await fixture()
    journal.prepareRun('TASK-001', 'RUN-A')
    journal.append('TASK-001', 'link.metric', { sequence: 1, message: 'old-metric' })
    journal.append('TASK-001', 'runtime.state', { sequence: 1, message: 'old-runtime' })
    journal.prepareRun('TASK-001', 'RUN-B')
    journal.append('TASK-001', 'link.metric', { sequence: 2, message: 'new-metric' })
    journal.append('TASK-001', 'runtime.state', { sequence: 2, message: 'new-runtime' })
    expect(journal.canResume('TASK-001', 'runtime.state', 2, true)).toMatchObject({ ok: true })
    expect(journal.canResume('TASK-001', 'link.metric', 0, true)).toMatchObject({ ok: true })
    expect(journal.readAfter('TASK-001', 'link.metric', 0, 64)).toMatchObject({ ok: true, events: [{ sequence: 2, message: 'new-metric' }] })
  })

  it('冷启动遇到部分已切换的有效元数据，会使所有旧游标失效', async () => {
    const { root, journal } = await fixture()
    journal.prepareRun('TASK-001', 'RUN-A')
    journal.append('TASK-001', 'simulation.frame', { sequence: 1, message: 'frame-A' })
    journal.append('TASK-001', 'runtime.state', { sequence: 1, message: 'state-A' })
    await writeFile(join(await topicPath(root, 'simulation.frame'), 'meta.json'), JSON.stringify({ runId: 'RUN-B', boundary: 2 }))
    const restored = new DiskRealtimeJournal(root, 2)
    expect(restored.prepareRun('TASK-001', 'RUN-B')).toBe(true)
    expect(restored.canResume('TASK-001', 'runtime.state', 1, true)).toMatchObject({ ok: false })
  })

  it.each([{ runId: 'RUN-A', boundary: 'bad' }, { runId: 'RUN-A', latest: 999 }, { runId: '../wrong' }])('不信任损坏元数据 %j', async meta => {
    const { root, journal } = await fixture()
    journal.prepareRun('TASK-001', 'RUN-A')
    await writeFile(join(await topicPath(root, 'runtime.state'), 'meta.json'), JSON.stringify(meta))
    expect(new DiskRealtimeJournal(root, 2).canResume('TASK-001', 'runtime.state', 0, false)).toMatchObject({ ok: false, reason: expect.stringContaining('corrupt') })
  })

  it('不接受越界generation或缺失索引的数据，不覆盖历史修补故障', async () => {
    const { root, journal } = await fixture()
    journal.append('TASK-001', 'runtime.state', { sequence: 1, message: 'first' })
    const path = join(await topicPath(root, 'runtime.state'), 'events.idx')
    await writeFile(path, '')
    expect(new DiskRealtimeJournal(root, 2).readAfter('TASK-001', 'runtime.state', 0, 1)).toMatchObject({ ok: false })
    await writeFile(join(root, 'active.json'), JSON.stringify({ generation: '../../outside' }))
    const invalid = new DiskRealtimeJournal(root, 2)
    expect(invalid.canResume('TASK-001', 'runtime.state', 0, false)).toMatchObject({ ok: false })
    expect(() => invalid.append('TASK-001', 'runtime.state', { sequence: 1, message: 'bad' })).toThrow()
  })

  it('大记录按总字节分页，下一页连续；重置保留旧目录，任务大小写不碰撞', async () => {
    const { root, journal } = await fixture()
    const message = 'x'.repeat(3 * 1024 * 1024)
    journal.append('TASK-001', 'runtime.state', { sequence: 1, message })
    journal.append('TASK-001', 'runtime.state', { sequence: 2, message })
    expect(journal.readAfter('TASK-001', 'runtime.state', 0, 512)).toMatchObject({ ok: true, events: [{ sequence: 1 }] })
    expect(journal.readAfter('TASK-001', 'runtime.state', 1, 512)).toMatchObject({ ok: true, events: [{ sequence: 2 }] })
    expect(journal.readAfter('TASK-001', 'runtime.state', 0, 0)).toMatchObject({ ok: false })
    journal.append('TASK-a', 'runtime.state', { sequence: 1, message: 'lower' })
    journal.append('TASK-A', 'runtime.state', { sequence: 1, message: 'upper' })
    const oldPath = await topicPath(root, 'runtime.state')
    journal.clear()
    expect(await readdir(oldPath)).toContain('events.ndjson')
    expect(journal.canResume('TASK-001', 'runtime.state', 2, true)).toMatchObject({ ok: false })
  })
})

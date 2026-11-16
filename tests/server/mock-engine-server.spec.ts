// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'
const { readMockFrames } = await import('../../scripts/websocketData/' + 'read-frames.mjs')
const { startMockEngine } = await import('../../server/local/' + 'mock-engine-server.js')
const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { WebSocket } = await import('w' + 's')
const cleanups: Array<() => void | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers() })
const frame = (frame_id: number) => ({ msg_type: 'frame_snapshot', frame_id, link_calc: { links: [] } })
async function file(text: string, encoding: 'utf8' | 'utf16le' = 'utf8') {
  const dir = await mkdtemp(join(tmpdir(), 'wrj-mock-txt-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'frame_snap.txt'); await writeFile(path, text, encoding); return path
}

it.each(['utf8', 'utf16le'] as const)('读取 %s BOM、时间戳前缀和空行，保留原字段', async encoding => {
  const first = { ...frame(0), extra: { rate: 1.2e-200 } }
  const path = await file(`\uFEFF[2026-11-11 23:25:33.286] ${JSON.stringify(first)}\r\n\r\n${JSON.stringify(frame(5))}\n`, encoding)
  expect(readMockFrames(path)).toEqual([first, frame(5)])
})

it.each([
  ['', '没有可推送的帧'],
  ['{bad}', '第 1 行'],
  [JSON.stringify({ ...frame(0), msg_type: 'other' }), 'frame_snapshot'],
  [JSON.stringify(frame(-1)), 'frame_id'],
  [JSON.stringify({ ...frame(0), link_calc: {} }), 'link_calc.links'],
  [[frame(5), frame(5)].map(value => JSON.stringify(value)).join('\n'), '第 2 行'],
  [[frame(5), frame(0)].map(value => JSON.stringify(value)).join('\n'), '递增'],
])('坏数据明确拒绝，不用旧 JSON 填补：%s', async (text, message) => {
  const awaitPath = await file(text)
  expect(() => readMockFrames(awaitPath)).toThrow(message)
})

it('完整新 TXT 的 1081 帧保持 0→5400，全部通过当前接收适配器', () => {
  const frames = readMockFrames()
  expect(frames).toHaveLength(1081)
  for (const [index, value] of frames.entries()) {
    expect(value.frame_id).toBe(index * 5)
    expect(adaptEngineFrameSnapshot(value).data, `帧 ${value.frame_id}`).not.toBeNull()
  }
  expect(() => readMockFrames('missing-mock-source.txt')).toThrow('ENOENT')
})

async function connect() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const engine = await startMockEngine(5000); cleanups.push(() => engine.close())
  const socket = new WebSocket(engine.url), frames: any[] = []
  cleanups.push(() => socket.terminate())
  socket.on('message', (data: { toString(): string }) => frames.push(JSON.parse(data.toString())))
  await once(socket, 'open'); await vi.waitFor(() => expect(frames).toHaveLength(1))
  const control = async (action: string) => {
    socket.send(JSON.stringify({ msg_type: 'sim_control', action }))
    const pong = once(socket, 'pong'); socket.ping(); await pong
  }
  return { engine, frames, control }
}

it('真实 WS 推送原始帧，暂停冻结、恢复下一帧、停止后不再恢复发送', async () => {
  const { frames, control } = await connect()
  const raw = (await readFile('scripts/websocketData/frame_snap.txt', 'utf16le')).replace(/^\uFEFF/, '').split(/\r?\n/)
  expect(frames[0]).toEqual(JSON.parse(raw[0]!.replace(/^\[[^\]]+\]\s*/, '')))
  expect(frames[0]).not.toHaveProperty('wall_time_ms')
  await vi.advanceTimersByTimeAsync(5000); await vi.waitFor(() => expect(frames).toHaveLength(2))
  expect(frames[1].frame_id).toBe(5)
  await control('pause'); await vi.advanceTimersByTimeAsync(15000)
  expect(frames).toHaveLength(2)
  await control('resume'); await vi.advanceTimersByTimeAsync(5000)
  await vi.waitFor(() => expect(frames).toHaveLength(3)); expect(frames[2].frame_id).toBe(10)
  await control('stop'); await control('resume'); await vi.advanceTimersByTimeAsync(10000)
  expect(frames).toHaveLength(3)
})

it('完整发送后停在 5400 不循环，新连接从 0 开始', async () => {
  const { engine, frames } = await connect()
  await vi.advanceTimersByTimeAsync(1081 * 5000)
  await vi.waitFor(() => expect(frames).toHaveLength(1081), { timeout: 5000 })
  expect(frames.at(-1).frame_id).toBe(5400)
  await vi.advanceTimersByTimeAsync(60000); expect(frames).toHaveLength(1081)
  const next = new WebSocket(engine.url); cleanups.push(() => next.terminate())
  const received = once(next, 'message'); await once(next, 'open')
  expect(JSON.parse((await received)[0].toString()).frame_id).toBe(0)
})

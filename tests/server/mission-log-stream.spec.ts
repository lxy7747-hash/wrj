// @vitest-environment node
import { expect, it } from 'vitest'
import type { MissionLogUpdate } from '../../src/contracts/domain-models'
const { MissionLogStreamer, splitUtf8 } = await import('../../server/local/' + 'mission-log-stream.js')

it('按完整 UTF-8 字符分块，不拆分中文或 emoji', () => {
  const chunks = splitUtf8('甲🙂乙', 4)
  expect(chunks).toEqual(['甲', '🙂', '乙'])
  expect(chunks.join('')).toBe('甲🙂乙')
})

it('首次读取仅作 HTTP 恢复基线，后续追加和尾部替换均带明确语义', async () => {
  const snapshots = [
    { text: '初始\n', bytes: 7, truncated: false },
    { text: '初始\n新增🙂\n', bytes: 18, truncated: false },
    { text: '末尾\n', bytes: 70_000, truncated: true },
  ]
  const updates: unknown[] = []
  const stream = new MissionLogStreamer(async () => snapshots.shift()!, (update: MissionLogUpdate) => updates.push(update), 'RUN-LOG', 1_000)
  await stream.prime()
  await stream.poll()
  await stream.poll()
  expect(updates).toEqual([
    { kind: 'MISSION_LOG', runId: 'RUN-LOG', text: '新增🙂\n', replace: false, bytes: 18, truncated: false, chunkIndex: 0, chunkCount: 1, startByteOffset: 7, endByteOffset: 18 },
    { kind: 'MISSION_LOG', runId: 'RUN-LOG', text: '末尾\n', replace: true, bytes: 70_000, truncated: true, chunkIndex: 0, chunkCount: 1, startByteOffset: 0, endByteOffset: 70_000 },
  ])
})

// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import type { MissionPositionUpdate } from '../../src/contracts/domain-models'
const { MissionPositionStreamer } = await import('../../server/local/' + 'mission-position-stream.js')

afterEach(() => vi.useRealTimers())

it('只发布本次 mission 位置源的变化快照，不把文件代际当引擎帧', async () => {
  const snapshots = [
    { runId: 'RUN-POS', scenarioId: 'SCN-POS', revision: 2, positions: { fileName: 'position.csv', generation: 4, recordCount: 7, issueCount: 0, issues: [], waitingForLine: false, hasMore: false, nodes: [{ platformId: 'P-1', time: 3, longitude: 120, latitude: 30, altitude: 100, speed: 20, heading: 90 }] } },
    { runId: 'RUN-POS', scenarioId: 'SCN-POS', revision: 2, positions: { fileName: 'position.csv', generation: 4, recordCount: 8, issueCount: 0, issues: [], waitingForLine: false, hasMore: false, nodes: [{ platformId: 'P-1', time: 4, longitude: 120.1, latitude: 30, altitude: 100, speed: 20, heading: 90 }] } },
  ]
  const updates: MissionPositionUpdate[] = []
  let index = 0
  const stream = new MissionPositionStreamer(async () => snapshots[Math.min(index++, snapshots.length - 1)]!, (update: MissionPositionUpdate) => updates.push(update), { runId: 'RUN-POS', scenarioId: 'SCN-POS', revision: 2 })
  await stream.poll(); await stream.poll(); await stream.poll()
  expect(updates).toHaveLength(2)
  expect(updates[1]).toMatchObject({ sourceGeneration: 4, sourceRecordCount: 8, nodes: [{ platformId: 'P-1', time: 4 }] })
  expect(updates[1]).not.toHaveProperty('frameId')
  expect(updates[1]).not.toHaveProperty('simulationTime')
})

it('首次位置读取失败后由下一轮重试，且不会留下未处理拒绝', async () => {
  vi.useFakeTimers()
  const updates: MissionPositionUpdate[] = []
  let attempts = 0
  const stream = new MissionPositionStreamer(async () => {
    attempts += 1
    if (attempts === 1) throw new Error('position source unavailable')
    return { runId: 'RUN-POS', scenarioId: 'SCN-POS', revision: 2, positions: { fileName: 'position.csv', generation: 1, recordCount: 1, issueCount: 0, issues: [], waitingForLine: false, hasMore: false, nodes: [] } }
  }, (update: MissionPositionUpdate) => updates.push(update), { runId: 'RUN-POS', scenarioId: 'SCN-POS', revision: 2 }, 20)
  stream.start()
  await vi.advanceTimersByTimeAsync(20)
  expect(attempts).toBe(2)
  expect(updates).toHaveLength(1)
  stream.stop()
})

it('停止或重启后不发布在途旧读取的结果', async () => {
  let resolveRead!: (snapshot: { runId: string; scenarioId: string; revision: number; positions: { fileName: string; generation: number; recordCount: number; issueCount: number; issues: []; waitingForLine: boolean; hasMore: boolean; nodes: [] } }) => void
  const updates: MissionPositionUpdate[] = []
  const stream = new MissionPositionStreamer(() => new Promise(resolve => { resolveRead = resolve }), (update: MissionPositionUpdate) => updates.push(update), { runId: 'RUN-POS', scenarioId: 'SCN-POS', revision: 2 })
  stream.start()
  await Promise.resolve()
  stream.stop()
  resolveRead({ runId: 'RUN-POS', scenarioId: 'SCN-POS', revision: 2, positions: { fileName: 'position.csv', generation: 1, recordCount: 1, issueCount: 0, issues: [], waitingForLine: false, hasMore: false, nodes: [] } })
  await Promise.resolve()
  expect(updates).toEqual([])
})

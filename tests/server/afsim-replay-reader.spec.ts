// @vitest-environment node
import { expect, it, vi } from 'vitest'

const source = vi.hoisted(() => ({ initial: { nodes: [] as Array<{ platformId: string; time: number }>,
  connections: [] as Array<{ time: number }>, deviceEvents: [] as Array<{ time: number }>,
  platformDeletions: [] as Array<{ time: number }> } }))
vi.mock('../../server/local/afsim-log-reader.js', () => ({
  readInitialNodes: async () => source.initial,
  readLocalFileSnapshot: async () => ({ bytes: new TextEncoder().encode('TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n'),
    source: { fileName: 'positions.csv', sha256: 'TEST' } }),
}))

const readerModule = '../../server/local/' + 'afsim-replay-reader.js'
const { readLocalReplay } = await import(readerModule)

it('大量初始、关联、设备及删除时刻逐项计算，不超过函数参数上限', async () => {
  source.initial = {
    nodes: Array(150_000).fill({ platformId: 'A', time: 1 }),
    connections: Array(150_000).fill({ time: 2 }),
    deviceEvents: Array(150_000).fill({ time: 3 }),
    platformDeletions: Array(150_000).fill({ time: 4 }),
  }
  expect((await readLocalReplay('initial.csv', 'positions.csv')).durationS).toBe(4)
  source.initial = { nodes: [], connections: [], deviceEvents: [], platformDeletions: [] }
  expect((await readLocalReplay('initial.csv', 'positions.csv')).durationS).toBe(0)
})

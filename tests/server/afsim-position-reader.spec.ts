// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPositionSnapshot, mergePositionNodes } from '../../src/features/situation/position-updates'
import type { InitialNodeSnapshot } from '../../src/features/situation/initial-nodes'
import { isLocalReplaySnapshot, selectReplayNodes } from '../../src/features/replays/local-replay'
import { INITIAL_LOG, LOCAL_REPLAY, POSITION_CSV } from '../fixtures/local-replay'

// Node 专用模块只在运行时加载，不纳入浏览器类型工程。
const fsModule = 'node:fs/' + 'promises'
const osModule = 'node:' + 'os'
const pathModule = 'node:' + 'path'
const eventsModule = 'node:' + 'events'
const readerModule = '../../server/local/' + 'afsim-position-reader.js'
const appModule = '../../server/' + 'app.js'
const requestModule = 'super' + 'test'
const { mkdtemp, writeFile, appendFile, readFile, rename, rm } = await import(fsModule)
const fs = (await import(fsModule)).default
const moduleModule = 'node:' + 'module'
const { syncBuiltinESMExports } = await import(moduleModule)
const { tmpdir } = await import(osModule)
const { join } = await import(pathModule)
const { once } = await import(eventsModule)
const { createPositionReader } = await import(readerModule)
const replayReaderModule = '../../server/local/' + 'afsim-replay-reader.js'
const { readLocalReplay } = await import(replayReaderModule)
const HEADER = 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n'
let directory = ''

/** 每个用例建立独立临时文件，禁止修改用户实际 AFSIM 输出。 */
async function fixture(text: string) {
  directory = await mkdtemp(join(tmpdir(), 'wrj-position-test-'))
  const path = join(directory, 'positions.csv')
  await writeFile(path, text)
  return { path, read: createPositionReader(path) }
}

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  if (directory) await rm(directory, { recursive: true })
  directory = ''
})

describe('AFSIM 追加位置读取', () => {
  it.each([[42, 0], [0, 42], [0, 0], [42, 42]])('设备号 %s/%s 可读取同一文件', async (handleDev, pathDev) => {
    const { path, read } = await fixture(POSITION_CSV)
    const handle = await fs.open(path, 'r')
    const stats = await handle.stat()
    vi.spyOn(handle, 'stat').mockResolvedValue({ ...stats, dev: handleDev, isFile: () => true })
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle)
    vi.spyOn(fs, 'stat').mockResolvedValueOnce({ ...stats, dev: pathDev })
    syncBuiltinESMExports()
    expect(isPositionSnapshot(await read())).toBe(true)
  })

  it.each(['dev', 'ino', 'size', 'birthtimeMs'] as const)('仍拒绝文件替换或截断：%s', async (field) => {
    const { path, read } = await fixture(POSITION_CSV)
    const handle = await fs.open(path, 'r')
    const stats = await handle.stat()
    // Windows 文件编号可能超出安全整数范围，使用可精确递增的测试编号。
    const before = { ...stats, dev: 42, ino: 100, isFile: () => true }
    const after = { ...before, dev: 0, [field]: field === 'size' ? stats.size - 1 : before[field] + 1 }
    expect(after[field]).not.toBe(before[field])
    vi.spyOn(handle, 'stat').mockResolvedValue(before)
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle)
    vi.spyOn(fs, 'stat').mockResolvedValueOnce(after)
    syncBuiltinESMExports()
    await expect(read()).rejects.toThrow('位置文件正在替换')
  })

  it('文件回放读取完整历史，与实时游标隔离，重新加载后可见追加记录', async () => {
    const { path, read } = await fixture(POSITION_CSV)
    const initialPath = join(directory, 'initial.csv')
    await writeFile(initialPath, INITIAL_LOG)
    const live = await read()
    const history = await readLocalReplay(initialPath, path)
    expect(isLocalReplaySnapshot(history)).toBe(true)
    expect(history).toMatchObject({ durationS: 3, recordCount: 3, issueCount: 0, tracks: LOCAL_REPLAY.tracks })
    expect(await read()).toEqual(live)
    expect(selectReplayNodes(history, 0)[0]).toMatchObject({ longitude: -77, latitude: 30 })
    expect(selectReplayNodes(history, 2)[0]).toMatchObject({ longitude: -78, latitude: 31 })
    expect(selectReplayNodes(history, 3)[0]).toMatchObject({ longitude: -79, latitude: 32 })
    expect(selectReplayNodes(history, 0)[0]).toMatchObject({ longitude: -77, latitude: 30 })
    await appendFile(path, '4,A,-80,33,30,30,175')
    expect(await readLocalReplay(initialPath, path)).toMatchObject({ durationS: 3, recordCount: 3, waitingForLine: true })
    await appendFile(path, '\n')
    expect(await readLocalReplay(initialPath, path)).toMatchObject({ durationS: 4, recordCount: 4, waitingForLine: false })
    expect(history.durationS).toBe(3)
    expect((await read()).nodes.find((node: { platformId: string }) => node.platformId === 'A').time).toBe(4)
    expect(await readFile(initialPath, 'utf8')).toBe(INITIAL_LOG)
  })

  it('末条位置之后的有效关联登记延长回放，节点保持最后位置', async () => {
    const { path } = await fixture(POSITION_CSV)
    const initialPath = join(directory, 'initial.csv')
    await writeFile(initialPath, `${INITIAL_LOG}\n0 COMM_TURNED_ON A Comm: a Type: microwave\n0 COMM_TURNED_ON B Comm: b Type: microwave\n10 LINK_ADDED_TO_MANAGER A a 1 linked to: B b 2\n`)
    const snapshot = await readLocalReplay(initialPath, path)
    expect(snapshot.initial.connections).toHaveLength(1)
    expect(snapshot.durationS).toBe(10)
    expect(isLocalReplaySnapshot(snapshot)).toBe(true)
    expect(isLocalReplaySnapshot({ ...snapshot, durationS: 3 })).toBe(false)
    expect(selectReplayNodes(snapshot, 10)).toEqual(selectReplayNodes(snapshot, 3))
    expect(selectReplayNodes(snapshot, 2)[0]?.longitude).toBe(-78)
    expect(isLocalReplaySnapshot({ ...snapshot, initial: { ...snapshot.initial, connections: [] }, durationS: 3 })).toBe(true)
  })

  it('回放拒绝损坏轨迹，保留缺少更新的节点，不预读未来位置', () => {
    expect(isLocalReplaySnapshot(LOCAL_REPLAY)).toBe(true)
    const noB = { ...LOCAL_REPLAY, tracks: LOCAL_REPLAY.tracks.slice(1), recordCount: 2 }
    expect(selectReplayNodes(noB, 2)[1]).toEqual(LOCAL_REPLAY.initial.nodes[1])
    expect(selectReplayNodes(LOCAL_REPLAY, 0.5)[0]?.longitude).toBe(-77)
    expect(isLocalReplaySnapshot({ ...LOCAL_REPLAY, durationS: 9 })).toBe(false)
    expect(isLocalReplaySnapshot({ ...LOCAL_REPLAY, tracks: [...LOCAL_REPLAY.tracks, LOCAL_REPLAY.tracks[0]] })).toBe(false)
    expect(isLocalReplaySnapshot({ ...LOCAL_REPLAY, tracks: [{ ...LOCAL_REPLAY.tracks[1], positions: [...LOCAL_REPLAY.tracks[1]!.positions].reverse() }] })).toBe(false)
  })

  it('回放异常行与未知节点报告行号，忽略同刻重复且拒绝错误表头和缺失文件', async () => {
    const { path } = await fixture(POSITION_CSV + '3,A,-79,32,20,20,175\n2,A,-79,32,20,20,175\n4,C,118,25,0,0,0\n4,A,181,30,0,0,0\n')
    const initialPath = join(directory, 'initial.csv')
    await writeFile(initialPath, INITIAL_LOG)
    const snapshot = await readLocalReplay(initialPath, path)
    expect(snapshot).toMatchObject({ recordCount: 3, issueCount: 3, durationS: 3 })
    expect(snapshot.issues.map((issue: { line: number }) => issue.line)).toEqual([6, 7, 8])
    expect(isLocalReplaySnapshot(snapshot)).toBe(true)
    await expect(readLocalReplay(initialPath, undefined)).rejects.toThrow('未配置')
    await writeFile(path, 'BAD\n')
    await expect(readLocalReplay(initialPath, path)).rejects.toThrow('表头')
    await writeFile(path, '')
    expect(await readLocalReplay(initialPath, path)).toMatchObject({ recordCount: 0, durationS: 0, tracks: [] })
    await expect(readLocalReplay(initialPath, path, true)).rejects.toThrow('表头')
    await writeFile(path, HEADER)
    expect((await readLocalReplay(initialPath, path)).recordCount).toBe(0)
    await expect(readLocalReplay(initialPath, path, true)).rejects.toThrow('有效位置记录')
  })

  it('回放只读接口校验角色和路径输入，纯 Mock 未配置，失败不泄露路径', async () => {
    const { createMockServer } = await import(appModule)
    const { default: request } = await import(requestModule)
    let reads = 0
    let fail = false
    const server = createMockServer({ loadLocalReplay: async () => {
      reads += 1
      if (fail) throw new Error('E:/private/input.csv')
      return LOCAL_REPLAY
    } })
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const endpoint = '/api/v1/replays/local-file'
    try {
      await request(server.httpServer).get(endpoint).set('Origin', 'http://127.0.0.1:5173').expect(403)
      await request(server.httpServer).get(`${endpoint}?path=other.csv`).set('Origin', 'http://127.0.0.1:5173').set('X-Demo-Role', 'OPERATOR').expect(400)
      expect(reads).toBe(0)
      const result = await request(server.httpServer).get(endpoint).set('Origin', 'http://127.0.0.1:5173').set('X-Demo-Role', 'OPERATOR').expect(200)
      expect(result.body.data).toEqual(LOCAL_REPLAY)
      fail = true
      const failure = await request(server.httpServer).get(endpoint).set('Origin', 'http://127.0.0.1:5173').set('X-Demo-Role', 'ADMIN').expect(503)
      expect(failure.text).not.toContain('E:/private')
    } finally { await server.close() }
    const mock = createMockServer()
    if (!mock.httpServer.listening) await once(mock.httpServer, 'listening')
    try {
      const result = await request(mock.httpServer).get(endpoint).set('Origin', 'http://127.0.0.1:5173').set('X-Demo-Role', 'ADMIN').expect(200)
      expect(result.body.data).toBeNull()
    } finally { await mock.close() }
  })

  it('保留半行，完整后更新；无追加及并发轮询均不重复累计，不写源文件', async () => {
    const original = `\uFEFF${HEADER.replace('\n', '\r\n')}0,A,-77,30,-1.7e-8,223.52,-1.15\r\n1,A,-78,`
    const { path, read } = await fixture(original)
    const first = await read()
    expect(isPositionSnapshot(first)).toBe(true)
    expect(first).toMatchObject({ generation: 1, recordCount: 1, waitingForLine: true, hasMore: false })
    expect(first.nodes[0]).toMatchObject({ longitude: -77, altitude: -1.7e-8, heading: -1.15 })
    expect(await read()).toEqual(first)
    expect(await readFile(path, 'utf8')).toBe(original)
    await appendFile(path, '31,0,220,90\r\n')
    const [second, concurrent] = await Promise.all([read(), read()])
    expect(second).toEqual(concurrent)
    expect(second).toMatchObject({ generation: 1, recordCount: 2, waitingForLine: false })
    expect(second.nodes).toEqual([{ platformId: 'A', time: 1, longitude: -78, latitude: 31, altitude: 0, speed: 220, heading: 90 }])
  })

  it('支持空文件和分段表头，非法表头不会推进游标', async () => {
    const { path, read } = await fixture('')
    expect(await read()).toMatchObject({ nodes: [], recordCount: 0 })
    await appendFile(path, 'TIME,NAME,')
    expect(await read()).toMatchObject({ nodes: [], waitingForLine: true })
    await appendFile(path, 'LON,LAT,ALT,SPEED,HEADING\n0,"节点甲",117,25,0,0,90\n')
    expect((await read()).nodes[0].platformId).toBe('节点甲')
    await writeFile(path, 'INVALID\n')
    await expect(read()).rejects.toThrow('表头')
    await writeFile(path, `${HEADER}0,B,118,26,10,1,0\n`)
    expect((await read()).nodes.map((node: { platformId: string }) => node.platformId)).toEqual(['B'])
  })

  it('异常、倒序与冲突记录带行号跳过，重复记录不生成重复节点', async () => {
    const { read } = await fixture(`${HEADER}1,A,117,25,0,1,90\n1,A,117,25,0,1,90\n0,A,116,24,0,1,90\n1,A,118,25,0,1,90\n2,A,181,25,0,1,90\n2,B,118,26,,1,90\n2,B,118,26,10,1,90\n`)
    const snapshot = await read()
    expect(snapshot).toMatchObject({ recordCount: 3, issueCount: 4 })
    expect(snapshot.nodes).toHaveLength(2)
    expect(snapshot.nodes[0].longitude).toBe(117)
    expect(snapshot.issues.map((issue: { line: number }) => issue.line)).toEqual([4, 5, 6, 7])
    expect(snapshot.issues[0].message).toContain('时间倒退')
    expect(snapshot.issues[1].message).toContain('冲突')
  })

  it('清空、截断后迅速增长、替换与暂时缺失均可恢复，不保留上一轮节点', async () => {
    const { path, read } = await fixture(`${HEADER}0,A,117,25,0,1,90\n`)
    expect((await read()).generation).toBe(1)
    await writeFile(path, `${HEADER}0,B,118,26,10,1,90\n1,B,119,26,10,1,90\n`)
    expect(await read()).toMatchObject({ generation: 2, nodes: [{ platformId: 'B', time: 1 }] })
    await writeFile(path, '')
    expect(await read()).toMatchObject({ generation: 3, nodes: [] })
    await appendFile(path, `${HEADER}0,C,119,27,0,0,0\n`)
    expect((await read()).nodes[0].platformId).toBe('C')
    const previous = join(directory, 'previous.csv')
    await rename(path, previous)
    await expect(read()).rejects.toThrow()
    await writeFile(path, `${HEADER}0,D,120,28,0,0,0\n`)
    expect(await read()).toMatchObject({ generation: 4, nodes: [{ platformId: 'D' }] })
  })

  it('大文件分块追平，仅保存每个节点的最新位置', async () => {
    const total = 40_000
    const { read } = await fixture(HEADER + Array.from({ length: total }, (_, time) => `${time},A,117,25,0,223.52,90\n`).join(''))
    const first = await read()
    expect(first.hasMore).toBe(true)
    expect(first.recordCount).toBeLessThan(total)
    let last = first
    while (last.hasMore) last = await read()
    expect(last).toMatchObject({ recordCount: total, issueCount: 0 })
    expect(last.nodes).toHaveLength(1)
    expect(last.nodes[0].time).toBe(total - 1)
    expect(await read()).toEqual(last)
  })

  it('合并保留未更新节点和原始类型，忽略未知节点，换代后回到初始化基线', async () => {
    const initial: InitialNodeSnapshot = { fileName: 'initial.csv', sha256: 'a'.repeat(64), nodes: ['A', 'B'].map((id) => ({
      platformId: id, name: id, type: 'RAW_TYPE', longitude: 117, latitude: 25, altitude: 0,
      speed: 0, time: 0, sourceEventId: `LOG-${id}`,
    })) }
    const { read } = await fixture(`${HEADER}1,A,118,26,10,2,90\n1,C,119,27,0,0,0\n`)
    const snapshot = await read()
    const merged = mergePositionNodes(initial, snapshot)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ type: 'RAW_TYPE', longitude: 118 })
    expect(merged[1]).toEqual(initial.nodes[1])
    expect(mergePositionNodes(initial, { ...snapshot, generation: 2, nodes: [] })).toEqual(initial.nodes)
    expect(initial.nodes[0]?.longitude).toBe(117)
    expect(isPositionSnapshot({ ...snapshot, nodes: [snapshot.nodes[0], snapshot.nodes[0]] })).toBe(false)
    expect(isPositionSnapshot({ ...snapshot, nodes: [{ ...snapshot.nodes[0], latitude: 91 }] })).toBe(false)
  })

  it('接口限制角色和路径输入，返回位置快照，读取失败不泄露路径，纯 Mock 返回未配置', async () => {
    const { createMockServer } = await import(appModule)
    const { default: request } = await import(requestModule)
    const { read } = await fixture(`${HEADER}0,A,117,25,0,0,0\n`)
    let fail = false
    let reads = 0
    const server = createMockServer({ loadPositions: async () => {
      reads += 1
      if (fail) throw new Error('E:/private/positions.csv')
      return read()
    } })
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    try {
      const endpoint = '/api/v1/situation/positions'
      await request(server.httpServer).get(endpoint).set('Origin', 'http://127.0.0.1:5173').expect(403)
      await request(server.httpServer).get(`${endpoint}?path=anything`).set('Origin', 'http://127.0.0.1:5173').set('X-Demo-Role', 'OPERATOR').expect(400)
      expect(reads).toBe(0)
      const result = await request(server.httpServer).get(endpoint).set('Origin', 'http://127.0.0.1:5173').set('X-Demo-Role', 'OPERATOR').expect(200)
      expect(isPositionSnapshot(result.body.data)).toBe(true)
      expect(result.body.data.nodes).toHaveLength(1)
      fail = true
      const failure = await request(server.httpServer).get(endpoint).set('Origin', 'http://127.0.0.1:5173').set('X-Demo-Role', 'ADMIN').expect(503)
      expect(failure.text).not.toContain('E:/private')
      expect(failure.body.data).toBeUndefined()
    } finally { await server.close() }
    const mock = createMockServer()
    if (!mock.httpServer.listening) await once(mock.httpServer, 'listening')
    try {
      const result = await request(mock.httpServer).get('/api/v1/situation/positions').set('Origin', 'http://127.0.0.1:5173').set('X-Demo-Role', 'ADMIN').expect(200)
      expect(result.body.data).toBeNull()
    } finally { await mock.close() }
  })
})

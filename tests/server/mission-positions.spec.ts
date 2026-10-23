// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { ScenarioDraft } from '../../src/contracts/domain-models.js'
import { isMissionPositionSnapshot } from '../../src/features/situation/mission-positions.js'

const { createMockServer } = await import('../../server/' + 'app.js')
const { MissionPositionReader } = await import('../../server/local/' + 'mission-position-reader.js')
const { default: request } = await import('super' + 'test')
const { appendFile, mkdtemp, mkdir, rm, symlink, writeFile } = await import('node:' + 'fs/promises')
const { once } = await import('node:' + 'events')
const { tmpdir } = await import('node:' + 'os')
const { dirname, join } = await import('node:' + 'path')
type MissionProcess = { pid: number; startedAt: string; entryPath: string; readPositions(): Promise<unknown>; completed: Promise<{ code: number | null }>; stop(): Promise<void> }

const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function startLocalMission(
  output: string | false,
  platforms = [{ platformId: 'CMD-01', name: '指挥节点' }, { platformId: 'AIR-01', name: '无人机' }],
  resolvedDirectory = 'output',
) {
  const root = await mkdtemp(join(tmpdir(), 'wrj-mission-positions-'))
  const entryPath = join(root, 'mission-1', 'comm_SimSetup.txt')
  const positions = new MissionPositionReader()
  let process: MissionProcess | undefined
  const server = createMockServer({ port: 0, missionExecution: {
    start: async (draft: ScenarioDraft, runId: string) => {
      await mkdir(dirname(entryPath), { recursive: true })
      await writeFile(entryPath, 'entry')
      await writeFile(join(dirname(entryPath), 'mapping.json'), JSON.stringify({
        scenarioId: draft.config.scenario.id, revision: draft.revision,
        output: { resolvedDirectory },
        platforms,
      }))
      if (output !== false) {
        await mkdir(join(dirname(entryPath), resolvedDirectory))
        await writeFile(join(dirname(entryPath), resolvedDirectory, 'position.csv'), output)
      }
      positions.attach(runId, draft, entryPath)
      process = { pid: 8001, startedAt: '2026-10-22T00:00:00Z', entryPath,
        readPositions: () => positions.read(runId),
        completed: new Promise(() => {}), stop: async () => {} }
      return process
    },
  } })
  cleanups.push(async () => { await server.close(); await rm(root, { recursive: true, force: true }) })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(server.httpServer)
  const created = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
  const runId = created.body.data.runId
  await api.post(`/api/v1/simulations/${runId}/commands`).set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
  return { api, runId, root, process, server }
}

describe('本次 mission 位置接口', () => {
  it('仅读取本次独占位置文件，并按 mapping 映射平台编号', async () => {
    const { api, runId } = await startLocalMission('TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n0,指挥节点,121,25,100,0,0\n1,未知节点,122,26,200,10,90\n')
    const response = await api.get(`/api/v1/simulations/${runId}/positions`).set(headers).expect(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(isMissionPositionSnapshot(response.body.data)).toBe(true)
    expect(response.body.data).toMatchObject({ runId, scenarioId: 'SCN-001', positions: {
      fileName: 'position.csv', recordCount: 2, nodes: [{ platformId: 'CMD-01', time: 0 }],
    } })
    expect(response.body.data.positions.nodes).toHaveLength(1)
    await api.get(`/api/v1/simulations/${runId}/positions?path=C%3A%5Cother.csv`).set(headers).expect(400)
    await api.get('/api/v1/simulations/RUN-MISSING/positions').set(headers).expect(404)
  })

  it('在本次位置文件尚未创建时返回等待快照', async () => {
    const { api, runId } = await startLocalMission(false)
    const response = await api.get(`/api/v1/simulations/${runId}/positions`).set(headers).expect(200)
    expect(response.body.data).toMatchObject({ runId, scenarioId: 'SCN-001', revision: expect.any(Number), positions: null })
  })

  it('将完整但错误的表头作为读取错误，而非等待状态', async () => {
    const { api, runId } = await startLocalMission('TIME,NAME\n')
    await api.get(`/api/v1/simulations/${runId}/positions`).set(headers).expect(503)
  })

  it('平台显示名称与另一平台编号冲突时，优先保留引擎输出的真实平台编号', async () => {
    const { api, runId } = await startLocalMission('TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n0,CMD-01,121,25,100,0,0\n', [
      { platformId: 'CMD-01', name: '指挥节点' }, { platformId: 'AIR-01', name: 'CMD-01' },
    ])
    const response = await api.get(`/api/v1/simulations/${runId}/positions`).set(headers).expect(200)
    expect(response.body.data.positions.nodes).toMatchObject([{ platformId: 'CMD-01' }])
  })

  it('多个客户端共享本次追加游标，半行暂存后继续推进且不丢旧位置', async () => {
    const { api, runId, process, server } = await startLocalMission('TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n0,指挥节点,121,25,100,0,0\n')
    const alternate = request(server.httpServer)
    const path = join(dirname(process!.entryPath), 'output', 'position.csv')
    expect((await api.get(`/api/v1/simulations/${runId}/positions`).set(headers).expect(200)).body.data.positions.nodes)
      .toMatchObject([{ platformId: 'CMD-01', time: 0 }])
    await appendFile(path, '1,无人机,122,26,200,10')
    const partial = await alternate.get(`/api/v1/simulations/${runId}/positions`).set(headers).expect(200)
    expect(partial.body.data.positions).toMatchObject({ waitingForLine: true, nodes: [{ platformId: 'CMD-01', time: 0 }] })
    await appendFile(path, ',90\n')
    const complete = await api.get(`/api/v1/simulations/${runId}/positions`).set(headers).expect(200)
    expect(complete.body.data.positions).toMatchObject({ waitingForLine: false, recordCount: 2 })
    expect(complete.body.data.positions.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ platformId: 'CMD-01', time: 0 }), expect.objectContaining({ platformId: 'AIR-01', time: 1 }),
    ]))
  })

  it('拒绝无效权限和路径参数，读取错误不泄露本机路径', async () => {
    const { api, runId, root } = await startLocalMission('TIME,NAME\n')
    await api.get(`/api/v1/simulations/${runId}/positions`).set({ Origin: headers.Origin }).expect(403)
    await api.get(`/api/v1/simulations/${runId}/positions`).set({ Origin: headers.Origin, 'X-Demo-Role': 'ROOT' }).expect(403)
    await api.get(`/api/v1/simulations/${runId}/positions?file=C%3A%5Cother.csv`).set(headers).expect(400)
    const failed = await api.get(`/api/v1/simulations/${runId}/positions`).set(headers).expect(503)
    expect(JSON.stringify(failed.body)).not.toContain(root)
  })

  it('拒绝 mapping 中越界的输出目录', async () => {
    const { api, runId } = await startLocalMission(false, undefined, '../other')
    await api.get(`/api/v1/simulations/${runId}/positions`).set(headers).expect(503)
  })

  it('拒绝指向运行目录外的符号链接输出目录', async () => {
    const { api, runId, root, process } = await startLocalMission(false)
    const output = join(dirname(process!.entryPath), 'output')
    const external = join(root, 'external-output')
    await mkdir(external)
    await writeFile(join(external, 'position.csv'), 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n0,CMD-01,121,25,100,0,0\n')
    try {
      await symlink(external, output, 'dir')
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : undefined
      if (code === 'EPERM' || code === 'EACCES') return
      throw error
    }
    await api.get(`/api/v1/simulations/${runId}/positions`).set(headers).expect(503)
  })

  it('登记新运行时清除旧运行绑定', async () => {
    const reader = new MissionPositionReader()
    const draft = { config: { scenario: { id: 'SCN-001' } }, revision: 1 } as unknown as ScenarioDraft
    reader.attach('RUN-OLD', draft, 'C:/mission/old.txt')
    reader.attach('RUN-NEW', draft, 'C:/mission/new.txt')
    expect(reader.has('RUN-OLD')).toBe(false)
    await expect(reader.read('RUN-OLD')).resolves.toBeNull()
    expect(reader.has('RUN-NEW')).toBe(true)
  })
})

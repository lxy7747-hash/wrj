// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import latest from '../fixtures/engine-frame/websocket-latest.json'
import alarmSample from '../fixtures/engine-frame/websocket-new/fream_chenge3.json'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'
const { EngineFrameSqliteStorage } = await import('../../server/local/' + 'engine-frame-sqlite.js')
const { createEngineFrameArchive } = await import('../../server/local/' + 'engine-frame-archive.js')
const { mkdtemp, rm, readFile, writeFile } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { DatabaseSync } = await import('node:' + 'sqlite')
const { createMockServer } = await import('../../server/' + 'app.js')
const { once } = await import('node:' + 'events')
const { default: request } = await import('super' + 'test')
const roots: string[] = [], databases: InstanceType<typeof EngineFrameSqliteStorage>[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
const scope = { taskId: 'TASK-001', runId: 'RUN-HISTORY', scenarioId: 'SCN-A', revision: 1, startedAt: '2026-11-10T00:00:00Z' }
const frame = (id: number, runId = scope.runId, engineEpoch = 0) => ({ ...adaptEngineFrameSnapshot({ ...latest[0], frame_id: id }).data!, runId, engineEpoch })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'wrj-engine-db-')); roots.push(root)
  const path = join(root, 'engine-history.db'), database = new EngineFrameSqliteStorage(path); databases.push(database)
  const archive = createEngineFrameArchive(join(root, 'frames'), () => scope.startedAt, { database })
  return { root, path, database, archive }
}

it('一个数据库隔离同场景多次运行、不同场景和引擎轮次，重开后按时间读取真实帧', async () => {
  const { archive, database, path } = await setup()
  for (const [runId, scenarioId] of [['RUN-HISTORY', 'SCN-A'], ['RUN-SECOND', 'SCN-A'], ['RUN-OTHER', 'SCN-B']]) {
    const session = await archive.begin({ ...scope, runId: runId!, scenarioId: scenarioId! })
    await session.append(frame(5, runId)); await session.append(frame(10, runId)); await session.append(frame(10, runId))
    await session.append(frame(0, runId, 1)); await session.close()
  }
  expect(await archive.replay(scope.runId, scope, 4)).toMatchObject({ engineFrame: null, nextFrameTime: 5, frameCount: 3 })
  expect(await archive.replay(scope.runId, scope, 7)).toMatchObject({ engineFrame: { runId: scope.runId, frameId: 5 }, nextFrameTime: 10 })
  expect(await archive.replay(scope.runId, scope, 10, 1)).toMatchObject({ engineFrame: { engineEpoch: 1, frameId: 0 } })
  await expect(archive.replay(scope.runId, { ...scope, scenarioId: 'SCN-B' }, 5)).rejects.toThrow('不一致')
  database.close(); databases.splice(databases.indexOf(database), 1)
  const reopened = new EngineFrameSqliteStorage(path); databases.push(reopened)
  const replay = await reopened.replay(scope, 10)
  expect(replay.engineFrame!.links[1]!.quality.ber).toBe(latest[0]!.link_calc.links[1]!.quality.ber)
  expect(replay.epochs).toEqual([{ engineEpoch: 0, frameCount: 2, firstTime: 5, lastTime: 10 }, { engineEpoch: 1, frameCount: 1, firstTime: 0, lastTime: 0 }])
})

it.each(['append', 'complete'] as const)('数据库 %s 失败保留文件与待写帧，停止重试后只存一份', async method => {
  const { archive, database } = await setup()
  const session = await archive.begin(scope)
  const fault = vi.spyOn(database, method).mockRejectedValue(new Error('模拟数据库写入失败'))
  await session.append(frame(5))
  await expect(session.close()).rejects.toThrow('数据库写入失败')
  fault.mockRestore()
  await session.close(); await session.close()
  expect(session.failure()).toBeNull()
  expect(await archive.replay(scope.runId, scope, 5)).toMatchObject({ frameCount: 1, engineFrame: { frameId: 5 } })
  expect(await archive.load(scope.runId)).toMatchObject({ frameCount: 1 })
})

it('数据库锁占用时写入失败可以重试，不把未保存帧标成已完成', async () => {
  const { archive, path } = await setup(), session = await archive.begin(scope)
  const locked = new DatabaseSync(path); locked.exec('BEGIN IMMEDIATE')
  try { await session.append(frame(5)); expect(session.failure()).not.toBeNull() }
  finally { locked.exec('ROLLBACK'); locked.close() }
  await session.close()
  expect(await archive.replay(scope.runId, scope, 5)).toMatchObject({ frameCount: 1 })
})

it('旧 JSONL 首次回放按完整摘要导入，重复读取不重复入库且源文件不变', async () => {
  const { root, archive } = await setup()
  const legacy = createEngineFrameArchive(join(root, 'frames'), () => scope.startedAt)
  const session = await legacy.begin(scope)
  const first = { ...adaptEngineFrameSnapshot({ ...alarmSample, frame_id: 5 }).data!, runId: scope.runId }
  await session.append(first); await session.append(frame(10)); await session.close()
  const summary = (await legacy.load(scope.runId))!, file = (await legacy.getFile(scope.runId, summary.sourceSha256))!
  const original = await readFile(file, 'utf8')
  expect(await archive.replay(scope.runId, scope, 4)).toMatchObject({ engineFrame: null, engineEvents: [], engineSwitches: [], engineAlarms: [] })
  const forward = (await archive.replay(scope.runId, scope, 10))!
  expect(forward.engineEvents.map((v: any) => v.event)).toEqual(first.events)
  expect(forward.engineSwitches.map((v: any) => v.route)).toEqual(first.routing.switches)
  expect(forward.engineAlarms.map((v: any) => v.alarm)).toEqual(first.routing.alarms)
  expect(await archive.replay(scope.runId, scope, 0)).toMatchObject({ engineFrame: null, engineEvents: [], engineSwitches: [], engineAlarms: [] })
  expect((await archive.replay(scope.runId, scope, 10))!.frameCount).toBe(2)
  expect(await readFile(file, 'utf8')).toBe(original)
})

it('旧归档校验失败整批回滚，修复源文件后可重新导入', async () => {
  const { root, archive, path } = await setup()
  const legacy = createEngineFrameArchive(join(root, 'frames'), () => scope.startedAt), session = await legacy.begin(scope)
  await session.append(frame(5)); await session.close()
  const summary = (await legacy.load(scope.runId))!, file = (await legacy.getFile(scope.runId, summary.sourceSha256))!
  const original = await readFile(file, 'utf8')
  await writeFile(file, `${JSON.stringify(frame(10))}\n`)
  await expect(archive.replay(scope.runId, scope, 10)).rejects.toThrow('摘要')
  const inspect = new DatabaseSync(path)
  try { expect(inspect.prepare('SELECT COUNT(*) AS n FROM engine_frames').get().n).toBe(0) } finally { inspect.close() }
  await writeFile(file, original)
  expect(await archive.replay(scope.runId, scope, 5)).toMatchObject({ frameCount: 1 })
})

it('超出页面上限的告警仅截取展示，数据库和完整帧保留全部记录', async () => {
  const { archive } = await setup(), session = await archive.begin(scope)
  const value = frame(5)
  value.routing.alarms = Array.from({ length: 205 }, (_, index) => ({ pathId: null, linkId: null, message: `告警 ${index}` }))
  await session.append(value); await session.close()
  const replay = (await archive.replay(scope.runId, scope, 5))!
  expect(replay.historyTruncated).toBe(true)
  expect(replay.engineAlarms).toHaveLength(200)
  expect(replay.engineAlarms[0]!.alarm.message).toBe('告警 5')
  expect(replay.engineAlarms.at(-1)!.alarm.message).toBe('告警 204')
  expect(replay.engineFrame!.routing.alarms).toHaveLength(205)
  expect((await archive.replay(scope.runId, scope, 0))!.engineAlarms).toEqual([])
})

it('回放 API 只读取授权结果所属运行，拒绝替换场景或运行参数', async () => {
  const { archive } = await setup(), session = await archive.begin(scope)
  await session.append(frame(5)); await session.close()
  const resultId = 'RESULT-11111111-1111-4111-8111-111111111111'
  const app = createMockServer({ port: 0, engineFrameArchive: archive,
    missionResults: { get: async (id: string) => id === resultId ? { record: { ...scope, resultId } } : null } as any })
  try {
    if (!app.httpServer.listening) await once(app.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${app.httpServer.address().port}`), route = `/api/v1/mission-results/${resultId}/engine-replay`
    const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
    await api.get(`${route}?time=5`).set('Origin', headers.Origin).expect(403)
    expect((await api.get(`${route}?time=5`).set(headers).expect(200)).body.data).toMatchObject({ runId: scope.runId, scenarioId: scope.scenarioId, engineFrame: { frameId: 5 } })
    for (const query of ['time=-1', 'time=no', 'time=5&epoch=-1', 'time=5&runId=RUN-OTHER', 'time=5&scenarioId=SCN-B']) await api.get(`${route}?${query}`).set(headers).expect(400)
  } finally { await app.close() }
})

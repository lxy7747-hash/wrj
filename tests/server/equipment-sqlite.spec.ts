// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { EQUIPMENT } from '../fixtures/equipment'

const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { DatabaseSync } = await import('node:' + 'sqlite')
const { EquipmentSqliteStorage } = await import('../../server/local/' + 'equipment-sqlite.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const cleanups: Array<() => Promise<void> | void> = []
let directory = ''
const path = '/api/v1/admin/equipment'
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }

async function start(database?: string) {
  if (!directory) directory = await mkdtemp(join(tmpdir(), 'wrj-equipment-test-'))
  const file = database ?? join(directory, 'test.db')
  const storage = new EquipmentSqliteStorage(file)
  const server = createMockServer({ port: 0, equipmentStorage: storage })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  let closed = false
  const close = async () => { if (!closed) { closed = true; await server.close(); storage.close() } }
  cleanups.push(close)
  return { api, storage, server, file, close }
}

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

describe('装备参数正式存储与接口', () => {
  it('空库新增、编辑、重启重载保持参数与版本，记录审计且不植入演示', async () => {
    const first = await start()
    expect((await first.api.get(path).set(headers)).body.data).toEqual([])
    expect((await first.api.post(path).set(headers).send(EQUIPMENT)).status).toBe(201)
    const edited = { ...EQUIPMENT, frequencyMaxMHz: 250, modulation: null, berThreshold: 0 }
    const saved = await first.api.put(`${path}/${EQUIPMENT.equipmentId}`).set(headers).send(edited)
    expect(saved.status).toBe(200)
    expect(saved.body.data).toEqual({ ...edited, version: 2 })
    expect(first.server.auditSnapshot().some((row: { action: string }) => row.action === 'MASTER_DATA_EQUIPMENT_UPDATE')).toBe(true)
    await first.close()
    const second = await start(first.file)
    expect((await second.api.get(path).set(headers)).body.data).toEqual([{ ...edited, version: 2 }])
    expect((await second.api.put(`${path}/${EQUIPMENT.equipmentId}`).set(headers).send(EQUIPMENT)).status).toBe(409)
    expect((await second.api.post(path).set(headers).send(EQUIPMENT)).status).toBe(409)
    expect((await second.api.get(path).set(headers)).body.data[0].version).toBe(2)
  })

  it.each(['OPERATOR', 'INVALID'])('列表与写入拒绝 %s，数据库保持空', async role => {
    const { api, storage } = await start()
    for (const verb of ['get', 'post', 'put'] as const) {
      const call = api[verb](verb === 'put' ? `${path}/TEST-RADIO` : path).set({ ...headers, 'X-Demo-Role': role })
      const response = await (verb === 'get' ? call : call.send(EQUIPMENT))
      expect([401, 403]).toContain(response.status)
      expect(response.body.error.code).not.toBe('LOOPBACK_ONLY')
    }
    expect(storage.load()).toEqual([])
  })

  it.each([
    { equipmentId: '..' }, { type: ' ' }, { frequencyMinMHz: 0 }, { frequencyMaxMHz: -1 },
    { frequencyMinMHz: null }, { frequencyMinMHz: 300 }, { modulation: ' ' },
    { berThreshold: -0.1 }, { berThreshold: 1.1 }, { extra: true }, { version: 0 },
  ])('拒绝非法参数 %j，不改变已有记录', async change => {
    const { api, storage } = await start()
    await api.post(path).set(headers).send(EQUIPMENT)
    const response = await api.put(`${path}/TEST-RADIO`).set(headers).send({ ...EQUIPMENT, ...change })
    expect(response.status).toBe(422)
    expect(response.body.error.fieldPath).toBeTruthy()
    expect(storage.load()).toEqual([EQUIPMENT])
  })

  it('拒绝只读写入、错路径、缺失对象；允许未配置参数与阈值上界', async () => {
    const { api } = await start()
    expect((await api.post(path).set(headers).send({ ...EQUIPMENT, readOnly: true })).status).toBe(403)
    expect((await api.put(`${path}/OTHER`).set(headers).send(EQUIPMENT)).status).toBe(422)
    expect((await api.put(`${path}/TEST-RADIO`).set(headers).send(EQUIPMENT)).status).toBe(404)
    expect((await api.post(path).set(headers).send({ ...EQUIPMENT, version: 2 })).status).toBe(409)
    const nullable = { ...EQUIPMENT, frequencyMinMHz: null, frequencyMaxMHz: null, modulation: null, berThreshold: 1 }
    expect((await api.post(path).set(headers).send(nullable)).status).toBe(201)
  })

  it('跨连接旧版本不能覆盖；只读记录不能更改', async () => {
    const { storage, file, api } = await start()
    expect(storage.save(EQUIPMENT)).toBe(true)
    const second = new EquipmentSqliteStorage(file)
    cleanups.push(() => second.close())
    expect(second.save({ ...EQUIPMENT, version: 2 }, 1)).toBe(true)
    expect(storage.save({ ...EQUIPMENT, version: 2, type: '旧值' }, 1)).toBe(false)
    const db = new DatabaseSync(file)
    cleanups.push(() => db.close())
    db.prepare('UPDATE equipment_parameters SET parameters_json = ?').run(JSON.stringify({ ...EQUIPMENT, version: 2, readOnly: true }))
    expect((await api.put(`${path}/TEST-RADIO`).set(headers).send({ ...EQUIPMENT, version: 2 })).status).toBe(403)
    expect(() => second.save({ ...EQUIPMENT, version: 4 }, 2)).toThrow()
  })

  it('存储错误返回 503 而非假成功；纯 Mock 空库仍可独立使用', async () => {
    const { api, storage } = await start()
    // 锁由测试临时连接持有，不触碰用户数据库。
    const db = new DatabaseSync(join(directory, 'test.db'))
    cleanups.push(() => db.close())
    db.exec('BEGIN EXCLUSIVE')
    try {
      expect((await api.get(path).set(headers)).status).toBe(503)
      expect((await api.post(path).set(headers).send(EQUIPMENT)).status).toBe(503)
    } finally { db.exec('ROLLBACK') }
    expect(storage.load()).toEqual([])
    const server = createMockServer({ port: 0 })
    cleanups.push(() => server.close())
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const mock = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    expect((await mock.get(path).set(headers)).body.data).toEqual([])
    expect((await mock.post(path).set(headers).send(EQUIPMENT)).status).toBe(201)
    expect((await mock.get(path).set(headers)).body.data).toEqual([EQUIPMENT])
  })
})

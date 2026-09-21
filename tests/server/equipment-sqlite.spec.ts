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
  it('可选完整参数兼容旧数据，真实历史和引用持久化且不改写场景', async () => {
    const first = await start()
    await first.api.post(path).set(headers).send(EQUIPMENT).expect(201)
    const before = (await first.api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data
    const linkId = before.config.links[0].id
    const edited = { ...EQUIPMENT, bandwidthMHz: 0.5, txPowerW: 0, dataRateMbps: 2 }
    await first.api.put(`${path}/TEST-RADIO`).set(headers).send(edited).expect(200)
    const reference = { equipmentId: 'TEST-RADIO', equipmentVersion: 2, scenarioId: 'SCN-001', linkId }
    const bind = (change = {}, remove = false) => first.api.put(`${path}/TEST-RADIO/reference`).set(headers).send({ reference: { ...reference, ...change }, remove })
    await bind({ equipmentVersion: 1 }).expect(409)
    await bind({ linkId: 'MISSING' }).expect(404)
    await bind({ equipmentId: 'OTHER' }).expect(422)
    await first.api.put(`${path}/TEST-RADIO/reference`).set({ ...headers, 'X-Demo-Role': 'OPERATOR' }).send({ reference, remove: false }).expect(403)
    await bind().expect(200)
    const details = (await first.api.get(`${path}/TEST-RADIO/details`).set(headers)).body.data
    expect(details.references).toEqual([reference])
    expect(details.history).toEqual([{ ...edited, version: 2 }, EQUIPMENT])
    expect((await first.api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data).toEqual(before)
    expect(first.storage.delete('TEST-RADIO', 2)).toBe(false)
    await first.close()
    const second = await start(first.file)
    expect(second.storage.details('TEST-RADIO')).toEqual(details)
    await second.api.put(`${path}/TEST-RADIO/reference`).set(headers).send({ reference, remove: true }).expect(200)
    expect(second.storage.details('TEST-RADIO').references).toEqual([])
    expect(second.storage.delete('TEST-RADIO', 2)).toBe(true)
    expect(second.storage.save(EQUIPMENT)).toBe(true)
    expect(second.storage.details('TEST-RADIO').history).toEqual([EQUIPMENT])
  })

  it.each([{ bandwidthMHz: 0 }, { bandwidthMHz: -1 }, { txPowerW: -1 }, { dataRateMbps: 0 }, { dataRateMbps: '2' }])('完整参数拒绝非法数值 %j', async change => {
    const { api, storage } = await start()
    await api.post(path).set(headers).send({ ...EQUIPMENT, ...change }).expect(422)
    expect(storage.load()).toEqual([])
  })

  it('确认删除、重开不再存在；确认不可复用且权限独立保护', async () => {
    const first = await start()
    await first.api.post(path).set(headers).send(EQUIPMENT)
    const url = `${path}/TEST-RADIO?expectedVersion=1`
    expect((await first.api.delete(url).set(headers)).status).toBe(428)
    for (const role of ['OPERATOR', 'INVALID']) {
      expect([401, 403]).toContain((await first.api.delete(url).set({ ...headers, 'X-Demo-Role': role })).status)
    }
    const created = await first.api.post('/api/v1/confirmations').set(headers).send({ action: 'MASTER_DATA_DELETE', objectId: 'EQUIPMENT:TEST-RADIO:1' })
    const id = created.body.data.confirmationId
    await first.api.post(`/api/v1/confirmations/${id}`).set(headers).send({ confirm: true })
    const confirmedHeaders = { ...headers, 'X-Confirmation-Id': id }
    const result = await first.api.delete(url).set(confirmedHeaders)
    expect(result.status).toBe(200)
    expect(result.body.data).toEqual({ objectId: 'TEST-RADIO', deleted: true })
    expect((await first.api.delete(url).set(confirmedHeaders)).status).toBe(409)
    expect(first.server.auditSnapshot().some((row: { action: string }) => row.action === 'MASTER_DATA_EQUIPMENT_DELETE')).toBe(true)
    await first.close()
    expect((await (await start(first.file)).api.get(path).set(headers)).body.data).toEqual([])
  })

  it('删除拒绝错误版本、只读、缺失、错对象确认、非法版本及存储锁，不丢原数据', async () => {
    const { api, storage, file } = await start()
    await api.post(path).set(headers).send(EQUIPMENT)
    const confirm = async (objectId = 'EQUIPMENT:TEST-RADIO:1') => {
      const response = await api.post('/api/v1/confirmations').set(headers).send({ action: 'MASTER_DATA_DELETE', objectId })
      const id = response.body.data.confirmationId
      await api.post(`/api/v1/confirmations/${id}`).set(headers).send({ confirm: true })
      return { ...headers, 'X-Confirmation-Id': id }
    }
    expect((await api.delete(`${path}/TEST-RADIO?expectedVersion=1`).set(await confirm('TEST-RADIO'))).status).toBe(409)
    for (const suffix of ['', '?expectedVersion=0', '?expectedVersion=1.5', '?expectedVersion=1&extra=1']) {
      expect((await api.delete(`${path}/TEST-RADIO${suffix}`).set(headers)).status).toBe(422)
    }
    expect((await api.delete(`${path}/MISSING?expectedVersion=1`).set(await confirm('EQUIPMENT:MISSING:1'))).status).toBe(404)
    const stale = await confirm()
    await api.put(`${path}/TEST-RADIO`).set(headers).send(EQUIPMENT)
    expect((await api.delete(`${path}/TEST-RADIO?expectedVersion=1`).set(stale)).status).toBe(409)
    const db = new DatabaseSync(file)
    cleanups.push(() => db.close())
    const lockedConfirmation = await confirm('EQUIPMENT:TEST-RADIO:2')
    db.exec('BEGIN EXCLUSIVE')
    try { expect((await api.delete(`${path}/TEST-RADIO?expectedVersion=2`).set(lockedConfirmation)).status).toBe(503) }
    finally { db.exec('ROLLBACK') }
    expect(storage.delete('TEST-RADIO', 1)).toBe(false)
    db.prepare('UPDATE equipment_parameters SET parameters_json = ?').run(JSON.stringify({ ...EQUIPMENT, version: 2, readOnly: true }))
    expect(storage.delete('TEST-RADIO', 2)).toBe(false)
    expect((await api.delete(`${path}/TEST-RADIO?expectedVersion=2`).set(await confirm('EQUIPMENT:TEST-RADIO:2'))).status).toBe(403)
    expect(storage.load()).toHaveLength(1)
  })

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

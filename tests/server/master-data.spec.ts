// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'

const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { MasterDataSqliteStorage } = await import('../../server/local/' + 'master-data-sqlite.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')

const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
const path = '/api/v1/admin/master-data'
const cleanups: Array<() => Promise<void> | void> = []
let directory = ''

const master = {
  dataId: 'DICT-TEST', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
  content: {
    name: '测试参数字典', description: '仅用于临时数据库回归。',
    entries: [{ key: 'retryLimit', valueType: 'NUMBER' as const, value: 3, minimum: 0, maximum: 10 }],
  },
}

async function start(file?: string) {
  directory ||= await mkdtemp(join(tmpdir(), 'wrj-master-data-'))
  const storage = new MasterDataSqliteStorage(file ?? join(directory, 'master-data.db'))
  const server = createMockServer({ port: 0, masterDataStorage: storage })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await server.close()
    storage.close()
  }
  cleanups.push(close)
  return { api, storage, file: file ?? join(directory, 'master-data.db'), close }
}

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

describe('主数据独立 SQLite 存储与引用保护', () => {
  it('纯 Mock 登记引用幂等且不抹去其他项的历史保护，停用仍保留关系', async () => {
    const server = createMockServer({ port: 0 })
    cleanups.push(() => server.close())
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    await api.post(path).set(headers).send({ operation: 'CREATE', data: master }).expect(201)
    const targets = (await api.get(`${path}/targets`).set(headers).expect(200)).body.data
    const scene = targets.find((item: { targetType: string }) => item.targetType === 'SCENARIO')
    const template = targets.find((item: { targetType: string }) => item.targetType === 'TEMPLATE')
    for (const target of [scene, scene, template]) {
      await api.put(`${path}/${master.dataId}/reference`).set(headers).send({ dataId: master.dataId, dataVersion: 1,
        targetType: target.targetType, targetId: target.targetId, targetVersion: target.targetVersion }).expect(200)
    }
    const rows = (await api.get(path).set(headers).expect(200)).body.data
    expect(rows.find((row: { dataId: string }) => row.dataId === master.dataId).referenceCount).toBe(2)
    expect(rows.find((row: { dataId: string }) => row.dataId === 'MW-COMM').referenceCount).toBe(2)
    const details = (await api.get(`${path}/${master.dataId}/details`).set(headers).expect(200)).body.data
    expect(details.references).toHaveLength(2)
    expect(details.history[0].referenceCount).toBe(2)
    await api.put(`${path}/${master.dataId}`).set(headers).send({ operation: 'UPDATE', data: { ...master, referenceCount: 2, active: false } }).expect(200)
    await api.put(`${path}/${master.dataId}/reference`).set(headers).send({ dataId: master.dataId, dataVersion: 1,
      targetType: scene.targetType, targetId: scene.targetId, targetVersion: scene.targetVersion }).expect(409)
    const current = (await api.get(`${path}/${master.dataId}/details`).set(headers).expect(200)).body.data
    expect(current.history.map((row: { version: number }) => row.version)).toEqual([2, 1])
    expect(current.references).toEqual(details.references)
  })

  it('空库起步，保存真实内容、版本快照和重启后一致', async () => {
    const first = await start()
    expect((await first.api.get(path).set(headers)).body.data).toEqual([])
    await first.api.post(path).set(headers).send({ operation: 'CREATE', data: master }).expect(201)
    const edited = { ...master, content: { ...master.content, entries: [{ ...master.content.entries[0], value: 5 }] } }
    const updated = await first.api.put(`${path}/${master.dataId}`).set(headers).send({ operation: 'UPDATE', data: edited }).expect(200)
    expect(updated.body.data).toMatchObject({ version: 2, content: { entries: [{ value: 5 }] } })
    expect((await first.api.put(`${path}/${master.dataId}`).set(headers).send({ operation: 'UPDATE', data: master })).status).toBe(409)
    const details = await first.api.get(`${path}/${master.dataId}/details`).set(headers).expect(200)
    expect(details.body.data.history.map((row: { version: number }) => row.version)).toEqual([2, 1])
    const file = first.file
    await first.close()
    const second = await start(file)
    expect((await second.api.get(path).set(headers)).body.data).toEqual([{ ...edited, version: 2 }])
    expect((await second.api.get(`${path}/${master.dataId}/details`).set(headers)).body.data.history).toHaveLength(2)
  })

  it('真实空库可使用与冻结夹具相同的编号，且不读取或覆盖夹具记录', async () => {
    const { api, storage } = await start()
    const local = { ...master, dataId: 'MW-COMM', content: { ...master.content, name: '本机录入通信字典' } }
    await api.post(path).set(headers).send({ operation: 'CREATE', data: local }).expect(201)
    expect(storage.load()).toEqual([local])
  })

  it('拒绝非法内容、越界值和旧无内容写入，且不写入空库', async () => {
    const { api, storage } = await start()
    for (const data of [
      { ...master, content: { ...master.content, entries: [] } },
      { ...master, content: { ...master.content, entries: [{ key: 'retryLimit', valueType: 'NUMBER', value: 11, minimum: 0, maximum: 10 }] } },
      { ...master, kind: 'DEVICE' },
      { dataId: 'OLD', kind: 'DEVICE', version: 1, referenceCount: 0, active: true },
    ]) await api.post(path).set(headers).send({ operation: 'CREATE', data }).expect(422)
    expect(storage.load()).toEqual([])
  })

  it('登记当前目标版本幂等，保留历史引用并保护停用后的删除', async () => {
    const { api } = await start()
    await api.post(path).set(headers).send({ operation: 'CREATE', data: master }).expect(201)
    const targets = (await api.get(`${path}/targets`).set(headers).expect(200)).body.data
    const target = targets.find((row: { targetType: string }) => row.targetType === 'SCENARIO')
    const template = targets.find((row: { targetType: string }) => row.targetType === 'TEMPLATE')
    expect(target).toMatchObject({ targetType: 'SCENARIO', targetId: 'SCN-001' })
    const reference = { dataId: master.dataId, dataVersion: 1, targetType: target.targetType, targetId: target.targetId, targetVersion: target.targetVersion }
    await api.put(`${path}/${master.dataId}/reference`).set(headers).send({ ...reference, targetVersion: '999' }).expect(409)
    await api.put(`${path}/${master.dataId}/reference`).set(headers).send({ ...reference, targetId: 'SCN-MISSING' }).expect(404)
    await api.put(`${path}/${master.dataId}/reference`).set(headers).send(reference).expect(200)
    await api.put(`${path}/${master.dataId}/reference`).set(headers).send(reference).expect(200)
    const templateReference = { ...reference, targetType: template.targetType, targetId: template.targetId, targetVersion: template.targetVersion }
    await api.put(`${path}/${master.dataId}/reference`).set(headers).send({ ...templateReference, targetVersion: '999' }).expect(409)
    await api.put(`${path}/${master.dataId}/reference`).set(headers).send({ ...templateReference, targetId: 'TPL-MISSING' }).expect(404)
    await api.put(`${path}/${master.dataId}/reference`).set(headers).send(templateReference).expect(200)
    const details = (await api.get(`${path}/${master.dataId}/details`).set(headers).expect(200)).body.data
    expect(details.references).toEqual(expect.arrayContaining([reference, templateReference]))
    expect((await api.get(path).set(headers)).body.data[0].referenceCount).toBe(2)
    const inactive = { ...master, active: false, referenceCount: 2 }
    await api.put(`${path}/${master.dataId}`).set(headers).send({ operation: 'UPDATE', data: inactive }).expect(200)
    const confirmation = await api.post('/api/v1/confirmations').set(headers).send({ action: 'MASTER_DATA_DELETE', objectId: master.dataId }).expect(201)
    const confirmationId = confirmation.body.data.confirmationId
    await api.post(`/api/v1/confirmations/${confirmationId}`).set(headers).send({ confirm: true }).expect(200)
    await api.delete(`${path}/${master.dataId}`).set({ ...headers, 'X-Confirmation-Id': confirmationId }).expect(409)
  })

  it('接口仅允许管理员，详情和引用不伪造 fixture 引用记录', async () => {
    const { api } = await start()
    for (const endpoint of [path, `${path}/targets`, `${path}/MW-COMM/details`]) {
      expect((await api.get(endpoint).set({ ...headers, 'X-Demo-Role': 'OPERATOR' })).status).toBe(403)
    }
    await api.post(path).set({ ...headers, 'X-Demo-Role': 'OPERATOR' }).send({ operation: 'CREATE', data: master }).expect(403)
    await api.put(`${path}/MW-COMM/reference`).set({ ...headers, 'X-Demo-Role': 'OPERATOR' }).send({ dataId: 'MW-COMM', dataVersion: 4, targetType: 'SCENARIO', targetId: 'SCN-001', targetVersion: '4' }).expect(403)
    const mock = createMockServer({ port: 0 })
    cleanups.push(() => mock.close())
    if (!mock.httpServer.listening) await once(mock.httpServer, 'listening')
    const pure = request(`http://127.0.0.1:${mock.httpServer.address().port}`)
    const details = await pure.get(`${path}/MW-COMM/details`).set(headers).expect(200)
    expect(details.body.data.references).toEqual([])
    expect((await pure.get(path).set(headers)).body.data.find((row: { dataId: string }) => row.dataId === 'MW-COMM').referenceCount).toBe(2)
  })

  it('删除未引用项仍保留版本历史，且同编号不能重新创建覆盖快照', async () => {
    const { api, storage } = await start()
    await api.post(path).set(headers).send({ operation: 'CREATE', data: master }).expect(201)
    const confirmation = await api.post('/api/v1/confirmations').set(headers).send({ action: 'MASTER_DATA_DELETE', objectId: master.dataId }).expect(201)
    const confirmationId = confirmation.body.data.confirmationId
    await api.post(`/api/v1/confirmations/${confirmationId}`).set(headers).send({ confirm: true }).expect(200)
    await api.delete(`${path}/${master.dataId}`).set({ ...headers, 'X-Confirmation-Id': confirmationId }).expect(200)
    expect(storage.load()).toEqual([])
    expect(storage.details(master.dataId).history).toEqual([master])
    await api.post(path).set(headers).send({ operation: 'CREATE', data: master }).expect(409)
  })

  it('当前或选定历史版本停用、场景锁定时拒绝登记，详情缺失返回 404', async () => {
    const { api } = await start()
    await api.get(`${path}/MISSING/details`).set(headers).expect(404)
    await api.post(path).set(headers).send({ operation: 'CREATE', data: { ...master, dataId: 'DICT-INACTIVE', active: false } }).expect(201)
    await api.put(`${path}/DICT-INACTIVE`).set(headers).send({ operation: 'UPDATE', data: { ...master, dataId: 'DICT-INACTIVE', active: true } }).expect(200)
    const target = (await api.get(`${path}/targets`).set(headers).expect(200)).body.data.find((row: { targetType: string }) => row.targetType === 'SCENARIO')
    await api.put(`${path}/DICT-INACTIVE/reference`).set(headers).send({ dataId: 'DICT-INACTIVE', dataVersion: 1,
      targetType: target.targetType, targetId: target.targetId, targetVersion: target.targetVersion }).expect(409)
    await api.post(path).set(headers).send({ operation: 'CREATE', data: master }).expect(201)
    await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
    await api.put(`${path}/${master.dataId}/reference`).set(headers).send({ dataId: master.dataId, dataVersion: 1,
      targetType: target.targetType, targetId: target.targetId, targetVersion: target.targetVersion }).expect(409)
  })

  it('存储拒绝旧 CAS、无效版本和已删除数据的迟到引用', async () => {
    const { storage, file } = await start()
    expect(storage.save(master)).toBe(true)
    const second = new MasterDataSqliteStorage(file)
    cleanups.push(() => second.close())
    expect(second.save({ ...master, version: 2 }, 1)).toBe(true)
    expect(storage.save({ ...master, version: 2 }, 1)).toBe(false)
    expect(() => storage.save({ ...master, version: 4 }, 2)).toThrow('主数据写入无效')
    expect(second.delete(master.dataId, 2)).toBe(true)
    expect(second.addReference({ dataId: master.dataId, dataVersion: 2, targetType: 'SCENARIO', targetId: 'SCN-001', targetVersion: '4' })).toBe(false)
  })

  it('主数据或目标存储异常均返回 503，不伪造成功响应', async () => {
    const unavailable = {
      load: () => { throw new Error('unavailable') },
      save: () => { throw new Error('unavailable') },
      delete: () => { throw new Error('unavailable') },
      details: () => { throw new Error('unavailable') },
      addReference: () => { throw new Error('unavailable') },
    }
    const server = createMockServer({ port: 0, masterDataStorage: unavailable })
    cleanups.push(() => server.close())
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    await api.get(path).set(headers).expect(503)
    await api.post(path).set(headers).send({ operation: 'CREATE', data: master }).expect(503)
    await api.get(`${path}/${master.dataId}/details`).set(headers).expect(503)
    await api.put(`${path}/${master.dataId}/reference`).set(headers).send({ dataId: master.dataId, dataVersion: 1,
      targetType: 'SCENARIO', targetId: 'SCN-001', targetVersion: '4' }).expect(503)
    let targetUnavailable = false
    const scenarios = { load: () => undefined, list: () => {
      if (targetUnavailable) throw new Error('unavailable')
      return []
    }, save: () => false, delete: () => false }
    const targetServer = createMockServer({ port: 0, scenarioStorage: scenarios })
    cleanups.push(() => targetServer.close())
    if (!targetServer.httpServer.listening) await once(targetServer.httpServer, 'listening')
    targetUnavailable = true
    await request(`http://127.0.0.1:${targetServer.httpServer.address().port}`).get(`${path}/targets`).set(headers).expect(503)
  })
})

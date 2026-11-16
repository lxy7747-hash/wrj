// @vitest-environment node
// B1-3：发布 / 装备删除的确定性交错。屏障位于 express.json 等待请求体（app.ts:966-969），
// 发布路由 capture→提交 与删除事务均为同步段，不插入 await，也不在产品代码加延时。
import { afterEach, describe, expect, it } from 'vitest'
import { EQUIPMENT } from '../fixtures/equipment'

const { mkdtemp, rm } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const httpRequest = (await import('node:' + 'http')).request
const request = (await import('super' + 'test')).default
const { createMockServer } = await import('../../server/' + 'app.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { ScenarioSqliteStorage } = await import('../../server/local/' + 'scenario-sqlite.js')
const { EquipmentSqliteStorage } = await import('../../server/local/' + 'equipment-sqlite.js')
const { TemplateSqliteStorage } = await import('../../server/local/' + 'template-sqlite.js')

const ORIGIN = 'http://127.0.0.1:5173'
const headers = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }
const cleanups: Array<() => void | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

function templatePayload() {
  const draft = new ScenarioProjection().get('SCN-001').data
  Object.assign(draft.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
  const link = draft.config.links.find((item: { id: string }) => item.id === 'L-MW-01')!
  Object.assign(link, { frequency: 150, modulation: 'QPSK', berThreshold: EQUIPMENT.berThreshold,
    parameterSource: { kind: 'EQUIPMENT', sourceId: EQUIPMENT.equipmentId, sourceVersion: 1, fields: ['modulation', 'berThreshold'] } })
  return { name: '交错发布模板', config: draft.config, uiExtensions: draft.uiExtensions }
}

async function boot(makeStorages?: () => { scenarioStorage: unknown; equipmentStorage: unknown; templateStorage: unknown }) {
  const storages = makeStorages?.(); const server = createMockServer(storages ? { port: 0, ...(storages as unknown as Record<string, never>) } : { port: 0 })
  cleanups.push(() => server.close())
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw Error('missing port')
  const origin = `http://127.0.0.1:${address.port}`
  const api = request(origin)
  return { server, api, port: address.port, origin }
}

async function confirmDelete(api: ReturnType<typeof request>, version: number) {
  const created = await api.post('/api/v1/confirmations').set(headers).send({ action: 'MASTER_DATA_DELETE', objectId: `EQUIPMENT:${EQUIPMENT.equipmentId}:${version}` }).expect(201)
  const confirmationId = created.body.data.confirmationId as string
  await api.post(`/api/v1/confirmations/${confirmationId}`).set(headers).send({ confirm: true }).expect(200)
  return { ...headers, 'X-Confirmation-Id': confirmationId }
}

/** 只写一半请求体的原始 HTTP 请求；命中 express.json 等待，返回 finish 以放行。 */
function halfRequest(port: number, options: { method: 'POST' | 'DELETE'; path: string; headers: Record<string, string>; body: string }) {
  const length = new TextEncoder().encode(options.body).length
  const half = Math.floor(length / 2)
  const req = httpRequest({ host: '127.0.0.1', port, method: options.method, path: options.path,
    headers: { ...options.headers, 'Content-Type': 'application/json', 'Content-Length': String(length) } })
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.on('response', (res: { statusCode?: number; on(event: 'data', listener: (chunk: unknown) => void): void; on(event: 'end', listener: () => void): void }) => { let body = ''; res.on('data', (chunk: unknown) => { body += String(chunk) }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body })) })
    req.on('error', (error: unknown) => reject(error))
  })
  req.write(options.body.slice(0, half))
  return { req, response, finish: () => req.end(options.body.slice(half)) }
}

/** 屏障命中：http.Server 'request' 事件已触发（请求头到达、请求体未收完）。 */
function requestArrived(server: { httpServer: { prependOnceListener(event: 'request', listener: () => void): unknown } }) {
  return new Promise<void>(resolve => { server.httpServer.prependOnceListener('request', () => resolve()) })
}

describe('B1-3 发布 / 删除确定性交错', () => {
  it('B1-3a 删除先完成：发布挂起后删除成功，随后发布按历史版本冻结引用成功', async () => {
    const { server, api, port } = await boot()
    await api.post('/api/v1/admin/equipment').set(headers).send(EQUIPMENT).expect(201)
    const payload = templatePayload()
    const arrived = requestArrived(server)
    const half = halfRequest(port, { method: 'POST', path: '/api/v1/templates', headers, body: JSON.stringify(payload) })
    await arrived
    // 屏障命中时：真实存储没有本次模板/引用，设备仍在
    const before = (await api.get(`/api/v1/admin/equipment/${EQUIPMENT.equipmentId}/history`).set(headers).expect(200)).body.data
    expect(before.deleted).toBe(false)
    expect(before.publishedReferences).toEqual([])
    // 删除先完成
    const confirmHeaders = await confirmDelete(api, 1)
    await api.delete(`/api/v1/admin/equipment/${EQUIPMENT.equipmentId}`).query({ expectedVersion: 1 }).set(confirmHeaders).expect(200)
    // 放行发布：按历史版本 1 合法冻结
    half.finish()
    const response = await half.response
    expect(response.status).toBe(201)
    const list = (await api.get('/api/v1/templates').set(headers).expect(200)).body.data
    const created = list.find((row: { name: string }) => row.name === '交错发布模板')
    expect(created).toBeTruthy()
    const templateId = created.templateId as string
    const after = (await api.get(`/api/v1/admin/equipment/${EQUIPMENT.equipmentId}/history`).set(headers).expect(200)).body.data
    expect(after.deleted).toBe(true)
    const refs = after.publishedReferences.filter((row: { targetType: string }) => row.targetType === 'TEMPLATE')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ equipmentVersion: 1, targetId: templateId })
  })

  it('B1-3b 发布先完成：删除挂起后发布登记引用，随后删除返回 409 且设备/历史仍在', async () => {
    const { server, api, port } = await boot()
    await api.post('/api/v1/admin/equipment').set(headers).send(EQUIPMENT).expect(201)
    const confirmHeaders = await confirmDelete(api, 1)
    const arrived = requestArrived(server)
    const half = halfRequest(port, { method: 'DELETE', path: `/api/v1/admin/equipment/${EQUIPMENT.equipmentId}?expectedVersion=1`, headers: confirmHeaders, body: '{}' })
    await arrived
    // 屏障命中时删除尚未执行：设备仍在、无引用
    const before = (await api.get(`/api/v1/admin/equipment/${EQUIPMENT.equipmentId}/history`).set(headers).expect(200)).body.data
    expect(before.deleted).toBe(false)
    expect(before.publishedReferences).toEqual([])
    // 发布先完成
    const payload = templatePayload()
    const created = await api.post('/api/v1/templates').set(headers).send(payload).expect(201)
    const templateId = created.body.data.templateId as string
    // 放行删除：应被发布引用拒绝
    half.finish()
    const response = await half.response
    expect(response.status).toBe(409)
    expect(response.body).toContain(templateId)
    const after = (await api.get(`/api/v1/admin/equipment/${EQUIPMENT.equipmentId}/history`).set(headers).expect(200)).body.data
    expect(after.deleted).toBe(false)
    expect(after.publishedReferences.filter((row: { targetType: string }) => row.targetType === 'TEMPLATE')).toHaveLength(1)
  })
})

describe('B1-3c 跨连接 SQLite：删除事务看得到另一连接已提交的引用', () => {
  async function bootPair() {
    const root = await mkdtemp(join(tmpdir(), 'wrj-interleave-sqlite-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
    const equipmentPath = join(root, 'equipment.db'), scenarioPath = join(root, 'scenarios.db'), templatePath = join(root, 'templates.db')
    const scenarioA = new ScenarioSqliteStorage(scenarioPath, { equipmentPath, masterDataPath: join(root, 'master.db') })
    const equipmentA = new EquipmentSqliteStorage(equipmentPath)
    const templateA = new TemplateSqliteStorage(templatePath)
    const scenarioB = new ScenarioSqliteStorage(scenarioPath, { equipmentPath, masterDataPath: join(root, 'master.db') })
    const equipmentB = new EquipmentSqliteStorage(equipmentPath)
    const templateB = new TemplateSqliteStorage(templatePath)
    cleanups.push(() => { templateB.close(); equipmentB.close(); scenarioB.close(); templateA.close(); equipmentA.close(); scenarioA.close() })
    const a = await boot(() => ({ scenarioStorage: scenarioA, equipmentStorage: equipmentA, templateStorage: templateA }))
    const b = await boot(() => ({ scenarioStorage: scenarioB, equipmentStorage: equipmentB, templateStorage: templateB }))
    return { a, b }
  }

  it('B1-3c-1 删除先完成（跨连接）：另一连接发布按历史版本冻结成功', async () => {
    const { a, b } = await bootPair()
    await a.api.post('/api/v1/admin/equipment').set(headers).send(EQUIPMENT).expect(201)
    const payload = templatePayload()
    const arrived = requestArrived(a.server)
    const half = halfRequest(a.port, { method: 'POST', path: '/api/v1/templates', headers, body: JSON.stringify(payload) })
    await arrived
    const before = (await a.api.get(`/api/v1/admin/equipment/${EQUIPMENT.equipmentId}/history`).set(headers).expect(200)).body.data
    expect(before.publishedReferences).toEqual([])
    const confirmHeaders = await confirmDelete(b.api, 1)
    await b.api.delete(`/api/v1/admin/equipment/${EQUIPMENT.equipmentId}`).query({ expectedVersion: 1 }).set(confirmHeaders).expect(200)
    half.finish()
    expect((await half.response).status).toBe(201)
    const after = (await a.api.get(`/api/v1/admin/equipment/${EQUIPMENT.equipmentId}/history`).set(headers).expect(200)).body.data
    expect(after.deleted).toBe(true)
    expect(after.publishedReferences.filter((row: { targetType: string }) => row.targetType === 'TEMPLATE')).toHaveLength(1)
  })

  it('B1-3c-2 发布先完成（跨连接）：另一连接删除看到引用并 409', async () => {
    const { a, b } = await bootPair()
    await a.api.post('/api/v1/admin/equipment').set(headers).send(EQUIPMENT).expect(201)
    const confirmHeaders = await confirmDelete(b.api, 1)
    const arrived = requestArrived(b.server)
    const half = halfRequest(b.port, { method: 'DELETE', path: `/api/v1/admin/equipment/${EQUIPMENT.equipmentId}?expectedVersion=1`, headers: confirmHeaders, body: '{}' })
    await arrived
    const before = (await b.api.get(`/api/v1/admin/equipment/${EQUIPMENT.equipmentId}/history`).set(headers).expect(200)).body.data
    expect(before.publishedReferences).toEqual([])
    const created = await a.api.post('/api/v1/templates').set(headers).send(templatePayload()).expect(201)
    const templateId = created.body.data.templateId as string
    half.finish()
    const response = await half.response
    expect(response.status).toBe(409)
    expect(response.body).toContain(templateId)
    const after = (await b.api.get(`/api/v1/admin/equipment/${EQUIPMENT.equipmentId}/history`).set(headers).expect(200)).body.data
    expect(after.deleted).toBe(false)
    expect(after.publishedReferences.filter((row: { targetType: string }) => row.targetType === 'TEMPLATE')).toHaveLength(1)
  })
})




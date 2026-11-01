// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const { once } = await import('node:' + 'events')
const servers: Array<ReturnType<typeof createMockServer>> = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }

it('操作类型在查询和确认导出中使用相同精确条件，拒绝越权和多值条件', async () => {
  const server = createMockServer({ port: 0 }); servers.push(server)
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(server.httpServer)
  await api.get('/api/v1/admin/health').set(headers).expect(200)
  await api.get('/api/v1/admin/equipment').set(headers).expect(200)
  const filtered = (await api.get('/api/v1/admin/audit').set(headers).query({ action: 'HEALTH_READ' }).expect(200)).body.data
  expect(filtered.length).toBeGreaterThan(0)
  expect(filtered.every((record: { action: string }) => record.action === 'HEALTH_READ')).toBe(true)
  const confirmation = (await api.post('/api/v1/confirmations').set(headers).send({ action: 'AUDIT_EXPORT', objectId: 'AUDIT-LOG' }).expect(201)).body.data
  await api.post(`/api/v1/confirmations/${confirmation.confirmationId}`).set(headers).send({ confirm: true }).expect(200)
  const exported = (await api.post('/api/v1/admin/audit/export').set(headers).send({ export: true, action: 'HEALTH_READ', confirmationId: confirmation.confirmationId }).expect(200)).body.data
  expect(exported.content).toContain('HEALTH_READ')
  expect(exported.content).not.toContain('MASTER_DATA_EQUIPMENT_LIST')
  expect(exported.recordCount).toBe(filtered.length)
  await api.get('/api/v1/admin/audit?action=HEALTH_READ&action=MASTER_DATA_EQUIPMENT_LIST').set(headers).expect(400)
  await api.get('/api/v1/admin/audit').set({ ...headers, 'X-Demo-Role': 'OPERATOR' }).query({ action: 'HEALTH_READ' }).expect(403)
})

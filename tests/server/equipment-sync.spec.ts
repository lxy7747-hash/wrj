// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import type { ScenarioDraft } from '../../src/contracts/domain-models'
import { EQUIPMENT } from '../fixtures/equipment'
const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { DatabaseSync } = await import('node:' + 'sqlite')
const { EquipmentSqliteStorage } = await import('../../server/local/' + 'equipment-sqlite.js')
const { ScenarioSqliteStorage } = await import('../../server/local/' + 'scenario-sqlite.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const cleanups: Array<() => unknown> = []
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
const equipmentUrl = '/api/v1/admin/equipment/TEST-RADIO'
const record = { ...EQUIPMENT, frequencyMinMHz: 1, frequencyMaxMHz: 100000 }
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(persistent = true) {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-equipment-sync-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const scenePath = join(directory, 'scenarios.db')
  const equipmentPath = join(directory, 'equipment.db')
  const sceneStorage = persistent ? new ScenarioSqliteStorage(scenePath) : undefined
  const equipmentStorage = persistent ? new EquipmentSqliteStorage(equipmentPath, scenePath) : undefined
  cleanups.push(() => { equipmentStorage?.close(); sceneStorage?.close() })
  const server = createMockServer({ port: 0, scenarioStorage: sceneStorage, equipmentStorage })
  cleanups.push(() => server.close())
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  const source: ScenarioDraft = new ScenarioProjection().get('SCN-001').data
  for (const id of persistent ? ['SCN-001', 'SCN-SECOND'] as const : ['SCN-SECOND'] as const) {
    const draft = structuredClone(source)
    draft.config.scenario.id = id
    await api.post('/api/v1/scenarios').set(headers).send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: 0 }).expect(201)
  }
  await api.post('/api/v1/admin/equipment').set(headers).send(record).expect(201)
  for (const id of ['SCN-001', 'SCN-SECOND']) await api.put(`${equipmentUrl}/reference`).set(headers).send({
    reference: { equipmentId: record.equipmentId, equipmentVersion: 1, scenarioId: id, linkId: 'L-MW-01' }, remove: false,
  }).expect(200)
  const scene = async (id = 'SCN-001'): Promise<ScenarioDraft> => (await api.get(`/api/v1/scenarios/${id}`).set(headers).expect(200)).body.data
  const details = async () => (await api.get(`${equipmentUrl}/details`).set(headers).expect(200)).body.data
  return { api, scene, details, scenePath, equipmentPath, equipmentStorage, sceneStorage }
}

it.each([true, false])('公开 PUT 原子同步多个场景、参数、修订和引用版本，持久化=%s', async persistent => {
  const f = await setup(persistent)
  const before = await f.scene()
  const second = await f.scene('SCN-SECOND')
  const changed = { ...record, bandwidthMHz: 0.5, txPowerW: 0, dataRateMbps: 2, berThreshold: 0.002, modulation: 'BPSK' }
  await f.api.put(equipmentUrl).set(headers).send(changed).expect(200)
  const after = await f.scene()
  expect(after.revision).toBe(before.revision + 1)
  const link = after.config.links.find(item => item.id === 'L-MW-01')!
  expect(link).toMatchObject({ frequency: before.config.links.find(item => item.id === 'L-MW-01')!.frequency,
    bandwidth: 0.5, txPower: 0, dataRate: 2, berThreshold: 0.002, modulation: 'BPSK' })
  expect(after.config.links.filter(item => item.id !== 'L-MW-01')).toEqual(before.config.links.filter(item => item.id !== 'L-MW-01'))
  expect(after.uiExtensions).toEqual(before.uiExtensions)
  expect((await f.scene('SCN-SECOND')).revision).toBe(second.revision + 1)
  expect((await f.details()).references.every((item: { equipmentVersion: number }) => item.equipmentVersion === 2)).toBe(true)
  expect((await f.details()).history).toHaveLength(2)
  // 旧编辑器不能用旧修订号覆盖同步结果。
  await f.api.put('/api/v1/scenarios/SCN-001').set(headers).send({ config: before.config, uiExtensions: before.uiExtensions, expectedRevision: before.revision }).expect(409)
  await f.api.put(equipmentUrl).set(headers).send(changed).expect(409)
  if (persistent) {
    const reopened = new ScenarioSqliteStorage(f.scenePath)
    try { expect(reopened.load('SCN-001')).toEqual(after) } finally { reopened.close() }
  }
})

it('空参数不覆盖，频率恰在新范围边界仍保持原值', async () => {
  const f = await setup()
  const before = await f.scene()
  const frequency = before.config.links.find(item => item.id === 'L-MW-01')!.frequency
  await f.api.put(equipmentUrl).set(headers).send({ ...record, frequencyMinMHz: frequency, frequencyMaxMHz: frequency,
    modulation: null, berThreshold: null, bandwidthMHz: null, txPowerW: null, dataRateMbps: null }).expect(200)
  expect((await f.scene()).config).toEqual(before.config)
  expect((await f.scene()).revision).toBe(before.revision + 1)
})

it.each(['frequency', 'modulation', 'missing-link', 'missing-scene', 'locked', 'write-failure'])('拒绝 %s，装备历史、全部场景及引用均不部分更新', async reason => {
  const f = await setup()
  if (reason === 'missing-link') {
    const db = new DatabaseSync(f.equipmentPath)
    try { db.exec("UPDATE equipment_references SET link_id='MISSING' WHERE scenario_id='SCN-SECOND'") } finally { db.close() }
  }
  if (reason === 'missing-scene') {
    const db = new DatabaseSync(f.equipmentPath)
    try { db.exec("UPDATE equipment_references SET scenario_id='SCN-MISSING' WHERE scenario_id='SCN-SECOND'") } finally { db.close() }
  }
  if (reason === 'write-failure') {
    const db = new DatabaseSync(f.scenePath)
    try { db.exec("CREATE TRIGGER reject_second BEFORE UPDATE ON scenarios WHEN OLD.id='SCN-SECOND' BEGIN SELECT RAISE(ABORT, 'injected failure'); END") } finally { db.close() }
  }
  if (reason === 'locked') {
    const run = await f.api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
    await f.api.post(`/api/v1/simulations/${run.body.data.runId}/commands`).set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
  }
  const before = await f.scene()
  const second = await f.scene('SCN-SECOND')
  const history = await f.details()
  const update = { ...record, txPowerW: 0, ...(reason === 'frequency' ? { frequencyMinMHz: 1, frequencyMaxMHz: 2 } : {}), ...(reason === 'modulation' ? { modulation: 'UNSUPPORTED' } : {}) }
  const result = await f.api.put(equipmentUrl).set(headers).send(update)
  expect(result.status).toBe(reason === 'write-failure' ? 503 : reason === 'missing-scene' ? 404 : ['locked', 'missing-link'].includes(reason) ? 409 : 422)
  if (reason !== 'write-failure') expect(result.body.error.fieldPath).toContain('SCN-')
  expect(await f.scene()).toEqual(before)
  expect(await f.scene('SCN-SECOND')).toEqual(second)
  expect(await f.details()).toEqual(history)
  expect(f.equipmentStorage.load()).toEqual([record])
})

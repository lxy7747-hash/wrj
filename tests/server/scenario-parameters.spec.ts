// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { DatabaseSync } = await import('node:' + 'sqlite')
const { default: request } = await import('super' + 'test')
const { createMockServer } = await import('../../server/' + 'app.js')
const { EquipmentSqliteStorage } = await import('../../server/local/' + 'equipment-sqlite.js')
const { MasterDataSqliteStorage } = await import('../../server/local/' + 'master-data-sqlite.js')
const { ScenarioSqliteStorage } = await import('../../server/local/' + 'scenario-sqlite.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { prepareLinkEquipment } = await import('../../src/features/scenarios/' + 'link-equipment-parameters.js')
const { prepareLinkMasterData } = await import('../../src/features/scenarios/' + 'link-master-parameters.js')

const admin = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
const operator = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
const cleanups: Array<() => unknown> = []

const equipment = { equipmentId: 'SRC-EQ', type: '微波通信设备', frequencyMinMHz: null, frequencyMaxMHz: null,
  bandwidthMHz: 5, txPowerW: 20, dataRateMbps: null, modulation: 'QPSK', berThreshold: 0.001, active: true, readOnly: false, version: 1 }
const master = { dataId: 'SRC-MD', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
  content: { name: '来源字典', description: '', entries: [{ key: 'noiseFigureDb', valueType: 'NUMBER', value: 6, unit: 'dB' }] } }

afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-scenario-parameters-'))
  const scenePath = join(directory, 'scenarios.db'), equipmentPath = join(directory, 'equipment.db'), masterPath = join(directory, 'master.db')
  // The scenario connection owns the cross-db transaction, so it must exist before EquipmentSqliteStorage attaches scenes.
  const scenes = new ScenarioSqliteStorage(scenePath, { equipmentPath, masterDataPath: masterPath })
  const equipments = new EquipmentSqliteStorage(equipmentPath, scenePath)
  const masters = new MasterDataSqliteStorage(masterPath)
  const server = createMockServer({ scenarioStorage: scenes, equipmentStorage: equipments, masterDataStorage: masters })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  cleanups.push(async () => { await server.close(); scenes.close(); equipments.close(); masters.close(); await rm(directory, { recursive: true, force: true }) })
  return { api, scenes, equipments, masters, scenePath, masterPath, equipmentPath }
}

function draft(): any { const value = new ScenarioProjection().get('SCN-001'); if (!value.ok) throw new Error('missing fixture'); Object.assign(value.data.config.jammers[0], { defaultPower: 1, bandwidth: 200 }); return value.data }
function update(value: any, expectedRevision = 0) { return { config: value.config, uiExtensions: value.uiExtensions, expectedRevision } }

async function confirmedDelete(api: ReturnType<typeof request>, path: string, objectId: string) {
  const created = await api.post('/api/v1/confirmations').set(admin).send({ action: 'MASTER_DATA_DELETE', objectId }).expect(201)
  const confirmationId = created.body.data.confirmationId
  await api.post(`/api/v1/confirmations/${confirmationId}`).set(admin).send({ confirm: true }).expect(200)
  return api.delete(`/api/v1/admin/${path}`).set({ ...admin, 'X-Confirmation-Id': confirmationId })
}

describe('场景参数来源', () => {
  it('OPERATOR 可读取目录但不能维护来源；装备和通用数据保存均登记删除保护', async () => {
    const f = await setup()
    await f.api.post('/api/v1/admin/equipment').set(admin).send(equipment).expect(201)
    await f.api.post('/api/v1/admin/master-data').set(admin).send({ operation: 'CREATE', data: master }).expect(201)
    const catalog = await f.api.get('/api/v1/scenarios/parameter-catalog').set(operator).expect(200)
    expect(catalog.body.data).toMatchObject({ equipment: [expect.objectContaining({ equipmentId: equipment.equipmentId })], masterData: [expect.objectContaining({ dataId: master.dataId })] })
    await f.api.get('/api/v1/admin/equipment').set(operator).expect(403)

    const value = draft()
    const first = prepareLinkEquipment(value.config.links[0]!, equipment, value.config.platforms)
    expect(first.ok).toBe(true)
    Object.assign(value.config.links[0]!, first.ok && first.link, { parameterSource: { kind: 'EQUIPMENT', sourceId: equipment.equipmentId, sourceVersion: 1, fields: first.ok ? first.fields : [] } })
    const second = prepareLinkMasterData(value.config.links[1]!, master, value.config.platforms)
    expect(second.ok).toBe(true)
    Object.assign(value.config.links[1]!, second.ok && second.link, { parameterSource: { kind: 'MASTER_DATA', sourceId: master.dataId, sourceVersion: 1, fields: second.ok ? second.fields : [] } })
    const saved = (await f.api.post('/api/v1/scenarios').set(admin).send(update(value)).expect(201)).body.data
    expect(f.equipments.details(equipment.equipmentId).references).toHaveLength(1)
    expect(f.masters.details(master.dataId).references).toHaveLength(1)
    await f.api.put(`/api/v1/admin/equipment/${equipment.equipmentId}/reference`).set(admin).send({ remove: true,
      reference: { equipmentId: equipment.equipmentId, equipmentVersion: 1, scenarioId: 'SCN-001', linkId: value.config.links[0].id } }).expect(409)
    expect(f.equipments.details(equipment.equipmentId).references).toHaveLength(1)
    expect((await confirmedDelete(f.api, `equipment/${equipment.equipmentId}?expectedVersion=1`, `EQUIPMENT:${equipment.equipmentId}:1`)).status).toBe(409)
    expect((await confirmedDelete(f.api, `master-data/${master.dataId}`, master.dataId)).status).toBe(409)
    expect(f.scenes.load('SCN-001')).toEqual(saved)
    expect(f.equipments.load()).toHaveLength(1)
    expect(f.masters.load()).toHaveLength(1)

    const forged = structuredClone(saved)
    forged.config.links[0].parameterSource.fields = ['txPower']
    await f.api.put('/api/v1/scenarios/SCN-001').set(admin).send(update(forged, saved.revision)).expect(422)
    expect(f.scenes.load('SCN-001')).toEqual(saved)
    forged.config.links[0].parameterSource.fields = saved.config.links[0].parameterSource.fields
    forged.config.links[0].bandwidth = 77
    await f.api.put('/api/v1/scenarios/SCN-001').set(admin).send(update(forged, saved.revision)).expect(422)
    expect(f.scenes.load('SCN-001')).toEqual(saved)

    const changed = { ...equipment, txPowerW: 25 }
    await f.api.put(`/api/v1/admin/equipment/${equipment.equipmentId}`).set(admin).send(changed).expect(200)
    expect(f.scenes.load('SCN-001')!.config.links[0]!.parameterSource).toMatchObject({ sourceVersion: 2, fields: ['bandwidth', 'txPower', 'modulation', 'berThreshold'] })
    const before = f.scenes.load('SCN-001')!
    await f.api.put(`/api/v1/admin/equipment/${equipment.equipmentId}`).set(admin).send({ ...changed, version: 2, dataRateMbps: 2 }).expect(422)
    expect(f.scenes.load('SCN-001')).toEqual(before)
    expect(f.equipments.load()[0]).toMatchObject({ version: 2, dataRateMbps: null })
  })

  it('未知设备不能作为新来源，旧版本来源被拒绝且写入触发器失败不会留下装备引用', async () => {
    const f = await setup()
    await f.api.post('/api/v1/admin/equipment').set(admin).send(equipment).expect(201)
    const legacy = { ...equipment, equipmentId: 'LEGACY-EQ', type: '历史通信设备' }
    await f.api.post('/api/v1/admin/equipment').set(admin).send(legacy).expect(201)
    const unknown = draft()
    unknown.config.links[0]!.parameterSource = { kind: 'EQUIPMENT', sourceId: legacy.equipmentId, sourceVersion: 1, fields: [] }
    const rejected = await f.api.post('/api/v1/scenarios').set(admin).send(update(unknown))
    expect(rejected.status).toBe(422)
    expect(rejected.body.error.fieldPath).toBe('links[0].parameterSource')
    expect(f.scenes.load('SCN-001')).toBeUndefined()

    const value = draft()
    const prepared = prepareLinkEquipment(value.config.links[0]!, equipment, value.config.platforms)
    expect(prepared.ok).toBe(true)
    Object.assign(value.config.links[0]!, prepared.ok && prepared.link, { parameterSource: { kind: 'EQUIPMENT', sourceId: 'MISSING', sourceVersion: 1, fields: prepared.ok ? prepared.fields : [] } })
    await f.api.post('/api/v1/scenarios').set(admin).send(update(value)).expect(409)
    expect(f.scenes.load('SCN-001')).toBeUndefined()

    value.config.links[0]!.parameterSource.sourceId = equipment.equipmentId
    value.config.links[0]!.parameterSource.sourceVersion = 2
    await f.api.post('/api/v1/scenarios').set(admin).send(update(value)).expect(409)
    const db = new DatabaseSync(f.scenePath)
    try { db.exec("CREATE TRIGGER reject_scene BEFORE INSERT ON scenarios BEGIN SELECT RAISE(ABORT, 'reject'); END") } finally { db.close() }
    value.config.links[0]!.parameterSource.sourceVersion = 1
    await f.api.post('/api/v1/scenarios').set(admin).send(update(value)).expect(503)
    expect(f.equipments.details(equipment.equipmentId).references).toEqual([])
  })

  it('历史未知设备只允许保留在原链路来源，不能用于新引用', () => {
    const value = draft()
    const legacy = { ...equipment, type: '历史通信设备' }
    expect(prepareLinkEquipment(value.config.links[0]!, legacy, value.config.platforms).ok).toBe(false)
    expect(prepareLinkEquipment(value.config.links[0]!, legacy, value.config.platforms, true)).toMatchObject({ ok: true })
  })

  it.each(['EQUIPMENT', 'MASTER_DATA'] as const)('旧记录缺少 %s 登记时，按已保存的链路来源阻止删除', async kind => {
    const f = await setup()
    await f.api.post('/api/v1/admin/equipment').set(admin).send(equipment).expect(201)
    await f.api.post('/api/v1/admin/master-data').set(admin).send({ operation: 'CREATE', data: master }).expect(201)
    const value = draft()
    const prepared = kind === 'EQUIPMENT'
      ? prepareLinkEquipment(value.config.links[0], equipment, value.config.platforms)
      : prepareLinkMasterData(value.config.links[0], master, value.config.platforms)
    expect(prepared.ok).toBe(true)
    const sourceId = kind === 'EQUIPMENT' ? equipment.equipmentId : master.dataId
    Object.assign(value.config.links[0], prepared.link, { parameterSource: { kind, sourceId, sourceVersion: 1, fields: prepared.fields } })
    const saved = (await f.api.post('/api/v1/scenarios').set(admin).send(update(value)).expect(201)).body.data
    // 仅在临时库模拟旧服务保存了来源、未登记删除保护的记录。
    const db = new DatabaseSync(kind === 'EQUIPMENT' ? f.equipmentPath : f.masterPath)
    try { db.exec(kind === 'EQUIPMENT' ? 'DELETE FROM equipment_references' : 'DELETE FROM master_data_references') } finally { db.close() }
    const path = kind === 'EQUIPMENT' ? `equipment/${sourceId}?expectedVersion=1` : `master-data/${sourceId}`
    const objectId = kind === 'EQUIPMENT' ? `EQUIPMENT:${sourceId}:1` : sourceId
    const result = await confirmedDelete(f.api, path, objectId)
    expect(result.status).toBe(409)
    expect(result.body.error.message).toContain('引用')
    expect(f.scenes.load('SCN-001')).toEqual(saved)
    expect(f.equipments.load()).toHaveLength(1)
    expect(f.masters.load()).toHaveLength(1)
  })

  it('停用来源不能新引用，既有来源仍可按历史版本保存；解除来源保留参数和通用数据历史', async () => {
    const f = await setup()
    await f.api.post('/api/v1/admin/equipment').set(admin).send(equipment).expect(201)
    await f.api.post('/api/v1/admin/master-data').set(admin).send({ operation: 'CREATE', data: master }).expect(201)
    const value = draft()
    const prepared = prepareLinkEquipment(value.config.links[0], equipment, value.config.platforms)
    Object.assign(value.config.links[0], prepared.link, { parameterSource: { kind: 'EQUIPMENT', sourceId: equipment.equipmentId, sourceVersion: 1, fields: prepared.fields } })
    value.config.links[1].noiseFigureDb = 6
    value.config.links[1].parameterSource = { kind: 'MASTER_DATA', sourceId: master.dataId, sourceVersion: 1, fields: ['noiseFigureDb'] }
    const saved = (await f.api.post('/api/v1/scenarios').set(admin).send(update(value)).expect(201)).body.data
    await f.api.put(`/api/v1/admin/equipment/${equipment.equipmentId}`).set(admin).send({ ...equipment, active: false }).expect(200)
    await f.api.put(`/api/v1/admin/master-data/${master.dataId}`).set(admin).send({ operation: 'UPDATE', data: { ...f.masters.load()[0], active: false } }).expect(200)
    const unchanged = (await f.api.put('/api/v1/scenarios/SCN-001').set(admin).send(update(saved, saved.revision)).expect(200)).body.data
    expect(unchanged.config.links[0].parameterSource.sourceVersion).toBe(1)
    const clone = structuredClone(unchanged)
    clone.config.scenario.id = 'SCN-DISABLED'
    clone.config.links[0].parameterSource.sourceVersion = 2
    await f.api.post('/api/v1/scenarios').set(admin).send(update(clone)).expect(409)
    delete unchanged.config.links[0].parameterSource
    delete unchanged.config.links[1].parameterSource
    const cleared = (await f.api.put('/api/v1/scenarios/SCN-001').set(admin).send(update(unchanged, unchanged.revision)).expect(200)).body.data
    expect(cleared.config.links[0]).toMatchObject({ bandwidth: 5, txPower: 20 })
    expect(f.equipments.details(equipment.equipmentId).references).toEqual([])
    expect(f.masters.details(master.dataId).references).toHaveLength(1)
  })

  it('第二个来源登记失败时回滚整个场景和首个装备引用', async () => {
    const f = await setup()
    await f.api.post('/api/v1/admin/equipment').set(admin).send(equipment).expect(201)
    await f.api.post('/api/v1/admin/master-data').set(admin).send({ operation: 'CREATE', data: master }).expect(201)
    const value = draft()
    const prepared = prepareLinkEquipment(value.config.links[0], equipment, value.config.platforms)
    Object.assign(value.config.links[0], prepared.link, { parameterSource: { kind: 'EQUIPMENT', sourceId: equipment.equipmentId, sourceVersion: 1, fields: prepared.fields } })
    value.config.links[1].noiseFigureDb = 6
    value.config.links[1].parameterSource = { kind: 'MASTER_DATA', sourceId: master.dataId, sourceVersion: 1, fields: ['noiseFigureDb'] }
    const db = new DatabaseSync(f.masterPath)
    try { db.exec("CREATE TRIGGER reject_reference BEFORE INSERT ON master_data_references BEGIN SELECT RAISE(ABORT, 'reject reference'); END") } finally { db.close() }
    await f.api.post('/api/v1/scenarios').set(admin).send(update(value)).expect(503)
    expect(f.scenes.load('SCN-001')).toBeUndefined()
    expect(f.equipments.details(equipment.equipmentId).references).toEqual([])
    expect(f.masters.details(master.dataId).references).toEqual([])
  })

  it('纯内存入口复核来源和值并登记引用；不能原子登记的混合入口明确拒绝', async () => {
    const server = createMockServer({ port: 0 })
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    cleanups.push(() => server.close())
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    await api.post('/api/v1/admin/equipment').set(admin).send(equipment).expect(201)
    await api.post('/api/v1/admin/master-data').set(admin).send({ operation: 'CREATE', data: master }).expect(201)
    const value = (await api.get('/api/v1/scenarios/SCN-001').set(operator).expect(200)).body.data
    Object.assign(value.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
    const prepared = prepareLinkEquipment(value.config.links[0], equipment, value.config.platforms)
    Object.assign(value.config.links[0], prepared.link, { parameterSource: { kind: 'EQUIPMENT', sourceId: equipment.equipmentId, sourceVersion: 1, fields: prepared.fields } })
    value.config.links[1].noiseFigureDb = 6
    value.config.links[1].parameterSource = { kind: 'MASTER_DATA', sourceId: master.dataId, sourceVersion: 1, fields: ['noiseFigureDb'] }
    const invalid = structuredClone(value)
    invalid.config.links[0].bandwidth = 77
    await api.put('/api/v1/scenarios/SCN-001').set(operator).send(update(invalid, value.revision)).expect(422)
    expect((await api.get('/api/v1/scenarios/SCN-001').set(operator)).body.data.config.links[0].parameterSource).toBeUndefined()
    const saved = (await api.put('/api/v1/scenarios/SCN-001').set(operator).send(update(value, value.revision)).expect(200)).body.data
    expect((await api.get(`/api/v1/admin/equipment/${equipment.equipmentId}/details`).set(admin)).body.data.references).toHaveLength(1)
    expect((await api.get(`/api/v1/admin/master-data/${master.dataId}/details`).set(admin)).body.data.references).toHaveLength(1)
    await api.put(`/api/v1/admin/equipment/${equipment.equipmentId}/reference`).set(admin).send({ remove: true,
      reference: { equipmentId: equipment.equipmentId, equipmentVersion: 1, scenarioId: 'SCN-001', linkId: value.config.links[0].id } }).expect(409)
    expect((await confirmedDelete(api, `equipment/${equipment.equipmentId}?expectedVersion=1`, `EQUIPMENT:${equipment.equipmentId}:1`)).status).toBe(409)
    expect((await confirmedDelete(api, `master-data/${master.dataId}`, master.dataId)).status).toBe(409)
    expect((await api.put('/api/v1/scenarios/SCN-001').set(operator).send(update(saved, saved.revision)).expect(200)).body.data.config.links[0].parameterSource.sourceId).toBe(equipment.equipmentId)
    const projection = new ScenarioProjection()
    expect(projection.save('SCN-001', update(value, value.revision))).toMatchObject({ ok: false, status: 503 })
    const f = await setup()
    const isolated = new ScenarioSqliteStorage(f.scenePath)
    cleanups.push(() => isolated.close())
    expect(() => isolated.save({ ...value, revision: 1 }, undefined)).toThrow('参数来源')
    expect(f.scenes.load('SCN-001')).toBeUndefined()
  })

  it('WAL 存量库可继续打开和保存普通场景，仅拒绝不能保证原子的跨库引用写入', async () => {
    const f = await setup()
    await f.api.post('/api/v1/admin/equipment').set(admin).send(equipment).expect(201)
    const db = new DatabaseSync(f.scenePath)
    try { db.exec('PRAGMA journal_mode=WAL') } finally { db.close() }
    const reopened = new ScenarioSqliteStorage(f.scenePath, { equipmentPath: f.equipmentPath, masterDataPath: f.masterPath })
    cleanups.push(() => reopened.close())
    const saved = (await f.api.post('/api/v1/scenarios').set(admin).send(update(draft())).expect(201)).body.data
    const value = structuredClone(saved)
    const prepared = prepareLinkEquipment(value.config.links[0], equipment, value.config.platforms)
    Object.assign(value.config.links[0], prepared.link, { parameterSource: { kind: 'EQUIPMENT', sourceId: equipment.equipmentId, sourceVersion: 1, fields: prepared.fields } })
    await f.api.put('/api/v1/scenarios/SCN-001').set(admin).send(update(value, saved.revision)).expect(503)
    expect(f.scenes.load('SCN-001')).toEqual(saved)
    expect(f.equipments.details(equipment.equipmentId).references).toEqual([])
  })

  it('旧通用数据设备字段与既有场景来源可继续保存，新场景不能套用', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wrj-legacy-master-source-'))
    const scenePath = join(directory, 'scenarios.db'), equipmentPath = join(directory, 'equipment.db'), masterPath = join(directory, 'master.db')
    const legacyMaster = { ...master, dataId: 'LEGACY-BAND', content: { ...master.content,
      entries: [{ key: 'bandwidthMHz', valueType: 'NUMBER' as const, value: 6, unit: 'MHz' }] } }
    const legacyScenes = new ScenarioSqliteStorage(scenePath)
    const masters = new MasterDataSqliteStorage(masterPath)
    expect(masters.save(legacyMaster)).toBe(true)
    const old = draft()
    // Simulate a pre-boundary database row: public writes now reject this key, reads must not rewrite it.
    expect(legacyScenes.save(old, undefined)).toBe(true)
    old.config.links[1].bandwidth = 6
    old.config.links[1].parameterSource = { kind: 'MASTER_DATA', sourceId: legacyMaster.dataId, sourceVersion: 1, fields: ['bandwidth'] }
    const legacyDb = new DatabaseSync(scenePath)
    try { legacyDb.prepare('UPDATE scenarios SET config_json = ? WHERE id = ?').run(JSON.stringify(old.config), old.config.scenario.id) } finally { legacyDb.close() }
    legacyScenes.close()
    const scenes = new ScenarioSqliteStorage(scenePath, { equipmentPath, masterDataPath: masterPath })
    const equipments = new EquipmentSqliteStorage(equipmentPath, scenePath)
    const server = createMockServer({ scenarioStorage: scenes, equipmentStorage: equipments, masterDataStorage: masters })
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    cleanups.push(async () => { await server.close(); scenes.close(); equipments.close(); masters.close(); await rm(directory, { recursive: true, force: true }) })
    const saved = (await api.get('/api/v1/scenarios/SCN-001').set(admin).expect(200)).body.data
    await api.put('/api/v1/scenarios/SCN-001').set(admin).send(update(saved, saved.revision)).expect(200)
    const copy = structuredClone(saved)
    copy.config.scenario.id = 'SCN-NEW-LEGACY'
    await api.post('/api/v1/scenarios').set(admin).send(update(copy)).expect(422)
  })
})

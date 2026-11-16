// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioConfig, ScenarioDraft } from '../../src/contracts/domain-models'
import { EQUIPMENT } from '../fixtures/equipment'
import { createBackupFixture } from '../fixtures/system-backup'

const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { DatabaseSync } = await import('node:' + 'sqlite')
const { createHash } = await import('node:' + 'crypto')
const { readFileSync } = await import('node:' + 'fs')
const { EquipmentSqliteStorage } = await import('../../server/local/' + 'equipment-sqlite.js')
const { ScenarioSqliteStorage } = await import('../../server/local/' + 'scenario-sqlite.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { AdminProjection } = await import('../../server/admin/' + 'projection.js')
const { default: request } = await import('super' + 'test')

const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
const base = '/api/v1/admin/equipment'
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })

async function setupServer() {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-equipment-history-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const scenePath = join(directory, 'scenarios.db')
  const equipmentPath = join(directory, 'equipment.db')
  const scenarioStorage = new ScenarioSqliteStorage(scenePath, { equipmentPath, masterDataPath: join(directory, 'master.db') })
  const equipmentStorage = new EquipmentSqliteStorage(equipmentPath, scenePath)
  cleanups.push(() => { equipmentStorage.close(); scenarioStorage.close() })
  const server = (await import('../../server/' + 'app.js')).createMockServer({ port: 0, scenarioStorage, equipmentStorage })
  cleanups.push(() => server.close())
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  return { api, equipmentStorage, scenarioStorage, directory, equipmentPath }
}

function fixtureDraft(): ScenarioDraft { return new ScenarioProjection().get('SCN-001').data }

/** 构造带链路参数来源的有效场景草稿：微波链路频率落在 TEST-RADIO 的 100–200MHz，调制与装备一致。 */
function linkedDraft(equipmentId = EQUIPMENT.equipmentId): ScenarioDraft {
  const draft = fixtureDraft()
  // 夹具干扰功率按当前 dBm 档位规则需为合法值（1 W = +30 dBm，档位内）。
  Object.assign(draft.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
  const link = draft.config.links.find(item => item.type === 'MICROWAVE')!
  link.frequency = 150
  link.modulation = 'QPSK'
  link.berThreshold = EQUIPMENT.berThreshold as number
  link.parameterSource = { kind: 'EQUIPMENT', sourceId: equipmentId, sourceVersion: 1, fields: ['modulation', 'berThreshold'] }
  return draft
}

async function confirmDelete(api: ReturnType<typeof request>, id: string, version: number) {
  const created = await api.post('/api/v1/confirmations').set(headers).send({ action: 'MASTER_DATA_DELETE', objectId: `EQUIPMENT:${id}:${version}` }).expect(201)
  const confirmationId = created.body.data.confirmationId
  await api.post(`/api/v1/confirmations/${confirmationId}`).set(headers).send({ confirm: true }).expect(200)
  return { ...headers, 'X-Confirmation-Id': confirmationId }
}

async function createScenarioWithLink(api: ReturnType<typeof request>, equipmentId = EQUIPMENT.equipmentId) {
  const draft = linkedDraft(equipmentId)
  const created = await api.post('/api/v1/scenarios').set(headers).send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: 0 })
  if (created.status !== 201) throw new Error(`scenario create ${created.status}: ${JSON.stringify(created.body)}`)
  return draft
}

const recreateParams = { type: '微波通信设备', frequencyMinMHz: 100, frequencyMaxMHz: 200, modulation: 'QPSK', berThreshold: 0.00001 }

describe('D1 设备历史、引用防删与显式重建', () => {
  it('D1-01 运行冻结/模板创建时冻结来源；链路与平台端口在删除时按历史引用409列出目标', async () => {
    const { api, equipmentStorage } = await setupServer()
    await api.post(base).set(headers).send(EQUIPMENT).expect(201)
    const draft = await createScenarioWithLink(api)

    // 模板创建与运行冻结都要在发布点捕获参数来源。
    await api.post('/api/v1/templates').set(headers).send({ name: '来源模板', config: draft.config, uiExtensions: draft.uiExtensions }).expect(201)
    const run = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
    if (run.status !== 201) throw new Error(`run create ${run.status}: ${JSON.stringify(run.body)}`)
    const published = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)
    expect(published.map((row: { targetType: string }) => row.targetType).sort()).toEqual(['RUN', 'TEMPLATE'])
    expect(published.every((row: { equipmentVersion: number }) => row.equipmentVersion === 1)).toBe(true)
    expect(published.some((row: { targetId: string }) => row.targetId === run.body.data.runId)).toBe(true)

    // 独立投影验证：链路 + 平台端口来源在 RUN/TEMPLATE/ARCHIVE 三类发布目标都被捕获，
    // 解除当前引用后删除仍 409 并列出目标（历史引用不随当前引用解除）。
    const admin = new AdminProjection(undefined, equipmentStorage)
    equipmentStorage.save({ ...EQUIPMENT, equipmentId: 'REF-EQ' })
    equipmentStorage.setReference({ equipmentId: 'REF-EQ', equipmentVersion: 1, scenarioId: 'SCN-001', linkId: 'L-MW-01' }, false)
    equipmentStorage.setReference({ equipmentId: 'REF-EQ', equipmentVersion: 1, scenarioId: 'SCN-001', linkId: 'PORT-P1' }, false)
    const synthetic = { links: [{ id: 'L-MW-01', type: 'MICROWAVE', parameterSource: { kind: 'EQUIPMENT', sourceId: 'REF-EQ', sourceVersion: 1, fields: ['modulation'] } }],
      deviceParameters: { ports: { MISSION_UAV_PLATFORM: { P1: { txFrequency: 150, txBandwidth: 2, txPower: 1, rxFrequency: 150, rxBandwidth: 2, noiseFigureDb: 3, transferRate: 80,
        parameterSource: { kind: 'EQUIPMENT', sourceId: 'REF-EQ', sourceVersion: 1, fields: ['txBandwidth'] } } } } } } as unknown as ScenarioConfig
    admin.capturePublishedParameterSources(synthetic, { targetType: 'RUN', targetId: 'RUN-X', targetVersion: '1' }, 'admin')
    admin.capturePublishedParameterSources(synthetic, { targetType: 'TEMPLATE', targetId: 'TPL-X', targetVersion: '1' }, 'admin')
    admin.capturePublishedParameterSources(synthetic, { targetType: 'ARCHIVE', targetId: 'ARCH-X', targetVersion: '1' }, 'admin')
    const refPublished = equipmentStorage.publishedReferences('REF-EQ')
    expect(refPublished).toHaveLength(6)
    expect(refPublished.some((row: { sourceSummary: string }) => row.sourceSummary.startsWith('links['))).toBe(true)
    expect(refPublished.some((row: { sourceSummary: string }) => row.sourceSummary.includes('deviceParameters.ports'))).toBe(true)
    equipmentStorage.setReference({ equipmentId: 'REF-EQ', equipmentVersion: 1, scenarioId: 'SCN-001', linkId: 'L-MW-01' }, true)
    equipmentStorage.setReference({ equipmentId: 'REF-EQ', equipmentVersion: 1, scenarioId: 'SCN-001', linkId: 'PORT-P1' }, true)
    expect(equipmentStorage.details('REF-EQ').references).toEqual([])
    const blocked = admin.deleteEquipment('REF-EQ', 1)
    expect(blocked).toMatchObject({ ok: false, code: 'CONFLICT', status: 409 })
    if (!blocked.ok) {
      expect(blocked.message).toContain('运行')
      expect(blocked.message).toContain('模板')
      expect(blocked.message).toContain('归档')
    }
    expect(equipmentStorage.historyDetails('REF-EQ').publishedReferences).toHaveLength(6)
  })

  it('D1-02 已核验无引用设备可删；历史与DELETE保留、重复删除不追加事件；越权/过期版本拒绝', async () => {
    const { api, equipmentStorage } = await setupServer()
    await api.post(base).set(headers).send(EQUIPMENT).expect(201)
    // 升级后新建设备完整登记，无需人工核验即可删除。
    const confirmed = await confirmDelete(api, EQUIPMENT.equipmentId, 1)
    await api.delete(`${base}/${EQUIPMENT.equipmentId}?expectedVersion=1`).set(confirmed).expect(200)
    expect((await api.get(base).set(headers)).body.data).toEqual([])
    const history = (await api.get(`${base}/${EQUIPMENT.equipmentId}/history`).set(headers)).body.data
    expect(history.deleted).toBe(true)
    expect(history.history.map((row: { version: number }) => row.version)).toEqual([1])
    expect(history.lifecycle).toHaveLength(1)
    expect(history.lifecycle[0]).toMatchObject({ eventType: 'DELETE', version: 1 })
    // 重复删除不再追加成功事件。
    expect(equipmentStorage.delete(EQUIPMENT.equipmentId, 1)).toBe(false)
    expect(equipmentStorage.lifecycleEvents(EQUIPMENT.equipmentId)).toHaveLength(1)
    // 越权删除被拒绝。
    const denied = await api.delete(`${base}/${EQUIPMENT.equipmentId}?expectedVersion=1`).set({ ...headers, 'X-Demo-Role': 'OPERATOR' })
    expect([401, 403]).toContain(denied.status)
    // 过期版本删除被拒绝且不丢数据。
    await api.post(base).set(headers).send({ ...EQUIPMENT, equipmentId: 'V2-EQ' }).expect(201)
    await api.put(`${base}/V2-EQ`).set(headers).send({ ...EQUIPMENT, equipmentId: 'V2-EQ', frequencyMaxMHz: 250 }).expect(200)
    const staleConfirmed = await confirmDelete(api, 'V2-EQ', 1)
    expect((await api.delete(`${base}/V2-EQ?expectedVersion=1`).set(staleConfirmed)).status).toBe(409)
    expect(((await api.get(base).set(headers)).body.data as Array<{ equipmentId: string }>).some(row => row.equipmentId === 'V2-EQ')).toBe(true)
  })

  it('D1-03 迁移缺来源旧设备标待核验：拒删可停用；缺依据核验不解锁；升级后无引用设备正常删除', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wrj-legacy-eq-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const file = join(directory, 'equipment.db')
    const legacy = new DatabaseSync(file)
    legacy.exec(`CREATE TABLE equipment_parameters (id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, parameters_json TEXT NOT NULL) STRICT;
      CREATE TABLE equipment_history (id TEXT NOT NULL, version INTEGER NOT NULL, parameters_json TEXT NOT NULL, PRIMARY KEY(id, version)) STRICT;
      CREATE TABLE equipment_references (scenario_id TEXT NOT NULL, link_id TEXT NOT NULL, equipment_id TEXT NOT NULL, equipment_version INTEGER NOT NULL, PRIMARY KEY(scenario_id, link_id)) STRICT;`)
    legacy.prepare('INSERT INTO equipment_parameters VALUES (?, ?, ?)').run('OLD-EQ', 1, JSON.stringify({ ...EQUIPMENT, equipmentId: 'OLD-EQ' }))
    legacy.prepare('INSERT INTO equipment_history VALUES (?, ?, ?)').run('OLD-EQ', 1, JSON.stringify({ ...EQUIPMENT, equipmentId: 'OLD-EQ' }))
    legacy.close()

    const storage = new EquipmentSqliteStorage(file)
    cleanups.push(() => storage.close())
    const admin = new AdminProjection(undefined, storage)
    expect(storage.historyDetails('OLD-EQ').pendingVerification).toBe(true)
    expect(admin.deleteEquipment('OLD-EQ', 1)).toMatchObject({ ok: false, code: 'CONFLICT', status: 409 })
    // 缺依据的核验不能解锁。
    expect(admin.recordEquipmentVerification('OLD-EQ', { coveredTargets: '', evidenceSummary: '', conclusion: '' }, 'admin')).toMatchObject({ ok: false, status: 422 })
    // 只能先停用。
    expect(admin.saveEquipment({ ...EQUIPMENT, equipmentId: 'OLD-EQ', active: false }, 'OLD-EQ')).toMatchObject({ ok: true })
    expect(storage.historyDetails('OLD-EQ').pendingVerification).toBe(true)
    // 升级后新建且无引用的设备正常删除，不是全库禁删。
    expect(admin.saveEquipment({ ...EQUIPMENT, equipmentId: 'NEW-EQ' })).toMatchObject({ ok: true })
    expect(storage.historyDetails('NEW-EQ').pendingVerification).toBe(false)
    expect(admin.deleteEquipment('NEW-EQ', 1)).toMatchObject({ ok: true })
  })

  it('D1-04 有据核验且复检零引用才可删；核验后新登记发布引用立即阻止删除', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wrj-legacy-verify-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const make = (id: string) => {
      const file = join(directory, `${id}.db`)
      const db = new DatabaseSync(file)
      db.exec(`CREATE TABLE equipment_parameters (id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, parameters_json TEXT NOT NULL) STRICT;
        CREATE TABLE equipment_history (id TEXT NOT NULL, version INTEGER NOT NULL, parameters_json TEXT NOT NULL, PRIMARY KEY(id, version)) STRICT;
        CREATE TABLE equipment_references (scenario_id TEXT NOT NULL, link_id TEXT NOT NULL, equipment_id TEXT NOT NULL, equipment_version INTEGER NOT NULL, PRIMARY KEY(scenario_id, link_id)) STRICT;`)
      db.prepare('INSERT INTO equipment_parameters VALUES (?, ?, ?)').run(id, 1, JSON.stringify({ ...EQUIPMENT, equipmentId: id }))
      db.prepare('INSERT INTO equipment_history VALUES (?, ?, ?)').run(id, 1, JSON.stringify({ ...EQUIPMENT, equipmentId: id }))
      db.close()
      return new EquipmentSqliteStorage(file)
    }
    const storage = make('A')
    cleanups.push(() => storage.close())
    const admin = new AdminProjection(undefined, storage)
    expect(admin.recordEquipmentVerification('A', { coveredTargets: 'SCN-001/L-MW-01 v1', evidenceSummary: '核查旧日志与模板清单', conclusion: '确无历史引用' }, 'admin')).toMatchObject({ ok: true })
    expect(storage.historyDetails('A').pendingVerification).toBe(false)
    expect(admin.deleteEquipment('A', 1)).toMatchObject({ ok: true })

    const storageB = make('B')
    cleanups.push(() => storageB.close())
    const adminB = new AdminProjection(undefined, storageB)
    expect(adminB.recordEquipmentVerification('B', { coveredTargets: 'SCN-001', evidenceSummary: '依据摘要', conclusion: '暂无引用' }, 'admin')).toMatchObject({ ok: true })
    storageB.addPublishedReference({ equipmentId: 'B', equipmentVersion: 1, targetType: 'RUN', targetId: 'RUN-NEW', targetVersion: '1', sourceSummary: 'links[L1].parameterSource' })
    // 核验后新登记发布引用立即阻止删除，不能绕过。
    expect(adminB.deleteEquipment('B', 1)).toMatchObject({ ok: false, code: 'CONFLICT', status: 409 })
  })

  it('D1-05 V1→V2→删除→重建V3；普通新建撞历史ID为409；首次新ID仍V1；旧版本与DELETE不改、旧引用不复活', async () => {
    const { api, equipmentStorage } = await setupServer()
    await api.post(base).set(headers).send(EQUIPMENT).expect(201)
    await api.put(`${base}/${EQUIPMENT.equipmentId}`).set(headers).send({ ...EQUIPMENT, frequencyMaxMHz: 250 }).expect(200)
    const confirmed = await confirmDelete(api, EQUIPMENT.equipmentId, 2)
    await api.delete(`${base}/${EQUIPMENT.equipmentId}?expectedVersion=2`).set(confirmed).expect(200)
    expect(((await api.get(base).set(headers)).body.data as unknown[]).length).toBe(0)

    // 普通新建撞已删除编号 → 409 提示重建。
    const plain = await api.post(base).set(headers).send(EQUIPMENT)
    expect(plain.status).toBe(409)
    expect(plain.body.error.message).toMatch(/重建/)

    const recreated = await api.post(`${base}/${EQUIPMENT.equipmentId}/recreate`).set(headers).send({ expectedHistoryVersion: 2, parameters: recreateParams }).expect(201)
    expect(recreated.body.data.equipment).toMatchObject({ equipmentId: EQUIPMENT.equipmentId, version: 3, readOnly: false })
    expect(recreated.body.data.event).toMatchObject({ eventType: 'RECREATE', version: 3 })
    // store/UI 接收实际版本 V3（普通新建 V1 断言在 store 测试中保留）。
    expect((await api.get(base).set(headers)).body.data[0].version).toBe(3)

    const history = (await api.get(`${base}/${EQUIPMENT.equipmentId}/history`).set(headers)).body.data
    expect(history.history.map((row: { version: number }) => row.version)).toEqual([3, 2, 1])
    expect(history.lifecycle.map((row: { eventType: string }) => row.eventType)).toEqual(['DELETE', 'RECREATE'])
    expect(history.lifecycle[0]).toMatchObject({ eventType: 'DELETE', version: 2 })
    // 重建后旧引用不自动恢复。
    expect(equipmentStorage.details(EQUIPMENT.equipmentId).references).toEqual([])
    // 首次新编号仍为 V1。
    expect((await api.post(base).set(headers).send({ ...EQUIPMENT, equipmentId: 'FRESH-EQ' }).expect(201)).body.data.version).toBe(1)
    // 当前记录已存在时再次重建拒绝。
    expect((await api.post(`${base}/${EQUIPMENT.equipmentId}/recreate`).set(headers).send({ expectedHistoryVersion: 3, parameters: recreateParams })).status).toBe(409)
  })

  it('D1-06 并发重建仅一个成功；过期版本/无历史/当前存在/只读字段/非法值/越权分别拒绝', async () => {
    const { api, equipmentStorage } = await setupServer()
    await api.post(base).set(headers).send(EQUIPMENT).expect(201)
    const confirmed = await confirmDelete(api, EQUIPMENT.equipmentId, 1)
    await api.delete(`${base}/${EQUIPMENT.equipmentId}?expectedVersion=1`).set(confirmed).expect(200)

    // 并发：两个 expectedHistoryVersion=1 只应有一个成功。
    const [a, b] = await Promise.all([
      api.post(`${base}/${EQUIPMENT.equipmentId}/recreate`).set(headers).send({ expectedHistoryVersion: 1, parameters: recreateParams }),
      api.post(`${base}/${EQUIPMENT.equipmentId}/recreate`).set(headers).send({ expectedHistoryVersion: 1, parameters: recreateParams }),
    ])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect(equipmentStorage.lifecycleEvents(EQUIPMENT.equipmentId).filter((row: { eventType: string }) => row.eventType === 'RECREATE')).toHaveLength(1)

    // 过期版本：删除后重建用错误 expected。
    const confirmed2 = await confirmDelete(api, EQUIPMENT.equipmentId, 2)
    await api.delete(`${base}/${EQUIPMENT.equipmentId}?expectedVersion=2`).set(confirmed2).expect(200)
    expect((await api.post(`${base}/${EQUIPMENT.equipmentId}/recreate`).set(headers).send({ expectedHistoryVersion: 1, parameters: recreateParams })).status).toBe(409)
    // 无历史 404。
    expect((await api.post(`${base}/NO-HISTORY/recreate`).set(headers).send({ expectedHistoryVersion: 1, parameters: recreateParams })).status).toBe(404)
    // 只读字段/编号覆盖 422。
    expect((await api.post(`${base}/${EQUIPMENT.equipmentId}/recreate`).set(headers).send({ expectedHistoryVersion: 2, parameters: { ...recreateParams, readOnly: true } })).status).toBe(422)
    expect((await api.post(`${base}/${EQUIPMENT.equipmentId}/recreate`).set(headers).send({ expectedHistoryVersion: 2, parameters: { ...recreateParams, equipmentId: 'OTHER' } })).status).toBe(422)
    // 非法参数 422。
    expect((await api.post(`${base}/${EQUIPMENT.equipmentId}/recreate`).set(headers).send({ expectedHistoryVersion: 2, parameters: { ...recreateParams, frequencyMinMHz: 0 } })).status).toBe(422)
    // 越权 403。
    expect((await api.post(`${base}/${EQUIPMENT.equipmentId}/recreate`).set({ ...headers, 'X-Demo-Role': 'OPERATOR' }).send({ expectedHistoryVersion: 2, parameters: recreateParams })).status).toBe(403)
    // 失败的重建不留下半条事件或当前记录（已存在 DELETE(v1)、RECREATE(v2)、DELETE(v2) 三条事件）。
    expect(equipmentStorage.load().some((row: { equipmentId: string }) => row.equipmentId === EQUIPMENT.equipmentId)).toBe(false)
    expect(equipmentStorage.lifecycleEvents(EQUIPMENT.equipmentId)).toHaveLength(3)
  })

  it('D1-07 旧库升级幂等、新备份恢复保留引用/核验/DELETE，旧格式恢复标未核验，篡改拒绝且回滚保留prebackupId', async () => {
    const f = createBackupFixture()
    cleanups.push(() => f.close())
    const equipment = f.equipment.load()[0]!
    // 先建立第二版本（此时无引用），再登记当前引用与核验。
    expect(f.equipment.save({ ...equipment, version: 2, modulation: 'BPSK' }, 1)).toBe(true)
    f.equipment.setReference({ equipmentId: equipment.equipmentId, equipmentVersion: 2, scenarioId: 'SCN-001', linkId: 'L-MW-01' }, false)
    f.equipment.recordVerification({ equipmentId: equipment.equipmentId, coveredTargets: 'SCN-001', evidenceSummary: '核查通过', conclusion: '无历史引用', operator: 'admin', verifiedAt: '2026-09-21T00:00:00Z' })
    // 另一台设备承载发布引用历史（发布引用会阻止删除，故不放在被删除设备上）。
    expect(f.equipment.save({ ...EQUIPMENT, equipmentId: 'PUB-EQ' })).toBe(true)
    f.equipment.addPublishedReference({ equipmentId: 'PUB-EQ', equipmentVersion: 1, targetType: 'RUN', targetId: 'RUN-BACKUP', targetVersion: '1', sourceSummary: 'links[L-MW-01].parameterSource' })
    expect(f.backup.backup('NEW-FMT').ok).toBe(true)
    expect(f.backup.backup('OLD-FMT').ok).toBe(true)
    // 制造 DELETE 事件后再备份。
    f.equipment.setReference({ equipmentId: equipment.equipmentId, equipmentVersion: 2, scenarioId: 'SCN-001', linkId: 'L-MW-01' }, true)
    expect(f.equipment.delete(equipment.equipmentId, 2, 'admin')).toBe(true)
    expect(f.backup.backup('DEL-FMT').ok).toBe(true)

    // 新格式恢复：当前记录、历史、引用、核验与发布引用均保留。
    expect(f.backup.restore('NEW-FMT')).toMatchObject({ ok: true, data: { result: 'SUCCESS' } })
    const restored = f.equipment.historyDetails(equipment.equipmentId)
    expect(restored.deleted).toBe(false)
    expect(restored.history.map((row: { version: number }) => row.version)).toEqual([2, 1])
    expect(restored.references).toHaveLength(1)
    expect(restored.verification).toMatchObject({ evidenceSummary: '核查通过' })
    expect(f.equipment.publishedReferences('PUB-EQ')).toHaveLength(1)
    // DELETE 事件随备份恢复。
    expect(f.backup.restore('DEL-FMT')).toMatchObject({ ok: true, data: { result: 'SUCCESS' } })
    expect(f.equipment.historyDetails(equipment.equipmentId).deleted).toBe(true)
    expect(f.equipment.lifecycleEvents(equipment.equipmentId).some((row: { eventType: string }) => row.eventType === 'DELETE')).toBe(true)
    // 旧格式备份（移除新增表）恢复后设备标为“历史引用待核验”。
    const path = join(f.backup.directory, 'OLD-FMT.system.db')
    const snapshot = new DatabaseSync(path)
    const tables = JSON.parse(String(snapshot.prepare('SELECT payload FROM snapshot').get()?.payload)) as Array<{ scope: string; table: string; rows: unknown[] }>
    const legacyTables = tables.filter(table => !(table.scope === 'equipment' && ['equipment_published_references', 'equipment_lifecycle_events', 'equipment_verification', 'equipment_legacy_unverified'].includes(table.table)))
    snapshot.prepare('UPDATE snapshot SET payload=?').run(JSON.stringify(legacyTables)); snapshot.close()
    const catalog = new DatabaseSync(join(f.backup.directory, 'catalog.db'))
    catalog.prepare('UPDATE system_backups SET checksum=? WHERE backup_id=?').run(createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase(), 'OLD-FMT')
    catalog.close()
    expect(f.backup.restore('OLD-FMT')).toMatchObject({ ok: true, data: { result: 'SUCCESS' } })
    expect(f.equipment.historyDetails(equipment.equipmentId).pendingVerification).toBe(true)

    // 篡改：发布引用版本缺失被拒绝，恢复保留 prebackupId 并回滚。
    expect(f.backup.backup('TAMPER').ok).toBe(true)
    const tamperPath = join(f.backup.directory, 'TAMPER.system.db')
    const tamper = new DatabaseSync(tamperPath)
    const tamperTables = JSON.parse(String(tamper.prepare('SELECT payload FROM snapshot').get()?.payload)) as Array<{ scope: string; table: string; rows: Array<Record<string, unknown>> }>
    const publishedRow = { equipment_id: equipment.equipmentId, equipment_version: 99, target_type: 'RUN', target_id: 'RUN-X', target_version: '1', source_summary: 'x', created_at: '2026-09-21T00:00:00.000Z' }
    tamperTables.find(table => table.scope === 'equipment' && table.table === 'equipment_published_references')!.rows.push(publishedRow)
    tamper.prepare('UPDATE snapshot SET payload=?').run(JSON.stringify(tamperTables)); tamper.close()
    const catalog2 = new DatabaseSync(join(f.backup.directory, 'catalog.db'))
    catalog2.prepare('UPDATE system_backups SET checksum=? WHERE backup_id=?').run(createHash('sha256').update(readFileSync(tamperPath)).digest('hex').toUpperCase(), 'TAMPER')
    catalog2.close()
    const tampered = f.backup.restore('TAMPER')
    expect(tampered).toMatchObject({ ok: true, data: { result: 'FAILURE', integrityValid: false } })
    expect(f.backup.listBackups().some((row: { backupId: string }) => typeof row.backupId === 'string' && row.backupId.startsWith('PREBACKUP-'))).toBe(true)
  })

  it('B2 重建失败尝试不留半写；重试版本=历史最大+1 且 RECREATE 只记一次', async () => {
    const { api, equipmentStorage } = await setupServer()
    await api.post(base).set(headers).send(EQUIPMENT).expect(201)
    const confirmed = await confirmDelete(api, EQUIPMENT.equipmentId, 1)
    await api.delete(`${base}/${EQUIPMENT.equipmentId}?expectedVersion=1`).set(confirmed).expect(200)
    // 失败尝试：错误期望版本，不得留下半条当前记录或事件。
    expect((await api.post(`${base}/${EQUIPMENT.equipmentId}/recreate`).set(headers).send({ expectedHistoryVersion: 5, parameters: recreateParams })).status).toBe(409)
    expect(equipmentStorage.load().some((row: { equipmentId: string }) => row.equipmentId === EQUIPMENT.equipmentId)).toBe(false)
    expect(equipmentStorage.lifecycleEvents(EQUIPMENT.equipmentId).filter((row: { eventType: string }) => row.eventType === 'RECREATE')).toHaveLength(0)
    // 恢复后重试：版本为历史最大(1)+1=2，RECREATE 只记一次。
    const retried = await api.post(`${base}/${EQUIPMENT.equipmentId}/recreate`).set(headers).send({ expectedHistoryVersion: 1, parameters: recreateParams })
    expect(retried.status).toBe(201)
    expect(retried.body.data.equipment).toMatchObject({ equipmentId: EQUIPMENT.equipmentId, version: 2 })
    expect(equipmentStorage.lifecycleEvents(EQUIPMENT.equipmentId).map((row: { eventType: string }) => row.eventType)).toEqual(['DELETE', 'RECREATE'])
    expect(equipmentStorage.lifecycleEvents(EQUIPMENT.equipmentId).filter((row: { eventType: string }) => row.eventType === 'RECREATE')).toHaveLength(1)
  })

  it('B2 DELETE→RECREATE 后备份恢复保留连续版本、RECREATE、核验与发布引用，且历史引用不改绑', async () => {
    const f = createBackupFixture()
    cleanups.push(() => f.close())
    const equipment = f.equipment.load()[0]!
    expect(f.equipment.save({ ...equipment, version: 2, modulation: 'BPSK' }, 1)).toBe(true)
    f.equipment.recordVerification({ equipmentId: equipment.equipmentId, coveredTargets: 'SCN-001', evidenceSummary: '重建前核验', conclusion: '通过', operator: 'admin', verifiedAt: '2026-09-21T00:00:00Z' })
    expect(f.equipment.save({ ...EQUIPMENT, equipmentId: 'PUB-EQ' })).toBe(true)
    f.equipment.addPublishedReference({ equipmentId: 'PUB-EQ', equipmentVersion: 1, targetType: 'RUN', targetId: 'RUN-RECREATE', targetVersion: '1', sourceSummary: 'links[L-MW-01].parameterSource' })
    // 真实 DELETE → RECREATE（版本连续 3）。
    expect(f.equipment.delete(equipment.equipmentId, 2, 'admin')).toBe(true)
    const recreated = f.equipment.recreate(equipment.equipmentId, 2, recreateParams, 'admin')
    expect(recreated.ok).toBe(true)
    if (recreated.ok) expect(recreated.equipment.version).toBe(3)
    expect(f.equipment.lifecycleEvents(equipment.equipmentId).map((row: { eventType: string }) => row.eventType)).toEqual(['DELETE', 'RECREATE'])
    expect(f.backup.backup('RECREATE-FMT').ok).toBe(true)
    expect(f.backup.restore('RECREATE-FMT')).toMatchObject({ ok: true, data: { result: 'SUCCESS' } })
    const restored = f.equipment.historyDetails(equipment.equipmentId)
    expect(restored.deleted).toBe(false)
    expect(restored.current?.version).toBe(3)
    expect(restored.history.map((row: { version: number }) => row.version)).toEqual([3, 2, 1])
    expect(restored.verification).toMatchObject({ evidenceSummary: '重建前核验' })
    // 历史引用不改绑到重建后的新版本。
    expect(restored.references).toEqual([])
    expect(f.equipment.publishedReferences('PUB-EQ')).toHaveLength(1)
    expect(f.equipment.lifecycleEvents(equipment.equipmentId).map((row: { eventType: string }) => row.eventType)).toEqual(['DELETE', 'RECREATE'])
  })

  it('B2 事务中途写失败：current/history/lifecycle 全回滚；重试版本=历史最大+1 且 RECREATE 只一次', async () => {
    const { api, equipmentStorage } = await setupServer()
    await api.post(base).set(headers).send(EQUIPMENT).expect(201)
    const confirmed = await confirmDelete(api, EQUIPMENT.equipmentId, 1)
    await api.delete(`${base}/${EQUIPMENT.equipmentId}?expectedVersion=1`).set(confirmed).expect(200)
    // 操作前状态：无当前记录、历史 [1]、仅 DELETE 事件
    expect(equipmentStorage.historyDetails(EQUIPMENT.equipmentId).history.map((row: { version: number }) => row.version)).toEqual([1])
    expect(equipmentStorage.lifecycleEvents(EQUIPMENT.equipmentId).map((row: { eventType: string }) => row.eventType)).toEqual(['DELETE'])
    // 在 current、history 已写入之后、lifecycle 写入阶段注入一次性失败
    const originalPrepare = DatabaseSync.prototype.prepare
    let fired = false
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: unknown, ...args: unknown[]) {
      const sql = args[0] as string
      const stmt = originalPrepare.call(this, sql) as { run: (...runArgs: unknown[]) => unknown }
      if (!fired && typeof sql === 'string' && sql.includes('INSERT INTO equipment_lifecycle_events')) {
        return { run: () => { fired = true; throw new Error('AUDIT lifecycle write failure') } } as never
      }
      return stmt as never
    })
    let thrown: Error | undefined
    try { equipmentStorage.recreate(EQUIPMENT.equipmentId, 1, recreateParams, 'admin') } catch (error) { thrown = error as Error }
    spy.mockRestore()
    expect(fired).toBe(true)
    expect(thrown?.message).toBe('AUDIT lifecycle write failure')
    // 全部回滚：current 不存在、history 仍 [1]、无 RECREATE 事件
    expect(equipmentStorage.load().some((row: { equipmentId: string }) => row.equipmentId === EQUIPMENT.equipmentId)).toBe(false)
    expect(equipmentStorage.historyDetails(EQUIPMENT.equipmentId).history.map((row: { version: number }) => row.version)).toEqual([1])
    expect(equipmentStorage.lifecycleEvents(EQUIPMENT.equipmentId).map((row: { eventType: string }) => row.eventType)).toEqual(['DELETE'])
    // 去掉注入后重试：版本=历史最大(1)+1=2，RECREATE 只一次
    const retried = equipmentStorage.recreate(EQUIPMENT.equipmentId, 1, recreateParams, 'admin')
    expect(retried.ok).toBe(true)
    if (retried.ok) expect(retried.equipment.version).toBe(2)
    expect(equipmentStorage.lifecycleEvents(EQUIPMENT.equipmentId).map((row: { eventType: string }) => row.eventType)).toEqual(['DELETE', 'RECREATE'])
    expect(equipmentStorage.lifecycleEvents(EQUIPMENT.equipmentId).filter((row: { eventType: string }) => row.eventType === 'RECREATE')).toHaveLength(1)
  })

  it('B2 历史引用身份：删除后对历史版本合法冻结引用，重建不改绑，备份恢复保留完整身份', async () => {
    const f = createBackupFixture()
    cleanups.push(() => f.close())
    const equipment = f.equipment.load()[0]!
    // 合法时序：先删除当前 v1（此时无有效引用，删除合法）
    expect(f.equipment.delete(equipment.equipmentId, 1, 'admin')).toBe(true)
    // 删除后对历史版本 v1 合法冻结发布引用
    expect(f.equipment.addPublishedReference({ equipmentId: equipment.equipmentId, equipmentVersion: 1, targetType: 'RUN', targetId: 'RUN-HIST', targetVersion: '7', sourceSummary: 'links[L-MW-01].parameterSource' })).toBe(true)
    // 重建为 v2，历史引用不得改绑到新版本
    const recreated = f.equipment.recreate(equipment.equipmentId, 1, recreateParams, 'admin')
    expect(recreated.ok).toBe(true)
    if (recreated.ok) expect(recreated.equipment.version).toBe(2)
    expect(f.equipment.publishedReferences(equipment.equipmentId).map((row: { equipmentVersion: number; targetType: string; targetId: string; targetVersion: string }) => ({ version: row.equipmentVersion, type: row.targetType, id: row.targetId, targetVersion: row.targetVersion })))
      .toEqual([{ version: 1, type: 'RUN', id: 'RUN-HIST', targetVersion: '7' }])
    // 备份恢复后引用身份字段完整保留，仍未改绑
    expect(f.backup.backup('HIST-REF').ok).toBe(true)
    expect(f.backup.restore('HIST-REF')).toMatchObject({ ok: true, data: { result: 'SUCCESS' } })
    expect(f.equipment.publishedReferences(equipment.equipmentId)).toMatchObject([{ equipmentId: equipment.equipmentId, equipmentVersion: 1, targetType: 'RUN', targetId: 'RUN-HIST', targetVersion: '7', sourceSummary: 'links[L-MW-01].parameterSource' }])
    expect(f.equipment.historyDetails(equipment.equipmentId).current?.version).toBe(2)
    expect(f.equipment.lifecycleEvents(equipment.equipmentId).map((row: { eventType: string }) => row.eventType)).toEqual(['DELETE', 'RECREATE'])
  })
})

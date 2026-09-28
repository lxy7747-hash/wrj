// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioDraft } from '../../src/contracts/domain-models'
import { createEmptyScenarioDraft } from '../../src/features/scenarios/scenario-basic'

// Node 专用入口不纳入浏览器类型工程，与现有本机文件接口测试保持一致。
const fsModule = 'node:fs/' + 'promises'
const osModule = 'node:' + 'os'
const pathModule = 'node:' + 'path'
const eventsModule = 'node:' + 'events'
const sqliteModule = 'node:' + 'sqlite'
const storageModule = '../../server/local/' + 'scenario-sqlite.js'
const appModule = '../../server/' + 'app.js'
const projectionModule = '../../server/scenarios/' + 'projection.js'
const requestModule = 'super' + 'test'
const { mkdtemp, rm } = await import(fsModule)
const { tmpdir } = await import(osModule)
const { join } = await import(pathModule)
const { once } = await import(eventsModule)
const { DatabaseSync } = await import(sqliteModule)
const { ScenarioSqliteStorage } = await import(storageModule)
const { ScenarioProjection } = await import(projectionModule)
const { createMockServer } = await import(appModule)
const { default: request } = await import(requestModule)
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
const endpoint = '/api/v1/scenarios/SCN-001'
let directory = ''
const resources: Array<() => Promise<void> | void> = []

async function databasePath() {
  if (!directory) directory = await mkdtemp(join(tmpdir(), 'wrj-scenario-sqlite-'))
  return join(directory, 'scenarios.db') as string
}

async function start(path: string) {
  const storage = new ScenarioSqliteStorage(path)
  const server = createMockServer({ scenarioStorage: storage })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await server.close()
    storage.close()
  }
  resources.push(stop)
  return { api, storage, stop }
}

function draft(): ScenarioDraft {
  return new ScenarioProjection().get('SCN-001').data
}

function update(value: ScenarioDraft, expectedRevision = 0) {
  return { config: value.config, uiExtensions: value.uiExtensions, expectedRevision }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of resources.reverse()) await close()
  resources.length = 0
  // 仅删除本用例在系统临时目录创建的独立数据库，不触碰用户数据目录。
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

describe('SQLite 场景开发持久化', () => {
  it('零速度航点在保存前返回字段错误，不写入或增加修订；正速度可保存', async () => {
    const { api, storage } = await start(await databasePath())
    const value = draft()
    const saved = (await api.put(endpoint).set(headers).send(update(value)).expect(200)).body.data
    const platform = value.config.platforms[3]!
    platform.waypoints = [{ ...platform.initialPosition, speed: 0, arrivalTime: 10 }]
    const failed = await api.put(endpoint).set(headers).send(update(value, saved.revision)).expect(422)
    expect(failed.body.error).toMatchObject({ fieldPath: 'platforms[3].waypoints[0].speed', message: expect.stringContaining('必须大于 0') })
    expect(storage.load()).toEqual(saved)
    platform.waypoints[0]!.speed = 20
    await api.put(endpoint).set(headers).send(update(value, saved.revision)).expect(200)
    expect(storage.load().config.platforms[3].waypoints[0].speed).toBe(20)
  })

  it('新干扰范围可保存重读，缺少 jammingRange 的旧格式不能新建、保存或导入', async () => {
    const path = await databasePath()
    const first = await start(path)
    const current = draft()
    const saved = (await first.api.put(endpoint).set(headers).send(update(current)).expect(200)).body.data
    const legacy = structuredClone(current)
    Reflect.deleteProperty(legacy.config.jammers[0]!, 'jammingRange')
    const rejected = await first.api.put(endpoint).set(headers).send(update(legacy, saved.revision)).expect(422)
    expect(rejected.body.error).toMatchObject({ fieldPath: 'jammers[0].jammingRange', message: expect.stringContaining('不支持该旧格式') })
    legacy.config.scenario.id = 'SCN-LEGACY-JAMMER'
    const created = await first.api.post('/api/v1/scenarios').set(headers).send(update(legacy)).expect(422)
    expect(created.body.error.fieldPath).toBe('jammers[0].jammingRange')
    const imported = await first.api.post('/api/v1/scenarios/import').set(headers).send({ items: [legacy.config] }).expect(422)
    expect(imported.body.error.fieldPath).toBe('items[0].jammers[0].jammingRange')
    expect(first.storage.list()).toEqual([saved])
    expect(legacy.config.jammers[0]).not.toHaveProperty('jammingRange')
    await first.stop()
    const reopened = await start(path)
    expect((await reopened.api.get(endpoint).set(headers).expect(200)).body.data).toEqual(saved)
  })

  it('读取也拒绝缺少 jammingRange 的旧格式，不补默认值或改写原记录', async () => {
    const path = await databasePath()
    const first = await start(path)
    await first.api.put(endpoint).set(headers).send(update(draft())).expect(200)
    await first.stop()
    const legacy = draft().config
    Reflect.deleteProperty(legacy.jammers[0]!, 'jammingRange')
    const db = new DatabaseSync(path)
    try {
      const json = JSON.stringify(legacy)
      db.prepare('UPDATE scenarios SET config_json = ? WHERE id = ?').run(json, legacy.scenario.id)
      expect(() => new ScenarioSqliteStorage(path)).toThrow('场景数据库结构或数据无效')
      expect(db.prepare('SELECT config_json FROM scenarios WHERE id = ?').get(legacy.scenario.id).config_json).toBe(json)
    } finally { db.close() }
  })

  it('旧四类优先级与历史业务文本重新打开仍原样读取，新建和 PUT 继续拒绝旧写入', async () => {
    const path = await databasePath()
    const old = draft()
    old.config.informationDemand[0]!.informationType = '视频'
    old.config.linkSettings = {
      priority: ['SAT', 'MICROWAVE', 'DATALINK', 'LASER'],
      enabledTypes: { SAT: true, MICROWAVE: true, DATALINK: true, LASER: true },
      enabledSatellites: { TIANTONG: false, SHENTONG: false }, switchCooldownS: 5,
    }
    const initial = new ScenarioSqliteStorage(path)
    expect(initial.save(old)).toBe(true)
    initial.close()
    const reopened = await start(path)
    expect((await reopened.api.get(endpoint).set(headers).expect(200)).body.data.config).toEqual(old.config)
    const failed = await reopened.api.put(endpoint).set(headers).send({ ...update(old), expectedRevision: old.revision }).expect(422)
    expect(failed.body.error).toBeDefined()
    expect(reopened.storage.load('SCN-001').config).toEqual(old.config)
    const created = structuredClone(old)
    created.config.scenario.id = 'SCN-LEGACY-NEW'
    await reopened.api.post('/api/v1/scenarios').set(headers).send(update(created)).expect(422)
    expect(reopened.storage.load('SCN-LEGACY-NEW')).toBeUndefined()
    old.config.informationDemand[0]!.informationType = '态势信息'
    old.config.linkSettings.priority.push('FIBER')
    old.config.linkSettings.enabledTypes!.FIBER = true
    await reopened.api.put(endpoint).set(headers).send({ ...update(old), expectedRevision: old.revision }).expect(200)
    await reopened.stop()
    const final = new ScenarioSqliteStorage(path)
    try { expect(final.load('SCN-001').config).toEqual(old.config) } finally { final.close() }
  })

  it('列表、多场景同修订持久化、独立编辑及按修订删除不会影响其他场景', async () => {
    const path = await databasePath()
    const first = await start(path)
    expect((await first.api.get('/api/v1/scenarios').set(headers).expect(200)).body.data).toEqual([])
    const a = draft()
    const b = draft()
    b.config.scenario.id = 'SCN-SECOND'
    b.config.scenario.name = '第二个场景'
    const savedA = (await first.api.post('/api/v1/scenarios').set(headers).send(update(a)).expect(201)).body.data
    const savedB = (await first.api.post('/api/v1/scenarios').set(headers).send(update(b)).expect(201)).body.data
    expect(savedA.revision).toBe(savedB.revision)
    await first.api.post('/api/v1/scenarios').set(headers).send(update(a)).expect(409)
    expect((await first.api.get('/api/v1/scenarios').set(headers).expect(200)).body.data).toHaveLength(2)
    const renamed = structuredClone(savedA)
    renamed.config.scenario.name = '只修改第一个'
    const changedA = (await first.api.put(endpoint).set(headers).send({ ...update(renamed), expectedRevision: savedA.revision }).expect(200)).body.data
    expect(first.storage.load('SCN-SECOND')).toEqual(savedB)
    await first.stop()
    const second = await start(path)
    expect((await second.api.get(endpoint).set(headers).expect(200)).body.data).toEqual(changedA)
    expect((await second.api.get('/api/v1/scenarios/SCN-SECOND').set(headers).expect(200)).body.data).toEqual(savedB)
    await second.api.delete(endpoint).set(headers).expect(422)
    await second.api.delete(`${endpoint}?expectedRevision=${savedA.revision}`).set(headers).expect(409)
    await second.api.delete(`${endpoint}?expectedRevision=${changedA.revision}`).set({ ...headers, 'X-Demo-Role': 'UNKNOWN' }).expect(403)
    await second.api.delete(`${endpoint}?expectedRevision=${changedA.revision}`).set(headers).expect(200)
    await second.api.get(endpoint).set(headers).expect(404)
    expect((await second.api.get('/api/v1/scenarios').set(headers).expect(200)).body.data).toEqual([savedB])
  })

  it('运行锁只作用于对应场景，禁止删除或写入；模板按新编号创建不覆盖来源', async () => {
    const projection = new ScenarioProjection()
    const original = projection.get('SCN-001').data
    expect(projection.copyTemplate(original.config, '模板副本', original.uiExtensions, 'SCN-COPY').ok).toBe(true)
    projection.setLocked('SCN-COPY', true)
    expect(projection.delete('SCN-COPY', { expectedRevision: 1 })).toMatchObject({ ok: false, status: 409, code: 'CONFIG_LOCKED' })
    const copy = projection.get('SCN-COPY').data
    expect(projection.save('SCN-COPY', update(copy))).toMatchObject({ ok: false, code: 'CONFIG_LOCKED' })
    expect(projection.get('SCN-001').data).toEqual(original)
    projection.setLocked('SCN-COPY', false)
    expect(projection.delete('SCN-COPY', { expectedRevision: 1 }).ok).toBe(true)
    expect(projection.list()).toEqual([original])
  })

  it('空白新草稿不能写库，填齐后按新编号首次保存并在重启后恢复', async () => {
    const path = await databasePath()
    const first = await start(path)
    const initial = createEmptyScenarioDraft('SCN-NEW-TEST')
    await first.api.put('/api/v1/scenarios/SCN-NEW-TEST').set(headers).send(update(initial)).expect(422)
    expect(first.storage.load()).toBeUndefined()
    const complete = draft()
    complete.config.scenario.id = initial.config.scenario.id
    const saved = (await first.api.put('/api/v1/scenarios/SCN-NEW-TEST').set(headers).send(update(complete)).expect(200)).body.data
    expect(saved.revision).toBe(1)
    await first.stop()
    const second = await start(path)
    expect((await second.api.get('/api/v1/scenarios/SCN-NEW-TEST').set(headers).expect(200)).body.data).toEqual(saved)
  })

  it('创建空表和只读 GET 不落入演示记录，显式 PUT 后关闭并重新打开仍完整一致', async () => {
    const path = await databasePath()
    const first = await start(path)
    expect(first.storage.load()).toBeUndefined()
    const missing = await first.api.get(endpoint).set(headers).expect(404)
    expect(missing.body.error.code).toBe('NOT_FOUND')
    await first.api.post('/api/v1/reset').set(headers).send({ confirm: true }).expect(200)
    await first.api.get(endpoint).set(headers).expect(404)
    const initial = draft()
    expect(first.storage.load()).toBeUndefined()
    initial.config.scenario.name = 'SQLite 重启验证'
    initial.uiExtensions.jammers[0]!.enabled = !initial.uiExtensions.jammers[0]!.enabled
    const saved = (await first.api.put(endpoint).set(headers).send(update(initial)).expect(200)).body.data
    expect(saved.revision).toBe(1)
    await first.stop()
    const second = await start(path)
    expect((await second.api.get(endpoint).set(headers).expect(200)).body.data).toEqual(saved)
  })

  it('拒绝非法配置和无效角色，数据库与修订号不变', async () => {
    const { api, storage } = await start(await databasePath())
    const valid = draft()
    const saved = (await api.put(endpoint).set(headers).send(update(valid)).expect(200)).body.data
    valid.config.scenario.duration = -1
    await api.put(endpoint).set(headers).send(update(valid, saved.revision)).expect(422)
    await api.put(endpoint).set({ ...headers, 'X-Demo-Role': 'UNKNOWN' }).send(update(draft())).expect(403)
    expect(storage.load()).toEqual(saved)
  })

  it('数据库事务失败返回稳定错误且不泄露路径，撤销栈不被失败保存污染', async () => {
    const { api, storage } = await start(await databasePath())
    const original = draft()
    const first = structuredClone(original)
    first.config.scenario.name = '第一次保存'
    await api.put(endpoint).set(headers).send(update(original)).expect(200)
    await api.put(endpoint).set(headers).send(update(first, 1)).expect(200)
    const failedWrite = vi.spyOn(storage, 'save').mockImplementationOnce(() => { throw new Error('secret.db disk failure') })
    const failed = await api.put(endpoint).set(headers).send(update(original, 2)).expect(503)
    expect(failed.body.error.code).toBe('ATOMIC_REPLACE_FAILED')
    expect(JSON.stringify(failed.body)).not.toContain('secret.db')
    expect(storage.load().config.scenario.name).toBe('第一次保存')
    failedWrite.mockRestore()
    const current = (await api.get(endpoint).set(headers).expect(200)).body.data
    const undone = (await api.post(`${endpoint}/undo`).set(headers).send({ expectedRevision: current.revision }).expect(200)).body.data
    expect(undone.config).toEqual(original.config)
  })

  it('同库两个进程连接不能使用旧修订覆盖新记录，重新 GET 后可保存', async () => {
    const path = await databasePath()
    const first = await start(path)
    const second = await start(path)
    const original = draft()
    await first.api.put(endpoint).set(headers).send(update(original)).expect(200)
    const stale = (await second.api.get(endpoint).set(headers).expect(200)).body.data as ScenarioDraft
    await first.api.put(endpoint).set(headers).send({ ...update(stale), expectedRevision: stale.revision }).expect(200)
    await second.api.put(endpoint).set(headers).send({ ...update(stale), expectedRevision: stale.revision }).expect(409)
    const refreshed = (await second.api.get(endpoint).set(headers).expect(200)).body.data as ScenarioDraft
    refreshed.config.scenario.name = '重新加载后修改'
    await second.api.put(endpoint).set(headers).send(update(refreshed, refreshed.revision)).expect(200)
    expect(first.storage.load().config.scenario.name).toBe('重新加载后修改')
  })

  it('导入新编号保留独立记录，重启后按指定编号读取而非默认别名', async () => {
    const path = await databasePath()
    const first = await start(path)
    const original = draft()
    const saved = (await first.api.put(endpoint).set(headers).send(update(original)).expect(200)).body.data
    original.config.scenario.id = 'SCN-IMPORTED'
    const imported = (await first.api.post('/api/v1/scenarios/import').set(headers).send({ items: [original.config] }).expect(200)).body.data.drafts[0]
    expect((await first.api.get(endpoint).set(headers).expect(200)).body.data).toEqual(saved)
    await first.stop()
    const second = await start(path)
    expect((await second.api.get(endpoint).set(headers).expect(200)).body.data).toEqual(saved)
    expect((await second.api.get('/api/v1/scenarios/SCN-IMPORTED').set(headers).expect(200)).body.data).toEqual(imported)
    const db = new DatabaseSync(path, { readOnly: true })
    try { expect(db.prepare('SELECT count(*) AS count FROM scenarios').get().count).toBe(2) } finally { db.close() }
  })

  it('模板应用、场景重置及撤销同样落盘，全局 reset 不覆盖保存值', async () => {
    const { api, storage } = await start(await databasePath())
    const template = (await api.post('/api/v1/templates').set(headers).send({ name: '持久化模板', config: draft().config }).expect(201)).body.data
    const copied = await api.post(`/api/v1/templates/${template.templateId}/copy`).set(headers).send({ name: '模板应用' }).expect(201)
    expect(storage.load().config.scenario.name).toBe('模板应用')
    const reset = (await api.post(`${endpoint}/reset`).set(headers).send({ expectedRevision: copied.body.data.revision }).expect(200)).body.data
    expect(storage.load()).toEqual(reset)
    const undone = (await api.post(`${endpoint}/undo`).set(headers).send({ expectedRevision: reset.revision }).expect(200)).body.data
    expect(undone.config.scenario.name).toBe('模板应用')
    await api.post('/api/v1/reset').set(headers).send({ confirm: true }).expect(200)
    expect((await api.get(endpoint).set(headers).expect(200)).body.data).toEqual(undone)
    expect(storage.load()).toEqual(undone)
  })

  it('兼容旧卫星读取，但不放宽新写入校验；运行锁不持久化', async () => {
    const path = await databasePath()
    const { storage } = await start(path)
    const legacy = draft()
    legacy.locked = true
    delete legacy.config.platforms.find(item => item.type === 'COMMUNICATION_SATELLITE')!.satelliteType
    expect(storage.save(legacy, undefined)).toBe(true)
    expect(storage.load().locked).toBe(false)
    const second = await start(path)
    expect((await second.api.get(endpoint).set(headers).expect(200)).body.data.config).toEqual(legacy.config)
    await second.api.put(endpoint).set(headers).send(update(legacy, legacy.revision)).expect(422)
  })

  it('已有数据库损坏配置不回退、不覆盖，启动拒绝，运行中 GET 返回可见错误', async () => {
    const path = await databasePath()
    const { api } = await start(path)
    await api.put(endpoint).set(headers).send(update(draft())).expect(200)
    const db = new DatabaseSync(path)
    try { db.exec("UPDATE scenarios SET config_json = '{}'") } finally { db.close() }
    await api.get(endpoint).set(headers).expect(503)
    const resetFailure = await api.post('/api/v1/reset').set(headers).send({ confirm: true }).expect(503)
    expect(resetFailure.body.error.message).toContain('未执行全局重置')
    expect(() => new ScenarioSqliteStorage(path)).toThrow('场景数据库结构或数据无效')
    const check = new DatabaseSync(path, { readOnly: true })
    try { expect(check.prepare('SELECT config_json FROM scenarios').get().config_json).toBe('{}') } finally { check.close() }
  })

  it('真实 SQL 失败回滚，数据库仍保留完整旧场景', async () => {
    const path = await databasePath()
    const { api, storage } = await start(path)
    const saved = (await api.put(endpoint).set(headers).send(update(draft())).expect(200)).body.data
    const db = new DatabaseSync(path)
    try { db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON scenarios BEGIN SELECT RAISE(ABORT, 'test disk failure'); END") } finally { db.close() }
    await api.put(endpoint).set(headers).send(update(draft(), saved.revision)).expect(503)
    expect(storage.load()).toEqual(saved)
  })

  it('拒绝相对路径，避免错误工作目录创建另一份数据库', () => {
    expect(() => new ScenarioSqliteStorage('scenarios.db')).toThrow('绝对路径')
  })

  it.each(['identity', 'extensions', 'tie'] as const)('拒绝已有数据库的 %s 不一致，不覆盖原记录', async mutation => {
    const path = await databasePath()
    const { storage } = await start(path)
    storage.save(draft(), undefined)
    const db = new DatabaseSync(path)
    try {
      if (mutation === 'identity') db.exec("UPDATE scenarios SET name = '不匹配名称'")
      if (mutation === 'extensions') db.exec("UPDATE scenarios SET ui_extensions_json = '{}'")
      if (mutation === 'tie') db.exec("INSERT INTO scenarios SELECT 'SCN-OTHER', name, config_json, ui_extensions_json, revision FROM scenarios")
    } finally { db.close() }
    expect(() => storage.list()).toThrow()
  })

  it('拒绝数据库非递增修订号，事务回滚后仍可读取旧值', async () => {
    const { storage } = await start(await databasePath())
    const original = draft()
    storage.save(original, undefined)
    expect(() => storage.save(original, { id: original.config.scenario.id, revision: original.revision })).toThrow('修订号必须递增')
    expect(storage.load()).toEqual(original)
  })

  it('数据库记录被外部移除后 GET 返回空态，不静默使用旧内存或 Mock', async () => {
    const path = await databasePath()
    const { api } = await start(path)
    await api.put(endpoint).set(headers).send(update(draft())).expect(200)
    const db = new DatabaseSync(path)
    try { db.exec('DELETE FROM scenarios') } finally { db.close() }
    await api.get(endpoint).set(headers).expect(404)
    await api.get(endpoint).set(headers).expect(404)
  })

  it('空库的配置锁、校验、撤销、场景重置不能生成 Mock；显式导入可创建首个场景', async () => {
    const { api, storage } = await start(await databasePath())
    const projection = new ScenarioProjection(storage)
    expect(projection.setLocked('SCN-001', true).status).toBe(404)
    await api.post(`${endpoint}/validate`).set(headers).send({ config: draft().config }).expect(404)
    await api.post(`${endpoint}/undo`).set(headers).send({ expectedRevision: 0 }).expect(404)
    await api.post(`${endpoint}/reset`).set(headers).send({ expectedRevision: 0 }).expect(404)
    expect(storage.load()).toBeUndefined()
    const imported = await api.post('/api/v1/scenarios/import').set(headers).send({ items: [draft().config] }).expect(200)
    expect(imported.body.data.drafts[0].revision).toBe(1)
    expect(storage.load()).toEqual(imported.body.data.drafts[0])
  })

  it('数据库不可写时导入失败，原配置不被替换', async () => {
    const { api, storage } = await start(await databasePath())
    const original = draft()
    await api.put(endpoint).set(headers).send(update(original)).expect(200)
    vi.spyOn(storage, 'save').mockImplementationOnce(() => { throw new Error('blocked') })
    original.config.scenario.id = 'SCN-FAILED'
    await api.post('/api/v1/scenarios/import').set(headers).send({ items: [original.config] }).expect(503)
    expect((await api.get(endpoint).set(headers).expect(200)).body.data.config.scenario.id).toBe('SCN-001')
  })
})

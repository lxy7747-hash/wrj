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

function update(value: ScenarioDraft) {
  return { config: value.config, uiExtensions: value.uiExtensions }
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
    await api.put(endpoint).set(headers).send(update(valid)).expect(422)
    await api.put(endpoint).set({ ...headers, 'X-Demo-Role': 'UNKNOWN' }).send(update(draft())).expect(403)
    expect(storage.load()).toEqual(saved)
  })

  it('数据库事务失败返回稳定错误且不泄露路径，撤销栈不被失败保存污染', async () => {
    const { api, storage } = await start(await databasePath())
    const original = draft()
    const first = structuredClone(original)
    first.config.scenario.name = '第一次保存'
    await api.put(endpoint).set(headers).send(update(original)).expect(200)
    await api.put(endpoint).set(headers).send(update(first)).expect(200)
    const failedWrite = vi.spyOn(storage, 'save').mockImplementationOnce(() => { throw new Error('secret.db disk failure') })
    const failed = await api.put(endpoint).set(headers).send(update(original)).expect(503)
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
    await second.api.put(endpoint).set(headers).send(update(original)).expect(409)
    const refreshed = (await second.api.get(endpoint).set(headers).expect(200)).body.data as ScenarioDraft
    refreshed.config.scenario.name = '重新加载后修改'
    await second.api.put(endpoint).set(headers).send(update(refreshed)).expect(200)
    expect(first.storage.load().config.scenario.name).toBe('重新加载后修改')
  })

  it('导入新编号后默认入口和重启恢复当前工作场景，同时保留原编号记录', async () => {
    const path = await databasePath()
    const first = await start(path)
    const original = draft()
    await first.api.put(endpoint).set(headers).send(update(original)).expect(200)
    original.config.scenario.id = 'SCN-IMPORTED'
    const imported = (await first.api.post('/api/v1/scenarios/import').set(headers).send({ items: [original.config] }).expect(200)).body.data.drafts[0]
    expect((await first.api.get(endpoint).set(headers).expect(200)).body.data).toEqual(imported)
    await first.stop()
    const second = await start(path)
    expect((await second.api.get(endpoint).set(headers).expect(200)).body.data).toEqual(imported)
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
    await second.api.put(endpoint).set(headers).send(update(legacy)).expect(422)
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
    await api.put(endpoint).set(headers).send(update(draft())).expect(503)
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
    expect(() => storage.load()).toThrow()
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

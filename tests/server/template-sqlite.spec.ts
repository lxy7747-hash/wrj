// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioDraft } from '../../src/contracts/domain-models'

const storagePath = '../../server/local/' + 'template-sqlite.js'
const scenarioPath = '../../server/local/' + 'scenario-sqlite.js'
const appPath = '../../server/' + 'app.js'
const projectionPath = '../../server/scenarios/' + 'projection.js'
const templatePath = '../../server/templates/' + 'projection.js'
const { TemplateSqliteStorage } = await import(storagePath)
const { ScenarioSqliteStorage } = await import(scenarioPath)
const { createMockServer } = await import(appPath)
const { ScenarioProjection } = await import(projectionPath)
const { TemplateProjection } = await import(templatePath)
const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { DatabaseSync } = await import('node:' + 'sqlite')
const { default: request } = await import('super' + 'test')
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
const operator = { ...headers, 'X-Demo-Role': 'OPERATOR' }
const resources: Array<() => Promise<void> | void> = []
let directory = ''

async function path() {
  directory ||= await mkdtemp(join(tmpdir(), 'wrj-template-sqlite-'))
  return join(directory, 'test.db') as string
}

async function start(file: string) {
  const scenarios = new ScenarioSqliteStorage(file)
  const templates = new TemplateSqliteStorage(file)
  const server = createMockServer({ scenarioStorage: scenarios, templateStorage: templates })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await server.close()
    templates.close()
    scenarios.close()
  }
  resources.push(close)
  return { api, templates, scenarios, close }
}

function source(): ScenarioDraft {
  const draft = new ScenarioProjection().get('SCN-001').data as ScenarioDraft
  draft.uiExtensions.jammers[0]!.elevation = 30
  draft.uiExtensions.sensors[0]!.probability = 0.37
  return draft
}

function body() {
  const draft = source()
  return { name: '完整模板', config: draft.config, uiExtensions: draft.uiExtensions }
}

async function confirmation(api: any, id: string) {
  const created = await api.post('/api/v1/confirmations').set(headers).send({ action: 'OFFICIAL_TEMPLATE_DELETE', objectId: id }).expect(201)
  const confirmationId = created.body.data.confirmationId
  await api.post(`/api/v1/confirmations/${confirmationId}`).set(headers).send({ confirm: true }).expect(200)
  return confirmationId as string
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of resources.reverse()) await close()
  resources.length = 0
  // 仅清理本测试创建的临时数据库，绝不访问用户数据目录。
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

describe('SQLite 模板持久化', () => {
  it('旧模板退役字段在读取、保存和应用时清理，不修改输入或传感器方向', async () => {
    const file = await path()
    const server = await start(file)
    const input = body()
    const created = (await server.api.post('/api/v1/templates').set(headers).send(input).expect(201)).body.data
    const addLegacyFields = (value: typeof input) => {
      Object.assign(value.config.scenario.environment, { temperatureC: null, humidityPercent: 101, rainLossDbPerKm: -1 })
      value.config.jammers.forEach(jammer => Object.assign(jammer, { autoDetect: 'invalid' }))
      value.uiExtensions.jammers.forEach(jammer => Object.assign(jammer, { duration: -1 }))
    }
    const legacy = structuredClone(input)
    addLegacyFields(legacy)
    const raw = new DatabaseSync(file)
    raw.prepare('UPDATE scenario_templates SET config_json = ?, ui_extensions_json = ? WHERE id = ?')
      .run(JSON.stringify(legacy.config), JSON.stringify(legacy.uiExtensions), created.templateId)
    raw.close()
    const reloaded = (await server.api.get('/api/v1/templates/' + created.templateId).set(headers).expect(200)).body.data
    expect(reloaded).toEqual(created)
    const saved = (await server.api.put('/api/v1/templates/' + created.templateId).set(headers).send(legacy).expect(200)).body.data
    expect(saved).toMatchObject({ config: input.config, uiExtensions: input.uiExtensions, version: '2' })
    const check = new DatabaseSync(file)
    const row = check.prepare('SELECT config_json, ui_extensions_json FROM scenario_templates WHERE id = ?').get(created.templateId)
    check.close()
    expect(JSON.parse(row.config_json)).toEqual(input.config)
    expect(JSON.parse(row.ui_extensions_json)).toEqual(input.uiExtensions)
    const copied = (await server.api.post('/api/v1/templates/' + created.templateId + '/copy').set(headers).send({ name: '退役字段清理后副本' }).expect(201)).body.data
    expect(copied.uiExtensions).toEqual(input.uiExtensions)
    expect(copied.config.scenario.environment).toEqual(input.config.scenario.environment)
    expect(copied.config.jammers).toEqual(input.config.jammers)
    // 无 SQLite 的模板流程也须返回干净数据，且不能修改调用者对象。
    const projection = new TemplateProjection()
    const result = projection.create(legacy)
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ config: input.config, uiExtensions: input.uiExtensions })
    expect(legacy.config.scenario.environment).toHaveProperty('humidityPercent', 101)
    expect(legacy.uiExtensions.jammers[0]).toHaveProperty('duration', -1)
  })

  it('空库无默认模板，另存不改原场景；重启、复制、再编辑场景均保持模板完整独立', async () => {
    const file = await path()
    const first = await start(file)
    expect((await first.api.get('/api/v1/templates').set(headers).expect(200)).body.data).toEqual([])
    const initial = source()
    const saved = (await first.api.put('/api/v1/scenarios/SCN-001').set(headers).send({ config: initial.config, uiExtensions: initial.uiExtensions, expectedRevision: 0 }).expect(200)).body.data
    const template = (await first.api.post('/api/v1/templates').set(headers).send(body()).expect(201)).body.data
    expect(template).toMatchObject({ version: '1', uiExtensions: initial.uiExtensions, config: initial.config })
    expect(first.scenarios.load()).toEqual(saved)
    await first.close()
    const second = await start(file)
    expect((await second.api.get(`/api/v1/templates/${template.templateId}`).set(operator).expect(200)).body.data).toEqual(template)
    const applied = (await second.api.post(`/api/v1/templates/${template.templateId}/copy`).set(operator).send({ name: '从模板创建' }).expect(201)).body.data
    expect(applied.uiExtensions).toEqual(initial.uiExtensions)
    expect(applied.config.scenario.name).toBe('从模板创建')
    applied.config.scenario.name = '只修改场景'
    await second.api.put('/api/v1/scenarios/SCN-001').set(headers).send({ config: applied.config, uiExtensions: applied.uiExtensions, expectedRevision: applied.revision }).expect(200)
    expect((await second.api.get(`/api/v1/templates/${template.templateId}`).set(headers).expect(200)).body.data).toEqual(template)
    await second.api.post('/api/v1/reset').set(headers).send({ confirm: true }).expect(200)
    expect(second.templates.load()).toEqual([template])
  })

  it('更新递增版本，重名/非法扩展/操作员写入拒绝且不破坏旧模板', async () => {
    const server = await start(await path())
    await server.api.post('/api/v1/templates').set(operator).send(body()).expect(403)
    const created = (await server.api.post('/api/v1/templates').set(headers).send(body()).expect(201)).body.data
    await server.api.post('/api/v1/templates').set(headers).send(body()).expect(409)
    const invalid = body()
    invalid.uiExtensions.jammers[0]!.jammerId = 'UNKNOWN'
    const rejected = await server.api.put(`/api/v1/templates/${created.templateId}`).set(headers).send(invalid).expect(422)
    expect(rejected.body.error.fieldPath).toContain('uiExtensions')
    expect(server.templates.load()).toEqual([created])
    const updated = (await server.api.put(`/api/v1/templates/${created.templateId}`).set(headers).send({ ...body(), name: '更新模板' }).expect(200)).body.data
    expect(updated.version).toBe('2')
    await server.close()
    const reopened = await start(await path())
    expect(reopened.templates.load()).toEqual([updated])
  })

  it('旧模板无扩展仍可导入应用，删除需要一次性确认并在重启后保持删除', async () => {
    const file = await path()
    const server = await start(file)
    const { uiExtensions: _, ...legacy } = body()
    const template = (await server.api.post('/api/v1/templates').set(headers).send(legacy).expect(201)).body.data
    expect(template.uiExtensions).toBeUndefined()
    const copied = await server.api.post(`/api/v1/templates/${template.templateId}/copy`).set(operator).send({ name: '旧模板副本' }).expect(201)
    expect(copied.body.data.uiExtensions.jammers).toHaveLength(legacy.config.jammers.length)
    const endpoint = `/api/v1/templates/${template.templateId}`
    await server.api.delete(endpoint).set(operator).expect(403)
    await server.api.delete(endpoint).set(headers).expect(428)
    const id = await confirmation(server.api, template.templateId)
    await server.api.delete(endpoint).set({ ...headers, 'X-Confirmation-Id': id }).expect(200)
    await server.api.delete(endpoint).set({ ...headers, 'X-Confirmation-Id': id }).expect(404)
    await server.close()
    const reopened = await start(file)
    expect(reopened.templates.load()).toEqual([])
    expect(reopened.scenarios.load()).toBeDefined()
  })

  it('数据库故障不假报成功、不丢失旧模板；损坏扩展拒绝加载', async () => {
    const file = await path()
    const server = await start(file)
    const template = (await server.api.post('/api/v1/templates').set(headers).send(body()).expect(201)).body.data
    vi.spyOn(server.templates, 'save').mockImplementation(() => { throw new Error('private-db-path') })
    const failed = await server.api.put(`/api/v1/templates/${template.templateId}`).set(headers).send({ ...body(), name: '不能保存' }).expect(503)
    expect(JSON.stringify(failed.body)).not.toContain('private-db-path')
    expect(server.templates.load()).toEqual([template])
    vi.restoreAllMocks()
    const db = new DatabaseSync(file)
    db.prepare('UPDATE scenario_templates SET ui_extensions_json = ?').run('{"jammers":[],"sensors":[]}')
    db.close()
    await server.api.get('/api/v1/templates').set(headers).expect(503)
    await server.api.get(`/api/v1/templates/${template.templateId}`).set(headers).expect(503)
    await server.close()
    expect(() => new TemplateSqliteStorage(file)).toThrow('模板数据库结构或数据无效')
  })

  it('跨连接旧版本、重复名和已引用模板不能覆盖或删除', async () => {
    const file = await path()
    const first = new TemplateSqliteStorage(file)
    const second = new TemplateSqliteStorage(file)
    resources.push(() => first.close(), () => second.close())
    const projection = new TemplateProjection(first)
    const template = projection.create(body()).data
    expect(second.save({ ...template, name: '另一连接', version: '2' }, '1')).toBe(true)
    expect(first.save({ ...template, version: '2' }, '1')).toBe(false)
    expect(first.delete(template.templateId, '1')).toBe(false)
    expect(first.save({ ...template, templateId: 'OTHER', name: '另一连接' })).toBe(false)
    expect(second.save({ ...template, version: '3', referenceCount: 1 }, '2')).toBe(true)
    expect(projection.delete(template.templateId)).toMatchObject({ ok: false, status: 409 })
    expect(first.delete(template.templateId, '3')).toBe(false)
  })
})


it('旧模板缺少运动时刻和方向时读取补齐，后续保存及应用成功', async () => {
  const file = await path()
  const server = await start(file)
  const input = body()
  const created = (await server.api.post('/api/v1/templates').set(headers).send(input).expect(201)).body.data
  for (const platform of input.config.platforms) for (const point of platform.waypoints) Reflect.deleteProperty(point, 'arrivalTime')
  for (const extension of input.uiExtensions.jammers) Reflect.deleteProperty(extension, 'direction')
  const raw = new DatabaseSync(file)
  raw.prepare('UPDATE scenario_templates SET config_json = ?, ui_extensions_json = ? WHERE id = ?')
    .run(JSON.stringify(input.config), JSON.stringify(input.uiExtensions), created.templateId)
  raw.close()
  const restored = (await server.api.get('/api/v1/templates/' + created.templateId).set(headers).expect(200)).body.data
  expect(restored.config.platforms[3].waypoints[0].arrivalTime).toBeGreaterThan(0)
  expect(restored.uiExtensions.jammers[0].direction).toBe(0)
  await server.api.put('/api/v1/templates/' + created.templateId).set(headers)
    .send({ name: restored.name, config: restored.config, uiExtensions: restored.uiExtensions }).expect(200)
  const copied = (await server.api.post('/api/v1/templates/' + created.templateId + '/copy').set(headers).send({ name: '兼容模板副本' }).expect(201)).body.data
  expect(copied.config).toEqual({ ...restored.config, scenario: { ...restored.config.scenario, name: '兼容模板副本' } })
  expect(copied.uiExtensions).toEqual(restored.uiExtensions)
})

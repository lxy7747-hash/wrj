// @vitest-environment node
import { expect, it } from 'vitest'
import { createTemplateScenario } from '../fixtures/template-scenario'
import { createScenarioSnapshot, parseScenarioSnapshot } from '../../src/features/scenarios/scenario-snapshot'
import { readDeviceParameters } from '../../src/features/scenarios/template-defaults'
import { withScenarioBasicDefaults } from '../../src/features/scenarios/scenario-basic'
const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { once } = await import('node:' + 'events')
const { default: request } = await import('super' + 'test')
const { createMockServer } = await import('../../server/' + 'app')
const { ScenarioSqliteStorage } = await import('../../server/local/' + 'scenario-sqlite')
const { TemplateSqliteStorage } = await import('../../server/local/' + 'template-sqlite')

it('P5 场景JSON导入、SQLite重载及模板HTTP往返保留全部新字段', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-p5-roundtrip-'))
  const scenarios = new ScenarioSqliteStorage(join(directory, 'scenarios.db'))
  const templates = new TemplateSqliteStorage(join(directory, 'templates.db'))
  const server = createMockServer({ port: 0, scenarioStorage: scenarios, templateStorage: templates })
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
    const draft = createTemplateScenario()
    draft.config.scenario.id = 'SCN-P5-ROUNDTRIP'
    draft.config.scenario.realtime = false
    draft.config.deviceParameters = readDeviceParameters(draft.config)
    draft.config.deviceParameters.ports!.MISSION_UAV_PLATFORM!.microwave_link!.noiseFigureDb = 4
    Object.assign(draft.config.deviceParameters.ports!.MISSION_UAV_PLATFORM!.microwave_link!, { eirpDbw: -5, gtDbk: -10 })
    draft.config.linkSettings!.messageIntervalS = 7
    draft.config.linkSettings!.linkCalc!.jammingRangeKm = 31
    draft.config = withScenarioBasicDefaults(draft.config)
    const snapshot = JSON.parse(JSON.stringify(createScenarioSnapshot(draft)))
    expect(parseScenarioSnapshot(snapshot)?.config).toEqual(draft.config)
    const imported = await api.post('/api/v1/scenarios/import').set(headers).send({ items: [snapshot] }).expect(200)
    expect(imported.body.data.drafts[0].config).toEqual(draft.config)
    expect(scenarios.load(draft.config.scenario.id)?.config).toEqual(draft.config)
    const loaded = await api.get(`/api/v1/scenarios/${draft.config.scenario.id}`).set(headers).expect(200)
    expect(loaded.body.data.config).toEqual(draft.config)
    const template = await api.post('/api/v1/templates').set(headers).send({ name: 'P5新字段往返', config: loaded.body.data.config, uiExtensions: draft.uiExtensions }).expect(201)
    const reread = await api.get(`/api/v1/templates/${template.body.data.templateId}`).set(headers).expect(200)
    expect(reread.body.data.config).toEqual(draft.config)
    expect(templates.load()[0]?.config).toEqual(draft.config)
    expect(draft.config.platforms.some(platform => platform.loiterWaypoints && platform.returnPlan)).toBe(true)
    expect(draft.config.jammers.every(jammer => jammer.detectionMinimumRange === 1000)).toBe(true)
  } finally {
    await server.close()
    templates.close()
    scenarios.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('场景导入独立校验非负整数文件版本和 x.x 配置版本，按 1.0 保存', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-scenario-import-versions-'))
  const storage = new ScenarioSqliteStorage(join(directory, 'scenarios.db'))
  const server = createMockServer({ port: 0, scenarioStorage: storage })
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
    const draft = createTemplateScenario()
    const scenarioId = 'SCN-IMPORT-VERSIONS'
    draft.config.scenario.id = scenarioId
    draft.config = withScenarioBasicDefaults(draft.config)
    const path = `/api/v1/scenarios/${scenarioId}`
    const v1 = createScenarioSnapshot(draft)
    const configV2 = { ...v1.config, schemaVersion: '2.0' }
    const v2 = { ...v1, version: 2, config: configV2 }
    const arbitrary = { ...v1, version: 17, config: { ...v1.config, schemaVersion: '003.5' } }
    const accepted = [v1.config, v1, configV2, { ...v1, config: configV2 }, v2, { ...v1, version: 2 },
      { ...v1.config, schemaVersion: '23.5' }, { ...v1, version: 0, config: { ...v1.config, schemaVersion: '0.0' } }, arbitrary]
    for (const [index, item] of accepted.entries()) {
      const response = await api.post('/api/v1/scenarios/import').set(headers).send({ items: [item] }).expect(200)
      const saved = response.body.data.drafts[0]
      expect(saved.revision).toBe(index + 1)
      expect(saved.config).toEqual(draft.config)
    }
    const original = (await api.get(path).set(headers).expect(200)).body.data
    expect(original.uiExtensions).toEqual(draft.uiExtensions)
    expect(storage.load(scenarioId)).toEqual(original)
    expect(createScenarioSnapshot(original)).toEqual(v1)
    expect(arbitrary.config.schemaVersion).toBe('003.5')

    const badImports = [
      { item: { ...arbitrary, config: { ...v1.config, schemaVersion: null } }, field: 'items[0].config.schemaVersion' },
      { item: { ...arbitrary, config: { ...v1.config, schemaVersion: 2.5 } }, field: 'items[0].config.schemaVersion' },
      { item: { ...arbitrary, config: { ...v1.config, schemaVersion: '-2.5' } }, field: 'items[0].config.schemaVersion' },
      { item: { ...v1.config, schemaVersion: 'v3' }, field: 'items[0].schemaVersion' },
      { item: { ...arbitrary, version: -1 }, field: 'items[0]' },
      { item: { ...arbitrary, version: 2.5 }, field: 'items[0]' },
      { item: { ...arbitrary, version: '3' }, field: 'items[0]' },
      { item: { ...arbitrary, config: { ...arbitrary.config, scenario: { ...arbitrary.config.scenario, name: '' } } }, field: 'items[0].config.scenario.name' },
      { item: { ...arbitrary, uiExtensions: null }, field: 'items[0].uiExtensions' },
    ]
    for (const { item, field } of badImports) {
      const response = await api.post('/api/v1/scenarios/import').set(headers).send({ items: [item] }).expect(422)
      expect(response.body.error.fieldPath).toBe(field)
      expect((await api.get(path).set(headers).expect(200)).body.data).toEqual(original)
    }
    await api.put(path).set(headers).send({ config: configV2, uiExtensions: v2.uiExtensions, expectedRevision: original.revision }).expect(422)
    expect(storage.load(scenarioId)).toEqual(original)
  } finally {
    await server.close()
    storage.close()
    await rm(directory, { recursive: true, force: true })
  }
})

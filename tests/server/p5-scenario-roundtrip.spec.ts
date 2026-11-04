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

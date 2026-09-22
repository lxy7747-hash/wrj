// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ScenarioDraft } from '../../src/contracts/domain-models'
const { buildMissionPackage, MissionGenerationError } = await import('../../server/scripts/' + 'mission-generator.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { ScriptProjection } = await import('../../server/scripts/' + 'projection.js')
const { writeScriptText } = await import('../../server/local/' + 'script-file.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const { mkdtemp, readFile, rm, readdir, writeFile } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join, dirname } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')

function minimalDraft(): ScenarioDraft {
  const draft: ScenarioDraft = new ScenarioProjection().get('SCN-001').data
  const config = draft.config
  config.platforms = config.platforms.filter(p => ['CMD-01', 'AIR-01'].includes(p.id))
  config.links = [{ ...config.links[0]!, id: 'L-A', enabled: true, sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01' }]
  for (const p of config.platforms) {
    p.waypoints = []
    p.linkIds = ['L-A']
    p.sensorIds = []
    p.jammerIds = []
  }
  config.jammers = []
  config.sensors = []
  config.informationDemand = [{ ...config.informationDemand[0]!, linkId: 'L-A', direction: 'FORWARD',
    sourcePlatformId: 'CMD-01', destinationPlatformIds: ['AIR-01'], enabled: false }]
  config.scenario.environment.rainLossDbPerKm = 0.08
  config.output.writeInterval = 2
  draft.uiExtensions = { jammers: [], sensors: [] }
  delete config.linkSettings
  return draft
}

describe('候选 AFSIM 节点与独立微波设备生成', () => {
  it('按输入生成节点、物理单位和两端独立设备，引用闭合且不改草稿', () => {
    const draft = minimalDraft()
    const original = structuredClone(draft)
    const { files, manifest } = buildMissionPackage(draft)
    expect(draft).toEqual(original)
    expect(files['mission.txt']).toContain('include_once platforms.txt')
    expect(files['mission.txt']).toContain('include_once observers.txt')
    expect(files['mission.txt']).toContain(`end_time ${draft.config.scenario.duration} sec`)
    for (const platform of draft.config.platforms) {
      expect(files['mission.txt']).toContain(`platform ${platform.id} `)
      expect(files['mission.txt']).toContain(`position ${platform.initialPosition.latitude}n ${platform.initialPosition.longitude}e`)
      expect(files['mission.txt']).toContain(`altitude ${platform.initialPosition.altitude} m`)
    }
    const text = files['platforms.txt']
    expect(text.match(/  comm /g)).toHaveLength(2)
    expect(text.match(/frequency 4500 MHz/g)).toHaveLength(4)
    expect(text.match(/bandwidth 20 MHz/g)).toHaveLength(4)
    expect(text.match(/power 100 W/g)).toHaveLength(2)
    expect(text.match(/transfer_rate 20 mbits\/sec/g)).toHaveLength(2)
    expect(text).toContain('peak_gain 18 dB')
    expect(text).toContain('peak_gain 12 dB')
    expect(text).toContain('update_interval 2 sec')
    const [mapping] = manifest.devices
    expect(mapping.source.deviceId).not.toBe(mapping.target.deviceId)
    expect(text.match(new RegExp(`network_name ${mapping.network}`, 'g'))).toHaveLength(2)
    expect(files['observers.txt']).toContain('TIME,NAME,LON,LAT,ALT,SPEED,HEADING')
    expect(files['observers.txt']).toContain('aPlatform.Name()')
    expect(manifest.engineValidated).toBe(false)
    expect(files['README.txt']).toContain('不是完整业务仿真脚本')
    expect(files['README.txt']).toContain('未映射为引擎行为')
    expect(JSON.parse(files['input.json'])).toEqual(draft)
    for (const forbidden of ['side blue', 'noise_figure', 'SendMessage', '17:30', 'H:\\', 'scenario "']) {
      expect(files['mission.txt'] + text + files['observers.txt']).not.toContain(forbidden)
    }
  })

  it('同节点多链路设备/网络互不复用，参数不相互覆盖，标点不同编号不碰撞', () => {
    const draft = minimalDraft()
    draft.config.links.push({ ...draft.config.links[0]!, id: 'L_A', frequency: 8000, txPower: 20 })
    draft.config.platforms.forEach(p => p.linkIds.push('L_A'))
    const generated = buildMissionPackage(draft)
    const mappings = generated.manifest.devices
    expect(new Set(mappings.flatMap((m: { source: { deviceId: string }; target: { deviceId: string } }) => [m.source.deviceId, m.target.deviceId])).size).toBe(4)
    expect(mappings[0].network).not.toBe(mappings[1].network)
    expect(generated.files['platforms.txt']).toContain('frequency 8000 MHz')
    expect(generated.files['platforms.txt']).toContain('frequency 4500 MHz')
    draft.config.links[0]!.enabled = false
    draft.config.informationDemand[0]!.enabled = true
    const stopped = buildMissionPackage(draft)
    expect(stopped.manifest.devices).toEqual([mappings[1]])
    expect(stopped.manifest.excludedLinkIds).toEqual(['L-A'])
    expect(stopped.files['platforms.txt']).not.toContain(mappings[0].source.deviceId)
    expect(draft.config.informationDemand).toHaveLength(1)
    draft.config.links[0]!.enabled = true
    draft.config.informationDemand[0]!.enabled = false
    expect(buildMissionPackage(draft)).toEqual(generated)
  })

  const cases: Array<[string, (d: ScenarioDraft) => void, string]> = [
    ['业务未接通', d => { d.config.informationDemand[0]!.enabled = true }, 'informationDemand[0]'],
    ['平台未接通', d => { d.config.platforms[1]!.type = 'GROUND_CLUSTER_COMMAND_NODE'; d.config.platforms[1]!.category = 'ground' }, 'platforms[1].type'],
    ['航点未接通', d => { d.config.platforms[1]!.waypoints = [{ ...d.config.platforms[1]!.initialPosition, speed: 10, arrivalTime: 10 }] }, 'platforms[1].waypoints'],
    ['非微波链路', d => { d.config.links[0]!.type = 'DATALINK' }, 'links[0].type'],
    ['编码未接通', d => { d.config.links[0]!.coding = 'LDPC' }, 'links[0].coding'],
    ['增益修正未接通', d => { d.config.links[0]!.antennaGainCorrectionDb = 1 }, 'links[0].antennaGainCorrectionDb'],
    ['非法频率', d => { d.config.links[0]!.frequency = 0 }, 'links[0].frequency'],
    ['脚本注入', d => {
      const id = 'CMD\ninclude_once bad.txt'
      d.config.platforms[0]!.id = id
      d.config.links[0]!.sourcePlatformId = id
      d.config.informationDemand[0]!.sourcePlatformId = id
    }, 'platforms[0].id'],
  ]
  it.each(cases)('%s 阻断生成且提供字段，不静默省略', (_, mutate, fieldPath) => {
    const draft = minimalDraft()
    mutate(draft)
    expect(() => buildMissionPackage(draft)).toThrow(MissionGenerationError)
    expect(() => buildMissionPackage(draft)).toThrow(fieldPath)
  })

  it('关闭事件输出时不写事件配置；无链路仍能生成节点且不伪造设备', () => {
    const draft = minimalDraft()
    draft.config.links[0]!.enabled = false
    draft.config.output.eventsEnabled = false
    const { files, manifest } = buildMissionPackage(draft)
    expect(files['mission.txt']).not.toContain('csv_event_output')
    expect(files['platforms.txt']).not.toContain('  comm ')
    expect(manifest.devices).toEqual([])
  })

  it('独占目录打包，保留预览与映射；重复生成不覆盖，不创建实际 CSV', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-'))
    try {
      const draft = minimalDraft()
      const script = new ScriptProjection().preview(draft)
      const first = await writeScriptText(root, script, draft.revision, draft)
      const second = await writeScriptText(root, script, draft.revision, draft)
      expect(first).not.toBe(second)
      expect(first.endsWith('mission.txt')).toBe(true)
      expect(await readFile(first, 'utf8')).toBe(await readFile(second, 'utf8'))
      expect(await readdir(join(dirname(first), 'output'))).toEqual([])
      expect(await readFile(join(dirname(first), `SCN-001-r${draft.revision}.txt`), 'utf8')).toContain(script.preview)
      const manifest = JSON.parse(await readFile(join(dirname(first), 'mapping.json'), 'utf8'))
      expect(manifest).toMatchObject({ scenarioId: 'SCN-001', revision: draft.revision, engineValidated: false })
      for (const dependency of ['platforms.txt', 'observers.txt', 'input.json', 'README.txt']) {
        expect((await readFile(join(dirname(first), dependency), 'utf8')).length).toBeGreaterThan(0)
      }
      const directories = await readdir(root)
      draft.config.informationDemand[0]!.enabled = true
      await expect(writeScriptText(root, script, draft.revision, draft)).rejects.toThrow('informationDemand[0]')
      expect(await readdir(root)).toEqual(directories)
      await writeFile(join(root, 'keep.txt'), '保留')
      draft.config.informationDemand[0]!.enabled = false
      await expect(writeScriptText(root, { ...script, scenarioId: 'x'.repeat(300) }, draft.revision, draft)).rejects.toThrow()
      expect((await readdir(root)).sort()).toEqual([...directories, 'keep.txt'].sort())
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('正式 API 从服务端草稿生成；未支持字段返回 422，保存数据不丢失', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-mission-api-'))
    const server = createMockServer({ writeScriptText: (script: unknown, revision: number, draft: ScenarioDraft) => writeScriptText(root, script, revision, draft) })
    const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
    try {
      if (!server.httpServer.listening) await once(server.httpServer, 'listening')
      const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
      const draft = minimalDraft()
      const saved = (await api.put('/api/v1/scenarios/SCN-001').set(headers)
        .send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: draft.revision }).expect(200)).body.data
      const context = (await api.post('/api/v1/confirmations').set(headers)
        .send({ action: 'SCENARIO_WARNING_CONTINUE', objectId: 'SCN-001' }).expect(201)).body.data
      await api.post(`/api/v1/confirmations/${context.confirmationId}`).set(headers).send({ confirm: true }).expect(200)
      const script = (await api.post('/api/v1/scripts/preview').set(headers)
        .send({ scenarioId: 'SCN-001', warningConfirmationId: context.confirmationId }).expect(200)).body.data
      const result = (await api.post(`/api/v1/scripts/${script.scriptId}/local-file`).set(headers)
        .send({ checksum: script.checksum }).expect(200)).body.data
      expect(result.path.endsWith('mission.txt')).toBe(true)
      expect(JSON.parse(await readFile(join(dirname(result.path), 'input.json'), 'utf8'))).toEqual(saved)
      saved.config.informationDemand[0].enabled = true
      const latest = (await api.put('/api/v1/scenarios/SCN-001').set(headers)
        .send({ config: saved.config, uiExtensions: saved.uiExtensions, expectedRevision: saved.revision }).expect(200)).body.data
      const confirm = (await api.post('/api/v1/confirmations').set(headers)
        .send({ action: 'SCENARIO_WARNING_CONTINUE', objectId: 'SCN-001' }).expect(201)).body.data
      await api.post(`/api/v1/confirmations/${confirm.confirmationId}`).set(headers).send({ confirm: true }).expect(200)
      const next = (await api.post('/api/v1/scripts/preview').set(headers)
        .send({ scenarioId: 'SCN-001', warningConfirmationId: confirm.confirmationId }).expect(200)).body.data
      const failure = (await api.post(`/api/v1/scripts/${next.scriptId}/local-file`).set(headers)
        .send({ checksum: next.checksum }).expect(422)).body
      expect(failure.error).toMatchObject({ code: 'VALIDATION_FAILED', fieldPath: 'informationDemand[0]' })
      expect(failure.data).toBeUndefined()
      expect((await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data).toEqual(latest)
      expect(await readdir(root)).toHaveLength(1)
    } finally {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

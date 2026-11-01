// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Link, ScenarioDraft } from '../../src/contracts/domain-models'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'

const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { buildMissionPackage } = await import('../../server/scripts/' + 'mission-generator.js')
const { LocalMissionRunner } = await import('../../server/local/' + 'mission-runner.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const { once } = await import('node:' + 'events')
const { mkdtemp, readFile, rm } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join, dirname } = await import('node:' + 'path')
const { env } = await import('node:' + 'process')

// 合成验收参数，仅用于测试；新建/编辑激光设备不会填入这些值。
const optical: NonNullable<Link['laser']> = {
  txApertureDiameterM: 0.1, rxApertureDiameterM: 0.1, pulseWidthS: 1e-8, modulation: 'OOK',
}
function laserDraft(): ScenarioDraft {
  const draft: ScenarioDraft = new ScenarioProjection().get('SCN-001').data
  const config = draft.config
  config.platforms = config.platforms.filter(platform => ['CMD-01', 'AIR-01'].includes(platform.id))
  config.platforms.forEach((platform, index) => {
    platform.waypoints = []; platform.sensorIds = []; platform.jammerIds = []; platform.linkIds = ['L-OPTICAL']
    platform.initialPosition = { longitude: 119.5 + index * 0.00001, latitude: 24.9, altitude: 10 }
  })
  config.links = [{ ...config.links[0]!, id: 'L-OPTICAL', type: 'LASER', enabled: true, direction: 'FORWARD',
    sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', frequency: 299792458 / 1.55e-6 / 1e6,
    bandwidth: 1000, txPower: 1, dataRate: 1, laser: { ...optical } }]
  config.jammers = []; config.sensors = []
  config.informationDemand = [{ ...config.informationDemand[0]!, linkId: 'L-OPTICAL', direction: 'FORWARD',
    sourcePlatformId: 'CMD-01', destinationPlatformIds: ['AIR-01'], informationType: '态势信息',
    enabled: true, frequencyHz: 1, volumeMb: 0.000001 }]
  config.scenario.duration = 2
  config.scenario.timeStep = 1
  config.output.linkQualityEnabled = false; config.output.linkSwitchEnabled = false
  config.output.eventsEnabled = true
  delete config.linkSettings
  draft.uiExtensions = { jammers: [], sensors: [] }
  return draft
}

describe('激光配置与真实专用设备生成', () => {
  it('旧激光配置可读取，启用写入和生成必须补齐光学参数；停用不生成', () => {
    const draft = laserDraft()
    delete draft.config.links[0]!.laser
    const original = structuredClone(draft)
    expect(inspectScenarioConfig(draft.config).result.valid).toBe(true)
    expect(inspectScenarioConfig(draft.config, 'write').result.errors).toContainEqual(expect.objectContaining({
      code: 'LASER_PARAMETERS_REQUIRED', fieldPath: 'links[0].laser',
    }))
    expect(() => buildMissionPackage(draft)).toThrow('links[0].laser')
    expect(draft).toEqual(original)
    draft.config.links[0]!.enabled = false
    expect(inspectScenarioConfig(draft.config, 'write').result.valid).toBe(true)
    expect(buildMissionPackage(draft).manifest.devices).toEqual([])
  })

  it.each([
    ['txApertureDiameterM', 0], ['txApertureDiameterM', -1], ['rxApertureDiameterM', NaN],
    ['rxApertureDiameterM', Infinity], ['pulseWidthS', 0], ['pulseWidthS', -1],
    ['pulseWidthS', '1e-8'], ['modulation', 'QPSK'], ['modulation', ['OOK']], ['extra', 1],
  ])('拒绝光学非法字段 %s=%s 且不修改原配置', (key, value) => {
    const draft = laserDraft()
    Object.assign(draft.config.links[0]!.laser!, { [key]: value })
    const original = structuredClone(draft)
    expect(inspectScenarioConfig(draft.config).result.valid).toBe(false)
    expect(inspectScenarioConfig(draft.config, 'write').result.errors.some(issue => issue.fieldPath.startsWith('links[0].laser'))).toBe(true)
    expect(() => buildMissionPackage(draft)).toThrow('links[0].laser')
    expect(draft).toEqual(original)
  })

  it.each([null, [], {}, { ...optical, pulseWidthS: undefined }])('拒绝不完整或非对象光学参数 %j', value => {
    const draft = laserDraft()
    Object.assign(draft.config.links[0]!, { laser: value })
    expect(inspectScenarioConfig(draft.config).result.valid).toBe(false)
  })

  it('仅激光可带光学配置，激光发射功率和介质速率必须为正', () => {
    const draft = laserDraft()
    draft.config.links[0]!.type = 'MICROWAVE'
    expect(inspectScenarioConfig(draft.config).result.errors).toContainEqual(expect.objectContaining({ code: 'LASER_TYPE_INVALID' }))
    draft.config.links[0]!.type = 'LASER'
    draft.config.links[0]!.txPower = 0
    draft.config.links[0]!.dataRate = 0
    expect(inspectScenarioConfig(draft.config, 'write').result.errors.map(issue => issue.fieldPath))
      .toEqual(expect.arrayContaining(['links[0].txPower', 'links[0].dataRate']))
  })

  it.each(['frequency', 'rxFrequency'] as const)('拒绝无法安全换算的光学频率 %s', field => {
    for (const value of [Number.MIN_VALUE, Number.MAX_VALUE]) {
      const draft = laserDraft()
      draft.config.links[0]![field] = value
      expect(() => buildMissionPackage(draft)).toThrow(`links[0].${field}`)
    }
  })

  it('生成两端激光收发器、独立介质与实际光学参数，不使用射频或光纤模型', () => {
    const draft = laserDraft()
    const original = structuredClone(draft)
    const generated = buildMissionPackage(draft)
    const text = Object.values(generated.files).join('\n')
    expect(generated.manifest.devices[0]).toMatchObject({ linkType: 'LASER', commModel: 'WSF_LASER_TRANSCEIVER',
      modulation: 'OOK', modulationEngineMapped: true, laser: { ...optical, wavelengthM: 1.55e-6 } })
    expect(text.match(/comm \S+ WSF_LASER_TRANSCEIVER/g)).toHaveLength(2)
    expect(text.match(/modulation_type ook/g)).toHaveLength(2)
    expect(text).toContain('wavelength 0.00000155 m')
    expect(text).toContain('aperture_diameter 0.1 m')
    expect(text).toContain('pulse_width 1e-8 sec')
    expect(text).toContain('transfer_rate constant 1 mbits/sec')
    expect(text).not.toContain('WSF_RADIO_TRANSCEIVER')
    expect(text).not.toMatch(/comm \S+ WSF_COMM_TRANSCEIVER/)
    expect(text).not.toContain('antenna_pattern LASER_COMM_ANTENNA')
    expect(generated.manifest.linkCalc.excludedOpticalLinkIds).toEqual(['L-OPTICAL'])
    expect(draft).toEqual(original)
  })

  it('PUT 拒绝缺项并保留旧修订，完整参数保存后 GET 原样回读', async () => {
    const server = createMockServer({ port: 0 })
    try {
      if (!server.httpServer.listening) await once(server.httpServer, 'listening')
      const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
      const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
      const before = (await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data
      const draft = laserDraft()
      delete draft.config.links[0]!.laser
      const rejected = await api.put('/api/v1/scenarios/SCN-001').set(headers)
        .send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: before.revision }).expect(422)
      expect(rejected.body.error).toMatchObject({ fieldPath: 'links[0].laser' })
      expect((await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data).toEqual(before)
      draft.config.links[0]!.laser = { ...optical }
      await api.put('/api/v1/scenarios/SCN-001').set(headers)
        .send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: before.revision }).expect(200)
      const loaded = (await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data
      expect(loaded.config.links[0].laser).toEqual(optical)
    } finally { await server.close() }
  })

  it.skipIf(!env.MISSION_SMOKE_EXECUTABLE).each([
    { power: 1, transmitted: 2, received: 2 }, { power: 1e-30, transmitted: 0, received: 0 },
  ])('真实引擎：光功率 $power W 时接收 $received 条业务消息', { timeout: 30_000 }, async ({ power, transmitted, received }) => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-laser-native-test-'))
    try {
      const draft = laserDraft()
      draft.config.links[0]!.txPower = power
      const run = await new LocalMissionRunner(env.MISSION_SMOKE_EXECUTABLE!, root).start(draft)
      const result = await run.completed
      const directory = dirname(run.entryPath)
      const log = await readFile(join(directory, 'mission-console.log'), 'utf8')
      expect(result, log).toMatchObject({ code: 0 })
      expect(result.errorMessage, log).toBeUndefined()
      const events = await readFile(join(directory, 'output/scenario_events.csv'), 'utf8')
      const rows = events.split(/\r?\n/).map((row: string) => row.split(','))
      expect(rows.filter((row: string[]) => row[1] === 'MESSAGE_TRANSMITTED' && row[2] === 'CMD-01')).toHaveLength(transmitted)
      expect(rows.filter((row: string[]) => row[1] === 'MESSAGE_RECEIVED' && row[2] === 'AIR-01')).toHaveLength(received)
      expect(events).toContain('WSF_LASER_TRANSCEIVER')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

import { describe, expect, it } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ScenarioConfig } from '../../src/contracts/domain-models'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'
import { LINK_CALC_DEFAULTS } from '../../src/features/scenarios/link-calc-defaults'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'

function configuration(): ScenarioConfig {
  const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
  const link = config.links[0]!
  config.links = [link]
  config.platforms = config.platforms.filter(platform => [link.sourcePlatformId, link.targetPlatformId].includes(platform.id))
  for (const platform of config.platforms) {
    platform.waypoints = []
    platform.linkIds = [link.id]
    platform.jammerIds = []
    platform.sensorIds = []
  }
  config.jammers = []
  config.sensors = []
  config.informationDemand = [{ ...config.informationDemand[0]!, linkId: link.id, direction: link.direction,
    informationType: link.direction === 'FORWARD' ? '目标指令' : '侦察信息',
    sourcePlatformId: link.sourcePlatformId, destinationPlatformIds: [link.targetPlatformId] }]
  config.linkSettings = readLinkSettings(config)
  return config
}

describe('新增场景参数的写入边界', () => {
  it('旧配置可写入；新增接收参数、环境开关和合法边界不改变输入', () => {
    const config = configuration()
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([])
    Object.assign(config.scenario.environment, { rainEnabled: false, cloudEnabled: false, rainCloudAttenuation: 'stormRain',
      rainAltitudeLimitM: 30000, rainAttenuationDb: 0, simplifiedAttenuationDbPerKm: 0,
      polarizationMismatchDb: 0, pointingErrorDb: 0, seaLowAltitudeThresholdM: 0, seaPathOverSeaThresholdKm: 0,
      seaWaterTempC: -2, seaSurfaceRoughnessM: 5, atmosphereModel: 'auto', seaModel: 'fine', seaPolarization: 'horizontal', seaState: 9 })
    Object.assign(config.links[0]!, { rxFrequency: 0.001, rxBandwidth: 0.001,
      txPolarization: 'horizontal', rxPolarization: 'vertical', noiseFigureDb: 0 })
    config.linkSettings!.linkCalc = { ...LINK_CALC_DEFAULTS, jammingRangeKm: 0, channelEncodingScheme: -1 }
    const before = structuredClone(config)
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([])
    expect(config).toEqual(before)
  })

  it.each([
    ['rainEnabled', 'false', 'NATURAL_ENVIRONMENT_SWITCH_INVALID'],
    ['cloudEnabled', 0, 'NATURAL_ENVIRONMENT_SWITCH_INVALID'],
    ['rainAltitudeLimitM', 30001, 'NATURAL_ENVIRONMENT_INVALID'],
    ['rainAttenuationDb', -1, 'NATURAL_ENVIRONMENT_INVALID'],
    ['simplifiedAttenuationDbPerKm', Infinity, 'NATURAL_ENVIRONMENT_INVALID'],
    ['polarizationMismatchDb', -1, 'NATURAL_ENVIRONMENT_INVALID'],
    ['pointingErrorDb', Number.NaN, 'NATURAL_ENVIRONMENT_INVALID'],
    ['seaLowAltitudeThresholdM', -1, 'NATURAL_ENVIRONMENT_INVALID'],
    ['seaPathOverSeaThresholdKm', -1, 'NATURAL_ENVIRONMENT_INVALID'],
    ['seaWaterTempC', 31, 'NATURAL_ENVIRONMENT_INVALID'],
    ['seaSurfaceRoughnessM', 5.01, 'NATURAL_ENVIRONMENT_INVALID'],
    ['atmosphereModel', 'unknown', 'ATMOSPHERE_MODEL_INVALID'],
    ['seaModel', 'unknown', 'SEA_MODEL_INVALID'],
    ['seaPolarization', 'circular', 'SEA_POLARIZATION_INVALID'],
    ['rainCloudAttenuation', 'unknown', 'WEATHER_INVALID'],
    ['seaState', 1.5, 'SEA_STATE_INVALID'],
    ['seaState', 10, 'SEA_STATE_INVALID'],
  ])('非法环境字段 %s=%s 返回可定位的中文错误', (key, value, code) => {
    const config = configuration()
    Object.assign(config.scenario.environment, { [key]: value })
    const before = structuredClone(config)
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([
      expect.objectContaining({ code, fieldPath: `scenario.environment.${key}`, message: expect.any(String) }),
    ])
    expect(config).toEqual(before)
  })

  it('超过雨强上限只给出封顶警告，不静默改写用户输入', () => {
    const config = configuration()
    config.scenario.environment.rainRateMmPerHour = 101
    const result = inspectScenarioConfig(config, 'write').result
    expect(result.errors).toEqual([])
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'RAIN_RATE_CAPPED', fieldPath: 'scenario.environment.rainRateMmPerHour' }))
    expect(config.scenario.environment.rainRateMmPerHour).toBe(101)
  })

  it.each([
    ['rxFrequency', 0, 'LINK_RX_INVALID'], ['rxBandwidth', Number.NaN, 'LINK_RX_INVALID'],
    ['txPolarization', 'circular', 'LINK_POLARIZATION_INVALID'], ['rxPolarization', '', 'LINK_POLARIZATION_INVALID'],
    ['noiseFigureDb', -1, 'LINK_NOISE_FIGURE_INVALID'], ['noiseFigureDb', 101, 'LINK_NOISE_FIGURE_INVALID'],
  ])('非法接收参数 %s=%s 不通过写入校验', (key, value, code) => {
    const config = configuration()
    Object.assign(config.links[0]!, { [key]: value })
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([
      expect.objectContaining({ code, fieldPath: `links[0].${key}` }),
    ])
  })

  it.each([
    ['emergencyThreshold', 0, 'LINK_CALC_THRESHOLD_INVALID'],
    ['warningThreshold', Infinity, 'LINK_CALC_THRESHOLD_INVALID'],
    ['valueThresholdBer', 1.01, 'LINK_CALC_THRESHOLD_INVALID'],
    ['jammingRangeKm', -1, 'LINK_CALC_JAMMING_RANGE_INVALID'],
    ['jammingRangeKm', 101, 'LINK_CALC_JAMMING_RANGE_INVALID'],
    ['channelEncodingScheme', 1, 'LINK_CALC_ENCODING_INVALID'],
  ])('非法全局计算参数 %s=%s 返回具体字段', (key, value, code) => {
    const config = configuration()
    Object.assign(config.linkSettings!, { linkCalc: { ...LINK_CALC_DEFAULTS, [key]: value } })
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([
      expect.objectContaining({ code, fieldPath: `linkSettings.linkCalc.${key}` }),
    ])
  })

  it('全局计算参数必须结构闭合且完整', () => {
    const config = configuration()
    for (const linkCalc of [null, { ...LINK_CALC_DEFAULTS, injected: true }, { emergencyThreshold: 1e-5 }]) {
      Object.assign(config.linkSettings!, { linkCalc })
      expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([
        expect.objectContaining({ code: 'LINK_CALC_INVALID', fieldPath: 'linkSettings.linkCalc' }),
      ])
    }
  })

  it('热链结构、终点类型及有序引用分别定位，不修改已保存的链路', () => {
    const config = configuration()
    const originalLinks = structuredClone(config.links)
    const valid = { forward: [] as string[][], reverse: [] as string[][], endPlatformType: 'REAR_COMMAND_NODE' }
    for (const [hotLinks, code, fieldPath] of [
      [null, 'HOT_LINKS_INVALID', 'linkSettings.hotLinks'],
      [{ ...valid, extra: true }, 'HOT_LINKS_INVALID', 'linkSettings.hotLinks'],
      [{ ...valid, endPlatformType: 'FORWARD_RELAY_NODE' }, 'HOT_LINK_END_TYPE_INVALID', 'linkSettings.hotLinks.endPlatformType'],
      [{ ...valid, forward: 'invalid' }, 'HOT_LINKS_INVALID', 'linkSettings.hotLinks.forward'],
      [{ ...valid, reverse: [[5]] }, 'HOT_LINKS_INVALID', 'linkSettings.hotLinks.reverse'],
      [{ ...valid, forward: [[]] }, 'HOT_LINK_CHAIN_INVALID', 'linkSettings.hotLinks.forward[0]'],
      [{ ...valid, forward: [['NO-SUCH-LINK']] }, 'HOT_LINK_CHAIN_INVALID', 'linkSettings.hotLinks.forward[0]'],
    ] as const) {
      Object.assign(config.linkSettings!, { hotLinks })
      expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([
        expect.objectContaining({ code, fieldPath }),
      ])
      expect(config.links).toEqual(originalLinks)
    }
  })
})

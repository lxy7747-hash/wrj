import { describe, expect, it } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ScenarioConfig } from '../../src/contracts/domain-models'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'
import { LINK_CALC_DEFAULTS } from '../../src/features/scenarios/link-calc-defaults'
import { dropRetiredScenarioFields, inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'
import { isControlledPowerDbm } from '../../src/features/scenarios/jammer-settings'
import { createTemplateScenario } from '../fixtures/template-scenario'

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

  it('简化大气模型衰减率为 0：保存阻断、读取仅提示；自动模型为 0 合法', () => {
    const config = configuration()
    Object.assign(config.scenario.environment, { atmosphereModel: 'simplified', simplifiedAttenuationDbPerKm: 0 })
    const before = structuredClone(config)
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([
      expect.objectContaining({ code: 'ATMOSPHERE_SIMPLIFIED_RATE_REQUIRED', fieldPath: 'scenario.environment.simplifiedAttenuationDbPerKm' }),
    ])
    const read = inspectScenarioConfig(config, 'read').result
    expect(read.errors.map(issue => issue.code)).not.toContain('ATMOSPHERE_SIMPLIFIED_RATE_REQUIRED')
    expect(read.warnings).toContainEqual(expect.objectContaining({ code: 'ATMOSPHERE_SIMPLIFIED_RATE_REQUIRED' }))
    expect(config).toEqual(before)
    config.scenario.environment.simplifiedAttenuationDbPerKm = 0.02
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([])
    Object.assign(config.scenario.environment, { atmosphereModel: 'auto', simplifiedAttenuationDbPerKm: 0 })
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([])
  })

  it('启用海面多径但未框选海面区域时只提示不阻断，框选后提示消失', () => {
    const config = configuration()
    config.scenario.environment.multipathEnabled = true
    delete config.scenario.environment.seaPolygon
    for (const mode of ['write', 'read'] as const) {
      const result = inspectScenarioConfig(config, mode).result
      expect(result.errors.map(issue => issue.code)).not.toContain('SEA_POLYGON_REQUIRED')
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'SEA_POLYGON_REQUIRED', fieldPath: 'scenario.environment.seaPolygon' }))
    }
    config.scenario.environment.seaPolygon = [{ longitude: 118, latitude: 24 }, { longitude: 119, latitude: 24 }, { longitude: 119, latitude: 25 }]
    expect(inspectScenarioConfig(config, 'write').result.warnings.map(issue => issue.code)).not.toContain('SEA_POLYGON_REQUIRED')
    delete config.scenario.environment.seaPolygon
    config.scenario.environment.multipathEnabled = false
    expect(inspectScenarioConfig(config, 'write').result.warnings.map(issue => issue.code)).not.toContain('SEA_POLYGON_REQUIRED')
  })

  it('超过雨强上限只给出封顶警告，不静默改写用户输入', () => {
    const config = configuration()
    config.scenario.environment.rainRateMmPerHour = 101
    const result = inspectScenarioConfig(config, 'write').result
    expect(result.errors).toEqual([])
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'RAIN_RATE_CAPPED', fieldPath: 'scenario.environment.rainRateMmPerHour' }))
    expect(config.scenario.environment.rainRateMmPerHour).toBe(101)
  })

  it('写入时三类航点速度至少为 1 m/s，读取旧场景保留正数兼容', () => {
    const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
    Object.assign(config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
    const platformIndex = config.platforms.findIndex(platform => platform.id === 'AIR-01')
    const platform = config.platforms[platformIndex]!
    const { longitude, latitude, altitude, speed } = platform.waypoints[0]!
    const point = { longitude, latitude, altitude, speed }
    platform.waypoints[0]!.speed = 0.5
    platform.loiterWaypoints = [
      { ...point, longitude: point.longitude + 0.01, speed: 0.5 },
      { ...point, longitude: point.longitude + 0.02, speed: 0.5 },
    ]
    platform.returnPlan = { timeS: 600, waypoints: [{ ...point, speed: 0.5 }] }

    const expectedErrors = [
      { code: 'SPEED_INVALID', fieldPath: `platforms[${platformIndex}].waypoints[0].speed`, message: '航点速度必填且必须至少为 1 m/s；固定节点请删除航点，仅设置初始位置。' },
      { code: 'TEMPLATE_ROUTE_SPEED_INVALID', fieldPath: `platforms[${platformIndex}].loiterWaypoints[0].speed`, message: '模板路线点速度必须至少为 1 m/s。' },
      { code: 'TEMPLATE_ROUTE_SPEED_INVALID', fieldPath: `platforms[${platformIndex}].loiterWaypoints[1].speed`, message: '模板路线点速度必须至少为 1 m/s。' },
      { code: 'TEMPLATE_ROUTE_SPEED_INVALID', fieldPath: `platforms[${platformIndex}].returnPlan.waypoints[0].speed`, message: '模板路线点速度必须至少为 1 m/s。' },
    ]
    expect(inspectScenarioConfig(config, 'read').result.errors).toEqual([])
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual(expect.arrayContaining(expectedErrors.map(issue => expect.objectContaining(issue))))

    platform.waypoints[0]!.speed = 1
    platform.loiterWaypoints = platform.loiterWaypoints!.map(routePoint => ({ ...routePoint, speed: 1 }))
    platform.returnPlan!.waypoints[0]!.speed = 1
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([])
  })

  it('前出中继初始位置和普通航点写入时按无人机范围限位，读取旧位置保持兼容', () => {
    const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
    Object.assign(config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
    const platformIndex = config.platforms.findIndex(platform => platform.type === 'FORWARD_RELAY_NODE')
    const platform = config.platforms[platformIndex]!
    Object.assign(platform.initialPosition, { longitude: 117, latitude: 26, altitude: 3200 })
    platform.waypoints = [{ longitude: 122, latitude: 21, altitude: 5000, speed: 1, arrivalTime: 0 }]
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([])

    Object.assign(platform.initialPosition, { longitude: 116.999999, latitude: 26 })
    platform.waypoints[0]!.latitude = 26.000001
    expect(inspectScenarioConfig(config, 'read').result.errors).toEqual([])
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RELAY_LONGITUDE_INVALID', fieldPath: `platforms[${platformIndex}].initialPosition.longitude`, message: '前出中继初始位置经度必须在 117°E～122°E 范围内。' }),
      expect.objectContaining({ code: 'RELAY_LATITUDE_INVALID', fieldPath: `platforms[${platformIndex}].waypoints[0].latitude`, message: '前出中继航点纬度必须在 21°N～26°N 范围内。' }),
    ]))
    Object.assign(platform.initialPosition, { longitude: 122, latitude: 20.999999 })
    Object.assign(platform.waypoints[0]!, { longitude: 122.000001, latitude: 21 })
    expect(inspectScenarioConfig(config, 'read').result.errors).toEqual([])
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RELAY_LATITUDE_INVALID', fieldPath: `platforms[${platformIndex}].initialPosition.latitude`, message: '前出中继初始位置纬度必须在 21°N～26°N 范围内。' }),
      expect.objectContaining({ code: 'RELAY_LONGITUDE_INVALID', fieldPath: `platforms[${platformIndex}].waypoints[0].longitude`, message: '前出中继航点经度必须在 117°E～122°E 范围内。' }),
    ]))
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

  it('链路最大传输距离必须为正数且结构闭合，合法自定义值校验通过', () => {
    const valid = configuration()
    Object.assign(valid.linkSettings!, {
      linkCalc: {
        ...LINK_CALC_DEFAULTS,
        trafficDistance: { relayUavKm: 80, relayRelayKm: 220, relayCommandKm: 260, uavCommandKm: 250, microwaveKm: 180, laserKm: 50 },
      },
    })
    expect(inspectScenarioConfig(valid, 'write').result.errors).toEqual([])

    const badField = configuration()
    Object.assign(badField.linkSettings!, {
      linkCalc: { ...LINK_CALC_DEFAULTS, trafficDistance: { relayUavKm: 0, laserKm: -5 } },
    })
    expect(inspectScenarioConfig(badField, 'write').result.errors).toEqual([
      expect.objectContaining({ code: 'LINK_CALC_DISTANCE_INVALID', fieldPath: 'linkSettings.linkCalc.trafficDistance.relayUavKm' }),
      expect.objectContaining({ code: 'LINK_CALC_DISTANCE_INVALID', fieldPath: 'linkSettings.linkCalc.trafficDistance.laserKm' }),
    ])

    const badShape = configuration()
    Object.assign(badShape.linkSettings!, {
      linkCalc: { ...LINK_CALC_DEFAULTS, trafficDistance: { relayUavKm: 60, extra: 10 } },
    })
    expect(inspectScenarioConfig(badShape, 'write').result.errors).toEqual([
      expect.objectContaining({ code: 'LINK_CALC_DISTANCE_INVALID', fieldPath: 'linkSettings.linkCalc.trafficDistance' }),
    ])
  })

  it('紧急、告警、质量三档误码率阈值须满足 紧急 >= 告警 >= 质量', () => {
    const config = configuration()
    Object.assign(config.linkSettings!, { linkCalc: { ...LINK_CALC_DEFAULTS, emergencyThreshold: 1e-6, warningThreshold: 1e-5, valueThresholdBer: 2e-5 } })
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LINK_CALC_THRESHOLD_INVALID', fieldPath: 'linkSettings.linkCalc.warningThreshold', message: '告警阈值不能高于紧急阈值。' }),
      expect.objectContaining({ code: 'LINK_CALC_THRESHOLD_INVALID', fieldPath: 'linkSettings.linkCalc.valueThresholdBer', message: '质量阈值不能高于告警阈值。' }),
    ]))
  })

  it('卫星方向速率与质量切换门限分别校验边界和相互关系', () => {
    const config = configuration()
    config.links[0]!.type = 'SAT'
    config.links[0]!.forwardDataRate = 0.128
    config.links[0]!.reverseDataRate = 2
    expect(inspectScenarioConfig(config, 'write').result.errors.map(issue => issue.fieldPath)).not.toContain('links[0].forwardDataRate')
    config.links[0]!.forwardDataRate = 0.1
    expect(inspectScenarioConfig(config, 'write').result.errors.map(issue => issue.fieldPath)).toContain('links[0].forwardDataRate')
    config.links[0]!.forwardDataRate = 0.128
    Object.assign(config.linkSettings!, { minimumGxbDb: 6, maximumBer: 1e-5, failureGxbDb: 7, failureBer: 1e-6 })
    expect(inspectScenarioConfig(config, 'write').result.errors.map(issue => issue.fieldPath)).toEqual(expect.arrayContaining([
      'linkSettings.failureGxbDb', 'linkSettings.failureBer',
    ]))
  })

  it('各类链路前向/返向速率均按类型上下界校验', () => {
    const cases: Array<{
      type: ScenarioConfig['links'][number]['type']
      band?: 'C' | 'L'
      key: 'forwardDataRate' | 'reverseDataRate'
      valid: number
      tooLow: number
      tooHigh: number
    }> = [
      { type: 'MICROWAVE', key: 'forwardDataRate', valid: 80, tooLow: 0.05, tooHigh: 120 },
      { type: 'DATALINK', band: 'C', key: 'forwardDataRate', valid: 2, tooLow: 0.01, tooHigh: 5 },
      { type: 'DATALINK', band: 'C', key: 'reverseDataRate', valid: 16, tooLow: 0.02, tooHigh: 20 },
      { type: 'DATALINK', band: 'L', key: 'forwardDataRate', valid: 0.512, tooLow: 0.005, tooHigh: 2 },
      { type: 'DATALINK', band: 'L', key: 'reverseDataRate', valid: 8, tooLow: 0.01, tooHigh: 10 },
      { type: 'LASER', key: 'forwardDataRate', valid: 2500, tooLow: 0.05, tooHigh: 12000 },
      { type: 'FIBER', key: 'reverseDataRate', valid: 500, tooLow: 5, tooHigh: 2000 },
    ]
    for (const item of cases) {
      const config = configuration()
      const link = config.links[0]!
      link.type = item.type
      if (item.band) link.band = item.band
      else delete link.band
      delete link.forwardDataRate
      delete link.reverseDataRate

      link[item.key] = item.valid
      expect(inspectScenarioConfig(config, 'write').result.errors.map(issue => issue.fieldPath)).not.toContain(`links[0].${item.key}`)

      link[item.key] = item.tooLow
      expect(inspectScenarioConfig(config, 'write').result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DIRECTIONAL_DATA_RATE_OUT_OF_RANGE', fieldPath: `links[0].${item.key}` }),
      ]))

      link[item.key] = item.tooHigh
      expect(inspectScenarioConfig(config, 'write').result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DIRECTIONAL_DATA_RATE_OUT_OF_RANGE', fieldPath: `links[0].${item.key}` }),
      ]))
    }
  })

  it('热链结构及有序引用分别定位，不修改已保存的链路', () => {
    const config = configuration()
    const originalLinks = structuredClone(config.links)
    const valid = { forward: [] as string[][], reverse: [] as string[][] }
    for (const [hotLinks, code, fieldPath] of [
      [null, 'HOT_LINKS_INVALID', 'linkSettings.hotLinks'],
      [{ ...valid, extra: true }, 'HOT_LINKS_INVALID', 'linkSettings.hotLinks'],
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

  it('旧场景残留的 hotLinks.endPlatformType 在读取/保存前被丢弃', () => {
    const config = configuration()
    ;(config.linkSettings as unknown as { hotLinks: unknown }).hotLinks = { forward: [], reverse: [], endPlatformType: 'REAR_COMMAND_NODE' }
    dropRetiredScenarioFields(config)
    expect((config.linkSettings as unknown as { hotLinks: unknown }).hotLinks).toEqual({ forward: [], reverse: [] })
    expect(inspectScenarioConfig(config, 'write').result.errors.filter(item => item.code === 'HOT_LINKS_INVALID')).toEqual([])
  })
})


describe('V1.2 干扰功率（W）、带宽及瞄准频率', () => {
  it.each([0, -10, Number.NaN])('非法干扰功率 %s W 写入被拒绝，定位功率字段且不修改原值', powerW => {
    const config = createTemplateScenario().config
    config.jammers[0]!.defaultPower = powerW
    const before = structuredClone(config)
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([
      expect.objectContaining({ code: 'JAMMER_POWER_INVALID', fieldPath: 'jammers[0].defaultPower',
        message: '干扰功率必须大于 0 W。' }),
    ])
    expect(config).toEqual(before)
  })

  it.each([0.0001, 1, 200, 500, 1000, 10_000])('任意正瓦特功率 %s W 可直接写入', powerW => {
    const config = createTemplateScenario().config
    config.jammers[0]!.defaultPower = powerW
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([])
  })

  it('档位容差为 1e-6 dB，拒绝非有限或非数值输入', () => {
    for (const value of [-10 - 5e-7, 5 + 5e-7, 30 + 5e-7]) expect(isControlledPowerDbm(value)).toBe(true)
    for (const value of [-10 - 2e-6, 5 + 2e-6, 30 + 2e-6, NaN, Infinity, '5', null]) expect(isControlledPowerDbm(value)).toBe(false)
  })

  it('场景支持大功率 W 值和自定义正数带宽，读写均可通过', () => {
    const config = createTemplateScenario().config
    Object.assign(config.jammers[0]!, { defaultPower: 10_000, bandwidth: 50 })
    expect(inspectScenarioConfig(config, 'read').result.errors).toEqual([])
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([])
  })

  it.each([
    ['BARRAGE', 0, false], ['BARRAGE', 1, true], ['BARRAGE', 50, true], ['BARRAGE', 200, true],
    ['SPOT', -1, false], ['SPOT', 1, true], ['SPOT', 5, true], ['SWEEP', 50, true],
  ] as const)('%s 带宽 %s MHz 的写入边界', (type, bandwidth, valid) => {
    const config = createTemplateScenario().config
    Object.assign(config.jammers[0]!, { type, bandwidth })
    const result = inspectScenarioConfig(config, 'write').result
    expect(result.valid).toBe(valid)
    expect(result.errors).toEqual(valid ? [] : [expect.objectContaining({ code: 'JAMMER_BANDWIDTH_INVALID', fieldPath: 'jammers[0].bandwidth',
      message: '干扰带宽必须大于 0 MHz。' })])
    expect(inspectScenarioConfig(config, 'read').result.errors).toEqual(result.errors)
  })

  it('瞄准频率未匹配只警告，匹配启用的非激光链路后消失', () => {
    const config = createTemplateScenario().config
    Object.assign(config.jammers[0]!, { type: 'SPOT', bandwidth: 5, frequency: 1234 })
    const unmatched = inspectScenarioConfig(config, 'write').result
    expect(unmatched.valid).toBe(true)
    expect(unmatched.warnings).toContainEqual(expect.objectContaining({ code: 'JAMMER_SPOT_FREQUENCY_UNMATCHED', fieldPath: 'jammers[0].frequency',
      message: '瞄准式干扰中心频率未对准任何链路工作频率。' }))
    config.jammers[0]!.frequency = config.links[0]!.frequency
    expect(inspectScenarioConfig(config, 'write').result.warnings.some(issue => issue.code === 'JAMMER_SPOT_FREQUENCY_UNMATCHED')).toBe(false)
  })

  it.each(['disabled', 'laser'] as const)('%s 链路不作为瞄准频率依据', reason => {
    const config = createTemplateScenario().config
    Object.assign(config.jammers[0]!, { type: 'SPOT', bandwidth: 5, frequency: 1234 })
    Object.assign(config.links[0]!, { frequency: 1234, ...(reason === 'disabled' ? { enabled: false } : { type: 'LASER' }) })
    expect(inspectScenarioConfig(config, 'write').result.warnings).toContainEqual(expect.objectContaining({ code: 'JAMMER_SPOT_FREQUENCY_UNMATCHED' }))
  })
})

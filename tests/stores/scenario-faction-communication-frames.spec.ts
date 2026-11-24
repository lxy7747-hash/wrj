import { describe, expect, it } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { Jammer, Platform, ScenarioConfig } from '../../src/contracts/domain-models'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'
import { platformMapSide } from '../../src/features/situation/initial-nodes'

/** 复用既有最小合法场景，聚焦 F01/F02/F06 新增字段的写入边界。 */
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

function jammerConfiguration(): ScenarioConfig {
  const config = configuration()
  const platform: Platform = {
    id: 'JAM-1', name: '干扰站', type: 'GROUND_JAMMER_DETECTION_STATION', category: 'ground',
    initialPosition: { longitude: 119, latitude: 24, altitude: 0 },
    waypoints: [], linkIds: [], sensorIds: [], jammerIds: ['J-1'],
  }
  config.platforms.push(platform)
  const jammer: Jammer = {
    id: 'J-1', platformId: 'JAM-1', type: 'BARRAGE', defaultPower: 1, frequency: 2400, bandwidth: 200,
    detectionRange: 30000, jammingRange: 30000, releaseRange: 35000, detectionMinimumRange: 1000,
    plannedStartFrame: 300, plannedStopFrame: 900,
  }
  config.jammers = [jammer]
  return config
}

function errorCodes(config: ScenarioConfig, prefix: string): string[] {
  return inspectScenarioConfig(config, 'write').result.errors
    .filter(issue => issue.fieldPath.startsWith(prefix))
    .map(issue => issue.code)
}

function warningCodes(config: ScenarioConfig, prefix: string): string[] {
  return inspectScenarioConfig(config, 'write').result.warnings
    .filter(issue => issue.fieldPath.startsWith(prefix))
    .map(issue => issue.code)
}

describe('F01 所属阵营写入校验', () => {
  it.each(['BLUE', 'RED', 'NEUTRAL'] as const)('显式阵营 %s 合法且不改写输入', (faction) => {
    const config = configuration()
    config.platforms[0]!.faction = faction
    const before = structuredClone(config)
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([])
    expect(config).toEqual(before)
  })

  it('非法阵营取值被拒绝并可定位', () => {
    const config = configuration()
    ;(config.platforms[0] as { faction?: string }).faction = 'GREEN'
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([
      expect.objectContaining({ code: 'PLATFORM_FACTION_INVALID', fieldPath: 'platforms[0].faction' }),
    ])
  })

  it('缺省阵营保持兼容（旧场景不强制、不推断回写）', () => {
    const config = configuration()
    delete config.platforms[0]!.faction
    expect(errorCodes(config, 'platforms[0].faction')).toEqual([])
  })
})

describe('F02 节点通信能力范围写入校验', () => {
  it('缺失表示未配置，合法正数写入通过', () => {
    const config = configuration()
    expect(errorCodes(config, 'platforms[0].communicationRangeM')).toEqual([])
    config.platforms[0]!.communicationRangeM = 50_000
    const before = structuredClone(config)
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([])
    expect(config).toEqual(before)
  })

  it.each([0, -1, Number.NaN])('非正/非法取值 %s 被拒绝', (value) => {
    const config = configuration()
    config.platforms[0]!.communicationRangeM = value
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([
      expect.objectContaining({ code: 'PLATFORM_COMMUNICATION_RANGE_INVALID', fieldPath: 'platforms[0].communicationRangeM' }),
    ])
  })
})

describe('F06 干扰计划帧写入校验', () => {
  it('300 启 / 900 停 合法且可保存', () => {
    const config = jammerConfiguration()
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([])
  })

  it('0 为合法显式启动帧，不被当作未配置', () => {
    const config = jammerConfiguration()
    config.jammers[0]!.plannedStartFrame = 0
    config.jammers[0]!.plannedStopFrame = 5
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([])
  })

  it('停止帧不大于启动帧仅提示，不阻止保存', () => {
    const config = jammerConfiguration()
    config.jammers[0]!.plannedStartFrame = 900
    config.jammers[0]!.plannedStopFrame = 300
    expect(errorCodes(config, 'jammers[0].planned')).toEqual([])
    expect(warningCodes(config, 'jammers[0].planned')).toEqual(['JAMMER_PLANNED_FRAME_ORDER_INVALID'])
  })

  it.each([300.5, -1])('非负整数之外的计划帧 %s 仅提示，不阻止保存', (value) => {
    const config = jammerConfiguration()
    config.jammers[0]!.plannedStartFrame = value
    expect(errorCodes(config, 'jammers[0].plannedStartFrame')).toEqual([])
    expect(warningCodes(config, 'jammers[0].plannedStartFrame')).toEqual(['JAMMER_PLANNED_FRAME_INVALID'])
  })
})

describe('F01 地图 side 来源', () => {
  it('显式阵营映射为地图 side，缺省按平台类型推断，中立不臆造', () => {
    expect(platformMapSide({ type: 'REAR_COMMAND_NODE', faction: 'BLUE' })).toBe('blue')
    expect(platformMapSide({ type: 'REAR_COMMAND_NODE', faction: 'RED' })).toBe('red')
    expect(platformMapSide({ type: 'REAR_COMMAND_NODE', faction: 'NEUTRAL' })).toBeUndefined()
    expect(platformMapSide({ type: 'GROUND_JAMMER_DETECTION_STATION' })).toBe('red')
    expect(platformMapSide({ type: 'COMMUNICATION_SATELLITE' })).toBe('blue')
    expect(platformMapSide({})).toBeUndefined()
  })
})

describe('#5 激光链路 eirpDbw/gtDbk 校验', () => {
  it('缺省允许；存在时有限数值通过', () => {
    const config = configuration()
    expect(errorCodes(config, 'links[0].eirpDbw')).toEqual([])
    expect(errorCodes(config, 'links[0].gtDbk')).toEqual([])
    config.links[0]!.eirpDbw = 20
    config.links[0]!.gtDbk = 15
    expect(inspectScenarioConfig(config, 'write').result.errors).toEqual([])
  })

  it.each([
    ['eirpDbw', Infinity, 'links[0].eirpDbw'],
    ['gtDbk', Number.NaN, 'links[0].gtDbk'],
  ] as const)('%s 非有限数值被拒绝', (field, value, path) => {
    const config = configuration()
    config.links[0]![field] = value
    expect(errorCodes(config, path)).toEqual(['LINK_GAIN_INVALID'])
  })

  it('noiseFigureDb 为负被拒绝（须 >= 0）', () => {
    const config = configuration()
    config.links[0]!.noiseFigureDb = -1
    expect(errorCodes(config, 'links[0].noiseFigureDb')).toEqual(['LINK_NOISE_FIGURE_INVALID'])
  })
})

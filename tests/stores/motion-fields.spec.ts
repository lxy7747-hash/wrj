import { describe, expect, it } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import { inspectScenarioConfig, inspectScenarioUiExtensions, restoreRequiredMotionFields } from '../../src/features/scenarios/scenario-validation'
import { metersBetween } from '../../src/features/scenarios/position-distance'
import { readScenarioDraft } from '../../src/stores/scenario'

function legacy() {
  const config = structuredClone(fixtureSource.scenario)
  Object.assign(config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
  const platform = config.platforms[3]!
  platform.initialPosition = { longitude: 120, latitude: 24, altitude: 0 }
  const point = { longitude: 120.01, latitude: 24, altitude: 0, speed: 100 }
  const waypoints: Array<Record<string, unknown>> = [point, { ...point, longitude: 120.02 }]
  Object.assign(platform, { waypoints })
  const uiExtensions = {
    jammers: config.jammers.map(item => ({ jammerId: item.id, enabled: true })),
    sensors: config.sensors.map(item => ({ sensorId: item.id, type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true })),
  }
  return { config, uiExtensions, platform, waypoints }
}

describe('D1 旧场景运动字段兼容', () => {
  it('逐段按大圆距离/速度补时刻，方向补零，二次读取幂等', () => {
    const value = legacy()
    restoreRequiredMotionFields(value.config, value.uiExtensions)
    const times = value.waypoints.map(point => point.arrivalTime as number)
    const leg = metersBetween(value.platform.initialPosition, { longitude: 120.01, latitude: 24 }) / 100
    expect(times[0]).toBeCloseTo(leg)
    expect(times[1]).toBeCloseTo(2 * leg)
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1)
    expect(value.uiExtensions.jammers[0]).toHaveProperty('direction', 0)
    expect(inspectScenarioConfig(value.config, 'write').result.valid).toBe(true)
    const before = structuredClone(value)
    restoreRequiredMotionFields(value.config, value.uiExtensions)
    expect(value).toEqual(before)
  })

  it('超出时长时从尾部预留间隔，同点至少增加一秒', () => {
    const value = legacy()
    value.config.scenario.duration = 10
    for (const platform of value.config.platforms) if (platform !== value.platform) platform.waypoints = []
    restoreRequiredMotionFields(value.config, value.uiExtensions)
    expect(value.waypoints.map(point => point.arrivalTime)).toEqual([9, 10])
    expect(inspectScenarioConfig(value.config, 'write').result.valid).toBe(true)
    const same = legacy()
    Object.assign(same.waypoints[0]!, same.platform.initialPosition)
    Object.assign(same.waypoints[1]!, same.platform.initialPosition)
    restoreRequiredMotionFields(same.config)
    expect(same.waypoints.map(point => point.arrivalTime)).toEqual([1, 2])
  })

  it('既有时刻和方向一律保留，无法容纳的新时刻由写入校验指出', () => {
    const value = legacy()
    value.config.scenario.duration = 1
    value.waypoints[0]!.arrivalTime = 5
    Object.assign(value.uiExtensions.jammers[0]!, { direction: 270 })
    restoreRequiredMotionFields(value.config, value.uiExtensions)
    expect(value.waypoints[0]!.arrivalTime).toBe(5)
    expect(value.uiExtensions.jammers[0]).toHaveProperty('direction', 270)
    expect(inspectScenarioConfig(value.config, 'read').result.valid).toBe(true)
    expect(inspectScenarioConfig(value.config, 'write').result.valid).toBe(false)
  })

  it('只补缺失值，不掩盖非法显式值；畸形容器不抛异常', () => {
    const value = legacy()
    value.waypoints[0]!.arrivalTime = null
    Object.assign(value.uiExtensions.jammers[0]!, { direction: 999 })
    restoreRequiredMotionFields(value.config, value.uiExtensions)
    expect(value.waypoints[0]!.arrivalTime).toBeNull()
    expect(inspectScenarioConfig(value.config).result.valid).toBe(false)
    expect(inspectScenarioUiExtensions(value.uiExtensions, value.config.jammers.map(item => item.id), value.config.sensors.map(item => item.id)).result.valid).toBe(false)
    for (const value of [null, 1, [], {}, { platforms: [null, {}, { waypoints: [null, 1, []] }] }]) {
      expect(() => restoreRequiredMotionFields(value, value)).not.toThrow()
    }
  })

  it('草稿成功信封解析先兼容再校验，原响应不被修改', () => {
    const value = legacy()
    const original = structuredClone(value)
    const draft = readScenarioDraft({ ok: true, data: {
      config: value.config, uiExtensions: value.uiExtensions, revision: 1, locked: false, officialLibraryChanged: false,
    } })
    expect(draft).toBeDefined()
    expect(draft!.config.platforms[3]!.waypoints[0]!.arrivalTime).toBeGreaterThan(1)
    expect(draft!.uiExtensions.jammers[0]!.direction).toBe(0)
    expect(value).toEqual(original)
  })

  it.each([
    [[10, 9], 'ARRIVAL_TIME_NOT_INCREASING'],
    [[10, 10], 'ARRIVAL_TIME_NOT_INCREASING'],
    [[10, 5401], 'ARRIVAL_TIME_EXCEEDS_DURATION'],
  ] as const)('写入拒绝到达时刻 %j；读取不检查顺序/时长', (times, code) => {
    const value = legacy()
    value.config.scenario.duration = 5400
    value.waypoints.forEach((point, index) => { point.arrivalTime = times[index] })
    expect(inspectScenarioConfig(value.config, 'read').result.valid).toBe(true)
    expect(inspectScenarioConfig(value.config, 'write').result.errors).toContainEqual(expect.objectContaining({ code, fieldPath: 'platforms[3].waypoints[1].arrivalTime' }))
  })

  it('不经过读取兼容的写入仍拒绝缺失必填字段', () => {
    const value = legacy()
    expect(inspectScenarioConfig(value.config, 'write').result.errors).toContainEqual(expect.objectContaining({ code: 'ARRIVAL_TIME_INVALID', fieldPath: 'platforms[3].waypoints[0].arrivalTime' }))
    expect(inspectScenarioUiExtensions(value.uiExtensions, value.config.jammers.map(item => item.id), value.config.sensors.map(item => item.id)).result.errors)
      .toContainEqual(expect.objectContaining({ code: 'JAMMER_UI_EXTENSION_DIRECTION_INVALID', fieldPath: 'uiExtensions.jammers[0].direction' }))
  })
})

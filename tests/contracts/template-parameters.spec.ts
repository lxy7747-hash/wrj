import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { beforeAll, describe, expect, it } from 'vitest'

import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { Link, ScenarioConfig } from '../../src/contracts/domain-models'
import { readDeviceParameters, readPortParameters, resolveTemplateLinkPorts } from '../../src/features/scenarios/template-defaults'
import { inspectScenarioConfig, laserOnlyBusinessPaths } from '../../src/features/scenarios/scenario-validation'
import { createTemplateScenario } from '../fixtures/template-scenario'

type JsonObject = Record<string, unknown>
let loadContractDocuments: () => { openApi: unknown }

beforeAll(async () => {
  const modulePath = '../../scripts/contracts/contract-' + 'documents.js'
  ;({ loadContractDocuments } = await import(modulePath) as { loadContractDocuments: typeof loadContractDocuments })
})

function asObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Expected object')
  return value as JsonObject
}

function templateSchema(name: string) {
  const openApi = loadContractDocuments().openApi
  const ajv = new Ajv2020({ strict: false })
  addFormats(ajv)
  ajv.addSchema({ $id: 'template-parameters', components: asObject(openApi).components })
  return ajv.compile({ $ref: `template-parameters#/components/schemas/${name}` })
}

function config(): ScenarioConfig {
  return structuredClone(fixtureSource.scenario) as ScenarioConfig
}

describe('新模板通信参数', () => {
  it('模板对照场景是完整的正向写入样例，并由冻结 ScenarioConfigWrite schema 接受', () => {
    const draft = createTemplateScenario()
    expect(inspectScenarioConfig(draft.config, 'write').result).toMatchObject({ valid: true, errors: [] })
    expect(templateSchema('ScenarioConfigWrite')(draft.config)).toBe(true)
  })

  it('兼容不含新增字段的旧场景读取，并返回不共享的模板端口默认值', () => {
    const old = config()
    expect(inspectScenarioConfig(old, 'read').result.valid).toBe(true)
    const first = readDeviceParameters(old)
    const second = readDeviceParameters(old)
    expect(first.ports.MISSION_UAV_PLATFORM!.microwave_link?.transferRate).toBe(80)
    expect(first.ports.TIAN_TONG_SAT!.sat_link?.transferRate).toBe(0.016)
    expect(first.antennaGains.LASER_COMM_ANTENNA).toBe(40)
    first.ports.MISSION_UAV_PLATFORM!.microwave_link!.txPower = 99
    expect(second.ports.MISSION_UAV_PLATFORM!.microwave_link?.txPower).toBe(20)
    expect(readPortParameters(old, 'COMMAND_VEHICLE_PLATFORM', 'fiber_link')?.transferRate).toBe(1000)
  })

  it('端口映射严格，数传前后向使用同名端口；激光只产生保留警告', () => {
    const value = config()
    const datalink = value.links.find(link => link.id === 'L-DL-03')!
    expect(resolveTemplateLinkPorts(value, datalink)).toMatchObject({ status: 'MAPPED', source: { portName: 'c_band_downlink' }, target: { portName: 'c_band_downlink' } })
    const laser = value.links.find(link => link.type === 'LASER')!
    expect(resolveTemplateLinkPorts(value, laser)).toMatchObject({ status: 'WARNING' })
    const invalid = { ...datalink, type: 'MICROWAVE' as const }
    expect(resolveTemplateLinkPorts(value, invalid)).toMatchObject({ status: 'ERROR' })
    expect(inspectScenarioConfig({ ...value, links: [invalid] }, 'write').result.errors).toContainEqual(expect.objectContaining({ code: 'TEMPLATE_PORT_MAPPING_INVALID', fieldPath: 'links[0]' }))

    const satellite = value.links.find(link => link.id === 'L-SAT-05')!
    expect(resolveTemplateLinkPorts(value, satellite)).toMatchObject({ status: 'MAPPED', target: { portName: 'sat_link_a' } })
    expect(resolveTemplateLinkPorts(value, { ...satellite, direction: 'REVERSE' })).toMatchObject({ status: 'MAPPED', target: { portName: 'sat_link_b' } })
    const rearSource = { ...satellite, sourcePlatformId: satellite.targetPlatformId, targetPlatformId: satellite.sourcePlatformId }
    expect(resolveTemplateLinkPorts(value, rearSource)).toMatchObject({ status: 'MAPPED', source: { portName: 'sat_link_a' } })
    expect(resolveTemplateLinkPorts(value, { ...rearSource, direction: 'REVERSE' })).toMatchObject({ status: 'MAPPED', source: { portName: 'sat_link_b' } })
  })

  it('拒绝未知端口、来源的非端口字段和非有限天线增益', () => {
    const value = config() as ScenarioConfig & { deviceParameters: NonNullable<ScenarioConfig['deviceParameters']> }
    value.deviceParameters = {
      ports: { MISSION_UAV_PLATFORM: {
        unknown: { txFrequency: 1, txBandwidth: 1, txPower: 1, rxFrequency: 1, rxBandwidth: 1, transferRate: 1, noiseFigureDb: 0 },
        microwave_link: {
          txFrequency: 1, txBandwidth: 1, txPower: 1, rxFrequency: 1, rxBandwidth: 1, transferRate: 1, noiseFigureDb: 0,
          parameterSource: { kind: 'EQUIPMENT', sourceId: 'EQ-1', sourceVersion: 1, fields: ['modulation'] },
        },
      } },
      antennaGains: { MICRO_UAV_OMNI_ANTENNA: Infinity },
    }
    const fields = inspectScenarioConfig(value, 'read').result.errors.map(error => error.fieldPath)
    expect(fields).toContain('deviceParameters.ports.MISSION_UAV_PLATFORM.unknown')
    expect(fields).toContain('deviceParameters.ports.MISSION_UAV_PLATFORM.microwave_link.parameterSource.fields')
    expect(fields).toContain('deviceParameters.antennaGains.MICRO_UAV_OMNI_ANTENNA')
  })

  it('冻结 schema 拒绝未知端口、非法来源字段和非正端口值，返回计划只强制 timeS 大于 0', () => {
    const validate = templateSchema('DeviceParameters')
    const port = { txFrequency: 1, txBandwidth: 1, txPower: 1, rxFrequency: 1, rxBandwidth: 1, noiseFigureDb: 0, transferRate: 1 }
    expect(validate({ ports: { MISSION_UAV_PLATFORM: { microwave_link: port } } })).toBe(true)
    expect(validate({ ports: { MISSION_UAV_PLATFORM: { unknown: port } } })).toBe(false)
    expect(validate({ ports: { MISSION_UAV_PLATFORM: { microwave_link: { ...port, txPower: 0 } } } })).toBe(false)
    expect(validate({ ports: { MISSION_UAV_PLATFORM: { microwave_link: { ...port, parameterSource: { kind: 'EQUIPMENT', sourceId: 'EQ-1', sourceVersion: 1, fields: ['modulation'] } } } } })).toBe(false)
    expect(validate({ ports: { MISSION_UAV_PLATFORM: { microwave_link: { ...port, parameterSource: { kind: 'MASTER_DATA', sourceId: 'MD-1', sourceVersion: 1, fields: ['frequency', 'noiseFigureDb'] } } } } })).toBe(true)

    const returnPlan = templateSchema('ReturnPlan')
    const waypoint = { longitude: 120, latitude: 24, altitude: 1000, speed: 1 }
    expect(returnPlan({ timeS: 1, waypoints: [waypoint] })).toBe(true)
    expect(returnPlan({ timeS: 0, waypoints: [waypoint] })).toBe(false)
    // JSON Schema 无法表达与外层 scenario.duration 的比较，由下方的运行时校验覆盖。
    expect(returnPlan({ timeS: 999999, waypoints: [waypoint] })).toBe(true)
  })

  it('校验干扰 0 触发半径、最小探测距离、盘旋和返航约束', () => {
    const positive = config() as ScenarioConfig & { jammers: Array<Record<string, unknown>>; platforms: Array<Record<string, unknown>> }
    positive.jammers[0]!.jammingRange = 0
    positive.jammers[0]!.releaseRange = 0
    positive.jammers[0]!.detectionMinimumRange = 1000
    const relay = positive.platforms.find(platform => platform.id === 'UAV-01')!
    relay.loiterWaypoints = [
      { longitude: 120, latitude: 24, altitude: 1000, speed: 50 },
      { longitude: 120.1, latitude: 24.1, altitude: 1000, speed: 50 },
    ]
    relay.returnPlan = { timeS: 10, waypoints: [{ longitude: 120, latitude: 24, altitude: 1000, speed: 50 }] }
    const positiveFields = inspectScenarioConfig(positive, 'write').result.errors.map(error => error.fieldPath)
    expect(positiveFields).not.toContain('jammers[0].jammingRange')
    expect(positiveFields).not.toContain('jammers[0].detectionMinimumRange')

    const negative = structuredClone(positive)
    negative.jammers[0]!.detectionMinimumRange = negative.jammers[0]!.detectionRange
    negative.platforms.find(platform => platform.id === 'UAV-01')!.loiterWaypoints = [{ longitude: 120, latitude: 24, altitude: 1000, speed: 0 }]
    negative.platforms.find(platform => platform.id === 'UAV-01')!.returnPlan!.timeS = 0
    const fields = inspectScenarioConfig(negative, 'write').result.errors.map(error => error.fieldPath)
    expect(fields).toContain('jammers[0].detectionMinimumRange')
    expect(fields).toContain('platforms[1].loiterWaypoints')
    expect(fields).toContain('platforms[1].returnPlan.timeS')

    for (const timeS of [-1, positive.scenario.duration]) {
      const invalidTime = structuredClone(positive)
      invalidTime.platforms.find(platform => platform.id === 'UAV-01')!.returnPlan!.timeS = timeS
      expect(inspectScenarioConfig(invalidTime, 'write').result.errors.map(error => error.fieldPath)).toContain('platforms[1].returnPlan.timeS')
    }
    const nonFinite = structuredClone(positive) as unknown as { deviceParameters?: unknown }
    nonFinite.deviceParameters = { ports: { MISSION_UAV_PLATFORM: { microwave_link: { txFrequency: Number.NaN, txBandwidth: 1, txPower: 1, rxFrequency: 1, rxBandwidth: 1, noiseFigureDb: 0, transferRate: 1 } } } }
    expect(inspectScenarioConfig(nonFinite, 'write').result.errors.map(error => error.fieldPath)).toContain('deviceParameters.ports.MISSION_UAV_PLATFORM.microwave_link.txFrequency')
  })

  it('D6 限制每个干扰平台一台设备，并要求同类平台的参数一致', () => {
    const value = config() as ScenarioConfig & { jammers: Array<Record<string, unknown>>; platforms: Array<Record<string, unknown>> }
    value.platforms.push({ ...structuredClone(value.platforms.find(platform => platform.id === 'STN-01')!), id: 'STN-02', jammerIds: ['JAM-02'] })
    value.jammers.push({ ...structuredClone(value.jammers[0]!), id: 'JAM-02', platformId: 'STN-02', frequency: 2300 })
    const errors = inspectScenarioConfig(value, 'write').result.errors
    expect(errors).toContainEqual(expect.objectContaining({ code: 'JAMMER_PLATFORM_PARAMETER_CONFLICT', fieldPath: 'jammers[1].frequency' }))

    const duplicate = structuredClone(value)
    duplicate.jammers[1]!.platformId = 'STN-01'
    expect(inspectScenarioConfig(duplicate, 'write').result.errors).toContainEqual(expect.objectContaining({ code: 'JAMMER_PLATFORM_DUPLICATED', fieldPath: 'jammers[1].platformId' }))
  })

  it('激光独占业务返回精确目标索引供生成器过滤，不进入界面校验警告', () => {
    const draft = createTemplateScenario()
    const config = draft.config
    const laser: Link = {
      ...structuredClone(config.links.find(link => link.id === 'c_forward_uav2')!),
      id: 'laser_uav2', type: 'LASER' as const,
      sourcePlatformId: 'rear_comm_vehicle', targetPlatformId: 'mission_uav_02', direction: 'FORWARD' as const,
      laser: { txApertureDiameterM: 0.1, rxApertureDiameterM: 0.1, pulseWidthS: 0.001, modulation: 'OOK' as const },
    }
    delete laser.band
    config.links.push(laser)
    config.platforms.find(platform => platform.id === laser.sourcePlatformId)!.linkIds.push(laser.id)
    config.platforms.find(platform => platform.id === laser.targetPlatformId)!.linkIds.push(laser.id)

    const bound = config.informationDemand.find(demand => demand.id === 'uav2_forward_situation')!
    bound.linkId = laser.id
    let paths = laserOnlyBusinessPaths(config)
    expect(paths).toContainEqual({ fieldPath: 'informationDemand[0].linkId', demandIndex: 0, targetIndex: 'ALL' })
    const validation = inspectScenarioConfig(config, 'write').result
    expect(validation.valid).toBe(true)
    expect(validation.warnings.some(item => item.code === 'BUSINESS_LASER_ONLY_ROUTE' || item.code === 'TEMPLATE_PORT_MAPPING_WARNING')).toBe(false)

    delete bound.linkId
    config.links.find(link => link.id === 'fiber_forward')!.enabled = false
    config.links.find(link => link.id === 'c_forward_uav2')!.enabled = false
    paths = laserOnlyBusinessPaths(config)
    expect(paths).toContainEqual({ fieldPath: 'informationDemand[0].destinationPlatformIds[0]', demandIndex: 0, targetIndex: 0 })

    config.links.find(link => link.id === 'fiber_forward')!.enabled = true
    bound.destinationPlatformIds.push('mission_uav_03')
    paths = laserOnlyBusinessPaths(config)
    expect(paths).toContainEqual({ fieldPath: 'informationDemand[0].destinationPlatformIds[0]', demandIndex: 0, targetIndex: 0 })
    expect(paths.some(item => item.fieldPath === 'informationDemand[0].destinationPlatformIds[1]')).toBe(false)
    expect(paths.some(item => item.fieldPath === 'informationDemand[0]')).toBe(false)

    config.links.find(link => link.id === 'c_forward_uav2')!.enabled = true
    const restored = inspectScenarioConfig(config, 'write').result
    expect(restored.valid).toBe(true)
    paths = laserOnlyBusinessPaths(config)
    expect(paths.some(item => item.fieldPath === 'informationDemand[0].destinationPlatformIds[0]')).toBe(false)

    // 旧链路缺省开关时沿用类型开关，目标识别与生成器使用同一份有效链路。
    delete config.links.find(link => link.id === 'c_forward_uav2')!.enabled
    config.linkSettings!.enabledTypes = { SAT: true, MICROWAVE: true, DATALINK: false, LASER: true, FIBER: true }
    const legacy = inspectScenarioConfig(config, 'write').result
    expect(legacy.valid).toBe(true)
    paths = laserOnlyBusinessPaths(config)
    expect(paths).toContainEqual({ fieldPath: 'informationDemand[0].destinationPlatformIds[0]', demandIndex: 0, targetIndex: 0 })
  })
})

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { beforeAll, describe, expect, it } from 'vitest'

import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { Link, ScenarioConfig } from '../../src/contracts/domain-models'
import { deriveCommPortsFromLinks, readDeviceParameters, readPortParameters, resolveTemplateLinkPorts } from '../../src/features/scenarios/template-defaults'
import { applyLinkEdit } from '../../src/features/scenarios/link-edit'
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
  it('干扰时序为兼容可选字段，合同与读写校验均拒绝 null、负数及非数值', () => {
    const validate = templateSchema('ScenarioConfigWrite')
    const config = createTemplateScenario().config
    expect(validate(config)).toBe(true)
    for (const field of ['detectionDelayS', 'jammingDurationS'] as const) {
      for (const value of (field === 'detectionDelayS' ? [0, 1.5, 30, config.scenario.duration] : [1.5, 30, config.scenario.duration])) {
        const candidate = structuredClone(config)
        candidate.jammers[0]![field] = value
        expect(validate(candidate), JSON.stringify(validate.errors)).toBe(true)
        expect(inspectScenarioConfig(candidate, 'write').result.valid).toBe(true)
        expect(inspectScenarioConfig(candidate, 'read').result.valid).toBe(true)
      }
      for (const value of [null, -1, '3', [], NaN, Infinity, ...(field === 'jammingDurationS' ? [0] : [])]) {
        const candidate = structuredClone(config)
        Object.assign(candidate.jammers[0]!, { [field]: value })
        // JSON 无法表达 NaN / Infinity，运行时入口也必须拒绝。
        if (typeof value !== 'number' || Number.isFinite(value)) expect(validate(candidate)).toBe(false)
        for (const mode of ['read', 'write'] as const) {
          expect(inspectScenarioConfig(candidate, mode).result.errors).toContainEqual(expect.objectContaining({ code: 'JAMMER_TIMING_INVALID', fieldPath: `jammers[0].${field}` }))
        }
      }
      const tooLong = structuredClone(config)
      tooLong.jammers[0]![field] = config.scenario.duration + 1
      expect(inspectScenarioConfig(tooLong, 'write').result.errors).toContainEqual(expect.objectContaining({ code: 'JAMMER_TIMING_INVALID', fieldPath: `jammers[0].${field}` }))
    }
  })

  it('执行证据合同保留单对象必填并允许非空复数数组', () => {
    const validate = templateSchema('FrameEvidence')
    const evidence = structuredClone(fixtureSource.frame.evidence)
    expect(validate(evidence)).toBe(true)
    expect(validate({ ...evidence, jammerExecutions: [evidence.jammerExecution] })).toBe(true)
    const { jammerExecution, ...missingRequired } = evidence
    expect(validate({ ...missingRequired, jammerExecutions: [jammerExecution] })).toBe(false)
    for (const jammerExecutions of [[], null, [null], [{ ...jammerExecution, extra: true }]]) {
      expect(validate({ ...evidence, jammerExecutions })).toBe(false)
    }
  })

  it('模板对照场景是完整的正向写入样例，并由冻结 ScenarioConfigWrite schema 接受', () => {
    const draft = createTemplateScenario()
    expect(inspectScenarioConfig(draft.config, 'write').result).toMatchObject({ valid: true, errors: [] })
    expect(templateSchema('ScenarioConfigWrite')(draft.config)).toBe(true)
  })

  it.each(['Link', 'LinkWrite'])('%s 兼容旧链路且只接受非激光的显式端口继承', schema => {
    const validate = templateSchema(schema)
    const links = config().links
    const microwave = links.find(link => link.type === 'MICROWAVE')!
    const laser = links.find(link => link.type === 'LASER')!
    expect(validate(microwave)).toBe(true)
    expect(validate({ ...microwave, inheritPortParameters: true })).toBe(true)
    for (const invalid of [false, null, 'true']) {
      expect(validate({ ...microwave, inheritPortParameters: invalid })).toBe(false)
    }
    expect(validate(laser)).toBe(true)
    expect(validate({ ...laser, inheritPortParameters: true })).toBe(false)
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
    expect(resolveTemplateLinkPorts(value, laser)).toMatchObject({
      status: 'WARNING',
      message: expect.stringContaining('lazer_link'),
    })
    const invalid = { ...datalink, type: 'MICROWAVE' as const }
    expect(resolveTemplateLinkPorts(value, invalid)).toMatchObject({ status: 'ERROR' })
    expect(inspectScenarioConfig({ ...value, links: [invalid] }, 'write').result.errors).toContainEqual(expect.objectContaining({ code: 'TEMPLATE_PORT_MAPPING_INVALID', fieldPath: 'links[0]' }))

    const satellite = value.links.find(link => link.id === 'L-SAT-05')!
    expect(resolveTemplateLinkPorts(value, satellite)).toMatchObject({ status: 'MAPPED', target: { portName: 'sat_link_a' } })
    expect(resolveTemplateLinkPorts(value, { ...satellite, direction: 'REVERSE' })).toMatchObject({ status: 'MAPPED', target: { portName: 'sat_link_b' } })
    const rearSource = { ...satellite, sourcePlatformId: satellite.targetPlatformId, targetPlatformId: satellite.sourcePlatformId }
    expect(resolveTemplateLinkPorts(value, rearSource)).toMatchObject({ status: 'MAPPED', source: { portName: 'sat_link_a' } })
    expect(resolveTemplateLinkPorts(value, { ...rearSource, direction: 'REVERSE' })).toMatchObject({ status: 'MAPPED', source: { portName: 'sat_link_b' } })

    const uavs = value.platforms.filter(platform => platform.type === 'FORWARD_RELAY_NODE' || platform.type === 'AIRBORNE_MISSION_CLUSTER')
    const relayUav = uavs[0]!
    const targetUav = uavs[1]!
    const relayUavMicrowave = { ...satellite, id: 'L-MW-RELAY', type: 'MICROWAVE' as const, sourcePlatformId: relayUav.id, targetPlatformId: targetUav.id, relayPlatformId: null }
    expect(resolveTemplateLinkPorts(value, relayUavMicrowave)).toMatchObject({
      status: 'MAPPED',
      source: { platformType: 'MISSION_UAV_PLATFORM', portName: 'microwave_link' },
      target: { platformType: 'MISSION_UAV_PLATFORM', portName: 'microwave_link' },
    })
    const relayUavDatalink = { ...datalink, id: 'L-DL-RELAY', sourcePlatformId: targetUav.id, targetPlatformId: relayUav.id, relayPlatformId: null }
    expect(resolveTemplateLinkPorts(value, relayUavDatalink)).toMatchObject({
      status: 'MAPPED',
      source: { platformType: 'MISSION_UAV_PLATFORM', portName: 'c_band_downlink' },
      target: { platformType: 'MISSION_UAV_PLATFORM', portName: 'c_band_downlink' },
    })
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

  it('commPorts 拒绝未知端口及设备类型/网络不匹配', () => {
    const value = config() as ScenarioConfig & { deviceParameters: NonNullable<ScenarioConfig['deviceParameters']> }
    value.deviceParameters = {
      commPorts: {
        MISSION_UAV_PLATFORM: {
          unknown: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
          microwave_link: { deviceType: 'WSF_COMM_TRANSCEIVER', network: 'FIBER_NET' },
        },
      },
    }
    const fields = inspectScenarioConfig(value, 'read').result.errors.map(error => error.fieldPath)
    expect(fields).toContain('deviceParameters.commPorts.MISSION_UAV_PLATFORM.unknown')
    expect(fields).toContain('deviceParameters.commPorts.MISSION_UAV_PLATFORM.microwave_link.deviceType')
    expect(fields).toContain('deviceParameters.commPorts.MISSION_UAV_PLATFORM.microwave_link.network')
  })

  it('冻结 schema 拒绝未知端口、非法来源字段和非正端口值，返回计划只强制 timeS 大于 0', () => {
    const validate = templateSchema('DeviceParameters')
    const port = { txFrequency: 1, txBandwidth: 1, txPower: 1, rxFrequency: 1, rxBandwidth: 1, noiseFigureDb: 0, transferRate: 1 }
    expect(validate({ ports: { MISSION_UAV_PLATFORM: { microwave_link: port } } })).toBe(true)
    expect(validate({ ports: { MISSION_UAV_PLATFORM: { unknown: port } } })).toBe(false)
    expect(validate({ ports: { MISSION_UAV_PLATFORM: { microwave_link: { ...port, txPower: 0 } } } })).toBe(false)
    expect(validate({ ports: { MISSION_UAV_PLATFORM: { microwave_link: { ...port, parameterSource: { kind: 'EQUIPMENT', sourceId: 'EQ-1', sourceVersion: 1, fields: ['modulation'] } } } } })).toBe(false)
    expect(validate({ ports: { MISSION_UAV_PLATFORM: { microwave_link: { ...port, parameterSource: { kind: 'MASTER_DATA', sourceId: 'MD-1', sourceVersion: 1, fields: ['frequency', 'noiseFigureDb'] } } } } })).toBe(true)
    expect(validate({ commPorts: { MISSION_UAV_PLATFORM: { microwave_link: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' } } } })).toBe(true)
    expect(validate({ commPorts: { MISSION_UAV_PLATFORM: { unknown: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' } } } })).toBe(false)

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


it('11-06 可选参数兼容旧场景，读取仅补副本且显式值优先', async () => {
  const { readJammerParameters, JAMMER_CALC_DEFAULTS } = await import('../../src/features/scenarios/jammer-settings')
  const { readLinkCalcSettings } = await import('../../src/features/scenarios/link-calc-defaults')
  const { readLinkSettings } = await import('../../src/features/scenarios/link-settings')
  const old = createTemplateScenario().config, before = structuredClone(old)
  expect(templateSchema('ScenarioConfigWrite')(old)).toBe(true)
  for (const mode of ['read', 'write'] as const) expect(inspectScenarioConfig(old, mode).result.valid).toBe(true)
  expect(readLinkSettings(old).messageIntervalS).toBe(5)
  expect(readLinkCalcSettings(old.linkSettings?.linkCalc).updateIntervalS).toBe(5)
  expect(readJammerParameters(old.jammers[0]!)).toMatchObject(JAMMER_CALC_DEFAULTS)
  const parameters = readDeviceParameters(old)
  expect(parameters.ports.MISSION_UAV_PLATFORM!.microwave_link).toMatchObject({ txBandwidth: 50, rxBandwidth: 50, eirpDbw: 30, gtDbk: -3 })
  expect(parameters.ports.MISSION_UAV_PLATFORM!.sat_link).toMatchObject({ eirpDbw: 5, gtDbk: -14 })
  expect(parameters.ports.COMMAND_VEHICLE_PLATFORM!.l_band_uplink).toMatchObject({ eirpDbw: 26, gtDbk: -6 })
  expect(parameters.ports.COMMAND_VEHICLE_PLATFORM!.fiber_link).not.toHaveProperty('eirpDbw')
  expect(parameters.antennaGains).toMatchObject({ OMNI_ANTENNA: 30, L_BAND_DIRECTIONAL_VEHICLE_ANTENNA: 25, L_BAND_DIRECTIONAL_UAV_ANTENNA: 25 })
  old.deviceParameters = { ports: { MISSION_UAV_PLATFORM: { microwave_link: { ...parameters.ports.MISSION_UAV_PLATFORM!.microwave_link!, txBandwidth: 50, eirpDbw: -2, gtDbk: 0 } } } }
  expect(readDeviceParameters(old).ports.MISSION_UAV_PLATFORM!.microwave_link).toMatchObject({ txBandwidth: 50, eirpDbw: -2, gtDbk: 0 })
  Object.assign(old.jammers[0]!, { radarPower: 200, gtDbk: 0 })
  expect(readJammerParameters(old.jammers[0]!)).toMatchObject({ radarPower: 200, gtDbk: 0 })
  delete old.deviceParameters
  delete old.jammers[0]!.radarPower; delete old.jammers[0]!.gtDbk
  expect(old).toEqual(before)
})

it('11-06 新键保持闭合校验：有限数、正周期、正雷达功率/带宽及占空比边界', () => {
  const validate = templateSchema('ScenarioConfigWrite')
  const candidate = createTemplateScenario().config
  candidate.deviceParameters = { ports: { MISSION_UAV_PLATFORM: { microwave_link: readDeviceParameters(candidate).ports.MISSION_UAV_PLATFORM!.microwave_link! } } }
  candidate.linkSettings!.linkCalc = { emergencyThreshold: 1e-5, warningThreshold: 1e-6, valueThresholdBer: 1e-7, jammingRangeKm: 30, channelEncodingScheme: 0 }
  const targets: [object, string, boolean, number?][] = [
    [candidate.deviceParameters.ports!.MISSION_UAV_PLATFORM!.microwave_link!, 'eirpDbw', false],
    [candidate.deviceParameters.ports!.MISSION_UAV_PLATFORM!.microwave_link!, 'gtDbk', false],
    [candidate.linkSettings!, 'messageIntervalS', true], [candidate.linkSettings!.linkCalc!, 'updateIntervalS', true],
    ...['radarFrequency', 'noiseFigureDb', 'gtDbk', 'eirpDbw', 'antennaGainDbi', 'txLossDb'].map(key => [candidate.jammers[0]!, key, false] as [object, string, boolean]),
    [candidate.jammers[0]!, 'radarBandwidth', true], [candidate.jammers[0]!, 'radarPower', true], [candidate.jammers[0]!, 'sweepDutyCycle', true, 1],
  ]
  for (const [target, key, positive, max] of targets) {
    const value = target as Record<string, unknown>, saved = value[key]
    for (const invalid of [null, '1', [], {}, NaN, Infinity, ...(positive ? [0, -1] : []), ...(max ? [1.1] : [])]) {
      value[key] = invalid
      if (typeof invalid !== 'number' || Number.isFinite(invalid)) expect(validate(candidate), key).toBe(false)
      for (const mode of ['read', 'write'] as const) expect(inspectScenarioConfig(candidate, mode).result.errors.some(issue => issue.fieldPath?.endsWith(`.${key}`)), key).toBe(true)
    }
    value[key] = positive ? 0.5 : -3
    expect(validate(candidate), JSON.stringify(validate.errors)).toBe(true)
    expect(inspectScenarioConfig(candidate, 'write').result.valid).toBe(true)
    if (saved === undefined) delete value[key]; else value[key] = saved
  }
  candidate.deviceParameters.ports!.MISSION_UAV_PLATFORM!.microwave_link!.parameterSource = { kind: 'EQUIPMENT', sourceId: 'EQ-1', sourceVersion: 1, fields: ['eirpDbw'] as never }
  expect(validate(candidate)).toBe(false)
  expect(inspectScenarioConfig(candidate, 'write').result.valid).toBe(false)
})

it('11-06 扩展不放宽 V1.2 干扰功率档位和正带宽校验，同类雷达差异不会静默采用首台', () => {
  const draft = createTemplateScenario()
  for (const patch of [{ defaultPower: 2 }, { bandwidth: 0 }]) {
    const config = structuredClone(draft.config)
    Object.assign(config.jammers[0]!, patch)
    expect(inspectScenarioConfig(config, 'write').result.errors).toContainEqual(expect.objectContaining({ code: 'defaultPower' in patch ? 'JAMMER_POWER_OUT_OF_RANGE' : 'JAMMER_BANDWIDTH_INVALID' }))
  }
  const platform = structuredClone(draft.config.platforms.find(p => p.id === draft.config.jammers[0]!.platformId)!)
  platform.id = 'second-ground'; platform.jammerIds = ['JAM-SECOND']
  draft.config.platforms.push(platform)
  draft.config.jammers.push({ ...draft.config.jammers[0]!, id: 'JAM-SECOND', platformId: platform.id, radarPower: 101 })
  expect(inspectScenarioConfig(draft.config, 'write').result.errors).toContainEqual(expect.objectContaining({ code: 'JAMMER_PLATFORM_PARAMETER_CONFLICT', fieldPath: 'jammers[2].radarPower' }))
})

it('deriveCommPortsFromLinks 自动推导激活端口，校验跳过已禁用链路并检查中继/LASER 端口，applyLinkEdit 自动同步显式清单', () => {
  const draft = createTemplateScenario()
  const config = draft.config
  config.links.push({
    id: 'sat_disabled',
    type: 'SAT',
    sourcePlatformId: 'rear_comm_vehicle',
    targetPlatformId: 'mission_uav_02',
    relayPlatformId: 'tiantong_sat',
    direction: 'FORWARD',
    dataRate: 16,
    frequency: 14200,
    bandwidth: 20,
    txPower: 20,
    rxFrequency: 11800,
    rxBandwidth: 20,
    antennaGain: { tx: 25, rx: 25 },
    modulation: 'QPSK',
    berThreshold: 1e-6,
    enabled: false,
  })
  for (const id of ['rear_comm_vehicle', 'mission_uav_02', 'tiantong_sat']) {
    config.platforms.find(platform => platform.id === id)!.linkIds.push('sat_disabled')
  }
  const derivedWithDisabled = deriveCommPortsFromLinks(config)
  expect(Object.keys(derivedWithDisabled.TIAN_TONG_SAT ?? {})).toEqual([])
  expect(Object.keys(derivedWithDisabled.MISSION_UAV_PLATFORM ?? {})).toEqual(['c_band_uplink', 'c_band_downlink'])

  // 显式清单缺少已被禁用的卫星端口时不应报 COMM_PORT_NOT_CONFIGURED。
  config.deviceParameters = {
    commPorts: {
      MISSION_UAV_PLATFORM: {
        c_band_uplink: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
        c_band_downlink: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
      },
      TIAN_TONG_SAT: {},
    },
  }
  expect(inspectScenarioConfig(config, 'write').result.errors.some(e => e.code === 'COMM_PORT_NOT_CONFIGURED')).toBe(false)

  // 启用卫星链路时必须校验中继平台 TIAN_TONG_SAT.sat_link。
  config.links[config.links.length - 1]!.enabled = true
  expect(inspectScenarioConfig(config, 'write').result.errors).toContainEqual(expect.objectContaining({
    code: 'COMM_PORT_NOT_CONFIGURED',
    fieldPath: `links[${config.links.length - 1}]`,
  }))

  // 启用 LASER 链路时必须校验 MISSION_UAV_PLATFORM.lazer_link。
  config.links[config.links.length - 1]!.enabled = false
  config.links.push({
    id: 'laser_1',
    type: 'LASER',
    sourcePlatformId: 'mission_uav_02',
    targetPlatformId: 'mission_uav_03',
    direction: 'FORWARD',
    dataRate: 2500,
    frequency: 681300000,
    bandwidth: 1000,
    txPower: 0.1,
    antennaGain: { tx: 45, rx: 45 },
    modulation: 'BPSK',
    berThreshold: 1e-6,
    enabled: true,
  })
  expect(inspectScenarioConfig(config, 'write').result.errors).toContainEqual(expect.objectContaining({
    code: 'COMM_PORT_NOT_CONFIGURED',
    fieldPath: `links[${config.links.length - 1}]`,
  }))

  // applyLinkEdit 保存新增的微波链路时自动补齐显式 commPorts 中的 microwave_link。
  config.links.pop()
  applyLinkEdit(config, {
    id: 'mw_1',
    type: 'MICROWAVE',
    sourcePlatformId: 'rear_comm_vehicle',
    targetPlatformId: 'mission_uav_02',
    direction: 'REVERSE',
    dataRate: 80,
    frequency: 8200,
    bandwidth: 20,
    txPower: 20,
    antennaGain: { tx: 18, rx: 3 },
    modulation: 'QPSK',
    berThreshold: 1e-6,
    enabled: true,
  }, {
    ...config.informationDemand[0]!,
    id: 'DEMAND-MW-1',
    linkId: 'mw_1',
    sourcePlatformId: 'rear_comm_vehicle',
    destinationPlatformIds: ['mission_uav_02'],
    direction: 'REVERSE',
  })
  expect(Object.keys(config.deviceParameters.commPorts!.MISSION_UAV_PLATFORM!)).toContain('microwave_link')
})

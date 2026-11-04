// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createTemplateScenario } from '../fixtures/template-scenario'

const { buildMissionPackage, MissionGenerationError } = await import('../../server/scripts/' + 'mission-generator.js')

describe('2026-11-01 模板脚本生成器', () => {
  it('总是生成模板固定的通信平台、共享端口与附带脚本', () => {
    const draft = createTemplateScenario()
    const generated = buildMissionPackage(draft)
    expect(Object.keys(generated.files)).toEqual(expect.arrayContaining([
      'comm_SimSetup.txt', 'comm_PerDefinition.txt', 'comm_platform_COMMAND_VEHICLE.txt',
      'comm_platform_MISSION_UAV.txt', 'comm_platform_JAMMER.txt', 'comm_platform_REAR.txt',
      'comm_platform_SAT.txt', 'comm_platform_INS.txt', 'observers.txt', 'ad_hoc_comm.txt',
      'scenario.txt', 'mapping.json', 'input.json', 'README.txt',
    ]))
    expect(generated.files['comm_platform_MISSION_UAV.txt']).toContain('comm c_band_uplink WSF_RADIO_TRANSCEIVER')
    expect(generated.files['comm_platform_MISSION_UAV.txt']).toContain('transfer_rate constant 2000000 bit/s')
    expect(generated.files['comm_platform_REAR.txt']).toContain('add processor link_calc WSF_LINK_CALC_PROCESSOR')
    expect(generated.files['comm_SimSetup.txt']).not.toContain('COMM_TURNED_OFF')
    expect(generated.files['comm_SimSetup.txt']).not.toContain('WEAPON_TURNED_OFF')
    expect(generated.manifest.devices.every((device: { source: { deviceId: string }; target: { deviceId: string } }) => !device.source.deviceId.startsWith('comm_') && !device.target.deviceId.startsWith('comm_'))).toBe(true)
  })

  it('端点不符合模板端口映射时阻断生成，不因旧链路兼容而改写端口', () => {
    const draft = createTemplateScenario()
    draft.config.links[0]!.sourcePlatformId = 'tiantong_sat'
    expect(() => buildMissionPackage(draft)).toThrow(MissionGenerationError)
  })

  it('新模板不存在的激光端口只列为警告，不生成替代设备', () => {
    const draft = createTemplateScenario()
    draft.config.links[0] = {
      ...draft.config.links[0]!, type: 'LASER', enabled: true,
      laser: { txApertureDiameterM: 0.1, rxApertureDiameterM: 0.1, pulseWidthS: 1e-8, modulation: 'OOK' },
    }
    draft.config.informationDemand[0]!.volumeMb = 123 / 8_000_000
    const generated = buildMissionPackage(draft)
    expect(generated.manifest.warnings).toContainEqual(expect.stringContaining('激光链路'))
    expect(generated.manifest.warnings).toContainEqual(expect.stringContaining('informationDemand[0]'))
    expect(generated.manifest.retainedButNotEmitted).toContainEqual(expect.stringContaining('informationDemand[0]'))
    expect(generated.manifest.devices).not.toContainEqual(expect.objectContaining({ linkId: draft.config.links[0]!.id }))
    expect(generated.files['comm_platform_MISSION_UAV.txt']).not.toContain('WSF_LASER_TRANSCEIVER')
    expect(generated.files['comm_platform_REAR.txt']).not.toContain('"data_volume_bits":123')
  })

  it('仅过滤多接收端业务中的激光-only 目标，保留其他非激光目标', () => {
    const draft = createTemplateScenario()
    const laserLink = draft.config.links.find(item => item.id === 'c_forward_uav2')!
    Object.assign(laserLink, {
      type: 'LASER',
      laser: { txApertureDiameterM: 0.1, rxApertureDiameterM: 0.1, pulseWidthS: 1e-8, modulation: 'OOK' },
    })
    delete laserLink.band
    Object.assign(draft.config.informationDemand[0]!, {
      sourcePlatformId: 'command_vehicle',
      destinationPlatformIds: ['mission_uav_02', 'mission_uav_03'],
      volumeMb: 123 / 8_000_000,
    })

    const generated = buildMissionPackage(draft)
    const traffic = JSON.parse(generated.files['comm_platform_REAR.txt'].match(/traffic_type (.+)\n/u)![1]!) as Array<Record<string, { forward: Array<{ data_volume_bits: number }> }>>
    expect(generated.manifest.warnings).toContainEqual(expect.stringContaining('informationDemand[0].destinationPlatformIds[0]'))
    expect(traffic.find(item => item.mission_uav_02)?.mission_uav_02.forward.some(item => item.data_volume_bits === 123)).toBe(false)
    expect(traffic.find(item => item.mission_uav_03)?.mission_uav_03.forward.some(item => item.data_volume_bits === 123)).toBe(true)
  })

  it.each(['../outside', 'out ', 'NUL', 'out\u0000csv'])('拒绝危险输出目录 %j', directory => {
    const draft = createTemplateScenario()
    draft.config.output.directory = directory
    expect(() => buildMissionPackage(draft, draft.config.output)).toThrow('output.directory')
  })

  it('拒绝会注入脚本的实体编号，并保留连字符避免与下划线编号碰撞', () => {
    const unsafe = createTemplateScenario()
    unsafe.config.platforms[0]!.id = 'unsafe\nend_platform'
    expect(() => buildMissionPackage(unsafe)).toThrow('platforms[0].id')

    const draft = createTemplateScenario()
    const clone = structuredClone(draft.config.platforms.find(item => item.id === 'mission_uav_02')!)
    clone.id = 'A-B'; clone.linkIds = []; clone.returnPlan = { timeS: 100, waypoints: [{ ...clone.initialPosition, speed: 100 }] }
    const twin = structuredClone(clone); twin.id = 'A_B'
    draft.config.platforms.push(clone, twin)
    const generated = buildMissionPackage(draft)
    expect(generated.files['comm_platform_INS.txt']).toContain('route return_A-B')
    expect(generated.files['comm_platform_INS.txt']).toContain('route return_A_B')
  })

  it('保留输入不变，并将运行时间、端口和天线参数同时写入设备定义与 link_calc', () => {
    const draft = createTemplateScenario()
    draft.config.scenario.realtime = false
    draft.config.scenario.environment.simClockSpeed = 16
    draft.config.deviceParameters = {
      ports: { MISSION_UAV_PLATFORM: { c_band_uplink: {
        txFrequency: 4600, txBandwidth: 12, txPower: 21, rxFrequency: 4600, rxBandwidth: 12, noiseFigureDb: 4, transferRate: 3,
      } } },
      antennaGains: { C_BAND_DIRECTIONAL_UAV_ANTENNA: 27 },
    }
    const before = structuredClone(draft)
    const generated = buildMissionPackage(draft)
    expect(generated.files['comm_SimSetup.txt']).toContain('non-realtime')
    expect(generated.files['comm_SimSetup.txt']).toContain('clock_rate 16')
    expect(generated.files['comm_platform_MISSION_UAV.txt']).toContain('frequency 4.6 GHz')
    expect(generated.files['comm_PerDefinition.txt']).toContain('peak_gain 27 dB')
    const mapping = JSON.parse(generated.files['mapping.json'])
    expect(mapping).toEqual(expect.objectContaining({ scenarioStartTime: expect.objectContaining({ engineEmitted: true }) }))
    expect(generated.files['comm_platform_REAR.txt']).toContain('"frequency_ghz":4.6')
    expect(generated.files['comm_platform_REAR.txt']).toContain('"peak_gain_dB":27')
    expect(draft).toEqual(before)
  })

  it('按配置保留返航、盘旋、干扰参数，并过滤关闭链路', () => {
    const draft = createTemplateScenario()
    draft.config.links[0]!.enabled = false
    const generated = buildMissionPackage(draft)
    const instances = generated.files['comm_platform_INS.txt']
    expect(instances).toContain('route return_mission_uav_02')
    expect(instances).toContain('label LOITER')
    expect(instances).toContain('double detection_range_nm = 30;')
    expect(generated.manifest.devices).not.toContainEqual(expect.objectContaining({ linkId: draft.config.links[0]!.id }))
  })

  it('卫星中继链路使用卫星原生端口，且无航迹节点不虚构速度', () => {
    const draft = createTemplateScenario()
    const satelliteLink = {
      ...draft.config.links[1]!,
      id: 'satellite_relay',
      type: 'SAT' as const,
      sourcePlatformId: 'rear_comm_vehicle',
      targetPlatformId: 'mission_uav_02',
      relayPlatformId: 'tiantong_sat',
    }
    delete satelliteLink.band
    draft.config.links.push(satelliteLink)
    for (const platformId of ['rear_comm_vehicle', 'mission_uav_02', 'tiantong_sat']) {
      draft.config.platforms.find(item => item.id === platformId)!.linkIds.push(satelliteLink.id)
    }
    const relay = draft.config.platforms.find(item => item.id === 'mission_uav_01')!
    relay.waypoints = []
    delete relay.loiterWaypoints

    const generated = buildMissionPackage(draft)
    const relayDevice = generated.manifest.devices.find((item: { linkId: string }) => item.linkId === satelliteLink.id) as { relayDeviceId: string }
    expect(relayDevice.relayDeviceId).toBe('sat_link')
    expect(generated.files['comm_platform_INS.txt']).toContain('platform mission_uav_01 MISSION_UAV_PLATFORM\n  side blue\n  icon F-18\n  heading 90 deg\n  route\n    position')
    expect(generated.files['comm_platform_INS.txt']).not.toContain('platform mission_uav_01 MISSION_UAV_PLATFORM\n  side blue\n  icon F-18\n  heading 90 deg\n  route\n    position 119.55e 24.66n altitude 3200 m heading 0 deg speed 1 m/s')
  })

  it('展开多接收端业务，并按既有业务类型推断旧业务方向', () => {
    const draft = createTemplateScenario()
    const forward = draft.config.informationDemand.find(item => item.informationType === '态势信息')!
    forward.destinationPlatformIds = ['mission_uav_02', 'mission_uav_03']
    delete forward.direction
    const reverse = draft.config.informationDemand.find(item => item.informationType === '侦察信息')!
    delete reverse.direction

    const generated = buildMissionPackage(draft)
    const traffic = JSON.parse(generated.files['comm_platform_REAR.txt'].match(/traffic_type (.+)\n/u)![1]!) as Array<Record<string, { forward: unknown[]; return: unknown[] }>>
    expect(traffic.find(item => item.mission_uav_02)?.mission_uav_02.forward).not.toHaveLength(0)
    expect(traffic.find(item => item.mission_uav_03)?.mission_uav_03.forward).not.toHaveLength(0)
    expect(traffic.find(item => item.mission_uav_02)?.mission_uav_02.return).not.toHaveLength(0)
  })
})


it('D1 运动及指向配置仅记录清单，所有 TXT 字节保持不变', () => {
  const draft = createTemplateScenario()
  const baseline = buildMissionPackage(draft)
  const platform = draft.config.platforms.find(item => item.waypoints.length > 0)!
  Object.assign(platform.waypoints[0]!, { arrivalTime: 123, heading: 217, acceleration: -0.5 })
  Object.assign(draft.uiExtensions.jammers[0]!, { direction: 135, elevation: 30 })
  const generated = buildMissionPackage(draft)
  const mapping = JSON.parse(generated.files['mapping.json']!)
  expect(mapping.motion.find((item: { platformId: string }) => item.platformId === platform.id).waypoints[0]).toEqual({
    longitude: platform.waypoints[0]!.longitude, latitude: platform.waypoints[0]!.latitude,
    altitude: platform.waypoints[0]!.altitude, speed: platform.waypoints[0]!.speed,
    arrivalTimeS: 123, headingDeg: 217, accelerationMps2: -0.5, arrivalTimeEnforced: false, headingEnforced: false,
  })
  expect(mapping.jammerPointing[0]).toEqual({ jammerId: draft.uiExtensions.jammers[0]!.jammerId,
    directionDeg: 135, elevationDeg: 30, directionEngineMapped: false, elevationEngineMapped: false })
  expect(mapping.retainedButNotEmitted).toEqual(expect.arrayContaining(['航点航向/加速度/到达时间', '干扰方位角/俯仰角']))
  for (const [name, content] of Object.entries(baseline.files)) {
    if (name.endsWith('.txt')) expect(generated.files[name], name).toBe(content)
  }
})

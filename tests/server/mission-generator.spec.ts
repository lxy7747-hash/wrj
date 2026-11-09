// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createRenamedTemplateScenario, createTemplateScenario } from '../fixtures/template-scenario'

const { buildMissionPackage, MissionGenerationError, engineNames } = await import('../../server/scripts/' + 'mission-generator.js')

describe('2026-11-01 模板脚本生成器', () => {

  it('时序仅进入本地 stub；对接方全部原生 TXT 与未设置时逐字节一致', () => {
    const draft = createTemplateScenario()
    const before = buildMissionPackage(draft).files
    draft.config.jammers[0]!.detectionDelayS = 6
    draft.config.jammers[0]!.jammingDurationS = 9
    draft.config.jammers[1]!.detectionDelayS = 0
    draft.config.jammers[1]!.jammingDurationS = 3
    const after = buildMissionPackage(draft).files
    for (const [name, content] of Object.entries(before)) {
      if (name.endsWith('.txt')) expect(after[name], name).toBe(content)
    }
    const local = buildMissionPackage(draft, undefined, { linkCalc: 'STUB' }).files
    const rear = local['comm_platform_REAR.txt']!
    for (const i of [0, 1]) {
      expect(rear).toContain(`bool engaged${i} = false;`)
      expect(rear).toContain(`double detectAt${i} = -1;`)
      expect(rear).toContain(`double onAt${i} = -1;`)
      expect(rear).toContain(`bool spent${i} = false;`)
      expect(rear).toContain(`if (!engaged${i} && !spent${i})`)
      expect(rear).toContain(`engaged${i} = false; spent${i} = true; detectAt${i} = -1;`)
      expect(rear).toContain(`else { detectAt${i} = -1; }`)
    }
    expect(rear).toContain('if (TIME_NOW - detectAt0 >= 6)')
    expect(rear).toContain('else if (TIME_NOW - onAt0 >= 9)')
    expect(rear).toContain('if (TIME_NOW - detectAt1 >= 0)')
    expect(rear).toContain('else if (TIME_NOW - onAt1 >= 3)')
    expect(rear).toContain('if (nearest0 >= 0)')
    expect(rear).toContain('execute at_interval_of 3 sec')
    expect(JSON.parse(local['mapping.json']!).localRuntime.note).toContain('±3 秒')
    const localDependencies = JSON.parse(local['mapping.json']!).executionStatus.dependencyUnconfirmed as Array<{ fieldPath: string }>
    expect(localDependencies.some(item => item.fieldPath === 'linkSettings.linkCalc' || item.fieldPath.startsWith('definitions.antennaPatterns.') || item.fieldPath.startsWith('jammers['))).toBe(false)
  })

  it('未设置时序：到达触发半径立即开启，离开释放半径关闭，不添加持续时长限制', () => {
    const draft = createTemplateScenario()
    const generated = buildMissionPackage(draft, undefined, { linkCalc: 'STUB' })
    const rear = generated.files['comm_platform_REAR.txt']!
    expect(rear).toContain(`if (${draft.config.jammers[0]!.jammingRange} > 0 && nearest0 <= ${draft.config.jammers[0]!.jammingRange})`)
    expect(rear).toContain('if (TIME_NOW - detectAt0 >= 0)')
    expect(rear).toContain('if (!weapon0.IsTurnedOn()) { weapon0.TurnOn(); }')
    expect(rear).toContain('weapon0.SelectMode("broadband_jamming");')
    expect(rear).toContain('weapon0.SelectMode("default"); weapon0.TurnOff();')
    expect(rear).not.toContain('else if (TIME_NOW - onAt')
    for (const jammer of generated.manifest.jammers) {
      expect(jammer).not.toHaveProperty('detectionDelayS')
      expect(jammer).not.toHaveProperty('jammingDurationS')
    }
  })

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

  it('逐项记录当前配置进入脚本、仅保留快照和具体待确认依赖，且不把停用链路写成已执行', () => {
    const draft = createTemplateScenario()
    const enabled = draft.config.links.find(link => link.type !== 'LASER')!
    const disabled = draft.config.links.find(link => link.id !== enabled.id)!
    disabled.enabled = false
    const platform = draft.config.platforms.find(item => item.waypoints.length > 0)!
    Object.assign(platform.waypoints[0]!, { arrivalTime: 12, heading: 30 })
    const mapping = JSON.parse(buildMissionPackage(draft).files['mapping.json']!)
    expect(mapping.executionStatus.emitted).toContainEqual(expect.objectContaining({ fieldPath: 'scenario.startTime' }))
    expect(mapping.executionStatus.emitted).toContainEqual(expect.objectContaining({ fieldPath: `links[${draft.config.links.indexOf(enabled)}]` }))
    expect(mapping.executionStatus.emitted).not.toContainEqual(expect.objectContaining({ fieldPath: `links[${draft.config.links.indexOf(disabled)}]` }))
    expect(mapping.executionStatus.retainedSnapshot).toContainEqual(expect.objectContaining({ fieldPath: `platforms[${draft.config.platforms.indexOf(platform)}].waypoints[0].arrivalTime` }))
    expect(mapping.executionStatus.dependencyUnconfirmed).toContainEqual(expect.objectContaining({ fieldPath: 'definitions.antennaPatterns.MICRO_REAR_PLATFORM_DIR_ANTENNA' }))
    expect(mapping.executionStatus.dependencyUnconfirmed).toContainEqual(expect.objectContaining({ fieldPath: 'linkSettings.linkCalc' }))
  })

  it('无航路、停用 ESM/激光/干扰项不误报，已支持的全局 LinkCalc 参数列为写入', () => {
    const draft = createTemplateScenario()
    const rear = draft.config.platforms.find(platform => platform.type === 'REAR_COMMAND_NODE')!
    rear.waypoints = []
    draft.config.jammingEnabled = false
    draft.uiExtensions.jammers.forEach(extension => { extension.enabled = false })
    draft.config.sensors = [{ id: 'esm-off', platformId: rear.id, frequencyRange: { min: 1, max: 2 }, detectionRange: 1 }]
    draft.uiExtensions.sensors = [{ sensorId: 'esm-off', type: 'ESM', direction: 'OMNI', probability: 1, enabled: false }]
    const mapping = JSON.parse(buildMissionPackage(draft).files['mapping.json']!)
    const retained = mapping.executionStatus.retainedSnapshot as Array<{ fieldPath: string }>
    const tiantong = draft.config.platforms.find(platform => platform.type === 'COMMUNICATION_SATELLITE' && platform.satelliteType === 'TIANTONG')!
    expect(mapping.executionStatus.emitted).toContainEqual(expect.objectContaining({ fieldPath: 'linkSettings.linkCalc' }))
    expect(mapping.executionStatus.emitted).not.toContainEqual(expect.objectContaining({ fieldPath: `platforms[${draft.config.platforms.indexOf(rear)}].waypoints` }))
    expect(mapping.executionStatus.emitted).not.toContainEqual(expect.objectContaining({ fieldPath: `platforms[${draft.config.platforms.indexOf(tiantong)}].waypoints` }))
    expect(retained).not.toContainEqual(expect.objectContaining({ fieldPath: `platforms[${draft.config.platforms.indexOf(tiantong)}].waypoints` }))
    expect(retained.some(item => item.fieldPath.startsWith('sensors['))).toBe(false)
    expect(retained.some(item => item.fieldPath.startsWith('uiExtensions.jammers['))).toBe(false)
    expect(retained.some(item => item.fieldPath.startsWith('links['))).toBe(false)
  })

  it('允许巡逻航路的平台只标为已写入，不同时列为快照', () => {
    const draft = createTemplateScenario()
    const uav = draft.config.platforms.find(platform => platform.type === 'AIRBORNE_MISSION_CLUSTER')!
    uav.loiterWaypoints = [{ longitude: 118.7, latitude: 25, altitude: 100, speed: 20 }, { longitude: 118.8, latitude: 25.1, altitude: 100, speed: 20 }]
    const mapping = JSON.parse(buildMissionPackage(draft).files['mapping.json']!)
    const fieldPath = `platforms[${draft.config.platforms.indexOf(uav)}].loiterWaypoints`
    expect(mapping.executionStatus.emitted).toContainEqual(expect.objectContaining({ fieldPath }))
    expect(mapping.executionStatus.retainedSnapshot).not.toContainEqual(expect.objectContaining({ fieldPath }))
  })

  it('瞄准式按配置写入 5 MHz，spot_bandwidth_mhz 同步为 5', () => {
    const draft = createTemplateScenario()
    Object.assign(draft.config.jammers[0]!, { type: 'SPOT', bandwidth: 5, frequency: draft.config.links[0]!.frequency })
    const generated = buildMissionPackage(draft)
    const parameters = JSON.parse(generated.files['comm_platform_REAR.txt'].match(/jammer_param (.+)\n/u)![1]!)
    expect(parameters.jammers[0]).toMatchObject({ power_w: 1000, weapon_power_w: 1, weapon_bandwidth_mhz: 5,
      spot_bandwidth_mhz: 5, sweep_duty_cycle: 0.1, weapon_antenna_gain_dbi: 0, tx_loss_db: 0 })
    const ground = buildMissionPackage(draft, undefined, { linkCalc: 'PRESERVE' }).files['comm_platform_JAMMER.txt']!.split('end_platform_type')[0]!
    expect(ground).toContain('bandwidth 5 MHz')
    expect(ground).toContain('power 1 W')
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

  it('拒绝非法实体编号，原编号不同的实体生成独立的模板实例和返航路线', () => {
    const unsafe = createTemplateScenario()
    unsafe.config.platforms[0]!.id = 'unsafe\nend_platform'
    expect(() => buildMissionPackage(unsafe)).toThrow('platforms[0].id')

    const draft = createTemplateScenario()
    const clone = structuredClone(draft.config.platforms.find(item => item.id === 'mission_uav_02')!)
    clone.id = 'A-B'; clone.linkIds = []; clone.returnPlan = { timeS: 100, waypoints: [{ ...clone.initialPosition, speed: 100 }] }
    const twin = structuredClone(clone); twin.id = 'A_B'
    draft.config.platforms.push(clone, twin)
    const generated = buildMissionPackage(draft)
    expect(generated.files['comm_platform_INS.txt']).toContain('route return_mission_uav_04')
    expect(generated.files['comm_platform_INS.txt']).toContain('route return_mission_uav_05')
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

it('界面编号统一换为模板实例名，中继优先，端点/业务/干扰/清单一致且原草稿不变', () => {
  const draft = createRenamedTemplateScenario()
  const config = draft.config
  const relay = config.platforms.find(item => item.type === 'FORWARD_RELAY_NODE')!
  const rear = config.platforms.find(item => item.type === 'REAR_COMMAND_NODE')!
  const uavs = config.platforms.filter(item => item.type === 'AIRBORNE_MISSION_CLUSTER')
  const satellite = config.platforms.find(item => item.satelliteType === 'TIANTONG')!
  const link = { ...config.links[1]!, id: 'sat-relay-test', type: 'SAT' as const,
    sourcePlatformId: rear.id, targetPlatformId: uavs[0]!.id, relayPlatformId: satellite.id }
  delete link.band
  config.links.push(link)
  for (const platform of [rear, uavs[0]!, satellite]) platform.linkIds.push(link.id)
  const before = structuredClone(draft)
  const generated = buildMissionPackage(draft)
  const mapping = JSON.parse(generated.files['mapping.json']!)
  expect(config.platforms.map(item => item.id)).toEqual([
    'PLAT-001', 'PLAT-002', 'SUP-001', 'SUP-002', 'PLAT-003', 'mission_uav_01', 'PLAT-005', 'SUP-003', 'SUP-004',
  ])
  expect(relay.id).toBe('PLAT-005')
  expect(mapping.platforms.map(({ platformId, name }: { platformId: string; name: string }) => ({ platformId, name }))).toEqual([
    { platformId: 'PLAT-001', name: 'rear_comm_vehicle' },
    { platformId: 'PLAT-002', name: 'command_vehicle' },
    { platformId: 'SUP-001', name: 'tiantong_sat' },
    { platformId: 'SUP-002', name: 'shentong_sat' },
    { platformId: 'PLAT-003', name: 'mission_uav_02' },
    { platformId: 'mission_uav_01', name: 'mission_uav_03' },
    { platformId: 'PLAT-005', name: 'mission_uav_01' },
    { platformId: 'SUP-003', name: 'jammer_station_01' },
    { platformId: 'SUP-004', name: 'jammer_airborne_01' },
  ])
  for (const name of ['mission_uav_01', 'mission_uav_02', 'mission_uav_03', 'rear_comm_vehicle', 'command_vehicle', 'tiantong_sat', 'shentong_sat', 'jammer_station_01', 'jammer_airborne_01']) {
    expect(generated.files['comm_platform_INS.txt']).toContain(`platform ${name} `)
  }
  expect(JSON.parse(generated.files['comm_platform_REAR.txt']!.match(/relay_uav_names (.+)\n/u)![1]!)).toEqual(['mission_uav_01'])
  for (const [name, value] of Object.entries(generated.files)) if (name.endsWith('.txt')) expect(value, name).not.toMatch(/PLAT-|SUP-/)
  expect(mapping.devices.find((item: { linkId: string }) => item.linkId === link.id)).toMatchObject({
    source: { platformId: 'rear_comm_vehicle' }, target: { platformId: 'mission_uav_02' }, relayPlatformId: 'tiantong_sat',
  })
  expect(mapping.jammers.map((item: { platformId: string }) => item.platformId)).toEqual(['jammer_station_01', 'jammer_airborne_01'])
  expect(JSON.stringify([mapping.businesses, mapping.motion])).not.toMatch(/PLAT-|SUP-/)
  expect(JSON.parse(generated.files['input.json']!)).toEqual(before)
  expect(draft).toEqual(before)
  expect(buildMissionPackage(draft).files).toEqual(generated.files)
})

it('两架中继连续占用 01/02，作业无人机从 03 起；同类按配置顺序编号', () => {
  const draft = createRenamedTemplateScenario()
  const relay = draft.config.platforms.find(item => item.type === 'FORWARD_RELAY_NODE')!
  const extra = { ...structuredClone(relay), id: 'PLAT-006', name: '第二架中继' }
  draft.config.platforms.push(extra)
  const generated = buildMissionPackage(draft)
  expect(JSON.parse(generated.files['comm_platform_REAR.txt']!.match(/relay_uav_names (.+)\n/u)![1]!)).toEqual(['mission_uav_01', 'mission_uav_02'])
  expect(generated.manifest.platforms.filter((item: { generatedType: string }) => item.generatedType === 'MISSION_UAV_PLATFORM')).toEqual([
    { platformId: 'PLAT-003', name: 'mission_uav_03', generatedType: 'MISSION_UAV_PLATFORM' },
    { platformId: 'mission_uav_01', name: 'mission_uav_04', generatedType: 'MISSION_UAV_PLATFORM' },
    { platformId: 'PLAT-005', name: 'mission_uav_01', generatedType: 'MISSION_UAV_PLATFORM' },
    { platformId: 'PLAT-006', name: 'mission_uav_02', generatedType: 'MISSION_UAV_PLATFORM' },
  ])
  for (const name of ['mission_uav_01', 'mission_uav_02', 'mission_uav_03', 'mission_uav_04']) {
    expect(generated.files['comm_platform_INS.txt']).toContain(`platform ${name} `)
  }
})

it('没有中继时作业无人机从 01 起，各类干扰节点分别连续编号且每次从头生成', () => {
  const draft = createRenamedTemplateScenario()
  draft.config.platforms = draft.config.platforms.filter(item => item.type !== 'FORWARD_RELAY_NODE')
  const uavs = draft.config.platforms.filter(item => item.type === 'AIRBORNE_MISSION_CLUSTER')
  const generated = buildMissionPackage(draft)
  expect(generated.manifest.platforms.find((item: { platformId: string }) => item.platformId === uavs[0]!.id)?.name).toBe('mission_uav_01')
  expect(generated.manifest.platforms.find((item: { platformId: string }) => item.platformId === uavs[1]!.id)?.name).toBe('mission_uav_02')
  expect(JSON.parse(generated.files['comm_platform_REAR.txt']!.match(/relay_uav_names (.+)\n/u)![1]!)).toEqual([])
  const platforms = draft.config.platforms.filter(item => ['GROUND_JAMMER_DETECTION_STATION', 'AIRBORNE_JAMMER_PLATFORM'].includes(item.type))
  platforms.push(...platforms.map(item => ({ ...structuredClone(item), id: `${item.id}-2` })))
  const before = structuredClone(platforms)
  expect([...engineNames(platforms).values()]).toEqual(['jammer_station_01', 'jammer_airborne_01', 'jammer_station_02', 'jammer_airborne_02'])
  expect(engineNames(platforms)).toEqual(engineNames(platforms))
  expect(platforms).toEqual(before)
})

it.each(['TIANTONG', 'SHENTONG'] as const)('拒绝重复的 %s 卫星，保留一颗天通加一颗神通', async satelliteType => {
  const { inspectScenarioConfig } = await import('../../src/features/scenarios/scenario-validation')
  const draft = createTemplateScenario()
  expect(inspectScenarioConfig(draft.config, 'write').result.valid).toBe(true)
  const satellite = draft.config.platforms.find(item => item.satelliteType === satelliteType)!
  draft.config.platforms.push({ ...structuredClone(satellite), id: 'SUP-DUPLICATE' })
  expect(inspectScenarioConfig(draft.config, 'write').result.errors).toContainEqual(expect.objectContaining({
    code: 'SATELLITE_TYPE_DUPLICATED', message: '天通卫星和神通卫星各只能配置一颗。', fieldPath: 'platforms',
  }))
  expect(() => buildMissionPackage(draft)).toThrow('天通卫星和神通卫星各只能配置一颗。')
})


it('11-06 删除项仅作用于交付 TXT，原场景与本地引擎定义不丢失', () => {
  const draft = createTemplateScenario(), before = structuredClone(draft)
  const partner = buildMissionPackage(draft), local = buildMissionPackage(draft, undefined, { linkCalc: 'STUB' })
  for (const antenna of ['MICRO_UAV_OMNI_ANTENNA', 'MICRO_REAR_PLATFORM_DIR_ANTENNA', 'OMNI_ANTENNA_HIGHGAIN']) {
    expect(partner.files['comm_PerDefinition.txt']).not.toContain(`antenna_pattern ${antenna}`)
    expect(local.files['comm_PerDefinition.txt']).toContain(`antenna_pattern ${antenna}`)
  }
  expect(partner.files['comm_platform_JAMMER.txt']).not.toContain('weapon prophet_jammer')
  expect(local.files['comm_platform_JAMMER.txt']).toContain('weapon prophet_jammer WSF_RF_JAMMER')
  expect(partner.files['comm_platform_REAR.txt']).toContain('antenna_pattern MICRO_REAR_PLATFORM_DIR_ANTENNA')
  expect(partner.files['comm_platform_JAMMER.txt']).toContain('antenna_pattern OMNI_ANTENNA_HIGHGAIN')
  expect(partner.files['comm_PerDefinition.txt']).toContain('antenna_pattern OMNI_ANTENNA\n')
  expect(partner.files['comm_platform_REAR.txt']).not.toContain('local_link_stub')
  for (const [name, content] of Object.entries(partner.files)) if (name.endsWith('.txt')) expect(content).not.toMatch(/-{3,}(添加|修改|删除|写死)/u)
  expect(draft).toEqual(before)
})

it('11-06 新参数进入各自单位和有序 JSON，业务与计算周期独立生效', () => {
  const draft = createTemplateScenario()
  Object.assign(draft.config.jammers[0]!, { radarFrequency: 3100, radarBandwidth: 2, radarPower: 175, noiseFigureDb: 4, gtDbk: -9, eirpDbw: 38, antennaGainDbi: 2, txLossDb: 0.5, sweepDutyCycle: 0.25 })
  draft.config.linkSettings!.messageIntervalS = 2.5
  draft.config.linkSettings!.linkCalc = { emergencyThreshold: 1e-5, warningThreshold: 1e-6, valueThresholdBer: 1e-7, jammingRangeKm: 30, channelEncodingScheme: 0, updateIntervalS: 7 }
  const generated = buildMissionPackage(draft)
  const rear = generated.files['comm_platform_REAR.txt']!, uav = generated.files['comm_platform_MISSION_UAV.txt']!
  expect(rear).toContain('execute at_interval_of 2.5 sec')
  expect(uav).toContain('execute at_interval_of 2.5 sec')
  expect(rear).toContain('update_interval 7 sec')
  const param = JSON.parse(rear.match(/jammer_param (.+)\n/u)![1]!).jammers[0]
  expect(param).toMatchObject({ frequency_ghz: 3.1, bandwidth_mhz: 2, power_w: 175, noise_figure: 4, G_T_dBK: -9, weapon_frequency_ghz: 2.4, weapon_bandwidth_mhz: 200, weapon_power_w: 1, weapon_eirp_dBW: 38, weapon_antenna_gain_dbi: 2, tx_loss_db: 0.5, sweep_duty_cycle: 0.25, spot_bandwidth_mhz: 20, detect_radius_nm: 30 })
  expect(Object.keys(param)).toEqual(['platform_name', 'weapon_name', 'jammer_type', 'G_T_dBK', 'enabled', 'mode', 'frequency_ghz', 'bandwidth_mhz', 'power_w', 'noise_figure', 'weapon_frequency_ghz', 'weapon_bandwidth_mhz', 'weapon_power_w', 'weapon_eirp_dBW', 'weapon_antenna_gain_dbi', 'tx_loss_db', 'detect_radius_nm', 'trigger_radius_nm', 'release_radius_nm', 'spot_bandwidth_mhz', 'sweep_duty_cycle'])
  expect(generated.files['comm_platform_JAMMER.txt']).toContain('frequency 3.1 GHz')
  expect(generated.files['comm_platform_JAMMER.txt']).toContain('power 175 W')
  const ports = JSON.parse(rear.match(/port_params (.+)\n/u)![1]!)
  for (const platform of ports) for (const port of platform.comm_params) {
    if (port.comm_name === 'fiber_link') continue
    expect(Object.keys(port.transmitter).slice(0, 5)).toEqual(['frequency_ghz', 'bandwidth_mhz', 'power_w', 'eirp_dBW', 'peak_gain_dB'])
    expect(Object.keys(port.receiver).slice(0, 4)).toEqual(['frequency_ghz', 'bandwidth_mhz', 'peak_gain_dB', 'G_T_dBK'])
    expect(Object.keys(port.receiver).at(-1)).toBe('noise_figure_dB')
  }
  expect(ports[0].comm_params.find((port: { comm_name: string }) => port.comm_name === 'microwave_link').transmitter.peak_gain_dB).toBe(30)
  expect(ports[1].comm_params[0].transmitter.peak_gain_dB).toBe(30)
})

it('11-06 接收阈值与地形屏蔽语句覆盖指定端口，顺序和 C 下行倾角不变', () => {
  const files = buildMissionPackage(createTemplateScenario()).files
  let receivers = 0, terrain = 0
  for (const file of ['comm_platform_MISSION_UAV.txt', 'comm_platform_COMMAND_VEHICLE.txt', 'comm_platform_REAR.txt', 'comm_platform_SAT.txt']) {
    for (const match of files[file]!.matchAll(/  comm (\S+) WSF_RADIO_TRANSCEIVER[\s\S]*?  end_comm/gu)) {
      const block = match[0], masking = file.includes('MISSION_UAV') || (file.includes('REAR') && match[1] === 'microwave_link')
      const rx = block.split('    receiver')[1]!
      expect(rx).toMatch(masking ? /noise_figure [^\n]+\n      check_terrain_masking off\n      detection_threshold -1000 dB/u : /noise_figure [^\n]+\n      detection_threshold -1000 dB/u)
      if (masking) { expect(block).toContain('end_attenuation_model\n      check_terrain_masking off\n    end_transmitter'); terrain++ }
      else expect(block).not.toContain('check_terrain_masking')
      if (file.includes('MISSION_UAV') && match[1] === 'c_band_downlink') expect(block).toContain('antenna_tilt -3 deg\n      attenuation_model none')
      receivers++
    }
  }
  expect(receivers).toBe(15); expect(terrain).toBe(7)
})

it('业务默认数组由热链生成；共享返向差异明示，空返向数组与零数据量可生成', () => {
  const draft = createTemplateScenario(), generated = buildMissionPackage(draft)
  const uav = generated.files['comm_platform_MISSION_UAV.txt']!
  expect(uav).toContain('int    rt_video_size = 8192;')
  expect(uav).toContain('int    rt_status_size = 512;')
  expect(generated.manifest.warnings).toContainEqual(expect.stringContaining('同类任务无人机的首跳或数据量不同'))
  expect(generated.files['comm_platform_REAR.txt']).toContain('Array<string> fw_sit_dst  = { "mission_uav_02", "mission_uav_03" };')
  expect(generated.files['comm_platform_COMMAND_VEHICLE.txt']).toContain('Array<string> rt_video_nexts = { "rear_comm_vehicle" };')
  draft.config.informationDemand = draft.config.informationDemand.filter(item => item.direction !== 'REVERSE')
  const empty = buildMissionPackage(draft).files['comm_platform_MISSION_UAV.txt']!
  expect(empty).toContain('rt_video_dsts  = {  };')
  expect(empty).toContain('rt_status_dsts  = {  };')
  expect(empty).toContain('int    rt_video_size = 0;')
  expect(empty).toContain('int    rt_status_size = 0;')
})

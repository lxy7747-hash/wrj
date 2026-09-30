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
  config.output.linkQualityEnabled = false
  config.output.linkSwitchEnabled = false
  config.scenario.timeStep = 2
  draft.uiExtensions = { jammers: [], sensors: [] }
  delete config.linkSettings
  return draft
}

function jammerDraft(): ScenarioDraft {
  const draft = minimalDraft()
  const platform = structuredClone(draft.config.platforms[0]!)
  platform.id = 'STN-01'
  platform.name = '地面干扰站'
  platform.type = 'GROUND_JAMMER_DETECTION_STATION'
  platform.category = 'ground'
  platform.initialPosition = { longitude: 121.55, latitude: 25.15, altitude: 15 }
  platform.linkIds = []
  platform.sensorIds = []
  platform.jammerIds = ['JAM-WB-01-TX']
  draft.config.platforms.push(platform)
  draft.config.jammers = [{ id: 'JAM-WB-01-TX', platformId: 'STN-01', type: 'BARRAGE', defaultPower: 72,
    frequency: 2200, bandwidth: 40, autoDetect: false, detectionRange: 44448, jammingRange: 44448, triggerTimeS: 0 }]
  draft.config.jammingEnabled = true
  draft.uiExtensions = { jammers: [{ jammerId: 'JAM-WB-01-TX', direction: 360, duration: 120, enabled: true }], sensors: [] }
  return draft
}

function satelliteDraft(): ScenarioDraft {
  const draft = minimalDraft()
  const command = draft.config.platforms[0]!
  const airborne = draft.config.platforms[1]!
  airborne.linkIds = []
  const satellite = structuredClone(airborne)
  satellite.id = 'SAT-01'
  satellite.name = '天通通信卫星'
  satellite.type = 'COMMUNICATION_SATELLITE'
  satellite.category = 'space'
  satellite.satelliteType = 'TIANTONG'
  satellite.initialPosition = { longitude: 121.55, latitude: 25.15, altitude: 0 }
  satellite.waypoints = []
  satellite.linkIds = ['L-SAT']
  draft.config.platforms.push(satellite)
  command.linkIds = ['L-SAT']
  draft.config.links = [{ ...draft.config.links[0]!, id: 'L-SAT', type: 'SAT',
    sourcePlatformId: 'CMD-01', targetPlatformId: 'SAT-01' }]
  Object.assign(draft.config.informationDemand[0]!, { linkId: 'L-SAT', sourcePlatformId: 'CMD-01',
    destinationPlatformIds: ['SAT-01'], enabled: false })
  return draft
}

describe('候选 AFSIM 节点与独立微波设备生成', () => {
  it('按映射表生成干扰平台、独立 weapon、模式和频率单位，并保留配置状态', () => {
    const draft = jammerDraft()
    const original = structuredClone(draft)
    const generated = buildMissionPackage(draft)
    const platform = generated.manifest.platforms.find((item: { platformId: string; generatedType: string }) => item.platformId === 'STN-01')!
    const jammer = generated.manifest.jammers[0]
    expect(jammer).toMatchObject({ jammerId: 'JAM-WB-01-TX', platformId: 'STN-01', model: 'WSF_RF_JAMMER',
      type: 'BARRAGE', mode: 'broadband_jamming', frequencyMHz: 2200, frequencyHz: 2_200_000_000,
      bandwidthMHz: 40, bandwidthHz: 40_000_000, powerW: 72, configuredEnabled: true, startsOn: true,
      startTimeS: 0.001, stopTimeS: 120.001, activation: 'SCHEDULED' })
    expect(generated.files['mission.txt']).toContain(`platform STN-01 ${platform.generatedType}`)
    const text = generated.files['platforms.txt']
    expect(text).toContain(`platform_type ${platform.generatedType} WSF_PLATFORM`)
    expect(text).toContain('mover WSF_SURFACE_MOVER')
    expect(text).toContain(`weapon ${jammer.weaponId} WSF_RF_JAMMER`)
    expect(text).toContain('frequency 2.2 GHz')
    expect(text).toContain('bandwidth 40 MHz')
    expect(text).toContain('power 72 W')
    expect(text).toContain('mode broadband_jamming')
    expect(text).toContain('mode spot_jamming')
    expect(text).toContain('mode sweep_jamming')
    expect(text).toContain(`jammer.SelectMode("${jammer.mode}")`)
    // 启停完全由带时刻的处理器驱动，weapon 不写常开 on。
    expect(text).not.toContain('\n    on\n')
    expect(text).toContain(`processor ${jammer.processorId} WSF_SCRIPT_PROCESSOR`)
    expect(text).toContain('execute at_time 0.001 sec absolute')
    expect(text).toContain('execute at_time 120.001 sec absolute')
    expect(text).toContain('jammer.TurnOn();')
    expect(text).toContain('jammer.TurnOff();')
    expect(generated.files['mission.txt']).toContain('enable JAMMING_REQUEST_INITIATED')
    expect(generated.files['mission.txt']).toContain('enable JAMMING_REQUEST_CANCELED')
    expect(draft).toEqual(original)
  })

  it('定时触发按配置时刻选模，持续时间生成关闭；超出仿真时长时不写永不执行的关闭', () => {
    const draft = jammerDraft()
    draft.config.jammers[0]!.triggerTimeS = 300
    draft.uiExtensions.jammers[0]!.duration = 60
    const scheduled = buildMissionPackage(draft)
    expect(scheduled.manifest.jammers[0]).toMatchObject({ activation: 'SCHEDULED', startTimeS: 300, stopTimeS: 360 })
    expect(scheduled.files['platforms.txt']).toContain('execute at_time 300 sec absolute')
    expect(scheduled.files['platforms.txt']).toContain('execute at_time 360 sec absolute')
    draft.uiExtensions.jammers[0]!.duration = draft.config.scenario.duration
    const beyond = buildMissionPackage(draft)
    expect(beyond.manifest.jammers[0]).toMatchObject({ startTimeS: 300, stopTimeS: null, durationS: 1200 })
    expect(beyond.files['platforms.txt']).not.toContain('jammer.TurnOff();')
  })

  it('自动探测按 detectionRange 对全部平台做距离判断并生成启停', () => {
    const draft = jammerDraft()
    draft.config.jammers[0]!.autoDetect = true
    const generated = buildMissionPackage(draft)
    expect(generated.manifest.jammers[0]).toMatchObject({ autoDetect: true, activation: 'AUTO_DETECT_RANGE',
      startsOn: true, startTimeS: null, stopTimeS: null, detectionRangeM: 44448, jammingRangeM: 44448, directionDeg: 360 })
    const platforms = generated.files['platforms.txt']
    expect(platforms).toContain('jammer_proc_')
    expect(platforms).toContain('SlantRangeTo')
    expect(platforms).toContain('44448')
    expect(platforms).toContain('rangeM <= 44448 && rangeM <= 44448')
    expect(platforms).toContain('FindPlatform("CMD-01")')
    expect(platforms).toContain('FindPlatform("AIR-01")')
    expect(platforms).toContain('SelectMode("broadband_jamming")')
    expect(platforms).toContain('execute at_interval_of 3 sec')
  })

  it('自动探测仅在干扰范围内 TurnOn；候选项 weapon 无 maximum_range', () => {
    const draft = jammerDraft()
    draft.config.jammers[0]!.autoDetect = true
    draft.config.jammers[0]!.detectionRange = 44448
    draft.config.jammers[0]!.jammingRange = 18520
    const generated = buildMissionPackage(draft)
    expect(generated.manifest.jammers[0]).toMatchObject({ detectionRangeM: 44448, jammingRangeM: 18520 })
    const platforms = generated.files['platforms.txt']
    expect(platforms).toContain('rangeM <= 44448 && rangeM <= 18520')
    expect(platforms).not.toContain('maximum_range')
    expect(generated.manifest.engineValidated).toBe(false)
  })

  it('缺少或非法干扰范围时阻断生成', () => {
    const draft = jammerDraft()
    draft.config.jammers[0]!.jammingRange = 0
    expect(() => buildMissionPackage(draft)).toThrow('jammers[0].jammingRange')
  })

  it('旧记录缺少触发时刻时不猜启动时间，只保留设备定义', () => {
    const draft = jammerDraft()
    delete draft.config.jammers[0]!.triggerTimeS
    const generated = buildMissionPackage(draft)
    expect(generated.manifest.jammers[0]).toMatchObject({ triggerTimeS: null, activation: 'TRIGGER_NOT_CONFIGURED',
      startsOn: false, startTimeS: null })
    expect(generated.files['platforms.txt']).toContain('WSF_RF_JAMMER')
    expect(generated.files['platforms.txt']).not.toContain('jammer_proc_')
  })

  it.each([
    ['BARRAGE', 'broadband_jamming'], ['SPOT', 'spot_jamming'], ['SWEEP', 'sweep_jamming'],
  ] as const)('显式映射 %s 干扰类型到 %s 模式', (type, mode) => {
    const draft = jammerDraft()
    draft.config.jammers[0]!.type = type
    const generated = buildMissionPackage(draft)
    expect(generated.manifest.jammers[0]!.mode).toBe(mode)
    expect(generated.files['platforms.txt']).toContain(`mode ${mode}`)
  })

  it('总开关或单设备关闭时保留 weapon 配置但不生成任何启停动作', () => {
    const draft = jammerDraft()
    draft.config.jammingEnabled = false
    draft.uiExtensions.jammers[0]!.enabled = true
    const generated = buildMissionPackage(draft)
    expect(generated.manifest.jammers[0]).toMatchObject({ configuredEnabled: false, startsOn: false,
      startTimeS: null, stopTimeS: null, activation: 'DISABLED' })
    expect(generated.files['platforms.txt']).toContain('WSF_RF_JAMMER')
    expect(generated.files['platforms.txt']).not.toContain('jammer_proc_')
    expect(generated.files['platforms.txt']).not.toContain('TurnOn')
    expect(generated.files['platforms.txt']).not.toContain('\n    on\n')
  })

  it('拒绝 AFSIM 不接受的零功率干扰 weapon', () => {
    const draft = jammerDraft()
    draft.config.jammers[0]!.defaultPower = 0
    expect(() => buildMissionPackage(draft)).toThrow('jammers[0].defaultPower')
  })

  it('地面无人集群指挥车按已确认候选模型生成，不套用后方通信平台', () => {
    const draft = minimalDraft()
    draft.config.platforms[1]!.type = 'GROUND_CLUSTER_COMMAND_NODE'
    draft.config.platforms[1]!.category = 'ground'
    const { files, manifest } = buildMissionPackage(draft)
    const platform = manifest.platforms.find((item: { platformId: string }) => item.platformId === 'AIR-01')!
    expect(platform).toMatchObject({ referenceModel: 'COMMAND_VEHICLE_PLATFORM', mover: 'WSF_GROUND_MOVER' })
    expect(platform.generatedType).toContain('COMMAND_VEHICLE_PLATFORM')
    expect(files['platforms.txt']).toContain(`platform_type ${platform.generatedType} WSF_PLATFORM`)
    expect(files['mission.txt']).toContain(`platform AIR-01 ${platform.generatedType}`)
  })

  it('通信卫星按子类型生成候选模型与轨道模板，历元取开始时刻且不写配置坐标', () => {
    const draft = satelliteDraft()
    const original = structuredClone(draft)
    const { files, manifest } = buildMissionPackage(draft)
    const satellite = manifest.platforms.find((item: { platformId: string }) => item.platformId === 'SAT-01')!
    expect(satellite).toMatchObject({ satelliteType: 'TIANTONG', referenceModel: 'TIAN_TONG_SAT',
      mover: 'WSF_SPACE_MOVER', orbitalTemplate: 'CANDIDATE_MODEL' })
    const text = files['platforms.txt']
    expect(text).toContain(`platform_type ${satellite.generatedType} WSF_PLATFORM`)
    expect(text).toContain('mover WSF_SPACE_MOVER')
    expect(text).toContain('    oblate_earth true')
    expect(text).toContain('      epoch_date_time aug 06 2026 08:00:00')
    expect(text).toContain('      semi_major_axis 42164 km')
    expect(text).toContain('      inclination 0 deg')
    expect(text).toContain('    end_orbital_state')
    expect(text).not.toContain('7000 km')
    // 卫星位置由轨道决定，实例不写 position 与 altitude，避免配置坐标看起来生效。
    expect(files['mission.txt']).toContain(`platform SAT-01 ${satellite.generatedType}\nend_platform\n`)
    expect(manifest.devices[0]).toMatchObject({ linkType: 'SAT' })
    expect(draft).toEqual(original)
  })

  it('神通卫星使用 LEO 轨道模板，两个子类型不互相套用', () => {
    const draft = satelliteDraft()
    draft.config.platforms[2]!.satelliteType = 'SHENTONG'
    const text = buildMissionPackage(draft).files['platforms.txt']
    expect(text).toContain('      semi_major_axis 7000 km')
    expect(text).toContain('      inclination 60 deg')
    expect(text).toContain('      raan 80 deg')
    expect(text).not.toContain('42164 km')
  })

  it('高空中继复用无人机模型生成并标注中继角色，不新增独立模型', () => {
    const draft = minimalDraft()
    draft.config.platforms[1]!.type = 'FORWARD_RELAY_NODE'
    draft.config.platforms[1]!.category = 'air'
    const { files, manifest } = buildMissionPackage(draft)
    const relay = manifest.platforms.find((item: { platformId: string }) => item.platformId === 'AIR-01')!
    expect(relay).toMatchObject({ referenceModel: 'MISSION_UAV_PLATFORM', mover: 'WSF_AIR_MOVER', relayRole: true })
    expect(manifest.platforms[0]).toMatchObject({ relayRole: false })
    expect(files['platforms.txt']).toContain('mover WSF_AIR_MOVER')
  })

  it('侦测设备生成主动雷达，频率取范围中心、带宽取上下限之差', () => {
    const draft = minimalDraft()
    draft.config.sensors = [{ id: 'ESM-01', platformId: 'CMD-01',
      frequencyRange: { min: 2000, max: 5000 }, detectionRange: 150000 }]
    draft.uiExtensions.sensors = [{ sensorId: 'ESM-01', type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true }]
    const original = structuredClone(draft)
    const { files, manifest } = buildMissionPackage(draft)
    const sensor = manifest.sensors[0]
    expect(sensor).toMatchObject({ sensorId: 'ESM-01', platformId: 'CMD-01', model: 'WSF_RADAR_SENSOR',
      uiType: 'ESM', frequencyMHz: 3500, bandwidthMHz: 3000, detectionRangeM: 150000,
      directionDeg: null, probability: 0.95, enabled: true })
    const text = files['platforms.txt']
    expect(text).toContain(`sensor ${sensor.deviceId} WSF_RADAR_SENSOR`)
    expect(text).toContain('          frequency 3.5 GHz')
    expect(text).toContain('          bandwidth 3000 MHz')
    expect(text).toContain('        maximum_range 150000 m')
    expect(text).toContain('      frame_time 5 sec')
    expect(text).toContain('    on')
    expect(draft).toEqual(original)
  })

  it('侦测设备停用时不写 on，非法频率范围与距离阻断生成', () => {
    const draft = minimalDraft()
    draft.config.sensors = [{ id: 'ESM-01', platformId: 'CMD-01',
      frequencyRange: { min: 2000, max: 5000 }, detectionRange: 150000 }]
    draft.uiExtensions.sensors = [{ sensorId: 'ESM-01', type: 'ESM', direction: 90, probability: 0.5, enabled: false }]
    const off = buildMissionPackage(draft)
    expect(off.manifest.sensors[0]).toMatchObject({ directionDeg: 90, enabled: false })
    expect(off.files['platforms.txt']).not.toContain('    on\n  end_sensor')
    draft.config.sensors[0]!.frequencyRange = { min: 5000, max: 2000 }
    expect(() => buildMissionPackage(draft)).toThrow('sensors[0].frequencyRange')
    draft.config.sensors[0]!.frequencyRange = { min: 2000, max: 5000 }
    draft.config.sensors[0]!.detectionRange = 0
    expect(() => buildMissionPackage(draft)).toThrow('sensors[0].detectionRange')
  })

  it('数传固定 C 波段、由方向决定上下行，并写死合同误码概率', () => {
    const draft = minimalDraft()
    const link = draft.config.links[0]!
    link.type = 'DATALINK'
    link.direction = 'FORWARD'
    const forward = buildMissionPackage(draft)
    expect(forward.manifest.devices[0]).toMatchObject({ linkType: 'DATALINK', band: 'C', role: 'UPLINK',
      bitErrorProbability: 0.00001 })
    expect(forward.files['platforms.txt']).toContain('    bit_error_probability 0.00001')
    link.direction = 'REVERSE'
    draft.config.informationDemand[0]!.direction = 'REVERSE'
    expect(buildMissionPackage(draft).manifest.devices[0]).toMatchObject({ role: 'DOWNLINK' })
    // 微波链路没有误码概率参数，也不带波段与角色。
    link.type = 'MICROWAVE'
    const microwave = buildMissionPackage(draft)
    expect(microwave.manifest.devices[0]).toMatchObject({ band: null, role: null, bitErrorProbability: null })
    expect(microwave.files['platforms.txt']).not.toContain('bit_error_probability')
  })

  it('航点生成可推进 route，首点固定为初始位置，arrivalTime 不作为引擎约束', () => {
    const draft = minimalDraft()
    const platform = draft.config.platforms[1]!
    platform.initialPosition = { longitude: 120.1, latitude: 23.5, altitude: 8000 }
    platform.waypoints = [
      { longitude: 120.2, latitude: 23.6, altitude: 8100, speed: 200, arrivalTime: 60 },
      { longitude: 120.3, latitude: 23.7, altitude: 8200, speed: 250, arrivalTime: 120 },
    ]
    const { files, manifest } = buildMissionPackage(draft)
    const entry = files['mission.txt']
    expect(entry).toContain('  route\n')
    expect(entry).toContain('    position 23.5n 120.1e altitude 8000 m speed 200 m/s\n')
    expect(entry).toContain('    position 23.6n 120.2e altitude 8100 m speed 250 m/s\n')
    expect(entry).toContain('    position 23.7n 120.3e altitude 8200 m speed 250 m/s\n')
    expect(entry).toContain('  end_route\n')
    expect(manifest.platforms[1].waypoints[0]).toMatchObject({ arrivalTimeS: 60, arrivalTimeEnforced: false })
    expect(entry).not.toContain('arrival')
  })

  it('环境、时钟倍速与开始日期时刻写入 mission 入口', () => {
    const draft = minimalDraft()
    draft.config.scenario.environment.seaState = 3
    draft.config.scenario.environment.rainRateMmPerHour = 12.5
    draft.config.scenario.environment.simClockSpeed = 4
    draft.config.scenario.startTime = '2026-09-23T00:00:00.000Z'
    const { files, manifest } = buildMissionPackage(draft)
    const entry = files['mission.txt']
    expect(entry).toContain('clock_rate 4')
    expect(entry).toContain('global_environment')
    expect(entry).toContain('  sea_state 3')
    expect(entry).toContain('  rain_rate 12.5 mm/hr')
    expect(entry).toContain('end_global_environment')
    // 引擎只接受“三字母月份 两位日 四位年”；脚本无时区标记，按存储的 UTC 分量原样写入。
    expect(entry).toContain('start_date sep 23 2026')
    expect(entry).toContain('start_time 00:00:00.000')
    expect(manifest.clockRate).toMatchObject({ value: 4, engineEmitted: true, effectiveUnderEventStepping: false })
    expect(manifest.scenarioStartTime).toEqual({ value: '2026-09-23T00:00:00.000Z', scriptDate: 'sep 23 2026',
      scriptTime: '00:00:00.000', convention: 'AS_STORED_UTC', engineEmitted: true })
    expect(files['README.txt']).toContain('按 priority 自动选主链路')
  })

  it('开始日期用三字母月份与两位日，不接受全称月份或年在前写法', () => {
    const draft = minimalDraft()
    draft.config.scenario.startTime = '2025-01-05T23:59:59.500Z'
    const { files } = buildMissionPackage(draft)
    expect(files['mission.txt']).toContain('start_date jan 05 2025')
    expect(files['mission.txt']).toContain('start_time 23:59:59.500')
  })

  it('业务保留类型和编号，按位数/周期生成真实发送且不改草稿', () => {
    const draft = minimalDraft()
    const demand = draft.config.informationDemand[0]!
    demand.enabled = true
    demand.id = 'INFO-001'
    demand.informationType = '态势信息'
    demand.volumeMb = 0.000256
    demand.frequencyHz = 3
    const original = structuredClone(draft)
    const { files, manifest } = buildMissionPackage(draft)
    const business = manifest.businesses[0]
    expect(business).toMatchObject({ demandId: demand.id, messageType: demand.informationType, sizeBits: 2048, frequencyHz: 3,
      constraints: { engineEnforced: false, minDataRateMbps: demand.minDataRateMbps } })
    expect(business.routes).toEqual([manifest.devices[0]])
    expect(files['platforms.txt']).toContain(`SetType("${demand.informationType}")`)
    expect(files['platforms.txt']).toContain(`SetSubType("${demand.id}")`)
    expect(files['platforms.txt']).toContain('SetSizeInBits(2048)')
    expect(files['platforms.txt']).toContain('emissionIndex / 3.00000000000000000e+0')
    expect(files['platforms.txt']).toContain('ExecuteScriptAtTime(0, "QueueBusiness")')
    expect(files['platforms.txt']).toContain('ExecuteScriptAtTime(TIME_NOW, "EmitBusiness")')
    expect(files['platforms.txt']).toContain(`TIME_NOW >= ${draft.config.scenario.duration}`)
    expect(files['platforms.txt']).toContain(`SendMessage(message, "AIR-01", "${manifest.devices[0].target.deviceId}")`)
    expect(draft).toEqual(original)
  })

  it.each([
    ['informationType', '态势"信息'],
    ['id', 'INFO"001'],
  ] as const)('业务 %s 含双引号时明确拒绝并返回字段路径', (field, value) => {
    const draft = minimalDraft()
    Object.assign(draft.config.informationDemand[0]!, { enabled: true, [field]: value })
    expect(() => buildMissionPackage(draft)).toThrow(`informationDemand[0].${field}`)
    expect(() => buildMissionPackage(draft)).toThrow('无法无损生成')
  })

  it.each(['id', 'informationType'] as const)('拒绝 %s 中任意位置的反斜杠，不改写草稿', field => {
    for (const value of ['A\\B', 'A\\', 'A\\\\B', '中文\\业务']) {
      const draft = minimalDraft()
      Object.assign(draft.config.informationDemand[0]!, { enabled: true, [field]: value })
      const original = structuredClone(draft)
      expect(() => buildMissionPackage(draft)).toThrow(`informationDemand[0].${field}`)
      expect(() => buildMissionPackage(draft)).toThrow('反斜杠')
      expect(draft).toEqual(original)
    }
  })

  it('业务/链路关闭或零频次不发包；重新开启恢复且保留业务配置', () => {
    const draft = minimalDraft()
    const demand = draft.config.informationDemand[0]!
    demand.enabled = true
    const enabled = buildMissionPackage(draft)
    expect(enabled.manifest.businesses).toHaveLength(1)
    for (const action of ['business', 'link', 'frequency']) {
      const changed = structuredClone(draft)
      if (action === 'business') changed.config.informationDemand[0]!.enabled = false
      if (action === 'link') changed.config.links[0]!.enabled = false
      if (action === 'frequency') changed.config.informationDemand[0]!.frequencyHz = 0
      const generated = buildMissionPackage(changed)
      expect(generated.manifest.businesses).toEqual([])
      expect(generated.files['platforms.txt']).not.toContain('SendMessage')
      expect(changed.config.informationDemand).toHaveLength(1)
    }
    delete demand.enabled
    expect(buildMissionPackage(draft).manifest.businesses).toEqual(enabled.manifest.businesses)
  })

  it('旧未关联业务按目的地匹配链路；同端点多链路时按 priority 选路', () => {
    const draft = minimalDraft()
    const demand = draft.config.informationDemand[0]!
    demand.enabled = true
    delete demand.linkId
    draft.config.platforms.push({ ...structuredClone(draft.config.platforms[1]!), id: 'AIR-02', linkIds: ['L-B'] })
    draft.config.platforms[0]!.linkIds.push('L-B')
    draft.config.links.push({ ...draft.config.links[0]!, id: 'L-B', targetPlatformId: 'AIR-02' })
    demand.destinationPlatformIds.push('AIR-02')
    const generated = buildMissionPackage(draft)
    expect(generated.manifest.businesses[0].routes.map((route: { linkId: string }) => route.linkId)).toEqual(['L-A', 'L-B'])
    expect(generated.files['platforms.txt'].match(/SendMessage\(/g)).toHaveLength(2)
    draft.config.links[1]!.enabled = false
    expect(() => buildMissionPackage(draft)).toThrow('informationDemand[0].destinationPlatformIds[1]')
    draft.config.links[1]!.enabled = true
    demand.direction = 'REVERSE'
    expect(() => buildMissionPackage(draft)).toThrow('informationDemand[0].destinationPlatformIds[0]')
    demand.direction = 'FORWARD'
    demand.destinationPlatformIds = ['AIR-01']
    draft.config.links.push({ ...draft.config.links[0]!, id: 'L-C' })
    draft.config.platforms[0]!.linkIds.push('L-C')
    draft.config.platforms[1]!.linkIds.push('L-C')
    // 同端点多链路：按 priority 自动选主路由，不再拒绝。
    const multi = buildMissionPackage(draft)
    expect(multi.manifest.businesses[0].failoverEnabled).toBe(false)
    expect(multi.manifest.businesses[0].routePlans[0].orderedLinkIds).toEqual(
      expect.arrayContaining(['L-A', 'L-C']))
    expect(multi.manifest.businesses[0].routes).toHaveLength(1)
    expect(multi.files['platforms.txt'].match(/SendMessage\(/g)).toHaveLength(1)
    expect(multi.files['platforms.txt']).not.toContain('activeRouteIndex')
  })

  it.each([
    ['volumeMb', 1000], ['frequencyHz', 1e200], ['informationType', ''], ['informationType', '态势\nend_script'], ['id', 'ID\u0000'],
  ])('业务 %s=%s 不能生成损坏脚本或无界任务', (field, value) => {
    const draft = minimalDraft()
    Object.assign(draft.config.informationDemand[0]!, { enabled: true, [field]: value })
    expect(() => buildMissionPackage(draft)).toThrow(`informationDemand[0].${field}`)
  })

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
    expect(files['README.txt']).toContain('按 priority 自动选主链路')
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
    ['报文超过引擎容量', d => { d.config.informationDemand[0]!.enabled = true; d.config.informationDemand[0]!.volumeMb = 1000 }, 'informationDemand[0].volumeMb'],
    ['激光链路未接通', d => { d.config.links[0]!.type = 'LASER' }, 'links[0].type'],
    ['卫星缺子类型', d => {
      d.config.platforms[1]!.type = 'COMMUNICATION_SATELLITE'
      d.config.platforms[1]!.category = 'space'
    }, 'platforms[1].satelliteType'],
    ['卫星写航点', d => {
      d.config.platforms[1]!.type = 'COMMUNICATION_SATELLITE'
      d.config.platforms[1]!.category = 'space'
      d.config.platforms[1]!.satelliteType = 'TIANTONG'
      d.config.platforms[1]!.waypoints = [{ ...d.config.platforms[1]!.initialPosition, speed: 10, arrivalTime: 5 }]
    }, 'platforms[1].waypoints'],
    ['卫星链路缺卫星端点', d => { d.config.links[0]!.type = 'SAT' }, 'links[0].type'],
    ['航点速度为零', d => { d.config.platforms[1]!.waypoints = [{ ...d.config.platforms[1]!.initialPosition, speed: 0, arrivalTime: 10 }] }, 'platforms[1].waypoints[0].speed'],
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
    const { files, manifest } = buildMissionPackage(draft, { ...draft.config.output, eventsEnabled: false })
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
      expect(await readdir(join(dirname(first), draft.config.output.directory))).toEqual([])
      expect(await readFile(join(dirname(first), `SCN-001-r${draft.revision}.txt`), 'utf8')).toContain(script.preview)
      const manifest = JSON.parse(await readFile(join(dirname(first), 'mapping.json'), 'utf8'))
      expect(manifest).toMatchObject({ scenarioId: 'SCN-001', revision: draft.revision, engineValidated: false })
      for (const dependency of ['platforms.txt', 'observers.txt', 'input.json', 'README.txt']) {
        expect((await readFile(join(dirname(first), dependency), 'utf8')).length).toBeGreaterThan(0)
      }
      const directories = await readdir(root)
      draft.config.informationDemand[0]!.enabled = true
      draft.config.informationDemand[0]!.volumeMb = 1000
      await expect(writeScriptText(root, script, draft.revision, draft)).rejects.toThrow('informationDemand[0]')
      expect(await readdir(root)).toEqual(directories)
      await writeFile(join(root, 'keep.txt'), '保留')
      draft.config.informationDemand[0]!.enabled = false
      await expect(writeScriptText(root, { ...script, scenarioId: 'x'.repeat(300) }, draft.revision, draft)).rejects.toThrow()
      expect((await readdir(root)).sort()).toEqual([...directories, 'keep.txt'].sort())
    } finally { await rm(root, { recursive: true, force: true }) }
  })


  it('光纤按候选有线收发器生成并声明 P2P 网络', () => {
    const draft = minimalDraft()
    draft.config.links[0]!.type = 'FIBER'
    const generated = buildMissionPackage(draft)
    expect(generated.manifest.devices[0]).toMatchObject({ linkType: 'FIBER', commModel: 'WSF_COMM_TRANSCEIVER' })
    expect(generated.files['platforms.txt']).toContain('WSF_COMM_TRANSCEIVER')
    expect(generated.files['platforms.txt']).toContain('WSF_COMM_NETWORK_P2P')
  })

  it('卫星单跳中继生成源→卫星→目标转发', () => {
    const draft = satelliteDraft()
    draft.config.links = [{
      ...draft.config.links[0]!,
      id: 'L-RELAY', type: 'SAT', enabled: true,
      sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', relayPlatformId: 'SAT-01',
    }]
    draft.config.platforms.forEach(p => { p.linkIds = ['CMD-01','AIR-01','SAT-01'].includes(p.id) ? ['L-RELAY'] : [] })
    Object.assign(draft.config.informationDemand[0]!, { linkId: 'L-RELAY', sourcePlatformId: 'CMD-01',
      destinationPlatformIds: ['AIR-01'], enabled: false })
    const generated = buildMissionPackage(draft)
    const device = generated.manifest.devices[0]!
    expect(device.relayPlatformId).toBe('SAT-01')
    expect(device.relay).toMatchObject({ platformId: 'SAT-01' })
    expect(generated.files['platforms.txt']).toContain('on_message')
    expect(generated.files['platforms.txt']).toContain('relay_proc_')
    expect(generated.files['platforms.txt']).toContain('comm_')
  })

  it('输出目录写入包内 csv 路径；缺少真实质量和切换测量时明确阻断', () => {
    const draft = minimalDraft()
    draft.config.output.directory = 'custom_out'
    draft.config.output.eventsEnabled = true
    const generated = buildMissionPackage(draft, draft.config.output)
    expect(generated.files['mission.txt']).toContain('file custom_out/scenario_events.csv')
    expect(generated.files['observers.txt']).toContain('custom_out/position.csv')
    expect(generated.files['platforms.txt']).not.toContain('link_quality.csv')
    expect(generated.manifest.output.linkQualityCsvPath).toBeNull()
    expect(generated.manifest.output.linkSwitchCsvPath).toBeNull()
    expect(generated.manifest.output).toMatchObject({
      resolvedDirectory: 'custom_out', linkQualityEnabled: false, linkSwitchEnabled: false, linkSwitchStatsEmitted: false,
    })
    draft.config.output.linkQualityEnabled = true
    expect(() => buildMissionPackage(draft, draft.config.output)).toThrow('output.linkQualityEnabled')
    draft.config.output.linkQualityEnabled = false
    draft.config.output.linkSwitchEnabled = true
    expect(() => buildMissionPackage(draft, draft.config.output)).toThrow('output.linkSwitchEnabled')
  })

  it.each(['../outside', 'nested/../../outside', '/outside', 'C:\\outside', '\\\\host\\share', 'a/CON', 'a"/b'])('拒绝包外或非法输出目录 %s，保留草稿', directory => {
    const draft = minimalDraft()
    draft.config.output.directory = directory
    const original = structuredClone(draft)
    expect(() => buildMissionPackage(draft, draft.config.output)).toThrow('output.directory')
    expect(draft).toEqual(original)
  })

  it.each(['linkQualityEnabled', 'linkSwitchEnabled'] as const)('旧场景开启 %s 时仍按系统配置落盘，不生成伪造 CSV', async flag => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-unsupported-output-'))
    try {
      const draft = minimalDraft()
      const second = structuredClone(draft.config.informationDemand[0]!)
      second.id = 'INFO-SECOND'
      delete second.linkId
      draft.config.informationDemand.push(second)
      draft.config.output[flag] = true
      const original = structuredClone(draft)
      await writeFile(join(root, 'keep.csv'), 'previous run')
      const entry = await writeScriptText(root, new ScriptProjection().preview(draft), draft.revision, draft)
      const manifest = JSON.parse(await readFile(join(dirname(entry), 'mapping.json'), 'utf8'))
      expect(manifest.output).toMatchObject({ linkQualityEnabled: false, linkSwitchEnabled: false })
      expect(await readdir(root)).toContain('keep.csv')
      expect(await readFile(join(root, 'keep.csv'), 'utf8')).toBe('previous run')
      expect(draft).toEqual(original)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('业务类型非四枚举时阻断生成', () => {
    const draft = minimalDraft()
    draft.config.informationDemand[0]!.enabled = true
    draft.config.informationDemand[0]!.informationType = '视频' as never
    draft.config.informationDemand[0]!.frequencyHz = 1
    expect(() => buildMissionPackage(draft)).toThrow(/informationType/)
  })


  it('高空中继 UAV 单跳转发：源→中继→目标', () => {
    const draft = minimalDraft()
    const airborne = draft.config.platforms[1]!
    const relay = structuredClone(airborne)
    relay.id = 'RELAY-01'
    relay.name = '高空中继'
    relay.type = 'FORWARD_RELAY_NODE'
    relay.linkIds = ['L-RELAY-UAV']
    draft.config.platforms.push(relay)
    draft.config.platforms[0]!.linkIds = ['L-RELAY-UAV']
    airborne.linkIds = ['L-RELAY-UAV']
    draft.config.links = [{
      ...draft.config.links[0]!,
      id: 'L-RELAY-UAV', type: 'MICROWAVE', enabled: true,
      sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', relayPlatformId: 'RELAY-01',
    }]
    Object.assign(draft.config.informationDemand[0]!, {
      linkId: 'L-RELAY-UAV', sourcePlatformId: 'CMD-01', destinationPlatformIds: ['AIR-01'], enabled: false,
    })
    const generated = buildMissionPackage(draft)
    expect(generated.manifest.devices[0]).toMatchObject({
      relayKind: 'FORWARD_RELAY_UAV', relayPlatformId: 'RELAY-01',
    })
    expect(generated.manifest.platforms.find((p: { platformId: string }) => p.platformId === 'RELAY-01')).toMatchObject({ relayRole: true })
    expect(generated.files['platforms.txt']).toContain('relay_proc_')
    expect(generated.files['platforms.txt']).toContain('on_message')
    expect(generated.files['mission.txt']).toContain('platform RELAY-01 ')
    expect(generated.files['platforms.txt']).toContain(`internal_link ${generated.manifest.devices[0]!.relay!.processorId}`)
    expect(generated.files['platforms.txt']).toContain('on_message\n      default')
  })

  it('多链路按 priority 选主路由；不输出无测量的切换与质量 CSV', () => {
    const draft = minimalDraft()
    const base = draft.config.links[0]!
    draft.config.links = [
      { ...base, id: 'L-MW', type: 'MICROWAVE', enabled: true, sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01' },
      { ...base, id: 'L-DL', type: 'DATALINK', enabled: true, direction: 'FORWARD',
        sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', frequency: 5000, bandwidth: 10, dataRate: 5 },
    ]
    draft.config.platforms.forEach(p => { p.linkIds = ['L-MW', 'L-DL'] })
    draft.config.linkSettings = {
      enabledSatellites: { TIANTONG: false, SHENTONG: false },
      switchCooldownS: 2,
      priority: ['DATALINK', 'MICROWAVE', 'SAT', 'LASER', 'FIBER'],
    }
    draft.config.output.linkSwitchEnabled = false
    draft.config.output.linkQualityEnabled = false
    draft.config.jammingEnabled = true
    const jammerPlat = structuredClone(draft.config.platforms[0]!)
    jammerPlat.id = 'STN-01'
    jammerPlat.type = 'GROUND_JAMMER_DETECTION_STATION'
    jammerPlat.category = 'ground'
    jammerPlat.linkIds = []
    jammerPlat.jammerIds = ['JAM-1']
    draft.config.platforms.push(jammerPlat)
    draft.config.jammers = [{
      id: 'JAM-1', platformId: 'STN-01', type: 'BARRAGE', defaultPower: 50,
      frequency: 2000, bandwidth: 20, autoDetect: false, detectionRange: 10000, jammingRange: 10000, triggerTimeS: 1,
    }]
    draft.uiExtensions = { jammers: [{ jammerId: 'JAM-1', direction: 0, duration: 10, enabled: true }], sensors: [] }
    const demand = draft.config.informationDemand[0]!
    demand.enabled = true
    delete demand.linkId
    demand.direction = 'FORWARD'
    demand.informationType = '态势信息'
    demand.frequencyHz = 1
    demand.sourcePlatformId = 'CMD-01'
    demand.destinationPlatformIds = ['AIR-01']
    const generated = buildMissionPackage(draft)
    expect(generated.manifest.businesses[0]).toMatchObject({
      failoverEnabled: false,
      routes: [expect.objectContaining({ linkId: 'L-DL', linkType: 'DATALINK' })],
      routePlans: [expect.objectContaining({ orderedLinkIds: ['L-DL', 'L-MW'] })],
    })
    expect(generated.files['platforms.txt']).not.toContain('FailoverToNextRoute')
    expect(generated.files['platforms.txt']).not.toContain('activeRouteIndex')
    expect(generated.files['platforms.txt']).not.toContain('link_switch.csv')
    expect(generated.files['platforms.txt']).not.toContain('link_quality.csv')
    expect(generated.manifest.output.linkSwitchStatsEmitted).toBe(false)
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
      saved.config.informationDemand[0].volumeMb = 1000
      const latest = (await api.put('/api/v1/scenarios/SCN-001').set(headers)
        .send({ config: saved.config, uiExtensions: saved.uiExtensions, expectedRevision: saved.revision }).expect(200)).body.data
      const confirm = (await api.post('/api/v1/confirmations').set(headers)
        .send({ action: 'SCENARIO_WARNING_CONTINUE', objectId: 'SCN-001' }).expect(201)).body.data
      await api.post(`/api/v1/confirmations/${confirm.confirmationId}`).set(headers).send({ confirm: true }).expect(200)
      const next = (await api.post('/api/v1/scripts/preview').set(headers)
        .send({ scenarioId: 'SCN-001', warningConfirmationId: confirm.confirmationId }).expect(200)).body.data
      const failure = (await api.post(`/api/v1/scripts/${next.scriptId}/local-file`).set(headers)
        .send({ checksum: next.checksum }).expect(422)).body
      expect(failure.error).toMatchObject({ code: 'VALIDATION_FAILED', fieldPath: 'informationDemand[0].volumeMb' })
      expect(failure.data).toBeUndefined()
      expect((await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data).toEqual(latest)
      expect(await readdir(root)).toHaveLength(1)
    } finally {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

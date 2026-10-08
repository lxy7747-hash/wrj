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

// 对接示例拆分：平台定义分布在公共定义与 5 个平台类型文件中，入口与实例分别在 SimSetup 与 INS。
const TYPE_FILES = ['comm_PerDefinition.txt', 'comm_platform_COMMAND_VEHICLE.txt', 'comm_platform_MISSION_UAV.txt',
  'comm_platform_JAMMER.txt', 'comm_platform_REAR.txt', 'comm_platform_SAT.txt']
function typeText(files: Record<string, string>): string { return TYPE_FILES.map(name => files[name] ?? '').join('\n') }
function setupText(files: Record<string, string>): string { return `${files['comm_SimSetup.txt']}\n${files['comm_platform_INS.txt']}` }

// 通信设备按示例写 on；常开断言只针对干扰 weapon 段。
function weaponBlocks(text: string): string { return (text.match(/ {2}weapon [\s\S]*? {2}end_weapon/g) ?? []).join('\n') }

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
    expect(setupText(generated.files)).toContain(`platform STN-01 ${platform.generatedType}`)
    const text = typeText(generated.files)
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
    expect(weaponBlocks(text)).not.toContain('\n    on\n')
    expect(text).toContain(`processor ${jammer.processorId} WSF_SCRIPT_PROCESSOR`)
    expect(text).toContain('execute at_time 0.001 sec absolute')
    expect(text).toContain('execute at_time 120.001 sec absolute')
    expect(text).toContain('jammer.TurnOn();')
    expect(text).toContain('jammer.TurnOff();')
    expect(setupText(generated.files)).toContain('enable JAMMING_REQUEST_INITIATED')
    expect(setupText(generated.files)).toContain('enable JAMMING_REQUEST_CANCELED')
    expect(draft).toEqual(original)
  })

  it('定时触发按配置时刻选模，持续时间生成关闭；超出仿真时长时不写永不执行的关闭', () => {
    const draft = jammerDraft()
    draft.config.jammers[0]!.triggerTimeS = 300
    draft.uiExtensions.jammers[0]!.duration = 60
    const scheduled = buildMissionPackage(draft)
    expect(scheduled.manifest.jammers[0]).toMatchObject({ activation: 'SCHEDULED', startTimeS: 300, stopTimeS: 360 })
    expect(typeText(scheduled.files)).toContain('execute at_time 300 sec absolute')
    expect(typeText(scheduled.files)).toContain('execute at_time 360 sec absolute')
    draft.uiExtensions.jammers[0]!.duration = draft.config.scenario.duration
    const beyond = buildMissionPackage(draft)
    expect(beyond.manifest.jammers[0]).toMatchObject({ startTimeS: 300, stopTimeS: null, durationS: 1200 })
    expect(typeText(beyond.files)).not.toContain('jammer.TurnOff();')
  })

  it('自动探测按 detectionRange 对全部平台做距离判断并生成启停', () => {
    const draft = jammerDraft()
    draft.config.jammers[0]!.autoDetect = true
    const generated = buildMissionPackage(draft)
    expect(generated.manifest.jammers[0]).toMatchObject({ autoDetect: true, activation: 'AUTO_DETECT_RANGE',
      startsOn: true, startTimeS: null, stopTimeS: null, detectionRangeM: 44448, jammingRangeM: 44448, directionDeg: 360 })
    const platforms = typeText(generated.files)
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
    const platforms = typeText(generated.files)
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
    expect(typeText(generated.files)).toContain('WSF_RF_JAMMER')
    expect(typeText(generated.files)).not.toContain('jammer_proc_')
  })

  it.each([
    ['BARRAGE', 'broadband_jamming'], ['SPOT', 'spot_jamming'], ['SWEEP', 'sweep_jamming'],
  ] as const)('显式映射 %s 干扰类型到 %s 模式', (type, mode) => {
    const draft = jammerDraft()
    draft.config.jammers[0]!.type = type
    const generated = buildMissionPackage(draft)
    expect(generated.manifest.jammers[0]!.mode).toBe(mode)
    expect(typeText(generated.files)).toContain(`mode ${mode}`)
  })

  it('总开关或单设备关闭时保留 weapon 配置但不生成任何启停动作', () => {
    const draft = jammerDraft()
    draft.config.jammingEnabled = false
    draft.uiExtensions.jammers[0]!.enabled = true
    const generated = buildMissionPackage(draft)
    expect(generated.manifest.jammers[0]).toMatchObject({ configuredEnabled: false, startsOn: false,
      startTimeS: null, stopTimeS: null, activation: 'DISABLED' })
    expect(typeText(generated.files)).toContain('WSF_RF_JAMMER')
    expect(typeText(generated.files)).not.toContain('jammer_proc_')
    expect(typeText(generated.files)).not.toContain('TurnOn')
    expect(weaponBlocks(typeText(generated.files))).not.toContain('\n    on\n')
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
    expect(platform).toMatchObject({ referenceModel: 'COMMAND_VEHICLE_PLATFORM', mover: 'WSF_SURFACE_MOVER' })
    expect(platform.generatedType).toContain('COMMAND_VEHICLE_PLATFORM')
    expect(typeText(files)).toContain(`platform_type ${platform.generatedType} WSF_PLATFORM`)
    expect(setupText(files)).toContain(`platform AIR-01 ${platform.generatedType}`)
  })

  it('通信卫星按子类型生成候选模型与轨道模板，历元取开始时刻且不写配置坐标', () => {
    const draft = satelliteDraft()
    const original = structuredClone(draft)
    const { files, manifest } = buildMissionPackage(draft)
    const satellite = manifest.platforms.find((item: { platformId: string }) => item.platformId === 'SAT-01')!
    expect(satellite).toMatchObject({ satelliteType: 'TIANTONG', referenceModel: 'TIAN_TONG_SAT',
      mover: 'WSF_SPACE_MOVER', orbitalTemplate: 'CANDIDATE_MODEL' })
    const text = typeText(files)
    expect(text).toContain(`platform_type ${satellite.generatedType} WSF_PLATFORM`)
    expect(text).toContain('mover WSF_SPACE_MOVER')
    expect(text).toContain('    oblate_earth true')
    expect(text).toContain('      epoch_date_time aug 06 2026 08:00:00')
    expect(text).toContain('      semi_major_axis 42164 km')
    expect(text).toContain('      inclination 0 deg')
    expect(text).toContain('    end_orbital_state')
    expect(text).not.toContain('7000 km')
    // 示例固定值：天通接收机噪声系数 2 dB、卫星链路不启用 ITU 衰减、RCS 取 SAT_SIG。
    expect(files['comm_platform_SAT.txt']).toContain('      noise_figure 2 dB')
    expect(files['comm_platform_SAT.txt']).toContain('      attenuation_model none')
    expect(files['comm_platform_SAT.txt']).toContain('  radar_signature SAT_SIG')
    // 卫星位置由轨道决定，实例不写 position 与 altitude，避免配置坐标看起来生效。
    expect(setupText(files)).toContain(`platform SAT-01 ${satellite.generatedType}\n  side blue\n  icon satellite\n  creation_time 0 sec\nend_platform\n`)
    expect(manifest.devices[0]).toMatchObject({ linkType: 'SAT' })
    expect(draft).toEqual(original)
  })

  it('神通卫星按已确认口径使用与天通相同的 GEO 轨道，并套用神通参考模型', () => {
    const draft = satelliteDraft()
    draft.config.platforms[2]!.satelliteType = 'SHENTONG'
    const { files, manifest } = buildMissionPackage(draft)
    const text = typeText(files)
    expect(manifest.platforms[2]).toMatchObject({ referenceModel: 'SHEN_TONG_SAT' })
    expect(text).toContain('      semi_major_axis 42164 km')
    expect(text).toContain('      inclination 0 deg')
    expect(text).toContain('      raan 120 deg')
    expect(text).not.toContain('7000 km')
  })

  it('高空中继复用无人机模型生成并标注中继角色，不新增独立模型', () => {
    const draft = minimalDraft()
    draft.config.platforms[1]!.type = 'FORWARD_RELAY_NODE'
    draft.config.platforms[1]!.category = 'air'
    const { files, manifest } = buildMissionPackage(draft)
    const relay = manifest.platforms.find((item: { platformId: string }) => item.platformId === 'AIR-01')!
    expect(relay).toMatchObject({ referenceModel: 'MISSION_UAV_PLATFORM', mover: 'WSF_AIR_MOVER', relayRole: true })
    expect(manifest.platforms[0]).toMatchObject({ relayRole: false })
    expect(typeText(files)).toContain('mover WSF_AIR_MOVER')
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
    const text = typeText(files)
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
    expect(typeText(off.files)).not.toContain('    on\n  end_sensor')
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
    const forwardText = typeText(forward.files)
    expect(forwardText).toContain('      bit_error_probability 0.00001')
    // 示例 C 波段定向天线：俯仰 88°、下倾 3°；上行接前向时延处理器。
    expect(forwardText).toContain('    elevation_beamwidth 88 deg')
    expect(forwardText).toContain('      antenna_tilt -3 deg')
    expect(forwardText).toContain('    internal_link forward_delay')
    link.direction = 'REVERSE'
    draft.config.informationDemand[0]!.direction = 'REVERSE'
    const reverse = buildMissionPackage(draft)
    expect(reverse.manifest.devices[0]).toMatchObject({ role: 'DOWNLINK' })
    expect(typeText(reverse.files)).toContain('    internal_link return_delay')
    // 微波不带波段与角色；误码概率按示例写在公共介质的 mode 中，所有无线链路一致。
    link.type = 'MICROWAVE'
    const microwave = buildMissionPackage(draft)
    expect(microwave.manifest.devices[0]).toMatchObject({ band: null, role: null, bitErrorProbability: null })
    const microwaveText = typeText(microwave.files)
    expect(microwaveText).toContain('      bit_error_probability 0.00001')
    expect(microwaveText).not.toContain('antenna_tilt')
    expect(microwaveText).not.toContain('WSF_DELAY_PROCESSOR')
    expect(microwaveText).toContain('      polarization horizontal')
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
    const entry = setupText(files)
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
    const entry = setupText(files)
    expect(entry).toContain('clock_rate 4')
    expect(entry).toContain('multi_thread')
    // 环境按示例写在 comm_PerDefinition.txt；雨区高度与云层取示例固定值。
    const definition = files['comm_PerDefinition.txt']
    expect(definition).toContain('global_environment')
    expect(definition).toContain('  sea_state 3')
    expect(definition).toContain('  rain_rate 12.5 mm/hr')
    expect(definition).toContain('  rain_altitude_limit 3000 m')
    expect(definition).toContain('  cloud_altitude_limits 500 m 2000 m')
    expect(definition).toContain('  cloud_water_density 0.5 g/m3')
    expect(definition).toContain('end_global_environment')
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
    expect(setupText(files)).toContain('start_date jan 05 2025')
    expect(setupText(files)).toContain('start_time 23:59:59.500')
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
    expect(typeText(files)).toContain(`SetType("${demand.informationType}")`)
    expect(typeText(files)).toContain(`SetSubType("${demand.id}")`)
    expect(typeText(files)).toContain('SetSizeInBits(2048)')
    expect(typeText(files)).toContain('emissionIndex / 3.00000000000000000e+0')
    expect(typeText(files)).toContain('ExecuteScriptAtTime(0, "QueueBusiness")')
    expect(typeText(files)).toContain('ExecuteScriptAtTime(TIME_NOW, "EmitBusiness")')
    expect(typeText(files)).toContain(`TIME_NOW >= ${draft.config.scenario.duration}`)
    expect(typeText(files)).toContain(`SendMessage(message, "AIR-01", "${manifest.devices[0].target.deviceId}")`)
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
      expect(typeText(generated.files)).not.toContain('SendMessage')
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
    expect(typeText(generated.files).match(/SendMessage\(/g)).toHaveLength(2)
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
    expect(typeText(multi.files).match(/SendMessage\(/g)).toHaveLength(1)
    expect(typeText(multi.files)).not.toContain('activeRouteIndex')
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
    // 入口与文件拆分同对接示例：SimSetup 依次包含 5 个平台类型文件、实例与观察者；类型文件引用公共定义。
    expect(manifest.entry).toBe('comm_SimSetup.txt')
    expect(files['comm_SimSetup.txt']).toContain(['include_once comm_platform_COMMAND_VEHICLE.txt',
      'include_once comm_platform_MISSION_UAV.txt', 'include_once comm_platform_JAMMER.txt',
      'include_once comm_platform_REAR.txt', 'include_once comm_platform_SAT.txt',
      'include_once comm_platform_INS.txt', 'include_once observers.txt'].join('\n'))
    for (const name of TYPE_FILES.slice(1)) expect(files[name]).toMatch(/^include_once comm_PerDefinition\.txt\n/)
    expect(files['comm_SimSetup.txt']).toContain('simulation_name "MultiMethod_UAV_Comm_Scenario"')
    expect(files['comm_SimSetup.txt']).toContain('event_pipe\n   file output/scenario_events.aer\nend_event_pipe')
    expect(Object.keys(files)).not.toContain('mission.txt')
    expect(Object.keys(files)).not.toContain('platforms.txt')
    expect(setupText(files)).toContain(`end_time ${draft.config.scenario.duration} sec`)
    for (const platform of draft.config.platforms) {
      expect(setupText(files)).toContain(`platform ${platform.id} `)
      expect(setupText(files)).toContain(`position ${platform.initialPosition.latitude}n ${platform.initialPosition.longitude}e`)
      expect(setupText(files)).toContain(`altitude ${platform.initialPosition.altitude} m`)
    }
    const text = typeText(files)
    expect(text.match(/  comm /g)).toHaveLength(2)
    expect(text.match(/frequency 4500 MHz/g)).toHaveLength(4)
    expect(text.match(/bandwidth 20 MHz/g)).toHaveLength(4)
    expect(text.match(/power 100 W/g)).toHaveLength(2)
    expect(text.match(/transfer_rate constant 20 mbits\/sec/g)).toHaveLength(2)
    // 每台设备独立介质，避免共享介质被逐台改写；参数与示例介质一致。
    expect(text.match(/    add medium medium_comm_/g)).toHaveLength(2)
    expect(text.match(/^medium medium_comm_\S+ WSF_COMM_MEDIUM_UNGUIDED$/gm)).toHaveLength(2)
    expect(text).not.toContain('add medium UAV_MESH_MEDIUM')
    // 示例固定值：接收机噪声系数、RCS 与 ITU 衰减。
    expect(text.match(/noise_figure 3 dB/g)).toHaveLength(2)
    expect(text.match(/attenuation_model itu/g)).toHaveLength(2)
    expect(text).toContain('medium UAV_MESH_MEDIUM WSF_COMM_MEDIUM_UNGUIDED')
    expect(text).toContain('radar_signature COMMAND_VEHICLE_SIG')
    expect(setupText(files)).toContain('  side blue')
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
    // 不复制示例剧情（硬编码平台名与阶段），也不泄露本机路径。
    for (const forbidden of ['mission_uav_0', 'PHASE', 'SendMessage', '17:30', 'H:\\', 'scenario "']) {
      expect(setupText(files) + text + files['observers.txt']).not.toContain(forbidden)
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
    expect(typeText(generated.files)).toContain('frequency 8000 MHz')
    expect(typeText(generated.files)).toContain('frequency 4500 MHz')
    draft.config.links[0]!.enabled = false
    draft.config.informationDemand[0]!.enabled = true
    const stopped = buildMissionPackage(draft)
    expect(stopped.manifest.devices).toEqual([mappings[1]])
    expect(stopped.manifest.excludedLinkIds).toEqual(['L-A'])
    expect(typeText(stopped.files)).not.toContain(mappings[0].source.deviceId)
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

  it('后方节点挂载 link_calc：参数结构同示例，由场景配置汇总，JSON 内层引号不转义', () => {
    const draft: ScenarioDraft = new ScenarioProjection().get('SCN-001').data
    draft.config.links.find(link => link.type === 'LASER')!.enabled = false
    draft.config.informationDemand[0]!.enabled = false
    draft.config.output.linkQualityEnabled = false
    draft.config.output.linkSwitchEnabled = false
    const { files, manifest } = buildMissionPackage(draft)
    const rear = manifest.platforms.find((item: { referenceModel: string }) => item.referenceModel === 'REAR_COMM_PLATFORM')!
    expect(manifest.linkCalc).toMatchObject({ emitted: true, hostPlatformId: rear.platformId })
    const rearText = files['comm_platform_REAR.txt']
    const block = rearText.slice(rearText.indexOf('  add processor link_calc WSF_LINK_CALC_PROCESSOR'))
    expect(rearText.match(/add processor link_calc/g)).toHaveLength(1)
    expect(block).toContain('    update_interval 3.0 sec\n    emergency_threshold 0.80\n    warning_threshold   0.50\n')
    const value = (name: string) => {
      const line = block.split('\n').find((item: string) => item.trimStart().startsWith(`${name} `))!
      const raw = line.trim().slice(name.length).trim()
      // 示例写法：外层双引号直接包裹 JSON，内层双引号不转义。
      expect(raw.startsWith('"') && raw.endsWith('"')).toBe(true)
      expect(raw).not.toContain('\\"')
      return JSON.parse(raw.slice(1, -1))
    }
    const relayIds = manifest.platforms.filter((item: { relayRole: boolean }) => item.relayRole).map((item: { platformId: string }) => item.platformId)
    expect(value('relay_uav_names')).toEqual(relayIds)
    const forward = manifest.devices.filter((item: { direction: string }) => item.direction === 'FORWARD')
    const hotForward = value('hot_link_fw')
    expect(Object.keys(hotForward)).toHaveLength(forward.length)
    expect(hotForward.link1[0]).toEqual({ platform: forward[0].source.platformId, inPort: '', outPort: forward[0].source.deviceId })
    expect(hotForward.link1.at(-1)).toEqual({ platform: forward[0].target.platformId, inPort: forward[0].target.deviceId, outPort: '' })
    expect(Object.keys(value('hot_link_ret'))).toHaveLength(manifest.devices.length - forward.length)
    // port_params 由实际设备参数生成，平台类型名与设备编号能在生成的脚本中找到。
    const allText = typeText(files)
    for (const entry of value('port_params')) {
      expect(allText).toContain(`platform_type ${entry.platform_type} WSF_PLATFORM`)
      for (const comm of entry.comm_params) expect(allText).toContain(`  comm ${comm.comm_name} `)
    }
    const environment = value('natural_environment')
    expect(environment.sea_state.sea_state_level).toBe(draft.config.scenario.environment.seaState)
    expect(environment.rain.rain_rate_mm_hr).toBe(draft.config.scenario.environment.rainRateMmPerHour)
    // 未框选海面区域时不写坐标；海况是否计入跟随“海面多径衰落”开关。
    expect(environment.sea_state.sea_polygon).toEqual([])
    expect(environment.sea_state.enabled).toBe(draft.config.scenario.environment.multipathEnabled)
  })

  it('海面多径衰落：框选区域写入 sea_polygon，开关写入 sea_state.enabled', () => {
    const draft = minimalDraft()
    draft.config.scenario.environment.multipathEnabled = false
    draft.config.scenario.environment.seaPolygon = [{ longitude: 118.5, latitude: 24.1 }, { longitude: 120, latitude: 24.2 }, { longitude: 119.6, latitude: 25.3 }]
    const text = buildMissionPackage(draft).files['comm_platform_REAR.txt']
    expect(text).toContain('"sea_state":{"enabled":false,"sea_state_level":')
    expect(text).toContain('"sea_polygon":[{"lat":24.1,"lon":118.5},{"lat":24.2,"lon":120},{"lat":25.3,"lon":119.6}]')
  })

  it('云层参数与 L 波段取自场景配置：L 波段不下倾、全向俯仰波束', () => {
    const draft = minimalDraft()
    Object.assign(draft.config.scenario.environment, { cloudAltitudeMinM: 800, cloudAltitudeMaxM: 2500, cloudWaterDensityGM3: 0.3 })
    Object.assign(draft.config.links[0]!, { type: 'DATALINK', direction: 'FORWARD', band: 'L' })
    const { files, manifest } = buildMissionPackage(draft)
    expect(files['comm_PerDefinition.txt']).toContain('  cloud_altitude_limits 800 m 2500 m\n  cloud_water_density 0.3 g/m3\n')
    expect(files['comm_platform_REAR.txt']).toContain('"cloud":{"enabled":true,"cloud_altitude_min_m":800,"cloud_altitude_max_m":2500,"cloud_water_density_g_m3":0.3}')
    expect(manifest.devices[0]).toMatchObject({ band: 'L', role: 'UPLINK' })
    const text = typeText(files)
    expect(text).not.toContain('antenna_tilt')
    expect(text).not.toContain('elevation_beamwidth 88 deg\n  end_uniform_pattern\nend_antenna_pattern\nantenna_pattern comm_')
    expect(text).toContain('    internal_link forward_delay')
  })

  it('阶段切换规则：按列表顺序判断距离与干扰条件，受滞回时间约束切换发送设备', () => {
    const draft = jammerDraft()
    const config = draft.config
    config.links.push({ ...config.links[0]!, id: 'L-B', frequency: 8200 })
    config.platforms[0]!.linkIds.push('L-B')
    config.platforms[1]!.linkIds.push('L-B')
    Object.assign(config.informationDemand[0]!, { enabled: true, frequencyHz: 0.5 })
    config.linkSettings = { enabledSatellites: { TIANTONG: false, SHENTONG: false }, switchCooldownS: 7,
      priority: ['DATALINK', 'MICROWAVE', 'SAT', 'LASER', 'FIBER'], switchRules: [
        { id: 'RULE-JAM', trigger: 'JAMMING_ACTIVE', jammerId: 'JAM-WB-01-TX', sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', toLinkId: 'L-B' },
        { id: 'RULE-CLR', trigger: 'JAMMING_STOPPED', jammerId: 'JAM-WB-01-TX', sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', toLinkId: 'L-A' },
        { id: 'RULE-FAR', trigger: 'DISTANCE_ABOVE', distanceThresholdM: 200000, sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', toLinkId: 'L-B' },
        { id: 'RULE-OFF', enabled: false, trigger: 'DISTANCE_BELOW', distanceThresholdM: 1, sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', toLinkId: 'L-A' },
      ] }
    const { files, manifest } = buildMissionPackage(draft)
    const business = manifest.businesses[0]
    expect(business.failoverEnabled).toBe(true)
    expect(business.routePlans[0].switchRuleIds).toEqual(['RULE-JAM', 'RULE-CLR', 'RULE-FAR'])
    const text = files['comm_platform_REAR.txt']
    const linkA = manifest.devices.find((item: { linkId: string }) => item.linkId === 'L-A')
    const linkB = manifest.devices.find((item: { linkId: string }) => item.linkId === 'L-B')
    expect(text).toContain(`      string routeComm_0 = "${linkA.source.deviceId}";`)
    expect(text).toContain('PLATFORM.Comm(routeComm_0).SendMessage(message, routePlatform_0, routeDevice_0);')
    expect(text).toContain('    execute at_interval_of 3 sec')
    expect(text).toContain(`          WsfWeapon jammer = jammerPlatform.Weapon("${manifest.jammers[0].weaponId}");`.replace(/^ {10}/, '            '))
    expect(text).toContain('              condition = jammer.IsTurnedOn();')
    expect(text).toContain('              condition = jammerSeenOn_0_1 && !jammer.IsTurnedOn();')
    expect(text).toContain('if (peer.IsValid()) condition = PLATFORM.SlantRangeTo(peer) > 200000;')
    expect(text).toContain(`            nextComm = "${linkB.source.deviceId}";`)
    expect(text).toContain('          && TIME_NOW - routeSwitchedAt_0 >= 7)')
    expect(text).toContain('writeln("LINK_SWITCH time=", TIME_NOW, " business=')
    // 停用的规则不生成；规则顺序即优先顺序（干扰规则在距离规则之前判断）。
    expect(text).not.toContain('RULE-OFF')
    expect(text.indexOf('ruleId = "RULE-JAM"')).toBeLessThan(text.indexOf('ruleId = "RULE-FAR"'))
  })

  it('切换规则只作用于同方向业务：返向目标链路不挂到前向路由', () => {
    const draft = jammerDraft()
    const config = draft.config
    config.links.push({ ...config.links[0]!, id: 'L-REV', direction: 'REVERSE', frequency: 8200 })
    config.platforms[0]!.linkIds.push('L-REV')
    config.platforms[1]!.linkIds.push('L-REV')
    Object.assign(config.informationDemand[0]!, { enabled: true, frequencyHz: 0.5 })
    config.linkSettings = { enabledSatellites: { TIANTONG: false, SHENTONG: false }, switchCooldownS: 5,
      priority: ['DATALINK', 'MICROWAVE', 'SAT', 'LASER', 'FIBER'], switchRules: [
        { id: 'RULE-REV', trigger: 'DISTANCE_ABOVE', distanceThresholdM: 1000, sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', toLinkId: 'L-REV' },
      ] }
    // 只有前向业务时，共享校验阻断并定位到规则目标链路。
    expect(() => buildMissionPackage(draft)).toThrow('linkSettings.switchRules[0].toLinkId')
    // 不限方向的旧业务可通过校验；按优先级选出前向主链路后，返向规则不挂到该路由。
    const demand = config.informationDemand[0]!
    delete demand.linkId
    delete demand.direction
    const business = buildMissionPackage(draft).manifest.businesses[0]
    expect(business.routePlans[0]).toMatchObject({ orderedLinkIds: ['L-A', 'L-REV'], switchRuleIds: [] })
    expect(business.failoverEnabled).toBe(false)
  })

  it('切换目标链路停用时阻断生成并定位到规则', () => {
    const draft = minimalDraft()
    draft.config.links.push({ ...draft.config.links[0]!, id: 'L-B', enabled: false })
    draft.config.platforms.forEach(platform => platform.linkIds.push('L-B'))
    draft.config.linkSettings = { enabledSatellites: { TIANTONG: false, SHENTONG: false }, switchCooldownS: 5,
      priority: ['DATALINK', 'MICROWAVE', 'SAT', 'LASER', 'FIBER'], switchRules: [
        { id: 'RULE-1', trigger: 'DISTANCE_ABOVE', distanceThresholdM: 1000, sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', toLinkId: 'L-B' },
      ] }
    expect(() => buildMissionPackage(draft)).toThrow('linkSettings.switchRules[0].toLinkId')
  })

  it('无后方节点时不生成 link_calc，并在映射中说明', () => {
    const draft = minimalDraft()
    draft.config.platforms[0]!.type = 'GROUND_CLUSTER_COMMAND_NODE'
    const { files, manifest } = buildMissionPackage(draft)
    expect(typeText(files)).not.toContain('link_calc')
    expect(manifest.linkCalc).toMatchObject({ emitted: false, hostPlatformId: null })
  })

  it('数传经高空中继时，中继入口使用独立时延处理器再转发，不与其他链路共用', () => {
    const draft = minimalDraft()
    const relay = structuredClone(draft.config.platforms[1]!)
    relay.id = 'RLY-01'
    relay.type = 'FORWARD_RELAY_NODE'
    relay.linkIds = ['L-A']
    draft.config.platforms.push(relay)
    Object.assign(draft.config.links[0]!, { type: 'DATALINK', direction: 'FORWARD', relayPlatformId: 'RLY-01' })
    const { files, manifest } = buildMissionPackage(draft)
    const device = manifest.devices[0]
    const text = files['comm_platform_MISSION_UAV.txt']
    const delayId = text.match(/processor (forward_delay_[0-9a-f_]+) WSF_DELAY_PROCESSOR/)![1]
    expect(text).toContain(`  comm ${device.relay.ingressDeviceId} WSF_RADIO_TRANSCEIVER`)
    expect(text).toContain(`    internal_link ${delayId}\n  end_comm`)
    expect(text).toContain(`    time_distribution constant time 1.0 sec\n    internal_link ${device.relay.processorId}\n  end_processor`)
    // 端点（后方节点、目标无人机）使用共用的 forward_delay → script_proc。
    expect(files['comm_platform_REAR.txt']).toContain('  processor forward_delay WSF_DELAY_PROCESSOR')
    expect(files['comm_platform_REAR.txt']).toContain('  processor script_proc WSF_SCRIPT_PROCESSOR')
  })

  it('关闭事件输出时不写事件配置；无链路仍能生成节点且不伪造设备', () => {
    const draft = minimalDraft()
    draft.config.links[0]!.enabled = false
    draft.config.output.eventsEnabled = false
    const { files, manifest } = buildMissionPackage(draft, { ...draft.config.output, eventsEnabled: false })
    expect(setupText(files)).not.toContain('csv_event_output')
    expect(typeText(files)).not.toContain('  comm ')
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
      expect(first.endsWith('comm_SimSetup.txt')).toBe(true)
      expect(await readFile(first, 'utf8')).toBe(await readFile(second, 'utf8'))
      expect(await readdir(join(dirname(first), draft.config.output.directory))).toEqual([])
      expect(await readFile(join(dirname(first), `SCN-001-r${draft.revision}.txt`), 'utf8')).toContain(script.preview)
      const manifest = JSON.parse(await readFile(join(dirname(first), 'mapping.json'), 'utf8'))
      expect(manifest).toMatchObject({ scenarioId: 'SCN-001', revision: draft.revision, engineValidated: false })
      for (const dependency of [...TYPE_FILES, 'comm_platform_INS.txt', 'observers.txt', 'input.json', 'README.txt']) {
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
    expect(typeText(generated.files)).toContain('WSF_COMM_TRANSCEIVER')
    expect(typeText(generated.files)).toContain('WSF_COMM_NETWORK_P2P')
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
    expect(typeText(generated.files)).toContain('on_message')
    expect(typeText(generated.files)).toContain('relay_proc_')
    expect(typeText(generated.files)).toContain('comm_')
  })

  it('输出目录写入包内 csv 路径；缺少真实质量和切换测量时明确阻断', () => {
    const draft = minimalDraft()
    draft.config.output.directory = 'custom_out'
    draft.config.output.eventsEnabled = true
    const generated = buildMissionPackage(draft, draft.config.output)
    expect(setupText(generated.files)).toContain('file custom_out/scenario_events.csv')
    expect(generated.files['observers.txt']).toContain('custom_out/position.csv')
    expect(typeText(generated.files)).not.toContain('link_quality.csv')
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
    expect(typeText(generated.files)).toContain('relay_proc_')
    expect(typeText(generated.files)).toContain('on_message')
    expect(setupText(generated.files)).toContain('platform RELAY-01 ')
    expect(typeText(generated.files)).toContain(`internal_link ${generated.manifest.devices[0]!.relay!.processorId}`)
    expect(typeText(generated.files)).toContain('on_message\n      default')
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
    expect(typeText(generated.files)).not.toContain('FailoverToNextRoute')
    expect(typeText(generated.files)).not.toContain('activeRouteIndex')
    expect(typeText(generated.files)).not.toContain('link_switch.csv')
    expect(typeText(generated.files)).not.toContain('link_quality.csv')
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
      expect(result.path.endsWith('comm_SimSetup.txt')).toBe(true)
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

import type { LinkCalcSettings, LinkSwitchTrigger, SatelliteType, ScenarioDraft } from '../../src/contracts/domain-models.js'
import { configuredScenarioOutput } from '../../src/config/app.config.js'
import { INFORMATION_TYPE_DIRECTIONS, inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation.js'
import { isConfiguredLinkEnabled, readLinkSettings } from '../../src/features/scenarios/link-settings.js'
import {
  defaultPolarization, fixedLinkDataRate, readLinkCalcSettings, readNaturalEnvironment, RECEIVER_NOISE_FIGURE_DB, TIANTONG_NOISE_FIGURE_DB,
  type NaturalEnvironment,
} from '../../src/features/scenarios/link-calc-defaults.js'
import { METERS_PER_NAUTICAL_MILE, readJammerReleaseRange } from '../../src/features/scenarios/jammer-settings.js'
import { HOT_LINK_END_REFERENCE_MODELS, readHotLinks } from '../../src/features/scenarios/hot-links.js'

export class MissionGenerationError extends Error {
  constructor(readonly fieldPath: string, reason: string) {
    super(`${fieldPath}：${reason}`)
    this.name = 'MissionGenerationError'
  }
}

type JammerConfig = ScenarioDraft['config']['jammers'][number]
type JammerExtension = ScenarioDraft['uiExtensions']['jammers'][number]
type JammerMode = 'broadband_jamming' | 'spot_jamming' | 'sweep_jamming'
type JammerActivation = 'DISABLED' | 'AUTO_DETECT_RANGE' | 'TRIGGER_NOT_CONFIGURED' | 'SCHEDULED'

type GeneratedWaypoint = {
  longitude: number
  latitude: number
  altitude: number
  speed: number
  arrivalTimeS: number
  /** 候选脚本没有与到达时间同名的约束，本批只按 speed 推进路线。 */
  arrivalTimeEnforced: false
}

type GeneratedJammer = {
  jammerId: string
  platformId: string
  weaponId: string
  processorId: string
  type: JammerConfig['type']
  model: 'WSF_RF_JAMMER'
  mode: JammerMode
  frequencyMHz: number
  frequencyHz: number
  bandwidthMHz: number
  bandwidthHz: number
  powerW: number
  globalEnabled: boolean
  extensionEnabled: boolean
  configuredEnabled: boolean
  autoDetect: boolean
  detectionRangeM: number
  jammingRangeM: number
  /** 干扰机离开后的释放距离，写入 jammer_param.release_radius_nm。 */
  releaseRangeM: number
  triggerTimeS: number | null
  directionDeg: number
  durationS: number
  startsOn: boolean
  /** 引擎实际选模时刻；未生成启停动作时为 null。 */
  startTimeS: number | null
  /** 引擎实际关闭时刻；未配置持续时间或关闭时刻超出仿真时长时为 null。 */
  stopTimeS: number | null
  activation: JammerActivation
}

const NOTICE = '候选 AFSIM 节点/微波/干扰设备验证包；生成成功不代表执行成功，也不是完整业务仿真脚本。'

// 已核实候选模型映射（映射表 13.1）。高空中继按已确认选择复用无人机模型，不新增独立模型。
const MODELS = {
  REAR_COMMAND_NODE: { reference: 'REAR_COMM_PLATFORM', mover: 'WSF_GROUND_MOVER' },
  // 已确认选择：指挥车运动器与对接示例一致。
  GROUND_CLUSTER_COMMAND_NODE: { reference: 'COMMAND_VEHICLE_PLATFORM', mover: 'WSF_SURFACE_MOVER' },
  AIRBORNE_MISSION_CLUSTER: { reference: 'MISSION_UAV_PLATFORM', mover: 'WSF_AIR_MOVER' },
  FORWARD_RELAY_NODE: { reference: 'MISSION_UAV_PLATFORM', mover: 'WSF_AIR_MOVER' },
  GROUND_JAMMER_DETECTION_STATION: { reference: 'GROUND_JAMMER_STATION', mover: 'WSF_SURFACE_MOVER' },
  AIRBORNE_JAMMER_PLATFORM: { reference: 'AIRBORNE_JAMMER_PLATFORM', mover: 'WSF_AIR_MOVER' },
} as const

// 需要标注中继角色的场景实体类型；角色只作记录，不代表已生成中继转发行为。
const RELAY_PLATFORM_TYPES = new Set(['FORWARD_RELAY_NODE'])

// 当前配置类型到候选脚本 mode 标识的显式绑定；不能把前端枚举原样写成引擎模式。
const JAMMER_MODES: Record<JammerConfig['type'], JammerMode> = {
  BARRAGE: 'broadband_jamming',
  SPOT: 'spot_jamming',
  SWEEP: 'sweep_jamming',
}

// 卫星子类型的候选模型与轨道模板，取自候选脚本 comm_platform_SAT.txt 的模型定义。
// 轨道要素是候选模型的给定值，不是按任务推算出来的；不复制示例中的转发剧情与设备编号。
const SATELLITE_MODELS: Record<SatelliteType, { reference: string; orbital: readonly string[] }> = {
  TIANTONG: { reference: 'TIAN_TONG_SAT', orbital: [
    '      semi_major_axis 42164 km', '      eccentricity 0.0', '      inclination 0 deg',
    '      raan 120 deg', '      argument_of_periapsis 0 deg', '      mean_anomaly 0 deg'] },
  // 已确认选择：神通与天通使用相同的 GEO 轨道要素。
  SHENTONG: { reference: 'SHEN_TONG_SAT', orbital: [
    '      semi_major_axis 42164 km', '      eccentricity 0.0', '      inclination 0 deg',
    '      raan 120 deg', '      argument_of_periapsis 0 deg', '      mean_anomaly 0 deg'] },
}

/**
 * 对接示例的文件拆分与平台类型固定值（已确认：文件名必须一致，界面没有的参数按示例写死）。
 * file 决定平台类型定义写入哪个示例文件；其余字段写入平台类型或实例。
 */
const REFERENCE_PROFILES: Record<string, {
  file: string; signature: string; side: 'blue' | 'red'; icon: string | null; heading: boolean; createdAtStart: boolean
}> = {
  COMMAND_VEHICLE_PLATFORM: { file: 'comm_platform_COMMAND_VEHICLE.txt', signature: 'COMMAND_VEHICLE_SIG', side: 'blue', icon: '737', heading: true, createdAtStart: false },
  MISSION_UAV_PLATFORM: { file: 'comm_platform_MISSION_UAV.txt', signature: 'DRONE_SIG', side: 'blue', icon: 'F-18', heading: true, createdAtStart: false },
  GROUND_JAMMER_STATION: { file: 'comm_platform_JAMMER.txt', signature: 'COMMAND_VEHICLE_SIG', side: 'red', icon: 'triangle', heading: false, createdAtStart: true },
  AIRBORNE_JAMMER_PLATFORM: { file: 'comm_platform_JAMMER.txt', signature: 'DRONE_SIG', side: 'red', icon: 'triangle', heading: false, createdAtStart: true },
  REAR_COMM_PLATFORM: { file: 'comm_platform_REAR.txt', signature: 'COMM_VEHICLE_SIG', side: 'blue', icon: null, heading: false, createdAtStart: false },
  TIAN_TONG_SAT: { file: 'comm_platform_SAT.txt', signature: 'SAT_SIG', side: 'blue', icon: 'satellite', heading: false, createdAtStart: true },
  SHEN_TONG_SAT: { file: 'comm_platform_SAT.txt', signature: 'SAT_SIG', side: 'blue', icon: 'satellite', heading: false, createdAtStart: true },
}
/** 与示例 comm_SimSetup.txt 的 include 顺序一致；无对应平台的文件也照常生成。 */
const PLATFORM_TYPE_FILES = ['comm_platform_COMMAND_VEHICLE.txt', 'comm_platform_MISSION_UAV.txt',
  'comm_platform_JAMMER.txt', 'comm_platform_REAR.txt', 'comm_platform_SAT.txt'] as const
const DEFINITION_FILE = 'comm_PerDefinition.txt'
const INSTANCE_FILE = 'comm_platform_INS.txt'
const ENTRY_FILE = 'comm_SimSetup.txt'

// 示例固定值：通信设备的公共介质、信道数与接收机参数。
const COMM_MEDIUM = 'UAV_MESH_MEDIUM'
const COMM_CHANNELS = 4
const BIT_ERROR_PROBABILITY = 0.00001
// 指挥车 C 波段定向天线：俯仰波束 88°，下倾 3°；任务机 C 波段按文档为全向 180°。
const DATALINK_C_ELEVATION_BEAMWIDTH_DEG = 88
const DATALINK_C_ANTENNA_TILT_DEG = -3
// 示例时延处理器：先进先出、10 个服务台、固定 1 秒。
const DELAY_TEMPLATE = ['    queuing_method first_in_first_out', '    number_of_servers 10',
  '    time_distribution constant time 1.0 sec'] as const
// 示例 link_calc 的固定参数；阈值、编码与环境参数来自场景配置（缺省按《与前端字段确认说明》）。
const LINK_CALC_TEMPLATE = {
  updateIntervalS: 3.0,
  cloud: { minM: 500, maxM: 2000, waterDensityGM3: 0.5 },
} as const
// 业务类型到 traffic_type 的对应；字段名 traffice_type 按文档原样拼写（已确认）。分组方向取共享规则 INFORMATION_TYPE_DIRECTIONS。
const TRAFFIC_TYPES: Record<keyof typeof INFORMATION_TYPE_DIRECTIONS, string> = {
  '态势信息': 'kForwardSituation',
  '目标指令': 'kForwardTarget',
  '侦察信息': 'kReturnReconVideo',
  '状态信息': 'kReturnReconStatus',
}
// jammer_param 中文档注明“写死”的字段。
const JAMMER_PARAM_FIXED = { antenna_gain_dbi: 0.0, tx_loss_db: 0.0, spot_bandwidth_mhz: 20.0, sweep_duty_cycle: 0.1 } as const
const JAMMER_PARAM_MODES: Record<JammerConfig['type'], string> = { BARRAGE: 'broadband', SPOT: 'spot', SWEEP: 'sweep' }
const SIMULATION_NAME = 'MultiMethod_UAV_Comm_Scenario'

// 以下固定段落原样取自对接示例 comm_PerDefinition.txt。
const GLOBAL_SCRIPT_VARIABLES = ['script_variables',
  '  string INFO_TYPE_FORWARD_SITUATION = "forward_situation";',
  '  string INFO_TYPE_FORWARD_TARGET    = "forward_target";',
  '  string INFO_TYPE_BACK_RECON        = "back_recon";',
  '  string INFO_TYPE_BACK_STATUS       = "back_status";',
  '  double FORWARD_SITUATION_FREQ_SEC  = 1.0;', '  double FORWARD_TARGET_FREQ_SEC     = 1.0;',
  '  double BACK_RECON_FREQ_SEC         = 10.0;', '  double BACK_STATUS_FREQ_SEC        = 5.0;',
  '  double FORWARD_SITUATION_DELAY_SEC = 1.0;', '  double FORWARD_TARGET_DELAY_SEC    = 1.0;',
  '  double BACK_RECON_DELAY_SEC        = 2.0;', '  double BACK_STATUS_DELAY_SEC       = 5.0;',
  'end_script_variables'] as const

function uniformAntenna(name: string, gainDb: number, azimuthDeg: number, elevationDeg: number): string[] {
  return [`antenna_pattern ${name}`, '  uniform_pattern', `    peak_gain ${gainDb} dB`,
    `    azimuth_beamwidth ${azimuthDeg} deg`, `    elevation_beamwidth ${elevationDeg} deg`,
    '  end_uniform_pattern', 'end_antenna_pattern']
}
const FIXED_ANTENNA_PATTERNS = [
  ...uniformAntenna('OMNI_ANTENNA', 0, 360, 180),
  ...uniformAntenna('OMNI_ANTENNA_HIGHGAIN', 8, 360, 180),
  ...uniformAntenna('C_BAND_DIRECTIONAL_ANTENNA', 25, 360, 88),
  ...uniformAntenna('SAT_COMM_ANTENNA', 25, 360, 180),
  ...uniformAntenna('LASER_COMM_ANTENNA', 40, 5, 5),
]
const FIXED_RADAR_SIGNATURES = [['DRONE_SIG', 1.0], ['COMMAND_VEHICLE_SIG', 10.0], ['COMM_VEHICLE_SIG', 8.0], ['SAT_SIG', 0.5]]
  .flatMap(([name, area]) => [`radar_signature ${name}`, `  constant ${Number(area).toFixed(1)} m^2`, 'end_radar_signature'])
const COMM_MEDIUM_DEFINITION = [`medium ${COMM_MEDIUM} WSF_COMM_MEDIUM_UNGUIDED`, `    channels ${COMM_CHANNELS}`,
  '    default_mode_name "default"', '    mode "default"', '      propagation_speed constant 299792458 m/sec',
  '      transfer_rate constant 4000000 bit/s', '      packet_loss_time constant 0 sec', '    end_mode', 'end_medium'] as const

// 对接示例 comm_SimSetup.txt 的事件开关，去掉重复与注释项，保持首次出现顺序。
const CSV_EVENTS = ['PLATFORM_ADDED', 'PLATFORM_INITIALIZED', 'COMM_TURNED_ON', 'COMM_TURNED_OFF',
  'MESSAGE_TRANSMITTED', 'MESSAGE_RECEIVED', 'JAMMING_REQUEST_INITIATED', 'JAMMING_REQUEST_CANCELED',
  'JAMMING_REQUEST_UPDATED', 'WEAPON_FIRED', 'SENSOR_DETECTION_CHANGED', 'WEAPON_TURNED_ON',
  'WEAPON_MODE_ACTIVATED', 'WEAPON_MODE_DEACTIVATED', 'PLATFORM_DELETED', 'PLATFORM_BROKEN', 'PLATFORM_OMITTED',
  'SIMULATION_STARTING', 'SIMULATION_COMPLETE', 'LINK_ADDED_TO_MANAGER', 'LINK_ENABLED_ON_MANAGER',
  'LINK_DISABLED_ON_MANAGER', 'LINK_REMOVED_FROM_MANAGER', 'MESSAGE_HOP', 'COMM_FREQUENCY_CHANGED',
  'LOCAL_TRACK_INITIATED', 'LOCAL_TRACK_UPDATED', 'LOCAL_TRACK_DROPPED', 'SENSOR_TRACK_INITIATED',
  'SENSOR_TRACK_UPDATED', 'SENSOR_TRACK_DROPPED', 'EXCHANGE_COMPLETED', 'LINK_ENABLED_ON_LOCAL',
  'LINK_DISABLED_ON_LOCAL', 'WEAPON_TURNED_OFF', 'MOVER_TURNED_ON'] as const

// 切换规则检查周期取自示例指挥车脚本（每 3 秒判断一次距离与干扰状态）。
const SWITCH_CHECK_INTERVAL_S = 3

type SendDevice = {
  source: { deviceId: string }
  relay: { platformId: string; ingressDeviceId: string } | null
  target: { platformId: string; deviceId: string }
}

/** 业务消息从源设备发出；经中继时先发到中继入口，否则直接发到目标设备。 */
function sendTarget(device: SendDevice): { comm: string; platform: string; device: string } {
  return { comm: device.source.deviceId,
    platform: device.relay ? device.relay.platformId : device.target.platformId,
    device: device.relay ? device.relay.ingressDeviceId : device.target.deviceId }
}

type SwitchPlan = {
  ruleId: string; trigger: LinkSwitchTrigger; targetPlatformId: string; distanceThresholdM: number | null
  jammer: { platformId: string; weaponId: string } | null; device: SendDevice
}

/**
 * 生成单个业务目标的切换判断：按规则列表顺序，第一条满足条件的规则决定当前链路；
 * 与当前链路不同且距上次切换不少于滞回时间时才切换，并输出 LINK_SWITCH 日志。
 * “干扰设备关闭”只在该设备开启过之后成立，避免仿真起点误判为干扰解除。
 */
function buildSwitchCheck(demandId: string, routeIndex: number, rules: SwitchPlan[], cooldownS: number): string[] {
  const lines = ['      {', '        bool matched = false;', '        string ruleId = "";',
    `        string nextComm = routeComm_${routeIndex};`, `        string nextPlatform = routePlatform_${routeIndex};`,
    `        string nextDevice = routeDevice_${routeIndex};`]
  const jammerState = (rule: SwitchPlan, body: string[]) => [
    `          WsfPlatform jammerPlatform = WsfSimulation.FindPlatform("${rule.jammer!.platformId}");`,
    '          if (jammerPlatform.IsValid())', '          {',
    `            WsfWeapon jammer = jammerPlatform.Weapon("${rule.jammer!.weaponId}");`,
    '            if (jammer.IsValid())', '            {', ...body, '            }', '          }']
  // 先更新各“干扰关闭”规则的开启记录，前面的规则命中时也不能漏记。
  rules.forEach((rule, ruleIndex) => {
    if (rule.trigger !== 'JAMMING_STOPPED') return
    lines.push('        {', ...jammerState(rule, [`              if (jammer.IsTurnedOn()) jammerSeenOn_${routeIndex}_${ruleIndex} = true;`]), '        }')
  })
  rules.forEach((rule, ruleIndex) => {
    const send = sendTarget(rule.device)
    lines.push('        if (!matched)', '        {', '          bool condition = false;')
    if (rule.trigger === 'DISTANCE_ABOVE' || rule.trigger === 'DISTANCE_BELOW') {
      lines.push(`          WsfPlatform peer = WsfSimulation.FindPlatform("${rule.targetPlatformId}");`,
        `          if (peer.IsValid()) condition = PLATFORM.SlantRangeTo(peer) ${rule.trigger === 'DISTANCE_ABOVE' ? '>' : '<'} ${rule.distanceThresholdM};`)
    } else {
      lines.push(...jammerState(rule, [rule.trigger === 'JAMMING_ACTIVE'
        ? '              condition = jammer.IsTurnedOn();'
        : `              condition = jammerSeenOn_${routeIndex}_${ruleIndex} && !jammer.IsTurnedOn();`]))
    }
    lines.push('          if (condition)', '          {', '            matched = true;', `            ruleId = "${rule.ruleId}";`,
      `            nextComm = "${send.comm}";`, `            nextPlatform = "${send.platform}";`, `            nextDevice = "${send.device}";`,
      '          }', '        }')
  })
  lines.push(`        if (matched && (nextComm != routeComm_${routeIndex} || nextPlatform != routePlatform_${routeIndex} || nextDevice != routeDevice_${routeIndex})`,
    `          && TIME_NOW - routeSwitchedAt_${routeIndex} >= ${cooldownS})`, '        {',
    `          writeln("LINK_SWITCH time=", TIME_NOW, " business=${demandId} rule=", ruleId, " from=", routeComm_${routeIndex}, " to=", nextComm);`,
    `          routeComm_${routeIndex} = nextComm;`, `          routePlatform_${routeIndex} = nextPlatform;`,
    `          routeDevice_${routeIndex} = nextDevice;`, `          routeSwitchedAt_${routeIndex} = TIME_NOW;`, '        }', '      }')
  return lines
}

type LinkCalcDevice = {
  direction: 'FORWARD' | 'REVERSE'
  source: { platformId: string; deviceId: string }
  relay: { platformId: string; ingressDeviceId: string; egressDeviceId: string } | null
  target: { platformId: string; deviceId: string }
}

/**
 * 生成对接方程序读取的 link_calc 总配置（已确认 D-02）。
 * JSON 按示例原样包在双引号中、内层不转义（已确认 A-03）；平台与设备编号均已限定为安全字符。
 */
function buildLinkCalcProcessor(input: {
  relayUavNames: string[]; portParams: Map<string, Array<Record<string, unknown>>>
  hotLinks: { forward: LinkCalcDevice[][]; reverse: LinkCalcDevice[][]; endReferenceModel: string }
  environment: NaturalEnvironment; cloud: { minM: number; maxM: number; waterDensityGM3: number }
  seaPolygon: ReadonlyArray<{ lat: number; lon: number }>
  linkCalc: LinkCalcSettings; trafficType: unknown[]; jammerParam: { jammers: unknown[] }
}): string[] {
  // 热链跨多条首尾相接的链路：相邻链路在衔接平台上以上一条的目标设备为入端口、下一条的源设备为出端口。
  const hotLinks = (chains: readonly LinkCalcDevice[][]) => Object.fromEntries(chains.map((chain, index) => {
    const hops: Array<{ platform: string; inPort: string; outPort: string }> = []
    chain.forEach((device, position) => {
      const inPort = position === 0 ? '' : chain[position - 1]!.target.deviceId
      hops.push({ platform: device.source.platformId, inPort, outPort: device.source.deviceId })
      if (device.relay !== null) hops.push({ platform: device.relay.platformId, inPort: device.relay.ingressDeviceId, outPort: device.relay.egressDeviceId })
    })
    const last = chain.at(-1)!
    hops.push({ platform: last.target.platformId, inPort: last.target.deviceId, outPort: '' })
    return [`link${index + 1}`, hops]
  }))
  const template = LINK_CALC_TEMPLATE
  const env = input.environment
  // 字段与默认值取自《与前端字段确认说明》；降雨强度超过 100 mm/h 由后端封顶，这里原样写出。
  const naturalEnvironment = {
    rain: { enabled: env.rainEnabled, rain_rate_mm_hr: env.rainRateMmPerHour, rain_altitude_limit_m: env.rainAltitudeLimitM,
      rain_attenuation_db: env.rainAttenuationDb },
    cloud: { enabled: env.cloudEnabled, cloud_altitude_min_m: input.cloud.minM, cloud_altitude_max_m: input.cloud.maxM, cloud_water_density_g_m3: input.cloud.waterDensityGM3 },
    atmosphere: { enabled: true, model: env.atmosphereModel, simplified_attenuation_db_per_km: env.simplifiedAttenuationDbPerKm },
    misc_loss_db: { polarization_mismatch_db: env.polarizationMismatchDb, pointing_error_db: env.pointingErrorDb, rain_attenuation_db: env.rainAttenuationDb },
    sea_state: { enabled: env.multipathEnabled, sea_state_level: env.seaState, low_altitude_threshold_m: env.seaLowAltitudeThresholdM,
      path_over_sea_threshold_km: env.seaPathOverSeaThresholdKm, model: env.seaModel, polarization: env.seaPolarization,
      sea_water_temp_c: env.seaWaterTempC, sea_surface_roughness_m: env.seaSurfaceRoughnessM,
      use_reflection_geometry: false, sea_polygon: input.seaPolygon },
  }
  const portParams = [...input.portParams].map(([platformType, commParams]) => ({ platform_type: platformType, comm_params: commParams }))
  const raw = (value: unknown) => `"${JSON.stringify(value)}"`
  const { linkCalc } = input
  return ['  add processor link_calc WSF_LINK_CALC_PROCESSOR',
    `    update_interval ${template.updateIntervalS.toFixed(1)} sec`,
    `    emergency_threshold ${linkCalc.emergencyThreshold.toExponential()}`,
    `    warning_threshold   ${linkCalc.warningThreshold.toExponential()}`,
    `    value_threshold_ber ${linkCalc.valueThresholdBer.toExponential()}`,
    `    jamming_range       ${linkCalc.jammingRangeKm} km`,
    `    channel_encoding_scheme ${linkCalc.channelEncodingScheme.toFixed(1)}`,
    `    relay_uav_names         ${raw(input.relayUavNames)}`,
    `    hot_link_ret            ${raw(hotLinks(input.hotLinks.reverse))}`,
    `    hot_link_fw             ${raw(hotLinks(input.hotLinks.forward))}`,
    `    end_platform_type       ${input.hotLinks.endReferenceModel}`,
    `    port_params             ${raw(portParams)}`,
    `    natural_environment     ${raw(naturalEnvironment)}`,
    `    traffic_type            ${raw(input.trafficType)}`,
    `    jammer_param            ${raw(input.jammerParam)}`,
    '  end_processor']
}

/**
 * 按任务机汇总已启用业务，生成 traffic_type：前向类型（态势/目标指令）记在目标平台下，
 * 返向类型（侦察/状态）记在源平台下。trans_freq 为“n 秒/次”，由业务频次（Hz）取倒数。
 */
function buildTrafficType(businesses: ReadonlyArray<{ sourcePlatformId: string; messageType: string; sizeBits: number; frequencyHz: number
  routes: ReadonlyArray<{ target: { platformId: string } }> }>): unknown[] {
  const byPlatform = new Map<string, { forward: unknown[]; return: unknown[] }>()
  for (const business of businesses) {
    if (!Object.hasOwn(TRAFFIC_TYPES, business.messageType)) continue
    const messageType = business.messageType as keyof typeof TRAFFIC_TYPES
    const direction = INFORMATION_TYPE_DIRECTIONS[messageType] === 'FORWARD' ? 'forward' : 'return'
    const entry = { traffice_type: TRAFFIC_TYPES[messageType], data_volume_bits: business.sizeBits, trans_freq: Number((1 / business.frequencyHz).toPrecision(6)) }
    const owners = direction === 'forward' ? business.routes.map(route => route.target.platformId) : [business.sourcePlatformId]
    for (const owner of new Set(owners)) {
      const lists = byPlatform.get(owner) ?? { forward: [], return: [] }
      lists[direction].push(entry)
      byPlatform.set(owner, lists)
    }
  }
  return [...byPlatform].map(([platformId, lists]) => ({ [platformId]: lists }))
}

// 已接通候选设备语法的链路类型；激光没有可用设备，数传按已确认选择固定 C 波段。
const SUPPORTED_LINK_TYPES = ['MICROWAVE', 'DATALINK', 'SAT', 'FIBER'] as const
// 已确认选择：数传波段固定 C，由 direction 决定上下行，误码概率取候选脚本的合同固定值。
const DATALINK_BAND = 'C'
const DATALINK_BIT_ERROR_PROBABILITY = 0.00001
// 已确认选择：侦测设备使用候选脚本的主动雷达模型；界面扩展的 ESM 类型只作记录。
const SENSOR_MODEL = 'WSF_RADAR_SENSOR'
// 候选模型给定的侦测模板参数，配置里没有对应输入项，不另行推算。
const SENSOR_TEMPLATE = {
  frameTimeSec: 5,
  minimumRangeKm: 1,
  transmitterPowerW: 1000,
  noiseFigureDb: 3,
  azimuthFieldOfView: '-180 deg 180 deg',
  elevationFieldOfView: '-10 deg 10 deg',
} as const

// 已确认选择：中文业务类型限定为候选四枚举；生成时校验，SetType 保留中文原值。
const INFORMATION_TYPE_ENUM = ['态势信息', '目标指令', '侦察信息', '状态信息'] as const
type InformationTypeEnum = (typeof INFORMATION_TYPE_ENUM)[number]
const INFORMATION_TYPE_CANDIDATE: Record<InformationTypeEnum, string> = {
  '态势信息': 'forward_situation',
  '目标指令': 'forward_target',
  '侦察信息': 'back_recon',
  '状态信息': 'back_status',
}

// 光纤按候选脚本使用有线收发器；激光仅有天线图形、无已核实 comm 设备。
const FIBER_COMM_MODEL = 'WSF_COMM_TRANSCEIVER'
const FIBER_NETWORK_MODEL = 'WSF_COMM_NETWORK_P2P'
// 干扰自动探测轮询间隔取自候选脚本（3 秒），与输出采样间隔无关。
const AUTO_DETECT_INTERVAL_S = 3

// AFSIM 的 at_time 必须严格大于 0；起点触发使用引擎允许的最小正时刻。
const EARLIEST_TRIGGER_S = 0.001

// 使用无损编码而非替换标点，L-A 和 L_A 不会分配到同一个设备或网络。
function token(id: string): string {
  return Array.from(id, character => character.codePointAt(0)!.toString(16)).join('_')
}

/** 将配置中的 MHz 转成候选脚本常用的 GHz 文本，避免把频率数值当作另一单位。 */
function formatFrequencyGHz(valueMHz: number): string {
  return Number((valueMHz / 1000).toPrecision(12)).toString()
}

/** 为映射清单生成 Hz 字段；超出安全范围时拒绝生成，避免 JSON 精度损坏。 */
function toHertz(valueMHz: number, fieldPath: string): number {
  const valueHz = valueMHz * 1_000_000
  if (!Number.isFinite(valueHz) || Math.abs(valueHz) > Number.MAX_SAFE_INTEGER) {
    throw new MissionGenerationError(fieldPath, '换算为 Hz 后超出安全数值范围。')
  }
  return valueHz
}

/**
 * 按 AFSIM 脚本的原始字符串规则包裹文本；不使用 JSON/JavaScript 转义。
 * 引擎不能无损表达双引号及反斜杠；由生成边界拒绝，不改写业务原值。
 */
function formatAfsimString(value: string): string {
  return `"${value}"`
}

/** 为每台场景干扰设备生成独立、可安全引用的引擎武器编号。 */
function jammerWeaponId(platformId: string, jammerId: string): string {
  return `weapon_${token(platformId)}_${token(jammerId)}`
}

/** 为每台场景干扰设备生成独立的启停处理器编号。 */
function jammerProcessorId(platformId: string, jammerId: string): string {
  return `jammer_proc_${token(platformId)}_${token(jammerId)}`
}

/** 统一写出候选脚本“纬度在前、带半球字母”的位置写法，避免经纬度顺序互换。 */
function formatPosition(latitude: number, longitude: number): string {
  return `${Math.abs(latitude)}${latitude < 0 ? 's' : 'n'} ${Math.abs(longitude)}${longitude < 0 ? 'w' : 'e'}`
}

// 候选脚本入口使用 start_date <三字母月份> <两位日> <四位年>；全称月份和“年在前”的写法都会被引擎拒绝。
const MONTH_ABBREVIATIONS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const

/**
 * 把配置的开始时刻转成候选脚本的 start_date/start_time。
 * 脚本没有时区标记，因此按配置存储的 UTC 分量原样写入，不做本地时区换算，也不丢弃日期。
 */
function formatStartDateTime(iso: string): { date: string; time: string } {
  const instant = new Date(iso)
  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  return {
    date: `${MONTH_ABBREVIATIONS[instant.getUTCMonth()]} ${pad(instant.getUTCDate(), 2)} ${instant.getUTCFullYear()}`,
    time: `${pad(instant.getUTCHours(), 2)}:${pad(instant.getUTCMinutes(), 2)}:${pad(instant.getUTCSeconds(), 2)}.${pad(instant.getUTCMilliseconds(), 3)}`,
  }
}

/** 编译已核实语法的静态节点、微波设备、干扰器和航点路线，不复制候选脚本中的任务剧情。 */
export function buildMissionPackage(draft: ScenarioDraft, output = configuredScenarioOutput(draft.config.scenario.timeStep)) {
  const config = { ...draft.config, output }
  const inspection = inspectScenarioConfig(config, 'write')
  const issue = inspection.result.errors[0]
  if (issue) throw new MissionGenerationError(issue.fieldPath ?? 'config', issue.message)
  const settings = readLinkSettings(config)
  const links = config.links.filter(link => isConfiguredLinkEnabled(link, settings, config.platforms))
  const excluded = new Set(config.links.filter(link => !links.includes(link)).map(link => link.id))
  // 开始时刻在平台定义、卫星轨道历元和入口指令中复用同一份换算结果，避免日期口径不一致。
  const startDateTime = formatStartDateTime(config.scenario.startTime)
  const sensors = config.sensors.map((sensor, index) => {
    const path = `sensors[${index}]`
    const extension = draft.uiExtensions.sensors.find(item => item.sensorId === sensor.id)
    if (extension === undefined) {
      throw new MissionGenerationError(`uiExtensions.sensors[${index}]`, '侦测设备缺少对应的界面扩展配置。')
    }
    const { min, max } = sensor.frequencyRange
    if (!(min > 0) || !(max > 0) || max < min) {
      throw new MissionGenerationError(`${path}.frequencyRange`, '侦测频率范围必须为正数，且上限不小于下限。')
    }
    if (!(sensor.detectionRange > 0)) throw new MissionGenerationError(`${path}.detectionRange`, '侦测距离必须大于 0 m。')
    return {
      sensorId: sensor.id, platformId: sensor.platformId, deviceId: `radar_${token(sensor.id)}`, model: SENSOR_MODEL,
      uiType: extension.type, enabled: extension.enabled,
      // 已确认选择：频率范围取中心频率，带宽取 max−min。
      frequencyMHz: (min + max) / 2, bandwidthMHz: max - min, detectionRangeM: sensor.detectionRange,
      directionDeg: extension.direction === 'OMNI' ? null : extension.direction,
      probability: extension.probability,
    }
  })
  const platforms = config.platforms.map((platform, index) => {
    const path = `platforms[${index}]`
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(platform.id)) throw new MissionGenerationError(`${path}.id`, '引擎平台编号须以英文字母开头，仅包含字母、数字、下划线或连字符；不会自动改写原编号。')
    let referenceModel: string
    let mover: string
    let orbital: readonly string[] | null = null
    let waypoints: GeneratedWaypoint[] = []
    if (platform.type === 'COMMUNICATION_SATELLITE') {
      const template = platform.satelliteType === undefined ? undefined : SATELLITE_MODELS[platform.satelliteType]
      if (template === undefined) throw new MissionGenerationError(`${path}.satelliteType`, '通信卫星必须选择天通或神通，才能确定候选模型与轨道模板。')
      // 卫星位置由轨道决定，写航点或坐标都会与轨道冲突。
      if (platform.waypoints.length > 0) throw new MissionGenerationError(`${path}.waypoints`, '卫星位置由轨道决定，不生成航点路线。')
      referenceModel = template.reference
      mover = 'WSF_SPACE_MOVER'
      orbital = template.orbital
    } else {
      if (!(platform.type in MODELS)) throw new MissionGenerationError(`${path}.type`, '当前生成器尚未接通该场景实体类型的候选引擎模型。')
      const mapped = MODELS[platform.type as keyof typeof MODELS]
      referenceModel = mapped.reference
      mover = mapped.mover
      waypoints = platform.waypoints.map((waypoint, waypointIndex) => {
        const waypointPath = `${path}.waypoints[${waypointIndex}]`
        // 速度为 0 的路线无法推进，会在引擎里静默停在起点，因此显式拒绝而不是原样写出。
        if (!(waypoint.speed > 0)) throw new MissionGenerationError(`${waypointPath}.speed`, '航点速度必须大于 0 m/s，否则路线无法推进。')
        for (const [field, value] of [['longitude', waypoint.longitude], ['latitude', waypoint.latitude],
          ['altitude', waypoint.altitude]] as const) {
          if (!Number.isFinite(value)) throw new MissionGenerationError(`${waypointPath}.${field}`, '航点坐标必须是有限数值。')
        }
        return { longitude: waypoint.longitude, latitude: waypoint.latitude, altitude: waypoint.altitude,
          speed: waypoint.speed, arrivalTimeS: waypoint.arrivalTime, arrivalTimeEnforced: false }
      })
    }
    return { platformId: platform.id, name: platform.name, frontendType: platform.type,
      satelliteType: platform.satelliteType ?? null,
      orbitalTemplate: orbital === null ? null : 'CANDIDATE_MODEL',
      // 中继角色只作记录：本轮不生成中继转发行为。
      relayRole: RELAY_PLATFORM_TYPES.has(platform.type),
      orbital, referenceModel, generatedType: `GEN_${referenceModel}_${token(platform.id)}`, mover, waypoints }
  })
  const jammers: GeneratedJammer[] = config.jammers.map((jammer, index) => {
    const extensionIndex = draft.uiExtensions.jammers.findIndex(extension => extension.jammerId === jammer.id)
    const extension: JammerExtension | undefined = extensionIndex >= 0 ? draft.uiExtensions.jammers[extensionIndex] : undefined
    if (extension === undefined) {
      throw new MissionGenerationError(`uiExtensions.jammers[${index}]`, '干扰设备缺少对应的界面扩展配置。')
    }
    const mode = JAMMER_MODES[jammer.type]
    if (jammer.defaultPower <= 0) {
      throw new MissionGenerationError(`jammers[${index}].defaultPower`, 'AFSIM 干扰 weapon 的发射功率必须大于 0 W。')
    }
    const globalEnabled = config.jammingEnabled ?? false
    const configuredEnabled = globalEnabled && extension.enabled
    const triggerTimeS = jammer.triggerTimeS ?? null
    const durationS = extension.duration
    // 已确认选择 A：autoDetect 时按 detectionRange 对全部平台做距离判断；与定时触发并存时优先自动探测。
    const activation: JammerActivation = !configuredEnabled ? 'DISABLED'
      : jammer.autoDetect ? 'AUTO_DETECT_RANGE'
        : triggerTimeS === null ? 'TRIGGER_NOT_CONFIGURED' : 'SCHEDULED'
    const startTimeS = activation === 'SCHEDULED' ? Math.max(triggerTimeS!, EARLIEST_TRIGGER_S) : null
    // 定时启停的关闭时刻；自动探测的关闭由探测到目标后按持续时间调度，不在此预计算绝对时刻。
    const stopCandidate = startTimeS === null || !(durationS > 0) ? null : startTimeS + durationS
    const stopTimeS = stopCandidate !== null && stopCandidate <= config.scenario.duration ? stopCandidate : null
    if (activation === 'AUTO_DETECT_RANGE' && !(jammer.detectionRange > 0)) {
      throw new MissionGenerationError(`jammers[${index}].detectionRange`, '自动探测的探测范围必须大于 0 m。')
    }
    if (!(jammer.jammingRange > 0)) {
      throw new MissionGenerationError(`jammers[${index}].jammingRange`, '干扰范围必须大于 0 m。')
    }
    return {
      jammerId: jammer.id,
      platformId: jammer.platformId,
      weaponId: jammerWeaponId(jammer.platformId, jammer.id),
      processorId: jammerProcessorId(jammer.platformId, jammer.id),
      type: jammer.type,
      model: 'WSF_RF_JAMMER',
      mode,
      frequencyMHz: jammer.frequency,
      frequencyHz: toHertz(jammer.frequency, `jammers[${index}].frequency`),
      bandwidthMHz: jammer.bandwidth,
      bandwidthHz: toHertz(jammer.bandwidth, `jammers[${index}].bandwidth`),
      powerW: jammer.defaultPower,
      globalEnabled,
      extensionEnabled: extension.enabled,
      configuredEnabled,
      autoDetect: jammer.autoDetect,
      detectionRangeM: jammer.detectionRange,
      jammingRangeM: jammer.jammingRange,
      releaseRangeM: readJammerReleaseRange(jammer),
      triggerTimeS,
      directionDeg: extension.direction,
      durationS,
      startsOn: activation === 'SCHEDULED' || activation === 'AUTO_DETECT_RANGE',
      startTimeS,
      stopTimeS,
      activation,
    }
  })
  const satellitePlatformIds = new Set(config.platforms
    .filter(platform => platform.type === 'COMMUNICATION_SATELLITE')
    .map(platform => platform.id))
  const relayUavPlatformIds = new Set(config.platforms
    .filter(platform => RELAY_PLATFORM_TYPES.has(platform.type))
    .map(platform => platform.id))
  const devices = links.map(link => {
    const path = `links[${config.links.indexOf(link)}]`
    if (!(SUPPORTED_LINK_TYPES as readonly string[]).includes(link.type)) {
      throw new MissionGenerationError(`${path}.type`,
        link.type === 'LASER'
          ? '激光链路尚无已核实的通信设备模型（候选仅有 LASER_COMM_ANTENNA 天线图形），不自动转换为微波或光纤。'
          : '本批仅支持微波、数传、卫星与光纤设备。')
    }
    const relayId = link.relayPlatformId ?? null
    const relayIsSatellite = relayId !== null && satellitePlatformIds.has(relayId)
    const relayIsUav = relayId !== null && relayUavPlatformIds.has(relayId)
    const endpointHasSatellite = satellitePlatformIds.has(link.sourcePlatformId)
      || satellitePlatformIds.has(link.targetPlatformId)
    // 单跳转发：relayPlatformId 可为通信卫星（源→星→目标）或高空中继 UAV（源→中继→目标）。
    if (relayId !== null) {
      if (!relayIsSatellite && !relayIsUav) {
        throw new MissionGenerationError(`${path}.relayPlatformId`,
          '中继转发仅支持通信卫星或高空中继节点（FORWARD_RELAY_NODE），不自动指定其他平台为转发器。')
      }
      if (relayId === link.sourcePlatformId || relayId === link.targetPlatformId) {
        throw new MissionGenerationError(`${path}.relayPlatformId`, '中继节点不能与链路源或目标是同一实体。')
      }
      // 卫星中继仅用于 SAT；UAV 中继用于微波/数传（及显式带中继的非星链路）。
      if (relayIsSatellite && link.type !== 'SAT') {
        throw new MissionGenerationError(`${path}.relayPlatformId`, '通信卫星中继仅适用于卫星链路类型。')
      }
      if (relayIsUav && link.type === 'SAT') {
        throw new MissionGenerationError(`${path}.relayPlatformId`, '高空中继节点不作为卫星链路的中继星；请使用微波或数传链路经 UAV 转发。')
      }
      if (relayIsUav && link.type === 'FIBER') {
        throw new MissionGenerationError(`${path}.relayPlatformId`, '光纤为点对点有线链路，不经高空中继转发。')
      }
    }
    if (link.type === 'SAT' && !endpointHasSatellite && !relayIsSatellite) {
      throw new MissionGenerationError(`${path}.type`,
        '卫星链路须有一端是通信卫星，或通过 relayPlatformId 指定中继卫星；不自动补卫星或改走微波。')
    }
    for (const field of ['antennaGainCorrectionDb', 'antiJammingGainDb', 'spatialIsolationDb'] as const) {
      if ((link[field] ?? 0) !== 0) {
        // 无已确认引擎参数；写入 mapping 注解由调用方在 manifest 中查看，生成仍阻断以免静默丢弃。
        throw new MissionGenerationError(`${path}.${field}`, '该修正参数尚无已确认的引擎映射。')
      }
    }
    if (link.coding != null) throw new MissionGenerationError(`${path}.coding`, '信道编码尚无已确认的引擎映射。')
    const datalink = link.type === 'DATALINK'
    const fiber = link.type === 'FIBER'
    const singleHopRelay = relayIsSatellite || relayIsUav
    const network = `net_${token(link.id)}`
    const hop1 = singleHopRelay ? `net_${token(link.id)}_hop1` : network
    const hop2 = singleHopRelay ? `net_${token(link.id)}_hop2` : null
    return {
      linkId: link.id, linkType: link.type, network, hop1Network: hop1, hop2Network: hop2,
      direction: link.direction,
      band: datalink ? link.band ?? DATALINK_BAND : null,
      role: datalink ? (link.direction === 'FORWARD' ? 'UPLINK' : 'DOWNLINK') : null,
      bitErrorProbability: datalink ? DATALINK_BIT_ERROR_PROBABILITY : null,
      commModel: fiber ? FIBER_COMM_MODEL : 'WSF_RADIO_TRANSCEIVER',
      networkModel: fiber ? FIBER_NETWORK_MODEL : null,
      relayPlatformId: singleHopRelay ? relayId : null,
      modulation: link.modulation,
      berThreshold: link.berThreshold,
      // 调制与 BER 阈值写入 mapping 供对照；候选脚本无已确认单一等价项，不写入引擎指令。
      modulationEngineMapped: false,
      berThresholdEngineMapped: false,
      relayKind: relayIsSatellite ? 'SATELLITE' : relayIsUav ? 'FORWARD_RELAY_UAV' : null,
      frequencyMHz: link.frequency,
      bandwidthMHz: link.bandwidth,
      txPowerW: link.txPower,
      antennaGainDb: link.antennaGain,
      // 卫星、微波速率按文档固定（天通 16 kbit/s），其余链路使用配置值。
      dataRateMbps: fixedLinkDataRate(link, config.platforms) ?? link.dataRate,
      source: { platformId: link.sourcePlatformId, deviceId: `comm_${token(link.id)}_src` },
      relay: singleHopRelay ? {
        platformId: relayId!,
        ingressDeviceId: `comm_${token(link.id)}_relay_in`,
        egressDeviceId: `comm_${token(link.id)}_relay_out`,
        processorId: `relay_proc_${token(link.id)}`,
      } : null,
      target: { platformId: link.targetPlatformId, deviceId: `comm_${token(link.id)}_dst` },
    }
  })
  // 已确认 D-05：阶段切换规则来自场景配置；结构已由共享校验保证，这里只核对目标链路与干扰设备是否参与本次生成。
  const switchRules = (settings.switchRules ?? []).flatMap((rule, index) => {
    if (rule.enabled === false) return []
    const path = `linkSettings.switchRules[${index}]`
    const device = devices.find(item => item.linkId === rule.toLinkId)
    if (device === undefined) {
      throw new MissionGenerationError(`${path}.toLinkId`, '切换目标链路已停用或未参与本次场景，请启用该链路或停用此规则。')
    }
    const jamming = rule.trigger === 'JAMMING_ACTIVE' || rule.trigger === 'JAMMING_STOPPED'
    const jammer = jamming ? jammers.find(item => item.jammerId === rule.jammerId) : undefined
    if (jamming && jammer === undefined) throw new MissionGenerationError(`${path}.jammerId`, '干扰条件引用的干扰设备不存在。')
    return [{ ruleId: rule.id, trigger: rule.trigger, sourcePlatformId: rule.sourcePlatformId, targetPlatformId: rule.targetPlatformId,
      toLinkId: rule.toLinkId, distanceThresholdM: rule.distanceThresholdM ?? null,
      jammer: jammer === undefined ? null : { jammerId: jammer.jammerId, platformId: jammer.platformId, weaponId: jammer.weaponId },
      device }]
  })
  let sendRequests = 0
  const businesses = config.informationDemand.flatMap((demand, index) => {
    if (demand.enabled === false || demand.frequencyHz === 0 || (demand.linkId && excluded.has(demand.linkId))) return []
    const path = `informationDemand[${index}]`
    for (const field of ['id', 'informationType'] as const) {
      if (!String(demand[field] ?? '').trim() || /[\u0000-\u001f\u007f"\\]/.test(String(demand[field]))) {
        throw new MissionGenerationError(`${path}.${field}`, 'AFSIM 字符串不支持双引号、反斜杠或控制字符，无法无损生成。')
      }
    }
    // 已确认选择：中文业务类型限定四枚举；自由文本（含视频）阻断生成，不静默改写。
    if (!(INFORMATION_TYPE_ENUM as readonly string[]).includes(demand.informationType)) {
      throw new MissionGenerationError(`${path}.informationType`,
        `业务类型须为 ${INFORMATION_TYPE_ENUM.join(' / ')} 之一，不接受自由文本或视频帧语义。`)
    }
    const sizeBits = Math.round(demand.volumeMb * 8_000_000)
    if (!Number.isSafeInteger(sizeBits) || sizeBits > 2_147_483_647) {
      throw new MissionGenerationError(`${path}.volumeMb`, '单报文转换后不能超过 mission 的 2147483647 bit 上限；当前不自动分包。')
    }
    const linkPriority = settings.priority
    const routes = demand.destinationPlatformIds.map((target, targetIndex) => {
      const candidates = devices.filter(device => device.source.platformId === demand.sourcePlatformId
        && device.target.platformId === target && (demand.linkId === undefined || device.linkId === demand.linkId)
        && (demand.direction === undefined || demand.direction === device.direction))
      if (candidates.length === 0) {
        throw new MissionGenerationError(`${path}.destinationPlatformIds[${targetIndex}]`,
          '没有匹配端点和方向的已启用链路，不自动补线或转发。')
      }
      // 自动选路：按 linkSettings.priority 排序；显式 linkId 时候选已唯一。
      const ordered = [...candidates].sort((left, right) => {
        const leftRank = linkPriority.indexOf(left.linkType as typeof linkPriority[number])
        const rightRank = linkPriority.indexOf(right.linkType as typeof linkPriority[number])
        const leftOrder = leftRank < 0 ? linkPriority.length : leftRank
        const rightOrder = rightRank < 0 ? linkPriority.length : rightRank
        return leftOrder - rightOrder || left.linkId.localeCompare(right.linkId)
      })
      const primary = ordered[0]!
      // 旧业务未指定方向时按实际主路由兜底：类型方向不符即阻断，不改类型、方向或选路。
      const expected = INFORMATION_TYPE_DIRECTIONS[demand.informationType as InformationTypeEnum]
      if (primary.direction !== expected) {
        throw new MissionGenerationError(`${path}.destinationPlatformIds[${targetIndex}]`,
          `${demand.informationType}须使用${expected === 'FORWARD' ? '前向' : '返向'}链路，实际主路由 ${primary.linkId} 为${primary.direction === 'FORWARD' ? '前向' : '返向'}。`)
      }
      // 规则只作用于同方向业务：前向业务不得切到返向链路，反之亦然。
      const rules = switchRules.filter(rule => rule.sourcePlatformId === demand.sourcePlatformId && rule.targetPlatformId === target
        && rule.device.direction === primary.direction)
      return { targetPlatformId: target, ordered, primary, rules }
    })
    // 本机执行预算，不是业务速率约束；防止合法有限数值组合生成无界发送任务。
    sendRequests += Math.ceil(config.scenario.duration * demand.frequencyHz) * routes.length
    if (!Number.isFinite(sendRequests) || sendRequests > 1_000_000) {
      throw new MissionGenerationError(`${path}.frequencyHz`, '本次执行的预计发送请求超过 100 万次，请降低频次或缩短场景时长。')
    }
    return [{ demandId: demand.id, sourcePlatformId: demand.sourcePlatformId, messageType: demand.informationType,
      candidateMessageType: INFORMATION_TYPE_CANDIDATE[demand.informationType as InformationTypeEnum],
      sizeBits, frequencyHz: demand.frequencyHz,
      routes: routes.map(item => item.primary),
      switchPlans: routes.map(item => item.rules),
      routePlans: routes.map(item => ({
        targetPlatformId: item.targetPlatformId,
        orderedLinkIds: item.ordered.map(device => device.linkId),
        orderedLinkTypes: item.ordered.map(device => device.linkType),
        switchRuleIds: item.rules.map(rule => rule.ruleId),
      })),
      failoverEnabled: routes.some(item => item.rules.length > 0),
      processorId: `business_${token(demand.id)}`,
      switchProcessorId: null,
      constraints: { priority: demand.priority, maxLatencyMs: demand.maxLatencyMs, minDataRateMbps: demand.minDataRateMbps, engineEnforced: false } }]
  })
  // 输出路径提前计算，供平台处理器写入专用 CSV。
  const outputDirectoryEarly = resolveOutputDirectory(config.output.directory)
  const linkQualityEnabled = config.output.linkQualityEnabled === true
  if (linkQualityEnabled) throw new MissionGenerationError('output.linkQualityEnabled', '当前引擎尚无完整的真实质量测量来源，请关闭质量输出；不会使用配置 BER 或固定 UP 生成规范 CSV。')
  const linkSwitchEnabled = config.output.linkSwitchEnabled === true
  if (linkSwitchEnabled) throw new MissionGenerationError('output.linkSwitchEnabled', '当前引擎尚无切换前后真实 BER 测量，请关闭切换输出；不会以空值或配置值生成规范 CSV。')
  const antennas: string[] = []
  // 平台类型按参考模型写入对接示例的同名文件；definitions 指向当前平台所属文件。
  const typeFiles = new Map<string, string[]>(PLATFORM_TYPE_FILES.map(name => [name, []]))
  let definitions: string[] = []
  let linkCalcSlot: { bucket: string[]; index: number } | null = null
  const networkDeclarations: string[] = []
  const declaredNetworks = new Set<string>()
  /** 声明候选网络类型；光纤用 P2P，其余直连仍只写 network_name（与既有微波/数传一致）。 */
  function ensureNetwork(name: string, model: string | null): void {
    if (declaredNetworks.has(name) || model === null) return
    declaredNetworks.add(name)
    networkDeclarations.push(`network ${name} ${model}`, 'end_network')
  }
  /** link_calc 的 port_params 由实际生成的设备参数汇总，保证与设备定义一致（已确认 C-01）。 */
  const portParams = new Map<string, Array<Record<string, unknown>>>()
  const mediums: string[] = []
  /**
   * 为端点生成独立通信设备；收发机固定值取自对接示例（极化、衰减模型、噪声系数、介质与信道数）。
   * 光纤无射频收发参数，只写有线收发器与速率。
   */
  function pushCommDevice(
    deviceId: string,
    networkName: string,
    link: (typeof links)[number],
    mapping: (typeof devices)[number],
    platform: (typeof platforms)[number],
    receiverProcessorId?: string,
  ): void {
    const receiver = receiverProcessorId ? [`    internal_link ${receiverProcessorId}`] : []
    const dataRate = mapping.dataRateMbps
    const frequencyParam = (valueMHz: number) => valueMHz < 1000 ? { frequency_mhz: valueMHz } : { frequency_ghz: Number((valueMHz / 1000).toPrecision(12)) }
    const params = portParams.get(platform.generatedType) ?? []
    portParams.set(platform.generatedType, params)
    if (mapping.commModel === FIBER_COMM_MODEL) {
      ensureNetwork(networkName, FIBER_NETWORK_MODEL)
      definitions.push(`  comm ${deviceId} ${FIBER_COMM_MODEL}`, '    on', `    network_name ${networkName}`,
        `    transfer_rate ${dataRate} mbits/sec`, `    channels ${COMM_CHANNELS}`, ...receiver, '  end_comm')
      // 文档：光纤端口只有传输速率与发送频率（默认 1.3 GHz），有线收发器本身不写射频参数。
      params.push({ comm_name: deviceId, transmitter: { ...frequencyParam(link.frequency), 'information_rate_mbits/sec': dataRate } })
      return
    }
    // 文档：仅指挥车 C 波段使用定向天线（俯仰 88°）；任务机 C 波段为全向 180°。
    const directionalCBand = mapping.linkType === 'DATALINK' && mapping.band === 'C' && platform.referenceModel === 'COMMAND_VEHICLE_PLATFORM'
    const elevationBeamwidth = directionalCBand ? DATALINK_C_ELEVATION_BEAMWIDTH_DEG : 180
    const tilt = directionalCBand ? [`      antenna_tilt ${DATALINK_C_ANTENNA_TILT_DEG} deg`] : []
    // 收发极化可配置；缺省时微波水平极化、其余垂直极化。卫星链路不启用 ITU 大气衰减。
    const txPolarization = link.txPolarization ?? defaultPolarization(link.type)
    const rxPolarization = link.rxPolarization ?? defaultPolarization(link.type)
    const rxFrequency = link.rxFrequency ?? link.frequency
    const rxBandwidth = link.rxBandwidth ?? link.bandwidth
    const attenuation = mapping.linkType === 'SAT' ? 'none' : 'itu'
    const noiseFigure = link.noiseFigureDb ?? (platform.satelliteType === 'TIANTONG' ? TIANTONG_NOISE_FIGURE_DB : RECEIVER_NOISE_FIGURE_DB)
    for (const side of ['tx', 'rx'] as const) {
      antennas.push(`antenna_pattern ${deviceId}_${side}`, '  uniform_pattern',
        `    peak_gain ${link.antennaGain[side]} dB`, '    azimuth_beamwidth 360 deg',
        `    elevation_beamwidth ${elevationBeamwidth} deg`, '  end_uniform_pattern', 'end_antenna_pattern')
    }
    // 示例在 comm 内改写共享介质 UAV_MESH_MEDIUM，引擎会告警“Medium is shared”，且最后一次改写覆盖全部设备的速率。
    // 因此每台设备独立定义介质类型（参数同示例），再在 comm 中引用，速率互不覆盖。
    const medium = `medium_${deviceId}`
    mediums.push(`medium ${medium} WSF_COMM_MEDIUM_UNGUIDED`, `    channels ${COMM_CHANNELS}`,
      '    default_mode_name "default"', '    mode "default"', '      propagation_speed constant 299792458 m/sec',
      `      transfer_rate constant ${dataRate} mbits/sec`,
      `      bit_error_probability ${BIT_ERROR_PROBABILITY}`,
      '      packet_loss_time constant 0 sec', '    end_mode', 'end_medium')
    definitions.push(`  comm ${deviceId} ${mapping.commModel}`, '    on', `    network_name ${networkName}`,
      `    add medium ${medium}`, '    end_medium',
      '    transmitter',
      `      frequency ${link.frequency} MHz`, `      bandwidth ${link.bandwidth} MHz`,
      `      power ${link.txPower} W`, `      polarization ${txPolarization}`,
      `      antenna_pattern ${deviceId}_tx`, ...tilt,
      `      attenuation_model ${attenuation}`, '      end_attenuation_model', '    end_transmitter',
      '    receiver', `      frequency ${rxFrequency} MHz`, `      bandwidth ${rxBandwidth} MHz`,
      `      polarization ${rxPolarization}`, `      antenna_pattern ${deviceId}_rx`, ...tilt,
      `      noise_figure ${noiseFigure} dB`, '    end_receiver',
      ...receiver, '  end_comm')
    params.push({ comm_name: deviceId,
      transmitter: { ...frequencyParam(link.frequency), bandwidth_mhz: link.bandwidth, power_w: link.txPower, peak_gain_dB: link.antennaGain.tx,
        polarization: txPolarization, 'information_rate_mbits/sec': dataRate },
      receiver: { ...frequencyParam(rxFrequency), bandwidth_mhz: rxBandwidth, peak_gain_dB: link.antennaGain.rx,
        polarization: rxPolarization, 'information_rate_mbits/sec': dataRate, noise_figure_dB: noiseFigure } })
  }
  if (jammers.length > 0) {
    // 候选干扰模型明确使用全向天线；不把通信链路天线增益借用到干扰设备。
    antennas.push('antenna_pattern JAMMER_OMNI_ANTENNA', '  uniform_pattern',
      '    peak_gain 0 dB', '    azimuth_beamwidth 360 deg', '    elevation_beamwidth 180 deg',
      '  end_uniform_pattern', 'end_antenna_pattern')
  }
  // timeStep 映射为运动器 update_interval；输出采样仍用 writeInterval。无已核实的独立 time_step 指令。
  const moverUpdateInterval = config.scenario.timeStep > 0 ? config.scenario.timeStep : config.output.writeInterval
  const otherPlatformIds = platforms.map(item => item.platformId)
  const linkCalcHost = platforms.find(item => item.referenceModel === 'REAR_COMM_PLATFORM') ?? null
  for (const platform of platforms) {
    const profile = REFERENCE_PROFILES[platform.referenceModel]!
    definitions = typeFiles.get(profile.file)!
    definitions.push(`platform_type ${platform.generatedType} WSF_PLATFORM`,
      `  radar_signature ${profile.signature}`,
      `  mover ${platform.mover}`, `    update_interval ${moverUpdateInterval} sec`)
    if (platform.orbital !== null) {
      // 轨道要素取自候选模型，历元取配置的仿真开始时刻，使轨道与 start_date 使用同一日期口径。
      definitions.push('    oblate_earth true', '    orbital_state',
        `      epoch_date_time ${startDateTime.date} ${startDateTime.time.slice(0, 8)}`,
        ...platform.orbital, '    end_orbital_state')
    }
    definitions.push('  end_mover')
    // 已确认 B-05：数传上行接前向时延、下行接返向时延，时延处理器再交给 script_proc；其余链路直连 script_proc。
    const receiverFor = (mapping: (typeof devices)[number]) =>
      mapping.role === 'UPLINK' ? 'forward_delay' : mapping.role === 'DOWNLINK' ? 'return_delay' : 'script_proc'
    let endpointCount = 0
    let datalinkEndpoint = false
    devices.forEach((mapping, index) => {
      const link = links[index]!
      for (const [endpoint, network] of [[mapping.source, mapping.hop1Network],
        [mapping.target, mapping.hop2Network ?? mapping.hop1Network]] as const) {
        if (endpoint.platformId !== platform.platformId) continue
        endpointCount += 1
        datalinkEndpoint ||= mapping.role !== null
        pushCommDevice(endpoint.deviceId, network, link, mapping, platform, receiverFor(mapping))
      }
      if (mapping.relay && mapping.relay.platformId === platform.platformId) {
        // 中继入口各链路独立时延处理器，避免多条中继链路共用后把消息转发到彼此的出口。
        const relayDelay = mapping.role === null ? null
          : `${mapping.role === 'UPLINK' ? 'forward' : 'return'}_delay_${token(mapping.linkId)}`
        pushCommDevice(mapping.relay.ingressDeviceId, mapping.hop1Network, link, mapping, platform,
          relayDelay ?? mapping.relay.processorId)
        pushCommDevice(mapping.relay.egressDeviceId, mapping.hop2Network!, link, mapping, platform)
        if (relayDelay !== null) {
          definitions.push(`  processor ${relayDelay} WSF_DELAY_PROCESSOR`, ...DELAY_TEMPLATE,
            `    internal_link ${mapping.relay.processorId}`, '  end_processor')
        }
        // 固定单跳：中继（卫星或高空 UAV）收到源消息后经第二跳发往目标；不复制候选硬编码平台名。
        // default 是兜底处理指令；type default 只匹配名为 default 的消息。
        definitions.push(`  processor ${mapping.relay.processorId} WSF_SCRIPT_PROCESSOR`,
          '    on_message', '      default', '        script',
          `          PLATFORM.Comm("${mapping.relay.egressDeviceId}").SendMessage(MESSAGE, "${mapping.target.platformId}", "${mapping.target.deviceId}");`,
          '        end_script', '    end_on_message', '  end_processor')
      }
    })
    if (datalinkEndpoint) {
      for (const name of ['forward_delay', 'return_delay']) {
        definitions.push(`  processor ${name} WSF_DELAY_PROCESSOR`, ...DELAY_TEMPLATE, '    internal_link script_proc', '  end_processor')
      }
    }
    if (endpointCount > 0) {
      // 端点接收日志，与示例 script_proc 的 default 分支一致；不复制示例中的阶段剧情。
      definitions.push('  processor script_proc WSF_SCRIPT_PROCESSOR', '    on_message', '      default', '        script',
        '          writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());',
        '        end_script', '    end_on_message', '  end_processor')
    }
    // port_params 需要全部平台的设备参数，先记录插入位置，循环结束后再写入。
    if (platform === linkCalcHost) linkCalcSlot = { bucket: definitions, index: definitions.length }
    for (const sensor of sensors.filter(item => item.platformId === platform.platformId)) {
      // 波束视场、帧周期、发射功率、噪声系数与最小距离沿用候选模型给定值，配置里没有对应输入项。
      // ESM/direction/probability 仅留在 mapping.json：引擎无概率输入指令，缺虚警率假设。
      definitions.push(`  sensor ${sensor.deviceId} ${sensor.model}`,
        '    mode default', `      frame_time ${SENSOR_TEMPLATE.frameTimeSec} sec`, '      beam 1',
        `        azimuth_field_of_view ${SENSOR_TEMPLATE.azimuthFieldOfView}`,
        `        elevation_field_of_view ${SENSOR_TEMPLATE.elevationFieldOfView}`,
        `        minimum_range ${SENSOR_TEMPLATE.minimumRangeKm} km`,
        `        maximum_range ${sensor.detectionRangeM} m`,
        '        transmitter', `          frequency ${formatFrequencyGHz(sensor.frequencyMHz)} GHz`,
        `          power ${SENSOR_TEMPLATE.transmitterPowerW} W`, '        end_transmitter',
        '        receiver', `          noise_figure ${SENSOR_TEMPLATE.noiseFigureDb} dB`,
        `          bandwidth ${sensor.bandwidthMHz} MHz`, '        end_receiver',
        '      end_beam', '      reports_location', '      reports_velocity', '      reports_bearing',
        '    end_mode',
        ...(sensor.enabled ? ['    on'] : []), '  end_sensor')
    }
    for (const jammer of jammers.filter(item => item.platformId === platform.platformId)) {
      // 不写 weapon 的常开 on：启停完全由带时刻的处理器驱动，避免设备在仿真起点就处于开启状态。
      definitions.push(`  weapon ${jammer.weaponId} ${jammer.model}`,
        '    mode_template', '      transmitter',
        `        frequency ${formatFrequencyGHz(jammer.frequencyMHz)} GHz`,
        `        bandwidth ${jammer.bandwidthMHz} MHz`,
        `        power ${jammer.powerW} W`,
        '        antenna_pattern JAMMER_OMNI_ANTENNA',
        '      end_transmitter', '    end_mode_template',
        '    mode broadband_jamming', '    end_mode',
        '    mode spot_jamming', '    end_mode',
        '    mode sweep_jamming', '    end_mode',
        '    mode default', '    end_mode', '  end_weapon')
      if (jammer.activation === 'AUTO_DETECT_RANGE') {
        const targets = otherPlatformIds.filter(id => id !== jammer.platformId)
        definitions.push(`  processor ${jammer.processorId} WSF_SCRIPT_PROCESSOR`,
          '    script_variables', '      bool jammingActivated = false;', '    end_script_variables',
          `    execute at_interval_of ${AUTO_DETECT_INTERVAL_S} sec`, '    {',
          '      if (jammingActivated) return;')
        for (const targetId of targets) {
          definitions.push(
            `      WsfPlatform target_${token(targetId)} = WsfSimulation.FindPlatform("${targetId}");`,
            `      if (target_${token(targetId)}.IsValid())`,
            '      {',
            `        double rangeM = PLATFORM.SlantRangeTo(target_${token(targetId)});`,
            // 先按探测范围发现目标，再仅在干扰范围内 TurnOn（候选 weapon 无 maximum_range）。
            `        if (rangeM <= ${jammer.detectionRangeM} && rangeM <= ${jammer.jammingRangeM})`,
            '        {',
            `          WsfWeapon jammer = PLATFORM.Weapon("${jammer.weaponId}");`,
            '          if (jammer.IsValid())', '          {',
            '            jammer.TurnOn();',
            `            jammer.SelectMode("${jammer.mode}");`,
            '            jammingActivated = true;',
            ...(jammer.durationS > 0 ? [
              `            double stopAt = TIME_NOW + ${jammer.durationS};`,
              `            if (stopAt < ${config.scenario.duration}) PROCESSOR.ExecuteScriptAtTime(stopAt, "StopAutoJammer");`,
            ] : []),
            '          }',
            '          return;',
            '        }',
            '      }')
        }
        definitions.push('    }', '    end_execute')
        if (jammer.durationS > 0) {
          definitions.push('    script void StopAutoJammer()', '    {',
            `      WsfWeapon jammer = PLATFORM.Weapon("${jammer.weaponId}");`,
            '      if (jammer.IsValid()) jammer.TurnOff();',
            '    }', '    end_script')
        }
        definitions.push('  end_processor')
      } else if (jammer.startTimeS !== null) {
        definitions.push(`  processor ${jammer.processorId} WSF_SCRIPT_PROCESSOR`,
          `    execute at_time ${jammer.startTimeS} sec absolute`, '    {',
          `      WsfWeapon jammer = PLATFORM.Weapon("${jammer.weaponId}");`,
          '      if (jammer.IsValid())', '      {',
          '        jammer.TurnOn();',
          `        jammer.SelectMode("${jammer.mode}");`,
          '      }', '    }', '    end_execute')
        if (jammer.stopTimeS !== null) {
          definitions.push(`    execute at_time ${jammer.stopTimeS} sec absolute`, '    {',
            `      WsfWeapon jammer = PLATFORM.Weapon("${jammer.weaponId}");`,
            '      if (jammer.IsValid())', '      {',
            '        jammer.TurnOff();',
            '      }', '    }', '    end_execute')
        }
        definitions.push('  end_processor')
      }
    }
    for (const business of businesses.filter(item => item.sourcePlatformId === platform.platformId)) {
      // 有切换规则的目标用脚本变量保存当前发送设备与目的地，其余目标仍固定发往主链路。
      const switched = business.switchPlans.flatMap((rules, routeIndex) => rules.length > 0 ? [routeIndex] : [])
      const routeVariables = switched.flatMap(routeIndex => {
        const send = sendTarget(business.routes[routeIndex]!)
        return [`      string routeComm_${routeIndex} = "${send.comm}";`, `      string routePlatform_${routeIndex} = "${send.platform}";`,
          `      string routeDevice_${routeIndex} = "${send.device}";`, `      double routeSwitchedAt_${routeIndex} = -1.0e9;`,
          ...business.switchPlans[routeIndex]!.flatMap((rule, ruleIndex) => rule.trigger === 'JAMMING_STOPPED'
            ? [`      bool jammerSeenOn_${routeIndex}_${ruleIndex} = false;`] : [])]
      })
      definitions.push(`  processor ${business.processorId} WSF_SCRIPT_PROCESSOR`,
        `    update_interval ${config.output.writeInterval} sec`,
        '    script_variables',
        '      double emissionIndex = 0;',
        ...routeVariables,
        '    end_script_variables',
        '    script void EmitBusiness()', '    {', `      if (TIME_NOW >= ${config.scenario.duration}) return;`)
      business.routes.forEach((route, routeIndex) => {
        const send = sendTarget(route)
        const call = switched.includes(routeIndex)
          ? `PLATFORM.Comm(routeComm_${routeIndex}).SendMessage(message, routePlatform_${routeIndex}, routeDevice_${routeIndex});`
          : `PLATFORM.Comm("${send.comm}").SendMessage(message, "${send.platform}", "${send.device}");`
        // 多目标各发送一次；无切换规则时只用优先级最高的主链路。
        definitions.push('      {')
        definitions.push(
          '        WsfMessage message = WsfMessage();',
          `        message.SetType(${formatAfsimString(business.messageType)});`,
          `        message.SetSubType(${formatAfsimString(business.demandId)});`,
          `        message.SetSizeInBits(${business.sizeBits});`,
          `        ${call}`,
        )
        definitions.push('      }')
      })
      definitions.push('      emissionIndex = emissionIndex + 1;',
        `      double nextTime = emissionIndex / ${business.frequencyHz.toExponential(17)};`,
        `      if (nextTime < ${config.scenario.duration} && nextTime > TIME_NOW) PROCESSOR.ExecuteScriptAtTime(nextTime, "EmitBusiness");`,
        '    }', '    end_script',
        '    script void QueueBusiness()', '    {', '      PROCESSOR.ExecuteScriptAtTime(TIME_NOW, "EmitBusiness");',
        '    }', '    end_script')
      if (switched.length > 0) {
        definitions.push(`    execute at_interval_of ${SWITCH_CHECK_INTERVAL_S} sec`, '    {')
        for (const routeIndex of switched) {
          definitions.push(...buildSwitchCheck(business.demandId, routeIndex, business.switchPlans[routeIndex]!, settings.switchCooldownS))
        }
        definitions.push('    }', '    end_execute')
      }

      definitions.push('    on_initialize2',
        '      PROCESSOR.ExecuteScriptAtTime(0, "QueueBusiness");', '    end_on_initialize2', '  end_processor')
    }

    definitions.push('end_platform_type')
  }
  const environment = config.scenario.environment
  // 已确认 D-04：云层参数来自场景配置；旧场景缺省时使用示例典型值。
  const cloud = {
    minM: environment.cloudAltitudeMinM ?? LINK_CALC_TEMPLATE.cloud.minM,
    maxM: environment.cloudAltitudeMaxM ?? LINK_CALC_TEMPLATE.cloud.maxM,
    waterDensityGM3: environment.cloudWaterDensityGM3 ?? LINK_CALC_TEMPLATE.cloud.waterDensityGM3,
  }
  /**
   * 解析热链配置（全局）：未自定义时按已启用链路自动串联；自定义热链引用停用或未参与本次场景的链路时阻断，
   * 不静默丢弃整条热链。结构与首尾相接已由共享校验保证。
   */
  function resolveHotLinks() {
    const hot = readHotLinks(settings.hotLinks, links, settings.priority)
    const toDevices = (key: 'forward' | 'reverse') => hot[key].map((chain, index) => chain.map(linkId => {
      const device = devices.find(item => item.linkId === linkId)
      if (device === undefined) throw new MissionGenerationError(`linkSettings.hotLinks.${key}[${index}]`, `热链包含已停用或未参与本次场景的链路 ${linkId}，请启用该链路或调整热链。`)
      return device
    }))
    return { forward: toDevices('forward'), reverse: toDevices('reverse'), endReferenceModel: HOT_LINK_END_REFERENCE_MODELS[hot.endPlatformType] }
  }
  if (linkCalcSlot !== null) {
    linkCalcSlot.bucket.splice(linkCalcSlot.index, 0, ...buildLinkCalcProcessor({
      relayUavNames: platforms.filter(item => item.relayRole).map(item => item.platformId),
      hotLinks: resolveHotLinks(), portParams, environment: readNaturalEnvironment(environment), cloud,
      // 海面多径衰落开关决定是否计入海况；地图框选的区域写入 sea_polygon，未框选时不写坐标（空列表）。
      seaPolygon: environment.seaPolygon?.map(point => ({ lat: point.latitude, lon: point.longitude })) ?? [],
      linkCalc: readLinkCalcSettings(settings.linkCalc),
      trafficType: buildTrafficType(businesses),
      jammerParam: { jammers: jammers.map(jammer => ({
        platform_name: jammer.platformId, weapon_name: jammer.weaponId,
        jammer_type: config.platforms.find(item => item.id === jammer.platformId)?.type === 'AIRBORNE_JAMMER_PLATFORM' ? 'airborne' : 'ground',
        enabled: jammer.configuredEnabled, mode: JAMMER_PARAM_MODES[jammer.type],
        frequency_hz: jammer.frequencyHz, bandwidth_hz: jammer.bandwidthHz, power_w: jammer.powerW,
        antenna_gain_dbi: JAMMER_PARAM_FIXED.antenna_gain_dbi, tx_loss_db: JAMMER_PARAM_FIXED.tx_loss_db,
        trigger_radius_nm: Number((jammer.jammingRangeM / METERS_PER_NAUTICAL_MILE).toFixed(3)),
        release_radius_nm: Number((jammer.releaseRangeM / METERS_PER_NAUTICAL_MILE).toFixed(3)),
        spot_bandwidth_mhz: JAMMER_PARAM_FIXED.spot_bandwidth_mhz, sweep_duty_cycle: JAMMER_PARAM_FIXED.sweep_duty_cycle,
      })) },
    }))
  }

  const instances = config.platforms.flatMap((platform, index) => {
    const generated = platforms[index]!
    const profile = REFERENCE_PROFILES[generated.referenceModel]!
    const position = platform.initialPosition
    // 阵营、图标、朝向与创建时刻按示例实例写死（已确认 D-03）。
    const header = [`platform ${platform.id} ${generated.generatedType}`, `  side ${profile.side}`,
      ...(profile.icon === null ? [] : [`  icon ${profile.icon}`]),
      ...(profile.createdAtStart ? ['  creation_time 0 sec'] : [])]
    // 卫星位置由轨道决定；写 position 会与轨道冲突，也会让配置坐标看起来生效。
    const lines = generated.orbital === null
      ? [...header,
        `  position ${formatPosition(position.latitude, position.longitude)}`,
        `  altitude ${position.altitude} m`,
        ...(profile.heading ? ['  heading 90 deg'] : [])]
      : header
    const waypoints = generated.waypoints
    if (waypoints.length > 0) {
      // 路线首点固定为配置的初始位置：运动器会把起点设成路线首点，不写就会丢掉配置的初始位置。
      lines.push('  route',
        `    position ${formatPosition(position.latitude, position.longitude)} altitude ${position.altitude} m speed ${waypoints[0]!.speed} m/s`)
      waypoints.forEach((waypoint, waypointIndex) => {
        // 每个航点的 speed 作用于抵达该航点的那一段；末点速度不参与推进。
        const legSpeed = waypoints[Math.min(waypointIndex + 1, waypoints.length - 1)]!.speed
        lines.push(`    position ${formatPosition(waypoint.latitude, waypoint.longitude)} altitude ${waypoint.altitude} m speed ${legSpeed} m/s`)
      })
      lines.push('  end_route')
    }
    lines.push('end_platform')
    return lines
  })
  const clockRate = environment.simClockSpeed
  const clockRateEmitted = typeof clockRate === 'number' && Number.isFinite(clockRate) && clockRate > 0
  const environmentEmitted = Number.isFinite(environment.seaState) && environment.seaState >= 0
    && Number.isFinite(environment.rainRateMmPerHour) && environment.rainRateMmPerHour >= 0
  // 输出路径：复用平台生成前已解析的目录；事件/位置/质量/切换 CSV 均落在同一目录。
  const outputDirectory = outputDirectoryEarly
  const eventsCsvPath = joinOutputPath(outputDirectory, 'scenario_events.csv')
  const positionCsvPath = joinOutputPath(outputDirectory, 'position.csv')
  const aerPath = joinOutputPath(outputDirectory, 'scenario_events.aer')
  const linkSettings = settings
  // comm_PerDefinition.txt：环境、全局变量、天线、RCS、网络与介质，结构同对接示例。
  const perDefinition = [
    ...(environmentEmitted ? ['global_environment',
      `  rain_rate ${environment.rainRateMmPerHour} mm/hr`,
      `  rain_altitude_limit ${readNaturalEnvironment(environment).rainAltitudeLimitM} m`,
      `  cloud_altitude_limits ${cloud.minM} m ${cloud.maxM} m`,
      `  cloud_water_density ${cloud.waterDensityGM3} g/m3`,
      `  sea_state ${environment.seaState}`, 'end_global_environment', ''] : []),
    ...GLOBAL_SCRIPT_VARIABLES, '',
    ...FIXED_ANTENNA_PATTERNS, ...antennas, '',
    ...FIXED_RADAR_SIGNATURES, '',
    ...networkDeclarations, ...(networkDeclarations.length > 0 ? [''] : []),
    ...COMM_MEDIUM_DEFINITION, ...(mediums.length > 0 ? ['', ...mediums] : []),
  ]
  const setup = ['// ' + NOTICE,
    ...[...PLATFORM_TYPE_FILES, INSTANCE_FILE, 'observers.txt'].map(name => `include_once ${name}`), '',
    `start_date ${startDateTime.date}`,
    `start_time ${startDateTime.time}`,
    `end_time ${config.scenario.duration} sec`,
    ...(clockRateEmitted ? [`clock_rate ${clockRate}`] : []),
    'multi_thread', '',
    `simulation_name "${SIMULATION_NAME}"`, '',
    'event_pipe', `   file ${aerPath}`, 'end_event_pipe']
  if (config.output.eventsEnabled) {
    // 事件开关取对接示例的完整清单（去重）；起止事件自带年月日时分秒，是结果与开始时刻绑定的证据。
    setup.push('', 'csv_event_output', `  file ${eventsCsvPath}`,
      ...CSV_EVENTS.map(event => `  enable ${event}`), 'end_csv_event_output')
  }
  const limitations = [
    NOTICE,
    '生成静态初始节点、独立微波/数传/卫星/光纤设备、雷达侦测、干扰启停、航点、卫星/高空中继单跳转发、按 priority 自动选主链路与业务发送。',
    '高空中继：FORWARD_RELAY_NODE 作 relayPlatformId 时生成源→UAV→目标两跳与 on_message 转发（同卫星单跳模式）；仅标注 relayRole 但未引用为中继的节点仍不转发。',
    '自动选路：未指定 linkId 且存在多条同端点链路时，按 linkSettings.priority 选用最高优先链路；显式 linkId 仍绑定该链路。',
    '链路切换：按 linkSettings.switchRules 每 3 秒判断距离/干扰条件，列表中第一条成立的规则决定当前链路，受滞回时间约束并写 LINK_SWITCH 日志；未配置规则时只用优先级最高的主链路。',
    '切换输出：缺少切换前后真实 BER 测量，开启 linkSwitchEnabled 时仍阻断生成，不输出伪造质量的切换 CSV。',
    '数传波段：C 波段使用 88° 俯仰波束与 -3° 下倾，L 波段使用全向波束（示例固定值）。',
    '链路质量：缺少完整真实测量，开启 linkQualityEnabled 时阻断生成，不输出规范质量 CSV。',
    '侦测仍为 WSF_RADAR_SENSOR；ESM/激光/编码与增益修正等未核实项保持阻断或仅 mapping 注解。',
    '干扰：探测范围 detectionRange 用于自动探测发现；干扰范围 jammingRange 门控 TurnOn（SlantRangeTo，候选 weapon 无 maximum_range）；定时启停不按距离门控。',
    'clock_rate 在 -es 下不生效；arrivalTime 无引擎约束；业务 QoS engineEnforced=false。',
    `包内输出目录 ${outputDirectory}：scenario_events.csv（按开关输出） / scenario_events.aer / position.csv。`,
    `文件拆分与命名同对接示例，入口为 ${ENTRY_FILE}；平台类型名仍按场景平台独立生成。`,
    '数传上行经 forward_delay、下行经 return_delay（固定 1 秒）交给 script_proc；微波、卫星、光纤直连 script_proc。',
    'link_calc 挂在第一个后方指挥节点上，参数由场景配置汇总；本地运行前探测引擎，缺少 WSF_LINK_CALC_PROCESSOR 时运行包去掉该段，有则原样运行。',
    '生成阶段不运行 mission，engineValidated 保持 false。',
  ]

  const manifest = {
    scope: 'CANDIDATE_NODES_MICROWAVE_DATALINK_SAT_FIBER_JAMMER_UAV_RELAY_ROUTING',
    engineValidated: false,
    scenarioId: config.scenario.id, revision: draft.revision, entry: ENTRY_FILE,
    scriptFiles: [ENTRY_FILE, DEFINITION_FILE, ...PLATFORM_TYPE_FILES, INSTANCE_FILE, 'observers.txt'],
    linkCalc: {
      emitted: linkCalcSlot !== null,
      hostPlatformId: linkCalcHost?.platformId ?? null,
      note: linkCalcSlot === null
        ? '场景中没有后方指挥节点，未生成 link_calc。'
        : 'WSF_LINK_CALC_PROCESSOR 由对接方程序读取；本地运行前探测引擎，缺少该处理器时运行包去掉该段，有则原样运行。',
    },
    platforms, devices, businesses, jammers, sensors,
    environment: { seaState: environment.seaState, rainRateMmPerHour: environment.rainRateMmPerHour, engineEmitted: environmentEmitted },
    clockRate: {
      value: clockRate ?? null, engineEmitted: clockRateEmitted,
      effectiveUnderEventStepping: false,
      note: 'mission-runner 使用 -es；事件推进下 clock_rate 不改变墙钟速度。',
    },
    timeStep: { value: config.scenario.timeStep, mappedTo: 'mover.update_interval', engineEmitted: config.scenario.timeStep > 0 },
    output: {
      configuredDirectory: config.output.directory,
      resolvedDirectory: outputDirectory,
      eventsCsvPath: config.output.eventsEnabled ? eventsCsvPath : null,
      positionCsvPath,
      eventsEnabled: config.output.eventsEnabled,
      linkQualityEnabled,
      linkQualityCsvPath: null,
      linkQualityMappedTo: [],
      linkQualityUnmeasured: ['PathLoss', 'JammingPower', 'ReceivedPower', 'SNR', 'BER', 'LinkStatus'],
      linkSwitchEnabled,
      linkSwitchCsvPath: null,
      linkSwitchStatsEmitted: false,
      linkSwitchTrigger: null,
      linkSwitchNote: '缺少真实 BER，不执行或输出切换；priority 仅决定主链路。',
      linkPriority: linkSettings.priority,
      switchCooldownS: linkSettings.switchCooldownS,
    },
    scenarioStartTime: { value: config.scenario.startTime, scriptDate: startDateTime.date,
      scriptTime: startDateTime.time, convention: 'AS_STORED_UTC', engineEmitted: true },
    informationTypes: { enum: [...INFORMATION_TYPE_ENUM], candidateMap: INFORMATION_TYPE_CANDIDATE },
    sensorExtensions: {
      esmModelAvailableInCandidateScripts: false,
      probabilityMapped: false,
      probabilityBlocker: 'detection_threshold 为 dB 门限，缺虚警率假设；detection_probability 仅为脚本 API。',
      directionMapped: false,
    },
    excludedLinkIds: [...excluded], limitations,
  }
  const typeFileTexts = Object.fromEntries(PLATFORM_TYPE_FILES.map(name =>
    [name, [`include_once ${DEFINITION_FILE}`, '', ...typeFiles.get(name)!].join('\n') + '\n']))
  return { manifest, files: {
    [ENTRY_FILE]: setup.join('\n') + '\n',
    [DEFINITION_FILE]: perDefinition.join('\n') + '\n',
    ...typeFileTexts,
    [INSTANCE_FILE]: instances.join('\n') + '\n',
    'observers.txt': buildPositionObserver(positionCsvPath),
    'mapping.json': JSON.stringify(manifest, null, 2) + '\n',
    'input.json': JSON.stringify(draft, null, 2) + '\n',
    'README.txt': limitations.join('\n') + '\n',
  } }
}

/** 引擎只写本次独占包内的相对目录，不接受路径穿越或脚本语法字符。 */
function resolveOutputDirectory(directory: string): string {
  const normalized = directory.trim().replace(/\\/g, '/')
  const parts = normalized.split('/').filter(part => part !== '.' && part !== '')
  if (normalized.startsWith('/') || /[:"<>|?*\x00-\x20]/.test(normalized)
    || parts.some(part => part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new MissionGenerationError('output.directory', '输出目录必须为本次运行包内的相对目录，不得含绝对路径、上级目录或非法路径字符。')
  }
  return parts.length > 0 ? parts.join('/') : 'output'
}

/** directory 已通过包内相对路径校验。 */
function joinOutputPath(directory: string, fileName: string): string {
  return `${directory}/${fileName}`
}


// 沿用候选 observers.txt 的字段和回调；路径按配置 output.directory 解析，不合成质量结果。
function buildPositionObserver(positionCsvPath: string): string {
  return `script_variables
  bool positionHeaderWritten = false;
end_script_variables
script void MoverUpdated(WsfPlatform aPlatform, WsfMover aMover)
{
  FileIO file = FileIO();
  if (!positionHeaderWritten)
  {
    file.Open("${positionCsvPath}", "out");
    file.Writeln("TIME,NAME,LON,LAT,ALT,SPEED,HEADING");
    positionHeaderWritten = true;
  }
  else
  {
    file.Open("${positionCsvPath}", "append");
  }
  file.Writeln(write_str(TIME_NOW, ",", aPlatform.Name(), ",", aPlatform.Longitude(), ",", aPlatform.Latitude(), ",", aPlatform.Altitude(), ",", aPlatform.Speed(), ",", aPlatform.Heading()));
  file.Close();
}
end_script
observer
  enable MOVER_UPDATED MoverUpdated
end_observer
`
}

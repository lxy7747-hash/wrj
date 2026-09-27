import type { SatelliteType, ScenarioDraft } from '../../src/contracts/domain-models.js'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation.js'
import { isConfiguredLinkEnabled, readLinkSettings } from '../../src/features/scenarios/link-settings.js'

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
  GROUND_CLUSTER_COMMAND_NODE: { reference: 'COMMAND_VEHICLE_PLATFORM', mover: 'WSF_GROUND_MOVER' },
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
  SHENTONG: { reference: 'SHEN_TONG_SAT', orbital: [
    '      semi_major_axis 7000 km', '      eccentricity 0.0', '      inclination 60 deg',
    '      raan 80 deg', '      argument_of_periapsis 0 deg', '      mean_anomaly 0 deg'] },
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
export function buildMissionPackage(draft: ScenarioDraft) {
  const { config } = draft
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
      band: datalink ? DATALINK_BAND : null,
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
      dataRateMbps: link.dataRate,
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
      return { targetPlatformId: target, ordered, primary: ordered[0]! }
    })
    // 本机执行预算，不是业务速率约束；防止合法有限数值组合生成无界发送任务。
    sendRequests += Math.ceil(config.scenario.duration * demand.frequencyHz) * routes.length
    if (!Number.isFinite(sendRequests) || sendRequests > 1_000_000) {
      throw new MissionGenerationError(`${path}.frequencyHz`, '本次执行的预计发送请求超过 100 万次，请降低频次或缩短场景时长。')
    }
    const canFailover = routes.length === 1 && routes[0]!.ordered.length > 1
    return [{ demandId: demand.id, sourcePlatformId: demand.sourcePlatformId, messageType: demand.informationType,
      candidateMessageType: INFORMATION_TYPE_CANDIDATE[demand.informationType as InformationTypeEnum],
      sizeBits, frequencyHz: demand.frequencyHz,
      routes: routes.map(item => item.primary),
      routePlans: routes.map(item => ({
        targetPlatformId: item.targetPlatformId,
        orderedLinkIds: item.ordered.map(device => device.linkId),
        orderedLinkTypes: item.ordered.map(device => device.linkType),
      })),
      failoverEnabled: canFailover,
      failoverRoutes: canFailover ? routes[0]!.ordered : null,
      processorId: `business_${token(demand.id)}`,
      switchProcessorId: canFailover ? `link_switch_${token(demand.id)}` : null,
      constraints: { priority: demand.priority, maxLatencyMs: demand.maxLatencyMs, minDataRateMbps: demand.minDataRateMbps, engineEnforced: false } }]
  })
  // 输出路径提前计算，供平台处理器写入专用 CSV。
  const outputDirectoryEarly = resolveOutputDirectory(config.output.directory)
  const linkQualityEnabled = config.output.linkQualityEnabled === true
  if (linkQualityEnabled) throw new MissionGenerationError('output.linkQualityEnabled', '当前引擎尚无完整的真实质量测量来源，请关闭质量输出；不会使用配置 BER 或固定 UP 生成规范 CSV。')
  const linkSwitchEnabled = config.output.linkSwitchEnabled === true
  if (linkSwitchEnabled) throw new MissionGenerationError('output.linkSwitchEnabled', '当前引擎尚无切换前后真实 BER 测量，请关闭切换输出；不会以空值或配置值生成规范 CSV。')
  const antennas: string[] = []
  const definitions: string[] = []
  const networkDeclarations: string[] = []
  const declaredNetworks = new Set<string>()
  /** 声明候选网络类型；光纤用 P2P，其余直连仍只写 network_name（与既有微波/数传一致）。 */
  function ensureNetwork(name: string, model: string | null): void {
    if (declaredNetworks.has(name) || model === null) return
    declaredNetworks.add(name)
    networkDeclarations.push(`network ${name} ${model}`, 'end_network')
  }
  /** 为端点生成独立通信设备；光纤无射频收发参数，只写有线收发器与速率。 */
  function pushCommDevice(
    deviceId: string,
    networkName: string,
    link: (typeof links)[number],
    mapping: (typeof devices)[number],
    receiverProcessorId?: string,
  ): void {
    if (mapping.commModel === FIBER_COMM_MODEL) {
      ensureNetwork(networkName, FIBER_NETWORK_MODEL)
      definitions.push(`  comm ${deviceId} ${FIBER_COMM_MODEL}`, `    network_name ${networkName}`,
        `    transfer_rate ${link.dataRate} mbits/sec`, '  end_comm')
      return
    }
    for (const side of ['tx', 'rx'] as const) {
      antennas.push(`antenna_pattern ${deviceId}_${side}`, '  uniform_pattern',
        `    peak_gain ${link.antennaGain[side]} dB`, '    azimuth_beamwidth 360 deg',
        '    elevation_beamwidth 180 deg', '  end_uniform_pattern', 'end_antenna_pattern')
    }
    definitions.push(`  comm ${deviceId} ${mapping.commModel}`, `    network_name ${networkName}`,
      `    transfer_rate ${link.dataRate} mbits/sec`,
      ...(mapping.bitErrorProbability === null ? [] : [`    bit_error_probability ${mapping.bitErrorProbability}`]),
      '    transmitter',
      `      frequency ${link.frequency} MHz`, `      bandwidth ${link.bandwidth} MHz`,
      `      power ${link.txPower} W`, `      antenna_pattern ${deviceId}_tx`, '    end_transmitter',
      '    receiver', `      frequency ${link.frequency} MHz`, `      bandwidth ${link.bandwidth} MHz`,
      `      antenna_pattern ${deviceId}_rx`, '    end_receiver',
      ...(receiverProcessorId ? [`    internal_link ${receiverProcessorId}`] : []), '  end_comm')
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
  for (const platform of platforms) {
    definitions.push(`platform_type ${platform.generatedType} WSF_PLATFORM`,
      `  mover ${platform.mover}`, `    update_interval ${moverUpdateInterval} sec`)
    if (platform.orbital !== null) {
      // 轨道要素取自候选模型，历元取配置的仿真开始时刻，使轨道与 start_date 使用同一日期口径。
      definitions.push('    oblate_earth true', '    orbital_state',
        `      epoch_date_time ${startDateTime.date} ${startDateTime.time.slice(0, 8)}`,
        ...platform.orbital, '    end_orbital_state')
    }
    definitions.push('  end_mover')
    devices.forEach((mapping, index) => {
      const link = links[index]!
      if (mapping.source.platformId === platform.platformId) {
        pushCommDevice(mapping.source.deviceId, mapping.hop1Network, link, mapping)
      }
      if (mapping.target.platformId === platform.platformId) {
        pushCommDevice(mapping.target.deviceId, mapping.hop2Network ?? mapping.hop1Network, link, mapping)
      }
      if (mapping.relay && mapping.relay.platformId === platform.platformId) {
        pushCommDevice(mapping.relay.ingressDeviceId, mapping.hop1Network, link, mapping, mapping.relay.processorId)
        pushCommDevice(mapping.relay.egressDeviceId, mapping.hop2Network!, link, mapping)
        // 固定单跳：中继（卫星或高空 UAV）收到源消息后经第二跳发往目标；不复制候选硬编码平台名。
        // default 是兜底处理指令；type default 只匹配名为 default 的消息。
        definitions.push(`  processor ${mapping.relay.processorId} WSF_SCRIPT_PROCESSOR`,
          '    on_message', '      default', '        script',
          `          PLATFORM.Comm("${mapping.relay.egressDeviceId}").SendMessage(MESSAGE, "${mapping.target.platformId}", "${mapping.target.deviceId}");`,
          '        end_script', '    end_on_message', '  end_processor')
      }
    })
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
      const emitRoutes = business.failoverRoutes ?? business.routes
      definitions.push(`  processor ${business.processorId} WSF_SCRIPT_PROCESSOR`,
        `    update_interval ${config.output.writeInterval} sec`,
        '    script_variables',
        '      double emissionIndex = 0;',
        '      int activeRouteIndex = 0;',
        '    end_script_variables',
        '    script void EmitBusiness()', '    {', `      if (TIME_NOW >= ${config.scenario.duration}) return;`)
      emitRoutes.forEach((route, index) => {
        const destPlatform = route.relay ? route.relay.platformId : route.target.platformId
        const destDevice = route.relay ? route.relay.ingressDeviceId : route.target.deviceId
        if (business.failoverEnabled) {
          definitions.push(index === 0 ? '      if (activeRouteIndex == 0)' : `      else if (activeRouteIndex == ${index})`)
        }
        // 多目标各发送一次；只有同一目标的备选链路才按活动路由互斥发送。
        definitions.push('      {')
        definitions.push(
          '        WsfMessage message = WsfMessage();',
          `        message.SetType(${formatAfsimString(business.messageType)});`,
          `        message.SetSubType(${formatAfsimString(business.demandId)});`,
          `        message.SetSizeInBits(${business.sizeBits});`,
          `        PLATFORM.Comm("${route.source.deviceId}").SendMessage(message, "${destPlatform}", "${destDevice}");`,
        )
        definitions.push('      }')
      })
      definitions.push('      emissionIndex = emissionIndex + 1;',
        `      double nextTime = emissionIndex / ${business.frequencyHz.toExponential(17)};`,
        `      if (nextTime < ${config.scenario.duration} && nextTime > TIME_NOW) PROCESSOR.ExecuteScriptAtTime(nextTime, "EmitBusiness");`,
        '    }', '    end_script',
        '    script void QueueBusiness()', '    {', '      PROCESSOR.ExecuteScriptAtTime(TIME_NOW, "EmitBusiness");',
        '    }', '    end_script')

      definitions.push('    on_initialize2',
        '      PROCESSOR.ExecuteScriptAtTime(0, "QueueBusiness");', '    end_on_initialize2', '  end_processor')
    }

    definitions.push('end_platform_type')
  }
  // 网络声明放在平台类型之前，供光纤 P2P 等需要显式 network 的设备引用。
  if (networkDeclarations.length > 0) definitions.unshift(...networkDeclarations, '')

  const instances = config.platforms.flatMap((platform, index) => {
    const generated = platforms[index]!
    const position = platform.initialPosition
    // 卫星位置由轨道决定；写 position 会与轨道冲突，也会让配置坐标看起来生效。
    const lines = generated.orbital === null
      ? [`platform ${platform.id} ${generated.generatedType}`,
        `  position ${formatPosition(position.latitude, position.longitude)}`,
        `  altitude ${position.altitude} m`]
      : [`platform ${platform.id} ${generated.generatedType}`]
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
  const environment = config.scenario.environment
  const clockRate = environment.simClockSpeed
  const clockRateEmitted = typeof clockRate === 'number' && Number.isFinite(clockRate) && clockRate > 0
  const environmentEmitted = Number.isFinite(environment.seaState) && environment.seaState >= 0
    && Number.isFinite(environment.rainRateMmPerHour) && environment.rainRateMmPerHour >= 0
  // 输出路径：复用平台生成前已解析的目录；事件/位置/质量/切换 CSV 均落在同一目录。
  const outputDirectory = outputDirectoryEarly
  const eventsCsvPath = joinOutputPath(outputDirectory, 'scenario_events.csv')
  const positionCsvPath = joinOutputPath(outputDirectory, 'position.csv')
  const linkSettings = settings
  const globals = [
    `start_date ${startDateTime.date}`,
    `start_time ${startDateTime.time}`,
    ...(clockRateEmitted ? [`clock_rate ${clockRate}`] : []),
    ...(environmentEmitted ? ['global_environment', `  sea_state ${environment.seaState}`,
      `  rain_rate ${environment.rainRateMmPerHour} mm/hr`, 'end_global_environment'] : []),
  ]
  const entry = ['# ' + NOTICE, 'include_once platforms.txt', 'include_once observers.txt',
    `end_time ${config.scenario.duration} sec`, ...globals, ...instances]
  if (config.output.eventsEnabled) {
    entry.push('csv_event_output', `  file ${eventsCsvPath}`,
      // 起止事件自带年月日时分秒，是运行结果与配置开始时刻绑定的唯一证据。
      '  enable SIMULATION_STARTING', '  enable SIMULATION_COMPLETE',
      '  enable PLATFORM_ADDED', '  enable PLATFORM_INITIALIZED',
      '  enable COMM_TURNED_ON', '  enable COMM_TURNED_OFF',
      '  enable MESSAGE_TRANSMITTED', '  enable MESSAGE_RECEIVED')
    if (jammers.length > 0 || sensors.length > 0) entry.push('  enable SENSOR_DETECTION_CHANGED')
    if (jammers.length > 0) entry.push(
      '  enable WEAPON_TURNED_ON', '  enable WEAPON_TURNED_OFF',
      '  enable WEAPON_MODE_ACTIVATED', '  enable WEAPON_MODE_DEACTIVATED',
      '  enable JAMMING_REQUEST_INITIATED', '  enable JAMMING_REQUEST_UPDATED',
      '  enable JAMMING_REQUEST_CANCELED')
    // 专用 link_quality/link_switch CSV 由平台处理器写入；此处 events 仍保留收发与干扰事件。
    entry.push('end_csv_event_output')
  }
  const limitations = [
    NOTICE,
    '生成静态初始节点、独立微波/数传/卫星/光纤设备、雷达侦测、干扰启停、航点、卫星/高空中继单跳转发、按 priority 自动选主链路与业务发送。',
    '高空中继：FORWARD_RELAY_NODE 作 relayPlatformId 时生成源→UAV→目标两跳与 on_message 转发（同卫星单跳模式）；仅标注 relayRole 但未引用为中继的节点仍不转发。',
    '自动选路：未指定 linkId 且存在多条同端点链路时，按 linkSettings.priority 选用最高优先链路；显式 linkId 仍绑定该链路。',
    '链路切换：缺少切换前后真实 BER 测量，开启 linkSwitchEnabled 时阻断生成；当前只按优先级选择主链路，不执行伪造质量的切换。',
    '链路质量：缺少完整真实测量，开启 linkQualityEnabled 时阻断生成，不输出规范质量 CSV。',
    '侦测仍为 WSF_RADAR_SENSOR；ESM/激光/编码与增益修正等未核实项保持阻断或仅 mapping 注解。',
    '干扰：探测范围 detectionRange 用于自动探测发现；干扰范围 jammingRange 门控 TurnOn（SlantRangeTo，候选 weapon 无 maximum_range）；定时启停不按距离门控。',
    'clock_rate 在 -es 下不生效；arrivalTime 无引擎约束；业务 QoS engineEnforced=false。',
    `包内输出目录 ${outputDirectory}：scenario_events.csv（按开关输出） / position.csv。`,
    '生成阶段不运行 mission，engineValidated 保持 false。',
  ]

  const manifest = {
    scope: 'CANDIDATE_NODES_MICROWAVE_DATALINK_SAT_FIBER_JAMMER_UAV_RELAY_ROUTING',
    engineValidated: false,
    scenarioId: config.scenario.id, revision: draft.revision, entry: 'mission.txt',
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
  return { manifest, files: {
    'mission.txt': entry.join('\n') + '\n',
    'platforms.txt': [...antennas, ...definitions].join('\n') + '\n',
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

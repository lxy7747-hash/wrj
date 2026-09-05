import type {
  InformationDemand,
  Jammer,
  JammerUiExtension,
  Link,
  OutputConfig,
  Platform,
  ScenarioIdentity,
  Sensor,
  SensorUiExtension,
  ValidationIssue,
  ValidationResult,
} from '../../contracts/domain-models'

const ROOT_KEYS = [
  'schemaVersion',
  'scenario',
  'platforms',
  'links',
  'jammers',
  'sensors',
  'output',
  'informationDemand',
] as const
const SCENARIO_KEYS = ['id', 'name', 'description', 'startTime', 'duration', 'timeStep', 'environment'] as const
const ENVIRONMENT_KEYS = [
  'seaState',
  'temperatureC',
  'humidityPercent',
  'rainRateMmPerHour',
  'rainLossDbPerKm',
  'multipathEnabled',
] as const
const PLATFORM_KEYS = ['id', 'name', 'type', 'category', 'initialPosition', 'waypoints', 'linkIds', 'sensorIds', 'jammerIds'] as const
const LINK_KEYS = ['id', 'type', 'sourcePlatformId', 'targetPlatformId', 'frequency', 'bandwidth', 'txPower', 'antennaGain', 'modulation', 'berThreshold', 'dataRate', 'direction'] as const
const JAMMER_KEYS = ['id', 'platformId', 'type', 'defaultPower', 'frequency', 'bandwidth', 'autoDetect', 'detectionRange'] as const
const SENSOR_KEYS = ['id', 'platformId', 'frequencyRange', 'detectionRange'] as const
const FREQUENCY_RANGE_KEYS = ['min', 'max'] as const
const OUTPUT_KEYS = ['directory', 'writeInterval', 'linkQualityEnabled', 'eventsEnabled', 'linkSwitchEnabled'] as const
const INFORMATION_DEMAND_KEYS = ['id', 'sourcePlatformId', 'destinationPlatformIds', 'informationType', 'volumeMb', 'frequencyHz', 'priority', 'maxLatencyMs', 'minDataRateMbps'] as const
const UI_EXTENSION_KEYS = ['jammers', 'sensors'] as const
const JAMMER_UI_EXTENSION_KEYS = ['jammerId', 'direction', 'duration', 'enabled'] as const
const SENSOR_UI_EXTENSION_KEYS = ['sensorId', 'type', 'direction', 'probability', 'enabled'] as const
const ANTENNA_GAIN_KEYS = ['tx', 'rx'] as const
const POSITION_KEYS = ['longitude', 'latitude', 'altitude'] as const
const WAYPOINT_KEYS = [...POSITION_KEYS, 'speed', 'arrivalTime'] as const
export const BUSINESS_INFORMATION_NODE_TYPES = [
  'REAR_COMMAND_NODE',
  'FORWARD_RELAY_NODE',
  'GROUND_CLUSTER_COMMAND_NODE',
  'AIRBORNE_MISSION_CLUSTER',
] as const
export const SUPPORTING_ENTITY_TYPES = ['COMMUNICATION_SATELLITE', 'GROUND_JAMMER_DETECTION_STATION'] as const
const PLATFORM_TYPES = [...BUSINESS_INFORMATION_NODE_TYPES, ...SUPPORTING_ENTITY_TYPES] as const
const DEPLOYMENT_DOMAINS = ['ground', 'air', 'space'] as const
export const LINK_TYPES = ['SAT', 'MICROWAVE', 'DATALINK', 'LASER'] as const
export const JAMMER_TYPES = ['BARRAGE', 'SPOT'] as const
export const LINK_MHZ_MINIMUM_STEP = 0.001
const MODULATIONS = ['BPSK', 'QPSK'] as const
const LINK_DIRECTIONS = ['FORWARD', 'REVERSE'] as const
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

export interface ScenarioInspection {
  result: ValidationResult
  identity?: ScenarioIdentity
  platforms?: Platform[]
  links?: Link[]
  jammers?: Jammer[]
  sensors?: Sensor[]
  output?: OutputConfig
  informationDemand?: InformationDemand[]
}

export interface ScenarioUiExtensionsInspection {
  result: ValidationResult
  jammers?: JammerUiExtension[]
  sensors?: SensorUiExtension[]
}

/**
 * 判断未知值是否是仅包含指定键的普通对象。
 * @param value 待校验的未知值。
 * @param keys 对象必须且只能包含的键。
 * @returns 值满足闭合对象形状时返回 `true`。
 * @remarks 纯校验函数，不修改输入值。
 */
function isClosedObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

/**
 * 判断未知值是否是有限数值且满足给定范围。
 * @param value 待校验的未知值。
 * @param minimum 可选最小值。
 * @param maximum 可选最大值。
 * @returns 数值有效且位于范围内时返回 `true`。
 * @remarks 纯校验函数，不进行单位换算或状态修改。
 */
function isFiniteNumber(value: unknown, minimum = -Infinity, maximum = Infinity): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0
}

/**
 * 按公历规则校验 RFC 3339 时间戳。
 * @param value 待校验的时间文本。
 * @returns 文本格式和日历日期均有效时返回 `true`。
 * @remarks 纯算术校验，不读取系统时间。
 */
export function isRfc3339DateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = RFC3339_DATE_TIME.exec(value)
  if (match === null) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return false
  const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= monthLengths[month - 1]!
}

/**
 * 追加一个中文字段校验错误。
 * @param errors 当前错误集合。
 * @param code 稳定错误代码。
 * @param message 面向用户的中文提示。
 * @param fieldPath 对应场景合同字段路径。
 * @returns 无返回值。
 * @remarks 仅向传入数组追加一项错误。
 */
function addError(errors: ValidationIssue[], code: string, message: string, fieldPath: string): void {
  errors.push({ severity: 'ERROR', code, message, fieldPath })
}

/**
 * 判断场景实体是否计入 50 个业务信息节点容量。
 * @param type 场景实体类型。
 * @returns 属于文档规定的四类业务信息节点时返回 `true`。
 * @remarks 纯分类判断，不修改场景数据。
 */
export function isBusinessInformationNodeType(type: unknown): boolean {
  return typeof type === 'string' && (BUSINESS_INFORMATION_NODE_TYPES as readonly string[]).includes(type)
}

/**
 * 读取集合中可用于引用校验的字符串 ID。
 * @param value 待读取的配置集合。
 * @returns 集合内合法字符串 ID 的集合。
 * @remarks 忽略形状错误的条目；各集合自身的完整校验负责报告具体字段错误。
 */
function collectIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.flatMap((item) => (
    typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string'
      ? [(item as { id: string }).id]
      : []
  )))
}

/**
 * 校验平台关联 ID 数组的类型、唯一性和引用闭合性。
 * @param value 待校验的关联 ID 数组。
 * @param knownIds 对应目标集合中的有效 ID。
 * @param fieldPath 当前关联字段路径。
 * @param errors 接收中文字段错误的集合。
 * @returns 无返回值。
 * @remarks 只追加校验错误，不修改关联数组。
 */
function inspectReferenceIds(
  value: unknown,
  knownIds: ReadonlySet<string>,
  ownedIds: ReadonlySet<string>,
  fieldPath: string,
  errors: ValidationIssue[],
): void {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.trim() === '')) {
    addError(errors, 'REFERENCE_LIST_INVALID', '关联 ID 必须是非空字符串数组。', fieldPath)
    return
  }
  if (new Set(value).size !== value.length) addError(errors, 'REFERENCE_DUPLICATED', '关联 ID 不允许重复。', fieldPath)
  if (value.some((id) => !knownIds.has(id))) addError(errors, 'REFERENCE_NOT_FOUND', '关联 ID 必须引用当前场景中存在的对象。', fieldPath)
  if (value.some((id) => knownIds.has(id) && !ownedIds.has(id))) {
    addError(errors, 'REFERENCE_OWNERSHIP_MISMATCH', '关联对象不属于当前场景实体。', fieldPath)
  }
}

/** 读取归属于指定平台的关联对象 ID。 */
function collectOwnedIds(items: unknown, platformId: string, fields: readonly string[]): Set<string> {
  if (!Array.isArray(items)) return new Set()
  return collectIds(items.filter((item) => (
    typeof item === 'object'
    && item !== null
    && fields.some((field) => (item as Record<string, unknown>)[field] === platformId)
  )))
}

/**
 * 校验初始位置或航点坐标。
 * @param value 待校验的位置对象。
 * @param fieldPath 当前对象路径。
 * @param waypoint 是否同时校验航点速度和到达时间。
 * @param errors 接收中文字段错误的集合。
 * @returns 无返回值。
 * @remarks 只追加校验错误，不修改坐标或单位。
 */
function inspectPosition(value: unknown, fieldPath: string, waypoint: boolean, errors: ValidationIssue[]): void {
  if (!isClosedObject(value, waypoint ? WAYPOINT_KEYS : POSITION_KEYS)) {
    addError(errors, 'POSITION_SHAPE_INVALID', waypoint ? '航点结构不正确。' : '初始位置结构不正确。', fieldPath)
    return
  }
  if (!isFiniteNumber(value.longitude, -180, 180)) addError(errors, 'LONGITUDE_INVALID', '经度必须在 -180 至 180 之间。', `${fieldPath}.longitude`)
  if (!isFiniteNumber(value.latitude, -90, 90)) addError(errors, 'LATITUDE_INVALID', '纬度必须在 -90 至 90 之间。', `${fieldPath}.latitude`)
  if (!isFiniteNumber(value.altitude, 0)) addError(errors, 'ALTITUDE_INVALID', '高度不能小于 0。', `${fieldPath}.altitude`)
  if (waypoint) {
    if (!isFiniteNumber(value.speed, 0)) addError(errors, 'SPEED_INVALID', '速度不能小于 0。', `${fieldPath}.speed`)
    if (!isFiniteNumber(value.arrivalTime, 0)) addError(errors, 'ARRIVAL_TIME_INVALID', '到达时间不能小于 0。', `${fieldPath}.arrivalTime`)
  }
}

/**
 * 校验一条信息链路的完整参数和平台端点。
 * @param value 待校验的链路对象。
 * @param index 链路在场景集合中的位置。
 * @param platformIds 当前场景中存在的平台 ID。
 * @param errors 接收中文字段错误的集合。
 * @returns 无返回值。
 * @remarks 只追加校验错误，不修改链路或平台关联数组。
 */
function inspectLink(value: unknown, index: number, platformIds: ReadonlySet<string>, errors: ValidationIssue[]): void {
  const path = `links[${index}]`
  if (!isClosedObject(value, LINK_KEYS)) {
    addError(errors, 'LINK_SHAPE_INVALID', '链路结构不正确。', path)
    return
  }
  if (typeof value.id !== 'string' || value.id.trim() === '') addError(errors, 'LINK_ID_INVALID', '链路 ID 为必填项。', `${path}.id`)
  if (typeof value.type !== 'string' || !(LINK_TYPES as readonly string[]).includes(value.type)) addError(errors, 'LINK_TYPE_INVALID', '链路类型不正确。', `${path}.type`)
  if (typeof value.sourcePlatformId !== 'string' || !platformIds.has(value.sourcePlatformId)) addError(errors, 'LINK_SOURCE_INVALID', '链路源平台必须引用当前场景实体。', `${path}.sourcePlatformId`)
  if (typeof value.targetPlatformId !== 'string' || !platformIds.has(value.targetPlatformId)) addError(errors, 'LINK_TARGET_INVALID', '链路目标平台必须引用当前场景实体。', `${path}.targetPlatformId`)
  if (typeof value.sourcePlatformId === 'string' && value.sourcePlatformId === value.targetPlatformId) addError(errors, 'LINK_ENDPOINT_DUPLICATED', '链路源平台和目标平台不能相同。', `${path}.targetPlatformId`)
  if (!isPositiveFiniteNumber(value.frequency)) addError(errors, 'LINK_FREQUENCY_INVALID', '链路频率必须大于 0 MHz。', `${path}.frequency`)
  if (!isPositiveFiniteNumber(value.bandwidth)) addError(errors, 'LINK_BANDWIDTH_INVALID', '链路带宽必须大于 0 MHz。', `${path}.bandwidth`)
  if (!isFiniteNumber(value.txPower, 0)) addError(errors, 'LINK_POWER_INVALID', '链路发射功率不能小于 0 W。', `${path}.txPower`)
  if (!isClosedObject(value.antennaGain, ANTENNA_GAIN_KEYS)) {
    addError(errors, 'ANTENNA_GAIN_INVALID', '收发天线增益结构不正确。', `${path}.antennaGain`)
  } else {
    if (!isFiniteNumber(value.antennaGain.tx)) addError(errors, 'TX_ANTENNA_GAIN_INVALID', '发射天线增益必须是有效数值。', `${path}.antennaGain.tx`)
    if (!isFiniteNumber(value.antennaGain.rx)) addError(errors, 'RX_ANTENNA_GAIN_INVALID', '接收天线增益必须是有效数值。', `${path}.antennaGain.rx`)
  }
  if (typeof value.modulation !== 'string' || !(MODULATIONS as readonly string[]).includes(value.modulation)) addError(errors, 'MODULATION_INVALID', '调制方式不正确。', `${path}.modulation`)
  if (!isFiniteNumber(value.berThreshold, 0, 1)) addError(errors, 'BER_THRESHOLD_INVALID', 'BER 阈值必须在 0 至 1 之间。', `${path}.berThreshold`)
  if (!isFiniteNumber(value.dataRate, 0)) addError(errors, 'DATA_RATE_INVALID', '数据速率不能小于 0 Mbps。', `${path}.dataRate`)
  if (typeof value.direction !== 'string' || !(LINK_DIRECTIONS as readonly string[]).includes(value.direction)) addError(errors, 'LINK_DIRECTION_INVALID', '链路方向不正确。', `${path}.direction`)
}

/**
 * 校验一台干扰设备的完整参数和归属平台。
 * @param value 待校验的干扰设备对象。
 * @param index 干扰设备在场景集合中的位置。
 * @param platformIds 当前场景中存在的平台 ID。
 * @param errors 接收中文字段错误的集合。
 * @returns 无返回值。
 * @remarks 只追加校验错误，不修改干扰设备或平台关联数组。
 */
function inspectJammer(value: unknown, index: number, platformIds: ReadonlySet<string>, errors: ValidationIssue[]): void {
  const path = `jammers[${index}]`
  if (!isClosedObject(value, JAMMER_KEYS)) {
    addError(errors, 'JAMMER_SHAPE_INVALID', '干扰设备结构不正确。', path)
    return
  }
  if (typeof value.id !== 'string' || value.id.trim() === '') addError(errors, 'JAMMER_ID_INVALID', '干扰设备 ID 为必填项。', `${path}.id`)
  if (typeof value.platformId !== 'string' || !platformIds.has(value.platformId)) addError(errors, 'JAMMER_PLATFORM_INVALID', '干扰设备必须归属于当前场景实体。', `${path}.platformId`)
  if (typeof value.type !== 'string' || !(JAMMER_TYPES as readonly string[]).includes(value.type)) addError(errors, 'JAMMER_TYPE_INVALID', '干扰设备类型不正确。', `${path}.type`)
  if (!isFiniteNumber(value.defaultPower, 0)) addError(errors, 'JAMMER_POWER_INVALID', '默认功率不能小于 0 W。', `${path}.defaultPower`)
  if (!isPositiveFiniteNumber(value.frequency)) addError(errors, 'JAMMER_FREQUENCY_INVALID', '干扰频率必须大于 0 MHz。', `${path}.frequency`)
  if (!isPositiveFiniteNumber(value.bandwidth)) addError(errors, 'JAMMER_BANDWIDTH_INVALID', '干扰带宽必须大于 0 MHz。', `${path}.bandwidth`)
  if (typeof value.autoDetect !== 'boolean') addError(errors, 'JAMMER_AUTO_DETECT_INVALID', '自动检测开关格式不正确。', `${path}.autoDetect`)
  if (!isFiniteNumber(value.detectionRange, 0)) addError(errors, 'JAMMER_RANGE_INVALID', '检测范围不能小于 0 m。', `${path}.detectionRange`)
}

/** 校验一台传感器的规范参数和归属平台。 */
function inspectSensor(value: unknown, index: number, platformIds: ReadonlySet<string>, errors: ValidationIssue[]): void {
  const path = `sensors[${index}]`
  if (!isClosedObject(value, SENSOR_KEYS)) {
    addError(errors, 'SENSOR_SHAPE_INVALID', '传感器结构不正确。', path)
    return
  }
  if (typeof value.id !== 'string' || value.id.trim() === '') addError(errors, 'SENSOR_ID_INVALID', '传感器 ID 为必填项。', `${path}.id`)
  if (typeof value.platformId !== 'string' || !platformIds.has(value.platformId)) addError(errors, 'SENSOR_PLATFORM_INVALID', '传感器必须归属于当前场景实体。', `${path}.platformId`)
  if (!isClosedObject(value.frequencyRange, FREQUENCY_RANGE_KEYS)) {
    addError(errors, 'SENSOR_FREQUENCY_RANGE_INVALID', '传感器频率范围结构不正确。', `${path}.frequencyRange`)
  } else {
    const minimum = value.frequencyRange.min
    const maximum = value.frequencyRange.max
    const minimumValid = isPositiveFiniteNumber(minimum)
    const maximumValid = isPositiveFiniteNumber(maximum)
    if (!minimumValid) addError(errors, 'SENSOR_FREQUENCY_MIN_INVALID', '最低频率必须大于 0 MHz。', `${path}.frequencyRange.min`)
    if (!maximumValid) addError(errors, 'SENSOR_FREQUENCY_MAX_INVALID', '最高频率必须大于 0 MHz。', `${path}.frequencyRange.max`)
    if (minimumValid && maximumValid && maximum < minimum) {
      addError(errors, 'SENSOR_FREQUENCY_RANGE_REVERSED', '最高频率不能小于最低频率。', `${path}.frequencyRange.max`)
    }
  }
  if (!isFiniteNumber(value.detectionRange, 0)) addError(errors, 'SENSOR_RANGE_INVALID', '侦测距离不能小于 0 m。', `${path}.detectionRange`)
}

/** 校验输出目录合同、写入间隔和三个输出开关。 */
function inspectOutput(value: unknown, timeStep: unknown, errors: ValidationIssue[]): void {
  if (!isClosedObject(value, OUTPUT_KEYS)) {
    addError(errors, 'OUTPUT_SHAPE_INVALID', '输出配置结构不正确。', 'output')
    return
  }
  if (typeof value.directory !== 'string' || value.directory.trim() === '') addError(errors, 'OUTPUT_DIRECTORY_INVALID', '输出目录合同不能为空。', 'output.directory')
  if (!isPositiveFiniteNumber(value.writeInterval)) {
    addError(errors, 'OUTPUT_INTERVAL_INVALID', '输出写入间隔必须大于 0 秒。', 'output.writeInterval')
  } else if (isPositiveFiniteNumber(timeStep) && value.writeInterval < timeStep) {
    addError(errors, 'OUTPUT_INTERVAL_BELOW_TIME_STEP', '输出写入间隔不能小于场景时间步长。', 'output.writeInterval')
  }
  if (typeof value.linkQualityEnabled !== 'boolean') addError(errors, 'OUTPUT_LINK_QUALITY_INVALID', '链路质量输出开关格式不正确。', 'output.linkQualityEnabled')
  if (typeof value.eventsEnabled !== 'boolean') addError(errors, 'OUTPUT_EVENTS_INVALID', '事件输出开关格式不正确。', 'output.eventsEnabled')
  if (typeof value.linkSwitchEnabled !== 'boolean') addError(errors, 'OUTPUT_LINK_SWITCH_INVALID', '链路切换输出开关格式不正确。', 'output.linkSwitchEnabled')
}

/** 校验一项信息需求的引用、数量、优先级和性能约束。 */
function inspectInformationDemand(value: unknown, index: number, platformIds: ReadonlySet<string>, errors: ValidationIssue[]): void {
  const path = `informationDemand[${index}]`
  if (!isClosedObject(value, INFORMATION_DEMAND_KEYS)) {
    addError(errors, 'INFORMATION_DEMAND_SHAPE_INVALID', '信息需求结构不正确。', path)
    return
  }
  if (typeof value.id !== 'string' || value.id.trim() === '') addError(errors, 'INFORMATION_DEMAND_ID_INVALID', '信息需求 ID 为必填项。', `${path}.id`)
  if (typeof value.sourcePlatformId !== 'string' || !platformIds.has(value.sourcePlatformId)) addError(errors, 'INFORMATION_DEMAND_SOURCE_INVALID', '信息需求源平台必须引用当前场景实体。', `${path}.sourcePlatformId`)
  if (!Array.isArray(value.destinationPlatformIds) || value.destinationPlatformIds.length === 0
    || value.destinationPlatformIds.some((id) => typeof id !== 'string' || !platformIds.has(id))) {
    addError(errors, 'INFORMATION_DEMAND_DESTINATION_INVALID', '信息需求至少需要一个有效目标平台。', `${path}.destinationPlatformIds`)
  } else if (new Set(value.destinationPlatformIds).size !== value.destinationPlatformIds.length) {
    addError(errors, 'INFORMATION_DEMAND_DESTINATION_DUPLICATED', '信息需求目标平台不允许重复。', `${path}.destinationPlatformIds`)
  }
  if (typeof value.informationType !== 'string') addError(errors, 'INFORMATION_DEMAND_TYPE_INVALID', '信息类型格式不正确。', `${path}.informationType`)
  if (!isFiniteNumber(value.volumeMb, 0)) addError(errors, 'INFORMATION_DEMAND_VOLUME_INVALID', '数据量不能小于 0 MB。', `${path}.volumeMb`)
  if (!isFiniteNumber(value.frequencyHz, 0)) addError(errors, 'INFORMATION_DEMAND_FREQUENCY_INVALID', '发送频率不能小于 0 Hz。', `${path}.frequencyHz`)
  if (value.priority !== 'HIGH' && value.priority !== 'NORMAL') addError(errors, 'INFORMATION_DEMAND_PRIORITY_INVALID', '信息需求优先级不正确。', `${path}.priority`)
  if (!isFiniteNumber(value.maxLatencyMs, 0)) addError(errors, 'INFORMATION_DEMAND_LATENCY_INVALID', '最大时延不能小于 0 ms。', `${path}.maxLatencyMs`)
  if (!isFiniteNumber(value.minDataRateMbps, 0)) addError(errors, 'INFORMATION_DEMAND_RATE_INVALID', '最低速率不能小于 0 Mbps。', `${path}.minDataRateMbps`)
}

/** 校验干扰设备和传感器 UI 扩展与规范对象 ID 的一一对应关系。 */
export function inspectScenarioUiExtensions(
  value: unknown,
  jammerIds: readonly string[],
  sensorIds: readonly string[] = [],
): ScenarioUiExtensionsInspection {
  const errors: ValidationIssue[] = []
  if (!isClosedObject(value, UI_EXTENSION_KEYS) || !Array.isArray(value.jammers) || !Array.isArray(value.sensors)) {
    addError(errors, 'UI_EXTENSIONS_SHAPE_INVALID', '场景界面扩展结构不正确。', 'uiExtensions')
    return { result: { valid: false, errors, warnings: [] } }
  }

  value.jammers.forEach((extension, index) => {
    const path = `uiExtensions.jammers[${index}]`
    if (!isClosedObject(extension, JAMMER_UI_EXTENSION_KEYS)) {
      addError(errors, 'JAMMER_UI_EXTENSION_SHAPE_INVALID', '干扰设备界面扩展结构不正确。', path)
      return
    }
    if (typeof extension.jammerId !== 'string' || extension.jammerId.trim() === '') addError(errors, 'JAMMER_UI_EXTENSION_ID_INVALID', '干扰设备扩展 ID 为必填项。', `${path}.jammerId`)
    if (!isFiniteNumber(extension.direction, 0, 360)) addError(errors, 'JAMMER_UI_EXTENSION_DIRECTION_INVALID', '干扰方向必须在 0 至 360 度之间。', `${path}.direction`)
    if (!isFiniteNumber(extension.duration, 0)) addError(errors, 'JAMMER_UI_EXTENSION_DURATION_INVALID', '干扰持续时间不能小于 0 秒。', `${path}.duration`)
    if (typeof extension.enabled !== 'boolean') addError(errors, 'JAMMER_UI_EXTENSION_ENABLED_INVALID', '干扰设备启用开关格式不正确。', `${path}.enabled`)
  })

  const extensionIds = value.jammers.flatMap((extension) => (
    typeof extension === 'object' && extension !== null && typeof extension.jammerId === 'string'
      ? [extension.jammerId]
      : []
  ))
  if (new Set(extensionIds).size !== extensionIds.length) addError(errors, 'JAMMER_UI_EXTENSION_ID_DUPLICATED', '干扰设备扩展 ID 不允许重复。', 'uiExtensions.jammers')
  const canonicalIds = new Set(jammerIds)
  if (extensionIds.length !== jammerIds.length || extensionIds.some((id) => !canonicalIds.has(id))) {
    addError(errors, 'JAMMER_UI_EXTENSION_IDS_MISMATCH', '干扰设备与界面扩展必须按 ID 一一对应。', 'uiExtensions.jammers')
  }

  value.sensors.forEach((extension, index) => {
    const path = `uiExtensions.sensors[${index}]`
    if (!isClosedObject(extension, SENSOR_UI_EXTENSION_KEYS)) {
      addError(errors, 'SENSOR_UI_EXTENSION_SHAPE_INVALID', '传感器界面扩展结构不正确。', path)
      return
    }
    if (typeof extension.sensorId !== 'string' || extension.sensorId.trim() === '') addError(errors, 'SENSOR_UI_EXTENSION_ID_INVALID', '传感器扩展 ID 为必填项。', `${path}.sensorId`)
    if (extension.type !== 'ESM') addError(errors, 'SENSOR_UI_EXTENSION_TYPE_INVALID', '传感器扩展类型必须为 ESM。', `${path}.type`)
    if (extension.direction !== 'OMNI' && !isFiniteNumber(extension.direction, 0, 360)) addError(errors, 'SENSOR_UI_EXTENSION_DIRECTION_INVALID', '传感器方向必须为全向或 0 至 360 度。', `${path}.direction`)
    if (!isFiniteNumber(extension.probability, 0, 1)) addError(errors, 'SENSOR_UI_EXTENSION_PROBABILITY_INVALID', '传感器侦测概率必须在 0 至 1 之间。', `${path}.probability`)
    if (typeof extension.enabled !== 'boolean') addError(errors, 'SENSOR_UI_EXTENSION_ENABLED_INVALID', '传感器启用开关格式不正确。', `${path}.enabled`)
  })

  const sensorExtensionIds = value.sensors.flatMap((extension) => (
    typeof extension === 'object' && extension !== null && typeof extension.sensorId === 'string'
      ? [extension.sensorId]
      : []
  ))
  if (new Set(sensorExtensionIds).size !== sensorExtensionIds.length) addError(errors, 'SENSOR_UI_EXTENSION_ID_DUPLICATED', '传感器扩展 ID 不允许重复。', 'uiExtensions.sensors')
  const canonicalSensorIds = new Set(sensorIds)
  if (sensorExtensionIds.length !== sensorIds.length || sensorExtensionIds.some((id) => !canonicalSensorIds.has(id))) {
    addError(errors, 'SENSOR_UI_EXTENSION_IDS_MISMATCH', '传感器与界面扩展必须按 ID 一一对应。', 'uiExtensions.sensors')
  }

  const result: ValidationResult = { valid: errors.length === 0, errors, warnings: [] }
  return result.valid
    ? { result, jammers: value.jammers as JammerUiExtension[], sensors: value.sensors as SensorUiExtension[] }
    : { result }
}

/**
 * 校验其他集合中指向平台的引用，防止删除平台后留下悬空关系。
 * @param items 链路、传感器或信息需求集合。
 * @param fields 需要检查的平台 ID 字段。
 * @param platformIds 当前平台 ID 集合。
 * @param collectionPath 集合合同路径。
 * @param errors 接收中文字段错误的集合。
 * @returns 无返回值。
 * @remarks 仅检查已有字符串引用；对应集合的完整字段校验按功能阶段开放。
 */
function inspectPlatformReferences(
  items: unknown,
  fields: readonly string[],
  platformIds: ReadonlySet<string>,
  collectionPath: string,
  errors: ValidationIssue[],
): void {
  if (!Array.isArray(items)) return
  items.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) return
    fields.forEach((field) => {
      const reference = (item as Record<string, unknown>)[field]
      if (typeof reference === 'string' && !platformIds.has(reference)) {
        addError(errors, 'PLATFORM_REFERENCE_NOT_FOUND', '引用的平台不存在。', `${collectionPath}[${index}].${field}`)
      }
      if (Array.isArray(reference) && reference.some((id) => typeof id === 'string' && !platformIds.has(id))) {
        addError(errors, 'PLATFORM_REFERENCE_NOT_FOUND', '引用的平台不存在。', `${collectionPath}[${index}].${field}`)
      }
    })
  })
}

/**
 * 校验场景配置 1.0 的全部规范字段，并读取安全配置对象。
 * @param value 待校验的完整场景配置。
 * @returns 校验结果；通过时额外返回重建后的场景身份对象。
 * @remarks 覆盖平台、链路、干扰器、传感器、输出和信息需求，不修改原始配置。
 */
export function inspectScenarioConfig(value: unknown): ScenarioInspection {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  if (!isClosedObject(value, ROOT_KEYS)) {
    addError(errors, 'SCENARIO_SHAPE_INVALID', '场景配置结构不正确。', 'config')
    return { result: { valid: false, errors, warnings } }
  }
  if (value.schemaVersion !== '1.0') addError(errors, 'SCHEMA_VERSION_INVALID', '配置版本必须为 1.0。', 'schemaVersion')
  if (!Array.isArray(value.platforms) || value.platforms.length === 0) addError(errors, 'PLATFORMS_INVALID', '场景至少需要一个平台。', 'platforms')
  if (!Array.isArray(value.links)) addError(errors, 'LINKS_INVALID', '链路配置格式不正确。', 'links')
  if (!Array.isArray(value.jammers)) addError(errors, 'JAMMERS_INVALID', '干扰设备配置格式不正确。', 'jammers')
  if (!Array.isArray(value.sensors)) addError(errors, 'SENSORS_INVALID', '传感器配置格式不正确。', 'sensors')
  if (typeof value.output !== 'object' || value.output === null || Array.isArray(value.output)) addError(errors, 'OUTPUT_INVALID', '输出配置格式不正确。', 'output')
  if (!Array.isArray(value.informationDemand) || value.informationDemand.length === 0) addError(errors, 'INFORMATION_DEMAND_INVALID', '场景至少需要一项信息需求。', 'informationDemand')

  if (!isClosedObject(value.scenario, SCENARIO_KEYS)) {
    addError(errors, 'SCENARIO_IDENTITY_INVALID', '场景基础信息结构不正确。', 'scenario')
    return { result: { valid: false, errors, warnings } }
  }
  const scenario = value.scenario
  if (typeof scenario.id !== 'string' || !scenario.id.startsWith('SCN-')) addError(errors, 'ID_INVALID', '场景编号必须以 SCN- 开头。', 'scenario.id')
  if (typeof scenario.name !== 'string' || scenario.name.trim().length === 0 || scenario.name.length > 128) addError(errors, 'NAME_INVALID', '场景名称为必填项，且不能超过 128 个字符。', 'scenario.name')
  if (typeof scenario.description !== 'string' || scenario.description.length > 512) addError(errors, 'DESCRIPTION_INVALID', '场景描述不能超过 512 个字符。', 'scenario.description')
  if (!isRfc3339DateTime(scenario.startTime)) addError(errors, 'START_TIME_INVALID', '开始时间必须是有效的 RFC 3339 时间。', 'scenario.startTime')
  if (!isFiniteNumber(scenario.duration, Number.MIN_VALUE)) addError(errors, 'DURATION_INVALID', '仿真时长必须大于 0 秒。', 'scenario.duration')
  if (!isFiniteNumber(scenario.timeStep, Number.MIN_VALUE)) addError(errors, 'TIME_STEP_INVALID', '时间步长必须大于 0 秒。', 'scenario.timeStep')

  if (!isClosedObject(scenario.environment, ENVIRONMENT_KEYS)) {
    addError(errors, 'ENVIRONMENT_INVALID', '环境参数结构不正确。', 'scenario.environment')
    return { result: { valid: false, errors, warnings } }
  }
  const environment = scenario.environment
  if (!isFiniteNumber(environment.seaState, 0)) addError(errors, 'SEA_STATE_INVALID', '海况等级不能小于 0。', 'scenario.environment.seaState')
  if (!isFiniteNumber(environment.temperatureC)) addError(errors, 'TEMPERATURE_INVALID', '温度必须是有效数值。', 'scenario.environment.temperatureC')
  if (!isFiniteNumber(environment.humidityPercent, 0, 100)) addError(errors, 'HUMIDITY_INVALID', '相对湿度必须在 0 至 100 之间。', 'scenario.environment.humidityPercent')
  if (!isFiniteNumber(environment.rainRateMmPerHour, 0)) addError(errors, 'RAIN_RATE_INVALID', '降雨率不能小于 0。', 'scenario.environment.rainRateMmPerHour')
  if (!isFiniteNumber(environment.rainLossDbPerKm, 0)) addError(errors, 'RAIN_LOSS_INVALID', '雨衰不能小于 0。', 'scenario.environment.rainLossDbPerKm')
  if (typeof environment.multipathEnabled !== 'boolean') addError(errors, 'MULTIPATH_INVALID', '多径效应开关格式不正确。', 'scenario.environment.multipathEnabled')
  if (environment.rainLossDbPerKm === 0.07) {
    warnings.push({
      severity: 'WARNING',
      code: 'RAIN_LOSS_DEFAULT_MISMATCH',
      message: '当前雨衰值未匹配设备默认值，生成脚本前需要确认。',
      fieldPath: 'scenario.environment.rainLossDbPerKm',
    })
  }

  if (Array.isArray(value.platforms)) {
    const platformIds = collectIds(value.platforms)
    const linkIds = collectIds(value.links)
    const sensorIds = collectIds(value.sensors)
    const jammerIds = collectIds(value.jammers)
    const businessNodeCount = value.platforms.filter((platform) => (
      typeof platform === 'object' && platform !== null && isBusinessInformationNodeType((platform as { type?: unknown }).type)
    )).length
    const missingBusinessTypes = BUSINESS_INFORMATION_NODE_TYPES.filter((type) => !(value.platforms as unknown[]).some((platform) => (
      typeof platform === 'object' && platform !== null && (platform as { type?: unknown }).type === type
    )))

    if (businessNodeCount === 0) addError(errors, 'MINIMUM_BUSINESS_NODE', '场景至少需要一个业务信息节点。', 'platforms')
    if (businessNodeCount > 50) addError(errors, 'NODE_LIMIT_EXCEEDED', '业务信息节点不能超过 50 个。', 'platforms')
    if (platformIds.size !== value.platforms.length) addError(errors, 'PLATFORM_ID_DUPLICATED', '场景实体 ID 不允许为空或重复。', 'platforms')
    if (missingBusinessTypes.length > 0) {
      warnings.push({
        severity: 'WARNING',
        code: 'CAPABILITY_COVERAGE_NOTICE',
        message: '当前场景未覆盖全部四类业务信息节点，生成脚本前需要确认。',
        fieldPath: 'platforms',
      })
    }

    value.platforms.forEach((platform, index) => {
      const path = `platforms[${index}]`
      if (!isClosedObject(platform, PLATFORM_KEYS)) {
        addError(errors, 'PLATFORM_SHAPE_INVALID', '场景实体结构不正确。', path)
        return
      }
      if (typeof platform.id !== 'string' || platform.id.trim() === '') addError(errors, 'PLATFORM_ID_INVALID', '场景实体 ID 为必填项。', `${path}.id`)
      if (typeof platform.name !== 'string' || platform.name.trim() === '') addError(errors, 'PLATFORM_NAME_INVALID', '场景实体名称为必填项。', `${path}.name`)
      if (typeof platform.type !== 'string' || !(PLATFORM_TYPES as readonly string[]).includes(platform.type)) addError(errors, 'PLATFORM_TYPE_INVALID', '场景实体类型不正确。', `${path}.type`)
      if (typeof platform.category !== 'string' || !(DEPLOYMENT_DOMAINS as readonly string[]).includes(platform.category)) addError(errors, 'PLATFORM_CATEGORY_INVALID', '部署域不正确。', `${path}.category`)
      inspectPosition(platform.initialPosition, `${path}.initialPosition`, false, errors)
      if (!Array.isArray(platform.waypoints)) {
        addError(errors, 'WAYPOINTS_INVALID', '航点必须是数组。', `${path}.waypoints`)
      } else {
        let previousArrivalTime: number | undefined
        platform.waypoints.forEach((waypoint, waypointIndex) => {
          const waypointPath = `${path}.waypoints[${waypointIndex}]`
          inspectPosition(waypoint, waypointPath, true, errors)
          if (typeof waypoint !== 'object' || waypoint === null) return
          const arrivalTime = (waypoint as { arrivalTime?: unknown }).arrivalTime
          if (!isFiniteNumber(arrivalTime, 0)) return
          if (isFiniteNumber(scenario.duration, Number.MIN_VALUE) && arrivalTime > scenario.duration) {
            addError(errors, 'ARRIVAL_TIME_EXCEEDS_DURATION', '航点到达时间不能超过场景仿真时长。', `${waypointPath}.arrivalTime`)
          }
          if (previousArrivalTime !== undefined && arrivalTime <= previousArrivalTime) {
            addError(errors, 'ARRIVAL_TIME_NOT_INCREASING', '航点到达时间必须严格递增。', `${waypointPath}.arrivalTime`)
          }
          previousArrivalTime = arrivalTime
        })
      }
      const platformId = typeof platform.id === 'string' ? platform.id : ''
      inspectReferenceIds(platform.linkIds, linkIds, collectOwnedIds(value.links, platformId, ['sourcePlatformId', 'targetPlatformId']), `${path}.linkIds`, errors)
      inspectReferenceIds(platform.sensorIds, sensorIds, collectOwnedIds(value.sensors, platformId, ['platformId']), `${path}.sensorIds`, errors)
      inspectReferenceIds(platform.jammerIds, jammerIds, collectOwnedIds(value.jammers, platformId, ['platformId']), `${path}.jammerIds`, errors)
    })

    inspectPlatformReferences(value.links, ['sourcePlatformId', 'targetPlatformId'], platformIds, 'links', errors)
    inspectPlatformReferences(value.sensors, ['platformId'], platformIds, 'sensors', errors)
    inspectPlatformReferences(value.informationDemand, ['sourcePlatformId', 'destinationPlatformIds'], platformIds, 'informationDemand', errors)
  }

  if (Array.isArray(value.links)) {
    const linkIds = collectIds(value.links)
    const platformIds = collectIds(value.platforms)
    if (linkIds.size !== value.links.length) addError(errors, 'LINK_ID_DUPLICATED', '链路 ID 不允许为空或重复。', 'links')
    value.links.forEach((link, index) => inspectLink(link, index, platformIds, errors))
  }

  if (Array.isArray(value.jammers)) {
    const jammerIds = collectIds(value.jammers)
    const platformIds = collectIds(value.platforms)
    if (jammerIds.size !== value.jammers.length) addError(errors, 'JAMMER_ID_DUPLICATED', '干扰设备 ID 不允许为空或重复。', 'jammers')
    value.jammers.forEach((jammer, index) => inspectJammer(jammer, index, platformIds, errors))
  }

  if (Array.isArray(value.sensors)) {
    const sensorIds = collectIds(value.sensors)
    const platformIds = collectIds(value.platforms)
    if (sensorIds.size !== value.sensors.length) addError(errors, 'SENSOR_ID_DUPLICATED', '传感器 ID 不允许为空或重复。', 'sensors')
    value.sensors.forEach((sensor, index) => inspectSensor(sensor, index, platformIds, errors))
  }

  inspectOutput(value.output, scenario.timeStep, errors)

  if (Array.isArray(value.informationDemand)) {
    const demandIds = collectIds(value.informationDemand)
    const platformIds = collectIds(value.platforms)
    if (demandIds.size !== value.informationDemand.length) addError(errors, 'INFORMATION_DEMAND_ID_DUPLICATED', '信息需求 ID 不允许为空或重复。', 'informationDemand')
    value.informationDemand.forEach((demand, index) => inspectInformationDemand(demand, index, platformIds, errors))
  }

  const result: ValidationResult = { valid: errors.length === 0, errors, warnings }
  if (!result.valid) return { result }

  return {
    result,
    platforms: value.platforms as Platform[],
    links: value.links as Link[],
    jammers: value.jammers as Jammer[],
    sensors: value.sensors as Sensor[],
    output: value.output as OutputConfig,
    informationDemand: value.informationDemand as InformationDemand[],
    identity: {
      id: scenario.id as ScenarioIdentity['id'],
      name: scenario.name as string,
      description: scenario.description as string,
      startTime: scenario.startTime as string,
      duration: scenario.duration as number,
      timeStep: scenario.timeStep as number,
      environment: {
        seaState: environment.seaState as number,
        temperatureC: environment.temperatureC as number,
        humidityPercent: environment.humidityPercent as number,
        rainRateMmPerHour: environment.rainRateMmPerHour as number,
        rainLossDbPerKm: environment.rainLossDbPerKm as number,
        multipathEnabled: environment.multipathEnabled as boolean,
      },
    },
  }
}

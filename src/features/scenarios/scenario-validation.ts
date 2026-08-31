import type {
  ScenarioIdentity,
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
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

export interface ScenarioInspection {
  result: ValidationResult
  identity?: ScenarioIdentity
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

/**
 * 按公历规则校验 RFC 3339 时间戳。
 * @param value 待校验的时间文本。
 * @returns 文本格式和日历日期均有效时返回 `true`。
 * @remarks 纯算术校验，不读取系统时间。
 */
function isRfc3339DateTime(value: unknown): value is string {
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
 * 校验 P2-1 场景基础信息、环境参数和时序参数，并读取安全的身份对象。
 * @param value 待校验的完整场景配置。
 * @returns 校验结果；通过时额外返回重建后的场景身份对象。
 * @remarks 只覆盖本阶段可编辑字段及完整配置外壳，不修改原始配置。
 */
export function inspectScenarioConfig(value: unknown): ScenarioInspection {
  const errors: ValidationIssue[] = []
  if (!isClosedObject(value, ROOT_KEYS)) {
    addError(errors, 'SCENARIO_SHAPE_INVALID', '场景配置结构不正确。', 'config')
    return { result: { valid: false, errors, warnings: [] } }
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
    return { result: { valid: false, errors, warnings: [] } }
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
    return { result: { valid: false, errors, warnings: [] } }
  }
  const environment = scenario.environment
  if (!isFiniteNumber(environment.seaState, 0)) addError(errors, 'SEA_STATE_INVALID', '海况等级不能小于 0。', 'scenario.environment.seaState')
  if (!isFiniteNumber(environment.temperatureC)) addError(errors, 'TEMPERATURE_INVALID', '温度必须是有效数值。', 'scenario.environment.temperatureC')
  if (!isFiniteNumber(environment.humidityPercent, 0, 100)) addError(errors, 'HUMIDITY_INVALID', '相对湿度必须在 0 至 100 之间。', 'scenario.environment.humidityPercent')
  if (!isFiniteNumber(environment.rainRateMmPerHour, 0)) addError(errors, 'RAIN_RATE_INVALID', '降雨率不能小于 0。', 'scenario.environment.rainRateMmPerHour')
  if (!isFiniteNumber(environment.rainLossDbPerKm, 0)) addError(errors, 'RAIN_LOSS_INVALID', '雨衰不能小于 0。', 'scenario.environment.rainLossDbPerKm')
  if (typeof environment.multipathEnabled !== 'boolean') addError(errors, 'MULTIPATH_INVALID', '多径效应开关格式不正确。', 'scenario.environment.multipathEnabled')

  const result: ValidationResult = { valid: errors.length === 0, errors, warnings: [] }
  if (!result.valid) return { result }

  return {
    result,
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

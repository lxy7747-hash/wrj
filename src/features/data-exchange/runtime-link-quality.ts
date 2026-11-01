import type { ValidationIssue } from '../../contracts/domain-models'
import { LASER_LINK_MODULATION, LINK_MODULATIONS } from '../scenarios/link-calc-defaults'

type RuntimeModulation = (typeof LINK_MODULATIONS)[number] | typeof LASER_LINK_MODULATION

/** 后台原始链路身份；尚未绑定本次运行的场景链路。 */
export interface RuntimeLinkQuality {
  linkId: string
  sourcePlatformId: string
  destinationPlatformId: string
  /** null means a canonical imported record did not claim an engine port binding. */
  sourcePortId: string | null
  destinationPortId: string | null
  distanceMeters: number | null
  losses: {
    freeSpaceLossDb: number | null
    seaMultipathLossDb: number | null
    atmosphericLossDb: number | null
    cloudRainLossDb: number | null
    jammingLossDb: number | null
    totalLossDb: number | null
  }
  quality: {
    /** 保留源 GXB，不据此生成 SNR、状态或滞回结论。 */
    gxbDb: number | null
    /** Native link_calc has no agreed SNR field; canonical file imports may provide it. */
    snrDb: number | null
    ber: number | null
    receivedPowerDbm: number | null
    /** 尚无已确认的引擎字段映射；null 不得被干扰损耗或干扰源数量替代。 */
    interferencePowerDbm: number | null
    modelVersion: string | null
    modulation: RuntimeModulation | null
    inputTrace: {
      eirpDbw: number | null
      gOverTDbK: number | null
      dataRateMbps: number | null
      /** null 表示未提供，空数组才表示源明确未列出干扰源。 */
      jammerIds: string[] | null
    }
  }
}

export interface RuntimeLinkQualityData {
  modelVersion: string | null
  modulation: RuntimeModulation | null
  links: RuntimeLinkQuality[]
}

export type RuntimeLinkQualityResult =
  | { data: RuntimeLinkQualityData; errors: [] }
  | { data: null; errors: ValidationIssue[] }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 只适配已解析的 link_calc 子对象；不解析示例 TXT，不校验外壳、时间、运行归属或 status。
 * 缺测量为 null，任何非法质量字段均拒绝整个结果；不构造旧固定证据或规范状态。
 */
export function adaptRuntimeLinkQuality(value: unknown): RuntimeLinkQualityResult {
  const errors: ValidationIssue[] = []
  const fail = (code: string, fieldPath: string, message: string) => {
    errors.push({ severity: 'ERROR', code, fieldPath, message })
  }
  const object = (input: unknown, path: string): Record<string, unknown> => {
    if (input === undefined || input === null) return {}
    if (isObject(input)) return input
    fail('RUNTIME_QUALITY_TYPE_INVALID', path, '此字段必须为对象，缺少数据时请省略或使用 null。')
    return {}
  }
  const text = (input: unknown, path: string, required = false): string | null => {
    if (!required && (input === undefined || input === null)) return null
    if (typeof input === 'string' && input.trim()) return input
    fail(required ? 'RUNTIME_QUALITY_IDENTITY_REQUIRED' : 'RUNTIME_QUALITY_TYPE_INVALID', path,
      required ? '链路、平台及端口标识必须为非空字符串。' : '此字段必须为非空字符串，缺少数据时请省略或使用 null。')
    return null
  }
  const number = (input: unknown, path: string, options: { min?: number; max?: number; convert?: (value: number) => number } = {}): number | null => {
    if (input === undefined || input === null) return null
    if (typeof input !== 'number' || !Number.isFinite(input)) {
      fail('RUNTIME_QUALITY_TYPE_INVALID', path, '此字段必须为有限数值，不能使用字符串或空白代替。')
      return null
    }
    const converted = options.convert ? options.convert(input) : input
    if (input < (options.min ?? -Infinity) || input > (options.max ?? Infinity) || !Number.isFinite(converted)) {
      fail('RUNTIME_QUALITY_VALUE_INVALID', path, '数值超出允许范围，或单位转换后的结果不是有限数值。')
      return null
    }
    return converted
  }
  const modulation = (input: unknown, path: string): RuntimeModulation | null => {
    const result = text(input, path)
    if (result === null) return null
    if ([...LINK_MODULATIONS, LASER_LINK_MODULATION].some(mode => mode === result)) return result as RuntimeModulation
    fail('RUNTIME_QUALITY_UNSUPPORTED_MODULATION', path, '当前只支持 BPSK、QPSK 或 OOK，不会自动替换调制方式。')
    return null
  }
  if (!isObject(value)) {
    fail('RUNTIME_QUALITY_TYPE_INVALID', 'link_calc', '链路计算数据必须为对象。')
    return { data: null, errors }
  }
  if (!Array.isArray(value.links)) {
    fail('RUNTIME_QUALITY_TYPE_INVALID', 'link_calc.links', '链路质量集合必须为数组，暂无链路时请使用空数组。')
    return { data: null, errors }
  }
  if (value.invalid_param_errors !== undefined && value.invalid_param_errors !== null) {
    if (!Array.isArray(value.invalid_param_errors)) {
      fail('RUNTIME_QUALITY_TYPE_INVALID', 'link_calc.invalid_param_errors', '参数错误集合必须为数组。')
    } else if (value.invalid_param_errors.length) {
      // 聚合错误元素尚无正式结构，只拒绝成功投影，不猜测其字段路径或上游错误码。
      fail('RUNTIME_QUALITY_ENGINE_ERROR', 'link_calc.invalid_param_errors', '后台报告参数错误；详细错误结构尚未约定，本次不接收质量结果。')
    }
  }
  const data: RuntimeLinkQualityData = {
    modelVersion: text(value.model_version, 'link_calc.model_version'),
    modulation: modulation(value.modulation, 'link_calc.modulation'),
    links: [],
  }
  const identities = new Set<string>()
  for (const [index, input] of value.links.entries()) {
    const path = `link_calc.links[${index}]`
    if (!isObject(input)) {
      fail('RUNTIME_QUALITY_TYPE_INVALID', path, '每条链路质量必须为对象。')
      continue
    }
    const linkId = text(input.link_id, `${path}.link_id`, true)
    const sourcePlatformId = text(input.tx_platform, `${path}.tx_platform`, true)
    const destinationPlatformId = text(input.rx_platform, `${path}.rx_platform`, true)
    const sourcePortId = text(input.tx_port, `${path}.tx_port`, true)
    const destinationPortId = text(input.rx_port, `${path}.rx_port`, true)
    if (linkId === null || sourcePlatformId === null || destinationPlatformId === null || sourcePortId === null || destinationPortId === null) continue
    // 尚未约定 link_id 的全局唯一性；按完整有向设备身份判重，保留反向及同平台其他端口。
    const identity = JSON.stringify([linkId, sourcePlatformId, destinationPlatformId, sourcePortId, destinationPortId])
    if (identities.has(identity)) fail('RUNTIME_QUALITY_DUPLICATE', path, '同一链路及收发设备身份重复。')
    identities.add(identity)
    const losses = object(input.losses, `${path}.losses`)
    const quality = object(input.quality, `${path}.quality`)
    const trace = object(quality.input_trace, `${path}.quality.input_trace`)
    if (quality.error_msg !== undefined && quality.error_msg !== null) {
      if (typeof quality.error_msg !== 'string') {
        fail('RUNTIME_QUALITY_TYPE_INVALID', `${path}.quality.error_msg`, '计算错误信息必须为字符串。')
      } else if (quality.error_msg !== '') {
        fail('RUNTIME_QUALITY_ENGINE_ERROR', `${path}.quality.error_msg`, `后台报告链路质量计算错误：${quality.error_msg}`)
      }
    }
    let jammerIds: string[] | null = null
    if (trace.jammers !== undefined && trace.jammers !== null) {
      if (!Array.isArray(trace.jammers)) {
        fail('RUNTIME_QUALITY_TYPE_INVALID', `${path}.quality.input_trace.jammers`, '干扰源标识必须为数组。')
      } else {
        jammerIds = []
        for (const [jammerIndex, jammer] of trace.jammers.entries()) {
          const jammerPath = `${path}.quality.input_trace.jammers[${jammerIndex}]`
          const id = text(jammer, jammerPath, true)
          if (id === null) continue
          if (jammerIds.includes(id)) fail('RUNTIME_QUALITY_DUPLICATE', jammerPath, '同一链路的干扰源标识重复。')
          jammerIds.push(id)
        }
      }
    }
    data.links.push({
      linkId, sourcePlatformId, destinationPlatformId, sourcePortId, destinationPortId,
      distanceMeters: number(input.distance_km, `${path}.distance_km`, { min: 0, convert: km => km * 1000 }),
      // dB 分量只校验有限数；资料未约定符号、总量求和规则和误差，不自行增加传播模型判定。
      losses: {
        freeSpaceLossDb: number(losses.free_space_db, `${path}.losses.free_space_db`),
        seaMultipathLossDb: number(losses.sea_multipath_db, `${path}.losses.sea_multipath_db`),
        atmosphericLossDb: number(losses.atmospheric_db, `${path}.losses.atmospheric_db`),
        cloudRainLossDb: number(losses.cloud_rain_db, `${path}.losses.cloud_rain_db`),
        jammingLossDb: number(losses.jamming_loss_db, `${path}.losses.jamming_loss_db`),
        totalLossDb: number(losses.total_composite_db, `${path}.losses.total_composite_db`),
      },
      quality: {
        gxbDb: number(quality.gxb_db, `${path}.quality.gxb_db`),
        snrDb: null,
        ber: number(quality.ber, `${path}.quality.ber`, { min: 0, max: 1 }),
        receivedPowerDbm: number(quality.rx_power_dbw, `${path}.quality.rx_power_dbw`, { convert: dbw => dbw + 30 }),
        interferencePowerDbm: null,
        modelVersion: text(quality.model_version, `${path}.quality.model_version`),
        modulation: modulation(quality.modulation, `${path}.quality.modulation`),
        inputTrace: {
          eirpDbw: number(trace.eirp_dbw, `${path}.quality.input_trace.eirp_dbw`),
          gOverTDbK: number(trace.g_over_t_dbk, `${path}.quality.input_trace.g_over_t_dbk`),
          dataRateMbps: number(trace.data_rate_bps, `${path}.quality.input_trace.data_rate_bps`, { min: 0, convert: bps => bps / 1_000_000 }),
          jammerIds,
        },
      },
    })
  }
  return errors.length ? { data: null, errors } : { data, errors: [] }
}

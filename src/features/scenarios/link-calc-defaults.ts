import type {
  ChannelEncodingScheme, DatalinkBand, Environment, Link, LinkCalcSettings, LinkDirection, LinkType, Platform, Polarization,
} from '../../contracts/domain-models'

/**
 * 《与前端字段确认说明》（2026-10-22）给出的 link_calc 默认值与取值档位。
 * 界面、校验和脚本生成器共用，避免默认值分散在多个组件中。
 */

/** 雨强档位对应的降雨强度（mm/h）。 */
export const RAIN_TIER_RATES = { none: 0, lightRain: 10, moderateRain: 25, heavyRain: 50, stormRain: 100 } as const
export type RainTier = keyof typeof RAIN_TIER_RATES
export const RAIN_TIER_OPTIONS: readonly { value: RainTier; label: string }[] = [
  { value: 'none', label: '无雨（0 mm/h）' }, { value: 'lightRain', label: '小雨（10 mm/h）' },
  { value: 'moderateRain', label: '中雨（25 mm/h）' }, { value: 'heavyRain', label: '大雨（50 mm/h）' },
  { value: 'stormRain', label: '暴雨（100 mm/h）' },
]
/** 降雨强度上限；超过时后端按 100 封顶。 */
export const RAIN_RATE_MAX = 100
export const SEA_STATE_MAX = 9

export const NATURAL_ENVIRONMENT_DEFAULTS = {
  rainEnabled: true, rainAltitudeLimitM: 3000, rainAttenuationDb: 0,
  cloudEnabled: true,
  atmosphereModel: 'itu', simplifiedAttenuationDbPerKm: 0,
  polarizationMismatchDb: 0, pointingErrorDb: 0,
  seaLowAltitudeThresholdM: 100, seaPathOverSeaThresholdKm: 30, seaModel: 'coarse', seaPolarization: 'vertical',
  seaWaterTempC: 20, seaSurfaceRoughnessM: 0,
} as const satisfies Partial<Environment>

export type NaturalEnvironment = Environment & Required<Pick<Environment, keyof typeof NATURAL_ENVIRONMENT_DEFAULTS>>

/** 读取 natural_environment 参数，旧场景缺省字段按文档默认值补齐，返回副本。 */
export function readNaturalEnvironment(environment: Environment): NaturalEnvironment {
  return { ...NATURAL_ENVIRONMENT_DEFAULTS, ...environment } as NaturalEnvironment
}

export const CHANNEL_ENCODING_OPTIONS: readonly { value: ChannelEncodingScheme; label: string }[] = [
  { value: -1, label: '关闭（-1）' },
  { value: 0, label: '无编码（0 dB）' },
  { value: 5, label: '卷积码 1/2（5.0 dB）' },
  { value: 6.5, label: '卷积码 1/3（6.5 dB）' },
  { value: 3.5, label: 'RS 码 255/223（3.5 dB）' },
  { value: 8, label: 'Turbo 码 1/3（8.0 dB）' },
]
export const JAMMING_RANGE_KM = { min: 0, max: 100 } as const
export const LINK_CALC_DEFAULTS: LinkCalcSettings = {
  emergencyThreshold: 1e-5, warningThreshold: 1e-6, valueThresholdBer: 1e-7,
  jammingRangeKm: 30, channelEncodingScheme: 0,
}

/** 读取 link_calc 全局设置；缺省字段按文档默认值补齐，返回副本。 */
export function readLinkCalcSettings(value: Partial<LinkCalcSettings> | undefined): LinkCalcSettings {
  return { ...LINK_CALC_DEFAULTS, ...value }
}

/** 文档未单列激光链路，沿用项目原有的垂直极化口径；微波为水平极化。 */
export function defaultPolarization(type: LinkType): Polarization {
  return type === 'MICROWAVE' ? 'horizontal' : 'vertical'
}

export const RECEIVER_NOISE_FIGURE_DB = 3
export const TIANTONG_NOISE_FIGURE_DB = 2

/** 链路涉及的通信卫星（端点或中继），用于确定天通的固定速率与噪声系数。 */
export function linkSatellite(link: Pick<Link, 'sourcePlatformId' | 'targetPlatformId' | 'relayPlatformId'>, platforms: readonly Platform[]): Platform | undefined {
  return platforms.find(platform => platform.type === 'COMMUNICATION_SATELLITE'
    && [link.sourcePlatformId, link.targetPlatformId, link.relayPlatformId].includes(platform.id))
}

/** 卫星、微波链路的传输速率由文档固定（只显示、不可选）；天通为 16 kbit/s。返回 Mbps，其他类型返回 null。 */
export function fixedLinkDataRate(link: Pick<Link, 'type' | 'sourcePlatformId' | 'targetPlatformId' | 'relayPlatformId'>, platforms: readonly Platform[]): number | null {
  if (link.type === 'MICROWAVE') return 80
  if (link.type !== 'SAT') return null
  return linkSatellite(link, platforms)?.satelliteType === 'TIANTONG' ? 0.016 : 16
}

/** 数传速率档位（Mbps），按波段与方向区分；前向为上行、返向为下行。 */
export function datalinkRateTiers(band: DatalinkBand, direction: LinkDirection): readonly number[] {
  if (band === 'L') return direction === 'FORWARD' ? [0.0064, 0.0128] : [0.0128, 0.0256, 2, 4, 8]
  return direction === 'FORWARD' ? [0.0256, 2, 4] : [0.0512, 2, 4, 8, 16]
}

/** 将 Mbps 档位显示为 kbps 或 Mbps 文本。 */
export function formatDataRate(valueMbps: number): string {
  return valueMbps < 1 ? `${Number((valueMbps * 1000).toPrecision(6))} kbps` : `${valueMbps} Mbps`
}

export const FIBER_DATA_RATE_MBPS = { min: 10, max: 1000 } as const
/** 发射功率上限：卫星链路 1000 W，其余 100 W。 */
export function linkPowerMaxW(type: LinkType): number {
  return type === 'SAT' ? 1000 : 100
}

type LinkParameterDefaults = Pick<Link, 'frequency' | 'bandwidth' | 'rxFrequency' | 'rxBandwidth' | 'txPower' | 'antennaGain' | 'dataRate' | 'txPolarization' | 'rxPolarization'>

/**
 * 文档按链路类型给出的端口默认值（任务机/中继机口径）；频率单位 MHz，速率 Mbps。
 * 噪声系数不写入链路，留给生成器按设备取缺省值（天通 2 dB，其余 3 dB）。
 * 激光链路文档未给出，沿用项目原有新建链路默认值。
 */
export function linkTypeDefaults(type: LinkType, band: DatalinkBand = 'C', direction: LinkDirection = 'FORWARD'): LinkParameterDefaults {
  const polarization = defaultPolarization(type)
  const base = { txPolarization: polarization, rxPolarization: polarization }
  if (type === 'SAT') return { ...base, frequency: 200, rxFrequency: 200, bandwidth: 20, rxBandwidth: 50, txPower: 100, antennaGain: { tx: 25, rx: 25 }, dataRate: 16 }
  if (type === 'MICROWAVE') return { ...base, frequency: 8200, rxFrequency: 8200, bandwidth: 30, rxBandwidth: 50, txPower: 20, antennaGain: { tx: 0, rx: 0 }, dataRate: 80 }
  if (type === 'FIBER') return { ...base, frequency: 1300, rxFrequency: 1300, bandwidth: 20, rxBandwidth: 20, txPower: 50, antennaGain: { tx: 10, rx: 10 }, dataRate: 100 }
  if (type === 'DATALINK') {
    const table = {
      C: { FORWARD: [4500, 10, 20, 2], REVERSE: [4000, 20, 30, 8] },
      L: { FORWARD: [1500, 5, 10, 0.0128], REVERSE: [1300, 10, 15, 0.0128] },
    } as const
    const [frequency, bandwidth, txPower, dataRate] = table[band][direction]
    return { ...base, frequency, rxFrequency: frequency, bandwidth, rxBandwidth: bandwidth, txPower, antennaGain: { tx: 0, rx: 0 }, dataRate }
  }
  return { ...base, frequency: 4500, rxFrequency: 4500, bandwidth: 20, rxBandwidth: 20, txPower: 50, antennaGain: { tx: 10, rx: 10 }, dataRate: 10 }
}

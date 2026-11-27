import type { Link, Platform, ScenarioConfig, ScenarioLinkSettings } from '../../contracts/domain-models'

export const RETIRED_LINK_SETTINGS_KEYS = ['switchRules', 'priority'] as const

/** 只移除旧场景里的废弃设置，保留已经选定的前向和返向热链。 */
export function withoutRetiredLinkSettings<T extends Pick<ScenarioConfig, 'linkSettings'>>(config: T): T {
  const settings = config.linkSettings
  if (!settings || !RETIRED_LINK_SETTINGS_KEYS.some(key => Object.hasOwn(settings, key))) return config
  const linkSettings = { ...settings }
  for (const key of RETIRED_LINK_SETTINGS_KEYS) Reflect.deleteProperty(linkSettings, key)
  return { ...config, linkSettings }
}

export const LINK_PARAMETER_DEFAULTS = {
  enabled: true,
  antennaGainCorrectionDb: 0,
  antiJammingGainDb: 0,
  spatialIsolationDb: 0,
} as const

export const LINK_DECISION_DEFAULTS = {
  switchStableChecks: 3,
  switchCooldownS: 5,
  switchCooldownFrames: 10,
  minimumGxbDb: 6,
  maximumBer: 1e-5,
  minimumGxbImprovementDb: 3,
  minimumBerImprovementFactor: 10,
  minimumSpatialIsolationDb: 0,
} as const

/**
 * 读取链路设置，旧快照缺省时返回独立的默认值，不修改原场景。
 * @param config 当前场景中的平台和可选链路设置。
 * @returns 卫星启用和切换策略的配置副本；保留旧配置的兼容字段。
 */
export function readLinkSettings(config: Pick<ScenarioConfig, 'platforms' | 'linkSettings'>): ScenarioLinkSettings {
  const stored = withoutRetiredLinkSettings(config).linkSettings
  const settings: ScenarioLinkSettings = stored !== undefined ? {
    ...stored,
    ...(stored.enabledTypes === undefined ? {} : { enabledTypes: { ...stored.enabledTypes } }),
    enabledSatellites: { ...stored.enabledSatellites },
    ...(stored.linkCalc === undefined ? {} : { linkCalc: { ...stored.linkCalc } }),
    ...(stored.hotLinks === undefined ? {} : { hotLinks: { ...stored.hotLinks,
      forward: stored.hotLinks.forward.map(chain => [...chain]), reverse: stored.hotLinks.reverse.map(chain => [...chain]) } }),
  } : {
    enabledSatellites: {
      TIANTONG: config.platforms.some((p) => p.type === 'COMMUNICATION_SATELLITE' && p.satelliteType === 'TIANTONG'),
      // 单选默认天通；没有对应实体时不自动创建或启用卫星。
      SHENTONG: false,
    },
    ...LINK_DECISION_DEFAULTS,
  }
  // 旧双选/均未选收敛为默认天通；仅转换合法布尔值的副本，非法输入仍交给校验阻断。
  const { TIANTONG, SHENTONG } = settings.enabledSatellites
  if (typeof TIANTONG === 'boolean' && TIANTONG === SHENTONG) {
    settings.enabledSatellites = {
      TIANTONG: config.platforms.some(p => p.type === 'COMMUNICATION_SATELLITE' && p.satelliteType === 'TIANTONG'),
      SHENTONG: false,
    }
  }
  return { messageIntervalS: 5, ...settings }
}

/**
 * 读取单条链路开关；显式值优先，旧链路兼容历史类型开关，均缺省时启用。
 * @param link 当前链路，不会修改其原始配置。
 * @param settings 可选的历史场景设置，仅用于旧链路缺省值。
 * @returns 本条链路配置的启用状态，不代表通信质量或卫星可用性。
 */
export function readLinkEnabled(link: Link, settings?: ScenarioLinkSettings): boolean {
  return link.enabled ?? settings?.enabledTypes?.[link.type] ?? true
}

/**
 * 判断配置链路是否参与本次场景；不推断实时通信质量。
 * @param link 当前链路。
 * @param settings 当前场景启停设置。
 * @param platforms 当前节点，用于解析中继及端点卫星。
 * @returns 本条链路及涉及的卫星均未停用时返回 true。
 */
export function isConfiguredLinkEnabled(link: Link, settings: ScenarioLinkSettings, platforms: readonly Platform[]): boolean {
  return getLinkExclusionReason(link, settings, platforms) === null
}

/**
 * 读取不参与场景的原因，供列表展示和脚本过滤共同使用，链路自身停用优先。
 * @param link 当前链路。
 * @param settings 已读取的场景设置。
 * @param platforms 节点，用于查找端点或历史中继关联的卫星。
 * @returns null 表示参与，否则返回链路停用或未选中的卫星名称。
 */
export function getLinkExclusionReason(link: Link, settings: ScenarioLinkSettings, platforms: readonly Platform[]): '链路停用' | '天通卫星' | '神通卫星' | null {
  if (!readLinkEnabled(link, settings)) return '链路停用'
  const satellite = platforms.find(p => p.type === 'COMMUNICATION_SATELLITE'
    && [link.sourcePlatformId, link.targetPlatformId, link.relayPlatformId].includes(p.id)
    && p.satelliteType !== undefined && !settings.enabledSatellites[p.satelliteType])
  if (satellite) return satellite.satelliteType === 'TIANTONG' ? '天通卫星' : '神通卫星'
  return null
}

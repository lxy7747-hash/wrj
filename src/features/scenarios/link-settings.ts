import type { Link, Platform, ScenarioConfig, ScenarioLinkSettings } from '../../contracts/domain-models'

export const LINK_PARAMETER_DEFAULTS = {
  enabled: true,
  antennaGainCorrectionDb: 0,
  coding: null,
  antiJammingGainDb: 0,
  spatialIsolationDb: 0,
} as const

/**
 * 读取链路设置，旧快照缺省时返回独立的默认值，不修改原场景。
 * @param config 当前场景中的平台和可选链路设置。
 * @returns 卫星启用和切换策略的配置副本；保留旧配置的兼容字段。
 */
export function readLinkSettings(config: Pick<ScenarioConfig, 'platforms' | 'linkSettings'>): ScenarioLinkSettings {
  if (config.linkSettings !== undefined) return {
    ...config.linkSettings,
    ...(config.linkSettings.enabledTypes === undefined ? {} : { enabledTypes: { ...config.linkSettings.enabledTypes } }),
    enabledSatellites: { ...config.linkSettings.enabledSatellites },
    priority: [...config.linkSettings.priority],
  }
  return {
    enabledSatellites: {
      TIANTONG: config.platforms.some((p) => p.type === 'COMMUNICATION_SATELLITE' && p.satelliteType === 'TIANTONG'),
      // 文档默认选择天通；神通由用户独立启用，已保存的开关在上方原样读取。
      SHENTONG: false,
    },
    switchCooldownS: 5,
    priority: ['DATALINK', 'MICROWAVE', 'SAT', 'LASER'],
  }
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
 * @param platforms 当前场景实体，用于解析中继及端点卫星。
 * @returns 本条链路及涉及的卫星均未停用时返回 true。
 */
export function isConfiguredLinkEnabled(link: Link, settings: ScenarioLinkSettings, platforms: readonly Platform[]): boolean {
  if (!readLinkEnabled(link, settings)) return false
  return platforms.filter((p) => p.type === 'COMMUNICATION_SATELLITE'
    && [link.sourcePlatformId, link.targetPlatformId, link.relayPlatformId].includes(p.id))
    .every((p) => p.satelliteType === undefined || settings.enabledSatellites[p.satelliteType])
}

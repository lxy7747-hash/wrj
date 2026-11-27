import type { Jammer, ScenarioConfig } from '../../contracts/domain-models'
import { withoutRetiredLinkSettings } from '../scenarios/link-settings'
import { LINK_TYPES } from '../scenarios/scenario-validation'

export type ReplayMapConfig = Pick<ScenarioConfig, 'platforms' | 'links' | 'linkSettings'> & {
  scenario: Pick<ScenarioConfig['scenario'], 'id' | 'environment'>
  jammers: Array<Pick<Jammer, 'id' | 'platformId' | 'jammingRange'> & { detectionRange?: number }>
}

/** 结果只留存历史地图和链路详情需要的配置。 */
export function snapshotReplayMap(config: ScenarioConfig): ReplayMapConfig {
  const { scenario, platforms, links, linkSettings, jammers } = withoutRetiredLinkSettings(config)
  return structuredClone({
    scenario: { id: scenario.id, environment: scenario.environment }, platforms, links,
    ...(linkSettings && { linkSettings }),
    jammers: jammers.map(({ id, platformId, jammingRange, detectionRange }) => ({ id, platformId, jammingRange, detectionRange })),
  })
}

export function isReplayMapConfig(value: unknown, scenarioId: string): value is ReplayMapConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const { scenario, platforms, links, jammers, linkSettings } = value as Partial<ReplayMapConfig>
  if (scenario?.id !== scenarioId || !scenario.environment || typeof scenario.environment !== 'object' || Array.isArray(scenario.environment)) return false
  const polygon = scenario.environment.seaPolygon
  if (polygon !== undefined && !(Array.isArray(polygon) && polygon.every(p => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)))) return false
  if (linkSettings !== undefined && (!linkSettings
    || typeof linkSettings.enabledSatellites?.TIANTONG !== 'boolean' || typeof linkSettings.enabledSatellites?.SHENTONG !== 'boolean'
    || (linkSettings.hotLinks !== undefined && ![linkSettings.hotLinks?.forward, linkSettings.hotLinks?.reverse]
      .every(paths => Array.isArray(paths) && paths.every(Array.isArray))))) return false
  return Array.isArray(platforms) && platforms.every(p => p && typeof p.id === 'string' && p.id.length > 0
    && typeof p.name === 'string' && typeof p.type === 'string'
    && [p.initialPosition?.longitude, p.initialPosition?.latitude, p.initialPosition?.altitude].every(Number.isFinite))
    && Array.isArray(links) && links.every(l => l && LINK_TYPES.includes(l.type)
      && [l.id, l.sourcePlatformId, l.targetPlatformId].every(id => typeof id === 'string' && id.length > 0))
    && Array.isArray(jammers) && jammers.every(j => j && typeof j.id === 'string' && typeof j.platformId === 'string'
      && Number.isFinite(j.jammingRange) && (j.detectionRange === undefined || Number.isFinite(j.detectionRange)))
}

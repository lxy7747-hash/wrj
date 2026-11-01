import type { InformationDemand, Link, ScenarioConfig } from '../../contracts/domain-models'
import { toRaw } from 'vue'

/** 编辑副本可含嵌套 Vue 代理和未填的 NaN，不能用 JSON 序列化改变草稿值。 */
export function copyScenarioEdit<T>(value: T): T {
  const raw = toRaw(value)
  if (Array.isArray(raw)) return raw.map(item => copyScenarioEdit(item)) as T
  if (raw !== null && typeof raw === 'object') {
    return Object.fromEntries(Object.entries(raw).map(([key, item]) => [key, copyScenarioEdit(item)])) as T
  }
  return raw
}

export function synchronizePlatformLinkIds(config: ScenarioConfig, linkId: string): void {
  for (const platform of config.platforms) platform.linkIds = platform.linkIds.filter(id => id !== linkId)
  const link = config.links.find(item => item.id === linkId)
  if (!link) return
  for (const id of new Set([link.sourcePlatformId, link.targetPlatformId, link.relayPlatformId])) {
    config.platforms.find(platform => platform.id === id)?.linkIds.push(linkId)
  }
}

/** 同一链路编辑用于服务端候选和本地合并，避免覆盖其他草稿内容。 */
export function applyLinkEdit(config: ScenarioConfig, link: Link, demand: InformationDemand, previousLinkId = link.id): void {
  const index = config.links.findIndex(item => item.id === previousLinkId)
  if (index < 0) config.links.push(structuredClone(link))
  else config.links[index] = structuredClone(link)
  const demandIndex = config.informationDemand.findIndex(item => item.id === demand.id)
  const previous = config.informationDemand[demandIndex]
  if (previous?.linkId && previous.linkId !== previousLinkId && previous.linkId !== link.id) throw new Error('该业务已关联其他链路。')
  const edited = { ...structuredClone(demand), linkId: link.id, sourcePlatformId: link.sourcePlatformId,
    destinationPlatformIds: [link.targetPlatformId], direction: link.direction }
  if (demandIndex < 0) config.informationDemand.push(edited)
  else config.informationDemand[demandIndex] = edited
  if (previousLinkId !== link.id) synchronizePlatformLinkIds(config, previousLinkId)
  synchronizePlatformLinkIds(config, link.id)
}

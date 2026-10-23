import type { HotLinkSettings, Link, LinkDirection, LinkType } from '../../contracts/domain-models'

/**
 * 热链配置（全局）：每条热链是首尾相接的链路编号序列，后一条链路的源平台必须是前一条的目标平台。
 * 生成器据此逐跳写出 {platform, inPort, outPort}，端口即各链路在该平台上的通信设备。
 */

/** 热链终点可选的平台类型及其参考模型名；end_platform_type 写参考模型名（已确认）。 */
export const HOT_LINK_END_PLATFORM_TYPES = ['REAR_COMMAND_NODE', 'GROUND_CLUSTER_COMMAND_NODE', 'AIRBORNE_MISSION_CLUSTER'] as const
export const HOT_LINK_END_REFERENCE_MODELS: Record<HotLinkSettings['endPlatformType'], string> = {
  REAR_COMMAND_NODE: 'REAR_COMM_PLATFORM',
  GROUND_CLUSTER_COMMAND_NODE: 'COMMAND_VEHICLE_PLATFORM',
  AIRBORNE_MISSION_CLUSTER: 'MISSION_UAV_PLATFORM',
}
export const HOT_LINK_DEFAULT_END_PLATFORM_TYPE: HotLinkSettings['endPlatformType'] = 'REAR_COMMAND_NODE'

type ChainLink = Pick<Link, 'id' | 'type' | 'sourcePlatformId' | 'targetPlatformId' | 'direction'>

/**
 * 检查一条热链是否首尾相接；返回中文错误原因，合法时返回 null。
 * @param chain 链路编号序列。
 * @param links 场景链路。
 * @param direction 热链所在列表的方向，链路方向必须一致。
 */
export function hotLinkChainError(chain: readonly string[], links: readonly ChainLink[], direction: LinkDirection): string | null {
  if (chain.length === 0) return '热链至少需要一条链路。'
  if (new Set(chain).size !== chain.length) return '同一条热链不能重复使用链路。'
  let previous: ChainLink | undefined
  for (const id of chain) {
    const link = links.find(item => item.id === id)
    if (link === undefined) return `热链引用的链路 ${id} 不存在。`
    if (link.direction !== direction) return `链路 ${id} 的方向与热链方向不一致。`
    if (previous !== undefined && previous.targetPlatformId !== link.sourcePlatformId) return `链路 ${id} 的源平台与上一跳的目标平台不相接。`
    previous = link
  }
  return null
}

/**
 * 按已启用链路自动串联热链：从没有上游的链路出发，沿“目标平台 = 下一条源平台”延伸，
 * 有多条可走时按链路优先级、再按编号取第一条；未被覆盖的链路各自起头，保证每条链路至少出现一次。
 */
export function autoHotLinkChains(links: readonly ChainLink[], direction: LinkDirection, priority: readonly LinkType[]): string[][] {
  const candidates = links.filter(link => link.direction === direction)
  const rank = (link: ChainLink) => { const index = priority.indexOf(link.type); return index < 0 ? priority.length : index }
  const ordered = [...candidates].sort((left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id))
  const extend = (start: ChainLink): string[] => {
    const chain = [start]
    for (;;) {
      const last = chain.at(-1)!
      const next = ordered.find(link => link.sourcePlatformId === last.targetPlatformId && !chain.includes(link))
      if (next === undefined) return chain.map(link => link.id)
      chain.push(next)
    }
  }
  const starts = ordered.filter(link => !candidates.some(other => other !== link && other.targetPlatformId === link.sourcePlatformId))
  const chains = starts.map(extend)
  for (const link of ordered) {
    if (!chains.some(chain => chain.includes(link.id))) chains.push(extend(link))
  }
  return chains
}

/**
 * 读取热链配置；场景未自定义时按已启用链路自动串联，返回副本。
 * @param value 场景中的热链设置。
 * @param enabledLinks 参与本次场景的链路。
 * @param priority 链路优先级，用于自动串联时的分支选择。
 */
export function readHotLinks(value: HotLinkSettings | undefined, enabledLinks: readonly ChainLink[], priority: readonly LinkType[]): HotLinkSettings {
  if (value !== undefined) return { forward: value.forward.map(chain => [...chain]), reverse: value.reverse.map(chain => [...chain]), endPlatformType: value.endPlatformType }
  return {
    forward: autoHotLinkChains(enabledLinks, 'FORWARD', priority),
    reverse: autoHotLinkChains(enabledLinks, 'REVERSE', priority),
    endPlatformType: HOT_LINK_DEFAULT_END_PLATFORM_TYPE,
  }
}

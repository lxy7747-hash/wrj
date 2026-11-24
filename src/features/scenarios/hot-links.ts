import type { HotLinkSettings, Link, LinkDirection } from '../../contracts/domain-models'

/**
 * 热链配置（全局）：每条热链是首尾相接的链路编号序列，后一条链路的源节点必须是前一条的目标节点。
 * 热链只来自场景中的显式配置，不按链路自动生成；生成器据此逐跳写出 {platform, inPort, outPort}，
 * 端口即各链路在该平台上的通信设备。
 */

type ChainLink = Pick<Link, 'id' | 'type' | 'sourcePlatformId' | 'targetPlatformId' | 'direction'>

/** 可选的中文名解析器；不传时回退为编号，保持共享校验/生成器原有提示。 */
export type HotLinkLabelers = { link?: (id: string) => string; platform?: (id: string) => string }

/**
 * 检查一条热链是否首尾相接；返回中文错误原因，合法时返回 null。
 * @param chain 链路编号序列。
 * @param links 场景链路。
 * @param direction 热链所在列表的方向，链路方向必须一致。
 * @param labelers 可选的中文名解析器，界面用于把编号换成平台名/链路名。
 */
export function hotLinkChainError(chain: readonly string[], links: readonly ChainLink[], direction: LinkDirection, labelers?: HotLinkLabelers): string | null {
  const linkName = (id: string) => labelers?.link?.(id) ?? id
  const platformName = (id: string) => labelers?.platform?.(id) ?? id
  if (chain.length === 0) return '热链至少需要一条链路。'
  if (new Set(chain).size !== chain.length) return '同一条热链不能重复使用链路。'
  let previous: ChainLink | undefined
  for (const id of chain) {
    const link = links.find(item => item.id === id)
    if (link === undefined) return `热链引用的链路 ${linkName(id)} 不存在。`
    if (link.direction !== direction) return `链路 ${linkName(id)} 的方向与热链方向不一致。`
    if (previous !== undefined && previous.targetPlatformId !== link.sourcePlatformId) {
      return `链路 ${linkName(id)} 的源节点 ${platformName(link.sourcePlatformId)} 与上一跳的目标节点 ${platformName(previous.targetPlatformId)} 不相接。`
    }
    previous = link
  }
  return null
}

/**
 * 读取热链配置；未配置时返回空配置（由用户显式添加热链），返回值始终是副本。
 * @param value 场景中的热链设置。
 */
export function readHotLinks(value?: HotLinkSettings): HotLinkSettings {
  if (value !== undefined) return { forward: value.forward.map(chain => [...chain]), reverse: value.reverse.map(chain => [...chain]) }
  return { forward: [], reverse: [] }
}

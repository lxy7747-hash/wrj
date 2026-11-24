import { describe, expect, it } from 'vitest'
import type { Link } from '../../src/contracts/domain-models'
import { hotLinkChainError, readHotLinks } from '../../src/features/scenarios/hot-links'

type ChainLink = Pick<Link, 'id' | 'type' | 'sourcePlatformId' | 'targetPlatformId' | 'direction'>
const link = (id: string, type: Link['type'], source: string, target: string, direction: Link['direction'] = 'REVERSE'): ChainLink =>
  ({ id, type, sourcePlatformId: source, targetPlatformId: target, direction })

describe('热链配置（全局）', () => {
  // 文档示例：任务机 →（C 下行）→ 指挥车 →（光纤）→ 后方车。
  const links = [
    link('DL-1', 'DATALINK', 'UAV-01', 'CMD-01'), link('DL-2', 'DATALINK', 'UAV-02', 'CMD-01'),
    link('FB-1', 'FIBER', 'CMD-01', 'REAR-01'), link('UP-1', 'DATALINK', 'CMD-01', 'UAV-01', 'FORWARD'),
  ]

  it('校验首尾相接、方向一致、引用存在且不重复', () => {
    expect(hotLinkChainError(['DL-1', 'FB-1'], links, 'REVERSE')).toBeNull()
    expect(hotLinkChainError([], links, 'REVERSE')).toContain('至少需要一条')
    expect(hotLinkChainError(['FB-1', 'DL-1'], links, 'REVERSE')).toContain('不相接')
    expect(hotLinkChainError(['UP-1'], links, 'REVERSE')).toContain('方向')
    expect(hotLinkChainError(['NONE'], links, 'REVERSE')).toContain('不存在')
    expect(hotLinkChainError(['DL-1', 'DL-1'], links, 'REVERSE')).toContain('重复')
  })

  it('未配置时返回空热链；已配置时原样返回副本', () => {
    expect(readHotLinks(undefined)).toEqual({ forward: [], reverse: [] })
    const custom = { forward: [['UP-1']], reverse: [['DL-2', 'FB-1']] }
    const read = readHotLinks(custom)
    expect(read).toEqual(custom)
    read.reverse[0]!.push('X')
    expect(custom.reverse[0]).toEqual(['DL-2', 'FB-1'])
  })
})

// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { MissionResultParameters } from '../../src/features/results/mission-result'
import { compareRunParameters } from '../../src/features/reports/run-parameter-diff'

const link = { id: 'LINK-A', type: 'FIBER', frequencyMHz: 0, bandwidthMHz: 1, txPowerW: 0 }
const jammer = { id: 'DEVICE-A', frequencyMHz: 1, bandwidthMHz: 1, defaultPowerW: 0 }
const snapshot: MissionResultParameters = {
  scenarioId: 'SCN-FIXTURE', revision: 1, platformCount: 1, linkCount: 2, jammerCount: 1,
  links: [link, { ...link, id: 'LINK-B' }], jammers: [jammer],
}

describe('归档运行参数对比', () => {
  it('按编号对齐完整字段，顺序和快照元数据变化不影响差异状态', () => {
    const rows = compareRunParameters(snapshot, {
      ...snapshot, revision: 2, source: 'PROJECT_REFERENCE', links: [...snapshot.links].reverse(),
    })

    expect(rows).toHaveLength(14)
    expect(rows.every(row => !row.changed && row.reference === row.current)).toBe(true)
    expect(rows.find(row => row.id === 'LINK-A' && row.field === '频率')).toMatchObject({
      index: 1, reference: '0 MHz', current: '0 MHz',
    })
    expect(rows.find(row => row.group === '场景' && row.field === '链路数')).toMatchObject({
      reference: '2', current: '2', changed: false,
    })
  })

  it('保留未变字段和零值，标记实际变化并安全显示历史类型', () => {
    const rows = compareRunParameters(snapshot, {
      ...snapshot, links: [snapshot.links[1]!, { ...link, type: 'constructor', bandwidthMHz: 2, txPowerW: 1 }],
      jammers: [{ ...jammer, frequencyMHz: 0, defaultPowerW: 2 }],
    })

    expect(rows).toHaveLength(14)
    expect(rows.filter(row => row.changed)).toMatchObject([
      { group: '链路', id: 'LINK-A', type: 'constructor', index: 1, field: '链路类型', reference: '光纤链路', current: 'constructor' },
      { group: '链路', id: 'LINK-A', field: '带宽', reference: '1 MHz', current: '2 MHz' },
      { group: '链路', id: 'LINK-A', field: '发射功率', reference: '0 W', current: '1 W' },
      { group: '干扰机', id: 'DEVICE-A', field: '频率', reference: '1 MHz', current: '0 MHz' },
      { group: '干扰机', id: 'DEVICE-A', field: '默认功率', reference: '0 W', current: '2 W' },
    ])
  })

  it('为增减的对象逐项显示实际值，缺失的一侧标为未记录', () => {
    const rows = compareRunParameters(snapshot, {
      ...snapshot, platformCount: 2, linkCount: 1, links: [{ ...link, id: 'LINK-C' }], jammerCount: 0, jammers: [],
    })

    expect(rows.filter(row => row.group === '场景')).toMatchObject([
      { field: '节点数', reference: '1', current: '2', changed: true },
      { field: '链路数', reference: '2', current: '1', changed: true },
      { field: '干扰机数', reference: '1', current: '0', changed: true },
    ])
    expect(rows.filter(row => row.id === 'LINK-C')).toMatchObject([
      { field: '链路类型', reference: '未记录', current: '光纤链路', changed: true },
      { field: '频率', reference: '未记录', current: '0 MHz', changed: true },
      { field: '带宽', reference: '未记录', current: '1 MHz', changed: true },
      { field: '发射功率', reference: '未记录', current: '0 W', changed: true },
    ])
    expect(rows.filter(row => row.id === 'DEVICE-A')).toMatchObject([
      { field: '频率', reference: '1 MHz', current: '未记录', changed: true },
      { field: '带宽', reference: '1 MHz', current: '未记录', changed: true },
      { field: '默认功率', reference: '0 W', current: '未记录', changed: true },
    ])
    expect(rows.filter(row => row.id === 'LINK-A' || row.id === 'LINK-B')).toHaveLength(8)
    expect(rows.filter(row => row.group !== '场景').every(row => row.changed && (row.reference === '未记录' || row.current === '未记录'))).toBe(true)
    expect(new Set(rows.map(({ key }) => key)).size).toBe(rows.length)
  })
})

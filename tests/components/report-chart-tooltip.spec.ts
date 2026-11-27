import { describe, expect, it } from 'vitest'
import { buildLineChartPoints, formatChartMinutesSeconds, formatLineChartTooltip } from '../../src/features/reports/chart-tooltip'

describe('评估报表折线图悬浮提示与断点处理', () => {
  it('将横轴秒数格式化为 XX分xx秒（支持小数秒）', () => {
    expect(formatChartMinutesSeconds(0)).toBe('00分00秒')
    expect(formatChartMinutesSeconds(9)).toBe('00分09秒')
    expect(formatChartMinutesSeconds(65)).toBe('01分05秒')
    expect(formatChartMinutesSeconds(1324)).toBe('22分04秒')
    expect(formatChartMinutesSeconds(65.5)).toBe('01分05.5秒')
  })

  it('断点 null 占位插入在相邻采样中点，避免与真实数据点重合', () => {
    const points = buildLineChartPoints([
      { time: 10, value: 0 },
      { time: 20, value: 5 },
      { time: 50, value: 5, breakBefore: true },
    ])
    expect(points).toEqual([
      [10, 0],
      [20, 5],
      [35, null],
      { value: [50, 5], symbol: 'circle', symbolSize: 6 },
    ])
  })

  it('悬浮提示按 XX分xx秒显示时间并过滤 null 占位，不出现 null 秒', () => {
    const mixed = formatLineChartTooltip([
      { axisValue: 1324, value: [1324, null], marker: '<span>•</span>', seriesName: 'series0' },
      { axisValue: 1324, value: [1324, 18], marker: '<span>•</span>', seriesName: 'series0' },
    ], '秒')
    expect(mixed).toContain('22分04秒')
    expect(mixed).toContain('18 秒')
    expect(mixed).not.toContain('null')

    // 悬停在纯断档空隙（仅 null 占位）时返回空字符串隐藏提示框
    const gapOnly = formatLineChartTooltip([
      { axisValue: 35, value: [35, null], marker: '<span>•</span>', seriesName: 'series0' },
    ], '秒')
    expect(gapOnly).toBe('')
  })
})

import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'
import ReportChart from '../../src/components/reports/ReportChart.vue'

type Row = { label: string; time: number; value: number; breakBefore?: boolean }
const points = (count: number, value: (index: number) => number, breakBefore?: (index: number) => boolean): Row[] =>
  Array.from({ length: count }, (_, index) => ({ label: String(index), time: index, value: value(index), ...(breakBefore?.(index) ? { breakBefore: true } : {}) }))

const draw = (rows: Row[]) => mount(ReportChart, { props: { title: 't', unit: 'dB', line: true, rows }, global: { plugins: [ElementPlus] } })
const segments = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('.line-chart-segment')
const circlesPerSegment = (wrapper: ReturnType<typeof mount>) => segments(wrapper).map(segment => segment.findAll('circle').length)
const polylineLengths = (scope: any) =>
  (scope.findAll('polyline') as Array<{ attributes(name: string): string | undefined }>).map(polyline => (polyline.attributes('points') ?? '').trim().split(/\s+/).filter(Boolean).length)
/** 精确解析每个 li 的数值，避免 includes('100') 误命中 -100。 */
const liValues = (scope: any) =>
  (scope.findAll('li') as Array<{ text(): string }>).map(item => {
    const match = item.text().match(/：\s*(-?\d+(?:\.\d+)?)/)
    return match ? Number(match[1]) : Number.NaN
  })
const circleCx = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('circle').map(circle => circle.attributes('cx'))
/** 从 SVG circle 的 title 精确解析数值，验证每个点可追溯。 */
const circleTitleValues = (scope: any) =>
  (scope.findAll('circle') as Array<{ find(selector: string): { exists(): boolean; text(): string } }>).map(circle => {
    const title = circle.find('title')
    const match = (title.exists() ? title.text() : '').match(/：\s*(-?\d+(?:\.\d+)?)/)
    return match ? Number(match[1]) : Number.NaN
  })
/** 依据“真实断点”计算应有折线段分组（用于验证实际 polyline 不跨断点）。 */
function expectedGroups(values: number[]): number[][] {
  const groups: number[][] = []
  let current: number[] = []
  for (const value of values) {
    if (value % 2 === 1 && current.length) { groups.push(current); current = [] }
    current.push(value)
  }
  if (current.length) groups.push(current)
  return groups
}

describe('R4 ReportChart 折线有界分段（真实组件 SVG）', () => {
  it.each([0, 1, 2, 3])('雷达有 %i 条有效链路：少维度展示真实数值，只有零条才为空', count => {
    const rows = [{ label: 'L-1', value: 100 }, { label: 'L-2', value: 0 }, { label: 'L-3', value: 50 }].slice(0, count)
    const wrapper = mount(ReportChart, { props: { title: '连通率', unit: '%', radar: true, rows: [...rows, { label: '缺失', value: NaN }] }, global: { plugins: [ElementPlus] } })
    expect(wrapper.text().includes('暂无数据')).toBe(count === 0)
    expect(wrapper.findAll('li').map(item => item.text())).toEqual(rows.map(row => `${row.label}：${row.value} %`))
    expect(wrapper.find('svg[role="img"]').exists()).toBe(count >= 3)
    expect(wrapper.text().includes('有效链路不足三条')).toBe(count > 0 && count < 3)
    wrapper.unmount()
  })
  it('a 6000 点少断点：单图 ≤5000，精确保留首末与断点前后点，实际 polyline 不跨断点', () => {
    const rows = points(6000, index => index === 0 ? -7 : index === 5999 ? 9 : index === 3000 ? 50 : index === 2999 ? -50 : 0, index => index === 3000)
    const wrapper = draw(rows)
    expect(segments(wrapper)).toHaveLength(1)
    const counts = circlesPerSegment(wrapper)
    expect(counts[0]).toBeLessThanOrEqual(5000)
    const values = liValues(wrapper)
    expect(values).toHaveLength(counts[0]!)
    // 精确值而非 includes('50')
    expect(values.filter(value => value === -50)).toHaveLength(1)
    expect(values.filter(value => value === 50)).toHaveLength(1)
    expect(values[0]).toBe(-7)
    expect(values[values.length - 1]).toBe(9)
    // circle 的 title 也精确保留同一值（每条点可追溯）
    const titles = circleTitleValues(wrapper)
    expect(titles).toEqual(values)
    expect(titles.filter(value => value === -50)).toHaveLength(1)
    // 断点把折线拆成两段，且两段点数之和等于全部渲染点，说明无跨断点连线
    const lengths = polylineLengths(segments(wrapper)[0]!)
    expect(lengths).toHaveLength(2)
    expect(lengths.reduce((sum, value) => sum + value, 0)).toBe(counts[0])
    wrapper.unmount()
  })

  it('b 6000 点交替奇数 breakBefore（forced>5000）：全部点、标签/数值/顺序/总数可区分，每图 ≤5000，实际路径无跨断点', () => {
    const rows = points(6000, index => index, index => index % 2 === 1)
    const wrapper = draw(rows)
    const segmentWrappers = segments(wrapper)
    expect(segmentWrappers.length).toBeGreaterThan(1)
    for (const count of circlesPerSegment(wrapper)) expect(count).toBeLessThanOrEqual(5000)
    const total = circlesPerSegment(wrapper).reduce((sum, value) => sum + value, 0)
    expect(total).toBe(6000) // 不丢点
    // 跨段顺序与数值完整 0..5999
    const allValues = segmentWrappers.flatMap(segment => liValues(segment))
    expect(allValues).toEqual(Array.from({ length: 6000 }, (_, index) => index))
    expect(segmentWrappers.flatMap(segment => circleTitleValues(segment))).toEqual(allValues)
    // 每段内真实 polyline 分组必须与断点规则一致，证明没有跨断点连线
    for (const segment of segmentWrappers) {
      const values = liValues(segment)
      const lengths = polylineLengths(segment)
      const groups = expectedGroups(values)
      expect(lengths).toEqual(groups.map(group => group.length))
      expect(lengths.reduce((sum, value) => sum + value, 0)).toBe(segment.findAll('circle').length)
      expect(lengths.length).toBeGreaterThan(1)
    }
    wrapper.unmount()
  })

  it('c 首末与正负极值位于不同位置时精确保留（不用 includes 误命中 -100）', () => {
    const rows = points(6000, index => index === 1234 ? -100 : index === 4321 ? 100 : index === 0 ? 5 : index === 5999 ? -5 : 0)
    const wrapper = draw(rows)
    const values = liValues(wrapper)
    expect(values.filter(value => value === -100)).toHaveLength(1)
    expect(values.filter(value => value === 100)).toHaveLength(1)
    expect(values.filter(value => value === -5)).toHaveLength(1)
    expect(values[0]).toBe(5)
    expect(values[values.length - 1]).toBe(-5)
    expect(circleTitleValues(wrapper)).toEqual(values)
    // 最小值位置在最大值之前（1234 < 4321）
    expect(values.indexOf(-100)).toBeLessThan(values.indexOf(100))
    wrapper.unmount()
  })

  it('d 单点居中、同刻不同点同真实 x 且断开路径、不同刻真实 x', () => {
    const single = draw([{ label: '0', time: 0, value: 5 }])
    expect(single.findAll('circle')).toHaveLength(1)
    expect(single.find('circle').attributes('cx')).toBe('160')
    expect(circleTitleValues(single)).toEqual([5])
    expect(polylineLengths(single)).toEqual([1])
    single.unmount()

    const sameTime = draw([
      { label: 'a', time: 3, value: 1 },
      { label: 'b', time: 3, value: 2, breakBefore: true },
    ])
    expect(sameTime.findAll('circle')).toHaveLength(2)
    expect(circleCx(sameTime)).toEqual(['40', '40']) // 同一时刻真实 x 相同
    expect(circleTitleValues(sameTime)).toEqual([1, 2])
    expect(polylineLengths(sameTime)).toEqual([1, 1]) // 断点使两条路径各自成段，不连线
    sameTime.unmount()

    const distinct = draw([
      { label: 'a', time: 0, value: 1 },
      { label: 'b', time: 10, value: 2 },
    ])
    expect(circleCx(distinct)).toEqual(['40', '270']) // 真实时间轴 x
    expect(polylineLengths(distinct)).toEqual([2])
    distinct.unmount()
  })

  it('e 断点补充：每处 breakBefore 及其前一点成段，segments 与点数一致', () => {
    const wrapper = draw([
      { label: '0', time: 0, value: 1 },
      { label: '1', time: 1, value: 2 },
      { label: '2', time: 2, value: 3, breakBefore: true },
      { label: '3', time: 3, value: 4 },
      { label: '4', time: 4, value: 5 },
    ])
    expect(wrapper.findAll('circle')).toHaveLength(5)
    expect(polylineLengths(wrapper)).toEqual([2, 3])
    expect(liValues(wrapper)).toEqual([1, 2, 3, 4, 5])
    wrapper.unmount()
  })
})

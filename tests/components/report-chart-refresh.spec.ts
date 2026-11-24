import { mount, type VueWrapper } from '@vue/test-utils'
import * as echarts from 'echarts/core'
import ElementPlus from 'element-plus'
import { nextTick } from 'vue'
import { expect, it, vi } from 'vitest'
import ReportChart from '../../src/components/reports/ReportChart.vue'

vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn((host: HTMLElement) => ({
    getDom: () => host, resize: vi.fn(), setOption: vi.fn(), dispose: vi.fn(),
  })),
}))

it('筛选无数据后再次有数据时，图表在新的容器重绘', async () => {
  vi.stubEnv('MODE', 'production')
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  const wrapper: VueWrapper = mount(ReportChart, {
    props: { title: '统计', unit: '', useEcharts: true, rows: [{ label: '原范围', value: 4 }] },
    global: { plugins: [ElementPlus] },
  })
  try {
    await nextTick()
    const initial = wrapper.get('.report-chart__canvas').element
    const init = vi.mocked(echarts.init)
    expect(init).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ rows: [] })
    expect(wrapper.text()).toContain('暂无数据')
    expect(init.mock.results[0]!.value.dispose).toHaveBeenCalledOnce()

    await wrapper.setProps({ rows: [{ label: '新范围', value: 2 }] })
    const refreshed = wrapper.get('.report-chart__canvas').element
    expect(refreshed).not.toBe(initial)
    expect(init).toHaveBeenCalledTimes(2)
    expect(init.mock.results[1]!.value.getDom()).toBe(refreshed)
    expect(init.mock.results[1]!.value.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ series: [expect.objectContaining({ data: [2] })] }), true,
    )
  } finally {
    wrapper.unmount()
    vi.unstubAllEnvs()
  }
})

it('等待可见宽度，随布局变化调整尺寸，并在筛选时刷新时间轴和孤点', async () => {
  vi.stubEnv('MODE', 'production')
  let width = 0
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  let notify: (() => void) | undefined
  const observe = vi.fn(), disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notify = callback }
    observe = observe
    disconnect = disconnect
  })
  const wrapper: VueWrapper = mount(ReportChart, {
    props: {
      title: '统计', unit: 's', line: true, useEcharts: true, xMin: 10, xMax: 25, invalidValue: -999,
      scopeSummary: '3 秒',
      rows: [
        { label: 'a', time: 10, value: 2 },
        { label: '缺测', time: 15, value: -999 },
        { label: 'b', time: 20, value: 3 },
        { label: 'c', time: 25, value: 4 },
      ],
    },
    global: { plugins: [ElementPlus] },
  })
  const init = vi.mocked(echarts.init)
  try {
    await nextTick()
    const host = wrapper.get('.report-chart__canvas').element
    expect(observe).toHaveBeenCalledWith(host)
    expect(init).not.toHaveBeenCalled()
    expect(wrapper.get('.report-chart__summary').text()).toBe('当前范围统计 3 秒')

    width = 640
    notify!()
    expect(init).toHaveBeenCalledWith(host, undefined, expect.objectContaining({ width: 640 }))
    const renderer = init.mock.results[0]!.value
    expect(renderer.setOption).toHaveBeenLastCalledWith(expect.objectContaining({
      xAxis: expect.objectContaining({ min: 10, max: 25 }),
      series: [expect.objectContaining({
        connectNulls: false,
        data: [{ value: [10, 2], symbol: 'circle', symbolSize: 6 }, [20, null], [20, 3], [25, 4]],
      })],
    }), true)

    width = 960
    notify!()
    expect(renderer.resize).toHaveBeenCalledWith({ width: 960, height: 230 })
    expect(renderer.setOption).toHaveBeenCalledOnce()

    width = 0
    notify!()
    await wrapper.setProps({ xMin: 5, xMax: 30 })
    expect(renderer.setOption).toHaveBeenCalledOnce()
    width = 960
    notify!()
    expect(renderer.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({ xAxis: expect.objectContaining({ min: 5, max: 30 }) }), true,
    )
    await wrapper.setProps({ rows: [{ label: '单点', time: 15, value: 0 }], xMin: 15, xMax: 15 })
    expect(renderer.setOption).toHaveBeenLastCalledWith(expect.objectContaining({
      xAxis: expect.objectContaining({ min: 15, max: 15 }),
      series: [expect.objectContaining({ data: [{ value: [15, 0], symbol: 'circle', symbolSize: 6 }] })],
    }), true)
  } finally {
    wrapper.unmount()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  }
  expect(disconnect).toHaveBeenCalledOnce()
  expect(init.mock.results[0]!.value.dispose).toHaveBeenCalledOnce()
})

it('柱状图按容器比例限制柱宽，并使用已格式化的统计标签', async () => {
  vi.stubEnv('MODE', 'production')
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  const options = {
    props: { title: '统计', unit: '秒', useEcharts: true, rows: [{ label: '当前', value: 3, displayValue: '0分3秒' }] },
    global: { plugins: [ElementPlus] },
  }
  const wrapper = mount(ReportChart, options)
  try {
    await nextTick()
    const renderer = vi.mocked(echarts.init).mock.results[0]!.value
    const chart = vi.mocked(renderer.setOption).mock.calls[0]![0] as {
      series: { barMaxWidth: string; data: { value: number; label: { formatter: () => string } }[] }[]
      tooltip: { valueFormatter: (value: number, index: number) => string }
    }
    const series = chart.series[0]!
    expect(series.barMaxWidth).toBe('60%')
    expect(series.data[0]!.value).toBe(3)
    expect(series.data[0]!.label.formatter()).toBe('0分3秒')
    expect(chart.tooltip.valueFormatter(3, 0)).toBe('0分3秒')
  } finally {
    wrapper.unmount()
    vi.unstubAllEnvs()
  }
  const fallback = mount(ReportChart, options)
  try {
    expect(fallback.get('.bar-row strong').text()).toBe('0分3秒')
  } finally {
    fallback.unmount()
  }
})

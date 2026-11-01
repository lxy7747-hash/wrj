import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElInputNumber, ElSelect } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import ReportTabs from '../../src/components/reports/ReportTabs.vue'
import ReportsPage from '../../src/pages/reports/reports.vue'
import type { Principal, Report, ReportExportResult } from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
import { useReportStore } from '../../src/stores/report'

const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR',
  permissions: ['BUSINESS_READ', 'ORDINARY_REPORT_EXPORT'],
}

/** 创建报告页面测试使用的成功响应。 */
function success(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

/** 创建报告页测试使用的内存路由。 */
function reportsRouter() {
  return createRouter({ history: createMemoryHistory(), routes: [{ path: '/reports', component: ReportsPage }] })
}

describe('P3 报表内容', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('单次报告展示范围、单位和内容', async () => {
    const wrapper = mount(ReportTabs, {
      attachTo: document.body,
      props: {
        report: fixtureSource.report as Report,
        frame: fixtureSource.frame,
        events: fixtureSource.events,
      },
      global: { plugins: [ElementPlus] },
    })
    expect(wrapper.text()).toContain('RUN-001 · 0分0秒～0分42秒')
    expect(wrapper.text()).toContain('2026-08-06 18:06:30')
    expect(wrapper.text()).toContain('单位：dB')
    expect(wrapper.get('#tab-summary').attributes('aria-selected')).toBe('true')
    expect(wrapper.find('[data-testid="report-time-series-table"]').exists()).toBe(false)
    expect(wrapper.findAll('.el-tabs__item').map((tab) => tab.text())).toEqual([
      '汇总', '分链路', '干扰影响', '切换事件', '时序曲线', '事件时间线',
    ])

    await wrapper.findAll('.el-tabs__item')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('L-MW-01')
    await wrapper.findAll('.el-tabs__item')[2]!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('JAM-WB-01')
    await wrapper.findAll('.el-tabs__item')[3]!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('SW-003')
    await wrapper.findAll('.el-tabs__item')[4]!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="report-time-series"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="report-time-series"] polyline')).toHaveLength(3)
    expect(wrapper.findAll('[data-testid="report-time-series-table"] .el-table__row')).toHaveLength(3)
    expect(wrapper.text()).toContain('L-MW-01 · UAV-01 → GCC-01')
    expect(wrapper.text()).toContain('3.2e-7')
    await wrapper.get('#tab-summary').trigger('click')
    expect(wrapper.find('[data-testid="report-time-series-table"]').exists()).toBe(false)
    await wrapper.get('#tab-timeline').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="report-time-series-table"] .el-table__row')).toHaveLength(3)
  })

  it('质量筛选同时更新样本汇总、详情、时间线与范围，不保留全量持续时长', async () => {
    const wrapper = mount(ReportTabs, {
      props: { report: fixtureSource.report as Report, frame: fixtureSource.frame, events: fixtureSource.events },
      global: { plugins: [ElementPlus] },
    })
    const inputs = wrapper.findAllComponents(ElInputNumber)
    inputs[1]!.vm.$emit('update:modelValue', 0)
    await flushPromises()
    const cards = wrapper.findAll('.report-kpis article')
    expect(cards[1]!.text()).toContain('样本平均 SNR22.40')
    expect(cards[0]!.text()).toContain('暂无数据')
    expect(cards[3]!.text()).toContain('切换次数0')
    expect(cards[4]!.text()).toContain('暂无数据')
    expect(wrapper.text()).toContain('RUN-001 · 0分0秒～0分0秒')
    await wrapper.get('#tab-interference').trigger('click')
    expect(wrapper.findComponent({ name: 'ElDescriptions' }).exists()).toBe(false)
    await wrapper.get('#tab-switches').trigger('click')
    expect(wrapper.text()).not.toContain('SW-003')
    inputs[0]!.vm.$emit('update:modelValue', 1)
    await flushPromises()
    expect(wrapper.find('.report-kpis').exists()).toBe(false)
    await wrapper.findAll('button').find(button => button.text() === '重置筛选')!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.report-kpis article')[0]!.text()).toContain('87.3%')
    const selects = wrapper.findAllComponents(ElSelect)
    selects[0]!.vm.$emit('update:modelValue', 'GCC-01')
    await wrapper.get('#tab-interference').trigger('click')
    await flushPromises()
    expect(wrapper.findComponent({ name: 'ElDescriptions' }).exists()).toBe(false)
    selects[0]!.vm.$emit('update:modelValue', '')
    inputs[0]!.vm.$emit('update:modelValue', 50)
    inputs[1]!.vm.$emit('update:modelValue', 60)
    await flushPromises()
    expect(wrapper.findComponent({ name: 'ElDescriptions' }).text()).toContain('10 s')
    selects[1]!.vm.$emit('update:modelValue', 'UNKNOWN')
    await flushPromises()
    expect(wrapper.findComponent({ name: 'ElDescriptions' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('按不等间隔采样时刻定位曲线横坐标', async () => {
    const report = structuredClone(fixtureSource.report) as Report
    if (report.timeSeries === undefined) throw new Error('测试报告缺少时序点')
    report.timeSeries[0]!.points[0]!.time = 0
    report.timeSeries[0]!.points[1]!.time = 10
    report.timeSeries[0]!.points[2]!.time = 40
    const wrapper = mount(ReportTabs, {
      attachTo: document.body,
      props: { report },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.findAll('.el-tabs__item')[4]!.trigger('click')
    await flushPromises()
    const points = wrapper.get('[data-testid="report-time-series"] polyline').attributes('points') ?? ''
    expect(points.split(' ').map((point) => Number(point.split(',')[0]))).toEqual([4, 27, 96])
  })

  it('普通报告筛选到无匹配数据时保持各数据表为空，不回退到上一份遥测', async () => {
    const wrapper = mount(ReportTabs, {
      props: { report: fixtureSource.report as Report, frame: null, events: [] },
      global: { plugins: [ElementPlus] },
    })
    const selects = wrapper.findAllComponents(ElSelect)
    selects[0]!.vm.$emit('update:modelValue', 'UNKNOWN-NODE')
    await flushPromises()

    expect(wrapper.text()).toContain('当前筛选范围暂无时序数据')
    expect(wrapper.find('.report-kpis').exists()).toBe(false)
    for (const tabId of ['links', 'interference', 'switches', 'timeline']) {
      await wrapper.get(`#tab-${tabId}`).trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('暂无数据')
    }
    await wrapper.get('#tab-summary').trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '重置筛选')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('暂无数据')
  })

  it('普通报告缺少遥测和时序证据时显示空范围，仍保留只读数据表路径', async () => {
    const report = { ...structuredClone(fixtureSource.report), timeSeries: undefined } as Report
    const wrapper = mount(ReportTabs, { props: { report, frame: null, events: [] }, global: { plugins: [ElementPlus] } })

    expect(wrapper.text()).toContain('可用证据范围暂无数据')
    await wrapper.get('#tab-timeline').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('暂无数据')
  })

  it('普通报告的事件时间线只呈现链路切换，不把其他遥测事件伪装为切换', async () => {
    const wrapper = mount(ReportTabs, {
      props: { report: fixtureSource.report as Report, frame: fixtureSource.frame, events: fixtureSource.events },
      global: { plugins: [ElementPlus] },
    })
    await wrapper.findAll('.el-tabs__item').find(tab => tab.text() === '事件时间线')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('L-DL-03')
    expect(wrapper.text()).toContain('L-MW-01')
    expect(wrapper.text()).not.toContain('DET-042')
  })

  it('报告页面加载来源、验证二级导出并展示空态和错误态', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    const result: ReportExportResult = {
      reportId: 'RPT-001', generated: false, status: 'FIXTURE_SUCCESS',
      watermark: '仅供验证 · 未生成文件', verifiedAt: '2026-08-06T10:06:30Z',
    }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(success([fixtureSource.report]))
      .mockResolvedValueOnce(success(fixtureSource.report))
      .mockResolvedValueOnce(success(fixtureSource.frame))
      .mockResolvedValueOnce(success(fixtureSource.events))
      .mockResolvedValueOnce(success(result)))
    const router = reportsRouter()
    await router.push('/reports')
    const wrapper = mount(ReportsPage, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus] } })
    await flushPromises()

    expect(wrapper.attributes('aria-label')).toBe('评估报表')
    expect(wrapper.get('[data-testid="report-tabs"]').attributes('data-report-id')).toBe('RPT-001')
    await wrapper.get('[data-testid="report-export"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.reports-page__export-result').text()).toContain('未生成文件')

    const report = useReportStore(pinia)
    report.$patch({ selectedReport: null, capabilityState: 'EMPTY', resultMessage: '尚未加载报告。' })
    await flushPromises()
    expect(wrapper.text()).toContain('暂无可用报告')
    report.$patch({ capabilityState: 'ERROR', resultMessage: '报告读取失败。' })
    await flushPromises()
    expect(wrapper.text()).toContain('报告加载失败')
    report.$patch({ capabilityState: 'LOADING' })
    await flushPromises()
    expect(wrapper.find('.el-skeleton')).toBeTruthy()
    wrapper.unmount()
    expect(report.capabilityState).toBe('EMPTY')
  })

})

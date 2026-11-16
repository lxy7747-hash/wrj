import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElInputNumber, ElSelect } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import ReportChart from '../../src/components/reports/ReportChart.vue'
import { formatDateTime } from '../../src/features/shared/date-time'
import ReportTabs from '../../src/components/reports/ReportTabs.vue'
import ReportsPage from '../../src/pages/reports/reports.vue'
import type { Principal, Report, ReportExportResult, SwitchEvent } from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
import { useReportStore } from '../../src/stores/report'
import { LOCAL_REPORT } from '../fixtures/local-report'

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

  it('干扰影响展示全部执行证据，并按目标节点筛选第二台', async () => {
    const frame = structuredClone(fixtureSource.frame)
    const first = frame.evidence.jammerExecution
    const second = { ...first, jammerId: 'JAM-SECOND', targetPlatformId: 'CMD-01', power: 17 }
    const wrapper = mount(ReportTabs, {
      props: { report: fixtureSource.report as Report, frame: { ...frame, evidence: { ...frame.evidence, jammerExecutions: [first, second] } }, events: fixtureSource.events },
      global: { plugins: [ElementPlus] },
    })
    await wrapper.get('#tab-interference').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="report-jammer-evidence"]')).toHaveLength(2)
    expect(wrapper.get('#pane-interference').text()).toContain('JAM-SECOND')
    const nodeFilter = wrapper.findAllComponents(ElSelect)[0]!
    nodeFilter.vm.$emit('update:modelValue', 'CMD-01')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="report-jammer-evidence"]')).toHaveLength(1)
    expect(wrapper.get('#pane-interference').text()).toContain('JAM-SECOND')
    expect(wrapper.get('#pane-interference').text()).not.toContain(first.jammerId)
    wrapper.unmount()
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
      '汇总', '分链路', '干扰影响', '切换事件', '时序曲线', '柱状图', '雷达图', '事件时间线',
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
    expect(wrapper.text()).toContain('L-MW-01 · UAV-01 → CMD-01')
    expect(wrapper.text()).toContain('3.2e-7')
    await wrapper.get('#tab-summary').trigger('click')
    expect(wrapper.find('[data-testid="report-time-series-table"]').exists()).toBe(false)
    await wrapper.get('#tab-timeline').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="report-time-series-table"] .el-table__row')).toHaveLength(3)
  })

  it('柱状图和雷达图使用同一筛选样本、真实单位及门限，切换涉及同一链路只计一次', async () => {
    const report: Report = { ...structuredClone(fixtureSource.report) as Report, timeSeries: [
      { linkId: 'L-A', sourcePlatformId: 'A', targetPlatformId: 'B', points: [
        { time: 0, snrDb: 10, ber: 1e-5, interferencePowerDbm: -80 }, { time: 10, snrDb: 20, ber: 1e-4, interferencePowerDbm: -60 }] },
      { linkId: 'L-B', sourcePlatformId: 'B', targetPlatformId: 'C', points: [
        { time: 0, snrDb: 30, ber: 1e-6, interferencePowerDbm: -90 }, { time: 10, snrDb: 50, ber: 1e-7, interferencePowerDbm: -70 }] },
      { linkId: 'L-C', sourcePlatformId: 'D', targetPlatformId: 'C', points: [
        { time: 0, snrDb: -4, ber: 1e-4, interferencePowerDbm: -100 }, { time: 10, snrDb: 0, ber: 1e-3, interferencePowerDbm: -90 }] },
    ] }
    const event = fixtureSource.events.find(row => row.type === 'LINK_SWITCH') as SwitchEvent
    const wrapper: VueWrapper = mount(ReportTabs, { props: { report, events: [
      { ...event, eventId: 'SW-A', time: 0, oldLinkId: 'L-A', newLinkId: 'L-B' },
      { ...event, eventId: 'SW-B', time: 10, oldLinkId: 'L-A', newLinkId: 'L-A' },
    ] }, global: { plugins: [ElementPlus] } })
    expect(wrapper.find('[data-testid="report-bar-charts"]').exists()).toBe(false)
    await wrapper.get('#tab-bars').trigger('click'); await flushPromises()
    const charts = (): VueWrapper[] => wrapper.findAllComponents(ReportChart)
    const bars = () => charts().filter(chart => !chart.get('h4').text().includes('样本连通率'))
    expect(bars().map(chart => chart.get('h4').text())).toEqual(['各链路平均 SNR（dB）', '各链路平均干扰功率（dBm）', '各链路切换次数（次）'])
    expect(bars().map(chart => chart.findAll('.bar-row strong').map(row => Number.parseFloat(row.text())))).toEqual([[15, 40, -2], [-70, -80, -95], [2, 1, 0]])
    for (const chart of bars()) {
      expect(chart.text()).toContain('RUN-001 · 0分0秒～0分10秒 · 全部节点 · 全部链路')
      expect(chart.text()).toContain(`生成时刻 ${formatDateTime(report.generatedTime)}`)
    }
    expect(bars()[1]!.findAll('.bar-track > div').every(bar => !bar.attributes('style')?.includes('width: 0%;'))).toBe(true)
    await wrapper.get('#tab-radar').trigger('click'); await flushPromises()
    const radar = () => charts().find(chart => chart.get('h4').text().includes('样本连通率'))!
    expect(radar().findAll('li').map(row => Number.parseFloat(row.text().split('：')[1]!))).toEqual([50, 100, 0])
    expect(radar().get('svg').attributes('aria-label')).toContain('0–100%')
    expect(wrapper.get('[data-testid="report-radar-chart"]').text()).toContain('默认 BER 门限（1E-5）')
    expect(radar().text()).toContain(`生成时刻 ${formatDateTime(report.generatedTime)}`)
    const inputs = wrapper.findAllComponents(ElInputNumber)
    inputs[1]!.vm.$emit('update:modelValue', 0); await flushPromises()
    expect(radar().findAll('li').map(row => Number.parseFloat(row.text().split('：')[1]!))).toEqual([100, 100, 0])
    await wrapper.get('#tab-bars').trigger('click'); await flushPromises()
    expect(bars().map(chart => chart.findAll('.bar-row strong').map(row => Number.parseFloat(row.text())))).toEqual([[10, 30, -4], [-80, -90, -100], [1, 1, 0]])
    const selects = wrapper.findAllComponents(ElSelect)
    selects[1]!.vm.$emit('update:modelValue', 'L-A'); await flushPromises()
    expect(bars()[0]!.findAll('.bar-row').map(row => row.text())).toEqual(['L-A10 dB'])
    expect(bars()[0]!.text()).toContain('0分0秒～0分0秒 · 全部节点 · L-A')
    await wrapper.get('#tab-radar').trigger('click'); await flushPromises()
    expect(radar().find('svg[role="img"]').exists()).toBe(false)
    expect(radar().text()).toContain('有效链路不足三条，按数值展示连通率')
    expect(radar().findAll('li').map(row => row.text())).toEqual(['L-A：100 %'])
    selects[1]!.vm.$emit('update:modelValue', '')
    selects[0]!.vm.$emit('update:modelValue', 'A'); await flushPromises()
    expect(radar().text()).toContain(' · A · 全部链路')
    expect(radar().find('svg[role="img"]').exists()).toBe(false)
    inputs[1]!.vm.$emit('update:modelValue', 30); inputs[0]!.vm.$emit('update:modelValue', 20); await flushPromises()
    expect(wrapper.get('[data-testid="report-radar-chart"]').text()).toBe('暂无数据')
    await wrapper.get('#tab-bars').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-testid="report-bar-charts"]').text()).toBe('暂无数据')
    await wrapper.setProps({ report: { ...report, timeSeries: undefined } })
    expect(wrapper.get('[data-testid="report-bar-charts"]').text()).toBe('暂无数据')
    wrapper.unmount()
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
    expect(wrapper.get('[data-testid="report-export"]').isVisible()).toBe(false)
    await wrapper.get('[data-testid="report-tools"] .el-collapse-item__header').trigger('click')
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

  it('打开已生成链路 CSV 的运行报告时自动选中任务 CSV 并加载明细和曲线', async () => {
    const pinia = createPinia(); setActivePinia(pinia)
    useAuthStore(pinia).$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    const store = useReportStore(pinia), sha = 'c'.repeat(64)
    const report = structuredClone(LOCAL_REPORT)
    report.localEvidence!.engineCsv = { sourceSha256: 'a'.repeat(64), missing: [], files: [{ fileName: 'link_state.csv', rowCount: 1, sha256: 'b'.repeat(64), status: 'PARTIAL', skippedCount: 0 }] }
    vi.spyOn(store, 'loadResult').mockImplementation(async () => {
      store.$patch({ selectedReport: report, capabilityState: 'SUCCESS', resultSource: { resultId: 'RESULT-1' } as never }); return true
    })
    vi.spyOn(store, 'applyLocalFilter').mockResolvedValue(true)
    const overview = vi.spyOn(store, 'loadEvidenceOverview').mockImplementation(async selected => {
      store.evidenceOverview = { sources: [{ sourceSha256: sha, label: '任务 CSV（部分覆盖）', sourceKind: 'FILE_SET', capabilities: ['state'], totals: { state: 1 }, series: [] }], selectedSourceSha256: selected ?? null,
        capabilities: ['state', 'loss', 'switch'], series: [{ seriesId: 'state:L-1:gxb' }] } as never
      return true
    })
    const comparisons = vi.spyOn(store, 'loadResultComparisons').mockResolvedValue(true)
    const rows = vi.spyOn(store, 'loadEvidenceRows').mockResolvedValue(true)
    const series = vi.spyOn(store, 'loadEvidenceSeries').mockResolvedValue(true)
    const router = reportsRouter(); await router.push('/reports?resultId=RESULT-1')
    const wrapper = mount(ReportsPage, { global: { plugins: [pinia, router, ElementPlus], stubs: { MissionResults: true, ReportTabs: true, ReportChart: true } } })
    await flushPromises()
    expect(overview).toHaveBeenCalledWith(sha)
    expect(rows).toHaveBeenCalledWith('state', { filter: undefined })
    expect(series).toHaveBeenCalledWith('state:L-1:gxb', { filter: undefined })
    expect(comparisons).not.toHaveBeenCalled()
    await wrapper.get('#tab-链路质量与曲线').trigger('click'); await flushPromises()
    expect(comparisons).not.toHaveBeenCalled()
    await wrapper.get('#tab-已完成运行参数对比').trigger('click'); await flushPromises()
    expect(comparisons).toHaveBeenCalledTimes(1)
    store.comparisonsLoading = true
    await flushPromises()
    expect(wrapper.get('#pane-已完成运行参数对比').attributes('aria-busy')).toBe('true')
    wrapper.unmount()
  })

  it('证据元信息：全源统计与当前筛选明细分开展示，不把全源 total 当筛选 total', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(success([LOCAL_REPORT]))
      .mockResolvedValueOnce(success(LOCAL_REPORT)))
    const router = reportsRouter()
    await router.push('/reports')
    const wrapper = mount(ReportsPage, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router, ElementPlus],
        stubs: { MissionResults: true, LocalReportTabs: true, ReportTabs: true, ReportChart: true },
      },
    })
    await flushPromises()
    const store = useReportStore(pinia)
    const sha = 'a'.repeat(64)
    store.$patch({
      capabilityState: 'SUCCESS',
      resultSource: { resultId: 'RESULT-1', scenarioId: 'SCN-1', scenarioName: 'x', revision: 1, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', runId: 'RUN-1', taskId: 'TASK-1' } as never,
      localFilterResult: { report: structuredClone(LOCAL_REPORT), filter: {}, timeline: [], timelineTotal: 0, stages: [], links: [] } as never,
      evidenceOverview: {
        reportId: LOCAL_REPORT.reportId, resultId: 'RESULT-1', runId: 'RUN-1', generatedTime: LOCAL_REPORT.generatedTime,
        effectiveFilter: {}, sources: [{ sourceSha256: sha, sourceKind: 'FILE_SET', capabilities: ['state'], totals: { state: 123 }, series: [], label: 'src' }],
        selectedSourceSha256: sha, capabilities: ['state'], totals: { state: 123 }, missing: [], series: [],
      } as never,
      evidenceRows: { reportId: LOCAL_REPORT.reportId, resultId: 'RESULT-1', runId: 'RUN-1', sourceSha256: sha, kind: 'state', effectiveFilter: {}, total: 7, rows: [{ id: 'r1', time: 1, gxbDb: 0, receivedPower: null, cloudRainLossDb: null }], nextCursor: null } as never,
    })
    await flushPromises()
    await wrapper.get('[data-testid="report-tools"] .el-collapse-item__header').trigger('click')
    const sourceTotals = wrapper.get('[data-testid="report-evidence-source-totals"]').text()
    expect(sourceTotals).toContain('全源统计')
    expect(sourceTotals).toContain('state 123')
    expect(wrapper.get('[data-testid="report-evidence-filtered-total"]').text()).toContain('7')
    expect(sourceTotals).not.toContain('7')
    const csvTable = wrapper.get('[data-testid="report-evidence-rows"]')
    expect(csvTable.text()).toContain('接收功率（dBm）')
    expect(csvTable.text()).toContain('云雨损耗（dB）')
    expect(csvTable.text()).toContain('暂无数据')
    expect(csvTable.findAll('.el-table__body td').map(cell => cell.text())).toContain('0')
    wrapper.unmount()
  })

  it('仅编辑未应用筛选不触发请求；成功应用后才按已应用筛选刷新当前 kind 与 series', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(success([LOCAL_REPORT]))
      .mockResolvedValueOnce(success(LOCAL_REPORT)))
    const router = reportsRouter()
    await router.push('/reports')
    const wrapper = mount(ReportsPage, {
      attachTo: document.body,
      global: { plugins: [pinia, router, ElementPlus], stubs: { MissionResults: true, LocalReportTabs: true, ReportTabs: true, ReportChart: true } },
    })
    await flushPromises()
    const store = useReportStore(pinia)
    const sha = 'a'.repeat(64)
    store.$patch({
      capabilityState: 'SUCCESS',
      resultSource: { resultId: 'RESULT-1', scenarioId: 'SCN-1', scenarioName: 'x', revision: 1, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', runId: 'RUN-1', taskId: 'TASK-1' } as never,
      localFilterResult: { report: structuredClone(LOCAL_REPORT), filter: {}, timeline: [], timelineTotal: 0, stages: [], links: [] } as never,
      evidenceOverview: {
        reportId: LOCAL_REPORT.reportId, resultId: 'RESULT-1', runId: 'RUN-1', generatedTime: LOCAL_REPORT.generatedTime,
        effectiveFilter: {}, sources: [{ sourceSha256: sha, sourceKind: 'FILE_SET', capabilities: ['state'], totals: { state: 1 }, series: [{ seriesId: 'state:L-1:gxb', kind: 'state', unit: 'dB' }], label: 'src' }],
        selectedSourceSha256: sha, capabilities: ['state'], totals: { state: 1 }, missing: [], series: [{ seriesId: 'state:L-1:gxb', kind: 'state', unit: 'dB' }],
      } as never,
    })
    await flushPromises()
    const rowsSpy = vi.spyOn(store, 'loadEvidenceRows').mockResolvedValue(true)
    const seriesSpy = vi.spyOn(store, 'loadEvidenceSeries').mockResolvedValue(true)
    const applySpy = vi.spyOn(store, 'applyLocalFilter').mockImplementation(async (filter) => {
      store.localFilterResult = { report: structuredClone(LOCAL_REPORT), filter, timeline: [], timelineTotal: 0, stages: [], links: [] } as never
      return true
    })
    await wrapper.get('[data-testid="report-tools"] .el-collapse-item__header').trigger('click')
    const selects = wrapper.findAllComponents(ElSelect)
    const byTestId = (id: string) => selects.find(select => (select.vm.$el as HTMLElement).getAttribute('data-testid') === id)!
    byTestId('evidence-kind').vm.$emit('change', 'state'); await flushPromises()
    byTestId('evidence-series').vm.$emit('change', 'state:L-1:gxb'); await flushPromises()
    const rowsBefore = rowsSpy.mock.calls.length
    const seriesBefore = seriesSpy.mock.calls.length
    expect(rowsBefore).toBeGreaterThanOrEqual(1)
    expect(seriesBefore).toBeGreaterThanOrEqual(1)

    // 仅编辑筛选（未应用）：不触发任何证据请求
    const inputs = wrapper.findAllComponents(ElInputNumber)
    inputs[0]!.vm.$emit('update:modelValue', 1)
    inputs[1]!.vm.$emit('update:modelValue', 3)
    await flushPromises()
    expect(applySpy).not.toHaveBeenCalled()
    expect(rowsSpy.mock.calls.length).toBe(rowsBefore)
    expect(seriesSpy.mock.calls.length).toBe(seriesBefore)

    // 成功应用后才用“已应用筛选”刷新当前 kind/series
    await wrapper.findAll('button').find(button => button.text() === '应用精确筛选')!.trigger('click')
    await flushPromises()
    expect(applySpy).toHaveBeenCalledWith({ from: 1, to: 3 })
    await vi.waitFor(() => expect(rowsSpy.mock.calls.length).toBe(rowsBefore + 1))
    expect(seriesSpy.mock.calls.length).toBe(seriesBefore + 1)
    expect(rowsSpy.mock.calls.at(-1)![1]).toMatchObject({ filter: { from: 1, to: 3 } })
    expect(seriesSpy.mock.calls.at(-1)![1]).toMatchObject({ filter: { from: 1, to: 3 } })
    wrapper.unmount()
  })

})

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElInputNumber, ElSelect } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReportsPage from '../../src/pages/reports/reports.vue'
import ReportChart from '../../src/components/reports/ReportChart.vue'
import { formatDateTime } from '../../src/features/shared/date-time'
import LocalReportTabs from '../../src/components/reports/LocalReportTabs.vue'
import { useReportStore, isReport } from '../../src/stores/report'
import { useAuthStore } from '../../src/stores/auth'
import { isLocalReport, isLocalReportExport, localReportTables } from '../../src/features/reports/local-report'
import { attachQualityReport } from '../../src/features/reports/quality-report'
import { LOCAL_REPORT, LOCAL_EXPORT, LOCAL_QUALITY_REPORT } from '../fixtures/local-report'
import type { EngineFrameArchiveSummary, LocalReportFilterResult, LocalSwitchEvent } from '../../src/contracts/domain-models'
import type { MissionResultParameterComparison } from '../../src/features/results/mission-result'
import { LATEST_FRAME_REPORT } from '../fixtures/engine-frame/latest-report'

const response = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) }) as Response
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('本地文件报告页面与信任边界', () => {
  it('主报告不展示运行明细，也不把内部缺失原因写成引擎故障', async () => {
    const report = structuredClone(LATEST_FRAME_REPORT)
    const evidence = report.localEvidence!
    evidence.engineCsv = { sourceSha256: 'c'.repeat(64), files: [], missing: [
      { fileName: 'link_state.csv', status: 'SOURCE_MISSING', reason: '缺少接收功率。' },
    ] }
    const before = structuredClone(evidence)
    const wrapper = mount(LocalReportTabs, { props: { evidence }, global: { plugins: [ElementPlus] } })
    try {
      expect(wrapper.find('[data-testid="report-details"]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('运行明细与来源校验')
      expect(wrapper.text()).not.toContain('引擎数据缺少')
      expect(wrapper.text()).not.toContain('部分规范 CSV 数据缺失')
      expect(evidence).toEqual(before)
    } finally { wrapper.unmount() }
  })

  it('评估指标与业务页签直接展示，不再提供运行明细与来源校验', async () => {
    const wrapper = mount(LocalReportTabs, { attachTo: document.body, props: { evidence: LOCAL_QUALITY_REPORT.localEvidence! }, global: { plugins: [ElementPlus] } })
    try {
      await flushPromises()
      const cards = wrapper.get('[data-testid="report-metric-cards"]')
      expect(cards.findAll('h4').map(card => card.text())).toEqual(['平均连通时长', '切换次数', '平均干信比', '平均误码率', '干扰持续时长'])
      expect(cards.isVisible()).toBe(true)
      expect(wrapper.find('[data-testid="report-details"]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('运行明细与来源校验')
      for (const title of ['汇总', '折线图', '柱状图', '雷达图', '事件时间线']) expect(wrapper.get(`#tab-${title}`).isVisible()).toBe(true)
      expect(wrapper.find('#tab-已完成运行参数对比').exists()).toBe(false)
    } finally { wrapper.unmount() }
  })

  it('无运行日志切换事件时，链路切换事件表使用引擎帧 routing.switches', async () => {
    const report = structuredClone(LATEST_FRAME_REPORT)
    report.localEvidence!.engineFrameArchive!.switchRows = [{
      engineEpoch: 0, frameId: 5, simulationTime: 5,
      value: {
        pathId: 'NEW-PATH', direction: 'FORWARD', sourceName: 'A', targetName: 'B',
        sourcePlatformId: 'A', targetPlatformId: 'B', transTypes: [], nodes: [],
        oldPathId: 'OLD-PATH', oldNodes: [], reasons: [{ linkId: 'L-1', reasons: ['ber_switch'] }],
      },
    }]
    const wrapper = mount(LocalReportTabs, { props: { evidence: report.localEvidence }, global: { plugins: [ElementPlus] } })
    try {
      await wrapper.findAll('.el-tabs__item').find(item => item.text() === '链路切换事件')!.trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('切换-001')
      expect(wrapper.text()).toContain('OLD-PATH')
      expect(wrapper.text()).toContain('NEW-PATH')
      expect(wrapper.text()).toContain('链路劣化切换')
    } finally { wrapper.unmount() }
  })

  it('运行报告只保留一次刷新，刷新目录与报告；统计 CSV 收进数据导出菜单', async () => {
    const pinia = createPinia(); setActivePinia(pinia)
    useAuthStore().runtimeMode = 'LOCAL'
    const record = { resultId: 'RESULT-11111111-1111-4111-8111-111111111111', scenarioId: 'SCN-001', scenarioName: '运行结果', revision: 1, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:10Z' }
    const fetch = vi.fn().mockResolvedValue(response([record])); vi.stubGlobal('fetch', fetch)
    const store = useReportStore()
    store.$patch({ selectedReport: structuredClone(LOCAL_REPORT), resultSource: record, capabilityState: 'SUCCESS' })
    const load = vi.spyOn(store, 'loadResult').mockResolvedValue(true)
    vi.spyOn(store, 'applyLocalFilter').mockResolvedValue(true)
    const exportReport = vi.spyOn(store, 'requestExport').mockResolvedValue(true)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/reports', component: ReportsPage }] })
    await router.push(`/reports?resultId=${record.resultId}`)
    const wrapper = mount(ReportsPage, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus] } })
    try {
      await flushPromises()
      expect(load).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce()
      expect(wrapper.find('[data-testid="report-source"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="report-tools"]').exists()).toBe(false)
      const refresh = wrapper.findAll('button').filter(button => /刷新|重新加载/.test(button.text()))
      expect(refresh).toHaveLength(1)
      await refresh[0]!.trigger('click'); await flushPromises()
      expect(load).toHaveBeenCalledTimes(2); expect(fetch).toHaveBeenCalledTimes(2)
      expect(wrapper.findAllComponents(ElSelect).find(select => wrapper.get('.reports-page__actions').element.contains(select.element))!.findAllComponents({ name: 'ElOption' }).map(option => option.props('value'))).toEqual(['HTML', 'PDF'])
      await wrapper.get('[data-testid="report-data-export"]').trigger('click'); await flushPromises()
      const csvItem = document.querySelector<HTMLElement>('[data-testid="export-summary-csv"]')!
      expect(csvItem.textContent).toContain('导出统计 CSV')
      csvItem.click(); await flushPromises()
      expect(exportReport).toHaveBeenLastCalledWith('CSV')
      await wrapper.get('[data-testid="report-export"]').trigger('click'); await flushPromises()
      expect(exportReport).toHaveBeenLastCalledWith('HTML')
    } finally { wrapper.unmount() }
  })

  it('质量曲线、柱状图与雷达图独立，图表注明来源、已应用范围和生成时刻', async () => {
    const wrapper: VueWrapper = mount(LocalReportTabs, { props: { evidence: LOCAL_QUALITY_REPORT.localEvidence!, generatedTime: LOCAL_QUALITY_REPORT.generatedTime }, global: { plugins: [ElementPlus] } })
    const tabs = wrapper.findAll('.el-tabs__item').map(tab => tab.text())
    expect(tabs.indexOf('雷达图')).toBe(tabs.indexOf('柱状图') + 1)
    await wrapper.get('#tab-折线图').trigger('click'); await flushPromises()
    expect(wrapper.findAllComponents(ReportChart)).toHaveLength(5)
    expect(wrapper.findAllComponents(ReportChart).map(chart => chart.get('h4').text())).toEqual([
      '连通时长随时间变化（秒）', '切换次数随时间变化（次）', '干信比随时间变化（dB）', '误码率随时间变化（比率）', '干扰持续时长随时间变化（秒）',
    ])
    expect(wrapper.get('#pane-折线图').find('svg[aria-label*="范围 0–100%"]').exists()).toBe(false)
    await wrapper.get('#tab-柱状图').trigger('click'); await flushPromises()
    const bars = wrapper.get('[data-testid="report-bar-charts"]')
    expect(bars.text()).toContain('五项评估指标')
    const panels = wrapper.findAllComponents(ReportChart).filter(chart => bars.element.contains(chart.element))
      .map(chart => ({ ...(chart.props() as { title: string; rows: unknown[] }), text: chart.text() }))
    expect(panels.map(chart => chart.title)).toEqual(['平均连通时长', '切换次数', '平均干信比', '平均误码率', '干扰持续时长'])
    expect(panels.find(chart => chart.title === '切换次数')?.rows).toEqual([])
    expect(panels.find(chart => chart.title === '干扰持续时长')?.text).toContain('暂无数据')
    await wrapper.get('#tab-雷达图').trigger('click'); await flushPromises()
    const radar = wrapper.get('[data-testid="report-radar-chart"]')
    expect(radar.text()).not.toContain('quality.csv')
    expect(radar.text()).toContain('平均连通时长')
    expect(radar.findAll('li')).toHaveLength(3)
    expect(radar.findAll('li').map(item => item.text())).toContain('平均误码率：0')
    await wrapper.setProps({ preciseFilter: true, filter: { nodeId: 'A', linkId: 'L-1', stage: 'PH-1', from: 0, to: 1 } })
    expect(radar.text()).not.toContain('quality.csv')
    await wrapper.setProps({ evidence: LOCAL_REPORT.localEvidence })
    expect(radar.text()).toBe('暂无数据')
    wrapper.unmount()
  })
  it('趋势沿用实际仿真时刻，时长曲线不计未配对的末次采样', async () => {
    const quality = LOCAL_QUALITY_REPORT.localEvidence!.quality!
    const evidence = attachQualityReport({ ...LOCAL_REPORT, localEvidence: {
      ...LOCAL_REPORT.localEvidence,
      switchEvents: [{ eventId: 'SW-OBSERVED', time: 0.75, demandId: 'D-1', ruleId: null,
        fromDeviceId: 'device-a', toDeviceId: 'device-b', fromLinkId: 'L-1', toLinkId: 'L-2', stableChecks: null }],
    } }, { ...quality, samples: quality.samples.map(sample => ({ ...sample, time: sample.time + 0.25, interferenceActive: false })) }).localEvidence!
    const wrapper: VueWrapper = mount(LocalReportTabs, { props: { evidence }, global: { plugins: [ElementPlus] } })
    try {
      await wrapper.get('#tab-折线图').trigger('click')
      await flushPromises()
      const getCharts = () => new Map(wrapper.findAllComponents(ReportChart).map(chart => {
        const props = chart.props() as { title: string; rows: unknown[]; stepEnd?: boolean }
        return [props.title, props] as const
      }))
      const charts = getCharts()
      expect(charts.get('误码率随时间变化')?.rows).toMatchObject([{ time: 0.25 }, { time: 1.25 }])
      expect(charts.get('连通时长随时间变化')?.rows).toMatchObject([{ time: 0.25, value: 2 / 3 }])
      expect(charts.get('干扰持续时长随时间变化')?.rows).toMatchObject([{ time: 0.25, value: 0 }, { time: 1.25, value: 0 }])
      expect(charts.get('切换次数随时间变化')).toMatchObject({
        stepEnd: true, rows: [{ time: 0, value: 0 }, { time: 0.75, value: 1 }, { time: 10, value: 1 }],
      })

      const clipped = {
        ...evidence, startTimeS: 0.5, endTimeS: 1, positionCount: 1, simulationComplete: false,
        nodes: evidence.nodes.map(node => node.platformId === 'A'
          ? { ...node, positionCount: 1, lastTimeS: 1 }
          : { ...node, positionCount: 0, firstTimeS: 0.5, lastTimeS: 0.5 }),
        eventCount: 0, eventCounts: [], connections: [], deviceEvents: [], switchEvents: undefined,
        quality: { ...quality, samples: [], switchEvents: [] }, qualityKpis: { jammingDurationS: 0.5 },
        qualityJammingDurationTrend: [{ time: 0.5, value: 0 }, { time: 1, value: 0.5 }],
      }
      expect(isLocalReport({ ...LOCAL_QUALITY_REPORT, localEvidence: clipped })).toBe(true)
      await wrapper.setProps({ evidence: clipped, filter: { from: 0.5, to: 1 } })
      await flushPromises()
      expect(getCharts().get('干扰持续时长随时间变化')).toMatchObject({
        xMin: 0.5, xMax: 1, scopeSummary: '0分0.5秒',
        rows: [{ time: 0.5, value: 0 }, { time: 1, value: 0.5 }],
      })
    } finally { wrapper.unmount() }
  })
  it.each([0, 1])('引擎明细尚未加载时使用已归档的累计趋势（切换 %i 次）', async switchCount => {
    const report = structuredClone(LOCAL_REPORT)
    const switchCountTrend = [{ time: 0, value: 0 }, ...(switchCount ? [{ time: 4, value: 1 }] : []), { time: 10, value: switchCount }]
    const jammingDurationTrend = [{ time: 0, value: 0 }, { time: 2, value: 1 }, { time: 6, value: 1, breakBefore: true }, { time: 8, value: 2 }]
    report.localEvidence.engineFrameArchive = {
      sourceSha256: 'd'.repeat(64), frameCount: 2, firstSimulationTime: 0, lastSimulationTime: 10,
      missingFieldNames: [], detailDeferred: true, segmentRows: [], switchRows: [], eventRows: [],
      aggregate: { uniqueSingleSegmentCount: 1, switchCount, jammingDurationS: 2, switchCountTrend, jammingDurationTrend, missing: [] },
    }
    expect(isLocalReport(report)).toBe(true)
    const wrapper = mount(LocalReportTabs, { props: { evidence: report.localEvidence }, global: { plugins: [ElementPlus] } })
    try {
      await wrapper.get('#tab-折线图').trigger('click')
      await flushPromises()
      const rows = (title: string) => wrapper.findAllComponents(ReportChart)
        .map(chart => chart.props() as { title: string; rows: unknown[] }).find(chart => chart.title === title)?.rows
      expect(rows('切换次数随时间变化')).toMatchObject(switchCountTrend)
      expect(rows('干扰持续时长随时间变化')).toMatchObject(jammingDurationTrend)
    } finally { wrapper.unmount() }
  })
  it('表单编辑不改变已应用范围，非法区间仍可重置，重新加载清除旧条件', async () => {
    const pinia = createPinia(); setActivePinia(pinia)
    const record = { resultId: 'RESULT-11111111-1111-4111-8111-111111111111', scenarioId: 'SCN-001', scenarioName: '运行结果', revision: 1,
      startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:10Z' }
    const store = useReportStore()
    store.$patch({ selectedReport: structuredClone(LOCAL_REPORT), reports: [structuredClone(LOCAL_REPORT)], resultSource: record, capabilityState: 'SUCCESS' })
    vi.spyOn(store, 'loadResult').mockResolvedValue(true)
    const apply = vi.spyOn(store, 'applyLocalFilter').mockImplementation(async filter => {
      store.localFilterResult = { report: structuredClone(LOCAL_REPORT), filter, timeline: [], timelineTotal: 0, stages: [], links: ['L-1'] }
      store.capabilityState = 'SUCCESS'
      return true
    })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/reports', component: ReportsPage }] })
    await router.push(`/reports?resultId=${record.resultId}`)
    const wrapper = mount(ReportsPage, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus], stubs: { MissionResults: true } } })
    await flushPromises()
    const form = wrapper.get('[aria-label="报告统一筛选"]')
    const selects = wrapper.findAllComponents(ElSelect).filter(select => form.element.contains(select.element))
    const inputs = wrapper.findAllComponents(ElInputNumber)
    selects[0]!.vm.$emit('update:modelValue', 'A')
    inputs[0]!.vm.$emit('update:modelValue', 1); inputs[1]!.vm.$emit('update:modelValue', 3)
    await flushPromises()
    expect(wrapper.get('[data-testid="report-applied-filter"]').text()).toContain('全部数据')
    await wrapper.findAll('button').find(button => button.text() === '应用精确筛选')!.trigger('click')
    await flushPromises()
    expect(apply).toHaveBeenLastCalledWith({ nodeId: 'A', from: 1, to: 3 })
    expect(wrapper.get('[data-testid="report-applied-filter"]').text()).toContain('节点 A；1～3 秒')
    expect(wrapper.get('[data-testid="report-export"]').text()).toBe('导出筛选报告')
    expect(selects).toHaveLength(2)
    inputs[0]!.vm.$emit('update:modelValue', 5)
    await flushPromises()
    expect(wrapper.text()).toContain('开始时刻不得晚于结束时刻')
    await wrapper.findAll('button').find(button => button.text() === '重置')!.trigger('click')
    await flushPromises()
    expect(apply).toHaveBeenLastCalledWith({})
    selects[0]!.vm.$emit('update:modelValue', 'A')
    await wrapper.findAll('button').find(button => button.text() === '重新加载')!.trigger('click')
    await flushPromises()
    expect(selects[0]!.props('modelValue')).toBe('')
    store.localFilterResult = null; store.capabilityState = 'ERROR'; store.resultMessage = '历史索引缺失，请重新生成结果。'
    await flushPromises()
    expect(wrapper.text()).toContain('历史索引缺失，请重新生成结果。')
    expect(wrapper.get('[data-testid="report-export"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
  it('精确筛选完成后各页签共用服务端数据，等待期间保留当前页签和已应用数据', async () => {
    const before = structuredClone(LOCAL_QUALITY_REPORT)
    const switchIn: LocalSwitchEvent = { eventId: 'SW-FILTERED', time: 1, demandId: 'D-1', ruleId: null,
      fromDeviceId: 'device-a', toDeviceId: 'device-b', fromLinkId: 'L-1', toLinkId: 'L-2', stableChecks: null }
    before.localEvidence!.switchEvents = [switchIn, { ...switchIn, eventId: 'SW-UNFILTERED', time: 5 }]
    const { localEvidence } = LOCAL_REPORT
    const filter = { linkId: 'L-2', from: 0, to: 1 }
    const after = attachQualityReport({ ...LOCAL_REPORT, localEvidence: {
      ...localEvidence, endTimeS: 1, positionCount: 2, nodes: localEvidence.nodes.map(node =>
        node.platformId === 'A' ? { ...node, positionCount: 1, lastTimeS: 1 } : node),
      eventCount: 1, eventCounts: [localEvidence.eventCounts[1]!], connections: [], switchEvents: [switchIn],
    } }, before.localEvidence!.quality!, filter)
    expect(isLocalReport(before)).toBe(true)
    expect(isLocalReport(after)).toBe(true)
    const record = { resultId: 'RESULT-11111111-1111-4111-8111-111111111111', scenarioId: 'SCN-1', scenarioName: '运行结果', revision: 1,
      startedAt: '2026-09-20T00:00:00Z', completedAt: '2026-09-20T00:00:10Z', runId: 'RUN-1', taskId: 'TASK-1' }
    const shownEvent = { id: 'LOG-L2', type: 'COMM_TURNED_ON', time: 0, subject: 'A' }
    const initialFilter = { filter: {}, stages: [], links: ['L-1', 'L-2'], timelineTotal: 2,
      timeline: [shownEvent, { id: 'LOG-L1', type: 'LINK_ADDED_TO_MANAGER', subject: 'A', target: 'B', time: 5 }] }
    const filtered: LocalReportFilterResult = { ...initialFilter, report: after, filter, timeline: [shownEvent], timelineTotal: 1 }
    let finishFilter!: (result: Response) => void
    const inFlight = new Promise<Response>(resolve => { finishFilter = resolve })
    const fetch = vi.fn().mockResolvedValueOnce(response({ record, report: before, initialFilter })).mockReturnValueOnce(inFlight)
    vi.stubGlobal('fetch', fetch)
    const pinia = createPinia()
    vi.spyOn(useReportStore(pinia), 'loadEvidenceOverview').mockResolvedValue(false)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/reports', component: ReportsPage }] })
    await router.push('/reports?resultId=' + record.resultId)
    const wrapper = mount(ReportsPage, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus], stubs: { MissionResults: true } } })
    const tab = async (label: string) => { await wrapper.get('#tab-' + label).trigger('click'); await flushPromises() }
    const charts = () => wrapper.findAllComponents(ReportChart).map(chart => ({
      ...(chart.props() as { title: string; unit: string; radar?: boolean; scopeSummary?: string; xMin?: number; xMax?: number;
        rows: Array<{ label: string; value: number; displayValue?: string }> }),
      bar: chart.element.closest('#pane-柱状图') !== null,
    }))
    const berChart = () => charts().find(chart => chart.title === '误码率随时间变化')!
    const cards = () => Object.fromEntries(wrapper.get('[data-testid="report-metric-cards"]').findAll('.engine-metric-card')
      .map(card => [card.get('h4').text(), card.get('p').text()]))
    try {
      await flushPromises()
      await tab('折线图')
      expect(berChart().rows).toMatchObject([{ time: 0, value: 0.1 / 3 }, { time: 1, value: 0.1 / 3 }])
      const form = wrapper.get('[aria-label="报告统一筛选"]')
      wrapper.findAllComponents(ElSelect).filter(select => form.element.contains(select.element))[1]!.vm.$emit('update:modelValue', filter.linkId)
      const inputs = wrapper.findAllComponents(ElInputNumber)
      inputs[0]!.vm.$emit('update:modelValue', filter.from)
      inputs[1]!.vm.$emit('update:modelValue', filter.to)
      await flushPromises()
      await form.findAll('button').find(button => button.text() === '应用精确筛选')!.trigger('click')
      await flushPromises()
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(fetch.mock.calls[1]?.[0]).toContain('linkId=L-2&from=0&to=1')
      expect(wrapper.get('#tab-折线图').attributes('aria-selected')).toBe('true')
      expect(wrapper.get('[data-testid="report-applied-filter"]').text()).toContain('全部数据')
      expect(cards()['切换次数']).toBe('2')
      expect(berChart().rows).toMatchObject([{ time: 0, value: 0.1 / 3 }, { time: 1, value: 0.1 / 3 }])

      finishFilter(response(filtered))
      await flushPromises()
      expect(wrapper.get('#tab-折线图').attributes('aria-selected')).toBe('true')
      expect(wrapper.get('[data-testid="report-applied-filter"]').text()).toContain('0～1 秒')
      const filteredCards = cards()
      expect(filteredCards).toMatchObject({ 平均连通时长: '0分0秒', 切换次数: '1', 平均误码率: '1.00e-1' })
      expect(berChart()).toMatchObject({
        scopeSummary: filteredCards['平均误码率'], xMin: 0, xMax: 1,
        rows: [{ time: 0, value: 0.1 }, { time: 1, value: 0.1 }],
      })

      await tab('汇总')
      const summary = wrapper.get('#pane-汇总').findAll('tbody tr').map(row => row.findAll('td').map(cell => cell.text()))
      expect(summary).toContainEqual(['统计范围', '0分0秒～0分1秒'])
      expect(summary).toContainEqual(['事件记录', '1'])
      await tab('链路切换事件')
      const switches = wrapper.get('#pane-链路切换事件').text()
      expect(switches).toContain('SW-FILTERED')
      expect(switches).not.toContain('SW-UNFILTERED')
      await tab('柱状图')
      await tab('雷达图')
      const bars = charts().filter(chart => chart.bar)
      expect(bars.map(chart => chart.unit)).toEqual(['秒', '次', 'dB', '比率', '秒'])
      const barRows = bars.flatMap(chart => chart.rows)
      expect(barRows).toContainEqual({ label: '平均连通时长', value: 0, displayValue: filteredCards['平均连通时长'] })
      expect(bars.find(chart => chart.unit === '比率')?.rows).toEqual([
        { label: '平均误码率', value: 0.1, displayValue: filteredCards['平均误码率'] },
      ])
      expect(bars.find(chart => chart.unit === '次')?.rows).toEqual([
        { label: '切换次数', value: 1, displayValue: filteredCards['切换次数'] },
      ])
      const radarRows = charts().find(chart => chart.radar)!.rows
      expect(radarRows).toContainEqual({ label: '切换次数', value: 95 })
      expect(radarRows).toContainEqual({ label: '平均误码率', value: 0 })
      await tab('事件时间线')
      const timeline = wrapper.get('[data-testid="report-event-timeline"]').text()
      expect(timeline).toContain('LOG-L2')
      expect(timeline).not.toContain('LOG-L1')
    } finally { wrapper.unmount() }
  })

  it('精确筛选时间线非空时不显示空态，柱图声明筛选范围', async () => {
    const wrapper = mount(LocalReportTabs, { props: { evidence: LOCAL_REPORT.localEvidence, preciseFilter: true,
      timeline: [{ id: 'LOG-L1', time: 5, type: 'LINK_ADDED_TO_MANAGER', subject: 'A', target: 'B' }], timelineTotal: 1 },
      global: { plugins: [ElementPlus] } })
    await wrapper.findAll('.el-tabs__item').find(tab => tab.text() === '事件时间线')!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="report-event-timeline"]').text()).toContain('LOG-L1')
    expect(wrapper.findAll('.el-empty').some(empty => empty.text().includes('暂无符合条件的数据'))).toBe(false)
    await wrapper.findAll('.el-tabs__item').find(tab => tab.text() === '柱状图')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('五项评估指标')
    wrapper.unmount()
  })
  it('把已导入质量切换合并到时间线，并保留方向、原因和文件来源', async () => {
    const report = structuredClone(LOCAL_QUALITY_REPORT)
    report.localEvidence!.quality!.switchEvents = [{
      eventId: 'SW-QUALITY-1', frameId: 4 as never, time: 4, type: 'LINK_SWITCH', direction: 'FORWARD',
      oldLinkId: 'L-1', newLinkId: 'L-2', oldBer: 0.1, newBer: 0.01, stabilityFrames: 3,
      minimumStableFrames: 2, hysteresisSatisfied: true, cooldownRemainingS: 0,
      decision: 'ACCEPTED', reason: 'BER_IMPROVED', dedupeKey: 'source-switch-1',
    }]
    const wrapper = mount(LocalReportTabs, { props: { evidence: report.localEvidence }, global: { plugins: [ElementPlus] } })
    await wrapper.findAll('.el-tabs__item').find(tab => tab.text() === '事件时间线')!.trigger('click')
    await flushPromises()
    const text = wrapper.get('[data-testid="report-event-timeline"]').text()
    expect(text).toContain('SW-QUALITY-1')
    expect(text).toContain('FORWARD')
    expect(text).toContain('BER_IMPROVED')
    expect(text).toContain('quality.csv')
    wrapper.unmount()
  })
  it('本地节点或通信关联筛选不猜测质量切换端点', async () => {
    const report = structuredClone(LOCAL_QUALITY_REPORT)
    report.localEvidence!.quality!.switchEvents = [{
      eventId: 'SW-QUALITY-A', frameId: 4 as never, time: 4, type: 'LINK_SWITCH', direction: 'FORWARD',
      oldLinkId: 'L-1', newLinkId: 'L-2', oldBer: 0.1, newBer: 0.01, stabilityFrames: 3,
      minimumStableFrames: 2, hysteresisSatisfied: true, cooldownRemainingS: 0,
      decision: 'ACCEPTED', reason: 'BER_IMPROVED', dedupeKey: 'source-switch-a',
    }, {
      eventId: 'SW-QUALITY-UNKNOWN', frameId: 5 as never, time: 5, type: 'LINK_SWITCH', direction: 'FORWARD',
      oldLinkId: 'L-UNKNOWN', newLinkId: 'L-OTHER', oldBer: 0.1, newBer: 0.01, stabilityFrames: 3,
      minimumStableFrames: 2, hysteresisSatisfied: true, cooldownRemainingS: 0,
      decision: 'ACCEPTED', reason: 'BER_IMPROVED', dedupeKey: 'source-switch-unknown',
    }]
    const wrapper = mount(LocalReportTabs, { props: { evidence: report.localEvidence }, global: { plugins: [ElementPlus] } })
    await wrapper.findAll('.el-tabs__item').find(tab => tab.text() === '事件时间线')!.trigger('click')
    await flushPromises()
    wrapper.findAllComponents(ElSelect).find(select => select.attributes('data-testid') === 'report-filter-node')!.vm.$emit('update:modelValue', 'A')
    await flushPromises()
    const text = wrapper.get('[data-testid="report-event-timeline"]').text()
    expect(text).toContain('SW-QUALITY-A')
    expect(text).not.toContain('SW-QUALITY-UNKNOWN')
    wrapper.unmount()
  })
  it('引擎归档明确标注截断，并把可验证的切换和事件源字段并入统一时间线', async () => {
    const report = structuredClone(LOCAL_REPORT)
    report.localEvidence!.engineFrameArchive = {
      sourceSha256: 'a'.repeat(64), frameCount: 99, firstSimulationTime: 1, lastSimulationTime: 9, missingFieldNames: [], detailTruncated: true, retainedDetailRows: 2,
      aggregate: { uniqueSingleSegmentCount: 2, averageGxbDb: 4.25, averageBer: 0.0025, switchCount: 3, missing: ['connectivityDurationS', 'interferenceDurationS'] },
      segmentRows: [{ engineEpoch: 1, frameId: 7, simulationTime: 4, segment: {
        linkId: 'SEG-A', linkIds: ['L-1'], sourceName: 'A', sourcePlatformId: 'A', sourcePort: 'OUT', targetName: 'B', targetPlatformId: 'B', targetPort: 'IN',
        status: 'UP', engineStatus: 'AVAILABLE', error: null, distanceM: null,
        losses: { freeSpaceDb: null, seaMultipathDb: null, atmosphericDb: null, cloudRainDb: null, jammingDb: null, totalDb: null },
        quality: { gxbDb: null, ber: null, rxPowerDbw: null, rxPowerDbm: null }, inputTrace: { eirpDbw: null, gtDbk: null, dataRateMbps: null, frequencyGHz: null, jammers: [] },
      }}],
      switchRows: [{ engineEpoch: 1, frameId: 7, simulationTime: 4, value: {
        pathId: 'PATH-NEW', direction: 'FORWARD', sourceName: 'A', targetName: 'C', sourcePlatformId: 'A', targetPlatformId: 'C', transTypes: ['任务'],
        oldPathId: 'PATH-OLD', oldNodes: [{ platformName: 'A', platformId: 'A', inPort: '', outPort: 'OUT' }, { platformName: 'B', platformId: 'B', inPort: 'IN', outPort: '' }],
        nodes: [{ platformName: 'A', platformId: 'A', inPort: '', outPort: 'OUT2' }, { platformName: 'C', platformId: 'C', inPort: 'IN2', outPort: '' }], reasons: [{ linkId: 'SEG-A', reasons: ['ber_switch'] }],
      }}],
      eventRows: [{ engineEpoch: 1, frameId: 7, simulationTime: 4, value: { type: 'JAM_ON', pathId: 'PATH-NEW', uavNames: ['A'], jammerNames: ['J'], uavIds: ['A'], jammerIds: ['J'] }}],
    } as never
    // 同帧同路径但不同方向/目标的原始行不得被 UI 时间线去重。
    const archive = report.localEvidence!.engineFrameArchive as unknown as EngineFrameArchiveSummary
    archive.switchRows.push({ engineEpoch: 1, frameId: 7, simulationTime: 4, value: {
      ...structuredClone(archive.switchRows[0]!.value), direction: 'REVERSE', sourcePlatformId: 'C', targetPlatformId: 'A',
    } })
    archive.eventRows.push({ engineEpoch: 1, frameId: 7, simulationTime: 4, value: {
      type: 'JAM_ON', pathId: 'PATH-NEW', uavNames: ['C'], jammerNames: ['K'], uavIds: ['C'], jammerIds: ['K'],
    } })
    const wrapper = mount(LocalReportTabs, { props: { evidence: report.localEvidence }, global: { plugins: [ElementPlus] } })
    const cards = wrapper.get('[data-testid="report-metric-cards"]')
    expect(cards.text()).not.toContain('平均GXB')
    expect(cards.text()).not.toContain('唯一单段有效样本')
    expect(cards.text()).toContain('2.50e-3')
    expect(cards.text()).toContain('3（引擎实际记录）')
    expect(wrapper.find('[data-testid="engine-archive-truncated"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="report-details"]').exists()).toBe(false)
    await wrapper.findAll('.el-tabs__item').find(tab => tab.text() === '事件时间线')!.trigger('click'); await flushPromises()
    const timeline = wrapper.get('[data-testid="report-event-timeline"]')
    expect(timeline.text()).toContain('引擎路径切换')
    expect(timeline.text()).toContain('PATH-OLD')
    expect(timeline.text()).toContain('ber_switch')
    expect(timeline.text()).toContain('源轮次/帧/时刻：1/7/4')
    expect(timeline.text()).toContain('引擎事件')
    expect(timeline.findAll('li').filter(item => item.text().includes('引擎路径切换'))).toHaveLength(2)
    expect(timeline.findAll('li').filter(item => item.text().includes('引擎事件'))).toHaveLength(2)
    wrapper.unmount()
  })
  it('结果绑定的引擎归档从已有受权端点下载完整 JSONL', async () => {
    const pinia = createPinia(); setActivePinia(pinia)
    const report = structuredClone(LOCAL_REPORT)
    report.localEvidence!.engineFrameArchive = { sourceSha256: 'b'.repeat(64), frameCount: 2, firstSimulationTime: 1, lastSimulationTime: 2,
      missingFieldNames: [], segmentRows: [], switchRows: [], eventRows: [], detailTruncated: true, retainedDetailRows: 0 } as never
    const record = { resultId: 'RESULT-11111111-1111-4111-8111-111111111111', scenarioId: 'SCN-001', scenarioName: '运行结果', revision: 1, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:10Z' }
    const store = useReportStore()
    store.$patch({ selectedReport: report, reports: [report], resultSource: record, localFilterResult: { report, filter: {}, timeline: [], timelineTotal: 0, stages: [], links: [] }, capabilityState: 'SUCCESS' })
    vi.spyOn(store, 'load').mockResolvedValue(true); vi.spyOn(store, 'applyLocalFilter').mockResolvedValue(true)
    const createUrl = vi.fn(() => 'blob:engine-frames')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const attachment = { ok: true, headers: new Headers({ 'Content-Disposition': 'attachment; filename="engine.jsonl"' }), blob: async () => new Blob(['{}']) } as Response
    const fetch = vi.fn().mockResolvedValue(attachment); vi.stubGlobal('fetch', fetch)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/reports', component: ReportsPage }] })
    await router.push('/reports'); await router.isReady()
    const wrapper = mount(ReportsPage, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus], stubs: { MissionResults: true } } })
    await flushPromises()
    await wrapper.get('[data-testid="report-data-export"]').trigger('click'); await flushPromises()
    document.querySelector<HTMLElement>('[data-testid="engine-frame-archive-download"]')!.click(); await flushPromises()
    expect(fetch.mock.calls[0]![0]).toContain(`/api/v1/mission-results/${record.resultId}/engine-frames/${'b'.repeat(64)}`)
    expect(click).toHaveBeenCalledOnce(); expect(createUrl).toHaveBeenCalledOnce()
    wrapper.unmount()
  })
  it('结果绑定的已生成规范 CSV 可点击下载，部分覆盖状态不伪装为完整', async () => {
    const pinia = createPinia(); setActivePinia(pinia)
    const report = structuredClone(LOCAL_REPORT)
    report.localEvidence!.engineCsv = { sourceSha256: 'c'.repeat(64), files: [{ fileName: 'link_state.csv', rowCount: 12, sha256: 'd'.repeat(64), status: 'PARTIAL', skippedCount: 2, reason: '缺少唯一逻辑链路。' }], missing: [{ fileName: 'link_quality.csv', status: 'SOURCE_MISSING', reason: '缺少 SNR。' }] } as never
    const record = { resultId: 'RESULT-11111111-1111-4111-8111-111111111111', scenarioId: 'SCN-001', scenarioName: '运行结果', revision: 1, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:10Z' }
    const store = useReportStore()
    store.$patch({ selectedReport: report, reports: [report], resultSource: record, localFilterResult: { report, filter: {}, timeline: [], timelineTotal: 0, stages: [], links: [] }, capabilityState: 'SUCCESS' })
    vi.spyOn(store, 'load').mockResolvedValue(true); vi.spyOn(store, 'applyLocalFilter').mockResolvedValue(true)
    vi.spyOn(store, 'loadEvidenceOverview').mockResolvedValue(false)
    const createUrl = vi.fn(() => 'blob:engine-csv')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const attachment = { ok: true, headers: new Headers({ 'Content-Disposition': 'attachment; filename="link_state.csv"' }), blob: async () => new Blob(['task_id']) } as Response
    const fetch = vi.fn().mockResolvedValue(attachment); vi.stubGlobal('fetch', fetch)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/reports', component: ReportsPage }] })
    await router.push('/reports'); await router.isReady()
    const wrapper = mount(ReportsPage, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus], stubs: { MissionResults: true } } })
    await flushPromises()
    await wrapper.get('[data-testid="report-data-export"]').trigger('click'); await flushPromises()
    const item = document.querySelector<HTMLElement>('[data-testid="engine-csv-download"]')!
    expect(item.textContent?.trim()).toBe('下载 link_state.csv')
    expect(item.getAttribute('title')).toBe('缺少唯一逻辑链路。')
    item.click(); await flushPromises()
    expect(fetch.mock.calls[0]![0]).toContain(`/api/v1/mission-results/${record.resultId}/engine-csv/link_state.csv`)
    expect(click).toHaveBeenCalledOnce(); expect(createUrl).toHaveBeenCalledOnce()
    wrapper.unmount()
  })
  it('有导出权限时不提供浏览器打印，但提供服务端真实 PDF 导出', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const principal = { userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'ORDINARY_REPORT_EXPORT'] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ authenticated: true, sessionCreated: false, principal }))
      .mockResolvedValueOnce(response([LOCAL_REPORT])).mockResolvedValueOnce(response(LOCAL_REPORT)))
    expect((await useAuthStore().login({ username: 'operator', password: '123456' })).authenticated).toBe(true)
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/reports', component: ReportsPage }] })
    await router.push('/reports')
    const wrapper = mount(ReportsPage, { global: { plugins: [pinia, router, ElementPlus] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="report-print-pdf"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('打印当前视图')
    expect(wrapper.text()).not.toContain('另存 PDF')
    await wrapper.get('input[aria-label="导出格式"]').trigger('click'); await flushPromises()
    expect(document.body.textContent).toContain('PDF')
    expect(wrapper.get('[data-testid="report-export"]').text()).toBe('导出报告')
    expect(print).not.toHaveBeenCalled()
    expect(useReportStore().exportResult).toBeNull()
    useAuthStore().resetToSafeEmpty()
    await flushPromises()
    expect(wrapper.find('[data-testid="report-print-pdf"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('真实 Store 加载、各页签、浏览器下载；不请求 Mock 遥测或批次', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const attachment = { ok: true, headers: new Headers({ 'Content-Disposition': 'attachment; filename="report.html"' }), blob: async () => new Blob(['<html>report</html>']) } as Response
    const createUrl = vi.fn(() => 'blob:report-download')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const fetch = vi.fn().mockResolvedValueOnce(response([LOCAL_REPORT])).mockResolvedValueOnce(response(LOCAL_REPORT)).mockResolvedValueOnce(attachment)
    vi.stubGlobal('fetch', fetch)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/reports', component: ReportsPage }] })
    await router.push('/reports'); await router.isReady()
    const wrapper = mount(ReportsPage, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus] } })
    await flushPromises()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="report-export"]').text()).toBe('导出报告')
    expect(wrapper.text()).not.toContain('来源为本地 CSV 快照；未绑定场景或运行编号。')
    expect(wrapper.text()).toContain('0分10秒')
    expect(wrapper.find('[data-testid="report-details"]').exists()).toBe(false)
    for (const tab of wrapper.findAll('.el-tabs__item')) { await tab.trigger('click'); await flushPromises() }
    expect(wrapper.text()).toContain('暂无数据')
    // 链路质量曲线无测量时只显示暂无数据；汇总按大纲列出评估指标，缺数据同样显示暂无数据。
    expect(wrapper.get('[data-testid="report-quality-curves"]').text()).toBe('暂无数据')
    for (const label of ['平均连通时长', '切换次数', '平均干信比', '平均误码率', '干扰持续时长']) expect(wrapper.text()).toContain(label)
    expect(wrapper.text()).toContain('链路切换事件')
    expect(wrapper.text()).not.toContain('不使用 Mock 补齐')
    await wrapper.get('[data-testid="report-export"]').trigger('click')
    await flushPromises()
    expect(click).toHaveBeenCalledOnce()
    expect(createUrl).toHaveBeenCalledOnce()
    expect(fetch.mock.calls.at(-1)?.[0]).toContain('download=1')
    expect(useReportStore().resultMessage).toContain('已发起报告下载')
    expect(wrapper.find('[data-testid="local-report-export-result"]').exists()).toBe(false)
    expect(fetch.mock.calls.every(call => String(call[0]).includes('/api/v1/reports'))).toBe(true)
    wrapper.unmount()
    expect(useReportStore().selectedReport).toBeNull()
  })
  it('失败清空报告；来源不符/假生成状态拒绝；重置后迟到导出不回写', async () => {
    setActivePinia(createPinia())
    const store = useReportStore()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const output of [{ ...LOCAL_EXPORT, reportId: `RPT-LOCAL-${'e'.repeat(64)}` }, { ...LOCAL_EXPORT, format: 'CSV' },
      { reportId: LOCAL_REPORT.reportId, generated: false, status: 'FIXTURE_SUCCESS', watermark: 'mock', verifiedAt: LOCAL_EXPORT.verifiedAt }]) {
      fetch.mockResolvedValueOnce(response(LOCAL_REPORT)).mockResolvedValueOnce(response(output))
      expect(await store.selectReport(LOCAL_REPORT.reportId)).toBe(true)
      expect(await store.requestExport('HTML')).toBe(false)
      expect(store.capabilityState).toBe('ERROR')
      expect(store.exportResult).toBeNull()
    }
    fetch.mockResolvedValueOnce(response(LOCAL_REPORT))
    await store.selectReport(LOCAL_REPORT.reportId)
    let resolve!: (response: Response) => void
    fetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done }))
    const pending = store.requestExport('HTML')
    store.resetToSafeEmpty()
    resolve(response(LOCAL_EXPORT))
    expect(await pending).toBe(false)
    expect(store.exportResult).toBeNull()
  })
  it('所有报告子集合闭合，拒绝畸形数值、身份、哈希、重复与多余字段', () => {
    expect(isReport(LOCAL_REPORT)).toBe(true)
    expect(isLocalReportExport(LOCAL_EXPORT)).toBe(true)
    const changes: Array<(r: typeof LOCAL_REPORT) => void> = [
      r => { r.localEvidence.eventFile.sha256 = '' }, r => { r.localEvidence.endTimeS = -1 },
      r => { r.localEvidence.positionCount++ }, r => { r.localEvidence.eventCount++ },
      r => { r.localEvidence.nodes.push(r.localEvidence.nodes[0]!) }, r => { r.localEvidence.nodes[0]!.name = '' },
      r => { r.localEvidence.eventCounts.push(r.localEvidence.eventCounts[0]!) }, r => { r.localEvidence.eventCounts[0]!.count = 0 },
      r => { r.localEvidence.connections[0]!.targetPlatformId = 'unknown' }, r => { r.localEvidence.connections[0]!.time = 20 },
      r => { r.localEvidence.connections.push(r.localEvidence.connections[0]!) }, r => { r.localEvidence.connections[0]!.sourceDeviceId = '' },
      r => { r.localEvidence.deviceEvents[0]!.type = 'unknown' }, r => { r.localEvidence.deviceEvents[0]!.platformId = 'unknown' },
      r => { r.localEvidence.deviceEvents.push(r.localEvidence.deviceEvents[0]!) }, r => { r.localEvidence.nodes = [] },
    ]
    for (const change of changes) { const report = structuredClone(LOCAL_REPORT); change(report); expect(isLocalReport(report)).toBe(false) }
    for (const value of [null, [], {}, { ...LOCAL_REPORT, runId: 'RUN-001' }, { ...LOCAL_REPORT, generatedTime: 'bad' }]) expect(isLocalReport(value)).toBe(false)
    for (const value of [null, {}, { ...LOCAL_EXPORT, extra: true }, { ...LOCAL_EXPORT, sha256: '' }, { ...LOCAL_EXPORT, filePath: '' }]) expect(isLocalReportExport(value)).toBe(false)
    const partial = structuredClone(LOCAL_REPORT.localEvidence)
    partial.simulationComplete = false; partial.waitingForPositionLine = true; partial.nodes[0]!.positionCount = 0
    expect(JSON.stringify(localReportTables(partial))).toContain('当前快照')
  })
  it.each([undefined, 'PROJECT_REFERENCE'] as const)('弹窗展示已保存参数、可读时间和配置来源 %s', async source => {
    const links = [
      { id: 'L-1', type: 'MICROWAVE' },
      { id: 'fiber_forward', type: 'FIBER' },
      { id: 'fiber_return', type: 'FIBER' },
      { id: 'c_forward_command_relay', type: 'DATALINK' },
    ].map(link => ({ ...link, frequencyMHz: 8200, bandwidthMHz: 30, txPowerW: 45 }))
    const jammers = ['J-1', 'ground_jammer', 'airborne_jammer']
      .map(id => ({ id, frequencyMHz: 2400, bandwidthMHz: 50, defaultPowerW: 200 }))
    const current: MissionResultParameterComparison = {
      record: { resultId: 'RESULT-00000000-0000-0000-0000-000000000001', scenarioId: 'SCN-001', scenarioName: '参数对比', revision: 2, startedAt: '2026-09-20T00:00:00Z', completedAt: '2026-09-20T00:01:00Z' },
      parameters: { source, scenarioId: 'SCN-001', revision: 2, platformCount: 2, linkCount: links.length, jammerCount: jammers.length, links, jammers },
    }
    const historicalResultId = 'RESULT-00000000-0000-0000-0000-000000000002'
    const historical = {
      record: { ...current.record, resultId: historicalResultId, scenarioId: 'SCN-002' },
      parameters: { ...current.parameters, scenarioId: 'SCN-002', linkCount: 0, jammerCount: 0, links: [], jammers: [] },
    }
    const wrapper = mount(LocalReportTabs, {
      attachTo: document.body,
      props: { evidence: LOCAL_REPORT.localEvidence, currentResultId: current.record.resultId, comparison: [historical, current] },
      global: { plugins: [ElementPlus] },
    })
    try {
      const trigger = wrapper.get('.report-summary-actions').get('[data-testid="report-parameter-comparison"]')
      expect(trigger.text()).toBe('运行参数对比')
      expect(document.querySelector('[role="dialog"][aria-label="运行参数对比"] .el-dialog')).toBeNull()
      await trigger.trigger('click')
      await flushPromises()
      const dialog = document.querySelector('[role="dialog"][aria-label="运行参数对比"]')
      const full = dialog?.querySelector<HTMLDetailsElement>('[data-testid="run-parameter-full"]')
      expect(full?.open).toBe(true)
      const table = full?.querySelector('[data-testid="completed-result-parameter-comparison"]')
      const rows = [...(table?.querySelectorAll('tbody > tr') ?? [])].map(row => row.textContent ?? '')
      expect(rows.find(row => row.includes(current.record.resultId))).toContain('本次运行')
      const historyRow = rows.find(row => row.includes(historicalResultId))
      expect(historyRow).toContain('历史运行')
      expect(historyRow).toContain('无链路参数')
      expect(historyRow).toContain('无干扰机参数')
      expect(table?.textContent).toContain(formatDateTime(current.record.completedAt))
      const items = [...(table?.querySelectorAll('li') ?? [])]
      for (const [id, title] of [
        ['fiber_forward', '光纤链路 · 前向'],
        ['fiber_return', '光纤链路 · 返向'],
        ['c_forward_command_relay', 'C 波段数传链路 · 前向 · 指挥车与中继节点'],
        ['ground_jammer', '地面干扰机'],
        ['airborne_jammer', '机载干扰机'],
        ['L-1', '微波链路 1'],
        ['J-1', '干扰机 1'],
      ]) {
        const item = items.find(element => element.textContent?.includes('编号 ' + id))
        expect(item?.querySelector('strong')?.textContent).toBe(title)
      }
      for (const parameter of ['频率 8200 MHz', '带宽 30 MHz', '发射功率 45 W', '默认功率 200 W']) {
        expect(table?.textContent).toContain(parameter)
      }
      expect(table?.textContent).toContain(source ? '项目参考配置' : '运行时保存的配置')
      if (source) expect(table?.textContent).toContain('未确认引擎实际执行版本')
    } finally { wrapper.unmount() }
  })
  it('并排比较同场景最近运行，可显示全部参数及切换对照', async () => {
    const snapshot = (id: string, completedAt: string, platformCount: number, scenarioId = 'SCN-001'): MissionResultParameterComparison => ({
      record: {
        resultId: id, scenarioId: 'SCN-FILE', scenarioName: '文件接收', revision: 1, startedAt: '2026-09-20T00:00:00Z',
        completedAt, executionSource: 'REMOTE_WS', runId: 'RUN-001', taskId: 'TASK-001',
      },
      parameters: { source: 'PROJECT_REFERENCE', scenarioId, revision: 1, platformCount, linkCount: 0, jammerCount: 0, links: [], jammers: [] },
    })
    const current = snapshot('RESULT-00000000-0000-0000-0000-000000000001', '2026-09-20T00:04:00Z', 5)
    const same = snapshot('RESULT-00000000-0000-0000-0000-000000000002', '2026-09-20T00:01:00Z', 5)
    const recent = snapshot('RESULT-00000000-0000-0000-0000-000000000003', '2026-09-20T00:02:00Z', 4)
    const unrelated = snapshot('RESULT-00000000-0000-0000-0000-000000000004', '2026-09-20T00:03:00Z', 3, 'SCN-002')
    const wrapper: VueWrapper = mount(LocalReportTabs, {
      attachTo: document.body,
      props: { evidence: LOCAL_REPORT.localEvidence, currentResultId: current.record.resultId, comparison: [current] },
      global: { plugins: [ElementPlus] },
    })
    try {
      await wrapper.get('[data-testid="report-parameter-comparison"]').trigger('click')
      await flushPromises()
      const dialog = document.querySelector('[role="dialog"][aria-label="运行参数对比"]')
      const status = () => dialog?.querySelector('[data-testid="run-parameter-difference-status"]')?.textContent
      const differences = () => dialog?.querySelector('[data-testid="run-parameter-differences"]')
      expect(status()).toContain('没有同场景的历史参数快照可对比。')
      expect(dialog?.querySelector<HTMLDetailsElement>('[data-testid="run-parameter-full"]')?.open).toBe(true)

      await wrapper.setProps({ comparison: [same, unrelated, current, recent] })
      await flushPromises()
      const select = wrapper.findAllComponents(ElSelect).find(item => item.attributes('data-testid') === 'run-parameter-history')!
      expect(select.props('modelValue')).toBe(recent.record.resultId)
      const values = select.findAllComponents({ name: 'ElOption' }).map(option => option.props('value'))
      expect(values).toHaveLength(2)
      expect(values).toContain(same.record.resultId)
      expect(values).not.toContain(unrelated.record.resultId)
      expect(status()).toContain('共 1 项差异')
      const reference = () => differences()?.querySelector('th[data-testid="run-parameter-reference"]')?.textContent
      const selected = differences()?.querySelector('th[data-testid="run-parameter-current"]')?.textContent
      expect(differences()?.querySelectorAll('thead th')).toHaveLength(2)
      for (const [info, title, run] of [[reference(), '对照运行', recent], [selected, '本次运行', current]] as const) {
        expect(info).toContain(title)
        expect(info).toContain(run.record.resultId)
        expect(info).toContain(formatDateTime(run.record.completedAt))
        expect(info).toContain('项目参考配置')
      }
      const rows = () => [...(differences()?.querySelectorAll<HTMLTableRowElement>('tbody tr') ?? [])]
      expect(rows()).toHaveLength(1)
      const cells = [...rows()[0]!.cells]
      expect(cells).toHaveLength(2)
      expect(cells.every(cell => cell.textContent?.includes('节点数'))).toBe(true)
      expect(cells.map(cell => cell.querySelector('.comparison-value')?.textContent?.trim())).toEqual(['4', '5'])
      expect(dialog?.querySelector('[data-testid="run-parameter-full"]')).toBeNull()

      const showAll = [...(dialog?.querySelectorAll('label') ?? [])].find(label => label.textContent?.includes('显示全部参数'))
        ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
      expect(showAll?.checked).toBe(false)
      showAll?.click()
      await flushPromises()
      const unchanged = rows().find(row => row.textContent?.includes('链路数'))
      expect([...(unchanged?.cells ?? [])].map(cell => cell.querySelector('.comparison-value')?.textContent?.trim())).toEqual(['0', '0'])
      expect(rows().every(row => row.cells.length === 2)).toBe(true)
      showAll?.click()
      await flushPromises()
      expect(rows()).toHaveLength(1)

      select.vm.$emit('update:modelValue', same.record.resultId)
      await flushPromises()
      expect(status()).toContain('两次运行的参数对比项一致。')
      expect(reference()).toContain(same.record.resultId)
      expect(rows()).toHaveLength(0)

      await wrapper.setProps({ comparison: [same] })
      expect(status()).toContain('本次运行未保存参数快照，无法对比。')
    } finally { wrapper.unmount() }
  })
})

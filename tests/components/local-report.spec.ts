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
import { LOCAL_REPORT, LOCAL_EXPORT, LOCAL_QUALITY_REPORT } from '../fixtures/local-report'
import type { EngineFrameArchiveSummary } from '../../src/contracts/domain-models'
import { STEP_FIVE_REPORT } from '../fixtures/engine-frame/step-five-report'
import { LATEST_FRAME_REPORT } from '../fixtures/engine-frame/latest-report'

const response = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) }) as Response
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })
describe('本地文件报告页面与信任边界', () => {
  it('最新报文的极小 BER 曲线保留变化，报表可展开全部接收参数', async () => {
    const wrapper = mount(LocalReportTabs, { props: { evidence: LATEST_FRAME_REPORT.localEvidence }, global: { plugins: [ElementPlus] } })
    try {
      await wrapper.get('#tab-引擎链路段实测').trigger('click'); await flushPromises()
      const chart = wrapper.findAllComponents(ReportChart).find(chart => chart.get('h4').text().includes('BER'))!
      expect(new Set(chart.findAll('circle').map(point => point.attributes('cy'))).size).toBe(2)
      await wrapper.findAll('.el-table__expand-icon')[1]!.trigger('click'); await flushPromises()
      const details = wrapper.get('[data-testid="engine-segment-details"]')
      for (const value of ['雨衰', '云衰', '44.092173718306995', '8.2', '80', '30', '-3', '0.3433178367922316', 'jammer_station_01', '144.5182955065433', '单位待确认', '口径待确认']) expect(details.text()).toContain(value)
    } finally { wrapper.unmount() }
  })
  it('引擎曲线连通5→10→15，仅在缺少20的25之前断开', async () => {
    const wrapper = mount(LocalReportTabs, { props: { evidence: STEP_FIVE_REPORT.localEvidence }, global: { plugins: [ElementPlus] } })
    try {
      await wrapper.findAll('.el-tabs__item').find(tab => tab.text() === '引擎链路段实测')!.trigger('click'); await flushPromises()
      const charts = wrapper.findAllComponents(ReportChart).filter(chart => chart.get('h4').text().startsWith('引擎段'))
      expect(charts).toHaveLength(2)
      for (const chart of charts) {
        expect(chart.findAll('polyline').map(line => line.attributes('points')!.trim().split(/\s+/).length)).toEqual([3, 1])
        expect(chart.findAll('circle')).toHaveLength(4)
      }
    } finally { wrapper.unmount() }
  })

  it('质量曲线、柱状图与雷达图独立，图表注明来源、已应用范围和生成时刻', async () => {
    const wrapper: VueWrapper = mount(LocalReportTabs, { props: { evidence: LOCAL_QUALITY_REPORT.localEvidence!, generatedTime: LOCAL_QUALITY_REPORT.generatedTime }, global: { plugins: [ElementPlus] } })
    const tabs = wrapper.findAll('.el-tabs__item').map(tab => tab.text())
    expect(tabs.indexOf('雷达图')).toBe(tabs.indexOf('柱状图') + 1)
    await wrapper.get('#tab-链路质量与曲线').trigger('click'); await flushPromises()
    expect(wrapper.findAllComponents(ReportChart)).toHaveLength(6)
    expect(wrapper.findAllComponents(ReportChart).every(chart => /GXB|误码率/.test(chart.get('h4').text()))).toBe(true)
    expect(wrapper.find('polygon').exists()).toBe(false)
    await wrapper.get('#tab-柱状图').trigger('click'); await flushPromises()
    const bars = wrapper.get('[data-testid="report-bar-charts"]')
    expect(bars.text()).toContain('scenario_events.csv · 完整快照 · 0分0秒～0分10秒')
    expect(bars.text()).toContain(`生成时刻 ${formatDateTime(LOCAL_REPORT.generatedTime)}`)
    await wrapper.get('#tab-雷达图').trigger('click'); await flushPromises()
    const radar = wrapper.get('[data-testid="report-radar-chart"]')
    expect(radar.text()).toContain('quality.csv · 完整快照')
    expect(radar.text()).toContain(`生成时刻 ${formatDateTime(LOCAL_REPORT.generatedTime)}`)
    expect(radar.findAll('li').map(row => row.text())).toEqual(['L-1：100 %', 'L-2：0 %', 'L-3：100 %'])
    await wrapper.setProps({ preciseFilter: true, filter: { nodeId: 'A', linkId: 'L-1', stage: 'PH-1', from: 0, to: 1 } })
    expect(radar.text()).toContain('quality.csv · 筛选范围 · 0分0秒～0分1秒 · 节点 A · 链路 L-1 · 阶段 PH-1')
    await wrapper.setProps({ evidence: LOCAL_REPORT.localEvidence })
    expect(radar.text()).toBe('暂无数据')
    wrapper.unmount()
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
    const wrapper = mount(ReportsPage, { global: { plugins: [pinia, router, ElementPlus], stubs: { MissionResults: true } } })
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
    expect(selects[2]!.props('disabled')).toBe(true)
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
    expect(wrapper.text()).toContain('筛选范围事件记录数')
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
    const cards = wrapper.get('[data-testid="engine-aggregate-cards"]')
    expect(cards.text()).toContain('引擎完整流唯一单段有效样本')
    expect(cards.text()).toContain('2 条')
    expect(cards.text()).toContain('4.25 dB（唯一单段实测）')
    expect(cards.text()).toContain('2.50e-3')
    expect(cards.text()).toContain('3 条（引擎实际记录，不代表成功率）')
    expect(wrapper.text()).toContain('引擎完整流平均GXB')
    expect(wrapper.text()).toContain('引擎路由切换记录')
    await wrapper.findAll('.el-tabs__item').find(tab => tab.text() === '引擎链路段实测')!.trigger('click'); await flushPromises()
    expect(wrapper.get('[data-testid="engine-archive-truncated"]').text()).toContain('完整归档流汇总仍有效')
    expect(wrapper.text()).toContain('非全量统计')
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
    const wrapper = mount(ReportsPage, { global: { plugins: [pinia, router, ElementPlus], stubs: { MissionResults: true } } })
    await flushPromises(); await wrapper.get('[data-testid="engine-frame-archive-download"]').trigger('click'); await flushPromises()
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
    const createUrl = vi.fn(() => 'blob:engine-csv')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const attachment = { ok: true, headers: new Headers({ 'Content-Disposition': 'attachment; filename="link_state.csv"' }), blob: async () => new Blob(['task_id']) } as Response
    const fetch = vi.fn().mockResolvedValue(attachment); vi.stubGlobal('fetch', fetch)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/reports', component: ReportsPage }] })
    await router.push('/reports'); await router.isReady()
    const wrapper = mount(ReportsPage, { global: { plugins: [pinia, router, ElementPlus], stubs: { MissionResults: true } } })
    await flushPromises()
    await wrapper.findAll('.el-tabs__item').find(tab => tab.text() === '引擎链路段实测')!.trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('PARTIAL · 12 行；跳过 2 行')
    await wrapper.get('[data-testid="engine-csv-download"]').trigger('click'); await flushPromises()
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
    expect(wrapper.get('[data-testid="report-export"]').text()).toBe('导出完整报告')
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
    expect(wrapper.text()).toContain('scenario_events.csv')
    expect(wrapper.get('[data-testid="report-export"]').text()).toBe('导出完整报告')
    expect(wrapper.text()).not.toContain('来源为本地 CSV 快照；未绑定场景或运行编号。')
    expect(wrapper.text()).toContain('0分10秒')
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
  it('只展示完成时冻结的已保存参数，不把缺失质量指标补为数值', async () => {
    const wrapper = mount(LocalReportTabs, { props: { evidence: LOCAL_REPORT.localEvidence, comparison: [{
      record: { resultId: 'RESULT-00000000-0000-0000-0000-000000000001', scenarioId: 'SCN-001', scenarioName: '参数对比', revision: 2, startedAt: '2026-09-20T00:00:00Z', completedAt: '2026-09-20T00:01:00Z' },
      parameters: { scenarioId: 'SCN-001', revision: 2, platformCount: 2, linkCount: 1, jammerCount: 1,
        links: [{ id: 'L-1', type: 'MICROWAVE', frequencyMHz: 8200, bandwidthMHz: 30, txPowerW: 45 }],
        jammers: [{ id: 'J-1', frequencyMHz: 2400, bandwidthMHz: 50, defaultPowerW: 200 }] },
    }] }, global: { plugins: [ElementPlus] } })
    await wrapper.findAll('.el-tabs__item').find(tab => tab.text().includes('已完成运行参数对比'))!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="completed-result-parameter-comparison"]').text()).toContain('8200MHz/30MHz/45W')
    expect(wrapper.text()).toContain('质量指标仍为暂无数据')
  })
})

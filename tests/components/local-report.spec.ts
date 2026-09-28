import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReportsPage from '../../src/pages/reports/reports.vue'
import { useReportStore, isReport } from '../../src/stores/report'
import { useAuthStore } from '../../src/stores/auth'
import { isLocalReport, isLocalReportExport, localReportTables } from '../../src/features/reports/local-report'
import { LOCAL_REPORT, LOCAL_EXPORT } from '../fixtures/local-report'

const response = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) }) as Response
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })
describe('本地文件报告页面与信任边界', () => {
  it('有导出权限时也不再提供打印或另存 PDF 入口，保留完整报告导出', async () => {
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
    expect(wrapper.text()).toContain('当前文件未提供干信比、SNR、BER、接收功率、时延和可用率测量。')
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
})

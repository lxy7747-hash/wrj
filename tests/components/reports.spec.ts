import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import ReportTabs from '../../src/components/reports/ReportTabs.vue'
import ReportsPage from '../../src/pages/reports/reports.vue'
import type { ConfirmationContext, Principal, Report, ReportExportResult } from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
import { useReportStore } from '../../src/stores/report'

const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR',
  permissions: ['BUSINESS_READ', 'ORDINARY_REPORT_EXPORT'],
}
const admin: Principal = {
  userId: 'USR-ADMIN', username: 'admin', role: 'ADMIN',
  permissions: ['BUSINESS_READ', 'ORDINARY_REPORT_EXPORT', 'BATCH_LEVEL_III_EXPORT'],
}

/** 创建报告页面测试使用的成功响应。 */
function success(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

describe('P3 报表内容', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('单次报告展示范围、单位和五类内容且不混入批量运行', async () => {
    const wrapper = mount(ReportTabs, {
      attachTo: document.body,
      props: { report: fixtureSource.report as Report },
      global: { plugins: [ElementPlus] },
    })
    expect(wrapper.text()).toContain('RUN-001 · T+0～7200 s')
    expect(wrapper.text()).toContain('2026-08-06T10:06:30Z')
    expect(wrapper.text()).toContain('单位：dB')
    expect(wrapper.findAll('.el-tabs__item').map((tab) => tab.text())).toEqual([
      '汇总', '分链路', '干扰影响', '切换事件', '批量对比',
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
    expect(wrapper.text()).toContain('当前为单次仿真报告，无批量参数组合')
    expect(wrapper.text()).not.toContain('RUN-B01')
  })

  it('批量报告只使用 12 次批量运行生成聚合和对比数据', async () => {
    const wrapper = mount(ReportTabs, {
      attachTo: document.body,
      props: { report: fixtureSource.batchAggregateReport as Report },
      global: { plugins: [ElementPlus] },
    })
    expect(wrapper.text()).toContain('BATCH-001 · 12 次确定性运行')
    expect(wrapper.text()).toContain('批量聚合报告')
    expect(wrapper.text()).not.toContain('87.3%')

    await wrapper.findAll('.el-tabs__item')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('批量聚合报告不包含单链路明细')
    await wrapper.findAll('.el-tabs__item')[4]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="batch-report-table"]')).toBeTruthy()
    expect(wrapper.findAll('[data-testid="batch-report-table"] .el-table__row')).toHaveLength(12)
    expect(wrapper.text()).toContain('RUN-B01')
    expect(wrapper.text()).not.toContain('RUN-001 · T+0')
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
      .mockResolvedValueOnce(success([fixtureSource.report, fixtureSource.batchAggregateReport]))
      .mockResolvedValueOnce(success(fixtureSource.report))
      .mockResolvedValueOnce(success(result)))
    const wrapper = mount(ReportsPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()

    expect(wrapper.get('#reports-title').text()).toBe('报告分析')
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

  it('管理员在页面中确认三级报告导出验证', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).$patch({ principal: admin, role: admin.role, permissions: [...admin.permissions] })
    const awaiting: ConfirmationContext = {
      confirmationId: 'CONF-P2-001', state: 'AWAITING_CONFIRMATION', actor: 'admin', role: 'ADMIN',
      createdAt: '2026-08-06T08:00:00Z', expiresAt: '2026-08-06T08:05:00Z',
    }
    const result: ReportExportResult = {
      reportId: 'RPT-BATCH-001', generated: false, status: 'FIXTURE_SUCCESS',
      watermark: '仅供验证 · 未生成文件', verifiedAt: '2026-08-06T10:08:00Z',
    }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(success([fixtureSource.report, fixtureSource.batchAggregateReport]))
      .mockResolvedValueOnce(success(fixtureSource.report))
      .mockResolvedValueOnce(success(fixtureSource.batchAggregateReport))
      .mockResolvedValueOnce(success(awaiting))
      .mockResolvedValueOnce(success({ ...awaiting, state: 'CONFIRMED' }))
      .mockResolvedValueOnce(success(result)))
    const wrapper = mount(ReportsPage, { attachTo: document.body, global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()

    const selects = wrapper.findAllComponents({ name: 'ElSelect' })
    selects[0]!.vm.$emit('update:modelValue', 'RPT-BATCH-001')
    await flushPromises()
    expect(wrapper.get('[data-testid="report-tabs"]').attributes('data-report-id')).toBe('RPT-BATCH-001')
    await wrapper.get('[data-testid="report-export"]').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('确认验证三级批量报告导出')
    document.querySelector<HTMLElement>('[data-testid="confirm-report-export"]')?.click()
    await flushPromises()
    expect(wrapper.get('.reports-page__export-result').text()).toContain('2026-08-06T10:08:00Z')
    wrapper.unmount()
  })
})

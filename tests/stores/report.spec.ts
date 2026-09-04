import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ApiFailure, ConfirmationContext, Principal, Report, ReportExportResult } from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
import { isReport, useReportStore } from '../../src/stores/report'

const ordinaryReport = structuredClone(fixtureSource.report) as Report
const batchReport = structuredClone(fixtureSource.batchAggregateReport) as Report
const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR',
  permissions: ['BUSINESS_READ', 'ORDINARY_REPORT_EXPORT'],
}
const admin: Principal = {
  userId: 'USR-ADMIN', username: 'admin', role: 'ADMIN',
  permissions: ['BUSINESS_READ', 'ORDINARY_REPORT_EXPORT', 'BATCH_LEVEL_III_EXPORT'],
}

/** 创建报告 Store 测试使用的成功响应。 */
function success(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

/** 创建报告 Store 测试使用的失败响应。 */
function failure(code = 'NOT_FOUND', message = '未找到报告。'): Response {
  const body: ApiFailure = {
    ok: false,
    error: { code: code as ApiFailure['error']['code'], message, retryable: false, correlationId: 'CORR-P3-REPORT' },
    meta: { requestId: 'REQ-P3-REPORT', generatedAt: '2026-08-06T10:08:00Z' },
  }
  return { ok: false, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}

/** 创建指定状态的管理员一次性确认。 */
function confirmation(state: ConfirmationContext['state']): ConfirmationContext {
  return {
    confirmationId: 'CONF-P2-001', state, actor: 'admin', role: 'ADMIN',
    createdAt: '2026-08-06T08:00:00Z', expiresAt: '2026-08-06T08:05:00Z',
  }
}

const exportResult: ReportExportResult = {
  reportId: 'RPT-001', generated: false, status: 'FIXTURE_SUCCESS',
  watermark: '仅供验证 · 未生成文件', verifiedAt: '2026-08-06T10:06:30Z',
}

describe('P3 报表 Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('校验单次与批量报告的闭合合同', () => {
    expect(isReport(ordinaryReport)).toBe(true)
    expect(isReport(batchReport)).toBe(true)
    for (const invalid of [
      null, [], {},
      { ...ordinaryReport, reportId: 'BAD' },
      { ...ordinaryReport, runId: 'BAD' },
      { ...ordinaryReport, runId: 1 },
      { ...ordinaryReport, runId: undefined, batchId: undefined },
      { ...ordinaryReport, batchId: 'BATCH-001' },
      { ...batchReport, batchId: '' },
      { ...batchReport, batchId: 1 },
      { ...ordinaryReport, classification: 'LEVEL_IV' },
      { ...ordinaryReport, generatedTime: 1 },
      { ...ordinaryReport, status: 'DRAFT' },
      { ...ordinaryReport, timeSeries: undefined },
      { ...ordinaryReport, timeSeries: [] },
      { ...ordinaryReport, timeSeries: [{ ...ordinaryReport.timeSeries![0], points: [ordinaryReport.timeSeries![0]!.points[0]!] }] },
      { ...ordinaryReport, timeSeries: [{ ...ordinaryReport.timeSeries![0], points: ordinaryReport.timeSeries![0]!.points.map((point) => ({ ...point, ber: -1 })) }] },
      { ...ordinaryReport, timeSeries: [{ ...ordinaryReport.timeSeries![0], points: ordinaryReport.timeSeries![0]!.points.map((point) => ({ ...point, time: 0 })) }] },
      { ...ordinaryReport, kpis: { ...ordinaryReport.kpis, avgBer: Number.NaN } },
      { ...ordinaryReport, kpis: null },
      { ...ordinaryReport, kpis: { ...ordinaryReport.kpis, extra: 1 } },
      { ...ordinaryReport, extra: true },
    ]) expect(isReport(invalid)).toBe(false)
  })

  it('加载目录并原子选择首份单次报告', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(success([ordinaryReport, batchReport]))
      .mockResolvedValueOnce(success(ordinaryReport))
    vi.stubGlobal('fetch', fetchSpy)
    const report = useReportStore()

    await expect(report.load()).resolves.toBe(true)

    expect(report.reports).toHaveLength(2)
    expect(report.selectedReport?.reportId).toBe('RPT-001')
    expect(report.capabilityState).toBe('SUCCESS')
    expect(fetchSpy).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:4173/api/v1/reports/RPT-001', expect.any(Object))
  })

  it('空目录恢复空态，损坏和失败响应清除旧来源', async () => {
    const report = useReportStore()
    report.selectedReport = ordinaryReport
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(success([]))
      .mockResolvedValueOnce(success([{ bad: true }]))
      .mockResolvedValueOnce(failure()))

    await expect(report.load()).resolves.toBe(true)
    expect(report.capabilityState).toBe('EMPTY')
    await expect(report.load()).resolves.toBe(false)
    expect(report).toMatchObject({ selectedReport: null, capabilityState: 'ERROR', resultCode: 'REPORT_ERROR' })
    await expect(report.load()).resolves.toBe(false)
    expect(report.resultCode).toBe('NOT_FOUND')
  })

  it('来源切换失败时不保留上一来源内容', async () => {
    const report = useReportStore()
    report.selectedReport = ordinaryReport
    report.reports = [ordinaryReport, batchReport]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(success({ ...batchReport, reportId: 'RPT-WRONG' })))

    await expect(report.selectReport('RPT-BATCH-001')).resolves.toBe(false)
    expect(report.selectedReport).toBeNull()
    expect(report.resultMessage).toBe('报告来源与请求不一致。')
  })

  it('操作员可验证二级报告导出且结果明确不生成文件', async () => {
    const report = useReportStore()
    report.selectedReport = ordinaryReport
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(success(exportResult)))

    await expect(report.requestExport('HTML')).resolves.toBe(true)
    expect(report.exportResult).toEqual(exportResult)
    expect(report.resultMessage).toContain('未生成文件')
  })

  it('操作员不能发起三级批量报告导出', async () => {
    const report = useReportStore()
    report.selectedReport = batchReport
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(report.requestExport('CSV')).resolves.toBe(false)
    expect(report.resultCode).toBe('PERMISSION_DENIED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('管理员经一次性确认验证三级批量报告导出', async () => {
    const auth = useAuthStore()
    auth.$patch({ principal: admin, role: admin.role, permissions: [...admin.permissions] })
    const report = useReportStore()
    report.selectedReport = batchReport
    const batchExport = { ...exportResult, reportId: 'RPT-BATCH-001', verifiedAt: '2026-08-06T10:08:00Z' }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(success(confirmation('AWAITING_CONFIRMATION')))
      .mockResolvedValueOnce(success(confirmation('CONFIRMED')))
      .mockResolvedValueOnce(success(batchExport))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(report.requestExport('PDF')).resolves.toBe(true)
    expect(report.confirmation?.state).toBe('AWAITING_CONFIRMATION')
    await expect(report.confirmExport()).resolves.toBe(true)
    expect(report.exportResult).toEqual(batchExport)
    expect(report.confirmation).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('取消确认、无报告导出及无上下文确认均保持安全状态', async () => {
    const report = useReportStore()
    await expect(report.requestExport('HTML')).resolves.toBe(false)
    expect(report.resultCode).toBe('EMPTY')
    await expect(report.confirmExport()).resolves.toBe(false)
    await expect(report.exportNow('CSV')).resolves.toBe(false)

    report.confirmation = confirmation('AWAITING_CONFIRMATION')
    report.pendingFormat = 'CSV'
    report.cancelConfirmation()
    expect(report).toMatchObject({ confirmation: null, pendingFormat: null, resultCode: 'CANCELLED' })
  })

  it('管理员确认接口失败时清除半完成上下文', async () => {
    const auth = useAuthStore()
    auth.$patch({ principal: admin, role: admin.role, permissions: [...admin.permissions] })
    const report = useReportStore()
    report.selectedReport = batchReport
    report.confirmation = confirmation('AWAITING_CONFIRMATION')
    report.pendingFormat = 'PDF'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(failure('CONFIRMATION_EXPIRED', '二次确认已失效。')))

    await expect(report.confirmExport()).resolves.toBe(false)
    expect(report).toMatchObject({
      selectedReport: null,
      confirmation: null,
      pendingFormat: null,
      capabilityState: 'ERROR',
      resultCode: 'CONFIRMATION_EXPIRED',
    })
  })

  it('拒绝损坏的确认和导出结果，并使重置前的响应失效', async () => {
    const auth = useAuthStore()
    auth.$patch({ principal: admin, role: admin.role, permissions: [...admin.permissions] })
    const report = useReportStore()
    report.selectedReport = batchReport
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(success({ ...confirmation('AWAITING_CONFIRMATION'), confirmationId: '' }))
      .mockResolvedValueOnce(success({ ...exportResult, generated: true })))
    await expect(report.requestExport('PDF')).resolves.toBe(false)

    report.selectedReport = ordinaryReport
    await expect(report.requestExport('CSV')).resolves.toBe(false)
    expect(report.capabilityState).toBe('ERROR')

    let resolveResponse!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(new Promise<Response>((resolve) => { resolveResponse = resolve })))
    const pending = report.selectReport('RPT-001')
    report.resetToSafeEmpty()
    resolveResponse(success(ordinaryReport))
    await expect(pending).resolves.toBe(false)
    expect(report.capabilityState).toBe('EMPTY')
  })
})

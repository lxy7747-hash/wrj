import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ApiFailure, Principal, Report, ReportExportResult } from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
import { isReport, useReportStore } from '../../src/stores/report'

const ordinaryReport = structuredClone(fixtureSource.report) as Report
const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR',
  permissions: ['BUSINESS_READ', 'ORDINARY_REPORT_EXPORT'],
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

  it('校验单次报告的闭合合同', () => {
    expect(isReport(ordinaryReport)).toBe(true)
    for (const invalid of [
      null, [], {},
      { ...ordinaryReport, reportId: 'BAD' },
      { ...ordinaryReport, runId: 'BAD' },
      { ...ordinaryReport, runId: 1 },
      { ...ordinaryReport, runId: undefined },
      { ...ordinaryReport, legacySourceId: 'SOURCE-001' },
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
      .mockResolvedValueOnce(success([ordinaryReport]))
      .mockResolvedValueOnce(success(ordinaryReport))
    vi.stubGlobal('fetch', fetchSpy)
    const report = useReportStore()

    await expect(report.load()).resolves.toBe(true)

    expect(report.reports).toHaveLength(1)
    expect(report.selectedReport?.reportId).toBe('RPT-001')
    expect(report.capabilityState).toBe('SUCCESS')
    expect(fetchSpy).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:4173/api/v1/reports/RPT-001', expect.any(Object))
  })

  it('目录中的指定普通报告优先加载，目录响应过期不会恢复旧选择', async () => {
    const alternate = { ...ordinaryReport, reportId: 'RPT-002', runId: 'RUN-002' as const }
    const report = useReportStore()
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(success([ordinaryReport, alternate]))
      .mockResolvedValueOnce(success(alternate))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(report.load('RPT-002')).resolves.toBe(true)
    expect(report.selectedReport?.reportId).toBe('RPT-002')

    let resolveDirectory!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { resolveDirectory = resolve })))
    const pending = report.load()
    report.resetToSafeEmpty()
    resolveDirectory(success([ordinaryReport]))
    await expect(pending).resolves.toBe(false)
    expect(report).toMatchObject({ reports: [], selectedReport: null, capabilityState: 'EMPTY' })
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

  it.each([
    ['batchId', () => ({ ...ordinaryReport, batchId: 'BATCH-LEGACY-001' })],
    ['batch', () => ({ ...ordinaryReport, batch: { batchId: 'BATCH-LEGACY-001' } })],
  ])('目录响应包含已移除的 %s 字段时拒绝加载', async (_field, createInvalidReport) => {
    const report = useReportStore()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(success([createInvalidReport()])))

    await expect(report.load()).resolves.toBe(false)

    expect(report).toMatchObject({ reports: [], selectedReport: null, capabilityState: 'ERROR', resultCode: 'REPORT_ERROR' })
  })

  it.each([
    ['KPI 不是闭合数值对象', () => ({ ...ordinaryReport, kpis: [] })],
    ['时序条目不是对象', () => ({ ...ordinaryReport, timeSeries: [null] })],
    ['时刻为负数', () => ({
      ...ordinaryReport,
      timeSeries: [{ ...ordinaryReport.timeSeries![0]!, points: ordinaryReport.timeSeries![0]!.points.map(point => ({ ...point, time: -1 })) }],
    })],
    ['误码率超过范围', () => ({
      ...ordinaryReport,
      timeSeries: [{ ...ordinaryReport.timeSeries![0]!, points: ordinaryReport.timeSeries![0]!.points.map(point => ({ ...point, ber: 1.01 })) }],
    })],
    ['时刻不是严格递增', () => ({
      ...ordinaryReport,
      timeSeries: [{ ...ordinaryReport.timeSeries![0]!, points: ordinaryReport.timeSeries![0]!.points.map((point, index) => ({ ...point, time: index === 0 ? 10 : 9 })) }],
    })],
  ])('selectReport 拒绝损坏的普通报告：%s', async (_reason, createInvalidReport) => {
    const report = useReportStore()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(success(createInvalidReport())))

    await expect(report.selectReport('RPT-001')).resolves.toBe(false)

    expect(report).toMatchObject({ selectedReport: null, capabilityState: 'ERROR', resultCode: 'REPORT_ERROR' })
  })

  it('来源切换失败时不保留上一来源内容', async () => {
    const report = useReportStore()
    report.selectedReport = ordinaryReport
    report.reports = [ordinaryReport]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(success({ ...ordinaryReport, reportId: 'RPT-WRONG' })))

    await expect(report.selectReport('RPT-001')).resolves.toBe(false)
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

  it('三级历史报告导出已下线', async () => {
    const report = useReportStore()
    report.selectedReport = { ...ordinaryReport, classification: 'LEVEL_III' }
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(report.requestExport('CSV')).resolves.toBe(false)
    expect(report.resultCode).toBe('PERMISSION_DENIED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('无报告导出保持安全状态', async () => {
    const report = useReportStore()
    await expect(report.requestExport('HTML')).resolves.toBe(false)
    expect(report.resultCode).toBe('EMPTY')
    await expect(report.exportNow('CSV')).resolves.toBe(false)
  })

  it('拒绝损坏的导出结果，并使重置前的响应失效', async () => {
    const report = useReportStore()
    report.selectedReport = ordinaryReport
    vi.stubGlobal('fetch', vi.fn()
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

  it('重置后迟到的 JSON 导出响应不会恢复旧确认', async () => {
    let resolveExport!: (response: Response) => void
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(success([ordinaryReport]))
      .mockResolvedValueOnce(success(ordinaryReport))
      .mockReturnValueOnce(new Promise<Response>(resolve => { resolveExport = resolve }))
    vi.stubGlobal('fetch', fetchSpy)
    const report = useReportStore()

    await expect(report.load()).resolves.toBe(true)
    const pending = report.requestExport('HTML')
    report.resetToSafeEmpty()
    resolveExport(success(exportResult))

    await expect(pending).resolves.toBe(false)
    expect(report).toMatchObject({
      reports: [], selectedReport: null, exportResult: null, capabilityState: 'EMPTY', resultCode: 'EMPTY',
    })
  })
})

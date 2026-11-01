import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useReportStore } from '../../src/stores/report'
import { useReplayStore } from '../../src/stores/replay'
import { isMissionResultSnapshot, type MissionResultSnapshot } from '../../src/features/results/mission-result'
import { LOCAL_ARCHIVE } from '../fixtures/local-archive'
const result: MissionResultSnapshot = {
  record: { resultId: 'RESULT-11111111-1111-4111-8111-111111111111', scenarioId: 'SCN-001', scenarioName: '执行场景', revision: 3,
    startedAt: '2026-09-24T00:00:00Z', completedAt: '2026-09-24T00:00:01Z' },
  replay: structuredClone(LOCAL_ARCHIVE.replay), report: structuredClone(LOCAL_ARCHIVE.report),
}
const response = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) }) as Response
const comparisonResult = (): MissionResultSnapshot => ({ ...structuredClone(result), parameters: {
  scenarioId: result.record.scenarioId, revision: result.record.revision, platformCount: 2, linkCount: 1, jammerCount: 0,
  links: [{ id: 'L-1', type: 'MICROWAVE', frequencyMHz: 8200, bandwidthMHz: 30, txPowerW: 45 }], jammers: [],
} })
const resultResponse = (input: unknown, selected = result): unknown => {
  const url = String(input)
  if (url.endsWith('/mission-results')) return response([selected.record])
  return response(selected)
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('运行结果来源固定', () => {
  it('报告与回放使用相同 resultId；拒绝错来源，迟到结果不覆盖新选择', async () => {
    expect(isMissionResultSnapshot(result)).toBe(true)
    setActivePinia(createPinia())
    const fetch = vi.fn((input: unknown) => Promise.resolve(resultResponse(input)))
    vi.stubGlobal('fetch', fetch)
    const reports = useReportStore(), replay = useReplayStore()
    expect(await reports.loadResult(result.record.resultId)).toBe(true)
    expect(await replay.loadLocalFile(undefined, result.record.resultId)).toBe(true)
    expect(reports.resultSource).toEqual(result.record)
    expect(reports.selectedReport?.localEvidence?.positionFile.sha256).toBe(replay.localSnapshot?.sha256)
    expect(fetch.mock.calls.some(call => String(call[0]).endsWith('/mission-results'))).toBe(true)
    expect(fetch.mock.calls.filter(call => String(call[0]).includes('/mission-results/')).every(call => String(call[0]).endsWith(`/mission-results/${result.record.resultId}`))).toBe(true)
    expect(await reports.loadResult('RESULT-22222222-2222-4222-8222-222222222222')).toBe(false)
    expect(reports.selectedReport).toBeNull()
    let resolve!: (r: Response) => void
    fetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done }))
    const pending = reports.loadResult(result.record.resultId)
    reports.resetToSafeEmpty()
    resolve(response(result))
    expect(await pending).toBe(false)
    expect(reports.resultSource).toBeNull()
    expect(await replay.loadLocalFile('ARCH-INVALID', result.record.resultId)).toBe(false)
    expect(replay.localSnapshot).toBeNull()
  })

  it('下载绑定 resultId，失败不触发保存；切换来源后迟到附件不下载', async () => {
    setActivePinia(createPinia())
    const reports = useReportStore()
    const fetch = vi.fn((input: unknown) => Promise.resolve(resultResponse(input)))
    vi.stubGlobal('fetch', fetch)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:result'), revokeObjectURL: vi.fn() }))
    expect(await reports.loadResult(result.record.resultId)).toBe(true)
    fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { message: '没有导出权限' } }) })
    expect(await reports.requestExport('HTML')).toBe(false)
    expect(click).not.toHaveBeenCalled()
    expect(fetch.mock.calls.at(-1)?.[0]).toContain(`resultId=${result.record.resultId}&download=1`)
    fetch.mockResolvedValueOnce(response(result))
    await reports.loadResult(result.record.resultId)
    let resolve!: (value: Blob) => void
    fetch.mockResolvedValueOnce({ ok: true, headers: new Headers({ 'Content-Disposition': 'attachment; filename="result.html"' }), blob: () => new Promise<Blob>(done => { resolve = done }) })
    const pending = reports.requestExport('HTML')
    await vi.waitFor(() => expect(resolve).toBeDefined())
    reports.resetToSafeEmpty()
    resolve(new Blob(['old report']))
    expect(await pending).toBe(false)
    expect(click).not.toHaveBeenCalled()
  })

  it('比较只接受请求的 resultId 与当前场景，错源候选不会污染已选报告', async () => {
    setActivePinia(createPinia())
    const selected = comparisonResult()
    const wrongId = 'RESULT-22222222-2222-4222-8222-222222222222'
    const wrongScenario = 'RESULT-33333333-3333-4333-8333-333333333333'
    const fetch = vi.fn((input: unknown) => {
      const url = String(input)
      if (url.endsWith('/mission-results')) return Promise.resolve(response([selected.record,
        { ...selected.record, resultId: wrongId }, { ...selected.record, resultId: wrongScenario }]))
      if (url.endsWith(`/${wrongId}`)) return Promise.resolve(response(selected))
      if (url.endsWith(`/${wrongScenario}`)) return Promise.resolve(response({ ...selected,
        record: { ...selected.record, resultId: wrongScenario, scenarioId: 'SCN-002' },
        parameters: { ...selected.parameters!, scenarioId: 'SCN-002' } }))
      return Promise.resolve(response(selected))
    })
    vi.stubGlobal('fetch', fetch)
    const reports = useReportStore()
    expect(await reports.loadResult(selected.record.resultId)).toBe(true)
    expect(reports.resultSource).toEqual(selected.record)
    expect(reports.selectedReport).toEqual(selected.report)
    expect(reports.resultComparisons).toEqual([{ record: selected.record, parameters: selected.parameters }])
  })
})

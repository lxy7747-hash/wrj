import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LocalReportFilter } from '../../src/contracts/domain-models'
import { useReportStore } from '../../src/stores/report'
import { LOCAL_REPORT } from '../fixtures/local-report'

const record = { resultId: 'RESULT-11111111-1111-4111-8111-111111111111', scenarioId: 'SCN-001', scenarioName: '执行场景', revision: 3,
  startedAt: '2026-09-24T00:00:00Z', completedAt: '2026-09-24T00:00:01Z' }
const filtered = (filter: LocalReportFilter = {}) => ({ report: structuredClone(LOCAL_REPORT), filter,
  timeline: [{ id: 'LOG-L1', type: 'LINK_ADDED_TO_MANAGER', time: 5, subject: 'A', target: 'B' }], timelineTotal: 2, stages: [], links: ['L-1'] })
const response = (data: unknown) => new Response(JSON.stringify({ ok: true, data }))
beforeEach(() => { setActivePinia(createPinia()); useReportStore().$patch({ resultSource: record, selectedReport: structuredClone(LOCAL_REPORT) }) })
afterEach(() => vi.unstubAllGlobals())

it('晚返回的旧筛选不能覆盖新筛选，切换结果也使在途筛选失效', async () => {
  const store = useReportStore(), replies: Array<(response: Response) => void> = []
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => replies.push(resolve))))
  const old = store.applyLocalFilter({}), current = store.applyLocalFilter({ from: 0, to: 10 })
  replies[1]!(response(filtered({ from: 0, to: 10 })))
  expect(await current).toBe(true)
  replies[0]!(response(filtered()))
  expect(await old).toBe(false)
  expect(store.localFilterResult?.filter).toEqual({ from: 0, to: 10 })
  const pending = store.applyLocalFilter({})
  store.resetToSafeEmpty()
  replies[2]!(response(filtered()))
  expect(await pending).toBe(false)
  expect(store.localFilterResult).toBeNull()
})

it.each([
  { filter: { from: 2 } },
  { filter: { extra: 'unexpected' } },
  { filter: { nodeId: '' } },
  { filter: { from: -1 } },
  { filter: null },
  { timeline: [{ id: 'bad', type: 'BAD', subject: 'A', time: -1 }] },
  { timelineTotal: 0 },
  { timeline: [null] },
  { timeline: [{ id: 'bad', type: 'BAD', subject: 'A', time: 1, target: {} }] },
  { report: { ...LOCAL_REPORT, localEvidence: { ...LOCAL_REPORT.localEvidence, eventFile: { fileName: 'other.csv', sha256: 'd'.repeat(64) } } } },
])('错条件、错源或损坏时间线被拒绝，保留最后一次已应用范围：%j', async patch => {
  const store = useReportStore()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(filtered())).mockResolvedValueOnce(response({ ...filtered(), ...patch })))
  expect(await store.applyLocalFilter({})).toBe(true)
  expect(await store.applyLocalFilter({})).toBe(false)
  expect(store.localFilterResult?.filter).toEqual({})
  expect(store.selectedReport?.reportId).toBe(LOCAL_REPORT.reportId)
  expect(store.capabilityState).toBe('ERROR')
})

it('无运行结果来源时明确拒绝筛选，不发请求', async () => {
  const store = useReportStore(), fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  store.resultSource = null
  expect(await store.applyLocalFilter({})).toBe(false)
  expect(store.resultCode).toBe('FILTER_UNSUPPORTED')
  expect(fetch).not.toHaveBeenCalled()
})

it('report 视图结果响应携带 initialFilter 时可直接复用空筛选，且显式筛选/重置仍请求服务端', async () => {
  const store = useReportStore()
  const fetch = vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input)
    if (url.includes(`/mission-results/${record.resultId}`)) {
      expect(init?.headers?.['X-Mission-Result-View']).toBe('report')
      return response({
        record,
        report: structuredClone(LOCAL_REPORT),
        initialFilter: { filter: {}, timeline: [{ id: 'LOG-L1', type: 'LINK_ADDED_TO_MANAGER', time: 5, subject: 'A', target: 'B' }], timelineTotal: 2, stages: [], links: ['L-1'] },
      })
    }
    return response(filtered(url.includes('nodeId=A') ? { nodeId: 'A' } : {}))
  })
  vi.stubGlobal('fetch', fetch)
  expect(await store.loadResult(record.resultId)).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(store.localFilterResult?.links).toEqual(['L-1'])
  expect(await store.applyLocalFilter({})).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await store.applyLocalFilter({ nodeId: 'A' })).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(await store.applyLocalFilter({})).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('loadEngineSegments 以 includeEngineSegments=1 按需加载完整引擎链路段而不重置骨架状态', async () => {
  const store = useReportStore()
  const withSegment = structuredClone(LOCAL_REPORT)
  withSegment.localEvidence!.engineFrameArchive = {
    sourceSha256: 'a'.repeat(64), frameCount: 1, firstSimulationTime: 1, lastSimulationTime: 1,
    missingFieldNames: [], segmentRows: [], switchRows: [], eventRows: [], detailDeferred: true,
  }
  store.$patch({ selectedReport: withSegment, capabilityState: 'SUCCESS' })
  const fetch = vi.fn(async (input: unknown) => {
    expect(String(input)).toContain('includeEngineSegments=1')
    expect(store.capabilityState).toBe('SUCCESS')
    return response(filtered({ nodeId: 'A' }))
  })
  vi.stubGlobal('fetch', fetch)
  expect(await store.loadEngineSegments({ nodeId: 'A' })).toBe(true)
  expect(store.engineSegmentsLoading).toBe(false)
  expect(store.capabilityState).toBe('SUCCESS')
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('新筛选可重新加载延迟明细，旧响应不清除新请求且筛选不缩小原报告范围', async () => {
  const store = useReportStore(), replies: Array<(response: Response) => void> = []
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => replies.push(resolve))))
  const previousSegments = store.loadEngineSegments({})
  const filter = { to: 7 }
  const applying = store.applyLocalFilter(filter)
  const narrow = filtered(filter)
  narrow.report.localEvidence!.endTimeS = 7
  replies[1]!(response(narrow))
  expect(await applying).toBe(true)

  const currentSegments = store.loadEngineSegments(filter)
  expect(store.engineSegmentsLoading).toBe(true)
  replies[0]!(response(filtered()))
  expect(await previousSegments).toBe(false)
  expect(store.engineSegmentsLoading).toBe(true)
  replies[2]!(response(narrow))
  expect(await currentSegments).toBe(true)
  expect(store.localFilterResult?.report.localEvidence?.endTimeS).toBe(7)
  expect(store.selectedReport?.localEvidence?.endTimeS).toBe(10)
  expect(store.engineSegmentsLoading).toBe(false)
})

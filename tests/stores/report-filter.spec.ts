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

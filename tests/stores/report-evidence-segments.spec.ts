// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { LOCAL_REPORT } from '../fixtures/local-report'
import type { MissionResultRecord } from '../../src/features/results/mission-result'

interface Call { url: string; resolve: (data: unknown) => void }
const calls: Call[] = []
vi.mock('../../src/features/shared/api-fetch', () => ({ apiFetch: (url: string) => new Promise((resolve) => { calls.push({ url, resolve }) }) }))
const { useReportStore } = await import('../../src/stores/report')

const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const ok = (index: number, data: unknown) => calls[index]!.resolve({ ok: true, json: async () => ({ ok: true, data }) })
const fail = (index: number, message = 'x') => calls[index]!.resolve({ ok: false, json: async () => ({ ok: false, error: { message } }) })
const sha = 'a'.repeat(64)
const RESULT = 'RESULT-00000000-0000-0000-0000-000000000970'
const SERIES = 'state:L-1:gxb'
const SERIES_B = 'state:L-2:gxb'
const reportId = LOCAL_REPORT.reportId

const meta = (seriesId = SERIES) => ({ seriesId, kind: 'state', unit: 'dB' })
const overview = (sourceSha256 = sha) => ({
  reportId, resultId: RESULT, runId: 'RUN-1', generatedTime: LOCAL_REPORT.generatedTime, effectiveFilter: {},
  sources: [{ sourceSha256, sourceKind: 'FILE_SET', capabilities: ['state'], totals: { state: 6 }, series: [meta()], label: 's' }],
  selectedSourceSha256: sourceSha256, capabilities: ['state'], totals: { state: 6 }, missing: [], series: [meta()],
})
interface PageOpts { nextCursor: string | null; start: number; count?: number; seriesId?: string; sourceSha256?: string; resultId?: string }
const page = (opts: PageOpts) => {
  const count = opts.count ?? 2
  return {
    reportId, resultId: opts.resultId ?? RESULT, runId: 'RUN-1', sourceSha256: opts.sourceSha256 ?? sha,
    seriesId: opts.seriesId ?? SERIES, kind: 'state', unit: 'dB', continuityReliable: true, effectiveFilter: {},
    rawCount: 6, pointCount: count, sampling: 'DOWNSAMPLED',
    points: Array.from({ length: count }, (_, index) => ({ time: opts.start + index, value: opts.start + index })),
    nextCursor: opts.nextCursor,
  }
}

function prepare() {
  setActivePinia(createPinia()); calls.length = 0
  const store = useReportStore()
  const record: MissionResultRecord = { resultId: RESULT, scenarioId: 'SCN-1', scenarioName: 'x', revision: 1, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', runId: 'RUN-1', taskId: 'TASK-1' }
  store.$patch({ selectedReport: structuredClone(LOCAL_REPORT), resultSource: record, evidenceOverview: overview() as never })
  return store
}
const flatTimes = (store: ReturnType<typeof useReportStore>) => store.evidenceSeriesSegments.flat().map(point => point.time)

describe('R5 evidenceSeries 只存当前页 + 分段（不扁平累计）', () => {
  it('正常三页：每页 ≤ 预算仅存当前页，segments 完整有序，末页 nextCursor=null，末页后不追加', async () => {
    const store = prepare()
    const p1 = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick(); ok(0, page({ nextCursor: 'c1', start: 0 })); expect(await p1).toBe(true)
    expect(store.evidenceSeries!.points.map(point => point.time)).toEqual([0, 1])
    expect(store.evidenceSeriesSegments).toHaveLength(1)
    expect(store.evidenceSeriesSegments[0]).toHaveLength(2)

    const p2 = store.loadNextEvidenceSeries(); await tick(); ok(1, page({ nextCursor: 'c2', start: 2 })); expect(await p2).toBe(true)
    expect(store.evidenceSeries!.points.map(point => point.time)).toEqual([2, 3]) // 只存当前页
    expect(store.evidenceSeriesSegments).toHaveLength(2)

    const p3 = store.loadNextEvidenceSeries(); await tick(); ok(2, page({ nextCursor: null, start: 4 })); expect(await p3).toBe(true)
    expect(store.evidenceSeriesSegments).toHaveLength(3)
    expect(store.evidenceSeries!.points.map(point => point.time)).toEqual([4, 5])
    expect(store.evidenceSeries!.nextCursor).toBeNull()
    expect(store.evidenceSeriesSegments.map(segment => segment.length)).toEqual([2, 2, 2])
    expect(flatTimes(store)).toEqual([0, 1, 2, 3, 4, 5])
    expect(store.evidenceLoading).toBe(false)

    const before = calls.length
    expect(await store.loadNextEvidenceSeries()).toBe(false)
    expect(calls.length).toBe(before)
    expect(store.evidenceSeriesSegments).toHaveLength(3)
    // 游标与预算实际带到 HTTP 参数
    expect(calls[0]!.url).toContain('maxPoints=2')
    expect(calls[1]!.url).toContain('cursor=c1')
    expect(calls[2]!.url).toContain('cursor=c2')
  })

  it('同一有效游标并发：只发 1 个 HTTP、两个 promise 均完成、不提前关闭 loading，正常下一页仍可用', async () => {
    const store = prepare()
    const p1 = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick(); ok(0, page({ nextCursor: 'c1', start: 0 })); await p1
    const first = store.loadNextEvidenceSeries()
    const second = store.loadNextEvidenceSeries()
    await tick()
    expect(calls).toHaveLength(2) // 首段 + 仅一个续页 HTTP；第二个被阻断
    expect(await second).toBe(false)
    expect(store.evidenceLoading).toBe(true) // 第一个仍在途，不能被第二个提前关闭
    expect(store.evidenceSeriesSegments).toHaveLength(1)
    ok(1, page({ nextCursor: 'c2', start: 2 }))
    expect(await first).toBe(true)
    expect(store.evidenceSeriesSegments).toHaveLength(2)
    expect(flatTimes(store)).toEqual([0, 1, 2, 3]) // 只 append 一次，无重复
    expect(store.evidenceLoading).toBe(false)

    const third = store.loadNextEvidenceSeries(); await tick()
    expect(calls).toHaveLength(3) // 正常下一页仍可发起
    ok(2, page({ nextCursor: null, start: 4 }))
    expect(await third).toBe(true)
    expect(flatTimes(store)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('同一游标并发失败后可重试，且始终只 append 一次', async () => {
    const store = prepare()
    const p1 = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick(); ok(0, page({ nextCursor: 'c1', start: 0 })); await p1
    const first = store.loadNextEvidenceSeries()
    const second = store.loadNextEvidenceSeries()
    await tick()
    expect(calls).toHaveLength(2)
    expect(await second).toBe(false)
    fail(1, 'network')
    expect(await first).toBe(false)
    expect(store.evidenceSeriesSegments).toHaveLength(1)
    expect(store.evidenceLoading).toBe(false) // 失败后 loading 复位
    const retry = store.loadNextEvidenceSeries(); await tick()
    expect(calls).toHaveLength(3) // 失败后可重试
    ok(2, page({ nextCursor: null, start: 2 }))
    expect(await retry).toBe(true)
    expect(flatTimes(store)).toEqual([0, 1, 2, 3])
  })

  it('A 续页在途→切 B 成功→A 成功晚到被丢弃，不污染 B 内容/段/error/loading', async () => {
    const store = prepare()
    const a1 = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick(); ok(0, page({ nextCursor: 'a1', start: 0 })); await a1
    const aNext = store.loadNextEvidenceSeries(); await tick()
    const bFirst = store.loadEvidenceSeries(SERIES_B, { maxPoints: 2 }); await tick()
    ok(2, page({ nextCursor: 'b1', start: 10, seriesId: SERIES_B })); expect(await bFirst).toBe(true)
    expect(store.evidenceSeries!.seriesId).toBe(SERIES_B)
    expect(store.evidenceSeries!.points.map(point => point.time)).toEqual([10, 11])
    ok(1, page({ nextCursor: 'a2', start: 2 }))
    expect(await aNext).toBe(false)
    expect(store.evidenceSeries!.seriesId).toBe(SERIES_B)
    expect(store.evidenceSeries!.points.map(point => point.time)).toEqual([10, 11])
    expect(store.evidenceSeriesSegments).toHaveLength(1)
    expect(flatTimes(store)).toEqual([10, 11])
    expect(store.evidenceMessage).toBe('')
    expect(store.evidenceLoading).toBe(false)
  })

  it('A 续页在途→B 成功→A 失败晚到被丢弃，B 段保持且不写 error', async () => {
    const store = prepare()
    const a1 = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick(); ok(0, page({ nextCursor: 'a1', start: 0 })); await a1
    const aNext = store.loadNextEvidenceSeries(); await tick()
    const bFirst = store.loadEvidenceSeries(SERIES_B, { maxPoints: 2 }); await tick()
    ok(2, page({ nextCursor: null, start: 10, seriesId: SERIES_B })); expect(await bFirst).toBe(true)
    fail(1, 'boom')
    expect(await aNext).toBe(false)
    expect(store.evidenceSeries!.seriesId).toBe(SERIES_B)
    expect(store.evidenceSeries!.points.map(point => point.time)).toEqual([10, 11])
    expect(store.evidenceSeriesSegments).toHaveLength(1)
    expect(store.evidenceMessage).toBe('')
    expect(store.evidenceLoading).toBe(false)
  })

  it('A 首段在途→B 仍待→A 失败不打断 B，B 成功后即唯一结果', async () => {
    const store = prepare()
    const aFirst = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick()
    const bFirst = store.loadEvidenceSeries(SERIES_B, { maxPoints: 2 }); await tick()
    expect(calls).toHaveLength(2)
    fail(0, 'a-fail')
    expect(await aFirst).toBe(false)
    expect(store.evidenceMessage).toBe('') // 旧 A 失败不写 error
    expect(store.evidenceSeries).toBeNull()
    expect(store.evidenceLoading).toBe(true) // B 仍在途
    ok(1, page({ nextCursor: null, start: 10, seriesId: SERIES_B })); expect(await bFirst).toBe(true)
    expect(store.evidenceSeries!.seriesId).toBe(SERIES_B)
    expect(store.evidenceSeries!.points.map(point => point.time)).toEqual([10, 11])
    expect(store.evidenceSeriesSegments).toHaveLength(1)
    expect(store.evidenceLoading).toBe(false)
  })

  it('续页失败不丢既有段、loading 复位；切源清段', async () => {
    const store = prepare()
    const p1 = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick(); ok(0, page({ nextCursor: 'c1', start: 0 })); await p1
    const failing = store.loadNextEvidenceSeries(); await tick()
    fail(1, 'x'); await failing
    expect(store.evidenceSeriesSegments).toHaveLength(1)
    expect(store.evidenceLoading).toBe(false)
    const source = store.loadEvidenceOverview('b'.repeat(64)); await tick(); ok(2, overview('b'.repeat(64))); await source
    expect(store.evidenceSeriesSegments).toHaveLength(0)
    expect(store.evidenceSeriesContext).toBeNull()
  })

  it('R5-B：旧代际续页 finally 不清除新代际同游标在途标记（A→B→A）', async () => {
    const store = prepare()
    // 首段 A（代际1，nextCursor=c2）
    const a0 = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick(); ok(0, page({ nextCursor: 'c2', start: 0 })); expect(await a0).toBe(true)
    // 旧 A 续页在途（代际1）——call1
    const oldNext = store.loadNextEvidenceSeries(); await tick()
    // 切到 B（代际2），再切回 A（代际3），两次首段都返回同一 nextCursor=c2
    const b = store.loadEvidenceSeries(SERIES_B, { maxPoints: 2 }); await tick(); ok(2, page({ nextCursor: 'c2', start: 10, seriesId: SERIES_B })); expect(await b).toBe(true)
    const a1 = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick(); ok(3, page({ nextCursor: 'c2', start: 0 })); expect(await a1).toBe(true)
    // 新 A 相同游标续页在途（代际3）——旧代际在途标记不得阻止它发 HTTP
    const newNext = store.loadNextEvidenceSeries(); await tick()
    expect(calls).toHaveLength(5)
    // 释放旧 A 续页（call1）：不得清除新 A 在途标记
    ok(1, page({ nextCursor: 'c3', start: 2 })); expect(await oldNext).toBe(false)
    expect(store.evidenceSeriesInflightCursor).toBe('c2')
    // 再调用续页：同一有效代际的相同在途游标 → 不再发 HTTP
    const dup = store.loadNextEvidenceSeries(); await tick()
    expect(calls).toHaveLength(5)
    expect(await dup).toBe(false)
    // 释放新 A 成功：只追加一段，loading 结束，末游标记录正确
    ok(4, page({ nextCursor: 'c4', start: 4 })); expect(await newNext).toBe(true)
    expect(store.evidenceSeriesSegments).toHaveLength(2)
    expect(store.evidenceLoading).toBe(false)
    expect(store.evidenceSeriesLastCursor).toBe('c2')
  })

  it('R5-B：A→B→A 同游标，旧 A 失败不清除新 A 续页锁', async () => {
    const store = prepare()
    const a0 = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick(); ok(0, page({ nextCursor: 'c2', start: 0 })); expect(await a0).toBe(true)
    const oldNext = store.loadNextEvidenceSeries(); await tick()
    const b = store.loadEvidenceSeries(SERIES_B, { maxPoints: 2 }); await tick(); ok(2, page({ nextCursor: 'c2', start: 10, seriesId: SERIES_B })); expect(await b).toBe(true)
    const a1 = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick(); ok(3, page({ nextCursor: 'c2', start: 0 })); expect(await a1).toBe(true)
    const newNext = store.loadNextEvidenceSeries(); await tick()
    expect(calls).toHaveLength(5)
    expect(store.evidenceSeriesInflightCursor).toBe('c2')
    expect(store.evidenceLoading).toBe(true)
    expect(store.evidenceActiveRequests).toBe(1)
    fail(1, 'old-a-fail'); expect(await oldNext).toBe(false)
    expect(store.evidenceSeriesInflightCursor).toBe('c2')
    expect(store.evidenceLoading).toBe(true)
    expect(store.evidenceActiveRequests).toBe(1)
    expect(store.evidenceMessage).toBe('')
    expect(store.evidenceSeriesSegments).toHaveLength(1)
    const dup = store.loadNextEvidenceSeries(); await tick()
    expect(calls).toHaveLength(5)
    expect(await dup).toBe(false)
    expect(store.evidenceSeriesInflightCursor).toBe('c2')
    expect(store.evidenceLoading).toBe(true)
    ok(4, page({ nextCursor: 'c4', start: 4 })); expect(await newNext).toBe(true)
    expect(store.evidenceSeriesSegments).toHaveLength(2)
    expect(flatTimes(store)).toEqual([0, 1, 4, 5])
    expect(store.evidenceLoading).toBe(false)
    expect(store.evidenceActiveRequests).toBe(0)
    expect(store.evidenceSeriesLastCursor).toBe('c2')
    expect(store.evidenceSeriesInflightCursor).toBeNull()
    expect(store.evidenceMessage).toBe('')
  })
})

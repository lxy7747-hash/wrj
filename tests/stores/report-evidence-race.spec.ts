// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { LOCAL_REPORT } from '../fixtures/local-report'
import type { MissionResultRecord } from '../../src/features/results/mission-result'
import { useSimulationStore } from '../../src/stores/simulation'

interface Call { url: string; resolve: (data: unknown) => void; reject: (error: unknown) => void; body?: string }
const calls: Call[] = []
/** 下载副作用计数。throwTimes>0 时下一次 saveDownload 抛错，用来进入 exportEvidence 的 catch。 */
let downloadCalls = 0
let downloadThrowTimes = 0
vi.mock('../../src/features/shared/api-fetch', () => ({
  apiFetch: (url: string, init?: { body?: string }) => new Promise((resolve, reject) => { calls.push({ url, resolve, reject, body: init?.body }) }),
}))
vi.mock('../../src/features/shared/download', () => ({
  saveDownload: async (response: { ok: boolean }, _filename: string, isCurrent: () => boolean) => {
    downloadCalls += 1
    if (downloadThrowTimes > 0) {
      downloadThrowTimes -= 1
      throw new Error('download-boom')
    }
    if (!isCurrent()) return false
    return response.ok
  },
}))
const { useReportStore } = await import('../../src/stores/report')

const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const ok = (index: number, data: unknown) => calls[index]!.resolve({ ok: true, json: async () => ({ ok: true, data }) })
const fail = (index: number, message = 'x') => calls[index]!.resolve({ ok: false, json: async () => ({ ok: false, error: { message } }) })
const rejectCall = (index: number, error: unknown = new Error('net-fail')) => calls[index]!.reject(error)
const RESULT = 'RESULT-00000000-0000-0000-0000-000000000950'
const SERIES = 'state:L-1:gxb'
const reportId = LOCAL_REPORT.reportId
const overview = (sourceSha256: string, resultId = RESULT) => ({
  reportId, resultId, runId: 'RUN-1', generatedTime: LOCAL_REPORT.generatedTime, effectiveFilter: {},
  sources: [{ sourceSha256, sourceKind: 'FILE_SET', capabilities: ['state'], totals: { state: 1 }, series: [], label: 'src' }],
  selectedSourceSha256: sourceSha256, capabilities: ['state'], totals: { state: 1 }, missing: [], series: [],
})
const rows = (sourceSha256: string, opts: { kind?: string; total?: number; rows?: Array<{ id: string; time: number }>; nextCursor?: string | null; effectiveFilter?: Record<string, unknown>; resultId?: string } = {}) => ({
  reportId, resultId: opts.resultId ?? RESULT, runId: 'RUN-1', sourceSha256, kind: opts.kind ?? 'state', effectiveFilter: opts.effectiveFilter ?? {},
  total: opts.total ?? (opts.rows?.length ?? 1), rows: opts.rows ?? [{ id: 'r1', time: 0 }], nextCursor: opts.nextCursor ?? null,
})
const seriesView = (sourceSha256: string, opts: { nextCursor: string | null; points: number[]; seriesId?: string; resultId?: string; effectiveFilter?: Record<string, unknown>; rawCount?: number }) => ({
  reportId, resultId: opts.resultId ?? RESULT, runId: 'RUN-1', sourceSha256, seriesId: opts.seriesId ?? SERIES, kind: 'state', unit: 'dB',
  continuityReliable: true, effectiveFilter: opts.effectiveFilter ?? {}, rawCount: opts.rawCount ?? 6, pointCount: opts.points.length, sampling: 'DOWNSAMPLED',
  points: opts.points.map(time => ({ time, value: time })), nextCursor: opts.nextCursor,
})

function prepare() {
  setActivePinia(createPinia())
  calls.length = 0
  downloadCalls = 0
  downloadThrowTimes = 0
  const store = useReportStore()
  const record: MissionResultRecord = { resultId: RESULT, scenarioId: 'SCN-1', scenarioName: 'x', revision: 1, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', runId: 'RUN-1', taskId: 'TASK-1' }
  store.$patch({ selectedReport: structuredClone(LOCAL_REPORT), resultSource: record })
  return store
}
const filterResult = (filter: Record<string, unknown>) => ({ report: structuredClone(LOCAL_REPORT), filter, timeline: [], timelineTotal: 0, stages: [], links: [] })

describe('R6 store 级：不可变上下文 / loading 活跃计数 / 迟到响应隔离', () => {
  it('旧 overview 晚到被丢弃；新 overview 成为当前且旧请求不作为新上下文 loading', async () => {
    const store = prepare()
    const a = 'a'.repeat(64), b = 'b'.repeat(64)
    const first = store.loadEvidenceOverview(a); await tick()
    const second = store.loadEvidenceOverview(b); await tick()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain(`sourceSha256=${a}`)
    expect(calls[1]!.url).toContain(`sourceSha256=${b}`)
    ok(1, overview(b)); await second
    // 新 B 完成后 loading 关闭；旧 A 属于旧上下文，不得继续拖住新状态 loading
    expect(store.evidenceOverview?.selectedSourceSha256).toBe(b)
    expect(store.evidenceLoading).toBe(false)
    ok(0, overview(a)); await first
    // 旧 A 晚到不覆盖当前 B，也不重新打开 loading
    expect(store.evidenceOverview?.selectedSourceSha256).toBe(b)
    expect(store.evidenceLoading).toBe(false)
  })

  it('切换来源后旧 rows/series 迟到成功被丢弃，不覆盖新空状态', async () => {
    const store = prepare()
    store.evidenceOverview = overview('c'.repeat(64)) as unknown as typeof store.evidenceOverview
    const staleRows = store.loadEvidenceRows('state'); await tick()
    const staleSeries = store.loadEvidenceSeries(SERIES); await tick()
    const switching = store.loadEvidenceOverview('d'.repeat(64)); await tick()
    ok(2, overview('d'.repeat(64))); await switching
    ok(0, rows('c'.repeat(64))); await staleRows
    ok(1, seriesView('c'.repeat(64), { nextCursor: null, points: [0] })); await staleSeries
    expect(store.evidenceRows).toBeNull()
    expect(store.evidenceSeries).toBeNull()
    expect(store.evidenceSeriesSegments).toHaveLength(0)
    expect(store.evidenceOverview?.selectedSourceSha256).toBe('d'.repeat(64))
    expect(store.evidenceLoading).toBe(false)
  })

  it('切换来源后旧 rows/series 迟到失败不写 error（success/catch 均核有效版本）', async () => {
    const store = prepare()
    store.evidenceOverview = overview('c'.repeat(64)) as unknown as typeof store.evidenceOverview
    const staleRows = store.loadEvidenceRows('state'); await tick()
    const staleSeries = store.loadEvidenceSeries(SERIES); await tick()
    const switching = store.loadEvidenceOverview('d'.repeat(64)); await tick()
    ok(2, overview('d'.repeat(64))); await switching
    store.evidenceMessage = ''
    fail(0, 'stale-rows'); await staleRows
    fail(1, 'stale-series'); await staleSeries
    expect(store.evidenceMessage).toBe('') // 旧失败不污染新来源 error
    expect(store.evidenceRows).toBeNull()
    expect(store.evidenceSeries).toBeNull()
    expect(store.evidenceLoading).toBe(false)
  })

  it('历史 run 来自 resultSource.resultId，即使 SimulationStore 指向不同 run', async () => {
    const store = prepare()
    // 同时放一个不同的当前模拟运行，证明证据身份不依赖 SimulationStore。
    useSimulationStore().$patch({ run: { runId: 'RUN-OTHER', taskId: 'TASK-X', scenarioId: 'SCN-X', configLocked: false, uiStatus: 'IDLE', canonical: { status: 'IDLE', currentTime: 0, totalDuration: 0, processId: null, progress: 0 } } as never })
    const run = store.loadEvidenceOverview(undefined); await tick()
    expect(calls[0]!.url).toContain(`resultId=${RESULT}`)
    expect(calls[0]!.url).not.toContain('RUN-OTHER')
    ok(0, overview('e'.repeat(64))); await run
    expect(store.evidenceOverview?.resultId).toBe(RESULT)
    expect(store.evidenceOverview?.runId).toBe('RUN-1')
  })

  it('同一来源切换 kind：旧 rows 迟到成功/失败均不覆盖新 kind', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    const stateRows = store.loadEvidenceRows('state'); await tick()
    const lossRows = store.loadEvidenceRows('loss'); await tick()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain('kind=state')
    expect(calls[1]!.url).toContain('kind=loss')
    ok(1, rows(sha, { kind: 'loss', rows: [{ id: 'l1', time: 2 }] })); expect(await lossRows).toBe(true)
    ok(0, rows(sha, { kind: 'state', rows: [{ id: 's1', time: 1 }] }))
    expect(await stateRows).toBe(false) // 旧 kind rows 迟到被丢弃
    expect(store.evidenceRows?.kind).toBe('loss')
    expect(store.evidenceRows?.rows).toEqual([{ id: 'l1', time: 2 }])
    expect(store.evidenceLoading).toBe(false)
  })

  it('明细与曲线带已应用筛选并行都完成，rows 不提前关闭 loading；续段真正取到第二段', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    const filter = { nodeId: 'A', linkId: 'L-1', stage: 'PH-1', from: 1, to: 3 }
    store.evidenceOverview = overview(sha) as never
    const rowsP = store.loadEvidenceRows('state', { filter }); await tick()
    const seriesP = store.loadEvidenceSeries(SERIES, { maxPoints: 2, filter }); await tick()
    expect(calls).toHaveLength(2)
    for (const key of ['nodeId=A', 'linkId=L-1', 'stage=PH-1', 'from=1', 'to=3']) {
      expect(calls[0]!.url).toContain(key)
      expect(calls[1]!.url).toContain(key)
    }
    expect(calls[1]!.url).toContain('maxPoints=2')
    expect(store.evidenceLoading).toBe(true)
    ok(0, rows(sha, { effectiveFilter: filter, rows: [{ id: 'r1', time: 1 }] }))
    expect(await rowsP).toBe(true)
    expect(store.evidenceLoading).toBe(true) // 曲线仍在途
    ok(1, seriesView(sha, { nextCursor: 's1', points: [1, 2], effectiveFilter: filter, rawCount: 3 }))
    expect(await seriesP).toBe(true)
    expect(store.evidenceLoading).toBe(false)
    expect(store.evidenceRows?.rows).toHaveLength(1)
    expect(store.evidenceRows?.effectiveFilter).toEqual(filter)
    expect(store.evidenceSeries?.points.map(point => point.time)).toEqual([1, 2])
    expect(store.evidenceSeries?.effectiveFilter).toEqual(filter)
    expect([store.evidenceSeries?.rawCount, store.evidenceSeries?.pointCount, store.evidenceSeries?.sampling]).toEqual([3, 2, 'DOWNSAMPLED'])
    // 真正续段：上下文携带首段 sha / maxPoints / filter，不用 rows 的过滤值
    const next = store.loadNextEvidenceSeries(); await tick()
    expect(calls).toHaveLength(3)
    expect(calls[2]!.url).toContain(`sourceSha256=${sha}`)
    expect(calls[2]!.url).toContain('cursor=s1')
    expect(calls[2]!.url).toContain('maxPoints=2')
    expect(calls[2]!.url).toContain('nodeId=A')
    // 续页仍在 from=1~3 范围内（末页仅 1 点），不使用范围外时刻凑第二页
    ok(2, seriesView(sha, { nextCursor: null, points: [3], effectiveFilter: filter, rawCount: 3 }))
    expect(await next).toBe(true)
    expect(store.evidenceSeriesSegments).toHaveLength(2)
    expect(store.evidenceSeriesSegments.flat().map(point => point.time)).toEqual([1, 2, 3])
  })

  it('rows 响应迟到不能改写曲线首段 filter（续段仍用曲线自身 filter）', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    const seriesP = store.loadEvidenceSeries(SERIES, { maxPoints: 2, filter: { nodeId: 'A' } }); await tick()
    ok(0, seriesView(sha, { nextCursor: 's1', points: [1, 2] })); await seriesP
    const rowsP = store.loadEvidenceRows('state', { filter: { nodeId: 'B' } }); await tick()
    ok(1, rows(sha, { rows: [{ id: 'r1', time: 1 }] })); await rowsP
    const next = store.loadNextEvidenceSeries(); await tick()
    expect(calls).toHaveLength(3)
    expect(calls[2]!.url).toContain('nodeId=A')
    expect(calls[2]!.url).not.toContain('nodeId=B')
    ok(2, seriesView(sha, { nextCursor: null, points: [3, 4] })); await next
    expect(store.evidenceSeriesSegments.flat().map(point => point.time)).toEqual([1, 2, 3, 4])
  })

  it('applyLocalFilter 成功：旧上下文/分页/分段立即失效，迟到续段不复活', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    const first = store.loadEvidenceSeries(SERIES, { maxPoints: 2, filter: { nodeId: 'A' } }); await tick()
    ok(0, seriesView(sha, { nextCursor: 's1', points: [1, 2] })); await first
    const lateNext = store.loadNextEvidenceSeries(); await tick()
    const applyP = store.applyLocalFilter({}); await tick()
    ok(2, filterResult({})); expect(await applyP).toBe(true)
    expect(store.localFilterResult).not.toBeNull() // 空结果也应用，不回退旧数据
    expect(store.evidenceRows).toBeNull()
    expect(store.evidenceSeries).toBeNull()
    expect(store.evidenceSeriesSegments).toHaveLength(0)
    expect(store.evidenceSeriesContext).toBeNull()
    expect(store.evidenceSeriesLastCursor).toBeNull()
    ok(1, seriesView(sha, { nextCursor: 's2', points: [3, 4] }))
    expect(await lateNext).toBe(false)
    expect(store.evidenceSeries).toBeNull()
    expect(store.evidenceSeriesSegments).toHaveLength(0)
    expect(store.evidenceLoading).toBe(false)
  })

  it('resetToSafeEmpty 清空证据上下文/分段并复位活跃计数', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    const first = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick()
    ok(0, seriesView(sha, { nextCursor: 's1', points: [1, 2] })); await first
    store.resetToSafeEmpty()
    expect(store.evidenceOverview).toBeNull()
    expect(store.evidenceSeries).toBeNull()
    expect(store.evidenceSeriesSegments).toHaveLength(0)
    expect(store.evidenceSeriesContext).toBeNull()
    expect(store.evidenceActiveRequests).toBe(0)
    expect(store.evidenceLoading).toBe(false)
  })

  it('缺陷2：选定来源后完整来源目录保留，原生与文件集原地 A→B→A 均可切换', async () => {
    const store = prepare()
    const nat = 'a'.repeat(64), fs = 'b'.repeat(64)
    const src = (sha: string, kind: string, caps: string[]) => ({ sourceSha256: sha, sourceKind: kind, capabilities: caps, totals: { [caps[0]!]: 1 }, series: [], label: kind === 'NATIVE_ARCHIVE' ? '原生帧归档' : '文件集' })
    const catalog = { reportId, resultId: RESULT, runId: 'RUN-1', generatedTime: LOCAL_REPORT.generatedTime, effectiveFilter: {},
      sources: [src(nat, 'NATIVE_ARCHIVE', ['segments']), src(fs, 'FILE_SET', ['state'])], selectedSourceSha256: null as string | null, capabilities: [], totals: {}, missing: [], series: [] }
    const initial = store.loadEvidenceOverview(undefined); await tick(); ok(0, catalog); await initial
    expect(store.evidenceOverview?.sources.map(s => s.sourceSha256)).toEqual([nat, fs])
    const pick = async (index: number, sha: string, kind: string) => {
      const p = store.loadEvidenceOverview(sha); await tick()
      ok(index, { ...catalog, selectedSourceSha256: sha, sources: [src(sha, kind, kind === 'NATIVE_ARCHIVE' ? ['segments'] : ['state'])] }); await p
      expect(store.evidenceOverview?.selectedSourceSha256).toBe(sha)
      // 目录始终保留两项
      expect(store.evidenceOverview?.sources.map(s => s.sourceSha256).sort()).toEqual([nat, fs].sort())
    }
    await pick(1, nat, 'NATIVE_ARCHIVE')
    await pick(2, fs, 'FILE_SET')
    await pick(3, nat, 'NATIVE_ARCHIVE')
  })

  it('缺陷3：重置并加载新报告后旧请求 finally 不扣减新请求计数（新 loading 不被提前关闭）', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    const oldRows = store.loadEvidenceRows('state'); await tick()
    store.resetToSafeEmpty()
    const record: MissionResultRecord = { resultId: RESULT, scenarioId: 'SCN-1', scenarioName: 'x', revision: 1, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', runId: 'RUN-1', taskId: 'TASK-1' }
    store.$patch({ selectedReport: structuredClone(LOCAL_REPORT), resultSource: record })
    store.evidenceOverview = overview(sha) as never
    const newRows = store.loadEvidenceRows('state'); await tick()
    expect(calls).toHaveLength(2)
    ok(0, rows(sha, { rows: [{ id: 'old', time: 9 }] })); expect(await oldRows).toBe(false)
    expect(store.evidenceLoading).toBe(true)
    expect(store.evidenceRows).toBeNull()
    ok(1, rows(sha, { rows: [{ id: 'new', time: 1 }] })); expect(await newRows).toBe(true)
    expect(store.evidenceRows?.rows).toEqual([{ id: 'new', time: 1 }])
    expect(store.evidenceLoading).toBe(false)
  })

  it('R6.C：导出证据请求体携带 resultId、摘要与已应用筛选', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    const filter = { nodeId: 'A', from: 1, to: 3 }
    const p = store.exportEvidence('HTML', filter); await tick()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/evidence/export?download=1')
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ resultId: RESULT, sourceSha256: sha, format: 'HTML', filter })
    ok(0, {}); await p
  })

  it('缺陷4：同一来源切 kind，旧 state 迟到失败不写新 kind 错误且不提前关闭 loss loading', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    const stateRows = store.loadEvidenceRows('state'); await tick()
    const lossRows = store.loadEvidenceRows('loss'); await tick()
    store.evidenceMessage = ''
    fail(0, 'old-state-fail'); expect(await stateRows).toBe(false)
    expect(store.evidenceLoading).toBe(true)
    expect(store.evidenceMessage).toBe('')
    ok(1, rows(sha, { kind: 'loss', rows: [{ id: 'l1', time: 2 }] })); expect(await lossRows).toBe(true)
    expect(store.evidenceRows?.kind).toBe('loss')
    expect(store.evidenceMessage).toBe('')
    expect(store.evidenceLoading).toBe(false)
  })

  it('R5-A：旧 rows 被新 rows 取代后不再占用当前 loading', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    const a = store.loadEvidenceRows('state'); await tick()
    const b = store.loadEvidenceRows('loss'); await tick()
    // 同通道替代：loss 挂起时 state 已失效，有效计数是 1 而不是 2
    expect(store.evidenceActiveRequests).toBe(1)
    expect(store.evidenceLoading).toBe(true)
    ok(1, rows(sha, { kind: 'loss', rows: [{ id: 'b', time: 2 }] })); expect(await b).toBe(true)
    // B 已完成、A 仍过期在途：旧请求不得占用当前 loading
    expect(store.evidenceRows?.kind).toBe('loss')
    expect(store.evidenceLoading).toBe(false)
    // 释放过期 A 成功：数据/错误/loading 均不变
    ok(0, rows(sha, { kind: 'state', rows: [{ id: 'a', time: 1 }] })); expect(await a).toBe(false)
    expect(store.evidenceRows?.kind).toBe('loss')
    expect(store.evidenceMessage).toBe('')
    expect(store.evidenceLoading).toBe(false)
  })

  it('R5-A：旧首段曲线被新首段取代后不再占用当前 loading', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    const a = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick()
    const b = store.loadEvidenceSeries('state:L-2:gxb', { maxPoints: 2 }); await tick()
    ok(1, seriesView(sha, { seriesId: 'state:L-2:gxb', nextCursor: null, points: [7, 8] })); expect(await b).toBe(true)
    expect(store.evidenceSeries?.seriesId).toBe('state:L-2:gxb')
    expect(store.evidenceLoading).toBe(false)
    fail(0, 'old-series-fail'); expect(await a).toBe(false)
    expect(store.evidenceSeries?.seriesId).toBe('state:L-2:gxb')
    expect(store.evidenceLoading).toBe(false)
    expect(store.evidenceMessage).toBe('')
  })

  it('R5-A：B 在途时释放旧 A（成功/失败）不提前关闭 B 的 loading', async () => {
    // 成功分支
    let store = prepare()
    let sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    let a = store.loadEvidenceRows('state'); await tick()
    let b = store.loadEvidenceRows('loss'); await tick()
    expect(store.evidenceActiveRequests).toBe(1)
    expect(store.evidenceLoading).toBe(true)
    ok(0, rows(sha, { kind: 'state', rows: [{ id: 'a', time: 1 }] })); expect(await a).toBe(false)
    expect(store.evidenceLoading).toBe(true)
    expect(store.evidenceMessage).toBe('')
    ok(1, rows(sha, { kind: 'loss', rows: [{ id: 'b', time: 2 }] })); expect(await b).toBe(true)
    expect(store.evidenceLoading).toBe(false)
    // 失败分支
    store = prepare()
    sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    a = store.loadEvidenceRows('state'); await tick()
    b = store.loadEvidenceRows('loss'); await tick()
    expect(store.evidenceActiveRequests).toBe(1)
    expect(store.evidenceLoading).toBe(true)
    fail(0, 'old-fail'); expect(await a).toBe(false)
    expect(store.evidenceLoading).toBe(true)
    expect(store.evidenceMessage).toBe('')
    ok(1, rows(sha, { kind: 'loss', rows: [{ id: 'b', time: 2 }] })); expect(await b).toBe(true)
    expect(store.evidenceLoading).toBe(false)
    expect(store.evidenceMessage).toBe('')
  })

  it('R5-A：当前有效 rows+series 并行，任一未结束仍 loading，全部结束才关闭', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    const r = store.loadEvidenceRows('state'); await tick()
    const s = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick()
    expect(store.evidenceActiveRequests).toBe(2)
    expect(store.evidenceLoading).toBe(true)
    ok(0, rows(sha, { rows: [{ id: 'r1', time: 0 }] })); expect(await r).toBe(true)
    expect(store.evidenceActiveRequests).toBe(1)
    expect(store.evidenceLoading).toBe(true)
    ok(1, seriesView(sha, { nextCursor: null, points: [1, 2] })); expect(await s).toBe(true)
    expect(store.evidenceLoading).toBe(false)
  })

  it('R5-导出：并发 HTML 与 PDF 独立完成，计数 2→1→0 且均返回 true', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    const html = store.exportEvidence('HTML'); await tick()
    const pdf = store.exportEvidence('PDF'); await tick()
    expect(calls).toHaveLength(2)
    expect(store.evidenceActiveRequests).toBe(2)
    expect(store.evidenceLoading).toBe(true)
    calls[0]!.resolve({ ok: true })
    expect(await html).toBe(true)
    expect(store.evidenceActiveRequests).toBe(1)
    expect(store.evidenceLoading).toBe(true)
    calls[1]!.resolve({ ok: true })
    expect(await pdf).toBe(true)
    expect(store.evidenceActiveRequests).toBe(0)
    expect(store.evidenceLoading).toBe(false)
    expect(downloadCalls).toBe(2)
    expect(store.evidenceMessage).toBe('证据已导出并开始下载：PDF')
  })

  it('R5-导出：同格式 HTML 并发，后发请求先完成仍独立释放', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    const first = store.exportEvidence('HTML'); await tick()
    const second = store.exportEvidence('HTML'); await tick()
    expect(calls).toHaveLength(2)
    expect(store.evidenceActiveRequests).toBe(2)
    expect(store.evidenceLoading).toBe(true)
    calls[1]!.resolve({ ok: true })
    expect(await second).toBe(true)
    expect(store.evidenceActiveRequests).toBe(1)
    expect(store.evidenceLoading).toBe(true)
    calls[0]!.resolve({ ok: true })
    expect(await first).toBe(true)
    expect(store.evidenceActiveRequests).toBe(0)
    expect(store.evidenceLoading).toBe(false)
    expect(downloadCalls).toBe(2)
  })

  it('R5-导出：一个下载抛错返回 false，另一个挂起请求保持计数直至成功', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    downloadThrowTimes = 1
    const html = store.exportEvidence('HTML'); await tick()
    const pdf = store.exportEvidence('PDF'); await tick()
    expect(store.evidenceActiveRequests).toBe(2)
    expect(store.evidenceLoading).toBe(true)
    calls[0]!.resolve({ ok: true })
    expect(await html).toBe(false)
    expect(store.evidenceMessage).toBe('download-boom')
    expect(store.evidenceActiveRequests).toBe(1)
    expect(store.evidenceLoading).toBe(true)
    calls[1]!.resolve({ ok: true })
    expect(await pdf).toBe(true)
    expect(store.evidenceActiveRequests).toBe(0)
    expect(store.evidenceLoading).toBe(false)
    expect(downloadCalls).toBe(2)
    expect(store.evidenceMessage).toBe('证据已导出并开始下载：PDF')
  })

  it('R5-清理：reset 后逐个结束挂起的 rows 与 series，成功释放不复活计数', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    store.evidenceMessage = 'old-msg'
    const rowsP = store.loadEvidenceRows('state'); await tick()
    const seriesP = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick()
    expect(store.evidenceActiveRequests).toBe(2)
    expect(store.evidenceLoading).toBe(true)
    expect(store.evidenceActiveTokens).toHaveLength(2)
    store.resetToSafeEmpty()
    expect(store.evidenceActiveTokens).toHaveLength(0)
    expect(store.evidenceActiveRequests).toBe(0)
    expect(store.evidenceLoading).toBe(false)
    expect(store.evidenceRows).toBeNull()
    expect(store.evidenceSeries).toBeNull()
    expect(store.evidenceSeriesContext).toBeNull()
    expect(store.evidenceOverview).toBeNull()
    expect(store.evidenceMessage).toBe('')
    expect(store.selectedReport).toBeNull()
    expect(store.resultSource).toBeNull()
    ok(0, rows(sha, { kind: 'state', rows: [{ id: 'old-row', time: 9 }] }))
    expect(await rowsP).toBe(false)
    expect(store.evidenceActiveRequests).toBe(0)
    expect(store.evidenceLoading).toBe(false)
    expect(store.evidenceRows).toBeNull()
    expect(store.evidenceSeries).toBeNull()
    expect(store.evidenceMessage).toBe('')
    expect(store.selectedReport).toBeNull()
    ok(1, seriesView(sha, { nextCursor: null, points: [1, 2] }))
    expect(await seriesP).toBe(false)
    expect(store.evidenceActiveRequests).toBe(0)
    expect(store.evidenceLoading).toBe(false)
    expect(store.evidenceRows).toBeNull()
    expect(store.evidenceSeries).toBeNull()
    expect(store.evidenceSeriesContext).toBeNull()
    expect(store.evidenceMessage).toBe('')
    expect(store.resultSource).toBeNull()
  })

  it('R5-清理：reset 后逐个结束挂起的 rows 与 series，真实失败不复活计数', async () => {
    const store = prepare()
    const sha = 'a'.repeat(64)
    store.evidenceOverview = overview(sha) as never
    const rowsP = store.loadEvidenceRows('state'); await tick()
    const seriesP = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick()
    expect(store.evidenceActiveRequests).toBe(2)
    expect(store.evidenceLoading).toBe(true)
    store.resetToSafeEmpty()
    expect(store.evidenceActiveTokens).toHaveLength(0)
    expect(store.evidenceActiveRequests).toBe(0)
    expect(store.evidenceLoading).toBe(false)
    rejectCall(0, new Error('old-rows-fail'))
    expect(await rowsP).toBe(false)
    expect(store.evidenceActiveRequests).toBe(0)
    expect(store.evidenceLoading).toBe(false)
    expect(store.evidenceRows).toBeNull()
    expect(store.evidenceMessage).toBe('')
    expect(store.selectedReport).toBeNull()
    rejectCall(1, new Error('old-series-fail'))
    expect(await seriesP).toBe(false)
    expect(store.evidenceActiveRequests).toBe(0)
    expect(store.evidenceLoading).toBe(false)
    expect(store.evidenceSeries).toBeNull()
    expect(store.evidenceSeriesContext).toBeNull()
    expect(store.evidenceMessage).toBe('')
    expect(store.resultSource).toBeNull()
  })

  it('R5-清理：同一 store reset 后新请求挂起，旧成功与旧失败均不干扰', async () => {
    const store = prepare()
    const oldSha = 'a'.repeat(64)
    const newSha = 'b'.repeat(64)
    const newResult = 'RESULT-00000000-0000-0000-0000-000000000951'
    store.evidenceOverview = overview(oldSha) as never
    const oldRows = store.loadEvidenceRows('state'); await tick()
    const oldSeries = store.loadEvidenceSeries(SERIES, { maxPoints: 2 }); await tick()
    expect(store.evidenceActiveRequests).toBe(2)
    expect(calls).toHaveLength(2)
    store.resetToSafeEmpty()
    expect(store.evidenceActiveRequests).toBe(0)
    expect(store.evidenceLoading).toBe(false)
    expect(store.evidenceActiveTokens).toHaveLength(0)
    const record: MissionResultRecord = {
      resultId: newResult, scenarioId: 'SCN-2', scenarioName: 'y', revision: 2,
      startedAt: '2026-02-01T00:00:00Z', completedAt: '2026-02-01T00:01:00Z', runId: 'RUN-2', taskId: 'TASK-2',
    }
    store.$patch({ selectedReport: structuredClone(LOCAL_REPORT), resultSource: record })
    store.evidenceOverview = overview(newSha, newResult) as never
    const newRows = store.loadEvidenceRows('loss'); await tick()
    expect(calls).toHaveLength(3)
    expect(calls[2]!.url).toContain(`resultId=${newResult}`)
    expect(calls[2]!.url).toContain(`sourceSha256=${newSha}`)
    expect(calls[2]!.url).toContain('kind=loss')
    expect(store.evidenceActiveRequests).toBe(1)
    expect(store.evidenceLoading).toBe(true)
    expect(store.evidenceRows).toBeNull()
    ok(0, rows(oldSha, { kind: 'state', rows: [{ id: 'old', time: 9 }] }))
    expect(await oldRows).toBe(false)
    expect(store.evidenceActiveRequests).toBe(1)
    expect(store.evidenceLoading).toBe(true)
    expect(store.evidenceRows).toBeNull()
    expect(store.evidenceSeries).toBeNull()
    expect(store.evidenceMessage).toBe('')
    expect(store.resultSource?.resultId).toBe(newResult)
    rejectCall(1, new Error('old-series-fail'))
    expect(await oldSeries).toBe(false)
    expect(store.evidenceActiveRequests).toBe(1)
    expect(store.evidenceLoading).toBe(true)
    expect(store.evidenceRows).toBeNull()
    expect(store.evidenceSeries).toBeNull()
    expect(store.evidenceMessage).toBe('')
    expect(store.selectedReport?.reportId).toBe(reportId)
    ok(2, rows(newSha, { kind: 'loss', resultId: newResult, rows: [{ id: 'new', time: 3 }] }))
    expect(await newRows).toBe(true)
    expect(store.evidenceRows?.rows).toEqual([{ id: 'new', time: 3 }])
    expect(store.evidenceRows?.kind).toBe('loss')
    expect(store.evidenceRows?.sourceSha256).toBe(newSha)
    expect(store.evidenceRows?.resultId).toBe(newResult)
    expect(store.evidenceActiveRequests).toBe(0)
    expect(store.evidenceLoading).toBe(false)
    expect(store.evidenceMessage).toBe('')
  })
})

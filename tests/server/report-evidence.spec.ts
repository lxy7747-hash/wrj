// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_REPORT } from '../fixtures/local-report'
import type { QualityScope } from '../../src/contracts/domain-models'
import type { QualityConfig } from '../../src/features/data-exchange/quality-records'
import {
  EVIDENCE_KINDS, buildFileSetSource, buildNativeArchiveSource, collectSeriesPages, decodeEvidenceCursor, encodeEvidenceCursor, evidenceFilterKey, evidenceWindow,
  filteredRows, paginateRows, sampleSeries, seriesContinuityReliable, seriesRawPoints, type EvidenceSeriesPoint, type EvidenceSource, type EvidenceKind,
} from '../../src/features/reports/report-evidence'
import { EVIDENCE_KIND_FILE } from '../../src/features/data-exchange/evidence-contract'
import { ENGINE_FRAME_ID_STEP } from '../../src/features/data-exchange/engine-frame-snapshot'

const { createHash } = await import('node:' + 'crypto')

const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { createRunEvidenceStore } = await import('../../server/local/' + 'run-evidence.js')
const { createEngineFrameArchive } = await import('../../server/local/' + 'engine-frame-archive.js')
const { exportEvidenceReport } = await import('../../server/local/' + 'report-file.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const scope: QualityScope = { taskId: 'TASK-1', runId: 'RUN-EVID-1', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' }
const config = {
  scenario: { id: 'SCN-1', timeStep: 1 }, platforms: [{ id: 'A' }, { id: 'B' }],
  links: [{ id: 'L-1', type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B', enabled: true }], linkSettings: {},
} as unknown as QualityConfig
const STATE_CSV = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'}\nTASK-1,1.1,0,A,B,MICROWAVE,UP,12,0.0001,-70\nTASK-1,1.1,1,A,B,MICROWAVE,DOWN,9,0.2,-80`
const file = (kind: keyof typeof EVIDENCE_KIND_FILE, text: string) => ({ fileName: EVIDENCE_KIND_FILE[kind], text })

function sourceWith(rows: number): EvidenceSource {
  return buildFileSetSource({ state: Array.from({ length: rows }, (_, index) => ({ time: index, linkId: 'L-1', linkStatus: 'UP' as const, gxbDb: index % 7, ber: 0.0001, receivedPower: -70 })), loss: [], switch: [], bundleSha256: 'a'.repeat(64), capabilities: ['state'] })
}

describe('D3 报告证据投影纯逻辑', () => {
  it('D3-02 超过 50000 行的先筛后游标分页无重漏且 total 正确', () => {
    const source = sourceWith(50001)
    const window = { start: 0, end: 1e9, includeEnd: true } as const
    const rows = filteredRows(source.rowsByKind.state, undefined, window as never)
    expect(rows).toHaveLength(50001)
    const identity = { reportId: 'RPT-X', resultId: 'RESULT-X', runId: 'RUN-X', sourceSha256: 'a'.repeat(64), filterKey: evidenceFilterKey(undefined), kind: 'state' }
    const seen: string[] = []
    let cursor: string | undefined
    let guard = 0
    do {
      const page = paginateRows(rows, 200, identity, cursor)
      seen.push(...page.rows.map(row => row.id))
      cursor = page.nextCursor ?? undefined
      guard += 1
    } while (cursor !== undefined && guard < 400)
    expect(seen).toHaveLength(50001)
    expect(new Set(seen).size).toBe(50001)
  })

  it('D3-03 空白集合 total=0；错源/错筛选游标被拒绝', () => {
    const source = sourceWith(3)
    const window = { start: 100, end: 200, includeEnd: true } as const
    expect(filteredRows(source.rowsByKind.state, undefined, window as never)).toHaveLength(0)
    const identity = { reportId: 'RPT-X', resultId: 'RESULT-X', runId: 'RUN-X', sourceSha256: 'a'.repeat(64), filterKey: evidenceFilterKey(undefined), kind: 'state' }
    const cursor = paginateRows([...source.rowsByKind.state, ...source.rowsByKind.state], 1, identity).nextCursor!
    expect(() => decodeEvidenceCursor(cursor, { ...identity, sourceSha256: 'b'.repeat(64) }, 'ROW')).toThrow()
    expect(() => decodeEvidenceCursor(cursor, { ...identity, filterKey: evidenceFilterKey({ nodeId: 'A' }) }, 'ROW')).toThrow()
  })

  it('D3-04 曲线保留首尾/极值/断点，超预算时稳定续取且不超单次点数', () => {
    const points: EvidenceSeriesPoint[] = Array.from({ length: 6000 }, (_, index) => ({ time: index, value: index === 3000 ? 999 : Math.sin(index) }))
    points[1000] = { ...points[1000]!, breakBefore: true }
    const identity = { reportId: 'RPT-X', resultId: 'RESULT-X', runId: 'RUN-X', sourceSha256: 'a'.repeat(64), filterKey: evidenceFilterKey(undefined), kind: 'state', seriesId: 'state:L-1:gxb' }
    const page = sampleSeries(points, 1000, identity)
    expect(page.pointCount).toBeLessThanOrEqual(1000)
    const values = page.points.map(point => point.value)
    expect(values).toContain(999)
    expect(page.points[0]!.time).toBe(0)
    expect(page.points.at(-1)!.time).toBe(5999)
    expect(page.points.some(point => point.breakBefore)).toBe(true)
    // 构造强制点超过预算（每点都是断点）时按游标续取，单页不超限。
    const forced = Array.from({ length: 6000 }, (_, index) => ({ time: index, value: index, breakBefore: index > 0 }))
    const first = sampleSeries(forced, 1000, identity)
    expect(first.pointCount).toBe(1000)
    expect(first.nextCursor).not.toBeNull()
    const second = sampleSeries(forced, 1000, identity, first.nextCursor!)
    expect(second.pointCount).toBe(1000)
    expect(second.points[0]!.time).not.toBe(first.points.at(-1)!.time)
  })

  it('D3 复用 04 半开阶段边界：阶段末点不重复计入', () => {
    const phases = [{ id: 'A', name: '前段', startTimeS: 0, endTimeS: 5 }, { id: 'B', name: '后段', startTimeS: 5, endTimeS: 10 }]
    const evidence = { startTimeS: 0, endTimeS: 10 }
    const windowA = evidenceWindow(evidence, { stage: 'A' }, phases, 10)
    expect(filteredRows([{ id: 'x', time: 5 }], undefined, windowA)).toHaveLength(0)
    const windowB = evidenceWindow(evidence, { stage: 'B' }, phases, 10)
    expect(filteredRows([{ id: 'x', time: 5 }], undefined, windowB)).toHaveLength(1)
  })
})

describe('D3 报告证据 HTTP 接口', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'wrj-report-evidence-')); roots.push(root)
    const store = createRunEvidenceStore(join(root, 'evidence'), () => '2026-01-01T00:01:00.000Z')
    const bundle = await store.import({ files: [file('state', STATE_CSV)] }, scope, config)
    const record = { resultId: 'RESULT-00000000-0000-0000-0000-000000000777', taskId: 'TASK-1', runId: 'RUN-EVID-1', scenarioId: 'SCN-1', scenarioName: '证据', revision: 1, startedAt: scope.startedAt, completedAt: '2026-01-01T00:02:00.000Z' }
    const snapshot = { record, report: LOCAL_REPORT, parameters: { scenarioId: 'SCN-1', revision: 1, platformCount: 2, linkCount: 1, jammerCount: 0, links: [], jammers: [], phases: [] }, replay: { tracks: [] } }
    const missionResults = { list: async () => [record], get: async (id: string) => id === record.resultId ? snapshot : null, filter: async () => { throw new Error('FILTER_UNSUPPORTED') } }
    const server = createMockServer({ port: 0, missionResults: missionResults as never, runEvidenceStore: store, exportReportEvidence: (input: Parameters<typeof exportEvidenceReport>[1]) => exportEvidenceReport(join(root, 'exports'), input) })
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(server.httpServer)
    const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
    return { root, server, api, headers, record, bundle, reportId: LOCAL_REPORT.reportId, store }
  }

  it('D3-01 概览拒绝错误 resultId 与跨报告结果，选定来源返回全量统计；旧报告/导出仍兼容', async () => {
    const { server, api, headers, record, bundle, reportId } = await fixture()
    try {
      const base = `/api/v1/reports/${reportId}/evidence`
      await api.get(`${base}?resultId=not-a-result`).set(headers).expect(422)
      await api.get(`${base}?resultId=RESULT-00000000-0000-0000-0000-000000000888`).set(headers).expect(404)
      await api.get(`/api/v1/reports/RPT-LOCAL-${'e'.repeat(64)}/evidence?resultId=${record.resultId}`).set(headers).expect(404)
      const overview = await api.get(`${base}?resultId=${record.resultId}`).set(headers).expect(200)
      expect(overview.body.data.sources.map((item: { sourceSha256: string }) => item.sourceSha256)).toContain(bundle.bundleSha256)
      const selected = await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${bundle.bundleSha256}`).set(headers).expect(200)
      expect(selected.body.data.capabilities).toEqual(['state'])
      expect(selected.body.data.totals.state).toBe(2)
      await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${'f'.repeat(64)}`).set(headers).expect(409)
    } finally { if (server.httpServer.listening) await server.close() }
  })

  it('D3-02/03 rows 默认/上限、游标遍历无重漏、错游标与空集', async () => {
    const { server, api, headers, record, bundle, reportId } = await fixture()
    try {
      const url = `/api/v1/reports/${reportId}/evidence/rows?resultId=${record.resultId}&sourceSha256=${bundle.bundleSha256}&kind=state`
      const first = await api.get(`${url}&limit=1`).set(headers).expect(200)
      expect(first.body.data.total).toBe(2)
      expect(first.body.data.rows).toHaveLength(1)
      expect(first.body.data.nextCursor).toBeTruthy()
      const second = await api.get(`${url}&limit=1&cursor=${encodeURIComponent(first.body.data.nextCursor)}`).set(headers).expect(200)
      expect(second.body.data.rows[0].id).not.toBe(first.body.data.rows[0].id)
      expect(second.body.data.nextCursor).toBeNull()
      await api.get(`${url}&limit=1001`).set(headers).expect(422)
      await api.get(`${url}&kind=bogus`).set(headers).expect(422)
      await api.get(`${url}&cursor=${encodeURIComponent(first.body.data.nextCursor!)}&sourceSha256=${'c'.repeat(64)}`).set(headers).expect(422)
      const empty = await api.get(`${url}&linkId=L-9`).set(headers).expect(200)
      expect(empty.body.data).toMatchObject({ total: 0, rows: [], nextCursor: null })
    } finally { if (server.httpServer.listening) await server.close() }
  })

  it('D3-04 series 返回单位/原始与展示点数/采样方式，非法 seriesId 拒绝', async () => {
    const { server, api, headers, record, bundle, reportId } = await fixture()
    try {
      const base = `/api/v1/reports/${reportId}/evidence/series?resultId=${record.resultId}&sourceSha256=${bundle.bundleSha256}`
      const series = await api.get(`${base}&seriesId=state:L-1:gxb`).set(headers).expect(200)
      expect(series.body.data).toMatchObject({ unit: 'dB', rawCount: 2, pointCount: 2, sampling: 'FULL' })
      expect(series.body.data.points.map((point: { value: number }) => point.value)).toEqual([12, 9])
      const ber = await api.get(`${base}&seriesId=state:L-1:ber`).set(headers).expect(200)
      expect(ber.body.data).toMatchObject({ unit: 'BER' })
      await api.get(`${base}&seriesId=bogus`).set(headers).expect(422)
      await api.get(`${base}&seriesId=state:L-1:gxb&maxPoints=5001`).set(headers).expect(422)
    } finally { if (server.httpServer.listening) await server.close() }
  })

  it('D3-06 export 生成 HTML 全筛选时段文件（中文不裁切、含末段）', async () => {
    const { server, api, headers, record, bundle, reportId } = await fixture()
    try {
      const response = await api.post(`/api/v1/reports/${reportId}/evidence/export`).set(headers)
        .send({ resultId: record.resultId, sourceSha256: bundle.bundleSha256, format: 'HTML', filter: {} }).expect(200)
      const content = await readFile(response.body.data.filePath, 'utf8')
      expect(content).toContain('报告证据')
      expect(content).toContain('L-1')
      expect(content).toContain('state')
      expect(content).toContain('生成时刻')
      expect(content).toContain('误码率 · state:L-1:ber')
      expect(content).toContain('单位：比率')
      expect(content).toContain('<th>误码率</th>')
      await api.post(`/api/v1/reports/${reportId}/evidence/export`).set(headers)
        .send({ resultId: record.resultId, sourceSha256: 'd'.repeat(64), format: 'HTML' }).expect(409)
      // PDF 实际生成（无中文字体时服务端明确失败，不返回伪成功文件）。
      const pdf = await api.post(`/api/v1/reports/${reportId}/evidence/export`).set(headers)
        .send({ resultId: record.resultId, sourceSha256: bundle.bundleSha256, format: 'PDF', filter: {} })
      if (pdf.status === 200) { const buffer = await readFile(pdf.body.data.filePath); expect(buffer.length).toBeGreaterThan(100) }
      else expect(pdf.status).toBe(503)
    } finally { if (server.httpServer.listening) await server.close() }
  })

describe('P1 原生 >50000 经 D3 HTTP 有界分页；P5 download=1', () => {
  it('真实 >50000 原生归档经 HTTP 分页遍历无重漏、单帧跨页、各 kind total 正确', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-http-native-')); roots.push(root)
    const archiveScope: QualityScope = { taskId: 'TASK-1', runId: 'RUN-ARCH-HTTP', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' }
    const frames: unknown[] = []
    for (let frameId = 0; frameId < 240; frameId += 1) frames.push(makeFrame(archiveScope.runId, 0, frameId, Array.from({ length: 210 }, (_, index) => linkOf(index, index % 11, 0.0001))))
    const archive = await writeArchive(root, archiveScope, frames)
    const record = { resultId: 'RESULT-00000000-0000-0000-0000-000000000901', taskId: 'TASK-1', runId: archiveScope.runId, scenarioId: 'SCN-1', scenarioName: '归档', revision: 1, startedAt: archiveScope.startedAt, completedAt: '2026-01-01T00:02:00.000Z' }
    const snapshot = { record, report: { ...LOCAL_REPORT, localEvidence: { ...LOCAL_REPORT.localEvidence!, endTimeS: 5000 } }, parameters: { scenarioId: 'SCN-1', revision: 1, platformCount: 2, linkCount: 1, jammerCount: 0, links: [], jammers: [], phases: [] }, replay: { tracks: [] } }
    const missionResults = { list: async () => [record], get: async (id: string) => id === record.resultId ? snapshot : null, filter: async () => { throw new Error('FILTER_UNSUPPORTED') } }
    const server = createMockServer({ port: 0, missionResults: missionResults as never, engineFrameArchive: archive, exportReportEvidence: (input: Parameters<typeof exportEvidenceReport>[1]) => exportEvidenceReport(join(root, 'exports'), input) })
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    try {
      const api = request(server.httpServer), headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
      const base = `/api/v1/reports/${LOCAL_REPORT.reportId}/evidence`
      const overview = await api.get(`${base}?resultId=${record.resultId}`).set(headers).expect(200)
      const nativeSha = overview.body.data.sources.find((source: { sourceKind: string }) => source.sourceKind === 'NATIVE_ARCHIVE').sourceSha256
      const selected = await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${nativeSha}`).set(headers).expect(200)
      expect(selected.body.data.totals.segments).toBe(50400)
      let cursor: string | null = null
      const ids = new Set<string>(); let firstPage = true; let pages = 0
      do {
        const query: string = `${base}/rows?resultId=${record.resultId}&sourceSha256=${nativeSha}&kind=segments&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        const page: { body: { data: { total: number; rows: Array<{ id: string; engineEpoch?: number; frameId?: number }>; nextCursor: string | null } } } = await api.get(query).set(headers).expect(200)
        expect(page.body.data.total).toBe(50400)
        if (firstPage) { expect(page.body.data.rows[0]).toMatchObject({ engineEpoch: 0, frameId: 0 }); expect(page.body.data.rows[199]).toMatchObject({ engineEpoch: 0, frameId: 0 }); firstPage = false }
        page.body.data.rows.forEach((row: { id: string }) => ids.add(row.id))
        cursor = page.body.data.nextCursor; pages += 1
      } while (cursor && pages < 80)
      expect(ids.size).toBe(50400)
    } finally { if (server.httpServer.listening) await server.close() }
  }, 180_000)

  it('P5 download=1 返回受控文件响应；非法 download 参数 422', async () => {
    const { server, api, headers, record, bundle, reportId } = await fixture()
    try {
      const response = await api.post(`/api/v1/reports/${reportId}/evidence/export?download=1`).set(headers)
        .send({ resultId: record.resultId, sourceSha256: bundle.bundleSha256, format: 'HTML', filter: {} }).expect(200)
      expect(response.headers['content-disposition']).toContain('attachment')
      await api.post(`/api/v1/reports/${reportId}/evidence/export?download=2`).set(headers)
        .send({ resultId: record.resultId, sourceSha256: bundle.bundleSha256, format: 'HTML' }).expect(422)
    } finally { if (server.httpServer.listening) await server.close() }
  })
  })

  it('缺陷3 API 固定旧摘要精确读取 A（B 为当前），篡改 A 返回 409 且 B 仍可读', async () => {
    const { root, server, api, headers, record, bundle, reportId, store } = await fixture()
    try {
      const B_CSV = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'}\nTASK-1,1.1,9,A,B,MICROWAVE,UP,77,0.0003,-50`
      const b = await store.import({ files: [{ fileName: 'link_state.csv', text: B_CSV }] }, scope, config)
      const overview = await api.get(`/api/v1/reports/${reportId}/evidence?resultId=${record.resultId}`).set(headers).expect(200)
      expect(overview.body.data.sources.map((item: { sourceSha256: string }) => item.sourceSha256)).toContain(b.bundleSha256)
      const rowsA = await api.get(`/api/v1/reports/${reportId}/evidence/rows?resultId=${record.resultId}&sourceSha256=${bundle.bundleSha256}&kind=state`).set(headers).expect(200)
      expect(rowsA.body.data.rows.map((row: { gxbDb: number }) => row.gxbDb)).toEqual([12, 9])
      const runDir = join(root, 'evidence', 'RUN-EVID-1')
      for (const generation of (await readdir(runDir)).filter((name: string) => name.startsWith('evidence-'))) {
        const manifestPath = join(runDir, generation, 'bundle.json')
        const declared = JSON.parse(await readFile(manifestPath, 'utf8')) as { result: { bundleSha256: string } }
        if (declared.result.bundleSha256 === bundle.bundleSha256) { await writeFile(join(runDir, generation, 'files', 'link_state.csv'), B_CSV, 'utf8'); break }
      }
      await api.get(`/api/v1/reports/${reportId}/evidence?resultId=${record.resultId}&sourceSha256=${bundle.bundleSha256}`).set(headers).expect(409)
      const rowsB = await api.get(`/api/v1/reports/${reportId}/evidence/rows?resultId=${record.resultId}&sourceSha256=${b.bundleSha256}&kind=state`).set(headers).expect(200)
      expect(rowsB.body.data.rows.map((row: { gxbDb: number }) => row.gxbDb)).toEqual([77])
    } finally { if (server.httpServer.listening) await server.close() }
  })

  it('确认证据 kind 集合与文件名映射稳定（06/09 共用 DTO）', () => {
    expect(EVIDENCE_KINDS).toEqual(['quality', 'state', 'loss', 'switch', 'segments', 'switches', 'events'])
    expect(EVIDENCE_KIND_FILE.state).toBe('link_state.csv')
    const source = sourceWith(2)
    expect(source.capabilities).toEqual(['state'] as EvidenceKind[])
    expect(seriesRawPoints(source, { seriesId: 'state:L-1:gxb', kind: 'state', unit: 'dB', linkId: 'L-1' }, undefined, { start: 0, end: 10, includeEnd: true } as never).map(point => point.value)).toEqual([0, 1])
  })

  it('D2-07/D3-05 文件集与原生归档分源并存，各自统计不重复累计', () => {
    const fileSet = sourceWith(2)
    const archive = { sourceSha256: 'b'.repeat(64), frameCount: 2, firstSimulationTime: 0, lastSimulationTime: 1, missingFieldNames: [], switchRows: [], eventRows: [],
      segmentRows: [{ engineEpoch: 0, frameId: 0, simulationTime: 0, segment: { linkId: 'HOP', linkIds: ['L-1'], sourceName: 'A', sourcePlatformId: 'A', sourcePort: 'tx', targetName: 'B', targetPlatformId: 'B', targetPort: 'rx', status: 'UP', engineStatus: 'AVAILABLE', error: null, distanceM: null, losses: { freeSpaceDb: null, seaMultipathDb: null, atmosphericDb: null, cloudRainDb: null, jammingDb: null, totalDb: null }, quality: { gxbDb: 5, ber: 0.01, rxPowerDbw: null, rxPowerDbm: null }, inputTrace: { eirpDbw: null, gtDbk: null, dataRateMbps: null, frequencyGHz: null, jammers: [] } } }] }
    const native = buildNativeArchiveSource(archive as never)
    expect(fileSet.sourceSha256).not.toBe(native.sourceSha256)
    expect(fileSet.totals.state).toBe(2)
    expect(native.totals.segments).toBe(1)
    expect(native.capabilities).toEqual(['segments'])
    expect(native.rowsByKind.state).toHaveLength(0)
  })
})

// —— 缺陷 1/2/6/7 直接回归：真实归档写入/读取链路 ——
const linkOf = (index: number, gxbDb: number | null, ber: number, source = 'A', target = 'B') => ({
  linkId: `L-${index}`, linkIds: [], sourceName: source, sourcePlatformId: source, sourcePort: 'tx', targetName: target, targetPlatformId: target, targetPort: 'rx',
  status: 'UP', engineStatus: 'AVAILABLE', error: null, distanceM: null,
  losses: { freeSpaceDb: null, seaMultipathDb: null, atmosphericDb: null, cloudRainDb: null, jammingDb: null, totalDb: null },
  quality: { gxbDb, ber, rxPowerDbw: null, rxPowerDbm: null }, inputTrace: { eirpDbw: null, gtDbk: null, dataRateMbps: null, frequencyGHz: null, jammers: [] },
})
const makeFrame = (runId: string, engineEpoch: number, frameId: number, links: unknown[]) => ({ kind: 'ENGINE_FRAME', runId, engineEpoch, frameId, simulationTime: frameId * 5, modelVersion: '1', modulation: 'BPSK', links, jammers: [], routing: { switches: [], alarms: [] }, events: [], initRouting: null })
let archiveCounter = 0
async function writeArchive(root: string, archiveScope: QualityScope, frames: unknown[]) {
  const directory = join(root, 'engine-frames')
  const runDir = join(directory, archiveScope.runId)
  await mkdir(runDir, { recursive: true })
  const text = frames.map(frame => JSON.stringify(frame)).join('\n') + '\n'
  const fileName = `engine-00000000-0000-4000-8000-${String(++archiveCounter).padStart(12, '0')}.jsonl`
  await writeFile(join(runDir, fileName), text)
  const times = frames.map(frame => (frame as { simulationTime: number }).simulationTime)
  const manifest = { schemaVersion: '1.0', scope: { taskId: archiveScope.taskId, runId: archiveScope.runId, scenarioId: archiveScope.scenarioId, revision: archiveScope.revision, startedAt: archiveScope.startedAt },
    sourceSha256: sha(text), frameCount: frames.length, firstSimulationTime: Math.min(...times), lastSimulationTime: Math.max(...times), missingFieldNames: [], completedAt: '2026-01-01T00:02:00.000Z', fileName, linkBindings: {} }
  await writeFile(join(runDir, 'current.json'), JSON.stringify(manifest))
  return createEngineFrameArchive(directory, () => '2026-01-01T00:02:00.000Z')
}

describe('D3 缺陷回归：原生完整读取/身份/连续性/游标', () => {
  it('缺陷1 真实归档 >50000 明细完整读取后游标分页无重漏、单帧跨页、后段筛选与末点', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-defect1-')); roots.push(root)
    const archiveScope: QualityScope = { taskId: 'TASK-1', runId: 'RUN-ARCH-BIG', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' }
    const frames: unknown[] = []
    for (let frameId = 0; frameId < 240; frameId += 1) {
      const links = Array.from({ length: 210 }, (_, index) => linkOf(index, frameId === 239 && index === 0 ? 999 : index % 11, 0.0001))
      frames.push(makeFrame(archiveScope.runId, 0, frameId, links))
    }
    const archive = await writeArchive(root, archiveScope, frames)
    const full = await archive.loadComplete(archiveScope.runId, archiveScope, undefined, undefined)
    expect(full!.segmentRows.length).toBe(50400)
    const source = buildNativeArchiveSource(full!)
    expect(source.totals.segments).toBe(50400)
    const window = { start: 0, end: 1e9, includeEnd: true } as never
    const rows = filteredRows(source.rowsByKind.segments, undefined, window)
    expect(rows).toHaveLength(50400)
    // 单帧 210 段 > 一页：前 200 行同属 frame0。
    expect(rows[0]).toMatchObject({ engineEpoch: 0, frameId: 0 })
    expect(rows[199]).toMatchObject({ engineEpoch: 0, frameId: 0 })
    // 末行是 239 帧；分页遍历无重漏。
    expect(rows.at(-1)).toMatchObject({ engineEpoch: 0, frameId: 239 })
    const identity = { reportId: 'RPT-X', resultId: 'RESULT-X', runId: archiveScope.runId, sourceSha256: source.sourceSha256, filterKey: evidenceFilterKey(undefined), kind: 'segments' }
    const seen = new Set<string>(); let cursor: string | undefined; let guard = 0
    do { const page = paginateRows(rows, 200, identity, cursor); page.rows.forEach(row => seen.add(row.id)); cursor = page.nextCursor ?? undefined; guard += 1 } while (cursor && guard < 600)
    expect(seen.size).toBe(50400)
    // 仅筛后段（row 索引 > 50000 的时间窗口）：frame238/239 共 420 行。
    const late = filteredRows(source.rowsByKind.segments, undefined, { start: 238 * 5, end: 1e9, includeEnd: true } as never)
    expect(late).toHaveLength(420)
    // 峰值/末点保留在曲线。
    const meta = source.series.find(item => item.seriesId.startsWith('segments:0:L-0'))!
    const points = seriesRawPoints(source, meta, undefined, window)
    expect(points.at(-1)!.value).toBe(999)
  }, 120_000)

  it('缺陷1 多 epoch 时间重置按 epoch→frameId→序号分页，不按 id 字典序', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-defect1b-')); roots.push(root)
    const archiveScope: QualityScope = { taskId: 'TASK-1', runId: 'RUN-ARCH-EPOCH', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' }
    const frames = [
      makeFrame(archiveScope.runId, 0, 0, [linkOf(0, 1, 0.1)]), makeFrame(archiveScope.runId, 0, 5, [linkOf(0, 2, 0.1)]),
      makeFrame(archiveScope.runId, 1, 0, [linkOf(0, 3, 0.1)]), makeFrame(archiveScope.runId, 1, 5, [linkOf(0, 4, 0.1)]),
    ]
    const archive = await writeArchive(root, archiveScope, frames)
    const source = buildNativeArchiveSource((await archive.loadComplete(archiveScope.runId, archiveScope))!)
    const rows = filteredRows(source.rowsByKind.segments, undefined, { start: 0, end: 1e9, includeEnd: true } as never)
    expect(rows.map(row => [row.engineEpoch, row.frameId])).toEqual([[0, 0], [0, 5], [1, 0], [1, 5]])
  })

  it('缺陷2/6 原生曲线按完整身份隔离、断点用 ENGINE_FRAME_ID_STEP，且不被其他链路行污染', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-defect2-')); roots.push(root)
    const archiveScope: QualityScope = { taskId: 'TASK-1', runId: 'RUN-ARCH-ID', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' }
    const frames = [0, 5, 15].map(frameId => makeFrame(archiveScope.runId, 0, frameId, [linkOf(0, frameId + 1, 0.1), linkOf(1, 100 + frameId, 0.1, 'C', 'D')]))
    const archive = await writeArchive(root, archiveScope, frames)
    const source = buildNativeArchiveSource((await archive.loadComplete(archiveScope.runId, archiveScope))!)
    const meta = source.series.find(item => item.seriesId.startsWith('segments:0:L-0'))!
    expect(seriesContinuityReliable(meta)).toBe(true)
    const points = seriesRawPoints(source, meta, undefined, { start: 0, end: 1e9, includeEnd: true } as never)
    expect(points.map(point => point.value)).toEqual([1, 6, 16])
    expect(points[0]!.breakBefore).toBeUndefined()
    expect(points[1]!.breakBefore).toBeUndefined()
    expect(points[2]!.breakBefore).toBe(true)
  })

  it('缺陷7 曲线非法游标在所有分支被拒绝（garbage/负数/跨源/跨 filter/改 maxPoints/越界）', () => {
    const points: EvidenceSeriesPoint[] = Array.from({ length: 2000 }, (_, index) => ({ time: index, value: index }))
    const identity = { reportId: 'RPT-X', resultId: 'RESULT-X', runId: 'RUN-X', sourceSha256: 'a'.repeat(64), filterKey: evidenceFilterKey(undefined), kind: 'segments', seriesId: 'segments:0:L-0:gxb', seriesMaxPoints: 1000 }
    expect(() => sampleSeries(points, 1000, identity, 'garbage!!')).toThrow()
    const good = sampleSeries(points, 1000, identity).nextCursor!
    expect(() => decodeEvidenceCursor(good, { ...identity, sourceSha256: 'b'.repeat(64) }, 'SERIES')).toThrow()
    expect(() => decodeEvidenceCursor(good, { ...identity, filterKey: evidenceFilterKey({ nodeId: 'A' }) }, 'SERIES')).toThrow()
    expect(() => decodeEvidenceCursor(good, { ...identity, seriesMaxPoints: 500 }, 'SERIES')).toThrow()
    expect(() => decodeEvidenceCursor(good, { ...identity, seriesId: 'segments:0:L-1:gxb' }, 'SERIES')).toThrow()
    // 负数/非整数位置
    const forged = encodeEvidenceCursor({ ...identity }, -1, 'SERIES')
    expect(() => decodeEvidenceCursor(forged, identity, 'SERIES')).toThrow()
    // 携带合法游标但改 maxPoints：服务端会以新 maxPoints 绑定 identity，旧游标 seriesMaxPoints 不等 → 拒绝
    expect(() => sampleSeries(points, 500, { ...identity, seriesMaxPoints: 500 }, good)).toThrow()
  })

  it('缺陷5 导出循环消费全部续页：1200 点含末点 2398；必要断点 >5000 仍可续取不超限', () => {
    const many: EvidenceSeriesPoint[] = Array.from({ length: 1200 }, (_, index) => ({ time: index * 2, value: Math.sin(index) }))
    const identity = { reportId: 'RPT', resultId: 'RESULT', runId: 'RUN', sourceSha256: 'a'.repeat(64), filterKey: evidenceFilterKey(undefined), kind: 'segments', seriesId: 'segments:0:L-0:gxb', seriesMaxPoints: 1000 }
    const points = collectSeriesPages(many, 1000, identity)
    expect(points.at(-1)!.time).toBe(2398)
    // 必要断点超预算：每点都是断点 → 强制点约 2N，按游标分段且每页不超限。
    const forced: EvidenceSeriesPoint[] = Array.from({ length: 6000 }, (_, index) => ({ time: index, value: index, breakBefore: index > 0 }))
    const all = collectSeriesPages(forced, 5000, identity)
    expect(all.length).toBeGreaterThan(5000)
    expect(all.at(-1)!.time).toBe(5999)
    const firstPage = sampleSeries(forced, 5000, identity)
    expect(firstPage.pointCount).toBe(5000)
    expect(firstPage.nextCursor).not.toBeNull()
  })

  it('缺陷7 续页位置必须落在实际续页序列；越界/非起点拒绝，maxPoints=1/2 边界合法', () => {
    const forced: EvidenceSeriesPoint[] = Array.from({ length: 6001 }, (_, index) => ({ time: index, value: index, breakBefore: index > 0 }))
    const identity = { reportId: 'R', resultId: 'S', runId: 'RUN', sourceSha256: 'a'.repeat(64), filterKey: evidenceFilterKey(undefined), kind: 'segments', seriesId: 'segments:x:gxb', seriesMaxPoints: 2000 }
    const forged = encodeEvidenceCursor(identity, 7000, 'SERIES')
    expect(() => sampleSeries(forced, 2000, identity, forged)).toThrow()
    expect(() => sampleSeries(forced, 2000, identity, encodeEvidenceCursor(identity, 1, 'SERIES'))).toThrow()
    const one: EvidenceSeriesPoint[] = Array.from({ length: 5 }, (_, index) => ({ time: index, value: index, breakBefore: index === 3 }))
    const oneIdentity = { ...identity, seriesMaxPoints: 1 }
    const pages1 = collectSeriesPages(one, 1, oneIdentity)
    expect(pages1[0]!.time).toBe(0)
    expect(pages1.at(-1)!.time).toBe(4)
    expect(pages1.some(point => point.time === 3)).toBe(true)
    expect(sampleSeries(one, 2, { ...identity, seriesMaxPoints: 2 }).pointCount).toBeLessThanOrEqual(2)
  })

  it('缺陷2 空端口与已知端口曲线隔离：null 端口只匹配缺失端口，不匹配任意非空', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-defect2b-')); roots.push(root)
    const archiveScope: QualityScope = { taskId: 'TASK-1', runId: 'RUN-ARCH-PORT', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' }
    const nullPortLink = { ...linkOf(0, 10, 0.1), sourcePort: null }
    const knownPortLink = { ...linkOf(0, 20, 0.1), sourcePort: 'S1' }
    const frames = [makeFrame(archiveScope.runId, 0, 0, [nullPortLink, knownPortLink])]
    const archive = await writeArchive(root, archiveScope, frames)
    const source = buildNativeArchiveSource((await archive.loadComplete(archiveScope.runId, archiveScope))!)
    const nullMeta = source.series.find(item => item.seriesId.endsWith(':gxb') && item.sourcePort === null)!
    const points = seriesRawPoints(source, nullMeta, undefined, { start: 0, end: 1e9, includeEnd: true } as never)
    expect(points.map(point => point.value)).toEqual([10])
  })

  it('缺陷6 state-only 冻结步长持久化后 0→10 断线；缺步长不臆造连续', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-defect6-')); roots.push(root)
    const config2 = { scenario: { id: 'SCN-1', timeStep: 5 }, platforms: [{ id: 'A' }, { id: 'B' }], links: [{ id: 'L-1', type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B', enabled: true }], linkSettings: {} } as unknown as QualityConfig
    const csv = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'}\nTASK-1,1.1,0,A,B,MICROWAVE,UP,12,0.0001,-70\nTASK-1,1.1,10,A,B,MICROWAVE,UP,11,0.0001,-70`
    const store = createRunEvidenceStore(join(root, 'ev'), () => '2026-01-01T00:01:00.000Z')
    await store.import({ files: [{ fileName: 'link_state.csv', text: csv }] }, scope, config2)
    const bundle = (await store.load('RUN-EVID-1'))!
    expect(bundle.expectedStepS).toBe(5)
    const stepped = buildFileSetSource({ state: bundle.state, loss: bundle.loss, switch: bundle.switch, bundleSha256: bundle.result.bundleSha256, capabilities: ['state'], expectedStepS: bundle.expectedStepS })
    const meta = stepped.series.find(item => item.seriesId === 'state:L-1:gxb')!
    const points = seriesRawPoints(stepped, meta, undefined, { start: 0, end: 1e9, includeEnd: true } as never)
    expect(points.map(point => point.value)).toEqual([12, 11])
    expect(points[1]!.breakBefore).toBe(true)
    const noStep = buildFileSetSource({ state: bundle.state, loss: bundle.loss, switch: bundle.switch, bundleSha256: bundle.result.bundleSha256, capabilities: ['state'] })
    const noStepPoints = seriesRawPoints(noStep, noStep.series.find(item => item.seriesId === 'state:L-1:gxb')!, undefined, { start: 0, end: 1e9, includeEnd: true } as never)
    expect(noStepPoints[1]!.breakBefore).toBeUndefined()
  })
})

describe('缺陷4 CSV 状态端点贯穿持久化→投影→筛选', () => {
  it('state 保留 SourcePlatform/DestPlatform；节点筛选不丢行，store 重读后仍可筛', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-defect4-')); roots.push(root)
    const config2 = { scenario: { id: 'SCN-2', timeStep: 1 }, platforms: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      links: [{ id: 'L-1', type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B', enabled: true }, { id: 'L-2', type: 'MICROWAVE', sourcePlatformId: 'C', targetPlatformId: 'D', enabled: true }], linkSettings: {} } as unknown as QualityConfig
    const scope2: QualityScope = { taskId: 'TASK-1', runId: 'RUN-2', scenarioId: 'SCN-2', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' }
    const csv = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'}\nTASK-1,1.1,0,A,B,MICROWAVE,UP,12,0.0001,-70\nTASK-1,1.1,0,C,D,MICROWAVE,UP,8,0.0002,-80`
    const store = createRunEvidenceStore(join(root, 'ev'), () => '2026-01-01T00:01:00.000Z')
    const imported = await store.import({ files: [{ fileName: 'link_state.csv', text: csv }] }, scope2, config2)
    const build = (loaded: { state: Parameters<typeof buildFileSetSource>[0]['state']; loss: Parameters<typeof buildFileSetSource>[0]['loss']; switch: Parameters<typeof buildFileSetSource>[0]['switch']; result: { bundleSha256: string; capabilities: string[] } }) =>
      buildFileSetSource({ state: loaded.state, loss: loaded.loss, switch: loaded.switch, bundleSha256: loaded.result.bundleSha256, capabilities: loaded.result.capabilities as EvidenceKind[] })
    const source = build((await store.load('RUN-2', imported.bundleSha256))!)
    const window = { start: 0, end: 1e9, includeEnd: true } as never
    expect(source.rowsByKind.state.find(row => row.linkId === 'L-2')).toMatchObject({ sourcePlatformId: 'C', targetPlatformId: 'D' })
    expect(filteredRows(source.rowsByKind.state, { nodeId: 'C' }, window).map(row => row.linkId)).toEqual(['L-2'])
    // 重开 store 后按摘要重读，端点不丢
    const reopened = createRunEvidenceStore(join(root, 'ev'), () => '2026-01-01T00:02:00.000Z')
    const rebuilt = build((await reopened.load('RUN-2', imported.bundleSha256))!)
    expect(filteredRows(rebuilt.rowsByKind.state, { nodeId: 'D' }, window).map(row => row.linkId)).toEqual(['L-2'])
  })
})

describe('D2-07 同一结果同时存在原生归档与文件集：分源不重复、缺测正确、导出同批', () => {
  it('overview 返回手动文件集、任务 CSV 与原生归档，rows/series/export 按 sourceSha256 分源且切换后旧摘要仍可读', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-dual-')); roots.push(root)
    const scope2: QualityScope = { taskId: 'TASK-1', runId: 'RUN-DUAL', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' }
    const config2 = { scenario: { id: 'SCN-1', timeStep: 1 }, platforms: [{ id: 'A' }, { id: 'B' }], links: [{ id: 'L-1', type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B', enabled: true }], linkSettings: {} } as unknown as QualityConfig
    const csv = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'}\nTASK-1,1.1,0,A,B,MICROWAVE,UP,12,0.0001,-70\nTASK-1,1.1,1,A,B,MICROWAVE,UP,11,0.0001,-70`
    const evidenceStore = createRunEvidenceStore(join(root, 'evidence'), () => '2026-01-01T00:01:00.000Z')
    const first = await evidenceStore.import({ files: [{ fileName: 'link_state.csv', text: csv }] }, scope2, config2)
    const archive = await writeArchive(root, scope2, [makeFrame(scope2.runId, 0, 0, [linkOf(0, 5, 0.01)]), makeFrame(scope2.runId, 0, 5, [linkOf(0, 6, 0.01)])])
    const record = { resultId: 'RESULT-00000000-0000-0000-0000-000000000960', taskId: 'TASK-1', runId: scope2.runId, scenarioId: 'SCN-1', scenarioName: '双源', revision: 1, startedAt: scope2.startedAt, completedAt: '2026-01-01T00:02:00.000Z' }
    const snapshot = { record, report: { ...LOCAL_REPORT, localEvidence: { ...LOCAL_REPORT.localEvidence!, endTimeS: 100 } }, parameters: { scenarioId: 'SCN-1', revision: 1, platformCount: 2, linkCount: 1, jammerCount: 0, links: [], jammers: [], phases: [] }, replay: { tracks: [] } }
    const missionResults = { list: async () => [record], get: async (id: string) => id === record.resultId ? snapshot : null, filter: async () => { throw new Error('FILTER_UNSUPPORTED') } }
    const server = createMockServer({ port: 0, missionResults: missionResults as never, runEvidenceStore: evidenceStore, engineFrameArchive: archive, exportReportEvidence: (input: Parameters<typeof exportEvidenceReport>[1]) => exportEvidenceReport(join(root, 'exports'), input) })
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(server.httpServer), h = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
    try {
      const base = `/api/v1/reports/${LOCAL_REPORT.reportId}/evidence`
      const overview = await api.get(`${base}?resultId=${record.resultId}`).set(h).expect(200)
      const sources = overview.body.data.sources as Array<{ sourceKind: string; sourceSha256: string }>
      expect(sources.map(source => source.sourceKind).sort()).toEqual(['FILE_SET', 'FILE_SET', 'NATIVE_ARCHIVE'])
      const fileSetSha = sources.find(source => source.sourceSha256 === first.bundleSha256)!.sourceSha256
      const nativeSha = sources.find(source => source.sourceKind === 'NATIVE_ARCHIVE')!.sourceSha256
      expect(fileSetSha).toBe(first.bundleSha256)
      const selectedFile = await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${fileSetSha}`).set(h).expect(200)
      expect(selectedFile.body.data.totals.state).toBe(2)
      const selectedNative = await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${nativeSha}`).set(h).expect(200)
      expect(selectedNative.body.data.totals.segments).toBe(2)
      const fileRows = await api.get(`${base}/rows?resultId=${record.resultId}&sourceSha256=${fileSetSha}&kind=state`).set(h).expect(200)
      expect(fileRows.body.data.total).toBe(2)
      const nativeRows = await api.get(`${base}/rows?resultId=${record.resultId}&sourceSha256=${nativeSha}&kind=segments`).set(h).expect(200)
      expect(nativeRows.body.data.total).toBe(2)
      await api.get(`${base}/rows?resultId=${record.resultId}&sourceSha256=${fileSetSha}&kind=segments`).set(h).expect(422)
      const fileSeries = await api.get(`${base}/series?resultId=${record.resultId}&sourceSha256=${fileSetSha}&seriesId=state:L-1:gxb`).set(h).expect(200)
      expect(fileSeries.body.data.points.map((point: { value: number }) => point.value)).toEqual([12, 11])
      const nativeSeriesList = selectedNative.body.data.series as Array<{ seriesId: string }>
      const nativeSeries = await api.get(`${base}/series?resultId=${record.resultId}&sourceSha256=${nativeSha}&seriesId=${encodeURIComponent(nativeSeriesList[0]!.seriesId)}`).set(h).expect(200)
      expect(nativeSeries.body.data.rawCount).toBe(2)
      const exportFile = await api.post(`/api/v1/reports/${LOCAL_REPORT.reportId}/evidence/export`).set(h).send({ resultId: record.resultId, sourceSha256: fileSetSha, format: 'HTML', filter: {} }).expect(200)
      expect(await readFile(exportFile.body.data.filePath, 'utf8')).toContain('文件集')
      const exportNative = await api.post(`/api/v1/reports/${LOCAL_REPORT.reportId}/evidence/export`).set(h).send({ resultId: record.resultId, sourceSha256: nativeSha, format: 'HTML', filter: {} }).expect(200)
      expect(await readFile(exportNative.body.data.filePath, 'utf8')).toContain('原生帧归档')
      const second = await evidenceStore.import({ files: [{ fileName: 'link_state.csv', text: csv.replace(',12,', ',77,') }] }, scope2, config2)
      expect(second.bundleSha256).not.toBe(first.bundleSha256)
      const oldRows = await api.get(`${base}/rows?resultId=${record.resultId}&sourceSha256=${first.bundleSha256}&kind=state`).set(h).expect(200)
      expect(oldRows.body.data.rows.map((row: { gxbDb: number }) => row.gxbDb)).toEqual([12, 11])
    } finally { if (server.httpServer.listening) await server.close() }
  })
})

describe('R1/R2/R3 原生曲线强制点分页', () => {
  it('全分页无遗漏/重复/顺序稳定、每页≤预算、非法游标422、maxPoints=1位置1合法、导出覆盖全时段', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-native-series-')); roots.push(root)
    const archiveScope: QualityScope = { taskId: 'TASK-1', runId: 'RUN-ARCH-SERIES', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' }
    const frames: unknown[] = []
    for (let index = 0; index < 6000; index += 1) {
      const value = index === 4500 ? -100 : index === 5999 ? 999 : index
      frames.push(makeFrame(archiveScope.runId, 0, index * 10, [linkOf(0, value, 0.01)]))
    }
    const archive = await writeArchive(root, archiveScope, frames)
    const record = { resultId: 'RESULT-00000000-0000-0000-0000-000000000980', taskId: 'TASK-1', runId: archiveScope.runId, scenarioId: 'SCN-1', scenarioName: '曲线', revision: 1, startedAt: archiveScope.startedAt, completedAt: '2026-01-01T00:02:00.000Z' }
    const snapshot = { record, report: { ...LOCAL_REPORT, localEvidence: { ...LOCAL_REPORT.localEvidence!, endTimeS: 1e6 } }, parameters: { scenarioId: 'SCN-1', revision: 1, platformCount: 2, linkCount: 1, jammerCount: 0, links: [], jammers: [], phases: [] }, replay: { tracks: [] } }
    const missionResults = { list: async () => [record], get: async (id: string) => id === record.resultId ? snapshot : null, filter: async () => { throw new Error('FILTER_UNSUPPORTED') } }
    const server = createMockServer({ port: 0, missionResults: missionResults as never, engineFrameArchive: archive, exportReportEvidence: (input: Parameters<typeof exportEvidenceReport>[1]) => exportEvidenceReport(join(root, 'exports'), input) })
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(server.httpServer), h = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
    try {
      const base = `/api/v1/reports/${LOCAL_REPORT.reportId}/evidence`
      const overview = await api.get(`${base}?resultId=${record.resultId}`).set(h).expect(200)
      const nativeSha = overview.body.data.sources.find((source: { sourceKind: string }) => source.sourceKind === 'NATIVE_ARCHIVE').sourceSha256
      const selected = await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${nativeSha}`).set(h).expect(200)
      const seriesId = selected.body.data.series[0].seriesId as string
      const seriesUrl = `${base}/series?resultId=${record.resultId}&sourceSha256=${nativeSha}&seriesId=${encodeURIComponent(seriesId)}`
      let cursor: string | null = null, pages = 0, lastTime = -1
      const seen = new Set<number>()
      do {
        const response: { body: { data: { pointCount: number; points: Array<{ time: number }>; rawCount: number; nextCursor: string | null } } } = await api.get(`${seriesUrl}&maxPoints=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).set(h).expect(200)
        const data = response.body.data
        expect(data.pointCount).toBe(data.points.length)
        expect(data.pointCount).toBeLessThanOrEqual(1000)
        expect(data.rawCount).toBe(6000)
        for (const point of data.points as Array<{ time: number }>) { expect(point.time).toBeGreaterThan(lastTime); lastTime = point.time; seen.add(point.time) }
        cursor = data.nextCursor; pages += 1
      } while (cursor && pages < 30)
      expect(cursor).toBeNull()
      expect(seen.size).toBe(6000)
      const one = await api.get(`${seriesUrl}&maxPoints=1`).set(h).expect(200)
      expect(one.body.data.pointCount).toBe(1)
      const second = await api.get(`${seriesUrl}&maxPoints=1&cursor=${encodeURIComponent(one.body.data.nextCursor)}`).set(h).expect(200)
      expect(second.body.data.pointCount).toBe(1)
      await api.get(`${seriesUrl}&maxPoints=1000&cursor=${encodeURIComponent(one.body.data.nextCursor)}`).set(h).expect(422)
      await api.get(`${seriesUrl}&maxPoints=1000&cursor=garbage!!`).set(h).expect(422)
      const forged = encodeEvidenceCursor({ reportId: LOCAL_REPORT.reportId, resultId: record.resultId, runId: archiveScope.runId, sourceSha256: nativeSha, filterKey: evidenceFilterKey(undefined), kind: 'segments', seriesId, seriesMaxPoints: 1 }, 7000, 'SERIES')
      await api.get(`${seriesUrl}&maxPoints=1&cursor=${encodeURIComponent(forged)}`).set(h).expect(422)
      const html = await api.post(`/api/v1/reports/${LOCAL_REPORT.reportId}/evidence/export`).set(h).send({ resultId: record.resultId, sourceSha256: nativeSha, format: 'HTML', filter: {} }).expect(200)
      const content = await readFile(html.body.data.filePath, 'utf8')
      expect(content).toContain('原生帧归档'); expect(content).toContain('999')
    } finally { if (server.httpServer.listening) await server.close() }
  }, 120_000)
})

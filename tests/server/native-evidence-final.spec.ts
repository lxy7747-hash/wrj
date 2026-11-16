// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { QualityConfig } from '../../src/features/data-exchange/quality-records'
import type { QualityScope } from '../../src/contracts/domain-models'
import { encodeEvidenceCursor, evidenceFilterKey } from '../../src/features/reports/report-evidence'
import { LOCAL_REPORT } from '../fixtures/local-report'
const { createMockServer } = await import('../../server/' + 'app.js')
const { createEngineFrameArchive } = await import('../../server/local/' + 'engine-frame-archive.js')
const { createRunEvidenceStore } = await import('../../server/local/' + 'run-evidence.js')
const { exportEvidenceReport } = await import('../../server/local/' + 'report-file.js')
const { default: request } = await import('super' + 'test')
const { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')

const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
const scope: QualityScope = { taskId: 'TASK-1', runId: 'RUN-NATIVE', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' }
const ARTIFACT_ROOT = join('output', 'gnzb-final-20261111-2117', 'artifacts')
const roots: string[] = []
const servers: Array<ReturnType<typeof createMockServer>> = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const shaOf = async (text: string) => { const { createHash } = await import('node:' + 'crypto'); return createHash('sha256').update(text).digest('hex') }
const link = (gxb: number | null, ber: number | null = 0.01) => ({ linkId: 'L-1', linkIds: [], sourceName: 'A', sourcePlatformId: 'A', sourcePort: 'tx', targetName: 'B', targetPlatformId: 'B', targetPort: 'rx', status: 'UP', engineStatus: 'AVAILABLE', error: null, distanceM: null, losses: { freeSpaceDb: null, seaMultipathDb: null, atmosphericDb: null, cloudRainDb: null, jammingDb: null, totalDb: null }, quality: { gxbDb: gxb, ber, rxPowerDbw: null, rxPowerDbm: null }, inputTrace: { eirpDbw: null, gtDbk: null, dataRateMbps: null, frequencyGHz: null, jammers: [] } })
const frame = (frameId: number, gxb: number | null, ber: number | null = 0.01) => ({ kind: 'ENGINE_FRAME', runId: scope.runId, engineEpoch: 0, frameId, simulationTime: frameId, modelVersion: '1', modulation: 'BPSK', links: [link(gxb, ber)], jammers: [], routing: { switches: [], alarms: [] }, events: [], initRouting: null })
/** 交替帧增量显式累加：0,10,15,25,30,40,45…（i 奇数 +10，i 偶数 +5）。 */
function alternatingFrames(count: number): unknown[] {
  const frames: unknown[] = []; let frameId = 0
  for (let index = 0; index < count; index += 1) { if (index > 0) frameId += index % 2 === 1 ? 10 : 5; frames.push(frame(frameId, Math.round(100 * Math.sin(index / 7)))) }
  return frames
}
/** 连续 6000：内部极大 919@4000、极小 -319@1000，首末不同且非极值。 */
function continuousFrames(count = 6000): unknown[] {
  return Array.from({ length: count }, (_, index) => frame(index * 5, index === 1000 ? -319 : index === 4000 ? 919 : Math.round(200 * Math.sin(index / 50))))
}

async function serverWith(frames: unknown[], exportDir?: string) {
  const root = await mkdtemp(join(tmpdir(), 'wrj-native-final-')); roots.push(root)
  const directory = join(root, 'engine-frames')
  const runDir = join(directory, scope.runId)
  await mkdir(runDir, { recursive: true })
  const text = frames.map(item => JSON.stringify(item)).join('\n') + '\n'
  const fileName = 'engine-00000000-0000-4000-8000-000000000001.jsonl'
  await writeFile(join(runDir, fileName), text)
  const sourceSha256 = await shaOf(text)
  const manifest = { schemaVersion: '1.0', scope, sourceSha256, frameCount: frames.length, firstSimulationTime: 0, lastSimulationTime: 1e9, missingFieldNames: [], completedAt: '2026-01-01T00:02:00.000Z', fileName, linkBindings: {} }
  await writeFile(join(runDir, 'current.json'), JSON.stringify(manifest))
  // 按用户夹具规则补 per-generation 自有清单 engine-<id>.json（与 close 写入一致）。
  await writeFile(join(runDir, 'engine-00000000-0000-4000-8000-000000000001.json'), JSON.stringify(manifest))
  const archive = createEngineFrameArchive(directory, () => '2026-01-01T00:02:00.000Z')
  const record = { resultId: 'RESULT-00000000-0000-0000-0000-000000000990', taskId: 'TASK-1', runId: scope.runId, scenarioId: 'SCN-1', scenarioName: 'n', revision: 1, startedAt: scope.startedAt, completedAt: '2026-01-01T00:03:00.000Z' }
  const snapshot = { record, report: { ...LOCAL_REPORT, localEvidence: { ...LOCAL_REPORT.localEvidence!, endTimeS: 1e9 } }, parameters: { scenarioId: 'SCN-1', revision: 1, platformCount: 2, linkCount: 1, jammerCount: 0, links: [], jammers: [], phases: [] }, replay: { tracks: [] } }
  const missionResults = { list: async () => [record], get: async (id: string) => id === record.resultId ? snapshot : null, filter: async () => { throw new Error('FILTER_UNSUPPORTED') } }
  const exportRoot = exportDir ?? join(root, 'exports')
  const server = createMockServer({ port: 0, missionResults: missionResults as never, engineFrameArchive: archive, exportReportEvidence: (input: Parameters<typeof exportEvidenceReport>[1]) => exportEvidenceReport(exportRoot, input) })
  servers.push(server)
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  const base = `/api/v1/reports/${LOCAL_REPORT.reportId}/evidence`
  const overview = await api.get(`${base}?resultId=${record.resultId}`).set(headers).expect(200)
  const nativeSha = overview.body.data.sources.find((source: { sourceKind: string }) => source.sourceKind === 'NATIVE_ARCHIVE').sourceSha256 as string
  const selected = await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${nativeSha}`).set(headers).expect(200)
  const series = selected.body.data.series as Array<{ seriesId: string; unit: string }>
  const gxbSeriesId = series[0]!.seriesId, berSeriesId = series[1]!.seriesId
  const seriesUrl = (id: string) => `${base}/series?resultId=${record.resultId}&sourceSha256=${nativeSha}&seriesId=${encodeURIComponent(id)}`
  return { root, api, base, nativeSha, gxbSeriesId, berSeriesId, seriesUrl, record, archive, directory, runDir, manifest, exportRoot }
}

describe('R1 pointsNative 预算/缺测/采样（强断言）', () => {
  it('连续 20 有效点预算 1000 返回全部 20 且 FULL', async () => {
    const { api, seriesUrl, gxbSeriesId } = await serverWith(Array.from({ length: 20 }, (_, index) => frame(index * 5, index)))
    const data = (await api.get(`${seriesUrl(gxbSeriesId)}&maxPoints=1000`).set(headers).expect(200)).body.data
    expect([data.pointCount, data.rawCount, data.sampling]).toEqual([20, 20, 'FULL'])
    expect(data.points.map((p: { value: number }) => p.value)).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })
  it('GXB 缺测→下一有效点 breakBefore；BER 第二指标连续 13 点无断点', async () => {
    const frames = [...Array.from({ length: 10 }, (_, i) => frame(i * 5, i, i)), frame(50, null, 50), frame(55, 55, 55), frame(60, 60, 60)]
    const { api, seriesUrl, gxbSeriesId, berSeriesId } = await serverWith(frames)
    const gxb = (await api.get(`${seriesUrl(gxbSeriesId)}&maxPoints=1000`).set(headers).expect(200)).body.data
    expect(gxb.points.map((p: { value: number }) => p.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 55, 60])
    expect(gxb.points[10]!.breakBefore).toBe(true)
    expect(gxb.points[11]!.breakBefore).toBeUndefined()
    const ber = (await api.get(`${seriesUrl(berSeriesId)}&maxPoints=1000`).set(headers).expect(200)).body.data
    expect(ber.pointCount).toBe(13); expect(ber.rawCount).toBe(13)
    expect(ber.points.some((p: { breakBefore?: boolean }) => p.breakBefore === true)).toBe(false)
  })
  it('连续 6000 预算 5000 实际采样，首末不同且内部极值 -319@1000/919@4000 精确', async () => {
    const { api, seriesUrl, gxbSeriesId } = await serverWith(continuousFrames(6000))
    const data = (await api.get(`${seriesUrl(gxbSeriesId)}&maxPoints=5000`).set(headers).expect(200)).body.data
    expect(data.sampling).toBe('DOWNSAMPLED'); expect(data.rawCount).toBe(6000); expect(data.pointCount).toBeLessThanOrEqual(5000)
    const values = data.points.map((p: { value: number }) => p.value)
    expect(values).toContain(-319); expect(values).toContain(919)
    expect(data.points[0].value).toBe(0)
    const expectedLast = Math.round(200 * Math.sin(5999 / 50))
    expect(data.points.at(-1)!.value).toBe(expectedLast); expect(expectedLast).not.toBe(0)
  })
  it('交替帧显式累加前5 [0,10,15,25,30]；forced>5000 全分页无重复/顺序稳定/末页结束', async () => {
    const { api, seriesUrl, gxbSeriesId } = await serverWith(alternatingFrames(6000))
    let cursor: string | null = null, pages = 0; const seen = new Set<number>(); let last = -1
    const times: number[][] = []
    do {
      const response: { body: { data: { pointCount: number; points: Array<{ time: number }>; nextCursor: string | null } } } = await api.get(`${seriesUrl(gxbSeriesId)}&maxPoints=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).set(headers).expect(200)
      const data = response.body.data
      expect(data.pointCount).toBe(data.points.length); expect(data.pointCount).toBeLessThanOrEqual(1000)
      times.push(data.points.map(point => point.time))
      for (const point of data.points) { expect(point.time).toBeGreaterThan(last); last = point.time; seen.add(point.time) }
      cursor = data.nextCursor; pages += 1
    } while (cursor && pages < 40)
    expect(times[0]!.slice(0, 5)).toEqual([0, 10, 15, 25, 30])
    expect(cursor).toBeNull(); expect(seen.size).toBe(6000); expect(pages).toBeGreaterThan(1)
  })
  it('小预算 maxPoints=3 突破旧 *8 阈值仍保留全部强制点；同时间不同点按值/序号保留', async () => {
    const { api, seriesUrl, gxbSeriesId } = await serverWith(alternatingFrames(100))
    let cursor: string | null = null; const seen = new Set<number>(); let pages = 0
    do {
      const data: { points: Array<{ time: number; value: number }>; pointCount: number; nextCursor: string | null } = (await api.get(`${seriesUrl(gxbSeriesId)}&maxPoints=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).set(headers).expect(200)).body.data
      data.points.forEach((point: { time: number }) => seen.add(point.time)); cursor = data.nextCursor; pages += 1
    } while (cursor && pages < 300)
    expect(seen.size).toBe(100); expect(pages).toBeGreaterThan(24)
    const sameTime = await serverWith([frame(0, 1), frame(0, 2)])
    const data = (await sameTime.api.get(`${sameTime.seriesUrl(sameTime.gxbSeriesId)}&maxPoints=1000`).set(headers).expect(200)).body.data
    expect(data.pointCount).toBe(2); expect(data.points.map((p: { value: number }) => p.value)).toEqual([1, 2])
  })
  it('缺陷1：6点连续曲线预算 1/2/3 分页保留 [5,-100,100,-5]；预算4恰容纳、预算6全量FULL', async () => {
    const vals = [5, -100, 0, 100, 0, -5]
    const frames = vals.map((value, index) => frame(index * 5, value))
    for (const mp of [1, 2, 3]) {
      const ctx = await serverWith(frames)
      let cursor: string | null = null; const collected: number[] = []; let pages = 0
      do {
        const data: { points: Array<{ value: number }>; pointCount: number; nextCursor: string | null } =
          (await ctx.api.get(`${ctx.seriesUrl(ctx.gxbSeriesId)}&maxPoints=${mp}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).set(headers).expect(200)).body.data
        expect(data.pointCount).toBeLessThanOrEqual(mp)
        collected.push(...data.points.map((p: { value: number }) => p.value)); cursor = data.nextCursor; pages += 1
      } while (cursor && pages < 20)
      expect(cursor).toBeNull()
      expect(collected).toEqual([5, -100, 100, -5])
      expect(pages).toBeGreaterThan(1)
    }
    const exact = await serverWith(frames)
    const d4 = (await exact.api.get(`${exact.seriesUrl(exact.gxbSeriesId)}&maxPoints=4`).set(headers).expect(200)).body.data
    expect(d4.pointCount).toBe(4); expect(d4.points.map((p: { value: number }) => p.value)).toEqual([5, -100, 100, -5]); expect(d4.nextCursor).toBeNull()
    const full = await serverWith(frames)
    const d6 = (await full.api.get(`${full.seriesUrl(full.gxbSeriesId)}&maxPoints=6`).set(headers).expect(200)).body.data
    expect([d6.pointCount, d6.rawCount, d6.sampling]).toEqual([6, 6, 'FULL'])
    expect(d6.points.map((p: { value: number }) => p.value)).toEqual([5, -100, 0, 100, 0, -5])
  })
})

describe('R2/R3 原生游标与预算矩阵（强断言）', () => {
  it('真实 nextCursor 非空并成功续页；非法身份矩阵/负数/非整数/非页起点/越界/空集offset 422', async () => {
    const { api, seriesUrl, gxbSeriesId, nativeSha, record } = await serverWith(alternatingFrames(6000))
    const url = seriesUrl(gxbSeriesId)
    const first = (await api.get(`${url}&maxPoints=1000`).set(headers).expect(200)).body.data
    expect(typeof first.nextCursor).toBe('string')
    const second = (await api.get(`${url}&maxPoints=1000&cursor=${encodeURIComponent(first.nextCursor)}`).set(headers).expect(200)).body.data
    expect(second.pointCount).toBeGreaterThan(0); expect(second.points[0].time).toBeGreaterThan(first.points.at(-1).time)
    const base = { reportId: LOCAL_REPORT.reportId, resultId: record.resultId, runId: scope.runId, sourceSha256: nativeSha, filterKey: evidenceFilterKey(undefined), kind: 'segments', seriesId: gxbSeriesId, seriesMaxPoints: 1000 }
    const bad = (mutate: (identity: typeof base) => unknown, pos: number) => encodeEvidenceCursor(mutate({ ...base }) as typeof base, pos, 'SERIES')
    expect(() => encodeEvidenceCursor(base, -1, 'SERIES')).not.toThrow() // 编码不校验，decode 时拒绝
    await api.get(`${url}&maxPoints=1000&cursor=garbage!!`).set(headers).expect(422)
    await api.get(`${url}&maxPoints=1000&cursor=${encodeURIComponent(encodeEvidenceCursor(base, -1, 'SERIES'))}`).set(headers).expect(422)
    await api.get(`${url}&maxPoints=1000&cursor=${encodeURIComponent(encodeEvidenceCursor(base, 1.5, 'SERIES'))}`).set(headers).expect(422)
    await api.get(`${url}&maxPoints=1000&cursor=${encodeURIComponent(bad(identity => ({ ...identity, resultId: 'RESULT-00000000-0000-0000-0000-000000000998' }), 1000))}`).set(headers).expect(422)
    await api.get(`${url}&maxPoints=1000&cursor=${encodeURIComponent(bad(identity => ({ ...identity, runId: 'RUN-OTHER' }), 1000))}`).set(headers).expect(422)
    await api.get(`${url}&maxPoints=1000&cursor=${encodeURIComponent(bad(identity => ({ ...identity, filterKey: evidenceFilterKey({ nodeId: 'A' }) }), 1000))}`).set(headers).expect(422)
    await api.get(`${url}&maxPoints=1000&cursor=${encodeURIComponent(bad(identity => ({ ...identity, kind: 'events' }), 1000))}`).set(headers).expect(422)
    await api.get(`${url}&maxPoints=1000&cursor=${encodeURIComponent(bad(identity => ({ ...identity, seriesId: 'segments:other:gxb' }), 1000))}`).set(headers).expect(422)
    await api.get(`${url}&maxPoints=1000&cursor=${encodeURIComponent(encodeEvidenceCursor(base, 1, 'SERIES'))}`).set(headers).expect(422)
    await api.get(`${url}&maxPoints=1000&cursor=${encodeURIComponent(encodeEvidenceCursor(base, 7000, 'SERIES'))}`).set(headers).expect(422)
    await api.get(`${url}&maxPoints=1&cursor=${encodeURIComponent(first.nextCursor)}`).set(headers).expect(422) // 改 maxPoints
    // 空集同上下文 offset>0 → 422；无游标正常空
    const emptyBase = { ...base, filterKey: evidenceFilterKey({ from: 99999 }) }
    await api.get(`${url}&maxPoints=1000&from=99999&cursor=${encodeURIComponent(encodeEvidenceCursor(emptyBase, 1, 'SERIES'))}`).set(headers).expect(422)
    const empty = (await api.get(`${url}&maxPoints=1000&from=99999`).set(headers).expect(200)).body.data
    expect(empty).toMatchObject({ rawCount: 0, pointCount: 0, nextCursor: null })
    expect((await api.get(`${url}&maxPoints=1`).set(headers).expect(200)).body.data.pointCount).toBe(1)
  })
  it('R3 原生与文件集两来源 maxPoints 1/2/1000/5000/默认 每页≤预算、pointCount==length、rawCount 不变；非法值 422', async () => {
    const native = await serverWith(alternatingFrames(6000))
    for (const maxPoints of [1, 2, 1000, 5000]) {
      const response: { body: { data: { pointCount: number; points: unknown[]; rawCount: number } } } = await native.api.get(`${native.seriesUrl(native.gxbSeriesId)}&maxPoints=${maxPoints}`).set(headers).expect(200)
      expect(response.body.data.pointCount).toBe(response.body.data.points.length)
      expect(response.body.data.pointCount).toBeLessThanOrEqual(maxPoints)
      expect(response.body.data.rawCount).toBe(6000)
    }
    expect((await native.api.get(`${native.seriesUrl(native.gxbSeriesId)}`).set(headers).expect(200)).body.data.pointCount).toBeLessThanOrEqual(1000)
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '5001']) await native.api.get(`${native.seriesUrl(native.gxbSeriesId)}&maxPoints=${value}`).set(headers).expect(422)
    // 文件集来源预算矩阵
    const fs = await fileSetServer(30)
    for (const maxPoints of [1, 2, 1000, 5000]) {
      const response = await fs.api.get(`${fs.seriesUrl}&maxPoints=${maxPoints}`).set(headers).expect(200)
      expect(response.body.data.pointCount).toBe(response.body.data.points.length)
      expect(response.body.data.pointCount).toBeLessThanOrEqual(maxPoints)
      expect(response.body.data.rawCount).toBe(30)
    }
    expect((await fs.api.get(`${fs.seriesUrl}`).set(headers).expect(200)).body.data.pointCount).toBeLessThanOrEqual(1000)
  })
})

async function fileSetServer(count: number) {
  const root = await mkdtemp(join(tmpdir(), 'wrj-native-fs-')); roots.push(root)
  const config = { scenario: { id: 'SCN-1', timeStep: 1 }, platforms: [{ id: 'A' }, { id: 'B' }], links: [{ id: 'L-1', type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B', enabled: true }], linkSettings: {} } as unknown as QualityConfig
  const csv = `task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower\n${Array.from({ length: count }, (_, i) => `TASK-1,1.1,${i},A,B,MICROWAVE,UP,${i},0.01,-70`).join('\n')}`
  const store = createRunEvidenceStore(join(root, 'evidence'), () => '2026-01-01T00:01:00.000Z')
  await store.import({ files: [{ fileName: 'link_state.csv', text: csv }] }, scope, config)
  const record = { resultId: 'RESULT-00000000-0000-0000-0000-000000000992', taskId: 'TASK-1', runId: scope.runId, scenarioId: 'SCN-1', scenarioName: 'fs', revision: 1, startedAt: scope.startedAt, completedAt: '2026-01-01T00:03:00.000Z' }
  const snapshot = { record, report: { ...LOCAL_REPORT, localEvidence: { ...LOCAL_REPORT.localEvidence!, endTimeS: 1e9 } }, parameters: { scenarioId: 'SCN-1', revision: 1, platformCount: 2, linkCount: 1, jammerCount: 0, links: [], jammers: [], phases: [] }, replay: { tracks: [] } }
  const missionResults = { list: async () => [record], get: async (id: string) => id === record.resultId ? snapshot : null, filter: async () => { throw new Error('FILTER_UNSUPPORTED') } }
  const server = createMockServer({ port: 0, missionResults: missionResults as never, runEvidenceStore: store, exportReportEvidence: (input: Parameters<typeof exportEvidenceReport>[1]) => exportEvidenceReport(join(root, 'exports'), input) })
  servers.push(server); if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  const base = `/api/v1/reports/${LOCAL_REPORT.reportId}/evidence`
  const overview = await api.get(`${base}?resultId=${record.resultId}`).set(headers).expect(200)
  const sha = overview.body.data.sources.find((source: { sourceKind: string }) => source.sourceKind === 'FILE_SET').sourceSha256
  const selected = await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${sha}`).set(headers).expect(200)
  const seriesId = selected.body.data.series[0].seriesId as string
  return { api, seriesUrl: `${base}/series?resultId=${record.resultId}&sourceSha256=${sha}&seriesId=${encodeURIComponent(seriesId)}` }
}

describe('R1 导出：真实 HTML/PDF、采样/分段/极值/末点、中途失败必须失败', () => {
  it('连续 6000 导出 DOWNSAMPLED raw6000，末点/内部极值精确；PDF 实际生成', async () => {
    const artifact = join(ARTIFACT_ROOT, 'native-continuous6000')
    await mkdir(artifact, { recursive: true })
    const { api, base, nativeSha, record } = await serverWith(continuousFrames(6000), artifact)
    const html = await api.post(`${base}/export`).set(headers).send({ resultId: record.resultId, sourceSha256: nativeSha, format: 'HTML', filter: {} }).expect(200)
    const content = await readFile(html.body.data.filePath, 'utf8')
    expect(content).toContain('原始 6000'); expect(content).toContain('DOWNSAMPLED'); expect(content).toContain('第1段')
    expect(content).toContain('919'); expect(content).toContain('-319')
    const pdf = await api.post(`${base}/export`).set(headers).send({ resultId: record.resultId, sourceSha256: nativeSha, format: 'PDF', filter: {} }).expect(200)
    const buffer = await readFile(pdf.body.data.filePath); expect(buffer.length).toBeGreaterThan(500)
  }, 120_000)
  it('交替 forced6000 导出多段 FULL raw6000，含末点；PDF 实际生成', async () => {
    const artifact = join(ARTIFACT_ROOT, 'native-forced6000')
    await mkdir(artifact, { recursive: true })
    const { api, base, nativeSha, record } = await serverWith(alternatingFrames(6000), artifact)
    const html = await api.post(`${base}/export`).set(headers).send({ resultId: record.resultId, sourceSha256: nativeSha, format: 'HTML', filter: {} }).expect(200)
    const content = await readFile(html.body.data.filePath, 'utf8')
    expect(content).toContain('原始 6000'); expect(content).toContain('FULL'); expect(content).toContain('第1段'); expect(content).toContain('第2段')
    const pdf = await api.post(`${base}/export`).set(headers).send({ resultId: record.resultId, sourceSha256: nativeSha, format: 'PDF', filter: {} }).expect(200)
    expect((await readFile(pdf.body.data.filePath)).length).toBeGreaterThan(500)
  }, 120_000)
  it('导出中途 querySeriesPoints 抛错/空页有 next 必须失败（JSON/download 均不回部分附件）', async () => {
    const { api, base, nativeSha, record, archive } = await serverWith(alternatingFrames(6000))
    const original = archive.querySeriesPoints.bind(archive)
    let calls = 0
    ;(archive as unknown as { querySeriesPoints: typeof original }).querySeriesPoints = async (...args: Parameters<typeof original>) => {
      calls += 1; if (calls >= 2) throw new Error('INJECTED_FAILURE'); return original(...args)
    }
    const failed = await api.post(`${base}/export`).set(headers).send({ resultId: record.resultId, sourceSha256: nativeSha, format: 'HTML', filter: {} })
    expect(failed.status).toBe(503); expect(failed.body.ok).toBe(false)
    const download = await api.post(`${base}/export?download=1`).set(headers).send({ resultId: record.resultId, sourceSha256: nativeSha, format: 'HTML', filter: {} })
    expect(download.status).toBe(503); expect(download.headers['content-disposition']).toBeUndefined()
    // 空页但仍有 next → 失败
    ;(archive as unknown as { querySeriesPoints: typeof original }).querySeriesPoints = async (...args: Parameters<typeof original>) => {
      const result = await original(...args); return { ...result, points: [], nextOffset: result.nextOffset ?? 1 }
    }
    const stalled = await api.post(`${base}/export`).set(headers).send({ resultId: record.resultId, sourceSha256: nativeSha, format: 'HTML', filter: {} })
    expect(stalled.status).toBe(503)
  }, 120_000)
})

describe('T6 原生历史：真实 begin/append/close 两代清单与作用域', () => {
  async function realArchive() {
    const root = await mkdtemp(join(tmpdir(), 'wrj-native-t6-')); roots.push(root)
    const directory = join(root, 'engine-frames')
    const archive = createEngineFrameArchive(directory, () => '2026-01-01T00:02:00.000Z')
    const runDir = join(directory, scope.runId)
    const build = async (values: number[], exclude: string[] = []) => {
      const session = await archive.begin(scope, {})
      for (const [index, value] of values.entries()) await session.append(frame(index * 5, value) as never)
      await session.close()
      const generations = (await readdir(runDir)).filter((name: string) => /^engine-[0-9a-f-]{36}\.json$/.test(name)).map((name: string) => name.replace(/^engine-(.*)\.json$/, '$1')).filter((generation: string) => !exclude.includes(generation))
      if (generations.length !== 1) throw new Error(`expected one new generation, got ${generations.length}`)
      const generation = generations[0]!
      return { generation, manifest: JSON.parse(await readFile(join(runDir, `engine-${generation}.json`), 'utf8')) as { sourceSha256: string, scope: Record<string, unknown> } }
    }
    const a = await build([1, 2, 3]); const b = await build([9, 8, 7, 6], [a.generation])
    const record = { resultId: 'RESULT-00000000-0000-0000-0000-000000000991', taskId: 'TASK-1', runId: scope.runId, scenarioId: 'SCN-1', scenarioName: 'n', revision: 1, startedAt: scope.startedAt, completedAt: '2026-01-01T00:03:00.000Z' }
    const snapshot = { record, report: { ...LOCAL_REPORT, localEvidence: { ...LOCAL_REPORT.localEvidence!, endTimeS: 1e9 } }, parameters: { scenarioId: 'SCN-1', revision: 1, platformCount: 2, linkCount: 1, jammerCount: 0, links: [], jammers: [], phases: [] }, replay: { tracks: [] } }
    const missionResults = { list: async () => [record], get: async (id: string) => id === record.resultId ? snapshot : null, filter: async () => { throw new Error('FILTER_UNSUPPORTED') } }
    const server = createMockServer({ port: 0, missionResults: missionResults as never, engineFrameArchive: archive, exportReportEvidence: (input: Parameters<typeof exportEvidenceReport>[1]) => exportEvidenceReport(join(root, 'exports'), input) })
    servers.push(server); if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    return { runDir, api: request(`http://127.0.0.1:${server.httpServer.address().port}`), a, b, record }
  }
  it('固定 A 可读；五字段篡改 A→409 且 B 可读；删 A 清单→明确失败不借 current', async () => {
    const { runDir, api, a, b, record } = await realArchive()
    const base = `/api/v1/reports/${LOCAL_REPORT.reportId}/evidence`
    expect((await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${a.manifest.sourceSha256}`).set(headers).expect(200)).body.data.totals.segments).toBe(3)
    expect((await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${b.manifest.sourceSha256}`).set(headers).expect(200)).body.data.totals.segments).toBe(4)
    const manifestPath = join(runDir, `engine-${a.generation}.json`)
    const original = JSON.parse(await readFile(manifestPath, 'utf8')) as { scope: Record<string, unknown> }
    for (const key of ['taskId', 'runId', 'scenarioId', 'revision', 'startedAt']) {
      const tampered = structuredClone(original); tampered.scope[key] = key === 'revision' ? 99 : 'TAMPER'
      await writeFile(manifestPath, JSON.stringify(tampered))
      await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${a.manifest.sourceSha256}`).set(headers).expect(409)
      expect((await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${b.manifest.sourceSha256}`).set(headers).expect(200)).body.data.totals.segments).toBe(4)
    }
    await writeFile(manifestPath, JSON.stringify(original)); await unlink(manifestPath)
    expect((await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${a.manifest.sourceSha256}`).set(headers)).status).toBe(409)
    expect((await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${b.manifest.sourceSha256}`).set(headers).expect(200)).body.data.totals.segments).toBe(4)
  })
})

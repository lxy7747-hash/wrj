// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineFrameSnapshot } from '../../src/contracts/domain-models'
import { inspectCsvText } from '../../src/features/data-exchange/csv-contract'
import { seriesRawPoints } from '../../src/features/reports/report-evidence'
import { LOCAL_REPORT } from '../fixtures/local-report'
const { mkdtemp, readFile, readdir, rm, writeFile } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { default: request } = await import('super' + 'test')
const { createEngineFrameArchive } = await import('../../server/local/' + 'engine-frame-archive.js')
const { getEngineCsvFile, publishTaskEngineCsv } = await import('../../server/local/' + 'engine-frame-csv.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { exportEvidenceReport } = await import('../../server/local/' + 'report-file.js')

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const scope = { taskId: 'TASK-CSV', runId: 'RUN-CSV', scenarioId: 'SCN-CSV', revision: 1, startedAt: '2026-11-15T00:00:00Z' }
const bindings = {
  MICRO: { type: 'MICROWAVE' as const, sourcePlatformId: 'A', targetPlatformId: 'B' },
  DATA: { type: 'DATALINK' as const, sourcePlatformId: 'A', targetPlatformId: 'B' },
}
function frame(time: number): EngineFrameSnapshot {
  const nodes = (port: string) => [{ platformName: 'A', platformId: 'A', inPort: null, outPort: port }, { platformName: 'B', platformId: 'B', inPort: port, outPort: null }]
  return { kind: 'ENGINE_FRAME', runId: scope.runId, engineEpoch: 0, frameId: time, simulationTime: time, modelVersion: 'test', modulation: null,
    links: ['MICRO', 'DATA'].map((id, index) => ({ linkId: `segment-${id}`, linkIds: [id], sourceName: 'A', sourcePlatformId: 'A', sourcePort: id,
      targetName: 'B', targetPlatformId: 'B', targetPort: id, status: 'UP', engineStatus: 'AVAILABLE', error: null, distanceM: 100,
      quality: { gxbDb: 10 + time, ber: index ? 0.001 : 0.04, rxPowerDbm: -80, rxPowerDbw: -110 },
      losses: { freeSpaceDb: 90, seaMultipathDb: 1, atmosphericDb: 2, cloudRainDb: 3, jammingDb: 4, totalDb: 100 },
      inputTrace: { eirpDbw: null, gtDbk: null, dataRateMbps: null, frequencyGHz: null, jammers: [] } })),
    routing: { switches: time ? [{ pathId: 'new', direction: 'FORWARD', sourceName: 'A', targetName: 'B', sourcePlatformId: 'A', targetPlatformId: 'B',
      transTypes: [], nodes: nodes('DATA'), oldPathId: 'old', oldNodes: nodes('MICRO'), reasons: [{ linkId: 'segment-MICRO', reasons: ['alarm_switch'] }] }] : [], alarms: [] },
    initRouting: null, jammers: [], events: [] }
}
async function fixture(frames = [frame(0), frame(5)]) {
  const root = await mkdtemp(join(tmpdir(), 'wrj-csv-flow-')); roots.push(root)
  const directory = join(root, 'archive'), archive = createEngineFrameArchive(directory, () => scope.startedAt)
  const session = await archive.begin(scope, bindings)
  for (const value of frames) await session.append(value)
  await session.close()
  const evidence = (await archive.finalizeCsv(scope.runId, scope, {}))!
  return { root, directory, archive, evidence }
}

describe('GNZB-23/28 现行 1.1 链路 CSV 到报表', () => {
  it('提供完整字段时逐项落盘，单跳切换取同帧 BER；重开后从 CSV 读取三类报告数据', async () => {
    const { directory, archive, evidence } = await fixture()
    expect(evidence.files.map((file: { fileName: string; rowCount: number; status: string }) => [file.fileName, file.rowCount, file.status])).toEqual([
      ['link_switch.csv', 1, 'COMPLETE'], ['link_state.csv', 4, 'COMPLETE'], ['link_loss.csv', 4, 'COMPLETE'],
    ])
    const switchFile = await archive.getCsvFile(scope.runId, evidence.sourceSha256, 'link_switch.csv')
    expect(await readFile(switchFile!, 'utf8')).toContain('TASK-CSV,1.1,5,A,B,FORWARD,MICROWAVE,DATALINK,0.04,0.001,alarm_switch\r\n')
    const reopened = createEngineFrameArchive(directory, () => scope.startedAt)
    const source = (await reopened.loadCsvSource(scope.runId, scope))!
    expect(source.label).toContain('任务 CSV')
    expect(source.totals).toMatchObject({ state: 4, loss: 4, switch: 1 })
    expect(source.rowsByKind.state.map((row: { gxbDb: number }) => row.gxbDb)).toEqual([10, 10, 15, 15])
    expect(source.rowsByKind.loss[3]).toMatchObject({ totalLossDb: 100, cloudRainLossDb: 3 })
    expect(source.rowsByKind.switch[0]).toMatchObject({ oldBer: 0.04, newBer: 0.001, reason: 'alarm_switch' })
    expect(await reopened.loadCsvSource(scope.runId, scope, 'f'.repeat(64))).toBeNull()
    await expect(reopened.loadCsvSource(scope.runId, { ...scope, revision: 2 })).rejects.toThrow('作用域')
  })

  it('缺接收功率不补零，分开云雨不擅自合并，多跳切换不伪造单链路', async () => {
    const value = frame(5)
    for (const link of value.links) {
      link.quality.rxPowerDbm = null; link.quality.rxPowerDbw = null
      link.losses.cloudRainDb = null; link.losses.rainDb = 1; link.losses.cloudDb = 2
    }
    value.routing.switches[0]!.nodes.splice(1, 0, { platformName: 'C', platformId: 'C', inPort: 'DATA', outPort: 'DATA' })
    const { archive, evidence } = await fixture([value])
    expect(evidence.files).toHaveLength(3)
    for (const name of ['link_state.csv', 'link_loss.csv', 'link_switch.csv']) {
      const text = await readFile((await archive.getCsvFile(scope.runId, evidence.sourceSha256, name))!, 'utf8')
      expect(text).toContain('暂无数据')
      expect(text).not.toMatch(/NaN|undefined|null/)
      const contract = { name, version: '1.1', sourceRef: 'test', fields: text.split('\r\n')[0]!.split(',') }
      expect(inspectCsvText(contract, text).valid).toBe(true)
    }
    const source = (await archive.loadCsvSource(scope.runId, scope))!
    expect(source.totals).toMatchObject({ state: 2, loss: 2, switch: 1 })
    expect(source.rowsByKind.state[0]).toMatchObject({ gxbDb: 15, receivedPower: null })
    expect(source.rowsByKind.loss[0]).toMatchObject({ cloudRainLossDb: null, freeSpaceLossDb: 90 })
    expect(source.rowsByKind.switch[0]).toMatchObject({ oldLinkType: 'MICROWAVE', newLinkType: '暂无数据', oldBer: 0.04, newBer: null })
    const meta = source.series.find((item: { seriesId: string }) => item.seriesId === 'state:MICRO:receivedPower')!
    expect(seriesRawPoints(source, meta, undefined, { start: 0, end: 5, includeEnd: true })).toEqual([])
  })

  it('部分字段缺失仍保留所有行并标明部分覆盖，不把同端点同类型的多条链路混为一条', async () => {
    const incomplete = frame(5)
    incomplete.links[0]!.quality.rxPowerDbm = null
    incomplete.links[0]!.quality.rxPowerDbw = null
    const { archive, evidence } = await fixture([frame(0), incomplete])
    expect(evidence.files.find((file: { fileName: string }) => file.fileName === 'link_state.csv')).toMatchObject({ rowCount: 4, status: 'PARTIAL', skippedCount: 0 })
    expect((await archive.loadCsvSource(scope.runId, scope))?.label).toContain('部分覆盖')
    const ambiguous = await archive.begin(scope, { ...bindings, DUPLICATE: bindings.MICRO })
    await ambiguous.append(frame(5)); await ambiguous.close()
    const source = (await archive.loadCsvSource(scope.runId, scope))!
    expect(source.rowsByKind.state.map((row: { linkId: string }) => row.linkId)).toEqual([null, 'DATA'])
    expect(source.totals.switch).toBe(1)
    expect(source.rowsByKind.switch[0].oldBer).toBeNull()
    expect(source.series.some((item: { seriesId: string }) => item.seriesId.includes('null'))).toBe(false)
  })

  it('旧缺测清单从不可变 JSONL 重建；零次切换只写表头，保留真实零值', async () => {
    const value = frame(0)
    value.links[0]!.quality = { gxbDb: 0, ber: 0, rxPowerDbm: null, rxPowerDbw: null }
    const { directory, archive, evidence } = await fixture([value])
    const pointerPath = join(directory, scope.runId, 'csv', 'current.json')
    const oldPointer = JSON.parse(await readFile(pointerPath, 'utf8'))
    const oldManifestPath = join(directory, scope.runId, 'csv', oldPointer.generation, 'manifest.json')
    await writeFile(oldManifestPath, JSON.stringify({ sourceSha256: evidence.sourceSha256, files: [], missing: [{ fileName: 'link_state.csv', status: 'SOURCE_MISSING', reason: '旧规则缺功率时跳过整行' }] }))
    delete oldPointer.projectionVersion
    await writeFile(pointerPath, JSON.stringify(oldPointer))
    const rebuilt = await archive.finalizeCsv(scope.runId, scope, {})
    expect(rebuilt.sourceSha256).toBe(evidence.sourceSha256)
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8'))
    expect(pointer.generation).not.toBe(oldPointer.generation)
    expect(await readFile(join(directory, scope.runId, 'csv', oldPointer.generation, 'manifest.json'), 'utf8')).toContain(evidence.sourceSha256)
    expect(rebuilt.files.find((file: { fileName: string }) => file.fileName === 'link_switch.csv')).toMatchObject({ rowCount: 0, status: 'COMPLETE' })
    const source = await archive.loadCsvSource(scope.runId, scope)
    expect(source.rowsByKind.state[0]).toMatchObject({ gxbDb: 0, ber: 0, receivedPower: null })
  })

  it('任务目录整批副本含相同摘要，任一来源失败不替换旧指针', async () => {
    const { root, archive, evidence } = await fixture()
    const output = join(root, 'task-output')
    const getFile = (name: string) => archive.getCsvFile(scope.runId, evidence.sourceSha256, name)
    await archive.publishTaskCsv(scope.runId, output, evidence)
    const pointer = await readFile(join(output, 'link-csv', 'current.json'), 'utf8')
    for (const file of evidence.files) {
      const path = await getEngineCsvFile(join(output, 'link-csv'), evidence.sourceSha256, file.fileName)
      expect(await readFile(path!, 'utf8')).toBe(await readFile((await getFile(file.fileName))!, 'utf8'))
    }
    await expect(publishTaskEngineCsv(output, evidence, async (name: string) => name === 'link_loss.csv' ? null : getFile(name))).rejects.toThrow('来源')
    expect(await readFile(join(output, 'link-csv', 'current.json'), 'utf8')).toBe(pointer)
    expect((await readdir(join(output, 'link-csv'))).filter((name: string) => name.startsWith('.engine-csv-'))).toEqual([])
  })

  it('报告自动发现 CSV，支持筛选、分页和 HTML/PDF 导出；损坏文件不回退原生数据', async () => {
    const missing = frame(5); missing.links[0]!.quality.rxPowerDbm = null; missing.links[0]!.quality.rxPowerDbw = null
    const { root, archive, evidence } = await fixture([frame(0), missing])
    const record = { resultId: 'RESULT-00000000-0000-0000-0000-000000002328', ...scope, scenarioName: 'CSV test', completedAt: '2026-11-15T00:00:10Z' }
    const snapshot = { record, report: LOCAL_REPORT }
    const server = createMockServer({ port: 0, engineFrameArchive: archive,
      missionResults: { list: async () => [record], get: async () => snapshot } as never,
      exportReportEvidence: (input: Parameters<typeof exportEvidenceReport>[1]) => exportEvidenceReport(join(root, 'exports'), input) })
    try {
      if (!server.httpServer.listening) await once(server.httpServer, 'listening')
      const address = server.httpServer.address() as { port: number }
      const api = request(`http://127.0.0.1:${address.port}`)
      const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
      const base = `/api/v1/reports/${LOCAL_REPORT.reportId}/evidence`
      const overview = (await api.get(`${base}?resultId=${record.resultId}`).set(headers).expect(200)).body.data
      const csvSource = overview.sources.find((source: { label: string }) => source.label.startsWith('任务 CSV'))
      expect(csvSource.totals).toMatchObject({ state: 4, loss: 4, switch: 1 })
      const query = `resultId=${record.resultId}&sourceSha256=${csvSource.sourceSha256}`
      const rows = (await api.get(`${base}/rows?${query}&kind=state&from=5&to=5&limit=1`).set(headers).expect(200)).body.data
      expect(rows.total).toBe(2); expect(rows.rows).toHaveLength(1); expect(rows.rows[0].gxbDb).toBe(15); expect(rows.rows[0].receivedPower).toBeNull()
      const next = (await api.get(`${base}/rows?${query}&kind=state&from=5&to=5&limit=1&cursor=${encodeURIComponent(rows.nextCursor)}`).set(headers).expect(200)).body.data
      expect(next.rows[0].id).not.toBe(rows.rows[0].id)
      const series = csvSource.series.find((item: { seriesId: string }) => item.seriesId === 'state:MICRO:gxb')
      const values = (await api.get(`${base}/series?${query}&seriesId=${encodeURIComponent(series.seriesId)}`).set(headers).expect(200)).body.data
      expect(values.points.map((point: { value: number }) => point.value)).toEqual([10, 15])
      for (const format of ['HTML', 'PDF']) {
        const exported = await api.post(`${base}/export`).set(headers).send({ resultId: record.resultId, sourceSha256: csvSource.sourceSha256, format }).expect(200)
        const content = await readFile(exported.body.data.filePath)
        if (format === 'HTML') {
          expect(content.toString('utf8')).toContain('任务 CSV')
          expect(content.toString('utf8')).toContain(csvSource.sourceSha256)
          expect(content.toString('utf8')).toContain('alarm_switch')
          expect(content.toString('utf8')).toContain('暂无数据')
        } else expect(content.subarray(0, 5).toString()).toBe('%PDF-')
      }
      const path = (await archive.getCsvFile(scope.runId, evidence.sourceSha256, 'link_state.csv'))!
      await writeFile(path, (await readFile(path, 'utf8')).replace(',10,', ',99,'))
      const remaining = (await api.get(`${base}?resultId=${record.resultId}`).set(headers).expect(200)).body.data
      expect(remaining.sources).toEqual([expect.objectContaining({ sourceKind: 'NATIVE_ARCHIVE', sourceSha256: evidence.sourceSha256 })])
      expect(remaining.selectedSourceSha256).toBeNull()
      const native = (await api.get(`${base}?resultId=${record.resultId}&sourceSha256=${evidence.sourceSha256}`).set(headers).expect(200)).body.data
      expect(native).toMatchObject({ sourceKind: 'NATIVE_ARCHIVE', selectedSourceSha256: evidence.sourceSha256 })
      await api.get(`${base}?${query}`).set(headers).expect(503)
      await api.get(`${base}/rows?${query}&kind=state`).set(headers).expect(503)
      expect(await archive.getCsvFile(scope.runId, evidence.sourceSha256, 'link_state.csv')).toBeNull()
    } finally { await server.close() }
  })
})

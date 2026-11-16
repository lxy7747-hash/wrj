// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { LocalReportFilter, QualityImportRequest, QualitySample, QualityScope, Report, ScenarioDraft } from '../../src/contracts/domain-models'
import { isMissionResultSnapshot, snapshotMissionResultParameters, type MissionResultSnapshot, type MissionResultRecord, type MissionResultParameterComparison } from '../../src/features/results/mission-result'
import { LOCAL_REPLAY } from '../fixtures/local-replay'
const { createMockServer } = await import('../../server/' + 'app.js')
const { createRunQualityStore } = await import('../../server/local/' + 'run-quality.js')
const { exportLocalReport } = await import('../../server/local/' + 'report-file.js')
const { default: request } = await import('super' + 'test')
const { mkdtemp, rm, readFile } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')

const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
const servers: Array<ReturnType<typeof createMockServer>> = []
const roots: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup(buildSamples?: (scene: ScenarioDraft) => QualitySample[]) {
  const root = await mkdtemp(join(tmpdir(), 'wrj-quality-api-'))
  roots.push(root)
  const store = createRunQualityStore(root, () => '2026-11-01T02:00:00Z')
  let resultSnapshot: MissionResultSnapshot | null = null
  const server = createMockServer({ port: 0, runQualityStore: store,
    missionResults: {
      list: async () => resultSnapshot ? [resultSnapshot.record] : [],
      get: async (id: string) => resultSnapshot?.record.resultId === id ? structuredClone(resultSnapshot) : null,
      filter: async (id: string, reportId: string, filter: LocalReportFilter) => {
        if (!resultSnapshot || resultSnapshot.record.resultId !== id || resultSnapshot.report.reportId !== reportId) throw new Error('FILTER_NOT_FOUND')
        return { report: structuredClone(resultSnapshot.report), filter, timeline: [], timelineTotal: 0, stages: [], links: resultSnapshot.parameters?.links.map(link => link.id) ?? [] }
      },
    },
    exportLocalReport: (report: Report, format: 'HTML' | 'PDF' | 'CSV', actor: string, record?: MissionResultRecord, comparisons?: MissionResultParameterComparison[], filter?: LocalReportFilter) => exportLocalReport(join(root, 'reports'), report, format, actor, record, comparisons, filter),
  })
  servers.push(server)
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('HTTP测试端口不可用')
  const api = request(`http://127.0.0.1:${address.port}`)
  const scene = (await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data as ScenarioDraft
  const created = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
  const runId = created.body.data.runId as string
  const started = await api.post(`/api/v1/simulations/${runId}/commands`).set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
  const scope: QualityScope = { taskId: 'TASK-001', runId, scenarioId: 'SCN-001', revision: scene.revision, startedAt: started.body.data.startedAt }
  const link = scene.config.links[0]!
  const defaultSamples: QualitySample[] = [0, 1, 2].map(index => ({ frameId: index + 1, linkId: link.id, time: index * scene.config.scenario.timeStep,
    sourcePlatform: link.sourcePlatformId, destPlatform: link.targetPlatformId, linkType: link.type,
    frequency: link.frequency, bandwidth: link.bandwidth, distance: 1000, txPower: link.txPower,
    txAntennaGain: link.antennaGain.tx, rxAntennaGain: link.antennaGain.rx, pathLoss: 100, jammingPower: -90,
    receivedPower: -80, snr: 12, jsrDb: 9 + index, modulation: 'QPSK', ber: 1e-6, linkStatus: 'UP',
    berThreshold: 1e-5, dataRate: 2, interferenceActive: true,
    losses: { freeSpaceLossDb: 90, seaMultipathLossDb: 2, atmosphericLossDb: 2, cloudRainLossDb: 1, jammingLossDb: 5, totalLossDb: 100 },
  }))
  const samples = buildSamples ? buildSamples(scene) : defaultSamples
  const payload = (values = samples, valueScope = scope): QualityImportRequest => ({ scope: valueScope, fileName: '质量输入.json', format: 'JSON',
    text: JSON.stringify({ format: 'wrj.quality.v1', scope: valueScope, samples: values }) })
  const replay = structuredClone(LOCAL_REPLAY)
  const ids = new Map([['A', link.sourcePlatformId], ['B', link.targetPlatformId]])
  for (const node of replay.initial.nodes) { node.platformId = ids.get(node.platformId)!; node.name = node.platformId }
  for (const track of replay.tracks) {
    track.platformId = ids.get(track.platformId)!
    for (const position of track.positions) position.platformId = track.platformId
  }
  const resultId = 'RESULT-11111111-1111-4111-8111-111111111111'
  const completedAt = new Date(Date.parse(scope.startedAt) + 1000).toISOString()
  resultSnapshot = {
    record: { resultId, scenarioId: scope.scenarioId, scenarioName: scene.config.scenario.name, revision: scope.revision, startedAt: scope.startedAt, completedAt, runId, taskId: scope.taskId },
    replay, parameters: snapshotMissionResultParameters(scene),
    report: { reportId: `RPT-LOCAL-${'c'.repeat(64)}`, classification: 'LEVEL_II', generatedTime: completedAt, status: 'READY', localEvidence: {
      eventFile: { fileName: replay.initial.fileName, sha256: replay.initial.sha256 }, positionFile: { fileName: replay.fileName, sha256: replay.sha256 },
      startTimeS: 0, endTimeS: Math.max(replay.durationS, samples.at(-1)!.time), simulationComplete: true,
      positionCount: replay.recordCount, positionIssueCount: 0, waitingForPositionLine: false, eventCount: 1, eventWarningCount: 0,
      nodes: replay.initial.nodes.map(node => ({ platformId: node.platformId, name: node.name, type: node.type, side: 'blue', positionCount: replay.tracks.find(track => track.platformId === node.platformId)!.positions.length, firstTimeS: 0, lastTimeS: replay.durationS })),
      eventCounts: [{ type: 'SIMULATION_COMPLETE', count: 1 }], connections: [], deviceEvents: [],
    } },
  }
  expect(isMissionResultSnapshot(resultSnapshot)).toBe(true)
  return { api, store, scope, samples, payload, resultId, path: `/api/v1/simulations/${runId}/quality` }
}

describe('质量接入真实HTTP与文件生产', () => {
  it('从HTTP导入完整测量、可重新读取且CSV保持数值，缺少事件不伪造完整合同', async () => {
    const { api, store, scope, samples, payload, path } = await setup()
    expect((await api.get(path).set(headers).expect(200)).body.data).toBeNull()
    const result = (await api.post(path).set(headers).send(payload()).expect(200)).body.data
    expect(result.scope).toEqual(scope)
    expect(result.samples).toEqual(samples)
    expect(result.source).toMatchObject({ kind: 'FILE_IMPORT', frameIdKind: 'PROVIDED' })
    expect((await api.get(path).set(headers).expect(200)).body.data).toEqual(result)
    const qualityFile = await store.getFile(scope.runId, 'link_quality.csv')
    expect(qualityFile).not.toBeNull()
    expect(await readFile(qualityFile!.filePath, 'utf8')).toContain(',-90,-80,12,9,QPSK,0.000001,UP,0.00001,2')
    const download = await api.get(`${path}/files/link_state.csv`).set(headers).expect(200)
    expect(download.headers['content-disposition']).toContain('link_state.csv')
    const manifest = await store.getFile(scope.runId, 'manifest.json')
    const record = JSON.parse(await readFile(manifest!.filePath, 'utf8'))
    expect(record.contractsComplete).toBe(false)
    expect(record.missing.map((item: { fileName: string }) => item.fileName)).toContain('events.csv')
  })

  it('错误任务、非法BER及路径参数不能替换已接收数据', async () => {
    const { api, store, scope, samples, payload, path } = await setup()
    const good = (await api.post(path).set(headers).send(payload()).expect(200)).body.data
    await api.post(path).set(headers).send(payload(samples, { ...scope, taskId: 'TASK-OTHER' })).expect(422)
    await api.post(path).set(headers).send(payload([{ ...samples[0]!, ber: 2 }])).expect(422)
    await api.post(`${path}?path=other.csv`).set(headers).send(payload()).expect(400)
    await api.get(`${path}/files/missing.csv`).set(headers).expect(404)
    expect((await store.load(scope.runId))?.source.sha256).toBe(good.source.sha256)
    await api.post(path).set({ Origin: headers.Origin }).send(payload()).expect(403)
  })

  it('结果、筛选和导出使用同一质量版本，新导入不会改写旧报告', async () => {
    const { api, samples, payload, path, resultId } = await setup()
    const first = (await api.post(path).set(headers).send(payload()).expect(200)).body.data
    const result = (await api.get(`/api/v1/mission-results/${resultId}`).set(headers).expect(200)).body.data
    const reportId = result.report.reportId as string
    expect(reportId).toContain(`-Q-${first.source.sha256}`)
    expect(result.report.localEvidence.qualityKpis).toMatchObject({ averageJsrDb: 10, averageBer: 1e-6 })
    const filter = { from: samples[1]!.time, to: samples[2]!.time }
    const query = `?resultId=${resultId}&from=${filter.from}&to=${filter.to}`
    const filtered = (await api.get(`/api/v1/reports/${reportId}/filter${query}`).set(headers).expect(200)).body.data
    expect(filtered.report.localEvidence.qualityKpis.averageJsrDb).toBe(10.5)
    expect(filtered.report.localEvidence.quality.samples).toHaveLength(2)
    const exportRequest = { reportId, format: 'CSV', qualitySha256: first.source.sha256, filter }
    const exported = (await api.post(`/api/v1/reports/${reportId}/export?resultId=${resultId}`).set(headers).send(exportRequest).expect(200)).body.data
    expect(await readFile(exported.filePath, 'utf8')).toContain('10.50 dB')
    const second = (await api.post(path).set(headers).send(payload(samples.map(sample => ({ ...sample, jsrDb: 99 })))).expect(200)).body.data
    const newer = (await api.get(`/api/v1/mission-results/${resultId}`).set(headers).expect(200)).body.data
    expect(newer.report.reportId).not.toBe(reportId)
    const old = (await api.get(`/api/v1/reports/${reportId}/filter${query}`).set(headers).expect(200)).body.data
    expect(old.report.localEvidence.quality.source.sha256).toBe(first.source.sha256)
    expect(old.report.localEvidence.qualityKpis.averageJsrDb).toBe(10.5)
    const oldFile = await api.get(`${path}/files/link_quality.csv?sourceSha256=${first.source.sha256}`).set(headers).expect(200)
    expect(oldFile.headers['x-quality-source-sha256']).toBe(first.source.sha256)
    expect(oldFile.headers['content-type']).toContain('application/octet-stream')
    expect(oldFile.body.toString('utf8')).not.toContain(',99,QPSK,')
    await api.post(`/api/v1/reports/${newer.report.reportId}/export?resultId=${resultId}`).set(headers).send({ ...exportRequest, reportId: newer.report.reportId }).expect(409)
    const oldExport = (await api.post(`/api/v1/reports/${reportId}/export?resultId=${resultId}`).set(headers).send(exportRequest).expect(200)).body.data
    expect(await readFile(oldExport.filePath, 'utf8')).toContain(first.source.sha256)
    expect(second.source.sha256).not.toBe(first.source.sha256)
  })

  it('A3 筛选后反转子集经真实HTTP报告/筛选/导出：帧序合法、范围来源一致、HTML+PDF 生成', async () => {
    const build = (scene: ScenarioDraft): QualitySample[] => {
      const mw = scene.config.links.find(link => link.id === 'L-MW-01')!
      const sat = scene.config.links.find(link => link.id === 'L-SAT-02')!
      const mk = (link: typeof mw, frameId: number, time: number, jsrDb: number): QualitySample => ({
        frameId, linkId: link.id, time, sourcePlatform: link.sourcePlatformId, destPlatform: link.targetPlatformId, linkType: link.type,
        frequency: link.frequency, bandwidth: link.bandwidth, distance: 1000, txPower: link.txPower,
        txAntennaGain: link.antennaGain.tx, rxAntennaGain: link.antennaGain.rx, pathLoss: 100, jammingPower: -90,
        receivedPower: -80, snr: 12, jsrDb, modulation: 'QPSK', ber: 1e-6, linkStatus: 'UP', berThreshold: 1e-5, dataRate: 2, interferenceActive: true,
        losses: { freeSpaceLossDb: 90, seaMultipathLossDb: 2, atmosphericLossDb: 2, cloudRainLossDb: 1, jammingLossDb: 5, totalLossDb: 100 },
      })
      // 已知帧后补充另一条链路：筛选 L-SAT-02 会得到 [f1, f0] 的反转子集
      return [mk(mw, 0, 0, 10), mk(sat, 1, 1, 20), mk(sat, 0, 0, 30)]
    }
    const { api, payload, resultId, path } = await setup(build)
    const imported = (await api.post(path).set(headers).send(payload()).expect(200)).body.data
    // 报告成功挂载（若投影帧序非法会在此抛错）
    const result = (await api.get(`/api/v1/mission-results/${resultId}`).set(headers).expect(200)).body.data
    const reportId = result.report.reportId as string
    expect(reportId).toContain(`-Q-${imported.source.sha256}`)
    // 真实 HTTP 按链路筛选：反转被校正为合法全局帧序 [0,1]
    const filtered = (await api.get(`/api/v1/reports/${reportId}/filter?resultId=${resultId}&linkId=L-SAT-02`).set(headers).expect(200)).body.data
    const filteredSamples = filtered.report.localEvidence.quality.samples as Array<{ frameId: number; linkId: string; jsrDb: number }>
    expect(filteredSamples.map(sample => sample.frameId)).toEqual([0, 1])
    expect(filteredSamples.every(sample => sample.linkId === 'L-SAT-02')).toBe(true)
    expect(filteredSamples.map(sample => sample.jsrDb)).toEqual([30, 20])
    // 导出 HTML/PDF 使用同一筛选范围与来源
    for (const format of ['HTML', 'PDF'] as const) {
      const exportRequest = { reportId, format, qualitySha256: imported.source.sha256, filter: { linkId: 'L-SAT-02' } }
      const exported = (await api.post(`/api/v1/reports/${reportId}/export?resultId=${resultId}`).set(headers).send(exportRequest).expect(200)).body.data
      const bytes = await readFile(exported.filePath)
      if (format === 'PDF') expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
      else {
        const text = bytes.toString('utf8')
        const start = text.indexOf('<h2>GXB 随时间变化 · L-SAT-02</h2>')
        expect(start).toBeGreaterThanOrEqual(0)
        const cut = text.indexOf('<h2>', start + 1)
        const gxb = text.slice(start, cut < 0 ? undefined : cut)
        expect(gxb).toContain('<title>0分0秒: 30 dB</title>')
        expect(gxb).toContain('<title>0分1秒: 20 dB</title>')
        expect(gxb).toContain('横轴：0～1 秒；纵轴：20～30 dB')
        expect(text).toContain('链路=L-SAT-02')
      }
    }
  })
})

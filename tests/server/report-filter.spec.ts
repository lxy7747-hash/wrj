// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { LocalDetectionEvent, LocalReportFilter } from '../../src/contracts/domain-models'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { POSITION_CSV } from '../fixtures/local-replay'

const { mkdtemp, mkdir, readFile, rm, unlink, writeFile } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { once } = await import('node:' + 'events')
const { join } = await import('node:' + 'path')
const { createHash } = await import('node:' + 'crypto')
const { readLocalReport } = await import('../../server/local/' + 'report-file.js')
const { exportLocalReport } = await import('../../server/local/' + 'report-file.js')
const { readLocalReplay } = await import('../../server/local/' + 'afsim-replay-reader.js')
const { readAfsimLogFile } = await import('../../server/local/' + 'afsim-log-reader.js')
const { eventCsvRow } = await import('../../server/local/' + 'time-series.js')
const { publishReportFilterIndex, filterMissionReport } = await import('../../server/local/' + 'report-filter.js')
const { EVENTS_CSV_HEADER } = await import('../../src/contracts/' + 'domain-models.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(canonical = false, eventCsv = REPORT_EVENT_CSV) {
  const root = await mkdtemp(join(tmpdir(), 'wrj-report-filter-')); roots.push(root)
  const events = join(root, 'scenario_events.csv'), positions = join(root, 'position.csv'), resultDir = join(root, 'results')
  await mkdir(resultDir); await writeFile(events, eventCsv + '\n'); await writeFile(positions, POSITION_CSV)
  const [report, replay, source] = await Promise.all([readLocalReport(events, positions), readLocalReplay(events, positions, true), readAfsimLogFile(events)])
  if (!report) throw new Error('fixture report missing')
  const record = { resultId: 'RESULT-00000000-0000-0000-0000-000000000099', scenarioId: 'SCN-001', scenarioName: '筛选', revision: 1, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z' }
  const indexReport = canonical ? { ...report, localEvidence: { ...report.localEvidence!, messageDetailsComplete: false as const, messageDetailEventCount: report.localEvidence!.eventCount } } : report
  const canonicalPath = join(root, 'events.csv')
  if (canonical) await writeFile(canonicalPath, `${EVENTS_CSV_HEADER}\n${source.events.map((event: { time: number; type: string; id: string; sourceLine: number; subject: string; fields: Record<string, string> }) => eventCsvRow(event, 'TASK-FILTER')).join('\n')}\n`)
  const log = canonical ? { ...source, messageDetailsComplete: false as const, messageDetailEventCount: source.summary.eventCount } : source
  const snapshot = { record, replay, report: indexReport } as const
  await publishReportFilterIndex(resultDir, record, indexReport, replay, log, {
    // Native REPORT_EVENT_CSV has tx/rx but no link_id. Mapping is the authoritative link binding.
    devices: [{ linkId: 'L-RELAY', source: { platformId: 'A', deviceId: 'tx' }, target: { platformId: 'B', deviceId: 'rx' }, relay: { platformId: 'R', ingressDeviceId: 'relay-in', egressDeviceId: 'relay-out' } }],
    ...(canonical ? { canonicalEventsPath: canonicalPath } : {}),
  })
  return { root, resultDir, record, snapshot }
}

describe('ESM 侦测规范事件进入报告与筛选', () => {
  // 在示例事件文件中插入原生 ESM 声明与两条侦测记录（B 侦测 A：2 秒侦测到，8 秒未侦测到）。
  const withDetections = REPORT_EVENT_CSV
    .replace('! SIMULATION_COMPLETE', '! SENSOR_DETECTION_CHANGED,time<time>,event<string>,platform<string>,side<string>,target_platform<string>,sensor<string>,mode<string>,Pd<double>,required_Pd<double>,detected<bool>\n! SIMULATION_COMPLETE')
    .replace('5,LINK_ADDED_TO_MANAGER', '2,SENSOR_DETECTION_CHANGED,B,red,A,esm,default,9.000000e-01,1.177022e-01,1\n5,LINK_ADDED_TO_MANAGER')
    .replace('10,SIMULATION_COMPLETE', '8,SENSOR_DETECTION_CHANGED,B,red,A,esm,default,0,1.177022e-01,0\n10,SIMULATION_COMPLETE')

  it('报告含目标、概率、时刻与结论；时间与节点筛选同步收窄，导出表格一致', async () => {
    const { resultDir, snapshot } = await fixture(false, withDetections)
    const times = (rows: LocalDetectionEvent[] | undefined) => rows?.map(row => row.time)
    const all: LocalDetectionEvent[] = snapshot.report.localEvidence!.detectionEvents!
    expect(all.map(row => [row.time, row.platformId, row.targetPlatformId, row.probability, row.detected])).toEqual([[2, 'B', 'A', 0.9, true], [8, 'B', 'A', 0, false]])
    const early = await filterMissionReport(resultDir, snapshot, { from: 0, to: 5 })
    expect(times(early.report.localEvidence?.detectionEvents)).toEqual([2])
    // 只看节点 A：该节点是被侦测目标，但侦测平台 B 不在所选范围内，不展示他方传感器记录。
    const targetOnly = await filterMissionReport(resultDir, snapshot, { nodeId: 'A' })
    expect(targetOnly.report.localEvidence?.detectionEvents).toBeUndefined()
    const sensorNode = await filterMissionReport(resultDir, snapshot, { nodeId: 'B' })
    expect(times(sensorNode.report.localEvidence?.detectionEvents)).toEqual([2, 8])
    const late = await filterMissionReport(resultDir, snapshot, { from: 9, to: 10 })
    expect(late.report.localEvidence?.detectionEvents).toBeUndefined()
  })
})

describe('结果报表筛选索引', () => {
  it('仿真恰在相邻阶段边界提前结束时，结束事件仍只归后阶段', async () => {
    const { resultDir, snapshot } = await fixture(false, REPORT_EVENT_CSV.replace('10,SIMULATION_COMPLETE', '5,SIMULATION_COMPLETE'))
    const phases = [{ id: 'EARLY', name: '前段', startTimeS: 0, endTimeS: 5 }, { id: 'LATE', name: '后段', startTimeS: 5, endTimeS: 10 }]
    const staged = { ...snapshot, parameters: { scenarioId: snapshot.record.scenarioId, revision: snapshot.record.revision, platformCount: 2, linkCount: 0, jammerCount: 0, links: [], jammers: [], phases } }
    const early = await filterMissionReport(resultDir, staged, { stage: 'EARLY' }), late = await filterMissionReport(resultDir, staged, { stage: 'LATE' })
    expect(early.timeline.every((row: { time: number }) => row.time < 5)).toBe(true)
    expect(early.report.localEvidence?.simulationComplete).toBe(false)
    expect(late.report.localEvidence?.simulationComplete).toBe(true)
    expect(early.timelineTotal + late.timelineTotal).toBe(9)
  })
  it('任务阶段来自冻结计划，边界事件只归一个阶段，位置与统计使用相同区间', async () => {
    const { resultDir, snapshot } = await fixture()
    const phases = [{ id: 'EARLY', name: '前段', startTimeS: 0, endTimeS: 5 }, { id: 'LATE', name: '后段', startTimeS: 5, endTimeS: 10 }]
    const staged = { ...snapshot, parameters: { scenarioId: snapshot.record.scenarioId, revision: snapshot.record.revision, platformCount: 2, linkCount: 0, jammerCount: 0, links: [], jammers: [], phases } }
    const all = await filterMissionReport(resultDir, staged, {})
    const early = await filterMissionReport(resultDir, staged, { stage: 'EARLY' }), late = await filterMissionReport(resultDir, staged, { stage: 'LATE' })
    expect(all.stages).toEqual(['EARLY', 'LATE'])
    expect(early.timeline.every((event: { time: number }) => event.time < 5)).toBe(true)
    expect(late.timeline.every((event: { time: number }) => event.time >= 5 && event.time <= 10)).toBe(true)
    expect(early.timelineTotal + late.timelineTotal).toBe(all.timelineTotal)
    expect(early.report.localEvidence?.positionCount).toBe(3)
    expect(late.report.localEvidence?.positionCount).toBe(0)
    expect(late.report.localEvidence?.connections[0]?.time).toBe(5)
    expect(late.report.localEvidence?.simulationComplete).toBe(true)
    await expect(filterMissionReport(resultDir, staged, { stage: 'MISSING' })).rejects.toThrow('FILTER_INVALID')
    await expect(filterMissionReport(resultDir, staged, { stage: 'EARLY', from: 6 })).rejects.toThrow('FILTER_INVALID')
  })
  it('节点与链路联合筛选拒绝不相交条件，避免位置统计落入另一条链路', async () => {
    const { resultDir, record, snapshot } = await fixture()
    const path = join(resultDir, `${record.resultId}.report-index.json`)
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.links.push({ id: 'L-B-ONLY', nodes: ['B'] })
    manifest.bindingsSha256 = createHash('sha256').update(JSON.stringify(manifest.links)).digest('hex')
    await writeFile(path, JSON.stringify(manifest))
    await expect(filterMissionReport(resultDir, snapshot, { nodeId: 'A', linkId: 'L-B-ONLY' })).rejects.toThrow('FILTER_INVALID')
    expect((await filterMissionReport(resultDir, snapshot, { nodeId: 'B', linkId: 'L-B-ONLY' })).report.localEvidence?.positionCount).toBe(1)
  })
  it('拒绝缺失、超大、错来源和无效链路清单，不改变快照', async () => {
    const { resultDir, record, snapshot } = await fixture()
    const path = join(resultDir, `${record.resultId}.report-index.json`)
    const original = await readFile(path, 'utf8'), manifest = JSON.parse(original)
    await unlink(path)
    await expect(filterMissionReport(resultDir, snapshot, {})).rejects.toThrow('FILTER_UNSUPPORTED')
    await writeFile(path, ' '.repeat(1024 * 1024 + 1))
    await expect(filterMissionReport(resultDir, snapshot, {})).rejects.toThrow('FILTER_UNSUPPORTED')
    for (const patch of [{ reportId: 'OTHER' }, { sourceSha256: 'f'.repeat(64) }, { positionSha256: 'e'.repeat(64) },
      { rowCount: -1 }, { links: [null] }, { links: [{ id: 'BAD', nodes: [null] }] }, { bindingsSha256: 'd'.repeat(64) }]) {
      await writeFile(path, JSON.stringify({ ...manifest, ...patch }))
      await expect(filterMissionReport(resultDir, snapshot, {})).rejects.toThrow('FILTER_UNSUPPORTED')
    }
    await writeFile(path, original)
    expect((await filterMissionReport(resultDir, snapshot, {})).timelineTotal).toBe(9)
  })

  it('连续归档表头、字段、参数或尾行损坏时拒绝发布筛选索引，原索引仍可用', async () => {
    const { root, resultDir, record, snapshot } = await fixture(true)
    const canonicalPath = join(root, 'events.csv'), source = await readAfsimLogFile(join(root, 'scenario_events.csv'))
    const csv = await readFile(canonicalPath, 'utf8'), rows = csv.trimEnd().split('\n')
    const badTime = [...rows]; badTime[1] = badTime[1]!.replace(/TASK-FILTER,1.1,[^,]+,/, 'TASK-FILTER,1.1,NaN,')
    const invalidInputs = [csv.replace(EVENTS_CSV_HEADER, 'bad-header'), `${EVENTS_CSV_HEADER}\nwrong,row\n`, badTime.join('\n') + '\n', csv.trimEnd()]
    let suffix = 200
    for (const input of invalidInputs) {
      await writeFile(canonicalPath, input)
      const next = { ...record, resultId: `RESULT-00000000-0000-0000-0000-${String(++suffix).padStart(12, '0')}` }
      await expect(publishReportFilterIndex(resultDir, next, snapshot.report, snapshot.replay,
        { ...source, messageDetailsComplete: false }, { devices: [], canonicalEventsPath: canonicalPath })).rejects.toThrow()
    }
    await expect(publishReportFilterIndex(resultDir, { ...record, resultId: 'RESULT-00000000-0000-0000-0000-000000000300' }, snapshot.report, snapshot.replay,
      { ...source, messageDetailsComplete: false }, { devices: [] })).rejects.toThrow('缺少')
    expect((await filterMissionReport(resultDir, snapshot, {})).timelineTotal).toBe(9)
  })
  it('索引文件写入失败可控拒绝，并保留已发布结果的可查询索引', async () => {
    const { root, resultDir, record, snapshot } = await fixture(true)
    await mkdir(join(resultDir, `${record.resultId}.report-index.ndjson.pending`))
    const source = await readAfsimLogFile(join(root, 'scenario_events.csv'))
    await expect(publishReportFilterIndex(resultDir, record, snapshot.report, snapshot.replay,
      { ...source, messageDetailsComplete: false }, { devices: [], canonicalEventsPath: join(root, 'events.csv') })).rejects.toThrow()
    expect((await filterMissionReport(resultDir, snapshot, {})).timelineTotal).toBe(9)
  })
  it('以原生设备字段绑定中继链路；节点、链路、空范围与阶段拒绝均不伪造统计', async () => {
    const { resultDir, snapshot } = await fixture()
    const link = await filterMissionReport(resultDir, snapshot, { linkId: 'L-RELAY' })
    expect(link.links).toEqual(['L-RELAY'])
    expect(link.report.localEvidence?.nodes.map((node: { platformId: string }) => node.platformId).sort()).toEqual(['A', 'B'])
    expect(link.report.localEvidence?.eventCounts.some((row: { type: string }) => row.type === 'LINK_ADDED_TO_MANAGER')).toBe(true)
    const empty = await filterMissionReport(resultDir, snapshot, { nodeId: 'B', from: 1, to: 3 })
    expect(empty.report.localEvidence?.nodes[0]).toMatchObject({ positionCount: 0, firstTimeS: 1, lastTimeS: 1 })
    expect(empty.report.localEvidence?.simulationComplete).toBe(false)
    await expect(filterMissionReport(resultDir, snapshot, { stage: 'PHASE-1' })).rejects.toThrow('FILTER_UNSUPPORTED')
    await expect(filterMissionReport(resultDir, snapshot, { nodeId: 'missing' })).rejects.toThrow('FILTER_INVALID')
    await expect(filterMissionReport(resultDir, snapshot, { from: 99 })).rejects.toThrow('FILTER_INVALID')
  })

  it('限制详情为 500 条但保留全量聚合和时间线总数', async () => {
    const { resultDir, record, snapshot } = await fixture()
    const row = JSON.stringify({ time: 5, type: 'LINK_ADDED_TO_MANAGER', id: 'IDX', subject: 'A', target: 'B', sourceDeviceId: 'tx', targetDeviceId: 'rx', linkId: 'L-RELAY', scope: 'INTER_PLATFORM' })
    const text = Array.from({ length: 501 }, (_, index) => row.replace('"IDX"', `"IDX-${index}"`)).join('\n') + '\n'
    const index = join(resultDir, `${record.resultId}.report-index.ndjson`), manifestPath = join(resultDir, `${record.resultId}.report-index.json`)
    await writeFile(index, text)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.rowCount = 501; manifest.sha256 = createHash('sha256').update(text).digest('hex')
    await writeFile(manifestPath, JSON.stringify(manifest))
    const filtered = await filterMissionReport(resultDir, snapshot, { linkId: 'L-RELAY' })
    expect(filtered.timelineTotal).toBe(501)
    expect(filtered.timeline).toHaveLength(500)
    expect(filtered.report.localEvidence?.eventCount).toBe(501)
    expect(filtered.report.localEvidence?.connections).toHaveLength(500)
  })

  it('fail-closes missing, corrupt, cross-result and cross-source sidecars without invalidating the stored report', async () => {
    const { resultDir, record, snapshot } = await fixture()
    const index = join(resultDir, `${record.resultId}.report-index.ndjson`), manifestPath = join(resultDir, `${record.resultId}.report-index.json`)
    await unlink(index)
    await expect(filterMissionReport(resultDir, snapshot, {})).rejects.toThrow('FILTER_UNSUPPORTED')
    await writeFile(index, '{}\n')
    await expect(filterMissionReport(resultDir, snapshot, {})).rejects.toThrow('FILTER_UNSUPPORTED')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.resultId = 'RESULT-00000000-0000-0000-0000-000000000100'
    await writeFile(manifestPath, JSON.stringify(manifest))
    await expect(filterMissionReport(resultDir, snapshot, {})).rejects.toThrow('FILTER_UNSUPPORTED')
  })

  it('indexes canonical continuous-event rows when message details are omitted from the replay', async () => {
    const { resultDir, snapshot } = await fixture(true)
    const filtered = await filterMissionReport(resultDir, snapshot, {})
    expect(filtered.report.localEvidence).toMatchObject({ eventCount: 9, messageDetailsComplete: false, messageDetailEventCount: 1 })
    expect(filtered.timelineTotal).toBe(9)
  })

  it('rejects duplicate/NaN query filters and exports the same result-bound range', async () => {
    const { root, resultDir, record, snapshot } = await fixture()
    const results = {
      list: async () => [record], get: async (id: string) => id === record.resultId ? snapshot : null,
      filter: async (id: string, reportId: string, filter: LocalReportFilter) => {
        if (id !== record.resultId || reportId !== snapshot.report.reportId) throw new Error('FILTER_NOT_FOUND')
        return filterMissionReport(resultDir, snapshot, filter)
      },
    }
    const server = createMockServer({ port: 0, missionResults: results,
      exportLocalReport: (
        report: Parameters<typeof exportLocalReport>[1], format: Parameters<typeof exportLocalReport>[2], actor: Parameters<typeof exportLocalReport>[3],
        source: Parameters<typeof exportLocalReport>[4], comparisons: Parameters<typeof exportLocalReport>[5], filter: Parameters<typeof exportLocalReport>[6],
      ) => exportLocalReport(join(root, 'exports'), report, format, actor, source, comparisons, filter) })
    try {
      if (!server.httpServer.listening) await once(server.httpServer, 'listening')
      const api = request(server.httpServer), base = `/api/v1/reports/${snapshot.report.reportId}`
      const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
      await api.get(`${base}/filter?resultId=${record.resultId}&nodeId=A&nodeId=B`).set(headers).expect(422)
      await api.get(`${base}/filter?resultId=${record.resultId}&from=NaN`).set(headers).expect(422)
      const filtered = await api.get(`${base}/filter?resultId=${record.resultId}&nodeId=A&from=1&to=3`).set(headers).expect(200)
      expect(filtered.body.data.report.localEvidence).toMatchObject({ positionCount: 2, simulationComplete: false })
      const exported = await api.post(`${base}/export?resultId=${record.resultId}`).set(headers).send({ reportId: snapshot.report.reportId, format: 'HTML', filter: { nodeId: 'A', from: 1, to: 3 } }).expect(200)
      expect(await readFile(exported.body.data.filePath, 'utf8')).toContain('节点=A')
    } finally { if (server.httpServer.listening) await server.close() }
  })
})

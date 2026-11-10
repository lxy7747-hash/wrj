// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import sample from '../fixtures/engine-frame/params_check.json'
import newSample from '../fixtures/engine-frame/websocket-new/fream_chenge2.json'
import { LOCAL_REPORT } from '../fixtures/local-report'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'
const { mkdtemp, rm } = await import('node:' + 'fs/promises')
const { readFile, writeFile } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createEngineFrameArchive } = await import('../../server/local/' + 'engine-frame-archive.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const { once } = await import('node:' + 'events')

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function frame(frameId: number) {
  const parsed = adaptEngineFrameSnapshot({ ...sample, frame_id: frameId, sim_time_s: undefined })
  if (!parsed.data) throw new Error('fixture invalid')
  return { ...parsed.data, runId: 'RUN-ARCHIVE', engineEpoch: 0 }
}

describe('引擎帧可靠归档', () => {
  it('新协议秒值、新增原始指标往返归档不丢失，不伪造缺测 CSV', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-engine-archive-')); roots.push(root)
    const archive = createEngineFrameArchive(root, () => '2026-11-09T00:00:00Z')
    const received = { ...adaptEngineFrameSnapshot(newSample).data!, runId: 'RUN-ARCHIVE' }
    received.links[0]!.linkIds = ['L-1']
    const session = await archive.begin({ taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-09T00:00:00Z' },
      { 'L-1': { type: 'MICROWAVE', sourcePlatformId: received.links[0]!.sourcePlatformId!, targetPlatformId: received.links[0]!.targetPlatformId! } })
    session.append(received); await session.close()
    const summary = (await archive.load('RUN-ARCHIVE', undefined, { start: 375, end: 376 }))!
    expect(summary.segmentRows).toHaveLength(5)
    expect(summary.segmentRows[0]).toMatchObject({ simulationTime: 375, segment: {
      losses: { rainDb: newSample.link_calc.links[0]!.losses.atten_rain_db, totalDb: newSample.link_calc.links[0]!.losses.total_composite_db },
      quality: { delay: newSample.link_calc.links[0]!.quality.delay, rxPowerDbm: null }, inputTrace: { frequencyGHz: 8.2 } } })
    const path = (await archive.getFile('RUN-ARCHIVE', summary.sourceSha256))!
    const restored = JSON.parse((await readFile(path, 'utf8')).trim())
    expect(restored).toEqual(received)
    const csv = await archive.finalizeCsv('RUN-ARCHIVE', { taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-09T00:00:00Z' }, {})
    expect(csv?.files).toEqual([])
    expect(csv?.missing.map((item: { fileName: string }) => item.fileName)).toEqual(expect.arrayContaining(['link_state.csv', 'link_loss.csv', 'link_quality.csv']))
  })
  it('按轮次和帧号去重，结束后发布带来源摘要的可验证真实段记录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-engine-archive-')); roots.push(root)
    const archive = createEngineFrameArchive(root, () => '2026-11-07T00:00:00Z')
    const session = await archive.begin({ taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-07T00:00:00Z' }, { 'L-1': { type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B' } })
    session.append(frame(1)); session.append(frame(1)); session.append(frame(2))
    await Promise.all([session.close(), session.close()])
    const stored = await archive.load('RUN-ARCHIVE')
    expect(stored?.frameCount).toBe(2)
    expect(stored?.segmentRows).toHaveLength(frame(1).links.length * 2)
    expect(stored?.segmentRows[0]).toMatchObject({ engineEpoch: 0, frameId: 1, simulationTime: 1 })
    expect(stored?.missingFieldNames).toContain('snrDb')
    expect(stored?.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
  })
  it('拒绝错误运行归属并把失败暴露给结束路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-engine-archive-')); roots.push(root)
    const archive = createEngineFrameArchive(root, () => '2026-11-07T00:00:00Z')
    const session = await archive.begin({ taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-07T00:00:00Z' }, { 'L-1': { type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B' } })
    session.append({ ...frame(1), runId: 'RUN-OTHER' })
    expect(session.failure()?.message).toContain('作用域')
    await expect(session.close()).rejects.toThrow('作用域')
    expect(await archive.load('RUN-ARCHIVE')).toBeNull()
  })
  it('兼容缺少冻结绑定的历史清单：仍可展示和下载原始归档，但不猜测单段汇总', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-engine-archive-')); roots.push(root)
    const archive = createEngineFrameArchive(root, () => '2026-11-07T00:00:00Z')
    const scope = { taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-07T00:00:00Z' }
    const session = await archive.begin(scope, { 'L-1': { type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B' } })
    session.append(frame(1)); await session.close()
    const pointerPath = join(root, 'RUN-ARCHIVE', 'current.json')
    const legacy = JSON.parse(await readFile(pointerPath, 'utf8')) as Record<string, unknown>
    delete legacy.linkBindings; await writeFile(pointerPath, JSON.stringify(legacy), 'utf8')
    const loaded = await archive.load('RUN-ARCHIVE', scope)
    expect(loaded?.frameCount).toBe(1)
    expect(await archive.getFile('RUN-ARCHIVE', loaded!.sourceSha256)).toMatch(/\.jsonl$/)
    await expect(archive.aggregate('RUN-ARCHIVE', scope, {})).resolves.toMatchObject({ uniqueSingleSegmentCount: 0 })
  })
  it('明细超过上限时保留可下载完整 JSONL，尾段时间筛选在上限前生效', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-engine-archive-')); roots.push(root)
    const firstFrame = frame(1)
    const rowsPerFrame = firstFrame.links.length + firstFrame.routing.switches.length + firstFrame.events.length
    const archive = createEngineFrameArchive(root, () => '2026-11-07T00:00:00Z', { maxReportRows: rowsPerFrame })
    const session = await archive.begin({ taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-07T00:00:00Z' })
    session.append(frame(1)); session.append(frame(2)); await session.close()
    const full = await archive.load('RUN-ARCHIVE')
    expect(full?.detailTruncated).toBe(true)
    expect(full?.retainedDetailRows).toBe(rowsPerFrame)
    const tail = await archive.load('RUN-ARCHIVE', undefined, { start: 2, end: 2 })
    expect(tail?.detailTruncated).toBeUndefined()
    expect(tail?.segmentRows.every((row: { simulationTime: number }) => row.simulationTime === 2)).toBe(true)
    expect(await archive.getFile('RUN-ARCHIVE', full!.sourceSha256)).toMatch(/\.jsonl$/)
  })
  it('只允许报告读取权限按结果编号和来源摘要下载完整引擎 JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-engine-archive-')); roots.push(root)
    const archive = createEngineFrameArchive(root, () => '2026-11-07T00:00:00Z')
    const session = await archive.begin({ taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-07T00:00:00Z' })
    session.append(frame(1)); await session.close()
    const summary = (await archive.load('RUN-ARCHIVE'))!
    const resultId = 'RESULT-11111111-1111-4111-8111-111111111111'
    const server = createMockServer({ port: 0, engineFrameArchive: archive, missionResults: { get: async (id: string) => id === resultId ? { record: { resultId, runId: 'RUN-ARCHIVE' } } : null, list: async () => [] } as any })
    try {
      if (!server.httpServer.listening) await once(server.httpServer, 'listening')
      const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
      await api.get(`/api/v1/mission-results/${resultId}/engine-frames/${summary.sourceSha256}`).set('Origin', 'http://127.0.0.1:5173').expect(403)
      const ok = await api.get(`/api/v1/mission-results/${resultId}/engine-frames/${summary.sourceSha256}`).set({ Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }).expect(200)
      expect(ok.headers['access-control-expose-headers']).toContain('Content-Disposition')
      expect(ok.headers['content-disposition']).toContain(`${summary.sourceSha256}.jsonl`)
      expect(ok.body.toString('utf8')).toContain('ENGINE_FRAME')
      await api.get(`/api/v1/mission-results/${resultId}/engine-frames/${'b'.repeat(64)}`).set({ Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }).expect(404)
    } finally { await server.close() }
  })
  it('按文件独立生成状态和损耗 CSV，质量/切换/事件缺字段明确标记而非用 SNR 阻塞全部', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-engine-archive-')); roots.push(root)
    const archive = createEngineFrameArchive(root, () => '2026-11-07T00:00:00Z')
    const session = await archive.begin({ taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-07T00:00:00Z' }, { 'L-1': { type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B' } })
    const received = frame(1); received.links[0]!.linkIds = ['L-1']; received.links[0]!.sourcePlatformId = 'A'; received.links[0]!.targetPlatformId = 'B'; received.links[0]!.status = 'UP'; received.links[0]!.quality.gxbDb = 2; received.links[0]!.quality.ber = 0.01; received.links[0]!.quality.rxPowerDbm = -80
    received.links[0]!.losses = { freeSpaceDb: 1, seaMultipathDb: 2, atmosphericDb: 3, cloudRainDb: 4, jammingDb: 5, totalDb: 15, rainDb: null, cloudDb: null }
    session.append(received); await session.close()
    const evidence = await archive.finalizeCsv('RUN-ARCHIVE', { taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-07T00:00:00Z' }, { 'L-1': { type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B' } })
    expect(evidence?.files.map((file: { fileName: string }) => file.fileName)).toEqual(expect.arrayContaining(['link_state.csv', 'link_loss.csv']))
    expect(evidence?.missing.map((file: { fileName: string }) => file.fileName)).toEqual(expect.arrayContaining(['link_quality.csv', 'link_switch.csv', 'events.csv']))
    expect(await archive.getCsvFile('RUN-ARCHIVE', evidence!.sourceSha256, 'link_state.csv')).toMatch(/link_state\.csv$/)
    expect(await archive.aggregate('RUN-ARCHIVE', { taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-07T00:00:00Z' }, { 'L-1': { type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B' } })).toMatchObject({ uniqueSingleSegmentCount: 1, averageGxbDb: 2, averageBer: 0.01, missing: ['connectivityDurationS', 'interferenceDurationS'] })
  })
  it('逐帧连续追加时保留 dBW 到 dBm 的明确换算，并将混合有效/缺项帧标为部分覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-engine-archive-')); roots.push(root)
    const archive = createEngineFrameArchive(root, () => '2026-11-07T00:00:00Z')
    const scope = { taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-07T00:00:00Z' }
    const session = await archive.begin(scope, { 'L-1': { type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B' } })
    const valid = frame(1); valid.links[0]!.linkIds = ['L-1']; valid.links[0]!.sourcePlatformId = 'A'; valid.links[0]!.targetPlatformId = 'B'; valid.links[0]!.status = 'UP'
    valid.links[0]!.quality = { ...valid.links[0]!.quality, gxbDb: 2, ber: 0.01, rxPowerDbm: null, rxPowerDbw: -110 }
    valid.links[0]!.losses = { freeSpaceDb: 1, seaMultipathDb: 2, atmosphericDb: 3, cloudRainDb: 4, jammingDb: 5, totalDb: 15 }
    const incomplete = structuredClone(valid); incomplete.frameId = 2; incomplete.simulationTime = 2; incomplete.links[0]!.quality.gxbDb = null
    session.append(valid); session.append(incomplete); await session.close()
    const evidence = await archive.finalizeCsv('RUN-ARCHIVE', scope, {})
    const state = evidence!.files.find((file: { fileName: string }) => file.fileName === 'link_state.csv')!
    expect(state).toMatchObject({ status: 'PARTIAL', rowCount: 1, skippedCount: 1 })
    const path = await archive.getCsvFile('RUN-ARCHIVE', evidence!.sourceSha256, 'link_state.csv')
    expect(await readFile(path!, 'utf8')).toContain(',-80\r\n')
  })
  it('下载前流式校验已发布 CSV 的摘要和行数，截断文件不被当作完整证据', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-engine-archive-')); roots.push(root)
    const archive = createEngineFrameArchive(root, () => '2026-11-07T00:00:00Z')
    const scope = { taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-07T00:00:00Z' }
    const session = await archive.begin(scope, { 'L-1': { type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B' } })
    const received = frame(1); received.links[0]!.linkIds = ['L-1']; received.links[0]!.sourcePlatformId = 'A'; received.links[0]!.targetPlatformId = 'B'; received.links[0]!.status = 'UP'; received.links[0]!.quality = { ...received.links[0]!.quality, gxbDb: 2, ber: 0.01, rxPowerDbm: -80 }; received.links[0]!.losses = { freeSpaceDb: 1, seaMultipathDb: 2, atmosphericDb: 3, cloudRainDb: 4, jammingDb: 5, totalDb: 15 }
    session.append(received); await session.close()
    const evidence = (await archive.finalizeCsv('RUN-ARCHIVE', scope, {}))!
    const path = (await archive.getCsvFile('RUN-ARCHIVE', evidence.sourceSha256, 'link_state.csv'))!
    await writeFile(path, 'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower\r\n', 'utf8')
    expect(await archive.getCsvFile('RUN-ARCHIVE', evidence.sourceSha256, 'link_state.csv')).toBeNull()
  })
  it('多段或链路错误不冒充唯一逻辑链路，并按完整归档的筛选范围计算汇总', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-engine-archive-')); roots.push(root)
    const archive = createEngineFrameArchive(root, () => '2026-11-07T00:00:00Z', { maxReportRows: 1 })
    const scope = { taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-07T00:00:00Z' }
    const session = await archive.begin(scope, { 'L-1': { type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B' } })
    const first = frame(1); first.links[0]!.linkIds = ['L-1']; first.links[0]!.sourcePlatformId = 'A'; first.links[0]!.targetPlatformId = 'B'; first.links[0]!.status = 'UP'; first.links[0]!.quality = { ...first.links[0]!.quality, gxbDb: 1, ber: 0.1, rxPowerDbm: -80 }
    const duplicate = structuredClone(first.links[0]!); duplicate.linkId = 'SEG-OTHER'; first.links.push(duplicate)
    const second = frame(2); second.links[0]!.linkIds = ['L-1']; second.links[0]!.sourcePlatformId = 'A'; second.links[0]!.targetPlatformId = 'B'; second.links[0]!.status = 'UP'; second.links[0]!.quality = { ...second.links[0]!.quality, gxbDb: 3, ber: 0.03, rxPowerDbm: -70 }
    session.append(first); session.append(second); await session.close()
    const evidence = await archive.finalizeCsv('RUN-ARCHIVE', scope, {})
    expect(evidence!.files.find((file: { fileName: string }) => file.fileName === 'link_state.csv')).toMatchObject({ status: 'PARTIAL', rowCount: 1 })
    await expect(archive.aggregate('RUN-ARCHIVE', scope, {}, { start: 1, end: 1, linkId: 'L-1' })).resolves.toMatchObject({ uniqueSingleSegmentCount: 0 })
    await expect(archive.aggregate('RUN-ARCHIVE', scope, {}, { start: 2, end: 2, linkId: 'L-1' })).resolves.toMatchObject({ uniqueSingleSegmentCount: 1, averageGxbDb: 3, averageBer: 0.03 })
  })
  it('结果读取挂接冻结归档的聚合与连续 CSV，并仅向报告读取权限开放 CSV 下载', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-engine-archive-')); roots.push(root)
    const archive = createEngineFrameArchive(root, () => '2026-11-07T00:00:00Z')
    const scope = { taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-07T00:00:00Z' }
    const session = await archive.begin(scope, { 'L-1': { type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B' } })
    const received = frame(1); received.links[0]!.linkIds = ['L-1']; received.links[0]!.sourcePlatformId = 'A'; received.links[0]!.targetPlatformId = 'B'; received.links[0]!.status = 'UP'; received.links[0]!.quality.gxbDb = 2; received.links[0]!.quality.ber = 0.01; received.links[0]!.quality.rxPowerDbm = -80
    received.links[0]!.losses = { freeSpaceDb: 1, seaMultipathDb: 2, atmosphericDb: 3, cloudRainDb: 4, jammingDb: 5, totalDb: 15 }
    session.append(received); await session.close()
    const resultId = 'RESULT-11111111-1111-4111-8111-111111111111'
    const snapshot = { record: { resultId, ...scope, scenarioName: '引擎归档验证', completedAt: '2026-11-07T00:01:00Z' }, report: structuredClone(LOCAL_REPORT) }
    const server = createMockServer({ port: 0, engineFrameArchive: archive, missionResults: { get: async (id: string) => id === resultId ? snapshot : null, list: async () => [] } as any })
    try {
      if (!server.httpServer.listening) await once(server.httpServer, 'listening')
      const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
      const result = await api.get(`/api/v1/mission-results/${resultId}`).set({ Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }).expect(200)
      expect(result.body.data.report.localEvidence.engineFrameArchive.aggregate).toMatchObject({ uniqueSingleSegmentCount: 1, averageGxbDb: 2, averageBer: 0.01 })
      expect(result.body.data.report.localEvidence.engineCsv.files).toEqual(expect.arrayContaining([expect.objectContaining({ fileName: 'link_state.csv', status: 'COMPLETE', skippedCount: 0 })]))
      await api.get(`/api/v1/mission-results/${resultId}/engine-csv/link_state.csv`).set('Origin', 'http://127.0.0.1:5173').expect(403)
      const csv = await api.get(`/api/v1/mission-results/${resultId}/engine-csv/link_state.csv`).set({ Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }).expect(200)
      expect(csv.headers['access-control-expose-headers']).toContain('Content-Disposition')
      expect(csv.headers['content-disposition']).toContain('link_state.csv')
      expect(csv.text).toContain('task_id')
      await api.get(`/api/v1/mission-results/${resultId}/engine-csv/other.csv`).set({ Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }).expect(400)
    } finally { await server.close() }
  })
})

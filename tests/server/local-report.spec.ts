// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_REPORT } from '../fixtures/local-report'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { INITIAL_LOG, POSITION_CSV } from '../fixtures/local-replay'
const { mkdtemp, readFile, writeFile, rm, readdir } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { createHash } = await import('node:' + 'crypto')
const { readLocalReport, exportLocalReport } = await import('../../server/local/' + 'report-file.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const dirs: string[] = []
const servers: Array<ReturnType<typeof createMockServer>> = []
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'wrj-report-test-')); dirs.push(dir); return dir }
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

describe('本地报告读取和真实文件导出', () => {
  it('新事件 CSV 形成真实关联、设备时间线及消息统计', async () => {
    const dir = await directory()
    const events = join(dir, 'scenario_events.csv'), positions = join(dir, 'position.csv')
    await writeFile(events, REPORT_EVENT_CSV)
    await writeFile(positions, POSITION_CSV)
    const report = await readLocalReport(events, positions)
    expect(report?.localEvidence).toMatchObject({ eventCount: 9, simulationComplete: true, endTimeS: 10, positionCount: 3 })
    expect(report?.localEvidence?.connections).toEqual([expect.objectContaining({ time: 5, sourcePlatformId: 'A', targetPlatformId: 'B' })])
    expect(report?.localEvidence?.deviceEvents).toHaveLength(2)
    expect(report?.localEvidence?.eventCounts).toContainEqual({ type: 'MESSAGE_RECEIVED', count: 1 })
  })
  it('实际解析文件、统计、源哈希绑定；未配置不回退 Mock，坏文件拒绝', async () => {
    const dir = await directory()
    const events = join(dir, 'events.csv'), positions = join(dir, 'position.csv')
    await writeFile(events, INITIAL_LOG)
    await writeFile(positions, POSITION_CSV)
    const report = await readLocalReport(events, positions)
    expect(report?.localEvidence).toMatchObject({ positionCount: 3, eventCount: 4, endTimeS: 3, simulationComplete: false })
    expect(report?.localEvidence?.nodes).toHaveLength(2)
    expect(report?.runId).toBeUndefined()
    expect(report?.kpis).toBeUndefined()
    await writeFile(positions, POSITION_CSV + '4,A,-79,32,20,20,175\n')
    expect((await readLocalReport(events, positions))?.reportId).not.toBe(report?.reportId)
    expect(await readLocalReport(undefined, positions)).toBeNull()
    expect(await readLocalReport(events, undefined)).toBeNull()
    await writeFile(events, 'broken')
    await expect(readLocalReport(events, positions)).rejects.toThrow()
  })
  it.each(['HTML', 'CSV'] as const)('%s 真实生成、摘要一致、转义且重复导出不覆盖', async format => {
    const dir = await directory()
    const report = structuredClone(LOCAL_REPORT)
    report.localEvidence.nodes[0]!.name = '<script>alert(1)</script>'
    const first = await exportLocalReport(dir, report, format, '=danger')
    const content = await readFile(first.filePath, 'utf8')
    expect(first.generated).toBe(true)
    expect(first.sha256).toBe(createHash('sha256').update(content).digest('hex'))
    expect(content).toContain(report.reportId)
    expect(content).toContain('0分10秒')
    expect(content).toContain('无数据')
    if (format === 'HTML') { expect(content).not.toContain('<script>'); expect(content).toContain('&lt;script&gt;') }
    const second = await exportLocalReport(dir, report, format, 'operator')
    expect(second.filePath).not.toBe(first.filePath)
    expect(await readFile(first.filePath, 'utf8')).toBe(content)
  })
  it('拒绝非法报告和格式，不创建文件', async () => {
    const dir = await directory()
    await expect(exportLocalReport(dir, { ...LOCAL_REPORT, runId: 'RUN-001' }, 'HTML', 'operator')).rejects.toThrow()
    await expect(exportLocalReport(dir, LOCAL_REPORT, 'PDF' as 'HTML', 'operator')).rejects.toThrow()
    expect(await readdir(dir)).toEqual([])
  })
  it('HTTP 全链路、权限、来源变更和失败均不回退固定报告', async () => {
    const dir = await directory()
    let mode = 'ok'
    const server = createMockServer({ port: 0,
      loadLocalReport: async () => {
        if (mode === 'error') throw new Error('private path')
        if (mode === 'empty') return null
        return mode === 'invalid' ? { ...LOCAL_REPORT, runId: 'RUN-001' } : LOCAL_REPORT
      },
      exportLocalReport: (report: typeof LOCAL_REPORT, format: 'HTML' | 'CSV', actor: string) => exportLocalReport(dir, report, format, actor),
    })
    servers.push(server)
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    const path = `/api/v1/reports/${LOCAL_REPORT.reportId}`
    expect((await api.get('/api/v1/reports').set(headers)).body.data).toEqual([LOCAL_REPORT])
    expect((await api.get(path).set(headers)).body.data).toEqual(LOCAL_REPORT)
    const exported = await api.post(`${path}/export`).set(headers).send({ reportId: LOCAL_REPORT.reportId, format: 'CSV' })
    expect(exported.status).toBe(200)
    expect(await readFile(exported.body.data.filePath, 'utf8')).toContain('无人机甲')
    expect((await api.post(`${path}/export`).set(headers).send({ reportId: LOCAL_REPORT.reportId, format: 'PDF' })).status).toBe(422)
    expect((await api.get(path).set({ ...headers, 'X-Demo-Role': 'INVALID' })).status).toBe(403)
    for (const next of ['empty', 'error', 'invalid']) {
      mode = next
      const list = await api.get('/api/v1/reports').set(headers)
      expect(list.status).toBe(next === 'empty' ? 200 : 503)
      if (next === 'empty') expect(list.body.data).toEqual([])
      expect((await api.get(path).set(headers)).status).toBe(next === 'empty' ? 409 : 503)
      expect((await api.post(`${path}/export`).set(headers).send({ reportId: LOCAL_REPORT.reportId, format: 'HTML' })).status).toBe(next === 'empty' ? 409 : 503)
    }
  })
})

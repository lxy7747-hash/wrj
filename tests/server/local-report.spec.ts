// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_REPORT, LOCAL_QUALITY_REPORT } from '../fixtures/local-report'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { INITIAL_LOG, POSITION_CSV } from '../fixtures/local-replay'
const { appendFile, mkdtemp, readFile, writeFile, rm, readdir, stat } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { createHash } = await import('node:' + 'crypto')
const { existsSync } = await import('node:' + 'fs')
const { env } = await import('node:' + 'process')
const { readLocalReport, exportLocalReport } = await import('../../server/local/' + 'report-file.js')
const { readAfsimLogFile } = await import('../../server/local/' + 'afsim-log-reader.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const { default: PDFDocument } = await import('pdf' + 'kit')
const dirs: string[] = []
const servers: Array<ReturnType<typeof createMockServer>> = []
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
const pdfFont = [env.WRJ_PDF_FONT_PATH, 'C:\\Windows\\Fonts\\Deng.ttf', 'C:\\Windows\\Fonts\\simhei.ttf'].find(path => !!path && existsSync(path) && !/\.ttc$/i.test(path))
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
  it('流式读取超过 32 MiB 的位置 CSV，完整保留轨迹计数、来源摘要并可导出报告', async () => {
    const dir = await directory()
    const events = join(dir, 'scenario_events.csv'), positions = join(dir, 'position.csv')
    await writeFile(events, REPORT_EVENT_CSV)
    await writeFile(positions, 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n')
    const rows = 360_000
    const batchSize = 5_000
    for (let start = 1; start <= rows; start += batchSize) {
      const end = Math.min(rows, start + batchSize - 1)
      const batch = Array.from({ length: end - start + 1 }, (_, offset) => {
        const time = start + offset
        return `${time},A,-79.1234567890123,32.1234567890123,20.1234567890123,20.1234567890123,175.1234567890123\n`
      }).join('')
      await appendFile(positions, batch)
    }
    expect((await stat(positions)).size).toBeGreaterThan(32 * 1024 * 1024)
    const report = await readLocalReport(events, positions)
    expect(report?.localEvidence).toMatchObject({ positionCount: rows, positionIssueCount: 0, eventCount: 9, simulationComplete: true })
    const exported = await exportLocalReport(join(dir, 'exports'), report!, 'HTML', 'operator')
    expect(await readFile(exported.filePath, 'utf8')).toContain(String(rows))
  }, 30_000)
  it('流式汇总超过 32 MiB 的消息事件 CSV，保留全量分类计数并显式标记未装入逐消息回放', async () => {
    const dir = await directory()
    const events = join(dir, 'scenario_events.csv'), positions = join(dir, 'position.csv')
    const lines = REPORT_EVENT_CSV.split('\n')
    const message = lines.find(line => line.includes(',MESSAGE_RECEIVED,'))!
    const completion = lines.find(line => line.includes(',SIMULATION_COMPLETE,'))!
    await writeFile(events, lines.filter(line => !line.includes(',MESSAGE_RECEIVED,') && !line.includes(',SIMULATION_COMPLETE,')).join('\n') + '\n')
    const rows = 360_000, batchSize = 5_000
    for (let start = 0; start < rows; start += batchSize) {
      await appendFile(events, Array.from({ length: Math.min(batchSize, rows - start) }, () => message).join('\n') + '\n')
    }
    await appendFile(events, completion + '\n')
    await writeFile(positions, POSITION_CSV)
    expect((await stat(events)).size).toBeGreaterThan(32 * 1024 * 1024)
    const names = new Map([['A', 'CMD-01'], ['B', 'AIR-01']])
    const report = await readLocalReport(events, positions, names)
    expect(report?.localEvidence).toMatchObject({
      eventCount: rows + 8, messageDetailsComplete: false, messageDetailEventCount: rows,
    })
    expect(report?.localEvidence?.eventCounts).toContainEqual({ type: 'MESSAGE_RECEIVED', count: rows })
    expect(report?.localEvidence?.nodes.map((node: { platformId: string }) => node.platformId).sort()).toEqual(['AIR-01', 'CMD-01'])
    expect(report?.localEvidence?.connections[0]).toMatchObject({ sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01' })
    const parsed = await readAfsimLogFile(events, names)
    expect(parsed.events.find((event: { type: string; sourceLine: number }) => event.type === 'SIMULATION_COMPLETE')?.sourceLine).toBe(rows + 15)
    const exported = await exportLocalReport(join(dir, 'exports'), report!, 'CSV', 'operator')
    expect(await readFile(exported.filePath, 'utf8')).toContain(String(rows))
  }, 30_000)
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
    if (format === 'HTML') {
      expect(content).not.toContain('<script>'); expect(content).toContain('&lt;script&gt;')
      expect(content.match(/<svg /g)).toHaveLength(2)
      expect(content).toContain('事件分类统计柱状图')
      expect(content).toContain('节点位置记录数柱状图')
      expect(content).toContain('单位：条；生成时刻：')
    }
    const second = await exportLocalReport(dir, report, format, 'operator')
    expect(second.filePath).not.toBe(first.filePath)
    expect(await readFile(first.filePath, 'utf8')).toBe(content)
  })
  for (const format of ['HTML', 'PDF'] as const) it.skipIf(format === 'PDF' && !pdfFont)(`${format} 导出包含柱状图、雷达图数据表及真实单位、来源和生成时刻`, async () => {
    const dir = await directory()
    const textCalls = vi.spyOn(PDFDocument.prototype, 'text')
    const result = await exportLocalReport(dir, LOCAL_QUALITY_REPORT, format, 'operator', undefined, [], { nodeId: 'A', from: 0, to: 10 })
    const content = format === 'HTML' ? await readFile(result.filePath, 'utf8') : textCalls.mock.calls.map(call => String(call[0])).join('\n')
    for (const text of ['柱状图数据表：事件分类统计', '雷达图数据表：各链路有效观测区间连通率', '标签', '数值', '单位', '数据范围', '生成时刻',
      'quality.csv · 筛选范围 · 0分0秒～0分10秒 · 节点 A', 'scenario_events.csv · 筛选范围', LOCAL_REPORT.generatedTime, '单位：%', '单位：条']) expect(content).toContain(text)
    for (const [link, rate] of [['L-1', '100'], ['L-2', '0'], ['L-3', '100']]) {
      expect(content).toContain(format === 'HTML' ? `<td>${link}</td><td>${rate}</td><td>%</td>` : `标签：${link}； 数值：${rate}； 单位：%`)
    }
    if (format === 'PDF') {
      expect((await readFile(result.filePath)).subarray(0, 5).toString()).toBe('%PDF-')
      expect(content).toContain('雷达图范围 0–100%')
      expect(content).not.toContain('L-1：100 条')
    } else {
      expect(content).toContain('<polygon')
      const empty = await exportLocalReport(dir, LOCAL_REPORT, format, 'operator')
      const emptyHtml = await readFile(empty.filePath, 'utf8')
      expect(emptyHtml).toContain('雷达图数据表：各链路有效观测区间连通率')
      expect(emptyHtml).toContain('<td>暂无数据</td><td></td><td>%</td>')
    }
  })
  it.skipIf(!pdfFont)('PDF 真实生成、嵌入中文字体、包含页面和统计来源', async () => {
    const dir = await directory()
    const exported = await exportLocalReport(dir, LOCAL_REPORT, 'PDF', 'operator')
    const bytes = await readFile(exported.filePath)
    const text = bytes.toString('latin1')
    expect(bytes.subarray(0, 8).toString('ascii')).toMatch(/^%PDF-\d\.\d$/); expect(bytes.length).toBeGreaterThan(10_000)
    expect(text).toContain('/Type /Page'); expect(text).toContain('/ToUnicode'); expect(text).toMatch(/\/FontFile[23]/)
    expect(exported.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    // 图表和各统计表由同一个 localEvidence 衍生；没有质量字段时仍只写“暂无数据”。
    expect(text).toContain('/Title')
    const empty = structuredClone(LOCAL_REPORT)
    empty.localEvidence.eventCount = 0; empty.localEvidence.eventCounts = []; empty.localEvidence.connections = []; empty.localEvidence.deviceEvents = []
    const emptyExport = await exportLocalReport(dir, empty, 'PDF', 'operator', undefined, [], {})
    expect((await readFile(emptyExport.filePath)).subarray(0, 5).toString()).toBe('%PDF-')
  })
  it('PDF 字体未配置或路径无效时明确失败，不产生伪造文件', async () => {
    const dir = await directory(), original = env.WRJ_PDF_FONT_PATH
    env.WRJ_PDF_FONT_PATH = join(dir, 'missing-cjk-font.ttf')
    await expect(exportLocalReport(dir, LOCAL_REPORT, 'PDF', 'operator')).rejects.toThrow('中文字体文件不存在')
    if (original === undefined) delete env.WRJ_PDF_FONT_PATH
    else env.WRJ_PDF_FONT_PATH = original
    expect(await readdir(dir)).toEqual([])
  })
  it('拒绝非法报告和格式，不创建文件', async () => {
    const dir = await directory()
    await expect(exportLocalReport(dir, { ...LOCAL_REPORT, runId: 'RUN-001' }, 'HTML', 'operator')).rejects.toThrow()
    await expect(exportLocalReport(dir, LOCAL_REPORT, 'ZIP' as 'HTML', 'operator')).rejects.toThrow()
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
      exportLocalReport: (report: typeof LOCAL_REPORT, format: 'HTML' | 'PDF' | 'CSV', actor: string) => exportLocalReport(dir, report, format, actor),
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
    const pdf = await api.post(`${path}/export`).set(headers).send({ reportId: LOCAL_REPORT.reportId, format: 'PDF' })
    if (pdfFont) {
      expect(pdf.status).toBe(200); expect(pdf.body.data).toMatchObject({ format: 'PDF', generated: true })
      const downloaded = await api.post(`${path}/export?download=1`).set(headers).send({ reportId: LOCAL_REPORT.reportId, format: 'PDF' })
      expect(downloaded.status).toBe(200); expect(downloaded.headers['content-type']).toContain('application/pdf')
      expect(downloaded.body.subarray(0, 8).toString('ascii')).toMatch(/^%PDF-\d\.\d$/)
    } else expect(pdf.status).toBe(503)
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

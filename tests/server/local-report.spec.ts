// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_REPORT, LOCAL_QUALITY_REPORT } from '../fixtures/local-report'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { INITIAL_LOG, POSITION_CSV } from '../fixtures/local-replay'
import { STEP_FIVE_REPORT } from '../fixtures/engine-frame/step-five-report'
import { LATEST_FRAME_REPORT } from '../fixtures/engine-frame/latest-report'
const { appendFile, mkdtemp, readFile, writeFile, rm, readdir, stat } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { createHash } = await import('node:' + 'crypto')
const { existsSync } = await import('node:' + 'fs')
const { env } = await import('node:' + 'process')
const { readLocalReport, exportLocalReport } = await import('../../server/local/' + 'report-file.js')
const { reportRadarSvg } = await import('../../server/local/' + 'report-file.js')
const { writeLocalReportPdf } = await import('../../server/local/' + 'pdf-report.js')
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

it.each([0, 1, 2, 3])('HTML/PDF 雷达 %i 条链路空态与页面一致', async count => {
  const rows = [{ label: 'L-1', value: 100 }, { label: 'L-2', value: 0 }, { label: 'L-3', value: 50 }].slice(0, count)
  const html = reportRadarSvg({ title: '连通率', rows }, '当前范围')
  expect(html.includes('暂无数据')).toBe(count === 0)
  expect(html.includes('<polygon')).toBe(count >= 3)
  if (count > 0 && count < 3) for (const row of rows) expect(html).toContain(`${row.label}：${row.value} %`)
  if (!pdfFont) return
  const text = vi.spyOn(PDFDocument.prototype, 'text')
  try {
    const path = join(await directory(), 'radar.pdf')
    const sha256 = await writeLocalReportPdf(path, { title: '连通率', notes: [], chartScope: '当前范围', charts: [{ title: '连通率', kind: 'RADAR', unit: '%', rows }], sections: [] })
    const pdf = await readFile(path)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(sha256).toBe(createHash('sha256').update(pdf).digest('hex'))
    const rendered = text.mock.calls.map(call => String(call[0])).join('\n')
    expect(rendered.includes('暂无数据')).toBe(count === 0)
    if (count > 0 && count < 3) for (const row of rows) expect(rendered).toContain(`${row.label}：${row.value} %`)
  } finally { text.mockRestore() }
})

it.skipIf(!pdfFont)('大表格分批写出完整 PDF，已有目标文件不被覆盖', async () => {
  const path = join(await directory(), 'full-report.pdf')
  const rows = Array.from({ length: 520 }, (_, index) => [String(index), `明细记录 ${index}`])
  const input = { title: '详细报表', notes: [], chartScope: '', charts: [], sections: [{ title: '明细', columns: ['编号', '记录'], rows }] }
  const text = vi.spyOn(PDFDocument.prototype, 'text')
  try {
    const sha256 = await writeLocalReportPdf(path, input)
    const pdf = await readFile(path)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true)
    expect(sha256).toBe(createHash('sha256').update(pdf).digest('hex'))
    expect(text.mock.calls.filter(([line]) => typeof line === 'string' && line.startsWith('编号：'))).toHaveLength(rows.length)
    expect(text).toHaveBeenCalledWith('编号：519； 记录：明细记录 519', { lineGap: 2 })
    await expect(writeLocalReportPdf(path, input)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(path)).toEqual(pdf)
  } finally { text.mockRestore() }
})

it('统计 CSV 保留最新报文的分项损耗、通信参数、干扰源及待确认标记', async () => {
  const result = await exportLocalReport(await directory(), LATEST_FRAME_REPORT, 'CSV', 'operator')
  const text = await readFile(result.filePath, 'utf8')
  for (const value of ['自由空间', '雨衰', '云衰', '44.092173718306995', '频率（GHz）', '数据率（Mbit/s）', 'G/T（dB/K）', '0.3433178367922316', 'jammer_station_01', '144.5182955065433', '单位待确认', '总复合损耗（dB）', '错误信息', '1.189035332459013e-243']) expect(text).toContain(value)
  expect(text).toContain('"GXB（dB）","BER","接收功率（dBm）"')
})

it('HTML 折线保留极小 BER 值之间的差异', async () => {
  const { reportCurveSvg } = await import('../../server/local/' + 'report-file.js')
  const svg = reportCurveSvg({ title: '极小 BER', unit: 'BER', rows: [{ label: '3775', value: 1.189035332459013e-243 }, { label: '3780', value: 8.484338827878784e-244 }] }, '实际报文')
  const y = [...svg.matchAll(/<circle[^>]* cy="([^"]+)"/g)].map(match => match[1])
  expect(new Set(y).size).toBe(2)
})

describe('本地报告读取和真实文件导出', () => {
  it('HTML引擎曲线与页面一致：5秒步长连续，缺帧处保留断点', async () => {
    const dir = await directory()
    const result = await exportLocalReport(dir, STEP_FIVE_REPORT, 'HTML', 'operator')
    const html = await readFile(result.filePath, 'utf8')
    for (const title of ['干信比随时间变化</h2>', '误码率随时间变化</h2>']) {
      const start = html.indexOf(`<h2>${title}`)
      expect(start).toBeGreaterThanOrEqual(0)
      const chart = html.slice(start, html.indexOf('<h2>', start + 1))
      const pointCounts = [...chart.matchAll(/<polyline points="([^"]+)"/g)].map(match => match[1]!.trim().split(/\s+/).length)
      expect(pointCounts).toEqual([3, 1])
    }
    expect(html).not.toContain('引擎段误码率随时间变化')
    expect(html).toContain('横轴：0～30 秒')
    expect(html).toContain('<title>0分5秒: 0 dB</title>')
    expect(html).toContain('<title>0分25秒: 0 dB</title>')
  })

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
    report.localEvidence.eventFile.fileName = '<script>alert(1)</script>'
    const first = await exportLocalReport(dir, report, format, '=danger')
    const content = await readFile(first.filePath, 'utf8')
    expect(first.generated).toBe(true)
    expect(first.sha256).toBe(createHash('sha256').update(content).digest('hex'))
    expect(content).toContain(report.reportId)
    expect(content).toContain('0分10秒')
    expect(content).toContain('无数据')
    if (format === 'HTML') {
      expect(content).not.toContain('<script>'); expect(content).toContain('&lt;script&gt;')
      expect(content).toContain('<h2>五项评估指标</h2>')
      expect(content).toContain('<td>平均干信比</td><td>暂无数据</td>')
      expect(content).not.toContain('<svg ')
      expect(content).not.toContain('节点与位置')
    }
    const second = await exportLocalReport(dir, report, format, 'operator')
    expect(second.filePath).not.toBe(first.filePath)
    expect(await readFile(first.filePath, 'utf8')).toBe(content)
  })
  for (const format of ['HTML', 'CSV', 'PDF'] as const) it.skipIf(format === 'PDF' && !pdfFont)(`${format} 真实零值与缺失数据区分，文件状态仅在 CSV 明细中展示`, async () => {
    const dir = await directory()
    const report = structuredClone(LATEST_FRAME_REPORT)
    const segment = report.localEvidence.engineFrameArchive!.segmentRows[0]!.segment
    Object.assign(segment.quality, { gxbDb: 0, ber: 0, rxPowerDbm: null, rxPowerDbw: null })
    report.localEvidence.engineFrameArchive!.aggregate = { uniqueSingleSegmentCount: 1, switchCount: 0, averageGxbDb: 0, averageBer: 0, missing: [] }
    report.localEvidence.engineCsv = { sourceSha256: 'a'.repeat(64), files: [{ fileName: 'link_state.csv', rowCount: 3, sha256: 'b'.repeat(64), status: 'PARTIAL', skippedCount: 2, reason: '存在多段。' }], missing: [{ fileName: 'link_quality.csv', status: 'SOURCE_MISSING', reason: '缺少 SNR。' }] } as never
    const before = structuredClone(report)
    const textCalls = format === 'PDF' ? vi.spyOn(PDFDocument.prototype, 'text') : undefined
    try {
      const exported = await exportLocalReport(dir, report, format, 'operator')
      const content = format === 'PDF' ? textCalls!.mock.calls.map(call => String(call[0])).join('\n') : await readFile(exported.filePath, 'utf8')
      expect(content).toContain('暂无数据')
      expect(content).not.toContain('SOURCE_MISSING')
      expect(content).not.toContain('undefined')
      if (format === 'CSV') {
        for (const value of ['引擎规范 CSV 生成状态', 'PARTIAL', '缺少 SNR。', '"0","0","暂无数据","暂无数据"']) expect(content).toContain(value)
        expect(content).toContain('"link_quality.csv","暂无数据","暂无数据","暂无数据","缺少 SNR。"')
      } else {
        for (const value of ['0.00 dB', '0.00e+0']) expect(content).toContain(value)
        for (const table of ['引擎规范 CSV 生成状态', '引擎链路段实测', '接收功率（dBm）']) expect(content).not.toContain(table)
      }
      if (format === 'PDF') {
        expect((await readFile(exported.filePath)).subarray(0, 5).toString()).toBe('%PDF-')
      }
      expect(report).toEqual(before)
    } finally { textCalls?.mockRestore() }
  })
  for (const format of ['HTML', 'PDF'] as const) it.skipIf(format === 'PDF' && !pdfFont)(`${format} 简版保留汇总、有效趋势和雷达图，省去重复表图及逐帧明细`, async () => {
    const dir = await directory()
    const textCalls = vi.spyOn(PDFDocument.prototype, 'text')
    try {
      const report = structuredClone(LOCAL_QUALITY_REPORT)
      const evidence = report.localEvidence!
      evidence.deviceEvents.push({ eventId: 'JAM-END', type: 'JAMMING_REQUEST_CANCELED', time: 5, platformId: 'A', deviceId: 'J-1' })
      evidence.eventCounts.push({ type: 'JAMMING_REQUEST_CANCELED', count: 1 })
      evidence.eventCount++
      const result = await exportLocalReport(dir, report, format, 'operator', undefined, [], { nodeId: 'A', from: 0, to: 10 })
      const content = format === 'HTML' ? await readFile(result.filePath, 'utf8') : textCalls.mock.calls.map(call => String(call[0])).join('\n')
      for (const text of ['运行与筛选', '五项评估指标', '节点=A', '时间=0～10 秒', 'quality.csv', LOCAL_QUALITY_REPORT.localEvidence!.quality!.source.sha256,
        '10.00 dB', '3.33e-2', '连通时长随时间变化', '干信比随时间变化', '误码率随时间变化', '评估指标得分', '关键事件',
        '0分5秒', '干扰请求取消', '无人机甲', 'J-1 · 已记录请求']) expect(content).toContain(text)
      for (const text of ['柱状图数据表', '各链路有效观测区间连通率', '链路质量测量', '引擎链路段实测']) expect(content).not.toContain(text)
      expect(content.indexOf('五项评估指标')).toBeLessThan(content.indexOf('干信比随时间变化'))
      if (format === 'PDF') {
        expect((await readFile(result.filePath)).subarray(0, 5).toString()).toBe('%PDF-')
        expect(content).toContain('评估指标归一化得分范围 0–100')
        expect(content).not.toContain('0分1秒：10 dB')
      } else {
        expect(content).toContain('<polygon')
        expect(content).toContain('<title>0分1秒: 10 dB</title>')
      }
    } finally { textCalls.mockRestore() }
  })
  it('大型引擎归档明确略过不完整的逐帧趋势，保留完整筛选范围的累计趋势', async () => {
    const report = structuredClone(LATEST_FRAME_REPORT)
    const archive = report.localEvidence.engineFrameArchive!
    archive.detailTruncated = true
    archive.retainedDetailRows = archive.segmentRows.length
    archive.aggregate = { uniqueSingleSegmentCount: 6, switchCount: 1, missing: [], averageGxbDb: 42,
      switchCountTrend: [{ time: 3775, value: 0 }, { time: 3780, value: 1 }] }
    const exported = await exportLocalReport(await directory(), report, 'HTML', 'operator')
    const html = await readFile(exported.filePath, 'utf8')
    expect(html).toContain('连通时长、干信比、误码率的逐帧折线未导出')
    expect(html).not.toContain('引擎链路段实测')
    expect(html).toContain('aria-label="切换次数随时间变化折线图"')
    expect(html).toContain('<title>63分0秒: 1 次</title>')
    expect(html).toContain('42.00 dB')
    expect(html).not.toContain('aria-label="干信比随时间变化折线图"')
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

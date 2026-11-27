import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { setImmediate } from 'node:timers/promises'
import PDFDocument from 'pdfkit'
import { downsampleCurveRows, EXPORT_CURVE_MAX_POINTS, selectCurveMarkerIndices } from './report-curve-downsample.js'

interface ReportTable { title: string; columns: string[]; rows: string[][] }
const PDF_ROWS_PER_BATCH = 128
let cachedFont: { path: string; size: number; mtimeMs: number; buffer: Buffer } | null = null

function readCachedFont(path: string): Buffer {
  const info = statSync(path)
  if (cachedFont && cachedFont.path === path && cachedFont.size === info.size && cachedFont.mtimeMs === info.mtimeMs) {
    return cachedFont.buffer
  }
  const buffer = readFileSync(path)
  cachedFont = { path, size: info.size, mtimeMs: info.mtimeMs, buffer }
  return buffer
}

const configuredFont = () => process.env.WRJ_PDF_FONT_PATH?.trim()
const defaultWindowsFont = () => process.platform === 'win32'
  ? ['C:\\Windows\\Fonts\\Deng.ttf', 'C:\\Windows\\Fonts\\simhei.ttf'].find(existsSync)
  : undefined

/**
 * The font is intentionally a deployment setting: Windows system fonts are not
 * redistributed, and the generated file embeds the configured font so recipients
 * do not need that font installed to read Chinese text.
 */
function chineseFontPath(): string {
  const path = configuredFont() || defaultWindowsFont()
  if (!path) throw new Error('PDF 导出未配置中文字体；请在 .env.server 设置 WRJ_PDF_FONT_PATH（TTF 或 OTF）。')
  if (!existsSync(path)) throw new Error('PDF 导出配置的中文字体文件不存在；请检查 WRJ_PDF_FONT_PATH。')
  // PDFKit 0.20/Fontkit 可嵌入 TTF/OTF；直接注册 TTC 会得到 collection
  // 而不是可子集化 font，必须让部署显式提供一个可嵌入的单字体文件。
  if (/\.ttc$/i.test(path)) throw new Error('PDF 导出不支持直接注册 TTC 字体集合；请配置可嵌入的中文 TTF 或 OTF。')
  return path
}

async function writeTable(document: PDFKit.PDFDocument, table: ReportTable, drain: () => Promise<void>): Promise<void> {
  const left = () => { document.x = document.page.margins.left }
  left(); document.moveDown(0.7); left(); document.fontSize(14).text(`统计表：${table.title}`)
  left(); document.moveDown(0.2); left(); document.fontSize(9).fillColor('#23445d').text(table.columns.join(' | '))
  document.fillColor('#17212b')
  for (const [index, row] of table.rows.entries()) {
    const record = row.map((value, index) => `${table.columns[index] ?? `列${index + 1}`}：${value}`).join('； ')
    left(); document.fontSize(9).text(record, { lineGap: 2 })
    if ((index + 1) % PDF_ROWS_PER_BATCH === 0) await drain()
  }
}

export interface ReportFileChart {
  title: string
  rows: Array<{ label: string; value: number; time?: number; breakBefore?: boolean; displayValue?: string }>
  kind?: 'BAR' | 'LINE' | 'RADAR'
  unit?: string
  scope?: string
  normalizedScore?: boolean
  timeRange?: readonly [number, number]
  stepEnd?: boolean
  showPointList?: boolean
}

export interface LocalReportPdfInput {
  title: string
  notes: string[]
  summary?: ReportTable[]
  sections: ReportTable[]
  charts: ReportFileChart[]
  chartScope: string
}

/** 以嵌入字体输出实际 PDF；没有真实质量证据的说明由调用方原样写入，不生成推测曲线。 */
export async function writeLocalReportPdf(filePath: string, input: LocalReportPdfInput): Promise<string> {
  const fontBuffer = readCachedFont(chineseFontPath())
  // 明细包含大量不同的文本，关闭排版缓存与页缓冲避免内存随页数线性增长。
  const document = new PDFDocument({
    size: 'A4',
    margin: 42,
    compress: true,
    bufferPages: false,
    fontLayoutCache: false,
    info: { Title: input.title, Author: 'WRJ' },
  })
  const output = createWriteStream(filePath, { flags: 'wx' })
  const checksum = createHash('sha256')
  const failure = new AbortController()
  const written = pipeline(document, output)
  document.on('data', (chunk: Buffer) => checksum.update(chunk))
  void written.catch(error => failure.abort(error))
  const drain = async () => {
    // PDFKit 的排版会同步生成页内容，定期让出执行权并等待写盘背压。
    await setImmediate()
    failure.signal.throwIfAborted()
    if (output.writableNeedDrain) await once(output, 'drain', { signal: failure.signal })
  }
  try {
    // 复用缓存的单字体 Buffer，并嵌入子集供接收方离线阅读。
    document.registerFont('wrj-cjk', fontBuffer)
    document.font('wrj-cjk').fillColor('#17212b').fontSize(20).text(input.title)
    document.moveDown(0.6)
    for (const note of input.notes) document.fontSize(10).text(`说明：${note}`, { lineGap: 3 })
    for (const section of input.summary ?? []) {
      await drain()
      await writeTable(document, section, drain)
    }
    for (const chart of input.charts) {
      await drain()
      document.x = document.page.margins.left
      document.moveDown(0.6).fontSize(14).text(`统计图表：${chart.title}`)
      document.fontSize(9).text(chart.scope ?? input.chartScope)
      if (!chart.rows.length) { document.fontSize(10).text('暂无数据'); continue }
      if (chart.kind === 'RADAR' && chart.rows.length < 3) {
        document.fontSize(10).text(chart.normalizedScore ? '有效指标不足三项，列出各项得分。' : '有效链路不足三条，按数值展示连通率。')
        for (const row of chart.rows) document.text(`${row.label}：${row.value} ${chart.unit ?? '%'}`)
        continue
      }
      if (chart.kind === 'LINE') {
        let minimum = Infinity, maximum = -Infinity, minTime = Infinity, maxTime = -Infinity
        for (let i = 0; i < chart.rows.length; i += 1) {
          const row = chart.rows[i]!
          if (row.value < minimum) minimum = row.value
          if (row.value > maximum) maximum = row.value
          const t = row.time ?? i
          if (t < minTime) minTime = t
          if (t > maxTime) maxTime = t
        }
        const span = (maximum - minimum) || 1
        const [startTime, endTime] = chart.timeRange ?? [minTime, maxTime]
        const timeSpan = Math.max(1e-12, endTime - startTime)
        const plotted = downsampleCurveRows(chart.rows, EXPORT_CURVE_MAX_POINTS)
        if (document.y + 190 > document.page.height - document.page.margins.bottom) document.addPage()
        const startX = document.page.margins.left, startY = document.y + 20
        document.fontSize(9).text(`横轴：${startTime}～${endTime} 秒；纵轴：${minimum}～${maximum} ${chart.unit ?? ''}`)
        document.moveTo(startX, startY).lineTo(startX, startY + 130).lineTo(startX + 400, startY + 130).stroke('#17212b')
        const xy = (row: { value: number; time?: number }, index: number): [number, number] => [
          startTime === endTime ? startX + 200 : startX + ((row.time ?? index) - startTime) / timeSpan * 400,
          startY + 130 - (row.value - minimum) / span * 120,
        ]
        let previousY = startY
        for (let index = 0; index < plotted.length; index += 1) {
          const row = plotted[index]!
          const [x, y] = xy(row, index)
          if (index === 0 || row.breakBefore) document.moveTo(x, y)
          else {
            if (chart.stepEnd) document.lineTo(x, previousY)
            document.lineTo(x, y)
          }
          previousY = y
        }
        document.stroke('#2f6b8f')
        // 点标记：小图全量标注；大图仅保留 <= 60 个均匀/极值关键点，防止 PDF 矢量指令膨胀。
        const markerIndices = selectCurveMarkerIndices(plotted)
        for (const index of markerIndices) {
          const [x, y] = xy(plotted[index]!, index)
          document.circle(x, y, 1.5).fill('#2f6b8f')
        }
        document.fillColor('#17212b'); document.y = startY + 145; document.x = startX
        if (chart.showPointList === false) continue
        if (chart.rows.length <= 50) { for (const row of chart.rows) document.fontSize(9).text(`${row.label}：${row.value} ${chart.unit ?? ''}`) }
        else {
          // 有界预览：仅打印首尾各 20 点，精确数据以下载原文为准（不改渲染架构）。
          const head = chart.rows.slice(0, 20), tail = chart.rows.slice(-20)
          for (const row of head) document.fontSize(9).text(`${row.label}：${row.value} ${chart.unit ?? ''}`)
          document.fontSize(9).text(`……（共 ${chart.rows.length} 点，仅预览首尾各 20 点；精确数据见原始来源下载）`)
          for (const row of tail) document.fontSize(9).text(`${row.label}：${row.value} ${chart.unit ?? ''}`)
        }
      } else if (chart.kind === 'RADAR') {
        document.fontSize(9).text(chart.normalizedScore ? '评估指标归一化得分范围 0–100。' : '雷达图范围 0–100%；仅统计连续有效观测区间，缺口和末帧不计。')
        if (document.y + 180 > document.page.height - document.page.margins.bottom) document.addPage()
        const centerX = document.page.margins.left + 90, centerY = document.y + 80
        const point = (index: number, ratio: number): [number, number] => {
          const angle = index * Math.PI * 2 / chart.rows.length - Math.PI / 2
          return [centerX + 70 * ratio * Math.cos(angle), centerY + 70 * ratio * Math.sin(angle)]
        }
        document.circle(centerX, centerY, 70).stroke('#8795a1')
        chart.rows.forEach((_, index) => { document.moveTo(centerX, centerY).lineTo(...point(index, 1)).stroke('#8795a1') })
        document.polygon(...chart.rows.map((row, index) => point(index, row.value / 100))).stroke('#2f6b8f')
        document.y = centerY + 85; document.x = document.page.margins.left
        for (const row of chart.rows) document.fontSize(9).text(`${row.label}：${row.value} ${chart.unit ?? '%'}`)
      } else {
        const maximum = chart.rows.reduce((largest, row) => Math.max(largest, Math.abs(row.value)), 1)
        const signed = chart.rows.some(row => row.value < 0)
        for (const [index, row] of chart.rows.entries()) {
          if (document.y + 44 > document.page.height - document.page.margins.bottom) document.addPage()
          document.x = document.page.margins.left
          document.fontSize(10).text(`${row.label}：${row.displayValue ?? `${row.value} ${chart.unit ?? '条'}`}`)
          const startX = document.page.margins.left, startY = document.y + 3, width = Math.abs(row.value) / maximum * (signed ? 190 : 380)
          const baseline = startX + (signed ? 190 : 0)
          document.rect(row.value < 0 ? baseline - width : baseline, startY, width, 8).fill('#2f6b8f').fillColor('#17212b')
          document.y = startY + 14; document.x = startX
          if ((index + 1) % PDF_ROWS_PER_BATCH === 0) await drain()
        }
      }
    }
    for (const section of input.sections) {
      await drain()
      await writeTable(document, section, drain)
    }
    document.end()
    await written
    return checksum.digest('hex')
  } catch (error) {
    document.destroy(error instanceof Error ? error : new Error('PDF 生成失败。'))
    await written.catch(() => {})
    throw failure.signal.aborted ? failure.signal.reason : error
  }
}

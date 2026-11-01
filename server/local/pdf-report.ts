import { existsSync } from 'node:fs'
import PDFDocument from 'pdfkit'

interface ReportTable { title: string; columns: string[]; rows: string[][] }

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

function writeTable(document: PDFKit.PDFDocument, table: ReportTable): void {
  const left = () => { document.x = document.page.margins.left }
  left(); document.moveDown(0.7); left(); document.fontSize(14).text(`统计表：${table.title}`)
  left(); document.moveDown(0.2); left(); document.fontSize(9).fillColor('#23445d').text(table.columns.join(' | '))
  document.fillColor('#17212b')
  for (const row of table.rows) {
    const record = row.map((value, index) => `${table.columns[index] ?? `列${index + 1}`}：${value}`).join('； ')
    left(); document.fontSize(9).text(record, { lineGap: 2 })
  }
}

/** 以嵌入字体输出实际 PDF；没有真实质量证据的说明由调用方原样写入，不生成推测曲线。 */
export async function createLocalReportPdf(input: {
  title: string
  notes: string[]
  sections: ReportTable[]
  charts: Array<{ title: string; rows: Array<{ label: string; value: number; time?: number; breakBefore?: boolean }>; kind?: 'BAR' | 'LINE' | 'RADAR'; unit?: string }>
  chartScope: string
}): Promise<Buffer> {
  const fontPath = chineseFontPath()
  return await new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', margin: 42, info: { Title: input.title, Author: 'WRJ' } })
    const chunks: Buffer[] = []
    document.on('data', (chunk: Buffer) => chunks.push(chunk))
    document.once('error', reject)
    document.once('end', () => resolve(Buffer.concat(chunks)))
    try {
      // 只注册上方已检查的单字体文件，并嵌入子集供接收方离线阅读。
      document.registerFont('wrj-cjk', fontPath)
      document.font('wrj-cjk').fillColor('#17212b').fontSize(20).text(input.title)
      document.moveDown(0.6)
      for (const note of input.notes) document.fontSize(10).text(`说明：${note}`, { lineGap: 3 })
      for (const chart of input.charts) {
        document.x = document.page.margins.left
        document.moveDown(0.6).fontSize(14).text(`统计图表：${chart.title}`)
        document.fontSize(9).text(chart.kind === 'LINE' ? input.chartScope.replace('；单位：条', '') : input.chartScope)
        if (!chart.rows.length) document.fontSize(10).text('当前范围没有记录。')
        if (chart.kind === 'LINE') {
          const values = chart.rows.map(row => row.value), minimum = Math.min(...values), maximum = Math.max(...values), span = Math.max(1e-12, maximum - minimum)
          const times = chart.rows.map((row, index) => row.time ?? index), startTime = Math.min(...times), endTime = Math.max(...times), timeSpan = Math.max(1e-12, endTime - startTime)
          if (document.y + 190 > document.page.height - document.page.margins.bottom) document.addPage()
          const startX = document.page.margins.left, startY = document.y + 20
          document.fontSize(9).text(`横轴：${startTime}～${endTime} 秒；纵轴：${minimum}～${maximum} ${chart.unit ?? ''}`)
          document.moveTo(startX, startY).lineTo(startX, startY + 130).lineTo(startX + 400, startY + 130).stroke('#17212b')
          chart.rows.forEach((row, index) => {
            const x = chart.rows.length === 1 ? startX + 200 : startX + ((row.time ?? index) - startTime) / timeSpan * 400
            const y = startY + 130 - (row.value - minimum) / span * 120
            if (index === 0 || row.breakBefore) document.moveTo(x, y); else document.lineTo(x, y)
          })
          document.stroke('#2f6b8f').fillColor('#17212b'); document.y = startY + 145; document.x = startX
          for (const row of chart.rows) document.fontSize(9).text(`${row.label}：${row.value} ${chart.unit ?? ''}`)
        } else {
          if (chart.kind === 'RADAR') document.fontSize(9).text(chart.rows.length >= 3 ? '雷达图数据：仅统计连续有效观测区间；缺口和末帧不计。' : '有效观测链路不足 3 条，不能绘制雷达图。')
          const maximum = Math.max(...chart.rows.map(row => row.value), 1)
          for (const row of chart.rows) {
            if (document.y + 44 > document.page.height - document.page.margins.bottom) document.addPage()
            document.x = document.page.margins.left
            document.fontSize(10).text(`${row.label}：${row.value} 条`)
            const startX = document.page.margins.left, startY = document.y + 3, width = Math.max(0, row.value / maximum * 380)
            document.rect(startX, startY, width, 8).fill('#2f6b8f').fillColor('#17212b')
            document.y = startY + 14; document.x = startX
          }
        }
      }
      for (const section of input.sections) writeTable(document, section)
      document.end()
    } catch (error) {
      document.destroy(error instanceof Error ? error : new Error('PDF 生成失败。'))
    }
  })
}

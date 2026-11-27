import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import type { LocalReportEvidence, LocalReportExportResult, LocalReportFilter, Report } from '../../src/contracts/domain-models.js'
import { EVENT_LABELS, isLocalReport, localReportTables, localReportChartRange, localReportMetrics, reportTime } from '../../src/features/reports/local-report.js'
import { localReportMetricCharts, localReportRadarRows } from '../../src/features/reports/local-report-charts.js'
import { qualityReportView } from '../../src/features/reports/quality-report.js'
import { readAfsimLogFile, readLocalFileDigest } from './afsim-log-reader.js'
import { readLocalReplay } from './afsim-replay-reader.js'
import type { MissionResultRecord } from '../../src/features/results/mission-result.js'
import type { MissionResultParameterComparison } from '../../src/features/results/mission-result.js'
import { writeLocalReportPdf, type LocalReportPdfInput, type ReportFileChart } from './pdf-report.js'
import { buildReportKeyEvents } from './report-key-events.js'
import {
  downsampleCurveRows,
  EXPORT_CURVE_FULL_MARKER_LIMIT,
  EXPORT_CURVE_MAX_POINTS,
  EXPORT_CURVE_MAX_POLYLINES,
  selectCurveMarkerIndices,
} from './report-curve-downsample.js'

const STREAM_FLUSH_THRESHOLD_CHARS = 64 * 1024

/** 流式写入 UTF-8 文本报告并增量计算 SHA-256，避免在内存中拼接整份巨型 HTML/CSV 字符串。 */
async function writeReportStream(
  filePath: string,
  produce: (write: (chunk: string) => Promise<void>) => Promise<void>,
): Promise<string> {
  const stream = createWriteStream(filePath, { encoding: 'utf8', flags: 'wx' })
  const checksum = createHash('sha256')
  const failure = new AbortController()
  const done = finished(stream)
  void done.catch(error => failure.abort(error))
  let pending = ''
  const flush = async () => {
    if (!pending) return
    const payload = pending
    pending = ''
    failure.signal.throwIfAborted()
    checksum.update(payload, 'utf8')
    if (!stream.write(payload, 'utf8')) {
      await once(stream, 'drain', { signal: failure.signal })
    }
  }
  const write = async (chunk: string) => {
    if (!chunk) return
    pending += chunk
    if (pending.length >= STREAM_FLUSH_THRESHOLD_CHARS) await flush()
  }
  try {
    await produce(write)
    await flush()
    stream.end()
    await done
    return checksum.digest('hex')
  } catch (error) {
    stream.destroy(error instanceof Error ? error : new Error('报告写入失败。'))
    await done.catch(() => {})
    throw failure.signal.aborted ? failure.signal.reason : error
  }
}
import { toDetectionEvent } from '../../src/features/reports/detection-events.js'
import { engineSegmentDetails } from '../../src/features/reports/engine-segment-details.js'

/** 侦测规范事件明细上限；计数仍在事件分类统计中完整保留。 */
const DETECTION_DETAIL_LIMIT = 500

/** 仅读取本机配置路径；摘要绑定原始文件，不把文件快照冒充场景或引擎运行编号。 */
export async function readLocalReport(eventPath: string | undefined, positionPath: string | undefined, names?: Map<string, string>, displayNames?: Map<string, string>): Promise<Report | null> {
  if (!eventPath || !positionPath) return null
  const log = await readAfsimLogFile(eventPath, names)
  const replay = await readLocalReplay(eventPath, positionPath, log.summary.simulationComplete, names, displayNames)
  if (!log.valid || !log.summary.timeRange || log.source.sha256 !== replay.initial.sha256) throw new Error('事件文件快照不一致或无有效事件。')
  // 两份文件分别读取后再次比对，拒绝读到正在替换的文件；不修改源文件或回放游标。
  const latest = await Promise.all([readLocalFileDigest(eventPath), readLocalFileDigest(positionPath)])
  if (latest[0]!.source.sha256 !== log.source.sha256 || latest[1]!.source.sha256 !== replay.sha256) throw new Error('来源文件已变化，请重新加载。')
  const tracks = new Map(replay.tracks.map(track => [track.platformId, track.positions]))
  const evidence: LocalReportEvidence = {
    eventFile: { fileName: log.source.fileName, sha256: log.source.sha256 },
    positionFile: { fileName: replay.fileName, sha256: replay.sha256 },
    startTimeS: Math.min(log.summary.timeRange.start, ...replay.initial.nodes.map(node => node.time)),
    endTimeS: Math.max(log.summary.timeRange.end, replay.durationS),
    simulationComplete: log.summary.simulationComplete,
    positionCount: replay.recordCount, positionIssueCount: replay.issueCount, waitingForPositionLine: replay.waitingForLine,
    eventCount: log.summary.eventCount, eventWarningCount: log.summary.warningCount,
    ...(('messageDetailsComplete' in log && log.messageDetailsComplete === false)
      ? { messageDetailsComplete: false, messageDetailEventCount: log.messageDetailEventCount } : {}),
    nodes: replay.initial.nodes.map(node => {
      const positions = tracks.get(node.platformId) ?? []
      return { platformId: node.platformId, name: node.name, type: node.type, side: node.side ?? '未提供', positionCount: positions.length,
        firstTimeS: positions[0]?.time ?? node.time, lastTimeS: positions.at(-1)?.time ?? node.time }
    }),
    eventCounts: Object.entries(log.summary.eventCounts).sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => ({ type, count })),
    connections: log.connections.map(row => ({ eventId: row.sourceEventId, time: row.time, scope: row.scope,
      sourcePlatformId: row.source.platformName, sourceDeviceId: row.source.communicationName,
      targetPlatformId: row.target.platformName, targetDeviceId: row.target.communicationName })),
    deviceEvents: log.events.filter(event => /^(COMM_TURNED_(ON|OFF)|WEAPON_TURNED_(ON|OFF)|WEAPON_MODE_(ACTIVATED|DEACTIVATED)|JAMMING_REQUEST_(INITIATED|UPDATED|CANCELED))$/.test(event.type))
      .map(event => ({ eventId: event.id, type: event.type, time: event.time, platformId: event.subject,
        deviceId: event.fields.system ?? event.fields.Comm ?? event.fields.weapon ?? event.fields.system_platform ?? '' })),
  }
  const nodeIds = new Set(evidence.nodes.map(node => node.platformId))
  const detections = log.events.map(toDetectionEvent).filter((row): row is NonNullable<typeof row> => row !== null && nodeIds.has(row.platformId))
  if (detections.length) evidence.detectionEvents = detections.slice(0, DETECTION_DETAIL_LIMIT)
  const digest = createHash('sha256').update(`local-report-v1:${log.source.sha256}:${replay.sha256}`).digest('hex')
  const report: Report = { reportId: `RPT-LOCAL-${digest}`, classification: 'LEVEL_II', generatedTime: new Date().toISOString(), status: 'READY', localEvidence: evidence }
  if (!isLocalReport(report)) throw new Error('报告统计或来源引用未闭合。')
  return report
}

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
// CSV 引号只防止分列，不防公式执行；所有以危险前缀开头的文本额外加单引号。
export const csvCell = (value: string) => `"${(/^[\s]*[=+@-]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`

export function reportChartSvg(chart: Pick<ReportFileChart, 'title' | 'rows' | 'unit'>, scope: string): string {
  const maximum = chart.rows.reduce((largest, row) => Math.max(largest, Math.abs(row.value)), 1)
  const signed = chart.rows.some(row => row.value < 0)
  const baseline = signed ? 400 : 220
  const formatted = chart.rows.some(row => row.displayValue !== undefined)
  return `<h2>${escapeHtml(chart.title)}</h2><p>${escapeHtml(scope)}</p><svg viewBox="0 0 640 ${Math.max(90, chart.rows.length * 34 + 30)}" role="img" aria-label="${escapeHtml(chart.title)}柱状图">${chart.rows.length ? '' : '<text x="0" y="25">暂无数据</text>'}${chart.rows.map((row, index) => {
    const y = 12 + index * 34, width = Math.round(Math.abs(row.value) / maximum * (signed ? 180 : formatted ? 240 : 360))
    const value = row.displayValue ?? `${row.value} ${chart.unit ?? '条'}`
    const valueX = formatted ? 632 : baseline + (row.value < 0 ? 8 : width + 8)
    return `<text x="0" y="${y + 14}">${escapeHtml(row.label)}</text><rect x="${row.value < 0 ? baseline - width : baseline}" y="${y}" width="${width}" height="18" fill="#2f6b8f"/><text x="${valueX}" y="${y + 14}" text-anchor="${formatted ? 'end' : 'start'}">${escapeHtml(value)}</text>`
  }).join('')}</svg>`
}

export function reportCurveSvg(chart: Pick<ReportFileChart, 'title' | 'rows' | 'unit' | 'timeRange' | 'stepEnd' | 'showPointList'>, scope: string): string {
  if (!chart.rows.length) return `<h2>${escapeHtml(chart.title)}</h2><p>${escapeHtml(scope)}</p><p>暂无数据</p>`
  const unit = chart.unit ?? ''
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
  const decimals = plotted.length > EXPORT_CURVE_FULL_MARKER_LIMIT ? 1 : 2
  const xs: string[] = new Array(plotted.length)
  const ys: string[] = new Array(plotted.length)
  for (let i = 0; i < plotted.length; i += 1) {
    const row = plotted[i]!
    const x = startTime === endTime ? 320 : 50 + ((row.time ?? i) - startTime) / timeSpan * 540
    const y = 190 - (row.value - minimum) / span * 150
    xs[i] = x.toFixed(decimals)
    ys[i] = y.toFixed(decimals)
  }
  const segments: string[][] = []
  let current: string[] = []
  for (let i = 0; i < plotted.length; i += 1) {
    const row = plotted[i]!
    if (row.breakBefore && current.length) { segments.push(current); current = [] }
    if (chart.stepEnd && current.length) current.push(`${xs[i]},${ys[i - 1]}`)
    current.push(`${xs[i]},${ys[i]}`)
  }
  if (current.length) segments.push(current)
  // 小图及常规分段保持 `<polyline>`；极端高频断帧合并为单条 `<path>`，避免生成数千个 SVG 节点。
  let curveMarkup = ''
  if (segments.length <= EXPORT_CURVE_MAX_POLYLINES) {
    curveMarkup = segments.map(segment => `<polyline points="${segment.join(' ')}" fill="none" stroke="#2f6b8f" stroke-width="2"/>`).join('')
  } else {
    const dParts: string[] = []
    for (const segment of segments) {
      if (segment.length < 2) continue
      dParts.push(`M${segment[0]}L${segment.slice(1).join('L')}`)
    }
    if (dParts.length) curveMarkup = `<path d="${dParts.join('')}" fill="none" stroke="#2f6b8f" stroke-width="2"/>`
  }
  const markerIndices = selectCurveMarkerIndices(plotted)
  let markers = ''
  for (const index of markerIndices) {
    const row = plotted[index]!
    markers += `<circle cx="${xs[index]}" cy="${ys[index]}" r="3" fill="#2f6b8f"><title>${escapeHtml(`${row.label}: ${row.value} ${unit}`)}</title></circle>`
  }
  const sampleNote = plotted.length < chart.rows.length ? `（已按极值保真降采样至 ${plotted.length}/${chart.rows.length} 点）` : ''
  return `<h2>${escapeHtml(chart.title)}</h2><p>${escapeHtml(scope)}；横轴：${startTime}～${endTime} 秒；纵轴：${minimum}～${maximum} ${escapeHtml(unit)}${sampleNote}</p><svg viewBox="0 0 640 230" role="img" aria-label="${escapeHtml(chart.title)}折线图"><line x1="50" y1="20" x2="50" y2="190" stroke="#17212b"/><line x1="50" y1="190" x2="600" y2="190" stroke="#17212b"/>${curveMarkup}${markers}</svg>`
}

export function reportRadarSvg(chart: Pick<ReportFileChart, 'title' | 'rows' | 'normalizedScore' | 'unit'>, scope: string): string {
  if (!chart.rows.length) return `<h2>${escapeHtml(chart.title)}</h2><p>${escapeHtml(scope)}</p><p>暂无数据</p>`
  if (chart.rows.length < 3) return `<h2>${escapeHtml(chart.title)}</h2><p>${escapeHtml(scope)}</p><p>${chart.normalizedScore ? '有效指标不足三项，列出各项得分。' : '有效链路不足三条，按数值展示连通率。'}</p><ol>${chart.rows.map(row => `<li>${escapeHtml(row.label)}：${row.value} ${escapeHtml(chart.unit ?? '%')}</li>`).join('')}</ol>`
  const point = (index: number, value: number) => { const angle = index * Math.PI * 2 / chart.rows.length - Math.PI / 2; return `${150 + 90 * value / 100 * Math.cos(angle)},${120 + 90 * value / 100 * Math.sin(angle)}` }
  const description = chart.normalizedScore ? '评估指标归一化得分范围 0–100。' : '仅统计连续有效观测区间，缺口和末帧不计。'
  const labels = chart.rows.map((row, index) => {
    const [x, y] = point(index, 112).split(',').map(Number) as [number, number]
    const anchor = x < 149 ? 'end' : x > 151 ? 'start' : 'middle'
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="central" font-size="12">${escapeHtml(row.label)}</text>`
  }).join('')
  return `<h2>${escapeHtml(chart.title)}</h2><p>${escapeHtml(scope)}；${description}</p><svg viewBox="-72 0 444 248" role="img" aria-label="${escapeHtml(chart.title)}雷达图"><circle cx="150" cy="120" r="90" fill="none" stroke="#17212b"/><polygon points="${chart.rows.map((row, index) => point(index, row.value)).join(' ')}" fill="#2f6b8f" fill-opacity=".2" stroke="#2f6b8f"/>${labels}</svg>`
}

async function writeStatisticsCsvStream(
  filePath: string,
  report: Report & { localEvidence: LocalReportEvidence },
  watermark: string,
  source: MissionResultRecord | undefined,
  comparisons: MissionResultParameterComparison[],
  filter?: LocalReportFilter,
): Promise<string> {
  const tables = localReportTables(report.localEvidence, true)
  const berLabel = 'BER'
  const quality = report.localEvidence.quality === undefined ? undefined : qualityReportView(report.localEvidence.quality, report.localEvidence)
  const engine = report.localEvidence.engineFrameArchive
  const engineCsv = report.localEvidence.engineCsv
  const qualityConnectivityRates = report.localEvidence.qualityConnectivityRates ?? quality?.connectivityRates ?? []
  const notes = ['本报告只陈述文件记录；登记关联、设备启停、消息收发均不等于物理链路质量。', quality === undefined && engine === undefined
    ? `没有 SNR、${berLabel}、接收功率或链路质量证据，不计算连通率、丢包率和干扰效果；不关联未经证实的场景/运行。`
    : quality === undefined
      ? `段级 GXB、${berLabel}、接收功率和损耗仅来自已归档引擎帧；不补 SNR，不合并为逻辑链路，不计算规范质量文件的连通率或干扰效果。`
      : '质量指标和曲线仅来自报告中绑定的已导入测量文件；采样缺口不外推，干扰时长仅统计来源明确标注为活动的连续观测区间。']
  if (engine?.detailTruncated) notes.push(`引擎归档报告明细仅保留 ${engine.retainedDetailRows} 行；完整 JSONL 需按执行结果和来源 SHA-256 下载核查，截取明细不代表完整统计。`)
  if (engine?.aggregate) notes.push(`引擎汇总基于完整归档流：唯一单段有效样本 ${engine.aggregate.uniqueSingleSegmentCount} 条；路由切换仅计实际记录 ${engine.aggregate.switchCount} 条，不代表切换成功率。`)
  if (filter) notes.push('精确筛选的通信关联、设备事件明细每类最多展示前 500 条；事件分类统计与图表包含全部匹配记录。')
  const metadata = [['报告编号', report.reportId], ['生成时刻', report.generatedTime], ['导出标记', watermark], ['事件文件', report.localEvidence.eventFile.fileName], ['事件文件 SHA-256', report.localEvidence.eventFile.sha256], ['位置文件', report.localEvidence.positionFile.fileName], ['位置文件 SHA-256', report.localEvidence.positionFile.sha256]]
  if (filter) metadata.push(['已应用筛选', [filter.nodeId && `节点=${filter.nodeId}`, filter.linkId && `链路=${filter.linkId}`, filter.stage && `任务阶段=${filter.stage}`,
    (filter.from !== undefined || filter.to !== undefined) && `时间=${filter.from ?? report.localEvidence.startTimeS}～${filter.to ?? report.localEvidence.endTimeS} 秒`].filter(Boolean).join('； ') || '全部'])
  if (source) metadata.unshift(['执行结果编号', source.resultId], ['场景编号', source.scenarioId], ['场景名称', source.scenarioName], ['场景修订', String(source.revision)], ['运行开始', source.startedAt], ['运行完成', source.completedAt])
  if (source?.executionSource === 'REMOTE_WS') metadata.push(['接收结果说明', '本次 WebSocket 接收已结束；引擎指标来自本次归档，文件事件与轨迹来自所播放的文件，不表示引擎已确认停止。'])
  if (comparisons.some(item => item.record.resultId === source?.resultId && item.parameters.source === 'PROJECT_REFERENCE')) notes.push('参数及任务阶段来自播放前冻结的项目参考配置，未确认引擎实际执行版本；阶段筛选按该参考计划的时间范围统计。')
  if (quality) metadata.push(['质量来源文件', quality.dataset.source.fileName], ['质量来源 SHA-256', quality.dataset.source.sha256])
  if (engine) metadata.push(['引擎帧归档 SHA-256', engine.sourceSha256], ['引擎帧数', String(engine.frameCount)], ['引擎帧时刻范围', `${engine.firstSimulationTime ?? '暂无数据'}～${engine.lastSimulationTime ?? '暂无数据'} 秒`])
  if (engineCsv) metadata.push(['引擎规范CSV来源 SHA-256', engineCsv.sourceSha256], ['已生成规范CSV', engineCsv.files.map(file => `${file.fileName}（${file.rowCount}行）`).join('；') || '无'])
  const parameterRows = comparisons.map(({ record, parameters }) => [
    record.resultId, record.completedAt, `${parameters.scenarioId} · ${parameters.source === 'PROJECT_REFERENCE' ? '项目参考配置，未确认引擎实际执行版本' : '运行配置快照'}`, String(parameters.revision), String(parameters.platformCount), String(parameters.linkCount), String(parameters.jammerCount),
    parameters.links.map(link => `${link.id} ${link.type} ${link.frequencyMHz}MHz/${link.bandwidthMHz}MHz/${link.txPowerW}W`).join('； ') || '无',
    parameters.jammers.map(jammer => `${jammer.id} ${jammer.frequencyMHz}MHz/${jammer.bandwidthMHz}MHz/${jammer.defaultPowerW}W`).join('； ') || '无',
  ])
  const parameterSection = source === undefined ? [] : [{ title: '同场景已完成运行参数对比',
    columns: ['运行结果', '完成时刻', '配置来源', '修订', '节点数', '链路数', '干扰机数', '链路参数（频率/带宽/功率）', '干扰机参数（频率/带宽/默认功率）'],
    rows: parameterRows.length ? parameterRows : [['当前结果未保存参数快照', '暂无数据', '暂无数据', '暂无数据', '暂无数据', '暂无数据', '暂无数据', '暂无数据', '暂无数据']],
  }]
  const engineCsvSections = engineCsv === undefined ? [] : [{ title: '引擎规范 CSV 生成状态', columns: ['文件', '状态', '已写入行数', '跳过行数', '原因'], rows: [
    ...engineCsv.files.map(file => [file.fileName, file.status, String(file.rowCount), String(file.skippedCount), file.reason ?? '无']),
    ...engineCsv.missing.map(file => [file.fileName, '暂无数据', '暂无数据', '暂无数据', file.reason]),
  ] }]
  const chartContext = (sourceSha256: string) => ({ reportId: report.reportId, ...(report.runId ? { runId: report.runId } : {}), ...(source?.resultId ? { resultId: source.resultId } : {}), sourceSha256 })
  const eventRange = localReportChartRange(report.localEvidence, report.localEvidence.eventFile.fileName, filter, chartContext(report.localEvidence.eventFile.sha256))
  const positionRange = localReportChartRange(report.localEvidence, report.localEvidence.positionFile.fileName, filter, chartContext(report.localEvidence.positionFile.sha256))
  const qualityRange = localReportChartRange(report.localEvidence, quality?.dataset.source.fileName ?? '未导入质量数据', filter, quality === undefined ? undefined : chartContext(quality.dataset.source.sha256))
  const chartSections = [
    { title: '柱状图数据表：事件分类统计', unit: '条', sourceRange: eventRange, rows: report.localEvidence.eventCounts.map(row => ({ label: EVENT_LABELS[row.type] ?? row.type, value: row.count })) },
    { title: '柱状图数据表：节点位置记录数', unit: '条', sourceRange: positionRange, rows: report.localEvidence.nodes.map(node => ({ label: node.name, value: node.positionCount })) },
    { title: '雷达图数据表：各链路有效观测区间连通率', unit: '%', sourceRange: qualityRange, rows: qualityConnectivityRates.map(row => ({ label: row.linkId, value: row.value })) },
  ].map(chart => ({
    title: chart.title,
    columns: ['标签', '数值', '单位', '数据范围', '生成时刻'],
    rows: chart.rows.length
      ? chart.rows.map(row => [row.label, String(row.value), chart.unit, chart.sourceRange, report.generatedTime])
      : [['暂无数据', '', chart.unit, chart.sourceRange, report.generatedTime]],
  }))

  return writeReportStream(filePath, async write => {
    let firstLine = true
    const writeCsvRow = async (cells: readonly string[]) => {
      const line = `${firstLine ? '\uFEFF' : '\r\n'}${cells.map(csvCell).join(',')}`
      firstLine = false
      await write(line)
    }
    const writeSection = async (title: string, columns: readonly string[], rows: Iterable<readonly string[]>) => {
      await writeCsvRow([title])
      await writeCsvRow(columns)
      for (const row of rows) await writeCsvRow(row)
      await writeCsvRow([])
    }
    for (const note of notes) await writeCsvRow([note])
    for (const section of [{ title: '来源与范围', columns: ['项目', '值'], rows: metadata }, ...parameterSection, ...tables]) {
      await writeSection(section.title, section.columns, section.rows)
    }
    if (engine !== undefined) {
      // 逐行流式生成引擎大表，避免先在内存中构造数万行二维字符串数组。
      await writeCsvRow(['引擎链路段实测（仅已接收帧）'])
      await writeCsvRow(['轮次', '帧', '时刻（秒）', '段标识', '源端', '目标端', 'GXB（dB）', berLabel, '接收功率（dBm）', '接收功率（dBW）', '总复合损耗（dB，原值）'])
      if (engine.segmentRows.length) {
        for (const row of engine.segmentRows) {
          await writeCsvRow([String(row.engineEpoch), String(row.frameId), String(row.simulationTime), row.segment.linkId,
            `${row.segment.sourceName ?? '暂无数据'}:${row.segment.sourcePort ?? '暂无数据'}`, `${row.segment.targetName ?? '暂无数据'}:${row.segment.targetPort ?? '暂无数据'}`,
            String(row.segment.quality.gxbDb ?? '暂无数据'), String(row.segment.quality.ber ?? '暂无数据'), String(row.segment.quality.rxPowerDbm ?? '暂无数据'), String(row.segment.quality.rxPowerDbw ?? '暂无数据'), String(row.segment.losses.totalDb ?? '暂无数据')])
        }
      } else {
        await writeCsvRow(['暂无数据', '', '', '', '', '', '', '', '', '', ''])
      }
      await writeCsvRow([])

      await writeCsvRow(['引擎链路段完整参数（源值）'])
      await writeCsvRow(['轮次/帧/时刻（秒）/段标识', '链路信息', '损耗明细', '通信参数', '干扰来源（计算输入）'])
      for (const row of engine.segmentRows) {
        await writeCsvRow([`${row.engineEpoch}/${row.frameId}/${row.simulationTime}/${row.segment.linkId}`,
          ...engineSegmentDetails(row.segment).map(group => group.rows.map(([label, value]) => `${label}：${value}`).join('；'))])
      }
      await writeCsvRow([])

      await writeSection('引擎路由切换（仅已接收帧）', ['轮次', '帧', '时刻（秒）', '方向', '旧路径', '新路径', '原因（段/原始原因）'],
        engine.switchRows.length
          ? engine.switchRows.map(row => [String(row.engineEpoch), String(row.frameId), String(row.simulationTime), row.value.direction,
            row.value.oldPathId ?? '暂无数据', row.value.pathId, row.value.reasons.map(reason => `${reason.linkId ?? '暂无数据'}:${reason.reasons.join('|') || '暂无数据'}`).join('；') || '暂无数据'])
          : [['暂无数据', '', '', '', '', '', '']])
      await writeSection('引擎事件（仅已接收帧）', ['轮次', '帧', '时刻（秒）', '类型', '路径', '无人机', '干扰设备'],
        engine.eventRows.length
          ? engine.eventRows.map(row => [String(row.engineEpoch), String(row.frameId), String(row.simulationTime), row.value.type ?? '暂无数据', row.value.pathId ?? '暂无数据', row.value.uavNames.join('；') || '暂无数据', row.value.jammerNames.join('；') || '暂无数据'])
          : [['暂无数据', '', '', '', '', '', '']])
      await writeSection('引擎暂无数据字段', ['字段', '数据'], engine.missingFieldNames.length ? engine.missingFieldNames.map(field => [field, '暂无数据']) : [['无', '']])
    }
    for (const section of [...engineCsvSections, ...chartSections]) {
      await writeSection(section.title, section.columns, section.rows)
    }
  })
}

function buildReportBrief(report: Report & { localEvidence: LocalReportEvidence }, watermark: string, source: MissionResultRecord | undefined, comparisons: MissionResultParameterComparison[], filter?: LocalReportFilter): LocalReportPdfInput {
  const evidence = report.localEvidence
  const engine = evidence.engineFrameArchive
  const quality = evidence.quality === undefined ? null : qualityReportView(evidence.quality, evidence)
  const metrics = localReportMetrics(evidence)
  const range = `${reportTime(evidence.startTimeS)}～${reportTime(evidence.endTimeS)}`
  const filterLabel = [filter?.nodeId && `节点=${filter.nodeId}`, filter?.linkId && `链路=${filter.linkId}`, filter?.stage && `任务阶段=${filter.stage}`,
    (filter?.from !== undefined || filter?.to !== undefined) && `时间=${filter.from ?? evidence.startTimeS}～${filter.to ?? evidence.endTimeS} 秒`].filter(Boolean).join('； ') || '全部数据'
  const runRows = source === undefined ? [] : [['场景名称', source.scenarioName], ['场景编号', source.scenarioId], ['场景修订', String(source.revision)],
    ['执行结果编号', source.resultId], ['运行开始', source.startedAt], ['运行完成', source.completedAt]]
  const metadata = [...runRows, ['报告编号', report.reportId], ['生成时刻', report.generatedTime], ['导出标记', watermark],
    ['统计范围', range], ['已应用筛选', filterLabel], ['结束事件', evidence.simulationComplete ? '已记录' : '未记录'],
    ['有效位置记录', String(evidence.positionCount)], ['事件记录', String(evidence.eventCount)],
    ['事件文件', evidence.eventFile.fileName], ['事件文件 SHA-256', evidence.eventFile.sha256],
    ['位置文件', evidence.positionFile.fileName], ['位置文件 SHA-256', evidence.positionFile.sha256]]
  if (quality) metadata.push(['质量来源文件', quality.dataset.source.fileName], ['质量来源 SHA-256', quality.dataset.source.sha256])
  if (engine) metadata.push(['引擎帧归档 SHA-256', engine.sourceSha256])
  const reference = comparisons.find(item => item.record.resultId === source?.resultId && item.parameters.source === 'PROJECT_REFERENCE')?.parameters
  if (reference) metadata.push(['参考场景编号', reference.scenarioId], ['参考场景修订', String(reference.revision)])

  const keyEvents = buildReportKeyEvents(evidence)
  const notes = [keyEvents.note, '详细统计与可用的原始归档见报表页面的「数据导出」。']
  if (source?.executionSource === 'REMOTE_WS') notes.push('本次 WebSocket 接收已结束；结果不表示引擎已确认停止。')
  if (reference) notes.push('参数及任务阶段来自播放前冻结的项目参考配置，未确认引擎实际执行版本；阶段筛选按该参考计划的时间范围统计。')
  const truncated = engine?.detailTruncated === true && !quality?.samples.length
  const trendEvidence = truncated ? { ...evidence, engineFrameArchive: { ...engine, segmentRows: [] } } : evidence
  if (truncated) notes.push('引擎明细超出导出上限，连通时长、干信比、误码率的逐帧折线未导出；汇总及可用的累计趋势仍按完整筛选范围统计。')

  const charts: ReportFileChart[] = localReportMetricCharts(trendEvidence, quality, metrics)
    .filter(chart => chart.rows.length > 0)
    .map(({ key, title, unit, rows }) => ({ title, unit, rows, kind: 'LINE', stepEnd: key === 'switches',
      timeRange: [evidence.startTimeS, evidence.endTimeS], showPointList: false }))
  const radar = localReportRadarRows(evidence, metrics)
  if (radar.length >= 3) charts.push({ title: '评估指标得分', kind: 'RADAR', unit: '分', normalizedScore: true, rows: radar })
  return {
    title: '本地运行数据报告',
    notes,
    summary: [{ title: '运行与筛选', columns: ['项目', '值'], rows: metadata },
      { title: '五项评估指标', columns: ['指标', '结果'], rows: metrics.map(metric => [metric.label, metric.display]) }],
    sections: [keyEvents.table],
    charts,
    chartScope: `统计范围 ${range}`,
  }
}

async function writeHtmlTableStream(write: (chunk: string) => Promise<void>, section: LocalReportPdfInput['sections'][number]): Promise<void> {
  await write(`<h2>${escapeHtml(section.title)}</h2><table><thead><tr>${section.columns.map(text => `<th>${escapeHtml(text)}</th>`).join('')}</tr></thead><tbody>`)
  for (const row of section.rows) {
    await write(`<tr>${row.map(text => `<td>${escapeHtml(text)}</td>`).join('')}</tr>`)
  }
  await write('</tbody></table>')
}

async function writeBriefReportHtmlStream(filePath: string, report: LocalReportPdfInput): Promise<string> {
  return writeReportStream(filePath, async write => {
    await write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>本地运行数据报告</title><style>body{font-family:system-ui,sans-serif;margin:32px}table{border-collapse:collapse;width:100%;margin-bottom:24px}td,th{border:1px solid #ccc;padding:8px;text-align:left;overflow-wrap:anywhere}th{background:#eef3f7}svg{max-width:640px;width:100%;height:auto}p{line-height:1.6}</style><h1>本地运行数据报告</h1>')
    for (const note of report.notes) await write(`<p>${escapeHtml(note)}</p>`)
    for (const section of report.summary ?? []) await writeHtmlTableStream(write, section)
    for (const chart of report.charts) {
      await write(chart.kind === 'RADAR' ? reportRadarSvg(chart, report.chartScope) : reportCurveSvg(chart, report.chartScope))
    }
    for (const section of report.sections) await writeHtmlTableStream(write, section)
    await write('</html>')
  })
}

/** 创建独占导出目录，失败仅清理本次文件；不允许客户端提供路径或正文。 */
export async function exportLocalReport(directory: string, report: Report, format: 'HTML' | 'PDF' | 'CSV', actor: string, source?: MissionResultRecord, comparisons: MissionResultParameterComparison[] = [], filter?: LocalReportFilter): Promise<LocalReportExportResult> {
  if (!isLocalReport(report) || !['HTML', 'PDF', 'CSV'].includes(format)) throw new Error('不支持的真实报告或导出格式。')
  const verifiedAt = new Date().toISOString()
  const watermark = `本地文件统计 · 二级 · 导出人 ${actor} · ${verifiedAt}`
  const root = resolve(directory)
  await mkdir(root, { recursive: true })
  const owned = await mkdtemp(join(root, 'report-'))
  const filePath = join(owned, `${report.reportId}.${format.toLowerCase()}`)
  try {
    let sha256: string
    if (format === 'CSV') {
      sha256 = await writeStatisticsCsvStream(filePath, report, watermark, source, comparisons, filter)
    } else {
      const brief = buildReportBrief(report, watermark, source, comparisons, filter)
      sha256 = format === 'PDF' ? await writeLocalReportPdf(filePath, brief) : await writeBriefReportHtmlStream(filePath, brief)
    }
    return { reportId: report.reportId, generated: true, status: 'SUCCESS', format, watermark, verifiedAt, filePath, sha256 }
  } catch (error) {
    await rm(owned, { recursive: true, force: true })
    throw error
  }
}

/** D3 报告证据导出：复用既有 HTML/PDF 渲染器与图表组件格式，导出全部筛选时段而非当前明细页。 */
export async function exportEvidenceReport(directory: string, input: {
  reportId: string
  format: 'HTML' | 'PDF'
  sourceLabel: string
  sourceSha256: string
  filterLabel: string
  generatedTime: string
  charts: Array<{ title: string; kind: 'LINE' | 'BAR'; unit: string; rows: Array<{ label: string; value: number; time?: number; breakBefore?: boolean }>; sourceRange: string }>
  sections: Array<{ title: string; columns: string[]; rows: string[][] }>
}): Promise<LocalReportExportResult> {
  const verifiedAt = new Date().toISOString()
  const watermark = `本地报告证据 · ${input.sourceLabel} · 导出人证据 · ${verifiedAt}`
  const notes = [`来源：${input.sourceLabel}（SHA-256 ${input.sourceSha256}）`, `筛选范围：${input.filterLabel}`, '曲线与明细均来自同一已固定来源摘要；抽样点已标注，不代表完整逐帧实测。']
  const scopedCharts = input.charts.map(chart => {
    const isBer = chart.unit === 'BER'
    const unit = isBer ? '比率' : chart.unit
    return {
      ...chart,
      title: isBer ? `误码率 · ${chart.title}` : chart.title,
      unit,
      showPointList: false,
      scope: `${chart.sourceRange}；单位：${unit}；生成时刻：${input.generatedTime}`,
    }
  })
  const sections = input.sections.map(section => ({
    ...section,
    columns: section.columns.map(column => column === 'ber' ? '误码率' : column === 'oldBer' ? '原误码率' : column === 'newBer' ? '新误码率' : column),
  }))
  const root = resolve(directory)
  await mkdir(root, { recursive: true })
  const owned = await mkdtemp(join(root, 'evidence-'))
  const filePath = join(owned, `${input.reportId}.${input.format.toLowerCase()}`)
  try {
    const sha256 = input.format === 'PDF'
      ? await writeLocalReportPdf(filePath, { title: '报告证据导出', notes, sections, charts: scopedCharts, chartScope: input.filterLabel })
      : await writeReportStream(filePath, async write => {
        await write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>报告证据导出</title><style>body{font-family:system-ui,sans-serif;margin:32px}table{border-collapse:collapse;width:100%;margin-bottom:24px}td,th{border:1px solid #ccc;padding:8px;text-align:left;overflow-wrap:anywhere}th{background:#eef3f7}svg{max-width:640px;width:100%;height:auto}p{line-height:1.6}</style>')
        for (const note of notes) await write(`<p>${escapeHtml(note)}</p>`)
        for (const chart of scopedCharts) {
          await write(chart.kind === 'LINE' ? reportCurveSvg(chart, chart.scope) : reportChartSvg(chart, chart.scope))
        }
        for (const section of sections) await writeHtmlTableStream(write, section)
        await write('</html>')
      })
    return { reportId: input.reportId as LocalReportExportResult['reportId'], generated: true, status: 'SUCCESS', format: input.format, watermark, verifiedAt, filePath, sha256 }
  } catch (error) {
    await rm(owned, { recursive: true, force: true })
    throw error
  }
}

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { LocalReportEvidence, LocalReportExportResult, LocalReportFilter, Report } from '../../src/contracts/domain-models.js'
import { EVENT_LABELS, isLocalReport, localReportTables, localReportChartRange, reportTime } from '../../src/features/reports/local-report.js'
import { qualityReportView } from '../../src/features/reports/quality-report.js'
import { ENGINE_FRAME_ID_STEP } from '../../src/features/data-exchange/engine-frame-snapshot.js'
import { readAfsimLogFile, readLocalFileDigest } from './afsim-log-reader.js'
import { readLocalReplay } from './afsim-replay-reader.js'
import type { MissionResultRecord } from '../../src/features/results/mission-result.js'
import type { MissionResultParameterComparison } from '../../src/features/results/mission-result.js'
import { createLocalReportPdf } from './pdf-report.js'
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

export function reportChartSvg(chart: { title: string; rows: Array<{ label: string; value: number }> }, scope: string): string {
  const maximum = Math.max(1, ...chart.rows.map(row => row.value))
  return `<h2>${escapeHtml(chart.title)}</h2><p>${escapeHtml(scope)}</p><svg viewBox="0 0 640 ${Math.max(90, chart.rows.length * 34 + 30)}" role="img" aria-label="${escapeHtml(chart.title)}柱状图">${chart.rows.length ? '' : '<text x="0" y="25">暂无数据</text>'}${chart.rows.map((row, index) => {
    const y = 12 + index * 34, width = Math.round(row.value / maximum * 360)
    return `<text x="0" y="${y + 14}">${escapeHtml(row.label)}</text><rect x="220" y="${y}" width="${width}" height="18" fill="#2f6b8f"/><text x="${228 + width}" y="${y + 14}">${row.value} 条</text>`
  }).join('')}</svg>`
}

export function reportCurveSvg(chart: { title: string; rows: Array<{ label: string; value: number; time?: number; breakBefore?: boolean }>; unit: string }, scope: string): string {
  if (!chart.rows.length) return `<h2>${escapeHtml(chart.title)}</h2><p>${escapeHtml(scope)}</p><p>暂无数据</p>`
  const values = chart.rows.map(row => row.value), minimum = Math.min(...values), maximum = Math.max(...values), span = (maximum - minimum) || 1
  const times = chart.rows.map((row, index) => row.time ?? index), startTime = Math.min(...times), endTime = Math.max(...times), timeSpan = Math.max(1e-12, endTime - startTime)
  const points = chart.rows.map((row, index) => {
    const x = chart.rows.length === 1 ? 320 : 50 + ((row.time ?? index) - startTime) / timeSpan * 540
    const y = 190 - (row.value - minimum) / span * 150
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  const segments: string[] = [], current: string[] = []
  chart.rows.forEach((row, index) => { if (row.breakBefore && current.length) { segments.push(current.join(' ')); current.length = 0 } current.push(points[index]!) })
  if (current.length) segments.push(current.join(' '))
  return `<h2>${escapeHtml(chart.title)}</h2><p>${escapeHtml(scope)}；横轴：${startTime}～${endTime} 秒；纵轴：${minimum}～${maximum} ${escapeHtml(chart.unit)}</p><svg viewBox="0 0 640 230" role="img" aria-label="${escapeHtml(chart.title)}折线图"><line x1="50" y1="20" x2="50" y2="190" stroke="#17212b"/><line x1="50" y1="190" x2="600" y2="190" stroke="#17212b"/>${segments.map(segment => `<polyline points="${segment}" fill="none" stroke="#2f6b8f" stroke-width="2"/>`).join('')}${chart.rows.map((row, index) => `<circle cx="${points[index]!.split(',')[0]}" cy="${points[index]!.split(',')[1]}" r="3" fill="#2f6b8f"><title>${escapeHtml(`${row.label}: ${row.value} ${chart.unit}`)}</title></circle>`).join('')}</svg>`
}

export function reportRadarSvg(chart: { title: string; rows: Array<{ label: string; value: number }> }, scope: string): string {
  if (chart.rows.length < 3) return `<h2>${escapeHtml(chart.title)}</h2><p>${escapeHtml(scope)}</p><p>暂无数据</p>`
  const point = (index: number, value: number) => { const angle = index * Math.PI * 2 / chart.rows.length - Math.PI / 2; return `${150 + 90 * value / 100 * Math.cos(angle)},${120 + 90 * value / 100 * Math.sin(angle)}` }
  return `<h2>${escapeHtml(chart.title)}</h2><p>${escapeHtml(scope)}；仅统计连续有效观测区间，缺口和末帧不计。</p><svg viewBox="0 0 300 240" role="img" aria-label="${escapeHtml(chart.title)}雷达图"><circle cx="150" cy="120" r="90" fill="none" stroke="#17212b"/><polygon points="${chart.rows.map((row, index) => point(index, row.value)).join(' ')}" fill="#2f6b8f" fill-opacity=".2" stroke="#2f6b8f"/>${chart.rows.map((row, index) => `<text x="${point(index, 1).split(',')[0]}" y="${point(index, 1).split(',')[1]}">${escapeHtml(row.label)}</text>`).join('')}</svg>`
}

/** 创建独占导出目录，失败仅清理本次文件；不允许客户端提供路径或正文。 */
export async function exportLocalReport(directory: string, report: Report, format: 'HTML' | 'PDF' | 'CSV', actor: string, source?: MissionResultRecord, comparisons: MissionResultParameterComparison[] = [], filter?: LocalReportFilter): Promise<LocalReportExportResult> {
  if (!isLocalReport(report) || !['HTML', 'PDF', 'CSV'].includes(format)) throw new Error('不支持的真实报告或导出格式。')
  const verifiedAt = new Date().toISOString()
  const watermark = `本地文件统计 · 二级 · 导出人 ${actor} · ${verifiedAt}`
  const tables = localReportTables(report.localEvidence)
  const quality = report.localEvidence.quality === undefined ? undefined : qualityReportView(report.localEvidence.quality, report.localEvidence)
  const engine = report.localEvidence.engineFrameArchive
  const engineCsv = report.localEvidence.engineCsv
  const qualityConnectivityRates = report.localEvidence.qualityConnectivityRates ?? quality?.connectivityRates ?? []
  const notes = ['本报告只陈述文件记录；登记关联、设备启停、消息收发均不等于物理链路质量。', quality === undefined && engine === undefined
    ? '没有 SNR、BER、接收功率或链路质量证据，不计算连通率、丢包率和干扰效果；不关联未经证实的场景/运行。'
    : quality === undefined
      ? '段级 GXB、BER、接收功率和损耗仅来自已归档引擎帧；不补 SNR，不合并为逻辑链路，不计算规范质量文件的连通率或干扰效果。'
      : '质量指标和曲线仅来自报告中绑定的已导入测量文件；采样缺口不外推，干扰时长仅统计来源明确标注为活动的连续观测区间。']
  if (engine?.detailTruncated) notes.push(`引擎归档报告明细仅保留 ${engine.retainedDetailRows} 行；完整 JSONL 需按执行结果和来源 SHA-256 下载核查，截取明细不代表完整统计。`)
  if (engine?.aggregate) notes.push(`引擎汇总基于完整归档流：唯一单段有效样本 ${engine.aggregate.uniqueSingleSegmentCount} 条；路由切换仅计实际记录 ${engine.aggregate.switchCount} 条，不代表切换成功率。`)
  if (filter) notes.push('精确筛选的通信关联、设备事件明细每类最多展示前 500 条；事件分类统计与图表包含全部匹配记录。')
  const metadata = [['报告编号', report.reportId], ['生成时刻', report.generatedTime], ['导出标记', watermark], ['事件文件', report.localEvidence.eventFile.fileName], ['事件文件 SHA-256', report.localEvidence.eventFile.sha256], ['位置文件', report.localEvidence.positionFile.fileName], ['位置文件 SHA-256', report.localEvidence.positionFile.sha256]]
  if (filter) metadata.push(['已应用筛选', [filter.nodeId && `节点=${filter.nodeId}`, filter.linkId && `链路=${filter.linkId}`, filter.stage && `任务阶段=${filter.stage}`,
    (filter.from !== undefined || filter.to !== undefined) && `时间=${filter.from ?? report.localEvidence.startTimeS}～${filter.to ?? report.localEvidence.endTimeS} 秒`].filter(Boolean).join('； ') || '全部'])
  if (source) metadata.unshift(['执行结果编号', source.resultId], ['场景编号', source.scenarioId], ['场景名称', source.scenarioName], ['场景修订', String(source.revision)], ['运行开始', source.startedAt], ['运行完成', source.completedAt])
  if (source?.executionSource === 'REMOTE_WS') metadata.push(['接收结果说明', '本次 WebSocket 接收已结束；引擎指标来自本次归档，文件事件与轨迹来自所播放的文件，不表示引擎已确认停止。'])
  if (quality) metadata.push(['质量来源文件', quality.dataset.source.fileName], ['质量来源 SHA-256', quality.dataset.source.sha256])
  if (engine) metadata.push(['引擎帧归档 SHA-256', engine.sourceSha256], ['引擎帧数', String(engine.frameCount)], ['引擎帧时刻范围', `${engine.firstSimulationTime ?? '暂无'}～${engine.lastSimulationTime ?? '暂无'} 秒`])
  if (engineCsv) metadata.push(['引擎规范CSV来源 SHA-256', engineCsv.sourceSha256], ['已生成规范CSV', engineCsv.files.map(file => `${file.fileName}（${file.rowCount}行）`).join('；') || '无'])
  const parameterRows = comparisons.map(({ record, parameters }) => [
    record.resultId, record.completedAt, String(parameters.revision), String(parameters.platformCount), String(parameters.linkCount), String(parameters.jammerCount),
    parameters.links.map(link => `${link.id} ${link.type} ${link.frequencyMHz}MHz/${link.bandwidthMHz}MHz/${link.txPowerW}W`).join('； ') || '无',
    parameters.jammers.map(jammer => `${jammer.id} ${jammer.frequencyMHz}MHz/${jammer.bandwidthMHz}MHz/${jammer.defaultPowerW}W`).join('； ') || '无',
  ])
  const parameterSection = source === undefined ? [] : [{ title: '同场景已完成运行参数对比',
    columns: ['运行结果', '完成时刻', '修订', '节点数', '链路数', '干扰机数', '链路参数（频率/带宽/功率）', '干扰机参数（频率/带宽/默认功率）'],
    rows: parameterRows.length ? parameterRows : [['当前结果未保存参数快照', '暂无数据', '暂无数据', '暂无数据', '暂无数据', '暂无数据', '暂无数据', '暂无数据']],
  }]
  const engineSections = engine === undefined ? [] : [{ title: '引擎链路段实测（仅已接收帧）',
    columns: ['轮次', '帧', '时刻（秒）', '段标识', '源端', '目标端', 'GXB（dB）', 'BER', '接收功率（dBm）', '接收功率（dBW）', '总复合损耗（dB，原值）'],
    rows: engine.segmentRows.length ? engine.segmentRows.map(row => [String(row.engineEpoch), String(row.frameId), String(row.simulationTime), row.segment.linkId,
      `${row.segment.sourceName ?? '暂无'}:${row.segment.sourcePort ?? '暂无'}`, `${row.segment.targetName ?? '暂无'}:${row.segment.targetPort ?? '暂无'}`,
      String(row.segment.quality.gxbDb ?? '暂无'), String(row.segment.quality.ber ?? '暂无'), String(row.segment.quality.rxPowerDbm ?? '暂无'), String(row.segment.quality.rxPowerDbw ?? '暂无'), String(row.segment.losses.totalDb ?? '暂无')])
      : [['暂无接收到的链路段', '', '', '', '', '', '', '', '', '', '']],
  }, { title: '引擎链路段完整参数（源值）', columns: ['轮次/帧/时刻（秒）/段标识', '链路信息', '损耗明细', '通信参数', '干扰来源（计算输入）'],
    rows: engine.segmentRows.map(row => [`${row.engineEpoch}/${row.frameId}/${row.simulationTime}/${row.segment.linkId}`,
      ...engineSegmentDetails(row.segment).map(group => group.rows.map(([label, value]) => `${label}：${value}`).join('；'))]),
  }, { title: '引擎路由切换（仅已接收帧）', columns: ['轮次', '帧', '时刻（秒）', '方向', '旧路径', '新路径', '原因（段/原始原因）'],
    rows: engine.switchRows.length ? engine.switchRows.map(row => [String(row.engineEpoch), String(row.frameId), String(row.simulationTime), row.value.direction,
      row.value.oldPathId ?? '暂无', row.value.pathId, row.value.reasons.map(reason => `${reason.linkId ?? '暂无'}:${reason.reasons.join('|') || '暂无'}`).join('；') || '暂无'])
      : [['暂无接收到的路由切换', '', '', '', '', '', '']],
  }, { title: '引擎事件（仅已接收帧）', columns: ['轮次', '帧', '时刻（秒）', '类型', '路径', '无人机', '干扰设备'],
    rows: engine.eventRows.length ? engine.eventRows.map(row => [String(row.engineEpoch), String(row.frameId), String(row.simulationTime), row.value.type ?? '暂无', row.value.pathId ?? '暂无', row.value.uavNames.join('；') || '暂无', row.value.jammerNames.join('；') || '暂无'])
      : [['暂无接收到的引擎事件', '', '', '', '', '', '']],
  }, { title: '引擎归档缺源字段', columns: ['字段'], rows: engine.missingFieldNames.length ? engine.missingFieldNames.map(field => [field]) : [['无']] }]
  const engineCsvSections = engineCsv === undefined ? [] : [{ title: '引擎规范 CSV 生成状态', columns: ['文件', '状态', '已写入行数', '跳过行数', '原因'], rows: [
    ...engineCsv.files.map(file => [file.fileName, file.status, String(file.rowCount), String(file.skippedCount), file.reason ?? '无']),
    ...engineCsv.missing.map(file => [file.fileName, file.status, '0', '0', file.reason]),
  ] }]
  const sections = [{ title: '来源与范围', columns: ['项目', '值'], rows: metadata }, ...parameterSection, ...tables, ...engineSections, ...engineCsvSections]
  const eventRange = localReportChartRange(report.localEvidence, report.localEvidence.eventFile.fileName, filter)
  const positionRange = localReportChartRange(report.localEvidence, report.localEvidence.positionFile.fileName, filter)
  const qualityRange = localReportChartRange(report.localEvidence, quality?.dataset.source.fileName ?? '未导入质量数据', filter)
  const charts: Array<{ title: string; rows: Array<{ label: string; value: number; time?: number; breakBefore?: boolean }>; kind?: 'BAR' | 'LINE' | 'RADAR'; unit: string; sourceRange: string }> = [
    { title: '事件分类统计', unit: '条', sourceRange: eventRange, rows: report.localEvidence.eventCounts.map(row => ({ label: EVENT_LABELS[row.type] ?? row.type, value: row.count })) },
    { title: '节点位置记录数', unit: '条', sourceRange: positionRange, rows: report.localEvidence.nodes.map(node => ({ label: node.name, value: node.positionCount })) },
    ...(quality === undefined ? [] : quality.series.flatMap(series => [
      { title: `GXB 随时间变化 · ${series.linkId}`, kind: 'LINE' as const, sourceRange: qualityRange, unit: 'dB', rows: series.gxbCurve.map(point => ({ label: reportTime(point.time), time: point.time, value: point.value, breakBefore: point.breakBefore })) },
      { title: `误码率随时间变化 · ${series.linkId}`, kind: 'LINE' as const, sourceRange: qualityRange, unit: 'BER', rows: series.berCurve.map(point => ({ label: reportTime(point.time), time: point.time, value: point.value, breakBefore: point.breakBefore })) },
    ])),
    ...(engine === undefined ? [] : (() => {
      const groups = new Map<string, typeof engine.segmentRows>()
      for (const row of engine.segmentRows) {
        const identity = `${row.engineEpoch}:${row.segment.linkId}:${row.segment.sourceName ?? '暂无'}:${row.segment.sourcePort ?? '暂无'}→${row.segment.targetName ?? '暂无'}:${row.segment.targetPort ?? '暂无'}`
        const rows = groups.get(identity)
        if (rows) rows.push(row)
        else groups.set(identity, [row])
      }
      return [...groups.entries()].flatMap(([identity, rows]) => [
      ...(rows.some(row => row.segment.quality.gxbDb !== null) ? [{ title: `引擎段 GXB 随时间变化 · ${identity}`, kind: 'LINE' as const, sourceRange: `引擎帧归档 · SHA-256 ${engine.sourceSha256}`, unit: 'dB', rows: rows.filter(row => row.segment.quality.gxbDb !== null).map((row, index, values) => ({ label: reportTime(row.simulationTime), time: row.simulationTime, value: row.segment.quality.gxbDb!, breakBefore: index > 0 && row.frameId !== values[index - 1]!.frameId + ENGINE_FRAME_ID_STEP })) }] : []),
      ...(rows.some(row => row.segment.quality.ber !== null) ? [{ title: `引擎段 BER 随时间变化 · ${identity}`, kind: 'LINE' as const, sourceRange: `引擎帧归档 · SHA-256 ${engine.sourceSha256}`, unit: 'BER', rows: rows.filter(row => row.segment.quality.ber !== null).map((row, index, values) => ({ label: reportTime(row.simulationTime), time: row.simulationTime, value: row.segment.quality.ber!, breakBefore: index > 0 && row.frameId !== values[index - 1]!.frameId + ENGINE_FRAME_ID_STEP })) }] : []),
      ])
    })()),
    { title: '各链路有效观测区间连通率', kind: 'RADAR', unit: '%', sourceRange: qualityRange, rows: qualityConnectivityRates.map(row => ({ label: row.linkId, value: row.value })) },
  ]
  const scopedCharts = charts.map(chart => ({ ...chart, scope: `${chart.sourceRange}；单位：${chart.unit}；生成时刻：${report.generatedTime}` }))
  sections.push(...charts.filter(chart => chart.kind !== 'LINE').map(chart => ({
    title: `${chart.kind === 'RADAR' ? '雷达图' : '柱状图'}数据表：${chart.title}`,
    columns: ['标签', '数值', '单位', '数据范围', '生成时刻'],
    rows: chart.rows.length
      ? chart.rows.map(row => [row.label, String(row.value), chart.unit, chart.sourceRange, report.generatedTime])
      : [['暂无数据', '', chart.unit, chart.sourceRange, report.generatedTime]],
  })))
  const content = format === 'CSV'
    ? '\uFEFF' + [...notes.map(note => [note]), ...sections.flatMap(section => [[section.title], section.columns, ...section.rows, []])].map(row => row.map(csvCell).join(',')).join('\r\n')
    : format === 'PDF'
      ? await createLocalReportPdf({ title: '本地运行数据报告', notes, sections,
          charts: scopedCharts, chartScope: eventRange })
      : '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>本地运行数据报告</title><style>body{font-family:system-ui,sans-serif;margin:32px;color:#17212b}table{border-collapse:collapse;width:100%;margin-bottom:24px}td,th{border:1px solid #ccc;padding:8px;text-align:left;overflow-wrap:anywhere}th{background:#eef3f7}p{line-height:1.6}</style><h1>本地运行数据报告</h1>'
        + notes.map(note => `<p>${escapeHtml(note)}</p>`).join('') + scopedCharts.map(chart => chart.kind === 'LINE' ? reportCurveSvg(chart, chart.scope) : chart.kind === 'RADAR' ? reportRadarSvg(chart, chart.scope) : reportChartSvg(chart, chart.scope)).join('')
        + sections.map(section => `<h2>${escapeHtml(section.title)}</h2><table><thead><tr>${section.columns.map(text => `<th>${escapeHtml(text)}</th>`).join('')}</tr></thead><tbody>${section.rows.map(row => `<tr>${row.map(text => `<td>${escapeHtml(text)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('') + '</html>'
  const root = resolve(directory)
  await mkdir(root, { recursive: true })
  const owned = await mkdtemp(join(root, 'report-'))
  const filePath = join(owned, `${report.reportId}.${format.toLowerCase()}`)
  try {
    await writeFile(filePath, content, { ...(typeof content === 'string' ? { encoding: 'utf8' as const } : {}), flag: 'wx' })
    return { reportId: report.reportId, generated: true, status: 'SUCCESS', format, watermark, verifiedAt, filePath, sha256: createHash('sha256').update(content).digest('hex') }
  } catch (error) {
    await rm(owned, { recursive: true, force: true })
    throw error
  }
}

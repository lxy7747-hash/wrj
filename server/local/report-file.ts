import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { LocalReportEvidence, LocalReportExportResult, Report } from '../../src/contracts/domain-models.js'
import { isLocalReport, localReportTables } from '../../src/features/reports/local-report.js'
import { readAfsimLogFile, readLocalFileSnapshot } from './afsim-log-reader.js'
import { readLocalReplay } from './afsim-replay-reader.js'

/** 仅读取本机配置路径；摘要绑定原始文件，不把文件快照冒充场景或引擎运行编号。 */
export async function readLocalReport(eventPath: string | undefined, positionPath: string | undefined): Promise<Report | null> {
  if (!eventPath || !positionPath) return null
  const [replay, log] = await Promise.all([readLocalReplay(eventPath, positionPath), readAfsimLogFile(eventPath)])
  if (!log.valid || !log.summary.timeRange || log.source.sha256 !== replay.initial.sha256) throw new Error('事件文件快照不一致或无有效事件。')
  // 两份文件分别读取后再次比对，拒绝读到正在替换的文件；不修改源文件或回放游标。
  const latest = await Promise.all([readLocalFileSnapshot(eventPath), readLocalFileSnapshot(positionPath)])
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
  const digest = createHash('sha256').update(`local-report-v1:${log.source.sha256}:${replay.sha256}`).digest('hex')
  const report: Report = { reportId: `RPT-LOCAL-${digest}`, classification: 'LEVEL_II', generatedTime: new Date().toISOString(), status: 'READY', localEvidence: evidence }
  if (!isLocalReport(report)) throw new Error('报告统计或来源引用未闭合。')
  return report
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
// CSV 引号只防止分列，不防公式执行；所有以危险前缀开头的文本额外加单引号。
const csvCell = (value: string) => `"${(/^[\s]*[=+@-]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`

/** 创建独占导出目录，失败仅清理本次文件；不允许客户端提供路径或正文。 */
export async function exportLocalReport(directory: string, report: Report, format: 'HTML' | 'CSV', actor: string): Promise<LocalReportExportResult> {
  if (!isLocalReport(report) || !['HTML', 'CSV'].includes(format)) throw new Error('不支持的真实报告或导出格式。')
  const verifiedAt = new Date().toISOString()
  const watermark = `本地文件统计 · 二级 · 导出人 ${actor} · ${verifiedAt}`
  const tables = localReportTables(report.localEvidence)
  const notes = ['本报告只陈述文件记录；登记关联、设备启停、消息收发均不等于物理链路质量。', '没有 SNR、BER、接收功率或链路质量证据，不计算连通率、丢包率和干扰效果；不关联未经证实的场景/运行。']
  const metadata = [['报告编号', report.reportId], ['生成时刻', report.generatedTime], ['导出标记', watermark], ['事件文件', report.localEvidence.eventFile.fileName], ['事件文件 SHA-256', report.localEvidence.eventFile.sha256], ['位置文件', report.localEvidence.positionFile.fileName], ['位置文件 SHA-256', report.localEvidence.positionFile.sha256]]
  const sections = [{ title: '来源与范围', columns: ['项目', '值'], rows: metadata }, ...tables]
  const content = format === 'CSV'
    ? '\uFEFF' + [...notes.map(note => [note]), ...sections.flatMap(section => [[section.title], section.columns, ...section.rows, []])].map(row => row.map(csvCell).join(',')).join('\r\n')
    : '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>本地运行数据报告</title><style>body{font-family:system-ui,sans-serif;margin:32px;color:#17212b}table{border-collapse:collapse;width:100%;margin-bottom:24px}td,th{border:1px solid #ccc;padding:8px;text-align:left;overflow-wrap:anywhere}th{background:#eef3f7}p{line-height:1.6}</style><h1>本地运行数据报告</h1>'
      + notes.map(note => `<p>${escapeHtml(note)}</p>`).join('')
      + sections.map(section => `<h2>${escapeHtml(section.title)}</h2><table><thead><tr>${section.columns.map(text => `<th>${escapeHtml(text)}</th>`).join('')}</tr></thead><tbody>${section.rows.map(row => `<tr>${row.map(text => `<td>${escapeHtml(text)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('') + '</html>'
  const root = resolve(directory)
  await mkdir(root, { recursive: true })
  const owned = await mkdtemp(join(root, 'report-'))
  const filePath = join(owned, `${report.reportId}.${format.toLowerCase()}`)
  try {
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' })
    return { reportId: report.reportId, generated: true, status: 'SUCCESS', format, watermark, verifiedAt, filePath, sha256: createHash('sha256').update(content).digest('hex') }
  } catch (error) {
    await rm(owned, { recursive: true, force: true })
    throw error
  }
}

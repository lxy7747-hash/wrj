import type { LocalReportEvidence } from '../../src/contracts/domain-models.js'
import { EVENT_LABELS, reportTime } from '../../src/features/reports/local-report.js'

const KEY_EVENT_LIMIT = 20
const JAMMING_REQUESTS = new Set(['JAMMING_REQUEST_INITIATED', 'JAMMING_REQUEST_CANCELED'])
const JAMMING_AREA_EVENTS = new Map([
  ['into_detect', '进入探测圈'],
  ['into_jamm', '进入干扰圈'],
  ['release_jamm', '离开干扰圈'],
  ['release_detect', '离开探测圈'],
])

export function buildReportKeyEvents(evidence: LocalReportEvidence): {
  table: { title: string; columns: string[]; rows: string[][] }
  note: string
} {
  const archive = evidence.engineFrameArchive
  const quality = evidence.quality
  const names = new Map(evidence.nodes.map(node => [node.platformId, node.name]))
  const name = (id: string) => names.get(id) ?? id
  const inRange = (time: number) => time >= evidence.startTimeS && time <= evidence.endTimeS
  const rows: Array<{ time: number; cells: () => string[] }> = []
  function keep(time: number, cells: () => string[]): void {
    if (rows.length === KEY_EVENT_LIMIT && time >= rows[KEY_EVENT_LIMIT - 1]!.time) return
    const index = rows.findIndex(row => time < row.time)
    if (index < 0) rows.push({ time, cells })
    else rows.splice(index, 0, { time, cells })
    if (rows.length > KEY_EVENT_LIMIT) rows.pop()
  }

  let switchRows = 0
  let switchTotal: number | undefined
  const archiveIncomplete = Boolean(archive?.detailTruncated || archive?.detailDeferred)
  if (archive && (archive.aggregate || archive.switchRows.length)) {
    for (const { simulationTime: time, value } of archive.switchRows) {
      if (!inRange(time)) continue
      switchRows++
      keep(time, () => ['路径切换', value.direction === 'FORWARD' ? '前向' : '反向',
        `${value.oldPathId ?? '未记录'} → ${value.pathId}`, '引擎帧归档'])
    }
    switchTotal = archive.aggregate?.switchCount ?? (archiveIncomplete ? undefined : switchRows)
  } else if (quality && (quality.source.switchEventsProvided === true || quality.switchEvents.length)) {
    for (const event of quality.switchEvents) {
      if (event.decision !== 'ACCEPTED' || !inRange(event.time)) continue
      switchRows++
      keep(event.time, () => ['链路切换', event.direction === 'FORWARD' ? '前向' : '反向',
        `${event.oldLinkId} → ${event.newLinkId}`, quality.source.fileName])
    }
    switchTotal = switchRows
  } else if (evidence.switchEvents) {
    for (const event of evidence.switchEvents) {
      if (!inRange(event.time)) continue
      switchRows++
      keep(event.time, () => ['链路切换', event.demandId,
        `${event.fromLinkId ?? event.fromDeviceId} → ${event.toLinkId ?? event.toDeviceId}`, evidence.eventFile.fileName])
    }
    switchTotal = switchRows
  }

  let areaRows = 0
  for (const { simulationTime: time, value } of archive?.eventRows ?? []) {
    const label = value.type === null ? undefined : JAMMING_AREA_EVENTS.get(value.type)
    if (!label || !inRange(time)) continue
    areaRows++
    keep(time, () => [label, (value.uavIds.length ? value.uavIds.map(name) : value.uavNames).join('、') || '目标未记录',
      `干扰源 ${(value.jammerIds.length ? value.jammerIds.map(name) : value.jammerNames).join('、') || '未记录'}`, '引擎帧归档'])
  }

  let requestRows = 0
  for (const event of evidence.deviceEvents) {
    if (!JAMMING_REQUESTS.has(event.type) || !inRange(event.time)) continue
    requestRows++
    keep(event.time, () => [EVENT_LABELS[event.type]!, name(event.platformId), `${event.deviceId || '设备未记录'} · 已记录请求`, evidence.eventFile.fileName])
  }
  const requestTotal = evidence.eventCounts.reduce((sum, item) => sum + (JAMMING_REQUESTS.has(item.type) ? item.count : 0), 0)

  const observed = switchRows + areaRows + requestRows
  const switchNote = switchTotal === undefined
    ? switchRows ? `已保留切换 ${switchRows} 条，总数未提供` : '切换记录未提供'
    : `切换 ${switchTotal} 条`
  const totals = [switchNote, requestTotal < requestRows ? `已保留干扰请求 ${requestRows} 条，总数未提供` : `干扰请求 ${requestTotal} 条`]
  if (archive?.eventRows.length || archiveIncomplete) totals.push(`干扰圈事件${archiveIncomplete ? '已保留' : ''} ${areaRows} 条`)
  const notes = [`统计范围 ${reportTime(evidence.startTimeS)}～${reportTime(evidence.endTimeS)}。${totals.join('，')}。`,
    observed > KEY_EVENT_LIMIT ? `按时刻展示已保留明细中的前 ${KEY_EVENT_LIMIT} 条。` : `展示已保留明细 ${rows.length} 条。`]
  if (archiveIncomplete || (switchTotal ?? 0) > switchRows || requestTotal > requestRows) notes.push('所选范围内部分事件缺少明细。')
  if (requestTotal || requestRows || areaRows) notes.push('干扰请求与干扰圈事件为来源记录，设备实际启停未确认。')
  return {
    table: { title: '关键事件', columns: ['时刻', '事件', '对象', '结果', '来源'], rows: rows.map(row => [reportTime(row.time), ...row.cells()]) },
    note: notes.join(''),
  }
}

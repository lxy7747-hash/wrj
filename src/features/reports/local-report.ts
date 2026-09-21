import type { LocalReportEvidence, LocalReportExportResult, Report } from '../../contracts/domain-models'

const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
function object(v: unknown, keys: string[]): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key))
}

/** 本机报告不借用 Mock 的运行号、质量指标或时序点；全部子集合在边界闭合校验。 */
export function isLocalReport(value: unknown): value is Report & { localEvidence: LocalReportEvidence } {
  if (!object(value, ['reportId', 'classification', 'generatedTime', 'status', 'localEvidence'])
    || typeof value.reportId !== 'string' || !/^RPT-LOCAL-[a-f0-9]{64}$/.test(value.reportId)
    || value.classification !== 'LEVEL_II' || value.status !== 'READY'
    || !text(value.generatedTime) || !Number.isFinite(Date.parse(value.generatedTime))) return false
  const e = value.localEvidence
  if (!object(e, ['eventFile', 'positionFile', 'startTimeS', 'endTimeS', 'simulationComplete', 'positionCount', 'positionIssueCount', 'waitingForPositionLine', 'eventCount', 'eventWarningCount', 'nodes', 'eventCounts', 'connections', 'deviceEvents'])
    || ![e.eventFile, e.positionFile].every(file => object(file, ['fileName', 'sha256']) && text(file.fileName) && hash(file.sha256))
    || !time(e.startTimeS) || !time(e.endTimeS) || e.startTimeS > e.endTimeS
    || ![e.positionCount, e.positionIssueCount, e.eventCount, e.eventWarningCount].every(count)
    || typeof e.simulationComplete !== 'boolean' || typeof e.waitingForPositionLine !== 'boolean'
    || !Array.isArray(e.nodes) || !e.nodes.length || !Array.isArray(e.eventCounts)
    || !Array.isArray(e.connections) || !Array.isArray(e.deviceEvents)) return false
  const inRange = (v: unknown) => time(v) && v >= Number(e.startTimeS) && v <= Number(e.endTimeS)
  const ids = new Set<string>()
  let positions = 0
  for (const node of e.nodes) {
    if (!object(node, ['platformId', 'name', 'type', 'side', 'positionCount', 'firstTimeS', 'lastTimeS'])
      || ![node.platformId, node.name, node.type, node.side].every(text) || ids.has(String(node.platformId))
      || !count(node.positionCount) || !inRange(node.firstTimeS) || !inRange(node.lastTimeS)
      || Number(node.firstTimeS) > Number(node.lastTimeS)) return false
    ids.add(String(node.platformId))
    positions += node.positionCount
  }
  if (positions !== e.positionCount) return false
  const types = new Map<string, number>()
  for (const row of e.eventCounts) {
    if (!object(row, ['type', 'count']) || !text(row.type) || !count(row.count) || row.count === 0 || types.has(row.type)) return false
    types.set(row.type, row.count)
  }
  if ([...types.values()].reduce((sum, n) => sum + n, 0) !== e.eventCount) return false
  const seen = new Set<string>()
  for (const row of e.connections) {
    if (!object(row, ['eventId', 'time', 'scope', 'sourcePlatformId', 'sourceDeviceId', 'targetPlatformId', 'targetDeviceId'])
      || !text(row.eventId) || seen.has(row.eventId) || !inRange(row.time)
      || !['INTERNAL', 'INTER_PLATFORM'].includes(String(row.scope)) || typeof row.scope !== 'string'
      || !ids.has(String(row.sourcePlatformId)) || typeof row.sourcePlatformId !== 'string'
      || !ids.has(String(row.targetPlatformId)) || typeof row.targetPlatformId !== 'string'
      || !text(row.sourceDeviceId) || !text(row.targetDeviceId)) return false
    seen.add(row.eventId)
  }
  for (const row of e.deviceEvents) {
    if (!object(row, ['eventId', 'type', 'time', 'platformId', 'deviceId']) || !text(row.eventId) || seen.has(row.eventId)
      || !text(row.type) || !types.has(row.type) || !inRange(row.time)
      || !text(row.platformId) || !ids.has(row.platformId) || !text(row.deviceId)) return false
    seen.add(row.eventId)
  }
  return true
}

export function isLocalReportExport(value: unknown): value is LocalReportExportResult {
  return object(value, ['reportId', 'generated', 'status', 'format', 'watermark', 'verifiedAt', 'filePath', 'sha256'])
    && typeof value.reportId === 'string' && /^RPT-LOCAL-[a-f0-9]{64}$/.test(value.reportId)
    && value.generated === true && value.status === 'SUCCESS' && (value.format === 'HTML' || value.format === 'CSV')
    && text(value.watermark) && text(value.verifiedAt) && Number.isFinite(Date.parse(value.verifiedAt))
    && text(value.filePath) && hash(value.sha256)
}

/** 报表时间只作分钟/秒显示，不改写接口秒数。 */
export function reportTime(seconds: number): string {
  const rounded = Math.round(seconds * 1000) / 1000
  return `${Math.floor(rounded / 60)}分${Number((rounded % 60).toFixed(3))}秒`
}

export const EVENT_LABELS: Record<string, string> = {
  COMM_TURNED_ON: '通信设备开启', COMM_TURNED_OFF: '通信设备关闭',
  WEAPON_TURNED_ON: '干扰设备开启', WEAPON_TURNED_OFF: '干扰设备关闭',
  WEAPON_MODE_ACTIVATED: '设备模式启用', WEAPON_MODE_DEACTIVATED: '设备模式停用',
  JAMMING_REQUEST_INITIATED: '干扰请求发起', JAMMING_REQUEST_UPDATED: '干扰请求更新', JAMMING_REQUEST_CANCELED: '干扰请求取消',
  MESSAGE_TRANSMITTED: '消息发送记录', MESSAGE_RECEIVED: '消息接收记录', MESSAGE_HOP: '消息转发记录',
  PLATFORM_ADDED: '平台登记', PLATFORM_DELETED: '平台退出', PLATFORM_INITIALIZED: '平台初始化',
  LINK_ADDED_TO_MANAGER: '通信关联登记', SIMULATION_STARTING: '仿真开始', SIMULATION_COMPLETE: '仿真结束', MOVER_TURNED_ON: '运动器开启',
}

/** 展示和导出使用同一组表格，避免导出重新计算或混入其他报告。 */
export function localReportTables(e: LocalReportEvidence): Array<{ title: string; columns: string[]; rows: string[][] }> {
  const names = new Map(e.nodes.map(node => [node.platformId, node.name]))
  const name = (id: string) => `${names.get(id) ?? id}（${id}）`
  const events = new Map(e.eventCounts.map(row => [row.type, row.count]))
  return [
    { title: '汇总', columns: ['统计项', '结果'], rows: [
      ['统计范围', `${reportTime(e.startTimeS)}～${reportTime(e.endTimeS)}`], ['结束事件', e.simulationComplete ? '已记录' : '未记录（当前快照）'],
      ['登记节点', String(e.nodes.length)], ['有效位置记录', String(e.positionCount)], ['跳过的位置异常记录', String(e.positionIssueCount)],
      ['位置文件尾部未完成行', e.waitingForPositionLine ? '有，未纳入统计' : '无'], ['事件记录', String(e.eventCount)], ['事件解析警告', String(e.eventWarningCount)],
      ['通信关联登记记录（包含平台内部关联）', String(e.connections.length)],
      ['消息发送记录', String(events.get('MESSAGE_TRANSMITTED') ?? 0)], ['消息接收记录', String(events.get('MESSAGE_RECEIVED') ?? 0)],
      ['通信设备关闭记录', String(events.get('COMM_TURNED_OFF') ?? 0)], ['干扰请求发起记录', String(events.get('JAMMING_REQUEST_INITIATED') ?? 0)],
      ['SNR / BER / 连通率 / 干扰效果', '暂无数据'],
    ] },
    { title: '节点与位置', columns: ['节点', '类型', '阵营原值', '位置记录数', '首条位置时刻', '末条位置时刻'], rows: e.nodes.map(node => [name(node.platformId), node.type, node.side, String(node.positionCount), node.positionCount ? reportTime(node.firstTimeS) : '无位置记录', node.positionCount ? reportTime(node.lastTimeS) : '无位置记录']) },
    { title: '通信关联登记', columns: ['事件编号', '登记时刻', '范围', '发送端', '发送设备', '接收端', '接收设备'], rows: e.connections.map(row => [row.eventId, reportTime(row.time), row.scope === 'INTERNAL' ? '平台内部' : '跨平台', name(row.sourcePlatformId), row.sourceDeviceId, name(row.targetPlatformId), row.targetDeviceId]) },
    { title: '设备与干扰请求', columns: ['事件编号', '时刻', '事件', '平台', '设备'], rows: e.deviceEvents.map(row => [row.eventId, reportTime(row.time), `${EVENT_LABELS[row.type] ?? row.type}（${row.type}）`, name(row.platformId), row.deviceId]) },
    { title: '事件分类', columns: ['事件', '原始类型', '记录数'], rows: e.eventCounts.map(row => [EVENT_LABELS[row.type] ?? row.type, row.type, String(row.count)]) },
  ]
}

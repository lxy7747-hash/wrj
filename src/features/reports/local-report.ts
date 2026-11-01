import type { LocalQualityKpis, LocalReportEvidence, LocalReportExportResult, LocalReportFilter, LocalSwitchEvent, Report } from '../../contracts/domain-models'
import { isDetectionEvent } from './detection-events'

/** 共享纯校验，Mock 服务无需导入本机文件索引适配器。 */
export function parseLocalReportFilter(value: unknown): LocalReportFilter | null {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>, allowed = ['nodeId', 'linkId', 'stage', 'from', 'to']
  const validText = (key: string) => item[key] === undefined || (typeof item[key] === 'string' && item[key].trim().length > 0 && item[key].length <= 200)
  const validTime = (key: string) => item[key] === undefined || (typeof item[key] === 'number' && Number.isFinite(item[key]) && item[key] >= 0)
  if (Object.keys(item).some(key => !allowed.includes(key)) || !['nodeId', 'linkId', 'stage'].every(validText)
    || !['from', 'to'].every(validTime) || (typeof item.from === 'number' && typeof item.to === 'number' && item.from > item.to)) return null
  return { ...(typeof item.nodeId === 'string' ? { nodeId: item.nodeId } : {}), ...(typeof item.linkId === 'string' ? { linkId: item.linkId } : {}), ...(typeof item.stage === 'string' ? { stage: item.stage } : {}),
    ...(typeof item.from === 'number' ? { from: item.from } : {}), ...(typeof item.to === 'number' ? { to: item.to } : {}) }
}

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
  const e = value.localEvidence as Partial<LocalReportEvidence>
  const evidenceKeys = ['eventFile', 'positionFile', 'startTimeS', 'endTimeS', 'simulationComplete', 'positionCount', 'positionIssueCount', 'waitingForPositionLine', 'eventCount', 'eventWarningCount', 'nodes', 'eventCounts', 'connections', 'deviceEvents']
  const optionalEvidenceKeys = ['messageDetailsComplete', 'messageDetailEventCount', 'relatedNodeIds', 'detectionEvents', 'switchEvents', 'qualityKpis']
  if (!e || typeof e !== 'object' || Array.isArray(e) || !evidenceKeys.every(key => Object.hasOwn(e, key))
    || !Object.keys(e).every(key => evidenceKeys.includes(key) || optionalEvidenceKeys.includes(key))
    || ![e.eventFile, e.positionFile].every(file => object(file, ['fileName', 'sha256']) && text(file.fileName) && hash(file.sha256))
    || !time(e.startTimeS) || !time(e.endTimeS) || e.startTimeS > e.endTimeS
    || ![e.positionCount, e.positionIssueCount, e.eventCount, e.eventWarningCount].every(count)
    || typeof e.simulationComplete !== 'boolean' || typeof e.waitingForPositionLine !== 'boolean'
    || !Array.isArray(e.nodes) || !e.nodes.length || !Array.isArray(e.eventCounts)
    || !Array.isArray(e.connections) || !Array.isArray(e.deviceEvents)
    || (e.messageDetailsComplete !== undefined && typeof e.messageDetailsComplete !== 'boolean')
    || (e.messageDetailEventCount !== undefined && !count(e.messageDetailEventCount))
    || (e.messageDetailsComplete === false && e.messageDetailEventCount === undefined)
    || (e.relatedNodeIds !== undefined && (!Array.isArray(e.relatedNodeIds) || e.relatedNodeIds.some(id => !text(id))))) return false
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
  const related = new Set(e.relatedNodeIds ?? [])
  if ([...related].some(id => ids.has(id))) return false
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
      || !(ids.has(String(row.sourcePlatformId)) || related.has(String(row.sourcePlatformId))) || typeof row.sourcePlatformId !== 'string'
      || !(ids.has(String(row.targetPlatformId)) || related.has(String(row.targetPlatformId))) || typeof row.targetPlatformId !== 'string'
      || !text(row.sourceDeviceId) || !text(row.targetDeviceId)) return false
    seen.add(row.eventId)
  }
  for (const row of e.deviceEvents) {
    if (!object(row, ['eventId', 'type', 'time', 'platformId', 'deviceId']) || !text(row.eventId) || seen.has(row.eventId)
      || !text(row.type) || !types.has(row.type) || !inRange(row.time)
      || !text(row.platformId) || !ids.has(row.platformId) || !text(row.deviceId)) return false
    seen.add(row.eventId)
  }
  if (e.detectionEvents !== undefined) {
    if (!Array.isArray(e.detectionEvents)) return false
    for (const row of e.detectionEvents) {
      if (!isDetectionEvent(row, ids) || seen.has(row.eventId) || !types.has(row.type) || !inRange(row.time)) return false
      seen.add(row.eventId)
    }
  }
  if (e.switchEvents !== undefined) {
    if (!Array.isArray(e.switchEvents)) return false
    for (const row of e.switchEvents) {
      if (!isSwitchEvent(row) || seen.has(row.eventId) || !inRange(row.time)) return false
      seen.add(row.eventId)
    }
  }
  if (e.qualityKpis !== undefined && !isQualityKpis(e.qualityKpis)) return false
  return true
}

const SWITCH_EVENT_KEYS = ['eventId', 'time', 'demandId', 'ruleId', 'fromDeviceId', 'toDeviceId', 'fromLinkId', 'toLinkId', 'stableChecks']
function isSwitchEvent(value: unknown): value is LocalSwitchEvent {
  if (!object(value, SWITCH_EVENT_KEYS)) return false
  const nullableText = (v: unknown) => v === null || text(v)
  return text(value.eventId) && time(value.time) && text(value.demandId) && nullableText(value.ruleId)
    && text(value.fromDeviceId) && text(value.toDeviceId) && nullableText(value.fromLinkId) && nullableText(value.toLinkId)
    && (value.stableChecks === null || (Number.isSafeInteger(value.stableChecks) && Number(value.stableChecks) >= 0))
}

const KPI_KEYS = ['averageConnectedDurationS', 'averageJsrDb', 'averageBer', 'jammingDurationS'] as const
function isQualityKpis(value: unknown): value is LocalQualityKpis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (!Object.keys(row).every(key => (KPI_KEYS as readonly string[]).includes(key))) return false
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  return (row.averageConnectedDurationS === undefined || (finite(row.averageConnectedDurationS) && Number(row.averageConnectedDurationS) >= 0))
    && (row.averageJsrDb === undefined || finite(row.averageJsrDb))
    && (row.averageBer === undefined || (finite(row.averageBer) && Number(row.averageBer) >= 0 && Number(row.averageBer) <= 1))
    && (row.jammingDurationS === undefined || (finite(row.jammingDurationS) && Number(row.jammingDurationS) >= 0))
}

export function isLocalReportExport(value: unknown): value is LocalReportExportResult {
  return object(value, ['reportId', 'generated', 'status', 'format', 'watermark', 'verifiedAt', 'filePath', 'sha256'])
    && typeof value.reportId === 'string' && /^RPT-LOCAL-[a-f0-9]{64}$/.test(value.reportId)
    && value.generated === true && value.status === 'SUCCESS' && (value.format === 'HTML' || value.format === 'PDF' || value.format === 'CSV')
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
  SENSOR_DETECTION_CHANGED: '侦测状态变化', SENSOR_TRACK_INITIATED: '侦测航迹建立', SENSOR_TRACK_UPDATED: '侦测航迹更新', SENSOR_TRACK_DROPPED: '侦测航迹丢失',
}

const NO_DATA = '暂无数据'

/** 频段以 MHz 展示；源文件未提供时显示“暂无数据”，不补默认值。 */
function detectionBand(min: number | null, max: number | null): string {
  if (min === null && max === null) return NO_DATA
  const mhz = (hz: number | null) => hz === null ? '?' : String(Number((hz / 1e6).toFixed(6)))
  return `${mhz(min)}～${mhz(max)} MHz`
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
      ['逐消息回放明细', e.messageDetailsComplete === false ? `未装入快照（${e.messageDetailEventCount} 条消息已计入分类统计和来源摘要）` : '完整'],
      ['通信关联登记明细（包含平台内部关联）', String(e.connections.length)],
      ['消息发送记录', String(events.get('MESSAGE_TRANSMITTED') ?? 0)], ['消息接收记录', String(events.get('MESSAGE_RECEIVED') ?? 0)],
      ['通信设备关闭记录', String(events.get('COMM_TURNED_OFF') ?? 0)], ['干扰请求发起记录', String(events.get('JAMMING_REQUEST_INITIATED') ?? 0)],
      // 大纲评估指标：有引擎质量/干扰输出时填写，缺省显示“暂无数据”。切换次数来自切换事件，未解析到时同样显示暂无数据。
      ['平均连通时长', kpi(e.qualityKpis?.averageConnectedDurationS, value => reportTime(value))],
      ['切换次数', e.switchEvents === undefined ? NO_DATA : String(e.switchEvents.length)],
      ['平均干信比', kpi(e.qualityKpis?.averageJsrDb, value => `${value.toFixed(2)} dB`)],
      ['平均误码率', kpi(e.qualityKpis?.averageBer, value => value.toExponential(2))],
      ['干扰持续时长', kpi(e.qualityKpis?.jammingDurationS, value => reportTime(value))],
    ] },
    { title: '节点与位置', columns: ['节点', '类型', '阵营原值', '位置记录数', '首条位置时刻', '末条位置时刻'], rows: e.nodes.map(node => [name(node.platformId), node.type, node.side, String(node.positionCount), node.positionCount ? reportTime(node.firstTimeS) : '无位置记录', node.positionCount ? reportTime(node.lastTimeS) : '无位置记录']) },
    { title: '通信关联登记', columns: ['事件编号', '登记时刻', '范围', '发送端', '发送设备', '接收端', '接收设备'], rows: e.connections.map(row => [row.eventId, reportTime(row.time), row.scope === 'INTERNAL' ? '平台内部' : '跨平台', name(row.sourcePlatformId), row.sourceDeviceId, name(row.targetPlatformId), row.targetDeviceId]) },
    { title: '设备与干扰请求', columns: ['事件编号', '时刻', '事件', '平台', '设备'], rows: e.deviceEvents.map(row => [row.eventId, reportTime(row.time), `${EVENT_LABELS[row.type] ?? row.type}（${row.type}）`, name(row.platformId), row.deviceId]) },
    { title: '事件分类', columns: ['事件', '原始类型', '记录数'], rows: e.eventCounts.map(row => [EVENT_LABELS[row.type] ?? row.type, row.type, String(row.count)]) },
    { title: 'ESM 侦测事件', columns: ['事件编号', '时刻', '事件', '侦测平台', '传感器', '目标', '频段', '概率', '结论'],
      rows: (e.detectionEvents ?? []).map(row => [row.eventId, reportTime(row.time), EVENT_LABELS[row.type] ?? row.type, name(row.platformId), row.sensorId,
        row.targetPlatformId === null ? NO_DATA : name(row.targetPlatformId), detectionBand(row.frequencyMinHz, row.frequencyMaxHz),
        row.probability === null ? NO_DATA : row.probability.toFixed(3), row.detected === null ? NO_DATA : row.detected ? '侦测到目标' : '未侦测到目标']) },
    { title: '链路切换事件', columns: ['事件编号', '时刻', '业务', '规则', '原链路', '新链路', '稳定次数'],
      rows: (e.switchEvents ?? []).map(row => [row.eventId, reportTime(row.time), row.demandId, row.ruleId ?? NO_DATA,
        row.fromLinkId ?? row.fromDeviceId, row.toLinkId ?? row.toDeviceId, row.stableChecks === null ? NO_DATA : String(row.stableChecks)]) },
  ]
}

function kpi(value: number | undefined, format: (value: number) => string): string {
  return typeof value === 'number' && Number.isFinite(value) ? format(value) : NO_DATA
}

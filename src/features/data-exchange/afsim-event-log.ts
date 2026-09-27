import { parseCsvLine } from './csv-contract'

/** 事件日志的原始字段；保留单位、消息编号和 DataTag 的文本精度。 */
export interface AfsimLogEvent {
  id: string
  time: number
  type: string
  sourceLine: number
  endLine: number
  subject: string
  fields: Record<string, string>
  /** 未识别或无效记录保留原文，避免解析失败后无法追溯。 */
  unparsedText?: string
}

export interface AfsimInitialState {
  time: number
  sourceEventId: string
  longitude: number
  latitude: number
  altitudeMeters: number
  headingDegrees: number
  pitchDegrees: number
  rollDegrees: number
  speedMetersPerSecond: number
}

export interface AfsimLogNode {
  name: string
  type: string
  side: string
  createdAt: number
  sourceEventId: string
  initialState: AfsimInitialState | null
}

export interface AfsimCommunicationSystem {
  platformName: string
  name: string
  type: string
  enabledAt: number
  sourceEventId: string
}

export interface AfsimConnectionEndpoint {
  platformName: string
  communicationName: string
  address: string
}

/** 连接登记记录，不代表物理链路可用性；保留方向与登记时间，不合并反向记录。 */
export interface AfsimConnectionRecord {
  sourceEventId: string
  time: number
  scope: 'INTERNAL' | 'INTER_PLATFORM'
  source: AfsimConnectionEndpoint
  target: AfsimConnectionEndpoint
}

export interface AfsimLogIssue {
  severity: 'ERROR' | 'WARNING'
  line: number
  message: string
  rawText?: string
}

/** 独立的日志解析结果，不冒充含质量指标和计算证据的 TelemetryFrame。 */
export interface AfsimEventLog {
  schemaVersion: 'afsim-event-log/1'
  valid: boolean
  nodes: AfsimLogNode[]
  communicationSystems: AfsimCommunicationSystem[]
  connections: AfsimConnectionRecord[]
  events: AfsimLogEvent[]
  issues: AfsimLogIssue[]
  summary: {
    eventCount: number
    eventCounts: Record<string, number>
    timeRange: { start: number; end: number } | null
    simulationComplete: boolean
    internalConnectionCount: number
    interPlatformConnectionCount: number
    errorCount: number
    warningCount: number
  }
}

interface LogBlock { timeText: string; type: string; line: number; endLine: number; headerText: string; lines: string[]; csvFields?: Record<string, string> }

/**
 * WEAPON_TURNED_ON/OFF 的 CSV 字段声明漏写了 x、y、z 三列，导致数据行比声明多 11 列且姿态列整体错位
 * （真实数据中 heading 位置实际落在 ECI 的 x 分量 -2.47850191e+06）。这两类事件允许出现未声明的
 * 扩展列，并且只校验 alt 及其之前的字段；heading 起的姿态字段一律不读，避免把坐标当成角度。
 */
const MISALIGNED_DECLARATION = new Set(['WEAPON_TURNED_ON', 'WEAPON_TURNED_OFF'])

const REQUIRED_FIELDS: Record<string, string[]> = {
  PLATFORM_ADDED: ['Type', 'Side'],
  PLATFORM_DELETED: ['Type', 'Side'],
  MOVER_TURNED_ON: ['Mover', 'Type', 'LLA', 'Heading', 'Pitch', 'Roll', 'Speed'],
  COMM_TURNED_ON: ['Comm', 'Type'],
  COMM_TURNED_OFF: ['Comm', 'Type'],
  LINK_ADDED_TO_MANAGER: ['linked to'],
  SIMULATION_STARTING: ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second'],
  SIMULATION_COMPLETE: ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second'],
  MESSAGE_TRANSMITTED: ['System', 'Number', 'DataTag', 'Type', 'Size'],
  MESSAGE_HOP: ['System', 'Number', 'DataTag', 'Type', 'Size', 'Destination'],
  MESSAGE_RECEIVED: ['System', 'Number', 'DataTag', 'Type', 'Size'],
  // 干扰请求只校验身份与请求数字段；频率和带宽的数值有效性由 buildFileDeviceEvents 判定。
  JAMMING_REQUEST_INITIATED: ['weapon', 'current_mode', 'active_requests_(eM_Xmtrs)'],
  JAMMING_REQUEST_UPDATED: ['weapon', 'current_mode', 'active_requests_(eM_Xmtrs)'],
  JAMMING_REQUEST_CANCELED: ['weapon', 'current_mode', 'active_requests_(eM_Xmtrs)'],
  WEAPON_MODE_ACTIVATED: ['weapon', 'mode'],
  WEAPON_MODE_DEACTIVATED: ['weapon', 'mode'],
  // 只登记身份字段；声明错位点之后的姿态列一律不校验、不读取。几何字段存在时由真实数据冒烟比对位置文件。
  WEAPON_TURNED_ON: ['type', 'system_platform', 'system_type'],
  WEAPON_TURNED_OFF: ['type', 'system_platform', 'system_type'],
}

/** 将 token 的度分秒转换为经纬度；axis 限定方向及合法范围，非法值不做纠正。 */
function parseCoordinate(token: string, axis: 'latitude' | 'longitude'): number {
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)([nsew])$/i.exec(token)
  if (!match) throw new Error('经纬度必须为带方向的度分秒格式。')
  const [, degrees, minutes, seconds, directionText] = match
  const direction = directionText!.toLowerCase()
  const allowed = axis === 'latitude' ? 'ns' : 'ew'
  const absolute = Number(degrees) + Number(minutes) / 60 + Number(seconds) / 3600
  if (!allowed.includes(direction) || Number(minutes) >= 60 || Number(seconds) >= 60
    || !Number.isFinite(absolute) || absolute > (axis === 'latitude' ? 90 : 180)) {
    throw new Error('经纬度的方向或度分秒范围不正确。')
  }
  return absolute * ('sw'.includes(direction) ? -1 : 1)
}

/** 读取带单位的数值；text 为原始字段，unit 为日志明确给出的单位，不猜测单位转换。 */
function readUnitNumber(text: string, unit: string): number {
  const parts = text.trim().split(/\s+/)
  const value = Number(parts[0])
  if (parts.length !== 2 || parts[1] !== unit || !Number.isFinite(value)) {
    throw new Error(`数值或单位不正确，预期单位为 ${unit}。`)
  }
  return value
}

/** 从运动器开启事件提取初始状态，保留真实位置，不推算后续轨迹。 */
function readInitialState(event: AfsimLogEvent, csv = false): AfsimInitialState {
  const fields = event.fields
  if (csv) {
    const number = (key: string, min = -Infinity, max = Infinity) => {
      const value = Number(fields[key])
      if (!fields[key]?.trim() || !Number.isFinite(value) || value < min || value > max) throw new Error(`字段 ${key} 必须为范围内的有限数值。`)
      return value
    }
    // AFSIM 事件 CSV 的姿态为弧度，位置 CSV 的 HEADING 为度；原始字段仍原样保留。
    return { time: event.time, sourceEventId: event.id,
      latitude: number('lat', -90, 90), longitude: number('lon', -180, 180), altitudeMeters: number('alt'),
      headingDegrees: number('heading') * 180 / Math.PI, pitchDegrees: number('pitch') * 180 / Math.PI,
      rollDegrees: number('roll') * 180 / Math.PI, speedMetersPerSecond: number('ned_speed', 0) }
  }
  const lla = fields.LLA!.split(/\s+/)
  if (lla.length !== 4) throw new Error('LLA 必须包含纬度、经度、高度及米制单位。')
  const speed = readUnitNumber(fields.Speed!.split('*')[0]!.trim(), 'm/s')
  if (speed < 0) throw new Error('速度不能为负数。')
  return {
    time: event.time,
    sourceEventId: event.id,
    latitude: parseCoordinate(lla[0]!, 'latitude'),
    longitude: parseCoordinate(lla[1]!, 'longitude'),
    altitudeMeters: readUnitNumber(lla.slice(2).join(' '), 'm'),
    headingDegrees: readUnitNumber(fields.Heading!, 'deg'),
    pitchDegrees: readUnitNumber(fields.Pitch!, 'deg'),
    rollDegrees: readUnitNumber(fields.Roll!, 'deg'),
    speedMetersPerSecond: speed,
  }
}

/** 拆解连接端点的“平台 设备 地址”，地址仅作为源数据保留，不发起网络访问。 */
function readEndpoint(text: string): AfsimConnectionEndpoint {
  const parts = text.trim().split(/\s+/)
  if (parts.length !== 3) throw new Error('连接端点必须包含平台名称、通信设备名称和地址。')
  return { platformName: parts[0]!, communicationName: parts[1]!, address: parts[2]! }
}

/**
 * 解析已完整读取的 AFSIM 事件文本。
 * @param text 旧版多行事件文本或包含 ! 事件字段声明的 CSV 全文。
 * @returns 节点、设备、连接登记、事件及带源行号的问题清单。
 * @remarks ponytail: 本阶段只处理完整文件快照，不负责监听、增量分帧或仿真指标推算。
 */
export function parseAfsimEventLog(text: string): AfsimEventLog {
  const events: AfsimLogEvent[] = []
  const issues: AfsimLogIssue[] = []
  const nodes = new Map<string, AfsimLogNode>()
  const systems = new Map<string, AfsimCommunicationSystem>()
  const initialStates = new Map<string, AfsimInitialState>()
  const connections: AfsimConnectionRecord[] = []
  let block: LogBlock | null = null
  let previousTime = -Infinity
  const csvSchemas = new Map<string, string[]>()

  /** CSV 按各事件声明取列，不按统一表头猜测；空的尾部扩展列不产生业务数据。 */
  function readCsvRecord(line: string, lineNumber: number): void {
    try {
      const cells = parseCsvLine(line)?.map(cell => cell.trim())
      if (!cells) throw new Error('CSV 引号未闭合。')
      if (line.startsWith('!')) {
        const type = cells[0]!.slice(1).trim()
        const columns = cells.slice(1).map(cell => {
          const match = /^(.+)<[^<>]+>$/.exec(cell)
          if (!match) throw new Error('CSV 事件字段声明格式不正确。')
          return match[1]!
        })
        // LINK_* 等声明省略公共 time/event 两列，但数据行始终包含这两列。
        if (columns[0] !== 'time') columns.unshift('time', 'event')
        if (!/^[A-Z][A-Z_0-9]*$/.test(type) || columns[1] !== 'event'
          || (type !== 'MESSAGE_HOP' && new Set(columns).size !== columns.length)
          || csvSchemas.has(type)) throw new Error('CSV 事件声明重复或字段不唯一。')
        // MESSAGE_HOP 声明拼接了外层接收信息和内层消息；重复列加序号，避免覆盖外层证据。
        const counts = new Map<string, number>()
        columns.forEach((key, index) => {
          const count = (counts.get(key) ?? 0) + 1
          counts.set(key, count)
          if (count > 1) columns[index] = `${key}#${count}`
        })
        csvSchemas.set(type, columns)
        return
      }
      const type = cells[1] ?? ''
      const columns = csvSchemas.get(type)
      if (!columns) throw new Error(`CSV 事件 ${type} 缺少字段声明。`)
      if (!cells[0]) throw new Error('仿真时间不能为空。')
      const fields: Record<string, string> = Object.create(null)
      columns.forEach((key, index) => { fields[key] = cells[index] ?? '' })
      // 消息记录可能比声明多出空的可选尾列；未知非空扩展不得静默丢弃。
      const extra = cells.slice(columns.length)
      if (extra.some(Boolean)) {
        fields.csvExtraColumns = JSON.stringify(extra)
        // 已知声明缺列的事件，扩展列属于来源缺陷而不是解析错误，仍需原样保留。
        if ((Object.hasOwn(REQUIRED_FIELDS, type) && !MISALIGNED_DECLARATION.has(type))
          || type === 'PLATFORM_INITIALIZED') throw new Error('CSV 事件含未声明的非空字段。')
      }
      const aliases: Record<string, string> = { Type: 'type', Side: 'side', Comm: 'system', Mover: 'system',
        System: 'comm', Number: 'message_serial_number', DataTag: 'data_tag',
        Year: 'year', Month: 'month', Day: 'day', Hour: 'hour', Minute: 'minute', Second: 'second' }
      // COMM_TURNED_ON/OFF 的 Type 列承载设备类型（system_type），Comm 列承载设备名称（system）。
      if (type === 'COMM_TURNED_ON' || type === 'COMM_TURNED_OFF' || type === 'MOVER_TURNED_ON') aliases.Type = 'system_type'
      if (type.startsWith('MESSAGE_')) aliases.Type = 'message_type'
      if (type === 'MESSAGE_HOP') { aliases.System = 'receiver_system'; aliases.Destination = 'destination' }
      for (const [key, source] of Object.entries(aliases)) if (fields[source] !== undefined) fields[key] = fields[source]!
      if (fields.message_size?.trim()) fields.Size = `${fields.message_size} bits`
      block = { timeText: cells[0]!, type, line: lineNumber, endLine: lineNumber, headerText: line,
        lines: [fields.receiver ?? fields.platform ?? fields.source_platform ?? ''], csvFields: fields }
      finishBlock()
    } catch (error) {
      issues.push({ severity: 'ERROR', line: lineNumber, rawText: line,
        message: error instanceof Error ? error.message : 'CSV 事件解析失败。' })
    }
  }

  /** 提交一个多行事件，原始事件与派生实体共享源事件标识；无效记录不得生成实体。 */
  function finishBlock(): void {
    if (!block) return
    const current = block
    block = null
    const time = Number(current.timeText)
    const rawText = [current.headerText, ...current.lines.slice(1)].join('\n')
    if (!Number.isFinite(time) || time < 0) {
      issues.push({ severity: 'ERROR', line: current.line, message: '仿真时间必须为非负有限数值。', rawText })
      return
    }
    const body = current.lines.map((line) => line.trim().replace(/\\$/, '').trim()).join(' ')
    const labels = [...body.matchAll(/\b(linked to|[A-Za-z_][A-Za-z0-9_]*):\s*/g)]
    const fields: Record<string, string> = current.csvFields ?? Object.create(null)
    const event: AfsimLogEvent = {
      id: `LOG-L${current.line}`, time, type: current.type,
      sourceLine: current.line, endLine: current.endLine,
      subject: current.csvFields ? current.lines[0]! : body.slice(0, labels[0]?.index ?? body.length).trim(), fields,
    }
    events.push(event)
    if (time < previousTime) issues.push({ severity: 'WARNING', line: current.line, message: '事件时间倒退，结果仍保留源文件顺序。' })
    previousTime = time
    try {
      if (!current.csvFields) labels.forEach((label, index) => {
        const key = label[1]!
        if (Object.hasOwn(fields, key)) throw new Error(`字段 ${key} 在同一事件中重复。`)
        fields[key] = body.slice(label.index! + label[0].length, labels[index + 1]?.index ?? body.length).trim()
      })
      const required = current.csvFields && (event.type === 'MOVER_TURNED_ON' || event.type === 'PLATFORM_INITIALIZED')
        ? ['lat', 'lon', 'alt', 'heading', 'pitch', 'roll', 'ned_speed']
        : current.csvFields && event.type === 'LINK_ADDED_TO_MANAGER'
          ? ['source_platform', 'source_comm', 'source_address', 'destination_platform', 'destination_comm', 'destination_address']
          : REQUIRED_FIELDS[event.type]
      if (!required) {
        event.unparsedText = rawText
        issues.push({ severity: 'WARNING', line: current.line, message: `未识别事件类型 ${event.type}，已保留原始内容。` })
        return
      }
      for (const key of required) {
        // 引擎允许平台不设置阵营；CSV 声明的空 side 是缺省值，不是丢失字段。
        if (key === 'Side' && current.csvFields && fields.side === '') continue
        if (!fields[key]) throw new Error(`事件缺少字段 ${key}。`)
      }
      if (!event.type.startsWith('SIMULATION_') && event.subject === '') throw new Error('事件缺少主体名称。')
      if (event.type.startsWith('MESSAGE_')) {
        if (!/^\d+$/.test(fields.Number!) || !/^\d+ bits$/.test(fields.Size!)) {
          throw new Error('消息编号或消息大小格式不正确。')
        }
        // 消息编号和 DataTag 是标识，不转成浮点数，也不据此推算误码率、带宽或时延。
      } else if (event.type.startsWith('SIMULATION_')) {
        for (const key of REQUIRED_FIELDS[event.type]!) {
          if (!Number.isFinite(Number(fields[key]))) throw new Error(`仿真日期字段 ${key} 必须为数值。`)
        }
        // 日期不含时区，保留源字段，不强行转换为 UTC。
      } else if (event.type === 'PLATFORM_ADDED') {
        if (nodes.has(event.subject)) throw new Error(`平台 ${event.subject} 重复创建。`)
        nodes.set(event.subject, {
          name: event.subject, type: fields.Type!, side: fields.Side!,
          createdAt: time, sourceEventId: event.id, initialState: null,
        })
      } else if (event.type === 'MOVER_TURNED_ON' || (current.csvFields && event.type === 'PLATFORM_INITIALIZED')) {
        const state = readInitialState(event, Boolean(current.csvFields))
        const previous = initialStates.get(event.subject)
        if (!previous || time < previous.time) initialStates.set(event.subject, state)
      } else if (event.type === 'COMM_TURNED_ON') {
        const key = JSON.stringify([event.subject, fields.Comm])
        const previous = systems.get(key)
        if (previous && previous.type !== fields.Type) throw new Error('同一通信设备出现不同类型。')
        if (!previous || time < previous.enabledAt) systems.set(key, {
          platformName: event.subject, name: fields.Comm!, type: fields.Type!, enabledAt: time, sourceEventId: event.id,
        })
      } else if (event.type === 'LINK_ADDED_TO_MANAGER') {
        const source = current.csvFields
          ? { platformName: fields.source_platform!, communicationName: fields.source_comm!, address: fields.source_address! }
          : readEndpoint(event.subject)
        const target = current.csvFields
          ? { platformName: fields.destination_platform!, communicationName: fields.destination_comm!, address: fields.destination_address! }
          : readEndpoint(fields['linked to']!)
        connections.push({ sourceEventId: event.id, time, source, target,
          scope: source.platformName === target.platformName ? 'INTERNAL' : 'INTER_PLATFORM' })
      }
    } catch (error) {
      event.unparsedText = rawText
      issues.push({ severity: 'ERROR', line: current.line, message: error instanceof Error ? error.message : '事件解析失败。' })
    }
  }

  text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).forEach((line, index) => {
    if (!line.trim()) return
    if (line.trimStart().startsWith('!') || /^\s*[^,\s]+,/.test(line)) {
      finishBlock()
      readCsvRecord(line.trim(), index + 1)
      return
    }
    const header = /^(\S+)\s+([A-Z][A-Z_0-9]*)\b(?:\s+(.*))?$/.exec(line.trim())
    if (header) {
      finishBlock()
      block = { timeText: header[1]!, type: header[2]!, line: index + 1, endLine: index + 1,
        headerText: line, lines: [header[3] ?? ''] }
    } else if (block && /^\s*(?:LLA|Speed):/.test(line)) {
      block.lines.push(line)
      block.endLine = index + 1
    } else {
      issues.push({ severity: 'ERROR', line: index + 1, message: '无法识别事件行或孤立续行，已保留原文。', rawText: line })
    }
  })
  finishBlock()

  for (const node of nodes.values()) {
    node.initialState = initialStates.get(node.name) ?? null
    if (!node.initialState) issues.push({ severity: 'WARNING', line: Number(node.sourceEventId.slice(5)), message: `平台 ${node.name} 缺少初始位置，不使用默认坐标补齐。` })
  }
  for (const [name, state] of initialStates) {
    if (!nodes.has(name)) issues.push({ severity: 'WARNING', line: Number(state.sourceEventId.slice(5)), message: `位置记录的平台 ${name} 未声明，不自动创建节点。` })
  }
  for (const system of systems.values()) {
    if (!nodes.has(system.platformName)) issues.push({ severity: 'WARNING', line: Number(system.sourceEventId.slice(5)), message: `通信设备所属平台 ${system.platformName} 未声明。` })
  }
  for (const connection of connections) {
    for (const endpoint of [connection.source, connection.target]) {
      if (!nodes.has(endpoint.platformName) || !systems.has(JSON.stringify([endpoint.platformName, endpoint.communicationName]))) {
        issues.push({ severity: 'WARNING', line: Number(connection.sourceEventId.slice(5)), message: `连接端点 ${endpoint.platformName}.${endpoint.communicationName} 缺少平台或设备声明。` })
      }
    }
  }
  if (events.length === 0) issues.push({ severity: 'ERROR', line: 1, message: '文件中没有可解析的事件。' })
  const eventCounts: Record<string, number> = Object.create(null)
  let start = Infinity
  let end = -Infinity
  for (const event of events) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1
    start = Math.min(start, event.time)
    end = Math.max(end, event.time)
  }
  const errorCount = issues.filter((issue) => issue.severity === 'ERROR').length
  return {
    schemaVersion: 'afsim-event-log/1', valid: errorCount === 0,
    nodes: [...nodes.values()], communicationSystems: [...systems.values()], connections, events, issues,
    summary: {
      eventCount: events.length, eventCounts,
      timeRange: events.length ? { start, end } : null,
      simulationComplete: events.some((event) => event.type === 'SIMULATION_COMPLETE' && !event.unparsedText),
      internalConnectionCount: connections.filter((connection) => connection.scope === 'INTERNAL').length,
      interPlatformConnectionCount: connections.filter((connection) => connection.scope === 'INTER_PLATFORM').length,
      errorCount, warningCount: issues.length - errorCount,
    },
  }
}

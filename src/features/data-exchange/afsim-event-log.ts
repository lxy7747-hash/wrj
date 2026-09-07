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

interface LogBlock { timeText: string; type: string; line: number; endLine: number; headerText: string; lines: string[] }

const REQUIRED_FIELDS: Record<string, string[]> = {
  PLATFORM_ADDED: ['Type', 'Side'],
  MOVER_TURNED_ON: ['Mover', 'Type', 'LLA', 'Heading', 'Pitch', 'Roll', 'Speed'],
  COMM_TURNED_ON: ['Comm', 'Type'],
  LINK_ADDED_TO_MANAGER: ['linked to'],
  SIMULATION_STARTING: ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second'],
  SIMULATION_COMPLETE: ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second'],
  MESSAGE_TRANSMITTED: ['System', 'Number', 'DataTag', 'Type', 'Size'],
  MESSAGE_HOP: ['System', 'Number', 'DataTag', 'Type', 'Size', 'Destination'],
  MESSAGE_RECEIVED: ['System', 'Number', 'DataTag', 'Type', 'Size'],
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
function readInitialState(event: AfsimLogEvent): AfsimInitialState {
  const fields = event.fields
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
 * @param text 日志全文（虽然扩展名可能为 CSV，内容仍按事件和续行解析）。
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
    const fields: Record<string, string> = Object.create(null)
    const event: AfsimLogEvent = {
      id: `LOG-L${current.line}`, time, type: current.type,
      sourceLine: current.line, endLine: current.endLine,
      subject: body.slice(0, labels[0]?.index ?? body.length).trim(), fields,
    }
    events.push(event)
    if (time < previousTime) issues.push({ severity: 'WARNING', line: current.line, message: '事件时间倒退，结果仍保留源文件顺序。' })
    previousTime = time
    try {
      labels.forEach((label, index) => {
        const key = label[1]!
        if (Object.hasOwn(fields, key)) throw new Error(`字段 ${key} 在同一事件中重复。`)
        fields[key] = body.slice(label.index! + label[0].length, labels[index + 1]?.index ?? body.length).trim()
      })
      if (!Object.hasOwn(REQUIRED_FIELDS, event.type)) {
        event.unparsedText = rawText
        issues.push({ severity: 'WARNING', line: current.line, message: `未识别事件类型 ${event.type}，已保留原始内容。` })
        return
      }
      for (const key of REQUIRED_FIELDS[event.type]!) {
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
      } else if (event.type === 'MOVER_TURNED_ON') {
        const state = readInitialState(event)
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
        const source = readEndpoint(event.subject)
        const target = readEndpoint(fields['linked to']!)
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

import { toScenarioLog } from './engine-name-mapping.js'
import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { parseAfsimEventLog, type AfsimEventLog } from '../../src/features/data-exchange/afsim-event-log.js'
import { parseCsvLine } from '../../src/features/data-exchange/csv-contract.js'
import { isInitialNodeSnapshot, type InitialNodeSnapshot } from '../../src/features/situation/initial-nodes.js'
import { FILE_COMMUNICATION_LABELS, fileConnectionTypes, type FileCommunicationConnection, type FileCommunicationType } from '../../src/features/situation/file-communication-links.js'
import { buildFileDeviceEvents } from '../../src/features/situation/file-device-events.js'
import { buildFileMessageLinks } from '../../src/features/situation/file-message-links.js'
import { buildFilePlatformDeletions } from '../../src/features/situation/platform-lifecycle.js'

// 仅作界面显示别名；位置、事件及连接仍使用日志中的原始平台名称关联。
const PLATFORM_DISPLAY_NAMES = new Map([
  ['rear_comm_vehicle', '后方通信车'],
  ['command_vehicle', '指挥车'],
  ['tiantong_sat', '天通卫星'],
  ['shentong_sat', '神通卫星'],
  ['mission_uav_01', '无人机01'],
  ['mission_uav_02', '无人机02'],
  ['mission_uav_03', '无人机03'],
  ['jammer_station_01', '地面干扰站01'],
  ['jammer_airborne_01', '机载干扰平台01'],
])

/** 完整内存快照仍服务于小文件和旧调用方；较大原始文件走逐行稳定读取。 */
const FULL_SNAPSHOT_LIMIT_BYTES = 32 * 1024 * 1024
const STREAM_SOURCE_LIMIT_BYTES = 256 * 1024 * 1024
const STREAM_MAX_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
const STREAM_CHUNK_BYTES = 64 * 1024
const STREAM_LINE_LIMIT_BYTES = 128 * 1024
const STREAM_METADATA_LIMIT_BYTES = 16 * 1024 * 1024
const DECLARATION_LIMIT_BYTES = 256 * 1024
const MESSAGE_BATCH_LIMIT_BYTES = 1024 * 1024

export interface StableTextSource {
  source: { fileName: string; path: string; bytes: number; sha256: string }
  waitingForLine: boolean
}

/**
 * 在文件身份、长度和修改时间保持不变时才提交逐行读取结果。回调只看到已换行的 UTF-8 文本，
 * 因此大文件不会被复制成一个 Buffer 或字符串；未完成尾行由调用者明确决定是否接受。
 */
export async function readStableUtf8Lines(
  inputPath: string, onLine: (line: string, lineNumber: number) => void | Promise<void>, maxBytes = STREAM_SOURCE_LIMIT_BYTES,
): Promise<StableTextSource> {
  const sourcePath = resolve(inputPath)
  const handle = await open(sourcePath, 'r')
  let waitingForLine = false
  const digest = createHash('sha256')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('输入路径必须为普通文件。')
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > STREAM_MAX_LIMIT_BYTES) throw new Error('流式读取上限无效。')
    if (before.size > BigInt(maxBytes)) throw new Error(`原始文件超过受保护流式读取上限 ${maxBytes / 1024 / 1024} MiB。`)
    const size = Number(before.size)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let pending = ''
    let lineNumber = 0
    let offset = 0
    while (offset < size) {
      const bytes = new Uint8Array(Math.min(STREAM_CHUNK_BYTES, size - offset))
      const result = await handle.read(bytes, 0, bytes.length, offset)
      if (result.bytesRead === 0) throw new Error('文件在读取期间被截断，请在写入稳定后重试。')
      const chunk = bytes.subarray(0, result.bytesRead)
      digest.update(chunk)
      offset += result.bytesRead
      try { pending += decoder.decode(chunk, { stream: true }) } catch { throw new Error('文件不是有效的 UTF-8 文本，请确认文件编码。') }
      let breakAt = pending.indexOf('\n')
      while (breakAt >= 0) {
        const line = pending.slice(0, breakAt).replace(/\r$/, '')
        pending = pending.slice(breakAt + 1)
        if (Buffer.byteLength(line, 'utf8') > STREAM_LINE_LIMIT_BYTES) throw new Error('文件含超过 128 KiB 的单行记录，拒绝不受控解析。')
        lineNumber += 1
        await onLine(line, lineNumber)
        breakAt = pending.indexOf('\n')
      }
      if (Buffer.byteLength(pending, 'utf8') > STREAM_LINE_LIMIT_BYTES) throw new Error('文件含超过 128 KiB 的未完成记录，拒绝不受控解析。')
    }
    try { pending += decoder.decode() } catch { throw new Error('文件末尾不是完整 UTF-8 文本。') }
    waitingForLine = pending.length > 0
    const after = await stat(sourcePath, { bigint: true })
    if (!sameFileVersion(before, after)) throw new Error('文件在读取期间发生变化，请在写入稳定后重试。')
    return { source: { fileName: basename(sourcePath), path: sourcePath, bytes: size, sha256: digest.digest('hex') }, waitingForLine }
  } finally { await handle.close() }
}

type FileVersionStat = Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs'>

/**
 * 判断读取前（句柄）与读取后（路径）是否为同一文件的同一版本。
 * @remarks 部分 Node 版本在 Windows 上按路径 stat 返回 dev=0，而句柄 stat 返回实际卷序列号；
 * 只有两侧都提供设备号时才比较 dev，替换/改写仍由 inode、长度和纳秒级 mtime/ctime 判定。
 */
export function sameFileVersion(before: FileVersionStat, after: FileVersionStat): boolean {
  if (before.dev !== 0n && after.dev !== 0n && before.dev !== after.dev) return false
  return before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}

/** 大文件只需来源校验时逐块求摘要，不在内存中保留原始字节。 */
export async function readLocalFileDigest(inputPath: string): Promise<StableTextSource> {
  return readStableUtf8Lines(inputPath, () => undefined)
}

async function fileVersion(path: string): Promise<string> {
  const info = await stat(path, { bigint: true })
  if (!info.isFile()) throw new Error('输入路径必须为普通文件。')
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs].join(':')
}

// ponytail: 单机只缓存最近一个初始日志快照；多日志并用时再改为有界 LRU。
let initialCache: { path: string; version: string; pending: Promise<InitialNodeSnapshot> } | undefined

/**
 * 有界只读加载指定日志；拒绝读取过程中变化的文件，不启动监听或写回源文件。
 * @param inputPath 本机启动配置或命令行明确指定的文件路径，不来自 HTTP 参数。
 */
export async function readLocalFileSnapshot(inputPath: string) {
  const sourcePath = resolve(inputPath)
  const handle = await open(sourcePath, 'r')
  let bytes: Buffer
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('输入路径必须为普通文件。')
    if (before.size > BigInt(FULL_SNAPSHOT_LIMIT_BYTES)) throw new Error('当前完整文件解析上限为 32 MiB；请使用流式读取接口。')
    bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (chunk.bytesRead === 0) throw new Error('文件在读取期间被截断，请在写入稳定后重试。')
      offset += chunk.bytesRead
    }
    const after = await stat(sourcePath, { bigint: true })
    if (!sameFileVersion(before, after)) {
      throw new Error('文件在读取期间发生变化，请在写入稳定后重试。')
    }
  } finally {
    await handle.close()
  }
  return {
    source: { fileName: basename(sourcePath), path: sourcePath, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') },
    bytes,
  }
}

/** 只读解析 AFSIM 事件日志；inputPath 为本机配置或命令行明确指定的路径。 */
export async function readAfsimLogFile(inputPath: string, names?: Map<string, string>) {
  const info = await stat(resolve(inputPath), { bigint: true })
  if (info.size > BigInt(FULL_SNAPSHOT_LIMIT_BYTES)) return toScenarioLog(names, await readLargeAfsimLogFile(inputPath))
  const { source, bytes } = await readLocalFileSnapshot(inputPath)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('日志不是有效的 UTF-8 文本，请确认文件编码。')
  }
  return {
    source,
    ...toScenarioLog(names, parseAfsimEventLog(text)),
  }
}

/**
 * 对大量消息事件做分批语法验证与计数，只保留报告/态势所需的非消息元数据。消息明细仍由任务的
 * 连续 events.csv 留存，不把数十万条消息复制进结果快照。非消息元数据超过固定上限时拒绝发布，
 * 防止“看似完整”的截断报告。
 */
async function readLargeAfsimLogFile(inputPath: string) {
  const declarations = new Map<string, { text: string; line: number }>()
  const emittedDeclarations = new Set<string>()
  const metadata: string[] = []
  const metadataLineNumbers: number[] = []
  let metadataBytes = 0
  let declarationBytes = 0
  let nativeMessageBlock = false
  let messageEventCount = 0
  const messageCounts = new Map<string, number>()
  const messageIssues: Array<{ severity: 'WARNING'; line: number; message: string; rawText?: string }> = []
  let messageStart = Infinity
  let messageEnd = -Infinity
  let pendingMessageBytes = 0
  const messageBatches = new Map<string, { rows: Array<{ text: string; line: number }>; bytes: number }>()

  const appendMetadata = (line: string, lineNumber: number) => {
    metadataBytes += Buffer.byteLength(line, 'utf8') + 1
    if (metadataBytes > STREAM_METADATA_LIMIT_BYTES) throw new Error('非消息事件元数据超过 16 MiB 受保护上限，拒绝生成不完整报告。')
    metadata.push(line)
    metadataLineNumbers.push(lineNumber)
  }
  const flushMessageBatch = (type: string) => {
    const batch = messageBatches.get(type)
    if (!batch || batch.rows.length === 0) return
    const declaration = declarations.get(type)
    if (!declaration) throw new Error(`消息事件 ${type} 缺少字段声明。`)
    const parsed = parseAfsimEventLog(`${declaration.text}\n${batch.rows.map(row => row.text).join('\n')}`)
    if (!parsed.valid || parsed.events.length !== batch.rows.length || parsed.events.some(event => event.type !== type)) {
      throw new Error(`消息事件 ${type} 解析失败，拒绝用计数替代原始记录。`)
    }
    for (const issue of parsed.issues) {
      if (issue.severity !== 'WARNING') continue
      const sourceLine = issue.line === 1 ? declaration.line : batch.rows[issue.line - 2]?.line
      if (!sourceLine) throw new Error(`消息事件 ${type} 的诊断行号无法映射回来源。`)
      messageIssues.push({ severity: 'WARNING', line: sourceLine, message: issue.message,
        ...(issue.rawText === undefined ? {} : { rawText: issue.rawText }) })
    }
    for (const event of parsed.events) {
      messageEventCount += 1
      messageCounts.set(type, (messageCounts.get(type) ?? 0) + 1)
      messageStart = Math.min(messageStart, event.time)
      messageEnd = Math.max(messageEnd, event.time)
    }
    pendingMessageBytes -= batch.bytes
    batch.rows = []
    batch.bytes = 0
  }
  const flushAllMessageBatches = () => { for (const type of messageBatches.keys()) flushMessageBatch(type) }
  const validateDeclaration = (text: string) => {
    const cells = parseCsvLine(text)?.map(cell => cell.trim())
    if (!cells || !cells[0]?.startsWith('!')) throw new Error('CSV 事件字段声明格式不正确。')
    const type = cells[0].slice(1).trim()
    const columns = cells.slice(1).map(cell => {
      const match = /^(.+)<[^<>]+>$/.exec(cell)
      if (!match) throw new Error('CSV 事件字段声明格式不正确。')
      return match[1]!
    })
    if (columns[0] !== 'time') columns.unshift('time', 'event')
    if (!/^[A-Z][A-Z_0-9]*$/.test(type) || columns[1] !== 'event'
      || (type !== 'MESSAGE_HOP' && new Set(columns).size !== columns.length)) throw new Error('CSV 事件声明重复或字段不唯一。')
    return type
  }
  const source = await readStableUtf8Lines(inputPath, async (line, lineNumber) => {
    const trimmed = line.trim()
    if (!trimmed) return
    if (trimmed.startsWith('!')) {
      const type = validateDeclaration(trimmed)
      if (declarations.has(type)) throw new Error(`CSV 事件 ${type} 字段声明重复。`)
      declarationBytes += Buffer.byteLength(trimmed, 'utf8') + 1
      if (declarationBytes > DECLARATION_LIMIT_BYTES) throw new Error('CSV 事件字段声明超过 256 KiB 受保护上限。')
      declarations.set(type, { text: trimmed, line: lineNumber })
      nativeMessageBlock = false
      return
    }
    const columns = parseCsvLine(trimmed)
    if (columns && columns.length >= 2) {
      const type = columns[1]?.trim() ?? ''
      if (!type) throw new Error('CSV 事件类型为空。')
      nativeMessageBlock = false
      if (type.startsWith('MESSAGE_')) {
        const batch = messageBatches.get(type) ?? { rows: [], bytes: 0 }
        const bytes = Buffer.byteLength(trimmed, 'utf8') + 1
        batch.rows.push({ text: trimmed, line: lineNumber }); batch.bytes += bytes; pendingMessageBytes += bytes
        messageBatches.set(type, batch)
        if (batch.bytes >= MESSAGE_BATCH_LIMIT_BYTES || pendingMessageBytes >= MESSAGE_BATCH_LIMIT_BYTES) flushAllMessageBatches()
      } else {
        const declaration = declarations.get(type)
        if (!declaration) throw new Error(`CSV 事件 ${type} 缺少字段声明。`)
        if (!emittedDeclarations.has(type)) { appendMetadata(declaration.text, declaration.line); emittedDeclarations.add(type) }
        appendMetadata(trimmed, lineNumber)
      }
      return
    }
    const header = /^(\S+)\s+([A-Z][A-Z_0-9]*)\b/.exec(trimmed)
    if (header) {
      nativeMessageBlock = header[2]!.startsWith('MESSAGE_')
      if (!nativeMessageBlock) appendMetadata(line, lineNumber)
      else {
        // 原生多行消息可能带任意扩展续行；不校验就汇总会掩盖损坏。大体量运行要求引擎输出 CSV。
        throw new Error('超过 32 MiB 的原生多行消息日志暂不支持；请使用 AFSIM CSV 事件输出以生成可验证报告。')
      }
      return
    }
    if (!nativeMessageBlock) appendMetadata(line, lineNumber)
  })
  if (source.waitingForLine) throw new Error('日志含未换行的尾部记录，拒绝将其当作完整仿真结果。')
  flushAllMessageBatches()
  const parsed = parseAfsimEventLog(metadata.join('\n'))
  if (!parsed.valid) throw new Error('日志解析失败，请先检查来源行号。')
  const sourceLine = (line: number) => {
    const mapped = metadataLineNumbers[line - 1]
    if (!mapped) throw new Error('压缩元数据的诊断行号无法映射回来源。')
    return mapped
  }
  const sourceEventId = (id: string) => /^LOG-L\d+$/.test(id) ? `LOG-L${sourceLine(Number(id.slice(5)))}` : id
  for (const event of parsed.events) {
    event.sourceLine = sourceLine(event.sourceLine); event.endLine = sourceLine(event.endLine); event.id = sourceEventId(event.id)
  }
  for (const node of parsed.nodes) {
    node.sourceEventId = sourceEventId(node.sourceEventId)
    if (node.initialState) node.initialState.sourceEventId = sourceEventId(node.initialState.sourceEventId)
  }
  for (const system of parsed.communicationSystems) system.sourceEventId = sourceEventId(system.sourceEventId)
  for (const connection of parsed.connections) connection.sourceEventId = sourceEventId(connection.sourceEventId)
  parsed.issues = [...parsed.issues.map(issue => ({ ...issue, line: sourceLine(issue.line) })), ...messageIssues]
  const eventCounts = { ...parsed.summary.eventCounts }
  for (const [type, count] of messageCounts) eventCounts[type] = (eventCounts[type] ?? 0) + count
  const times = [parsed.summary.timeRange?.start, parsed.summary.timeRange?.end, messageStart, messageEnd].filter((value): value is number => Number.isFinite(value))
  return {
    source: source.source,
    ...parsed,
    // 报告统计仍使用全量消息数；调用方必须把 false 透传到回放/界面，不能将空 messageLinks 当成全量动画。
    messageDetailsComplete: false,
    messageDetailEventCount: messageEventCount,
    summary: {
      ...parsed.summary,
      eventCount: parsed.summary.eventCount + messageEventCount,
      eventCounts,
      timeRange: times.length ? { start: Math.min(...times), end: Math.max(...times) } : null,
      warningCount: parsed.issues.filter(issue => issue.severity === 'WARNING').length,
    },
  }
}

/**
 * 提取每个平台的首个位置供地图初始化，不暴露本机路径，不补造遥测帧。
 * @param inputPath 本机配置的事件日志路径。
 */
export async function readInitialNodes(inputPath: string, names?: Map<string, string>, displayNames?: Map<string, string>): Promise<InitialNodeSnapshot> {
  if (names) return loadInitialNodes(inputPath, names, displayNames)
  const path = resolve(inputPath)
  const version = await fileVersion(path)
  if (initialCache?.path !== path || initialCache.version !== version) {
    const pending = loadInitialNodes(path).then(async snapshot => {
      if (await fileVersion(path) !== version) throw new Error('文件在读取期间发生变化，请在写入稳定后重试。')
      return snapshot
    })
    const entry = { path, version, pending }
    initialCache = entry
    void pending.catch(() => { if (initialCache === entry) initialCache = undefined })
  }
  const snapshot = await initialCache.pending
  if (await fileVersion(path) !== version) throw new Error('文件在读取期间发生变化，请在写入稳定后重试。')
  return structuredClone(snapshot)
}

async function loadInitialNodes(inputPath: string, names?: Map<string, string>, displayNames?: Map<string, string>): Promise<InitialNodeSnapshot> {
  const parsed = await readAfsimLogFile(inputPath, names)
  if (!parsed.valid) throw new Error('日志解析失败，请先检查来源行号。')
  const nodes = parsed.nodes.map((node) => {
    const state = node.initialState
    if (!state) throw new Error('日志中有节点缺少初始位置。')
    return { platformId: node.name, name: displayNames?.get(node.name) ?? PLATFORM_DISPLAY_NAMES.get(node.name) ?? node.name, type: node.type,
      ...(node.side ? { side: node.side } : {}),
      longitude: state.longitude, latitude: state.latitude,
      altitude: state.altitudeMeters, speed: state.speedMetersPerSecond,
      time: state.time, sourceEventId: state.sourceEventId }
  })
  const systems = new Map(parsed.communicationSystems.map(system => [JSON.stringify([system.platformName, system.name]), system.type]))
  const connections = resolveManifestConnections(parsed)
  const deviceEvents = buildFileDeviceEvents(parsed.events, new Set(nodes.map(node => node.platformId)))
  // 业务链路在服务端推导：浏览器不接触原始事件，且 systems 的键与设备类型索引同形。
  const messageLinks = buildFileMessageLinks(parsed.events, new Set(nodes.map(node => node.platformId)), systems).links
  const platformDeletions = buildFilePlatformDeletions(parsed.events, new Set(nodes.map(node => node.platformId)))
  const incompleteMessages = 'messageDetailsComplete' in parsed && parsed.messageDetailsComplete === false
  const snapshot = { fileName: parsed.source.fileName, sha256: parsed.source.sha256, nodes, connections, deviceEvents, messageLinks, platformDeletions,
    ...(incompleteMessages ? { messageDetailsComplete: false, messageDetailEventCount: parsed.messageDetailEventCount } : {}) }
  if (!isInitialNodeSnapshot(snapshot)) throw new Error('日志初始位置为空或格式不正确。')
  return snapshot
}

const platformPortKey = (platformId: string, portId: string) => JSON.stringify([platformId, portId])
const connectionKey = (sourcePlatformId: string, sourcePortId: string, targetPlatformId: string, targetPortId: string) => JSON.stringify([
  platformPortKey(sourcePlatformId, sourcePortId), platformPortKey(targetPlatformId, targetPortId),
])
const knownConnectionType = (value: unknown): value is FileCommunicationType => typeof value === 'string' && Object.hasOwn(FILE_COMMUNICATION_LABELS, value)

/**
 * 把事件中的连接注册转换为可显示的连接记录。新模板端口按事件里的系统类型和端口名分类；
 * 已归档的通用射频记录，只有当可选的 manifest 中完整的“平台 + 端口”端点对恰好对应一种链路类型时，
 * 才由 manifest 补充类型。归档设备编号视为不透明标识，不改写，也不按文本推断类型。
 */
export function resolveManifestConnections(parsed: Pick<AfsimEventLog, 'communicationSystems' | 'connections'>, manifestDevices?: unknown): FileCommunicationConnection[] {
  const systems = new Map(parsed.communicationSystems.map(system => [platformPortKey(system.platformName, system.name), system.type]))
  const manifestTypes = new Map<string, Set<FileCommunicationType>>()
  const bind = (source: { platformId: string; deviceId: string }, target: { platformId: string; deviceId: string }, type: FileCommunicationType) => {
    for (const key of [connectionKey(source.platformId, source.deviceId, target.platformId, target.deviceId), connectionKey(target.platformId, target.deviceId, source.platformId, source.deviceId)]) {
      const current = manifestTypes.get(key) ?? new Set<FileCommunicationType>(); current.add(type); manifestTypes.set(key, current)
    }
  }
  if (Array.isArray(manifestDevices)) for (const raw of manifestDevices) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>, type = item.linkType
    const source = item.source as Record<string, unknown> | undefined, target = item.target as Record<string, unknown> | undefined
    if (!knownConnectionType(type) || !source || !target || typeof source.platformId !== 'string' || typeof source.deviceId !== 'string' || typeof target.platformId !== 'string' || typeof target.deviceId !== 'string') continue
    const relay = typeof item.relayPlatformId === 'string' && typeof item.relayDeviceId === 'string'
      ? { platformId: item.relayPlatformId, deviceId: item.relayDeviceId }
      : undefined
    if (relay) { bind(source as { platformId: string; deviceId: string }, relay, type); bind(relay, target as { platformId: string; deviceId: string }, type) }
    else {
      const legacyRelay = item.relay as Record<string, unknown> | undefined
      if (legacyRelay && typeof legacyRelay.platformId === 'string' && typeof legacyRelay.ingressDeviceId === 'string' && typeof legacyRelay.egressDeviceId === 'string') {
        bind(source as { platformId: string; deviceId: string }, { platformId: legacyRelay.platformId, deviceId: legacyRelay.ingressDeviceId }, type)
        bind({ platformId: legacyRelay.platformId, deviceId: legacyRelay.egressDeviceId }, target as { platformId: string; deviceId: string }, type)
      } else bind(source as { platformId: string; deviceId: string }, target as { platformId: string; deviceId: string }, type)
    }
  }
  const connections: FileCommunicationConnection[] = []
  for (const record of parsed.connections) {
    if (record.scope !== 'INTER_PLATFORM') continue
    const sourceType = systems.get(platformPortKey(record.source.platformName, record.source.communicationName))
    const targetType = systems.get(platformPortKey(record.target.platformName, record.target.communicationName))
    if (!sourceType || !targetType) continue
    const connection = { ...record, sourceType, targetType }
    if (fileConnectionTypes(connection).length) { connections.push(connection); continue }
    const resolved = manifestTypes.get(connectionKey(record.source.platformName, record.source.communicationName, record.target.platformName, record.target.communicationName))
    if (resolved?.size === 1) {
      const mapped = { ...connection, resolvedType: [...resolved][0]! } as FileCommunicationConnection
      if (fileConnectionTypes(mapped).length) connections.push(mapped)
    }
  }
  return connections
}

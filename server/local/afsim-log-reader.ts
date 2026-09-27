import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log.js'
import { isInitialNodeSnapshot, type InitialNodeSnapshot } from '../../src/features/situation/initial-nodes.js'
import { fileConnectionTypes, type FileCommunicationConnection } from '../../src/features/situation/file-communication-links.js'
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
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('输入路径必须为普通文件。')
    // ponytail: 完整快照暂限 32 MiB；接入持续增长的大日志时再增加流式读取。
    if (before.size > 32 * 1024 * 1024) throw new Error('当前完整文件解析上限为 32 MiB。')
    bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (chunk.bytesRead === 0) throw new Error('文件在读取期间被截断，请在写入稳定后重试。')
      offset += chunk.bytesRead
    }
    const after = await stat(sourcePath)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
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
export async function readAfsimLogFile(inputPath: string) {
  const { source, bytes } = await readLocalFileSnapshot(inputPath)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('日志不是有效的 UTF-8 文本，请确认文件编码。')
  }
  return {
    source,
    ...parseAfsimEventLog(text),
  }
}

/**
 * 提取每个平台的首个位置供地图初始化，不暴露本机路径，不补造遥测帧。
 * @param inputPath 本机配置的事件日志路径。
 */
export async function readInitialNodes(inputPath: string): Promise<InitialNodeSnapshot> {
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

async function loadInitialNodes(inputPath: string): Promise<InitialNodeSnapshot> {
  const parsed = await readAfsimLogFile(inputPath)
  if (!parsed.valid) throw new Error('日志解析失败，请先检查来源行号。')
  const nodes = parsed.nodes.map((node) => {
    const state = node.initialState
    if (!state) throw new Error('日志中有节点缺少初始位置。')
    return { platformId: node.name, name: PLATFORM_DISPLAY_NAMES.get(node.name) ?? node.name, type: node.type,
      ...(node.side ? { side: node.side } : {}),
      longitude: state.longitude, latitude: state.latitude,
      altitude: state.altitudeMeters, speed: state.speedMetersPerSecond,
      time: state.time, sourceEventId: state.sourceEventId }
  })
  const systems = new Map(parsed.communicationSystems.map(system => [JSON.stringify([system.platformName, system.name]), system.type]))
  const connections: FileCommunicationConnection[] = []
  for (const record of parsed.connections) {
    if (record.scope !== 'INTER_PLATFORM') continue
    const sourceType = systems.get(JSON.stringify([record.source.platformName, record.source.communicationName]))
    const targetType = systems.get(JSON.stringify([record.target.platformName, record.target.communicationName]))
    if (sourceType && targetType) {
      const connection = { ...record, sourceType, targetType }
      if (fileConnectionTypes(connection).length) connections.push(connection)
    }
  }
  const deviceEvents = buildFileDeviceEvents(parsed.events, new Set(nodes.map(node => node.platformId)))
  // 业务链路在服务端推导：浏览器不接触原始事件，且 systems 的键与设备类型索引同形。
  const messageLinks = buildFileMessageLinks(parsed.events, new Set(nodes.map(node => node.platformId)), systems).links
  const platformDeletions = buildFilePlatformDeletions(parsed.events, new Set(nodes.map(node => node.platformId)))
  const snapshot = { fileName: parsed.source.fileName, sha256: parsed.source.sha256, nodes, connections, deviceEvents, messageLinks, platformDeletions }
  if (!isInitialNodeSnapshot(snapshot)) throw new Error('日志初始位置为空或格式不正确。')
  return snapshot
}

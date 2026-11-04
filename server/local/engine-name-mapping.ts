import type { AfsimEventLog, AfsimLogEvent } from '../../src/features/data-exchange/afsim-event-log.js'
import { parseCsvLine } from '../../src/features/data-exchange/csv-contract.js'

/** 只有显式标记的新包使用实例名；旧包原编号不作猜测或替换。 */
export function engineNameMap(manifest: unknown): Map<string, string> | undefined {
  if (!manifest || typeof manifest !== 'object' || !('platformNaming' in manifest)
    || manifest.platformNaming !== 'TEMPLATE_INSTANCE') return undefined
  const platforms = (manifest as { platforms?: unknown }).platforms
  if (!Array.isArray(platforms) || platforms.length === 0) throw new Error('平台实例映射为空或格式无效。')
  const names = new Map<string, string>(), ids = new Set<string>()
  for (const platform of platforms) {
    if (!platform || typeof platform !== 'object' || Array.isArray(platform)
      || typeof platform.platformId !== 'string' || !platform.platformId.trim()
      || typeof platform.name !== 'string' || !platform.name.trim()) throw new Error('平台实例映射条目无效。')
    if (names.has(platform.name) || ids.has(platform.platformId)) throw new Error('平台实例名或场景编号重复。')
    names.set(platform.name, platform.platformId)
    ids.add(platform.platformId)
  }
  return names
}

export function toScenarioId(names: Map<string, string> | undefined, engineName: string): string {
  return names?.get(engineName) ?? engineName
}

// 仅转换平台列；设备、消息、链路标识及原始诊断文本保持原样。
const PLATFORM_FIELDS = new Set(['platform', 'source_platform', 'destination_platform', 'target_platform',
  'receiver', 'sender', 'local_platform', 'weapon_platform', 'target', 'destination', 'Destination', 'message_platform', 'SourcePlatform', 'TargetPlatform', 'DestPlatform'])

export function toScenarioEvent(names: Map<string, string> | undefined, event: AfsimLogEvent): AfsimLogEvent {
  if (!names) return event
  return { ...event, subject: toScenarioId(names, event.subject), fields: Object.fromEntries(
    Object.entries(event.fields).map(([key, value]) => [key, PLATFORM_FIELDS.has(key) ? toScenarioId(names, value) : value])) }
}

export function toScenarioLog<T extends AfsimEventLog>(names: Map<string, string> | undefined, log: T): T {
  if (!names) return log
  return { ...log,
    nodes: log.nodes.map(node => ({ ...node, name: toScenarioId(names, node.name) })),
    communicationSystems: log.communicationSystems.map(system => ({ ...system, platformName: toScenarioId(names, system.platformName) })),
    connections: log.connections.map(connection => ({ ...connection,
      source: { ...connection.source, platformName: toScenarioId(names, connection.source.platformName) },
      target: { ...connection.target, platformName: toScenarioId(names, connection.target.platformName) } })),
    events: log.events.map(event => toScenarioEvent(names, event)),
  }
}

/** 转换副本供关联类型及筛选索引匹配；不改写 mapping.json。 */
export function toScenarioDevices(names: Map<string, string> | undefined, devices: unknown): unknown {
  if (!names || !Array.isArray(devices)) return devices
  return devices.map(device => {
    if (!device || typeof device !== 'object') return device
    const copy = { ...device }
    for (const key of ['source', 'target', 'relay']) {
      const endpoint = copy[key]
      if (endpoint && typeof endpoint.platformId === 'string') copy[key] = { ...endpoint, platformId: toScenarioId(names, endpoint.platformId) }
    }
    if (typeof copy.relayPlatformId === 'string') copy.relayPlatformId = toScenarioId(names, copy.relayPlatformId)
    return copy
  })
}

/** 规范 CSV 使用场景编号，原始文件及 sourceSha256 不变。 */
export function toScenarioCsvRow(names: Map<string, string> | undefined, fields: readonly string[], line: string): string {
  if (!names || !line.trim()) return line
  const cells = parseCsvLine(line)
  if (!cells || cells.length !== fields.length) throw new Error('规范 CSV 行格式无效。')
  return cells.map((cell, index) => {
    const value = PLATFORM_FIELDS.has(fields[index]!) ? toScenarioId(names, cell) : cell
    return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
  }).join(',')
}

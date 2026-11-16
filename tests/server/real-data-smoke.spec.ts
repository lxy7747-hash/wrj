// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log'
import type { FileDeviceEvent } from '../../src/features/situation/file-device-events'
import {
  buildFileMessageLinks,
  fileMessageDeviceKey,
  FORWARD_MESSAGE_TYPES,
  selectFileMessageLinks,
} from '../../src/features/situation/file-message-links'

// 真实数据冒烟：读取 .env.local 的 AFSIM_EVENT_LOG_PATH，只验证跨版本应保持的不变量，
// 配置文件随 Git 共享，其他机器尚未配置路径或没有对应文件时整体跳过。
// 模块路径用拼接变量，避免 tsc 把服务端 node 代码拉进浏览器 app 项目编译图（与既有服务端测试一致）。
const fsModule = 'node:fs/' + 'promises'
const readerModule = '../../server/local/' + 'afsim-log-reader.js'
const replayReaderModule = '../../server/local/' + 'afsim-replay-reader.js'
const localReplayModule = '../../src/features/replays/' + 'local-replay.js'
const eventPath = await (async () => {
  try {
    const { readFile } = await import(fsModule)
    return (await readFile('.env.local', 'utf8')).match(/^AFSIM_EVENT_LOG_PATH=(.+)$/m)?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
})()

const eventFileAvailable = eventPath ? await (await import(fsModule)).access(eventPath).then(() => true, (error: { code?: string }) => {
  if (error.code === 'ENOENT') return false
  throw error
}) : false

async function loadReal() {
  const { readFile } = await import(fsModule)
  const { readInitialNodes } = await import(readerModule)
  const text = await readFile(eventPath, 'utf8')
  return { parsed: parseAfsimEventLog(text), snapshot: await readInitialNodes(eventPath), text }
}

/** 只统计数据行，排除 CSV 顶部的 `!` 字段声明。 */
function rawEventRowCount(text: string, type: string): number {
  return (text.match(new RegExp(`^[^,\\r\\n]+,\\s*${type},`, 'gmu')) ?? []).length
}

describe.skipIf(!eventFileAvailable)('真实数据冒烟（需 .env.local 配置 AFSIM_EVENT_LOG_PATH）', () => {
  it.skipIf(!eventPath)('事件日志解析有效、初始快照结构不变量成立', async () => {
    const { parsed, snapshot } = await loadReal()
    expect(parsed.valid).toBe(true)
    expect(parsed.nodes.length).toBeGreaterThan(0)
    for (const node of parsed.nodes) {
      expect(node.initialState, `节点 ${node.name} 缺少初始位置`).not.toBeNull()
    }
    expect(snapshot.nodes).toHaveLength(parsed.nodes.length)
    const connections = snapshot.connections ?? []
    expect(connections.length).toBeGreaterThan(0)
    for (const connection of connections) {
      expect(connection.source.platformName).not.toBe(connection.target.platformName)
      expect(connection.sourceType.trim()).not.toBe('')
      expect(connection.targetType.trim()).not.toBe('')
    }
  })

  it.skipIf(!eventPath)('全部实际使用的事件类型均已登记，真实数据不产生未识别告警', async () => {
    const { parsed } = await loadReal()
    const unregistered = parsed.issues.filter((issue) => issue.message.includes('未识别事件类型'))
    expect(unregistered.map((issue) => `第 ${issue.line} 行 ${issue.message}`)).toEqual([])
    expect(parsed.summary.warningCount).toBe(0)
  })

  it.skipIf(!eventPath)('WEAPON_TURNED_ON 数据行不丢失；存在该事件时错位声明下的 lat/lon/alt 与位置文件首帧一致', async () => {
    const { readFile } = await import(fsModule)
    const { parsed, text } = await loadReal()
    const weaponEvents = parsed.events.filter((event) => event.type === 'WEAPON_TURNED_ON' && !event.unparsedText)
    // 当前真实数据可能是无武器事件的 1112 场景；断言解析条数与原始数据行一致，
    // 不能因为样例没有该事件就把解析失败或丢行当成通过。
    expect(weaponEvents.length).toBe(rawEventRowCount(text, 'WEAPON_TURNED_ON'))
    if (weaponEvents.length === 0) return

    const positionPath = (await readFile('.env.local', 'utf8')).match(/^AFSIM_POSITION_LOG_PATH=(.+)$/m)?.[1]?.trim() ?? ''
    if (!positionPath) return
    const csv = await readFile(positionPath, 'utf8')
    const firstFrame = new Map<string, { lon: string; lat: string; alt: string }>()
    for (const line of csv.split('\n').slice(1)) {
      const cells = line.replace(/\r$/, '').split(',')
      if (cells.length !== 7 || firstFrame.has(cells[1]!)) continue
      firstFrame.set(cells[1]!, { lon: cells[2]!, lat: cells[3]!, alt: cells[4]! })
    }
    for (const event of weaponEvents) {
      const frame = firstFrame.get(event.subject)
      expect(frame, `位置文件缺少平台 ${event.subject}`).toBeDefined()
      // 只比较声明错位点之前的字段，姿态列整体错位因而不得参与比对。
      expect(Number(event.fields.lat)).toBeCloseTo(Number(frame!.lat), 6)
      expect(Number(event.fields.lon)).toBeCloseTo(Number(frame!.lon), 6)
      expect(Number(event.fields.alt)).toBeCloseTo(Number(frame!.alt), 3)
    }
  })

  it.skipIf(!eventPath)('消息链路推导覆盖全部接收记录，链路证据与活跃区间自洽', async () => {
    const { parsed, snapshot } = await loadReal()
    const platformIds = new Set(parsed.nodes.map((node) => node.name))
    const deviceTypes = new Map(parsed.communicationSystems.map((system) => (
      [fileMessageDeviceKey(system.platformName, system.name), system.type]
    )))
    const { links, issues } = buildFileMessageLinks(parsed.events, platformIds, deviceTypes)
    const delivered = links.reduce((sum, link) => sum + link.messageCount, 0)
    // 每条接收记录要么落到一条链路上，要么被明确计为未投递、歧义或未归类，不允许静默丢弃。
    expect(delivered + issues.undelivered + issues.ambiguous + issues.unclassified)
      .toBe(parsed.summary.eventCounts.MESSAGE_RECEIVED)
    /*
     * 真实数据可能是带中继的多跳场景：同一消息序号在 0.15 s 窗口内会同时出现上一跳和
     * 下一跳的发送记录。配对逻辑只把能构成已知链路制式的候选当作有效来源；剩余歧义
     * 是证据本身的缺口，不能为了通过而清零，也不能静默丢弃。这里只要求所有接收记录
     * 都有明确归类，并验证已生成链路的证据约束。
     */
    expect(issues.undelivered).toBe(0)
    expect(issues.unclassified).toBe(0)
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(platformIds.has(link.sourcePlatformId)).toBe(true)
      expect(platformIds.has(link.targetPlatformId)).toBe(true)
      // 登记表里存在同设备自环，业务链路不得出现自环。
      expect(link.sourcePlatformId).not.toBe(link.targetPlatformId)
      expect(link.messageTypes.length).toBeGreaterThan(0)
      expect(link.messageCount).toBe(link.records.length)
    }
    // 业务方向：指令为前向，状态与侦察为返向；每条链路方向必须与承载类型自洽。
    expect(links.every((link) => link.direction !== undefined)).toBe(true)
    for (const link of links) {
      const carriesForward = link.messageTypes.some((type) => FORWARD_MESSAGE_TYPES.has(type))
      expect(link.direction, `${link.id} 方向与业务类型不符`).toBe(carriesForward ? 'FORWARD' : 'REVERSE')
    }
    // 前向只承载指令类，返向绝不承载指令类。
    expect(links.filter((link) => link.direction === 'FORWARD')
      .every((link) => link.messageTypes.every((type) => FORWARD_MESSAGE_TYPES.has(type)))).toBe(true)
    expect(links.filter((link) => link.direction === 'REVERSE')
      .every((link) => !link.messageTypes.some((type) => FORWARD_MESSAGE_TYPES.has(type)))).toBe(true)
    // 首条投递之前没有任何链路；末次投递之后也没有，链路不会一直画到仿真结束。
    const maxLast = Math.max(...links.map((link) => link.lastTimeS))
    expect(selectFileMessageLinks(links, 0)).toEqual([])
    expect(selectFileMessageLinks(links, maxLast)).not.toEqual([])
    expect(selectFileMessageLinks(links, maxLast + 1e-6)).toEqual([])
    // 若样例包含卫星链路，GEO 单程光时 35 786 km / 299 792.458 km·s⁻¹ ≈ 0.1194 s，
    // 时延应接近该值而不是零；样例没有卫星链路时不做场景特定断言。
    for (const hop of links.filter((link) => link.type === 'SAT')) {
      expect(hop.medianDelayS, `${hop.id} 卫星时延不符合 GEO 单程光时`).toBeGreaterThan(0.11)
      expect(hop.medianDelayS, `${hop.id} 卫星时延不符合 GEO 单程光时`).toBeLessThan(0.15)
    }
    // 若样例包含指挥车到无人机直连，活跃区间必须与其首末投递时刻一致；
    // 不再假设固定的干扰窗口或固定的中断次数。
    for (const link of links.filter((candidate) => candidate.sourcePlatformId === 'command_vehicle'
      && candidate.targetPlatformId.startsWith('mission_uav'))) {
      expect(link.activeIntervals[0]!.startTimeS).toBe(link.firstTimeS)
      expect(link.activeIntervals.at(-1)!.endTimeS).toBe(link.lastTimeS)
      expect(selectFileMessageLinks([link], link.firstTimeS)).not.toEqual([])
      expect(selectFileMessageLinks([link], link.lastTimeS)).not.toEqual([])
    }
    // 服务端快照必须携带同一批业务链路，浏览器才能真正收到并按时刻截断。
    expect(snapshot.messageLinks?.length ?? 0).toBe(links.length)
    expect(snapshot.messageLinks).toEqual(links)
  })

  it.skipIf(!eventPath)('平台删除记录覆盖全部节点，回放时长包含删除时刻并在该时刻移除节点', async () => {
    const { readFile } = await import(fsModule)
    const { readLocalReplay } = await import(replayReaderModule)
    const { selectReplayNodes } = await import(localReplayModule)
    const { parsed, snapshot } = await loadReal()
    const deletions: Array<{ platformId: string; time: number }> = snapshot.platformDeletions ?? []
    expect(deletions.map((deletion) => deletion.platformId).sort())
      .toEqual(parsed.nodes.map((node) => node.name).sort())
    const positionPath = (await readFile('.env.local', 'utf8')).match(/^AFSIM_POSITION_LOG_PATH=(.+)$/m)?.[1]?.trim() ?? ''
    if (!positionPath) return
    const replay = await readLocalReplay(eventPath, positionPath)
    const lastDeletion = Math.max(...deletions.map((deletion) => deletion.time))
    // 位置文件末帧早于删除时刻，因此回放时长必须被删除时刻延长，否则游标到不了删除时刻。
    expect(replay.durationS).toBeGreaterThanOrEqual(lastDeletion)
    expect(selectReplayNodes(replay, lastDeletion).map((node: { platformId: string }) => node.platformId)).toEqual([])
    expect(selectReplayNodes(replay, lastDeletion - 0.01).length).toBeGreaterThan(0)
  })

  it.skipIf(!eventPath)('节点阵营与 PLATFORM_ADDED 声明一致，红方仅为干扰平台', async () => {
    const { parsed, snapshot } = await loadReal()
    const nodes: Array<{ platformId: string; side?: string }> = snapshot.nodes
    const added = parsed.events.filter((event) => event.type === 'PLATFORM_ADDED' && !event.unparsedText)
    const declared = new Map<string, string>(added.map((event) => [event.subject, event.fields.Side!] as [string, string]))
    const declaredTypes = new Map<string, string>(added.map((event) => [event.subject, event.fields.Type ?? ''] as [string, string]))
    // 平台数量由数据本身决定；不把某一版样例的 9 个平台当作跨版本不变量。
    expect(declared.size).toBeGreaterThan(0)
    expect(nodes).toHaveLength(declared.size)
    expect(nodes.map((node) => node.platformId).sort()).toEqual([...declared.keys()].sort())
    // 每个节点的阵营必须与 PLATFORM_ADDED 声明的一致，不补默认阵营。
    for (const node of nodes) {
      expect(node.side, `节点 ${node.platformId} 缺少阵营`).toBe(declared.get(node.platformId))
    }
    // 事件里只允许蓝/红两种阵营；红方必须恰好是干扰平台，不能把其他节点误标红。
    expect(new Set(declared.values())).toEqual(new Set(['blue', 'red']))
    const red = nodes.filter((node) => node.side === 'red').map((node) => node.platformId).sort()
    const jammerNodes = nodes.filter((node) => declaredTypes.get(node.platformId)?.includes('JAMMER')).map((node) => node.platformId).sort()
    expect(red).toEqual(jammerNodes)
    expect(nodes.filter((node) => node.side === 'blue')).toHaveLength(nodes.length - jammerNodes.length)
  })

  it.skipIf(!eventPath)('WEAPON_TURNED_OFF 必须提取为 JAMMING 关闭，不继承频率/带宽', async () => {
    const { parsed, snapshot } = await loadReal()
    const deviceEvents: FileDeviceEvent[] = snapshot.deviceEvents ?? []
    const stops = parsed.events.filter(event => event.type === 'WEAPON_TURNED_OFF'
      && event.fields.system_type === 'WSF_RF_JAMMER')
    for (const stop of stops) {
      const state = deviceEvents.find(event => event.kind === 'JAMMING' && !event.active
        && event.platformId === stop.subject && event.time === stop.time)
      expect(state, `WEAPON_TURNED_OFF ${stop.subject}@${stop.time} 未提取为 JAMMING 关闭`).toBeDefined()
      expect(state?.frequencyHz).toBeUndefined()
      expect(state?.bandwidthHz).toBeUndefined()
    }
  })
})

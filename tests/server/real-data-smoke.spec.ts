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
// 不硬编码绝对路径、不断言具体消息计数；其他机器无配置时整体跳过。
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

async function loadReal() {
  const { readFile } = await import(fsModule)
  const { readInitialNodes } = await import(readerModule)
  const text = await readFile(eventPath, 'utf8')
  return { parsed: parseAfsimEventLog(text), snapshot: await readInitialNodes(eventPath) }
}

describe('真实数据冒烟（需 .env.local 配置 AFSIM_EVENT_LOG_PATH）', () => {
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

  it.skipIf(!eventPath)('WEAPON_TURNED_ON 错位声明下的 lat/lon/alt 与位置文件首帧一致', async () => {
    const { readFile } = await import(fsModule)
    const { parsed } = await loadReal()
    const positionPath = (await readFile('.env.local', 'utf8')).match(/^AFSIM_POSITION_LOG_PATH=(.+)$/m)?.[1]?.trim() ?? ''
    if (!positionPath) return
    const csv = await readFile(positionPath, 'utf8')
    const firstFrame = new Map<string, { lon: string; lat: string; alt: string }>()
    for (const line of csv.split('\n').slice(1)) {
      const cells = line.replace(/\r$/, '').split(',')
      if (cells.length !== 7 || firstFrame.has(cells[1]!)) continue
      firstFrame.set(cells[1]!, { lon: cells[2]!, lat: cells[3]!, alt: cells[4]! })
    }
    const weaponEvents = parsed.events.filter((event) => event.type === 'WEAPON_TURNED_ON' && !event.unparsedText)
    expect(weaponEvents.length).toBeGreaterThan(0)
    for (const event of weaponEvents) {
      const frame = firstFrame.get(event.subject)
      expect(frame, `位置文件缺少平台 ${event.subject}`).toBeDefined()
      // 只比较声明错位点之前的字段，姿态列整体错位因而不得参与比对。
      expect(Number(event.fields.lat)).toBeCloseTo(Number(frame!.lat), 6)
      expect(Number(event.fields.lon)).toBeCloseTo(Number(frame!.lon), 6)
      expect(Number(event.fields.alt)).toBeCloseTo(Number(frame!.alt), 3)
    }
  })

  it.skipIf(!eventPath)('消息链路推导覆盖全部接收记录，卫星中继只在干扰窗口内活跃', async () => {
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
    // 真实数据中同一消息的多次发送都落在同一平台同一设备，因此来源唯一、无歧义。
    expect(issues).toEqual({ undelivered: 0, ambiguous: 0, unclassified: 0 })
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(platformIds.has(link.sourcePlatformId)).toBe(true)
      expect(platformIds.has(link.targetPlatformId)).toBe(true)
      // 登记表里存在同设备自环，业务链路不得出现自环。
      expect(link.sourcePlatformId).not.toBe(link.targetPlatformId)
      expect(link.messageTypes.length).toBeGreaterThan(0)
      expect(link.messageCount).toBe(link.records.length)
    }
    // 卫星中继只在干扰窗口内出现（地面干扰站 1666.178 开启、2806.178 关闭）。
    const satelliteHops = links.filter((link) => link.type === 'SAT')
    expect(satelliteHops.length).toBeGreaterThan(0)
    for (const hop of satelliteHops) {
      expect(hop.firstTimeS, `${hop.id} 早于干扰窗口`).toBeGreaterThan(1600)
      expect(hop.lastTimeS, `${hop.id} 晚于干扰窗口`).toBeLessThan(2900)
      // GEO 单程光时 35 786 km / 299 792.458 km·s⁻¹ ≈ 0.1194 s，卫星链路时延应接近该值而不是零。
      expect(hop.medianDelayS).toBeGreaterThan(0.11)
      expect(hop.medianDelayS).toBeLessThan(0.15)
    }
    // 业务方向：指令为前向，状态与侦察为返向；真实数据里每条链路方向单一，不出现无法判定。
    expect(links.every((link) => link.direction !== undefined)).toBe(true)
    for (const link of links) {
      const carriesCommand = link.messageTypes.some((type) => FORWARD_MESSAGE_TYPES.has(type))
      expect(link.direction, `${link.id} 方向与业务类型不符`).toBe(carriesCommand ? 'FORWARD' : 'REVERSE')
    }
    // 前向只承载指令，返向绝不承载指令。
    expect(links.filter((link) => link.direction === 'FORWARD')
      .every((link) => link.messageTypes.every((type) => type === 'CMD_ORDER'))).toBe(true)
    expect(links.filter((link) => link.direction === 'REVERSE')
      .every((link) => !link.messageTypes.includes('CMD_ORDER'))).toBe(true)
    // 全量链路的投递条数之和等于接收总条数。
    expect(delivered).toBe(parsed.summary.eventCounts.MESSAGE_RECEIVED)
    // 首条投递之前没有任何链路；末次投递之后也没有，链路不会一直画到仿真结束。
    expect(selectFileMessageLinks(links, 0)).toEqual([])
    expect(selectFileMessageLinks(links, 5399.29)).not.toEqual([])
    expect(selectFileMessageLinks(links, 5400)).toEqual([])
    // 卫星中继只在干扰窗口内活跃，干扰结束后必须消失。
    const activeSatellite = (time: number) => selectFileMessageLinks(links, time).filter((link) => link.type === 'SAT')
    expect(activeSatellite(1660)).toEqual([])
    expect(activeSatellite(2000).length).toBeGreaterThan(0)
    expect(activeSatellite(2806)).toEqual([])
    expect(activeSatellite(5399)).toEqual([])
    // 卫星中继启用期间，指挥车到 U02/U03 的直连完全静默，链路必须在该中断期间消失。
    const direct = (source: string, target: string) => {
      const link = links.find((candidate) => candidate.sourcePlatformId === source && candidate.targetPlatformId === target)
      expect(link, `缺少链路 ${source} → ${target}`).toBeDefined()
      return link!
    }
    for (const target of ['mission_uav_02', 'mission_uav_03']) {
      const link = direct('command_vehicle', target)
      expect(link.activeIntervals.length, `${target} 应被判定为中断过一次`).toBe(2)
      expect(selectFileMessageLinks([link], 500)).toHaveLength(1)
      expect(selectFileMessageLinks([link], 2000), `${target} 在卫星中继期间仍被画成连通`).toEqual([])
      expect(selectFileMessageLinks([link], 4000)).toHaveLength(1)
    }
    // 指挥车到 U01 的直连全程连续，是卫星中继的上行来源。
    const toUav01 = direct('command_vehicle', 'mission_uav_01')
    expect(toUav01.activeIntervals).toEqual([{ startTimeS: toUav01.firstTimeS, endTimeS: toUav01.lastTimeS }])
    for (const time of [500, 2000, 4000]) expect(selectFileMessageLinks([toUav01], time)).toHaveLength(1)
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

  it.skipIf(!eventPath)('节点携带事件日志的阵营：7 个蓝方、2 个红方，与 PLATFORM_ADDED 一致', async () => {
    const { parsed, snapshot } = await loadReal()
    const nodes: Array<{ platformId: string; side?: string }> = snapshot.nodes
    const declared = new Map<string, string>(parsed.events
      .filter((event) => event.type === 'PLATFORM_ADDED' && !event.unparsedText)
      .map((event) => [event.subject, event.fields.Side!] as [string, string]))
    expect(declared.size).toBe(9)
    expect(nodes.map((node) => node.platformId).sort()).toEqual([...declared.keys()].sort())
    // 每个节点的阵营必须与 PLATFORM_ADDED 声明的一致，不补默认阵营。
    for (const node of nodes) {
      expect(node.side, `节点 ${node.platformId} 缺少阵营`).toBe(declared.get(node.platformId))
    }
    // 事件里从未出现第三种阵营；红方只有两个干扰平台。
    expect(new Set(declared.values())).toEqual(new Set(['blue', 'red']))
    expect(nodes.filter((node) => node.side === 'red').map((node) => node.platformId).sort())
      .toEqual(['jammer_airborne_01', 'jammer_station_01'])
    expect(nodes.filter((node) => node.side === 'blue')).toHaveLength(7)
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

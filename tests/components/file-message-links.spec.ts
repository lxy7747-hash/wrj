// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log'
import {
  buildFileMessageLinks,
  fileMessageDeviceKey,
  isFileMessageLink,
  MESSAGE_MAX_DELAY_S,
  readFileMessageDirection,
  selectFileMessageLinks,
} from '../../src/features/situation/file-message-links'

const DECLARATION = [
  '! MESSAGE_TRANSMITTED,time<time>,event<string>,platform<string>,side<string>,comm<string>,message_serial_number<int>,data_tag<double>,message_type<string>,message_size<int>',
  '! MESSAGE_RECEIVED,time<time>,event<string>,platform<string>,side<string>,comm<string>,message_serial_number<int>,data_tag<double>,message_type<string>,message_size<int>',
  '! COMM_TURNED_ON,time<time>,event<string>,platform<string>,side<string>,type<string>,system<string>,system_type<string>',
]
const transmit = (time: number, platform: string, comm: string, serial: number, type = 'CMD_ORDER', size = 512): string =>
  `${time},MESSAGE_TRANSMITTED,${platform},blue,${comm},${serial},0,${type},${size}`
const receive = (time: number, platform: string, comm: string, serial: number, type = 'CMD_ORDER', size = 512): string =>
  `${time},MESSAGE_RECEIVED,${platform},blue,${comm},${serial},0,${type},${size}`

type Device = [platform: string, comm: string, type?: string]

function build(lines: string[], options: { platforms?: string[]; devices?: Device[] } = {}) {
  const parsed = parseAfsimEventLog([...DECLARATION, ...lines].join('\n'))
  const platforms = new Set(options.platforms ?? ['A', 'B', 'C'])
  const devices = new Map((options.devices ?? [['A', 'c_band_uplink'], ['B', 'c_band_uplink'], ['C', 'c_band_uplink']])
    .map(([platform, comm, type]) => [fileMessageDeviceKey(platform!, comm!), type ?? 'WSF_RADIO_TRANSCEIVER']))
  return { parsed, ...buildFileMessageLinks(parsed.events, platforms, devices) }
}

describe('文件消息链路投影', () => {
  it('按序号配对收发，生成有向链路并保留时刻、条数、业务类型与中位时延', () => {
    const { parsed, links, issues } = build([
      transmit(1, 'A', 'c_band_uplink', 7),
      receive(1.0004, 'B', 'c_band_uplink', 7),
      transmit(3, 'A', 'c_band_uplink', 8),
      receive(3.0004, 'B', 'c_band_uplink', 8),
    ])
    expect(parsed.summary.errorCount).toBe(0)
    expect(issues).toEqual({ undelivered: 0, ambiguous: 0, unclassified: 0 })
    expect(links).toHaveLength(1)
    const link = links[0]!
    expect(link).toMatchObject({
      type: 'DATALINK',
      sourcePlatformId: 'A',
      targetPlatformId: 'B',
      sourceDeviceId: 'c_band_uplink',
      targetDeviceId: 'c_band_uplink',
      messageCount: 2,
      firstTimeS: 1.0004,
      lastTimeS: 3.0004,
      messageTypes: ['CMD_ORDER'],
    })
    expect(link.medianDelayS).toBeCloseTo(0.0004, 9)
    expect(link.records[0]).toMatchObject({
      sourceEventId: 'LOG-L5', transmitEventId: 'LOG-L4', time: 1.0004, messageSizeBits: 512,
      source: { platformName: 'A', communicationName: 'c_band_uplink' },
      target: { platformName: 'B', communicationName: 'c_band_uplink' },
    })
    expect(link.id).toBe(JSON.stringify(['DATALINK', 'A', 'c_band_uplink', 'B', 'c_band_uplink']))
  })

  it('同一消息发往多个接收方时发送设备唯一，判为来源明确而不是歧义', () => {
    const { links, issues } = build([
      transmit(1, 'A', 'c_band_uplink', 7),
      transmit(1, 'A', 'c_band_uplink', 7),
      transmit(1, 'A', 'c_band_uplink', 7),
      receive(1.0004, 'B', 'c_band_uplink', 7),
      receive(1.0004, 'C', 'c_band_uplink', 7),
      receive(1.0004, 'D', 'c_band_uplink', 7),
    ], { platforms: ['A', 'B', 'C', 'D'], devices: [
      ['A', 'c_band_uplink'], ['B', 'c_band_uplink'], ['C', 'c_band_uplink'], ['D', 'c_band_uplink'],
    ] })
    expect(issues).toEqual({ undelivered: 0, ambiguous: 0, unclassified: 0 })
    expect(links).toHaveLength(3)
    expect(links.map((link) => link.targetPlatformId).sort()).toEqual(['B', 'C', 'D'])
    for (const link of links) expect(link.messageCount).toBe(1)
  })

  it('候选发送分散在不同设备时判为歧义，不生成链路也不猜来源', () => {
    const { links, issues } = build([
      transmit(1, 'A', 'c_band_uplink', 7),
      transmit(1.1, 'A', 'l_band_uplink', 7),
      receive(1.12, 'B', 'c_band_uplink', 7),
    ], { devices: [['A', 'c_band_uplink'], ['A', 'l_band_uplink'], ['B', 'c_band_uplink']] })
    expect(links).toEqual([])
    expect(issues).toEqual({ undelivered: 0, ambiguous: 1, unclassified: 0 })
  })

  it('无同序号发送、接收早于发送、时延超出窗口或业务类型不符时记为未投递', () => {
    const { links, issues } = build([
      receive(5, 'B', 'c_band_uplink', 9),
      transmit(10, 'A', 'c_band_uplink', 11),
      receive(9.9, 'B', 'c_band_uplink', 11),
      transmit(20, 'A', 'c_band_uplink', 12),
      receive(20.2, 'B', 'c_band_uplink', 12),
      transmit(30, 'A', 'c_band_uplink', 13, 'CMD_ORDER'),
      receive(30.001, 'B', 'c_band_uplink', 13, 'STATUS_REPORT'),
    ])
    expect(links).toEqual([])
    expect(issues).toEqual({ undelivered: 4, ambiguous: 0, unclassified: 0 })
    expect(20.2 - 20).toBeGreaterThan(MESSAGE_MAX_DELAY_S)
  })

  it('设备类型缺失、两端制式不一致或平台未登记时不生成链路并计入未归类', () => {
    const { links, issues } = build([
      transmit(1, 'A', 'c_band_uplink', 1),
      receive(1, 'B', 'mystery_link', 1),
      transmit(2, 'A', 'sat_link', 2),
      receive(2, 'B', 'c_band_uplink', 2),
      transmit(3, 'A', 'c_band_uplink', 3),
      receive(3, 'Z', 'c_band_uplink', 3),
    ], { platforms: ['A', 'B'], devices: [
      ['A', 'c_band_uplink'], ['B', 'mystery_link'], ['A', 'sat_link'], ['B', 'c_band_uplink'], ['Z', 'c_band_uplink'],
    ] })
    expect(links).toEqual([])
    expect(issues).toEqual({ undelivered: 0, ambiguous: 0, unclassified: 3 })
  })

  it('解析失败的消息与非消息事件都不参与配对', () => {
    const { parsed, links, issues } = build([
      '0,COMM_TURNED_ON,A,blue,Comm,c_band_uplink,WSF_RADIO_TRANSCEIVER',
      transmit(1, 'A', 'c_band_uplink', 7),
      '1.2,MESSAGE_RECEIVED,B,blue,c_band_uplink,7,0,CMD_ORDER,not-a-size',
      receive(1.1, 'B', 'c_band_uplink', 7),
    ])
    expect(parsed.summary.errorCount).toBe(1)
    expect(links).toHaveLength(1)
    // 未被解析的接收记录即使序号相同也不计入投递。
    expect(links[0]!.messageCount).toBe(1)
    expect(links[0]!.records[0]!.sourceEventId).toBe('LOG-L7')
    expect(links[0]!.medianDelayS).toBeCloseTo(0.1, 9)
    expect(issues).toEqual({ undelivered: 0, ambiguous: 0, unclassified: 0 })
  })

  it('按活跃窗口取链路：末次投递之后消失，而不是一旦出现就永久保留', () => {
    const { links } = build([
      transmit(1, 'A', 'c_band_uplink', 1),
      receive(1.001, 'B', 'c_band_uplink', 1),
      transmit(5, 'A', 'c_band_uplink', 2),
      receive(5.001, 'B', 'c_band_uplink', 2),
      transmit(9, 'A', 'c_band_uplink', 3),
      receive(9.001, 'B', 'c_band_uplink', 3),
    ])
    const before = structuredClone(links)
    expect(links[0]!.messageCount).toBe(3)
    // 首个投递之前不存在。
    expect(selectFileMessageLinks(links, 0)).toEqual([])
    expect(selectFileMessageLinks(links, 1.0009)).toEqual([])
    const atOne = selectFileMessageLinks(links, 1.001)[0]!
    expect(atOne).toMatchObject({ messageCount: 1, firstTimeS: 1.001, lastTimeS: 1.001 })
    const atFive = selectFileMessageLinks(links, 5.001)[0]!
    expect(atFive).toMatchObject({ messageCount: 2, firstTimeS: 1.001, lastTimeS: 5.001 })
    // 末次投递当刻仍在窗口内。
    const atLast = selectFileMessageLinks(links, 9.001)[0]!
    expect(atLast).toMatchObject({ messageCount: 3, firstTimeS: 1.001, lastTimeS: 9.001 })
    // 末次投递之后必须消失，否则地图会把已经停用的链路一直画到结束。
    expect(selectFileMessageLinks(links, 9.002)).toEqual([])
    expect(selectFileMessageLinks(links, 5400)).toEqual([])
    expect(selectFileMessageLinks([], 100)).toEqual([])
    expect(links).toEqual(before)
  })

  it('窗口判定使用完整活跃窗口，不受截断后明细影响', () => {
    const { links } = build([
      transmit(2, 'A', 'c_band_uplink', 1),
      receive(2.0004, 'B', 'c_band_uplink', 1),
      transmit(100, 'A', 'c_band_uplink', 2),
      receive(100.0004, 'B', 'c_band_uplink', 2),
    ])
    // 游标落在两次投递之间：链路仍在窗口内，但明细只含已发生的那一次。
    const midway = selectFileMessageLinks(links, 50)[0]!
    expect(midway).toMatchObject({ messageCount: 1, firstTimeS: 2.0004, lastTimeS: 2.0004 })
    expect(midway.records).toHaveLength(1)
    expect(selectFileMessageLinks(links, 99.9)[0]!.messageCount).toBe(1)
    expect(selectFileMessageLinks(links, 100.0004)[0]!.messageCount).toBe(2)
  })

  it('中断后恢复的链路按多段活跃区间处理，中断期间不再保持连线', () => {
    const { links } = build([
      transmit(1, 'A', 'c_band_uplink', 1),
      receive(1.0004, 'B', 'c_band_uplink', 1),
      transmit(2, 'A', 'c_band_uplink', 2),
      receive(2.0004, 'B', 'c_band_uplink', 2),
      // 静默 1000 秒后恢复：远超该链路自身约 1 秒的节奏。
      transmit(1002, 'A', 'c_band_uplink', 3),
      receive(1002.0004, 'B', 'c_band_uplink', 3),
      transmit(1003, 'A', 'c_band_uplink', 4),
      receive(1003.0004, 'B', 'c_band_uplink', 4),
    ])
    const link = links[0]!
    expect(link.activeIntervals).toEqual([
      { startTimeS: 1.0004, endTimeS: 2.0004 },
      { startTimeS: 1002.0004, endTimeS: 1003.0004 },
    ])
    // 首末时刻是区间的汇总投影，跨越了中断但仍然只用于展示。
    expect(link).toMatchObject({ firstTimeS: 1.0004, lastTimeS: 1003.0004, messageCount: 4 })
    expect(selectFileMessageLinks(links, 0)).toEqual([])
    expect(selectFileMessageLinks(links, 2.0004)[0]!.messageCount).toBe(2)
    // 中断期间必须消失，否则地图会把断开的两段连成一条跨越中断的线。
    expect(selectFileMessageLinks(links, 2.1)).toEqual([])
    expect(selectFileMessageLinks(links, 500)).toEqual([])
    expect(selectFileMessageLinks(links, 1002.0003)).toEqual([])
    // 恢复后重新出现，且明细只含恢复之后发生的投递。
    expect(selectFileMessageLinks(links, 1002.0004)[0]!.messageCount).toBe(3)
    expect(selectFileMessageLinks(links, 1003.0004)[0]!.messageCount).toBe(4)
    expect(selectFileMessageLinks(links, 1003.5)).toEqual([])
  })

  it('正常投递抖动不会被误判为中断，阈值随链路自身节奏缩放', () => {
    const slow = build([
      transmit(1, 'A', 'c_band_uplink', 1), receive(1.0004, 'B', 'c_band_uplink', 1),
      transmit(11, 'A', 'c_band_uplink', 2), receive(11.0004, 'B', 'c_band_uplink', 2),
      transmit(21, 'A', 'c_band_uplink', 3), receive(21.0004, 'B', 'c_band_uplink', 3),
      // 一次 60 秒抖动：约等于中位间隔的 6 倍，仍属同一段。
      transmit(81, 'A', 'c_band_uplink', 4), receive(81.0004, 'B', 'c_band_uplink', 4),
      transmit(91, 'A', 'c_band_uplink', 5), receive(91.0004, 'B', 'c_band_uplink', 5),
    ]).links[0]!
    expect(slow.activeIntervals).toEqual([{ startTimeS: 1.0004, endTimeS: 91.0004 }])
    expect(selectFileMessageLinks([slow], 50)).toHaveLength(1)

    // 同样 60 秒的间隔，对高频链路就是明显中断。
    const fast = build([
      transmit(1, 'A', 'c_band_uplink', 1), receive(1.0004, 'B', 'c_band_uplink', 1),
      transmit(2, 'A', 'c_band_uplink', 2), receive(2.0004, 'B', 'c_band_uplink', 2),
      transmit(3, 'A', 'c_band_uplink', 3), receive(3.0004, 'B', 'c_band_uplink', 3),
      transmit(63, 'A', 'c_band_uplink', 4), receive(63.0004, 'B', 'c_band_uplink', 4),
      transmit(64, 'A', 'c_band_uplink', 5), receive(64.0004, 'B', 'c_band_uplink', 5),
    ]).links[0]!
    expect(fast.activeIntervals).toEqual([
      { startTimeS: 1.0004, endTimeS: 3.0004 },
      { startTimeS: 63.0004, endTimeS: 64.0004 },
    ])
    expect(selectFileMessageLinks([fast], 30)).toEqual([])
  })

  it('单次投递的链路退化为零长区间，只在当刻出现', () => {
    const single = build([
      transmit(7, 'A', 'c_band_uplink', 1),
      receive(7.0004, 'B', 'c_band_uplink', 1),
    ]).links[0]!
    expect(single.activeIntervals).toEqual([{ startTimeS: 7.0004, endTimeS: 7.0004 }])
    expect(selectFileMessageLinks([single], 7)).toEqual([])
    expect(selectFileMessageLinks([single], 7.0004)).toHaveLength(1)
    expect(selectFileMessageLinks([single], 7.001)).toEqual([])
  })

  it('业务方向由承载的业务类型判定：只承载一类才判定，混合或未识别都不猜', () => {
    const forward = build([
      transmit(1, 'A', 'c_band_uplink', 1, 'CMD_ORDER'),
      receive(1.0004, 'B', 'c_band_uplink', 1, 'CMD_ORDER'),
    ]).links[0]!
    expect(forward.direction).toBe('FORWARD')

    const reverse = build([
      transmit(1, 'A', 'c_band_uplink', 1, 'STATUS_REPORT'),
      receive(1.0004, 'B', 'c_band_uplink', 1, 'STATUS_REPORT'),
      transmit(2, 'A', 'c_band_uplink', 2, 'RECON_DATA'),
      receive(2.0004, 'B', 'c_band_uplink', 2, 'RECON_DATA'),
    ]).links[0]!
    // 状态与侦察同属回传类，合并后仍是返向。
    expect(reverse.direction).toBe('REVERSE')
    expect(reverse.messageTypes).toEqual(['RECON_DATA', 'STATUS_REPORT'])

    // 同一链路同时承载下发与回传 → 语义冲突，不猜方向。
    const mixed = build([
      transmit(1, 'A', 'c_band_uplink', 1, 'CMD_ORDER'),
      receive(1.0004, 'B', 'c_band_uplink', 1, 'CMD_ORDER'),
      transmit(2, 'A', 'c_band_uplink', 2, 'STATUS_REPORT'),
      receive(2.0004, 'B', 'c_band_uplink', 2, 'STATUS_REPORT'),
    ]).links[0]!
    expect(mixed.direction).toBeUndefined()

    // 未识别类型 → 无法判定，不猜方向。
    const unknown = build([
      transmit(1, 'A', 'c_band_uplink', 1, 'MYSTERY'),
      receive(1.0004, 'B', 'c_band_uplink', 1, 'MYSTERY'),
    ]).links[0]!
    expect(unknown.direction).toBeUndefined()
    expect(readFileMessageDirection(['CMD_ORDER'])).toBe('FORWARD')
    expect(readFileMessageDirection(['CMD_ORDER', 'RECON_DATA'])).toBeUndefined()
    expect(readFileMessageDirection(['MYSTERY'])).toBeUndefined()
    expect(readFileMessageDirection([])).toBeUndefined()
  })

  it('校验器拒绝与承载业务类型矛盾的方向，避免界面展示与证据不符', () => {
    const ids = new Set(['A', 'B'])
    const link = build([
      transmit(1, 'A', 'c_band_uplink', 1, 'CMD_ORDER'),
      receive(1.0004, 'B', 'c_band_uplink', 1, 'CMD_ORDER'),
    ]).links[0]!
    expect(isFileMessageLink(link, ids)).toBe(true)
    // 指令链路上标成返向、标成未知取值、或干脆不给方向，都必须拒绝。
    for (const direction of ['REVERSE', 'SIDEWAYS', undefined]) {
      expect(isFileMessageLink({ ...link, direction }, ids)).toBe(false)
    }
    expect(isFileMessageLink({ ...link, messageTypes: ['CMD_ORDER', 'RECON_DATA'] }, ids)).toBe(false)
  })

  it('旧版浏览器没有 Object.hasOwn 时仍可校验消息链路', () => {
    const ids = new Set(['A', 'B'])
    const link = build([
      transmit(1, 'A', 'c_band_uplink', 1, 'CMD_ORDER'),
      receive(1.0004, 'B', 'c_band_uplink', 1, 'CMD_ORDER'),
    ]).links[0]!
    const hasOwn = vi.spyOn(Object, 'hasOwn').mockImplementation(() => { throw new Error('Object.hasOwn 不可用') })
    let valid = false
    try { valid = isFileMessageLink(link, ids) } finally { hasOwn.mockRestore() }
    expect(valid).toBe(true)
  })

  it('偶数条投递取中位时延，且不输出任何未由消息证据支撑的字段', () => {
    const { links } = build([
      transmit(1, 'A', 'c_band_uplink', 1),
      receive(1.001, 'B', 'c_band_uplink', 1),
      transmit(2, 'A', 'c_band_uplink', 2),
      receive(2.003, 'B', 'c_band_uplink', 2),
    ])
    expect(links[0]!.medianDelayS).toBeCloseTo(0.002, 9)
    expect(JSON.stringify(links)).not.toMatch(/"(?:snr|ber|linkStatus|capacity|packetLoss|packetLossRate|throughput)":/)
  })
})

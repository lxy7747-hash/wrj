// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log'
import { isInitialNodeSnapshot } from '../../src/features/situation/initial-nodes'

// 与已有服务端测试一致：Node 专用模块只在测试运行时加载，不纳入浏览器类型工程。
const fsModule = 'node:fs/' + 'promises'
const osModule = 'node:' + 'os'
const pathModule = 'node:' + 'path'
const eventsModule = 'node:' + 'events'
const { mkdtemp, readFile, rm, writeFile } = await import(fsModule)
const { tmpdir } = await import(osModule)
const { join } = await import(pathModule)
const { once } = await import(eventsModule)

const SAMPLE = [
  '0.00000 PLATFORM_ADDED A Type: AIR_PLATFORM Side: blue \\',
  '',
  '0.00000 PLATFORM_ADDED B Type: GROUND_PLATFORM Side: blue \\',
  '0.00000 LINK_ADDED_TO_MANAGER A tx 0.1.0.1 linked to: B rx 0.1.0.2',
  '0.00000 LINK_ADDED_TO_MANAGER B rx 0.1.0.2 linked to: A tx 0.1.0.1',
  '0.00000 LINK_ADDED_TO_MANAGER A tx 0.1.0.1 linked to: A rx 0.1.0.3',
  '0.00000 MOVER_TURNED_ON A Mover: mover Type: WSF_AIR_MOVER \\',
  ' LLA: 30:00:08.78n 77:57:42.14w 0 m Heading: 358.855 deg Pitch: 0.000 deg Roll: 0.000 deg \\',
  ' Speed: 223.520 m/s * [ 1.000 -0.020 0.000 ] Acceleration: 0.000 m/s2 * [ 0.000 0.000 0.000 ]',
  '0.00000 MOVER_TURNED_ON B Mover: mover Type: WSF_GROUND_MOVER \\',
  ' LLA: 25:06:09.22n 117:03:05.43e 8000 m Heading: 90.000 deg Pitch: 0.000 deg Roll: 0.000 deg \\',
  ' Speed: 0.000 m/s * [ 0.000 0.000 0.000 ] Acceleration: 0.000 m/s2 * [ 0.000 0.000 0.000 ]',
  '0.00000 COMM_TURNED_ON A Comm: tx Type: satcom_1',
  '0.00000 COMM_TURNED_ON A Comm: rx Type: microwave',
  '0.00000 COMM_TURNED_ON B Comm: rx Type: satcom_2',
  '0.00000 SIMULATION_STARTING Year: 2003 Month: 6 Day: 1 Hour: 12 Minute: 0 Second: 0',
  '10.59284 MESSAGE_TRANSMITTED A System: tx Number: 9007199254740993 DataTag: 0.000000000000000001 Type: WSF_CONTROL_MESSAGE Size: 0 bits',
  '10.59296 MESSAGE_HOP A System: tx Number: 9007199254740993 DataTag: 0.000000000000000001 Type: WSF_CONTROL_MESSAGE Size: 0 bits Destination: B.rx',
  '10.59313 MESSAGE_RECEIVED B System: rx Number: 9007199254740993 DataTag: 0.000000000000000001 Type: WSF_CONTROL_MESSAGE Size: 0 bits',
  '3600.00100 SIMULATION_COMPLETE Year: 2003 Month: 6 Day: 1 Hour: 13 Minute: 0 Second: 0',
].join('\n')

describe('真实 AFSIM 事件日志解析', () => {
  it('只读提取初始位置，不覆盖源文件、不暴露路径或虚构链路字段', async () => {
    const readerModule = '../../server/local/' + 'afsim-log-reader.js'
    const { readInitialNodes } = await import(readerModule)
    const directory = await mkdtemp(join(tmpdir(), 'wrj-initial-nodes-'))
    const source = join(directory, 'sample.csv')
    try {
      await writeFile(source, SAMPLE)
      const snapshot = await readInitialNodes(source)
      expect(isInitialNodeSnapshot(snapshot)).toBe(true)
      expect(snapshot.nodes).toHaveLength(2)
      expect(snapshot.nodes[0]).toMatchObject({ name: 'A', type: 'AIR_PLATFORM', altitude: 0, speed: 223.52, time: 0 })
      expect(snapshot.nodes[0].longitude).toBeCloseTo(-77.9617055556, 9)
      expect(snapshot.nodes[1].altitude).toBe(8000)
      expect(JSON.stringify(snapshot)).not.toMatch(/"(?:path|snr|ber|status|links)":/)
      expect(await readFile(source, 'utf8')).toBe(SAMPLE)
      await writeFile(source, '0 PLATFORM_ADDED A Type: AIR Side: blue')
      await expect(readInitialNodes(source)).rejects.toThrow('初始位置')
      await expect(readInitialNodes(join(directory, 'missing.csv'))).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('初始位置接口校验拒绝重复、缺失或越界坐标', () => {
    const node = { platformId: 'A', name: 'A', type: 'AIR', longitude: 117, latitude: 25, altitude: 0,
      speed: 0, time: 0, sourceEventId: 'LOG-L1' }
    const snapshot = { fileName: 'sample.csv', sha256: 'a'.repeat(64), nodes: [node] }
    expect(isInitialNodeSnapshot(snapshot)).toBe(true)
    expect(isInitialNodeSnapshot(null)).toBe(true)
    expect(isInitialNodeSnapshot([])).toBe(false)
    expect(isInitialNodeSnapshot({ ...snapshot, nodes: [node, node] })).toBe(false)
    expect(isInitialNodeSnapshot({ ...snapshot, nodes: [{ ...node, latitude: 91 }] })).toBe(false)
    expect(isInitialNodeSnapshot({ ...snapshot, nodes: [{ ...node, longitude: undefined }] })).toBe(false)
  })

  it('本机初始位置接口检查角色和查询参数，失败不回退 Mock 或泄露路径', async () => {
    const appModule = '../../server/' + 'app.js'
    const supertestModule = 'super' + 'test'
    const { createMockServer } = await import(appModule)
    const { default: request } = await import(supertestModule)
    let reads = 0
    const server = createMockServer({ loadInitialNodes: async () => {
      reads += 1
      throw new Error('E:/private/input.csv 读取失败')
    } })
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    try {
      await request(server.httpServer).get('/api/v1/situation/initial-nodes').set('Origin', 'http://127.0.0.1:5173').expect(403)
      await request(server.httpServer).get('/api/v1/situation/initial-nodes?path=other.csv').set('Origin', 'http://127.0.0.1:5173').set('X-Demo-Role', 'OPERATOR').expect(400)
      expect(reads).toBe(0)
      const result = await request(server.httpServer).get('/api/v1/situation/initial-nodes').set('Origin', 'http://127.0.0.1:5173').set('X-Demo-Role', 'OPERATOR').expect(503)
      expect(reads).toBe(1)
      expect(result.text).not.toContain('E:/private')
      expect(result.body.data).toBeUndefined()
    } finally {
      await server.close()
    }
    const mock = createMockServer()
    if (!mock.httpServer.listening) await once(mock.httpServer, 'listening')
    try {
      const result = await request(mock.httpServer).get('/api/v1/situation/initial-nodes').set('Origin', 'http://127.0.0.1:5173').set('X-Demo-Role', 'ADMIN').expect(200)
      expect(result.body.data).toBeNull()
    } finally {
      await mock.close()
    }
  })

  it('解析多行初始节点、设备与事件，并保留单位和消息标识精度', () => {
    const result = parseAfsimEventLog(SAMPLE)
    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.nodes).toHaveLength(2)
    expect(result.communicationSystems).toHaveLength(3)
    expect(result.events).toHaveLength(15)
    expect(result.summary).toMatchObject({ eventCount: 15, timeRange: { start: 0, end: 3600.001 }, simulationComplete: true })
    expect(result.nodes[0]).toMatchObject({ name: 'A', type: 'AIR_PLATFORM', side: 'blue',
      initialState: { time: 0, sourceEventId: 'LOG-L7', altitudeMeters: 0, headingDegrees: 358.855, speedMetersPerSecond: 223.52 } })
    expect(result.nodes[0]?.initialState?.latitude).toBeCloseTo(30.0024388889, 9)
    expect(result.nodes[0]?.initialState?.longitude).toBeCloseTo(-77.9617055556, 9)
    expect(result.nodes[1]?.initialState?.longitude).toBeCloseTo(117.0515083333, 9)
    expect(result.nodes[1]?.initialState?.speedMetersPerSecond).toBe(0)
    const mover = result.events.find((event) => event.type === 'MOVER_TURNED_ON')
    expect(mover).toMatchObject({ sourceLine: 7, endLine: 9 })
    expect(mover?.fields.Acceleration).toBe('0.000 m/s2 * [ 0.000 0.000 0.000 ]')
    const hop = result.events.find((event) => event.type === 'MESSAGE_HOP')
    expect(hop?.fields).toMatchObject({ Number: '9007199254740993', DataTag: '0.000000000000000001', Size: '0 bits', Destination: 'B.rx' })
    expect(hop?.subject).toBe('A')
    expect(result.summary.eventCounts.MESSAGE_RECEIVED).toBe(1)
    expect(JSON.stringify(result)).not.toMatch(/"(?:snr|ber|linkStatus)":/)
  })

  it('区分平台内外连接，保留反向、重复登记与晚于初始化的连接', () => {
    const result = parseAfsimEventLog(`${SAMPLE}\n3601 LINK_ADDED_TO_MANAGER A tx 0.1.0.1 linked to: B rx 0.1.0.2`)
    expect(result.connections).toHaveLength(4)
    expect(result.summary.internalConnectionCount).toBe(1)
    expect(result.summary.interPlatformConnectionCount).toBe(3)
    expect(result.connections[0]).toMatchObject({ time: 0, scope: 'INTER_PLATFORM', source: { platformName: 'A', communicationName: 'tx', address: '0.1.0.1' }, target: { platformName: 'B', communicationName: 'rx' } })
    expect(result.connections[1]?.source.platformName).toBe('B')
    expect(result.connections[2]?.scope).toBe('INTERNAL')
    expect(result.connections[3]?.time).toBe(3601)
  })

  it('兼容 UTF-8 BOM、CRLF、空行及无结尾换行', () => {
    expect(parseAfsimEventLog(`\uFEFF${SAMPLE.replaceAll('\n', '\r\n')}`)).toEqual(parseAfsimEventLog(SAMPLE))
  })

  it('缺失位置保持空值，未声明平台或设备不自动补造', () => {
    const result = parseAfsimEventLog('0 PLATFORM_ADDED A Type: AIR Side: blue\n0 LINK_ADDED_TO_MANAGER A tx 1 linked to: X rx 2')
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]?.initialState).toBeNull()
    expect(result.communicationSystems).toEqual([])
    expect(result.issues.map((issue) => issue.message).join(' ')).toContain('缺少初始位置')
    expect(result.issues.map((issue) => issue.message).join(' ')).toContain('X.rx')
  })

  it.each(['91:00:00n', '30:60:00n', '30:00:60n', '30:00:00w'])('拒绝非法纬度 %s，不搬移节点或默认归零', (latitude) => {
    const result = parseAfsimEventLog(SAMPLE.replace('30:00:08.78n', latitude))
    expect(result.valid).toBe(false)
    expect(result.nodes[0]?.initialState).toBeNull()
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: 'ERROR', line: 7 }))
  })

  it('支持南纬，拒绝错误高度单位与非有限速度', () => {
    expect(parseAfsimEventLog(SAMPLE.replace('30:00:08.78n', '30:00:08.78s')).nodes[0]?.initialState?.latitude).toBeLessThan(0)
    for (const malformed of [SAMPLE.replace('0 m Heading:', '0 ft Heading:'), SAMPLE.replace('223.520 m/s', 'Infinity m/s')]) {
      expect(parseAfsimEventLog(malformed).valid).toBe(false)
    }
  })

  it('字段缺失、重复字段和非法消息大小保留错误行及原文', () => {
    const result = parseAfsimEventLog('0 PLATFORM_ADDED A Type: AIR\n1 PLATFORM_ADDED B Type: AIR Side: blue Type: OTHER\n2 MESSAGE_TRANSMITTED A System: tx Number: 1 DataTag: 0 Type: MSG Size: -1 bits')
    expect(result.valid).toBe(false)
    expect(result.summary.errorCount).toBe(3)
    expect(result.events).toHaveLength(3)
    expect(result.events.every((event) => event.unparsedText?.startsWith(`${event.time} ${event.type}`))).toBe(true)
    expect(result.nodes).toEqual([])
  })

  it('未知事件保留字段与原文，不能静默丢弃或当作正常链路', () => {
    const result = parseAfsimEventLog('2 CUSTOM_EVENT A Details: original')
    expect(result.events[0]).toMatchObject({ type: 'CUSTOM_EVENT', fields: { Details: 'original' }, unparsedText: '2 CUSTOM_EVENT A Details: original' })
    expect(result.summary.warningCount).toBe(1)
    expect(result.summary.simulationComplete).toBe(false)
    expect(result.connections).toEqual([])
  })

  it('报告空文件、孤立续行、损坏行及非法时间', () => {
    for (const input of ['', ' LLA: 1:00:00n 1:00:00e 0 m', 'broken line', '-1 PLATFORM_ADDED A Type: AIR Side: blue', 'NaN PLATFORM_ADDED A Type: AIR Side: blue']) {
      const result = parseAfsimEventLog(input)
      expect(result.valid).toBe(false)
      expect(result.issues.every((issue) => issue.line > 0)).toBe(true)
    }
  })

  it('报告时间倒退并保留文件原始顺序，初始状态不会被后续位置覆盖', () => {
    const result = parseAfsimEventLog(`${SAMPLE}\n1 CUSTOM_EVENT A Details: late\n2 MOVER_TURNED_ON A Mover: mover Type: AIR\n LLA: 20:00:00n 120:00:00e 10 m Heading: 0 deg Pitch: 0 deg Roll: 0 deg\n Speed: 1 m/s`)
    expect(result.events.at(-2)?.time).toBe(1)
    expect(result.issues.some((issue) => issue.message.includes('时间倒退'))).toBe(true)
    expect(result.nodes[0]?.initialState?.time).toBe(0)
    expect(result.nodes[0]?.initialState?.longitude).toBeLessThan(0)
  })
})

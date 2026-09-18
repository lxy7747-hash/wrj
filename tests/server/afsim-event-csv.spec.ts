// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log'
import { isLocalReplaySnapshot, selectReplayNodes } from '../../src/features/replays/local-replay'
import { mergePositionNodes } from '../../src/features/situation/position-updates'
import { selectFileCommunicationLinks } from '../../src/features/situation/file-communication-links'
import { selectFileDeviceStates } from '../../src/features/situation/file-device-events'

const CSV = [
  '! PLATFORM_ADDED,time<time>,event<string>,platform<string>,side<string>,type<string>,ps<double>,lat<lat>,lon<lon>',
  '! PLATFORM_INITIALIZED,time<time>,event<string>,platform<string>,side<string>,type<string>,lat<lat>,lon<lon>,alt<double>,heading<angle>,pitch<angle>,roll<angle>,ned_speed<double>',
  '! MOVER_TURNED_ON,time<time>,event<string>,platform<string>,side<string>,type<string>,system<string>,system_type<string>,lat<lat>,lon<lon>,alt<double>,heading<double>,pitch<double>,roll<double>,ned_speed<double>',
  '! COMM_TURNED_ON,time<time>,event<string>,platform<string>,side<string>,type<string>,system<string>,system_type<string>',
  '! LINK_ADDED_TO_MANAGER,source_platform<string>,source_comm<string>,source_address<string>,destination_platform<string>,destination_comm<string>,destination_address<string>',
  '! MESSAGE_RECEIVED,time<time>,event<string>,platform<string>,side<string>,comm<string>,message_serial_number<int>,data_tag<double>,message_type<string>,message_size<int>,comment<string>',
  '! SIMULATION_COMPLETE,time<time>,event<string>,year<int>,month<int>,day<int>,hour<int>,minute<int>,second<int>',
  '0,PLATFORM_ADDED,A,blue,AIR,',
  '0,PLATFORM_ADDED,B,red,GROUND,',
  '0,PLATFORM_INITIALIZED,A,blue,AIR,25,119,3000,1.5707963267948966,0,0,100',
  '0,MOVER_TURNED_ON,B,red,Mover,mover,WSF_GROUND_MOVER,26,120,0,0,0,0,0',
  '0,COMM_TURNED_ON,A,blue,Comm,tx,satcom_1',
  '0,COMM_TURNED_ON,B,red,Comm,rx,satcom_2',
  '5,LINK_ADDED_TO_MANAGER,A,tx,0.1.0.1,B,rx,0.1.0.2',
  '5,MESSAGE_RECEIVED,B,red,rx,9007199254740993,0.000000000000000001,CMD_ORDER,512,"含逗号,及""引号""",,,,',
  '10,SIMULATION_COMPLETE,2025,9,15,0,0,1.000000e+01',
].join('\n')

const MESSAGE_LINK_CSV = [
  '! PLATFORM_ADDED,time<time>,event<string>,platform<string>,side<string>,type<string>,ps<double>,lat<lat>,lon<lon>',
  '! PLATFORM_INITIALIZED,time<time>,event<string>,platform<string>,side<string>,type<string>,lat<lat>,lon<lon>,alt<double>,heading<angle>,pitch<angle>,roll<angle>,ned_speed<double>',
  '! MOVER_TURNED_ON,time<time>,event<string>,platform<string>,side<string>,type<string>,system<string>,system_type<string>,lat<lat>,lon<lon>,alt<double>,heading<double>,pitch<double>,roll<double>,ned_speed<double>',
  '! COMM_TURNED_ON,time<time>,event<string>,platform<string>,side<string>,type<string>,system<string>,system_type<string>',
  '! MESSAGE_TRANSMITTED,time<time>,event<string>,platform<string>,side<string>,comm<string>,message_serial_number<int>,data_tag<double>,message_type<string>,message_size<int>',
  '! MESSAGE_RECEIVED,time<time>,event<string>,platform<string>,side<string>,comm<string>,message_serial_number<int>,data_tag<double>,message_type<string>,message_size<int>',
  '! PLATFORM_DELETED,time<time>,event<string>,platform<string>,side<string>,type<string>,lat<lat>,lon<lon>,alt<double>',
  '0,PLATFORM_ADDED,A,blue,AIR,',
  '0,PLATFORM_ADDED,B,red,AIR,',
  '0,PLATFORM_INITIALIZED,A,blue,AIR,25,119,3000,0,0,0,100',
  '0,PLATFORM_INITIALIZED,B,red,AIR,26,120,3000,0,0,0,100',
  '0,MOVER_TURNED_ON,A,blue,Mover,mover,WSF_AIR_MOVER,25,119,3000,0,0,0,100',
  '0,MOVER_TURNED_ON,B,red,Mover,mover,WSF_AIR_MOVER,26,120,3000,0,0,0,100',
  '0,COMM_TURNED_ON,A,blue,Comm,sat_link,WSF_RADIO_TRANSCEIVER',
  '0,COMM_TURNED_ON,B,red,Comm,sat_link,WSF_RADIO_TRANSCEIVER',
  '1,MESSAGE_TRANSMITTED,A,blue,sat_link,7,0,CMD_ORDER,512',
  '1.0004,MESSAGE_RECEIVED,B,red,sat_link,7,0,CMD_ORDER,512',
  '12,PLATFORM_DELETED,B,red,AIR,26,120,3000',
].join('\n')

describe('AFSIM 多事件 CSV 兼容', () => {
  it('按事件声明解析初始位置、设备与关联，保留消息精度及引用字段', () => {
    const result = parseAfsimEventLog(`\uFEFF${CSV.replaceAll('\n', '\r\n')}`)
    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes[0]).toMatchObject({ name: 'A', type: 'AIR', side: 'blue',
      initialState: { longitude: 119, latitude: 25, altitudeMeters: 3000, headingDegrees: 90, speedMetersPerSecond: 100 } })
    expect(result.nodes[1]?.initialState?.speedMetersPerSecond).toBe(0)
    expect(result.communicationSystems).toHaveLength(2)
    expect(result.connections).toEqual([expect.objectContaining({ time: 5, scope: 'INTER_PLATFORM',
      source: { platformName: 'A', communicationName: 'tx', address: '0.1.0.1' },
      target: { platformName: 'B', communicationName: 'rx', address: '0.1.0.2' } })])
    expect(result.events.find(event => event.type === 'MESSAGE_RECEIVED')?.fields).toMatchObject({
      message_serial_number: '9007199254740993', Number: '9007199254740993', DataTag: '0.000000000000000001',
      comment: '含逗号,及"引号"', Size: '512 bits',
    })
    expect(result.summary).toMatchObject({ eventCount: 9, simulationComplete: true, timeRange: { start: 0, end: 10 } })
    expect(JSON.stringify(result)).not.toMatch(/"(?:snr|ber|linkStatus)":/)
  })

  it.each([
    ['空纬度', CSV.replace('AIR,25,119', 'AIR,,119')],
    ['越界经度', CSV.replace('AIR,25,119', 'AIR,25,181')],
    ['负速度', CSV.replace(',0,0,100', ',0,0,-1')],
    ['非有限高度', CSV.replace(',119,3000,', ',119,Infinity,')],
    ['空链路端点', CSV.replace('A,tx,0.1.0.1,B,rx', 'A,tx,,B,rx')],
    ['非法消息大小', CSV.replace('CMD_ORDER,512', 'CMD_ORDER,-1')],
    ['缺少声明', CSV.replace(/^! PLATFORM_ADDED[^\n]*\n/, '')],
    ['重复声明', `${CSV}\n! PLATFORM_ADDED,time<time>,event<string>`],
    ['重复字段', CSV.replace('side<string>,type<string>,ps<double>', 'side<string>,side<string>,ps<double>')],
    ['未闭合引号', CSV.replace('A,blue,AIR,', '"A,blue,AIR,')],
    ['未声明非空尾列', CSV.replace('0,COMM_TURNED_ON,A,blue,Comm,tx,satcom_1', '0,COMM_TURNED_ON,A,blue,Comm,tx,satcom_1,unexpected')],
    ['非法时间', CSV.replace('5,LINK_ADDED', '-1,LINK_ADDED')],
  ])('拒绝%s并保留来源行，不能把空白数值当零', (_, text) => {
    const result = parseAfsimEventLog(text)
    expect(result.valid).toBe(false)
    expect(result.issues.some(issue => issue.severity === 'ERROR' && issue.line > 0)).toBe(true)
  })

  it('支持带箭头的字段声明和 HOP 嵌套重复列，未支持的事件保留原文', () => {
    const extra = [
      '! SENSOR_DETECTION_CHANGED,time<time>,event<string>,xmtr->rcvr_range<double>',
      '! MESSAGE_HOP,time<time>,event<string>,receiver<string>,receiver_system<string>,message_serial_number<int>,data_tag<double>,message_type<string>,message_size<int>,destination<string>,time<time>,event<string>',
      '11,MESSAGE_HOP,B,rx,9007199254740993,0.1,MSG,0,A,9,MESSAGE_RECEIVED',
      '12,SENSOR_DETECTION_CHANGED,20,unmapped',
    ].join('\n')
    const result = parseAfsimEventLog(`${CSV}\n${extra}`)
    expect(result.valid).toBe(true)
    expect(result.events.at(-2)?.fields).toMatchObject({ time: '11', 'time#2': '9', Destination: 'A', Number: '9007199254740993' })
    expect(result.events.at(-1)).toMatchObject({ unparsedText: '12,SENSOR_DETECTION_CHANGED,20,unmapped',
      fields: { 'xmtr->rcvr_range': '20', csvExtraColumns: '["unmapped"]' } })
    expect(result.summary.warningCount).toBe(1)
  })

  it('真实读取临时 CSV 后初始节点及回放接口可用，损坏来源返回错误且不回退', async () => {
    const fsModule = 'node:fs/' + 'promises'
    const osModule = 'node:' + 'os'
    const pathModule = 'node:' + 'path'
    const readerModule = '../../server/local/' + 'afsim-log-reader.js'
    const replayModule = '../../server/local/' + 'afsim-replay-reader.js'
    const appModule = '../../server/' + 'app.js'
    const supertestModule = 'super' + 'test'
    const { mkdtemp, writeFile, rm } = await import(fsModule)
    const { tmpdir } = await import(osModule)
    const { join } = await import(pathModule)
    const { readInitialNodes } = await import(readerModule)
    const { readLocalReplay } = await import(replayModule)
    const { createMockServer } = await import(appModule)
    const { default: request } = await import(supertestModule)
    const directory = await mkdtemp(join(tmpdir(), 'wrj-event-csv-'))
    const source = join(directory, 'scenario_events.csv')
    const positions = join(directory, 'position.csv')
    const server = createMockServer({ loadInitialNodes: () => readInitialNodes(source), loadLocalReplay: () => readLocalReplay(source, positions) })
    const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
    try {
      await writeFile(source, CSV)
      await writeFile(positions, 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n3,A,120,25,3000,100,90\n')
      const initial = await request(server.httpServer).get('/api/v1/situation/initial-nodes').set(headers).expect(200)
      expect(initial.body.data.nodes).toHaveLength(2)
      // 阵营必须随初始节点接口一起下发，否则地图无法区分红蓝。
      expect(initial.body.data.nodes.map((node: { side?: string }) => node.side)).toEqual(['blue', 'red'])
      expect(initial.body.data.connections).toHaveLength(1)
      expect(initial.body.data.deviceEvents).toEqual([
        expect.objectContaining({ platformId: 'A', deviceId: 'tx', kind: 'COMMUNICATION', active: true, time: 0 }),
        expect.objectContaining({ platformId: 'B', deviceId: 'rx', kind: 'COMMUNICATION', active: true, time: 0 }),
      ])
      const replay = await request(server.httpServer).get('/api/v1/replays/local-file').set(headers).expect(200)
      expect(isLocalReplaySnapshot(replay.body.data)).toBe(true)
      expect(replay.body.data).toMatchObject({ durationS: 5, recordCount: 1, issueCount: 0 })
      const namedCsv = CSV.replace(/\bA\b/g, 'mission_uav_01').replace(/\bAIR\b/g, 'MISSION_UAV_PLATFORM')
      await writeFile(source, namedCsv)
      await writeFile(positions, 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n3,mission_uav_01,120,25,3200,100,90\n')
      const named = await request(server.httpServer).get('/api/v1/replays/local-file').set(headers).expect(200)
      expect(isLocalReplaySnapshot(named.body.data)).toBe(true)
      const namedNode = { platformId: 'mission_uav_01', name: '无人机01', type: 'MISSION_UAV_PLATFORM' }
      expect(named.body.data.initial.nodes[0]).toMatchObject(namedNode)
      expect(named.body.data.initial.nodes[1]).toMatchObject({ platformId: 'B', name: 'B', type: 'GROUND' })
      expect(named.body.data.initial.connections[0].source.platformName).toBe('mission_uav_01')
      expect(selectReplayNodes(named.body.data, 3)[0]).toMatchObject({ ...namedNode, longitude: 120, altitude: 3200 })
      expect(selectReplayNodes(named.body.data, 0)[0]).toMatchObject({ ...namedNode, longitude: 119, altitude: 3000 })
      expect(mergePositionNodes(named.body.data.initial, { fileName: 'position.csv', generation: 1,
        recordCount: 1, issueCount: 0, issues: [], waitingForLine: false, hasMore: false,
        nodes: named.body.data.tracks[0].positions })[0]).toMatchObject({ ...namedNode, longitude: 120, altitude: 3200 })
      expect(parseAfsimEventLog(namedCsv).nodes[0]?.name).toBe('mission_uav_01')
      // 通用收发机并不声明卫星/微波制式，保留原始关联但不猜测地图分类。
      await writeFile(source, CSV.replaceAll('satcom_1', 'WSF_RADIO_TRANSCEIVER').replaceAll('satcom_2', 'WSF_RADIO_TRANSCEIVER'))
      expect((await readInitialNodes(source)).connections).toEqual([])
      // 经确认的名称映射走正式文件/API 入口；跨用途或仅单端已知不能画成数传链路。
      await writeFile(positions, 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n3,A,120,25,3000,100,90\n')
      for (const [sourceComm, targetComm, sourceType, targetType, expected] of [
        ['c_band_uplink', 'c_band_downlink', 'WSF_RADIO_TRANSCEIVER', 'WSF_RADIO_TRANSCEIVER', 'DATALINK'],
        ['l_band_uplink', 'l_band_downlink', 'WSF_RADIO_TRANSCEIVER', 'WSF_RADIO_TRANSCEIVER', 'DATALINK'],
        ['c_band_downlink', 'l_band_uplink', 'WSF_RADIO_TRANSCEIVER', 'WSF_RADIO_TRANSCEIVER', 'DATALINK'],
        ['fiber_link', 'fiber_link', 'WSF_COMM_TRANSCEIVER', 'WSF_COMM_TRANSCEIVER', 'FIBER'],
        ['sat_link', 'sat_link', 'WSF_RADIO_TRANSCEIVER', 'WSF_RADIO_TRANSCEIVER', 'SAT'],
        ['sat_link_a', 'sat_link', 'WSF_RADIO_TRANSCEIVER', 'WSF_RADIO_TRANSCEIVER', 'SAT'],
        ['sat_link', 'sat_link_b', 'WSF_RADIO_TRANSCEIVER', 'WSF_RADIO_TRANSCEIVER', 'SAT'],
        ['microwave_link', 'microwave_link', 'WSF_RADIO_TRANSCEIVER', 'WSF_RADIO_TRANSCEIVER', 'MICROWAVE'],
        ['sat_link', 'microwave_link', 'WSF_RADIO_TRANSCEIVER', 'WSF_RADIO_TRANSCEIVER', null],
        ['sat_link', 'sat_link_b', 'UNKNOWN', 'WSF_RADIO_TRANSCEIVER', null],
        ['c_band_uplink', 'sat_link', 'WSF_RADIO_TRANSCEIVER', 'WSF_RADIO_TRANSCEIVER', null],
        ['c_band_uplink', 'fiber_link', 'WSF_RADIO_TRANSCEIVER', 'WSF_COMM_TRANSCEIVER', null],
        ['c_band_uplink', 'l_band_downlink', 'UNKNOWN', 'WSF_RADIO_TRANSCEIVER', null],
      ]) {
        const csv = CSV.replace(/\btx\b/g, sourceComm!).replace(/\brx\b/g, targetComm!)
          .replace('satcom_1', sourceType!).replace('satcom_2', targetType!)
        await writeFile(source, csv)
        const response = await request(server.httpServer).get('/api/v1/replays/local-file').set(headers).expect(200)
        expect(isLocalReplaySnapshot(response.body.data)).toBe(true)
        const connections = response.body.data.initial.connections
        expect(selectFileCommunicationLinks(connections, 0)).toEqual([])
        expect(selectFileCommunicationLinks(connections, 5).map(link => link.type)).toEqual(expected ? [expected] : [])
        if (expected) expect(connections[0]).toMatchObject({ sourceType, targetType,
          source: { platformName: 'A', communicationName: sourceComm },
          target: { platformName: 'B', communicationName: targetComm } })
      }
      const deviceCsv = [
        '! JAMMING_REQUEST_INITIATED,time<time>,event<string>,platform<string>,weapon<string>,current_mode<string>,active_requests_(eM_Xmtrs)<int>,frequency<double>,bandwidth<double>,target_platform<string>',
        '! WEAPON_TURNED_OFF,time<time>,event<string>,platform<string>,side<string>,type<string>,system_platform<string>,system_type<string>',
        '! COMM_TURNED_OFF,time<time>,event<string>,platform<string>,side<string>,type<string>,system<string>,system_type<string>',
        CSV.split('\n').slice(0, -1).join('\n'),
        '10,JAMMING_REQUEST_INITIATED,B,prophet_jammer,broadband_jamming,1,2.4e9,5e7,',
        '12,COMM_TURNED_OFF,A,blue,Comm,tx,satcom_1',
        '12.5,WEAPON_TURNED_OFF,B,red,Weapon,prophet_jammer,WSF_RF_JAMMER',
        '13,SIMULATION_COMPLETE,2025,9,15,0,0,13',
      ].join('\n')
      await writeFile(source, deviceCsv)
      const deviceReplay = await request(server.httpServer).get('/api/v1/replays/local-file').set(headers).expect(200)
      expect(isLocalReplaySnapshot(deviceReplay.body.data)).toBe(true)
      expect(deviceReplay.body.data.durationS).toBe(12.5)
      expect(deviceReplay.body.data.initial.deviceEvents).toHaveLength(5)
      expect(selectFileDeviceStates(deviceReplay.body.data.initial.deviceEvents, 9)).toHaveLength(2)
      expect(selectFileDeviceStates(deviceReplay.body.data.initial.deviceEvents, 10).at(-1)).toMatchObject({
        kind: 'JAMMING', active: true, time: 10, frequencyHz: 2.4e9, bandwidthHz: 5e7,
      })
      expect(selectFileDeviceStates(deviceReplay.body.data.initial.deviceEvents, 12)[0]).toMatchObject({ active: false, deviceId: 'tx' })
      const stopped = selectFileDeviceStates(deviceReplay.body.data.initial.deviceEvents, 12.5).find(event => event.kind === 'JAMMING')
      expect(stopped).toMatchObject({ active: false, deviceId: 'prophet_jammer', time: 12.5 })
      expect(stopped?.frequencyHz).toBeUndefined()
      expect(stopped?.bandwidthHz).toBeUndefined()
      expect(selectReplayNodes(deviceReplay.body.data, 12)[0]?.longitude).toBe(120)
      expect(selectReplayNodes(deviceReplay.body.data, 10)[0]?.longitude).toBe(120)
      for (const corrupt of [
        deviceCsv.replace('B,prophet_jammer', 'UNKNOWN,prophet_jammer'),
        deviceCsv.replace(',1,2.4e9,5e7,', ',1,,5e7,'),
        deviceCsv.replace(',1,2.4e9,5e7,', ',-1,2.4e9,5e7,'),
      ]) {
        await writeFile(source, corrupt)
        await request(server.httpServer).get('/api/v1/replays/local-file').set(headers).expect(503)
      }
      await writeFile(source, CSV)
      const restored = await request(server.httpServer).get('/api/v1/replays/local-file').set(headers).expect(200)
      expect(restored.body.data.initial.deviceEvents).toHaveLength(2)
      await writeFile(source, CSV.replace('AIR,25,119', 'AIR,,119'))
      await request(server.httpServer).get('/api/v1/replays/local-file').set(headers).expect(503)
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('初始节点接口下发业务链路与平台删除记录，回放时长被删除时刻延长', async () => {
    const fsModule = 'node:fs/' + 'promises'
    const osModule = 'node:' + 'os'
    const pathModule = 'node:' + 'path'
    const readerModule = '../../server/local/' + 'afsim-log-reader.js'
    const replayModule = '../../server/local/' + 'afsim-replay-reader.js'
    const appModule = '../../server/' + 'app.js'
    const supertestModule = 'super' + 'test'
    const { mkdtemp, writeFile, rm } = await import(fsModule)
    const { tmpdir } = await import(osModule)
    const { join } = await import(pathModule)
    const { readInitialNodes } = await import(readerModule)
    const { readLocalReplay } = await import(replayModule)
    const { createMockServer } = await import(appModule)
    const { default: request } = await import(supertestModule)
    const directory = await mkdtemp(join(tmpdir(), 'wrj-message-links-'))
    const source = join(directory, 'scenario_events.csv')
    const positions = join(directory, 'position.csv')
    const server = createMockServer({
      loadInitialNodes: () => readInitialNodes(source),
      loadLocalReplay: () => readLocalReplay(source, positions),
    })
    const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
    try {
      await writeFile(source, MESSAGE_LINK_CSV)
      await writeFile(positions, 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n3,A,119,25,3000,100,90\n')
      const initial = await request(server.httpServer).get('/api/v1/situation/initial-nodes').set(headers).expect(200)
      // 业务链路必须在服务端算好后随初始快照下发，否则前端地图链路图层永远为空。
      expect(initial.body.data.messageLinks).toHaveLength(1)
      const [link] = initial.body.data.messageLinks
      expect(link).toMatchObject({
        id: JSON.stringify(['SAT', 'A', 'sat_link', 'B', 'sat_link']),
        type: 'SAT',
        sourcePlatformId: 'A',
        targetPlatformId: 'B',
        sourceDeviceId: 'sat_link',
        targetDeviceId: 'sat_link',
        firstTimeS: 1.0004,
        lastTimeS: 1.0004,
        messageCount: 1,
        messageTypes: ['CMD_ORDER'],
      })
      // 时延保留原始的浮点差值，不做四舍五入后改写。
      expect(link.medianDelayS).toBeCloseTo(0.0004, 9)
      expect(link.records).toHaveLength(1)
      expect(link.records[0]).toMatchObject({
        sourceEventId: 'LOG-L17',
        transmitEventId: 'LOG-L16',
        time: 1.0004,
        messageType: 'CMD_ORDER',
        messageSizeBits: 512,
        source: { platformName: 'A', communicationName: 'sat_link' },
        target: { platformName: 'B', communicationName: 'sat_link' },
      })
      expect(link.records[0].delayS).toBeCloseTo(0.0004, 9)
      expect(initial.body.data.platformDeletions).toEqual([
        { sourceEventId: 'LOG-L18', platformId: 'B', time: 12 },
      ])
      const replay = await request(server.httpServer).get('/api/v1/replays/local-file').set(headers).expect(200)
      expect(isLocalReplaySnapshot(replay.body.data)).toBe(true)
      // 位置记录末刻只有 3 秒，删除时刻 12 秒必须计入总时长，否则游标到不了删除时刻。
      expect(replay.body.data.durationS).toBe(12)
      expect(replay.body.data.initial.messageLinks).toHaveLength(1)
      const idsAt = (seconds: number) => selectReplayNodes(replay.body.data, seconds).map((node: { platformId: string }) => node.platformId)
      expect(idsAt(11.9)).toEqual(['A', 'B'])
      expect(idsAt(12)).toEqual(['A'])
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

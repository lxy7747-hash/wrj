// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log'
import { buildFileDeviceEvents, fileLinkDeviceStatus, isFileDeviceEvent, selectFileDeviceStates, type FileDeviceEvent } from '../../src/features/situation/file-device-events'
import type { FileCommunicationLink } from '../../src/features/situation/file-communication-links'
import { isInitialNodeSnapshot } from '../../src/features/situation/initial-nodes'
import { isLocalReplaySnapshot } from '../../src/features/replays/local-replay'
import { LOCAL_REPLAY } from '../fixtures/local-replay'

const CSV = [
  '! COMM_TURNED_ON,time<time>,event<string>,platform<string>,side<string>,type<string>,system<string>,system_type<string>',
  '! COMM_TURNED_OFF,time<time>,event<string>,platform<string>,side<string>,type<string>,system<string>,system_type<string>',
  ...['INITIATED', 'UPDATED', 'CANCELED'].map(action => `! JAMMING_REQUEST_${action},time<time>,event<string>,platform<string>,weapon<string>,current_mode<string>,active_requests_(eM_Xmtrs)<int>,frequency<double>,bandwidth<double>,target_platform<string>`),
  '0,COMM_TURNED_ON,A,blue,Comm,microwave_link,WSF_RADIO_TRANSCEIVER',
  '0,JAMMING_REQUEST_INITIATED,B,jammer,broadband_jamming,1,2.4e9,2e7,',
  '1,JAMMING_REQUEST_UPDATED,B,jammer,broadband_jamming,2,2.4e9,5e7,',
  '2,JAMMING_REQUEST_CANCELED,B,jammer,broadband_jamming,1,2.4e9,5e7,',
  '3,JAMMING_REQUEST_CANCELED,B,jammer,broadband_jamming,0,2.4e9,5e7,',
  '2300,COMM_TURNED_ON,A,blue,Comm,microwave_link,WSF_RADIO_TRANSCEIVER',
  '2300.437,COMM_TURNED_OFF,A,blue,Comm,microwave_link,WSF_RADIO_TRANSCEIVER',
].join('\n')
const read = (text = CSV) => buildFileDeviceEvents(parseAfsimEventLog(text).events, new Set(['A', 'B']))

describe('文件设备事件投影', () => {
  it('关联按两端设备证据判定开启、关闭、未知，合并线保留仍开启的关联', () => {
    const link: FileCommunicationLink = {
      id: 'SAT-A-B', type: 'SAT', sourcePlatformId: 'A', targetPlatformId: 'B', records: [{
        sourceEventId: 'LINK-1', time: 0, scope: 'INTER_PLATFORM', sourceType: 'WSF_RADIO_TRANSCEIVER', targetType: 'WSF_RADIO_TRANSCEIVER',
        source: { platformName: 'A', communicationName: 'sat_link', address: '1' },
        target: { platformName: 'B', communicationName: 'sat_link', address: '2' },
      }],
    }
    const a: FileDeviceEvent = { sourceEventId: 'ON-A', time: 0, platformId: 'A', deviceId: 'sat_link', kind: 'COMMUNICATION', active: true }
    const b: FileDeviceEvent = { ...a, sourceEventId: 'ON-B', platformId: 'B' }
    expect(fileLinkDeviceStatus(link, [])).toBe('未知')
    expect(fileLinkDeviceStatus(link, [a])).toBe('未知')
    expect(fileLinkDeviceStatus(link, [a, b])).toBe('开启')
    expect(fileLinkDeviceStatus(link, [a, { ...b, active: false }])).toBe('关闭')
    expect(fileLinkDeviceStatus(link, [{ ...a, active: false }])).toBe('关闭')
    expect(fileLinkDeviceStatus(link, [{ ...a, kind: 'JAMMING' }, b])).toBe('未知')
    expect(fileLinkDeviceStatus(link, [{ ...a, platformId: 'OTHER' }, b])).toBe('未知')
    expect(fileLinkDeviceStatus(link, [{ ...a, deviceId: 'microwave_link' }, b])).toBe('未知')
    const second = { ...link.records[0]!, source: { ...link.records[0]!.source, communicationName: 'sat_link_b' } }
    const merged = { ...link, records: [...link.records, second] }
    const off = { ...a, active: false }
    expect(fileLinkDeviceStatus(merged, [off, b])).toBe('未知')
    expect(fileLinkDeviceStatus(merged, [off, b, { ...a, deviceId: 'sat_link_b' }])).toBe('开启')
    expect(fileLinkDeviceStatus(merged, [off, b, { ...off, deviceId: 'sat_link_b' }])).toBe('关闭')
    expect(fileLinkDeviceStatus({ ...link, records: [] }, [])).toBe('未知')
  })

  it('解析射频干扰设备关闭，保留原始时刻和身份，不补造参数，不影响另一设备', () => {
    const csv = [
      '! JAMMING_REQUEST_INITIATED,time<time>,event<string>,platform<string>,weapon<string>,current_mode<string>,active_requests_(eM_Xmtrs)<int>,frequency<double>,bandwidth<double>,target_platform<string>',
      '! WEAPON_TURNED_OFF,time<time>,event<string>,platform<string>,side<string>,type<string>,system_platform<string>,system_type<string>',
      '0,JAMMING_REQUEST_INITIATED,A,alq99_jammer,broadband_jamming,1,2.4e9,2e7,',
      '1666.178,JAMMING_REQUEST_INITIATED,B,prophet_jammer,broadband_jamming,1,2.4e9,5e7,',
      '2806.178,WEAPON_TURNED_OFF,B,red,Weapon,prophet_jammer,WSF_RF_JAMMER',
    ].join('\n')
    const events = read(csv)
    const off = events[2]!
    expect(off).toEqual({ sourceEventId: 'LOG-L5', time: 2806.178, platformId: 'B', deviceId: 'prophet_jammer', kind: 'JAMMING', active: false })
    expect(selectFileDeviceStates(events, 2806.177)).toEqual(events.slice(0, 2))
    expect(selectFileDeviceStates(events, 2806.178)).toEqual([events[0], off])
    expect(selectFileDeviceStates(events, 1666.178)).toEqual(events.slice(0, 2))
    expect(isFileDeviceEvent(off, new Set(['A', 'B']))).toBe(true)
    for (const change of [{ active: true }, { frequencyHz: 2.4e9 }, { bandwidthHz: 5e7 }, { frequencyHz: -1, bandwidthHz: 5e7 }]) {
      expect(isFileDeviceEvent({ ...off, ...change }, new Set(['A', 'B']))).toBe(false)
    }
    expect(read(csv.replace('Weapon,prophet_jammer,WSF_RF_JAMMER', 'Weapon,missile,WSF_EXPLICIT_WEAPON'))).toHaveLength(2)
    expect(() => read(csv.replace('OFF,B,red', 'OFF,UNKNOWN,red'))).toThrow(/第 .* 行/)
    expect(() => read(csv.replace('Weapon,prophet_jammer,WSF_RF_JAMMER', 'Weapon,,WSF_RF_JAMMER'))).toThrow(/第 .* 行/)
  })

  it('保留真实时间、身份和参数，取消部分请求不错误关闭仍有请求的设备', () => {
    const events = read()
    expect(events).toHaveLength(7)
    expect(events[1]).toMatchObject({ kind: 'JAMMING', platformId: 'B', deviceId: 'jammer', time: 0, active: true, frequencyHz: 2.4e9, bandwidthHz: 2e7 })
    expect(selectFileDeviceStates(events, 2).find(event => event.kind === 'JAMMING')).toMatchObject({ active: true, bandwidthHz: 5e7 })
    expect(selectFileDeviceStates(events, 3).find(event => event.kind === 'JAMMING')?.active).toBe(false)
    expect(selectFileDeviceStates(events, 2300).find(event => event.kind === 'COMMUNICATION')?.active).toBe(true)
    expect(selectFileDeviceStates(events, 2300.437).find(event => event.kind === 'COMMUNICATION')?.active).toBe(false)
    expect(selectFileDeviceStates(events, 0)).toEqual(events.slice(0, 2))
    expect(selectFileDeviceStates([], 5400)).toEqual([])
    expect(JSON.stringify(events)).not.toMatch(/"(?:snr|ber|linkStatus|targetPlatformId)":/)
  })

  it('不同设备独立，乱序按时刻选择，同刻按源文件顺序，重算不修改原始数据', () => {
    const events = read()
    const before = structuredClone(events)
    const other: FileDeviceEvent = { ...events[1]!, deviceId: 'jammer-2', sourceEventId: 'LOG-L90' }
    const sameTimeOff: FileDeviceEvent = { ...other, sourceEventId: 'LOG-L91', active: false }
    expect(selectFileDeviceStates([events[6]!, events[0]!, other], 2400)).toEqual([events[6], other])
    expect(selectFileDeviceStates([other, sameTimeOff], 0)).toEqual([sameTimeOff])
    expect(events).toEqual(before)
  })

  it.each([
    ['空设备', 'B,jammer,broadband', 'B,,broadband'],
    ['未知节点', 'B,jammer,broadband', 'UNKNOWN,jammer,broadband'],
    ['空请求数', 'broadband_jamming,1,2.4e9', 'broadband_jamming,,2.4e9'],
    ['负请求数', 'broadband_jamming,1,2.4e9', 'broadband_jamming,-1,2.4e9'],
    ['小数请求数', 'broadband_jamming,1,2.4e9', 'broadband_jamming,0.5,2.4e9'],
    ['空频率', ',2.4e9,2e7,', ',,2e7,'],
    ['零带宽', ',2.4e9,2e7,', ',2.4e9,0,'],
  ])('拒绝%s，不输出虚假成功状态', (_, source, replacement) => {
    expect(() => read(CSV.replace(source, replacement))).toThrow(/第 .* 行/)
  })

  it('旧快照兼容；设备字段、重复事件或跨节点响应非法时拒绝整份快照', () => {
    expect(isInitialNodeSnapshot(LOCAL_REPLAY.initial)).toBe(true)
    const events = read()
    const initial = { ...LOCAL_REPLAY.initial, deviceEvents: events }
    expect(isInitialNodeSnapshot(initial)).toBe(true)
    const event = events[1]!
    for (const changes of [
      { time: -1 }, { time: Infinity }, { active: 'true' }, { kind: ['JAMMING'] },
      { platformId: 'OTHER' }, { deviceId: '' }, { sourceEventId: '' },
      { frequencyHz: 0 }, { frequencyHz: undefined }, { bandwidthHz: NaN },
      { kind: 'COMMUNICATION' },
    ]) expect(isInitialNodeSnapshot({ ...initial, deviceEvents: [{ ...event, ...changes }] })).toBe(false)
    expect(isInitialNodeSnapshot({ ...initial, deviceEvents: [event, event] })).toBe(false)
    expect(isInitialNodeSnapshot({ ...initial, deviceEvents: [null] })).toBe(false)
    expect(isInitialNodeSnapshot({ ...initial, deviceEvents: {} })).toBe(false)
    expect(isLocalReplaySnapshot({ ...LOCAL_REPLAY, initial, durationS: 2300.437 })).toBe(true)
    expect(isLocalReplaySnapshot({ ...LOCAL_REPLAY, initial })).toBe(false)
  })
})

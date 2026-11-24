import { describe, expect, it } from 'vitest'
import { engineJammerNodes, selectDetectionRanges, selectInterferenceRanges } from '../../src/features/situation/interference-ranges'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'
import sample from '../fixtures/engine-frame/websocket-new/fream_chenge2.json'
import { SITUATION_FRAME_F00042 } from '../../src/features/situation/situation-model'
import type { FileDeviceEvent } from '../../src/features/situation/file-device-events'

const node = SITUATION_FRAME_F00042.platforms[0]!
const configured = [
  { id: 'JAM-ONE', platformId: node.platformId, jammingRange: 5000 },
  { id: 'JAM-TWO', platformId: node.platformId, jammingRange: 17000 },
]

describe('设备干扰配置范围', () => {
  it('同平台唯一引擎设备的位置和10海里范围覆盖配置，且不改原始节点', () => {
    const frame = adaptEngineFrameSnapshot(sample).data!
    const jammer = frame.jammers[0]!
    const nodes = [{ ...node, platformId: jammer.platformId! }]
    const configured = [{ id: 'J-1', platformId: jammer.platformId!, jammingRange: 1000 }]
    const before = JSON.stringify(nodes)
    expect(engineJammerNodes(nodes, frame)[0]).toMatchObject({ longitude: 121.55, latitude: 25.15, positionSource: 'ENGINE', time: frame.simulationTime })
    expect(engineJammerNodes([{ ...nodes[0]!, time: frame.simulationTime, heading: 90 }], frame)[0]?.heading).toBe(90)
    expect(engineJammerNodes([{ ...nodes[0]!, time: frame.simulationTime + 1, heading: 90 }], frame)[0]?.heading).toBeUndefined()
    expect(selectInterferenceRanges(nodes, null, configured, [], frame)).toEqual([
      expect.objectContaining({ radiusMeters: 18520, jammerId: 'J-1', configured: false, sourceLabel: '引擎报告范围' }),
    ])
    expect(JSON.stringify(nodes)).toBe(before)
    expect(selectInterferenceRanges(nodes, null, configured, [], { ...frame, jammers: [] })[0]).toMatchObject({ configured: true, radiusMeters: 1000 })
    expect(selectInterferenceRanges(nodes, null, configured, [], { ...frame, jammers: [{ ...jammer, deviceStatus: 'OFF' }] })).toEqual([])
    expect(selectInterferenceRanges(nodes, null, configured, [], { ...frame, jammers: [{ ...jammer, rangeM: 0 }] })).toEqual([])
    expect(selectInterferenceRanges(nodes, null, configured, [], { ...frame, jammers: [{ ...jammer, deviceStatus: null }] })[0]!.sourceLabel).toContain('启停未确认')
  })

  it('身份未知、重复平台和非法位置不猜测映射，缺失半径保留标明来源的配置值', () => {
    const frame = adaptEngineFrameSnapshot(sample).data!, jammer = frame.jammers[0]!
    const nodes = [{ ...node, platformId: jammer.platformId! }]
    for (const jammers of [[{ ...jammer, platformId: null }], [jammer, jammer]]) {
      expect(engineJammerNodes(nodes, { ...frame, jammers })).toEqual(nodes)
      expect(selectInterferenceRanges(nodes, null, undefined, [], { ...frame, jammers })).toEqual([])
    }
    expect(engineJammerNodes(nodes, { ...frame, jammers: [{ ...jammer, position: { longitude: 181, latitude: 25, altitudeM: null } }] })).toEqual(nodes)
    const configured = [{ id: 'J-1', platformId: jammer.platformId!, jammingRange: 1000 }]
    expect(selectInterferenceRanges(nodes, null, configured, [], { ...frame, jammers: [{ ...jammer, rangeM: null }] })[0]!.configured).toBe(true)
  })
  it('同一节点上不同设备分别使用自己的米制半径', () => {
    expect(selectInterferenceRanges([node], null, configured).map(range =>
      [range.jammerId, range.radiusMeters, range.configured])).toEqual([
      ['JAM-ONE', 5000, true], ['JAM-TWO', 17000, true],
    ])
  })

  it('不为无效范围、缺失节点或明确为空的配置补示意值', () => {
    for (const jammingRange of [0, -1, NaN, Infinity]) {
      expect(selectInterferenceRanges([node], null, [{ ...configured[0]!, jammingRange }])).toEqual([])
    }
    expect(selectInterferenceRanges([], null, configured)).toEqual([])
    expect(selectInterferenceRanges(SITUATION_FRAME_F00042.platforms, SITUATION_FRAME_F00042, [])).toEqual([])
  })

  it('运行帧按平台和设备双身份匹配，只显示活动设备范围', () => {
    const frame = structuredClone(SITUATION_FRAME_F00042)
    const platform = frame.platforms.find(platform => platform.jammers.some(jammer => jammer.active))!
    const active = platform.jammers.find(jammer => jammer.active)!
    const jammers = [
      { id: active.jammerId, platformId: platform.platformId, jammingRange: 19000 },
      { id: active.jammerId, platformId: node.platformId, jammingRange: 9000 },
      { id: 'INACTIVE', platformId: platform.platformId, jammingRange: 21000 },
    ]
    const ranges = selectInterferenceRanges(frame.platforms, frame, jammers)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]).toMatchObject({ jammerId: active.jammerId, radiusMeters: 19000, configured: true })
    active.active = false
    expect(selectInterferenceRanges(frame.platforms, frame, jammers)).toEqual([])
  })

  it('缺配置日志的范围保持示意来源，启停事件不能当成真实覆盖', () => {
    const event: FileDeviceEvent = { sourceEventId: 'EV-1', time: 0, platformId: node.platformId,
      deviceId: 'JAM-ONE', kind: 'JAMMING', active: true }
    expect(selectInterferenceRanges([node], null, undefined, [event])).toEqual([
      expect.objectContaining({ radiusMeters: 24 * 1852, configured: false }),
    ])
    expect(selectInterferenceRanges([node], null, undefined, [{ ...event, active: false }])).toEqual([])
    expect(selectInterferenceRanges([node], null, undefined, [])).toEqual([])
  })
})

describe('地面干扰站与机载干扰平台探测范围', () => {
  const groundStation = { ...node, platformId: 'STN-GND', name: '地面干扰站', type: 'GROUND_JAMMER_DETECTION_STATION' }
  const airbornePlatform = { ...node, platformId: 'AJ-AIR', name: '机载干扰平台', type: 'AIRBORNE_JAMMER_PLATFORM', altitude: 3000 }
  const uavNode = { ...node, platformId: 'UAV-1', name: '任务无人机', type: 'AIRBORNE_MISSION_CLUSTER' }

  it('场景与仿真配置为地面干扰站和机载干扰平台提供探测范围，忽略非干扰平台和无效值', () => {
    const jammers = [
      { id: 'JAM-GND', platformId: 'STN-GND', jammingRange: 44448, detectionRange: 55560 },
      { id: 'JAM-AIR', platformId: 'AJ-AIR', jammingRange: 30000, detectionRange: 60000 },
      { id: 'JAM-UAV', platformId: 'UAV-1', jammingRange: 20000, detectionRange: 40000 },
    ]
    expect(selectDetectionRanges([groundStation, airbornePlatform, uavNode], null, jammers, null, [])).toEqual([
      { id: 'configured:JAM-GND', platformId: 'STN-GND', jammerId: 'JAM-GND', radiusMeters: 55560, configured: true, sourceLabel: '配置范围，非实测覆盖' },
      { id: 'configured:JAM-AIR', platformId: 'AJ-AIR', jammerId: 'JAM-AIR', radiusMeters: 60000, configured: true, sourceLabel: '配置范围，非实测覆盖' },
    ])
    for (const detectionRange of [undefined, 0, -1, NaN, Infinity]) {
      expect(selectDetectionRanges([groundStation], null, [{ id: 'JAM-GND', platformId: 'STN-GND', jammingRange: 1000, detectionRange }], null, [])).toEqual([
        { id: 'configured:JAM-GND', platformId: 'STN-GND', jammerId: 'JAM-GND', radiusMeters: 19520, configured: false, sourceLabel: '默认范围（干扰范围 + 10 海里）' },
      ])
    }
    for (const jammingRange of [0, -1, NaN, Infinity]) {
      expect(selectDetectionRanges([groundStation], null, [{ id: 'JAM-GND', platformId: 'STN-GND', jammingRange }], null, [])).toEqual([])
    }
    expect(selectDetectionRanges([groundStation], null, [], null, [])).toEqual([])
  })

  it('引擎帧报告探测距离时覆盖配置半径，缺省探测按干扰范围加 10 海里兜底，明确关闭时移除', () => {
    const frame = adaptEngineFrameSnapshot(sample).data!
    const engineJammer = frame.jammers[0]!
    const station = { ...groundStation, platformId: engineJammer.platformId! }
    const jammers = [{ id: 'J-1', platformId: station.platformId, jammingRange: 44448, detectionRange: 55560 }]

    expect(selectDetectionRanges([station], null, jammers, frame, [])).toEqual([
      { id: `engine:${station.platformId}`, platformId: station.platformId, jammerId: 'J-1', radiusMeters: 22224, configured: false, sourceLabel: '引擎报告范围' },
    ])
    expect(selectDetectionRanges([station], null, jammers, { ...frame, jammers: [{ ...engineJammer, detections: [] }] }, [])[0]).toMatchObject({
      configured: true, radiusMeters: 55560, sourceLabel: '配置范围，非实测覆盖',
    })
    expect(selectDetectionRanges([station], null, [], { ...frame, jammers: [{ ...engineJammer, detections: [] }] }, [])).toEqual([
      { id: `engine:${station.platformId}`, platformId: station.platformId, jammerId: engineJammer.name!, radiusMeters: 37040, configured: false, sourceLabel: '默认范围（干扰范围 + 10 海里）' },
    ])
    expect(selectDetectionRanges([station], null, [{ id: 'J-1', platformId: station.platformId, jammingRange: 1000 }], { ...frame, jammers: [{ ...engineJammer, detections: [] }] }, [])).toEqual([
      { id: `engine:${station.platformId}`, platformId: station.platformId, jammerId: 'J-1', radiusMeters: 37040, configured: false, sourceLabel: '默认范围（干扰范围 + 10 海里）' },
    ])
    expect(selectDetectionRanges([station], null, [], { ...frame, jammers: [{ ...engineJammer, deviceStatus: 'OFF', detections: [] }] }, [])).toEqual([])
    expect(selectDetectionRanges([station], null, jammers, { ...frame, jammers: [{ ...engineJammer, detectStatus: 'OFF' }] }, [])).toEqual([])
    expect(selectDetectionRanges([station], null, jammers, { ...frame, jammers: [engineJammer, engineJammer] }, [])[0]).toMatchObject({
      configured: true, radiusMeters: 55560,
    })
  })

  it('文件模式保留指定 50 公里探测范围，切入空场景配置后移除示意圈', () => {
    const stationFile = { ...node, platformId: 'jammer_station_01', type: 'HIGH_ALT_COMMS_PLATFORM' }
    const airborneFile = { ...node, platformId: 'jammer_airborne_01', type: 'HIGH_ALT_COMMS_PLATFORM' }
    expect(selectDetectionRanges([stationFile, airborneFile], null)).toEqual([
      { id: 'file:jammer_station_01', platformId: 'jammer_station_01', radiusMeters: 50_000, configured: false, sourceLabel: '指定范围' },
      { id: 'file:jammer_airborne_01', platformId: 'jammer_airborne_01', radiusMeters: 50_000, configured: false, sourceLabel: '指定范围' },
    ])
    expect(selectDetectionRanges([stationFile, airborneFile], null, undefined, null, [])).toEqual([])
  })
})

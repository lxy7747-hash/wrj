import { describe, expect, it } from 'vitest'
import { engineJammerNodes, selectInterferenceRanges } from '../../src/features/situation/interference-ranges'
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

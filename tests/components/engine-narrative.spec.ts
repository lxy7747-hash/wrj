import { describe, expect, it } from 'vitest'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'
import { extractActiveJammingOverlay, extractEngineMapStoryBanner } from '../../src/features/situation/engine-narrative'
import { localizeReplayTimelineMarkers } from '../../src/features/replays/replay-situation'
import type { ScenarioConfig } from '../../src/contracts/domain-models'
import type { SituationMapNode } from '../../src/features/situation/initial-nodes'
import jamFrameRaw from '../fixtures/engine-frame/websocket-new/fream_chenge2.json'
import switchFrameRaw from '../fixtures/engine-frame/websocket-new/fream_chenge3.json'

const nodes: SituationMapNode[] = [
  { platformId: 'jammer_station_01', name: '地面干扰站 1', type: 'GROUND_JAMMER_DETECTION_STATION', longitude: 121.55, latitude: 25.15, altitude: 0, speed: 0 },
  { platformId: 'rear_comm_vehicle', name: '后方指挥节点', type: 'REAR_COMMAND_NODE', longitude: 119.3, latitude: 26.0, altitude: 0, speed: 0 },
  { platformId: 'mission_uav_01', name: '高空中继 1', type: 'FORWARD_RELAY_NODE', longitude: 120.5, latitude: 25.5, altitude: 5000, speed: 50 },
  { platformId: 'mission_uav_02', name: '作业无人机 2', type: 'AIRBORNE_MISSION_CLUSTER', longitude: 121.1, latitude: 25.2, altitude: 3600, speed: 40 },
  { platformId: 'mission_uav_03', name: '作业无人机 3', type: 'AIRBORNE_MISSION_CLUSTER', longitude: 121.38, latitude: 25.09, altitude: 3689, speed: 40 },
]

describe('engine-narrative', () => {
  it('从真实干扰帧提取活跃压制源与干扰射线，并生成受扰播报胶囊', () => {
    const adapted = adaptEngineFrameSnapshot(jamFrameRaw)
    expect(adapted.data).not.toBeNull()
    const frame = adapted.data!
    // 给测试样本补充平台 ID 映射（与服务端映射行为一致）
    frame.jammers[0]!.platformId = 'jammer_station_01'
    frame.jammers[0]!.actions[0]!.targetPlatformId = 'mission_uav_03'
    for (const seg of frame.links) {
      seg.sourcePlatformId = seg.sourceName
      seg.targetPlatformId = seg.targetName
      for (const j of seg.inputTrace.jammers) j.platformId = j.jammerName
    }

    const overlay = extractActiveJammingOverlay(frame, nodes)
    expect(overlay.activeJammerPlatformIds.has('jammer_station_01')).toBe(true)
    expect(overlay.beams.some(b => b.jammerPlatformId === 'jammer_station_01' && b.targetPlatformId === 'mission_uav_03')).toBe(true)

    const banner = extractEngineMapStoryBanner(frame, nodes)
    expect(banner).toHaveLength(1)
    expect(banner[0]!.kind).toBe('JAMMED')
    expect(banner[0]!.summary).toContain('作业无人机 3')
    expect(banner[0]!.detail).toContain('63.4 dB')
  })

  it('同帧既有链路干扰损耗又有路由切换时，并排输出「链路受扰 → 已切换链路」双阶段因果胶囊', () => {
    const adapted = adaptEngineFrameSnapshot(switchFrameRaw)
    expect(adapted.data).not.toBeNull()
    const frame = adapted.data!
    for (const seg of frame.links) {
      seg.sourcePlatformId = seg.sourceName
      seg.targetPlatformId = seg.targetName
      for (const j of seg.inputTrace.jammers) j.platformId = j.jammerName
    }
    for (const sw of frame.routing.switches) {
      sw.targetPlatformId = sw.targetName
      for (const node of sw.nodes) node.platformId = node.platformName
    }

    const overlay = extractActiveJammingOverlay(frame, nodes)
    expect(overlay.activeJammerPlatformIds.has('jammer_station_01')).toBe(true)
    expect(overlay.beams).toEqual([
      expect.objectContaining({
        jammerPlatformId: 'jammer_station_01',
        targetPlatformId: 'mission_uav_02',
      }),
      expect.objectContaining({
        jammerPlatformId: 'jammer_station_01',
        targetPlatformId: 'mission_uav_03',
      }),
    ])

    const banner = extractEngineMapStoryBanner(frame, nodes)
    expect(banner.map(item => item.kind)).toEqual(['JAMMED', 'SWITCH'])
    expect(banner[0]!.detail).toContain('55.3 dB')
    expect(banner[1]!.tag).toBe('已切换链路')
    expect(banner[1]!.summary).toContain('路由切换')
    expect(banner[1]!.detail).toContain('受扰告警触发')
  })

  it('将时间轴里的英文平台标识与冗长波段名替换为场景中文名称和简洁通信体制', () => {
    const sceneConfig = {
      platforms: [
        { id: 'PLT-RELAY-1', name: '高空中继 1 号', type: 'FORWARD_RELAY_NODE' },
        { id: 'PLT-UAV-1', name: '作业无人机 1 号', type: 'AIRBORNE_MISSION_CLUSTER' },
        { id: 'PLT-JAM-1', name: '东侧地面干扰站', type: 'GROUND_JAMMER_DETECTION_STATION' },
      ],
    } as unknown as ScenarioConfig

    const localized = localizeReplayTimelineMarkers([
      { id: '1', kind: 'DETECTION', time: 1160, frameId: 1160, label: '目标侦测', detail: 'jammer_station_01 → mission_uav_02' },
      { id: '2', kind: 'SWITCH', time: 1152, frameId: 1152, label: '链路切换', detail: '切至 光纤/C 波段上行/微波（mission_uav_02）' },
      { id: '3', kind: 'DETECTION', time: 1161, frameId: 1161, label: '目标侦测', detail: 'jammer_station_01 → mission_uav_03' },
    ], sceneConfig, { 'PLT-UAV-1': '作业无人机 1 号', 'PLT-JAM-1': '东侧地面干扰站' })

    expect(localized[0]!.detail).toBe('东侧地面干扰站 → 作业无人机 1 号')
    expect(localized[1]!.detail).toBe('切至 光纤/数传/微波（作业无人机 1 号）')
    expect(localized[2]!.detail).toBe('东侧地面干扰站 → 无人节点 3')
  })
})

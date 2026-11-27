import { describe, expect, it } from 'vitest'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'
import {
  clearJammerVisualMemory,
  createJammerVisualMemory,
  extractActiveJammingOverlay,
  extractEngineMapStoryBanner,
  resolveJammerVisualStates,
  SWITCH_BANNER_RETENTION_SECONDS,
  summarizeHoverJammingLines,
  summarizeSegmentJammingEvidence,
} from '../../src/features/situation/engine-narrative'
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
    expect(banner[1]!.summary).toContain('微波')
    expect(banner[1]!.detail).toContain('新路径：')
    expect(banner[1]!.thresholds?.[0]).toContain('质量告警')

    const berFrame = structuredClone(frame)
    berFrame.routing.switches[0]!.reasons = [{ linkId: 'L-1', reasons: ['ber_switch', 'bey_switch', 'beyond_weitch'] }]
    const berBanner = extractEngineMapStoryBanner(berFrame, nodes)
    expect(berBanner[1]!.thresholds).toEqual([
      '误码超标 · 劣化 1e-6 / 中断 1e-5',
      '超视距 · 超出最大通信距离',
    ])
  })

  it('链路切换横幅明确给出超视距距离上限、误码门限实测值与自定义场景阈值，且切链帧过后仍保持展示', () => {
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

    // 1) 超视距切换：分别验证中继↔作业机（60 km 上限）与指挥车↔作业机（240 km 上限）
    const beyFrame = structuredClone(frame)
    const relayUavSeg = beyFrame.links.find(item => item.sourcePort === 'c_band_uplink' && item.sourceName === 'mission_uav_01')!
    relayUavSeg.distanceM = 64500
    beyFrame.routing.switches[0]!.reasons = [{ linkId: relayUavSeg.linkId, reasons: ['bey_switch'] }]
    const relayBanner = extractEngineMapStoryBanner(beyFrame, nodes)
    expect(relayBanner[1]!.threshold).toContain('超视距 · C 波段上行 64.5 > 60 km')

    const cmdUavSeg = beyFrame.links.find(item => item.sourcePort === 'c_band_uplink' && item.sourceName === 'command_vehicle')
      ?? { ...relayUavSeg, linkId: 'SEG-CMD-UAV', linkIds: ['SEG-CMD-UAV'], sourceName: 'command_vehicle', sourcePlatformId: 'command_vehicle', targetName: 'mission_uav_02', targetPlatformId: 'mission_uav_02' }
    cmdUavSeg.distanceM = 242340
    if (!beyFrame.links.includes(cmdUavSeg)) beyFrame.links.push(cmdUavSeg)
    beyFrame.routing.switches[0]!.reasons = [{ linkId: cmdUavSeg.linkId, reasons: ['bey_switch'] }]
    const beyBanner = extractEngineMapStoryBanner(beyFrame, nodes)
    expect(beyBanner[1]!.threshold).toContain('超视距 · C 波段上行 242.3 > 240 km')

    // 1.5) 下一帧不再带 routing.switches 时，借助 latestSwitch 与缓存证据继续展示最近一次切换及阈值
    const nextFrame = structuredClone(beyFrame)
    nextFrame.frameId = beyFrame.frameId + 1
    nextFrame.simulationTime = beyFrame.simulationTime + 5
    nextFrame.routing.switches = []
    nextFrame.events = []
    const persistedBanner = extractEngineMapStoryBanner(
      nextFrame,
      nodes,
      undefined,
      undefined,
      { frameId: beyFrame.frameId, simulationTime: beyFrame.simulationTime, route: beyFrame.routing.switches[0]! },
      { links: beyFrame.links, alarms: beyFrame.routing.alarms, events: beyFrame.events },
    )
    const switchPill = persistedBanner.find(item => item.kind === 'SWITCH')
    expect(switchPill).toBeDefined()
    expect(switchPill!.timeS).toBe(beyFrame.simulationTime)
    expect(switchPill!.threshold).toContain('超视距 · C 波段上行 242.3 > 240 km')

    // 1.6) 无缓存旧链路实测（如历史回放直接跳到切链之后）也能从 oldNodes 推出具体体制的上限，并省略固定光纤
    const jumpedRoute = structuredClone(beyFrame.routing.switches[0]!)
    jumpedRoute.oldNodes = [
      { platformId: 'mission_uav_02', platformName: 'mission_uav_02', inPort: '', outPort: 'c_band_downlink' },
      { platformId: 'command_vehicle', platformName: 'command_vehicle', inPort: 'c_band_downlink', outPort: 'fiber_link' },
      { platformId: 'rear_comm_vehicle', platformName: 'rear_comm_vehicle', inPort: 'fiber_link', outPort: '' },
    ]
    jumpedRoute.reasons = [{ linkId: 'UNKNOWN-OLD-LINK', reasons: ['bey_switch'] }]
    const jumpedBanner = extractEngineMapStoryBanner(
      nextFrame,
      nodes,
      undefined,
      undefined,
      { frameId: beyFrame.frameId, simulationTime: beyFrame.simulationTime, route: jumpedRoute },
      null,
    )
    const jumpedSwitch = jumpedBanner.find(item => item.kind === 'SWITCH')
    expect(jumpedSwitch!.summary).not.toContain('光纤')
    expect(jumpedSwitch!.threshold).toBe('超视距 · C 波段下行 > 240 km')

    // 2) 误码劣化切换：实测 BER 触发自定义紧急门限 + 干扰损耗
    const berFrame = structuredClone(frame)
    const jammedSeg = berFrame.links.find(item => (item.losses.jammingDb ?? 0) > 0)!
    jammedSeg.quality.ber = 2.4e-5
    berFrame.routing.switches[0]!.reasons = [{ linkId: jammedSeg.linkId, reasons: ['ber_switch'] }]
    const berBanner = extractEngineMapStoryBanner(berFrame, nodes, undefined, {
      emergencyThreshold: 2e-5,
      warningThreshold: 2e-6,
      valueThresholdBer: 1e-7,
    })
    expect(berBanner[1]!.threshold).toContain('误码 2.4e-5 ≥ 中断 2e-5')
    expect(berBanner[1]!.threshold).toContain('干扰 55.3 dB')

    // 3) 告警切换且无 linkId 时不编造实测数，明确给出配置门限
    const alarmFrame = structuredClone(frame)
    alarmFrame.routing.switches[0]!.oldNodes = []
    alarmFrame.routing.switches[0]!.reasons = [{ linkId: null, reasons: ['alarm_switch'] }]
    const alarmBanner = extractEngineMapStoryBanner(alarmFrame, nodes, undefined, {
      emergencyThreshold: 5e-5,
      warningThreshold: 5e-6,
    })
    expect(alarmBanner[1]!.threshold).toContain('质量告警 · 劣化 5e-6 / 中断 5e-5')
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

  it('从受扰链路段提取完整受扰依据、频段对照与地图悬停干扰来源，区分非干扰衰落', () => {
    const frame = adaptEngineFrameSnapshot(switchFrameRaw).data!
    const jammedSegment = frame.links.find(item => (item.losses.jammingDb ?? 0) > 0)!
    const evidence = summarizeSegmentJammingEvidence(
      jammedSegment,
      (_id, engineName) => engineName === 'jammer_station_01' ? '东侧地面干扰站' : (engineName ?? ''),
      [{ name: 'jammer_station_01', platformId: null, detectStatus: 'DETECTED', deviceStatus: 'ON', powerW: 200, frequencyHz: 2.4e9, rangeM: 18520, engineMode: 'broadband', detections: [], actions: [] }],
    )
    expect(evidence.isJammed).toBe(true)
    expect(evidence.shouldShow).toBe(true)
    expect(evidence.summary).toContain('受 东侧地面干扰站 电磁压制')
    expect(evidence.summary).toContain('干扰损耗 55.26 dB')
    expect(evidence.summary).toContain('干信比 -6.32 dB')
    expect(evidence.jammers[0]).toMatchObject({
      jammerName: '东侧地面干扰站',
      modeLabel: '宽带压制',
      freqMatchNote: '同频/邻频覆盖',
      eirpDbw: 40,
    })

    const hover = summarizeHoverJammingLines([jammedSegment], (_id, engineName) => engineName === 'jammer_station_01' ? '东侧地面干扰站' : (engineName ?? ''))
    expect(hover.jammingLoss).toBe('55.26 dB')
    expect(hover.jammingSource).toContain('东侧地面干扰站')
    expect(hover.jammingSource).toContain('73.13 km')
    expect(hover.jammingSource).toContain('40 dBW')

    const nonJammedDown = {
      ...structuredClone(jammedSegment),
      status: 'DOWN' as const,
      losses: { ...jammedSegment.losses, jammingDb: 0, rainDb: 4.5 },
      inputTrace: { ...jammedSegment.inputTrace, jammers: [] },
    }
    const nonJammedEvidence = summarizeSegmentJammingEvidence(nonJammedDown)
    expect(nonJammedEvidence.isJammed).toBe(false)
    expect(nonJammedEvidence.shouldShow).toBe(true)
    expect(nonJammedEvidence.title).toContain('非干扰主导')
    expect(nonJammedEvidence.summary).toContain('本帧未检出干扰损耗（0 dB）')
    expect(nonJammedEvidence.summary).toContain('雨衰损耗 4.5 dB')
  })

  it('按目标进出探测/干扰范围准确切换干扰机状态：侦测中 → 开启压制 → 关闭压制，且干扰机互不误触发', () => {
    const jammerStation: SituationMapNode = {
      platformId: 'jammer_station_01', name: '地面干扰站 1', type: 'GROUND_JAMMER_DETECTION_STATION',
      longitude: 121.55, latitude: 25.15, altitude: 0, speed: 0,
    }
    const airborneJammer: SituationMapNode = {
      platformId: 'jammer_airborne_01', name: '机载干扰机 1', type: 'AIRBORNE_JAMMER_PLATFORM',
      longitude: 121.56, latitude: 25.03, altitude: 3000, speed: 80,
    }
    const makeUav = (lon: number, lat: number): SituationMapNode => ({
      platformId: 'mission_uav_02', name: '作业无人机 2', type: 'AIRBORNE_MISSION_CLUSTER',
      longitude: lon, latitude: lat, altitude: 3600, speed: 40,
    })
    const interferenceRanges = [
      { id: 'configured:J1', platformId: 'jammer_station_01', jammerId: 'J1', radiusMeters: 18_520, configured: true },
      { id: 'configured:J2', platformId: 'jammer_airborne_01', jammerId: 'J2', radiusMeters: 18_520, configured: true },
    ]
    const detectionRanges = [
      { id: 'configured:J1', platformId: 'jammer_station_01', jammerId: 'J1', radiusMeters: 37_040, configured: true, sourceLabel: '配置范围' },
      { id: 'configured:J2', platformId: 'jammer_airborne_01', jammerId: 'J2', radiusMeters: 37_040, configured: true, sourceLabel: '配置范围' },
    ]
    const memory = createJammerVisualMemory()

    // 1) 目标在远端（两台干扰机仅相距约 13 km，但互不为目标 → 均为 IDLE）
    const s1 = resolveJammerVisualStates([jammerStation, airborneJammer, makeUav(119.5, 24.8)], interferenceRanges, detectionRanges, null, [], memory)
    expect(s1.get('jammer_station_01')).toMatchObject({ state: 'IDLE', label: '' })
    expect(s1.get('jammer_airborne_01')).toMatchObject({ state: 'IDLE', label: '' })

    // 2) 目标进入地面干扰站探测范围（距站 ~25 km，未进 18.52 km 干扰圈）→ 侦测中
    const s2 = resolveJammerVisualStates([jammerStation, makeUav(121.3, 25.15)], interferenceRanges, detectionRanges, null, [], memory)
    expect(s2.get('jammer_station_01')).toMatchObject({ state: 'DETECTING', label: '侦测中' })

    // 3) 目标进入干扰范围（距站 ~10 km）→ 开启压制
    const s3 = resolveJammerVisualStates([jammerStation, makeUav(121.45, 25.15)], interferenceRanges, detectionRanges, null, [], memory)
    expect(s3.get('jammer_station_01')).toMatchObject({ state: 'JAMMING', label: '开启压制' })

    // 4) 目标飞出干扰范围（仍在探测外环 ~25 km）→ 立即切换为 关闭压制
    const s4 = resolveJammerVisualStates([jammerStation, makeUav(121.3, 25.15)], interferenceRanges, detectionRanges, null, [], memory)
    expect(s4.get('jammer_station_01')).toMatchObject({ state: 'JAMMING_OFF', label: '关闭压制' })

    // 5) 目标彻底飞出探测范围（远端）→ 保持 关闭压制
    const s5 = resolveJammerVisualStates([jammerStation, makeUav(119.5, 24.8)], interferenceRanges, detectionRanges, null, [], memory)
    expect(s5.get('jammer_station_01')).toMatchObject({ state: 'JAMMING_OFF', label: '关闭压制' })

    // 6) 随后目标从外部重新进入探测范围 → 再次回到 侦测中
    const s6 = resolveJammerVisualStates([jammerStation, makeUav(121.3, 25.15)], interferenceRanges, detectionRanges, null, [], memory)
    expect(s6.get('jammer_station_01')).toMatchObject({ state: 'DETECTING', label: '侦测中' })

    // 7) 仅擦边进入探测圈后离开（未开启过压制）→ 回到 IDLE，不误报关闭压制
    const s7 = resolveJammerVisualStates([jammerStation, makeUav(119.5, 24.8)], interferenceRanges, detectionRanges, null, [], memory)
    expect(s7.get('jammer_station_01')).toMatchObject({ state: 'IDLE', label: '' })

    // 8) 引擎帧：仅探测（deviceStatus=OFF + DETECTED）→ 侦测中；release_jamm 事件 → 关闭压制（含地图顶部横幅）
    clearJammerVisualMemory(memory)
    const baseFrame = adaptEngineFrameSnapshot(jamFrameRaw).data!
    baseFrame.links = []
    baseFrame.events = [{ type: 'into_detect', pathId: null, uavNames: ['mission_uav_03'], jammerNames: ['jammer_station_01'], uavIds: ['mission_uav_03'], jammerIds: ['jammer_station_01'] }]
    baseFrame.jammers = [{ ...baseFrame.jammers[0]!, platformId: 'jammer_station_01', detectStatus: 'DETECTED', deviceStatus: 'OFF', actions: [] }]
    const sDetect = resolveJammerVisualStates([jammerStation, makeUav(119.5, 24.8)], [], [], baseFrame, [], memory)
    expect(sDetect.get('jammer_station_01')).toMatchObject({ state: 'DETECTING', label: '侦测中' })
    const detectBanner = extractEngineMapStoryBanner(baseFrame, nodes)
    expect(detectBanner[0]).toMatchObject({ kind: 'DETECT', tag: '侦测中' })

    const releaseFrame = {
      ...baseFrame,
      jammers: [{ ...baseFrame.jammers[0]!, detectStatus: 'UNDETECTED', deviceStatus: 'OFF', detections: [], actions: [{ action: 'JAM_OFF', targetName: 'mission_uav_03', targetPlatformId: 'mission_uav_03', engineMode: 'broadband', mode: 'BARRAGE' as const }] }],
      events: [{ type: 'release_jamm', pathId: null, uavNames: ['mission_uav_03'], jammerNames: ['jammer_station_01'], uavIds: ['mission_uav_03'], jammerIds: ['jammer_station_01'] }],
    }
    const sOff = resolveJammerVisualStates([jammerStation, makeUav(119.5, 24.8)], [], [], releaseFrame, [], memory)
    expect(sOff.get('jammer_station_01')).toMatchObject({ state: 'JAMMING_OFF', label: '关闭压制' })
    const offBanner = extractEngineMapStoryBanner(releaseFrame, nodes)
    expect(offBanner[0]).toMatchObject({ kind: 'JAM_OFF', tag: '关闭压制' })
  })

  it('真实引擎仅进入探测圈时虽上报 deviceStatus=ON 但无 JAM_ON/干扰损耗，仅显示「侦测中」且不提前开启压制', () => {
    const jammerStation: SituationMapNode = {
      platformId: 'jammer_station_01', name: '地面干扰站 1', type: 'GROUND_JAMMER_DETECTION_STATION',
      longitude: 121.55, latitude: 25.15, altitude: 0, speed: 0,
    }
    const uavInDetectOnly: SituationMapNode = {
      platformId: 'mission_uav_02', name: '作业无人机 2', type: 'AIRBORNE_MISSION_CLUSTER',
      longitude: 121.35, latitude: 25.15, altitude: 3000, speed: 40, // ~20 km，处于 25 km 探测圈内、15 km 干扰圈外
    }
    const uavInJamming: SituationMapNode = {
      ...uavInDetectOnly,
      longitude: 121.45, // ~10 km，处于 15 km 干扰圈内
    }
    const uavOutside: SituationMapNode = {
      ...uavInDetectOnly,
      longitude: 119.5, latitude: 24.8,
    }
    const interferenceRanges = [
      { id: 'engine:jammer_station_01', platformId: 'jammer_station_01', jammerId: 'ground_jammer', radiusMeters: 15_000, configured: false },
    ]
    const detectionRanges = [
      { id: 'engine:jammer_station_01', platformId: 'jammer_station_01', jammerId: 'ground_jammer', radiusMeters: 25_000, configured: false, sourceLabel: '引擎报告范围' },
    ]
    const memory = createJammerVisualMemory()

    const detectOnlyFrame = adaptEngineFrameSnapshot(jamFrameRaw).data!
    detectOnlyFrame.links = []
    detectOnlyFrame.events = [
      { type: 'into_detect', pathId: null, uavNames: ['mission_uav_02'], jammerNames: ['jammer_station_01'], uavIds: ['mission_uav_02'], jammerIds: ['jammer_station_01'] },
      { type: 'esm_info', pathId: null, uavNames: ['mission_uav_02'], jammerNames: ['jammer_station_01'], uavIds: ['mission_uav_02'], jammerIds: ['jammer_station_01'] },
    ]
    detectOnlyFrame.jammers = [{
      ...detectOnlyFrame.jammers[0]!,
      platformId: 'jammer_station_01',
      detectStatus: 'DETECTED',
      deviceStatus: 'ON',
      rangeM: 15_000,
      detections: [{
        targetNames: ['mission_uav_02'], targetIds: ['mission_uav_02'], platformType: 'UAV',
        frequencyHz: 2.4e9, probability: 1, rangeM: 25_000, targets: [],
      }],
      actions: [],
    }]

    // 1) 进入探测圈（deviceStatus=ON 但 actions=[]、无干扰损耗）→ 仅显示侦测中，不画干扰射线、不污染已压制记忆
    const overlayDetect = extractActiveJammingOverlay(detectOnlyFrame, [jammerStation, uavInDetectOnly])
    expect(overlayDetect.activeJammerPlatformIds.has('jammer_station_01')).toBe(false)
    expect(overlayDetect.beams).toEqual([])
    const stateDetect = resolveJammerVisualStates([jammerStation, uavInDetectOnly], interferenceRanges, detectionRanges, detectOnlyFrame, [], memory)
    expect(stateDetect.get('jammer_station_01')).toMatchObject({ state: 'DETECTING', label: '侦测中' })
    const bannerDetect = extractEngineMapStoryBanner(detectOnlyFrame, [jammerStation, uavInDetectOnly])
    expect(bannerDetect[0]).toMatchObject({ kind: 'DETECT', tag: '侦测中' })

    // 2) 若仅擦边探测圈后直接离开（从未进入干扰圈）→ 回到 IDLE，不误报关闭压制
    const emptyFrame = { ...detectOnlyFrame, jammers: [], events: [] }
    const stateAfterDetectOnlyLeave = resolveJammerVisualStates([jammerStation, uavOutside], interferenceRanges, detectionRanges, emptyFrame, [], memory)
    expect(stateAfterDetectOnlyLeave.get('jammer_station_01')).toMatchObject({ state: 'IDLE', label: '' })

    // 3) 真正进入干扰圈（into_jamm + JAM_ON）→ 切换为开启压制并绘制压制射线
    const jamActiveFrame = {
      ...detectOnlyFrame,
      events: [
        { type: 'into_jamm', pathId: null, uavNames: ['mission_uav_02'], jammerNames: ['jammer_station_01'], uavIds: ['mission_uav_02'], jammerIds: ['jammer_station_01'] },
        { type: 'esm_info', pathId: null, uavNames: ['mission_uav_02'], jammerNames: ['jammer_station_01'], uavIds: ['mission_uav_02'], jammerIds: ['jammer_station_01'] },
      ],
      jammers: [{
        ...detectOnlyFrame.jammers[0]!,
        actions: [{ action: 'JAM_ON', targetName: 'mission_uav_02', targetPlatformId: 'mission_uav_02', engineMode: 'broadband', mode: 'BARRAGE' as const }],
      }],
    }
    const overlayJam = extractActiveJammingOverlay(jamActiveFrame, [jammerStation, uavInJamming])
    expect(overlayJam.activeJammerPlatformIds.has('jammer_station_01')).toBe(true)
    expect(overlayJam.beams).toHaveLength(1)
    const stateJam = resolveJammerVisualStates([jammerStation, uavInJamming], interferenceRanges, detectionRanges, jamActiveFrame, [], memory)
    expect(stateJam.get('jammer_station_01')).toMatchObject({ state: 'JAMMING', label: '开启压制' })

    // 4) 飞出干扰圈（release_jamm）→ 切换为关闭压制
    const releaseJammFrame = {
      ...detectOnlyFrame,
      jammers: [],
      events: [{ type: 'release_jamm', pathId: null, uavNames: ['mission_uav_02'], jammerNames: ['jammer_station_01'], uavIds: ['mission_uav_02'], jammerIds: ['jammer_station_01'] }],
    }
    const stateOff = resolveJammerVisualStates([jammerStation, uavOutside], interferenceRanges, detectionRanges, releaseJammFrame, [], memory)
    expect(stateOff.get('jammer_station_01')).toMatchObject({ state: 'JAMMING_OFF', label: '关闭压制' })
  })

  it('多架无人机同时受扰或被侦测时完整汇总全部无人机，且切链弹框超时或离开干扰/侦测圈后自动关闭', () => {
    const fourUavNodes: SituationMapNode[] = [
      ...nodes,
      { platformId: 'mission_uav_04', name: '作业无人机 4', type: 'AIRBORNE_MISSION_CLUSTER', longitude: 121.4, latitude: 25.12, altitude: 3600, speed: 40 },
      { platformId: 'mission_uav_05', name: '作业无人机 5', type: 'AIRBORNE_MISSION_CLUSTER', longitude: 121.42, latitude: 25.11, altitude: 3600, speed: 40 },
    ]
    const base = adaptEngineFrameSnapshot(switchFrameRaw).data!
    const templateSeg = base.links.find(seg => (seg.losses.jammingDb ?? 0) > 0)!
    const makeJammedSeg = (id: string, targetId: string, lossDb: number) => ({
      ...structuredClone(templateSeg),
      linkId: id,
      linkIds: [id],
      sourceName: 'mission_uav_01',
      sourcePlatformId: 'mission_uav_01',
      sourcePort: 'microwave_link',
      targetName: targetId,
      targetPlatformId: targetId,
      status: 'DOWN' as const,
      losses: { ...templateSeg.losses, jammingDb: lossDb },
    })

    // 1) 四架无人机同时受扰中断 → 顶部横幅汇总全部 4 架无人机与各自干扰损耗，不再只显示一架
    const fourJammedFrame = {
      ...structuredClone(base),
      frameId: 1237,
      simulationTime: 1237,
      routing: { switches: [], alarms: [] },
      events: [],
      jammers: [],
      links: [
        makeJammedSeg('L2', 'mission_uav_02', 33.7),
        makeJammedSeg('L3', 'mission_uav_03', 33.5),
        makeJammedSeg('L4', 'mission_uav_04', 32.7),
        makeJammedSeg('L5', 'mission_uav_05', 32.5),
      ],
    }
    const makeReverseSwitch = (frameId: number, uavId: string) => ({
      frameId,
      simulationTime: frameId,
      route: {
        ...structuredClone(base.routing.switches[0]!),
        pathId: `PATH-REV-${uavId}`,
        direction: 'REVERSE' as const,
        sourcePlatformId: uavId,
        sourceName: uavId,
        targetPlatformId: 'rear_comm_vehicle',
        targetName: 'rear_comm_vehicle',
        oldNodes: [
          { platformId: uavId, platformName: uavId, inPort: null, outPort: 'c_band_downlink' },
          { platformId: 'command_vehicle', platformName: 'command_vehicle', inPort: 'c_band_downlink', outPort: 'fiber_link' },
          { platformId: 'rear_comm_vehicle', platformName: 'rear_comm_vehicle', inPort: 'fiber_link', outPort: null },
        ],
        nodes: [
          { platformId: uavId, platformName: uavId, inPort: null, outPort: 'microwave_link' },
          { platformId: 'mission_uav_01', platformName: 'mission_uav_01', inPort: 'microwave_link', outPort: 'c_band_downlink' },
          { platformId: 'command_vehicle', platformName: 'command_vehicle', inPort: 'c_band_downlink', outPort: 'fiber_link' },
          { platformId: 'rear_comm_vehicle', platformName: 'rear_comm_vehicle', inPort: 'fiber_link', outPort: null },
        ],
        reasons: [
          { linkId: null, reasons: ['bey_switch'] },
          { linkId: null, reasons: ['ber_switch'] },
        ],
      },
    })
    const fourUavSwitches = [
      makeReverseSwitch(1152, 'mission_uav_02'),
      makeReverseSwitch(1153, 'mission_uav_03'),
      makeReverseSwitch(1154, 'mission_uav_04'),
      makeReverseSwitch(1155, 'mission_uav_05'),
    ]
    const staleSwitch = fourUavSwitches[3]!
    const jammedBanner = extractEngineMapStoryBanner(fourJammedFrame, fourUavNodes, undefined, undefined, staleSwitch, null, fourUavSwitches)
    // 仍在干扰圈活跃期内：红框/蓝框主文本保持恒定紧凑，不堆叠长串机名；全部 4 架明细收在 targets 折叠列表中
    expect(jammedBanner).toHaveLength(2)
    expect(jammedBanner[0]).toMatchObject({
      kind: 'JAMMED',
      tag: '受扰中断',
    })
    expect(jammedBanner[0]!.stacked).toBeFalsy()
    expect(jammedBanner[0]!.summary).toContain('4 架无人机中断')
    expect(jammedBanner[0]!.detail).toContain('32.5~33.7 dB')
    expect(jammedBanner[0]!.targets).toHaveLength(4)
    expect(jammedBanner[0]!.targets?.map(item => `${item.name} ${item.meta}`)).toEqual([
      '作业无人机 2 33.7 dB',
      '作业无人机 3 33.5 dB',
      '作业无人机 4 32.7 dB',
      '作业无人机 5 32.5 dB',
    ])
    expect(jammedBanner[1]).toMatchObject({
      kind: 'SWITCH',
      tag: '已切换链路',
      timeS: 1155,
    })
    expect(jammedBanner[1]!.summary).toContain('4 架无人机')
    expect(jammedBanner[1]!.detail).toBe('新路径：4 架无人机 → 高空中继 1 → command_vehicle → 后方指挥节点')
    expect(jammedBanner[1]!.thresholds?.length).toBeGreaterThan(0)
    expect(jammedBanner[1]!.targets).toHaveLength(4)
    expect(jammedBanner[1]!.targets?.map(item => item.name)).toEqual([
      '作业无人机 2',
      '作业无人机 3',
      '作业无人机 4',
      '作业无人机 5',
    ])
    // 每条切链明细各自标注自己的触发条件，而不是只在顶部汇总混放
    for (const row of jammedBanner[1]!.targets ?? []) {
      expect(row.thresholds).toEqual([
        '超视距 · C 波段下行 > 240 km',
        '误码超标 · 劣化 1e-6 / 中断 1e-5',
      ])
    }

    // 1.5) 同一架无人机同时发生前向（上行）与返向（下行）切链时，两条链路分别标注各自的触发条件
    const forwardUav2 = {
      frameId: 1152,
      simulationTime: 1152,
      route: {
        ...structuredClone(fourUavSwitches[0]!.route),
        pathId: 'PATH-FWD-mission_uav_02',
        direction: 'FORWARD' as const,
        sourcePlatformId: 'rear_comm_vehicle',
        sourceName: 'rear_comm_vehicle',
        targetPlatformId: 'mission_uav_02',
        targetName: 'mission_uav_02',
        oldNodes: [
          { platformId: 'rear_comm_vehicle', platformName: 'rear_comm_vehicle', inPort: null, outPort: 'fiber_link' },
          { platformId: 'command_vehicle', platformName: 'command_vehicle', inPort: 'fiber_link', outPort: 'c_band_uplink' },
          { platformId: 'mission_uav_02', platformName: 'mission_uav_02', inPort: 'c_band_uplink', outPort: null },
        ],
        nodes: [
          { platformId: 'rear_comm_vehicle', platformName: 'rear_comm_vehicle', inPort: null, outPort: 'fiber_link' },
          { platformId: 'command_vehicle', platformName: 'command_vehicle', inPort: 'fiber_link', outPort: 'c_band_uplink' },
          { platformId: 'mission_uav_01', platformName: 'mission_uav_01', inPort: 'c_band_uplink', outPort: 'microwave_link' },
          { platformId: 'mission_uav_02', platformName: 'mission_uav_02', inPort: 'microwave_link', outPort: null },
        ],
      },
    }
    const dualDirBanner = extractEngineMapStoryBanner(
      fourJammedFrame,
      fourUavNodes,
      undefined,
      undefined,
      fourUavSwitches[0]!,
      null,
      [forwardUav2, fourUavSwitches[0]!],
    )
    expect(dualDirBanner[1]!.targets).toHaveLength(2)
    expect(dualDirBanner[1]!.targets?.[0]).toMatchObject({
      name: '作业无人机 2',
      badge: '前向 · 19:12',
      thresholds: ['超视距 · C 波段上行 > 240 km', '误码超标 · 劣化 1e-6 / 中断 1e-5'],
    })
    expect(dualDirBanner[1]!.targets?.[1]).toMatchObject({
      name: '作业无人机 2',
      badge: '返向 · 19:12',
      thresholds: ['超视距 · C 波段下行 > 240 km', '误码超标 · 劣化 1e-6 / 中断 1e-5'],
    })

    // 2) 四架无人机仅进入侦测圈 → 侦测横幅主行保持紧凑，全部 4 架明细收入 targets
    const fourDetectFrame = {
      ...fourJammedFrame,
      links: [],
      jammers: [{
        name: 'jammer_station_01',
        platformId: 'jammer_station_01',
        detectStatus: 'DETECTED',
        deviceStatus: 'ON',
        powerW: 200,
        frequencyHz: 2.4e9,
        rangeM: 15_000,
        engineMode: 'broadband',
        detections: [{
          targetNames: ['mission_uav_02', 'mission_uav_03', 'mission_uav_04', 'mission_uav_05'],
          targetIds: ['mission_uav_02', 'mission_uav_03', 'mission_uav_04', 'mission_uav_05'],
          platformType: 'UAV',
          frequencyHz: 2.4e9,
          probability: 1,
          rangeM: 25_000,
          targets: [],
        }],
        actions: [],
      }],
    }
    const detectBanner = extractEngineMapStoryBanner(fourDetectFrame, fourUavNodes)
    expect(detectBanner).toHaveLength(1)
    expect(detectBanner[0]).toMatchObject({ kind: 'DETECT', tag: '侦测中' })
    expect(detectBanner[0]!.stacked).toBeFalsy()
    expect(detectBanner[0]!.summary).toContain('4 架无人机')
    expect(detectBanner[0]!.targets?.map(item => item.name)).toEqual([
      '作业无人机 2',
      '作业无人机 3',
      '作业无人机 4',
      '作业无人机 5',
    ])

    // 3) 离开干扰与探测圈后（无受扰/侦测，且切链超过保留窗口或因干扰触发的切链已脱离干扰区）→ 弹框自动关闭
    const exitedFrame = {
      ...fourJammedFrame,
      frameId: 1372,
      simulationTime: 1372,
      links: [],
      jammers: [],
      events: [],
    }
    expect(extractEngineMapStoryBanner(exitedFrame, fourUavNodes, undefined, undefined, staleSwitch, null)).toEqual([])

    // 4) 干扰/误码导致的切链，即便仍在保留窗口内，一旦离开干扰与探测圈也会立即自动关闭
    const recentQualitySwitch = {
      frameId: 1368,
      simulationTime: 1368,
      route: { ...structuredClone(base.routing.switches[0]!), reasons: [{ linkId: 'L2', reasons: ['ber_switch'] }] },
    }
    expect(1372 - recentQualitySwitch.simulationTime).toBeLessThanOrEqual(SWITCH_BANNER_RETENTION_SECONDS)
    expect(extractEngineMapStoryBanner(exitedFrame, fourUavNodes, undefined, undefined, recentQualitySwitch, null)).toEqual([])
  })
})

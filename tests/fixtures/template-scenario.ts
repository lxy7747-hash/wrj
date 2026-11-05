import type { Link, Platform, ScenarioDraft } from '../../src/contracts/domain-models'

/**
 * 以场景输入（而非生成的脚本文本）表达 2026-11-01 对接模板。
 * 数值独立于生成器维护，脚本生成一旦偏离模板，对照测试就会失败。
 */
const KNOT = 0.5144444444444445
const KNOTS_120 = 120 * KNOT
const KNOTS_150 = 150 * KNOT
const KNOTS_200 = 200 * KNOT
const KMH_300 = 300 / 3.6
const NM = 1852

function platform(
  id: string,
  name: string,
  type: Platform['type'],
  category: Platform['category'],
  longitude: number,
  latitude: number,
  altitude: number,
  extra: Partial<Platform> = {},
): Platform {
  return {
    id,
    name,
    type,
    category,
    initialPosition: { longitude, latitude, altitude },
    waypoints: [],
    linkIds: [],
    sensorIds: [],
    jammerIds: [],
    ...extra,
  }
}

function cLink(id: string, sourcePlatformId: string, targetPlatformId: string, direction: Link['direction']): Link {
  return {
    id,
    type: 'DATALINK',
    sourcePlatformId,
    targetPlatformId,
    enabled: true,
    frequency: direction === 'FORWARD' ? 4500 : 4000,
    bandwidth: direction === 'FORWARD' ? 10 : 20,
    txPower: direction === 'FORWARD' ? 20 : 30,
    antennaGain: { tx: 25, rx: 25 },
    modulation: 'QPSK',
    berThreshold: 1e-5,
    dataRate: direction === 'FORWARD' ? 2 : 8,
    direction,
    band: 'C',
    rxFrequency: direction === 'FORWARD' ? 4500 : 4000,
    rxBandwidth: direction === 'FORWARD' ? 10 : 20,
    txPolarization: 'vertical',
    rxPolarization: 'vertical',
    noiseFigureDb: 3,
  }
}

function fiberLink(id: string, sourcePlatformId: string, targetPlatformId: string, direction: Link['direction']): Link {
  return {
    id,
    type: 'FIBER',
    sourcePlatformId,
    targetPlatformId,
    enabled: true,
    frequency: 0.001,
    bandwidth: 0.001,
    txPower: 0.001,
    antennaGain: { tx: 0, rx: 0 },
    modulation: 'BPSK',
    berThreshold: 1e-5,
    dataRate: 1000,
    direction,
    rxFrequency: 0.001,
    rxBandwidth: 0.001,
    noiseFigureDb: 0,
  }
}

function demand(id: string, sourcePlatformId: string, destinationPlatformId: string, direction: 'FORWARD' | 'REVERSE', informationType: string, volumeMb: number, frequencyHz: number) {
  return {
    id,
    sourcePlatformId,
    destinationPlatformIds: [destinationPlatformId],
    direction,
    enabled: true,
    informationType,
    volumeMb,
    frequencyHz,
    priority: 'HIGH' as const,
    maxLatencyMs: 1_000,
    minDataRateMbps: 0.001,
  }
}

/** 创建与 10 个模板 TXT 参考场景一致的全新草稿。 */
export function createTemplateScenario(): ScenarioDraft {
  const rear = platform('rear_comm_vehicle', '后方通信车', 'REAR_COMMAND_NODE', 'ground', 118.5, 24.8, 0)
  const command = platform('command_vehicle', '指挥车', 'GROUND_CLUSTER_COMMAND_NODE', 'ground', 118.5, 24.66, 0)
  const tiantong = platform('tiantong_sat', '天通卫星', 'COMMUNICATION_SATELLITE', 'space', 120, 0, 35_786_000, { satelliteType: 'TIANTONG' })
  const shentong = platform('shentong_sat', '神通卫星', 'COMMUNICATION_SATELLITE', 'space', 120, 0, 35_786_000, { satelliteType: 'SHENTONG' })
  const relay = platform('mission_uav_01', '中继无人机', 'FORWARD_RELAY_NODE', 'air', 119.55, 24.66, 3200, {
    waypoints: [{ longitude: 120.8, latitude: 25, altitude: 8000, speed: KNOTS_200, arrivalTime: 0 }],
    loiterWaypoints: [
      { longitude: 120.82, latitude: 25.02, altitude: 8000, speed: KNOTS_150 },
      { longitude: 120.8, latitude: 25.04, altitude: 8000, speed: KNOTS_150 },
      { longitude: 120.78, latitude: 25.02, altitude: 8000, speed: KNOTS_150 },
    ],
  })
  const uav2 = platform('mission_uav_02', '任务无人机 A', 'AIRBORNE_MISSION_CLUSTER', 'air', 119.57, 24.66, 8000, {
    waypoints: [
      { longitude: 119.57, latitude: 24.66, altitude: 8000, speed: KNOTS_200, arrivalTime: 0 },
      { longitude: 121.17, latitude: 25.03, altitude: 3200, speed: KNOTS_150, arrivalTime: 1 },
    ],
    loiterWaypoints: [
      { longitude: 121.42, latitude: 25.12, altitude: 3200, speed: KNOTS_120 },
      { longitude: 121.42, latitude: 25.08, altitude: 3200, speed: KNOTS_120 },
      { longitude: 121.38, latitude: 25.08, altitude: 3200, speed: KNOTS_120 },
      { longitude: 121.38, latitude: 25.12, altitude: 3200, speed: KNOTS_120 },
    ],
    returnPlan: {
      timeS: 2220,
      waypoints: [
        { longitude: 121.12, latitude: 25.03, altitude: 3200, speed: KNOTS_200 },
        { longitude: 119.6, latitude: 24.8, altitude: 3200, speed: KNOTS_200 },
      ],
    },
  })
  const uav3 = platform('mission_uav_03', '任务无人机 B', 'AIRBORNE_MISSION_CLUSTER', 'air', 119.62, 24.66, 3200, {
    waypoints: [
      { longitude: 120.8, latitude: 25, altitude: 8000, speed: KNOTS_200, arrivalTime: 0 },
      { longitude: 121.45, latitude: 25.1, altitude: 3200, speed: KNOTS_150, arrivalTime: 1 },
    ],
    loiterWaypoints: [
      { longitude: 121.47, latitude: 25.12, altitude: 3200, speed: KNOTS_120 },
      { longitude: 121.47, latitude: 25.08, altitude: 3200, speed: KNOTS_120 },
      { longitude: 121.43, latitude: 25.08, altitude: 3200, speed: KNOTS_120 },
      { longitude: 121.43, latitude: 25.12, altitude: 3200, speed: KNOTS_120 },
    ],
    returnPlan: {
      timeS: 2220,
      waypoints: [
        { longitude: 121.17, latitude: 25.03, altitude: 3200, speed: KNOTS_200 },
        { longitude: 119.6, latitude: 24.8, altitude: 3200, speed: KNOTS_200 },
      ],
    },
  })
  const groundJammer = platform('jammer_station_01', '地面干扰站', 'GROUND_JAMMER_DETECTION_STATION', 'ground', 121.55, 25.15, 0, { jammerIds: ['ground_jammer'] })
  const airborneJammer = platform('jammer_airborne_01', '机载干扰平台', 'AIRBORNE_JAMMER_PLATFORM', 'air', 121.56, 25.0345, 3000, {
    loiterWaypoints: [
      { longitude: 121.564, latitude: 25.0345, altitude: 3000, speed: KMH_300 },
      { longitude: 121.564, latitude: 25.03, altitude: 3000, speed: KMH_300 },
      { longitude: 121.564, latitude: 25.0255, altitude: 3000, speed: KMH_300 },
      { longitude: 121.56, latitude: 25.0255, altitude: 3000, speed: KMH_300 },
      { longitude: 121.556, latitude: 25.0255, altitude: 3000, speed: KMH_300 },
      { longitude: 121.556, latitude: 25.03, altitude: 3000, speed: KMH_300 },
      { longitude: 121.556, latitude: 25.0345, altitude: 3000, speed: KMH_300 },
    ],
    jammerIds: ['airborne_jammer'],
  })

  const links = [
    fiberLink('fiber_forward', rear.id, command.id, 'FORWARD'),
    cLink('c_forward_uav2', command.id, uav2.id, 'FORWARD'),
    cLink('c_forward_uav3', command.id, uav3.id, 'FORWARD'),
    cLink('c_return_uav2', uav2.id, command.id, 'REVERSE'),
    cLink('c_return_uav3', uav3.id, command.id, 'REVERSE'),
    fiberLink('fiber_return', command.id, rear.id, 'REVERSE'),
  ]
  for (const link of links) {
    const source = [rear, command, tiantong, shentong, relay, uav2, uav3, groundJammer, airborneJammer].find(item => item.id === link.sourcePlatformId)!
    const target = [rear, command, tiantong, shentong, relay, uav2, uav3, groundJammer, airborneJammer].find(item => item.id === link.targetPlatformId)!
    source.linkIds.push(link.id)
    target.linkIds.push(link.id)
  }

  return {
    config: {
      schemaVersion: '1.0',
      scenario: {
        id: 'SCN-TEMPLATE-20261101',
        name: 'AFSIM 模板对照场景',
        description: '仅供 2026-11-01 AFSIM 模板逐文件对照。',
        startTime: '2025-09-15T00:00:00Z',
        duration: 5400,
        timeStep: 1,
        realtime: true,
        environment: {
          seaState: 3,
          rainRateMmPerHour: 10,
          multipathEnabled: true,
          rainEnabled: true,
          rainAltitudeLimitM: 3000,
          rainAttenuationDb: 0,
          cloudEnabled: true,
          cloudAltitudeMinM: 500,
          cloudAltitudeMaxM: 2000,
          cloudWaterDensityGM3: 0.5,
          atmosphereModel: 'itu',
          simplifiedAttenuationDbPerKm: 0.02,
          polarizationMismatchDb: 0,
          pointingErrorDb: 0,
          seaLowAltitudeThresholdM: 100,
          seaPathOverSeaThresholdKm: 30,
          seaModel: 'coarse',
          seaPolarization: 'vertical',
          seaWaterTempC: 20,
          seaSurfaceRoughnessM: 0,
          seaPolygon: [
            { latitude: 24.2, longitude: 117.6 },
            { latitude: 24.2, longitude: 120.1 },
            { latitude: 25.6, longitude: 121.3 },
            { latitude: 26.3, longitude: 120 },
          ],
        },
      },
      platforms: [rear, command, tiantong, shentong, relay, uav2, uav3, groundJammer, airborneJammer],
      links,
      jammers: [
        { id: 'ground_jammer', platformId: groundJammer.id, type: 'BARRAGE', defaultPower: 1, frequency: 2400, bandwidth: 200,
          detectionMinimumRange: 1000, detectionRange: 55_560, jammingRange: 0, releaseRange: 35 * NM, triggerTimeS: 0 },
        { id: 'airborne_jammer', platformId: airborneJammer.id, type: 'BARRAGE', defaultPower: 0.1, frequency: 2400, bandwidth: 100,
          detectionMinimumRange: 1000, detectionRange: 55_560, jammingRange: 10 * NM, releaseRange: 15 * NM, triggerTimeS: 0 },
      ],
      sensors: [],
      output: { directory: 'output', writeInterval: 5, linkQualityEnabled: false, eventsEnabled: true, linkSwitchEnabled: false },
      informationDemand: [
        demand('uav2_forward_situation', rear.id, uav2.id, 'FORWARD', '态势信息', 256 / 8_000_000, 5),
        demand('uav2_forward_target', rear.id, uav2.id, 'FORWARD', '目标指令', 512 / 8_000_000, 10),
        demand('uav2_return_video', uav2.id, rear.id, 'REVERSE', '侦察信息', 8192 / 8_000_000, 3),
        demand('uav2_return_status', uav2.id, rear.id, 'REVERSE', '状态信息', 512 / 8_000_000, 10),
        demand('uav3_forward_situation', rear.id, uav3.id, 'FORWARD', '态势信息', 256 / 8_000_000, 5),
        demand('uav3_forward_target', rear.id, uav3.id, 'FORWARD', '目标指令', 128 / 8_000_000, 10),
        demand('uav3_return_video', uav3.id, rear.id, 'REVERSE', '侦察信息', 4096 / 8_000_000, 5),
        demand('uav3_return_status', uav3.id, rear.id, 'REVERSE', '状态信息', 256 / 8_000_000, 10),
      ],
      linkSettings: {
        enabledSatellites: { TIANTONG: true, SHENTONG: true },
        switchCooldownS: 5,
        priority: ['DATALINK', 'MICROWAVE', 'SAT', 'LASER', 'FIBER'],
        linkCalc: { emergencyThreshold: 1e-5, warningThreshold: 1e-6, valueThresholdBer: 1e-7, jammingRangeKm: 30, channelEncodingScheme: 0 },
        hotLinks: {
          forward: [['fiber_forward', 'c_forward_uav2'], ['fiber_forward', 'c_forward_uav3']],
          reverse: [['c_return_uav2', 'fiber_return'], ['c_return_uav3', 'fiber_return']],
          endPlatformType: 'REAR_COMMAND_NODE',
        },
      },
      jammingEnabled: true,
    },
    uiExtensions: {
      jammers: [
        { jammerId: 'ground_jammer', direction: 0, enabled: true },
        { jammerId: 'airborne_jammer', direction: 0, enabled: true },
      ],
      sensors: [],
    },
    revision: 1,
    officialLibraryChanged: false,
    locked: false,
  }
}

/** 保留拓扑和参数，只改平台编号并将中继排到作业无人机之后，包含编号与实例名冲突。 */
export function createRenamedTemplateScenario(): ScenarioDraft {
  const draft = structuredClone(createTemplateScenario())
  const ids = new Map([
    ['rear_comm_vehicle', 'PLAT-001'],
    ['command_vehicle', 'PLAT-002'],
    ['tiantong_sat', 'SUP-001'],
    ['shentong_sat', 'SUP-002'],
    ['mission_uav_02', 'PLAT-003'],
    ['mission_uav_03', 'mission_uav_01'],
    ['mission_uav_01', 'PLAT-005'],
    ['jammer_station_01', 'SUP-003'],
    ['jammer_airborne_01', 'SUP-004'],
  ])
  draft.config.platforms = [...ids].map(([originalId, id]) => ({
    ...draft.config.platforms.find(platform => platform.id === originalId)!, id,
  }))
  for (const link of draft.config.links) {
    link.sourcePlatformId = ids.get(link.sourcePlatformId)!
    link.targetPlatformId = ids.get(link.targetPlatformId)!
    if (link.relayPlatformId != null) link.relayPlatformId = ids.get(link.relayPlatformId)!
  }
  for (const demand of draft.config.informationDemand) {
    demand.sourcePlatformId = ids.get(demand.sourcePlatformId)!
    demand.destinationPlatformIds = demand.destinationPlatformIds.map(id => ids.get(id)!)
  }
  for (const jammer of draft.config.jammers) jammer.platformId = ids.get(jammer.platformId)!
  return draft
}

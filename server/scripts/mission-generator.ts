import type { ScenarioDraft } from '../../src/contracts/domain-models.js'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation.js'
import { isConfiguredLinkEnabled, readLinkSettings } from '../../src/features/scenarios/link-settings.js'

export class MissionGenerationError extends Error {
  constructor(readonly fieldPath: string, reason: string) {
    super(`${fieldPath}：${reason}`)
    this.name = 'MissionGenerationError'
  }
}

const NOTICE = '候选 AFSIM 节点/微波设备验证包，未经 mission 执行验证；不是完整业务仿真脚本。'
const MODELS = {
  REAR_COMMAND_NODE: { reference: 'REAR_COMM_PLATFORM', mover: 'WSF_GROUND_MOVER' },
  AIRBORNE_MISSION_CLUSTER: { reference: 'MISSION_UAV_PLATFORM', mover: 'WSF_AIR_MOVER' },
} as const

// 使用无损编码而非替换标点，L-A 和 L_A 不会分配到同一个设备或网络。
function token(id: string): string {
  return Array.from(id, character => character.codePointAt(0)!.toString(16)).join('_')
}

/** 只编译已核实语法的静态节点和微波设备，不复制候选脚本中的任务剧情。 */
export function buildMissionPackage(draft: ScenarioDraft) {
  const { config } = draft
  const inspection = inspectScenarioConfig(config, 'write')
  const issue = inspection.result.errors[0]
  if (issue) throw new MissionGenerationError(issue.fieldPath ?? 'config', issue.message)
  const settings = readLinkSettings(config)
  const links = config.links.filter(link => isConfiguredLinkEnabled(link, settings, config.platforms))
  const excluded = new Set(config.links.filter(link => !links.includes(link)).map(link => link.id))
  const demandIndex = config.informationDemand.findIndex(demand => demand.enabled !== false
    && (demand.linkId === undefined || !excluded.has(demand.linkId)))
  if (demandIndex !== -1) throw new MissionGenerationError(`informationDemand[${demandIndex}]`, '业务发送规则尚未接通，不能生成完整业务脚本。')
  if (config.jammers.length) throw new MissionGenerationError('jammers', '干扰设备脚本尚未接通。')
  if (config.sensors.length) throw new MissionGenerationError('sensors', '侦测设备脚本尚未接通。')
  const platforms = config.platforms.map((platform, index) => {
    const path = `platforms[${index}]`
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(platform.id)) throw new MissionGenerationError(`${path}.id`, '引擎平台编号须以英文字母开头，仅包含字母、数字、下划线或连字符；不会自动改写原编号。')
    if (!(platform.type in MODELS)) throw new MissionGenerationError(`${path}.type`, '本批仅支持后方指挥节点和空中无人作业集群的基础节点。')
    if (platform.waypoints.length) throw new MissionGenerationError(`${path}.waypoints`, '航点到达时刻的引擎映射尚未确认，本批仅支持无航点节点。')
    const model = MODELS[platform.type as keyof typeof MODELS]
    return { platformId: platform.id, name: platform.name, frontendType: platform.type,
      referenceModel: model.reference, generatedType: `GEN_${model.reference}_${token(platform.id)}`, mover: model.mover }
  })
  const devices = links.map(link => {
    const path = `links[${config.links.indexOf(link)}]`
    if (link.type !== 'MICROWAVE') throw new MissionGenerationError(`${path}.type`, '本批仅支持微波设备，其他链路不自动转换为微波。')
    if (link.relayPlatformId != null) throw new MissionGenerationError(`${path}.relayPlatformId`, '中继转发规则尚未接通，不自动拆分链路。')
    for (const field of ['antennaGainCorrectionDb', 'antiJammingGainDb', 'spatialIsolationDb'] as const) {
      if ((link[field] ?? 0) !== 0) throw new MissionGenerationError(`${path}.${field}`, '该修正参数尚无已确认的引擎映射。')
    }
    if (link.coding != null) throw new MissionGenerationError(`${path}.coding`, '信道编码尚无已确认的引擎映射。')
    return { linkId: link.id, network: `net_${token(link.id)}`, direction: link.direction,
      source: { platformId: link.sourcePlatformId, deviceId: `comm_${token(link.id)}_src` },
      target: { platformId: link.targetPlatformId, deviceId: `comm_${token(link.id)}_dst` } }
  })
  const antennas: string[] = []
  const definitions: string[] = []
  for (const platform of platforms) {
    definitions.push(`platform_type ${platform.generatedType} WSF_PLATFORM`,
      `  mover ${platform.mover}`, `    update_interval ${config.output.writeInterval} sec`, '  end_mover')
    devices.forEach((mapping, index) => {
      const endpoint = mapping.source.platformId === platform.platformId ? mapping.source
        : mapping.target.platformId === platform.platformId ? mapping.target : undefined
      if (!endpoint) return
      const link = links[index]!
      for (const side of ['tx', 'rx'] as const) {
        antennas.push(`antenna_pattern ${endpoint.deviceId}_${side}`, '  uniform_pattern',
          `    peak_gain ${link.antennaGain[side]} dB`, '    azimuth_beamwidth 360 deg',
          '    elevation_beamwidth 180 deg', '  end_uniform_pattern', 'end_antenna_pattern')
      }
      definitions.push(`  comm ${endpoint.deviceId} WSF_RADIO_TRANSCEIVER`, `    network_name ${mapping.network}`,
        `    transfer_rate ${link.dataRate} mbits/sec`, '    transmitter',
        `      frequency ${link.frequency} MHz`, `      bandwidth ${link.bandwidth} MHz`,
        `      power ${link.txPower} W`, `      antenna_pattern ${endpoint.deviceId}_tx`, '    end_transmitter',
        '    receiver', `      frequency ${link.frequency} MHz`, `      bandwidth ${link.bandwidth} MHz`,
        `      antenna_pattern ${endpoint.deviceId}_rx`, '    end_receiver', '  end_comm')
    })
    definitions.push('end_platform_type')
  }
  const instances = config.platforms.flatMap((platform, index) => {
    const position = platform.initialPosition
    return [`platform ${platform.id} ${platforms[index]!.generatedType}`,
      `  position ${Math.abs(position.latitude)}${position.latitude < 0 ? 's' : 'n'} ${Math.abs(position.longitude)}${position.longitude < 0 ? 'w' : 'e'}`,
      `  altitude ${position.altitude} m`, 'end_platform']
  })
  const entry = ['# ' + NOTICE, 'include_once platforms.txt', 'include_once observers.txt',
    `end_time ${config.scenario.duration} sec`, ...instances]
  if (config.output.eventsEnabled) entry.push('csv_event_output', '  file output/scenario_events.csv',
    '  enable PLATFORM_ADDED', '  enable PLATFORM_INITIALIZED', '  enable COMM_TURNED_ON',
    '  enable COMM_TURNED_OFF', '  enable MESSAGE_TRANSMITTED', '  enable MESSAGE_RECEIVED', 'end_csv_event_output')
  const limitations = [
    NOTICE,
    '仅生成静态初始节点和独立设备；不实现业务发包、启停剧情、选路、干扰或侦测。',
    '前端业务类型仅用于选择基础 mover；未复制候选模型的处理器、阵营或任务行为。',
    '调制、BER 阈值、天气、仿真开始日期/时区、timeStep、时钟倍速及链路优先级仅保留于输入快照，未映射为引擎行为。',
    '天线使用候选全向图形并代入输入增益；没有已确认的极化、噪声和衰减模型参数，因此未生成这些指令；引擎默认行为尚未验证，不能用于质量评估。',
    '输出固定在本包 output 子目录；不采用配置中的外部输出路径，不生成链路质量或切换统计，不覆盖既有 CSV。',
    '执行时必须以本包目录为工作目录；本次只生成文件，不运行 mission，不宣称设备已连通。',
  ]
  const manifest = { scope: 'STATIC_MICROWAVE_CANDIDATE', engineValidated: false,
    scenarioId: config.scenario.id, revision: draft.revision, entry: 'mission.txt',
    platforms, devices, excludedLinkIds: [...excluded], limitations }
  return { manifest, files: {
    'mission.txt': entry.join('\n') + '\n',
    'platforms.txt': [...antennas, ...definitions].join('\n') + '\n',
    'observers.txt': POSITION_OBSERVER,
    'mapping.json': JSON.stringify(manifest, null, 2) + '\n',
    'input.json': JSON.stringify(draft, null, 2) + '\n',
    'README.txt': limitations.join('\n') + '\n',
  } }
}

// 沿用候选 observers.txt 的字段和回调；不合成位置或质量结果。
const POSITION_OBSERVER = `script_variables
  bool positionHeaderWritten = false;
end_script_variables
script void MoverUpdated(WsfPlatform aPlatform, WsfMover aMover)
{
  FileIO file = FileIO();
  if (!positionHeaderWritten)
  {
    file.Open("output/position.csv", "out");
    file.Writeln("TIME,NAME,LON,LAT,ALT,SPEED,HEADING");
    positionHeaderWritten = true;
  }
  else
  {
    file.Open("output/position.csv", "append");
  }
  file.Writeln(write_str(TIME_NOW, ",", aPlatform.Name(), ",", aPlatform.Longitude(), ",", aPlatform.Latitude(), ",", aPlatform.Altitude(), ",", aPlatform.Speed(), ",", aPlatform.Heading()));
  file.Close();
}
end_script
observer
  enable MOVER_UPDATED MoverUpdated
end_observer
`

import type { Link, Platform, PortParameters, ScenarioDraft, TemplateAntennaName, TemplatePlatformType } from '../../src/contracts/domain-models.js'
import { configuredScenarioOutput } from '../../src/config/app.config.js'
import {
  INFORMATION_TYPE_DIRECTIONS,
  inspectScenarioConfig,
  laserOnlyBusinessPaths,
} from '../../src/features/scenarios/scenario-validation.js'
import { isConfiguredLinkEnabled, readLinkSettings } from '../../src/features/scenarios/link-settings.js'
import { readLinkCalcSettings, readNaturalEnvironment } from '../../src/features/scenarios/link-calc-defaults.js'
import { hotLinkChainError, readHotLinks } from '../../src/features/scenarios/hot-links.js'
import { deriveCommPortsFromLinks, readDeviceParameters, resolveLinkRequiredCommPorts, resolveTemplateLinkPorts, templatePlatformType, TEMPLATE_PLATFORM_TYPES, TEMPLATE_PORT_PARAMS } from '../../src/features/scenarios/template-defaults.js'
import { JAMMER_CALC_DEFAULTS, readJammerParameters } from '../../src/features/scenarios/jammer-settings.js'
import { AD_HOC_COMM_FILE, AD_HOC_COMM_TEXT } from './ad-hoc-comm.js'
import { renderTemplate1112, replaceLinkCalcBlock, stripScriptComments, filterPlatformCommPorts, TemplateRegionError } from './afsim-template-patch.js'
import { TEMPLATE_1112_FILES, TEMPLATE_1112_PATCHES, TEMPLATE_1112_SHA256, TEMPLATE_1112_SOURCE_DIRECTORY, type Template1112FileName } from './afsim-template-1112.js'

export class MissionGenerationError extends Error {
  constructor(readonly fieldPath: string, reason: string) { super(`${fieldPath}：${reason}`); this.name = 'MissionGenerationError' }
}

/** 每次生成独立编号；中继先占无人机序号，同类保持配置顺序。 */
export function engineNames(platforms: readonly Platform[]): Map<string, string> {
  const names = new Map<string, string>()
  let uav = 0, ground = 0, airborne = 0
  const numbered = (prefix: string, index: number) => `${prefix}_${String(index).padStart(2, '0')}`
  for (const platform of platforms) if (platform.type === 'FORWARD_RELAY_NODE') names.set(platform.id, numbered('mission_uav', ++uav))
  for (const platform of platforms) {
    switch (platform.type) {
      case 'FORWARD_RELAY_NODE': break
      case 'AIRBORNE_MISSION_CLUSTER': names.set(platform.id, numbered('mission_uav', ++uav)); break
      case 'GROUND_JAMMER_DETECTION_STATION': names.set(platform.id, numbered('jammer_station', ++ground)); break
      case 'AIRBORNE_JAMMER_PLATFORM': names.set(platform.id, numbered('jammer_airborne', ++airborne)); break
      case 'REAR_COMMAND_NODE': names.set(platform.id, 'rear_comm_vehicle'); break
      case 'GROUND_CLUSTER_COMMAND_NODE': names.set(platform.id, 'command_vehicle'); break
      case 'COMMUNICATION_SATELLITE': names.set(platform.id, platform.satelliteType === 'TIANTONG' ? 'tiantong_sat' : 'shentong_sat'); break
    }
  }
  return names
}

export const SCENARIO_PREVIEW_FILE = 'scenario.txt'
const ENTRY_FILE = 'comm_SimSetup.txt'
const DEFINITION_FILE = 'comm_PerDefinition.txt'
const INSTANCE_FILE = 'comm_platform_INS.txt'
const TYPE_FILES = ['comm_platform_COMMAND_VEHICLE.txt', 'comm_platform_MISSION_UAV.txt', 'comm_platform_JAMMER.txt', 'comm_platform_REAR.txt', 'comm_platform_SAT.txt'] as const
/** 模板平台类型 → 承载该类型 comm 段的文件，用于配置采用清单的输出位置。 */
const TYPE_FILE_BY_PLATFORM: Record<TemplatePlatformType, string> = {
  MISSION_UAV_PLATFORM: 'comm_platform_MISSION_UAV.txt',
  COMMAND_VEHICLE_PLATFORM: 'comm_platform_COMMAND_VEHICLE.txt',
  REAR_COMM_PLATFORM: 'comm_platform_REAR.txt',
  TIAN_TONG_SAT: 'comm_platform_SAT.txt',
  SHEN_TONG_SAT: 'comm_platform_SAT.txt',
}
/** 每个模板平台类型实际输出的端口（顺序与模板 port_params 一致；fiber_link 由 fiber() 固定输出）。 */
const OUTPUT_PORTS: Record<TemplatePlatformType, readonly string[]> = {
  MISSION_UAV_PLATFORM: ['sat_link', 'microwave_link', 'c_band_uplink', 'c_band_downlink', 'l_band_uplink', 'l_band_downlink'],
  COMMAND_VEHICLE_PLATFORM: ['c_band_uplink', 'c_band_downlink', 'l_band_uplink', 'l_band_downlink', 'fiber_link'],
  REAR_COMM_PLATFORM: ['sat_link_a', 'sat_link_b', 'microwave_link', 'fiber_link'],
  TIAN_TONG_SAT: ['sat_link'],
  SHEN_TONG_SAT: ['sat_link'],
}
/**
 * 读取场景数据里的端口清单（未显式配置时根据已启用链路自动推导），转换成“平台类型 → 允许生成的端口集合”。
 */
function configuredCommPortSets(config: ScenarioDraft['config']): Map<TemplatePlatformType, Set<string>> | undefined {
  const definitions = config.deviceParameters?.commPorts ?? deriveCommPortsFromLinks(config)
  const result = new Map<TemplatePlatformType, Set<string>>()
  for (const type of TEMPLATE_PLATFORM_TYPES) {
    const ports = definitions[type]
    if (ports !== undefined) result.set(type, new Set(Object.keys(ports)))
  }
  return result.size > 0 ? result : undefined
}
/** 1112 comm_PerDefinition.txt 顶部全局业务变量（信息类型标签 / 传输频次 / 时延要求）。 */
const GLOBAL_SCRIPT_VARIABLES = [
  'script_variables',
  '  string INFO_TYPE_FORWARD_SITUATION = "forward_situation";',
  '  string INFO_TYPE_FORWARD_TARGET = "forward_target";',
  '  string INFO_TYPE_BACK_RECON = "back_recon";',
  '  string INFO_TYPE_BACK_STATUS = "back_status";',
  '  double FORWARD_SITUATION_FREQ_SEC = 1.0;',
  '  double FORWARD_TARGET_FREQ_SEC = 1.0;',
  '  double BACK_RECON_FREQ_SEC = 10.0;',
  '  double BACK_STATUS_FREQ_SEC = 5.0;',
  '  double FORWARD_SITUATION_DELAY_SEC = 1.0;',
  '  double FORWARD_TARGET_DELAY_SEC = 1.0;',
  '  double BACK_RECON_DELAY_SEC = 2.0;',
  '  double BACK_STATUS_DELAY_SEC = 5.0;',
  'end_script_variables',
]
/** 1112 MISSION_UAV / COMMAND_VEHICLE 的时延处理器；是否真实接线/语义按 B05 待确认。 */
function delayProcessors(): string[] {
  return [
    '  processor forward_delay WSF_DELAY_PROCESSOR',
    '    queuing_method first_in_first_out',
    '    number_of_servers 10',
    '    time_distribution constant time 1.0 sec',
    '  end_processor',
    '  processor return_delay WSF_DELAY_PROCESSOR',
    '    queuing_method first_in_first_out',
    '    number_of_servers 10',
    '    time_distribution constant time 1.0 sec',
    '    internal_link script_proc',
    '  end_processor',
  ]
}
const EVENTS = ['PLATFORM_ADDED', 'PLATFORM_INITIALIZED', 'MESSAGE_TRANSMITTED', 'MESSAGE_RECEIVED', 'JAMMING_REQUEST_INITIATED', 'JAMMING_REQUEST_CANCELED', 'JAMMING_REQUEST_UPDATED', 'WEAPON_FIRED', 'SENSOR_DETECTION_CHANGED', 'WEAPON_TURNED_ON', 'WEAPON_MODE_ACTIVATED', 'WEAPON_MODE_DEACTIVATED', 'PLATFORM_DELETED', 'PLATFORM_BROKEN', 'PLATFORM_OMITTED', 'SIMULATION_STARTING', 'SIMULATION_COMPLETE', 'LINK_ADDED_TO_MANAGER', 'LINK_ENABLED_ON_MANAGER', 'LINK_DISABLED_ON_MANAGER', 'LINK_REMOVED_FROM_MANAGER', 'MESSAGE_HOP', 'COMM_TURNED_ON', 'COMM_FREQUENCY_CHANGED', 'LOCAL_TRACK_INITIATED', 'LOCAL_TRACK_UPDATED', 'LOCAL_TRACK_DROPPED', 'SENSOR_TRACK_INITIATED', 'SENSOR_TRACK_UPDATED', 'SENSOR_TRACK_DROPPED', 'EXCHANGE_COMPLETED', 'LINK_ENABLED_ON_LOCAL', 'LINK_DISABLED_ON_LOCAL', 'MOVER_TURNED_ON'] as const
const ANTENNAS: Record<TemplateAntennaName, readonly [number, number]> = {
  OMNI_ANTENNA: [360, 180],
  MICRO_UAV_OMNI_ANTENNA: [360, 65], MICRO_REAR_PLATFORM_DIR_ANTENNA: [12, 12], OMNI_ANTENNA_HIGHGAIN: [360, 180],
  C_BAND_DIRECTIONAL_VEHICLE_ANTENNA: [360, 88], C_BAND_DIRECTIONAL_UAV_ANTENNA: [360, 88], L_BAND_DIRECTIONAL_VEHICLE_ANTENNA: [360, 88], L_BAND_DIRECTIONAL_UAV_ANTENNA: [360, 88],
  SAT_GROUND_MOBILE_ANTENNA: [360, 180], SAT_SPACE_BEAM_ANTENNA: [360, 180], SAT_UAV_CLUSTER_WIDEBAND_ANTENNA: [360, 180], LASER_COMM_ANTENNA: [360, 180],
}
type Device = { linkId: string; linkType: Link['type']; direction: Link['direction']; source: { platformId: string; deviceId: string; platformType: TemplatePlatformType }; target: { platformId: string; deviceId: string; platformType: TemplatePlatformType }; relayPlatformId: string | null; relayDeviceId: string | null }
type Jammer = { jammerId: string; platformId: string; weaponId: 'prophet_jammer' | 'alq99_jammer'; type: string; configuredEnabled: boolean; frequencyMHz: number; bandwidthMHz: number; powerW: number; detectionRangeM: number; detectionMinimumRangeM: number; jammingRangeM: number; releaseRangeM: number; detectionDelayS?: number; jammingDurationS?: number } & Record<keyof typeof JAMMER_CALC_DEFAULTS, number>

/** 保留场景中配置的数值，不以展示精度截断脚本或 link_calc JSON。 */
const n = (value: number) => String(value)
/** 阈值按科学计数法输出，如 1e-5、3e-6。 */
const sci = (value: number) => Number.isFinite(value) ? value.toExponential() : String(value)
function position(latitude: number, longitude: number): string { return `${n(Math.abs(latitude))}${latitude < 0 ? 's' : 'n'} ${n(Math.abs(longitude))}${longitude < 0 ? 'w' : 'e'}` }
function startTime(iso: string): { date: string; time: string } {
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) throw new MissionGenerationError('scenario.startTime', '开始时间不是有效的 ISO 时间。')
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][value.getUTCMonth()]!
  const pad = (part: number) => String(part).padStart(2, '0')
  return { date: `${month} ${pad(value.getUTCDate())} ${value.getUTCFullYear()}`, time: `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}` }
}
function outputDirectory(value: string): string {
  const raw = value.replace(/\\/g, '/')
  const value2 = raw.trim()
  const chunks = value2.split('/').filter(item => item !== '' && item !== '.')
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
  if (value2.startsWith('/') || /[:"<>|?*\x00-\x20]/.test(raw)
    || chunks.some(item => item === '..' || /[. ]$/.test(item) || reserved.test(item))) {
    throw new MissionGenerationError('output.directory', '输出目录必须是本次运行包内的相对目录。')
  }
  return chunks.join('/') || 'output'
}
function rate(value: number, unit: 'bit/s' | 'kbits/sec' | 'mbits/sec'): string { return n(unit === 'bit/s' ? value * 1_000_000 : unit === 'kbits/sec' ? value * 1_000 : value) }
function antenna(type: TemplatePlatformType, port: string): TemplateAntennaName {
  // P0-2：激光口在 1112 引用 LASER_COMM_ANTENNA；comm 端口名 laser_link、port_params 端口名 lazer_link 两种拼写都匹配。
  if (type === 'MISSION_UAV_PLATFORM' && (port === 'lazer_link' || port === 'laser_link')) return 'LASER_COMM_ANTENNA'
  if (type === 'MISSION_UAV_PLATFORM') return port === 'sat_link' ? 'SAT_UAV_CLUSTER_WIDEBAND_ANTENNA' : port === 'microwave_link' ? 'OMNI_ANTENNA' : port.startsWith('c_') ? 'C_BAND_DIRECTIONAL_UAV_ANTENNA' : 'L_BAND_DIRECTIONAL_UAV_ANTENNA'
  if (type === 'COMMAND_VEHICLE_PLATFORM') return port === 'c_band_uplink' ? 'OMNI_ANTENNA' : port.startsWith('c_') ? 'C_BAND_DIRECTIONAL_VEHICLE_ANTENNA' : 'L_BAND_DIRECTIONAL_VEHICLE_ANTENNA'
  // P1 方案A：1112 REAR microwave_link 原文使用 OMNI_ANTENNA（11-06 曾为 MICRO_REAR_PLATFORM_DIR_ANTENNA）。
  return type === 'REAR_COMM_PLATFORM' && port === 'microwave_link' ? 'OMNI_ANTENNA' : type === 'REAR_COMM_PLATFORM' ? 'SAT_GROUND_MOBILE_ANTENNA' : 'SAT_SPACE_BEAM_ANTENNA'
}
function unit(type: TemplatePlatformType, port: string): 'bit/s' | 'kbits/sec' | 'mbits/sec' {
  if (port === 'fiber_link' || (type !== 'MISSION_UAV_PLATFORM' && type !== 'REAR_COMM_PLATFORM' && type !== 'TIAN_TONG_SAT' && type !== 'SHEN_TONG_SAT')) return 'bit/s'
  if (type === 'TIAN_TONG_SAT') return 'kbits/sec'
  if (type === 'MISSION_UAV_PLATFORM' && (port.startsWith('c_') || port.startsWith('l_'))) return 'bit/s'
  return 'mbits/sec'
}
function radio(type: TemplatePlatformType, port: string, value: PortParameters): string[] {
  const radioUnit = unit(type, port)
  const constant = type === 'MISSION_UAV_PLATFORM' || type === 'COMMAND_VEHICLE_PLATFORM' ? 'constant ' : ''
  // 11-06 模板已统一为 vertical，保留此前已验证的同极化通信。
  const polarization = 'vertical'
  const terrain = type === 'MISSION_UAV_PLATFORM' || (type === 'REAR_COMM_PLATFORM' && port === 'microwave_link') ? ['      check_terrain_masking off'] : []
  const tilt = type === 'MISSION_UAV_PLATFORM' && port === 'c_band_downlink' ? ['      antenna_tilt -3 deg'] : []
  return [`  comm ${port} WSF_RADIO_TRANSCEIVER`, '    on', '    network_name COM_MESH_NET', '    add medium UAV_MESH_MEDIUM', '      channels 4', '      mode "default"', `        transfer_rate ${constant}${rate(value.transferRate, radioUnit)} ${radioUnit}`, '      end_mode', '    end_medium', '    transmitter', `      frequency ${n(value.txFrequency / 1000)} GHz`, `      bandwidth ${n(value.txBandwidth)} MHz`, `      power ${n(value.txPower)} W`, `      polarization ${polarization}`, `      antenna_pattern ${antenna(type, port)}`, ...tilt, '      attenuation_model none', '      end_attenuation_model', ...terrain, '    end_transmitter', '    receiver', `      frequency ${n(value.rxFrequency / 1000)} GHz`, `      bandwidth ${n(value.rxBandwidth)} MHz`, `      polarization ${polarization}`, `      antenna_pattern ${antenna(type, port)}`, ...tilt, `      noise_figure ${n(value.noiseFigureDb)} dB`, ...terrain, '      detection_threshold -1000 dB', '    end_receiver', '    internal_link script_proc', '  end_comm']
}
const fiber = (rateMbps: number) => ['  comm fiber_link WSF_COMM_TRANSCEIVER', '    on', '    network_name FIBER_NET', `    transfer_rate ${n(rateMbps)} mbits/sec`, '    channels 4', '    internal_link script_proc', '  end_comm']
function definitions(config: ScenarioDraft['config'], localRuntime: boolean): string {
  const parameters = readDeviceParameters(config)
  const lines = (Object.keys(ANTENNAS) as TemplateAntennaName[]).flatMap(name => {
    const [azimuth, elevation] = ANTENNAS[name]
    return [`antenna_pattern ${name}`, '  uniform_pattern', `    peak_gain ${n(parameters.antennaGains[name] ?? 0)} dB`, `    azimuth_beamwidth ${azimuth} deg`, `    elevation_beamwidth ${elevation} deg`, '  end_uniform_pattern', 'end_antenna_pattern', '']
  })
  // 本地 /23 网段容纳 50 信息节点的 297 个无线端口；对接方 TXT 保留模板网络块。
  return [...GLOBAL_SCRIPT_VARIABLES, '', ...lines, 'radar_signature DRONE_SIG', '  constant 1.0 m^2', 'end_radar_signature', '', 'radar_signature COMMAND_VEHICLE_SIG', '  constant 5.0 m^2', 'end_radar_signature', '', 'radar_signature SAT_SIG', '  constant 3.0 m^2', 'end_radar_signature', '', 'network COM_MESH_NET WSF_COMM_NETWORK_MESH', ...(localRuntime ? ['  network_address 10.0.0.0/23'] : []), 'end_network', '', 'network FIBER_NET WSF_COMM_NETWORK_P2P', 'end_network', '', 'medium UAV_MESH_MEDIUM WSF_COMM_MEDIUM_UNGUIDED', '  channels 4', '  default_mode_name "default"', '  mode "default"', '    propagation_speed constant 299792458 m/sec', '    transfer_rate constant 4000000 bit/s', '    packet_loss_time constant 0 sec', '  end_mode', 'end_medium', '', 'medium FIBER_MEDIUM WSF_COMM_MEDIUM_GUIDED', '  channels 4', '  default_mode_name "default"', '  mode "default"', '    propagation_speed constant 200000000 m/sec', '    transfer_rate constant 1000000 bit/s', '    packet_loss_time constant 0 sec', '  end_mode', 'end_medium', ''].join('\n')
}
const scriptArray = (values: readonly string[]) => `{ ${values.map(value => JSON.stringify(value)).join(', ')} }`
type RouteDefaults = Record<string, string[]>
function missionProcessor(values: { relayNames: string[]; rt_video_nexts: string[]; rt_video_outs: string[]; rt_video_ins: string[]; rt_video_dsts: string[]; rt_video_size: number; rt_status_nexts: string[]; rt_status_outs: string[]; rt_status_ins: string[]; rt_status_dsts: string[]; rt_status_size: number }, interval = 5): string[] {
  return `  processor script_proc WSF_SCRIPT_PROCESSOR
    report_to commander via microwave_link
    update_interval 1 sec
    script_variables
      Array<string> relayNames = ${scriptArray(values.relayNames)};
        bool isRelay = false;
        Array<string> rt_video_nexts = ${scriptArray(values.rt_video_nexts)};
        Array<string> rt_video_outs  = ${scriptArray(values.rt_video_outs)};
        Array<string> rt_video_ins   = ${scriptArray(values.rt_video_ins)};
        Array<string> rt_video_dsts  = ${scriptArray(values.rt_video_dsts)};
        int    rt_video_size = ${n(values.rt_video_size)};
        Array<string> rt_status_nexts = ${scriptArray(values.rt_status_nexts)};
        Array<string> rt_status_outs  = ${scriptArray(values.rt_status_outs)};
        Array<string> rt_status_ins   = ${scriptArray(values.rt_status_ins)};
        Array<string> rt_status_dsts  = ${scriptArray(values.rt_status_dsts)};
        int    rt_status_size = ${n(values.rt_status_size)};
    end_script_variables
    on_initialize
      foreach (string name in relayNames)
        {
          if (name == PLATFORM.Name())
          {
            isRelay = true;
          }
        }
    end_on_initialize
    execute at_interval_of ${n(interval)} sec
      if (!isRelay)
      {
        foreach (int i : string dst in rt_video_dsts)
        {
          string nxts = PLATFORM.AuxDataString("kReturnReconVideo_" + dst + "_next_platform_name");
          if (nxts != "")
          {
            Array<string> nexts = nxts.Split("|");
            Array<string> outs  = PLATFORM.AuxDataString("kReturnReconVideo_" + dst + "_out_port_name").Split("|");
            Array<string> ins   = PLATFORM.AuxDataString("kReturnReconVideo_" + dst + "_next_in_port_name").Split("|");
            foreach (int j : string nxt in nexts)
            {
              WsfMessage msg = WsfMessage();
              msg.SetType("kReturnReconVideo");
              msg.SetSizeInBits(rt_video_size);
              msg.SetAuxData("origin_sender", PLATFORM.Name());
              msg.SetAuxData("destination", dst);
              PLATFORM.Comm(outs[j]).SendMessage(msg, nxt, ins[j]);
              writeln(PLATFORM.Name() + " kReturnReconVideo SendMessage Out Port:[" + outs[j] + "] Destination:[" + dst + "] Next Plat:[" + nxt + "] Next Port:[" + ins[j] + "]");
            }
          }
          else
          {
            WsfMessage msg = WsfMessage();
            msg.SetType("kReturnReconVideo");
            msg.SetSizeInBits(rt_video_size);
            msg.SetAuxData("origin_sender", PLATFORM.Name());
            msg.SetAuxData("destination", rt_video_dsts[i]);
            PLATFORM.Comm(rt_video_outs[i]).SendMessage(msg, rt_video_nexts[i], rt_video_ins[i]);
            writeln(PLATFORM.Name() + " kReturnReconVideo SendMessage Out Port:[" + rt_video_outs[i] + "] Destination:[" + rt_video_dsts[i] + "] Next Plat:[" + rt_video_nexts[i] + "] Next Port:[" + rt_video_ins[i] + "]");
          }
        }
        foreach (int i : string dst in rt_status_dsts)
        {
          string nxts2 = PLATFORM.AuxDataString("kReturnReconStatus_" + dst + "_next_platform_name");
          if (nxts2 != "")
          {
            Array<string> nexts = nxts2.Split("|");
            Array<string> outs  = PLATFORM.AuxDataString("kReturnReconStatus_" + dst + "_out_port_name").Split("|");
            Array<string> ins   = PLATFORM.AuxDataString("kReturnReconStatus_" + dst + "_next_in_port_name").Split("|");
            foreach (int j : string nxt in nexts)
            {
              WsfMessage msg = WsfMessage();
              msg.SetType("kReturnReconStatus");
              msg.SetSizeInBits(rt_status_size);
              msg.SetAuxData("origin_sender", PLATFORM.Name());
              msg.SetAuxData("destination", dst);
              PLATFORM.Comm(outs[j]).SendMessage(msg, nxt, ins[j]);
              writeln(PLATFORM.Name() + " kReturnReconStatus SendMessage Out Port:[" + outs[j] + "] Destination:[" + dst + "] Next Plat:[" + nxt + "] Next Port:[" + ins[j] + "]");
            }
          }
          else
          {
            WsfMessage msg = WsfMessage();
            msg.SetType("kReturnReconStatus");
            msg.SetSizeInBits(rt_status_size);
            msg.SetAuxData("origin_sender", PLATFORM.Name());
            msg.SetAuxData("destination", rt_status_dsts[i]);
            PLATFORM.Comm(rt_status_outs[i]).SendMessage(msg, rt_status_nexts[i], rt_status_ins[i]);
            writeln(PLATFORM.Name() + " kReturnReconStatus SendMessage Out Port:[" + rt_status_outs[i] + "] Destination:[" + rt_status_dsts[i] + "] Next Plat:[" + rt_status_nexts[i] + "] Next Port:[" + rt_status_ins[i] + "]");
          }
        }
      }
    end_execute
    on_message
      type kReturnReconVideo
        script
          string dest = MESSAGE.AuxDataString("destination");
          string nxts = PLATFORM.AuxDataString("kReturnReconVideo_" + dest + "_next_platform_name");
          if (nxts != "")
          {
            Array<string> nexts = nxts.Split("|");
            Array<string> outs  = PLATFORM.AuxDataString("kReturnReconVideo_" + dest + "_out_port_name").Split("|");
            Array<string> ins   = PLATFORM.AuxDataString("kReturnReconVideo_" + dest + "_next_in_port_name").Split("|");
            foreach (int i : string nxt in nexts)
            {
              PLATFORM.Comm(outs[i]).SendMessage(MESSAGE, nxt, ins[i]);
              writeln(PLATFORM.Name() + " kReturnReconVideo Forward Message Out Port:[" + outs[i] + "] Destination:[" + dest + "] Next Plat:[" + nxt + "] Next Port:[" + ins[i] + "]");
            }
          }
        end_script
      type kReturnReconStatus
        script
          string dest = MESSAGE.AuxDataString("destination");
          string nxts = PLATFORM.AuxDataString("kReturnReconStatus_" + dest + "_next_platform_name");
          if (nxts != "")
          {
            Array<string> nexts = nxts.Split("|");
            Array<string> outs  = PLATFORM.AuxDataString("kReturnReconStatus_" + dest + "_out_port_name").Split("|");
            Array<string> ins   = PLATFORM.AuxDataString("kReturnReconStatus_" + dest + "_next_in_port_name").Split("|");
            foreach (int i : string nxt in nexts)
            {
              PLATFORM.Comm(outs[i]).SendMessage(MESSAGE, nxt, ins[i]);
              writeln(PLATFORM.Name() + " kReturnReconStatus Forward Message Out Port:[" + outs[i] + "] Destination:[" + dest + "] Next Plat:[" + nxt + "] Next Port:[" + ins[i] + "]");
            }
          }
        end_script
      type kForwardTarget
        script
          if(isRelay)
          {
            string dest = MESSAGE.AuxDataString("destination");
            string nxts = PLATFORM.AuxDataString("kForwardTarget_" + dest + "_next_platform_name");
            if (nxts != "")
            {
              Array<string> nexts = nxts.Split("|");
              Array<string> outs  = PLATFORM.AuxDataString("kForwardTarget_" + dest + "_out_port_name").Split("|");
              Array<string> ins   = PLATFORM.AuxDataString("kForwardTarget_" + dest + "_next_in_port_name").Split("|");
              foreach (int i : string nxt in nexts)
              {
                PLATFORM.Comm(outs[i]).SendMessage(MESSAGE, nxt, ins[i]);
                writeln(PLATFORM.Name() + " kForwardTarget Forward Message Out Port:[" + outs[i] + "] Destination:[" + dest + "] Next Plat:[" + nxt + "] Next Port:[" + ins[i] + "]");
              }
            }
          }
          else
          {
            writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
          }
        end_script
      type kForwardSituation
        script
          if(isRelay)
          {
            string dest = MESSAGE.AuxDataString("destination");
            string nxts = PLATFORM.AuxDataString("kForwardSituation_" + dest + "_next_platform_name");
            if (nxts != "")
            {
              Array<string> nexts = nxts.Split("|");
              Array<string> outs  = PLATFORM.AuxDataString("kForwardSituation_" + dest + "_out_port_name").Split("|");
              Array<string> ins   = PLATFORM.AuxDataString("kForwardSituation_" + dest + "_next_in_port_name").Split("|");
              foreach (int i : string nxt in nexts)
              {
                PLATFORM.Comm(outs[i]).SendMessage(MESSAGE, nxt, ins[i]);
                writeln(PLATFORM.Name() + " kForwardSituation Forward Message Out Port:[" + outs[i] + "] Destination:[" + dest + "] Next Plat:[" + nxt + "] Next Port:[" + ins[i] + "]");
              }
            }
          }
          else
          {
            writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
          }
        end_script
        default
          script
            writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
          end_script
    end_on_message
  end_processor`.split('\n')
}
function rearProcessor(values: RouteDefaults, interval = 5): string[] {
  return `  processor script_proc WSF_SCRIPT_PROCESSOR
    script_variables
      Array<string> fw_sit_next = ${scriptArray(values.fw_sit_next)};
      Array<string> fw_sit_out  = ${scriptArray(values.fw_sit_out)};
      Array<string> fw_sit_in   = ${scriptArray(values.fw_sit_in)};
      Array<string> fw_sit_dst  = ${scriptArray(values.fw_sit_dst)};
      Array<string> fw_sit_size = ${scriptArray(values.fw_sit_size)};
      Array<string> fw_tgt_next = ${scriptArray(values.fw_tgt_next)};
      Array<string> fw_tgt_out  = ${scriptArray(values.fw_tgt_out)};
      Array<string> fw_tgt_in   = ${scriptArray(values.fw_tgt_in)};
      Array<string> fw_tgt_dst  = ${scriptArray(values.fw_tgt_dst)};
      Array<string> fw_tgt_size = ${scriptArray(values.fw_tgt_size)};
    end_script_variables
    execute at_interval_of ${n(interval)} sec
      foreach (int i : string dst in fw_sit_dst) {
        string nxts = PLATFORM.AuxDataString("kForwardSituation_" + dst + "_next_platform_name");
        if (nxts != "")
        {
          Array<string> nexts = nxts.Split("|");
          Array<string> outs  = PLATFORM.AuxDataString("kForwardSituation_" + dst + "_out_port_name").Split("|");
          Array<string> ins   = PLATFORM.AuxDataString("kForwardSituation_" + dst + "_next_in_port_name").Split("|");
          writeln(PLATFORM.Name() + " kForwardSituation_" + dst + "_next_platform_name New Path Chenged");
          foreach (int j : string nxt in nexts) {
            WsfMessage msg = WsfMessage();
            msg.SetType("kForwardSituation");
            msg.SetSizeInBits((int)fw_sit_size[i]);
            msg.SetAuxData("origin_sender", PLATFORM.Name());
            msg.SetAuxData("destination", dst);
            PLATFORM.Comm(outs[j]).SendMessage(msg, nxt, ins[j]);
            writeln(PLATFORM.Name() + " SendMessage Out Port:[" + outs[j] + "] kForwardSituation DataSize:[" + fw_sit_size[i] + "] Destination:[" + dst + "] Next Plat:[" + nxt + "] Next Port:[" + ins[j] + "]");
          }
        }
        else
        {
          WsfMessage msg = WsfMessage();
          msg.SetType("kForwardSituation");
          msg.SetSizeInBits((int)fw_sit_size[i]);
          msg.SetAuxData("origin_sender", PLATFORM.Name());
          msg.SetAuxData("destination", fw_sit_dst[i]);
          PLATFORM.Comm(fw_sit_out[i]).SendMessage(msg, fw_sit_next[i], fw_sit_in[i]);
          writeln(PLATFORM.Name() + " SendMessage Out Port:[" + fw_sit_out[i] + "] kForwardSituation DataSize:[" + fw_sit_size[i] + "] Destination:[" + fw_sit_dst[i] + "] Next Plat:[" + fw_sit_next[i] + "] Next Port:[" + fw_sit_in[i] + "]");
        }
      }
      foreach (int i : string dst in fw_tgt_dst) {
        string nxts2 = PLATFORM.AuxDataString("kForwardTarget_" + dst + "_next_platform_name");
        if (nxts2 != "") {
          Array<string> nexts2 = nxts2.Split("|");
          Array<string> outs2  = PLATFORM.AuxDataString("kForwardTarget_" + dst + "_out_port_name").Split("|");
          Array<string> ins2   = PLATFORM.AuxDataString("kForwardTarget_" + dst + "_next_in_port_name").Split("|");
          writeln(PLATFORM.Name() + " kForwardTarget_" + dst + "_next_platform_name New Path Chenged");
          foreach (int j : string nxt in nexts2) {
            WsfMessage msg = WsfMessage();
            msg.SetType("kForwardTarget");
            msg.SetSizeInBits((int)fw_tgt_size[i]);
            msg.SetAuxData("origin_sender", PLATFORM.Name());
            msg.SetAuxData("destination", dst);
            PLATFORM.Comm(outs2[j]).SendMessage(msg, nxt, ins2[j]);
            writeln(PLATFORM.Name() + " SendMessage Out Port:[" + outs2[j] + "] kForwardTarget DataSize:[" + fw_tgt_size[i] + "] Destination:[" + dst + "] Next Plat:[" + nxt + "] Next Port:[" + ins2[j] + "]");
          }
        }
        else {
          WsfMessage msg = WsfMessage();
          msg.SetType("kForwardTarget");
          msg.SetSizeInBits((int)fw_tgt_size[i]);
          msg.SetAuxData("origin_sender", PLATFORM.Name());
          msg.SetAuxData("destination", fw_tgt_dst[i]);
          PLATFORM.Comm(fw_tgt_out[i]).SendMessage(msg, fw_tgt_next[i], fw_tgt_in[i]);
          writeln(PLATFORM.Name() + " SendMessage Out Port:[" + fw_tgt_out[i] + "] kForwardTarget DataSize:[" + fw_tgt_size[i] + "] Destination:[" + fw_tgt_dst[i] + "] Next Plat:[" + fw_tgt_next[i] + "] Next Port:[" + fw_tgt_in[i] + "]");
        }
      }
    end_execute
    on_message
      default
        script
          writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
        end_script
    end_on_message
  end_processor`.split('\n')
}
function commandProcessor(values: RouteDefaults, interval = 5): string[] {
  return `  processor script_proc WSF_SCRIPT_PROCESSOR
    report_to commander via fiber_link
    script_variables
      Array<string> fw_sit_nexts = ${scriptArray(values.fw_sit_nexts)};
      Array<string> fw_sit_outs  = ${scriptArray(values.fw_sit_outs)};
      Array<string> fw_sit_ins   = ${scriptArray(values.fw_sit_ins)};
      Array<string> fw_sit_dsts  = ${scriptArray(values.fw_sit_dsts)};
      Array<string> fw_tgt_nexts = ${scriptArray(values.fw_tgt_nexts)};
      Array<string> fw_tgt_outs  = ${scriptArray(values.fw_tgt_outs)};
      Array<string> fw_tgt_ins   = ${scriptArray(values.fw_tgt_ins)};
      Array<string> fw_tgt_dsts  = ${scriptArray(values.fw_tgt_dsts)};
      Array<string> rt_video_nexts = ${scriptArray(values.rt_video_nexts)};
      Array<string> rt_video_outs  = ${scriptArray(values.rt_video_outs)};
      Array<string> rt_video_ins   = ${scriptArray(values.rt_video_ins)};
      Array<string> rt_video_dsts  = ${scriptArray(values.rt_video_dsts)};
      Array<string> rt_status_nexts = ${scriptArray(values.rt_status_nexts)};
      Array<string> rt_status_outs  = ${scriptArray(values.rt_status_outs)};
      Array<string> rt_status_ins   = ${scriptArray(values.rt_status_ins)};
      Array<string> rt_status_dsts  = ${scriptArray(values.rt_status_dsts)};
    end_script_variables
    on_message
      type kForwardSituation
        script
          writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
          string dest = MESSAGE.AuxDataString("destination");
          string nxts = PLATFORM.AuxDataString("kForwardSituation_" + dest + "_next_platform_name");
          if (nxts != "") {
            Array<string> fw_sit_nexts_Change = nxts.Split("|");
            Array<string> fw_sit_outs_Change  = PLATFORM.AuxDataString("kForwardSituation_" + dest + "_out_port_name").Split("|");
            Array<string> fw_sit_ins_Change   = PLATFORM.AuxDataString("kForwardSituation_" + dest + "_next_in_port_name").Split("|");
            Array<string> fw_sit_dsts_Change  = PLATFORM.AuxDataString("kForwardSituation_" + dest + "_dst_platform_name").Split("|");
            foreach (int i : string nxt in fw_sit_nexts_Change) {
              if (fw_sit_dsts_Change[i] == dest) {
                PLATFORM.Comm(fw_sit_outs_Change[i]).SendMessage(MESSAGE, nxt, fw_sit_ins_Change[i]);
                writeln(PLATFORM.Name() + "kForwardSituation Forward Out Port:[" + fw_sit_outs_Change[i] + "] Destination:[" + dest + "] Next Plat:[" + nxt + "] Next Port:[" + fw_sit_ins_Change[i] + "]");
              }
            }
          }else{
            foreach (int i : string nxt in fw_sit_nexts) {
              if (fw_sit_dsts[i] == dest) {
                PLATFORM.Comm(fw_sit_outs[i]).SendMessage(MESSAGE, nxt, fw_sit_ins[i]);
                writeln(PLATFORM.Name() + "kForwardSituation Forward Out Port:[" + fw_sit_outs[i] + "] Destination:[" + dest + "] Next Plat:[" + nxt + "] Next Port:[" + fw_sit_ins[i] + "]");
              }
            }
          }
        end_script
      type kForwardTarget
        script
          writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
          string dest = MESSAGE.AuxDataString("destination");
          string nxts = PLATFORM.AuxDataString("kForwardTarget_" + dest + "_next_platform_name");
          if (nxts != "") {
            Array<string> fw_tgt_nexts_Change = nxts.Split("|");
            Array<string> fw_tgt_outs_Change  = PLATFORM.AuxDataString("kForwardTarget_" + dest + "_out_port_name").Split("|");
            Array<string> fw_tgt_ins_Change   = PLATFORM.AuxDataString("kForwardTarget_" + dest + "_next_in_port_name").Split("|");
            Array<string> fw_tgt_dsts_Change  = PLATFORM.AuxDataString("kForwardTarget_" + dest + "_dst_platform_name").Split("|");
            foreach (int i : string nxt in fw_tgt_nexts_Change) {
              if (fw_tgt_dsts_Change[i] == dest) {
                PLATFORM.Comm(fw_tgt_outs_Change[i]).SendMessage(MESSAGE, nxt, fw_tgt_ins_Change[i]);
                writeln(PLATFORM.Name() + "kForwardTarget Forward Out Port:[" + fw_tgt_outs_Change[i] + "] Destination:[" + dest + "] Next Plat:[" + nxt + "] Next Port:[" + fw_tgt_ins_Change[i] + "]");
              }
            }
          }else{
            foreach (int i : string nxt in fw_tgt_nexts) {
              if (fw_tgt_dsts[i] == dest) {
                PLATFORM.Comm(fw_tgt_outs[i]).SendMessage(MESSAGE, nxt, fw_tgt_ins[i]);
                writeln(PLATFORM.Name() + "kForwardTarget Forward Out Port:[" + fw_tgt_outs[i] + "] Destination:[" + dest + "] Next Plat:[" + nxt + "] Next Port:[" + fw_tgt_ins[i] + "]");
              }
            }
          }
        end_script
      type kReturnReconVideo
        script
          writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
          string dest = MESSAGE.AuxDataString("destination");
          string nxts = PLATFORM.AuxDataString("kReturnReconVideo_" + dest + "_next_platform_name");
          if (nxts != "") {
            Array<string> rt_video_nexts_Change = nxts.Split("|");
            Array<string> rt_video_outs_Change  = PLATFORM.AuxDataString("kReturnReconVideo_" + dest + "_out_port_name").Split("|");
            Array<string> rt_video_ins_Change   = PLATFORM.AuxDataString("kReturnReconVideo_" + dest + "_next_in_port_name").Split("|");
            Array<string> rt_video_dsts_Change  = PLATFORM.AuxDataString("kReturnReconVideo_" + dest + "_dst_platform_name").Split("|");
            foreach (int i : string nxt in rt_video_nexts_Change) {
              if (rt_video_dsts_Change[i] == dest) {
                PLATFORM.Comm(rt_video_outs_Change[i]).SendMessage(MESSAGE, nxt, rt_video_ins_Change[i]);
                writeln(PLATFORM.Name() + "kReturnReconVideo Forward Out Port:[" + rt_video_outs_Change[i] + "] Destination:[" + dest + "] Next Plat:[" + nxt + "] Next Port:[" + rt_video_ins_Change[i] + "]");
              }
            }
          }else{
            foreach (int i : string nxt in rt_video_nexts) {
              if (rt_video_dsts[i] == dest) {
                PLATFORM.Comm(rt_video_outs[i]).SendMessage(MESSAGE, nxt, rt_video_ins[i]);
                writeln(PLATFORM.Name() + "kReturnReconVideo Forward Out Port:[" + rt_video_outs[i] + "] Destination:[" + dest + "] Next Plat:[" + nxt + "] Next Port:[" + rt_video_ins[i] + "]");
              }
            }
          }
        end_script
      type kReturnReconStatus
        script
          writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
          string dest = MESSAGE.AuxDataString("destination");
          string nxts = PLATFORM.AuxDataString("kReturnReconStatus_" + dest + "_next_platform_name");
          if (nxts != "") {
            Array<string> rt_status_nexts_Change = nxts.Split("|");
            Array<string> rt_status_outs_Change  = PLATFORM.AuxDataString("kReturnReconStatus_" + dest + "_out_port_name").Split("|");
            Array<string> rt_status_ins_Change   = PLATFORM.AuxDataString("kReturnReconStatus_" + dest + "_next_in_port_name").Split("|");
            Array<string> rt_status_dsts_Change  = PLATFORM.AuxDataString("kReturnReconStatus_" + dest + "_dst_platform_name").Split("|");
            foreach (int i : string nxt in rt_status_nexts_Change) {
              if (rt_status_dsts_Change[i] == dest) {
                PLATFORM.Comm(rt_status_outs_Change[i]).SendMessage(MESSAGE, nxt, rt_status_ins_Change[i]);
                writeln(PLATFORM.Name() + "kReturnReconStatus Forward Out Port:[" + rt_status_outs_Change[i] + "] Destination:[" + dest + "] Next Plat:[" + nxt + "] Next Port:[" + rt_status_ins_Change[i] + "]");
              }
            }
          }else{
            foreach (int i : string nxt in rt_status_nexts) {
              if (rt_status_dsts[i] == dest) {
                PLATFORM.Comm(rt_status_outs[i]).SendMessage(MESSAGE, nxt, rt_status_ins[i]);
                writeln(PLATFORM.Name() + "kReturnReconStatus Forward Out Port:[" + rt_status_outs[i] + "] Destination:[" + dest + "] Next Plat:[" + nxt + "] Next Port:[" + rt_status_ins[i] + "]");
              }
            }
          }
        end_script
      default
        script
          writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
        end_script
    end_on_message
  end_processor`.split('\n')
}
function satellite(kind: 'TIAN_TONG_SAT' | 'SHEN_TONG_SAT', value: PortParameters, start: string): string[] {
  const radioUnit = unit(kind, 'sat_link')
  return [`platform_type ${kind} WSF_PLATFORM`, '  radar_signature SAT_SIG', '  mover WSF_SPACE_MOVER', '    update_interval 1 sec', '    oblate_earth true', '    orbital_state', `      epoch_date_time ${start}`, '      semi_major_axis 42164 km', '      eccentricity 0.0', '      inclination 0 deg', '      raan 120 deg', '      argument_of_periapsis 0 deg', '      mean_anomaly 0 deg', '    end_orbital_state', '  end_mover', '  comm sat_link WSF_RADIO_TRANSCEIVER', '    on', '    network_name COM_MESH_NET', '    add medium UAV_MESH_MEDIUM', '      channels 4', '      mode "default"', `        transfer_rate ${rate(value.transferRate, radioUnit)} ${radioUnit}`, '      end_mode', '    end_medium', '    transmitter', `      frequency ${n(value.txFrequency / 1000)} GHz`, `      bandwidth ${n(value.txBandwidth)} MHz`, `      power ${n(value.txPower)} W`, '      polarization vertical', '      antenna_pattern SAT_SPACE_BEAM_ANTENNA', '      attenuation_model none', '      end_attenuation_model', '    end_transmitter', '    receiver', `      frequency ${n(value.rxFrequency / 1000)} GHz`, `      bandwidth ${n(value.rxBandwidth)} MHz`, '      polarization vertical', '      antenna_pattern SAT_SPACE_BEAM_ANTENNA', `      noise_figure ${n(value.noiseFigureDb)} dB`, '      detection_threshold -1000 dB', '    end_receiver', '    internal_link script_proc', '  end_comm', '  processor script_proc WSF_SCRIPT_PROCESSOR', ...(kind === 'SHEN_TONG_SAT' ? `    on_message
      type kForwardSituation
          script
            writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
            string nxts = PLATFORM.AuxDataString("kForwardSituation_next_platform_name");
            if (nxts != "") {
              Array<string> nexts = nxts.Split("|");
              Array<string> outs  = PLATFORM.AuxDataString("kForwardSituation_out_port_name").Split("|");
              Array<string> ins   = PLATFORM.AuxDataString("kForwardSituation_next_in_port_name").Split("|");
              Array<string> dsts  = PLATFORM.AuxDataString("kForwardSituation_dst_platform_name").Split("|");
              string dest = MESSAGE.AuxDataString("destination");
              foreach (int i : string nxt in nexts) {
                if (dsts[i] == dest) {
                  PLATFORM.Comm(outs[i]).SendMessage(MESSAGE, nxt, ins[i]);
                }
              }
            }
          end_script
      type kForwardTarget
        script
          writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
          string nxts = PLATFORM.AuxDataString("kForwardTarget_next_platform_name");
          if (nxts != "") {
            Array<string> nexts = nxts.Split("|");
            Array<string> outs  = PLATFORM.AuxDataString("kForwardTarget_out_port_name").Split("|");
            Array<string> ins   = PLATFORM.AuxDataString("kForwardTarget_next_in_port_name").Split("|");
            Array<string> dsts  = PLATFORM.AuxDataString("kForwardTarget_dst_platform_name").Split("|");
            string dest2 = MESSAGE.AuxDataString("destination");
            foreach (int i : string nxt in nexts) {
              if (dsts[i] == dest2) {
                PLATFORM.Comm(outs[i]).SendMessage(MESSAGE, nxt, ins[i]);
              }
            }
          }
        end_script
      type kReturnReconVideo
        script
          writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
          string nxts = PLATFORM.AuxDataString("kReturnReconVideo_next_platform_name");
          if (nxts != "") {
            Array<string> nexts = nxts.Split("|");
            Array<string> outs  = PLATFORM.AuxDataString("kReturnReconVideo_out_port_name").Split("|");
            Array<string> ins   = PLATFORM.AuxDataString("kReturnReconVideo_next_in_port_name").Split("|");
            Array<string> dsts  = PLATFORM.AuxDataString("kReturnReconVideo_dst_platform_name").Split("|");
            string dest3 = MESSAGE.AuxDataString("destination");
            foreach (int i : string nxt in nexts) {
              if (dsts[i] == dest3) {
                PLATFORM.Comm(outs[i]).SendMessage(MESSAGE, nxt, ins[i]);
              }
            }
          }
        end_script
      type kReturnReconStatus
        script
          writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
          string nxts = PLATFORM.AuxDataString("kReturnReconStatus_next_platform_name");
          if (nxts != "") {
            Array<string> nexts = nxts.Split("|");
            Array<string> outs  = PLATFORM.AuxDataString("kReturnReconStatus_out_port_name").Split("|");
            Array<string> ins   = PLATFORM.AuxDataString("kReturnReconStatus_next_in_port_name").Split("|");
            Array<string> dsts  = PLATFORM.AuxDataString("kReturnReconStatus_dst_platform_name").Split("|");
            string dest4 = MESSAGE.AuxDataString("destination");
            foreach (int i : string nxt in nexts) {
              if (dsts[i] == dest4) {
                PLATFORM.Comm(outs[i]).SendMessage(MESSAGE, nxt, ins[i]);
              }
            }
          }
        end_script
      default
        script
          writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());
        end_script
    end_on_message`.split('\n') : []), '  end_processor', 'end_platform_type']
}
function jammerType(airborne: boolean, jammer: Jammer | undefined, localRuntime: boolean): string[] {
  const defaults = airborne ? { frequency: 2400, bandwidth: 20, power: 100 } : { frequency: 2400, bandwidth: 50, power: 200 }
  const weapon = airborne ? 'alq99_jammer' : 'prophet_jammer'
  const radar = { ...JAMMER_CALC_DEFAULTS, ...jammer }
  return [`platform_type ${airborne ? 'AIRBORNE_JAMMER_PLATFORM' : 'GROUND_JAMMER_STATION'} WSF_PLATFORM`, `  radar_signature ${airborne ? 'DRONE_SIG' : 'COMMAND_VEHICLE_SIG'}`, `  mover ${airborne ? 'WSF_AIR_MOVER' : 'WSF_SURFACE_MOVER'}`, '    update_interval 1 sec', '  end_mover', '  sensor detection_radar WSF_RADAR_SENSOR', '    mode default', '      frame_time 5 sec', '      beam 1', '        azimuth_field_of_view -180 deg 180 deg', '        elevation_field_of_view -10 deg 10 deg', `        minimum_range ${n((jammer?.detectionMinimumRangeM ?? 1000) / 1000)} km`, `        maximum_range ${n(jammer?.detectionRangeM ?? 55560)} m`, '        transmitter', `          frequency ${n(radar.radarFrequency / 1000)} GHz`, `          power ${n(radar.radarPower)} W`, '        end_transmitter', '        receiver', `          noise_figure ${n(radar.noiseFigureDb)} dB`, `          bandwidth ${n(radar.radarBandwidth)} MHz`, '        end_receiver', '      end_beam', '      reports_location', '      reports_velocity', '      reports_bearing', '    end_mode', '    on', '  end_sensor', ...(airborne || localRuntime ? [`  weapon ${weapon} WSF_RF_JAMMER`, airborne ? '    on' : '    off', '    mode_template', '      transmitter', `        frequency ${n((jammer?.frequencyMHz ?? defaults.frequency) / 1000)} GHz`, `        bandwidth ${n(jammer?.bandwidthMHz ?? defaults.bandwidth)} MHz`, `        power ${n(jammer?.powerW ?? defaults.power)} W`, '        antenna_pattern OMNI_ANTENNA_HIGHGAIN', '      end_transmitter', '    end_mode_template', ...(!airborne ? ['    mode default', '    end_mode'] : []), '    mode broadband_jamming', '    end_mode', '    mode spot_jamming', '    end_mode', '    mode sweep_jamming', '    end_mode', ...(airborne ? ['    mode default', '    end_mode'] : []), '  end_weapon'] : []), ...(!airborne ? ['  processor auto_jammer_proc WSF_SCRIPT_PROCESSOR', '  end_processor'] : []), '  processor script_proc WSF_SCRIPT_PROCESSOR', '  end_processor', 'end_platform_type', '']
}
function devices(config: ScenarioDraft['config']): { items: Device[]; warnings: string[] } {
  const settings = readLinkSettings(config); const items: Device[] = []; const warnings: string[] = []
  config.links.forEach((link, index) => {
    if (!isConfiguredLinkEnabled(link, settings, config.platforms)) return
    const mapping = resolveTemplateLinkPorts(config, link)
    if (mapping.status === 'WARNING') { warnings.push(`links[${index}]：${mapping.message}`); return }
    if (mapping.status === 'ERROR') throw new MissionGenerationError(`links[${index}]`, mapping.message)
    const relay = link.relayPlatformId === undefined || link.relayPlatformId === null ? undefined : config.platforms.find(item => item.id === link.relayPlatformId)
    const relayType = relay && templatePlatformType(relay)
    const relayDeviceId = relay === undefined ? null
      : relayType === 'TIAN_TONG_SAT' || relayType === 'SHEN_TONG_SAT' ? 'sat_link'
        : mapping.source.portName
    if (relay !== undefined && !relayType) throw new MissionGenerationError(`links[${index}].relayPlatformId`, '中继实体没有新模板通信端口。')
    items.push({ linkId: link.id, linkType: link.type, direction: link.direction, source: { platformId: link.sourcePlatformId, deviceId: mapping.source.portName, platformType: mapping.source.platformType }, target: { platformId: link.targetPlatformId, deviceId: mapping.target.portName, platformType: mapping.target.platformType }, relayPlatformId: link.relayPlatformId ?? null, relayDeviceId })
  })
  return { items, warnings }
}
type EmittedPortParams = Array<{ platform_type: TemplatePlatformType; comm_params: Array<{ comm_name: string; transmitter: Record<string, number>; receiver: Record<string, number> }> }>
function portParams(config: ScenarioDraft['config'], resolved: EffectivePorts, allowedPorts?: Map<TemplatePlatformType, Set<string>>): EmittedPortParams {
  const explicitGains = config.deviceParameters?.antennaGains
  return TEMPLATE_PORT_PARAMS.flatMap(platformEntry => {
    const allowed = allowedPorts?.get(platformEntry.platform_type)
    if (allowed !== undefined && allowed.size === 0) return []
    return [{
      platform_type: platformEntry.platform_type,
      comm_params: platformEntry.comm_params.filter(base => allowed === undefined || allowed.has(base.comm_name)).map(base => {
      const override = resolved.overrides.get(`${platformEntry.platform_type}.${base.comm_name}`) ?? {}
      const rateKey = Object.keys(base.transmitter).find(key => key.startsWith('information_rate_'))!
      const rateUnit = rateKey.slice('information_rate_'.length) as 'bit/s' | 'kbits/sec' | 'mbits/sec'
      const tx: Record<string, number> = { ...base.transmitter }
      const rx: Record<string, number> = { ...base.receiver }
      if (base.comm_name !== 'fiber_link') {
        if (override.txFrequency !== undefined) tx.frequency_ghz = override.txFrequency / 1000
        if (override.txBandwidth !== undefined) tx.bandwidth_mhz = override.txBandwidth
        if (override.txPower !== undefined) tx.power_w = override.txPower
        if (override.eirpDbw !== undefined) tx.eirp_dBW = override.eirpDbw
        if (override.rxFrequency !== undefined) rx.frequency_ghz = override.rxFrequency / 1000
        if (override.rxBandwidth !== undefined) rx.bandwidth_mhz = override.rxBandwidth
        if (override.noiseFigureDb !== undefined) rx.noise_figure_dB = override.noiseFigureDb
        // 交付 TXT 的 G/T 统一写 0（按用户 2026-11-14 要求）；配置值仍保留在快照中。
        if (Object.hasOwn(rx, 'G_T_dBK')) rx.G_T_dBK = 0
        // #3：仅当该天线被 deviceParameters.antennaGains 显式包含时，才覆盖引用它的端口峰值增益。
        const antennaName = antenna(platformEntry.platform_type, base.comm_name)
        if (explicitGains && Object.hasOwn(explicitGains, antennaName) && typeof explicitGains[antennaName] === 'number') {
          tx.peak_gain_dB = explicitGains[antennaName]!
          rx.peak_gain_dB = explicitGains[antennaName]!
        }
        // 交付 TXT 的 EIRP 统一写 0（按用户 2026-11-13 要求）；配置值仍保留在快照中。
        if (Object.hasOwn(tx, 'eirp_dBW')) tx.eirp_dBW = 0
      }
      if (override.transferRate !== undefined) { tx[rateKey] = Number(rate(override.transferRate, rateUnit)); rx[rateKey] = Number(rate(override.transferRate, rateUnit)) }
      return { comm_name: base.comm_name, transmitter: tx, receiver: rx }
    }),
    }]
  })
}
type PortBinding = { indexes: number[]; chosen: number | null; conflicting: boolean }
type EffectivePorts = { values: Map<string, PortParameters>; overrides: Map<string, Partial<PortParameters>>; sources: Map<string, 'CONFIGURED' | 'TEMPLATE_DEFAULT'>; bindings: Map<string, PortBinding>; conflicts: Array<{ fieldPath: string; message: string }> }
/** 链路字段 → 端口字段的映射（含冲突定位用中文标签）。 */
const LINK_PORT_FIELDS: ReadonlyArray<{ portKey: keyof PortParameters; linkKey: keyof Link; label: string }> = [
  { portKey: 'txFrequency', linkKey: 'frequency', label: '频率(MHz)' },
  { portKey: 'txBandwidth', linkKey: 'bandwidth', label: '发射带宽(MHz)' },
  { portKey: 'txPower', linkKey: 'txPower', label: '功率(W)' },
  { portKey: 'transferRate', linkKey: 'dataRate', label: '速率(Mbps)' },
  { portKey: 'rxFrequency', linkKey: 'rxFrequency', label: '接收频率(MHz)' },
  { portKey: 'rxBandwidth', linkKey: 'rxBandwidth', label: '接收带宽(MHz)' },
  { portKey: 'noiseFigureDb', linkKey: 'noiseFigureDb', label: '噪声系数(dB)' },
]
/** 该端口实际映射到输出的字段：光纤 comm 为 WSF_COMM_TRANSCEIVER，仅 transferRate 映射；无线端口映射收发频率/带宽/功率/速率/噪声。EIRP/G-T 非链路字段不参与冲突比较。 */
const RADIO_MAPPED_PORT_FIELDS = ['txFrequency', 'txBandwidth', 'txPower', 'transferRate', 'rxFrequency', 'rxBandwidth', 'noiseFigureDb'] as const
const FIBER_MAPPED_PORT_FIELDS = ['transferRate'] as const
function mappedPortFields(port: string): readonly (keyof PortParameters)[] {
  return port === 'fiber_link' ? FIBER_MAPPED_PORT_FIELDS : RADIO_MAPPED_PORT_FIELDS
}
function linkOverride(link: Link, port: string): Partial<PortParameters> {
  const override: Partial<PortParameters> = {}
  const mapped = mappedPortFields(port)
  for (const { portKey, linkKey } of LINK_PORT_FIELDS) {
    if (!mapped.includes(portKey)) continue
    const value = link[linkKey]
    if (typeof value === 'number') (override as Record<string, number>)[portKey as string] = value
  }
  return override
}
/** 设备端口显式字段：光纤仅 transferRate；无线端口另含 EIRP/G-T（用于覆盖 port_params 默认集）。 */
function deviceOverride(value: PortParameters | null | undefined, port: string): Partial<PortParameters> {
  const override: Partial<PortParameters> = {}
  if (!value) return override
  const keys: readonly (keyof PortParameters)[] = port === 'fiber_link' ? FIBER_MAPPED_PORT_FIELDS : [...RADIO_MAPPED_PORT_FIELDS, 'eirpDbw', 'gtDbk']
  for (const key of keys) {
    const item = value[key]
    if (typeof item === 'number') (override as Record<string, number>)[key] = item
  }
  return override
}
/**
 * #1/#6/#4 单一“有效端口参数”解析器（comm 域取值）：
 * 模板默认 ← deviceParameters 端口配置 ← 绑定到该(platformType,port)的启用链路显式字段。
 * #1：同端口被多条启用链路映射且显式字段不一致、或链路显式值与 deviceParameters 显式值冲突 → 抛 MissionGenerationError 阻断并定位 links[i]。
 * 仅对已映射端口叠加；未绑定端口保持设备/模板默认。overrides 记录显式覆盖字段，供 portParams() 在其独立默认集上叠加。
 */
function resolveEffectivePorts(config: ScenarioDraft['config'], items: readonly Device[]): EffectivePorts {
  const parameters = readDeviceParameters(config)
  const explicit = config.deviceParameters?.ports
  const linkIndex = new Map(config.links.map((link, index) => [link.id, index]))
  const bindingMap = new Map<string, number[]>()
  const addBinding = (key: string, index: number | undefined) => {
    if (index === undefined) return
    const list = bindingMap.get(key) ?? []
    if (!list.includes(index)) list.push(index)
    bindingMap.set(key, list)
  }
  for (const item of items) {
    const index = linkIndex.get(item.linkId)
    addBinding(`${item.source.platformType}.${item.source.deviceId}`, index)
    addBinding(`${item.target.platformType}.${item.target.deviceId}`, index)
    if (item.relayPlatformId !== null && item.relayDeviceId !== null) addBinding(`MISSION_UAV_PLATFORM.${item.relayDeviceId}`, index)
  }
  const values = new Map<string, PortParameters>(); const overrides = new Map<string, Partial<PortParameters>>()
  const sources = new Map<string, 'CONFIGURED' | 'TEMPLATE_DEFAULT'>(); const bindings = new Map<string, PortBinding>(); const conflicts: Array<{ fieldPath: string; message: string }> = []
  for (const type of TEMPLATE_PLATFORM_TYPES) for (const port of OUTPUT_PORTS[type]) {
    const key = `${type}.${port}`
    const base = parameters.ports[type]?.[port]
    if (!base) throw new MissionGenerationError(`deviceParameters.ports.${type}.${port}`, '模板端口参数缺失。')
    const hasDeviceConfig = explicit?.[type] !== undefined && Object.hasOwn(explicit[type]!, port)
    const device = hasDeviceConfig ? deviceOverride(explicit![type]![port] ?? null, port) : {}
    const hasDeviceMapped = Object.keys(device).length > 0
    const indexes = [...(bindingMap.get(key) ?? [])].sort((left, right) => left - right)
    const entries = indexes.map(index => ({ index, override: linkOverride(config.links[index]!, port) }))
    const mappedFields = LINK_PORT_FIELDS.filter(field => mappedPortFields(port).includes(field.portKey))
    // 同端口多条链路“已映射字段”显式值不一致 → 阻断（未映射字段不比较）。
    for (const { portKey, linkKey, label } of mappedFields) {
      const present = entries.filter(entry => entry.override[portKey] !== undefined)
      if (present.length < 2) continue
      const first = present[0]!
      const mismatch = present.find(entry => entry.override[portKey] !== first.override[portKey])
      if (mismatch) {
        throw new MissionGenerationError(`links[${mismatch.index}].${String(linkKey)}`, `共享模板端口 ${type}.${port} 的${label}在 links[${first.index}](${String(first.override[portKey])}) 与 links[${mismatch.index}](${String(mismatch.override[portKey])}) 不一致；请先消除共享端口冲突再生成。`)
      }
    }
    // 链路显式值与设备端口显式值在“已映射字段”上不一致 → 阻断（未映射字段差异不阻断）。
    for (const entry of entries) for (const { portKey, linkKey, label } of mappedFields) {
      const linkValue = entry.override[portKey]
      const deviceValue = device[portKey]
      if (linkValue !== undefined && deviceValue !== undefined && linkValue !== deviceValue) {
        throw new MissionGenerationError(`links[${entry.index}].${String(linkKey)}`, `链路 links[${entry.index}] 的${label}=${String(linkValue)} 与 deviceParameters.ports.${type}.${port}.${String(portKey)}=${String(deviceValue)} 冲突；请消除冲突再生成。`)
      }
    }
    // #2：逐字段收集所有绑定链路的显式值（含 0），单一/相同值采用；多个不同值已在上面阻断。
    // 链路顺序不影响结果；某字段仅部分链路提供时也能进入输出。
    const combined: Partial<PortParameters> = { ...device }
    for (const { portKey } of mappedFields) {
      const values = entries.map(entry => entry.override[portKey]).filter((value): value is number => typeof value === 'number')
      if (values.length === 0) continue
      (combined as Record<string, number>)[portKey as string] = values[0]!
    }
    overrides.set(key, combined)
    values.set(key, { ...base, ...combined })
    sources.set(key, entries.length === 0 ? (hasDeviceMapped ? 'CONFIGURED' : 'TEMPLATE_DEFAULT') : 'CONFIGURED')
    bindings.set(key, { indexes, chosen: entries.length === 0 ? null : entries[0]!.index, conflicting: false })
  }
  return { values, overrides, sources, bindings, conflicts }
}
/** #6：分别记录 comm 段与 port_params 段（两段默认可能不同，不能合并成一个 adoptedValue）。 */
type PortAdoptionSegment = { adoptedValue: Record<string, unknown>; source: 'CONFIGURED' | 'TEMPLATE_DEFAULT'; unit: string; outputPath: string }
type PortAdoption = {
  fieldPath: string; platformType: TemplatePlatformType; port: string; configuredValue: PortParameters | null
  comm: PortAdoptionSegment | null; portParams: PortAdoptionSegment | null
  outputStatus: 'REFERENCED' | 'DEFINED_OUTPUT' | 'NOT_EMITTED'; engineExecution: 'UNVERIFIED'
  linkOverride: { linkIndex: number; conflicting: boolean } | null; note: string
}
function portParamsPortNames(type: TemplatePlatformType): readonly string[] {
  return TEMPLATE_PORT_PARAMS.find(entry => entry.platform_type === type)?.comm_params.map(item => item.comm_name) ?? []
}
function portAdoption(
  config: ScenarioDraft['config'],
  resolved: EffectivePorts,
  emittedPortParams: EmittedPortParams,
  allowedCommPorts?: Map<TemplatePlatformType, Set<string>>,
): PortAdoption[] {
  const explicit = config.deviceParameters?.ports
  const explicitGains = config.deviceParameters?.antennaGains
  const emitted = new Map<string, { transmitter: Record<string, number>; receiver: Record<string, number> }>()
  for (const platformEntry of emittedPortParams) for (const comm of platformEntry.comm_params) emitted.set(`${platformEntry.platform_type}.${comm.comm_name}`, { transmitter: comm.transmitter, receiver: comm.receiver })
  return TEMPLATE_PLATFORM_TYPES.flatMap(type => {
    const allowedPorts = allowedCommPorts?.get(type)
    const ports = [...new Set([...OUTPUT_PORTS[type], ...portParamsPortNames(type)])]
    return ports.map(port => {
      const key = `${type}.${port}`
      const isAllowed = allowedPorts === undefined || allowedPorts.has(port)
      const binding = resolved.bindings.get(key)
      const referenced = isAllowed && (binding?.indexes.length ?? 0) > 0
      const hasDeviceConfig = explicit?.[type] !== undefined && Object.hasOwn(explicit[type]!, port)
      const emittedValue = isAllowed ? emitted.get(key) : undefined
      const override = resolved.overrides.get(key) ?? {}
      const antennaName = port === 'fiber_link' ? null : antenna(type, port)
      const hasAntennaGain = antennaName !== null && explicitGains !== undefined && Object.hasOwn(explicitGains, antennaName)
      // comm 段只列实际映射到 comm 输出的字段（未映射字段不标已采用）；光纤仅 transferRate。
      // 1112 固定模板：comm 段不随设备参数改写，设备参数只进入 link_calc port_params。
      const comm: PortAdoptionSegment | null = null
      const portParams: PortAdoptionSegment | null = emittedValue
        ? { adoptedValue: emittedValue as unknown as Record<string, unknown>, source: Object.keys(override).length > 0 || hasAntennaGain ? 'CONFIGURED' : 'TEMPLATE_DEFAULT', unit: 'GHz / MHz / W / bit/s 等（按 1112 port_params 键）', outputPath: `${TYPE_FILE_BY_PLATFORM[type]} 的 link_calc port_params.${port}` }
        : null
      const outputStatus: PortAdoption['outputStatus'] = !isAllowed
        ? 'NOT_EMITTED'
        : (referenced ? 'REFERENCED' : 'DEFINED_OUTPUT')
      const note = !isAllowed
        ? '未包含在本次生成端口清单（commPorts 或链路自动推导）中，comm 段与 port_params 均未输出该端口。'
        : referenced
          ? `由链路 links[${binding!.chosen}] 的显式收发参数采用；comm 与 port_params 各自记录实际输出值。`
          : (hasDeviceConfig ? '未绑定链路，按设备端口配置输出定义。' : '未绑定链路，按模板缺省输出定义。')
      return {
        fieldPath: `deviceParameters.ports.${type}.${port}`, platformType: type, port,
        configuredValue: hasDeviceConfig ? (explicit![type]![port] ?? null) : null,
        comm, portParams,
        outputStatus, engineExecution: 'UNVERIFIED',
        linkOverride: referenced ? { linkIndex: binding!.chosen!, conflicting: false } : null,
        note,
      }
    })
  })
}
/** 显式配置了但端口未进入生成输出（comm 与 port_params 均无该端口）时仅保留配置。 */
function configuredNotEmitted(
  config: ScenarioDraft['config'],
  resolved: EffectivePorts,
  emittedPortParams: EmittedPortParams,
  allowedCommPorts?: Map<TemplatePlatformType, Set<string>>,
): Array<{ fieldPath: string; detail: string }> {
  const outputKeys = new Set(resolved.values.keys())
  for (const platformEntry of emittedPortParams) for (const comm of platformEntry.comm_params) outputKeys.add(`${platformEntry.platform_type}.${comm.comm_name}`)
  const explicit = config.deviceParameters?.ports
  if (!explicit) return []
  return TEMPLATE_PLATFORM_TYPES.flatMap(type => {
    const allowedPorts = allowedCommPorts?.get(type)
    return Object.keys(explicit[type] ?? {}).flatMap(port => {
      const isAllowed = allowedPorts === undefined || allowedPorts.has(port)
      return isAllowed && outputKeys.has(`${type}.${port}`)
        ? []
        : [{ fieldPath: `deviceParameters.ports.${type}.${port}`, detail: '该端口未进入生成输出（未在端口清单中启用或模板未定义），仅保留配置。' }]
    })
  })
}

function chain(chains: readonly (readonly string[])[], all: readonly Device[]): Record<string, Hop[]> {
  const result: Record<string, Hop[]> = {}
  chains.forEach((ids, index) => {
    const hops = ids.map(id => all.find(value => value.linkId === id)).filter((value): value is Device => value !== undefined)
    if (hops.length !== ids.length || hops.length === 0) return
    const resultHops: Hop[] = []
    hops.forEach((hop, hopIndex) => {
      if (hopIndex === 0) resultHops.push({ platform: hop.source.platformId, inPort: '', outPort: hop.source.deviceId })
      else resultHops[resultHops.length - 1]!.outPort = hop.source.deviceId
      if (hop.relayPlatformId && hop.relayDeviceId) resultHops.push({ platform: hop.relayPlatformId, inPort: hop.relayDeviceId, outPort: hop.relayDeviceId })
      resultHops.push({ platform: hop.target.platformId, inPort: hop.target.deviceId, outPort: '' })
    })
    result[`link${index + 1}`] = resultHops
  })
  return result
}
function traffic(
  config: ScenarioDraft['config'],
  all: readonly Device[],
  laserOnlyTargets: ReadonlyMap<number, ReadonlySet<number> | 'ALL'>,
): Traffic {
  const names = { '态势信息': 'kForwardSituation', '目标指令': 'kForwardTarget', '侦察信息': 'kReturnReconVideo', '状态信息': 'kReturnReconStatus' } as const
  const grouped = new Map<string, { forward: TrafficRecord[]; return: TrafficRecord[] }>()
  config.informationDemand.forEach((demand, index) => {
    const excluded = laserOnlyTargets.get(index)
    if (excluded === 'ALL') return
    if (demand.enabled === false || (demand.linkId !== undefined && !all.some(item => item.linkId === demand.linkId))) return
    const name = names[demand.informationType as keyof typeof names]
    if (!name) return
    const associatedDirection = demand.linkId === undefined
      ? undefined
      : all.find(item => item.linkId === demand.linkId)?.direction
    const direction = demand.direction
      ?? associatedDirection
      ?? INFORMATION_TYPE_DIRECTIONS[demand.informationType as keyof typeof INFORMATION_TYPE_DIRECTIONS]
      ?? 'FORWARD'
    const targets = direction === 'REVERSE'
      ? excluded !== undefined && excluded.size >= demand.destinationPlatformIds.length
        ? []
        : [demand.sourcePlatformId]
      : demand.destinationPlatformIds.filter((_target, targetIndex) => !excluded?.has(targetIndex))
    targets.forEach(target => {
      if (!target) return
      const current = grouped.get(target) ?? { forward: [], return: [] }
      const record = {
        traffice_type: name,
        data_volume_bits: Math.round(demand.volumeMb * 8_000_000),
        trans_freq: demand.frequencyHz,
      }
      ;(direction === 'REVERSE' ? current.return : current.forward).push(record)
      grouped.set(target, current)
    })
  })
  return [...grouped].map(([platform, value]) => ({ [platform]: value }))
}
function jammerValues(config: ScenarioDraft['config'], uiExtensions: ScenarioDraft['uiExtensions']): Jammer[] {
  const enabled = config.jammingEnabled ?? false
  return config.jammers.map(stored => {
    const value = readJammerParameters(stored)
    const extension = uiExtensions.jammers.find(item => item.jammerId === value.id)
    const airborne = config.platforms.find(item => item.id === value.platformId)?.type === 'AIRBORNE_JAMMER_PLATFORM'
    // 未配置的链路计算字段取 1112 jammer_param 基准（地面 G_T -12/eirp 50/增益 30；机载 G_T -10/eirp 40/增益 25）。
    const templateDefaults = airborne
      ? { gtDbk: -10, eirpDbw: 40, antennaGainDbi: 25 }
      : { gtDbk: -12, eirpDbw: 50, antennaGainDbi: 30 }
    return {
      radarFrequency: value.radarFrequency,
      radarBandwidth: value.radarBandwidth,
      radarPower: value.radarPower,
      noiseFigureDb: value.noiseFigureDb,
      gtDbk: stored.gtDbk ?? templateDefaults.gtDbk,
      eirpDbw: stored.eirpDbw ?? templateDefaults.eirpDbw,
      antennaGainDbi: stored.antennaGainDbi ?? templateDefaults.antennaGainDbi,
      txLossDb: value.txLossDb,
      sweepDutyCycle: value.sweepDutyCycle,
      jammerId: value.id,
      platformId: value.platformId,
      weaponId: airborne ? 'alq99_jammer' : 'prophet_jammer',
      type: value.type,
      configuredEnabled: enabled && (extension?.enabled ?? false),
      frequencyMHz: value.frequency,
      bandwidthMHz: value.bandwidth,
      powerW: value.defaultPower,
      detectionRangeM: value.detectionRange,
      detectionMinimumRangeM: value.detectionMinimumRange ?? 1000,
      jammingRangeM: value.jammingRange,
      releaseRangeM: value.releaseRange ?? value.jammingRange + 9260,
      ...(value.detectionDelayS !== undefined ? { detectionDelayS: value.detectionDelayS } : {}),
      ...(value.jammingDurationS !== undefined ? { jammingDurationS: value.jammingDurationS } : {}),
    }
  })
}type Hop = { platform: string; inPort: string; outPort: string }
type TrafficRecord = { traffice_type: string; data_volume_bits: number; trans_freq: number }
type Traffic = Array<Record<string, { forward: TrafficRecord[]; return: TrafficRecord[] }>>
export type RouteInputs = { traffic: Traffic; forward: Record<string, Hop[]>; reverse: Record<string, Hop[]> }
/** link_calc 与本地补丁共用的业务与热链输入，保证两者路由一致。 */
function routeInputs(
  config: ScenarioDraft['config'],
  all: readonly Device[],
  laserOnlyTargets: ReadonlyMap<number, ReadonlySet<number> | 'ALL'>,
): RouteInputs {
  const settings = readLinkSettings(config)
  const enabledLinks = config.links.filter(link => all.some(item => item.linkId === link.id))
  const hot = readHotLinks(settings.hotLinks, enabledLinks, settings.priority)
  // 显式热链引用不存在/停用链路、方向不一致或跳点不相接时在生成前报错，不静默丢弃该链。
  for (const [direction, chains] of [['FORWARD', hot.forward], ['REVERSE', hot.reverse]] as const) {
    for (const chain of chains) {
      const error = hotLinkChainError(chain, enabledLinks, direction)
      if (error !== null) throw new MissionGenerationError('linkSettings.hotLinks', `热链引用无效：${error}`)
    }
  }
  return { traffic: traffic(config, all, laserOnlyTargets), forward: chain(hot.forward, all), reverse: chain(hot.reverse, all) }
}
function calculator(
  config: ScenarioDraft['config'],
  routes: RouteInputs,
  jammers: readonly Jammer[],
  resolved: EffectivePorts,
  emittedPortParams: EmittedPortParams,
): string {
  const settings = readLinkSettings(config); const calc = readLinkCalcSettings(settings.linkCalc); const environment = readNaturalEnvironment(config.scenario.environment)
  const natural = { rain: { enabled: environment.rainEnabled, rain_rate_mm_hr: environment.rainRateMmPerHour, rain_altitude_limit_m: environment.rainAltitudeLimitM, rain_attenuation_db: environment.rainAttenuationDb }, cloud: { enabled: environment.cloudEnabled, cloud_altitude_min_m: environment.cloudAltitudeMinM, cloud_altitude_max_m: environment.cloudAltitudeMaxM, cloud_water_density_g_m3: environment.cloudWaterDensityGM3 }, atmosphere: { enabled: true, model: environment.atmosphereModel, simplified_attenuation_db_per_km: environment.simplifiedAttenuationDbPerKm }, misc_loss_db: { polarization_mismatch_db: environment.polarizationMismatchDb, pointing_error_db: environment.pointingErrorDb }, sea_state: { enabled: config.scenario.environment.multipathEnabled, sea_state_level: environment.seaState, low_altitude_threshold_m: environment.seaLowAltitudeThresholdM, path_over_sea_threshold_km: environment.seaPathOverSeaThresholdKm, mode: environment.seaModel, sea_polygon: (environment.seaPolygon ?? []).map(point => ({ lat: point.latitude, lon: point.longitude })), polarization: environment.seaPolarization, sea_water_temp_c: environment.seaWaterTempC, sea_surface_roughness_m: environment.seaSurfaceRoughnessM } }
  const jams = { jammers: jammers.map(item => ({
    platform_name: item.platformId, weapon_name: item.weaponId, jammer_type: item.weaponId === 'alq99_jammer' ? 'airborne' : 'ground',
    G_T_dBK: 0, enabled: item.configuredEnabled, mode: item.type === 'BARRAGE' ? 'broadband' : item.type === 'SPOT' ? 'spot' : 'sweep',
    frequency_ghz: item.radarFrequency / 1000, bandwidth_mhz: item.radarBandwidth, power_w: item.radarPower, noise_figure: item.noiseFigureDb,
    weapon_frequency_ghz: item.frequencyMHz / 1000, weapon_bandwidth_mhz: item.bandwidthMHz, weapon_power_w: item.powerW,
    weapon_eirp_dBW: 0, weapon_antenna_gain_dbi: item.antennaGainDbi, tx_loss_db: item.txLossDb,
    detect_radius_nm: item.detectionRangeM / 1852, trigger_radius_nm: item.jammingRangeM / 1852, release_radius_nm: item.releaseRangeM / 1852,
    spot_bandwidth_mhz: item.type === 'SPOT' ? item.bandwidthMHz : 20, sweep_duty_cycle: item.sweepDutyCycle,
  })) }
  return ['  add processor link_calc WSF_LINK_CALC_PROCESSOR', `    update_interval ${n(calc.updateIntervalS)} sec`, `    emergency_threshold ${sci(calc.emergencyThreshold)}`, `    warning_threshold ${sci(calc.warningThreshold)}`, `    value_threshold_ber ${n(calc.valueThresholdBer)}`, `    channel_encoding_scheme ${n(calc.channelEncodingScheme)}`, `    traffic_type ${JSON.stringify(routes.traffic)}`, `    relay_uav_names ${JSON.stringify(config.platforms.filter(item => item.type === 'FORWARD_RELAY_NODE').map(item => item.id))}`, `    hot_link_ret ${JSON.stringify(routes.reverse)}`, `    hot_link_fw ${JSON.stringify(routes.forward)}`, `    port_params ${JSON.stringify(emittedPortParams)}`, `    natural_environment ${JSON.stringify(natural)}`, `    jammer_param ${JSON.stringify(jams)}`, '  end_processor'].join('\n')
}
/** 本地运行包选项；对接方 TXT、预览和 writeScriptText 都不传，保持模板原样。 */
export type LocalRuntimeOptions = {
  linkCalc: 'PRESERVE' | 'STUB'
  /** 运行包内事件/位置输出子目录（必须是包内相对路径）；缺省沿用场景 output.directory（默认 output）。 */
  outputDirectory?: string
}
const SHARED_MEDIUM = 'UAV_MESH_MEDIUM'
const JAMMER_SCRIPT_MODE = (type: string) => type === 'BARRAGE' ? 'broadband_jamming' : type === 'SPOT' ? 'spot_jamming' : 'sweep_jamming'
type AuxEntry = { next: string[]; out: string[]; in: string[]; dst: string[]; size: string[] }
/**
 * E1 实测：模板各端口 `add medium UAV_MESH_MEDIUM` 后改写的 transfer_rate 作用于同一介质类型，
 * 后定义覆盖前定义（C 上行 2 Mbps 实际按 8 Mbps 传输）。本地包为每个平台类型的每个射频端口
 * 派生独立介质类型，基础属性与 UAV_MESH_MEDIUM 相同，端口内的速率改写只作用于本端口。
 */
function splitSharedMedium(files: Record<string, string>): string[] {
  const names: string[] = []
  for (const name of TYPE_FILES) {
    let type = ''
    let port = ''
    files[name] = files[name]!.split('\n').map(line => {
      // 1112 模板各文件缩进不同（MISSION_UAV 的 platform_type/comm 多两级），按结构而非固定空格数定位。
      const typeMatch = /^\s*platform_type (\S+) /u.exec(line)
      if (typeMatch) type = typeMatch[1]!
      const portMatch = /^\s*comm (\S+) /u.exec(line)
      if (portMatch) port = portMatch[1]!
      const mediumMatch = /^(\s*)add medium UAV_MESH_MEDIUM\s*$/u.exec(line)
      if (mediumMatch === null) return line
      const medium = `${SHARED_MEDIUM}__${type}__${port}`
      names.push(medium)
      // 保留模板原有 CRLF，避免本地包与交付包仅因换行不同。
      const carriageReturn = line.endsWith('\r') ? '\r' : ''
      return `${mediumMatch[1]}add medium ${medium}${carriageReturn}`
    }).join('\n')
  }
  files[DEFINITION_FILE] += [
    '// 本地运行包：每端口独立介质，避免共享介质速率互相覆盖（对接方 TXT 不含此段）。',
    ...names.flatMap(medium => [`medium ${medium} WSF_COMM_MEDIUM_UNGUIDED`, '  channels 4', '  default_mode_name "default"', '  mode "default"', '    propagation_speed constant 299792458 m/sec', '    transfer_rate constant 4000000 bit/s', '    packet_loss_time constant 0 sec', '  end_mode', 'end_medium', '']),
  ].join('\n')
  return names
}
/** 每条业务选择首条对应热链；不构造配置中不存在的跳点。 */
function businessPaths(routes: RouteInputs): { hops: Hop[]; record: TrafficRecord }[] {
  return routes.traffic.flatMap(item => Object.entries(item).flatMap(([platform, value]) => {
    const forward = Object.values(routes.forward).find(hops => hops.at(-1)?.platform === platform)
    const reverse = Object.values(routes.reverse).find(hops => hops[0]?.platform === platform)
    return [...(forward ? value.forward.map(record => ({ hops: forward, record })) : []),
      ...(reverse ? value.return.map(record => ({ hops: reverse, record })) : [])]
  }))
}
const emptyAux = (): AuxEntry => ({ next: [], out: [], in: [], dst: [], size: [] })
function appendAux(entry: AuxEntry, hops: readonly Hop[], index: number, record: TrafficRecord): void {
  const next = hops[index + 1]!, out = hops[index]!.outPort, dst = hops.at(-1)!.platform
  if (entry.next.some((value, i) => value === next.platform && entry.out[i] === out && entry.in[i] === next.inPort && entry.dst[i] === dst)) return
  entry.next.push(next.platform); entry.out.push(out); entry.in.push(next.inPort); entry.dst.push(dst); entry.size.push(String(record.data_volume_bits))
}
function processorDefaults(routes: RouteInputs, platform: string | undefined, type: string): AuxEntry {
  const entry = emptyAux()
  for (const { hops, record } of businessPaths(routes)) {
    const index = hops.findIndex(hop => hop.platform === platform)
    if (record.traffice_type === type && index >= 0 && index < hops.length - 1) appendAux(entry, hops, index, record)
  }
  return entry
}
/** AuxData 使用真实业务类型和目的地；卫星同时保留模板要求的旧键。 */
export function localAuxRoutes(routes: RouteInputs): Map<string, Map<string, AuxEntry>> {
  const result = new Map<string, Map<string, AuxEntry>>()
  for (const { hops, record } of businessPaths(routes)) {
    hops.slice(0, -1).forEach((hop, index) => {
      const byType = result.get(hop.platform) ?? new Map<string, AuxEntry>()
      result.set(hop.platform, byType)
      const keys = [`${record.traffice_type}_${hops.at(-1)!.platform}`]
      if (hop.platform === 'tiantong_sat' || hop.platform === 'shentong_sat') keys.push(record.traffice_type)
      for (const key of keys) {
        const entry = byType.get(key) ?? emptyAux()
        byType.set(key, entry)
        appendAux(entry, hops, index, record)
      }
    })
  }
  return result
}
/** D4：引擎缺少 WSF_LINK_CALC_PROCESSOR 时替代 link_calc 的本地补丁，只进入本地运行包。 */
export function localLinkStub(host: string, routes: RouteInputs, jammers: readonly Jammer[]): string {
  const aux = [...localAuxRoutes(routes)].flatMap(([platform, byType]) => [
    `        target = WsfSimulation.FindPlatform("${platform}");`, '        if (target.IsValid())', '        {',
    ...[...byType].flatMap(([type, value]) => [
      `          target.SetAuxData("${type}_next_platform_name", "${value.next.join('|')}");`,
      `          target.SetAuxData("${type}_out_port_name", "${value.out.join('|')}");`,
      `          target.SetAuxData("${type}_next_in_port_name", "${value.in.join('|')}");`,
      `          target.SetAuxData("${type}_dst_platform_name", "${value.dst.join('|')}");`,
    ]),
    '        }',
  ])
  // 未启用的干扰设备开局关闭（alq99_jammer 在模板中初始为 on）。
  const disabled = jammers.filter(item => !item.configuredEnabled).flatMap(item => [
    `        target = WsfSimulation.FindPlatform("${item.platformId}");`,
    `        if (target.IsValid() && target.Weapon("${item.weaponId}").IsValid()) { target.Weapon("${item.weaponId}").TurnOff(); }`,
  ])
  const enabled = jammers.map((item, index) => ({ item, index })).filter(({ item }) => item.configuredEnabled)
  return [
    '  processor local_link_stub WSF_SCRIPT_PROCESSOR',
    '    script_variables',
    ...enabled.flatMap(({ index }) => [
      `      bool engaged${index} = false;`, `      double detectAt${index} = -1;`,
      `      double onAt${index} = -1;`, `      bool spent${index} = false;`,
    ]),
    '    end_script_variables',
    '    on_initialize2',
    `      if (PLATFORM.Name() == "${host}")`,
    '      {',
    '        WsfPlatform target;',
    ...aux,
    ...disabled,
    ...enabled.filter(({ item }) => item.detectionDelayS !== undefined || item.jammingDurationS !== undefined).flatMap(({ item }) => [
      `        target = WsfSimulation.FindPlatform("${item.platformId}");`,
      `        if (target.IsValid() && target.Weapon("${item.weaponId}").IsValid()) { target.Weapon("${item.weaponId}").TurnOff(); }`,
    ]),
    '      }',
    '    end_on_initialize2',
    ...(enabled.length ? [
      '    execute at_interval_of 3 sec',
      `      if (PLATFORM.Name() == "${host}")`,
      '      {',
      ...enabled.flatMap(({ item, index: i }) => [
        `        WsfPlatform jammer${i} = WsfSimulation.FindPlatform("${item.platformId}");`,
        `        if (jammer${i}.IsValid())`, '        {',
        `          WsfWeapon weapon${i} = jammer${i}.Weapon("${item.weaponId}");`,
        `          if (weapon${i}.IsValid())`, '          {',
        `            double nearest${i} = -1;`,
        '            for (int j = 0; j < WsfSimulation.PlatformCount(); j = j + 1)', '            {',
        '              WsfPlatform other = WsfSimulation.PlatformEntry(j);',
        '              if (other.Side() == "blue")', '              {',
        `                double range = jammer${i}.SlantRangeTo(other);`,
        `                if (nearest${i} < 0 || range < nearest${i}) { nearest${i} = range; }`,
        '              }', '            }',
        `            if (nearest${i} >= 0)`, '            {',
        `              if (!engaged${i})`, '              {',
        `                if (nearest${i} > ${n(item.releaseRangeM)})`, '                {',
        `                  spent${i} = false;`,
        `                  if (weapon${i}.IsTurnedOn()) { weapon${i}.SelectMode("default"); weapon${i}.TurnOff(); }`,
        '                }', '              }',
        ...(item.jammingDurationS !== undefined ? [
          `              else if (TIME_NOW - onAt${i} >= ${n(item.jammingDurationS)})`, '              {',
          `                weapon${i}.SelectMode("default"); weapon${i}.TurnOff();`,
          `                engaged${i} = false; spent${i} = true; detectAt${i} = -1;`,
          '              }',
        ] : []),
        `              else if (nearest${i} > ${n(item.releaseRangeM)})`, '              {',
        `                weapon${i}.SelectMode("default"); weapon${i}.TurnOff();`,
        `                engaged${i} = false; detectAt${i} = -1;`,
        '              }',
        `              if (!engaged${i} && !spent${i})`, '              {',
        `                if (${n(item.jammingRangeM)} > 0 && nearest${i} <= ${n(item.jammingRangeM)})`, '                {',
        `                  if (detectAt${i} < 0) { detectAt${i} = TIME_NOW; }`,
        `                  if (TIME_NOW - detectAt${i} >= ${n(item.detectionDelayS ?? 0)})`, '                  {',
        `                    if (!weapon${i}.IsTurnedOn()) { weapon${i}.TurnOn(); }`,
        `                    weapon${i}.SelectMode("${JAMMER_SCRIPT_MODE(item.type)}");`,
        `                    engaged${i} = true; onAt${i} = TIME_NOW;`,
        '                  }', '                }',
        `                else { detectAt${i} = -1; }`,
        '              }', '            }', '          }', '        }',
      ]),
      '      }',
      '    end_execute',
    ] : []),
    '  end_processor',
  ].join('\n')
}
function typeTexts(config: ScenarioDraft['config'], relays: readonly string[], jammers: readonly Jammer[], start: string, calc: string, routes: RouteInputs, warnings: string[], resolved: EffectivePorts, localRuntime: boolean): Record<string, string> {
  const radioPorts = (type: TemplatePlatformType) => OUTPUT_PORTS[type].filter(port => port !== 'fiber_link')
  const portValue = (type: TemplatePlatformType, port: string): PortParameters => resolved.values.get(`${type}.${port}`)!
  const interval = readLinkSettings(config).messageIntervalS ?? 5
  const host = (type: Platform['type']) => config.platforms.find(item => item.type === type)?.id
  const variables = (prefix: string, entry: AuxEntry, plural: boolean): RouteDefaults => ({
    [`${prefix}_next${plural ? 's' : ''}`]: entry.next, [`${prefix}_out${plural ? 's' : ''}`]: entry.out,
    [`${prefix}_in${plural ? 's' : ''}`]: entry.in, [`${prefix}_dst${plural ? 's' : ''}`]: entry.dst, [`${prefix}_size`]: entry.size,
  })
  const rear: RouteDefaults = {}, command: RouteDefaults = {}
  for (const [prefix, type] of [['fw_sit', 'kForwardSituation'], ['fw_tgt', 'kForwardTarget'], ['rt_video', 'kReturnReconVideo'], ['rt_status', 'kReturnReconStatus']]) {
    Object.assign(rear, variables(prefix!, processorDefaults(routes, host('REAR_COMMAND_NODE'), type!), false))
    Object.assign(command, variables(prefix!, processorDefaults(routes, host('GROUND_CLUSTER_COMMAND_NODE'), type!), true))
  }
  const returnDefaults = (type: string): AuxEntry => {
    const candidates = config.platforms.filter(item => item.type === 'AIRBORNE_MISSION_CLUSTER')
      .map(item => processorDefaults(routes, item.id, type)).filter(entry => entry.next.length > 0)
    const first = candidates[0] ?? emptyAux()
    if (candidates.some(entry => JSON.stringify(entry) !== JSON.stringify(first))) warnings.push(`${type}：同类任务无人机的首跳或数据量不同，共享 script_proc 默认数组及数据量取第一条返向业务。`)
    return first
  }
  const video = returnDefaults('kReturnReconVideo'), status = returnDefaults('kReturnReconStatus')

  const common = (name: string, signature: string, mover: string, ports: string[], processor: string[]) => ['include_once comm_PerDefinition.txt', '', `platform_type ${name} WSF_PLATFORM`, `  radar_signature ${signature}`, `  mover ${mover}`, '    update_interval 1 sec', '  end_mover', ...ports, ...processor, 'end_platform_type', ''].join('\n')
  return {
    'comm_platform_MISSION_UAV.txt': common('MISSION_UAV_PLATFORM', 'DRONE_SIG', 'WSF_AIR_MOVER', radioPorts('MISSION_UAV_PLATFORM').flatMap(port => radio('MISSION_UAV_PLATFORM', port, portValue('MISSION_UAV_PLATFORM', port))), [...delayProcessors(), ...missionProcessor({ relayNames: [...relays], rt_video_nexts: video.next, rt_video_outs: video.out, rt_video_ins: video.in, rt_video_dsts: video.dst, rt_video_size: Number(video.size[0] ?? 0), rt_status_nexts: status.next, rt_status_outs: status.out, rt_status_ins: status.in, rt_status_dsts: status.dst, rt_status_size: Number(status.size[0] ?? 0) }, interval)]),
    'comm_platform_COMMAND_VEHICLE.txt': common('COMMAND_VEHICLE_PLATFORM', 'COMMAND_VEHICLE_SIG', 'WSF_SURFACE_MOVER', radioPorts('COMMAND_VEHICLE_PLATFORM').flatMap(port => radio('COMMAND_VEHICLE_PLATFORM', port, portValue('COMMAND_VEHICLE_PLATFORM', port))).concat(fiber(portValue('COMMAND_VEHICLE_PLATFORM', 'fiber_link').transferRate)), [...delayProcessors(), ...commandProcessor(command)]),
    'comm_platform_REAR.txt': common('REAR_COMM_PLATFORM', 'COMMAND_VEHICLE_SIG', 'WSF_GROUND_MOVER', radioPorts('REAR_COMM_PLATFORM').flatMap(port => radio('REAR_COMM_PLATFORM', port, portValue('REAR_COMM_PLATFORM', port))).concat(fiber(portValue('REAR_COMM_PLATFORM', 'fiber_link').transferRate)), rearProcessor(rear, interval).concat(calc ? calc.split('\n') : [])),
    'comm_platform_SAT.txt': ['include_once comm_PerDefinition.txt', '', ...satellite('TIAN_TONG_SAT', portValue('TIAN_TONG_SAT', 'sat_link'), start), '', ...satellite('SHEN_TONG_SAT', portValue('SHEN_TONG_SAT', 'sat_link'), start), ''].join('\n'),
    'comm_platform_JAMMER.txt': ['include_once comm_PerDefinition.txt', '', ...jammerType(false, jammers.find(item => item.weaponId === 'prophet_jammer'), localRuntime), ...jammerType(true, jammers.find(item => item.weaponId === 'alq99_jammer'), localRuntime)].join('\n'),
  }
}
function point(value: { latitude: number; longitude: number; altitude: number; speed: number }, suffix = ''): string { return `    position ${position(value.latitude, value.longitude)} altitude ${n(value.altitude)} m speed ${n(value.speed)} m/s${suffix}` }
function route(platform: Platform, airborne = false): string[] {
  const first = platform.waypoints[0]
  const speed = first?.speed ?? platform.loiterWaypoints?.[0]?.speed
  const repeatsInitial = first !== undefined
    && first.latitude === platform.initialPosition.latitude
    && first.longitude === platform.initialPosition.longitude
    && first.altitude === platform.initialPosition.altitude
  const initialPosition = `    position ${position(platform.initialPosition.latitude, platform.initialPosition.longitude)} altitude ${n(platform.initialPosition.altitude)} m`
  const initial = airborne
    ? `${initialPosition} heading 0 deg${speed === undefined ? '' : ` speed ${n(speed)} m/s`}`
    : `${initialPosition}${speed === undefined ? '' : ` speed ${n(speed)} m/s`}`
  const lines = ['  route', initial, ...(repeatsInitial ? platform.waypoints.slice(1) : platform.waypoints).map(item => point(item))]
  const loiter = platform.loiterWaypoints ?? []
  if (loiter.length) {
    const label = airborne ? 'orbit_loop' : 'LOITER'
    lines.push(`    label ${label}`, ...loiter.map(item => point(item, airborne ? ' turn left' : '')), `    goto ${label}`)
  }
  lines.push('  end_route')
  return lines
}
function platformType(platform: Platform): string { if (platform.type === 'REAR_COMMAND_NODE') return 'REAR_COMM_PLATFORM'; if (platform.type === 'GROUND_CLUSTER_COMMAND_NODE') return 'COMMAND_VEHICLE_PLATFORM'; if (platform.type === 'AIRBORNE_MISSION_CLUSTER' || platform.type === 'FORWARD_RELAY_NODE') return 'MISSION_UAV_PLATFORM'; if (platform.type === 'COMMUNICATION_SATELLITE') return platform.satelliteType === 'SHENTONG' ? 'SHEN_TONG_SAT' : 'TIAN_TONG_SAT'; return platform.type === 'AIRBORNE_JAMMER_PLATFORM' ? 'AIRBORNE_JAMMER_PLATFORM' : 'GROUND_JAMMER_STATION' }
/** 写入校验只允许这三类平台携带巡逻航路，状态清单须使用同一判据。 */
function writesLoiter(platform: Platform): boolean { return platform.type === 'AIRBORNE_MISSION_CLUSTER' || platform.type === 'FORWARD_RELAY_NODE' || platform.type === 'AIRBORNE_JAMMER_PLATFORM' }
function instances(config: ScenarioDraft['config']): string {
  const select = (kind: Platform['type']) => config.platforms.filter(item => item.type === kind)
  /** 优先使用平台显式阵营（BLUE/RED/NEUTRAL），旧场景缺省时回退现有类型推断：地面/空中为红方，其余蓝方。 */
  const sideOf = (platform: Platform, kind: 'rear' | 'command' | 'uav' | 'ground' | 'air'): string =>
    platform.faction ? platform.faction.toLowerCase() : kind === 'ground' || kind === 'air' ? 'red' : 'blue'
  const regular = (platform: Platform, kind: 'rear' | 'command' | 'uav' | 'ground' | 'air'): string[] => { const lines = [`platform ${platform.id} ${platformType(platform)}`, `  side ${sideOf(platform, kind)}`]; if (kind === 'command') lines.push('  icon 737'); if (kind === 'uav') lines.push('  icon F-18', '  heading 90 deg'); if (kind === 'ground' || kind === 'air') lines.push('  icon triangle', '  creation_time 0 sec'); if (kind === 'rear' || kind === 'command') { lines.push(`  position ${position(platform.initialPosition.latitude, platform.initialPosition.longitude)}`, `  altitude ${n(platform.initialPosition.altitude)} m`); if (kind === 'command') lines.push('  heading 90 deg'); if (platform.waypoints.length) lines.push(...route(platform)) } else if (kind === 'uav' || kind === 'air') lines.push(...route(platform, kind === 'air')); else { lines.push('  route', `    position ${position(platform.initialPosition.latitude, platform.initialPosition.longitude)}`, ...platform.waypoints.map(item => point(item)), '  end_route'); const jammer = config.jammers.find(item => item.platformId === platform.id); if (jammer) lines.push('  script_variables', `    double detection_range_nm = ${n(jammer.detectionRange / 1852)};`, '  end_script_variables') } lines.push('end_platform', ''); return lines }
  const lines: string[] = []; lines.push(...select('REAR_COMMAND_NODE').flatMap(item => regular(item, 'rear')), ...select('GROUND_CLUSTER_COMMAND_NODE').flatMap(item => regular(item, 'command')))
  select('COMMUNICATION_SATELLITE').forEach(item => lines.push(`platform ${item.id} ${platformType(item)}`, `  side ${item.faction ? item.faction.toLowerCase() : 'blue'}`, '  icon satellite', '  creation_time 0 sec', '  position 0n 120e altitude 35786 km heading 90 degrees', 'end_platform', ''))
  const uavs = [...select('FORWARD_RELAY_NODE'), ...select('AIRBORNE_MISSION_CLUSTER')]
  uavs.filter(item => item.returnPlan).forEach(item => lines.push(`route return_${item.id}`, ...item.returnPlan!.waypoints.map(value => point(value)), 'end_route', ''))
  uavs.forEach(item => {
    const value = regular(item, 'uav')
    if (item.returnPlan) value.splice(value.length - 2, 0, `  execute at_time ${n(item.returnPlan.timeS)} sec absolute`, `    PLATFORM.FollowRoute("return_${item.id}");`, '  end_execute')
    lines.push(...value)
  })
  lines.push(...select('GROUND_JAMMER_DETECTION_STATION').flatMap(item => regular(item, 'ground')), ...select('AIRBORNE_JAMMER_PLATFORM').flatMap(item => regular(item, 'air')))
  return lines.join('\n')
}
/** 场景中按 1112 模板 mission_uav 类型映射的飞行平台：中继与作业无人机。 */
function isMissionUavPlatform(platform: Platform): boolean {
  return platform.type === 'FORWARD_RELAY_NODE' || platform.type === 'AIRBORNE_MISSION_CLUSTER'
}

/** mission_uav 实例序号，用于按模板编号顺序输出。 */
function missionUavIndex(id: string): number {
  const match = /^mission_uav_(\d+)$/u.exec(id)
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1])
}

/**
 * 按场景配置生成 comm_platform_INS.txt 的无人机编队段。
 * @remarks 数量、阵营、初始位置、航点、盘旋和返航均来自场景；实例名沿用 engineNames 的 mission_uav_XX。
 */
function missionUavSection(config: ScenarioDraft['config']): string[] {
  const uavs = config.platforms.filter(isMissionUavPlatform).sort((left, right) => missionUavIndex(left.id) - missionUavIndex(right.id))
  const lines = ['// ============================================================', '// 无人机编队（按场景配置生成：中继与作业无人机）', '// ============================================================', '']
  for (const uav of uavs) {
    if (uav.returnPlan !== undefined) lines.push(`route return_${uav.id}`, ...uav.returnPlan.waypoints.map(value => point(value)), 'end_route', '')
  }
  let clusterIndex = 0
  for (const uav of uavs) {
    const role = uav.type === 'FORWARD_RELAY_NODE' ? 'RELAY' : (['TASK_A', 'TASK_B'][clusterIndex++] ?? 'TASK_EXTRA')
    lines.push(
      `platform ${uav.id} MISSION_UAV_PLATFORM`,
      `  side ${uav.faction ? uav.faction.toLowerCase() : 'blue'}`,
      '  icon F-18',
      '  heading 90 deg',
      ...route(uav),
      '  script_variables',
      `    string uav_role = "${role}";`,
      '  end_script_variables',
      '  execute at_time 1 sec absolute',
      `    writeln("SCENARIO: [INIT] ${uav.id} role=${role} starting");`,
      '  end_execute',
    )
    if (uav.returnPlan !== undefined) {
      lines.push('  execute at_time ' + n(uav.returnPlan.timeS) + ' sec absolute', `    PLATFORM.FollowRoute("return_${uav.id}");`, '  end_execute')
    }
    lines.push('end_platform', '')
  }
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** 本地运行按计算周期采样真实坐标；MoverUpdated 事件不保证固定频率或结束帧。 */
function runtimePositionObserver(path: string, platformName: string, interval: number, duration: number): string {
  return [
    'script_variables',
    '  double wrjPositionTime = -1;',
    'end_script_variables',
    'script void WrjSamplePositions()',
    '  if (TIME_NOW <= wrjPositionTime) return;',
    '  FileIO file = FileIO();',
    '  if (wrjPositionTime < 0)',
    '  {',
    '    file.Open(' + JSON.stringify(path) + ', "out");',
    '    file.Writeln("TIME,NAME,LON,LAT,ALT,SPEED,HEADING");',
    '  }',
    '  else file.Open(' + JSON.stringify(path) + ', "append");',
    '  for (int i = 0; i < WsfSimulation.PlatformCount(); i = i + 1)',
    '  {',
    '    WsfPlatform p = WsfSimulation.PlatformEntry(i);',
    '    file.Writeln(write_str(TIME_NOW, ",", p.Name(), ",", p.Longitude(), ",", p.Latitude(), ",", p.Altitude(), ",", p.Speed(), ",", p.Heading()));',
    '  }',
    '  file.Close();',
    '  wrjPositionTime = TIME_NOW;',
    'end_script',
    'edit platform ' + platformName,
    '  add processor wrj_position_sampler WSF_SCRIPT_PROCESSOR',
    '    update_interval ' + n(interval) + ' sec',
    '    on_update',
    '      WrjSamplePositions();',
    '    end_on_update',
    '  end_processor',
    '  execute at_time ' + n(duration) + ' sec absolute',
    '    WrjSamplePositions();',
    '  end_execute',
    'end_platform',
    '',
  ].join('\n')
}

/** 远端接收只需要模板实例名和端口映射，不依赖脚本生成、输出路径或本机引擎校验。 */
export function buildEngineFrameMapping(config: ScenarioDraft['config']) {
  const names = engineNames(config.platforms)
  const mapped = devices(config)
  return {
    platformNaming: 'TEMPLATE_INSTANCE',
    platforms: config.platforms.map(item => ({ platformId: item.id, name: names.get(item.id)!, generatedType: platformType(item) })),
    devices: mapped.items.map(item => ({ ...item,
      source: { ...item.source, platformId: names.get(item.source.platformId)! },
      target: { ...item.target, platformId: names.get(item.target.platformId)! },
      relayPlatformId: item.relayPlatformId === null ? null : names.get(item.relayPlatformId)!,
    })),
  }
}

/** 1112 模板 comm_platform_INS.txt 中的固定实例名 → 平台类型。 */
function templateInstanceNames(): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of TEMPLATE_1112_FILES['comm_platform_INS.txt'].split(/\r?\n/u)) {
    const match = /^platform (\S+) (\S+)$/u.exec(line)
    if (match !== null) result.set(match[1]!, match[2]!)
  }
  if (result.size === 0) throw new MissionGenerationError('template.comm_platform_INS.txt', '未解析到任何模板平台实例。')
  return result
}

const TEMPLATE_INSTANCE_ORDER = [
  'rear_comm_vehicle', 'command_vehicle', 'tiantong_sat', 'shentong_sat',
  'mission_uav_01', 'mission_uav_02', 'mission_uav_03', 'jammer_station_01', 'jammer_airborne_01',
] as const

/**
 * 场景平台必须映射到 1112 固定 INS 中已存在的实例；mission_uav 段由场景配置动态生成，
 * 允许超过模板的 mission_uav_01..03。超出非无人机实例、重复占用或名称无法映射时生成前报错。
 */
function validateTemplateInstances(config: ScenarioDraft['config']): { names: Map<string, string>; template: Map<string, string>; allowed: Set<string>; warnings: string[] } {
  const template = templateInstanceNames()
  for (const name of TEMPLATE_INSTANCE_ORDER) {
    if (!template.has(name)) throw new MissionGenerationError('template.comm_platform_INS.txt', `模板缺少固定实例 ${name}，无法按 1112 基线生成。`)
  }
  const names = engineNames(config.platforms)
  const dynamicUavNames = new Set(config.platforms.filter(isMissionUavPlatform).map(platform => names.get(platform.id)!))
  const allowed = new Set<string>([...template.keys(), ...dynamicUavNames])
  const occupied = new Map<string, string>()
  const typeByName = new Map(config.platforms.map(platform => [names.get(platform.id)!, platform.type]))
  const warnings: string[] = []
  config.platforms.forEach((platform, index) => {
    const name = names.get(platform.id)
    if (name === undefined) throw new MissionGenerationError(`platforms[${index}].type`, `平台类型 ${platform.type} 没有 1112 模板实例映射。`)
    if (!allowed.has(name)) {
      throw new MissionGenerationError(`platforms[${index}].id`, `平台 ${platform.id} 映射到 ${name}，但 1112 模板固定实例只有 ${TEMPLATE_INSTANCE_ORDER.join('、')}；场景超出模板实例范围。请减少同类平台数量，或由对接方提供新的模板实例。`)
    }
    const previous = occupied.get(name)
    if (previous !== undefined) {
      throw new MissionGenerationError(`platforms[${index}].id`, `平台 ${platform.id} 与 ${previous} 都映射到模板实例 ${name}；固定模板不允许重复占用同一实例。`)
    }
    occupied.set(name, platform.id)
  })
  const relays = config.platforms.filter(platform => platform.type === 'FORWARD_RELAY_NODE')
  const missionUavs = config.platforms.filter(platform => platform.type === 'AIRBORNE_MISSION_CLUSTER')
  if (relays.length > 1) warnings.push(`场景包含 ${relays.length} 架中继平台；模板 JAMMER 脚本与示例按 1 架中继设计，请确认多中继的任务分工。`)
  if (relays.length === 0 && missionUavs.length > 0) warnings.push('场景没有中继平台；relayNames 为空，MISSION_UAV 的中继角色不会出现。')
  const jammerRefs = ['mission_uav_02', 'mission_uav_03'] as const
  const missingJammerRefs = jammerRefs.filter(name => !allowed.has(name))
  if (missingJammerRefs.length > 0) {
    warnings.push(`模板 JAMMER 脚本固定引用 ${jammerRefs.join('、')}；当前场景缺少 ${missingJammerRefs.join('、')}，干扰自动激活判断不会成立。`)
  } else if (jammerRefs.some(name => typeByName.get(name) !== 'AIRBORNE_MISSION_CLUSTER')) {
    warnings.push('模板 JAMMER 脚本固定把 mission_uav_02/03 当作作业无人机；当前编号（中继优先占号）不是作业无人机，干扰脚本的判断对象与模板示例不同。')
  }
  return { names, template, allowed, warnings }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

const INFORMATION_TYPE_NAMES = {
  '态势信息': 'kForwardSituation', '目标指令': 'kForwardTarget', '侦察信息': 'kReturnReconVideo', '状态信息': 'kReturnReconStatus',
} as const
type InformationTypeName = (typeof INFORMATION_TYPE_NAMES)[keyof typeof INFORMATION_TYPE_NAMES]

/**
 * 由已进入 link_calc traffic_type 的业务推导 REAR/MISSION_UAV 数组目的地，避免生成指向不存在或无路由平台的引用。
 * 前向数组取 traffic_type 的键；返向数组取返向业务的接收平台。
 */
function businessDestinations(
  config: ScenarioDraft['config'],
  mapped: readonly Device[],
  traffic: Traffic,
  laserOnlyTargets: ReadonlyMap<number, ReadonlySet<number> | 'ALL'>,
  type: InformationTypeName,
): string[] {
  if (type === 'kForwardSituation' || type === 'kForwardTarget') {
    return uniqueStrings(traffic.flatMap(item => Object.entries(item)
      .filter(([, value]) => value.forward.some(record => record.traffice_type === type))
      .map(([platform]) => platform)))
  }
  const destinations: string[] = []
  config.informationDemand.forEach((demand, index) => {
    if (demand.enabled === false) return
    if (demand.linkId !== undefined && !mapped.some(item => item.linkId === demand.linkId)) return
    if (INFORMATION_TYPE_NAMES[demand.informationType as keyof typeof INFORMATION_TYPE_NAMES] !== type) return
    const associatedDirection = demand.linkId === undefined ? undefined : mapped.find(item => item.linkId === demand.linkId)?.direction
    const direction = demand.direction
      ?? associatedDirection
      ?? INFORMATION_TYPE_DIRECTIONS[demand.informationType as keyof typeof INFORMATION_TYPE_DIRECTIONS]
      ?? 'FORWARD'
    if (direction !== 'REVERSE') return
    const excluded = laserOnlyTargets.get(index)
    if (excluded === 'ALL') return
    const hasReturnTraffic = traffic.some(item => item[demand.sourcePlatformId]?.return.some(record => record.traffice_type === type))
    if (!hasReturnTraffic) return
    demand.destinationPlatformIds.forEach((destination, targetIndex) => {
      if (excluded?.has(targetIndex)) return
      destinations.push(destination)
    })
  })
  return uniqueStrings(destinations)
}

type SimulationSpeed = {
  option: 'full' | 'x1' | 'x2' | 'x4' | 'x8' | 'x16' | 'x32' | 'legacy'
  realtimeEnabled: boolean
  clockRate: number
}

/**
 * 倍速只控制 comm_SimSetup.txt 的 realtime / clock_rate。
 * 全速 = 不启用 realtime + clock_rate 32；xN = realtime + clock_rate N。
 * 旧场景缺省沿用生成器既有约定：clock_rate 2、realtime 启用（即 x2）。
 */
function readSimulationSpeed(config: ScenarioDraft['config']): SimulationSpeed {
  const clockRate = config.scenario.environment.simClockSpeed ?? 2
  if (!Number.isFinite(clockRate) || clockRate <= 0) {
    throw new MissionGenerationError('scenario.environment.simClockSpeed', '仿真时钟倍速必须是大于 0 的有限数。')
  }
  const realtimeEnabled = config.scenario.realtime !== false
  if (!realtimeEnabled) return { option: clockRate === 32 ? 'full' : 'legacy', realtimeEnabled, clockRate }
  const option = ([1, 2, 4, 8, 16, 32] as const).includes(clockRate as 1 | 2 | 4 | 8 | 16 | 32) ? (`x${clockRate}` as SimulationSpeed['option']) : 'legacy'
  return { option, realtimeEnabled, clockRate }
}

/**
 * 把场景「仿真总时长（scenario.duration）」写入 comm_SimSetup.txt 的 end_time。
 * 交付 TXT 与本地运行包都适用；模板该行带行尾注释，匹配前先剥离 `//` 注释与尾随空白，避免替换落空。
 */
function replaceEndTimeWithDuration(files: Record<string, string>, config: ScenarioDraft['config']): void {
  files[ENTRY_FILE] = files[ENTRY_FILE]!.split('\n').map(line => {
    const ending = line.endsWith('\r') ? '\r' : ''
    const body = ending ? line.slice(0, -1) : line
    const code = body.split('//')[0]!.replace(/\s+$/u, '')
    if (/^end_time \S+ \S+$/u.test(code)) return `end_time ${n(config.scenario.duration)} sec${ending}`
    return line
  }).join('\n')
}

/**
 * 把场景 scenario.startTime 写入 comm_SimSetup.txt 的 start_date / start_time。
 * 交付 TXT 与本地运行包都适用；匹配前剥离行尾 `//` 注释，兼容带注释的模板行。
 */
function replaceScenarioStartWithConfig(files: Record<string, string>, config: ScenarioDraft['config']): void {
  const start = startTime(config.scenario.startTime)
  files[ENTRY_FILE] = files[ENTRY_FILE]!.split('\n').map(line => {
    const ending = line.endsWith('\r') ? '\r' : ''
    const body = ending ? line.slice(0, -1) : line
    const code = body.split('//')[0]!.replace(/\s+$/u, '')
    if (/^start_date \S+ \d+ \d+$/u.test(code)) return `start_date ${start.date}${ending}`
    if (/^start_time \d{2}:\d{2}:\d{2}$/u.test(code)) return `start_time ${start.time}${ending}`
    return line
  }).join('\n')
}

/** 本地运行包专用：模板固定绝对路径和场景时间不适用于本机执行，仅在运行副本中替换。 */
function adaptRuntimeFiles(files: Record<string, string>, config: ScenarioDraft['config'], directory: string): void {
  const start = startTime(config.scenario.startTime)
  // 1112 模板是 CRLF；逐行匹配时必须先剥离行尾 \r，再按原行尾回写，否则 $ 锚定规则永远匹配不到。
  const setup = files[ENTRY_FILE]!.split('\n').map(line => {
    const ending = line.endsWith('\r') ? '\r' : ''
    const body = ending ? line.slice(0, -1) : line
    let next: string
    if (/^start_date \S+ \d+ \d+$/u.test(body)) next = `start_date ${start.date}`
    else if (/^start_time \d{2}:\d{2}:\d{2}$/u.test(body)) next = `start_time ${start.time}`
    else if (/^end_time \S+ \S+$/u.test(body)) next = `end_time ${n(config.scenario.duration)} sec`
    else if (/^\s+file .+\.aer$/u.test(body)) next = `   file ${directory}/scenario_events.aer`
    else if (/^\s+file .+\.csv$/u.test(body)) next = `  file ${directory}/scenario_events.csv`
    else return line
    return next + ending
  }).join('\n')
  files[ENTRY_FILE] = setup
  files['observers.txt'] = runtimePositionObserver(`${directory}/position.csv`, config.platforms[0]!.id, readLinkCalcSettings(readLinkSettings(config).linkCalc).updateIntervalS, config.scenario.duration)
}

export function buildMissionPackage(draft: ScenarioDraft, output = configuredScenarioOutput(draft.config.scenario.timeStep), runtime?: LocalRuntimeOptions) {
  const inputConfig = { ...draft.config, output }
  inputConfig.platforms.forEach((platform, index) => {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(platform.id)) {
      throw new MissionGenerationError(`platforms[${index}].id`, '引擎平台编号须以英文字母开头，仅包含字母、数字、下划线或连字符。')
    }
  })
  const report = inspectScenarioConfig(inputConfig, 'write')
  const issue = report.result.errors[0]
  if (issue) throw new MissionGenerationError(issue.fieldPath || 'config', issue.message)
  const names = engineNames(inputConfig.platforms)
  // 仅换名生成副本，保存场景与 input.json 继续使用原编号。
  const config = structuredClone(inputConfig)
  for (const platform of config.platforms) platform.id = names.get(platform.id)!
  for (const link of config.links) {
    link.sourcePlatformId = names.get(link.sourcePlatformId)!
    link.targetPlatformId = names.get(link.targetPlatformId)!
    if (link.relayPlatformId != null) link.relayPlatformId = names.get(link.relayPlatformId)!
  }
  for (const demand of config.informationDemand) {
    demand.sourcePlatformId = names.get(demand.sourcePlatformId)!
    demand.destinationPlatformIds = demand.destinationPlatformIds.map(id => names.get(id)!)
  }
  for (const item of [...config.jammers, ...config.sensors]) item.platformId = names.get(item.platformId)!
  for (const rule of config.linkSettings?.switchRules ?? []) {
    rule.sourcePlatformId = names.get(rule.sourcePlatformId)!
    rule.targetPlatformId = names.get(rule.targetPlatformId)!
  }
  const laserOnlyPaths = laserOnlyBusinessPaths(config)
  const laserOnlyWarnings = laserOnlyPaths.map(item => {
    const demand = config.informationDemand[item.demandIndex]!
    const direction = demand.direction ?? INFORMATION_TYPE_DIRECTIONS[demand.informationType as keyof typeof INFORMATION_TYPE_DIRECTIONS]
    const label = direction === 'FORWARD' ? '前向' : direction === 'REVERSE' ? '返向' : ''
    const message = item.targetIndex === 'ALL'
      ? '该业务已绑定激光链路；激光链路不建立可执行通信路由映射，业务不会生成可执行通信路径。'
      : '该业务到 ' + demand.destinationPlatformIds[item.targetIndex] + ' 的' + label + '路径仅依赖激光链路；激光链路不建立可执行通信路由映射。'
    return { fieldPath: item.fieldPath, message }
  })
  const laserOnlyTargets = new Map<number, Set<number> | 'ALL'>()
  laserOnlyPaths.forEach(({ demandIndex, targetIndex }) => {
    if (targetIndex === 'ALL') {
      laserOnlyTargets.set(demandIndex, 'ALL')
      return
    }
    const existing = laserOnlyTargets.get(demandIndex)
    if (existing === 'ALL') return
    const targetIndexes = existing ?? new Set<number>()
    targetIndexes.add(targetIndex)
    laserOnlyTargets.set(demandIndex, targetIndexes)
  })
  const start = startTime(config.scenario.startTime)
  const directory = outputDirectory(runtime?.outputDirectory ?? config.output.directory)
  const templateInstances = validateTemplateInstances(config)
  const mapped = devices(config)
  const resolved = resolveEffectivePorts(config, mapped.items)
  const allowedCommPorts = configuredCommPortSets(config)
  if (allowedCommPorts !== undefined) {
    const linkSettings = readLinkSettings(config)
    config.links.forEach((link, index) => {
      if (!isConfiguredLinkEnabled(link, linkSettings, config.platforms)) return
      for (const side of resolveLinkRequiredCommPorts(config.platforms, link)) {
        const allowed = allowedCommPorts.get(side.platformType)
        if (allowed !== undefined && !allowed.has(side.portName)) {
          throw new MissionGenerationError(
            `deviceParameters.commPorts.${side.platformType}`,
            `links[${index}] (${link.id}) 使用的端口 ${side.portName} 未包含在允许生成的端口清单中。`,
          )
        }
      }
    })
  }
  const emittedPortParams = portParams(config, resolved, allowedCommPorts)
  const jammers = jammerValues(config, draft.uiExtensions)
  const routes = routeInputs(config, mapped.items, laserOnlyTargets)
  const host = config.platforms.find(item => item.type === 'REAR_COMMAND_NODE')?.id
  const relays = config.platforms.filter(item => item.type === 'FORWARD_RELAY_NODE').map(item => item.id)
  const speed = readSimulationSpeed(config)
  const deliveryCalc = calculator(config, routes, jammers, resolved, emittedPortParams).split('\n')
  const stubCalc = runtime?.linkCalc === 'STUB' && host !== undefined ? localLinkStub(host, routes, jammers).split('\n') : []
  const linkCalcBlock = stubCalc.length > 0 ? stubCalc : deliveryCalc
  const rearSituationDestinations = businessDestinations(config, mapped.items, routes.traffic, laserOnlyTargets, 'kForwardSituation')
  const rearTargetDestinations = businessDestinations(config, mapped.items, routes.traffic, laserOnlyTargets, 'kForwardTarget')
  const returnVideoDestinations = businessDestinations(config, mapped.items, routes.traffic, laserOnlyTargets, 'kReturnReconVideo')
  const returnStatusDestinations = businessDestinations(config, mapped.items, routes.traffic, laserOnlyTargets, 'kReturnReconStatus')
  const templateLimitations: string[] = []
  if (returnVideoDestinations.length > 1) templateLimitations.push(`MISSION_UAV 的 rt_video_dsts 是类型级共享数组，模板无法表达每架无人机不同的返向侦察目的地；当前合并为 ${returnVideoDestinations.join('、')}，所有作业无人机会向这些目的地发送。`)
  if (returnStatusDestinations.length > 1) templateLimitations.push(`MISSION_UAV 的 rt_status_dsts 是类型级共享数组，模板无法表达每架无人机不同的返向状态目的地；当前合并为 ${returnStatusDestinations.join('、')}，所有作业无人机会向这些目的地发送。`)
  if (config.platforms.filter(item => item.type === 'AIRBORNE_MISSION_CLUSTER').length > 1 && routes.traffic.length > 0) {
    const volumes = routes.traffic.flatMap(item => Object.values(item).flatMap(value => [...value.forward, ...value.return].map(record => record.data_volume_bits)))
    if (new Set(volumes).size > 1) templateLimitations.push('模板 MISSION_UAV 固定 SetSizeInBits(8)，link_calc traffic_type 中的不同 data_volume_bits 仅用于链路计算，不改变脚本实际发送位数。')
  }

  const allowedTemplateNames = templateInstances.allowed
  const assertTemplateReference = (name: string, fieldPath: string, label: string): void => {
    if (!allowedTemplateNames.has(name)) throw new MissionGenerationError(fieldPath, `${label}引用了 1112 模板中不存在的平台 ${name}；固定模板不会生成该实例，请修正配置或改用模板实例。`)
  }
  for (const platform of config.platforms) assertTemplateReference(platform.id, 'platforms', '平台实例')
  for (const name of relays) assertTemplateReference(name, 'platforms', 'relay_uav_names ')
  for (const name of [...rearSituationDestinations, ...rearTargetDestinations, ...returnVideoDestinations, ...returnStatusDestinations]) assertTemplateReference(name, 'informationDemand', '业务目的地')
  for (const hops of [...Object.values(routes.forward), ...Object.values(routes.reverse)]) for (const hop of hops) assertTemplateReference(hop.platform, 'linkSettings.hotLinks', '热链跳点')
  for (const jammer of jammers) assertTemplateReference(jammer.platformId, 'jammers', '干扰平台')

  let templateFiles: Record<Template1112FileName, string>
  try {
    templateFiles = renderTemplate1112({
      missionUavLines: missionUavSection(config),
      rearSituationDestinations,
      rearTargetDestinations,
      relayNames: relays,
      returnVideoDestinations,
      returnStatusDestinations,
      linkCalcLines: linkCalcBlock,
      linkCalcHeader: stubCalc.length > 0 ? /^\s*processor local_link_stub WSF_SCRIPT_PROCESSOR\s*$/u : undefined,
      realtimeEnabled: speed.realtimeEnabled,
      clockRate: speed.clockRate,
    }).files
  } catch (error) {
    if (error instanceof TemplateRegionError) throw new MissionGenerationError(`template.${error.fileName}`, error.message)
    throw error
  }

  // 场景数据带端口清单时，仅保留清单内的 comm 段；未配置时保持模板全端口。
  if (allowedCommPorts !== undefined) {
    const allowedByFile = new Map<Template1112FileName, Record<string, ReadonlySet<string>>>()
    for (const [platformType, ports] of allowedCommPorts) {
      const file = TYPE_FILE_BY_PLATFORM[platformType] as Template1112FileName
      const current = allowedByFile.get(file) ?? {}
      current[platformType] = ports
      allowedByFile.set(file, current)
    }
    for (const [file, allowed] of allowedByFile) {
      templateFiles[file] = filterPlatformCommPorts(templateFiles[file], file, allowed)
    }
  }

  const scriptFiles = [SCENARIO_PREVIEW_FILE, ENTRY_FILE, DEFINITION_FILE, ...TYPE_FILES, INSTANCE_FILE, 'observers.txt', AD_HOC_COMM_FILE]
  const templateStartDate = /^start_date (.+)$/mu.exec(templateFiles[ENTRY_FILE])?.[1] ?? start.date
  const templateStartTime = /^start_time (.+)$/mu.exec(templateFiles[ENTRY_FILE])?.[1] ?? start.time
  const templateEventAer = /^\s+file (.+\.aer)$/mu.exec(templateFiles[ENTRY_FILE])?.[1] ?? null
  const templateEventCsv = /^\s+file (.+\.csv)$/mu.exec(templateFiles[ENTRY_FILE])?.[1] ?? null
  const mappedLinkIds = new Set(mapped.items.map(item => item.linkId))
  const portPaths = new Set(mapped.items.flatMap(item => [
    `deviceParameters.ports.${item.source.platformType}.${item.source.deviceId}`,
    `deviceParameters.ports.${item.target.platformType}.${item.target.deviceId}`,
    ...(item.relayPlatformId === null || item.relayDeviceId === null ? [] : [`deviceParameters.ports.MISSION_UAV_PLATFORM.${item.relayDeviceId}`]),
  ]))
  const original = inputConfig
  // manifest 保留原场景编号，因此实例名按原配置重新计算；生成副本使用同一确定性编号规则。
  const inputNames = engineNames(original.platforms)
  const originalSettings = original.linkSettings
  const settings = readLinkSettings(original)
  const localStub = runtime?.linkCalc === 'STUB'
  const activeLinks = original.links.map((link, index) => ({ link, index })).filter(({ link }) => isConfiguredLinkEnabled(link, settings, original.platforms))
  const activeJammers = draft.uiExtensions.jammers.map((extension, index) => ({ extension, index, jammerIndex: original.jammers.findIndex(jammer => jammer.id === extension.jammerId) }))
    .filter(({ extension, jammerIndex }) => original.jammingEnabled === true && extension.enabled && jammerIndex >= 0)
  const emitted = [
    ...(originalSettings?.linkCalc === undefined ? [] : [{ fieldPath: 'linkSettings.linkCalc', detail: '已写入 comm_platform_REAR.txt 的 link_calc 更新周期、BER 门限和编码方案；不再输出模板没有的 jamming_range。' }]),
    ...(originalSettings?.messageIntervalS === undefined ? [] : [{ fieldPath: 'linkSettings.messageIntervalS', detail: '已用于模板固定业务处理器的发送周期（模板为 5 秒，生成器不新增变量）。' }]),
    ...(originalSettings?.hotLinks === undefined ? [] : [{ fieldPath: 'linkSettings.hotLinks', detail: '已写入 link_calc 的 hot_link_fw / hot_link_ret。' }]),
    ...(originalSettings?.priority === undefined ? [] : [{ fieldPath: 'linkSettings.priority', detail: '用于推导热链候选；模板固定执行逻辑不写入优先级。' }]),
    ...(original.scenario.realtime === undefined && original.scenario.environment.simClockSpeed === undefined ? [] : [{ fieldPath: 'scenario.realtime', detail: '与 scenario.environment.simClockSpeed 共同写入 comm_SimSetup.txt 的 realtime / clock_rate。' }]),
    ...original.informationDemand.flatMap((demand, index) => {
      if (demand.enabled === false) return []
      if (laserOnlyTargets.get(index) === 'ALL') return []
      if (demand.linkId !== undefined && !mappedLinkIds.has(demand.linkId)) return []
      return [{ fieldPath: `informationDemand[${index}]`, detail: '已写入 link_calc traffic_type，并汇总到 REAR / MISSION_UAV 的固定目的地数组；激光-only 目标不计入。' }]
    }),
    ...[...portPaths].map(fieldPath => ({ fieldPath, detail: '已写入 link_calc port_params；模板 comm 定义保持固定，不随设备参数改写。' })),
    ...original.links.flatMap((link, index) => mappedLinkIds.has(link.id) ? [{ fieldPath: `links[${index}]`, detail: '已写入 link_calc 的端口映射、热链和业务路径；模板 comm 定义保持固定。' }] : []),
    ...activeJammers.map(({ jammerIndex }) => ({ fieldPath: `jammers[${jammerIndex}]`, detail: '已写入 link_calc 的 jammer_param；模板 JAMMER 平台定义保持固定。' })),
    ...inputConfig.platforms.map((platform, index) => ({
      fieldPath: `platforms[${index}].id`,
      detail: isMissionUavPlatform(platform)
        ? `已映射到模板实例 ${inputNames.get(platform.id)}；mission_uav 实例段由场景配置生成。`
        : `已映射到固定模板实例 ${inputNames.get(platform.id)}；实例、位置和航线由 comm_platform_INS.txt 固定。`,
    })),
    ...original.platforms.flatMap((platform, index) => isMissionUavPlatform(platform) ? [
      { fieldPath: `platforms[${index}].initialPosition`, detail: '已写入 comm_platform_INS.txt 的 mission_uav 实例。' },
      ...(platform.waypoints.length > 0 ? [{ fieldPath: `platforms[${index}].waypoints`, detail: '已写入 comm_platform_INS.txt 的 mission_uav 航线。' }] : []),
      ...((platform.loiterWaypoints?.length ?? 0) > 0 ? [{ fieldPath: `platforms[${index}].loiterWaypoints`, detail: '已写入 comm_platform_INS.txt 的 mission_uav 盘旋航点。' }] : []),
      ...(platform.returnPlan !== undefined ? [{ fieldPath: `platforms[${index}].returnPlan`, detail: '已写入 comm_platform_INS.txt 的 mission_uav 返航航线与执行时刻。' }] : []),
    ] : []),
  ]
  const retainedSnapshot = [
    { fieldPath: 'scenario.startTime', detail: 'start_date / start_time 按 scenario.startTime 写入 comm_SimSetup.txt（交付 TXT 与本地运行包均生效）。' },
    { fieldPath: 'scenario.duration', detail: '仿真总时长写入 comm_SimSetup.txt 的 end_time（交付 TXT 与本地运行包均按场景时长生成）。' },
    ...original.platforms.flatMap((platform, index) => {
      const items: Array<{ fieldPath: string; detail: string }> = []
      if (!isMissionUavPlatform(platform)) {
        items.push({ fieldPath: `platforms[${index}].initialPosition`, detail: 'comm_platform_INS.txt 固定模板实例，不写入配置位置。' })
        if (platform.waypoints.length > 0) items.push({ fieldPath: `platforms[${index}].waypoints`, detail: 'comm_platform_INS.txt 固定模板航线，不写入配置航点/速度。' })
        if ((platform.loiterWaypoints?.length ?? 0) > 0) items.push({ fieldPath: `platforms[${index}].loiterWaypoints`, detail: 'comm_platform_INS.txt 固定模板航线，不写入配置盘旋点。' })
        if (platform.returnPlan !== undefined) items.push({ fieldPath: `platforms[${index}].returnPlan`, detail: 'comm_platform_INS.txt 固定模板航线，不写入配置返航计划。' })
      }
      platform.waypoints.forEach((waypoint, waypointIndex) => {
        if (waypoint.arrivalTime !== undefined) items.push({ fieldPath: `platforms[${index}].waypoints[${waypointIndex}].arrivalTime`, detail: '模板固定航线不读取到达时间，仅保留快照。' })
        if (waypoint.heading !== undefined) items.push({ fieldPath: `platforms[${index}].waypoints[${waypointIndex}].heading`, detail: '模板固定航线不读取航向，仅保留快照。' })
        if (waypoint.acceleration !== undefined) items.push({ fieldPath: `platforms[${index}].waypoints[${waypointIndex}].acceleration`, detail: '模板固定航线不读取加速度，仅保留快照。' })
      })
      return items
    }),
    ...activeJammers.flatMap(({ extension, index }) => [
      { fieldPath: `uiExtensions.jammers[${index}].direction`, detail: '干扰方位角未写入模板固定 JAMMER 段，仅保留快照。' },
      ...(extension.elevation === undefined ? [] : [{ fieldPath: `uiExtensions.jammers[${index}].elevation`, detail: '干扰俯仰角未写入模板固定 JAMMER 段，仅保留快照。' }]),
    ]),
    ...activeLinks.flatMap(({ link, index }) => link.type === 'LASER' ? [{ fieldPath: `links[${index}]`, detail: '激光通信端口在模板中仅保留 lazer_link 基准；激光链路配置仅保留快照。' }] : []),
    ...original.sensors.flatMap((sensor, index) => draft.uiExtensions.sensors.some(extension => extension.sensorId === sensor.id && extension.enabled) ? [{ fieldPath: `sensors[${index}]`, detail: '已启用 ESM 传感器未写入模板，仅保留快照。' }] : []),
    ...(originalSettings?.switchRules?.length ? [{ fieldPath: 'linkSettings.switchRules', detail: '链路切换规则未写入模板固定执行逻辑，仅保留快照。' }] : []),
  ]
  const dependencyUnconfirmed = [
    ...(!localStub ? [{ fieldPath: 'linkSettings.linkCalc', detail: 'WSF_LINK_CALC_PROCESSOR 由外部 AFSIM/LinkCalc 提供；本包已写入参数，但提供方定义待确认。' }] : []),
    ...(runtime === undefined ? activeJammers.flatMap(({ jammerIndex }) => original.platforms.find(platform => platform.id === original.jammers[jammerIndex]!.platformId)?.type === 'GROUND_JAMMER_DETECTION_STATION'
      ? [{ fieldPath: `jammers[${jammerIndex}]`, detail: '已启用地面干扰机对应 prophet_jammer 在模板中被注释；需提供方模板/插件确认。' }]
      : []) : []),
    ...mapped.warnings.map(message => ({ fieldPath: 'links', detail: `未写入端口映射：${message}` })),
  ]
  const executionStatus = {
    emitted,
    retainedSnapshot,
    dependencyUnconfirmed,
    portAdoption: portAdoption(config, resolved, emittedPortParams, allowedCommPorts),
    portConflicts: resolved.conflicts,
    configuredNotEmitted: configuredNotEmitted(config, resolved, emittedPortParams, allowedCommPorts),
    templateRegions: [
      'comm_platform_INS.txt：mission_uav 实例段（数量/阵营/初始位置/航点/盘旋/返航/角色；其余平台实例保持模板原文）',
      'comm_platform_REAR.txt：fw_sit_dst / fw_tgt_dst 数组元素',
      'comm_platform_REAR.txt：link_calc 处理器参数块',
      'comm_platform_MISSION_UAV.txt：relayNames / rt_video_dsts / rt_status_dsts 数组元素',
      'comm_SimSetup.txt：realtime / clock_rate',
      '激光端口 laser_link → lazer_link 的必要声明/引用统一（1112 源模板已统一，命中 0 处）',
    ],
    fixedContent: '除上述区域外，10 个执行 TXT 与 1112 模板逐字节一致；非 mission_uav 平台实例、注释、顺序和固定路径均不随场景改写。',
  }
  const manifest = {
    scope: 'TEMPLATE_ALIGNED_PLATFORM_PORTS',
    engineValidated: false,
    scenarioId: config.scenario.id,
    revision: draft.revision,
    entry: ENTRY_FILE,
    scriptFiles,
    platformNaming: 'TEMPLATE_INSTANCE',
    template: {
      source: TEMPLATE_1112_SOURCE_DIRECTORY,
      sha256: TEMPLATE_1112_SHA256,
      patches: TEMPLATE_1112_PATCHES,
      fixedFiles: [...TYPE_FILES, DEFINITION_FILE, 'observers.txt', AD_HOC_COMM_FILE],
      patchedFiles: [INSTANCE_FILE],
      allowedRegions: executionStatus.templateRegions,
      knownIssues: [
        { id: 'MISSION_UAV_SAT_RX_11_8_MHZ', file: 'comm_platform_MISSION_UAV.txt', detail: 'sat_link 接收频率写为 11.8 MHz（疑似应为 GHz）；模板原文保留，未擅自修正。' },
        { id: 'REAR_ARRAY_TRAILING_BACKSLASH', file: 'comm_platform_REAR.txt', detail: '模板 fw_sit_dst / fw_tgt_dst 行尾带反斜杠；生成时已去除行尾反斜杠，避免 AFSIM 语法错误。' },
        { id: 'GROUND_JAMMER_WEAPON_COMMENTED', file: 'comm_platform_JAMMER.txt', detail: '地面站 prophet_jammer 武器块在模板中被注释；交付 TXT 不补造定义，需提供方确认。' },
        { id: 'AIRBORNE_JAMMER_WEAPON_NAME', file: 'comm_platform_REAR.txt', detail: '模板 jammer_param 的机载项写 prophet_jammer；生成器按实际机载武器写 alq99_jammer，差异已记录待对接方确认。' },
        { id: 'FIXED_MESSAGE_SIZE_VS_LINK_CALC', file: 'comm_platform_REAR.txt / comm_platform_MISSION_UAV.txt', detail: '模板固定 SetSizeInBits(8)，link_calc traffic_type 的 data_volume_bits 来自业务配置；两者语义不一致，未修改固定执行逻辑。' },
        { id: 'TEMPLATE_ABSOLUTE_OUTPUT_PATH', file: 'comm_SimSetup.txt', detail: '交付模板保留 D:\\... 绝对输出路径；本地运行包在运行副本中适配为包内 output 目录，交付 TXT 不改。' },
      ],
    },
    templateInstances: {
      fixed: [...templateInstances.template.keys()],
      mapped: inputConfig.platforms.map(item => ({ platformId: item.id, name: inputNames.get(item.id)!, generatedType: platformType(item) })),
    },
    speed: {
      option: speed.option,
      realtimeEnabled: speed.realtimeEnabled,
      clockRate: speed.clockRate,
      standardOptions: ['全速', 'x1', 'x2', 'x4', 'x8', 'x16', 'x32'],
      fullSpeed: { realtimeEnabled: false, clockRate: 32 },
      compatibility: '旧场景缺少 simClockSpeed 时沿用既有生成器约定 clock_rate 2；缺少 realtime 时按实时处理，即 x2。非实时但倍速非 32 的旧组合按原值保留，不静默改写。',
    },
    platforms: inputConfig.platforms.map(item => ({ platformId: item.id, name: inputNames.get(item.id)!, generatedType: platformType(item) })),
    devices: mapped.items,
    businesses: config.informationDemand.filter(item => item.enabled !== false),
    jammers,
    sensors: [],
    motion: config.platforms.filter(platform => platform.waypoints.length > 0).map(platform => ({
      platformId: platform.id,
      templateFixed: !isMissionUavPlatform(platform),
      waypoints: platform.waypoints.map(waypoint => ({
        longitude: waypoint.longitude, latitude: waypoint.latitude, altitude: waypoint.altitude, speed: waypoint.speed,
        arrivalTimeS: waypoint.arrivalTime, headingDeg: waypoint.heading ?? null, accelerationMps2: waypoint.acceleration ?? null,
        arrivalTimeEnforced: false, headingEnforced: false,
      })),
    })),
    executionStatus,
    jammerPointing: draft.uiExtensions.jammers.map(extension => ({
      jammerId: extension.jammerId, directionDeg: extension.direction, elevationDeg: extension.elevation ?? 0,
      directionEngineMapped: false, elevationEngineMapped: false,
    })),
    linkCalc: {
      emitted: true,
      hostPlatformId: host ?? null,
      excludedOpticalLinkIds: config.links.filter(item => item.type === 'LASER').map(item => item.id),
      jammingRangeEmitted: false,
      note: 'port_params 按模板平台类型共享；jamming_range 不在 1112 模板中，已从交付输出移除。',
    },
    output: {
      configuredDirectory: config.output.directory,
      resolvedDirectory: directory,
      eventsCsvPath: runtime === undefined ? (templateEventCsv ?? `${directory}/scenario_events.csv`) : `${directory}/scenario_events.csv`,
      positionCsvPath: runtime === undefined ? 'output/position.csv' : `${directory}/position.csv`,
      templateEventAerPath: templateEventAer,
      templateEventCsvPath: templateEventCsv,
      eventsEnabled: true,
      linkQualityEnabled: false,
      linkSwitchEnabled: false,
      templateFixedPaths: runtime === undefined,
    },
    scenarioStartTime: {
      value: config.scenario.startTime,
      scriptDate: templateStartDate,
      scriptTime: templateStartTime,
      configuredScriptDate: start.date,
      configuredScriptTime: start.time,
      convention: 'AS_STORED_UTC',
      engineEmitted: runtime !== undefined,
      detail: runtime === undefined ? '交付 TXT 使用模板固定 start_date / start_time；本地运行包另行适配。' : '本地运行包已按场景时间适配。',
    },
    retainedButNotEmitted: [
      '非 mission_uav 平台实例/位置/航线/盘旋/返航（comm_platform_INS.txt 固定）',
      'mission_uav 航点的航向/加速度/到达时间（模板航线执行不读取）',
      'start_date/start_time（交付 TXT 固定；本地运行包适配）；end_time 按 scenario.duration 生成',
      '其余平台航点的航向/加速度/到达时间',
      '干扰方位角/俯仰角',
      '激光通信端口配置（模板只保留 lazer_link 基准）',
      '侦测传感器/ESM',
      '业务 QoS',
      '链路切换规则/优先级/质量门限',
      '调制/BER/编码/增益修正',
      '海峡宽度',
      '时间步长',
      ...laserOnlyWarnings.map(item => `${item.fieldPath}：${item.message}`),
    ],
    warnings: [...mapped.warnings, ...templateInstances.warnings, ...templateLimitations, ...laserOnlyWarnings.map(item => `${item.fieldPath}：${item.message}`)],
  }
  const files: Record<string, string> = {
    [SCENARIO_PREVIEW_FILE]: [`// ${SCENARIO_PREVIEW_FILE}：可追溯入口。`, `// 场景：${config.scenario.name.replace(/[\r\n]+/gu, ' ')}（${config.scenario.id}，修订 ${draft.revision}）`, `// 引用顺序：${ENTRY_FILE} → ${[...TYPE_FILES, INSTANCE_FILE, 'observers.txt'].join(' → ')}`, `include_once ${ENTRY_FILE}`, ''].join('\n'),
    [AD_HOC_COMM_FILE]: templateFiles['ad_hoc_comm.txt'],
    'mapping.json': JSON.stringify(manifest, null, 2) + '\n',
    'input.json': JSON.stringify(draft, null, 2) + '\n',
    'README.txt': [
      '1112 模板脚本包（mission_uav 实例段按场景配置生成）。',
      '10 个执行 TXT 以 1112 模板为基准，只允许变化：INS 的 mission_uav 实例段（数量/阵营/位置/航线/盘旋/返航/角色）、REAR 的 fw_sit_dst/fw_tgt_dst、REAR 的 link_calc 参数块、MISSION_UAV 的 relayNames/rt_video_dsts/rt_status_dsts、comm_SimSetup 的 realtime/clock_rate，以及 lazer_link 命名统一（当前源模板已统一，命中 0 处）。',
      '非 mission_uav 平台实例、固定参数、注释、顺序和模板固定路径均保持原文；mission_uav 的位置/航线写入 INS，其余场景位置/航线保留在 mapping.json / input.json。',
      '交付执行 TXT 已去除模板注释（// 与 # 整行/行尾注释）；全速档不输出 realtime 行（等价于模板中的 //realtime）。',
      '交付 TXT 的 port_params.eirp_dBW 与 jammer_param.weapon_eirp_dBW 统一写 0；配置快照保留原值。',
      `倍速：${speed.option}（realtime ${speed.realtimeEnabled ? '启用' : '不启用'}，clock_rate ${speed.clockRate}）。`,
      'jamming_range 不在 1112 模板中，交付 TXT 不输出。',
      '模板疑似问题：MISSION_UAV sat_link 接收 11.8 MHz；REAR 数组行尾反斜杠（生成时已去除）；地面站 prophet_jammer 武器块被注释；模板 jammer_param 机载项写 prophet_jammer；固定 SetSizeInBits(8) 与 traffic_type 数据量语义不一致；SimSetup 绝对输出路径。',
      ...templateInstances.warnings,
      ...templateLimitations,
      ...mapped.warnings,
    ].join('\n') + '\n',
  }
  for (const name of [ENTRY_FILE, DEFINITION_FILE, ...TYPE_FILES, INSTANCE_FILE, 'observers.txt'] as const) {
    files[name] = templateFiles[name as Template1112FileName]
  }
  // 场景配置的仿真总时长决定脚本 end_time（不再固定为模板的 90 min）。
  replaceEndTimeWithDuration(files, config)
  // 场景配置的开始时间决定 start_date / start_time（交付 TXT 与本地运行包均生效）。
  replaceScenarioStartWithConfig(files, config)
  if (runtime) {
    adaptRuntimeFiles(files, config, directory)
    const media = splitSharedMedium(files)
    const localRuntime = {
      linkCalc: runtime.linkCalc === 'STUB' ? 'MISSING_PROCESSOR_STUBBED' : 'PRESERVED',
      splitMedia: media,
      note: '本地运行包：场景时间/输出路径按本机目录适配；每端口独立介质；位置按链路计算周期及结束时刻采样；缺少 link_calc 时以 local_link_stub 写入主路由 AuxData 并按触发/释放半径启停干扰。本地 stub 按进入触发半径计算延迟，离开触发半径取消等待；持续时长到期后须离开释放半径才重新就绪。判断周期 3 秒，存在约 ±3 秒误差。对接方 TXT 不含这些改动。',
    }
    files['mapping.json'] = JSON.stringify({ ...manifest, localRuntime }, null, 2) + '\n'
    files['README.txt'] += `本地运行兼容：${localRuntime.note}\n`
  }
  // 交付/预览的 TXT 脚本不保留注释；mapping.json、input.json、README.txt 等资料文件不受影响。
  for (const name of scriptFiles) {
    if (typeof files[name] === 'string') files[name] = stripScriptComments(files[name]!)
  }
  return { manifest, files }
}

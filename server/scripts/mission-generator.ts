import type { Link, Platform, ScenarioDraft, TemplateAntennaName, TemplatePlatformType } from '../../src/contracts/domain-models.js'
import { configuredScenarioOutput } from '../../src/config/app.config.js'
import {
  INFORMATION_TYPE_DIRECTIONS,
  inspectScenarioConfig,
  laserOnlyBusinessPaths,
} from '../../src/features/scenarios/scenario-validation.js'
import { isConfiguredLinkEnabled, readLinkSettings } from '../../src/features/scenarios/link-settings.js'
import { readLinkCalcSettings, readNaturalEnvironment } from '../../src/features/scenarios/link-calc-defaults.js'
import { readHotLinks } from '../../src/features/scenarios/hot-links.js'
import { readDeviceParameters, resolveTemplateLinkPorts, templatePlatformType, TEMPLATE_PLATFORM_TYPES } from '../../src/features/scenarios/template-defaults.js'
import { JAMMER_CALC_DEFAULTS, readJammerParameters } from '../../src/features/scenarios/jammer-settings.js'
import { AD_HOC_COMM_FILE, AD_HOC_COMM_TEXT } from './ad-hoc-comm.js'

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
  if (type === 'MISSION_UAV_PLATFORM') return port === 'sat_link' ? 'SAT_UAV_CLUSTER_WIDEBAND_ANTENNA' : port === 'microwave_link' ? 'OMNI_ANTENNA' : port.startsWith('c_') ? 'C_BAND_DIRECTIONAL_UAV_ANTENNA' : 'L_BAND_DIRECTIONAL_UAV_ANTENNA'
  if (type === 'COMMAND_VEHICLE_PLATFORM') return port === 'c_band_uplink' ? 'OMNI_ANTENNA' : port.startsWith('c_') ? 'C_BAND_DIRECTIONAL_VEHICLE_ANTENNA' : 'L_BAND_DIRECTIONAL_VEHICLE_ANTENNA'
  return type === 'REAR_COMM_PLATFORM' && port === 'microwave_link' ? 'MICRO_REAR_PLATFORM_DIR_ANTENNA' : type === 'REAR_COMM_PLATFORM' ? 'SAT_GROUND_MOBILE_ANTENNA' : 'SAT_SPACE_BEAM_ANTENNA'
}
function unit(type: TemplatePlatformType, port: string): 'bit/s' | 'kbits/sec' | 'mbits/sec' {
  if (port === 'fiber_link' || (type !== 'MISSION_UAV_PLATFORM' && type !== 'REAR_COMM_PLATFORM' && type !== 'TIAN_TONG_SAT' && type !== 'SHEN_TONG_SAT')) return 'bit/s'
  if (type === 'TIAN_TONG_SAT') return 'kbits/sec'
  if (type === 'MISSION_UAV_PLATFORM' && (port.startsWith('c_') || port.startsWith('l_'))) return 'bit/s'
  return 'mbits/sec'
}
function radio(type: TemplatePlatformType, port: string, config: ScenarioDraft['config']): string[] {
  const value = readDeviceParameters(config).ports[type]?.[port]
  if (!value) throw new MissionGenerationError(`deviceParameters.ports.${type}.${port}`, '模板端口参数缺失。')
  const radioUnit = unit(type, port)
  const constant = type === 'MISSION_UAV_PLATFORM' || type === 'COMMAND_VEHICLE_PLATFORM' ? 'constant ' : ''
  // 11-06 模板已统一为 vertical，保留此前已验证的同极化通信。
  const polarization = 'vertical'
  const terrain = type === 'MISSION_UAV_PLATFORM' || (type === 'REAR_COMM_PLATFORM' && port === 'microwave_link') ? ['      check_terrain_masking off'] : []
  const tilt = type === 'MISSION_UAV_PLATFORM' && port === 'c_band_downlink' ? ['      antenna_tilt -3 deg'] : []
  return [`  comm ${port} WSF_RADIO_TRANSCEIVER`, '    on', '    network_name COM_MESH_NET', '    add medium UAV_MESH_MEDIUM', '      channels 4', '      mode "default"', `        transfer_rate ${constant}${rate(value.transferRate, radioUnit)} ${radioUnit}`, '      end_mode', '    end_medium', '    transmitter', `      frequency ${n(value.txFrequency / 1000)} GHz`, `      bandwidth ${n(value.txBandwidth)} MHz`, `      power ${n(value.txPower)} W`, `      polarization ${polarization}`, `      antenna_pattern ${antenna(type, port)}`, ...tilt, '      attenuation_model none', '      end_attenuation_model', ...terrain, '    end_transmitter', '    receiver', `      frequency ${n(value.rxFrequency / 1000)} GHz`, `      bandwidth ${n(value.rxBandwidth)} MHz`, `      polarization ${polarization}`, `      antenna_pattern ${antenna(type, port)}`, ...tilt, `      noise_figure ${n(value.noiseFigureDb)} dB`, ...terrain, '      detection_threshold -1000 dB', '    end_receiver', '    internal_link script_proc', '  end_comm']
}
const fiber = () => ['  comm fiber_link WSF_COMM_TRANSCEIVER', '    on', '    network_name FIBER_NET', '    transfer_rate 1000 mbits/sec', '    channels 4', '    internal_link script_proc', '  end_comm']
function definitions(config: ScenarioDraft['config'], localRuntime: boolean): string {
  const parameters = readDeviceParameters(config)
  const lines = (Object.keys(ANTENNAS) as TemplateAntennaName[]).flatMap(name => {
    if (!localRuntime && ['MICRO_UAV_OMNI_ANTENNA', 'MICRO_REAR_PLATFORM_DIR_ANTENNA', 'OMNI_ANTENNA_HIGHGAIN'].includes(name)) return []
    const [azimuth, elevation] = ANTENNAS[name]
    return [`antenna_pattern ${name}`, '  uniform_pattern', `    peak_gain ${n(parameters.antennaGains[name] ?? 0)} dB`, `    azimuth_beamwidth ${azimuth} deg`, `    elevation_beamwidth ${elevation} deg`, '  end_uniform_pattern', 'end_antenna_pattern', '']
  })
  // 本地 /23 网段容纳 50 信息节点的 297 个无线端口；对接方 TXT 保留模板网络块。
  return [...lines, 'radar_signature DRONE_SIG', '  constant 1.0 m^2', 'end_radar_signature', '', 'radar_signature COMMAND_VEHICLE_SIG', '  constant 5.0 m^2', 'end_radar_signature', '', 'radar_signature SAT_SIG', '  constant 3.0 m^2', 'end_radar_signature', '', 'network COM_MESH_NET WSF_COMM_NETWORK_MESH', ...(localRuntime ? ['  network_address 10.0.0.0/23'] : []), 'end_network', '', 'network FIBER_NET WSF_COMM_NETWORK_P2P', 'end_network', '', 'medium UAV_MESH_MEDIUM WSF_COMM_MEDIUM_UNGUIDED', '  channels 4', '  default_mode_name "default"', '  mode "default"', '    propagation_speed constant 299792458 m/sec', '    transfer_rate constant 4000000 bit/s', '    packet_loss_time constant 0 sec', '  end_mode', 'end_medium', '', 'medium FIBER_MEDIUM WSF_COMM_MEDIUM_GUIDED', '  channels 4', '  default_mode_name "default"', '  mode "default"', '    propagation_speed constant 200000000 m/sec', '    transfer_rate constant 1000000 bit/s', '    packet_loss_time constant 0 sec', '  end_mode', 'end_medium', ''].join('\n')
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
function satellite(kind: 'TIAN_TONG_SAT' | 'SHEN_TONG_SAT', config: ScenarioDraft['config'], start: string): string[] {
  const value = readDeviceParameters(config).ports[kind]?.sat_link
  if (!value) throw new MissionGenerationError(`deviceParameters.ports.${kind}.sat_link`, '模板端口参数缺失。')
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
function portParams(config: ScenarioDraft['config']): unknown[] {
  const parameters = readDeviceParameters(config)
  return TEMPLATE_PLATFORM_TYPES.map(type => ({ platform_type: type, comm_params: Object.entries(parameters.ports[type] ?? {}).flatMap(([name, value]) => {
    if (!value) return []
    if (name === 'fiber_link') return { comm_name: name, transmitter: { 'information_rate_bit/s': 1_000_000_000 }, receiver: { 'information_rate_bit/s': 1_000_000_000 } }
    const radioUnit = unit(type, name); const name2 = `information_rate_${radioUnit}`
    const tx: Record<string, number> = { frequency_ghz: value.txFrequency / 1000, bandwidth_mhz: value.txBandwidth, power_w: value.txPower, eirp_dBW: value.eirpDbw!, peak_gain_dB: parameters.antennaGains[antenna(type, name)] ?? 0 }
    const rx: Record<string, number> = { frequency_ghz: value.rxFrequency / 1000, bandwidth_mhz: value.rxBandwidth, peak_gain_dB: parameters.antennaGains[antenna(type, name)] ?? 0, G_T_dBK: value.gtDbk! }
    tx[name2] = Number(rate(value.transferRate, radioUnit)); rx[name2] = Number(rate(value.transferRate, radioUnit)); rx.noise_figure_dB = value.noiseFigureDb
    return { comm_name: name, transmitter: tx, receiver: rx }
  }) }))
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
function jammerValues(config: ScenarioDraft['config'], uiExtensions: ScenarioDraft['uiExtensions']): Jammer[] { const enabled = config.jammingEnabled ?? false; return config.jammers.map(stored => { const value = readJammerParameters(stored); const extension = uiExtensions.jammers.find(item => item.jammerId === value.id); const airborne = config.platforms.find(item => item.id === value.platformId)?.type === 'AIRBORNE_JAMMER_PLATFORM'; return { radarFrequency: value.radarFrequency, radarBandwidth: value.radarBandwidth, radarPower: value.radarPower, noiseFigureDb: value.noiseFigureDb, gtDbk: value.gtDbk, eirpDbw: value.eirpDbw, antennaGainDbi: value.antennaGainDbi, txLossDb: value.txLossDb, sweepDutyCycle: value.sweepDutyCycle, jammerId: value.id, platformId: value.platformId, weaponId: airborne ? 'alq99_jammer' : 'prophet_jammer', type: value.type, configuredEnabled: enabled && (extension?.enabled ?? false), frequencyMHz: value.frequency, bandwidthMHz: value.bandwidth, powerW: value.defaultPower, detectionRangeM: value.detectionRange, detectionMinimumRangeM: value.detectionMinimumRange ?? 1000, jammingRangeM: value.jammingRange, releaseRangeM: value.releaseRange ?? value.jammingRange + 9260, ...(value.detectionDelayS !== undefined ? { detectionDelayS: value.detectionDelayS } : {}), ...(value.jammingDurationS !== undefined ? { jammingDurationS: value.jammingDurationS } : {}) } }) }
type Hop = { platform: string; inPort: string; outPort: string }
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
  const hot = readHotLinks(settings.hotLinks, config.links.filter(link => all.some(item => item.linkId === link.id)), settings.priority)
  return { traffic: traffic(config, all, laserOnlyTargets), forward: chain(hot.forward, all), reverse: chain(hot.reverse, all) }
}
function calculator(
  config: ScenarioDraft['config'],
  routes: RouteInputs,
  jammers: readonly Jammer[],
): string {
  const settings = readLinkSettings(config); const calc = readLinkCalcSettings(settings.linkCalc); const environment = readNaturalEnvironment(config.scenario.environment)
  const natural = { rain: { enabled: environment.rainEnabled, rain_rate_mm_hr: environment.rainRateMmPerHour, rain_altitude_limit_m: environment.rainAltitudeLimitM, rain_attenuation_db: environment.rainAttenuationDb }, cloud: { enabled: environment.cloudEnabled, cloud_altitude_min_m: environment.cloudAltitudeMinM, cloud_altitude_max_m: environment.cloudAltitudeMaxM, cloud_water_density_g_m3: environment.cloudWaterDensityGM3 }, atmosphere: { enabled: true, model: environment.atmosphereModel, simplified_attenuation_db_per_km: environment.simplifiedAttenuationDbPerKm }, misc_loss_db: { polarization_mismatch_db: environment.polarizationMismatchDb, pointing_error_db: environment.pointingErrorDb }, sea_state: { enabled: config.scenario.environment.multipathEnabled, sea_state_level: environment.seaState, low_altitude_threshold_m: environment.seaLowAltitudeThresholdM, path_over_sea_threshold_km: environment.seaPathOverSeaThresholdKm, mode: environment.seaModel, sea_polygon: (environment.seaPolygon ?? []).map(point => ({ lat: point.latitude, lon: point.longitude })), polarization: environment.seaPolarization, sea_water_temp_c: environment.seaWaterTempC, sea_surface_roughness_m: environment.seaSurfaceRoughnessM } }
  const jams = { jammers: jammers.map(item => ({
    platform_name: item.platformId, weapon_name: item.weaponId, jammer_type: item.weaponId === 'alq99_jammer' ? 'airborne' : 'ground',
    G_T_dBK: item.gtDbk, enabled: item.configuredEnabled, mode: item.type === 'BARRAGE' ? 'broadband' : item.type === 'SPOT' ? 'spot' : 'sweep',
    frequency_ghz: item.radarFrequency / 1000, bandwidth_mhz: item.radarBandwidth, power_w: item.radarPower, noise_figure: item.noiseFigureDb,
    weapon_frequency_ghz: item.frequencyMHz / 1000, weapon_bandwidth_mhz: item.bandwidthMHz, weapon_power_w: item.powerW,
    weapon_eirp_dBW: item.eirpDbw, weapon_antenna_gain_dbi: item.antennaGainDbi, tx_loss_db: item.txLossDb,
    detect_radius_nm: item.detectionRangeM / 1852, trigger_radius_nm: item.jammingRangeM / 1852, release_radius_nm: item.releaseRangeM / 1852,
    spot_bandwidth_mhz: item.type === 'SPOT' ? item.bandwidthMHz : 20, sweep_duty_cycle: item.sweepDutyCycle,
  })) }
  return ['  add processor link_calc WSF_LINK_CALC_PROCESSOR', `    update_interval ${n(calc.updateIntervalS)} sec`, `    emergency_threshold ${n(calc.emergencyThreshold)}`, `    warning_threshold ${n(calc.warningThreshold)}`, `    value_threshold_ber ${n(calc.valueThresholdBer)}`, `    jamming_range ${n(calc.jammingRangeKm)}`, `    channel_encoding_scheme ${n(calc.channelEncodingScheme)}`, `    traffic_type ${JSON.stringify(routes.traffic)}`, `    relay_uav_names ${JSON.stringify(config.platforms.filter(item => item.type === 'FORWARD_RELAY_NODE').map(item => item.id))}`, `    hot_link_ret ${JSON.stringify(routes.reverse)}`, `    hot_link_fw ${JSON.stringify(routes.forward)}`, `    port_params ${JSON.stringify(portParams(config))}`, `    natural_environment ${JSON.stringify(natural)}`, `    jammer_param ${JSON.stringify(jams)}`, '  end_processor'].join('\n')
}
/** 本地运行包选项；对接方 TXT、预览和 writeScriptText 都不传，保持模板原样。 */
export type LocalRuntimeOptions = { linkCalc: 'PRESERVE' | 'STUB' }
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
      const typeMatch = /^platform_type (\S+) /u.exec(line)
      if (typeMatch) type = typeMatch[1]!
      const portMatch = /^ {2}comm (\S+) /u.exec(line)
      if (portMatch) port = portMatch[1]!
      if (line !== `    add medium ${SHARED_MEDIUM}`) return line
      const medium = `${SHARED_MEDIUM}__${type}__${port}`
      names.push(medium)
      return `    add medium ${medium}`
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
function typeTexts(config: ScenarioDraft['config'], relays: readonly string[], jammers: readonly Jammer[], start: string, calc: string, routes: RouteInputs, warnings: string[], localRuntime: boolean): Record<string, string> {
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
    'comm_platform_MISSION_UAV.txt': common('MISSION_UAV_PLATFORM', 'DRONE_SIG', 'WSF_AIR_MOVER', ['sat_link', 'microwave_link', 'c_band_uplink', 'c_band_downlink', 'l_band_uplink', 'l_band_downlink'].flatMap(port => radio('MISSION_UAV_PLATFORM', port, config)), missionProcessor({ relayNames: [...relays], rt_video_nexts: video.next, rt_video_outs: video.out, rt_video_ins: video.in, rt_video_dsts: video.dst, rt_video_size: Number(video.size[0] ?? 0), rt_status_nexts: status.next, rt_status_outs: status.out, rt_status_ins: status.in, rt_status_dsts: status.dst, rt_status_size: Number(status.size[0] ?? 0) }, interval)),
    'comm_platform_COMMAND_VEHICLE.txt': common('COMMAND_VEHICLE_PLATFORM', 'COMMAND_VEHICLE_SIG', 'WSF_SURFACE_MOVER', ['c_band_uplink', 'c_band_downlink', 'l_band_uplink', 'l_band_downlink'].flatMap(port => radio('COMMAND_VEHICLE_PLATFORM', port, config)).concat(fiber()), commandProcessor(command)),
    'comm_platform_REAR.txt': common('REAR_COMM_PLATFORM', 'COMMAND_VEHICLE_SIG', 'WSF_GROUND_MOVER', ['sat_link_a', 'sat_link_b', 'microwave_link'].flatMap(port => radio('REAR_COMM_PLATFORM', port, config)).concat(fiber()), rearProcessor(rear, interval).concat(calc ? calc.split('\n') : [])),
    'comm_platform_SAT.txt': ['include_once comm_PerDefinition.txt', '', ...satellite('TIAN_TONG_SAT', config, start), '', ...satellite('SHEN_TONG_SAT', config, start), ''].join('\n'),
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
  const regular = (platform: Platform, kind: 'rear' | 'command' | 'uav' | 'ground' | 'air'): string[] => { const lines = [`platform ${platform.id} ${platformType(platform)}`, `  side ${kind === 'ground' || kind === 'air' ? 'red' : 'blue'}`]; if (kind === 'command') lines.push('  icon 737'); if (kind === 'uav') lines.push('  icon F-18', '  heading 90 deg'); if (kind === 'ground' || kind === 'air') lines.push('  icon triangle', '  creation_time 0 sec'); if (kind === 'rear' || kind === 'command') { lines.push(`  position ${position(platform.initialPosition.latitude, platform.initialPosition.longitude)}`, `  altitude ${n(platform.initialPosition.altitude)} m`); if (kind === 'command') lines.push('  heading 90 deg'); if (platform.waypoints.length) lines.push(...route(platform)) } else if (kind === 'uav' || kind === 'air') lines.push(...route(platform, kind === 'air')); else { lines.push('  route', `    position ${position(platform.initialPosition.latitude, platform.initialPosition.longitude)}`, ...platform.waypoints.map(item => point(item)), '  end_route'); const jammer = config.jammers.find(item => item.platformId === platform.id); if (jammer) lines.push('  script_variables', `    double detection_range_nm = ${n(jammer.detectionRange / 1852)};`, '  end_script_variables') } lines.push('end_platform', ''); return lines }
  const lines: string[] = []; lines.push(...select('REAR_COMMAND_NODE').flatMap(item => regular(item, 'rear')), ...select('GROUND_CLUSTER_COMMAND_NODE').flatMap(item => regular(item, 'command')))
  select('COMMUNICATION_SATELLITE').forEach(item => lines.push(`platform ${item.id} ${platformType(item)}`, '  side blue', '  icon satellite', '  creation_time 0 sec', '  position 0n 120e altitude 35786 km heading 90 degrees', 'end_platform', ''))
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
function observers(path: string): string {
  const io = ['F', 'ileIO'].join('')
  return [
    'script_variables',
    `   string mOutputFile = "${path}";`,
    '   bool flag = 0;',
    'end_script_variables',
    '',
    'script void MoverUpdated(WsfPlatform aPlatform, WsfMover aMover)',
    '{',
    `   ${io} myfile = ${io}();`,
    '   if(flag == 0)',
    '   {',
    '      flag = 1;',
    '      myfile.Open(mOutputFile, "out");',
    '',
    '      string line_flag = write_str("TIME", ",",',
    '                     "NAME", ",",',
    '                     "LON", ",",',
    '                     "LAT", ",",',
    '                     "ALT", ",",',
    '                     "SPEED", ",",',
    '                     "HEADING");',
    '      myfile.Writeln(line_flag);',
    '   }',
    '   else',
    '   {',
    '      myfile.Open(mOutputFile, "append");',
    '   }',
    '',
    '   string line = write_str(TIME_NOW, ",",',
    '      aPlatform.Name(), ",",',
    '      aPlatform.Longitude(), ",",',
    '      aPlatform.Latitude(), ",",',
    '      aPlatform.Altitude(), ",",',
    '      aPlatform.Speed(), ",",',
    '      aPlatform.Heading());',
    '',
    '   myfile.Writeln(line);',
    '   myfile.Close();',
    '}',
    'end_script',
    '',
    'observer',
    '   enable MOVER_UPDATED MoverUpdated',
    'end_observer',
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
      ? '该业务已绑定激光链路；激光链路不写入模板，业务不会生成可执行通信路径。'
      : '该业务到 ' + demand.destinationPlatformIds[item.targetIndex] + ' 的' + label + '路径仅依赖激光链路；激光链路不写入模板。'
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
  const start = startTime(config.scenario.startTime); const directory = outputDirectory(config.output.directory); const mapped = devices(config); const jammers = jammerValues(config, draft.uiExtensions); const routes = routeInputs(config, mapped.items, laserOnlyTargets); const host = config.platforms.find(item => item.type === 'REAR_COMMAND_NODE')?.id; const calc = runtime?.linkCalc === 'STUB' ? (host ? localLinkStub(host, routes, jammers) : '') : calculator(config, routes, jammers); const relays = config.platforms.filter(item => item.type === 'FORWARD_RELAY_NODE').map(item => item.id); const types = typeTexts(config, relays, jammers, `${start.date} ${start.time}`, calc, routes, mapped.warnings, runtime !== undefined)
  const setup = [...TYPE_FILES.map(name => `include_once ${name}`), `include_once ${INSTANCE_FILE}`, 'include_once observers.txt', '', `start_date ${start.date}`, `start_time ${start.time}`, `end_time ${n(config.scenario.duration)} sec`, config.scenario.realtime === false ? 'non-realtime' : 'realtime', `clock_rate ${n(config.scenario.environment.simClockSpeed ?? 2)}`, 'multi_thread', '', 'simulation_name "MultiMethod_UAV_Comm_Scenario"', '', 'event_pipe', `   file ${directory}/scenario_events.aer`, 'end_event_pipe', '', 'csv_event_output', `  file ${directory}/scenario_events.csv`, ...EVENTS.map(name => `  enable ${name}`), 'end_csv_event_output', ''].join('\n')
  const scriptFiles = [SCENARIO_PREVIEW_FILE, ENTRY_FILE, DEFINITION_FILE, ...TYPE_FILES, INSTANCE_FILE, 'observers.txt', AD_HOC_COMM_FILE]
  // mapping.json 是配置快照以外唯一的逐项生成事实来源：只列当前配置实际进入包、保留但未写入或待外部确认的字段。
  const mappedLinkIds = new Set(mapped.items.map(item => item.linkId))
  const portPaths = new Set(mapped.items.flatMap(item => [
    `deviceParameters.ports.${item.source.platformType}.${item.source.deviceId}`,
    `deviceParameters.ports.${item.target.platformType}.${item.target.deviceId}`,
    ...(item.relayPlatformId === null || item.relayDeviceId === null ? [] : [`deviceParameters.ports.MISSION_UAV_PLATFORM.${item.relayDeviceId}`]),
  ]))
  const original = inputConfig
  const originalSettings = original.linkSettings
  const settings = readLinkSettings(original)
  const localStub = runtime?.linkCalc === 'STUB'
  const activeLinks = original.links.map((link, index) => ({ link, index })).filter(({ link }) => isConfiguredLinkEnabled(link, settings, original.platforms))
  const activeJammers = draft.uiExtensions.jammers.map((extension, index) => ({ extension, index, jammerIndex: original.jammers.findIndex(jammer => jammer.id === extension.jammerId) }))
    .filter(({ extension, jammerIndex }) => original.jammingEnabled === true && extension.enabled && jammerIndex >= 0)
  const emitted = [
    { fieldPath: 'scenario.startTime', detail: '已写入 comm_SimSetup.txt 的 start_date/start_time。' },
    { fieldPath: 'scenario.duration', detail: '已写入 comm_SimSetup.txt 的 end_time。' },
    ...original.platforms.flatMap((platform, index) => {
      if (platform.type === 'COMMUNICATION_SATELLITE') return []
      const items = [{ fieldPath: `platforms[${index}].initialPosition`, detail: '已写入平台实例或 route 的初始经纬度和高度。' }]
      if (platform.waypoints.length > 0) items.push({ fieldPath: `platforms[${index}].waypoints`, detail: '已写入 route 的经纬度、高度和速度。' })
      if (writesLoiter(platform) && (platform.loiterWaypoints?.length ?? 0) > 0) items.push({ fieldPath: `platforms[${index}].loiterWaypoints`, detail: '已写入 route 的巡逻航路点。' })
      if ((platform.type === 'AIRBORNE_MISSION_CLUSTER' || platform.type === 'FORWARD_RELAY_NODE') && platform.returnPlan !== undefined) items.push({ fieldPath: `platforms[${index}].returnPlan`, detail: '已写入返回 route 及触发时刻。' })
      return items
    }),
    ...[...portPaths].map(fieldPath => ({ fieldPath, detail: '已写入模板端口的速率、收发频率/带宽/功率和接收噪声系数。' })),
    ...original.links.flatMap((link, index) => mappedLinkIds.has(link.id) ? [{ fieldPath: `links[${index}]`, detail: '已写入 LinkManager 端口映射。' }] : []),
    ...(originalSettings?.messageIntervalS === undefined ? [] : [{ fieldPath: 'linkSettings.messageIntervalS', detail: '已写入业务处理器发送周期。' }]),
    ...(originalSettings?.priority === undefined ? [] : [{ fieldPath: 'linkSettings.priority', detail: '已用于推导写入的热链路由。' }]),
    ...(originalSettings?.hotLinks === undefined ? [] : [{ fieldPath: 'linkSettings.hotLinks', detail: '已写入 LinkCalc 的前向/返向热链。' }]),
    ...(originalSettings?.linkCalc === undefined ? [] : [{ fieldPath: 'linkSettings.linkCalc', detail: '已写入 LinkCalc 的更新周期、BER 门限、干扰范围和编码方案。' }]),
    ...activeJammers.map(({ jammerIndex }) => ({ fieldPath: `jammers[${jammerIndex}]`, detail: '已写入 LinkCalc 的干扰机计算参数和启用状态。' })),
  ]
  const retainedSnapshot = [
    ...original.platforms.flatMap((platform, index) => {
      const items: Array<{ fieldPath: string; detail: string }> = []
      if (platform.type === 'COMMUNICATION_SATELLITE' && activeLinks.some(({ link }) => [link.sourcePlatformId, link.targetPlatformId, link.relayPlatformId].includes(platform.id))) items.push({ fieldPath: `platforms[${index}].initialPosition`, detail: '卫星实例使用模板固定轨道；当前配置位置只保留快照。' })
      if (!writesLoiter(platform) && (platform.loiterWaypoints?.length ?? 0) > 0) items.push({ fieldPath: `platforms[${index}].loiterWaypoints`, detail: '该模板平台未写入巡逻航路点，仅保留快照。' })
      if (!(platform.type === 'AIRBORNE_MISSION_CLUSTER' || platform.type === 'FORWARD_RELAY_NODE') && platform.returnPlan !== undefined) items.push({ fieldPath: `platforms[${index}].returnPlan`, detail: '该模板平台未写入返回航路，仅保留快照。' })
      platform.waypoints.forEach((waypoint, waypointIndex) => {
        if (waypoint.arrivalTime !== undefined) items.push({ fieldPath: `platforms[${index}].waypoints[${waypointIndex}].arrivalTime`, detail: '到达时间不参与模板 route 执行，仅保留快照。' })
        if (waypoint.heading !== undefined) items.push({ fieldPath: `platforms[${index}].waypoints[${waypointIndex}].heading`, detail: '航向不参与模板 route 执行，仅保留快照。' })
        if (waypoint.acceleration !== undefined) items.push({ fieldPath: `platforms[${index}].waypoints[${waypointIndex}].acceleration`, detail: '加速度不参与模板 route 执行，仅保留快照。' })
      })
      return items
    }),
    ...activeJammers.flatMap(({ extension, index }) => [
      { fieldPath: `uiExtensions.jammers[${index}].direction`, detail: '干扰方位角未写入引擎指向控制，仅保留快照。' },
      ...(extension.elevation === undefined ? [] : [{ fieldPath: `uiExtensions.jammers[${index}].elevation`, detail: '干扰俯仰角未写入引擎指向控制，仅保留快照。' }]),
    ]),
    ...activeLinks.flatMap(({ link, index }) => link.type === 'LASER' ? [{ fieldPath: `links[${index}]`, detail: '激光通信端口未写入模板，仅保留快照。' }] : []),
    ...original.sensors.flatMap((sensor, index) => draft.uiExtensions.sensors.some(extension => extension.sensorId === sensor.id && extension.enabled) ? [{ fieldPath: `sensors[${index}]`, detail: '已启用 ESM 传感器未生成引擎模型，仅保留快照。' }] : []),
    ...(originalSettings?.switchRules?.length ? [{ fieldPath: 'linkSettings.switchRules', detail: '链路切换规则未写入模板执行，仅保留快照。' }] : []),
  ]
  const dependencyUnconfirmed = [
    ...(localStub || calc === '' ? [] : [{ fieldPath: 'linkSettings.linkCalc', detail: 'WSF_LINK_CALC_PROCESSOR 由外部 AFSIM/LinkCalc 提供；本包已写入参数，但提供方定义待确认。' }]),
    ...(runtime === undefined ? [
      { fieldPath: 'definitions.antennaPatterns.MICRO_REAR_PLATFORM_DIR_ANTENNA', detail: '对外交付包引用该天线但本包未定义，需由提供方模板/库确认。' },
      { fieldPath: 'definitions.antennaPatterns.OMNI_ANTENNA_HIGHGAIN', detail: '对外交付包引用该天线但本包未定义，需由提供方模板/库确认。' },
    ] : []),
    ...(runtime === undefined ? activeJammers.flatMap(({ jammerIndex }) => original.platforms.find(platform => platform.id === original.jammers[jammerIndex]!.platformId)?.type === 'GROUND_JAMMER_DETECTION_STATION'
      ? [{ fieldPath: `jammers[${jammerIndex}]`, detail: '已启用地面干扰机对应 prophet_jammer 未在对外交付包定义；需提供方模板/插件确认。' }]
      : []) : []),
    ...mapped.warnings.map(message => ({ fieldPath: 'links', detail: `未写入端口映射：${message}` })),
  ]
  const executionStatus = { emitted, retainedSnapshot, dependencyUnconfirmed }
  const manifest = { scope: 'TEMPLATE_ALIGNED_PLATFORM_PORTS', engineValidated: false, scenarioId: config.scenario.id, revision: draft.revision, entry: ENTRY_FILE, scriptFiles, platformNaming: 'TEMPLATE_INSTANCE',
    platforms: inputConfig.platforms.map(item => ({ platformId: item.id, name: names.get(item.id)!, generatedType: platformType(item) })), devices: mapped.items, businesses: config.informationDemand.filter(item => item.enabled !== false), jammers, sensors: [], motion: config.platforms.filter(platform => platform.waypoints.length > 0).map(platform => ({
    platformId: platform.id,
    waypoints: platform.waypoints.map(waypoint => ({
      longitude: waypoint.longitude, latitude: waypoint.latitude, altitude: waypoint.altitude, speed: waypoint.speed,
      arrivalTimeS: waypoint.arrivalTime, headingDeg: waypoint.heading ?? null, accelerationMps2: waypoint.acceleration ?? null,
      // 模板 route 按位置与速度推进；这些配置仅供追溯，不强制引擎运动。
      arrivalTimeEnforced: false, headingEnforced: false,
    })),
  })), executionStatus, jammerPointing: draft.uiExtensions.jammers.map(extension => ({
    jammerId: extension.jammerId, directionDeg: extension.direction, elevationDeg: extension.elevation ?? 0,
    directionEngineMapped: false, elevationEngineMapped: false,
  })), linkCalc: { emitted: true, hostPlatformId: config.platforms.find(item => item.type === 'REAR_COMMAND_NODE')?.id ?? null, excludedOpticalLinkIds: config.links.filter(item => item.type === 'LASER').map(item => item.id), note: 'port_params 按模板平台类型共享。' }, output: { configuredDirectory: config.output.directory, resolvedDirectory: directory, eventsCsvPath: `${directory}/scenario_events.csv`, positionCsvPath: `${directory}/position.csv`, eventsEnabled: true, linkQualityEnabled: false, linkSwitchEnabled: false }, scenarioStartTime: { value: config.scenario.startTime, scriptDate: start.date, scriptTime: start.time, convention: 'AS_STORED_UTC', engineEmitted: true }, retainedButNotEmitted: ['航点航向/加速度/到达时间', '干扰方位角/俯仰角', '激光通信端口', '侦测传感器/ESM', '业务 QoS', '链路切换规则/优先级/质量门限', '调制/BER/编码/增益修正', '海峡宽度', '时间步长', ...laserOnlyWarnings.map(item => `${item.fieldPath}：${item.message}`)], warnings: [...mapped.warnings, ...laserOnlyWarnings.map(item => `${item.fieldPath}：${item.message}`)] }
  const files: Record<string, string> = { [SCENARIO_PREVIEW_FILE]: [`// ${SCENARIO_PREVIEW_FILE}：可追溯入口。`, `// 场景：${config.scenario.name.replace(/[\r\n]+/gu, ' ')}（${config.scenario.id}，修订 ${draft.revision}）`, `// 引用顺序：${ENTRY_FILE} → ${[...TYPE_FILES, INSTANCE_FILE, 'observers.txt'].join(' → ')}`, `include_once ${ENTRY_FILE}`, ''].join('\n'), [ENTRY_FILE]: setup, [DEFINITION_FILE]: definitions(config, runtime !== undefined), ...types, [INSTANCE_FILE]: instances(config), 'observers.txt': observers(`${directory}/position.csv`), [AD_HOC_COMM_FILE]: AD_HOC_COMM_TEXT, 'mapping.json': JSON.stringify(manifest, null, 2) + '\n', 'input.json': JSON.stringify(draft, null, 2) + '\n', 'README.txt': ['新模板对齐脚本包。', '界面保留但不写入脚本：激光链路、侦测/ESM、QoS、切换规则、调制/BER/编码/增益修正、航点扩展和未映射环境字段。', ...mapped.warnings].join('\n') + '\n' }
  if (runtime) {
    const media = splitSharedMedium(files)
    const localRuntime = { linkCalc: runtime.linkCalc === 'STUB' ? 'MISSING_PROCESSOR_STUBBED' : 'PRESERVED', splitMedia: media, note: '本地运行包：每端口独立介质；缺少 link_calc 时以 local_link_stub 写入主路由 AuxData 并按触发/释放半径启停干扰。本地 stub 按进入触发半径计算延迟，离开触发半径取消等待；持续时长到期后须离开释放半径才重新就绪。判断周期 3 秒，存在约 ±3 秒误差。对接方 TXT 不含这些改动。' }
    files['mapping.json'] = JSON.stringify({ ...manifest, localRuntime }, null, 2) + '\n'
    files['README.txt'] += `本地运行兼容：${localRuntime.note}\n`
  }
  return { manifest, files }
}

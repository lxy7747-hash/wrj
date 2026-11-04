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
  MICRO_UAV_OMNI_ANTENNA: [360, 65], MICRO_REAR_PLATFORM_DIR_ANTENNA: [12, 12], OMNI_ANTENNA_HIGHGAIN: [360, 180],
  C_BAND_DIRECTIONAL_VEHICLE_ANTENNA: [15, 88], C_BAND_DIRECTIONAL_UAV_ANTENNA: [360, 88], L_BAND_DIRECTIONAL_VEHICLE_ANTENNA: [20, 88], L_BAND_DIRECTIONAL_UAV_ANTENNA: [360, 70],
  SAT_GROUND_MOBILE_ANTENNA: [4, 4], SAT_SPACE_BEAM_ANTENNA: [45, 45], SAT_UAV_CLUSTER_WIDEBAND_ANTENNA: [110, 100], LASER_COMM_ANTENNA: [5, 5],
}
type Device = { linkId: string; linkType: Link['type']; direction: Link['direction']; source: { platformId: string; deviceId: string; platformType: TemplatePlatformType }; target: { platformId: string; deviceId: string; platformType: TemplatePlatformType }; relayPlatformId: string | null; relayDeviceId: string | null }
type Jammer = { jammerId: string; platformId: string; weaponId: 'prophet_jammer' | 'alq99_jammer'; type: string; configuredEnabled: boolean; frequencyMHz: number; bandwidthMHz: number; powerW: number; detectionRangeM: number; detectionMinimumRangeM: number; jammingRangeM: number; releaseRangeM: number }

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
  if (type === 'MISSION_UAV_PLATFORM') return port === 'sat_link' ? 'SAT_UAV_CLUSTER_WIDEBAND_ANTENNA' : port === 'microwave_link' ? 'MICRO_UAV_OMNI_ANTENNA' : port.startsWith('c_') ? 'C_BAND_DIRECTIONAL_UAV_ANTENNA' : 'L_BAND_DIRECTIONAL_UAV_ANTENNA'
  if (type === 'COMMAND_VEHICLE_PLATFORM') return port.startsWith('c_') ? 'C_BAND_DIRECTIONAL_VEHICLE_ANTENNA' : 'L_BAND_DIRECTIONAL_VEHICLE_ANTENNA'
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
  // 2026-11-01 用户裁定：模板后方车微波为 horizontal，与无人机全向天线 vertical 交叉极化，
  // 本机引擎实测完全收不到；统一为 vertical（对照测试白名单第 10 项）。
  const polarization = 'vertical'
  const tilt = type === 'MISSION_UAV_PLATFORM' && port === 'c_band_downlink' ? ['      antenna_tilt -3 deg'] : []
  return [`  comm ${port} WSF_RADIO_TRANSCEIVER`, '    on', '    network_name COM_MESH_NET', '    add medium UAV_MESH_MEDIUM', '      channels 4', '      mode "default"', `        transfer_rate ${constant}${rate(value.transferRate, radioUnit)} ${radioUnit}`, '      end_mode', '    end_medium', '    transmitter', `      frequency ${n(value.txFrequency / 1000)} GHz`, `      bandwidth ${n(value.txBandwidth)} MHz`, `      power ${n(value.txPower)} W`, `      polarization ${polarization}`, `      antenna_pattern ${antenna(type, port)}`, ...tilt, '      attenuation_model none', '      end_attenuation_model', '    end_transmitter', '    receiver', `      frequency ${n(value.rxFrequency / 1000)} GHz`, `      bandwidth ${n(value.rxBandwidth)} MHz`, `      polarization ${polarization}`, `      antenna_pattern ${antenna(type, port)}`, ...tilt, `      noise_figure ${n(value.noiseFigureDb)} dB`, '    end_receiver', '    internal_link script_proc', '  end_comm']
}
const fiber = () => ['  comm fiber_link WSF_COMM_TRANSCEIVER', '    on', '    network_name FIBER_NET', '    transfer_rate 1000 mbits/sec', '    channels 4', '    internal_link script_proc', '  end_comm']
function definitions(config: ScenarioDraft['config']): string {
  const parameters = readDeviceParameters(config)
  const lines = (Object.keys(ANTENNAS) as TemplateAntennaName[]).flatMap(name => {
    const [azimuth, elevation] = ANTENNAS[name]
    return [`antenna_pattern ${name}`, '  uniform_pattern', `    peak_gain ${n(parameters.antennaGains[name] ?? 0)} dB`, `    azimuth_beamwidth ${azimuth} deg`, `    elevation_beamwidth ${elevation} deg`, '  end_uniform_pattern', 'end_antenna_pattern', '']
  })
  return [...lines, 'radar_signature DRONE_SIG', '  constant 1.0 m^2', 'end_radar_signature', '', 'radar_signature COMMAND_VEHICLE_SIG', '  constant 5.0 m^2', 'end_radar_signature', '', 'radar_signature SAT_SIG', '  constant 3.0 m^2', 'end_radar_signature', '', 'network COM_MESH_NET WSF_COMM_NETWORK_MESH', 'end_network', '', 'network FIBER_NET WSF_COMM_NETWORK_P2P', 'end_network', '', 'medium UAV_MESH_MEDIUM WSF_COMM_MEDIUM_UNGUIDED', '  channels 4', '  default_mode_name "default"', '  mode "default"', '    propagation_speed constant 299792458 m/sec', '    transfer_rate constant 4000000 bit/s', '    packet_loss_time constant 0 sec', '  end_mode', 'end_medium', '', 'medium FIBER_MEDIUM WSF_COMM_MEDIUM_GUIDED', '  channels 4', '  default_mode_name "default"', '  mode "default"', '    propagation_speed constant 200000000 m/sec', '    transfer_rate constant 1000000 bit/s', '    packet_loss_time constant 0 sec', '  end_mode', 'end_medium', ''].join('\n')
}
function missionProcessor(relays: readonly string[]): string[] {
  const items = relays.map(item => `"${item}"`).join(', ')
  const emit = (type: 'kReturnReconVideo' | 'kReturnReconStatus', suffix = '') => [
    `        string nxts${suffix} = PLATFORM.AuxDataString("${type}_next_platform_name");`,
    `        if (nxts${suffix} != "")`, '        {', `          Array<string> nexts${suffix} = nxts${suffix}.Split("|");`,
    `          Array<string> outs${suffix} = PLATFORM.AuxDataString("${type}_out_port_name").Split("|");`,
    `          Array<string> ins${suffix} = PLATFORM.AuxDataString("${type}_next_in_port_name").Split("|");`,
    `          Array<string> sizes${suffix} = PLATFORM.AuxDataString("${type}_data_size").Split("|");`,
    `          foreach (int i : string nxt in nexts${suffix})`, '          {', '            WsfMessage msg = WsfMessage();',
    `            msg.SetType("${type}");`, `            msg.SetSizeInBits((int)sizes${suffix}[i]);`,
    '            msg.SetAuxData("origin_sender", PLATFORM.Name());', `            PLATFORM.Comm(outs${suffix}[i]).SendMessage(msg, nxt, ins${suffix}[i]);`, '          }', '        }',
  ]
  const receive = (type: string) => [
    `      type ${type}`, '        script',
    '          string nxts = PLATFORM.AuxDataString("kReturnReconVideo_next_platform_name");',
    '          if (nxts != "") {', '            Array<string> nexts = nxts.Split("|");',
    '            Array<string> outs = PLATFORM.AuxDataString("kReturnReconVideo_out_port_name").Split("|");',
    '            Array<string> ins = PLATFORM.AuxDataString("kReturnReconVideo_next_in_port_name").Split("|");',
    '            foreach (int i : string nxt in nexts) {', '              PLATFORM.Comm(outs[i]).SendMessage(MESSAGE, nxt, ins[i]);', '            }', '          }', '        end_script',
  ]
  return [
    '  processor script_proc WSF_SCRIPT_PROCESSOR', '    report_to commander via microwave_link', '    update_interval 1 sec',
    '    script_variables', `      Array<string> relayNames = { ${items} };`, '      bool isRelay = false;', '    end_script_variables',
    '    on_initialize', '      foreach (string name in relayNames)', '        if (name == PLATFORM.Name())', '          isRelay = true;', '    end_on_initialize',
    '    execute at_interval_of 5 sec', '      if (!isRelay)', '      {', ...emit('kReturnReconVideo'), ...emit('kReturnReconStatus', '2'), '      }', '    end_execute',
    '    on_message', ...['kReturnReconVideo', 'kReturnReconStatus', 'kForwardTarget', 'kForwardSituation'].flatMap(receive),
    '      default', '        script', '          writeln(PLATFORM.Name() + " RECV " + MESSAGE.Type() + " from " + MESSAGE.Originator());', '        end_script',
    '    end_on_message', '  end_processor',
  ]
}
function rearProcessor(): string[] {
  const emit = (type: 'kForwardSituation' | 'kForwardTarget', suffix = '') => [
    `      string nxts${suffix} = PLATFORM.AuxDataString("${type}_next_platform_name");`, `      if (nxts${suffix} != "") {`,
    `        Array<string> nexts${suffix} = nxts${suffix}.Split("|");`, `        Array<string> outs${suffix} = PLATFORM.AuxDataString("${type}_out_port_name").Split("|");`,
    `        Array<string> ins${suffix} = PLATFORM.AuxDataString("${type}_next_in_port_name").Split("|");`, `        Array<string> sizes${suffix} = PLATFORM.AuxDataString("${type}_data_size").Split("|");`,
    `        foreach (int i : string nxt in nexts${suffix}) {`, '          WsfMessage msg = WsfMessage();', `          msg.SetType("${type}");`,
    `          msg.SetSizeInBits((int)sizes${suffix}[i]);`, '          msg.SetAuxData("origin_sender", PLATFORM.Name());', `          PLATFORM.Comm(outs${suffix}[i]).SendMessage(msg, nxt, ins${suffix}[i]);`, '        }', '      }',
  ]
  return ['  processor script_proc WSF_SCRIPT_PROCESSOR', '    execute at_interval_of 5 sec', ...emit('kForwardSituation'), ...emit('kForwardTarget', '2'), '    end_execute', '    on_message', '    end_on_message', '  end_processor']
}
function satellite(kind: 'TIAN_TONG_SAT' | 'SHEN_TONG_SAT', config: ScenarioDraft['config'], start: string): string[] {
  const value = readDeviceParameters(config).ports[kind]?.sat_link
  if (!value) throw new MissionGenerationError(`deviceParameters.ports.${kind}.sat_link`, '模板端口参数缺失。')
  const radioUnit = unit(kind, 'sat_link')
  return [`platform_type ${kind} WSF_PLATFORM`, '  radar_signature SAT_SIG', '  mover WSF_SPACE_MOVER', '    update_interval 1 sec', '    oblate_earth true', '    orbital_state', `      epoch_date_time ${start}`, '      semi_major_axis 42164 km', '      eccentricity 0.0', '      inclination 0 deg', '      raan 120 deg', '      argument_of_periapsis 0 deg', '      mean_anomaly 0 deg', '    end_orbital_state', '  end_mover', '  comm sat_link WSF_RADIO_TRANSCEIVER', '    on', '    network_name COM_MESH_NET', '    add medium UAV_MESH_MEDIUM', '      channels 4', '      mode "default"', `        transfer_rate ${rate(value.transferRate, radioUnit)} ${radioUnit}`, '      end_mode', '    end_medium', '    transmitter', `      frequency ${n(value.txFrequency / 1000)} GHz`, `      bandwidth ${n(value.txBandwidth)} MHz`, `      power ${n(value.txPower)} W`, '      polarization vertical', '      antenna_pattern SAT_SPACE_BEAM_ANTENNA', '      attenuation_model none', '      end_attenuation_model', '    end_transmitter', '    receiver', `      frequency ${n(value.rxFrequency / 1000)} GHz`, `      bandwidth ${n(value.rxBandwidth)} MHz`, '      polarization vertical', '      antenna_pattern SAT_SPACE_BEAM_ANTENNA', `      noise_figure ${n(value.noiseFigureDb)} dB`, '    end_receiver', '    internal_link script_proc', '  end_comm', '  processor script_proc WSF_SCRIPT_PROCESSOR', ...(kind === 'SHEN_TONG_SAT' ? ['    on_message', '    end_on_message'] : []), '  end_processor', 'end_platform_type']
}
function jammerType(airborne: boolean, jammer: Jammer | undefined): string[] {
  const defaults = airborne ? { frequency: 2400, bandwidth: 20, power: 100 } : { frequency: 2400, bandwidth: 50, power: 200 }
  const weapon = airborne ? 'alq99_jammer' : 'prophet_jammer'
  return [`platform_type ${airborne ? 'AIRBORNE_JAMMER_PLATFORM' : 'GROUND_JAMMER_STATION'} WSF_PLATFORM`, `  radar_signature ${airborne ? 'DRONE_SIG' : 'COMMAND_VEHICLE_SIG'}`, `  mover ${airborne ? 'WSF_AIR_MOVER' : 'WSF_SURFACE_MOVER'}`, '    update_interval 1 sec', '  end_mover', '  sensor detection_radar WSF_RADAR_SENSOR', '    mode default', '      frame_time 5 sec', '      beam 1', '        azimuth_field_of_view -180 deg 180 deg', '        elevation_field_of_view -10 deg 10 deg', `        minimum_range ${n((jammer?.detectionMinimumRangeM ?? 1000) / 1000)} km`, `        maximum_range ${n(jammer?.detectionRangeM ?? 55560)} m`, '        transmitter', '          frequency 2.4 GHz', '          power 1000 W', '        end_transmitter', '        receiver', '          noise_figure 3 dB', '          bandwidth 1 MHz', '        end_receiver', '      end_beam', '      reports_location', '      reports_velocity', '      reports_bearing', '    end_mode', '    on', '  end_sensor', `  weapon ${weapon} WSF_RF_JAMMER`, airborne ? '    on' : '    off', '    mode_template', '      transmitter', `        frequency ${n((jammer?.frequencyMHz ?? defaults.frequency) / 1000)} GHz`, `        bandwidth ${n(jammer?.bandwidthMHz ?? defaults.bandwidth)} MHz`, `        power ${n(jammer?.powerW ?? defaults.power)} W`, '        antenna_pattern OMNI_ANTENNA_HIGHGAIN', '      end_transmitter', '    end_mode_template', ...(!airborne ? ['    mode default', '    end_mode'] : []), '    mode broadband_jamming', '    end_mode', '    mode spot_jamming', '    end_mode', '    mode sweep_jamming', '    end_mode', ...(airborne ? ['    mode default', '    end_mode'] : []), '  end_weapon', ...(!airborne ? ['  processor auto_jammer_proc WSF_SCRIPT_PROCESSOR', '  end_processor'] : []), '  processor script_proc WSF_SCRIPT_PROCESSOR', '  end_processor', 'end_platform_type', '']
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
    const tx: Record<string, number> = { frequency_ghz: value.txFrequency / 1000, bandwidth_mhz: value.txBandwidth, power_w: value.txPower, peak_gain_dB: parameters.antennaGains[antenna(type, name)] ?? 0 }
    const rx: Record<string, number> = { frequency_ghz: value.rxFrequency / 1000, bandwidth_mhz: value.rxBandwidth, peak_gain_dB: parameters.antennaGains[antenna(type, name)] ?? 0 }
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
function jammerValues(config: ScenarioDraft['config'], uiExtensions: ScenarioDraft['uiExtensions']): Jammer[] { const enabled = config.jammingEnabled ?? false; return config.jammers.map(value => { const extension = uiExtensions.jammers.find(item => item.jammerId === value.id); const airborne = config.platforms.find(item => item.id === value.platformId)?.type === 'AIRBORNE_JAMMER_PLATFORM'; return { jammerId: value.id, platformId: value.platformId, weaponId: airborne ? 'alq99_jammer' : 'prophet_jammer', type: value.type, configuredEnabled: enabled && (extension?.enabled ?? false), frequencyMHz: value.frequency, bandwidthMHz: value.bandwidth, powerW: value.defaultPower, detectionRangeM: value.detectionRange, detectionMinimumRangeM: value.detectionMinimumRange ?? 1000, jammingRangeM: value.jammingRange, releaseRangeM: value.releaseRange ?? value.jammingRange + 9260 } }) }
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
  const jams = { jammers: jammers.map(item => ({ platform_name: item.platformId, weapon_name: item.weaponId, jammer_type: item.weaponId === 'alq99_jammer' ? 'airborne' : 'ground', enabled: item.configuredEnabled, mode: item.type === 'BARRAGE' ? 'broadband' : item.type === 'SPOT' ? 'spot' : 'sweep', frequency_hz: item.frequencyMHz * 1_000_000, bandwidth_hz: item.bandwidthMHz * 1_000_000, power_w: item.powerW, antenna_gain_dbi: 0, tx_loss_db: 0, trigger_radius_nm: item.jammingRangeM / 1852, release_radius_nm: item.releaseRangeM / 1852, spot_bandwidth_mhz: 20, sweep_duty_cycle: 0.1 })) }
  return ['  add processor link_calc WSF_LINK_CALC_PROCESSOR', '    update_interval 5 sec', `    emergency_threshold ${n(calc.emergencyThreshold)}`, `    warning_threshold ${n(calc.warningThreshold)}`, `    value_threshold_ber ${n(calc.valueThresholdBer)}`, `    jamming_range ${n(calc.jammingRangeKm)}`, `    channel_encoding_scheme ${n(calc.channelEncodingScheme)}`, `    traffic_type ${JSON.stringify(routes.traffic)}`, `    relay_uav_names ${JSON.stringify(config.platforms.filter(item => item.type === 'FORWARD_RELAY_NODE').map(item => item.id))}`, `    hot_link_ret ${JSON.stringify(routes.reverse)}`, `    hot_link_fw ${JSON.stringify(routes.forward)}`, `    port_params ${JSON.stringify(portParams(config))}`, `    natural_environment ${JSON.stringify(natural)}`, `    jammer_param ${JSON.stringify(jams)}`, '  end_processor'].join('\n')
}
/** 本地运行包选项；对接方 TXT、预览和 writeScriptText 都不传，保持模板原样。 */
export type LocalRuntimeOptions = { linkCalc: 'PRESERVE' | 'STUB' }
const SHARED_MEDIUM = 'UAV_MESH_MEDIUM'
const JAMMER_SCRIPT_MODE = (type: string) => type === 'BARRAGE' ? 'broadband_jamming' : type === 'SPOT' ? 'spot_jamming' : 'sweep_jamming'
type AuxEntry = { next: string[]; out: string[]; in: string[]; size: string[] }
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
/**
 * 按热链与 traffic_type 推导模板 script_proc 读取的 4 个 AuxData 键（多值以 | 分隔）。
 * 前向业务取以目标平台结尾的第一条前向热链，回传业务取以源平台开头的第一条回传热链（主路由）。
 * 源节点按业务类型逐条写入（保留数据量）。中间节点只有任务机类 on_message 会转发，且模板四个分支
 * 都读取 kReturnReconVideo_* 键，所以中间跳统一写到该键下，并按（下一跳、出端口、入端口）去重。
 * 限制：消息不携带最终目的地，中继会把收到的消息转发到它的全部下一跳；指挥车、卫星的
 * on_message 在模板中为空，不会继续转发。
 */
export function localAuxRoutes(routes: RouteInputs): Map<string, Map<string, AuxEntry>> {
  const result = new Map<string, Map<string, AuxEntry>>()
  const add = (platform: string, type: string, next: string, out: string, inPort: string, size: number, origin: boolean) => {
    const byType = result.get(platform) ?? new Map<string, AuxEntry>()
    result.set(platform, byType)
    const entry = byType.get(type) ?? { next: [], out: [], in: [], size: [] }
    byType.set(type, entry)
    if (!origin && entry.next.some((value, index) => value === next && entry.out[index] === out && entry.in[index] === inPort)) return
    entry.next.push(next); entry.out.push(out); entry.in.push(inPort); entry.size.push(String(size))
  }
  const walk = (hops: readonly Hop[], record: TrafficRecord) => hops.slice(0, -1).forEach((hop, index) =>
    add(hop.platform, index === 0 ? record.traffice_type : 'kReturnReconVideo', hops[index + 1]!.platform, hop.outPort, hops[index + 1]!.inPort, record.data_volume_bits, index === 0))
  routes.traffic.forEach(item => Object.entries(item).forEach(([platform, value]) => {
    const forward = Object.values(routes.forward).find(hops => hops.at(-1)?.platform === platform)
    const reverse = Object.values(routes.reverse).find(hops => hops[0]?.platform === platform)
    if (forward) value.forward.forEach(record => walk(forward, record))
    if (reverse) value.return.forEach(record => walk(reverse, record))
  }))
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
      `          target.SetAuxData("${type}_data_size", "${value.size.join('|')}");`,
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
    '    script_variables', ...enabled.map(({ index }) => `      bool engaged${index} = false;`), '    end_script_variables',
    '    script bool LocalStubJammer(string aPlatform, string aWeapon, string aMode, double aTrigger, double aRelease, bool aEngaged)',
    '      WsfPlatform jammer = WsfSimulation.FindPlatform(aPlatform);',
    '      if (!jammer.IsValid()) { return aEngaged; }',
    '      WsfWeapon weapon = jammer.Weapon(aWeapon);',
    '      if (!weapon.IsValid()) { return aEngaged; }',
    '      double nearest = -1;',
    '      for (int i = 0; i < WsfSimulation.PlatformCount(); i = i + 1)',
    '      {',
    '        WsfPlatform other = WsfSimulation.PlatformEntry(i);',
    '        if (other.Side() == "blue")',
    '        {',
    '          double range = jammer.SlantRangeTo(other);',
    '          if (nearest < 0 || range < nearest) { nearest = range; }',
    '        }',
    '      }',
    '      if (nearest < 0) { return aEngaged; }',
    '      // 触发半径为 0 表示不按距离开启。',
    '      if (!aEngaged && aTrigger > 0 && nearest <= aTrigger)',
    '      {',
    '        if (!weapon.IsTurnedOn()) { weapon.TurnOn(); }',
    '        weapon.SelectMode(aMode);',
    '        return true;',
    '      }',
    '      if (nearest > aRelease && weapon.IsTurnedOn())',
    '      {',
    '        weapon.SelectMode("default");',
    '        weapon.TurnOff();',
    '        return false;',
    '      }',
    '      return aEngaged;',
    '    end_script',
    '    on_initialize2',
    `      if (PLATFORM.Name() == "${host}")`,
    '      {',
    '        WsfPlatform target;',
    ...aux,
    ...disabled,
    '      }',
    '    end_on_initialize2',
    ...(enabled.length ? [
      '    execute at_interval_of 3 sec',
      `      if (PLATFORM.Name() == "${host}")`,
      '      {',
      ...enabled.map(({ item, index }) => `        engaged${index} = LocalStubJammer("${item.platformId}", "${item.weaponId}", "${JAMMER_SCRIPT_MODE(item.type)}", ${n(item.jammingRangeM)}, ${n(item.releaseRangeM)}, engaged${index});`),
      '      }',
      '    end_execute',
    ] : []),
    '  end_processor',
  ].join('\n')
}
function typeTexts(config: ScenarioDraft['config'], relays: readonly string[], jammers: readonly Jammer[], start: string, calc: string): Record<string, string> {
  const common = (name: string, signature: string, mover: string, ports: string[], processor: string[]) => ['include_once comm_PerDefinition.txt', '', `platform_type ${name} WSF_PLATFORM`, `  radar_signature ${signature}`, `  mover ${mover}`, '    update_interval 1 sec', '  end_mover', ...ports, ...processor, 'end_platform_type', ''].join('\n')
  return {
    'comm_platform_MISSION_UAV.txt': common('MISSION_UAV_PLATFORM', 'DRONE_SIG', 'WSF_AIR_MOVER', ['sat_link', 'microwave_link', 'c_band_uplink', 'c_band_downlink', 'l_band_uplink', 'l_band_downlink'].flatMap(port => radio('MISSION_UAV_PLATFORM', port, config)), missionProcessor(relays)),
    'comm_platform_COMMAND_VEHICLE.txt': common('COMMAND_VEHICLE_PLATFORM', 'COMMAND_VEHICLE_SIG', 'WSF_SURFACE_MOVER', ['c_band_uplink', 'c_band_downlink', 'l_band_uplink', 'l_band_downlink'].flatMap(port => radio('COMMAND_VEHICLE_PLATFORM', port, config)).concat(fiber()), ['  processor script_proc WSF_SCRIPT_PROCESSOR', '    report_to commander via fiber_link', '    script_variables', '    end_script_variables', '    on_message', '    end_on_message', '  end_processor']),
    'comm_platform_REAR.txt': common('REAR_COMM_PLATFORM', 'COMMAND_VEHICLE_SIG', 'WSF_GROUND_MOVER', ['sat_link_a', 'sat_link_b', 'microwave_link'].flatMap(port => radio('REAR_COMM_PLATFORM', port, config)).concat(fiber()), rearProcessor().concat(calc ? calc.split('\n') : [])),
    'comm_platform_SAT.txt': ['include_once comm_PerDefinition.txt', '', ...satellite('TIAN_TONG_SAT', config, start), '', ...satellite('SHEN_TONG_SAT', config, start), ''].join('\n'),
    'comm_platform_JAMMER.txt': ['include_once comm_PerDefinition.txt', '', ...jammerType(false, jammers.find(item => item.weaponId === 'prophet_jammer')), ...jammerType(true, jammers.find(item => item.weaponId === 'alq99_jammer'))].join('\n'),
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
  const start = startTime(config.scenario.startTime); const directory = outputDirectory(config.output.directory); const mapped = devices(config); const jammers = jammerValues(config, draft.uiExtensions); const routes = routeInputs(config, mapped.items, laserOnlyTargets); const host = config.platforms.find(item => item.type === 'REAR_COMMAND_NODE')?.id; const calc = runtime?.linkCalc === 'STUB' ? (host ? localLinkStub(host, routes, jammers) : '') : calculator(config, routes, jammers); const relays = config.platforms.filter(item => item.type === 'FORWARD_RELAY_NODE').map(item => item.id); const types = typeTexts(config, relays, jammers, `${start.date} ${start.time}`, calc)
  const setup = [...TYPE_FILES.map(name => `include_once ${name}`), `include_once ${INSTANCE_FILE}`, 'include_once observers.txt', '', `start_date ${start.date}`, `start_time ${start.time}`, `end_time ${n(config.scenario.duration)} sec`, config.scenario.realtime === false ? 'non-realtime' : 'realtime', `clock_rate ${n(config.scenario.environment.simClockSpeed ?? 2)}`, 'multi_thread', '', 'simulation_name "MultiMethod_UAV_Comm_Scenario"', '', 'event_pipe', `   file ${directory}/scenario_events.aer`, 'end_event_pipe', '', 'csv_event_output', `  file ${directory}/scenario_events.csv`, ...EVENTS.map(name => `  enable ${name}`), 'end_csv_event_output', ''].join('\n')
  const scriptFiles = [SCENARIO_PREVIEW_FILE, ENTRY_FILE, DEFINITION_FILE, ...TYPE_FILES, INSTANCE_FILE, 'observers.txt', AD_HOC_COMM_FILE]
  const manifest = { scope: 'TEMPLATE_ALIGNED_PLATFORM_PORTS', engineValidated: false, scenarioId: config.scenario.id, revision: draft.revision, entry: ENTRY_FILE, scriptFiles, platformNaming: 'TEMPLATE_INSTANCE',
    platforms: inputConfig.platforms.map(item => ({ platformId: item.id, name: names.get(item.id)!, generatedType: platformType(item) })), devices: mapped.items, businesses: config.informationDemand.filter(item => item.enabled !== false), jammers, sensors: [], motion: config.platforms.filter(platform => platform.waypoints.length > 0).map(platform => ({
    platformId: platform.id,
    waypoints: platform.waypoints.map(waypoint => ({
      longitude: waypoint.longitude, latitude: waypoint.latitude, altitude: waypoint.altitude, speed: waypoint.speed,
      arrivalTimeS: waypoint.arrivalTime, headingDeg: waypoint.heading ?? null, accelerationMps2: waypoint.acceleration ?? null,
      // 模板 route 按位置与速度推进；这些配置仅供追溯，不强制引擎运动。
      arrivalTimeEnforced: false, headingEnforced: false,
    })),
  })), jammerPointing: draft.uiExtensions.jammers.map(extension => ({
    jammerId: extension.jammerId, directionDeg: extension.direction, elevationDeg: extension.elevation ?? 0,
    directionEngineMapped: false, elevationEngineMapped: false,
  })), linkCalc: { emitted: true, hostPlatformId: config.platforms.find(item => item.type === 'REAR_COMMAND_NODE')?.id ?? null, excludedOpticalLinkIds: config.links.filter(item => item.type === 'LASER').map(item => item.id), note: 'port_params 按模板平台类型共享。' }, output: { configuredDirectory: config.output.directory, resolvedDirectory: directory, eventsCsvPath: `${directory}/scenario_events.csv`, positionCsvPath: `${directory}/position.csv`, eventsEnabled: true, linkQualityEnabled: false, linkSwitchEnabled: false }, scenarioStartTime: { value: config.scenario.startTime, scriptDate: start.date, scriptTime: start.time, convention: 'AS_STORED_UTC', engineEmitted: true }, retainedButNotEmitted: ['航点航向/加速度/到达时间', '干扰方位角/俯仰角', '激光通信端口', '侦测传感器/ESM', '业务 QoS', '链路切换规则/优先级/质量门限', '调制/BER/编码/增益修正', '海峡宽度', '时间步长', ...laserOnlyWarnings.map(item => `${item.fieldPath}：${item.message}`)], warnings: [...mapped.warnings, ...laserOnlyWarnings.map(item => `${item.fieldPath}：${item.message}`)] }
  const files: Record<string, string> = { [SCENARIO_PREVIEW_FILE]: [`// ${SCENARIO_PREVIEW_FILE}：可追溯入口。`, `// 场景：${config.scenario.name.replace(/[\r\n]+/gu, ' ')}（${config.scenario.id}，修订 ${draft.revision}）`, `// 引用顺序：${ENTRY_FILE} → ${[...TYPE_FILES, INSTANCE_FILE, 'observers.txt'].join(' → ')}`, `include_once ${ENTRY_FILE}`, ''].join('\n'), [ENTRY_FILE]: setup, [DEFINITION_FILE]: definitions(config), ...types, [INSTANCE_FILE]: instances(config), 'observers.txt': observers(`${directory}/position.csv`), [AD_HOC_COMM_FILE]: AD_HOC_COMM_TEXT, 'mapping.json': JSON.stringify(manifest, null, 2) + '\n', 'input.json': JSON.stringify(draft, null, 2) + '\n', 'README.txt': ['新模板对齐脚本包。', '界面保留但不写入脚本：激光链路、侦测/ESM、QoS、切换规则、调制/BER/编码/增益修正、航点扩展和未映射环境字段。', ...mapped.warnings].join('\n') + '\n' }
  if (runtime) {
    const media = splitSharedMedium(files)
    const localRuntime = { linkCalc: runtime.linkCalc === 'STUB' ? 'MISSING_PROCESSOR_STUBBED' : 'PRESERVED', splitMedia: media, note: '本地运行包：每端口独立介质；缺少 link_calc 时以 local_link_stub 写入主路由 AuxData 并按触发/释放半径启停干扰。对接方 TXT 不含这些改动。' }
    files['mapping.json'] = JSON.stringify({ ...manifest, localRuntime }, null, 2) + '\n'
    files['README.txt'] += `本地运行兼容：${localRuntime.note}\n`
  }
  return { manifest, files }
}

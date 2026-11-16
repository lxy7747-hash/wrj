import type {
  CommDeviceType,
  CommPortDefinition,
  DeviceParameters,
  Link,
  Platform,
  PortParameters,
  ScenarioConfig,
  TemplateAntennaName,
  TemplatePlatformType,
} from '../../contracts/domain-models'
import { isConfiguredLinkEnabled, readLinkSettings } from './link-settings'

/** 新模板的五类通信平台，顺序同时是 port_params 的固定顺序。 */
export const TEMPLATE_PLATFORM_TYPES = [
  'MISSION_UAV_PLATFORM', 'COMMAND_VEHICLE_PLATFORM', 'REAR_COMM_PLATFORM', 'TIAN_TONG_SAT', 'SHEN_TONG_SAT',
] as const satisfies readonly TemplatePlatformType[]

/** 模板中每个平台类型实际声明的全部 comm 端口及设备类型/网络；顺序即模板端口顺序。 */
export const TEMPLATE_COMM_PORT_META: Record<TemplatePlatformType, Readonly<Record<string, Readonly<{ deviceType: CommDeviceType; network: string }>>>> = {
  MISSION_UAV_PLATFORM: {
    sat_link: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
    microwave_link: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
    c_band_uplink: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
    c_band_downlink: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
    l_band_uplink: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
    l_band_downlink: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
    lazer_link: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
  },
  COMMAND_VEHICLE_PLATFORM: {
    c_band_uplink: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
    c_band_downlink: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
    l_band_uplink: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
    l_band_downlink: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
    fiber_link: { deviceType: 'WSF_COMM_TRANSCEIVER', network: 'FIBER_NET' },
  },
  REAR_COMM_PLATFORM: {
    sat_link_a: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
    sat_link_b: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
    microwave_link: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' },
    fiber_link: { deviceType: 'WSF_COMM_TRANSCEIVER', network: 'FIBER_NET' },
  },
  TIAN_TONG_SAT: { sat_link: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' } },
  SHEN_TONG_SAT: { sat_link: { deviceType: 'WSF_RADIO_TRANSCEIVER', network: 'COM_MESH_NET' } },
}

/** 读取场景数据里的端口清单；未配置时返回 undefined（沿用模板全端口）。 */
export function readConfiguredCommPorts(
  config: Pick<ScenarioConfig, 'deviceParameters'>,
): Partial<Record<TemplatePlatformType, Partial<Record<string, CommPortDefinition>>>> | undefined {
  return config.deviceParameters?.commPorts
}

/** 返回模板全量端口清单（按模板定义顺序浅拷贝，供基准全量输出或显式初始化使用）。 */
export function allTemplateCommPorts(): Partial<Record<TemplatePlatformType, Partial<Record<string, CommPortDefinition>>>> {
  return Object.fromEntries(TEMPLATE_PLATFORM_TYPES.map(type => [
    type,
    Object.fromEntries(Object.entries(TEMPLATE_COMM_PORT_META[type]).map(([portName, meta]) => [
      portName,
      { deviceType: meta.deviceType, network: meta.network },
    ])),
  ])) as Partial<Record<TemplatePlatformType, Partial<Record<string, CommPortDefinition>>>>
}

/** 返回单条链路在模板平台类型上实际占用的端口（含中继平台与 LASER 端口，按链路去重）。 */
export function resolveLinkRequiredCommPorts(
  platforms: readonly Platform[],
  link: Link,
): Array<{ platformType: TemplatePlatformType; portName: string }> {
  const seen = new Set<string>()
  const result: Array<{ platformType: TemplatePlatformType; portName: string }> = []
  const add = (platformType: TemplatePlatformType | undefined, portName: string) => {
    if (platformType === undefined) return
    if (!Object.hasOwn(TEMPLATE_COMM_PORT_META[platformType], portName)) return
    const key = `${platformType}.${portName}`
    if (seen.has(key)) return
    seen.add(key)
    result.push({ platformType, portName })
  }
  if (link.type === 'LASER') {
    for (const platformId of [link.sourcePlatformId, link.targetPlatformId, link.relayPlatformId]) {
      if (!platformId) continue
      const platform = platforms.find(item => item.id === platformId)
      if (platform && templatePlatformType(platform) === 'MISSION_UAV_PLATFORM') {
        add('MISSION_UAV_PLATFORM', 'lazer_link')
      }
    }
    return result
  }
  const resolution = resolveTemplateLinkPorts({ platforms: platforms as Platform[] }, link)
  if (resolution.status !== 'MAPPED') return result
  add(resolution.source.platformType, resolution.source.portName)
  add(resolution.target.platformType, resolution.target.portName)
  if (link.relayPlatformId) {
    const relay = platforms.find(item => item.id === link.relayPlatformId)
    const relayType = relay ? templatePlatformType(relay) : undefined
    if (relayType === 'TIAN_TONG_SAT' || relayType === 'SHEN_TONG_SAT') {
      add(relayType, 'sat_link')
    } else if (relayType !== undefined) {
      add(relayType, resolution.source.portName)
    }
  }
  return result
}

/** 根据已启用链路与平台映射自动推导各模板平台类型所需生成的 comm 端口。 */
export function deriveCommPortsFromLinks(
  config: Pick<ScenarioConfig, 'platforms' | 'links' | 'linkSettings'>,
): Partial<Record<TemplatePlatformType, Partial<Record<string, CommPortDefinition>>>> {
  const needed = new Map<TemplatePlatformType, Set<string>>()
  const ensureType = (type: TemplatePlatformType | undefined): Set<string> | undefined => {
    if (type === undefined) return undefined
    let ports = needed.get(type)
    if (ports === undefined) {
      ports = new Set<string>()
      needed.set(type, ports)
    }
    return ports
  }
  for (const platform of config.platforms) ensureType(templatePlatformType(platform))

  const settings = readLinkSettings(config)
  for (const link of config.links) {
    if (!isConfiguredLinkEnabled(link, settings, config.platforms)) continue
    for (const { platformType, portName } of resolveLinkRequiredCommPorts(config.platforms, link)) {
      ensureType(platformType)!.add(portName)
    }
  }

  const result: Partial<Record<TemplatePlatformType, Partial<Record<string, CommPortDefinition>>>> = {}
  for (const type of TEMPLATE_PLATFORM_TYPES) {
    const ports = needed.get(type)
    if (ports === undefined) continue
    result[type] = Object.fromEntries(
      Object.entries(TEMPLATE_COMM_PORT_META[type])
        .filter(([portName]) => ports.has(portName))
        .map(([portName, meta]) => [portName, { deviceType: meta.deviceType, network: meta.network }]),
    )
  }
  return result
}

export const TEMPLATE_ANTENNA_NAMES = [
  'OMNI_ANTENNA', 'MICRO_UAV_OMNI_ANTENNA', 'MICRO_REAR_PLATFORM_DIR_ANTENNA', 'OMNI_ANTENNA_HIGHGAIN',
  'C_BAND_DIRECTIONAL_VEHICLE_ANTENNA', 'C_BAND_DIRECTIONAL_UAV_ANTENNA',
  'L_BAND_DIRECTIONAL_VEHICLE_ANTENNA', 'L_BAND_DIRECTIONAL_UAV_ANTENNA',
  'SAT_GROUND_MOBILE_ANTENNA', 'SAT_SPACE_BEAM_ANTENNA', 'SAT_UAV_CLUSTER_WIDEBAND_ANTENNA', 'LASER_COMM_ANTENNA',
] as const satisfies readonly TemplateAntennaName[]

/** 端口来源只能记录这些原有 LinkParameterSource 字段。 */
export const TEMPLATE_PORT_PARAMETER_SOURCE_FIELDS = [
  'frequency', 'bandwidth', 'txPower', 'rxFrequency', 'rxBandwidth', 'dataRate', 'noiseFigureDb',
] as const

type CompleteDeviceParameters = Required<Pick<DeviceParameters, 'ports' | 'antennaGains'>>
type DefaultPorts = Record<TemplatePlatformType, Record<string, PortParameters>>
const port = (txFrequency: number, txBandwidth: number, txPower: number, rxFrequency: number, rxBandwidth: number, transferRate: number, eirpDbw?: number, gtDbk?: number): PortParameters => (
  { txFrequency, txBandwidth, txPower, rxFrequency, rxBandwidth, transferRate, noiseFigureDb: 3, ...(eirpDbw === undefined ? {} : { eirpDbw, gtDbk }) }
)

/** 新模板中的设备定义；速率单位在生成器按端口分别输出，领域值统一为 Mbps。 */
const DEFAULT_PORTS: DefaultPorts = {
  MISSION_UAV_PLATFORM: {
    sat_link: port(14200, 20, 20, 11800, 20, 16, 5, -14),
    microwave_link: port(8200, 20, 20, 8200, 20, 80, 30, -3),
    c_band_uplink: port(4500, 10, 20, 4500, 10, 2, 26, -6),
    c_band_downlink: port(4000, 20, 30, 4000, 20, 8, 26, -6),
    l_band_uplink: port(1500, 5, 10, 1500, 5, 0.0128, 26, -6),
    l_band_downlink: port(1300, 10, 15, 1300, 10, 4, 26, -6),
  },
  COMMAND_VEHICLE_PLATFORM: {
    c_band_uplink: port(4500, 10, 20, 4500, 10, 2, 26, -6),
    c_band_downlink: port(4000, 20, 30, 4000, 20, 8, 26, -6),
    l_band_uplink: port(1500, 5, 10, 1500, 5, 0.0128, 26, -6),
    l_band_downlink: port(1300, 10, 15, 1300, 10, 2, 26, -6),
    fiber_link: port(0.001, 0.001, 0.001, 0.001, 0.001, 1000),
  },
  REAR_COMM_PLATFORM: {
    sat_link_a: port(14200, 54, 20, 11800, 54, 16, 5, -14),
    sat_link_b: port(14200, 54, 20, 11800, 54, 16, 5, -14),
    microwave_link: port(8200, 50, 20, 8200, 50, 80, 30, -3),
    fiber_link: port(0.001, 0.001, 0.001, 0.001, 0.001, 1000),
  },
  TIAN_TONG_SAT: { sat_link: port(11800, 54, 40, 14200, 54, 0.016, 5, -14) },
  SHEN_TONG_SAT: { sat_link: port(11800, 54, 40, 14200, 54, 16, 5, -14) },
}

const DEFAULT_ANTENNA_GAINS: Record<TemplateAntennaName, number> = {
  OMNI_ANTENNA: 30,
  MICRO_UAV_OMNI_ANTENNA: 3,
  MICRO_REAR_PLATFORM_DIR_ANTENNA: 18,
  OMNI_ANTENNA_HIGHGAIN: 25,
  C_BAND_DIRECTIONAL_VEHICLE_ANTENNA: 25,
  C_BAND_DIRECTIONAL_UAV_ANTENNA: 25,
  L_BAND_DIRECTIONAL_VEHICLE_ANTENNA: 25,
  L_BAND_DIRECTIONAL_UAV_ANTENNA: 25,
  SAT_GROUND_MOBILE_ANTENNA: 25,
  SAT_SPACE_BEAM_ANTENNA: 30,
  SAT_UAV_CLUSTER_WIDEBAND_ANTENNA: 30,
  LASER_COMM_ANTENNA: 40,
}

function clonePort(value: PortParameters): PortParameters {
  const { parameterSource, ...parameters } = value
  return parameterSource === undefined ? { ...parameters } : { ...parameters, parameterSource: { ...parameterSource, fields: [...parameterSource.fields] } }
}

function clonePorts(ports: DefaultPorts): DefaultPorts {
  return Object.fromEntries(TEMPLATE_PLATFORM_TYPES.map(type => [
    type,
    Object.fromEntries(Object.entries(ports[type]).map(([name, value]) => [name, clonePort(value)])),
  ])) as DefaultPorts
}

/** 将节点映射为新模板固定平台类型；没有模板通信定义的实体返回 undefined。 */
export function templatePlatformType(platform: Pick<Platform, 'type' | 'satelliteType'>): TemplatePlatformType | undefined {
  if (platform.type === 'AIRBORNE_MISSION_CLUSTER' || platform.type === 'FORWARD_RELAY_NODE') return 'MISSION_UAV_PLATFORM'
  if (platform.type === 'GROUND_CLUSTER_COMMAND_NODE') return 'COMMAND_VEHICLE_PLATFORM'
  if (platform.type === 'REAR_COMMAND_NODE') return 'REAR_COMM_PLATFORM'
  if (platform.type === 'COMMUNICATION_SATELLITE') return platform.satelliteType === 'TIANTONG' ? 'TIAN_TONG_SAT' : platform.satelliteType === 'SHENTONG' ? 'SHEN_TONG_SAT' : undefined
  return undefined
}

/**
 * 读取模板通信设备参数。旧场景未存 deviceParameters 时只在返回副本中补齐默认值，
 * 不修改传入配置、更不在读/存储层注入字段。
 */
export function readDeviceParameters(config: Pick<ScenarioConfig, 'deviceParameters'>): CompleteDeviceParameters {
  const ports = clonePorts(DEFAULT_PORTS)
  const customPorts = config.deviceParameters?.ports
  for (const platformType of TEMPLATE_PLATFORM_TYPES) {
    for (const [name, value] of Object.entries(customPorts?.[platformType] ?? {})) {
      if (value) ports[platformType][name] = { ...ports[platformType][name], ...clonePort(value) }
    }
  }
  return { ports, antennaGains: { ...DEFAULT_ANTENNA_GAINS, ...config.deviceParameters?.antennaGains } }
}

/** 读取一个端口的默认补齐副本；未知端口返回 undefined。 */
export function readPortParameters(config: Pick<ScenarioConfig, 'deviceParameters'>, platformType: TemplatePlatformType, portName: string): PortParameters | undefined {
  const value = readDeviceParameters(config).ports[platformType]?.[portName]
  return value ? clonePort(value) : undefined
}

export interface TemplateLinkPort { platformType: TemplatePlatformType; portName: string }
export type TemplateLinkPortResolution =
  | { status: 'MAPPED'; source: TemplateLinkPort; target: TemplateLinkPort }
  | { status: 'WARNING'; message: string }
  | { status: 'ERROR'; message: string }

function endpoints(config: Pick<ScenarioConfig, 'platforms'>, link: Pick<Link, 'sourcePlatformId' | 'targetPlatformId'>): [Platform | undefined, Platform | undefined] {
  return [config.platforms.find(item => item.id === link.sourcePlatformId), config.platforms.find(item => item.id === link.targetPlatformId)]
}

/** 按新模板固定端口命名解析一条链路；激光链路不建立链路端口映射，故明确返回警告。 */
export function resolveTemplateLinkPorts(config: Pick<ScenarioConfig, 'platforms'>, link: Pick<Link, 'type' | 'band' | 'direction' | 'sourcePlatformId' | 'targetPlatformId'>): TemplateLinkPortResolution {
  if (link.type === 'LASER') return { status: 'WARNING', message: '激光链路不建立通信端口映射；涉及任务/中继无人机时保留模板 lazer_link 端口定义。' }
  const [sourcePlatform, targetPlatform] = endpoints(config, link)
  const sourceType = sourcePlatform && templatePlatformType(sourcePlatform)
  const targetType = targetPlatform && templatePlatformType(targetPlatform)
  if (!sourceType || !targetType) return { status: 'ERROR', message: '链路端点没有可映射的新模板通信平台类型。' }
  const pair = (sourcePort: string, targetPort: string): TemplateLinkPortResolution => ({
    status: 'MAPPED', source: { platformType: sourceType, portName: sourcePort }, target: { platformType: targetType, portName: targetPort },
  })
  if (link.type === 'FIBER') {
    return sourceType === 'COMMAND_VEHICLE_PLATFORM' && targetType === 'REAR_COMM_PLATFORM'
      ? pair('fiber_link', 'fiber_link') : sourceType === 'REAR_COMM_PLATFORM' && targetType === 'COMMAND_VEHICLE_PLATFORM'
        ? pair('fiber_link', 'fiber_link') : { status: 'ERROR', message: '光纤链路仅支持地面无人集群指挥车与后方指挥节点之间。' }
  }
  if (link.type === 'MICROWAVE') {
    return sourceType === 'MISSION_UAV_PLATFORM' && targetType === 'REAR_COMM_PLATFORM'
      ? pair('microwave_link', 'microwave_link') : sourceType === 'REAR_COMM_PLATFORM' && targetType === 'MISSION_UAV_PLATFORM'
        ? pair('microwave_link', 'microwave_link') : { status: 'ERROR', message: '微波链路仅支持任务/中继无人机与后方指挥节点之间。' }
  }
  if (link.type === 'DATALINK') {
    const sourceIsUav = sourceType === 'MISSION_UAV_PLATFORM'
    const targetIsUav = targetType === 'MISSION_UAV_PLATFORM'
    const sourceIsCommand = sourceType === 'COMMAND_VEHICLE_PLATFORM'
    const targetIsCommand = targetType === 'COMMAND_VEHICLE_PLATFORM'
    if (!((sourceIsUav && targetIsCommand) || (sourceIsCommand && targetIsUav))) return { status: 'ERROR', message: '数传链路仅支持任务/中继无人机与地面无人集群指挥车之间。' }
    const band = link.band ?? 'C'
    const forward = link.direction !== 'REVERSE'
    const portName = `${band.toLowerCase()}_band_${forward ? 'uplink' : 'downlink'}`
    return pair(portName, portName)
  }
  if (link.type === 'SAT') {
    const sourcePort = sourceType === 'REAR_COMM_PLATFORM' ? (link.direction === 'REVERSE' ? 'sat_link_b' : 'sat_link_a') : 'sat_link'
    const targetPort = targetType === 'REAR_COMM_PLATFORM' ? (link.direction === 'REVERSE' ? 'sat_link_b' : 'sat_link_a') : 'sat_link'
    const supportsSatellitePath = [sourceType, targetType].includes('REAR_COMM_PLATFORM') && [sourceType, targetType].some(type => type === 'MISSION_UAV_PLATFORM' || type === 'TIAN_TONG_SAT' || type === 'SHEN_TONG_SAT')
    return supportsSatellitePath ? pair(sourcePort, targetPort) : { status: 'ERROR', message: '卫星链路需连接后方指挥节点与任务/中继无人机或通信卫星。' }
  }
  return { status: 'ERROR', message: '链路类型没有新模板端口映射。' }
}


/** 1112 comm_platform_REAR.txt 的 port_params 原样（每平台段各自值与键序，保留 comm 与 port_params 的内部差异；不替后端统一修正）。 */
export type TemplatePortParamsEntry = { platform_type: TemplatePlatformType; comm_params: Array<{ comm_name: string; transmitter: Record<string, number>; receiver: Record<string, number> }> }
export const TEMPLATE_PORT_PARAMS = JSON.parse(String.raw`[{"platform_type":"MISSION_UAV_PLATFORM","comm_params":[{"comm_name":"sat_link","transmitter":{"frequency_ghz":30,"bandwidth_mhz":20,"power_w":50,"eirp_dBW":5,"peak_gain_dB":30,"information_rate_mbits/sec":2},"receiver":{"frequency_ghz":20,"bandwidth_mhz":20,"peak_gain_dB":30,"G_T_dBK":-14,"information_rate_mbits/sec":2,"noise_figure_dB":3}},{"comm_name":"microwave_link","transmitter":{"frequency_ghz":8.2,"bandwidth_mhz":50,"power_w":20,"peak_gain_dB":3,"eirp_dBW":30,"information_rate_mbits/sec":80},"receiver":{"frequency_ghz":8.2,"bandwidth_mhz":50,"peak_gain_dB":3,"G_T_dBK":-3,"information_rate_mbits/sec":80,"noise_figure_dB":3}},{"comm_name":"c_band_uplink","transmitter":{"frequency_ghz":2.3,"bandwidth_mhz":10,"power_w":20,"eirp_dBW":26,"peak_gain_dB":5,"information_rate_bit/s":2000000},"receiver":{"frequency_ghz":2.3,"bandwidth_mhz":10,"peak_gain_dB":5,"G_T_dBK":-6,"information_rate_bit/s":2000000,"noise_figure_dB":3}},{"comm_name":"c_band_downlink","transmitter":{"frequency_ghz":2.3,"bandwidth_mhz":20,"eirp_dBW":26,"power_w":30,"peak_gain_dB":5,"information_rate_bit/s":8000000},"receiver":{"frequency_ghz":2.3,"bandwidth_mhz":20,"peak_gain_dB":5,"G_T_dBK":-6,"information_rate_bit/s":8000000,"noise_figure_dB":3}},{"comm_name":"l_band_uplink","transmitter":{"frequency_ghz":2.3,"bandwidth_mhz":5,"power_w":10,"eirp_dBW":26,"peak_gain_dB":4,"information_rate_bit/s":12800},"receiver":{"frequency_ghz":2.3,"bandwidth_mhz":5,"peak_gain_dB":4,"G_T_dBK":-6,"information_rate_bit/s":12800,"noise_figure_dB":3}},{"comm_name":"l_band_downlink","transmitter":{"frequency_ghz":2.3,"bandwidth_mhz":10,"power_w":15,"eirp_dBW":26,"peak_gain_dB":4,"information_rate_bit/s":4000000},"receiver":{"frequency_ghz":2.3,"bandwidth_mhz":10,"peak_gain_dB":4,"G_T_dBK":-6,"information_rate_bit/s":4000000,"noise_figure_dB":3}},{"comm_name":"lazer_link","transmitter":{"frequency_ghz":681300,"bandwidth_mhz":1000,"power_w":0.1,"eirp_dBW":20,"peak_gain_dB":45,"information_rate_bit/s":2500000000},"receiver":{"frequency_ghz":681300,"bandwidth_mhz":1000,"peak_gain_dB":45,"G_T_dBK":15,"information_rate_bit/s":2500000000,"noise_figure_dB":5}}]},{"platform_type":"COMMAND_VEHICLE_PLATFORM","comm_params":[{"comm_name":"c_band_uplink","transmitter":{"frequency_ghz":2.3,"bandwidth_mhz":10,"power_w":20,"eirp_dBW":26,"peak_gain_dB":5,"information_rate_bit/s":2000000},"receiver":{"frequency_ghz":2.3,"bandwidth_mhz":10,"peak_gain_dB":5,"G_T_dBK":-6,"information_rate_bit/s":2000000,"noise_figure_dB":3}},{"comm_name":"c_band_downlink","transmitter":{"frequency_ghz":2.3,"bandwidth_mhz":20,"eirp_dBW":26,"power_w":30,"peak_gain_dB":5,"information_rate_bit/s":8000000},"receiver":{"frequency_ghz":2.3,"bandwidth_mhz":20,"peak_gain_dB":5,"G_T_dBK":-6,"information_rate_bit/s":8000000,"noise_figure_dB":3}},{"comm_name":"l_band_uplink","transmitter":{"frequency_ghz":2.3,"bandwidth_mhz":5,"power_w":10,"eirp_dBW":26,"peak_gain_dB":4,"information_rate_bit/s":12800},"receiver":{"frequency_ghz":2.3,"bandwidth_mhz":5,"peak_gain_dB":4,"G_T_dBK":-6,"information_rate_bit/s":12800,"noise_figure_dB":3}},{"comm_name":"l_band_downlink","transmitter":{"frequency_ghz":2.3,"bandwidth_mhz":10,"power_w":15,"eirp_dBW":26,"peak_gain_dB":4,"information_rate_bit/s":4000000},"receiver":{"frequency_ghz":2.3,"bandwidth_mhz":10,"peak_gain_dB":4,"G_T_dBK":-6,"information_rate_bit/s":4000000,"noise_figure_dB":3}},{"comm_name":"fiber_link","transmitter":{"information_rate_bit/s":1000000000},"receiver":{"information_rate_bit/s":1000000000}}]},{"platform_type":"REAR_COMM_PLATFORM","comm_params":[{"comm_name":"sat_link_a","transmitter":{"frequency_ghz":30,"bandwidth_mhz":54,"power_w":100,"eirp_dBW":5,"peak_gain_dB":25,"information_rate_mbits/sec":2},"receiver":{"frequency_ghz":20,"bandwidth_mhz":54,"peak_gain_dB":25,"G_T_dBK":-14,"information_rate_mbits/sec":2,"noise_figure_dB":3}},{"comm_name":"sat_link_b","transmitter":{"frequency_ghz":30,"bandwidth_mhz":54,"power_w":100,"eirp_dBW":5,"peak_gain_dB":25,"information_rate_mbits/sec":2},"receiver":{"frequency_ghz":20,"bandwidth_mhz":54,"peak_gain_dB":25,"G_T_dBK":-14,"information_rate_mbits/sec":2,"noise_figure_dB":3}},{"comm_name":"microwave_link","transmitter":{"frequency_ghz":8.2,"bandwidth_mhz":50,"power_w":20,"eirp_dBW":30,"peak_gain_dB":18,"information_rate_mbits/sec":80},"receiver":{"frequency_ghz":8.2,"bandwidth_mhz":50,"peak_gain_dB":18,"G_T_dBK":-3,"information_rate_mbits/sec":80,"noise_figure_dB":3}},{"comm_name":"fiber_link","transmitter":{"information_rate_bit/s":1000000000},"receiver":{"information_rate_bit/s":1000000000}}]},{"platform_type":"TIAN_TONG_SAT","comm_params":[{"comm_name":"sat_link","transmitter":{"frequency_ghz":20,"bandwidth_mhz":54,"power_w":40,"eirp_dBW":5,"peak_gain_dB":30,"information_rate_kbits/sec":16},"receiver":{"frequency_ghz":30,"bandwidth_mhz":54,"peak_gain_dB":30,"G_T_dBK":-14,"information_rate_kbits/sec":16,"noise_figure_dB":2}}]},{"platform_type":"SHEN_TONG_SAT","comm_params":[{"comm_name":"sat_link","transmitter":{"frequency_ghz":20,"bandwidth_mhz":54,"power_w":40,"eirp_dBW":5,"peak_gain_dB":30,"information_rate_mbits/sec":2},"receiver":{"frequency_ghz":30,"bandwidth_mhz":54,"peak_gain_dB":30,"G_T_dBK":-14,"information_rate_mbits/sec":2,"noise_figure_dB":3}}]}]`) as TemplatePortParamsEntry[]

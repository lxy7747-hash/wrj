import type {
  DeviceParameters,
  Link,
  Platform,
  PortParameters,
  ScenarioConfig,
  TemplateAntennaName,
  TemplatePlatformType,
} from '../../contracts/domain-models'

/** 新模板的五类通信平台，顺序同时是 port_params 的固定顺序。 */
export const TEMPLATE_PLATFORM_TYPES = [
  'MISSION_UAV_PLATFORM', 'COMMAND_VEHICLE_PLATFORM', 'REAR_COMM_PLATFORM', 'TIAN_TONG_SAT', 'SHEN_TONG_SAT',
] as const satisfies readonly TemplatePlatformType[]

export const TEMPLATE_ANTENNA_NAMES = [
  'MICRO_UAV_OMNI_ANTENNA', 'MICRO_REAR_PLATFORM_DIR_ANTENNA', 'OMNI_ANTENNA_HIGHGAIN',
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
const port = (txFrequency: number, txBandwidth: number, txPower: number, rxFrequency: number, rxBandwidth: number, transferRate: number): PortParameters => (
  { txFrequency, txBandwidth, txPower, rxFrequency, rxBandwidth, transferRate, noiseFigureDb: 3 }
)

/** 新模板中的设备定义；速率单位在生成器按端口分别输出，领域值统一为 Mbps。 */
const DEFAULT_PORTS: DefaultPorts = {
  MISSION_UAV_PLATFORM: {
    sat_link: port(14200, 20, 20, 11800, 20, 16),
    microwave_link: port(8200, 50, 20, 8200, 50, 80),
    c_band_uplink: port(4500, 10, 20, 4500, 10, 2),
    c_band_downlink: port(4000, 20, 30, 4000, 20, 8),
    l_band_uplink: port(1500, 5, 10, 1500, 5, 0.0128),
    l_band_downlink: port(1300, 10, 15, 1300, 10, 4),
  },
  COMMAND_VEHICLE_PLATFORM: {
    c_band_uplink: port(4500, 10, 20, 4500, 10, 2),
    c_band_downlink: port(4000, 20, 30, 4000, 20, 8),
    l_band_uplink: port(1500, 5, 10, 1500, 5, 0.0128),
    l_band_downlink: port(1300, 10, 15, 1300, 10, 2),
    fiber_link: port(0.001, 0.001, 0.001, 0.001, 0.001, 1000),
  },
  REAR_COMM_PLATFORM: {
    sat_link_a: port(14200, 54, 20, 11800, 54, 16),
    sat_link_b: port(14200, 54, 20, 11800, 54, 16),
    microwave_link: port(8200, 50, 20, 8200, 50, 80),
    fiber_link: port(0.001, 0.001, 0.001, 0.001, 0.001, 1000),
  },
  TIAN_TONG_SAT: { sat_link: port(11800, 54, 40, 14200, 54, 0.016) },
  SHEN_TONG_SAT: { sat_link: port(11800, 54, 40, 14200, 54, 16) },
}

const DEFAULT_ANTENNA_GAINS: Record<TemplateAntennaName, number> = {
  MICRO_UAV_OMNI_ANTENNA: 3,
  MICRO_REAR_PLATFORM_DIR_ANTENNA: 18,
  OMNI_ANTENNA_HIGHGAIN: 8,
  C_BAND_DIRECTIONAL_VEHICLE_ANTENNA: 25,
  C_BAND_DIRECTIONAL_UAV_ANTENNA: 25,
  L_BAND_DIRECTIONAL_VEHICLE_ANTENNA: 14,
  L_BAND_DIRECTIONAL_UAV_ANTENNA: 4,
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

/** 将场景实体映射为新模板固定平台类型；没有模板通信定义的实体返回 undefined。 */
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

/** 按新模板固定端口命名解析一条链路；激光仅保留天线图，故明确返回警告。 */
export function resolveTemplateLinkPorts(config: Pick<ScenarioConfig, 'platforms'>, link: Pick<Link, 'type' | 'band' | 'direction' | 'sourcePlatformId' | 'targetPlatformId'>): TemplateLinkPortResolution {
  if (link.type === 'LASER') return { status: 'WARNING', message: '激光链路仅保留天线图，当前新模板不写入通信端口。' }
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


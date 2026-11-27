import type { Platform, ScenarioConfig, ValidationIssue } from '../../contracts/domain-models'
import { resolveLinkPortFieldTarget } from './link-port-parameters'
import { scenarioPlatformLabel } from './scenario-basic'
import { LINK_TYPE_LABELS } from '../situation/situation-model'

type ValidationLabelConfig = Pick<ScenarioConfig, 'platforms' | 'links' | 'jammers' | 'sensors'> & Partial<Pick<ScenarioConfig, 'deviceParameters'>>

export interface SpectrumConflictLinkSummary {
  index: number
  id: string
  type: unknown
  bandName?: string
  direction?: string
  source: string
  relay?: string
  target: string
}

const LEAF_FIELD_LABELS: Record<string, string> = {
  id: '编号',
  name: '名称',
  description: '说明',
  type: '类型',
  category: '平台分类',
  enabled: '启用状态',
  startTime: '开始时间',
  duration: '仿真总时长',
  timeStep: '时间步长',
  sourcePlatformId: '源节点',
  relayPlatformId: '中继节点',
  targetPlatformId: '目标节点',
  direction: '传输方向',
  bandName: '频段标识',
  frequency: '发射频率',
  bandwidth: '发射带宽',
  txFrequency: '发射频率',
  txBandwidth: '发射带宽',
  txPower: '发射功率',
  eirpDbw: 'EIRP',
  rxFrequency: '接收频率',
  rxBandwidth: '接收带宽',
  noiseFigureDb: '噪声系数',
  gtDbk: 'G/T',
  transferRate: '数据速率',
  dataRate: '数据速率',
  txPolarization: '发射极化',
  rxPolarization: '接收极化',
  modulation: '调制方式',
  berThreshold: '误码率阈值',
  parameterSource: '参数来源',
  jammingRangeKm: '干扰有效距离',
  valueThresholdBer: '质量阈值',
  warningThreshold: '告警阈值',
  emergencyThreshold: '紧急阈值',
  channelEncodingScheme: '信道编码方式',
  switchCooldownS: '切换冷却时间',
  priority: '业务优先级',
  peak_gain_dB: '天线峰值增益',
  latitude: '纬度',
  longitude: '经度',
  altitude: '高度',
  timestamp: '时间点',
  centerFrequency: '中心频率',
  power: '发射功率',
  dutyCycle: '占空比',
  targetLinkTypes: '目标链路类型',
  rangeMeters: '作用距离',
  beamwidthDeg: '波束宽度',
  jammingBandwidth: '干扰带宽',
  weaponBands: '干扰频段',
  mode: '干扰方式',
  spotBandwidthMHz: '瞄准带宽',
  sweepDutyCycle: '扫频占空比',
  platformId: '所属平台',
  seaState: '海况等级',
  rainRateMmPerHour: '降雨强度',
  multipathEnabled: '多径效应开关',
  rainEnabled: '降雨衰减开关',
  rainAltitudeLimitM: '雨区顶部高度',
  rainAttenuationDb: '固定雨衰兜底值',
  cloudEnabled: '云层衰减开关',
  cloudAltitudeMinM: '云底高度',
  cloudAltitudeMaxM: '云顶高度',
  cloudWaterDensityGM3: '云液态水密度',
  atmosphereModel: '大气衰减模型',
  simplifiedAttenuationDbPerKm: '简化大气衰减率',
  polarizationMismatchDb: '极化失配损耗',
  pointingErrorDb: '指向误差损耗',
  seaModel: '海面模型',
  seaPolarization: '海面极化',
  seaWaterTempC: '海水温度',
  seaSurfaceRoughnessM: '海面高度标准差',
  seaLowAltitudeThresholdM: '贴海飞行高度阈值',
  seaPathOverSeaThresholdKm: '跨海距离阈值',
  seaPolygon: '海面多边形区域',
  simClockSpeed: '仿真倍速',
  rainCloudAttenuation: '天气等级',
}

const TEMPLATE_PLATFORM_LABELS: Record<string, string> = {
  MISSION_UAV_PLATFORM: '任务无人机（含中继）',
  COMMAND_VEHICLE_PLATFORM: '集群指挥车',
  REAR_COMM_PLATFORM: '后方通信车',
  TIAN_TONG_SAT: '天通卫星',
  SHEN_TONG_SAT: '神通卫星',
}

const TEMPLATE_PORT_LABELS: Record<string, string> = {
  sat_link: '卫通',
  sat_link_a: '卫通 A（前向）',
  sat_link_b: '卫通 B（返向）',
  microwave_link: '微波',
  c_band_uplink: 'C 波段上行',
  c_band_downlink: 'C 波段下行',
  l_band_uplink: 'L 波段上行',
  l_band_downlink: 'L 波段下行',
  fiber_link: '光纤',
  lazer_link: '激光',
}

const TEMPLATE_ANTENNA_LABELS: Record<string, string> = {
  OMNI_ANTENNA: '通用全向天线',
  MICRO_UAV_OMNI_ANTENNA: '任务无人机微波宽波束天线',
  MICRO_REAR_PLATFORM_DIR_ANTENNA: '后方通信车微波定向天线',
  OMNI_ANTENNA_HIGHGAIN: '干扰设备高增益全向天线',
  C_BAND_DIRECTIONAL_VEHICLE_ANTENNA: '集群指挥车 C 波段定向天线',
  C_BAND_DIRECTIONAL_UAV_ANTENNA: '任务无人机 C 波段天线',
  L_BAND_DIRECTIONAL_VEHICLE_ANTENNA: '集群指挥车 L 波段定向天线',
  L_BAND_DIRECTIONAL_UAV_ANTENNA: '任务无人机 L 波段全向天线',
  SAT_GROUND_MOBILE_ANTENNA: '后方通信车卫通动中通天线',
  SAT_SPACE_BEAM_ANTENNA: '卫星星载点波束天线',
  SAT_UAV_CLUSTER_WIDEBAND_ANTENNA: '任务无人机卫通宽波束天线',
  LASER_COMM_ANTENNA: '任务无人机激光通信天线',
}

function translateLeaf(key: string): string {
  const bracketIndex = key.indexOf('[')
  if (bracketIndex > 0 && key.endsWith(']')) {
    const base = key.slice(0, bracketIndex)
    const index = Number(key.slice(bracketIndex + 1, -1))
    const baseLabel = LEAF_FIELD_LABELS[base] ?? base
    return Number.isInteger(index) ? `${baseLabel}第 ${index + 1} 项` : baseLabel
  }
  return LEAF_FIELD_LABELS[key] ?? key
}

function formatLinkPrefix(index: number, config?: ValidationLabelConfig): string {
  const link = config?.links?.[index]
  const base = `第 ${index + 1} 条链路`
  if (!link) return base
  const platforms = config?.platforms ?? []
  const route = [link.sourcePlatformId, ...(link.relayPlatformId ? [link.relayPlatformId] : []), link.targetPlatformId]
    .filter(Boolean)
    .map(id => scenarioPlatformLabel(platforms, id))
    .join(' → ')
  const typeLabel = LINK_TYPE_LABELS[link.type]
  const summary = route || typeLabel
  return summary ? `${base}（${summary}）` : base
}

function formatPlatformPrefix(index: number, config?: ValidationLabelConfig): string {
  const platform = config?.platforms?.[index]
  const base = `第 ${index + 1} 个平台`
  return platform?.name ? `${base}（${platform.name}）` : base
}

function formatJammerPrefix(index: number, config?: ValidationLabelConfig): string {
  const jammer = config?.jammers?.[index]
  const base = `第 ${index + 1} 个干扰设备`
  if (!jammer) return base
  const platformName = jammer.platformId && config?.platforms
    ? scenarioPlatformLabel(config.platforms, jammer.platformId)
    : ''
  const label = [jammer.id, platformName && platformName !== jammer.platformId ? platformName : ''].filter(Boolean).join(' · ')
  return label ? `${base}（${label}）` : base
}

function formatSensorPrefix(index: number, config?: ValidationLabelConfig): string {
  const sensor = config?.sensors?.[index]
  const base = `第 ${index + 1} 个传感载荷`
  return sensor?.id ? `${base}（${sensor.id}）` : base
}

function formatTailSegments(segments: readonly string[]): string {
  if (segments.length === 0) return ''
  if (segments[0] === 'initialPosition') {
    const rest = segments.slice(1).map(translateLeaf).join(' · ')
    return rest ? `初始位置 · ${rest}` : '初始位置'
  }
  const waypointMatch = /^waypoints\[(\d+)\]$/.exec(segments[0] ?? '')
  if (waypointMatch) {
    const wpLabel = `第 ${Number(waypointMatch[1]) + 1} 个航点`
    const rest = segments.slice(1).map(translateLeaf).join(' · ')
    return rest ? `${wpLabel} · ${rest}` : wpLabel
  }
  if (segments[0] === 'waypoints') return '航点列表'
  if (segments[0] === 'environment') {
    const rest = segments.slice(1).map(translateLeaf).join(' · ')
    return rest ? `仿真环境 · ${rest}` : '仿真环境'
  }
  return segments.map(translateLeaf).join(' · ')
}

/**
 * 将校验问题里的英文 schema 字段路径转换为通俗中文定位标签，
 * 同时可结合当前场景配置展示第几条链路及源→目标平台中文名称。
 */
export function formatValidationFieldLabel(fieldPath: string, config?: ValidationLabelConfig): string {
  if (!fieldPath) return '场景配置'
  if (fieldPath === 'schemaVersion') return '配置版本'
  const parts = fieldPath.split('.').filter(Boolean)
  const head = parts[0] ?? ''
  const tail = parts.slice(1)

  if (head === 'scenario') {
    if (tail.length === 1 && tail[0] === 'name') return '基本信息 · 场景名称'
    const rest = formatTailSegments(tail)
    return rest ? `基本信息 · ${rest}` : '基本信息'
  }

  const linkMatch = /^links\[(\d+)\]$/.exec(head)
  if (linkMatch) {
    const linkIndex = Number(linkMatch[1])
    const prefix = formatLinkPrefix(linkIndex, config)
    const rest = formatTailSegments(tail)
    const portTarget = config && tail.length === 1 ? resolveLinkPortFieldTarget(config, linkIndex, tail[0]!) : null
    const portHint = portTarget && !portTarget.legacyLinkOverrideInvalid
      ? `（端口：${TEMPLATE_PLATFORM_LABELS[portTarget.platformType] ?? portTarget.platformType} · ${TEMPLATE_PORT_LABELS[portTarget.portName] ?? portTarget.portName}）`
      : ''
    return rest ? `${prefix} · ${rest}${portHint}` : prefix
  }

  const platformMatch = /^platforms\[(\d+)\]$/.exec(head)
  if (platformMatch) {
    const prefix = formatPlatformPrefix(Number(platformMatch[1]), config)
    const rest = formatTailSegments(tail)
    return rest ? `${prefix} · ${rest}` : prefix
  }

  const jammerMatch = /^jammers\[(\d+)\]$/.exec(head)
  if (jammerMatch) {
    const prefix = formatJammerPrefix(Number(jammerMatch[1]), config)
    const rest = formatTailSegments(tail)
    return rest ? `${prefix} · ${rest}` : prefix
  }

  const sensorMatch = /^sensors\[(\d+)\]$/.exec(head)
  if (sensorMatch) {
    const prefix = formatSensorPrefix(Number(sensorMatch[1]), config)
    const rest = formatTailSegments(tail)
    return rest ? `${prefix} · ${rest}` : prefix
  }

  if (head === 'uiExtensions') {
    const sub = tail[0] ?? ''
    const uiJammer = /^jammers\[(\d+)\]$/.exec(sub)
    if (uiJammer) {
      const prefix = formatJammerPrefix(Number(uiJammer[1]), config)
      const rest = formatTailSegments(tail.slice(1))
      return rest ? `${prefix} · ${rest}` : prefix
    }
    const uiSensor = /^sensors\[(\d+)\]$/.exec(sub)
    if (uiSensor) {
      const prefix = formatSensorPrefix(Number(uiSensor[1]), config)
      const rest = formatTailSegments(tail.slice(1))
      return rest ? `${prefix} · ${rest}` : prefix
    }
  }

  if (head === 'deviceParameters') {
    if (tail[0] === 'ports' && tail[1] && tail[2]) {
      const platformLabel = TEMPLATE_PLATFORM_LABELS[tail[1]] ?? tail[1]
      const portLabel = TEMPLATE_PORT_LABELS[tail[2]] ?? tail[2]
      const rest = tail.slice(3).map(translateLeaf).join(' · ')
      return rest ? `端口参数（${platformLabel} · ${portLabel}） · ${rest}` : `端口参数（${platformLabel} · ${portLabel}）`
    }
    if (tail[0] === 'antennaGains' && tail[1]) {
      const antennaLabel = TEMPLATE_ANTENNA_LABELS[tail[1]] ?? tail[1]
      const rest = tail.slice(2).map(translateLeaf).join(' · ')
      return rest ? `其他天线模型与增益（${antennaLabel}） · ${rest}` : `其他天线模型与增益（${antennaLabel}）`
    }
    if (tail[0] === 'commPorts') return '端口参数 · 通信端口清单'
    const rest = formatTailSegments(tail)
    return rest ? `设备参数 · ${rest}` : '设备参数'
  }

  if (head === 'linkSettings') {
    const rest = formatTailSegments(tail)
    return rest ? `全局链路设置 · ${rest}` : '全局链路设置'
  }

  const demandMatch = /^informationDemand\[(\d+)\]$/.exec(head)
  if (demandMatch) {
    const prefix = `第 ${Number(demandMatch[1]) + 1} 条信息需求`
    const rest = formatTailSegments(tail)
    return rest ? `${prefix} · ${rest}` : prefix
  }

  const phaseMatch = /^taskPhases\[(\d+)\]$/.exec(head)
  if (phaseMatch) {
    const prefix = `第 ${Number(phaseMatch[1]) + 1} 个任务阶段`
    const rest = formatTailSegments(tail)
    return rest ? `${prefix} · ${rest}` : prefix
  }

  if (head === 'output') {
    const rest = formatTailSegments(tail)
    return rest ? `输出配置 · ${rest}` : '输出配置'
  }

  if (head === 'taskPhases') return '任务阶段配置'
  if (head === 'platforms') return '平台列表'
  if (head === 'links') return '链路列表'

  return parts.map(translateLeaf).join(' · ')
}

/**
 * 将同频互扰中的对端链路格式化为“第 X 条链路（源 → 目标，波段类型·方向）”。
 * 仅在起止平台路径均为空时才回退显示内部链路 ID。
 */
export function formatSpectrumConflictLink(
  link: SpectrumConflictLinkSummary,
  platforms: readonly Pick<Platform, 'id' | 'name'>[],
): string {
  const typeLabel = LINK_TYPE_LABELS[link.type as keyof typeof LINK_TYPE_LABELS] ?? String(link.type)
  const kindLabel = link.bandName ? `${link.bandName}波段${typeLabel}` : typeLabel
  const dirLabel = link.direction === 'FORWARD' ? '前向' : link.direction === 'REVERSE' ? '返向' : ''
  const route = [link.source, ...(link.relay ? [link.relay] : []), link.target]
    .filter(Boolean)
    .map(id => scenarioPlatformLabel(platforms, id))
    .join(' → ')
  const details = route
    ? [route, dirLabel ? `${kindLabel}·${dirLabel}` : kindLabel]
    : [dirLabel ? `${kindLabel}·${dirLabel}` : kindLabel, link.id].filter(Boolean)
  return `第 ${link.index + 1} 条链路（${details.join('，')}）`
}

const LEGACY_SPECTRUM_CONFLICT_RE = /^与链路\s+(\S+)\s+在同一接收平台\s+(\S+)\s+的频段重叠(.*)$/

/**
 * 将校验提示消息里的英文内部 ID 转换为当前场景对应的中文名称与序号描述；
 * 若服务端已直接返回中文描述，则原样返回。
 */
export function formatValidationIssueMessage(
  issue: Pick<ValidationIssue, 'code' | 'message'>,
  config?: ValidationLabelConfig,
): string {
  if (issue.code !== 'LINK_FREQUENCY_CONFLICT' || !config) return issue.message
  const match = LEGACY_SPECTRUM_CONFLICT_RE.exec(issue.message.trim())
  if (!match) return issue.message
  const [, rawLinkId, rawTargetId, suffix] = match
  const linkIndex = config.links.findIndex(item => item.id === rawLinkId)
  const matchedLink = linkIndex >= 0 ? config.links[linkIndex] : undefined
  const linkText = matchedLink
    ? formatSpectrumConflictLink(
      {
        index: linkIndex,
        id: matchedLink.id,
        type: matchedLink.type,
        bandName: matchedLink.type === 'DATALINK' ? matchedLink.band : undefined,
        direction: matchedLink.direction,
        source: matchedLink.sourcePlatformId,
        relay: matchedLink.relayPlatformId ?? undefined,
        target: matchedLink.targetPlatformId,
      },
      config.platforms,
    )
    : `链路 ${rawLinkId}`
  const targetLabel = scenarioPlatformLabel(config.platforms, rawTargetId!)
  return `与${linkText}在同一接收平台「${targetLabel}」的频段重叠${suffix}`
}

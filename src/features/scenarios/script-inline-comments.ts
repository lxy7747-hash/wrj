import type { Platform, ScenarioConfig } from '../../contracts/domain-models'

export type ScriptCommentCategory = 'platform' | 'motion' | 'communication' | 'sensor' | 'jammer' | 'timeline'
export type ScriptCommentMode = 'all' | 'off' | ScriptCommentCategory

export interface ScriptLineAnnotation {
  category: ScriptCommentCategory
  comment: string
  /** 超长单行（如 port_params/hot_link）放在行首徽标，常规行放在行尾注释。 */
  placement: 'after' | 'before'
}

const LONG_LINE_THRESHOLD = 140

const PLATFORM_TYPE_LABELS: Record<string, string> = {
  REAR_COMM_PLATFORM: '后方指挥平台',
  COMMAND_VEHICLE_PLATFORM: '地面集群指挥车平台',
  MISSION_UAV_PLATFORM: '任务无人机平台',
  TIAN_TONG_SAT: '天通通信卫星',
  SHEN_TONG_SAT: '神通通信卫星',
  GROUND_JAMMER_STATION: '地面干扰侦测站',
  AIRBORNE_JAMMER_PLATFORM: '机载干扰平台',
  WSF_PLATFORM: '通用平台基类',
}

const SIDE_LABELS: Record<string, string> = {
  blue: '蓝方',
  red: '红方',
  neutral: '中立',
}

const MOVER_LABELS: Record<string, string> = {
  WSF_AIR_MOVER: '空中运动模型',
  WSF_GROUND_MOVER: '地面运动模型',
  WSF_SURFACE_MOVER: '地面/海面运动模型',
  WSF_SPACE_MOVER: '轨道卫星运动模型',
}

const FILE_DESCRIPTIONS: Record<string, string> = {
  'comm_SimSetup.txt': '仿真主入口与时序配置',
  'comm_PerDefinition.txt': '公共天线与通信基础定义',
  'comm_platform_COMMAND_VEHICLE.txt': '集群指挥车平台类型定义',
  'comm_platform_MISSION_UAV.txt': '任务无人机平台类型定义',
  'comm_platform_JAMMER.txt': '干扰平台类型定义',
  'comm_platform_REAR.txt': '后方指挥平台与链路计算定义',
  'comm_platform_SAT.txt': '通信卫星平台类型定义',
  'comm_platform_INS.txt': '平台实例与运动航线定义',
  'observers.txt': '事件观测与日志脚本',
  'ad_hoc_comm.txt': '自组网通信定义',
}

const COMM_PORT_LABELS: Record<string, string> = {
  sat_link: '卫星链路端口',
  sat_link_a: '卫星链路端口 A',
  sat_link_b: '卫星链路端口 B',
  microwave_link: '微波链路端口',
  c_band_uplink: 'C 波段上行端口',
  c_band_downlink: 'C 波段下行端口',
  l_band_uplink: 'L 波段上行端口',
  l_band_downlink: 'L 波段下行端口',
  data_link: '数据链端口',
  lazer_link: '激光链路端口',
  laser_link: '激光链路端口',
  fiber_link: '光纤链路端口',
}

const HOT_LINK_PARAMETER_LABELS: Record<string, string> = {
  platform: '节点编号',
  inPort: '接收端口',
  outPort: '发送端口',
}

const PORT_PARAMETER_LABELS: Record<string, string> = {
  platform_type: '平台类型',
  comm_params: '通信端口列表',
  comm_name: '通信端口名称',
  modulation: '调制方式',
  transmitter: '发射参数',
  receiver: '接收参数',
  frequency_ghz: '频率（GHz）',
  bandwidth_mhz: '带宽（MHz）',
  power_w: '发射功率（W）',
  eirp_dBW: '等效全向辐射功率 EIRP（dBW）',
  peak_gain_dB: '天线峰值增益（dB）',
  G_T_dBK: '接收品质因数 G/T（dB/K）',
  noise_figure_dB: '接收机噪声系数（dB）',
  'information_rate_bit/s': '信息速率（bit/s）',
  'information_rate_kbits/sec': '信息速率（kbit/s）',
  'information_rate_mbits/sec': '信息速率（Mbit/s）',
}

const PARAMETER_VALUE_LABELS: Record<string, Record<string, string>> = {
  platform_type: PLATFORM_TYPE_LABELS,
  comm_name: COMM_PORT_LABELS,
  inPort: COMM_PORT_LABELS,
  outPort: COMM_PORT_LABELS,
}

const ENVIRONMENT_PARAMETER_LABELS: Record<string, string> = {
  rain: '降雨',
  cloud: '云雾',
  atmosphere: '大气衰减',
  enabled: '是否启用',
  rain_rate_mm_hr: '降雨强度（mm/h）',
  rain_altitude_limit_m: '雨区高度上限（m）',
  rain_attenuation_db: '固定雨衰（dB）',
  cloud_altitude_min_m: '云底高度（m）',
  cloud_altitude_max_m: '云顶高度（m）',
  cloud_water_density_g_m3: '云层含水量（g/m³）',
  model: '大气衰减模型',
  simplified_attenuation_db_per_km: '简化大气衰减（dB/km）',
  misc_loss_db: '附加损耗',
  polarization_mismatch_db: '极化失配损耗（dB）',
  pointing_error_db: '指向误差损耗（dB）',
  sea_state: '海面多径',
  sea_state_level: '海况等级',
  low_altitude_threshold_m: '低空高度阈值（m）',
  path_over_sea_threshold_km: '海面路径长度阈值（km）',
  mode: '海面多径模式',
  sea_polygon: '海域边界顶点',
  lat: '纬度（°）',
  lon: '经度（°）',
  polarization: '海面模型极化方式',
  sea_water_temp_c: '海水温度（℃）',
  sea_surface_roughness_m: '海面粗糙度（m）',
}

const JAMMER_PARAMETER_LABELS: Record<string, string> = {
  jammers: '干扰设备列表',
  platform_name: '所属节点编号',
  weapon_name: '干扰载荷名称',
  jammer_type: '干扰平台类型',
  enabled: '是否启用',
  mode: '干扰模式',
  G_T_dBK: '接收品质因数 G/T（dB/K）',
  frequency_ghz: '频率（GHz）',
  bandwidth_mhz: '带宽（MHz）',
  power_w: '侦测雷达发射功率（W）',
  noise_figure: '侦测接收机噪声系数（dB）',
  weapon_power_w: '干扰发射功率（W）',
  weapon_eirp_dBW: '干扰等效全向辐射功率 EIRP（dBW）',
  weapon_antenna_gain_dbi: '干扰天线增益（dBi）',
  weapon_band_params: '干扰频段列表',
  tx_loss_db: '发射损耗（dB）',
  detect_radius_nm: '侦测半径（海里）',
  trigger_radius_nm: '干扰触发半径（海里）',
  release_radius_nm: '干扰释放半径（海里）',
  spot_bandwidth_mhz: '点频干扰带宽（MHz）',
  sweep_duty_cycle: '扫频占空比（0～1）',
}

const PARAMETER_LABELS: Record<string, Record<string, string>> = {
  hot_link_ret: HOT_LINK_PARAMETER_LABELS,
  hot_link_fw: HOT_LINK_PARAMETER_LABELS,
  port_params: PORT_PARAMETER_LABELS,
  natural_environment: ENVIRONMENT_PARAMETER_LABELS,
  jammer_param: JAMMER_PARAMETER_LABELS,
}

export function annotateScriptParameterLine(name: string, line: string): string | undefined {
  const [, key, value] = /^\s*"([^"\\]+)":(?:\s*"([^"\\]+)")?/u.exec(line) ?? []
  if (key === undefined) return undefined
  const labels = PARAMETER_LABELS[name]
  if (labels === undefined) return undefined
  const label = labels === HOT_LINK_PARAMETER_LABELS && /^link\d+$/u.test(key)
    ? '候选路由'
    : Object.hasOwn(labels, key) ? labels[key] : undefined
  if (label === undefined) return undefined
  const valueLabels = PARAMETER_VALUE_LABELS[key]
  const valueLabel = valueLabels && value !== undefined && Object.hasOwn(valueLabels, value)
    ? valueLabels[value] : undefined
  return `  // ${label}${valueLabel === undefined ? '' : ` · ${valueLabel}`}`
}

const CHANNEL_ENCODING_LABELS: Record<string, string> = {
  '-1': '未编码',
  '0': '无额外编码增益',
  '3.5': 'RS/卷积编码（3.5 dB）',
  '5': 'LDPC 编码（5.0 dB）',
  '5.0': 'LDPC 编码（5.0 dB）',
  '6.5': 'Turbo 编码（6.5 dB）',
  '8': '强纠错编码（8.0 dB）',
  '8.0': '强纠错编码（8.0 dB）',
}

function buildPlatformNameMap(config?: ScenarioConfig | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!config) return map
  const setIfMissing = (key: string, label: string) => {
    if (key && label && !map.has(key)) map.set(key, label)
  }
  const byType = (type: Platform['type']) => config.platforms.filter(item => item.type === type)
  for (const platform of config.platforms) {
    setIfMissing(platform.id, platform.name)
  }
  const rear = byType('REAR_COMMAND_NODE')[0]
  if (rear) setIfMissing('rear_comm_vehicle', rear.name)
  const cmd = byType('GROUND_CLUSTER_COMMAND_NODE')[0]
  if (cmd) setIfMissing('command_vehicle', cmd.name)
  const sats = byType('COMMUNICATION_SATELLITE')
  const tiantong = sats.find(item => item.satelliteType === 'TIANTONG')
  if (tiantong) setIfMissing('tiantong_sat', tiantong.name)
  const shentong = sats.find(item => item.satelliteType === 'SHENTONG')
  if (shentong) setIfMissing('shentong_sat', shentong.name)
  const groundJammers = byType('GROUND_JAMMER_DETECTION_STATION')
  groundJammers.forEach((item, index) => setIfMissing(`jammer_station_${String(index + 1).padStart(2, '0')}`, item.name))
  const airJammers = byType('AIRBORNE_JAMMER_PLATFORM')
  airJammers.forEach((item, index) => {
    const suffix = String(index + 1).padStart(2, '0')
    setIfMissing(`jammer_airbround_${suffix}`, item.name)
    setIfMissing(`jammer_airborne_${suffix}`, item.name)
  })
  const uavs = [...byType('FORWARD_RELAY_NODE'), ...byType('AIRBORNE_MISSION_CLUSTER')]
  uavs.forEach((item, index) => setIfMissing(`mission_uav_${String(index + 1).padStart(2, '0')}`, item.name))
  return map
}

function formatCoord(token: string): string {
  const match = /^(-?\d+(?:\.\d+)?)([nsew])$/iu.exec(token)
  if (!match) return token
  const value = match[1]!
  const dir = match[2]!.toLowerCase()
  const label = dir === 'n' ? '北纬' : dir === 's' ? '南纬' : dir === 'e' ? '东经' : '西经'
  return `${label} ${value}°`
}

function formatPositionDetails(trimmed: string): string {
  const posMatch = /^position\s+(\S+)\s+(\S+)(.*)$/u.exec(trimmed)
  if (!posMatch) return ''
  const parts = [`${formatCoord(posMatch[1]!)}，${formatCoord(posMatch[2]!)}`]
  const rest = posMatch[3] ?? ''
  const alt = /\baltitude\s+([\d.]+)\s*(\S+)/u.exec(rest)
  if (alt) parts.push(`高度 ${alt[1]} ${alt[2]}`)
  const heading = /\bheading\s+([\d.]+)\s*(\S+)/u.exec(rest)
  if (heading) parts.push(`航向 ${heading[1]}°`)
  const speed = /\bspeed\s+([\d.]+)\s*(\S+)/u.exec(rest)
  if (speed) parts.push(`速度 ${speed[1]} ${speed[2]}`)
  if (/\bturn\s+left\b/u.test(rest)) parts.push('左转盘旋')
  else if (/\bturn\s+right\b/u.test(rest)) parts.push('右转盘旋')
  return parts.join('，')
}

function makeComment(
  category: ScriptCommentCategory,
  text: string,
  lineLength: number,
  shortBadge?: string,
): ScriptLineAnnotation {
  if (lineLength > LONG_LINE_THRESHOLD) {
    return { category, comment: shortBadge ?? `[${text}]`, placement: 'before' }
  }
  return { category, comment: `  // ${text}`, placement: 'after' }
}

/**
 * 为前端预览中的单份 AFSIM `.txt` 脚本生成纯展示用中文行注释，不修改原脚本文本。
 * `.json` 快照文件不附加语法注释，直接返回全 `null`。
 */
export function annotateScriptSectionLines(
  fileName: string,
  lines: readonly string[],
  config?: ScenarioConfig | null,
): Array<ScriptLineAnnotation | null> {
  if (!/\.txt$/iu.test(fileName) && fileName !== '脚本原文' && fileName !== '脚本内容') {
    return lines.map(() => null)
  }

  const platformNames = buildPlatformNameMap(config)
  type BlockScope = 'comm' | 'sensor' | 'weapon' | 'mover' | 'link_calc' | 'route' | 'return_route' | 'platform' | 'platform_type'
  const stack: BlockScope[] = []
  let platformHasOuterPosition = false
  let routePointIndex = 0
  let inLoiterLoop = false
  let inTransmitter = false
  let inReceiver = false

  const activeRadioOwner = (): ScriptCommentCategory => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const scope = stack[i]
      if (scope === 'sensor') return 'sensor'
      if (scope === 'weapon') return 'jammer'
      if (scope === 'comm') return 'communication'
    }
    return 'communication'
  }

  const hasScope = (scope: BlockScope) => stack.includes(scope)

  const popScope = (scope: BlockScope) => {
    const idx = stack.lastIndexOf(scope)
    if (idx >= 0) stack.splice(idx, 1)
  }

  return lines.map((rawLine) => {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) return null
    const len = rawLine.length

    // 块结束语句更新上下文状态
    if (trimmed === 'end_platform') {
      popScope('platform')
      platformHasOuterPosition = false
      return null
    }
    if (trimmed === 'end_platform_type') { popScope('platform_type'); return null }
    if (trimmed === 'end_route') {
      popScope('route')
      popScope('return_route')
      routePointIndex = 0
      inLoiterLoop = false
      return null
    }
    if (trimmed === 'end_comm') { popScope('comm'); inTransmitter = false; inReceiver = false; return null }
    if (trimmed === 'end_sensor') { popScope('sensor'); inTransmitter = false; inReceiver = false; return null }
    if (trimmed === 'end_weapon') { popScope('weapon'); inTransmitter = false; inReceiver = false; return null }
    if (trimmed === 'end_mover') { popScope('mover'); return null }
    if (trimmed === 'end_processor') { popScope('link_calc'); return null }
    if (trimmed === 'end_transmitter') { inTransmitter = false; return null }
    if (trimmed === 'end_receiver') { inReceiver = false; return null }

    // 1. 时序与引用定义
    const includeMatch = /^include_once\s+(\S+)$/u.exec(trimmed)
    if (includeMatch) {
      const target = includeMatch[1]!
      const desc = FILE_DESCRIPTIONS[target]
      return makeComment('timeline', desc ? `引用脚本：${target}（${desc}）` : `引用脚本：${target}`, len)
    }
    const startDate = /^start_date\s+(.+)$/u.exec(trimmed)
    if (startDate) return makeComment('timeline', `仿真起始日期：${startDate[1]}`, len)
    const startTime = /^start_time\s+(.+)$/u.exec(trimmed)
    if (startTime) return makeComment('timeline', `仿真起始时刻（UTC）：${startTime[1]}`, len)
    const endTime = /^end_time\s+([\d.]+)\s*(\S+)/u.exec(trimmed)
    if (endTime) {
      const sec = Number(endTime[1])
      const minHint = Number.isFinite(sec) && endTime[2]?.startsWith('sec') && sec >= 60 ? `（约 ${(sec / 60).toFixed(sec % 60 === 0 ? 0 : 1)} 分钟）` : ''
      return makeComment('timeline', `仿真总时长：${endTime[1]} ${endTime[2]}${minHint}`, len)
    }
    if (trimmed === 'realtime') return makeComment('timeline', '启用实时时钟同步模式', len)
    const clockRate = /^clock_rate\s+([\d.]+)$/u.exec(trimmed)
    if (clockRate) return makeComment('timeline', `仿真倍速：${clockRate[1]}×`, len)
    if (trimmed === 'multi_thread') return makeComment('timeline', '启用多线程仿真计算', len)
    if (/^simulation_name\s+/u.test(trimmed)) return makeComment('timeline', '仿真任务名称', len)
    if (trimmed === 'event_pipe') return makeComment('timeline', '仿真事件流（.aer）输出配置', len)
    if (trimmed === 'csv_event_output') return makeComment('timeline', '仿真事件表（.csv）输出配置', len)

    // 2. 平台定义
    const platformMatch = /^platform\s+(\S+)\s+(\S+)$/u.exec(trimmed)
    if (platformMatch) {
      stack.push('platform')
      platformHasOuterPosition = false
      const [, id, type] = platformMatch
      const cnName = platformNames.get(id!)
      const cnType = PLATFORM_TYPE_LABELS[type!] ?? type
      const idText = cnName && cnName !== id ? `ID=${id}（${cnName}）` : `ID=${id}`
      return makeComment('platform', `平台实例：${idText}，类型=${cnType}`, len)
    }
    const platformTypeMatch = /^platform_type\s+(\S+)\s+(\S+)$/u.exec(trimmed)
    if (platformTypeMatch) {
      stack.push('platform_type')
      const [, name, base] = platformTypeMatch
      const cnName = PLATFORM_TYPE_LABELS[name!] ?? name
      const cnBase = PLATFORM_TYPE_LABELS[base!] ?? base
      return makeComment('platform', `平台类型定义：${cnName}（继承 ${cnBase}）`, len)
    }
    const sideMatch = /^side\s+(\S+)$/u.exec(trimmed)
    if (sideMatch) {
      const side = SIDE_LABELS[sideMatch[1]!.toLowerCase()] ?? sideMatch[1]
      return makeComment('platform', `阵营：${side}`, len)
    }
    const iconMatch = /^icon\s+(\S+)$/u.exec(trimmed)
    if (iconMatch) return makeComment('platform', `态势图标样式：${iconMatch[1]}`, len)
    const creationMatch = /^creation_time\s+(.+)$/u.exec(trimmed)
    if (creationMatch) return makeComment('platform', `平台创建时刻：${creationMatch[1]}`, len)
    if (/^radar_signature\s+/u.test(trimmed)) return makeComment('platform', '平台雷达散射截面特征', len)

    // 3. 运动定义（及平台初始位置）
    const moverMatch = /^mover\s+(\S+)$/u.exec(trimmed)
    if (moverMatch) {
      stack.push('mover')
      const label = MOVER_LABELS[moverMatch[1]!] ?? moverMatch[1]
      return makeComment('motion', `运动模型：${label}`, len)
    }
    const returnRouteMatch = /^route\s+return_(\S+)$/u.exec(trimmed)
    if (returnRouteMatch) {
      stack.push('return_route')
      routePointIndex = 0
      inLoiterLoop = false
      const targetId = returnRouteMatch[1]!
      const cnName = platformNames.get(targetId)
      return makeComment('motion', `返航航线定义：${cnName ? `${cnName}（${targetId}）` : targetId}`, len)
    }
    if (trimmed === 'route') {
      stack.push('route')
      routePointIndex = 0
      inLoiterLoop = false
      return makeComment('motion', '平台主运动航线', len)
    }
    const labelMatch = /^label\s+(\S+)$/u.exec(trimmed)
    if (labelMatch && (hasScope('route') || hasScope('return_route'))) {
      inLoiterLoop = true
      return makeComment('motion', `盘旋循环起点标签（${labelMatch[1]}）`, len)
    }
    const gotoMatch = /^goto\s+(\S+)$/u.exec(trimmed)
    if (gotoMatch && (hasScope('route') || hasScope('return_route'))) {
      return makeComment('motion', `循环跳回 ${gotoMatch[1]} 持续盘旋`, len)
    }
    const executeAtTime = /^execute\s+at_time\s+([\d.]+)\s*(\S+)/u.exec(trimmed)
    if (executeAtTime) {
      return makeComment('motion', `定时触发返航：第 ${executeAtTime[1]} ${executeAtTime[2]}`, len)
    }
    const followRoute = /^PLATFORM\.FollowRoute\("([^"]+)"\);?$/u.exec(trimmed)
    if (followRoute) return makeComment('motion', `切换执行返航航线：${followRoute[1]}`, len)

    if (/^position\s+/u.test(trimmed)) {
      const details = formatPositionDetails(trimmed)
      if (!hasScope('route') && !hasScope('return_route')) {
        platformHasOuterPosition = true
        return makeComment('platform', `初始位置：${details}`, len)
      }
      routePointIndex += 1
      if (hasScope('return_route')) {
        return makeComment('motion', `返航航点 ${routePointIndex}：${details}`, len)
      }
      if (routePointIndex === 1 && !platformHasOuterPosition && hasScope('platform')) {
        return makeComment('platform', `初始位置（起点）：${details}`, len)
      }
      const prefix = inLoiterLoop ? `盘旋航点 ${routePointIndex}` : `航点 ${routePointIndex}`
      return makeComment('motion', `${prefix}：${details}`, len)
    }
    const altMatch = /^altitude\s+([\d.]+)\s*(\S+)$/u.exec(trimmed)
    if (altMatch && hasScope('platform') && !hasScope('route')) {
      return makeComment('platform', `初始高度：${altMatch[1]} ${altMatch[2]}`, len)
    }
    const headingMatch = /^heading\s+([\d.]+)\s*(\S+)$/u.exec(trimmed)
    if (headingMatch && hasScope('platform') && !hasScope('route')) {
      return makeComment('platform', `初始航向：${headingMatch[1]}°`, len)
    }

    // 4. 传感器定义
    const sensorMatch = /^(?:add\s+)?sensor\s+(\S+)\s+(\S+)$/u.exec(trimmed)
    if (sensorMatch) {
      stack.push('sensor')
      return makeComment('sensor', `传感器定义：${sensorMatch[1]}（${sensorMatch[2]}）`, len)
    }
    const detRangeMatch = /^double\s+detection_range_nm\s*=\s*([\d.]+)\s*;?$/u.exec(trimmed)
    if (detRangeMatch) {
      const nm = Number(detRangeMatch[1])
      const km = Number.isFinite(nm) ? `（约 ${(nm * 1.852).toFixed(1)} km）` : ''
      return makeComment('sensor', `地面站侦测半径：${detRangeMatch[1]} 海里${km}`, len)
    }

    // 5. 干扰定义
    const weaponMatch = /^(?:add\s+)?weapon\s+(\S+)\s+(\S+)$/u.exec(trimmed)
    if (weaponMatch) {
      stack.push('weapon')
      return makeComment('jammer', `干扰载荷定义：${weaponMatch[1]}（${weaponMatch[2]}）`, len)
    }
    if (/^jammer_param\s+/u.test(trimmed)) {
      return makeComment('jammer', '干扰源位置、功率与天线增益参数', len, '[干扰·干扰参数配置]')
    }

    // 6. 通信与链路计算定义
    const commMatch = /^(?:add\s+)?comm\s+(\S+)\s+(\S+)$/u.exec(trimmed)
    if (commMatch) {
      stack.push('comm')
      const portCn = COMM_PORT_LABELS[commMatch[1]!]
      return makeComment('communication', portCn ? `通信设备：${commMatch[1]}（${portCn}）` : `通信设备：${commMatch[1]}（${commMatch[2]}）`, len)
    }
    if (/^(?:add\s+)?processor\s+link_calc\b/u.test(trimmed)) {
      stack.push('link_calc')
      return makeComment('communication', '链路质量与抗干扰选路计算处理器', len)
    }
    const antennaDef = /^antenna_pattern\s+(\S+)$/u.exec(trimmed)
    if (antennaDef) {
      const owner = stack.length ? activeRadioOwner() : 'communication'
      return makeComment(owner, stack.length ? `使用天线方向图：${antennaDef[1]}` : `天线方向图定义：${antennaDef[1]}`, len)
    }
    if (trimmed === 'transmitter') {
      inTransmitter = true
      inReceiver = false
      const owner = activeRadioOwner()
      return makeComment(owner, owner === 'jammer' ? '干扰发射机参数' : owner === 'sensor' ? '传感器发射机参数' : '通信发射机参数', len)
    }
    if (trimmed === 'receiver') {
      inReceiver = true
      inTransmitter = false
      const owner = activeRadioOwner()
      return makeComment(owner, owner === 'sensor' ? '传感器接收机参数' : '通信接收机参数', len)
    }
    const freqMatch = /^frequency\s+(.+)$/u.exec(trimmed)
    if (freqMatch) {
      const owner = activeRadioOwner()
      const dir = inTransmitter ? '发射' : inReceiver ? '接收' : ''
      return makeComment(owner, `${dir}中心频率：${freqMatch[1]}`, len)
    }
    const bwMatch = /^bandwidth\s+(.+)$/u.exec(trimmed)
    if (bwMatch) return makeComment(activeRadioOwner(), `工作带宽：${bwMatch[1]}`, len)
    const powerMatch = /^power\s+(.+)$/u.exec(trimmed)
    if (powerMatch) return makeComment(activeRadioOwner(), `发射功率：${powerMatch[1]}`, len)
    const polMatch = /^polarization\s+(\S+)$/u.exec(trimmed)
    if (polMatch) return makeComment(activeRadioOwner(), `极化方式：${polMatch[1]}`, len)
    const nfMatch = /^noise_figure\s+(.+)$/u.exec(trimmed)
    if (nfMatch) return makeComment(activeRadioOwner(), `接收机噪声系数：${nfMatch[1]}`, len)
    const dtMatch = /^detection_threshold\s+(.+)$/u.exec(trimmed)
    if (dtMatch) return makeComment(activeRadioOwner(), `接收检测门限：${dtMatch[1]}`, len)
    const rateMatch = /^transfer_rate\s+(.+)$/u.exec(trimmed)
    if (rateMatch) return makeComment('communication', `信道传输速率：${rateMatch[1]}`, len)
    const chanMatch = /^channels\s+(\d+)$/u.exec(trimmed)
    if (chanMatch) return makeComment('communication', `并行信道数：${chanMatch[1]}`, len)
    const netMatch = /^network_name\s+(\S+)$/u.exec(trimmed)
    if (netMatch) return makeComment('communication', `所属通信网络：${netMatch[1]}`, len)

    // link_calc 与 mover 的更新周期区分
    const intervalMatch = /^update_interval\s+(.+)$/u.exec(trimmed)
    if (intervalMatch) {
      if (hasScope('link_calc')) return makeComment('communication', `链路质量计算周期：${intervalMatch[1]}`, len)
      if (hasScope('mover')) return makeComment('motion', `运动位置更新周期：${intervalMatch[1]}`, len)
    }

    // link_calc 处理器内部参数
    if (hasScope('link_calc')) {
      const em = /^emergency_threshold\s+(\S+)$/u.exec(trimmed)
      if (em) return makeComment('communication', `紧急切换误码率门限：${em[1]}`, len)
      const warn = /^warning_threshold\s+(\S+)$/u.exec(trimmed)
      if (warn) return makeComment('communication', `链路告警误码率门限：${warn[1]}`, len)
      const val = /^value_threshold_ber\s+(\S+)$/u.exec(trimmed)
      if (val) return makeComment('communication', `链路质量参考误码率门限：${val[1]}`, len)
      const enc = /^channel_encoding_scheme\s+(\S+)$/u.exec(trimmed)
      if (enc) {
        const label = CHANNEL_ENCODING_LABELS[enc[1]!] ?? `编码增益 ${enc[1]} dB`
        return makeComment('communication', `信道编码方案：${label}`, len)
      }
      if (/^relay_uav_names\s+/u.test(trimmed)) return makeComment('communication', '中继无人机节点清单', len, '[通信·中继节点清单]')
      if (/^traffic_type\s+/u.test(trimmed)) return makeComment('communication', '业务流量路由与数据量定义', len, '[通信·业务流量配置]')
      if (/^hot_link_ret\s+/u.test(trimmed)) return makeComment('communication', '回传方向热链候选路由表', len, '[通信·回传热链路由]')
      if (/^hot_link_fw\s+/u.test(trimmed)) return makeComment('communication', '前向方向热链候选路由表', len, '[通信·前向热链路由]')
      if (/^port_params\s+/u.test(trimmed)) return makeComment('communication', '通信端口 EIRP、G/T 与调制方式参数', len, '[通信·端口射频参数]')
      if (/^natural_environment\s+/u.test(trimmed)) return makeComment('communication', '自然环境衰减参数（降雨/云雾/大气/海况）', len, '[通信·自然环境衰减]')
    }

    return null
  })
}

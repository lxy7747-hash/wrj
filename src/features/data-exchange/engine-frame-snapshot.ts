import type { EngineFrameSnapshot, EngineJammer, EngineLinkSegment, EnginePathNode, EngineRoute, EngineRouteSwitch, ValidationIssue } from '../../contracts/domain-models'

/** websocketNew 正常帧号每次递增 5，对应仿真推进 5 秒；与 WS 信封 sequence 独立。 */
export const ENGINE_FRAME_ID_STEP = 5

/** 引擎以仿真秒数标识帧，亚秒推送保留小数，不取整或另造帧号。 */
export function isEngineFrameId(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}

const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
const texts = (value: unknown): string[] => (typeof value === 'string' ? [value] : list(value)).filter((item): item is string => text(item) !== null)
const number = (value: unknown, factor = 1): number | null => {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value.trim()) ? Number(value) : NaN
  return Number.isFinite(parsed * factor) ? parsed * factor : null
}
const nodes = (value: unknown): EnginePathNode[] => list(value).map(item => {
  const node = record(item), name = text(node.plat_name)
  return { platformName: name, platformId: name, inPort: text(node.in_port), outPort: text(node.out_port) }
})

function route(value: unknown, direction: EngineRoute['direction'], switching: boolean): EngineRoute {
  const item = record(value), pathNodes = nodes(switching ? item.new_path_nodes : item.path_nodes)
  const sourceName = text(item.src_name), targetName = text(item.dist_name), params = record(item.path_params)
  return {
    pathId: text(item.path_id) ?? text(item.pathid) ?? JSON.stringify([sourceName, targetName, pathNodes.map(node => [node.platformName, node.inPort, node.outPort])]),
    direction, sourceName, targetName, sourcePlatformId: sourceName, targetPlatformId: targetName,
    transTypes: texts(params.trans_type ?? item.trans_type), nodes: pathNodes,
    parameters: { delay: number(params.delay), transFrequency: number(params.trans_freq), dataContent: number(params.data_content) },
  }
}

/** 仅必需帧头/链路数组无效时拒绝整帧；其余缺测值留空，原始原因字符串不收紧。 */
export function adaptEngineFrameSnapshot(value: unknown): { data: EngineFrameSnapshot } | { data: null; errors: ValidationIssue[] } {
  const input = record(value), calc = record(input.link_calc), manager = record(input.link_manager)
  // 对接方已取消 sim_time_s；帧号 5→10 对应仿真 5→10 秒，旧时间字段不再使用。
  const frameId = number(input.frame_id)
  const errors: ValidationIssue[] = []
  const error = (fieldPath: string, message: string) => errors.push({ severity: 'ERROR', code: 'ENGINE_FRAME_INVALID', fieldPath, message })
  if (!isEngineFrameId(frameId)) error('frame_id', '引擎帧号必须为非负有限数，且不超过安全数值范围。')
  if (!Array.isArray(calc.links)) error('link_calc.links', '引擎链路段必须为数组。')
  if (errors.length) return { data: null, errors }
  const links = list(calc.links).map((value): EngineLinkSegment => {
    const item = record(value), losses = record(item.losses), quality = record(item.quality), trace = record(quality.input_trace)
    const sourceName = text(item.tx_platform), targetName = text(item.rx_platform), sourcePort = text(item.tx_port), targetPort = text(item.rx_port)
    const engineStatus = text(item.status), rxPowerDbw = number(quality.rx_power_dbw)
    return {
      linkId: text(item.link_id) ?? JSON.stringify([sourceName, sourcePort, targetName, targetPort]), linkIds: [],
      sourceName, sourcePlatformId: sourceName, sourcePort, targetName, targetPlatformId: targetName, targetPort,
      engineStatus, status: engineStatus === 'AVAILABLE' ? 'UP' : engineStatus === 'RISK' ? 'DEGRADED' : engineStatus === 'INVALID' ? 'DOWN' : 'UNKNOWN',
      error: text(quality.error_msg), distanceM: number(item.distance_km, 1000),
      losses: { freeSpaceDb: number(losses.free_space_db), seaMultipathDb: number(losses.sea_multipath_db), atmosphericDb: number(losses.atmospheric_db),
        cloudRainDb: number(losses.cloud_rain_db), jammingDb: number(losses.jamming_loss_db), totalDb: number(losses.total_composite_db),
        // shortcut: 分量与总损耗均保留源值，口径确认后再做合并或派生统计。
        rainDb: number(losses.atten_rain_db), cloudDb: number(losses.atten_cloud_db) },
      quality: { gxbDb: number(quality.gxb_db), ber: number(quality.ber), rxPowerDbw, rxPowerDbm: rxPowerDbw === null ? null : rxPowerDbw + 30,
        delay: number(quality.delay),
        ...(Object.hasOwn(quality, 'margin_db') ? { marginDb: number(quality.margin_db) } : {}),
        ...(Object.hasOwn(quality, 'delay_ms') ? { delayMs: number(quality.delay_ms) } : {}),
      },
      inputTrace: { eirpDbw: number(trace.eirp_dbw), gtDbk: number(trace.g_over_t_dbk), dataRateMbps: number(trace.data_rate_bps, 1e-6),
        frequencyGHz: number(trace.frequency_ghz ?? trace.frequency),
        jammers: list(trace.jammers).map(value => { const jammer = record(value), name = text(jammer.jammer_name); return {
          jammerName: name, platformId: name, distanceM: number(jammer.dist_km, 1000), eirpDbw: number(jammer.eirp_dbw), lossDb: number(jammer.Loss_dB),
          ...(Object.hasOwn(jammer, 'frequency_ghz') ? { frequencyGHz: number(jammer.frequency_ghz) } : {}),
        } }),
      },
    }
  })
  const pathQuality = Array.isArray(calc.path_quality) ? calc.path_quality.map(value => {
    const item = record(value)
    return {
      pathId: text(item.path_id), gxbDb: number(item.gxb_db), ber: number(item.ber),
      marginDb: number(item.margin_db), delayMs: number(item.delay_ms), rateBps: number(item.rate_bps),
    }
  }) : undefined
  const parseJamMode = (mode: string | null): 'BARRAGE' | 'SPOT' | 'SWEEP' | null =>
    mode === 'broadband' ? 'BARRAGE' : mode === 'spot' ? 'SPOT' : mode === 'sweep' ? 'SWEEP' : null
  const jammers = list(input.jammer_params).map((value): EngineJammer => {
    const item = record(value), sensor = record(item.jammer_sensor), rf = record(item.rf_jammer), params = record(rf.active_params), name = text(item.jammer_name), pos = record(item.jammer_pos)
    const freqBands = Array.isArray(params.freq_band)
      ? list(params.freq_band).map(entry => {
        const band = record(entry), engineMode = text(band.mode)
        return {
          frequencyGHz: number(band.frequency_ghz),
          bandwidthMHz: number(band.bandwidth_mhz),
          mode: parseJamMode(engineMode),
          engineMode,
        }
      })
      : undefined
    const primaryBand = freqBands?.[0]
    const frequencyHz = number(params.freq_band_hz) ?? (primaryBand?.frequencyGHz != null ? primaryBand.frequencyGHz * 1e9 : null)
    const engineMode = text(rf.mode) ?? primaryBand?.engineMode ?? null
    return { name, platformId: name, detectStatus: text(sensor.detect_status), deviceStatus: text(rf.device_status),
      powerW: number(params.power_w), frequencyHz, rangeM: number(params.jammer_range_nm, 1852),
      ...(Object.hasOwn(params, 'antenna_gain_dbi') ? { antennaGainDbi: number(params.antenna_gain_dbi) } : {}),
      ...(Object.hasOwn(params, 'eirp_dbw') ? { eirpDbw: number(params.eirp_dbw) } : {}),
      ...(freqBands !== undefined ? { freqBands } : {}),
      position: { longitude: number(pos.lon), latitude: number(pos.lat), altitudeM: number(pos.alt_m) }, engineMode,
      detections: list(sensor.events).map(value => { const item = record(value), targetNames = texts(item.target_names); return {
        // 2026-11-24 起按插件实际输出统一为 Hz，与 rf_jammer.active_params 同名字段一致，不再乘 10⁹。
        targetNames, targetIds: [...targetNames], platformType: text(item.platform_type), frequencyHz: number(item.freq_band_hz),
        probability: number(item.detect_prob), rangeM: number(item.detect_range_nm, 1852),
        targets: list(item.target_pos).map(value => { const target = record(value), pos = record(target.pos), name = text(target.name); return {
          name, platformId: name, longitude: number(pos.lon), latitude: number(pos.lat), altitudeM: number(pos.alt_m),
          ...(Object.hasOwn(target, 'detect_prob') ? { probability: number(target.detect_prob) } : {}),
        } }),
      } }),
      actions: list(item.closed_loop).map(value => { const action = record(value), engineMode = text(action.jam_mode), targetName = text(action.jam_target_id); return {
        action: text(action.last_action), targetName, targetPlatformId: targetName, engineMode,
        mode: parseJamMode(engineMode),
        ...(Object.hasOwn(action, 'jam_freq_hz') ? { jamFreqHz: number(action.jam_freq_hz) } : {}),
      } }),
    }
  })
  const routes = (value: unknown, switching: boolean) => (['forward', 'return'] as const).flatMap(key => list(record(value)[key]).map(item => route(item, key === 'forward' ? 'FORWARD' : 'REVERSE', switching)))
  const routing = record(manager.routing_result)
  const switches = (['forward', 'return'] as const).flatMap(key => list(routing[key]).map((value): EngineRouteSwitch => {
    const item = record(value), oldNodes = nodes(item.old_path_nodes)
    return { ...route(item, key === 'forward' ? 'FORWARD' : 'REVERSE', true),
      oldPathId: text(item.old_path_id) ?? (oldNodes.length ? JSON.stringify([text(item.src_name), text(item.dist_name), oldNodes.map(node => [node.platformName, node.inPort, node.outPort])]) : null),
      oldNodes, reasons: list(item.reason_change ?? item.reason_chenge ?? item.ln_chenge).map(value => { const cause = record(value); return {
        linkId: text(cause.link_id) ?? text(cause.linkid), reasons: texts(cause.reason),
      } }),
    }
  }))
  return { data: {
    // 运行身份和重启轮次由服务端连接所有者覆盖，不信任外部消息中的身份。
    kind: 'ENGINE_FRAME', runId: '', engineEpoch: 0, frameId: frameId!, simulationTime: frameId!, modelVersion: text(calc.model_version), modulation: text(calc.modulation),
    wallTimeMs: number(input.wall_time_ms),
    links, jammers, ...(pathQuality === undefined ? {} : { pathQuality }), initRouting: manager.init_routing_result == null ? null : routes(manager.init_routing_result, false),
    routing: { switches, alarms: [...list(manager.alarm), ...list(routing.alarm)].map(value => { const item = record(value); return {
      pathId: text(item.path_id) ?? text(item.pathid), linkId: text(item.link_id) ?? text(item.linkid), message: text(item.message),
    } }) },
    events: list(input.events).map(value => { const item = record(value), uavNames = texts(item.events_uav), jammerNames = texts(item.events_jammer); return {
      type: text(item.events_type), pathId: text(item.events_pathid) ?? text(item.events_new_pathid) ?? text(item.events_old_pathid),
      ...(Object.hasOwn(item, 'events_new_pathid') ? { newPathId: text(item.events_new_pathid) } : {}),
      ...(Object.hasOwn(item, 'events_old_pathid') ? { oldPathId: text(item.events_old_pathid) } : {}),
      uavNames, jammerNames, uavIds: [...uavNames], jammerIds: [...jammerNames],
    } }),
  } }
}

const snapObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const snapStr = (v: unknown) => v === null || typeof v === 'string'
const snapNum = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v))
const snapArray = (v: unknown, check: (v: unknown) => boolean) => Array.isArray(v) && v.every(check)
const snapStrEl = (v: unknown) => typeof v === 'string'
const snapStrings = (v: unknown) => snapArray(v, snapStrEl)
const snapFields = (v: unknown, names: readonly string[], check: (v: unknown) => boolean) =>
  snapObj(v) && names.every(key => Object.hasOwn(v, key) && check(v[key]))
const snapOptional = (v: unknown, key: string, check: (v: unknown) => boolean) =>
  snapObj(v) && (!Object.hasOwn(v, key) || check(v[key]))

const PATH_NODE_FIELDS = ['platformName', 'platformId', 'inPort', 'outPort'] as const
const PATH_ENDPOINTS = ['sourceName', 'targetName', 'sourcePlatformId', 'targetPlatformId'] as const
const PATH_PARAMS = ['delay', 'transFrequency', 'dataContent'] as const
const LINK_ENDPOINTS = ['sourceName', 'sourcePlatformId', 'sourcePort', 'targetName', 'targetPlatformId', 'targetPort', 'engineStatus', 'error'] as const
const LOSS_FIELDS = ['freeSpaceDb', 'seaMultipathDb', 'atmosphericDb', 'cloudRainDb', 'jammingDb', 'totalDb'] as const
const QUALITY_FIELDS = ['gxbDb', 'ber', 'rxPowerDbw', 'rxPowerDbm'] as const
const TRACE_FIELDS = ['eirpDbw', 'gtDbk', 'dataRateMbps', 'frequencyGHz'] as const
const TRACE_JAMMER_NAMES = ['jammerName', 'platformId'] as const
const TRACE_JAMMER_NUMS = ['distanceM', 'eirpDbw', 'lossDb'] as const
const PATH_QUALITY_ID = ['pathId'] as const
const PATH_QUALITY_NUMS = ['gxbDb', 'ber', 'marginDb', 'delayMs', 'rateBps'] as const
const JAMMER_TEXTS = ['name', 'platformId', 'detectStatus', 'deviceStatus'] as const
const JAMMER_NUMS = ['powerW', 'frequencyHz', 'rangeM'] as const
const POS_FIELDS = ['longitude', 'latitude', 'altitudeM'] as const
const DET_NUMS = ['frequencyHz', 'probability', 'rangeM'] as const
const TARGET_TEXTS = ['name', 'platformId'] as const
const ACTION_TEXTS = ['action', 'targetName', 'targetPlatformId', 'engineMode'] as const
const ALARM_FIELDS = ['pathId', 'linkId', 'message'] as const
const EVENT_TEXTS = ['type', 'pathId'] as const
const EVENT_STRING_LISTS = ['uavNames', 'jammerNames', 'uavIds', 'jammerIds'] as const

const isSnapPathNode = (v: unknown) => snapFields(v, PATH_NODE_FIELDS, snapStr)
const isSnapPathNodes = (v: unknown) => snapArray(v, isSnapPathNode)
const isSnapPathParams = (p: unknown) => snapFields(p, PATH_PARAMS, snapNum)
const isSnapPath = (v: unknown) => snapObj(v) && typeof v.pathId === 'string' && v.pathId.length > 0
  && typeof v.direction === 'string' && (v.direction === 'FORWARD' || v.direction === 'REVERSE')
  && snapFields(v, PATH_ENDPOINTS, snapStr) && snapStrings(v.transTypes) && isSnapPathNodes(v.nodes)
  && snapOptional(v, 'parameters', isSnapPathParams)
const isSnapTraceJammer = (j: unknown) => snapFields(j, TRACE_JAMMER_NAMES, snapStr) && snapFields(j, TRACE_JAMMER_NUMS, snapNum)
  && snapOptional(j, 'frequencyGHz', snapNum)
const isSnapLink = (v: unknown) => snapObj(v) && typeof v.linkId === 'string' && v.linkId.length > 0 && snapStrings(v.linkIds)
  && snapFields(v, LINK_ENDPOINTS, snapStr)
  && typeof v.status === 'string' && (v.status === 'UP' || v.status === 'DEGRADED' || v.status === 'DOWN' || v.status === 'UNKNOWN')
  && snapNum(v.distanceM)
  && snapFields(v.losses, LOSS_FIELDS, snapNum)
  && snapOptional(v.losses, 'rainDb', snapNum) && snapOptional(v.losses, 'cloudDb', snapNum)
  && snapFields(v.quality, QUALITY_FIELDS, snapNum)
  && snapOptional(v.quality, 'delay', snapNum) && snapOptional(v.quality, 'marginDb', snapNum) && snapOptional(v.quality, 'delayMs', snapNum)
  && snapFields(v.inputTrace, TRACE_FIELDS, snapNum) && snapObj(v.inputTrace)
  && snapArray(v.inputTrace.jammers, isSnapTraceJammer)
const isSnapPathQualityItem = (item: unknown) => snapFields(item, PATH_QUALITY_ID, snapStr) && snapFields(item, PATH_QUALITY_NUMS, snapNum)
const isSnapPathQuality = (v: unknown) => snapArray(v, isSnapPathQualityItem)
const isSnapJamMode = (m: unknown) => m === null || (typeof m === 'string' && (m === 'BARRAGE' || m === 'SPOT' || m === 'SWEEP'))
const isSnapTarget = (t: unknown) => snapFields(t, TARGET_TEXTS, snapStr) && snapFields(t, POS_FIELDS, snapNum)
  && snapOptional(t, 'probability', snapNum)
const isSnapDetection = (d: unknown) => snapObj(d) && snapStrings(d.targetNames) && snapStrings(d.targetIds) && snapStr(d.platformType)
  && snapFields(d, DET_NUMS, snapNum) && snapArray(d.targets, isSnapTarget)
const isSnapAction = (a: unknown) => snapObj(a) && snapFields(a, ACTION_TEXTS, snapStr) && isSnapJamMode(a.mode)
  && snapOptional(a, 'jamFreqHz', snapNum)
const isSnapJammerBand = (b: unknown) => snapObj(b) && snapNum(b.frequencyGHz) && snapNum(b.bandwidthMHz)
  && isSnapJamMode(b.mode) && snapStr(b.engineMode)
const isSnapPos = (p: unknown) => snapFields(p, POS_FIELDS, snapNum)
const isSnapJammer = (v: unknown) => snapObj(v) && snapFields(v, JAMMER_TEXTS, snapStr) && snapFields(v, JAMMER_NUMS, snapNum)
  && snapOptional(v, 'antennaGainDbi', snapNum) && snapOptional(v, 'eirpDbw', snapNum)
  && snapOptional(v, 'freqBands', bands => snapArray(bands, isSnapJammerBand))
  && snapOptional(v, 'engineMode', snapStr) && snapOptional(v, 'position', isSnapPos)
  && snapArray(v.detections, isSnapDetection) && snapArray(v.actions, isSnapAction)
const isSnapReason = (r: unknown) => snapObj(r) && snapStr(r.linkId) && snapStrings(r.reasons)
const isSnapSwitch = (s: unknown) => snapObj(s) && isSnapPath(s) && snapStr(s.oldPathId) && isSnapPathNodes(s.oldNodes) && snapArray(s.reasons, isSnapReason)
const isSnapAlarm = (a: unknown) => snapFields(a, ALARM_FIELDS, snapStr)
const isSnapEvent = (e: unknown) => snapObj(e) && snapFields(e, EVENT_TEXTS, snapStr)
  && snapOptional(e, 'newPathId', snapStr) && snapOptional(e, 'oldPathId', snapStr)
  && EVENT_STRING_LISTS.every(k => snapStrings(e[k]))

/** 校验已归一化的 WS 载荷，不允许数字字符串或畸形嵌套越过前端信任边界。 */
export function isEngineFrameSnapshot(value: unknown): value is EngineFrameSnapshot {
  if (!snapObj(value) || value.kind !== 'ENGINE_FRAME' || typeof value.runId !== 'string' || !value.runId.trim()
    || typeof value.engineEpoch !== 'number' || !Number.isSafeInteger(value.engineEpoch) || value.engineEpoch < 0
    || !isEngineFrameId(value.frameId)
    || typeof value.simulationTime !== 'number' || !Number.isFinite(value.simulationTime) || value.simulationTime < 0
    || !snapStr(value.modelVersion) || !snapStr(value.modulation) || !snapOptional(value, 'wallTimeMs', snapNum)) return false
  return snapArray(value.links, isSnapLink)
    && snapOptional(value, 'pathQuality', isSnapPathQuality)
    && snapArray(value.jammers, isSnapJammer)
    && (value.initRouting === null || snapArray(value.initRouting, isSnapPath))
    && snapObj(value.routing) && snapArray(value.routing.switches, isSnapSwitch)
    && snapArray(value.routing.alarms, isSnapAlarm)
    && snapArray(value.events, isSnapEvent)
}

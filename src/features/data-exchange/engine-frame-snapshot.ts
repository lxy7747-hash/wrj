import type { EngineFrameSnapshot, EngineJammer, EngineLinkSegment, EnginePathNode, EngineRoute, EngineRouteSwitch, ValidationIssue } from '../../contracts/domain-models'

/** websocketNew 正常帧号每次递增 5，对应仿真推进 5 秒；与 WS 信封 sequence 独立。 */
export const ENGINE_FRAME_ID_STEP = 5

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
  if (frameId === null || !Number.isSafeInteger(frameId) || frameId < 0) error('frame_id', '引擎帧号必须为非负整数。')
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
      quality: { gxbDb: number(quality.gxb_db), ber: number(quality.ber), rxPowerDbw, rxPowerDbm: rxPowerDbw === null ? null : rxPowerDbw + 30, delay: number(quality.delay) },
      inputTrace: { eirpDbw: number(trace.eirp_dbw), gtDbk: number(trace.g_over_t_dbk), dataRateMbps: number(trace.data_rate_bps, 1e-6),
        frequencyGHz: number(trace.frequency_ghz ?? trace.frequency),
        jammers: list(trace.jammers).map(value => { const jammer = record(value), name = text(jammer.jammer_name); return {
          jammerName: name, platformId: name, distanceM: number(jammer.dist_km, 1000), eirpDbw: number(jammer.eirp_dbw), lossDb: number(jammer.Loss_dB),
        } }),
      },
    }
  })
  const jammers = list(input.jammer_params).map((value): EngineJammer => {
    const item = record(value), sensor = record(item.jammer_sensor), rf = record(item.rf_jammer), params = record(rf.active_params), name = text(item.jammer_name), pos = record(item.jammer_pos)
    return { name, platformId: name, detectStatus: text(sensor.detect_status), deviceStatus: text(rf.device_status),
      powerW: number(params.power_w), frequencyHz: number(params.freq_band_hz), rangeM: number(params.jammer_range_nm, 1852),
      position: { longitude: number(pos.lon), latitude: number(pos.lat), altitudeM: number(pos.alt_m) }, engineMode: text(rf.mode),
      detections: list(sensor.events).map(value => { const item = record(value), targetNames = texts(item.target_names); return {
        // 探测器该字段实际为 GHz；rf_jammer.active_params 同名字段仍为 Hz。
        targetNames, targetIds: [...targetNames], platformType: text(item.platform_type), frequencyHz: number(item.freq_band_hz, 1e9),
        probability: number(item.detect_prob), rangeM: number(item.detect_range_nm, 1852),
        targets: list(item.target_pos).map(value => { const target = record(value), pos = record(target.pos), name = text(target.name); return {
          name, platformId: name, longitude: number(pos.lon), latitude: number(pos.lat), altitudeM: number(pos.alt_m),
        } }),
      } }),
      actions: list(item.closed_loop).map(value => { const action = record(value), engineMode = text(action.jam_mode), targetName = text(action.jam_target_id); return {
        action: text(action.last_action), targetName, targetPlatformId: targetName, engineMode,
        mode: engineMode === 'broadband' ? 'BARRAGE' : engineMode === 'spot' ? 'SPOT' : engineMode === 'sweep' ? 'SWEEP' : null,
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
    links, jammers, initRouting: manager.init_routing_result == null ? null : routes(manager.init_routing_result, false),
    routing: { switches, alarms: [...list(manager.alarm), ...list(routing.alarm)].map(value => { const item = record(value); return {
      pathId: text(item.path_id) ?? text(item.pathid), linkId: text(item.link_id) ?? text(item.linkid), message: text(item.message),
    } }) },
    events: list(input.events).map(value => { const item = record(value), uavNames = texts(item.events_uav), jammerNames = texts(item.events_jammer); return {
      type: text(item.events_type), pathId: text(item.events_pathid), uavNames, jammerNames, uavIds: [...uavNames], jammerIds: [...jammerNames],
    } }),
  } }
}

/** 校验已归一化的 WS 载荷，不允许数字字符串或畸形嵌套越过前端信任边界。 */
export function isEngineFrameSnapshot(value: unknown): value is EngineFrameSnapshot {
  const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  const str = (v: unknown) => v === null || typeof v === 'string'
  const num = (v: unknown) => v === null || typeof v === 'number' && Number.isFinite(v)
  const array = (v: unknown, check: (v: unknown) => boolean) => Array.isArray(v) && v.every(check)
  const strings = (v: unknown) => array(v, v => typeof v === 'string')
  const fields = (v: unknown, names: string[], check: (v: unknown) => boolean) => obj(v) && names.every(key => Object.hasOwn(v, key) && check(v[key]))
  const optional = (v: unknown, key: string, check: (v: unknown) => boolean) => obj(v) && (!Object.hasOwn(v, key) || check(v[key]))
  const pathNodes = (v: unknown) => array(v, v => fields(v, ['platformName', 'platformId', 'inPort', 'outPort'], str))
  const path = (v: unknown) => obj(v) && typeof v.pathId === 'string' && v.pathId.length > 0 && typeof v.direction === 'string' && ['FORWARD', 'REVERSE'].includes(v.direction)
    && fields(v, ['sourceName', 'targetName', 'sourcePlatformId', 'targetPlatformId'], str) && strings(v.transTypes) && pathNodes(v.nodes)
    && optional(v, 'parameters', p => fields(p, ['delay', 'transFrequency', 'dataContent'], num))
  if (!obj(value) || value.kind !== 'ENGINE_FRAME' || typeof value.runId !== 'string' || !value.runId.trim()
    || typeof value.engineEpoch !== 'number' || !Number.isSafeInteger(value.engineEpoch) || value.engineEpoch < 0
    || typeof value.frameId !== 'number' || !Number.isSafeInteger(value.frameId) || value.frameId < 0
    || typeof value.simulationTime !== 'number' || !Number.isFinite(value.simulationTime) || value.simulationTime < 0
    || !str(value.modelVersion) || !str(value.modulation) || !optional(value, 'wallTimeMs', num)) return false
  return array(value.links, v => obj(v) && typeof v.linkId === 'string' && v.linkId.length > 0 && strings(v.linkIds)
    && fields(v, ['sourceName', 'sourcePlatformId', 'sourcePort', 'targetName', 'targetPlatformId', 'targetPort', 'engineStatus', 'error'], str)
    && typeof v.status === 'string' && ['UP', 'DEGRADED', 'DOWN', 'UNKNOWN'].includes(v.status) && num(v.distanceM)
    && fields(v.losses, ['freeSpaceDb', 'seaMultipathDb', 'atmosphericDb', 'cloudRainDb', 'jammingDb', 'totalDb'], num)
    && optional(v.losses, 'rainDb', num) && optional(v.losses, 'cloudDb', num)
    && fields(v.quality, ['gxbDb', 'ber', 'rxPowerDbw', 'rxPowerDbm'], num)
    && optional(v.quality, 'delay', num)
    && fields(v.inputTrace, ['eirpDbw', 'gtDbk', 'dataRateMbps', 'frequencyGHz'], num) && obj(v.inputTrace)
    && array(v.inputTrace.jammers, j => fields(j, ['jammerName', 'platformId'], str) && fields(j, ['distanceM', 'eirpDbw', 'lossDb'], num)))
    && array(value.jammers, v => obj(v) && fields(v, ['name', 'platformId', 'detectStatus', 'deviceStatus'], str) && fields(v, ['powerW', 'frequencyHz', 'rangeM'], num)
      && optional(v, 'engineMode', str) && optional(v, 'position', p => fields(p, ['longitude', 'latitude', 'altitudeM'], num))
      && array(v.detections, d => obj(d) && strings(d.targetNames) && strings(d.targetIds) && str(d.platformType) && fields(d, ['frequencyHz', 'probability', 'rangeM'], num)
        && array(d.targets, t => fields(t, ['name', 'platformId'], str) && fields(t, ['longitude', 'latitude', 'altitudeM'], num)))
      && array(v.actions, a => obj(a) && fields(a, ['action', 'targetName', 'targetPlatformId', 'engineMode'], str)
        && (a.mode === null || typeof a.mode === 'string' && ['BARRAGE', 'SPOT', 'SWEEP'].includes(a.mode))))
    && (value.initRouting === null || array(value.initRouting, path))
    && obj(value.routing) && array(value.routing.switches, s => obj(s) && path(s) && str(s.oldPathId) && pathNodes(s.oldNodes)
      && array(s.reasons, r => obj(r) && str(r.linkId) && strings(r.reasons)))
    && array(value.routing.alarms, a => fields(a, ['pathId', 'linkId', 'message'], str))
    && array(value.events, e => obj(e) && fields(e, ['type', 'pathId'], str) && ['uavNames', 'jammerNames', 'uavIds', 'jammerIds'].every(k => strings(e[k])))
}

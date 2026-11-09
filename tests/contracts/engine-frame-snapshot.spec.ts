// @vitest-environment node
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import sample from '../fixtures/engine-frame/params_check.json'
import emptyIds from '../fixtures/engine-frame/params_check.empty-ids.json'
import initial from '../fixtures/engine-frame/websocket-new/fream001.json'
import changed from '../fixtures/engine-frame/websocket-new/fream_chenge1.json'
import detected from '../fixtures/engine-frame/websocket-new/fream_chenge2.json'
import alarm from '../fixtures/engine-frame/websocket-new/fream_chenge3.json'
import { adaptEngineFrameSnapshot, isEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'
const { loadContractDocuments } = await import('../../scripts/contracts/contract-' + 'documents.js')
const ajv = new Ajv2020({ strict: false }); addFormats(ajv)
ajv.addSchema(loadContractDocuments().openApi, 'engine')
const validate = ajv.compile({ $ref: 'engine#/components/schemas/LinkMetricPayload' })
const adapt = (input: unknown = sample) => { const result = adaptEngineFrameSnapshot(input); expect(result.data).not.toBeNull(); return { ...result.data!, runId: 'RUN-ENGINE' } }

describe('引擎帧归一化及合同', () => {
  it.each([initial, changed, detected, alarm])('websocketNew 帧 $frame_id 保留帧号，毫秒只转换一次，新增字段通过合同', raw => {
    const frame = adapt(raw)
    expect(frame.frameId).toBe(raw.frame_id)
    expect(frame.simulationTime).toBeCloseTo(raw.sim_time_s / 1000, 10)
    expect(frame.wallTimeMs).toBe(raw.wall_time_ms)
    frame.links.forEach((link, index) => {
      const source = raw.link_calc.links[index]!
      expect(link.inputTrace.frequencyGHz).toBe(source.quality.input_trace.frequency_ghz)
      expect(link.losses).toMatchObject({ rainDb: source.losses.atten_rain_db, cloudDb: source.losses.atten_cloud_db, totalDb: source.losses.total_composite_db, cloudRainDb: null })
      expect(link.quality).toMatchObject({ delay: source.quality.delay, rxPowerDbw: null, rxPowerDbm: null })
    })
    expect(isEngineFrameSnapshot(frame)).toBe(true)
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true)
    expect(isEngineFrameSnapshot(JSON.parse(JSON.stringify(frame)))).toBe(true)
    expect(frame.simulationTime).toBeCloseTo(raw.sim_time_s / 1000, 10)
  })
  it('探测频率从 GHz 转 Hz，干扰机同名字段保持 Hz；不补造概率或启停事件', () => {
    const frame = adapt(detected)
    expect(frame.jammers[0]).toMatchObject({ position: { longitude: 121.55, latitude: 25.15, altitudeM: 0 }, engineMode: 'broadband',
      frequencyHz: 2400000000, detections: [{ frequencyHz: 2400000000, probability: null }], actions: [{ action: 'JAM_ON' }] })
    expect(frame.events.map(event => event.type)).toEqual(['into_jamm', 'esm_info'])
    const again = adapt({ ...detected, frame_id: detected.frame_id + 1, events: [] })
    expect(again.jammers[0]!.actions[0]!.action).toBe('JAM_ON')
    expect(again.events).toEqual([])
    expect(adapt(alarm).jammers).toEqual([])
  })
  it('从 path_params 读取业务与原始路径参数，未提供的旧路径保持空', () => {
    const frame = adapt(initial), route = initial.link_manager.init_routing_result.forward[0]!
    expect(frame.initRouting![0]).toMatchObject({ transTypes: route.path_params.trans_type,
      parameters: { delay: route.path_params.delay, transFrequency: 10, dataContent: 102 } })
    expect(adapt(changed).routing.switches[0]).toMatchObject({ transTypes: ['kForwardSituation', 'kForwardTarget'], oldNodes: [], parameters: { transFrequency: 10, dataContent: 64 } })
  })
  it('缺少新增可选字段的旧归档仍有效且保持秒值，畸形新字段被拒绝', () => {
    const old = adapt(detected)
    delete old.wallTimeMs
    old.links.forEach(link => { delete link.losses.rainDb; delete link.losses.cloudDb; delete link.quality.delay })
    old.jammers.forEach(jammer => { delete jammer.position; delete jammer.engineMode })
    old.simulationTime = 350.625
    expect(isEngineFrameSnapshot(old)).toBe(true); expect(validate(old)).toBe(true)
    expect(old.simulationTime).toBe(350.625)
    const cases: Array<(value: any) => void> = [
      value => { value.wallTimeMs = '1' }, value => { value.links[0].losses.rainDb = '1' },
      value => { value.links[0].quality.delay = {} }, value => { value.jammers[0].position.longitude = '121.55' },
      value => { value.jammers[0].engineMode = [] }, value => { value.initRouting = [{ ...adapt(initial).initRouting![0], parameters: { delay: 1 } }] },
    ]
    for (const mutate of cases) { const frame = adapt(detected); mutate(frame); expect(isEngineFrameSnapshot(frame)).toBe(false); expect(validate(frame)).toBe(false) }
  })
  it('严格 JSON 夹具保留数字字符串，归一化单位后通过运行时和 OpenAPI', () => {
    const frame = adapt()
    expect(frame.engineEpoch).toBe(0)
    expect(frame.links[0]).toMatchObject({ status: 'UP', distanceM: 120500, quality: { rxPowerDbw: -112.3, rxPowerDbm: -82.3 },
      inputTrace: { frequencyGHz: 4.5, jammers: [{ distanceM: 18300 }, { distanceM: 18300 }] } })
    expect(frame.links[0]!.inputTrace.dataRateMbps).toBeCloseTo(1.6)
    expect(frame.jammers[0]).toMatchObject({ rangeM: 111120, detections: [{ rangeM: 111120, probability: 0.92 }], actions: [{ mode: 'BARRAGE' }, { mode: 'BARRAGE' }] })
    expect(isEngineFrameSnapshot(frame)).toBe(true)
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true)
  })
  it('空 ID 按端点与端口、路径节点生成稳定备用身份；不合并不同路径', () => {
    const frame = adapt(emptyIds)
    expect(frame.links[0]!.linkId).toBe(JSON.stringify(['UAV1', 'sat_link_a', 'shentong_sat', 'sat_link']))
    expect(frame.initRouting![0]!.pathId).toContain('rear')
    expect(frame.routing.switches[0]!.pathId).not.toBe(frame.routing.switches[1]!.pathId)
    expect(frame.routing.switches[0]!.oldPathId).toBeNull()
    expect(frame.routing.switches[1]!.oldNodes).toHaveLength(3)
    expect(isEngineFrameSnapshot(frame)).toBe(true)
  })
  it.each(['reason_change', 'reason_chenge', 'ln_chenge'])('兼容 %s 和 pathid，原因与业务类型不限定枚举', key => {
    const raw: any = structuredClone(sample)
    const route = raw.link_manager.routing_result.forward[0]
    route.pathid = 'alternate-id'; delete route.path_id; delete route.reason_chenge
    route[key] = [{ linkid: 'segment-1', reason: ['引擎自定义原因'] }]; route.trans_type = ['新业务']
    expect(adapt(raw).routing.switches[0]).toMatchObject({ pathId: 'alternate-id', transTypes: ['新业务'], reasons: [{ linkId: 'segment-1', reasons: ['引擎自定义原因'] }] })
  })
  it.each([['AVAILABLE','UP'],['RISK','DEGRADED'],['INVALID','DOWN'],['other','UNKNOWN']])('状态 %s 直接映射为 %s', (status, result) => {
    const raw = structuredClone(sample); raw.link_calc.links[0]!.status = status
    expect(adapt(raw).links[0]!.status).toBe(result)
  })
  it.each([['broadband','BARRAGE'],['spot','SPOT'],['sweep','SWEEP'],['other',null]])('干扰模式 %s 映射为 %s', (mode, result) => {
    const raw = structuredClone(sample); raw.jammer_params[0]!.closed_loop[0]!.jam_mode = mode!
    expect(adapt(raw).jammers[0]!.actions[0]!.mode).toBe(result)
  })
  it('单段报错和缺测不影响其他链路，缺少可选消息块仍可用', () => {
    const bad = { ...sample.link_calc.links[0], quality: { error_msg: '模型输入缺失' }, status: 'INVALID' }
    const frame = adapt({ frame_id: '0', sim_time_s: '0', link_calc: { links: [bad, sample.link_calc.links[0]] } })
    expect(frame.links[0]).toMatchObject({ error: '模型输入缺失', status: 'DOWN', quality: { gxbDb: null, ber: null, rxPowerDbm: null } })
    expect(frame.links[1]!.quality.gxbDb).toBe(9.5)
    expect(frame).toMatchObject({ jammers: [], events: [], initRouting: null, routing: { switches: [], alarms: [] } })
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true)
  })
  it.each([{ frame_id: undefined }, { frame_id: -1 }, { frame_id: 1.5 }, { frame_id: '' }, { sim_time_s: undefined }, { sim_time_s: Infinity }, { link_calc: {} }])('必要帧头不合法拒绝并定位 %j', change => {
    const result = adaptEngineFrameSnapshot({ ...sample, ...change })
    expect(result.data).toBeNull(); if (!result.data) expect(result.errors[0]!.fieldPath).toMatch(/frame_id|sim_time_s|link_calc.links/)
  })
  it.each([undefined, null, -1, 0.5, '0', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('运行时和 OpenAPI 拒绝非法 engineEpoch：%s', engineEpoch => {
    const frame = { ...adapt(), engineEpoch }
    expect(isEngineFrameSnapshot(frame)).toBe(false)
    expect(validate(frame)).toBe(false)
  })
  it('engineEpoch 必填且由服务端赋值，不采信上游同名字段', () => {
    const frame: any = adapt({ ...sample, engineEpoch: 99 })
    expect(frame.engineEpoch).toBe(0)
    frame.engineEpoch = 1
    expect(isEngineFrameSnapshot(frame)).toBe(true); expect(validate(frame)).toBe(true)
    delete frame.engineEpoch
    expect(isEngineFrameSnapshot(frame)).toBe(false); expect(validate(frame)).toBe(false)
  })
  it('归一化载荷拒绝数组枚举、非有限值及缺失嵌套字段', () => {
    const frame: any = adapt()
    frame.initRouting[0].direction = ['FORWARD']
    expect(isEngineFrameSnapshot(frame)).toBe(false); expect(validate(frame)).toBe(false)
    frame.initRouting = null; frame.links[0].quality.ber = '0.1'
    expect(isEngineFrameSnapshot(frame)).toBe(false); expect(validate(frame)).toBe(false)
    frame.links[0].quality.ber = NaN; expect(isEngineFrameSnapshot(frame)).toBe(false)
    delete frame.links[0].quality; expect(isEngineFrameSnapshot(frame)).toBe(false)
  })
})

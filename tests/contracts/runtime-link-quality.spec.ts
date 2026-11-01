import { describe, expect, it } from 'vitest'
import { adaptRuntimeLinkQuality } from '../../src/features/data-exchange/runtime-link-quality'

// 仅用于适配测试，取自资料中结构明确的 link_calc；不是运行数据或正式报文夹具。
function sample() {
  return {
    model_version: '1.0.0', modulation: 'BPSK', invalid_param_errors: [],
    links: [{
      link_id: 'sat_link_a', tx_platform: 'UAV1', rx_platform: 'shentong_sat', tx_port: 'sat_link_a', rx_port: 'sat_link',
      distance_km: 120.5,
      losses: { free_space_db: 145.2, sea_multipath_db: 2.1, atmospheric_db: 0.3, cloud_rain_db: 0, jamming_loss_db: 4.8, total_composite_db: 152.4 },
      quality: {
        gxb_db: 9.5, ber: 1.2e-7, rx_power_dbw: -112.3,
        input_trace: { eirp_dbw: 40, g_over_t_dbk: -5, data_rate_bps: 1.6e6, jammers: ['jammer_01'] },
        model_version: '1.0.0', modulation: 'BPSK', error_msg: '',
      },
      status: { state: 'DEGRADED', thresholds: { gxb_db: 6, ber_switch: 1e-5, ber_degrade: 1e-4 }, jitter_suppressed: true },
    }],
  }
}

function setLinkField(value: ReturnType<typeof sample>, field: string, replacement: unknown) {
  const keys = field.split('.')
  let target = value.links[0] as Record<string, any>
  for (const key of keys.slice(0, -1)) target = target[key]
  target[keys[keys.length - 1]!] = replacement
}

describe('后台 link_calc 质量字段适配', () => {
  it('保留原始设备身份、五分量与来源版本，准确换算单位且不补 SNR 或状态', () => {
    const source = sample()
    const before = structuredClone(source)
    const result = adaptRuntimeLinkQuality(source)
    expect(result.errors).toEqual([])
    expect(result.data).toMatchObject({ modelVersion: '1.0.0', modulation: 'BPSK' })
    expect(result.data?.links).toHaveLength(1)
    const link = result.data!.links[0]!
    expect(link).toEqual({
      linkId: 'sat_link_a', sourcePlatformId: 'UAV1', destinationPlatformId: 'shentong_sat', sourcePortId: 'sat_link_a', destinationPortId: 'sat_link',
      distanceMeters: 120500,
      losses: { freeSpaceLossDb: 145.2, seaMultipathLossDb: 2.1, atmosphericLossDb: 0.3, cloudRainLossDb: 0, jammingLossDb: 4.8, totalLossDb: 152.4 },
      quality: {
        gxbDb: 9.5, snrDb: null, ber: 1.2e-7, receivedPowerDbm: -82.3, interferencePowerDbm: null, modelVersion: '1.0.0', modulation: 'BPSK',
        inputTrace: { eirpDbw: 40, gOverTDbK: -5, dataRateMbps: 1.6, jammerIds: ['jammer_01'] },
      },
    })
    expect(link).not.toHaveProperty('canonicalStatus')
    expect(link).not.toHaveProperty('status')
    expect(link.losses).not.toHaveProperty('systemLossDb')
    expect(link.losses).not.toHaveProperty('obstructionLossDb')
    expect(source).toEqual(before)
    link.quality.inputTrace.jammerIds!.push('later')
    expect(source.links[0]!.quality.input_trace.jammers).toEqual(['jammer_01'])
  })

  it('缺失或 null 的测量保持未知，不继承全局值，不写入 0、默认模型或编码', () => {
    const source = sample()
    const result = adaptRuntimeLinkQuality({ model_version: 'global-model', modulation: 'QPSK', links: [{
      link_id: source.links[0]!.link_id, tx_platform: 'UAV1', rx_platform: 'shentong_sat', tx_port: 'sat_link_a', rx_port: 'sat_link',
      distance_km: null, losses: { free_space_db: null }, quality: { input_trace: null, ber: null },
    }] })
    expect(result.errors).toEqual([])
    const link = result.data!.links[0]!
    expect(link.distanceMeters).toBeNull()
    expect(Object.values(link.losses).every(value => value === null)).toBe(true)
    expect(link.quality).toEqual({
      gxbDb: null, snrDb: null, ber: null, receivedPowerDbm: null, interferencePowerDbm: null, modelVersion: null, modulation: null,
      inputTrace: { eirpDbw: null, gOverTDbK: null, dataRateMbps: null, jammerIds: null },
    })
    expect(link.quality).not.toHaveProperty('coding')
    expect(adaptRuntimeLinkQuality({ links: [{ link_id: 'L', tx_platform: 'A', rx_platform: 'B', tx_port: 'a', rx_port: 'b' }] }).data?.links[0]!.quality).toEqual(link.quality)
    expect(adaptRuntimeLinkQuality({ links: [] })).toEqual({ data: { modelVersion: null, modulation: null, links: [] }, errors: [] })
  })

  it('全局与逐链路版本/调制分别保留，不推断优先级或固定版本', () => {
    const source = sample()
    source.links[0]!.quality.model_version = 'engine-model-2'
    source.links[0]!.quality.modulation = 'QPSK'
    const result = adaptRuntimeLinkQuality(source)
    expect(result.errors).toEqual([])
    expect(result.data).toMatchObject({ modelVersion: '1.0.0', modulation: 'BPSK', links: [{ quality: { modelVersion: 'engine-model-2', modulation: 'QPSK' } }] })
  })

  it.each(['BPSK', 'QPSK', 'OOK'])('沿用现有已支持调制 %s，未提供的其他指标仍为空', mode => {
    expect(adaptRuntimeLinkQuality({ modulation: mode, links: [] }).data?.modulation).toBe(mode)
  })

  it('0 和边界比率有效；负 dBW、GXB、dB 输入不会被当作负线性功率', () => {
    const source = sample()
    source.links[0]!.distance_km = 0
    source.links[0]!.quality.ber = 0
    source.links[0]!.quality.gxb_db = -9
    source.links[0]!.losses.sea_multipath_db = -2
    source.links[0]!.quality.input_trace.data_rate_bps = 0
    const result = adaptRuntimeLinkQuality(source)
    expect(result.errors).toEqual([])
    expect(result.data!.links[0]).toMatchObject({ distanceMeters: 0, losses: { seaMultipathLossDb: -2 }, quality: { gxbDb: -9, ber: 0, receivedPowerDbm: -82.3, inputTrace: { dataRateMbps: 0 } } })
    source.links[0]!.quality.ber = 1
    expect(adaptRuntimeLinkQuality(source).errors).toEqual([])
  })

  it('相同链路名的反向和其他端口保留；完整有向身份重复时整批拒绝', () => {
    const source = sample()
    const link = source.links[0]!
    source.links.push({ ...structuredClone(link), tx_platform: link.rx_platform, rx_platform: link.tx_platform, tx_port: link.rx_port, rx_port: link.tx_port })
    source.links.push({ ...structuredClone(link), tx_port: 'another_device' })
    expect(adaptRuntimeLinkQuality(source).data?.links).toHaveLength(3)
    source.links.push(structuredClone(link))
    expect(adaptRuntimeLinkQuality(source)).toMatchObject({ data: null, errors: [{ code: 'RUNTIME_QUALITY_DUPLICATE', fieldPath: 'link_calc.links[3]' }] })
  })

  it.each(['link_id', 'tx_platform', 'rx_platform', 'tx_port', 'rx_port'])('身份 %s 缺失、空白或数组时拒绝，不按 BER 猜链路', field => {
    for (const replacement of [undefined, null, '', '  ', ['UAV1']]) {
      const source = sample()
      setLinkField(source, field, replacement)
      expect(adaptRuntimeLinkQuality(source)).toMatchObject({ data: null, errors: [{ code: 'RUNTIME_QUALITY_IDENTITY_REQUIRED', fieldPath: `link_calc.links[0].${field}` }] })
    }
  })

  it.each([
    ['distance_km', -1], ['distance_km', NaN], ['distance_km', Number.MAX_VALUE],
    ['quality.ber', -0.01], ['quality.ber', 1.01], ['quality.ber', Infinity],
    ['quality.gxb_db', NaN], ['quality.rx_power_dbw', -Infinity],
    ['quality.input_trace.data_rate_bps', -1], ['quality.input_trace.data_rate_bps', Infinity],
    ['quality.input_trace.eirp_dbw', NaN], ['quality.input_trace.g_over_t_dbk', Infinity],
    ['losses.free_space_db', NaN], ['losses.sea_multipath_db', Infinity], ['losses.atmospheric_db', -Infinity],
    ['losses.cloud_rain_db', NaN], ['losses.jamming_loss_db', Infinity], ['losses.total_composite_db', NaN],
    ['distance_km', '120.5'], ['quality.ber', ''], ['quality.gxb_db', [9.5]], ['quality.rx_power_dbw', false],
  ])('非法数值 %s=%s 返回原字段路径且不保留其他成功行', (field, replacement) => {
    const source = sample()
    setLinkField(source, field as string, replacement)
    source.links.unshift(structuredClone(sample().links[0]!))
    source.links[0]!.link_id = 'valid_other_link'
    const result = adaptRuntimeLinkQuality(source)
    expect(result.data).toBeNull()
    expect(result.errors).toEqual([expect.objectContaining({ severity: 'ERROR', fieldPath: `link_calc.links[1].${field}` })])
    expect(result.errors[0]!.message).not.toBe('')
  })

  it.each([null, [], 'not parsed', 42])('非对象输入 %s 明确拒绝，不擅自修复或解析原 TXT', value => {
    expect(adaptRuntimeLinkQuality(value)).toMatchObject({ data: null, errors: [{ code: 'RUNTIME_QUALITY_TYPE_INVALID', fieldPath: 'link_calc' }] })
  })

  it.each([undefined, null, {}, '[]'])('非法 links 集合 %s 被拒绝', links => {
    expect(adaptRuntimeLinkQuality({ links })).toMatchObject({ data: null, errors: [{ code: 'RUNTIME_QUALITY_TYPE_INVALID', fieldPath: 'link_calc.links' }] })
  })

  it.each([
    ['losses', []], ['quality', false], ['quality.input_trace', 'trace'],
    ['quality.model_version', ' '], ['quality.model_version', ['1.0.0']], ['quality.error_msg', {}],
    ['quality.modulation', '16QAM'], ['quality.modulation', ['BPSK']], ['quality.modulation', ''],
    ['quality.input_trace.jammers', 'jammer_01'], ['quality.input_trace.jammers', ['']],
    ['quality.input_trace.jammers', [['jammer_01']]], ['quality.input_trace.jammers', ['jammer_01', 'jammer_01']],
  ])('嵌套字段 %s 非法时给出可定位错误', (field, replacement) => {
    const source = sample()
    setLinkField(source, field as string, replacement)
    const result = adaptRuntimeLinkQuality(source)
    expect(result.data).toBeNull()
    expect(result.errors[0]!.fieldPath).toBe(`link_calc.links[0].${field}${field === 'quality.input_trace.jammers' && Array.isArray(replacement) ? `[${replacement.length - 1}]` : ''}`)
  })

  it('缺省容器和空干扰源集合区分未知与确实为空，不共享前次结果', () => {
    const source = sample()
    source.links[0]!.quality.input_trace.jammers = []
    expect(adaptRuntimeLinkQuality(source).data!.links[0]!.quality.inputTrace.jammerIds).toEqual([])
    setLinkField(source, 'losses', null)
    setLinkField(source, 'quality', null)
    const result = adaptRuntimeLinkQuality(source)
    expect(result.errors).toEqual([])
    expect(Object.values(result.data!.links[0]!.losses).every(value => value === null)).toBe(true)
    expect(result.data!.links[0]!.quality.inputTrace.jammerIds).toBeNull()
    expect(result.data!.links[0]!.quality.ber).toBeNull()
  })

  it('后台错误非空时不返回质量成功，错误路径和原始原因保留', () => {
    const source = sample()
    source.links[0]!.quality.error_msg = '发射参数无效'
    expect(adaptRuntimeLinkQuality(source)).toMatchObject({ data: null, errors: [{ code: 'RUNTIME_QUALITY_ENGINE_ERROR', fieldPath: 'link_calc.links[0].quality.error_msg', message: '后台报告链路质量计算错误：发射参数无效' }] })
    const result = adaptRuntimeLinkQuality({ ...sample(), invalid_param_errors: [{ unconfirmed_error_format: true }] })
    expect(result).toMatchObject({ data: null, errors: [{ code: 'RUNTIME_QUALITY_ENGINE_ERROR', fieldPath: 'link_calc.invalid_param_errors' }] })
  })

  it.each([
    { links: [null] }, { links: [[]] }, { links: ['link'] },
    { links: [], model_version: '' }, { links: [], model_version: 1 },
    { links: [], modulation: 'OTHER' }, { links: [], invalid_param_errors: false },
  ])('非法集合成员或全局元数据整批拒绝 %#', value => {
    const result = adaptRuntimeLinkQuality(value)
    expect(result.data).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.fieldPath).toMatch(/^link_calc\./)
  })

  it('仅投影明确质量字段，不透传未知扩展、状态或其他模块，也不按全局模型制造溯源', () => {
    const source = sample()
    const result = adaptRuntimeLinkQuality({ ...source, jammer_sensor: { rf_jammer: { device_status: 'ON' } }, links: [{
      ...source.links[0], quality: { ...source.links[0]!.quality, snr_db: 99, coding: 'UNCODED', thresholdVersion: 'LLZT-1.0' },
      status: { state: 'INTERRUPTED', canonicalStatus: 'DOWN' },
    }] })
    expect(result.errors).toEqual([])
    expect(result.data).not.toHaveProperty('jammer_sensor')
    expect(result.data!.links[0]!.quality.snrDb).toBeNull()
    expect(result.data!.links[0]!.quality).not.toHaveProperty('coding')
    expect(result.data!.links[0]).not.toHaveProperty('canonicalStatus')
    expect(result.data!.links[0]).not.toHaveProperty('status')
  })
})

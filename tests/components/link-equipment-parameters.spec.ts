import { describe, expect, it } from 'vitest'
import type { EquipmentParameter, Link, Platform } from '../../src/contracts/domain-models'
import { equipmentLinkIssues } from '../../src/features/admin/equipment-link-rules'
import { equipmentDataRateOptions, prepareLinkEquipment } from '../../src/features/scenarios/link-equipment-parameters'
import { datalinkRateTiers } from '../../src/features/scenarios/link-calc-defaults'

function link(change: Partial<Link> = {}): Link {
  return {
    id: 'L-1', type: 'DATALINK', sourcePlatformId: 'P-1', targetPlatformId: 'P-2', frequency: 150,
    bandwidth: 10, txPower: 20, antennaGain: { tx: 1, rx: 2 }, modulation: 'BPSK', berThreshold: 0.01,
    dataRate: 2, direction: 'FORWARD', band: 'C', ...change,
  }
}

function equipment(change: Partial<EquipmentParameter> = {}): EquipmentParameter {
  return {
    equipmentId: 'EQ-1', type: '数传通信设备', frequencyMinMHz: 100, frequencyMaxMHz: 200,
    modulation: 'QPSK', berThreshold: 0.001, bandwidthMHz: 5, txPowerW: 0, dataRateMbps: 2,
    active: true, readOnly: false, version: 1, ...change,
  }
}

describe('装备参数预填链路', () => {
  it('设备速率复用微波、卫星固定值，数传列出所有既有档位并保留目标方向校验', () => {
    expect(equipmentDataRateOptions('微波通信设备')).toEqual([{ value: 80, label: '80 Mbps' }])
    expect(equipmentDataRateOptions('卫星通信设备')).toEqual([
      { value: 0.016, label: '16 kbps（天通）' }, { value: 16, label: '16 Mbps（神通）' },
    ])
    const options = equipmentDataRateOptions('数传通信设备')!
    expect(options.map(option => option.value)).toEqual([0.0064, 0.0128, 0.0256, 0.0512, 2, 4, 8, 16])
    for (const band of ['C', 'L'] as const) {
      for (const direction of ['FORWARD', 'REVERSE'] as const) {
        for (const option of options) {
          const allowed = datalinkRateTiers(band, direction).includes(option.value)
          expect(option.label.includes(`${band} 波段${direction === 'FORWARD' ? '前向' : '返向'}`)).toBe(allowed)
          expect(prepareLinkEquipment(link({ band, direction }), equipment({ type: '数传通信设备', dataRateMbps: option.value }), []).ok).toBe(allowed)
        }
      }
    }
    for (const type of ['光纤通信设备', '激光通信设备', '原有设备']) expect(equipmentDataRateOptions(type)).toBeNull()
  })

  it('在当前频率可用时仅复制通用已配置参数，并保留零功率', () => {
    const original = link()
    const result = prepareLinkEquipment(original, equipment(), [])

    expect(result).toMatchObject({ ok: true, fields: ['bandwidth', 'txPower', 'dataRate', 'modulation', 'berThreshold'], link: {
      bandwidth: 5, txPower: 0, dataRate: 2, modulation: 'QPSK', berThreshold: 0.001,
      type: 'DATALINK', sourcePlatformId: 'P-1', targetPlatformId: 'P-2', frequency: 150, antennaGain: { tx: 1, rx: 2 },
    } })
    expect(original).toMatchObject({ bandwidth: 10, txPower: 20, modulation: 'BPSK', berThreshold: 0.01 })
    if (result.ok) {
      result.link.antennaGain.tx = 99
      expect(original.antennaGain.tx).toBe(1)
    }
  })

  it('不改选频且拒绝越界频率、停用和只读装备', () => {
    expect(prepareLinkEquipment(link({ frequency: 201 }), equipment(), [])).toMatchObject({ ok: false, fieldPath: 'frequency' })
    expect(prepareLinkEquipment(link(), equipment({ active: false }), [])).toMatchObject({ ok: false, fieldPath: 'active' })
    expect(prepareLinkEquipment(link(), equipment({ readOnly: true }), [])).toMatchObject({ ok: false, fieldPath: 'readOnly' })
  })

  it('空值不覆盖且拒绝不兼容的调制、固定速率和数传档位', () => {
    const empty = prepareLinkEquipment(link(), equipment({ bandwidthMHz: null, txPowerW: null, dataRateMbps: null, modulation: null, berThreshold: null }), [])
    expect(empty).toMatchObject({ ok: true, fields: [], link: { bandwidth: 10, txPower: 20, dataRate: 2, modulation: 'BPSK', berThreshold: 0.01 } })
    expect(prepareLinkEquipment(link(), equipment({ modulation: '16QAM' }), [])).toMatchObject({ ok: false, fieldPath: 'modulation' })
    expect(prepareLinkEquipment(link({ type: 'MICROWAVE' }), equipment({ type: '微波通信设备', dataRateMbps: 2 }), [])).toMatchObject({ ok: false, fieldPath: 'dataRateMbps' })
    expect(prepareLinkEquipment(link({ type: 'MICROWAVE' }), equipment({ type: '微波通信设备', txPowerW: 101, dataRateMbps: null }), [])).toMatchObject({ ok: false, fieldPath: 'txPowerW' })
    expect(prepareLinkEquipment(link({ band: 'L' }), equipment({ dataRateMbps: 2 }), [])).toMatchObject({ ok: false, fieldPath: 'dataRate' })
  })

  it('按现有光纤范围和激光规则处理数据速率与调制', () => {
    expect(prepareLinkEquipment(link({ type: 'FIBER' }), equipment({ type: '光纤通信设备', dataRateMbps: 8 }), [])).toMatchObject({ ok: false, fieldPath: 'dataRateMbps' })
    const laser = prepareLinkEquipment(link({ type: 'LASER' }), equipment({ type: '激光通信设备', modulation: 'OOK', txPowerW: 1, dataRateMbps: 3 }), [])
    expect(laser).toMatchObject({ ok: true, fields: expect.not.arrayContaining(['modulation']), link: { modulation: 'BPSK', dataRate: 3 } })
  })

  it.each([
    { satelliteType: 'TIANTONG', rate: 0.016, invalidRate: 16 },
    { satelliteType: 'SHENTONG', rate: 16, invalidRate: 0.016 },
  ] as const)('按 $satelliteType 核对固定速率，并不修改输入平台', ({ satelliteType, rate, invalidRate }) => {
    const platforms: Platform[] = [{ id: 'P-1', name: '通信卫星', type: 'COMMUNICATION_SATELLITE', category: 'space', satelliteType,
      initialPosition: { longitude: 0, latitude: 0, altitude: 0 }, waypoints: [], linkIds: [], sensorIds: [], jammerIds: [] }]
    const result = prepareLinkEquipment(link({ type: 'SAT', dataRate: rate }), equipment({ type: '卫星通信设备', dataRateMbps: rate }), platforms)
    expect(result).toMatchObject({ ok: true, link: { dataRate: rate } })
    expect(prepareLinkEquipment(link({ type: 'SAT', dataRate: rate }), equipment({ type: '卫星通信设备', dataRateMbps: invalidRate }), platforms)).toMatchObject({ ok: false, fieldPath: 'dataRate' })
    expect(platforms[0]!.satelliteType).toBe(satelliteType)
  })

  it('在纯预填入口拒绝类型不匹配或未知的新增来源，且不改写原链路', () => {
    const original = link()
    const before = structuredClone(original)
    expect(prepareLinkEquipment(original, equipment({ type: '微波通信设备' }), [])).toMatchObject({ ok: false, fieldPath: 'type' })
    expect(prepareLinkEquipment(original, equipment({ type: '遗留通信设备' }), [])).toMatchObject({ ok: false, fieldPath: 'type' })
    expect(original).toEqual(before)
  })

  it('仅在历史回显时兼容未知装备来源，不猜测或改写其原始值', () => {
    const original = link()
    for (const type of ['遗留通信设备', 'constructor']) {
      const legacy = equipment({ type, modulation: 'QPSK', bandwidthMHz: 5, txPowerW: 20, dataRateMbps: 2, berThreshold: 0.1 })
      expect(prepareLinkEquipment(original, legacy, [])).toMatchObject({ ok: false, fieldPath: 'type' })
      const result = prepareLinkEquipment(original, legacy, [], true)
      expect(result).toMatchObject({ ok: true, fields: ['bandwidth', 'txPower', 'dataRate', 'modulation', 'berThreshold'] })
      expect(original).toEqual(link())
      expect(legacy).toMatchObject({ modulation: 'QPSK', bandwidthMHz: 5, txPowerW: 20, dataRateMbps: 2, berThreshold: 0.1 })
    }
  })

  it.each([
    [{ frequencyMinMHz: 0 }, 'frequencyMinMHz'],
    [{ frequencyMaxMHz: -1 }, 'frequencyMaxMHz'],
    [{ frequencyMinMHz: 100, frequencyMaxMHz: null }, 'frequencyMaxMHz'],
    [{ frequencyMinMHz: 200, frequencyMaxMHz: 100 }, 'frequencyMaxMHz'],
    [{ bandwidthMHz: 0 }, 'bandwidthMHz'],
    [{ bandwidthMHz: Number.POSITIVE_INFINITY }, 'bandwidthMHz'],
    [{ txPowerW: -1 }, 'txPowerW'],
    [{ txPowerW: 101 }, 'txPowerW'],
    [{ modulation: 'OOK' }, 'modulation'],
    [{ dataRateMbps: 1 }, 'dataRateMbps'],
    [{ berThreshold: -0.1 }, 'berThreshold'],
    [{ berThreshold: 1.1 }, 'berThreshold'],
  ] as const)('拒绝设备参数 %j，且不静默夹改旧值', (change, fieldPath) => {
    const original = link()
    const source = equipment(change)
    expect(equipmentLinkIssues(source)).toHaveProperty(fieldPath)
    expect(prepareLinkEquipment(original, source, [])).toMatchObject({ ok: false })
    expect(original).toEqual(link())
    expect(source).toMatchObject(change)
  })

  it('接受边界内的卫星参数，包括超过旧控件上限的 12000 MHz', () => {
    const platforms: Platform[] = [{ id: 'P-1', name: '通信卫星', type: 'COMMUNICATION_SATELLITE', category: 'space', satelliteType: 'SHENTONG',
      initialPosition: { longitude: 0, latitude: 0, altitude: 0 }, waypoints: [], linkIds: [], sensorIds: [], jammerIds: [] }]
    expect(prepareLinkEquipment(link({ type: 'SAT', frequency: 12000, dataRate: 16 }), equipment({ type: '卫星通信设备', frequencyMinMHz: 12000, frequencyMaxMHz: 12000, bandwidthMHz: 1001, txPowerW: 1000, dataRateMbps: 16, berThreshold: 1 }), platforms))
      .toMatchObject({ ok: true, link: { frequency: 12000, bandwidth: 1001, txPower: 1000, dataRate: 16, berThreshold: 1 } })
  })
})

import { describe, expect, it } from 'vitest'
import type { Environment, Platform } from '../../src/contracts/domain-models'
import {
  datalinkRateTiers, fixedLinkDataRate, LASER_LINK_DEFAULTS, linkTypeDefaults, readLinkCalcSettings, readNaturalEnvironment,
} from '../../src/features/scenarios/link-calc-defaults'

describe('《与前端字段确认说明》默认值', () => {
  it('link_calc 阈值与编码缺省为 1e-5 / 1e-6 / 1e-7、30 km、无编码，显式值优先', () => {
    expect(readLinkCalcSettings(undefined)).toEqual({ emergencyThreshold: 1e-5, warningThreshold: 1e-6, valueThresholdBer: 1e-7,
      jammingRangeKm: 30, channelEncodingScheme: 0, updateIntervalS: 5 })
    expect(readLinkCalcSettings({ channelEncodingScheme: -1 }).channelEncodingScheme).toBe(-1)
  })

  it('环境参数缺省按文档补齐，不覆盖已有字段', () => {
    const environment: Environment = { seaState: 3, rainRateMmPerHour: 10,
      multipathEnabled: true, seaModel: 'fine' }
    expect(readNaturalEnvironment(environment)).toMatchObject({ rainEnabled: true, rainAltitudeLimitM: 3000, atmosphereModel: 'itu',
      simplifiedAttenuationDbPerKm: 0, seaLowAltitudeThresholdM: 100, seaPathOverSeaThresholdKm: 30, seaModel: 'fine',
      seaPolarization: 'vertical', seaWaterTempC: 20, seaSurfaceRoughnessM: 0 })
  })

  it('端口默认值按链路类型、数传波段与方向区分', () => {
    expect(linkTypeDefaults('SAT')).toMatchObject({ frequency: 200, bandwidth: 20, rxBandwidth: 50, txPower: 100, antennaGain: { tx: 25, rx: 25 } })
    expect(linkTypeDefaults('MICROWAVE')).toMatchObject({ frequency: 8200, bandwidth: 30, rxBandwidth: 50, txPower: 20, txPolarization: 'horizontal' })
    expect(linkTypeDefaults('DATALINK', 'C', 'FORWARD')).toMatchObject({ frequency: 4500, bandwidth: 10, txPower: 20, dataRate: 2 })
    expect(linkTypeDefaults('DATALINK', 'C', 'REVERSE')).toMatchObject({ frequency: 4000, bandwidth: 20, txPower: 30, dataRate: 8 })
    expect(linkTypeDefaults('DATALINK', 'L', 'FORWARD')).toMatchObject({ frequency: 1500, bandwidth: 5, txPower: 10, dataRate: 0.0128 })
    expect(linkTypeDefaults('DATALINK', 'L', 'REVERSE')).toMatchObject({ frequency: 1300, bandwidth: 10, txPower: 15, dataRate: 0.0128 })
    expect(linkTypeDefaults('FIBER')).toMatchObject({ frequency: 1300, dataRate: 100 })
    expect(datalinkRateTiers('C', 'FORWARD')).toEqual([0.0256, 2, 4])
    expect(datalinkRateTiers('C', 'REVERSE')).toEqual([0.0512, 2, 4, 8, 16])
    expect(datalinkRateTiers('L', 'FORWARD')).toEqual([0.0064, 0.0128, 1])
    expect(datalinkRateTiers('L', 'REVERSE')).toEqual([0.0128, 0.0256, 2, 4, 8])
  })

  it('卫星与微波速率固定，天通卫星为 16 kbit/s', () => {
    const satellite = { id: 'SAT-01', type: 'COMMUNICATION_SATELLITE', satelliteType: 'TIANTONG' } as Platform
    const link = { type: 'SAT' as const, sourcePlatformId: 'CMD-01', targetPlatformId: 'SAT-01', relayPlatformId: null }
    expect(fixedLinkDataRate(link, [satellite])).toBe(0.016)
    expect(fixedLinkDataRate(link, [{ ...satellite, satelliteType: 'SHENTONG' }])).toBe(16)
    expect(fixedLinkDataRate({ ...link, type: 'MICROWAVE' }, [])).toBe(80)
    expect(fixedLinkDataRate({ ...link, type: 'DATALINK' }, [])).toBeNull()
  })

  it('激光缺省采用最新 lazer_link 参数集：发射 193500 GHz、接收 681300 GHz、带宽 1000、功率 0.1、速率 2500、收发增益 45', () => {
    expect(LASER_LINK_DEFAULTS.frequency).toBe(193_500_000)
    expect(LASER_LINK_DEFAULTS.rxFrequency).toBe(681_300_000)
    expect(LASER_LINK_DEFAULTS.frequency / 1000).toBe(193_500)
    expect(LASER_LINK_DEFAULTS.bandwidth).toBe(1_000)
    expect(LASER_LINK_DEFAULTS.txPower).toBe(0.1)
    expect(LASER_LINK_DEFAULTS.dataRate).toBe(2_500)
    expect(LASER_LINK_DEFAULTS.eirpDbw).toBe(0)
    expect(LASER_LINK_DEFAULTS.gtDbk).toBe(0)
    expect(LASER_LINK_DEFAULTS.noiseFigureDb).toBe(5)
    expect(linkTypeDefaults('LASER')).toMatchObject({
      frequency: 193_500_000, rxFrequency: 681_300_000, bandwidth: 1_000, rxBandwidth: 1_000,
      txPower: 0.1, dataRate: 2_500, antennaGain: { tx: 45, rx: 45 }, eirpDbw: 0, gtDbk: 0, noiseFigureDb: 5,
    })
  })

  it('卫星可覆盖历史固定速率，按方向读取独立速率', () => {
    const link = { type: 'SAT' as const, sourcePlatformId: 'CMD-01', targetPlatformId: 'SAT-01', relayPlatformId: null,
      direction: 'FORWARD' as const, forwardDataRate: 4, reverseDataRate: 0.512 }
    expect(fixedLinkDataRate(link, [])).toBe(4)
    expect(fixedLinkDataRate({ ...link, direction: 'REVERSE' }, [])).toBe(0.512)
  })
})

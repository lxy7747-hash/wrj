import { describe, expect, it } from 'vitest'
import type { Environment, Platform } from '../../src/contracts/domain-models'
import {
  datalinkRateTiers, fixedLinkDataRate, linkTypeDefaults, readLinkCalcSettings, readNaturalEnvironment,
} from '../../src/features/scenarios/link-calc-defaults'

describe('《与前端字段确认说明》默认值', () => {
  it('link_calc 阈值与编码缺省为 1e-5 / 1e-6 / 1e-7、30 km、无编码，显式值优先', () => {
    expect(readLinkCalcSettings(undefined)).toEqual({ emergencyThreshold: 1e-5, warningThreshold: 1e-6, valueThresholdBer: 1e-7,
      jammingRangeKm: 30, channelEncodingScheme: 0 })
    expect(readLinkCalcSettings({ channelEncodingScheme: -1 }).channelEncodingScheme).toBe(-1)
  })

  it('环境参数缺省按文档补齐，不覆盖已有字段', () => {
    const environment: Environment = { seaState: 3, temperatureC: 20, humidityPercent: 50, rainRateMmPerHour: 10,
      rainLossDbPerKm: 0, multipathEnabled: true, seaModel: 'fine' }
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
    expect(datalinkRateTiers('L', 'FORWARD')).toEqual([0.0064, 0.0128])
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
})

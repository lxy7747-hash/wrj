// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createTemplateScenario } from '../fixtures/template-scenario'

const { buildMissionPackage } = await import('../../server/scripts/' + 'mission-generator.js')

describe('新模板中的激光链路输出', () => {
  it('将任务无人机之间的激光链路写入 lazer_link 端口和可配置 port_params', () => {
    const draft = createTemplateScenario()
    const source = draft.config.platforms.find(item => item.id === 'mission_uav_02')!
    const target = draft.config.platforms.find(item => item.id === 'mission_uav_03')!
    const sample = draft.config.links.find(item => item.id === 'c_forward_uav2')!
    draft.config.links.push({
      ...sample,
      id: 'laser_uav2_uav3',
      type: 'LASER',
      sourcePlatformId: source.id,
      targetPlatformId: target.id,
      frequency: 193_500_000,
      rxFrequency: 194_000_000,
      bandwidth: 1_000,
      rxBandwidth: 2_000,
      txPower: 20,
      dataRate: 100,
      eirpDbw: 21,
      gtDbk: 16,
      noiseFigureDb: 4,
      antennaGain: { tx: 45, rx: 45 },
      laser: { txApertureDiameterM: 0.1, rxApertureDiameterM: 0.1, pulseWidthS: 1e-8, modulation: 'OOK' },
    })
    delete (draft.config.links[draft.config.links.length - 1] as { band?: string }).band
    // 热链已改为显式配置，清空后不会自动串联；本用例验证激光链路的端口与参数生成。
    delete draft.config.linkSettings!.hotLinks
    const generated = buildMissionPackage(draft)
    const text = Object.entries(generated.files).filter(([name]) => name !== 'ad_hoc_comm.txt').map(([, value]) => value).join('\n')
    expect(generated.files['comm_PerDefinition.txt']).toContain('antenna_pattern LASER_COMM_ANTENNA')
    expect(generated.files['comm_platform_MISSION_UAV.txt']).toContain('comm lazer_link')
    expect(generated.files['comm_platform_REAR.txt']).toContain('"comm_name":"lazer_link"')
    expect(text).not.toContain('WSF_LASER_TRANSCEIVER')
    expect(text).toContain('"frequency_ghz":193500')
    expect(text).toContain('"bandwidth_mhz":1000')
    expect(text).toContain('"power_w":20')
    expect(text).toContain('"information_rate_bit/s":100000000')
    expect(text).toContain('"eirp_dBW":21')
    expect(text).toContain('"G_T_dBK":16')
    expect(text).toContain('"noise_figure_dB":4')
    const mapping = JSON.parse(generated.files['mapping.json'])
    expect(mapping.devices).toContainEqual(expect.objectContaining({ linkId: 'laser_uav2_uav3', linkType: 'LASER' }))
    expect(mapping.retainedButNotEmitted).not.toContainEqual(expect.stringContaining('激光通信端口'))
    expect(generated.manifest.warnings).not.toContainEqual(expect.stringContaining('激光链路'))
  })
})

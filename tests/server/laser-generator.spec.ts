// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createTemplateScenario } from '../fixtures/template-scenario'

const { buildMissionPackage } = await import('../../server/scripts/' + 'mission-generator.js')

describe('新模板中的激光保留项', () => {
  it('保留 LASER_COMM_ANTENNA，激光链路不生成收发器或端口参数', () => {
    const draft = createTemplateScenario()
    draft.config.links[0] = {
      ...draft.config.links[0]!, type: 'LASER', enabled: true,
      laser: { txApertureDiameterM: 0.1, rxApertureDiameterM: 0.1, pulseWidthS: 1e-8, modulation: 'OOK' },
    }
    const generated = buildMissionPackage(draft)
    const text = Object.entries(generated.files).filter(([name]) => name !== 'ad_hoc_comm.txt').map(([, value]) => value).join('\n')
    expect(generated.files['comm_PerDefinition.txt']).toContain('antenna_pattern LASER_COMM_ANTENNA')
    expect(text).not.toContain('WSF_LASER_TRANSCEIVER')
    expect(JSON.parse(generated.files['mapping.json']).retainedButNotEmitted).toContain('激光通信端口')
    expect(generated.manifest.warnings).toContainEqual(expect.stringContaining('激光链路'))
  })
})

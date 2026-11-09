// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createTemplateScenario } from '../fixtures/template-scenario'

const { ScriptProjection, inspectScriptPreview } = await import('../../server/scripts/' + 'projection.js')

describe('模板脚本预览', () => {
  it('展开模板固定文件和配置快照，并可通过原生结构预检', () => {
    const projection = new ScriptProjection()
    const script = projection.preview(createTemplateScenario())
    expect(script.preview).toContain('// ===== scenario.txt =====')
    expect(script.preview).toContain('// ===== comm_platform_REAR.txt =====')
    expect(script.preview).toContain('port_params [')
    expect(script.preview).toContain('// ===== mapping.json =====')
    const result = inspectScriptPreview(script.preview)
    expect(result).toMatchObject({ valid: true })
    expect(result.warnings.map((item: { code: string }) => item.code)).toEqual(expect.arrayContaining(['LINK_CALC_PROVIDER_UNCONFIRMED', 'TEMPLATE_REFERENCE_PROVIDER_UNCONFIRMED', 'GROUND_JAMMER_WEAPON_PROVIDER_UNCONFIRMED']))
    expect(result.warnings.map((item: { message: string }) => item.message).join('\n')).toContain('MICRO_REAR_PLATFORM_DIR_ANTENNA')
    expect(result.warnings.map((item: { message: string }) => item.message).join('\n')).toContain('OMNI_ANTENNA_HIGHGAIN')
    expect(projection.preflight(script.scriptId, script.checksum)).toMatchObject({ ok: true, data: { valid: true } })
  })

  it('仍拒绝缺少入口和输出段的伪预览', () => {
    const result = inspectScriptPreview('// ===== scenario.txt =====\ninclude_once comm_SimSetup.txt')
    expect(result.valid).toBe(false)
    expect(result.errors.map((item: { code: string }) => item.code)).toContain('SCRIPT_OUTPUT_PATH_INVALID')
  })

  it('逐项检查新模板的所有必需文件段，预览不含本机运行补丁', () => {
    const script = new ScriptProjection().preview(createTemplateScenario())
    expect(script.preview).not.toContain('local_link_stub')
    expect(script.preview).not.toContain('UAV_MESH_MEDIUM__')
    for (const name of ['comm_platform_COMMAND_VEHICLE.txt', 'comm_platform_MISSION_UAV.txt', 'comm_platform_JAMMER.txt',
      'comm_platform_REAR.txt', 'comm_platform_SAT.txt', 'ad_hoc_comm.txt', 'mapping.json', 'input.json']) {
      const result = inspectScriptPreview(script.preview.replace(`// ===== ${name} =====`, ''))
      expect(result.errors).toContainEqual(expect.objectContaining({ code: 'SCRIPT_REFERENCE_INVALID', message: expect.stringContaining(name) }))
    }
  })
})

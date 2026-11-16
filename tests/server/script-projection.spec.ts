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
    expect(script.preview).toContain('clock_rate 2')
    const rearSection = script.preview.split('// ===== comm_platform_REAR.txt =====')[1]!.split('// ===== ')[0]!
    expect(rearSection).not.toContain('jamming_range')
    expect(script.preview).toContain('Array<string> fw_sit_dst  = { "mission_uav_02", "mission_uav_03" }')
    expect(script.preview).toContain('// ===== mapping.json =====')
    const result = inspectScriptPreview(script.preview)
    expect(result).toMatchObject({ valid: true })
    // F09：三种天线已在交付包定义，端口引用可解析，不再产生“未定义天线”待确认告警。
    expect(result.warnings.map((item: { code: string }) => item.code)).toEqual(expect.arrayContaining(['LINK_CALC_PROVIDER_UNCONFIRMED', 'GROUND_JAMMER_WEAPON_PROVIDER_UNCONFIRMED']))
    expect(result.warnings.map((item: { code: string }) => item.code)).not.toContain('TEMPLATE_REFERENCE_PROVIDER_UNCONFIRMED')
    expect(projection.preflight(script.scriptId, script.checksum)).toMatchObject({ ok: true, data: { valid: true } })
  })

  it('预览遵守同一倍速规则：全速不启用 realtime，x32 启用 realtime', () => {
    const full = createTemplateScenario()
    full.config.scenario.realtime = false
    full.config.scenario.environment.simClockSpeed = 32
    const fullPreview = new ScriptProjection().preview(full).preview
    expect(fullPreview).toMatch(/clock_rate 32/u)
    expect(fullPreview).not.toMatch(/^\s*realtime\s*$/mu)
    const x32 = createTemplateScenario()
    delete x32.config.scenario.realtime
    x32.config.scenario.environment.simClockSpeed = 32
    expect(new ScriptProjection().preview(x32).preview).toMatch(/^\s*realtime\s*\r?\n\s*clock_rate 32/mu)
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

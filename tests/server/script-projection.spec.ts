import { beforeAll, describe, expect, it } from 'vitest'
import type { ScenarioDraft, ScriptContract, ValidationResult } from '../../src/contracts/domain-models'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'

let inspectScriptPreview: (preview: string) => ValidationResult
let ScriptProjection: new () => {
  preview(draft: ScenarioDraft): ScriptContract
  preflight(scriptId: string, checksum: string): unknown
  reset(): void
}
let ScenarioProjection: new () => { get(scenarioId: string): { ok: true; data: ScenarioDraft } | { ok: false } }

beforeAll(async () => {
  const modulePath = '../../server/scripts/' + 'projection.js'
  ;({ inspectScriptPreview, ScriptProjection } = await import(modulePath) as {
    inspectScriptPreview: typeof inspectScriptPreview
    ScriptProjection: typeof ScriptProjection
  })
  ;({ ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js') as {
    ScenarioProjection: typeof ScenarioProjection
  })
})

describe('T-XQ-008 脚本结构预检', () => {
  it('干扰默认禁用，总开关与单设备开关共同过滤且保留扫频触发参数', () => {
    const result = new ScenarioProjection().get('SCN-001')
    if (!result.ok) throw new Error('缺少场景夹具')
    const draft = result.data
    const generator = new ScriptProjection()
    const jammer = draft.config.jammers[0]!
    jammer.type = 'SWEEP'
    jammer.triggerTimeS = 300
    draft.uiExtensions.jammers.forEach(item => { item.enabled = false })
    draft.uiExtensions.jammers[0]!.enabled = true
    const before = generator.preview(draft)
    expect(before.preview).not.toContain('  jammer ')
    expect(before.preview).toContain('"triggerTimeS":300')
    draft.config.jammingEnabled = true
    const enabled = generator.preview(draft)
    expect(enabled.preview).toContain(`  jammer ${JSON.stringify(jammer.id)} `)
    expect(enabled.preview).toContain('type=SWEEP')
    expect(enabled.preview).not.toContain(`  jammer ${JSON.stringify(draft.config.jammers[1]!.id)} `)
    expect(enabled.checksum).not.toBe(before.checksum)
    draft.config.jammingEnabled = false
    expect(generator.preview(draft).preview).not.toContain('  jammer ')
    expect(draft.uiExtensions.jammers[0]!.enabled).toBe(true)
  })
  it('业务独立停用只过滤对应任务，方向与参数保留在预览中', () => {
    const result = new ScenarioProjection().get('SCN-001')
    if (!result.ok) throw new Error('缺少场景夹具')
    const draft = result.data
    const generator = new ScriptProjection()
    const before = generator.preview(draft)
    const business = draft.config.informationDemand[0]!
    business.direction = 'REVERSE'
    business.enabled = false
    const stopped = generator.preview(draft)
    expect(stopped.preview).toContain('"direction":"REVERSE"')
    expect(stopped.preview).not.toContain(`  information_demand ${JSON.stringify(business.id)} `)
    expect(stopped.checksum).not.toBe(before.checksum)
    business.enabled = true
    const enabled = generator.preview(draft)
    expect(enabled.preview).toContain(`  information_demand ${JSON.stringify(business.id)} `)
    expect(inspectScriptPreview(enabled.preview).valid).toBe(true)
  })
  it('展示版本、路径、结构及一基行列错误', () => {
    const result = inspectScriptPreview('# 错误头\nconfig_version 2.0\nscenario invalid {\n}')

    expect(result.valid).toBe(false)
    expect(result.errors.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'SCRIPT_HEADER_INVALID',
      'SCRIPT_VERSION_INVALID',
      'SCRIPT_SCENARIO_INVALID',
      'SCRIPT_OUTPUT_PATH_INVALID',
    ]))
    expect(result.errors.every((issue) => /^preview\[\d+:\d+\]$/.test(issue.fieldPath))).toBe(true)
    expect(result.errors.every((issue) => /第 \d+ 行，第 \d+ 列/.test(issue.message))).toBe(true)
  })

  it('定位括号不匹配并覆盖空脚本的末行列号', () => {
    const unclosed = inspectScriptPreview('# AFSIM 2.9.0 场景脚本预览；仅内存生成\nconfig_version 1.0\nscenario "SCN-TEST" {\n  output path="output/test" interval=1')
    expect(unclosed.errors).toContainEqual(expect.objectContaining({ code: 'SCRIPT_STRUCTURE_INVALID' }))

    const empty = inspectScriptPreview('')
    expect(empty.errors).toContainEqual(expect.objectContaining({
      code: 'SCRIPT_OUTPUT_PATH_INVALID',
      fieldPath: 'preview[1:1]',
    }))
  })

  it('生成完整预览并覆盖未知脚本、校验和和重置分支', () => {
    const scenario = new ScenarioProjection().get('SCN-001')
    expect(scenario.ok).toBe(true)
    if (!scenario.ok) return
    const projection = new ScriptProjection()
    const script = projection.preview(scenario.data)

    expect(script).toMatchObject({ scriptId: 'SCRIPT-P2-001', target: 'AFSIM 2.9.0' })
    expect(script.checksum).toMatch(/^FNV1A-MOCK-[0-9A-F]{8}$/)
    expect(script.preview).toContain('platform "CMD-01"')
    expect(projection.preflight(script.scriptId, 'FNV1A-MOCK-WRONG')).toMatchObject({ ok: false, fieldPath: 'checksum' })
    expect(projection.preflight('SCRIPT-MISSING', script.checksum)).toMatchObject({ ok: false, fieldPath: 'scriptId' })
    expect(projection.preflight(script.scriptId, script.checksum)).toMatchObject({ ok: true, data: { valid: true } })

    projection.reset()
    expect(projection.preflight(script.scriptId, script.checksum)).toMatchObject({ ok: false, fieldPath: 'scriptId' })
    expect(projection.preview(scenario.data).scriptId).toBe('SCRIPT-P2-001')
  })

  it('新参数影响预览校验和，停用链路和卫星保留配置但不生成通信段', () => {
    const scenario = new ScenarioProjection().get('SCN-001')
    if (!scenario.ok) throw new Error('缺少测试场景')
    const draft = scenario.data
    const projection = new ScriptProjection()
    const before = projection.preview(draft)
    draft.config.linkSettings = readLinkSettings(draft.config)
    const [disabledLink, enabledLink] = draft.config.links.filter(link => link.type === 'MICROWAVE')
    disabledLink!.enabled = false
    enabledLink!.enabled = true
    draft.config.linkSettings.enabledSatellites.TIANTONG = false
    draft.config.linkSettings.enabledSatellites.SHENTONG = true
    draft.config.platforms.push({ ...structuredClone(draft.config.platforms.find(p => p.satelliteType === 'TIANTONG')!), id: 'SAT-ST', satelliteType: 'SHENTONG', linkIds: [] })
    draft.config.linkSettings.switchCooldownS = 8
    draft.config.linkSettings.priority = ['SAT', 'LASER', 'DATALINK', 'MICROWAVE']
    draft.config.links[0]!.coding = 'CUSTOM-1/2'
    draft.config.links[0]!.antennaGainCorrectionDb = -2
    const after = projection.preview(draft)
    expect(after.checksum).not.toBe(before.checksum)
    expect(after.preview).toContain('"switchCooldownS":8')
    expect(after.preview).toContain('"coding":"CUSTOM-1/2"')
    const communication = after.preview.split('\n').filter(line => line.startsWith('  comm '))
    expect(communication.some(line => line.includes(JSON.stringify(disabledLink!.id)))).toBe(false)
    expect(communication.some(line => line.includes(JSON.stringify(enabledLink!.id)))).toBe(true)
    const satelliteId = draft.config.platforms.find(p => p.satelliteType === 'TIANTONG')!.id
    expect(communication.some(line => line.includes(JSON.stringify(satelliteId)))).toBe(false)
    expect(projection.preflight(after.scriptId, after.checksum)).toMatchObject({ ok: true, data: { valid: true } })
  })
})

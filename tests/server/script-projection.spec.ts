import { beforeAll, describe, expect, it } from 'vitest'
import type { ScenarioDraft, ScriptContract, ValidationResult } from '../../src/contracts/domain-models'

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
})

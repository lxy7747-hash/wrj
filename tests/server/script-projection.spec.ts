import { beforeAll, describe, expect, it } from 'vitest'
import type { ScenarioDraft, ScriptContract, ValidationResult } from '../../src/contracts/domain-models'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'

let inspectScriptPreview: (preview: string) => ValidationResult
let ScriptProjection: new () => { preview(draft: ScenarioDraft): ScriptContract; get(scriptId: string): ScriptContract | undefined; preflight(scriptId: string, checksum: string): unknown; reset(): void }
let ScenarioProjection: new () => { get(scenarioId: string): { ok: true; data: ScenarioDraft } | { ok: false } }

beforeAll(async () => {
  const scriptModule = '../../server/scripts/' + 'projection.js'
  const scenarioModule = '../../server/scenarios/' + 'projection.js'
  ;({ inspectScriptPreview, ScriptProjection } = await import(scriptModule))
  ;({ ScenarioProjection } = await import(scenarioModule))
})

function fixtureDraft(): ScenarioDraft {
  const result = new ScenarioProjection().get('SCN-001')
  if (!result.ok) throw new Error('缺少场景夹具')
  return result.data
}

/** 从注释化工件读取原始 JSON，以区分原始配置与实际生成映射。 */
function previewJson(preview: string, name: 'input.json' | 'mapping.json'): Record<string, unknown> {
  const marker = `// ===== ${name} =====\n`
  const start = preview.indexOf(marker)
  if (start < 0) throw new Error(`缺少 ${name} 预览段`)
  const contentStart = start + marker.length
  const next = preview.indexOf('\n// ===== ', contentStart)
  const lines = preview.slice(contentStart, next < 0 ? undefined : next).split('\n')
  const jsonStart = lines.findIndex(line => line === '// {')
  if (jsonStart < 0) throw new Error(`${name} 不含 JSON`)
  return JSON.parse(lines.slice(jsonStart).filter(line => line.startsWith('// ')).map(line => line.slice(3)).join('\n')) as Record<string, unknown>
}

function mappedIds(mapping: Record<string, unknown>, key: 'devices' | 'businesses', idKey: 'linkId' | 'demandId'): string[] {
  const values = mapping[key]
  if (!Array.isArray(values)) return []
  return values.flatMap(item => typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>)[idKey] === 'string'
    ? [(item as Record<string, string>)[idKey]] : [])
}

describe('T-XQ-008 原生脚本预览与预检', () => {
  it('停用链路只过滤实际生成映射，恢复后保持配置不变', () => {
    const draft = fixtureDraft()
    const generator = new ScriptProjection()
    const [link, otherLink] = draft.config.links.filter(item => item.type === 'MICROWAVE')
    if (!link || !otherLink) throw new Error('缺少微波链路夹具')
    link.enabled = true
    otherLink.enabled = true
    const legacy = structuredClone(draft.config.informationDemand[0]!)
    delete legacy.linkId
    legacy.enabled = true
    const business = { ...structuredClone(legacy), id: 'INFO-LINK', linkId: link.id, sourcePlatformId: link.sourcePlatformId, destinationPlatformIds: [link.targetPlatformId], direction: link.direction }
    const otherBusiness = { ...structuredClone(legacy), id: 'INFO-OTHER', linkId: otherLink.id, sourcePlatformId: otherLink.sourcePlatformId, destinationPlatformIds: [otherLink.targetPlatformId], direction: otherLink.direction }
    draft.config.informationDemand = [business, otherBusiness, legacy]
    const originalBusiness = structuredClone(draft.config.informationDemand)

    const initial = generator.preview(draft)
    expect(initial.preview).toContain('start_date')
    expect(initial.preview).toContain(`message.SetSubType("${business.id}")`)
    expect(mappedIds(previewJson(initial.preview, 'mapping.json'), 'devices', 'linkId')).toContain(link.id)
    expect(mappedIds(previewJson(initial.preview, 'mapping.json'), 'businesses', 'demandId')).toEqual(expect.arrayContaining([business.id, otherBusiness.id, legacy.id]))

    link.enabled = false
    const beforeStopped = structuredClone(draft)
    const stopped = generator.preview(draft)
    const mapping = previewJson(stopped.preview, 'mapping.json')
    expect(mappedIds(mapping, 'devices', 'linkId')).not.toContain(link.id)
    expect(mappedIds(mapping, 'devices', 'linkId')).toContain(otherLink.id)
    expect(mappedIds(mapping, 'businesses', 'demandId')).not.toContain(business.id)
    expect(mappedIds(mapping, 'businesses', 'demandId')).toEqual(expect.arrayContaining([otherBusiness.id, legacy.id]))
    expect(JSON.stringify(previewJson(stopped.preview, 'input.json'))).toContain(`\"id\":\"${business.id}\"`)
    expect(JSON.stringify(previewJson(stopped.preview, 'input.json'))).toContain(`\"linkId\":\"${link.id}\"`)
    expect(stopped.checksum).not.toBe(initial.checksum)
    expect(draft).toEqual(beforeStopped)

    link.enabled = true
    const resumed = generator.preview(draft)
    expect(resumed.preview).toBe(initial.preview)
    expect(resumed.checksum).toBe(initial.checksum)
    expect(draft.config.informationDemand).toEqual(originalBusiness)
  })

  it('保留干扰触发和方向配置快照，生成映射反映总开关与设备开关', () => {
    const draft = fixtureDraft()
    const generator = new ScriptProjection()
    draft.config.jammers.push({ ...draft.config.jammers[0]!, id: 'JAM-TEST-SECOND', type: 'SPOT' })
    draft.uiExtensions.jammers.push({ jammerId: 'JAM-TEST-SECOND', direction: 45, duration: 60, enabled: false })
    const jammer = draft.config.jammers[0]!
    jammer.type = 'SWEEP'
    jammer.triggerTimeS = 300
    draft.uiExtensions.jammers.forEach(item => { item.enabled = false })
    draft.uiExtensions.jammers[0]!.enabled = true
    const before = generator.preview(draft)
    expect(JSON.stringify(previewJson(before.preview, 'input.json'))).toContain('"triggerTimeS":300')
    expect((previewJson(before.preview, 'mapping.json').jammers as Array<Record<string, unknown>>).find(item => item.jammerId === jammer.id)).toMatchObject({ configuredEnabled: false })

    draft.config.jammingEnabled = true
    const enabled = generator.preview(draft)
    const jammers = previewJson(enabled.preview, 'mapping.json').jammers as Array<Record<string, unknown>>
    expect(jammers.find(item => item.jammerId === jammer.id)).toMatchObject({ configuredEnabled: true, directionDeg: draft.uiExtensions.jammers[0]!.direction })
    expect(jammers.find(item => item.jammerId === 'JAM-TEST-SECOND')).toMatchObject({ configuredEnabled: false })
    expect(enabled.checksum).not.toBe(before.checksum)
  })

  it('业务独立停用只移出实际生成映射，输入快照仍保留方向和开关', () => {
    const draft = fixtureDraft()
    const generator = new ScriptProjection()
    const business = draft.config.informationDemand[0]!
    business.enabled = false
    const stopped = generator.preview(draft)
    expect(mappedIds(previewJson(stopped.preview, 'mapping.json'), 'businesses', 'demandId')).not.toContain(business.id)
    expect(previewJson(stopped.preview, 'input.json')).toMatchObject({ config: { informationDemand: [{ id: business.id, enabled: false }] } })
    business.enabled = true
    const enabled = generator.preview(draft)
    expect(mappedIds(previewJson(enabled.preview, 'mapping.json'), 'businesses', 'demandId')).toContain(business.id)
    expect(inspectScriptPreview(enabled.preview).valid).toBe(true)
  })

  it('预检识别原生入口、AFSIM 头、依赖和一基行列错误', () => {
    const result = inspectScriptPreview('# 不是原生入口\ninclude_once comm_SimSetup.txt')
    expect(result.valid).toBe(false)
    expect(result.errors.map(issue => issue.code)).toEqual(expect.arrayContaining(['SCRIPT_HEADER_INVALID', 'SCRIPT_ENTRY_INVALID', 'SCRIPT_AFSIM_HEADER_INVALID', 'SCRIPT_REFERENCE_INVALID', 'SCRIPT_OUTPUT_PATH_INVALID']))
    expect(result.errors.every(issue => /^preview\[\d+:\d+\]$/.test(issue.fieldPath))).toBe(true)
    expect(result.errors.every(issue => /第 \d+ 行，第 \d+ 列/.test(issue.message))).toBe(true)
  })

  it('定位原生 AFSIM 块结构错误，并覆盖空预览的末行列号', () => {
    const unclosed = inspectScriptPreview(['// ===== scenario.txt =====', 'include_once comm_SimSetup.txt', '// ===== comm_SimSetup.txt =====', 'start_date aug 06 2026', 'platform_type TEST {', '// ===== comm_PerDefinition.txt =====', '// ===== comm_platform_INS.txt =====', '// ===== observers.txt =====', '   file output/test.aer'].join('\n'))
    expect(unclosed.errors).toContainEqual(expect.objectContaining({ code: 'SCRIPT_STRUCTURE_INVALID' }))
    expect(inspectScriptPreview('').errors).toContainEqual(expect.objectContaining({ code: 'SCRIPT_OUTPUT_PATH_INVALID', fieldPath: 'preview[1:1]' }))
  })

  it('忽略字符串与注释里的花括号，却能发现截断的原生块', () => {
    const draft = fixtureDraft()
    draft.config.scenario.name = '名称包含 { 和 \\"转义引号'
    const preview = new ScriptProjection().preview(draft).preview
    expect(inspectScriptPreview(preview).valid).toBe(true)
    const snapshots = preview.indexOf('// ===== mapping.json =====')
    const lastNativeClose = preview.lastIndexOf('\n}', snapshots)
    const broken = preview.slice(0, lastNativeClose) + preview.slice(lastNativeClose + 2)
    expect(inspectScriptPreview(broken).errors).toContainEqual(expect.objectContaining({ code: 'SCRIPT_STRUCTURE_INVALID', fieldPath: expect.stringMatching(/^preview\[\d+:\d+\]$/) }))
  })

  it('多余右括号定位到所在行列，末行注释里的括号不影响结构', () => {
    const preview = new ScriptProjection().preview(fixtureDraft()).preview
    const extraClose = `${preview}\n  }`
    const line = extraClose.split('\n').length
    expect(inspectScriptPreview(extraClose)).toMatchObject({ valid: false })
    expect(inspectScriptPreview(extraClose).errors).toContainEqual(expect.objectContaining({
      code: 'SCRIPT_STRUCTURE_INVALID', fieldPath: `preview[${line}:3]`,
    }))
    expect(inspectScriptPreview(`${preview}\n// 最后一行含未配对括号 } {，没有换行`).valid).toBe(true)
  })

  it('生成完整原生包预览并覆盖未知脚本、校验和和重置分支', () => {
    const projection = new ScriptProjection()
    const script = projection.preview(fixtureDraft())
    expect(script).toMatchObject({ scriptId: 'SCRIPT-P2-001', target: 'AFSIM 2.9.0' })
    expect(script.checksum).toMatch(/^FNV1A-MOCK-[0-9A-F]{8}$/)
    expect(script.preview).toContain('// ===== scenario.txt =====')
    expect(script.preview).toContain('// ===== comm_SimSetup.txt =====')
    expect(script.preview).toContain('platform_type ')
    expect(script.preview).toContain('// ===== input.json =====')
    expect(projection.get('SCRIPT-MISSING')).toBeUndefined()
    const retrieved = projection.get(script.scriptId)!
    expect(retrieved).toEqual(script)
    retrieved.preview = '客户端修改副本'
    expect(projection.get(script.scriptId)?.preview).toBe(script.preview)
    expect(projection.preflight(script.scriptId, 'FNV1A-MOCK-WRONG')).toMatchObject({ ok: false, fieldPath: 'checksum' })
    expect(projection.preflight('SCRIPT-MISSING', script.checksum)).toMatchObject({ ok: false, fieldPath: 'scriptId' })
    expect(projection.preflight(script.scriptId, script.checksum)).toMatchObject({ ok: true, data: { valid: true } })
    projection.reset()
    expect(projection.preflight(script.scriptId, script.checksum)).toMatchObject({ ok: false, fieldPath: 'scriptId' })
    expect(projection.preview(fixtureDraft()).scriptId).toBe('SCRIPT-P2-001')
  })

  it('未映射配置仍在 input.json 可追溯，通信映射按停用链路和卫星过滤', () => {
    const draft = fixtureDraft()
    const projection = new ScriptProjection()
    const before = projection.preview(draft)
    draft.config.linkSettings = readLinkSettings(draft.config)
    const [disabledLink, enabledLink] = draft.config.links.filter(link => link.type === 'MICROWAVE')
    disabledLink!.enabled = false
    enabledLink!.enabled = true
    draft.config.linkSettings.enabledSatellites.TIANTONG = false
    draft.config.linkSettings.enabledSatellites.SHENTONG = true
    draft.config.platforms.push({ ...structuredClone(draft.config.platforms.find(platform => platform.satelliteType === 'TIANTONG')!), id: 'SAT-ST', satelliteType: 'SHENTONG', linkIds: [] })
    draft.config.linkSettings.switchCooldownS = 8
    const after = projection.preview(draft)
    const mapping = previewJson(after.preview, 'mapping.json')
    expect(after.checksum).not.toBe(before.checksum)
    expect(JSON.stringify(previewJson(after.preview, 'input.json'))).toContain('"switchCooldownS":8')
    expect(mappedIds(mapping, 'devices', 'linkId')).not.toContain(disabledLink!.id)
    expect(mappedIds(mapping, 'devices', 'linkId')).toContain(enabledLink!.id)
    expect(mappedIds(mapping, 'devices', 'linkId')).not.toEqual(expect.arrayContaining(draft.config.links.filter(link => link.type === 'SAT').map(link => link.id)))
    expect(JSON.stringify(mapping)).toContain('"platformId":"SAT-01"')
    expect(inspectScriptPreview(after.preview).valid).toBe(true)
  })
})

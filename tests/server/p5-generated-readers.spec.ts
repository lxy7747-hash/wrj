// @vitest-environment node
import { describe, expect, it } from 'vitest'
const { functionalParameterDraft } = await import('../../scripts/' + 'functional-parameters-probe')
const { nativeWorkload } = await import('../../scripts/' + 'native-integration')
const { dynamicDraft } = await import('../../scripts/' + 'native-dynamic-nodes')
const { buildMissionPackage } = await import('../../server/scripts/' + 'mission-generator')
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'

describe('P5 本机工具读取新模板包', () => {
  it.each([
    ['通信参数探针', () => functionalParameterDraft(), 2],
    ['50节点联调', () => nativeWorkload('SCN-P5-NATIVE', 10), 53],
    ['50节点动态探针', () => dynamicDraft(50), 50],
    ['51节点动态探针', () => dynamicDraft(51), 51],
  ] as const)('%s 使用合法端点和本机运行补丁', (_name, create, platformCount) => {
    const draft = create()
    expect(inspectScenarioConfig(draft.config, 'write').result.errors).toEqual([])
    expect(draft.config.platforms).toHaveLength(platformCount)
    const generated = buildMissionPackage(draft, draft.config.output, { linkCalc: 'STUB' })
    expect(JSON.parse(generated.files['mapping.json']!).localRuntime).toMatchObject({ linkCalc: 'MISSING_PROCESSOR_STUBBED' })
    expect(generated.files['comm_PerDefinition.txt']).toContain('UAV_MESH_MEDIUM__')
    expect(generated.files['comm_platform_REAR.txt']).toContain('local_link_stub')
    expect(generated.manifest.devices.every((device: { source: { deviceId: string } }) => !device.source.deviceId.startsWith('comm_'))).toBe(true)
    const preview = buildMissionPackage(draft)
    expect(preview.files['comm_platform_REAR.txt']).toContain('WSF_LINK_CALC_PROCESSOR')
    expect(preview.files['comm_platform_REAR.txt']).not.toContain('local_link_stub')
  })
})

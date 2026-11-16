// @vitest-environment node
import { describe, expect, it } from 'vitest'
const { functionalParameterDraft } = await import('../../scripts/' + 'functional-parameters-probe')
const { nativeWorkload } = await import('../../scripts/' + 'native-integration')
const { dynamicDraft } = await import('../../scripts/' + 'native-dynamic-nodes')
const { buildMissionPackage } = await import('../../server/scripts/' + 'mission-generator')
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'

describe('P5 本机工具读取新模板包', () => {
  it('通信参数探针使用合法端点并生成本机运行补丁', () => {
    const draft = functionalParameterDraft()
    expect(inspectScenarioConfig(draft.config, 'write').result.errors).toEqual([])
    const generated = buildMissionPackage(draft, draft.config.output, { linkCalc: 'STUB' })
    expect(JSON.parse(generated.files['mapping.json']!).localRuntime).toMatchObject({ linkCalc: 'MISSING_PROCESSOR_STUBBED' })
    expect(generated.files['comm_PerDefinition.txt']).toContain('UAV_MESH_MEDIUM__')
    expect(generated.files['comm_platform_REAR.txt']).toContain('local_link_stub')
    expect(generated.manifest.devices.every((device: { source: { deviceId: string } }) => !device.source.deviceId.startsWith('comm_'))).toBe(true)
    const preview = buildMissionPackage(draft)
    expect(preview.files['comm_platform_REAR.txt']).toContain('WSF_LINK_CALC_PROCESSOR')
    expect(preview.files['comm_platform_REAR.txt']).not.toContain('local_link_stub')
  })

  it.each([
    ['50节点联调', () => nativeWorkload('SCN-P5-NATIVE', 10), 53],
    ['50节点动态探针', () => dynamicDraft(50), 50],
    ['51节点动态探针', () => dynamicDraft(51), 51],
  ] as const)('%s 按场景配置生成 mission_uav 实例，不再受模板 3 架无人机限制', (_name, create, platformCount) => {
    const draft = create()
    expect(inspectScenarioConfig(draft.config, 'write').result.errors).toEqual([])
    expect(draft.config.platforms).toHaveLength(platformCount)
    const expectedUavs = draft.config.platforms.filter((platform: { type: string }) => platform.type === 'FORWARD_RELAY_NODE' || platform.type === 'AIRBORNE_MISSION_CLUSTER').length
    const generated = buildMissionPackage(draft, draft.config.output, { linkCalc: 'STUB' })
    const uavInstances = [...generated.files['comm_platform_INS.txt']!.matchAll(/^platform (mission_uav_\d+) MISSION_UAV_PLATFORM$/gmu)].map(match => match[1]!)
    expect(uavInstances).toHaveLength(expectedUavs)
    expect(uavInstances).toContain('mission_uav_04')
  })
})

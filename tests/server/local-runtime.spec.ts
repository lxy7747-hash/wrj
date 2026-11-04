// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createTemplateScenario } from '../fixtures/template-scenario'

const { mkdtemp, readFile, rm } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { dirname, join } = await import('node:' + 'path')
const { buildMissionPackage } = await import('../../server/scripts/' + 'mission-generator.js')
const { writeMissionPackage, writeScriptText } = await import('../../server/local/' + 'script-file.js')

const RADIO_FILES = ['comm_platform_COMMAND_VEHICLE.txt', 'comm_platform_MISSION_UAV.txt', 'comm_platform_REAR.txt', 'comm_platform_SAT.txt'] as const
const addedMedia = (files: Record<string, string>) => RADIO_FILES.flatMap(name => [...files[name]!.matchAll(/^ {4}add medium (\S+)$/gmu)].map(match => match[1]!))

describe('本地运行包兼容（P4）', () => {
  it('对接方 TXT 保持模板：共享 UAV_MESH_MEDIUM、保留 link_calc、不含补丁', () => {
    const { files } = buildMissionPackage(createTemplateScenario())
    expect(new Set(addedMedia(files))).toEqual(new Set(['UAV_MESH_MEDIUM']))
    expect(files['comm_PerDefinition.txt']).not.toContain('UAV_MESH_MEDIUM__')
    expect(files['comm_platform_REAR.txt']).toContain('add processor link_calc WSF_LINK_CALC_PROCESSOR')
    expect(Object.values(files).join('\n')).not.toContain('local_link_stub')
    expect(JSON.parse(files['mapping.json']!)).not.toHaveProperty('localRuntime')
  })

  it('本地包为每个射频端口派生独立介质，引擎有 link_calc 时原样保留', () => {
    const shared = buildMissionPackage(createTemplateScenario()).files
    const { files } = buildMissionPackage(createTemplateScenario(), undefined, { linkCalc: 'PRESERVE' })
    const media = addedMedia(files)
    // 无人机 6 + 指挥车 4 + 后方车 3 + 天通 1 + 神通 1。
    expect(media).toHaveLength(15)
    expect(new Set(media).size).toBe(media.length)
    expect(media).toContain('UAV_MESH_MEDIUM__MISSION_UAV_PLATFORM__c_band_uplink')
    expect(media).toContain('UAV_MESH_MEDIUM__SHEN_TONG_SAT__sat_link')
    media.forEach(name => expect(files['comm_PerDefinition.txt']).toContain(`medium ${name} WSF_COMM_MEDIUM_UNGUIDED`))
    // 端口内速率改写不变，只换介质类型名。
    RADIO_FILES.forEach(name => expect(files[name]!.replace(/UAV_MESH_MEDIUM__\S+/gu, 'UAV_MESH_MEDIUM')).toBe(shared[name]))
    expect(files['comm_platform_REAR.txt']).toContain('add processor link_calc WSF_LINK_CALC_PROCESSOR')
    expect(files['comm_platform_REAR.txt']).not.toContain('local_link_stub')
    expect(JSON.parse(files['mapping.json']!).localRuntime).toMatchObject({ linkCalc: 'PRESERVED', splitMedia: media })
  })

  it('缺少 link_calc 时原位注入补丁：按主路由写 4 个 AuxData 键，干扰按半径启停', () => {
    const { files } = buildMissionPackage(createTemplateScenario(), undefined, { linkCalc: 'STUB' })
    const rear = files['comm_platform_REAR.txt']!
    expect(rear).not.toContain('WSF_LINK_CALC_PROCESSOR')
    expect(rear.indexOf('  processor local_link_stub WSF_SCRIPT_PROCESSOR')).toBeGreaterThan(rear.indexOf('  processor script_proc WSF_SCRIPT_PROCESSOR'))
    expect(rear.trimEnd().endsWith('end_platform_type')).toBe(true)
    expect(rear).toContain('      if (PLATFORM.Name() == "rear_comm_vehicle")')
    // 前向：后方车 → 光纤 → 指挥车；两架任务机的两类前向业务都从后方车发出。
    expect(rear).toContain('target = WsfSimulation.FindPlatform("rear_comm_vehicle");')
    expect(rear).toMatch(/target\.SetAuxData\("kForwardSituation_next_platform_name", "command_vehicle\|command_vehicle"\);/u)
    expect(rear).toMatch(/target\.SetAuxData\("kForwardSituation_out_port_name", "fiber_link\|fiber_link"\);/u)
    expect(rear).toMatch(/target\.SetAuxData\("kForwardSituation_next_in_port_name", "fiber_link\|fiber_link"\);/u)
    expect(rear).toContain('target.SetAuxData("kForwardSituation_data_size", "256|256");')
    // 回传：任务机 c_band_downlink → 指挥车，中间节点去重后只保留一跳。
    expect(rear).toContain('target = WsfSimulation.FindPlatform("mission_uav_02");')
    expect(rear).toContain('target.SetAuxData("kReturnReconVideo_out_port_name", "c_band_downlink");')
    expect(rear).toContain('target.SetAuxData("kReturnReconVideo_data_size", "8192");')
    // 干扰：地面站触发半径 0（不触发）、机载 10/15 nm，模式取干扰类型。
    expect(rear).toMatch(new RegExp(`LocalStubJammer\\("jammer_station_01", "prophet_jammer", "broadband_jamming", 0, ${35 * 1852}, engaged\\d\\);`, 'u'))
    expect(rear).toMatch(/LocalStubJammer\("jammer_airborne_01", "alq99_jammer", "\w+_jamming", 18520, 27780, engaged\d\);/u)
    expect(rear).toContain('if (!aEngaged && aTrigger > 0 && nearest <= aTrigger)')
    expect(rear).toContain('weapon.SelectMode("default");\n        weapon.TurnOff();')
    expect(JSON.parse(files['mapping.json']!).localRuntime).toMatchObject({ linkCalc: 'MISSING_PROCESSOR_STUBBED' })
  })

  it('未启用的干扰设备在开始时关闭，无启用设备时不生成周期检查', () => {
    const draft = createTemplateScenario()
    draft.config.jammingEnabled = false
    const rear = buildMissionPackage(draft, undefined, { linkCalc: 'STUB' }).files['comm_platform_REAR.txt']!
    expect(rear).toContain('if (target.IsValid() && target.Weapon("alq99_jammer").IsValid()) { target.Weapon("alq99_jammer").TurnOff(); }')
    expect(rear).toContain('if (target.IsValid() && target.Weapon("prophet_jammer").IsValid()) { target.Weapon("prophet_jammer").TurnOff(); }')
    expect(rear).not.toContain('execute at_interval_of 3 sec')
  })

  it('writeMissionPackage 写本地包，writeScriptText 保存的 TXT 不含本地改动', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-local-runtime-'))
    try {
      const draft = createTemplateScenario()
      const entry = await writeMissionPackage(join(root, 'runs'), draft, true)
      const local = await readFile(join(dirname(entry), 'comm_platform_REAR.txt'), 'utf8')
      expect(local).toContain('local_link_stub')
      expect(local).toContain('UAV_MESH_MEDIUM__REAR_COMM_PLATFORM__microwave_link')
      const saved = await writeScriptText(join(root, 'scripts'), { scenarioId: draft.config.scenario.id, preview: '' } as never, draft.revision, draft)
      const delivered = await readFile(join(dirname(saved), 'comm_platform_REAR.txt'), 'utf8')
      expect(delivered).toBe(buildMissionPackage(draft).files['comm_platform_REAR.txt'])
      expect(delivered).toContain('WSF_LINK_CALC_PROCESSOR')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

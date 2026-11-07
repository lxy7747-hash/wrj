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
    expect(files['comm_PerDefinition.txt']).toContain('network COM_MESH_NET WSF_COMM_NETWORK_MESH\nend_network')
    expect(files['comm_PerDefinition.txt']).not.toContain('network_address')
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

  it.each(['PRESERVE', 'STUB'] as const)('本地 %s 包扩大 COM_MESH_NET 地址容量，保留光纤网络与全部通信端口', linkCalc => {
    const draft = createTemplateScenario()
    const { files } = buildMissionPackage(draft, undefined, { linkCalc })
    expect(files['comm_PerDefinition.txt']).toContain('network COM_MESH_NET WSF_COMM_NETWORK_MESH\n  network_address 10.0.0.0/23\nend_network')
    expect(files['comm_PerDefinition.txt']).toContain('network FIBER_NET WSF_COMM_NETWORK_P2P\nend_network')
    const shared = buildMissionPackage(draft).files
    for (const file of RADIO_FILES) {
      const ports = (text: string) => [...text.matchAll(/^ {2}comm (\S+) (\S+)$/gmu)].map(match => match[0])
      expect(ports(files[file]!)).toEqual(ports(shared[file]!))
    }
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
    for (const dst of ['mission_uav_02', 'mission_uav_03']) {
      expect(rear).toContain(`target.SetAuxData("kForwardSituation_${dst}_next_platform_name", "command_vehicle");`)
      expect(rear).toContain(`target.SetAuxData("kForwardSituation_${dst}_out_port_name", "fiber_link");`)
      expect(rear).toContain(`target.SetAuxData("kForwardSituation_${dst}_next_in_port_name", "fiber_link");`)
      expect(rear).toContain(`target.SetAuxData("kForwardSituation_${dst}_dst_platform_name", "${dst}");`)
    }
    // 回传使用真实业务类型和目的地，数据量由 script_variables 提供。
    expect(rear).toContain('target = WsfSimulation.FindPlatform("mission_uav_02");')
    expect(rear).toContain('target.SetAuxData("kReturnReconVideo_rear_comm_vehicle_out_port_name", "c_band_downlink");')
    expect(rear).toContain('target.SetAuxData("kReturnReconStatus_rear_comm_vehicle_dst_platform_name", "rear_comm_vehicle");')
    expect(rear).not.toContain('_data_size')
    // 干扰：地面站触发半径 0（不触发）、机载 10/15 nm，模式取干扰类型。
    expect(rear).toContain('WsfPlatform jammer0 = WsfSimulation.FindPlatform("jammer_station_01");')
    expect(rear).toContain('WsfWeapon weapon0 = jammer0.Weapon("prophet_jammer");')
    expect(rear).toContain('if (0 > 0 && nearest0 <= 0)')
    expect(rear).toContain(`else if (nearest0 > ${35 * 1852})`)
    expect(rear).toContain('if (18520 > 0 && nearest1 <= 18520)')
    expect(rear).toContain('else if (nearest1 > 27780)')
    expect(rear).toContain('weapon0.SelectMode("default"); weapon0.TurnOff();')
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


it('卫星同时写新旧 AuxData 键，目的地顺序一致，中继保留真实业务类型', async () => {
  const { localAuxRoutes, localLinkStub } = await import('../../server/scripts/' + 'mission-generator.js')
  for (const satellite of ['tiantong_sat', 'shentong_sat']) {
    const hops = (dst: string) => [{ platform: 'rear_comm_vehicle', inPort: '', outPort: 'sat_link_a' },
      { platform: satellite, inPort: 'sat_link', outPort: 'sat_link' },
      { platform: 'mission_uav_01', inPort: 'sat_link', outPort: 'microwave_link' },
      { platform: dst, inPort: 'microwave_link', outPort: '' }]
    const routes = { forward: { link1: hops('mission_uav_02'), link2: hops('mission_uav_03') }, reverse: {},
      traffic: ['mission_uav_02', 'mission_uav_03'].map(dst => ({ [dst]: { forward: [{ traffice_type: 'kForwardTarget', data_volume_bits: 512, trans_freq: 1 }], return: [] } })) }
    const aux = localAuxRoutes(routes)
    expect([...aux.get('mission_uav_01')!.keys()]).toEqual(['kForwardTarget_mission_uav_02', 'kForwardTarget_mission_uav_03'])
    const old = aux.get(satellite)!.get('kForwardTarget')!
    expect(old.next).toEqual(['mission_uav_01', 'mission_uav_01'])
    expect(old.dst).toEqual(['mission_uav_02', 'mission_uav_03'])
    for (const dst of old.dst) expect(aux.get(satellite)!.get(`kForwardTarget_${dst}`)!.dst).toEqual([dst])
    const stub = localLinkStub('rear_comm_vehicle', routes, [])
    expect(stub).toContain('target.SetAuxData("kForwardTarget_dst_platform_name", "mission_uav_02|mission_uav_03");')
    expect(stub).toContain('target.SetAuxData("kForwardTarget_mission_uav_02_dst_platform_name", "mission_uav_02");')
  }
})

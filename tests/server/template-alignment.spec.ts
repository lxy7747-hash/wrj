// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { allTemplateCommPorts } from '../../src/features/scenarios/template-defaults'
import { createTemplateScenario } from '../fixtures/template-scenario'

function withAllTemplateCommPorts() {
  const draft = createTemplateScenario()
  draft.config.deviceParameters = { ...draft.config.deviceParameters, commPorts: allTemplateCommPorts() }
  return draft
}

const { readFile, readdir } = await import('node:' + 'fs/promises')
const { dirname, join } = await import('node:' + 'path')
const { fileURLToPath } = await import('node:' + 'url')
const { createHash } = await import('node:' + 'crypto')
const { buildMissionPackage } = await import('../../server/scripts/' + 'mission-generator.js')
const templateModule = await import('../../server/scripts/' + 'afsim-template-1112.js')
const patchModule = await import('../../server/scripts/' + 'afsim-template-patch.js')

const TEMPLATE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'afsim-template-1112')
const MANIFEST_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'afsim-template-1112.source.json')
const TEMPLATE_FILES = [
  'ad_hoc_comm.txt', 'comm_PerDefinition.txt', 'comm_platform_COMMAND_VEHICLE.txt', 'comm_platform_INS.txt',
  'comm_platform_JAMMER.txt', 'comm_platform_MISSION_UAV.txt', 'comm_platform_REAR.txt', 'comm_platform_SAT.txt',
  'comm_SimSetup.txt', 'observers.txt',
] as const

/** 遮蔽动态生成的 mission_uav 实例段与 5.x 干扰源实例段；其余固定实例仍按模板逐字节比较。 */
function maskDynamicInsSections(text: string): string {
  const records = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const content = records.map(raw => raw.replace(/\r?\n$/u, ''))
  const routes = content.flatMap((line, index) => /^\s*route\s+\S+/u.test(line) ? [index] : [])
  const firstUav = content.findIndex(line => /^\s*platform mission_uav_01 MISSION_UAV_PLATFORM\s*$/u.test(line))
  expect(firstUav, '缺少 mission_uav_01 实例').toBeGreaterThanOrEqual(0)
  const start = routes.length > 0 ? Math.min(routes[0]!, firstUav) : firstUav
  const jammerStart = content.findIndex((line, index) => index > start && /^\s*platform\s+jammer_station_01\s+GROUND_JAMMER_STATION\s*$/u.test(line))
  expect(jammerStart, '缺少 jammer_station_01').toBeGreaterThan(start)
  let uavEnd = jammerStart - 1
  while (uavEnd > start && !/^\s*end_platform\s*$/u.test(content[uavEnd]!)) uavEnd -= 1
  expect(uavEnd, '缺少无人机段 end_platform').toBeGreaterThanOrEqual(start)
  let jammerEnd = content.length - 1
  while (jammerEnd > jammerStart && !/^\s*end_platform\s*$/u.test(content[jammerEnd]!)) jammerEnd -= 1
  expect(jammerEnd, '缺少干扰源段 end_platform').toBeGreaterThanOrEqual(jammerStart)
  const ending = /\r?\n$/u.exec(records[0] ?? '')?.[0] ?? '\n'
  return [
    ...records.slice(0, start),
    `<MISSION_UAV_SECTION>${ending}`,
    ...records.slice(uavEnd + 1, jammerStart),
    `<JAMMER_SECTION>${ending}`,
    ...records.slice(jammerEnd + 1),
  ].join('')
}

/** 仅遮蔽明确允许变化的区域，保留行尾与其余字节。 */
function maskAllowedRegions(name: string, text: string): string {
  const records = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const output: string[] = []
  let skippingLinkCalc = false
  for (const raw of records) {
    const ending = /\r?\n$/u.exec(raw)?.[0] ?? ''
    const content = raw.slice(0, raw.length - ending.length)
    if (name === 'comm_platform_REAR.txt') {
      if (/^\s*Array<string>\s+(fw_sit_dst|fw_tgt_dst)\s*=/u.test(content)) {
        output.push('<ARRAY>' + ending)
        continue
      }
      if (/^\s*add processor link_calc WSF_LINK_CALC_PROCESSOR\s*$/u.test(content)) {
        skippingLinkCalc = true
        output.push('<LINK_CALC>' + ending)
        continue
      }
      if (skippingLinkCalc) {
        if (/^\s*end_processor\s*$/u.test(content)) skippingLinkCalc = false
        continue
      }
    }
    if (name === 'comm_platform_MISSION_UAV.txt' && /^\s*Array<string>\s+(relayNames|rt_video_dsts|rt_status_dsts)\s*=/u.test(content)) {
      output.push('<ARRAY>' + ending)
      continue
    }
    if (name === 'comm_SimSetup.txt' && /^\s*(?:\/\/)?\s*(realtime|clock_rate|end_time)\b/u.test(content)) {
      if (output.at(-1) !== '<SPEED>' + ending) output.push('<SPEED>' + ending)
      continue
    }
    output.push(raw)
  }
  return output.join('')
}

function directiveValue(lines: readonly string[], directive: string): unknown {
  const line = lines.find(item => item.trimStart().startsWith(`${directive} `))
  expect(line, `缺少 ${directive}`).toBeDefined()
  return JSON.parse(line!.trimStart().slice(directive.length).trim())
}

function linkCalcBlock(text: string): string[] {
  const lines = text.split(/\r?\n/u)
  const start = lines.findIndex(line => /^\s*add processor link_calc WSF_LINK_CALC_PROCESSOR\s*$/u.test(line))
  expect(start).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((line, index) => index > start && /^\s*end_processor\s*$/u.test(line))
  expect(end).toBeGreaterThan(start)
  return lines.slice(start, end + 1)
}

function scriptVariableBlock(text: string, processor: string): string[] {
  const lines = text.split(/\r?\n/u)
  const processorLine = lines.findIndex(line => line.trimStart().startsWith(`processor ${processor} `))
  expect(processorLine).toBeGreaterThanOrEqual(0)
  const start = lines.findIndex((line, index) => index > processorLine && /^\s*script_variables\s*$/u.test(line))
  expect(start).toBeGreaterThan(processorLine)
  const end = lines.findIndex((line, index) => index > start && /^\s*end_script_variables\s*$/u.test(line))
  expect(end).toBeGreaterThan(start)
  return lines.slice(start + 1, end)
}

function arrayNames(block: readonly string[]): string[] {
  return block.flatMap(line => /^\s*Array<string>\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)?.[1] ?? [])
}

describe('1112 固定模板基线', () => {
  it('仓库副本与源模板逐字节一致，哈希写入清单且与运行时资源一致', async () => {
    const copied = (await readdir(TEMPLATE_DIRECTORY)).sort()
    expect(copied).toEqual([...TEMPLATE_FILES].sort())
    const manifest = JSON.parse(await readFile(MANIFEST_FILE, 'utf8')) as { sourceDirectory: string; sha256: Record<string, string>; patches: Array<{ id: string; sourceOccurrences: number }> }
    expect(manifest.sourceDirectory).toContain('afsim_script_lcm_1112')
    expect(manifest.patches).toContainEqual(expect.objectContaining({ id: 'lazer-link-normalization', sourceOccurrences: 0 }))
    for (const name of TEMPLATE_FILES) {
      const bytes = await readFile(join(TEMPLATE_DIRECTORY, name))
      const hash = createHash('sha256').update(bytes).digest('hex').toUpperCase()
      expect(hash, `${name} 与清单哈希不一致`).toBe(manifest.sha256[name])
      expect(templateModule.TEMPLATE_1112_SHA256[name], `${name} 与运行时资源哈希不一致`).toBe(hash)
      expect(templateModule.TEMPLATE_1112_FILES[name], `${name} 运行时解码内容与仓库副本不一致`).toBe(bytes.toString('utf8'))
    }
  })

  it('除明确允许区域外，10 个执行 TXT 去除注释后与模板逐字节一致', async () => {
    const generated = buildMissionPackage(withAllTemplateCommPorts())
    for (const name of TEMPLATE_FILES) {
      const template: string = await readFile(join(TEMPLATE_DIRECTORY, name), 'utf8')
      let expected = name === 'comm_platform_MISSION_UAV.txt'
        ? template.replace(/(\breceiver\r?\n[ \t]*frequency 11\.8 )MHz(?=\r?\n)/u, '$1GHz')
        : template
      if (name === 'comm_platform_REAR.txt' || name === 'comm_platform_MISSION_UAV.txt') {
        expected = expected.replace(/if\s*\(\s*nxts2\s*!=\s*""\s*&&\s*nxts\s*!=\s*"interrupted"\s*\)/gu, match =>
          match.replace(/&&\s*nxts\s*!=/u, '&& nxts2 !='))
      }
      const generatedText = name === 'comm_platform_INS.txt'
        ? maskDynamicInsSections(patchModule.stripScriptComments(generated.files[name]!))
        : maskAllowedRegions(name, patchModule.stripScriptComments(generated.files[name]!))
      const templateText = name === 'comm_platform_INS.txt'
        ? maskDynamicInsSections(patchModule.stripScriptComments(expected))
        : maskAllowedRegions(name, patchModule.stripScriptComments(expected))
      expect(generatedText, `${name} 存在不属于允许区域的差异`).toBe(templateText)
    }
  })

  it.each([undefined, { linkCalc: 'PRESERVE' } as const])('交付及本地运行包修正无人机卫星接收频率，模板原件保持原单位（%j）', runtime => {
    const file = 'comm_platform_MISSION_UAV.txt'
    const satPort = (text: string) => /^\s*comm sat_link WSF_RADIO_TRANSCEIVER\r?\n[\s\S]*?^\s*end_comm\b/mu.exec(text)?.[0]
    expect(satPort(templateModule.TEMPLATE_1112_FILES[file])).toMatch(/\breceiver\r?\n[ \t]*frequency 11\.8 MHz\b/u)
    const generated = buildMissionPackage(withAllTemplateCommPorts(), undefined, runtime).files[file]!
    expect(satPort(generated)).toMatch(/\btransmitter\r?\n[ \t]*frequency 14\.2 GHz\b/u)
    expect(satPort(generated)).toMatch(/\breceiver\r?\n[ \t]*frequency 11\.8 GHz\b/u)
  })

  it('mission_uav 实例段按场景配置生成：数量、位置、航线与返航可配置', () => {
    const base = buildMissionPackage(createTemplateScenario()).files['comm_platform_INS.txt']!
    expect([...base.matchAll(/^platform (mission_uav_\d+) MISSION_UAV_PLATFORM$/gmu)].map(match => match[1])).toEqual(['mission_uav_01', 'mission_uav_02', 'mission_uav_03'])
    expect(base).toContain('position 24.66n 119.55e altitude 3200 m')
    expect(base).toContain('PLATFORM.FollowRoute("return_mission_uav_02")')

    const extra = createTemplateScenario()
    const prototype = extra.config.platforms.find(platform => platform.type === 'AIRBORNE_MISSION_CLUSTER')!
    const added = structuredClone(prototype)
    added.id = 'PLAT-EXTRA'; added.name = '额外无人机'; added.linkIds = []; added.sensorIds = []; added.jammerIds = []
    added.initialPosition = { longitude: 119.9, latitude: 24.9, altitude: 4000 }
    added.waypoints = [{ longitude: 120.5, latitude: 25.1, altitude: 5000, speed: 80, arrivalTime: 0 }]
    delete added.returnPlan
    extra.config.platforms.push(added)
    const generated = buildMissionPackage(extra).files['comm_platform_INS.txt']!
    expect([...generated.matchAll(/^platform (mission_uav_\d+) MISSION_UAV_PLATFORM$/gmu)].map(match => match[1])).toEqual(['mission_uav_01', 'mission_uav_02', 'mission_uav_03', 'mission_uav_04'])
    expect(generated).toContain('platform mission_uav_04 MISSION_UAV_PLATFORM')
    expect(generated).toContain('position 24.9n 119.9e altitude 4000 m speed 80 m/s')
  })

  it('5.x 干扰源实例段按场景配置生成：地面与机载位置、盘旋航线、侦测范围与增减数量可配置', () => {
    const custom = createTemplateScenario()
    const groundStation = custom.config.platforms.find(platform => platform.type === 'GROUND_JAMMER_DETECTION_STATION')!
    groundStation.initialPosition = { longitude: 121.371465, latitude: 24.614799, altitude: 120 }
    groundStation.faction = 'BLUE'
    custom.config.jammers[0]!.detectionRange = 60_000
    const airborne = custom.config.platforms.find(platform => platform.type === 'AIRBORNE_JAMMER_PLATFORM')!
    airborne.initialPosition = { longitude: 119.8, latitude: 24.2, altitude: 4200 }
    airborne.loiterWaypoints = [
      { longitude: 120.1, latitude: 24.2, altitude: 4200, speed: 95 },
      { longitude: 119.8, latitude: 24.5, altitude: 4200, speed: 95 },
      { longitude: 119.5, latitude: 24.2, altitude: 4200, speed: 95 },
    ]
    const secondAirborne = structuredClone(airborne)
    secondAirborne.id = 'AJ-EXTRA'
    secondAirborne.name = '额外机载干扰'
    secondAirborne.jammerIds = []
    custom.config.platforms.push(secondAirborne)

    const generated = buildMissionPackage(custom).files['comm_platform_INS.txt']!
    expect(generated).toContain('platform jammer_station_01 GROUND_JAMMER_STATION')
    expect(generated).toContain('side blue')
    expect(generated).toContain('position 24.614799n 121.371465e altitude 120 m')
    expect(generated).toContain(`double detection_range_nm = ${String(60_000 / 1852)};`)
    expect(generated).toContain('platform jammer_airborne_01 AIRBORNE_JAMMER_PLATFORM')
    expect(generated).toContain('position 24.2n 119.8e altitude 4200 m heading 0 deg speed 95 m/s')
    expect(generated).toContain('position 24.5n 119.8e altitude 4200 m speed 95 m/s turn left')
    expect([...generated.matchAll(/^platform (jammer_airborne_\d+) AIRBORNE_JAMMER_PLATFORM$/gmu)].map(match => match[1])).toEqual(['jammer_airborne_01', 'jammer_airborne_02'])
  })

  it('REAR 只保留 fw_sit_dst / fw_tgt_dst 两个原有数组，不新增路由或端口变量，且行尾无多余反斜杠', () => {
    const rear = buildMissionPackage(createTemplateScenario()).files['comm_platform_REAR.txt']!
    const block = scriptVariableBlock(rear, 'script_proc')
    expect(arrayNames(block)).toEqual(['fw_sit_dst', 'fw_tgt_dst'])
    expect(block.join('\n')).not.toMatch(/\b(fw_sit_next|fw_sit_out|fw_sit_in|fw_sit_size|fw_tgt_next|fw_tgt_out|fw_tgt_in|fw_tgt_size)\b/u)
    expect(rear).not.toMatch(/\\\\\s*$/mu)
    expect(rear.split(/\r?\n/u).filter((line: string) => /Array<string>\s+(fw_sit_dst|fw_tgt_dst)\s*=/u.test(line)).every((line: string) => line.trimEnd().endsWith('};'))).toBe(true)
  })

  it('MISSION_UAV 只保留 relayNames / rt_video_dsts / rt_status_dsts 三个原有数组和 isRelay', () => {
    const uav = buildMissionPackage(createTemplateScenario()).files['comm_platform_MISSION_UAV.txt']!
    const block = scriptVariableBlock(uav, 'script_proc')
    expect(arrayNames(block)).toEqual(['relayNames', 'rt_video_dsts', 'rt_status_dsts'])
    expect(block.filter(line => /^\s*bool\s+/u.test(line))).toEqual(['        bool isRelay = false;'])
    expect(block.join('\n')).not.toMatch(/\b(rt_video_nexts|rt_video_outs|rt_video_ins|rt_video_size|rt_status_nexts|rt_status_outs|rt_status_ins|rt_status_size)\b/u)
  })

  it('link_calc 参数名称、顺序与模板一致，且不输出 jamming_range / end_platform_type', () => {
    const pkg = buildMissionPackage(createTemplateScenario())
    const rear = pkg.files['comm_platform_REAR.txt']!
    const uav = pkg.files['comm_platform_MISSION_UAV.txt']!
    const block = linkCalcBlock(rear)
    const directives = block.flatMap(line => /^ {4}([a-z_]+)\s/u.exec(line)?.[1] ?? [])
    expect(directives).toEqual([
      'update_interval', 'emergency_threshold', 'warning_threshold', 'value_threshold_ber', 'channel_encoding_scheme',
      'traffic_type', 'traffic_distance', 'relay_uav_names', 'hot_link_ret', 'hot_link_fw', 'port_params', 'natural_environment', 'jammer_param',
    ])
    expect(directiveValue(block, 'traffic_distance')).toEqual([
      {
        link_type: 'cl_link',
        distance_set: [
          { dist_seg: 'relay-uav', distance: 60 },
          { dist_seg: 'relay-relay', distance: 200 },
          { dist_seg: 'relay-comand', distance: 240 },
          { dist_seg: 'uav-comand', distance: 240 },
        ],
      },
      { link_type: 'microwave_link', distance: 200 },
      { link_type: 'lazer_link', distance: 40 },
    ])
    expect(rear).toContain('if (nxts != "" && nxts != "interrupted")')
    expect(rear).toContain('if (nxts2 != "" && nxts2 != "interrupted")')
    expect(rear).not.toContain('nxts2 != "" && nxts != "interrupted"')
    expect(uav).toContain('if (nxts != "" && nxts != "interrupted")')
    expect(uav).toContain('if (nxts2 != "" && nxts2 != "interrupted")')
    expect(uav).not.toContain('nxts2 != "" && nxts != "interrupted"')
    expect(block.join('\n')).not.toContain('jamming_range')
    expect(block.join('\n')).not.toContain('end_platform_type')
  })

  it('本机运行包与交付脚本都保留启用的 traffic_distance', () => {
    const draft = createTemplateScenario()
    const file = 'comm_platform_REAR.txt'
    const delivery = linkCalcBlock(buildMissionPackage(draft).files[file]!)
    const local = linkCalcBlock(buildMissionPackage(draft, undefined, { linkCalc: 'PRESERVE' }).files[file]!)
    expect(delivery.some(line => line.trimStart().startsWith('traffic_distance '))).toBe(true)
    expect(local).toEqual(delivery)
  })

  it('场景自定义链路最大传输距离按 1112 模板结构写入交付脚本 traffic_distance', () => {
    const draft = createTemplateScenario()
    draft.config.linkSettings!.linkCalc = {
      ...draft.config.linkSettings!.linkCalc!,
      trafficDistance: {
        relayUavKm: 85,
        relayRelayKm: 210,
        relayCommandKm: 260,
        uavCommandKm: 250,
        microwaveKm: 180,
        laserKm: 55,
      },
    }
    const block = linkCalcBlock(buildMissionPackage(draft).files['comm_platform_REAR.txt']!)
    expect(directiveValue(block, 'traffic_distance')).toEqual([
      {
        link_type: 'cl_link',
        distance_set: [
          { dist_seg: 'relay-uav', distance: 85 },
          { dist_seg: 'relay-relay', distance: 210 },
          { dist_seg: 'relay-comand', distance: 260 },
          { dist_seg: 'uav-comand', distance: 250 },
        ],
      },
      { link_type: 'microwave_link', distance: 180 },
      { link_type: 'lazer_link', distance: 55 },
    ])
  })

  it('激光端口声明、port_params 与引用统一为 lazer_link，不保留 laser_link', () => {
    const generated = buildMissionPackage(withAllTemplateCommPorts())
    const all = Object.entries(generated.files).filter(([name]) => name.endsWith('.txt')).map(([, content]) => content).join('\n')
    expect(all).not.toMatch(/\blaser_link\b/u)
    const uav = generated.files['comm_platform_MISSION_UAV.txt']!
    expect(uav).toContain('comm lazer_link WSF_RADIO_TRANSCEIVER')
    expect(uav).toContain('antenna_pattern LASER_COMM_ANTENNA')
    const portParams = directiveValue(linkCalcBlock(generated.files['comm_platform_REAR.txt']!), 'port_params') as Array<{ platform_type: string; comm_params: Array<{ comm_name: string }> }>
    const mission = portParams.find(item => item.platform_type === 'MISSION_UAV_PLATFORM')!
    expect(mission.comm_params.map(item => item.comm_name)).toContain('lazer_link')
    expect(mission.comm_params.map(item => item.comm_name)).not.toContain('laser_link')
    // 模板中的 lazer_link 收发参数未被改动；EIRP/G_T 直接采用端口配置值。
    const lazer = mission.comm_params.find(item => item.comm_name === 'lazer_link') as unknown as { transmitter: Record<string, number>; receiver: Record<string, number> }
    expect(lazer.transmitter).toMatchObject({ frequency_ghz: 193500, bandwidth_mhz: 1000, power_w: 0.1, eirp_dBW: 0, peak_gain_dB: 45, 'information_rate_bit/s': 2_500_000_000 })
    expect(lazer.receiver).toMatchObject({ frequency_ghz: 681300, noise_figure_dB: 5, 'G_T_dBK': 0 })
  })

  it('区域定位必须唯一：缺失或重复标记时明确报错，不使用第一个匹配', () => {
    expect(() => patchModule.replaceArrayValues('script_variables\nend_script_variables', 'comm_platform_REAR.txt', 'fw_sit_dst', [])).toThrow(/定位失败/u)
    expect(() => patchModule.replaceArrayValues('  Array<string> fw_sit_dst = { "a" };\n  Array<string> fw_sit_dst = { "b" };', 'comm_platform_REAR.txt', 'fw_sit_dst', [])).toThrow(/匹配到 2 处/u)
    expect(() => patchModule.replaceLinkCalcBlock('  processor script_proc WSF_SCRIPT_PROCESSOR\n  end_processor', 'comm_platform_REAR.txt', ['  add processor link_calc WSF_LINK_CALC_PROCESSOR', '  end_processor'])).toThrow(/未找到 add processor link_calc/u)
    expect(() => patchModule.replaceSimulationSpeed('realtime\nrealtime\nclock_rate 2', 'comm_SimSetup.txt', true, 2)).toThrow(/匹配到 2 处/u)
    expect(() => patchModule.replaceSimulationSpeed('realtime\nclock_rate 2', 'comm_SimSetup.txt', true, 0)).toThrow(/倍速必须/u)
    expect(() => patchModule.replaceJammerSection('platform rear_comm_vehicle REAR_COMM_PLATFORM\nend_platform', 'comm_platform_INS.txt', ['// 5.x 干扰源配置'])).toThrow(/定位失败/u)
    expect(() => patchModule.replaceJammerSection('// 5.x 干扰源配置\n// 5.x 干扰源配置\nend_platform', 'comm_platform_INS.txt', ['// 5.x 干扰源配置'])).toThrow(/匹配到 2 处/u)
  })
})

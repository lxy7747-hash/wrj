// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { allTemplateCommPorts, deriveCommPortsFromLinks } from '../../src/features/scenarios/template-defaults'
import { createRenamedTemplateScenario, createTemplateScenario } from '../fixtures/template-scenario'

function withAllTemplateCommPorts() {
  const draft = createTemplateScenario()
  draft.config.deviceParameters = { ...draft.config.deviceParameters, commPorts: allTemplateCommPorts() }
  return draft
}

const { buildMissionPackage, MissionGenerationError } = await import('../../server/scripts/' + 'mission-generator.js')
const { stripScriptComments } = await import('../../server/scripts/' + 'afsim-template-patch.js')
const { readFile } = await import('node:' + 'fs/promises')
const { dirname, join } = await import('node:' + 'path')
const { fileURLToPath } = await import('node:' + 'url')

const TEMPLATE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'afsim-template-1112')
const FIXED_FILES = [
  'comm_PerDefinition.txt', 'comm_platform_COMMAND_VEHICLE.txt',
  'comm_platform_JAMMER.txt', 'comm_platform_SAT.txt', 'observers.txt', 'ad_hoc_comm.txt',
] as const

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function rearLinkCalc(pkg: { files: Record<string, string> }): string[] {
  const lines = pkg.files['comm_platform_REAR.txt']!.split(/\r?\n/u)
  const start = lines.findIndex(line => /^\s*add processor link_calc WSF_LINK_CALC_PROCESSOR\s*$/u.test(line))
  expect(start).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((line, index) => index > start && /^\s*end_processor\s*$/u.test(line))
  expect(end).toBeGreaterThan(start)
  return lines.slice(start, end + 1)
}

function directive<T = Json>(pkg: { files: Record<string, string> }, name: string): T {
  const line = rearLinkCalc(pkg).find(item => item.trimStart().startsWith(`${name} `))
  expect(line, `缺少 ${name}`).toBeDefined()
  return JSON.parse(line!.trimStart().slice(name.length).trim()) as T
}

function scalarDirective(pkg: { files: Record<string, string> }, name: string): string {
  const line = rearLinkCalc(pkg).find(item => item.trimStart().startsWith(`${name} `))
  expect(line, `缺少 ${name}`).toBeDefined()
  return line!.trimStart().slice(name.length).trim()
}

type PortParams = Array<{ platform_type: string; comm_params: Array<{ comm_name: string; transmitter: Record<string, number>; receiver: Record<string, number> }> }>
function portParam(pkg: { files: Record<string, string> }, platformType: string, port: string) {
  const params = directive<PortParams>(pkg, 'port_params')
  const platform = params.find(item => item.platform_type === platformType)
  expect(platform, `缺少平台类型 ${platformType}`).toBeDefined()
  const value = platform!.comm_params.find(item => item.comm_name === port)
  expect(value, `缺少端口 ${platformType}.${port}`).toBeDefined()
  return value!
}

function arrayValues(pkg: { files: Record<string, string> }, file: string, name: string): string[] {
  const line = pkg.files[file]!.split(/\r?\n/u).find(item => new RegExp(`^\\s*Array<string>\\s+${name}\\s*=`, 'u').test(item))
  expect(line, `缺少数组 ${name}`).toBeDefined()
  const literal = /\{([^}]*)\}/u.exec(line!)?.[1] ?? ''
  return [...literal.matchAll(/"([^"]*)"/gu)].map(match => match[1]!)
}

/** 只遮蔽允许变化区域，保留其余行与行尾，避免用宽泛过滤掩盖固定内容差异。 */
function maskAllowed(name: string, text: string): string {
  const lines = text.split(/(?<=\n)/u)
  const output: string[] = []
  let skippingLinkCalc = false
  for (const raw of lines) {
    const content = raw.replace(/\r?\n$/u, '')
    if (name === 'comm_platform_REAR.txt') {
      if (/^\s*Array<string>\s+(fw_sit_dst|fw_tgt_dst)\s*=/u.test(content)) { output.push('<ARRAY>\n'); continue }
      if (/^\s*add processor link_calc WSF_LINK_CALC_PROCESSOR\s*$/u.test(content)) { skippingLinkCalc = true; output.push('<LINK_CALC>\n'); continue }
      if (skippingLinkCalc) { if (/^\s*end_processor\s*$/u.test(content)) skippingLinkCalc = false; continue }
    }
    if (name === 'comm_platform_MISSION_UAV.txt' && /^\s*Array<string>\s+(relayNames|rt_video_dsts|rt_status_dsts)\s*=/u.test(content)) { output.push('<ARRAY>\n'); continue }
    if (name === 'comm_SimSetup.txt' && /^\s*(?:\/\/)?\s*(realtime|clock_rate|end_time)\b/u.test(content)) {
      if (output.at(-1) !== '<SPEED>\n') output.push('<SPEED>\n')
      continue
    }
    output.push(raw)
  }
  return output.join('')
}

function speedLines(pkg: { files: Record<string, string> }): string[] {
  return pkg.files['comm_SimSetup.txt']!.split(/\r?\n/u).filter(line => /^(?:\/\/)?(?:realtime|clock_rate)\b/u.test(line))
}

describe('1112 固定模板 + 受控替换生成器', () => {
  it('生成 10 个执行 TXT、metadata 与固定文件；固定文件逐字节等于 1112 模板', async () => {
    const generated = buildMissionPackage(withAllTemplateCommPorts())
    for (const name of [
      'ad_hoc_comm.txt', 'comm_PerDefinition.txt', 'comm_platform_COMMAND_VEHICLE.txt', 'comm_platform_INS.txt',
      'comm_platform_JAMMER.txt', 'comm_platform_MISSION_UAV.txt', 'comm_platform_REAR.txt', 'comm_platform_SAT.txt',
      'comm_SimSetup.txt', 'observers.txt', 'scenario.txt', 'mapping.json', 'input.json', 'README.txt',
    ]) expect(generated.files, name).toHaveProperty(name)
    for (const name of FIXED_FILES) {
      const template = await readFile(join(TEMPLATE_DIRECTORY, name), 'utf8')
      expect(generated.files[name], `${name} 去除注释后应与模板一致`).toBe(stripScriptComments(template))
    }
    expect(generated.manifest.template.sha256).toEqual(expect.objectContaining({ 'comm_platform_REAR.txt': expect.any(String) }))
    expect(generated.manifest.template.source).toContain('afsim_script_lcm_1112')
  })

  it('生成的执行脚本不保留注释', () => {
    for (const draft of [createTemplateScenario(), createRenamedTemplateScenario()]) {
      const generated = buildMissionPackage(draft)
      for (const name of generated.manifest.scriptFiles) {
        const text = generated.files[name]
        expect(typeof text, name).toBe('string')
        // stripScriptComments 幂等：已去除注释的脚本再次处理应完全不变。
        expect(stripScriptComments(text!), `${name} 仍含 // 注释`).toBe(text)
        expect(text, `${name} 仍含模板注释关键字`).not.toContain('写死')
        expect(text, `${name} 仍含装饰注释`).not.toContain('──')
        expect(text, `${name} 仍含块注释起始符`).not.toContain('/*')
        expect(text, `${name} 仍含块注释结束符`).not.toContain('*/')
      }
    }
  })

  it('commPorts 清单决定生成的端口数量和 port_params', () => {
    const draft = createTemplateScenario()
    const radio = { deviceType: 'WSF_RADIO_TRANSCEIVER' as const, network: 'COM_MESH_NET' }
    const fiber = { deviceType: 'WSF_COMM_TRANSCEIVER' as const, network: 'FIBER_NET' }
    draft.config.deviceParameters = {
      commPorts: {
        MISSION_UAV_PLATFORM: { microwave_link: radio, c_band_uplink: radio, c_band_downlink: radio },
        COMMAND_VEHICLE_PLATFORM: { c_band_uplink: radio, c_band_downlink: radio, fiber_link: fiber },
        REAR_COMM_PLATFORM: { sat_link_a: radio, microwave_link: radio, fiber_link: fiber },
        TIAN_TONG_SAT: { sat_link: radio },
        SHEN_TONG_SAT: {},
      },
    }
    const pkg = buildMissionPackage(draft)
    const ports = (file: string) => [...pkg.files[file]!.matchAll(/^\s+comm (\S+) WSF_\w+/gmu)].map(match => match[1]!)
    expect(ports('comm_platform_REAR.txt')).toEqual(['sat_link_a', 'microwave_link', 'fiber_link'])
    expect(ports('comm_platform_COMMAND_VEHICLE.txt')).toEqual(['c_band_uplink', 'c_band_downlink', 'fiber_link'])
    expect(ports('comm_platform_MISSION_UAV.txt')).toEqual(['microwave_link', 'c_band_uplink', 'c_band_downlink'])
    expect(ports('comm_platform_SAT.txt')).toEqual(['sat_link'])
    const rear = pkg.files['comm_platform_REAR.txt']!
    const line = rear.split(/\r?\n/u).find((item: string) => item.includes('port_params '))!
    const params = JSON.parse(line.slice(line.indexOf('port_params ') + 'port_params '.length).trim()) as Array<{ platform_type: string; comm_params: Array<{ comm_name: string }> }>
    expect(params.map((item: { platform_type: string; comm_params: Array<{ comm_name: string }> }) => [item.platform_type, item.comm_params.map((port: { comm_name: string }) => port.comm_name)])).toEqual([
      ['MISSION_UAV_PLATFORM', ['microwave_link', 'c_band_uplink', 'c_band_downlink']],
      ['COMMAND_VEHICLE_PLATFORM', ['c_band_uplink', 'c_band_downlink', 'fiber_link']],
      ['REAR_COMM_PLATFORM', ['sat_link_a', 'microwave_link', 'fiber_link']],
      ['TIAN_TONG_SAT', ['sat_link']],
    ])
  })

  it('场景配置变化只影响允许区域，不泄漏到固定 TXT', async () => {
    const baseline = buildMissionPackage(createTemplateScenario())
    const changed = createTemplateScenario()
    changed.config.linkSettings!.linkCalc = { updateIntervalS: 7, emergencyThreshold: 2e-5, warningThreshold: 3e-6, valueThresholdBer: 4e-7, jammingRangeKm: 55, channelEncodingScheme: 5 }
    changed.config.linkSettings!.messageIntervalS = 9
    changed.config.scenario.environment.rainRateMmPerHour = 50
    changed.config.scenario.environment.seaState = 5
    changed.config.jammers[0]!.frequency = 2450
    changed.config.jammers[0]!.bandwidth = 400
    changed.config.jammers[0]!.defaultPower = 0.1
    changed.config.jammers[0]!.detectionRange = 60_000
    changed.config.jammers[0]!.jammingRange = 20 * 1852
    changed.config.informationDemand[0]!.volumeMb = 999 / 8_000_000
    changed.config.informationDemand[0]!.frequencyHz = 7
    changed.config.scenario.realtime = false
    changed.config.scenario.environment.simClockSpeed = 32
    const modified = buildMissionPackage(changed)
    for (const name of ['comm_PerDefinition.txt', 'comm_platform_COMMAND_VEHICLE.txt', 'comm_platform_INS.txt', 'comm_platform_JAMMER.txt', 'comm_platform_SAT.txt', 'observers.txt', 'ad_hoc_comm.txt']) {
      expect(modified.files[name], `${name} 不应被配置变化改写`).toBe(baseline.files[name])
    }
    // REAR/MISSION_UAV/SimSetup 的固定区域同样不变；只允许数组、link_calc、倍速行变化。
    for (const name of ['comm_platform_REAR.txt', 'comm_platform_MISSION_UAV.txt', 'comm_SimSetup.txt']) {
      expect(maskAllowed(name, modified.files[name]!), `${name} 固定区域被配置变化改写`).toBe(maskAllowed(name, baseline.files[name]!))
    }
    expect(scalarDirective(modified, 'update_interval')).toBe('7 sec')
    expect(scalarDirective(modified, 'emergency_threshold')).toBe('2e-5')
    expect(scalarDirective(modified, 'warning_threshold')).toBe('3e-6')
    expect(scalarDirective(modified, 'value_threshold_ber')).toBe('4e-7')
    expect(scalarDirective(modified, 'channel_encoding_scheme')).toBe('5')
    expect(portParam(modified, 'MISSION_UAV_PLATFORM', 'c_band_uplink').transmitter.power_w).toBe(20)
    const ground = directive<{ jammers: Array<Record<string, Json>> }>(modified, 'jammer_param').jammers[0]!
    expect(ground).toMatchObject({ frequency_ghz: 2.4, bandwidth_mhz: 1, power_w: 1000, weapon_frequency_ghz: 2.45, weapon_bandwidth_mhz: 400, weapon_power_w: 0.1, detect_radius_nm: 60_000 / 1852, trigger_radius_nm: 20 })
    const traffic = directive<Array<Record<string, { forward: Array<{ data_volume_bits: number; trans_freq: number }> }>>>(modified, 'traffic_type')
    expect(traffic[0]!.mission_uav_02!.forward[0]).toMatchObject({ data_volume_bits: 999, trans_freq: 7 })
    const natural = directive<Record<string, Json>>(modified, 'natural_environment')
    expect(natural.rain).toMatchObject({ rain_rate_mm_hr: 50 })
    expect(natural.sea_state).toMatchObject({ sea_state_level: 5 })
  })

  it('热链显式变化进入 hot_link_fw / hot_link_ret，固定区域不变', () => {
    const draft = createTemplateScenario()
    draft.config.linkSettings!.hotLinks = {
      forward: [['fiber_forward', 'c_forward_uav2']],
      reverse: [['c_return_uav2', 'fiber_return']],
      endPlatformType: 'REAR_COMMAND_NODE',
    }
    const pkg = buildMissionPackage(draft)
    expect(directive(pkg, 'hot_link_fw')).toEqual({
      link1: [{ platform: 'rear_comm_vehicle', inPort: '', outPort: 'fiber_link' }, { platform: 'command_vehicle', inPort: 'fiber_link', outPort: 'c_band_uplink' }, { platform: 'mission_uav_02', inPort: 'c_band_uplink', outPort: '' }],
    })
    expect(directive(pkg, 'hot_link_ret')).toEqual({
      link1: [{ platform: 'mission_uav_02', inPort: '', outPort: 'c_band_downlink' }, { platform: 'command_vehicle', inPort: 'c_band_downlink', outPort: 'fiber_link' }, { platform: 'rear_comm_vehicle', inPort: 'fiber_link', outPort: '' }],
    })
  })

  it('不同无人机返向目的地时准确报告共享数组限制，不静默按第一条业务处理', () => {
    const draft = createTemplateScenario()
    draft.config.informationDemand.find(item => item.id === 'uav2_return_video')!.destinationPlatformIds = ['command_vehicle']
    const pkg = buildMissionPackage(draft)
    expect(pkg.manifest.warnings).toContainEqual(expect.stringContaining('rt_video_dsts 是类型级共享数组'))
    expect(arrayValues(pkg, 'comm_platform_MISSION_UAV.txt', 'rt_video_dsts')).toEqual(['command_vehicle', 'rear_comm_vehicle'])
  })

  it('LinkCalc 映射：周期/阈值/编码、业务、热链、端口、环境、干扰均来自场景配置', () => {
    const pkg = buildMissionPackage(createTemplateScenario())
    expect(scalarDirective(pkg, 'update_interval')).toBe('5 sec')
    expect(scalarDirective(pkg, 'emergency_threshold')).toBe('1e-5')
    expect(scalarDirective(pkg, 'warning_threshold')).toBe('1e-6')
    expect(scalarDirective(pkg, 'value_threshold_ber')).toBe('1e-7')
    expect(scalarDirective(pkg, 'channel_encoding_scheme')).toBe('0')
    const traffic = directive<Array<Record<string, { forward: Array<{ traffice_type: string; data_volume_bits: number; trans_freq: number }>; return: Array<{ traffice_type: string; data_volume_bits: number; trans_freq: number }> }>>>(pkg, 'traffic_type')
    expect(traffic.map(item => Object.keys(item)[0])).toEqual(['mission_uav_02', 'mission_uav_03'])
    expect(traffic[0]!.mission_uav_02!.forward).toEqual([
      { traffice_type: 'kForwardSituation', data_volume_bits: 256, trans_freq: 5 },
      { traffice_type: 'kForwardTarget', data_volume_bits: 512, trans_freq: 10 },
    ])
    expect(traffic[0]!.mission_uav_02!.return).toEqual([
      { traffice_type: 'kReturnReconVideo', data_volume_bits: 8192, trans_freq: 3 },
      { traffice_type: 'kReturnReconStatus', data_volume_bits: 512, trans_freq: 10 },
    ])
    expect(traffic[1]!.mission_uav_03!.forward[1]!.data_volume_bits).toBe(128)
    expect(directive(pkg, 'relay_uav_names')).toEqual(['mission_uav_01'])
    expect(directive(pkg, 'hot_link_ret')).toEqual({
      link1: [{ platform: 'mission_uav_02', inPort: '', outPort: 'c_band_downlink' }, { platform: 'command_vehicle', inPort: 'c_band_downlink', outPort: 'fiber_link' }, { platform: 'rear_comm_vehicle', inPort: 'fiber_link', outPort: '' }],
      link2: [{ platform: 'mission_uav_03', inPort: '', outPort: 'c_band_downlink' }, { platform: 'command_vehicle', inPort: 'c_band_downlink', outPort: 'fiber_link' }, { platform: 'rear_comm_vehicle', inPort: 'fiber_link', outPort: '' }],
    })
    expect(portParam(pkg, 'MISSION_UAV_PLATFORM', 'c_band_uplink').transmitter).toMatchObject({ frequency_ghz: 4.5, bandwidth_mhz: 10, power_w: 20 })
    expect(portParam(pkg, 'COMMAND_VEHICLE_PLATFORM', 'fiber_link').transmitter).toEqual({ 'information_rate_bit/s': 1_000_000_000 })
    const natural = directive<Record<string, Json>>(pkg, 'natural_environment')
    expect(natural.rain).toMatchObject({ enabled: true, rain_rate_mm_hr: 10, rain_altitude_limit_m: 3000, rain_attenuation_db: 0 })
    expect(natural.sea_state).toMatchObject({ enabled: true, sea_state_level: 3, mode: 'coarse', sea_water_temp_c: 20 })
    expect(natural.atmosphere).toMatchObject({ model: 'itu', simplified_attenuation_db_per_km: 0.02 })
    const jammers = directive<{ jammers: Array<Record<string, Json>> }>(pkg, 'jammer_param').jammers
    expect(jammers.map(item => item.platform_name)).toEqual(['jammer_station_01', 'jammer_airborne_01'])
    expect(jammers[0]).toMatchObject({ weapon_name: 'prophet_jammer', jammer_type: 'ground', G_T_dBK: 0, frequency_ghz: 2.4, bandwidth_mhz: 1, power_w: 1000, weapon_eirp_dBW: 0, weapon_antenna_gain_dbi: 30 })
    expect(jammers[1]).toMatchObject({ weapon_name: 'alq99_jammer', jammer_type: 'airborne', G_T_dBK: 0, weapon_eirp_dBW: 0, weapon_antenna_gain_dbi: 25, trigger_radius_nm: 10, release_radius_nm: 15 })
  })

  it('设备端口参数只进入 link_calc port_params，不改写固定 comm / 天线定义', async () => {
    const draft = createTemplateScenario()
    draft.config.deviceParameters = {
      commPorts: allTemplateCommPorts(),
      ports: {
        // l_band_uplink 未被任何链路绑定，用来验证设备参数只进入 port_params。
        MISSION_UAV_PLATFORM: {
          l_band_uplink: { txFrequency: 1550, txBandwidth: 7, txPower: 11, rxFrequency: 1550, rxBandwidth: 7, transferRate: 0.02, noiseFigureDb: 4 },
        },
      },
      antennaGains: { LASER_COMM_ANTENNA: 33 },
    }
    const pkg = buildMissionPackage(draft)
    expect(portParam(pkg, 'MISSION_UAV_PLATFORM', 'l_band_uplink').transmitter).toMatchObject({ frequency_ghz: 1.55, bandwidth_mhz: 7, power_w: 11 })
    expect(portParam(pkg, 'MISSION_UAV_PLATFORM', 'lazer_link').transmitter.peak_gain_dB).toBe(33)
    expect(pkg.files['comm_platform_MISSION_UAV.txt']).toContain('frequency 1.5 GHz')
    expect(pkg.files['comm_platform_MISSION_UAV.txt']).toContain('power 10 W')
    expect(stripScriptComments(await readFile(join(TEMPLATE_DIRECTORY, 'comm_PerDefinition.txt'), 'utf8'))).toBe(pkg.files['comm_PerDefinition.txt'])
    const adoption = pkg.manifest.executionStatus.portAdoption as Array<{ comm: unknown; portParams: unknown; note: string }>
    expect(adoption.every(item => item.comm === null)).toBe(true)
    expect(adoption.some(item => item.portParams !== null)).toBe(true)
  })

  it('同名端口的多条链路显式值冲突时阻断并定位，不采用不透明覆盖顺序', () => {
    const draft = createTemplateScenario()
    draft.config.links.find(link => link.id === 'c_forward_uav2')!.frequency = 4501
    draft.config.links.find(link => link.id === 'c_forward_uav3')!.frequency = 4502
    expect(() => buildMissionPackage(draft)).toThrow(MissionGenerationError)
    try { buildMissionPackage(draft) } catch (error) { expect((error as InstanceType<typeof MissionGenerationError>).fieldPath).toMatch(/^links\[/u) }
  })

  it('多无人机业务按目的地和数据量分别写入，不静默使用第一条业务值', () => {
    const pkg = buildMissionPackage(createTemplateScenario())
    const traffic = directive<Array<Record<string, { forward: Array<{ data_volume_bits: number }>; return: Array<{ data_volume_bits: number }> }>>>(pkg, 'traffic_type')
    expect(traffic[0]!.mission_uav_02!.forward.map(item => item.data_volume_bits)).toEqual([256, 512])
    expect(traffic[1]!.mission_uav_03!.forward.map(item => item.data_volume_bits)).toEqual([256, 128])
    expect(traffic[0]!.mission_uav_02!.return.map(item => item.data_volume_bits)).toEqual([8192, 512])
    expect(traffic[1]!.mission_uav_03!.return.map(item => item.data_volume_bits)).toEqual([4096, 256])
    expect(arrayValues(pkg, 'comm_platform_REAR.txt', 'fw_sit_dst')).toEqual(['mission_uav_02', 'mission_uav_03'])
    expect(arrayValues(pkg, 'comm_platform_REAR.txt', 'fw_tgt_dst')).toEqual(['mission_uav_02', 'mission_uav_03'])
    expect(arrayValues(pkg, 'comm_platform_MISSION_UAV.txt', 'relayNames')).toEqual(['mission_uav_01'])
    expect(arrayValues(pkg, 'comm_platform_MISSION_UAV.txt', 'rt_video_dsts')).toEqual(['rear_comm_vehicle'])
    expect(arrayValues(pkg, 'comm_platform_MISSION_UAV.txt', 'rt_status_dsts')).toEqual(['rear_comm_vehicle'])
  })

  it.each([
    ['全速', false, 32, ['clock_rate 32']],
    ['x1', undefined, 1, ['realtime', 'clock_rate 1']],
    ['x2', undefined, 2, ['realtime', 'clock_rate 2']],
    ['x4', undefined, 4, ['realtime', 'clock_rate 4']],
    ['x8', undefined, 8, ['realtime', 'clock_rate 8']],
    ['x16', undefined, 16, ['realtime', 'clock_rate 16']],
    ['x32', undefined, 32, ['realtime', 'clock_rate 32']],
  ] as const)('倍速 %s：只改 comm_SimSetup 的 realtime / clock_rate', (_label, realtime, clock, expected) => {
    const draft = createTemplateScenario()
    if (realtime === false) draft.config.scenario.realtime = false
    else delete draft.config.scenario.realtime
    draft.config.scenario.environment.simClockSpeed = clock
    const pkg = buildMissionPackage(draft)
    expect(speedLines(pkg)).toEqual(expected)
    expect(pkg.manifest.speed).toMatchObject({ realtimeEnabled: realtime !== false, clockRate: clock })
    // 全速与 x32 的 clock_rate 相同，但 realtime 状态必须不同。
    if (clock === 32) expect(pkg.manifest.speed.option).toBe(realtime === false ? 'full' : 'x32')
  })

  it('旧场景缺省倍速沿用 clock_rate 2 / realtime 启用；非实时旧组合按原值保留；非法值报错', () => {
    const draft = createTemplateScenario()
    delete draft.config.scenario.realtime
    delete draft.config.scenario.environment.simClockSpeed
    expect(speedLines(buildMissionPackage(draft))).toEqual(['realtime', 'clock_rate 2'])
    expect(buildMissionPackage(draft).manifest.speed.option).toBe('x2')
    draft.config.scenario.realtime = false
    draft.config.scenario.environment.simClockSpeed = 2
    expect(speedLines(buildMissionPackage(draft))).toEqual(['clock_rate 2'])
    expect(buildMissionPackage(draft).manifest.speed.option).toBe('legacy')
    draft.config.scenario.environment.simClockSpeed = 0
    expect(() => buildMissionPackage(draft)).toThrow(/倍速必须大于 0/u)
  })

  it('场景超出固定实例范围时动态生成 mission_uav 实例；非无人机类型超限仍明确报错', () => {
    const extraUav = createTemplateScenario()
    extraUav.config.platforms.push({
      ...structuredClone(extraUav.config.platforms.find(item => item.type === 'AIRBORNE_MISSION_CLUSTER')!),
      id: 'extra_uav', name: '额外无人机', linkIds: [], sensorIds: [], jammerIds: [],
    })
    const extraPackage = buildMissionPackage(extraUav)
    expect(extraPackage.files['comm_platform_INS.txt']).toContain('platform mission_uav_04 MISSION_UAV_PLATFORM')
    expect([...extraPackage.files['comm_platform_INS.txt']!.matchAll(/^platform (mission_uav_\d+) MISSION_UAV_PLATFORM$/gmu)]).toHaveLength(4)
    expect(extraPackage.manifest.templateInstances.mapped).toContainEqual(expect.objectContaining({ platformId: 'extra_uav', name: 'mission_uav_04' }))

    const duplicateRear = createTemplateScenario()
    duplicateRear.config.platforms.push({
      ...structuredClone(duplicateRear.config.platforms.find(item => item.type === 'REAR_COMMAND_NODE')!),
      id: 'extra_rear', name: '额外后方车', linkIds: [], sensorIds: [], jammerIds: [],
    })
    expect(() => buildMissionPackage(duplicateRear)).toThrow(/后方指挥节点当前场景不能超过 1 个/u)

    const invalidReference = createTemplateScenario()
    invalidReference.config.informationDemand[0]!.destinationPlatformIds = ['not_a_template_instance']
    expect(() => buildMissionPackage(invalidReference)).toThrow(MissionGenerationError)

    const invalidHotLink = createTemplateScenario()
    invalidHotLink.config.linkSettings!.hotLinks!.forward[0] = ['missing_link']
    expect(() => buildMissionPackage(invalidHotLink)).toThrow(/热链引用/u)
  })

  it('mapping 区分 mission_uav 的可配置位置/航线与非无人机实例快照', () => {
    const draft = createTemplateScenario()
    const pkg = buildMissionPackage(draft)
    const emitted = pkg.manifest.executionStatus.emitted as Array<{ fieldPath: string; detail: string }>
    const retained = pkg.manifest.executionStatus.retainedSnapshot as Array<{ fieldPath: string; detail: string }>
    const uavIndex = draft.config.platforms.findIndex(platform => platform.type === 'AIRBORNE_MISSION_CLUSTER')
    expect(uavIndex).toBeGreaterThan(0)
    expect(emitted.some(item => item.fieldPath === 'scenario.startTime')).toBe(false)
    expect(emitted.some(item => item.fieldPath === `platforms[${uavIndex}].waypoints`)).toBe(true)
    expect(emitted.some(item => item.fieldPath === `platforms[${uavIndex}].initialPosition`)).toBe(true)
    expect(retained).toContainEqual(expect.objectContaining({ fieldPath: 'scenario.startTime' }))
    expect(retained).toContainEqual(expect.objectContaining({ fieldPath: 'platforms[0].initialPosition' }))
    expect(retained.some(item => item.fieldPath === `platforms[${uavIndex}].initialPosition`)).toBe(false)
    expect(pkg.manifest.linkCalc.jammingRangeEmitted).toBe(false)
    expect(pkg.manifest.template.sha256).toBeTruthy()
    expect(pkg.manifest.templateInstances.fixed).toHaveLength(9)
    expect(pkg.manifest.templateInstances.mapped).toHaveLength(9)
    const motion = pkg.manifest.motion as Array<{ platformId: string; templateFixed: boolean }>
    expect(motion.find(item => item.platformId === 'mission_uav_02')?.templateFixed).toBe(false)
  })

  it('改名、乱序后的场景仍映射到固定实例，且业务/热链/干扰引用一致', () => {
    const pkg = buildMissionPackage(createRenamedTemplateScenario())
    expect(pkg.manifest.platforms).toContainEqual(expect.objectContaining({ platformId: 'PLAT-003', name: 'mission_uav_02' }))
    expect(arrayValues(pkg, 'comm_platform_REAR.txt', 'fw_sit_dst')).toEqual(['mission_uav_02', 'mission_uav_03'])
    expect(arrayValues(pkg, 'comm_platform_MISSION_UAV.txt', 'relayNames')).toEqual(['mission_uav_01'])
    const traffic = directive<Array<Record<string, unknown>>>(pkg, 'traffic_type')
    expect(traffic.map(item => Object.keys(item)[0])).toEqual(['mission_uav_02', 'mission_uav_03'])
    expect(directive<{ jammers: Array<{ platform_name: string }> }>(pkg, 'jammer_param').jammers.map(item => item.platform_name)).toEqual(['jammer_station_01', 'jammer_airborne_01'])
  })

  it('未显式配置 commPorts 时自动从已启用链路推导端口，典型 50 节点场景仅输出使用端口', async () => {
    const raw = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'SCN-TYPICAL-20261113-50NODES.json'), 'utf8')
    const snapshot = JSON.parse(raw) as { config: ReturnType<typeof createTemplateScenario>['config']; uiExtensions: ReturnType<typeof createTemplateScenario>['uiExtensions'] }
    expect(snapshot.config.deviceParameters?.commPorts).toBeUndefined()
    const derived = deriveCommPortsFromLinks(snapshot.config)
    expect(Object.keys(derived.MISSION_UAV_PLATFORM ?? {})).toEqual(['microwave_link', 'c_band_uplink', 'c_band_downlink', 'lazer_link'])
    expect(Object.keys(derived.COMMAND_VEHICLE_PLATFORM ?? {})).toEqual(['c_band_uplink', 'c_band_downlink', 'fiber_link'])
    expect(Object.keys(derived.REAR_COMM_PLATFORM ?? {})).toEqual(['sat_link_a', 'microwave_link', 'fiber_link'])
    expect(Object.keys(derived.TIAN_TONG_SAT ?? {})).toEqual(['sat_link'])
    expect(Object.keys(derived.SHEN_TONG_SAT ?? {})).toEqual([])

    const pkg = buildMissionPackage({ config: snapshot.config, uiExtensions: snapshot.uiExtensions })
    const ports = (file: string) => [...pkg.files[file]!.matchAll(/^\s+comm (\S+) WSF_\w+/gmu)].map(match => match[1]!)
    expect(ports('comm_platform_MISSION_UAV.txt')).toEqual(['microwave_link', 'c_band_uplink', 'c_band_downlink', 'lazer_link'])
    expect(ports('comm_platform_COMMAND_VEHICLE.txt')).toEqual(['c_band_uplink', 'c_band_downlink', 'fiber_link'])
    expect(ports('comm_platform_REAR.txt')).toEqual(['sat_link_a', 'microwave_link', 'fiber_link'])
    expect(ports('comm_platform_SAT.txt')).toEqual(['sat_link'])
  })

  it('过滤 COMMAND_VEHICLE_PLATFORM.fiber_link 时同步移除 report_to commander via fiber_link，且准确标记 NOT_EMITTED / configuredNotEmitted', () => {
    const draft = createTemplateScenario()
    draft.config.links = draft.config.links.filter(link => link.type !== 'FIBER')
    for (const platform of draft.config.platforms) {
      platform.linkIds = platform.linkIds.filter(id => draft.config.links.some(link => link.id === id))
    }
    delete draft.config.linkSettings?.hotLinks
    draft.config.deviceParameters = {
      ports: {
        MISSION_UAV_PLATFORM: {
          l_band_uplink: { txFrequency: 1550, txBandwidth: 7, txPower: 11, rxFrequency: 1550, rxBandwidth: 7, transferRate: 0.02, noiseFigureDb: 4 },
        },
      },
    }
    const pkg = buildMissionPackage(draft)
    expect(pkg.files['comm_platform_COMMAND_VEHICLE.txt']).not.toContain('report_to commander via fiber_link')
    expect(pkg.files['comm_platform_COMMAND_VEHICLE.txt']).not.toContain('comm fiber_link')
    const adoption = pkg.manifest.executionStatus.portAdoption as Array<{ platformType: string; port: string; outputStatus: string }>
    expect(adoption.find(item => item.platformType === 'COMMAND_VEHICLE_PLATFORM' && item.port === 'fiber_link')?.outputStatus).toBe('NOT_EMITTED')
    expect(pkg.manifest.executionStatus.configuredNotEmitted).toContainEqual(expect.objectContaining({ fieldPath: 'deviceParameters.ports.MISSION_UAV_PLATFORM.l_band_uplink' }))
  })

  it('显式 commPorts 遗漏已启用链路的中继端口或 LASER 端口时阻断生成，已禁用链路不阻断', () => {
    const draft = createTemplateScenario()
    draft.config.deviceParameters = {
      commPorts: {
        TIAN_TONG_SAT: {},
      },
    }
    // 加一条引用 tiantong_sat 中继的已禁用 SAT 链路：不应阻断。
    const disabledSatLink = {
      id: 'sat_disabled',
      type: 'SAT' as const,
      sourcePlatformId: 'rear_comm_vehicle',
      targetPlatformId: 'mission_uav_02',
      relayPlatformId: 'tiantong_sat',
      direction: 'FORWARD' as const,
      dataRate: 16,
      frequency: 14200,
      bandwidth: 20,
      txPower: 20,
      rxFrequency: 11800,
      rxBandwidth: 20,
      antennaGain: { tx: 25, rx: 25 },
      modulation: 'QPSK' as const,
      berThreshold: 1e-6,
      enabled: false,
    }
    draft.config.links.push(disabledSatLink)
    for (const id of ['rear_comm_vehicle', 'mission_uav_02', 'tiantong_sat']) {
      draft.config.platforms.find(platform => platform.id === id)!.linkIds.push('sat_disabled')
    }
    expect(() => buildMissionPackage(draft)).not.toThrow()

    // 启用该卫星链路但 TIAN_TONG_SAT.sat_link 未列在 commPorts 中：应阻断。
    draft.config.links[draft.config.links.length - 1]!.enabled = true
    expect(() => buildMissionPackage(draft)).toThrow(MissionGenerationError)
    try {
      buildMissionPackage(draft)
    } catch (error) {
      expect((error as Error).message).toContain('TIAN_TONG_SAT')
    }
  })
})

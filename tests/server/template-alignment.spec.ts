// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createRenamedTemplateScenario, createTemplateScenario } from '../fixtures/template-scenario'

const { readFile, readdir } = await import('node:' + 'fs/promises')
const { dirname, join } = await import('node:' + 'path')
const { fileURLToPath } = await import('node:' + 'url')
const { createHash } = await import('node:' + 'crypto')
const { buildMissionPackage } = await import('../../server/scripts/' + 'mission-generator.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const TEMPLATE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'afsim-template-20261106')
const TEMPLATE_FILES = [
  'ad_hoc_comm.txt',
  'comm_PerDefinition.txt',
  'comm_platform_COMMAND_VEHICLE.txt',
  'comm_platform_INS.txt',
  'comm_platform_JAMMER.txt',
  'comm_platform_MISSION_UAV.txt',
  'comm_platform_REAR.txt',
  'comm_platform_SAT.txt',
  'comm_SimSetup.txt',
  'observers.txt',
] as const
const LINK_CALC_JSON_DIRECTIVES = ['traffic_type', 'relay_uav_names', 'hot_link_ret', 'hot_link_fw', 'port_params', 'natural_environment', 'jammer_param'] as const

type TemplateFile = (typeof TEMPLATE_FILES)[number]
const TEMPLATE_SHA256: Readonly<Record<TemplateFile, string>> = {
  'ad_hoc_comm.txt': '9E92EA411FB996CD3544C85709F3E2A30787E1921CF6D554FC342B26D0726468',
  'comm_PerDefinition.txt': '8BB0CDD68825B221A72A6908EC0402AF4F83F09B3A54ACC4E1D03E77E3675571',
  'comm_platform_COMMAND_VEHICLE.txt': '75C6FACF09D449F43C06E71E29F8242149ADDDF8C807755A670933A9A7A99B56',
  'comm_platform_INS.txt': '3858B2AB6FF9C521F3E1ED31BDBCF5016638C00DEC99C45DDA7D2FFF0E3A3CA1',
  'comm_platform_JAMMER.txt': 'AA2FC8B6B360A5F189438EB8F8A1626D983C63B46E6AA6DA40A24AEF3D7D55CA',
  'comm_platform_MISSION_UAV.txt': '2C37C228423590312AF57314B4FB458C8B58773DC4954F67B00B4D8CD87BF54D',
  'comm_platform_REAR.txt': 'F6423F9D0BEA75D8F6ED6D6B777D5D5A006EAE46F3C798B82BE33BCE396569FA',
  'comm_platform_SAT.txt': '68C63FC291CDA791ABF9E8756B7BAD587A59400302B96838201948E5460A2A9A',
  'comm_SimSetup.txt': '807AA335886E55FFCC5A75D3F190E34BE3D12199B08F6CD181052CBD59E07C87',
  'observers.txt': '35BE0581BAB47B1C690055C9C5DA1FFC9385E5E09BB7A7703B46EAE41CDFCA0B',
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type ScriptFiles = Record<string, string>

/** 新夹具移除人工标注、行尾空白及指定删除项；比对时规范化语法。 */
function normalizedLines(value: string): string[] {
  return value.replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/\/\/.*$/u, '').replace(/#.*$/u, '').trim().replace(/\s+/gu, ' '))
    .filter(Boolean)
}

function formatNumber(value: number): string {
  return String(value)
}

function physicalValue(value: number, unit: string): [number, string] {
  if (unit === 'kts') return [value * 0.5144444444444445, 'm/s']
  if (unit === 'km/h') return [value / 3.6, 'm/s']
  if (unit === 'km') return [value * 1000, 'm']
  return [value, unit]
}

/**
 * 数值写法不影响语义（4.0 GHz 等于 4 GHz）。单位换算只限文档列出的速度、高度写法。
 */
function canonicalLine(line: string): string {
  let result = line.replace(/(-?\d+(?:\.\d+)?)\s*(kts|km\/h)\b/gu, (_match, raw: string, unit: string) => {
    const [value, target] = physicalValue(Number(raw), unit)
    return `${formatNumber(value)} ${target}`
  })
  if (/\baltitude\b/u.test(result)) {
    result = result.replace(/(-?\d+(?:\.\d+)?)\s*km\b/gu, (_match, raw: string) => {
      const [value, target] = physicalValue(Number(raw), 'km')
      return `${formatNumber(value)} ${target}`
    })
  }
  result = result.replace(/(?<![A-Za-z_])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/giu, raw => formatNumber(Number(raw)))
  return result
}

function findDirective(lines: readonly string[], directive: string): { index: number; value: Json } {
  const index = lines.findIndex(line => line.startsWith(`${directive} `))
  expect(index, `缺少 ${directive} JSON。`).toBeGreaterThanOrEqual(0)
  const raw = lines[index]!.slice(directive.length).trim()
  return { index, value: JSON.parse(raw) as Json }
}

function jsonKeyOrder(value: Json): Json {
  if (Array.isArray(value)) return value.map(jsonKeyOrder)
  if (value !== null && typeof value === 'object') return Object.keys(value).map(key => [key, jsonKeyOrder(value[key]!)]) as unknown as Json
  return value
}

function normaliseJsonNumbers(value: Json): Json {
  if (Array.isArray(value)) return value.map(normaliseJsonNumbers)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normaliseJsonNumbers(nested)]))
  return typeof value === 'number' ? Number(value) : value
}

function asObject(value: Json): { [key: string]: Json } {
  expect(value !== null && !Array.isArray(value) && typeof value === 'object').toBe(true)
  return value as { [key: string]: Json }
}

/** 只套用文档记录的模板自身不一致之处，不迁就任意生成结果。 */
function expectedLinkCalc(templateJson: { [key: string]: Json }, templates: ScriptFiles): { [key: string]: Json } {
  const expected = JSON.parse(JSON.stringify(templateJson)) as { [key: string]: Json }
  const definitions = normalizedLines(templates['comm_PerDefinition.txt'])
  const gain = (name: string): number => {
    if (name === 'MICRO_REAR_PLATFORM_DIR_ANTENNA') return 18 // 交付定义删除，但引用与既有增益保留。
    const start = definitions.indexOf(`antenna_pattern ${name}`)
    expect(start).toBeGreaterThanOrEqual(0)
    return Number(definitions.slice(start, definitions.indexOf('end_antenna_pattern', start)).find(line => line.startsWith('peak_gain '))!.split(' ')[1])
  }
  const typeFiles: Record<string, TemplateFile> = { MISSION_UAV_PLATFORM: 'comm_platform_MISSION_UAV.txt', COMMAND_VEHICLE_PLATFORM: 'comm_platform_COMMAND_VEHICLE.txt', REAR_COMM_PLATFORM: 'comm_platform_REAR.txt', TIAN_TONG_SAT: 'comm_platform_SAT.txt', SHEN_TONG_SAT: 'comm_platform_SAT.txt' }
  // 不采用 port_params 的旧示例数值，独立从夹具 comm 块读取；EIRP/G/T 取新示例。
  for (const platformValue of expected.port_params as Json[]) {
    const platform = asObject(platformValue), lines = normalizedLines(templates[typeFiles[String(platform.platform_type)]!])
    const typeStart = lines.indexOf(`platform_type ${platform.platform_type} WSF_PLATFORM`)
    const body = lines.slice(typeStart, lines.indexOf('end_platform_type', typeStart))
    for (const commValue of platform.comm_params as Json[]) {
      const comm = asObject(commValue)
      if (comm.comm_name === 'fiber_link') continue
      const start = body.indexOf(`comm ${comm.comm_name} WSF_RADIO_TRANSCEIVER`)
      expect(start).toBeGreaterThanOrEqual(0)
      const block = body.slice(start, body.indexOf('end_comm', start))
      const rate = block.find(line => line.startsWith('transfer_rate '))!.replace('constant ', '').split(' ')
      for (const side of ['transmitter', 'receiver'] as const) {
        const part = block.slice(block.indexOf(side), block.indexOf(`end_${side}`))
        const number = (key: string) => Number(part.find(line => line.startsWith(`${key} `))!.split(' ')[1])
        const old = asObject(comm[side]), peak = gain(part.find(line => line.startsWith('antenna_pattern '))!.split(' ')[1]!)
        comm[side] = side === 'transmitter'
          ? { frequency_ghz: number('frequency'), bandwidth_mhz: number('bandwidth'), power_w: number('power'), eirp_dBW: old.eirp_dBW!, peak_gain_dB: peak, [`information_rate_${rate[2]}`]: Number(rate[1]) }
          : { frequency_ghz: number('frequency'), bandwidth_mhz: number('bandwidth'), peak_gain_dB: peak, G_T_dBK: old.G_T_dBK!, [`information_rate_${rate[2]}`]: Number(rate[1]), noise_figure_dB: number('noise_figure') }
      }
    }
  }
  const jammers = asObject(expected.jammer_param).jammers as Json[]
  expect(jammers).toHaveLength(1)
  expect(Object.keys(asObject(jammers[0]!))).toEqual(['platform_name', 'weapon_name', 'jammer_type', 'G_T_dBK', 'enabled', 'mode', 'frequency_ghz', 'bandwidth_mhz', 'power_w', 'noise_figure', 'weapon_frequency_ghz', 'weapon_bandwidth_mhz', 'weapon_power_w', 'weapon_eirp_dBW', 'weapon_antenna_gain_dbi', 'tx_loss_db', 'detect_radius_nm', 'trigger_radius_nm', 'release_radius_nm', 'spot_bandwidth_mhz', 'sweep_duty_cycle'])
  // 雷达默认 1000 W，与新模板一致；武器使用 V1.2 合法值，半径、启停与配置一致。机载项沿用相同键序。
  const ground = asObject(jammers[0]!)
  expect(ground.power_w).toBe(1000)
  Object.assign(ground, { weapon_bandwidth_mhz: 200, weapon_power_w: 1, detect_radius_nm: 30, trigger_radius_nm: 0, release_radius_nm: 35 })
  jammers.push({ ...ground, platform_name: 'jammer_airborne_01', weapon_name: 'alq99_jammer', jammer_type: 'airborne', weapon_bandwidth_mhz: 100, weapon_power_w: 0.1, detect_radius_nm: 30, trigger_radius_nm: 10, release_radius_nm: 15 })
  return expected
}

function removeDirectiveLine(lines: string[], directive: string): string[] {
  return lines.map(line => line.startsWith(`${directive} `) ? `${directive} <json>` : line)
}

/** §5.1 要求模板事件集合中每个事件只输出一次。 */
function dedupeCsvEventEnables(lines: string[]): string[] {
  const seen = new Set<string>()
  return lines.filter(line => {
    if (!line.startsWith('enable ')) return true
    if (seen.has(line)) return false
    seen.add(line)
    return true
  })
}

function removeTemplateOnlyStory(lines: string[]): string[] {
  const result: string[] = []
  let ignoredRoute: string | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const route = /^route (relay_loiter|return_relay)$/u.exec(line)
    if (route) { ignoredRoute = route[1]!; continue }
    if (ignoredRoute !== null) {
      if (line === 'end_route') ignoredRoute = null
      continue
    }
    if (line === 'script_variables') {
      const end = lines.indexOf('end_script_variables', index)
      const block = lines.slice(index, end + 1)
      if (block.some(entry => entry.includes('uav_role'))) {
        index = end
        continue
      }
      result.push(...block)
      index = end
      continue
    }
    if (line.includes('writeln(')) continue
    result.push(line)
  }
  return result
}

function declaredNames(lines: readonly string[], keyword: 'label' | 'route'): string[] {
  return lines.flatMap(line => {
    const match = new RegExp(`^${keyword} ([A-Za-z0-9_-]+)$`, 'u').exec(line)
    return match ? [match[1]!] : []
  })
}

function references(lines: readonly string[], pattern: RegExp): string[] {
  return lines.flatMap(line => {
    const match = pattern.exec(line)
    return match ? [match[1]!] : []
  })
}

/**
 * §8.2 第 9 项：比较 label/goto 与 route/FollowRoute 的引用关系，不比较名称文字。
 * 先确认每个引用都能对应到声明，再替换名称做文本比较。
 */
function platformRouteRelations(lines: readonly string[]): Map<string, { labels: string[]; gotos: string[]; follows: string[] }> {
  const result = new Map<string, { labels: string[]; gotos: string[]; follows: string[] }>()
  let platformId: string | null = null
  for (const line of lines) {
    const platform = /^platform ([A-Za-z0-9_-]+) /u.exec(line)
    if (platform) {
      platformId = platform[1]!
      result.set(platformId, { labels: [], gotos: [], follows: [] })
      continue
    }
    if (line === 'end_platform') { platformId = null; continue }
    if (platformId === null) continue
    const relation = result.get(platformId)!
    const label = /^label ([A-Za-z0-9_-]+)$/u.exec(line)
    const goto = /^goto ([A-Za-z0-9_-]+)$/u.exec(line)
    const follow = /FollowRoute\("([A-Za-z0-9_-]+)"\)/u.exec(line)
    if (label) relation.labels.push(label[1]!)
    if (goto) relation.gotos.push(goto[1]!)
    if (follow) relation.follows.push(follow[1]!)
  }
  return result
}

function canonicaliseRouteRelations(expected: string[], actual: string[]): { expected: string[]; actual: string[] } {
  const expectedRelations = platformRouteRelations(expected)
  const actualRelations = platformRouteRelations(actual)
  const labelAliases = new Map<string, Map<string, string>>()
  const routeAliases = new Map<string, Map<string, string>>()
  for (const [platformId, expectedRelation] of expectedRelations) {
    const actualRelation = actualRelations.get(platformId)
    expect(actualRelation, `生成脚本缺少平台 ${platformId}。`).toBeDefined()
    expect(actualRelation!.labels.length, `${platformId} 的 label 数量改变。`).toBe(expectedRelation.labels.length)
    const labels = new Map(actualRelation!.labels.map((name, index) => [name, expectedRelation.labels[index]!]))
    expect(actualRelation!.gotos.map(name => labels.get(name)), `${platformId} 的 goto 必须指向同一平台路线内对应的 label。`).toEqual(expectedRelation.gotos)
    expect(actualRelation!.follows.length, `${platformId} 的 FollowRoute 数量改变。`).toBe(expectedRelation.follows.length)
    labelAliases.set(platformId, labels)
    routeAliases.set(platformId, new Map(actualRelation!.follows.map((name, index) => [name, expectedRelation.follows[index]!])))
  }
  const expectedRoutes = declaredNames(expected, 'route')
  const actualRoutes = declaredNames(actual, 'route')
  const expectedFollow = [...expectedRelations.values()].flatMap(value => value.follows)
  const actualFollow = [...actualRelations.values()].flatMap(value => value.follows)
  for (const expectedName of expectedFollow) expect(expectedRoutes).toContain(expectedName)
  for (const actualName of actualFollow) expect(actualRoutes).toContain(actualName)

  const globalRouteAliases = new Map([...routeAliases.values()].flatMap(value => [...value.entries()]))
  const replace = (lines: string[]) => {
    let platformId: string | null = null
    return lines.map(line => {
      const platform = /^platform ([A-Za-z0-9_-]+) /u.exec(line)
      if (platform) platformId = platform[1]!
      const labels = platformId === null ? undefined : labelAliases.get(platformId)
      const routes = platformId === null ? undefined : routeAliases.get(platformId)
      let value = line.replace(/^route ([A-Za-z0-9_-]+)$/u, (_match, name: string) => `route ${globalRouteAliases.get(name) ?? name}`)
      value = value.replace(/^label ([A-Za-z0-9_-]+)$/u, (_match, name: string) => `label ${labels?.get(name) ?? name}`)
      value = value.replace(/^goto ([A-Za-z0-9_-]+)$/u, (_match, name: string) => `goto ${labels?.get(name) ?? name}`)
      value = value.replace(/FollowRoute\("([A-Za-z0-9_-]+)"\)/u, (_match, name: string) => `FollowRoute("${routes?.get(name) ?? name}")`)
      if (line === 'end_platform') platformId = null
      return value
    })
  }
  return { expected: replace(expected), actual: replace(actual) }
}

function readGeneratedFile(files: unknown, name: string): string {
  const result = (files as ScriptFiles)[name]
  expect(typeof result, `生成包缺少 ${name}`).toBe('string')
  return result
}

function durationSeconds(line: string): number | null {
  const match = /^end_time (\d+(?:\.\d+)?) (sec|min)$/u.exec(line)
  if (!match) return null
  return Number(match[1]) * (match[2] === 'min' ? 60 : 1)
}

function scriptNumber(token: string): { value: number; suffix: string } | null {
  const match = /^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(.*)$/iu.exec(token)
  return match ? { value: Number(match[1]), suffix: match[2]! } : null
}

/** 脚本中的小数按数值比较，不按格式化精度比较。 */
function expectScriptLines(actual: string[], expected: string[], message: string): void {
  expect(actual.length, message).toBe(expected.length)
  for (let index = 0; index < expected.length; index += 1) {
    const actualTokens = actual[index]!.split(' ')
    const expectedTokens = expected[index]!.split(' ')
    expect(actualTokens.length, `${message}（第 ${index + 1} 行字段数不同）`).toBe(expectedTokens.length)
    for (let tokenIndex = 0; tokenIndex < expectedTokens.length; tokenIndex += 1) {
      const actualToken = actualTokens[tokenIndex]!
      const expectedToken = expectedTokens[tokenIndex]!
      const actualNumber = scriptNumber(actualToken)
      const expectedNumber = scriptNumber(expectedToken)
      if (actualNumber && expectedNumber && actualNumber.suffix === expectedNumber.suffix) {
        const scale = Math.max(1, Math.abs(actualNumber.value), Math.abs(expectedNumber.value))
        expect(Math.abs(actualNumber.value - expectedNumber.value), `${message}（第 ${index + 1} 行数值字段不同）`).toBeLessThanOrEqual(Number.EPSILON * scale * 8)
      } else {
        expect(actualToken, `${message}（第 ${index + 1} 行字段不同）`).toBe(expectedToken)
      }
    }
  }
}

describe('2026-11-06 AFSIM 模板逐文件对齐', () => {
  it('冻结去除人工标注及指定删除项后的 10 个 TXT，且不纳入 mission.log', async () => {
    const copied = await readdir(TEMPLATE_DIRECTORY)
    expect(copied.sort()).toEqual([...TEMPLATE_FILES].sort())
    for (const name of TEMPLATE_FILES) {
      const fixture = await readFile(join(TEMPLATE_DIRECTORY, name))
      expect(createHash('sha256').update(fixture).digest('hex').toUpperCase(), `${name} 不再是审核后的交付夹具。`).toBe(TEMPLATE_SHA256[name])
    }
  })

  it('改名、乱序和编号冲突后，六个通信平台文件的哈希与原场景生成结果一致', () => {
    const original = buildMissionPackage(createTemplateScenario())
    const renamed = buildMissionPackage(createRenamedTemplateScenario())
    // 原始 TXT 含已批准的语法差异；这里比较生成字节，原始模板哈希与逐文件语义检查仍保留。
    for (const name of TEMPLATE_FILES.filter(name => name.startsWith('comm_platform_'))) {
      expect(createHash('sha256').update(renamed.files[name]!).digest('hex'), name)
        .toBe(createHash('sha256').update(original.files[name]!).digest('hex'))
    }
  })

  it.each([
    ['原始编号', createTemplateScenario],
    ['改名、乱序及编号冲突', createRenamedTemplateScenario],
  ] as const)('%s：严格对照每个模板文件，只允许既有白名单及 11-06 明确的配置差异', async (_label, createScenario) => {
    const generated = buildMissionPackage(createScenario())
    const files = generated.files as unknown
    const template = Object.fromEntries(await Promise.all(TEMPLATE_FILES.map(async name => [name, await readFile(join(TEMPLATE_DIRECTORY, name), 'utf8')]))) as ScriptFiles

    // 1：速度、高度换算为场景的 m/s 与 m。
    expectScriptLines([canonicalLine('speed 200 kts')], [canonicalLine('speed 102.88888888888889 m/s')], '节到 m/s 的换算不一致。')
    expectScriptLines([canonicalLine('speed 300 km/h')], [canonicalLine('speed 83.33333333333333 m/s')], 'km/h 到 m/s 的换算不一致。')
    expectScriptLines([canonicalLine('altitude 35.786 km')], [canonicalLine('altitude 35786 m')], 'km 到 m 的换算不一致。')

    // 2：起止时间与日期写法按夹具场景语义比较。
    const setupLines = normalizedLines(readGeneratedFile(files, 'comm_SimSetup.txt'))
    expect(durationSeconds(setupLines.find(line => line.startsWith('end_time ')) ?? '')).toBe(5400)
    expect(setupLines).toContain('start_date sep 15 2025')
    expect(setupLines).toContain('start_time 00:00:00')

    // 3：生成的路径必须是可移植的 / 分隔路径。
    expect(setupLines.filter(line => line.startsWith('file ')).every(line => !line.includes('\\'))).toBe(true)

    // 4：两颗卫星的 epoch 跟随夹具开始时间，而不是模板里的旧字面值。
    const satelliteLines = normalizedLines(readGeneratedFile(files, 'comm_platform_SAT.txt'))
    expect(satelliteLines.filter(line => line.startsWith('epoch_date_time '))).toEqual(['epoch_date_time sep 15 2025 00:00:00', 'epoch_date_time sep 15 2025 00:00:00'])

    const rearTemplateLines = normalizedLines(template['comm_platform_REAR.txt'])
    const rearGeneratedLines = normalizedLines(readGeneratedFile(files, 'comm_platform_REAR.txt'))
    const templateJson = Object.fromEntries(LINK_CALC_JSON_DIRECTIVES.map(directive => [directive, findDirective(rearTemplateLines, directive).value])) as { [key: string]: Json }
    const generatedJson = Object.fromEntries(LINK_CALC_JSON_DIRECTIVES.map(directive => [directive, findDirective(rearGeneratedLines, directive).value])) as { [key: string]: Json }
    const expectedJson = expectedLinkCalc(templateJson, template)
    const actualJson = generatedJson as Json

    // 5：以设备定义和天线增益表为准，覆盖模板中不一致的旧值。
    const generatedPorts = generatedJson.port_params as Json[]
    const rearPorts = asObject(generatedPorts.find(item => asObject(item).platform_type === 'REAR_COMM_PLATFORM')!)
    for (const comm of rearPorts.comm_params as Json[]) {
      const entry = asObject(comm)
      if (entry.comm_name === 'sat_link_a' || entry.comm_name === 'sat_link_b') expect(asObject(entry.transmitter).power_w).toBe(20)
    }
    for (const platform of generatedPorts) {
      const entry = asObject(platform)
      if (entry.platform_type !== 'MISSION_UAV_PLATFORM' && entry.platform_type !== 'COMMAND_VEHICLE_PLATFORM') continue
      for (const comm of entry.comm_params as Json[]) {
        const port = asObject(comm)
        if (port.comm_name === 'c_band_uplink' || port.comm_name === 'c_band_downlink') {
          expect(asObject(port.transmitter).peak_gain_dB).toBe(entry.platform_type === 'COMMAND_VEHICLE_PLATFORM' && port.comm_name === 'c_band_uplink' ? 30 : 25)
          expect(asObject(port.receiver).peak_gain_dB).toBe(entry.platform_type === 'COMMAND_VEHICLE_PLATFORM' && port.comm_name === 'c_band_uplink' ? 30 : 25)
        }
      }
    }
    // 6：使用实际实例编号，而不是模板示例中的 airborne_jammer_01。
    expect(asObject((asObject(generatedJson.jammer_param).jammers as Json[])[1]!).platform_name).toBe('jammer_airborne_01')
    // 8：该环境值由场景配置决定，须取夹具中的值。
    expect(asObject(asObject(generatedJson.natural_environment).atmosphere).simplified_attenuation_db_per_km).toBe(0.02)

    // link_calc 的 JSON 按语义比较，并额外要求键顺序与对接方一致。
    expect(normaliseJsonNumbers(actualJson)).toEqual(normaliseJsonNumbers(expectedJson))
    expect(jsonKeyOrder(actualJson), 'link_calc JSON 键顺序必须与模板一致。').toEqual(jsonKeyOrder(expectedJson))

    for (const name of TEMPLATE_FILES) {
      let expected = normalizedLines(template[name])
      let actual = normalizedLines(readGeneratedFile(files, name))
      if (name === 'comm_platform_INS.txt') {
        // 11-06 INS 是另一份六节点场景。当前九节点夹具的坐标/航线继续对照其原始输入样例，平台类型固定段均对照 11-06。
        expect(expected.filter(line => line.startsWith('platform '))).toHaveLength(6)
        expected = normalizedLines(await readFile(join(TEMPLATE_DIRECTORY, '..', 'afsim-template-20261101', name), 'utf8'))
        // 7 与 9：只允许文档记录的示例剧情块和引用名称不同。
        expect(expected.some(line => line.includes('uav_role') || line.includes('writeln('))).toBe(true)
        expect(expected.filter(line => line === 'route relay_loiter' || line === 'route return_relay')).toHaveLength(2)
        expect(references(expected, /FollowRoute\("([A-Za-z0-9_-]+)"\)/u)).not.toContain('return_relay')
        expect(actual.some(line => line.includes('uav_role') || line.includes('writeln('))).toBe(false)
        expected = removeTemplateOnlyStory(expected)
        ;({ expected, actual } = canonicaliseRouteRelations(expected, actual))
      }
      if (name === 'comm_platform_MISSION_UAV.txt') {
        // 模板示例为 32/16 bit，实际数据量与 traffic_type 的第一条业务一致。
        expect(expected).toContain('int rt_video_size = 32;')
        expect(expected).toContain('int rt_status_size = 16;')
        expected = expected.map(line => line.replace('int rt_video_size = 32;', 'int rt_video_size = 8192;').replace('int rt_status_size = 16;', 'int rt_status_size = 512;'))
      }
      if (name === 'comm_platform_JAMMER.txt') {
        expect(expected.filter(line => line === 'power 1000 W')).toHaveLength(2)
        const start = expected.indexOf('weapon alq99_jammer WSF_RF_JAMMER'), end = expected.indexOf('end_weapon', start)
        expect(expected.slice(start, end)).toEqual(expect.arrayContaining(['power 100 W', 'bandwidth 20 MHz']))
        expected = expected.map((line, index) => index > start && index < end
          ? line.replace('power 100 W', 'power 0.1 W').replace('bandwidth 20 MHz', 'bandwidth 100 MHz') : line)
        expect(actual.filter(line => line.startsWith('weapon '))).toEqual(['weapon alq99_jammer WSF_RF_JAMMER'])
      }
      if (name === 'comm_platform_REAR.txt') {
        // 新模板已采用既有 vertical 修正，不再对期望结果做极化替换。
        const polarizations = (lines: readonly string[]) => {
          const start = lines.indexOf('comm microwave_link WSF_RADIO_TRANSCEIVER')
          return lines.slice(start, lines.indexOf('end_comm', start)).filter(line => line.startsWith('polarization '))
        }
        expect(polarizations(expected)).toEqual(['polarization vertical', 'polarization vertical'])
        expect(polarizations(actual)).toEqual(['polarization vertical', 'polarization vertical'])
        for (const directive of LINK_CALC_JSON_DIRECTIVES) {
          expected = removeDirectiveLine(expected, directive)
          actual = removeDirectiveLine(actual, directive)
        }
      }
      if (name === 'comm_platform_SAT.txt') {
        expect(expected.filter(line => line.startsWith('epoch_date_time '))).toEqual(['epoch_date_time oct 23 2026 02:07:00', 'epoch_date_time oct 23 2026 02:07:00'])
        expected = expected.map(line => line.replace('epoch_date_time oct 23 2026 02:07:00', 'epoch_date_time sep 15 2025 00:00:00'))
      }
      if (name === 'comm_SimSetup.txt') {
        expect(expected).toEqual(expect.arrayContaining(['start_date oct 23 2026', 'start_time 02:07:00', 'end_time 1200 sec']))
        expected = dedupeCsvEventEnables(expected).map(line => line
          .replace(/^end_time 1200 sec$/u, 'end_time 5400 sec')
          .replace(/^start_date oct 23 2026$/u, 'start_date sep 15 2025')
          .replace(/^start_time 02:07:00$/u, 'start_time 00:00:00')
          .replace(/output\\/gu, 'output/'))
      }
      expectScriptLines(actual.map(canonicalLine), expected.map(canonicalLine), `${name} 存在不属于 §8.2 白名单的脚本差异。`)
    }
  })

  it('数值或固定语句变更不会被规范化掩盖', () => {
    expect(() => expectScriptLines(['power 21 W'], ['power 20 W'], '固定设备功率发生变化。')).toThrow()
    expect(() => expectScriptLines(['frequency 4.1 GHz'], ['frequency 4 GHz'], '固定端口频率发生变化。')).toThrow()
  })
})

it('SCN-001 的 TXT 只含模板实例名，mapping 显式声明命名模式', () => {
  const draft = new ScenarioProjection().get('SCN-001').data
  Object.assign(draft.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
  const generated = buildMissionPackage(draft)
  const ins = generated.files['comm_platform_INS.txt']!
  expect(ins).toContain('rear_comm_vehicle')
  expect(ins).toContain('mission_uav_01')
  expect(ins).not.toMatch(/CMD-01|AIR-01|UAV-01/)
  expect(generated.manifest.platformNaming).toBe('TEMPLATE_INSTANCE')
  expect(generated.manifest.platforms).toContainEqual(expect.objectContaining({ platformId: 'CMD-01', name: 'rear_comm_vehicle' }))
})

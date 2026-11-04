// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createRenamedTemplateScenario, createTemplateScenario } from '../fixtures/template-scenario'

const { readFile, readdir } = await import('node:' + 'fs/promises')
const { dirname, join } = await import('node:' + 'path')
const { fileURLToPath } = await import('node:' + 'url')
const { createHash } = await import('node:' + 'crypto')
const { buildMissionPackage } = await import('../../server/scripts/' + 'mission-generator.js')
const TEMPLATE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'afsim-template-20261101')
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

const TEMPLATE_SHA256: Record<(typeof TEMPLATE_FILES)[number], string> = {
  'ad_hoc_comm.txt': '1F4024F2BEF861F00A60130C99B5A063C338B702955060F47DC6583AAA2F9DAB',
  'comm_PerDefinition.txt': 'BEEECA60F4C1E3F5B516EA49BF934C1F12BA6E277F58C1DB255C07B97EB4BBAD',
  'comm_platform_COMMAND_VEHICLE.txt': '365831CE382B6F234A87E7A10B8E82E07109FAB2D63B3E2201BCC19E117AA550',
  'comm_platform_INS.txt': '8B6E272CE6FB36DC131DD5A2AEE5A0EA5911D6DE4E3DF95594D804BFBCAC2C7C',
  'comm_platform_JAMMER.txt': 'A12AE67BB82F86FACC9009165EA8ABEB37FF6549A41B6ACF4D86A6A30CA76283',
  'comm_platform_MISSION_UAV.txt': 'EC6F2340718A1D142F0F7ED7A271EC123510CFEB6F026913ECD83D005A33C115',
  'comm_platform_REAR.txt': '65EC9A4B352F3E98B4AF738C83000148FB64E92E6D9A657E683F26866C664C6B',
  'comm_platform_SAT.txt': 'CB28FD83C87E8860C101B38569CC5DE22326E222ACF122B802AF2B2C38B83DE8',
  'comm_SimSetup.txt': 'FD92847A93418D0741B3BDF2DB49E4D3E1B9D44CDD614F7AD6E20FC31E4379F2',
  'observers.txt': '67C9235DE215BA0169888DCC649AAFF2683A48B8BD5776302CBD90794EC3F85D',
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type ScriptFiles = Record<string, string>

/** 模板文件按字节原样复制；比对时只按 §8.2 规范化语法。 */
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
function expectedLinkCalc(template: Json, simplifiedAttenuationDbPerKm: number): Json {
  const expected = structuredClone(template)
  const root = asObject(expected)
  const ports = root.port_params as Json[]
  for (const platform of ports) {
    const platformEntry = asObject(platform)
    const type = platformEntry.platform_type
    for (const comm of platformEntry.comm_params as Json[]) {
      const commEntry = asObject(comm)
      const transmitter = asObject(commEntry.transmitter)
      const receiver = asObject(commEntry.receiver)
      if (type === 'REAR_COMM_PLATFORM' && (commEntry.comm_name === 'sat_link_a' || commEntry.comm_name === 'sat_link_b')) transmitter.power_w = 20
      if ((type === 'MISSION_UAV_PLATFORM' || type === 'COMMAND_VEHICLE_PLATFORM') && (commEntry.comm_name === 'c_band_uplink' || commEntry.comm_name === 'c_band_downlink')) {
        transmitter.peak_gain_dB = 25
        receiver.peak_gain_dB = 25
      }
    }
  }
  const natural = asObject(root.natural_environment)
  asObject(natural.atmosphere).simplified_attenuation_db_per_km = simplifiedAttenuationDbPerKm
  const jammer = asObject(root.jammer_param)
  const jammers = jammer.jammers as Json[]
  asObject(jammers[1]!).platform_name = 'jammer_airborne_01'
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

describe('2026-11-01 AFSIM 模板逐文件对齐', () => {
  it('保留 10 个原始 TXT 字节副本，且不纳入 mission.log', async () => {
    const copied = await readdir(TEMPLATE_DIRECTORY)
    expect(copied.sort()).toEqual([...TEMPLATE_FILES].sort())
    for (const name of TEMPLATE_FILES) {
      const fixture = await readFile(join(TEMPLATE_DIRECTORY, name))
      expect(createHash('sha256').update(fixture).digest('hex').toUpperCase(), `${name} 不再是原字节副本。`).toBe(TEMPLATE_SHA256[name])
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
  ] as const)('%s：严格对照每个模板文件，所有差异均落在 §8.2 的九项白名单', async (_label, createScenario) => {
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
    const expectedJson = expectedLinkCalc(templateJson, 0.02)
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
          expect(asObject(port.transmitter).peak_gain_dB).toBe(25)
          expect(asObject(port.receiver).peak_gain_dB).toBe(25)
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
        // 7 与 9：只允许文档记录的示例剧情块和引用名称不同。
        expect(expected.some(line => line.includes('uav_role') || line.includes('writeln('))).toBe(true)
        expect(expected.filter(line => line === 'route relay_loiter' || line === 'route return_relay')).toHaveLength(2)
        expect(references(expected, /FollowRoute\("([A-Za-z0-9_-]+)"\)/u)).not.toContain('return_relay')
        expect(actual.some(line => line.includes('uav_role') || line.includes('writeln('))).toBe(false)
        expected = removeTemplateOnlyStory(expected)
        ;({ expected, actual } = canonicaliseRouteRelations(expected, actual))
      }
      if (name === 'comm_platform_REAR.txt') {
        // 10: 用户裁定后方车微波极化与无人机一致改为 vertical（模板为 horizontal，交叉极化收不到）。
        const polarizations = (lines: readonly string[]) => {
          const start = lines.indexOf('comm microwave_link WSF_RADIO_TRANSCEIVER')
          return lines.slice(start, lines.indexOf('end_comm', start)).filter(line => line.startsWith('polarization '))
        }
        expect(polarizations(expected)).toEqual(['polarization horizontal', 'polarization horizontal'])
        expect(polarizations(actual)).toEqual(['polarization vertical', 'polarization vertical'])
        expected = expected.map((line, index) => {
          const start = expected.indexOf('comm microwave_link WSF_RADIO_TRANSCEIVER')
          return index > start && index < expected.indexOf('end_comm', start) && line === 'polarization horizontal' ? 'polarization vertical' : line
        })
        for (const directive of LINK_CALC_JSON_DIRECTIVES) {
          expected = removeDirectiveLine(expected, directive)
          actual = removeDirectiveLine(actual, directive)
        }
      }
      if (name === 'comm_SimSetup.txt') {
        expected = dedupeCsvEventEnables(expected).map(line => line
          .replace(/^end_time 90 min$/u, 'end_time 5400 sec')
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

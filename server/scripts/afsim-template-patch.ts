/**
 * 1112 固定模板的受控替换。
 *
 * 只允许修改以下区域，其余字节保持模板原文：
 * 1. comm_platform_REAR.txt 的 fw_sit_dst、fw_tgt_dst 两个数组元素；
 * 2. comm_platform_REAR.txt 的 link_calc 处理器参数块；
 * 3. comm_platform_MISSION_UAV.txt 的三个数组元素及 sat_link 接收频率单位；
 * 4. comm_SimSetup.txt 的 realtime、clock_rate；
 * 5. 指向同一激光端口的 laser_link 声明/引用统一为 lazer_link（1112 源模板已统一，当前命中 0 处）。
 *
 * 区域定位必须唯一；定位失败或匹配多处时抛错，不静默使用第一个匹配。
 */
import { TEMPLATE_1112_FILES, type Template1112FileName } from './afsim-template-1112.js'

export class TemplateRegionError extends Error {
  constructor(readonly fileName: string, readonly region: string, reason: string) {
    super(`${fileName}：${region}${reason}`)
    this.name = 'TemplateRegionError'
  }
}

type LineRecord = { content: string; ending: string }

function splitLineRecords(text: string): LineRecord[] {
  const records: LineRecord[] = []
  let index = 0
  while (index < text.length) {
    const newline = text.indexOf('\n', index)
    if (newline < 0) {
      records.push({ content: text.slice(index), ending: '' })
      break
    }
    const hasCarriageReturn = newline > index && text[newline - 1] === '\r'
    records.push({ content: text.slice(index, hasCarriageReturn ? newline - 1 : newline), ending: hasCarriageReturn ? '\r\n' : '\n' })
    index = newline + 1
  }
  return records
}

function joinLineRecords(records: readonly LineRecord[]): string {
  return records.map(record => record.content + record.ending).join('')
}

function replaceUniqueLine(
  text: string,
  fileName: Template1112FileName,
  region: string,
  matches: (content: string) => boolean,
  replacement: (content: string) => string,
): string {
  const records = splitLineRecords(text)
  const indexes = records.flatMap((record, index) => matches(record.content) ? [index] : [])
  if (indexes.length !== 1) {
    throw new TemplateRegionError(fileName, region, indexes.length === 0 ? '定位失败：未找到唯一结构标记。' : `定位失败：匹配到 ${indexes.length} 处，无法确定唯一区域。`)
  }
  const index = indexes[0]!
  records[index] = { ...records[index]!, content: replacement(records[index]!.content) }
  return joinLineRecords(records)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function arrayLiteral(values: readonly string[]): string {
  return values.length === 0 ? '{ }' : `{ ${values.map(value => JSON.stringify(value)).join(', ')} }`
}

/** 只替换指定数组的 `{ ... }` 元素列表，保留缩进、变量名和行尾原文。 */
export function replaceArrayValues(
  text: string,
  fileName: Template1112FileName,
  arrayName: string,
  values: readonly string[],
): string {
  const pattern = new RegExp(`^(\\s*Array<string>\\s+${escapeRegExp(arrayName)}\\s*=\\s*)\\{[^}]*\\}(.*)$`, 'u')
  return replaceUniqueLine(text, fileName, `数组 ${arrayName}`, content => pattern.test(content), content => {
    const match = pattern.exec(content)
    if (match === null) throw new TemplateRegionError(fileName, `数组 ${arrayName}`, '结构标记不完整。')
    // 模板 REAR 的数组行尾带 `\\`（行续接/转义），AFSIM 解析会报语法错误；生成时去掉行尾反斜杠。
    return match[1]! + arrayLiteral(values) + match[2]!.replace(/\s*\\+\s*$/u, '')
  })
}

/** 移除 `/* ... *\/` 块注释（含注释掉的内容），保留字符串字面量中的 `/*`。 */
function removeBlockComments(text: string): string {
  let result = ''
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (quoted) {
      result += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') {
      quoted = true
      result += character
      continue
    }
    if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      // 未闭合的块注释按注释到文末处理，避免残留半个注释符。
      if (end < 0) break
      index = end + 1
      continue
    }
    result += character
  }
  return result
}

/**
 * 按平台类型过滤模板中的 `comm ... end_comm` 段。
 * @param text 模板文件全文。
 * @param fileName 模板文件名（错误定位用）。
 * @param allowedByPlatform 平台类型 → 允许保留的端口名集合；未列出的平台类型保留全部端口。
 * @returns 过滤后的文件全文。
 */
export function filterPlatformCommPorts(
  text: string,
  fileName: Template1112FileName,
  allowedByPlatform: Readonly<Record<string, ReadonlySet<string>>>,
): string {
  const records = splitLineRecords(text)
  const kept: LineRecord[] = []
  let currentPlatform: string | undefined
  let skippingComm = false
  for (const record of records) {
    const content = record.content
    if (skippingComm) {
      if (/^\s*end_comm\s*$/u.test(content)) skippingComm = false
      continue
    }
    const platform = /^\s*platform_type\s+(\S+)\s+WSF_PLATFORM\s*$/u.exec(content)
    if (platform !== null) {
      currentPlatform = platform[1]
      kept.push(record)
      continue
    }
    if (/^\s*end_platform_type\s*$/u.test(content)) {
      currentPlatform = undefined
      kept.push(record)
      continue
    }
    const comm = /^\s*comm\s+(\S+)\s+WSF_\w+\s*$/u.exec(content)
    if (comm !== null && currentPlatform !== undefined) {
      const allowed = allowedByPlatform[currentPlatform]
      if (allowed !== undefined && !allowed.has(comm[1]!)) {
        skippingComm = true
        continue
      }
    }
    if (
      currentPlatform === 'COMMAND_VEHICLE_PLATFORM'
      && allowedByPlatform.COMMAND_VEHICLE_PLATFORM !== undefined
      && !allowedByPlatform.COMMAND_VEHICLE_PLATFORM.has('fiber_link')
      && /^\s*report_to\s+commander\s+via\s+fiber_link\s*$/u.test(content)
    ) {
      continue
    }
    kept.push(record)
  }
  if (skippingComm) throw new TemplateRegionError(fileName, 'comm 端口段', '定位失败：comm 段缺少 end_comm。')
  return joinLineRecords(kept)
}

/** 移除 TXT 脚本中的整行注释、行尾注释与块注释；保留字符串字面量中的 `//` 和 `/*`。 */
export function stripScriptComments(text: string): string {
  const records = splitLineRecords(removeBlockComments(text))
  const kept: LineRecord[] = []
  for (const record of records) {
    let content = record.content
    if (/^\s*\/\//u.test(content) || /^\s*#/u.test(content)) continue
    let quoted = false
    let escaped = false
    let cut = -1
    for (let index = 0; index < content.length; index += 1) {
      const character = content[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"') {
        quoted = true
        continue
      }
      if (character === '/' && content[index + 1] === '/') {
        cut = index
        break
      }
    }
    if (cut >= 0) content = content.slice(0, cut).replace(/\s+$/u, '')
    if (/^\s*$/u.test(content)) {
      if (kept.length === 0 || /^\s*$/u.test(kept.at(-1)!.content)) continue
      content = ''
    }
    kept.push({ content, ending: record.ending })
  }
  while (kept.length > 0 && /^\s*$/u.test(kept.at(-1)!.content)) kept.pop()
  return joinLineRecords(kept)
}

function spliceSectionLines(records: LineRecord[], start: number, end: number, lines: readonly string[], keepFinalEnding: boolean): string {
  const blockEnding = records[start]!.ending || '\n'
  const finalEnding = keepFinalEnding ? records[end]!.ending : (records[end]!.ending || '\n')
  const replacement: LineRecord[] = lines.map((content, index) => ({
    content,
    ending: index === lines.length - 1 ? finalEnding : blockEnding,
  }))
  records.splice(start, end - start + 1, ...replacement)
  return joinLineRecords(records)
}

/**
 * 替换无人机编队实例段：从“无人机编队”注释块开始，到干扰站实例前的最后一个 `end_platform`。
 * 该段由场景配置生成 mission_uav 实例（数量、阵营、初始位置、航点、盘旋、返航、角色）；
 * 其余固定平台实例（后方车/指挥车/卫星）保持模板原文。
 */
export function replaceMissionUavSection(text: string, fileName: Template1112FileName, lines: readonly string[]): string {
  const records = splitLineRecords(text)
  const comment = records.findIndex(record => /^\s*\/\/\s*无人机编队/u.test(record.content))
  if (comment < 0) throw new TemplateRegionError(fileName, 'mission_uav 实例段', '定位失败：未找到“无人机编队”注释标记。')
  const start = comment > 0 && /^\s*\/\/\s*=+\s*$/u.test(records[comment - 1]!.content) ? comment - 1 : comment
  const jammer = records.findIndex((record, index) => index > start && /^\s*platform\s+jammer_station_01\s+GROUND_JAMMER_STATION\s*$/u.test(record.content))
  if (jammer < 0) throw new TemplateRegionError(fileName, 'mission_uav 实例段', '定位失败：未找到 jammer_station_01 实例。')
  let end = jammer - 1
  while (end > start && !/^\s*end_platform\s*$/u.test(records[end]!.content)) end -= 1
  if (end <= start || !/^\s*end_platform\s*$/u.test(records[end]!.content)) {
    throw new TemplateRegionError(fileName, 'mission_uav 实例段', '定位失败：未找到无人机段的 end_platform。')
  }
  if (lines.length === 0) throw new TemplateRegionError(fileName, 'mission_uav 实例段', '生成内容为空。')
  return spliceSectionLines(records, start, end, lines, false)
}

/**
 * 替换 5.x 干扰源配置段：从“5.x 干扰源配置”注释块开始，到末尾最后一个 `end_platform`。
 * 该段由场景配置生成地面干扰站与机载干扰平台（数量、阵营、初始位置、航线、盘旋、侦测范围）。
 */
export function replaceJammerSection(text: string, fileName: Template1112FileName, lines: readonly string[]): string {
  const records = splitLineRecords(text)
  const matches = records.flatMap((record, index) => /^\s*\/\/\s*5\.x\s*干扰源配置/u.test(record.content) ? [index] : [])
  if (matches.length !== 1) {
    throw new TemplateRegionError(
      fileName,
      '干扰源实例段',
      matches.length === 0 ? '定位失败：未找到“5.x 干扰源配置”注释标记。' : `定位失败：匹配到 ${matches.length} 处“5.x 干扰源配置”注释标记。`,
    )
  }
  const comment = matches[0]!
  const start = comment > 0 && /^\s*\/\/\s*=+\s*$/u.test(records[comment - 1]!.content) ? comment - 1 : comment
  let end = records.length - 1
  while (end > start && !/^\s*end_platform\s*$/u.test(records[end]!.content)) end -= 1
  if (end <= start || !/^\s*end_platform\s*$/u.test(records[end]!.content)) {
    throw new TemplateRegionError(fileName, '干扰源实例段', '定位失败：未找到干扰源段的 end_platform。')
  }
  if (records.slice(end + 1).some(record => record.content.trim() !== '' && !/^\s*(?:\/\/|#)/u.test(record.content))) {
    throw new TemplateRegionError(fileName, '干扰源实例段', '结构异常：干扰源段之后存在未预期的模板语句。')
  }
  if (lines.length === 0) throw new TemplateRegionError(fileName, '干扰源实例段', '生成内容为空。')
  return spliceSectionLines(records, start, end, lines, true)
}

/**
 * 替换 link_calc 处理器块。调用方传入完整块（含 add processor 与 end_processor 行）。
 * 只允许一个 link_calc 块，且块内不允许嵌套其他 processor。
 */
export function replaceLinkCalcBlock(
  text: string,
  fileName: Template1112FileName,
  blockLines: readonly string[],
  header: RegExp = /^\s*add processor link_calc WSF_LINK_CALC_PROCESSOR\s*$/u,
): string {
  const records = splitLineRecords(text)
  const starts = records.flatMap((record, index) => /^\s*add processor link_calc WSF_LINK_CALC_PROCESSOR\s*$/u.test(record.content) ? [index] : [])
  if (starts.length !== 1) {
    throw new TemplateRegionError(fileName, 'link_calc 处理器', starts.length === 0 ? '定位失败：未找到 add processor link_calc WSF_LINK_CALC_PROCESSOR。' : `定位失败：匹配到 ${starts.length} 个 link_calc 处理器。`)
  }
  const start = starts[0]!
  const ends = records.flatMap((record, index) => index > start && /^\s*end_processor\s*$/u.test(record.content) ? [index] : [])
  const end = ends[0]
  if (end === undefined) throw new TemplateRegionError(fileName, 'link_calc 处理器', '定位失败：未找到对应的 end_processor。')
  if (records.slice(start + 1, end).some(record => /^\s*add processor\s+/u.test(record.content))) {
    throw new TemplateRegionError(fileName, 'link_calc 处理器', '结构异常：块内出现嵌套 processor。')
  }
  if (blockLines.length < 2 || !header.test(blockLines[0]!) || !/^\s*end_processor\s*$/u.test(blockLines.at(-1)!)) {
    throw new TemplateRegionError(fileName, 'link_calc 处理器', '生成块必须以处理器声明开始并以 end_processor 结束。')
  }
  const blockEnding = records[start]!.ending || '\n'
  const finalEnding = records[end]!.ending
  const replacement: LineRecord[] = blockLines.map((content, index) => ({
    content,
    ending: index === blockLines.length - 1 ? finalEnding : blockEnding,
  }))
  records.splice(start, end - start + 1, ...replacement)
  return joinLineRecords(records)
}

/** 只改 realtime / clock_rate 两条指令；保留原行缩进与行尾。 */
export function replaceSimulationSpeed(
  text: string,
  fileName: Template1112FileName,
  realtimeEnabled: boolean,
  clockRate: number,
): string {
  if (!Number.isFinite(clockRate) || clockRate <= 0) throw new TemplateRegionError(fileName, 'clock_rate', `：倍速必须是大于 0 的有限数，当前为 ${String(clockRate)}。`)
  const afterRealtime = replaceUniqueLine(text, fileName, 'realtime 指令', content => /^\s*(?:\/\/)?\s*realtime\s*$/u.test(content), content => {
    const indent = /^\s*/u.exec(content)?.[0] ?? ''
    return `${indent}${realtimeEnabled ? 'realtime' : '//realtime'}`
  })
  return replaceUniqueLine(afterRealtime, fileName, 'clock_rate 指令', content => /^\s*(?:\/\/)?\s*clock_rate\s+\S+\s*$/u.test(content), content => {
    const indent = /^\s*/u.exec(content)?.[0] ?? ''
    return `${indent}clock_rate ${String(clockRate)}`
  })
}

type LaserRename = { fileName: Template1112FileName; line: number; before: string; after: string }

/** 仅统一明确指向激光端口的声明/引用，不做全局文本替换。 */
function normalizeLaserPortName(fileName: Template1112FileName, text: string): { text: string; renames: LaserRename[] } {
  const renames: LaserRename[] = []
  const records = splitLineRecords(text)
  const normalized = records.map((record, index) => {
    let content = record.content
    const replacements: Array<[RegExp, (match: string, prefix: string, suffix: string) => string]> = [
      [/^(\s*comm\s+)laser_link(\s+)/u, (match, prefix, suffix) => prefix + 'lazer_link' + suffix],
      [/("comm_name"\s*:\s*")laser_link(")/gu, (match, prefix, suffix) => prefix + 'lazer_link' + suffix],
      [/(Comm\(\s*")laser_link(")/gu, (match, prefix, suffix) => prefix + 'lazer_link' + suffix],
    ]
    for (const [pattern, replace] of replacements) {
      content = content.replace(pattern, (match, prefix: string, suffix: string) => {
        renames.push({ fileName, line: index + 1, before: match, after: replace(match, prefix, suffix) })
        return replace(match, prefix, suffix)
      })
    }
    return content === record.content ? record : { ...record, content }
  })
  return { text: joinLineRecords(normalized), renames }
}

export type TemplateRenderInput = {
  rearSituationDestinations: readonly string[]
  rearTargetDestinations: readonly string[]
  relayNames: readonly string[]
  returnVideoDestinations: readonly string[]
  returnStatusDestinations: readonly string[]
  /** comm_platform_INS.txt 中无人机编队段的完整文本行（含注释头与各 mission_uav 实例块）。 */
  missionUavLines: readonly string[]
  /** comm_platform_INS.txt 中 5.x 干扰源配置段的完整文本行（含注释头与各干扰源实例块）。 */
  jammerLines: readonly string[]
  /** 完整 link_calc 块，含 add processor 与 end_processor 行。 */
  linkCalcLines: readonly string[]
  /** 本地运行包用 local_link_stub 原位替换时传入对应处理器声明。 */
  linkCalcHeader?: RegExp
  realtimeEnabled: boolean
  clockRate: number
}

export type TemplateRenderReport = {
  files: Record<Template1112FileName, string>
  regions: Array<{ fileName: Template1112FileName; region: string }>
  laserRenames: LaserRename[]
}

/** 生成 10 个执行 TXT：固定模板 + 受控替换。 */
export function renderTemplate1112(input: TemplateRenderInput): TemplateRenderReport {
  const files = {} as Record<Template1112FileName, string>
  const uavFile = 'comm_platform_MISSION_UAV.txt'
  const laserRenames: LaserRename[] = []
  for (const fileName of Object.keys(TEMPLATE_1112_FILES) as Template1112FileName[]) {
    const normalized = normalizeLaserPortName(fileName, TEMPLATE_1112_FILES[fileName])
    files[fileName] = normalized.text
    laserRenames.push(...normalized.renames)
  }
  files['comm_platform_INS.txt'] = replaceMissionUavSection(files['comm_platform_INS.txt'], 'comm_platform_INS.txt', input.missionUavLines)
  files['comm_platform_INS.txt'] = replaceJammerSection(files['comm_platform_INS.txt'], 'comm_platform_INS.txt', input.jammerLines)
  files['comm_platform_REAR.txt'] = replaceArrayValues(files['comm_platform_REAR.txt'], 'comm_platform_REAR.txt', 'fw_sit_dst', input.rearSituationDestinations)
  files['comm_platform_REAR.txt'] = replaceArrayValues(files['comm_platform_REAR.txt'], 'comm_platform_REAR.txt', 'fw_tgt_dst', input.rearTargetDestinations)
  files['comm_platform_REAR.txt'] = replaceLinkCalcBlock(files['comm_platform_REAR.txt'], 'comm_platform_REAR.txt', input.linkCalcLines, input.linkCalcHeader)
  files[uavFile] = replaceArrayValues(files[uavFile], uavFile, 'relayNames', input.relayNames)
  files[uavFile] = replaceArrayValues(files[uavFile], uavFile, 'rt_video_dsts', input.returnVideoDestinations)
  files[uavFile] = replaceArrayValues(files[uavFile], uavFile, 'rt_status_dsts', input.returnStatusDestinations)
  files[uavFile] = replaceUniqueLine(files[uavFile], uavFile, 'sat_link 接收频率',
    content => /^[ \t]*frequency 11\.8 MHz[ \t]*$/u.test(content),
    content => content.replace('11.8 MHz', '11.8 GHz'))
  files['comm_SimSetup.txt'] = replaceSimulationSpeed(files['comm_SimSetup.txt'], 'comm_SimSetup.txt', input.realtimeEnabled, input.clockRate)
  return {
    files,
    regions: [
      { fileName: 'comm_platform_INS.txt', region: 'mission_uav 实例段（数量/阵营/位置/航线/盘旋/返航/角色）' },
      { fileName: 'comm_platform_INS.txt', region: '5.x 干扰源实例段（数量/阵营/位置/航线/盘旋/侦测范围）' },
      { fileName: 'comm_platform_REAR.txt', region: 'fw_sit_dst 数组' },
      { fileName: 'comm_platform_REAR.txt', region: 'fw_tgt_dst 数组' },
      { fileName: 'comm_platform_REAR.txt', region: 'link_calc 处理器参数块' },
      { fileName: 'comm_platform_MISSION_UAV.txt', region: 'relayNames 数组' },
      { fileName: 'comm_platform_MISSION_UAV.txt', region: 'rt_video_dsts 数组' },
      { fileName: 'comm_platform_MISSION_UAV.txt', region: 'rt_status_dsts 数组' },
      { fileName: uavFile, region: 'sat_link 接收频率单位' },
      { fileName: 'comm_SimSetup.txt', region: 'realtime / clock_rate' },
    ],
    laserRenames,
  }
}

/** 从本次脚本预览的 mapping.json 注释段读取生成器的字段级事实，不在前端重复推断生成结果。 */
export type ScriptExecutionStatusEntry = { fieldPath: string; detail: string }
export type ScriptExecutionStatus = { emitted: ScriptExecutionStatusEntry[]; retainedSnapshot: ScriptExecutionStatusEntry[]; dependencyUnconfirmed: ScriptExecutionStatusEntry[] }

type Status = keyof ScriptExecutionStatus
type AcceptanceGroup = 'platform' | 'communication' | 'sensor' | 'jammer' | 'timeline'
type AcceptanceLocation = { fileName: string; fileLine: number; previewLine: number; endPreviewLine?: number }
type PreviewFile = { fileName: string; header: number; end: number }
export type ScriptAcceptanceEntry = ScriptExecutionStatusEntry & {
  status: Status
  group: AcceptanceGroup
  location: AcceptanceLocation | null
}

const statusLabels = [
  ['emitted', '已写入执行'],
  ['retainedSnapshot', '仅保留快照'],
  ['dependencyUnconfirmed', '依赖待确认'],
] as const

const acceptanceGroups = new Map<string, AcceptanceGroup>([
  ['platforms', 'platform'],
  ['links', 'communication'], ['linkSettings', 'communication'], ['informationDemand', 'communication'], ['deviceParameters', 'communication'],
  ['sensors', 'sensor'], ['uiExtensions.sensors', 'sensor'],
  ['jammers', 'jammer'], ['uiExtensions.jammers', 'jammer'],
  ['scenario', 'timeline'], ['output', 'timeline'], ['references', 'timeline'],
])

function entries(value: unknown): ScriptExecutionStatusEntry[] | null {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'object' && item !== null && typeof item.fieldPath === 'string' && typeof item.detail === 'string')) return null
  return value as ScriptExecutionStatusEntry[]
}

/** 预览中的 mapping.json 每行以 // 前缀保存，去除注释后严格验证最小结构。 */
function parseScriptExecutionStatus(preview: string) {
  const lines = preview.split(/\r\n?|\n/u)
  const header = lines.indexOf('// ===== mapping.json =====')
  if (header < 0) return null
  const end = lines.findIndex((line, index) => index > header && line.startsWith('// ===== '))
  const section = lines.slice(header + 1, end < 0 ? undefined : end)
  const jsonStart = section.findIndex(line => line === '// {')
  if (jsonStart < 0) return null
  try {
    const json = section.slice(jsonStart).map(line => line.startsWith('// ') ? line.slice(3) : line).join('\n').trimEnd()
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return null
    const status = (parsed as { executionStatus?: unknown }).executionStatus
    if (typeof status !== 'object' || status === null) return null
    const value = status as Partial<Record<Status, unknown>>
    const emitted = entries(value.emitted)
    const retainedSnapshot = entries(value.retainedSnapshot)
    const dependencyUnconfirmed = entries(value.dependencyUnconfirmed)
    if (emitted === null || retainedSnapshot === null || dependencyUnconfirmed === null) return null
    return { status: { emitted, retainedSnapshot, dependencyUnconfirmed }, parsed, json, lines, bodyOffset: header + 1 + jsonStart }
  } catch { return null }
}

export function readScriptExecutionStatus(preview: string): ScriptExecutionStatus | null {
  return parseScriptExecutionStatus(preview)?.status ?? null
}

function statusFieldLines(lines: string[], status: Status, items: ScriptExecutionStatusEntry[]): number[] {
  const section = lines.indexOf('  "executionStatus": {')
  if (section < 0) return []
  const sectionEnd = lines.findIndex((line, index) => index > section && (line === '  }' || line === '  },'))
  if (sectionEnd < 0) return []
  const start = lines.findIndex((line, index) => index > section && index < sectionEnd && line === '    "' + status + '": [')
  if (start < 0) return []
  const end = lines.findIndex((line, index) => index > start && index < sectionEnd && (line === '    ]' || line === '    ],'))
  if (end < 0) return []
  const fields: number[] = []
  for (let index = start + 1; index < end; index += 1) {
    if (lines[index]!.startsWith('        "fieldPath": ')) fields.push(index)
  }
  if (fields.length !== items.length) return []
  if (fields.some((index, position) => lines[index]!.replace(/,$/u, '')
    !== '        "fieldPath": ' + JSON.stringify(items[position]!.fieldPath))) return []
  return fields
}

function previewTextFiles(lines: readonly string[]): PreviewFile[] {
  const headers = lines.flatMap((line, header) => {
    const match = /^\/\/ ===== ([^/\\]+) =====$/u.exec(line)
    return match ? [{ fileName: match[1]!, header }] : []
  })
  return headers.map((file, index) => ({ ...file, end: headers[index + 1]?.header ?? lines.length }))
    .filter(file => /\.txt$/iu.test(file.fileName))
}

function uniqueTextLine(lines: readonly string[], files: readonly PreviewFile[], pattern: RegExp | string, range?: { start: number; end: number }): AcceptanceLocation | null {
  let found: AcceptanceLocation | null = null
  for (const file of files) {
    const start = Math.max(file.header + 1, range?.start ?? 0)
    const end = Math.min(file.end, range?.end ?? lines.length)
    for (let index = start; index < end; index += 1) {
      const line = lines[index]!.trim()
      if (typeof pattern === 'string' ? line !== pattern : !pattern.test(line)) continue
      if (found) return null
      found = { fileName: file.fileName, fileLine: index - file.header, previewLine: index + 1 }
    }
  }
  return found && files.filter(file => file.fileName === found?.fileName).length === 1 ? found : null
}

const entryDefinitions = new Map<string, RegExp>([
  ['scenario.startTime', /^start_date\s+\S/u],
  ['scenario.duration', /^end_time\s+\S/u],
  ['scenario.realtime', /^clock_rate\s+\S/u],
])
const linkCalcDefinitions: Array<{ field: RegExp; directive?: RegExp; wholeBlock?: boolean }> = [
  { field: /^linkSettings\.linkCalc$/u, wholeBlock: true },
  { field: /^links\[\d+\]$/u, directive: /^port_params\s+\[/u, wholeBlock: true },
  { field: /^linkSettings\.hotLinks$/u, directive: /^hot_link_fw\s+\S/u },
  { field: /^deviceParameters\.ports\.[^.]+\.[^.]+$/u, directive: /^port_params\s+\[/u },
  { field: /^informationDemand\[\d+\]$/u, directive: /^traffic_type\s+\[/u },
  { field: /^jammers\[\d+\]$/u, directive: /^jammer_param\s+\{/u },
]

function linkCalcTextLocation(lines: readonly string[], files: readonly PreviewFile[], definition: typeof linkCalcDefinitions[number]): AcceptanceLocation | null {
  const owners = files.filter(file => file.fileName === 'comm_platform_REAR.txt')
  const file = owners[0]
  if (!file || owners.length !== 1) return null
  const opening = uniqueTextLine(lines, owners, /^(?:add\s+)?processor\s+link_calc(?:\s|$)/u)
  if (!opening) return null

  const start = opening.previewLine
  const end = lines.findIndex((line, index) => index >= start && index < file.end
    && /^(?:end_processor$|(?:add\s+)?processor\s)/u.test(line.trim()))
  if (end < 0 || lines[end]!.trim() !== 'end_processor') return null

  const source = definition.directive ? uniqueTextLine(lines, owners, definition.directive, { start, end }) : opening
  if (!source) return null
  return definition.wholeBlock ? { ...opening, endPreviewLine: end + 1 } : source
}

function emittedTextLocation(fieldPath: string, mapping: NonNullable<ReturnType<typeof parseScriptExecutionStatus>>, files: readonly PreviewFile[]): AcceptanceLocation | null {
  const definition = entryDefinitions.get(fieldPath)
  if (definition) {
    const entry = 'entry' in mapping.parsed ? mapping.parsed.entry : undefined
    const entryFiles = files.filter(file => file.fileName === entry)
    return entryFiles.length === 1 ? uniqueTextLine(mapping.lines, entryFiles, definition) : null
  }
  const linkCalcDefinition = linkCalcDefinitions.find(rule => rule.field.test(fieldPath))
  if (linkCalcDefinition) return linkCalcTextLocation(mapping.lines, files, linkCalcDefinition)

  const platformField = /^platforms\[(\d+)\]\.(id|initialPosition|waypoints|returnPlan)$/u.exec(fieldPath)
  const platforms = 'platforms' in mapping.parsed ? mapping.parsed.platforms : undefined
  if (!platformField || !Array.isArray(platforms)) return null
  const identity: unknown = platforms[Number(platformField[1])]
  if (typeof identity !== 'object' || identity === null || !('name' in identity) || !('generatedType' in identity)
    || typeof identity.name !== 'string' || !/^\S+$/u.test(identity.name)
    || typeof identity.generatedType !== 'string' || !/^\S+$/u.test(identity.generatedType)) return null

  const declaration = uniqueTextLine(mapping.lines, files, `platform ${identity.name} ${identity.generatedType}`)
  if (!declaration || platformField[2] === 'id') return declaration
  const file = files.find(item => item.fileName === declaration.fileName && item.header < declaration.previewLine && item.end >= declaration.previewLine)
  if (!file) return null
  if (platformField[2] === 'returnPlan') return uniqueTextLine(mapping.lines, [file], `route return_${identity.name}`)

  const start = declaration.previewLine
  const end = mapping.lines.findIndex((line, index) => index >= start && index < file.end
    && /^(?:end_platform$|platform\s)/u.test(line.trim()))
  if (end < 0 || mapping.lines[end]!.trim() !== 'end_platform') return null

  const route = /^route(?:\s|$)/u
  if (platformField[2] === 'waypoints') return uniqueTextLine(mapping.lines, [file], route, { start, end })
  const routeStart = mapping.lines.findIndex((line, index) => index >= start && index < end && route.test(line.trim()))
  return uniqueTextLine(mapping.lines, [file], /^position\s+\S/u, { start, end: routeStart < 0 ? end : routeStart })
}

/** 原文位置来自预览中可唯一定位的定义，清单位置只使用生成器的原始 JSON 排版。 */
export function readScriptAcceptanceReview(preview: string): ScriptAcceptanceEntry[] | null {
  const mapping = parseScriptExecutionStatus(preview)
  if (!mapping) return null
  const textFiles = previewTextFiles(mapping.lines)
  const lines = mapping.json === JSON.stringify(mapping.parsed, null, 2) ? mapping.json.split('\n') : []
  const review = statusLabels.flatMap(([status]) => {
    const items = mapping.status[status]
    const fieldLines = statusFieldLines(lines, status, items)
    return items.flatMap(({ fieldPath, detail }, index) => {
      const [root, extension] = fieldPath.split(/[.\[]/u, 2)
      const group = acceptanceGroups.get(root === 'uiExtensions' ? root + '.' + (extension ?? '') : root ?? '')
      if (!group) return []
      const fieldLine = fieldLines[index]
      const manifestLocation = fieldLine === undefined ? null : {
        fileName: 'mapping.json', fileLine: fieldLine + 1, previewLine: mapping.bodyOffset + fieldLine + 1,
      }
      const location = (status === 'emitted' ? emittedTextLocation(fieldPath, mapping, textFiles) : null) ?? manifestLocation
      return [{ fieldPath, detail, status, group, location }]
    })
  })
  const entry = 'entry' in mapping.parsed ? mapping.parsed.entry : undefined
  const introductoryFiles = textFiles.filter(file => file.fileName === 'scenario.txt')
  if (typeof entry === 'string' && entry && introductoryFiles.length === 1) {
    const location = uniqueTextLine(mapping.lines, introductoryFiles, `include_once ${entry}`)
    if (location) {
      review.push({
        fieldPath: 'references.entry', detail: `入口脚本引用 ${entry}。`, status: 'emitted', group: 'timeline',
        location,
      })
    }
  }
  return review
}

/** 逐行展示生成器记录的 fieldPath 与处理状态；解析失败不使用前端猜测作为替代。 */
export function formatScriptExecutionLog(preview: string): string[] {
  const status = readScriptExecutionStatus(preview)
  if (status === null) return ['未能读取本次预览中的 mapping.json.executionStatus；请重新生成预览，不能据此判断配置是否已写入执行包。']
  return statusLabels.flatMap(([key, label]) => status[key].map(item => '[' + label + '] ' + item.fieldPath + '：' + item.detail))
}

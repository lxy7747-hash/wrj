import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REFERENCE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'afsim-template-20261101')

export interface TemplateStatement {
  line: number
  text: string
  uiConfiguration: boolean
}

export interface TemplateChange {
  previous?: TemplateStatement
  next?: TemplateStatement
  reason?: string
}

export interface FileComparison {
  file: string
  added: TemplateChange[]
  deleted: TemplateChange[]
  changed: TemplateChange[]
  uiConfigurationMarkers: TemplateChange[]
}

export interface TemplateComparison {
  referenceDirectory: string
  candidateDirectory: string
  addedFiles: string[]
  deletedFiles: string[]
  files: FileComparison[]
}

interface ComparableStatement extends TemplateStatement {
  key: string
  orderKey: string
}

interface NormalizedDocument {
  statements: ComparableStatement[]
  standaloneMarkers: TemplateStatement[]
}

function stripComment(line: string): { statement: string; comment: string } {
  let quote: string | undefined
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    if (quote !== undefined) {
      if (character === '\\' && index + 1 < line.length) { index += 1; continue }
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === '#' || (character === '/' && line[index + 1] === '/')) return { statement: line.slice(0, index), comment: line.slice(index) }
  }
  return { statement: line, comment: '' }
}

function normaliseNumber(raw: string | number): string {
  return String(Number(raw))
}

function normaliseDate(value: string): string | undefined {
  const trimmed = value.trim()
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(trimmed)
  if (iso) return `${iso[1]}-${iso[2]!.padStart(2, '0')}-${iso[3]!.padStart(2, '0')}`
  const named = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})\s+(\d{4})$/iu.exec(trimmed)
  if (!named) return undefined
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  return `${named[3]}-${String(months.indexOf(named[1]!.toLowerCase()) + 1).padStart(2, '0')}-${named[2]!.padStart(2, '0')}`
}

function normaliseTime(value: string): string | undefined {
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/u.exec(value.trim())
  return match ? `${match[1]!.padStart(2, '0')}:${match[2]!.padStart(2, '0')}:${(match[3] ?? '00').padStart(2, '0')}` : undefined
}

function transformOutsideQuotes(value: string, transform: (outside: string) => string): string {
  let result = ''
  let segmentStart = 0
  let quote: string | undefined
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (quote !== undefined) {
      if (character === '\\' && index + 1 < value.length) { index += 1; continue }
      if (character === quote) {
        result += value.slice(segmentStart, index + 1)
        segmentStart = index + 1
        quote = undefined
      }
      continue
    }
    if (character === '"' || character === "'") {
      result += transform(value.slice(segmentStart, index)) + character
      segmentStart = index + 1
      quote = character
    }
  }
  return result + (quote === undefined ? transform(value.slice(segmentStart)) : value.slice(segmentStart))
}

function normaliseNativeSpacing(value: string): string {
  return transformOutsideQuotes(value, outside => outside.replace(/\s+/gu, ' '))
}

function normaliseNativeNumbers(value: string): string {
  return transformOutsideQuotes(value, outside => outside.replace(/(^|[\s(,=])(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?=$|[\s),;]|(?=[nsew]\b))/gimu, (_match, prefix: string, raw: string) => `${prefix}${normaliseNumber(raw)}`))
}

/** 这里只合并 §8.2 中语法层面的等价写法，数值差异仍会显示。 */
function canonicalStatement(statement: string): string {
  const raw = statement.trim()
  // 先解析 JSON，再做空白和数值规范化：JSON 的键和字符串是数据，不是脚本里的数值记号。
  const json = /^(\S+)\s+([\[{].*)$/u.exec(raw)
  if (json) {
    try {
      JSON.parse(json[2]!)
      return `${json[1]} ${json[2]}`
    } catch { /* fall through so malformed text is diffed verbatim */ }
  }
  let result = normaliseNativeSpacing(raw).trim()
  const date = /^start_date\s+(.+)$/iu.exec(result)
  if (date) return `start_date ${normaliseDate(date[1]!) ?? date[1]!.toLowerCase()}`
  const time = /^start_time\s+(.+)$/iu.exec(result)
  if (time) return `start_time ${normaliseTime(time[1]!) ?? time[1]}`
  const duration = /^end_time\s+(-?\d+(?:\.\d+)?)\s+(sec|min)$/iu.exec(result)
  if (duration) return `end_time ${normaliseNumber(Number(duration[1]) * (duration[2]!.toLowerCase() === 'min' ? 60 : 1))} sec`
  result = transformOutsideQuotes(result, outside => outside.replace(/(-?\d+(?:\.\d+)?)\s*(kts|km\/h)\b/giu, (_match, raw: string, unit: string) => `${unit.toLowerCase() === 'kts' ? normaliseNumber(Number(raw) * 0.5144444444444445) : normaliseNumber(Number(raw) / 3.6)} m/s`))
  if (/\baltitude\b/iu.test(result)) result = transformOutsideQuotes(result, outside => outside.replace(/(-?\d+(?:\.\d+)?)\s*km\b/giu, (_match, raw: string) => `${normaliseNumber(Number(raw) * 1000)} m`))
  result = normaliseNativeNumbers(result)
  if (/^(?:file|include_once)\b/iu.test(result)) result = result.replace(/\\/gu, '/')
  return result
}

function jsonKey(value: unknown, preserveOrder: boolean): string {
  if (Array.isArray(value)) return `[${value.map(item => jsonKey(item, preserveOrder)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!preserveOrder) entries.sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${jsonKey(item, preserveOrder)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function jsonComparisonKeys(statement: string): { semantic: string; order: string } | undefined {
  const match = /^(\S+)\s+([\[{].*)$/u.exec(statement)
  if (!match) return undefined
  try {
    const value = JSON.parse(match[2]!) as unknown
    return { semantic: `${match[1]} ${jsonKey(value, false)}`, order: `${match[1]} ${jsonKey(value, true)}` }
  } catch {
    return undefined
  }
}

function normaliseRouteNames(statements: ComparableStatement[]): void {
  const routes = new Map<string, string>()
  let routeIndex = 0
  for (const statement of statements) {
    const route = /^route\s+([A-Za-z0-9_-]+)$/u.exec(statement.key)
    if (route && !routes.has(route[1]!)) routes.set(route[1]!, `__route_${routeIndex++}`)
  }
  let activeLabels = new Map<string, string>()
  let labelIndex = 0
  for (const statement of statements) {
    if (/^route\s+/u.test(statement.key)) { activeLabels = new Map(); labelIndex = 0 }
    const label = /^label\s+([A-Za-z0-9_-]+)$/u.exec(statement.key)
    if (label && !activeLabels.has(label[1]!)) activeLabels.set(label[1]!, `__label_${labelIndex++}`)
    statement.key = statement.key
      .replace(/^route\s+([A-Za-z0-9_-]+)$/u, (_match, name: string) => `route ${routes.get(name) ?? name}`)
      .replace(/^label\s+([A-Za-z0-9_-]+)$/u, (_match, name: string) => `label ${activeLabels.get(name) ?? name}`)
      .replace(/^goto\s+([A-Za-z0-9_-]+)$/u, (_match, name: string) => `goto ${activeLabels.get(name) ?? name}`)
      .replace(/FollowRoute\("([A-Za-z0-9_-]+)"\)/u, (_match, name: string) => `FollowRoute("${routes.get(name) ?? name}")`)
    statement.orderKey = statement.orderKey
      .replace(/^route\s+([A-Za-z0-9_-]+)$/u, (_match, name: string) => `route ${routes.get(name) ?? name}`)
      .replace(/^label\s+([A-Za-z0-9_-]+)$/u, (_match, name: string) => `label ${activeLabels.get(name) ?? name}`)
      .replace(/^goto\s+([A-Za-z0-9_-]+)$/u, (_match, name: string) => `goto ${activeLabels.get(name) ?? name}`)
      .replace(/FollowRoute\("([A-Za-z0-9_-]+)"\)/u, (_match, name: string) => `FollowRoute("${routes.get(name) ?? name}")`)
    if (statement.key === 'end_route') activeLabels = new Map()
  }
}

function normaliseDocument(contents: string, startDateTime: string | undefined): NormalizedDocument {
  const statements: ComparableStatement[] = []
  const standaloneMarkers: TemplateStatement[] = []
  for (const [index, original] of contents.replace(/\r\n?/gu, '\n').split('\n').entries()) {
    const { statement, comment } = stripComment(original)
    const text = canonicalStatement(statement)
    if (!text) {
      if (/界面配置/u.test(comment)) standaloneMarkers.push({ line: index + 1, text: comment.trim().replace(/\s+/gu, ' '), uiConfiguration: true })
      continue
    }
    let key = text
    const json = jsonComparisonKeys(text)
    let orderKey = text
    if (json) { key = json.semantic; orderKey = json.order }
    const epoch = /^epoch_date_time\s+(.+)$/iu.exec(text)
    if (epoch && startDateTime !== undefined && normaliseEpoch(epoch[1]!) === startDateTime) {
      key = 'epoch_date_time <follows-start-time>'
      orderKey = key
    }
    statements.push({ line: index + 1, text, uiConfiguration: /界面配置/u.test(comment), key, orderKey })
  }
  normaliseRouteNames(statements)
  return { statements, standaloneMarkers }
}

function normaliseEpoch(value: string): string | undefined {
  const tokens = value.trim().split(/\s+/u)
  if (tokens.length < 4) return undefined
  const date = normaliseDate(tokens.slice(0, 3).join(' '))
  const time = normaliseTime(tokens[3]!)
  return date && time ? `${date} ${time}` : undefined
}

function startDateTime(contents: string): string | undefined {
  let date: string | undefined
  let time: string | undefined
  for (const original of contents.replace(/\r\n?/gu, '\n').split('\n')) {
    const text = canonicalStatement(stripComment(original).statement)
    const dateMatch = /^start_date\s+(.+)$/u.exec(text)
    const timeMatch = /^start_time\s+(.+)$/u.exec(text)
    if (dateMatch) date = dateMatch[1]!
    if (timeMatch) time = timeMatch[1]!
  }
  return date && time ? `${date} ${time}` : undefined
}

async function listFiles(directory: string): Promise<string[]> {
  const result: string[] = []
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name)
      // 只比对模板 TXT；对接方目录里常带引擎运行留下的 mission.log 和 output/，不属于模板。
      if (entry.isDirectory()) { if (entry.name !== 'output') await visit(path) }
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) result.push(relative(directory, path).split(sep).join('/'))
    }
  }
  await visit(directory)
  return result.sort()
}

function lcsPairs(previous: ComparableStatement[], next: ComparableStatement[]): Array<[number, number]> {
  const table = Array.from({ length: previous.length + 1 }, () => Array<number>(next.length + 1).fill(0))
  for (let left = previous.length - 1; left >= 0; left -= 1) for (let right = next.length - 1; right >= 0; right -= 1) {
    table[left]![right] = previous[left]!.key === next[right]!.key ? table[left + 1]![right + 1]! + 1 : Math.max(table[left + 1]![right]!, table[left]![right + 1]!)
  }
  const pairs: Array<[number, number]> = []
  let left = 0
  let right = 0
  while (left < previous.length && right < next.length) {
    if (previous[left]!.key === next[right]!.key) { pairs.push([left++, right++]); continue }
    if (table[left + 1]![right]! >= table[left]![right + 1]!) left += 1
    else right += 1
  }
  return pairs
}

function markerChanges(previous: ComparableStatement[], next: ComparableStatement[], changes: TemplateChange[]): TemplateChange[] {
  const result = [...changes.filter(change => change.previous?.uiConfiguration || change.next?.uiConfiguration)]
  const paired = lcsPairs(previous, next)
  for (const [left, right] of paired) {
    const oldStatement = previous[left]!
    const newStatement = next[right]!
    if (oldStatement.uiConfiguration !== newStatement.uiConfiguration) result.push({ previous: oldStatement, next: newStatement, reason: oldStatement.uiConfiguration ? '界面配置标记已移除' : '界面配置标记已新增' })
  }
  return result
}

function standaloneMarkerChanges(previous: TemplateStatement[], next: TemplateStatement[]): TemplateChange[] {
  const remaining = [...next]
  const result: TemplateChange[] = []
  for (const marker of previous) {
    const match = remaining.findIndex(candidate => candidate.text === marker.text)
    if (match < 0) result.push({ previous: marker, reason: '界面配置标记已移除' })
    else remaining.splice(match, 1)
  }
  for (const marker of remaining) result.push({ next: marker, reason: '界面配置标记已新增' })
  return result
}

function compareFile(file: string, previous: NormalizedDocument, next: NormalizedDocument): FileComparison | undefined {
  const pairs = lcsPairs(previous.statements, next.statements)
  const added: TemplateChange[] = []
  const deleted: TemplateChange[] = []
  const changed: TemplateChange[] = []
  const consumeGap = (previousIndexes: number[], nextIndexes: number[]) => {
    const shared = Math.min(previousIndexes.length, nextIndexes.length)
    for (let index = 0; index < shared; index += 1) changed.push({ previous: previous.statements[previousIndexes[index]!]!, next: next.statements[nextIndexes[index]!]! })
    for (const index of previousIndexes.slice(shared)) deleted.push({ previous: previous.statements[index]! })
    for (const index of nextIndexes.slice(shared)) added.push({ next: next.statements[index]! })
  }
  let beforePrevious = 0
  let beforeNext = 0
  for (const [previousIndex, nextIndex] of [...pairs, [previous.statements.length, next.statements.length] as [number, number]]) {
    consumeGap(Array.from({ length: previousIndex - beforePrevious }, (_value, index) => beforePrevious + index), Array.from({ length: nextIndex - beforeNext }, (_value, index) => beforeNext + index))
    if (previousIndex < previous.statements.length && previous.statements[previousIndex]!.orderKey !== next.statements[nextIndex]!.orderKey) changed.push({ previous: previous.statements[previousIndex]!, next: next.statements[nextIndex]!, reason: 'JSON 键顺序发生变化' })
    beforePrevious = previousIndex + 1
    beforeNext = nextIndex + 1
  }
  const uiConfigurationMarkers = [
    ...markerChanges(previous.statements, next.statements, [...added, ...deleted, ...changed]),
    ...standaloneMarkerChanges(previous.standaloneMarkers, next.standaloneMarkers),
  ]
  return added.length || deleted.length || changed.length || uiConfigurationMarkers.length ? { file, added, deleted, changed, uiConfigurationMarkers } : undefined
}

async function readTemplate(directory: string): Promise<Map<string, string>> {
  const files = await listFiles(directory)
  return new Map(await Promise.all(files.map(async file => [file, await readFile(resolve(directory, file), 'utf8')] as const)))
}

async function requireDirectory(directory: string, label: string): Promise<void> {
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error(`${label}不是可读取的目录：${directory}`)
  }
}

/** 读取两个模板目录，不写入任何一方。 */
export async function compareAfsimTemplates(candidateDirectory: string, referenceDirectory = REFERENCE_DIRECTORY): Promise<TemplateComparison> {
  const candidate = resolve(candidateDirectory)
  const reference = resolve(referenceDirectory)
  await requireDirectory(candidate, '新模板目录')
  await requireDirectory(reference, '基准模板目录')
  const [previousFiles, nextFiles] = await Promise.all([readTemplate(reference), readTemplate(candidate)])
  const referenceNames = [...previousFiles.keys()]
  const candidateNames = [...nextFiles.keys()]
  const common = referenceNames.filter(name => nextFiles.has(name))
  const previousStart = startDateTime(previousFiles.get('comm_SimSetup.txt') ?? '')
  const nextStart = startDateTime(nextFiles.get('comm_SimSetup.txt') ?? '')
  const files = common.flatMap(file => {
    const comparison = compareFile(file, normaliseDocument(previousFiles.get(file)!, previousStart), normaliseDocument(nextFiles.get(file)!, nextStart))
    return comparison ? [comparison] : []
  })
  for (const file of candidateNames.filter(name => !previousFiles.has(name))) {
    const comparison = compareFile(file, { statements: [], standaloneMarkers: [] }, normaliseDocument(nextFiles.get(file)!, nextStart))
    if (comparison) files.push(comparison)
  }
  for (const file of referenceNames.filter(name => !nextFiles.has(name))) {
    const comparison = compareFile(file, normaliseDocument(previousFiles.get(file)!, previousStart), { statements: [], standaloneMarkers: [] })
    if (comparison) files.push(comparison)
  }
  files.sort((left, right) => left.file.localeCompare(right.file))
  return {
    referenceDirectory: reference,
    candidateDirectory: candidate,
    addedFiles: candidateNames.filter(name => !previousFiles.has(name)),
    deletedFiles: referenceNames.filter(name => !nextFiles.has(name)),
    files,
  }
}

function printStatement(statement: TemplateStatement | undefined): string {
  return statement ? `${statement.line}: ${statement.text}${statement.uiConfiguration ? '  [界面配置]' : ''}` : '(无)'
}

export function formatTemplateComparison(comparison: TemplateComparison): string {
  const lines = [`AFSIM 模板比对（只读）`, `基准: ${comparison.referenceDirectory}`, `新模板: ${comparison.candidateDirectory}`]
  for (const file of comparison.addedFiles) lines.push(`文件新增 ${file}`)
  for (const file of comparison.deletedFiles) lines.push(`文件删除 ${file}`)
  for (const file of comparison.files) {
    lines.push(`\n${file.file}`)
    for (const change of file.added) lines.push(`  新增: ${printStatement(change.next)}`)
    for (const change of file.deleted) lines.push(`  删除: ${printStatement(change.previous)}`)
    for (const change of file.changed) lines.push(`  改动: ${printStatement(change.previous)} -> ${printStatement(change.next)}${change.reason ? ` (${change.reason})` : ''}`)
    for (const marker of file.uiConfigurationMarkers) lines.push(`  界面配置标记: ${printStatement(marker.previous)} -> ${printStatement(marker.next)}${marker.reason ? ` (${marker.reason})` : ''}`)
  }
  const changes = comparison.addedFiles.length + comparison.deletedFiles.length + comparison.files.reduce((total, file) => total + file.added.length + file.deleted.length + file.changed.length, 0)
  lines.push(`\n结果: ${changes === 0 ? '未发现语义变更' : `发现 ${changes} 项语句或文件变更`}；界面配置标记变更 ${comparison.files.reduce((total, file) => total + file.uiConfigurationMarkers.length, 0)} 项。`)
  return lines.join('\n')
}

async function main(): Promise<void> {
  const candidate = process.argv[2]
  if (!candidate || candidate === '--help' || candidate === '-h') {
    console.error('用法：tsx scripts/compare-afsim-template.ts <新模板目录>')
    process.exitCode = candidate ? 0 : 2
    return
  }
  console.log(formatTemplateComparison(await compareAfsimTemplates(candidate)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`模板比对失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

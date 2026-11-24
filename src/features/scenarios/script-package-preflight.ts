export interface ScriptGenerationReceipt {
  path: string
  version: string
  log: string[]
}

import { isSafeScriptFilename, type ScriptPackageEngineLoadCheckRequest } from './script-engine-load-contract'

type PackageIdentity = { scenarioId: string; revision: number; entry: string }
type ScriptFilePreflight = {
  path: string
  state: 'unchecked' | 'missing' | 'unreadable' | 'checked'
  references: number
  referenceErrors: number
  referenceWarnings: number
  closedBlocks: number
  structureErrors: number
}

export interface ScriptPackagePreflightResult {
  folder: string
  identity: PackageIdentity | null
  entryState: 'unchecked' | 'missing' | 'unreadable' | 'empty' | 'present'
  filesExpected: number
  filesPresent: number
  referencesChecked: number
  scriptFiles: ScriptFilePreflight[]
  errors: string[]
  warnings: string[]
}

type SelectedFile = Pick<File, 'size' | 'webkitRelativePath' | 'text'>
type PackageManifest = PackageIdentity & { scriptFiles: string[] }

const METADATA = ['metadata/mapping.json', 'metadata/input.json'] as const
const LEGACY_METADATA = ['mapping.json', 'input.json'] as const
const MAX_SELECTED_FILES = 4096
const MAX_DECLARED_FILES = 128
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_DIRECTIVES = 2000
const MAX_STRUCTURE_ERRORS = 50
const LINE_BREAK = /\r\n?|\n/u
const QUOTED_TEXT = /"(?:[^"\\\r\n]|\\[^\r\n])*"|'(?:[^'\\\r\n]|\\[^\r\n])*'/.source
const SCRIPT_STRINGS = new RegExp('(' + QUOTED_TEXT + ')|["\'][^\\r\\n]*', 'gu')
const SCRIPT_COMMENTS = new RegExp(QUOTED_TEXT + '|["\'][^\\r\\n]*|(\\/\\*[\\s\\S]*?(?:\\*\\/|$)|\\/\\/[^\\r\\n]*|#[^\\r\\n]*)|(\\r\\n?|\\n)', 'gu')
const DEFINITION_BLOCKS = new Set(['platform', 'platform_type', 'mover', 'route', 'comm', 'sensor', 'processor', 'network', 'medium', 'execute'])

function safePart(part: string): boolean {
  return part.length > 0 && part !== '.' && part !== '..' && !/[\u0000-\u001f\u007f<>:"\\|?*]/u.test(part)
}

function relativeParts(path: string): string[] | null {
  if (path.length > 1024) return null
  const parts = path.split('/')
  return parts.every(safePart) ? parts : null
}

function readManifest(text: string): PackageManifest | null {
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/u, ''))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const { scenarioId, revision, entry, scriptFiles } = value as Partial<PackageManifest>
    if (typeof scenarioId !== 'string' || !scenarioId || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0
      || typeof entry !== 'string' || relativeParts(entry)?.length !== 1
      || !Array.isArray(scriptFiles) || !scriptFiles.length || scriptFiles.length > MAX_DECLARED_FILES
      || !scriptFiles.every(path => typeof path === 'string' && relativeParts(path) !== null && /\.txt$/iu.test(path))
      || new Set(scriptFiles.map(path => path.toLowerCase())).size !== scriptFiles.length
      || !scriptFiles.includes(entry)) return null
    return { scenarioId, revision, entry, scriptFiles }
  } catch { return null }
}

function inFolderReference(source: string, directive: string): string | null {
  const literal = /^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))$/u.exec(directive.trim())
  const target = (literal?.[1] ?? literal?.[2] ?? literal?.[3])?.replace(/\\/gu, '/')
  if (!target || /^[\/~]/u.test(target) || /[:$%<>{}\[\]*?]/u.test(target)) return null
  const parts = source.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else if (safePart(part)) parts.push(part)
    else return null
  }
  return parts.length ? parts.join('/') : null
}

type StructuralIssue = (line: number, message: string) => void

function uncomment(text: string, issue: StructuralIssue): string {
  let line = 1
  return text.replace(SCRIPT_COMMENTS, (token, comment: string | undefined, newline: string | undefined) => {
    if (newline) line += 1
    if (comment === undefined) return token
    if (comment.startsWith('/*') && (comment.length < 4 || !comment.endsWith('*/'))) issue(line, '块注释未闭合。')
    line += comment.split(LINE_BREAK).length - 1
    return comment.replace(/[^\r\n]/gu, ' ')
  })
}

function definitionOpener(line: string): string | null {
  const header = /^(?:(add|edit)\s+)?(\w+)(?:\s+(.*))?$/u.exec(line)
  if (!header || !DEFINITION_BLOCKS.has(header[2]!)) return null
  const [, action, block, args = ''] = header
  if (block === 'execute') return !action && (!args || /^at_(?:time|interval(?:_of)?)\b/u.test(args)) ? block : null
  if (!/^(?:[^\s=();{}]+(?:\s+[^\s=();{}]+)?)?$/u.test(args)) return null
  const count = args ? args.split(/\s+/u).length : 0
  if (block === 'route') return !action && count <= 1 ? block : null
  if (block === 'mover' || block === 'medium') return (action === 'edit' ? count <= 1 : count >= 1) ? block : null
  return count === (action === 'edit' ? 1 : 2) ? block! : null
}

function inspectStructure(lines: readonly string[], issue: StructuralIssue): number {
  const braces: number[] = []
  const blocks: { name: string; line: number }[] = []
  const blockPositions = new Map<string, number[]>()
  let closedBlocks = 0
  const popBlock = () => {
    const block = blocks.pop()!
    blockPositions.get(block.name)!.pop()
    return block
  }
  const unclosed = (block: { name: string; line: number }) => issue(block.line, '定义块 ' + block.name + ' 未闭合，缺少 end_' + block.name + '。')
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    const code = line.replace(SCRIPT_STRINGS, (_, closed: string | undefined) => {
      if (closed === undefined) issue(lineNumber, '字符串引号未闭合。')
      return '""'
    })
    const insideBraces = braces.length > 0
    for (const character of code.matchAll(/[{}]/gu)) {
      if (character[0] === '{') braces.push(lineNumber)
      else if (braces.pop() === undefined) issue(lineNumber, '右花括号缺少对应的左花括号。')
    }
    if (insideBraces) continue
    const command = code.trim()
    const closing = /^end_(\w+)$/u.exec(command)?.[1]
    if (closing && DEFINITION_BLOCKS.has(closing)) {
      const opener = blockPositions.get(closing)?.at(-1)
      if (opener === undefined) issue(lineNumber, '结束标记 end_' + closing + ' 缺少对应的定义块。')
      else {
        while (blocks.length - 1 > opener) unclosed(popBlock())
        popBlock()
        closedBlocks += 1
      }
    } else if (blocks.at(-1)?.name !== 'execute') {
      const name = definitionOpener(command)
      if (name) {
        const positions = blockPositions.get(name) ?? []
        positions.push(blocks.length)
        blockPositions.set(name, positions)
        blocks.push({ name, line: lineNumber })
      }
    }
  }
  for (const line of braces) issue(line, '左花括号未闭合。')
  for (const block of blocks) unclosed(block)
  return closedBlocks
}

export async function inspectScriptPackageFolder(
  files: readonly SelectedFile[],
): Promise<ScriptPackagePreflightResult> {
  const result: ScriptPackagePreflightResult = {
    folder: '', identity: null, entryState: 'unchecked', filesExpected: METADATA.length, filesPresent: 0,
    referencesChecked: 0, scriptFiles: [], errors: [], warnings: [],
  }
  if (!files.length || files.length > MAX_SELECTED_FILES) {
    result.errors.push('未选中文件夹，或选中的文件数量超出预检上限。')
    return result
  }
  const selected = new Map<string, SelectedFile>()
  const seen = new Set<string>()
  for (const file of files) {
    const parts = relativeParts(file.webkitRelativePath)
    if (!parts || parts.length < 2 || (result.folder && result.folder !== parts[0])) {
      result.errors.push('请选择单个脚本包根目录，文件路径须位于该目录内。')
      return result
    }
    result.folder = parts[0]!
    const relative = parts.slice(1).join('/')
    if (seen.has(relative.toLowerCase())) {
      result.errors.push('文件路径重复：' + relative)
      return result
    }
    seen.add(relative.toLowerCase())
    selected.set(relative, file)
  }

  let bytesRead = 0
  const read = async (path: string): Promise<string | undefined> => {
    const file = selected.get(path)
    if (!file) return undefined
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES || bytesRead + file.size > MAX_TOTAL_BYTES) {
      result.errors.push('文件超出预检读取上限：' + path)
      return undefined
    }
    bytesRead += file.size
    try { return await file.text() }
    catch { result.errors.push('文件无法读取：' + path); return undefined }
  }
  // 新版清单存在时按其报告错误，避免旧清单掩盖当前包的缺项。
  const metadata = !selected.has(METADATA[0]) && selected.has(LEGACY_METADATA[0]) ? LEGACY_METADATA : METADATA
  const manifestText = await read(metadata[0])
  const manifest = manifestText === undefined ? null : readManifest(manifestText)
  const required = manifest ? [...metadata, ...manifest.scriptFiles] : metadata
  result.filesExpected = required.length
  result.filesPresent = required.filter(path => selected.has(path)).length
  for (const path of required) {
    if (selected.has(path)) continue
    if (path === manifest?.entry) {
      const line = (manifestText?.split(LINE_BREAK).findIndex(text => /"entry"\s*:/u.test(text)) ?? -1) + 1
      result.errors.push(metadata[0] + ':' + (line || 1) + '：入口文件缺失：' + path)
    } else result.errors.push('缺少文件：' + path)
  }
  if (!manifest) {
    if (manifestText !== undefined) result.errors.push(metadata[0] + ':1：清单格式或声明路径无效。')
    return result
  }
  result.identity = { scenarioId: manifest.scenarioId, revision: manifest.revision, entry: manifest.entry }
  if (!selected.has(manifest.entry)) result.entryState = 'missing'
  result.scriptFiles = manifest.scriptFiles.map(path => ({
    path, state: selected.has(path) ? 'unchecked' : 'missing',
    references: 0, referenceErrors: 0, referenceWarnings: 0, closedBlocks: 0, structureErrors: 0,
  }))

  let directives = 0
  let structureErrors = 0
  const declared = new Set(manifest.scriptFiles)
  for (const file of result.scriptFiles) {
    if (file.state === 'missing') continue
    const { path } = file
    const text = await read(path)
    if (text === undefined) {
      file.state = 'unreadable'
      if (path === manifest.entry) result.entryState = 'unreadable'
      continue
    }
    const issue: StructuralIssue = (line, message) => {
      file.structureErrors += 1
      if (structureErrors < MAX_STRUCTURE_ERRORS) result.errors.push(path + ':' + line + '：' + message)
      if (structureErrors++ === MAX_STRUCTURE_ERRORS) result.errors.push('结构问题较多，已列出前 ' + MAX_STRUCTURE_ERRORS + ' 条。')
    }
    const lines = uncomment(text, issue).split(LINE_BREAK)
    if (path === manifest.entry) {
      result.entryState = lines.some(line => line.trim()) ? 'present' : 'empty'
      if (result.entryState === 'empty') result.errors.push(path + ':1：入口文件为空或只有注释。')
    }
    file.closedBlocks = inspectStructure(lines, issue)
    for (let index = 0; index < lines.length; index += 1) {
      const directive = /^\s*include(?:_once)?(?:[ \t]+(.*)|\s*)$/u.exec(lines[index]!)
      if (!directive) continue
      if (++directives > MAX_DIRECTIVES) {
        result.errors.push('引用数量超出预检上限。')
        return result
      }
      file.references += 1
      const location = path + ':' + (index + 1) + '：'
      const target = directive[1]?.trim()
      if (!target || target === '""' || target === "''") {
        file.referenceErrors += 1
        result.errors.push(location + '包含引用缺少文件路径。')
        continue
      }
      const reference = inFolderReference(path, target)
      if (reference === null) {
        file.referenceWarnings += 1
        result.warnings.push(location + '外部或动态引用未核验。')
      } else {
        result.referencesChecked += 1
        if (!selected.has(reference)) {
          file.referenceErrors += 1
          result.errors.push(location + '包内引用缺少文件：' + reference)
        } else if (!declared.has(reference)) {
          file.referenceWarnings += 1
          result.warnings.push(location + '引用文件未列入清单，内容未核验：' + reference)
        }
      }
    }
    file.state = 'checked'
  }
  return result
}

/**
 * 从已通过结构预检的本地文件夹提取待送审本机 AFSIM 引擎的 TXT 与清单快照。
 * 仅在用户主动点击「执行引擎加载检查」时调用，不影响静态预检耗时。
 */
export async function extractScriptPackageEngineCheckRequest(
  files: readonly SelectedFile[],
  preflight: ScriptPackagePreflightResult,
): Promise<ScriptPackageEngineLoadCheckRequest> {
  if (!preflight.folder || !preflight.identity || preflight.entryState !== 'present') {
    throw new Error('所选脚本包缺少有效入口或清单，请先修复结构预检错误后再执行引擎加载检查。')
  }
  const selected = new Map<string, SelectedFile>()
  for (const file of files) {
    const parts = relativeParts(file.webkitRelativePath)
    if (!parts || parts.length < 2 || parts[0] !== preflight.folder) continue
    selected.set(parts.slice(1).join('/'), file)
  }
  const scriptTexts: Record<string, string> = {}
  let totalBytes = 0
  const readSafe = async (path: string): Promise<string | undefined> => {
    const file = selected.get(path)
    if (!file) return undefined
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES || totalBytes + file.size > MAX_TOTAL_BYTES) {
      throw new Error(`文件超出引擎加载检查读取上限：${path}`)
    }
    totalBytes += file.size
    return file.text()
  }
  for (const item of preflight.scriptFiles) {
    if (item.state !== 'checked' || !isSafeScriptFilename(item.path)) continue
    const text = await readSafe(item.path)
    if (text !== undefined) scriptTexts[item.path] = text
  }
  if (!Object.hasOwn(scriptTexts, preflight.identity.entry)) {
    throw new Error(`脚本包缺少可读取的入口文件：${preflight.identity.entry}`)
  }
  const mappingJson = await readSafe(METADATA[0]) ?? await readSafe(LEGACY_METADATA[0])
  const inputJson = await readSafe(METADATA[1]) ?? await readSafe(LEGACY_METADATA[1])
  return {
    folder: preflight.folder,
    entry: preflight.identity.entry,
    scenarioId: preflight.identity.scenarioId,
    revision: preflight.identity.revision,
    files: scriptTexts,
    ...(mappingJson === undefined ? {} : { mappingJson }),
    ...(inputJson === undefined ? {} : { inputJson }),
  }
}

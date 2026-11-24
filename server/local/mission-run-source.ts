import { engineNameMap } from './engine-name-mapping.js'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export interface RunMapping {
  scenarioId: string
  revision: number
  output: { resolvedDirectory: string }
  platforms: Array<{ platformId: string; name: string }>
  devices?: unknown
}

export interface RunOutputSource {
  runId: string
  scenarioId: string
  revision: number
  entryPath: string
  mapping?: RunMapping
}

export type ResolvedRunOutputFile =
  | { status: 'STALE' }
  | { status: 'MISSING'; mapping: RunMapping }
  | { status: 'READY'; mapping: RunMapping; filePath: string }

export function isInsidePath(root: string, target: string): boolean {
  const path = relative(root, target)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
}

export function parseRunMapping(value: unknown, scenarioId: string, revision: number): RunMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本次仿真映射文件无效。')
  const mapping = value as Partial<RunMapping>
  if (mapping.scenarioId !== scenarioId || mapping.revision !== revision
    || !mapping.output || typeof mapping.output.resolvedDirectory !== 'string'
    || !Array.isArray(mapping.platforms)
    || !mapping.platforms.every(platform => platform && typeof platform.platformId === 'string' && platform.platformId.length > 0
      && typeof platform.name === 'string' && platform.name.length > 0)) throw new Error('本次仿真映射文件与场景版本不一致。')
  engineNameMap(value)
  const output = mapping.output.resolvedDirectory
  if (output.length === 0 || isAbsolute(output) || output.split(/[\\/]/).some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('本次仿真输出目录无效。')
  }
  return mapping as RunMapping
}

/**
 * 校验本次运行入口文件、mapping.json 及输出目录边界，再解析具体的输出文件真实路径。
 * 对符号链接与目录越界严格拒绝，且报错信息不泄露本机文件路径。
 */
export async function resolveRunOutputFile(
  source: RunOutputSource,
  fileName: string,
  isCurrent: () => boolean,
  fileLabel = '位置文件',
): Promise<ResolvedRunOutputFile> {
  let root: string
  try {
    const entry = await lstat(source.entryPath)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('本次仿真入口文件不可用。')
    root = dirname(await realpath(source.entryPath))
  } catch (error) {
    if (!isCurrent()) return { status: 'STALE' }
    throw error
  }
  if (!isCurrent()) return { status: 'STALE' }

  let mapping: RunMapping
  try {
    mapping = source.mapping ??= parseRunMapping(
      JSON.parse(await readFile(join(root, 'mapping.json'), 'utf8')),
      source.scenarioId,
      source.revision,
    )
  } catch (error) {
    if (!isCurrent()) return { status: 'STALE' }
    throw error
  }
  if (!isCurrent()) return { status: 'STALE' }

  const outputPath = resolve(root, mapping.output.resolvedDirectory)
  if (!isInsidePath(root, outputPath)) throw new Error('本次仿真输出目录越界。')
  let outputRoot: string
  try {
    const outputStat = await lstat(outputPath)
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error('本次仿真输出目录不可用。')
    outputRoot = await realpath(outputPath)
  } catch (error) {
    if (!isCurrent()) return { status: 'STALE' }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'MISSING', mapping }
    throw error
  }
  if (!isCurrent()) return { status: 'STALE' }
  if (!isInsidePath(root, outputRoot)) throw new Error('本次仿真输出目录越界。')

  const candidate = join(outputRoot, fileName)
  let filePath: string
  try {
    const fileStat = await lstat(candidate)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`本次仿真${fileLabel}不可用。`)
    filePath = await realpath(candidate)
  } catch (error) {
    if (!isCurrent()) return { status: 'STALE' }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'MISSING', mapping }
    throw error
  }
  if (!isCurrent()) return { status: 'STALE' }
  if (!isInsidePath(outputRoot, filePath)) throw new Error(`本次仿真${fileLabel}越界。`)
  return { status: 'READY', mapping, filePath }
}

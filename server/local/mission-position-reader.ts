import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ScenarioDraft } from '../../src/contracts/domain-models.js'
import type { PositionSnapshot } from '../../src/features/situation/position-updates.js'
import type { MissionPositionSnapshot } from '../../src/features/situation/mission-positions.js'
import { createPositionReader } from './afsim-position-reader.js'

type Mapping = {
  scenarioId: string
  revision: number
  output: { resolvedDirectory: string }
  platforms: Array<{ platformId: string; name: string }>
}

type RunSource = {
  runId: string
  scenarioId: string
  revision: number
  entryPath: string
  reader?: () => Promise<PositionSnapshot>
  positionPath?: string
  mapping?: Mapping
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
}

function readMapping(value: unknown, scenarioId: string, revision: number): Mapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本次仿真映射文件无效。')
  const mapping = value as Partial<Mapping>
  if (mapping.scenarioId !== scenarioId || mapping.revision !== revision
    || !mapping.output || typeof mapping.output.resolvedDirectory !== 'string'
    || !Array.isArray(mapping.platforms)
    || !mapping.platforms.every(platform => platform && typeof platform.platformId === 'string' && platform.platformId.length > 0
      && typeof platform.name === 'string' && platform.name.length > 0)) throw new Error('本次仿真映射文件与场景版本不一致。')
  const output = mapping.output.resolvedDirectory
  if (output.length === 0 || isAbsolute(output) || output.split(/[\\/]/).some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('本次仿真输出目录无效。')
  }
  return mapping as Mapping
}

/** 运行目录由 mission 启动器登记；浏览器只能通过运行编号读取其位置 CSV。 */
export class MissionPositionReader {
  private readonly sources = new Map<string, RunSource>()

  attach(runId: string, draft: ScenarioDraft, entryPath: string): void {
    // 单实例仿真投影只暴露当前或最后一次运行，旧绑定不再保留以免长期积累。
    this.sources.clear()
    this.sources.set(runId, { runId, scenarioId: draft.config.scenario.id, revision: draft.revision, entryPath: resolve(entryPath) })
  }

  has(runId: string): boolean { return this.sources.has(runId) }

  async read(runId: string): Promise<MissionPositionSnapshot | null> {
    const source = this.sources.get(runId)
    if (!source) return null
    let root: string
    try { root = await this.resolveRoot(source) }
    catch (error) {
      if (!this.isCurrent(source)) return null
      throw error
    }
    if (!this.isCurrent(source)) return null
    let mapping: Mapping
    try {
      mapping = source.mapping ??= readMapping(JSON.parse(await readFile(join(root, 'mapping.json'), 'utf8')), source.scenarioId, source.revision)
    } catch (error) {
      if (!this.isCurrent(source)) return null
      throw error
    }
    if (!this.isCurrent(source)) return null
    const outputPath = resolve(root, mapping.output.resolvedDirectory)
    if (!isInside(root, outputPath)) throw new Error('本次仿真输出目录越界。')
    let outputRoot: string
    try {
      const stat = await lstat(outputPath)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('本次仿真输出目录不可用。')
      outputRoot = await realpath(outputPath)
    } catch (error) {
      if (!this.isCurrent(source)) return null
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.snapshot(source, null)
      throw error
    }
    if (!this.isCurrent(source)) return null
    if (!isInside(root, outputRoot)) throw new Error('本次仿真输出目录越界。')
    const candidate = join(outputRoot, 'position.csv')
    let positionPath: string
    try {
      const stat = await lstat(candidate)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('本次仿真位置文件不可用。')
      positionPath = await realpath(candidate)
    } catch (error) {
      if (!this.isCurrent(source)) return null
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.snapshot(source, null)
      throw error
    }
    if (!this.isCurrent(source)) return null
    if (!isInside(outputRoot, positionPath)) throw new Error('本次仿真位置文件越界。')
    if (source.positionPath !== positionPath || !source.reader) {
      source.positionPath = positionPath
      source.reader = createPositionReader(positionPath)
    }
    const positions = await source.reader()
    if (!this.isCurrent(source)) return null
    if (positions.recordCount === 0) return this.snapshot(source, null)
    const platformIds = new Set(mapping.platforms.map(platform => platform.platformId))
    const nameCounts = new Map<string, number>()
    for (const platform of mapping.platforms) {
      nameCounts.set(platform.name, (nameCounts.get(platform.name) ?? 0) + 1)
    }
    const aliases = new Map(mapping.platforms
      .filter(platform => !platformIds.has(platform.name) && nameCounts.get(platform.name) === 1)
      .map(platform => [platform.name, platform.platformId]))
    return this.snapshot(source, { ...positions, nodes: positions.nodes.flatMap(position => {
      const platformId = platformIds.has(position.platformId) ? position.platformId : aliases.get(position.platformId)
      return platformId ? [{ ...position, platformId }] : []
    }) })
  }

  private async resolveRoot(source: RunSource): Promise<string> {
    const entry = await lstat(source.entryPath)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('本次仿真入口文件不可用。')
    const entryPath = await realpath(source.entryPath)
    return dirname(entryPath)
  }

  private isCurrent(source: RunSource): boolean {
    return this.sources.get(source.runId) === source
  }

  private snapshot(source: RunSource, positions: PositionSnapshot | null): MissionPositionSnapshot {
    return { runId: source.runId, scenarioId: source.scenarioId, revision: source.revision, positions }
  }
}

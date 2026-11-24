import { engineNameMap, toScenarioId } from './engine-name-mapping.js'
import { resolve } from 'node:path'
import type { ScenarioDraft } from '../../src/contracts/domain-models.js'
import type { PositionSnapshot } from '../../src/features/situation/position-updates.js'
import type { MissionPositionSnapshot } from '../../src/features/situation/mission-positions.js'
import { createPositionReader } from './afsim-position-reader.js'
import { resolveRunOutputFile, type RunOutputSource } from './mission-run-source.js'

type RunSource = RunOutputSource & {
  reader?: () => Promise<PositionSnapshot>
  positionPath?: string
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
    const resolved = await resolveRunOutputFile(source, 'position.csv', () => this.isCurrent(source), '位置文件')
    if (resolved.status === 'STALE') return null
    if (resolved.status === 'MISSING') return this.snapshot(source, null)
    const { mapping, filePath: positionPath } = resolved
    if (source.positionPath !== positionPath || !source.reader) {
      source.positionPath = positionPath
      source.reader = createPositionReader(positionPath)
    }
    const positions = await source.reader()
    if (!this.isCurrent(source)) return null
    if (positions.recordCount === 0) return this.snapshot(source, null)
    const platformIds = new Set(mapping.platforms.map(platform => platform.platformId))
    const names = engineNameMap(mapping)
    return this.snapshot(source, { ...positions, nodes: positions.nodes.flatMap(position => {
      // CSV NAME 是引擎实例名；即使与另一场景原编号重名，也优先按名称映射。
      const platformId = toScenarioId(names, position.platformId)
      return platformIds.has(platformId) ? [{ ...position, platformId }] : []
    }) })
  }

  private isCurrent(source: RunSource): boolean {
    return this.sources.get(source.runId) === source
  }

  private snapshot(source: RunSource, positions: PositionSnapshot | null): MissionPositionSnapshot {
    return { runId: source.runId, scenarioId: source.scenarioId, revision: source.revision, positions }
  }
}

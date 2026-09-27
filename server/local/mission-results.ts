import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, lstat, realpath, rename, unlink } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import type { ScenarioDraft } from '../../src/contracts/domain-models.js'
import { isMissionResultId, isMissionResultSnapshot, type MissionResultRecord, type MissionResultSnapshot } from '../../src/features/results/mission-result.js'
import { readLocalReplay } from './afsim-replay-reader.js'
import { readLocalReport } from './report-file.js'

export interface MissionResults {
  list(): Promise<MissionResultRecord[]>
  get(id: string): Promise<MissionResultSnapshot | null>
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex')

/** 完成后的快照原子发布，与可变的配置文件路径隔离。目录可随部署包迁移。 */
export class LocalMissionResults implements MissionResults {
  private readonly directory: string
  constructor(directory: string) { this.directory = resolve(directory) }

  async capture(entryDirectory: string, draft: ScenarioDraft, startedAt: string, completedAt: string, canPublish: () => boolean = () => true): Promise<void> {
    const manifest = JSON.parse(await readFile(join(entryDirectory, 'mapping.json'), 'utf8'))
    if (manifest.scenarioId !== draft.config.scenario.id || manifest.revision !== draft.revision
      || typeof manifest.output?.resolvedDirectory !== 'string') throw new Error('生成包与执行场景版本不一致。')
    const root = await realpath(entryDirectory)
    const output = await realpath(resolve(root, manifest.output.resolvedDirectory))
    const within = relative(root, output)
    if (isAbsolute(within) || within === '..' || within.startsWith('..\\') || within.startsWith('../')) throw new Error('结果目录超出本次执行目录。')
    const eventPath = join(output, 'scenario_events.csv')
    const positionPath = join(output, 'position.csv')
    for (const path of [eventPath, positionPath]) {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('结果文件不是普通文件。')
    }
    const [replay, report] = await Promise.all([readLocalReplay(eventPath, positionPath), readLocalReport(eventPath, positionPath)])
    const record: MissionResultRecord = {
      resultId: `RESULT-${randomUUID()}`, scenarioId: draft.config.scenario.id,
      scenarioName: draft.config.scenario.name, revision: draft.revision, startedAt, completedAt,
    }
    const snapshot = { record, replay, report }
    if (!isMissionResultSnapshot(snapshot)) throw new Error('结果未完整结束，或回放与报告的来源不一致。')
    if (!canPublish()) return
    const payload = JSON.stringify(snapshot)
    await mkdir(this.directory, { recursive: true })
    const pending = join(this.directory, `${record.resultId}.pending`)
    await writeFile(pending, JSON.stringify({ sha256: hash(payload), payload }), { flag: 'wx' })
    if (!canPublish()) { await unlink(pending); return }
    // 只有快照写入完成后才出现在目录中；不会暴露半份报告。
    await rename(pending, join(this.directory, `${record.resultId}.json`))
  }

  async get(id: string): Promise<MissionResultSnapshot | null> {
    if (!isMissionResultId(id)) return null
    const path = join(this.directory, `${id}.json`)
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('结果快照必须为普通文件。')
      const stored = JSON.parse(await readFile(path, 'utf8'))
      if (typeof stored.payload !== 'string' || hash(stored.payload) !== stored.sha256) throw new Error('结果快照完整性校验失败。')
      const snapshot: unknown = JSON.parse(stored.payload)
      if (!isMissionResultSnapshot(snapshot) || snapshot.record.resultId !== id) throw new Error('结果快照关联校验失败。')
      return snapshot
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async list(): Promise<MissionResultRecord[]> {
    let names: string[]
    try { names = await readdir(this.directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: MissionResultRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || !isMissionResultId(name.slice(0, -5))) continue
      const snapshot = await this.get(name.slice(0, -5))
      if (snapshot) records.push(snapshot.record)
    }
    return records.sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.resultId.localeCompare(a.resultId))
  }
}

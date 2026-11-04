import { engineNameMap, toScenarioDevices } from './engine-name-mapping.js'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, lstat, realpath, rename, unlink } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { EVENTS_CSV_HEADER, type ScenarioDraft } from '../../src/contracts/domain-models.js'
import { isMissionResultId, isMissionResultSnapshot, snapshotMissionResultParameters, type MissionResultRecord, type MissionResultSnapshot } from '../../src/features/results/mission-result.js'
import { readLocalReplay } from './afsim-replay-reader.js'
import { readLocalReport } from './report-file.js'
import { readAfsimLogFile, readStableUtf8Lines, resolveManifestConnections } from './afsim-log-reader.js'
import { writeTimeSeries, type TimeSeriesContext } from './time-series.js'
import { parseCsvLine } from '../../src/features/data-exchange/csv-contract.js'
import { filterMissionReport, publishReportFilterIndex } from './report-filter.js'
import type { LocalReportFilter, LocalReportFilterResult } from '../../src/contracts/domain-models.js'

export interface MissionResults {
  list(): Promise<MissionResultRecord[]>
  get(id: string): Promise<MissionResultSnapshot | null>
  filter?(id: string, reportId: string, filter: LocalReportFilter): Promise<LocalReportFilterResult>
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const CANONICAL_ARCHIVE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024

/** 大型事件日志仅接受 runner 传入的、已完成且逐项可核验的连续归档。 */
async function validateContinuousEventArchive(
  archiveDirectory: string, context: TimeSeriesContext, eventSource: { bytes: number; sha256: string }, expectedRows: number,
): Promise<void> {
  const initial = await lstat(archiveDirectory)
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error('连续时序归档目录必须为普通目录。')
  const root = await realpath(archiveDirectory)
  const manifestPath = join(root, 'manifest.json')
  const manifestStat = await lstat(manifestPath)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('连续时序归档清单必须为普通文件。')
  let manifest: unknown
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) }
  catch { throw new Error('连续时序归档清单不是有效 JSON。') }
  if (!isObject(manifest) || manifest.schemaVersion !== '1.1' || manifest.mode !== 'CONTINUOUS'
    || manifest.status !== 'COMPLETED' || manifest.completed !== true
    || manifest.taskId !== context.taskId || manifest.runId !== context.runId || !Array.isArray(manifest.files)) {
    throw new Error('连续时序归档清单与本次已完成任务不一致。')
  }
  const events = manifest.files.find(file => isObject(file) && file.fileName === 'events.csv')
  if (!isObject(events) || events.version !== '1.1' || events.encoding !== 'UTF-8'
    || events.sourceFile !== 'scenario_events.csv' || events.sourceBytes !== eventSource.bytes
    || events.sourceSha256 !== eventSource.sha256 || events.rowCount !== expectedRows
    || typeof events.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(events.sha256)) {
    throw new Error('连续时序 events.csv 的来源摘要或行数未通过核验。')
  }
  const eventsPath = join(root, 'events.csv')
  const eventsStat = await lstat(eventsPath)
  if (!eventsStat.isFile() || eventsStat.isSymbolicLink()) throw new Error('连续时序 events.csv 必须为普通文件。')
  let rows = 0
  let headerSeen = false
  const canonical = await readStableUtf8Lines(eventsPath, line => {
    if (!headerSeen) {
      headerSeen = true
      if (line !== EVENTS_CSV_HEADER) throw new Error('连续时序 events.csv 表头不符合规范。')
      return
    }
    const fields = parseCsvLine(line)
    if (!fields || fields.length !== EVENTS_CSV_HEADER.split(',').length || fields[0] !== context.taskId) {
      throw new Error('连续时序 events.csv 含无效记录或其他任务数据。')
    }
    rows += 1
  }, CANONICAL_ARCHIVE_LIMIT_BYTES)
  if (!headerSeen || canonical.waitingForLine || rows !== expectedRows || canonical.source.sha256 !== events.sha256) {
    throw new Error('连续时序 events.csv 实际行数与完整来源不一致。')
  }
}

/** 完成后的快照原子发布，与可变的配置文件路径隔离。目录可随部署包迁移。 */
export class LocalMissionResults implements MissionResults {
  private readonly directory: string
  constructor(directory: string) { this.directory = resolve(directory) }

  async capture(entryDirectory: string, draft: ScenarioDraft, startedAt: string, completedAt: string, canPublish: () => boolean = () => true, context?: TimeSeriesContext, continuousArchiveDirectory?: string): Promise<void> {
    const manifest = JSON.parse(await readFile(join(entryDirectory, 'mapping.json'), 'utf8'))
    if (manifest.scenarioId !== draft.config.scenario.id || manifest.revision !== draft.revision
      || typeof manifest.output?.resolvedDirectory !== 'string') throw new Error('生成包与执行场景版本不一致。')
    const names = engineNameMap(manifest)
    const displayNames = names ? new Map(draft.config.platforms.map(platform => [platform.id, platform.name])) : undefined
    const devices = toScenarioDevices(names, manifest.devices)
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
    const [replay, report, log] = await Promise.all([readLocalReplay(eventPath, positionPath, true, names, displayNames), readLocalReport(eventPath, positionPath, names, displayNames), readAfsimLogFile(eventPath, names)])
    // 归档的通用射频编号保持原样；只有 manifest 端点对精确匹配时才补充显示类型。
    const mappedConnections = resolveManifestConnections(log, devices)
    const mappedReplay = { ...replay, initial: { ...replay.initial, connections: mappedConnections },
      durationS: Math.max(replay.durationS, ...mappedConnections.map(connection => connection.time)) }
    const record: MissionResultRecord = {
      resultId: `RESULT-${randomUUID()}`, scenarioId: draft.config.scenario.id,
      scenarioName: draft.config.scenario.name, revision: draft.revision, startedAt, completedAt,
      ...(context === undefined ? {} : { runId: context.runId, taskId: context.taskId }),
    }
    // 只冻结 capture 时已保存草稿的可比输入；不得从输出 CSV 推断功率、频段或质量结果。
    const snapshot = { record, replay: mappedReplay, report, parameters: snapshotMissionResultParameters(draft) }
    if (!isMissionResultSnapshot(snapshot)) throw new Error('结果未完整结束，或回放与报告的来源不一致。')
    if (!canPublish()) return
    if (log.source.sha256 !== snapshot.report.localEvidence?.eventFile.sha256) throw new Error('筛选索引前事件来源已变化。')
    if (context) {
      if ('messageDetailsComplete' in log && log.messageDetailsComplete === false) {
        if (!continuousArchiveDirectory) throw new Error('大型事件来源缺少经核验的连续时序归档，拒绝发布不完整 CSV 快照。')
        await validateContinuousEventArchive(continuousArchiveDirectory, context, log.source, log.summary.eventCount)
      } else {
        await writeTimeSeries(output, context, log, log.source.sha256, names)
      }
    }
    if (!canPublish()) return
    // Index is published before the result snapshot. A read can therefore never mistake a partial index for a filterable result.
    await mkdir(this.directory, { recursive: true })
    await publishReportFilterIndex(this.directory, record, snapshot.report, snapshot.replay, log, {
      devices,
      ...(('messageDetailsComplete' in log && log.messageDetailsComplete === false && continuousArchiveDirectory)
        ? { canonicalEventsPath: join(continuousArchiveDirectory, 'events.csv') } : {}),
    })
    if (!canPublish()) return
    const payload = JSON.stringify(snapshot)
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

  async filter(id: string, reportId: string, filter: LocalReportFilter): Promise<LocalReportFilterResult> {
    const snapshot = await this.get(id)
    if (!snapshot || snapshot.report.reportId !== reportId) throw new Error('FILTER_NOT_FOUND')
    return filterMissionReport(this.directory, snapshot, filter)
  }
}

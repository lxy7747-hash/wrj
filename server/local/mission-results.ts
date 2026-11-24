import { engineNameMap, toScenarioDevices } from './engine-name-mapping.js'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, lstat, realpath, rename, unlink } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { EVENTS_CSV_HEADER, type Report, type ScenarioDraft, type SimulationRun } from '../../src/contracts/domain-models.js'
import { fileReceptionMapping } from '../../src/features/situation/file-reception.js'
import { isMissionResultId, isMissionResultRecord, isMissionResultSnapshot, normalizeMissionResultSnapshot, snapshotMissionResultParameters, type MissionResultParameters, type MissionResultRecord, type MissionResultSnapshot } from '../../src/features/results/mission-result.js'
import { readLocalReplay } from './afsim-replay-reader.js'
import { readLocalReport } from './report-file.js'
import { readAfsimLogFile, readStableUtf8Lines, resolveManifestConnections } from './afsim-log-reader.js'
import { writeTimeSeries, type TimeSeriesContext } from './time-series.js'
import { parseCsvLine } from '../../src/features/data-exchange/csv-contract.js'
import type { EquipmentPublishedReference } from '../../src/features/admin/equipment-history-contract.js'
import { filterMissionReport, publishReportFilterIndex } from './report-filter.js'
import { isLocalReport, parseLocalReportFilter } from '../../src/features/reports/local-report.js'
import type { LocalReportFilter, LocalReportFilterResult } from '../../src/contracts/domain-models.js'

export interface MissionResults {
  list(): Promise<MissionResultRecord[]>
  get(id: string): Promise<MissionResultSnapshot | null>
  filter?(id: string, reportId: string, filter: LocalReportFilter): Promise<LocalReportFilterResult>
  /** 报告视图：读取轻量快照（不含回放轨迹），避免为了看报告加载整份回放。 */
  getReportView?(id: string): Promise<MissionResultReportView | null>
}

/** 报告视图快照：包含渲染报告所需的最小数据（record/report/parameters/初始空筛选）。 */
export interface MissionResultReportView {
  record: MissionResultRecord
  report: Report
  parameters?: MissionResultParameters
  initialFilter?: Omit<LocalReportFilterResult, 'report'>
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const CANONICAL_ARCHIVE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
const MAX_CACHED_SNAPSHOTS = 4

function lruSet<K, V>(cache: Map<K, V>, key: K, value: V, limit = MAX_CACHED_SNAPSHOTS): void {
  if (cache.has(key)) cache.delete(key)
  else if (cache.size >= limit) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

async function regularFileSig(path: string, errorMessage: string): Promise<string> {
  const info = await lstat(path, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(errorMessage)
  return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.birthtimeNs}`
}

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
  private readonly recordCache = new Map<string, { sig: string; record: MissionResultRecord }>()
  private readonly snapshotCache = new Map<string, { sig: string; snapshot: MissionResultSnapshot }>()
  private readonly emptyFilterCache = new Map<string, { sig: string; manifestSig: string; indexSig: string; reportId: string; result: LocalReportFilterResult }>()
  constructor(directory: string, private readonly onPublished?: (draft: ScenarioDraft, record: MissionResultRecord) => EquipmentPublishedReference[] | void,
    private readonly onDiscarded?: (references: EquipmentPublishedReference[]) => void) { this.directory = resolve(directory) }

  /** 文件与 WS 并行接收结束后发布结果；文件统计仍属于所播放的源文件。 */
  async captureFileReception(eventPath: string, positionPath: string, run: Pick<SimulationRun, 'fileSource' | 'startedAt' | 'scenarioId' | 'runId' | 'taskId'>, completedAt: string, lastFrameTime: number, parameters?: MissionResultParameters): Promise<void> {
    if (!run.fileSource || !run.startedAt) throw new Error('文件接收运行缺少来源或开始时刻。')
    const frozenParameters = parameters === undefined ? undefined : structuredClone(parameters)
    const [replay, report, log] = await Promise.all([
      readLocalReplay(eventPath, positionPath), readLocalReport(eventPath, positionPath), readAfsimLogFile(eventPath),
    ])
    if (!report?.localEvidence || replay.initial.sha256 !== run.fileSource.eventSha256 || replay.sha256 !== run.fileSource.positionSha256
      || log.source.sha256 !== run.fileSource.eventSha256) throw new Error('播放文件已变化，不能将其他来源保存为本次运行结果。')
    // 引擎可能运行得比文件轨迹更久，报告范围不能截掉已接收的帧。
    report.localEvidence.endTimeS = Math.max(report.localEvidence.endTimeS, lastFrameTime)
    const record: MissionResultRecord = {
      resultId: `RESULT-${randomUUID()}`, scenarioId: run.scenarioId, scenarioName: `文件与 WebSocket · ${replay.initial.fileName}`,
      revision: 1, startedAt: run.startedAt, completedAt, runId: run.runId, taskId: run.taskId, executionSource: 'REMOTE_WS',
    }
    const snapshot = { record, replay, report, ...(frozenParameters === undefined ? {} : { parameters: frozenParameters }) }
    if (!isMissionResultSnapshot(snapshot)) throw new Error('播放文件快照或报告来源不一致，无法发布接收结果。')
    await mkdir(this.directory, { recursive: true })
    await publishReportFilterIndex(this.directory, record, report, replay, log, { devices: fileReceptionMapping(replay.initial).manifest.devices })
    const payload = JSON.stringify(snapshot), pending = join(this.directory, `${record.resultId}.pending`)
    await writeFile(pending, JSON.stringify({ sha256: hash(payload), payload }), { flag: 'wx' })
    await rename(pending, join(this.directory, `${record.resultId}.json`))
    try { await this.writeRecordIndex(record) } catch { /* 索引写入失败时列表回退读取快照 */ }
    try { await this.writeReportView(await this.buildReportView(snapshot)) } catch { /* 报告视图写入失败时打开时回退完整快照 */ }
  }

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
    // 归档发布时冻结装备参数来源；登记失败则不发布本次结果（与发布目标一致）。
    let inserted: EquipmentPublishedReference[] | void
    try { inserted = this.onPublished?.(draft, record) } catch (error) { await unlink(pending); throw error }
    // 只有快照写入完成后才出现在目录中；不会暴露半份报告。
    try { await rename(pending, join(this.directory, `${record.resultId}.json`)) } catch (error) {
      // 提交失败只撤销本次登记并丢弃待发布文件，不删除已重命名的不可变结果。
      if (inserted) this.onDiscarded?.(inserted)
      await unlink(pending)
      throw error
    }
    try { await this.writeRecordIndex(record) } catch { /* 索引写入失败时列表回退读取快照 */ }
    try { await this.writeReportView(await this.buildReportView(snapshot)) } catch { /* 报告视图写入失败时打开时回退完整快照 */ }
  }

  /** 报告视图：优先读轻量快照；缺失时从完整快照构建并回填，打开报告不再加载回放轨迹。 */
  async getReportView(id: string): Promise<MissionResultReportView | null> {
    const indexed = await this.readReportView(id)
    if (indexed) return indexed.view
    const snapshot = await this.get(id, false)
    if (!snapshot) return null
    // 一次完整快照读取同时回填记录索引和报告视图，避免后续再读大快照。
    try { await this.writeRecordIndex(snapshot.record) } catch { /* 回填失败时列表仍回退读取快照 */ }
    const view = await this.buildReportView(snapshot)
    try { await this.writeReportView(view) } catch { /* 回填失败时下次仍回退完整快照 */ }
    return view
  }

  private reportViewPath(id: string): string {
    return join(this.directory, `${id}.report-view.json`)
  }

  private async buildReportView(snapshot: MissionResultSnapshot): Promise<MissionResultReportView> {
    const view: MissionResultReportView = {
      record: snapshot.record, report: snapshot.report,
      ...(snapshot.parameters === undefined ? {} : { parameters: snapshot.parameters }),
    }
    try {
      const initial = await filterMissionReport(this.directory, snapshot, {})
      view.report = initial.report
      view.initialFilter = { filter: initial.filter, timeline: initial.timeline, timelineTotal: initial.timelineTotal, stages: initial.stages, links: initial.links }
    } catch { /* 旧结果缺少筛选索引时保留原始报告，后续 /filter 明确提示 */ }
    return view
  }

  private async writeReportView(view: MissionResultReportView): Promise<void> {
    const pending = join(this.directory, `${view.record.resultId}.report-view.pending`)
    try {
      await writeFile(pending, JSON.stringify(view), { flag: 'wx' })
      await rename(pending, this.reportViewPath(view.record.resultId))
    } catch (error) {
      try { await unlink(pending) } catch { /* ignore */ }
      throw error
    }
  }

  private async readReportView(id: string): Promise<{ sig: string; view: MissionResultReportView } | null> {
    if (!isMissionResultId(id)) return null
    const filePath = this.reportViewPath(id)
    let sig: string
    try {
      sig = await regularFileSig(filePath, '结果报告视图必须为普通文件。')
    } catch {
      return null
    }
    try {
      const view = JSON.parse(await readFile(filePath, 'utf8')) as MissionResultReportView
      if (isMissionResultRecord(view?.record) && view.record.resultId === id && isLocalReport(view.report)) return { sig, view }
    } catch { /* fall through */ }
    return null
  }

  async get(id: string, cacheSnapshot = true): Promise<MissionResultSnapshot | null> {
    if (!isMissionResultId(id)) return null
    const path = join(this.directory, `${id}.json`)
    try {
      const sig = await regularFileSig(path, '结果快照必须为普通文件。')
      const cached = this.snapshotCache.get(id)
      if (cached?.sig === sig) {
        if (cacheSnapshot) lruSet(this.snapshotCache, id, cached)
        return cached.snapshot
      }
      const stored = JSON.parse(await readFile(path, 'utf8'))
      if (typeof stored.payload !== 'string' || hash(stored.payload) !== stored.sha256) throw new Error('结果快照完整性校验失败。')
      // 历史快照可能缺少新版消息类型的方向字段；读取时补出可判定方向后再按严格规则校验。
      const snapshot = normalizeMissionResultSnapshot(JSON.parse(stored.payload))
      if (!isMissionResultSnapshot(snapshot) || snapshot.record.resultId !== id) throw new Error('结果快照关联校验失败。')
      this.recordCache.set(id, { sig, record: snapshot.record })
      if (cacheSnapshot) lruSet(this.snapshotCache, id, { sig, snapshot })
      return snapshot
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.recordCache.delete(id)
        this.snapshotCache.delete(id)
        this.emptyFilterCache.delete(id)
        return null
      }
      throw error
    }
  }

  async list(): Promise<MissionResultRecord[]> {
    let names: string[]
    try { names = await readdir(this.directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const ids = names
      .filter(name => name.endsWith('.json') && isMissionResultId(name.slice(0, -5)))
      .map(name => name.slice(0, -5))
    const activeIds = new Set(ids)
    const records: MissionResultRecord[] = []
    const missing: string[] = []
    const concurrency = 8
    let cursor = 0
    const readOne = async (id: string): Promise<void> => {
      const indexed = await this.readRecordIndex(id)
      if (indexed) {
        const cached = this.recordCache.get(id)
        if (!cached || cached.sig !== indexed.sig) this.recordCache.set(id, { sig: indexed.sig, record: indexed.record })
        records.push(indexed.record)
        return
      }
      const cached = this.recordCache.get(id)
      if (cached) { records.push(cached.record); return }
      missing.push(id)
    }
    const worker = async (): Promise<void> => {
      while (cursor < ids.length) {
        const id = ids[cursor++]!
        await readOne(id)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()))
    // 兼容没有记录索引的历史结果：并发读取完整快照补出记录，并回填轻量索引，后续列表不再读大文件。
    // 旧结果快照可能很大（数十 MB），回填时限制并发并避免把整份快照留在缓存里。
    const legacyConcurrency = 2
    let legacyCursor = 0
    const legacyWorker = async (): Promise<void> => {
      while (legacyCursor < missing.length) {
        const id = missing[legacyCursor++]!
        const snapshot = await this.get(id, false)
        if (!snapshot) continue
        records.push(snapshot.record)
        try { await this.writeRecordIndex(snapshot.record) } catch { /* 回填失败时下次仍回退读取快照 */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(legacyConcurrency, missing.length) }, () => legacyWorker()))
    for (const id of this.recordCache.keys()) if (!activeIds.has(id)) this.recordCache.delete(id)
    for (const id of this.snapshotCache.keys()) if (!activeIds.has(id)) this.snapshotCache.delete(id)
    for (const id of this.emptyFilterCache.keys()) if (!activeIds.has(id)) this.emptyFilterCache.delete(id)
    return records.sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.resultId.localeCompare(a.resultId))
  }

  /** 轻量记录索引文件：只保存列表需要的 record 字段，避免列目录时读取整份快照。 */
  private recordIndexPath(id: string): string {
    return join(this.directory, `${id}.record.json`)
  }

  /** 写入记录索引；失败不影响已发布快照，列表会回退读取快照。 */
  private async writeRecordIndex(record: MissionResultRecord): Promise<void> {
    const pending = join(this.directory, `${record.resultId}.record.pending`)
    try {
      await writeFile(pending, JSON.stringify(record), { flag: 'wx' })
      await rename(pending, this.recordIndexPath(record.resultId))
    } catch (error) {
      try { await unlink(pending) } catch { /* ignore */ }
      throw error
    }
  }

  /** 读取并校验轻量记录索引；缺失或损坏返回 null。 */
  private async readRecordIndex(id: string): Promise<{ sig: string; record: MissionResultRecord } | null> {
    const filePath = this.recordIndexPath(id)
    let sig: string
    try {
      sig = await regularFileSig(filePath, '结果记录索引必须为普通文件。')
    } catch {
      return null
    }
    try {
      const record: unknown = JSON.parse(await readFile(filePath, 'utf8'))
      if (isMissionResultRecord(record) && record.resultId === id) return { sig, record }
    } catch { /* fall through */ }
    return null
  }

  async filter(id: string, reportId: string, filter: LocalReportFilter): Promise<LocalReportFilterResult> {
    const parsed = parseLocalReportFilter(filter)
    const emptyFilter = parsed !== null && Object.keys(parsed).length === 0
    if (emptyFilter) {
      const cached = this.emptyFilterCache.get(id)
      if (cached && cached.reportId === reportId) {
        try {
          const [sig, manifestSig, indexSig] = await Promise.all([
            regularFileSig(join(this.directory, `${id}.json`), '结果快照必须为普通文件。'),
            regularFileSig(join(this.directory, `${id}.report-index.json`), 'invalid'),
            regularFileSig(join(this.directory, `${id}.report-index.ndjson`), 'invalid'),
          ])
          if (sig === cached.sig && manifestSig === cached.manifestSig && indexSig === cached.indexSig) {
            lruSet(this.emptyFilterCache, id, cached)
            return cached.result
          }
        } catch { /* fall through to verified filter */ }
      }
    }
    const snapshot = await this.get(id)
    if (!snapshot || snapshot.report.reportId !== reportId) throw new Error('FILTER_NOT_FOUND')
    const result = await filterMissionReport(this.directory, snapshot, filter)
    if (emptyFilter) {
      try {
        const [sig, manifestSig, indexSig] = await Promise.all([
          regularFileSig(join(this.directory, `${id}.json`), '结果快照必须为普通文件。'),
          regularFileSig(join(this.directory, `${id}.report-index.json`), 'invalid'),
          regularFileSig(join(this.directory, `${id}.report-index.ndjson`), 'invalid'),
        ])
        lruSet(this.emptyFilterCache, id, { sig, manifestSig, indexSig, reportId, result })
      } catch { /* non-fatal */ }
    }
    return result
  }
}

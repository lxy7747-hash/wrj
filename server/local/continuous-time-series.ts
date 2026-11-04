import { toScenarioCsvRow, toScenarioEvent } from './engine-name-mapping.js'
import { createHash, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, toNamespacedPath } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { ContractDescriptor } from '../../src/contracts/domain-models.js'
import type { AfsimLogEvent } from '../../src/features/data-exchange/afsim-event-log.js'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log.js'
import { inspectCsvText, parseCsvLine } from '../../src/features/data-exchange/csv-contract.js'
import { TIME_SERIES_CONTRACTS, eventCsvRow, type TimeSeriesContext } from './time-series.js'

const READ_CHUNK_BYTES = 64 * 1024
const WRITE_BATCH_BYTES = 64 * 1024
const MAX_PENDING_BYTES = 128 * 1024
const DECLARATION_LIMIT_BYTES = 256 * 1024
const LATENCY_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000]
const createUtf8Decoder = () => new TextDecoder('utf-8', { fatal: true })

type DurationStats = { samples: number; totalMs: number; maximumMs: number; buckets: number[] }
const durationStats = (): DurationStats => ({ samples: 0, totalMs: 0, maximumMs: 0, buckets: Array(LATENCY_BUCKETS_MS.length + 1).fill(0) })
function observeDuration(stats: DurationStats, ms: number): void {
  stats.samples++; stats.totalMs += ms; stats.maximumMs = Math.max(stats.maximumMs, ms)
  const bucket = LATENCY_BUCKETS_MS.findIndex(upper => ms <= upper)
  stats.buckets[bucket < 0 ? LATENCY_BUCKETS_MS.length : bucket]!++
}
function summarizeDuration(stats: DurationStats) {
  return { samples: stats.samples, averageMs: stats.samples ? stats.totalMs / stats.samples : null,
    maximumMs: stats.samples ? stats.maximumMs : null,
    histogram: stats.buckets.map((count, i) => ({ upperBoundMs: LATENCY_BUCKETS_MS[i] ?? null, count })) }
}

type Completion = 'COMPLETED' | 'INCOMPLETE' | 'FAILED'

type SourceFile = {
  contract: ContractDescriptor
  sourcePath: string
  destination: FileHandle
  offset: number
  pending: string
  decoder: ReturnType<typeof createUtf8Decoder>
  sourceHash: ReturnType<typeof createHash>
  destinationHash: ReturnType<typeof createHash>
  sourceBytes: number
  rowCount: number
  writeBatch: string[]
  writeBatchBytes: number
  writeBatchRows: number
  snapshotObservedAt: number
  batchObservedAt: number | null
  writeDuration: DurationStats
  observedToWrite: DurationStats
  writtenBytes: number
  maxObservedBacklogBytes: number
  syncMs: number | null
  headerSeen: boolean
  identity?: string
  present: boolean
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\')
}

function sourceIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}`
}

function splitCompleteLines(value: string): { lines: string[]; pending: string } {
  const lines: string[] = []
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\n') continue
    const end = index > start && value[index - 1] === '\r' ? index - 1 : index
    lines.push(value.slice(start, end))
    start = index + 1
  }
  return { lines, pending: value.slice(start) }
}

/** 将原生事件 CSV 的声明保留为小型解析上下文，逐条复用既有事件解析器。 */
class IncrementalEventDecoder {
  private declarations = ''
  private readonly csvDeclarations = new Map<string, string>()
  private sourceLine = 0
  private block: string[] = []
  private blockBytes = 0
  private blockStart = 0

  private parse(text: string, start: number, end: number): AfsimLogEvent[] {
    const parsed = parseAfsimEventLog(text)
    if (!parsed.valid || parsed.events.length !== 1) throw new Error(`scenario_events.csv 第 ${start} 行无法按原生事件解析：${parsed.issues[0]?.message ?? '解析失败'}`)
    const event = parsed.events[0]!
    return [{ ...event, id: `event-${start}`, sourceLine: start, endLine: end }]
  }

  private flushBlock(): AfsimLogEvent[] {
    if (this.block.length === 0) return []
    const events = this.parse(this.block.join('\n'), this.blockStart, this.sourceLine - 1)
    this.block = []
    this.blockBytes = 0
    this.blockStart = 0
    return events
  }

  read(line: string): AfsimLogEvent[] {
    this.sourceLine += 1
    if (!line.trim()) return []
    if (line.trimStart().startsWith('!')) {
      const prior = this.flushBlock()
      const candidate = this.declarations ? `${this.declarations}\n${line}` : line
      const parsed = parseAfsimEventLog(candidate)
      const issue = parsed.issues.find(item => item.severity === 'ERROR' && item.message !== '文件中没有可解析的事件。')
      if (issue) throw new Error(`scenario_events.csv 第 ${this.sourceLine} 行声明无效：${issue.message}`)
      if (new TextEncoder().encode(candidate).byteLength > DECLARATION_LIMIT_BYTES) throw new Error('scenario_events.csv 事件声明超过受保护上限。')
      this.declarations = candidate
      const type = parseCsvLine(line.trim())![0]!.slice(1).trim()
      this.csvDeclarations.set(type, line.trim())
      return prior
    }
    if (/^\s*[^,\s]+,/.test(line)) {
      const prior = this.flushBlock()
      if (!this.declarations) throw new Error('scenario_events.csv 在事件声明前出现数据行。')
      // Declaration uniqueness was checked against the full context above. A record only needs its own schema;
      // reparsing every other event schema for every row makes the live archive fall behind the native engine.
      const type = parseCsvLine(line)?.[1]?.trim() ?? ''
      return [...prior, ...this.parse(`${this.csvDeclarations.get(type) ?? ''}\n${line}`, this.sourceLine, this.sourceLine)]
    }
    if (/^\S+\s+[A-Z][A-Z_0-9]*\b/.test(line.trim())) {
      const prior = this.flushBlock()
      this.block = [line]
      this.blockBytes = new TextEncoder().encode(line).byteLength
      this.blockStart = this.sourceLine
      return prior
    }
    if (this.block.length > 0 && /^\s*(?:LLA|Speed):/.test(line)) {
      this.blockBytes += new TextEncoder().encode(line).byteLength + 1
      if (this.blockBytes > MAX_PENDING_BYTES) throw new Error('scenario_events.csv 原生事件块超过128KiB受保护上限。')
      this.block.push(line)
      return []
    }
    throw new Error(`scenario_events.csv 第 ${this.sourceLine} 行不是完整事件块。`)
  }

  close(): AfsimLogEvent[] { return this.flushBlock() }
}

/**
 * 运行中增量留存：仅从上次偏移读取追加字节，不重读完整文件，也不使用完成态 32 MiB 快照读取器。
 * 原生事件转换为 canonical events.csv；质量类文件只在已是规范 CSV 时按原值镜像，绝不推算质量数据。
 */
export class ContinuousTimeSeriesWriter {
  private readonly root: string
  private readonly outputRoot: string
  private readonly eventDecoder = new IncrementalEventDecoder()
  private readonly sources = new Map<string, SourceFile>()
  private timer?: ReturnType<typeof setInterval>
  private polling: Promise<void> | null = null
  private closePromise: Promise<string> | null = null
  private closed = false
  private failure: Error | null = null
  private notifyFailure!: (error: Error) => void
  readonly failed: Promise<Error>

  private constructor(private readonly directory: string, private readonly context: TimeSeriesContext, outputDirectory: string, root: string, private readonly names?: Map<string, string>) {
    this.failed = new Promise(resolve => { this.notifyFailure = resolve })
    this.root = root
    this.outputRoot = resolve(outputDirectory)
  }

  static async create(directory: string, context: TimeSeriesContext, outputDirectory: string, names?: Map<string, string>): Promise<ContinuousTimeSeriesWriter> {
    const base = resolve(directory)
    const parent = resolve(base, 'time-series', context.taskId)
    if (!isInside(base, parent) || !/^TASK-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(context.taskId)
      || !/^RUN-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(context.runId)) throw new Error('连续时序任务标识或输出目录无效。')
    await mkdir(parent, { recursive: true })
    // runId 是服务记录标识而非全局唯一文件名；重启/恢复后复用时必须不覆盖历史归档。
    // Windows的mkdtemp不自动扩展长路径；任务摘要和UUID组合后会超过传统260字符边界。
    const root = await mkdtemp(toNamespacedPath(join(parent, `${context.runId}-`)))
    const writer = new ContinuousTimeSeriesWriter(directory, context, outputDirectory, root, names)
    try {
      for (const contract of TIME_SERIES_CONTRACTS) await writer.addSource(contract)
      // 所有来源初始化完成后才轮询，避免慢速open时先轮询空Map并缓存一个已完成的Promise。
      writer.timer = setInterval(() => { void writer.poll().catch(() => undefined) }, 100)
      writer.timer.unref()
      return writer
    } catch (error) {
      clearInterval(writer.timer)
      // addSource 是逐个打开文件的；初始化中途失败也不能遗留 Windows 句柄。
      await Promise.allSettled([...writer.sources.values()].map(source => source.destination.close()))
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }

  private async addSource(contract: ContractDescriptor): Promise<void> {
    const destination = await open(join(this.root, contract.name), 'wx')
    try {
      const sourcePath = contract.name === 'events.csv'
        ? join(this.outputRoot, 'scenario_events.csv')
        : join(this.outputRoot, contract.name)
      const source: SourceFile = { contract, sourcePath, destination, offset: 0, pending: '', decoder: new TextDecoder('utf-8', { fatal: true }),
        sourceHash: createHash('sha256'), destinationHash: createHash('sha256'), sourceBytes: 0, rowCount: 0, writeBatch: [], writeBatchBytes: 0, writeBatchRows: 0,
        snapshotObservedAt: 0, batchObservedAt: null, writeDuration: durationStats(), observedToWrite: durationStats(), writtenBytes: 0,
        maxObservedBacklogBytes: 0, syncMs: null, headerSeen: false, present: false }
      if (contract.name === 'events.csv') {
        const header = `${contract.fields.join(',')}\r\n`
        await destination.writeFile(header)
        source.destinationHash.update(header)
        source.writtenBytes += Buffer.byteLength(header, 'utf8')
        source.headerSeen = true
      }
      this.sources.set(contract.name, source)
    } catch (error) {
      await destination.close().catch(() => undefined)
      throw error
    }
  }

  private async readSource(source: SourceFile): Promise<void> {
    let stat: BigIntStats
    // NTFS identifiers can exceed 2^53; Number rounding can make replacement files look identical.
    try { stat = await lstat(source.sourcePath, { bigint: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (source.present) throw new Error(`${basename(source.sourcePath)} 在运行中消失，无法保证增量可追溯。`)
        return
      }
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${basename(source.sourcePath)} 必须是普通文件。`)
    const identity = sourceIdentity(stat)
    if (source.identity !== undefined && source.identity !== identity) throw new Error(`${basename(source.sourcePath)} 在运行中被替换，无法保证增量可追溯。`)
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${basename(source.sourcePath)} 超过可精确寻址的文件大小。`)
    const sourceSize = Number(stat.size)
    if (sourceSize < source.offset) throw new Error(`${basename(source.sourcePath)} 在运行中被截断，无法保证增量可追溯。`)
    source.identity = identity
    source.present = true
    if (sourceSize === source.offset) return
    source.snapshotObservedAt = performance.now()
    source.maxObservedBacklogBytes = Math.max(source.maxObservedBacklogBytes, sourceSize - source.offset)
    const handle = await open(source.sourcePath, 'r')
    try {
      while (source.offset < sourceSize) {
        const bytes = new Uint8Array(Math.min(READ_CHUNK_BYTES, sourceSize - source.offset))
        const chunk = await handle.read(bytes, 0, bytes.length, source.offset)
        if (chunk.bytesRead === 0) throw new Error(`${basename(source.sourcePath)} 在增量读取中被截断。`)
        const piece = bytes.subarray(0, chunk.bytesRead)
        source.offset += chunk.bytesRead
        source.sourceBytes += chunk.bytesRead
        source.sourceHash.update(piece)
        try { source.pending += source.decoder.decode(piece, { stream: true }) }
        catch { throw new Error(`${basename(source.sourcePath)} 不是有效 UTF-8。`) }
        if (new TextEncoder().encode(source.pending).byteLength > MAX_PENDING_BYTES) throw new Error(`${basename(source.sourcePath)} 存在过长或未完成的记录。`)
        const split = splitCompleteLines(source.pending)
        source.pending = split.pending
        for (const line of split.lines) await this.writeLine(source, line)
        await this.flushWrites(source)
      }
    } finally { await handle.close() }
  }

  private async flushWrites(source: SourceFile): Promise<void> {
    if (source.writeBatch.length === 0) return
    const text = source.writeBatch.join('')
    const rows = source.writeBatchRows
    const observedAt = source.batchObservedAt!
    source.writeBatch = []
    source.writeBatchBytes = 0
    source.writeBatchRows = 0
    source.batchObservedAt = null
    // A failed write can have committed a prefix; close must not retry and duplicate it.
    const started = performance.now()
    await source.destination.writeFile(text)
    source.destinationHash.update(text)
    const completed = performance.now()
    observeDuration(source.writeDuration, completed - started)
    observeDuration(source.observedToWrite, completed - observedAt)
    source.writtenBytes += Buffer.byteLength(text, 'utf8')
    source.rowCount += rows
  }

  private async queueWrite(source: SourceFile, line: string, rowCount = 1): Promise<void> {
    const text = `${line}\r\n`
    const bytes = Buffer.byteLength(text, 'utf8')
    if (source.writeBatchBytes + bytes > WRITE_BATCH_BYTES) await this.flushWrites(source)
    source.batchObservedAt ??= source.snapshotObservedAt
    source.writeBatch.push(text)
    source.writeBatchBytes += bytes
    source.writeBatchRows += rowCount
    // A single validated record may exceed the batch size; never accumulate another beside it.
    if (source.writeBatchBytes >= WRITE_BATCH_BYTES) await this.flushWrites(source)
  }

  private async writeLine(source: SourceFile, line: string): Promise<void> {
    if (source.contract.name === 'events.csv') {
      for (const event of this.eventDecoder.read(line)) {
        await this.writeEvent(source, event)
      }
      return
    }
    if (!source.headerSeen) {
      if (line !== source.contract.fields.join(',')) throw new Error(`${source.contract.name} 表头名称或顺序与合同不一致。`)
      source.headerSeen = true
      await this.queueWrite(source, line, 0)
      return
    }
    const inspected = inspectCsvText(source.contract, `${source.contract.fields.join(',')}\n${line}`)
    if (!inspected.valid || inspected.rowCount !== 1) throw new Error(`${source.contract.name}：${inspected.issues[0]?.message ?? '增量记录不符合合同。'}`)
    const taskIndex = source.contract.fields.indexOf('task_id')
    if (parseCsvLine(line)?.[taskIndex] !== this.context.taskId) throw new Error(`${source.contract.name} 含其他任务的数据。`)
    await this.queueWrite(source, toScenarioCsvRow(this.names, source.contract.fields, line))
  }

  private async writeEvent(source: SourceFile, event: AfsimLogEvent): Promise<void> {
    const row = eventCsvRow(toScenarioEvent(this.names, event), this.context.taskId)
    const checked = inspectCsvText(source.contract, `${source.contract.fields.join(',')}\n${row}`)
    if (!checked.valid) throw new Error(`events.csv：${checked.issues[0]?.message ?? '事件记录不符合规范合同。'}`)
    await this.queueWrite(source, row)
  }

  async poll(): Promise<void> {
    if (this.closed) return
    if (this.failure) throw this.failure
    if (this.polling) return this.polling
    this.polling = (async () => {
      try { for (const source of this.sources.values()) await this.readSource(source) }
      catch (error) {
        this.failure = error instanceof Error ? error : new Error('连续时序写入失败。')
        this.notifyFailure(this.failure)
        throw this.failure
      }
      finally { this.polling = null }
    })()
    return this.polling
  }

  /** 关闭前串行收尾最后一个已落盘块；失败/停止同样发布不可完成的可追溯清单。 */
  async close(completion: Completion): Promise<string> {
    this.closePromise ??= this.closeOnce(completion)
    return this.closePromise
  }

  private async closeOnce(completion: Completion): Promise<string> {
    this.closed = true
    clearInterval(this.timer)
    try { await this.polling }
    catch { /* failure 已保存，仍须发布失败清单。 */ }
    if (!this.failure) {
      try { for (const source of this.sources.values()) await this.readSource(source) }
      catch (error) { this.failure = error instanceof Error ? error : new Error('连续时序收尾失败。') }
    }
    for (const source of this.sources.values()) {
      try {
        try { source.pending += source.decoder.decode() }
        catch { throw new Error(`${basename(source.sourcePath)} 以未完成 UTF-8 结束。`) }
        // CSV 的最后一行可不带换行；仅在收尾时验证并写入，解析失败才视为半行。
        if (source.pending) {
          const line = source.pending
          source.pending = ''
          await this.writeLine(source, line)
        }
        if (source.contract.name === 'events.csv') {
          for (const event of this.eventDecoder.close()) {
            await this.writeEvent(source, event)
          }
        }
      } catch (error) { this.failure ??= error instanceof Error ? error : new Error('连续时序文件关闭失败。') }
      finally {
        // 解析或写盘失败不应跳过 close；否则下次清理/归档在 Windows 上会被句柄阻塞。
        try { await this.flushWrites(source) }
        catch (error) { this.failure ??= error instanceof Error ? error : new Error('连续时序批次写入失败。') }
        try {
          const syncStarted = performance.now()
          await source.destination.sync()
          source.syncMs = performance.now() - syncStarted
        }
        catch (error) { this.failure ??= error instanceof Error ? error : new Error('连续时序文件刷盘失败。') }
        try { await source.destination.close() }
        catch (error) { this.failure ??= error instanceof Error ? error : new Error('连续时序文件关闭失败。') }
      }
      if (source.rowCount === 0) {
        try { await rm(join(this.root, source.contract.name), { force: true }) }
        catch (error) { this.failure ??= error instanceof Error ? error : new Error('连续时序归档清理失败。') }
      }
    }
    const status: Completion = this.failure ? 'FAILED' : completion
    const missing = [...this.sources.values()].filter(source => !source.present || source.rowCount === 0)
      .map(source => ({ fileName: source.contract.name, status: this.failure ? 'CAPTURE_FAILED' : 'REQUIRES_ENGINE',
        reason: this.failure ? '采集失败，未确认该类数据完整；请按错误信息核对原始文件。'
          : source.present ? '引擎未提供实际记录；未生成替代数据。' : '引擎未提供该规范时序数据；未生成替代数据。' }))
    const files = [...this.sources.values()].filter(source => source.rowCount > 0).map(source => ({
      fileName: source.contract.name, version: source.contract.version, rowCount: source.rowCount, encoding: 'UTF-8',
      sourceFile: basename(source.sourcePath), sourceBytes: source.sourceBytes, sourceSha256: source.sourceHash.digest('hex'),
      sha256: source.destinationHash.digest('hex'), fields: source.contract.fields,
      writeMetrics: { writtenBytes: source.writtenBytes, maxObservedBacklogBytes: source.maxObservedBacklogBytes,
        writeCall: summarizeDuration(source.writeDuration), observedSnapshotToWrite: summarizeDuration(source.observedToWrite), finalSyncMs: source.syncMs },
    }))
    const manifest = { schemaVersion: '1.1', mode: 'CONTINUOUS', simulationTimeUnit: 's', status, completed: status === 'COMPLETED',
      // COMPLETED 仅表示本次连续采集收尾无错误；五类合同是否齐备由 contractsComplete 单独说明。
      contractsComplete: missing.length === 0, statusNote: 'COMPLETED 表示连续采集正常收尾，不表示全部五类时序合同均已提供。', ...this.context,
      measurementNote: '批次耗时单位ms；writeCall为文件写入调用返回，observedSnapshotToWrite从本轮观察到源文件快照起计，不是逐条引擎产生时刻。finalSyncMs为收尾sync调用耗时。直方图末档null表示超过5000ms，分档不是验收阈值。',
      files, missing, ...(this.failure ? { errorCode: 'CSV_STREAM_ERROR', error: this.failure.message } : {}) }
    const pending = join(this.root, `manifest-${randomUUID()}.pending`)
    const published = join(this.root, 'manifest.json')
    await writeFile(pending, JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx', flush: true })
    await rename(pending, published)
    if (this.failure) throw this.failure
    return this.root
  }
}

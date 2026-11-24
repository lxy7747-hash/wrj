import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { renameWithRetry } from './file-publication.js'
import type { EngineFrameSnapshot, LinkType } from '../../src/contracts/domain-models.js'
import { EVENTS_CSV_HEADER, LINK_LOSS_CSV_HEADER, LINK_QUALITY_CSV_HEADER, LINK_STATE_CSV_HEADER, LINK_SWITCH_CSV_HEADER } from '../../src/contracts/domain-models.js'
import { isEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot.js'
import { CSV_NO_DATA, inspectCsvRecord } from '../../src/features/data-exchange/csv-contract.js'
import { TIME_SERIES_CONTRACTS } from './time-series.js'
import { readStableUtf8Lines } from './afsim-log-reader.js'

export interface EngineCsvEvidence { sourceSha256: string; files: Array<{ fileName: string; rowCount: number; sha256: string; status: 'COMPLETE' | 'PARTIAL'; skippedCount: number; reason?: string }>; missing: Array<{ fileName: string; status: 'SOURCE_MISSING'; reason: string }> }
export interface EngineLinkBinding { type: LinkType; sourcePlatformId: string; targetPlatformId: string; relayPlatformId?: string | null }
/** 一次已生成但可能尚未切换指针的派生 CSV 发布；调用方可延迟提交或回滚指针。 */
export interface EngineCsvPublication {
  evidence: EngineCsvEvidence
  commitPointer(): Promise<void>
  restorePreviousPointer(): Promise<void>
}
export interface EngineCsvSession {
  append(frame: EngineFrameSnapshot): Promise<void>
  close(sourceSha256: string, options?: { deferPointer?: boolean }): Promise<EngineCsvPublication>
  abort(): Promise<void>
}
const names = ['link_quality.csv', 'events.csv', 'link_switch.csv', 'link_state.csv', 'link_loss.csv'] as const
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
/** 引擎 JSONL 一行包含整帧（含同帧双包），独立于普通 CSV 的 128KiB 单行限制。 */
export const ENGINE_JSONL_LINE_LIMIT_BYTES = 8 * 1024 * 1024
/** 派生规范 CSV 单文件上限；按 UTF-8 字节计入表头、换行与转义，超限即失败关闭。 */
const DERIVED_CSV_LIMIT_BYTES = 256 * 1024 * 1024
// 运行期生效上限；生产恒为 256MiB，仅测试通过 __setDerivedCsvLimitBytesForTest 注入小阈值，产品不暴露环境变量或配置项。
let derivedCsvLimitBytes = DERIVED_CSV_LIMIT_BYTES
/** @internal 仅供验收测试注入小阈值；传 undefined 恢复生产 256MiB。 */
export function __setDerivedCsvLimitBytesForTest(bytes?: number): void {
  derivedCsvLimitBytes = bytes ?? DERIVED_CSV_LIMIT_BYTES
}
/** 计入表头、记录结束符与转义后的 UTF-8 字节是否仍在派生 CSV 单文件上限内（等于边界允许）。 */
export const csvWithinLimit = (bytes: number, limit = derivedCsvLimitBytes): boolean => bytes <= limit
export const CSV_CAPACITY_MESSAGE = '派生 CSV 超过单文件 256MiB 上限。'
export const isEngineCsvCapacityError = (error: unknown): boolean => error instanceof Error && error.message === CSV_CAPACITY_MESSAGE
export const ENGINE_CSV_PROJECTION_VERSION = 2
const csv = (row: readonly unknown[]) => row.map(value => { const text = String(value ?? CSV_NO_DATA); return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text }).join(',')
export async function validateCsvFile(path: string, name: typeof names[number], expectedRows?: number, expectedSha?: string): Promise<{ rowCount: number; sha256: string }> {
  const contract = TIME_SERIES_CONTRACTS.find(item => item.name === name)!
  let header = true, rowCount = 0
  const source = await readStableUtf8Lines(path, line => {
    if (line.includes('\uFFFD')) throw new Error(`${name} 包含无效 UTF-8。`)
    if (header) {
      header = false
      if (line !== contract.fields.join(',')) throw new Error(`${name} 表头不符合规范。`)
      return
    }
    rowCount += 1
    const issues = inspectCsvRecord(contract, line, rowCount + 1)
    if (issues.length) throw new Error(`${name} 连续写入后未通过规范校验：${issues[0]!.message}`)
  }, derivedCsvLimitBytes)
  if (header || source.waitingForLine || (expectedRows !== undefined && rowCount !== expectedRows) || (expectedSha !== undefined && source.source.sha256 !== expectedSha)) throw new Error(`${name} 连续写入后行数、摘要或尾行无效。`)
  return { rowCount, sha256: source.source.sha256 }
}
const typeFor = (frame: EngineFrameSnapshot, bindings: Readonly<Record<string, EngineLinkBinding>>, link: EngineFrameSnapshot['links'][number]) => {
  if (link.linkIds.length !== 1 || link.error !== null) return undefined
  const id = link.linkIds[0]!, binding = bindings[id]
  if (!binding || binding.relayPlatformId || binding.sourcePlatformId !== link.sourcePlatformId || binding.targetPlatformId !== link.targetPlatformId
    || frame.links.filter(candidate => candidate.linkIds.includes(id)).length !== 1
    || Object.values(bindings).filter(candidate => !candidate.relayPlatformId && candidate.type === binding.type
      && candidate.sourcePlatformId === binding.sourcePlatformId && candidate.targetPlatformId === binding.targetPlatformId).length !== 1) return undefined
  return binding.type
}
const segmentRows = (frame: EngineFrameSnapshot, taskId: string, bindings: Readonly<Record<string, EngineLinkBinding>>) => frame.links.map(link => {
  const common = [taskId, '1.1', frame.simulationTime, link.sourcePlatformId, link.targetPlatformId, typeFor(frame, bindings, link)]
  return {
    state: csv([...common, link.status === 'UNKNOWN' ? null : link.status, link.quality.gxbDb, link.quality.ber,
      link.quality.rxPowerDbm ?? (link.quality.rxPowerDbw === null ? null : link.quality.rxPowerDbw + 30)]),
    losses: csv([...common, link.losses.freeSpaceDb, link.losses.seaMultipathDb, link.losses.atmosphericDb,
      link.losses.cloudRainDb, link.losses.jammingDb, link.losses.totalDb]),
  }
})

/** 多跳路径没有单一类型/BER；保留切换行并标缺测，不用某一跳冒充整条路径。 */
function switchRow(frame: EngineFrameSnapshot, value: EngineFrameSnapshot['routing']['switches'][number], taskId: string, bindings: Readonly<Record<string, EngineLinkBinding>>): string {
  const segment = (nodes: typeof value.nodes) => {
    if (nodes.length !== 2) return undefined
    const [source, target] = nodes
    const matches = frame.links.filter(link => link.sourcePlatformId === source!.platformId && link.targetPlatformId === target!.platformId
      && link.sourcePort === source!.outPort && link.targetPort === target!.inPort
      && link.sourcePlatformId === value.sourcePlatformId && link.targetPlatformId === value.targetPlatformId)
    if (matches.length !== 1) return undefined
    const link = matches[0]!, type = typeFor(frame, bindings, link)
    return type ? { type, ber: link.quality.ber } : undefined
  }
  const old = segment(value.oldNodes), next = segment(value.nodes)
  const reason = [...new Set(value.reasons.flatMap(item => item.reasons))].join('; ')
  return csv([taskId, '1.1', frame.simulationTime, value.sourcePlatformId, value.targetPlatformId, value.direction,
    old?.type, next?.type, old?.ber, next?.ber, reason.trim() ? reason : null])
}

/** Generates rows with explicit missing cells from immutable received frames; each file has its own missing reason. */
export async function publishEngineCsv(directory: string, rawJsonl: string, taskId: string, sourceSha256: string, bindings: Readonly<Record<string, EngineLinkBinding>>, expectedFrameCount?: number, options?: { deferPointer?: boolean }): Promise<EngineCsvPublication> {
  const session = await createEngineCsvSession(directory, taskId, bindings)
  try {
    let rows = 0
    const source = await readStableUtf8Lines(rawJsonl, async line => { const frame: unknown = JSON.parse(line); if (!isEngineFrameSnapshot(frame)) throw new Error('引擎帧 CSV 来源无效。'); rows += 1; await session.append(frame) }, MAX_ARCHIVE_BYTES, ENGINE_JSONL_LINE_LIMIT_BYTES)
    if (source.waitingForLine || source.source.sha256 !== sourceSha256 || (rows === 0 && expectedFrameCount !== 0) || (expectedFrameCount !== undefined && rows !== expectedFrameCount)) throw new Error('引擎帧 CSV 来源摘要、尾行或记录数无效。')
    const publication = await session.close(sourceSha256, options)
    // 默认调用方（非两级发布）仍由本函数立即切换指针；延迟调用方自行决定提交时机。
    if (!options?.deferPointer) await publication.commitPointer()
    return publication
  } catch (error) { await session.abort(); throw error }
}

/**
 * Appends received rows, marking missing cells while frames arrive.  The temporary directory is never
 * exposed; close validates each written file then publishes one immutable generation.
 */
export async function createEngineCsvSession(directory: string, taskId: string, bindings: Readonly<Record<string, EngineLinkBinding>>): Promise<EngineCsvSession> {
  const root = resolve(directory); await mkdir(root, { recursive: true }); const pending = await mkdtemp(join(root, '.engine-csv-'))
  const handles = new Map<string, Awaited<ReturnType<typeof open>>>()
  const counts = new Map<string, number>(names.map(name => [name, 0]))
  const reasons = new Map<string, Set<string>>(names.map(name => [name, new Set<string>()]))
  const written = new Map<string, number>(names.map(name => [name, 0]))
  let capacityFailed = false
  const account = (name: typeof names[number], text: string) => {
    const next = written.get(name)! + Buffer.byteLength(text, 'utf8')
    if (!csvWithinLimit(next)) { capacityFailed = true; throw new Error(CSV_CAPACITY_MESSAGE) }
    written.set(name, next)
  }
  const writeAll = async (handle: Awaited<ReturnType<typeof open>>, text: string) => { const bytes = Buffer.from(text, 'utf8'); let offset = 0; while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset, null); if (result.bytesWritten <= 0) throw new Error('规范 CSV 写入未完成。'); offset += result.bytesWritten } }
  const ensure = async (name: typeof names[number]) => {
    let handle = handles.get(name); if (handle) return handle
    const header = `${TIME_SERIES_CONTRACTS.find(item => item.name === name)!.fields.join(',')}\r\n`
    account(name, header)
    handle = await open(join(pending, name), 'wx')
    try { await writeAll(handle, header); handles.set(name, handle); return handle }
    catch (error) { await handle.close().catch(() => undefined); throw error }
  }
  const write = async (name: typeof names[number], line: string) => {
    if (line.includes(CSV_NO_DATA)) reasons.get(name)!.add('缺测或无法唯一对应的字段已写入“暂无数据”，未补零或推算。')
    const text = `${line}\r\n`
    account(name, text)
    const handle = await ensure(name); await writeAll(handle, text); counts.set(name, counts.get(name)! + 1)
  }
  let frames = 0
  let closed = false
  const closeHandles = async () => {
    const results = await Promise.allSettled([...handles.values()].map(async handle => { try { await handle.sync() } finally { await handle.close() } }))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }
  return {
    async append(frame) {
      if (closed) throw new Error('规范 CSV 会话已关闭。')
      frames += 1
      const projected = segmentRows(frame, taskId, bindings)
      for (const row of projected) {
        await write('link_state.csv', row.state)
        await write('link_loss.csv', row.losses)
      }
      reasons.get('link_quality.csv')!.add('上游帧未提供规范质量行所需 SNR、带宽、功率、天线增益、BER门限等完整真实字段。')
      for (const value of frame.routing.switches) await write('link_switch.csv', switchRow(frame, value, taskId, bindings))
      reasons.get('events.csv')!.add('上游事件未提供规范 events.csv 所需明确来源平台及完整事件字段。')
    },
    async close(sourceSha256, options) {
      if (closed) throw new Error('规范 CSV 会话已关闭。'); closed = true
      try {
        // 容量已确定超限时失败关闭：不生成任何代，也不写入指针。
        if (capacityFailed) throw new Error(CSV_CAPACITY_MESSAGE)
        if (frames > 0) for (const name of ['link_state.csv', 'link_loss.csv', 'link_switch.csv'] as const) await ensure(name)
        await closeHandles()
        const files: EngineCsvEvidence['files'] = [], missing: EngineCsvEvidence['missing'] = []
        for (const name of names) {
          if (!handles.has(name)) { missing.push({ fileName: name, status: 'SOURCE_MISSING', reason: [...reasons.get(name)!].join('；') || '来源未提供可验证规范行。' }); continue }
          const validated = await validateCsvFile(join(pending, name), name, counts.get(name))
          const reason = [...reasons.get(name)!].join('；') || undefined
          files.push({ fileName: name, ...validated, status: reason ? 'PARTIAL' : 'COMPLETE', skippedCount: 0, ...(reason ? { reason } : {}) })
        }
        const evidence: EngineCsvEvidence = { sourceSha256, files, missing }
        await writeFile(join(pending, 'manifest.json'), JSON.stringify(evidence, null, 2), 'utf8')
        const generation = `engine-csv-${randomUUID()}`, published = join(root, generation); await renameWithRetry(pending, published)
        // 指针切换只能在本代不可变目录就绪后进行；延迟调用方由上层决定提交时机。
        let captured = false
        let previous: string | null = null
        const commitPointer = async () => {
          try { previous = await readFile(join(root, 'current.json'), 'utf8') } catch { previous = null }
          captured = true
          const pointer = join(root, `.current-${randomUUID()}.json`)
          await writeFile(pointer, JSON.stringify({ generation, sourceSha256, projectionVersion: ENGINE_CSV_PROJECTION_VERSION }), 'utf8')
          await renameWithRetry(pointer, join(root, 'current.json'))
        }
        const restorePreviousPointer = async () => {
          // 未捕获过先前指针时不得删除或改写现有指针。
          if (!captured) return
          if (previous === null) { await unlink(join(root, 'current.json')).catch(() => undefined); return }
          const pointer = join(root, `.current-${randomUUID()}.json`)
          await writeFile(pointer, previous, 'utf8')
          await renameWithRetry(pointer, join(root, 'current.json'))
        }
        const publication: EngineCsvPublication = { evidence, commitPointer, restorePreviousPointer }
        if (!options?.deferPointer) await commitPointer()
        return publication
      } catch (error) { await Promise.allSettled([...handles.values()].map(handle => handle.close())); await rm(pending, { recursive: true, force: true }); throw error }
    },
    async abort() { closed = true; await Promise.allSettled([...handles.values()].map(handle => handle.close())); await rm(pending, { recursive: true, force: true }) },
  }
}

function isEvidence(value: unknown, sourceSha256: string): value is EngineCsvEvidence {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (value as { sourceSha256?: unknown }).sourceSha256 === sourceSha256
    && Array.isArray((value as { files?: unknown }).files) && Array.isArray((value as { missing?: unknown }).missing)
}

export async function getEngineCsvFile(directory: string, sourceSha256: string, fileName: string, options?: { skipContentValidation?: boolean }): Promise<string | null> {
  if (!names.includes(fileName as typeof names[number]) || !/^[a-f0-9]{64}$/u.test(sourceSha256)) return null
  const root = resolve(directory)
  let pointer: { generation?: unknown; sourceSha256?: unknown }
  try { await lstat(join(root, 'current.json')).then(info => { if (!info.isFile() || info.isSymbolicLink()) throw new Error('pointer') }); pointer = JSON.parse(await readFile(join(root, 'current.json'), 'utf8')) } catch { return null }
  if (typeof pointer.generation !== 'string' || pointer.sourceSha256 !== sourceSha256 || !/^engine-csv-[0-9a-f-]{36}$/u.test(pointer.generation)) return null
  const generation = join(root, pointer.generation)
  let evidence: unknown
  try { await lstat(join(generation, 'manifest.json')).then(info => { if (!info.isFile() || info.isSymbolicLink()) throw new Error('manifest') }); evidence = JSON.parse(await readFile(join(generation, 'manifest.json'), 'utf8')) } catch { return null }
  if (!isEvidence(evidence, sourceSha256)) return null
  const declared = (evidence.files as EngineCsvEvidence['files']).find(file => file.fileName === fileName)
  if (!declared) return null
  const candidate = join(generation, fileName), info = await lstat(candidate).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink()) return null
  if (!options?.skipContentValidation) {
    try { await validateCsvFile(candidate, fileName as typeof names[number], declared.rowCount, declared.sha256) } catch { return null }
  }
  return candidate
}

/** 在本次独占任务输出下整批发布副本；只复制已校验文件，失败不替换已有指针。 */
export async function publishTaskEngineCsv(directory: string, evidence: EngineCsvEvidence, getFile: (name: string) => Promise<string | null>): Promise<void> {
  const root = resolve(directory, 'link-csv')
  await mkdir(root, { recursive: true })
  const pending = await mkdtemp(join(root, '.engine-csv-'))
  try {
    for (const file of evidence.files) {
      if (!names.includes(file.fileName as typeof names[number])) throw new Error('任务 CSV 文件名无效。')
      const original = await getFile(file.fileName)
      if (!original) throw new Error('任务 CSV 发布来源缺失或校验失败。')
      const copied = join(pending, file.fileName)
      await copyFile(original, copied)
      await validateCsvFile(copied, file.fileName as typeof names[number], file.rowCount, file.sha256)
    }
    await writeFile(join(pending, 'manifest.json'), JSON.stringify(evidence, null, 2), { encoding: 'utf8', flag: 'wx' })
    const generation = `engine-csv-${randomUUID()}`
    await renameWithRetry(pending, join(root, generation))
    const pointer = join(root, `.current-${randomUUID()}.json`)
    await writeFile(pointer, JSON.stringify({ generation, sourceSha256: evidence.sourceSha256 }), { encoding: 'utf8', flag: 'wx' })
    await renameWithRetry(pointer, join(root, 'current.json'))
  } catch (error) { await rm(pending, { recursive: true, force: true }); throw error }
}

import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { EngineFrameSnapshot, LinkType } from '../../src/contracts/domain-models.js'
import { EVENTS_CSV_HEADER, LINK_LOSS_CSV_HEADER, LINK_QUALITY_CSV_HEADER, LINK_STATE_CSV_HEADER, LINK_SWITCH_CSV_HEADER } from '../../src/contracts/domain-models.js'
import { isEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot.js'
import { inspectCsvRecord } from '../../src/features/data-exchange/csv-contract.js'
import { TIME_SERIES_CONTRACTS } from './time-series.js'
import { readStableUtf8Lines } from './afsim-log-reader.js'

export interface EngineCsvEvidence { sourceSha256: string; files: Array<{ fileName: string; rowCount: number; sha256: string; status: 'COMPLETE' | 'PARTIAL'; skippedCount: number; reason?: string }>; missing: Array<{ fileName: string; status: 'SOURCE_MISSING'; reason: string }> }
export interface EngineLinkBinding { type: LinkType; sourcePlatformId: string; targetPlatformId: string; relayPlatformId?: string | null }
export interface EngineCsvSession { append(frame: EngineFrameSnapshot): Promise<void>; close(sourceSha256: string): Promise<EngineCsvEvidence>; abort(): Promise<void> }
const names = ['link_quality.csv', 'events.csv', 'link_switch.csv', 'link_state.csv', 'link_loss.csv'] as const
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const csv = (row: readonly unknown[]) => row.map(value => { const text = String(value); return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text }).join(',')
async function validateCsvFile(path: string, name: typeof names[number], expectedRows?: number, expectedSha?: string): Promise<{ rowCount: number; sha256: string }> {
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
  })
  if (header || source.waitingForLine || (expectedRows !== undefined && rowCount !== expectedRows) || (expectedSha !== undefined && source.source.sha256 !== expectedSha)) throw new Error(`${name} 连续写入后行数、摘要或尾行无效。`)
  return { rowCount, sha256: source.source.sha256 }
}
const typeFor = (frame: EngineFrameSnapshot, bindings: Readonly<Record<string, EngineLinkBinding>>, link: EngineFrameSnapshot['links'][number]) => {
  if (link.linkIds.length !== 1 || link.error !== null) return undefined
  const id = link.linkIds[0]!, binding = bindings[id]
  if (!binding || binding.relayPlatformId || binding.sourcePlatformId !== link.sourcePlatformId || binding.targetPlatformId !== link.targetPlatformId
    || frame.links.filter(candidate => candidate.linkIds.includes(id)).length !== 1) return undefined
  return binding.type
}
const segmentRows = (frame: EngineFrameSnapshot, taskId: string, bindings: Readonly<Record<string, EngineLinkBinding>>) => frame.links.flatMap(link => {
  const type = typeFor(frame, bindings, link)
  if (!type || !link.sourcePlatformId || !link.targetPlatformId) return []
  const state = link.error === null && (link.status === 'UP' || link.status === 'DOWN')
    ? link.quality.gxbDb !== null && link.quality.ber !== null && (link.quality.rxPowerDbm ?? link.quality.rxPowerDbw) !== null
      ? csv([taskId, '1.1', frame.simulationTime, link.sourcePlatformId, link.targetPlatformId, type, link.status, link.quality.gxbDb, link.quality.ber, link.quality.rxPowerDbm ?? (link.quality.rxPowerDbw === null ? null : link.quality.rxPowerDbw + 30)]) : undefined : undefined
  const losses = (['freeSpaceDb', 'seaMultipathDb', 'atmosphericDb', 'cloudRainDb', 'jammingDb', 'totalDb'] as const).every(key => link.losses[key] !== null)
    ? csv([taskId, '1.1', frame.simulationTime, link.sourcePlatformId, link.targetPlatformId, type, link.losses.freeSpaceDb, link.losses.seaMultipathDb, link.losses.atmosphericDb, link.losses.cloudRainDb, link.losses.jammingDb, link.losses.totalDb]) : undefined
  return [{ state, losses }]
})

/** Generates only contract-complete rows from immutable received frames; each file has its own missing reason. */
export async function publishEngineCsv(directory: string, rawJsonl: string, taskId: string, sourceSha256: string, bindings: Readonly<Record<string, EngineLinkBinding>>, expectedFrameCount?: number): Promise<EngineCsvEvidence> {
  const session = await createEngineCsvSession(directory, taskId, bindings)
  try {
    let rows = 0
    const source = await readStableUtf8Lines(rawJsonl, async line => { const frame: unknown = JSON.parse(line); if (!isEngineFrameSnapshot(frame)) throw new Error('引擎帧 CSV 来源无效。'); rows += 1; await session.append(frame) }, MAX_ARCHIVE_BYTES)
    if (source.waitingForLine || source.source.sha256 !== sourceSha256 || rows === 0 || (expectedFrameCount !== undefined && rows !== expectedFrameCount)) throw new Error('引擎帧 CSV 来源摘要、尾行或记录数无效。')
    return await session.close(sourceSha256)
  } catch (error) { await session.abort(); throw error }
}

/**
 * Appends contract-complete rows while frames arrive.  The temporary directory is never
 * exposed; close validates each written file then publishes one immutable generation.
 */
export async function createEngineCsvSession(directory: string, taskId: string, bindings: Readonly<Record<string, EngineLinkBinding>>): Promise<EngineCsvSession> {
  const root = resolve(directory); await mkdir(root, { recursive: true }); const pending = await mkdtemp(join(root, '.engine-csv-'))
  const handles = new Map<string, Awaited<ReturnType<typeof open>>>()
  const counts = new Map<string, number>(names.map(name => [name, 0]))
  const skipped = new Map<string, number>(names.map(name => [name, 0]))
  const reasons = new Map<string, Set<string>>(names.map(name => [name, new Set<string>()]))
  const writeAll = async (handle: Awaited<ReturnType<typeof open>>, text: string) => { const bytes = Buffer.from(text, 'utf8'); let offset = 0; while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset, null); if (result.bytesWritten <= 0) throw new Error('规范 CSV 写入未完成。'); offset += result.bytesWritten } }
  const ensure = async (name: typeof names[number]) => {
    let handle = handles.get(name); if (handle) return handle
    handle = await open(join(pending, name), 'wx')
    try { await writeAll(handle, `${TIME_SERIES_CONTRACTS.find(item => item.name === name)!.fields.join(',')}\r\n`); handles.set(name, handle); return handle }
    catch (error) { await handle.close().catch(() => undefined); throw error }
  }
  const write = async (name: typeof names[number], line: string | undefined, reason: string) => {
    if (!line) { reasons.get(name)!.add(reason); skipped.set(name, skipped.get(name)! + 1); return }
    const handle = await ensure(name); await writeAll(handle, `${line}\r\n`); counts.set(name, counts.get(name)! + 1)
  }
  let closed = false
  const closeHandles = async () => {
    const results = await Promise.allSettled([...handles.values()].map(async handle => { try { await handle.sync() } finally { await handle.close() } }))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }
  return {
    async append(frame) {
      if (closed) throw new Error('规范 CSV 会话已关闭。')
      const projected = segmentRows(frame, taskId, bindings)
      const unmatched = frame.links.length - projected.length
      if (unmatched) for (const name of ['link_state.csv', 'link_loss.csv'] as const) { skipped.set(name, skipped.get(name)! + unmatched); reasons.get(name)!.add('存在非唯一、多跳、端点不匹配或引擎错误的段，未映射为逻辑链路。') }
      for (const row of projected) {
        await write('link_state.csv', row.state, '缺少唯一配置链路类型、端点、UP/DOWN状态或GXB/BER/接收功率。')
        await write('link_loss.csv', row.losses, '缺少唯一配置链路类型、端点或六项完整损耗分量。')
      }
      reasons.get('link_quality.csv')!.add('上游帧未提供规范质量行所需 SNR、带宽、功率、天线增益、BER门限等完整真实字段。')
      reasons.get('link_switch.csv')!.add('上游切换记录未同时提供旧新链路类型、旧新 BER 和可规范化原因。')
      reasons.get('events.csv')!.add('上游事件未提供规范 events.csv 所需明确来源平台及完整事件字段。')
    },
    async close(sourceSha256) {
      if (closed) throw new Error('规范 CSV 会话已关闭。'); closed = true
      try {
        await closeHandles()
        const files: EngineCsvEvidence['files'] = [], missing: EngineCsvEvidence['missing'] = []
        for (const name of names) {
          if (!counts.get(name)) { missing.push({ fileName: name, status: 'SOURCE_MISSING', reason: [...reasons.get(name)!].join('；') || '来源未提供可验证规范行。' }); continue }
          const validated = await validateCsvFile(join(pending, name), name, counts.get(name))
          const skippedCount = skipped.get(name)!, reason = [...reasons.get(name)!].join('；') || undefined
          files.push({ fileName: name, ...validated, status: skippedCount ? 'PARTIAL' : 'COMPLETE', skippedCount, ...(reason ? { reason } : {}) })
        }
        const evidence: EngineCsvEvidence = { sourceSha256, files, missing }
        await writeFile(join(pending, 'manifest.json'), JSON.stringify(evidence, null, 2), 'utf8')
        const generation = `engine-csv-${randomUUID()}`, published = join(root, generation); await rename(pending, published)
        const pointer = join(root, `.current-${randomUUID()}.json`); await writeFile(pointer, JSON.stringify({ generation, sourceSha256 }), 'utf8'); await rename(pointer, join(root, 'current.json'))
        return evidence
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

export async function getEngineCsvFile(directory: string, sourceSha256: string, fileName: string): Promise<string | null> {
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
  try { await validateCsvFile(candidate, fileName as typeof names[number], declared.rowCount, declared.sha256) } catch { return null }
  return candidate
}

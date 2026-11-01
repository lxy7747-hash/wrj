import { randomUUID, createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  EVENTS_CSV_HEADER, LINK_QUALITY_CSV_HEADER, LINK_STATE_CSV_HEADER,
  LINK_LOSS_CSV_HEADER, LINK_SWITCH_CSV_HEADER, type ContractDescriptor,
} from '../../src/contracts/domain-models.js'
import type { AfsimEventLog } from '../../src/features/data-exchange/afsim-event-log.js'
import { inspectCsvText, parseCsvLine } from '../../src/features/data-exchange/csv-contract.js'
import { readLocalFileSnapshot } from './afsim-log-reader.js'

export const TIME_SERIES_CONTRACTS: readonly ContractDescriptor[] = [
  ['link_quality.csv', LINK_QUALITY_CSV_HEADER], ['events.csv', EVENTS_CSV_HEADER],
  ['link_switch.csv', LINK_SWITCH_CSV_HEADER], ['link_state.csv', LINK_STATE_CSV_HEADER],
  ['link_loss.csv', LINK_LOSS_CSV_HEADER],
].map(([name, header]) => ({ name: name!, version: '1.1', sourceRef: '软件测试大纲 表30/53/65', fields: header!.split(',') }))

export interface TimeSeriesContext {
  taskId: string
  runId: string
}

const checksum = (text: string) => createHash('sha256').update(text).digest('hex')
const csvCell = (text: string) => {
  if (/[\r\n]/.test(text)) throw new Error('规范 CSV 单元格不接受未编码的换行。')
  return /[",]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** 保留原始字段，不从设备启停、消息接收或配置值推算物理链路质量。 */
export function eventCsvRow(event: AfsimEventLog['events'][number], taskId: string): string {
  const fields = EVENTS_CSV_HEADER.split(',')
  const row: Record<string, string> = {
    task_id: taskId, SchemaVersion: '1.1', Time: String(event.time), EventType: event.type,
    SourcePlatform: event.subject,
    TargetPlatform: event.fields.target_platform ?? event.fields.TargetPlatform ?? '',
    Status: event.fields.Status ?? event.fields.status ?? '',
    // 原生事件字段的单位未规范化，保留在 Parameters，不将 Hz 或 dBW 猜成 MHz 或 W。
    Power: '', Frequency: '', Bandwidth: '',
    Parameters: JSON.stringify({ eventId: event.id, sourceLine: event.sourceLine,
      fields: event.fields, ...(event.unparsedText === undefined ? {} : { unparsedText: event.unparsedText }) }),
  }
  return fields.map(field => csvCell(row[field] ?? '')).join(',')
}

function eventCsv(log: AfsimEventLog, taskId: string): string {
  return [EVENTS_CSV_HEADER, ...log.events.map(event => eventCsvRow(event, taskId))].join('\r\n') + '\r\n'
}

function validateDataset(contract: ContractDescriptor, text: string, taskId: string): number {
  const result = inspectCsvText(contract, text)
  if (!result.valid) throw new Error(`${contract.name}：${result.issues[0]?.message ?? '规范校验失败'}`)
  if (result.rowCount === 0) throw new Error(`${contract.name} 没有实际记录，不能作为完整时序数据。`)
  const taskIndex = contract.fields.indexOf('task_id')
  for (const line of text.trimEnd().split(/\r?\n/).slice(1)) {
    if (parseCsvLine(line)?.[taskIndex] !== taskId) throw new Error(`${contract.name} 含其他任务的数据。`)
  }
  return result.rowCount
}

/** 在任务独占输出目录原子发布规范 CSV；缺少质量数据时只留明确的待引擎项，不造空表。 */
export async function writeTimeSeries(
  outputDirectory: string, context: TimeSeriesContext, log: AfsimEventLog, sourceSha256: string,
): Promise<string> {
  if (!/^TASK-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(context.taskId)
    || !/^RUN-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(context.runId)
    || !/^[a-f0-9]{64}$/.test(sourceSha256) || !log.valid) throw new Error('时序任务标识或来源无效。')
  const root = resolve(outputDirectory)
  const datasets: Array<{ contract: ContractDescriptor; text: string; rowCount: number; sourceSha256: string }> = []
  const missing: Array<{ fileName: string; status: 'REQUIRES_ENGINE'; reason: string }> = []
  for (const contract of TIME_SERIES_CONTRACTS) {
    let text: string
    let datasetSourceSha256 = sourceSha256
    if (contract.name === 'events.csv') text = eventCsv(log, context.taskId)
    else {
      const path = join(root, contract.name)
      try {
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${contract.name} 必须是普通文件。`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        missing.push({ fileName: contract.name, status: 'REQUIRES_ENGINE', reason: '引擎未提供该规范时序数据；未生成替代数据。' })
        continue
      }
      const snapshot = await readLocalFileSnapshot(path)
      datasetSourceSha256 = snapshot.source.sha256
      text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)
    }
    datasets.push({ contract, text, rowCount: validateDataset(contract, text, context.taskId), sourceSha256: datasetSourceSha256 })
  }
  await mkdir(root, { recursive: true })
  const owned = await mkdtemp(join(root, '.time-series-'))
  try {
    for (const data of datasets) await writeFile(join(owned, data.contract.name), data.text, { encoding: 'utf8', flag: 'wx' })
    const manifest = {
      schemaVersion: '1.1', ...context, encoding: 'UTF-8', simulationTimeUnit: 's', sourceSha256,
      contractsComplete: missing.length === 0,
      files: datasets.map(data => ({ fileName: data.contract.name, version: data.contract.version,
        rowCount: data.rowCount, sha256: checksum(data.text), sourceSha256: data.sourceSha256, fields: data.contract.fields })), missing,
    }
    await writeFile(join(owned, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' })
    const published = join(root, `time-series-${randomUUID()}`)
    await rename(owned, published)
    return published
  } catch (error) {
    // owned 只可能是上方在 root 中独占创建的目录；不清理原始文件或既有发布目录。
    await rm(owned, { recursive: true, force: true })
    throw error
  }
}

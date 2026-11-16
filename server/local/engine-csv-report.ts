import { createHash } from 'node:crypto'
import { CSV_NO_DATA, inspectCsvRecord, parseCsvLine } from '../../src/features/data-exchange/csv-contract.js'
import { evidenceBundlePayload } from '../../src/features/data-exchange/evidence-contract.js'
import { buildFileSetSource, type EvidenceSource, type FileSetInput } from '../../src/features/reports/report-evidence.js'
import { readStableUtf8Lines } from './afsim-log-reader.js'
import { TIME_SERIES_CONTRACTS } from './time-series.js'
import type { EngineCsvEvidence, EngineLinkBinding } from './engine-frame-csv.js'

/** 从已发布 CSV 原文生成报告来源；不借当前场景或 JSONL 补齐文件中的缺项。 */
export async function readEngineCsvSource(
  evidence: EngineCsvEvidence, taskId: string, bindings: Readonly<Record<string, EngineLinkBinding>>,
  getFile: (name: string) => Promise<string | null>, requestedSha?: string,
): Promise<EvidenceSource | null> {
  const kinds = { 'link_state.csv': 'state', 'link_loss.csv': 'loss', 'link_switch.csv': 'switch' } as const
  const files = evidence.files.filter(file => Object.hasOwn(kinds, file.fileName)).sort((a, b) => a.fileName.localeCompare(b.fileName))
  if (!files.length) return null
  const bundleSha256 = createHash('sha256').update(evidenceBundlePayload(files.map(file => ({ fileName: file.fileName, sha256: file.sha256, rows: file.rowCount })))).digest('hex')
  if (requestedSha !== undefined && requestedSha !== bundleSha256) return null
  // shortcut: 沿用文件集的内存投影；大体量 CSV 的报表性能验收前需改为索引分页。
  const input: FileSetInput = { bundleSha256, capabilities: [], state: [], loss: [], switch: [] }
  const linkIds = new Map<string, string | null>()
  const key = (source: string, target: string, type: string) => JSON.stringify([source, target, type])
  for (const [id, binding] of Object.entries(bindings)) {
    if (binding.relayPlatformId) continue
    const identity = key(binding.sourcePlatformId, binding.targetPlatformId, binding.type)
    linkIds.set(identity, linkIds.has(identity) ? null : id)
  }
  for (const file of files) {
    const name = file.fileName as keyof typeof kinds
    const path = await getFile(name)
    if (!path) throw new Error('任务 CSV 缺失或摘要校验失败。')
    const contract = TIME_SERIES_CONTRACTS.find(item => item.name === name)!
    let rows = 0
    const source = await readStableUtf8Lines(path, (line, lineNumber) => {
      if (lineNumber === 1) {
        if (line !== contract.fields.join(',')) throw new Error('任务 CSV 表头不符合 1.1 契约。')
        return
      }
      const issues = inspectCsvRecord(contract, line, lineNumber)
      if (issues.length) throw new Error(`${name}: ${issues[0]!.message}`)
      const cells = parseCsvLine(line)!
      const row = Object.fromEntries(contract.fields.map((field, index) => [field, cells[index]!]))
      if (row.task_id !== taskId || row.SchemaVersion !== '1.1') throw new Error('任务 CSV 的任务或版本不匹配。')
      rows += 1
      const time = Number(row.Time)
      const number = (field: string) => row[field] === CSV_NO_DATA ? null : Number(row[field])
      if (name === 'link_switch.csv') {
        input.switch.push({ time, sourcePlatform: row.SourcePlatform!, destPlatform: row.DestPlatform!, direction: row.Direction!,
          oldLinkType: row.OldLinkType!, newLinkType: row.NewLinkType!, oldBer: number('OldBER'), newBer: number('NewBER'), reason: row.SwitchReason! })
        return
      }
      const linkId = row.LinkType === CSV_NO_DATA ? null : linkIds.get(key(row.SourcePlatform!, row.DestPlatform!, row.LinkType!))
      if (row.LinkType !== CSV_NO_DATA && !linkId) throw new Error('任务 CSV 无法唯一关联本次运行冻结的链路。')
      const common = { time, linkId: linkId ?? null, sourcePlatformId: row.SourcePlatform === CSV_NO_DATA ? null : row.SourcePlatform!, targetPlatformId: row.DestPlatform === CSV_NO_DATA ? null : row.DestPlatform! }
      if (name === 'link_state.csv') input.state.push({ ...common, linkStatus: row.LinkStatus!, gxbDb: number('GXB'), ber: number('BER'), receivedPower: number('ReceivedPower') })
      else input.loss.push({ ...common, freeSpaceLossDb: number('FreeSpaceLoss'), seaMultipathLossDb: number('SeaMultipathLoss'),
        atmosphericLossDb: number('AtmosphericLoss'), cloudRainLossDb: number('CloudRainLoss'), jammingLossDb: number('JammingLoss'), totalLossDb: number('TotalLoss') })
    })
    if (source.waitingForLine || rows !== file.rowCount || source.source.sha256 !== file.sha256) throw new Error('任务 CSV 的行数、尾行或摘要不一致。')
    input.capabilities.push(kinds[name])
  }
  const result = buildFileSetSource(input)
  const partial = files.length < 3 || files.some(file => file.status === 'PARTIAL')
  result.label = `任务 CSV${partial ? '（部分覆盖）' : ''} ${bundleSha256.slice(0, 12)}…`
  return result
}

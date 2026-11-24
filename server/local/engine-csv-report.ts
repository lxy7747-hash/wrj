import { createHash } from 'node:crypto'
import { CSV_NO_DATA, inspectCsvCells, parseCsvLine } from '../../src/features/data-exchange/csv-contract.js'
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
    const expectedHeader = contract.fields.join(',')
    const col = Object.fromEntries(contract.fields.map((field, index) => [field, index])) as Record<string, number>
    const taskIdIdx = col.task_id!, schemaIdx = col.SchemaVersion!, timeIdx = col.Time!
    const srcIdx = col.SourcePlatform!, dstIdx = col.DestPlatform!
    const linkTypeIdx = col.LinkType, linkStatusIdx = col.LinkStatus, gxbIdx = col.GXB, berIdx = col.BER, rxIdx = col.ReceivedPower
    const fsIdx = col.FreeSpaceLoss, mpIdx = col.SeaMultipathLoss, atmIdx = col.AtmosphericLoss, crIdx = col.CloudRainLoss, jamIdx = col.JammingLoss, totIdx = col.TotalLoss
    const dirIdx = col.Direction, oldTypeIdx = col.OldLinkType, newTypeIdx = col.NewLinkType, oldBerIdx = col.OldBER, newBerIdx = col.NewBER, reasonIdx = col.SwitchReason
    let rows = 0
    const source = await readStableUtf8Lines(path, (line, lineNumber) => {
      if (lineNumber === 1) {
        if (line !== expectedHeader) throw new Error('任务 CSV 表头不符合 1.1 契约。')
        return
      }
      const cells = parseCsvLine(line)
      const issues = inspectCsvCells(contract, cells, lineNumber)
      if (issues.length) throw new Error(`${name}: ${issues[0]!.message}`)
      if (cells![taskIdIdx] !== taskId || cells![schemaIdx] !== '1.1') throw new Error('任务 CSV 的任务或版本不匹配。')
      rows += 1
      const time = Number(cells![timeIdx])
      const numberAt = (index: number | undefined) => {
        const raw = index === undefined ? undefined : cells![index]
        return raw === undefined || raw === CSV_NO_DATA ? null : Number(raw)
      }
      if (name === 'link_switch.csv') {
        input.switch.push({ time, sourcePlatform: cells![srcIdx]!, destPlatform: cells![dstIdx]!, direction: cells![dirIdx!]!,
          oldLinkType: cells![oldTypeIdx!]!, newLinkType: cells![newTypeIdx!]!, oldBer: numberAt(oldBerIdx), newBer: numberAt(newBerIdx), reason: cells![reasonIdx!]! })
        return
      }
      const srcPlat = cells![srcIdx]!, dstPlat = cells![dstIdx]!, linkType = cells![linkTypeIdx!]!
      const linkId = linkType === CSV_NO_DATA ? null : linkIds.get(key(srcPlat, dstPlat, linkType))
      if (linkType !== CSV_NO_DATA && !linkId) throw new Error('任务 CSV 无法唯一关联本次运行冻结的链路。')
      const common = { time, linkId: linkId ?? null, sourcePlatformId: srcPlat === CSV_NO_DATA ? null : srcPlat, targetPlatformId: dstPlat === CSV_NO_DATA ? null : dstPlat }
      if (name === 'link_state.csv') input.state.push({ ...common, linkStatus: cells![linkStatusIdx!]!, gxbDb: numberAt(gxbIdx), ber: numberAt(berIdx), receivedPower: numberAt(rxIdx) })
      else input.loss.push({ ...common, freeSpaceLossDb: numberAt(fsIdx), seaMultipathLossDb: numberAt(mpIdx),
        atmosphericLossDb: numberAt(atmIdx), cloudRainLossDb: numberAt(crIdx), jammingLossDb: numberAt(jamIdx), totalLossDb: numberAt(totIdx) })
    })
    if (source.waitingForLine || rows !== file.rowCount || source.source.sha256 !== file.sha256) throw new Error('任务 CSV 的行数、尾行或摘要不一致。')
    input.capabilities.push(kinds[name])
  }
  const result = buildFileSetSource(input)
  const partial = files.length < 3 || files.some(file => file.status === 'PARTIAL')
  result.label = `任务 CSV${partial ? '（部分覆盖）' : ''} ${bundleSha256.slice(0, 12)}…`
  return result
}

import {
  LINK_LOSS_CSV_HEADER, LINK_STATE_CSV_HEADER, LINK_SWITCH_CSV_HEADER,
  type Link, type QualityDataset, type QualityScope,
} from '../../contracts/domain-models'
import { CSV_NO_DATA, parseCsvLine } from './csv-contract'
import { parseQualityImport, QualityImportError, type QualityConfig } from './quality-records'
import {
  EVIDENCE_FILE_KINDS, EVIDENCE_KIND_FILE, EvidenceImportError, evidenceBundlePayload,
  type EvidenceFileKind, type EvidenceImportFile, type EvidenceImportFileReceipt, type EvidenceImportRequest, type EvidenceImportResult, type EvidenceValidationIssue,
} from './evidence-contract'

export interface EvidenceStateRecord { time: number; linkId: string | null; linkStatus: 'UP' | 'DOWN' | 'DEGRADED' | '暂无数据'; gxbDb: number | null; ber: number | null; receivedPower: number | null; sourcePlatformId: string; targetPlatformId: string }
export interface EvidenceLossRecord { time: number; linkId: string | null; freeSpaceLossDb: number | null; seaMultipathLossDb: number | null; atmosphericLossDb: number | null; cloudRainLossDb: number | null; jammingLossDb: number | null; totalLossDb: number | null; sourcePlatformId: string; targetPlatformId: string }
export interface EvidenceSwitchRecord { time: number; sourcePlatform: string; destPlatform: string; direction: 'FORWARD' | 'REVERSE'; oldLinkType: string; newLinkType: string; oldBer: number | null; newBer: number | null; reason: string }

export interface ParsedEvidenceBundle {
  result: EvidenceImportResult
  quality?: QualityDataset
  state: EvidenceStateRecord[]
  loss: EvidenceLossRecord[]
  switch: EvidenceSwitchRecord[]
}

const decimalNumber = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u
const linkTypes = new Set(['SAT', 'MICROWAVE', 'DATALINK', 'LASER', 'FIBER'])
const issue = (issues: EvidenceValidationIssue[], code: string, file: string, row: number | undefined, fieldPath: string, message: string) =>
  issues.push({ severity: 'ERROR', code, file, ...(row === undefined ? {} : { row }), fieldPath, message })

function numeric(value: string | undefined): number | null {
  const text = value?.trim() ?? ''
  return text !== '' && decimalNumber.test(text) && Number.isFinite(Number(text)) ? Number(text) : null
}
function requiredNumeric(value: string | undefined): number | null {
  const parsed = numeric(value)
  return parsed !== null && Number.isFinite(parsed) ? parsed : null
}

/** 拆分 CSV 文本并校验表头；返回记录行（不含表头）。 */
function rowsOf(file: string, text: string, header: string, issues: EvidenceValidationIssue[]): Array<{ cells: string[]; row: number }> {
  if (text.includes('\uFFFD')) { issue(issues, 'EVIDENCE_ENCODING_INVALID', file, undefined, 'text', '文件包含无效 UTF-8 替换字符。'); return [] }
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  while (lines.at(-1) === '') lines.pop()
  if (lines.shift() !== header) { issue(issues, 'EVIDENCE_HEADER_INVALID', file, 1, 'header', `表头必须等于规范 ${file} 表头。`); return [] }
  const columns = header.split(',')
  const rows: Array<{ cells: string[]; row: number }> = []
  for (let index = 0; index < lines.length; index += 1) {
    const cells = parseCsvLine(lines[index]!)
    if (!cells || cells.length !== columns.length) { issue(issues, 'EVIDENCE_ROW_INVALID', file, index + 2, `rows[${index}]`, '行列数或引号格式无效。'); continue }
    rows.push({ cells, row: index + 2 })
  }
  return rows
}

function linkResolver(config: QualityConfig) {
  const links = config.links.filter(link => link.enabled !== false)
  return (sourcePlatform: string, destPlatform: string, linkType: string): Link | undefined => {
    const candidates = links.filter(link => link.sourcePlatformId === sourcePlatform && link.targetPlatformId === destPlatform && link.type === linkType)
    return candidates.length === 1 ? candidates[0] : undefined
  }
}

function scopeRowOk(record: Record<string, string>, scope: QualityScope): boolean {
  return record.task_id === scope.taskId && record.SchemaVersion === '1.1'
}

/**
 * 解析并整批校验四类规范 CSV；任一文件失败即整批拒绝（返回错误，不产生批次）。
 * state/loss/switch 保持缺失为缺失，不补默认值，不从状态或功率推导 SNR。
 */
export function parseEvidenceBundle(
  request: EvidenceImportRequest, scope: QualityScope, config: QualityConfig,
  source: { sha256: (text: string) => string; importedAt: string },
): ParsedEvidenceBundle {
  const issues: EvidenceValidationIssue[] = []
  const resolveLink = linkResolver(config)
  const byKind = new Map<EvidenceFileKind, EvidenceImportFile>()
  for (const file of request.files) {
    const kind = EVIDENCE_FILE_KINDS.find(candidate => EVIDENCE_KIND_FILE[candidate] === file.fileName)
    if (kind) byKind.set(kind, file)
  }
  let quality: QualityDataset | undefined
  const state: EvidenceStateRecord[] = []
  const loss: EvidenceLossRecord[] = []
  const switchRows: EvidenceSwitchRecord[] = []
  const receipts: EvidenceImportFileReceipt[] = []
  const warnings: string[] = []

  const qualityFile = byKind.get('quality')
  if (qualityFile) {
    try {
      const parsed = parseQualityImport({ scope, fileName: qualityFile.fileName, format: 'CSV', text: qualityFile.text }, scope, config,
        { sha256: source.sha256(qualityFile.text), importedAt: source.importedAt })
      if (parsed.data) quality = parsed.data
      else for (const item of parsed.errors) issue(issues, item.code, qualityFile.fileName, undefined, item.fieldPath, item.message)
    } catch (error) {
      if (error instanceof QualityImportError) for (const item of error.issues) issue(issues, item.code, qualityFile.fileName, undefined, item.fieldPath, item.message)
      else throw error
    }
    if (quality) receipts.push({ fileName: qualityFile.fileName, sha256: quality.source.sha256, rows: quality.samples.length })
  }

  const stateFile = byKind.get('state')
  if (stateFile) {
    const duplicates = new Set<string>()
    for (const { cells, row } of rowsOf(stateFile.fileName, stateFile.text, LINK_STATE_CSV_HEADER, issues)) {
      const record = Object.fromEntries(LINK_STATE_CSV_HEADER.split(',').map((key, index) => [key, cells[index]!])) as Record<string, string>
      const path = `rows[${row - 2}]`
      if (!scopeRowOk(record, scope)) { issue(issues, 'EVIDENCE_SCOPE_INVALID', stateFile.fileName, row, path, '任务标识或版本与当前运行不一致。'); continue }
      const time = requiredNumeric(record.Time), link = resolveLink(record.SourcePlatform!, record.DestPlatform!, record.LinkType!)
      if (time === null || time < 0) { issue(issues, 'EVIDENCE_TIME_INVALID', stateFile.fileName, row, `${path}.Time`, '时刻必须为非负有限秒数。'); continue }
      if (!link && record.LinkType !== CSV_NO_DATA) { issue(issues, 'EVIDENCE_LINK_AMBIGUOUS', stateFile.fileName, row, path, '链路端点与类型无法唯一映射到当前已启用链路。'); continue }
      if ((!linkTypes.has(record.LinkType!) && record.LinkType !== CSV_NO_DATA) || !['UP', 'DOWN', 'DEGRADED', CSV_NO_DATA].includes(record.LinkStatus!)) { issue(issues, 'EVIDENCE_STATE_ENUM_INVALID', stateFile.fileName, row, path, '链路类型或状态枚举无效。'); continue }
      const gxbDb = numeric(record.GXB), ber = numeric(record.BER), receivedPower = numeric(record.ReceivedPower)
      if (gxbDb === null && record.GXB?.trim() !== '' && record.GXB !== CSV_NO_DATA || ber === null && record.BER?.trim() !== '' && record.BER !== CSV_NO_DATA || receivedPower === null && record.ReceivedPower?.trim() !== '' && record.ReceivedPower !== CSV_NO_DATA) { issue(issues, 'EVIDENCE_NUMBER_INVALID', stateFile.fileName, row, path, 'GXB、误码率和接收功率必须为有限数值、暂无数据或留空。'); continue }
      if (ber !== null && (ber < 0 || ber > 1)) { issue(issues, 'EVIDENCE_BER_RANGE_INVALID', stateFile.fileName, row, `${path}.BER`, '误码率必须在 0 到 1 之间。'); continue }
      const signature = JSON.stringify([time, link?.id ?? null, record.LinkStatus, gxbDb, ber, receivedPower])
      if (link && duplicates.has(signature)) { issue(issues, 'EVIDENCE_DUPLICATE_ROW', stateFile.fileName, row, path, '同一状态行重复出现。'); continue }
      duplicates.add(signature)
      state.push({ time, linkId: link?.id ?? null, linkStatus: record.LinkStatus as EvidenceStateRecord['linkStatus'], gxbDb, ber, receivedPower, sourcePlatformId: record.SourcePlatform!, targetPlatformId: record.DestPlatform! })
    }
    receipts.push({ fileName: stateFile.fileName, sha256: source.sha256(stateFile.text), rows: state.length })
    warnings.push('state 文件仅提供状态、GXB、误码率与接收功率，不提供也不能推导 SNR。')
  }

  const lossFile = byKind.get('loss')
  if (lossFile) {
    const duplicates = new Set<string>()
    for (const { cells, row } of rowsOf(lossFile.fileName, lossFile.text, LINK_LOSS_CSV_HEADER, issues)) {
      const record = Object.fromEntries(LINK_LOSS_CSV_HEADER.split(',').map((key, index) => [key, cells[index]!])) as Record<string, string>
      const path = `rows[${row - 2}]`
      if (!scopeRowOk(record, scope)) { issue(issues, 'EVIDENCE_SCOPE_INVALID', lossFile.fileName, row, path, '任务标识或版本与当前运行不一致。'); continue }
      const time = requiredNumeric(record.Time), link = resolveLink(record.SourcePlatform!, record.DestPlatform!, record.LinkType!)
      if (time === null || time < 0) { issue(issues, 'EVIDENCE_TIME_INVALID', lossFile.fileName, row, `${path}.Time`, '时刻必须为非负有限秒数。'); continue }
      if (!link && record.LinkType !== CSV_NO_DATA) { issue(issues, 'EVIDENCE_LINK_AMBIGUOUS', lossFile.fileName, row, path, '链路端点与类型无法唯一映射到当前已启用链路。'); continue }
      const keys = ['FreeSpaceLoss', 'SeaMultipathLoss', 'AtmosphericLoss', 'CloudRainLoss', 'JammingLoss', 'TotalLoss']
      const components = keys.map(key => requiredNumeric(record[key]))
      if (components.some((value, index) => value === null && record[keys[index]!] !== CSV_NO_DATA)) { issue(issues, 'EVIDENCE_NUMBER_INVALID', lossFile.fileName, row, path, '六项损耗分量必须为有限数值或暂无数据。'); continue }
      const [freeSpaceLossDb, seaMultipathLossDb, atmosphericLossDb, cloudRainLossDb, jammingLossDb, totalLossDb] = components
      const signature = JSON.stringify([time, link?.id ?? null, ...components])
      if (link && duplicates.has(signature)) { issue(issues, 'EVIDENCE_DUPLICATE_ROW', lossFile.fileName, row, path, '同一损耗行重复出现。'); continue }
      duplicates.add(signature)
      loss.push({ time, linkId: link?.id ?? null, freeSpaceLossDb: freeSpaceLossDb!, seaMultipathLossDb: seaMultipathLossDb!, atmosphericLossDb: atmosphericLossDb!, cloudRainLossDb: cloudRainLossDb!, jammingLossDb: jammingLossDb!, totalLossDb: totalLossDb!, sourcePlatformId: record.SourcePlatform!, targetPlatformId: record.DestPlatform! })
    }
    receipts.push({ fileName: lossFile.fileName, sha256: source.sha256(lossFile.text), rows: loss.length })
  }

  const switchFile = byKind.get('switch')
  if (switchFile) {
    const duplicates = new Set<string>()
    for (const { cells, row } of rowsOf(switchFile.fileName, switchFile.text, LINK_SWITCH_CSV_HEADER, issues)) {
      const record = Object.fromEntries(LINK_SWITCH_CSV_HEADER.split(',').map((key, index) => [key, cells[index]!])) as Record<string, string>
      const path = `rows[${row - 2}]`
      if (!scopeRowOk(record, scope)) { issue(issues, 'EVIDENCE_SCOPE_INVALID', switchFile.fileName, row, path, '任务标识或版本与当前运行不一致。'); continue }
      const time = requiredNumeric(record.Time), oldBer = requiredNumeric(record.OldBER), newBer = requiredNumeric(record.NewBER)
      if (time === null || time < 0 || (oldBer === null && record.OldBER !== CSV_NO_DATA) || (newBer === null && record.NewBER !== CSV_NO_DATA)) { issue(issues, 'EVIDENCE_NUMBER_INVALID', switchFile.fileName, row, path, '时刻或新旧误码率必须为有限数值。'); continue }
      if ((oldBer !== null && (oldBer < 0 || oldBer > 1)) || (newBer !== null && (newBer < 0 || newBer > 1))) { issue(issues, 'EVIDENCE_BER_RANGE_INVALID', switchFile.fileName, row, path, '误码率必须在 0 到 1 之间。'); continue }
      if ((record.Direction !== 'FORWARD' && record.Direction !== 'REVERSE') || (!linkTypes.has(record.OldLinkType!) && record.OldLinkType !== CSV_NO_DATA) || (!linkTypes.has(record.NewLinkType!) && record.NewLinkType !== CSV_NO_DATA) || !record.SwitchReason?.trim()) {
        issue(issues, 'EVIDENCE_SWITCH_ENUM_INVALID', switchFile.fileName, row, path, '方向、链路类型或切换原因无效。'); continue
      }
      const signature = JSON.stringify([time, record.SourcePlatform, record.DestPlatform, record.Direction, record.OldLinkType, record.NewLinkType, oldBer, newBer, record.SwitchReason])
      if (duplicates.has(signature)) { issue(issues, 'EVIDENCE_DUPLICATE_ROW', switchFile.fileName, row, path, '同一切换行重复出现。'); continue }
      duplicates.add(signature)
      switchRows.push({ time, sourcePlatform: record.SourcePlatform!, destPlatform: record.DestPlatform!, direction: record.Direction!, oldLinkType: record.OldLinkType!, newLinkType: record.NewLinkType!, oldBer, newBer, reason: record.SwitchReason! })
    }
    receipts.push({ fileName: switchFile.fileName, sha256: source.sha256(switchFile.text), rows: switchRows.length })
    warnings.push('switch 文件为实际切换记录，不代表闭环切换成功。')
  }

  // 跨文件冲突：同一链路、同一关联时刻的 GXB / BER / 接收功率必须一致，不择一覆盖。
  if (quality) {
    const index = new Map<string, QualitySampleLike>()
    for (const sample of quality.samples) index.set(`${sample.linkId}\u0000${sample.time}`, { gxb: sample.jsrDb, ber: sample.ber, receivedPower: sample.receivedPower })
    for (const row of state) {
      const other = index.get(`${row.linkId}\u0000${row.time}`)
      if (!other) continue
      const conflict = (row.gxbDb !== null && row.gxbDb !== other.gxb) || (row.ber !== null && row.ber !== other.ber) || (row.receivedPower !== null && row.receivedPower !== other.receivedPower)
      if (conflict) issue(issues, 'EVIDENCE_CROSS_FILE_CONFLICT', stateFile?.fileName ?? 'state', undefined, 'rows', `状态与质量文件在链路 ${row.linkId} ${row.time} 秒的测量值冲突。`)
    }
  }

  if (issues.length) throw new EvidenceImportError(issues)
  const ordered = receipts.slice().sort((left, right) => left.fileName.localeCompare(right.fileName))
  const result: EvidenceImportResult = {
    scope: { ...scope }, bundleSha256: source.sha256(evidenceBundlePayload(ordered)), association: 'USER_SELECTED_RUN',
    files: ordered, capabilities: EVIDENCE_FILE_KINDS.filter(kind => byKind.has(kind)), missing: EVIDENCE_FILE_KINDS.filter(kind => !byKind.has(kind)), warnings,
  }
  return { result, ...(quality ? { quality } : {}), state, loss, switch: switchRows }
}
interface QualitySampleLike { gxb: number; ber: number; receivedPower: number }

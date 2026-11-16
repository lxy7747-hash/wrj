import type { QualityScope } from '../../contracts/domain-models'

/**
 * 06/D2 独立文件集导入（本地扩展）。这里只定义本地请求/响应 DTO 与校验，
 * 不改冻结的 QualityDataset 强类型接口；旧 quality 端点仍按原合同工作。
 * 本模块浏览器安全：不引入 node:crypto，摘要由调用方（Node 侧）注入。
 */
export const EVIDENCE_FILE_KINDS = ['quality', 'state', 'loss', 'switch'] as const
export type EvidenceFileKind = typeof EVIDENCE_FILE_KINDS[number]

/** 每类文件仅允许一个规范文件名；文件名即类别，不接受任意路径。 */
export const EVIDENCE_KIND_FILE: Readonly<Record<EvidenceFileKind, string>> = {
  quality: 'link_quality.csv',
  state: 'link_state.csv',
  loss: 'link_loss.csv',
  switch: 'link_switch.csv',
}
export const EVIDENCE_ASSOCIATION = 'USER_SELECTED_RUN' as const
export type EvidenceAssociation = typeof EVIDENCE_ASSOCIATION
/** 8 MB 总请求上限（与 quality 端点一致）。 */
export const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024

export interface EvidenceImportFile { fileName: string; text: string }
export interface EvidenceImportRequest { files: EvidenceImportFile[] }
export interface EvidenceImportFileReceipt { fileName: string; sha256: string; rows: number }
export interface EvidenceImportResult {
  scope: QualityScope
  bundleSha256: string
  association: EvidenceAssociation
  files: EvidenceImportFileReceipt[]
  capabilities: EvidenceFileKind[]
  missing: EvidenceFileKind[]
  warnings: string[]
}

export interface EvidenceValidationIssue { severity: 'ERROR'; code: string; file: string; row?: number; fieldPath: string; message: string }

/** 文件集导入失败：逐文件、逐行、逐字段定位，供 HTTP 422 使用。 */
export class EvidenceImportError extends Error {
  readonly issues: EvidenceValidationIssue[]
  constructor(issues: EvidenceValidationIssue[]) {
    super(issues[0]?.message ?? '文件集不符合证据导入合同。')
    this.name = 'EvidenceImportError'
    this.issues = issues
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const kindForFile = (fileName: string): EvidenceFileKind | undefined =>
  EVIDENCE_FILE_KINDS.find(kind => EVIDENCE_KIND_FILE[kind] === fileName)

/** 校验请求外形：至少一份、最多四份、每类至多一份、文件名限定规范名、总字节 <= 8MB。 */
export function inspectEvidenceImportRequest(value: unknown): { request: EvidenceImportRequest } | { issues: EvidenceValidationIssue[] } {
  const issues: EvidenceValidationIssue[] = []
  if (!isObject(value) || Object.keys(value).length !== 1 || !Array.isArray(value.files)) {
    return { issues: [{ severity: 'ERROR', code: 'EVIDENCE_REQUEST_INVALID', file: 'request', fieldPath: 'request', message: '文件集请求必须只包含 files 数组。' }] }
  }
  const files = value.files
  if (files.length < 1 || files.length > 4) {
    return { issues: [{ severity: 'ERROR', code: 'EVIDENCE_FILES_COUNT_INVALID', file: 'request', fieldPath: 'files', message: '文件集必须包含 1 至 4 份文件。' }] }
  }
  const seenKinds = new Set<EvidenceFileKind>()
  const result: EvidenceImportFile[] = []
  let totalBytes = 0
  for (let index = 0; index < files.length; index += 1) {
    const item = files[index]
    const path = `files[${index}]`
    if (!isObject(item) || Object.keys(item).length !== 2 || typeof item.fileName !== 'string' || typeof item.text !== 'string') {
      issues.push({ severity: 'ERROR', code: 'EVIDENCE_FILE_SHAPE_INVALID', file: path, fieldPath: path, message: '每份文件必须只包含 fileName 与 text 两个字符串字段。' })
      continue
    }
    const kind = kindForFile(item.fileName)
    if (!kind) {
      issues.push({ severity: 'ERROR', code: 'EVIDENCE_FILE_NAME_INVALID', file: item.fileName, fieldPath: `${path}.fileName`, message: `文件名必须是 ${Object.values(EVIDENCE_KIND_FILE).join('、')} 之一。` })
      continue
    }
    if (seenKinds.has(kind)) {
      issues.push({ severity: 'ERROR', code: 'EVIDENCE_FILE_DUPLICATE', file: item.fileName, fieldPath: `${path}.fileName`, message: '同一类别最多提供一份文件。' })
      continue
    }
    seenKinds.add(kind)
    totalBytes += new TextEncoder().encode(item.text).byteLength
    result.push({ fileName: item.fileName, text: item.text })
  }
  if (totalBytes > EVIDENCE_MAX_BYTES) {
    issues.push({ severity: 'ERROR', code: 'EVIDENCE_FILES_TOO_LARGE', file: 'request', fieldPath: 'files', message: '文件集总大小不能超过 8 MB。' })
  }
  if (issues.length) return { issues }
  return { request: { files: result } }
}

/** 批次摘要的规范化载荷：按文件名排序后的「名称 + 原文摘要」，输入顺序不改变身份。 */
export function evidenceBundlePayload(files: ReadonlyArray<{ fileName: string; sha256: string }>): string {
  return JSON.stringify([...files].map(file => ({ fileName: file.fileName, sha256: file.sha256 })).sort((left, right) => left.fileName.localeCompare(right.fileName)))
}

/** 校验响应外形；供前端与旧 quality 消费者区分新 DTO。 */
export function isEvidenceImportResult(value: unknown): value is EvidenceImportResult {
  if (!isObject(value)) return false
  const keys = ['scope', 'bundleSha256', 'association', 'files', 'capabilities', 'missing', 'warnings']
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return false
  if (value.association !== EVIDENCE_ASSOCIATION) return false
  if (typeof value.bundleSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.bundleSha256)) return false
  if (!isObject(value.scope) || !Array.isArray(value.files) || !Array.isArray(value.capabilities) || !Array.isArray(value.missing) || !Array.isArray(value.warnings)) return false
  if (!value.warnings.every(item => typeof item === 'string')) return false
  if (!value.capabilities.every(kind => (EVIDENCE_FILE_KINDS as readonly string[]).includes(kind as string))) return false
  if (!value.missing.every(kind => (EVIDENCE_FILE_KINDS as readonly string[]).includes(kind as string))) return false
  return value.files.every(file => isObject(file) && typeof file.fileName === 'string'
    && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(file.sha256)
    && Number.isSafeInteger(file.rows) && (file.rows as number) >= 0)
}

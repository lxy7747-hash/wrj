import type { ContractDescriptor } from '../../contracts/domain-models'

export type CsvErrorCode = 'HEADER_INVALID' | 'TYPE_INVALID' | 'ENCODING_INVALID'

export interface CsvValidationIssue {
  code: CsvErrorCode
  row: number
  fieldPath: string
  message: string
}

export interface CsvValidationResult {
  valid: boolean
  contractName: string
  rowCount: number
  encoding: 'UTF-8'
  headerMatched: boolean
  atomicWrite: 'NOT_EXECUTED_BY_DESIGN'
  issues: CsvValidationIssue[]
}

const NUMERIC_FIELDS = new Set([
  'Time', 'Frequency', 'Bandwidth', 'Distance', 'TxPower', 'TxAntennaGain', 'RxAntennaGain',
  'PathLoss', 'JammingPower', 'ReceivedPower', 'SNR', 'BER', 'BERThreshold', 'DataRate', 'Power',
  'OldBER', 'NewBER',
])
const NON_NEGATIVE_FIELDS = new Set(['Time', 'Distance', 'TxPower', 'DataRate', 'Power'])
const POSITIVE_FIELDS = new Set(['Frequency', 'Bandwidth'])
const RATIO_FIELDS = new Set(['BER', 'BERThreshold', 'OldBER', 'NewBER'])
const OPTIONAL_EVENT_FIELDS = new Set(['TargetPlatform', 'Power', 'Frequency', 'Bandwidth', 'Parameters'])

/**
 * 解析一条逗号分隔记录。
 * @param line 单行 CSV 文本。
 * @returns 单元格列表；双引号未闭合时返回 `undefined`。
 * @remarks ponytail: 当前合同不允许字段内换行；出现多行字段时再替换为流式 RFC 4180 解析器。
 */
function parseCsvLine(line: string): string[] | undefined {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      cells.push(cell)
      cell = ''
    } else {
      cell += character
    }
  }
  if (quoted) return undefined
  cells.push(cell)
  return cells
}

/** 返回字段是否允许空值。 */
function isOptionalField(contractName: string, field: string): boolean {
  return contractName === 'events.csv' && OPTIONAL_EVENT_FIELDS.has(field)
}

/** 返回字段值是否符合 canonical CSV 的基本类型和枚举。 */
function isValidField(field: string, value: string): boolean {
  if (NUMERIC_FIELDS.has(field)) {
    if (value.trim() === '') return false
    const number = Number(value)
    if (!Number.isFinite(number)) return false
    if (NON_NEGATIVE_FIELDS.has(field)) return number >= 0
    if (POSITIVE_FIELDS.has(field)) return number > 0
    if (RATIO_FIELDS.has(field)) return number >= 0 && number <= 1
    return true
  }
  if (field === 'LinkType' || field === 'OldLinkType' || field === 'NewLinkType') {
    return ['SAT', 'MICROWAVE', 'DATALINK', 'LASER'].includes(value)
  }
  if (field === 'LinkStatus') return value === 'UP' || value === 'DOWN'
  if (field === 'Direction') return value === 'FORWARD' || value === 'REVERSE'
  if (field === 'Modulation') return value === 'BPSK' || value === 'QPSK'
  return value.trim().length > 0
}

/**
 * 校验内存中的 canonical CSV 文本。
 * @param contract 从本机 Mock 加载的 CSV 字段合同。
 * @param text 待校验文本，不代表外部文件内容。
 * @returns 表头、数据类型、行号和原子写入边界结果。
 */
export function inspectCsvText(contract: ContractDescriptor, text: string): CsvValidationResult {
  const result: CsvValidationResult = {
    valid: false,
    contractName: contract.name,
    rowCount: 0,
    encoding: 'UTF-8',
    headerMatched: false,
    atomicWrite: 'NOT_EXECUTED_BY_DESIGN',
    issues: [],
  }
  if (text.includes('\uFFFD')) {
    result.issues.push({ code: 'ENCODING_INVALID', row: 1, fieldPath: 'encoding', message: '文本包含无效的 UTF-8 替换字符。' })
    return result
  }

  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.at(-1)?.trim() === '') lines.pop()
  const header = lines.shift()
  if (header === undefined || header !== contract.fields.join(',')) {
    result.issues.push({ code: 'HEADER_INVALID', row: 1, fieldPath: 'header', message: 'CSV 表头名称或顺序与合同不一致。' })
    return result
  }
  result.headerMatched = true

  lines.forEach((line, rowIndex) => {
    const row = rowIndex + 2
    const cells = parseCsvLine(line)
    if (cells === undefined || cells.length !== contract.fields.length) {
      result.issues.push({ code: 'TYPE_INVALID', row, fieldPath: `rows[${rowIndex}]`, message: `第 ${row} 行列数或引号格式不正确。` })
      return
    }
    cells.forEach((value, columnIndex) => {
      const field = contract.fields[columnIndex] ?? `column${columnIndex + 1}`
      if (value.trim() === '' && isOptionalField(contract.name, field)) return
      if (!isValidField(field, value)) {
        result.issues.push({ code: 'TYPE_INVALID', row, fieldPath: `rows[${rowIndex}].${field}`, message: `第 ${row} 行字段 ${field} 的类型或取值不正确。` })
      }
    })
  })
  result.rowCount = lines.length
  result.valid = result.issues.length === 0
  return result
}

/** 将示例值转义为单行 CSV 单元格。 */
function escapeCell(value: string): string {
  return value.includes(',') || value.includes('"') ? `"${value.replaceAll('"', '""')}"` : value
}

/** 按字段名生成不依赖运行时数据的合同示例值。 */
function exampleValue(field: string): string {
  if (field === 'Time') return '42'
  if (field === 'LinkType' || field === 'OldLinkType' || field === 'NewLinkType') return 'MICROWAVE'
  if (field === 'LinkStatus') return 'UP'
  if (field === 'Direction') return 'FORWARD'
  if (field === 'Modulation') return 'QPSK'
  if (field === 'EventType') return 'DETECTION'
  if (field === 'Parameters') return '{"sensorId":"ESM-01"}'
  if (field.includes('Platform')) return field.startsWith('Dest') || field.startsWith('Target') ? 'GCC-01' : 'UAV-01'
  if (NUMERIC_FIELDS.has(field)) return field.includes('BER') ? '0.000001' : '1'
  if (field === 'Status') return 'SUCCESS'
  if (field === 'SwitchReason') return 'BER_THRESHOLD_AND_HYSTERESIS'
  return '示例值'
}

/**
 * 生成一行可直接校验的内存 CSV 示例。
 * @param contract CSV 字段合同。
 * @returns canonical 表头和一条示例记录。
 */
export function createCsvExample(contract: ContractDescriptor): string {
  return `${contract.fields.join(',')}\n${contract.fields.map((field) => escapeCell(exampleValue(field))).join(',')}`
}

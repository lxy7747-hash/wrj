import type { AfsimLogEvent } from '../../src/features/data-exchange/afsim-event-log.js'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log.js'
import { parseCsvLine } from '../../src/features/data-exchange/csv-contract.js'

export const MAX_PENDING_EVENT_BYTES = 128 * 1024
export const DECLARATION_LIMIT_BYTES = 256 * 1024

export function splitCompleteLines(value: string): { lines: string[]; pending: string } {
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
export class IncrementalEventDecoder {
  private declarations = ''
  private readonly csvDeclarations = new Map<string, string>()
  private sourceLine = 0
  private block: string[] = []
  private blockBytes = 0
  private blockStart = 0
  get isCsv(): boolean { return this.csvDeclarations.size > 0 }

  isTruncatedTail(line: string, reason: string): boolean {
    const cells = parseCsvLine(line)
    if (!cells) return reason.includes('CSV 引号未闭合')
    if (cells.length === 1) return /^\s*\d[\d.eE+-]*\s*$/.test(line)
    const declaration = this.csvDeclarations.get(cells[1]?.trim() ?? '')
    const missing = /事件缺少字段 (\w+)/.exec(reason)?.[1]
    if (!declaration || !missing) return false
    const aliases: Record<string, string> = { Size: 'message_size', Number: 'message_serial_number', DataTag: 'data_tag',
      System: cells[1]?.trim() === 'MESSAGE_HOP' ? 'receiver_system' : 'comm', Type: 'message_type' }
    const columns = parseCsvLine(declaration)!.slice(1).map(column => column.trim().replace(/<[^<>]+>$/, ''))
    if (columns[0] !== 'time') columns.unshift('time', 'event')
    const index = columns.findIndex(column => column === (aliases[missing] ?? missing.toLowerCase()))
    // 已存在但为空的必填列仍属坏数据；只接受尚未写到必填列的尾部截断。
    return index >= cells.length
  }

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

  read(line: string, options?: { includeTypes?: ReadonlySet<string>; onSkippedTime?: (timeS: number) => void }): AfsimLogEvent[] {
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
      const cells = parseCsvLine(line)
      const type = cells?.[1]?.trim() ?? ''
      const declaration = this.csvDeclarations.get(type)
      if (options?.includeTypes && declaration && !options.includeTypes.has(type)) {
        const time = Number(cells?.[0])
        if (Number.isFinite(time) && time >= 0) options.onSkippedTime?.(time)
        return prior
      }
      return [...prior, ...this.parse(`${declaration ?? ''}\n${line}`, this.sourceLine, this.sourceLine)]
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
      if (this.blockBytes > MAX_PENDING_EVENT_BYTES) throw new Error('scenario_events.csv 原生事件块超过128KiB受保护上限。')
      this.block.push(line)
      return []
    }
    throw new Error(`scenario_events.csv 第 ${this.sourceLine} 行不是完整事件块。`)
  }

  close(): AfsimLogEvent[] { return this.flushBlock() }
}

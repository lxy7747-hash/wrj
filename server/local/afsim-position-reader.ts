import { open, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { parseCsvLine } from '../../src/features/data-exchange/csv-contract.js'
import { POSITION_HEADER, parsePositionLine, positionOrderIssue, type PositionSnapshot, type PositionUpdate } from '../../src/features/situation/position-updates.js'

const CHUNK_BYTES = 1024 * 1024
const MAX_LINE_BYTES = 8192

/**
 * 创建只读的追加文件读取器；同一实例共享字节游标，多客户端并发读取合并为一次。
 * @param inputPath 本机环境配置的文件路径，不接受浏览器指定路径。
 * @returns 按需读取新增完整行，返回各节点最新状态的方法；文件替换或截断后自动重新读取。
 */
export function createPositionReader(inputPath: string): () => Promise<PositionSnapshot> {
  const filePath = resolve(inputPath)
  let identity = ''
  let offset = 0
  let anchor = Buffer.alloc(0)
  let pending = Buffer.alloc(0)
  let lineNumber = 0
  let generation = 0
  let recordCount = 0
  let issueCount = 0
  let issues: PositionSnapshot['issues'] = []
  let nodes = new Map<string, PositionUpdate>()
  let inFlight: Promise<PositionSnapshot> | null = null

  /** 读取一个有大小上限的增量；只在完整读取和解析成功后提交游标，失败保留上次状态。 */
  async function readNext(): Promise<PositionSnapshot> {
    const file = await open(filePath, 'r')
    try {
      const before = await file.stat()
      if (!before.isFile()) throw new Error('位置来源必须为普通文件。')
      const nextIdentity = `${before.dev}:${before.ino}:${before.birthtimeMs}`
      let reset = identity !== nextIdentity || before.size < offset
      if (!reset && anchor.length > 0) {
        const check = Buffer.alloc(anchor.length)
        const { bytesRead } = await file.read(check, 0, check.length, offset - anchor.length)
        // ponytail: 用游标前 64 字节识别截断后迅速长大的文件；不扫描全部历史来检测任意原地改写。
        reset = bytesRead !== anchor.length || !check.equals(anchor)
      }
      const start = reset ? 0 : offset
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, before.size - start))
      let readBytes = 0
      while (readBytes < chunk.length) {
        const { bytesRead } = await file.read(chunk, readBytes, chunk.length - readBytes, start + readBytes)
        if (bytesRead === 0) throw new Error('位置文件正在重建，请重试。')
        readBytes += bytesRead
      }
      const after = await stat(filePath)
      // Windows 的路径 stat 可能返回 dev=0，只有两侧均提供设备号时才能比较。
      if ((after.dev !== 0 && before.dev !== 0 && after.dev !== before.dev)
        || after.ino !== before.ino || after.size < before.size
        || after.birthtimeMs !== before.birthtimeMs) throw new Error('位置文件正在替换，请重试。')

      const combined = Buffer.concat([reset ? Buffer.alloc(0) : pending, chunk])
      const end = combined.lastIndexOf(10) + 1
      const nextPending = combined.subarray(end)
      if (nextPending.length > MAX_LINE_BYTES) throw new Error('位置文件存在过长或缺少换行的记录。')
      const nextNodes = reset ? new Map<string, PositionUpdate>() : new Map(nodes)
      let nextLine = reset ? 0 : lineNumber
      let nextCount = reset ? 0 : recordCount
      let nextIssueCount = reset ? 0 : issueCount
      const nextIssues = reset ? [] : [...issues]
      const lines = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(combined.subarray(0, end)).split('\n').slice(0, -1)
      for (const raw of lines) {
        nextLine += 1
        let line = raw.replace(/\r$/, '')
        if (nextLine === 1) {
          line = line.replace(/^\uFEFF/, '')
          if (parseCsvLine(line)?.map((cell) => cell.trim()).join(',') !== POSITION_HEADER) {
            throw new Error('位置文件表头必须为 TIME,NAME,LON,LAT,ALT,SPEED,HEADING。')
          }
          continue
        }
        if (line.trim() === '') continue
        const update = Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES ? parsePositionLine(line) : null
        let message = ''
        if (!update) message = '位置记录字段或数值无效，已跳过。'
        else {
          const previous = nextNodes.get(update.platformId)
          message = positionOrderIssue(previous, update)
          if (!message) {
            nextNodes.set(update.platformId, update)
            nextCount += 1
          }
        }
        if (message) {
          nextIssueCount += 1
          // 只保留最近 20 条行号提示，避免长期运行时随文件无限增长。
          nextIssues.push({ line: nextLine, message })
          if (nextIssues.length > 20) nextIssues.shift()
        }
        if (nextNodes.size > 10_000) throw new Error('位置文件节点数量超过读取上限。')
      }
      const nextOffset = start + readBytes
      const nextAnchor = Buffer.alloc(Math.min(64, nextOffset))
      if (nextAnchor.length > 0) {
        const result = await file.read(nextAnchor, 0, nextAnchor.length, nextOffset - nextAnchor.length)
        if (result.bytesRead !== nextAnchor.length) throw new Error('位置文件正在重建，请重试。')
      }
      identity = nextIdentity
      offset = nextOffset
      anchor = nextAnchor
      pending = Buffer.from(nextPending)
      lineNumber = nextLine
      if (reset) generation += 1
      nodes = nextNodes
      recordCount = nextCount
      issueCount = nextIssueCount
      issues = nextIssues
      return {
        fileName: basename(filePath), generation, nodes: [...nodes.values()], recordCount, issueCount,
        issues: [...issues], waitingForLine: pending.length > 0, hasMore: after.size > offset,
      }
    } finally {
      await file.close()
    }
  }

  return () => {
    inFlight ??= readNext().finally(() => { inFlight = null })
    return inFlight
  }
}

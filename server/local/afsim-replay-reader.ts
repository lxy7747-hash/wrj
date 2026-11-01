import { parseCsvLine } from '../../src/features/data-exchange/csv-contract.js'
import { POSITION_HEADER, parsePositionLine, positionOrderIssue, type PositionUpdate } from '../../src/features/situation/position-updates.js'
import type { LocalReplaySnapshot } from '../../src/features/replays/local-replay.js'
import { readInitialNodes, readStableUtf8Lines } from './afsim-log-reader.js'

// 快照要能通过 JSON 接口完整回放，因此位置记录数设有明确上限而非无限堆积。
// 此上限约覆盖 50 个节点以 1 Hz 运行 5.5 小时；超过时保留原始 CSV 和摘要，但拒绝发布假完整快照。
const MAX_REPLAY_POSITION_RECORDS = 1_000_000

/**
 * 加载两份真实文件的当前只读快照，生成按节点分组的完整位置历史，不修改实时追加游标。
 * @param initialPath 初始化日志的本机路径。
 * @param positionPath 持续追加位置 CSV 的本机路径；未配置时拒绝回退 Mock。
 */
export async function readLocalReplay(initialPath: string, positionPath: string | undefined, completed = false): Promise<LocalReplaySnapshot> {
  if (!positionPath) throw new Error('尚未配置位置文件。')
  const initial = await readInitialNodes(initialPath)
  const nodes = new Map(initial.nodes.map((node) => [node.platformId, node]))
  const tracks = new Map<string, PositionUpdate[]>()
  let issueCount = 0
  let recordCount = 0
  let durationS = 0
  for (const node of initial.nodes) durationS = Math.max(durationS, node.time)
  for (const record of initial.connections ?? []) durationS = Math.max(durationS, record.time)
  for (const event of initial.deviceEvents ?? []) durationS = Math.max(durationS, event.time)
  // 平台删除时刻必须与 isLocalReplaySnapshot 的口径一致，否则真实回放会被自身校验拒绝。
  for (const deletion of initial.platformDeletions ?? []) durationS = Math.max(durationS, deletion.time)
  const issues: LocalReplaySnapshot['issues'] = []
  let headerSeen = false
  const file = await readStableUtf8Lines(positionPath, (line, lineNumber) => {
    if (!headerSeen) {
      if (!line.trim() && !completed) return
      if (parseCsvLine(line.trim())?.map((cell) => cell.trim()).join(',') !== POSITION_HEADER) throw new Error('位置文件表头不正确。')
      headerSeen = true
      return
    }
    if (!line.trim()) return
    const update = Buffer.byteLength(line, 'utf8') <= 8192 ? parsePositionLine(line) : null
    const node = update ? nodes.get(update.platformId) : undefined
    const positions = update ? tracks.get(update.platformId) ?? [] : []
    const previous = positions.at(-1)
    const message = !update ? '位置记录字段或数值无效，已跳过。'
      : !node ? '节点未在初始化日志中登记，已跳过。'
        : update.time < node.time ? '记录早于节点初始时刻，已跳过。' : positionOrderIssue(previous, update)
    if (message) {
      issueCount += 1
      issues.push({ line: lineNumber, message })
      if (issues.length > 20) issues.shift()
      return
    }
    if (!update || previous?.time === update.time) return
    if (recordCount >= MAX_REPLAY_POSITION_RECORDS) throw new Error(`位置记录超过完整回放快照上限 ${MAX_REPLAY_POSITION_RECORDS} 条，拒绝截断发布。`)
    positions.push(update)
    tracks.set(update.platformId, positions)
    recordCount += 1
    durationS = Math.max(durationS, update.time)
  })
  if (completed && !headerSeen) throw new Error('已完成运行的位置文件表头不正确。')
  if (completed && recordCount === 0) throw new Error('已完成运行的位置文件没有通过节点关联校验的有效位置记录。')
  return {
    initial, fileName: file.source.fileName, sha256: file.source.sha256, durationS, recordCount,
    tracks: [...tracks].map(([platformId, positions]) => ({ platformId, positions })),
    issueCount, issues, waitingForLine: file.waitingForLine,
    ...(initial.messageDetailsComplete === false ? { messageDetailsComplete: false, messageDetailEventCount: initial.messageDetailEventCount } : {}),
  }
}

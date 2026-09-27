import { parseCsvLine } from '../../src/features/data-exchange/csv-contract.js'
import { POSITION_HEADER, parsePositionLine, positionOrderIssue, type PositionUpdate } from '../../src/features/situation/position-updates.js'
import type { LocalReplaySnapshot } from '../../src/features/replays/local-replay.js'
import { readInitialNodes, readLocalFileSnapshot } from './afsim-log-reader.js'

/**
 * 加载两份真实文件的当前只读快照，生成按节点分组的完整位置历史，不修改实时追加游标。
 * @param initialPath 初始化日志的本机路径。
 * @param positionPath 持续追加位置 CSV 的本机路径；未配置时拒绝回退 Mock。
 */
export async function readLocalReplay(initialPath: string, positionPath: string | undefined): Promise<LocalReplaySnapshot> {
  if (!positionPath) throw new Error('尚未配置位置文件。')
  const [initial, file] = await Promise.all([readInitialNodes(initialPath), readLocalFileSnapshot(positionPath)])
  const end = file.bytes.lastIndexOf(10) + 1
  // 完整换行以前才是已提交记录，尾部即使截在 UTF-8 字符中间也留待下次加载。
  const text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes.subarray(0, end))
  const lines = text.split('\n').slice(0, -1)
  if (lines.length && parseCsvLine(lines[0]!.trim())?.map((cell) => cell.trim()).join(',') !== POSITION_HEADER) {
    throw new Error('位置文件表头不正确。')
  }
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
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\r$/, '')
    if (!line.trim()) continue
    const update = Buffer.byteLength(line, 'utf8') <= 8192 ? parsePositionLine(line) : null
    const node = update ? nodes.get(update.platformId) : undefined
    const positions = update ? tracks.get(update.platformId) ?? [] : []
    const previous = positions.at(-1)
    const message = !update ? '位置记录字段或数值无效，已跳过。'
      : !node ? '节点未在初始化日志中登记，已跳过。'
        : update.time < node.time ? '记录早于节点初始时刻，已跳过。' : positionOrderIssue(previous, update)
    if (message) {
      issueCount += 1
      issues.push({ line: index + 1, message })
      if (issues.length > 20) issues.shift()
      continue
    }
    if (!update || previous?.time === update.time) continue
    positions.push(update)
    tracks.set(update.platformId, positions)
    recordCount += 1
    durationS = Math.max(durationS, update.time)
  }
  return {
    initial, fileName: file.source.fileName, sha256: file.source.sha256, durationS, recordCount,
    tracks: [...tracks].map(([platformId, positions]) => ({ platformId, positions })),
    issueCount, issues, waitingForLine: end < file.bytes.length,
  }
}

import { stat } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { readLocalReplay } from '../server/local/afsim-replay-reader.js'
import { readLocalReport } from '../server/local/report-file.js'
import { isLocalReplaySnapshot } from '../src/features/replays/local-replay.js'
import { isLocalReport } from '../src/features/reports/local-report.js'

// 只读复验指定快照，不启动引擎、不访问业务库；耗时不是实时求解或持续写入吞吐量。
const [eventPath, positionPath] = process.argv.slice(2)
if (!eventPath || !positionPath) throw new Error('请依次提供事件 CSV 和位置 CSV 路径。')
const timings: number[] = []
let summary: unknown
let source: string | undefined
for (let iteration = 0; iteration < 5; iteration++) {
  const started = performance.now()
  const replay = await readLocalReplay(eventPath, positionPath)
  const report = await readLocalReport(eventPath, positionPath)
  if (!isLocalReplaySnapshot(replay) || !report || !isLocalReport(report)) throw new Error('正式读取入口未通过消费合同。')
  const evidence = report.localEvidence
  const fingerprint = `${replay.initial.sha256}:${replay.sha256}`
  if (evidence.eventFile.sha256 !== replay.initial.sha256 || evidence.positionFile.sha256 !== replay.sha256
    || evidence.positionCount !== replay.recordCount || (source !== undefined && source !== fingerprint)) throw new Error('回放／报告跨来源或文件在复验期间变化。')
  source = fingerprint
  timings.push(Math.round((performance.now() - started) * 100) / 100)
  summary = { source, nodes: replay.initial.nodes.length, positionCount: replay.recordCount, positionIssues: replay.issueCount,
    duration: `${Math.floor(replay.durationS / 60)}分${Number((replay.durationS % 60).toFixed(3))}秒`,
    eventCount: evidence.eventCount, eventWarnings: evidence.eventWarningCount, eventCounts: evidence.eventCounts,
    connections: evidence.connections.length, deviceEvents: evidence.deviceEvents.length, qualitySamples: '该本地报告未提供质量测量序列；不推断 SNR/BER' }
}
const bytes = (await stat(eventPath)).size + (await stat(positionPath)).size
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), result: 'PASS', scope: '5 次正式读取与同源闭合；非持续吞吐／引擎验收',
  environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramGiB: Math.round(totalmem() / 1024 ** 3) },
  bytes, timingsMs: timings, peakRssKiB: process.resourceUsage().maxRSS, summary }, null, 2))

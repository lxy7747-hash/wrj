import { describe, expect, it } from 'vitest'
import type { LocalReportEvidence, QualityDataset, Report } from '../../src/contracts/domain-models'
import { isLocalReport, localReportTables } from '../../src/features/reports/local-report'
import { attachQualityReport, qualityReportView } from '../../src/features/reports/quality-report'

const evidence: LocalReportEvidence = {
  eventFile: { fileName: 'events.csv', sha256: 'a'.repeat(64) }, positionFile: { fileName: 'positions.csv', sha256: 'b'.repeat(64) },
  startTimeS: 0, endTimeS: 50, simulationComplete: true, positionCount: 1, positionIssueCount: 0, waitingForPositionLine: false,
  eventCount: 1, eventWarningCount: 0, nodes: [{ platformId: 'A', name: '甲', type: 'UAV', side: 'blue', positionCount: 1, firstTimeS: 0, lastTimeS: 0 }, { platformId: 'B', name: '乙', type: 'UAV', side: 'blue', positionCount: 0, firstTimeS: 0, lastTimeS: 0 }],
  eventCounts: [{ type: 'SIMULATION_COMPLETE', count: 1 }], connections: [], deviceEvents: [],
}
const sample = (frameId: number, time: number, linkStatus: 'UP' | 'DOWN', jsrDb: number, ber: number, interferenceActive?: boolean) => ({
  time, sourcePlatform: 'A', destPlatform: 'B', linkType: 'MICROWAVE' as const, frequency: 8000, bandwidth: 20, distance: 1000,
  txPower: 10, txAntennaGain: 1, rxAntennaGain: 1, pathLoss: 100, jammingPower: -90, receivedPower: -70, snr: 12,
  modulation: 'QPSK' as const, ber, linkStatus, berThreshold: 0.01, dataRate: 10, jsrDb, linkId: 'L-1', frameId,
  ...(interferenceActive === undefined ? {} : { interferenceActive }),
})
const dataset = (includeInterference = true): QualityDataset => ({
  schemaVersion: '1.0', scope: { taskId: 'TASK-1', runId: 'RUN-1', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' },
  source: { kind: 'FILE_IMPORT', fileName: 'quality.csv', sha256: 'c'.repeat(64), importedAt: '2026-01-01T00:01:00.000Z', frameIdKind: 'PROVIDED' }, expectedStepS: 10,
  samples: [sample(0, 0, 'UP', 10, 0.1, includeInterference ? true : undefined), sample(1, 10, 'UP', 20, 0.2, includeInterference ? true : undefined), sample(3, 30, 'UP', 30, 0.3, includeInterference ? true : undefined), sample(4, 40, 'DOWN', 40, 0.4, includeInterference ? false : undefined)], switchEvents: [],
})
const switchEvent = (eventId: string, decision: 'ACCEPTED' | 'REJECTED') => ({ eventId, frameId: 'F-0' as const, time: 0, type: 'LINK_SWITCH' as const, direction: 'FORWARD' as const,
  oldLinkId: 'L-1', newLinkId: 'L-2', oldBer: 0.1, newBer: 0.2, stabilityFrames: 2, minimumStableFrames: 2, hysteresisSatisfied: true, cooldownRemainingS: 0,
  decision, reason: decision === 'ACCEPTED' ? 'QUALITY_IMPROVED' : 'HYSTERESIS_NOT_MET', dedupeKey: `switch-${eventId}` })
const report = (): Report => ({ reportId: `RPT-LOCAL-${'d'.repeat(64)}`, classification: 'LEVEL_II', generatedTime: '2026-01-01T00:02:00.000Z', status: 'READY', localEvidence: evidence })

describe('导入质量报告投影', () => {
  it('按时间裁剪连续观测，跳过帧和采样间隔缺口均不外推', () => {
    const view = qualityReportView(dataset(), evidence, { from: 5, to: 25 })
    expect(view.samples.map(item => item.frameId)).toEqual([1])
    expect(view.kpis).toEqual({ averageConnectedDurationS: 5, averageJsrDb: 20, averageBer: 0.2, jammingDurationS: 5 })
  })

  it('只对来源明确给出的干扰活动状态计算时长，缺失时保持缺测', () => {
    const view = qualityReportView(dataset(false), evidence)
    expect(view.kpis.jammingDurationS).toBeUndefined()
    expect(view.kpis.averageConnectedDurationS).toBe(10)
  })

  it('按左侧离散帧状态累计到下一连续帧：状态切换、裁剪和全断链均不外推', () => {
    const source = dataset()
    source.expectedStepS = 1
    source.samples = [sample(0, 0, 'UP', 10, 0.1, true), sample(1, 1, 'UP', 20, 0.2, false), sample(2, 2, 'DOWN', 30, 0.3, false)]
    const full = qualityReportView(source, evidence)
    expect(full.kpis).toMatchObject({ averageConnectedDurationS: 2, jammingDurationS: 1 })
    expect(qualityReportView(source, evidence, { from: 0.5, to: 1.5 }).kpis).toMatchObject({ averageConnectedDurationS: 1, jammingDurationS: 0.5 })
    source.samples = [sample(0, 0, 'DOWN', 10, 0.1), sample(1, 1, 'DOWN', 20, 0.2)]
    const down = qualityReportView(source, evidence)
    expect(down.kpis.averageConnectedDurationS).toBe(0)
    expect(down.kpis.jammingDurationS).toBeUndefined()
  })

  it('不让范围外的干扰标记为选中范围的未知区间确认零时长', () => {
    const source = dataset()
    source.expectedStepS = 1
    source.samples = [sample(0, 0, 'UP', 10, 0.1), sample(1, 1, 'UP', 20, 0.2), sample(2, 10, 'UP', 30, 0.3, true), sample(3, 11, 'UP', 40, 0.4, true)]
    expect(qualityReportView(source, evidence, { from: 0, to: 1 }).kpis.jammingDurationS).toBeUndefined()
  })

  it('同一筛选范围中只要存在未标记的有效区间，干扰时长即保持缺测', () => {
    const source = dataset(); source.expectedStepS = 1
    source.samples = [sample(0, 0, 'UP', 10, 0.1, false), sample(1, 1, 'UP', 20, 0.2), sample(2, 2, 'UP', 30, 0.3, true), sample(3, 3, 'UP', 40, 0.4, false)]
    expect(qualityReportView(source, evidence).kpis.jammingDurationS).toBeUndefined()
  })

  it('按链路分组曲线，筛选后的图表与测量表使用同一范围', () => {
    const source = dataset()
    source.expectedStepS = 1
    source.samples = [sample(0, 0, 'UP', 10, 0.1), sample(1, 1, 'UP', 20, 0.2),
      { ...sample(2, 5, 'UP', 30, 0.3), linkId: 'L-2', sourcePlatform: 'B', destPlatform: 'A' },
      { ...sample(3, 6, 'UP', 40, 0.4), linkId: 'L-2', sourcePlatform: 'B', destPlatform: 'A' }]
    const view = qualityReportView(source, evidence, { from: 0, to: 5 })
    expect(view.series.map(series => [series.linkId, series.gxbCurve.length])).toEqual([['L-1', 2], ['L-2', 1]])
    const attached = attachQualityReport(report(), source, { from: 0, to: 5 })
    expect(localReportTables(attached.localEvidence!).find(table => table.title === '链路质量测量')?.rows).toHaveLength(3)
  })

  it('只将源文件明确接受的切换事件计为切换次数，并导出决策与原因', async () => {
    const source = dataset()
    source.expectedStepS = 1
    source.samples = [sample(0, 0, 'UP', 10, 0.1), { ...sample(0, 0, 'UP', 20, 0.2), linkId: 'L-2', sourcePlatform: 'B', destPlatform: 'A' },
      sample(1, 1, 'UP', 11, 0.1), { ...sample(1, 1, 'UP', 21, 0.2), linkId: 'L-2', sourcePlatform: 'B', destPlatform: 'A' }]
    source.switchEvents = [switchEvent('SW-ACCEPT', 'ACCEPTED'), switchEvent('SW-REJECT', 'REJECTED')]
    const attached = attachQualityReport(report(), source)
    const summary = new Map(localReportTables(attached.localEvidence!)[0]!.rows.map(([label, value]) => [label, value]))
    expect(summary.get('切换次数')).toBe('1')
    const switches = localReportTables(attached.localEvidence!).find(table => table.title === '质量源文件切换事件')!
    expect(switches.rows.map(row => row.slice(-2))).toEqual([['接受', 'QUALITY_IMPROVED'], ['拒绝', 'HYSTERESIS_NOT_MET']])
    const singleLink = attachQualityReport(report(), source, { linkId: 'L-1' })
    expect(singleLink.localEvidence?.quality?.samples.every(item => item.linkId === 'L-1')).toBe(true)
    expect(singleLink.localEvidence?.quality?.switchEvents.some(item => item.decision === 'ACCEPTED')).toBe(true)
    const { mkdtemp, readFile, rm } = await import('node:' + 'fs/promises')
    const { tmpdir } = await import('node:' + 'os')
    const { join } = await import('node:' + 'path')
    const { exportLocalReport } = await import('../../server/local/' + 'report-file.js')
    const directory = await mkdtemp(join(tmpdir(), 'wrj-quality-switch-'))
    try { expect(await readFile((await exportLocalReport(directory, attached, 'CSV', 'operator')).filePath, 'utf8')).toContain('HYSTERESIS_NOT_MET') } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('区分未提供的切换事件集合和明确提供的空集合', () => {
    const absent = attachQualityReport(report(), dataset())
    const explicit = dataset(); explicit.source.switchEventsProvided = true
    const provided = attachQualityReport(report(), explicit)
    const summary = (value: Report) => new Map(localReportTables(value.localEvidence!)[0]!.rows.map(([label, result]) => [label, result]))
    expect(summary(absent).get('切换次数')).toBe('暂无数据')
    expect(summary(provided).get('切换次数')).toBe('0')
  })

  it('质量报告编号绑定来源摘要，且雷达数据只使用连续有效观测区间', async () => {
    const source = dataset(); source.expectedStepS = 1
    source.samples = [
      { ...sample(0, 0, 'UP', 10, 0.1), linkId: 'L-1' }, { ...sample(0, 0, 'DOWN', 10, 0.1), linkId: 'L-2' }, { ...sample(0, 0, 'UP', 10, 0.1), linkId: 'L-3' },
      { ...sample(1, 1, 'UP', 10, 0.1), linkId: 'L-1' }, { ...sample(1, 1, 'UP', 10, 0.1), linkId: 'L-2' }, { ...sample(1, 1, 'UP', 10, 0.1), linkId: 'L-3' },
      { ...sample(3, 3, 'UP', 10, 0.1), linkId: 'L-3' },
    ]
    const attached = attachQualityReport(report(), source)
    expect(attached.reportId).toBe(`RPT-LOCAL-${'d'.repeat(64)}-Q-${'c'.repeat(64)}`)
    expect(qualityReportView(source, evidence).connectivityRates).toEqual([{ linkId: 'L-1', value: 100 }, { linkId: 'L-2', value: 0 }, { linkId: 'L-3', value: 100 }])
    const changed = structuredClone(source); changed.source.sha256 = 'e'.repeat(64)
    expect(attachQualityReport(report(), changed).reportId).not.toBe(attached.reportId)
    const tampered = structuredClone(attached); tampered.localEvidence!.quality!.source.sha256 = 'e'.repeat(64)
    expect(isLocalReport(tampered)).toBe(false)
    const { mkdtemp, readFile, rm } = await import('node:' + 'fs/promises'); const { tmpdir } = await import('node:' + 'os'); const { join } = await import('node:' + 'path'); const { exportLocalReport } = await import('../../server/local/' + 'report-file.js')
    const directory = await mkdtemp(join(tmpdir(), 'wrj-quality-radar-'))
    try { expect(await readFile((await exportLocalReport(directory, attached, 'HTML', 'operator')).filePath, 'utf8')).toContain('各链路有效观测区间连通率') } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('非采样边界筛选保留裁剪后的连通率证据，但测量表绝不泄漏范围外样本', async () => {
    const source = dataset(); source.expectedStepS = 1
    source.samples = [
      { ...sample(0, 0, 'UP', 10, 0.1), linkId: 'L-1' }, { ...sample(0, 0, 'DOWN', 10, 0.1), linkId: 'L-2' }, { ...sample(0, 0, 'UP', 10, 0.1), linkId: 'L-3' },
      { ...sample(1, 1, 'UP', 10, 0.1), linkId: 'L-1' }, { ...sample(1, 1, 'UP', 10, 0.1), linkId: 'L-2' }, { ...sample(1, 1, 'UP', 10, 0.1), linkId: 'L-3' },
    ]
    const attached = attachQualityReport(report(), source, { from: 0.5, to: 1.5 })
    expect(attached.localEvidence?.quality?.samples).toHaveLength(3)
    expect(attached.localEvidence?.qualityConnectivityRates).toEqual([{ linkId: 'L-1', value: 100 }, { linkId: 'L-2', value: 0 }, { linkId: 'L-3', value: 100 }])
    expect(qualityReportView(attached.localEvidence!.quality!, attached.localEvidence!).connectivityRates).toEqual([])
    expect(localReportTables(attached.localEvidence!).find(table => table.title === '链路质量测量')?.rows).toHaveLength(3)
    const { mkdtemp, readFile, rm } = await import('node:' + 'fs/promises'); const { tmpdir } = await import('node:' + 'os'); const { join } = await import('node:' + 'path'); const { exportLocalReport } = await import('../../server/local/' + 'report-file.js')
    const directory = await mkdtemp(join(tmpdir(), 'wrj-quality-boundary-'))
    try { expect(await readFile((await exportLocalReport(directory, attached, 'HTML', 'operator')).filePath, 'utf8')).toContain('雷达图') } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('附加筛选后的真实样本、来源摘要和指标，不把无匹配测量改写为零', () => {
    const attached = attachQualityReport(report(), dataset(), { from: 5, to: 25 })
    expect(attached.localEvidence?.quality?.source.sha256).toBe('c'.repeat(64))
    expect(attached.localEvidence?.quality?.samples).toHaveLength(1)
    expect(attached.localEvidence?.qualityKpis).toMatchObject({ averageConnectedDurationS: 5, jammingDurationS: 5 })
    const source = localReportTables(attached.localEvidence!).find(table => table.title === '质量数据来源')
    expect(source?.rows).toContainEqual(['来源 SHA-256', 'c'.repeat(64)])
    const empty = attachQualityReport(report(), dataset(), { from: 11, to: 20 })
    expect(empty.localEvidence?.quality?.source.sha256).toBe('c'.repeat(64))
    expect(empty.localEvidence?.quality?.samples).toEqual([])
    expect(empty.localEvidence?.qualityKpis?.averageBer).toBeUndefined()
  })

  it('HTML 和 CSV 导出复用筛选后的质量来源、测量表和实际曲线', async () => {
    const { mkdtemp, readFile, rm } = await import('node:' + 'fs/promises')
    const { tmpdir } = await import('node:' + 'os')
    const { join } = await import('node:' + 'path')
    const { exportLocalReport } = await import('../../server/local/' + 'report-file.js')
    const directory = await mkdtemp(join(tmpdir(), 'wrj-quality-report-'))
    try {
      const attached = attachQualityReport(report(), dataset(), { from: 5, to: 25 })
      const html = await exportLocalReport(directory, attached, 'HTML', 'operator')
      const csv = await exportLocalReport(directory, attached, 'CSV', 'operator')
      expect(await readFile(html.filePath, 'utf8')).toContain('GXB 随时间变化')
      expect(await readFile(csv.filePath, 'utf8')).toContain('质量数据来源')
      expect(await readFile(csv.filePath, 'utf8')).toContain('cccccccc')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('拒绝来源摘要或测量结构被篡改的质量证据', () => {
    const attached = attachQualityReport(report(), dataset())
    const tampered = structuredClone(attached)
    tampered.localEvidence!.quality!.source.sha256 = 'not-a-hash'
    expect(isLocalReport(tampered)).toBe(false)
  })
})

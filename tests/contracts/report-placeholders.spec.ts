import { describe, expect, it } from 'vitest'
import type { LocalReportEvidence } from '../../src/contracts/domain-models'
import { isLocalReport, localReportTables } from '../../src/features/reports/local-report'

const BASE: LocalReportEvidence = {
  eventFile: { fileName: 'events.csv', sha256: 'a'.repeat(64) }, positionFile: { fileName: 'position.csv', sha256: 'b'.repeat(64) },
  startTimeS: 0, endTimeS: 100, simulationComplete: true, positionCount: 0, positionIssueCount: 0, waitingForPositionLine: false,
  eventCount: 1, eventWarningCount: 0, nodes: [{ platformId: 'A', name: '节点A', type: 'X', side: 'blue', positionCount: 0, firstTimeS: 0, lastTimeS: 0 }],
  eventCounts: [{ type: 'SIMULATION_COMPLETE', count: 1 }], connections: [], deviceEvents: [],
}
const report = (evidence: LocalReportEvidence) => ({ reportId: `RPT-LOCAL-${'c'.repeat(64)}`, classification: 'LEVEL_II', generatedTime: '2026-10-28T00:00:00Z', status: 'READY', localEvidence: evidence })
const summary = (evidence: LocalReportEvidence) => new Map(localReportTables(evidence)[0]!.rows.map(([label, value]) => [label, value]))

describe('报表评估指标占位', () => {
  it('无引擎质量与切换数据时，大纲评估指标逐项显示暂无数据', () => {
    const rows = summary(BASE)
    for (const label of ['平均连通时长', '切换次数', '平均干信比', '平均误码率', '干扰持续时长']) expect(rows.get(label), label).toBe('暂无数据')
    expect(localReportTables(BASE).find(table => table.title === '链路切换事件')!.rows).toEqual([])
    expect(isLocalReport(report(BASE))).toBe(true)
  })

  it('提供真实数据后自动替换占位，并通过报告边界校验', () => {
    const evidence: LocalReportEvidence = {
      ...BASE,
      qualityKpis: { averageConnectedDurationS: 75.5, averageJsrDb: -3.25, averageBer: 1.2e-5, jammingDurationS: 30 },
      switchEvents: [{ eventId: 'SW-1', time: 12, demandId: 'DEM-1', ruleId: 'RULE-JAM', fromDeviceId: 'tx-a', toDeviceId: 'tx-b', fromLinkId: 'L-A', toLinkId: 'L-B', stableChecks: 5 }],
    }
    expect(isLocalReport(report(evidence))).toBe(true)
    const rows = summary(evidence)
    expect(rows.get('平均连通时长')).toBe('1分15.5秒')
    expect(rows.get('切换次数')).toBe('1')
    expect(rows.get('平均干信比')).toBe('-3.25 dB')
    expect(rows.get('平均误码率')).toBe('1.20e-5')
    expect(rows.get('干扰持续时长')).toBe('0分30秒')
    expect(localReportTables(evidence).find(table => table.title === '链路切换事件')!.rows).toEqual([['SW-1', '0分12秒', 'DEM-1', 'RULE-JAM', 'L-A', 'L-B', '5']])
  })

  it('拒绝越界或结构错误的评估指标与切换事件', () => {
    expect(isLocalReport(report({ ...BASE, qualityKpis: { averageBer: 2 } }))).toBe(false)
    expect(isLocalReport(report({ ...BASE, qualityKpis: { unknown: 1 } as never }))).toBe(false)
    expect(isLocalReport(report({ ...BASE, switchEvents: [{ eventId: 'SW', time: 999, demandId: 'D', ruleId: null, fromDeviceId: 'a', toDeviceId: 'b', fromLinkId: null, toLinkId: null, stableChecks: null }] }))).toBe(false)
  })
})

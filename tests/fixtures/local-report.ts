import type { LocalReportEvidence, LocalReportExportResult, Report } from '../../src/contracts/domain-models'

export const LOCAL_REPORT: Report & { localEvidence: LocalReportEvidence } = {
  reportId: `RPT-LOCAL-${'a'.repeat(64)}`, classification: 'LEVEL_II', generatedTime: '2026-09-20T00:00:00Z', status: 'READY',
  localEvidence: {
    eventFile: { fileName: 'scenario_events.csv', sha256: 'b'.repeat(64) }, positionFile: { fileName: 'position.csv', sha256: 'c'.repeat(64) },
    startTimeS: 0, endTimeS: 10, simulationComplete: true, positionCount: 3, positionIssueCount: 0, waitingForPositionLine: false,
    eventCount: 2, eventWarningCount: 0,
    nodes: [{ platformId: 'A', name: '无人机甲', type: 'AIR', side: 'blue', positionCount: 2, firstTimeS: 1, lastTimeS: 3 },
      { platformId: 'B', name: '通信车乙', type: 'GROUND', side: 'blue', positionCount: 1, firstTimeS: 0, lastTimeS: 0 }],
    eventCounts: [{ type: 'LINK_ADDED_TO_MANAGER', count: 1 }, { type: 'COMM_TURNED_ON', count: 1 }],
    connections: [{ eventId: 'LOG-L1', time: 5, scope: 'INTER_PLATFORM', sourcePlatformId: 'A', sourceDeviceId: 'tx', targetPlatformId: 'B', targetDeviceId: 'rx' }],
    deviceEvents: [{ eventId: 'LOG-L2', type: 'COMM_TURNED_ON', time: 0, platformId: 'A', deviceId: 'tx' }],
  },
}
export const LOCAL_EXPORT: LocalReportExportResult = {
  reportId: LOCAL_REPORT.reportId, generated: true, status: 'SUCCESS', format: 'HTML', watermark: '本地文件统计 · 二级',
  verifiedAt: '2026-09-20T00:00:00Z', filePath: 'H:\\reports\\report.html', sha256: 'd'.repeat(64),
}

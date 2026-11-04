import { attachQualityReport } from '../../src/features/reports/quality-report'
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

export const LOCAL_QUALITY_REPORT = attachQualityReport(LOCAL_REPORT, {
  schemaVersion: '1.0', scope: { taskId: 'TASK-1', runId: 'RUN-1', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-09-20T00:00:00Z' },
  source: { kind: 'FILE_IMPORT', fileName: 'quality.csv', sha256: 'd'.repeat(64), importedAt: '2026-09-20T00:01:00Z', frameIdKind: 'PROVIDED' },
  expectedStepS: 1, switchEvents: [],
  samples: [0, 1].flatMap(time => [1, 2, 3].map(index => ({
    time, frameId: time, linkId: `L-${index}`, sourcePlatform: 'A', destPlatform: 'B', linkType: 'MICROWAVE' as const,
    frequency: 8000, bandwidth: 20, distance: 1000, txPower: 10, txAntennaGain: 1, rxAntennaGain: 1,
    pathLoss: 100, jammingPower: -90, receivedPower: -70, snr: 12, modulation: 'QPSK' as const,
    ber: index === 2 ? 0.1 : 0, berThreshold: 1e-5, linkStatus: index === 2 ? 'DOWN' as const : 'UP' as const, dataRate: 10, jsrDb: 10,
  }))),
})

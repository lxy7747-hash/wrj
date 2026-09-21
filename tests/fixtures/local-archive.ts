import type { LocalArchiveSnapshot } from '../../src/features/admin/local-archive'
import { LOCAL_REPLAY } from './local-replay'
import { LOCAL_REPORT } from './local-report'

export const LOCAL_ARCHIVE: LocalArchiveSnapshot = {
  record: { archiveId: `ARCH-LOCAL-${'d'.repeat(64)}`, name: '真实测试快照', createdAt: '2026-09-21T00:00:00Z', createdBy: 'admin',
    sourceKind: 'LOCAL_FILE_SNAPSHOT', binding: 'UNBOUND', eventFile: { fileName: 'initial.csv', sha256: 'a'.repeat(64) },
    positionFile: { fileName: 'positions.csv', sha256: 'b'.repeat(64) }, reportId: LOCAL_REPORT.reportId, nodeCount: 2, positionCount: 3, durationS: 3 },
  replay: structuredClone(LOCAL_REPLAY),
  report: { ...structuredClone(LOCAL_REPORT), localEvidence: { ...structuredClone(LOCAL_REPORT.localEvidence),
    eventFile: { fileName: 'initial.csv', sha256: 'a'.repeat(64) }, positionFile: { fileName: 'positions.csv', sha256: 'b'.repeat(64) } } },
}

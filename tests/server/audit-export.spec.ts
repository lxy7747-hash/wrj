import { describe, expect, it } from 'vitest'
import type { AuditRecord } from '../../src/contracts/domain-models'

const path = '../../server/auth/' + 'audit-export.js'
const { buildAuditExport } = await import(path)

describe('audit TXT serialization', () => {
  it('escapes control characters rather than allowing forged record lines', () => {
    const record: AuditRecord = { auditId: 'AUD-001', actor: 'a\n伪造记录\t值', role: 'ADMIN', module: 'SYSTEM',
      action: 'UNKNOWN', objectId: 'id\r\nnext', result: 'SUCCESS', occurredAt: '2026-09-11T06:00:00Z', immutableFixture: true }
    const result = buildAuditExport([record], { actor: record.actor }, 'admin', '2026-09-11T06:00:00Z', 'CONF-001')
    const line = result.content.split('\r\n').find((row: string) => row.startsWith('"AUD-001"'))
    expect(line.split('\t')).toHaveLength(8)
    expect(JSON.parse(line.split('\t')[2])).toBe(record.actor)
    expect(result.content).not.toContain('\n伪造记录')
    expect(result.content).toContain('记录数量：1')
  })
})

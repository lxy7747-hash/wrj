// @vitest-environment node
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { LOCAL_REPORT, LOCAL_EXPORT } from '../fixtures/local-report'
import fixtures from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
const { loadContractDocuments } = await import('../../scripts/contracts/contract-' + 'documents.js')
const ajv = new Ajv2020({ strict: false })
addFormats(ajv)
ajv.addSchema(loadContractDocuments().openApi, 'report-contract')
const report = ajv.compile({ $ref: 'report-contract#/components/schemas/Report' })
const exported = ajv.compile({ $ref: 'report-contract#/components/schemas/ReportExportOutcome' })
describe('本地报告增量合同兼容与冻结', () => {
  it('保留纯 Mock，接受真实文件来源及真实导出', () => {
    expect(report(fixtures.report)).toBe(true)
    expect(report(LOCAL_REPORT)).toBe(true)
    expect(exported(LOCAL_EXPORT)).toBe(true)
    expect(exported({ reportId: 'RPT-001', generated: false, status: 'FIXTURE_SUCCESS', watermark: 'mock', verifiedAt: LOCAL_EXPORT.verifiedAt })).toBe(true)
  })
  it('拒绝本地证据冒充运行、三级报告及质量数据；拒绝伪导出', () => {
    for (const change of [{ runId: 'RUN-001' }, { classification: 'LEVEL_III' }, { kpis: fixtures.report.kpis }]) expect(report({ ...LOCAL_REPORT, ...change })).toBe(false)
    for (const change of [{ generated: false }, { format: 'PDF' }, { sha256: 'bad' }, { filePath: '' }, { extra: true }]) expect(exported({ ...LOCAL_EXPORT, ...change })).toBe(false)
    const invalid = structuredClone(LOCAL_REPORT)
    invalid.localEvidence.positionCount = -1
    expect(report(invalid)).toBe(false)
  })
})

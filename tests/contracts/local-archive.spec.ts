// @vitest-environment node
import { describe, it, expect } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { LOCAL_ARCHIVE } from '../fixtures/local-archive'
import { isLocalArchiveSnapshot, isLocalArchiveRecord } from '../../src/features/admin/local-archive'
const { loadContractDocuments } = await import('../../scripts/contracts/contract-' + 'documents.js')
const ajv = new Ajv2020({ strict: false }); addFormats(ajv)
ajv.addSchema(loadContractDocuments().openApi, 'archive')
const validate = ajv.compile({ $ref: 'archive#/components/schemas/LocalArchiveSnapshot' })
describe('真实快照合同与信任边界', () => {
  it('规范快照通过，不用场景或运行占位编号', () => {
    expect(validate(LOCAL_ARCHIVE), JSON.stringify(validate.errors)).toBe(true)
    expect(isLocalArchiveSnapshot(LOCAL_ARCHIVE)).toBe(true)
    expect(isLocalArchiveRecord(null)).toBe(false)
    expect(isLocalArchiveSnapshot(null)).toBe(false)
  })
  it.each([
    { name: '' }, { name: 'a'.repeat(81) }, { archiveId: '../file' }, { scenarioId: 'SCN-001' },
    { binding: 'BOUND' }, { nodeCount: 0 }, { positionCount: -1 }, { createdAt: 'bad' },
  ])('拒绝非法目录字段 %j', change => {
    const snapshot = { ...LOCAL_ARCHIVE, record: { ...LOCAL_ARCHIVE.record, ...change } }
    expect(validate(snapshot)).toBe(false)
    expect(isLocalArchiveSnapshot(snapshot)).toBe(false)
  })
  it.each(['hash', 'nodes', 'positions', 'duration', 'report'])('拒绝跨快照关联 %s', field => {
    const snapshot = structuredClone(LOCAL_ARCHIVE)
    if (field === 'hash') snapshot.replay.sha256 = 'c'.repeat(64)
    if (field === 'nodes') snapshot.record.nodeCount++
    if (field === 'positions') snapshot.record.positionCount++
    if (field === 'duration') snapshot.record.durationS++
    if (field === 'report') snapshot.record.reportId = `RPT-LOCAL-${'e'.repeat(64)}`
    expect(isLocalArchiveSnapshot(snapshot)).toBe(false)
  })
})

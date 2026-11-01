import { describe, expect, it } from 'vitest'
import { consecutiveQualitySamples, isQualityDataset } from '../../src/features/data-exchange/quality-records'
const { loadContractDocuments, auditOpenApi } = await import('../../scripts/contracts/' + 'contract-documents.js')

describe('质量管线合同与连续采样', () => {
  it('网络质量边界拒绝空样本对象，不向调用方抛出异常', () => {
    const value = { schemaVersion: '1.0', scope: { taskId: 'TASK-1', runId: 'RUN-1', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' },
      source: { kind: 'FILE_IMPORT', fileName: 'quality.json', sha256: 'a'.repeat(64), importedAt: '2026-01-01T00:01:00.000Z', frameIdKind: 'PROVIDED' },
      expectedStepS: 1, samples: [null], switchEvents: [] }
    expect(() => isQualityDataset(value)).not.toThrow()
    expect(isQualityDataset(value)).toBe(false)
  })

  it('浮点时间步连续，真实时间或帧号缺口不连续', () => {
    expect(consecutiveQualitySamples({ frameId: 1, time: 0.2 }, { frameId: 2, time: 0.3 }, 0.1)).toBe(true)
    expect(consecutiveQualitySamples({ frameId: 2, time: 0.3 }, { frameId: 3, time: 0.4 }, 0.1)).toBe(true)
    expect(consecutiveQualitySamples({ frameId: 1, time: 0.2 }, { frameId: 2, time: 100 }, 0.1)).toBe(false)
    expect(consecutiveQualitySamples({ frameId: 1, time: 0.2 }, { frameId: 3, time: 0.3 }, 0.1)).toBe(false)
    expect(consecutiveQualitySamples({ frameId: 1, time: 0.2 }, { frameId: 2, time: 0.2 }, 0.1)).toBe(false)
  })

  it('规范下载二进制响应受冻结合同约束，不放宽其他JSON接口', () => {
    const { openApi } = loadContractDocuments()
    expect(auditOpenApi(openApi)).toEqual([])
    const candidate = structuredClone(openApi)
    candidate.paths['/api/v1/simulations/{runId}/quality/files/{fileName}'].get.responses['200'].content['application/octet-stream'].schema.format = 'unknown'
    expect(auditOpenApi(candidate).some((finding: { code: string; path: string }) => finding.code === 'OPENAPI_SUCCESS_ENVELOPE' && finding.path.includes('/quality/files/'))).toBe(true)
  })
})

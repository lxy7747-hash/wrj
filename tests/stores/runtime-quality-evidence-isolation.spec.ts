// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Principal, QualityDataset, SimulationRun } from '../../src/contracts/domain-models'
import { isQualityDataset } from '../../src/features/data-exchange/quality-records'
import { useAuthStore } from '../../src/stores/auth'
import { useRuntimeQualityStore, type RuntimeQualityBinding, type RuntimeQualityScope } from '../../src/stores/runtime-quality'
import { useSimulationStore } from '../../src/stores/simulation'

const OPERATOR: Principal = { userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'] }
const scope = (): RuntimeQualityScope => ({ taskId: 'TASK-001', runId: 'RUN-001', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-10-31T01:00:00Z' })
const binding = (): RuntimeQualityBinding => ({
  linkId: 'L-001', sourceLinkId: 'source-link-001', sourcePlatformId: 'UAV-001', destinationPlatformId: 'SAT-001', sourcePortId: 'comm_l001_src', destinationPortId: 'comm_l001_dst',
})
const legalDataset = (): QualityDataset => ({
  schemaVersion: '1.0', scope: scope(),
  source: { kind: 'FILE_IMPORT', fileName: 'quality.json', sha256: 'a'.repeat(64), importedAt: '2026-10-31T01:02:00Z', frameIdKind: 'PROVIDED' },
  expectedStepS: 1,
  samples: [{
    time: 5, frameId: 7, linkId: 'L-001', sourcePlatform: 'UAV-001', destPlatform: 'SAT-001', linkType: 'SAT',
    frequency: 2200, bandwidth: 40, distance: 12_500, txPower: 10, txAntennaGain: 2, rxAntennaGain: 3,
    pathLoss: 102, jammingPower: -89, receivedPower: -70, snr: 12, modulation: 'QPSK', ber: 1e-6,
    linkStatus: 'UP', berThreshold: 1e-5, dataRate: 1, jsrDb: 8, interferenceActive: true,
  }],
  switchEvents: [],
} as unknown as QualityDataset)

/** 正确 auth(LOCAL)/run/scenario scope/bindings/epoch 的激活上下文，用于正向合法数据集断言。 */
function prepare() {
  const auth = useAuthStore()
  const simulation = useSimulationStore()
  auth.$patch({ principal: structuredClone(OPERATOR), role: OPERATOR.role, permissions: [...OPERATOR.permissions], runtimeMode: 'LOCAL' })
  const active = scope()
  simulation.$patch({
    run: { taskId: active.taskId, runId: active.runId, scenarioId: active.scenarioId, startedAt: active.startedAt } as SimulationRun,
    selectedScene: { config: { scenario: { id: active.scenarioId }, links: [{ id: 'L-001' }] }, revision: active.revision } as any,
  })
  const store = useRuntimeQualityStore()
  const epoch = store.activate(active, ['L-001'])
  expect(store.bindLinks(epoch, [binding()])).toBe(true)
  return store
}

const evidenceReceipt = {
  scope: scope(), bundleSha256: 'c'.repeat(64), association: 'USER_SELECTED_RUN',
  files: [{ fileName: 'link_state.csv', sha256: 'b'.repeat(64), rows: 2 }], capabilities: ['state'], missing: ['quality', 'loss', 'switch'], warnings: [],
}

describe('T3 新文件集回执与旧 QualityDataset 隔离（store 级，正向激活）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('正确激活上下文中合法 QualityDataset acceptDataset=true 且实际写入 importedDataset', () => {
    const store = prepare()
    const dataset = legalDataset()
    expect(store.scope).not.toBeNull()
    expect(isQualityDataset(dataset)).toBe(true)
    expect(store.acceptDataset(store.epoch, dataset)).toBe(true)
    expect(store.importedDataset).toMatchObject({ source: { sha256: 'a'.repeat(64), kind: 'FILE_IMPORT' }, expectedStepS: 1 })
    expect(store.state).toBe('SUCCESS')
  })

  it('已激活时新文件集回执仍被 DTO 拒绝（非因 active 提前拒绝），且不冒充旧数据集', () => {
    const store = prepare()
    expect(store.acceptDataset(store.epoch, legalDataset())).toBe(true)
    const before = store.importedDataset
    // 已激活：校验真正走到 DTO 拒绝路径，错误码为 QUALITY_DATASET_INVALID。
    expect(store.acceptDataset(store.epoch, evidenceReceipt)).toBe(false)
    expect(store.errors[0]).toMatchObject({ code: 'QUALITY_DATASET_INVALID' })
    // 新回执绝不会被当作完整样本（importedDataset 被清除，而非写入回执）。
    expect(store.importedDataset).toBeNull()
    expect(store.importedDataset).not.toBe(before)
    expect(isQualityDataset(evidenceReceipt)).toBe(false)
  })
})

// @vitest-environment node
// B1-2：完整发布引用去重身份（6 字段）+ createdAt 保留；SQLite 与内存分支。
import { afterEach, describe, expect, it } from 'vitest'
import { EQUIPMENT } from '../fixtures/equipment'

const { mkdtemp, rm } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { AdminProjection } = await import('../../server/admin/' + 'projection.js')
const { EquipmentSqliteStorage } = await import('../../server/local/' + 'equipment-sqlite.js')
const { registerPublishedParameterSources } = await import('../../server/local/' + 'equipment-publish.js')

const T0 = '2020-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:00:00.000Z'
const target = { targetType: 'TEMPLATE' as const, targetId: 'TPL-DEDUP', targetVersion: '1' }
const summaryA = 'links[L-MW-01].parameterSource fields=modulation,berThreshold'
const summaryB = 'links[L-DL-03].parameterSource fields=modulation,berThreshold'
const cleanups: Array<() => void | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

/** 两条链路各带一条同装备来源：一条与旧引用完全一致（应去重），一条全新。 */
function config() {
  const draft = new ScenarioProjection().get('SCN-001').data
  for (const link of draft.config.links.filter((item: { id: string }) => ['L-MW-01', 'L-DL-03'].includes(item.id))) {
    Object.assign(link, { parameterSource: { kind: 'EQUIPMENT', sourceId: EQUIPMENT.equipmentId, sourceVersion: 1, fields: ['modulation', 'berThreshold'] } })
  }
  return draft.config
}

function ref(overrides: Record<string, unknown>) {
  return { equipmentId: EQUIPMENT.equipmentId, equipmentVersion: 1, targetType: 'TEMPLATE', targetId: 'TPL-DEDUP',
    targetVersion: '1', sourceSummary: summaryA, createdAt: T0, ...overrides } as never
}

function seed(admin: InstanceType<typeof AdminProjection>) {
  admin.addPublishedReference(ref({ sourceSummary: summaryA }))
  admin.addPublishedReference(ref({ sourceSummary: 'links[L-OTHER].parameterSource fields=modulation' }))
  admin.addPublishedReference(ref({ equipmentVersion: 2, sourceSummary: summaryB }))
}

function assertFlow(admin: InstanceType<typeof AdminProjection>, refs: () => Array<{ sourceSummary: string; createdAt: string; equipmentVersion: number }>) {
  const inserted = registerPublishedParameterSources(config(), target, T1,
    (reference: never) => admin.addPublishedReference(reference), (reference: never) => admin.removePublishedReference(reference))
  // 与旧引用完全一致的那条返回 false（被去重）；仅新链路返回 true；只差 sourceSummary / version 的两条不误判新引用
  expect(inserted).toHaveLength(1)
  expect(inserted[0]!.sourceSummary).toBe(summaryB)
  expect(refs()).toHaveLength(4)
  // 目标提交失败：只撤销本次新增
  admin.discardPublishedReferences(inserted)
  const kept = refs()
  expect(kept).toHaveLength(3)
  expect(kept.every(row => row.createdAt === T0)).toBe(true)
  expect(kept.map(row => row.sourceSummary).sort()).toEqual([summaryA, 'links[L-OTHER].parameterSource fields=modulation', summaryB].sort())
  expect(kept.find(row => row.sourceSummary === summaryB)!.equipmentVersion).toBe(2)
  // 重试成功：集合恰为旧 3 + 新 1，无重复、无遗漏，旧 createdAt 仍为 T0
  const retried = registerPublishedParameterSources(config(), target, T1,
    (reference: never) => admin.addPublishedReference(reference), (reference: never) => admin.removePublishedReference(reference))
  expect(retried).toHaveLength(1)
  const final = refs()
  expect(final).toHaveLength(4)
  expect(final.filter(row => row.createdAt === T0)).toHaveLength(3)
  expect(new Set(final.map(row => `${row.equipmentVersion}|${row.sourceSummary}`)).size).toBe(4)
}

describe('B1-2 完整去重身份', () => {
  it('B1-2a SQLite：仅 target 三字段相同不算覆盖，旧引用 createdAt 保留，失败只撤新增', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-dedup-sqlite-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
    const equipment = new EquipmentSqliteStorage(join(root, 'equipment.db')); cleanups.push(() => equipment.close())
    expect(equipment.save(structuredClone(EQUIPMENT))).toBe(true)
    expect(equipment.save({ ...structuredClone(EQUIPMENT), version: 2, modulation: 'BPSK' }, 1)).toBe(true)
    const admin = new AdminProjection(undefined, equipment)
    seed(admin)
    assertFlow(admin, () => equipment.publishedReferences(EQUIPMENT.equipmentId) as never)
  })

  it('B1-2b 内存分支：同样完整身份去重与 createdAt 保留', () => {
    const admin = new AdminProjection()
    const first = admin.saveEquipment(structuredClone(EQUIPMENT))
    expect(first.ok).toBe(true)
    const second = admin.saveEquipment({ ...structuredClone(EQUIPMENT), version: 1, modulation: 'BPSK' } as never, EQUIPMENT.equipmentId)
    expect(second.ok).toBe(true)
    seed(admin)
    assertFlow(admin, () => admin.equipmentHistoryDetails(EQUIPMENT.equipmentId).publishedReferences as never)
  })
})


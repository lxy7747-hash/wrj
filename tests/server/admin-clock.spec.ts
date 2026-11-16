// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ScenarioConfig } from '../../src/contracts/domain-models'
import { EQUIPMENT } from '../fixtures/equipment'

const { AdminProjection, DEFAULT_ADMIN_NOW } = await import('../../server/admin/' + 'projection.js')

const T = '2026-09-21T00:00:00Z'
const recreateParams = {
  type: '微波通信设备', frequencyMinMHz: 100, frequencyMaxMHz: 200, modulation: 'QPSK', berThreshold: 0.00001,
}

describe('管理投影确定性时钟', () => {
  it('核验、发布引用、删除与重建事件统一使用注入时钟', () => {
    const admin = new AdminProjection(undefined, undefined, undefined, undefined, { now: () => T })
    expect(admin.saveEquipment(structuredClone(EQUIPMENT))).toMatchObject({ ok: true })

    const verification = admin.recordEquipmentVerification(EQUIPMENT.equipmentId, {
      coveredTargets: 'SCN-001', evidenceSummary: '核查依据', conclusion: '通过',
    }, 'admin')
    expect(verification).toMatchObject({ ok: true, data: { verifiedAt: T } })

    const config = {
      links: [{
        id: 'L-CLOCK-1', type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B', direction: 'FORWARD',
        parameterSource: { kind: 'EQUIPMENT', sourceId: EQUIPMENT.equipmentId, sourceVersion: 1, fields: ['modulation'] },
      }],
    } as unknown as ScenarioConfig
    const published = admin.capturePublishedParameterSources(config,
      { targetType: 'TEMPLATE', targetId: 'TPL-CLOCK', targetVersion: '1' }, 'admin')
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ createdAt: T, sourceSummary: 'links[L-CLOCK-1].parameterSource fields=modulation' })
    // 发布引用会阻止删除；先撤销本次新增，再验证删除/重建事件也使用同一时钟。
    admin.discardPublishedReferences(published)

    expect(admin.deleteEquipment(EQUIPMENT.equipmentId, 1, 'admin')).toMatchObject({ ok: true })
    const lifecycle = admin.equipmentHistoryDetails(EQUIPMENT.equipmentId).lifecycle
    expect(lifecycle).toContainEqual(expect.objectContaining({ eventType: 'DELETE', occurredAt: T }))
    expect(lifecycle.every((event: { occurredAt: string }) => event.occurredAt === T)).toBe(true)

    const recreated = admin.recreateEquipment(EQUIPMENT.equipmentId,
      { expectedHistoryVersion: 1, parameters: recreateParams }, 'admin')
    expect(recreated).toMatchObject({ ok: true, data: { event: { eventType: 'RECREATE', occurredAt: T } } })
  })

  it('纯 Mock 默认使用公开固定时刻，不读取系统时钟', () => {
    const admin = new AdminProjection()
    expect(admin.saveEquipment(structuredClone(EQUIPMENT))).toMatchObject({ ok: true })
    const verification = admin.recordEquipmentVerification(EQUIPMENT.equipmentId, {
      coveredTargets: 'SCN-001', evidenceSummary: '核查依据', conclusion: '通过',
    }, 'admin')
    expect(verification).toMatchObject({ ok: true, data: { verifiedAt: DEFAULT_ADMIN_NOW } })
    expect(DEFAULT_ADMIN_NOW).toBe('2026-08-06T08:00:00Z')
  })

  it('装备 SQLite 存储的生命周期事件使用同一注入时钟', async () => {
    const { mkdtemp, rm } = await import('node:fs/' + 'promises')
    const { tmpdir } = await import('node:' + 'os')
    const { join } = await import('node:' + 'path')
    const { EquipmentSqliteStorage } = await import('../../server/local/' + 'equipment-sqlite.js')
    const directory = await mkdtemp(join(tmpdir(), 'wrj-admin-clock-'))
    const storage = new EquipmentSqliteStorage(join(directory, 'equipment.db'), undefined, () => T)
    try {
      expect(storage.save(structuredClone(EQUIPMENT))).toBe(true)
      expect(storage.delete(EQUIPMENT.equipmentId, 1, 'admin')).toBe(true)
      expect(storage.lifecycleEvents(EQUIPMENT.equipmentId)).toEqual([
        expect.objectContaining({ eventType: 'DELETE', occurredAt: T }),
      ])
      const recreated = storage.recreate(EQUIPMENT.equipmentId, 1, recreateParams, 'admin')
      expect(recreated).toMatchObject({ ok: true, event: { eventType: 'RECREATE', occurredAt: T } })
    } finally {
      storage.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

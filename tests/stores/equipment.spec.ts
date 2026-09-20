import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAdminStore } from '../../src/stores/admin'
import { useAuthStore } from '../../src/stores/auth'
import { equipmentIssue } from '../../src/features/admin/equipment-contract'
import { EQUIPMENT } from '../fixtures/equipment'

export function equipmentResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data, meta: { requestId: 'REQ-EQ', generatedAt: '2026-08-06T08:00:00Z', page: 1, pageSize: 10, total: Array.isArray(data) ? data.length : 1 } }))
}

beforeEach(() => { setActivePinia(createPinia()); useAuthStore().$patch({ role: 'ADMIN' }) })
afterEach(() => vi.unstubAllGlobals())

describe('装备参数正式 Store 入口', () => {
  it('加载空库、新增、编辑后重载并保留数值和 null', async () => {
    const store = useAdminStore()
    const edited = { ...EQUIPMENT, modulation: null, version: 2 }
    const fetcher = vi.fn().mockResolvedValueOnce(equipmentResponse([])).mockResolvedValueOnce(equipmentResponse(EQUIPMENT))
      .mockResolvedValueOnce(equipmentResponse(edited)).mockResolvedValueOnce(equipmentResponse([edited]))
    vi.stubGlobal('fetch', fetcher)
    expect(await store.loadMaintenance('equipment')).toBe(true)
    expect(store.maintenance.equipment.state).toBe('EMPTY')
    expect(await store.saveEquipment(EQUIPMENT, true)).toBe(true)
    expect(await store.saveEquipment({ ...edited, version: 1 }, false)).toBe(true)
    expect(await store.loadMaintenance('equipment')).toBe(true)
    expect(store.equipment).toEqual([edited])
    expect(JSON.parse(fetcher.mock.calls[2]![1].body).modulation).toBeNull()
  })

  it.each([null, [{ ...EQUIPMENT, extra: true }], [EQUIPMENT, EQUIPMENT], [{ ...EQUIPMENT, frequencyMinMHz: 0 }]])('非法列表清空旧数据 %j', async bad => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(equipmentResponse([EQUIPMENT])).mockResolvedValueOnce(equipmentResponse(bad)))
    const store = useAdminStore()
    await store.loadMaintenance('equipment')
    expect(await store.loadMaintenance('equipment')).toBe(false)
    expect(store.equipment).toEqual([])
    expect(store.maintenance.equipment.state).toBe('ERROR')
  })

  it.each(['load', 'save'] as const)('%s 在离页/登出失效后迟到响应不回写', async action => {
    let resolve!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done })))
    const store = useAdminStore()
    const pending = action === 'load' ? store.loadMaintenance('equipment') : store.saveEquipment(EQUIPMENT, true)
    expect(await store.saveEquipment(EQUIPMENT, true)).toBe(false)
    store.resetToSafeEmpty()
    resolve(equipmentResponse(action === 'load' ? [EQUIPMENT] : EQUIPMENT))
    expect(await pending).toBe(false)
    expect(store.equipment).toEqual([])
    expect(store.maintenance.equipment.state).toBe('EMPTY')
  })

  it('拒绝本地非法字段、只读写入、操作员请求和不匹配保存结果', async () => {
    const fetcher = vi.fn().mockResolvedValue(equipmentResponse({ ...EQUIPMENT, type: '服务器意外改值' }))
    vi.stubGlobal('fetch', fetcher)
    const store = useAdminStore()
    expect(await store.saveEquipment({ ...EQUIPMENT, type: '' }, true)).toBe(false)
    expect(await store.saveEquipment({ ...EQUIPMENT, readOnly: true }, true)).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
    useAuthStore().role = 'OPERATOR'
    expect(await store.loadMaintenance('equipment')).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
    useAuthStore().role = 'ADMIN'
    expect(await store.saveEquipment(EQUIPMENT, true)).toBe(false)
    expect(store.maintenance.equipment.message).toContain('不一致')
    expect(store.equipment).toEqual([])
  })

  it.each([{ frequencyMinMHz: Infinity }, { readOnly: 'false' }, { modulation: 'x'.repeat(33) }, { type: 'x'.repeat(101) }, { version: 1.5 }])('共享规则拒绝 %j', change => {
    expect(equipmentIssue({ ...EQUIPMENT, ...change })).not.toBeNull()
  })
})

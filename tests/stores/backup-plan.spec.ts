import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAdminStore } from '../../src/stores/admin'
import { useAuthStore } from '../../src/stores/auth'
import { isBackupPlan, isBackupPlanStatus } from '../../src/features/admin/backup-plan'
import { isBackupRecord } from '../../src/features/admin/admin-contract'

const plan = { version: 1, enabled: false, name: '每天备份', intervalMinutes: 1440 }
const status = { plan, nextRunAt: null, executions: [] }
const response = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data, meta: { requestId: 'REQ-PLAN', generatedAt: '2026-09-21T00:00:00Z', page: 1, pageSize: 1, total: 1 } }) }) as Response
beforeEach(() => { setActivePinia(createPinia()); useAuthStore().role = 'ADMIN' })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('计划和记录闭合校验、范围、时间与启用状态一致', () => {
  expect(isBackupPlan(plan)).toBe(true)
  expect(isBackupPlanStatus(status)).toBe(true)
  for (const value of [null, {}, { ...plan, name: ' ' }, { ...plan, version: 0 }, { ...plan, intervalMinutes: 59 }, { ...plan, intervalMinutes: 10081 }, { ...plan, intervalMinutes: 60.5 }, { ...plan, extra: 1 }]) expect(isBackupPlan(value)).toBe(false)
  const run = { startedAt: '2026-09-21T00:00:00Z', completedAt: '2026-09-21T00:01:00Z', result: 'SUCCESS', backupId: 'BACKUP-1', message: '完成' }
  expect(isBackupPlanStatus({ ...status, executions: [run] })).toBe(true)
  expect(isBackupPlanStatus({ ...status, executions: [{ ...run, result: 'FAILURE', backupId: null }] })).toBe(true)
  for (const value of [{ ...status, plan: { ...plan, enabled: true } }, { ...status, nextRunAt: '2026-09-21T00:00:00Z' },
    { ...status, executions: [{ ...run, completedAt: '2020-01-01T00:00:00Z' }] }, { ...status, executions: [{ ...run, backupId: null }] }, { ...status, executions: [{ ...run, result: 'BAD' }] },
    { ...status, executions: Array(21).fill(run) }]) expect(isBackupPlanStatus(value)).toBe(false)
  const backup = { backupId: 'A', createdAt: run.startedAt, checksum: 'A'.repeat(64), status: 'VALID', name: '系统备份', format: 'SYSTEM_SQLITE_V1' }
  expect(isBackupRecord(backup)).toBe(true)
  expect(isBackupRecord({ ...backup, name: ' ' })).toBe(false)
  expect(isBackupRecord({ ...backup, format: 'unknown' })).toBe(false)
})

it('正式 Store 加载和保存计划，非法或不匹配响应清空旧结果', async () => {
  const store = useAdminStore()
  const fetcher = vi.fn().mockResolvedValueOnce(response(status))
    .mockResolvedValueOnce(response({ ...status, plan: { ...plan, version: 2 } }))
    .mockResolvedValueOnce(response({ ...status, plan: { ...plan, name: 'wrong', version: 3 } }))
  vi.stubGlobal('fetch', fetcher)
  expect(await store.loadBackupPlan()).toBe(true)
  expect(await store.saveBackupPlan(plan)).toBe(true)
  expect(fetcher.mock.calls[1]?.[1]?.method).toBe('PUT')
  expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body)).toEqual(plan)
  expect(await store.saveBackupPlan({ ...plan, version: 2 })).toBe(false)
  expect(store.backupPlanStatus).toBeNull()
  expect(store.backupPlanError).toContain('不匹配')
  expect(await store.saveBackupPlan({ ...plan, name: '' })).toBe(false)
  fetcher.mockResolvedValueOnce(response({}))
  expect(await store.loadBackupPlan()).toBe(false)
  expect(store.backupPlanError).toContain('格式')
  fetcher.mockRejectedValueOnce(new Error('offline'))
  expect(await store.loadBackupPlan()).toBe(false)
  expect(store.backupPlanStatus).toBeNull()
})

it.each(['load', 'save'] as const)('计划 %s 在途重复操作受阻，离页后迟到响应不恢复', async action => {
  const store = useAdminStore()
  let resolve!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done })))
  const pending = action === 'load' ? store.loadBackupPlan() : store.saveBackupPlan(plan)
  expect(await store.loadBackupPlan()).toBe(false)
  expect(await store.saveBackupPlan(plan)).toBe(false)
  store.resetMaintenance()
  resolve(response({ ...status, plan: { ...plan, version: action === 'load' ? 1 : 2 } }))
  expect(await pending).toBe(false)
  expect(store.backupPlanStatus).toBeNull()
  expect(store.backupPlanPending).toBe(false)
})

it('操作员不能请求计划接口，保存失败不得保留成功结果', async () => {
  const store = useAdminStore()
  const fetcher = vi.fn().mockResolvedValueOnce(response(status)).mockRejectedValueOnce(new Error('offline'))
  vi.stubGlobal('fetch', fetcher)
  expect(await store.loadBackupPlan()).toBe(true)
  expect(await store.saveBackupPlan(plan)).toBe(false)
  expect(store.backupPlanStatus).toBeNull()
  useAuthStore().role = 'OPERATOR'
  expect(await store.loadBackupPlan()).toBe(false)
  expect(fetcher).toHaveBeenCalledTimes(2)
})

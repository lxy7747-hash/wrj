import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessageBox, ElMessage } from 'element-plus'
import BackupRestoreWizard from '../../src/components/admin/BackupRestoreWizard.vue'
import { useAuthStore } from '../../src/stores/auth'

let wrapper: VueWrapper | undefined
const response = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data, meta: { requestId: 'REQ-BACKUP', generatedAt: '2026-09-21T00:00:00Z', page: 1, pageSize: 1, total: 1 } }) }) as Response
beforeEach(() => { setActivePinia(createPinia()); useAuthStore().role = 'ADMIN' })
afterEach(() => { wrapper?.unmount(); wrapper = undefined; ElMessage.closeAll(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function start(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetcher)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/admin')
  wrapper = mount(BackupRestoreWizard, { global: { plugins: [ElementPlus, router] } })
  await flushPromises()
}

it('不再展示定时备份计划区域，且空备份名称不执行创建', async () => {
  const fetcher = vi.fn(() => Promise.resolve(response([])))
  await start(fetcher)
  expect(wrapper!.find('[data-testid="backup-plan"]').exists()).toBe(false)
  expect(wrapper!.find('[data-testid="backup-feedback"]').exists()).toBe(false)
  expect(wrapper!.get('[data-testid="backup-table"]').text()).toContain('暂无备份记录')
  expect(fetcher).toHaveBeenCalledTimes(1)
  await wrapper!.get('input[aria-label="备份名称"]').setValue(' ')
  const error = vi.spyOn(ElMessage, 'error')
  await wrapper!.get('[data-testid="backup-create"]').trigger('click')
  expect(error).toHaveBeenCalledOnce()
})

it('确认创建后使用加载状态，表格上方只显示实际错误', async () => {
  let finishRequest!: (value: Response) => void
  const pendingRequest = new Promise<Response>(resolve => { finishRequest = resolve })
  const fetcher = vi.fn().mockResolvedValueOnce(response([])).mockReturnValueOnce(pendingRequest)
  await start(fetcher)
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
  const create = wrapper!.get('[data-testid="backup-create"]')
  await create.trigger('click')
  await flushPromises()

  expect(create.attributes('disabled')).toBeDefined()
  expect(wrapper!.find('[data-testid="backup-feedback"]').exists()).toBe(false)

  finishRequest({ ok: false, json: async () => ({ ok: false, error: { code: 'ATOMIC_REPLACE_FAILED', message: '备份存储暂时不可用。' } }) } as Response)
  await flushPromises()
  expect(wrapper!.get('[data-testid="backup-feedback"]').text()).toContain('备份存储暂时不可用。')
  expect(create.attributes('disabled')).toBeUndefined()
})

it('支持备份搜索、仅看可恢复筛选与删除备份', async () => {
  const backups = [
    { backupId: 'BK-VALID', name: '发布前快照', status: 'VALID', format: 'SYSTEM_SQLITE_V2', checksum: 'A'.repeat(64), createdAt: '2026-09-21T02:00:00Z' },
    { backupId: 'BK-BROKEN', name: '损坏快照', status: 'INVALID', format: 'SYSTEM_SQLITE_V2', checksum: 'B'.repeat(64), createdAt: '2026-09-21T01:00:00Z' },
  ]
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return Promise.resolve(response({ deleted: true, objectId: 'BK-BROKEN' }))
    return Promise.resolve(response(backups))
  })
  await start(fetcher)

  // 筛选仅可恢复与搜索关键词
  expect(wrapper!.get('[data-testid="backup-table"]').text()).toContain('损坏快照')
  await wrapper!.get('[data-testid="filter-restorable"] input').setValue(true)
  await flushPromises()
  expect(wrapper!.get('[data-testid="backup-table"]').text()).toContain('发布前快照')
  expect(wrapper!.get('[data-testid="backup-table"]').text()).not.toContain('损坏快照')
  await wrapper!.get('[data-testid="filter-restorable"] input').setValue(false)
  await wrapper!.get('input[aria-label="搜索备份"]').setValue('损坏')
  await flushPromises()
  expect(wrapper!.get('[data-testid="backup-table"]').text()).toContain('损坏快照')
  expect(wrapper!.get('[data-testid="backup-table"]').text()).not.toContain('发布前快照')

  // 删除损坏备份：确认后调用 DELETE 并从列表移除
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
  const info = vi.spyOn(ElMessage, 'info')
  await wrapper!.get('[data-testid="delete-backup-BK-BROKEN"]').trigger('click')
  await flushPromises()
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/api/v1/admin/backups/BK-BROKEN'), expect.objectContaining({ method: 'DELETE' }))
  expect(wrapper!.get('[data-testid="backup-table"]').text()).not.toContain('损坏快照')
  expect(info).not.toHaveBeenCalled()
})

it.each([
  [{ code: 'NOT_FOUND', message: 'The requested local mock resource was not found.' }, '当前后端未提供删除备份接口。'],
  [{ code: 'NOT_FOUND', message: '备份记录不存在。', fieldPath: 'backupId' }, '备份记录不存在。'],
])('删除返回 404 时显示对应中文提示并保留列表记录', async (error, message) => {
  const backup = { backupId: 'BK-VALID', name: '发布前快照', status: 'VALID', format: 'SYSTEM_SQLITE_V2', checksum: 'A'.repeat(64), createdAt: '2026-09-21T02:00:00Z' }
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response([backup]))
    .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ ok: false, error }) })
  await start(fetcher)
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
  await wrapper!.get('[data-testid="delete-backup-BK-VALID"]').trigger('click')
  await flushPromises()
  expect(wrapper!.get('[data-testid="backup-feedback"]').text()).toContain(message)
  expect(wrapper!.get('[data-testid="backup-table"]').text()).toContain('发布前快照')
})

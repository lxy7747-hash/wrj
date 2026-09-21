import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessageBox, ElMessage } from 'element-plus'
import BackupRestoreWizard from '../../src/components/admin/BackupRestoreWizard.vue'
import { useAdminStore } from '../../src/stores/admin'
import { useAuthStore } from '../../src/stores/auth'

let wrapper: VueWrapper | undefined
const plan = { version: 1, enabled: false, name: '备份计划', intervalMinutes: 1440 }
const status = { plan, nextRunAt: null, executions: [] }
const response = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data, meta: { requestId: 'REQ-PLAN', generatedAt: '2026-09-21T00:00:00Z', page: 1, pageSize: 1, total: 1 } }) }) as Response
beforeEach(() => { setActivePinia(createPinia()); useAuthStore().role = 'ADMIN' })
afterEach(() => { wrapper?.unmount(); wrapper = undefined; ElMessage.closeAll(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function start(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetcher)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/admin')
  wrapper = mount(BackupRestoreWizard, { global: { plugins: [ElementPlus, router] } })
  await flushPromises()
}

it('页面正式加载计划、编辑、取消与启用，显示执行记录且仅一次成功提示', async () => {
  const fetcher = vi.fn((url: string, init?: RequestInit) => Promise.resolve(response(url.endsWith('/backups') ? [] : init?.method === 'PUT'
    ? { plan: { ...JSON.parse(String(init.body)), version: 2 }, nextRunAt: '2026-09-22T00:00:00Z', executions: [{ startedAt: '2026-09-21T00:00:00Z', completedAt: '2026-09-21T00:01:00Z', result: 'SUCCESS', backupId: 'A', message: '完成' }, { startedAt: '2026-09-21T01:00:00Z', completedAt: '2026-09-21T01:01:00Z', result: 'FAILURE', backupId: null, message: '磁盘故障' }] } : status)))
  await start(fetcher)
  expect(wrapper!.text()).toContain('计划未启用')
  expect(wrapper!.text()).toContain('暂无执行记录')
  await wrapper!.get('input[aria-label="计划名称"]').setValue('每小时备份')
  await wrapper!.getComponent({ name: 'ElSwitch' }).trigger('click')
  wrapper!.getComponent({ name: 'ElInputNumber' }).vm.$emit('update:modelValue', 60)
  const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as never)
  const message = vi.spyOn(ElMessage, 'success')
  await wrapper!.get('[data-testid="backup-plan-save"]').trigger('click'); await flushPromises()
  expect(fetcher).toHaveBeenCalledTimes(2)
  await wrapper!.get('[data-testid="backup-plan-save"]').trigger('click'); await flushPromises()
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('每 60 分钟'), '保存备份计划', expect.anything())
  expect(useAdminStore().backupPlanStatus?.plan).toMatchObject({ name: '每小时备份', intervalMinutes: 60, enabled: true, version: 2 })
  expect(message).toHaveBeenCalledExactlyOnceWith('备份计划已保存。')
  expect(wrapper!.get('[data-testid="backup-executions"]').text()).toContain('磁盘故障')
  expect(wrapper!.text()).toContain('下次执行')
})

it('错误可重试，空备份名称不执行；计划确认在途离页失效', async () => {
  const fetcher = vi.fn((url: string) => Promise.resolve(response(url.endsWith('/backups') ? [] : {})))
  await start(fetcher)
  expect(wrapper!.get('[data-testid="backup-plan"]').text()).toContain('响应格式不正确')
  await wrapper!.get('input[aria-label="备份名称"]').setValue(' ')
  const error = vi.spyOn(ElMessage, 'error')
  await wrapper!.get('[data-testid="backup-create"]').trigger('click')
  expect(error).toHaveBeenCalledOnce()
  fetcher.mockImplementation((url: string) => Promise.resolve(response(url.endsWith('/backups') ? [] : status)))
  await wrapper!.findAll('button').find(button => button.text() === '刷新记录')!.trigger('click'); await flushPromises()
  let resolve!: () => void
  vi.spyOn(ElMessageBox, 'confirm').mockImplementation(() => new Promise(done => { resolve = () => done('confirm' as never) }))
  await wrapper!.get('[data-testid="backup-plan-save"]').trigger('click')
  const count = fetcher.mock.calls.length
  wrapper!.unmount(); wrapper = undefined
  resolve(); await flushPromises()
  expect(fetcher).toHaveBeenCalledTimes(count)
})

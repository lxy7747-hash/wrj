import { afterEach, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import MissionRecovery from '../../src/components/situation/MissionRecovery.vue'
import SimulationToolbar from '../../src/components/situation/SimulationToolbar.vue'
import { useAuthStore } from '../../src/stores/auth'

enableAutoUnmount(afterEach)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); ElMessage.closeAll() })
const record = { runId: 'RUN-OLD', scenarioId: 'SCN-OLD', pid: 321, canStop: true, message: '上次 Mission 仍在运行。' }
async function setup(role: 'ADMIN' | 'OPERATOR' = 'ADMIN', failure = false) {
  const pinia = createPinia(); setActivePinia(pinia)
  useAuthStore().$patch({ role, runtimeMode: 'LOCAL', permissions: ['SIMULATION_CONTROL'], principal: { userId: `USR-${role}`, username: role, role, permissions: ['SIMULATION_CONTROL'] } })
  let records = [record]
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (failure) return new Response(JSON.stringify({ ok: false, error: { message: '进程尚未退出，保留锁。' } }), { status: 409 })
      records = []
    }
    return new Response(JSON.stringify({ ok: true, data: records }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  const wrapper = mount(MissionRecovery, { global: { plugins: [pinia, ElementPlus] } })
  await flushPromises()
  return { wrapper, fetcher, pinia }
}

it('管理员可以停止后端重启后没有内存运行投影的遗留进程，并刷新页面锁状态', async () => {
  const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
  const success = vi.spyOn(ElMessage, 'success')
  const { wrapper, fetcher } = await setup()
  await wrapper.findAll('button').find(button => button.text() === '停止遗留运行')!.trigger('click')
  await flushPromises()
  expect(confirm).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toEqual([
    [expect.stringContaining('/api/v1/simulations/recovery/stop'), expect.objectContaining({ body: JSON.stringify({ runId: 'RUN-OLD' }) })],
  ])
  expect(wrapper.emitted('resolved')).toHaveLength(1)
  expect(wrapper.find('[data-testid="mission-recovery"]').exists()).toBe(false)
  expect(success).toHaveBeenCalledWith('遗留运行已停止，场景已解锁。')
})

it('取消停止不发送请求；停止失败保留可重试入口', async () => {
  const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel')
  const error = vi.spyOn(ElMessage, 'error')
  const { wrapper, fetcher } = await setup('ADMIN', true)
  const stop = () => wrapper.findAll('button').find(button => button.text() === '停止遗留运行')!
  await stop().trigger('click'); await flushPromises()
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  confirm.mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
  await stop().trigger('click'); await flushPromises()
  expect(error).toHaveBeenCalledWith('进程尚未退出，保留锁。')
  expect(wrapper.emitted('resolved')).toBeUndefined()
  expect(stop().exists()).toBe(true)
})

it('非管理员看到原因但不能停止遗留进程', async () => {
  const { wrapper } = await setup('OPERATOR')
  expect(wrapper.text()).toContain('请管理员停止遗留运行')
  expect(wrapper.findAll('button').some(button => button.text() === '停止遗留运行')).toBe(false)
})

it('态势页没有正在运行的投影时，仍提供可点击的遗留停止入口', async () => {
  const { wrapper: initial, pinia } = await setup()
  initial.unmount()
  const toolbar = mount(SimulationToolbar, { props: { status: 'IDLE', speed: 1, pending: false, capabilityState: 'ERROR', feedback: '检测到遗留运行', realMission: true }, global: { plugins: [pinia, ElementPlus] } })
  await flushPromises()
  expect(toolbar.get('[data-testid="simulation-stop"]').attributes('disabled')).toBeDefined()
  const stop = toolbar.findAll('button').find(button => button.text() === '停止遗留运行')!
  expect(stop.attributes('disabled')).toBeUndefined()
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
  await stop.trigger('click'); await flushPromises()
  expect(toolbar.emitted('recovered')).toHaveLength(1)
})

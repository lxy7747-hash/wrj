import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus, { ElSelect } from 'element-plus'
import { afterEach, expect, it, vi } from 'vitest'
import AccountManagement from '../../src/components/admin/AccountManagement.vue'
import { useAuthStore } from '../../src/stores/auth'

afterEach(() => vi.unstubAllGlobals())

it('账号按用户名、角色、状态取交集；无结果、重置与加载原记录一致', async () => {
  const users = [
    { userId: 'A', username: 'admin', role: 'ADMIN', status: 'ACTIVE' },
    { userId: 'B', username: 'Alpha', role: 'OPERATOR', status: 'ACTIVE' },
    { userId: 'C', username: 'Alpha-disabled', role: 'OPERATOR', status: 'DISABLED' },
    { userId: 'D', username: 'Beta', role: 'OPERATOR', status: 'LOCKED' },
  ]
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: users,
    meta: { requestId: 'QUERY', generatedAt: '2026-09-21T00:00:00Z', page: 1, pageSize: 4, total: 4 } }))))
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().role = 'ADMIN'
  const wrapper = mount(AccountManagement, { global: { plugins: [pinia, ElementPlus] } })
  try {
    await flushPromises()
    const table = () => wrapper.get('[data-testid="user-role-panel"]')
    const rows = () => table().findAll('.el-table__row')
    expect(rows()).toHaveLength(4)
    await wrapper.get('input[aria-label="筛选用户名"]').setValue('  ALPHA  ')
    expect(rows()).toHaveLength(2)
    const selects = wrapper.get('.user-filters').findAllComponents(ElSelect)
    // 组件事件与实际选择一致，记录仍经公开 HTTP 加载，不手改 Store 数据。
    selects[0]!.vm.$emit('update:modelValue', 'OPERATOR')
    selects[1]!.vm.$emit('update:modelValue', 'DISABLED')
    await flushPromises()
    expect(rows()).toHaveLength(1)
    expect(table().text()).toContain('Alpha-disabled')
    selects[0]!.vm.$emit('update:modelValue', 'ADMIN')
    await flushPromises()
    expect(rows()).toHaveLength(0)
    expect(table().text()).toContain('暂无匹配账号')
    await wrapper.findAll('button').find(button => button.text() === '重置筛选')!.trigger('click')
    expect(rows()).toHaveLength(4)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(users[2]!.status).toBe('DISABLED')
  } finally { wrapper.unmount() }
})

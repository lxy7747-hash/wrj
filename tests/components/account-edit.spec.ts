import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus, { ElSelect } from 'element-plus'
import { afterEach, expect, it, vi } from 'vitest'
import AccountManagement from '../../src/components/admin/AccountManagement.vue'
import { useAuthStore } from '../../src/stores/auth'

afterEach(() => vi.unstubAllGlobals())

const meta = { requestId: 'Q', generatedAt: '2026-10-27T00:00:00Z', page: 1, pageSize: 2, total: 2 }

function mountWith(fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>) {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => url.endsWith('/admin/access-control')
    ? Promise.resolve(new Response(JSON.stringify({ ok: true, data: { version: 1, profiles: [], assignments: [] } })))
    : fetchMock(url, init))
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.role = 'ADMIN'
  auth.principal = { userId: 'A', username: 'admin', role: 'ADMIN' } as never
  return mount(AccountManagement, { global: { plugins: [pinia, ElementPlus] }, attachTo: document.body })
}

it('修改用户提交 UPDATE，包含独立用户名、登录账号、角色和状态，并刷新列表', async () => {
  const users = [
    { userId: 'A', username: 'admin', role: 'ADMIN', status: 'ACTIVE' },
    { userId: 'B', username: 'op', role: 'OPERATOR', status: 'ACTIVE' },
  ]
  const updated = { userId: 'B', username: 'op2', displayName: '张三', role: 'ADMIN', status: 'DISABLED' }
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: users, meta })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: updated, meta })))
  const wrapper = mountWith(fetchMock)
  try {
    await flushPromises()
    expect(wrapper.get('[data-testid="user-role-panel"]').findAll('button').map(button => button.text())).toEqual(['修改', '删除', '修改', '删除'])
    expect(wrapper.findAll('button').some(button => button.text() === '角色权限配置')).toBe(true)
    await wrapper.get('[data-testid="edit-user-B"]').trigger('click')
    await flushPromises()
    const dialog = document.querySelector('[data-testid="edit-user-dialog"]')!
    const input = dialog.querySelector<HTMLInputElement>('[data-testid="edit-username"] input, input[data-testid="edit-username"]')!
    input.value = 'op2'
    input.dispatchEvent(new Event('input'))
    const nameInput = dialog.querySelector<HTMLInputElement>('[data-testid="edit-display-name"] input, input[data-testid="edit-display-name"]')!
    nameInput.value = '张三'
    nameInput.dispatchEvent(new Event('input'))
    const selects = wrapper.findAllComponents(ElSelect).filter(select => ['edit-role', 'edit-status'].includes(String(select.attributes('data-testid'))))
    expect(selects[0]!.element.closest('.el-form-item')?.querySelector('.el-form-item__label')?.textContent).toBe('基础角色')
    selects[0]!.vm.$emit('update:modelValue', 'ADMIN')
    selects[1]!.vm.$emit('update:modelValue', 'DISABLED')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(users[1]!.role).toBe('OPERATOR')
    document.querySelector<HTMLButtonElement>('[data-testid="save-user"]')!.click()
    await flushPromises()
    const [url, init] = fetchMock.mock.calls[1]!
    expect(String(url)).toContain('/api/v1/admin/users/B')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toMatchObject({ operation: 'UPDATE', user: updated })
    expect(wrapper.get('[data-testid="user-role-panel"]').text()).toContain('op2')
  } finally { wrapper.unmount() }
})

it('当前登录管理员修改时角色和状态锁定', async () => {
  const users = [
    { userId: 'A', username: 'admin', role: 'ADMIN', status: 'ACTIVE' },
    { userId: 'B', username: 'op', role: 'OPERATOR', status: 'ACTIVE' },
  ]
  const wrapper = mountWith(vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: users, meta }))))
  try {
    await flushPromises()
    await wrapper.get('[data-testid="edit-user-A"]').trigger('click')
    await flushPromises()
    const selects = wrapper.findAllComponents(ElSelect).filter(select => ['edit-role', 'edit-status'].includes(String(select.attributes('data-testid'))))
    expect(selects).toHaveLength(2)
    expect(selects.every(select => select.props('disabled'))).toBe(true)
    expect(document.body.textContent).toContain('角色和状态不可修改')
  } finally { wrapper.unmount() }
})

it.each(['ADMIN', 'OPERATOR'] as const)('禁用的 %s 账号在修改弹窗恢复启用，取消不改数据', async role => {
  const user = { userId: 'B', username: 'second', displayName: '第二账号', role, status: 'DISABLED' }
  const users = [{ userId: 'A', username: 'admin', role: 'ADMIN', status: 'ACTIVE' }, user]
  const updated = { ...user, status: 'ACTIVE' }
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: users, meta })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: updated, meta })))
  const wrapper = mountWith(fetchMock)
  try {
    await flushPromises()
    expect(wrapper.get('[data-testid="user-role-panel"]').findAll('button').map(button => button.text())).toEqual(['修改', '删除', '修改', '删除'])
    await wrapper.get('[data-testid="edit-user-B"]').trigger('click')
    await flushPromises()
    const status = () => wrapper.findAllComponents(ElSelect).find(select => select.attributes('data-testid') === 'edit-status')!
    const baseRole = wrapper.findAllComponents(ElSelect).find(select => select.attributes('data-testid') === 'edit-role')!
    expect(baseRole.props('disabled')).toBe(role === 'ADMIN')
    expect(status().props('disabled')).toBe(false)
    status().vm.$emit('update:modelValue', 'ACTIVE')
    await flushPromises()
    await wrapper.get('[data-testid="edit-user-dialog"]').findAll('button').find(button => button.text() === '取消')!.trigger('click')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(user.status).toBe('DISABLED')
    await wrapper.get('[data-testid="edit-user-B"]').trigger('click')
    await flushPromises()
    expect(status().props('modelValue')).toBe('DISABLED')
    status().vm.$emit('update:modelValue', 'ACTIVE')
    await flushPromises()
    await wrapper.get('[data-testid="edit-user-dialog"] form').trigger('submit')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ operation: 'UPDATE', user: updated })
    expect(wrapper.get('[data-testid="user-role-panel"]').findAll('.el-table__row')[1]!.text()).toContain('启用（ACTIVE）')
    expect(user.status).toBe('DISABLED')
  } finally { wrapper.unmount() }
})

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus, { ElOption, ElSelect } from 'element-plus'
import { afterEach, expect, it, vi } from 'vitest'
import AccountManagement from '../../src/components/admin/AccountManagement.vue'
import { useAuthStore } from '../../src/stores/auth'
import RoleProfiles from '../../src/components/admin/RoleProfiles.vue'

afterEach(() => vi.unstubAllGlobals())

const profiles = Array.from({ length: 5 }, (_, index) => ({ profileId: `ROLE-${index}`, name: `自定义角色${index}`, baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: ['/situation'] }))
const config = () => ({ version: 1, profiles, assignments: [{ userId: 'B', profileId: 'ROLE-0' }, { userId: 'C', profileId: 'ROLE-1' }, { userId: 'D', profileId: 'ROLE-1' }] })
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: status === 200, data,
  meta: { requestId: 'QUERY', generatedAt: '2026-09-21T00:00:00Z', page: 1, pageSize: 4, total: 4 } }), { status })

it('账号按用户名、基础角色、自定义角色、状态取交集；展示五种角色选项，无结果和重置正确', async () => {
  const users = [
    { userId: 'A', username: 'admin', role: 'ADMIN', status: 'ACTIVE' },
    { userId: 'B', username: 'account-one', displayName: 'Alpha', role: 'OPERATOR', status: 'ACTIVE' },
    { userId: 'C', username: 'account-two', displayName: 'Alpha-disabled', role: 'OPERATOR', status: 'DISABLED' },
    { userId: 'D', username: 'Alpha-account', displayName: 'Beta', role: 'OPERATOR', status: 'LOCKED' },
  ]
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith('/admin/users') ? users : config()))))
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().role = 'ADMIN'
  const wrapper = mount(AccountManagement, { global: { plugins: [pinia, ElementPlus] } })
  try {
    await flushPromises()
    const table = () => wrapper.get('[data-testid="user-role-panel"]')
    const rows = () => table().findAll('.el-table__row')
    expect(rows()).toHaveLength(4)
    expect(rows()[0]!.text()).toContain('未分配（使用基础权限）')
    expect(rows()[1]!.text()).toContain('自定义角色0（ROLE-0）')
    await wrapper.get('input[aria-label="筛选用户名"]').setValue('  ALPHA  ')
    expect(rows()).toHaveLength(2)
    expect(table().text()).toContain('account-one')
    expect(table().text()).not.toContain('Alpha-account')
    const selects = wrapper.get('.user-filters').findAllComponents(ElSelect)
    // 组件事件与实际选择一致，记录仍经公开 HTTP 加载，不手改 Store 数据。
    selects[0]!.vm.$emit('update:modelValue', 'OPERATOR')
    selects[1]!.vm.$emit('update:modelValue', 'DISABLED')
    expect(selects[2]!.findAllComponents(ElOption)).toHaveLength(6)
    expect(selects[2]!.findAllComponents(ElOption)[5]!.props('label')).toBe('自定义角色4（ROLE-4）')
    selects[2]!.vm.$emit('update:modelValue', 'ROLE-1')
    await flushPromises()
    expect(rows()).toHaveLength(1)
    expect(table().text()).toContain('Alpha-disabled')
    selects[2]!.vm.$emit('update:modelValue', 'ROLE-0')
    await flushPromises()
    expect(rows()).toHaveLength(0)
    selects[2]!.vm.$emit('update:modelValue', 'ROLE-1')
    selects[0]!.vm.$emit('update:modelValue', 'ADMIN')
    await flushPromises()
    expect(rows()).toHaveLength(0)
    expect(table().text()).toContain('暂无匹配账号')
    await wrapper.findAll('button').find(button => button.text() === '重置筛选')!.trigger('click')
    expect(rows()).toHaveLength(4)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(users[2]!.status).toBe('DISABLED')
  } finally { wrapper.unmount() }
})

it('角色读取失败显示未知状态并允许重试，不把未知绑定显示成未分配', async () => {
  let failed = true
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(url.endsWith('/admin/users')
    ? response([{ userId: 'B', username: 'bound', role: 'OPERATOR', status: 'ACTIVE' }])
    : failed ? response(undefined, 503) : response(config()))))
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().role = 'ADMIN'
  const wrapper = mount(AccountManagement, { global: { plugins: [pinia, ElementPlus] } })
  try {
    await flushPromises()
    const table = () => wrapper.get('[data-testid="user-role-panel"]')
    expect(table().text()).toContain('读取失败')
    expect(table().text()).not.toContain('未分配')
    expect(wrapper.get('[role="alert"]').text()).toContain('自定义角色读取失败')
    failed = false
    await wrapper.findAll('button').find(button => button.text() === '重试角色读取')!.trigger('click')
    await flushPromises()
    expect(table().text()).toContain('自定义角色0（ROLE-0）')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  } finally { wrapper.unmount() }
})

it('权限配置保存和通过修改弹窗变更基础角色后重新读取绑定，不继续展示旧角色', async () => {
  let user = { userId: 'B', username: 'bound', role: 'OPERATOR', status: 'ACTIVE' }
  let roles = config()
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith('/admin/users/B')) {
      user = JSON.parse(String(init?.body)).user
      roles = { ...roles, version: roles.version + 1, assignments: [] }
      return Promise.resolve(response(user))
    }
    return Promise.resolve(response(url.endsWith('/admin/users') ? [user] : roles))
  }))
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().role = 'ADMIN'
  const wrapper = mount(AccountManagement, { global: { plugins: [pinia, ElementPlus] } })
  try {
    await flushPromises()
    const table = () => wrapper.get('[data-testid="user-role-panel"]')
    expect(table().text()).toContain('自定义角色0（ROLE-0）')
    await wrapper.findAll('button').find(button => button.text() === '角色权限配置')!.trigger('click')
    await flushPromises()
    roles = { ...roles, version: 2, assignments: [{ userId: 'B', profileId: 'ROLE-1' }] }
    wrapper.findComponent(RoleProfiles).vm.$emit('saved')
    await flushPromises()
    expect(table().text()).toContain('自定义角色1（ROLE-1）')
    await wrapper.findAllComponents({ name: 'ElDialog' }).find(dialog => dialog.props('title') === '角色权限配置')!.get('.el-dialog__headerbtn').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="edit-user-B"]').trigger('click')
    await flushPromises()
    wrapper.findAllComponents(ElSelect).find(select => select.attributes('data-testid') === 'edit-role')!.vm.$emit('update:modelValue', 'ADMIN')
    await flushPromises()
    expect(table().text()).toContain('自定义角色1（ROLE-1）')
    expect(user.role).toBe('OPERATOR')
    await wrapper.get('[data-testid="edit-user-dialog"] form').trigger('submit')
    await flushPromises()
    expect(table().text()).toContain('管理员（ADMIN）')
    expect(table().text()).toContain('未分配（使用基础权限）')
    expect(table().text()).not.toContain('自定义角色1（ROLE-1）')
  } finally { wrapper.unmount() }
})

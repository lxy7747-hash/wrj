import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminPage from '../../src/pages/admin/admin.vue'
import { createAppRouter } from '../../src/router'
import { useAuthStore } from '../../src/stores/auth'
import { useAdminStore } from '../../src/stores/admin'
import { EQUIPMENT } from '../fixtures/equipment'
import fixtures from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'

enableAutoUnmount(afterEach)
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function response(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data, meta: { requestId: 'REQ-BASIC', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: Array.isArray(data) ? data.length : 1 } }))
}

async function setup(path = '/admin?section=master-data', menuPaths?: string[], loadEquipment?: () => Promise<Response>) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  const permissions = ['BUSINESS_READ', 'USER_ROLE_MAINTAIN', 'MASTER_DATA_MAINTAIN'] as const
  auth.$patch({ role: 'ADMIN', permissions: [...permissions], principal: { userId: 'USER-ADMIN', username: 'admin', role: 'ADMIN', permissions: [...permissions], ...(menuPaths ? { menuPaths } : {}) } })
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/admin/equipment')) return loadEquipment ? loadEquipment() : response([EQUIPMENT])
    if (url.endsWith('/admin/master-data')) return response(fixtures.masterData)
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  const router = createAppRouter(createMemoryHistory(), pinia)
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AdminPage, { global: { plugins: [pinia, router, ElementPlus] } })
  await flushPromises()
  return { wrapper, router, fetch, store: useAdminStore() }
}

describe('基础数据管理复用原装备与通用数据面板', () => {
  it('统一入口默认加载原装备库，分类切换只加载对应接口且不复制或新建数据', async () => {
    const { wrapper, router, fetch } = await setup()
    expect(wrapper.get('[data-testid="basic-data-management"]').attributes('aria-label')).toBe('基础数据管理')
    expect(wrapper.get('#tab-equipment').text()).toBe('设备参数')
    expect(wrapper.get('#tab-master').text()).toBe('通用基础数据')
    expect(wrapper.get('[data-testid="equipment-table"]').text()).toContain(EQUIPMENT.equipmentId)
    expect(wrapper.find('[data-testid="master-data-panel"]').exists()).toBe(false)

    await wrapper.get('#tab-master').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toMatchObject({ section: 'master-data', category: 'master' })
    expect(wrapper.find('[data-testid="equipment-library"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="master-table"]').text()).toContain('MW-COMM')
    expect(wrapper.findAll('h2').map(heading => heading.text())).toEqual(['基础数据管理'])
    expect(wrapper.find('h3').exists()).toBe(false)

    await wrapper.get('#tab-equipment').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="equipment-table"]').text()).toContain(EQUIPMENT.equipmentId)
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/v1/admin/equipment', '/api/v1/admin/master-data', '/api/v1/admin/equipment'])
  })

  it('旧装备链接打开同一合并页面，刷新时按已选择分类加载', async () => {
    const { wrapper, router, fetch } = await setup('/admin?section=equipment-library')
    expect(wrapper.findAll('[data-testid="equipment-library"]')).toHaveLength(1)
    expect(wrapper.get('#tab-equipment').attributes('aria-selected')).toBe('true')
    await router.replace('/admin?section=master-data&category=master')
    await flushPromises()
    expect(wrapper.get('#tab-master').attributes('aria-selected')).toBe('true')
    expect(fetch.mock.calls.at(-1)?.[0]).toContain('/admin/master-data')
  })

  it.each([
    { key: '/admin?section=equipment-library', tab: 'equipment', hidden: 'master', category: 'master', endpoint: '/admin/master-data' },
    { key: '/admin?section=master-data', tab: 'master', hidden: 'equipment', category: 'equipment', endpoint: '/admin/equipment' },
  ])('旧分类授权 $tab 不因合并而获得其他分类权限', async ({ key, tab, hidden, category, endpoint }) => {
    const { wrapper, router, fetch } = await setup('/admin?section=master-data', [key, '/admin'])
    expect(wrapper.get(`#tab-${tab}`).attributes('aria-selected')).toBe('true')
    expect(wrapper.find(`#tab-${hidden}`).exists()).toBe(false)
    await router.push(`/admin?section=master-data&category=${category}`)
    await flushPromises()
    expect(router.currentRoute.value.query.category).not.toBe(category)
    expect(fetch.mock.calls.some(([url]) => url.endsWith(endpoint))).toBe(false)
  })

  it('切换分类后迟到的装备响应不能覆盖新分类或恢复旧数据', async () => {
    let finish!: (response: Response) => void
    const { wrapper, store } = await setup('/admin?section=master-data', undefined,
      () => new Promise<Response>(resolve => { finish = resolve }))
    await wrapper.get('#tab-master').trigger('click')
    await flushPromises()
    finish(response([EQUIPMENT]))
    await flushPromises()
    expect(store.equipment).toEqual([])
    expect(store.maintenance.master.state).toBe('SUCCESS')
    expect(wrapper.get('[data-testid="master-table"]').text()).toContain('MW-COMM')
    expect(wrapper.find('[data-testid="equipment-library"]').exists()).toBe(false)
  })
})

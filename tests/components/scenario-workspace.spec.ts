import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus, { ElMessage, ElMessageBox, ElSelect } from 'element-plus'
import Workspace from '../../src/pages/scenarios/ScenarioWorkspace.vue'
import { useScenarioStore } from '../../src/stores/scenario'
import { useAuthStore } from '../../src/stores/auth'
import type { ScenarioDraft } from '../../src/contracts/domain-models'

const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { TemplateProjection } = await import('../../server/templates/' + 'projection.js')
const Editor = defineComponent({
  emits: ['saved', 'back'],
  template: '<div data-testid="editor"><button @click="$emit(\'saved\')">保存完成</button><button @click="$emit(\'back\')">返回</button></div>',
})
enableAutoUnmount(afterEach)
beforeEach(() => { sessionStorage.clear() })
afterEach(() => {
  ElMessage.closeAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  sessionStorage.clear()
})

async function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ principal: { userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['SCENARIO_DRAFT_WRITE'] }, role: 'OPERATOR', permissions: ['SCENARIO_DRAFT_WRITE'] })
  const scenes = new ScenarioProjection()
  const templates = new TemplateProjection()
  const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    let result
    if (path === '/api/v1/templates') result = { ok: true, data: templates.list() }
    else if (path.endsWith('/copy')) {
      const body = JSON.parse(String(init?.body))
      result = scenes.copyTemplate(templates.list()[0]!.config, body.name, undefined, body.scenarioId)
    } else if (init?.method === 'DELETE') {
      result = scenes.delete(path.split('/').at(-1)!, { expectedRevision: Number(new URL(url).searchParams.get('expectedRevision')) })
    } else if (path === '/api/v1/scenarios') result = { ok: true, data: scenes.list() }
    else result = scenes.get(path.split('/').at(-1)!)
    return new Response(JSON.stringify(result), { status: result.ok ? 200 : result.status })
  })
  vi.stubGlobal('fetch', fetchSpy)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/scenarios', component: Workspace },
    { path: '/other', component: { template: '<p>other</p>' } },
    { path: '/login', component: { template: '<p>login</p>' } },
  ] })
  await router.push('/scenarios')
  await router.isReady()
  const wrapper = mount({ template: '<router-view />' }, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus], stubs: { ScenarioEditor: Editor } } })
  await flushPromises()
  return { wrapper, router, store: useScenarioStore(), scenes, templates, fetchSpy }
}

it('从列表按编号编辑、保存返回、刷新；复制使用独立草稿且不改来源', async () => {
  const { wrapper, store, scenes } = await setup()
  const original = scenes.get('SCN-001')
  expect(wrapper.get('[data-testid="scene-table"]').text()).toContain('跨海通联演示')
  await wrapper.get('[data-testid="scene-edit-SCN-001"]').trigger('click')
  await flushPromises()
  expect(store.draft?.config.scenario.id).toBe('SCN-001')
  await wrapper.get('[data-testid="editor"] button').trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-testid="scene-list"]').exists()).toBe(true)
  expect(store.draft).toBeNull()
  await wrapper.findAll('button').find(b => b.text() === '刷新')!.trigger('click')
  await flushPromises()
  await wrapper.get('[data-testid="scene-copy-SCN-001"]').trigger('click')
  await flushPromises()
  expect(store.draft?.config.scenario.id).not.toBe('SCN-001')
  expect(store.draft?.config.scenario.name).toBe('跨海通联演示 副本')
  expect(store.dirty).toBe(true)
  expect(scenes.get('SCN-001')).toEqual(original)
})

it('新建后返回列表须确认丢弃；取消继续编辑，确认后清除草稿', async () => {
  const { wrapper, store } = await setup()
  await wrapper.get('[data-testid="scene-create"]').trigger('click')
  expect(store.draft?.revision).toBe(0)
  const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValueOnce('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
  await wrapper.findAll('button').find(b => b.text() === '返回')!.trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-testid="editor"]').exists()).toBe(true)
  expect(store.dirty).toBe(true)
  await wrapper.findAll('button').find(b => b.text() === '返回')!.trigger('click')
  await flushPromises()
  expect(confirm).toHaveBeenCalledTimes(2)
  expect(wrapper.find('[data-testid="scene-list"]').exists()).toBe(true)
  expect(store.currentScenarioId).toBeNull()
})

it('路由离开保护未保存草稿，确认后清空；去登录页不阻塞登出', async () => {
  const { wrapper, router, store } = await setup()
  await wrapper.get('[data-testid="scene-create"]').trigger('click')
  vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValueOnce('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
  await router.push('/other')
  expect(router.currentRoute.value.path).toBe('/scenarios')
  await router.push('/other')
  expect(store.draft).toBeNull()
  await router.push('/scenarios')
  await flushPromises()
  await wrapper.get('[data-testid="scene-create"]').trigger('click')
  await router.push('/login')
  expect(router.currentRoute.value.path).toBe('/login')
})

it('删除取消不发请求，确认删除刷新列表；存储失败保留场景并显示错误', async () => {
  const { wrapper, scenes, fetchSpy } = await setup()
  vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
  const success = vi.spyOn(ElMessage, 'success')
  await wrapper.get('[data-testid="scene-delete-SCN-001"]').trigger('click')
  await flushPromises()
  expect(fetchSpy.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  fetchSpy.mockRejectedValueOnce(new Error('storage unavailable'))
  await wrapper.get('[data-testid="scene-delete-SCN-001"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('场景删除失败')
  expect(scenes.list()).toHaveLength(1)
  expect(success).not.toHaveBeenCalled()
  await wrapper.get('[data-testid="scene-delete-SCN-001"]').trigger('click')
  await flushPromises()
  expect(scenes.list()).toEqual([])
  expect(wrapper.text()).toContain('暂无场景')
  expect(success).toHaveBeenCalledWith('场景已删除。')
})

it('加载场景失败返回列表，锁定场景只能查看且禁止删除，无权限不能新建', async () => {
  const { wrapper, scenes, fetchSpy } = await setup()
  const error = vi.spyOn(ElMessage, 'error')
  fetchSpy.mockRejectedValueOnce(new Error('offline'))
  await wrapper.get('[data-testid="scene-edit-SCN-001"]').trigger('click')
  await flushPromises()
  expect(error).toHaveBeenCalled()
  expect(wrapper.find('[data-testid="editor"]').exists()).toBe(false)
  scenes.setLocked('SCN-001', true)
  await wrapper.findAll('button').find(b => b.text() === '刷新')!.trigger('click')
  await flushPromises()
  expect(wrapper.get('[data-testid="scene-edit-SCN-001"]').text()).toBe('查看')
  expect(wrapper.get('[data-testid="scene-delete-SCN-001"]').attributes('disabled')).toBeDefined()
  useAuthStore().permissions = []
  await flushPromises()
  expect(wrapper.get('[data-testid="scene-create"]').attributes('disabled')).toBeDefined()
})

it('从模板创建独立场景并返回列表，取消模板对话框不创建', async () => {
  const { wrapper, scenes } = await setup()
  await wrapper.get('[data-testid="scene-from-template"]').trigger('click')
  await flushPromises()
  wrapper.findComponent(ElSelect).vm.$emit('update:modelValue', 'TPL-SCN-001')
  await wrapper.get('[data-testid="scene-template-name"]').setValue('模板新场景')
  await wrapper.get('[data-testid="scene-template-confirm"]').trigger('click')
  await flushPromises()
  expect(scenes.list()).toHaveLength(2)
  const created = scenes.list().find((s: ScenarioDraft) => s.config.scenario.name === '模板新场景')!
  expect(created.config.scenario.id).not.toBe('SCN-001')
  expect(wrapper.text()).toContain('模板新场景')
  await wrapper.get('[data-testid="scene-from-template"]').trigger('click')
  await flushPromises()
  await wrapper.findAll('button').find(b => b.text() === '取消')!.trigger('click')
  expect(scenes.list()).toHaveLength(2)
})

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, isProxy } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus, { ElMessage, ElMessageBox, ElSelect } from 'element-plus'
import Workspace from '../../src/pages/scenarios/ScenarioWorkspace.vue'
import { useScenarioStore } from '../../src/stores/scenario'
import { useAuthStore } from '../../src/stores/auth'
import { useSimulationStore } from '../../src/stores/simulation'
import type { ScenarioDraft } from '../../src/contracts/domain-models'
import { createScenarioSnapshot } from '../../src/features/scenarios/scenario-snapshot'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'
import { createTemplateScenario } from '../fixtures/template-scenario'

const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { TemplateProjection } = await import('../../server/templates/' + 'projection.js')
const { ScriptProjection } = await import('../../server/scripts/' + 'projection.js')
const { ConfirmationProjection } = await import('../../server/confirmations/' + 'projection.js')
const Editor = defineComponent({
  emits: ['saved', 'back'],
  template: '<div data-testid="editor"><button @click="$emit(\'saved\')">保存完成</button><button @click="$emit(\'back\')">返回</button></div>',
})

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
}

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
  const template = templates.list()[0]!
  Object.assign(template.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
  expect(templates.update(template.templateId, { name: template.name, config: template.config }).ok).toBe(true)
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
    { path: '/situation', component: { template: '<p>态势主界面</p>' } },
    { path: '/other', component: { template: '<p>other</p>' } },
    { path: '/login', component: { template: '<p>login</p>' } },
  ] })
  await router.push('/scenarios')
  await router.isReady()
  const wrapper = mount({ template: '<router-view />' }, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus], stubs: { ScenarioEditor: Editor } } })
  await flushPromises()
  return { wrapper, router, store: useScenarioStore(), scenes, templates, fetchSpy }
}

it('列表选用指定场景成功后跳转态势页，不打开编辑器', async () => {
  const { wrapper, router, store } = await setup()
  const select = vi.spyOn(useSimulationStore(), 'selectScene').mockResolvedValue(true)
  await wrapper.get('[data-testid="scene-select-SCN-001"]').trigger('click')
  await flushPromises()
  expect(select).toHaveBeenCalledExactlyOnceWith('SCN-001', expect.any(AbortSignal))
  expect(router.currentRoute.value.path).toBe('/situation')
  expect(wrapper.text()).toContain('态势主界面')
  expect(store.draft).toBeNull()
})

it('选用失败显示原因并留在列表，可再次选择', async () => {
  const { wrapper, router } = await setup()
  const simulation = useSimulationStore()
  const select = vi.spyOn(simulation, 'selectScene').mockImplementation(async () => {
    simulation.resultMessage = '场景已删除，请刷新列表。'
    return false
  })
  const error = vi.spyOn(ElMessage, 'error')
  await wrapper.get('[data-testid="scene-select-SCN-001"]').trigger('click')
  await flushPromises()
  expect(select).toHaveBeenCalledOnce()
  expect(error).toHaveBeenCalledWith('场景已删除，请刷新列表。')
  expect(router.currentRoute.value.path).toBe('/scenarios')
  expect(wrapper.get('[data-testid="scene-select-SCN-001"]').attributes('disabled')).toBeUndefined()
})

it('选用请求期间禁止重复点击，离页后迟到结果不跳转', async () => {
  const { wrapper, router } = await setup()
  let resolveSelection!: (selected: boolean) => void
  const select = vi.spyOn(useSimulationStore(), 'selectScene').mockReturnValue(new Promise<boolean>(resolve => { resolveSelection = resolve }))
  await wrapper.get('[data-testid="scene-select-SCN-001"]').trigger('click')
  expect(wrapper.get('[data-testid="scene-select-SCN-001"]').attributes('disabled')).toBeDefined()
  await wrapper.get('[data-testid="scene-select-SCN-001"]').trigger('click')
  expect(select).toHaveBeenCalledOnce()
  await router.push('/other')
  await flushPromises()
  expect(select.mock.calls[0]![1]?.aborted).toBe(true)
  resolveSelection(true)
  await flushPromises()
  expect(router.currentRoute.value.path).toBe('/other')
})

it('列表选用入口保留已有请求和运行锁禁用条件', async () => {
  const { wrapper } = await setup()
  const simulation = useSimulationStore()
  const select = vi.spyOn(simulation, 'selectScene')
  simulation.capabilityState = 'LOADING'
  await flushPromises()
  expect(wrapper.get('[data-testid="scene-select-SCN-001"]').attributes('disabled')).toBeDefined()
  simulation.capabilityState = 'EMPTY'
  const { run } = await import('../../frontend-technical-design-v1/contracts/deterministic-fixtures.json')
  simulation.run = { ...structuredClone(run), configLocked: true } as NonNullable<typeof simulation.run>
  await flushPromises()
  await wrapper.get('[data-testid="scene-select-SCN-001"]').trigger('click')
  expect(wrapper.get('[data-testid="scene-select-SCN-001"]').attributes('disabled')).toBeDefined()
  expect(select).not.toHaveBeenCalled()
})

it.each(['刷新', '重新进入'])('本机运行结束后%s列表同步运行锁，恢复选用场景', async action => {
  const { wrapper, router, store, scenes, fetchSpy } = await setup()
  const simulation = useSimulationStore()
  useAuthStore().runtimeMode = 'LOCAL'
  const { run } = await import('../../frontend-technical-design-v1/contracts/deterministic-fixtures.json')
  const running = { ...structuredClone(run), uiStatus: 'RUNNING', configLocked: true,
    canonical: { ...run.canonical, status: 'RUNNING' } } as NonNullable<typeof simulation.run>
  simulation.applyRun(running)
  scenes.setLocked('SCN-001', true)
  await store.loadScenes()
  await flushPromises()
  expect(wrapper.get('[data-testid="scene-select-SCN-001"]').attributes('disabled')).toBeDefined()

  scenes.setLocked('SCN-001', false)
  const stopped = { ...running, uiStatus: 'COMPLETED', configLocked: false,
    canonical: { ...running.canonical, status: 'COMPLETED', processId: null } }
  const originalFetch = fetchSpy.getMockImplementation()!
  fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => new URL(url).pathname === '/api/v1/simulations'
    ? new Response(JSON.stringify({ ok: true, data: [stopped] })) : originalFetch(url, init))
  if (action === '刷新') await wrapper.findAll('button').find(button => button.text() === '刷新')!.trigger('click')
  else { await router.push('/other'); await router.push('/scenarios') }
  await flushPromises()
  expect(wrapper.get('[data-testid="scene-table"]').text()).not.toContain('运行中 · 已锁定')
  expect(simulation.run).toMatchObject({ uiStatus: 'COMPLETED', configLocked: false })
  expect(wrapper.get('[data-testid="scene-select-SCN-001"]').attributes('disabled')).toBeUndefined()
})

it('返回列表时等待本机进程收尾，解锁后自动更新且不再轮询', async () => {
  const { wrapper, scenes, fetchSpy } = await setup()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    useAuthStore().runtimeMode = 'LOCAL'
    const { run } = await import('../../frontend-technical-design-v1/contracts/deterministic-fixtures.json')
    const state = { ...structuredClone(run), uiStatus: 'RUNNING', configLocked: true, canonical: { ...run.canonical, status: 'RUNNING' } }
    scenes.setLocked('SCN-001', true)
    const originalFetch = fetchSpy.getMockImplementation()!
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => new URL(url).pathname === '/api/v1/simulations'
      ? new Response(JSON.stringify({ ok: true, data: [state] })) : originalFetch(url, init))
    await wrapper.findAll('button').find(button => button.text() === '刷新')!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="scene-select-SCN-001"]').attributes('disabled')).toBeDefined()
    state.uiStatus = 'STOPPED'; state.configLocked = false; state.canonical.status = 'IDLE'
    scenes.setLocked('SCN-001', false)
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(wrapper.get('[data-testid="scene-select-SCN-001"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="scene-table"]').text()).not.toContain('运行中 · 已锁定')
    const count = fetchSpy.mock.calls.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchSpy.mock.calls.length).toBe(count)
  } finally { vi.useRealTimers() }
})

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

it('列表按北京时间显示创建时间到秒，旧场景没有时间时显示暂无数据', async () => {
  const { wrapper, scenes, store, fetchSpy } = await setup()
  const { createdAt: _unused, ...legacy } = scenes.list()[0]!
  const recent = structuredClone(legacy)
  recent.config.scenario.id = 'SCN-TIMED'
  recent.config.scenario.name = '带创建时间的场景'
  fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: [
    legacy, { ...recent, createdAt: '2026-11-17T05:14:09.123Z' },
  ] }), { status: 200 }))
  expect(await store.loadScenes()).toBe(true)
  await flushPromises()
  expect(wrapper.findAll('th').some(header => header.text() === '创建时间')).toBe(true)
  expect(wrapper.text()).toContain('2026-11-17 13:14:09')
  expect(wrapper.text()).toContain('暂无数据')
})

it('默认按创建时间降序排列，支持表头升序/降序切换，无时间旧场景始终排在末尾且刷新/返回不丢失', async () => {
  const { wrapper, scenes, store, fetchSpy } = await setup()
  const { createdAt: _unused, ...legacy } = scenes.list()[0]!
  const makeScene = (id: `SCN-${string}`, name: string, createdAt?: string): ScenarioDraft => {
    const draft = structuredClone(legacy) as ScenarioDraft
    draft.config.scenario.id = id
    draft.config.scenario.name = name
    if (createdAt !== undefined) draft.createdAt = createdAt
    return draft
  }
  const older = makeScene('SCN-OLDER', '最早创建场景', '2026-11-16T08:00:00Z')
  const sameA = makeScene('SCN-SAME-A', '同时刻场景甲', '2026-11-17T05:14:09.123Z')
  const newer = makeScene('SCN-NEWER', '最新创建场景', '2026-11-18T12:30:00.000Z')
  const sameB = makeScene('SCN-SAME-B', '同时刻场景乙', '2026-11-17T05:14:09.123Z')
  const payload = [legacy, older, sameA, newer, sameB]

  const originalFetch = fetchSpy.getMockImplementation()!
  fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => new URL(url).pathname === '/api/v1/scenarios'
    ? new Response(JSON.stringify({ ok: true, data: payload }), { status: 200 })
    : originalFetch(url, init))

  expect(await store.loadScenes()).toBe(true)
  await flushPromises()

  const rowNames = () => wrapper.findAll('[data-testid="scene-table"] .el-table__body-wrapper tbody tr')
    .map(row => row.findAll('td')[2]!.text())
  const createdAtHeader = () => wrapper.findAll('[data-testid="scene-table"] th')
    .find(header => header.text() === '创建时间')!

  // 默认按创建时间降序排列（最新在前，同时刻保持相对顺序，无创建时间排末尾）
  expect(createdAtHeader().classes()).toContain('descending')
  expect(rowNames()).toEqual(['最新创建场景', '同时刻场景甲', '同时刻场景乙', '最早创建场景', '跨海通联演示'])

  // 列表刷新后仍保持降序排列
  await wrapper.findAll('button').find(button => button.text() === '刷新')!.trigger('click')
  await flushPromises()
  expect(rowNames()).toEqual(['最新创建场景', '同时刻场景甲', '同时刻场景乙', '最早创建场景', '跨海通联演示'])

  // 排序后点击行操作仍对应正确的场景，返回列表后保持降序与指示器高亮
  await wrapper.get('[data-testid="scene-edit-SCN-001"]').trigger('click')
  await flushPromises()
  expect(store.draft?.config.scenario.id).toBe('SCN-001')
  await wrapper.get('[data-testid="editor"]').findAll('button').find(b => b.text() === '返回')!.trigger('click')
  await flushPromises()
  expect(createdAtHeader().classes()).toContain('descending')
  expect(rowNames()).toEqual(['最新创建场景', '同时刻场景甲', '同时刻场景乙', '最早创建场景', '跨海通联演示'])

  // 第 1 次点击：切换为按创建时间升序（最早在前，无创建时间仍排末尾）
  await createdAtHeader().trigger('click')
  await flushPromises()
  expect(createdAtHeader().classes()).toContain('ascending')
  expect(rowNames()).toEqual(['最早创建场景', '同时刻场景甲', '同时刻场景乙', '最新创建场景', '跨海通联演示'])

  // 第 2 次点击：切回降序（最新在前）
  await createdAtHeader().trigger('click')
  await flushPromises()
  expect(createdAtHeader().classes()).toContain('descending')
  expect(rowNames()).toEqual(['最新创建场景', '同时刻场景甲', '同时刻场景乙', '最早创建场景', '跨海通联演示'])
})

it.each([false, true])('批量删除跳过锁定场景、只刷新一次并报告结果（部分失败 %s）', async partialFailure => {
  const { wrapper, scenes, store, templates, fetchSpy } = await setup()
  const template = templates.list()[0]!
  expect(scenes.copyTemplate(template.config, '第二个可选场景', undefined, 'SCN-BATCH-B').ok).toBe(true)
  expect(scenes.copyTemplate(template.config, '锁定场景', undefined, 'SCN-BATCH-LOCKED').ok).toBe(true)
  expect(scenes.setLocked('SCN-BATCH-LOCKED', true).ok).toBe(true)
  expect(await store.loadScenes()).toBe(true)
  await flushPromises()

  const batch = () => wrapper.get('[data-testid="scene-bulk-delete"]')
  const rows = () => wrapper.findAll<HTMLInputElement>('.el-table__body-wrapper input[type="checkbox"]')
  expect(batch().attributes('disabled')).toBeDefined()
  expect(rows().filter(input => input.element.disabled)).toHaveLength(1)
  await wrapper.get('.el-table__header-wrapper input[type="checkbox"]').setValue(true)
  await vi.waitFor(() => expect(rows().filter(input => input.element.checked)).toHaveLength(2))
  expect(batch().attributes('disabled')).toBeUndefined()
  vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
  const success = vi.spyOn(ElMessage, 'success')
  const warning = vi.spyOn(ElMessage, 'warning')
  fetchSpy.mockClear()
  await batch().trigger('click')
  await flushPromises()
  expect(fetchSpy).not.toHaveBeenCalled()

  // 列表快照之后另一客户端可能先启动场景，必须由原删除接口拒绝。
  if (partialFailure) expect(scenes.setLocked('SCN-BATCH-B', true).ok).toBe(true)
  const revisions = new Map(store.scenes.map(scene => [scene.config.scenario.id, scene.revision]))
  await batch().trigger('click')
  await flushPromises()
  const deletes = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => new URL(url))
  expect(deletes.map(url => [url.pathname.split('/').at(-1), url.searchParams.get('expectedRevision')])).toEqual([
    ['SCN-BATCH-B', String(revisions.get('SCN-BATCH-B'))], ['SCN-001', String(revisions.get('SCN-001'))],
  ])
  expect(fetchSpy.mock.calls.filter(([url]) => new URL(url).pathname === '/api/v1/scenarios')).toHaveLength(1)
  expect(scenes.list().map((scene: ScenarioDraft) => scene.config.scenario.id)).toEqual(
    partialFailure ? ['SCN-BATCH-B', 'SCN-BATCH-LOCKED'] : ['SCN-BATCH-LOCKED'],
  )
  if (partialFailure) expect(warning).toHaveBeenCalledWith(expect.stringContaining('已删除 1 个场景，1 个未删除。'))
  else expect(success).toHaveBeenCalledWith('已删除 2 个场景。')
  expect(batch().attributes('disabled')).toBeDefined()
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
  expect(wrapper.find('[data-testid="scene-bulk-delete"]').exists()).toBe(false)
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

it('从响应式列表导出完整场景文件，不向 structuredClone 传入 Proxy 且保留原生 ESM 扩展', async () => {
  const { wrapper, store } = await setup()
  const scene = store.scenes[0]!
  scene.uiExtensions.sensors[0]!.esm = { sensitivityDbw: -200, detectionThresholdDb: 0, dwellTimeS: 1, revisitTimeS: 1 }
  expect(isProxy(scene)).toBe(true)
  let captured: Blob | undefined
  vi.stubGlobal('URL', { createObjectURL: vi.fn((blob: Blob) => { captured = blob; return 'blob:scene-export' }), revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

  await wrapper.get('[data-testid="scene-export-SCN-001"]').trigger('click')

  expect(captured).toBeInstanceOf(Blob)
  const snapshot = JSON.parse(await readBlobText(captured!))
  expect(snapshot).toMatchObject({
    format: 'wrj.scenario.snapshot', version: 1,
    config: { schemaVersion: '1.0', scenario: { id: 'SCN-001' } },
    uiExtensions: { sensors: [{ sensorId: 'ESM-01', esm: scene.uiExtensions.sensors[0]!.esm }] },
  })
})

const scriptPath = 'H:/Project/newWrj/frontend/output/scripts/script-import/scenario.txt'

async function setupImport(options: { warnings?: boolean; previewFailure?: boolean; writeFailure?: boolean; staleVersion?: boolean } = {}) {
  const context = await setup()
  const fallback = context.fetchSpy.getMockImplementation()!
  const scripts = new ScriptProjection()
  const confirmations = new ConfirmationProjection()
  const draft = createTemplateScenario()
  draft.config.scenario.id = 'SCN-IMPORT'
  draft.config.scenario.name = '导入生成验证'
  if (options.warnings) draft.config.scenario.environment.rainRateMmPerHour = 101
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
  const failure = (code: string, message: string, status: number) => response({ ok: false, error: { code, message } }, status)
  context.fetchSpy.mockImplementation(async (url, init) => {
    const path = new URL(url).pathname
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (path === '/api/v1/scenarios/import') {
      const result = context.scenes.importSnapshots(body)
      return result.ok ? response(result) : failure(result.code, result.message, result.status)
    }
    if (path.endsWith('/validate')) {
      return response({ ok: true, data: inspectScenarioConfig(body.config, 'write').result })
    }
    if (path === '/api/v1/confirmations') {
      return response({ ok: true, data: confirmations.create(body.action, body.objectId, 'OPERATOR') })
    }
    if (path.startsWith('/api/v1/confirmations/')) {
      expect(body).toEqual({ confirm: true })
      return response(confirmations.confirm(path.split('/').at(-1)!, 'OPERATOR'))
    }
    if (path === '/api/v1/scripts/preview') {
      if (options.previewFailure) return failure('VALIDATION_FAILED', '无法生成通信设备脚本。', 422)
      if (options.warnings) {
        if (!body.warningConfirmationId) return failure('CONFIRMATION_REQUIRED', '场景存在校验警告。', 428)
        expect(confirmations.consume(body.warningConfirmationId, 'SCENARIO_WARNING_CONTINUE', body.scenarioId, 'OPERATOR').ok).toBe(true)
      }
      const saved = context.scenes.get(body.scenarioId)
      if (!saved.ok) throw new Error(saved.message)
      const script = scripts.preview(saved.data)
      return response({ ok: true, data: options.staleVersion ? { ...script, configVersion: 'SCN-IMPORT-v0' } : script })
    }
    if (path.endsWith('/local-file')) {
      if (options.writeFailure) return failure('START_FAILED', 'TXT 目录不可写。', 503)
      const script = scripts.get(path.split('/').at(-2)!)!
      expect(body).toEqual({ checksum: script.checksum })
      expect(context.store.draft?.revision).toBe(1)
      expect(context.store.dirty).toBe(false)
      return response({ ok: true, data: { scriptId: script.scriptId, configVersion: script.configVersion, path: scriptPath } })
    }
    return fallback(url, init)
  })
  context.fetchSpy.mockClear()
  return { ...context, draft, paths: () => context.fetchSpy.mock.calls.map(([url]) => new URL(url).pathname) }
}

async function importFile(wrapper: VueWrapper, draft: ScenarioDraft, version = 1, schemaVersion = '1.0'): Promise<void> {
  const input = wrapper.get<HTMLInputElement>('[data-testid="scene-import-file"]')
  const snapshot = createScenarioSnapshot(draft)
  const payload = { ...snapshot, version, config: { ...snapshot.config, schemaVersion } }
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const file = new File([bytes], 'scene.json', { type: 'application/json' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
  Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
  await input.trigger('change')
  await flushPromises()
}

it.each([{ version: 1, schemaVersion: '1.0' }, { version: 37, schemaVersion: '25.75' }])(
  'JSON 快照 $version / $schemaVersion 导入保存后写 TXT，刷新列表且不启动仿真', async ({ version, schemaVersion }) => {
  const { wrapper, store, scenes, draft, paths } = await setupImport()
  const success = vi.spyOn(ElMessage, 'success')
  const warning = vi.spyOn(ElMessage, 'warning')
  await importFile(wrapper, draft, version, schemaVersion)
  expect(paths()).toEqual([
    '/api/v1/scenarios/import', '/api/v1/scenarios/SCN-IMPORT/validate', '/api/v1/scripts/preview',
    expect.stringMatching(/^\/api\/v1\/scripts\/[^/]+\/local-file$/u), '/api/v1/scenarios',
  ])
  expect(success).toHaveBeenCalledExactlyOnceWith('已导入场景“导入生成验证”。')
  expect(warning).not.toHaveBeenCalled()
  expect(wrapper.text()).toContain('导入生成验证')
  expect(scenes.get(draft.config.scenario.id)).toMatchObject({ ok: true, data: { config: { schemaVersion: '1.0' } } })
  expect(store.draft).toBeNull()
  expect(wrapper.get('[data-testid="scene-import-json"]').attributes('disabled')).toBeUndefined()
})

it.each([
  { options: { previewFailure: true }, message: '无法生成通信设备脚本。', writes: 0 },
  { options: { writeFailure: true }, message: 'TXT 目录不可写。', writes: 1 },
  { options: { staleVersion: true }, message: '脚本版本与导入场景不一致。', writes: 0 },
])('TXT 未生成（$message）不回滚导入，警告说明重试入口并刷新列表', async ({ options, message, writes }) => {
  const { wrapper, scenes, draft, paths } = await setupImport(options)
  const warning = vi.spyOn(ElMessage, 'warning')
  const success = vi.spyOn(ElMessage, 'success')
  await importFile(wrapper, draft)
  expect(warning).toHaveBeenCalledExactlyOnceWith(`已导入场景“导入生成验证”，但 TXT 未生成：${message} 可进入场景点击“保存”重试。`)
  expect(success).not.toHaveBeenCalled()
  expect(paths().filter(path => path.endsWith('/local-file'))).toHaveLength(writes)
  expect(paths().at(-1)).toBe('/api/v1/scenarios')
  expect(paths().some(path => path.startsWith('/api/v1/simulations'))).toBe(false)
  expect(scenes.get('SCN-IMPORT')).toMatchObject({ ok: true, data: { revision: 1, config: draft.config } })
  expect(wrapper.text()).toContain('导入生成验证')
})

it('预览警告取消后不创建确认、不写 TXT，保留已导入场景', async () => {
  const { wrapper, scenes, draft, paths } = await setupImport({ warnings: true })
  vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel')
  const warning = vi.spyOn(ElMessage, 'warning')
  await importFile(wrapper, draft)
  expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('已取消生成。'))
  expect(paths()).toEqual(['/api/v1/scenarios/import', '/api/v1/scenarios/SCN-IMPORT/validate', '/api/v1/scripts/preview', '/api/v1/scenarios'])
  expect(scenes.get('SCN-IMPORT').ok).toBe(true)
  expect(wrapper.text()).toContain('导入生成验证')
})

it('预览警告确认后完成一次性确认，再携带 warningConfirmationId 生成并写 TXT', async () => {
  const { wrapper, draft, fetchSpy, paths } = await setupImport({ warnings: true })
  const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
  await importFile(wrapper, draft)
  expect(confirm).toHaveBeenCalledExactlyOnceWith('场景存在校验警告。 是否继续生成？', '脚本预览警告', expect.objectContaining({ confirmButtonText: '本次继续', cancelButtonText: '取消' }))
  expect(paths()).toEqual([
    '/api/v1/scenarios/import', '/api/v1/scenarios/SCN-IMPORT/validate', '/api/v1/scripts/preview',
    '/api/v1/scenarios/SCN-IMPORT/validate', '/api/v1/confirmations', '/api/v1/confirmations/CONF-P2-001',
    '/api/v1/scripts/preview', expect.stringMatching(/\/local-file$/u), '/api/v1/scenarios',
  ])
  expect(JSON.parse(String(fetchSpy.mock.calls[6]![1]!.body))).toEqual({ scenarioId: 'SCN-IMPORT', warningConfirmationId: 'CONF-P2-001' })
})

it('JSON 导入 422 保持原有错误展示，不请求任何脚本接口', async () => {
  const { wrapper, scenes, draft, paths } = await setupImport()
  const success = vi.spyOn(ElMessage, 'success')
  const warning = vi.spyOn(ElMessage, 'warning')
  draft.config.output.directory = ''
  await importFile(wrapper, draft)
  expect(wrapper.get('[data-testid="scene-import-error"]').text()).toContain('场景 JSON 导入失败')
  expect(paths()).toEqual(['/api/v1/scenarios/import', '/api/v1/scenarios'])
  expect(scenes.get('SCN-IMPORT').ok).toBe(false)
  expect(success).not.toHaveBeenCalled()
  expect(warning).not.toHaveBeenCalled()
})

it.each(['离页', '重置', '登出'])('导入脚本等待确认期间%s，迟到确认不写 TXT', async operation => {
  const { wrapper, router, store, draft, paths } = await setupImport({ warnings: true })
  let confirm!: () => void
  vi.spyOn(ElMessageBox, 'confirm').mockImplementation(() => new Promise(resolve => {
    confirm = () => resolve('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
  }))
  const success = vi.spyOn(ElMessage, 'success')
  const warning = vi.spyOn(ElMessage, 'warning')
  await importFile(wrapper, draft)
  expect(wrapper.get('[data-testid="scene-import-json"]').attributes('disabled')).toBeDefined()
  if (operation === '离页') await router.push('/other')
  else if (operation === '重置') store.resetToSafeEmpty()
  else useAuthStore().resetToSafeEmpty()
  await flushPromises()
  confirm()
  await flushPromises()
  expect(paths().filter(path => path.includes('/scripts/'))).toEqual(['/api/v1/scripts/preview'])
  expect(paths().some(path => path.includes('/confirmations'))).toBe(false)
  expect(success).not.toHaveBeenCalled()
  expect(warning).not.toHaveBeenCalled()
})

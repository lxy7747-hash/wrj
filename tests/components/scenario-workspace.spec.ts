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
    config: { scenario: { id: 'SCN-001' } },
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

async function importFile(wrapper: VueWrapper, draft: ScenarioDraft): Promise<void> {
  const input = wrapper.get<HTMLInputElement>('[data-testid="scene-import-file"]')
  const bytes = new TextEncoder().encode(JSON.stringify(createScenarioSnapshot(draft)))
  const file = new File([bytes], 'scene.json', { type: 'application/json' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
  Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
  await input.trigger('change')
  await flushPromises()
}

it('JSON 导入保存后依次预览并写 TXT，提示路径、刷新列表且不创建或启动仿真', async () => {
  const { wrapper, store, draft, paths } = await setupImport()
  const success = vi.spyOn(ElMessage, 'success')
  const warning = vi.spyOn(ElMessage, 'warning')
  await importFile(wrapper, draft)
  expect(paths()).toEqual([
    '/api/v1/scenarios/import', '/api/v1/scenarios/SCN-IMPORT/validate', '/api/v1/scripts/preview',
    expect.stringMatching(/^\/api\/v1\/scripts\/[^/]+\/local-file$/u), '/api/v1/scenarios',
  ])
  expect(success).toHaveBeenCalledExactlyOnceWith(`已导入场景“导入生成验证”，TXT 已生成：${scriptPath}`)
  expect(warning).not.toHaveBeenCalled()
  expect(wrapper.text()).toContain('导入生成验证')
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

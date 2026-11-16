// B1-1：管理页 JSON 模板真实导入联合链（组件 → scenarioStore.importTemplate → createTemplate → 真实 HTTP → TemplateSqliteStorage）。
// 真实服务在隔离 tsx 子进程中启动（真实 createMockServer + 真实 TemplateSqliteStorage），组件测试只转发 URL/Origin。
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import AdminPage from '../../src/pages/admin/admin.vue'
import { createAppRouter } from '../../src/router'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'
import type { Principal, ScenarioConfig } from '../../src/contracts/domain-models'

const { spawn } = await import('node:' + 'child_process')
interface ChildLike {
  stdout: { on(event: 'data', listener: (chunk: unknown) => void): void } | null
  stderr: { on(event: 'data', listener: (chunk: unknown) => void): void } | null
  on(event: 'exit', listener: (code: number | null) => void): void
  removeAllListeners(): void
  kill(signal?: string): boolean
}
interface HarnessState {
  templates: Array<{ templateId: string; name: string; version: string }>
  refs: Array<{ targetType: string; targetId: string; targetVersion: string; createdAt: string; sourceSummary: string }>
  audit: Array<{ actor: string; role: string; action: string; objectId?: string; result: string }>
  previewTemplateId: string
}

const ADMIN: Principal = { userId: 'USR-ADMIN', username: 'admin', role: 'ADMIN', permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE', 'OFFICIAL_TEMPLATE_MAINTAIN'] }
const HEADERS = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }

let child: ChildLike | undefined
let origin = ''
let controlOrigin = ''
let realFetch: typeof fetch
const cleanups: Array<() => void | Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })

beforeAll(async () => {
  realFetch = globalThis.fetch.bind(globalThis)
  const nodeProcess = await import('node:' + 'process')
  child = spawn(nodeProcess.execPath, ['--import', 'tsx', 'tests/fixtures/server-harness.mts'], { cwd: nodeProcess.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildLike
  const info = await new Promise<{ origin: string; controlOrigin: string }>((resolve, reject) => {
    let stdout = '', stderr = ''
    const timer = setTimeout(() => reject(new Error(`harness start timeout: ${stderr.slice(-500)}`)), 60_000)
    child!.stdout!.on('data', chunk => {
      stdout += String(chunk)
      const line = stdout.split('\n')[0]
      if (!line) return
      try { const parsed = JSON.parse(line); clearTimeout(timer); resolve(parsed) } catch { /* wait full line */ }
    })
    child!.stderr!.on('data', chunk => { stderr += String(chunk) })
    child!.on('exit', code => { clearTimeout(timer); reject(new Error(`harness exited ${code}: ${stderr.slice(-500)}`)) })
  })
  origin = info.origin; controlOrigin = info.controlOrigin
}, 60_000)
afterAll(async () => { child?.removeAllListeners(); child?.kill('SIGTERM') })

async function harnessState(): Promise<HarnessState> {
  const response = await realFetch(`${controlOrigin}/state`)
  return await response.json() as HarnessState
}
async function control(path: string): Promise<void> {
  const response = await realFetch(`${controlOrigin}${path}`, { method: 'POST' })
  if (!response.ok) throw new Error(`control ${path} failed ${response.status}`)
}

/** 两条链路各带一条 EQUIPMENT 来源（字段/版本导入时冻结）。 */
async function templateConfig(): Promise<ScenarioConfig> {
  const response = await realFetch(`${origin}/api/v1/scenarios/SCN-001`, { headers: HEADERS })
  const body = await response.json() as { data: { config: ScenarioConfig } }
  const config = body.data.config
  Object.assign(config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
  for (const link of config.links.filter((item: { id: string }) => item.id === 'L-MW-01' || item.id === 'L-DL-03')) {
    Object.assign(link, { frequency: 150, modulation: 'QPSK', berThreshold: 0.00001, parameterSource: { kind: 'EQUIPMENT', sourceId: 'TEST-RADIO', sourceVersion: 1, fields: ['modulation', 'berThreshold'] } })
  }
  return config
}

async function mountAdmin() {
  const pinia = createPinia(); setActivePinia(pinia)
  useAuthStore(pinia).$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
  const router = createAppRouter(createMemoryHistory(), pinia)
  await router.push({ path: '/admin', query: { section: 'scenario-templates' } })
  const wrapper = mount(AdminPage, { global: { plugins: [pinia, router, ElementPlus] } })
  await flushPromises()
  return { wrapper, scenario: useScenarioStore(pinia) }
}

function forwardFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    headers.set('Origin', 'http://127.0.0.1:5173')
    return realFetch(`${origin}${url.pathname}${url.search}`, { ...init, headers })
  }))
}

describe('B1-1 管理页 JSON 模板真实导入', () => {
  it('B1-1a 真实导入成功：两条来源冻结、TEMPLATE 引用与审计 SUCCESS 身份一致', async () => {
    const config = await templateConfig()
    forwardFetch()
    const { wrapper, scenario } = await mountAdmin()
    await vi.waitFor(() => expect(['SUCCESS', 'ERROR', 'EMPTY']).toContain(scenario.templateState), { timeout: 10_000 })
    const successSpy = vi.spyOn(ElMessage, 'success')
    const promptSpy = vi.spyOn(ElMessageBox, 'prompt').mockResolvedValueOnce({ value: JSON.stringify({ name: '导入联合模板', config }) } as never)
    await wrapper.get('[data-testid="import-template"]').trigger('click')
    await vi.waitFor(() => expect(promptSpy).toHaveBeenCalled())
    await vi.waitFor(() => expect(scenario.templateState).toBe('SUCCESS'))
    expect(successSpy).toHaveBeenCalled()
    const state = await harnessState()
    expect(state.templates).toHaveLength(1)
    const saved = state.templates[0]!
    // 真实存储中的 TEMPLATE 引用：2 条，targetId/version 与服务端模板一致
    const refs = state.refs.filter(row => row.targetType === 'TEMPLATE')
    expect(refs).toHaveLength(2)
    expect(refs.every(row => row.targetId === saved.templateId && row.targetVersion === saved.version)).toBe(true)
    // 审计：恰好一条 SUCCESS，actor/role/action/objectId/result 全核对
    const audits = state.audit.filter(row => row.action === 'TEMPLATE_CREATE')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actor: 'admin', role: 'ADMIN', action: 'TEMPLATE_CREATE', objectId: saved.templateId, result: 'SUCCESS' })
    expect(audits.some(row => row.result === 'ERROR')).toBe(false)
    wrapper.unmount()
  })

  it('B1-1b 目标提交失败：无半模板、引用回滚、旧引用保留、ERROR objectId=预览 templateId；重试成功', async () => {
    const config = await templateConfig()
    await control('/seed-old-ref')
    const seeded = await harnessState()
    const oldRefs = seeded.refs
    const baselineAudits = seeded.audit.filter(row => row.action === 'TEMPLATE_CREATE')
    const oldRef = oldRefs.filter(row => row.targetType === 'TEMPLATE' && row.targetId === 'TPL-OLD')
    expect(oldRef).toHaveLength(1)
    expect(oldRef[0]!.createdAt).toBe('2020-01-01T00:00:00.000Z')
    await control('/fail-next-save')
    forwardFetch()
    const { wrapper, scenario } = await mountAdmin()
    await vi.waitFor(() => expect(['SUCCESS', 'ERROR', 'EMPTY']).toContain(scenario.templateState), { timeout: 10_000 })
    const successSpy = vi.spyOn(ElMessage, 'success')
    const promptSpy = vi.spyOn(ElMessageBox, 'prompt').mockResolvedValueOnce({ value: JSON.stringify({ name: '导入失败模板', config }) } as never)
    await wrapper.get('[data-testid="import-template"]').trigger('click')
    await vi.waitFor(() => expect(promptSpy).toHaveBeenCalled())
    await vi.waitFor(() => expect(scenario.templateState).toBe('ERROR'))
    expect(successSpy).not.toHaveBeenCalled()
    const failed = await harnessState()
    // 无半模板；引用回到失败前集合且 createdAt 保留
    expect(failed.templates.filter(row => row.name === '导入失败模板')).toEqual([])
    expect(failed.refs).toEqual(oldRefs)
    // 本次恰好新增 1 条 ERROR，objectId 为预览 templateId，actor/role 正确，无本次虚假 SUCCESS
    const failedAudits = failed.audit.filter(row => row.action === 'TEMPLATE_CREATE')
    const delta = failedAudits.slice(baselineAudits.length)
    expect(delta).toHaveLength(1)
    expect(failed.previewTemplateId).not.toBe('')
    expect(delta[0]).toMatchObject({ actor: 'admin', role: 'ADMIN', action: 'TEMPLATE_CREATE', objectId: failed.previewTemplateId, result: 'ERROR' })
    expect(delta.some(row => row.result === 'SUCCESS')).toBe(false)
    // 撤掉注入重试：成功，模板与 2 条引用完整，恰好 1 条 SUCCESS
    const retryPrompt = vi.spyOn(ElMessageBox, 'prompt').mockResolvedValueOnce({ value: JSON.stringify({ name: '导入失败模板', config }) } as never)
    await wrapper.get('[data-testid="import-template"]').trigger('click')
    await vi.waitFor(() => expect(retryPrompt).toHaveBeenCalled())
    await vi.waitFor(() => expect(scenario.templateState).toBe('SUCCESS'))
    const retried = await harnessState()
    expect(retried.templates.filter(row => row.name === '导入失败模板')).toHaveLength(1)
    const created = retried.templates.find(row => row.name === '导入失败模板')!
    const templateRefs = retried.refs.filter(row => row.targetType === 'TEMPLATE')
    expect(templateRefs.filter(row => row.targetId === created.templateId)).toHaveLength(2)
    expect(templateRefs.filter(row => row.targetId === 'TPL-OLD')).toHaveLength(1)
    const finalAudits = retried.audit.filter(row => row.action === 'TEMPLATE_CREATE')
    const retryDelta = finalAudits.slice(failedAudits.length)
    expect(retryDelta.filter(row => row.result === 'ERROR')).toHaveLength(0)
    const successes = retryDelta.filter(row => row.result === 'SUCCESS')
    expect(successes).toHaveLength(1)
    expect(successes[0]).toMatchObject({ actor: 'admin', role: 'ADMIN', objectId: created.templateId, result: 'SUCCESS' })
    wrapper.unmount()
  })
})


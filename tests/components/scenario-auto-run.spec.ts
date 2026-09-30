import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus, { ElMessage } from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixture from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ScenarioConfig, ScenarioDraft, SimulationRun } from '../../src/contracts/domain-models'
import ScenariosPage from '../../src/pages/scenarios/scenarios.vue'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'
import { useSimulationStore } from '../../src/stores/simulation'

enableAutoUnmount(afterEach)
afterEach(() => {
  ElMessage.closeAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

function success(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }))
}
function failure(message = '测试服务拒绝'): Response {
  return new Response(JSON.stringify({ ok: false, error: { code: 'START_FAILED', message, retryable: false, correlationId: 'TEST' } }), { status: 503 })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  const permissions = ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE', 'SIMULATION_CONTROL'] as const
  auth.$patch({ principal: { userId: 'USR-TEST', username: 'operator', role: 'OPERATOR', permissions: [...permissions] }, role: 'OPERATOR', permissions: [...permissions], runtimeMode: 'LOCAL' })
  const saved: ScenarioDraft = { config: structuredClone(fixture.scenario) as ScenarioConfig, uiExtensions: {
    jammers: fixture.scenario.jammers.map(jammer => ({ jammerId: jammer.id, direction: 360, duration: 60, enabled: true })),
    sensors: fixture.scenario.sensors.map(sensor => ({ sensorId: sensor.id, type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true })),
  }, revision: 4, locked: false, officialLibraryChanged: false }
  saved.config.scenario.id = 'SCN-AUTO'
  const run: SimulationRun = {
    runId: 'RUN-007', taskId: 'TASK-001', scenarioId: 'SCN-AUTO', uiStatus: 'IDLE', configLocked: true,
    canonical: { status: 'IDLE', currentTime: 0, totalDuration: saved.config.scenario.duration, processId: null, progress: 0 },
  }
  const script = () => ({ scriptId: 'SCRIPT-AUTO', taskId: 'TASK-001', scenarioId: 'SCN-AUTO', configVersion: `SCN-AUTO-v${saved.revision}`, target: 'AFSIM 2.9.0', checksum: 'TEST', preview: '# test', generatedTime: '2026-09-30T00:00:00Z' })
  const file = () => ({ scriptId: 'SCRIPT-AUTO', configVersion: `SCN-AUTO-v${saved.revision}`, path: 'H:\\test-output\\SCN-AUTO.txt' })
  const calls: string[] = []
  const override = vi.fn<(path: string, init?: RequestInit) => Response | Promise<Response> | undefined>()
  const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    const overridden = override(path, init)
    if (overridden !== undefined) return overridden
    if (path.endsWith('/validate')) return success({ valid: true, errors: [], warnings: [] })
    if (path === '/api/v1/scripts/preview') return success(script())
    if (path.endsWith('/local-file')) return success(file())
    if (path === '/api/v1/scenarios/SCN-AUTO') {
      if (init?.method === 'PUT') { saved.config = JSON.parse(String(init.body)).config; saved.revision++ }
      return success(saved)
    }
    if (path === '/api/v1/simulations') return success(init?.method === 'POST' ? run : [])
    if (path.endsWith('/commands')) return success({ ...run, uiStatus: 'RUNNING', canonical: { ...run.canonical, status: 'RUNNING', processId: 123 } })
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchSpy)
  const store = useScenarioStore()
  expect(await store.loadScenario('SCN-AUTO')).toBe(true)
  const wrapper = mount(ScenariosPage, { props: { managed: true }, global: { plugins: [pinia, ElementPlus] } })
  const successSpy = vi.spyOn(ElMessage, 'success')
  const warningSpy = vi.spyOn(ElMessage, 'warning')
  const errorSpy = vi.spyOn(ElMessage, 'error')
  calls.length = 0
  const save = async () => { await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises() }
  return { auth, store, simulation: useSimulationStore(), wrapper, saved, run, file, script, calls, fetchSpy, override, save, successSpy, warningSpy, errorSpy }
}

describe('保存并生成 TXT 后自动运行', () => {
  it('按保存、生成、写入、选用、创建、START 顺序启动同一非默认场景，仅一次成功反馈', async () => {
    const t = await setup()
    await t.wrapper.get('[data-testid="scenario-name"]').setValue('自动运行场景')
    await t.save()
    expect(t.calls).toEqual([
      'PUT /api/v1/scenarios/SCN-AUTO', 'POST /api/v1/scenarios/SCN-AUTO/validate',
      'POST /api/v1/scripts/preview', 'POST /api/v1/scripts/SCRIPT-AUTO/local-file',
      'GET /api/v1/simulations', 'GET /api/v1/scenarios/SCN-AUTO',
      'POST /api/v1/simulations', 'POST /api/v1/simulations/RUN-007/commands',
    ])
    const create = t.fetchSpy.mock.calls.find(([url, init]) => url.endsWith('/simulations') && init?.method === 'POST')!
    expect(JSON.parse(String(create[1]?.body))).toEqual({ taskId: 'TASK-001', scenarioId: 'SCN-AUTO' })
    const command = t.fetchSpy.mock.calls.find(([url]) => url.endsWith('/commands'))!
    expect(JSON.parse(String(command[1]?.body))).toEqual({ command: 'START', mode: 'INTERACTIVE_SINGLE' })
    expect(t.simulation.uiStatus).toBe('RUNNING')
    expect(t.store.draft?.locked).toBe(true)
    expect(t.store.dirty).toBe(false)
    expect(t.successSpy).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('仿真已启动'))
    expect(t.wrapper.emitted('saved')).toHaveLength(1)
    await t.save()
    expect(t.calls.filter(c => c.endsWith('/commands'))).toHaveLength(1)
  })

  it.each(['PUT', 'preview', 'local-file'])('%s 失败不选用或运行场景', async stage => {
    const t = await setup()
    await t.wrapper.get('[data-testid="scenario-name"]').setValue('需要保存')
    t.override.mockImplementation((path, init) => (stage === 'PUT' ? init?.method === 'PUT' : path.endsWith(`/${stage}`)) ? failure() : undefined)
    await t.save()
    expect(t.calls.some(c => c.includes('/simulations'))).toBe(false)
    expect(t.successSpy).not.toHaveBeenCalled()
    expect(t.wrapper.emitted('saved')).toBeUndefined()
  })

  it.each(['RUNNING', 'PAUSED', 'IDLE'] as const)('已有 %s 锁定任务时不启动、不继续、不停止旧任务', async status => {
    const t = await setup()
    t.override.mockImplementation((path, init) => path === '/api/v1/simulations' && !init?.method
      ? success([{ ...t.run, uiStatus: status, canonical: { ...t.run.canonical, status } }]) : undefined)
    await t.save()
    expect(t.calls.some(c => c.startsWith('POST /api/v1/simulations'))).toBe(false)
    expect(t.warningSpy).toHaveBeenCalledWith(expect.stringContaining('已有仿真任务'))
    expect(t.successSpy).not.toHaveBeenCalled()
  })

  it('选用时版本已变化则不运行不同版本', async () => {
    const t = await setup()
    t.override.mockImplementation(path => path === '/api/v1/scenarios/SCN-AUTO' ? success({ ...t.saved, revision: 99 }) : undefined)
    await t.save()
    expect(t.calls.some(c => c.startsWith('POST /api/v1/simulations'))).toBe(false)
    expect(t.warningSpy).toHaveBeenCalledWith(expect.stringContaining('场景版本已变化'))
  })

  it.each(['create', 'start'])('%s 失败保留已保存配置，明确未运行且不报成功', async stage => {
    const t = await setup()
    t.override.mockImplementation((path, init) => init?.method === 'POST'
      && (stage === 'create' ? path === '/api/v1/simulations' : path.endsWith('/commands')) ? failure('运行服务不可用') : undefined)
    await t.save()
    expect(t.store.draft?.config.scenario.id).toBe('SCN-AUTO')
    expect(t.store.dirty).toBe(false)
    expect(t.successSpy).not.toHaveBeenCalled()
    expect(t.warningSpy).toHaveBeenCalledWith(expect.stringContaining('运行服务不可用'))
  })

  it.each(['离页', '登出', '修改草稿', '全局重置'])('TXT 写入在途时%s，迟到结果不启动', async action => {
    const t = await setup()
    const pending = deferred<Response>()
    t.override.mockImplementation(path => path.endsWith('/local-file') ? pending.promise : undefined)
    await t.save()
    expect(t.calls).toContain('POST /api/v1/scripts/SCRIPT-AUTO/local-file')
    if (action === '离页') t.wrapper.unmount()
    else if (action === '登出') { t.auth.resetToSafeEmpty(); t.store.resetToSafeEmpty(); t.simulation.resetToSafeEmpty() }
    else if (action === '修改草稿') await t.wrapper.get('[data-testid="scenario-name"]').setValue('新的草稿')
    else t.store.resetToSafeEmpty()
    pending.resolve(success(t.file()))
    await flushPromises()
    expect(t.calls.some(c => c.includes('/simulations'))).toBe(false)
    expect(t.successSpy).not.toHaveBeenCalled()
  })

  it('TXT 在途时重复点击保存不会重复写入或运行', async () => {
    const t = await setup()
    const pending = deferred<Response>()
    t.override.mockImplementation(path => path.endsWith('/local-file') ? pending.promise : undefined)
    await t.save()
    await t.save()
    expect(t.calls.filter(c => c.endsWith('/local-file'))).toHaveLength(1)
    pending.resolve(success(t.file()))
    await flushPromises()
    expect(t.calls.filter(c => c.endsWith('/commands'))).toHaveLength(1)
  })

  it.each(['选用', '创建'])('%s响应在途时离页，迟到结果不触发 START', async stage => {
    const t = await setup()
    const pending = deferred<Response>()
    t.override.mockImplementation((path, init) => (stage === '选用' ? path === '/api/v1/scenarios/SCN-AUTO'
      : path === '/api/v1/simulations' && init?.method === 'POST') ? pending.promise : undefined)
    await t.save()
    t.wrapper.unmount()
    pending.resolve(success(stage === '选用' ? t.saved : t.run))
    await flushPromises()
    if (stage === '选用') expect(t.simulation.selectedScene).toBeNull()
    expect(t.calls.some(c => c.endsWith('/commands'))).toBe(false)
    expect(t.successSpy).not.toHaveBeenCalled()
  })
})

import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ScenarioDraft, ScriptContract } from '../../src/contracts/domain-models'
import ScenariosPage from '../../src/pages/scenarios/scenarios.vue'
import { useScenarioStore } from '../../src/stores/scenario'
import { useAuthStore } from '../../src/stores/auth'

enableAutoUnmount(afterEach)
let ScenarioProjection: new () => { get(id: string): { ok: true; data: ScenarioDraft } }
let ScriptProjection: new () => { preview(draft: ScenarioDraft): ScriptContract }
beforeAll(async () => {
  ;({ ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js'))
  ;({ ScriptProjection } = await import('../../server/scripts/' + 'projection.js'))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const meta = { requestId: 'REQ-TXT', generatedAt: '2026-08-06T08:00:00Z', page: 1, pageSize: 1, total: 1 }
const reply = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data, meta }) }) as Response
const path = 'H:\\output\\scripts\\script-test\\SCN-001-r2.txt'

async function setup(preview?: () => Promise<Response>, write?: () => Promise<Response>, warnings = false) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ principal: { userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'] }, role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'] })
  let persisted = new ScenarioProjection().get('SCN-001').data
  persisted.config.scenario.environment.rainLossDbPerKm = 0.08
  const generator = new ScriptProjection()
  let script: ScriptContract
  const fetchSpy = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    if (String(url).endsWith('/scripts/preview')) {
      script = generator.preview(persisted)
      return preview ? preview() : reply(script)
    }
    if (String(url).endsWith('/local-file')) {
      const current = useScenarioStore().script!
      return write ? write() : reply({ scriptId: current.scriptId, configVersion: current.configVersion, path })
    }
    if (String(url).endsWith('/validate')) return reply({ valid: true, errors: [], warnings: warnings ? [{ severity: 'WARNING', code: 'RAIN', message: '雨衰警告。', fieldPath: 'scenario.environment.rainLossDbPerKm' }] : [] })
    if (String(url).endsWith('/preflight')) return reply({ valid: true, errors: [], warnings: [] })
    if (String(url).includes('/confirmations')) return reply({ confirmationId: 'CONF-TXT', state: String(url).endsWith('/confirmations') ? 'AWAITING_CONFIRMATION' : 'CONFIRMED', actor: 'operator', role: 'OPERATOR', createdAt: meta.generatedAt, expiresAt: '2026-08-06T08:05:00Z' })
    if (init?.method === 'PUT') {
      const data = JSON.parse(String(init.body))
      persisted = { ...persisted, config: data.config, uiExtensions: data.uiExtensions, revision: persisted.revision + 1 }
    }
    return reply(structuredClone(persisted))
  })
  vi.stubGlobal('fetch', fetchSpy)
  const alert = vi.spyOn(ElMessageBox, 'alert').mockResolvedValue('confirm' as never)
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
  const store = useScenarioStore()
  await store.loadScenario()
  const wrapper = mount(ScenariosPage, { props: { managed: true }, global: { plugins: [pinia, ElementPlus] } })
  await wrapper.get('[data-testid="scenario-name"]').setValue('TXT 当前场景')
  const save = async () => { await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises() }
  return { wrapper, store, fetchSpy, alert, click, save, persisted: () => persisted }
}

describe('保存后由 Node 写入 TXT', () => {
  it('保存、生成、落盘依次请求，显示服务端路径，不触发浏览器下载', async () => {
    const { wrapper, store, fetchSpy, alert, click, save } = await setup()
    await save()
    expect(fetchSpy.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url).split('/api/v1/')[1]}`))
      .toEqual(['GET scenarios/SCN-001', 'PUT scenarios/SCN-001', 'POST scenarios/SCN-001/validate', 'POST scripts/preview', 'POST scripts/SCRIPT-P2-001/local-file'])
    expect(JSON.parse(String(fetchSpy.mock.calls.at(-1)![1]?.body))).toEqual({ checksum: store.script!.checksum })
    expect(alert).toHaveBeenCalledWith(`TXT 已生成并写入：${path}\n文本生成不等于 mission 执行验证，请以生成文件中的支持范围说明为准。`, '场景保存成功', { confirmButtonText: '知道了' })
    expect(click).not.toHaveBeenCalled()
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('保存失败不生成、不写文件', async () => {
    const { wrapper, fetchSpy, alert, save } = await setup()
    await wrapper.get('[data-testid="scenario-name"]').setValue(' ')
    fetchSpy.mockClear()
    await save()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })

  it('落盘失败保留已保存草稿，重试不重复 PUT，非法成功响应不显示路径', async () => {
    let fail = true
    const { wrapper, store, fetchSpy, alert, save } = await setup(undefined, () => Promise.resolve(fail
      ? { ok: false, json: async () => ({ ok: false, error: { code: 'START_FAILED', message: '磁盘空间不足。' } }) } as Response
      : reply({ scriptId: 'OTHER', configVersion: 'OTHER', path })))
    const error = vi.spyOn(ElMessage, 'error')
    await save()
    expect(store.dirty).toBe(false)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('磁盘空间不足'))
    fail = false
    await save()
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('响应格式不正确'))
    expect(alert).not.toHaveBeenCalled()
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(wrapper.find('[data-testid="workflow-script"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="preflight-script"]').exists()).toBe(false)
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/preflight'))).toBe(false)
    const feedback = wrapper.get('[data-testid="scenario-next-step"]').text()
    expect(feedback).not.toContain('预检')
    expect(feedback).not.toContain('未写入文件')
    expect(wrapper.text()).not.toContain('TXT 已生成并写入')
    expect(alert).not.toHaveBeenCalled()
  })

  it.each(['离页', '重置', '编辑', '登出'])('%s 后迟到的生成响应不写文件', async action => {
    let finish!: (value: Response) => void
    const { wrapper, store, fetchSpy, alert, save, persisted } = await setup(() => new Promise(resolve => { finish = resolve }))
    await save()
    if (action === '离页') wrapper.unmount()
    if (action === '重置') store.resetToSafeEmpty()
    if (action === '编辑') { store.draft!.config.scenario.name = '新编辑'; store.markDirty() }
    if (action === '登出') useAuthStore().resetToSafeEmpty()
    finish(reply(new ScriptProjection().preview(persisted())))
    await flushPromises()
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/local-file'))).toBe(false)
    expect(alert).not.toHaveBeenCalled()
  })

  it('离页后迟到的写入结果不显示旧提示或返回列表', async () => {
    let finish!: (value: Response) => void
    const { wrapper, store, alert, save } = await setup(undefined, () => new Promise(resolve => { finish = resolve }))
    await save()
    const script = store.script!
    wrapper.unmount()
    finish(reply({ scriptId: script.scriptId, configVersion: script.configVersion, path }))
    await flushPromises()
    expect(alert).not.toHaveBeenCalled()
    expect(wrapper.emitted('saved')).toBeUndefined()
  })

  it('取消警告确认不写入，确认后仍按一次性确认流程生成', async () => {
    let attempts = 0
    const { fetchSpy, alert, save, persisted } = await setup(async () => ++attempts < 3
      ? { ok: false, json: async () => ({ ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: '存在警告。' } }) } as Response
      : reply(new ScriptProjection().preview(persisted())), undefined, true)
    vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValueOnce('confirm' as never)
    await save()
    expect(alert).not.toHaveBeenCalled()
    await save()
    expect(fetchSpy.mock.calls.slice(-4).map(([url]) => String(url).split('/api/v1/')[1]))
      .toEqual(['confirmations', 'confirmations/CONF-TXT', 'scripts/preview', 'scripts/SCRIPT-P2-001/local-file'])
    expect(alert).toHaveBeenCalledOnce()
  })
})

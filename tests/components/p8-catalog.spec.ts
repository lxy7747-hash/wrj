import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { FixtureMetadata } from '../../src/contracts/domain-models'
import Blueprint from '../../src/pages/blueprint/blueprint.vue'
import Traceability from '../../src/pages/traceability/traceability.vue'
import Interactions from '../../src/pages/interactions/interactions.vue'
import { useTraceabilityStore } from '../../src/stores/traceability'
import { useUiStore } from '../../src/stores/ui'
import { createAppRouter } from '../../src/router'
import { useAuthStore } from '../../src/stores/auth'
import App from '../../src/App.vue'

const stubs = Object.fromEntries(['LinkCalculatorContractCard', 'EsmSensorPanel', 'RfJammerPanel', 'ClosedLoopStepper', 'JammerSyncPanel', 'CompositeLossExample', 'SnrBerExample', 'RouteRankingPanel', 'SwitchDecisionPanel'].map((name) => [name, true]))
beforeEach(() => {
  setActivePinia(createPinia()); Element.prototype.scrollIntoView = vi.fn()
  useAuthStore().$patch({ principal: { userId: 'USR-ADMIN', username: 'admin', role: 'ADMIN', permissions: [] }, role: 'ADMIN' })
})
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

/** 装载真实 Element Plus 页面；仅隔离已在 P4 覆盖的业务子组件。 */
async function page(component: typeof Blueprint | typeof Traceability | typeof Interactions, metadata = true) {
  const store = useTraceabilityStore()
  store.resetToSafeEmpty()
  if (metadata) store.$patch({ metadata: fixtures.metadata as FixtureMetadata, state: 'SUCCESS' })
  const load = vi.spyOn(store, 'loadMetadata').mockClear().mockResolvedValue(true)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component, meta: { title: '能力蓝图', guard: 'principal' } }] })
  await router.push('/blueprint')
  const wrapper = mount(component, { attachTo: document.body, global: { plugins: [ElementPlus, router], stubs } })
  await flushPromises()
  return { wrapper, store, load, router }
}

describe('P8 目录页面与重置入口', () => {
  it('重置权限失败不会被 App 覆盖成空态，主动退出则取消协调', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const router = createAppRouter(createMemoryHistory())
    await router.push('/interactions')
    const wrapper = mount(App, { global: { plugins: [ElementPlus, router], stubs: { RouterView: true } } })
    const ui = useUiStore()
    ui.resetState = 'EXECUTING'
    useAuthStore().resetToSafeEmpty()
    expect(ui.resetState).toBe('EXECUTING')
    useAuthStore().$patch({ principal: { userId: 'USR-ADMIN', username: 'admin', role: 'ADMIN', permissions: [] }, role: 'ADMIN' })
    await wrapper.get('[data-testid="logout"]').trigger('click'); await flushPromises()
    expect(ui.resetState).toBe('EMPTY')
    expect(router.currentRoute.value.path).toBe('/login')
    wrapper.unmount()
  })

  it('重置期间不允许页面加载交叉，但仍允许退出到登录页', async () => {
    useAuthStore().$patch({ principal: { userId: 'USR-ADMIN', username: 'admin', role: 'ADMIN', permissions: [] }, role: 'ADMIN' })
    const router = createAppRouter(createMemoryHistory())
    await router.push('/interactions')
    useUiStore().resetState = 'EXECUTING'
    await router.push('/reports')
    expect(router.currentRoute.value.path).toBe('/interactions')
    await router.push('/login')
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('蓝图呈现 29 卡、7 锚点、8 决策和实际功能入口', async () => {
    const { wrapper, store, router, load } = await page(Blueprint)
    expect(wrapper.findAll('[data-testid="capability-card"]')).toHaveLength(29)
    expect(wrapper.findAll('[data-testid="interface-anchor"]')).toHaveLength(7)
    expect(wrapper.findAll('[data-testid="decision-table"] .el-table__row')).toHaveLength(8)
    expect(wrapper.get('#cap-jcsj a').attributes('href')).toBe('/admin?section=master-data')
    expect(wrapper.get('#cap-stxr a').attributes('href')).toBe('/situation')
    expect(wrapper.get('#cap-cjksh a').attributes('href')).toBe('/scenarios')
    expect(wrapper.get('#cap-bhc a').attributes('href')).toBe('/interactions')
    await wrapper.get('button').trigger('click')
    expect(load).toHaveBeenCalledOnce()
    await router.push('/blueprint#cap-jcsj'); await flushPromises()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    store.$patch({ state: 'ERROR', message: '目录加载失败' }); await flushPromises()
    expect(wrapper.text()).toContain('目录加载失败')
    wrapper.unmount()
  })

  it('空目录自动读取，追踪表筛选与定位使用同一份数据', async () => {
    const empty = await page(Blueprint, false)
    expect(empty.load).toHaveBeenCalledOnce(); empty.wrapper.unmount()
    const { wrapper, store, load } = await page(Traceability)
    expect(wrapper.findAll('.el-table__row')).toHaveLength(36)
    await wrapper.get('input').setValue('参数校验'); await flushPromises()
    expect(wrapper.findAll('.el-table__row')).toHaveLength(1)
    expect(wrapper.get('.el-table__row a').attributes('href')).toBe('/blueprint#cap-csjy')
    store.$patch({ state: 'ERROR', message: '加载失败' }); await flushPromises()
    expect(wrapper.text()).toContain('加载失败')
    await wrapper.get('button:not(.el-input__clear)').trigger('click'); expect(load).toHaveBeenCalled()
    wrapper.unmount()
    const initial = await page(Traceability, false)
    expect(initial.load).toHaveBeenCalledOnce(); initial.wrapper.unmount()
  })

  it('取消不触发 action；确认只调用一次；失败时可重试且不挂载旧业务面板', async () => {
    const { wrapper } = await page(Interactions)
    const reset = vi.spyOn(useUiStore(), 'resetAllProjections').mockResolvedValue(true)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    await wrapper.get('[data-testid="reset-all"]').trigger('click'); await flushPromises()
    expect(reset).not.toHaveBeenCalled()
    await wrapper.findComponent({ name: 'ElButton' }).vm.$emit('click'); await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(2); expect(reset).toHaveBeenCalledOnce()
    for (const state of ['EXECUTING', 'ERROR', 'SUCCESS'] as const) {
      useUiStore().$patch({ resetState: state, resetMessage: '重置反馈', correlationId: 'P8-CORR' })
      await flushPromises()
      expect(wrapper.find('[data-testid="reset-feedback"]').exists()).toBe(true)
      expect(wrapper.find('.interactions-page__evidence').exists()).toBe(state === 'SUCCESS')
    }
    await wrapper.get('.el-collapse-item__header').trigger('click')
    for (const label of ['失败', '成功', '暂无数据']) {
      const radio = wrapper.findAll('.el-radio-button').find((item) => item.text() === label)!
      await radio.get('input').setValue(true); await flushPromises()
      expect(wrapper.text()).toContain(`状态示例：${label}`)
    }
    expect(wrapper.findAll('[data-testid="error-catalog"] .el-table__row')).toHaveLength(31)
    expect(wrapper.get('[data-testid="error-catalog"]').text()).toContain('INTERNAL_ERROR')
    wrapper.unmount()
  })
})

import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MissionResults from '../../src/components/situation/MissionResults.vue'
import { useAuthStore } from '../../src/stores/auth'

const record = {
  resultId: 'RESULT-11111111-1111-4111-8111-111111111111',
  scenarioId: 'SCN-001', scenarioName: '执行场景', revision: 1,
  startedAt: '2026-09-24T00:00:00Z', completedAt: '2026-09-24T00:00:01Z',
}

async function mountResults(view: 'replay' | 'report', records = [record]) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().runtimeMode = 'LOCAL'
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: records }) }))
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/replays', component: { template: '<div />' } },
    { path: '/reports', component: { template: '<div />' } },
  ] })
  await router.push({ path: view === 'replay' ? '/replays' : '/reports', query: { resultId: record.resultId } })
  const wrapper = mount(MissionResults, { props: { view }, global: { plugins: [pinia, router, ElementPlus] } })
  await flushPromises()
  return { wrapper, router }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('运行结果导航入口', () => {
  it('回放页隐藏重复回放入口，报告按钮携带当前运行结果跳转', async () => {
    const { wrapper, router } = await mountResults('replay')
    try {
      expect(wrapper.text()).not.toContain('查看回放')
      const button = wrapper.findAll('button').find(item => item.text() === '查看报告／下载')!
      expect(button.classes()).toContain('el-button')
      await button.trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.path).toBe('/reports')
      expect(router.currentRoute.value.query.resultId).toBe(record.resultId)
    } finally { wrapper.unmount() }
  })

  it('报告页仍保留跳转到对应回放的入口', async () => {
    const { wrapper, router } = await mountResults('report')
    try {
      expect(wrapper.text()).not.toContain('查看报告／下载')
      expect(wrapper.text()).not.toContain('RESULT-')
      const button = wrapper.findAll('button').find(item => item.text() === '查看回放')!
      expect(button.classes()).toContain('el-button')
      await button.trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.path).toBe('/replays')
      expect(router.currentRoute.value.query.resultId).toBe(record.resultId)
    } finally { wrapper.unmount() }
  })

  it('没有运行结果时不显示报告按钮或回放入口', async () => {
    const { wrapper } = await mountResults('replay', [])
    try {
      expect(wrapper.text()).toContain('暂无已完成的运行结果')
      expect(wrapper.text()).not.toContain('查看报告／下载')
      expect(wrapper.text()).not.toContain('查看回放')
    } finally { wrapper.unmount() }
  })
})

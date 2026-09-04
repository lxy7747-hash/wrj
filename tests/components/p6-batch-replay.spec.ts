import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { Batch, Principal, Replay } from '../../src/contracts/domain-models'

vi.mock('../../src/components/situation/OfflineSituationMap.vue', () => ({
  default: { name: 'OfflineSituationMap', template: '<div data-testid="offline-map-stub" />' },
}))

import BatchesPage from '../../src/pages/batches/batches.vue'
import ReplaysPage from '../../src/pages/replays/replays.vue'
import { createAppRouter } from '../../src/router'
import { useAuthStore } from '../../src/stores/auth'

const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR',
  permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL', 'ORDINARY_REPORT_EXPORT'],
}

/** 创建页面测试使用的成功响应。 */
function success(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

/** 创建带登录身份和工作区路由的页面挂载环境。 */
async function mountPage(component: typeof BatchesPage | typeof ReplaysPage, path: '/batches' | '/replays') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore(pinia).$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
  const router = createAppRouter(createMemoryHistory(), pinia)
  await router.push(path)
  const wrapper = mount(component, { attachTo: document.body, global: { plugins: [pinia, router, ElementPlus] } })
  await flushPromises()
  return { wrapper, router }
}

describe('P6 批量仿真与历史回放页面', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('展示 12 行批量对比并完成创建、启动和聚合报告跳转', async () => {
    const queued = { ...fixtureSource.batch, state: 'QUEUED' } as Batch
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/batches') && init?.method === 'POST') return Promise.resolve(success(queued))
      if (url.endsWith('/commands')) return Promise.resolve(success(fixtureSource.batch))
      if (url.endsWith('/api/v1/batches')) return Promise.resolve(success([fixtureSource.batch]))
      if (url.endsWith('/api/v1/batches/BATCH-001')) return Promise.resolve(success({
        batch: fixtureSource.batch,
        runs: fixtureSource.batchRuns,
        aggregateReport: fixtureSource.batchAggregateReport,
      }))
      throw new Error(`未处理请求：${url}`)
    }))
    const { wrapper, router } = await mountPage(BatchesPage, '/batches')

    expect(wrapper.get('#batches-title').text()).toBe('批量仿真')
    for (const testId of ['batch-scenario', 'batch-powers', 'batch-distances']) {
      expect(wrapper.get(`[data-testid="${testId}"]`).attributes('readonly')).toBeDefined()
    }
    expect(wrapper.findAll('[data-testid="batch-run-table"] .el-table__row')).toHaveLength(12)
    expect(wrapper.text()).toContain('RUN-B01')
    await wrapper.get('[data-testid="batch-create"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已排队')
    await wrapper.get('[data-testid="batch-start"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="batch-run-table"] .el-table__row')).toHaveLength(12)
    await wrapper.findAll('button').find((button) => button.text().includes('查看聚合报告'))!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value).toMatchObject({ path: '/reports', query: { reportId: 'RPT-BATCH-001' } })
    wrapper.unmount()
  })

  it('展示只读回放地图、事件时间轴并执行播放与事件定位', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/frames/')) return Promise.resolve(success(fixtureSource.frame))
      if (url.endsWith('/simulations/RUN-001/events')) return Promise.resolve(success(fixtureSource.events))
      if (url.endsWith('/api/v1/replays')) return Promise.resolve(success([fixtureSource.replay]))
      if (url.endsWith('/api/v1/replays/REPLAY-001')) return Promise.resolve(success(fixtureSource.replay))
      if (url.endsWith('/commands')) {
        const command = JSON.parse(String(init?.body)) as { command: string; value?: number }
        const state = command.command === 'PLAY' ? 'PLAYING' : 'PAUSED'
        return Promise.resolve(success({
          ...fixtureSource.replay,
          state,
          currentTimeS: command.command === 'SEEK' ? command.value : fixtureSource.replay.currentTimeS,
        } as Replay))
      }
      throw new Error(`未处理请求：${url}`)
    }))
    const { wrapper } = await mountPage(ReplaysPage, '/replays')

    expect(wrapper.get('#replays-title').text()).toBe('历史回放')
    expect(wrapper.get('[data-testid="offline-map-stub"]')).toBeTruthy()
    expect(wrapper.findAll('[data-testid="replay-timeline"] .replay-timeline__events button')).toHaveLength(3)
    expect(wrapper.get('[data-testid="replay-event-detail"]').text()).toContain('SW-004')
    await wrapper.get('[data-testid="replay-play"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="replay-play"]').text()).toBe('暂停')
    await wrapper.findAll('[data-testid="replay-timeline"] .replay-timeline__events button')[0]!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="replay-event-detail"]').text()).toContain('DET-042')
    wrapper.unmount()
  })

  it('明确展示回放空态和损坏态', async () => {
    const baseFetch = (replays: unknown, replayDetail?: unknown) => vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/frames/')) return Promise.resolve(success(fixtureSource.frame))
      if (url.endsWith('/simulations/RUN-001/events')) return Promise.resolve(success(fixtureSource.events))
      if (url.endsWith('/api/v1/replays')) return Promise.resolve(success(replays))
      return Promise.resolve(success(replayDetail))
    })

    vi.stubGlobal('fetch', baseFetch([]))
    const empty = await mountPage(ReplaysPage, '/replays')
    expect(empty.wrapper.text()).toContain('暂无可用回放记录')
    empty.wrapper.unmount()

    vi.stubGlobal('fetch', baseFetch([fixtureSource.replay], { ...fixtureSource.replay, currentTimeS: 9000 }))
    const corrupt = await mountPage(ReplaysPage, '/replays')
    expect(corrupt.wrapper.text()).toContain('回放数据损坏')
    corrupt.wrapper.unmount()
  })
})

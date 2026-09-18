import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { Batch, Principal } from '../../src/contracts/domain-models'

vi.mock('../../src/components/situation/OfflineSituationMap.vue', () => ({
  default: { name: 'OfflineSituationMap', props: ['frame', 'initialNodes', 'fileLinks', 'fileDeviceEvents', 'fileTime', 'links', 'selectedNodeId', 'focusTarget'], template: '<div data-testid="offline-map-stub" />' },
}))

import BatchesPage from '../../src/pages/batches/batches.vue'
import ReplaysPage from '../../src/pages/replays/replays.vue'
import { createAppRouter } from '../../src/router'
import { useAuthStore } from '../../src/stores/auth'
import { useReplayStore } from '../../src/stores/replay'
import { LOCAL_REPLAY } from '../fixtures/local-replay'

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
    vi.useRealTimers()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('真实文件回放保持现有控制，按播放和拖动时刻更新地图，不加载模拟帧或事件', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const fetchSpy = vi.fn().mockResolvedValue(success(structuredClone(LOCAL_REPLAY)))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    const map = wrapper.findComponent({ name: 'OfflineSituationMap' })
    expect(wrapper.text()).toContain('positions.csv')
    expect(wrapper.text()).not.toContain('F-00042')
    expect(wrapper.text()).not.toContain('SW-004')
    expect(map.props('frame')).toBeNull()
    expect(map.props('links')).toEqual([])
    expect(map.props('initialNodes')).toHaveLength(2)
    expect(map.props('initialNodes')[0].longitude).toBe(-77)
    await wrapper.get('.replay-node-location button').trigger('click')
    expect(map.props('focusTarget')).toEqual({ kind: 'node', targetId: 'A' })
    await wrapper.get('[data-testid="replay-play"]').trigger('click')
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(map.props('initialNodes')[0].longitude).toBe(-78)
    const nodeSelect = wrapper.get('.replay-event-detail').getComponent({ name: 'ElSelect' })
    nodeSelect.vm.$emit('update:modelValue', 'B')
    await flushPromises()
    expect(map.props('focusTarget')).toEqual({ kind: 'node', targetId: 'B' })
    await wrapper.get('[role="slider"]').trigger('keydown', { key: 'End', code: 'End' })
    await flushPromises()
    expect(map.props('initialNodes')[0].longitude).toBe(-79)
    expect(map.props('selectedNodeId')).toBe('B')
    await wrapper.get('[role="slider"]').trigger('keydown', { key: 'Home', code: 'Home' })
    await flushPromises()
    expect(map.props('initialNodes')[0].longitude).toBe(-77)
    expect(fetchSpy).toHaveBeenCalledOnce()
    await wrapper.get('.replays-page__header button').trigger('click')
    await flushPromises()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(useReplayStore().replay?.currentTimeS).toBe(0)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('文件回放按游标展示卫星与微波关联，回退隐藏未来登记，重载清理旧关联', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const snapshot = structuredClone(LOCAL_REPLAY)
    const satellite = {
      sourceEventId: 'LOG-L10', time: 0, scope: 'INTER_PLATFORM' as const,
      source: { platformName: 'A', communicationName: 'sat-a', address: '0.1.0.1' },
      target: { platformName: 'B', communicationName: 'sat-b', address: '0.1.0.2' },
      sourceType: 'satcom_1', targetType: 'satcom_2',
    }
    snapshot.initial.connections = [satellite, {
      ...satellite, sourceEventId: 'LOG-L11', time: 1,
      source: satellite.target, target: satellite.source,
      sourceType: satellite.targetType, targetType: satellite.sourceType,
    }, {
      ...satellite, sourceEventId: 'LOG-L12', time: 3,
      source: { ...satellite.source, communicationName: 'mw-a' },
      target: { ...satellite.target, communicationName: 'mw-b' },
      sourceType: 'microwave', targetType: 'microwave',
    }]
    const fetchSpy = vi.fn().mockResolvedValueOnce(success(snapshot))
      .mockResolvedValueOnce(success(structuredClone(LOCAL_REPLAY)))
      .mockRejectedValueOnce(new Error('文件暂不可读'))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    try {
      const map = wrapper.getComponent({ name: 'OfflineSituationMap' })
      expect(map.props('fileLinks')).toEqual([expect.objectContaining({
        type: 'SAT', sourcePlatformId: 'A', targetPlatformId: 'B', records: [satellite],
      })])
      expect(map.props('links')).toEqual([])
      expect(map.props('frame')).toBeNull()
      await wrapper.get('[data-testid="replay-play"]').trigger('click')
      await vi.advanceTimersByTimeAsync(1000)
      await flushPromises()
      expect(map.props('fileLinks')).toHaveLength(1)
      expect(map.props('fileLinks')[0].records).toHaveLength(2)
      expect(map.props('initialNodes')[0].longitude).toBe(-78)
      await wrapper.get('[role="slider"]').trigger('keydown', { key: 'End', code: 'End' })
      await flushPromises()
      expect(map.props('fileLinks').map((link: { type: string }) => link.type)).toEqual(['SAT', 'MICROWAVE'])
      expect(map.props('initialNodes')[0].longitude).toBe(-79)
      await wrapper.get('[role="slider"]').trigger('keydown', { key: 'Home', code: 'Home' })
      await flushPromises()
      expect(map.props('fileLinks')).toHaveLength(1)
      expect(map.props('fileLinks')[0].records).toEqual([satellite])
      expect(map.props('initialNodes')[0].longitude).toBe(-77)
      expect(fetchSpy).toHaveBeenCalledOnce()
      await wrapper.get('.replays-page__header button').trigger('click')
      await flushPromises()
      expect(wrapper.getComponent({ name: 'OfflineSituationMap' }).props('fileLinks')).toEqual([])
      await wrapper.get('.replays-page__header button').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(false)
    } finally {
      wrapper.unmount()
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('真实文件设备事件传入地图，游标前进和后退同步时刻，重载不保留前一份事件', async () => {
    const snapshot = structuredClone(LOCAL_REPLAY)
    snapshot.initial.deviceEvents = [
      { sourceEventId: 'LOG-L10', platformId: 'A', deviceId: 'tx', kind: 'COMMUNICATION', time: 0, active: true },
      { sourceEventId: 'LOG-L11', platformId: 'A', deviceId: 'tx', kind: 'COMMUNICATION', time: 3, active: false },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(success(snapshot)).mockResolvedValueOnce(success(structuredClone(LOCAL_REPLAY))))
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    try {
      const map = wrapper.getComponent({ name: 'OfflineSituationMap' })
      expect(map.props('fileDeviceEvents')).toEqual(snapshot.initial.deviceEvents)
      expect(map.props('fileTime')).toBe(0)
      await wrapper.get('[role="slider"]').trigger('keydown', { key: 'End', code: 'End' })
      await flushPromises()
      expect(map.props('fileTime')).toBe(3)
      await wrapper.get('[role="slider"]').trigger('keydown', { key: 'Home', code: 'Home' })
      await flushPromises()
      expect(map.props('fileTime')).toBe(0)
      await wrapper.get('.replays-page__header button').trigger('click')
      await flushPromises()
      expect(wrapper.getComponent({ name: 'OfflineSituationMap' }).props('fileDeviceEvents')).toBeUndefined()
    } finally { wrapper.unmount() }
  })

  it('末条位置在3秒、关联在10秒时可回放到登记时刻，回退隐藏关联且保持末条位置', async () => {
    const snapshot = structuredClone(LOCAL_REPLAY)
    snapshot.durationS = 10
    snapshot.initial.connections = [{
      sourceEventId: 'LOG-L10', time: 10, scope: 'INTER_PLATFORM',
      source: { platformName: 'A', communicationName: 'mw-a', address: '1' },
      target: { platformName: 'B', communicationName: 'mw-b', address: '2' },
      sourceType: 'microwave', targetType: 'microwave',
    }]
    const fetchSpy = vi.fn().mockResolvedValue(success(snapshot))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    try {
      const map = wrapper.getComponent({ name: 'OfflineSituationMap' })
      expect(map.props('fileLinks')).toEqual([])
      await wrapper.get('[role="slider"]').trigger('keydown', { key: 'End', code: 'End' })
      await flushPromises()
      expect(useReplayStore().replay?.currentTimeS).toBe(10)
      expect(map.props('fileLinks')).toEqual([expect.objectContaining({ records: snapshot.initial.connections })])
      const lastNodes = structuredClone(map.props('initialNodes'))
      expect(lastNodes[0]).toMatchObject({ longitude: -79, latitude: 32, altitude: 20, time: 3 })
      expect(map.props('frame')).toBeNull()
      expect(map.props('links')).toEqual([])
      await useReplayStore().seek(9)
      await flushPromises()
      expect(useReplayStore().replay?.currentTimeS).toBe(9)
      expect(map.props('fileLinks')).toEqual([])
      expect(map.props('initialNodes')).toEqual(lastNodes)
      expect(fetchSpy).toHaveBeenCalledOnce()
    } finally { wrapper.unmount() }
  })

  it('真实文件读取失败展示中文错误，不回退旧地图', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('文件暂不可读'))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    expect(wrapper.text()).toContain('历史回放不可用')
    expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(false)
    expect(fetchSpy).toHaveBeenCalledOnce()
    wrapper.unmount()
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

    expect(wrapper.find('#batches-title').exists()).toBe(false)
    expect(wrapper.get('.batch-form').text()).toContain('批量参数配置')
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
    await vi.waitFor(() => expect(router.currentRoute.value).toMatchObject({ path: '/reports', query: { reportId: 'RPT-BATCH-001' } }))
    wrapper.unmount()
  })

  it('未配置本地数据时只显示空态，重新加载可恢复真实文件，不请求演示接口', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(success(null))
      .mockResolvedValueOnce(success(structuredClone(LOCAL_REPLAY)))
      .mockResolvedValueOnce(success(null))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    try {
      expect(wrapper.text()).toContain('暂无本地回放数据，请配置数据文件后重新加载。')
      expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="replay-play"]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('F-00042')
      expect(fetchSpy).toHaveBeenCalledOnce()
      await wrapper.get('.replays-page__header button').trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('positions.csv')
      expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(true)
      await wrapper.get('.replays-page__header button').trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('暂无本地回放数据')
      expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(false)
      expect(useReplayStore().localSnapshot).toBeNull()
      expect(fetchSpy).toHaveBeenCalledTimes(3)
      expect(fetchSpy.mock.calls.every(([url]) => String(url).endsWith('/api/v1/replays/local-file'))).toBe(true)
    } finally { wrapper.unmount() }
  })

  it('本地文件加载期间离页，迟到响应不能恢复数据或启动播放', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    let finishLoad!: (response: Response) => void
    const fetchSpy = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { finishLoad = resolve }))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(ReplaysPage, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    expect(wrapper.find('.el-skeleton').exists()).toBe(true)
    wrapper.unmount()
    finishLoad(success(structuredClone(LOCAL_REPLAY)))
    await flushPromises()
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(useReplayStore().state).toBe('EMPTY')
    expect(useReplayStore().replay).toBeNull()
    expect(useReplayStore().localSnapshot).toBeNull()
    expect(fetchSpy.mock.calls[0]?.[1].signal.aborted).toBe(true)
  })

  it('本地数据校验失败清除旧地图并提示错误，重试恢复后仍只加载本地文件', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(success(structuredClone(LOCAL_REPLAY)))
      .mockResolvedValueOnce(success({ ...structuredClone(LOCAL_REPLAY), durationS: -1 }))
      .mockResolvedValueOnce(success(structuredClone(LOCAL_REPLAY)))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountPage(ReplaysPage, '/replays')
    try {
      await wrapper.get('.replays-page__header button').trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('回放数据损坏')
      expect(wrapper.text()).toContain('历史回放数据格式不正确。')
      expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="replay-play"]').exists()).toBe(false)
      expect(useReplayStore().localSnapshot).toBeNull()
      await wrapper.get('.el-result button').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="offline-map-stub"]').exists()).toBe(true)
      expect(fetchSpy).toHaveBeenCalledTimes(3)
      expect(fetchSpy.mock.calls.every(([url]) => String(url).endsWith('/api/v1/replays/local-file'))).toBe(true)
    } finally { wrapper.unmount() }
  })
})

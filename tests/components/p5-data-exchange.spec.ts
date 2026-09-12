import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import ProcessContractCard from '../../src/components/data-exchange/ProcessContractCard.vue'
import ExchangeMonitor from '../../src/components/data-exchange/ExchangeMonitor.vue'
import ScenarioJsonPanel from '../../src/components/data-exchange/ScenarioJsonPanel.vue'
import WebSocketContractCard from '../../src/components/data-exchange/WebSocketContractCard.vue'
import type { Principal, ScenarioDraft, SimulationRun, TelemetryFrame } from '../../src/contracts/domain-models'
import DataExchangePage from '../../src/pages/admin-data-exchange/admin-data-exchange.vue'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'
import { useSimulationStore } from '../../src/stores/simulation'
import { useTelemetryStore } from '../../src/stores/telemetry'

const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'],
}

/** 创建组件测试使用的统一成功响应。 */
function successResponse(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

describe('P5 数据交换页面', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    useScenarioStore().$patch({
      draft: { config: structuredClone(fixtureSource.scenario), uiExtensions: { jammers: [], sensors: [] }, revision: 4, officialLibraryChanged: false, locked: false } as ScenarioDraft,
    })
    useSimulationStore().applyRun(structuredClone(fixtureSource.run) as SimulationRun)
    useTelemetryStore().$patch({
      frame: structuredClone(fixtureSource.frame) as unknown as TelemetryFrame,
      connectionState: 'SUBSCRIBED',
      topicSequences: { 'simulation.frame': 42, 'runtime.state': 42, 'link.metric': 42, 'jammer.event': 42, 'switch.event': 42 },
    })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/scenario-config')) return Promise.resolve(successResponse(fixtureSource.contracts.scenarioConfig))
      if (path.endsWith('/frontend-types')) return Promise.resolve(successResponse(fixtureSource.contracts.frontendTypes))
      if (path.endsWith('/csv')) return Promise.resolve(successResponse(fixtureSource.contracts.csv))
      if (path.endsWith('/data-exchange/monitor')) return Promise.resolve(successResponse(null))
      return Promise.resolve(successResponse(fixtureSource.metadata.interfaces))
    }))
  })

  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('正式加载监控显示 SQLite 实况和实际文件记录，轮询失败清除旧记录，离页停止轮询', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const record = { sequence: 2, operation: 'POSITIONS', fileName: 'platform_positions.csv', completedAt: '2026-09-12T00:00:00Z', durationMs: 2.5,
      status: 'ERROR', recordCount: null, issueCount: null, errorCode: 'LOCAL_READ_FAILED' }
    const snapshot = { service: 'HEALTHY', database: 'HEALTHY', recordStorage: 'HEALTHY', checkedAt: record.completedAt, records: [record,
      { ...record, sequence: 1, operation: 'INITIAL_NODES', fileName: 'j_1.csv', status: 'SUCCESS', recordCount: 12, issueCount: 0, errorCode: null }] }
    const fetcher = vi.fn().mockResolvedValueOnce(successResponse(snapshot))
      .mockResolvedValueOnce(successResponse({ ...snapshot, recordStorage: 'ERROR' }))
      .mockResolvedValueOnce(successResponse({ ...snapshot, database: 'ERROR' })).mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetcher)
    const wrapper = mount(ExchangeMonitor, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(wrapper.text()).toContain('本机服务正常')
    expect(wrapper.text()).toContain('SQLite检查通过')
    expect(wrapper.text()).toContain('SQLite 历史最近 50 次')
    expect(wrapper.text()).toContain('重启保留')
    expect(wrapper.get('[data-testid="local-file-records"]').text()).toContain('j_1.csv')
    expect(wrapper.get('[data-testid="local-file-records"]').text()).toContain('LOCAL_READ_FAILED')
    await vi.advanceTimersByTimeAsync(5000)
    expect(wrapper.get('[data-testid="local-monitor-error"]').text()).toContain('交换记录存储异常')
    expect(wrapper.text()).toContain('SQLite检查通过')
    await vi.advanceTimersByTimeAsync(5000)
    expect(wrapper.text()).toContain('SQLite检查失败')
    await vi.advanceTimersByTimeAsync(5000)
    expect(wrapper.text()).toContain('SQLite状态未知')
    expect(wrapper.get('[data-testid="local-file-records"]').text()).not.toContain('j_1.csv')
    expect(wrapper.get('[data-testid="local-monitor-error"]').text()).toContain('请求失败')
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('监控仅统计本页消息，区分重复与拒绝，限制缓存并清理订阅和计时器', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
    vi.setSystemTime(new Date('2026-09-11T06:01:57.327Z'))
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const telemetry = useTelemetryStore()
    const wrapper = mount(ExchangeMonitor, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const monitorTimer = intervalSpy.mock.results[intervalSpy.mock.calls.findIndex((call) => call[1] === 1000)].value
    expect(wrapper.findAll('.monitor-status')).toHaveLength(6)
    expect(wrapper.text()).toContain('AFSIM 引擎未接入')
    expect(wrapper.text()).toContain('SQLite未接入（Mock）')
    expect(wrapper.findAll('.monitor-curve')).toHaveLength(0)
    const envelope = { type: 'event', schemaVersion: '1.0', topic: 'simulation.frame', taskId: 'TASK-001', sequence: 43,
      frameId: fixtureSource.frame.frameId, simulationTime: fixtureSource.frame.simulationTime, payload: fixtureSource.frame }
    expect(telemetry.acceptEnvelope(envelope)).toBe(true)
    expect(telemetry.acceptEnvelope(envelope)).toBe(true)
    expect(telemetry.acceptEnvelope({ ...envelope, schemaVersion: '99' })).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    const table = wrapper.get('[data-testid="exchange-records"]')
    expect(table.text()).toContain('2026-09-11 14:01:57')
    expect(table.text()).toContain('通过')
    expect(table.text()).toContain('忽略')
    expect(table.text()).toContain('拒绝')
    expect(wrapper.get('[aria-label="消息处理耗时"]').text()).toContain('66.7%')
    for (let index = 0; index < 55; index += 1) telemetry.acceptEnvelope(envelope)
    await vi.advanceTimersByTimeAsync(61000)
    expect(table.findAll('.el-table__row')).toHaveLength(50)
    expect(wrapper.get('.monitor-curve').attributes('points')!.split(' ')).toHaveLength(60)
    telemetry.resetToSafeEmpty()
    await vi.advanceTimersByTimeAsync(1000)
    expect(table.findAll('.el-table__row')).toHaveLength(0)
    expect(wrapper.findAll('.monitor-curve')).toHaveLength(0)
    wrapper.unmount()
    // 只检查监控持有的采样定时器，不将 jsdom 的动画帧定时器误判为页面泄漏。
    expect(clearSpy).toHaveBeenCalledWith(monitorTimer)
    expect(telemetry.acceptEnvelope({ ...envelope, sequence: 1 })).toBe(true)
    expect(intervalSpy.mock.calls.filter((call) => call[1] === 1000)).toHaveLength(1)
  })

  it('默认展示监控，打开工具后关闭重开不丢失输入', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/admin/data-exchange', component: DataExchangePage }] })
    await router.push('/admin/data-exchange')
    const wrapper = mount(DataExchangePage, { global: { plugins: [ElementPlus, router] } })
    await flushPromises()
    expect(wrapper.get('[data-testid="exchange-monitor"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-testid="csv-contract-card"]').exists()).toBe(false)
    await wrapper.get('[data-testid="open-exchange-tools"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="csv-text"]').setValue('尚未提交的文本')
    await wrapper.get('.el-drawer__close-btn').trigger('click')
    await wrapper.get('[data-testid="open-exchange-tools"]').trigger('click')
    expect((wrapper.get('[data-testid="csv-text"]').element as HTMLTextAreaElement).value).toBe('尚未提交的文本')
    wrapper.unmount()
  })

  it('连接前的快照请求在离页后返回时不得建立通道', async () => {
    const telemetry = useTelemetryStore()
    telemetry.resetToSafeEmpty()
    const connect = vi.spyOn(telemetry, 'connect')
    const originalFetch = fetch
    let resolveFrame!: (response: Response) => void
    const pendingFrame = new Promise<Response>((resolve) => { resolveFrame = resolve })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/frames/F-00042')) return pendingFrame
      if (path.endsWith('/events')) return Promise.resolve(successResponse(fixtureSource.events))
      return originalFetch(input)
    }))
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/admin/data-exchange', component: DataExchangePage }] })
    await router.push('/admin/data-exchange')
    const wrapper = mount(DataExchangePage, { global: { plugins: [ElementPlus, router] } })
    await flushPromises()
    await wrapper.get('.connection-actions button').trigger('click')
    expect(telemetry.capabilityState).toBe('LOADING')
    wrapper.unmount()
    resolveFrame(successResponse(fixtureSource.frame))
    await flushPromises()
    expect(connect).not.toHaveBeenCalled()
    expect(telemetry.frame).toBeNull()
    expect(telemetry.connectionState).toBe('DISCONNECTED')
  })

  it('展示四项能力和七类接口，并完成内存校验', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/admin/data-exchange', component: DataExchangePage }] })
    await router.push('/admin/data-exchange#de-if-jk-yhcz')
    Element.prototype.scrollIntoView = vi.fn()
    const wrapper = mount(DataExchangePage, { global: { plugins: [ElementPlus, router] }, attachTo: document.body })
    await flushPromises()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    await router.push('/admin/data-exchange#de-if-jk-wjxt'); await flushPromises()

    expect(wrapper.findAll('[data-testid$="card"], [data-testid="scenario-json-panel"]').length).toBeGreaterThanOrEqual(4)
    expect(wrapper.findAll('.interface-item')).toHaveLength(7)
    expect(wrapper.get('[data-testid="websocket-topics"]').text()).toContain('simulation.frame')

    const csvCard = wrapper.get('[data-testid="csv-contract-card"]')
    await csvCard.findAll('button').find((button) => button.text().includes('加载合同示例'))!.trigger('click')
    await csvCard.findAll('button').find((button) => button.text().includes('校验 CSV'))!.trigger('click')
    expect(csvCard.text()).toContain('CSV 合同校验通过')
    expect(csvCard.text()).toContain('目标文件：未改变')

    const jsonCard = wrapper.get('[data-testid="scenario-json-panel"]')
    await jsonCard.findAll('button').find((button) => button.text().includes('加载当前场景'))!.trigger('click')
    await jsonCard.findAll('button').find((button) => button.text().includes('解析 JSON'))!.trigger('click')
    expect(jsonCard.text()).toContain('场景 JSON 解析通过')
    expect(jsonCard.text()).toContain('SCN-001')

    const processCard = wrapper.get('[data-testid="process-contract-card"]')
    await processCard.get('button').trigger('click')
    expect(processCard.text()).toContain('已退出')
    expect(processCard.text()).toContain('真实进程未启动')
    wrapper.unmount()
  })

  it('依赖加载失败时显示错误而不是空态', async () => {
    useScenarioStore().resetToSafeEmpty()
    useSimulationStore().resetToSafeEmpty()
    useTelemetryStore().$patch({ capabilityState: 'ERROR', connectionState: 'DISCONNECTED', resultMessage: '遥测加载失败。' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('本机服务不可用。')))

    const json = mount(ScenarioJsonPanel, { global: { plugins: [ElementPlus] } })
    await json.findAll('button').find((button) => button.text().includes('加载当前场景'))!.trigger('click')
    await flushPromises()
    expect(json.text()).toContain('失败')
    expect(json.text()).toContain('本机服务不可用')

    const process = mount(ProcessContractCard, { global: { plugins: [ElementPlus] } })
    await process.get('button').trigger('click')
    await flushPromises()
    expect(process.text()).toContain('失败')
    expect(process.text()).toContain('本机服务不可用')

    const websocket = mount(WebSocketContractCard, { global: { plugins: [ElementPlus] } })
    expect(websocket.text()).toContain('失败')
    expect(websocket.text()).toContain('遥测加载失败')
  })
})

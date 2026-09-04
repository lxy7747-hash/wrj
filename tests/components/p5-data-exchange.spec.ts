import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import ProcessContractCard from '../../src/components/data-exchange/ProcessContractCard.vue'
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
      return Promise.resolve(successResponse(fixtureSource.metadata.interfaces))
    }))
  })

  it('展示四项能力和七类接口，并完成内存校验', async () => {
    const wrapper = mount(DataExchangePage, { global: { plugins: [ElementPlus] }, attachTo: document.body })
    await flushPromises()

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

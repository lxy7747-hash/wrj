import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import LinkCalculatorContractCard from '../../src/components/blueprint/LinkCalculatorContractCard.vue'
import type { CapabilityState, TelemetryFrame } from '../../src/contracts/domain-models'
import { useTelemetryStore } from '../../src/stores/telemetry'

const frame = fixtureSource.frame as unknown as TelemetryFrame

describe('P3-3 同帧链路计算合同', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('WebSocket', undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('展示 F-00042 的端点、标准输入输出和算法边界', () => {
    const telemetryStore = useTelemetryStore()
    telemetryStore.$patch({ frame: structuredClone(frame), capabilityState: 'SUCCESS' })

    const wrapper = mount(LinkCalculatorContractCard, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="link-contract-state"]').text()).toBe('同帧通过')
    expect(wrapper.text()).toContain('F-00042')
    expect(wrapper.text()).toContain('高空前出中继节点')
    expect(wrapper.text()).toContain('地面无人集群指挥车')
    expect(wrapper.text()).toContain('4500 MHz')
    expect(wrapper.text()).toContain('3.2e-7')
    expect(wrapper.text()).toContain('浏览器仅校验和展示结果证据')
  })

  it('覆盖固定证据五态并拒绝跨帧链路证据', async () => {
    const telemetryStore = useTelemetryStore()
    telemetryStore.$patch({ frame: structuredClone(frame), capabilityState: 'SUCCESS' })
    const wrapper = mount(LinkCalculatorContractCard, { global: { plugins: [ElementPlus] } })

    const expected = {
      LOADING: '加载中', VALIDATING: '校验中', EMPTY: '暂无数据', ERROR: '证据错误',
    } as const
    for (const [state, label] of Object.entries(expected)) {
      telemetryStore.capabilityState = state as CapabilityState
      await nextTick()
      expect(wrapper.get('[data-testid="link-contract-state"]').text()).toBe(label)
    }

    const invalidFrame = structuredClone(frame)
    const target = invalidFrame.links.find((item) => item.linkId === 'L-MW-01')
    if (target === undefined) throw new Error('测试固定帧缺少 L-MW-01')
    target.time = invalidFrame.simulationTime - 1
    telemetryStore.$patch({ frame: invalidFrame, capabilityState: 'SUCCESS' })
    await nextTick()

    expect(wrapper.get('[data-testid="link-contract-state"]').text()).toBe('证据错误')
    expect(wrapper.text()).toContain('链路时刻与当前帧不一致')
  })

  it('缺少 L-MW-01 时进入空态', () => {
    const telemetryStore = useTelemetryStore()
    const missingLinkFrame = structuredClone(frame)
    missingLinkFrame.links = missingLinkFrame.links.filter((link) => link.linkId !== 'L-MW-01')
    telemetryStore.$patch({ frame: missingLinkFrame, capabilityState: 'SUCCESS' })

    const wrapper = mount(LinkCalculatorContractCard, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="link-contract-state"]').text()).toBe('暂无数据')
    expect(wrapper.text()).toContain('当前帧没有 L-MW-01 链路计算结果')
  })

  it.each([
    ['发送端', 'UAV-01'],
    ['接收端', 'GCC-01'],
  ])('%s平台缺失时进入错误态', async (endpoint, platformId) => {
    const telemetryStore = useTelemetryStore()
    const missingEndpointFrame = structuredClone(frame)
    missingEndpointFrame.platforms = missingEndpointFrame.platforms.filter(
      (platform) => platform.platformId !== platformId,
    )
    telemetryStore.$patch({ frame: missingEndpointFrame, capabilityState: 'SUCCESS' })

    const wrapper = mount(LinkCalculatorContractCard, { global: { plugins: [ElementPlus] } })
    await nextTick()

    expect(wrapper.get('[data-testid="link-contract-state"]').text()).toBe('证据错误')
    expect(wrapper.text()).toContain(`${endpoint}不存在`)
  })

  it('消费当前帧的 link.metric 指标', async () => {
    const telemetryStore = useTelemetryStore()
    telemetryStore.$patch({ frame: structuredClone(frame), capabilityState: 'SUCCESS' })
    const wrapper = mount(LinkCalculatorContractCard, { global: { plugins: [ElementPlus] } })
    const summaries = structuredClone(frame.linkSummaries)
    const target = summaries.find((summary) => (
      summary.sourcePlatform === 'UAV-01'
      && summary.destPlatform === 'GCC-01'
      && summary.linkType === 'MICROWAVE'
    ))
    if (target === undefined) throw new Error('测试固定帧缺少 L-MW-01 链路摘要')
    target.currentSnr = 21.5
    target.currentBer = 0.000004
    target.status = 'DOWN'

    expect(telemetryStore.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: 'TASK-001', sequence: 1,
      simulationTime: 42, frameId: 'F-00042', payload: summaries,
    })).toBe(true)
    await nextTick()

    expect(wrapper.text()).toContain('21.5 dB')
    expect(wrapper.text()).toContain('4.0e-6')
    expect(wrapper.text()).toContain('规范状态中断')
  })

  it('空态挂载时复用 telemetryStore 加载固定帧', () => {
    const telemetryStore = useTelemetryStore()
    const loadFrame = vi.spyOn(telemetryStore, 'loadFrame').mockResolvedValue(true)

    mount(LinkCalculatorContractCard, { global: { plugins: [ElementPlus] } })

    expect(loadFrame).toHaveBeenCalledOnce()
    expect(loadFrame).toHaveBeenCalledWith('RUN-001', 'F-00042')
  })
})

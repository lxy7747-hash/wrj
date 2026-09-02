import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import CompositeLossExample from '../../src/components/interactions/CompositeLossExample.vue'
import type { TelemetryFrame } from '../../src/contracts/domain-models'
import { useTelemetryStore } from '../../src/stores/telemetry'

const frame = fixtureSource.frame as unknown as TelemetryFrame

describe('P3-4 传播损耗固定算例', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('展示四项损耗合计、模型版本和同帧链路结果', () => {
    const telemetryStore = useTelemetryStore()
    telemetryStore.$patch({ frame: structuredClone(frame), capabilityState: 'SUCCESS' })

    const wrapper = mount(CompositeLossExample, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="composite-loss-state"]').text()).toBe('算例通过')
    expect(wrapper.text()).toContain('120 + 12 + 5 + 5.5 = 142.5 dB')
    expect(wrapper.text()).toContain('COMPOSITE-LOSS-1.0')
    expect(wrapper.text()).toContain('F-00042 @ 42 s')
    expect(wrapper.text()).toContain('链路路径损耗142.5 dB')
  })

  it('覆盖实际五态并拒绝损耗分量合计错误', async () => {
    const telemetryStore = useTelemetryStore()
    telemetryStore.$patch({ frame: structuredClone(frame), capabilityState: 'SUCCESS' })
    const wrapper = mount(CompositeLossExample, { global: { plugins: [ElementPlus] } })

    const expected = {
      LOADING: '加载中', VALIDATING: '校验中',
      SUCCESS: '算例通过', EMPTY: '暂无数据', ERROR: '证据错误',
    } as const
    for (const [state, label] of Object.entries(expected)) {
      telemetryStore.capabilityState = state as keyof typeof expected
      await nextTick()
      expect(wrapper.get('[data-testid="composite-loss-state"]').text()).toBe(label)
    }

    const invalidFrame = structuredClone(frame)
    const target = invalidFrame.evidence.losses.find((item) => item.linkId === 'L-MW-01')
    if (target === undefined) throw new Error('测试固定帧缺少 L-MW-01 损耗证据')
    target.obstructionLossDb += 1
    telemetryStore.$patch({ frame: invalidFrame, capabilityState: 'SUCCESS' })
    await nextTick()

    expect(wrapper.get('[data-testid="composite-loss-state"]').text()).toBe('证据错误')
    expect(wrapper.text()).toContain('损耗分量合计与总路径损耗不一致')
  })

  it('拒绝链路损耗不一致和非同帧证据', async () => {
    const telemetryStore = useTelemetryStore()
    const mismatchedLinkFrame = structuredClone(frame)
    const link = mismatchedLinkFrame.links.find((item) => item.linkId === 'L-MW-01')
    if (link === undefined) throw new Error('测试固定帧缺少 L-MW-01 链路')
    link.pathLoss += 1
    telemetryStore.$patch({ frame: mismatchedLinkFrame, capabilityState: 'SUCCESS' })
    const wrapper = mount(CompositeLossExample, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="composite-loss-state"]').text()).toBe('证据错误')
    expect(wrapper.text()).toContain('链路结果与损耗证据不一致')

    const mismatchedFrame = structuredClone(frame)
    mismatchedFrame.evidence.synchronization.effectiveFrameId = 'F-00041'
    telemetryStore.$patch({ frame: mismatchedFrame, capabilityState: 'SUCCESS' })
    await nextTick()

    expect(wrapper.get('[data-testid="composite-loss-state"]').text()).toBe('证据错误')
    expect(wrapper.text()).toContain('损耗证据与当前帧不一致')
  })

  it('证据缺失进入空态，初始空态复用固定帧加载', async () => {
    const telemetryStore = useTelemetryStore()
    const missingFrame = structuredClone(frame)
    missingFrame.evidence.losses = missingFrame.evidence.losses.filter((item) => item.linkId !== 'L-MW-01')
    telemetryStore.$patch({ frame: missingFrame, capabilityState: 'SUCCESS' })
    const wrapper = mount(CompositeLossExample, { global: { plugins: [ElementPlus] } })
    expect(wrapper.get('[data-testid="composite-loss-state"]').text()).toBe('暂无数据')

    wrapper.unmount()
    telemetryStore.resetToSafeEmpty()
    const loadFrame = vi.spyOn(telemetryStore, 'loadFrame').mockResolvedValue(true)
    mount(CompositeLossExample, { global: { plugins: [ElementPlus] } })
    expect(loadFrame).toHaveBeenCalledWith('RUN-001', 'F-00042')
  })
})

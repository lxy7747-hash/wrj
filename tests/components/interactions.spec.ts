import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import CompositeLossExample from '../../src/components/interactions/CompositeLossExample.vue'
import SnrBerExample from '../../src/components/interactions/SnrBerExample.vue'
import type { TelemetryFrame } from '../../src/contracts/domain-models'
import { useTelemetryStore } from '../../src/stores/telemetry'

const frame = fixtureSource.frame as unknown as TelemetryFrame

/** 创建统一成功响应。 */
function successResponse(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

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

describe('P3-5 SNR/BER 固定算例', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('展示接收功率、噪声、带宽、调制编码、SNR、BER 和模型版本', () => {
    const telemetryStore = useTelemetryStore()
    telemetryStore.$patch({ frame: structuredClone(frame), capabilityState: 'SUCCESS' })

    const wrapper = mount(SnrBerExample, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="snr-ber-state"]').text()).toBe('算例通过')
    expect(wrapper.text()).toContain('-84 dBm')
    expect(wrapper.text()).toContain('-104 dBm')
    expect(wrapper.text()).toContain('20 MHz')
    expect(wrapper.text()).toContain('QPSK')
    expect(wrapper.text()).toContain('UNCODED')
    expect(wrapper.text()).toContain('18.62 dB')
    expect(wrapper.text()).toContain('3.2e-7')
    expect(wrapper.text()).toContain('SNBER-1.2')
  })

  it('通过固定帧公开加载动作保持校验态并完成算例', async () => {
    const telemetryStore = useTelemetryStore()
    let resolveEvents!: (value: unknown) => void
    const eventsPayload = new Promise<unknown>((resolve) => { resolveEvents = resolve })
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      String(input).endsWith('/events')
        ? { ok: true, json: vi.fn().mockReturnValue(eventsPayload) } as unknown as Response
        : successResponse(frame),
    )))

    const wrapper = mount(SnrBerExample, { global: { plugins: [ElementPlus] } })
    await vi.waitFor(() => expect(telemetryStore.capabilityState).toBe('VALIDATING'))
    await nextTick()
    expect(wrapper.get('[data-testid="snr-ber-state"]').text()).toBe('校验中')

    resolveEvents({ ok: true, data: fixtureSource.events })
    await vi.waitFor(() => expect(telemetryStore.capabilityState).toBe('SUCCESS'))
    expect(wrapper.get('[data-testid="snr-ber-state"]').text()).toBe('算例通过')
  })

  it('通过真实加载结果展示调制、编码和模型版本字段错误', async () => {
    for (const [field, value, code] of [
      ['coding', 'LDPC', 'UNSUPPORTED_CODING'],
      ['modulation', '16QAM', 'UNSUPPORTED_MODULATION'],
      ['qualityModelVersion', 'SNBER-2.0', 'QUALITY_MODEL_VERSION_MISMATCH'],
    ] as const) {
      setActivePinia(createPinia())
      const invalidFrame = structuredClone(frame)
      const index = invalidFrame.links.findIndex((link) => link.linkId === 'L-MW-01')
      if (index < 0) throw new Error('测试固定帧缺少 L-MW-01 链路')
      Reflect.set(invalidFrame.links[index]!, field, value)
      vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
        successResponse(String(input).endsWith('/events') ? fixtureSource.events : invalidFrame),
      )))

      const telemetryStore = useTelemetryStore()
      const wrapper = mount(SnrBerExample, { global: { plugins: [ElementPlus] } })
      await vi.waitFor(() => expect(telemetryStore.capabilityState).toBe('ERROR'))

      expect(telemetryStore.frame).toBeNull()
      expect(wrapper.get('[data-testid="snr-ber-state"]').text()).toBe('证据错误')
      expect(wrapper.text()).toContain(code)
      expect(wrapper.text()).toContain(`links[${index}].${field}`)
      wrapper.unmount()
    }
  })

  it('拒绝 SNR 结果或生效帧不一致', async () => {
    const telemetryStore = useTelemetryStore()
    const invalidSnrFrame = structuredClone(frame)
    const target = invalidSnrFrame.links.find((item) => item.linkId === 'L-MW-01')
    if (target === undefined) throw new Error('测试固定帧缺少 L-MW-01 链路')
    target.snr += 1
    telemetryStore.$patch({ frame: invalidSnrFrame, capabilityState: 'SUCCESS' })
    const wrapper = mount(SnrBerExample, { global: { plugins: [ElementPlus] } })

    expect(wrapper.get('[data-testid="snr-ber-state"]').text()).toBe('证据错误')
    expect(wrapper.text()).toContain('接收功率、等效噪声与 SNR 不一致')

    const invalidFrame = structuredClone(frame)
    invalidFrame.evidence.synchronization.effectiveFrameId = 'F-00041'
    telemetryStore.$patch({ frame: invalidFrame, capabilityState: 'SUCCESS' })
    await nextTick()
    expect(wrapper.text()).toContain('质量证据与当前帧不一致')
  })

  it('链路缺失进入空态，初始空态复用固定帧加载', () => {
    const telemetryStore = useTelemetryStore()
    const missingFrame = structuredClone(frame)
    missingFrame.links = missingFrame.links.filter((item) => item.linkId !== 'L-MW-01')
    telemetryStore.$patch({ frame: missingFrame, capabilityState: 'SUCCESS' })
    const wrapper = mount(SnrBerExample, { global: { plugins: [ElementPlus] } })
    expect(wrapper.get('[data-testid="snr-ber-state"]').text()).toBe('暂无数据')

    wrapper.unmount()
    telemetryStore.resetToSafeEmpty()
    const loadFrame = vi.spyOn(telemetryStore, 'loadFrame').mockResolvedValue(true)
    mount(SnrBerExample, { global: { plugins: [ElementPlus] } })
    expect(loadFrame).toHaveBeenCalledWith('RUN-001', 'F-00042')
  })
})

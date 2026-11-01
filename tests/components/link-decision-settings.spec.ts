import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElInputNumber, ElSwitch } from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LinkSettingsPanel from '../../src/components/scenarios/LinkSettingsPanel.vue'
import type { ScenarioConfig, ScenarioLinkSettings } from '../../src/contracts/domain-models'
import { LINK_DECISION_DEFAULTS, readLinkSettings } from '../../src/features/scenarios/link-settings'

enableAutoUnmount(afterEach)
const dialogStub = { template: '<div><slot /><slot name="footer" /></div>' }
const config: Pick<ScenarioConfig, 'platforms'> = { platforms: [] }
const legacy: ScenarioLinkSettings = {
  enabledSatellites: { TIANTONG: false, SHENTONG: false },
  switchCooldownS: 0, switchStableChecks: 1,
  priority: ['SAT', 'MICROWAVE', 'DATALINK', 'LASER', 'FIBER'],
}

function panel(modelValue?: ScenarioLinkSettings, disabled = false) {
  return mount(LinkSettingsPanel, {
    props: { modelValue, platforms: [], disabled, typeOptions: [], dialogVisible: true,
      fieldMessage: () => '' },
    global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
  })
}

describe('质量选路配置', () => {
  it('新场景使用大纲的 3 帧、5 秒和质量改善默认值，旧的显式配置保留', () => {
    expect(readLinkSettings(config)).toMatchObject(LINK_DECISION_DEFAULTS)
    const before = structuredClone(legacy)
    expect(readLinkSettings({ ...config, linkSettings: legacy })).toMatchObject({ switchStableChecks: 1, switchCooldownS: 0 })
    expect(legacy).toEqual(before)
    expect(Object.hasOwn(legacy, 'minimumGxbDb')).toBe(false)
  })

  it('展示和修改门限，保留同一场景其他已配置参数', async () => {
    const wrapper = panel(legacy)
    const stable = wrapper.findAllComponents(ElInputNumber).find(item => item.attributes('data-testid') === 'link-switch-stable-checks')!
    expect(stable.props('modelValue')).toBe(1)
    for (const [key, value] of Object.entries({
      switchCooldownFrames: 60, minimumGxbDb: 7, maximumBer: 1e-6,
      minimumGxbImprovementDb: 4, minimumBerImprovementFactor: 20, minimumSpatialIsolationDb: 10,
    })) {
      const input = wrapper.findAllComponents(ElInputNumber).find(item => item.attributes('data-testid') === `link-decision-${key}`)!
      expect(input, key).toBeDefined()
      input.vm.$emit('update:modelValue', value)
      expect(wrapper.emitted('update:modelValue')!.at(-1)![0]).toMatchObject({ ...legacy, [key]: value })
    }
    // 项目的 .vue 声明不展开 SFC props；运行时仍由真实组件接收并验证这些输入。
    await wrapper.setProps({ fieldMessage: (path: string) => path === 'minimumBerImprovementFactor' ? '改善倍数必须大于等于 1' : '' } as never)
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.text()).toContain('改善倍数必须大于等于 1'))
  })

  it('清空输入保留非法值供保存校验阻止，锁定后不允许写回', () => {
    const wrapper = panel()
    const input = wrapper.findAllComponents(ElInputNumber).find(item => item.attributes('data-testid') === 'link-decision-maximumBer')!
    expect(input.props('modelValue')).toBe(1e-5)
    input.vm.$emit('update:modelValue', undefined)
    expect((wrapper.emitted('update:modelValue')!.at(-1)![0] as ScenarioLinkSettings).maximumBer).toBeNaN()
    const locked = panel(legacy, true)
    const lockedInput = locked.findAllComponents(ElInputNumber).find(item => item.attributes('data-testid') === 'link-decision-maximumBer')!
    lockedInput.vm.$emit('update:modelValue', 1e-6)
    expect(locked.emitted('update:modelValue')).toBeUndefined()
  })

  it('硬失效门限由用户明确启用和填写，关闭后移除而不代入默认功率', async () => {
    const wrapper = panel(legacy)
    const toggle = () => wrapper.findAllComponents(ElSwitch).find(item => item.attributes('data-testid') === 'link-decision-enable-minimumReceivedPowerDbm')!
    expect(toggle().props('modelValue')).toBe(false)
    toggle().vm.$emit('update:modelValue', true)
    const pending = wrapper.emitted('update:modelValue')!.at(-1)![0] as ScenarioLinkSettings
    expect(pending.minimumReceivedPowerDbm).toBeNaN()
    await wrapper.setProps({ modelValue: pending } as never)
    wrapper.findAllComponents(ElInputNumber).find(item => item.attributes('data-testid') === 'link-decision-minimumReceivedPowerDbm')!.vm.$emit('update:modelValue', -100)
    const configured = wrapper.emitted('update:modelValue')!.at(-1)![0] as ScenarioLinkSettings
    expect(configured.minimumReceivedPowerDbm).toBe(-100)
    await wrapper.setProps({ modelValue: configured } as never)
    toggle().vm.$emit('update:modelValue', false)
    expect(Object.hasOwn(wrapper.emitted('update:modelValue')!.at(-1)![0] as object, 'minimumReceivedPowerDbm')).toBe(false)
  })
})

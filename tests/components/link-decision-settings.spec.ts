import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElInputNumber, ElSwitch } from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LinkSettingsPanel from '../../src/components/scenarios/LinkSettingsPanel.vue'
import type { ScenarioConfig, ScenarioLinkSettings } from '../../src/contracts/domain-models'
import { LINK_DECISION_DEFAULTS, readLinkSettings } from '../../src/features/scenarios/link-settings'

enableAutoUnmount(afterEach)
const dialogStub = { props: ['modelValue'], template: '<section v-if="modelValue"><slot /><slot name="footer" /></section>' }
const config: Pick<ScenarioConfig, 'platforms'> = { platforms: [] }
const legacy: ScenarioLinkSettings = {
  enabledSatellites: { TIANTONG: false, SHENTONG: false },
  switchCooldownS: 0, switchStableChecks: 1,
}

function panel(modelValue?: ScenarioLinkSettings, disabled = false) {
  return mount(LinkSettingsPanel, {
    props: { modelValue, platforms: [], disabled, typeOptions: [], dialogVisible: true,
      fieldMessage: () => '' },
    global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
  })
}

async function toggleSection(wrapper: VueWrapper, section: string) {
  const details = wrapper.get(`[data-testid="${section}"]`)
  const toggled = new Promise<Event>(resolve => details.element.addEventListener('toggle', resolve, { once: true }))
  await details.get('summary').trigger('click')
  await toggled
  await flushPromises()
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
    await toggleSection(wrapper, 'link-strategy-advanced')
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

  it('清空输入保留非法值供保存校验阻止，锁定后不允许写回', async () => {
    const wrapper = panel()
    await toggleSection(wrapper, 'link-strategy-advanced')
    const input = wrapper.findAllComponents(ElInputNumber).find(item => item.attributes('data-testid') === 'link-decision-maximumBer')!
    expect(input.props('modelValue')).toBe(1e-5)
    input.vm.$emit('update:modelValue', undefined)
    expect((wrapper.emitted('update:modelValue')!.at(-1)![0] as ScenarioLinkSettings).maximumBer).toBeNaN()
    const locked = panel(legacy, true)
    await toggleSection(locked, 'link-strategy-advanced')
    const lockedInput = locked.findAllComponents(ElInputNumber).find(item => item.attributes('data-testid') === 'link-decision-maximumBer')!
    lockedInput.vm.$emit('update:modelValue', 1e-6)
    expect(locked.emitted('update:modelValue')).toBeUndefined()
  })

  it('设备失效标定门限默认关闭并使用默认值，开启后可编辑并在关闭时恢复默认', async () => {
    const wrapper = panel(legacy)
    await toggleSection(wrapper, 'link-strategy-advanced')
    const labels = wrapper.findAll('.link-settings__failure-label').map(item => item.text())
    expect(labels).toEqual(['紧急阈值', '告警阈值', '质量阈值'])
    expect(wrapper.find('[data-testid="link-calc-emergencyThreshold"]').exists()).toBe(false)
    const range = (field: string) => wrapper.get(`#link-calc-range-${field}`).text()
    expect(range('emergencyThreshold')).toBe('可填 0.000001～1（含两端）')
    expect(range('warningThreshold')).toBe('可填 0.0000001～0.00001（含两端）')
    expect(range('valueThresholdBer')).toBe('可填大于 0 且不大于 0.000001 的数值')
    for (const value of ['0.00001', '0.000001', '0.0000001']) expect(wrapper.text()).toContain(`默认 ${value}`)
    expect(wrapper.get('[data-testid="link-strategy-advanced"] > summary').text()).toContain('默认参数')

    const toggle = () => wrapper.findAllComponents(ElSwitch).find(item => item.attributes('data-testid') === 'link-calc-enable-emergencyThreshold')!
    expect(toggle().props('modelValue')).toBe(false)
    toggle().vm.$emit('update:modelValue', true)
    await flushPromises()
    expect(wrapper.get('[data-testid="link-strategy-advanced"] > summary').text()).toContain('已启用 1 项标定')

    const emergency = wrapper.get<HTMLInputElement>('[data-testid="link-calc-emergencyThreshold"]')
    expect(emergency.element.value).toBe('0.00001')
    for (const value of ['0.', '0.0000200']) {
      emergency.element.value = value
      await emergency.trigger('input')
      await flushPromises()
      expect(emergency.element.value).toBe(value)
    }
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await emergency.trigger('change')
    await flushPromises()
    const updated = wrapper.emitted('update:modelValue')!.at(-1)![0] as ScenarioLinkSettings
    expect(updated.linkCalc?.emergencyThreshold).toBe(2e-5)
    await wrapper.setProps({ modelValue: updated } as never)
    expect(range('warningThreshold')).toBe('可填 0.0000001～0.00002（含两端）')

    toggle().vm.$emit('update:modelValue', false)
    await flushPromises()
    const restored = wrapper.emitted('update:modelValue')!.at(-1)![0] as ScenarioLinkSettings
    expect(restored.linkCalc?.emergencyThreshold).toBe(1e-5)
    await wrapper.setProps({ modelValue: restored } as never)
    expect(wrapper.find('[data-testid="link-calc-emergencyThreshold"]').exists()).toBe(false)
    expect(range('warningThreshold')).toBe('可填 0.0000001～0.00001（含两端）')

    const message = '告警阈值不能高于紧急阈值。'
    const warningHint = wrapper.get('#link-calc-hint-warningThreshold')
    const warningRow = warningHint.element.closest('.link-settings__failure-item')!
    await wrapper.setProps({ fieldMessage: (path: string) => path === 'linkCalc.warningThreshold' ? message : '' } as never)
    expect(warningRow.querySelectorAll('.link-settings__hint')).toHaveLength(1)
    expect(warningHint.text()).toBe(message)
    expect(warningHint.classes()).toContain('link-settings__hint--error')
    expect(warningHint.find('#link-calc-range-warningThreshold').exists()).toBe(false)

    await wrapper.setProps({ fieldMessage: () => '' } as never)
    expect(warningHint.classes()).not.toContain('link-settings__hint--error')
    expect(range('warningThreshold')).toBe('可填 0.0000001～0.00001（含两端）')
  })
})


it('修改计算周期不覆盖历史周期，锁定时不写回', async () => {
  const wrapper = panel({ ...legacy, messageIntervalS: 2 })
  const input = (id: string) => wrapper.findAllComponents(ElInputNumber).find(item => item.attributes('data-testid') === id)!
  expect(input('link-message-interval')).toBeUndefined()
  expect(wrapper.text()).not.toContain('当前交付脚本的业务发送周期')
  expect(input('link-calc-updateIntervalS').props('modelValue')).toBe(5)
  input('link-calc-updateIntervalS').vm.$emit('update:modelValue', 7)
  expect(wrapper.emitted('update:modelValue')!.at(-1)![0]).toMatchObject({ messageIntervalS: 2, linkCalc: { updateIntervalS: 7 } })
  await wrapper.setProps({ disabled: true } as never)
  const count = wrapper.emitted('update:modelValue')!.length
  input('link-calc-updateIntervalS').vm.$emit('update:modelValue', 4)
  expect(wrapper.emitted('update:modelValue')).toHaveLength(count)
})

it('链路设置按展开状态挂载高级控件，重开弹框时保留写回值', async () => {
  const wrapper = panel(legacy)
  const selectors = ['link-switch-cooldown', 'hot-link-end-type']
  for (const id of selectors) expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false)

  const interval = () => wrapper.findAllComponents(ElInputNumber).find(item => item.attributes('data-testid') === 'link-calc-updateIntervalS')
  expect(interval()!.element.closest('details')).toBeNull()
  interval()!.vm.$emit('update:modelValue', 7)
  const settings = wrapper.emitted('update:modelValue')!.at(-1)![0]
  await wrapper.setProps({ modelValue: settings } as never)

  await toggleSection(wrapper, 'link-strategy-advanced')
  expect(wrapper.find('[data-testid="link-switch-cooldown"]').exists()).toBe(true)
  expect(interval()!.props('modelValue')).toBe(7)

  await wrapper.setProps({ dialogVisible: false } as never)
  await wrapper.setProps({ dialogVisible: true } as never)
  for (const id of selectors) expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false)
  expect(interval()!.props('modelValue')).toBe(7)
})

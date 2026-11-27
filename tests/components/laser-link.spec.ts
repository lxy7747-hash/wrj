import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import LinkEditorDialog from '../../src/components/scenarios/LinkEditorDialog.vue'
import type { Link, Platform, ScenarioConfig } from '../../src/contracts/domain-models'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'

const dialogStub = { props: ['modelValue'], template: '<section v-if="modelValue"><slot /><slot name="footer" /></section>' }
const typeOptions = [
  { value: 'SAT', label: '卫星' }, { value: 'MICROWAVE', label: '微波' },
  { value: 'DATALINK', label: '数传' }, { value: 'LASER', label: '激光' }, { value: 'FIBER', label: '光纤' },
] as const

function link(type: Link['type'] = 'MICROWAVE'): Link {
  const sample = structuredClone(fixtureSource.scenario.links.find(item => item.type === 'MICROWAVE')) as Link
  return { ...sample, type }
}

function mountEditor(value: Link): VueWrapper {
  return mount(LinkEditorDialog, {
    props: { modelValue: true, link: value, editing: true, error: '', pending: false, locked: false,
      platforms: fixtureSource.scenario.platforms as Platform[], linkTypeOptions: typeOptions,
      linkDirectionLabels: { FORWARD: '前向', REVERSE: '返向' }, minimumStep: 0.001 },
    global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
  })
}

function select(wrapper: VueWrapper, testId: string) {
  const field = wrapper.findAllComponents({ name: 'ElSelect' }).find(component => component.attributes('data-testid') === testId)
  expect(field, `未找到 ${testId}`).toBeDefined()
  return field!
}

function numberInput(wrapper: VueWrapper, testId: string) {
  const field = wrapper.findAllComponents({ name: 'ElInputNumber' }).find(component => component.attributes('data-testid') === testId)
  expect(field, `未找到 ${testId}`).toBeDefined()
  return field!
}

async function switchToLaser(wrapper: VueWrapper): Promise<void> {
  select(wrapper, 'link-type').vm.$emit('update:modelValue', 'LASER')
  select(wrapper, 'link-type').vm.$emit('change', 'LASER')
  await flushPromises()
}

function fillLaser(wrapper: VueWrapper): void {
  numberInput(wrapper, 'link-frequency').vm.$emit('update:modelValue', 193_500_000)
  numberInput(wrapper, 'link-bandwidth').vm.$emit('update:modelValue', 1_000)
  numberInput(wrapper, 'link-power').vm.$emit('update:modelValue', 20)
  numberInput(wrapper, 'link-data-rate').vm.$emit('update:modelValue', 100)
  numberInput(wrapper, 'laser-eirp').vm.$emit('update:modelValue', 12)
  numberInput(wrapper, 'laser-gt').vm.$emit('update:modelValue', 8)
  numberInput(wrapper, 'laser-noise').vm.$emit('update:modelValue', 4)
}

describe('激光链路编辑器', () => {
  it('切换激光时采用 1112 lazer_link 9 项有效物理参数，并隐藏不落脚本的冗余字段', async () => {
    const wrapper = mountEditor(link())
    await switchToLaser(wrapper)

    // 发射 193500 GHz=193500000 MHz，接收 681300 GHz=681300000 MHz；带宽 1000 MHz；功率 0.1 W；速率 2500 Mbps。
    expect(numberInput(wrapper, 'link-frequency').props('modelValue')).toBe(193_500_000)
    expect(numberInput(wrapper, 'link-bandwidth').props('modelValue')).toBe(1_000)
    expect(numberInput(wrapper, 'link-power').props('modelValue')).toBe(0.1)
    expect(numberInput(wrapper, 'link-data-rate').props('modelValue')).toBe(2_500)
    expect(numberInput(wrapper, 'link-rx-frequency').props('modelValue')).toBe(681_300_000)
    expect(numberInput(wrapper, 'link-rx-bandwidth').props('modelValue')).toBe(1_000)
    // 激光链路有效数值：EIRP 0 dBW / G-T 0 dB/K / 噪声 5 dB。
    expect(numberInput(wrapper, 'laser-eirp').props('modelValue')).toBe(0)
    expect(numberInput(wrapper, 'laser-gt').props('modelValue')).toBe(0)
    expect(wrapper.get('[data-testid="link-laser-advanced"]').attributes('open')).toBeUndefined()
    expect(numberInput(wrapper, 'laser-noise').props('modelValue')).toBe(5)
    expect(wrapper.get('[data-testid="laser-wavelength"]').text()).toContain('1549')
    // 不落脚本的光学口径/脉宽/OOK/误码率阈值/增益抗干扰均不再渲染。
    for (const removed of [
      'laser-tx-aperture', 'laser-rx-aperture', 'laser-pulse-width', 'laser-modulation',
      'link-quality-advanced', 'link-ber-threshold', 'link-gain-advanced',
      'link-modulation', 'link-tx-polarization', 'link-rx-polarization', 'link-noise-figure',
    ]) {
      expect(wrapper.find(`[data-testid="${removed}"]`).exists(), removed).toBe(false)
    }

    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    const emitted = wrapper.emitted('apply')![0]![0] as Link
    expect(emitted).not.toHaveProperty('laser')
    expect(emitted).toMatchObject({ type: 'LASER', frequency: 193_500_000, rxFrequency: 681_300_000, bandwidth: 1_000, txPower: 0.1, dataRate: 2_500, eirpDbw: 0, gtDbk: 0, noiseFigureDb: 5 })
    expect(emitted.antennaGain).toEqual({ tx: 45, rx: 45 })
    wrapper.unmount()
  })

  it('激光增益与噪声校验失败时自动展开并定位错误', async () => {
    const wrapper = mountEditor(link('LASER'))
    await wrapper.setProps({ validate: () => [{
      severity: 'ERROR', code: 'NOISE_FIGURE_INVALID', fieldPath: 'noiseFigureDb', message: '噪声系数不能为负。',
    }] })
    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    expect(wrapper.get('[data-testid="link-laser-advanced"]').attributes('open')).toBeDefined()
    const field = wrapper.findAllComponents({ name: 'ElFormItem' }).find(item => item.props('label') === '噪声系数（dB）')
    expect(field?.props('error')).toBe('噪声系数不能为负。')
    wrapper.unmount()
  })

  it('编辑激光 9 项有效物理参数并通过写入校验', async () => {
    const wrapper = mountEditor(link())
    await switchToLaser(wrapper)
    fillLaser(wrapper)
    await flushPromises()
    expect(wrapper.get('[data-testid="laser-wavelength"]').text()).toContain('1549.31')

    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    const emitted = wrapper.emitted('apply')![0]![0] as Link
    expect(emitted).toMatchObject({
      type: 'LASER', frequency: 193_500_000, bandwidth: 1_000, txPower: 20, dataRate: 100,
      eirpDbw: 12, gtDbk: 8, noiseFigureDb: 4,
    })
    const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
    Object.assign(config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
    config.links[0] = emitted
    expect(inspectScenarioConfig(config, 'write').result.valid).toBe(true)
    wrapper.unmount()
  })

  it('取消不改写原链路；重开旧激光链路保留历史字段，切回射频会清除 laser 并套用射频默认值', async () => {
    const original: Link = {
      ...link('LASER'), frequency: 193_500_000, bandwidth: 1_000, txPower: 20, dataRate: 100, rxFrequency: 194_000_000, rxBandwidth: 2_000,
      laser: { txApertureDiameterM: 0.1, rxApertureDiameterM: 0.1, pulseWidthS: 1e-8, modulation: 'OOK' },
    }
    const before = structuredClone(original)
    const wrapper = mountEditor(original)
    expect(numberInput(wrapper, 'link-rx-frequency').props('modelValue')).toBe(194_000_000)
    expect(numberInput(wrapper, 'link-rx-bandwidth').props('modelValue')).toBe(2_000)
    numberInput(wrapper, 'link-rx-frequency').vm.$emit('update:modelValue', 194_500_000)
    numberInput(wrapper, 'link-rx-frequency').vm.$emit('update:modelValue', undefined)
    numberInput(wrapper, 'link-rx-bandwidth').vm.$emit('update:modelValue', undefined)
    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    const clearedCarrier = wrapper.emitted('apply')![0]![0] as Link
    expect(clearedCarrier).not.toHaveProperty('rxFrequency')
    expect(clearedCarrier).not.toHaveProperty('rxBandwidth')
    // 未切换类型时，历史 laser 扩展字段保持无损兼容。
    expect(clearedCarrier.laser).toEqual(original.laser)
    numberInput(wrapper, 'laser-noise').vm.$emit('update:modelValue', 9)
    await wrapper.get('[data-testid="cancel-link"]').trigger('click')
    expect(original).toEqual(before)

    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true })
    expect(numberInput(wrapper, 'link-rx-frequency').props('modelValue')).toBe(194_000_000)
    select(wrapper, 'link-type').vm.$emit('update:modelValue', 'MICROWAVE')
    select(wrapper, 'link-type').vm.$emit('change', 'MICROWAVE')
    await flushPromises()
    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    const emitted = wrapper.emitted('apply')!.at(-1)![0] as Link
    expect(emitted).not.toHaveProperty('laser')
    expect(emitted).toMatchObject({ type: 'MICROWAVE', frequency: 8200, bandwidth: 30, txPower: 20, dataRate: 80 })
    wrapper.unmount()
  })
})

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
  numberInput(wrapper, 'laser-tx-aperture').vm.$emit('update:modelValue', 0.1)
  numberInput(wrapper, 'laser-rx-aperture').vm.$emit('update:modelValue', 0.1)
  numberInput(wrapper, 'laser-pulse-width').vm.$emit('update:modelValue', 10)
  select(wrapper, 'laser-modulation').vm.$emit('update:modelValue', 'OOK')
}

describe('激光链路编辑器', () => {
  it('切换激光时采用 1112 lazer_link 缺省参数集，不虚构光学扩展或显示射频字段', async () => {
    const wrapper = mountEditor(link())
    await switchToLaser(wrapper)

    // 频率 681300 GHz=681300000 MHz；带宽 1000 MHz；功率 0.1 W；速率 2500 Mbps。
    expect(numberInput(wrapper, 'link-frequency').props('modelValue')).toBe(681_300_000)
    expect(numberInput(wrapper, 'link-bandwidth').props('modelValue')).toBe(1_000)
    expect(numberInput(wrapper, 'link-power').props('modelValue')).toBe(0.1)
    expect(numberInput(wrapper, 'link-data-rate').props('modelValue')).toBe(2_500)
    expect(numberInput(wrapper, 'link-rx-frequency').props('modelValue')).toBe(681_300_000)
    expect(numberInput(wrapper, 'link-rx-bandwidth').props('modelValue')).toBe(1_000)
    // 激光链路可选数值：EIRP 20 dBW / G-T 15 dB/K / 噪声 5 dB。
    expect(numberInput(wrapper, 'laser-eirp').props('modelValue')).toBe(20)
    expect(numberInput(wrapper, 'laser-gt').props('modelValue')).toBe(15)
    expect(wrapper.get('[data-testid="link-laser-advanced"]').attributes('open')).toBeUndefined()
    expect(numberInput(wrapper, 'laser-noise').props('modelValue')).toBe(5)
    // 光学口径/脉宽/OOK 为可选扩展，切换时不强制填写。
    for (const id of ['laser-tx-aperture', 'laser-rx-aperture', 'laser-pulse-width']) {
      expect(numberInput(wrapper, id).props('modelValue')).toBeUndefined()
    }
    expect(select(wrapper, 'laser-modulation').props('modelValue')).toBeUndefined()
    const modulation = wrapper.get('[data-testid="link-quality-advanced"] [data-testid="laser-modulation"]')
    expect(modulation.element.closest('.el-form-item')?.querySelector('label')?.textContent).toBe('调制方式')
    const threshold = wrapper.get('[data-testid="link-quality-advanced"] [data-testid="link-ber-threshold"]')
    expect(threshold.element.closest('.el-form-item')?.parentElement).toBe(modulation.element.closest('.el-form-item')?.parentElement)
    expect(wrapper.find('[data-testid="link-laser-advanced"] [data-testid="laser-modulation"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="laser-wavelength"]').text()).toContain('440')
    expect(wrapper.find('[data-testid="link-modulation"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="link-tx-polarization"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="link-rx-polarization"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="link-noise-figure"]').exists()).toBe(false)

    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    const emitted = wrapper.emitted('apply')![0]![0] as Link
    expect(emitted).not.toHaveProperty('laser')
    expect(emitted).toMatchObject({ type: 'LASER', frequency: 681_300_000, bandwidth: 1_000, txPower: 0.1, dataRate: 2_500, eirpDbw: 20, gtDbk: 15, noiseFigureDb: 5 })
    expect(emitted.antennaGain).toEqual({ tx: 45, rx: 45 })
    wrapper.unmount()

    // 旧激光链路缺少新光学字段时保持空白，不能在重开时静默补一个口径或 OOK 值。
    const legacy = mountEditor(link('LASER'))
    expect(numberInput(legacy, 'laser-tx-aperture').props('modelValue')).toBeUndefined()
    expect(numberInput(legacy, 'laser-rx-aperture').props('modelValue')).toBeUndefined()
    expect(numberInput(legacy, 'laser-pulse-width').props('modelValue')).toBeUndefined()
    expect(select(legacy, 'laser-modulation').props('modelValue')).toBeUndefined()
    legacy.unmount()
  })

  it('质量参数常驻显示激光调制方式的校验错误', async () => {
    const wrapper = mountEditor(link('LASER'))
    await wrapper.setProps({ validate: () => [{
      severity: 'ERROR', code: 'LASER_MODULATION_INVALID', fieldPath: 'laser.modulation', message: '激光调制方式有误。',
    }] })
    const quality = wrapper.get('section[data-testid="link-quality-advanced"]')
    expect(quality.get('[data-testid="laser-modulation"]').element.closest('details')).toBeNull()
    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    const field = wrapper.findAllComponents({ name: 'ElFormItem' }).find(item => item.props('label') === '调制方式')
    expect(field?.props('error')).toBe('激光调制方式有误。')
    wrapper.unmount()
  })

  it('将 ns 脉宽转换为 s，提交完整 OOK 光学参数并通过写入校验', async () => {
    const wrapper = mountEditor(link())
    await switchToLaser(wrapper)
    numberInput(wrapper, 'laser-tx-aperture').vm.$emit('update:modelValue', 0.1)
    numberInput(wrapper, 'laser-tx-aperture').vm.$emit('update:modelValue', undefined)
    expect(numberInput(wrapper, 'laser-tx-aperture').props('modelValue')).toBeUndefined()
    fillLaser(wrapper)
    await flushPromises()
    const modulation = select(wrapper, 'laser-modulation')
    await modulation.trigger('mouseenter')
    await modulation.get('.el-select__clear').trigger('click')
    expect(modulation.props('modelValue')).toBeUndefined()
    modulation.vm.$emit('update:modelValue', 'OOK')
    expect(wrapper.get('[data-testid="laser-wavelength"]').text()).toContain('1549.31')

    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    const emitted = wrapper.emitted('apply')![0]![0] as Link
    expect(emitted).toMatchObject({
      type: 'LASER', frequency: 193_500_000, bandwidth: 1_000, txPower: 20, dataRate: 100,
      laser: { txApertureDiameterM: 0.1, rxApertureDiameterM: 0.1, pulseWidthS: 1e-8, modulation: 'OOK' },
    })
    const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
    Object.assign(config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
    config.links[0] = emitted
    expect(inspectScenarioConfig(config, 'write').result.valid).toBe(true)
    wrapper.unmount()
  })

  it('取消不改写原链路；重开完整激光参数后切回射频会清除 laser 并套用射频默认值', async () => {
    const original: Link = {
      ...link('LASER'), frequency: 193_500_000, bandwidth: 1_000, txPower: 20, dataRate: 100, rxFrequency: 194_000_000, rxBandwidth: 2_000,
      laser: { txApertureDiameterM: 0.1, rxApertureDiameterM: 0.1, pulseWidthS: 1e-8, modulation: 'OOK' },
    }
    const before = structuredClone(original)
    const wrapper = mountEditor(original)
    expect(numberInput(wrapper, 'laser-pulse-width').props('modelValue')).toBe(10)
    expect(numberInput(wrapper, 'link-rx-frequency').props('modelValue')).toBe(194_000_000)
    expect(numberInput(wrapper, 'link-rx-bandwidth').props('modelValue')).toBe(2_000)
    numberInput(wrapper, 'link-rx-frequency').vm.$emit('update:modelValue', 194_500_000)
    numberInput(wrapper, 'link-rx-frequency').vm.$emit('update:modelValue', undefined)
    numberInput(wrapper, 'link-rx-bandwidth').vm.$emit('update:modelValue', undefined)
    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    const clearedCarrier = wrapper.emitted('apply')![0]![0] as Link
    expect(clearedCarrier).not.toHaveProperty('rxFrequency')
    expect(clearedCarrier).not.toHaveProperty('rxBandwidth')
    numberInput(wrapper, 'laser-pulse-width').vm.$emit('update:modelValue', 20)
    await wrapper.get('[data-testid="cancel-link"]').trigger('click')
    expect(original).toEqual(before)

    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true })
    expect(numberInput(wrapper, 'laser-pulse-width').props('modelValue')).toBe(10)
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

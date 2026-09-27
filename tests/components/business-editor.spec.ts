import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it } from 'vitest'
import BusinessEditorDialog from '../../src/components/scenarios/BusinessEditorDialog.vue'
import type { InformationDemand, ScenarioConfig } from '../../src/contracts/domain-models'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import { BUSINESS_DEFAULTS } from '../../src/features/scenarios/business-defaults'

enableAutoUnmount(afterEach)
afterEach(() => { document.body.innerHTML = '' })

describe('业务编辑弹框', () => {
  it('50 KB 初始化和切换方向保留 KB 展示，确认后再打开仍为 50 KB', async () => {
    const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
    const demand: InformationDemand = { ...config.informationDemand[0]!, direction: 'FORWARD', volumeMb: 0.05 }
    const wrapper: VueWrapper = mount(BusinessEditorDialog, { props: { modelValue: true, editing: false, demand, platforms: config.platforms, disabled: false, error: '' },
      global: { plugins: [ElementPlus], stubs: { ElDialog: { props: ['modelValue'], template: '<section v-if="modelValue"><slot /><slot name="footer" /></section>' } } } })
    const component = (name: string, id: string) => wrapper.findAllComponents({ name }).find(item => item.attributes('data-testid') === id)!
    expect(component('ElSelect', 'demand-volume-unit').props('modelValue')).toBe('KB')
    expect(component('ElInputNumber', 'demand-volume').props('modelValue')).toBe(50)
    component('ElSelect', 'demand-direction').vm.$emit('change', 'REVERSE')
    await wrapper.get('[data-testid="apply-business"]').trigger('click')
    const saved = wrapper.emitted('apply')![0]![0] as InformationDemand
    expect(saved.volumeMb).toBe(0.05)
    expect(component('ElSelect', 'demand-volume-unit').props('modelValue')).toBe('KB')
    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true, editing: true, demand: saved })
    expect(component('ElSelect', 'demand-volume-unit').props('modelValue')).toBe('KB')
    expect(component('ElInputNumber', 'demand-volume').props('modelValue')).toBe(50)
  })

  it('统一新增入口在弹框切换方向，应用对应默认值且保留手动修改', async () => {
    const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
    const demand: InformationDemand = { ...config.informationDemand[0]!, direction: 'FORWARD', ...BUSINESS_DEFAULTS.FORWARD }
    const wrapper = mount(BusinessEditorDialog, { props: { modelValue: true, editing: false, demand, platforms: config.platforms, disabled: false, error: '' },
      global: { plugins: [ElementPlus], stubs: { ElDialog: { props: ['modelValue'], template: '<section v-if="modelValue"><slot /><slot name="footer" /></section>' } } } })
    await flushPromises()
    const component = (name: string, id: string) => wrapper.findAllComponents({ name }).find(item => item.attributes('data-testid') === id)!
    const direction = component('ElSelect', 'demand-direction')
    direction.vm.$emit('change', 'REVERSE')
    await wrapper.get('[data-testid="apply-business"]').trigger('click')
    expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ direction: 'REVERSE', ...BUSINESS_DEFAULTS.REVERSE })
    direction.vm.$emit('change', 'FORWARD')
    await wrapper.get('[data-testid="apply-business"]').trigger('click')
    expect(wrapper.emitted('apply')![1]![0]).toMatchObject({ direction: 'FORWARD', ...BUSINESS_DEFAULTS.FORWARD })
    component('ElInputNumber', 'demand-frequency').vm.$emit('update:modelValue', 8)
    direction.vm.$emit('change', 'REVERSE')
    await wrapper.get('[data-testid="apply-business"]').trigger('click')
    expect(wrapper.emitted('apply')![2]![0]).toMatchObject({ direction: 'REVERSE', volumeMb: 2, frequencyHz: 8, minDataRateMbps: 2 })
    expect(demand.direction).toBe('FORWARD')
  })
  it('复用旧业务、换算字节和 MB、取消不落盘且禁用阻止确认', async () => {
    const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
    const demand: InformationDemand = { ...config.informationDemand[0]!, volumeMb: 0.000256, informationType: '历史类型' as never, enabled: false }
    const original = structuredClone(demand)
    const wrapper: VueWrapper = mount(BusinessEditorDialog, { props: { modelValue: true, editing: true, demand, platforms: config.platforms, disabled: false, error: '' },
      global: { plugins: [ElementPlus], stubs: { ElDialog: { props: ['modelValue'], template: '<section v-if="modelValue"><slot /><slot name="footer" /></section>' } } } })
    await flushPromises()
    const component = (name: string, id: string) => wrapper.findAllComponents({ name }).find(item => item.attributes('data-testid') === id)!
    expect(component('ElInputNumber', 'demand-volume').props('modelValue')).toBe(256)
    expect(component('ElSelect', 'demand-type').props('modelValue')).toBe('历史类型')
    expect(wrapper.find('[data-testid="demand-id"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="demand-enabled"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="demand-priority"]').exists()).toBe(false)
    component('ElInputNumber', 'demand-volume').vm.$emit('update:modelValue', 512)
    component('ElSelect', 'demand-volume-unit').vm.$emit('update:modelValue', 'MB')
    await wrapper.vm.$nextTick()
    expect(component('ElInputNumber', 'demand-volume').props('modelValue')).toBe(0.000512)
    await wrapper.findAllComponents({ name: 'ElButton' }).find(button => button.text() === '取消')!.trigger('click')
    expect(demand).toEqual(original)
    expect(wrapper.emitted('apply')).toBeUndefined()
    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true })
    component('ElSelect', 'demand-direction').vm.$emit('change', 'REVERSE')
    component('ElSelect', 'demand-type').vm.$emit('update:modelValue', '侦察信息')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('传输频次（次/秒）')
    await wrapper.get('[data-testid="apply-business"]').trigger('click')
    expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ id: original.id, priority: original.priority, volumeMb: 0.000256, direction: 'REVERSE', informationType: '侦察信息', enabled: false })
    expect(demand).toEqual(original)
    await wrapper.setProps({ disabled: true })
    await wrapper.get('[data-testid="apply-business"]').trigger('click')
    expect(wrapper.emitted('apply')).toHaveLength(1)
  })
})

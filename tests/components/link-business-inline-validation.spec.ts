import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'
import BusinessEditorDialog from '../../src/components/scenarios/BusinessEditorDialog.vue'
import LinkEditorDialog from '../../src/components/scenarios/LinkEditorDialog.vue'
import type { InformationDemand, Link, Platform, ScenarioConfig, ValidationIssue } from '../../src/contracts/domain-models'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'

const dialogStub = { props: ['modelValue'], template: '<section v-if="modelValue"><slot /><slot name="footer" /></section>' }
const linkTypeOptions = [
  { value: 'SAT', label: '卫星' }, { value: 'MICROWAVE', label: '微波' },
  { value: 'DATALINK', label: '数传' }, { value: 'LASER', label: '激光' }, { value: 'FIBER', label: '光纤' },
] as const

function scenario(): ScenarioConfig {
  return structuredClone(fixtureSource.scenario) as ScenarioConfig
}

function inputNumber(wrapper: VueWrapper, testId: string) {
  const input = wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === testId)
  expect(input, `未找到 ${testId}`).toBeDefined()
  return input!
}

/** Element Plus 对表单错误状态做 100 ms 去抖，等待其把 error prop 渲染为字段下方文字。 */
async function waitForFormError(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 120))
}

describe('链路与业务编辑器的即时字段校验', () => {
  it('链路真实 DOM 输入 0 后即时显示字段错误，不修改原链路', async () => {
    const config = scenario()
    const link = structuredClone(config.links[0]!) as Link
    const originalFrequency = link.frequency
    const rawFrequencyInvalid = ref(false)
    const wrapper = mount(defineComponent({
      setup: () => () => h(LinkEditorDialog, {
        modelValue: true, link, editing: true, error: '', pending: false, locked: false,
        platforms: config.platforms as Platform[], linkTypeOptions,
        linkDirectionLabels: { FORWARD: '前向', REVERSE: '返向' }, minimumStep: 0.001,
        validate: (): ValidationIssue[] => rawFrequencyInvalid.value
          ? [{ severity: 'ERROR', code: 'FREQUENCY', message: '频率必须大于 0 MHz', fieldPath: 'frequency' }]
          : [],
        onFrequencyInput: (value: number | undefined) => { rawFrequencyInvalid.value = typeof value === 'number' && value <= 0 },
      }),
    }), {
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })

    await wrapper.get('[data-testid="link-frequency"] input').setValue('0')
    await flushPromises()
    await waitForFormError()
    expect(wrapper.text()).toContain('频率必须大于 0 MHz')
    expect(link.frequency).toBe(originalFrequency)

    await wrapper.get('[data-testid="link-frequency"] input').setValue('3000')
    await flushPromises()
    await waitForFormError()
    expect(wrapper.text()).not.toContain('频率必须大于 0 MHz')
    wrapper.unmount()
  })

  it('嵌入业务将 business. 字段路径映射为对应输入框的警告', async () => {
    const config = scenario()
    const wrapper = mount(LinkEditorDialog, {
      props: {
        modelValue: true, link: structuredClone(config.links[0]!) as Link, demand: structuredClone(config.informationDemand[0]!) as InformationDemand,
        editing: true, error: '', pending: false, locked: false, platforms: config.platforms as Platform[], linkTypeOptions,
        linkDirectionLabels: { FORWARD: '前向', REVERSE: '返向' }, minimumStep: 0.001,
        validate: () => [{ severity: 'WARNING', code: 'BUSINESS_RATE', message: '业务速率接近链路上限', fieldPath: 'business.minDataRateMbps' }],
      },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })

    await flushPromises()
    await waitForFormError()
    expect(wrapper.text()).toContain('警告：业务速率接近链路上限')
    wrapper.unmount()
  })

  it('独立业务编辑器按临时副本即时更新字段错误', async () => {
    const config = scenario()
    const demand = structuredClone(config.informationDemand[0]!) as InformationDemand
    const wrapper = mount(BusinessEditorDialog, {
      props: {
        modelValue: true, demand, editing: true, error: '', disabled: false, platforms: config.platforms as Platform[],
        validate: (candidate: InformationDemand) => candidate.frequencyHz < 2
          ? [{ severity: 'ERROR', code: 'FREQUENCY', message: '传输频次至少为 2', fieldPath: 'frequencyHz' }]
          : [],
      },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })

    inputNumber(wrapper, 'demand-frequency').vm.$emit('update:modelValue', 1)
    await flushPromises()
    await waitForFormError()
    expect(wrapper.text()).toContain('传输频次至少为 2')

    inputNumber(wrapper, 'demand-frequency').vm.$emit('update:modelValue', 2)
    await flushPromises()
    await waitForFormError()
    expect(wrapper.text()).not.toContain('传输频次至少为 2')
    expect(demand.frequencyHz).not.toBe(2)
    wrapper.unmount()
  })
})

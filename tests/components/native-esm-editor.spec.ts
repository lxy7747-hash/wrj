import { enableAutoUnmount, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElInputNumber, ElSwitch } from 'element-plus'
import { afterEach, describe, expect, it } from 'vitest'
import NativeEsmEditor from '../../src/components/scenarios/NativeEsmEditor.vue'
import { inspectScenarioUiExtensions } from '../../src/features/scenarios/scenario-validation'
import type { NativeEsmSettings } from '../../src/contracts/domain-models'

enableAutoUnmount(afterEach)
const NATIVE_ESM_PROBE_DEFAULTS: NativeEsmSettings = { sensitivityDbw: -200, detectionThresholdDb: 0, dwellTimeS: 1, revisitTimeS: 1 }

function editor(modelValue?: NativeEsmSettings, disabled = false): VueWrapper {
  return mount(NativeEsmEditor, { props: { sensorId: 'ESM-01', modelValue, disabled }, global: { plugins: [ElementPlus] } })
}

function input(wrapper: ReturnType<typeof editor>, testId: string) {
  return wrapper.findAllComponents(ElInputNumber).find(component => component.attributes('data-testid') === testId)!
}

describe('NativeEsmEditor', () => {
  it('启用时写入经过本机探针验证的默认值，并可编辑四个原生参数', async () => {
    const wrapper = editor()
    const toggle = wrapper.findComponent(ElSwitch)
    toggle.vm.$emit('update:modelValue', true)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([{ ...NATIVE_ESM_PROBE_DEFAULTS }])

    await wrapper.setProps({ modelValue: { ...NATIVE_ESM_PROBE_DEFAULTS } })
    const changes: Array<[keyof NativeEsmSettings, number]> = [
      ['sensitivityDbw', -180], ['detectionThresholdDb', 3], ['dwellTimeS', 2], ['revisitTimeS', 4],
    ]
    for (const [field, value] of changes) input(wrapper, `native-esm-${field === 'sensitivityDbw' ? 'sensitivity' : field === 'detectionThresholdDb' ? 'threshold' : field === 'dwellTimeS' ? 'dwell' : 'revisit'}-ESM-01`).vm.$emit('update:modelValue', value)
    expect(wrapper.emitted('update:modelValue')?.slice(-4).map(([value]) => value)).toEqual([
      { ...NATIVE_ESM_PROBE_DEFAULTS, sensitivityDbw: -180 },
      { ...NATIVE_ESM_PROBE_DEFAULTS, detectionThresholdDb: 3 },
      { ...NATIVE_ESM_PROBE_DEFAULTS, dwellTimeS: 2 },
      { ...NATIVE_ESM_PROBE_DEFAULTS, revisitTimeS: 4 },
    ])
  })

  it('清空数值保留非法值供字段校验，而关闭原生模式明确发出 undefined', async () => {
    const wrapper = editor({ ...NATIVE_ESM_PROBE_DEFAULTS })
    input(wrapper, 'native-esm-dwell-ESM-01').vm.$emit('update:modelValue', undefined)
    const invalid = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as NativeEsmSettings
    expect(Number.isNaN(invalid.dwellTimeS)).toBe(true)
    const result = inspectScenarioUiExtensions({ jammers: [], sensors: [{ sensorId: 'ESM-01', type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true, esm: invalid }] }, [], ['ESM-01']).result
    expect(result.errors).toContainEqual(expect.objectContaining({ fieldPath: 'uiExtensions.sensors[0].esm.dwellTimeS' }))

    wrapper.findComponent(ElSwitch).vm.$emit('update:modelValue', false)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([undefined])
  })

  it('禁用时不提供可编辑的切换或参数控件', () => {
    const wrapper = editor({ ...NATIVE_ESM_PROBE_DEFAULTS }, true)
    expect(wrapper.findComponent(ElSwitch).props('disabled')).toBe(true)
    expect(wrapper.findAllComponents(ElInputNumber)).toHaveLength(4)
    for (const field of wrapper.findAllComponents(ElInputNumber)) expect(field.props('disabled')).toBe(true)
  })
})

import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import type { Jammer, JammerUiExtension, Platform, ScenarioConfig, ScenarioDraft } from '../../src/contracts/domain-models'
import JammerEditorDialog from '../../src/components/scenarios/JammerEditorDialog.vue'
import ScenariosPage from '../../src/pages/scenarios/scenarios.vue'
import { useScenarioStore } from '../../src/stores/scenario'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'

function draft(): ScenarioDraft {
  const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
  return {
    config, revision: 4, locked: false, officialLibraryChanged: false,
    uiExtensions: { jammers: config.jammers.map(jammer => ({ jammerId: jammer.id, direction: 0, enabled: true })), sensors: [] },
  }
}

describe('新模板场景字段', () => {
  it('运行模式缺省显示实时；选非实时写 realtime=false，切回实时删除字段', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: draft(), panelState: 'SUCCESS' })
    const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    const radio = wrapper.findAllComponents({ name: 'ElRadioGroup' }).find(item => item.attributes('data-testid') === 'scenario-realtime')!
    expect(radio.props('modelValue')).toBe(true)
    expect(scenario.draft!.config.scenario).not.toHaveProperty('realtime')
    radio.vm.$emit('update:modelValue', false)
    await flushPromises()
    expect(scenario.draft!.config.scenario.realtime).toBe(false)
    expect(scenario.dirty).toBe(true)
    radio.vm.$emit('update:modelValue', true)
    await flushPromises()
    expect(scenario.draft!.config.scenario).not.toHaveProperty('realtime')
    wrapper.unmount()
  })

  it('侦测最小距离按 km 输入、以 m 写入；旧记录缺省展示模板默认 1 km 且未编辑不写字段', async () => {
    const config = draft().config
    const jammer = structuredClone(config.jammers[0]!) as Jammer
    const uiExtension: JammerUiExtension = { jammerId: jammer.id, direction: 0, enabled: true }
    const wrapper = mount(JammerEditorDialog, {
      props: { modelValue: true, jammer, uiExtension, editing: true, error: '', pending: false, locked: false,
        platforms: config.platforms as Platform[], links: config.links, jammerTypeOptions: [{ value: 'BARRAGE', label: '宽带阻塞' }], minimumStep: 0.001 },
      global: { plugins: [ElementPlus], stubs: { ElDialog: { template: '<section><slot /><slot name="footer" /></section>' } } },
    })
    await flushPromises()
    const input = wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'jammer-detection-minimum-range')!
    expect(input.props('modelValue')).toBe(1)
    expect(wrapper.text()).toContain('0 表示不触发')
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')![0]![0]).not.toHaveProperty('detectionMinimumRange')
    input.vm.$emit('update:modelValue', 2.5)
    await flushPromises()
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ detectionMinimumRange: 2500 })
    wrapper.unmount()
  })
})

import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
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

/** 挂载场景配置页，返回场景 Store 与页面包装器。 */
function mountPage(draftOverride: ScenarioDraft = draft()) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const scenario = useScenarioStore(pinia)
  scenario.$patch({ draft: draftOverride, panelState: 'SUCCESS' })
  const wrapper = mount(ScenariosPage, { global: { plugins: [pinia, ElementPlus] } })
  return { scenario, wrapper }
}

type PageWrapper = ReturnType<typeof mountPage>['wrapper']

/** 按 data-testid 定位仿真倍速下拉，不依赖页面其他下拉的排列顺序。 */
function simSpeedOf(wrapper: PageWrapper) {
  return wrapper.findAllComponents({ name: 'ElSelect' })
    .find((item: { attributes: (name: string) => string | undefined }) => item.attributes('data-testid') === 'scenario-sim-speed')!
}

describe('新模板场景字段', () => {
  it('仿真倍速缺省回显 x2 且不写 simClockSpeed；七个标准档位按 realtime / clock_rate 映射', async () => {
    const { scenario, wrapper } = mountPage()
    await flushPromises()
    const simSpeed = simSpeedOf(wrapper)
    // 旧场景缺省倍速按文档默认值回显 x2；回显本身不写 simClockSpeed。
    expect(simSpeed.props('modelValue')).toBe('x2')
    expect(scenario.draft!.config.scenario.environment).not.toHaveProperty('simClockSpeed')
    expect(scenario.draft!.config.scenario).not.toHaveProperty('realtime')
    expect(simSpeed.findAllComponents({ name: 'ElOption' }).map(option => option.props('value')))
      .toEqual(['full', 'x1', 'x2', 'x4', 'x8', 'x16', 'x32'])

    const cases = [
      { value: 'full', realtime: false as boolean | undefined, clock: 32 },
      { value: 'x1', realtime: undefined, clock: 1 },
      { value: 'x2', realtime: undefined, clock: 2 },
      { value: 'x4', realtime: undefined, clock: 4 },
      { value: 'x8', realtime: undefined, clock: 8 },
      { value: 'x16', realtime: undefined, clock: 16 },
      { value: 'x32', realtime: undefined, clock: 32 },
    ]
    for (const item of cases) {
      simSpeed.vm.$emit('update:modelValue', item.value)
      await nextTick()
      if (item.realtime === undefined) expect(scenario.draft!.config.scenario).not.toHaveProperty('realtime')
      else expect(scenario.draft!.config.scenario.realtime).toBe(item.realtime)
      expect(scenario.draft!.config.scenario.environment.simClockSpeed).toBe(item.clock)
      // 重新读取时同一组合回显为同一档位（x32 与全速靠 realtime 区分）。
      expect(simSpeed.props('modelValue')).toBe(item.value)
    }
    expect(scenario.dirty).toBe(true)

    scenario.draft!.locked = true
    await nextTick()
    expect(simSpeed.props('disabled')).toBe(true)
    wrapper.unmount()
  })

  it('旧场景非实时配非 32 倍速回显 legacy 且挂载不改写；改选标准档位后归一化', async () => {
    const legacyDraft = draft()
    legacyDraft.config.scenario.realtime = false
    legacyDraft.config.scenario.environment.simClockSpeed = 2
    const { scenario, wrapper } = mountPage(legacyDraft)
    await flushPromises()
    const simSpeed = simSpeedOf(wrapper)
    expect(simSpeed.props('modelValue')).toBe('legacy')
    const legacyOption = simSpeed.findAllComponents({ name: 'ElOption' }).find(option => option.props('value') === 'legacy')!
    expect(legacyOption.props()).toMatchObject({ label: '当前：非实时 / 2×（旧场景）', disabled: true })
    // 旧值作为当前值显示在下拉里，供用户识别并主动改选标准档位。
    expect(simSpeed.text()).toContain('当前：非实时 / 2×（旧场景）')
    // 打开旧场景只回显，不静默改写 realtime / simClockSpeed。
    expect(scenario.draft!.config.scenario.realtime).toBe(false)
    expect(scenario.draft!.config.scenario.environment.simClockSpeed).toBe(2)
    expect(scenario.dirty).toBe(false)

    simSpeed.vm.$emit('update:modelValue', 'x4')
    await nextTick()
    expect(scenario.draft!.config.scenario).not.toHaveProperty('realtime')
    expect(scenario.draft!.config.scenario.environment.simClockSpeed).toBe(4)
    wrapper.unmount()
  })

  it('实时配非标准倍速同样回显 legacy，且不静默改写', async () => {
    const oldDraft = draft()
    oldDraft.config.scenario.environment.simClockSpeed = 3
    const { scenario, wrapper } = mountPage(oldDraft)
    await flushPromises()
    const simSpeed = simSpeedOf(wrapper)
    expect(simSpeed.props('modelValue')).toBe('legacy')
    expect(simSpeed.findAllComponents({ name: 'ElOption' }).find(option => option.props('value') === 'legacy')!.props('label'))
      .toBe('当前：3×（旧场景）')
    expect(scenario.draft!.config.scenario.environment.simClockSpeed).toBe(3)
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

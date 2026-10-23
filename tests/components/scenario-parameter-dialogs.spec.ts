import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'
import type { Jammer, JammerUiExtension, Link, ScenarioConfig, ScenarioLinkSettings, ScriptContract, ValidationResult } from '../../src/contracts/domain-models'
import JammerEditorDialog from '../../src/components/scenarios/JammerEditorDialog.vue'
import LinkEditorDialog from '../../src/components/scenarios/LinkEditorDialog.vue'
import LinkSettingsPanel from '../../src/components/scenarios/LinkSettingsPanel.vue'
import ScriptPreview from '../../src/components/scenarios/ScriptPreview.vue'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'

const dialogStub = { props: ['modelValue'], template: '<section v-if="modelValue"><slot /><slot name="footer" /></section>' }
const typeOptions = [
  { value: 'SAT', label: '卫星' }, { value: 'MICROWAVE', label: '微波' },
  { value: 'DATALINK', label: '数传' }, { value: 'LASER', label: '激光' }, { value: 'FIBER', label: '光纤' },
] as const
const emptyValidation: ValidationResult = { valid: true, errors: [], warnings: [] }

function select(wrapper: VueWrapper, testId: string) {
  const component = wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === testId)
  expect(component, `未找到 ${testId}`).toBeDefined()
  return component!
}

function inputNumber(wrapper: VueWrapper, testId: string) {
  const component = wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === testId)
  expect(component, `未找到 ${testId}`).toBeDefined()
  return component!
}

function scenario(): ScenarioConfig {
  return structuredClone(fixtureSource.scenario) as ScenarioConfig
}

describe('场景参数弹框的真实编辑路径', () => {
  it('链路全局计算参数与热链可编辑、发现断链并可恢复自动生成', async () => {
    const config = scenario()
    const [source, relay, target] = config.platforms
    const seed = structuredClone(config.links[0]) as Link
    const links: Link[] = [
      { ...seed, id: 'L-F-1', type: 'DATALINK', sourcePlatformId: source!.id, targetPlatformId: relay!.id, direction: 'FORWARD', enabled: true },
      { ...seed, id: 'L-F-2', type: 'MICROWAVE', sourcePlatformId: relay!.id, targetPlatformId: target!.id, direction: 'FORWARD', enabled: true },
      { ...seed, id: 'L-R-1', type: 'SAT', sourcePlatformId: target!.id, targetPlatformId: source!.id, direction: 'REVERSE', enabled: true },
    ]
    const wrapper = mount(LinkSettingsPanel, {
      props: { modelValue: readLinkSettings(config), dialogVisible: true, platforms: config.platforms, links, jammers: config.jammers, disabled: false, typeOptions },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    const typed = wrapper as unknown as VueWrapper<{ $props: { modelValue?: ScenarioLinkSettings; disabled: boolean } }>
    const latest = () => wrapper.emitted('update:modelValue')!.at(-1)![0] as ScenarioLinkSettings

    expect(wrapper.get('[data-testid="hot-link-state"]').text()).toBe('自动生成')
    select(wrapper, 'link-calc-channelEncodingScheme').vm.$emit('update:modelValue', 6.5)
    expect(latest().linkCalc).toMatchObject({ channelEncodingScheme: 6.5, jammingRangeKm: 30 })
    await typed.setProps({ modelValue: latest() })

    // ElInput 的 setValue 会模拟用户输入并依次派发 input/change；每次发射后立即回写父级值。
    const threshold = wrapper.get('[data-testid="link-calc-warningThreshold"]')
    await threshold.setValue('1e-4')
    expect(latest().linkCalc!.warningThreshold).toBe(1e-4)
    await typed.setProps({ modelValue: latest() })
    await threshold.setValue('')
    expect(latest().linkCalc!.warningThreshold).toBeNaN()
    await typed.setProps({ modelValue: latest() })
    inputNumber(wrapper, 'link-calc-jammingRangeKm').vm.$emit('update:modelValue', null)
    expect(latest().linkCalc!.jammingRangeKm).toBeNaN()

    await typed.setProps({ modelValue: readLinkSettings(config) })
    select(wrapper, 'hot-link-end-type').vm.$emit('update:modelValue', 'AIRBORNE_MISSION_CLUSTER')
    expect(latest().hotLinks).toMatchObject({ endPlatformType: 'AIRBORNE_MISSION_CLUSTER', forward: [['L-F-1', 'L-F-2']] })
    await typed.setProps({ modelValue: latest() })
    select(wrapper, 'hot-link-forward-0').vm.$emit('update:modelValue', ['L-F-2', 'L-F-1'])
    expect(latest().hotLinks!.forward).toEqual([['L-F-2', 'L-F-1']])
    await typed.setProps({ modelValue: latest() })
    expect(wrapper.text()).toContain('源平台与上一跳的目标平台不相接')
    await wrapper.get('[data-testid="hot-link-forward-add"]').trigger('click')
    expect(latest().hotLinks!.forward).toEqual([['L-F-2', 'L-F-1'], []])
    await typed.setProps({ modelValue: latest() })
    await wrapper.get('[data-testid="hot-link-forward-1-remove"]').trigger('click')
    expect(latest().hotLinks!.forward).toEqual([['L-F-2', 'L-F-1']])
    await typed.setProps({ modelValue: latest() })
    await wrapper.get('[data-testid="hot-link-reset"]').trigger('click')
    expect(latest()).not.toHaveProperty('hotLinks')

    const writes = wrapper.emitted('update:modelValue')!.length
    await typed.setProps({ disabled: true })
    select(wrapper, 'link-calc-channelEncodingScheme').vm.$emit('update:modelValue', -1)
    await threshold.setValue('1e-3')
    await wrapper.get('[data-testid="hot-link-forward-add"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toHaveLength(writes)
    wrapper.unmount()
  })

  it('链路编辑按类型、波段、方向重置端口参数，并保留接收侧和编码输入', async () => {
    const config = scenario()
    const link = structuredClone(config.links.find(item => item.type === 'SAT')) as Link
    delete link.rxFrequency
    delete link.rxBandwidth
    delete link.txPolarization
    delete link.rxPolarization
    const wrapper = mount(LinkEditorDialog, {
      props: { modelValue: true, link, editing: false, showIds: true, error: '', pending: false, locked: false,
        platforms: config.platforms, linkTypeOptions: typeOptions, linkDirectionLabels: { FORWARD: '前向', REVERSE: '返向' }, minimumStep: 0.001 },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    expect(wrapper.get('[data-testid="link-id"]').attributes('disabled')).toBeUndefined()
    expect(inputNumber(wrapper, 'link-rx-frequency').props('modelValue')).toBe(link.frequency)
    expect(inputNumber(wrapper, 'link-rx-bandwidth').props('modelValue')).toBe(link.bandwidth)
    expect(select(wrapper, 'link-tx-polarization').props('modelValue')).toBe('vertical')

    select(wrapper, 'link-type').vm.$emit('update:modelValue', 'DATALINK')
    select(wrapper, 'link-type').vm.$emit('change', 'DATALINK')
    await flushPromises()
    expect(select(wrapper, 'link-band').props('modelValue')).toBe('C')
    expect(inputNumber(wrapper, 'link-frequency').props('modelValue')).toBe(4500)
    select(wrapper, 'link-band').vm.$emit('update:modelValue', 'L')
    select(wrapper, 'link-band').vm.$emit('change', 'L')
    select(wrapper, 'link-direction').vm.$emit('update:modelValue', 'REVERSE')
    select(wrapper, 'link-direction').vm.$emit('change', 'REVERSE')
    await flushPromises()
    expect(inputNumber(wrapper, 'link-frequency').props('modelValue')).toBe(1300)
    expect(inputNumber(wrapper, 'link-rx-bandwidth').props('modelValue')).toBe(10)
    expect(select(wrapper, 'link-data-rate').props('modelValue')).toBe(0.0128)
    select(wrapper, 'link-rx-polarization').vm.$emit('update:modelValue', 'horizontal')
    inputNumber(wrapper, 'link-noise-figure').vm.$emit('update:modelValue', 7)
    select(wrapper, 'link-coding').vm.$emit('update:modelValue', '  LDPC  ')
    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ type: 'DATALINK', band: 'L', direction: 'REVERSE', frequency: 1300,
      rxFrequency: 1300, rxBandwidth: 10, dataRate: 0.0128, rxPolarization: 'horizontal', noiseFigureDb: 7, coding: 'LDPC' })
    expect(link.type).toBe('SAT')

    select(wrapper, 'link-type').vm.$emit('update:modelValue', 'MICROWAVE')
    select(wrapper, 'link-type').vm.$emit('change', 'MICROWAVE')
    await flushPromises()
    expect(wrapper.get('[data-testid="link-data-rate"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('按对接文档固定，不可修改')
    expect(select(wrapper, 'link-tx-polarization').props('modelValue')).toBe('horizontal')
    select(wrapper, 'link-type').vm.$emit('update:modelValue', 'FIBER')
    select(wrapper, 'link-type').vm.$emit('change', 'FIBER')
    await flushPromises()
    expect(wrapper.text()).toContain('10～1000 Mbps')
    expect(wrapper.find('[data-testid="link-bandwidth"]').exists()).toBe(false)
    expect(inputNumber(wrapper, 'link-data-rate').props('min')).toBe(10)
    expect(inputNumber(wrapper, 'link-data-rate').props('max')).toBe(1000)
    wrapper.unmount()
  })

  it('链路取消、锁定和处理中不提交临时改动', async () => {
    const config = scenario()
    const link = structuredClone(config.links[0]) as Link
    const wrapper = mount(LinkEditorDialog, {
      props: { modelValue: true, link, editing: true, error: '服务端拒绝保存', pending: false, locked: true,
        platforms: config.platforms, linkTypeOptions: typeOptions, linkDirectionLabels: { FORWARD: '前向', REVERSE: '返向' }, minimumStep: 0.001 },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    expect(wrapper.text()).toContain('服务端拒绝保存')
    inputNumber(wrapper, 'link-noise-figure').vm.$emit('update:modelValue', null)
    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(link).not.toHaveProperty('noiseFigureDb')
    const typed = wrapper as unknown as VueWrapper<{ $props: { locked: boolean; pending: boolean } }>
    await typed.setProps({ locked: false, pending: true })
    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    await wrapper.get('[data-testid="cancel-link"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    wrapper.unmount()
  })

  it('干扰设备按公里编辑范围、释放距离，清空数值后只在确认副本中保留非法输入', async () => {
    const config = scenario()
    const jammer = structuredClone(config.jammers[0]) as Jammer
    delete jammer.releaseRange
    const uiExtension: JammerUiExtension = { jammerId: jammer.id, direction: 15, duration: 30, enabled: true }
    const wrapper = mount(JammerEditorDialog, {
      props: { modelValue: true, jammer, uiExtension, editing: true, showIds: true, error: '', pending: false, locked: false,
        platforms: config.platforms, jammerTypeOptions: [{ value: 'BARRAGE', label: '宽带压制' }, { value: 'SPOT', label: '瞄准式' }], minimumStep: 0.001 },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    expect(wrapper.get('[data-testid="jammer-id"]').attributes('disabled')).toBeDefined()
    expect(inputNumber(wrapper, 'jammer-release-range').props('modelValue')).toBeCloseTo((jammer.jammingRange + 9260) / 1000, 3)
    inputNumber(wrapper, 'jammer-range').vm.$emit('update:modelValue', 12.5)
    inputNumber(wrapper, 'jammer-jamming-range').vm.$emit('update:modelValue', 16)
    inputNumber(wrapper, 'jammer-release-range').vm.$emit('update:modelValue', 18)
    inputNumber(wrapper, 'jammer-direction').vm.$emit('update:modelValue', 270)
    inputNumber(wrapper, 'jammer-duration').vm.$emit('update:modelValue', 120)
    wrapper.findComponent({ name: 'ElSwitch' }).vm.$emit('update:modelValue', false)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ detectionRange: 12_500, jammingRange: 16_000, releaseRange: 18_000 })
    expect(wrapper.emitted('apply')!.at(-1)![1]).toMatchObject({ direction: 270, duration: 120, enabled: false })
    expect(jammer.releaseRange).toBeUndefined()

    inputNumber(wrapper, 'jammer-trigger-time').vm.$emit('update:modelValue', undefined)
    inputNumber(wrapper, 'jammer-jamming-range').vm.$emit('update:modelValue', undefined)
    inputNumber(wrapper, 'jammer-release-range').vm.$emit('update:modelValue', undefined)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    const emitted = wrapper.emitted('apply')!.at(-1)![0] as Jammer
    expect(emitted.triggerTimeS).toBeNaN()
    expect(emitted.jammingRange).toBeNaN()
    expect(emitted.releaseRange).toBeNaN()
    wrapper.unmount()
  })

  it('干扰设备取消及锁定不回写原对象', async () => {
    const config = scenario()
    const jammer = structuredClone(config.jammers[0]) as Jammer
    const uiExtension: JammerUiExtension = { jammerId: jammer.id, direction: 0, duration: 60, enabled: true }
    const wrapper = mount(JammerEditorDialog, {
      props: { modelValue: true, jammer, uiExtension, editing: false, error: '频率非法', pending: false, locked: true,
        platforms: config.platforms, jammerTypeOptions: [{ value: 'BARRAGE', label: '宽带压制' }], minimumStep: 0.001 },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    expect(wrapper.text()).toContain('频率非法')
    inputNumber(wrapper, 'jammer-range').vm.$emit('update:modelValue', 8)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(jammer.detectionRange).not.toBe(8_000)
    const typed = wrapper as unknown as VueWrapper<{ $props: { locked: boolean; pending: boolean } }>
    await typed.setProps({ locked: false, pending: true })
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    await wrapper.get('[data-testid="cancel-jammer"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    wrapper.unmount()
  })

  it('脚本预览按真实操作生成、预检并展示错误位置', async () => {
    const script: ScriptContract = {
      scriptId: 'SCRIPT-001', taskId: 'TASK-001', scenarioId: 'SCN-001', configVersion: 'SCN-001-v1', target: 'AFSIM 2.9.0',
      checksum: 'FNV1A-MOCK-TEST', preview: '# script', generatedTime: '2026-09-28T00:00:00Z',
    }
    const generate = mount(ScriptPreview, {
      props: { state: 'EMPTY', resultMessage: '', script: null, preflight: emptyValidation, locked: false, dirty: false, preflightPassed: false },
      global: { plugins: [ElementPlus] },
    })
    await generate.get('[data-testid="generate-script"]').trigger('click')
    expect(generate.emitted('generate')).toEqual([[]])
    expect(generate.get('[data-testid="preflight-script"]').attributes('disabled')).toBeDefined()
    generate.unmount()

    const wrapper = mount(ScriptPreview, {
      props: { state: 'ERROR', resultMessage: '预检失败', script,
        preflight: { valid: false, errors: [{ severity: 'ERROR', code: 'SCRIPT_INVALID', message: '第 3 行不可解析。', fieldPath: 'preview[3:12]' }], warnings: [] },
        locked: false, dirty: false, preflightPassed: false },
      global: { plugins: [ElementPlus] },
    })
    expect(wrapper.text()).toContain('下一步：点击“执行预检”')
    expect(wrapper.get('[data-testid="script-preview"]').text()).toBe('# script')
    await flushPromises()
    const issues = wrapper.findComponent({ name: 'ElTable' })
    expect(issues.props('data')).toEqual([expect.objectContaining({ fieldPath: 'preview[3:12]' })])
    await wrapper.get('[data-testid="preflight-script"]').trigger('click')
    expect(wrapper.emitted('preflight')).toEqual([[]])
    wrapper.unmount()

    const dirty = mount(ScriptPreview, {
      props: { state: 'LOADING', resultMessage: '', script: null, preflight: emptyValidation, locked: false, dirty: true, preflightPassed: false },
      global: { plugins: [ElementPlus] },
    })
    expect(dirty.text()).toContain('请先点击上方“保存”')
    expect(dirty.get('[data-testid="generate-script"]').attributes('disabled')).toBeDefined()
    dirty.unmount()
  })
})

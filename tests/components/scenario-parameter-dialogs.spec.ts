import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { toRaw } from 'vue'
import { describe, expect, it } from 'vitest'
import type { Jammer, JammerUiExtension, Link, ScenarioConfig, ScenarioLinkSettings, ScriptContract, ValidationResult } from '../../src/contracts/domain-models'
import JammerEditorDialog from '../../src/components/scenarios/JammerEditorDialog.vue'
import LinkEditorDialog from '../../src/components/scenarios/LinkEditorDialog.vue'
import LinkSettingsPanel from '../../src/components/scenarios/LinkSettingsPanel.vue'
import ScriptPreview from '../../src/components/scenarios/ScriptPreview.vue'
import { createScenarioSnapshot } from '../../src/features/scenarios/scenario-snapshot'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import { readJammerParameters } from '../../src/features/scenarios/jammer-settings'
import { createTemplateScenario } from '../fixtures/template-scenario'

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
    expect(wrapper.text()).toContain('按对接文档固定显示；脚本速率以“通信设备参数”为准')
    expect(wrapper.get('[data-testid="link-retained-hint"]').text()).toContain('此处参数暂保留，不写入脚本')
    expect(select(wrapper, 'link-tx-polarization').props('modelValue')).toBe('horizontal')
    select(wrapper, 'link-type').vm.$emit('update:modelValue', 'LASER')
    select(wrapper, 'link-type').vm.$emit('change', 'LASER')
    await flushPromises()
    expect(wrapper.find('[data-testid="link-retained-hint"]').exists()).toBe(false)
    select(wrapper, 'link-type').vm.$emit('update:modelValue', 'FIBER')
    select(wrapper, 'link-type').vm.$emit('change', 'FIBER')
    await flushPromises()
    expect(wrapper.find('[data-testid="link-retained-hint"]').exists()).toBe(true)
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
    expect(wrapper.get('[data-testid="cancel-link"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="cancel-link"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await wrapper.setProps({ pending: false } as never)
    await wrapper.get('[data-testid="cancel-link"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    wrapper.unmount()
  })

  it('干扰设备按公里编辑范围、释放距离，清空数值后只在确认副本中保留非法输入', async () => {
    const config = scenario()
    const jammer = structuredClone(config.jammers[0]) as Jammer
    delete jammer.releaseRange
    const uiExtension: JammerUiExtension = { jammerId: jammer.id, direction: 0, enabled: true }
    const wrapper = mount(JammerEditorDialog, {
      props: { modelValue: true, jammer, uiExtension, editing: true, showIds: true, error: '', pending: false, locked: false,
        platforms: config.platforms, links: config.links, jammerTypeOptions: [{ value: 'BARRAGE', label: '宽带压制' }, { value: 'SPOT', label: '瞄准式' }], minimumStep: 0.001 },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    expect(wrapper.get('[data-testid="jammer-id"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="jammer-trigger-time"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('新模板无对应参数，不写入脚本；干扰按干扰范围 / 释放范围启停。')
    expect(inputNumber(wrapper, 'jammer-release-range').props('modelValue')).toBeCloseTo((jammer.jammingRange + 9260) / 1000, 3)
    inputNumber(wrapper, 'jammer-range').vm.$emit('update:modelValue', 12.5)
    inputNumber(wrapper, 'jammer-jamming-range').vm.$emit('update:modelValue', 16)
    inputNumber(wrapper, 'jammer-release-range').vm.$emit('update:modelValue', 18)
    wrapper.findComponent({ name: 'ElSwitch' }).vm.$emit('update:modelValue', false)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ detectionRange: 12_500, jammingRange: 16_000, releaseRange: 18_000 })
    expect(wrapper.emitted('apply')!.at(-1)![1]).toMatchObject({ enabled: false })
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
    const uiExtension: JammerUiExtension = { jammerId: jammer.id, direction: 0, enabled: true }
    const wrapper = mount(JammerEditorDialog, {
      props: { modelValue: true, jammer, uiExtension, editing: false, error: '频率非法', pending: false, locked: true,
        platforms: config.platforms, links: config.links, jammerTypeOptions: [{ value: 'BARRAGE', label: '宽带压制' }], minimumStep: 0.001 },
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

  it('dBm 功率只接受 -10～30 的 5 dB 档位，旧瓦特值未编辑时原样保留', async () => {
    const config = scenario()
    const jammer = { ...(structuredClone(config.jammers[0]) as Jammer), defaultPower: 200 }
    const uiExtension: JammerUiExtension = { jammerId: jammer.id, direction: 0, enabled: true }
    const wrapper = mount(JammerEditorDialog, {
      props: { modelValue: true, jammer, uiExtension, editing: true, error: '', pending: false, locked: false,
        platforms: config.platforms, links: config.links, jammerTypeOptions: [{ value: 'BARRAGE', label: '宽带压制' }], minimumStep: 0.001, validate: () => [] },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    expect(wrapper.get('[data-testid="jammer-legacy-power"]').text()).toContain('200 W')
    inputNumber(wrapper, 'jammer-power').vm.$emit('update:modelValue', 35)
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(jammer.defaultPower).toBe(200)
    inputNumber(wrapper, 'jammer-power').vm.$emit('update:modelValue', undefined)
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    inputNumber(wrapper, 'jammer-power').vm.$emit('update:modelValue', 30)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect((wrapper.emitted('apply')!.at(-1)![0] as Jammer).defaultPower).toBeCloseTo(1)
    wrapper.unmount()
  })

  it('卫星方向速率接受范围内数值，清空后删除字段并回退历史速率', async () => {
    const config = scenario()
    const link = { ...(structuredClone(config.links[0]) as Link), type: 'SAT' as const }
    delete link.forwardDataRate
    delete link.reverseDataRate
    const wrapper = mount(LinkEditorDialog, {
      props: { modelValue: true, link, editing: true, error: '', pending: false, locked: false,
        platforms: config.platforms, linkTypeOptions: typeOptions, linkDirectionLabels: { FORWARD: '前向', REVERSE: '返向' }, minimumStep: 0.001 },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    inputNumber(wrapper, 'link-forward-data-rate').vm.$emit('update:modelValue', 3)
    inputNumber(wrapper, 'link-reverse-data-rate').vm.$emit('update:modelValue', 1.5)
    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ forwardDataRate: 3, reverseDataRate: 1.5 })
    inputNumber(wrapper, 'link-forward-data-rate').vm.$emit('update:modelValue', undefined)
    inputNumber(wrapper, 'link-reverse-data-rate').vm.$emit('update:modelValue', undefined)
    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    const emitted = wrapper.emitted('apply')!.at(-1)![0] as Link
    expect(Object.hasOwn(emitted, 'forwardDataRate')).toBe(false)
    expect(Object.hasOwn(emitted, 'reverseDataRate')).toBe(false)
    wrapper.unmount()
  })

  it('脚本预览引导保存生成，保留预检操作和错误位置', async () => {
    const script: ScriptContract = {
      scriptId: 'SCRIPT-001', taskId: 'TASK-001', scenarioId: 'SCN-001', configVersion: 'SCN-001-v1', target: 'AFSIM 2.9.0',
      checksum: 'FNV1A-MOCK-TEST', preview: '# script', generatedTime: '2026-09-28T00:00:00Z',
    }
    const generate = mount(ScriptPreview, {
      props: { state: 'EMPTY', resultMessage: '', script: null, preflight: emptyValidation, locked: false, dirty: false, preflightPassed: false },
      global: { plugins: [ElementPlus] },
    })
    expect(generate.find('[data-testid="generate-script"]').exists()).toBe(false)
    expect(generate.text()).toContain('请先点击上方“保存”')
    expect(generate.emitted('generate')).toBeUndefined()
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
    expect(dirty.find('[data-testid="generate-script"]').exists()).toBe(false)
    expect(dirty.get('[data-testid="preflight-script"]').attributes('disabled')).toBeDefined()
    dirty.unmount()
  })
})


describe('干扰带宽档位和链路对准', () => {
  function openJammer(bandwidth = 200, type: Jammer['type'] = 'BARRAGE') {
    const config = createTemplateScenario().config
    const jammer = { ...config.jammers[0]!, bandwidth, type }
    config.links.push({ ...config.links[0]!, id: 'disabled-link', enabled: false },
      { ...config.links[0]!, id: 'laser-link', type: 'LASER' })
    const wrapper = mount(JammerEditorDialog, {
      props: { modelValue: true, jammer, uiExtension: { jammerId: jammer.id, direction: 0, enabled: true },
        editing: true, error: '', pending: false, locked: false, platforms: config.platforms, links: config.links,
        jammerTypeOptions: [{ value: 'BARRAGE', label: '宽带压制' }, { value: 'SPOT', label: '瞄准式' }, { value: 'SWEEP', label: '扫频' }], minimumStep: 0.001 },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    return { wrapper, jammer, config }
  }

  it('可选干扰时序未填写或清空时省略键，已填值按原值序列化', async () => {
    const { wrapper, jammer } = openJammer()
    const serialized = () => {
      const draft = createTemplateScenario()
      draft.config.jammers[0] = structuredClone(toRaw(wrapper.emitted('apply')!.at(-1)![0] as Jammer))
      expect(inspectScenarioConfig(draft.config, 'write').result.errors).toEqual([])
      return JSON.stringify(createScenarioSnapshot(draft))
    }
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(serialized()).not.toMatch(/detectionDelayS|jammingDurationS/)
    inputNumber(wrapper, 'jammer-detection-delay').vm.$emit('update:modelValue', 0)
    inputNumber(wrapper, 'jammer-jamming-duration').vm.$emit('update:modelValue', 30)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(JSON.parse(serialized()).config.jammers[0]).toMatchObject({ detectionDelayS: 0, jammingDurationS: 30 })
    for (const empty of [undefined, null, Number.NaN]) {
      inputNumber(wrapper, 'jammer-detection-delay').vm.$emit('update:modelValue', empty)
      inputNumber(wrapper, 'jammer-jamming-duration').vm.$emit('update:modelValue', empty)
      await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
      const applied = wrapper.emitted('apply')!.at(-1)![0]
      expect(applied).not.toHaveProperty('detectionDelayS')
      expect(applied).not.toHaveProperty('jammingDurationS')
      expect(serialized()).not.toMatch(/detectionDelayS|jammingDurationS/)
    }
    expect(jammer).not.toHaveProperty('detectionDelayS')
    expect(jammer).not.toHaveProperty('jammingDurationS')
    wrapper.unmount()
  })

  it('按方式切换带宽，瞄准只读 5 MHz，扫频保留原值并允许自由输入', async () => {
    const { wrapper, jammer } = openJammer()
    expect(select(wrapper, 'jammer-bandwidth').findAllComponents({ name: 'ElOption' }).map(option => option.props('value'))).toEqual([100, 200, 400])
    expect(select(wrapper, 'jammer-bandwidth').props('allowCreate')).toBe(false)
    const changeType = async (type: Jammer['type']) => {
      select(wrapper, 'jammer-type').vm.$emit('update:modelValue', type)
      select(wrapper, 'jammer-type').vm.$emit('change', type)
      await flushPromises()
    }
    await changeType('SPOT')
    expect(select(wrapper, 'jammer-bandwidth').props()).toMatchObject({ modelValue: 5, disabled: true })
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ type: 'SPOT', bandwidth: 5 })
    await changeType('SWEEP')
    expect(inputNumber(wrapper, 'jammer-bandwidth').props('modelValue')).toBe(5)
    inputNumber(wrapper, 'jammer-bandwidth').vm.$emit('update:modelValue', 50)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ type: 'SWEEP', bandwidth: 50 })
    await changeType('BARRAGE')
    expect(select(wrapper, 'jammer-bandwidth').props('modelValue')).toBe(200)
    expect(jammer).toMatchObject({ type: 'BARRAGE', bandwidth: 200 })
    wrapper.unmount()
  })

  it.each([['BARRAGE', 50], ['SPOT', 20]] as const)('打开旧 %s 设备保留 %s MHz，显示非档位选项', async (type, bandwidth) => {
    const { wrapper, jammer } = openJammer(bandwidth, type)
    const options = select(wrapper, 'jammer-bandwidth').findAllComponents({ name: 'ElOption' })
    expect(options.find(option => option.props('value') === bandwidth)?.props('label')).toBe(`${bandwidth} MHz（不在档位内）`)
    expect(select(wrapper, 'jammer-bandwidth').props('modelValue')).toBe(bandwidth)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ type, bandwidth })
    expect(jammer.bandwidth).toBe(bandwidth)
    wrapper.unmount()
  })

  it('对准链路仅列启用的非激光链路，选择后填频率，不新增保存字段', async () => {
    const { wrapper, config, jammer } = openJammer(5, 'SPOT')
    const alignment = select(wrapper, 'jammer-aligned-link')
    expect(alignment.findAllComponents({ name: 'ElOption' }).map(option => option.props('value')))
      .toEqual(config.links.filter(link => link.enabled !== false && link.type !== 'LASER').map(link => link.id))
    const target = config.links[0]!
    alignment.vm.$emit('update:modelValue', target.id)
    alignment.vm.$emit('change', target.id)
    await flushPromises()
    expect(inputNumber(wrapper, 'jammer-frequency').props('modelValue')).toBe(target.frequency)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')![0]![0]).toEqual({ ...readJammerParameters(jammer), frequency: target.frequency })
    expect(jammer.frequency).toBe(2400)
    wrapper.unmount()
  })
})


it('侦测与链路计算默认补副本，保存输入值并保持原设备不变', async () => {
  const draft = createTemplateScenario(), original = structuredClone(draft.config.jammers[0]!)
  const wrapper = mount(JammerEditorDialog, {
    props: { modelValue: true, jammer: original, uiExtension: draft.uiExtensions.jammers[0], editing: true, error: '', pending: false, locked: false,
      platforms: draft.config.platforms, links: draft.config.links, jammerTypeOptions: [], minimumStep: 1 },
    global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
  })
  const inputs = wrapper.findAllComponents({ name: 'ElInputNumber' })
  for (const [key, value] of Object.entries({ radarFrequency: 2400, radarBandwidth: 1, radarPower: 1000, noiseFigureDb: 3, gtDbk: -12, eirpDbw: 40, antennaGainDbi: 0, txLossDb: 0, sweepDutyCycle: 0.1 })) {
    expect(inputs.find(input => input.attributes('data-testid') === `jammer-${key}`)!.props('modelValue')).toBe(value)
  }
  inputs.find(input => input.attributes('data-testid') === 'jammer-radarPower')!.vm.$emit('update:modelValue', 175)
  inputs.find(input => input.attributes('data-testid') === 'jammer-gtDbk')!.vm.$emit('update:modelValue', -9)
  await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
  expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ ...original, radarPower: 175, gtDbk: -9 })
  expect(original).toEqual(draft.config.jammers[0])
  wrapper.unmount()
})

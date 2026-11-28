import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { toRaw } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { APP_CONFIG } from '../../src/config/app.config'
import type { Jammer, JammerUiExtension, Link, ScenarioConfig, ScenarioLinkSettings, ScriptContract, ValidationResult } from '../../src/contracts/domain-models'
import JammerEditorDialog from '../../src/components/scenarios/JammerEditorDialog.vue'
import LinkEditorDialog from '../../src/components/scenarios/LinkEditorDialog.vue'
import LinkSettingsPanel from '../../src/components/scenarios/LinkSettingsPanel.vue'
import ScriptPreview from '../../src/components/scenarios/ScriptPreview.vue'
import { createScenarioSnapshot } from '../../src/features/scenarios/scenario-snapshot'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'
import type { LinkPortEditorProjection } from '../../src/features/scenarios/link-port-parameters'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import { readJammerParameters } from '../../src/features/scenarios/jammer-settings'
import { setJammerPowerUnit } from '../../src/features/scenarios/jammer-power-unit'
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
  it('链路全局计算参数与热链可编辑、发现断链', async () => {
    const config = scenario()
    const [source, relay, target] = config.platforms
    const seed = structuredClone(config.links[0]) as Link
    const links: Link[] = [
      { ...seed, id: 'L-F-1', type: 'DATALINK', sourcePlatformId: source!.id, targetPlatformId: relay!.id, direction: 'FORWARD', enabled: true },
      { ...seed, id: 'L-F-2', type: 'MICROWAVE', sourcePlatformId: relay!.id, targetPlatformId: target!.id, direction: 'FORWARD', enabled: true },
      { ...seed, id: 'R-F-1', type: 'DATALINK', sourcePlatformId: relay!.id, targetPlatformId: source!.id, direction: 'REVERSE', enabled: true },
      { ...seed, id: 'R-F-2', type: 'MICROWAVE', sourcePlatformId: target!.id, targetPlatformId: relay!.id, direction: 'REVERSE', enabled: true },
      { ...seed, id: 'L-R-1', type: 'SAT', sourcePlatformId: target!.id, targetPlatformId: source!.id, direction: 'REVERSE', enabled: true },
    ]
    const wrapper = mount(LinkSettingsPanel, {
      props: { modelValue: readLinkSettings(config), dialogVisible: true, platforms: config.platforms, links, jammers: config.jammers, disabled: false, typeOptions },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    const typed = wrapper as unknown as VueWrapper<{
      $props: { modelValue?: ScenarioLinkSettings; disabled: boolean }
      revealField: (path: string) => void
    }>
    const latest = () => wrapper.emitted('update:modelValue')!.at(-1)![0] as ScenarioLinkSettings

    const hotLinkHeader = wrapper.get('[data-testid="hot-link-settings"] > summary')
    expect(hotLinkHeader.text()).toContain('热链配置')
    expect(hotLinkHeader.get('[data-testid="hot-link-state"]').text()).toBe('未配置')
    expect(wrapper.find('[data-testid="hot-link-end-type"]').exists()).toBe(false)
    await hotLinkHeader.trigger('click')
    await wrapper.get('[data-testid="link-strategy-advanced"] > summary').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="hot-link-forward"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="link-calc-enable-warningThreshold"]').exists()).toBe(true)
    })
    wrapper.findAllComponents({ name: 'ElSwitch' }).find(item => item.attributes('data-testid') === 'link-calc-enable-warningThreshold')!.vm.$emit('update:modelValue', true)
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="link-calc-warningThreshold"]').exists()).toBe(true)
    })
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
    expect(wrapper.find('[data-testid="link-calc-jammingRangeKm"]').exists()).toBe(false)
    expect(latest().linkCalc!.jammingRangeKm).toBe(30)

    // 链路最大传输距离（trafficDistance）：默认折叠展示“默认距离”，展开可编辑 6 项距离并一键恢复默认
    expect(wrapper.get('[data-testid="traffic-distance-state"]').text()).toBe('默认距离')
    await wrapper.get('[data-testid="traffic-distance-settings"] > summary').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="link-calc-trafficDistance-relayUavKm"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="link-calc-trafficDistance-laserKm"]').exists()).toBe(true)
    })
    wrapper.findAllComponents({ name: 'ElInputNumber' })
      .find(item => item.attributes('data-testid') === 'link-calc-trafficDistance-relayUavKm')!
      .vm.$emit('update:modelValue', 90)
    expect(latest().linkCalc!.trafficDistance).toMatchObject({ relayUavKm: 90, microwaveKm: 200, laserKm: 40 })
    await typed.setProps({ modelValue: latest() })
    expect(wrapper.get('[data-testid="traffic-distance-state"]').text()).toBe('已自定义 1 项')
    await wrapper.get('[data-testid="traffic-distance-reset"]').trigger('click')
    expect(latest().linkCalc!.trafficDistance).toBeUndefined()
    await typed.setProps({ modelValue: latest() })
    expect(wrapper.get('[data-testid="traffic-distance-state"]').text()).toBe('默认距离')

    await typed.setProps({ modelValue: readLinkSettings(config) })
    // 已删除“热链终点平台类型”下拉，热链只按链路序列配置。
    expect(wrapper.find('[data-testid="hot-link-end-type"]').exists()).toBe(false)

    // 逐跳添加：先新增一条空热链，再选择第一跳。
    await wrapper.get('[data-testid="hot-link-forward-add"]').trigger('click')
    expect(latest().hotLinks!.forward).toEqual([[]])
    await typed.setProps({ modelValue: latest() })
    expect(wrapper.find('[data-testid="hot-link-forward-0"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="hot-link-forward-0"]').text()).not.toContain('热链至少需要一条链路')
    const closeEmits = wrapper.emitted('update:dialogVisible')?.length ?? 0
    await wrapper.get('[data-testid="close-link-settings"]').trigger('click')
    expect(wrapper.emitted('update:dialogVisible') ?? []).toHaveLength(closeEmits)
    expect(wrapper.get('[data-testid="hot-link-forward-0"]').text()).toContain('热链至少需要一条链路。')
    const firstHop = select(wrapper, 'hot-link-forward-0-next')
    expect(firstHop.findAllComponents({ name: 'ElOption' }).map(option => option.props('label'))).toEqual([
      '数传（后方指挥节点 → 高空前出中继节点）',
      '微波（高空前出中继节点 → 地面无人集群指挥车）',
    ])
    firstHop.vm.$emit('update:modelValue', 'L-F-1')
    expect(latest().hotLinks!.forward).toEqual([['L-F-1']])
    await typed.setProps({ modelValue: latest() })
    // 标题只给条数与跳数，路径用“节点+链路”常显，无需点“编辑”展开。
    const forwardCard = wrapper.get('[data-testid="hot-link-forward-0"]')
    expect(forwardCard.text()).toContain('第 1 条 · 1 跳')
    expect(forwardCard.text()).toContain('后方指挥节点')
    expect(forwardCard.text()).toContain('数传')
    expect(forwardCard.text()).toContain('高空前出中继节点')

    // 第二跳只列出从当前终点平台出发、未使用的链路。
    const secondHop = select(wrapper, 'hot-link-forward-0-next')
    expect(secondHop.findAllComponents({ name: 'ElOption' }).map(option => option.props('label'))).toEqual([
      '微波（高空前出中继节点 → 地面无人集群指挥车）',
    ])
    secondHop.vm.$emit('update:modelValue', 'L-F-2')
    expect(latest().hotLinks!.forward).toEqual([['L-F-1', 'L-F-2']])
    await typed.setProps({ modelValue: latest() })
    expect(wrapper.get('[data-testid="hot-link-forward-0"]').text()).toContain('第 1 条 · 2 跳')
    expect(wrapper.get('[data-testid="hot-link-forward-0"]').text()).toContain('地面无人集群指挥车')
    expect(select(wrapper, 'hot-link-forward-0-next').findAllComponents({ name: 'ElOption' })).toHaveLength(0)

    // 中间跳不可删：只有“删除最后一跳”；删后只剩第一跳，再删即整条移除。
    await wrapper.get('[data-testid="hot-link-forward-0-remove-last"]').trigger('click')
    expect(latest().hotLinks!.forward).toEqual([['L-F-1']])
    await typed.setProps({ modelValue: latest() })
    expect(wrapper.findAll('[data-testid="hot-link-forward-0-remove-last"]')).toHaveLength(1)
    await wrapper.get('[data-testid="hot-link-forward-0-remove-last"]').trigger('click')
    expect(latest().hotLinks!.forward).toEqual([])
    await typed.setProps({ modelValue: latest() })
    expect(wrapper.find('[data-testid="hot-link-forward-0"]').exists()).toBe(false)

    // 按起点/终点快捷生成最短连通路径。
    select(wrapper, 'hot-link-forward-quick-start').vm.$emit('update:modelValue', source!.id)
    select(wrapper, 'hot-link-forward-quick-end').vm.$emit('update:modelValue', target!.id)
    await wrapper.get('[data-testid="hot-link-forward-quick-generate"]').trigger('click')
    expect(latest().hotLinks!.forward).toEqual([['L-F-1', 'L-F-2']])
    await typed.setProps({ modelValue: latest() })

    // 由前向热链生成反方向返向热链：对应方向的链路存在时按相反顺序生成。
    await wrapper.get('[data-testid="hot-link-forward-0-reverse"]').trigger('click')
    expect(latest().hotLinks!.reverse).toEqual([['R-F-2', 'R-F-1']])
    await typed.setProps({ modelValue: latest() })

    // 服务端指出热链字段问题时能展开分区定位到条目。
    typed.vm.revealField('hotLinks.forward[0]')
    await flushPromises()
    expect(wrapper.find('[data-testid="hot-link-forward-0"]').exists()).toBe(true)
    expect(hotLinkHeader.get('[data-testid="hot-link-state"]').text()).toBe('已配置 2 条')

    const writes = wrapper.emitted('update:modelValue')!.length
    await typed.setProps({ disabled: true })
    select(wrapper, 'link-calc-channelEncodingScheme').vm.$emit('update:modelValue', -1)
    await threshold.setValue('1e-3')
    await wrapper.get('[data-testid="hot-link-forward-add"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toHaveLength(writes)
    wrapper.unmount()
  })

  it('旧排序不改变按起终点生成的热链，也不影响生成返向', async () => {
    const config = scenario()
    const seed = config.links[0]!
    const { sourcePlatformId, targetPlatformId } = seed
    const links: Link[] = [
      { ...seed, id: 'B', type: 'DATALINK' },
      { ...seed, id: 'A', type: 'MICROWAVE' },
      { ...seed, id: 'R-B', type: 'DATALINK', direction: 'REVERSE', sourcePlatformId: targetPlatformId, targetPlatformId: sourcePlatformId },
      { ...seed, id: 'R-A', type: 'FIBER', direction: 'REVERSE', sourcePlatformId: targetPlatformId, targetPlatformId: sourcePlatformId },
    ]
    const legacy = { ...readLinkSettings(config), priority: ['DATALINK', 'MICROWAVE', 'SAT', 'LASER', 'FIBER'] }
    const wrapper = mount(LinkSettingsPanel, {
      props: { modelValue: legacy, dialogVisible: true, platforms: config.platforms, links, disabled: false, typeOptions },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    const typed = wrapper as unknown as VueWrapper<{ $props: { modelValue: ScenarioLinkSettings } }>
    const latest = () => wrapper.emitted('update:modelValue')!.at(-1)![0] as ScenarioLinkSettings
    await wrapper.get('[data-testid="hot-link-settings"] > summary').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="hot-link-forward-quick-start"]').exists()).toBe(true))
    select(wrapper, 'hot-link-forward-quick-start').vm.$emit('update:modelValue', sourcePlatformId)
    select(wrapper, 'hot-link-forward-quick-end').vm.$emit('update:modelValue', targetPlatformId)
    await wrapper.get('[data-testid="hot-link-forward-quick-generate"]').trigger('click')
    expect(latest().hotLinks?.forward).toEqual([['A']])
    expect(latest()).not.toHaveProperty('priority')
    const legacyWithForward = { ...latest(), priority: legacy.priority }
    await typed.setProps({ modelValue: legacyWithForward })
    await wrapper.get('[data-testid="hot-link-forward-0-reverse"]').trigger('click')
    expect(latest().hotLinks).toEqual({ forward: [['A']], reverse: [['R-A']] })
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
    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ type: 'DATALINK', band: 'L', direction: 'REVERSE', frequency: 1300,
      rxFrequency: 1300, rxBandwidth: 10, dataRate: 0.0128, rxPolarization: 'horizontal', noiseFigureDb: 7 })
    expect(link.type).toBe('SAT')

    select(wrapper, 'link-type').vm.$emit('update:modelValue', 'MICROWAVE')
    select(wrapper, 'link-type').vm.$emit('change', 'MICROWAVE')
    await flushPromises()
    expect(wrapper.get('[data-testid="link-data-rate"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).not.toMatch(/新模板无对应参数|端口参数设置/)
    expect(select(wrapper, 'link-tx-polarization').props('modelValue')).toBe('horizontal')
    select(wrapper, 'link-type').vm.$emit('update:modelValue', 'LASER')
    select(wrapper, 'link-type').vm.$emit('change', 'LASER')
    await flushPromises()
    expect(wrapper.find('[data-testid="link-laser-advanced"]').exists()).toBe(true)
    select(wrapper, 'link-type').vm.$emit('update:modelValue', 'FIBER')
    select(wrapper, 'link-type').vm.$emit('change', 'FIBER')
    await flushPromises()
    expect(wrapper.text()).toContain('10～1000 Mbit/s')
    expect(wrapper.find('[data-testid="link-bandwidth"]').exists()).toBe(false)
    expect(inputNumber(wrapper, 'link-data-rate').props('min')).toBe(10)
    expect(inputNumber(wrapper, 'link-data-rate').props('max')).toBe(1000)
    wrapper.unmount()
  })

  it('质量参数常驻显示在接收与极化上方，确认校验失败时展开接收与极化', async () => {
    const config = scenario()
    const savedParameters = { rxFrequency: 5500, rxBandwidth: 3, txPolarization: 'horizontal', rxPolarization: 'vertical',
      noiseFigureDb: 6, modulation: 'QPSK', berThreshold: 0.001 } as const
    const link = { ...structuredClone(config.links[0]), ...savedParameters }
    const wrapper = mount(LinkEditorDialog, {
      props: { modelValue: true, link, editing: true, error: '', pending: false, locked: false,
        platforms: config.platforms, linkTypeOptions: typeOptions, linkDirectionLabels: { FORWARD: '前向', REVERSE: '返向' }, minimumStep: 0.001,
        validate: (candidate: Link) => {
          const updated = { ...config, links: [candidate, ...config.links.slice(1)] }
          return inspectScenarioConfig(updated, 'write').result.errors.filter(error => error.fieldPath.startsWith('links[0].'))
            .map(error => ({ ...error, fieldPath: error.fieldPath.slice('links[0].'.length) }))
        } },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    const receive = wrapper.get<HTMLDetailsElement>('[data-testid="link-receive-advanced"]')
    const quality = wrapper.get('section[data-testid="link-quality-advanced"]')
    expect(receive.get('summary').text()).toBe('接收与极化')
    expect(quality.get('h4, h5').text()).toBe('质量参数')
    expect(quality.element.nextElementSibling).toBe(receive.element)
    expect(receive.element.open).toBe(false)
    expect(receive.element.contains(wrapper.get('[data-testid="link-noise-figure"]').element)).toBe(true)
    expect(quality.get('[data-testid="link-modulation"]').element.closest('details')).toBeNull()
    expect(wrapper.find('[data-testid="link-ber-threshold"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="link-coding"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="link-direction"]').element.closest('details')).toBeNull()
    expect(wrapper.find('[data-testid="link-tx-gain"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="link-rx-gain"]').exists()).toBe(false)
    const confirm = wrapper.get('[data-testid="apply-link"]')
    await confirm.trigger('click')
    expect(wrapper.emitted('apply')?.[0][0]).toMatchObject(savedParameters)
    expect(receive.element.open).toBe(false)

    await receive.get('summary').trigger('click')
    expect(receive.element.open).toBe(true)
    const modulation = select(wrapper, 'link-modulation')
    await modulation.trigger('mouseenter')
    await modulation.get('.el-select__clear').trigger('click')
    expect(modulation.props('modelValue')).toBe('')
    const modulationField = wrapper.findAllComponents({ name: 'ElFormItem' })
      .find(item => item.props('label') === '调制方式')
    expect(modulationField?.props('error')).toBe('调制方式不正确。')
    inputNumber(wrapper, 'link-rx-frequency').vm.$emit('update:modelValue', 0)
    await receive.get('summary').trigger('click')
    await confirm.trigger('click')
    expect(receive.element.open).toBe(true)
    modulation.vm.$emit('update:modelValue', 'QPSK')
    inputNumber(wrapper, 'link-rx-frequency').vm.$emit('update:modelValue', 5600)
    await confirm.trigger('click')
    expect(wrapper.emitted('apply')?.at(-1)?.[0]).toMatchObject({ ...savedParameters, rxFrequency: 5600 })
    expect(receive.element.open).toBe(true)
    expect(link).toMatchObject(savedParameters)
    wrapper.unmount()
  })

  it('共享端口值随端点、链路类型、方向和频段变化，旧值只在明确采用后才交由平台端口托管', async () => {
    const config = createTemplateScenario().config
    const link = structuredClone(config.links.find(item => item.type === 'DATALINK')!)
    const original = structuredClone(link)
    delete link.rxFrequency
    const resolvePortParameters = (candidate: Link): LinkPortEditorProjection => {
      const portName = candidate.type === 'MICROWAVE' ? 'microwave_link'
        : `${candidate.band?.toLowerCase()}_band_${candidate.direction === 'REVERSE' ? 'downlink' : 'uplink'}`
      return {
        source: { platformType: 'COMMAND_VEHICLE_PLATFORM', portName },
        target: { platformType: 'MISSION_UAV_PLATFORM', portName },
        values: { frequency: candidate.band === 'L' ? 1620 : 2400, bandwidth: 12, txPower: 21, dataRate: 2,
          rxFrequency: 3100, rxBandwidth: 22, noiseFigureDb: 8 },
      }
    }
    const previousShowMasterData = APP_CONFIG.systemManagement.showMasterData
    APP_CONFIG.systemManagement.showMasterData = true
    const wrapper = mount(LinkEditorDialog, {
      props: { modelValue: true, link, editing: true, error: '', pending: false, locked: false, resolvePortParameters,
        platforms: config.platforms, linkTypeOptions: typeOptions, linkDirectionLabels: { FORWARD: '前向', REVERSE: '返向' }, minimumStep: 0.001,
        parameterCatalog: { equipment: [], masterData: [
          { dataId: 'PORT-DICT', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
            content: { name: '接收噪声', description: '', entries: [{ key: 'noiseFigureDb', valueType: 'NUMBER', value: 4, unit: 'dB' }] } },
          { dataId: 'LINK-ENUM', kind: 'ENUMERATION', version: 1, referenceCount: 0, active: true,
            content: { name: '链路调制', description: '', entries: [{ key: 'modulation.QPSK', valueType: 'TEXT', value: 'QPSK' }] } },
        ] } },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })

    const choose = async (id: string, value: string) => {
      const component = select(wrapper, id)
      component.vm.$emit('update:modelValue', value)
      component.vm.$emit('change', value)
      await flushPromises()
    }
    for (const name of ['frequency', 'bandwidth', 'power', 'data-rate', 'rx-frequency', 'rx-bandwidth', 'noise-figure']) {
      expect(wrapper.find(`[data-testid="link-${name}"]`).exists()).toBe(false)
    }
    expect(wrapper.get('[data-testid="link-port-parameters"]').text()).toContain('c_band_')
    expect(wrapper.find('[data-testid="link-port-conflict"]').exists()).toBe(false)

    select(wrapper, 'link-target').vm.$emit('update:modelValue', 'mission_uav_02')
    select(wrapper, 'link-band').vm.$emit('update:modelValue', 'L')
    select(wrapper, 'link-band').vm.$emit('change', 'L')
    select(wrapper, 'link-direction').vm.$emit('update:modelValue', 'REVERSE')
    select(wrapper, 'link-direction').vm.$emit('change', 'REVERSE')
    await flushPromises()
    expect(wrapper.get('[data-testid="link-port-parameters"]').text()).toContain('任务无人机 A · l_band_downlink')

    select(wrapper, 'link-type').vm.$emit('update:modelValue', 'MICROWAVE')
    select(wrapper, 'link-type').vm.$emit('change', 'MICROWAVE')
    await flushPromises()
    expect(wrapper.get('[data-testid="link-port-parameters"]').text()).toContain('microwave_link')

    const confirm = wrapper.get('[data-testid="apply-link"]')
    await confirm.trigger('click')
    const first = wrapper.emitted('apply')![0]![0] as Link
    expect(first).toMatchObject({ frequency: original.frequency, bandwidth: original.bandwidth, dataRate: original.dataRate })
    expect(first).not.toHaveProperty('rxFrequency')
    expect(first).not.toHaveProperty('inheritPortParameters')

    await choose('link-type', 'LASER')
    expect(inputNumber(wrapper, 'link-frequency').props('modelValue')).toBe(193_500_000)
    await choose('link-type', 'DATALINK')
    await confirm.trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)?.[0]).toMatchObject({ frequency: original.frequency, antennaGain: original.antennaGain })
    expect(wrapper.emitted('apply')!.at(-1)?.[0]).not.toHaveProperty('rxFrequency')
    expect(wrapper.find('[data-testid="inherit-link-port-parameters"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="keep-link-port-parameters"]').exists()).toBe(false)

    try {
      await choose('link-parameter-select', 'MASTER_DATA:PORT-DICT')
      expect(wrapper.get('[data-testid="link-parameter-selection-error"]').text()).toContain('端口参数设置')
      expect(wrapper.find('[data-testid="link-parameter-applied"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="link-noise-figure"]').exists()).toBe(false)

      await choose('link-parameter-select', 'MASTER_DATA:LINK-ENUM')
      await choose('link-parameter-entry', 'modulation.QPSK')
      await confirm.trigger('click')
      expect(wrapper.emitted('apply')!.at(-1)?.[0]).toMatchObject({ modulation: 'QPSK',
        parameterSource: { sourceId: 'LINK-ENUM', fields: ['modulation'] } })
    } finally {
      APP_CONFIG.systemManagement.showMasterData = previousShowMasterData
      wrapper.unmount()
    }
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
    // 触发时间、干扰指向与启停帧不参与仿真，编辑框不再提供配置。
    expect(wrapper.find('[data-testid="jammer-trigger-time"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="jammer-direction"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="jammer-planned-start"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('新模板无对应参数，不写入脚本；干扰按干扰范围 / 释放范围启停。')
    expect(inputNumber(wrapper, 'jammer-release-range').props('modelValue')).toBeCloseTo((jammer.jammingRange + 9260) / 1000, 3)
    inputNumber(wrapper, 'jammer-range').vm.$emit('update:modelValue', 12.5)
    inputNumber(wrapper, 'jammer-jamming-range').vm.$emit('update:modelValue', 16)
    inputNumber(wrapper, 'jammer-release-range').vm.$emit('update:modelValue', 18)
    expect(wrapper.findComponent({ name: 'ElSwitch' }).exists()).toBe(false)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ detectionRange: 12_500, jammingRange: 16_000, releaseRange: 18_000 })
    expect(wrapper.emitted('apply')!.at(-1)![1]).toMatchObject({ enabled: true })
    expect(jammer.releaseRange).toBeUndefined()

    inputNumber(wrapper, 'jammer-jamming-range').vm.$emit('update:modelValue', undefined)
    inputNumber(wrapper, 'jammer-release-range').vm.$emit('update:modelValue', undefined)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    const emitted = wrapper.emitted('apply')!.at(-1)![0] as Jammer
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

  it('干扰功率直接按 W 输入，拒绝 0/负值/空值并支持任意正瓦数', async () => {
    const config = scenario()
    const jammer = { ...(structuredClone(config.jammers[0]) as Jammer), defaultPower: 10_000 }
    const uiExtension: JammerUiExtension = { jammerId: jammer.id, direction: 0, enabled: true }
    const wrapper = mount(JammerEditorDialog, {
      props: { modelValue: true, jammer, uiExtension, editing: true, error: '', pending: false, locked: false,
        platforms: config.platforms, links: config.links, jammerTypeOptions: [{ value: 'BARRAGE', label: '宽带压制' }], minimumStep: 0.001, validate: () => [] },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    expect(inputNumber(wrapper, 'jammer-power').props('modelValue')).toBe(10_000)
    inputNumber(wrapper, 'jammer-power').vm.$emit('update:modelValue', 0)
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(jammer.defaultPower).toBe(10_000)
    inputNumber(wrapper, 'jammer-power').vm.$emit('update:modelValue', undefined)
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    inputNumber(wrapper, 'jammer-power').vm.$emit('update:modelValue', 250)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect((wrapper.emitted('apply')!.at(-1)![0] as Jammer).defaultPower).toBe(250)
    wrapper.unmount()
  })

  it('每条链路均按当前通信方向展示并编辑对应前向/返向速率，清空后删除字段', async () => {
    const config = scenario()
    const baseLink = structuredClone(config.links[0]) as Link
    delete baseLink.forwardDataRate
    delete baseLink.reverseDataRate

    // 卫星链路：前向仅展示前向速率，切到返向仅展示返向速率。
    const satWrapper = mount(LinkEditorDialog, {
      props: { modelValue: true, link: { ...baseLink, type: 'SAT', direction: 'FORWARD' }, editing: true, error: '', pending: false, locked: false,
        platforms: config.platforms, linkTypeOptions: typeOptions, linkDirectionLabels: { FORWARD: '前向', REVERSE: '返向' }, minimumStep: 0.001 },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    expect(satWrapper.find('[data-testid="link-forward-data-rate"]').exists()).toBe(true)
    expect(satWrapper.find('[data-testid="link-reverse-data-rate"]').exists()).toBe(false)
    inputNumber(satWrapper, 'link-forward-data-rate').vm.$emit('update:modelValue', 3)
    await satWrapper.get('[data-testid="apply-link"]').trigger('click')
    expect(satWrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ forwardDataRate: 3 })

    select(satWrapper, 'link-direction').vm.$emit('update:modelValue', 'REVERSE')
    select(satWrapper, 'link-direction').vm.$emit('change', 'REVERSE')
    await flushPromises()
    expect(satWrapper.find('[data-testid="link-forward-data-rate"]').exists()).toBe(false)
    expect(satWrapper.find('[data-testid="link-reverse-data-rate"]').exists()).toBe(true)
    inputNumber(satWrapper, 'link-reverse-data-rate').vm.$emit('update:modelValue', 1.5)
    await satWrapper.get('[data-testid="apply-link"]').trigger('click')
    expect(satWrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ direction: 'REVERSE', forwardDataRate: 3, reverseDataRate: 1.5 })

    inputNumber(satWrapper, 'link-reverse-data-rate').vm.$emit('update:modelValue', undefined)
    await satWrapper.get('[data-testid="apply-link"]').trigger('click')
    expect(Object.hasOwn(satWrapper.emitted('apply')!.at(-1)![0] as Link, 'reverseDataRate')).toBe(false)
    satWrapper.unmount()

    // 托管到端口参数设置的数传/光纤链路同样支持按方向设置独立速率。
    const fiberWrapper = mount(LinkEditorDialog, {
      props: {
        modelValue: true,
        link: { ...baseLink, type: 'FIBER', direction: 'FORWARD' },
        editing: true, error: '', pending: false, locked: false,
        platforms: config.platforms, linkTypeOptions: typeOptions, linkDirectionLabels: { FORWARD: '前向', REVERSE: '返向' }, minimumStep: 0.001,
        resolvePortParameters: () => ({
          source: { platformType: 'REAR_COMM_PLATFORM', portName: 'fiber_link' },
          target: { platformType: 'COMMAND_VEHICLE_PLATFORM', portName: 'fiber_link' },
          values: { dataRate: 1000 },
        }),
      },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    expect(fiberWrapper.find('[data-testid="link-forward-data-rate"]').exists()).toBe(true)
    expect(fiberWrapper.find('[data-testid="link-reverse-data-rate"]').exists()).toBe(false)
    expect(fiberWrapper.text()).toContain('10～1000 Mbit/s；留空沿用端口/默认速率。')
    expect(inputNumber(fiberWrapper, 'link-forward-data-rate').props('min')).toBe(10)
    expect(inputNumber(fiberWrapper, 'link-forward-data-rate').props('max')).toBe(1000)
    inputNumber(fiberWrapper, 'link-forward-data-rate').vm.$emit('update:modelValue', 500)
    await fiberWrapper.get('[data-testid="apply-link"]').trigger('click')
    expect(fiberWrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ type: 'FIBER', forwardDataRate: 500 })
    fiberWrapper.unmount()

    // 微波链路与 L 波段数传链路同样按各自上下界显示范围提示。
    const microwaveWrapper = mount(LinkEditorDialog, {
      props: {
        modelValue: true,
        link: { ...baseLink, type: 'MICROWAVE', direction: 'FORWARD' },
        editing: true, error: '', pending: false, locked: false,
        platforms: config.platforms, linkTypeOptions: typeOptions, linkDirectionLabels: { FORWARD: '前向', REVERSE: '返向' }, minimumStep: 0.001,
      },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    expect(microwaveWrapper.text()).toContain('0.1～100 Mbit/s；留空沿用端口/默认速率。')
    expect(inputNumber(microwaveWrapper, 'link-forward-data-rate').props('min')).toBe(0.1)
    expect(inputNumber(microwaveWrapper, 'link-forward-data-rate').props('max')).toBe(100)
    microwaveWrapper.unmount()
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

  it('干扰延迟与持续时长已从界面移除，保存时不引入无效时序字段', async () => {
    const { wrapper, jammer } = openJammer()
    expect(wrapper.find('[data-testid="jammer-timing-advanced"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="jammer-detection-delay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="jammer-jamming-duration"]').exists()).toBe(false)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    const draft = createTemplateScenario()
    draft.config.jammers[0] = structuredClone(toRaw(wrapper.emitted('apply')!.at(-1)![0] as Jammer))
    expect(inspectScenarioConfig(draft.config, 'write').result.errors).toEqual([])
    expect(JSON.stringify(createScenarioSnapshot(draft))).not.toMatch(/detectionDelayS|jammingDurationS/)
    expect(jammer).not.toHaveProperty('detectionDelayS')
    expect(jammer).not.toHaveProperty('jammingDurationS')
    wrapper.unmount()
  })

  it('按方式切换带宽默认值，所有干扰方式均支持手动输入', async () => {
    const { wrapper, jammer } = openJammer()
    expect(inputNumber(wrapper, 'jammer-bandwidth').props()).toMatchObject({ modelValue: 200, min: Number.MIN_VALUE, step: 0.001 })
    inputNumber(wrapper, 'jammer-bandwidth').vm.$emit('update:modelValue', 1)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ type: 'BARRAGE', bandwidth: 1 })
    const changeType = async (type: Jammer['type']) => {
      select(wrapper, 'jammer-type').vm.$emit('update:modelValue', type)
      select(wrapper, 'jammer-type').vm.$emit('change', type)
      await flushPromises()
    }
    await changeType('SPOT')
    expect(inputNumber(wrapper, 'jammer-bandwidth').props('modelValue')).toBe(5)
    inputNumber(wrapper, 'jammer-bandwidth').vm.$emit('update:modelValue', 12)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ type: 'SPOT', bandwidth: 12 })
    await changeType('SWEEP')
    expect(inputNumber(wrapper, 'jammer-bandwidth').props('modelValue')).toBe(12)
    inputNumber(wrapper, 'jammer-bandwidth').vm.$emit('update:modelValue', 50)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ type: 'SWEEP', bandwidth: 50 })
    await changeType('BARRAGE')
    expect(inputNumber(wrapper, 'jammer-bandwidth').props('modelValue')).toBe(10)
    expect(jammer).toMatchObject({ type: 'BARRAGE', bandwidth: 200 })
    wrapper.unmount()
  })

  it.each([['BARRAGE', 50], ['SPOT', 20]] as const)('打开 %s 设备保留原 %s MHz 带宽并可手动修改', async (type, bandwidth) => {
    const { wrapper, jammer } = openJammer(bandwidth, type)
    expect(inputNumber(wrapper, 'jammer-bandwidth').props('modelValue')).toBe(bandwidth)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ type, bandwidth })
    expect(jammer.bandwidth).toBe(bandwidth)
    wrapper.unmount()
  })

  it('宽带压制提供 100/200/400 MHz 快捷带宽并提示功率填写范围', async () => {
    const { wrapper } = openJammer(200, 'BARRAGE')
    expect(wrapper.find('[data-testid="jammer-timing-advanced"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="jammer-power-hint"]').text()).toBe('单位 W，须大于 0。')
    await wrapper.get('[data-testid="jammer-bandwidth-preset-400"]').trigger('click')
    expect(inputNumber(wrapper, 'jammer-bandwidth').props('modelValue')).toBe(400)
    await wrapper.get('[data-testid="jammer-bandwidth-preset-100"]').trigger('click')
    expect(inputNumber(wrapper, 'jammer-bandwidth').props('modelValue')).toBe(100)
    select(wrapper, 'jammer-type').vm.$emit('update:modelValue', 'SPOT')
    select(wrapper, 'jammer-type').vm.$emit('change', 'SPOT')
    await flushPromises()
    expect(wrapper.find('[data-testid="jammer-bandwidth-preset-100"]').exists()).toBe(false)
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
    expect(wrapper.emitted('apply')![0]![0]).toEqual({
      ...readJammerParameters(jammer),
      frequency: target.frequency,
      weaponBands: [{ frequency: target.frequency, bandwidth: jammer.bandwidth, mode: 'SPOT', spotBandwidthMHz: jammer.bandwidth, sweepDutyCycle: 0 }],
    })
    expect(jammer.frequency).toBe(2400)
    wrapper.unmount()
  })

  it('干扰频段支持新增多组、独立模式与瞄准带宽/扫频占空比编辑，至少保留 1 组并同步主频段', async () => {
    const { wrapper } = openJammer(200, 'BARRAGE')
    expect(wrapper.findAll('[data-testid^="jammer-band-row-"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="jammer-remove-band-0"]').attributes('disabled')).toBeDefined()
    inputNumber(wrapper, 'jammer-frequency').vm.$emit('update:modelValue', 4200)
    inputNumber(wrapper, 'jammer-bandwidth').vm.$emit('update:modelValue', 200)
    await wrapper.get('[data-testid="jammer-add-band"]').trigger('click')
    expect(wrapper.findAll('[data-testid^="jammer-band-row-"]')).toHaveLength(2)
    expect(wrapper.get('[data-testid="jammer-remove-band-0"]').attributes('disabled')).toBeUndefined()
    // 将第 2 组设为扫频模式并设置占空比 0.2。
    select(wrapper, 'jammer-band-mode-1').vm.$emit('update:modelValue', 'SWEEP')
    select(wrapper, 'jammer-band-mode-1').vm.$emit('change', 'SWEEP')
    await flushPromises()
    inputNumber(wrapper, 'jammer-band-frequency-1').vm.$emit('update:modelValue', 2200)
    inputNumber(wrapper, 'jammer-band-bandwidth-1').vm.$emit('update:modelValue', 40)
    inputNumber(wrapper, 'jammer-band-sweep-duty-1').vm.$emit('update:modelValue', 0.2)
    await flushPromises()
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({
      type: 'BARRAGE',
      frequency: 4200,
      bandwidth: 200,
      weaponBands: [
        { frequency: 4200, bandwidth: 200, mode: 'BARRAGE', spotBandwidthMHz: 0, sweepDutyCycle: 0 },
        { frequency: 2200, bandwidth: 40, mode: 'SWEEP', spotBandwidthMHz: 0, sweepDutyCycle: 0.2 },
      ],
    })
    // 删除第 1 组后，第 2 组自动成为主频段并同步顶层 type / frequency / bandwidth，且剩余 1 组禁用删除。
    await wrapper.get('[data-testid="jammer-remove-band-0"]').trigger('click')
    expect(wrapper.findAll('[data-testid^="jammer-band-row-"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="jammer-remove-band-0"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({
      type: 'SWEEP',
      frequency: 2200,
      bandwidth: 40,
      weaponBands: [{ frequency: 2200, bandwidth: 40, mode: 'SWEEP', spotBandwidthMHz: 0, sweepDutyCycle: 0.2 }],
    })
    wrapper.unmount()
  })

  it('瞄准式修改干扰带宽自动联动瞄准带宽，功率越界时确认拦截并提示', async () => {
    const config = scenario()
    const jammer = { ...(structuredClone(config.jammers[0]) as Jammer), type: 'BARRAGE' as const, bandwidth: 200 }
    const wrapper = mount(JammerEditorDialog, {
      props: {
        modelValue: true, jammer, uiExtension: { jammerId: jammer.id, direction: 0, enabled: true },
        editing: true, error: '', pending: false, locked: false,
        platforms: config.platforms, links: config.links,
        jammerTypeOptions: [{ value: 'BARRAGE', label: '宽带压制' }, { value: 'SPOT', label: '瞄准式' }, { value: 'SWEEP', label: '扫频' }],
        minimumStep: 0.001, validate: () => [],
      },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    inputNumber(wrapper, 'jammer-frequency').vm.$emit('update:modelValue', 8200)
    await flushPromises()
    expect(wrapper.find('[data-testid="jammer-frequency-ghz-hint"]').exists()).toBe(false)
    // 功率输入 0 W 非法，点击确认拦截并展示明确错误提示。
    inputNumber(wrapper, 'jammer-power').vm.$emit('update:modelValue', 0)
    await flushPromises()
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(wrapper.get('.platform-feedback').text()).toContain('大于 0 W')
    // 修正功率后切为瞄准式，仅改干扰带宽会自动联动瞄准带宽；单独改瞄准带宽后不再被覆盖。
    inputNumber(wrapper, 'jammer-power').vm.$emit('update:modelValue', 200)
    select(wrapper, 'jammer-type').vm.$emit('update:modelValue', 'SPOT')
    select(wrapper, 'jammer-type').vm.$emit('change', 'SPOT')
    await flushPromises()
    inputNumber(wrapper, 'jammer-bandwidth').vm.$emit('update:modelValue', 8)
    await flushPromises()
    expect(inputNumber(wrapper, 'jammer-band-spot-bandwidth-0').props('modelValue')).toBe(8)
    inputNumber(wrapper, 'jammer-band-spot-bandwidth-0').vm.$emit('update:modelValue', 5)
    inputNumber(wrapper, 'jammer-bandwidth').vm.$emit('update:modelValue', 12)
    await flushPromises()
    expect(inputNumber(wrapper, 'jammer-band-spot-bandwidth-0').props('modelValue')).toBe(5)
    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({
      type: 'SPOT',
      frequency: 8200,
      bandwidth: 12,
      weaponBands: [{ frequency: 8200, bandwidth: 12, mode: 'SPOT', spotBandwidthMHz: 5, sweepDutyCycle: 0 }],
    })
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
  expect(wrapper.get('[data-testid="jammer-calc-advanced"]').attributes('open')).toBeUndefined()
  expect(wrapper.find('[data-testid="jammer-gtDbk"]').exists()).toBe(false)
  // 干扰辐射功率与天线增益已移到主表单常显。
  expect(wrapper.find('[data-testid="jammer-eirpDbw"]').exists()).toBe(true)
  expect(wrapper.find('[data-testid="jammer-antennaGainDbi"]').exists()).toBe(true)
  for (const [key, value] of Object.entries({ radarFrequency: 2400, radarBandwidth: 1, radarPower: 1000, noiseFigureDb: 3, eirpDbw: 0, antennaGainDbi: 20, txLossDb: 0, sweepDutyCycle: 0.1 })) {
    expect(inputs.find(input => input.attributes('data-testid') === `jammer-${key}`)!.props('modelValue')).toBe(value)
  }
  inputs.find(input => input.attributes('data-testid') === 'jammer-radarPower')!.vm.$emit('update:modelValue', 175)
  await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
  expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ ...original, radarPower: 175, gtDbk: -12, eirpDbw: 0, antennaGainDbi: 20 })
  expect(original).toEqual(draft.config.jammers[0])
  wrapper.unmount()
})

it('干扰辐射功率、天线增益为空时不能确认', async () => {
  const draft = createTemplateScenario(), original = structuredClone(draft.config.jammers[0]!)
  const wrapper = mount(JammerEditorDialog, {
    props: { modelValue: true, jammer: original, uiExtension: draft.uiExtensions.jammers[0], editing: true, error: '', pending: false, locked: false,
      platforms: draft.config.platforms, links: draft.config.links, jammerTypeOptions: [], minimumStep: 1 },
    global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
  })
  for (const field of ['jammer-eirpDbw', 'jammer-antennaGainDbi'] as const) {
    inputNumber(wrapper, field).vm.$emit('update:modelValue', undefined)
  }
  await flushPromises()
  expect(inputNumber(wrapper, 'jammer-eirpDbw').props('modelValue')).toBeUndefined()
  expect(inputNumber(wrapper, 'jammer-antennaGainDbi').props('modelValue')).toBeUndefined()
  await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
  expect(wrapper.emitted('apply')).toBeUndefined()
  wrapper.unmount()
})

it('调整干扰功率、天线增益与发射损耗时自动联动更新干扰辐射功率，且允许手动覆盖', async () => {
  const draft = createTemplateScenario()
  const jammer = { ...structuredClone(draft.config.jammers[0]!), antennaGainDbi: 25, txLossDb: 1, eirpDbw: 40 }
  const wrapper = mount(JammerEditorDialog, {
    props: { modelValue: true, jammer, uiExtension: draft.uiExtensions.jammers[0], editing: true, error: '', pending: false, locked: false,
      platforms: draft.config.platforms, links: draft.config.links, jammerTypeOptions: [], minimumStep: 1 },
    global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
  })
  // 打开已有设备时不擅自改写原保存的 eirpDbw
  expect(inputNumber(wrapper, 'jammer-eirpDbw').props('modelValue')).toBe(40)

  // 调整干扰功率（W）：0.1 W(-10 dBW) -> -10+25-1=14 dBW；10 W(10 dBW) -> 34 dBW；1000 W(30 dBW) -> 54 dBW
  inputNumber(wrapper, 'jammer-power').vm.$emit('update:modelValue', 0.1)
  await flushPromises()
  expect(inputNumber(wrapper, 'jammer-eirpDbw').props('modelValue')).toBe(14)

  inputNumber(wrapper, 'jammer-power').vm.$emit('update:modelValue', 10)
  await flushPromises()
  expect(inputNumber(wrapper, 'jammer-eirpDbw').props('modelValue')).toBe(34)

  inputNumber(wrapper, 'jammer-power').vm.$emit('update:modelValue', 1000)
  await flushPromises()
  expect(inputNumber(wrapper, 'jammer-eirpDbw').props('modelValue')).toBe(54)

  // 调整天线增益与发射损耗同样同步联动
  inputNumber(wrapper, 'jammer-antennaGainDbi').vm.$emit('update:modelValue', 30)
  await flushPromises()
  expect(inputNumber(wrapper, 'jammer-eirpDbw').props('modelValue')).toBe(59)

  inputNumber(wrapper, 'jammer-txLossDb').vm.$emit('update:modelValue', 2.5)
  await flushPromises()
  expect(inputNumber(wrapper, 'jammer-eirpDbw').props('modelValue')).toBe(57.5)

  // 手动覆盖 eirpDbw 后，微调天线增益不冲掉手动值；再次调功率后恢复联动
  inputNumber(wrapper, 'jammer-eirpDbw').vm.$emit('update:modelValue', 48)
  await flushPromises()
  inputNumber(wrapper, 'jammer-antennaGainDbi').vm.$emit('update:modelValue', 20)
  await flushPromises()
  expect(inputNumber(wrapper, 'jammer-eirpDbw').props('modelValue')).toBe(48)

  inputNumber(wrapper, 'jammer-power').vm.$emit('update:modelValue', 1)
  await flushPromises()
  expect(inputNumber(wrapper, 'jammer-eirpDbw').props('modelValue')).toBe(17.5)

  await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
  expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ eirpDbw: 17.5, antennaGainDbi: 20, txLossDb: 2.5 })
  wrapper.unmount()
})

it('干扰功率支持在 W 与 dBm 之间切换显示和编辑，保存仍输出合同瓦数', async () => {
  setJammerPowerUnit('W')
  try {
    const draft = createTemplateScenario()
    const jammer = { ...structuredClone(draft.config.jammers[0]!), defaultPower: 1000, antennaGainDbi: 25, txLossDb: 1, eirpDbw: 54 }
    const wrapper = mount(JammerEditorDialog, {
      props: { modelValue: true, jammer, uiExtension: draft.uiExtensions.jammers[0], editing: true, error: '', pending: false, locked: false,
        platforms: draft.config.platforms, links: draft.config.links, jammerTypeOptions: [], minimumStep: 1 },
      global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
    })
    expect(inputNumber(wrapper, 'jammer-power').props('modelValue')).toBe(1000)

    // 切换到 dBm：1000 W 显示为 60 dBm，不改写原 eirpDbw
    const unitSwitch = wrapper.findAllComponents({ name: 'ElRadioGroup' })
      .find(item => item.attributes('data-testid') === 'jammer-power-unit-switch')!
    unitSwitch.vm.$emit('update:modelValue', 'dBm')
    await flushPromises()
    expect(inputNumber(wrapper, 'jammer-power').props('modelValue')).toBe(60)
    expect(wrapper.get('[data-testid="jammer-power-hint"]').text()).toContain('1000 W')
    expect(inputNumber(wrapper, 'jammer-eirpDbw').props('modelValue')).toBe(54)

    // 在 dBm 下输入 20 dBm（0.1 W）：自动换算 W 并联动 EIRP（20 - 30 + 25 - 1 = 14 dBW）
    inputNumber(wrapper, 'jammer-power').vm.$emit('update:modelValue', 20)
    await flushPromises()
    expect(inputNumber(wrapper, 'jammer-eirpDbw').props('modelValue')).toBe(14)

    // 切回 W 后显示 0.1 W
    unitSwitch.vm.$emit('update:modelValue', 'W')
    await flushPromises()
    expect(inputNumber(wrapper, 'jammer-power').props('modelValue')).toBe(0.1)

    await wrapper.get('[data-testid="apply-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ defaultPower: 0.1, eirpDbw: 14 })
    wrapper.unmount()
  } finally {
    setJammerPowerUnit('W')
  }
})

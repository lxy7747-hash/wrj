import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'
import type { CapabilityState, ValidationResult } from '../../src/contracts/domain-models'
import ValidationPanel from '../../src/components/scenarios/ValidationPanel.vue'
import PlatformEditorDialog from '../../src/components/scenarios/PlatformEditorDialog.vue'
import LinkSettingsPanel from '../../src/components/scenarios/LinkSettingsPanel.vue'
import LinkEditorDialog from '../../src/components/scenarios/LinkEditorDialog.vue'
import JammerEditorDialog from '../../src/components/scenarios/JammerEditorDialog.vue'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'
import type { Link, ScenarioConfig, ScenarioLinkSettings } from '../../src/contracts/domain-models'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { Platform } from '../../src/contracts/domain-models'

const emptyValidation: ValidationResult = { valid: true, errors: [], warnings: [] }

function mountValidationPanel(overrides: Partial<{
  pending: boolean
  panelState: CapabilityState
  resultMessage: string
  validation: ValidationResult
  completed: boolean
}> = {}) {
  return mount(ValidationPanel, {
    props: {
      pending: false,
      panelState: 'SUCCESS',
      resultMessage: '',
      validation: emptyValidation,
      completed: false,
      ...overrides,
    },
    global: { plugins: [ElementPlus] },
  })
}

describe('场景拆分面板', () => {
  it('干扰设备区分节点和方式，旧归属只提示不改绑，检测配置独立分组', async () => {
    const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
    config.platforms.push({ ...structuredClone(config.platforms.find(p => p.id === 'STN-01')!), id: 'AJ-001', name: '机载干扰平台', type: 'AIRBORNE_JAMMER_PLATFORM', category: 'air', jammerIds: [], sensorIds: [] })
    const jammer = { ...config.jammers[0]!, platformId: 'CMD-01' }
    const wrapper = mount(JammerEditorDialog, {
      props: { modelValue: true, jammer, uiExtension: { jammerId: jammer.id, direction: 0, duration: 60, enabled: true },
        editing: true, error: '', pending: false, locked: false, platforms: config.platforms,
        jammerTypeOptions: [{ value: 'BARRAGE', label: '宽带压制' }], minimumStep: 0.001 },
      global: { plugins: [ElementPlus], stubs: { ElDialog: { template: '<div><slot /><slot name="footer" /></div>' } } },
    })
    expect(wrapper.text()).toContain('所属干扰节点')
    expect(wrapper.text()).toContain('干扰方式')
    expect(wrapper.get('[data-testid="jammer-legacy-owner"]').text()).toContain('旧归属不是干扰节点')
    const owner = wrapper.findAllComponents({ name: 'ElSelect' }).find(c => c.attributes('data-testid') === 'jammer-platform')!
    expect(owner.props('modelValue')).toBe('CMD-01')
    expect(owner.findAllComponents({ name: 'ElOption' }).filter(c => !c.props('disabled')).map(c => c.props('value'))).toEqual(['STN-01', 'AJ-001'])
    expect(owner.findAllComponents({ name: 'ElOption' }).find(c => c.props('value') === 'CMD-01')!.props('disabled')).toBe(true)
    const detection = wrapper.get('[aria-labelledby="jammer-detection-title"]')
    expect(detection.find('[data-testid="jammer-auto-detect"]').exists()).toBe(true)
    expect(detection.find('[data-testid="jammer-range"]').exists()).toBe(true)
    await wrapper.get('[data-testid="cancel-jammer"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(jammer.platformId).toBe('CMD-01')
    wrapper.unmount()
  })

  it('优先级支持竖向拖拽与键盘排序，取消和运行锁不修改配置', async () => {
    const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
    config.platforms.push({ ...structuredClone(config.platforms.find(p => p.satelliteType === 'TIANTONG')!), id: 'SAT-ST', satelliteType: 'SHENTONG' })
    const baseline = readLinkSettings(config)
    const wrapper = mount(LinkSettingsPanel, {
      props: { modelValue: baseline, platforms: config.platforms, disabled: false, typeOptions: [
        { value: 'SAT', label: '卫星' }, { value: 'MICROWAVE', label: '微波' },
        { value: 'DATALINK', label: '数传' }, { value: 'LASER', label: '激光' },
      ] }, global: { plugins: [ElementPlus], stubs: { ElDialog: { props: ['modelValue'], template: '<section v-if="modelValue"><slot /><slot name="footer" /></section>' } } },
    })
    // 项目的通用 .vue 声明不携带 Props 类型，此处只声明本用例更新的 Props。
    const typedWrapper = wrapper as unknown as VueWrapper<{ $props: { modelValue?: ScenarioLinkSettings; disabled: boolean; dialogVisible?: boolean } }>
    expect(wrapper.find('[data-testid="link-switch-cooldown"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="link-type-enabled-MICROWAVE"]').exists()).toBe(false)
    expect(wrapper.findAllComponents({ name: 'ElSelect' })).toHaveLength(0)
    expect(wrapper.findAll('[data-testid^="link-priority-"]')).toHaveLength(0)
    await wrapper.get('[data-testid="open-link-settings"]').trigger('click')
    expect(wrapper.emitted('update:dialogVisible')!.at(-1)).toEqual([true])
    await typedWrapper.setProps({ dialogVisible: true })
    expect(wrapper.get('[data-testid="link-settings-dialog"]').findAll('[data-testid^="link-priority-"]')).toHaveLength(4)
    expect(wrapper.get('[data-testid="link-settings"]').findAll('[data-testid^="link-priority-"]')).toHaveLength(0)
    expect(wrapper.find('[aria-label="中继卫星选择"]').exists()).toBe(true)
    expect(baseline.enabledSatellites).toEqual({ TIANTONG: true, SHENTONG: false })
    expect(wrapper.get('[data-testid="link-settings-dialog"]').findAll('[data-testid^="link-type-enabled-"]')).toHaveLength(0)
    expect(wrapper.get('[data-testid="link-settings"]').findAll('[data-testid^="link-type-enabled-"]')).toHaveLength(0)
    const satelliteSelect = wrapper.findAllComponents({ name: 'ElSelect' }).find(c => c.attributes('data-testid') === 'link-relay-satellite')!
    expect(satelliteSelect.props('modelValue')).toBe('TIANTONG')
    expect(wrapper.findAllComponents({ name: 'ElSwitch' })).toHaveLength(0)
    satelliteSelect.vm.$emit('change', 'SHENTONG')
    let changed = wrapper.emitted('update:modelValue')!.at(-1)![0] as ScenarioLinkSettings
    expect(changed.enabledSatellites.TIANTONG).toBe(false)
    expect(baseline.enabledSatellites.TIANTONG).toBe(true)
    await typedWrapper.setProps({ modelValue: changed })
    expect(changed.enabledSatellites).toEqual({ TIANTONG: false, SHENTONG: true })
    expect(satelliteSelect.props('modelValue')).toBe('SHENTONG')
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' })[0]!.props('modelValue')).toBe(5)
    await wrapper.get('[data-testid="close-link-settings"]').trigger('click')
    expect(wrapper.emitted('update:dialogVisible')!.at(-1)).toEqual([false])
    await typedWrapper.setProps({ dialogVisible: false })
    expect(wrapper.find('[data-testid="link-switch-cooldown"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="link-priority-0"]').exists()).toBe(false)
    await wrapper.get('[data-testid="open-link-settings"]').trigger('click')
    await typedWrapper.setProps({ dialogVisible: true })
    const originalPriority = [...baseline.priority]
    const priorityItem = (index: number) => wrapper.get(`[data-testid="link-priority-${index}"]`)
    const priorityRow = (index: number) => wrapper.get('.link-settings__priority').findAll('li')[index]!
    const beforeDrag = wrapper.emitted('update:modelValue')!.length
    await priorityItem(2).trigger('dragstart')
    await priorityRow(0).trigger('dragover')
    expect(priorityRow(0).classes()).toContain('is-drop-target')
    expect(wrapper.emitted('update:modelValue')).toHaveLength(beforeDrag)
    await priorityRow(0).trigger('drop')
    changed = wrapper.emitted('update:modelValue')!.at(-1)![0] as ScenarioLinkSettings
    expect(changed.priority).toEqual(['SAT', 'DATALINK', 'MICROWAVE', 'LASER'])
    expect(changed.enabledSatellites.TIANTONG).toBe(false)
    expect(baseline.priority).toEqual(originalPriority)
    await typedWrapper.setProps({ modelValue: changed })
    expect(priorityItem(0).text()).toContain('卫星')
    await priorityItem(0).trigger('dragstart')
    await priorityRow(3).trigger('drop')
    changed = wrapper.emitted('update:modelValue')!.at(-1)![0] as ScenarioLinkSettings
    expect(changed.priority).toEqual(['DATALINK', 'MICROWAVE', 'LASER', 'SAT'])
    await typedWrapper.setProps({ modelValue: changed })
    await priorityItem(3).trigger('keydown', { key: 'ArrowUp' })
    changed = wrapper.emitted('update:modelValue')!.at(-1)![0] as ScenarioLinkSettings
    expect(changed.priority).toEqual(['DATALINK', 'MICROWAVE', 'SAT', 'LASER'])
    await typedWrapper.setProps({ modelValue: changed })
    const beforeCancel = wrapper.emitted('update:modelValue')!.length
    await priorityItem(0).trigger('keydown', { key: 'ArrowUp' })
    await priorityItem(3).trigger('keydown', { key: 'ArrowDown' })
    await priorityItem(0).trigger('dragstart')
    await priorityItem(0).trigger('dragend')
    await priorityRow(3).trigger('drop')
    expect(wrapper.emitted('update:modelValue')).toHaveLength(beforeCancel)
    expect(wrapper.find('.is-dragging').exists()).toBe(false)
    await priorityItem(0).trigger('dragstart')
    await typedWrapper.setProps({ disabled: true, dialogVisible: true })
    const count = wrapper.emitted('update:modelValue')!.length
    wrapper.findAllComponents({ name: 'ElSelect' }).find(c => c.attributes('data-testid') === 'link-relay-satellite')!.vm.$emit('change', 'TIANTONG')
    await priorityRow(3).trigger('drop')
    expect(priorityItem(0).attributes('draggable')).toBe('false')
    expect(priorityItem(0).attributes('disabled')).toBeDefined()
    wrapper.findAllComponents({ name: 'ElInputNumber' })[0]!.vm.$emit('update:modelValue', 20)
    expect(wrapper.emitted('update:modelValue')).toHaveLength(count)
    expect(config.linkSettings).toBeUndefined()
    wrapper.unmount()
  })

  it.each([false, true])('新增/编辑链路弹框仅包含当前链路开关并仅确认时提交（编辑=%s）', async (editing) => {
    const link = structuredClone(fixtureSource.scenario.links.find(l => l.type === 'SAT')) as Link
    if (editing) link.relayPlatformId = 'SAT-01'
    const wrapper = mount(LinkEditorDialog, {
      props: { modelValue: true, link, editing, error: '', pending: false, locked: false,
        platforms: fixtureSource.scenario.platforms as Platform[], linkTypeOptions: [
          { value: 'SAT', label: '卫星' }, { value: 'MICROWAVE', label: '微波' },
          { value: 'DATALINK', label: '数传' }, { value: 'LASER', label: '激光' },
        ],
        linkDirectionLabels: { FORWARD: '前向', REVERSE: '返向' }, minimumStep: 0.001 },
      global: { plugins: [ElementPlus], stubs: { ElDialog: { template: '<section><slot /><slot name="footer" /></section>' } } },
    })
    expect(wrapper.findAll('[data-testid^="link-type-enabled-"]')).toHaveLength(0)
    expect(wrapper.findAllComponents({ name: 'ElSwitch' })).toHaveLength(1)
    expect(wrapper.findComponent({ name: 'ElSwitch' }).props('modelValue')).toBe(true)
    await wrapper.get('[data-testid="link-enabled"]').trigger('click')
    expect(link.enabled).toBeUndefined()
    expect(wrapper.emitted('apply')).toBeUndefined()
    for (const [id, value] of [['link-gain-correction', -2], ['link-anti-jamming-gain', 10], ['link-spatial-isolation', 3]] as const) {
      wrapper.findAllComponents({ name: 'ElInputNumber' }).find(c => c.attributes('data-testid') === id)!.vm.$emit('update:modelValue', value)
    }
    wrapper.findAllComponents({ name: 'ElSelect' }).find(c => c.attributes('data-testid') === 'link-coding')!.vm.$emit('update:modelValue', 'UNCODED')
    expect(wrapper.find('[data-testid="link-relay"]').exists()).toBe(false)
    await flushPromises()
    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ antennaGainCorrectionDb: -2, antiJammingGainDb: 10, spatialIsolationDb: 3, coding: 'UNCODED' })
    if (editing) expect(wrapper.emitted('apply')![0]![0]).toHaveProperty('relayPlatformId', 'SAT-01')
    else expect(wrapper.emitted('apply')![0]![0]).not.toHaveProperty('relayPlatformId')
    expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ enabled: false })
    expect(link).not.toHaveProperty('coding')
    const coding = wrapper.findAllComponents({ name: 'ElSelect' }).find(c => c.attributes('data-testid') === 'link-coding')!
    for (const empty of [undefined, null]) {
      coding.vm.$emit('update:modelValue', 'UNCODED')
      coding.vm.$emit('update:modelValue', empty)
      await flushPromises()
      await wrapper.get('[data-testid="apply-link"]').trigger('click')
      expect(wrapper.emitted('apply')!.at(-1)![0]).toHaveProperty('coding', null)
    }
    const type = wrapper.findAllComponents({ name: 'ElSelect' }).find(c => c.attributes('data-testid') === 'link-type')!
    type.vm.$emit('update:modelValue', 'MICROWAVE')
    type.vm.$emit('change', 'MICROWAVE')
    await flushPromises()
    expect(wrapper.find('[data-testid="link-relay"]').exists()).toBe(false)
    await wrapper.get('[data-testid="apply-link"]').trigger('click')
    if (editing) {
      expect(wrapper.emitted('apply')!.at(-1)![0]).toHaveProperty('relayPlatformId', null)
      expect(link.relayPlatformId).toBe('SAT-01')
    } else expect(wrapper.emitted('apply')!.at(-1)![0]).not.toHaveProperty('relayPlatformId')
    wrapper.unmount()
  })

  it.each([[false, 47], [false, 46], [true, 47]] as const)('数量额度：编辑=%s，已有=%s', async (editing, count) => {
    const wrapper = mount(PlatformEditorDialog, {
      props: {
        modelValue: true, platform: structuredClone(fixtureSource.scenario.platforms[3]) as Platform,
        editing, error: '', pending: false, locked: false,
        businessTypeOptions: [{ value: 'AIRBORNE_MISSION_CLUSTER', label: '空中无人作业集群' }],
        supportingTypeOptions: [{ value: 'COMMUNICATION_SATELLITE', label: '通信卫星' }],
        satelliteTypeOptions: [{ value: 'TIANTONG', label: '天通卫星' }, { value: 'SHENTONG', label: '神通卫星' }],
        businessTypeCounts: { REAR_COMMAND_NODE: 1, FORWARD_RELAY_NODE: 1, GROUND_CLUSTER_COMMAND_NODE: 1, AIRBORNE_MISSION_CLUSTER: count },
        businessTypeLimits: { REAR_COMMAND_NODE: 1, FORWARD_RELAY_NODE: 1, GROUND_CLUSTER_COMMAND_NODE: 1, AIRBORNE_MISSION_CLUSTER: 47 },
        deploymentDomainLabels: { ground: '地面', air: '空中', space: '空间' },
      },
      global: { plugins: [ElementPlus], stubs: { ElDialog: { props: ['modelValue'], template: '<section v-if="modelValue"><slot /><slot name="footer" /></section>' } } },
    })
    await flushPromises()
    const number = wrapper.findAllComponents({ name: 'ElInputNumber' }).find((item) => item.attributes('data-testid') === 'platform-quantity')
    expect(wrapper.get('#platform-position-title').text()).toBe('编队原点')
    expect(wrapper.get('[data-testid="formation-origin-hint"]').text()).toBe('此处仅设置整个集群的编队原点，不单独配置各成员位置。')
    for (const field of ['longitude', 'latitude', 'altitude']) {
      expect(wrapper.find(`[data-testid="platform-${field}"]`).exists()).toBe(true)
    }
    const disabled = !editing && count === 47
    if (editing) expect(number).toBeUndefined()
    else {
      expect(number!.props('max')).toBe(47 - count)
      expect(number!.props('disabled')).toBe(disabled)
    }
    expect(wrapper.get('[data-testid="apply-platform"]').attributes('disabled') !== undefined).toBe(disabled)
    expect(wrapper.findAllComponents({ name: 'ElOptionGroup' }).map((group) => group.props('label'))).toEqual(['信息节点', '支撑实体（不计入50个信息节点）'])
    await wrapper.get('[data-testid="apply-platform"]').trigger('click')
    expect(wrapper.emitted('apply')?.length ?? 0).toBe(disabled ? 0 : 1)
    wrapper.unmount()
  })

  it('后方指挥与干扰节点初始位置按类型限制范围，边界可确认', async () => {
    const platform = structuredClone(fixtureSource.scenario.platforms[0]) as Platform
    platform.waypoints = [{ ...platform.initialPosition, speed: 0, arrivalTime: 1 }]
    const originalPosition = { ...platform.initialPosition }
    const wrapper = mount(PlatformEditorDialog, {
      props: {
        modelValue: true, platform, editing: true, error: '', pending: false, locked: false,
        businessTypeOptions: [{ value: 'REAR_COMMAND_NODE', label: '后方指挥节点' }, { value: 'AIRBORNE_MISSION_CLUSTER', label: '空中无人作业集群' }],
        supportingTypeOptions: [], satelliteTypeOptions: [],
        businessTypeCounts: { REAR_COMMAND_NODE: 1, FORWARD_RELAY_NODE: 1, GROUND_CLUSTER_COMMAND_NODE: 1, AIRBORNE_MISSION_CLUSTER: 3 },
        businessTypeLimits: { REAR_COMMAND_NODE: 1, FORWARD_RELAY_NODE: 1, GROUND_CLUSTER_COMMAND_NODE: 1, AIRBORNE_MISSION_CLUSTER: 47 },
        deploymentDomainLabels: { ground: '地面', air: '空中', space: '天基' },
      },
      global: { plugins: [ElementPlus], stubs: { ElDialog: { template: '<section><slot /><slot name="footer" /></section>' } } },
    })
    const longitude = wrapper.get('[data-testid="platform-longitude"] input')
    const latitude = wrapper.get('[data-testid="platform-latitude"] input')
    expect(wrapper.get('#platform-position-title').text()).toBe('初始位置')
    expect(wrapper.find('[data-testid="formation-origin-hint"]').exists()).toBe(false)
    expect(wrapper.find('#platform-waypoint-title').exists()).toBe(false)
    expect(wrapper.find('[data-testid="add-waypoint"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'WaypointMapPicker' }).exists()).toBe(false)
    expect(longitude.attributes()).toMatchObject({ min: '118.5', max: '120' })
    expect(latitude.attributes()).toMatchObject({ min: '24', max: '25' })
    for (const [lng, lat, expectedLng, expectedLat] of [
      [118, 23.9, 118.5, 24], [120.1, 25.1, 120, 25],
      [118.5, 24, 118.5, 24], [120, 25, 120, 25], [119.25, 24.5, 119.25, 24.5],
    ]) {
      await longitude.setValue(String(lng))
      await latitude.setValue(String(lat))
      await wrapper.get('[data-testid="apply-platform"]').trigger('click')
      expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ initialPosition: { longitude: expectedLng, latitude: expectedLat } })
      expect(wrapper.emitted('apply')!.at(-1)![0]).toHaveProperty('waypoints', [])
    }
    const type = wrapper.findAllComponents({ name: 'ElSelect' }).find(c => c.attributes('data-testid') === 'platform-type')!
    type.vm.$emit('update:modelValue', 'AIRBORNE_MISSION_CLUSTER')
    type.vm.$emit('change', 'AIRBORNE_MISSION_CLUSTER')
    await flushPromises()
    expect(longitude.attributes()).toMatchObject({ min: '117', max: '122' })
    expect(latitude.attributes()).toMatchObject({ min: '21', max: '26' })
    for (const [lng, lat, expectedLng, expectedLat] of [
      [116.9, 20.9, 117, 21], [122.1, 26.1, 122, 26],
      [117, 21, 117, 21], [122, 26, 122, 26], [119.5, 24, 119.5, 24],
    ]) {
      await longitude.setValue(String(lng))
      await latitude.setValue(String(lat))
      await wrapper.get('[data-testid="apply-platform"]').trigger('click')
      expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ initialPosition: { longitude: expectedLng, latitude: expectedLat } })
    }
    expect(wrapper.get('#platform-position-title').text()).toBe('编队原点')
    expect(wrapper.find('[data-testid="formation-origin-hint"]').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'WaypointMapPicker' }).props('bounds')).toEqual({ minLongitude: 117, maxLongitude: 122, minLatitude: 21, maxLatitude: 26 })
    expect(wrapper.find('#platform-waypoint-title').exists()).toBe(true)
    await wrapper.get('[data-testid="add-waypoint"]').trigger('click')
    const waypointLongitude = wrapper.get('[data-testid="waypoint-longitude-0"] input')
    const waypointLatitude = wrapper.get('[data-testid="waypoint-latitude-0"] input')
    expect(waypointLongitude.attributes()).toMatchObject({ min: '117', max: '122' })
    expect(waypointLatitude.attributes()).toMatchObject({ min: '21', max: '26' })
    for (const [lng, lat, expectedLng, expectedLat] of [
      [116, 25, 117, 25], [122.1, 26.1, 122, 26], [117, 21, 117, 21], [122, 26, 122, 26],
    ]) {
      await waypointLongitude.setValue(String(lng))
      await waypointLatitude.setValue(String(lat))
      await wrapper.get('[data-testid="apply-platform"]').trigger('click')
      expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ waypoints: [{ longitude: expectedLng, latitude: expectedLat }] })
    }
    expect(platform.initialPosition).toEqual(originalPosition)
    expect(platform.waypoints).toHaveLength(1)
    type.vm.$emit('update:modelValue', 'GROUND_JAMMER_DETECTION_STATION')
    type.vm.$emit('change', 'GROUND_JAMMER_DETECTION_STATION')
    await flushPromises()
    expect(longitude.attributes()).toMatchObject({ min: '121.2', max: '121.8' })
    expect(latitude.attributes()).toMatchObject({ min: '24.8', max: '25.4' })
    expect(wrapper.findComponent({ name: 'WaypointMapPicker' }).props('bounds')).toBeUndefined()
    expect(waypointLongitude.attributes()).toMatchObject({ min: '-180', max: '180' })
    expect(waypointLatitude.attributes()).toMatchObject({ min: '-90', max: '90' })
    expect(longitude.attributes('disabled')).toBeUndefined()
    expect(latitude.attributes('disabled')).toBeUndefined()
    for (const [lng, lat, expectedLng, expectedLat] of [
      [121.1, 24.7, 121.2, 24.8], [121.9, 25.5, 121.8, 25.4],
      [121.2, 24.8, 121.2, 24.8], [121.8, 25.4, 121.8, 25.4], [121.5, 25.1, 121.5, 25.1],
    ]) {
      await longitude.setValue(String(lng))
      await latitude.setValue(String(lat))
      await wrapper.get('[data-testid="apply-platform"]').trigger('click')
      expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({
        type: 'GROUND_JAMMER_DETECTION_STATION',
        initialPosition: { longitude: expectedLng, latitude: expectedLat, altitude: originalPosition.altitude },
      })
    }
    expect(platform.initialPosition).toEqual(originalPosition)
    type.vm.$emit('update:modelValue', 'AIRBORNE_MISSION_CLUSTER')
    type.vm.$emit('change', 'AIRBORNE_MISSION_CLUSTER')
    await flushPromises()
    expect(longitude.attributes()).toMatchObject({ min: '117', max: '122' })
    expect(latitude.attributes()).toMatchObject({ min: '21', max: '26' })
    wrapper.unmount()
  })

  it.each([[24.7, 25.3], [25.3, 25.3], [25.5, 25.5], [25.7, 25.7], [26, 25.7], [NaN, 25.3]])('高空中继初始位置只读，纬度 %s 收敛为 %s', async (latitude, expectedLatitude) => {
    const platform = structuredClone(fixtureSource.scenario.platforms[1]) as Platform
    platform.initialPosition.latitude = latitude
    const originalPosition = { ...platform.initialPosition }
    const wrapper = mount(PlatformEditorDialog, {
      props: {
        modelValue: true, platform, editing: true, error: '', pending: false, locked: false,
        businessTypeOptions: [{ value: 'FORWARD_RELAY_NODE', label: '高空前出中继节点' }, { value: 'AIRBORNE_MISSION_CLUSTER', label: '空中无人作业集群' }],
        supportingTypeOptions: [], satelliteTypeOptions: [],
        businessTypeCounts: { REAR_COMMAND_NODE: 1, FORWARD_RELAY_NODE: 1, GROUND_CLUSTER_COMMAND_NODE: 1, AIRBORNE_MISSION_CLUSTER: 3 },
        businessTypeLimits: { REAR_COMMAND_NODE: 1, FORWARD_RELAY_NODE: 1, GROUND_CLUSTER_COMMAND_NODE: 1, AIRBORNE_MISSION_CLUSTER: 47 },
        deploymentDomainLabels: { ground: '地面', air: '空中', space: '天基' },
      },
      global: { plugins: [ElementPlus], stubs: { ElDialog: { template: '<section><slot /><slot name="footer" /></section>' } } },
    })
    await flushPromises()
    for (const [field, expected] of [['longitude', 120.8], ['latitude', expectedLatitude], ['altitude', 8000]] as const) {
      const input = wrapper.get(`[data-testid="platform-${field}"] input`)
      expect(input.attributes('disabled')).toBeDefined()
      expect(Number((input.element as HTMLInputElement).value)).toBe(expected)
    }
    expect(wrapper.get('[data-testid="platform-latitude"] input').attributes()).toMatchObject({ min: '25.3', max: '25.7' })
    expect(wrapper.get('#platform-position-title').text()).toBe('初始位置')
    expect(wrapper.find('[data-testid="formation-origin-hint"]').exists()).toBe(false)
    expect(wrapper.find('#platform-waypoint-title').exists()).toBe(false)
    expect(wrapper.find('[data-testid="add-waypoint"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'WaypointMapPicker' }).exists()).toBe(false)
    expect(platform.initialPosition).toEqual(originalPosition)
    await wrapper.get('[data-testid="apply-platform"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ initialPosition: { longitude: 120.8, latitude: expectedLatitude, altitude: 8000 } })
    expect(wrapper.emitted('apply')!.at(-1)![0]).toHaveProperty('waypoints', [])
    expect(platform.waypoints).toEqual(fixtureSource.scenario.platforms[1]!.waypoints)
    const type = wrapper.findAllComponents({ name: 'ElSelect' }).find(c => c.attributes('data-testid') === 'platform-type')!
    type.vm.$emit('update:modelValue', 'AIRBORNE_MISSION_CLUSTER')
    type.vm.$emit('change', 'AIRBORNE_MISSION_CLUSTER')
    await flushPromises()
    for (const field of ['longitude', 'latitude', 'altitude']) {
      expect(wrapper.get(`[data-testid="platform-${field}"] input`).attributes('disabled')).toBeUndefined()
    }
    expect(wrapper.find('#platform-waypoint-title').exists()).toBe(true)
    await wrapper.get('[data-testid="add-waypoint"]').trigger('click')
    expect(wrapper.find('[data-testid="waypoint-longitude-0"]').exists()).toBe(true)
    await wrapper.get('[data-testid="platform-altitude"] input').setValue('1000')
    type.vm.$emit('update:modelValue', 'FORWARD_RELAY_NODE')
    type.vm.$emit('change', 'FORWARD_RELAY_NODE')
    await flushPromises()
    expect(wrapper.get('[data-testid="platform-altitude"] input').attributes('disabled')).toBeDefined()
    expect(wrapper.get('#platform-position-title').text()).toBe('初始位置')
    expect(wrapper.find('[data-testid="formation-origin-hint"]').exists()).toBe(false)
    expect(wrapper.find('#platform-waypoint-title').exists()).toBe(false)
    await wrapper.get('[data-testid="apply-platform"]').trigger('click')
    expect(wrapper.emitted('apply')!.at(-1)![0]).toMatchObject({ initialPosition: { longitude: 120.8, latitude: expectedLatitude, altitude: 8000 } })
    expect(wrapper.emitted('apply')!.at(-1)![0]).toHaveProperty('waypoints', [])
    wrapper.unmount()
  })

  it('覆盖整体校验的等待、请求失败、空态和成功态', () => {
    const pending = mountValidationPanel({ pending: true })
    expect(pending.text()).toContain('正在校验当前完整场景')
    pending.unmount()

    const failed = mountValidationPanel({ panelState: 'ERROR', resultMessage: '校验服务不可用。' })
    expect(failed.get('[data-testid="validation-request-error"]').text()).toContain('校验服务不可用')
    failed.unmount()

    const empty = mountValidationPanel()
    expect(empty.text()).toContain('点击“保存”时会自动检查配置')
    empty.unmount()

    const success = mountValidationPanel({ completed: true })
    expect(success.text()).toContain('配置检查通过')
    success.unmount()
  })

  it('展示错误和警告并向父级发送定位问题', async () => {
    const warning = {
      severity: 'WARNING' as const,
      code: 'RAIN_LOSS_DEFAULT',
      message: '雨衰参数需要确认。',
      fieldPath: 'scenario.environment.rainLossDbPerKm',
    }
    const wrapper = mountValidationPanel({
      completed: true,
      resultMessage: '发现 1 个警告。',
      validation: { valid: true, errors: [], warnings: [warning] },
    })
    expect(wrapper.text()).toContain('警告不阻断保存')
    await wrapper.get('[data-testid="locate-validation-issue-0"]').trigger('click')
    expect(wrapper.emitted('locate')).toEqual([[warning]])
    wrapper.unmount()

    const error = mountValidationPanel({
      completed: true,
      resultMessage: '发现 1 个错误。',
      validation: {
        valid: false,
        errors: [{ ...warning, severity: 'ERROR', code: 'INVALID_TIME_STEP' }],
        warnings: [],
      },
    })
    expect(error.text()).toContain('错误')
    expect(error.text()).not.toContain('警告不阻断保存')
    error.unmount()
  })
})

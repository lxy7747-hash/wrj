import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it, vi } from 'vitest'
import type { Platform, PlatformType, TemplateRoutePoint, ValidationIssue } from '../../src/contracts/domain-models'
import PlatformEditorDialog from '../../src/components/scenarios/PlatformEditorDialog.vue'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import { createTemplateScenario } from '../fixtures/template-scenario'
import { RELAY_DEFAULT_ORIGIN, RELAY_DEFAULT_ROUTE } from '../../src/features/scenarios/platform-position-rules'

const TYPE_OPTIONS = [
  { value: 'REAR_COMMAND_NODE', label: '后方指挥节点' },
  { value: 'FORWARD_RELAY_NODE', label: '高空前出中继节点' },
  { value: 'AIRBORNE_MISSION_CLUSTER', label: '空中无人作业集群' },
] as const

function airPlatform(): Platform {
  // AIR-02：空中无人作业集群，无普通航点。
  return structuredClone(fixtureSource.scenario.platforms[4]) as Platform
}

function mountEditor(platform: Platform, options: { editing?: boolean, validate?: (platform: Platform) => ValidationIssue[] } = {}) {
  return mount(PlatformEditorDialog, {
    props: {
      modelValue: true, platform, editing: options.editing ?? true, error: '', pending: false, locked: false,
      validate: options.validate,
      businessTypeOptions: TYPE_OPTIONS,
      supportingTypeOptions: [
        { value: 'GROUND_JAMMER_DETECTION_STATION', label: '地面干扰设备' },
        { value: 'AIRBORNE_JAMMER_PLATFORM', label: '机载干扰设备' },
      ],
      satelliteTypeOptions: [],
      businessTypeCounts: { REAR_COMMAND_NODE: 1, FORWARD_RELAY_NODE: 1, GROUND_CLUSTER_COMMAND_NODE: 1, AIRBORNE_MISSION_CLUSTER: 3 },
      businessTypeLimits: { REAR_COMMAND_NODE: 1, FORWARD_RELAY_NODE: 2, GROUND_CLUSTER_COMMAND_NODE: 1, AIRBORNE_MISSION_CLUSTER: 47 },
      deploymentDomainLabels: { ground: '地面', air: '空中', space: '空间' },
    },
    global: {
      plugins: [ElementPlus],
      stubs: { ElDialog: { template: '<section><slot /><slot name="footer" /></section>' } },
    },
  })
}

type Wrapper = ReturnType<typeof mountEditor>

const mapPoint = { longitude: 120.1, latitude: 23.95, altitude: 3300, speed: 1 }

async function addMapPoints(wrapper: Wrapper, route: 'waypoint' | 'loiter-waypoint', points: TemplateRoutePoint[]) {
  await wrapper.get(`[data-testid="add-${route}"]`).trigger('click')
  const picker = wrapper.getComponent({ name: 'WaypointMapPicker' })
  expect(picker.props('modelValue')).toBe(true)
  expect(picker.props('route')).toMatchObject({ loiter: route === 'loiter-waypoint' })
  picker.vm.$emit('confirm-route', points.map(point => ({ ...point })))
  await flushPromises()
}

async function setNumber(wrapper: Wrapper, testId: string, value: number): Promise<void> {
  await wrapper.get(`[data-testid="${testId}"] input`).setValue(String(value))
}

async function changeType(wrapper: Wrapper, type: PlatformType): Promise<void> {
  const select = wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'platform-type')!
  select.vm.$emit('update:modelValue', type)
  select.vm.$emit('change', type)
  await flushPromises()
}

async function applied(wrapper: Wrapper): Promise<Platform> {
  await wrapper.get('[data-testid="apply-platform"]').trigger('click')
  const emitted = wrapper.emitted('apply')
  expect(emitted).toBeDefined()
  return emitted!.at(-1)![0] as Platform
}

describe('PlatformEditorDialog 盘旋航点与返航', () => {
  it('地图新增航点沿用点值，返航新增默认 200 m/s，输入下限为 1，后续新增不沿用已修改的速度', async () => {
    const platform = airPlatform()
    const wrapper = mountEditor(platform)
    await addMapPoints(wrapper, 'waypoint', [mapPoint])
    expect(wrapper.get('[data-testid="waypoint-speed-0"] input').element).toHaveProperty('value', '1')
    await setNumber(wrapper, 'waypoint-speed-0', 20)
    await addMapPoints(wrapper, 'waypoint', [{ ...mapPoint, longitude: 120.15 }])
    await wrapper.get('[data-testid="loiter-enabled"]').trigger('click')
    await flushPromises()
    await addMapPoints(wrapper, 'loiter-waypoint', [{ ...mapPoint }])
    const appendedLoiterIndex = 8
    expect(wrapper.get(`[data-testid="loiter-speed-${appendedLoiterIndex}"] input`).element).toHaveProperty('value', '1')
    await setNumber(wrapper, 'loiter-speed-0', 50)
    await wrapper.get('[data-testid="return-enabled"]').trigger('click')
    await setNumber(wrapper, 'return-time', 600)
    await wrapper.get('[data-testid="add-return-waypoint"]').trigger('click')
    expect(wrapper.get('[data-testid="return-speed-0"] input').element).toHaveProperty('value', '200')
    await setNumber(wrapper, 'return-speed-0', 60)
    await wrapper.get('[data-testid="add-return-waypoint"]').trigger('click')

    const checks = [
      { testId: 'waypoint-speed-1', expected: 1 },
      { testId: `loiter-speed-${appendedLoiterIndex}`, expected: 1 },
      { testId: 'return-speed-1', expected: 200 },
    ] as const
    for (const { testId, expected } of checks) {
      const speed = wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === testId)!
      expect(speed.props('modelValue')).toBe(expected)
      expect(speed.props('min')).toBe(1)
      await setNumber(wrapper, testId, 0.5)
      await wrapper.get(`[data-testid="${testId}"] input`).trigger('blur')
      expect(speed.props('modelValue')).toBe(1)
    }
    const result = await applied(wrapper)
    expect(result.waypoints.map(point => point.speed)).toEqual([20, 1])
    expect(result.loiterWaypoints![0]!.speed).toBe(50)
    expect(result.loiterWaypoints!.at(-1)!.speed).toBe(1)
    expect(result.returnPlan!.waypoints.map(point => point.speed)).toEqual([60, 1])
    expect(platform.waypoints).toEqual([])
    expect(platform.loiterWaypoints).toBeUndefined()
    expect(platform.returnPlan).toBeUndefined()
    wrapper.unmount()
  })

  it('盘旋航点可开启生成、微调编辑、排序、删除并写回模型，删空后移除字段', async () => {
    const platform = airPlatform()
    const wrapper = mountEditor(platform)
    expect(wrapper.get('#platform-loiter-title').text()).toBe('盘旋配置（0）')
    expect(wrapper.text()).toContain('圆周盘旋航点')

    await wrapper.get('[data-testid="loiter-enabled"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('#platform-loiter-title').text()).toBe('盘旋配置（8）')
    await setNumber(wrapper, 'loiter-longitude-0', 120.1)
    await setNumber(wrapper, 'loiter-speed-0', 50)
    await setNumber(wrapper, 'loiter-longitude-1', 120.2)
    await setNumber(wrapper, 'loiter-speed-1', 60)
    expect(wrapper.get('[data-testid="move-up-loiter-0"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="move-down-loiter-7"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="move-down-loiter-0"]').trigger('click')
    let result = await applied(wrapper)
    expect(result.loiterWaypoints!.slice(0, 2).map(point => ({ longitude: point.longitude, speed: point.speed }))).toEqual([
      { longitude: 120.2, speed: 60 },
      { longitude: 120.1, speed: 50 },
    ])
    await wrapper.get('[data-testid="move-up-loiter-1"]').trigger('click')
    result = await applied(wrapper)
    expect(result.loiterWaypoints!.slice(0, 2).map(point => point.longitude)).toEqual([120.1, 120.2])

    for (let i = 0; i < 8; i += 1) {
      await wrapper.get('[data-testid="delete-loiter-0"]').trigger('click')
    }
    await flushPromises()
    result = await applied(wrapper)
    expect(Object.hasOwn(result, 'loiterWaypoints')).toBe(false)
    // 编辑副本不影响传入对象。
    expect(Object.hasOwn(platform, 'loiterWaypoints')).toBe(false)
    wrapper.unmount()
  })

  it('盘旋航点可逐点微调经纬度，保留高度和速度', async () => {
    const platform = airPlatform()
    platform.loiterWaypoints = [
      { longitude: 120, latitude: 24, altitude: 3000, speed: 50 },
      { longitude: 120.3, latitude: 24.2, altitude: 3100, speed: 55 },
    ]
    const wrapper = mountEditor(platform)
    await flushPromises()
    await wrapper.get('[data-testid="pick-loiter-1"]').trigger('click')
    const picker = wrapper.getComponent({ name: 'WaypointMapPicker' })
    expect(picker.props()).toMatchObject({ modelValue: true, longitude: 120.3, latitude: 24.2 })
    expect(picker.props('bounds')).toBeUndefined()
    picker.vm.$emit('confirm', { longitude: 121.5, latitude: 25.25 })
    await flushPromises()
    expect(picker.props('modelValue')).toBe(false)
    const result = await applied(wrapper)
    expect(result.loiterWaypoints![1]).toEqual({ ...platform.loiterWaypoints[1], longitude: 121.5, latitude: 25.25 })
    expect(result.loiterWaypoints![0]).toEqual(platform.loiterWaypoints[0])
    wrapper.unmount()
  })

  it('地图仅拖动已有盘旋点也能确认，保留点数、顺序及原有高度和速度', async () => {
    const platform = airPlatform()
    platform.loiterWaypoints = [{ ...mapPoint, altitude: 3000, speed: 25 }, { ...mapPoint, longitude: 120.3, altitude: 3500, speed: 30 }]
    const wrapper = mountEditor(platform)
    await wrapper.get('[data-testid="add-loiter-waypoint"]').trigger('click')
    const picker = wrapper.getComponent({ name: 'WaypointMapPicker' })
    const moved = { longitude: 120.5, latitude: 24 }
    picker.vm.$emit('confirm-route', [], new Map([[1, moved]]))
    await flushPromises()

    expect(picker.props('modelValue')).toBe(false)
    expect((await applied(wrapper)).loiterWaypoints).toEqual([
      platform.loiterWaypoints[0], { ...platform.loiterWaypoints[1], ...moved },
    ])
    expect(platform.loiterWaypoints[1]!.longitude).toBe(120.3)
    wrapper.unmount()
  })

  it('新增时选择中继预填起飞点、中继点和盘旋点，生成的路线按模板顺序排列', async () => {
    const draft = createTemplateScenario()
    const index = draft.config.platforms.findIndex(platform => platform.type === 'FORWARD_RELAY_NODE')
    const platform = structuredClone(draft.config.platforms[index]!)
    platform.type = 'AIRBORNE_MISSION_CLUSTER'
    platform.waypoints = []
    delete platform.loiterWaypoints
    delete platform.returnPlan
    const original = structuredClone(platform)
    const wrapper = mountEditor(platform, { editing: false })
    await changeType(wrapper, 'FORWARD_RELAY_NODE')
    const result = await applied(wrapper)
    expect(result.initialPosition).toEqual(RELAY_DEFAULT_ORIGIN)
    expect(result.waypoints).toEqual(RELAY_DEFAULT_ROUTE.waypoints)
    expect(result.loiterWaypoints).toEqual(RELAY_DEFAULT_ROUTE.loiterWaypoints)
    expect(result.waypoints[0]!.speed).toBeCloseTo(200 * 1852 / 3600)
    expect(result.loiterWaypoints!.map(point => point.speed)).toEqual([150, 150, 150].map(knots => knots * (1852 / 3600)))
    expect(result.returnPlan).toBeUndefined()
    expect(platform).toEqual(original)
    draft.config.platforms[index] = result
    const { buildMissionPackage } = await import('../../server/scripts/' + 'mission-generator')
    const baseline = buildMissionPackage(createTemplateScenario()).files['comm_platform_INS.txt']!
    const script = buildMissionPackage(draft).files['comm_platform_INS.txt']!
    // 1112 固定模板：编辑平台航线不改写 INS，实例与航线保持模板原文。
    expect(script).toBe(baseline)
    const route = script.split('platform mission_uav_01 MISSION_UAV_PLATFORM')[1]!.split('end_platform')[0]!
    const steps = ['position 24.66n 119.55e altitude 3200 m speed 102.8888888888889 m/s', 'position 25n 120.8e altitude 8000 m speed 102.8888888888889 m/s',
      'label LOITER', 'position 25.02n 120.82e altitude 8000 m speed 77.16666666666667 m/s', 'position 25.04n 120.8e altitude 8000 m speed 77.16666666666667 m/s',
      'position 25.02n 120.78e altitude 8000 m speed 77.16666666666667 m/s', 'goto LOITER']
    let previous = -1
    for (const step of steps) {
      const position = route.indexOf(step)
      expect(position, step).toBeGreaterThan(previous)
      previous = position
    }
    expect(route.match(/^\s*position /gm)).toHaveLength(5)
    expect(route).not.toContain('FollowRoute')
    wrapper.unmount()
  })

  it.each([false, true])('已有航点切到中继不覆盖，已有盘旋点=%s 时只补缺省内容', async (hasLoiter) => {
    const platform = airPlatform()
    platform.waypoints = [{ longitude: 120.5, latitude: 24.5, altitude: 3000, speed: 60, arrivalTime: 0 }]
    if (hasLoiter) platform.loiterWaypoints = [
      { longitude: 120, latitude: 24, altitude: 3000, speed: 50 },
      { longitude: 120.3, latitude: 24.2, altitude: 3100, speed: 55 },
    ]
    platform.returnPlan = { timeS: 600, waypoints: [{ longitude: 118, latitude: 24, altitude: 1000, speed: 60 }] }
    const original = structuredClone(platform)
    const wrapper = mountEditor(platform, { editing: false })
    await changeType(wrapper, 'FORWARD_RELAY_NODE')
    await changeType(wrapper, 'REAR_COMMAND_NODE')
    await changeType(wrapper, 'FORWARD_RELAY_NODE')
    const result = await applied(wrapper)
    expect(result.waypoints).toEqual(original.waypoints)
    expect(result.loiterWaypoints).toEqual(original.loiterWaypoints ?? RELAY_DEFAULT_ROUTE.loiterWaypoints)
    expect(result.returnPlan).toEqual(original.returnPlan)
    expect(platform).toEqual(original)
    wrapper.unmount()
  })

  it('模板中继打开并直接确认后保留起飞点、普通航点与盘旋点，生成脚本完全一致', async () => {
    const draft = createTemplateScenario()
    const index = draft.config.platforms.findIndex(platform => platform.type === 'FORWARD_RELAY_NODE')
    const relay = structuredClone(draft.config.platforms[index]!)
    const { buildMissionPackage } = await import('../../server/scripts/' + 'mission-generator')
    const before = buildMissionPackage(draft).files['comm_platform_INS.txt']
    const wrapper = mountEditor(relay)
    const result = await applied(wrapper)
    expect(result).toEqual(relay)
    expect(result.initialPosition).toEqual({ longitude: 119.55, latitude: 24.66, altitude: 3200 })
    expect(result.waypoints).toHaveLength(1)
    expect(result.loiterWaypoints).toHaveLength(3)
    draft.config.platforms[index] = result
    const after = buildMissionPackage(draft).files['comm_platform_INS.txt']
    expect(after).toBe(before)
    const route = after.split('platform mission_uav_01 MISSION_UAV_PLATFORM')[1]!.split('end_platform')[0]!
    expect(route).toContain('position 24.66n 119.55e altitude 3200 m')
    expect(route.indexOf('position 24.66n 119.55e')).toBeLessThan(route.indexOf('position 25n 120.8e'))
    expect(route.match(/^\s*position /gm)).toHaveLength(5)
    expect(relay).toEqual(draft.config.platforms[index])
    wrapper.unmount()
  })

  it('高空中继可配置普通航点、盘旋并地图选点', async () => {
    const platform = structuredClone(fixtureSource.scenario.platforms[1]) as Platform
    const wrapper = mountEditor(platform)
    // 与模板中继机一致：起点之后先有普通航点（爬升点），再进入盘旋。
    expect(wrapper.find('[data-testid="add-waypoint"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="loiter-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="return-section"]').exists()).toBe(true)
    await wrapper.get('[data-testid="loiter-enabled"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="pick-loiter-0"]').trigger('click')
    const picker = wrapper.getComponent({ name: 'WaypointMapPicker' })
    expect(picker.props('modelValue')).toBe(true)
    picker.vm.$emit('confirm', { longitude: 120.9, latitude: 25.4 })
    await flushPromises()
    expect(wrapper.get('[data-testid="loiter-longitude-0"] input').element).toHaveProperty('value', '120.9')
    expect(wrapper.get('[data-testid="loiter-latitude-0"] input').element).toHaveProperty('value', '25.4')
    wrapper.unmount()
  })

  it('返航开关打开后待填写，关闭后删除 returnPlan 字段', async () => {
    const wrapper = mountEditor(airPlatform())
    expect(wrapper.find('[data-testid="return-time"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="add-return-waypoint"]').exists()).toBe(false)

    await wrapper.get('[data-testid="return-enabled"]').trigger('click')
    await flushPromises()
    // 返航时刻不预填，确认时本地兜底拦截并原位提示。
    expect(wrapper.get('[data-testid="return-time"] input').element).toHaveProperty('value', '')
    await wrapper.get('[data-testid="apply-platform"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(wrapper.emitted('invalid')!.at(-1)).toEqual(['返航时刻必须大于 0 且早于仿真结束时刻。'])
    await vi.waitFor(() => expect(wrapper.get('[data-testid="return-time"]').element.closest('.el-form-item')!.textContent).toContain('返航时刻必须大于 0 且早于仿真结束时刻。'))

    expect(wrapper.get('#platform-return-title').text()).toBe('返航路线（0）')
    expect(wrapper.get('[data-testid="add-return-waypoint"]').text()).toBe('新增返航路线航点')
    await setNumber(wrapper, 'return-time', 1200)
    await wrapper.get('[data-testid="add-return-waypoint"]').trigger('click')
    expect(wrapper.get('#platform-return-title').text()).toBe('返航路线（1）')
    await setNumber(wrapper, 'return-speed-0', 80)
    await wrapper.get('[data-testid="pick-return-0"]').trigger('click')
    const picker = wrapper.getComponent({ name: 'WaypointMapPicker' })
    picker.vm.$emit('confirm', { longitude: 118.2, latitude: 24.5 })
    await flushPromises()
    let result = await applied(wrapper)
    expect(result.returnPlan).toEqual({ timeS: 1200, waypoints: [{ longitude: 118.2, latitude: 24.5, altitude: 3000, speed: 80 }] })

    await wrapper.get('[data-testid="return-enabled"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="return-time"]').exists()).toBe(false)
    result = await applied(wrapper)
    expect(Object.hasOwn(result, 'returnPlan')).toBe(false)
    wrapper.unmount()
  })

  it('不适用的类型不显示对应区域，确认时不提交不适用字段', async () => {
    const rear = mountEditor(structuredClone(fixtureSource.scenario.platforms[0]) as Platform)
    expect(rear.find('[data-testid="loiter-section"]').exists()).toBe(false)
    expect(rear.find('[data-testid="return-section"]').exists()).toBe(false)
    rear.unmount()

    const platform = airPlatform()
    platform.loiterWaypoints = [
      { longitude: 120, latitude: 24, altitude: 3000, speed: 50 },
      { longitude: 120.3, latitude: 24.2, altitude: 3000, speed: 50 },
    ]
    platform.returnPlan = { timeS: 600, waypoints: [{ longitude: 118, latitude: 24, altitude: 1000, speed: 60 }] }
    const wrapper = mountEditor(platform, { editing: false })
    await changeType(wrapper, 'AIRBORNE_JAMMER_PLATFORM')
    expect(wrapper.find('[data-testid="loiter-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="return-section"]').exists()).toBe(false)
    let result = await applied(wrapper)
    expect(result.loiterWaypoints).toHaveLength(2)
    expect(Object.hasOwn(result, 'returnPlan')).toBe(false)

    await changeType(wrapper, 'GROUND_JAMMER_DETECTION_STATION')
    expect(wrapper.find('[data-testid="loiter-section"]').exists()).toBe(false)
    result = await applied(wrapper)
    expect(Object.hasOwn(result, 'loiterWaypoints')).toBe(false)
    expect(Object.hasOwn(result, 'returnPlan')).toBe(false)
    wrapper.unmount()
  })

  it.each(['REAR_COMMAND_NODE', 'GROUND_CLUSTER_COMMAND_NODE', 'GROUND_JAMMER_DETECTION_STATION', 'AIRBORNE_JAMMER_PLATFORM', 'COMMUNICATION_SATELLITE'] as const)('%s 不显示普通航点区，残留航点不提交', async (type) => {
    const platform = structuredClone(fixtureSource.scenario.platforms.find(item => item.type === type) ?? fixtureSource.scenario.platforms[0]) as Platform
    platform.type = type
    platform.waypoints = [{ ...platform.initialPosition, speed: 20, arrivalTime: 0 }]
    const wrapper = mountEditor(platform)
    await flushPromises()
    expect(wrapper.find('#platform-waypoint-title').exists()).toBe(false)
    expect(wrapper.find('[data-testid="add-waypoint"]').exists()).toBe(false)
    // 机载干扰平台只有盘旋航点区。
    expect(wrapper.find('[data-testid="loiter-section"]').exists()).toBe(type === 'AIRBORNE_JAMMER_PLATFORM')
    expect((await applied(wrapper)).waypoints).toEqual([])
    wrapper.unmount()
  })

  it('切错类型再切回，已填的普通航点、盘旋航点和返航路线都还在', async () => {
    const platform = airPlatform()
    platform.waypoints = [{ longitude: 120.5, latitude: 24.5, altitude: 3000, speed: 60, arrivalTime: 0 }]
    platform.loiterWaypoints = [
      { longitude: 120, latitude: 24, altitude: 3000, speed: 50 },
      { longitude: 120.3, latitude: 24.2, altitude: 3000, speed: 50 },
    ]
    platform.returnPlan = { timeS: 600, waypoints: [{ longitude: 118, latitude: 24, altitude: 1000, speed: 60 }] }
    const original = structuredClone(platform)
    const wrapper = mountEditor(platform, { editing: false })

    // 切到后方通信车：三个区域都隐藏，确认时也不提交。
    await changeType(wrapper, 'REAR_COMMAND_NODE')
    for (const section of ['loiter-section', 'return-section']) expect(wrapper.find(`[data-testid="${section}"]`).exists()).toBe(false)
    expect(wrapper.find('[data-testid="waypoint-table"]').exists()).toBe(false)

    // 切回无人机集群：内容原样恢复。
    await changeType(wrapper, 'AIRBORNE_MISSION_CLUSTER')
    expect(wrapper.find('[data-testid="loiter-section"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="return-enabled"]').classes()).toContain('is-checked')
    const result = await applied(wrapper)
    expect(result.waypoints).toEqual(original.waypoints)
    expect(result.loiterWaypoints).toEqual(original.loiterWaypoints)
    expect(result.returnPlan).toEqual(original.returnPlan)
    wrapper.unmount()
  })

  it('校验错误按字段路径原位显示', async () => {
    const platform = airPlatform()
    platform.loiterWaypoints = [{ longitude: 120, latitude: 24, altitude: 3000, speed: 0 }]
    platform.returnPlan = { timeS: 9999, waypoints: [] }
    const validate = (): ValidationIssue[] => [
      { severity: 'ERROR', code: 'LOITER_POINT_COUNT_INVALID', message: '盘旋路线至少需要两个位置点。', fieldPath: 'loiterWaypoints' },
      { severity: 'ERROR', code: 'TEMPLATE_ROUTE_SPEED_INVALID', message: '模板路线点速度必须至少为 1 m/s。', fieldPath: 'loiterWaypoints[0].speed' },
      { severity: 'ERROR', code: 'RETURN_TIME_INVALID', message: '返航时刻必须大于 0 且早于仿真结束时刻。', fieldPath: 'returnPlan.timeS' },
      { severity: 'ERROR', code: 'TEMPLATE_ROUTE_INVALID', message: '模板路线至少需要一个位置点。', fieldPath: 'returnPlan.waypoints' },
    ]
    const wrapper = mountEditor(platform, { validate })
    await flushPromises()
    expect(wrapper.find('[data-testid="loiter-list-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="return-list-error"]').exists()).toBe(false)
    await wrapper.get('[data-testid="apply-platform"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(wrapper.get('[data-testid="loiter-list-error"]').text()).toBe('盘旋路线至少需要两个位置点。')
    const speedItem = wrapper.get('[data-testid="loiter-speed-0"]').element.closest('.el-form-item')!
    await vi.waitFor(() => expect(speedItem.textContent).toContain('模板路线点速度必须至少为 1 m/s。'))
    const timeItem = wrapper.get('[data-testid="return-time"]').element.closest('.el-form-item')!
    await vi.waitFor(() => expect(timeItem.textContent).toContain('返航时刻必须大于 0 且早于仿真结束时刻。'))
    expect(wrapper.get('[data-testid="return-list-error"]').text()).toBe('模板路线至少需要一个位置点。')
    // 列表级错误不重复显示行内错误。
    expect(wrapper.get('[data-testid="loiter-list-error"]').text()).not.toContain('速度')
    wrapper.unmount()
  })

  it('批量新增无人机时可配置盘旋与返航并验证后提交', async () => {
    const wrapper = mountEditor(airPlatform(), { editing: false })
    await setNumber(wrapper, 'platform-quantity', 3)
    await flushPromises()
    expect(wrapper.find('[data-testid="loiter-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="return-section"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="batch-route-hint"]').text()).toContain('新增后可逐个调整')
    await wrapper.get('[data-testid="loiter-enabled"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="return-enabled"]').trigger('click')
    await wrapper.get('[data-testid="apply-platform"]').trigger('click')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(wrapper.emitted('invalid')?.at(-1)).toEqual(['返航时刻必须大于 0 且早于仿真结束时刻。'])
    await setNumber(wrapper, 'return-time', 600)
    await wrapper.get('[data-testid="add-return-waypoint"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="apply-platform"]').trigger('click')
    const [platform, count] = wrapper.emitted('apply')!.at(-1)! as [Platform, number]
    expect(count).toBe(3)
    expect(platform.loiterWaypoints).toHaveLength(8)
    expect(platform.returnPlan).toEqual({ timeS: 600, waypoints: [{ ...airPlatform().initialPosition, altitude: 3000, speed: 200 }] })
    wrapper.unmount()
  })

  it('普通航点的航向、加速度和必填字段在同一张表中，盘旋和返航入口独立', async () => {
    const wrapper = mountEditor(structuredClone(fixtureSource.scenario.platforms[3]) as Platform)
    await flushPromises()
    const table = wrapper.get('[data-testid="waypoint-table"]')
    for (const field of ['speed', 'arrival', 'heading', 'acceleration']) {
      expect(table.find(`[data-testid="waypoint-${field}-0"]`).exists()).toBe(true)
    }
    for (const section of ['loiter-section', 'return-section']) {
      expect(wrapper.find(`[data-testid="${section}"]`).exists()).toBe(true)
      expect(table.find(`[data-testid="${section}"]`).exists()).toBe(false)
    }
    for (const removed of ['waypoint-advanced', 'waypoint-legacy-hint', 'platform-heading']) {
      expect(wrapper.find(`[data-testid="${removed}"]`).exists()).toBe(false)
    }
    wrapper.unmount()
  })

  it.each(['heading', 'acceleration'])('确认时在航点表内显示 %s 字段错误', async (field) => {
    const platform = airPlatform()
    platform.waypoints = [{ ...mapPoint, arrivalTime: 120 }]
    const wrapper = mountEditor(platform, { validate: () => [
      { severity: 'ERROR', code: 'WAYPOINT_FIELD_INVALID', message: '航点参数数值无效。', fieldPath: `waypoints[0].${field}` },
    ] })
    await flushPromises()
    await wrapper.get('[data-testid="apply-platform"]').trigger('click')
    const item = wrapper.get(`[data-testid="waypoint-${field}-0"]`).element.closest('.el-form-item')!
    await vi.waitFor(() => expect(item.textContent).toContain('航点参数数值无效。'))
    wrapper.unmount()
  })
})


it('普通航点地图选点只改位置，保留运动字段；可选数值清空后移除属性', async () => {
  const platform = airPlatform()
  platform.waypoints = [{ longitude: 120, latitude: 24, altitude: 3000, speed: 40, arrivalTime: 120, heading: 90, acceleration: 2 }]
  const wrapper = mountEditor(platform)
  await flushPromises()
  await wrapper.get('[data-testid="pick-waypoint-0"]').trigger('click')
  wrapper.getComponent({ name: 'WaypointMapPicker' }).vm.$emit('confirm', { longitude: 120.5, latitude: 24.5 })
  await flushPromises()
  expect((await applied(wrapper)).waypoints[0]).toEqual({ longitude: 120.5, latitude: 24.5, altitude: 3000, speed: 40, arrivalTime: 120, heading: 90, acceleration: 2 })
  await setNumber(wrapper, 'waypoint-heading-0', 135)
  await setNumber(wrapper, 'waypoint-acceleration-0', 2.5)
  expect((await applied(wrapper)).waypoints[0]).toMatchObject({ heading: 135, acceleration: 2.5 })
  for (const field of ['heading', 'acceleration']) {
    const control = wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === `waypoint-${field}-0`)!
    control.vm.$emit('update:modelValue', undefined)
  }
  await flushPromises()
  const result = await applied(wrapper)
  expect(result.waypoints[0]).not.toHaveProperty('heading')
  expect(result.waypoints[0]).not.toHaveProperty('acceleration')
  expect(platform.waypoints[0]!.heading).toBe(90)
  wrapper.unmount()
})

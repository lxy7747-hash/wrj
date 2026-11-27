import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'
import type { Platform } from '../../src/contracts/domain-models'
import PlatformEditorDialog from '../../src/components/scenarios/PlatformEditorDialog.vue'
import {
  DEFAULT_LOITER_POINT_COUNT,
  DEFAULT_LOITER_RADIUS_KM,
  generateLoiterCircleWaypoints,
  inferLoiterCircle,
} from '../../src/features/scenarios/loiter-circle'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'

const TYPE_OPTIONS = [
  { value: 'REAR_COMMAND_NODE', label: '后方指挥节点' },
  { value: 'FORWARD_RELAY_NODE', label: '高空前出中继节点' },
  { value: 'AIRBORNE_MISSION_CLUSTER', label: '空中无人作业集群' },
] as const

function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371.0088 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)))
}

function airPlatform(): Platform {
  return structuredClone(fixtureSource.scenario.platforms[4]) as Platform
}

function mountEditor(platform: Platform, editing = true) {
  return mount(PlatformEditorDialog, {
    props: {
      modelValue: true,
      platform,
      editing,
      error: '',
      pending: false,
      locked: false,
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

async function setNumber(wrapper: ReturnType<typeof mountEditor>, testId: string, value: number): Promise<void> {
  const control = wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === testId)!
  control.vm.$emit('update:modelValue', value)
  await flushPromises()
}

async function applied(wrapper: ReturnType<typeof mountEditor>): Promise<Platform> {
  await wrapper.get('[data-testid="apply-platform"]').trigger('click')
  const emitted = wrapper.emitted('apply')
  expect(emitted).toBeDefined()
  return emitted!.at(-1)![0] as Platform
}

describe('loiter-circle 盘旋圆心与半径几何换算', () => {
  it('按圆心、半径、高度与速度生成均匀分布的 8 个圆周盘旋航点', () => {
    const center = { longitude: 120.5, latitude: 24.8 }
    const points = generateLoiterCircleWaypoints({
      ...center,
      radiusKm: 10,
      altitude: 4500,
      speed: 120,
    })
    expect(points).toHaveLength(DEFAULT_LOITER_POINT_COUNT)
    for (const point of points) {
      expect(haversineKm(center.longitude, center.latitude, point.longitude, point.latitude)).toBeCloseTo(10, 1)
      expect(point.altitude).toBe(4500)
      expect(point.speed).toBe(120)
    }
  })

  it('从已有圆周盘旋航点可准确反推圆心与半径，空数组时回退默认值', () => {
    const points = generateLoiterCircleWaypoints({
      longitude: 119.8,
      latitude: 25.2,
      radiusKm: 8.5,
      altitude: 6000,
      speed: 95,
    })
    const inferred = inferLoiterCircle(points, { longitude: 0, latitude: 0, altitude: 3000, speed: 200 })
    expect(inferred.longitude).toBeCloseTo(119.8, 2)
    expect(inferred.latitude).toBeCloseTo(25.2, 2)
    expect(inferred.radiusKm).toBeCloseTo(8.5, 1)
    expect(inferred.altitude).toBe(6000)
    expect(inferred.speed).toBe(95)

    const emptyInferred = inferLoiterCircle(undefined, { longitude: 120.1, latitude: 24.3, altitude: 3200, speed: 150 })
    expect(emptyInferred).toMatchObject({
      longitude: 120.1,
      latitude: 24.3,
      radiusKm: DEFAULT_LOITER_RADIUS_KM,
      altitude: 3200,
      speed: 150,
    })
  })
})

describe('PlatformEditorDialog 模式 1：选圆心 + 设半径盘旋配置', () => {
  it('开启盘旋后自动生成 8 点圆周航点，修改圆心/半径/高度/速度或地图选圆心后实时更新，关闭后移除字段', async () => {
    const platform = airPlatform()
    const wrapper = mountEditor(platform)
    expect(wrapper.find('[data-testid="loiter-radius-km"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pick-loiter-center"]').exists()).toBe(false)

    // 开启盘旋
    await wrapper.get('[data-testid="loiter-enabled"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="loiter-radius-km"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pick-loiter-center"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="loiter-details"]').attributes('open')).toBeUndefined()

    // 调整半径、高度、速度
    await setNumber(wrapper, 'loiter-radius-km', 12)
    await setNumber(wrapper, 'loiter-altitude', 5000)
    await setNumber(wrapper, 'loiter-speed', 88)

    // 地图选圆心时透传半径预览（米）
    await wrapper.get('[data-testid="pick-loiter-center"]').trigger('click')
    await flushPromises()
    const picker = wrapper.getComponent({ name: 'WaypointMapPicker' })
    expect(picker.props('modelValue')).toBe(true)
    expect(picker.props('route')).toBeUndefined()
    expect(picker.props('title')).toBe('地图选取盘旋圆心')
    expect(picker.props('previewRadiusMeters')).toBe(12000)

    picker.vm.$emit('confirm', { longitude: 121.2, latitude: 25.1 })
    await flushPromises()
    expect(picker.props('modelValue')).toBe(false)

    let result = await applied(wrapper)
    expect(result.loiterWaypoints).toHaveLength(DEFAULT_LOITER_POINT_COUNT)
    for (const point of result.loiterWaypoints!) {
      expect(haversineKm(121.2, 25.1, point.longitude, point.latitude)).toBeCloseTo(12, 1)
      expect(point.altitude).toBe(5000)
      expect(point.speed).toBe(88)
    }

    // 关闭盘旋后删除 loiterWaypoints
    await wrapper.get('[data-testid="loiter-enabled"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="loiter-radius-km"]').exists()).toBe(false)
    result = await applied(wrapper)
    expect(Object.hasOwn(result, 'loiterWaypoints')).toBe(false)
    wrapper.unmount()
  })

  it('打开已有自定义盘旋航点的节点时仅反推回显，未修改盘旋参数直接确认不改写原航点数组', async () => {
    const platform = airPlatform()
    platform.loiterWaypoints = [
      { longitude: 120.0, latitude: 24.0, altitude: 3500, speed: 65 },
      { longitude: 120.2, latitude: 24.0, altitude: 3500, speed: 70 },
      { longitude: 120.1, latitude: 24.2, altitude: 3600, speed: 75 },
    ]
    const original = structuredClone(platform.loiterWaypoints)
    const wrapper = mountEditor(platform)
    await flushPromises()

    expect(wrapper.find('[data-testid="loiter-radius-km"]').exists()).toBe(true)
    const result = await applied(wrapper)
    expect(result.loiterWaypoints).toEqual(original)
    wrapper.unmount()
  })
})

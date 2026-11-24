import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

const leafletMocks = vi.hoisted(() => {
  const state: {
    clickHandler?: (event: { latlng: { lng: number; lat: number } }) => void
  } = {}
  const map = {
    on: vi.fn((event: string, handler: typeof state.clickHandler) => {
      if (event === 'click') state.clickHandler = handler
      return map
    }),
    off: vi.fn(),
    remove: vi.fn(),
    fitBounds: vi.fn(),
    setView: vi.fn(),
    invalidateSize: vi.fn(),
    createPane: vi.fn(() => document.createElement('div')),
  }
  const vectorLayer = { addTo: vi.fn(), on: vi.fn() }
  const createVectorLayer = vi.fn(() => vectorLayer)
  const zoomControl = { addTo: vi.fn(() => zoomControl) }
  const createZoomControl = vi.fn(() => zoomControl)
  const marker = {
    addTo: vi.fn(() => marker),
    bindTooltip: vi.fn<(content: string, options: object) => void>().mockReturnThis(),
    setLatLng: vi.fn(),
    remove: vi.fn(),
  }
  const circleMarker = vi.fn(() => marker)
  const layer = { addTo: vi.fn(() => layer), clearLayers: vi.fn() }
  const polyline = vi.fn(() => ({ addTo: vi.fn() }))
  const divIcon = vi.fn((options: { html: string | HTMLElement }) => options)
  const routeMarker = vi.fn(([lat, lng]: [number, number], _options?: object) => {
    const result = {
      on: vi.fn<(event: string, handler: () => void) => void>().mockReturnThis(),
      addTo: vi.fn().mockReturnThis(),
      bindTooltip: vi.fn<(content: HTMLElement, options: object) => void>().mockReturnThis(),
      getLatLng: vi.fn(() => ({ lat, lng })),
      setLatLng: vi.fn(),
      remove: vi.fn(),
    }
    return result
  })
  return { state, map, vectorLayer, createVectorLayer, zoomControl, createZoomControl, marker, circleMarker, layer, polyline, divIcon, routeMarker }
})

vi.mock('leaflet.vectorgrid', () => ({}))
vi.mock('leaflet', () => ({
  default: {
    map: vi.fn(() => leafletMocks.map),
    vectorGrid: { protobuf: leafletMocks.createVectorLayer },
    canvas: { tile: vi.fn() },
    control: { zoom: leafletMocks.createZoomControl },
    circleMarker: leafletMocks.circleMarker,
    layerGroup: vi.fn(() => leafletMocks.layer),
    polyline: leafletMocks.polyline,
    divIcon: leafletMocks.divIcon,
    marker: leafletMocks.routeMarker,
    DomEvent: { stopPropagation: vi.fn() },
    latLngBounds: vi.fn((bounds: unknown) => bounds),
  },
}))

import WaypointMapPicker from '../../src/components/scenarios/WaypointMapPicker.vue'
import { MAP_CONFIG } from '../../src/config/map.config'
import { PLATFORM_POSITION_RULES } from '../../src/features/scenarios/platform-position-rules'

function dragLastRouteMarker(lng: number, lat: number) {
  const result = leafletMocks.routeMarker.mock.results.at(-1)
  if (result?.type !== 'return') throw new Error('找不到地图航点标记')
  const marker = result.value
  marker.getLatLng.mockReturnValue({ lng, lat })
  marker.on.mock.calls.find(([event]) => event === 'dragend')![1]()
  return marker
}

describe('航点地图选点', () => {
  afterEach(() => {
    vi.clearAllMocks()
    leafletMocks.state.clickHandler = undefined
    document.body.innerHTML = ''
  })

  it.each([[116, 25], [116.9999999, 24], [122.0000001, 24], [119, 20.9999999], [119, 26.0000001], [NaN, 24]])('集群地图拒绝越界选点 %s/%s，清除旧点且可重新选取边界', async (lng, lat) => {
    const wrapper = mount(WaypointMapPicker, {
      attachTo: document.body,
      props: { modelValue: true, longitude: 119, latitude: 24, bounds: PLATFORM_POSITION_RULES.AIRBORNE_MISSION_CLUSTER },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    wrapper.getComponent({ name: 'ElDialog' }).vm.$emit('opened')
    await nextTick()
    expect(document.body.textContent).toContain('经度 117°E～122°E，纬度 21°N～26°N')
    leafletMocks.state.clickHandler?.({ latlng: { lng, lat } })
    await nextTick()
    const confirm = document.querySelector<HTMLButtonElement>('[data-testid="confirm-waypoint-point"]')!
    expect(confirm.disabled).toBe(true)
    expect(document.body.textContent).toContain('选点超出允许范围')
    expect(document.body.textContent).not.toContain('经度 119.000000°')
    expect(leafletMocks.marker.remove).toHaveBeenCalledOnce()
    confirm.click()
    expect(wrapper.emitted('confirm')).toBeUndefined()
    for (const [longitude, latitude] of [[117, 21], [122, 26]]) {
      leafletMocks.state.clickHandler?.({ latlng: { lng: longitude!, lat: latitude! } })
      await nextTick()
      expect(confirm.disabled).toBe(false)
      expect(document.querySelector('[data-testid="waypoint-range-error"]')).toBeNull()
      confirm.click()
      expect(wrapper.emitted('confirm')?.at(-1)).toEqual([{ longitude, latitude }])
    }
    wrapper.unmount()
  })

  it('旧的越界航点不可直接确认，不传范围的其他类型仍可选取该点', async () => {
    const wrapper = mount(WaypointMapPicker, {
      attachTo: document.body,
      props: { modelValue: true, longitude: 123, latitude: 27, bounds: PLATFORM_POSITION_RULES.AIRBORNE_MISSION_CLUSTER },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="confirm-waypoint-point"]')!.disabled).toBe(true)
    wrapper.unmount()
    const unrestricted = mount(WaypointMapPicker, {
      attachTo: document.body,
      props: { modelValue: true, longitude: 123, latitude: 27 },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-testid="confirm-waypoint-point"]')!.click()
    expect(unrestricted.emitted('confirm')?.at(-1)).toEqual([{ longitude: 123, latitude: 27 }])
    unrestricted.unmount()
  })

  it('加载与态势页相同的离线矢量底图并将点击坐标按六位小数提交', async () => {
    const wrapper = mount(WaypointMapPicker, {
      attachTo: document.body,
      props: { modelValue: true, longitude: 0, latitude: 0 },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    wrapper.getComponent({ name: 'ElDialog' }).vm.$emit('opened')
    await nextTick()

    expect(leafletMocks.map.fitBounds).toHaveBeenCalledOnce()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="confirm-waypoint-point"]')!.disabled).toBe(true)
    expect(leafletMocks.createVectorLayer).toHaveBeenCalledExactlyOnceWith(MAP_CONFIG.resources.vector.tileUrl, expect.objectContaining({
      maxNativeZoom: MAP_CONFIG.resources.vector.maxNativeZoom, interactive: false, pane: 'tilePane',
      vectorTileLayerStyles: expect.objectContaining({ ocean: expect.objectContaining({ fillColor: '#06111d' }) }),
    }))
    expect(leafletMocks.vectorLayer.addTo).toHaveBeenCalledExactlyOnceWith(leafletMocks.map)
    expect(leafletMocks.zoomControl.addTo).toHaveBeenCalledOnce()
    expect(leafletMocks.createZoomControl).toHaveBeenCalledWith(expect.objectContaining({
      zoomInTitle: '放大地图',
      zoomOutTitle: '缩小地图',
    }))
    leafletMocks.state.clickHandler?.({ latlng: { lng: 120.65432149, lat: 24.45678949 } })
    await nextTick()
    const confirm = document.querySelector<HTMLButtonElement>('[data-testid="confirm-waypoint-point"]')!
    const readout = confirm.parentElement?.querySelector('[aria-live="polite"]')
    expect(readout?.closest('.el-dialog__footer')).toBe(confirm.closest('.el-dialog__footer'))
    expect(readout?.textContent).toContain('经度 120.654321° · 纬度 24.456789° · 高度 0 m')
    leafletMocks.state.clickHandler?.({ latlng: { lng: 121.1234564, lat: 25.1234564 } })
    expect(leafletMocks.marker.setLatLng).toHaveBeenCalledWith([25.123456, 121.123456])

    confirm.click()
    await nextTick()
    expect(wrapper.emitted('confirm')?.[0]).toEqual([{ longitude: 121.123456, latitude: 25.123456 }])
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
    wrapper.unmount()
  })

  it('回显现有航点并在关闭时释放地图', async () => {
    const wrapper = mount(WaypointMapPicker, {
      attachTo: document.body,
      props: { modelValue: true, longitude: 119.55, latitude: 24.8 },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    const dialog = wrapper.getComponent({ name: 'ElDialog' })
    dialog.vm.$emit('opened')
    await nextTick()

    expect(document.body.textContent).toContain('经度 119.550000° · 纬度 24.800000° · 高度 0 m')
    expect(leafletMocks.map.setView).toHaveBeenCalledWith([24.8, 119.55], expect.any(Number), { animate: false })
    expect(leafletMocks.marker.addTo).toHaveBeenCalledOnce()
    dialog.vm.$emit('update:modelValue', false)
    dialog.vm.$emit('closed')
    await nextTick()
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
    expect(leafletMocks.map.off).toHaveBeenCalledWith('click', expect.any(Function))
    expect(leafletMocks.map.remove).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('按类型和卫星子类型显示已配置节点，并用带标签的金色圆点标出选点', async () => {
    const wrapper = mount(WaypointMapPicker, {
      attachTo: document.body,
      props: {
        modelValue: true, longitude: 119, latitude: 24, bounds: PLATFORM_POSITION_RULES.AIRBORNE_MISSION_CLUSTER,
        existingNodes: [
          { id: 'A', name: '<b>节点</b>', type: 'REAR_COMMAND_NODE', initialPosition: { longitude: 123, latitude: 27, altitude: 0 } },
          { id: 'B', name: '零点', type: 'COMMUNICATION_SATELLITE', satelliteType: 'SHENTONG', initialPosition: { longitude: 0, latitude: 0, altitude: 0 } },
          { id: 'C', name: '无效坐标', type: 'FORWARD_RELAY_NODE', initialPosition: { longitude: 0, latitude: 91, altitude: 0 } },
        ],
      },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    wrapper.getComponent({ name: 'ElDialog' }).vm.$emit('opened')
    expect(document.body.textContent).toContain('类型图标表示已配置节点。')
    expect(leafletMocks.map.setView).toHaveBeenCalledWith([24, 119], expect.any(Number), { animate: false })
    expect(leafletMocks.circleMarker).toHaveBeenCalledExactlyOnceWith([24, 119], expect.objectContaining({
      pane: 'waypoint-selection', radius: 5, fillColor: '#f5b942', fillOpacity: 1, interactive: false,
    }))
    expect(leafletMocks.marker.bindTooltip).toHaveBeenCalledExactlyOnceWith('当前选点',
      expect.objectContaining({ permanent: true, className: 'waypoint-map-dialog__selected-label' }))
    expect(leafletMocks.routeMarker).toHaveBeenCalledTimes(2)
    expect(leafletMocks.routeMarker).toHaveBeenCalledWith([27, 123], expect.objectContaining({ interactive: false, keyboard: false }))
    expect(leafletMocks.routeMarker).toHaveBeenCalledWith([0, 0], expect.objectContaining({ interactive: false, keyboard: false }))
    const [rearIcon, satelliteIcon] = leafletMocks.divIcon.mock.calls.map(([icon]) => icon.html as HTMLElement)
    expect(rearIcon?.querySelector('img')?.src).toBe(MAP_CONFIG.nodeTypeImages.REAR_COMMAND_NODE)
    expect(satelliteIcon?.querySelector('img')?.src).toBe(MAP_CONFIG.nodeTypeImages.SHENTONG)
    satelliteIcon?.querySelector('img')?.dispatchEvent(new Event('error'))
    expect(satelliteIcon?.textContent).toBe(MAP_CONFIG.nodeTypeGlyphs.COMMUNICATION_SATELLITE)
    const label = leafletMocks.routeMarker.mock.results[0]!.value.bindTooltip.mock.calls[0]![0]
    expect(label.textContent).toBe('<b>节点</b>')
    expect(label.childElementCount).toBe(0)

    leafletMocks.state.clickHandler?.({ latlng: { lng: 123, lat: 27 } })
    await nextTick()
    const confirm = document.querySelector<HTMLButtonElement>('[data-testid="confirm-waypoint-point"]')!
    expect(confirm.disabled).toBe(true)
    expect(wrapper.emitted('confirm')).toBeUndefined()
    leafletMocks.state.clickHandler?.({ latlng: { lng: 121, lat: 24 } })
    await nextTick()
    confirm.click()
    expect(wrapper.emitted('confirm')).toEqual([[{ longitude: 121, latitude: 24 }]])
    wrapper.unmount()
  })

  it('新建节点时将默认点和范围内的已有节点纳入初始视野', async () => {
    const wrapper = mount(WaypointMapPicker, {
      attachTo: document.body,
      props: {
        modelValue: true, longitude: 117, latitude: 21, bounds: PLATFORM_POSITION_RULES.AIRBORNE_MISSION_CLUSTER,
        fitExistingNodes: true,
        existingNodes: [
          { id: 'A', name: '范围内', type: 'AIRBORNE_MISSION_CLUSTER', initialPosition: { longitude: 119, latitude: 24, altitude: 0 } },
          { id: 'B', name: '范围外', type: 'FORWARD_RELAY_NODE', initialPosition: { longitude: 123, latitude: 27, altitude: 0 } },
        ],
      },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    wrapper.getComponent({ name: 'ElDialog' }).vm.$emit('opened')
    expect(leafletMocks.map.fitBounds).toHaveBeenCalledWith([[21, 117], [24, 119]], {
      padding: [48, 48], maxZoom: MAP_CONFIG.defaults.zoom, animate: false,
    })
    expect(leafletMocks.map.setView).not.toHaveBeenCalled()
    expect(leafletMocks.routeMarker).toHaveBeenCalledWith([27, 123], expect.objectContaining({ interactive: false }))
    expect(leafletMocks.routeMarker.mock.results[0]!.value.bindTooltip.mock.calls[0]![0].textContent).toBe('范围内 · 无人作业')
    expect(leafletMocks.routeMarker.mock.results[1]!.value.bindTooltip.mock.calls[0]![0].textContent).toBe('范围外 · 中继')
    document.querySelector<HTMLButtonElement>('[data-testid="confirm-waypoint-point"]')!.click()
    expect(wrapper.emitted('confirm')).toEqual([[{ longitude: 117, latitude: 21 }]])
    wrapper.unmount()
  })

  it('重新打开初始位置选点时定位并回显已保存的 (0, 0)', async () => {
    const wrapper = mount(WaypointMapPicker, {
      attachTo: document.body,
      props: { modelValue: true, longitude: 45, latitude: -12, allowZeroPoint: true, showAltitude: false },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    const dialog = wrapper.getComponent({ name: 'ElDialog' })
    dialog.vm.$emit('opened')
    expect(leafletMocks.map.setView).toHaveBeenLastCalledWith([-12, 45], expect.any(Number), { animate: false })
    const picker = wrapper as unknown as VueWrapper<{ $props: { modelValue: boolean; longitude: number; latitude: number } }>
    await picker.setProps({ modelValue: false })
    dialog.vm.$emit('closed')
    await picker.setProps({ modelValue: true, longitude: 0, latitude: 0 })
    await flushPromises()
    dialog.vm.$emit('opened')

    expect(leafletMocks.map.setView).toHaveBeenLastCalledWith([0, 0], expect.any(Number), { animate: false })
    expect(leafletMocks.marker.addTo).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('经度 0.000000° · 纬度 0.000000°')
    document.querySelector<HTMLButtonElement>('[data-testid="confirm-waypoint-point"]')!.click()
    expect(wrapper.emitted('confirm')).toEqual([[{ longitude: 0, latitude: 0 }]])
    wrapper.unmount()
  })

  it('连续预览与撤销盘旋点，确认时给新点回填默认高度和速度', async () => {
    const existing = [{ longitude: 119, latitude: 24 }]
    const wrapper = mount(WaypointMapPicker, {
      attachTo: document.body,
      props: {
        modelValue: true, longitude: 0, latitude: 0,
        route: { points: existing, origin: { longitude: 118, latitude: 24 }, loiter: true, altitude: 1000 },
      },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    wrapper.getComponent({ name: 'ElDialog' }).vm.$emit('opened')
    const control = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!
    const status = () => control('waypoint-batch-status').textContent
    const confirm = control('confirm-waypoint-batch')
    expect(control('waypoint-batch-status').parentElement).toBe(confirm.parentElement)
    expect(confirm.closest('.el-dialog__footer')).not.toBeNull()
    const pick = async (lng: number, lat: number) => {
      leafletMocks.state.clickHandler?.({ latlng: { lng, lat } })
      await nextTick()
    }
    expect(confirm.disabled).toBe(true)
    expect(status()).toContain('还需 1 个盘旋航点')
    await pick(120, 25)
    expect(confirm.disabled).toBe(false)
    expect(leafletMocks.divIcon).toHaveBeenLastCalledWith(expect.objectContaining({ html: '2' }))
    expect(leafletMocks.polyline).toHaveBeenLastCalledWith([[25, 120], [24, 119]], expect.objectContaining({ dashArray: expect.any(String) }))
    await pick(181, 25)
    expect(status()).toContain('本次已选 1 个点')
    expect(control('waypoint-range-error')).not.toBeNull()
    control('undo-waypoint-batch').click()
    await nextTick()
    expect(confirm.disabled).toBe(true)
    expect(control('waypoint-range-error')).toBeNull()

    await pick(120, 25)
    control('clear-waypoint-batch').click()
    await nextTick()
    expect(status()).toContain('本次已选 0 个点')
    await pick(121.1234564, 25)
    await pick(122, 26)
    expect(control('waypoint-batch-altitude')).toBeNull()
    expect(control('waypoint-batch-speed')).toBeNull()
    dragLastRouteMarker(122.1, 26)
    await nextTick()
    confirm.click()
    expect(wrapper.emitted('confirm-route')).toEqual([[
      [
        { longitude: 121.123456, latitude: 25, altitude: 1000, speed: 200 },
        { longitude: 122.1, latitude: 26, altitude: 1000, speed: 200 },
      ],
      new Map(),
    ]])
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
    expect(existing).toEqual([{ longitude: 119, latitude: 24 }])
    wrapper.unmount()
  })

  it('已有点可单独拖动并确认，越界回到原位，取消后重开不保留移动', async () => {
    const existing = [{ longitude: 119, latitude: 24 }]
    const wrapper = mount(WaypointMapPicker, {
      attachTo: document.body,
      props: {
        modelValue: true, longitude: 0, latitude: 0,
        route: { points: existing, origin: { longitude: 118, latitude: 24 }, loiter: false, altitude: 0 },
        bounds: PLATFORM_POSITION_RULES.AIRBORNE_MISSION_CLUSTER,
      },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    const dialog = wrapper.getComponent({ name: 'ElDialog' })
    dialog.vm.$emit('opened')
    const confirm = () => document.querySelector<HTMLButtonElement>('[data-testid="confirm-waypoint-batch"]')!
    const drag = async (lng: number, lat: number) => {
      const marker = dragLastRouteMarker(lng, lat)
      await nextTick()
      return marker
    }

    expect(confirm().disabled).toBe(true)
    const marker = await drag(123, 25)
    expect(marker.setLatLng).toHaveBeenLastCalledWith([24, 119])
    expect(confirm().disabled).toBe(true)
    await drag(119.6543214, 24)
    expect(confirm().disabled).toBe(false)
    const batchStatus = confirm().parentElement?.querySelector('[data-testid="waypoint-batch-status"]')
    expect(batchStatus?.textContent).toContain('已移动 1 个已有点')
    expect(confirm().textContent).toContain('确认修改')
    expect(leafletMocks.polyline).toHaveBeenLastCalledWith([[24, 118], [24, 119.654321]], expect.any(Object))
    expect(existing).toEqual([{ longitude: 119, latitude: 24 }])

    const picker = wrapper as unknown as VueWrapper<{ $props: { modelValue: boolean } }>
    await picker.setProps({ modelValue: false })
    dialog.vm.$emit('closed')
    await picker.setProps({ modelValue: true })
    await flushPromises()
    dialog.vm.$emit('opened')
    expect(confirm().disabled).toBe(true)
    expect(leafletMocks.routeMarker).toHaveBeenLastCalledWith([24, 119], expect.objectContaining({ draggable: true }))
    await drag(119.6543214, 24)
    confirm().click()
    expect(wrapper.emitted('confirm-route')).toEqual([[[], new Map([[0, { longitude: 119.654321, latitude: 24 }]])]])
    wrapper.unmount()
  })

  it('单点编辑返航点时展示已有航点连线，并随当前选点更新', async () => {
    const wrapper = mount(WaypointMapPicker, {
      attachTo: document.body,
      props: {
        modelValue: true, longitude: 120.1, latitude: 24.1,
        routeContext: {
          points: [{ longitude: 120, latitude: 24 }, { longitude: 120.1, latitude: 24.1 }, { longitude: 120.2, latitude: 24.2 }],
          origin: { longitude: 119.5, latitude: 23.9 }, activeIndex: 1,
        },
      },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    wrapper.getComponent({ name: 'ElDialog' }).vm.$emit('opened')
    await nextTick()
    // 已有航点按顺序连线，当前编辑点也计入线中。
    expect(leafletMocks.polyline).toHaveBeenCalledWith([[23.9, 119.5], [24, 120], [24.1, 120.1], [24.2, 120.2]], expect.objectContaining({ color: '#97a9b6' }))
    // 当前编辑点由“当前选点”标记表示，编号标记只画其余两个点。
    expect(leafletMocks.routeMarker).toHaveBeenCalledTimes(2)
    leafletMocks.state.clickHandler?.({ latlng: { lng: 120.15, lat: 24.15 } })
    await nextTick()
    expect(leafletMocks.polyline).toHaveBeenLastCalledWith([[23.9, 119.5], [24, 120], [24.15, 120.15], [24.2, 120.2]], expect.objectContaining({ color: '#97a9b6' }))
    wrapper.unmount()
  })

})

import { flushPromises, mount } from '@vue/test-utils'
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
    invalidateSize: vi.fn(),
  }
  const tileLayer = { addTo: vi.fn(() => tileLayer) }
  const zoomControl = { addTo: vi.fn(() => zoomControl) }
  const createZoomControl = vi.fn(() => zoomControl)
  const marker = {
    addTo: vi.fn(() => marker),
    setLatLng: vi.fn(),
  }
  return { state, map, tileLayer, zoomControl, createZoomControl, marker }
})

vi.mock('leaflet', () => ({
  default: {
    map: vi.fn(() => leafletMocks.map),
    tileLayer: vi.fn(() => leafletMocks.tileLayer),
    control: { zoom: leafletMocks.createZoomControl },
    circleMarker: vi.fn(() => leafletMocks.marker),
    latLngBounds: vi.fn((bounds: unknown) => bounds),
  },
}))

import WaypointMapPicker from '../../src/components/scenarios/WaypointMapPicker.vue'

describe('航点地图选点', () => {
  afterEach(() => {
    vi.clearAllMocks()
    leafletMocks.state.clickHandler = undefined
    document.body.innerHTML = ''
  })

  it('加载离线地图并将点击坐标按六位小数提交', async () => {
    const wrapper = mount(WaypointMapPicker, {
      attachTo: document.body,
      props: { modelValue: true, longitude: 0, latitude: 0 },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    wrapper.getComponent({ name: 'ElDialog' }).vm.$emit('opened')
    await nextTick()

    expect(leafletMocks.map.fitBounds).toHaveBeenCalledOnce()
    expect(leafletMocks.tileLayer.addTo).toHaveBeenCalledOnce()
    expect(leafletMocks.zoomControl.addTo).toHaveBeenCalledOnce()
    expect(leafletMocks.createZoomControl).toHaveBeenCalledWith(expect.objectContaining({
      zoomInTitle: '放大地图',
      zoomOutTitle: '缩小地图',
    }))
    leafletMocks.state.clickHandler?.({ latlng: { lng: 120.65432149, lat: 24.45678949 } })
    await nextTick()
    expect(document.body.textContent).toContain('经度 120.654321° · 纬度 24.456789° · 高度 0 m')
    leafletMocks.state.clickHandler?.({ latlng: { lng: 121.1234564, lat: 25.1234564 } })
    expect(leafletMocks.marker.setLatLng).toHaveBeenCalledWith([25.123456, 121.123456])

    document.querySelector<HTMLElement>('[data-testid="confirm-waypoint-point"]')!.click()
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
    expect(leafletMocks.marker.addTo).toHaveBeenCalledOnce()
    dialog.vm.$emit('update:modelValue', false)
    dialog.vm.$emit('closed')
    await nextTick()
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
    expect(leafletMocks.map.off).toHaveBeenCalledWith('click', expect.any(Function))
    expect(leafletMocks.map.remove).toHaveBeenCalledOnce()
    wrapper.unmount()
  })
})

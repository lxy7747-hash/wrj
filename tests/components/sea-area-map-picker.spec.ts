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
    invalidateSize: vi.fn(),
  }
  const tileLayer = { addTo: vi.fn(() => tileLayer) }
  const zoomControl = { addTo: vi.fn(() => zoomControl) }
  const group = { addTo: vi.fn(() => group), remove: vi.fn() }
  const polygon = { addTo: vi.fn(() => polygon), remove: vi.fn() }
  return { state, map, tileLayer, zoomControl, group, polygon }
})

vi.mock('leaflet', () => ({
  default: {
    map: vi.fn(() => leafletMocks.map),
    tileLayer: vi.fn(() => leafletMocks.tileLayer),
    control: { zoom: vi.fn(() => leafletMocks.zoomControl) },
    circleMarker: vi.fn((position: unknown) => position),
    layerGroup: vi.fn(() => leafletMocks.group),
    polygon: vi.fn(() => leafletMocks.polygon),
    latLngBounds: vi.fn((bounds: unknown) => bounds),
  },
}))

import L from 'leaflet'
import SeaAreaMapPicker from '../../src/components/scenarios/SeaAreaMapPicker.vue'
import type { GeoPoint } from '../../src/contracts/domain-models'
import { MAP_CONFIG } from '../../src/config/map.config'
import { SEA_POLYGON_LIMITS } from '../../src/features/scenarios/scenario-validation'

const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!
const count = () => document.querySelector('[data-testid="sea-area-count"]')!.textContent
const click = async (lng: number, lat: number) => {
  leafletMocks.state.clickHandler?.({ latlng: { lng, lat } })
  await nextTick()
}

/** 挂载并触发弹窗 opened，使地图初始化。 */
async function open(polygon?: Array<{ longitude: number; latitude: number }>) {
  const wrapper = mount(SeaAreaMapPicker, {
    attachTo: document.body,
    props: { modelValue: true, polygon },
    global: { plugins: [ElementPlus] },
  })
  await flushPromises()
  wrapper.getComponent({ name: 'ElDialog' }).vm.$emit('opened')
  await nextTick()
  return wrapper
}

describe('海面区域地图框选', () => {
  afterEach(() => {
    vi.clearAllMocks()
    leafletMocks.state.clickHandler = undefined
    document.body.innerHTML = ''
  })

  it('无已保存区域时显示任务范围，逐点放置后闭合并确认六位小数顶点', async () => {
    const wrapper = await open()
    expect(L.latLngBounds).toHaveBeenCalledWith(MAP_CONFIG.taskBounds.map(([lat, lng]) => [lat, lng]))
    expect(leafletMocks.map.invalidateSize).toHaveBeenCalledWith({ pan: false })
    expect(button('confirm-sea-area').disabled).toBe(true)
    expect(button('sea-area-undo').disabled).toBe(true)
    expect(document.body.textContent).toContain(`还需 ${SEA_POLYGON_LIMITS.minPoints} 个`)
    await click(118.12345678, 24.1)
    expect(L.polygon).not.toHaveBeenCalled()
    await click(119, 24.2)
    // 两点只画开放折线（不填充），三点后填充闭合区域。
    expect(L.polygon).toHaveBeenLastCalledWith([[24.1, 118.123457], [24.2, 119]], expect.objectContaining({ fillOpacity: 0 }))
    await click(119.5, 25)
    expect(L.polygon).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({ fillOpacity: 0.18 }))
    expect(count()).toContain('已放置 3 个顶点')
    expect(button('confirm-sea-area').disabled).toBe(false)
    button('confirm-sea-area').click()
    expect(wrapper.emitted('confirm')).toEqual([[[
      { longitude: 118.123457, latitude: 24.1 }, { longitude: 119, latitude: 24.2 }, { longitude: 119.5, latitude: 25 },
    ]]])
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    wrapper.unmount()
    expect(leafletMocks.map.off).toHaveBeenCalledWith('click', expect.any(Function))
    expect(leafletMocks.map.remove).toHaveBeenCalled()
  })

  it('已有区域时缩放到该区域，撤销与清空更新顶点且不足三点不可确认', async () => {
    const polygon = [{ longitude: 118, latitude: 24 }, { longitude: 119, latitude: 24 }, { longitude: 119, latitude: 25 }]
    const wrapper = await open(polygon)
    expect(L.latLngBounds).toHaveBeenCalledWith([[24, 118], [24, 119], [25, 119]])
    expect(count()).toContain('已放置 3 个顶点')
    button('sea-area-undo').click()
    await nextTick()
    expect(count()).toContain('已放置 2 个顶点')
    expect(leafletMocks.group.remove).toHaveBeenCalled()
    expect(leafletMocks.polygon.remove).toHaveBeenCalled()
    expect(button('confirm-sea-area').disabled).toBe(true)
    // 绕过禁用态直接调用也不发出确认。
    ;(wrapper.vm as unknown as { $: { setupState: { confirmArea: () => void } } }).$.setupState.confirmArea()
    expect(wrapper.emitted('confirm')).toBeUndefined()
    button('sea-area-clear').click()
    await nextTick()
    expect(count()).toContain('已放置 0 个顶点')
    expect(button('sea-area-clear').disabled).toBe(true)
    // 父组件区域不被弹窗内编辑改写。
    expect(polygon).toHaveLength(3)
    wrapper.unmount()
  })

  it('达到上限后不再追加顶点并提示', async () => {
    const wrapper = await open()
    for (let index = 0; index < SEA_POLYGON_LIMITS.maxPoints; index += 1) await click(118 + index * 0.01, 24 + (index % 2) * 0.1)
    expect(count()).toContain(`已放置 ${SEA_POLYGON_LIMITS.maxPoints} 个顶点`)
    expect(document.body.textContent).toContain('已达上限')
    await click(120, 25)
    expect(count()).toContain(`已放置 ${SEA_POLYGON_LIMITS.maxPoints} 个顶点`)
    wrapper.unmount()
  })

  it('取消与关闭释放地图；重新打开时按最新保存区域重置并重建地图', async () => {
    const wrapper = await open()
    await click(118, 24)
    const footer = Array.from(document.querySelectorAll<HTMLButtonElement>('.el-dialog__footer button'))
    footer.find(item => item.textContent?.includes('取消'))!.click()
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    const dialog = wrapper.getComponent({ name: 'ElDialog' })
    dialog.vm.$emit('update:modelValue', false)
    expect(wrapper.emitted('update:modelValue')).toEqual([[false], [false]])
    dialog.vm.$emit('closed')
    expect(leafletMocks.map.remove).toHaveBeenCalledOnce()
    // 地图已释放时撤销只更新顶点，不再操作图层。
    leafletMocks.group.remove.mockClear()
    button('sea-area-undo').click()
    await nextTick()
    expect(leafletMocks.group.remove).not.toHaveBeenCalled()
    const typedWrapper = wrapper as unknown as VueWrapper<{ $props: { modelValue: boolean; polygon?: GeoPoint[] } }>
    await typedWrapper.setProps({ modelValue: false })
    await typedWrapper.setProps({ modelValue: true, polygon: [{ longitude: 120, latitude: 23 }] })
    expect(count()).toContain('已放置 1 个顶点')
    dialog.vm.$emit('opened')
    dialog.vm.$emit('opened')
    await nextTick()
    // 重复 opened 先释放旧实例再初始化，避免重复绑定。
    expect(L.map).toHaveBeenCalledTimes(3)
    expect(leafletMocks.map.remove).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
})

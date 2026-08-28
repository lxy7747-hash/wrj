import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import L from 'leaflet'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAP_CONFIG } from '../../src/config/map.config'
import type { SituationLinkView } from '../../src/features/situation/situation-model'
import {
  SITUATION_FRAME_F00042,
  SITUATION_LINKS_F00042,
} from '../../src/features/situation/situation-model'

type SituationMapControllerOptions = {
  onSelectNode: (platformId: string) => void
  onSelectLink: (link: SituationLinkView) => void
}

const mapControllerMock = vi.hoisted(() => {
  const controller = {
    setLinks: vi.fn(),
    setSelectedNodeId: vi.fn(),
    setLayerVisible: vi.fn(),
    setTheme: vi.fn(),
    setBasemap: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    reset: vi.fn(),
    destroy: vi.fn(),
  }

  return {
    controller,
    latestOptions: null as SituationMapControllerOptions | null,
    createSituationMapController: vi.fn((options: SituationMapControllerOptions) => {
      mapControllerMock.latestOptions = options
      return controller
    }),
  }
})

const offlineLabelLayerMock = vi.hoisted(() => ({
  create: vi.fn(),
  latestLayer: null as (L.Layer & { setTheme: (theme: 'dark' | 'light') => void }) | null,
  setTheme: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('leaflet.vectorgrid', () => ({}))

vi.mock('../../src/components/situation/offline-vector-label-layer', () => ({
  createOfflineVectorLabelLayer: offlineLabelLayerMock.create,
}))

vi.mock('../../src/components/situation/situation-map-controller', () => ({
  createSituationMapController: mapControllerMock.createSituationMapController,
}))

import SituationPage from '../../src/pages/situation.vue'

describe('态势主界面', () => {
  let mountedWrapper: ReturnType<typeof mount> | null = null

  /**
   * 挂载态势主界面并登记为当前测试的待清理实例。
   * @returns 已挂载的态势页面包装器。
   * @sideeffect 向 document.body 添加页面及 Element Plus 的关联 DOM。
   */
  function mountSituationPage() {
    mountedWrapper = mount(SituationPage, {
      attachTo: document.body,
      global: {
        plugins: [ElementPlus],
        stubs: { RouterLink: { template: '<a><slot /></a>' } },
      },
    })
    return mountedWrapper
  }

  beforeEach(() => {
    mapControllerMock.latestOptions = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    mountedWrapper?.unmount()
    mountedWrapper = null
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('呈现原型要求的关键区域且不发起网络请求', () => {
    const fetchSpy = vi.fn()
    const webSocketSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('WebSocket', webSocketSpy)

    const wrapper = mountSituationPage()

    expect(wrapper.get('#situation-title').text()).toBe('态势主界面')
    expect(wrapper.get('[aria-label="仿真控制"]')).toBeTruthy()
    expect(wrapper.get('[aria-label="场景配置摘要"]')).toBeTruthy()
    expect(wrapper.get('[aria-label="Leaflet 离线态势图"]')).toBeTruthy()
    expect(wrapper.get('[data-testid="leaflet-situation-map"]')).toBeTruthy()
    expect(wrapper.get('[aria-label="链路、干扰与事件"]')).toBeTruthy()
    expect(wrapper.findAll('tr[data-link-id]')).toHaveLength(4)
    expect(wrapper.findAll('[data-frame-id="F-00042"]').length).toBeGreaterThanOrEqual(3)
    expect(wrapper.get('[data-testid="frame-freshness"]').text()).toBe('最大数据年龄 0 ms · 新鲜')
    expect(wrapper.get('[data-testid="business-node-capacity"]').text()).toBe('4 / 50')
    expect(wrapper.text()).toContain('4 类业务信息节点')
    expect(wrapper.text()).toContain('4 类链路')
    expect(wrapper.text()).toContain('2 种干扰设备')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(webSocketSpy).not.toHaveBeenCalled()
  })

  it('在开始后锁定摘要并在确认停止后解锁', async () => {
    const wrapper = mountSituationPage()

    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    expect(wrapper.text()).toContain('配置已锁定')
    expect(wrapper.text()).toContain('运行中')

    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    expect(wrapper.text()).toContain('已暂停')

    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    await flushPromises()
    const confirmButton = document.querySelector<HTMLElement>('[data-testid="confirm-stop"]')
    expect(confirmButton).not.toBeNull()
    confirmButton?.click()
    await flushPromises()

    expect(wrapper.text()).toContain('配置可查看')
    expect(wrapper.get('[data-testid="simulation-clock"]').text()).toBe('T+ 00:00:00')
  })

  it('展示 L-DL-03 的劣化详情并区分只有摘要的链路', async () => {
    const wrapper = mountSituationPage()

    await wrapper.get('tr[data-link-id="L-DL-03"]').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('界面状态劣化')
    expect(document.body.textContent).toContain('规范状态中断')
    expect(document.body.textContent).toContain('数据年龄0 ms')
    expect(document.body.textContent).toContain('数据新鲜度新鲜')

    const closeButton = document.querySelector<HTMLElement>('.el-dialog__headerbtn')
    closeButton?.click()
    await flushPromises()
    await wrapper.get('tr[data-link-id="L-SAT-02"]').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('当前帧仅提供摘要')
  })

  it('通过 Leaflet 控制器同步图层、视图、选择和销毁', async () => {
    const wrapper = mountSituationPage()
    const options = mapControllerMock.latestOptions

    expect(options).not.toBeNull()
    const layerButtons = wrapper.get('[aria-label="态势图层"]').findAll('button')
    expect(layerButtons.slice(0, 4)).toHaveLength(4)
    await layerButtons[0].trigger('click')
    expect(mapControllerMock.controller.setLayerVisible).toHaveBeenCalledWith('nodes', false)

    const mapSection = wrapper.get('[aria-label="Leaflet 离线态势图"]')
    const themeButton = wrapper.get('[aria-label="切换为深色地图"]')
    expect(mapSection.attributes('data-map-theme')).toBe('light')
    expect(mapSection.attributes('data-map-basemap')).toBe('vector')
    expect(themeButton.text()).toBe('地图：浅色')
    expect(wrapper.get('[aria-label="切换为卫星底图"]').text()).toBe('底图：矢量')
    expect(wrapper.get('[aria-label="态势图层"]').text()).toContain('离线矢量')
    expect(wrapper.get('[aria-label="态势图层"]').text()).toContain('Z10')

    await wrapper.get('[aria-label="切换为卫星底图"]').trigger('click')
    expect(mapControllerMock.controller.setBasemap).toHaveBeenNthCalledWith(1, 'satellite')
    expect(mapSection.attributes('data-map-basemap')).toBe('satellite')
    expect(wrapper.get('[aria-label="切换为矢量底图"]').text()).toBe('底图：卫星')
    expect(wrapper.get('[aria-label="态势图层"]').text()).toContain('离线卫星')

    await wrapper.get('[aria-label="切换为矢量底图"]').trigger('click')
    expect(mapControllerMock.controller.setBasemap).toHaveBeenNthCalledWith(2, 'vector')
    expect(mapSection.attributes('data-map-basemap')).toBe('vector')

    await themeButton.trigger('click')
    expect(mapControllerMock.controller.setTheme).toHaveBeenNthCalledWith(1, 'dark')
    expect(mapSection.attributes('data-map-theme')).toBe('dark')
    expect(wrapper.get('[aria-label="切换为浅色地图"]').text()).toBe('地图：深色')

    await wrapper.get('[aria-label="切换为浅色地图"]').trigger('click')
    expect(mapControllerMock.controller.setTheme).toHaveBeenNthCalledWith(2, 'light')
    expect(mapSection.attributes('data-map-theme')).toBe('light')
    expect(wrapper.get('[aria-label="切换为深色地图"]').text()).toBe('地图：浅色')

    await wrapper.get('[aria-label="放大态势图"]').trigger('click')
    await wrapper.get('[aria-label="缩小态势图"]').trigger('click')
    await wrapper.get('.offline-map__layerbar button:last-child').trigger('click')
    expect(mapControllerMock.controller.zoomIn).toHaveBeenCalledOnce()
    expect(mapControllerMock.controller.zoomOut).toHaveBeenCalledOnce()
    expect(mapControllerMock.controller.reset).toHaveBeenCalledOnce()

    options?.onSelectNode('SAT-01')
    await flushPromises()
    expect(mapControllerMock.controller.setSelectedNodeId).toHaveBeenCalledWith('SAT-01')
    const satelliteCard = wrapper.get('[data-testid="selected-node-card"]')
    expect(satelliteCard.text()).toContain('通信卫星')
    expect(satelliteCard.text()).toContain('原始位置')
    expect(satelliteCard.text()).toContain('地图采用台海任务展示投影，不改变固定帧原始遥测。')
    expect(satelliteCard.text()).toContain('卫星地图位置为轨道示意，非真实轨道位置。')

    options?.onSelectLink(SITUATION_LINKS_F00042[0])
    await flushPromises()
    expect(document.querySelector('.link-quality-dialog')).not.toBeNull()
    expect(document.body.textContent).toContain('链路质量详情')

    wrapper.unmount()
    mountedWrapper = null
    expect(mapControllerMock.controller.destroy).toHaveBeenCalledOnce()
  })
})

describe('Leaflet 控制器回归', () => {
  type MockVectorGridLayer = L.Layer & {
    options: L.LayerOptions & { vectorTileLayerStyles: Record<string, unknown> }
    redraw: ReturnType<typeof vi.fn>
  }

  type LeafletWithVectorGrid = typeof L & {
    canvas: typeof L.canvas & { tile: unknown }
    vectorGrid: { protobuf: ReturnType<typeof vi.fn> }
  }

  const leaflet = L as LeafletWithVectorGrid
  let container: HTMLDivElement | null = null
  let vectorGridLayer: MockVectorGridLayer | null = null
  const activeControllers = new Set<{ destroy: () => void }>()

  async function createController(options: {
    onSelectNode?: (platformId: string) => void
    onSelectLink?: (link: SituationLinkView) => void
    onZoomChange?: (zoom: number) => void
  } = {}) {
    vi.resetModules()
    vi.doUnmock('../../src/components/situation/situation-map-controller')
    const { createSituationMapController } = await import('../../src/components/situation/situation-map-controller')

    container = document.createElement('div')
    container.style.width = '800px'
    container.style.height = '500px'
    document.body.append(container)

    const controller = createSituationMapController({
      container,
      links: SITUATION_LINKS_F00042,
      selectedNodeId: 'CMD-01',
      onSelectNode: options.onSelectNode ?? vi.fn(),
      onSelectLink: options.onSelectLink ?? vi.fn(),
      onZoomChange: options.onZoomChange ?? vi.fn(),
    })
    activeControllers.add(controller)
    return controller
  }

  beforeEach(() => {
    leaflet.canvas.tile = {}
    leaflet.vectorGrid = {
      protobuf: vi.fn((_url: string, options: MockVectorGridLayer['options']) => {
        const layer = L.layerGroup() as unknown as MockVectorGridLayer
        layer.options = { ...options }
        layer.redraw = vi.fn(() => layer)
        vectorGridLayer = layer
        return layer
      }),
    }
    vectorGridLayer = null
    offlineLabelLayerMock.latestLayer = null
    offlineLabelLayerMock.setTheme = vi.fn()
    offlineLabelLayerMock.removeListener = vi.fn()
    offlineLabelLayerMock.create.mockImplementation(() => {
      const layer = L.layerGroup() as unknown as L.Layer & {
        setTheme: (theme: 'dark' | 'light') => void
      }
      layer.setTheme = offlineLabelLayerMock.setTheme
      layer.on('remove', offlineLabelLayerMock.removeListener)
      offlineLabelLayerMock.latestLayer = layer
      return layer
    })
  })

  afterEach(() => {
    activeControllers.forEach((controller) => controller.destroy())
    activeControllers.clear()
    container?.remove()
    container = null
    vectorGridLayer = null
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('链路 props 筛选和重排后保持几何与交互绑定', async () => {
    const onSelectLink = vi.fn()
    const polylineSpy = vi.spyOn(L, 'polyline')
    const controller = await createController({ onSelectLink })
    const [firstLink, secondLink] = SITUATION_LINKS_F00042
    const filteredLinks = [secondLink, firstLink]

    polylineSpy.mockClear()
    controller.setLinks([firstLink, secondLink])
    const originalCurves = polylineSpy.mock.calls.map(([points]) => points)

    polylineSpy.mockClear()
    controller.setLinks(filteredLinks)
    const reorderedCurves = polylineSpy.mock.calls.map(([points]) => points)
    const reorderedLines = polylineSpy.mock.results.map(({ value }) => value as L.Polyline)

    expect(reorderedCurves).toHaveLength(2)
    expect(reorderedCurves[0]).toEqual(originalCurves[1])
    expect(reorderedCurves[1]).toEqual(originalCurves[0])

    reorderedLines[0]?.fire('click')
    reorderedLines[1]?.fire('click')
    expect(onSelectLink).toHaveBeenNthCalledWith(1, secondLink)
    expect(onSelectLink).toHaveBeenNthCalledWith(2, firstLink)

    controller.destroy()
  })

  it('初始和重置视图均使用台海区域与配置的缩放范围', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const fitBoundsSpy = vi.spyOn(L.Map.prototype, 'fitBounds')
    const controller = await createController()

    expect(mapSpy).toHaveBeenCalledWith(
      container,
      expect.objectContaining({
        minZoom: MAP_CONFIG.zoom.min,
        maxZoom: MAP_CONFIG.zoom.max,
        zoomSnap: MAP_CONFIG.zoom.snap,
      }),
    )
    expect(MAP_CONFIG.defaults).toEqual({ theme: 'light', basemap: 'vector', zoom: 10 })
    expect(MAP_CONFIG.taskBounds).toEqual([[21.8, 117], [26.4, 123]])
    expect(MAP_CONFIG.fitPadding).toEqual([24, 24])
    expect(MAP_CONFIG.gridIntervalDegrees).toBe(0.5)
    expect(fitBoundsSpy).toHaveBeenCalledOnce()

    controller.reset()
    expect(fitBoundsSpy).toHaveBeenCalledTimes(2)
    const boundsCalls = fitBoundsSpy.mock.calls.map(([bounds]) => bounds as L.LatLngBounds)
    boundsCalls.forEach((bounds) => {
      expect(bounds.getSouth()).toBe(21.8)
      expect(bounds.getWest()).toBe(117)
      expect(bounds.getNorth()).toBe(26.4)
      expect(bounds.getEast()).toBe(123)
    })
    fitBoundsSpy.mock.calls.forEach(([, fitOptions]) => {
      expect(fitOptions).toEqual(expect.objectContaining({ padding: [24, 24], animate: false }))
    })

    controller.destroy()
  })

  it('在同一 VectorGrid 上幂等换肤且保持视图与关闭的经纬网状态', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const layerGroupSpy = vi.spyOn(L, 'layerGroup')
    const controller = await createController()
    const map = mapSpy.mock.results[0]?.value as L.Map
    const gridGroup = layerGroupSpy.mock.results[3]?.value as L.LayerGroup
    const originalStyles = vectorGridLayer?.options.vectorTileLayerStyles
    const originalCenter = map.getCenter()
    const originalZoom = map.getZoom()

    expect(leaflet.vectorGrid.protobuf).toHaveBeenCalledOnce()
    expect((originalStyles?.ocean as L.PathOptions).fillColor).toBe('#cfe8f3')
    expect(offlineLabelLayerMock.create).toHaveBeenCalledWith('light')
    controller.setTheme('light')
    expect(vectorGridLayer?.redraw).not.toHaveBeenCalled()
    expect(offlineLabelLayerMock.setTheme).not.toHaveBeenCalled()

    controller.setLayerVisible('grid', false)
    expect(map.hasLayer(gridGroup)).toBe(false)
    controller.setTheme('dark')

    expect(leaflet.vectorGrid.protobuf).toHaveBeenCalledOnce()
    expect(vectorGridLayer?.options.vectorTileLayerStyles).not.toBe(originalStyles)
    expect(vectorGridLayer?.redraw).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.setTheme).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.setTheme).toHaveBeenCalledWith('dark')
    expect(vectorGridLayer?.redraw.mock.invocationCallOrder[0])
      .toBeLessThan(offlineLabelLayerMock.setTheme.mock.invocationCallOrder[0] as number)
    expect(map.getCenter()).toEqual(originalCenter)
    expect(map.getZoom()).toBe(originalZoom)
    expect(map.hasLayer(gridGroup)).toBe(false)

    const darkGridLine = gridGroup.getLayers().find((layer) => layer instanceof L.Polyline) as L.Polyline
    const darkGridLabel = gridGroup.getLayers().find((layer) => layer instanceof L.Marker) as L.Marker
    const darkGridLabelElement = (darkGridLabel.options.icon as L.DivIcon).options.html as HTMLElement
    expect(darkGridLine.options.color).toBe('#31506a')
    expect(darkGridLabelElement.style.color).toBe('rgb(102, 132, 154)')
    expect(darkGridLabelElement.style.textShadow).toContain('#06111d')

    controller.setTheme('light')
    expect(vectorGridLayer?.redraw).toHaveBeenCalledTimes(2)
    expect(offlineLabelLayerMock.setTheme).toHaveBeenCalledTimes(2)
    expect(offlineLabelLayerMock.setTheme).toHaveBeenLastCalledWith('light')
    expect(map.getCenter()).toEqual(originalCenter)
    expect(map.getZoom()).toBe(originalZoom)
    expect(map.hasLayer(gridGroup)).toBe(false)

    const lightGridLine = gridGroup.getLayers().find((layer) => layer instanceof L.Polyline) as L.Polyline
    const lightGridLabel = gridGroup.getLayers().find((layer) => layer instanceof L.Marker) as L.Marker
    const gridLabelElement = (lightGridLabel.options.icon as L.DivIcon).options.html as HTMLElement
    expect(lightGridLine.options.color).toBe('#667f91')
    expect(gridLabelElement.style.color).toBe('rgb(66, 92, 109)')
    expect(gridLabelElement.style.textShadow).toContain('#f7fbfd')

    const lightStyles = vectorGridLayer?.options.vectorTileLayerStyles as Record<
      string,
      L.PathOptions | ((properties: Record<string, unknown>, zoom: number) => L.PathOptions)
    >
    const streetStyle = lightStyles.streets as (
      properties: Record<string, unknown>,
      zoom: number,
    ) => L.PathOptions
    expect(streetStyle({ kind: 'motorway' }, 12).color).toBe('#d98b18')
    expect(streetStyle({ kind: 'trunk' }, 12).color).toBe('#e5a536')
    expect(streetStyle({ kind: 'primary' }, 12).color).toBe('#efbd63')
    expect(streetStyle({ kind: 'residential' }, 12).color).toBe('#8d969b')
    expect(streetStyle({ kind: 42 }, 9)).toMatchObject({
      color: '#a7adb0',
      weight: 0.75,
      opacity: 0.7,
    })
    expect(streetStyle({}, 11)).toMatchObject({
      color: '#a7adb0',
      weight: 0.75,
      opacity: 0.9,
    })

    controller.setTheme('dark')
    const darkStyles = vectorGridLayer?.options.vectorTileLayerStyles as Record<
      string,
      L.PathOptions | ((properties: Record<string, unknown>, zoom: number) => L.PathOptions)
    >
    const darkStreetStyle = darkStyles.streets as (
      properties: Record<string, unknown>,
      zoom: number,
    ) => L.PathOptions
    expect(darkStreetStyle({}, 12)).toMatchObject({
      color: '#496579',
      weight: 1.35,
      opacity: 0.8,
    })
    expect(darkStreetStyle({}, 9)).toMatchObject({
      color: '#354f63',
      weight: 0.75,
      opacity: 0.55,
    })

    controller.setTheme('dark')
    expect(vectorGridLayer?.redraw).toHaveBeenCalledTimes(3)
    expect(offlineLabelLayerMock.setTheme).toHaveBeenCalledTimes(3)

    controller.destroy()
  })

  it('复用唯一底图实例切换并保持视图、隐藏业务层和卫星期间更新的主题', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const tileLayerSpy = vi.spyOn(L, 'tileLayer')
    const layerGroupSpy = vi.spyOn(L, 'layerGroup')
    const fitBoundsSpy = vi.spyOn(L.Map.prototype, 'fitBounds')
    const controller = await createController()
    const map = mapSpy.mock.results[0]?.value as L.Map
    const vectorLayer = vectorGridLayer as MockVectorGridLayer
    const labelLayer = offlineLabelLayerMock.latestLayer as L.Layer & {
      setTheme: (theme: 'dark' | 'light') => void
    }
    const satelliteLayer = tileLayerSpy.mock.results[0]?.value as L.TileLayer
    const interferenceGroup = layerGroupSpy.mock.results[2]?.value as L.LayerGroup
    const vectorRemoveSpy = vi.spyOn(vectorLayer, 'removeFrom')
    const vectorAddSpy = vi.spyOn(vectorLayer, 'addTo')
    const labelRemoveSpy = vi.spyOn(labelLayer, 'removeFrom')
    const labelAddSpy = vi.spyOn(labelLayer, 'addTo')
    const satelliteRemoveSpy = vi.spyOn(satelliteLayer, 'removeFrom')
    const satelliteAddSpy = vi.spyOn(satelliteLayer, 'addTo')

    expect(mapSpy).toHaveBeenCalledOnce()
    expect(leaflet.vectorGrid.protobuf).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.create).toHaveBeenCalledOnce()
    expect(tileLayerSpy).toHaveBeenCalledOnce()
    expect(tileLayerSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4174/tiles/taiwan-strait-satellite/{z}/{x}/{y}',
      {
        minZoom: MAP_CONFIG.zoom.min,
        maxNativeZoom: MAP_CONFIG.resources.satellite.maxNativeZoom,
        maxZoom: MAP_CONFIG.zoom.max,
        pane: 'tilePane',
        attribution: 'VersaTiles - Satellite + Orthophotos',
      },
    )
    expect(map.hasLayer(vectorLayer)).toBe(true)
    expect(map.hasLayer(labelLayer)).toBe(true)
    expect(map.hasLayer(satelliteLayer)).toBe(false)

    map.setView([24.1, 119.2], 9, { animate: false })
    controller.setLayerVisible('interference', false)
    const originalCenter = map.getCenter()
    const originalZoom = map.getZoom()

    controller.setBasemap('vector')
    expect(vectorRemoveSpy).not.toHaveBeenCalled()
    expect(satelliteAddSpy).not.toHaveBeenCalled()

    controller.setBasemap('satellite')
    controller.setBasemap('satellite')
    expect(vectorRemoveSpy).toHaveBeenCalledOnce()
    expect(labelRemoveSpy).toHaveBeenCalledOnce()
    expect(satelliteAddSpy).toHaveBeenCalledOnce()
    expect(map.hasLayer(vectorLayer)).toBe(false)
    expect(map.hasLayer(labelLayer)).toBe(false)
    expect(map.hasLayer(satelliteLayer)).toBe(true)

    controller.setTheme('dark')
    expect(vectorLayer.redraw).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.setTheme).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.setTheme).toHaveBeenCalledWith('dark')

    controller.setBasemap('vector')
    controller.setBasemap('vector')
    expect(satelliteRemoveSpy).toHaveBeenCalledOnce()
    expect(vectorAddSpy).toHaveBeenCalledOnce()
    expect(labelAddSpy).toHaveBeenCalledOnce()
    expect(map.hasLayer(vectorLayer)).toBe(true)
    expect(map.hasLayer(labelLayer)).toBe(true)
    expect(map.hasLayer(satelliteLayer)).toBe(false)
    expect(map.getCenter()).toEqual(originalCenter)
    expect(map.getZoom()).toBe(originalZoom)
    expect(map.hasLayer(interferenceGroup)).toBe(false)
    expect(mapSpy).toHaveBeenCalledOnce()
    expect(leaflet.vectorGrid.protobuf).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.create).toHaveBeenCalledOnce()
    expect(tileLayerSpy).toHaveBeenCalledOnce()
    expect(fitBoundsSpy).toHaveBeenCalledOnce()

    controller.destroy()
  })

  it('在卫星底图模式下销毁可重复调用且只清理一次地图', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const tileLayerSpy = vi.spyOn(L, 'tileLayer')
    const controller = await createController()
    const map = mapSpy.mock.results[0]?.value as L.Map
    const satelliteLayer = tileLayerSpy.mock.results[0]?.value as L.TileLayer
    const mapRemoveSpy = vi.spyOn(map, 'remove')
    const satelliteRemoveListener = vi.fn()
    satelliteLayer.on('remove', satelliteRemoveListener)

    controller.setBasemap('satellite')
    controller.destroy()
    controller.destroy()

    expect(mapRemoveSpy).toHaveBeenCalledOnce()
    expect(satelliteRemoveListener).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.removeListener).toHaveBeenCalledOnce()
  })

  it('用唯一台海展示投影生成六个平台、链路端点与命中点和干扰圈', async () => {
    const markerSpy = vi.spyOn(L, 'marker')
    const polylineSpy = vi.spyOn(L, 'polyline')
    const circleSpy = vi.spyOn(L, 'circle')
    const controller = await createController()
    const expectedPoints: Readonly<Record<string, L.LatLngTuple>> = {
      'CMD-01': [24.45, 118.15],
      'UAV-01': [24.70, 119.35],
      'GCC-01': [23.55, 118.65],
      'AIR-01': [23.95, 120.15],
      'SAT-01': [25.75, 121.25],
      'STN-01': [25.25, 119.55],
    }
    expect(MAP_CONFIG.displayProjection).toEqual(expectedPoints)

    const nodeCalls = markerSpy.mock.calls.filter(([, options]) => (
      typeof options?.title === 'string' && options.title.startsWith('选择节点 ')
    ))
    expect(nodeCalls).toHaveLength(6)
    SITUATION_FRAME_F00042.platforms.forEach((platform) => {
      const call = nodeCalls.find(([, options]) => options?.title?.includes(platform.name))
      expect(call?.[0]).toEqual(expectedPoints[platform.platformId])
    })

    const linkCurves = polylineSpy.mock.calls
      .filter(([, options]) => options?.interactive === true)
      .map(([points]) => points as L.LatLngTuple[])
    const linkKeyboardCalls = markerSpy.mock.calls.filter(([, options]) => (
      typeof options?.title === 'string' && !options.title.startsWith('选择节点 ')
    ))
    const controlOffsets = [-0.18, -0.06, 0.06, 0.18] as const
    expect(MAP_CONFIG.linkCurveOffsets).toEqual(controlOffsets)
    expect(MAP_CONFIG.curveSampleCount).toBe(32)
    expect(linkCurves).toHaveLength(4)
    expect(linkKeyboardCalls).toHaveLength(4)
    SITUATION_FRAME_F00042.linkSummaries.forEach((summary, index) => {
      const curve = linkCurves[index] as L.LatLngTuple[]
      const source = expectedPoints[summary.sourcePlatform] as L.LatLngTuple
      const destination = expectedPoints[summary.destPlatform] as L.LatLngTuple
      expect(curve[0]).toEqual(source)
      expect(curve[curve.length - 1]).toEqual(destination)
      expect(linkKeyboardCalls[index]?.[0]).toEqual(curve[16])
      expect(curve[16]?.[0]).toBeCloseTo(
        (source[0] + destination[0]) / 2 + controlOffsets[index] / 2,
      )
      expect(curve[16]?.[1]).toBeCloseTo(
        (source[1] + destination[1]) / 2 + controlOffsets[index] / 2,
      )
    })

    const activePlatforms = SITUATION_FRAME_F00042.platforms
      .filter((platform) => platform.jammers.some((jammer) => jammer.active))
    expect(circleSpy).toHaveBeenCalledTimes(activePlatforms.length)
    activePlatforms.forEach((platform, index) => {
      expect(circleSpy.mock.calls[index]?.[0]).toEqual(expectedPoints[platform.platformId])
      const circleOptions = circleSpy.mock.calls[index]?.[1] as unknown as L.CircleOptions
      expect(circleOptions.radius).toBe(12000)
    })
    expect(MAP_CONFIG.activeInterferenceRadiusMeters).toBe(12000)

    controller.destroy()
  })

  it('按底图、离线标注和业务图层的顺序挂载，并在销毁时清理标注图层', async () => {
    const mapSpy = vi.spyOn(L, 'map')
    const controller = await createController()
    const map = mapSpy.mock.results[0]?.value as L.Map
    const tilePane = map.getPane('tilePane')
    const labelPane = map.getPane('offline-label-pane')
    const overlayPane = map.getPane('overlayPane')

    expect(tilePane).not.toBeNull()
    expect(labelPane).not.toBeNull()
    expect(overlayPane).not.toBeNull()
    expect(labelPane?.style.zIndex).toBe('350')
    expect(Number(tilePane?.style.zIndex || '200')).toBeLessThan(Number(labelPane?.style.zIndex || '350'))
    expect(Number(labelPane?.style.zIndex || '350')).toBeLessThan(Number(overlayPane?.style.zIndex || '400'))
    expect(labelPane?.style.pointerEvents).toBe('none')
    expect(offlineLabelLayerMock.create).toHaveBeenCalledOnce()
    expect(offlineLabelLayerMock.latestLayer).not.toBeNull()
    expect(leaflet.vectorGrid.protobuf).toHaveBeenCalledWith(
      'http://127.0.0.1:4174/tiles/china-taiwan-260823/{z}/{x}/{y}',
      expect.objectContaining({
        maxNativeZoom: MAP_CONFIG.resources.vector.maxNativeZoom,
        maxZoom: MAP_CONFIG.zoom.max,
        pane: 'tilePane',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }),
    )

    controller.setLayerVisible('nodes', false)
    controller.setLayerVisible('links', false)
    controller.setLayerVisible('interference', false)
    controller.setLayerVisible('grid', false)
    controller.setLayerVisible('nodes', true)
    controller.setLayerVisible('links', true)
    controller.setLayerVisible('interference', true)
    controller.setLayerVisible('grid', true)

    controller.destroy()
    controller.destroy()
    expect(offlineLabelLayerMock.removeListener).toHaveBeenCalledOnce()
  })

  it('节点 Enter 和空格键各选择一次', async () => {
    const onSelectNode = vi.fn()
    const markerSpy = vi.spyOn(L, 'marker')
    const controller = await createController({ onSelectNode })
    const node = container?.querySelector<HTMLElement>('[title="选择节点 高空前出中继节点"]')
    const nodeMarker = markerSpy.mock.results.find(({ value }) => (
      (value as L.Marker).options.title === '选择节点 高空前出中继节点'
    ))?.value as L.Marker | undefined

    expect(node).not.toBeNull()
    nodeMarker?.fire('click')
    expect(onSelectNode).toHaveBeenCalledOnce()
    expect(onSelectNode).toHaveBeenCalledWith('UAV-01')

    onSelectNode.mockClear()
    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    node?.dispatchEvent(escapeEvent)
    expect(escapeEvent.defaultPrevented).toBe(false)
    expect(onSelectNode).not.toHaveBeenCalled()

    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    node?.dispatchEvent(enterEvent)
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(onSelectNode).toHaveBeenCalledOnce()
    expect(onSelectNode).toHaveBeenCalledWith('UAV-01')

    onSelectNode.mockClear()
    const spaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    node?.dispatchEvent(spaceEvent)
    expect(spaceEvent.defaultPrevented).toBe(true)
    expect(onSelectNode).toHaveBeenCalledOnce()
    expect(onSelectNode).toHaveBeenCalledWith('UAV-01')

    controller.destroy()
  })

  it('链路 Enter 和空格键各选择一次且焦点可见', async () => {
    const onSelectLink = vi.fn()
    const markerSpy = vi.spyOn(L, 'marker')
    const controller = await createController({ onSelectLink })
    const link = container?.querySelector<HTMLElement>('.situation-map-link-keyboard-hit[title]')
    const linkMarker = markerSpy.mock.results.find(({ value }) => (
      (value as L.Marker).options.title === link?.title
    ))?.value as L.Marker | undefined

    expect(link).not.toBeNull()
    expect(link?.style.opacity).not.toBe('0')
    link?.focus()
    expect(document.activeElement).toBe(link)

    linkMarker?.fire('click')
    expect(onSelectLink).toHaveBeenCalledOnce()
    expect(onSelectLink).toHaveBeenCalledWith(SITUATION_LINKS_F00042[0])

    onSelectLink.mockClear()
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    link?.dispatchEvent(enterEvent)
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(onSelectLink).toHaveBeenCalledOnce()
    expect(onSelectLink).toHaveBeenCalledWith(SITUATION_LINKS_F00042[0])

    onSelectLink.mockClear()
    const spaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    link?.dispatchEvent(spaceEvent)
    expect(spaceEvent.defaultPrevented).toBe(true)
    expect(onSelectLink).toHaveBeenCalledOnce()
    expect(onSelectLink).toHaveBeenCalledWith(SITUATION_LINKS_F00042[0])

    controller.destroy()
  })

  it('通过 ResizeObserver 刷新尺寸、上报缩放并清理观察器', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    const observe = vi.fn()
    const disconnect = vi.fn()
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
      }

      observe = observe
      unobserve = vi.fn()
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const invalidateSizeSpy = vi.spyOn(L.Map.prototype, 'invalidateSize')
    const mapSpy = vi.spyOn(L, 'map')
    const onZoomChange = vi.fn()
    const controller = await createController({ onZoomChange })
    const map = mapSpy.mock.results[0]?.value as L.Map
    const resizeCallback = resizeCallbacks[0]

    expect(observe).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledWith(container)
    expect(resizeCallback).toBeTypeOf('function')
    if (!resizeCallback) throw new Error('ResizeObserver callback was not registered')
    invalidateSizeSpy.mockClear()
    resizeCallback([] as ResizeObserverEntry[], {} as ResizeObserver)
    expect(invalidateSizeSpy).toHaveBeenCalledOnce()
    expect(invalidateSizeSpy).toHaveBeenCalledWith({ pan: false })

    map.fire('zoomend')
    expect(onZoomChange).toHaveBeenLastCalledWith(map.getZoom())

    controller.destroy()
    expect(disconnect).toHaveBeenCalledOnce()
    resizeCallback([] as ResizeObserverEntry[], {} as ResizeObserver)
    expect(invalidateSizeSpy).toHaveBeenCalledOnce()
  })

  it('在缺少 ResizeObserver 时使用并移除窗口尺寸监听', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const invalidateSizeSpy = vi.spyOn(L.Map.prototype, 'invalidateSize')
    const controller = await createController()
    const resizeRegistrations = addEventListenerSpy.mock.calls.filter(([type]) => type === 'resize')
    const resizeHandler = resizeRegistrations[resizeRegistrations.length - 1]?.[1] as EventListener

    invalidateSizeSpy.mockClear()
    resizeHandler(new Event('resize'))
    expect(invalidateSizeSpy).toHaveBeenCalledOnce()

    controller.destroy()
    expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', resizeHandler)
    resizeHandler(new Event('resize'))
    expect(invalidateSizeSpy).toHaveBeenCalledOnce()
  })

  it('同值更新与销毁后的全部控制命令保持无副作用', async () => {
    const markerSpy = vi.spyOn(L, 'marker')
    const polylineSpy = vi.spyOn(L, 'polyline')
    const layerGroupSpy = vi.spyOn(L, 'layerGroup')
    const mapSpy = vi.spyOn(L, 'map')
    const controller = await createController()
    const map = mapSpy.mock.results[0]?.value as L.Map
    const nodesGroup = layerGroupSpy.mock.results[0]?.value as L.LayerGroup
    const nodesAddSpy = vi.spyOn(nodesGroup, 'addTo')

    markerSpy.mockClear()
    controller.setSelectedNodeId('CMD-01')
    controller.setLayerVisible('nodes', true)
    expect(markerSpy).not.toHaveBeenCalled()
    expect(nodesAddSpy).not.toHaveBeenCalled()

    const zoomInSpy = vi.spyOn(map, 'zoomIn')
    const zoomOutSpy = vi.spyOn(map, 'zoomOut')
    const fitBoundsSpy = vi.spyOn(map, 'fitBounds')
    controller.destroy()
    markerSpy.mockClear()
    polylineSpy.mockClear()

    expect(() => {
      controller.setLinks(SITUATION_LINKS_F00042)
      controller.setSelectedNodeId('UAV-01')
      controller.setLayerVisible('nodes', false)
      controller.setTheme('dark')
      controller.setBasemap('satellite')
      controller.zoomIn()
      controller.zoomOut()
      controller.reset()
      controller.destroy()
    }).not.toThrow()
    expect(markerSpy).not.toHaveBeenCalled()
    expect(polylineSpy).not.toHaveBeenCalled()
    expect(zoomInSpy).not.toHaveBeenCalled()
    expect(zoomOutSpy).not.toHaveBeenCalled()
    expect(fitBoundsSpy).not.toHaveBeenCalled()
  })

  it('按名称回退匹配链路并安全忽略无法解析的链路', async () => {
    const onSelectLink = vi.fn()
    const polylineSpy = vi.spyOn(L, 'polyline')
    const markerSpy = vi.spyOn(L, 'marker')
    const controller = await createController({ onSelectLink })
    const firstLink = SITUATION_LINKS_F00042[0]
    const fallbackLink: SituationLinkView = {
      ...firstLink,
      linkId: 'fallback-by-name',
      detailed: SITUATION_LINKS_F00042[1]?.detailed ?? null,
    }
    const unresolvedLink: SituationLinkView = {
      ...fallbackLink,
      linkId: 'unresolved-link',
      sourceName: '不存在的源节点',
      destinationName: '不存在的目标节点',
    }

    polylineSpy.mockClear()
    markerSpy.mockClear()
    controller.setLinks([fallbackLink, unresolvedLink])
    const interactiveLines = polylineSpy.mock.results
      .map(({ value }) => value as L.Polyline)
      .filter((line) => line.options.interactive === true)
    const linkMarkers = markerSpy.mock.results
      .map(({ value }) => value as L.Marker)
      .filter((marker) => marker.options.title?.includes(fallbackLink.sourceName))

    expect(interactiveLines).toHaveLength(1)
    expect(linkMarkers).toHaveLength(1)
    interactiveLines[0]?.fire('click')
    expect(onSelectLink).toHaveBeenCalledOnce()
    expect(onSelectLink).toHaveBeenCalledWith(fallbackLink)

    controller.destroy()
  })
})

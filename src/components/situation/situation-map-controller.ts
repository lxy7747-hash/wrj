import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.vectorgrid'

import { MAP_CONFIG } from '../../config/map.config'
import type { MapBasemap, MapTheme } from '../../config/map.config'
import type { Link, TelemetryFrame } from '../../contracts/domain-models'
import type { SituationMapNode } from '../../features/situation/initial-nodes'
import { FILE_COMMUNICATION_LABELS, type FileCommunicationLink } from '../../features/situation/file-communication-links'
import { fileJammerRadiusMeters, type FileDeviceEvent } from '../../features/situation/file-device-events'
import { createOfflineVectorLabelLayer } from './offline-vector-label-layer'
import {
  LINK_TYPE_LABELS,
  PLATFORM_TYPE_LABELS,
  type SituationLinkView,
} from '../../features/situation/situation-model'

export type MapLayer = 'nodes' | 'links' | 'interference' | 'grid'

export interface SituationMapFocusTarget {
  kind: 'node' | 'link' | 'interference'
  targetId: string
}

export interface SituationMapControllerOptions {
  container: HTMLElement
  frame: TelemetryFrame | null
  /** 真实文件节点，无完整遥测帧时使用；后续位置通过 setNodes 更新。 */
  initialNodes?: SituationMapNode[]
  fileLinks?: FileCommunicationLink[]
  fileDeviceStates?: FileDeviceEvent[]
  configuredLinks?: Link[]
  onSelectConfiguredLink?: (link: Link) => void
  onSelectFileLink?: (link: FileCommunicationLink) => void
  links: SituationLinkView[]
  selectedNodeId: string
  onSelectNode: (platformId: string) => void
  onSelectLink: (link: SituationLinkView) => void
  onZoomChange: (zoom: number) => void
}

export interface SituationMapController {
  setConfiguredLinks: (links: Link[] | undefined) => void
  /**
   * 替换地图当前展示的链路集合。
   * @param links 新的链路视图列表。
   * @returns 无返回值。
   * @sideeffect 按身份增删链路并更新已有曲线、样式和键盘交互数据。
   */
  setLinks: (links: SituationLinkView[]) => void

  /**
   * 替换地图当前使用的完整遥测帧。
   * @param frame 新的同帧节点、链路和干扰数据。
   * @returns 无返回值。
   * @sideeffect 增量更新业务图层并保留仍有效的选中目标。
   */
  setFrame: (frame: TelemetryFrame | null) => void

  /**
   * 同步真实文件的节点位置；不改变地图中心、缩放、图层开关及有效选中项。
   * @param nodes 初始化节点与本轮追加位置合并后的完整集合。
   */
  setNodes: (nodes: SituationMapNode[]) => void

  /** 更新文件关联；与完整遥测链路分开，不补造质量或状态字段。 */
  setFileLinks: (links: FileCommunicationLink[]) => void
  setFileDeviceStates: (states: FileDeviceEvent[]) => void

  /**
   * 更新当前选中节点。
   * @param platformId 要选中的平台唯一标识。
   * @returns 无返回值。
   * @sideeffect 更新对应节点图标以刷新选中态样式。
   */
  setSelectedNodeId: (platformId: string) => void

  /**
   * 将地图视图定位到摘要列表指定的业务对象。
   * @param target 节点、链路或干扰设备的定位请求。
   * @returns 无返回值。
   * @sideeffect 节点和待机干扰设备使用中心定位，链路和活动干扰范围使用边界自适应。
   */
  focusTarget: (target: SituationMapFocusTarget) => void

  /**
   * 设置一个业务图层是否可见。
   * @param layer 节点、链路、干扰范围或经纬网图层。
   * @param visible 为 true 时显示图层，为 false 时隐藏图层。
   * @returns 无返回值。
   * @sideeffect 在 Leaflet 地图上增删对应图层组，底图不受影响。
   */
  setLayerVisible: (layer: MapLayer, visible: boolean) => void

  /**
   * 原地切换离线地图的深色或浅色主题。
   * @param theme 要应用的地图主题。
   * @returns 无返回值。
   * @sideeffect 主题变化时替换既有矢量瓦片样式并安全刷新可见底图和标签层，同时按新主题重建经纬网；不会重建地图或业务图层组。
   */
  setTheme: (theme: MapTheme) => void

  /**
   * 在离线矢量与本地卫星底图之间原地切换。
   * @param basemap 要显示的底图类型。
   * @returns 无返回值。
   * @sideeffect 仅在当前 Leaflet 地图上增删既有底图和标签实例，不改变视图或业务图层状态。
   */
  setBasemap: (basemap: MapBasemap) => void

  /**
   * 放大一级地图视图。
   * @returns 无返回值。
   * @sideeffect 修改 Leaflet 地图缩放级别并触发缩放回调。
   */
  zoomIn: () => void

  /**
   * 缩小一级地图视图。
   * @returns 无返回值。
   * @sideeffect 修改 Leaflet 地图缩放级别并触发缩放回调。
   */
  zoomOut: () => void

  /**
   * 将地图恢复到固定任务范围。
   * @returns 无返回值。
   * @sideeffect 对 Leaflet 地图执行范围自适应并可能触发缩放回调。
   */
  reset: () => void

  /**
   * 释放地图控制器占用的资源。
   * @returns 无返回值。
   * @sideeffect 断开尺寸监听、移除事件和 Leaflet 地图；可重复调用。
   */
  destroy: () => void
}

type SituationPlatform = SituationMapNode

interface VectorTilePathOptions extends L.PathOptions {
  radius?: number
}

type VectorTileStyle = VectorTilePathOptions
  | ((properties: Record<string, unknown>, zoom: number) => VectorTilePathOptions)

interface VectorGridOptions extends L.GridLayerOptions {
  rendererFactory: unknown
  vectorTileLayerStyles: Record<string, VectorTileStyle>
  maxNativeZoom: number
  maxZoom: number
  attribution: string
  interactive: boolean
}

interface LeafletVectorGridApi {
  protobuf: (url: string, options: VectorGridOptions) => SituationVectorGridLayer
}

/** 仅暴露换肤需要的 VectorGrid 可变样式选项与原地重绘能力。 */
interface SituationVectorGridLayer extends L.Layer {
  options: VectorGridOptions
  redraw: () => SituationVectorGridLayer
}

type LeafletWithVectorGrid = typeof L & {
  vectorGrid: LeafletVectorGridApi
  canvas: typeof L.canvas & { tile: unknown }
}

const taskBounds = L.latLngBounds(
  MAP_CONFIG.taskBounds.map(([latitude, longitude]) => [latitude, longitude] as L.LatLngTuple),
)

const HIDDEN_VECTOR_TILE_STYLE: VectorTilePathOptions = {
  stroke: false,
  color: 'transparent',
  weight: 0,
  opacity: 0,
  fill: false,
  fillColor: 'transparent',
  fillOpacity: 0,
  radius: 0,
}

/**
 * 为指定地图主题创建一份独立的 VectorGrid 样式表。
 * @param theme 深色或浅色地图主题。
 * @returns 可直接替换到既有 VectorGrid 实例的图层样式。
 * @sideeffect 无副作用；每次调用都返回新对象，避免主题间共享可变样式。
 */
function createVectorTileStyles(theme: MapTheme): Record<string, VectorTileStyle> {
  const hiddenStyles = {
    addresses: HIDDEN_VECTOR_TILE_STYLE,
    aerialways: HIDDEN_VECTOR_TILE_STYLE,
    boundary_labels: HIDDEN_VECTOR_TILE_STYLE,
    bridges: HIDDEN_VECTOR_TILE_STYLE,
    dam_lines: HIDDEN_VECTOR_TILE_STYLE,
    dam_polygons: HIDDEN_VECTOR_TILE_STYLE,
    ferries: HIDDEN_VECTOR_TILE_STYLE,
    pier_lines: HIDDEN_VECTOR_TILE_STYLE,
    pier_polygons: HIDDEN_VECTOR_TILE_STYLE,
    place_labels: HIDDEN_VECTOR_TILE_STYLE,
    pois: HIDDEN_VECTOR_TILE_STYLE,
    public_transport: HIDDEN_VECTOR_TILE_STYLE,
    sites: HIDDEN_VECTOR_TILE_STYLE,
    street_labels: HIDDEN_VECTOR_TILE_STYLE,
    street_labels_points: HIDDEN_VECTOR_TILE_STYLE,
    streets_polygons_labels: HIDDEN_VECTOR_TILE_STYLE,
    water_lines_labels: HIDDEN_VECTOR_TILE_STYLE,
    water_polygons_labels: HIDDEN_VECTOR_TILE_STYLE,
  }

  if (theme === 'light') {
    return {
      ...hiddenStyles,
      ocean: { fill: true, fillColor: '#cfe8f3', fillOpacity: 1, stroke: false },
      land: {
        fill: true,
        fillColor: '#eee7d6',
        fillOpacity: 1,
        color: '#c7c0b2',
        weight: 0.5,
      },
      water_polygons: {
        fill: true,
        fillColor: '#c6e2ef',
        fillOpacity: 1,
        color: '#8fb9cc',
        weight: 0.7,
      },
      water_lines: { color: '#73a9c0', weight: 1, opacity: 0.9 },
      boundaries: {
        color: '#718899',
        weight: 1,
        opacity: 0.85,
        dashArray: '5 4',
      },
      streets: (properties, zoom) => {
        const kind = typeof properties.kind === 'string' ? properties.kind : ''
        const arterialColors: Readonly<Record<string, string>> = {
          motorway: '#d98b18',
          trunk: '#e5a536',
          primary: '#efbd63',
        }
        return {
          color: arterialColors[kind] ?? (zoom >= 12 ? '#8d969b' : '#a7adb0'),
          weight: zoom >= 12 ? 1.35 : 0.75,
          opacity: zoom >= 10 ? 0.9 : 0.7,
        }
      },
      street_polygons: {
        fill: true,
        fillColor: '#d6d7d5',
        fillOpacity: 0.65,
        stroke: false,
      },
      buildings: {
        fill: true,
        fillColor: '#c8cac8',
        fillOpacity: 0.75,
        color: '#afb3b2',
        weight: 0.5,
      },
    }
  }

  return {
    ...hiddenStyles,
    ocean: { fill: true, fillColor: '#06111d', fillOpacity: 1, stroke: false },
    land: {
      fill: true,
      fillColor: '#10283a',
      fillOpacity: 1,
      color: '#1a3b51',
      weight: 0.5,
    },
    water_polygons: {
      fill: true,
      fillColor: '#092034',
      fillOpacity: 1,
      color: '#16445f',
      weight: 0.7,
    },
    water_lines: { color: '#1e5571', weight: 1, opacity: 0.85 },
    boundaries: {
      color: '#54728a',
      weight: 1,
      opacity: 0.75,
      dashArray: '5 4',
    },
    streets: (_properties, zoom) => ({
      color: zoom >= 12 ? '#496579' : '#354f63',
      weight: zoom >= 12 ? 1.35 : 0.75,
      opacity: zoom >= 10 ? 0.8 : 0.55,
    }),
    street_polygons: {
      fill: true,
      fillColor: '#324b5d',
      fillOpacity: 0.55,
      stroke: false,
    },
    buildings: {
      fill: true,
      fillColor: '#3b5363',
      fillOpacity: 0.7,
      color: '#4d6879',
      weight: 0.5,
    },
  }
}

const LINK_TYPE_STYLES: Record<SituationLinkView['type'], L.PathOptions> = {
  SAT: {
    color: '#67c23a',
    weight: 3,
    opacity: 0.95,
  },
  MICROWAVE: {
    color: '#409eff',
    weight: 3,
    opacity: 0.95,
    dashArray: '8 5',
  },
  DATALINK: {
    color: '#e6a23c',
    weight: 3,
    opacity: 0.95,
    dashArray: '2 5',
  },
  LASER: {
    color: '#b37feb',
    weight: 3,
    opacity: 0.95,
  },
}

const UNAVAILABLE_LINK_STYLE: L.PathOptions = {
  color: '#f56c6c',
  weight: 3,
  opacity: 0.95,
}

const LINK_STATUS_LABELS: Record<SituationLinkView['status'], string> = {
  UP: '正常',
  DEGRADED: '劣化',
  DOWN: '中断',
}

/**
 * 根据链路类型与运行状态生成地图线型。
 * @param link 当前帧链路视图。
 * @returns 正常链路使用类型配色，劣化或中断链路使用红色异常配色。
 * @sideeffect 无副作用。
 */
function linkStyle(link: SituationLinkView): L.PathOptions {
  return link.status === 'UP' ? LINK_TYPE_STYLES[link.type] : UNAVAILABLE_LINK_STYLE
}

/**
 * 创建可由 Vue 外壳驱动的 Leaflet 态势地图控制器。
 * @param options 地图容器、初始状态和节点、链路、缩放回调。
 * @returns 提供状态同步、图层控制、缩放、重置和销毁方法的控制器。
 * @sideeffect 初始化 Leaflet 地图、请求本机矢量瓦片并注册尺寸和地图事件。
 */
export function createSituationMapController(options: SituationMapControllerOptions): SituationMapController {
  let map: L.Map | null = L.map(options.container, {
    zoomControl: false,
    attributionControl: false,
    minZoom: MAP_CONFIG.zoom.min,
    maxZoom: MAP_CONFIG.zoom.max,
    zoomSnap: MAP_CONFIG.zoom.snap,
    preferCanvas: false,
  })
  let currentLinks = [...options.links]
  let currentFrame = options.frame
  let fileNodes = options.initialNodes ?? []
  let fileLinks = options.fileLinks ?? []
  let fileDeviceStates = options.fileDeviceStates ?? []
  let configuredLinks = options.configuredLinks
  let currentNodes = currentFrame?.platforms ?? fileNodes
  let selectedNodeId = options.selectedNodeId
  let focusedTarget: SituationMapFocusTarget | null = null
  let currentTheme: MapTheme = MAP_CONFIG.defaults.theme
  let currentBasemap: MapBasemap = MAP_CONFIG.defaults.basemap

  const layerGroups: Record<MapLayer, L.LayerGroup> = {
    nodes: L.layerGroup(),
    links: L.layerGroup(),
    interference: L.layerGroup(),
    grid: L.layerGroup(),
  }
  const layerVisibility: Record<MapLayer, boolean> = {
    nodes: true,
    links: true,
    interference: true,
    grid: MAP_CONFIG.defaults.gridVisible,
  }

  /**
   * 处理地图中的节点选择。
   * @param platformId 被选择的平台唯一标识。
   * @returns 无返回值。
   * @sideeffect 清除其他业务对象高亮、重绘节点选中态并通知上层组件。
   */
  function handleMapNodeSelect(platformId: string): void {
    selectedNodeId = platformId
    focusedTarget = { kind: 'node', targetId: platformId }
    renderBusinessLayers()
    options.onSelectNode(platformId)
  }

  /**
   * 处理地图中的链路选择。
   * @param link 被选择的链路视图。
   * @returns 无返回值。
   * @sideeffect 清除其他业务对象高亮、重绘链路选中态并通知上层组件。
   */
  function handleMapLinkSelect(link: SituationLinkView): void {
    focusedTarget = { kind: 'link', targetId: link.linkId }
    renderBusinessLayers()
    options.onSelectLink(link)
  }

  /** 根据当前联动目标重绘节点、链路和干扰范围的唯一高亮态。 */
  const renderBusinessLayers = (): void => {
    let highlightedNodeId = selectedNodeId
    if (focusedTarget?.kind === 'link') highlightedNodeId = ''
    if (focusedTarget?.kind === 'node') highlightedNodeId = focusedTarget.targetId
    if (focusedTarget?.kind === 'interference') {
      highlightedNodeId = currentFrame?.platforms.find((platform) => (
        platform.jammers.some((jammer) => jammer.jammerId === focusedTarget?.targetId)
      ))?.platformId ?? selectedNodeId
    }

    if (currentFrame) {
      renderInterference(
        layerGroups.interference,
        currentFrame,
        focusedTarget?.kind === 'interference' ? focusedTarget.targetId : '',
      )
      renderLinks(
        layerGroups.links,
        currentFrame,
        currentLinks,
        focusedTarget?.kind === 'link' ? focusedTarget.targetId : '',
        handleMapLinkSelect,
      )
    } else if (configuredLinks) {
      renderConfiguredLinks(layerGroups.links, currentNodes, configuredLinks, focusedTarget?.targetId ?? '', link => {
        focusedTarget = { kind: 'link', targetId: link.id }
        renderBusinessLayers()
        options.onSelectConfiguredLink?.(link)
      })
      renderInterference(layerGroups.interference, null, '')
    } else {
      const closedDevices = new Set(fileDeviceStates
        .filter(event => event.kind === 'COMMUNICATION' && !event.active)
        .map(event => JSON.stringify([event.platformId, event.deviceId])))
      // 仅过滤绘制：任一登记的两端均未明确关闭就保留合并线，完整明细不变。
      const visibleLinks = fileLinks.filter(link => link.records.some(record =>
        [record.source, record.target].every(endpoint =>
          !closedDevices.has(JSON.stringify([endpoint.platformName, endpoint.communicationName])))))
      renderFileLinks(layerGroups.links, currentNodes, visibleLinks, link => {
        focusedTarget = { kind: 'link', targetId: link.id }
        options.onSelectFileLink?.(link)
      })
      const activePlatforms = new Set(fileDeviceStates.filter(event => event.kind === 'JAMMING' && event.active).map(event => event.platformId))
      renderInterference(layerGroups.interference, null, '', currentNodes.filter(node => activePlatforms.has(node.platformId)), fileDeviceStates)
    }
    renderNodes(layerGroups.nodes, currentNodes, highlightedNodeId, handleMapNodeSelect)
  }

  const leaflet = L as LeafletWithVectorGrid
  const offlineLabelPane = map.createPane('offline-label-pane')
  offlineLabelPane.style.zIndex = '350'
  offlineLabelPane.style.pointerEvents = 'none'

  const vectorGrid = leaflet.vectorGrid.protobuf(MAP_CONFIG.resources.vector.tileUrl, {
    bounds: L.latLngBounds([...MAP_CONFIG.resources.vector.bounds[0]], [...MAP_CONFIG.resources.vector.bounds[1]]),
    rendererFactory: leaflet.canvas.tile,
    vectorTileLayerStyles: createVectorTileStyles(currentTheme),
    maxNativeZoom: MAP_CONFIG.resources.vector.maxNativeZoom,
    maxZoom: MAP_CONFIG.zoom.max,
    attribution: MAP_CONFIG.resources.vector.attribution,
    interactive: false,
    pane: 'tilePane',
  })
  vectorGrid.addTo(map)
  const offlineLabelLayer = createOfflineVectorLabelLayer(currentTheme)
  offlineLabelLayer.addTo(map)
  const satelliteLayer = L.tileLayer(MAP_CONFIG.resources.satellite.tileUrl, {
    bounds: L.latLngBounds([...MAP_CONFIG.resources.satellite.bounds[0]], [...MAP_CONFIG.resources.satellite.bounds[1]]),
    minZoom: MAP_CONFIG.zoom.min,
    maxNativeZoom: MAP_CONFIG.resources.satellite.maxNativeZoom,
    maxZoom: MAP_CONFIG.zoom.max,
    pane: 'tilePane',
    attribution: MAP_CONFIG.resources.satellite.attribution,
  })

  renderGrid(layerGroups.grid, currentTheme)
  renderBusinessLayers()

  const layerOrder: MapLayer[] = ['grid', 'interference', 'links', 'nodes']
  layerOrder.forEach((layer) => {
    if (layerVisibility[layer]) layerGroups[layer].addTo(map as L.Map)
  })

  const handleZoomEnd = (): void => {
    if (map) options.onZoomChange(map.getZoom())
  }
  map.on('zoomend', handleZoomEnd)
  map.fitBounds(taskBounds, { padding: [...MAP_CONFIG.fitPadding], animate: false })

  const handleResize = (): void => {
    if (map) map.invalidateSize({ pan: false })
  }
  let resizeObserver: ResizeObserver | null = null
  let removeResizeFallback: (() => void) | null = null

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(options.container)
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', handleResize)
    removeResizeFallback = () => window.removeEventListener('resize', handleResize)
  }

  return {
    setConfiguredLinks(links): void {
      if (!map) return
      configuredLinks = links
      if (!currentFrame) renderBusinessLayers()
    },
    setLinks(links): void {
      if (!map) return
      currentLinks = [...links]
      if (!currentFrame) return
      renderLinks(
        layerGroups.links,
        currentFrame,
        currentLinks,
        focusedTarget?.kind === 'link' ? focusedTarget.targetId : '',
        handleMapLinkSelect,
      )
    },

    setFrame(frame): void {
      if (!map) return
      currentFrame = frame
      currentNodes = frame?.platforms ?? fileNodes
      if (!currentNodes.some((platform) => platform.platformId === selectedNodeId)) {
        selectedNodeId = currentNodes[0]?.platformId ?? ''
      }
      renderBusinessLayers()
    },

    setNodes(nodes): void {
      if (!map) return
      fileNodes = nodes
      if (currentFrame) return
      currentNodes = nodes
      if (!nodes.some((node) => node.platformId === selectedNodeId)) {
        selectedNodeId = nodes[0]?.platformId ?? ''
        focusedTarget = null
      }
      renderBusinessLayers()
    },

    setFileLinks(links): void {
      if (!map) return
      fileLinks = links
      if (!currentFrame) renderBusinessLayers()
    },

    setFileDeviceStates(states): void {
      if (!map) return
      fileDeviceStates = states
      if (!currentFrame && !configuredLinks) renderBusinessLayers()
    },

    setSelectedNodeId(platformId): void {
      if (!map || (selectedNodeId === platformId && focusedTarget === null)) return
      selectedNodeId = platformId
      focusedTarget = null
      renderBusinessLayers()
    },

    focusTarget(target): void {
      if (!map) return
      const focusZoom = MAP_CONFIG.defaults.zoom
      const animation = { animate: true, duration: 0.45 }

      if (target.kind === 'node') {
        const platform = currentNodes.find(
          (candidate) => candidate.platformId === target.targetId,
        )
        if (platform) {
          selectedNodeId = platform.platformId
          focusedTarget = target
          renderBusinessLayers()
          map.setView(pointForPlatform(platform), focusZoom, animation)
        }
        return
      }

      if (!currentFrame && target.kind === 'link' && configuredLinks) {
        const link = configuredLinks.find(link => link.id === target.targetId)
        const source = currentNodes.find(node => node.platformId === link?.sourcePlatformId)
        const destination = currentNodes.find(node => node.platformId === link?.targetPlatformId)
        if (source && destination) {
          focusedTarget = target
          renderBusinessLayers()
          map.fitBounds(L.latLngBounds(sampleConnectionCurve(source, destination, 0)), {
            padding: [...MAP_CONFIG.fitPadding], maxZoom: focusZoom, ...animation,
          })
        }
        return
      }
      if (!currentFrame) return
      if (target.kind === 'link') {
        const link = currentLinks.find((candidate) => candidate.linkId === target.targetId)
        const points = link ? sampleLinkCurve(currentFrame, link, currentLinks) : []
        if (points.length > 0) {
          focusedTarget = target
          renderBusinessLayers()
          map.fitBounds(L.latLngBounds(points), {
            padding: [...MAP_CONFIG.fitPadding],
            maxZoom: focusZoom,
            ...animation,
          })
        }
        return
      }

      const platform = currentFrame.platforms.find((candidate) => (
        candidate.jammers.some((jammer) => jammer.jammerId === target.targetId)
      ))
      const jammer = platform?.jammers.find((candidate) => candidate.jammerId === target.targetId)
      if (!platform || !jammer) return

      selectedNodeId = platform.platformId
      focusedTarget = target
      renderBusinessLayers()
      const center = L.latLng(pointForPlatform(platform))
      if (jammer.active) {
        map.fitBounds(center.toBounds(MAP_CONFIG.activeInterferenceRadiusMeters * 2), {
          padding: [...MAP_CONFIG.fitPadding],
          maxZoom: focusZoom,
          ...animation,
        })
        return
      }
      map.setView(center, focusZoom, animation)
    },

    setLayerVisible(layer, visible): void {
      if (!map || layerVisibility[layer] === visible) return
      layerVisibility[layer] = visible
      if (visible) {
        layerGroups[layer].addTo(map)
      } else {
        layerGroups[layer].removeFrom(map)
      }
    },

    setTheme(theme): void {
      if (!map || currentTheme === theme) return
      currentTheme = theme
      vectorGrid.options.vectorTileLayerStyles = createVectorTileStyles(theme)
      if (currentBasemap === 'vector') {
        if (Number.isInteger(map.getZoom())) {
          vectorGrid.redraw()
          offlineLabelLayer.setTheme(theme)
        } else {
          // GridLayer.redraw() 会直接使用分数 map zoom；重新挂载才会走 Leaflet 的整数瓦片网格选择。
          offlineLabelLayer.setTheme(theme, false)
          vectorGrid.removeFrom(map)
          vectorGrid.addTo(map)
          offlineLabelLayer.removeFrom(map)
          offlineLabelLayer.addTo(map)
        }
      } else {
        offlineLabelLayer.setTheme(theme, false)
      }
      renderGrid(layerGroups.grid, theme)
    },

    setBasemap(basemap): void {
      if (!map || currentBasemap === basemap) return
      currentBasemap = basemap
      if (basemap === 'satellite') {
        vectorGrid.removeFrom(map)
        offlineLabelLayer.removeFrom(map)
        satelliteLayer.addTo(map)
        return
      }
      satelliteLayer.removeFrom(map)
      vectorGrid.addTo(map)
      offlineLabelLayer.addTo(map)
    },

    zoomIn(): void {
      if (map) map.zoomIn()
    },

    zoomOut(): void {
      if (map) map.zoomOut()
    },

    reset(): void {
      if (map) map.fitBounds(taskBounds, { padding: [...MAP_CONFIG.fitPadding], animate: false })
    },

    destroy(): void {
      if (!map) return
      resizeObserver?.disconnect()
      resizeObserver = null
      removeResizeFallback?.()
      removeResizeFallback = null
      map.off('zoomend', handleZoomEnd)
      offlineLabelLayer.remove()
      map.remove()
      map = null
      Object.values(layerGroups).forEach((group) => {
        group.clearLayers()
        nodeLayers.delete(group)
        connectionLayers.delete(group)
        interferenceLayers.delete(group)
      })
      currentLinks = []
    },
  }
}

/**
 * 将 API 平台经纬度转换为 Leaflet 坐标顺序。
 * @param platform 固定帧中的平台状态。
 * @returns Leaflet 使用的 [纬度, 经度] 坐标。
 * @sideeffect 无副作用；仅调整 API 经度、纬度的排列顺序。
 */
function pointForPlatform(platform: SituationPlatform): L.LatLngTuple {
  return [platform.latitude, platform.longitude]
}

/**
 * 为 Leaflet 标记绑定 Enter 和空格键选择行为。
 * @param marker 需要支持键盘确认的 Leaflet 标记。
 * @param onSelect 用户确认选择时执行的回调。
 * @returns 无返回值。
 * @sideeffect 在标记挂载时添加 DOM 键盘监听，并在移除时解除监听。
 */
function bindMarkerKeyboardSelection(marker: L.Marker, onSelect: () => void): void {
  let element: HTMLElement | undefined

  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    onSelect()
  }
  const detach = (): void => {
    element?.removeEventListener('keydown', handleKeydown)
    element = undefined
  }

  marker.on('add', () => {
    detach()
    element = marker.getElement()
    element?.addEventListener('keydown', handleKeydown)
  })
  marker.on('remove', detach)
}

/**
 * 构造节点安全图标内容。
 * @param platform 固定帧中的平台状态。
 * @param selected 节点是否处于选中状态。
 * @returns 只通过 textContent 写入名称和标识的 DOM 元素。
 * @sideeffect 创建新的 DOM 节点，不修改传入平台数据。
 */
function createNodeIconContent(platform: SituationPlatform, selected: boolean): HTMLElement {
  const compact = platform.type === 'AIRBORNE_MISSION_CLUSTER'
  const root = document.createElement('div')
  root.className = 'situation-map-node'
  root.style.display = 'flex'
  root.style.flexDirection = 'column'
  root.style.alignItems = 'center'
  root.style.color = selected ? '#f5b942' : '#42d8ff'
  root.style.filter = selected ? 'drop-shadow(0 0 5px rgba(245, 185, 66, 0.85))' : 'none'

  const glyph = document.createElement('span')
  glyph.className = 'situation-map-node__glyph'
  glyph.textContent = platform.type === 'COMMUNICATION_SATELLITE' ? '▲' : '●'
  glyph.style.fontSize = selected ? '24px' : '20px'
  glyph.style.lineHeight = '20px'
  glyph.style.webkitTextStroke = '1px #06111d'

  const name = document.createElement('span')
  name.className = 'situation-map-node__name'
  name.textContent = platform.type === 'COMMUNICATION_SATELLITE'
    ? `${platform.name}（轨道示意）`
    : platform.name
  name.style.display = compact ? 'none' : 'block'
  name.style.marginTop = '3px'
  name.style.color = '#d7e8f3'
  name.style.fontSize = '12px'
  name.style.fontWeight = selected ? '700' : '500'
  name.style.whiteSpace = 'nowrap'
  name.style.textShadow = '0 1px 3px #06111d, 0 0 4px #06111d'

  const id = document.createElement('span')
  id.className = 'situation-map-node__id'
  id.textContent = compact ? platform.platformId.replace('AIR-', 'U') : platform.platformId
  if (!compact && platform.name === platform.platformId) id.style.display = 'none'
  id.style.color = '#7f9aad'
  id.style.fontFamily = 'Consolas, monospace'
  id.style.fontSize = '12px'
  id.style.whiteSpace = 'nowrap'
  id.style.textShadow = '0 1px 3px #06111d'

  root.append(glyph, name, id)
  return root
}

const nodeLayers = new WeakMap<L.LayerGroup, Map<string, { marker: L.Marker; appearance: string }>>()

/** 按节点身份复用 Marker；位置更新不替换图标，选中和名称变化只更新对应图标。 */
function renderNodes(
  group: L.LayerGroup,
  nodes: SituationMapNode[],
  selectedNodeId: string,
  onSelectNode: (platformId: string) => void,
): void {
  const entries = nodeLayers.get(group) ?? new Map<string, { marker: L.Marker; appearance: string }>()
  nodeLayers.set(group, entries)
  const ids = new Set(nodes.map(node => node.platformId))
  for (const [id, entry] of entries) {
    if (!ids.has(id)) { group.removeLayer(entry.marker); entries.delete(id) }
  }
  for (const platform of nodes) {
    const selected = platform.platformId === selectedNodeId
    const appearance = JSON.stringify([platform.name, platform.type, selected])
    let entry = entries.get(platform.platformId)
    if (!entry) {
      const marker = L.marker(pointForPlatform(platform), {
        title: `选择节点 ${platform.name}${platform.type === 'COMMUNICATION_SATELLITE' ? '（轨道示意）' : ''}`,
        keyboard: true, riseOnHover: true, riseOffset: 500, bubblingMouseEvents: false,
      })
      marker.on('click', () => onSelectNode(platform.platformId))
      bindMarkerKeyboardSelection(marker, () => onSelectNode(platform.platformId))
      entry = { marker, appearance: '' }
      entries.set(platform.platformId, entry)
    }
    const { marker } = entry
    if (!marker.getLatLng().equals(pointForPlatform(platform))) marker.setLatLng(pointForPlatform(platform))
    if (entry.appearance !== appearance) {
      const compact = platform.type === 'AIRBORNE_MISSION_CLUSTER'
      const orbitSuffix = platform.type === 'COMMUNICATION_SATELLITE' ? '（轨道示意）' : ''
      const accessibleName = `选择节点 ${platform.name}${orbitSuffix}`
      marker.options.title = accessibleName
      marker.setIcon(L.divIcon({
        html: createNodeIconContent(platform, selected),
        className: selected ? 'situation-map-node-marker situation-map-node-marker--selected' : 'situation-map-node-marker',
        iconSize: compact ? [44, 40] : [160, 52],
        iconAnchor: compact ? [22, 16] : [80, 16], tooltipAnchor: [0, -16],
      }))
      const element = marker.getElement()
      if (element) element.title = accessibleName
      marker.setZIndexOffset(selected ? 1000 : 0)
      const tooltip = document.createElement('span')
      tooltip.textContent = `${platform.name}${orbitSuffix} · ${PLATFORM_TYPE_LABELS[platform.type as keyof typeof PLATFORM_TYPE_LABELS] ?? platform.type}`
      marker.bindTooltip(tooltip, { direction: 'top', offset: [0, -12] })
      entry.appearance = appearance
    }
    if (!group.hasLayer(marker)) marker.addTo(group)
  }
}

/**
 * 按稳定链路身份解析其固定帧摘要索引。
 * @param link 当前要展示的链路视图。
 * @returns 匹配摘要在固定帧中的索引；无法稳妥匹配时返回 -1。
 * @sideeffect 无副作用，只读取固定帧和链路视图。
 */
function resolveLinkSummaryIndex(frame: TelemetryFrame, link: SituationLinkView): number {
  const detailed = link.detailed?.linkId === link.linkId
    ? link.detailed
    : frame.links.find((candidate) => candidate.linkId === link.linkId)

  if (detailed) {
    const detailedIndex = frame.linkSummaries.findIndex((summary) => (
      summary.sourcePlatform === detailed.sourcePlatform
      && summary.destPlatform === detailed.destPlatform
      && summary.linkType === detailed.linkType
    ))
    if (detailedIndex >= 0) return detailedIndex
  }

  const routeCandidate = frame.evidence.routeCandidates.find(
    (candidate) => candidate.linkId === link.linkId,
  )
  if (routeCandidate) {
    const candidateIndex = frame.linkSummaries.findIndex(
      (summary) => summary.currentBer === routeCandidate.ber && summary.linkType === link.type,
    )
    if (candidateIndex >= 0) return candidateIndex
  }

  return frame.linkSummaries.findIndex((summary) => {
    const source = frame.platforms.find(
      (platform) => platform.platformId === summary.sourcePlatform,
    )
    const destination = frame.platforms.find(
      (platform) => platform.platformId === summary.destPlatform,
    )
    return summary.linkType === link.type
      && source?.name === link.sourceName
      && destination?.name === link.destinationName
  })
}

/**
 * 按稳定链路身份生成同端点链路的二次曲线采样点。
 * @param link 当前要展示的链路视图。
 * @returns 从源节点到目标节点的 Leaflet 折线采样点；端点缺失时返回空数组。
 * @sideeffect 无副作用，只读取固定帧。
 */
function sampleLinkCurve(frame: TelemetryFrame, link: SituationLinkView, links: SituationLinkView[]): L.LatLngTuple[] {
  const summaryIndex = resolveLinkSummaryIndex(frame, link)
  const summary = frame.linkSummaries[summaryIndex]
  if (!summary) return []

  const source = frame.platforms.find(
    (platform) => platform.platformId === summary.sourcePlatform,
  )
  const destination = frame.platforms.find(
    (platform) => platform.platformId === summary.destPlatform,
  )
  if (!source || !destination) return []

  const peers = links.flatMap(candidate => {
    const item = frame.linkSummaries[resolveLinkSummaryIndex(frame, candidate)]
    return item ? [{ sourcePlatformId: item.sourcePlatform, targetPlatformId: item.destPlatform, type: item.linkType }] : []
  })
  return sampleConnectionCurve(source, destination, connectionCurveOffset(source, destination, link.type, peers))
}

/** 按无向节点对及稳定类别排序分离；同类重复/反向登记不增加弯曲，其他节点对不影响结果。 */
function connectionCurveOffset(source: SituationMapNode, target: SituationMapNode, type: string,
  links: Array<{ sourcePlatformId: string; targetPlatformId: string; type: string }>): number {
  const types = [...new Set(links.filter(link => (
    link.sourcePlatformId === source.platformId && link.targetPlatformId === target.platformId
  ) || (
    link.sourcePlatformId === target.platformId && link.targetPlatformId === source.platformId
  )).map(link => link.type))].sort()
  if (types.length < 2) return 0
  return (types.indexOf(type) / (types.length - 1) - 0.5) * MAP_CONFIG.linkCurveSeparationRatio
}

/** 偏移按端点距离缩放且垂直于连线；方向归一保证端点反转后曲线不翻边，不改变节点位置。 */
function sampleConnectionCurve(source: SituationMapNode, destination: SituationMapNode, offset: number): L.LatLngTuple[] {
  const [sourceLatitude, sourceLongitude] = pointForPlatform(source)
  const [destinationLatitude, destinationLongitude] = pointForPlatform(destination)
  const direction = source.platformId < destination.platformId ? 1 : -1
  const controlLatitude = (sourceLatitude + destinationLatitude) / 2 + (destinationLongitude - sourceLongitude) * offset * direction
  const controlLongitude = (sourceLongitude + destinationLongitude) / 2 - (destinationLatitude - sourceLatitude) * offset * direction
  const samples: L.LatLngTuple[] = []

  for (let sampleIndex = 0; sampleIndex <= MAP_CONFIG.curveSampleCount; sampleIndex += 1) {
    const t = sampleIndex / MAP_CONFIG.curveSampleCount
    const inverseT = 1 - t
    samples.push([
      inverseT * inverseT * sourceLatitude
        + 2 * inverseT * t * controlLatitude
        + t * t * destinationLatitude,
      inverseT * inverseT * sourceLongitude
        + 2 * inverseT * t * controlLongitude
        + t * t * destinationLongitude,
    ])
  }

  return samples
}

interface ConnectionDrawing {
  id: string
  points: L.LatLngTuple[]
  name: string
  style: L.PathOptions
  hitClass: string
  select: () => void
}
interface ConnectionLayer {
  line: L.Polyline
  marker: L.Marker
  drawing: ConnectionDrawing
  geometry: string
  appearance: string
}
const connectionLayers = new WeakMap<L.LayerGroup, Map<string, ConnectionLayer>>()

/** 三种来源共用图层更新；回调始终读取最新记录，隐藏图层也只更新、不重新开启。 */
function renderConnections(group: L.LayerGroup, drawings: ConnectionDrawing[]): void {
  const entries = connectionLayers.get(group) ?? new Map<string, ConnectionLayer>()
  connectionLayers.set(group, entries)
  const ids = new Set(drawings.map(drawing => drawing.id))
  for (const [id, entry] of entries) {
    if (!ids.has(id)) { group.removeLayer(entry.line); group.removeLayer(entry.marker); entries.delete(id) }
  }
  for (const drawing of drawings) {
    const midpoint = drawing.points[Math.floor(drawing.points.length / 2)]!
    const geometry = JSON.stringify(drawing.points)
    const appearance = JSON.stringify([drawing.name, drawing.style])
    let entry = entries.get(drawing.id)
    if (!entry) {
      const hit = document.createElement('span')
      hit.textContent = drawing.name
      hit.style.cssText = 'display:block;width:28px;height:28px;opacity:0'
      const marker = L.marker(midpoint, {
        icon: L.divIcon({ html: hit, className: drawing.hitClass, iconSize: [28, 28], iconAnchor: [14, 14] }),
        keyboard: true, title: drawing.name, bubblingMouseEvents: false, zIndexOffset: 750,
      })
      const line = L.polyline(drawing.points, { ...drawing.style, bubblingMouseEvents: false, interactive: true })
      const created: ConnectionLayer = { line, marker, drawing, geometry, appearance: '' }
      const select = () => created.drawing.select()
      line.on('click', select)
      marker.on('click', select)
      bindMarkerKeyboardSelection(marker, select)
      entry = created
      entries.set(drawing.id, entry)
      line.addTo(group)
      marker.addTo(group)
    }
    entry.drawing = drawing
    if (entry.geometry !== geometry) {
      entry.line.setLatLngs(drawing.points)
      entry.marker.setLatLng(midpoint)
      entry.geometry = geometry
    }
    if (entry.appearance !== appearance) {
      // setStyle 不会更新 SVG class，且未指定的 dashArray 不会自动清除。
      entry.line.setStyle({ dashArray: undefined, ...drawing.style })
      entry.line.getElement()?.classList.toggle('situation-map-link--selected', drawing.style.className === 'situation-map-link--selected')
      const tooltip = document.createElement('span')
      tooltip.textContent = drawing.name
      entry.line.bindTooltip(tooltip, { sticky: true })
      entry.marker.options.title = drawing.name
      const element = entry.marker.getElement()
      if (element) element.title = drawing.name
      const hit = (entry.marker.options.icon as L.DivIcon).options.html as HTMLElement
      hit.textContent = drawing.name
      entry.appearance = appearance
    }
  }
}

/** 运行链路保留规范/三态投影语义，仅局部刷新几何和样式。 */
function renderLinks(group: L.LayerGroup, frame: TelemetryFrame, links: SituationLinkView[], selectedLinkId: string, onSelectLink: (link: SituationLinkView) => void): void {
  renderConnections(group, links.flatMap(link => {
    const points = sampleLinkCurve(frame, link, links)
    if (!points.length) return []
    return [{
      id: `runtime:${link.linkId}`, points,
      name: `${LINK_TYPE_LABELS[link.type]}，${link.sourceName}至${link.destinationName}，${LINK_STATUS_LABELS[link.status]}`,
      style: { ...linkStyle(link), className: '', ...(link.linkId === selectedLinkId ? { weight: 6, opacity: 1, className: 'situation-map-link--selected' } : {}) },
      hitClass: 'situation-map-link-keyboard-hit', select: () => onSelectLink(link),
    }]
  }))
}

/** 配置连线使用中性虚线，不把配置启停推断成运行通断或链路质量。 */
function renderConfiguredLinks(group: L.LayerGroup, nodes: SituationMapNode[], links: Link[], selectedId: string, onSelect: (link: Link) => void): void {
  const platforms = new Map(nodes.map(node => [node.platformId, node]))
  renderConnections(group, links.flatMap(link => {
    const source = platforms.get(link.sourcePlatformId)
    const target = platforms.get(link.targetPlatformId)
    if (!source || !target) return []
    return [{
      id: `configured:${link.id}`, points: sampleConnectionCurve(source, target, connectionCurveOffset(source, target, link.type, links)),
      name: `${link.id} · ${LINK_TYPE_LABELS[link.type]} · ${source.name} → ${target.name}；配置${link.enabled === false ? '停用' : '启用'}；暂无运行数据`,
      style: { color: '#8496a3', weight: selectedId === link.id ? 5 : 3, dashArray: '6 6', opacity: link.enabled === false ? 0.35 : 0.85, className: 'situation-map-configured-link' },
      hitClass: 'situation-map-configured-link-hit', select: () => onSelect(link),
    }]
  }))
}

/** 文件连线只表达登记关联；端点始终取本轮最新节点坐标，明细保留原始方向。 */
function renderFileLinks(group: L.LayerGroup, nodes: SituationMapNode[], links: FileCommunicationLink[], onSelect: (link: FileCommunicationLink) => void): void {
  const platforms = new Map(nodes.map(node => [node.platformId, node]))
  // 只画已登记的星地关联，不把端到端登记当直连，也不自动补出中继路径。
  const drawableLinks = links.filter(link => {
    if (link.type !== 'SAT') return true
    const types = [platforms.get(link.sourcePlatformId)?.type, platforms.get(link.targetPlatformId)?.type]
    return types.some(type => type === 'TIAN_TONG_SAT' || type === 'SHEN_TONG_SAT')
      && types.some(type => type === 'MISSION_UAV_PLATFORM' || type === 'REAR_COMM_PLATFORM' || type === 'COMMAND_VEHICLE_PLATFORM')
  })
  renderConnections(group, drawableLinks.flatMap(link => {
    const source = platforms.get(link.sourcePlatformId)
    const target = platforms.get(link.targetPlatformId)
    if (!source || !target) return []
    return [{
      id: `file:${link.id}`, points: sampleConnectionCurve(source, target, connectionCurveOffset(source, target, link.type, drawableLinks)),
      name: `${FILE_COMMUNICATION_LABELS[link.type]}关联：${source.name} — ${target.name}；${link.records.length} 条登记；状态未知，不表示当前正在转发`,
      style: { ...(link.type === 'FIBER' ? { color: '#20b2aa', weight: 3, opacity: 0.95 } : LINK_TYPE_STYLES[link.type]), className: 'situation-map-file-link' },
      hitClass: 'situation-map-file-link-hit', select: () => onSelect(link),
    }]
  }))
}

const interferenceLayers = new WeakMap<L.LayerGroup, Map<string, { circle: L.Circle; selected: boolean }>>()

/** 复用范围圈，文字说明留在详情；不由范围推断设备启停或链路质量。 */
function renderInterference(group: L.LayerGroup, frame: TelemetryFrame | null, selectedJammerId: string, fileNodes: SituationMapNode[] = [], fileDeviceStates: FileDeviceEvent[] = []): void {
  const entries = interferenceLayers.get(group) ?? new Map<string, { circle: L.Circle; selected: boolean }>()
  interferenceLayers.set(group, entries)
  const platforms = frame?.platforms.filter(platform => platform.jammers.some(jammer => jammer.active))
    ?? fileNodes.filter(node => fileJammerRadiusMeters(node.platformId, fileDeviceStates, MAP_CONFIG.fileInterferenceRadiusMeters) !== undefined)
  const ids = new Set(platforms.map(platform => platform.platformId))
  for (const [id, entry] of entries) {
    if (!ids.has(id)) { group.removeLayer(entry.circle); entries.delete(id) }
  }
  for (const platform of platforms) {
    const selected = frame?.platforms.find(node => node.platformId === platform.platformId)?.jammers
      .some(jammer => jammer.active && jammer.jammerId === selectedJammerId) ?? false
    const radius = frame ? MAP_CONFIG.activeInterferenceRadiusMeters : fileJammerRadiusMeters(platform.platformId, fileDeviceStates, MAP_CONFIG.fileInterferenceRadiusMeters)!
    let entry = entries.get(platform.platformId)
    if (entry && !entry.circle.getLatLng().equals(pointForPlatform(platform))) entry.circle.setLatLng(pointForPlatform(platform))
    if (entry?.selected === selected && entry.circle.getRadius() === radius) continue
    const color = selected ? '#f5b942' : '#ff526d'
    const style: L.CircleMarkerOptions = {
      color, weight: selected ? 4 : 1.5, opacity: selected ? 1 : 0.9, dashArray: '8 6',
      fill: true, fillColor: color, fillOpacity: selected ? 0.2 : 0.09,
      className: selected ? 'situation-map-interference--selected' : '', interactive: true,
    }
    if (!entry) {
      const circle = L.circle(pointForPlatform(platform), { ...style, radius }).addTo(group)
      entry = { circle, selected }
      entries.set(platform.platformId, entry)
    } else {
      entry.circle.setRadius(radius)
      entry.circle.setStyle(style)
      entry.circle.getElement()?.classList.toggle('situation-map-interference--selected', selected)
      entry.selected = selected
    }
  }
}

/**
 * 生成任务范围内的 0.5 度经纬网，避免低缩放视图下网线过密。
 * @param group 经纬网专用图层组。
 * @param theme 当前地图主题，用于选择可读的网线和文字颜色。
 * @returns 无返回值。
 * @sideeffect 清空并向图层组添加本地生成的网线和坐标标签。
 */
function renderGrid(group: L.LayerGroup, theme: MapTheme): void {
  group.clearLayers()
  const south = taskBounds.getSouth()
  const north = taskBounds.getNorth()
  const west = taskBounds.getWest()
  const east = taskBounds.getEast()
  const interval = MAP_CONFIG.gridIntervalDegrees
  const gridColor = theme === 'light' ? '#667f91' : '#31506a'

  for (
    let longitudeStep = Math.ceil(west / interval);
    longitudeStep <= Math.floor(east / interval);
    longitudeStep += 1
  ) {
    const longitude = longitudeStep * interval
    L.polyline([[south, longitude], [north, longitude]], {
      color: gridColor,
      weight: 0.75,
      opacity: 0.7,
      dashArray: '3 5',
      interactive: false,
    }).addTo(group)
    createGridLabel(`${longitude.toFixed(1)}°E`, [south, longitude], [34, 14], [17, -1], theme).addTo(group)
  }

  for (
    let latitudeStep = Math.ceil(south / interval);
    latitudeStep <= Math.floor(north / interval);
    latitudeStep += 1
  ) {
    const latitude = latitudeStep * interval
    L.polyline([[latitude, west], [latitude, east]], {
      color: gridColor,
      weight: 0.75,
      opacity: 0.7,
      dashArray: '3 5',
      interactive: false,
    }).addTo(group)
    createGridLabel(`${latitude.toFixed(1)}°N`, [latitude, west], [40, 14], [-20, 7], theme).addTo(group)
  }
}

/**
 * 创建无交互的经纬网文字标记。
 * @param text 要显示的坐标文字。
 * @param position 标记的纬度、经度位置。
 * @param size 图标宽高。
 * @param anchor 图标锚点。
 * @param theme 当前地图主题，用于选择可读的文字和阴影颜色。
 * @returns Leaflet 文字标记。
 * @sideeffect 创建承载坐标文字的安全 DOM 元素。
 */
function createGridLabel(
  text: string,
  position: L.LatLngTuple,
  size: L.PointExpression,
  anchor: L.PointExpression,
  theme: MapTheme,
): L.Marker {
  const label = document.createElement('span')
  label.textContent = text
  label.style.color = theme === 'light' ? '#425c6d' : '#66849a'
  label.style.fontFamily = 'Consolas, monospace'
  label.style.fontSize = '12px'
  label.style.whiteSpace = 'nowrap'
  label.style.textShadow = theme === 'light' ? '0 1px 2px #f7fbfd' : '0 1px 2px #06111d'

  return L.marker(position, {
    icon: L.divIcon({
      html: label,
      className: 'situation-map-grid-label',
      iconSize: size,
      iconAnchor: anchor,
    }),
    keyboard: false,
    interactive: false,
  })
}

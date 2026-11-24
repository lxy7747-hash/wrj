import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { MAP_CONFIG, isSatellitePlatform, nodeCategory, nodeGlyph, nodeIconUrl, resolvePlatformCoordinates } from '../../config/map.config'
import type { MapBasemap, MapTheme } from '../../config/map.config'
import type { EngineFrameSnapshot, Environment, Link, LinkDirection, TelemetryFrame, UiLinkStatus } from '../../contracts/domain-models'
import type { SituationMapNode } from '../../features/situation/initial-nodes'
import { FILE_COMMUNICATION_LABELS, type FileCommunicationLink, type FileCommunicationType } from '../../features/situation/file-communication-links'
import { fileLinkDeviceStatus, type FileDeviceEvent } from '../../features/situation/file-device-events'
import { engineJammerNodes, interferenceRangeSource, selectDetectionRanges, selectInterferenceRanges, type ConfiguredJammerRange } from '../../features/situation/interference-ranges'
import { extractActiveJammingOverlay } from '../../features/situation/engine-narrative'
import type { NodeTrail } from '../../features/situation/node-trails'
import type { FileMessageDirection, FileMessageLink } from '../../features/situation/file-message-links'
import {
  FILE_MESSAGE_DIRECTION_LABELS,
  readSingleMessageDirection,
} from '../../features/situation/file-message-links'
import type { LiveMessageFlowLane } from '../../features/situation/live-message-flows'
import type { EngineLinkHover } from '../../features/situation/engine-link-hover'
import { createOfflineVectorLabelLayer } from './offline-vector-label-layer'
import { createOfflineVectorBasemap, createVectorTileStyles } from './offline-vector-basemap'
import { createVectorTileSource } from './vector-tile-source'
import { createLiveFlowLayer, type LiveFlowPath } from './live-flow-layer'
import {
  LINK_TYPE_LABELS,
  PLATFORM_TYPE_LABELS,
  type SituationLinkView,
} from '../../features/situation/situation-model'

export type MapLayer = 'nodes' | 'links' | 'flow' | 'potential' | 'interference' | 'grid' | 'detection' | 'trails'

/** 场景链路在地图上的投影，距离仅来自已关联的运行数据。 */
export type SituationMapLink = Link & { distanceM?: number; hover?: EngineLinkHover }

/** 文件播放时钟；定位/换源必须更新 key，不把跳过的消息补播。 */
export interface FileLinkPlayback {
  time: number
  playing: boolean
  speed: number
  key: string
}

interface FileMessagePulse { eventId: string; time: number }

export interface SituationMapFocusTarget {
  kind: 'node' | 'link' | 'interference'
  targetId: string
}

/** 已由引擎当前帧端口唯一映射的切换路径标记；不是链路质量或选路结果。 */
export type ConfiguredLinkSwitchState = 'BEFORE' | 'AFTER' | 'BOTH'

export interface SituationMapControllerOptions {
  container: HTMLElement
  frame: TelemetryFrame | null
  engineFrame?: EngineFrameSnapshot | null
  nodeTrails?: NodeTrail[]
  /** 真实文件节点，无完整遥测帧时使用；后续位置通过 setNodes 更新。 */
  initialNodes?: SituationMapNode[]
  /** 已登记的通信关联，只表示路由登记，不是已发生的业务。 */
  fileLinks?: FileCommunicationLink[]
  /** 由消息收发证据推导的业务链路，是地图上链路图层的实际内容。 */
  fileMessageLinks?: FileMessageLink[]
  fileDeviceStates?: FileDeviceEvent[]
  configuredLinks?: SituationMapLink[]
  /** 场景里可定位的链路，含当前未画到地图上的；只用于点击定位，不参与绘制。 */
  focusLinks?: Link[]
  configuredLinkStatuses?: ReadonlyMap<string, UiLinkStatus>
  configuredLinkSwitches?: ReadonlyMap<string, ConfiguredLinkSwitchState>
  configuredJammers?: ConfiguredJammerRange[]
  configuredEnvironment?: Environment
  liveMessageFlows?: LiveMessageFlowLane[]
  liveFlowPlaying?: boolean
  liveFlowKey?: string
  onSelectConfiguredLink?: (link: Link) => void
  onSelectFileLink?: (link: FileCommunicationLink) => void
  onSelectFileMessageLink?: (link: FileMessageLink) => void
  links: SituationLinkView[]
  selectedNodeId: string
  onSelectNode: (platformId: string) => void
  onSelectLink: (link: SituationLinkView) => void
  onZoomChange: (zoom: number) => void
}

export interface SituationMapController {
  setEngineFrame: (frame: EngineFrameSnapshot | null) => void
  setNodeTrails: (trails: NodeTrail[]) => void
  setConfiguredLinks: (links: SituationMapLink[] | undefined) => void
  setConfiguredLinkStatuses: (statuses: ReadonlyMap<string, UiLinkStatus> | undefined) => void
  setConfiguredLinkSwitches: (switches: ReadonlyMap<string, ConfiguredLinkSwitchState> | undefined) => void
  setConfiguredJammers: (jammers: ConfiguredJammerRange[] | undefined) => void
  setConfiguredEnvironment: (environment: Environment | undefined) => void
  setLiveMessageFlows?: (flows: LiveMessageFlowLane[], options?: { playing: boolean; runKey: string }) => void
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
  /** 更新可定位的场景链路；不改变当前绘制的链路图层。 */
  setFocusLinks: (links: Link[]) => void
  /** 更新由消息证据推导的业务链路；与登记关联使用不同图层。 */
  setFileMessageLinks: (links: FileMessageLink[]) => void
  setFilePlayback: (playback: FileLinkPlayback, evidence?: readonly FileMessageLink[]) => void
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

const taskBounds = L.latLngBounds(
  MAP_CONFIG.taskBounds.map(([latitude, longitude]) => [latitude, longitude] as L.LatLngTuple),
)

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
    dashArray: '12 4 2 4',
  },
  FIBER: {
    color: '#20b2aa',
    weight: 3,
    opacity: 0.95,
  },
}

const UNAVAILABLE_LINK_STYLE: L.PathOptions = {
  color: '#f56c6c',
  weight: 3,
  opacity: 0.95,
}
/** 中断比劣化更深，避免和劣化的浅红混成同一种线。 */
const DOWN_LINK_STYLE: L.PathOptions = {
  color: '#8b1515',
  weight: 3,
  opacity: 0.95,
}

/** 节点配色：按事件日志的阵营区分红蓝；未标注阵营时保持既有青色，不臆造阵营。 */
const NODE_SIDE_COLORS: Record<string, string> = {
  red: '#f56c6c',
  blue: '#42d8ff',
}
const NODE_SELECTED_COLOR = '#f5b942'
const NODE_DEFAULT_COLOR = '#42d8ff'
/** 阵营中文说明，仅用于悬停提示，不额外增加图例。 */
const NODE_SIDE_LABELS: Record<string, string> = { red: '红方', blue: '蓝方' }

/** 取节点强调色；选中态优先，其次按阵营，最后回退默认色。 */
function nodeAccentColor(platform: SituationPlatform, selected: boolean): string {
  if (selected) return NODE_SELECTED_COLOR
  return NODE_SIDE_COLORS[platform.side ?? ''] ?? NODE_DEFAULT_COLOR
}

/** 取阵营说明文字；未标注阵营时返回空串，不补默认阵营。 */
function nodeSideLabel(platform: SituationPlatform): string {
  return NODE_SIDE_LABELS[platform.side ?? ''] ?? ''
}

/** 文件链路制式到线型的映射；FIBER 只出现在真实文件链路中，没有对应的运行链路类型。 */
const FILE_LINK_TYPE_STYLES: Record<FileCommunicationType, L.PathOptions> = {
  SAT: LINK_TYPE_STYLES.SAT,
  MICROWAVE: LINK_TYPE_STYLES.MICROWAVE,
  DATALINK: LINK_TYPE_STYLES.DATALINK,
  LASER: LINK_TYPE_STYLES.LASER,
  FIBER: { color: '#20b2aa', weight: 3, opacity: 0.95 },
}

// SVG pathLength 归一化整条路径；重复间距大于路径加尾迹，任何缩放下都只有一颗流星。
const LINK_FLOW_PATH_LENGTH = 1000
const LINK_FLOW_TRAIL_LENGTH = LINK_FLOW_PATH_LENGTH * MAP_CONFIG.linkFlowTrailRatio
const LINK_FLOW_TRAVEL = LINK_FLOW_PATH_LENGTH + LINK_FLOW_TRAIL_LENGTH
const LINK_FLOW_PERIOD = 2 * LINK_FLOW_TRAVEL
const LINK_FLOW_BRIGHTNESS = [0.12, 0.3, 0.6, 1] as const
const LINK_FLOW_STYLE: L.PathOptions = {
  weight: 2.5,
  opacity: 0.95,
  lineCap: 'butt',
  className: 'situation-map-link-flow',
  pane: 'linkFlowPane',
}

const LINK_STATUS_LABELS: Record<SituationLinkView['status'], string> = {
  UP: '正常',
  DEGRADED: '劣化',
  DOWN: '中断',
}

/**
 * 根据链路类型与运行状态生成地图线型。
 * @param link 当前帧链路视图。
 * @returns 正常链路使用类型配色，劣化使用浅红，中断使用深红。
 * @sideeffect 无副作用。
 */
function linkStyle(link: SituationLinkView): L.PathOptions {
  if (link.status === 'DOWN') return DOWN_LINK_STYLE
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
  // 脉冲在底线之上、节点之下；开关底线图层不会遮住尾迹，也不抢占点击。
  const flowPane = map.createPane('linkFlowPane')
  flowPane.style.zIndex = '450'
  flowPane.style.pointerEvents = 'none'
  const liveFlowLayer = createLiveFlowLayer(map, flowPane)
  const livePathCache = new Map<string, { geometry: string; points: L.LatLngTuple[] }>()
  const seaPane = map.createPane('scenario-sea')
  seaPane.style.zIndex = '315'
  seaPane.style.pointerEvents = 'none'
  let seaArea: L.Polygon | undefined
  let currentLinks = [...options.links]
  let currentFrame = options.frame
  let engineFrame = options.engineFrame
  let nodeTrails = options.nodeTrails ?? []
  let fileNodes = options.initialNodes ?? []
  let fileLinks = options.fileLinks ?? []
  let fileMessageLinks = options.fileMessageLinks ?? []
  let filePlayback: FileLinkPlayback | undefined
  const filePulses = new Map<string, FileMessagePulse>()
  let fileDeviceStates = options.fileDeviceStates ?? []
  let configuredLinks = options.configuredLinks
  let focusLinks = options.focusLinks ?? []
  let configuredLinkStatuses = options.configuredLinkStatuses
  let configuredLinkSwitches = options.configuredLinkSwitches
  let configuredJammers = options.configuredJammers
  let liveMessageFlows = options.liveMessageFlows ?? []
  let liveFlowPlaying = options.liveFlowPlaying ?? true
  let liveFlowKey = options.liveFlowKey ?? ''
  let currentNodes = engineJammerNodes(currentFrame?.platforms ?? fileNodes, engineFrame)
  let selectedNodeId = options.selectedNodeId
  let focusedTarget: SituationMapFocusTarget | null = null
  let currentTheme: MapTheme = MAP_CONFIG.defaults.theme
  let currentBasemap: MapBasemap = MAP_CONFIG.defaults.basemap
  let collapseUavMarkers = false

  const layerGroups: Record<MapLayer, L.LayerGroup> = {
    nodes: L.layerGroup(),
    links: L.layerGroup(),
    flow: L.layerGroup(),
    potential: L.layerGroup(),
    interference: L.layerGroup(),
    grid: L.layerGroup(),
    detection: L.layerGroup(),
    trails: L.layerGroup(),
  }
  const jammingEffectsGroup = L.layerGroup()
  const layerVisibility: Record<MapLayer, boolean> = {
    nodes: true,
    links: true,
    // 流向动画默认开启；组件在系统偏好「减少动态效果」时会先关闭该图层。
    flow: true,
    // 控制器不决定登记关联的让位策略，由组件按当前游标驱动。
    potential: true,
    interference: true,
    grid: MAP_CONFIG.defaults.gridVisible,
    detection: true,
    trails: MAP_CONFIG.defaults.trailsVisible,
  }
  const trailLines = new Map<string, L.Polyline>()
  function renderTrails(): void {
    const visible = nodeTrails.filter(trail => currentNodes.some(node => node.platformId === trail.platformId
      && (!isSatellitePlatform(node) || MAP_CONFIG.useSatelliteDataPosition)))
    const ids = new Set(visible.map(trail => trail.platformId))
    for (const [id, line] of trailLines) if (!ids.has(id)) { layerGroups.trails.removeLayer(line); trailLines.delete(id) }
    for (const trail of visible) {
      const points: L.LatLngTuple[] = trail.points.map(point => [point.latitude, point.longitude])
      const line = trailLines.get(trail.platformId)
      if (line) line.setLatLngs(points)
      else trailLines.set(trail.platformId, L.polyline(points, {
        color: '#48a9e8', weight: 2, opacity: 0.8, interactive: false, className: 'situation-map-node-trail',
      }).addTo(layerGroups.trails))
    }
  }

  function renderSceneLiveFlows(): void {
    if (currentFrame || !configuredLinks) {
      liveFlowLayer.clear()
      livePathCache.clear()
      return
    }
    liveFlowLayer.update(collectLiveFlowPaths(currentNodes, liveMessageFlows, livePathCache), liveFlowPlaying)
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

  function renderNodeLayer(): void {
    let highlightedNodeId = selectedNodeId
    if (focusedTarget?.kind === 'link') highlightedNodeId = ''
    if (focusedTarget?.kind === 'node') highlightedNodeId = focusedTarget.targetId
    if (focusedTarget?.kind === 'interference') {
      highlightedNodeId = currentFrame?.platforms.find((platform) => (
        platform.jammers.some((jammer) => jammer.jammerId === focusedTarget?.targetId)
      ))?.platformId ?? selectedNodeId
    }
    renderNodes(layerGroups.nodes, currentNodes, highlightedNodeId, handleMapNodeSelect, collapseUavMarkers, point => {
      map?.setView(point, MAP_CONFIG.zoom.uavClusterMax + 1)
    })
    renderNodeHeadings(layerGroups.nodes, nodeTrails, currentFrame?.simulationTime)
  }

  /** 根据当前联动目标重绘节点、链路和干扰范围的唯一高亮态。 */
  const renderBusinessLayers = (): void => {
    renderDetection(layerGroups.detection, currentFrame, currentNodes, configuredJammers, engineFrame, configuredLinks)
    // 底图复用后，切到场景或遥测源必须移除文件专属登记关联；实时场景叠加自身真实报文流向。
    if (currentFrame || configuredLinks) renderConnections(layerGroups.potential, [])
    if (currentFrame) {
      renderFlowSpecs(layerGroups.flow, [])
      renderInterference(
        layerGroups.interference,
        currentFrame,
        focusedTarget?.kind === 'interference' ? focusedTarget.targetId : '',
        currentNodes, configuredJammers, [], engineFrame,
      )
      renderLinks(
        layerGroups.links,
        currentFrame,
        currentLinks,
        focusedTarget?.kind === 'link' ? focusedTarget.targetId : '',
        handleMapLinkSelect,
      )
    } else if (configuredLinks) {
      renderFlowSpecs(layerGroups.flow, [])
      renderConfiguredLinks(layerGroups.links, currentNodes, configuredLinks, focusedTarget?.targetId ?? '', link => {
        focusedTarget = { kind: 'link', targetId: link.id }
        renderBusinessLayers()
        options.onSelectConfiguredLink?.(link)
      }, configuredLinkStatuses, configuredLinkSwitches)
      renderInterference(layerGroups.interference, null, focusedTarget?.kind === 'interference' ? focusedTarget.targetId : '', currentNodes, configuredJammers, [], engineFrame)
    } else {
      // 业务链路只陈述已发生的投递，不因设备启停被隐藏；设备状态在详情中单独呈现。
      renderMessageLinks(layerGroups.links, currentNodes, fileMessageLinks, focusedTarget?.targetId ?? '', link => {
        focusedTarget = { kind: 'link', targetId: link.id }
        options.onSelectFileMessageLink?.(link)
      }, layerGroups.flow, filePulses, filePlayback)
      // 仅过滤绘制：任一登记的两端均未明确关闭就保留合并线，完整明细不变。
      const visibleLinks = fileLinks.filter(link => link.records.length > 0 && fileLinkDeviceStatus(link, fileDeviceStates) !== '关闭')
      renderFileLinks(layerGroups.potential, currentNodes, visibleLinks, link => {
        focusedTarget = { kind: 'link', targetId: link.id }
        options.onSelectFileLink?.(link)
      })
      renderInterference(layerGroups.interference, null, '', currentNodes, configuredJammers, fileDeviceStates, engineFrame)
    }
    renderNodeLayer()
    renderJammingEffects(jammingEffectsGroup, currentNodes, engineFrame)
    renderTrails()
  }

  const offlineLabelPane = map.createPane('offline-label-pane')
  offlineLabelPane.style.zIndex = '350'
  offlineLabelPane.style.pointerEvents = 'none'

  const tileSource = createVectorTileSource()
  const vectorGrid = createOfflineVectorBasemap(currentTheme, tileSource).addTo(map)
  const offlineLabelLayer = MAP_CONFIG.defaults.basemapLabelsVisible
    ? createOfflineVectorLabelLayer(currentTheme, tileSource) : null
  offlineLabelLayer?.addTo(map)
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

  const layerOrder: MapLayer[] = ['grid', 'detection', 'potential', 'interference', 'trails', 'flow', 'links', 'nodes']
  layerOrder.forEach((layer) => {
    if (layerVisibility[layer]) layerGroups[layer].addTo(map as L.Map)
  })
  if (layerVisibility.interference) jammingEffectsGroup.addTo(map as L.Map)

  const handleZoomEnd = (): void => {
    if (!map) return
    const zoom = map.getZoom()
    const collapse = zoom <= MAP_CONFIG.zoom.uavClusterMax
    if (collapse !== collapseUavMarkers) {
      collapseUavMarkers = collapse
      renderNodeLayer()
    }
    options.onZoomChange(zoom)
  }
  map.on('zoomend', handleZoomEnd)
  map.fitBounds(taskBounds, { padding: [...MAP_CONFIG.fitPadding], animate: false })
  renderSceneLiveFlows()

  const setConfiguredEnvironment = (environment: Environment | undefined): void => {
    if (!map) return
    const polygon = environment?.multipathEnabled ? environment.seaPolygon : undefined
    if (!polygon || polygon.length < 3) {
      seaArea?.remove()
      seaArea = undefined
      return
    }
    const points = polygon.map(({ latitude, longitude }): L.LatLngTuple => [latitude, longitude])
    if (seaArea) {
      seaArea.setLatLngs(points)
      seaArea.getTooltip()?.setLatLng(seaArea.getCenter())
      return
    }
    seaArea = L.polygon(points, {
      pane: 'scenario-sea', color: '#39cfc8', weight: 1.5, opacity: 0.65, fillOpacity: 0.12, interactive: false,
    }).bindTooltip('海面多径区域', {
      pane: 'scenario-sea', permanent: true, direction: 'center', className: 'scenario-sea-label',
    }).addTo(map)
  }
  setConfiguredEnvironment(options.configuredEnvironment)

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
    setConfiguredEnvironment,
    setEngineFrame(frame): void {
      if (!map) return
      engineFrame = frame
      currentNodes = engineJammerNodes(currentFrame?.platforms ?? fileNodes, engineFrame)
      renderBusinessLayers()
      renderSceneLiveFlows()
    },
    setNodeTrails(trails): void {
      if (!map) return
      nodeTrails = trails
      renderTrails()
      renderNodeHeadings(layerGroups.nodes, nodeTrails, currentFrame?.simulationTime)
    },
    setConfiguredJammers(jammers): void {
      if (!map) return
      configuredJammers = jammers
      renderBusinessLayers()
    },
    setLiveMessageFlows(flows, opts): void {
      if (!map) return
      const nextKey = opts?.runKey ?? liveFlowKey
      if (nextKey !== liveFlowKey) {
        liveFlowLayer.clear()
        livePathCache.clear()
      }
      liveMessageFlows = flows
      if (opts) {
        liveFlowPlaying = opts.playing
        liveFlowKey = opts.runKey
      }
      renderSceneLiveFlows()
    },
    setConfiguredLinks(links): void {
      if (!map) return
      const sourceChanged = Boolean(configuredLinks) !== Boolean(links)
      configuredLinks = links
      if (!currentFrame) renderBusinessLayers()
      if (sourceChanged) renderSceneLiveFlows()
    },
    setFocusLinks(links): void {
      focusLinks = links
    },
    setConfiguredLinkStatuses(statuses): void {
      if (!map) return
      configuredLinkStatuses = statuses
      if (!currentFrame) renderBusinessLayers()
    },
    setConfiguredLinkSwitches(switches): void {
      if (!map) return
      configuredLinkSwitches = switches
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
      currentNodes = engineJammerNodes(frame?.platforms ?? fileNodes, engineFrame)
      if (!currentNodes.some((platform) => platform.platformId === selectedNodeId)) {
        selectedNodeId = currentNodes[0]?.platformId ?? ''
      }
      renderBusinessLayers()
      renderSceneLiveFlows()
    },

    setNodes(nodes): void {
      if (!map) return
      fileNodes = nodes
      if (currentFrame) return
      currentNodes = engineJammerNodes(nodes, engineFrame)
      if (!nodes.some((node) => node.platformId === selectedNodeId)) {
        selectedNodeId = nodes[0]?.platformId ?? ''
        focusedTarget = null
      }
      renderBusinessLayers()
      renderSceneLiveFlows()
    },

    setFileLinks(links): void {
      if (!map) return
      fileLinks = links
      if (!currentFrame) renderBusinessLayers()
    },

    setFileMessageLinks(links): void {
      if (!map) return
      fileMessageLinks = links
      if (!currentFrame && !configuredLinks) renderBusinessLayers()
    },

    setFilePlayback(playback, evidence = fileMessageLinks): void {
      if (!map) return
      const previous = filePlayback
      const validKeys = new Set<string>()
      const collectDirectionBuckets = (link: FileMessageLink) => {
        const buckets = new Set<FileMessageDirection | 'UNKNOWN'>()
        for (const record of link.records) buckets.add(readSingleMessageDirection(record.messageType) ?? 'UNKNOWN')
        return buckets
      }
      if (!previous || previous.key !== playback.key || playback.time < previous.time
        || (playback.time !== previous.time && !playback.playing)) {
        filePulses.clear()
      } else if (playback.playing && ((previous.playing && playback.time > previous.time)
        || (!previous.playing && playback.time === 0))) {
        const from = previous.time === 0 ? -Number.EPSILON : previous.time
        for (const link of evidence) {
          const buckets = collectDirectionBuckets(link)
          if (buckets.size <= 1) {
            let latest: FileMessagePulse | undefined
            for (const record of link.records) {
              const sentAt = record.time - record.delayS
              if (sentAt > from && sentAt <= playback.time && (!latest || sentAt > latest.time)) {
                latest = { eventId: record.transmitEventId, time: sentAt }
              }
            }
            if (latest) filePulses.set(link.id, latest)
            continue
          }
          for (const dirKey of buckets) {
            let latest: FileMessagePulse | undefined
            for (const record of link.records) {
              const recordDir = readSingleMessageDirection(record.messageType)
              if ((recordDir ?? 'UNKNOWN') !== dirKey) continue
              const sentAt = record.time - record.delayS
              if (sentAt > from && sentAt <= playback.time && (!latest || sentAt > latest.time)) {
              latest = { eventId: record.transmitEventId, time: sentAt }
              }
            }
            if (latest) filePulses.set(`${link.id}|${dirKey}`, latest)
          }
        }
      }
      for (const link of evidence) {
        const buckets = collectDirectionBuckets(link)
        if (buckets.size <= 1) validKeys.add(link.id)
        else for (const dirKey of buckets) validKeys.add(`${link.id}|${dirKey}`)
      }
      for (const id of filePulses.keys()) if (!validKeys.has(id)) filePulses.delete(id)
      filePlayback = { ...playback }
      if (!currentFrame && !configuredLinks) renderBusinessLayers()
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
          map.setView(pointForPlatform(platform, currentNodes), focusZoom, animation)
        }
        return
      }

      if (target.kind === 'link') {
        const drawn = configuredLinks ?? []
        const configured = drawn.find(candidate => candidate.id === target.targetId)
          ?? focusLinks.find(candidate => candidate.id === target.targetId)
        if (configured) {
          const platforms = new Map(currentNodes.map(node => [node.platformId, node]))
          const path = configuredConnectionPath(configured, currentNodes, drawn.some(candidate => candidate.id === configured.id) ? drawn : focusLinks, platforms)
          if (path) {
            focusedTarget = target
            if (drawn.some(candidate => candidate.id === configured.id)) renderBusinessLayers()
            map.fitBounds(L.latLngBounds(path.legs.flatMap(leg => leg.points)), {
              padding: [...MAP_CONFIG.fitPadding], maxZoom: focusZoom, ...animation,
            })
            return
          }
        }
      }

      if (!currentFrame && target.kind === 'link') {
        const link = fileLinks.find(candidate => candidate.id === target.targetId)
        const source = currentNodes.find(node => node.platformId === link?.sourcePlatformId)
        const destination = currentNodes.find(node => node.platformId === link?.targetPlatformId)
        if (source && destination) {
          focusedTarget = target
          renderBusinessLayers()
          map.fitBounds(L.latLngBounds(sampleConnectionCurve(source, destination, 0, currentNodes)), {
            padding: [...MAP_CONFIG.fitPadding], maxZoom: focusZoom, ...animation,
          })
        }
        return
      }
      if (!currentFrame && target.kind === 'interference') {
        const range = selectInterferenceRanges(currentNodes, null, configuredJammers, fileDeviceStates, engineFrame)
          .find(range => range.jammerId === target.targetId)
        const platform = currentNodes.find(node => node.platformId === range?.platformId)
        if (!platform || !range) return
        selectedNodeId = platform.platformId
        focusedTarget = target
        renderBusinessLayers()
        map.fitBounds(L.latLng(pointForPlatform(platform, currentNodes)).toBounds(range.radiusMeters * 2), {
          padding: [...MAP_CONFIG.fitPadding], maxZoom: focusZoom, ...animation,
        })
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
      const center = L.latLng(pointForPlatform(platform, currentNodes))
      const range = selectInterferenceRanges(currentNodes, currentFrame, configuredJammers, [], engineFrame)
        .find(range => range.platformId === platform.platformId && (!range.jammerId || range.jammerId === jammer.jammerId))
      if (jammer.active && range) {
        map.fitBounds(center.toBounds(range.radiusMeters * 2), {
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
      if (layer === 'flow') liveFlowLayer.setVisible(visible)
      if (visible) {
        layerGroups[layer].addTo(map)
        if (layer === 'interference') jammingEffectsGroup.addTo(map)
      } else {
        layerGroups[layer].removeFrom(map)
        if (layer === 'interference') jammingEffectsGroup.removeFrom(map)
      }
    },

    setTheme(theme): void {
      if (!map || currentTheme === theme) return
      currentTheme = theme
      vectorGrid.options.vectorTileLayerStyles = createVectorTileStyles(theme)
      if (currentBasemap === 'vector') {
        if (Number.isInteger(map.getZoom())) {
          vectorGrid.redraw()
          offlineLabelLayer?.setTheme(theme)
        } else {
          // GridLayer.redraw() 会直接使用分数 map zoom；重新挂载才会走 Leaflet 的整数瓦片网格选择。
          offlineLabelLayer?.setTheme(theme, false)
          vectorGrid.removeFrom(map)
          vectorGrid.addTo(map)
          offlineLabelLayer?.removeFrom(map)
          offlineLabelLayer?.addTo(map)
        }
      } else {
        offlineLabelLayer?.setTheme(theme, false)
      }
      renderGrid(layerGroups.grid, theme)
    },

    setBasemap(basemap): void {
      if (!map || currentBasemap === basemap) return
      currentBasemap = basemap
      if (basemap === 'satellite') {
        vectorGrid.removeFrom(map)
        offlineLabelLayer?.removeFrom(map)
        satelliteLayer.addTo(map)
        return
      }
      satelliteLayer.removeFrom(map)
      vectorGrid.addTo(map)
      offlineLabelLayer?.addTo(map)
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
      tileSource.clear()
      resizeObserver?.disconnect()
      resizeObserver = null
      removeResizeFallback?.()
      removeResizeFallback = null
      map.off('zoomend', handleZoomEnd)
      seaArea?.remove()
      offlineLabelLayer?.remove()
      liveFlowLayer.destroy()
      renderFlowSpecs(layerGroups.flow, [])
      map.remove()
      map = null
      Object.values(layerGroups).forEach((group) => {
        group.clearLayers()
        nodeLayers.delete(group)
        connectionLayers.delete(group)
        flowLayers.delete(group)
        interferenceLayers.delete(group)
        detectionLayers.delete(group)
      })
      jammingEffectsGroup.clearLayers()
      jammingPulseLayers.delete(jammingEffectsGroup)
      jammingBeamLayers.delete(jammingEffectsGroup)
      currentLinks = []
      trailLines.clear()
      nodeTrails = []
    },
  }
}

/**
 * 将 API 平台经纬度转换为 Leaflet 坐标顺序。
 * @param platform 固定帧中的平台状态。
 * @returns Leaflet 使用的 [纬度, 经度] 坐标。
 * @sideeffect 无副作用；解析展示坐标后调整经纬度排列顺序，不改写原始节点。
 */
function pointForPlatform(platform: SituationPlatform, nodes: readonly SituationMapNode[]): L.LatLngTuple {
  const coords = resolvePlatformCoordinates(platform, nodes)
  return [coords.latitude, coords.longitude]
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
 * @param count 标记所代表的节点数量。
 * @param label 地图上显示的节点名称。
 * @returns 只通过 textContent 写入名称和标识的 DOM 元素。
 * @sideeffect 创建新的 DOM 节点，不修改传入平台数据。
 */
function createNodeIconContent(platform: SituationPlatform, selected: boolean, count: number, label: string): HTMLElement {
  const compact = count > 1 || platform.type === 'AIRBORNE_MISSION_CLUSTER'
  const isSat = isSatellitePlatform(platform)
  const root = document.createElement('div')
  const imageUrl = nodeIconUrl(platform)
  root.className = imageUrl ? 'situation-map-node situation-map-node--image' : 'situation-map-node'
  root.style.display = 'flex'
  root.style.flexDirection = 'column'
  root.style.alignItems = 'center'
  root.style.color = nodeAccentColor(platform, selected)
  root.style.filter = selected ? 'drop-shadow(0 0 5px rgba(245, 185, 66, 0.85))' : 'none'

  const glyph = document.createElement('span')
  glyph.className = 'situation-map-node__glyph'
  glyph.setAttribute('aria-hidden', 'true')
  if (imageUrl) {
    const image = document.createElement('img')
    image.className = 'situation-map-node__image'
    image.src = imageUrl
    image.alt = ''
    image.draggable = false
    image.addEventListener('error', () => glyph.replaceChildren(document.createTextNode(nodeGlyph(platform))), { once: true })
    glyph.append(image)
  } else glyph.textContent = nodeGlyph(platform)
  glyph.dataset.nodeType = platform.type ?? ''
  glyph.style.fontSize = selected ? '24px' : '20px'
  glyph.style.lineHeight = '20px'
  glyph.style.webkitTextStroke = '1px #06111d'

  const name = document.createElement('span')
  name.className = 'situation-map-node__name'
  name.textContent = isSat ? `${label}（轨道示意）` : label
  name.style.display = compact ? 'none' : 'block'
  name.style.marginTop = '3px'
  name.style.color = '#d7e8f3'
  name.style.fontSize = '12px'
  name.style.fontWeight = selected ? '700' : '500'
  name.style.whiteSpace = 'nowrap'
  name.style.textShadow = '0 1px 3px #06111d, 0 0 4px #06111d'

  const id = document.createElement('span')
  id.className = 'situation-map-node__id'
  id.textContent = count > 1 ? `×${count}` : compact ? platform.platformId.replace('AIR-', 'U') : platform.platformId
  if (!compact && label === platform.platformId) id.style.display = 'none'
  id.style.color = '#7f9aad'
  id.style.fontFamily = 'Consolas, monospace'
  id.style.fontSize = '12px'
  id.style.whiteSpace = 'nowrap'
  id.style.textShadow = '0 1px 3px #06111d'

  root.append(glyph, name, id)
  return root
}

interface NodeLayer {
  marker: L.Marker
  appearance: string
  members: SituationMapNode[]
  image?: HTMLImageElement
}

const nodeLayers = new WeakMap<L.LayerGroup, Map<string, NodeLayer>>()

function nodeHeading(platform: SituationMapNode, trail: NodeTrail | undefined, simulationTime?: number): number | undefined {
  const { heading } = platform
  if (heading !== undefined && Number.isFinite(heading)) return heading

  const previous = trail?.points.at(-2)
  const current = trail?.points.at(-1)
  const time = platform.time ?? simulationTime
  // 位置和轨迹分开更新，转向只能使用当前节点已走到的轨迹段。
  if (!previous || !current || time === undefined || current.time > time
    || current.longitude !== platform.longitude || current.latitude !== platform.latitude) return undefined

  const longitudeDelta = ((current.longitude - previous.longitude + 540) % 360) - 180
  const from = L.Projection.SphericalMercator.project(L.latLng(previous.latitude, 0))
  const to = L.Projection.SphericalMercator.project(L.latLng(current.latitude, longitudeDelta))
  return from.equals(to) ? undefined : Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI
}

function uavGroupHeading(
  members: readonly SituationMapNode[],
  trailsByPlatformId: ReadonlyMap<string, NodeTrail>,
  simulationTime?: number,
): number | undefined {
  let east = 0
  let north = 0
  let totalSpeed = 0
  for (const member of members) {
    const { speed } = member
    if (!Number.isFinite(speed) || speed <= 0) continue
    const heading = nodeHeading(member, trailsByPlatformId.get(member.platformId), simulationTime)
    if (heading === undefined) continue
    const angle = (heading % 360) * Math.PI / 180
    east += speed * Math.sin(angle)
    north += speed * Math.cos(angle)
    totalSpeed += speed
  }
  // 运动互相抵消时，机群没有明确的整体朝向。
  if (Math.hypot(east, north) <= totalSpeed * 1e-6) return undefined
  return Math.atan2(east, north) * 180 / Math.PI
}

function renderNodeHeadings(group: L.LayerGroup, trails: NodeTrail[], simulationTime?: number): void {
  const trailsByPlatformId = new Map(trails.map(trail => [trail.platformId, trail]))
  for (const { members, image } of nodeLayers.get(group)?.values() ?? []) {
    if (!image) continue
    const platform = members[0]!
    const imageHeading = MAP_CONFIG.nodeImageHeadings[nodeCategory(platform) ?? '']
    if (imageHeading === undefined) continue
    const heading = members.length > 1
      ? uavGroupHeading(members, trailsByPlatformId, simulationTime)
      : nodeHeading(platform, trailsByPlatformId.get(platform.platformId), simulationTime)
    const transform = heading === undefined ? '' : `rotate(${(heading - imageHeading) % 360}deg)`
    if (image.style.transform !== transform) image.style.transform = transform
  }
}

/** 按节点身份复用 Marker；位置更新不替换图标，选中和名称变化只更新对应图标。 */
function renderNodes(
  group: L.LayerGroup,
  nodes: SituationMapNode[],
  selectedNodeId: string,
  onSelectNode: (platformId: string) => void,
  collapseUavMarkers: boolean,
  onExpandCluster: (point: L.LatLng) => void,
): void {
  const entries = nodeLayers.get(group) ?? new Map<string, NodeLayer>()
  nodeLayers.set(group, entries)
  const visible = new Map<string, SituationMapNode[]>()
  const uavGroups = new Map<string, SituationMapNode[]>()
  for (const node of nodes) {
    // 该文件模型也用于高空中继；缺少角色时保留独立标记。
    if (collapseUavMarkers && node.type !== 'MISSION_UAV_PLATFORM' && nodeCategory(node) === 'AIRBORNE_MISSION_CLUSTER') {
      const side = node.side ?? ''
      const members = uavGroups.get(side) ?? []
      members.push(node)
      uavGroups.set(side, members)
    } else {
      visible.set(`node:${node.platformId}`, [node])
    }
  }
  for (const [side, members] of uavGroups) {
    visible.set(members.length > 1 ? `uav:${side}` : `node:${members[0]!.platformId}`, members)
  }
  for (const [id, entry] of entries) {
    if (!visible.has(id)) { group.removeLayer(entry.marker); entries.delete(id) }
  }
  for (const [key, members] of visible) {
    const platform = members[0]!
    const clustered = members.length > 1
    const selected = members.some(node => node.platformId === selectedNodeId)
    const point = clustered
      ? L.latLngBounds(members.map(node => pointForPlatform(node, nodes))).getCenter()
      : pointForPlatform(platform, nodes)
    // 阵营变化也必须重建图标，否则改阵营后配色不会更新。
    const appearance = JSON.stringify([platform.name, platform.type, platform.satelliteType, platform.side, selected, members.length])
    const orbitSuffix = isSatellitePlatform(platform) ? '（轨道示意）' : ''
    const clusterLabel = `无人机群（${members.length} 架）`
    const category = nodeCategory(platform)
    const commandLabel = category === 'REAR_COMMAND_NODE' || category === 'GROUND_CLUSTER_COMMAND_NODE' ? PLATFORM_TYPE_LABELS[category] : undefined
    const label = commandLabel ?? platform.name
    const accessibleName = clustered ? `展开${clusterLabel}` : `选择节点 ${label}${orbitSuffix}`
    let entry = entries.get(key)
    if (!entry) {
      const marker = L.marker(point, {
        title: accessibleName,
        keyboard: true, riseOnHover: true, riseOffset: 500, bubblingMouseEvents: false,
      })
      const activate = clustered ? () => onExpandCluster(marker.getLatLng()) : () => onSelectNode(platform.platformId)
      marker.on('click', activate)
      bindMarkerKeyboardSelection(marker, activate)
      entry = { marker, appearance: '', members }
      entries.set(key, entry)
    }
    const { marker } = entry
    entry.members = members
    if (!marker.getLatLng().equals(point)) marker.setLatLng(point)
    if (entry.appearance !== appearance) {
      const compact = clustered || platform.type === 'AIRBORNE_MISSION_CLUSTER'
      const hasImage = !!nodeIconUrl(platform)
      const width = compact ? (hasImage ? 48 : 44) : 160
      const content = createNodeIconContent(platform, selected, members.length, label)
      entry.image = content.querySelector('img') ?? undefined
      marker.options.title = accessibleName
      marker.setIcon(L.divIcon({
        html: content,
        className: selected ? 'situation-map-node-marker situation-map-node-marker--selected' : 'situation-map-node-marker',
        iconSize: [width, hasImage ? (compact ? 68 : 88) : (compact ? 40 : 52)],
        iconAnchor: [width / 2, hasImage ? 24 : 16], tooltipAnchor: [0, hasImage ? -24 : -16],
      }))
      const element = marker.getElement()
      if (element) element.title = accessibleName
      marker.setZIndexOffset(selected ? 1000 : 0)
      const tooltip = document.createElement('span')
      const sideLabel = nodeSideLabel(platform)
      const nodeLabel = commandLabel
        ? commandLabel + (platform.name === commandLabel ? '' : ` · ${platform.name}`)
        : `${platform.name}${orbitSuffix} · ${PLATFORM_TYPE_LABELS[platform.type as keyof typeof PLATFORM_TYPE_LABELS] ?? platform.type}`
      tooltip.textContent = (clustered ? clusterLabel : nodeLabel) + (sideLabel ? ` · ${sideLabel}` : '')
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
  return sampleConnectionCurve(source, destination, connectionCurveOffset(source, destination, link.type, peers), frame.platforms)
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

/**
 * 业务链路的分离偏移：同一节点对上再按「方向 + 制式」分道。
 * @param link 当前要绘制的有向业务链路。
 * @param links 当前时刻全部可见的业务链路，用于判断该节点对上是否存在反向链路。
 * @returns 控制点偏移；该节点对只有一条链路时返回 0（保持直线）。
 * @remarks 业务链路的收发方向是证据本身，因此不对偏移做方向归一：
 * 只画单方向时是直线，两个方向同时可见时各自向相反一侧弯曲，避免互相压盖。
 */
function messageLinkCurveOffset(
  link: Pick<FileMessageLink, 'sourcePlatformId' | 'targetPlatformId' | 'type'>,
  links: ReadonlyArray<Pick<FileMessageLink, 'sourcePlatformId' | 'targetPlatformId' | 'type'>>,
): number {
  const samePair = links.filter(candidate => (
    candidate.sourcePlatformId === link.sourcePlatformId && candidate.targetPlatformId === link.targetPlatformId
  ) || (
    candidate.sourcePlatformId === link.targetPlatformId && candidate.targetPlatformId === link.sourcePlatformId
  ))
  // 方向术语：把节点标识较小的一端记为起点，使同向同类只占一条车道。
  const laneOf = (candidate: Pick<FileMessageLink, 'sourcePlatformId' | 'targetPlatformId' | 'type'>): string => {
    const forward = candidate.sourcePlatformId <= candidate.targetPlatformId
    return `${forward ? 'F' : 'R'}|${candidate.type}`
  }
  const lanes = [...new Set(samePair.map(laneOf))].sort()
  if (lanes.length < 2) return 0
  return (lanes.indexOf(laneOf(link)) / (lanes.length - 1) - 0.5) * MAP_CONFIG.linkCurveSeparationRatio
}

interface FlowLaneCurveInput {
  sourcePlatformId: string
  targetPlatformId: string
  type: FileCommunicationType
  directionKey: string
}

/** 同一跳段承载不同业务方向或对向报文时按车道对称偏移，避免流星互相压盖。 */
function flowLaneCurveOffset(lane: FlowLaneCurveInput, lanesAll: readonly FlowLaneCurveInput[]): number {
  const samePair = lanesAll.filter((candidate) => (
    candidate.sourcePlatformId === lane.sourcePlatformId && candidate.targetPlatformId === lane.targetPlatformId
  ) || (
    candidate.sourcePlatformId === lane.targetPlatformId && candidate.targetPlatformId === lane.sourcePlatformId
  ))
  const laneOf = (item: FlowLaneCurveInput): string => (
    `${item.sourcePlatformId <= item.targetPlatformId ? 'F' : 'R'}|${item.type}|${item.directionKey}`
  )
  const sorted = [...new Set(samePair.map(laneOf))].sort()
  if (sorted.length < 2) return 0
  return (sorted.indexOf(laneOf(lane)) / (sorted.length - 1) - 0.5) * MAP_CONFIG.linkCurveSeparationRatio
}

/**
 * 偏移按端点距离缩放且垂直于连线；方向归一保证端点反转后曲线不翻边，不改变节点位置。
 * @remarks 方向归一之后，两个方向的控制点偏移方向相同，因此给不同车道分配**符号相反**的偏移
 * 即可把两个方向分到连线两侧；若去掉归一，反向遍历本身会把偏移翻向同侧，反而无法分离。
 */
function sampleConnectionCurve(source: SituationMapNode, destination: SituationMapNode, offset: number, nodes: readonly SituationMapNode[]): L.LatLngTuple[] {
  const [sourceLatitude, sourceLongitude] = pointForPlatform(source, nodes)
  const [destinationLatitude, destinationLongitude] = pointForPlatform(destination, nodes)
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
  /** 链路点击热区图标的落点；中继折线需落在段中点，避免压住中继平台图标。 */
  hitPoint?: L.LatLngTuple
  tooltipText?: string
  name: string
  style: L.PathOptions
  hitClass: string
  select: () => void
  /** 有向链路的方向箭头；无向关联不设置。rotation 为 CSS 顺时针角度，0 指向正东。 */
  arrow?: { position: L.LatLngTuple; rotation: number }
  /** 异常或切换链路的中点轻量状态徽标。 */
  badge?: { text: string; variant: 'down' | 'degraded' | 'switch-before' | 'switch-after' }
}
interface ConnectionLayer {
  line: L.Polyline
  marker: L.Marker
  tooltipContent: HTMLSpanElement
  drawing: ConnectionDrawing
  geometry: string
  appearance: string
  arrow?: L.Marker
  arrowAppearance?: string
  badge?: L.Marker
  badgeAppearance?: string
}
const connectionLayers = new WeakMap<L.LayerGroup, Map<string, ConnectionLayer>>()
interface FlowSpec {
  id: string
  points: L.LatLngTuple[]
  flow: L.PathOptions
  pulseId?: string
  playback?: FileLinkPlayback
}
interface FlowLayer {
  lines: L.Polyline[]
  geometry: string
  appearance: string
  pulseId?: string
  elapsedMs: number
  updatedAt: number
  playing: boolean
}
/** 流向叠加载独立图层组管理，与主连线几何完全一致。 */
const flowLayers = new WeakMap<L.LayerGroup, Map<string, FlowLayer>>()

/** 由曲线采样点生成方向箭头；取偏后位置避免与节点图标和端点重合。 */function curveArrow(points: L.LatLngTuple[]): { position: L.LatLngTuple; rotation: number } | undefined {
  if (points.length < 4) return undefined
  const index = Math.max(1, Math.round((points.length - 1) * 0.72))
  const [fromLatitude, fromLongitude] = points[index - 1]!
  const [toLatitude, toLongitude] = points[index]!
  const east = toLongitude - fromLongitude
  const north = toLatitude - fromLatitude
  if (east === 0 && north === 0) return undefined
  // 图标使用 “▲”，默认指向正北；CSS rotate 顺时针为正。
  // 因此旋转角是「由正北顺时针转到链路方向」的夹角，而不是由正东起算。
  // 注意 Leaflet 按 Web Mercator 绘制，此处按经纬度线性近似，跨纬度大范围链路会有几度偏差。
  return { position: points[index]!, rotation: Math.atan2(east, north) * 180 / Math.PI }
}

/** 取链路样式颜色用于箭头着色；函数式样式不提供颜色时回退为当前文字色。 */
function arrowColor(style: L.PathOptions): string {
  return typeof style.color === 'string' ? style.color : '#c0c4cc'
}

/** 三种来源共用图层更新；回调始终读取最新记录，隐藏图层也只更新、不重新开启。 */
function renderConnections(group: L.LayerGroup, drawings: ConnectionDrawing[]): void {
  const entries = connectionLayers.get(group) ?? new Map<string, ConnectionLayer>()
  connectionLayers.set(group, entries)
  const ids = new Set(drawings.map(drawing => drawing.id))
  for (const [id, entry] of entries) {
    if (!ids.has(id)) {
      group.removeLayer(entry.line)
      group.removeLayer(entry.marker)
      if (entry.arrow) group.removeLayer(entry.arrow)
      if (entry.badge) group.removeLayer(entry.badge)
      entries.delete(id)
    }
  }
  for (const drawing of drawings) {
    const midpoint = drawing.hitPoint ?? drawing.points[Math.floor(drawing.points.length / 2)]!
    const geometry = JSON.stringify([drawing.points, midpoint])
    const appearance = JSON.stringify([drawing.name, drawing.style])
    const tooltipText = drawing.tooltipText ?? drawing.name
    let entry = entries.get(drawing.id)
    if (!entry) {
      const hit = document.createElement('span')
      hit.textContent = drawing.name
      hit.style.cssText = 'display:block;width:28px;height:28px;opacity:0'
      const marker = L.marker(midpoint, {
        icon: L.divIcon({ html: hit, className: drawing.hitClass, iconSize: [28, 28], iconAnchor: [14, 14] }),
        keyboard: true, title: drawing.name, bubblingMouseEvents: false, zIndexOffset: 750,
      })
      const tooltipContent = document.createElement('span')
      if (drawing.tooltipText !== undefined) tooltipContent.className = 'situation-map-link-tooltip'
      tooltipContent.textContent = tooltipText
      const line = L.polyline(drawing.points, { ...drawing.style, bubblingMouseEvents: false, interactive: true })
        .bindTooltip(tooltipContent, { sticky: true })
      const created: ConnectionLayer = { line, marker, tooltipContent, drawing, geometry, appearance: '' }
      const select = () => created.drawing.select()
      line.on('click', select)
      marker.on('click', select)
      marker.on('mouseover', () => line.openTooltip(marker.getLatLng()))
      marker.on('mouseout', () => line.closeTooltip())
      marker.on('add', () => {
        const element = marker.getElement()
        element?.setAttribute('aria-label', created.drawing.name)
        element?.removeAttribute('title')
      })
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
      const lineElement = entry.line.getElement()
      if (lineElement instanceof SVGElement) lineElement.style.setProperty('--situation-link-color', drawing.style.color ?? '#42d8ff')
      lineElement?.classList.toggle('situation-map-link--selected', drawing.style.className === 'situation-map-link--selected')
      lineElement?.classList.toggle('situation-map-link--switch-before', drawing.style.className?.includes('situation-map-link--switch-before') ?? false)
      lineElement?.classList.toggle('situation-map-link--switch-after', drawing.style.className?.includes('situation-map-link--switch-after') ?? false)
      lineElement?.classList.toggle('situation-map-link--switch-both', drawing.style.className?.includes('situation-map-link--switch-both') ?? false)
      entry.marker.options.title = drawing.name
      entry.marker.getElement()?.setAttribute('aria-label', drawing.name)
      const hit = (entry.marker.options.icon as L.DivIcon).options.html as HTMLElement
      hit.textContent = drawing.name
      entry.appearance = appearance
    }
    if (entry.tooltipContent.textContent !== tooltipText) {
      entry.tooltipContent.textContent = tooltipText
      entry.line.getTooltip()?.update()
    }
    syncArrowMarker(group, entry, drawing)
    syncStatusBadgeMarker(group, entry, drawing, midpoint)
  }
}

/** 统一刷新文件回放与实时场景仿真的报文流向脉冲。 */
function renderFlowSpecs(
  flowGroup: L.LayerGroup | undefined,
  specs: FlowSpec[],
): void {
  if (!flowGroup) return
  const flows = flowLayers.get(flowGroup) ?? new Map<string, FlowLayer>()
  flowLayers.set(flowGroup, flows)
  const ids = new Set(specs.map(spec => spec.id))
  for (const [id, entry] of flows) {
    if (!ids.has(id)) {
      entry.lines.forEach(line => flowGroup.removeLayer(line))
      flows.delete(id)
    }
  }
  const restartPaths: SVGPathElement[] = []
  for (const spec of specs) syncFlowLine(flowGroup, flows, spec, restartPaths)
  // 一次布局让本批移除的动画类统一生效，再恢复类以重启 scoped 动画。
  restartPaths[0]?.getBoundingClientRect()
  for (const path of restartPaths) path.classList.add('situation-map-link-flow')
}

/** 按需创建、更新或移除流向叠加线；几何始终与主连线一致。 */
function syncFlowLine(
  flowGroup: L.LayerGroup,
  flows: Map<string, FlowLayer>,
  spec: FlowSpec,
  restartPaths: SVGPathElement[],
): void {
  const geometry = JSON.stringify(spec.points)
  const appearance = JSON.stringify(spec.flow)
  let entry = flows.get(spec.id)
  const segmentLength = LINK_FLOW_TRAIL_LENGTH / LINK_FLOW_BRIGHTNESS.length
  const segmentStyle = (index: number): L.PathOptions => ({
    ...spec.flow,
    color: '#e8fcff',
    dashArray: `${segmentLength} ${LINK_FLOW_PERIOD - segmentLength}`,
    dashOffset: `${LINK_FLOW_TRAIL_LENGTH - index * segmentLength}`,
    weight: 1.5 + index * 0.7,
    opacity: (spec.flow.opacity ?? 1) * LINK_FLOW_BRIGHTNESS[index]!,
    interactive: false,
    bubblingMouseEvents: false,
  })
  if (!entry) {
    const created: FlowLayer = { lines: [], geometry, appearance, elapsedMs: Infinity,
      updatedAt: performance.now(), playing: false }
    const lines = LINK_FLOW_BRIGHTNESS.map((_, index) => {
      const line = L.polyline(spec.points, segmentStyle(index))
      // 图层重开后 SVG 元素会重建，需恢复同一组脉冲相位。
      line.on('add', () => { applyFlowAnimation(line, created) })
      line.addTo(flowGroup)
      return line
    })
    created.lines = lines
    flows.set(spec.id, created)
    entry = created
  }
  if (entry.geometry !== geometry) {
    entry.lines.forEach(line => line.setLatLngs(spec.points))
    entry.geometry = geometry
  }
  if (entry.appearance !== appearance) {
    entry.lines.forEach((line, index) => {
      line.setStyle(segmentStyle(index))
    })
    entry.appearance = appearance
  }
  const now = performance.now()
  const elapsed = entry.elapsedMs + (entry.playing ? now - entry.updatedAt : 0)
  const playing = spec.playback?.playing ?? false
  const pulseChanged = entry.pulseId !== spec.pulseId
  const startsNewPulse = pulseChanged && !!spec.pulseId && elapsed >= MAP_CONFIG.linkFlowCycleSeconds * 1000
  entry.pulseId = spec.pulseId
  // 在途投递只更新标识，沿用浏览器正在播放的动画和计时。
  if (startsNewPulse || (pulseChanged && !spec.pulseId) || entry.playing !== playing) {
    entry.elapsedMs = !spec.pulseId ? Infinity : startsNewPulse ? 0 : elapsed
    entry.updatedAt = now
    entry.playing = playing
    for (const line of entry.lines) {
      const path = applyFlowAnimation(line, entry)
      if (!path) continue
      path.classList.remove('situation-map-link-flow')
      restartPaths.push(path)
    }
  }
}

/**
 * 给单次流星写入归一化路径与行程：首尾整颗流星均位于路径外，不会停在终点。
 * 尾迹比例和时长来自 MAP_CONFIG；动画名由组件 scoped 样式提供，行内只覆盖参数，
 * 避免 Vue 的局部 @keyframes 哈希重命名与行内名字失配。
 */
function applyFlowAnimation(line: L.Polyline, flow: FlowLayer): SVGPathElement | undefined {
  const element = line.getElement() as SVGPathElement | undefined
  if (!element) return
  element.setAttribute('pathLength', `${LINK_FLOW_PATH_LENGTH}`)
  const offset = Number(line.options.dashOffset ?? 0)
  element.style.setProperty('--situation-link-flow-start', `${offset}`)
  element.style.setProperty('--situation-link-flow-shift', `${offset - LINK_FLOW_TRAVEL}`)
  // 事件由数据时钟触发，流星按现实时间展示；倍速不能压缩动画或跳过其可见部分。
  const elapsed = flow.elapsedMs + (flow.playing ? performance.now() - flow.updatedAt : 0)
  element.style.visibility = Number.isFinite(elapsed) ? '' : 'hidden'
  element.style.animationDuration = `${MAP_CONFIG.linkFlowCycleSeconds}s`
  element.style.animationDelay = `${-Math.min(elapsed, MAP_CONFIG.linkFlowCycleSeconds * 1000)}ms`
  element.style.animationPlayState = flow.playing ? 'running' : 'paused'
  return element
}

/** 按需创建、更新或移除方向箭头；无箭头的链路不会残留上一次的标记。 */
function syncArrowMarker(group: L.LayerGroup, entry: ConnectionLayer, drawing: ConnectionDrawing): void {
  if (!drawing.arrow) {
    if (entry.arrow) {
      group.removeLayer(entry.arrow)
      entry.arrow = undefined
      entry.arrowAppearance = undefined
    }
    return
  }
  const arrowAppearance = JSON.stringify([drawing.arrow.position, Math.round(drawing.arrow.rotation), arrowColor(drawing.style)])
  if (entry.arrow && entry.arrowAppearance === arrowAppearance) return
  const glyph = document.createElement('span')
  glyph.className = 'situation-map-link-arrow__glyph'
  glyph.textContent = '▲'
  glyph.style.color = arrowColor(drawing.style)
  glyph.style.transform = `rotate(${drawing.arrow.rotation}deg)`
  const icon = L.divIcon({
    html: glyph,
    className: 'situation-map-link-arrow',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  })
  if (entry.arrow) {
    entry.arrow.setLatLng(drawing.arrow.position)
    entry.arrow.setIcon(icon)
  } else {
    entry.arrow = L.marker(drawing.arrow.position, { icon, interactive: false, keyboard: false }).addTo(group)
  }
  entry.arrowAppearance = arrowAppearance
}

/** 按需创建、更新或移除链路中点状态/切换徽标（非交互，避免遮挡点击热区）。 */
function syncStatusBadgeMarker(
  group: L.LayerGroup,
  entry: ConnectionLayer,
  drawing: ConnectionDrawing,
  midpoint: L.LatLngTuple,
): void {
  if (!drawing.badge) {
    if (entry.badge) {
      group.removeLayer(entry.badge)
      entry.badge = undefined
      entry.badgeAppearance = undefined
    }
    return
  }
  const badgeAppearance = JSON.stringify([midpoint, drawing.badge.text, drawing.badge.variant])
  if (entry.badge && entry.badgeAppearance === badgeAppearance) return
  const pill = document.createElement('span')
  pill.className = `situation-map-link-badge situation-map-link-badge--${drawing.badge.variant}`
  pill.textContent = drawing.badge.text
  const icon = L.divIcon({
    html: pill,
    className: 'situation-map-link-badge-wrap',
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
  if (entry.badge) {
    entry.badge.setLatLng(midpoint)
    entry.badge.setIcon(icon)
  } else {
    entry.badge = L.marker(midpoint, { icon, interactive: false, keyboard: false, zIndexOffset: 770 }).addTo(group)
  }
  entry.badgeAppearance = badgeAppearance
}

function formatLinkDistance(meters: number | null | undefined): string | undefined {
  if (meters == null || !Number.isFinite(meters) || meters < 0) return undefined
  return meters < 1000 ? `${meters.toFixed(0)} m` : `${(meters / 1000).toFixed(2)} km`
}

const HOVER_NO_DATA = '暂无数据'

function formatHoverNumber(value: number | null | undefined, unit = ''): string | undefined {
  return value != null && Number.isFinite(value) ? `${Number(value.toPrecision(8))}${unit}` : undefined
}

function linkHoverText(name: string, route: string, metrics: {
  direction?: LinkDirection
  segmentMargin?: string
  segmentDelay?: string
  delayMs?: number | null
  rateBps?: number | null
  gxbDb?: number | null
  ber?: number | null
  marginDb?: number | null
  distanceM?: number | null
}): string {
  return [
    ['链路名称', name],
    ['传输方向', metrics.direction === 'FORWARD' ? '前向' : metrics.direction === 'REVERSE' ? '反向' : undefined],
    ['链路段抗干扰余量', metrics.segmentMargin],
    ['链路段时延', metrics.segmentDelay],
    ['链路延迟', formatHoverNumber(metrics.delayMs, ' ms')],
    ['链路速率', formatHoverNumber(metrics.rateBps, ' bit/s')],
    ['干信比', formatHoverNumber(metrics.gxbDb, ' dB')],
    ['误码率', formatHoverNumber(metrics.ber)],
    ['干扰余量', formatHoverNumber(metrics.marginDb, ' dB')],
    ['全程距离', formatLinkDistance(metrics.distanceM)],
    ['链路走向', route],
  ].map(([label, value]) => `${label}：${value ?? HOVER_NO_DATA}`).join('\n')
}

function segmentHoverMetric(
  segments: EngineLinkHover['segments'] | undefined, names: readonly string[], key: 'marginDb' | 'delayMs', unit: string,
): string | undefined {
  const values = segments?.map(segment => formatHoverNumber(segment?.quality[key], unit))
  if (!values?.some(value => value !== undefined)) return undefined
  if (values.length === 1) return values[0]
  return '\n' + values.map((value, index) => `${names[index]} → ${names[index + 1]}  ${value ?? HOVER_NO_DATA}`).join('\n')
}

/** 运行链路保留规范/三态投影语义，仅局部刷新几何和样式。 */
function renderLinks(group: L.LayerGroup, frame: TelemetryFrame, links: SituationLinkView[], selectedLinkId: string, onSelectLink: (link: SituationLinkView) => void): void {
  renderConnections(group, links.flatMap(link => {
    const points = sampleLinkCurve(frame, link, links)
    if (!points.length) return []
    const selected = link.linkId === selectedLinkId
    const typeName = LINK_TYPE_LABELS[link.type]
    return [{
      id: `runtime:${link.linkId}`, points,
      tooltipText: linkHoverText(`${link.linkId} · ${typeName}`, `${link.sourceName} → ${link.destinationName}`, {
        direction: link.direction,
        delayMs: link.detailed?.latencyMs, rateBps: link.detailed && link.detailed.dataRate * 1e6,
        gxbDb: link.detailed?.jsrDb, ber: link.ber, distanceM: link.detailed?.distance,
      }),
      name: `${typeName}，${link.sourceName}至${link.destinationName}，${LINK_STATUS_LABELS[link.status]}`,
      style: { ...linkStyle(link), className: '', ...(selected ? { weight: 6, opacity: 1, className: 'situation-map-link--selected' } : {}) },
      hitClass: 'situation-map-link-keyboard-hit', select: () => onSelectLink(link),
    }]
  }))
}

function expandConfiguredHopEdges(
  links: readonly Link[],
  platforms: ReadonlyMap<string, SituationMapNode>,
): Array<{ sourcePlatformId: string; targetPlatformId: string; type: string }> {
  return links.flatMap(link => {
    const relayId = link.relayPlatformId
    if (relayId && relayId !== link.sourcePlatformId && relayId !== link.targetPlatformId && platforms.has(relayId)) {
      return [
        { sourcePlatformId: link.sourcePlatformId, targetPlatformId: relayId, type: link.type },
        { sourcePlatformId: relayId, targetPlatformId: link.targetPlatformId, type: link.type },
      ]
    }
    return [{ sourcePlatformId: link.sourcePlatformId, targetPlatformId: link.targetPlatformId, type: link.type }]
  })
}

/**
 * 计算配置链路的地图折线：配置了中继平台（通信卫星或高空中继机）时绘制 源→中继→目标 两段路径，
 * 避免中继节点在配置态地图中呈孤立状态。
 */
function configuredConnectionPath(
  link: Link,
  nodes: readonly SituationMapNode[],
  allLinks: readonly Link[],
  platforms: ReadonlyMap<string, SituationMapNode>,
  hopEdges = expandConfiguredHopEdges(allLinks, platforms),
): { legs: { key: string; points: L.LatLngTuple[] }[]; nodeNames: string[] } | null {
  const source = platforms.get(link.sourcePlatformId)
  const target = platforms.get(link.targetPlatformId)
  if (!source || !target) return null
  const leg = (from: SituationMapNode, to: SituationMapNode) => ({
    key: JSON.stringify([link.type, ...[from.platformId, to.platformId].sort()]),
    points: sampleConnectionCurve(from, to, connectionCurveOffset(from, to, link.type, hopEdges), nodes),
  })
  const relay = link.relayPlatformId ? platforms.get(link.relayPlatformId) : undefined
  if (relay && relay.platformId !== source.platformId && relay.platformId !== target.platformId) {
    return {
      legs: [leg(source, relay), leg(relay, target)],
      nodeNames: [source.name, relay.name, target.name],
    }
  }
  return {
    legs: [leg(source, target)],
    nodeNames: [source.name, target.name],
  }
}

/**
 * 配置连线沿用体制样式。劣化覆盖为浅红，中断覆盖为深红。
 * 配置启停不代表运行质量，缺少判定时停用仅降低透明度。
 */
function renderConfiguredLinks(group: L.LayerGroup, nodes: SituationMapNode[], links: SituationMapLink[], selectedId: string, onSelect: (link: Link) => void,
  statuses?: ReadonlyMap<string, UiLinkStatus>, switches?: ReadonlyMap<string, ConfiguredLinkSwitchState>): void {
  const platforms = new Map(nodes.map(node => [node.platformId, node]))
  const hopEdges = expandConfiguredHopEdges(links, platforms)
  const owners = new Map<string, { linkId: string; priority: number; shared: boolean }>()
  const paths = links.flatMap(link => {
    const path = configuredConnectionPath(link, nodes, links, platforms, hopEdges)
    if (!path) return []
    const status = statuses?.get(link.id)
    const switching = switches?.get(link.id)
    // 共用段优先显示选中和切换高亮，其次显示启用链路及正常样式。
    const hasAbnormalStatus = status !== undefined && status !== 'UP'
    let priority = link.enabled === false ? 0 : hasAbnormalStatus ? 1 : 2
    if (switching) priority = 3
    if (selectedId === link.id) priority = 4
    for (const { key } of path.legs) {
      const owner = owners.get(key)
      if (!owner || priority > owner.priority) owners.set(key, { linkId: link.id, priority, shared: !!owner })
      else owner.shared = true
    }
    return [{ link, path, status, switching }]
  })
  renderConnections(group, paths.flatMap(({ link, path, status, switching }) => {
    const legs = path.legs.filter(leg => owners.get(leg.key)?.linkId === link.id)
    const lastLeg = legs.at(-1)
    if (!lastLeg) return []
    const points = legs.flatMap((leg, index) => index === 0 ? leg.points : leg.points.slice(1))
    const shared = legs.some(leg => owners.get(leg.key)?.shared)
    const style = status === 'DOWN' ? DOWN_LINK_STYLE : status && status !== 'UP' ? UNAVAILABLE_LINK_STYLE : LINK_TYPE_STYLES[link.type]
    const selected = selectedId === link.id
    const linkName = `${link.id} · ${LINK_TYPE_LABELS[link.type]}`
    const routeLabel = path.nodeNames.join(' → ')
    const fullPath = link.hover?.path
    return [{
      id: `configured:${link.id}`, points, hitPoint: lastLeg.points[Math.floor(lastLeg.points.length / 2)]!,
      tooltipText: linkHoverText(linkName, fullPath?.platformIds.map(id => platforms.get(id)?.name ?? id).join(' → ') ?? routeLabel, {
        ...fullPath?.quality,
        direction: link.direction,
        segmentMargin: segmentHoverMetric(link.hover?.segments, path.nodeNames, 'marginDb', ' dB'),
        segmentDelay: segmentHoverMetric(link.hover?.segments, path.nodeNames, 'delayMs', ' ms'),
        distanceM: fullPath ? fullPath.distanceM : link.distanceM,
      }),
      name: `${shared ? '共用连线 · ' : ''}${linkName} · ${routeLabel}；配置${link.enabled === false ? '停用' : '启用'}；${status ? `质量判定：${LINK_STATUS_LABELS[status]}` : '暂无运行数据'}${switching ? `；最近一次切换${switching === 'BEFORE' ? '前' : switching === 'AFTER' ? '后' : '前后'}路径已唯一关联` : ''}`,
      // 仅叠加高亮，不覆盖异常红色或四类体制线型；区分切出旧链与切入新链。
      style: {
        ...style,
        ...(switching === 'BEFORE' ? { dashArray: '6 6' } : {}),
        weight: selected ? 5 : switching === 'AFTER' ? 5 : switching === 'BOTH' ? 4 : 3,
        opacity: link.enabled === false ? 0.35 : switching === 'BEFORE' ? 0.55 : switching === 'AFTER' ? 1 : 0.85,
        className: `situation-map-configured-link${switching ? ` situation-map-link--switch-${switching.toLowerCase()}` : ''}`,
      },
      badge: switching === 'AFTER' ? { text: '已切换', variant: 'switch-after' }
        : switching === 'BEFORE' ? { text: '已切出', variant: 'switch-before' }
          : switching === 'BOTH' ? { text: '重路由', variant: 'switch-after' }
            : status === 'DOWN' ? { text: '✕ 中断', variant: 'down' }
              : status === 'DEGRADED' ? { text: '⚡ 受扰', variant: 'degraded' }
                : undefined,
      hitClass: 'situation-map-configured-link-hit', select: () => onSelect(link),
    }]
  }))
}

/**
 * 渲染由消息证据推导的业务链路：连线表达已发生的投递，箭头表达方向，样式按制式着色。
 * 不因设备启停隐藏连线，因为历史投递不因后续设备关闭而失效。
 * @param flowGroup 流向动画的独立图层组；组不在地图上时动画 DOM 也不存在，等于零开销关闭。
 */
function renderMessageLinks(group: L.LayerGroup, nodes: SituationMapNode[], links: FileMessageLink[], selectedId: string,
  onSelect: (link: FileMessageLink) => void, flowGroup?: L.LayerGroup,
  pulses?: ReadonlyMap<string, FileMessagePulse>, playback?: FileLinkPlayback): void {
  const platforms = new Map(nodes.map(node => [node.platformId, node]))
  const drawings: ConnectionDrawing[] = []
  const flowSpecs: FlowSpec[] = []
  const flowLaneInputs: FlowLaneCurveInput[] = []
  const linkMeta: Array<{
    link: FileMessageLink
    source: SituationMapNode
    target: SituationMapNode
    points: L.LatLngTuple[]
    buckets: Array<FileMessageDirection | 'UNKNOWN'>
  }> = []

  for (const link of links) {
    const source = platforms.get(link.sourcePlatformId)
    const target = platforms.get(link.targetPlatformId)
    if (!source || !target) continue
    const points = sampleConnectionCurve(source, target, messageLinkCurveOffset(link, links), nodes)
    const directionLabel = link.direction ? FILE_MESSAGE_DIRECTION_LABELS[link.direction] : ''
    drawings.push({
      id: `message:${link.id}`,
      points,
      name: `${directionLabel ? `${directionLabel} · ` : ''}${FILE_COMMUNICATION_LABELS[link.type]}业务：${source.name} → ${target.name}；${link.messageCount} 条投递；${link.firstTimeS}–${link.lastTimeS} 秒`,
      style: {
        ...FILE_LINK_TYPE_STYLES[link.type],
        ...(link.id === selectedId ? { weight: 6, opacity: 1, className: 'situation-map-link--selected' } : {}),
      },
      hitClass: 'situation-map-message-link-hit',
      select: () => onSelect(link),
      arrow: curveArrow(points),
    })

    const bucketSet = new Set<FileMessageDirection | 'UNKNOWN'>()
    for (const record of link.records) bucketSet.add(readSingleMessageDirection(record.messageType) ?? 'UNKNOWN')
    const buckets = bucketSet.size > 0 ? [...bucketSet].sort() : ['UNKNOWN' as const]
    linkMeta.push({ link, source, target, points, buckets })
    for (const dirKey of buckets) {
      flowLaneInputs.push({
        sourcePlatformId: link.sourcePlatformId,
        targetPlatformId: link.targetPlatformId,
        type: link.type,
        directionKey: dirKey,
      })
    }
  }

  for (const meta of linkMeta) {
    const { link, source, target, points, buckets } = meta
    if (buckets.length <= 1) {
      const pulse = pulses?.get(link.id)
      flowSpecs.push({
        id: `message:${link.id}`,
        points,
        flow: { ...LINK_FLOW_STYLE, color: arrowColor(FILE_LINK_TYPE_STYLES[link.type]) },
        pulseId: pulse?.eventId,
        playback,
      })
      continue
    }
    for (const dirKey of buckets) {
      const pulseKey = `${link.id}|${dirKey}`
      const pulse = pulses?.get(pulseKey)
      const lanePoints = sampleConnectionCurve(
        source,
        target,
        flowLaneCurveOffset(
          { sourcePlatformId: link.sourcePlatformId, targetPlatformId: link.targetPlatformId, type: link.type, directionKey: dirKey },
          flowLaneInputs,
        ),
        nodes,
      )
      flowSpecs.push({
        id: `message:${pulseKey}`,
        points: lanePoints,
        flow: { ...LINK_FLOW_STYLE, color: arrowColor(FILE_LINK_TYPE_STYLES[link.type]) },
        pulseId: pulse?.eventId,
        playback,
      })
    }
  }

  renderConnections(group, drawings)
  renderFlowSpecs(flowGroup, flowSpecs)
}

/** 仅从本次仿真已配对的跳段生成动画路径，同一对节点的曲线一起计算。 */
function collectLiveFlowPaths(
  nodes: SituationMapNode[],
  lanes: readonly LiveMessageFlowLane[],
  cache: Map<string, { geometry: string; points: L.LatLngTuple[] }>,
): LiveFlowPath[] {
  if (lanes.length === 0) { cache.clear(); return [] }
  const platforms = new Map(nodes.map(node => [node.platformId, node]))
  const byPair = new Map<string, Array<FlowLaneCurveInput & { id: string; pulseId?: string }>>()
  for (const lane of lanes) {
    const { sourcePlatformId, targetPlatformId, id, pulseId, type } = lane
    if (!platforms.has(sourcePlatformId) || !platforms.has(targetPlatformId)) continue
    const pair = JSON.stringify([sourcePlatformId, targetPlatformId].sort())
    const entry = { sourcePlatformId, targetPlatformId, id, pulseId, type, directionKey: lane.direction ?? 'UNKNOWN' }
    const peers = byPair.get(pair)
    if (peers) peers.push(entry)
    else byPair.set(pair, [entry])
  }

  const used = new Set<string>()
  const paths: LiveFlowPath[] = []
  for (const peers of byPair.values()) {
    for (const lane of peers) {
      if (!lane.pulseId) continue
      const source = platforms.get(lane.sourcePlatformId)!
      const target = platforms.get(lane.targetPlatformId)!
      const offset = flowLaneCurveOffset(lane, peers)
      const geometry = JSON.stringify([pointForPlatform(source, nodes), pointForPlatform(target, nodes), offset])
      let cached = cache.get(lane.id)
      if (!cached || cached.geometry !== geometry) {
        cached = { geometry, points: sampleConnectionCurve(source, target, offset, nodes) }
        cache.set(lane.id, cached)
      }
      used.add(lane.id)
      paths.push({ id: lane.id, pulseId: lane.pulseId, points: cached.points })
    }
  }
  for (const id of cache.keys()) if (!used.has(id)) cache.delete(id)
  return paths
}

/** 文件连线只表达登记关联；端点始终取本轮最新节点坐标，明细保留原始方向。 */
function renderFileLinks(group: L.LayerGroup, nodes: SituationMapNode[], links: FileCommunicationLink[], onSelect: (link: FileCommunicationLink) => void): void {  const platforms = new Map(nodes.map(node => [node.platformId, node]))
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
      id: `file:${link.id}`, points: sampleConnectionCurve(source, target, connectionCurveOffset(source, target, link.type, drawableLinks), nodes),
      name: `${FILE_COMMUNICATION_LABELS[link.type]}登记关联：${source.name} — ${target.name}；${link.records.length} 条登记；状态未知，不表示当前正在转发`,
      // 登记关联用半透明细线区分业务投递，保留各体制自己的线型。
      style: {
        ...FILE_LINK_TYPE_STYLES[link.type],
        weight: 2,
        opacity: 0.5,
        className: 'situation-map-file-link',
      },
      hitClass: 'situation-map-file-link-hit', select: () => onSelect(link),
    }]
  }))
}

const interferenceLayers = new WeakMap<L.LayerGroup, Map<string, { circle: L.Circle; selected: boolean; active: boolean; sourceLabel: string }>>()
const jammingPulseLayers = new WeakMap<L.LayerGroup, Map<string, L.Marker>>()
const jammingBeamLayers = new WeakMap<L.LayerGroup, Map<string, { line: L.Polyline; geometry: string; label: string }>>()

const detectionLayers = new WeakMap<L.LayerGroup, Map<string, L.Circle>>()

/** 固定半径或场景/引擎探测范围圈随节点移动；保持非交互，避免遮挡内部链路和干扰圈。 */
function renderDetection(group: L.LayerGroup, frame: TelemetryFrame | null, nodes: SituationMapNode[],
  jammers?: ConfiguredJammerRange[], engineFrame?: EngineFrameSnapshot | null, configuredLinks?: readonly SituationMapLink[]): void {
  const entries = detectionLayers.get(group) ?? new Map<string, L.Circle>()
  detectionLayers.set(group, entries)
  const ranges = selectDetectionRanges(nodes, frame, jammers, engineFrame, configuredLinks)
  const ids = new Set(ranges.map(range => range.id))
  for (const [id, circle] of entries) {
    if (!ids.has(id)) { group.removeLayer(circle); entries.delete(id) }
  }
  for (const range of ranges) {
    const platform = nodes.find(node => node.platformId === range.platformId)!
    const position = pointForPlatform(platform, nodes)
    const circle = entries.get(range.id)
    if (circle) {
      if (!circle.getLatLng().equals(position)) circle.setLatLng(position)
      if (circle.getRadius() !== range.radiusMeters) circle.setRadius(range.radiusMeters)
    } else {
      entries.set(range.id, L.circle(position, {
        radius: range.radiusMeters, color: '#f5c542', weight: 1.5, opacity: 0.9,
        dashArray: '8 6', fill: true, fillColor: '#f5c542', fillOpacity: 0.08,
        interactive: false, className: 'situation-map-detection',
      }).addTo(group))
    }
  }
}

/** 逐设备复用配置范围圈，并按真实引擎压制状态高亮正在压制的干扰圈。 */
function renderInterference(group: L.LayerGroup, frame: TelemetryFrame | null, selectedJammerId: string,
  nodes: SituationMapNode[], jammers?: ConfiguredJammerRange[], fileDeviceStates: FileDeviceEvent[] = [], engineFrame?: EngineFrameSnapshot | null): void {
  const entries = interferenceLayers.get(group) ?? new Map<string, { circle: L.Circle; selected: boolean; active: boolean; sourceLabel: string }>()
  interferenceLayers.set(group, entries)

  const { activeJammerPlatformIds } = extractActiveJammingOverlay(engineFrame, nodes)
  const ranges = selectInterferenceRanges(nodes, frame, jammers, fileDeviceStates, engineFrame)
  const ids = new Set(ranges.map(range => range.id))
  for (const [id, entry] of entries) {
    if (!ids.has(id)) { group.removeLayer(entry.circle); entries.delete(id) }
  }
  for (const range of ranges) {
    const platform = nodes.find(node => node.platformId === range.platformId)!
    const position = pointForPlatform(platform, nodes)
    const selected = range.jammerId ? range.jammerId === selectedJammerId
      : frame?.platforms.find(node => node.platformId === platform.platformId)?.jammers
        .some(jammer => jammer.active && jammer.jammerId === selectedJammerId) ?? false
    const active = activeJammerPlatformIds.has(range.platformId)
    const radius = range.radiusMeters
    const sourceLabel = interferenceRangeSource(range)
    let entry = entries.get(range.id)
    if (entry && !entry.circle.getLatLng().equals(position)) entry.circle.setLatLng(position)
    if (entry?.selected === selected && entry.active === active && entry.circle.getRadius() === radius && entry.sourceLabel === sourceLabel) continue
    const color = selected ? '#f5b942' : active ? '#ff3b5c' : '#ff526d'
    const className = [
      selected ? 'situation-map-interference--selected' : '',
      active ? 'situation-map-interference--active' : '',
    ].filter(Boolean).join(' ')
    const style: L.CircleMarkerOptions = {
      color, weight: selected ? 4 : active ? 2.5 : 1.5, opacity: selected || active ? 1 : 0.9, dashArray: '8 6',
      fill: true, fillColor: color, fillOpacity: selected ? 0.2 : active ? 0.16 : 0.09,
      className, interactive: true,
    }
    if (!entry) {
      const circle = L.circle(position, { ...style, radius }).addTo(group)
      entry = { circle, selected, active, sourceLabel }
      entries.set(range.id, entry)
    } else {
      entry.circle.setRadius(radius)
      entry.circle.setStyle(style)
      const element = entry.circle.getElement()
      element?.classList.toggle('situation-map-interference--selected', selected)
      element?.classList.toggle('situation-map-interference--active', active)
      entry.selected = selected
      entry.active = active
      entry.sourceLabel = sourceLabel
    }
    const label = document.createElement('span')
    label.textContent = `${range.jammerId ?? platform.name}：半径 ${radius / 1000} 公里（${active ? '正在压制 · ' : ''}${sourceLabel}）`
    entry.circle.unbindTooltip().bindTooltip(label, { sticky: true })
  }
}

/** 在独立效果层绘制活跃压制脉冲环、微标与干扰射线，随干扰图层联动显隐且不混入范围圈集合。 */
function renderJammingEffects(group: L.LayerGroup, nodes: SituationMapNode[], engineFrame?: EngineFrameSnapshot | null): void {
  const pulses = jammingPulseLayers.get(group) ?? new Map<string, L.Marker>()
  jammingPulseLayers.set(group, pulses)
  const beams = jammingBeamLayers.get(group) ?? new Map<string, { line: L.Polyline; geometry: string; label: string }>()
  jammingBeamLayers.set(group, beams)

  const { activeJammerPlatformIds, beams: activeBeams } = extractActiveJammingOverlay(engineFrame, nodes)

  // 活跃干扰源脉冲环与「压制中」微标
  for (const [platformId, marker] of pulses) {
    if (!activeJammerPlatformIds.has(platformId) || !nodes.some(node => node.platformId === platformId)) {
      group.removeLayer(marker)
      pulses.delete(platformId)
    }
  }
  for (const platformId of activeJammerPlatformIds) {
    const platform = nodes.find(node => node.platformId === platformId)
    if (!platform) continue
    const position = pointForPlatform(platform, nodes)
    const existing = pulses.get(platformId)
    if (existing) {
      if (!existing.getLatLng().equals(position)) existing.setLatLng(position)
      continue
    }
    const html = '<span class="situation-map-jammer-pulse__ring situation-map-jammer-pulse__ring--a"></span>'
      + '<span class="situation-map-jammer-pulse__ring situation-map-jammer-pulse__ring--b"></span>'
      + '<span class="situation-map-jammer-pulse__tag">压制中</span>'
    const marker = L.marker(position, {
      icon: L.divIcon({ html, className: 'situation-map-jammer-pulse', iconSize: [0, 0], iconAnchor: [0, 0] }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 740,
    }).addTo(group)
    pulses.set(platformId, marker)
  }

  // 干扰源 → 受扰目标的动态红色压制射线
  const activeBeamIds = new Set(activeBeams.map(beam => beam.id))
  for (const [beamId, beamEntry] of beams) {
    if (!activeBeamIds.has(beamId)) {
      group.removeLayer(beamEntry.line)
      beams.delete(beamId)
    }
  }
  for (const beam of activeBeams) {
    const jammerNode = nodes.find(node => node.platformId === beam.jammerPlatformId)
    const targetNode = nodes.find(node => node.platformId === beam.targetPlatformId)
    if (!jammerNode || !targetNode) continue
    const points: L.LatLngTuple[] = [pointForPlatform(jammerNode, nodes), pointForPlatform(targetNode, nodes)]
    const geometry = JSON.stringify(points)
    const labelText = [
      `${beam.jammerName} → ${beam.targetName} 电磁压制`,
      beam.mode ?? '',
      beam.lossDb !== null ? `干扰损耗 ${beam.lossDb.toFixed(1)} dB` : '',
    ].filter(Boolean).join(' · ')
    const existing = beams.get(beam.id)
    if (existing) {
      if (existing.geometry !== geometry) {
        existing.line.setLatLngs(points)
        existing.geometry = geometry
      }
      if (existing.label !== labelText) {
        const span = document.createElement('span')
        span.textContent = labelText
        existing.line.unbindTooltip().bindTooltip(span, { sticky: true })
        existing.label = labelText
      }
      continue
    }
    const span = document.createElement('span')
    span.textContent = labelText
    const line = L.polyline(points, {
      color: '#ff3b5c',
      weight: 2.5,
      opacity: 0.9,
      dashArray: '8 8',
      className: 'situation-map-jamming-beam',
      bubblingMouseEvents: false,
      interactive: true,
    }).bindTooltip(span, { sticky: true }).addTo(group)
    beams.set(beam.id, { line, geometry, label: labelText })
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

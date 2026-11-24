<script setup lang="ts">
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { computed, onBeforeUnmount, ref, shallowReactive, watch } from 'vue'
import { MAP_CONFIG, nodeGlyph, nodeIconUrl } from '../../config/map.config'
import type { Platform, TemplateRoutePoint } from '../../contracts/domain-models'
import { PLATFORM_POINT_DEFAULT_SPEED, type PLATFORM_POSITION_RULES } from '../../features/scenarios/platform-position-rules'
import { scenarioPlatformLabel } from '../../features/scenarios/scenario-basic'
import { createOfflineVectorBasemap } from '../situation/offline-vector-basemap'

export interface WaypointMapPoint {
  longitude: number
  latitude: number
}

export type WaypointMapNode = Pick<Platform, 'id' | 'name' | 'type' | 'satelliteType' | 'initialPosition'>

export interface WaypointMapRoute {
  points: readonly WaypointMapPoint[]
  origin: WaypointMapPoint
  loiter: boolean
  altitude: number
}

/** 单点编辑时的路线上下文：只用于展示已有航点及连线，不参与增删。 */
export interface WaypointMapContext {
  points: readonly WaypointMapPoint[]
  origin?: WaypointMapPoint
  loiter?: boolean
  /** 当前正在编辑的点在 points 中的下标，该点由“当前选点”标记表示。 */
  activeIndex?: number
}

const props = withDefaults(defineProps<{
  modelValue: boolean
  longitude: number
  latitude: number
  route?: WaypointMapRoute
  /** 单点编辑时展示的已有航点与连线（不含新点）。 */
  routeContext?: WaypointMapContext
  bounds?: NonNullable<(typeof PLATFORM_POSITION_RULES)['AIRBORNE_MISSION_CLUSTER']>
  existingNodes?: readonly WaypointMapNode[]
  fitExistingNodes?: boolean
  /** 弹窗标题，默认按航点选点。 */
  title?: string
  /** 弹窗顶部说明，默认按航点选点。 */
  hint?: string
  /** 未选点时的空态文案。 */
  emptyText?: string
  /** 是否在选中信息中展示“高度 0 m”；初始位置等需保留高度的场景可关闭。 */
  showAltitude?: boolean
  /** 初始位置的 (0, 0) 是有效坐标，新航点的 (0, 0) 是占位值。 */
  allowZeroPoint?: boolean
}>(), {
  title: '地图选取航点',
  hint: '单击地图选择经纬度；二维地图无法确定高度，确认后高度设置为 0 米。',
  emptyText: '尚未选择航点',
  showAltitude: true,
})

const emit = defineEmits<{
  'update:modelValue': [visible: boolean]
  confirm: [point: WaypointMapPoint]
  'confirm-route': [points: TemplateRoutePoint[], moved: ReadonlyMap<number, WaypointMapPoint>]
}>()

const mapContainer = ref<HTMLElement | null>(null)
const selectedPoint = ref<WaypointMapPoint | null>(null)
const newPoints = ref<WaypointMapPoint[]>([])
const movedPoints = shallowReactive(new Map<number, WaypointMapPoint>())
const selectionError = ref('')
const rangeHint = computed(() => props.bounds
  ? `选点范围：经度 ${props.bounds.minLongitude}°E～${props.bounds.maxLongitude}°E，纬度 ${props.bounds.minLatitude}°N～${props.bounds.maxLatitude}°N。`
  : '')
const missingLoiterPoints = computed(() => props.route?.loiter
  ? Math.max(0, 2 - props.route.points.length - newPoints.value.length)
  : 0)
const canConfirmRoute = computed(() => missingLoiterPoints.value === 0 && (newPoints.value.length > 0 || movedPoints.size > 0))
const SELECTED_POINT_PANE = 'waypoint-selection'
let map: L.Map | null = null
let marker: L.CircleMarker | null = null
let routeLayer: L.LayerGroup | null = null
const routeMarkers = new Map<number, L.Marker>()

function isGeographicPoint(longitude: number, latitude: number): boolean {
  return Number.isFinite(longitude) && Number.isFinite(latitude)
    && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90
}

function isAllowedPoint(longitude: number, latitude: number): boolean {
  const bounds = props.bounds
  return isGeographicPoint(longitude, latitude) && (!bounds || (
    longitude >= bounds.minLongitude && longitude <= bounds.maxLongitude
    && latitude >= bounds.minLatitude && latitude <= bounds.maxLatitude
  ))
}

/**
 * 判断现有经纬度是否适合作为地图初始选点。
 * @param longitude 经度，单位为度。
 * @param latitude 纬度，单位为度。
 * @returns 坐标合法且零值不是占位符时返回 `true`。
 */
function hasInitialPoint(longitude: number, latitude: number): boolean {
  return isAllowedPoint(longitude, latitude)
    && (props.allowZeroPoint || longitude !== 0 || latitude !== 0)
}

/** 选点和拖拽使用同一坐标精度。 */
function waypointPoint({ lng, lat }: L.LatLng): WaypointMapPoint {
  return { longitude: Number(lng.toFixed(6)), latitude: Number(lat.toFixed(6)) }
}

function coordinates(point: WaypointMapPoint): L.LatLngTuple {
  return [point.latitude, point.longitude]
}

function moveRoutePoint(index: number, routeMarker: L.Marker): void {
  const route = props.route
  if (!route) return
  const existing = route.points[index]
  const newIndex = index - route.points.length
  const previous = existing ? movedPoints.get(index) ?? existing : newPoints.value[newIndex]
  if (!previous) return
  const latLng = routeMarker.getLatLng()
  if (!isAllowedPoint(latLng.lng, latLng.lat)) {
    routeMarker.setLatLng(coordinates(previous))
    selectionError.value = `拖动位置超出允许范围，已回到原位。${rangeHint.value}`
    return
  }
  const point = waypointPoint(latLng)
  if (!existing) {
    newPoints.value[newIndex] = point
  } else if (point.longitude === existing.longitude && point.latitude === existing.latitude) {
    movedPoints.delete(index)
  } else {
    movedPoints.set(index, point)
  }
  selectionError.value = ''
  renderRoute()
}

function renderRoute(): void {
  const route = props.route
  if (!route || !routeLayer || !map) return
  const layer = routeLayer
  layer.clearLayers()
  const saved = route.points.map((original, index) => {
    const point = movedPoints.get(index) ?? original
    return isAllowedPoint(point.longitude, point.latitude) ? coordinates(point) : null
  })
  const added = newPoints.value.map(coordinates)
  const origin = isAllowedPoint(route.origin.longitude, route.origin.latitude) ? [coordinates(route.origin)] : []
  const existingLine = [...origin, ...saved.filter(point => point !== null)]
  const tail = existingLine.at(-1)
  const newLine = tail ? [tail, ...added] : added
  const first = saved.length ? saved[0] : added[0]
  const last = added.at(-1) ?? saved.at(-1)
  if (existingLine.length > 1) L.polyline(existingLine, { color: '#97a9b6', weight: 2, interactive: false }).addTo(layer)
  if (newLine.length > 1) L.polyline(newLine, { color: '#42dbf8', weight: 2, interactive: false }).addTo(layer)
  if (route.loiter && saved.length + added.length >= 2 && first && last) {
    // 两个盘旋点时往返线重合，用更浅的虚线区分回程。
    L.polyline([last, first], { color: '#d8f6ff', weight: 2, dashArray: '5 6', interactive: false }).addTo(layer)
  }
  origin.forEach(point => L.circleMarker(point, { radius: 4, color: '#97a9b6', weight: 2, interactive: false }).addTo(layer))
  const positions = [...saved, ...added]
  // 拖动结束后保留原标记，避免松手事件落到地图底层而追加一点。
  for (const [index, routeMarker] of routeMarkers) {
    if (positions[index]) continue
    routeMarker.remove()
    routeMarkers.delete(index)
  }
  const numberClass = 'waypoint-map-dialog__number'
  for (const [index, point] of positions.entries()) {
    if (!point) continue
    const current = routeMarkers.get(index)
    if (current) {
      current.setLatLng(point)
      continue
    }
    const icon = L.divIcon({
      className: index < saved.length ? numberClass : `${numberClass} ${numberClass}--added`,
      html: String(index + 1),
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    })
    const routeMarker = L.marker(point, { icon, draggable: true, keyboard: false, title: `拖动第 ${index + 1} 个航点` })
    routeMarker
      .on('click', L.DomEvent.stopPropagation)
      .on('dragend', () => moveRoutePoint(index, routeMarker))
      .addTo(map)
    routeMarkers.set(index, routeMarker)
  }
}

/** 单点编辑时绘制已有航点及连线，帮助判断当前点在整条路线中的位置。 */
function renderContext(): void {
  const context = props.routeContext
  if (!context || !routeLayer) return
  const layer = routeLayer
  layer.clearLayers()
  // 当前编辑点用最新选点位置替换，连线随之更新。
  const displayPoints = context.points.map((point, index) => index === context.activeIndex && selectedPoint.value ? selectedPoint.value : point)
  const points = displayPoints.map(point => isAllowedPoint(point.longitude, point.latitude) ? coordinates(point) : null)
  const origin = context.origin && isAllowedPoint(context.origin.longitude, context.origin.latitude) ? [coordinates(context.origin)] : []
  const line: L.LatLngTuple[] = [...origin, ...points.filter((point): point is L.LatLngTuple => point !== null)]
  if (line.length > 1) L.polyline(line, { color: '#97a9b6', weight: 2, interactive: false }).addTo(layer)
  if (context.loiter && line.length >= 2) {
    const loopStart = origin.length ? line[1] : line[0]
    if (loopStart) L.polyline([line.at(-1)!, loopStart], { color: '#d8f6ff', weight: 2, dashArray: '5 6', interactive: false }).addTo(layer)
  }
  origin.forEach(point => L.circleMarker(point, { radius: 4, color: '#97a9b6', weight: 2, interactive: false }).addTo(layer))
  const numberClass = 'waypoint-map-dialog__number'
  points.forEach((point, index) => {
    // 当前编辑点由“当前选点”标记展示，这里跳过以免重复。
    if (!point || index === context.activeIndex) return
    const icon = L.divIcon({ className: numberClass, html: String(index + 1), iconSize: [22, 22], iconAnchor: [11, 11] })
    L.marker(point, { icon, interactive: false, keyboard: false }).addTo(layer)
  })
}

function undoRoutePoint(): void {
  newPoints.value.pop()
  selectionError.value = ''
  renderRoute()
}

function clearRoutePoints(): void {
  newPoints.value = []
  selectionError.value = ''
  renderRoute()
}

/**
 * 在地图上绘制或移动当前航点标记。
 * @param point 要展示的经纬度。
 * @returns 无返回值。
 * @sideEffects 新建或移动 Leaflet 圆形标记。
 */
function renderMarker(point: WaypointMapPoint): void {
  if (map === null) return
  const position: L.LatLngExpression = [point.latitude, point.longitude]
  if (marker === null) {
    marker = L.circleMarker(position, {
      pane: SELECTED_POINT_PANE,
      className: 'waypoint-map-dialog__selected-marker',
      radius: 5,
      color: '#071522',
      fillColor: '#f5b942',
      fillOpacity: 1,
      weight: 2,
      interactive: false,
    }).bindTooltip('当前选点', {
      permanent: true,
      offset: [10, 0],
      opacity: 1,
      className: 'waypoint-map-dialog__selected-label',
    }).addTo(map)
    return
  }
  marker.setLatLng(position)
}

/** 记录待确认坐标并刷新地图标记。 */
function selectPoint(latLng: L.LatLng): void {
  // 先检查原始坐标，避免六位小数舍入将范围外的点误判为边界内。
  if (!isAllowedPoint(latLng.lng, latLng.lat)) {
    selectionError.value = `选点超出允许范围，请重新选择。${rangeHint.value}`
    if (!props.route) {
      selectedPoint.value = null
      marker?.remove()
      marker = null
    }
    return
  }
  selectionError.value = ''
  const point = waypointPoint(latLng)
  if (props.route) {
    newPoints.value.push(point)
    renderRoute()
  } else {
    selectedPoint.value = point
    renderMarker(point)
    if (props.routeContext) renderContext()
  }
}

function handleMapClick(event: L.LeafletMouseEvent): void {
  selectPoint(event.latlng)
}

function selectMapCenter(): void {
  if (props.route && map) selectPoint(map.getCenter())
}

function renderExistingNodes(target: L.Map): void {
  const nodes = props.existingNodes ?? []
  for (const node of nodes) {
    const position = node.initialPosition
    if (!isGeographicPoint(position.longitude, position.latitude)) continue
    const content = document.createElement('span')
    const imageUrl = nodeIconUrl(node)
    if (imageUrl) {
      const image = document.createElement('img')
      image.src = imageUrl
      image.alt = ''
      image.draggable = false
      image.addEventListener('error', () => { content.textContent = nodeGlyph(node) }, { once: true })
      content.append(image)
    } else content.textContent = nodeGlyph(node)

    const label = document.createElement('span')
    label.textContent = scenarioPlatformLabel(nodes, node.id)
    // 中继和作业集群在态势页使用同一张无人机素材，名称旁补充类型以区分。
    if (node.type === 'FORWARD_RELAY_NODE') label.append(' · 中继')
    if (node.type === 'AIRBORNE_MISSION_CLUSTER') label.append(' · 无人作业')
    L.marker(coordinates(position), {
      icon: L.divIcon({ html: content, className: 'waypoint-map-dialog__node-marker', iconSize: [34, 34], iconAnchor: [17, 17] }),
      interactive: false,
      keyboard: false,
    }).bindTooltip(label, {
      permanent: true, direction: 'top', offset: [0, -16], className: 'waypoint-map-dialog__node-label',
    }).addTo(target)
  }
}

/**
 * 在弹窗完全展开后初始化离线地图。
 * @returns 无返回值。
 * @sideEffects 创建 Leaflet 地图、加载本机瓦片并注册点击事件。
 */
function initializeMap(): void {
  destroyMap()
  if (mapContainer.value === null) return
  map = L.map(mapContainer.value, {
    attributionControl: false,
    zoomControl: false,
    doubleClickZoom: !props.route,
    minZoom: MAP_CONFIG.zoom.min,
    maxZoom: MAP_CONFIG.zoom.max,
    zoomSnap: MAP_CONFIG.zoom.snap,
  })
  createOfflineVectorBasemap(MAP_CONFIG.defaults.theme).addTo(map)
  L.control.zoom({
    zoomInText: '＋',
    zoomInTitle: '放大地图',
    zoomOutText: '－',
    zoomOutTitle: '缩小地图',
  }).addTo(map)
  map.on('click', handleMapClick)

  const point = selectedPoint.value
  const route = props.route
  if (!route) {
    const selectionPane = map.createPane(SELECTED_POINT_PANE)
    // 放在节点图标之上、名称之下，点击重合位置仍由地图选点处理。
    selectionPane.style.zIndex = '625'
    selectionPane.style.pointerEvents = 'none'
  }
  const referencePoints = props.fitExistingNodes && !route
    ? (props.existingNodes ?? []).map(node => node.initialPosition).filter(point => isAllowedPoint(point.longitude, point.latitude))
    : []
  const contextPoints = props.routeContext
    ? [props.routeContext.origin, ...props.routeContext.points, point]
      .filter((item): item is WaypointMapPoint => item !== undefined && item !== null && isAllowedPoint(item.longitude, item.latitude))
    : []
  if (route) {
    const extent = [route.origin, ...route.points].filter(point => isAllowedPoint(point.longitude, point.latitude))
    const bounds = L.latLngBounds(extent.length ? extent.map(coordinates) : MAP_CONFIG.taskBounds.map(([lat, lng]): L.LatLngTuple => [lat, lng]))
    map.fitBounds(bounds, { padding: [...MAP_CONFIG.fitPadding], maxZoom: MAP_CONFIG.defaults.zoom, animate: false })
  } else if (contextPoints.length > 0) {
    map.fitBounds(L.latLngBounds(contextPoints.map(coordinates)), {
      padding: [...MAP_CONFIG.fitPadding], maxZoom: MAP_CONFIG.defaults.zoom, animate: false,
    })
  } else if (referencePoints.length > 0) {
    const extent = point === null ? referencePoints : [point, ...referencePoints]
    map.fitBounds(L.latLngBounds(extent.map(coordinates)), {
      // 已配置节点的名称显示在标记上方，留出额外空间避免贴边裁切。
      padding: [MAP_CONFIG.fitPadding[0] * 2, MAP_CONFIG.fitPadding[1] * 2], maxZoom: MAP_CONFIG.defaults.zoom, animate: false,
    })
  } else if (point !== null) {
    map.setView(coordinates(point), MAP_CONFIG.defaults.zoom, { animate: false })
  } else {
    const bounds = L.latLngBounds(
      MAP_CONFIG.taskBounds.map(([latitude, longitude]) => [latitude, longitude] as L.LatLngTuple),
    )
    map.fitBounds(bounds, { padding: [...MAP_CONFIG.fitPadding], animate: false })
  }
  renderExistingNodes(map)
  if (route) {
    routeLayer = L.layerGroup().addTo(map)
    renderRoute()
  } else if (props.routeContext) {
    routeLayer = L.layerGroup().addTo(map)
    renderContext()
    if (point !== null) renderMarker(point)
  } else if (point !== null) {
    renderMarker(point)
  }
  map.invalidateSize({ pan: false })
}

/**
 * 释放当前地图实例。
 * @returns 无返回值。
 * @sideEffects 注销点击事件并销毁 Leaflet 地图和标记。
 */
function destroyMap(): void {
  if (map !== null) {
    map.off('click', handleMapClick)
    map.remove()
  }
  map = null
  marker = null
  routeLayer = null
  routeMarkers.clear()
}

/**
 * 确认当前地图选点。
 * @returns 无返回值。
 * @sideEffects 向父组件提交经纬度并关闭弹窗。
 */
function confirmPoint(): void {
  if (selectedPoint.value === null || !isAllowedPoint(selectedPoint.value.longitude, selectedPoint.value.latitude)) return
  emit('confirm', selectedPoint.value)
  emit('update:modelValue', false)
}

function confirmRoute(): void {
  const route = props.route
  if (!route || !canConfirmRoute.value) return
  emit('confirm-route', newPoints.value.map(point => ({ ...point, altitude: route.altitude, speed: PLATFORM_POINT_DEFAULT_SPEED })), new Map(movedPoints))
  emit('update:modelValue', false)
}

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  selectionError.value = ''
  newPoints.value = []
  movedPoints.clear()
  selectedPoint.value = !props.route && hasInitialPoint(props.longitude, props.latitude)
    ? { longitude: props.longitude, latitude: props.latitude }
    : null
}, { immediate: true })

onBeforeUnmount(destroyMap)
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    class="waypoint-map-dialog scenario-dialog"
    :title="route ? (route.loiter ? '地图新增盘旋航点' : '地图新增航点') : title"
    width="min(1240px, calc(100vw - 2rem))"
    append-to-body
    destroy-on-close
    data-testid="waypoint-map-dialog"
    @update:model-value="emit('update:modelValue', $event)"
    @opened="initializeMap"
    @closed="destroyMap"
  >
    <p class="waypoint-map-dialog__hint">
      {{ route ? '单击地图添加新点，按住编号点可拖动。用键盘选点时，可用方向键移动地图并按回车添加中心点。' : hint }}
      <template v-if="routeContext && !route">灰色连线为已有航点，单击地图可重新选择当前点。</template>
      <template v-if="existingNodes?.length">类型图标表示已配置节点。</template>
    </p>
    <p v-if="rangeHint" class="waypoint-map-dialog__hint" data-testid="waypoint-range-hint">{{ rangeHint }}</p>
    <el-alert v-if="selectionError" :title="selectionError" type="error" :closable="false" show-icon data-testid="waypoint-range-error" />
    <div
      ref="mapContainer"
      class="waypoint-map-dialog__map"
      :class="{ 'waypoint-map-dialog__map--route': route }"
      role="application"
      aria-label="离线地图选点"
      data-testid="waypoint-map"
      @keydown.enter.self.prevent="selectMapCenter"
    />
    <template #footer>
      <div class="waypoint-map-dialog__actions">
        <div class="waypoint-map-dialog__selection" aria-live="polite" :data-testid="route ? 'waypoint-batch-status' : undefined">
          <template v-if="route">
            本次已选 {{ newPoints.length }} 个点
            <template v-if="movedPoints.size > 0"> · 已移动 {{ movedPoints.size }} 个已有点</template>
            <template v-if="missingLoiterPoints > 0"> · 还需 {{ missingLoiterPoints }} 个盘旋航点</template>
          </template>
          <template v-else-if="selectedPoint">
            当前选点 · 经度 {{ selectedPoint.longitude.toFixed(6) }}° · 纬度 {{ selectedPoint.latitude.toFixed(6) }}°<template v-if="showAltitude"> · 高度 0 m</template>
          </template>
          <template v-else>{{ emptyText }}</template>
        </div>
        <template v-if="route">
          <el-button :disabled="!newPoints.length" data-testid="undo-waypoint-batch" @click="undoRoutePoint">撤销上一点</el-button>
          <el-button :disabled="!newPoints.length" data-testid="clear-waypoint-batch" @click="clearRoutePoints">清除本次选点</el-button>
        </template>
        <el-button @click="emit('update:modelValue', false)">取消</el-button>
        <el-button v-if="route" type="primary" :disabled="!canConfirmRoute" data-testid="confirm-waypoint-batch" @click="confirmRoute">
          {{ movedPoints.size > 0 ? '确认修改' : '确认添加' }}
        </el-button>
        <el-button v-else type="primary" :disabled="selectedPoint === null" data-testid="confirm-waypoint-point" @click="confirmPoint">
          确认选点
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.waypoint-map-dialog__hint {
  margin: 0 0 0.75rem;
  color: var(--console-text-muted);
  font-size: 0.75rem;
}

.waypoint-map-dialog__map {
  width: 100%;
  height: min(68vh, 720px);
  height: min(68dvh, 720px);
  overflow: hidden;
  border: 1px solid var(--console-border-strong);
  border-radius: 6px;
  cursor: crosshair;
  background: #071522;
}

.waypoint-map-dialog__map :deep(.waypoint-map-dialog__node-marker) {
  display: grid;
  place-items: center;
  color: var(--console-cyan);
  font-size: 20px;
  filter: drop-shadow(0 1px 2px #06111d);
}

.waypoint-map-dialog__map :deep(.waypoint-map-dialog__node-marker img) {
  display: block;
  width: 34px;
  height: 34px;
  object-fit: contain;
}

.waypoint-map-dialog__map :deep(.leaflet-tooltip.waypoint-map-dialog__node-label) {
  border-color: var(--console-border-strong);
  background: var(--console-surface);
  color: var(--console-text);
  pointer-events: none;
}

.waypoint-map-dialog__map :deep(.waypoint-map-dialog__node-label::before) {
  border-top-color: var(--console-surface);
}

.waypoint-map-dialog__map :deep(.leaflet-tooltip.waypoint-map-dialog__selected-label) {
  border-color: #f5b942;
  background: var(--console-surface);
  color: #f5b942;
  pointer-events: none;
  z-index: 1;
}

.waypoint-map-dialog__map :deep(.waypoint-map-dialog__selected-label.leaflet-tooltip-left::before) {
  border-left-color: #f5b942;
}

.waypoint-map-dialog__map :deep(.waypoint-map-dialog__selected-label.leaflet-tooltip-right::before) {
  border-right-color: #f5b942;
}

.waypoint-map-dialog__selection {
  margin: 0 auto 0 0;
  text-align: left;
  color: var(--console-cyan);
  font-family: Consolas, monospace;
  font-size: 0.75rem;
}

.waypoint-map-dialog__map--route:focus-visible::after {
  position: absolute;
  z-index: 450;
  top: 50%;
  left: 50%;
  color: white;
  font: 700 1.5rem/1 sans-serif;
  text-shadow: 0 0 3px black;
  content: '＋';
  pointer-events: none;
  transform: translate(-50%, -50%);
}

.waypoint-map-dialog__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}

.waypoint-map-dialog__actions :deep(.el-button) {
  margin-left: 0;
}

:global(.waypoint-map-dialog__number) {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  border: 1px solid #97a9b6;
  border-radius: 50%;
  background: #1b2d3d;
  color: #e6eef4;
  font-weight: 600;
  cursor: grab;
}

:global(.waypoint-map-dialog__number--added) {
  border-color: #42dbf8;
  background: #42dbf8;
  color: #071522;
}

@media (max-width: 600px), (max-height: 590px) {
  .waypoint-map-dialog__map {
    height: 56vh;
    height: 56dvh;
  }
}
</style>

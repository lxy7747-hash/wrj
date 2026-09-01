<script setup lang="ts">
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { onBeforeUnmount, ref, watch } from 'vue'
import { MAP_CONFIG } from '../../config/map.config'

export interface WaypointMapPoint {
  longitude: number
  latitude: number
}

const props = defineProps<{
  modelValue: boolean
  longitude: number
  latitude: number
}>()

const emit = defineEmits<{
  'update:modelValue': [visible: boolean]
  confirm: [point: WaypointMapPoint]
}>()

const mapContainer = ref<HTMLElement | null>(null)
const selectedPoint = ref<WaypointMapPoint | null>(null)
let map: L.Map | null = null
let marker: L.CircleMarker | null = null

/**
 * 判断现有经纬度是否适合作为地图初始选点。
 * @param longitude 经度，单位为度。
 * @param latitude 纬度，单位为度。
 * @returns 坐标合法且不是新增航点的零值占位时返回 `true`。
 */
function hasInitialPoint(longitude: number, latitude: number): boolean {
  return Number.isFinite(longitude)
    && Number.isFinite(latitude)
    && longitude >= -180
    && longitude <= 180
    && latitude >= -90
    && latitude <= 90
    && (longitude !== 0 || latitude !== 0)
}

/**
 * 将 Leaflet 经纬度收敛到场景字段使用的六位小数。
 * @param value Leaflet 点击事件返回的经度或纬度。
 * @returns 六位小数的有限数值。
 */
function normalizeCoordinate(value: number): number {
  return Number(value.toFixed(6))
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
      radius: 8,
      color: '#f5b942',
      fillColor: '#f5b942',
      fillOpacity: 0.45,
      weight: 3,
    }).addTo(map)
    return
  }
  marker.setLatLng(position)
}

/**
 * 处理地图点击并记录待确认航点。
 * @param event Leaflet 地图点击事件。
 * @returns 无返回值。
 * @sideEffects 更新待确认经纬度并刷新地图标记。
 */
function handleMapClick(event: L.LeafletMouseEvent): void {
  selectedPoint.value = {
    longitude: normalizeCoordinate(event.latlng.lng),
    latitude: normalizeCoordinate(event.latlng.lat),
  }
  renderMarker(selectedPoint.value)
}

/**
 * 在弹窗完全展开后初始化离线卫星地图。
 * @returns 无返回值。
 * @sideEffects 创建 Leaflet 地图、加载本机瓦片并注册点击事件。
 */
function initializeMap(): void {
  destroyMap()
  if (mapContainer.value === null) return
  map = L.map(mapContainer.value, {
    attributionControl: false,
    zoomControl: false,
    minZoom: MAP_CONFIG.zoom.min,
    maxZoom: MAP_CONFIG.zoom.max,
    zoomSnap: MAP_CONFIG.zoom.snap,
  })
  L.tileLayer(MAP_CONFIG.resources.satellite.tileUrl, {
    minZoom: MAP_CONFIG.zoom.min,
    maxNativeZoom: MAP_CONFIG.resources.satellite.maxNativeZoom,
    maxZoom: MAP_CONFIG.zoom.max,
  }).addTo(map)
  L.control.zoom({
    zoomInText: '＋',
    zoomInTitle: '放大地图',
    zoomOutText: '－',
    zoomOutTitle: '缩小地图',
  }).addTo(map)
  map.on('click', handleMapClick)

  const bounds = L.latLngBounds(
    MAP_CONFIG.taskBounds.map(([latitude, longitude]) => [latitude, longitude] as L.LatLngTuple),
  )
  map.fitBounds(bounds, { padding: [...MAP_CONFIG.fitPadding], animate: false })
  if (selectedPoint.value !== null) renderMarker(selectedPoint.value)
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
}

/**
 * 确认当前地图选点。
 * @returns 无返回值。
 * @sideEffects 向父组件提交经纬度并关闭弹窗；高度由父组件统一设置为 0。
 */
function confirmPoint(): void {
  if (selectedPoint.value === null) return
  emit('confirm', selectedPoint.value)
  emit('update:modelValue', false)
}

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  selectedPoint.value = hasInitialPoint(props.longitude, props.latitude)
    ? { longitude: props.longitude, latitude: props.latitude }
    : null
}, { immediate: true })

onBeforeUnmount(destroyMap)
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    class="waypoint-map-dialog"
    title="地图选取航点"
    width="min(760px, calc(100vw - 2rem))"
    append-to-body
    destroy-on-close
    data-testid="waypoint-map-dialog"
    @update:model-value="emit('update:modelValue', $event)"
    @opened="initializeMap"
    @closed="destroyMap"
  >
    <p class="waypoint-map-dialog__hint">单击地图选择经纬度；二维地图无法确定高度，确认后高度设置为 0 米。</p>
    <div
      ref="mapContainer"
      class="waypoint-map-dialog__map"
      role="application"
      aria-label="航点离线地图选点"
      data-testid="waypoint-map"
    />
    <div class="waypoint-map-dialog__selection" aria-live="polite">
      <template v-if="selectedPoint">
        经度 {{ selectedPoint.longitude.toFixed(6) }}° · 纬度 {{ selectedPoint.latitude.toFixed(6) }}° · 高度 0 m
      </template>
      <template v-else>尚未选择航点</template>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="selectedPoint === null" data-testid="confirm-waypoint-point" @click="confirmPoint">
        确认选点
      </el-button>
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
  height: min(52vh, 420px);
  min-height: 300px;
  overflow: hidden;
  border: 1px solid var(--console-border-strong);
  border-radius: 6px;
  cursor: crosshair;
  background: #071522;
}

.waypoint-map-dialog__selection {
  margin-top: 0.75rem;
  color: var(--console-cyan);
  font-family: Consolas, monospace;
  font-size: 0.75rem;
}

@media (max-width: 600px) {
  .waypoint-map-dialog__map {
    height: 48vh;
    min-height: 240px;
  }
}
</style>

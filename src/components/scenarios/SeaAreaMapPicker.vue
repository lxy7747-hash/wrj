<script setup lang="ts">
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { GeoPoint } from '../../contracts/domain-models'
import { MAP_CONFIG } from '../../config/map.config'
import { SEA_POLYGON_LIMITS } from '../../features/scenarios/scenario-validation'

const props = defineProps<{
  modelValue: boolean
  /** 已保存的海面区域顶点；为空表示尚未框选。 */
  polygon?: readonly GeoPoint[]
}>()

const emit = defineEmits<{
  'update:modelValue': [visible: boolean]
  confirm: [polygon: GeoPoint[]]
}>()

const mapContainer = ref<HTMLElement | null>(null)
const points = ref<GeoPoint[]>([])
const canConfirm = computed(() => points.value.length >= SEA_POLYGON_LIMITS.minPoints)
const full = computed(() => points.value.length >= SEA_POLYGON_LIMITS.maxPoints)
let map: L.Map | null = null
let shape: L.Polygon | null = null
let vertices: L.LayerGroup | null = null

/** 与航点选点一致，坐标保留六位小数。 */
function normalizeCoordinate(value: number): number {
  return Number(value.toFixed(6))
}

/**
 * 按当前顶点重绘区域：顶点用圆点标出，三个点以上闭合为多边形。
 * @sideEffects 替换地图上的顶点图层与多边形。
 */
function render(): void {
  if (map === null) return
  vertices?.remove()
  shape?.remove()
  shape = null
  const latLngs = points.value.map(point => [point.latitude, point.longitude] as L.LatLngTuple)
  vertices = L.layerGroup(latLngs.map(position => L.circleMarker(position, {
    radius: 5, color: '#4fd1e8', fillColor: '#4fd1e8', fillOpacity: 0.8, weight: 2,
  }))).addTo(map)
  if (latLngs.length >= 2) {
    shape = L.polygon(latLngs, { color: '#4fd1e8', weight: 2, fillColor: '#4fd1e8', fillOpacity: latLngs.length >= 3 ? 0.18 : 0 }).addTo(map)
  }
}

/** 单击地图追加一个顶点；达到上限后不再追加。 */
function handleMapClick(event: L.LeafletMouseEvent): void {
  if (full.value) return
  points.value = [...points.value, { longitude: normalizeCoordinate(event.latlng.lng), latitude: normalizeCoordinate(event.latlng.lat) }]
  render()
}

function undo(): void {
  points.value = points.value.slice(0, -1)
  render()
}

function clear(): void {
  points.value = []
  render()
}

/**
 * 弹窗展开后初始化离线卫星地图；已有区域时缩放到该区域，否则显示任务范围。
 * @sideEffects 创建 Leaflet 地图、加载本机瓦片并注册点击事件。
 */
function initializeMap(): void {
  destroyMap()
  if (mapContainer.value === null) return
  map = L.map(mapContainer.value, {
    attributionControl: false,
    zoomControl: false,
    doubleClickZoom: false,
    minZoom: MAP_CONFIG.zoom.min,
    maxZoom: MAP_CONFIG.zoom.max,
    zoomSnap: MAP_CONFIG.zoom.snap,
  })
  L.tileLayer(MAP_CONFIG.resources.satellite.tileUrl, {
    minZoom: MAP_CONFIG.zoom.min,
    maxNativeZoom: MAP_CONFIG.resources.satellite.maxNativeZoom,
    maxZoom: MAP_CONFIG.zoom.max,
  }).addTo(map)
  L.control.zoom({ zoomInText: '＋', zoomInTitle: '放大地图', zoomOutText: '－', zoomOutTitle: '缩小地图' }).addTo(map)
  map.on('click', handleMapClick)
  const extent = points.value.length >= SEA_POLYGON_LIMITS.minPoints
    ? points.value.map(point => [point.latitude, point.longitude] as L.LatLngTuple)
    : MAP_CONFIG.taskBounds.map(([latitude, longitude]) => [latitude, longitude] as L.LatLngTuple)
  map.fitBounds(L.latLngBounds(extent), { padding: [...MAP_CONFIG.fitPadding], animate: false })
  render()
  map.invalidateSize({ pan: false })
}

/** 释放地图实例与图层。 */
function destroyMap(): void {
  if (map !== null) {
    map.off('click', handleMapClick)
    map.remove()
  }
  map = null
  shape = null
  vertices = null
}

function confirmArea(): void {
  if (!canConfirm.value) return
  emit('confirm', points.value.map(point => ({ ...point })))
  emit('update:modelValue', false)
}

watch(() => props.modelValue, (visible) => {
  if (visible) points.value = (props.polygon ?? []).map(point => ({ ...point }))
}, { immediate: true })

onBeforeUnmount(destroyMap)
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="框选海面区域"
    width="min(760px, calc(100vw - 2rem))"
    append-to-body
    destroy-on-close
    data-testid="sea-area-dialog"
    @update:model-value="emit('update:modelValue', $event)"
    @opened="initializeMap"
    @closed="destroyMap"
  >
    <p class="sea-area-dialog__hint">
      依次单击地图放置区域顶点，至少 {{ SEA_POLYGON_LIMITS.minPoints }} 个，最多 {{ SEA_POLYGON_LIMITS.maxPoints }} 个；首尾自动闭合。
      链路路径位于该区域上方时，按海况等级计算海面多径衰落。
    </p>
    <div ref="mapContainer" class="sea-area-dialog__map" role="application" aria-label="海面区域离线地图框选" data-testid="sea-area-map" />
    <div class="sea-area-dialog__status" aria-live="polite">
      <span data-testid="sea-area-count">已放置 {{ points.length }} 个顶点</span>
      <span v-if="!canConfirm">（还需 {{ SEA_POLYGON_LIMITS.minPoints - points.length }} 个才能围成区域）</span>
      <span v-else-if="full">（已达上限）</span>
    </div>
    <template #footer>
      <el-button :disabled="points.length === 0" data-testid="sea-area-undo" @click="undo">撤销上一点</el-button>
      <el-button :disabled="points.length === 0" data-testid="sea-area-clear" @click="clear">清空</el-button>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="!canConfirm" data-testid="confirm-sea-area" @click="confirmArea">确认区域</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.sea-area-dialog__hint {
  margin: 0 0 0.75rem;
  color: var(--console-text-muted);
  font-size: 0.75rem;
}

.sea-area-dialog__map {
  width: 100%;
  height: min(52vh, 420px);
  min-height: 300px;
  overflow: hidden;
  border: 1px solid var(--console-border-strong);
  border-radius: 6px;
  cursor: crosshair;
  background: #071522;
}

.sea-area-dialog__status {
  margin-top: 0.75rem;
  color: var(--console-cyan);
  font-size: 0.75rem;
}

@media (max-width: 600px) {
  .sea-area-dialog__map {
    height: 48vh;
    min-height: 240px;
  }
}
</style>

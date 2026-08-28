<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { MAP_CONFIG } from '../../config/map.config'
import type { MapBasemap, MapTheme } from '../../config/map.config'
import {
  PLATFORM_TYPE_LABELS,
  SITUATION_FRAME_F00042,
  type SituationLinkView,
} from '../../features/situation/situation-model'
import {
  createSituationMapController,
  type MapLayer,
  type SituationMapController,
} from './situation-map-controller'

const props = defineProps<{
  links: SituationLinkView[]
  selectedNodeId: string
}>()

const emit = defineEmits<{
  'select-node': [platformId: string]
  'select-link': [link: SituationLinkView]
}>()

const mapContainer = ref<HTMLElement | null>(null)
const mapController = ref<SituationMapController | null>(null)
const zoom = ref(MAP_CONFIG.defaults.zoom)
const theme = ref<MapTheme>(MAP_CONFIG.defaults.theme)
const basemap = ref<MapBasemap>(MAP_CONFIG.defaults.basemap)
const layers = reactive<Record<MapLayer, boolean>>({
  nodes: true,
  links: true,
  interference: true,
  grid: true,
})

const selectedNode = computed(() => (
  SITUATION_FRAME_F00042.platforms.find((platform) => platform.platformId === props.selectedNodeId)
  ?? SITUATION_FRAME_F00042.platforms[0]
))

/**
 * 向父组件转发节点选择事件。
 * @param platformId 被选择的平台唯一标识。
 * @returns 无返回值。
 * @sideeffect 触发组件的 select-node 事件。
 */
function handleSelectNode(platformId: string): void {
  emit('select-node', platformId)
}

/**
 * 向父组件转发链路选择事件。
 * @param link 被选择的链路视图。
 * @returns 无返回值。
 * @sideeffect 触发组件的 select-link 事件。
 */
function handleSelectLink(link: SituationLinkView): void {
  emit('select-link', link)
}

/**
 * 同步 Leaflet 地图报告的缩放级别。
 * @param nextZoom Leaflet 当前的缩放级别。
 * @returns 无返回值。
 * @sideeffect 更新控制条中的本地缩放显示。
 */
function handleZoomChange(nextZoom: number): void {
  zoom.value = nextZoom
}

/**
 * 切换一个地图图层的可见性。
 * @param layer 要切换的图层名称。
 * @returns 无返回值。
 * @sideeffect 修改组件内图层状态，并同步 Leaflet 图层组。
 */
function toggleLayer(layer: MapLayer): void {
  layers[layer] = !layers[layer]
  mapController.value?.setLayerVisible(layer, layers[layer])
}

/**
 * 在深色与浅色离线地图主题之间切换。
 * @returns 无返回值。
 * @sideeffect 更新组件本地主题，并让既有 Leaflet 控制器原地重绘底图、标签和经纬网。
 */
function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  mapController.value?.setTheme(theme.value)
}

/**
 * 在离线矢量与本地卫星底图之间切换。
 * @returns 无返回值。
 * @sideeffect 更新组件内底图状态，并让既有 Leaflet 控制器替换当前底图图层。
 */
function toggleBasemap(): void {
  basemap.value = basemap.value === 'vector' ? 'satellite' : 'vector'
  mapController.value?.setBasemap(basemap.value)
}

/**
 * 调整 Leaflet 地图的缩放级别。
 * @param delta 缩放方向，正数放大、负数缩小。
 * @returns 无返回值。
 * @sideeffect 调用 Leaflet 控制器缩放，并由缩放回调更新显示。
 */
function changeZoom(delta: number): void {
  if (delta > 0) {
    mapController.value?.zoomIn()
    return
  }
  mapController.value?.zoomOut()
}

/**
 * 将 Leaflet 地图恢复到固定任务范围。
 * @returns 无返回值。
 * @sideeffect 调用控制器重置地图中心和缩放级别。
 */
function resetView(): void {
  mapController.value?.reset()
}

/**
 * 在组件挂载后创建 Leaflet 地图控制器。
 * @returns 无返回值。
 * @sideeffect 初始化地图、矢量瓦片和业务图层事件。
 */
onMounted(() => {
  if (!mapContainer.value) return

  mapController.value = createSituationMapController({
    container: mapContainer.value,
    links: props.links,
    selectedNodeId: props.selectedNodeId,
    onSelectNode: handleSelectNode,
    onSelectLink: handleSelectLink,
    onZoomChange: handleZoomChange,
  })
})

/**
 * 在链路输入变化时刷新 Leaflet 链路图层。
 * @param links 父组件传入的最新链路列表。
 * @returns 无返回值。
 * @sideeffect 清空并重建控制器中的链路图层。
 */
watch(() => props.links, (links) => {
  mapController.value?.setLinks(links)
})

/**
 * 在选中节点变化时刷新 Leaflet 节点选中态。
 * @param platformId 父组件传入的最新平台唯一标识。
 * @returns 无返回值。
 * @sideeffect 重建控制器中的节点图层以更新选中样式。
 */
watch(() => props.selectedNodeId, (platformId) => {
  mapController.value?.setSelectedNodeId(platformId)
})

/**
 * 在组件卸载前释放 Leaflet 地图资源。
 * @returns 无返回值。
 * @sideeffect 移除地图事件和尺寸监听，并清空控制器引用。
 */
onBeforeUnmount(() => {
  mapController.value?.destroy()
  mapController.value = null
})
</script>

<template>
  <section
    class="offline-map"
    aria-label="Leaflet 离线态势图"
    :data-frame-id="SITUATION_FRAME_F00042.frameId"
    :data-map-theme="theme"
    :data-map-basemap="basemap"
  >
    <div
      ref="mapContainer"
      class="offline-map__canvas"
      data-testid="leaflet-situation-map"
      role="application"
      aria-label="固定帧 F-00042 Leaflet 节点、链路和干扰态势图"
    ></div>

    <div class="offline-map__layerbar" aria-label="态势图层">
      <button
        v-for="layer in ([
          ['nodes', '节点'],
          ['links', '链路'],
          ['interference', '干扰范围'],
          ['grid', '经纬网'],
        ] as const)"
        :key="layer[0]"
        type="button"
        :class="{ active: layers[layer[0]] }"
        :aria-pressed="layers[layer[0]]"
        @click="toggleLayer(layer[0])"
      >{{ layer[1] }}</button>
      <span>{{ basemap === 'vector' ? '离线矢量' : '离线卫星' }} · Z{{ zoom }}</span>
      <button
        type="button"
        :aria-label="theme === 'dark' ? '切换为浅色地图' : '切换为深色地图'"
        @click="toggleTheme"
      >地图：{{ theme === 'dark' ? '深色' : '浅色' }}</button>
      <button
        type="button"
        :aria-label="basemap === 'vector' ? '切换为卫星底图' : '切换为矢量底图'"
        @click="toggleBasemap"
      >底图：{{ basemap === 'vector' ? '矢量' : '卫星' }}</button>
      <button type="button" aria-label="放大态势图" @click="changeZoom(1)">＋</button>
      <button type="button" aria-label="缩小态势图" @click="changeZoom(-1)">－</button>
      <button type="button" @click="resetView">重置视图</button>
    </div>

    <aside v-if="selectedNode" class="node-card" data-testid="selected-node-card">
      <div>
        <span>选中节点</span>
        <strong>{{ selectedNode.name }}</strong>
      </div>
      <dl>
        <div><dt>类型</dt><dd>{{ PLATFORM_TYPE_LABELS[selectedNode.type] }}</dd></div>
        <div><dt>原始位置</dt><dd>{{ selectedNode.longitude }}°E / {{ selectedNode.latitude }}°N</dd></div>
        <div><dt>高度</dt><dd>{{ selectedNode.altitude }} m</dd></div>
        <div><dt>速度</dt><dd>{{ selectedNode.speed }} m/s</dd></div>
      </dl>
      <p class="node-card__notice">
        地图采用台海任务展示投影，不改变固定帧原始遥测。
      </p>
      <p v-if="selectedNode.type === 'COMMUNICATION_SATELLITE'" class="node-card__notice">
        卫星地图位置为轨道示意，非真实轨道位置。
      </p>
    </aside>

    <div class="offline-map__legend" aria-label="地图图例">
      <span><i class="legend-line legend-line--up"></i>正常链路</span>
      <span><i class="legend-line legend-line--degraded"></i>劣化链路</span>
      <span><i class="legend-range"></i>活动干扰范围</span>
      <span>点击链路查看 SNR / BER</span>
    </div>

    <span class="offline-map__frame">固定帧 {{ SITUATION_FRAME_F00042.frameId }} · 数据时刻 {{ SITUATION_FRAME_F00042.simulationTime }} s</span>
  </section>
</template>

<style scoped>
.offline-map {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #07131f;
}

.offline-map__canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background: #07131f;
}

.offline-map__layerbar {
  position: absolute;
  z-index: 1001;
  top: 0.5rem;
  left: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem;
  border: 1px solid var(--console-border);
  border-radius: 5px;
  background: rgba(7, 21, 34, 0.94);
}

.offline-map__layerbar button {
  height: 1.65rem;
  padding: 0 0.45rem;
  border: 1px solid var(--console-border);
  border-radius: 4px;
  color: var(--console-text-muted);
  background: var(--console-bg-elevated);
  font-size: 0.66rem;
  cursor: pointer;
}

.offline-map__layerbar button.active {
  border-color: var(--console-cyan);
  color: var(--console-cyan);
  background: rgba(66, 216, 255, 0.1);
}

.offline-map__layerbar span {
  margin-left: 0.25rem;
  color: var(--console-text-muted);
  font-size: 0.65rem;
}

.node-card {
  position: absolute;
  z-index: 1001;
  right: 0.55rem;
  bottom: 2.15rem;
  width: min(18.5rem, 42%);
  padding: 0.55rem;
  border: 1px solid var(--console-border-strong);
  border-radius: 6px;
  background: rgba(7, 21, 34, 0.94);
  box-shadow: var(--console-shadow);
}

.node-card > div {
  display: grid;
  gap: 0.12rem;
  padding-bottom: 0.35rem;
  border-bottom: 1px solid var(--console-border);
}

.node-card span,
.node-card dt {
  color: var(--console-text-muted);
  font-size: 0.62rem;
}

.node-card strong {
  font-size: 0.74rem;
}

.node-card dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.3rem 0.65rem;
  margin: 0.4rem 0 0;
}

.node-card dl div {
  min-width: 0;
}

.node-card dd {
  overflow: hidden;
  margin: 0.1rem 0 0;
  color: var(--console-text);
  font-size: 0.65rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-card__notice {
  margin: 0.45rem 0 0;
  color: var(--console-amber);
  font-size: 0.61rem;
  line-height: 1.4;
}

.offline-map__legend {
  position: absolute;
  z-index: 1001;
  bottom: 0.45rem;
  left: 0.5rem;
  display: flex;
  max-width: calc(100% - 1rem);
  gap: 0.65rem;
  padding: 0.28rem 0.45rem;
  border: 1px solid var(--console-border);
  border-radius: 4px;
  color: var(--console-text-muted);
  background: rgba(7, 21, 34, 0.92);
  font-size: 0.62rem;
}

.offline-map__legend span {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  white-space: nowrap;
}

.legend-line {
  width: 1.2rem;
  border-top: 2px solid;
}

.legend-line--up {
  border-color: var(--console-teal);
}

.legend-line--degraded {
  border-color: var(--console-amber);
  border-top-style: dashed;
}

.legend-range {
  width: 0.7rem;
  height: 0.7rem;
  border: 1px dashed var(--console-danger);
  border-radius: 50%;
}

.offline-map__frame {
  position: absolute;
  z-index: 1001;
  top: 3rem;
  right: 0.55rem;
  color: var(--console-text-muted);
  font-family: Consolas, monospace;
  font-size: 0.62rem;
}

:deep(.leaflet-container) {
  color: var(--console-text);
  font-family: inherit;
  background: #07131f;
}

:deep(.leaflet-tooltip) {
  padding: 0.3rem 0.42rem;
  border: 1px solid var(--console-border-strong);
  border-radius: 4px;
  color: var(--console-text);
  background: rgba(7, 21, 34, 0.96);
  box-shadow: var(--console-shadow);
  font-size: 0.65rem;
}

:deep(.leaflet-tooltip-top::before) {
  border-top-color: var(--console-border-strong);
}

.offline-map[data-map-theme='light'],
.offline-map[data-map-theme='light'] .offline-map__canvas,
.offline-map[data-map-theme='light'] :deep(.leaflet-container) {
  background: #cfe8f3;
}

.offline-map[data-map-theme='light'] :deep(.leaflet-tooltip) {
  border-color: #718899;
  color: #18242d;
  background: rgba(247, 251, 253, 0.96);
  box-shadow: 0 2px 8px rgba(55, 72, 82, 0.2);
}

.offline-map[data-map-theme='light'] :deep(.leaflet-tooltip-top::before) {
  border-top-color: #718899;
}

:deep(.situation-map-node-marker) {
  background: transparent;
  border: 0;
}

:deep(.situation-map-node-marker--selected) {
  z-index: 700;
}

:deep(.situation-map-node__glyph) {
  text-shadow: 0 0 6px currentColor;
}

:deep(.leaflet-marker-icon:focus),
:deep(.situation-map-link-keyboard-hit:focus) {
  outline: 2px solid var(--console-cyan);
  outline-offset: 3px;
  border-radius: 50%;
}

@media (max-width: 1500px) {
  .offline-map__layerbar button {
    padding: 0 0.3rem;
  }

  .offline-map__layerbar span,
  .offline-map__legend span:last-child {
    display: none;
  }

  .node-card {
    width: 15.5rem;
  }
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { MAP_CONFIG } from '../../config/map.config'
import type { MapBasemap, MapTheme } from '../../config/map.config'
import type { Link, TelemetryFrame } from '../../contracts/domain-models'
import type { SituationMapNode } from '../../features/situation/initial-nodes'
import { FILE_COMMUNICATION_LABELS, type FileCommunicationLink } from '../../features/situation/file-communication-links'
import {
  PLATFORM_TYPE_LABELS,
  type SituationLinkView,
} from '../../features/situation/situation-model'
import {
  createSituationMapController,
  type MapLayer,
  type SituationMapFocusTarget,
  type SituationMapController,
} from './situation-map-controller'

const props = defineProps<{
  frame: TelemetryFrame | null
  initialNodes?: SituationMapNode[]
  fileLinks?: FileCommunicationLink[]
  configuredLinks?: Link[]
  links: SituationLinkView[]
  selectedNodeId: string
  focusTarget: SituationMapFocusTarget | null
}>()

const emit = defineEmits<{
  'select-node': [platformId: string]
  'select-link': [link: SituationLinkView]
  'select-configured-link': [link: Link]
}>()

const mapContainer = ref<HTMLElement | null>(null)
const mapController = ref<SituationMapController | null>(null)
const zoom = ref(MAP_CONFIG.defaults.zoom)
const theme = ref<MapTheme>(MAP_CONFIG.defaults.theme)
const basemap = ref<MapBasemap>(MAP_CONFIG.defaults.basemap)
const selectedNodeDialogVisible = ref(false)
const selectedFileLinkId = ref('')
const fileLinkDialogVisible = ref(false)
const selectedFileLink = computed(() => props.fileLinks?.find(link => link.id === selectedFileLinkId.value))
const hasFileLinks = computed(() => !props.frame && (props.fileLinks?.length ?? 0) > 0)
const themeToggleLabel = computed(() => (
  theme.value === 'dark' ? '切换为浅色地图' : '切换为深色地图'
))
const basemapToggleLabel = computed(() => (
  basemap.value === 'vector' ? '切换为卫星底图' : '切换为矢量底图'
))
const layers = reactive<Record<MapLayer, boolean>>({
  nodes: true,
  links: true,
  interference: props.frame !== null,
  grid: MAP_CONFIG.defaults.gridVisible,
})

const nodes = computed(() => props.frame?.platforms ?? props.initialNodes ?? [])
const selectedNode = computed(() => (
  nodes.value.find((platform) => platform.platformId === props.selectedNodeId)
  ?? nodes.value[0]
))

/** 返回节点原始类型或已知中文类型，不猜测日志类型与合同枚举的对应关系。 */
const selectedNodeType = computed(() => selectedNode.value
  ? PLATFORM_TYPE_LABELS[selectedNode.value.type as keyof typeof PLATFORM_TYPE_LABELS] ?? selectedNode.value.type
  : '')

/** 使用当前底图包的覆盖范围提示真实坐标越界，不改写或裁剪节点位置。 */
const nodeOutsideBasemap = computed(() => {
  if (!selectedNode.value) return false
  const [[south, west], [north, east]] = MAP_CONFIG.resources[basemap.value].bounds
  const { longitude, latitude } = selectedNode.value
  return longitude < west || longitude > east || latitude < south || latitude > north
})

/**
 * 向父组件转发节点选择事件。
 * @param platformId 被选择的平台唯一标识。
 * @returns 无返回值。
 * @sideeffect 触发组件的 select-node 事件，并打开节点详情弹框。
 */
function handleSelectNode(platformId: string): void {
  emit('select-node', platformId)
  selectedNodeDialogVisible.value = true
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
 * 设置一个地图图层的可见性。
 * @param layer 要设置的图层名称。
 * @param visible 是否显示该图层。
 * @returns 无返回值。
 * @sideeffect 修改组件内图层状态，并同步 Leaflet 图层组。
 */
function setLayerVisible(layer: MapLayer, visible: boolean): void {
  if (layers[layer] === visible) return
  layers[layer] = visible
  mapController.value?.setLayerVisible(layer, visible)
}

/**
 * 切换一个地图图层的可见性。
 * @param layer 要切换的图层名称。
 * @returns 无返回值。
 * @sideeffect 修改组件内图层状态，并同步 Leaflet 图层组。
 */
function toggleLayer(layer: MapLayer): void {
  setLayerVisible(layer, !layers[layer])
}

/**
 * 执行左侧摘要列表发出的地图定位请求。
 * @param target 节点、链路或干扰设备定位目标。
 * @returns 无返回值。
 * @sideeffect 确保对应业务图层可见，并调用 Leaflet 控制器调整地图视图。
 */
function focusTargetOnMap(target: SituationMapFocusTarget): void {
  if (target.kind === 'node') setLayerVisible('nodes', true)
  if (target.kind === 'link') setLayerVisible('links', true)
  if (target.kind === 'interference') {
    setLayerVisible('nodes', true)
    setLayerVisible('interference', true)
  }
  mapController.value?.focusTarget(target)
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
    frame: props.frame,
    initialNodes: props.initialNodes,
    fileLinks: props.fileLinks,
    configuredLinks: props.configuredLinks,
    onSelectConfiguredLink: link => emit('select-configured-link', link),
    onSelectFileLink: link => {
      selectedFileLinkId.value = link.id
      fileLinkDialogVisible.value = true
    },
    links: props.links,
    selectedNodeId: props.selectedNodeId,
    onSelectNode: handleSelectNode,
    onSelectLink: handleSelectLink,
    onZoomChange: handleZoomChange,
  })
  if (props.focusTarget) focusTargetOnMap(props.focusTarget)
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

/** 在完整帧变化时同步地图节点、链路端点和干扰范围。 */
watch(() => props.frame, (frame) => {
  mapController.value?.setFrame(frame)
})

/** 将追加文件合并后的节点位置传入现有地图，保留视图、图层开关和选中状态。 */
watch(() => props.initialNodes, (nodes) => {
  if (!props.frame) mapController.value?.setNodes(nodes ?? [])
})

watch(() => props.fileLinks, links => {
  mapController.value?.setFileLinks(links ?? [])
})

watch(() => props.configuredLinks, links => {
  mapController.value?.setConfiguredLinks(links)
})

watch(selectedFileLink, link => {
  if (!link) fileLinkDialogVisible.value = false
})

/**
 * 统一同步父组件的节点选择与摘要定位状态。
 * @returns 无返回值。
 * @sideeffect 更新节点选中样式，或恢复目标图层并调整地图视图。
 */
watch(
  [() => props.selectedNodeId, () => props.focusTarget],
  ([platformId, target], [previousPlatformId, previousTarget]) => {
    // 同一批次的摘要定位已包含选中态，优先处理它以避免重复重绘。
    if (target && target !== previousTarget) {
      focusTargetOnMap(target)
      return
    }
    if (platformId !== previousPlatformId) mapController.value?.setSelectedNodeId(platformId)
  },
)

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
    :data-frame-id="frame?.frameId"
    :data-map-theme="theme"
    :data-map-basemap="basemap"
  >
    <div
      ref="mapContainer"
      class="offline-map__canvas"
      data-testid="leaflet-situation-map"
      role="application"
      :aria-label="frame ? `固定帧 ${frame.frameId} Leaflet 节点、链路和干扰态势图` : configuredLinks ? '所选场景初始位置与配置链路图' : '真实日志节点位置与通信关联图'"
    ></div>

    <div class="offline-map__topbar">
      <slot name="topbar"></slot>

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
          :disabled="!frame && (layer[0] === 'interference' || (layer[0] === 'links' && !hasFileLinks && !configuredLinks?.length))"
          @click="toggleLayer(layer[0])"
        >{{ layer[1] }}</button>
        <span>{{ basemap === 'vector' ? '离线矢量' : '离线卫星' }} · Z{{ zoom }}</span>
      </div>
    </div>

    <div class="offline-map__view-controls" aria-label="态势图视图控制">
      <button
        type="button"
        :aria-label="themeToggleLabel"
        :title="themeToggleLabel"
        @click="toggleTheme"
      >
        <svg
          class="offline-map__control-icon"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          focusable="false"
        >
          <g
            v-if="theme === 'dark'"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          >
            <circle cx="12" cy="12" r="3.5" />
            <path d="M12 2.5V5M12 19V21.5M2.5 12H5M19 12H21.5M5.3 5.3L7.1 7.1M16.9 16.9L18.7 18.7M18.7 5.3L16.9 7.1M7.1 16.9L5.3 18.7" />
          </g>
          <path
            v-else
            d="M19.5 15.4A8 8 0 0 1 8.6 4.5A8 8 0 1 0 19.5 15.4Z"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button
        type="button"
        :aria-label="basemapToggleLabel"
        :title="basemapToggleLabel"
        @click="toggleBasemap"
      >
        <svg
          class="offline-map__control-icon"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          focusable="false"
        >
          <g
            v-if="basemap === 'vector'"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="9" y="8" width="6" height="8" rx="1" />
            <path d="M9 10L4 7V13L9 14M15 10L20 7V13L15 14M12 5V8M10 5H14M12 16V19M9.5 21.5L12 19L14.5 21.5" />
          </g>
          <g
            v-else
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3.5 5.5L9 3L15 5.5L20.5 3V18.5L15 21L9 18.5L3.5 21V5.5Z" />
            <path d="M9 3V18.5M15 5.5V21" />
          </g>
        </svg>
      </button>
      <button type="button" aria-label="放大态势图" title="放大态势图" @click="changeZoom(1)">＋</button>
      <button type="button" aria-label="缩小态势图" title="缩小态势图" @click="changeZoom(-1)">－</button>
      <button type="button" aria-label="重置视图" title="重置视图" @click="resetView">
        <svg
          class="offline-map__control-icon"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M4.5 8V3.5M4.5 3.5H9M4.5 3.5L7.7 6.7A7.5 7.5 0 1 1 5 14.5"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <el-dialog
      v-model="selectedNodeDialogVisible"
      width="min(38rem, calc(100vw - 2rem))"
      class="selected-node-dialog"
      :close-on-click-modal="false"
    >
      <template #header>
        <div v-if="selectedNode" class="selected-node-dialog__header">
          <span>节点详情</span>
          <strong>{{ selectedNode.name }}</strong>
        </div>
      </template>

      <div
        v-if="selectedNode"
        class="selected-node-dialog__body"
        data-testid="selected-node-dialog"
      >
        <dl class="selected-node-dialog__grid">
          <div><dt>类型</dt><dd>{{ selectedNodeType }}</dd></div>
          <div><dt>{{ frame ? '遥测位置' : '节点位置' }}</dt><dd>{{ Math.abs(selectedNode.longitude) }}°{{ selectedNode.longitude < 0 ? 'W' : 'E' }} / {{ Math.abs(selectedNode.latitude) }}°{{ selectedNode.latitude < 0 ? 'S' : 'N' }}</dd></div>
          <div><dt>高度</dt><dd>{{ selectedNode.altitude }} m</dd></div>
          <div><dt>速度</dt><dd>{{ configuredLinks ? '暂无运行数据' : `${selectedNode.speed} m/s` }}</dd></div>
        </dl>
        <p v-if="nodeOutsideBasemap" class="selected-node-dialog__notice">
          该节点位于当前离线底图覆盖范围之外，坐标按原值显示。
        </p>
        <p
          v-if="selectedNode.type === 'COMMUNICATION_SATELLITE'"
          class="selected-node-dialog__notice"
        >
          {{ configuredLinks ? '二维地图按卫星配置经纬度显示，高度不按地图比例呈现。' : '二维地图按卫星遥测经纬度显示，高度不按地图比例呈现。' }}
        </p>
      </div>
    </el-dialog>

    <el-dialog v-model="fileLinkDialogVisible" title="通信关联明细" width="min(52rem, calc(100vw - 2rem))" :close-on-click-modal="false">
      <div v-if="selectedFileLink" data-testid="file-link-details">
        <p>{{ FILE_COMMUNICATION_LABELS[selectedFileLink.type] }} · {{ selectedFileLink.sourcePlatformId }} — {{ selectedFileLink.targetPlatformId }}</p>
        <p class="selected-node-dialog__notice">状态未知：按端点设备类型筛选登记关联，曲线仅为关联示意，不代表物理链路已接通；不提供 SNR、BER。</p>
        <el-table :data="selectedFileLink.records" max-height="340">
          <el-table-column label="登记时间（秒）" prop="time" width="125" />
          <el-table-column label="发送端" min-width="230">
            <template #default="{ row }">{{ row.source.platformName }} / {{ row.source.communicationName }}<br>{{ row.sourceType }} · {{ row.source.address }}</template>
          </el-table-column>
          <el-table-column label="接收端" min-width="230">
            <template #default="{ row }">{{ row.target.platformName }} / {{ row.target.communicationName }}<br>{{ row.targetType }} · {{ row.target.address }}</template>
          </el-table-column>
          <el-table-column label="源记录" prop="sourceEventId" width="120" />
        </el-table>
      </div>
    </el-dialog>

    <div v-if="frame || hasFileLinks" class="offline-map__legend" aria-label="链路类型图例">
      <div><i class="legend-line legend-line--satellite"></i>卫星链路</div>
      <div><i class="legend-line legend-line--microwave"></i>微波链路</div>
      <div><i class="legend-line legend-line--datalink"></i>新一代数传链路</div>
      <div><i class="legend-line legend-line--laser"></i>激光链路</div>
      <div><i class="legend-line legend-line--unavailable"></i>受干扰 / 失效链路</div>
    </div>

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

.offline-map__topbar {
  position: absolute;
  z-index: 1002;
  top: 0.75rem;
  right: var(--telemetry-panel-clearance, 0.75rem);
  left: var(--scene-panel-clearance, 0.75rem);
  display: flex;
  min-width: 0;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 0.5rem;
  pointer-events: none;
  transition: right 0.18s ease, left 0.18s ease;
}

.offline-map__layerbar {
  display: flex;
  width: max-content;
  max-width: 100%;
  flex: 0 0 auto;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.25rem;
  margin-left: auto;
  padding: 0.25rem;
  border-radius: 5px;
  pointer-events: auto;
}

.offline-map__view-controls {
  position: absolute;
  z-index: 1001;
  right: var(--view-controls-clearance, var(--telemetry-panel-clearance, 0.75rem));
  bottom: 0.75rem;
  display: flex;
  flex-direction: column;
  width: max-content;
  max-width: calc(100% - var(--view-controls-clearance, var(--telemetry-panel-clearance, 0.75rem)) - 0.75rem);
  align-items: stretch;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 5px;
  transition: right 0.18s ease;
}

.offline-map__layerbar button,
.offline-map__view-controls button {
  height: 1.65rem;
  padding: 0 0.45rem;
  border: 1px solid var(--console-border);
  border-radius: 4px;
  color: var(--console-text-muted);
  background: var(--console-bg-elevated);
  font-size: var(--console-font-size-min);
  cursor: pointer;
}

.offline-map__layerbar button {
  background: rgba(7, 21, 34, 0.96);
}

.offline-map__view-controls button {
  display: grid;
  min-width: 1.65rem;
  place-items: center;
}

.offline-map__control-icon {
  display: block;
  width: 1rem;
  height: 1rem;
  color: inherit;
}

.offline-map__layerbar button.active {
  border-color: var(--console-cyan);
  color: var(--console-cyan);
  background: #0e4155;
}

.offline-map__layerbar span {
  margin-left: 0.25rem;
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.selected-node-dialog__header {
  display: grid;
  gap: 0.15rem;
}

.selected-node-dialog__header span {
  color: var(--console-text);
  font-size: 0.95rem;
  font-weight: 700;
}

.selected-node-dialog__header strong {
  color: var(--console-cyan);
  font-size: var(--console-font-size-min);
}

.selected-node-dialog__grid dt {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.selected-node-dialog__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.3rem 0.65rem;
  margin: 0;
}

.selected-node-dialog__grid div {
  min-width: 0;
}

.selected-node-dialog__grid dd {
  overflow: hidden;
  margin: 0.1rem 0 0;
  color: var(--console-text);
  font-size: var(--console-font-size-min);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selected-node-dialog__notice {
  margin: 0.45rem 0 0;
  color: var(--console-amber);
  font-size: var(--console-font-size-min);
  line-height: 1.4;
}

.offline-map__legend {
  position: absolute;
  z-index: 1001;
  bottom: 0.75rem;
  left: var(--legend-clearance, var(--scene-panel-clearance, 0.75rem));
  width: max-content;
  max-width: calc(100% - 1.5rem);
  padding: 0.625rem 0.875rem;
  border: 1px solid #2d4a6b;
  border-radius: 6px;
  color: #c0c4cc;
  background: rgba(13, 27, 42, 0.85);
  font-size: var(--console-font-size-min);
  transition: left 0.18s ease;
}

.offline-map__legend div {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.25rem 0;
  white-space: nowrap;
}

.legend-line {
  width: 1.625rem;
  border-top: 3px solid;
}

.legend-line--satellite {
  border-color: #67c23a;
}

.legend-line--microwave {
  border-color: #409eff;
  border-top-style: dashed;
}

.legend-line--datalink {
  border-color: #e6a23c;
  border-top-style: dotted;
}

.legend-line--laser {
  border-color: #b37feb;
}

.legend-line--unavailable {
  border-color: #f56c6c;
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
  font-size: var(--console-font-size-min);
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

:deep(.situation-map-node-marker--selected .situation-map-node__glyph) {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 2px solid #f5b942;
  border-radius: 50%;
  background: rgba(245, 185, 66, 0.2);
}

:deep(.situation-map-link--selected),
:deep(.situation-map-interference--selected) {
  filter: drop-shadow(0 0 4px #f5b942) drop-shadow(0 0 8px rgba(245, 185, 66, 0.9));
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
  .offline-map__layerbar button,
  .offline-map__view-controls button {
    padding: 0 0.3rem;
  }
}
</style>

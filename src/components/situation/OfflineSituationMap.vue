<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { MAP_CONFIG, isSatellitePlatform, resolvePlatformCoordinates } from '../../config/map.config'
import type { MapBasemap, MapTheme } from '../../config/map.config'
import type { Link, TelemetryFrame } from '../../contracts/domain-models'
import type { SituationMapNode } from '../../features/situation/initial-nodes'
import { FILE_COMMUNICATION_LABELS, type FileCommunicationLink } from '../../features/situation/file-communication-links'
import { selectFileMessageLinks, FILE_MESSAGE_DIRECTION_LABELS, type FileMessageLink } from '../../features/situation/file-message-links'
import { fileJammerRadiusMeters, selectFileDeviceStates, type FileDeviceEvent } from '../../features/situation/file-device-events'
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
  /** 已登记的通信关联；只表示路由登记，不是已发生的业务。 */
  fileLinks?: FileCommunicationLink[]
  /** 由消息收发证据推导的业务链路；地图链路图层的实际内容。 */
  fileMessageLinks?: FileMessageLink[]
  fileDeviceEvents?: FileDeviceEvent[]
  fileTime?: number
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
const selectedMessageLinkId = ref('')
const messageLinkDialogVisible = ref(false)
const visibleMessageLinks = computed(() => !props.frame && !props.configuredLinks
  ? selectFileMessageLinks(props.fileMessageLinks ?? [], props.fileTime ?? 0) : [])
const selectedMessageLink = computed(() => visibleMessageLinks.value.find(link => link.id === selectedMessageLinkId.value))
const hasFileLinks = computed(() => !props.frame && !props.configuredLinks && (props.fileLinks?.length ?? 0) > 0)
const hasFileMessageLinks = computed(() => visibleMessageLinks.value.length > 0)
const hasFileInterference = computed(() => !props.frame && !props.configuredLinks
  && props.initialNodes?.some(node => fileJammerRadiusMeters(node.platformId, props.fileDeviceEvents ?? [], MAP_CONFIG.fileInterferenceRadiusMeters) !== undefined))
const themeToggleLabel = computed(() => (
  theme.value === 'dark' ? '切换为浅色地图' : '切换为深色地图'
))
const basemapToggleLabel = computed(() => (
  basemap.value === 'vector' ? '切换为卫星底图' : '切换为矢量底图'
))
/** 系统要求减少动态效果时默认关闭流向动画，但保留按钮，用户仍可手动打开。 */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const layers = reactive<Record<MapLayer, boolean>>({
  nodes: true,
  links: true,
  // 流向动画默认开启；系统偏好减少动态效果时默认关闭。
  flow: !prefersReducedMotion(),
  // 当前时刻没有业务链路时用登记关联兜底，避免地图上一条连线都没有；有业务链路时让位。
  potential: !hasFileMessageLinks.value,
  interference: props.frame !== null || !!hasFileInterference.value,
  grid: MAP_CONFIG.defaults.gridVisible,
})

const nodes = computed(() => props.frame?.platforms ?? props.initialNodes ?? [])
const fileDeviceStates = computed(() => !props.frame && !props.configuredLinks
  ? selectFileDeviceStates(props.fileDeviceEvents ?? [], props.fileTime ?? 0) : [])

function fileEndpointLabel(platformId: string): string {
  const name = nodes.value.find(node => node.platformId === platformId)?.name
  return name && name !== platformId ? `${name}（${platformId}）` : platformId
}

const selectedNode = computed(() => (
  nodes.value.find((platform) => platform.platformId === props.selectedNodeId)
  ?? nodes.value[0]
))
const selectedNodeFileLinks = computed(() => props.fileLinks?.filter(link =>
  link.sourcePlatformId === selectedNode.value?.platformId || link.targetPlatformId === selectedNode.value?.platformId) ?? [])
const selectedNodeMessageLinks = computed(() => visibleMessageLinks.value.filter(link =>
  link.sourcePlatformId === selectedNode.value?.platformId || link.targetPlatformId === selectedNode.value?.platformId))

function openFileLink(link: FileCommunicationLink): void {
  selectedFileLinkId.value = link.id
  fileLinkDialogVisible.value = true
}

function openMessageLink(link: FileMessageLink): void {
  selectedMessageLinkId.value = link.id
  messageLinkDialogVisible.value = true
}

/** 以毫秒为主、秒为辅展示投递时延；秒值保留原始精度，不做四舍五入后改写。 */
function formatDelay(seconds: number): string {
  return `${(seconds * 1000).toFixed(3)} 毫秒（${seconds} 秒）`
}

/**
 * 判断一个图层按钮是否不可用。
 * @param layer 节点、链路、登记关联、干扰范围或经纬网图层。
 * @returns 当前数据源没有任何内容可绘制时为 true。
 */
function layerDisabled(layer: MapLayer): boolean {
  if (props.frame) return false
  if (layer === 'links' || layer === 'flow') return !hasFileMessageLinks.value && !props.configuredLinks?.length
  if (layer === 'potential') return !hasFileLinks.value
  if (layer === 'interference') return !hasFileInterference.value
  return false
}
const selectedFileInterferenceRadius = computed(() => !props.frame && !props.configuredLinks && selectedNode.value
  ? fileJammerRadiusMeters(selectedNode.value.platformId, props.fileDeviceEvents ?? [], MAP_CONFIG.fileInterferenceRadiusMeters) : undefined)
const selectedFileDevices = computed(() => fileDeviceStates.value.filter(event => event.platformId === selectedNode.value?.platformId))

function deviceStateLabel(event: FileDeviceEvent): string {
  return event.kind === 'JAMMING' ? (event.active ? '干扰请求进行中' : '干扰已停止') : (event.active ? '已开启' : '已关闭')
}

function communicationStateLabel(platformId: string, deviceId: string): string {
  const event = fileDeviceStates.value.find(event => event.kind === 'COMMUNICATION' && event.platformId === platformId && event.deviceId === deviceId)
  return event ? `${deviceStateLabel(event)} · ${event.time} 秒 · ${event.sourceEventId}` : '启停未知（无对应事件）'
}

/** 返回节点原始类型或已知中文类型，不猜测日志类型与合同枚举的对应关系。 */
const selectedNodeType = computed(() => selectedNode.value
  ? PLATFORM_TYPE_LABELS[selectedNode.value.type as keyof typeof PLATFORM_TYPE_LABELS] ?? selectedNode.value.type
  : '')

/** 根据地图开关解析选中节点在界面展示的有效经纬度坐标。 */
const selectedNodePosition = computed(() => {
  if (!selectedNode.value) return { longitude: 0, latitude: 0 }
  return resolvePlatformCoordinates(selectedNode.value, nodes.value)
})
const usesTemporarySatellitePosition = computed(() => isSatellitePlatform(selectedNode.value) && !MAP_CONFIG.useSatelliteDataPosition)

/** 使用当前底图包的覆盖范围提示坐标越界，不改写或裁剪节点位置。 */
const nodeOutsideBasemap = computed(() => {
  if (!selectedNode.value) return false
  const [[south, west], [north, east]] = MAP_CONFIG.resources[basemap.value].bounds
  const { longitude, latitude } = selectedNodePosition.value
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

// 首次收到范围数据时开启图层；普通位置更新不覆盖用户手动关闭的选择。
watch(() => props.frame !== null || !!hasFileInterference.value, available => {
  setLayerVisible('interference', available)
})

/**
 * 业务链路出现时让位、消失时兜底。
 * 登记关联是 t=0 的恒定路由登记，当前时刻已经有真实投递时不再需要它占位；
 * 反之当游标还没有到达第一条投递（含静止的 0 秒）时必须保留，否则地图会没有任何连线。
 */
watch(hasFileMessageLinks, visible => {
  setLayerVisible('potential', !visible)
})

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
    fileMessageLinks: visibleMessageLinks.value,
    fileDeviceStates: fileDeviceStates.value,
    configuredLinks: props.configuredLinks,
    onSelectConfiguredLink: link => emit('select-configured-link', link),
    onSelectFileLink: openFileLink,
    onSelectFileMessageLink: openMessageLink,
    links: props.links,
    selectedNodeId: props.selectedNodeId,
    onSelectNode: handleSelectNode,
    onSelectLink: handleSelectLink,
    onZoomChange: handleZoomChange,
  })
  if (!layers.interference) mapController.value.setLayerVisible('interference', false)
  if (!layers.potential) mapController.value.setLayerVisible('potential', false)
  if (!layers.flow) mapController.value.setLayerVisible('flow', false)
  if (props.focusTarget) focusTargetOnMap(props.focusTarget)
})

/**
 * 在链路输入变化时刷新 Leaflet 链路图层。
 * @param links 父组件传入的最新链路列表。
 * @returns 无返回值。
 * @sideeffect 按链路身份更新控制器中的坐标、样式和交互数据。
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

/** 回放游标变化时同步业务链路：链路集合按首末投递时刻随时间增长。 */
watch(visibleMessageLinks, links => {
  mapController.value?.setFileMessageLinks(links)
})

watch(fileDeviceStates, states => {
  mapController.value?.setFileDeviceStates(states)
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
            ['flow', '流向动画'],
            ['interference', '干扰范围'],
            ['grid', '经纬网'],
          ] as const)"
          :key="layer[0]"
          type="button"
          :class="{ active: layers[layer[0]] }"
          :aria-pressed="layers[layer[0]]"
          :disabled="layerDisabled(layer[0])"
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
          <div v-if="usesTemporarySatellitePosition"><dt>地图临时示意位置</dt><dd>{{ Math.abs(selectedNodePosition.longitude) }}°{{ selectedNodePosition.longitude < 0 ? 'W' : 'E' }} / {{ Math.abs(selectedNodePosition.latitude) }}°{{ selectedNodePosition.latitude < 0 ? 'S' : 'N' }}</dd></div>
          <div><dt>高度</dt><dd>{{ selectedNode.altitude }} m</dd></div>
          <div><dt>速度</dt><dd>{{ configuredLinks ? '暂无运行数据' : `${selectedNode.speed} m/s` }}</dd></div>
          <div v-if="selectedFileInterferenceRadius !== undefined"><dt>干扰范围（半径）</dt><dd>{{ selectedFileInterferenceRadius / 1000 }} 公里（指定范围）</dd></div>
        </dl>
        <template v-if="!frame && !configuredLinks">
          <p class="selected-node-dialog__notice">设备状态截至 {{ fileTime ?? 0 }} 秒；范围圈仅表示有进行中的干扰请求，不证明实际干扰效果。</p>
          <el-table v-if="selectedFileDevices.length" :data="selectedFileDevices" data-testid="file-device-states" max-height="260">
            <el-table-column prop="deviceId" label="设备标识" min-width="150" />
            <el-table-column label="事件状态" min-width="160">
              <template #default="{ row }">
                {{ deviceStateLabel(row) }}
                <template v-if="row.kind === 'JAMMING' && row.frequencyHz !== undefined && row.bandwidthHz !== undefined"><br>频率 {{ row.frequencyHz / 1000000 }} MHz · 带宽 {{ row.bandwidthHz / 1000000 }} MHz</template>
              </template>
            </el-table-column>
            <el-table-column label="最近事件" min-width="140">
              <template #default="{ row }">{{ row.time }} 秒 · {{ row.sourceEventId }}</template>
            </el-table-column>
          </el-table>
          <p v-else data-testid="file-device-empty" class="selected-node-dialog__notice">当前时刻无设备启停或干扰请求记录，状态未知。</p>
          <template v-if="selectedNodeMessageLinks.length">
            <p class="selected-node-dialog__notice">业务链路：由消息收发证据推导，表示已发生的投递及其方向，不表示链路质量。</p>
            <el-table :data="selectedNodeMessageLinks" max-height="240" data-testid="node-message-links">
              <el-table-column label="业务链路" min-width="240">
                <template #default="{ row }">{{ FILE_COMMUNICATION_LABELS[row.type as keyof typeof FILE_COMMUNICATION_LABELS] }} · {{ fileEndpointLabel(row.sourcePlatformId) }} → {{ fileEndpointLabel(row.targetPlatformId) }}</template>
              </el-table-column>
              <el-table-column label="投递" width="90">
                <template #default="{ row }">{{ row.messageCount }} 条</template>
              </el-table-column>
              <el-table-column label="明细" width="85">
                <template #default="{ row }"><el-button link type="primary" @click="openMessageLink(row)">查看</el-button></template>
              </el-table-column>
            </el-table>
          </template>
          <template v-if="selectedNodeFileLinks.length">
            <p class="selected-node-dialog__notice">登记的通信关联（含地图未绘制的关联），不表示当前正在转发，也不证明节点间存在业务。</p>
            <el-table :data="selectedNodeFileLinks" max-height="240" data-testid="node-file-associations">
              <el-table-column label="关联" min-width="240">
                <template #default="{ row }">{{ FILE_COMMUNICATION_LABELS[row.type as keyof typeof FILE_COMMUNICATION_LABELS] }} · {{ fileEndpointLabel(row.sourcePlatformId) }} — {{ fileEndpointLabel(row.targetPlatformId) }}</template>
              </el-table-column>
              <el-table-column label="明细" width="85">
                <template #default="{ row }"><el-button link type="primary" @click="openFileLink(row)">查看</el-button></template>
              </el-table-column>
            </el-table>
          </template>
        </template>
        <p v-if="nodeOutsideBasemap" class="selected-node-dialog__notice">
          该节点位于当前离线底图覆盖范围之外，坐标按原值显示。
        </p>
        <p
          v-if="isSatellitePlatform(selectedNode)"
          class="selected-node-dialog__notice"
        >
          {{ usesTemporarySatellitePosition ? '地图临时示意位置仅用于展示，不是遥测或配置原值；高度不按地图比例呈现。' : configuredLinks ? '二维地图按卫星配置经纬度显示，高度不按地图比例呈现。' : '二维地图按卫星遥测经纬度显示，高度不按地图比例呈现。' }}
        </p>
      </div>
    </el-dialog>

    <el-dialog v-model="messageLinkDialogVisible" title="业务链路明细" width="min(58rem, calc(100vw - 2rem))" :close-on-click-modal="false">
      <div v-if="selectedMessageLink" data-testid="message-link-details">
        <p>{{ FILE_COMMUNICATION_LABELS[selectedMessageLink.type] }}业务链路 · {{ fileEndpointLabel(selectedMessageLink.sourcePlatformId) }} → {{ fileEndpointLabel(selectedMessageLink.targetPlatformId) }}</p>
        <dl class="selected-node-dialog__grid">
          <div><dt>发送设备</dt><dd>{{ selectedMessageLink.sourceDeviceId }}</dd></div>
          <div><dt>接收设备</dt><dd>{{ selectedMessageLink.targetDeviceId }}</dd></div>
          <div><dt>活跃窗口</dt><dd>{{ selectedMessageLink.firstTimeS }} – {{ selectedMessageLink.lastTimeS }} 秒</dd></div>
          <div><dt>累计投递</dt><dd>{{ selectedMessageLink.messageCount }} 条</dd></div>
          <div><dt>业务类型</dt><dd>{{ selectedMessageLink.messageTypes.join('、') }}</dd></div>
          <div><dt>业务方向</dt><dd>{{ selectedMessageLink.direction ? FILE_MESSAGE_DIRECTION_LABELS[selectedMessageLink.direction] : '未判定（同一链路承载多类业务）' }}</dd></div>
          <div><dt>投递时延中位</dt><dd>{{ formatDelay(selectedMessageLink.medianDelayS) }}</dd></div>
        </dl>
        <p class="selected-node-dialog__notice">连线表示已发生的消息投递，箭头表示投递方向；不表示链路质量，也不提供 SNR、BER、丢包率。设备状态按 {{ fileTime ?? 0 }} 秒的事件显示。</p>
        <el-table :data="selectedMessageLink.records" max-height="320">
          <el-table-column label="接收时刻（秒）" prop="time" width="130" />
          <el-table-column label="发送端" min-width="200">
            <template #default="{ row }">{{ fileEndpointLabel(row.source.platformName) }} / {{ row.source.communicationName }}</template>
          </el-table-column>
          <el-table-column label="接收端" min-width="200">
            <template #default="{ row }">{{ fileEndpointLabel(row.target.platformName) }} / {{ row.target.communicationName }}</template>
          </el-table-column>
          <el-table-column label="业务类型" prop="messageType" width="130" />
          <el-table-column label="消息量（bit）" prop="messageSizeBits" width="115" />
          <el-table-column label="时延（秒）" width="115">
            <template #default="{ row }">{{ row.delayS }}</template>
          </el-table-column>
          <el-table-column label="源记录" prop="sourceEventId" width="110" />
        </el-table>
      </div>
    </el-dialog>

    <el-dialog v-model="fileLinkDialogVisible" title="通信关联明细" width="min(52rem, calc(100vw - 2rem))" :close-on-click-modal="false">
      <div v-if="selectedFileLink" data-testid="file-link-details">
        <p>{{ FILE_COMMUNICATION_LABELS[selectedFileLink.type] }} · {{ fileEndpointLabel(selectedFileLink.sourcePlatformId) }} — {{ fileEndpointLabel(selectedFileLink.targetPlatformId) }}</p>
        <p class="selected-node-dialog__notice">链路状态未知：连线仅为登记关联，不代表物理链路已接通，不表示当前正在转发；设备启停按 {{ fileTime ?? 0 }} 秒的事件显示，不提供 SNR、BER。</p>
        <el-table :data="selectedFileLink.records" max-height="340">
          <el-table-column label="登记时间（秒）" prop="time" width="125" />
          <el-table-column label="发送端" min-width="230">
            <template #default="{ row }">{{ fileEndpointLabel(row.source.platformName) }} / {{ row.source.communicationName }}<br>{{ row.sourceType }} · {{ row.source.address }}<br>{{ communicationStateLabel(row.source.platformName, row.source.communicationName) }}</template>
          </el-table-column>
          <el-table-column label="接收端" min-width="230">
            <template #default="{ row }">{{ fileEndpointLabel(row.target.platformName) }} / {{ row.target.communicationName }}<br>{{ row.targetType }} · {{ row.target.address }}<br>{{ communicationStateLabel(row.target.platformName, row.target.communicationName) }}</template>
          </el-table-column>
          <el-table-column label="源记录" prop="sourceEventId" width="120" />
        </el-table>
      </div>
    </el-dialog>

    <div class="offline-map__legend" aria-label="链路类型图例">
      <div><i class="legend-line legend-line--satellite"></i>卫星链路</div>
      <div><i class="legend-line legend-line--microwave"></i>微波链路</div>
      <div><i class="legend-line legend-line--datalink"></i>新一代数传链路</div>
      <div><i class="legend-line legend-line--laser"></i>激光链路</div>
      <div><i class="legend-line legend-line--unavailable"></i>受干扰 / 失效链路</div>
      <div><i class="legend-line legend-line--fiber"></i>光纤链路</div>
      <div v-if="hasFileMessageLinks"><i class="legend-arrow" aria-hidden="true">▲</i>消息投递方向</div>
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

.legend-line--fiber {
  border-color: #20b2aa;
}

.legend-arrow {
  width: 1.625rem;
  color: #c0c4cc;
  font-size: 0.7rem;
  font-style: normal;
  text-align: center;
}

:deep(.situation-map-link-arrow) {
  background: transparent;
  border: 0;
}

:deep(.situation-map-link-arrow__glyph) {
  display: block;
  font-size: 12px;
  line-height: 14px;
  text-align: center;
  text-shadow: 0 0 3px #06111d, 0 0 5px #06111d;
}

/* 业务方向单字标记：中文单字自带语义，因此不需要额外图例，也不参与交互。 */
:deep(.situation-map-link-direction) {
  background: transparent;
  border: 0;
  pointer-events: none;
}

:deep(.situation-map-link-direction__text) {
  display: block;
  color: #d7e8f3;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  text-shadow: 0 0 3px #06111d, 0 0 5px #06111d, 0 1px 2px #06111d;
}

/**
 * 单颗流星：暗尾到亮头共用相同速度，尾迹离开终点后再从起点发出。
 * 动画名必须写在 scoped 样式里 —— Vue 会给局部 @keyframes 加哈希重命名，
 * 只有在同一 scoped 块内引用才会被同步改写；行内样式里的名字不会被改写，会指向不存在的关键帧。
 * 位移量由控制器按归一化路径和尾迹比例写入 --situation-link-flow-shift，
 * 时长由 MAP_CONFIG.linkFlowCycleSeconds 以行内 animation-duration 覆盖。
 */
@keyframes situation-map-link-flow {
  from {
    stroke-dashoffset: var(--situation-link-flow-start);
  }

  to {
    stroke-dashoffset: var(--situation-link-flow-shift);
  }
}

:deep(.situation-map-link-flow) {
  animation-name: situation-map-link-flow;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  animation-duration: 1.4s;
  pointer-events: none;
  filter: drop-shadow(0 0 1.5px rgba(160, 225, 255, .5));
}

/* 尊重系统的减少动态效果设置：保留链路与箭头，只停掉滚动。 */
@media (prefers-reduced-motion: reduce) {
  :deep(.situation-map-link-flow) {
    animation: none !important;
  }
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

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { MAP_CONFIG, isSatellitePlatform, nodeCategory, nodeGlyph, nodeIconUrl, resolvePlatformCoordinates } from '../../config/map.config'
import type { MapBasemap, MapTheme } from '../../config/map.config'
import type { EngineFrameSnapshot, Environment, Link, ScenarioConfig, TelemetryFrame } from '../../contracts/domain-models'
import type { SituationMapNode } from '../../features/situation/initial-nodes'
import { buildNodeLinkParameterRows } from '../../features/situation/node-comm-params'
import { FILE_COMMUNICATION_LABELS, type FileCommunicationLink } from '../../features/situation/file-communication-links'
import {
  FILE_MESSAGE_DIRECTION_LABELS,
  formatMessageDirectionLabel,
  readSingleMessageDirection,
  selectFileMessageLinks,
  type FileMessageLink,
} from '../../features/situation/file-message-links'
import type { LiveMessageFlowLane } from '../../features/situation/live-message-flows'
import { RAIN_TIER_RATES, readNaturalEnvironment } from '../../features/scenarios/link-calc-defaults'
import { fileJammerRadiusMeters, selectFileDeviceStates, type FileDeviceEvent } from '../../features/situation/file-device-events'
import { engineJammerNodes, interferenceRangeSource, selectDetectionRanges, selectInterferenceRanges, type ConfiguredJammerRange } from '../../features/situation/interference-ranges'
import {
  extractEngineMapStoryBanner,
  hasActiveFrameInterferenceOrDetection,
  selectActiveSwitchBatch,
  SWITCH_BANNER_RETENTION_SECONDS,
  switchEntryKey,
  type LinkCalcThresholds,
  type MapStoryItem,
  type MapStoryKind,
  type MapStoryTargetDetail,
} from '../../features/situation/engine-narrative'
import type { EngineSwitchEntry } from '../../features/situation/engine-route-highlights'
import { createNodeTrailTracker, replayNodeTrails, type NodeTrail } from '../../features/situation/node-trails'
import type { LocalReplaySnapshot } from '../../features/replays/local-replay'
import { reportTime } from '../../features/reports/local-report'
import {
  PLATFORM_TYPE_LABELS,
  type SituationLinkView,
} from '../../features/situation/situation-model'
import {
  createSituationMapController,
  type MapLayer,
  type ConfiguredLinkSwitchState,
  type SituationMapFocusTarget,
  type SituationMapController,
  type SituationMapLink,
} from './situation-map-controller'
import ScenarioMapEnvironment from './ScenarioMapEnvironment.vue'

const props = defineProps<{  /** 数据源更换只清理业务选择与详情，不销毁底图。 */
  sourceKey?: string
  viewportKey?: string
  frame: TelemetryFrame | null
  engineFrame?: EngineFrameSnapshot | null
  engineSourceLabel?: string
  trailSourceKey?: string
  positionReplay?: LocalReplaySnapshot | null
  initialNodes?: SituationMapNode[]
  /** 已登记的通信关联；只表示路由登记，不是已发生的业务。 */
  fileLinks?: FileCommunicationLink[]
  /** 由消息收发证据推导的业务链路；地图链路图层的实际内容。 */
  fileMessageLinks?: FileMessageLink[]
  fileDeviceEvents?: FileDeviceEvent[]
  fileTime?: number
  filePlaying?: boolean
  fileSpeed?: number
  fileSeekRevision?: number
  configuredLinks?: SituationMapLink[]
  focusLinks?: Link[]
  configuredScenario?: Pick<ScenarioConfig, 'platforms' | 'deviceParameters'> | null
  configuredLinkStatuses?: ReadonlyMap<string, 'UP' | 'DEGRADED' | 'DOWN'>
  configuredLinkSwitches?: ReadonlyMap<string, ConfiguredLinkSwitchState>
  latestSwitch?: EngineSwitchEntry | null
  recentSwitches?: readonly EngineSwitchEntry[]
  configuredJammers?: ConfiguredJammerRange[]
  configuredEnvironment?: Environment
  linkCalcThresholds?: LinkCalcThresholds
  liveMessageFlows?: LiveMessageFlowLane[]
  liveFlowPlaying?: boolean
  liveFlowKey?: string
  links: SituationLinkView[]
  selectNearbyLinks?: boolean
  separateLinkDirections?: boolean
  selectedNodeId: string
  focusTarget: SituationMapFocusTarget | null
}>()

function toggleFullscreen(): void {
  isFullscreen.value = !isFullscreen.value
  emit('fullscreen-change', isFullscreen.value)
}

const rainIcons = [
  { tier: 'none', label: '无雨', maximum: RAIN_TIER_RATES.none, drops: 0 },
  { tier: 'lightRain', label: '小雨', maximum: RAIN_TIER_RATES.lightRain, drops: 1 },
  { tier: 'moderateRain', label: '中雨', maximum: RAIN_TIER_RATES.moderateRain, drops: 2 },
  { tier: 'heavyRain', label: '大雨', maximum: RAIN_TIER_RATES.heavyRain, drops: 3 },
  { tier: 'stormRain', label: '暴雨', maximum: RAIN_TIER_RATES.stormRain, drops: 4 },
] as const
const rainIndicator = computed(() => {
  if (!props.configuredEnvironment) return null
  const { rainEnabled, rainRateMmPerHour } = readNaturalEnvironment(props.configuredEnvironment)
  if (!rainEnabled) return { ...rainIcons[0], description: '降雨模型关闭' }
  const icon = rainIcons.find(level => rainRateMmPerHour <= level.maximum) ?? rainIcons[4]
  return { ...icon, description: `${icon.label} · 降雨强度 ${rainRateMmPerHour} mm/h` }
})

const emit = defineEmits<{
  'select-node': [platformId: string]
  'select-link': [link: SituationLinkView]
  'select-configured-link': [link: Link, paired?: Link]
  'fullscreen-change': [value: boolean]
}>()

const mapContainer = ref<HTMLElement | null>(null)
const mapController = ref<SituationMapController | null>(null)
const moreLayersContainer = ref<HTMLElement | null>(null)
const moreLayersOpen = ref(false)
const isFullscreen = ref(false)
const PRIMARY_LAYERS: ReadonlyArray<readonly [MapLayer, string]> = [
  ['nodes', '节点'],
  ['links', '链路'],
  ['interference', '干扰范围'],
  ['detection', '探测范围'],
  ['trails', '运动轨迹'],
]
const MORE_LAYERS: ReadonlyArray<readonly [MapLayer, string]> = [
  ['grid', '经纬网'],
  ['flow', '流向动画'],
]
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
const filePlayback = computed(() => ({
  time: props.fileTime ?? 0,
  playing: !!props.filePlaying && !props.frame && !props.configuredLinks,
  speed: props.fileSpeed && Number.isFinite(props.fileSpeed) && props.fileSpeed > 0 ? props.fileSpeed : 1,
  key: `${props.sourceKey ?? ''}:${props.fileSeekRevision ?? 0}`,
}))
const selectedMessageLink = computed(() => visibleMessageLinks.value.find(link => link.id === selectedMessageLinkId.value))
const selectedMessageLinkDirectionLabel = computed(() => {
  const link = selectedMessageLink.value
  if (!link) return ''
  if (link.direction) return FILE_MESSAGE_DIRECTION_LABELS[link.direction]
  const dirs = new Set(link.records.map(record => readSingleMessageDirection(record.messageType)).filter(Boolean))
  return dirs.size > 1 ? '混合业务（见逐条方向）' : '业务方向未识别'
})
const hasFileLinks = computed(() => !props.frame && !props.configuredLinks && (props.fileLinks?.length ?? 0) > 0)
const hasFileMessageLinks = computed(() => visibleMessageLinks.value.length > 0)
const hasLiveMessageFlows = computed(() => !props.frame && !!props.configuredLinks && (props.liveMessageFlows?.length ?? 0) > 0)
const hasAnyFlowEvidence = computed(() => hasFileMessageLinks.value || hasLiveMessageFlows.value)
const hasFileInterference = computed(() => !props.frame && !props.configuredLinks
  && props.initialNodes?.some(node => fileJammerRadiusMeters(node.platformId, props.fileDeviceEvents ?? [], MAP_CONFIG.fileInterferenceRadiusMeters) !== undefined))
const nodes = computed(() => engineJammerNodes(props.frame?.platforms ?? props.initialNodes ?? [], props.engineFrame))
const fileDeviceStates = computed(() => !props.frame && !props.configuredLinks
  ? selectFileDeviceStates(props.fileDeviceEvents ?? [], props.fileTime ?? 0) : [])
const configuredRanges = computed(() => selectInterferenceRanges(nodes.value, props.frame, props.configuredJammers, fileDeviceStates.value, props.engineFrame))
const trackNodes = createNodeTrailTracker()
const liveTrails = ref<NodeTrail[]>([])
watch([nodes, () => props.frame?.simulationTime, () => JSON.stringify([props.sourceKey, props.trailSourceKey, props.frame?.runId,
  props.engineFrame?.runId, props.engineFrame?.engineEpoch, props.fileSeekRevision])], ([current, time, key]) => {
  liveTrails.value = trackNodes(key, props.positionReplay ? current.filter(node => node.positionSource === 'ENGINE') : current, time)
}, { immediate: true })
const nodeTrails = computed(() => props.positionReplay
  ? [...replayNodeTrails(props.positionReplay, props.fileTime ?? 0, nodes.value.filter(node => node.positionSource !== 'ENGINE')), ...liveTrails.value] : liveTrails.value)
const hasInterference = computed(() => props.frame !== null || configuredRanges.value.length > 0 || !!hasFileInterference.value)
const switchEvidenceByFrame = new Map<string, { links: EngineFrameSnapshot['links']; alarms: EngineFrameSnapshot['routing']['alarms']; events: EngineFrameSnapshot['events'] }>()
const retiredSwitchKeys = ref(new Set<string>())
let previousFrameLinks: EngineFrameSnapshot['links'] = []
let previousEngineTime: number | null = null
let hadActiveInterferenceOrDetection = false
watch([() => props.sourceKey, () => props.engineFrame?.runId, () => props.engineFrame?.engineEpoch, () => props.fileSeekRevision], () => {
  switchEvidenceByFrame.clear()
  retiredSwitchKeys.value = new Set()
  previousFrameLinks = []
  previousEngineTime = null
  hadActiveInterferenceOrDetection = false
})
watch(() => props.engineFrame, frame => {
  if (!frame) {
    previousEngineTime = null
    hadActiveInterferenceOrDetection = false
    return
  }
  if (previousEngineTime !== null && frame.simulationTime < previousEngineTime) {
    retiredSwitchKeys.value = new Set()
    hadActiveInterferenceOrDetection = false
  }
  if (frame.routing.switches.length) {
    // 切链帧有时不再包含已断开的旧链路，保留上一帧链路段作为补充，以便读取旧链路的实测距离与误码率。
    const seenIds = new Set(frame.links.map(seg => seg.linkId))
    const mergedLinks = [...frame.links, ...previousFrameLinks.filter(seg => !seenIds.has(seg.linkId))]
    for (const sw of frame.routing.switches) {
      switchEvidenceByFrame.set(`${frame.frameId}:${sw.pathId}`, {
        links: mergedLinks,
        alarms: frame.routing.alarms,
        events: frame.events,
      })
    }
    if (switchEvidenceByFrame.size > 40) {
      const firstKey = switchEvidenceByFrame.keys().next().value
      if (firstKey) switchEvidenceByFrame.delete(firstKey)
    }
  }
  const activeNow = hasActiveFrameInterferenceOrDetection(frame)
  const sourceSwitches = props.recentSwitches?.length
    ? props.recentSwitches
    : (props.latestSwitch ? [props.latestSwitch] : [])
  if (!activeNow && sourceSwitches.length) {
    const activeBatch = selectActiveSwitchBatch(sourceSwitches, frame.simulationTime, retiredSwitchKeys.value)
    const latest = activeBatch.at(-1) ?? null
    if (latest && latest.frameId !== frame.frameId) {
      const ageS = frame.simulationTime - latest.simulationTime
      if (hadActiveInterferenceOrDetection || ageS > SWITCH_BANNER_RETENTION_SECONDS) {
        const next = new Set(retiredSwitchKeys.value)
        let changed = false
        for (const entry of activeBatch) {
          const key = switchEntryKey(entry)
          if (!next.has(key)) {
            next.add(key)
            changed = true
          }
        }
        if (changed) retiredSwitchKeys.value = next
      }
    }
  }
  hadActiveInterferenceOrDetection = activeNow
  previousEngineTime = frame.simulationTime
  previousFrameLinks = frame.links
}, { immediate: true })
const mapStoryItems = computed<MapStoryItem[]>(() => {
  const frame = props.engineFrame
  const sourceSwitches = props.recentSwitches?.length
    ? props.recentSwitches
    : (props.latestSwitch ? [props.latestSwitch] : [])
  const activeBatch = frame ? selectActiveSwitchBatch(sourceSwitches, frame.simulationTime, retiredSwitchKeys.value) : []
  const latest = activeBatch.at(-1) ?? null
  const cachedEvidence = latest ? switchEvidenceByFrame.get(switchEntryKey(latest)) ?? null : null
  return extractEngineMapStoryBanner(
    frame,
    nodes.value,
    props.configuredLinks,
    props.linkCalcThresholds,
    latest,
    cachedEvidence,
    activeBatch,
    switchEvidenceByFrame,
  )
})
const storyBannerContainer = ref<HTMLElement | null>(null)
const expandedStoryKind = ref<MapStoryKind | null>(null)
function storyThresholdList(item: MapStoryItem): string[] {
  if (item.thresholds?.length) return item.thresholds
  return item.threshold ? [item.threshold] : []
}
function hasStoryDetails(item: MapStoryItem): boolean {
  return Boolean(item.targets?.length || storyThresholdList(item).length)
}
watch(mapStoryItems, items => {
  if (!expandedStoryKind.value) return
  const stillExpandable = items.some(item => item.kind === expandedStoryKind.value && hasStoryDetails(item))
  if (!stillExpandable) expandedStoryKind.value = null
})
function formatStoryTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}
function handleStoryClick(item: MapStoryItem): void {
  if (hasStoryDetails(item)) {
    expandedStoryKind.value = expandedStoryKind.value === item.kind ? null : item.kind
    return
  }
  if (item.focusTarget) focusTargetOnMap(item.focusTarget)
}
function handleStoryTargetClick(target: MapStoryTargetDetail): void {
  if (target.focusTarget) focusTargetOnMap(target.focusTarget)
  expandedStoryKind.value = null
}
function handleStoryLocateClick(item: MapStoryItem): void {
  if (item.focusTarget) focusTargetOnMap(item.focusTarget)
  expandedStoryKind.value = null
}
const detectionRanges = computed(() => selectDetectionRanges(nodes.value, props.frame, props.configuredJammers, props.engineFrame, props.configuredLinks))
const hasDetection = computed(() => detectionRanges.value.length > 0)
/** 节点图例列出当前地图上出现的全部类型（含文件参考模型名换算后的类型）；无法识别的类型合并为“其他节点”。 */
const nodeTypeLegend = computed(() => {
  const entries = new Map<string, { glyph: string; image?: string; label: string }>()
  for (const node of props.initialNodes ?? []) {
    const category = nodeCategory(node)
    const image = nodeIconUrl(node)
    const label = image === MAP_CONFIG.nodeTypeImages.TIANTONG ? '天通卫星'
      : image === MAP_CONFIG.nodeTypeImages.SHENTONG ? '神通卫星'
      : category ? PLATFORM_TYPE_LABELS[category as keyof typeof PLATFORM_TYPE_LABELS] ?? '其他节点' : '其他节点'
    const glyph = nodeGlyph(node)
    const key = image ?? glyph
    const previous = entries.get(key)
    entries.set(key, { glyph, image, label: previous && !previous.label.includes(label) ? previous.label + ' / ' + label : previous?.label ?? label })
  }
  return [...entries.values()]
})
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
  interference: hasInterference.value,
  grid: MAP_CONFIG.defaults.gridVisible,
  detection: true,
  trails: MAP_CONFIG.defaults.trailsVisible,
})

function fileEndpointLabel(platformId: string, includeId = true): string {
  const name = nodes.value.find(node => node.platformId === platformId)?.name
  return name && name !== platformId ? (includeId ? `${name}（${platformId}）` : name) : platformId
}

const selectedNode = computed(() => (
  nodes.value.find((platform) => platform.platformId === props.selectedNodeId)
  ?? nodes.value[0]
))
const selectedNodeFileLinks = computed(() => props.fileLinks?.filter(link =>
  link.sourcePlatformId === selectedNode.value?.platformId || link.targetPlatformId === selectedNode.value?.platformId) ?? [])
const selectedNodeMessageLinks = computed(() => visibleMessageLinks.value.filter(link =>
  link.sourcePlatformId === selectedNode.value?.platformId || link.targetPlatformId === selectedNode.value?.platformId))
const selectedNodeCommLinks = computed(() => selectedNode.value
  ? buildNodeLinkParameterRows({
      platformId: selectedNode.value.platformId,
      nodes: nodes.value,
      configuredLinks: props.configuredLinks,
      focusLinks: props.focusLinks,
      engineFrame: props.engineFrame,
      configuredScenario: props.configuredScenario,
    })
  : [])

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

/** 将米换算为公里并消除浮点尾差（如 14.999999999999998 -> 15）。 */
function formatRangeKm(meters: number): string {
  const km = Number((meters / 1000).toFixed(3))
  return String(Object.is(km, -0) ? 0 : km)
}

function rangeFieldLabel(kind: '干扰范围（半径）' | '探测范围（半径）', index: number, total: number): string {
  return total > 1 ? `干扰设备 ${index + 1} ${kind}` : kind
}

/**
 * 判断一个图层按钮是否不可用。
 * @param layer 节点、链路、登记关联、干扰范围或经纬网图层。
 * @returns 当前数据源没有任何内容可绘制时为 true。
 */
function layerDisabled(layer: MapLayer): boolean {
  if (layer === 'detection') return !hasDetection.value
  if (layer === 'flow') return !hasAnyFlowEvidence.value
  if (props.frame) return false
  if (layer === 'links') return !hasFileMessageLinks.value && !props.configuredLinks?.length
  if (layer === 'potential') return !hasFileLinks.value
  if (layer === 'interference') return !hasInterference.value
  return false
}
const selectedConfiguredRanges = computed(() => configuredRanges.value.filter(range => range.platformId === selectedNode.value?.platformId && (range.configured || range.sourceLabel)))
const selectedFileInterferenceRadius = computed(() => !props.frame && !props.configuredLinks
  ? configuredRanges.value.find(range => range.platformId === selectedNode.value?.platformId && !range.configured && !range.sourceLabel)?.radiusMeters : undefined)
const selectedDetectionRanges = computed(() => detectionRanges.value.filter(range => range.platformId === selectedNode.value?.platformId))
const selectedFileDevices = computed(() => fileDeviceStates.value.filter(event => event.platformId === selectedNode.value?.platformId))

function deviceStateLabel(event: FileDeviceEvent): string {
  return event.kind === 'JAMMING' ? (event.active ? '干扰请求进行中' : '干扰已停止') : (event.active ? '已开启' : '已关闭')
}

function communicationStateLabel(platformId: string, deviceId: string, includeEvidence = true): string {
  const event = fileDeviceStates.value.find(event => event.kind === 'COMMUNICATION' && event.platformId === platformId && event.deviceId === deviceId)
  if (!includeEvidence) return event ? deviceStateLabel(event) : '未知'
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

const selectedNodePositionMetadata = computed(() => {
  const node = selectedNode.value
  if (!node) return null
  const fromEngine = node.positionSource === 'ENGINE'
  const sourceFrame = fromEngine ? props.engineFrame : props.frame
  const time = node.time ?? sourceFrame?.simulationTime
  let source = '文件位置数据'
  if (fromEngine) source = props.engineSourceLabel ?? '引擎位置数据'
  else if (props.frame) source = '遥测帧'
  else if (props.configuredLinks) source = node.time === undefined ? '场景初始配置' : '本次运行位置记录'
  return { source, time, frameId: sourceFrame?.frameId }
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
watch(hasInterference, available => {
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

function handleDocumentOutsideClick(event: Event): void {
  const target = event.target
  if (moreLayersOpen.value && !(target instanceof Node && moreLayersContainer.value?.contains(target))) {
    moreLayersOpen.value = false
  }
  if (expandedStoryKind.value && !(target instanceof Node && storyBannerContainer.value?.contains(target))) {
    expandedStoryKind.value = null
  }
}

function handleDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    moreLayersOpen.value = false
    expandedStoryKind.value = null
    if (isFullscreen.value) {
      isFullscreen.value = false
      emit('fullscreen-change', false)
    }
  }
}

/**
 * 在组件挂载后创建 Leaflet 地图控制器。
 * @returns 无返回值。
 * @sideeffect 初始化地图、矢量瓦片和业务图层事件。
 */
onMounted(() => {
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', handleDocumentOutsideClick)
    document.addEventListener('click', handleDocumentOutsideClick)
    document.addEventListener('keydown', handleDocumentKeyDown)
  }
  if (!mapContainer.value) return

  mapController.value = createSituationMapController({
    container: mapContainer.value,
    viewportKey: props.viewportKey,
    frame: props.frame,
    engineFrame: props.engineFrame,
    nodeTrails: nodeTrails.value,
    initialNodes: props.initialNodes,
    fileLinks: props.fileLinks,
    fileMessageLinks: visibleMessageLinks.value,
    fileDeviceStates: fileDeviceStates.value,
    configuredLinks: props.configuredLinks,
    focusLinks: props.focusLinks,
    configuredLinkStatuses: props.configuredLinkStatuses,
    configuredLinkSwitches: props.configuredLinkSwitches,
    configuredJammers: props.configuredJammers,
    configuredEnvironment: props.configuredEnvironment,
    liveMessageFlows: props.liveMessageFlows,
    liveFlowPlaying: props.liveFlowPlaying,
    liveFlowKey: props.liveFlowKey,
    onSelectConfiguredLink: (...selection) => emit('select-configured-link', ...selection),
    onSelectFileLink: openFileLink,
    onSelectFileMessageLink: openMessageLink,
    selectNearbyLinks: props.selectNearbyLinks,
    separateLinkDirections: props.separateLinkDirections,
    links: props.links,
    selectedNodeId: props.selectedNodeId,
    onSelectNode: handleSelectNode,
    onSelectLink: handleSelectLink,
    onZoomChange: handleZoomChange,
  })
  mapController.value.setFilePlayback(filePlayback.value, props.fileMessageLinks ?? [])
  if (!layers.interference) mapController.value.setLayerVisible('interference', false)
  if (!layers.potential) mapController.value.setLayerVisible('potential', false)
  if (!layers.flow) mapController.value.setLayerVisible('flow', false)
  if (!layers.trails) mapController.value.setLayerVisible('trails', false)
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

watch(() => props.engineFrame, frame => mapController.value?.setEngineFrame(frame ?? null))
watch(nodeTrails, trails => mapController.value?.setNodeTrails(trails), { flush: 'post' })

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

// 消息/节点先同步，再提交播放时钟；同一时刻的重绘不会重复触发投递。
watch([filePlayback, visibleMessageLinks], () => {
  mapController.value?.setFilePlayback(filePlayback.value, props.fileMessageLinks ?? [])
}, { flush: 'post' })

watch(fileDeviceStates, states => {
  mapController.value?.setFileDeviceStates(states)
})

watch(() => props.viewportKey, key => mapController.value?.setViewportKey(key))

watch(() => props.configuredLinks, links => {
  mapController.value?.setConfiguredLinks(links)
})
watch(() => props.focusLinks, links => {
  mapController.value?.setFocusLinks?.(links ?? [])
})

watch(() => props.configuredLinkStatuses, statuses => {
  mapController.value?.setConfiguredLinkStatuses(statuses)
})

watch(() => props.configuredLinkSwitches, switches => {
  // 兼容旧地图控制器测试替身；实际控制器实现该可选增强接口。
  mapController.value?.setConfiguredLinkSwitches?.(switches)
})

watch(() => props.configuredJammers, jammers => {
  mapController.value?.setConfiguredJammers(jammers)
}, { deep: true })

watch(() => props.configuredEnvironment, environment => {
  mapController.value?.setConfiguredEnvironment(environment)
}, { deep: true })

watch([() => props.liveMessageFlows, () => props.liveFlowPlaying, () => props.liveFlowKey], ([flows, playing, runKey]) => {
  mapController.value?.setLiveMessageFlows?.(flows ?? [], { playing: playing !== false, runKey: runKey ?? '' })
})

watch(selectedFileLink, link => {
  if (!link) fileLinkDialogVisible.value = false
})

watch(() => props.sourceKey, () => {
  selectedNodeDialogVisible.value = false
  fileLinkDialogVisible.value = false
  messageLinkDialogVisible.value = false
  selectedFileLinkId.value = ''
  selectedMessageLinkId.value = ''
  mapController.value?.setSelectedNodeId(props.selectedNodeId)
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
  if (typeof document !== 'undefined') {
    document.removeEventListener('pointerdown', handleDocumentOutsideClick)
    document.removeEventListener('click', handleDocumentOutsideClick)
    document.removeEventListener('keydown', handleDocumentKeyDown)
  }
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
      :class="{ 'offline-map__canvas--nearby-links': selectNearbyLinks }"
      data-testid="leaflet-situation-map"
      role="application"
      :aria-label="frame ? `固定帧 ${frame.frameId} Leaflet 节点、链路和干扰态势图` : configuredLinks ? '所选场景初始位置与配置链路图' : '真实日志节点位置与通信关联图'"
    ></div>

    <div class="offline-map__topbar">
      <div
        v-if="rainIndicator"
        class="offline-map__rain-indicator"
        :data-rain-tier="rainIndicator.tier"
        :title="rainIndicator.description"
        :aria-label="rainIndicator.description"
        role="img"
        data-testid="scene-map-rain-indicator"
      >
        <div class="offline-map__rain-cloud" aria-hidden="true"></div>
        <div v-if="rainIndicator.drops" class="offline-map__rain-drops" aria-hidden="true">
          <i v-for="drop in rainIndicator.drops" :key="drop"></i>
        </div>
      </div>
      <slot name="topbar"></slot>
      <ScenarioMapEnvironment v-if="configuredEnvironment" :key="sourceKey" :environment="configuredEnvironment" />

      <div class="offline-map__layerbar" aria-label="态势图层">
        <button
          v-for="layer in PRIMARY_LAYERS"
          :key="layer[0]"
          type="button"
          :class="{ active: layers[layer[0]] }"
          :aria-pressed="layers[layer[0]]"
          :disabled="layerDisabled(layer[0])"
          @click="toggleLayer(layer[0])"
        >{{ layer[1] }}</button>
        <div ref="moreLayersContainer" class="offline-map__more-layers">
          <button
            type="button"
            class="offline-map__more-trigger"
            :class="{ active: moreLayersOpen }"
            aria-haspopup="true"
            :aria-expanded="moreLayersOpen"
            data-testid="more-layers-toggle"
            @click="moreLayersOpen = !moreLayersOpen"
          >更多图层</button>
          <div
            v-if="moreLayersOpen"
            class="offline-map__more-menu"
            role="group"
            aria-label="更多图层"
            data-testid="more-layers-menu"
          >
            <button
              v-for="layer in MORE_LAYERS"
              :key="layer[0]"
              type="button"
              :class="{ active: layers[layer[0]] }"
              :aria-pressed="layers[layer[0]]"
              :disabled="layerDisabled(layer[0])"
              @click="toggleLayer(layer[0])"
            >{{ layer[1] }}</button>
          </div>
        </div>
        <div class="offline-map__layer-status">
          <span>{{ basemap === 'vector' ? '离线矢量' : '离线卫星' }} · Z{{ zoom }}</span>
          <slot v-if="engineFrame && $slots['engine-source']" name="engine-source" />
          <span v-else-if="engineFrame" role="status" data-testid="engine-map-source">{{ engineSourceLabel ?? '引擎数据（状态未确认）' }} · 帧 {{ engineFrame.frameId }}</span>
        </div>
      </div>

      <div
        v-if="mapStoryItems.length"
        ref="storyBannerContainer"
        class="offline-map__story-banner"
        role="status"
        aria-live="polite"
        data-testid="map-story-banner"
      >
        <template v-for="(item, index) in mapStoryItems" :key="item.id">
          <span v-if="index > 0 && item.timeS >= mapStoryItems[index - 1]!.timeS" class="offline-map__story-arrow" aria-hidden="true">→</span>
          <div class="offline-map__story-item">
            <button
              type="button"
              class="offline-map__story-pill"
              :class="[`offline-map__story-pill--${item.kind.toLowerCase()}`, { 'offline-map__story-pill--stacked': Boolean(item.stacked || (item.kind === 'SWITCH' && item.detail)) }]"
              :disabled="!item.focusTarget && !hasStoryDetails(item)"
              :aria-expanded="hasStoryDetails(item) ? expandedStoryKind === item.kind : undefined"
              :title="[item.summary, item.threshold ?? '', item.detail].filter(Boolean).join(' · ')"
              @click="handleStoryClick(item)"
            >
              <span class="offline-map__story-main">
                <span class="offline-map__story-time">{{ formatStoryTime(item.timeS) }}</span>
                <strong class="offline-map__story-tag">{{ item.tag }}</strong>
                <span class="offline-map__story-summary">{{ item.summary }}</span>
                <span
                  v-if="hasStoryDetails(item)"
                  class="offline-map__story-more"
                  data-testid="map-story-more"
                >{{ expandedStoryKind === item.kind ? '收起 ▴' : '明细 ▾' }}</span>
              </span>
              <span v-if="item.detail" class="offline-map__story-detail">{{ item.detail }}</span>
            </button>
            <div
              v-if="hasStoryDetails(item) && expandedStoryKind === item.kind"
              class="offline-map__story-popover"
              :class="`offline-map__story-popover--${item.kind.toLowerCase()}`"
              role="region"
              :aria-label="`${item.tag}明细`"
              data-testid="map-story-popover"
            >
              <div class="offline-map__story-popover-head">
                <span>{{ item.tag }}明细<template v-if="item.targets?.length">（共 {{ item.targets.length }} 项）</template></span>
                <span class="offline-map__story-popover-actions">
                  <button
                    v-if="!item.targets?.length && item.focusTarget"
                    type="button"
                    class="offline-map__story-popover-locate"
                    @click.stop="handleStoryLocateClick(item)"
                  >定位</button>
                  <button
                    type="button"
                    class="offline-map__story-popover-close"
                    aria-label="收起明细"
                    @click.stop="expandedStoryKind = null"
                  >×</button>
                </span>
              </div>
              <div
                v-if="!item.targets?.length && storyThresholdList(item).length"
                class="offline-map__story-popover-section"
                data-testid="map-story-thresholds"
              >
                <span class="offline-map__story-popover-label">触发条件</span>
                <div class="offline-map__story-popover-thresholds">
                  <span
                    v-for="badge in storyThresholdList(item)"
                    :key="badge"
                    class="offline-map__story-threshold"
                    data-testid="map-story-threshold"
                  >{{ badge }}</span>
                </div>
              </div>
              <ul v-if="item.targets?.length" class="offline-map__story-popover-list">
                <li v-for="target in item.targets" :key="target.key">
                  <button
                    type="button"
                    class="offline-map__story-popover-row"
                    :disabled="!target.focusTarget"
                    @click.stop="handleStoryTargetClick(target)"
                  >
                    <span class="offline-map__story-popover-row-head">
                      <strong class="offline-map__story-popover-name">{{ target.name }}</strong>
                      <span v-if="target.badge" class="offline-map__story-popover-badge">{{ target.badge }}</span>
                    </span>
                    <span v-if="target.meta" class="offline-map__story-popover-meta">{{ target.meta }}</span>
                    <span
                      v-if="target.thresholds?.length"
                      class="offline-map__story-popover-row-thresholds"
                      data-testid="map-story-row-thresholds"
                    >
                      <span
                        v-for="badge in target.thresholds"
                        :key="badge"
                        class="offline-map__story-threshold"
                        data-testid="map-story-threshold"
                      >{{ badge }}</span>
                    </span>
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </template>
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
      <button
        type="button"
        :aria-label="isFullscreen ? '退出全屏' : '全屏放大'"
        :title="isFullscreen ? '退出全屏' : '全屏放大'"
        :aria-pressed="isFullscreen"
        data-testid="map-fullscreen-toggle"
        @click="toggleFullscreen"
      >
        <svg
          class="offline-map__control-icon"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          focusable="false"
        >
          <path
            :d="isFullscreen ? 'M9 4v5H4M15 20v-5h5M20 9h-5V4M4 15h5v5' : 'M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5'"
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
      :width="selectedNodeCommLinks.length ? 'min(58rem, calc(100vw - 2rem))' : 'min(38rem, calc(100vw - 2rem))'"
      top="5vh"
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
          <div><dt>{{ selectedNode.positionSource === 'ENGINE' ? '引擎位置' : frame ? '遥测位置' : '节点位置' }}</dt><dd>{{ Math.abs(selectedNode.longitude) }}°{{ selectedNode.longitude < 0 ? 'W' : 'E' }} / {{ Math.abs(selectedNode.latitude) }}°{{ selectedNode.latitude < 0 ? 'S' : 'N' }}</dd></div>
          <div v-if="usesTemporarySatellitePosition"><dt>地图临时示意位置</dt><dd>{{ Math.abs(selectedNodePosition.longitude) }}°{{ selectedNodePosition.longitude < 0 ? 'W' : 'E' }} / {{ Math.abs(selectedNodePosition.latitude) }}°{{ selectedNodePosition.latitude < 0 ? 'S' : 'N' }}</dd></div>
          <div><dt>高度</dt><dd>{{ selectedNode.altitude }} m</dd></div>
          <div><dt>速度</dt><dd>{{ configuredLinks && !('time' in selectedNode) ? '暂无运行数据' : `${selectedNode.speed} m/s` }}</dd></div>
          <template v-if="selectedNodePositionMetadata">
            <div><dt>位置数据来源</dt><dd>{{ selectedNodePositionMetadata.source }}</dd></div>
            <div><dt>位置仿真时刻</dt><dd>{{ selectedNodePositionMetadata.time === undefined ? '暂无数据' : reportTime(selectedNodePositionMetadata.time) }}</dd></div>
            <div v-if="selectedNodePositionMetadata.frameId !== undefined"><dt>位置来源帧</dt><dd>{{ selectedNodePositionMetadata.frameId }}</dd></div>
          </template>
          <div v-for="(range, index) in selectedConfiguredRanges" :key="range.id" data-testid="configured-jammer-range"><dt>{{ rangeFieldLabel('干扰范围（半径）', index, selectedConfiguredRanges.length) }}</dt><dd>{{ formatRangeKm(range.radiusMeters) }} 公里（{{ interferenceRangeSource(range) }}）</dd></div>
          <div v-if="selectedFileInterferenceRadius !== undefined"><dt>干扰范围（半径）</dt><dd>{{ formatRangeKm(selectedFileInterferenceRadius) }} 公里（示意范围，缺少设备配置）</dd></div>
          <div v-for="(range, index) in selectedDetectionRanges" :key="range.id" data-testid="configured-detection-range"><dt>{{ rangeFieldLabel('探测范围（半径）', index, selectedDetectionRanges.length) }}</dt><dd>{{ formatRangeKm(range.radiusMeters) }} 公里（{{ range.sourceLabel }}）</dd></div>
        </dl>
        <section v-if="selectedNodeCommLinks.length" class="selected-node-dialog__section" data-testid="node-comm-params">
          <h4 class="selected-node-dialog__section-title">通信节点参数</h4>
          <el-table :data="selectedNodeCommLinks" max-height="260" size="small">
            <el-table-column label="链路 / 对端" min-width="200">
              <template #default="{ row }">
                <div class="node-comm-link-cell">
                  <strong>{{ row.typeLabel }}（{{ row.directionLabel }} · {{ row.roleLabel }}）</strong>
                  <span>{{ row.peerLabel }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="txPowerText" label="功率" min-width="84" />
            <el-table-column prop="antennaGainText" label="天线增益" min-width="140" />
            <el-table-column prop="distanceText" label="通信距离" min-width="136" />
            <el-table-column prop="antiJammingGainText" label="波形抗干扰增益" min-width="116" />
            <el-table-column prop="spatialIsolationText" label="空域隔离大小" min-width="106" />
          </el-table>
        </section>
        <template v-if="!frame && !configuredLinks">
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
          <p v-else data-testid="file-device-empty" class="selected-node-dialog__empty">设备事件：暂无数据</p>
          <template v-if="selectedNodeMessageLinks.length">
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
            <el-table :data="selectedNodeFileLinks" max-height="240" data-testid="node-file-associations">
              <el-table-column label="登记关联" min-width="240">
                <template #default="{ row }">{{ FILE_COMMUNICATION_LABELS[row.type as keyof typeof FILE_COMMUNICATION_LABELS] }} · {{ fileEndpointLabel(row.sourcePlatformId) }} — {{ fileEndpointLabel(row.targetPlatformId) }}</template>
              </el-table-column>
              <el-table-column label="明细" width="85">
                <template #default="{ row }"><el-button link type="primary" @click="openFileLink(row)">查看</el-button></template>
              </el-table-column>
            </el-table>
          </template>
        </template>
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
          <div><dt>业务方向</dt><dd>{{ selectedMessageLinkDirectionLabel }}</dd></div>
          <div><dt>投递时延中位</dt><dd>{{ formatDelay(selectedMessageLink.medianDelayS) }}</dd></div>
        </dl>
        <el-table :data="selectedMessageLink.records" max-height="320">
          <el-table-column label="接收时刻（秒）" prop="time" width="130" />
          <el-table-column label="发送端" min-width="200">
            <template #default="{ row }">{{ fileEndpointLabel(row.source.platformName) }} / {{ row.source.communicationName }}</template>
          </el-table-column>
          <el-table-column label="接收端" min-width="200">
            <template #default="{ row }">{{ fileEndpointLabel(row.target.platformName) }} / {{ row.target.communicationName }}</template>
          </el-table-column>
          <el-table-column label="业务类型" prop="messageType" width="130" />
          <el-table-column label="业务方向" width="120">
            <template #default="{ row }">{{ formatMessageDirectionLabel(readSingleMessageDirection(row.messageType)) }}</template>
          </el-table-column>
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
        <el-table :data="selectedFileLink.records" max-height="340">
          <el-table-column type="expand" label="详情" width="60">
            <template #default="{ row }">
              <el-descriptions class="file-association-evidence" data-testid="file-association-evidence" :column="1" border>
                <el-descriptions-item label="源节点编号">{{ row.source.platformName }}</el-descriptions-item>
                <el-descriptions-item label="源端设备编号">{{ row.source.communicationName }}</el-descriptions-item>
                <el-descriptions-item label="源端设备类型">{{ row.sourceType }}</el-descriptions-item>
                <el-descriptions-item label="源端通信地址">{{ row.source.address }}</el-descriptions-item>
                <el-descriptions-item label="源端启停依据">{{ communicationStateLabel(row.source.platformName, row.source.communicationName) }}</el-descriptions-item>
                <el-descriptions-item label="目标节点编号">{{ row.target.platformName }}</el-descriptions-item>
                <el-descriptions-item label="目标端设备编号">{{ row.target.communicationName }}</el-descriptions-item>
                <el-descriptions-item label="目标端设备类型">{{ row.targetType }}</el-descriptions-item>
                <el-descriptions-item label="目标端通信地址">{{ row.target.address }}</el-descriptions-item>
                <el-descriptions-item label="目标端启停依据">{{ communicationStateLabel(row.target.platformName, row.target.communicationName) }}</el-descriptions-item>
                <el-descriptions-item label="登记时间（秒）">{{ row.time }}</el-descriptions-item>
                <el-descriptions-item label="源记录">{{ row.sourceEventId }}</el-descriptions-item>
              </el-descriptions>
            </template>
          </el-table-column>
          <el-table-column label="源节点" min-width="120">
            <template #default="{ row }">{{ fileEndpointLabel(row.source.platformName, false) }}</template>
          </el-table-column>
          <el-table-column label="目标节点" min-width="120">
            <template #default="{ row }">{{ fileEndpointLabel(row.target.platformName, false) }}</template>
          </el-table-column>
          <el-table-column label="通信类型" min-width="130">
            <template #default>{{ FILE_COMMUNICATION_LABELS[selectedFileLink.type] }}</template>
          </el-table-column>
          <el-table-column label="源端设备" min-width="100">
            <template #default="{ row }">{{ communicationStateLabel(row.source.platformName, row.source.communicationName, false) }}</template>
          </el-table-column>
          <el-table-column label="目标端设备" min-width="100">
            <template #default="{ row }">{{ communicationStateLabel(row.target.platformName, row.target.communicationName, false) }}</template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>

    <div class="offline-map__legend">
      <div v-if="nodeTypeLegend.length" class="offline-map__legend-group" aria-label="节点类型图例" data-testid="node-type-legend">
        <div v-for="item in nodeTypeLegend" :key="item.image ?? item.glyph"><span class="legend-glyph" aria-hidden="true"><img v-if="item.image" :src="item.image" alt="" /> <template v-else>{{ item.glyph }}</template></span>{{ item.label }}</div>
      </div>
      <div class="offline-map__legend-group" aria-label="链路类型图例">
      <div><i class="legend-line legend-line--satellite"></i>卫星链路</div>
      <div><i class="legend-line legend-line--microwave"></i>微波链路</div>
      <div><i class="legend-line legend-line--datalink"></i>新一代数传链路</div>
      <div><i class="legend-line legend-line--laser"></i>激光链路</div>
      <div><i class="legend-line legend-line--unavailable"></i>受干扰 / 失效链路</div>
      <div><i class="legend-line legend-line--fiber"></i>光纤链路</div>
      <div v-if="hasFileMessageLinks"><i class="legend-arrow" aria-hidden="true">▲</i>消息投递方向</div>
      <div v-if="hasDetection"><i class="legend-line legend-line--detection"></i>探测范围</div>
      </div>
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

.offline-map__canvas :deep(.leaflet-tooltip.scenario-sea-label) {
  border: 1px solid rgba(57, 207, 200, 0.5);
  color: #9ceeea;
  background: rgba(7, 32, 39, 0.9);
  box-shadow: none;
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

.offline-map__layer-status {
  display: contents;
}

.offline-map__rain-indicator {
  box-sizing: border-box;
  display: grid;
  place-content: center;
  justify-items: center;
  flex: 0 0 auto;
  pointer-events: auto;
  gap: 0.2rem;
  width: 1.8rem;
  height: 1.65rem;
  padding-top: 0.25rem;
  border: 1px solid var(--console-border);
  border-radius: 4px;
  color: var(--console-cyan);
  background: var(--console-bg-elevated);
}

.offline-map__rain-indicator[data-rain-tier='none'] { color: var(--console-text-muted); }

.offline-map__rain-cloud {
  position: relative;
  display: block;
  width: 1.06rem;
  height: 0.4rem;
  border-radius: 0.4rem;
  background: currentColor;
}

.offline-map__rain-cloud::before,
.offline-map__rain-cloud::after {
  position: absolute;
  border-radius: 50%;
  background: currentColor;
  content: '';
}

.offline-map__rain-cloud::before { left: 0.14rem; bottom: 0.08rem; width: 0.6rem; height: 0.6rem; }
.offline-map__rain-cloud::after { right: 0.08rem; bottom: 0.1rem; width: 0.37rem; height: 0.37rem; }
.offline-map__rain-drops { display: flex; gap: 0.13rem; }
.offline-map__rain-drops i { width: 0.11rem; height: 0.3rem; border-radius: 0.1rem; background: currentColor; transform: rotate(24deg); }

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

.offline-map__layerbar button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.offline-map__more-layers {
  position: relative;
  display: inline-flex;
}

.offline-map__more-menu {
  position: absolute;
  top: calc(100% + 0.25rem);
  right: 0;
  z-index: 1005;
  display: grid;
  min-width: max-content;
  gap: 0.25rem;
  padding: 0.25rem;
  border: 1px solid var(--console-border);
  border-radius: 5px;
  background: rgba(7, 21, 34, 0.96);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
}

.offline-map__more-menu button {
  width: 100%;
  text-align: left;
  white-space: nowrap;
}

.offline-map__layerbar span {
  margin-left: 0.25rem;
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

:global(.el-dialog.selected-node-dialog) {
  display: flex;
  flex-direction: column;
  max-height: 90vh;
  margin-bottom: 0;
  overflow: hidden;
}

:global(.selected-node-dialog > .el-dialog__header) {
  flex-shrink: 0;
}

:global(.selected-node-dialog > .el-dialog__body) {
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.selected-node-dialog__body {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}

.selected-node-dialog__empty {
  margin: 0;
  color: var(--console-text-muted);
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
  overflow-wrap: anywhere;
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

.selected-node-dialog__section {
  display: grid;
  gap: 0.4rem;
  min-width: 0;
}

.selected-node-dialog__section-title {
  margin: 0;
  color: var(--console-text);
  font-size: var(--console-font-size-min);
  font-weight: 600;
}

.node-comm-link-cell {
  display: grid;
  gap: 0.1rem;
  line-height: 1.35;
}

.node-comm-link-cell strong {
  color: var(--console-text);
  font-weight: 600;
}

.node-comm-link-cell span {
  color: var(--console-text-muted);
  font-size: 0.75rem;
}

.file-association-evidence {
  margin: 0.5rem 1rem;
  overflow-wrap: anywhere;
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

.offline-map__legend {
  display: flex;
  align-items: flex-end;
  gap: 1rem;
}

.offline-map__legend-group > div {
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

.legend-line--detection {
  border-color: #f5c542;
  border-top-style: dashed;
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
  height: 3px;
  border: 0;
  background: repeating-linear-gradient(to right, #b37feb 0 12px, transparent 12px 16px, #b37feb 16px 18px, transparent 18px 22px);
}

.legend-line--unavailable {
  border-color: #f56c6c;
}

.legend-line--fiber {
  border-color: #20b2aa;
}

.legend-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.625rem;
  color: #42d8ff;
  font-size: 0.85rem;
  font-style: normal;
  text-align: center;
}

.legend-glyph img { width: 26px; height: 26px; object-fit: contain; filter: drop-shadow(0 0 1px #42d8ff); }

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

/**
 * 单颗流星：一批新消息触发一次，尾迹离开终点后停住，不作无限循环。
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
  animation-iteration-count: 1;
  animation-fill-mode: both;
  animation-duration: 1.4s;
  pointer-events: none;
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

:deep(.situation-map-link-tooltip) {
  display: block;
  width: max-content;
  max-width: min(24rem, calc(100vw - 2rem));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.55;
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

.offline-map__canvas--nearby-links :deep(.situation-map-node-marker) {
  pointer-events: none;
}

.offline-map__canvas--nearby-links :deep(.situation-map-node__glyph),
.offline-map__canvas--nearby-links :deep(.situation-map-node__name),
.offline-map__canvas--nearby-links :deep(.situation-map-node__id) {
  pointer-events: auto;
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

:deep(.situation-map-interference--selected) {
  filter: drop-shadow(0 0 4px #f5b942) drop-shadow(0 0 8px rgba(245, 185, 66, 0.9));
}

:deep(.situation-map-interference--active) {
  filter: drop-shadow(0 0 6px rgba(255, 59, 92, 0.85));
  animation: situation-jam-circle-pulse 2s ease-in-out infinite;
}

:deep(.situation-map-detection--active) {
  filter: drop-shadow(0 0 5px rgba(245, 197, 66, 0.72));
}

:deep(.situation-map-jammer-pulse) {
  pointer-events: none;
}

:deep(.situation-map-jammer-pulse__ring) {
  position: absolute;
  top: 0;
  left: 0;
  width: 24px;
  height: 24px;
  border: 2px solid #ff3b5c;
  border-radius: 50%;
  transform: translate(-50%, -50%) scale(0.7);
  opacity: 0;
  animation: situation-jam-ripple 2.1s cubic-bezier(0.2, 0.7, 0.3, 1) infinite;
}

:deep(.situation-map-jammer-pulse__ring--b) {
  animation-delay: 1.05s;
}

:deep(.situation-map-jammer-pulse__ring--detect) {
  border-color: #f5c542;
  animation-duration: 2.6s;
}

:deep(.situation-map-jammer-pulse__tag) {
  position: absolute;
  top: -32px;
  left: 0;
  padding: 1px 7px;
  border: 1px solid rgba(255, 120, 140, 0.9);
  border-radius: 999px;
  color: #fff;
  background: rgba(196, 29, 58, 0.92);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  transform: translateX(-50%);
  box-shadow: 0 2px 8px rgba(196, 29, 58, 0.5);
}

:deep(.situation-map-jammer-pulse__tag--detect) {
  border-color: rgba(245, 197, 66, 0.92);
  color: #fff8e6;
  background: rgba(176, 110, 12, 0.94);
  box-shadow: 0 2px 8px rgba(176, 110, 12, 0.45);
}

:deep(.situation-map-jammer-pulse__tag--off) {
  border-color: rgba(155, 184, 206, 0.78);
  color: #e3eef6;
  background: rgba(34, 52, 68, 0.92);
  box-shadow: 0 2px 8px rgba(9, 18, 28, 0.45);
}

:deep(.situation-map-jamming-beam) {
  filter: drop-shadow(0 0 4px rgba(255, 59, 92, 0.85));
  animation: situation-jam-beam-flow 1.1s linear infinite;
}

/* 用户主动选中的链路保留独立的选中效果。 */
:deep(.situation-map-link--selected) {
  stroke: color-mix(in srgb, var(--situation-link-color) 75%, white);
  filter: drop-shadow(0 0 3px color-mix(in srgb, var(--situation-link-color) 65%, transparent))
    drop-shadow(0 0 7px color-mix(in srgb, var(--situation-link-color) 35%, transparent));
}

:deep(.situation-map-link-badge-wrap) {
  pointer-events: none;
}

:deep(.situation-map-link-badge) {
  position: absolute;
  top: 0;
  left: 0;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.35;
  white-space: nowrap;
  transform: translate(-50%, -135%);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
}

:deep(.situation-map-link-badge--down) {
  color: #fff;
  background: rgba(139, 21, 21, 0.94);
  border: 1px solid #ff7875;
}

:deep(.situation-map-link-badge--degraded) {
  color: #ffda91;
  background: #47351d;
  border: 1px solid #bf914e;
}

:deep(.situation-map-link-badge--switch-before) {
  color: #d8e4ec;
  background: #223342;
  border: 1px solid #8196a5;
}

:deep(.situation-map-link-badge--switch-after) {
  color: #06212c;
  background: rgba(72, 236, 255, 0.95);
  border: 1px solid #d6fbff;
}

.offline-map__story-banner {
  flex: 1 0 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px;
  pointer-events: none;
}

.offline-map__story-item {
  position: relative;
  display: inline-flex;
  max-width: 100%;
  pointer-events: auto;
}

.offline-map__story-arrow {
  color: #8cecff;
  font-weight: 700;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.7);
}

.offline-map__story-pill {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  max-width: 100%;
  padding: 5px 11px;
  border: 1px solid transparent;
  border-radius: 12px;
  color: #f4f9ff;
  font-size: 12px;
  line-height: 1.35;
  text-align: left;
  cursor: pointer;
  pointer-events: auto;
  backdrop-filter: blur(6px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
}

.offline-map__story-pill--stacked {
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}

.offline-map__story-main {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}

.offline-map__story-pill:disabled {
  cursor: default;
}

.offline-map__story-pill--detect {
  background: rgba(120, 74, 12, 0.9);
  border-color: rgba(245, 185, 66, 0.85);
}

.offline-map__story-pill--jammed {
  background: rgba(145, 22, 42, 0.92);
  border-color: rgba(255, 99, 122, 0.9);
}

.offline-map__story-pill--jam_off {
  background: rgba(34, 52, 68, 0.92);
  border-color: rgba(155, 184, 206, 0.8);
}

.offline-map__story-pill--switch {
  background: rgba(10, 92, 108, 0.92);
  border-color: rgba(72, 236, 255, 0.9);
}

.offline-map__story-time {
  font-family: Consolas, "SFMono-Regular", monospace;
  opacity: 0.85;
}

.offline-map__story-tag {
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.25);
  font-size: 11px;
}

.offline-map__story-threshold {
  padding: 1px 6px;
  border: 1px solid rgba(255, 216, 138, 0.55);
  border-radius: 4px;
  background: rgba(255, 196, 61, 0.22);
  color: #ffe39b;
  font-family: Consolas, "Microsoft YaHei", monospace;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.offline-map__story-detail {
  opacity: 0.85;
  font-size: 11px;
}

.offline-map__story-more {
  margin-left: 2px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.offline-map__story-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 1020;
  width: max-content;
  min-width: 240px;
  max-width: min(440px, 82vw);
  border: 1px solid rgba(155, 184, 206, 0.55);
  border-radius: 10px;
  background: rgba(11, 22, 34, 0.96);
  color: #eef6ff;
  backdrop-filter: blur(8px);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.offline-map__story-popover--jammed {
  border-color: rgba(255, 99, 122, 0.78);
}

.offline-map__story-popover--detect {
  border-color: rgba(245, 185, 66, 0.78);
}

.offline-map__story-popover--switch {
  border-color: rgba(72, 236, 255, 0.78);
}

.offline-map__story-popover--jam_off {
  border-color: rgba(155, 184, 206, 0.72);
}

.offline-map__story-popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 11px;
  font-weight: 600;
  color: #cfe4f7;
}

.offline-map__story-popover-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.offline-map__story-popover-locate {
  border: 1px solid rgba(140, 236, 255, 0.45);
  border-radius: 4px;
  padding: 1px 6px;
  background: rgba(72, 236, 255, 0.12);
  color: #9beeff;
  font-size: 11px;
  cursor: pointer;
}

.offline-map__story-popover-locate:hover {
  background: rgba(72, 236, 255, 0.22);
}

.offline-map__story-popover-section {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.offline-map__story-popover-label {
  font-size: 11px;
  color: rgba(207, 228, 247, 0.78);
}

.offline-map__story-popover-thresholds {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.offline-map__story-popover-close {
  border: 0;
  padding: 0 4px;
  background: transparent;
  color: #cfe4f7;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.offline-map__story-popover-close:hover {
  color: #fff;
}

.offline-map__story-popover-list {
  margin: 0;
  padding: 4px;
  list-style: none;
  max-height: 260px;
  overflow-y: auto;
}

.offline-map__story-popover-row {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.offline-map__story-popover-list > li + li {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  margin-top: 2px;
  padding-top: 2px;
}

.offline-map__story-popover-row-thresholds {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.offline-map__story-popover-row:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
}

.offline-map__story-popover-row:disabled {
  cursor: default;
}

.offline-map__story-popover-row-head {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.offline-map__story-popover-name {
  font-size: 12px;
  font-weight: 600;
}

.offline-map__story-popover-badge {
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.12);
  font-family: Consolas, "SFMono-Regular", monospace;
  font-size: 11px;
  color: #ffe39b;
  white-space: nowrap;
}

.offline-map__story-popover-meta {
  font-size: 11px;
  color: rgba(226, 240, 252, 0.8);
  font-family: Consolas, "Microsoft YaHei", monospace;
}

@keyframes situation-jam-ripple {
  0% {
    transform: translate(-50%, -50%) scale(0.7);
    opacity: 0.92;
  }
  100% {
    transform: translate(-50%, -50%) scale(3.4);
    opacity: 0;
  }
}

@keyframes situation-jam-circle-pulse {
  0%, 100% { fill-opacity: 0.14; }
  50% { fill-opacity: 0.24; }
}

@keyframes situation-jam-beam-flow {
  from { stroke-dashoffset: 32; }
  to { stroke-dashoffset: 0; }
}

@media (prefers-reduced-motion: reduce) {
  :deep(.situation-map-interference--active),
  :deep(.situation-map-jammer-pulse__ring),
  :deep(.situation-map-jamming-beam) {
    animation: none;
  }
}

:deep(.situation-map-node__glyph) {
  text-shadow: 0 0 6px currentColor;
}

:deep(.situation-map-node--image .situation-map-node__glyph) {
  display: flex;
  width: 48px;
  height: 48px;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
}

:deep(.situation-map-node--image .situation-map-node__image) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  filter: drop-shadow(0 0 2px currentColor);
  pointer-events: none;
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

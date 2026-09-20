<script setup lang="ts">
import { apiFetch } from '../../features/shared/api-fetch'

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { MAP_CONFIG } from '../../config/map.config'
import type { DetectionEvent, Link, SimulationMode, SwitchEvent, UiSimulationStatus } from '../../contracts/domain-models'
import LinkCandidatePanel from '../../components/situation/LinkCandidatePanel.vue'
import LinkQualityDialog from '../../components/situation/LinkQualityDialog.vue'
import LinkStateBadge from '../../components/situation/LinkStateBadge.vue'
import MetricPanel from '../../components/situation/MetricPanel.vue'
import OfflineSituationMap from '../../components/situation/OfflineSituationMap.vue'
import SimulationToolbar from '../../components/situation/SimulationToolbar.vue'
import SavedScenePreview from '../../components/situation/SavedScenePreview.vue'
import type { SituationMapFocusTarget } from '../../components/situation/situation-map-controller'
import {
  LINK_TYPE_LABELS,
  JAMMER_TYPE_LABELS,
  PLATFORM_TYPE_LABELS,
  formatBer,
  formatSimulationTime,
  getJammerTypeLabel,
  getPlatformName,
  selectSituationLinks,
  selectSituationMetrics,
  type SituationLinkView,
} from '../../features/situation/situation-model'
import { useSimulationStore } from '../../stores/simulation'
import { useTelemetryStore } from '../../stores/telemetry'
import { resolveMockOrigin, useAuthStore } from '../../stores/auth'
import { isInitialNodeSnapshot, type InitialNodeSnapshot } from '../../features/situation/initial-nodes'
import { selectFileCommunicationLinks, FILE_COMMUNICATION_LABELS } from '../../features/situation/file-communication-links'
import { fileLinkDeviceStatus, selectFileDeviceStates } from '../../features/situation/file-device-events'
import { selectReplayNodes } from '../../features/replays/local-replay'
import { useReplayStore } from '../../stores/replay'
import { readLinkEnabled } from '../../features/scenarios/link-settings'

type SummaryTab = 'nodes' | 'links' | 'interference' | 'timing'

const BUSINESS_NODE_CAPACITY = 50
// 用户约定的展示名称；底层仍保留设备证据，不据此推断切换或干扰。
const FILE_LINK_STATUS_LABELS = { 开启: '正常', 关闭: '切换', 未知: '干扰' } as const
const BUSINESS_NODE_TYPES = new Set([
  'REAR_COMMAND_NODE', 'FORWARD_RELAY_NODE', 'GROUND_CLUSTER_COMMAND_NODE', 'AIRBORNE_MISSION_CLUSTER',
])
const summaryTabs: ReadonlyArray<{ key: SummaryTab; label: string }> = [
  { key: 'nodes', label: '节点' },
  { key: 'links', label: '链路' },
  { key: 'interference', label: '干扰' },
  { key: 'timing', label: '时序' },
]

const activeTab = ref<SummaryTab>('nodes')
const simulationStore = useSimulationStore()
const filePlayback = useReplayStore()
const fileLoading = ref(false)
const ownsFilePlayback = ref(false)
const selectedScene = computed(() => sourceState.value === 'SCENE' ? simulationStore.selectedScene : null)
const savedNodeGroups = computed(() => [
  { title: '信息节点', platforms: selectedScene.value?.config.platforms.filter(platform => BUSINESS_NODE_TYPES.has(platform.type)) ?? [] },
  { title: '支撑实体', platforms: selectedScene.value?.config.platforms.filter(platform => !BUSINESS_NODE_TYPES.has(platform.type)) ?? [] },
])
const otherSceneRun = computed(() => selectedScene.value && simulationStore.run?.scenarioId !== selectedScene.value.config.scenario.id)
const telemetryStore = useTelemetryStore()
const {
  run: simulationRun,
  uiStatus: simulationStatus,
  currentTime: simulationTime,
  speedMultiplier: simulationSpeed,
  mode: simulationMode,
  capabilityState: simulationCapabilityState,
  resultMessage: simulationFeedback,
  pending: simulationPending,
} = storeToRefs(simulationStore)
const {
  frame: mockFrame,
  events,
  capabilityState: telemetryCapabilityState,
  connectionState,
  resultMessage: telemetryFeedback,
} = storeToRefs(telemetryStore)
const stopDialogVisible = ref(false)
const selectedNodeId = ref('')
const selectedLinkId = ref('')
const linkDialogVisible = ref(false)
const candidatePanelVisible = ref(false)
const sceneSummaryCollapsed = ref(false)
const telemetryPanelCollapsed = ref(false)
const mapFocusTarget = ref<SituationMapFocusTarget | null>(null)
let unmounted = false
const sourceState = ref<'LOADING' | 'MOCK' | 'FILE' | 'SCENE' | 'ERROR'>('LOADING')
let sourceEpoch = 0
let sourceRequest: AbortController | null = null
const initialSnapshot = ref<InitialNodeSnapshot | null>(null)
// 文件播放复用回放游标，位置、关联和设备事件使用同一时刻，不混用引擎时钟。
const fileTime = computed(() => ownsFilePlayback.value && filePlayback.localSnapshot ? filePlayback.replay?.currentTimeS ?? 0 : 0)
const fileNodes = computed(() => ownsFilePlayback.value && filePlayback.localSnapshot
  ? selectReplayNodes(filePlayback.localSnapshot, fileTime.value) : initialSnapshot.value?.nodes.filter(node => node.time <= 0) ?? [])
const fileLinks = computed(() => selectFileCommunicationLinks(initialSnapshot.value?.connections ?? [], fileTime.value))
const fileMessageLinks = computed(() => initialSnapshot.value?.messageLinks ?? [])
const fileStatus = computed<UiSimulationStatus>(() => !ownsFilePlayback.value || !filePlayback.localSnapshot ? 'STOPPED'
  : filePlayback.state === 'PLAYING' ? 'RUNNING' : filePlayback.state === 'COMPLETED' ? 'COMPLETED' : 'PAUSED')
const fileSliderTime = ref(0)
const fileSliderDragging = ref(false)
watch(fileTime, time => { if (!fileSliderDragging.value) fileSliderTime.value = time })
function fileTimeLabel(time: number): string {
  return `${Math.floor(time / 60)}分${Math.floor(time % 60)}秒`
}
async function seekFileTime(time: number | number[]): Promise<void> {
  if (typeof time === 'number') await filePlayback.seek(time)
  fileSliderDragging.value = false
  fileSliderTime.value = fileTime.value
}
const sourceMessage = ref('正在读取初始节点位置。')
// 同一时刻只使用一种数据源，不把文件坐标与 Mock 链路、事件混合。
const frame = computed(() => !selectedScene.value && sourceState.value === 'MOCK' ? mockFrame.value : null)

/** 按本机配置加载初始位置；未配置时保留原有 Mock 流程，读取失败不回退假数据。 */
async function initializeSituation(): Promise<void> {
  const epoch = ++sourceEpoch
  if (ownsFilePlayback.value) filePlayback.resetToSafeEmpty()
  ownsFilePlayback.value = false
  fileLoading.value = false
  fileSliderDragging.value = false
  fileSliderTime.value = 0
  sourceRequest?.abort()
  const request = new AbortController()
  sourceRequest = request
  const sceneId = simulationStore.selectedScene?.config.scenario.id ?? simulationStore.readSelectedSceneId()
  if (sceneId) {
    initialSnapshot.value = null
    telemetryStore.disconnectAndReset()
    sourceState.value = 'LOADING'
    sourceMessage.value = '正在恢复所选场景。'
    const sessionEpoch = simulationStore.requestEpoch
    const loaded = await simulationStore.selectScene(sceneId, request.signal)
    if (unmounted || epoch !== sourceEpoch || sessionEpoch !== simulationStore.requestEpoch) return
    if (!loaded) {
      sourceState.value = 'ERROR'
      sourceMessage.value = `场景 ${sceneId} 加载失败：${simulationStore.resultMessage}`
      return
    }
    sourceState.value = 'SCENE'
    sourceMessage.value = '已保存场景配置预览；未接入真实求解引擎。'
    return
  }
  sourceState.value = 'LOADING'
  sourceMessage.value = '正在读取初始节点位置。'
  try {
    const response = await apiFetch(`${resolveMockOrigin()}/api/v1/situation/initial-nodes`, {
      headers: { 'X-Demo-Role': useAuthStore().role },
      signal: request.signal,
    })
    const body = await response.json()
    if (unmounted || epoch !== sourceEpoch) return
    if (!response.ok || body.ok !== true || !isInitialNodeSnapshot(body.data)) throw new Error('初始位置响应不可用')
    if (body.data !== null) {
      telemetryStore.disconnectAndReset()
      initialSnapshot.value = body.data
      sourceState.value = 'FILE'
      selectedNodeId.value = fileNodes.value[0]?.platformId ?? ''
      sourceMessage.value = `${body.data.fileName} · 0分0秒初始位置`
      return
    }
    initialSnapshot.value = null
    sourceState.value = 'MOCK'
  } catch {
    if (unmounted || epoch !== sourceEpoch) return
    sourceState.value = 'ERROR'
    sourceMessage.value = '初始节点读取失败，请检查本机日志路径、文件完整性及初始坐标后重试。'
    return
  }
  const simulationLoaded = await simulationStore.resetProjection()
  if (unmounted || epoch !== sourceEpoch || !simulationLoaded) return
  if (simulationStore.run && simulationStore.run.scenarioId !== 'SCN-001') {
    if (await simulationStore.selectScene(simulationStore.run.scenarioId) && !unmounted && epoch === sourceEpoch) await initializeSituation()
    return
  }
  const loaded = await telemetryStore.loadFrame()
  if (!unmounted && epoch === sourceEpoch && loaded) telemetryStore.connect()
}

onMounted(initializeSituation)

// 登出请求完成或路由卸载前就停止文件播放，并使在途加载失效。
watch(() => useAuthStore().principal?.userId, () => {
  if (!ownsFilePlayback.value) return
  sourceEpoch += 1
  sourceRequest?.abort()
  filePlayback.resetToSafeEmpty()
  ownsFilePlayback.value = false
  fileLoading.value = false
  initialSnapshot.value = null
  sourceState.value = 'ERROR'
  sourceMessage.value = '会话已改变，请重新登录后加载文件。'
}, { flush: 'sync' })

onBeforeUnmount(() => {
  unmounted = true
  sourceRequest?.abort()
  if (ownsFilePlayback.value) filePlayback.resetToSafeEmpty()
  telemetryStore.disconnectAndReset()
})

watch(frame, (nextFrame) => {
  if (sourceState.value === 'FILE') return
  if (nextFrame === null) {
    selectedNodeId.value = ''
    return
  }
  if (!nextFrame.platforms.some((platform) => platform.platformId === selectedNodeId.value)) {
    selectedNodeId.value = nextFrame.platforms[0]?.platformId ?? ''
  }
}, { immediate: true })

const situationLinks = computed(() => frame.value === null ? [] : selectSituationLinks(frame.value))
const fileLinksForSummary = computed(() => {
  if (sourceState.value !== 'FILE') return []
  return fileLinks.value.map(link => {
    const source = fileNodes.value.find(n => n.platformId === link.sourcePlatformId)
    const target = fileNodes.value.find(n => n.platformId === link.targetPlatformId)
    const typeLabel = FILE_COMMUNICATION_LABELS[link.type as keyof typeof FILE_COMMUNICATION_LABELS] ?? link.type
    return {
      linkId: link.id,
      sourceName: source?.name ?? link.sourcePlatformId,
      destinationName: target?.name ?? link.targetPlatformId,
      type: link.type,
      typeLabel,
    }
  })
})
const displayedLinks = computed(() => {
  if (selectedScene.value) {
    return selectedScene.value.config.links.map(link => ({
      linkId: link.id,
      type: link.type,
      sourceName: selectedScene.value!.config.platforms.find(platform => platform.id === link.sourcePlatformId)!.name,
      destinationName: selectedScene.value!.config.platforms.find(platform => platform.id === link.targetPlatformId)!.name,
      live: null,
      configured: link,
      file: null,
    }))
  }
  if (sourceState.value === 'FILE') {
    return fileLinks.value.map(link => {
      const source = fileNodes.value.find(n => n.platformId === link.sourcePlatformId)
      const target = fileNodes.value.find(n => n.platformId === link.targetPlatformId)
      return {
        linkId: link.id,
        type: link.type,
        sourceName: source?.name ?? link.sourcePlatformId,
        destinationName: target?.name ?? link.targetPlatformId,
        live: null,
        configured: null,
        file: {
          ...link,
          status: fileLinkDeviceStatus(link, fileDeviceStates.value),
        },
      }
    })
  }
  return situationLinks.value.map(link => ({
    linkId: link.linkId,
    type: link.type,
    sourceName: link.sourceName,
    destinationName: link.destinationName,
    live: link,
    configured: null,
    file: null,
  }))
})
const selectedLink = computed(() => situationLinks.value.find((link) => link.linkId === selectedLinkId.value) ?? null)
const selectedConfiguredLink = computed(() => {
  const link = selectedScene.value?.config.links.find(link => link.id === selectedLinkId.value)
  return link ? { ...link, enabled: readLinkEnabled(link, selectedScene.value!.config.linkSettings) } : null
})
watch([selectedLink, selectedConfiguredLink], ([live, configured]) => {
  if (!live && !configured) linkDialogVisible.value = false
})
watch(() => selectedScene.value?.config.scenario.id, () => {
  selectedNodeId.value = ''
  selectedLinkId.value = ''
  mapFocusTarget.value = null
  stopDialogVisible.value = false
})
const situationMetrics = computed(() => frame.value === null
  ? null
  : selectSituationMetrics(frame.value, events.value, situationLinks.value))
const displayedBusinessPlatforms = computed(() => initialSnapshot.value ? fileNodes.value : (frame.value?.platforms ?? []).filter(
  (platform) => BUSINESS_NODE_TYPES.has(platform.type),
))
const supportingPlatforms = computed(() => (frame.value?.platforms ?? []).filter(
  (platform) => !BUSINESS_NODE_TYPES.has(platform.type),
))
const fileDeviceStates = computed(() => !selectedScene.value && sourceState.value === 'FILE'
  ? selectFileDeviceStates(initialSnapshot.value?.deviceEvents ?? [], fileTime.value) : [])

const fileJammers = computed(() => {
  if (sourceState.value !== 'FILE' || !initialSnapshot.value) return []
  const states = fileDeviceStates.value
  const jammerNodes = initialSnapshot.value.nodes.filter(n =>
    n.platformId.includes('jammer') || n.name.includes('干扰')
    || initialSnapshot.value?.deviceEvents?.some(e => e.platformId === n.platformId && e.kind === 'JAMMING'),
  )
  return jammerNodes.map(node => {
    const event = states.find(e => e.platformId === node.platformId && e.kind === 'JAMMING')
    const deviceId = event?.deviceId || (node.platformId.includes('station') ? 'prophet_jammer' : 'airborne_jammer')
    return {
      jammerId: deviceId,
      platformId: node.platformId,
      platformName: node.name,
      power: 100,
      frequency: event?.frequencyHz ? event.frequencyHz / 1e6 : 2400,
      bandwidth: event?.bandwidthHz ? event.bandwidthHz / 1e6 : 50,
      active: event?.active ?? false,
    }
  })
})

const displayedJammers = computed(() => {
  if (selectedScene.value) {
    return selectedScene.value.config.jammers.map(jammer => ({
      jammerId: jammer.id,
      platformId: jammer.platformId,
      platformName: selectedScene.value!.config.platforms.find(platform => platform.id === jammer.platformId)?.name ?? jammer.platformId,
      power: jammer.defaultPower,
      frequency: jammer.frequency,
      bandwidth: jammer.bandwidth,
      active: null,
    }))
  }
  if (sourceState.value === 'FILE') return fileJammers.value
  return (frame.value?.platforms ?? []).flatMap((platform) => platform.jammers.map(j => ({
    ...j,
    platformName: platform.name,
  })))
})

const jammers = computed(() => displayedJammers.value)

const fileTimelineEvents = computed(() => {
  if (sourceState.value !== 'FILE' || !initialSnapshot.value?.deviceEvents) return []
  return (initialSnapshot.value.deviceEvents ?? [])
    .filter(e => e.time <= fileTime.value)
    .slice(-20)
    .reverse()
    .map(e => {
      const platform = fileNodes.value.find(n => n.platformId === e.platformId)
      const platformName = platform?.name ?? e.platformId
      const kindLabel = e.kind === 'JAMMING' ? '干扰事件' : '通信事件'
      const actionLabel = e.active ? '启动' : '关闭'
      const freqInfo = e.frequencyHz ? `，频率 ${(e.frequencyHz / 1e6).toFixed(0)} MHz，带宽 ${(e.bandwidthHz! / 1e6).toFixed(0)} MHz` : ''
      return {
        eventId: e.sourceEventId,
        time: e.time,
        frameId: '',
        displayType: kindLabel,
        description: `${platformName} ${actionLabel} ${e.deviceId}${freqInfo}`,
      }
    })
})

const displayedEvents = computed(() => frame.value ? events.value : [])
const allDisplayedEvents = computed(() => {
  if (sourceState.value === 'FILE') return fileTimelineEvents.value
  return displayedEvents.value.map(event => ({
    eventId: event.eventId,
    time: event.time,
    frameId: event.frameId,
    displayType: event.type === 'DETECTION' ? '侦测' : '链路切换',
    description: eventDescription(event),
  }))
})
const detectionEvent = computed(() => displayedEvents.value.find(
  (event): event is DetectionEvent => event.type === 'DETECTION',
))
const maximumLinkAgeMs = computed(() => Math.max(0, ...situationLinks.value.map((link) => link.ageMs)))
const frameFreshnessLabel = computed(() => situationLinks.value.length === 0
  ? '暂无链路数据'
  : maximumLinkAgeMs.value === 0 ? '新鲜' : '存在延迟')
const connectionLabel = computed(() => ({
  DISCONNECTED: '未连接',
  CONNECTING: '连接中',
  SUBSCRIBED: '实时已订阅',
  RETRYING: '重新连接中',
  FAILED: '连接失败',
}[connectionState.value]))

/** 重新加载完整帧，并在成功后恢复实时订阅。 */
async function retryTelemetry(): Promise<void> {
  if (sourceState.value !== 'MOCK') {
    await initializeSituation()
    return
  }
  const loaded = await telemetryStore.loadFrame()
  if (!unmounted && loaded) telemetryStore.connect()
}

/**
 * 切换场景配置悬浮面板的折叠状态。
 * @returns 无返回值。
 * @sideeffect 修改左侧悬浮面板状态并联动地图控件的左侧留白。
 */
function toggleSceneSummary(): void {
  sceneSummaryCollapsed.value = !sceneSummaryCollapsed.value
}

/**
 * 切换链路、干扰与事件悬浮面板的折叠状态。
 * @returns 无返回值。
 * @sideeffect 修改右侧悬浮面板状态并联动地图控件的右侧留白。
 */
function toggleTelemetryPanel(): void {
  telemetryPanelCollapsed.value = !telemetryPanelCollapsed.value
}

/**
 * 文件来源启动本地时间轴；其他来源创建并开始仿真，或继续暂停运行。
 * @returns 操作完成后兑现且不返回值的 Promise。
 * @sideeffect 文件播放不调用引擎；仿真交由 simulationStore 同步运行状态和场景配置锁。
 */
async function startSimulation(): Promise<void> {
  if (sourceState.value === 'FILE') {
    if (fileLoading.value) return
    const epoch = sourceEpoch
    const firstLoad = !ownsFilePlayback.value
    ownsFilePlayback.value = true
    if (firstLoad || !filePlayback.localSnapshot) {
      fileLoading.value = true
      const loaded = await filePlayback.loadLocalFile()
      if (unmounted || epoch !== sourceEpoch) return
      fileLoading.value = false
      if (!loaded || !filePlayback.localSnapshot) {
        initialSnapshot.value = null
        sourceState.value = 'ERROR'
        sourceMessage.value = filePlayback.resultMessage || '文件播放数据加载失败，请重新加载。'
        return
      }
      initialSnapshot.value = filePlayback.localSnapshot.initial
      if (!fileNodes.value.some(node => node.platformId === selectedNodeId.value)) selectedNodeId.value = fileNodes.value[0]?.platformId ?? ''
    }
    await filePlayback.play()
    return
  }
  await simulationStore.start()
}

/**
 * 暂停文件播放或当前仿真运行。
 * @returns 操作完成后兑现且不返回值的 Promise。
 * @sideeffect 通过 simulationStore 发送 PAUSE 命令并更新运行投影。
 */
async function pauseSimulation(): Promise<void> {
  if (sourceState.value === 'FILE') {
    await filePlayback.pause()
    return
  }
  await simulationStore.pause()
}

/**
 * 文件播放前进一秒；仿真执行一个场景时间步。
 * @returns 操作完成后兑现且不返回值的 Promise。
 * @sideeffect 通过 simulationStore 发送 STEP 命令并更新规范仿真时刻。
 */
async function stepSimulation(): Promise<void> {
  if (sourceState.value === 'FILE') {
    await filePlayback.step('forward')
    return
  }
  await simulationStore.step()
}

/**
 * 文件播放停止并归零；仿真打开停止操作确认框。
 * @returns 无返回值。
 * @sideeffect 修改停止确认框的可见状态。
 */
function requestStop(): void {
  if (sourceState.value === 'FILE') {
    filePlayback.resetToSafeEmpty()
    return
  }
  if (simulationStatus.value === 'RUNNING' || simulationStatus.value === 'PAUSED') stopDialogVisible.value = true
}

/**
 * 创建并消费一次性确认后停止当前仿真。
 * @returns 停止流程完成后兑现且不返回值的 Promise。
 * @sideeffect 成功时停止运行、清零规范时钟、解除配置锁并关闭确认框。
 */
async function confirmStop(): Promise<void> {
  if (await simulationStore.stop()) stopDialogVisible.value = false
}

/**
 * 更新仿真倍速选择并在运行期间同步到 Mock 服务。
 * @param speed 用户选择的倍速。
 * @returns 操作完成后兑现且不返回值的 Promise。
 * @sideeffect 调用 simulationStore 更新本地选择或发送 SET_SPEED 命令。
 */
async function updateSpeed(speed: number): Promise<void> {
  if (sourceState.value === 'FILE') {
    await filePlayback.setSpeed(speed)
    return
  }
  await simulationStore.setSpeed(speed)
}

/**
 * 更新下一次 START 使用的运行模式。
 * @param mode 合同定义的运行模式。
 * @returns 无返回值。
 * @sideeffect 只更新 simulationStore 中的模式选择。
 */
function updateMode(mode: SimulationMode): void {
  simulationStore.setMode(mode)
}

/**
 * 打开所选链路的质量详情。
 * @param link 来自固定帧的链路视图。
 * @returns 无返回值。
 * @sideeffect 更新所选链路并打开详情框。
 */
function openLinkDetails(link: SituationLinkView): void {
  selectedLinkId.value = link.linkId
  linkDialogVisible.value = true
}

function openConfiguredLinkDetails(link: Link): void {
  selectedLinkId.value = link.id
  linkDialogVisible.value = true
}

/**
 * 点击全链路状态表格行时，打开详情或在地图中定位。
 * @param link 链路表格行数据。
 * @returns 无返回值。
 */
function handleLinkRowClick(link: typeof displayedLinks.value[number]): void {
  if (link.live) {
    openLinkDetails(link.live)
  } else if (link.configured) {
    openConfiguredLinkDetails(link.configured)
  } else if (link.file) {
    focusLinkOnMap(link.linkId)
  }
}

/**
 * 打开当前固定帧的链路候选快照。
 * @returns 无返回值。
 * @sideeffect 显示链路候选集合弹框。
 */
function openLinkCandidates(): void {
  candidatePanelVisible.value = true
}

/**
 * 创建地图定位请求。
 * @param kind 节点、链路或干扰设备定位类型。
 * @param targetId 对应业务对象的唯一标识。
 * @returns 无返回值。
 * @sideeffect 创建新的请求对象并传给地图组件，同一条目可重复触发定位。
 */
function requestMapFocus(kind: SituationMapFocusTarget['kind'], targetId: string): void {
  mapFocusTarget.value = { kind, targetId }
}

/**
 * 从左侧摘要选择信息节点并定位地图。
 * @param platformId 平台唯一标识。
 * @returns 无返回值。
 * @sideeffect 更新当前选中节点并发出节点定位请求。
 */
function focusNodeOnMap(platformId: string): void {
  selectedNodeId.value = platformId
  requestMapFocus('node', platformId)
}

/**
 * 从左侧摘要选择信息链路并定位地图。
 * @param linkId 链路唯一标识。
 * @returns 无返回值。
 * @sideeffect 发出链路范围定位请求，不自动打开链路详情弹框。
 */
function focusLinkOnMap(linkId: string): void {
  requestMapFocus('link', linkId)
}

/**
 * 从左侧摘要选择干扰设备并定位地图。
 * @param jammerId 干扰设备唯一标识。
 * @param platformId 搭载干扰设备的平台唯一标识。
 * @returns 无返回值。
 * @sideeffect 选中干扰设备所在平台并发出干扰范围定位请求。
 */
function focusInterferenceOnMap(jammerId: string, platformId: string): void {
  selectedNodeId.value = platformId
  // 场景配置与本地文件模式只定位所属节点中心；在线仿真运行定位干扰范围。
  if (selectedScene.value || sourceState.value === 'FILE') {
    requestMapFocus('node', platformId)
    return
  }
  requestMapFocus('interference', jammerId)
}

/**
 * 返回干扰设备类型的中文名称。
 * @param jammerId 固定帧干扰设备标识。
 * @param platformId 搭载干扰设备的平台标识。
 * @returns 包含机载或地面部署位置的干扰设备名称。
 * @sideeffect 无副作用。
 */
function jammerTypeLabel(jammerId: string, platformId: string): string {
  if (selectedScene.value) {
    const jammer = selectedScene.value.config.jammers.find(item => item.id === jammerId)!
    const platform = selectedScene.value.config.platforms.find(item => item.id === platformId)!
    return `${platform.category === 'AIR' ? '机载' : '地面'}${JAMMER_TYPE_LABELS[jammer.type]}干扰设备`
  }
  if (sourceState.value === 'FILE') {
    const node = fileNodes.value.find(n => n.platformId === platformId)
    const isAir = (node?.altitude ?? 0) > 0 || node?.platformId.includes('airborne') || (node?.name.includes('机载') ?? false)
    return `${isAir ? '机载' : '地面'}干扰设备`
  }
  const location = frame.value?.platforms
    .find((platform) => platform.platformId === platformId)?.type === 'AIRBORNE_MISSION_CLUSTER'
    ? '机载'
    : '地面'
  return `${location}${getJammerTypeLabel(jammerId)}干扰设备`
}

/**
 * 生成同帧事件的中文描述。
 * @param event 固定帧侦测或链路切换事件。
 * @returns 事件摘要文本。
 * @sideeffect 无副作用。
 */
function eventDescription(event: DetectionEvent | SwitchEvent): string {
  if (event.type === 'DETECTION') {
    return `${event.sensorId} 发现 ${event.targetPlatformId}，发现概率 ${(event.detectionProbability * 100).toFixed(0)}%`
  }
  return `${event.oldLinkId} 切换至 ${event.newLinkId}，决策已接受`
}
</script>

<template>
  <section id="page-situation" class="situation-page" aria-labelledby="situation-title">
    <h2 id="situation-title" class="situation-page__semantic-title">态势主界面</h2>

    <SimulationToolbar
      :read-only="sourceState !== 'MOCK' && sourceState !== 'SCENE' && sourceState !== 'FILE'"
      :file-playback="sourceState === 'FILE'"
      :status="sourceState === 'FILE' ? fileStatus : otherSceneRun ? 'STOPPED' : simulationStatus"
      :speed="sourceState === 'FILE' ? ownsFilePlayback ? filePlayback.speed : 1 : simulationSpeed"
      :mode="sourceState === 'FILE' ? 'HISTORICAL_REPLAY' : simulationMode"
      :capability-state="simulationCapabilityState"
      :pending="sourceState === 'FILE' ? fileLoading : simulationPending || simulationStore.selectingScene"
      :feedback="sourceState === 'FILE' ? `文件播放 · ${fileTimeLabel(fileTime)} / ${fileTimeLabel(filePlayback.replay?.durationS ?? 0)}，不启动 mission` : sourceState === 'MOCK' || sourceState === 'SCENE' ? simulationFeedback : sourceMessage"
      @start="startSimulation"
      @pause="pauseSimulation"
      @step="stepSimulation"
      @stop="requestStop"
      @update:speed="updateSpeed"
      @update:mode="updateMode"
    >
      <template #timeline>
        <div v-if="sourceState === 'FILE' && filePlayback.replay" class="toolbar-timeline">
          <span class="toolbar-timeline__time">{{ fileTimeLabel(fileTime) }}</span>
          <el-slider
            v-model="fileSliderTime"
            :min="0"
            :max="filePlayback.replay.durationS"
            :step="1"
            :show-tooltip="false"
            :disabled="fileLoading || filePlayback.replay.durationS === 0"
            aria-label="文件播放进度"
            @input="fileSliderDragging = true"
            @change="seekFileTime"
          />
          <span class="toolbar-timeline__time">{{ fileTimeLabel(filePlayback.replay.durationS) }}</span>
        </div>
      </template>
    </SimulationToolbar>

    <div
      v-if="selectedScene || (frame && situationMetrics) || (sourceState === 'FILE' && initialSnapshot)"
      class="situation-page__workspace"
      :class="{
        'situation-page__workspace--scene-collapsed': sceneSummaryCollapsed,
        'situation-page__workspace--telemetry-collapsed': telemetryPanelCollapsed,
      }"
    >
      <aside
        class="scene-summary"
        :class="{ 'is-collapsed': sceneSummaryCollapsed }"
        aria-label="场景配置"
        :data-collapsed="sceneSummaryCollapsed"
      >
      <strong class="node-jammer-count">{{ selectedScene ? `${savedNodeGroups[0]!.platforms.length} / ${BUSINESS_NODE_CAPACITY}` : initialSnapshot ? `${fileNodes.length} 个` : `${situationMetrics?.businessNodeCount} / ${BUSINESS_NODE_CAPACITY}` }}</strong>
        <button
          type="button"
          class="floating-panel__toggle floating-panel__toggle--left"
          data-testid="toggle-scene-summary"
          :aria-expanded="!sceneSummaryCollapsed"
          :aria-label="sceneSummaryCollapsed ? '展开场景配置' : '折叠场景配置'"
          @click="toggleSceneSummary"
        ><span aria-hidden="true">{{ sceneSummaryCollapsed ? '›' : '‹' }}</span></button>
        <div class="panel-heading">
          <div><strong>场景配置</strong></div>
          <router-link to="/scenarios">进入场景配置</router-link>
        </div>

        <div class="scene-summary__tabs" role="tablist" aria-label="场景摘要分类">
          <button
            v-for="tab in summaryTabs"
            :key="tab.key"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab.key"
            :class="{ active: activeTab === tab.key }"
            @click="activeTab = tab.key"
          >{{ tab.label }}</button>
        </div>

        <div class="scene-summary__content" :aria-label="`${summaryTabs.find((tab) => tab.key === activeTab)?.label}摘要`">
          <template v-if="selectedScene">
            <template v-if="activeTab === 'nodes'">
              <div v-for="group in savedNodeGroups" :key="group.title" class="summary-group">
                <h3>{{ group.title }} · {{ group.platforms.length }} 个</h3>
                <ul>
                  <li v-for="platform in group.platforms" :key="platform.id">
                    <button type="button" class="summary-focus-button" :data-testid="`focus-node-${platform.id}`"
                      :aria-label="`在地图中定位${platform.name}`" :aria-pressed="selectedNodeId === platform.id" @click="focusNodeOnMap(platform.id)">
                      <span>{{ platform.id }}</span><small>{{ PLATFORM_TYPE_LABELS[platform.type] }}</small>
                    </button>
                  </li>
                </ul>
              </div>
            </template>
            <div v-else-if="activeTab === 'links'" class="summary-group">
              <ul>
                <li v-for="link in selectedScene.config.links" :key="link.id">
                  <button type="button" class="summary-focus-button" :data-testid="`focus-link-${link.id}`"
                    :aria-label="`在地图中定位${LINK_TYPE_LABELS[link.type]} ${link.id}`" @click="focusLinkOnMap(link.id)">
                    <span>{{ link.id }}</span><small>{{ LINK_TYPE_LABELS[link.type] }}</small>
                  </button>
                </li>
              </ul>
            </div>
            <div v-else-if="activeTab === 'interference'" class="summary-group">
              <ul>
                <li v-for="jammer in selectedScene.config.jammers" :key="jammer.id">
                  <button type="button" class="summary-focus-button" :data-testid="`focus-interference-${jammer.id}`"
                    :aria-label="`在地图中定位干扰设备${jammer.id}`" @click="focusInterferenceOnMap(jammer.id, jammer.platformId)">
                    <span>{{ jammerTypeLabel(jammer.id, jammer.platformId) }}</span><small>暂无数据</small>
                  </button>
                </li>
              </ul>
            </div>
            <div v-else class="summary-group">
              <h3>运行时序</h3>
              <dl class="timing-list">
                <div><dt>帧标识</dt><dd>暂无数据</dd></div>
                <div><dt>任务 / 运行</dt><dd>{{ otherSceneRun ? '暂无数据' : `${simulationRun?.taskId} / ${simulationRun?.runId}` }}</dd></div>
                <div><dt>仿真时刻</dt><dd>{{ otherSceneRun ? 0 : simulationTime }} s</dd></div>
                <div><dt>帧序号</dt><dd>暂无数据</dd></div>
              </dl>
            </div>
          </template>
          <template v-else-if="activeTab === 'nodes'">
            <div class="summary-group">
              <h3>信息节点 · {{ initialSnapshot?.nodes.length ?? situationMetrics?.businessNodeCount }} 个</h3>
              <ul>
                <li v-for="platform in displayedBusinessPlatforms" :key="platform.platformId">
                  <button
                    type="button"
                    class="summary-focus-button"
                    :data-testid="`focus-node-${platform.platformId}`"
                    :aria-label="`在地图中定位${platform.name}`"
                    :aria-pressed="selectedNodeId === platform.platformId"
                    @click="focusNodeOnMap(platform.platformId)"
                  >
                    <span>{{ initialSnapshot ? platform.name : platform.platformId }}</span><small>{{ initialSnapshot ? platform.type : platform.name }}</small>
                  </button>
                </li>
              </ul>
            </div>
            <div v-if="!initialSnapshot" class="summary-group">
              <h3>支撑实体</h3>
              <ul>
                <li v-for="platform in supportingPlatforms" :key="platform.platformId">
                  <button
                    type="button"
                    class="summary-focus-button"
                    :data-testid="`focus-node-${platform.platformId}`"
                    :aria-label="`在地图中定位${platform.name}`"
                    @click="focusNodeOnMap(platform.platformId)"
                  >
                    <span>{{ platform.platformId }}</span><small>{{ platform.name }}</small>
                  </button>
                </li>
              </ul>
            </div>
          </template>

          <div v-else-if="activeTab === 'links'" class="summary-group">
            <template v-if="sourceState === 'FILE'">
              <ul v-if="fileLinksForSummary.length">
                <li v-for="link in fileLinksForSummary" :key="link.linkId">
                  <button
                    type="button"
                    class="summary-focus-button"
                    :data-testid="`focus-link-${link.linkId}`"
                    :aria-label="`在地图中定位${link.typeLabel} ${link.sourceName}至${link.destinationName}`"
                    @click="focusLinkOnMap(link.linkId)"
                  >
                    <span>{{ link.sourceName }} → {{ link.destinationName }}</span>
                    <small>{{ link.typeLabel }}</small>
                  </button>
                </li>
              </ul>
              <p v-else class="summary-empty-caption">暂无文件链路数据</p>
            </template>
            <ul v-else>
              <li v-for="link in situationLinks" :key="link.linkId">
                <button
                  type="button"
                  class="summary-focus-button"
                  :data-testid="`focus-link-${link.linkId}`"
                  :aria-label="`在地图中定位${LINK_TYPE_LABELS[link.type]} ${link.sourceName}至${link.destinationName}`"
                  @click="focusLinkOnMap(link.linkId)"
                >
                  <span>{{ link.linkId }}</span><small>{{ LINK_TYPE_LABELS[link.type] }}</small>
                </button>
              </li>
            </ul>
          </div>

          <div v-else-if="activeTab === 'interference'" class="summary-group">
            <ul v-if="displayedJammers.length">
              <li v-for="jammer in displayedJammers" :key="jammer.jammerId">
                <button
                  type="button"
                  class="summary-focus-button"
                  :data-testid="`focus-interference-${jammer.jammerId}`"
                  :aria-label="`在地图中定位${jammerTypeLabel(jammer.jammerId, jammer.platformId)}`"
                  @click="focusInterferenceOnMap(jammer.jammerId, jammer.platformId)"
                >
                  <span>{{ jammerTypeLabel(jammer.jammerId, jammer.platformId) }}</span>
                  <small>{{ jammer.active === null ? '暂无数据' : jammer.active ? '活动' : '待机' }} · {{ jammer.power }} W</small>
                </button>
              </li>
            </ul>
            <p v-else class="summary-empty-caption">暂无干扰设备数据</p>
          </div>

          <div v-else-if="sourceState === 'FILE'" class="summary-group">
            <h3>文件回放时序</h3>
            <dl class="timing-list">
              <div><dt>来源文件</dt><dd>{{ initialSnapshot?.fileName ?? '未知文件' }}</dd></div>
              <div><dt>当前时刻</dt><dd>{{ fileTimeLabel(fileTime) }} ({{ fileTime.toFixed(1) }} s)</dd></div>
              <div><dt>总时长</dt><dd>{{ fileTimeLabel(filePlayback.replay?.durationS ?? 0) }}</dd></div>
              <div><dt>播放状态</dt><dd>{{ fileStatus === 'PLAYING' ? '播放中' : fileStatus === 'PAUSED' ? '已暂停' : '已就绪' }} · {{ ownsFilePlayback ? filePlayback.speed : 1 }}x</dd></div>
            </dl>
          </div>

          <div v-else-if="frame" class="summary-group">
            <h3>固定帧时序</h3>
            <dl class="timing-list">
              <div><dt>帧标识</dt><dd>{{ frame.frameId }}</dd></div>
              <div><dt>任务 / 运行</dt><dd>{{ frame.taskId }} / {{ frame.runId }}</dd></div>
              <div><dt>仿真时刻</dt><dd>{{ frame.simulationTime }} s</dd></div>
              <div><dt>帧序号</dt><dd>{{ frame.sequence }}</dd></div>
            </dl>
          </div>
        </div>

      </aside>

      <main class="situation-center" data-testid="situation-center">
        <SavedScenePreview v-if="selectedScene" :scene="selectedScene" :selected-node-id="selectedNodeId" :focus-target="mapFocusTarget"
          @select-node="selectedNodeId = $event" @select-configured-link="openConfiguredLinkDetails" />
        <OfflineSituationMap
          v-else
          :key="initialSnapshot?.sha256 ?? 'mock'"
          :frame="frame"
          :initial-nodes="initialSnapshot ? fileNodes : undefined"
          :file-links="fileLinks"
          :file-message-links="fileMessageLinks"
          :file-device-events="initialSnapshot?.deviceEvents"
          :file-time="fileTime"
          :links="situationLinks"
          :selected-node-id="selectedNodeId"
          :focus-target="mapFocusTarget"
          @select-node="selectedNodeId = $event"
          @select-link="openLinkDetails"
        >
          <template #topbar>
            <MetricPanel v-if="situationMetrics" :metrics="situationMetrics" />
          </template>
        </OfflineSituationMap>
      </main>

      <aside
        class="telemetry-panel"
        :class="{ 'is-collapsed': telemetryPanelCollapsed }"
        aria-label="链路、干扰与事件"
        :data-collapsed="telemetryPanelCollapsed"
      >
        <button
          type="button"
          class="floating-panel__toggle floating-panel__toggle--right"
          data-testid="toggle-telemetry-panel"
          :aria-expanded="!telemetryPanelCollapsed"
          :aria-label="telemetryPanelCollapsed ? '展开链路、干扰与事件' : '折叠链路、干扰与事件'"
          @click="toggleTelemetryPanel"
        ><span aria-hidden="true">{{ telemetryPanelCollapsed ? '‹' : '›' }}</span></button>
        <section class="telemetry-section telemetry-section--links" :data-frame-id="frame?.frameId">
          <div class="panel-heading">
            <div><strong>全链路状态</strong></div>
            <div>
              <span class="panel-heading__more">异常 {{ situationMetrics ? `${situationMetrics.degradedLinkCount + situationMetrics.downLinkCount} 条` : '暂无数据' }}</span>
              <el-button link type="primary" data-testid="open-link-candidates" :disabled="!frame" @click="openLinkCandidates">
                候选 {{ frame ? `${frame.evidence.routeCandidates.length} 条` : '暂无数据' }}
              </el-button>
            </div>
          </div>
          <div class="link-table-wrap">
            <table class="link-table" :class="{ 'link-table--quality': MAP_CONFIG.showLinkQualityColumns }">
              <thead><tr><th>链路</th><th>体制</th><th v-if="MAP_CONFIG.showLinkQualityColumns">SNR</th><th v-if="MAP_CONFIG.showLinkQualityColumns">BER</th><th :title="sourceState === 'FILE' ? '展示约定：开启→正常，关闭→切换，未知→干扰；不代表实际质量、切换或干扰判定' : undefined">状态</th></tr></thead>
              <tbody>
                <tr
                  v-for="link in displayedLinks"
                  :key="link.linkId"
                  tabindex="0"
                  role="button"
                  :data-link-id="link.linkId"
                  :class="{ 'is-exception': link.live && link.live.status !== 'UP' }"
                  @click="handleLinkRowClick(link)"
                  @keydown.enter="handleLinkRowClick(link)"
                >
                  <td><strong>{{ link.sourceName }}→{{ link.destinationName }}</strong></td>
                  <td>{{ link.file ? (link.type === 'DATALINK' ? '数传' : (FILE_COMMUNICATION_LABELS[link.type as keyof typeof FILE_COMMUNICATION_LABELS] ?? link.type).replace('通信', '')) : (link.type === 'DATALINK' ? '数传' : LINK_TYPE_LABELS[link.type].replace('链路', '')) }}</td>
                  <td v-if="MAP_CONFIG.showLinkQualityColumns">{{ link.live ? link.live.snrDb.toFixed(2) : link.file ? '--' : '暂无数据' }}</td>
                  <td v-if="MAP_CONFIG.showLinkQualityColumns">{{ link.live ? formatBer(link.live.ber) : link.file ? '--' : '暂无数据' }}</td>
                  <td>
                    <LinkStateBadge v-if="link.live" :link="link.live" />
                    <span v-else-if="link.file" class="link-device-status" :data-status="link.file.status" :title="`设备启停证据：${link.file.status}；名称为展示约定，不代表实际质量、切换或干扰判定`">{{ FILE_LINK_STATUS_LABELS[link.file.status] }}</span>
                    <span v-else>暂无数据</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <el-empty v-if="displayedLinks.length === 0" :description="sourceState === 'FILE' ? '当前时刻暂无通信关联' : '暂无链路数据'" :image-size="48" />
          </div>
        </section>

        <section class="telemetry-section telemetry-section--jammer">
          <div class="panel-heading">
            <div><strong>干扰 / 侦测设备</strong></div>
            <span class="panel-heading__more">{{ sourceState === 'FILE' ? (displayedJammers.length ? `${displayedJammers.length} 台` : '暂无数据') : `${displayedJammers.length} 台` }}</span>
          </div>
          <div v-if="displayedJammers.length" class="jammer-list">
            <p v-if="selectedScene" class="panel-caption">已保存配置；暂无当前运行数据</p>
            <p v-else-if="sourceState === 'FILE'" class="panel-caption">文件设备启停与干扰请求请在地图节点详情查看</p>
            <article v-for="jammer in displayedJammers" :key="jammer.jammerId" :class="{ active: jammer.active }">
              <div><strong>{{ jammerTypeLabel(jammer.jammerId, jammer.platformId) }}</strong><span>{{ jammer.active === null ? '暂无数据' : jammer.active ? '活动' : '待机' }}</span></div>
              <small>搭载平台：{{ jammer.platformName }} · {{ jammer.platformId }}</small>
              <dl>
                <div><dt>功率</dt><dd>{{ jammer.power }} W</dd></div>
                <div><dt>频率</dt><dd>{{ jammer.frequency }} MHz</dd></div>
                <div><dt>带宽</dt><dd>{{ jammer.bandwidth }} MHz</dd></div>
              </dl>
              <div v-if="!selectedScene" class="power-bar"><i :style="{ width: `${Math.min(jammer.power, 100)}%` }"></i></div>
            </article>
          </div>
          <el-empty v-else class="telemetry-empty-state" :description="initialSnapshot?.deviceEvents?.length ? '文件设备启停与干扰请求请在地图节点详情查看' : '暂无干扰 / 侦测设备运行数据'" :image-size="48" />
          <p v-if="detectionEvent" class="detection-state">
            {{ detectionEvent.sensorId }} 已发现 {{ detectionEvent.targetPlatformId }} · 发现概率 {{ (detectionEvent.detectionProbability * 100).toFixed(0) }}%
          </p>
        </section>

        <section class="telemetry-section telemetry-section--events">
          <div class="panel-heading">
            <div><strong>同帧事件</strong></div>
            <span class="panel-heading__more">累计 {{ allDisplayedEvents.length ? `${allDisplayedEvents.length} 条` : '暂无数据' }}</span>
          </div>
          <ol v-if="allDisplayedEvents.length" class="event-list">
            <li v-for="event in allDisplayedEvents" :key="event.eventId">
              <div><time>{{ formatSimulationTime(event.time) }}</time><strong>{{ event.displayType }}</strong></div>
              <p>{{ event.description }}</p><small>{{ event.eventId }}{{ event.frameId ? ` · ${event.frameId}` : '' }}</small>
            </li>
          </ol>
          <el-empty v-else class="telemetry-empty-state" description="暂无当前运行事件" :image-size="48" />
        </section>
      </aside>
    </div>

    <section v-else class="telemetry-empty" aria-live="polite">
      <strong>{{ sourceState === 'LOADING' || telemetryCapabilityState === 'LOADING' || telemetryCapabilityState === 'VALIDATING' ? '正在加载态势遥测' : '暂无可用态势遥测' }}</strong>
      <p>{{ sourceState === 'MOCK' ? telemetryFeedback : sourceMessage }}</p>
      <el-button v-if="sourceState === 'ERROR' || telemetryCapabilityState === 'ERROR'" type="primary" @click="retryTelemetry">重新加载</el-button>
    </section>

    <footer v-if="frame" class="situation-footer" :data-frame-id="frame.frameId">
      <span><i class="footer-dot"></i>{{ connectionLabel }}</span>
      <span class="situation-footer__sequence">帧序号 {{ frame.sequence }}</span>
      <span data-testid="frame-freshness">最大数据年龄 {{ maximumLinkAgeMs }} ms · {{ frameFreshnessLabel }}</span>
      <strong>4 类业务信息节点 · 4 类链路 · 2 种干扰设备</strong>
    </footer>
    <footer v-else-if="!selectedScene && sourceState === 'FILE' && initialSnapshot" class="situation-footer">
      <span>来源：{{ initialSnapshot.fileName }}</span>
      <span>{{ fileTimeLabel(fileTime) }} · 节点 {{ fileNodes.length }} 个 · 点击左侧节点可定位</span>
    </footer>

    <LinkQualityDialog v-model="linkDialogVisible" :link="selectedLink" :configured-link="selectedConfiguredLink" />
    <LinkCandidatePanel
      v-model="candidatePanelVisible"
      :frame="frame"
      :links="situationLinks"
      :capability-state="telemetryCapabilityState"
      :feedback="telemetryFeedback"
      @reload="retryTelemetry"
    />
    <el-dialog v-model="stopDialogVisible" title="确认停止仿真" width="min(26rem, calc(100vw - 2rem))">
      <p class="stop-dialog-copy">{{ selectedScene ? '停止 Mock 运行并解除所选场景配置锁，已保存配置不会删除。' : '停止后将清除当前执行状态并解除场景配置锁，固定遥测帧 F-00042 不会改变。' }}</p>
      <template #footer>
        <el-button :disabled="simulationPending" @click="stopDialogVisible = false">取消</el-button>
        <el-button type="danger" :loading="simulationPending" data-testid="confirm-stop" @click="confirmStop">确认停止</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.toolbar-timeline {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 22rem;
  max-width: 38rem;
  width: clamp(22rem, 28vw, 38rem);
  margin-left: 8px;
}

.toolbar-timeline__time {
  color: var(--console-text-muted);
  font-family: Consolas, "SFMono-Regular", monospace;
  font-size: 12px;
  white-space: nowrap;
}

.toolbar-timeline :deep(.el-slider) {
  --el-slider-main-bg-color: var(--console-cyan, #42d8ff);
  --el-slider-runway-bg-color: #16283c;
  --el-slider-stop-bg-color: #27435f;
  flex: 1;
  min-width: 12rem;
}

@media (max-width: 1400px) {
  .toolbar-timeline {
    min-width: 16rem;
    max-width: 26rem;
    width: clamp(16rem, 22vw, 26rem);
  }
}

.situation-page {
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 38rem;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  color: var(--console-text);
  background: var(--console-bg-elevated);
  box-shadow: var(--console-shadow);
}
.situation-page__semantic-title { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.telemetry-empty { display: grid; place-content: center; justify-items: center; gap: .65rem; color: var(--console-text-muted); text-align: center; }
.telemetry-empty strong { color: var(--console-text); }
.telemetry-empty p { margin: 0; }
.situation-page__workspace {
  --scene-panel-clearance: 17.5rem;
  --telemetry-panel-clearance: 24rem;
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.scene-summary, .telemetry-panel { position: absolute; z-index: 1100; top: .75rem; bottom: .75rem; min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--console-border); border-radius: 8px; background: rgba(8,25,39,.96); box-shadow: var(--console-shadow); transition: width .18s ease; }
.scene-summary { left: .75rem; display: grid; width: 16rem; grid-template-rows: auto auto minmax(0, 1fr); }
.telemetry-panel { right: .75rem; display: grid; width: 22.5rem; grid-template-rows: minmax(14rem, 1.35fr) minmax(10rem, 1fr) minmax(8rem, .8fr); border-color: #1e3448; background: #0f1f30; }
.floating-panel__toggle { position: absolute; z-index: 2; top: .3rem; display: grid; width: 1.75rem; height: 1.75rem; place-items: center; padding: 0; border: 1px solid var(--console-border-strong); border-radius: 5px; color: var(--console-cyan); background: rgba(7,21,34,.96); font-size: 1.1rem; line-height: 1; cursor: pointer; }
.floating-panel__toggle--left { right: .35rem; }
.floating-panel__toggle--right { left: .35rem; }
.scene-summary > .panel-heading { padding-right: 2.65rem; }
.telemetry-panel > .telemetry-section:first-of-type .panel-heading { padding-left: 2.65rem; }
.scene-summary.is-collapsed > :not(.floating-panel__toggle), .telemetry-panel.is-collapsed > :not(.floating-panel__toggle) { display: none; }
.scene-summary.is-collapsed .floating-panel__toggle, .telemetry-panel.is-collapsed .floating-panel__toggle { top: 0; right: auto; left: 0; font-size: 1.5rem; font-weight: 700; text-shadow: 0 0 2px #06111d, 0 0 5px #06111d; }
.panel-heading { display: flex; min-height: 2.25rem; align-items: center; justify-content: space-between; gap: .5rem; padding: .4rem .65rem; border-bottom: 1px solid var(--console-border); background: rgba(16,40,58,.72); }
.panel-heading>div { display: flex; min-width: 0; align-items: center; gap: .45rem; }
.panel-heading strong { font-size: .76rem; }
.panel-heading span, .panel-heading small, .panel-heading a { color: var(--console-text-muted); font-size: var(--console-font-size-min); }
.panel-heading a { color: var(--console-cyan); text-decoration: none; }
.telemetry-panel .panel-heading { min-height: 2.35rem; padding: .55rem .85rem; border-bottom-color: #1e3448; color: #e8f0f8; background: transparent; }
.telemetry-panel .panel-heading strong { color: #e8f0f8; font-size: 13px; }
.telemetry-panel .panel-heading__more { color: #4fd6ff; font-size: 12px; font-weight: 400; }
.telemetry-panel .panel-heading .el-button { height: auto; padding: 0; font-size: 12px; }
.scene-summary__tabs { display: grid; grid-template-columns: repeat(4,1fr); margin: .5rem .6rem 0; border: 1px solid var(--console-border); border-radius: 5px; overflow: hidden; }
.scene-summary__tabs button { min-height: 1.75rem; border: 0; border-right: 1px solid var(--console-border); color: var(--console-text-muted); background: var(--console-bg-elevated); font-size: var(--console-font-size-min); cursor: pointer; }
.scene-summary__tabs button:last-child { border-right: 0; }
.scene-summary__tabs button.active { color: var(--console-cyan); background: rgba(66,216,255,.1); }
.scene-summary__content { min-height: 0; overflow-y: auto; padding: .5rem .6rem; }
.summary-empty-caption { margin: 0; padding: .6rem .85rem; color: var(--console-text-muted); font-size: var(--console-font-size-min); }
.summary-group + .summary-group { margin-top: .55rem; }
.summary-group h3 { margin: 0 0 .3rem; color: var(--console-text-muted); font-size: var(--console-font-size-min); font-weight: 600; }
.summary-group ul, .event-list { display: grid; gap: .28rem; margin: 0; padding: 0; list-style: none; }
.summary-group li { border-left: 2px solid var(--console-border-strong); background: rgba(16,40,58,.48); }
.summary-focus-button { display: grid; width: 100%; gap: .12rem; padding: .38rem .45rem; border: 0; color: var(--console-text); background: transparent; font: inherit; font-size: var(--console-font-size-min); text-align: left; cursor: pointer; }
.summary-focus-button:hover { background: rgba(66,216,255,.08); }
.summary-focus-button[aria-pressed="true"] { box-shadow: inset 2px 0 #f5b942; background: rgba(245,185,66,.1); }
.scene-summary__tabs button:disabled { opacity: .45; cursor: not-allowed; }
.summary-focus-button:focus-visible { outline: 1px solid var(--console-cyan); outline-offset: -1px; background: rgba(66,216,255,.1); }
.summary-group li small { color: var(--console-text-muted); font-family: Consolas,monospace; font-size: var(--console-font-size-min); }
.timing-list { display: grid; gap: .3rem; margin: 0; }
.timing-list div { display: grid; gap: .12rem; padding: .4rem; background: rgba(16,40,58,.48); }
.timing-list dt { color: var(--console-text-muted); font-size: var(--console-font-size-min); }
.timing-list dd { margin: 0; font-family: Consolas,monospace; font-size: var(--console-font-size-min); }
.situation-center { position: relative; display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0; grid-template-rows: minmax(0,1fr); }
.telemetry-section { min-height: 0; overflow: hidden; border-bottom: 1px solid #1e3448; }
.telemetry-section:last-child { border-bottom: 0; }
.telemetry-section--links, .telemetry-section--events { display: grid; grid-template-rows: auto minmax(0,1fr); }
.telemetry-section--jammer { display: grid; grid-template-rows: auto minmax(0,1fr) auto; }
.telemetry-empty-state { min-height: 0; overflow-y: auto; padding: .5rem; }
.telemetry-empty-state :deep(.el-empty__description) { margin-top: .6rem; }
.telemetry-empty-state :deep(.el-empty__description p) { color: #829db3; font-size: 12px; line-height: 1.5; text-align: center; }
.jammer-list > .panel-caption { margin: 0; padding: .6rem .85rem; color: #829db3; font-size: 12px; }
.link-table-wrap, .event-list, .jammer-list { min-height: 0; overflow-y: auto; }
.link-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.link-table th { position: sticky; z-index: 1; top: 0; padding: .45rem .5rem; color: #8fb6d9; background: #102a40; font-size: 12px; font-weight: 600; text-align: left; }
.link-table th:nth-child(1) { width: 58%; }
.link-table th:nth-child(2) { width: 20%; }
.link-table th:last-child { width: 22%; }
.link-table--quality th:nth-child(1) { width: 36%; }
.link-table--quality th:nth-child(2) { width: 16%; }
.link-table--quality th:nth-child(3), .link-table--quality th:nth-child(4) { width: 14%; }
.link-table--quality th:last-child { width: 20%; }
.link-table td { padding: .4rem .5rem; border-bottom: 1px solid #16283c; color: #a8bfd4; font-family: Consolas,"Microsoft YaHei",monospace; font-size: 12px; cursor: pointer; }
.link-table tr.is-exception td { color: #ff7b7b; background: #3a1620; }
.link-table tr:hover td, .link-table tr:focus td { background: #16283c; }
.link-table tr.is-exception:hover td, .link-table tr.is-exception:focus td { background: #4a1b27; }
.link-table td strong { display: block; white-space: normal; overflow-wrap: anywhere; }
.link-device-status { display: inline-block; padding: 1px 6px; border-radius: 3px; color: #829db3; background: rgba(130, 157, 179, .15); font-size: 11px; white-space: nowrap; }
.link-device-status[data-status="开启"] { color: #49e49a; background: rgba(73, 228, 154, .15); }
.link-device-status[data-status="关闭"] { color: #ff7b7b; background: rgba(255, 123, 123, .15); }
.jammer-list { display: block; padding: 0; }
.jammer-list article { padding: .6rem .85rem; border-bottom: 1px solid #1e3448; color: #a8bfd4; background: transparent; }
.jammer-list article>div:first-child { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: .45rem; }
.jammer-list article>div:first-child::before { width: .55rem; height: .55rem; border-radius: 50%; background: #6b8299; content: ""; }
.jammer-list article.active>div:first-child::before { background: #ff5b5b; box-shadow: 0 0 6px rgba(255,91,91,.65); }
.jammer-list article strong { color: #e8f0f8; font-size: 12px; }
.jammer-list article span { color: #8fb6d9; font-size: 12px; }
.jammer-list article>small { display: block; margin-top: .35rem; color: #6b8299; font-size: 12px; }
.jammer-list article.active span { color: #ff7b7b; }
.jammer-list dl { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: .5rem; margin: .5rem 0; }
.jammer-list dt { color: #6b8299; font-size: 12px; }
.jammer-list dd { margin: .1rem 0 0; color: #a8bfd4; font-family: Consolas,monospace; font-size: 12px; }
.power-bar { height: .35rem; overflow: hidden; border-radius: 999px; background: #16283c; }
.power-bar i { display: block; height: 100%; border-radius: inherit; background: #ff5b5b; }
.detection-state { margin: 0; padding: .5rem .85rem; border-top: 1px solid #1e3448; color: #ff7b7b; font-size: 12px; }
.event-list { display: block; padding: .5rem .85rem; }
.event-list li { padding: .4rem 0; border-bottom: 1px dashed #16283c; background: transparent; }
.event-list li:last-child { border-bottom: 0; }
.event-list li>div { display: flex; justify-content: space-between; gap: .5rem; }
.event-list time { color: #4fd6ff; font-family: Consolas,monospace; font-size: 12px; }
.event-list small { color: #6b8299; font-family: Consolas,monospace; font-size: 12px; }
.event-list strong { color: #ffb84d; font-size: 12px; }
.event-list p { margin: .2rem 0; color: #a8bfd4; font-size: 12px; line-height: 1.5; }
.situation-footer { display: flex; min-height: 2rem; align-items: center; gap: 1rem; padding: .35rem .7rem; border-top: 1px solid var(--console-border); color: var(--console-text-muted); background: #06131f; font-family: Consolas,"Microsoft YaHei",monospace; font-size: var(--console-font-size-min); white-space: nowrap; }
.situation-footer span:first-child { display: inline-flex; align-items: center; gap: .3rem; }
.situation-footer strong { overflow: hidden; margin-left: auto; color: var(--console-teal); text-overflow: ellipsis; }
.footer-dot { width: .42rem; height: .42rem; border-radius: 50%; background: var(--console-text-dim); }
.stop-dialog-copy { margin: 0; color: var(--console-text-muted); line-height: 1.7; }
.scene-summary .node-jammer-count{ position: absolute;  top:9px; left:62px; color: var(--console-cyan); font-size: var(--console-font-size-min);}
@media (max-width: 1500px) {
  .situation-page__workspace { --scene-panel-clearance: 15.5rem; --telemetry-panel-clearance: 21.5rem; }
  .scene-summary { width: 14rem; }
  .telemetry-panel { width: 20rem; }
  .situation-footer { gap: .65rem; }
}
@media (max-width: 1100px) {
  .situation-page__workspace { --scene-panel-clearance: 13.5rem; --telemetry-panel-clearance: 19.5rem; }
  .scene-summary { width: 12rem; }
  .telemetry-panel { width: 18rem; }
  .situation-footer__sequence { display: none; }
}
.situation-page__workspace--scene-collapsed { --scene-panel-clearance: 3.25rem; --legend-clearance: .75rem; }
.situation-page__workspace--telemetry-collapsed { --telemetry-panel-clearance: 3.25rem; --view-controls-clearance: .75rem; }
.scene-summary.is-collapsed, .telemetry-panel.is-collapsed { bottom: auto; width: 1.75rem; height: 1.75rem; overflow: visible; border-color: transparent; background: transparent; box-shadow: none; }
@media (max-width: 760px) {
  .situation-page { height: auto; }
}
</style>

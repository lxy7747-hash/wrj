<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'
import OfflineSituationMap from '../../components/situation/OfflineSituationMap.vue'
import LinkQualityDialog from '../../components/situation/LinkQualityDialog.vue'
import ReplayTimeline from '../../components/replays/ReplayTimeline.vue'
import MissionResults from '../../components/situation/MissionResults.vue'
import EngineFramePanel from '../../components/situation/EngineFramePanel.vue'
import type { Link } from '../../contracts/domain-models'
import { useReplayStore } from '../../stores/replay'
import { useAuthStore } from '../../stores/auth'
import { selectFileCommunicationLinks } from '../../features/situation/file-communication-links'
import { formatSimulationTime } from '../../features/situation/situation-model'
import { readLinkEnabled } from '../../features/scenarios/link-settings'
import {
  localizeReplayTimelineMarkers,
  selectReplayConfiguredLinks,
  selectReplayLiveMessageFlows,
  selectReplayMapNodes,
} from '../../features/replays/replay-situation'
import type { PositionUpdate } from '../../features/situation/position-updates'
import type { SituationMapFocusTarget } from '../../components/situation/situation-map-controller'

const replayStore = useReplayStore()
const auth = useAuthStore()
const route = useRoute()
const archiveId = computed(() => typeof route.query.archiveId === 'string' ? route.query.archiveId : undefined)
const resultId = computed(() => typeof route.query.resultId === 'string' ? route.query.resultId : undefined)
const {
  replay,
  events,
  state,
  speed,
  selectedEventId,
  resultMessage,
  localSnapshot,
  engineHistory,
  engineLoading,
  scenarioConfig,
} = storeToRefs(replayStore)
const historyTab = ref('quality')
const currentTimeS = computed(() => replay.value?.currentTimeS ?? 0)
const choosingResult = computed(() => auth.runtimeMode === 'LOCAL' && !resultId.value && !archiveId.value && route.query.source !== 'file')
const useSceneSituationMode = computed(() => Boolean(scenarioConfig.value || (replayStore.resultRecord && !replayStore.resultRecord.executionSource)))
const nodeNames = computed(() => Object.fromEntries([
  ...(localSnapshot.value?.initial.nodes ?? []).map(node => [node.platformId, node.name] as const),
  ...(scenarioConfig.value?.platforms ?? []).map(platform => [platform.id, platform.name] as const),
]))
const mapFrame = computed(() => useSceneSituationMode.value ? engineHistory.value?.engineFrame : null)
const mapTimeS = computed(() => mapFrame.value?.simulationTime ?? currentTimeS.value)
const mapNodes = computed(() => selectReplayMapNodes(localSnapshot.value, scenarioConfig.value, mapTimeS.value))
const sceneLinkView = computed(() => (useSceneSituationMode.value && scenarioConfig.value && engineHistory.value
  ? selectReplayConfiguredLinks(scenarioConfig.value, engineHistory.value)
  : null))
// 传入空数组仍使用场景图层，缺帧时不能把累计投递画成当前链路。
const mapConfiguredLinks = computed(() => useSceneSituationMode.value ? sceneLinkView.value?.configuredLinks ?? [] : undefined)
const mapFocusLinks = computed(() => sceneLinkView.value?.focusLinks ?? [])
const configuredLinkStatuses = computed(() => sceneLinkView.value?.statuses)
const configuredLinkSwitches = computed(() => sceneLinkView.value?.switches)
const liveMessageFlows = computed(() => (useSceneSituationMode.value && engineHistory.value?.engineFrame
  ? selectReplayLiveMessageFlows(localSnapshot.value?.initial.messageLinks, mapTimeS.value, speed.value, state.value === 'PLAYING')
  : []))
const localizedTimelineMarkers = computed(() => localizeReplayTimelineMarkers(
  engineHistory.value?.timelineMarkers,
  scenarioConfig.value,
  nodeNames.value,
))
// 以回放游标筛选登记，不使用实时位置时刻，向后定位时也移除未来关联；场景引擎回放模式改由配置链路呈现。
const fileLinks = computed(() => (useSceneSituationMode.value
  ? []
  : selectFileCommunicationLinks(localSnapshot.value?.initial.connections ?? [], currentTimeS.value)))
const focusTarget = ref<SituationMapFocusTarget | null>(null)
const selectedNodeId = ref('')
const selectedLinkId = ref('')
const linkDetailDirections = shallowRef<readonly Pick<Link, 'id' | 'direction'>[]>([])
const linkDialogVisible = ref(false)
const mapFullscreen = ref(false)
const sliderTime = ref(0)
const sliderDragging = ref(false)
const fileSeekRevision = ref(0)
const loading = computed(() => state.value === 'LOADING')
const selectedConfiguredLink = computed(() => {
  const link = scenarioConfig.value?.links.find(item => item.id === selectedLinkId.value)
  return link ? { ...link, enabled: readLinkEnabled(link, scenarioConfig.value!.linkSettings) } : null
})
const selectedEngineSegments = computed(() => engineHistory.value?.engineFrame?.links.filter(segment => segment.linkIds.includes(selectedLinkId.value)) ?? [])
const linkNodePositions = computed<PositionUpdate[]>(() => mapNodes.value.map(node => ({
  time: typeof node.time === 'number' ? node.time : mapTimeS.value,
  platformId: node.platformId,
  longitude: node.longitude,
  latitude: node.latitude,
  altitude: node.altitude,
  speed: node.speed,
  heading: node.heading,
})))

function openConfiguredLinkDetails(link: Link, paired?: Link): void {
  linkDetailDirections.value = paired ? (link.direction === 'FORWARD' ? [link, paired] : [paired, link]) : []
  selectedLinkId.value = link.id
  linkDialogVisible.value = true
}

function selectLinkDetailDirection(id: string): void {
  if (linkDetailDirections.value.some(link => link.id === id)) selectedLinkId.value = id
}

watch(selectedConfiguredLink, link => {
  if (!link) linkDialogVisible.value = false
})

function formatTime(seconds: number): string {
  return formatSimulationTime(seconds).replace('T+ ', '')
}

/** 在播放与暂停之间切换。 */
async function togglePlayback(): Promise<void> {
  if (state.value === 'PLAYING') await replayStore.pause()
  else await replayStore.play()
}

/**
 * 接收滑块或事件标记发出的回放定位值。
 * @param value Element Plus 滑块值或事件的秒数。
 */
async function seek(value: number | number[]): Promise<void> {
  if (Array.isArray(value)) return
  fileSeekRevision.value += 1
  await replayStore.seek(value)
  sliderDragging.value = false
  sliderTime.value = replay.value?.currentTimeS ?? 0
}

/** 同步播放游标；用户正在拖动时保留输入草稿，松开后由 change 一次性提交定位。 */
watch(() => replay.value?.currentTimeS, (value) => {
  if (!sliderDragging.value) sliderTime.value = value ?? 0
}, { immediate: true })

/**
 * 设置回放倍速。
 * @param value 倍速选择器的新数值。
 */
async function changeSpeed(value: number): Promise<void> {
  await replayStore.setSpeed(value)
}

/** 仅加载本地文件；未配置或读取失败均保留提示，不回退演示数据。 */
async function reload(): Promise<void> {
  sliderDragging.value = false
  focusTarget.value = null
  selectedLinkId.value = ''
  linkDetailDirections.value = []
  linkDialogVisible.value = false
  if (choosingResult.value) replayStore.resetToSafeEmpty()
  else await replayStore.loadLocalFile(archiveId.value, resultId.value)
}

/** 选中节点仍存在时保留高亮；时间变化不自动重置视图或选择。 */
watch(mapNodes, (nodes) => {
  if (!nodes.some((node) => node.platformId === selectedNodeId.value)) selectedNodeId.value = nodes[0]?.platformId ?? ''
}, { immediate: true })

/** 将地图定位到真实节点，platformId 为节点原始名称，不改动西经或其他真实坐标。 */
function locateFileNode(platformId: string): void {
  selectedNodeId.value = platformId
  focusTarget.value = { kind: 'node', targetId: platformId }
}

const hasReplayControls = computed(() => !loading.value && state.value !== 'CORRUPT' && state.value !== 'ERROR' && Boolean(replay.value && localSnapshot.value))
const hasTimelineItems = computed(() => localizedTimelineMarkers.value.length > 0 || events.value.length > 0)

onMounted(() => { void reload() })
watch([archiveId, resultId, () => route.query.source, choosingResult], () => { void reload() })
onBeforeUnmount(() => {
  replayStore.resetToSafeEmpty()
})
</script>

<template>
  <section class="replays-page" :class="{ 'replays-page--map-fullscreen': mapFullscreen }" aria-label="历史回放">
    <header class="replays-page__header">
      <MissionResults view="replay" />
      <section v-if="hasReplayControls && replay" class="replay-controls" aria-label="回放控制">
        <div class="replay-controls__bar">
          <div class="replay-controls__toolbar">
            <el-button
              class="replay-controls__step"
              size="small"
              title="后退 1 秒"
              aria-label="后退 1 秒"
              :disabled="replay.currentTimeS <= 0"
              @click="replayStore.step('back')"
            >-1s</el-button>
            <el-button size="small" type="primary" data-testid="replay-play" :disabled="replay.durationS === 0" @click="togglePlayback">{{ state === 'PLAYING' ? '暂停' : '播放' }}</el-button>
            <el-button
              class="replay-controls__step"
              size="small"
              title="前进 1 秒"
              aria-label="前进 1 秒"
              :disabled="replay.currentTimeS >= replay.durationS"
              @click="replayStore.step('forward')"
            >+1s</el-button>
            <el-select size="small" :model-value="speed" aria-label="回放倍速" @update:model-value="changeSpeed">
              <el-option :value="1" label="倍速 ×1" />
              <el-option :value="2" label="×2" />
              <el-option :value="4" label="×4" />
              <el-option :value="8" label="×8" />
              <el-option :value="16" label="×16" />
              <el-option :value="32" label="×32" />
            </el-select>
          </div>
          <div class="replay-controls__slider">
            <span>{{ formatTime(replay.currentTimeS) }}</span>
            <el-slider
              v-model="sliderTime"
              :min="0"
              :max="replay.durationS"
              :disabled="replay.durationS === 0"
              :step="1"
              :show-tooltip="false"
              aria-label="回放进度"
              @input="sliderDragging = true"
              @change="seek"
            />
            <span>{{ formatTime(replay.durationS) }}</span>
          </div>
        </div>
      </section>
      <el-button class="replays-page__reload" :loading="loading" :disabled="loading" @click="reload">重新加载</el-button>
    </header>

    <el-skeleton v-if="loading" class="replays-page__loading" :rows="10" animated />
    <el-result
      v-else-if="state === 'CORRUPT' || state === 'ERROR'"
      :icon="state === 'CORRUPT' ? 'warning' : 'error'"
      :title="state === 'CORRUPT' ? '回放数据损坏' : '历史回放不可用'"
      :sub-title="resultMessage"
    >
      <template #extra><el-button type="primary" @click="reload">重新加载</el-button></template>
    </el-result>
    <el-empty v-else-if="choosingResult" description="请选择要回放的运行结果。" />
    <el-empty v-else-if="!replay || !localSnapshot" description="暂无本地回放数据，请配置数据文件后重新加载。" />

    <main
      v-else
      class="replays-page__body"
      :class="{ 'replays-page__body--engine': engineHistory?.frameCount, 'replays-page__body--timeline': hasTimelineItems }"
    >
      <section v-if="hasTimelineItems" class="replay-timeline-strip" aria-label="事件时序条">
        <ReplayTimeline
          :replay="replay"
          :events="events"
          :engine-markers="localizedTimelineMarkers"
          :selected-event-id="selectedEventId"
          @select="selectedEventId = $event"
          @seek="seek"
        />
      </section>

      <section class="replay-view" aria-label="回放视窗">
        <OfflineSituationMap
          :key="`${localSnapshot.initial.sha256}:${localSnapshot.sha256}`"
          :source-key="`${localSnapshot.initial.sha256}:${localSnapshot.sha256}`"
          :frame="null"
          :engine-frame="engineHistory?.engineFrame"
          engine-source-label="历史引擎数据"
          :viewport-key="useSceneSituationMode && replayStore.resultRecord ? `${auth.principal?.userId}:${replayStore.resultRecord.scenarioId}:${replayStore.resultRecord.revision}` : undefined"
          :position-replay="localSnapshot"
          :initial-nodes="mapNodes"
          :configured-links="mapConfiguredLinks"
          :focus-links="mapFocusLinks"
          :configured-scenario="scenarioConfig"
          :configured-link-statuses="configuredLinkStatuses"
          :configured-link-switches="configuredLinkSwitches"
          :latest-switch="engineHistory?.engineSwitches.at(-1)"
          :recent-switches="engineHistory?.engineSwitches"
          :configured-jammers="scenarioConfig?.jammers"
          :configured-environment="scenarioConfig?.scenario?.environment"
          :link-calc-thresholds="scenarioConfig?.linkSettings?.linkCalc"
          :live-message-flows="liveMessageFlows"
          :live-flow-playing="state === 'PLAYING'"
          :live-flow-key="`${localSnapshot.initial.sha256}:${localSnapshot.sha256}:${fileSeekRevision}`"
          :file-links="fileLinks"
          :file-message-links="useSceneSituationMode ? [] : localSnapshot.initial.messageLinks"
          :file-device-events="useSceneSituationMode ? [] : localSnapshot?.initial.deviceEvents"
          :file-time="mapTimeS"
          :file-playing="state === 'PLAYING'"
          :file-speed="speed"
          :file-seek-revision="fileSeekRevision"
          :links="[]"
          select-nearby-links
          separate-link-directions
          :selected-node-id="selectedNodeId"
          :focus-target="focusTarget"
          @select-node="selectedNodeId = $event"
          @select-configured-link="openConfiguredLinkDetails"
          @fullscreen-change="mapFullscreen = $event"
        />
        <div class="replay-view__badge">{{ useSceneSituationMode || engineHistory?.frameCount ? '历史回放' : '文件回放' }} · {{ formatTime(mapTimeS) }}</div>
      </section>

      <aside class="replay-event-detail" :class="{ 'replay-event-detail--engine': Boolean(engineHistory) }" aria-label="回放数据" data-testid="replay-event-detail">
        <div class="replay-summary">
          <p v-if="useSceneSituationMode && !scenarioConfig" role="status">该次运行缺少对应修订的地图配置，仅显示已记录的节点位置。</p>
          <div class="panel-title">
            <div class="panel-title__left">
              <strong>{{ engineHistory ? '历史引擎数据' : '回放数据' }}</strong>
            </div>
            <div class="replay-history__meta">
              <span v-if="engineLoading" class="replay-history__loading" role="status">读取中…</span>
              <el-select v-if="engineHistory && engineHistory.epochs.length > 1" size="small" class="replay-history__epoch" :model-value="engineHistory.engineEpoch" aria-label="引擎轮次" @update:model-value="replayStore.selectEngineEpoch">
                <el-option v-for="epoch in engineHistory.epochs" :key="epoch.engineEpoch" :value="epoch.engineEpoch" :label="`轮次 ${epoch.engineEpoch + 1} · ${epoch.frameCount} 帧`" />
              </el-select>
              <span class="panel-title__meta">
                {{ mapNodes.length }} 个节点<template v-if="engineHistory"> · {{ engineHistory.frameCount }} 帧</template><template v-else> · 位置记录 {{ localSnapshot.recordCount }} 条</template>
              </span>
            </div>
          </div>
          <div class="replay-node-field">
            <label for="replay-node-select">节点定位</label>
            <div class="replay-node-location">
              <el-select id="replay-node-select" size="small" :model-value="selectedNodeId" aria-label="回放节点定位" @update:model-value="locateFileNode">
                <el-option v-for="node in mapNodes" :key="node.platformId" :value="node.platformId" :label="node.name" />
              </el-select>
              <el-button size="small" :disabled="!selectedNodeId" @click="locateFileNode(selectedNodeId)">定位</el-button>
            </div>
          </div>
          <p v-if="archiveId" class="replay-summary__note" data-testid="replay-archive-source">归档：{{ archiveId }}。重新加载仍查看此归档。</p>
          <p v-if="!engineHistory && !useSceneSituationMode" class="replay-summary__note">图中通信关联不代表链路已接通。</p>
          <el-alert v-if="localSnapshot.waitingForLine" title="文件尾部尚有未写完的记录，写入完成后可重新加载。" type="info" :closable="false" />
          <el-alert v-if="localSnapshot.issueCount" :title="`已跳过 ${localSnapshot.issueCount} 条异常记录`"
            :description="localSnapshot.issues.map((issue) => `第 ${issue.line} 行：${issue.message}`).join('；')" type="warning" :closable="false" />
        </div>

        <section v-if="engineHistory" class="replay-history" aria-label="历史引擎数据" data-testid="replay-engine-history">
          <p v-if="!engineHistory.engineFrame" class="replay-history__empty">{{ engineHistory.frameCount ? '当前时刻尚未收到引擎帧。' : '本次运行没有收到引擎帧。' }}</p>
          <template v-else>
            <p v-if="engineHistory.historyTruncated" class="replay-history__note">事件、切换和告警分别显示游标前最近 200 条；完整数据仍保存在历史归档中。</p>
            <el-tabs v-model="historyTab" class="replay-history__tabs">
              <el-tab-pane label="质量指标" name="quality"><EngineFramePanel section="quality" :ber-thresholds="scenarioConfig?.linkSettings?.linkCalc" :evidence="engineHistory" :links="engineHistory.links" :node-names="nodeNames" /></el-tab-pane>
              <el-tab-pane label="干扰与探测" name="jammers"><EngineFramePanel section="jammers" :evidence="engineHistory" :links="engineHistory.links" :node-names="nodeNames" /></el-tab-pane>
              <el-tab-pane label="选路与告警" name="decisions"><EngineFramePanel section="decisions" :ber-thresholds="scenarioConfig?.linkSettings?.linkCalc" :node-platforms="mapNodes" :evidence="engineHistory" :links="engineHistory.links" :node-names="nodeNames" /></el-tab-pane>
              <el-tab-pane label="事件" name="events"><EngineFramePanel section="events" :evidence="engineHistory" :links="engineHistory.links" :node-names="nodeNames" /></el-tab-pane>
            </el-tabs>
          </template>
        </section>
        <p v-else-if="resultId && !engineLoading" class="replay-summary__note">本次结果没有引擎帧归档，保留文件轨迹回放。</p>
      </aside>
    </main>

    <LinkQualityDialog
      v-model="linkDialogVisible"
      :link="null"
      :configured-link="selectedConfiguredLink"
      :directions="linkDetailDirections"
      :engine-segments="selectedEngineSegments"
      :engine-frame="engineHistory?.engineFrame"
      engine-source-label="历史引擎数据"
      :node-positions="linkNodePositions"
      :platforms="scenarioConfig?.platforms ?? []"
      @select-direction="selectLinkDetailDirection"
    />
  </section>
</template>

<style scoped>
.replays-page {
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  color: var(--console-text);
  background: var(--console-bg-elevated);
}

.replays-page--map-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 1500;
  width: 100vw;
  height: 100dvh;
}
/* 全屏时隐藏右侧回放数据栏，让地图占满主区域；顶部运行结果和回放控制保留。 */
.replays-page--map-fullscreen .replay-event-detail {
  display: none;
}
.replays-page--map-fullscreen .replays-page__body {
  grid-template-columns: minmax(0, 1fr);
}

.replays-page__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem 0.65rem;
  padding: 0.35rem 0.75rem;
  border-bottom: 1px solid var(--console-border);
}

.replays-page__header :deep(.mission-results) {
  flex: 0 1 auto;
  padding: 0;
  gap: 0.5rem;
}

.replays-page__header :deep(.mission-results .el-select) {
  width: clamp(11rem, 16vw, 17rem) !important;
}

.replays-page__header :deep(.mission-results) + .replay-controls {
  padding-inline-start: 0.65rem;
  border-inline-start: 1px solid var(--console-border);
}

.replays-page__header h2 {
  margin: 0.15rem 0 0;
  font-size: 1.25rem;
}

.replays-page__header p:last-child {
  margin: 0.25rem 0 0;
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.panel-title,
.replay-controls__bar,
.replay-controls__slider,
.replay-controls__toolbar {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}

.replays-page__reload {
  margin-inline-start: auto;
  flex-shrink: 0;
}

.replays-page__body {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(0, 1fr) 18rem;
  grid-template-rows: minmax(0, 1fr);
  gap: 0.6rem;
  padding: 0.55rem 0.75rem 0.65rem;
}

.replays-page__body--timeline {
  grid-template-rows: auto minmax(0, 1fr);
}

.replays-page__loading {
  padding: 1rem;
}

.replays-page__body--engine { grid-template-columns: minmax(0, 1fr) clamp(22.5rem, 25vw, 27rem); }

.replay-view,
.replay-event-detail,
.replay-timeline-strip {
  border: 1px solid var(--console-border);
  border-radius: 6px;
  background: var(--console-surface);
}

.replay-view {
  position: relative;
  min-height: 20rem;
  overflow: hidden;
}

.replay-view :deep(.offline-map) {
  min-height: 100%;
}

.replay-view__badge {
  position: absolute;
  top: 0.65rem;
  left: 0.65rem;
  z-index: 500;
  padding: 0.35rem 0.55rem;
  border: 1px solid var(--console-border);
  border-radius: 4px;
  color: var(--console-text-muted);
  background: color-mix(in srgb, var(--console-bg-elevated) 88%, transparent);
  font-size: var(--console-font-size-min);
  font-variant-numeric: tabular-nums;
}

.replay-event-detail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0.55rem 0.7rem;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.replay-event-detail--engine {
  overflow: hidden;
}

.replay-summary {
  flex: 0 0 auto;
  display: grid;
  gap: 0.4rem;
  padding-bottom: 0.45rem;
  border-bottom: 1px solid var(--console-border);
}

.panel-title {
  justify-content: space-between;
  padding-bottom: 0.35rem;
  border-bottom: 1px solid var(--console-border);
}

.panel-title__left {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
}

.panel-title__meta {
  font-variant-numeric: tabular-nums;
}

.panel-title span,
.replay-controls__slider > span {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.replay-node-field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.replay-node-field label {
  flex: none;
  color: var(--console-text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.replay-node-location {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 0.4rem;
}

.replay-node-location :deep(.el-select) {
  min-width: 0;
  flex: 1;
}

.replay-node-location :deep(.el-button) {
  flex: none;
  padding-inline: 0.65rem;
}

.replay-summary__note,
.replay-history__empty,
.replay-history__note {
  margin: 0;
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
  line-height: 1.5;
}

.replay-history {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-top: 0.3rem;
}

.replay-history__meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.replay-history__loading {
  padding: 1px 7px;
  border: 1px solid color-mix(in srgb, var(--console-cyan, #4bd9f2) 55%, transparent);
  border-radius: 999px;
  color: var(--console-cyan, #4bd9f2) !important;
  background: color-mix(in srgb, var(--console-cyan, #4bd9f2) 12%, transparent);
  font-size: 11px !important;
}

.replay-history__epoch {
  width: 9rem;
}

.replay-history__tabs {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.replay-history__tabs :deep(.el-tabs__header) {
  flex: 0 0 auto;
  margin: 0 0 0.35rem;
}

.replay-history__tabs :deep(.el-tabs__item) {
  height: 2rem;
  line-height: 2rem;
  padding: 0 0.65rem;
  font-size: 13px;
}

.replay-history__tabs :deep(.el-tabs__content) {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding-right: 0.2rem;
}

.replay-history__tabs :deep(.el-tab-pane) {
  min-height: 100%;
}

.replay-history__tabs :deep(.quality-card-panel) {
  overflow: visible;
  scrollbar-gutter: auto;
}

.replay-history__tabs :deep(.quality-card-view) {
  margin: 2px 0 6px;
}

.replay-history__tabs :deep(.quality-card-filters) {
  gap: 6px;
  margin-bottom: 8px;
}

.replay-history__tabs :deep(.quality-card-filters .el-form-item__label) {
  margin-bottom: 2px;
  line-height: 1.3;
  font-size: 11px;
}

.replay-controls {
  flex: 1 1 20rem;
  min-width: 0;
}

.replay-controls__bar {
  flex-wrap: wrap;
  gap: 0.35rem 0.65rem;
  width: 100%;
}

.replay-controls__slider {
  flex: 1 1 11rem;
  min-width: 9rem;
}

.replay-controls__slider :deep(.el-slider) {
  min-width: 5.5rem;
  flex: 1;
}

.replay-controls__toolbar {
  flex: 0 0 auto;
  gap: 0.3rem;
}

.replay-controls__toolbar :deep(.el-button + .el-button) {
  margin-left: 0;
}

.replay-controls__step {
  padding-inline: 0.45rem;
  min-width: 2.3rem;
  font-variant-numeric: tabular-nums;
}

.replay-controls__toolbar :deep(.el-select) {
  width: 5.8rem;
}

.replay-timeline-strip {
  grid-column: 1 / -1;
  padding: 0.4rem 0.7rem;
}

@media (max-width: 900px) {
  .replays-page {
    height: auto;
    min-height: 100%;
  }

  .replays-page__header :deep(.mission-results) + .replay-controls {
    padding-inline-start: 0;
    border-inline-start: 0;
  }

  .replays-page__body,
  .replays-page__body--engine {
    grid-template-columns: 1fr;
  }

  .replay-event-detail,
  .replay-timeline-strip {
    grid-column: 1;
  }

  .replay-event-detail--engine {
    overflow: visible;
  }

  .replay-controls__toolbar {
    flex-wrap: wrap;
  }
}
</style>

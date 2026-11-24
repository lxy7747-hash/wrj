<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'
import OfflineSituationMap from '../../components/situation/OfflineSituationMap.vue'
import LinkQualityDialog from '../../components/situation/LinkQualityDialog.vue'
import ReplayTimeline from '../../components/replays/ReplayTimeline.vue'
import MissionResults from '../../components/situation/MissionResults.vue'
import EngineFramePanel from '../../components/situation/EngineFramePanel.vue'
import type { Link, ReplayState } from '../../contracts/domain-models'
import { useReplayStore } from '../../stores/replay'
import { selectFileCommunicationLinks } from '../../features/situation/file-communication-links'
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
  configuredJammers,
  scenarioConfig,
} = storeToRefs(replayStore)
const historyTab = ref('quality')
const currentTimeS = computed(() => replay.value?.currentTimeS ?? 0)
const useSceneSituationMode = computed(() => Boolean(scenarioConfig.value && engineHistory.value?.frameCount))
const nodeNames = computed(() => Object.fromEntries([
  ...(localSnapshot.value?.initial.nodes ?? []).map(node => [node.platformId, node.name] as const),
  ...(scenarioConfig.value?.platforms ?? []).map(platform => [platform.id, platform.name] as const),
]))
const mapNodes = computed(() => selectReplayMapNodes(localSnapshot.value, scenarioConfig.value, currentTimeS.value, Boolean(scenarioConfig.value)))
const sceneLinkView = computed(() => (useSceneSituationMode.value && scenarioConfig.value && engineHistory.value
  ? selectReplayConfiguredLinks(scenarioConfig.value, engineHistory.value)
  : null))
const mapConfiguredLinks = computed(() => sceneLinkView.value?.configuredLinks)
const mapFocusLinks = computed(() => sceneLinkView.value?.focusLinks ?? [])
const configuredLinkStatuses = computed(() => sceneLinkView.value?.statuses)
const configuredLinkSwitches = computed(() => sceneLinkView.value?.switches)
const liveMessageFlows = computed(() => (useSceneSituationMode.value && engineHistory.value?.engineFrame
  ? selectReplayLiveMessageFlows(localSnapshot.value?.initial.messageLinks, currentTimeS.value, speed.value, state.value === 'PLAYING')
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
  time: typeof node.time === 'number' ? node.time : currentTimeS.value,
  platformId: node.platformId,
  longitude: node.longitude,
  latitude: node.latitude,
  altitude: node.altitude,
  speed: node.speed,
  heading: node.heading,
})))

function openConfiguredLinkDetails(link: Link): void {
  selectedLinkId.value = link.id
  linkDialogVisible.value = true
}

watch(selectedConfiguredLink, link => {
  if (!link) linkDialogVisible.value = false
})

/** 将回放状态转换为中文。 */
function replayStateLabel(value: ReplayState): string {
  return ({
    EMPTY: '空', LOADING: '加载中', PAUSED: '已暂停', PLAYING: '播放中', SEEKING: '定位中',
    COMPLETED: '已完成', CORRUPT: '数据损坏', ERROR: '错误',
  } as const)[value]
}

/** 返回回放状态对应的标签类型。 */
function replayStateType(value: ReplayState): 'success' | 'warning' | 'danger' | 'info' {
  if (value === 'PLAYING') return 'success'
  if (value === 'CORRUPT' || value === 'ERROR') return 'danger'
  if (value === 'PAUSED' || value === 'SEEKING') return 'warning'
  return 'info'
}

/** 把秒数格式化为 HH:MM:SS。 */
function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor(total % 3_600 / 60)
  const remainder = total % 60
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':')
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
  linkDialogVisible.value = false
  await replayStore.loadLocalFile(archiveId.value, resultId.value)
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

onMounted(() => { void reload() })
watch([archiveId, resultId], () => { void reload() })
onBeforeUnmount(() => {
  replayStore.resetToSafeEmpty()
})
</script>

<template>
  <section class="replays-page" :class="{ 'replays-page--map-fullscreen': mapFullscreen }" aria-label="历史回放">
    <header class="replays-page__header">
      <MissionResults view="replay" />
<!--      <div>-->
<!--        <p class="eyebrow">运行快照与事件复盘</p>-->
<!--        <h2 id="replays-title">历史回放</h2>-->
<!--        <p>只读回放不会修改仿真运行、场景配置或实时遥测。</p>-->
<!--      </div>-->
      <div class="replays-page__source">
        <span v-if="localSnapshot">{{ localSnapshot.fileName }}</span>
        <span v-else>本地文件回放</span>
        <el-tag :type="replayStateType(state)" effect="plain">{{ replayStateLabel(state) }}</el-tag>
      </div>
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
    <el-empty v-else-if="!replay || !localSnapshot" description="暂无本地回放数据，请配置数据文件后重新加载。" />

    <main v-else class="replays-page__body" :class="{ 'replays-page__body--engine': engineHistory?.frameCount }">
      <section class="replay-view" aria-label="回放视窗">
        <OfflineSituationMap
          :key="`${localSnapshot.initial.sha256}:${localSnapshot.sha256}`"
          :source-key="`${localSnapshot.initial.sha256}:${localSnapshot.sha256}`"
          :frame="null"
          :engine-frame="engineHistory?.engineFrame"
          engine-source-label="历史引擎数据"
          :position-replay="localSnapshot"
          :initial-nodes="mapNodes"
          :configured-links="mapConfiguredLinks"
          :focus-links="mapFocusLinks"
          :configured-link-statuses="configuredLinkStatuses"
          :configured-link-switches="configuredLinkSwitches"
          :configured-jammers="configuredJammers ?? undefined"
          :configured-environment="scenarioConfig?.scenario?.environment"
          :live-message-flows="liveMessageFlows"
          :live-flow-playing="state === 'PLAYING'"
          :live-flow-key="`${localSnapshot.initial.sha256}:${localSnapshot.sha256}:${fileSeekRevision}`"
          :file-links="fileLinks"
          :file-message-links="useSceneSituationMode ? [] : localSnapshot.initial.messageLinks"
          :file-device-events="useSceneSituationMode ? [] : localSnapshot?.initial.deviceEvents"
          :file-time="currentTimeS"
          :file-playing="state === 'PLAYING'"
          :file-speed="speed"
          :file-seek-revision="fileSeekRevision"
          :links="[]"
          :selected-node-id="selectedNodeId"
          :focus-target="focusTarget"
          @select-node="selectedNodeId = $event"
          @select-configured-link="openConfiguredLinkDetails"
          @fullscreen-change="mapFullscreen = $event"
        />
        <div class="replay-view__badge">{{ engineHistory?.frameCount ? '历史回放' : '文件回放' }} · {{ formatTime(replay.currentTimeS) }}</div>
      </section>

      <aside class="replay-event-detail" :class="{ 'replay-event-detail--engine': Boolean(engineHistory) }" aria-label="回放数据" data-testid="replay-event-detail">
        <div class="replay-summary">
          <div class="panel-title">
            <div class="panel-title__left">
              <strong>回放数据</strong>
              <span v-if="resultId" class="panel-title__hint">正在回放所选运行</span>
              <span v-else-if="!archiveId" class="panel-title__hint">可重新加载新增记录</span>
            </div>
            <span class="panel-title__meta">{{ mapNodes.length }} 个节点</span>
          </div>
          <dl class="replay-summary__stats">
            <div :title="localSnapshot.initial.fileName">
              <dt>初始化来源</dt>
              <dd>{{ localSnapshot.initial.fileName }}</dd>
            </div>
            <div>
              <dt>位置记录</dt>
              <dd>{{ localSnapshot.recordCount }} 条</dd>
            </div>
            <div>
              <dt>位置更新节点</dt>
              <dd>{{ localSnapshot.tracks.length }} 个</dd>
            </div>
          </dl>
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
          <p v-if="!useSceneSituationMode" class="replay-summary__note">图中通信关联不代表链路已接通。</p>
          <el-alert v-if="localSnapshot.waitingForLine" title="文件尾部尚有未写完的记录，写入完成后可重新加载。" type="info" :closable="false" />
          <el-alert v-if="localSnapshot.issueCount" :title="`已跳过 ${localSnapshot.issueCount} 条异常记录`"
            :description="localSnapshot.issues.map((issue) => `第 ${issue.line} 行：${issue.message}`).join('；')" type="warning" :closable="false" />
        </div>

        <section v-if="engineHistory" class="replay-history" aria-label="历史引擎数据" data-testid="replay-engine-history">
          <div class="panel-title replay-history__title">
            <strong>历史引擎数据</strong>
            <div class="replay-history__meta">
              <span v-if="engineLoading" class="replay-history__loading" role="status">读取中…</span>
              <el-select v-if="engineHistory.epochs.length > 1" size="small" class="replay-history__epoch" :model-value="engineHistory.engineEpoch" aria-label="引擎轮次" @update:model-value="replayStore.selectEngineEpoch">
                <el-option v-for="epoch in engineHistory.epochs" :key="epoch.engineEpoch" :value="epoch.engineEpoch" :label="`轮次 ${epoch.engineEpoch + 1} · ${epoch.frameCount} 帧`" />
              </el-select>
              <span class="panel-title__meta">{{ engineHistory.frameCount }} 帧</span>
            </div>
          </div>
          <p v-if="!engineHistory.engineFrame" class="replay-history__empty">{{ engineHistory.frameCount ? '当前时刻尚未收到引擎帧。' : '本次运行没有收到引擎帧。' }}</p>
          <template v-else>
            <p v-if="engineHistory.historyTruncated" class="replay-history__note">事件、切换和告警分别显示游标前最近 200 条；完整数据仍保存在历史归档中。</p>
            <el-tabs v-model="historyTab" class="replay-history__tabs">
              <el-tab-pane label="质量指标" name="quality"><EngineFramePanel section="quality" :evidence="engineHistory" :links="engineHistory.links" :node-names="nodeNames" /></el-tab-pane>
              <el-tab-pane label="干扰与探测" name="jammers"><EngineFramePanel section="jammers" :evidence="engineHistory" :links="engineHistory.links" :node-names="nodeNames" /></el-tab-pane>
              <el-tab-pane label="选路与告警" name="decisions"><EngineFramePanel section="decisions" :evidence="engineHistory" :links="engineHistory.links" :node-names="nodeNames" /></el-tab-pane>
              <el-tab-pane label="事件" name="events"><EngineFramePanel section="events" :evidence="engineHistory" :links="engineHistory.links" :node-names="nodeNames" /></el-tab-pane>
            </el-tabs>
          </template>
        </section>
        <p v-else-if="resultId && !engineLoading" class="replay-summary__note">本次结果没有引擎帧归档，保留文件轨迹回放。</p>
      </aside>

      <section class="replay-controls" aria-label="回放控制">
        <ReplayTimeline
          :replay="replay"
          :events="events"
          :engine-markers="localizedTimelineMarkers"
          :selected-event-id="selectedEventId"
          @select="selectedEventId = $event"
          @seek="seek"
        />
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
        <div class="replay-controls__toolbar">
          <el-button :disabled="replay.currentTimeS <= 0" @click="replayStore.step('back')">后退 1 秒</el-button>
          <el-button type="primary" data-testid="replay-play" :disabled="replay.durationS === 0" @click="togglePlayback">{{ state === 'PLAYING' ? '暂停' : '播放' }}</el-button>
          <el-button :disabled="replay.currentTimeS >= replay.durationS" @click="replayStore.step('forward')">前进 1 秒</el-button>
          <el-select :model-value="speed" aria-label="回放倍速" @update:model-value="changeSpeed">
            <el-option :value="1" label="倍速 ×1" />
            <el-option :value="2" label="×2" />
            <el-option :value="4" label="×4" />
            <el-option :value="8" label="×8" />
            <el-option :value="16" label="×16" />
            <el-option :value="32" label="×32" />
          </el-select>
        </div>
      </section>
    </main>

    <LinkQualityDialog
      v-model="linkDialogVisible"
      :link="null"
      :configured-link="selectedConfiguredLink"
      :engine-segments="selectedEngineSegments"
      :engine-frame="engineHistory?.engineFrame"
      engine-source-label="历史引擎数据"
      :node-positions="linkNodePositions"
      :platforms="scenarioConfig?.platforms ?? []"
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
/* 全屏时隐藏右侧回放数据栏，让地图占满主区域；顶部运行结果和底部回放控制保留。 */
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
  gap: 1rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--console-border);
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

.replays-page__source,
.panel-title,
.replay-controls__slider,
.replay-controls__toolbar {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}

.replays-page__source :deep(.el-select) {
  width: 15rem;
}

.replays-page__source {
  flex: 1 1 12rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

.replays-page__reload {
  margin-inline-start: auto;
}

.replays-page__body {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(0, 1fr) 18rem;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 0.75rem;
  padding: 0.75rem;
}

.replays-page__loading {
  padding: 1rem;
}

.replays-page__body--engine { grid-template-columns: minmax(0, 1fr) minmax(24rem, 36%); }

.replay-view,
.replay-event-detail,
.replay-controls {
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
  padding: 0.65rem 0.75rem;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.replay-event-detail--engine {
  overflow: hidden;
}

.replay-summary {
  flex: 0 0 auto;
  display: grid;
  gap: 0.5rem;
  padding-bottom: 0.6rem;
  border-bottom: 1px solid var(--console-border);
}

.panel-title {
  justify-content: space-between;
  padding-bottom: 0.45rem;
  border-bottom: 1px solid var(--console-border);
}

.panel-title__left {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
}

.panel-title__hint {
  color: var(--console-text-muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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

.replay-summary__stats {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 0.85fr) minmax(0, 0.85fr);
  gap: 0.45rem;
  margin: 0;
}

.replay-summary__stats > div {
  min-width: 0;
  padding: 0.35rem 0.5rem;
  border: 1px solid color-mix(in srgb, var(--console-border) 80%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--console-bg-elevated) 72%, transparent);
}

.replay-summary__stats dt {
  color: var(--console-text-muted);
  font-size: 11px;
  line-height: 1.3;
  white-space: nowrap;
}

.replay-summary__stats dd {
  margin: 0.15rem 0 0;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  gap: 0.45rem;
  margin-top: 0.6rem;
}

.replay-history__title {
  flex: 0 0 auto;
  min-height: 1.75rem;
  padding-bottom: 0.4rem;
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
  margin: 0 0 0.45rem;
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
  grid-column: 1 / -1;
  display: grid;
  gap: 0.6rem;
  padding: 0.75rem;
}

.replay-controls__slider :deep(.el-slider) {
  min-width: 8rem;
  flex: 1;
}

.replay-controls__toolbar {
  justify-content: center;
}

.replay-controls__toolbar :deep(.el-select) {
  width: 6.8rem;
}

@media (max-width: 900px) {
  .replays-page {
    height: auto;
    min-height: 100%;
  }

  .replays-page__body,
  .replays-page__body--engine {
    grid-template-columns: 1fr;
  }

  .replay-event-detail,
  .replay-controls {
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

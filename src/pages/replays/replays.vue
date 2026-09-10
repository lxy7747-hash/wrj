<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import OfflineSituationMap from '../../components/situation/OfflineSituationMap.vue'
import ReplayTimeline from '../../components/replays/ReplayTimeline.vue'
import type { ReplayState } from '../../contracts/domain-models'
import { selectSituationLinks } from '../../features/situation/situation-model'
import { replayEventTime, useReplayStore } from '../../stores/replay'
import { useTelemetryStore } from '../../stores/telemetry'
import { selectReplayNodes } from '../../features/replays/local-replay'
import { selectFileCommunicationLinks } from '../../features/situation/file-communication-links'
import type { SituationMapFocusTarget } from '../../components/situation/situation-map-controller'

const replayStore = useReplayStore()
const telemetryStore = useTelemetryStore()
const { replay, replays, events, state, speed, selectedEventId, resultMessage, localSnapshot } = storeToRefs(replayStore)
const { frame: mockFrame, capabilityState: telemetryState, resultMessage: telemetryMessage } = storeToRefs(telemetryStore)
const sourceKind = ref<'LOADING' | 'FILE' | 'MOCK'>('LOADING')
const frame = computed(() => sourceKind.value === 'MOCK' ? mockFrame.value : null)
const fileNodes = computed(() => localSnapshot.value ? selectReplayNodes(localSnapshot.value, replay.value?.currentTimeS ?? 0) : [])
// 以回放游标筛选登记，不使用实时位置时刻，向后定位时也移除未来关联。
const fileLinks = computed(() => selectFileCommunicationLinks(localSnapshot.value?.initial.connections ?? [], replay.value?.currentTimeS ?? 0))
const focusTarget = ref<SituationMapFocusTarget | null>(null)
const selectedNodeId = ref('')
const sliderTime = ref(0)
const sliderDragging = ref(false)
let disposed = false

const links = computed(() => frame.value === null ? [] : selectSituationLinks(frame.value))
const selectedEvent = computed(() => events.value.find((event) => event.eventId === selectedEventId.value) ?? null)
const loading = computed(() => sourceKind.value === 'LOADING' || state.value === 'LOADING'
  || (sourceKind.value === 'MOCK' && telemetryState.value === 'LOADING'))

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

/** 重新加载只读遥测帧和回放记录。 */
async function reload(): Promise<void> {
  sourceKind.value = 'LOADING'
  sliderDragging.value = false
  focusTarget.value = null
  const localLoaded = await replayStore.loadLocalFile()
  if (disposed) return
  if (localLoaded !== null) {
    sourceKind.value = 'FILE'
    telemetryStore.disconnectAndReset()
    return
  }
  sourceKind.value = 'MOCK'
  const telemetryLoaded = await telemetryStore.loadFrame('RUN-001', 'F-00042')
  if (!disposed && telemetryLoaded) await replayStore.load()
}

/** 选中节点仍存在时保留高亮；时间变化不自动重置视图或选择。 */
watch([frame, fileNodes], ([value, nodes]) => {
  const displayed = value?.platforms ?? nodes
  if (!displayed.some((node) => node.platformId === selectedNodeId.value)) selectedNodeId.value = displayed[0]?.platformId ?? ''
}, { immediate: true })

/** 将地图定位到真实节点，platformId 为节点原始名称，不改动西经或其他真实坐标。 */
function locateFileNode(platformId: string): void {
  selectedNodeId.value = platformId
  focusTarget.value = { kind: 'node', targetId: platformId }
}

onMounted(() => { void reload() })
onBeforeUnmount(() => {
  disposed = true
  replayStore.resetToSafeEmpty()
  telemetryStore.resetToSafeEmpty()
})
</script>

<template>
  <section class="replays-page" aria-label="历史回放">
    <header class="replays-page__header">
<!--      <div>-->
<!--        <p class="eyebrow">运行快照与事件复盘</p>-->
<!--        <h2 id="replays-title">历史回放</h2>-->
<!--        <p>只读回放不会修改仿真运行、场景配置或实时遥测。</p>-->
<!--      </div>-->
      <div class="replays-page__source">
        <span v-if="localSnapshot">{{ localSnapshot.fileName }}</span>
        <el-select v-else :model-value="replay?.replayId ?? ''" aria-label="回放来源" :disabled="loading || replays.length === 0">
          <el-option v-for="item in replays" :key="item.replayId" :value="item.replayId" :label="`${item.replayId} · ${item.runId}`" />
        </el-select>
        <el-tag :type="replayStateType(state)" effect="plain">{{ replayStateLabel(state) }}</el-tag>
      </div>
      <el-button :loading="loading" :disabled="loading" @click="reload">重新加载</el-button>
    </header>

    <el-skeleton v-if="loading" class="replays-page__loading" :rows="10" animated />
    <el-result
      v-else-if="state === 'CORRUPT' || state === 'ERROR' || (sourceKind === 'MOCK' && telemetryState === 'ERROR')"
      :icon="state === 'CORRUPT' ? 'warning' : 'error'"
      :title="state === 'CORRUPT' ? '回放数据损坏' : '历史回放不可用'"
      :sub-title="sourceKind === 'MOCK' && telemetryState === 'ERROR' ? telemetryMessage : resultMessage"
    >
      <template #extra><el-button type="primary" @click="reload">重新加载</el-button></template>
    </el-result>
    <el-empty v-else-if="!replay" description="暂无可用回放记录" />

    <main v-else class="replays-page__body">
      <section class="replay-view" aria-label="回放视窗">
        <OfflineSituationMap
          v-if="frame || localSnapshot"
          :key="localSnapshot ? `${localSnapshot.initial.sha256}:${localSnapshot.sha256}` : 'mock'"
          :frame="frame"
          :initial-nodes="localSnapshot ? fileNodes : undefined"
          :file-links="fileLinks"
          :links="links"
          :selected-node-id="selectedNodeId"
          :focus-target="focusTarget"
          @select-node="selectedNodeId = $event"
        />
        <el-empty v-else description="回放态势快照不可用" />
        <div class="replay-view__badge">{{ localSnapshot ? `文件回放 · ${formatTime(replay.currentTimeS)}` : `只读快照 · ${replay.runId} · F-00042` }}</div>
      </section>

      <aside class="replay-event-detail" :aria-label="localSnapshot ? '回放数据' : '回放事件详情'" data-testid="replay-event-detail">
        <template v-if="localSnapshot">
          <div class="panel-title"><strong>回放数据</strong><span>{{ fileNodes.length }} 个节点</span></div>
          <dl>
            <div><dt>初始化来源</dt><dd>{{ localSnapshot.initial.fileName }}</dd></div>
            <div><dt>位置记录</dt><dd>{{ localSnapshot.recordCount }} 条</dd></div>
            <div><dt>位置更新节点</dt><dd>{{ localSnapshot.tracks.length }} 个</dd></div>
          </dl>
          <div class="replay-node-field">
            <label for="replay-node-select">节点定位</label>
            <div class="replay-node-location">
              <el-select id="replay-node-select" :model-value="selectedNodeId" aria-label="回放节点定位" @update:model-value="locateFileNode">
                <el-option v-for="node in fileNodes" :key="node.platformId" :value="node.platformId" :label="node.name" />
              </el-select>
              <el-button :disabled="!selectedNodeId" @click="locateFileNode(selectedNodeId)">定位</el-button>
            </div>
          </div>
          <p>按时间读取最后一条位置；暂无更新的节点保留初始化位置。重新加载可读取新增记录。</p>
          <p>按回放时刻展示位置及已登记的卫星、微波关联；关联不代表链路已接通，不展示模拟链路或模拟事件。</p>
          <el-alert v-if="localSnapshot.waitingForLine" title="文件尾部尚有未写完的记录，写入完成后可重新加载。" type="info" :closable="false" />
          <el-alert v-if="localSnapshot.issueCount" :title="`已跳过 ${localSnapshot.issueCount} 条异常记录`"
            :description="localSnapshot.issues.map((issue) => `第 ${issue.line} 行：${issue.message}`).join('；')" type="warning" :closable="false" />
        </template>
        <div v-else class="panel-title"><strong>事件详情</strong><span>{{ events.length }} 条事件</span></div>
        <template v-if="!localSnapshot && selectedEvent">
          <dl>
            <div><dt>事件编号</dt><dd>{{ selectedEvent.eventId }}</dd></div>
            <div><dt>类型</dt><dd>{{ selectedEvent.type === 'DETECTION' ? '目标侦测' : '链路切换' }}</dd></div>
            <div><dt>登记时刻</dt><dd>T+{{ replayEventTime(selectedEvent) }} s</dd></div>
            <div><dt>关联帧</dt><dd>{{ selectedEvent.frameId }}</dd></div>
            <div v-if="selectedEvent.type === 'DETECTION'"><dt>目标节点</dt><dd>{{ selectedEvent.targetPlatformId }}</dd></div>
            <div v-else><dt>链路变化</dt><dd>{{ selectedEvent.oldLinkId }} → {{ selectedEvent.newLinkId }}</dd></div>
            <div v-if="selectedEvent.type === 'LINK_SWITCH'"><dt>决策</dt><dd>{{ selectedEvent.decision === 'ACCEPTED' ? '接受' : '拒绝' }}</dd></div>
          </dl>
        </template>
        <el-empty v-else-if="!localSnapshot" description="暂无事件" />
      </aside>

      <section class="replay-controls" aria-label="回放控制">
        <ReplayTimeline
          :replay="replay"
          :events="events"
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
            <el-option v-for="value in [0.5, 1, 2, 4]" :key="value" :value="value" :label="`${value}×`" />
          </el-select>
        </div>
      </section>
    </main>
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

.replays-page__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
}

.replay-event-detail {
  min-height: 0;
  padding: 0.75rem;
  overflow: auto;
}

.panel-title {
  justify-content: space-between;
  padding-bottom: 0.6rem;
  border-bottom: 1px solid var(--console-border);
}

.panel-title span,
.replay-controls__slider > span {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
  white-space: nowrap;
}

.replay-event-detail dl {
  display: grid;
  gap: 0;
  margin: 0.5rem 0 0;
}

.replay-event-detail dl > div {
  display: grid;
  grid-template-columns: 6.5rem minmax(0, 1fr);
  gap: 0.75rem;
  padding: 0.55rem 0;
  border-bottom: 1px solid var(--console-border);
}

.replay-event-detail dt {
  color: var(--console-text-muted);
  white-space: nowrap;
}

.replay-event-detail dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.replay-node-field {
  display: grid;
  gap: 0.5rem;
  padding: 0.85rem 0;
  border-bottom: 1px solid var(--console-border);
}

.replay-node-field label {
  color: var(--console-text-muted);
}

.replay-node-location {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.replay-node-location :deep(.el-select) {
  min-width: 0;
  flex: 1;
}

.replay-node-location :deep(.el-button) {
  flex: none;
  padding-inline: 0.75rem;
}

.replay-event-detail > p {
  margin: 0.75rem 0;
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
  line-height: 1.7;
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
  width: 6rem;
}

@media (max-width: 900px) {
  .replays-page {
    height: auto;
    min-height: 100%;
  }

  .replays-page__header {
    align-items: flex-start;
    flex-direction: column;
  }

  .replays-page__body {
    grid-template-columns: 1fr;
  }

  .replay-event-detail,
  .replay-controls {
    grid-column: 1;
  }

  .replay-controls__toolbar {
    flex-wrap: wrap;
  }
}
</style>

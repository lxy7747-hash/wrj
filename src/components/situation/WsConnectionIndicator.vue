<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { WsConnectionState, WsTopic } from '../../contracts/domain-models'
import { formatSimulationTime } from '../../features/situation/situation-model'
import { useTelemetryStore } from '../../stores/telemetry'

const props = withDefaults(defineProps<{
  /** 当前是否存在运行中或暂停中的仿真，用于区分「待连接」与「运行中断开」。 */
  simulationActive?: boolean
}>(), { simulationActive: false })

const telemetry = useTelemetryStore()

const CORE_TOPICS: Array<{ id: WsTopic; label: string }> = [
  { id: 'simulation.frame', label: '仿真帧' },
  { id: 'runtime.state', label: '运行状态' },
  { id: 'link.metric', label: '链路指标' },
  { id: 'jammer.event', label: '干扰事件' },
  { id: 'switch.event', label: '切换事件' },
]

type Tone = 'success' | 'info' | 'warning' | 'danger' | 'muted'

const hadConnectedOnce = ref(false)
const hadInterrupted = ref(false)
let connectionNotice: ReturnType<typeof ElMessage.warning> | undefined

function notifyConnection(type: 'warning' | 'error' | 'success', message: string): void {
  connectionNotice?.close()
  connectionNotice = ElMessage[type](message)
}

watch([() => telemetry.connectionState, () => telemetry.requestEpoch], ([next, epoch], [prev, previousEpoch]) => {
  // 切换运行或数据源会重置遥测，随后建立的是新订阅。
  if (previousEpoch !== undefined && epoch !== previousEpoch) {
    connectionNotice?.close()
    connectionNotice = undefined
    hadConnectedOnce.value = next === 'SUBSCRIBED'
    hadInterrupted.value = false
    return
  }
  if (next === 'SUBSCRIBED') hadConnectedOnce.value = true
  if (!prev || next === prev) return
  if (prev === 'SUBSCRIBED' && next === 'RETRYING') {
    hadInterrupted.value = true
    notifyConnection('warning', 'WebSocket 连接中断，正在尝试自动重连…')
  } else if (prev === 'SUBSCRIBED' && next === 'DISCONNECTED') {
    hadInterrupted.value = true
    notifyConnection('warning', 'WebSocket 连接已断开，实时数据推送已暂停。')
  } else if (next === 'FAILED') {
    hadInterrupted.value = true
    notifyConnection('error', 'WebSocket 连接中断且重连失败，请点击顶栏「重连」恢复。')
  } else if (next === 'SUBSCRIBED' && (prev === 'RETRYING' || prev === 'FAILED' || hadInterrupted.value)) {
    hadInterrupted.value = false
    notifyConnection('success', 'WebSocket 连接已恢复，实时数据继续推送。')
  }
}, { immediate: true })

onBeforeUnmount(() => connectionNotice?.close())

watch(() => props.simulationActive, active => {
  if (!active && telemetry.connectionState === 'DISCONNECTED') {
    hadConnectedOnce.value = false
    hadInterrupted.value = false
  }
})

const isIdleDisconnected = computed(() => (
  telemetry.connectionState === 'DISCONNECTED' && !props.simulationActive && !hadConnectedOnce.value
))

const stateMeta = computed<{ short: string; label: string; tone: Tone }>(() => {
  const state = telemetry.connectionState
  if (state === 'SUBSCRIBED') return { short: 'WS 已连接', label: '已连接 · 实时订阅', tone: 'success' }
  if (state === 'CONNECTING') return { short: 'WS 连接中', label: '正在建立连接…', tone: 'info' }
  if (state === 'RETRYING') {
    return {
      short: telemetry.retryAttemptCount > 0 ? `WS 重连中 #${telemetry.retryAttemptCount}` : 'WS 重连中',
      label: '连接中断 · 自动重连中',
      tone: 'warning',
    }
  }
  if (state === 'FAILED') return { short: 'WS 连接中断', label: '连接中断 · 重连失败', tone: 'danger' }
  if (isIdleDisconnected.value) return { short: 'WS 待连接', label: '待仿真启动后自动连接', tone: 'muted' }
  return {
    short: 'WS 已断开',
    label: props.simulationActive ? '前端已断开 · 后台仿真继续推演' : '已断开连接',
    tone: props.simulationActive ? 'danger' : 'muted',
  }
})

const isActiveOrConnecting = computed(() => (
  telemetry.connectionState === 'SUBSCRIBED'
  || telemetry.connectionState === 'CONNECTING'
  || telemetry.connectionState === 'RETRYING'
))

const showQuickReconnect = computed(() => (
  telemetry.connectionState === 'FAILED'
  || (telemetry.connectionState === 'DISCONNECTED' && (props.simulationActive || hadConnectedOnce.value))
))

const topicRows = computed(() => CORE_TOPICS.map(topic => ({
  ...topic,
  sequence: telemetry.topicSequences[topic.id] ?? 0,
})))
const headerRows = computed(() => (
  telemetry.recentMessageHeaders.length
    ? telemetry.recentMessageHeaders
    : telemetry.lastMessageHeader
      ? [telemetry.lastMessageHeader]
      : []
))
const recentHistory = computed(() => telemetry.connectionHistory.slice(0, 8))

function disconnectWs(): void {
  telemetry.pauseConnection()
}

function reconnectWs(): void {
  telemetry.reconnectNow()
}

async function resyncWs(): Promise<void> {
  await telemetry.recoverFromGap('resume')
}

function stateBadgeTone(state: WsConnectionState): Tone {
  return {
    SUBSCRIBED: 'success',
    CONNECTING: 'info',
    RETRYING: 'warning',
    FAILED: 'danger',
    DISCONNECTED: 'muted',
  }[state] as Tone
}

function stateBadgeLabel(state: WsConnectionState): string {
  return {
    SUBSCRIBED: '已连接',
    CONNECTING: '连接中',
    RETRYING: '重连中',
    FAILED: '已中断',
    DISCONNECTED: '已断开',
  }[state]
}
</script>

<template>
  <div class="ws-indicator-wrap">
    <el-popover
      trigger="click"
      placement="bottom-end"
      :width="440"
      popper-class="ws-status-popover"
    >
      <template #reference>
        <button
          type="button"
          class="ws-pill"
          :class="`ws-pill--${stateMeta.tone}`"
          :title="`WebSocket 状态：${stateMeta.label}（点击查看消息头与断连控制）`"
          data-testid="ws-connection-pill"
        >
          <span class="ws-pill__dot" aria-hidden="true" />
          <span class="ws-pill__text">{{ stateMeta.short }}</span>
        </button>
      </template>

      <div class="ws-panel" data-testid="ws-connection-panel">
        <header class="ws-panel__head">
          <div>
            <strong class="ws-panel__title">WebSocket 实时推送</strong>
            <span class="ws-panel__status" :class="`is-${stateMeta.tone}`" data-testid="ws-connection-state-label">
              {{ stateMeta.label }}
            </span>
          </div>
          <div class="ws-panel__actions">
            <el-button
              v-if="isActiveOrConnecting"
              size="small"
              type="warning"
              plain
              data-testid="ws-disconnect-btn"
              @click="disconnectWs"
            >断开连接</el-button>
            <el-button
              v-else
              size="small"
              type="primary"
              data-testid="ws-reconnect-btn"
              @click="reconnectWs"
            >恢复连接</el-button>
            <el-button
              size="small"
              plain
              :disabled="telemetry.connectionState === 'DISCONNECTED'"
              data-testid="ws-resync-btn"
              @click="resyncWs"
            >重连续传</el-button>
          </div>
        </header>

        <section class="ws-panel__section" data-testid="ws-last-header">
          <h4>最近业务消息头（近 5 条）</h4>
          <div v-if="headerRows.length" class="ws-panel__stream" data-testid="ws-recent-headers">
            <div class="ws-panel__stream-row is-head">
              <span>类型（topic）</span>
              <span>仿真时刻</span>
              <span>序列号</span>
              <span>版本</span>
            </div>
            <div v-for="(item, idx) in headerRows" :key="`${item.topic}-${item.sequence}-${idx}`" class="ws-panel__stream-row">
              <code :title="item.topic">{{ item.topic }}</code>
              <span>{{ item.simulationTime !== undefined ? formatSimulationTime(item.simulationTime) : '—' }}</span>
              <strong class="ws-panel__topic-seq">#{{ item.sequence }}</strong>
              <code>v{{ item.schemaVersion }}</code>
            </div>
          </div>
          <p v-else class="ws-panel__empty">尚未收到实时推送消息。</p>
        </section>

        <section class="ws-panel__section" data-testid="ws-topic-sequences">
          <h4>主题连续序号</h4>
          <div class="ws-panel__topics">
            <div v-for="row in topicRows" :key="row.id" class="ws-panel__topic-row">
              <span class="ws-panel__topic-name">{{ row.label }}</span>
              <code class="ws-panel__topic-id">{{ row.id }}</code>
              <strong class="ws-panel__topic-seq">#{{ row.sequence }}</strong>
            </div>
          </div>
        </section>

        <section class="ws-panel__section" data-testid="ws-connection-history">
          <h4>连接状态记录</h4>
          <ul v-if="recentHistory.length" class="ws-panel__history">
            <li v-for="(item, idx) in recentHistory" :key="idx">
              <span class="ws-panel__history-time">{{ item.at }}</span>
              <span class="ws-panel__history-tag" :class="`is-${stateBadgeTone(item.state)}`">{{ stateBadgeLabel(item.state) }}</span>
              <span class="ws-panel__history-detail">{{ item.detail }}</span>
            </li>
          </ul>
          <p v-else class="ws-panel__empty">暂无连接变更记录。</p>
        </section>
      </div>
    </el-popover>

    <button
      v-if="showQuickReconnect"
      type="button"
      class="ws-quick-reconnect"
      title="立即恢复 WebSocket 连接并续传"
      data-testid="ws-quick-reconnect"
      @click="reconnectWs"
    >重连</button>
  </div>
</template>

<style scoped>
.ws-indicator-wrap {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 5px;
}

.ws-pill {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid #27435f;
  border-radius: 999px;
  background: rgba(11, 31, 49, 0.9);
  color: #cfe4f5;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}

.ws-pill:hover {
  border-color: #4bd9f2;
  background: rgba(18, 47, 72, 0.95);
}

.ws-pill__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.ws-pill--success {
  border-color: rgba(46, 204, 113, 0.45);
  color: #7ef2b2;
}
.ws-pill--success .ws-pill__dot {
  background: #2ecc71;
  box-shadow: 0 0 0 0 rgba(46, 204, 113, 0.7);
  animation: ws-pulse 2s infinite;
}

.ws-pill--info {
  border-color: rgba(75, 217, 242, 0.45);
  color: #7ee3f7;
}
.ws-pill--info .ws-pill__dot {
  background: #4bd9f2;
  animation: ws-blink 1s infinite;
}

.ws-pill--warning {
  border-color: rgba(245, 185, 66, 0.65);
  background: rgba(74, 49, 10, 0.65);
  color: #ffd166;
}
.ws-pill--warning .ws-pill__dot {
  background: #f5b942;
  animation: ws-blink 0.8s infinite;
}

.ws-pill--danger {
  border-color: rgba(255, 102, 122, 0.7);
  background: rgba(74, 16, 26, 0.72);
  color: #ff8a99;
}
.ws-pill--danger .ws-pill__dot {
  background: #ff5c72;
}

.ws-pill--muted {
  border-color: rgba(138, 166, 184, 0.4);
  color: #9bb3c4;
}
.ws-pill--muted .ws-pill__dot {
  background: #7c95a6;
}

.ws-quick-reconnect {
  flex-shrink: 0;
  padding: 4px 8px;
  border: 1px solid rgba(75, 217, 242, 0.55);
  border-radius: 999px;
  background: rgba(14, 143, 224, 0.22);
  color: #7ee3f7;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  cursor: pointer;
}

.ws-quick-reconnect:hover {
  background: rgba(14, 143, 224, 0.38);
  color: #ffffff;
}

@keyframes ws-pulse {
  0% { box-shadow: 0 0 0 0 rgba(46, 204, 113, 0.65); }
  70% { box-shadow: 0 0 0 6px rgba(46, 204, 113, 0); }
  100% { box-shadow: 0 0 0 0 rgba(46, 204, 113, 0); }
}

@keyframes ws-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.ws-panel {
  display: grid;
  gap: 10px;
  color: #d3e5f2;
  font-size: 12px;
}

.ws-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid #223c52;
}

.ws-panel__title {
  display: block;
  color: #eef6fc;
  font-size: 13px;
}

.ws-panel__status {
  display: inline-block;
  margin-top: 2px;
  font-size: 11px;
  font-weight: 600;
}
.ws-panel__status.is-success { color: #5ce69b; }
.ws-panel__status.is-info { color: #4bd9f2; }
.ws-panel__status.is-warning { color: #f5b942; }
.ws-panel__status.is-danger { color: #ff667a; }
.ws-panel__status.is-muted { color: #8aa6b8; }

.ws-panel__actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
}

.ws-panel__section h4 {
  margin: 0 0 6px;
  color: #8fb6d9;
  font-size: 11px;
  font-weight: 600;
}

.ws-panel__stream {
  display: grid;
  gap: 3px;
  padding: 6px 8px;
  border: 1px solid #1e384d;
  border-radius: 5px;
  background: rgba(7, 23, 37, 0.55);
}

.ws-panel__stream-row {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) 78px 54px 44px;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.ws-panel__stream-row.is-head {
  padding-bottom: 3px;
  border-bottom: 1px solid rgba(34, 60, 82, 0.8);
  color: #8aa6b8;
}

.ws-panel__stream-row code {
  overflow: hidden;
  color: #d3e5f2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-panel__topics {
  display: grid;
  gap: 4px;
}

.ws-panel__topic-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  border-radius: 4px;
  background: rgba(12, 33, 51, 0.55);
}

.ws-panel__topic-name {
  color: #d3e5f2;
}

.ws-panel__topic-id {
  color: #8aa6b8;
  font-size: 11px;
}

.ws-panel__topic-seq {
  color: #4bd9f2;
  font-family: Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

.ws-panel__history {
  margin: 0;
  padding: 0;
  max-height: 132px;
  overflow-y: auto;
  list-style: none;
  display: grid;
  gap: 4px;
}

.ws-panel__history li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
  line-height: 1.4;
}

.ws-panel__history-time {
  flex-shrink: 0;
  color: #8aa6b8;
  font-family: Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

.ws-panel__history-tag {
  flex-shrink: 0;
  font-weight: 600;
}
.ws-panel__history-tag.is-success { color: #5ce69b; }
.ws-panel__history-tag.is-info { color: #4bd9f2; }
.ws-panel__history-tag.is-warning { color: #f5b942; }
.ws-panel__history-tag.is-danger { color: #ff667a; }
.ws-panel__history-tag.is-muted { color: #8aa6b8; }

.ws-panel__history-detail {
  color: #cfe4f5;
  overflow-wrap: anywhere;
}

.ws-panel__empty {
  margin: 0;
  color: #8aa6b8;
  font-size: 11px;
}
</style>

<style>
.el-popover.ws-status-popover {
  --el-bg-color-overlay: #0c1f31;
  --el-border-color-light: #25435e;
  border: 1px solid #25435e;
  background: #0c1f31;
  color: #d3e5f2;
}
</style>

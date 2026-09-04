<script setup lang="ts">
import { computed } from 'vue'
import type { CapabilityState, WsTopic } from '../../contracts/domain-models'
import { useTelemetryStore } from '../../stores/telemetry'
import DataExchangeStateTag from './DataExchangeStateTag.vue'

const telemetry = useTelemetryStore()
const topics: Array<{ id: WsTopic; label: string }> = [
  { id: 'simulation.frame', label: '仿真帧' },
  { id: 'runtime.state', label: '运行状态' },
  { id: 'link.metric', label: '链路指标' },
  { id: 'jammer.event', label: '干扰事件' },
  { id: 'switch.event', label: '切换事件' },
]
const CONNECTION_STATES: Record<typeof telemetry.connectionState, CapabilityState> = {
  DISCONNECTED: 'EMPTY', CONNECTING: 'LOADING', SUBSCRIBED: 'SUCCESS', RETRYING: 'EXECUTING', FAILED: 'ERROR',
}
const state = computed<CapabilityState>(() => telemetry.connectionState === 'DISCONNECTED' && telemetry.capabilityState === 'ERROR'
  ? 'ERROR'
  : CONNECTION_STATES[telemetry.connectionState])
const connectionLabel = computed(() => ({
  DISCONNECTED: '未连接', CONNECTING: '连接中', SUBSCRIBED: '已订阅', RETRYING: '重连中', FAILED: '连接失败',
})[telemetry.connectionState])

/**
 * 返回指定主题已接收的最后序号。
 * @param topic 规范 WebSocket 主题。
 * @returns 对应主题的最后序号，尚未接收时为 0。
 */
function topicSequence(topic: WsTopic): number {
  return telemetry.topicSequences[topic]
}

/** 加载 REST 快照并建立本机回环订阅。 */
async function connect(): Promise<void> {
  if (telemetry.frame === null && !await telemetry.loadFrame()) return
  telemetry.connect()
}

/** 主动执行一次断档补偿和重新订阅。 */
async function resynchronize(): Promise<void> {
  await telemetry.recoverFromGap()
}
</script>

<template>
  <el-card id="de-cap-wstc" class="exchange-card" shadow="never" data-testid="websocket-contract-card">
    <template #header>
      <div class="exchange-card__header">
        <div><p class="eyebrow">T-XQ-024 · VISIBLE_CONTRACT</p><h3>本机消息推送</h3></div>
        <DataExchangeStateTag :state="state" data-testid="websocket-state" />
      </div>
    </template>
    <p class="exchange-card__description">只连接 127.0.0.1；按 topic、schemaVersion、taskId、sequence、simulationTime/frameId 和 payload 处理消息。</p>
    <div class="exchange-card__actions">
      <el-button type="primary" :disabled="telemetry.connectionState === 'SUBSCRIBED'" @click="connect">连接通道</el-button>
      <el-button :disabled="telemetry.frame === null" @click="resynchronize">重新同步</el-button>
    </div>
    <el-alert v-if="telemetry.capabilityState === 'ERROR'" class="exchange-card__result" type="error" :closable="false" :title="telemetry.resultMessage" />
    <el-descriptions :column="2" border size="small">
      <el-descriptions-item label="连接状态">{{ connectionLabel }}</el-descriptions-item>
      <el-descriptions-item label="当前帧">{{ telemetry.frame?.frameId ?? '未加载' }}</el-descriptions-item>
      <el-descriptions-item label="任务">{{ telemetry.frame?.taskId ?? 'TASK-001' }}</el-descriptions-item>
      <el-descriptions-item label="地址">ws://127.0.0.1:4173/ws/v1</el-descriptions-item>
    </el-descriptions>
    <el-table :data="topics" size="small" data-testid="websocket-topics">
      <el-table-column prop="label" label="主题" min-width="110" />
      <el-table-column prop="id" label="Topic" min-width="150" />
      <el-table-column label="最后序号" width="100"><template #default="scope">{{ topicSequence(scope.row.id) }}</template></el-table-column>
    </el-table>
    <p class="exchange-card__note">重复序号丢弃；序号缺口通过 REST 快照补偿；版本不兼容拒绝；断线按固定退避重连。</p>
  </el-card>
</template>

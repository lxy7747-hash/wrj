<script setup lang="ts">
import { computed } from 'vue'
import type { CapabilityState, DetectionEvent } from '../../contracts/domain-models'
import { useAuthStore } from '../../stores/auth'
import { useTelemetryStore } from '../../stores/telemetry'

const authStore = useAuthStore()
const telemetryStore = useTelemetryStore()
const detection = computed(() => telemetryStore.events.find(
  (event): event is DetectionEvent => event.type === 'DETECTION',
) ?? null)
const execution = computed(() => telemetryStore.frame?.evidence.jammerExecution ?? null)
const affectedLink = computed(() => {
  const frame = telemetryStore.frame
  const previousLinkId = frame?.evidence.routeDecisions.find((item) => item.direction === 'FORWARD')?.previousLinkId
  return frame?.uiLinks.find((item) => item.linkId === previousLinkId) ?? null
})
const canExecute = computed(() => authStore.authorize('SIMULATION_CONTROL').allowed)
const pending = computed(() => (
  telemetryStore.closedLoopState === 'VALIDATING' || telemetryStore.closedLoopState === 'EXECUTING'
))
const effectiveFrameLabel = computed(() => {
  if (telemetryStore.closedLoopDecision !== null) return telemetryStore.closedLoopDecision.effectiveFrameId
  return execution.value?.startTime === detection.value?.time ? detection.value?.frameId ?? '不一致' : '不一致'
})
const displayState = computed<CapabilityState>(() => {
  if (telemetryStore.capabilityState === 'LOADING' || telemetryStore.capabilityState === 'VALIDATING') {
    return telemetryStore.capabilityState
  }
  if (telemetryStore.capabilityState === 'ERROR') return 'ERROR'
  if (detection.value === null || execution.value === null || affectedLink.value === null) return 'EMPTY'
  return telemetryStore.closedLoopState
})
const stateLabel = computed(() => ({
  LOADING: '加载中', VALIDATING: '校验中', EXECUTING: '执行中',
  SUCCESS: '闭环完成', EMPTY: '待执行', ERROR: '闭环失败',
})[displayState.value])
const stateType = computed(() => ({
  LOADING: 'info', VALIDATING: 'warning', EXECUTING: 'warning',
  SUCCESS: 'success', EMPTY: 'info', ERROR: 'danger',
} as const)[displayState.value])

/**
 * 提交当前固定帧的侦测、目标和受影响链路上下文。
 * @returns 服务端完成首次状态迁移时返回 `true`。
 * @sideEffects 更新遥测 Store 的闭环六态和决策证据。
 */
async function execute(): Promise<boolean> {
  const frame = telemetryStore.frame
  if (frame === null || detection.value === null || affectedLink.value === null) return false
  return telemetryStore.runClosedLoop(frame.runId, {
    frameId: frame.frameId,
    detectionEventId: detection.value.eventId,
    targetPlatformId: detection.value.targetPlatformId,
    affectedLinkId: affectedLink.value.linkId,
  })
}
</script>

<template>
  <el-card class="p4-panel" shadow="never" aria-labelledby="closed-loop-title" data-testid="closed-loop-panel">
    <template #header>
      <div class="p4-panel__header">
        <div><p class="eyebrow">T-XQ-016 · 逐帧闭环</p><h3 id="closed-loop-title">侦测—启扰—链路劣化闭环</h3></div>
        <el-tag :type="stateType" effect="dark" data-testid="closed-loop-state">{{ stateLabel }}</el-tag>
      </div>
    </template>

    <el-skeleton v-if="displayState === 'LOADING'" :rows="3" animated />
    <el-alert v-else-if="displayState === 'ERROR'" type="error" :closable="false" show-icon title="闭环请求已拒绝" :description="telemetryStore.closedLoopResultMessage" />
    <el-empty v-else-if="detection === null || execution === null || affectedLink === null" description="当前帧缺少闭环证据" />
    <div v-else class="p4-panel__content">
      <el-alert v-if="displayState === 'VALIDATING' || displayState === 'EXECUTING'" type="warning" :closable="false" show-icon :title="displayState === 'VALIDATING' ? '正在校验同帧关系' : '正在执行闭环状态迁移'" />

      <el-steps :active="telemetryStore.closedLoopState === 'SUCCESS' ? 3 : 0" finish-status="success" align-center>
        <el-step title="侦测" :description="`${detection.eventId} · ${detection.frameId}`" />
        <el-step title="启扰" :description="`${execution.jammerId} · ${execution.power} W`" />
        <el-step title="链路劣化" :description="`${affectedLink.linkId} · ${affectedLink.status === 'DEGRADED' ? '劣化' : '中断'}`" />
      </el-steps>

      <el-descriptions :column="4" border size="small">
        <el-descriptions-item label="目标">{{ detection.targetPlatformId }}</el-descriptions-item>
        <el-descriptions-item label="仿真时刻">{{ detection.time }} s</el-descriptions-item>
        <el-descriptions-item label="生效帧">{{ effectiveFrameLabel }}</el-descriptions-item>
        <el-descriptions-item label="迁移约束">同目标同帧一次</el-descriptions-item>
      </el-descriptions>

      <div class="p4-panel__actions">
        <el-button type="primary" :loading="pending" :disabled="!canExecute" @click="execute">执行闭环</el-button>
        <span>再次提交同一目标与帧，将返回重复事件拒绝且不产生第二次动作。</span>
      </div>
    </div>
  </el-card>
</template>

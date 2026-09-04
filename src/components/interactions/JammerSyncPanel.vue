<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { CapabilityState, JammingParameterSet } from '../../contracts/domain-models'
import { useAuthStore } from '../../stores/auth'
import { useScenarioStore } from '../../stores/scenario'
import { useTelemetryStore } from '../../stores/telemetry'

const authStore = useAuthStore()
const scenarioStore = useScenarioStore()
const telemetryStore = useTelemetryStore()
const selectedJammerId = ref('')
const parameterSet = reactive<JammingParameterSet>({
  version: 5,
  effectiveFrameId: 'F-00042',
  parameters: { enabled: true, frequency: 2200, bandwidth: 40, power: 72, direction: 0, duration: 1470 },
})
const jammers = computed(() => scenarioStore.draft?.config.jammers ?? [])
const selectedJammer = computed(() => jammers.value.find((item) => item.id === selectedJammerId.value) ?? null)
const canExecute = computed(() => authStore.authorize('SIMULATION_CONTROL').allowed)
const pending = computed(() => telemetryStore.syncState === 'VALIDATING' || telemetryStore.syncState === 'EXECUTING')
const displayedVersion = computed(() => {
  const result = telemetryStore.syncResult
  return result !== null && result.taskId === telemetryStore.frame?.taskId && result.jammerId === selectedJammerId.value
    ? result.parameterVersion
    : telemetryStore.syncVersions[selectedJammerId.value] ?? 4
})
const displayState = computed<CapabilityState>(() => {
  if (scenarioStore.panelState === 'LOADING') return 'LOADING'
  if (scenarioStore.panelState === 'ERROR' && scenarioStore.draft === null) return 'ERROR'
  return telemetryStore.syncState
})
const stateLabel = computed(() => ({
  LOADING: '加载中', VALIDATING: '校验中', EXECUTING: '同步中',
  SUCCESS: '同步完成', EMPTY: '待同步', ERROR: '同步失败',
})[displayState.value])
const stateType = computed(() => ({
  LOADING: 'info', VALIDATING: 'warning', EXECUTING: 'warning',
  SUCCESS: 'success', EMPTY: 'info', ERROR: 'danger',
} as const)[displayState.value])

/**
 * 按所选设备和固定帧证据初始化同步参数。
 * @param jammerId 需要同步的干扰设备编号。
 * @returns 无返回值。
 * @sideEffects 覆盖设备参数并保留用户当前填写的版本号。
 */
function applyDefaults(jammerId: string): void {
  const jammer = jammers.value.find((item) => item.id === jammerId)
  const extension = scenarioStore.draft?.uiExtensions.jammers.find((item) => item.jammerId === jammerId)
  if (jammer === undefined || extension === undefined) return
  const evidence = telemetryStore.frame?.evidence.jammerExecution
  parameterSet.effectiveFrameId = telemetryStore.frame?.frameId ?? 'F-00042'
  Object.assign(parameterSet.parameters, {
    enabled: true,
    frequency: evidence?.jammerId === jammerId ? evidence.frequency : jammer.frequency,
    bandwidth: evidence?.jammerId === jammerId ? evidence.bandwidth : jammer.bandwidth,
    power: evidence?.jammerId === jammerId ? evidence.power : jammer.defaultPower,
    direction: extension.direction,
    duration: evidence?.jammerId === jammerId ? evidence.duration : extension.duration,
  })
}

/**
 * 提交当前版本化干扰参数集。
 * @returns 四端版本一致且在指定帧生效时返回 `true`。
 * @sideEffects 调用本机 Mock，并更新同步状态和实时干扰设备状态。
 */
async function execute(): Promise<boolean> {
  const jammer = selectedJammer.value
  if (jammer === null) return false
  const succeeded = await telemetryStore.synchronizeJammerParameters(
    telemetryStore.frame?.taskId ?? 'TASK-001',
    jammer.id,
    { ...parameterSet, parameters: { ...parameterSet.parameters } },
  )
  return succeeded
}

watch(jammers, (items) => {
  if (!items.some((item) => item.id === selectedJammerId.value)) selectedJammerId.value = items[0]?.id ?? ''
}, { immediate: true })
watch(
  [selectedJammerId, () => telemetryStore.frame?.taskId, () => telemetryStore.frame?.frameId],
  ([jammerId, taskId, frameId], [previousJammerId, previousTaskId, previousFrameId]) => {
    if (previousJammerId !== undefined
      && (jammerId !== previousJammerId || taskId !== previousTaskId || frameId !== previousFrameId)) {
      telemetryStore.clearSyncResult()
    }
    applyDefaults(jammerId)
  },
  { immediate: true },
)
watch(parameterSet, () => {
  if (telemetryStore.syncResult !== null) telemetryStore.clearSyncResult()
}, { deep: true })
</script>

<template>
  <el-card class="p4-panel" shadow="never" aria-labelledby="jammer-sync-title" data-testid="jammer-sync-panel">
    <template #header>
      <div class="p4-panel__header">
        <div><p class="eyebrow">T-XQ-017 · 参数实时同步</p><h3 id="jammer-sync-title">干扰参数同步</h3></div>
        <el-tag :type="stateType" effect="dark" data-testid="jammer-sync-state">{{ stateLabel }}</el-tag>
      </div>
    </template>

    <el-skeleton v-if="displayState === 'LOADING'" :rows="4" animated />
    <el-alert v-else-if="displayState === 'ERROR'" type="error" :closable="false" show-icon title="参数同步已拒绝" :description="telemetryStore.syncResultMessage" />
    <el-empty v-else-if="jammers.length === 0" description="暂无可同步的干扰设备" />
    <div v-else class="p4-panel__content">
      <el-alert v-if="displayState === 'VALIDATING' || displayState === 'EXECUTING'" type="warning" :closable="false" show-icon :title="displayState === 'VALIDATING' ? '正在校验版本和生效帧' : '正在同步四端参数'" />

      <div class="sync-versions" aria-label="参数版本同步状态">
        <article v-for="label in ['配置端', 'Node.js', 'AFSIM 引擎', '界面']" :key="label"><span>{{ label }}</span><strong>v{{ displayedVersion }}</strong></article>
      </div>
      <p v-if="telemetryStore.syncResult" class="p4-panel__note">生效帧：{{ telemetryStore.syncResult.effectiveFrameId }} · 仿真时刻：{{ telemetryStore.syncResult.effectiveSimulationTime }} 秒</p>

      <el-form class="sync-form" label-position="top">
        <el-form-item label="干扰设备"><el-select v-model="selectedJammerId" :disabled="pending"><el-option v-for="jammer in jammers" :key="jammer.id" :label="jammer.id" :value="jammer.id" /></el-select></el-form-item>
        <el-form-item label="参数版本"><el-input-number v-model="parameterSet.version" :min="1" :precision="0" :disabled="pending" /></el-form-item>
        <el-form-item label="生效帧"><el-input v-model="parameterSet.effectiveFrameId" :disabled="pending" /></el-form-item>
        <el-form-item label="功率（W）"><el-input-number v-model="parameterSet.parameters.power" :min="0" :disabled="pending" /></el-form-item>
        <el-form-item label="频率（MHz）"><el-input-number v-model="parameterSet.parameters.frequency" :min="1" :disabled="pending" /></el-form-item>
        <el-form-item label="带宽（MHz）"><el-input-number v-model="parameterSet.parameters.bandwidth" :min="1" :disabled="pending" /></el-form-item>
      </el-form>

      <div class="p4-panel__actions">
        <el-button type="primary" :loading="pending" :disabled="!canExecute || selectedJammer === null || telemetryStore.frame === null" @click="execute">同步参数</el-button>
        <span>版本必须大于当前 v{{ displayedVersion }}；旧版本或非当前帧更新会被拒绝。</span>
      </div>
    </div>
  </el-card>
</template>

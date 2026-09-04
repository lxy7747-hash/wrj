<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { CapabilityState, JammingCommand } from '../../contracts/domain-models'
import { useAuthStore } from '../../stores/auth'
import { useScenarioStore } from '../../stores/scenario'
import { useTelemetryStore } from '../../stores/telemetry'

const authStore = useAuthStore()
const scenarioStore = useScenarioStore()
const telemetryStore = useTelemetryStore()
const selectedJammerId = ref('')
const form = reactive<JammingCommand>({
  enabled: true,
  frequency: 0,
  bandwidth: 0,
  power: 0,
  direction: 0,
  duration: 1,
})

const jammers = computed(() => scenarioStore.draft?.config.jammers ?? [])
const selectedJammer = computed(() => jammers.value.find((item) => item.id === selectedJammerId.value) ?? null)
const selectedExtension = computed(() => (
  scenarioStore.draft?.uiExtensions.jammers.find((item) => item.jammerId === selectedJammerId.value) ?? null
))
const hostPlatform = computed(() => (
  scenarioStore.draft?.config.platforms.find((item) => item.id === selectedJammer.value?.platformId) ?? null
))
const taskId = computed(() => telemetryStore.frame?.taskId ?? 'TASK-001')
const frequencyRange = computed(() => {
  const jammer = selectedJammer.value
  return jammer === null
    ? { min: 0, max: 0 }
    : { min: jammer.frequency - jammer.bandwidth / 2, max: jammer.frequency + jammer.bandwidth / 2 }
})
const canControl = computed(() => authStore.authorize('SIMULATION_CONTROL').allowed)
const currentJammerState = computed(() => {
  const state = telemetryStore.jammerState
  return state?.taskId === taskId.value && state.jammerId === selectedJammerId.value ? state : null
})
const pending = computed(() => (
  telemetryStore.jammerControlState === 'VALIDATING' || telemetryStore.jammerControlState === 'EXECUTING'
))
const displayState = computed<CapabilityState>(() => {
  if (scenarioStore.panelState === 'LOADING') return 'LOADING'
  if (scenarioStore.panelState === 'ERROR' && scenarioStore.draft === null) return 'ERROR'
  if (telemetryStore.jammerControlState === 'SUCCESS' && currentJammerState.value === null) return 'EMPTY'
  return telemetryStore.jammerControlState
})
const stateLabel = computed(() => ({
  LOADING: '加载中', VALIDATING: '校验中', EXECUTING: '执行中',
  SUCCESS: '执行成功', EMPTY: '待执行', ERROR: '执行失败',
})[displayState.value])
const stateType = computed(() => ({
  LOADING: 'info', VALIDATING: 'warning', EXECUTING: 'warning',
  SUCCESS: 'success', EMPTY: 'info', ERROR: 'danger',
} as const)[displayState.value])
const errorMessage = computed(() => {
  if (scenarioStore.panelState === 'ERROR' && scenarioStore.draft === null) return scenarioStore.resultMessage
  return telemetryStore.jammerResultFieldPath === null
    ? telemetryStore.jammerResultMessage
    : `${telemetryStore.jammerResultMessage}（${telemetryStore.jammerResultFieldPath}）`
})

/**
 * 将所选设备的场景能力和当前固定帧证据填入控制表单。
 * @param jammerId 需要载入的干扰设备编号。
 * @returns 无返回值。
 * @sideEffects 覆盖表单中的启停、频段、功率、方向和持续时间。
 */
function applyDefaults(jammerId: string): void {
  const jammer = jammers.value.find((item) => item.id === jammerId)
  const extension = scenarioStore.draft?.uiExtensions.jammers.find((item) => item.jammerId === jammerId)
  if (jammer === undefined || extension === undefined) return
  const evidence = telemetryStore.frame?.evidence.jammerExecution
  Object.assign(form, {
    enabled: true,
    frequency: evidence?.jammerId === jammerId ? evidence.frequency : jammer.frequency,
    bandwidth: evidence?.jammerId === jammerId ? evidence.bandwidth : jammer.bandwidth,
    power: evidence?.jammerId === jammerId ? evidence.power : jammer.defaultPower,
    direction: extension.direction,
    duration: evidence?.jammerId === jammerId ? evidence.duration : extension.duration,
  })
}

/**
 * 提交当前 RF 干扰控制表单。
 * @returns 服务端接受并返回生效帧时返回 `true`。
 * @sideEffects 调用本机 Mock 接口并更新面板执行状态。
 */
async function execute(): Promise<boolean> {
  if (selectedJammer.value === null) return false
  return telemetryStore.controlJammer(taskId.value, selectedJammer.value.id, { ...form })
}

watch(jammers, (items) => {
  if (!items.some((item) => item.id === selectedJammerId.value)) selectedJammerId.value = items[0]?.id ?? ''
}, { immediate: true })
watch([selectedJammerId, () => telemetryStore.frame?.frameId], ([jammerId]) => applyDefaults(jammerId), { immediate: true })

onMounted(() => {
  if (scenarioStore.draft === null && scenarioStore.panelState === 'EMPTY') void scenarioStore.loadScenario('SCN-001')
})
</script>

<template>
  <el-card class="rf-panel" shadow="never" aria-labelledby="rf-panel-title" data-testid="rf-jammer-panel">
    <template #header>
      <div class="rf-panel__header">
        <div>
          <p class="eyebrow">T-XQ-015 · RF 干扰机控制</p>
          <h3 id="rf-panel-title">RF 干扰机控制</h3>
        </div>
        <el-tag :type="stateType" effect="dark" data-testid="rf-state">{{ stateLabel }}</el-tag>
      </div>
    </template>

    <el-alert
      v-if="scenarioStore.panelState === 'ERROR' && scenarioStore.draft === null"
      type="error"
      :closable="false"
      show-icon
      title="干扰设备加载失败"
      :description="errorMessage"
    />
    <el-skeleton v-else-if="displayState === 'LOADING'" :rows="5" animated />
    <el-empty v-else-if="jammers.length === 0" description="暂无可配置的干扰设备" />
    <div v-else class="rf-panel__content">
      <el-alert
        v-if="!canControl"
        type="error"
        :closable="false"
        show-icon
        title="当前账号没有干扰控制权限"
      />
      <el-alert
        v-else-if="displayState === 'ERROR'"
        type="error"
        :closable="false"
        show-icon
        title="干扰控制命令已拒绝"
        :description="errorMessage"
      />
      <el-alert
        v-else-if="displayState === 'VALIDATING' || displayState === 'EXECUTING'"
        type="warning"
        :closable="false"
        show-icon
        :title="displayState === 'VALIDATING' ? '正在校验设备能力范围' : '正在执行干扰控制命令'"
      />

      <el-form class="rf-panel__form" label-position="top">
        <el-form-item label="干扰设备">
          <el-select v-model="selectedJammerId" :disabled="pending" aria-label="选择干扰设备">
            <el-option
              v-for="jammer in jammers"
              :key="jammer.id"
              :label="`${jammer.id} · ${jammer.type === 'BARRAGE' ? '宽带压制' : '瞄准式'}`"
              :value="jammer.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="控制动作">
          <el-switch v-model="form.enabled" active-text="启扰" inactive-text="停扰" :disabled="pending" />
        </el-form-item>
        <el-form-item label="中心频率（MHz）">
          <el-input-number v-model="form.frequency" :precision="1" :step="1" :disabled="pending" />
        </el-form-item>
        <el-form-item label="带宽（MHz）">
          <el-input-number v-model="form.bandwidth" :precision="1" :step="1" :disabled="pending" />
        </el-form-item>
        <el-form-item label="功率（W）">
          <el-input-number v-model="form.power" :precision="1" :step="1" :disabled="pending" />
        </el-form-item>
        <el-form-item label="方向（°）">
          <el-input-number v-model="form.direction" :precision="1" :step="1" :disabled="pending" />
        </el-form-item>
        <el-form-item label="持续时间（s）">
          <el-input-number v-model="form.duration" :precision="0" :step="10" :disabled="pending" />
        </el-form-item>
        <div class="rf-panel__action">
          <el-button type="primary" :loading="pending" :disabled="!canControl || selectedJammer === null" @click="execute">
            执行命令
          </el-button>
        </div>
      </el-form>

      <el-descriptions v-if="selectedJammer" :column="5" border size="small">
        <el-descriptions-item label="所属平台">{{ hostPlatform?.name ?? selectedJammer.platformId }}</el-descriptions-item>
        <el-descriptions-item label="设备状态">{{ selectedExtension?.enabled ? '可用' : '不可用' }}</el-descriptions-item>
        <el-descriptions-item label="Mock 频率边界">{{ frequencyRange.min }}–{{ frequencyRange.max }} MHz</el-descriptions-item>
        <el-descriptions-item label="Mock 功率上限">{{ selectedJammer.defaultPower }} W</el-descriptions-item>
        <el-descriptions-item label="Mock 时长上限">{{ scenarioStore.draft?.config.scenario.duration }} s</el-descriptions-item>
      </el-descriptions>

      <el-result
        v-if="displayState === 'SUCCESS' && currentJammerState"
        icon="success"
        title="干扰控制命令已执行"
        :sub-title="telemetryStore.jammerResultMessage"
      >
        <template #extra>
          <span class="rf-panel__result">
            {{ currentJammerState.power }} W / {{ currentJammerState.frequency }} MHz /
            {{ currentJammerState.duration }} s
          </span>
        </template>
      </el-result>

      <p class="rf-panel__boundary">Mock 服务只校验场景能力并返回确定性生效帧，不连接或控制真实 RF 设备。</p>
    </div>
  </el-card>
</template>

<style scoped>
.rf-panel {
  border-color: var(--console-border);
  background: var(--console-bg-elevated);
}

.rf-panel__header,
.rf-panel__action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.rf-panel__header h3 {
  margin: var(--space-1) 0 0;
  color: var(--console-text);
  font-size: 1rem;
}

.rf-panel__content {
  display: grid;
  gap: var(--space-4);
}

.rf-panel__form {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
}

.rf-panel__form :deep(.el-form-item) {
  margin-bottom: 0;
}

.rf-panel__form :deep(.el-select),
.rf-panel__form :deep(.el-input-number) {
  width: 100%;
}

.rf-panel__action {
  align-items: flex-end;
}

.rf-panel__result {
  color: var(--console-teal);
  font-weight: 700;
}

.rf-panel__boundary {
  margin: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--console-border);
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
  line-height: 1.6;
}

@media (max-width: 900px) {
  .rf-panel__form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 520px) {
  .rf-panel__form {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

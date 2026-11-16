<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { frameJammerExecutions } from '../../features/situation/frame-evidence'
import { dbmToWatts, isControlledPowerDbm, isControlledPowerWatts, JAMMER_POWER_DBM_TIERS, JAMMER_RANGE_METERS, METERS_PER_KILOMETER, wattsToDbm } from '../../features/scenarios/jammer-settings'
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
  parameters: { enabled: true, frequency: 2200, bandwidth: 40, power: 72, direction: 0, duration: 1 },
})
/** 探测范围界面按 km 编辑，合同单位米；作为顶层字段随参数集提交，旧请求缺省兼容。 */
const detectionRangeKm = ref<number | undefined>(undefined)
/** 服务端已接受的探测范围（合同米）：只能来自读取接口或同步成功响应；编辑/失败不改变。 */
const acceptedDetectionRangeM = ref<number | undefined>(undefined)
/** 由已接受值回填编辑框时抑制“编辑触发清空结果”。 */
let applyingAccepted = false
const detectionRangeError = ref('')
/** 编辑保护：聚焦表单期间新帧不覆盖正在编辑的值。 */
const editing = ref(false)
/** 提交上下文，用于丢弃设备/运行切换后晚返回的旧请求结果。 */
const requestContext = ref<{ jammerId: string; runId: string | undefined; taskId: string } | null>(null)
/** 参数同步同样按 dBm 档位编辑，避免绕过 RF 面板的受控功率校验。 */
const powerDbm = ref<number | undefined>(undefined)
const powerTouched = ref(false)
const powerSubmitError = ref('')
const powerDbmOptions = JAMMER_POWER_DBM_TIERS

/** 将合同瓦数格式化为档位说明，仅用于展示。 */
function formatPowerWatts(dbm: number): string {
  return `${Number(dbmToWatts(dbm).toPrecision(6))} W`
}

/** 从当前瓦数回显合法档位；历史超范围值保留原值并仅提示。 */
function resetPowerFromWatts(): void {
  powerTouched.value = false
  powerSubmitError.value = ''
  const watts = parameterSet.parameters.power
  if (typeof watts !== 'number' || !Number.isFinite(watts) || watts <= 0) { powerDbm.value = undefined; return }
  const dbm = wattsToDbm(watts)
  powerDbm.value = isControlledPowerDbm(dbm) ? Number(dbm.toFixed(6)) : undefined
}

/** 选择合法档位时精确换算回 W。 */
function onPowerDbmChange(value: number | undefined): void {
  powerTouched.value = true
  powerSubmitError.value = ''
  powerDbm.value = value
  parameterSet.parameters.power = isControlledPowerDbm(value) ? dbmToWatts(value) : Number.NaN
}

const legacyPowerWarning = computed(() => (
  !powerTouched.value && powerDbm.value === undefined && Number.isFinite(parameterSet.parameters.power) && parameterSet.parameters.power > 0
    ? `当前回显 ${parameterSet.parameters.power} W 超出 -10～30 dBm 受控档位，仅提示、不改写历史值；请选择合法档位后再同步。`
    : ''
))
const jammers = computed(() => scenarioStore.draft?.config.jammers ?? [])
const selectedJammer = computed(() => jammers.value.find((item) => item.id === selectedJammerId.value) ?? null)
const taskId = computed(() => telemetryStore.frame?.taskId ?? 'TASK-001')
/** 当前运行/设备的运行期本地参数（GET 读取层 / 同步结果）；不代表真实插件确认。 */
const runtimeParameters = computed(() => {
  const runId = telemetryStore.frame?.runId ?? ''
  return telemetryStore.jammerRuntimeParameters[`${runId}|${selectedJammerId.value}`] ?? null
})
const canExecute = computed(() => authStore.authorize('SIMULATION_CONTROL').allowed)
const pending = computed(() => telemetryStore.syncState === 'VALIDATING' || telemetryStore.syncState === 'EXECUTING')
const displayedVersion = computed(() => {
  const result = telemetryStore.syncResult
  return result !== null && result.taskId === telemetryStore.frame?.taskId && result.jammerId === selectedJammerId.value
    ? result.parameterVersion
    : telemetryStore.syncVersions[selectedJammerId.value] ?? 4
})
/** 本次提交上下文是否仍对应当前设备/运行；晚返回的旧请求不污染当前选择。 */
const requestStillCurrent = computed(() => {
  const context = requestContext.value
  if (context === null) return true
  return context.jammerId === selectedJammerId.value
    && context.runId === telemetryStore.frame?.runId
    && context.taskId === (telemetryStore.frame?.taskId ?? 'TASK-001')
})
/**
 * 版本分工：配置端/Node/界面为本项目本地参数版本；AFSIM 引擎版本不是实测回读，
 * 显示“未接入”，不伪造“四端一致”或引擎确认。
 */
const versionCards = computed(() => {
  const local = displayedVersion.value
  return [
    { label: '配置端', value: `v${local}`, note: '本项目参数' },
    { label: 'Node.js', value: `v${local}`, note: '本地投影' },
    { label: 'AFSIM 引擎', value: '未接入', note: '真实插件版本未知' },
    { label: '界面', value: `v${local}`, note: '本地回显' },
  ]
})
const sourceRunLabel = computed(() => (
  telemetryStore.frame?.runId ? `当前运行 ${telemetryStore.frame.runId}` : '运行来源未确认'
))
/** 探测范围“本地已接受”回显（km）；仅来自读取接口/成功响应，不代表真实插件确认。 */
const detectionRangeLabel = computed(() => {
  const value = acceptedDetectionRangeM.value
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Number((value / METERS_PER_KILOMETER).toFixed(3))} km（${value} m）`
    : '暂无数据'
})
const displayState = computed<CapabilityState>(() => {
  if (scenarioStore.panelState === 'LOADING') return 'LOADING'
  if (scenarioStore.panelState === 'ERROR' && scenarioStore.draft === null) return 'ERROR'
  const state = telemetryStore.syncState
  if (state === 'SUCCESS' && !requestStillCurrent.value) return 'EMPTY'
  if (state === 'ERROR' && !requestStillCurrent.value) return 'EMPTY'
  return state
})
const stateLabel = computed(() => ({
  LOADING: '加载中', VALIDATING: '校验中', EXECUTING: '同步中',
  SUCCESS: '本地已接受', EMPTY: '待同步', ERROR: '同步失败',
})[displayState.value])
const stateType = computed(() => ({
  LOADING: 'info', VALIDATING: 'warning', EXECUTING: 'warning',
  SUCCESS: 'success', EMPTY: 'info', ERROR: 'danger',
} as const)[displayState.value])

/**
 * 按所选设备和固定帧证据初始化同步参数与探测范围回显；保留用户当前填写的版本号。
 * @param jammerId 需要同步的干扰设备编号。
 * @returns 无返回值。
 * @sideEffects 覆盖设备参数与探测范围，计划/版本由用户维护。
 */
function applyDefaults(jammerId: string): void {
  const jammer = jammers.value.find((item) => item.id === jammerId)
  const extension = scenarioStore.draft?.uiExtensions.jammers.find((item) => item.jammerId === jammerId)
  if (jammer === undefined || extension === undefined) return
  const frame = telemetryStore.frame
  const evidence = frame && frameJammerExecutions(frame).find(item => item.jammerId === jammerId)
  parameterSet.effectiveFrameId = telemetryStore.frame?.frameId ?? 'F-00042'
  Object.assign(parameterSet.parameters, {
    enabled: true,
    frequency: evidence?.frequency ?? jammer.frequency,
    bandwidth: evidence?.bandwidth ?? jammer.bandwidth,
    power: evidence?.power ?? jammer.defaultPower,
    // 持续时间沿用命令默认值；方向来自场景配置。
    direction: extension.direction,
    duration: 1,
  })
  // 编辑值初始回填：优先读取层已接受值，其次场景配置；仅作为可编辑初值，不代表已接受。
  const runtime = runtimeParameters.value
  const editMeters = runtime?.detectionRangeM ?? jammer.detectionRange
  applyingAccepted = true
  detectionRangeKm.value = typeof editMeters === 'number' && Number.isFinite(editMeters)
    ? Number((editMeters / METERS_PER_KILOMETER).toFixed(3))
    : undefined
  applyingAccepted = false
  detectionRangeError.value = ''
  resetPowerFromWatts()
}

/** 离开表单区域后解除编辑保护；移动到表单内其他控件时继续保持保护。 */
function onFormFocusOut(event: FocusEvent): void {
  const root = event.currentTarget as HTMLElement | null
  const next = event.relatedTarget as Node | null
  if (root !== null && next !== null && root.contains(next)) return
  editing.value = false
}

/** 校验探测范围必填并在 1～100 km 之间；不通过时原位提示，不提交。 */
function validateDetectionRange(): boolean {
  detectionRangeError.value = ''
  const value = detectionRangeKm.value
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    detectionRangeError.value = '探测范围必须填写，单位为 km。'
    return false
  }
  const meters = value * METERS_PER_KILOMETER
  if (meters < JAMMER_RANGE_METERS.min || meters > JAMMER_RANGE_METERS.max) {
    detectionRangeError.value = `探测范围必须在 ${JAMMER_RANGE_METERS.min / METERS_PER_KILOMETER}～${JAMMER_RANGE_METERS.max / METERS_PER_KILOMETER} km 之间。`
    return false
  }
  return true
}

/**
 * 提交当前版本化干扰参数集（含顶层探测范围，合同米）。
 * @returns 服务端接受并在指定帧生效时返回 `true`。
 * @sideEffects 调用本机服务接口并更新同步状态；本地投影不代表真实引擎执行回执。
 */
async function execute(): Promise<boolean> {
  const jammer = selectedJammer.value
  if (jammer === null) return false
  if (!validateDetectionRange()) return false
  if (parameterSet.parameters.enabled && !isControlledPowerWatts(parameterSet.parameters.power)) {
    powerSubmitError.value = '启扰功率必须为 -10～30 dBm 且按 5 dB 档位设置。'
    return false
  }
  editing.value = false
  requestContext.value = {
    jammerId: jammer.id,
    runId: telemetryStore.frame?.runId,
    taskId: telemetryStore.frame?.taskId ?? 'TASK-001',
  }
  const payload: JammingParameterSet = {
    ...parameterSet,
    parameters: { ...parameterSet.parameters },
    detectionRangeM: Math.round((detectionRangeKm.value as number) * METERS_PER_KILOMETER),
  }
  const ok = await telemetryStore.synchronizeJammerParameters(
    telemetryStore.frame?.taskId ?? 'TASK-001',
    jammer.id,
    payload,
  )
  // 只有同步成功响应才更新“本地已接受”；编辑/校验失败/提交失败不改接受值。
  if (ok && requestStillCurrent.value) {
    const accepted = telemetryStore.syncResult?.detectionRangeM
    if (accepted !== undefined) {
      acceptedDetectionRangeM.value = accepted
      applyingAccepted = true
      detectionRangeKm.value = Number((accepted / METERS_PER_KILOMETER).toFixed(3))
      applyingAccepted = false
    }
  }
  return ok
}

watch(jammers, (items) => {
  if (!items.some((item) => item.id === selectedJammerId.value)) selectedJammerId.value = items[0]?.id ?? ''
}, { immediate: true })
// 用显式快照判断变化，避免 immediate 首轮把预设结果误清空；仅真实设备/运行/帧变化才清空同步结果。
let lastSyncContext: { jammerId: string; taskId: string | undefined; runId: string | undefined; frameId: string | undefined } | null = null
watch(
  [selectedJammerId, () => telemetryStore.frame?.taskId, () => telemetryStore.frame?.runId, () => telemetryStore.frame?.frameId],
  ([jammerId]) => {
    const current = {
      jammerId,
      taskId: telemetryStore.frame?.taskId,
      runId: telemetryStore.frame?.runId,
      frameId: telemetryStore.frame?.frameId,
    }
    const deviceOrRunChanged = lastSyncContext === null
      || current.jammerId !== lastSyncContext.jammerId
      || current.taskId !== lastSyncContext.taskId
      || current.runId !== lastSyncContext.runId
    const frameChanged = lastSyncContext !== null && current.frameId !== lastSyncContext.frameId
    if (lastSyncContext !== null && (deviceOrRunChanged || frameChanged)) telemetryStore.clearSyncResult()
    if (deviceOrRunChanged) {
      editing.value = false
      // 切换设备/运行（含首挂载）清空上一归属的已接受值，随后按归属读取恢复。
      acceptedDetectionRangeM.value = undefined
      if (!editing.value) {
        applyingAccepted = true
        detectionRangeKm.value = undefined
        applyingAccepted = false
      }
      if (jammerId !== '') void telemetryStore.loadJammerRuntimeParameters(taskId.value, jammerId, { force: true })
    }
    // 编辑中且仅帧变化时不覆盖正在编辑的值；设备/运行切换或非编辑态才回填。
    if (deviceOrRunChanged || !editing.value) applyDefaults(jammerId)
    lastSyncContext = current
  },
  { immediate: true },
)
// 运行期参数读取层更新（GET/同步后）时更新“已接受值”，并在非编辑态回填编辑框。
watch(runtimeParameters, () => {
  const runtime = runtimeParameters.value
  acceptedDetectionRangeM.value = runtime?.detectionRangeM
  if (editing.value) return
  applyingAccepted = true
  detectionRangeKm.value = runtime === null ? undefined : Number((runtime.detectionRangeM / METERS_PER_KILOMETER).toFixed(3))
  applyingAccepted = false
})
watch(parameterSet, () => {
  if (telemetryStore.syncResult !== null) telemetryStore.clearSyncResult()
}, { deep: true })
watch(detectionRangeKm, () => {
  if (applyingAccepted) return
  // 用户编辑探测范围视为未提交修改，清空旧的同步“完成”结果。
  if (telemetryStore.syncResult !== null) telemetryStore.clearSyncResult()
})
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
    <el-empty v-else-if="jammers.length === 0 && displayState !== 'ERROR'" description="暂无可同步的干扰设备" />
    <div v-else class="p4-panel__content">
      <el-alert v-if="displayState === 'ERROR'" type="error" :closable="false" show-icon title="参数同步已拒绝" :description="telemetryStore.syncResultMessage" />
      <el-alert v-if="displayState === 'VALIDATING' || displayState === 'EXECUTING'" type="warning" :closable="false" show-icon :title="displayState === 'VALIDATING' ? '正在校验版本和生效帧' : '正在同步四端参数'" />

      <div class="sync-versions" aria-label="参数版本同步状态">
        <article v-for="card in versionCards" :key="card.label">
          <span>{{ card.label }}</span>
          <strong>{{ card.value }}</strong>
          <small class="sync-versions__tag">{{ card.note }}</small>
        </article>
      </div>
      <p class="p4-panel__note" data-testid="sync-source-note">来源：{{ sourceRunLabel }} 的本地投影/校验；真实引擎版本与执行未接入/未确认。</p>
      <p v-if="telemetryStore.syncResult" class="p4-panel__note">生效帧：{{ telemetryStore.syncResult.effectiveFrameId }} · 仿真时刻：{{ telemetryStore.syncResult.effectiveSimulationTime }} 秒</p>
      <p class="p4-panel__note" data-testid="sync-detection-range">探测范围（本地已接受回显）：{{ detectionRangeLabel }}；来自运行期本地参数读取层，真实插件是否采用未接入/未确认。</p>

      <el-form class="sync-form" label-position="top" @focusin="editing = true" @focusout="onFormFocusOut">
        <el-form-item label="干扰设备"><el-select v-model="selectedJammerId" :disabled="pending"><el-option v-for="jammer in jammers" :key="jammer.id" :label="jammer.id" :value="jammer.id" /></el-select></el-form-item>
        <el-form-item label="参数版本"><el-input-number v-model="parameterSet.version" :min="1" :precision="0" :disabled="pending" /></el-form-item>
        <el-form-item label="生效帧"><el-input v-model="parameterSet.effectiveFrameId" :disabled="pending" /></el-form-item>
        <el-form-item label="功率（dBm）" :error="powerSubmitError">
          <el-select
            :model-value="powerDbm"
            :disabled="pending"
            placeholder="选择 -10～30 dBm 档位"
            data-testid="jammer-sync-power-dbm"
            @update:model-value="onPowerDbmChange"
          >
            <el-option
              v-for="dbm in powerDbmOptions"
              :key="dbm"
              :label="`${dbm} dBm（${formatPowerWatts(dbm)}）`"
              :value="dbm"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="频率（MHz）"><el-input-number v-model="parameterSet.parameters.frequency" :min="1" :disabled="pending" /></el-form-item>
        <el-form-item label="带宽（MHz）"><el-input-number v-model="parameterSet.parameters.bandwidth" :min="1" :disabled="pending" /></el-form-item>
        <el-form-item label="探测范围（km）" :error="detectionRangeError">
          <el-input-number v-model="detectionRangeKm" :precision="3" :step="1" :disabled="pending" data-testid="jammer-sync-detection-range" />
        </el-form-item>
      </el-form>
      <el-alert v-if="detectionRangeError" type="error" :closable="false" show-icon :title="detectionRangeError" data-testid="jammer-sync-detection-range-error" />

      <div class="p4-panel__actions">
        <el-button type="primary" :loading="pending" :disabled="!canExecute || selectedJammer === null || telemetryStore.frame === null" @click="execute">同步参数</el-button>
        <span>版本必须大于当前 v{{ displayedVersion }}；旧版本或非当前帧更新会被拒绝。</span>
      </div>
    </div>
  </el-card>
</template>

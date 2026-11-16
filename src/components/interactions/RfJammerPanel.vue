<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { frameJammerExecutions } from '../../features/situation/frame-evidence'
import { BARRAGE_BANDWIDTH_OPTIONS_MHZ, dbmToWatts, isControlledPowerDbm, isControlledPowerWatts, JAMMER_POWER_DBM_TIERS, SPOT_BANDWIDTH_MHZ, wattsToDbm } from '../../features/scenarios/jammer-settings'
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

/** 干扰样式（运行面板独立切换）：宽带压制 / 瞄准式；默认取自设备类型。 */
const jammerStyle = ref<'BARRAGE' | 'SPOT'>('BARRAGE')
/** 俯仰角来自场景扩展 JammerUiExtension.elevation，规划范围 -10～60°。 */
const elevation = ref(0)
const elevationError = ref('')
/** 计划启停帧：按输入原值保存，不额外乘 5；真实调度未接入，仅本地留存。 */
const planStartFrame = ref<number | undefined>(undefined)
const planStopFrame = ref<number | undefined>(undefined)
/** 最近一次成功保存/读取到的计划快照；“已保存”仅在当前编辑值与其一致时显示。 */
const planSavedSnapshot = ref<{ style: 'BARRAGE' | 'SPOT'; elevation: number; start?: number; stop?: number } | null>(null)
/** 本次提交之后用户是否手动改过计划；仅用户操作置真，程序回填不置真。 */
const planDirtySinceSubmit = ref(false)
const planStatus = computed<'NONE' | 'SAVED'>(() => {
  const snapshot = planSavedSnapshot.value
  if (snapshot === null) return 'NONE'
  return snapshot.style === jammerStyle.value && snapshot.elevation === elevation.value
    && snapshot.start === planStartFrame.value && snapshot.stop === planStopFrame.value ? 'SAVED' : 'NONE'
})
const planError = ref('')
/** 编辑保护：聚焦表单期间新帧不覆盖正在编辑的值。 */
const editing = ref(false)
/** 提交上下文，用于丢弃设备/运行切换后晚返回的旧请求结果。 */
const requestContext = ref<{ jammerId: string; runId: string | undefined; taskId: string } | null>(null)

/** 界面按 dBm 档位编辑，合同仍以 W 提交；禁止先把 W 舍入到一位小数再提交。 */
const powerDbm = ref<number | undefined>(undefined)
const powerTouched = ref(false)
const powerSubmitError = ref('')
const powerDbmOptions = JAMMER_POWER_DBM_TIERS

/** 将合同瓦数格式化为便于识别的档位说明，仅用于展示，不参与提交。 */
function formatPowerWatts(dbm: number): string {
  return `${Number(dbmToWatts(dbm).toPrecision(6))} W`
}

/** 从表单当前瓦数回显合法 dBm 档位；历史超范围值保留原值并只作提示。 */
function resetPowerFromWatts(): void {
  powerTouched.value = false
  powerSubmitError.value = ''
  const watts = form.power
  if (typeof watts !== 'number' || !Number.isFinite(watts) || watts <= 0) { powerDbm.value = undefined; return }
  const dbm = wattsToDbm(watts)
  powerDbm.value = isControlledPowerDbm(dbm) ? Number(dbm.toFixed(6)) : undefined
}

/** 选择合法档位时精确换算回 W；非法档位写入 NaN 以阻止提交。 */
function onPowerDbmChange(value: number | undefined): void {
  powerTouched.value = true
  powerSubmitError.value = ''
  powerDbm.value = value
  form.power = isControlledPowerDbm(value) ? dbmToWatts(value) : Number.NaN
}

const legacyPowerWarning = computed(() => (
  !powerTouched.value && powerDbm.value === undefined && Number.isFinite(form.power) && form.power > 0
    ? `当前回显 ${form.power} W 超出 -10～30 dBm 受控档位，仅提示、不改写历史值；请选择合法档位后再启扰。`
    : ''
))

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
/** 当前运行/设备的运行期本地参数（来自 GET 读取层 / 同步/计划结果）；不代表引擎确认。 */
const runtimeParameters = computed(() => {
  const runId = telemetryStore.frame?.runId ?? ''
  return telemetryStore.jammerRuntimeParameters[`${runId}|${selectedJammerId.value}`] ?? null
})
/** 计划保存请求进行中（真实异步 PUT /plan）。 */
const planSubmitting = ref(false)
/** 保存请求序号：晚返回的旧保存不得覆盖后续保存或当前编辑。 */
const saveEpoch = ref(0)
/** 正在保存的设备/运行键；只保护该键的回填，避免保存中切到其他设备时无法回填。 */
const pendingPlanKey = ref<string | null>(null)
const currentPlanKey = computed(() => `${telemetryStore.frame?.runId ?? ''}|${selectedJammerId.value}`)
/** 仅当前设备/运行的保存请求使按钮进入 loading/disabled。 */
const planBusy = computed(() => planSubmitting.value && pendingPlanKey.value === currentPlanKey.value)
/** 本次提交上下文是否仍对应当前设备/运行；晚返回的旧请求不污染当前选择。 */
const requestStillCurrent = computed(() => {
  const context = requestContext.value
  if (context === null) return true
  return context.jammerId === selectedJammerId.value
    && context.runId === telemetryStore.frame?.runId
    && context.taskId === taskId.value
})
const pending = computed(() => (
  telemetryStore.jammerControlState === 'VALIDATING' || telemetryStore.jammerControlState === 'EXECUTING'
))
const displayState = computed<CapabilityState>(() => {
  if (scenarioStore.panelState === 'LOADING') return 'LOADING'
  if (scenarioStore.panelState === 'ERROR' && scenarioStore.draft === null) return 'ERROR'
  const state = telemetryStore.jammerControlState
  if (state === 'SUCCESS' && (currentJammerState.value === null || !requestStillCurrent.value)) return 'EMPTY'
  if (state === 'ERROR' && !requestStillCurrent.value) return 'EMPTY'
  return state
})
/** 命令已发送（本地投影接受），不等于引擎已执行；引擎执行回执未接入。 */
const commandSent = computed(() => (
  telemetryStore.jammerControlState === 'SUCCESS' && currentJammerState.value !== null && requestStillCurrent.value
))
/** 样式相关带宽建议：宽带压制取 100/200/400，瞄准式取 5 MHz，均不超过设备带宽。 */
const styleBandwidthOptions = computed<number[]>(() => {
  const cap = selectedJammer.value?.bandwidth ?? 0
  const base = jammerStyle.value === 'SPOT' ? [SPOT_BANDWIDTH_MHZ] : [...BARRAGE_BANDWIDTH_OPTIONS_MHZ]
  const within = base.filter((value) => value <= cap)
  return within.length > 0 ? within : base
})
const stateLabel = computed(() => ({
  LOADING: '加载中', VALIDATING: '校验中', EXECUTING: '执行中',
  SUCCESS: '命令已发送', EMPTY: '待执行', ERROR: '执行失败',
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
/** 本地投影/校验来源说明；真实设备执行回执尚未接入，未知运行不臆测来源。 */
const resultSourceLabel = computed(() => {
  if (telemetryStore.jammerResultSource !== 'LOCAL_PROJECTION') return '来源未确认：真实设备执行未接入'
  const runId = telemetryStore.frame?.runId
  return `本地演示/校验投影${runId ? ` · 运行 ${runId}` : ''}（真实设备执行未接入）`
})

/**
 * 将所选设备的场景能力和当前固定帧证据填入控制表单（样式、俯仰、频段、功率等）。
 * @param jammerId 需要载入的干扰设备编号。
 * @returns 无返回值。
 * @sideEffects 覆盖控制表单与俯仰角；不覆盖已填写的计划帧，计划帧由 applyPlanDefaults 单独初始化。
 */
function applyControlDefaults(jammerId: string): void {
  const jammer = jammers.value.find((item) => item.id === jammerId)
  const extension = scenarioStore.draft?.uiExtensions.jammers.find((item) => item.jammerId === jammerId)
  if (jammer === undefined || extension === undefined) return
  const frame = telemetryStore.frame
  const evidence = frame && frameJammerExecutions(frame).find(item => item.jammerId === jammerId)
  Object.assign(form, {
    enabled: true,
    frequency: evidence?.frequency ?? jammer.frequency,
    bandwidth: evidence?.bandwidth ?? jammer.bandwidth,
    power: evidence?.power ?? jammer.defaultPower,
    // 持续时间沿用命令默认值；方向来自场景配置。
    direction: extension.direction,
    duration: 1,
  })
  const runtime = runtimeParameters.value
  jammerStyle.value = runtime?.style ?? (jammer.type === 'SPOT' ? 'SPOT' : 'BARRAGE')
  elevation.value = runtime?.elevation ?? extension.elevation ?? 0
  elevationError.value = ''
  resetPowerFromWatts()
}

/**
 * 设备或运行切换时按运行期读取层优先、场景配置兜底初始化计划帧；新帧只刷新控制表单，保留用户已填写的计划。
 * @param jammerId 需要初始化计划帧的干扰设备编号。
 * @returns 无返回值。
 */
function applyPlanDefaults(jammerId: string): void {
  const jammer = jammers.value.find((item) => item.id === jammerId)
  const runtime = runtimeParameters.value
  planStartFrame.value = runtime?.plannedStartFrame ?? jammer?.plannedStartFrame
  planStopFrame.value = runtime?.plannedStopFrame ?? jammer?.plannedStopFrame
  planSavedSnapshot.value = runtime?.style === undefined
    ? null
    : { style: runtime.style, elevation: runtime.elevation ?? 0, start: runtime.plannedStartFrame, stop: runtime.plannedStopFrame }
  planError.value = ''
  // 设备/运行切换或读取层回填属于程序赋值，不构成“提交后的新编辑”。
  planDirtySinceSubmit.value = false
}

/** 用户手动修改计划相关字段：标记本次提交后已有新编辑，保存返回时不覆盖用户输入。 */
function markPlanDirty(): void {
  planDirtySinceSubmit.value = true
}

/** 切换干扰样式时按设备带宽给出建议带宽：宽带压制取可用档位，瞄准式取 5 MHz。 */
function onStyleChange(value: unknown): void {
  planDirtySinceSubmit.value = true
  const style: 'BARRAGE' | 'SPOT' = value === 'SPOT' ? 'SPOT' : 'BARRAGE'
  jammerStyle.value = style
  const cap = selectedJammer.value?.bandwidth ?? 0
  if (style === 'SPOT') {
    const spot = Math.min(SPOT_BANDWIDTH_MHZ, cap)
    if (spot > 0) form.bandwidth = spot
  } else {
    const option = [...BARRAGE_BANDWIDTH_OPTIONS_MHZ].filter((bandwidth) => bandwidth <= cap).pop()
    if (option !== undefined) form.bandwidth = option
  }
}

/** 离开表单区域后解除编辑保护；移动到表单内其他控件时继续保持保护。 */
function onFormFocusOut(event: FocusEvent): void {
  const root = event.currentTarget as HTMLElement | null
  const next = event.relatedTarget as Node | null
  if (root !== null && next !== null && root.contains(next)) return
  editing.value = false
}

/** 校验俯仰范围与计划帧非负整数、先后顺序；不通过时原位提示，不发送任何命令。 */
function validatePointingAndPlan(): boolean {
  elevationError.value = ''
  planError.value = ''
  const elevationValue = elevation.value
  if (typeof elevationValue !== 'number' || !Number.isFinite(elevationValue)
    || elevationValue < -10 || elevationValue > 60) {
    elevationError.value = '俯仰角必须在 -10～60° 之间。'
    return false
  }
  const start = planStartFrame.value
  const stop = planStopFrame.value
  if (start !== undefined && (!Number.isInteger(start) || start < 0)) {
    planError.value = '计划启动帧必须为非负整数。'
    return false
  }
  if (stop !== undefined && (!Number.isInteger(stop) || stop < 0)) {
    planError.value = '计划停止帧必须为非负整数。'
    return false
  }
  if (start !== undefined && stop !== undefined && stop <= start) {
    planError.value = '计划停止帧必须大于计划启动帧。'
    return false
  }
  return true
}

/**
 * 通过真实异步 PUT /plan 保存计划与新增控制字段（仅本地留存，storage=LOCAL_RUN）。
 * 成功后才标记“已保存（本地）”；失败保留输入、展示错误并允许重试；引擎执行仍未接入。
 */
async function savePlan(): Promise<void> {
  if (!validatePointingAndPlan()) return
  const jammer = selectedJammer.value
  if (jammer === null) return
  // 提交前捕获本次提交值：保存期间的新编辑不得被当作已保存。
  const submitted = {
    style: jammerStyle.value,
    elevation: elevation.value,
    plannedStartFrame: planStartFrame.value,
    plannedStopFrame: planStopFrame.value,
  }
  // 从发出本次请求起重新计数：请求期间用户若再编辑，保存返回时不得覆盖。
  planDirtySinceSubmit.value = false
  // 本次保存的局部上下文：不复用共享 requestContext，避免切换设备时其被清空后旧响应被放行。
  const context = { jammerId: jammer.id, runId: telemetryStore.frame?.runId, taskId: taskId.value }
  const sameContext = (): boolean => context.jammerId === selectedJammerId.value
    && context.runId === telemetryStore.frame?.runId
    && context.taskId === taskId.value
  const epoch = saveEpoch.value + 1
  saveEpoch.value = epoch
  planSubmitting.value = true
  pendingPlanKey.value = `${context.runId ?? ''}|${jammer.id}`
  const saved = await telemetryStore.saveJammerPlan(taskId.value, jammer.id, submitted)
  // 更新的保存请求已开始：由新请求接管状态，旧响应不得覆盖。
  if (epoch !== saveEpoch.value) return
  planSubmitting.value = false
  pendingPlanKey.value = null
  // 设备/运行已切换：旧响应不写快照/错误，不污染当前选择。
  if (!sameContext()) return
  if (saved === null) {
    planError.value = '计划保存失败，请重试（未写入本地运行参数）。'
    return
  }
  // 请求期间用户未再编辑：直接用服务端响应回填表单，避免切设备/读取失败时表单仍为空。
  if (!planDirtySinceSubmit.value) {
    jammerStyle.value = saved.style
    elevation.value = saved.elevation
    planStartFrame.value = saved.plannedStartFrame
    planStopFrame.value = saved.plannedStopFrame
  }
  // 用服务端实际保存值（本次提交）设置快照；当前编辑值若已变化则显示为未保存。
  planSavedSnapshot.value = {
    style: saved.style,
    elevation: saved.elevation,
    start: saved.plannedStartFrame,
    stop: saved.plannedStopFrame,
  }
  planError.value = ''
}

/**
 * 提交当前 RF 干扰控制表单。
 * @returns 服务端接受并返回生效帧时返回 `true`。
 * @sideEffects 调用本机服务接口并更新面板执行状态；不把本地投影当作真实引擎执行。
 */
async function execute(): Promise<boolean> {
  if (selectedJammer.value === null) return false
  if (!validatePointingAndPlan()) return false
  const command: JammingCommand = { ...form }
  // 停扰允许 0 W 安全停止；非有限旧回显不阻断停止。
  if (!command.enabled && !(Number.isFinite(command.power) && command.power >= 0)) command.power = 0
  if (command.enabled && !isControlledPowerWatts(command.power)) {
    powerSubmitError.value = '启扰功率必须为 -10～30 dBm 且按 5 dB 档位设置。'
    return false
  }
  editing.value = false
  requestContext.value = {
    jammerId: selectedJammer.value.id,
    runId: telemetryStore.frame?.runId,
    taskId: taskId.value,
  }
  return telemetryStore.controlJammer(taskId.value, selectedJammer.value.id, command)
}

watch(jammers, (items) => {
  if (!items.some((item) => item.id === selectedJammerId.value)) selectedJammerId.value = items[0]?.id ?? ''
}, { immediate: true })
// 用显式快照区分设备/运行切换与仅帧变化；编辑中仅帧变化不覆盖正在编辑的值。
let lastControlContext: { jammerId: string; runId: string | undefined } | null = null
watch(
  [selectedJammerId, () => telemetryStore.frame?.runId, () => telemetryStore.frame?.frameId],
  ([jammerId]) => {
    const runId = telemetryStore.frame?.runId
    const deviceOrRunChanged = lastControlContext === null
      || jammerId !== lastControlContext.jammerId || runId !== lastControlContext.runId
    if (deviceOrRunChanged) {
      editing.value = false
      requestContext.value = null
      applyControlDefaults(jammerId)
      applyPlanDefaults(jammerId)
      // 设备/运行切换与首挂载按归属从运行期读取层读取已接受参数（即使帧已存在、缓存为空也读取）。
      if (jammerId !== '') void telemetryStore.loadJammerRuntimeParameters(taskId.value, jammerId, { force: true })
    } else if (!editing.value) {
      // 仅帧变化：非编辑态刷新控制表单，保留已填计划。
      applyControlDefaults(jammerId)
    }
    lastControlContext = { jammerId, runId }
  },
  { immediate: true },
)
// 运行期参数读取层更新（GET/同步/计划保存后）时，非编辑态回填样式/俯仰/计划帧。
// 仅当“正在保存的键 == 当前设备/运行键”时暂缓回填，避免覆盖该设备保存期间的新编辑；
// 切换到其他设备/运行时仍应立即回填其已保存计划。
watch(runtimeParameters, () => {
  if (editing.value || pendingPlanKey.value === currentPlanKey.value) return
  const jammerId = selectedJammerId.value
  if (jammerId === '') return
  applyControlDefaults(jammerId)
  applyPlanDefaults(jammerId)
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

      <el-form class="rf-panel__form" label-position="top" @focusin="editing = true" @focusout="onFormFocusOut">
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
        <el-form-item label="干扰样式">
          <el-radio-group v-model="jammerStyle" :disabled="pending" data-testid="rf-style" @change="onStyleChange">
            <el-radio-button value="BARRAGE">宽带压制</el-radio-button>
            <el-radio-button value="SPOT">瞄准式</el-radio-button>
          </el-radio-group>
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
        <el-form-item label="功率（dBm）" :error="powerSubmitError">
          <el-select
            :model-value="powerDbm"
            :disabled="pending"
            placeholder="选择 -10～30 dBm 档位"
            data-testid="rf-power-dbm"
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
        <el-form-item label="方向（°）">
          <el-input-number v-model="form.direction" :precision="1" :step="1" :disabled="pending" />
        </el-form-item>
        <el-form-item label="俯仰角（°）" :error="elevationError">
          <el-input-number v-model="elevation" :step="1" :disabled="pending" data-testid="rf-elevation" @update:model-value="markPlanDirty" />
        </el-form-item>
        <el-form-item label="持续时间（s）">
          <el-input-number v-model="form.duration" :precision="0" :step="10" :disabled="pending" />
        </el-form-item>
        <el-form-item label="计划启动帧">
          <el-input-number v-model="planStartFrame" :precision="0" :step="1" :disabled="pending" placeholder="如 300" data-testid="rf-plan-start" @update:model-value="markPlanDirty" />
        </el-form-item>
        <el-form-item label="计划停止帧" :error="planError">
          <el-input-number v-model="planStopFrame" :precision="0" :step="1" :disabled="pending" placeholder="如 900" data-testid="rf-plan-stop" @update:model-value="markPlanDirty" />
        </el-form-item>
        <el-form-item label="计划操作">
          <el-button :disabled="pending || planBusy || !canControl" :loading="planBusy" data-testid="rf-save-plan" @click="savePlan">保存计划</el-button>
        </el-form-item>
        <el-form-item label="样式带宽建议">
          <span class="rf-panel__hint">{{ styleBandwidthOptions.join(' / ') }} MHz（不超过设备带宽 {{ selectedJammer?.bandwidth ?? '—' }} MHz）</span>
        </el-form-item>
        <el-alert
          v-if="legacyPowerWarning"
          type="warning"
          :closable="false"
          show-icon
          :title="legacyPowerWarning"
          data-testid="rf-power-legacy-warning"
        />
        <el-alert
          v-if="elevationError"
          type="error"
          :closable="false"
          show-icon
          :title="elevationError"
          data-testid="rf-elevation-error"
        />
        <el-alert
          v-if="planError"
          type="error"
          :closable="false"
          show-icon
          :title="planError"
          data-testid="rf-plan-error"
        />
        <div class="rf-panel__action">
          <el-button type="primary" :loading="pending" :disabled="!canControl || selectedJammer === null" @click="execute">
            执行命令
          </el-button>
        </div>
      </el-form>

      <div class="rf-panel__status-strip" data-testid="rf-plan-status">
        <el-tag :type="planStatus === 'SAVED' ? 'success' : 'info'" size="small" effect="plain">
          计划：{{ planStatus === 'SAVED' ? '已保存（本地）' : '未保存' }}
        </el-tag>
        <el-tag :type="commandSent ? 'success' : 'info'" size="small" effect="plain">
          命令：{{ commandSent ? '已发送（本地投影）' : '未发送' }}
        </el-tag>
        <el-tag type="warning" size="small" effect="plain">引擎：未接入（无执行回执）</el-tag>
      </div>
      <p class="rf-panel__hint" data-testid="rf-plan-note">
        计划帧按输入原值保存（示例 300 帧启扰、900 帧停扰，不额外乘 5）；计划经本地 PUT 保存到运行期参数（LOCAL_RUN），不修改场景原配置，引擎排程与执行回执仍未接入。
      </p>

      <el-descriptions v-if="selectedJammer" :column="5" border size="small">
        <el-descriptions-item label="所属平台">{{ hostPlatform?.name ?? selectedJammer.platformId }}</el-descriptions-item>
        <el-descriptions-item label="设备状态">{{ selectedExtension?.enabled ? '可用' : '不可用' }}</el-descriptions-item>
        <el-descriptions-item label="频率边界">{{ frequencyRange.min }}–{{ frequencyRange.max }} MHz</el-descriptions-item>
        <el-descriptions-item label="默认功率">{{ selectedJammer.defaultPower }} W（默认值，非上限）</el-descriptions-item>
        <el-descriptions-item label="时长上限">{{ scenarioStore.draft?.config.scenario.duration }} s</el-descriptions-item>
      </el-descriptions>

      <el-result
        v-if="displayState === 'SUCCESS' && currentJammerState"
        icon="success"
        title="本地校验通过（未接入真实执行）"
        :sub-title="telemetryStore.jammerResultMessage"
      >
        <template #extra>
          <span class="rf-panel__result">
            {{ currentJammerState.power }} W / {{ currentJammerState.frequency }} MHz /
            {{ currentJammerState.duration }} s
          </span>
          <p class="rf-panel__source" data-testid="rf-result-source">{{ resultSourceLabel }}</p>
        </template>
      </el-result>

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

.rf-panel__form :deep(.el-alert),
.rf-panel__action,
.rf-panel__full {
  grid-column: 1 / -1;
}

.rf-panel__action {
  align-items: flex-end;
}

.rf-panel__status-strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.rf-panel__hint {
  margin: 0;
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
  line-height: 1.6;
}

.rf-panel__result {
  color: var(--console-teal);
  font-weight: 700;
}

.rf-panel__source {
  margin: var(--space-2) 0 0;
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

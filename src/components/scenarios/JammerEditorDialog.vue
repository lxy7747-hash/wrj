<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue'
import type { Jammer, JammerUiExtension, Link, Platform, ValidationIssue } from '../../contracts/domain-models'
import { fieldValidationMessage } from '../../features/scenarios/validation-fields'
import { BARRAGE_BANDWIDTH_OPTIONS_MHZ, JAMMER_CALC_DEFAULTS, computeJammerEirpDbw, readJammerBands, readJammerParameters, type ResolvedJammerBandParam, isJammerPlatformType, METERS_PER_KILOMETER, readJammerReleaseRange, JAMMER_EDITOR_POWER_DBM, isJammerEditorPowerDbm, wattsToDbm, dbmToWatts, SPOT_BANDWIDTH_MHZ, JAMMER_DEFAULTS } from '../../features/scenarios/jammer-settings'
import { scenarioPlatformLabel } from '../../features/scenarios/scenario-basic'

type JammerTypeOption = { value: Jammer['type'], label: string }
/** 模板 detection_radar 的 minimum_range 1 km。 */
const DEFAULT_DETECTION_MINIMUM_RANGE_M = 1000

const props = defineProps<{
  modelValue: boolean
  jammer: Jammer | null
  uiExtension: JammerUiExtension | null
  editing: boolean
  showIds?: boolean
  error: string
  pending: boolean
  locked: boolean
  platforms: readonly Platform[]
  links: readonly Link[]
  jammerTypeOptions: readonly JammerTypeOption[]
  minimumStep: number
  validate?: (jammer: Jammer, extension: JammerUiExtension) => ValidationIssue[]
}>()

const emit = defineEmits<{
  'update:modelValue': [visible: boolean]
  apply: [jammer: Jammer, uiExtension: JammerUiExtension]
  'frequency-input': [value: number | undefined]
  'bandwidth-input': [value: number | undefined]
  opened: []
}>()

const calcFields = [
  { key: 'radarFrequency', label: '侦测雷达频率（MHz）' },
  { key: 'radarBandwidth', label: '侦测雷达带宽（MHz）' },
  { key: 'radarPower', label: '侦测雷达功率（W）' },
  { key: 'noiseFigureDb', label: '侦测接收噪声系数（dB）' },
  { key: 'gtDbk', label: 'G/T（dB/K）' },
  { key: 'txLossDb', label: '发射损耗（dB）' },
  { key: 'sweepDutyCycle', label: '扫频占空比（0～1）' },
] as const
const editor = ref<Jammer | null>(null)
const uiEditor = ref<JammerUiExtension | null>(null)
const localError = ref('')
const validationTick = ref(0)
watch([editor, uiEditor], () => {
  validationTick.value += 1
  localError.value = ''
}, { deep: true, flush: 'sync' })
const issues = computed(() => {
  void validationTick.value
  return editor.value && uiEditor.value ? props.validate?.(editor.value, uiEditor.value) ?? [] : []
})
const fieldError = (path: string) => fieldValidationMessage(issues.value, path)
const jammerPlatforms = computed(() => props.platforms.filter(platform => isJammerPlatformType(platform.type)))
const legacyPlatformId = computed(() => editor.value?.platformId
  && !jammerPlatforms.value.some(platform => platform.id === editor.value?.platformId) ? editor.value.platformId : '')
const legacyPlatformName = computed(() => props.platforms.find(platform => platform.id === legacyPlatformId.value)?.name ?? '未找到节点')
/** 按 km 展示合同米字段；清空留给确认校验，不自动覆盖旧超界距离。 */
function kilometers(field: 'detectionRange' | 'jammingRange') {
  return computed<number | undefined>({
    get: () => editor.value ? Number((editor.value[field] / METERS_PER_KILOMETER).toFixed(3)) : undefined,
    set: value => { if (editor.value) editor.value[field] = typeof value === 'number' ? value * METERS_PER_KILOMETER : Number.NaN },
  })
}
const detectionRangeKm = kilometers('detectionRange')
const jammingRangeKm = kilometers('jammingRange')
/** 释放范围；旧记录缺省时展示干扰范围加 5 海里，编辑后才写入字段。 */
const releaseRangeKm = computed<number | undefined>({
  get: () => editor.value ? Number((readJammerReleaseRange(editor.value) / METERS_PER_KILOMETER).toFixed(3)) : undefined,
  set: value => { if (editor.value) editor.value.releaseRange = typeof value === 'number' ? value * METERS_PER_KILOMETER : Number.NaN },
})
/** 侦测最小距离；旧记录缺省时展示模板默认 1 km，编辑后才写入字段。 */
const detectionMinimumRangeKm = computed<number | undefined>({
  get: () => editor.value ? Number(((editor.value.detectionMinimumRange ?? DEFAULT_DETECTION_MINIMUM_RANGE_M) / METERS_PER_KILOMETER).toFixed(3)) : undefined,
  set: value => { if (editor.value) editor.value.detectionMinimumRange = typeof value === 'number' ? value * METERS_PER_KILOMETER : Number.NaN },
})
const powerDbmInput = ref<number | undefined>(undefined)
const powerDbmTouched = ref(false)
const eirpManualOverride = ref(false)
/** V1.2 的射频干扰输入使用 dBm，保存和脚本仍以 W 为合同单位。历史大功率 W 值不截断。 */
function resetPowerDbmInput(): void {
  powerDbmTouched.value = false
  eirpManualOverride.value = false
  const watts = editor.value?.defaultPower
  if (typeof watts !== 'number' || !Number.isFinite(watts) || watts <= 0) { powerDbmInput.value = undefined; return }
  const dbm = wattsToDbm(watts)
  powerDbmInput.value = isJammerEditorPowerDbm(dbm) ? Number(dbm.toFixed(6)) : undefined
}
const powerDbmError = computed(() => {
  if (!powerDbmTouched.value) return ''
  if (!isJammerEditorPowerDbm(powerDbmInput.value)) return '功率必须为 -10～65 dBm 且按 5 dB 档位设置。'
  return ''
})
/** 按 LinkCalcManager 插件公式同步干扰辐射功率（dBW）：功率(dBm) - 30 + 天线增益(dBi) - 发射损耗(dB)。 */
function syncEirpFromPower(force = false): void {
  if (!editor.value || (!force && eirpManualOverride.value)) return
  const dbm = isJammerEditorPowerDbm(powerDbmInput.value)
    ? powerDbmInput.value
    : (typeof editor.value.defaultPower === 'number' && Number.isFinite(editor.value.defaultPower) && editor.value.defaultPower > 0
      ? wattsToDbm(editor.value.defaultPower)
      : undefined)
  const gain = editor.value.antennaGainDbi
  if (dbm === undefined || typeof gain !== 'number' || !Number.isFinite(gain)) return
  const txLoss = typeof editor.value.txLossDb === 'number' && Number.isFinite(editor.value.txLossDb)
    ? editor.value.txLossDb
    : JAMMER_CALC_DEFAULTS.txLossDb
  editor.value.eirpDbw = computeJammerEirpDbw(dbm, gain, txLoss)
}
function setPowerDbm(value: number | undefined): void {
  powerDbmTouched.value = true
  powerDbmInput.value = value
  if (!editor.value) return
  if (isJammerEditorPowerDbm(value)) {
    editor.value.defaultPower = dbmToWatts(value)
    eirpManualOverride.value = false
    syncEirpFromPower(true)
  } else {
    editor.value.defaultPower = Number.NaN
  }
}
const legacyPower = computed(() => editor.value?.defaultPower !== undefined && !powerDbmTouched.value && powerDbmInput.value === undefined
  ? `${editor.value.defaultPower} W（历史值，超出 -10～65 dBm 新建范围）` : '')
const weaponBands = computed<ResolvedJammerBandParam[]>(() => {
  if (!editor.value) return []
  if (!Array.isArray(editor.value.weaponBands) || editor.value.weaponBands.length === 0) {
    editor.value.weaponBands = readJammerBands(editor.value)
  }
  return editor.value.weaponBands as ResolvedJammerBandParam[]
})

/** 将第 1 组频段同步到顶层 type / frequency / bandwidth，保持旧场景与下游运行态面板兼容。 */
function syncPrimaryBand(): void {
  const first = weaponBands.value[0]
  if (!editor.value || !first) return
  editor.value.type = first.mode
  editor.value.frequency = first.frequency
  editor.value.bandwidth = first.bandwidth
}

const customSpotBandwidths = ref<Record<number, boolean>>({})

function setBandMode(index: number, mode: Jammer['type']): void {
  const band = weaponBands.value[index]
  if (!editor.value || !band) return
  band.mode = mode
  if (mode === 'SPOT') {
    if (!Number.isFinite(band.spotBandwidthMHz) || band.spotBandwidthMHz <= 0) {
      band.spotBandwidthMHz = SPOT_BANDWIDTH_MHZ
    }
    band.sweepDutyCycle = 0
  } else if (mode === 'SWEEP') {
    if (!Number.isFinite(band.sweepDutyCycle) || band.sweepDutyCycle <= 0 || band.sweepDutyCycle > 1) {
      band.sweepDutyCycle = editor.value.sweepDutyCycle ?? JAMMER_CALC_DEFAULTS.sweepDutyCycle
    }
    band.spotBandwidthMHz = 0
  } else {
    band.spotBandwidthMHz = 0
    band.sweepDutyCycle = 0
  }
  if (index === 0) syncPrimaryBand()
}

/** 仅主动切换方式时填默认带宽，打开历史设备不改写。 */
function changeBandMode(index: number, mode: Jammer['type']): void {
  const band = weaponBands.value[index]
  if (!editor.value || !band) return
  customSpotBandwidths.value = { ...customSpotBandwidths.value, [index]: false }
  setBandMode(index, mode)
  if (mode === 'BARRAGE') band.bandwidth = JAMMER_DEFAULTS.bandwidth
  if (mode === 'SPOT') {
    band.bandwidth = SPOT_BANDWIDTH_MHZ
    band.spotBandwidthMHz = SPOT_BANDWIDTH_MHZ
  }
  if (index === 0) {
    syncPrimaryBand()
    emit('bandwidth-input', editor.value.bandwidth)
  }
}

function setBandFrequency(index: number, value: number | undefined): void {
  const band = weaponBands.value[index]
  if (!band) return
  band.frequency = value ?? Number.NaN
  if (index === 0) syncPrimaryBand()
  if (alignmentLinks.value.find(link => link.id === alignedLinkIds.value[index])?.frequency !== band.frequency) {
    alignedLinkIds.value = { ...alignedLinkIds.value, [index]: undefined }
  }
}

function setBandBandwidth(index: number, value: number | undefined): void {
  const band = weaponBands.value[index]
  if (!band) return
  band.bandwidth = value ?? Number.NaN
  if (band.mode === 'SPOT' && !customSpotBandwidths.value[index]) {
    band.spotBandwidthMHz = band.bandwidth
  }
  if (index === 0) syncPrimaryBand()
}

function setBandSpotBandwidth(index: number, value: number | undefined): void {
  const band = weaponBands.value[index]
  if (!band) return
  customSpotBandwidths.value = { ...customSpotBandwidths.value, [index]: true }
  band.spotBandwidthMHz = value ?? Number.NaN
}

function setBandSweepDuty(index: number, value: number | undefined): void {
  const band = weaponBands.value[index]
  if (!band) return
  band.sweepDutyCycle = value ?? Number.NaN
}

function applyBandwidthPreset(index: number, bandwidthMHz: number): void {
  if (!editor.value || props.pending || props.locked) return
  setBandBandwidth(index, bandwidthMHz)
  if (index === 0) emit('bandwidth-input', bandwidthMHz)
}

function addBand(): void {
  if (!editor.value || props.pending || props.locked) return
  const mode = editor.value.type
  const defaultBandwidth = mode === 'SPOT' ? SPOT_BANDWIDTH_MHZ : JAMMER_DEFAULTS.bandwidth
  weaponBands.value.push({
    frequency: JAMMER_DEFAULTS.frequency,
    bandwidth: defaultBandwidth,
    mode,
    spotBandwidthMHz: mode === 'SPOT' ? SPOT_BANDWIDTH_MHZ : 0,
    sweepDutyCycle: mode === 'SWEEP' ? (editor.value.sweepDutyCycle ?? JAMMER_CALC_DEFAULTS.sweepDutyCycle) : 0,
  })
  syncPrimaryBand()
}

function removeBand(index: number): void {
  if (!editor.value || props.pending || props.locked || weaponBands.value.length <= 1) return
  weaponBands.value.splice(index, 1)
  alignedLinkIds.value = {}
  customSpotBandwidths.value = {}
  syncPrimaryBand()
}

/** 可选数值字段：清空时省略键，生成器按模板缺省值补齐。 */
function setOptionalNumber(field: 'eirpDbw' | 'antennaGainDbi', value: number | null | undefined): void {
  if (!editor.value) return
  if (field === 'eirpDbw') eirpManualOverride.value = true
  if (value === null || value === undefined || Number.isNaN(value)) delete editor.value[field]
  else {
    editor.value[field] = value
    if (field === 'antennaGainDbi') syncEirpFromPower()
  }
}
function setCalcField(key: (typeof calcFields)[number]['key'], value: number | null | undefined): void {
  if (!editor.value) return
  editor.value[key] = value ?? Number.NaN
  if (key === 'txLossDb' && typeof value === 'number' && Number.isFinite(value)) syncEirpFromPower()
}
/** 必填数值项在界面先行拦截，避免清空后仍能确认。 */
function requiredNumberError(field: 'eirpDbw' | 'antennaGainDbi', label: string): string {
  return editor.value === null || (editor.value[field] !== undefined && Number.isFinite(editor.value[field])) ? '' : `请填写${label}。`
}
function bandFieldError(index: number, field: 'frequency' | 'bandwidth' | 'spotBandwidthMHz' | 'sweepDutyCycle', label: string): string {
  const direct = fieldError(`weaponBands[${index}].${field}`)
    || (index === 0 && (field === 'frequency' || field === 'bandwidth') ? fieldError(field) : '')
  if (direct) return direct
  const band = weaponBands.value[index]
  if (!band || !Number.isFinite(band[field])) return `请填写${label}。`
  if (field === 'spotBandwidthMHz' && band.mode === 'SPOT' && band.spotBandwidthMHz <= 0) return '瞄准带宽必须大于 0 MHz。'
  if (field === 'sweepDutyCycle' && band.mode === 'SWEEP' && (band.sweepDutyCycle <= 0 || band.sweepDutyCycle > 1)) return '扫频占空比须大于 0 且不超过 1。'
  return ''
}

const alignmentLinks = computed(() => props.links.filter(link => link.enabled !== false && link.type !== 'LASER'))
const alignedLinkIds = ref<Record<number, string | undefined>>({})
function alignFrequency(index: number, linkId: string | undefined): void {
  alignedLinkIds.value = { ...alignedLinkIds.value, [index]: linkId }
  const link = alignmentLinks.value.find(item => item.id === linkId)
  const band = weaponBands.value[index]
  if (editor.value && band && link) {
    band.frequency = link.frequency
    if (index === 0) {
      syncPrimaryBand()
      emit('frequency-input', link.frequency)
    }
  }
}

/** 确认干扰设备及界面扩展的临时副本；处理中、锁定时禁止提交。 */
function apply(): void {
  if (props.pending || props.locked || editor.value === null || uiEditor.value === null) return
  if (powerDbmError.value) {
    localError.value = powerDbmError.value
    return
  }
  const powerReady = typeof editor.value.defaultPower === 'number' && Number.isFinite(editor.value.defaultPower) && editor.value.defaultPower > 0
  if (!powerReady) {
    localError.value = '功率必须为 -10～65 dBm 且按 5 dB 档位设置。'
    return
  }
  const eirpReady = typeof editor.value.eirpDbw === 'number' && Number.isFinite(editor.value.eirpDbw)
  if (!eirpReady) {
    localError.value = '请填写干扰辐射功率。'
    return
  }
  const gainReady = typeof editor.value.antennaGainDbi === 'number' && Number.isFinite(editor.value.antennaGainDbi)
  if (!gainReady) {
    localError.value = '请填写天线增益。'
    return
  }
  for (let i = 0; i < weaponBands.value.length; i += 1) {
    const band = weaponBands.value[i]!
    const prefix = weaponBands.value.length > 1 ? `频段 ${i + 1}：` : ''
    if (!(typeof band.frequency === 'number' && Number.isFinite(band.frequency) && band.frequency > 0)) {
      localError.value = `${prefix}干扰频率必须大于 0 MHz。`
      return
    }
    if (!(typeof band.bandwidth === 'number' && Number.isFinite(band.bandwidth) && band.bandwidth > 0)) {
      localError.value = `${prefix}干扰带宽必须大于 0 MHz。`
      return
    }
    if (band.mode === 'SPOT' && !(typeof band.spotBandwidthMHz === 'number' && Number.isFinite(band.spotBandwidthMHz) && band.spotBandwidthMHz > 0)) {
      localError.value = `${prefix}瞄准带宽必须大于 0 MHz。`
      return
    }
    if (band.mode === 'SWEEP' && !(typeof band.sweepDutyCycle === 'number' && Number.isFinite(band.sweepDutyCycle) && band.sweepDutyCycle > 0 && band.sweepDutyCycle <= 1)) {
      localError.value = `${prefix}扫频占空比须大于 0 且不超过 1。`
      return
    }
  }
  localError.value = ''
  for (const band of weaponBands.value) {
    if (band.mode !== 'SPOT') band.spotBandwidthMHz = 0
    if (band.mode !== 'SWEEP') band.sweepDutyCycle = 0
  }
  syncPrimaryBand()
  for (const field of ['detectionDelayS', 'jammingDurationS'] as const) setOptionalSeconds(field, editor.value[field])
  emit('apply', editor.value, uiEditor.value)
}

/** 可选时序的空输入必须省略键，避免 JSON 将 NaN 序列化为 null。 */
function setOptionalSeconds(field: 'detectionDelayS' | 'jammingDurationS', value: number | null | undefined): void {
  if (!editor.value) return
  if (value == null || Number.isNaN(value)) delete editor.value[field]
  else editor.value[field] = value
}

/** 写入触发秒数；清空视为非法输入，已有未设置字段在未编辑时继续保留缺省。 */
function setTriggerTime(value: number | undefined): void {
  if (editor.value) editor.value.triggerTimeS = value ?? Number.NaN
}

/** 写入计划帧序号；非负整数，清空视为未配置（省略键）。0 是合法显式值，不当作未配置。 */
function setPlannedFrame(field: 'plannedStartFrame' | 'plannedStopFrame', value: number | null | undefined): void {
  if (!editor.value) return
  if (value === null || value === undefined || Number.isNaN(value)) delete editor.value[field]
  else editor.value[field] = value
}

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  editor.value = props.jammer === null ? null : readJammerParameters(structuredClone(toRaw(props.jammer)))
  uiEditor.value = props.uiExtension === null ? null : structuredClone(toRaw(props.uiExtension))
  alignedLinkIds.value = {}
  customSpotBandwidths.value = {}
  localError.value = ''
  resetPowerDbmInput()
}, { immediate: true })
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    class="link-editor-dialog scenario-dialog"
    :title="editing ? '编辑干扰设备' : '新增干扰设备'"
    width="min(760px, calc(100vw - 2rem))"
    destroy-on-close
    append-to-body
    data-testid="jammer-dialog"
    @opened="emit('opened')"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert v-if="error || localError" class="platform-feedback" type="error" :closable="false" :title="error || localError" show-icon />
    <el-form v-if="editor && uiEditor" class="link-editor-form" :model="editor" label-position="top" :disabled="pending || locked">
      <section class="link-editor-section" aria-labelledby="jammer-basic-title">
        <h4 id="jammer-basic-title" class="link-editor-section__title">基本信息</h4>
        <div class="link-editor-grid">
          <el-form-item required v-show="showIds" label="干扰设备 ID" :error="fieldError('id')"><el-input v-model="editor.id" :disabled="editing" data-testid="jammer-id" /></el-form-item>
          <el-form-item required label="所属干扰节点" :error="fieldError('platformId')">
            <el-select v-model="editor.platformId" filterable placeholder="请选择所属干扰节点" style="width: 100%" data-testid="jammer-platform">
              <el-option v-if="legacyPlatformId" :label="`${legacyPlatformName}（${legacyPlatformId}，旧归属待修正）`" :value="legacyPlatformId" disabled />
              <el-option v-for="platform in jammerPlatforms" :key="platform.id" :label="scenarioPlatformLabel(jammerPlatforms, platform.id, showIds)" :value="platform.id" />
            </el-select>
            <small v-if="legacyPlatformId" class="field-hint" data-testid="jammer-legacy-owner">旧归属不是干扰节点，请重新选择；取消不会修改原数据。</small>
            <small v-if="jammerPlatforms.length === 0" class="field-hint">请先在节点配置中新增干扰节点。</small>
          </el-form-item>
        </div>
      </section>

      <section class="link-editor-section" aria-labelledby="jammer-detection-title">
        <h4 id="jammer-detection-title" class="link-editor-section__title">侦测（ESM）</h4>
        <div class="link-editor-grid">
          <el-form-item required label="探测范围（km）" :error="fieldError('detectionRange')">
            <el-input-number v-model="detectionRangeKm" controls-position="right" data-testid="jammer-range" />
            <small :class="{ 'field-hint--hidden': !!fieldError('detectionRange') }" class="field-hint">范围 1～100 km；须大于侦测最小距离。</small>
          </el-form-item>
          <el-form-item required label="侦测最小距离（km）" :error="fieldError('detectionMinimumRange')">
            <el-input-number v-model="detectionMinimumRangeKm" :min="validate ? undefined : 0" :step="0.1" controls-position="right" data-testid="jammer-detection-minimum-range" />
            <small :class="{ 'field-hint--hidden': !!fieldError('detectionMinimumRange') }" class="field-hint">须小于探测范围。</small>
          </el-form-item>
        </div>
        <details class="scenario-advanced jammer-advanced-sub" data-testid="jammer-calc-advanced" :open="calcFields.some(field => fieldError(field.key))">
          <summary>侦测与链路计算专业参数</summary>
          <div class="link-editor-grid">
            <el-form-item v-for="field in calcFields.filter(item => item.key !== 'gtDbk' || fieldError(item.key))" :key="field.key" :label="field.label" :error="fieldError(field.key)">
              <el-input-number :model-value="editor[field.key]" :step="0.1" controls-position="right" :data-testid="`jammer-${field.key}`"
                @update:model-value="setCalcField(field.key, $event)" />
            </el-form-item>
          </div>
        </details>
      </section>

      <section class="link-editor-section" aria-labelledby="jammer-parameter-title">
        <h4 id="jammer-parameter-title" class="link-editor-section__title">干扰（射频发射）</h4>
        <div class="link-editor-grid">
          <el-form-item required label="干扰功率（dBm）" :error="powerDbmError || fieldError('defaultPower')">
            <el-input-number :model-value="powerDbmInput" :min="validate ? undefined : JAMMER_EDITOR_POWER_DBM.min" :max="validate ? undefined : JAMMER_EDITOR_POWER_DBM.max" :step="JAMMER_EDITOR_POWER_DBM.step" controls-position="right" data-testid="jammer-power" @update:modelValue="setPowerDbm" />
            <small v-if="legacyPower" class="field-hint" data-testid="jammer-legacy-power">{{ legacyPower }}</small>
            <small v-else class="field-hint" data-testid="jammer-power-hint">-10～65 dBm，步长 5 dB。</small>
          </el-form-item>
          <el-form-item required label="干扰辐射功率（dBW）" :error="fieldError('eirpDbw') || requiredNumberError('eirpDbw', '干扰辐射功率')">
            <el-input-number :model-value="editor.eirpDbw" :step="0.1" controls-position="right" data-testid="jammer-eirpDbw" @update:model-value="setOptionalNumber('eirpDbw', $event)" />
          </el-form-item>
          <el-form-item required label="天线增益（dBi）" :error="fieldError('antennaGainDbi') || requiredNumberError('antennaGainDbi', '天线增益')">
            <el-input-number :model-value="editor.antennaGainDbi" :step="0.1" controls-position="right" data-testid="jammer-antennaGainDbi" @update:model-value="setOptionalNumber('antennaGainDbi', $event)" />
          </el-form-item>
        </div>

        <div class="jammer-bands" data-testid="jammer-bands">
          <div class="jammer-bands__head">
            <div class="jammer-bands__title">
              <span>干扰频段</span>
              <el-tag size="small" effect="plain" type="info">共 {{ weaponBands.length }} 组</el-tag>
            </div>
            <el-button size="small" type="primary" plain :disabled="pending || locked" data-testid="jammer-add-band" @click="addBand">
              + 新增频段
            </el-button>
          </div>
          <p v-if="fieldError('weaponBands')" class="jammer-bands__error">{{ fieldError('weaponBands') }}</p>
          <div v-for="(band, index) in weaponBands" :key="index" class="jammer-band-card" :data-testid="`jammer-band-row-${index}`">
            <div class="jammer-band-card__head">
              <div class="jammer-band-card__label">
                <span>频段 {{ index + 1 }}</span>
                <el-tag v-if="weaponBands.length > 1 && index === 0" size="small" type="primary" effect="plain">主频段</el-tag>
              </div>
              <el-button link type="danger" size="small" :disabled="pending || locked || weaponBands.length <= 1"
                :data-testid="`jammer-remove-band-${index}`" @click="removeBand(index)">删除</el-button>
            </div>
            <div class="link-editor-grid">
              <el-form-item required label="干扰方式" :error="fieldError(`weaponBands[${index}].mode`) || (index === 0 ? fieldError('type') : '')">
                <el-select :model-value="band.mode" style="width: 100%"
                  :data-testid="index === 0 ? 'jammer-type' : `jammer-band-mode-${index}`"
                  @update:model-value="setBandMode(index, $event)"
                  @change="changeBandMode(index, $event)">
                  <el-option v-for="option in jammerTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
                </el-select>
              </el-form-item>
              <el-form-item v-if="band.mode === 'SPOT'" required label="瞄准带宽（MHz）" :error="bandFieldError(index, 'spotBandwidthMHz', '瞄准带宽')">
                <el-input-number :model-value="band.spotBandwidthMHz" :min="Number.MIN_VALUE" :step="minimumStep" controls-position="right"
                  :data-testid="`jammer-band-spot-bandwidth-${index}`"
                  @update:model-value="setBandSpotBandwidth(index, $event)" />
              </el-form-item>
              <el-form-item v-else-if="band.mode === 'SWEEP'" required label="扫频占空比（0～1）" :error="bandFieldError(index, 'sweepDutyCycle', '扫频占空比')">
                <el-input-number :model-value="band.sweepDutyCycle" :min="validate ? undefined : 0" :max="validate ? undefined : 1" :step="0.05" controls-position="right"
                  :data-testid="`jammer-band-sweep-duty-${index}`"
                  @update:model-value="setBandSweepDuty(index, $event)" />
              </el-form-item>
              <div v-else class="jammer-band-card__spacer" aria-hidden="true" />
              <el-form-item required label="干扰频率（MHz）" :error="bandFieldError(index, 'frequency', '干扰频率')">
                <el-input-number :model-value="band.frequency" :min="Number.MIN_VALUE" :step="minimumStep" controls-position="right"
                  :data-testid="index === 0 ? 'jammer-frequency' : `jammer-band-frequency-${index}`"
                  @update:model-value="setBandFrequency(index, $event)"
                  @input="index === 0 && emit('frequency-input', $event)" />
              </el-form-item>
              <el-form-item required label="干扰带宽（MHz）" :error="bandFieldError(index, 'bandwidth', '干扰带宽')">
                <el-input-number :model-value="band.bandwidth" :min="Number.MIN_VALUE" :step="minimumStep" controls-position="right"
                  :data-testid="index === 0 ? 'jammer-bandwidth' : `jammer-band-bandwidth-${index}`"
                  @update:model-value="setBandBandwidth(index, $event)"
                  @input="index === 0 && emit('bandwidth-input', $event)" />
                <div v-if="band.mode === 'BARRAGE'" class="jammer-bandwidth-presets" role="group" aria-label="宽带压制快捷带宽">
                  <el-button
                    v-for="preset in BARRAGE_BANDWIDTH_OPTIONS_MHZ"
                    :key="preset"
                    size="small"
                    :type="band.bandwidth === preset ? 'primary' : 'default'"
                    plain
                    :disabled="pending || locked"
                    :data-testid="index === 0 ? `jammer-bandwidth-preset-${preset}` : `jammer-band-preset-${index}-${preset}`"
                    @click="applyBandwidthPreset(index, preset)"
                  >{{ preset }} MHz</el-button>
                </div>
              </el-form-item>
              <el-form-item v-if="band.mode === 'SPOT'" label="对准链路" class="jammer-band-card__align">
                <el-select :model-value="alignedLinkIds[index]" clearable placeholder="请选择要对准的链路" style="width: 100%"
                  :data-testid="index === 0 ? 'jammer-aligned-link' : `jammer-band-aligned-link-${index}`"
                  @change="alignFrequency(index, $event)">
                  <el-option v-for="link in alignmentLinks" :key="link.id" :label="`${scenarioPlatformLabel(platforms, link.sourcePlatformId, showIds)} → ${scenarioPlatformLabel(platforms, link.targetPlatformId, showIds)} · ${link.frequency} MHz`" :value="link.id" />
                </el-select>
              </el-form-item>
            </div>
          </div>
        </div>
      </section>

      <section class="link-editor-section" aria-labelledby="jammer-range-title">
        <h4 id="jammer-range-title" class="link-editor-section__title">干扰触发范围</h4>
        <div class="link-editor-grid">
          <el-form-item required label="干扰范围（km）" :error="fieldError('jammingRange')">
            <el-input-number v-model="jammingRangeKm" controls-position="right" data-testid="jammer-jamming-range" />
            <small :class="{ 'field-hint--hidden': !!fieldError('jammingRange') }" class="field-hint">范围 0～100 km，0 表示不触发。</small>
          </el-form-item>
          <el-form-item required label="释放范围（km）" :error="fieldError('releaseRange')">
            <el-input-number v-model="releaseRangeKm" controls-position="right" data-testid="jammer-release-range" />
            <small :class="{ 'field-hint--hidden': !!fieldError('releaseRange') }" class="field-hint">范围 0～100 km，须不小于干扰范围。</small>
          </el-form-item>
        </div>
      </section>
    </el-form>
    <template #footer>
      <el-button data-testid="cancel-jammer" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="pending || locked" data-testid="apply-jammer" @click="apply">确认</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.platform-feedback {
  margin-bottom: 1rem;
}

.field-hint--hidden { visibility: hidden; }
:deep(.el-form-item.is-error:has(.field-hint--hidden) .el-form-item__error) { transform: translateY(-1.5em); }
.field-hint { color: var(--console-text-muted); line-height: 1.5; }

.link-editor-form {
  display: grid;
  gap: 0.5rem;
}

.link-editor-section {
  min-width: 0;
}

.link-editor-section__title {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0 0 0.375rem;
  color: var(--console-cyan);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
}

.link-editor-section__title::after {
  flex: 1;
  border-top: 1px solid var(--console-border);
  content: '';
}

.link-editor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 1rem;
}

.link-editor-grid :deep(.el-form-item) {
  /* 为绝对定位的校验红字预留一行，避免压到下一行字段。 */
  margin-bottom: 1.25rem;
}

.link-editor-grid :deep(.el-form-item__label) {
  margin-bottom: 0.25rem;
  line-height: 1.25rem;
}

.link-editor-grid :deep(.el-input-number) {
  width: 100%;
}

.jammer-bands {
  display: grid;
  gap: 0.55rem;
  margin-bottom: 0.5rem;
}

.jammer-bands__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.jammer-bands__title {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  color: var(--console-text);
  font-size: 13px;
  font-weight: 600;
}

.jammer-bands__error {
  margin: 0;
  color: var(--el-color-danger);
  font-size: 12px;
}

.jammer-band-card {
  padding: 0.6rem 0.75rem 0.15rem;
  border: 1px solid var(--console-border);
  border-radius: 6px;
  background: var(--console-bg-elevated);
}

.jammer-band-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}

.jammer-band-card__label {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--console-text-muted);
  font-size: 12px;
  font-weight: 600;
}

.jammer-band-card__align {
  grid-column: 1 / -1;
}

.jammer-band-card__spacer {
  display: block;
}

.jammer-bandwidth-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.35rem;
}

.jammer-bandwidth-presets :deep(.el-button) {
  margin-left: 0;
  padding: 0 0.5rem;
  height: 24px;
  font-size: 12px;
}

.jammer-advanced-sub {
  margin-top: 0.45rem;
}

@media (max-width: 600px) {
  .link-editor-grid {
    grid-template-columns: 1fr;
  }

  .jammer-band-card__align {
    grid-column: auto;
  }

  .jammer-band-card__spacer {
    display: none;
  }
}
</style>

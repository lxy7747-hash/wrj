<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue'
import type { Jammer, JammerUiExtension, Link, Platform, ValidationIssue } from '../../contracts/domain-models'
import { fieldValidationMessage } from '../../features/scenarios/validation-fields'
import { isJammerPlatformType, METERS_PER_KILOMETER, readJammerReleaseRange, JAMMER_POWER_DBM, isControlledPowerDbm, wattsToDbm, dbmToWatts, BARRAGE_BANDWIDTH_OPTIONS_MHZ, SPOT_BANDWIDTH_MHZ, JAMMER_DEFAULTS } from '../../features/scenarios/jammer-settings'
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

const editor = ref<Jammer | null>(null)
const uiEditor = ref<JammerUiExtension | null>(null)
const validationTick = ref(0)
watch([editor, uiEditor], () => { validationTick.value += 1 }, { deep: true, flush: 'sync' })
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
/** V1.2 的射频干扰输入使用 dBm，保存和脚本仍以 W 为合同单位。历史大功率 W 值不截断。 */
function resetPowerDbmInput(): void {
  powerDbmTouched.value = false
  const watts = editor.value?.defaultPower
  if (typeof watts !== 'number' || !Number.isFinite(watts) || watts <= 0) { powerDbmInput.value = undefined; return }
  const dbm = wattsToDbm(watts)
  powerDbmInput.value = isControlledPowerDbm(dbm) ? Number(dbm.toFixed(6)) : undefined
}
const powerDbmError = computed(() => {
  if (!powerDbmTouched.value) return ''
  if (!isControlledPowerDbm(powerDbmInput.value)) return '功率必须为 -10～30 dBm 且按 5 dB 档位设置。'
  return ''
})
function setPowerDbm(value: number | undefined): void {
  powerDbmTouched.value = true
  powerDbmInput.value = value
  if (!editor.value) return
  editor.value.defaultPower = isControlledPowerDbm(value) ? dbmToWatts(value) : Number.NaN
}
const legacyPower = computed(() => editor.value?.defaultPower !== undefined && !powerDbmTouched.value && powerDbmInput.value === undefined
  ? `${editor.value.defaultPower} W（历史值，超出 -10～30 dBm 新建范围）` : '')

const bandwidthOptions = computed<readonly number[]>(() => editor.value?.type === 'SPOT' ? [SPOT_BANDWIDTH_MHZ] : BARRAGE_BANDWIDTH_OPTIONS_MHZ)
const alignmentLinks = computed(() => props.links.filter(link => link.enabled !== false && link.type !== 'LASER'))
const alignedLinkId = ref<string>()
/** 仅主动切换方式时填默认带宽，打开历史设备不改写。 */
function changeJammerType(type: Jammer['type']): void {
  if (!editor.value) return
  if (type === 'BARRAGE') editor.value.bandwidth = JAMMER_DEFAULTS.bandwidth
  if (type === 'SPOT') editor.value.bandwidth = SPOT_BANDWIDTH_MHZ
  emit('bandwidth-input', editor.value.bandwidth)
}
function alignFrequency(linkId: string | undefined): void {
  const link = alignmentLinks.value.find(link => link.id === linkId)
  if (editor.value && link) {
    editor.value.frequency = link.frequency
    emit('frequency-input', link.frequency)
  }
}
watch(() => editor.value?.frequency, frequency => {
  if (alignmentLinks.value.find(link => link.id === alignedLinkId.value)?.frequency !== frequency) alignedLinkId.value = undefined
})

/** 确认干扰设备及界面扩展的临时副本；处理中、锁定时禁止提交。 */
function apply(): void {
  if (!props.pending && !props.locked && !powerDbmError.value && editor.value !== null && uiEditor.value !== null) {
    for (const field of ['detectionDelayS', 'jammingDurationS'] as const) setOptionalSeconds(field, editor.value[field])
    emit('apply', editor.value, uiEditor.value)
  }
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

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  editor.value = props.jammer === null ? null : structuredClone(toRaw(props.jammer))
  uiEditor.value = props.uiExtension === null ? null : structuredClone(toRaw(props.uiExtension))
  alignedLinkId.value = undefined
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
    <el-alert v-if="error" class="platform-feedback" type="error" :closable="false" :title="error" show-icon />
    <el-form v-if="editor && uiEditor" class="link-editor-form" :model="editor" label-position="top" :disabled="pending || locked">
      <section class="link-editor-section" aria-labelledby="jammer-basic-title">
        <h4 id="jammer-basic-title" class="link-editor-section__title">基本信息</h4>
        <div class="link-editor-grid">
          <el-form-item required v-show="showIds" label="干扰设备 ID" :error="fieldError('id')"><el-input v-model="editor.id" :disabled="editing" data-testid="jammer-id" /></el-form-item>
          <el-form-item required label="干扰方式" :error="fieldError('type')">
            <el-select v-model="editor.type" style="width: 100%" data-testid="jammer-type" @change="changeJammerType">
              <el-option v-for="option in jammerTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </el-form-item>
          <el-form-item required label="所属干扰节点" :error="fieldError('platformId')">
            <el-select v-model="editor.platformId" filterable placeholder="请选择所属干扰节点" style="width: 100%" data-testid="jammer-platform">
              <el-option v-if="legacyPlatformId" :label="`${legacyPlatformName}（${legacyPlatformId}，旧归属待修正）`" :value="legacyPlatformId" disabled />
              <el-option v-for="platform in jammerPlatforms" :key="platform.id" :label="scenarioPlatformLabel(jammerPlatforms, platform.id, showIds)" :value="platform.id" />
            </el-select>
            <small class="field-hint">选择设备的搭载节点，位置沿用该节点，不是选择干扰目标。</small>
            <small v-if="legacyPlatformId" class="field-hint" data-testid="jammer-legacy-owner">旧归属不是干扰节点，请重新选择；取消不会修改原数据。</small>
            <small v-if="jammerPlatforms.length === 0" class="field-hint">请先在节点配置中新增干扰节点。</small>
          </el-form-item>
        </div>
      </section>

      <section class="link-editor-section" aria-labelledby="jammer-parameter-title">
        <h4 id="jammer-parameter-title" class="link-editor-section__title">干扰参数</h4>
        <div class="link-editor-grid">
          <el-form-item required label="单干扰源发射功率（dBm）" :error="powerDbmError || fieldError('defaultPower')">
            <el-input-number :model-value="powerDbmInput" :min="validate ? undefined : JAMMER_POWER_DBM.min" :max="validate ? undefined : JAMMER_POWER_DBM.max" :step="JAMMER_POWER_DBM.step" controls-position="right" data-testid="jammer-power" @update:modelValue="setPowerDbm" />
            <small v-if="legacyPower" class="field-hint" data-testid="jammer-legacy-power">{{ legacyPower }}</small>
            <small v-else class="field-hint">-10～30 dBm，步长 5 dB；保存时换算为 W。</small>
          </el-form-item>
          <el-form-item required label="干扰中心频率（MHz）" :error="fieldError('frequency')"><el-input-number v-model="editor.frequency" :min="Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="jammer-frequency" @input="emit('frequency-input', $event)" /></el-form-item>
          <el-form-item v-if="editor.type === 'SPOT'" label="对准链路">
            <el-select v-model="alignedLinkId" clearable placeholder="请选择要对准的链路" data-testid="jammer-aligned-link" @change="alignFrequency">
              <el-option v-for="link in alignmentLinks" :key="link.id" :label="`${scenarioPlatformLabel(platforms, link.sourcePlatformId, showIds)} → ${scenarioPlatformLabel(platforms, link.targetPlatformId, showIds)} · ${link.frequency} MHz`" :value="link.id" />
            </el-select>
          </el-form-item>
          <el-form-item required label="干扰带宽（MHz）" :error="fieldError('bandwidth')">
            <el-select v-if="editor.type !== 'SWEEP'" v-model="editor.bandwidth" :disabled="editor.type === 'SPOT'" data-testid="jammer-bandwidth" @change="emit('bandwidth-input', $event)">
              <el-option v-if="!bandwidthOptions.includes(editor.bandwidth)" :label="`${editor.bandwidth} MHz（不在档位内）`" :value="editor.bandwidth" />
              <el-option v-for="bandwidth in bandwidthOptions" :key="bandwidth" :label="`${bandwidth} MHz`" :value="bandwidth" />
            </el-select>
            <el-input-number v-else v-model="editor.bandwidth" :min="Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="jammer-bandwidth" @input="emit('bandwidth-input', $event)" />
          </el-form-item>
          <el-form-item label="干扰触发时间（仿真秒）" :error="fieldError('triggerTimeS')">
            <el-input-number :model-value="editor.triggerTimeS" :min="validate ? undefined : 0" placeholder="未设置" controls-position="right" data-testid="jammer-trigger-time" @update:model-value="setTriggerTime" />
          </el-form-item>
          <el-form-item label="干扰延迟（秒）" :error="fieldError('detectionDelayS')">
            <el-input-number :model-value="editor.detectionDelayS" :min="validate ? undefined : 0" placeholder="未设置" controls-position="right" data-testid="jammer-detection-delay" @update:model-value="setOptionalSeconds('detectionDelayS', $event)" />
            <small class="field-hint">需要服务端同步更新后才能保存</small>
          </el-form-item>
          <el-form-item label="干扰持续时长（秒）" :error="fieldError('jammingDurationS')">
            <el-input-number :model-value="editor.jammingDurationS" :min="validate ? undefined : 0" placeholder="未设置" controls-position="right" data-testid="jammer-jamming-duration" @update:model-value="setOptionalSeconds('jammingDurationS', $event)" />
            <small class="field-hint">需要服务端同步更新后才能保存</small>
          </el-form-item>
          <el-form-item required label="方向（°）" :error="fieldError('direction')"><el-input-number v-model="uiEditor.direction" :min="validate ? undefined : 0" :max="validate ? undefined : 360" controls-position="right" data-testid="jammer-direction" /></el-form-item>
          <el-form-item label="俯仰角（°）" :error="fieldError('elevation')"><el-input-number v-model="uiEditor.elevation" :min="validate ? undefined : -10" :max="validate ? undefined : 60" controls-position="right" data-testid="jammer-elevation" /></el-form-item>
          <el-form-item label="启用" :error="fieldError('enabled')"><el-switch v-model="uiEditor.enabled" inline-prompt active-text="启用" inactive-text="停用" data-testid="jammer-enabled" /></el-form-item>
        </div>
        <small class="field-hint" data-testid="jammer-retained-hint">同类干扰节点的频率、带宽、功率与探测距离须一致，每个干扰节点只能配置一台干扰设备。</small>
      </section>
      <section class="link-editor-section" aria-labelledby="jammer-detection-title">
        <h4 id="jammer-detection-title" class="link-editor-section__title">范围设置</h4>
        <div class="link-editor-grid">
          <el-form-item required label="探测范围（km，1～100）" :error="fieldError('detectionRange')">
            <el-input-number v-model="detectionRangeKm" controls-position="right" data-testid="jammer-range" />
            <small class="field-hint">同时写入侦测雷达 maximum_range 与地面站 detection_range_nm（换算为海里）。</small>
          </el-form-item>
          <el-form-item required label="侦测最小距离（km）" :error="fieldError('detectionMinimumRange')">
            <el-input-number v-model="detectionMinimumRangeKm" :min="validate ? undefined : 0" :step="0.1" controls-position="right" data-testid="jammer-detection-minimum-range" />
            <small class="field-hint">写入侦测雷达 minimum_range，须小于探测范围；默认 1 km。</small>
          </el-form-item>
          <el-form-item required label="干扰范围（km，0～100）" :error="fieldError('jammingRange')">
            <el-input-number v-model="jammingRangeKm" controls-position="right" data-testid="jammer-jamming-range" />
            <small class="field-hint">干扰机进入此距离后开启，写入 jammer_param 的 trigger_radius_nm（海里）；0 表示不触发。</small>
          </el-form-item>
          <el-form-item required label="释放范围（km，0～100）" :error="fieldError('releaseRange')">
            <el-input-number v-model="releaseRangeKm" controls-position="right" data-testid="jammer-release-range" />
            <small class="field-hint">干扰机离开此距离后释放；不小于干扰范围，写入时换算为海里。</small>
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
  margin-bottom: 0.375rem;
}

.link-editor-grid :deep(.el-form-item__label) {
  margin-bottom: 0.25rem;
  line-height: 1.25rem;
}

.link-editor-grid :deep(.el-input-number) {
  width: 100%;
}

@media (max-width: 600px) {
  .link-editor-grid {
    grid-template-columns: 1fr;
  }
}
</style>

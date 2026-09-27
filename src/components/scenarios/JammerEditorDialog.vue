<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue'
import type { Jammer, JammerUiExtension, Platform } from '../../contracts/domain-models'
import { isJammerPlatformType, METERS_PER_NAUTICAL_MILE } from '../../features/scenarios/jammer-settings'
import { scenarioPlatformLabel } from '../../features/scenarios/scenario-basic'

type JammerTypeOption = { value: Jammer['type'], label: string }

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
  jammerTypeOptions: readonly JammerTypeOption[]
  minimumStep: number
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
const jammerPlatforms = computed(() => props.platforms.filter(platform => isJammerPlatformType(platform.type)))
const legacyPlatformId = computed(() => editor.value?.platformId
  && !jammerPlatforms.value.some(platform => platform.id === editor.value?.platformId) ? editor.value.platformId : '')
const legacyPlatformName = computed(() => props.platforms.find(platform => platform.id === legacyPlatformId.value)?.name ?? '未找到节点')
const detectionRangeNm = computed<number | undefined>({
  get: () => editor.value ? editor.value.detectionRange / METERS_PER_NAUTICAL_MILE : undefined,
  /** 将用户输入的海里换算为合同米；清空留给确认校验，不自动覆盖旧超界距离。 */
  set: value => { if (editor.value) editor.value.detectionRange = typeof value === 'number' ? value * METERS_PER_NAUTICAL_MILE : Number.NaN },
})
const jammingRangeNm = computed<number | undefined>({
  get: () => editor.value ? editor.value.jammingRange / METERS_PER_NAUTICAL_MILE : undefined,
  /** 干扰有效作用距离；单位与探测范围一致（海里展示、合同米）。 */
  set: value => { if (editor.value) editor.value.jammingRange = typeof value === 'number' ? value * METERS_PER_NAUTICAL_MILE : Number.NaN },
})

/** 确认干扰设备及界面扩展的临时副本；处理中、锁定时禁止提交。 */
function apply(): void {
  if (!props.pending && !props.locked && editor.value !== null && uiEditor.value !== null) emit('apply', editor.value, uiEditor.value)
}

/** 写入触发秒数；清空视为非法输入，已有未设置字段在未编辑时继续保留缺省。 */
function setTriggerTime(value: number | undefined): void {
  if (editor.value) editor.value.triggerTimeS = value ?? Number.NaN
}

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  editor.value = props.jammer === null ? null : structuredClone(toRaw(props.jammer))
  uiEditor.value = props.uiExtension === null ? null : structuredClone(toRaw(props.uiExtension))
}, { immediate: true })
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    class="link-editor-dialog"
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
          <el-form-item required v-show="showIds" label="干扰设备 ID"><el-input v-model="editor.id" :disabled="editing" data-testid="jammer-id" /></el-form-item>
          <el-form-item required label="干扰方式">
            <el-select v-model="editor.type" style="width: 100%" data-testid="jammer-type">
              <el-option v-for="option in jammerTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </el-form-item>
          <el-form-item required label="所属干扰节点">
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
          <el-form-item required label="单干扰源发射功率（W）"><el-input-number v-model="editor.defaultPower" :min="Number.MIN_VALUE" controls-position="right" data-testid="jammer-power" /></el-form-item>
          <el-form-item required label="干扰中心频率（MHz）"><el-input-number v-model="editor.frequency" :min="Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="jammer-frequency" @input="emit('frequency-input', $event)" /></el-form-item>
          <el-form-item required label="干扰带宽（MHz）"><el-input-number v-model="editor.bandwidth" :min="Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="jammer-bandwidth" @input="emit('bandwidth-input', $event)" /></el-form-item>
          <el-form-item label="干扰触发时间（仿真秒）"><el-input-number :model-value="editor.triggerTimeS" :min="0" placeholder="未设置" controls-position="right" data-testid="jammer-trigger-time" @update:model-value="setTriggerTime" /></el-form-item>
          <el-form-item required label="方向（°）"><el-input-number v-model="uiEditor.direction" :min="0" :max="360" controls-position="right" data-testid="jammer-direction" /></el-form-item>
          <el-form-item required label="持续时间（s）"><el-input-number v-model="uiEditor.duration" :min="0" controls-position="right" data-testid="jammer-duration" /></el-form-item>
          <el-form-item label="启用"><el-switch v-model="uiEditor.enabled" inline-prompt active-text="启用" inactive-text="停用" data-testid="jammer-enabled" /></el-form-item>
        </div>
      </section>
      <section class="link-editor-section" aria-labelledby="jammer-detection-title">
        <h4 id="jammer-detection-title" class="link-editor-section__title">范围设置</h4>
        <div class="link-editor-grid">
          <el-form-item label="自动检测"><el-switch v-model="editor.autoDetect" inline-prompt active-text="开启" inactive-text="关闭" data-testid="jammer-auto-detect" /></el-form-item>
          <el-form-item required label="探测范围（海里，1～24）">
            <el-input-number v-model="detectionRangeNm" controls-position="right" data-testid="jammer-range" />
            <small class="field-hint">自动探测发现目标的距离；合同单位为米。</small>
          </el-form-item>
          <el-form-item required label="干扰范围（海里，1～24）">
            <el-input-number v-model="jammingRangeNm" controls-position="right" data-testid="jammer-jamming-range" />
            <small class="field-hint">干扰有效作用距离；自动探测仅在此范围内启停干扰。候选脚本无 weapon 最大作用距离指令。</small>
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

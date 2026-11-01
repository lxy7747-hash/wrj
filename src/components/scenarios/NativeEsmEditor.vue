<script lang="ts">
import type { NativeEsmSettings } from '../../contracts/domain-models'
/** The values below are the exact values accepted by the local AFSIM 2.9 probe. */
export const NATIVE_ESM_PROBE_DEFAULTS: NativeEsmSettings = {
  sensitivityDbw: -200,
  detectionThresholdDb: 0,
  dwellTimeS: 1,
  revisitTimeS: 1,
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import type { NativeEsmSettings } from '../../contracts/domain-models'

const props = defineProps<{ modelValue?: NativeEsmSettings; disabled?: boolean; sensorId: string; fieldMessage?: (path: string) => string }>()
const emit = defineEmits<{ 'update:modelValue': [value: NativeEsmSettings | undefined] }>()

const nativeEnabled = computed({
  get: () => props.modelValue !== undefined,
  set: (enabled: boolean) => emit('update:modelValue', enabled ? { ...NATIVE_ESM_PROBE_DEFAULTS } : undefined),
})

function setValue<K extends keyof NativeEsmSettings>(field: K, value: number | undefined): void {
  if (props.modelValue === undefined) return
  emit('update:modelValue', { ...props.modelValue, [field]: value ?? Number.NaN })
}
</script>

<template>
  <section class="native-esm-editor" :data-testid="`native-esm-${sensorId}`">
    <div class="native-esm-editor__heading">
      <el-switch v-model="nativeEnabled" :disabled="disabled" :data-testid="`native-esm-enabled-${sensorId}`" />
      <strong>原生 ESM</strong>
      <el-tag v-if="modelValue" type="success" size="small">WSF_ESM_SENSOR</el-tag>
      <el-tag v-else type="info" size="small">兼容雷达</el-tag>
    </div>
    <p v-if="!modelValue" class="native-esm-editor__hint">旧记录保持 WSF_RADAR_SENSOR 兼容路径；启用后才生成经本机 AFSIM 2.9 探针验证的被动侦测器。</p>
    <template v-else>
      <div class="native-esm-editor__fields">
        <el-form-item label="灵敏度（dBW）" :error="fieldMessage?.('sensitivityDbw') ?? ''"><el-input-number :model-value="modelValue.sensitivityDbw" :max="fieldMessage ? undefined : 0" controls-position="right" :disabled="disabled" :data-testid="`native-esm-sensitivity-${sensorId}`" @update:model-value="setValue('sensitivityDbw', $event)" /></el-form-item>
        <el-form-item label="检测阈值（dB）" :error="fieldMessage?.('detectionThresholdDb') ?? ''"><el-input-number :model-value="modelValue.detectionThresholdDb" :min="fieldMessage ? undefined : 0" controls-position="right" :disabled="disabled" :data-testid="`native-esm-threshold-${sensorId}`" @update:model-value="setValue('detectionThresholdDb', $event)" /></el-form-item>
        <el-form-item label="驻留时间（s）" :error="fieldMessage?.('dwellTimeS') ?? ''"><el-input-number :model-value="modelValue.dwellTimeS" :min="fieldMessage ? undefined : Number.MIN_VALUE" controls-position="right" :disabled="disabled" :data-testid="`native-esm-dwell-${sensorId}`" @update:model-value="setValue('dwellTimeS', $event)" /></el-form-item>
        <el-form-item label="重访时间（s）" :error="fieldMessage?.('revisitTimeS') ?? ''"><el-input-number :model-value="modelValue.revisitTimeS" :min="fieldMessage ? undefined : Number.MIN_VALUE" controls-position="right" :disabled="disabled" :data-testid="`native-esm-revisit-${sensorId}`" @update:model-value="setValue('revisitTimeS', $event)" /></el-form-item>
      </div>
      <p class="native-esm-editor__hint">频段来自最低/最高频率。概率、探测距离与方向没有已证实的一对一原生 ESM 指令，仅作为历史/规划字段保留，不会写入引擎。</p>
    </template>
  </section>
</template>

<style scoped>
.native-esm-editor__fields :deep(.el-form-item) { margin-bottom: 0; }
.native-esm-editor__fields :deep(.el-form-item__error) { position: static; }
.native-esm-editor { min-width: 24rem; }
.native-esm-editor__heading { display: flex; align-items: center; gap: 0.4rem; }
.native-esm-editor__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.4rem; margin-top: 0.45rem; }
.native-esm-editor__fields :deep(.el-form-item__label) { display: grid; gap: 0.2rem; color: var(--console-text-muted); font-size: 0.75rem; }
.native-esm-editor__fields :deep(.el-input-number) { width: 100%; }
.native-esm-editor__hint { margin: 0.4rem 0 0; color: var(--console-text-muted); font-size: 0.75rem; line-height: 1.45; }
</style>

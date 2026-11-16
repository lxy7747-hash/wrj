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
  <details class="native-esm-editor scenario-advanced" :data-testid="`native-esm-${sensorId}`"
    :open="['sensitivityDbw', 'detectionThresholdDb', 'dwellTimeS', 'revisitTimeS'].some(key => fieldMessage?.(key))">
    <summary>ESM 专业参数</summary>
    <div class="native-esm-editor__heading">
      <el-switch v-model="nativeEnabled" :disabled="disabled" :data-testid="`native-esm-enabled-${sensorId}`" />
      <strong>原生 ESM（仅配置）</strong>
      <el-tag v-if="modelValue" type="success" size="small">已配置</el-tag>
      <el-tag v-else type="info" size="small">兼容雷达</el-tag>
    </div>
    <template v-if="modelValue">
      <div class="native-esm-editor__fields">
        <el-form-item label="灵敏度（dBW）" :error="fieldMessage?.('sensitivityDbw') ?? ''"><el-input-number :model-value="modelValue.sensitivityDbw" :max="fieldMessage ? undefined : 0" controls-position="right" :disabled="disabled" :data-testid="`native-esm-sensitivity-${sensorId}`" @update:model-value="setValue('sensitivityDbw', $event)" /></el-form-item>
        <el-form-item label="检测阈值（dB）" :error="fieldMessage?.('detectionThresholdDb') ?? ''"><el-input-number :model-value="modelValue.detectionThresholdDb" :min="fieldMessage ? undefined : 0" controls-position="right" :disabled="disabled" :data-testid="`native-esm-threshold-${sensorId}`" @update:model-value="setValue('detectionThresholdDb', $event)" /></el-form-item>
        <el-form-item label="驻留时间（s）" :error="fieldMessage?.('dwellTimeS') ?? ''"><el-input-number :model-value="modelValue.dwellTimeS" :min="fieldMessage ? undefined : Number.MIN_VALUE" controls-position="right" :disabled="disabled" :data-testid="`native-esm-dwell-${sensorId}`" @update:model-value="setValue('dwellTimeS', $event)" /></el-form-item>
        <el-form-item label="重访时间（s）" :error="fieldMessage?.('revisitTimeS') ?? ''"><el-input-number :model-value="modelValue.revisitTimeS" :min="fieldMessage ? undefined : Number.MIN_VALUE" controls-position="right" :disabled="disabled" :data-testid="`native-esm-revisit-${sensorId}`" @update:model-value="setValue('revisitTimeS', $event)" /></el-form-item>
      </div>
    </template>
  </details>
</template>

<style scoped>
.native-esm-editor__fields :deep(.el-form-item) { margin-bottom: 0; }
.native-esm-editor__fields :deep(.el-form-item__error) { position: static; }
.native-esm-editor { min-width: 24rem; }
.native-esm-editor__heading { display: flex; align-items: center; gap: 0.4rem; }
.native-esm-editor__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.4rem; margin-top: 0.45rem; }
.native-esm-editor__fields :deep(.el-form-item__label) { display: grid; gap: 0.2rem; color: var(--console-text-muted); font-size: 0.75rem; }
.native-esm-editor__fields :deep(.el-input-number) { width: 100%; }
</style>

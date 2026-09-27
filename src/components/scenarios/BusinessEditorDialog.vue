<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue'
import { ElDialog, ElForm } from 'element-plus'
import type { InformationDemand, Platform } from '../../contracts/domain-models'
import { changeBusinessDirection } from '../../features/scenarios/business-defaults'

const props = defineProps<{
  modelValue: boolean
  demand: InformationDemand | null
  editing: boolean
  error: string
  disabled: boolean
  platforms: readonly Platform[]
  embedded?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [visible: boolean]
  apply: [demand: InformationDemand]
  opened: []
}>()
const localEditor = ref<InformationDemand | null>(null)
// 嵌入链路时编辑的仍是父弹框临时副本，统一确认前不写入场景。
const editor = computed(() => props.embedded ? props.demand : localEditor.value)
const volumeUnit = ref<'B' | 'KB' | 'MB'>('MB')
const unitFactors = { B: 1_000_000, KB: 1000, MB: 1 }
// 已确认选择：中文业务类型限定四枚举；不再提供视频帧语义选项。
const typeOptions = computed(() => {
  const types = editor.value?.direction === 'FORWARD' ? ['态势信息', '目标指令']
    : editor.value?.direction === 'REVERSE' ? ['侦察信息', '状态信息']
      : ['态势信息', '目标指令', '侦察信息', '状态信息']
  return [...new Set([...types, ...(editor.value?.informationType ? [editor.value.informationType] : [])])]
})
const volume = computed<number | undefined>({
  get: () => editor.value ? editor.value.volumeMb * unitFactors[volumeUnit.value] : undefined,
  /** 将显示单位换算为合同 MB（十进制）；清空保留非法值，由确认校验阻断。 */
  set: value => { if (editor.value) editor.value.volumeMb = typeof value === 'number' ? value / unitFactors[volumeUnit.value] : Number.NaN },
})

/** 切换业务方向；新增时仅替换仍等于原默认值的参数，编辑模式不重置参数。 */
function changeDirection(direction: 'FORWARD' | 'REVERSE'): void {
  if (!editor.value || props.disabled) return
  changeBusinessDirection(editor.value, direction, props.editing)
  volumeUnit.value = editor.value.volumeMb < 0.001 ? 'B' : editor.value.volumeMb < 1 ? 'KB' : 'MB'
}

/** 确认临时业务副本；禁用期间不提交，取消不会改变场景原始数据。 */
function apply(): void {
  if (editor.value && !props.disabled) emit('apply', structuredClone(toRaw(editor.value)))
}

watch([() => props.modelValue, () => props.embedded ? props.demand?.direction : undefined], ([visible]) => {
  if (!visible) return
  localEditor.value = props.demand ? { enabled: true, ...structuredClone(toRaw(props.demand)) } : null
  volumeUnit.value = editor.value && editor.value.volumeMb < 0.001 ? 'B' : editor.value && editor.value.volumeMb < 1 ? 'KB' : 'MB'
}, { immediate: true })
</script>

<template>
  <component :is="embedded ? 'section' : ElDialog" :model-value="modelValue" :title="embedded ? undefined : editing ? '编辑业务' : '新增业务'"
    width="min(760px, calc(100vw - 2rem))" top="5vh" append-to-body destroy-on-close
    :data-testid="embedded ? 'link-business-fields' : 'business-dialog'" @opened="emit('opened')" @update:model-value="emit('update:modelValue', $event)">
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <component :is="embedded ? 'div' : ElForm" v-if="editor" label-position="top" :disabled="disabled" class="business-editor">
      <el-form-item v-if="!embedded" label="业务方向"><el-select :model-value="editor.direction" placeholder="旧业务未设置方向" data-testid="demand-direction" @change="changeDirection">
        <el-option label="前向" value="FORWARD" /><el-option label="返向" value="REVERSE" />
      </el-select></el-form-item>
      <el-form-item required label="信息类型"><el-select v-model="editor.informationType" data-testid="demand-type">
        <el-option v-for="type in typeOptions" :key="type" :label="type" :value="type" />
      </el-select></el-form-item>
      <el-form-item required v-if="!embedded" label="源平台"><el-select v-model="editor.sourcePlatformId" filterable data-testid="demand-source">
        <el-option v-for="platform in platforms" :key="platform.id" :label="`${platform.name}（${platform.id}）`" :value="platform.id" />
      </el-select></el-form-item>
      <el-form-item required v-if="!embedded" label="目标平台"><el-select v-model="editor.destinationPlatformIds" multiple collapse-tags filterable data-testid="demand-destinations">
        <el-option v-for="platform in platforms" :key="platform.id" :label="`${platform.name}（${platform.id}）`" :value="platform.id" />
      </el-select></el-form-item>
      <el-form-item required :label="'单报文信息量'">
        <div class="business-editor__volume"><el-input-number v-model="volume" :min="0" controls-position="right" data-testid="demand-volume" />
          <el-select v-model="volumeUnit" aria-label="信息量单位" data-testid="demand-volume-unit">
            <el-option label="字节" value="B" /><el-option label="KB" value="KB" /><el-option label="MB" value="MB" />
          </el-select></div>
      </el-form-item>
      <el-form-item required :label="'传输频次（次/秒）'">
        <el-input-number v-model="editor.frequencyHz" :min="0" controls-position="right" data-testid="demand-frequency" />
      </el-form-item>
      <el-form-item required label="最低业务速率（Mbps）"><el-input-number v-model="editor.minDataRateMbps" :min="0" :step="0.001" controls-position="right" data-testid="demand-rate" /></el-form-item>
      <el-form-item required label="最大时延（ms）"><el-input-number v-model="editor.maxLatencyMs" :min="0" controls-position="right" data-testid="demand-latency" /></el-form-item>
    </component>
    <template v-if="!embedded" #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :disabled="disabled" data-testid="apply-business" @click="apply">确认</el-button></template>
  </component>
</template>

<style scoped>
.business-editor { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 1rem; margin-top: 1rem; }
.business-editor :deep(.el-input-number) { width: 100%; }
.business-editor__volume { display: flex; gap: 0.5rem; width: 100%; }
.business-editor__volume :deep(.el-select) { width: 90px; flex-shrink: 0; }
@media (max-width: 600px) { .business-editor { grid-template-columns: 1fr; } }
</style>

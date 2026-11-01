<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { TaskPhase } from '../../contracts/domain-models'
import { taskPhaseIssue } from '../../features/scenarios/task-phases'

const props = defineProps<{ modelValue?: TaskPhase[]; duration: number; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: TaskPhase[]] }>()
const phases = computed(() => props.modelValue ?? [])
const issue = computed(() => taskPhaseIssue(props.modelValue, props.duration))
const adding = ref<TaskPhase | null>(null)
const addingIssue = computed(() => adding.value === null ? null : taskPhaseIssue([...phases.value, adding.value], props.duration))
const addDisabled = computed(() => props.disabled || phases.value.length >= 64 || !Number.isFinite(props.duration) || props.duration <= 0)

/** taskPhaseIssue 的路径是场景中的完整字段路径；仅将当前字段的即时校验文字交给对应表单项。 */
function fieldMessage(validation: ReturnType<typeof taskPhaseIssue>, fieldPath: string): string {
  if (validation === null) return ''
  return validation.fieldPath === fieldPath || validation.fieldPath.startsWith(`${fieldPath}.`)
    || fieldPath.startsWith(`${validation.fieldPath}.`) ? validation.message : ''
}

function existingFieldMessage(index: number, field: keyof TaskPhase): string {
  return fieldMessage(issue.value, `scenario.phases[${index}].${field}`)
}

function addingFieldMessage(field: keyof TaskPhase): string {
  return fieldMessage(addingIssue.value, `scenario.phases[${phases.value.length}].${field}`)
}

function update(index: number, field: keyof TaskPhase, value: unknown): void {
  emit('update:modelValue', phases.value.map((phase, position) => position === index ? { ...phase, [field]: value } : { ...phase }))
}
function add(): void {
  if (addDisabled.value) return
  const used = new Set(phases.value.map(phase => phase.id)); let index = 1
  while (used.has(`PHASE-${index}`)) index++
  adding.value = { id: `PHASE-${index}`, name: `阶段${index}`, startTimeS: phases.value.at(-1)?.endTimeS ?? 0, endTimeS: props.duration }
}

function confirmAdd(): void {
  if (adding.value === null || addDisabled.value) return
  const next = [...phases.value.map(phase => ({ ...phase })), { ...adding.value }]
  const validation = taskPhaseIssue(next, props.duration)
  if (validation) { ElMessage.error(validation.message); return }
  emit('update:modelValue', next)
  adding.value = null
}

// 阶段计划、时长或锁状态变化后，关闭尚未确认的新增副本。
watch([() => props.modelValue, () => props.duration, () => props.disabled], () => { adding.value = null }, { deep: true })
</script>

<template>
  <section class="task-phases" aria-label="任务阶段" data-testid="task-phase-editor">
    <div v-for="(phase, index) in phases" :key="index" class="phase-row">
      <el-form-item :error="existingFieldMessage(index, 'id')">
        <el-input :model-value="phase.id" :aria-label="`阶段${index + 1}编号`" placeholder="阶段编号" :disabled="disabled" maxlength="64" @update:model-value="update(index, 'id', $event)" />
      </el-form-item>
      <el-form-item :error="existingFieldMessage(index, 'name')">
        <el-input :model-value="phase.name" :aria-label="`阶段${index + 1}名称`" placeholder="阶段名称" :disabled="disabled" maxlength="80" @update:model-value="update(index, 'name', $event)" />
      </el-form-item>
      <el-form-item :error="existingFieldMessage(index, 'startTimeS')">
        <el-input-number :model-value="phase.startTimeS" :controls="false" :aria-label="`阶段${index + 1}开始秒数`" :disabled="disabled" @update:model-value="update(index, 'startTimeS', $event)" />
      </el-form-item>
      <el-form-item :error="existingFieldMessage(index, 'endTimeS')">
        <el-input-number :model-value="phase.endTimeS" :controls="false" :aria-label="`阶段${index + 1}结束秒数`" :disabled="disabled" @update:model-value="update(index, 'endTimeS', $event)" />
      </el-form-item>
      <el-button :disabled="disabled" @click="emit('update:modelValue', phases.filter((_, position) => position !== index))">移除</el-button>
    </div>
    <p v-if="issue" class="phase-error" role="alert">{{ issue.message }}</p>
    <el-button :disabled="addDisabled" @click="add">添加任务阶段</el-button>
    <el-dialog :model-value="adding !== null" title="添加任务阶段" width="min(560px, calc(100vw - 2rem))"
      class="task-phase-dialog" top="10vh" destroy-on-close append-to-body @update:model-value="!$event && (adding = null)">
      <el-form v-if="adding" :model="adding" label-position="top" :disabled="disabled" @submit.prevent="confirmAdd">
        <div class="phase-form-grid">
          <el-form-item required label="阶段编号" :error="addingFieldMessage('id')">
            <el-input v-model="adding.id" maxlength="64" placeholder="阶段编号" data-testid="new-phase-id" />
          </el-form-item>
          <el-form-item required label="阶段名称" :error="addingFieldMessage('name')">
            <el-input v-model="adding.name" maxlength="80" placeholder="阶段名称" data-testid="new-phase-name" />
          </el-form-item>
          <el-form-item required label="开始时刻（秒）" :error="addingFieldMessage('startTimeS')">
            <el-input-number v-model="adding.startTimeS" controls-position="right" data-testid="new-phase-start" />
          </el-form-item>
          <el-form-item required label="结束时刻（秒）" :error="addingFieldMessage('endTimeS')">
            <el-input-number v-model="adding.endTimeS" controls-position="right" data-testid="new-phase-end" />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button data-testid="cancel-task-phase" @click="adding = null">取消</el-button>
        <el-button type="primary" :disabled="addDisabled" data-testid="confirm-task-phase" @click="confirmAdd">确认</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.task-phases { width: 100%; min-width: 0; }
.task-phases p { margin: 0 0 10px; font-size: 12px; }
.phase-row { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) repeat(2, minmax(0, 0.8fr)) auto; align-items: start; gap: 4px; margin-bottom: 8px; }
.phase-row :deep(.el-form-item) { min-width: 0; margin-bottom: 0; }
.phase-row :deep(.el-input), .phase-row :deep(.el-input-number) { width: 100%; min-width: 0; }
.phase-row :deep(.el-input__wrapper) { padding-inline: 6px; }
.phase-row :deep(.el-input-number .el-input__wrapper) { padding-inline: 4px; }
.phase-error { color: var(--el-color-danger); }
.phase-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.phase-form-grid :deep(.el-input-number) { width: 100%; }
:global(.task-phase-dialog) { display: flex; flex-direction: column; max-height: 80vh; }
:global(.task-phase-dialog .el-dialog__body) { min-height: 0; overflow-y: auto; }
@media (max-width: 540px) { .phase-form-grid { grid-template-columns: 1fr; } }
</style>

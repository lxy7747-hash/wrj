<script setup lang="ts">
import { computed, ref } from 'vue'
import type { LinkType, Platform, SatelliteType, ScenarioLinkSettings } from '../../contracts/domain-models'
import { readLinkSettings } from '../../features/scenarios/link-settings'

const props = defineProps<{
  modelValue?: ScenarioLinkSettings
  dialogVisible?: boolean
  platforms: Platform[]
  disabled: boolean
  typeOptions: readonly { value: LinkType; label: string }[]
}>()
const emit = defineEmits<{
  'update:modelValue': [value: ScenarioLinkSettings]
  'update:dialogVisible': [visible: boolean]
}>()
const settings = computed(() => readLinkSettings({ platforms: props.platforms, linkSettings: props.modelValue }))
const satellites = [{ value: 'TIANTONG', label: '天通卫星' }, { value: 'SHENTONG', label: '神通卫星' }] as const
const draggedType = ref<LinkType | null>(null)
const dropTarget = ref<LinkType | null>(null)

/** 更新卫星启用状态；type 为卫星子类型，enabled 为开关值，实体仍保留在场景中。 */
function setSatelliteEnabled(type: SatelliteType, enabled: boolean | string | number): void {
  if (props.disabled) return
  emit('update:modelValue', { ...settings.value, enabledSatellites: { ...settings.value.enabledSatellites, [type]: enabled === true } })
}

/** 保存冷却秒数；清空值保留为非法数值供整体校验阻断，避免静默改回默认值。 */
function setCooldown(value: number | undefined): void {
  if (!props.disabled) emit('update:modelValue', { ...settings.value, switchCooldownS: value ?? Number.NaN })
}

/** 移动优先级；type 为待移动类型，index 为目标顺位（从零开始），其余类型按原顺序顺延。 */
function movePriority(type: LinkType, index: number): void {
  if (props.disabled) return
  const priority = [...settings.value.priority]
  const previousIndex = priority.indexOf(type)
  if (previousIndex < 0 || previousIndex === index || index < 0 || index >= priority.length) return
  priority.splice(previousIndex, 1)
  priority.splice(index, 0, type)
  emit('update:modelValue', { ...settings.value, priority })
}

/** 开始原生拖拽；type 为当前类型，event 提供浏览器拖放数据，仅记录来源，不提前修改配置。 */
function startDrag(type: LinkType, event: DragEvent): void {
  if (props.disabled) {
    event.preventDefault()
    return
  }
  draggedType.value = type
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', type)
  }
}

/** 松开后将本列表拖拽的类型移到 index 顺位；外部拖入不修改配置。 */
function dropPriority(index: number): void {
  if (draggedType.value !== null) movePriority(draggedType.value, index)
  resetDrag()
}

/** 拖拽完成或取消时清除来源和目标高亮，不修改优先级。 */
function resetDrag(): void {
  draggedType.value = null
  dropTarget.value = null
}
</script>

<template>
  <div data-testid="link-settings">
    <el-button size="small" :disabled="disabled" data-testid="open-link-settings" @click="emit('update:dialogVisible', true)">链路设置</el-button>
  </div>
  <el-dialog :model-value="dialogVisible" title="链路设置" width="min(680px, calc(100vw - 2rem))"
    destroy-on-close append-to-body data-testid="link-settings-dialog" @closed="resetDrag" @update:model-value="emit('update:dialogVisible', $event)">
    <el-form label-position="top" :disabled="disabled" class="link-settings__fields">
      <div class="link-settings__strategy">
        <div class="link-settings__heading">链路优先级 <small>拖拽排序，越靠上优先级越高</small></div>
        <ol class="link-settings__priority" aria-label="链路优先级，从高到低">
          <li v-for="(type, index) in settings.priority" :key="type"
            :class="{ 'is-dragging': draggedType === type, 'is-drop-target': !disabled && dropTarget === type && draggedType !== type }"
            @dragover.prevent="!disabled && draggedType !== null && (dropTarget = type)" @drop.prevent="dropPriority(index)">
            <button type="button" class="link-settings__priority-item" :disabled="disabled" :draggable="!disabled"
              :data-testid="`link-priority-${index}`"
              :aria-label="`${typeOptions.find(option => option.value === type)?.label ?? type}，优先级 ${index + 1}，使用上下方向键调整`"
              title="拖拽调整顺序，也可使用上下方向键"
              @dragstart="startDrag(type, $event)" @dragend="resetDrag"
              @keydown.up.prevent="movePriority(type, index - 1)" @keydown.down.prevent="movePriority(type, index + 1)">
              <svg class="link-settings__drag-handle" viewBox="0 0 16 20" aria-hidden="true" fill="currentColor">
                <circle v-for="n in 6" :key="n" :cx="n % 2 ? 5 : 11" :cy="4 + Math.floor((n - 1) / 2) * 6" r="1.5" />
              </svg>
              <span class="link-settings__rank">{{ index + 1 }}</span>
              <span>{{ typeOptions.find(option => option.value === type)?.label ?? type }}</span>
              <small v-if="index === 0">最高</small>
            </button>
          </li>
        </ol>
      </div>
      <div class="link-settings__heading">中继卫星选择</div>
      <div class="link-settings__switches" role="group" aria-label="中继卫星选择">
        <el-form-item v-for="satellite in satellites" :key="satellite.value" :label="satellite.label">
          <el-switch :model-value="settings.enabledSatellites[satellite.value]" active-text="启用" inactive-text="停用"
            :disabled="!platforms.some(p => p.type === 'COMMUNICATION_SATELLITE' && p.satelliteType === satellite.value)"
            :data-testid="`link-satellite-enabled-${satellite.value}`" @change="setSatelliteEnabled(satellite.value, $event)" />
          <small v-if="!platforms.some(p => p.type === 'COMMUNICATION_SATELLITE' && p.satelliteType === satellite.value)">请先在平台与航点中配置</small>
        </el-form-item>
      </div>
      <el-form-item label="防乒乓滞回时间（秒）">
        <el-input-number :model-value="settings.switchCooldownS" :min="0" :step="1" controls-position="right"
          data-testid="link-switch-cooldown" @update:model-value="setCooldown" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button type="primary" data-testid="close-link-settings" @click="emit('update:dialogVisible', false)">完成</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.link-settings__strategy { min-width: 0; margin-bottom: 1rem; }
.link-settings__heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }
.link-settings__heading small, .link-settings__priority-item small { color: var(--console-text-muted); font-size: 12px; }
.link-settings__priority { display: grid; gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
.link-settings__priority-item { display: flex; align-items: center; gap: 0.65rem; width: 100%; padding: 0.45rem 0.65rem; border: 1px solid var(--console-border); border-radius: 4px; background: var(--console-bg-elevated); color: var(--console-text); font: inherit; text-align: left; cursor: grab; }
.link-settings__priority-item small { margin-left: auto; }
.link-settings__priority-item:active { cursor: grabbing; }
.link-settings__priority-item:disabled { opacity: 0.5; cursor: not-allowed; }
.link-settings__priority-item:focus-visible { outline: 2px solid var(--console-cyan); outline-offset: 2px; }
.link-settings__priority-item:not(:disabled):hover, .is-drop-target .link-settings__priority-item { border-color: var(--console-cyan); }
.is-dragging { opacity: 0.5; }
.link-settings__drag-handle { width: 16px; height: 20px; flex-shrink: 0; color: var(--console-text-muted); }
.link-settings__rank { min-width: 1.25rem; color: var(--console-cyan); font-variant-numeric: tabular-nums; }
.link-settings__switches { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0 1rem; }
.link-settings__switches small { display: block; width: 100%; color: var(--console-text-muted); font-size: 12px; }
.link-settings__fields :deep(.el-input-number) { width: 100%; }
</style>

<script setup lang="ts">
import { computed } from 'vue'
import type { CapabilityState, ConfigurationLockState, SimulationMode, UiSimulationStatus } from '../../contracts/domain-models'
import { formatSimulationTime } from '../../features/situation/situation-model'

const props = defineProps<{
  status: UiSimulationStatus
  currentTime: number
  speed: number
  mode: SimulationMode
  lockState: ConfigurationLockState
  capabilityState: CapabilityState
  processId: number | null
  progress: number
  pending: boolean
  feedback: string
  /** 只读初始位置尚未接入运行引擎，禁止调用 Mock 控制命令。 */
  readOnly?: boolean
}>()

defineEmits<{
  start: []
  pause: []
  step: []
  stop: []
  'update:speed': [value: number]
  'update:mode': [value: SimulationMode]
}>()

const statusLabel = computed(() => ({
  IDLE: '待运行',
  STOPPED: '已停止',
  RUNNING: '运行中',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  ERROR: '运行异常',
})[props.status])

const lockLabel = computed(() => ({
  UNLOCKED: '场景配置未锁定',
  LOCKING: '正在锁定场景配置',
  LOCKED: '场景配置已锁定',
  UNLOCKING: '正在解除场景配置锁',
  ERROR: '场景配置锁异常',
})[props.lockState])
</script>

<template>
  <header class="simulation-toolbar" aria-label="仿真控制">
    <div class="simulation-toolbar__title">
      <strong>态势主界面</strong>
      <span>跨海区域 · 多异构链路协同通联</span>
    </div>

    <div class="simulation-toolbar__controls">
      <el-button
        type="primary"
        size="small"
        data-testid="simulation-start"
        :loading="pending && (status === 'STOPPED' || status === 'IDLE' || status === 'PAUSED')"
        :disabled="readOnly || pending || status === 'RUNNING'"
        @click="$emit('start')"
      >
        <span aria-hidden="true">▶</span>
        {{ status === 'PAUSED' ? '继续' : '开始' }}
      </el-button>
      <el-button
        type="warning"
        size="small"
        data-testid="simulation-pause"
        :disabled="readOnly || pending || status !== 'RUNNING'"
        @click="$emit('pause')"
      ><span aria-hidden="true">⏸</span> 暂停</el-button>
      <el-button
        size="small"
        data-testid="simulation-step"
        :disabled="readOnly || pending || status !== 'PAUSED'"
        @click="$emit('step')"
      ><span aria-hidden="true">⏭</span> 单步</el-button>
      <el-button
        type="danger"
        plain
        size="small"
        data-testid="simulation-stop"
        :disabled="readOnly || pending || (status !== 'RUNNING' && status !== 'PAUSED')"
        @click="$emit('stop')"
      ><span aria-hidden="true">■</span> 停止</el-button>

      <label class="simulation-toolbar__select">
        <select
          :value="speed"
          aria-label="仿真倍速"
          :disabled="readOnly || pending"
          @change="$emit('update:speed', Number(($event.target as HTMLSelectElement).value))"
        >
          <option :value="1">倍速 ×1</option>
          <option :value="2">×2</option>
          <option :value="4">×4</option>
          <option :value="8">×8</option>
        </select>
      </label>
      <label class="simulation-toolbar__select">
        <select
          :value="mode"
          aria-label="运行模式"
          :disabled="readOnly || pending || status === 'RUNNING' || status === 'PAUSED'"
          @change="$emit('update:mode', ($event.target as HTMLSelectElement).value as SimulationMode)"
        >
          <option value="INTERACTIVE_SINGLE">单次仿真</option>
          <option value="BATCH_PARAMETER_TRAVERSAL">批量仿真</option>
          <option value="PARAMETER_SCAN">参数扫描</option>
          <option value="HISTORICAL_REPLAY">历史回放</option>
        </select>
      </label>
    </div>

    <div v-if="readOnly" class="simulation-toolbar__runtime" aria-live="polite">
      <small>{{ feedback }}</small>
    </div>
    <div v-else class="simulation-toolbar__runtime" aria-live="polite">
      <strong data-testid="simulation-clock">{{ formatSimulationTime(currentTime) }}</strong>
      <span :class="['runtime-state', `runtime-state--${status.toLowerCase()}`]">
        <i aria-hidden="true"></i>{{ statusLabel }}
      </span>
      <small data-testid="simulation-feedback">{{ lockLabel }} · {{ feedback }}</small>
      <small data-testid="engine-resource">
        AFSIM 2.9.0 · {{ processId === null ? '模拟进程资源已释放' : `模拟进程 ${processId}` }} · 进度 {{ progress.toFixed(1) }}%
      </small>
      <small v-if="capabilityState === 'ERROR'" class="simulation-toolbar__error">运行控制异常</small>
    </div>
  </header>
</template>

<style scoped>
.simulation-toolbar {
  display: grid;
  min-height: 3.55rem;
  grid-template-columns: minmax(12rem, 1fr) auto minmax(12rem, 1fr);
  align-items: center;
  gap: 0.75rem;
  padding: 0.45rem 0.75rem;
  border-bottom: 1px solid var(--console-border);
  background: #071725;
}

.simulation-toolbar__title {
  display: grid;
  gap: 0.15rem;
  min-width: 0;
}

.simulation-toolbar__title strong {
  color: var(--console-text);
  font-size: 0.92rem;
}

.simulation-toolbar__title span,
.simulation-toolbar__runtime small {
  overflow: hidden;
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.simulation-toolbar__controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.simulation-toolbar__controls :deep(.el-button) {
  height: auto;
  margin-left: 0;
  padding: 6px 14px;
  border: 1px solid #27435f;
  border-radius: 4px;
  color: #a8bfd4;
  background: #16283c;
  font-size: 13px;
  cursor: pointer;
}

.simulation-toolbar__controls :deep(.el-button.el-button--primary) {
  border-color: #0e8fe0;
  color: #fff;
  background: #0e8fe0;
}

.simulation-toolbar__controls :deep(.el-button.el-button--warning) {
  border-color: #b87410;
  color: #fff;
  background: #b87410;
}

.simulation-toolbar__controls :deep(.el-button.el-button--danger) {
  border-color: #c23b3b;
  color: #fff;
  background: #c23b3b;
}

.simulation-toolbar__controls :deep(.el-button.is-disabled) {
  opacity: 0.45;
  cursor: not-allowed;
}

.simulation-toolbar__select {
  display: flex;
}

.simulation-toolbar__select select {
  padding: 6px 10px;
  border: 1px solid #27435f;
  border-radius: 4px;
  color: #a8bfd4;
  background: #16283c;
  font-size: 13px;
}

.simulation-toolbar__runtime {
  display: grid;
  grid-template-columns: auto auto;
  align-items: center;
  justify-content: end;
  gap: 0.1rem 0.65rem;
  text-align: right;
}

.simulation-toolbar__runtime strong {
  color: var(--console-cyan);
  font-family: Consolas, monospace;
  font-size: 0.82rem;
}

.simulation-toolbar__runtime small {
  grid-column: 1 / -1;
}

.simulation-toolbar__error {
  color: var(--console-danger) !important;
}

.runtime-state {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.runtime-state i {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: var(--console-text-dim);
}

.runtime-state--running i {
  background: var(--console-teal);
  box-shadow: 0 0 0.5rem rgba(77, 224, 181, 0.7);
}

.runtime-state--paused i {
  background: var(--console-amber);
}

.runtime-state--completed i {
  background: var(--console-cyan);
}

.runtime-state--error i {
  background: #ff5b5b;
}

@media (max-width: 1500px) {
  .simulation-toolbar {
    grid-template-columns: 11rem 1fr 10.5rem;
  }

  .simulation-toolbar__title span {
    display: none;
  }

  .simulation-toolbar__controls :deep(.el-button),
  .simulation-toolbar__select select {
    padding: 5px 8px;
    font-size: 12px;
  }
}
</style>

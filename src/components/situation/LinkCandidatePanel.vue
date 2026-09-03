<script setup lang="ts">
import { computed } from 'vue'
import type { CapabilityState, TelemetryFrame } from '../../contracts/domain-models'
import {
  formatBer,
  validateCandidateSnapshot,
  type SituationLinkView,
} from '../../features/situation/situation-model'

const props = defineProps<{
  modelValue: boolean
  frame: TelemetryFrame | null
  links: SituationLinkView[]
  capabilityState: CapabilityState
  feedback: string
}>()

defineEmits<{
  'update:modelValue': [value: boolean]
  reload: []
}>()

const candidates = computed(() => props.frame?.evidence.routeCandidates ?? [])

const snapshotIssue = computed(() => {
  if (props.frame === null) return null
  return validateCandidateSnapshot(props.frame)
})

const displayState = computed<CapabilityState>(() => {
  if (props.capabilityState !== 'SUCCESS') return props.capabilityState
  if (props.frame === null || candidates.value.length === 0) return 'EMPTY'
  return snapshotIssue.value === null ? 'SUCCESS' : 'ERROR'
})

const stateText = computed(() => {
  if (displayState.value === 'LOADING') return '正在加载链路质量数据'
  if (displayState.value === 'VALIDATING') return '正在校验候选快照'
  if (displayState.value === 'SUCCESS') return '候选快照有效'
  if (displayState.value === 'EMPTY') return '当前帧没有候选链路'
  return snapshotIssue.value?.message ?? props.feedback
})

const candidateRows = computed(() => candidates.value.map((candidate) => ({
  ...candidate,
  link: props.links.find((item) => item.linkId === candidate.linkId),
})))
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    width="min(58rem, calc(100vw - 2rem))"
    class="link-candidate-dialog"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="link-candidate-dialog__header">
        <span>链路候选集合</span>
        <strong v-if="frame">{{ frame.taskId }} · {{ frame.frameId }} · {{ frame.simulationTime }} s</strong>
      </div>
    </template>

    <section :data-state="displayState" aria-live="polite">
      <div v-if="displayState === 'SUCCESS' && frame" class="candidate-snapshot">
        <dl class="candidate-snapshot__identity">
          <div><dt>任务</dt><dd>{{ frame.taskId }}</dd></div>
          <div><dt>固定帧</dt><dd>{{ frame.frameId }}</dd></div>
          <div><dt>仿真时刻</dt><dd>{{ frame.simulationTime }} s</dd></div>
          <div><dt>候选数量</dt><dd>{{ candidateRows.length }} 条</dd></div>
        </dl>

        <div class="candidate-table-wrap">
          <table class="candidate-table">
            <thead><tr><th>候选链路</th><th>方向</th><th>质量状态</th><th>可用状态</th><th>BER</th><th>干扰影响</th><th>稳定历史</th></tr></thead>
            <tbody>
              <tr v-for="candidate in candidateRows" :key="candidate.linkId" :data-candidate-id="candidate.linkId">
                <td><strong>{{ candidate.linkId }}</strong><small>{{ candidate.link?.sourceName }} → {{ candidate.link?.destinationName }}</small></td>
                <td>{{ candidate.direction === 'FORWARD' ? '前向' : '返向' }}</td>
                <td>{{ candidate.link?.status === 'UP' ? '正常' : candidate.link?.status === 'DEGRADED' ? '劣化' : '中断' }}</td>
                <td><el-tag :type="candidate.eligible ? 'success' : 'danger'" effect="dark">{{ candidate.eligible ? '可用' : '不可用' }}</el-tag></td>
                <td>{{ formatBer(candidate.ber) }}</td>
                <td>{{ candidate.jamImpactDb.toFixed(2) }} dB</td>
                <td>连续 {{ candidate.stabilityFrames }} 帧</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-else class="candidate-state" :class="`candidate-state--${displayState.toLowerCase()}`">
        <strong>{{ displayState === 'ERROR' ? '候选快照不可用' : stateText }}</strong>
        <p v-if="displayState === 'ERROR'">{{ stateText }}</p>
        <dl v-if="displayState === 'ERROR' && snapshotIssue" class="candidate-state__error">
          <div><dt>错误码</dt><dd data-testid="candidate-error-code">{{ snapshotIssue.code }}</dd></div>
          <div><dt>字段路径</dt><dd data-testid="candidate-error-path">{{ snapshotIssue.fieldPath }}</dd></div>
        </dl>
        <el-button v-if="displayState === 'ERROR'" type="primary" data-testid="candidate-reload" @click="$emit('reload')">
          重新加载
        </el-button>
      </div>
    </section>
  </el-dialog>
</template>

<style scoped>
.link-candidate-dialog__header { display: grid; gap: .15rem; }
.link-candidate-dialog__header span { color: var(--console-text); font-size: .95rem; font-weight: 700; }
.link-candidate-dialog__header strong { color: var(--console-cyan); font-family: Consolas, monospace; font-size: var(--console-font-size-min); }
.candidate-snapshot { display: grid; gap: .75rem; }
.candidate-snapshot__identity { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .5rem; margin: 0; }
.candidate-snapshot__identity div { padding: .55rem .65rem; border: 1px solid var(--console-border); border-radius: 5px; background: var(--console-bg-elevated); }
.candidate-snapshot__identity dt { color: var(--console-text-muted); font-size: var(--console-font-size-min); }
.candidate-snapshot__identity dd { margin: .18rem 0 0; color: var(--console-text); font-family: Consolas, "Microsoft YaHei", monospace; font-size: .76rem; }
.candidate-table-wrap { overflow-x: auto; border: 1px solid var(--console-border); border-radius: 6px; }
.candidate-table { width: 100%; min-width: 46rem; border-collapse: collapse; }
.candidate-table th, .candidate-table td { padding: .55rem .65rem; border-bottom: 1px solid var(--console-border); text-align: left; }
.candidate-table th { color: var(--console-text-muted); background: rgba(16, 40, 58, .72); font-size: var(--console-font-size-min); }
.candidate-table td { color: var(--console-text); font-family: Consolas, "Microsoft YaHei", monospace; font-size: var(--console-font-size-min); }
.candidate-table tbody tr:last-child td { border-bottom: 0; }
.candidate-table td strong, .candidate-table td small { display: block; }
.candidate-table td small { margin-top: .15rem; color: var(--console-text-muted); font-family: "Microsoft YaHei", sans-serif; }
.candidate-table .el-tag { height: auto; border: 0; font-size: var(--console-font-size-min); line-height: 1.4; }
.candidate-state { display: grid; min-height: 13rem; place-content: center; justify-items: center; gap: .45rem; color: var(--console-text-muted); text-align: center; }
.candidate-state strong { color: var(--console-text); }
.candidate-state p { max-width: 32rem; margin: 0; }
.candidate-state__error { display: grid; gap: .25rem; margin: 0; }
.candidate-state__error div { display: flex; gap: .5rem; }
.candidate-state__error dt { color: var(--console-text-muted); }
.candidate-state__error dd { margin: 0; font-family: Consolas, monospace; }
.candidate-state--error strong, .candidate-state--error p { color: var(--console-danger); }
@media (max-width: 760px) { .candidate-snapshot__identity { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>

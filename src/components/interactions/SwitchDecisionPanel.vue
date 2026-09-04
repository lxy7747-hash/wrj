<script setup lang="ts">
import { computed } from 'vue'
import type { CapabilityState, SwitchEvent } from '../../contracts/domain-models'
import { useTelemetryStore } from '../../stores/telemetry'

const telemetryStore = useTelemetryStore()
type FixedEvidenceState = Exclude<CapabilityState, 'EXECUTING'>
const decisions = computed(() => telemetryStore.events.filter(
  (event): event is SwitchEvent => event.type === 'LINK_SWITCH',
))
const acceptedCount = computed(() => decisions.value.filter((item) => item.decision === 'ACCEPTED').length)
const rejectedCount = computed(() => decisions.value.length - acceptedCount.value)
const displayState = computed<FixedEvidenceState>(() => {
  if (telemetryStore.capabilityState !== 'SUCCESS') return telemetryStore.capabilityState
  return decisions.value.length === 0 ? 'EMPTY' : 'SUCCESS'
})
const stateLabel = computed(() => ({
  LOADING: '加载中', VALIDATING: '校验中',
  SUCCESS: '记录完整', EMPTY: '无切换', ERROR: '记录错误',
})[displayState.value])
const stateType = computed(() => ({
  LOADING: 'info', VALIDATING: 'warning',
  SUCCESS: 'success', EMPTY: 'info', ERROR: 'danger',
} as const)[displayState.value])

/** 将切换原因码转换为中文显示。 */
function reasonLabel(reason: string): string {
  return ({ BER_THRESHOLD_AND_HYSTERESIS: 'BER 阈值与滞回条件满足', COOLDOWN_ACTIVE: '切换冷却期未结束' } as Record<string, string>)[reason] ?? reason
}

/** 以可读科学计数法展示误码率。 */
function formatBer(value: number): string {
  return value.toExponential(2)
}
</script>

<template>
  <el-card class="p4-panel" shadow="never" aria-labelledby="switch-decision-title" data-testid="switch-decision-panel">
    <template #header>
      <div class="p4-panel__header">
        <div><p class="eyebrow">T-XQ-021 · 切换决策与事件</p><h3 id="switch-decision-title">链路切换记录</h3></div>
        <div class="switch-summary"><el-tag type="success">接受 {{ acceptedCount }}</el-tag><el-tag type="danger">拒绝 {{ rejectedCount }}</el-tag><el-tag :type="stateType" effect="dark">{{ stateLabel }}</el-tag></div>
      </div>
    </template>

    <el-skeleton v-if="displayState === 'LOADING'" :rows="3" animated />
    <el-result v-else-if="displayState === 'ERROR'" icon="error" title="切换记录不可用" :sub-title="telemetryStore.resultMessage" />
    <el-empty v-else-if="displayState === 'EMPTY'" description="当前帧没有链路切换决策" />
    <el-table v-else :data="decisions" size="small" border>
      <el-table-column prop="eventId" label="事件" width="92" />
      <el-table-column label="结果" width="82"><template #default="scope"><el-tag :type="scope.row.decision === 'ACCEPTED' ? 'success' : 'danger'" size="small">{{ scope.row.decision === 'ACCEPTED' ? '接受' : '拒绝' }}</el-tag></template></el-table-column>
      <el-table-column label="路由变化" min-width="190"><template #default="scope">{{ scope.row.oldLinkId }} → {{ scope.row.newLinkId }}</template></el-table-column>
      <el-table-column label="BER 变化" min-width="175"><template #default="scope">{{ formatBer(scope.row.oldBer) }} → {{ formatBer(scope.row.newBer) }}</template></el-table-column>
      <el-table-column label="稳定/要求" width="105"><template #default="scope">{{ scope.row.stabilityFrames }} / {{ scope.row.minimumStableFrames }} 帧</template></el-table-column>
      <el-table-column label="滞回" width="78"><template #default="scope">{{ scope.row.hysteresisSatisfied ? '满足' : '未满足' }}</template></el-table-column>
      <el-table-column label="冷却" width="92"><template #default="scope">{{ scope.row.cooldownRemainingS === 0 ? '已结束' : `${scope.row.cooldownRemainingS} s` }}</template></el-table-column>
      <el-table-column label="原因" min-width="180"><template #default="scope">{{ reasonLabel(scope.row.reason) }}</template></el-table-column>
      <el-table-column label="仿真时刻" width="105"><template #default="scope">{{ scope.row.time }} s</template></el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { CapabilityState, LinkDirection } from '../../contracts/domain-models'
import { useTelemetryStore } from '../../stores/telemetry'

const props = defineProps<{ direction: LinkDirection; requirementId: 'T-XQ-019' | 'T-XQ-020' }>()
type FixedEvidenceState = Exclude<CapabilityState, 'EXECUTING'>
const telemetryStore = useTelemetryStore()
const isForward = computed(() => props.direction === 'FORWARD')
const candidates = computed(() => (telemetryStore.frame?.evidence.routeCandidates ?? [])
  .filter((item) => item.direction === props.direction)
  .toSorted((left, right) => left.rank - right.rank))
const decision = computed(() => telemetryStore.frame?.evidence.routeDecisions.find(
  (item) => item.direction === props.direction,
) ?? null)
const evidenceError = computed(() => {
  if (decision.value === null) return null
  const selected = candidates.value.find((item) => item.linkId === decision.value?.selectedLinkId)
  if (selected === undefined || !selected.eligible) return '最终路由不在有效候选集合中'
  if (isForward.value && selected.jamImpactDb !== decision.value.metric) return '前向决策指标与候选干扰影响不一致'
  if (!isForward.value && selected.ber !== decision.value.metric) return '返向决策指标与候选误码率不一致'
  return null
})
const displayState = computed<FixedEvidenceState>(() => {
  if (telemetryStore.capabilityState === 'LOADING' || telemetryStore.capabilityState === 'VALIDATING') {
    return telemetryStore.capabilityState
  }
  if (telemetryStore.capabilityState === 'ERROR' || evidenceError.value !== null) return 'ERROR'
  if (candidates.value.length === 0 || decision.value === null) return 'EMPTY'
  return 'SUCCESS'
})
const stateLabel = computed(() => ({
  LOADING: '加载中', VALIDATING: '校验中',
  SUCCESS: '已选路', EMPTY: '无候选', ERROR: '决策错误',
})[displayState.value])
const stateType = computed(() => ({
  LOADING: 'info', VALIDATING: 'warning',
  SUCCESS: 'success', EMPTY: 'info', ERROR: 'danger',
} as const)[displayState.value])

/** 将候选淘汰码转换为中文显示。 */
function eliminationLabel(reason: string | null): string {
  return reason === 'LINK_UNAVAILABLE' ? '链路不可用或未连通' : reason ?? '进入排名'
}

/** 以可读科学计数法展示误码率。 */
function formatBer(value: number): string {
  return value.toExponential(2)
}
</script>

<template>
  <el-card class="p4-panel route-ranking" shadow="never" :aria-labelledby="`${direction}-ranking-title`" :data-testid="`${direction.toLowerCase()}-route-ranking`">
    <template #header>
      <div class="p4-panel__header">
        <div><p class="eyebrow">{{ requirementId }} · {{ isForward ? '前向链路优选' : '返向链路优选' }}</p><h3 :id="`${direction}-ranking-title`">{{ isForward ? '干扰最小通道' : '误码最低稳定链路' }}</h3></div>
        <el-tag :type="stateType" effect="dark">{{ stateLabel }}</el-tag>
      </div>
    </template>

    <el-skeleton v-if="displayState === 'LOADING'" :rows="3" animated />
    <el-result v-else-if="displayState === 'ERROR'" icon="error" title="选路证据不可用" :sub-title="evidenceError ?? telemetryStore.resultMessage" />
    <el-empty v-else-if="displayState === 'EMPTY'" description="当前方向没有可用候选链路" />
    <div v-else-if="decision" class="p4-panel__content">
      <el-descriptions :column="4" border size="small">
        <el-descriptions-item label="最终路由">{{ decision.selectedLinkId }}</el-descriptions-item>
        <el-descriptions-item label="原路由">{{ decision.previousLinkId }}</el-descriptions-item>
        <el-descriptions-item label="排名依据">{{ isForward ? '干扰影响最小' : 'BER 最低且满足稳定/滞回' }}</el-descriptions-item>
        <el-descriptions-item label="生效时刻">{{ decision.simulationTime }} s / {{ decision.frameId }}</el-descriptions-item>
      </el-descriptions>
      <el-table :data="candidates" size="small" border>
        <el-table-column prop="rank" label="排名" width="72" />
        <el-table-column prop="linkId" label="链路" min-width="110" />
        <el-table-column label="可用性" width="90"><template #default="scope"><el-tag :type="scope.row.eligible ? 'success' : 'danger'" size="small">{{ scope.row.eligible ? '可用' : '淘汰' }}</el-tag></template></el-table-column>
        <el-table-column label="干扰影响" min-width="105"><template #default="scope">{{ scope.row.jamImpactDb }} dB</template></el-table-column>
        <el-table-column label="BER" min-width="100"><template #default="scope">{{ formatBer(scope.row.ber) }}</template></el-table-column>
        <el-table-column prop="stabilityFrames" label="稳定帧" width="90" />
        <el-table-column label="淘汰原因" min-width="150"><template #default="scope">{{ eliminationLabel(scope.row.eliminationReason) }}</template></el-table-column>
      </el-table>
      <p class="p4-panel__note">{{ isForward ? `先过滤不可用链路，再按干扰影响升序；选中值 ${decision.metric} dB。` : `按 BER 升序并要求至少 ${decision.minimumStableFrames} 个稳定帧，滞回阈值 ${formatBer(decision.hysteresisThreshold ?? 0)}。` }}</p>
    </div>
  </el-card>
</template>

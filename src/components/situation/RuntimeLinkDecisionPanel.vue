<script setup lang="ts">
import { computed } from 'vue'
import type { RuntimeLinkStatus, RuntimeRouteCandidate, RuntimeRouteDecision } from '../../features/data-exchange/runtime-link-decisions'
import { LINK_TYPE_LABELS, formatBer, formatSimulationTime } from '../../features/situation/situation-model'
import { RUNTIME_STATUS_LABELS, runtimeDecisionReason } from '../../features/situation/runtime-quality-view'

const props = defineProps<{
  statuses: ReadonlyMap<string, RuntimeLinkStatus>
  candidates: readonly RuntimeRouteCandidate[]
  decisions: readonly RuntimeRouteDecision[]
  events: readonly RuntimeRouteDecision[]
}>()
const statusesList = computed(() => [...props.statuses.values()])
const history = computed(() => [...props.events].reverse())
const direction = (value: string) => value === 'FORWARD' ? '前向' : '返向'
const metric = (value: number | null, unit = '') => value === null ? '暂无数据' : `${value}${unit}`
const ber = (value: number | null) => value === null ? '暂无数据' : formatBer(value)
</script>

<template>
  <section class="runtime-decision-panel" aria-label="质量选路判定" data-testid="runtime-decision-panel">
    <p class="runtime-decision-panel__note">以下为本机质量判定和选路决策。引擎尚未确认执行，不计为实际切换成功。</p>
    <h3>本帧状态</h3>
    <ul class="runtime-decision-panel__statuses">
      <li v-for="item in statusesList" :key="item.linkId" :data-status="item.status">
        <strong>{{ item.linkId }} · {{ RUNTIME_STATUS_LABELS[item.status] }}</strong>
        <span>{{ runtimeDecisionReason(item.reason) }} · 连续 {{ item.stableFrames }} 帧</span>
      </li>
    </ul>
    <h3>候选排序与约束</h3>
    <div class="runtime-decision-panel__table" tabindex="0" aria-label="可横向滚动的候选链路排序表">
      <table>
        <thead><tr><th>方向</th><th>链路</th><th>体制</th><th>顺位</th><th>GXB（dB）</th><th>BER</th><th>接收干扰（dBm）</th><th>判断</th></tr></thead>
        <tbody>
          <tr v-for="item in candidates" :key="`${item.routeKey}:${item.linkId}`" :data-link-id="item.linkId">
            <td>{{ direction(item.direction) }}</td><td>{{ item.linkId }}</td><td>{{ LINK_TYPE_LABELS[item.type] }}</td><td>{{ item.rank }}</td>
            <td>{{ metric(item.gxbDb) }}</td><td>{{ ber(item.ber) }}</td><td>{{ metric(item.interferencePowerDbm) }}</td>
            <td>{{ item.eligible ? '进入候选' : runtimeDecisionReason(item.eliminationReason ?? 'NO_ELIGIBLE_CANDIDATE') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <h3>当前选路决策</h3>
    <article v-for="item in decisions" :key="item.routeKey" class="runtime-decision-panel__decision">
      <strong>{{ direction(item.direction) }} · {{ item.selectedLinkId ?? '无可用链路' }}</strong>
      <span>帧 {{ item.frameId }} · {{ formatSimulationTime(item.simulationTime) }}</span>
      <span>{{ runtimeDecisionReason(item.reason) }}</span>
      <span>GXB {{ metric(item.gxbDb, ' dB') }} · BER {{ ber(item.ber) }}</span>
    </article>
    <h3>决策变更记录（本机）</h3>
    <ol class="runtime-decision-panel__history">
      <li v-for="(item, index) in history" :key="`${item.routeKey}:${item.frameId}:${index}`">
        <strong>{{ direction(item.direction) }} · {{ item.previousLinkId ?? '未选取' }} → {{ item.selectedLinkId ?? '无可用链路' }}</strong>
        <span>帧 {{ item.frameId }} · {{ formatSimulationTime(item.simulationTime) }} · {{ runtimeDecisionReason(item.reason) }}</span>
      </li>
    </ol>
    <p v-if="!history.length">尚无决策变更</p>
  </section>
</template>

<style scoped>
.runtime-decision-panel { min-height: 0; overflow: auto; padding: .65rem; font-size: 12px; }
h3 { margin: .8rem 0 .4rem; font-size: 13px; }
.runtime-decision-panel__note { margin: 0; color: var(--console-text-muted); line-height: 1.6; }
.runtime-decision-panel__statuses, .runtime-decision-panel__history { padding: 0; margin: 0; list-style: none; }
li, .runtime-decision-panel__decision { display: grid; gap: .3rem; padding: .5rem 0; border-bottom: 1px solid var(--console-border); overflow-wrap: anywhere; }
li[data-status="UP"] strong { color: var(--console-teal); }
li[data-status="DEGRADED"] strong { color: var(--console-amber, #ffb84d); }
li[data-status="DOWN"] strong { color: var(--console-danger, #ff7b7b); }
li span, article span { color: var(--console-text-muted); }
.runtime-decision-panel__table { width: 100%; overflow: auto; }
table { border-collapse: collapse; white-space: nowrap; }
th, td { padding: .4rem; text-align: left; border-bottom: 1px solid var(--console-border); }
</style>

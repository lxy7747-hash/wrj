<script setup lang="ts">
import {
  formatBer,
  type SituationMetricFilters,
  type SituationMetrics,
} from '../../features/situation/situation-model'

const props = defineProps<{
  metrics: SituationMetrics
  filters: SituationMetricFilters
  nodes: Array<{ id: string; label: string }>
  links: Array<{ id: string; label: string }>
}>()

const emit = defineEmits<{ 'update:filters': [value: SituationMetricFilters] }>()

/**
 * 更新一个指标筛选字段，并保留另外两个条件。
 * @param key 待更新的节点、链路或时间窗口字段。
 * @param value 由原生选择器读取的字段值。
 * @sideEffects 向父页面发送新的完整筛选对象。
 */
function updateFilter<K extends keyof SituationMetricFilters>(key: K, value: SituationMetricFilters[K]): void {
  emit('update:filters', { ...props.filters, [key]: value })
}
</script>

<template>
  <section class="metric-panel" aria-label="当前帧指标" :data-frame-id="metrics.frameId">
    <div class="metric-panel__filters" aria-label="链路指标筛选">
      <select :value="filters.nodeId" aria-label="按节点筛选" @change="updateFilter('nodeId', ($event.target as HTMLSelectElement).value)">
        <option value="">全部节点</option>
        <option v-for="node in nodes" :key="node.id" :value="node.id">{{ node.label }}</option>
      </select>
      <select :value="filters.linkId" aria-label="按链路筛选" @change="updateFilter('linkId', ($event.target as HTMLSelectElement).value)">
        <option value="">全部链路</option>
        <option v-for="link in links" :key="link.id" :value="link.id">{{ link.label }}</option>
      </select>
      <select
        :value="filters.windowMs === null ? 'all' : String(filters.windowMs)"
        aria-label="按时间窗口筛选"
        @change="updateFilter('windowMs', ($event.target as HTMLSelectElement).value === 'all' ? null : Number(($event.target as HTMLSelectElement).value))"
      >
        <option value="all">全部时间</option>
        <option value="0">当前时刻</option>
        <option value="1000">最近 1 秒</option>
        <option value="5000">最近 5 秒</option>
      </select>
    </div>
    <div class="metric-panel__item">
      <span>在线业务信息节点</span>
      <strong>{{ metrics.businessNodeCount }}</strong>
    </div>
    <div class="metric-panel__item">
      <span>正常链路</span>
      <strong class="metric-panel__good">{{ metrics.upLinkCount }}</strong>
    </div>
    <div class="metric-panel__item">
      <span>劣化链路</span>
      <strong class="metric-panel__warn">{{ metrics.degradedLinkCount }}</strong>
    </div>
    <div class="metric-panel__item">
      <span>中断链路</span>
      <strong class="metric-panel__danger">{{ metrics.downLinkCount }}</strong>
    </div>
    <div class="metric-panel__item">
      <span>平均 SNR</span>
      <strong>{{ metrics.avgSnrDb === null ? '—' : `${metrics.avgSnrDb.toFixed(2)} dB` }}</strong>
    </div>
    <div class="metric-panel__item">
      <span>平均 BER</span>
      <strong>{{ metrics.avgBer === null ? '—' : formatBer(metrics.avgBer) }}</strong>
    </div>
    <div class="metric-panel__item">
      <span>平均接收功率</span>
      <strong>{{ metrics.avgReceivedPowerDbm === null ? '未提供' : `${metrics.avgReceivedPowerDbm.toFixed(2)} dBm` }}</strong>
    </div>
    <div class="metric-panel__item">
      <span>平均时延</span>
      <strong>{{ metrics.latencyMs === null ? '未提供' : `${metrics.latencyMs.toFixed(1)} ms` }}</strong>
    </div>
    <div class="metric-panel__item">
      <span>数据源时刻</span>
      <strong>{{ metrics.latestUpdatedAt === null ? '—' : `${metrics.latestUpdatedAt} s` }}</strong>
    </div>
  </section>
</template>

<style scoped>
.metric-panel {
  display: flex;
  width: max-content;
  max-width: 100%;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 0.5rem;
  pointer-events: auto;
}

.metric-panel__filters {
  display: flex;
  flex: 1 0 100%;
  gap: 0.4rem;
}

.metric-panel__filters select {
  min-width: 8rem;
  max-width: 12rem;
  padding: 0.32rem 0.5rem;
  border: 1px solid var(--console-border);
  border-radius: 5px;
  color: var(--console-text);
  background: rgba(15, 31, 48, 0.94);
  font-size: 12px;
}

.metric-panel__item {
  min-width: 5.375rem;
  padding: 0.375rem 0.875rem;
  border: 1px solid var(--console-border);
  border-radius: 8px;
  background: rgba(15, 31, 48, 0.92);
}

.metric-panel__item span {
  display: block;
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
  white-space: nowrap;
}

.metric-panel__item strong {
  display: block;
  color: var(--console-cyan);
  font-family: Consolas, monospace;
  font-size: 0.95rem;
  line-height: 1.2;
}

.metric-panel__good {
  color: var(--console-teal) !important;
}

.metric-panel__warn {
  color: var(--console-amber) !important;
}

.metric-panel__danger {
  color: var(--console-danger) !important;
}

</style>

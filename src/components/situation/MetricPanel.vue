<script setup lang="ts">
import type { SituationMetrics } from '../../features/situation/situation-model'

defineProps<{
  metrics: SituationMetrics
}>()
</script>

<template>
  <section class="metric-panel" aria-label="当前帧指标" :data-frame-id="metrics.frameId">
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

<script setup lang="ts">
import type { SituationMetrics } from '../../features/situation/situation-model'

defineProps<{ metrics: SituationMetrics }>()
</script>

<template>
  <section class="metric-panel" aria-label="当前帧指标" :data-frame-id="metrics.frameId">
    <div class="metric-panel__item">
      <span>业务信息节点</span>
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
      <span>活动干扰源</span>
      <strong class="metric-panel__danger">{{ metrics.activeJammerCount }}</strong>
    </div>
    <div class="metric-panel__item">
      <span>切换事件</span>
      <strong>{{ metrics.switchEventCount }}</strong>
    </div>
  </section>
</template>

<style scoped>
.metric-panel {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 0.35rem;
  padding: 0.45rem;
  border-bottom: 1px solid var(--console-border);
  background: rgba(5, 11, 20, 0.78);
}

.metric-panel__item {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--console-border);
  border-radius: 5px;
  background: rgba(11, 29, 45, 0.92);
}

.metric-panel__item span {
  overflow: hidden;
  color: var(--console-text-muted);
  font-size: 0.66rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric-panel__item strong {
  color: var(--console-cyan);
  font-family: Consolas, monospace;
  font-size: 0.92rem;
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

@media (max-width: 1500px) {
  .metric-panel__item {
    display: grid;
    justify-items: center;
    gap: 0.1rem;
    padding: 0.25rem;
  }
}
</style>

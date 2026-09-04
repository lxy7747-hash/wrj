<script setup lang="ts">
import ClosedLoopStepper from '../../components/interactions/ClosedLoopStepper.vue'
import CompositeLossExample from '../../components/interactions/CompositeLossExample.vue'
import EsmSensorPanel from '../../components/interactions/EsmSensorPanel.vue'
import JammerSyncPanel from '../../components/interactions/JammerSyncPanel.vue'
import RfJammerPanel from '../../components/interactions/RfJammerPanel.vue'
import RouteRankingPanel from '../../components/interactions/RouteRankingPanel.vue'
import SnrBerExample from '../../components/interactions/SnrBerExample.vue'
import SwitchDecisionPanel from '../../components/interactions/SwitchDecisionPanel.vue'
</script>

<template>
  <section class="page interactions-page" aria-labelledby="interactions-title">
    <header class="interactions-page__header">
      <div>
        <p class="eyebrow">能力治理 / 感知、干扰与选路</p>
        <h2 id="interactions-title">感知、干扰与选路</h2>
        <p class="interactions-page__summary">集中展示侦测、干扰控制、参数同步、逐帧闭环、正反向选路及切换决策的完整可追溯证据。</p>
      </div>
      <span class="console-chip interactions-page__chip">P4 已完成</span>
    </header>

    <div class="interactions-page__evidence">
      <EsmSensorPanel />
      <RfJammerPanel />
      <ClosedLoopStepper />
      <JammerSyncPanel />
      <CompositeLossExample />
      <SnrBerExample />
      <RouteRankingPanel direction="FORWARD" requirement-id="T-XQ-019" />
      <RouteRankingPanel direction="REVERSE" requirement-id="T-XQ-020" />
      <SwitchDecisionPanel />
    </div>
  </section>
</template>

<style scoped>
.interactions-page {
  min-width: 0;
  overflow: auto;
}

.interactions-page__header,
:deep(.p4-panel__header),
:deep(.p4-panel__actions),
:deep(.switch-summary) {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.interactions-page__header > div {
  min-width: 0;
}

.interactions-page h2,
:deep(.p4-panel h3) {
  margin: 0;
  color: var(--console-text);
}

.interactions-page__summary {
  max-width: 52rem;
  margin: var(--space-3) 0 0;
  color: var(--console-text-muted);
  font-size: 0.92rem;
  line-height: 1.7;
}

.interactions-page__chip {
  flex: 0 0 auto;
  margin-top: var(--space-1);
  color: var(--console-teal);
}

.interactions-page__evidence,
:deep(.p4-panel__content) {
  display: grid;
  gap: var(--space-4);
}

.interactions-page__evidence {
  margin-top: var(--space-5);
}

:deep(.p4-panel) {
  border-color: var(--console-border);
  background: var(--console-bg-elevated);
}

:deep(.p4-panel__header) {
  align-items: center;
}

:deep(.p4-panel__header h3) {
  margin-top: var(--space-1);
  font-size: 1rem;
}

:deep(.p4-panel__actions) {
  align-items: center;
  justify-content: flex-start;
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

:deep(.sync-versions) {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
}

:deep(.sync-versions article) {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background: var(--console-surface);
}

:deep(.sync-versions span),
:deep(.p4-panel__note) {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

:deep(.sync-versions strong) {
  color: var(--console-teal);
  font-size: 1.08rem;
}

:deep(.sync-form) {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}

:deep(.sync-form .el-form-item) {
  margin-bottom: 0;
}

:deep(.sync-form .el-select),
:deep(.sync-form .el-input-number) {
  width: 100%;
}

:deep(.switch-summary) {
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
}

:deep(.p4-panel__note) {
  margin: 0;
  line-height: 1.6;
}

@media (max-width: 760px) {
  .interactions-page__header,
  :deep(.p4-panel__header) {
    flex-direction: column;
  }

  :deep(.sync-versions),
  :deep(.sync-form) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  :deep(.p4-panel__content) {
    overflow-x: auto;
  }

  :deep(.p4-panel__content > .el-steps),
  :deep(.p4-panel__content > .el-table),
  :deep(.p4-panel > .el-card__body > .el-table) {
    min-width: 48rem;
  }
}
</style>

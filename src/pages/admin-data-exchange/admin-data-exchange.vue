<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import CsvContractCard from '../../components/data-exchange/CsvContractCard.vue'
import InterfaceContractTable from '../../components/data-exchange/InterfaceContractTable.vue'
import ProcessContractCard from '../../components/data-exchange/ProcessContractCard.vue'
import ScenarioJsonPanel from '../../components/data-exchange/ScenarioJsonPanel.vue'
import WebSocketContractCard from '../../components/data-exchange/WebSocketContractCard.vue'
import { useDataExchangeStore } from '../../stores/data-exchange'
import { useTelemetryStore } from '../../stores/telemetry'

const store = useDataExchangeStore()
const telemetry = useTelemetryStore()
const route = useRoute()

/** 合同目录渲染完成后定位当前接口锚点，不接受外部页面地址。 */
async function locateInterface(): Promise<void> {
  await nextTick()
  document.getElementById(route.hash.slice(1))?.scrollIntoView({ block: 'start' })
}
watch(() => route.hash, locateInterface)

/**
 * 加载 P5 页面所需的四组规范合同。
 * @returns 合同加载结束后无返回值。
 * @sideEffects 通过本机 Mock 更新数据交换 Store，不访问真实文件或操作系统进程。
 */
async function loadContracts(): Promise<void> {
  await store.loadContracts()
  await locateInterface()
}

onMounted(loadContracts)
onUnmounted(() => {
  if (telemetry.connectionState !== 'DISCONNECTED') telemetry.disconnectAndReset()
})
</script>

<template>
  <section class="page data-exchange-page" aria-labelledby="data-exchange-title">
    <header class="data-exchange-page__header">
      <div>
        <p class="eyebrow">P5 · 数据交换与接口</p>
        <h2 id="data-exchange-title">数据交换与接口</h2>
        <p>以确定性 Mock 验证 CSV、场景 JSON、本机消息、进程管理及七类接口合同。</p>
      </div>
      <div class="data-exchange-page__status">
        <el-tag type="warning" effect="plain">零真实文件 / 零真实进程</el-tag>
        <el-button :loading="store.loadState === 'LOADING'" @click="loadContracts">重新加载合同</el-button>
      </div>
    </header>

    <el-alert
      v-if="store.loadState === 'ERROR'"
      type="error"
      :closable="false"
      show-icon
      :title="store.resultMessage"
      data-testid="contract-load-error"
    />

    <div class="data-exchange-page__capabilities">
      <CsvContractCard />
      <ScenarioJsonPanel />
      <WebSocketContractCard />
      <ProcessContractCard />
    </div>

    <InterfaceContractTable />
  </section>
</template>

<style scoped>
.data-exchange-page {
  min-width: 0;
  overflow: auto;
}

.data-exchange-page__header,
.data-exchange-page__status,
:deep(.exchange-card__header),
:deep(.exchange-card__actions) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.data-exchange-page__header {
  align-items: flex-start;
  margin-bottom: var(--space-4);
}

.data-exchange-page__header h2,
:deep(.exchange-card h3),
:deep(.interface-card h3) {
  margin: 0;
  color: var(--console-text);
}

.data-exchange-page__header > div:first-child > p:last-child,
:deep(.exchange-card__description),
:deep(.exchange-card__note),
:deep(.interface-item p) {
  color: var(--console-text-muted);
  line-height: 1.65;
}

.data-exchange-page__header > div:first-child > p:last-child {
  margin: var(--space-2) 0 0;
}

.data-exchange-page__capabilities {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
  margin: var(--space-4) 0;
}

:deep(.exchange-card),
:deep(.interface-card) {
  min-width: 0;
  border-color: var(--console-border);
  background: var(--console-bg-elevated);
}

:deep(.exchange-card__header h3),
:deep(.interface-card h3) {
  margin-top: var(--space-1);
  font-size: 1rem;
}

:deep(.exchange-card__description) {
  min-height: 3.3rem;
  margin: 0 0 var(--space-4);
}

:deep(.exchange-card__actions) {
  justify-content: flex-start;
  margin-top: var(--space-3);
}

:deep(.exchange-card__result) {
  margin: var(--space-3) 0;
}

:deep(.exchange-card__note) {
  margin: var(--space-3) 0 0;
  font-size: var(--console-font-size-min);
}

:deep(.interface-groups) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

:deep(.interface-groups section) {
  display: grid;
  gap: var(--space-2);
}

:deep(.interface-groups h4) {
  margin: 0;
  color: var(--console-cyan);
}

:deep(.interface-item) {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background: var(--console-surface);
}

:deep(.interface-item code) {
  overflow-wrap: anywhere;
  color: var(--console-amber);
  font-size: var(--console-font-size-min);
}

:deep(.interface-item p) {
  margin: 0;
}

@media (max-width: 980px) {
  .data-exchange-page__capabilities,
  :deep(.interface-groups) {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 620px) {
  .data-exchange-page__header,
  .data-exchange-page__status,
  :deep(.exchange-card__header) {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>

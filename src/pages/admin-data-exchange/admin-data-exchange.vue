<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import CsvContractCard from '../../components/data-exchange/CsvContractCard.vue'
import ExchangeMonitor from '../../components/data-exchange/ExchangeMonitor.vue'
import InterfaceContractTable from '../../components/data-exchange/InterfaceContractTable.vue'
import ProcessContractCard from '../../components/data-exchange/ProcessContractCard.vue'
import ScenarioJsonPanel from '../../components/data-exchange/ScenarioJsonPanel.vue'
import WebSocketContractCard from '../../components/data-exchange/WebSocketContractCard.vue'
import { useDataExchangeStore } from '../../stores/data-exchange'
import { useTelemetryStore } from '../../stores/telemetry'

const store = useDataExchangeStore()
const telemetry = useTelemetryStore()
const route = useRoute()
const toolsVisible = ref(false)

/** 打开既有接口工具；target 为卡片或接口的本页锚点，留空时展示工具顶部。 */
async function openTools(target = ''): Promise<void> {
  toolsVisible.value = true
  await nextTick()
  if (target) document.getElementById(target)?.scrollIntoView({ block: 'start' })
}

/** 合同目录渲染完成后定位当前接口锚点，不接受外部页面地址。 */
async function locateInterface(): Promise<void> {
  if (route.hash.startsWith('#de-')) await openTools(route.hash.slice(1))
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
  // 尚在加载快照时也使请求失效，避免离页后建立连接。
  telemetry.disconnectAndReset()
})
</script>

<template>
  <section class="page data-exchange-page" aria-labelledby="data-exchange-title">
    <header class="data-exchange-page__header">
      <div>
        <h2 id="data-exchange-title">数据交换与接口</h2>
      </div>
      <div class="data-exchange-page__status">
        <el-tag type="warning" effect="plain">{{ store.monitor ? '本机监控 / Mock 遥测' : store.monitorState === 'SUCCESS' ? 'Mock 监控' : '监控待确认' }}</el-tag>
        <el-button data-testid="open-exchange-tools" @click="openTools()">接口工具</el-button>
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

    <ExchangeMonitor @tools="openTools" @refresh="loadContracts" />

    <el-drawer v-model="toolsVisible" title="接口工具" size="min(1120px, 94vw)" :close-on-click-modal="false">
      <div class="data-exchange-page__status">
        <el-tag type="warning" effect="plain">零真实文件 / 零真实进程</el-tag>
        <el-button :loading="store.loadState === 'LOADING'" @click="loadContracts">重新加载合同</el-button>
      </div>
      <div class="data-exchange-page__capabilities">
        <CsvContractCard />
        <ScenarioJsonPanel />
        <WebSocketContractCard />
        <ProcessContractCard />
      </div>
      <InterfaceContractTable />
    </el-drawer>
  </section>
</template>

<style scoped>
.data-exchange-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* height: 100%; */
  min-height: 0;
  min-width: 0;
  padding: 16px;
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
  flex: 0 0 auto;
}

.data-exchange-page__header h2 { font-size: 18px; }

.data-exchange-page__header h2,
:deep(.exchange-card h3),
:deep(.interface-card h3) {
  margin: 0;
  color: var(--console-text);
}

:deep(.exchange-card__description),
:deep(.exchange-card__note),
:deep(.interface-item p) {
  color: var(--console-text-muted);
  line-height: 1.65;
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

@media (max-width: 1100px) {
  .data-exchange-page { height: auto; min-height: 100%; }
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

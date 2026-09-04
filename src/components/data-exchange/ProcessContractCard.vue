<script setup lang="ts">
import { computed } from 'vue'
import { useDataExchangeStore, type ProcessContractResult } from '../../stores/data-exchange'
import { useSimulationStore } from '../../stores/simulation'
import DataExchangeStateTag from './DataExchangeStateTag.vue'

const store = useDataExchangeStore()
const simulation = useSimulationStore()
const PROCESS_STATUS_LABELS: Record<ProcessContractResult['status'], string> = {
  NOT_STARTED: '未启动', RUNNING: '运行中', EXITED: '已退出', TERMINATED: '已终止', ERROR: '异常',
}
const statusLabel = computed(() => PROCESS_STATUS_LABELS[store.processResult?.status ?? 'NOT_STARTED'])

/** 读取当前运行并投影进程管理可见合同，不调用操作系统。 */
async function inspect(): Promise<void> {
  if (simulation.run === null && !await simulation.resetProjection()) {
    store.processState = 'ERROR'
    store.processMessage = simulation.resultMessage
    return
  }
  await store.inspectProcess(simulation.run)
}
</script>

<template>
  <el-card id="de-cap-jcgj" class="exchange-card" shadow="never" data-testid="process-contract-card">
    <template #header>
      <div class="exchange-card__header">
        <div><p class="eyebrow">T-XQ-025 · VISIBLE_CONTRACT</p><h3>AFSIM 进程管理合同</h3></div>
        <DataExchangeStateTag :state="store.processState" data-testid="process-state" />
      </div>
    </template>
    <p class="exchange-card__description">展示启动前路径校验、单实例锁、PID、stdout、超时终止和资源清理；不调用真实操作系统进程。</p>
    <el-button type="primary" @click="inspect">检查进程管理合同</el-button>
    <el-alert class="exchange-card__result" :type="store.processState === 'ERROR' ? 'error' : 'info'" :closable="false" :title="store.processMessage" />
    <el-descriptions v-if="store.processResult" :column="2" border size="small" data-testid="process-result">
      <el-descriptions-item label="进程状态">{{ statusLabel }}</el-descriptions-item>
      <el-descriptions-item label="PID">{{ store.processResult.processId ?? '无' }}</el-descriptions-item>
      <el-descriptions-item label="stdout">未捕获（设计状态）</el-descriptions-item>
      <el-descriptions-item label="退出码">{{ store.processResult.exitCode ?? '无' }}</el-descriptions-item>
      <el-descriptions-item label="超时">{{ store.processResult.timeoutMs }} ms</el-descriptions-item>
      <el-descriptions-item label="单实例锁">{{ store.processResult.singleInstance ? '通过' : '未通过' }}</el-descriptions-item>
      <el-descriptions-item label="可执行文件">未绑定（设计状态）</el-descriptions-item>
      <el-descriptions-item label="工作目录">未绑定（设计状态）</el-descriptions-item>
      <el-descriptions-item label="脚本路径">未绑定（设计状态）</el-descriptions-item>
      <el-descriptions-item label="重复启动">由单实例锁拒绝</el-descriptions-item>
      <el-descriptions-item label="资源释放">{{ store.processResult.resourcesReleased ? '已释放' : '占用中' }}</el-descriptions-item>
      <el-descriptions-item label="真实进程">未启动</el-descriptions-item>
    </el-descriptions>
  </el-card>
</template>

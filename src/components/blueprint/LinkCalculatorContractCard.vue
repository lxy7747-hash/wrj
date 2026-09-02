<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import type { CapabilityState, TelemetryLinkRecord } from '../../contracts/domain-models'
import { formatBer, LINK_TYPE_LABELS, selectSituationLinks } from '../../features/situation/situation-model'
import { useTelemetryStore } from '../../stores/telemetry'

interface ContractField {
  key: keyof TelemetryLinkRecord
  label: string
  unit?: string
}

const TARGET_LINK_ID = 'L-MW-01'

const INPUT_FIELDS: readonly ContractField[] = [
  { key: 'time', label: '仿真时刻', unit: 's' },
  { key: 'sourcePlatform', label: '发送端' },
  { key: 'destPlatform', label: '接收端' },
  { key: 'linkType', label: '链路体制' },
  { key: 'frequency', label: '频率', unit: 'MHz' },
  { key: 'bandwidth', label: '带宽', unit: 'MHz' },
  { key: 'distance', label: '传输距离', unit: 'm' },
  { key: 'txPower', label: '发射功率', unit: 'W' },
  { key: 'txAntennaGain', label: '发射天线增益', unit: 'dBi' },
  { key: 'rxAntennaGain', label: '接收天线增益', unit: 'dBi' },
  { key: 'jammingPower', label: '干扰功率', unit: 'dBm' },
] as const

const OUTPUT_FIELDS: readonly ContractField[] = [
  { key: 'pathLoss', label: '路径损耗', unit: 'dB' },
  { key: 'receivedPower', label: '接收功率', unit: 'dBm' },
  { key: 'snr', label: '信噪比', unit: 'dB' },
  { key: 'modulation', label: '调制方式' },
  { key: 'ber', label: '误码率' },
  { key: 'linkStatus', label: '规范状态' },
  { key: 'berThreshold', label: '误码率阈值' },
  { key: 'dataRate', label: '数据速率', unit: 'Mbps' },
] as const

const EXCEPTION_RULES = [
  { condition: '链路记录缺失', result: '进入空态，不保留上一帧结果' },
  { condition: '端点不存在', result: '拒绝展示并报告端点错误' },
  { condition: '帧号或仿真时刻不一致', result: '拒绝跨帧拼接并进入错误态' },
  { condition: '字段类型或枚举非法', result: '遥测边界校验失败并允许重新加载' },
] as const

const telemetryStore = useTelemetryStore()

const link = computed<TelemetryLinkRecord | null>(() => {
  const frame = telemetryStore.frame
  if (frame === null) return null
  const current = selectSituationLinks(frame).find((item) => item.linkId === TARGET_LINK_ID)
  if (current?.detailed === null || current === undefined) return null
  return {
    ...current.detailed,
    snr: current.snrDb,
    ber: current.ber,
    linkStatus: current.canonicalStatus,
  }
})

const sourceName = computed(() => (
  telemetryStore.frame?.platforms.find((platform) => platform.platformId === link.value?.sourcePlatform)?.name ?? '端点未找到'
))

const destinationName = computed(() => (
  telemetryStore.frame?.platforms.find((platform) => platform.platformId === link.value?.destPlatform)?.name ?? '端点未找到'
))

const contractIssues = computed(() => {
  const frame = telemetryStore.frame
  const currentLink = link.value
  if (frame === null) return []

  const issues: string[] = []
  if (currentLink === null) return [`当前帧缺少链路 ${TARGET_LINK_ID}`]
  if (!frame.platforms.some((platform) => platform.platformId === currentLink.sourcePlatform)) issues.push('发送端不存在')
  if (!frame.platforms.some((platform) => platform.platformId === currentLink.destPlatform)) issues.push('接收端不存在')
  if (currentLink.time !== frame.simulationTime) issues.push('链路时刻与当前帧不一致')
  if (frame.evidence.synchronization.effectiveFrameId !== frame.frameId
    || frame.evidence.synchronization.effectiveSimulationTime !== frame.simulationTime) {
    issues.push('同步证据与当前帧不一致')
  }
  const uiLink = frame.uiLinks.find((item) => item.linkId === currentLink.linkId)
  if (uiLink !== undefined && uiLink.frameId !== frame.frameId) issues.push('链路状态证据与当前帧不一致')
  return issues
})

const displayState = computed<CapabilityState>(() => {
  if (telemetryStore.capabilityState !== 'SUCCESS') return telemetryStore.capabilityState
  if (link.value === null) return 'EMPTY'
  return contractIssues.value.length === 0 ? 'SUCCESS' : 'ERROR'
})

const stateLabel = computed(() => ({
  LOADING: '加载中',
  VALIDATING: '校验中',
  EXECUTING: '计算中',
  SUCCESS: '同帧通过',
  EMPTY: '暂无数据',
  ERROR: '证据错误',
})[displayState.value])

const stateType = computed(() => ({
  LOADING: 'info',
  VALIDATING: 'warning',
  EXECUTING: 'primary',
  SUCCESS: 'success',
  EMPTY: 'info',
  ERROR: 'danger',
} as const)[displayState.value])

const errorMessage = computed(() => (
  contractIssues.value.length > 0 ? contractIssues.value.join('；') : telemetryStore.resultMessage
))

/**
 * 将链路字段转换为带中文枚举和单位的展示值。
 * @param field 标准链路合同字段定义。
 * @returns 当前链路对应的可读字段值；没有链路时返回占位符。
 */
function formatField(field: ContractField): string {
  const value = link.value?.[field.key]
  if (value === undefined) return '—'
  if (field.key === 'linkType') return LINK_TYPE_LABELS[link.value?.linkType ?? 'SAT']
  if (field.key === 'linkStatus') return value === 'UP' ? '正常' : '中断'
  if (field.key === 'ber' || field.key === 'berThreshold') return formatBer(Number(value))
  return field.unit === undefined ? String(value) : `${String(value)} ${field.unit}`
}

/**
 * 重新读取固定帧合同证据。
 * @returns 遥测 Store 的加载结果。
 * @sideEffects 请求本机遥测接口并替换当前帧或进入安全错误态。
 */
function reload(): Promise<boolean> {
  return telemetryStore.loadFrame('RUN-001', 'F-00042')
}

onMounted(async () => {
  const loaded = telemetryStore.frame !== null || await reload()
  if (loaded) telemetryStore.connect()
})

onBeforeUnmount(() => {
  telemetryStore.disconnectAndReset()
})
</script>

<template>
  <el-card
    class="link-contract"
    shadow="never"
    aria-labelledby="link-calculator-title"
    data-testid="link-calculator-contract"
  >
    <template #header>
      <div class="link-contract__header">
        <div>
          <p class="eyebrow">T-XQ-010 · 同帧链路计算</p>
          <h3 id="link-calculator-title">链路计算合同与结果证据</h3>
        </div>
        <el-tag :type="stateType" effect="dark" data-testid="link-contract-state">{{ stateLabel }}</el-tag>
      </div>
    </template>

    <el-skeleton v-if="displayState === 'LOADING'" :rows="8" animated />

    <el-alert
      v-else-if="displayState === 'VALIDATING'"
      type="warning"
      :closable="false"
      show-icon
      title="正在校验帧号、仿真时刻和标准字段"
    />

    <el-alert
      v-else-if="displayState === 'EXECUTING'"
      type="info"
      :closable="false"
      show-icon
      title="仿真计算模块正在形成链路指标"
    />

    <el-result v-else-if="displayState === 'ERROR'" icon="error" title="链路计算证据不可用" :sub-title="errorMessage">
      <template #extra><el-button type="primary" @click="reload">重新加载</el-button></template>
    </el-result>

    <el-empty v-else-if="displayState === 'EMPTY'" description="当前帧没有 L-MW-01 链路计算结果">
      <el-button type="primary" @click="reload">加载固定帧</el-button>
    </el-empty>

    <div v-else-if="link && telemetryStore.frame" class="link-contract__content" :data-frame-id="telemetryStore.frame.frameId">
      <el-alert
        type="success"
        :closable="false"
        show-icon
        title="同帧校验通过"
        :description="`${link.linkId} 的端点、输入和输出均来自 ${telemetryStore.frame.frameId}，仿真时刻 ${telemetryStore.frame.simulationTime} s。`"
      />

      <section class="link-contract__route" aria-label="链路端点">
        <div><span>发送端</span><strong>{{ sourceName }}</strong><small>{{ link.sourcePlatform }}</small></div>
        <i aria-hidden="true">→</i>
        <div><span>接收端</span><strong>{{ destinationName }}</strong><small>{{ link.destPlatform }}</small></div>
      </section>

      <section aria-labelledby="link-contract-inputs">
        <h4 id="link-contract-inputs">标准输入</h4>
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item v-for="field in INPUT_FIELDS" :key="field.key" :label="field.label">
            {{ formatField(field) }}
          </el-descriptions-item>
        </el-descriptions>
      </section>

      <section aria-labelledby="link-contract-outputs">
        <h4 id="link-contract-outputs">标准输出</h4>
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item v-for="field in OUTPUT_FIELDS" :key="field.key" :label="field.label">
            {{ formatField(field) }}
          </el-descriptions-item>
        </el-descriptions>
      </section>

      <section aria-labelledby="link-contract-exceptions">
        <h4 id="link-contract-exceptions">异常处理合同</h4>
        <el-table :data="EXCEPTION_RULES" size="small">
          <el-table-column prop="condition" label="异常条件" min-width="180" />
          <el-table-column prop="result" label="界面处理" min-width="260" />
        </el-table>
      </section>

      <footer class="link-contract__trace">
        <span>来源：SRS 3.3.3.2；详细设计 4.2.3.2、5.3.2.2</span>
        <span>数据：固定帧接口 + link.metric</span>
        <span>边界：算法由仿真计算模块执行，浏览器仅校验和展示结果证据</span>
      </footer>
    </div>
  </el-card>
</template>

<style scoped>
.link-contract {
  border-color: var(--console-border);
  background: var(--console-bg-elevated);
}

.link-contract__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.link-contract__header h3,
.link-contract__content h4 {
  margin: 0;
  color: var(--console-text);
}

.link-contract__header h3 {
  margin-top: var(--space-1);
  font-size: 1rem;
}

.link-contract__content {
  display: grid;
  gap: var(--space-5);
}

.link-contract__content h4 {
  margin-bottom: var(--space-3);
  font-size: 0.86rem;
}

.link-contract__route {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: var(--space-4);
}

.link-contract__route div {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background: var(--console-surface);
  text-align: center;
}

.link-contract__route span,
.link-contract__route small,
.link-contract__trace {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.link-contract__route strong {
  color: var(--console-text);
}

.link-contract__route i {
  color: var(--console-cyan);
  font-size: 1.4rem;
  font-style: normal;
}

.link-contract__trace {
  display: grid;
  gap: var(--space-1);
  padding-top: var(--space-3);
  border-top: 1px solid var(--console-border);
  line-height: 1.6;
}

@media (max-width: 760px) {
  .link-contract__route {
    grid-template-columns: minmax(0, 1fr);
  }

  .link-contract__route i {
    transform: rotate(90deg);
    text-align: center;
  }

  :deep(.el-descriptions__body .el-descriptions__table) {
    min-width: 42rem;
  }

  .link-contract__content section {
    overflow-x: auto;
  }
}
</style>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useTelemetryStore } from '../../stores/telemetry'

type DisplayState = 'LOADING' | 'VALIDATING' | 'SUCCESS' | 'EMPTY' | 'ERROR'

const TARGET_LINK_ID = 'L-MW-01'
const SUPPORTED_MODELS: Readonly<Record<string, string>> = {
  'BPSK:UNCODED': 'SNBER-1.2',
  'QPSK:UNCODED': 'SNBER-1.2',
}

const telemetryStore = useTelemetryStore()

const link = computed(() => (
  telemetryStore.frame?.links.find((item) => item.linkId === TARGET_LINK_ID) ?? null
))

const loss = computed(() => (
  telemetryStore.frame?.evidence.losses.find((item) => item.linkId === TARGET_LINK_ID) ?? null
))

const qualityIssues = computed(() => {
  const frame = telemetryStore.frame
  const currentLink = link.value
  if (frame === null || currentLink === null) return []

  const issues: string[] = []
  const currentLoss = loss.value
  const mappingKey = `${String(currentLink.modulation)}:${String(currentLink.coding)}`
  const expectedModel = SUPPORTED_MODELS[mappingKey]

  if (expectedModel === undefined) issues.push(`UNSUPPORTED_MODULATION：不支持 ${currentLink.modulation}/${currentLink.coding}`)
  else if (currentLink.qualityModelVersion !== expectedModel) issues.push('质量模型版本与调制编码映射不一致')
  if (currentLoss === null) issues.push(`当前帧缺少 ${TARGET_LINK_ID} 噪声证据`)
  else if (Math.abs(currentLink.receivedPower - currentLoss.effectiveNoiseAndInterferenceDbm - currentLink.snr) > 1e-9) {
    issues.push('接收功率、等效噪声与 SNR 不一致')
  }
  if (currentLink.time !== frame.simulationTime
    || frame.evidence.synchronization.effectiveFrameId !== frame.frameId
    || frame.evidence.synchronization.effectiveSimulationTime !== frame.simulationTime) {
    issues.push('质量证据与当前帧不一致')
  }
  return issues
})

const displayState = computed<DisplayState>(() => {
  const state = telemetryStore.capabilityState
  if (state === 'LOADING' || state === 'VALIDATING' || state === 'ERROR') return state
  if (state !== 'SUCCESS' || link.value === null) return 'EMPTY'
  return qualityIssues.value.length === 0 ? 'SUCCESS' : 'ERROR'
})

const stateLabel = computed(() => ({
  LOADING: '加载中', VALIDATING: '校验中',
  SUCCESS: '算例通过', EMPTY: '暂无数据', ERROR: '证据错误',
})[displayState.value])

const stateType = computed(() => ({
  LOADING: 'info', VALIDATING: 'warning',
  SUCCESS: 'success', EMPTY: 'info', ERROR: 'danger',
} as const)[displayState.value])

const errorMessage = computed(() => {
  if (qualityIssues.value.length > 0) return qualityIssues.value.join('；')
  if (telemetryStore.resultFieldPath === null) return telemetryStore.resultMessage
  return `${telemetryStore.resultCode}：${telemetryStore.resultMessage}（${telemetryStore.resultFieldPath}）`
})

/**
 * 将误码率格式化为便于核对的科学计数法。
 * @param value 误码率数值。
 * @returns 保留一位小数的科学计数法文本。
 */
function formatBer(value: number): string {
  return value.toExponential(1)
}

/**
 * 重新读取固定帧 SNR/BER 证据。
 * @returns 遥测 Store 的加载结果。
 * @sideEffects 请求本机固定帧接口并替换当前遥测快照。
 */
function reload(): Promise<boolean> {
  return telemetryStore.loadFrame()
}

onMounted(() => {
  if (telemetryStore.frame === null && telemetryStore.capabilityState === 'EMPTY') void reload()
})
</script>

<template>
  <el-card
    class="quality-example"
    shadow="never"
    aria-labelledby="snr-ber-title"
    data-testid="snr-ber-example"
  >
    <template #header>
      <div class="quality-example__header">
        <div>
          <p class="eyebrow">T-XQ-012 · SNR/BER 计算</p>
          <h3 id="snr-ber-title">SNR/BER 固定算例</h3>
        </div>
        <el-tag :type="stateType" effect="dark" data-testid="snr-ber-state">{{ stateLabel }}</el-tag>
      </div>
    </template>

    <el-skeleton v-if="displayState === 'LOADING'" :rows="4" animated />
    <el-alert v-else-if="displayState === 'VALIDATING'" type="warning" :closable="false" show-icon title="正在校验计算输入、模型版本和同帧关系" />
    <el-result v-else-if="displayState === 'ERROR'" icon="error" title="SNR/BER 证据不可用" :sub-title="errorMessage">
      <template #extra><el-button type="primary" @click="reload">重新加载</el-button></template>
    </el-result>
    <el-empty v-else-if="displayState === 'EMPTY'" description="当前帧没有 L-MW-01 质量计算结果">
      <el-button type="primary" @click="reload">加载固定帧</el-button>
    </el-empty>

    <div v-else-if="link && loss && telemetryStore.frame" class="quality-example__content" :data-frame-id="telemetryStore.frame.frameId">
      <div class="quality-example__metrics" aria-label="SNR 与 BER 固定算例指标">
        <article><span>接收功率 Pr</span><strong>{{ link.receivedPower }} dBm</strong></article>
        <article><span>噪声功率 N</span><strong>{{ loss.noisePowerDbm }} dBm</strong></article>
        <article><span>信噪比 SNR</span><strong>{{ link.snr }} dB</strong></article>
        <article><span>误码率 BER</span><strong>{{ formatBer(link.ber) }}</strong></article>
      </div>

      <el-alert
        type="success"
        :closable="false"
        show-icon
        title="固定算例一致"
        :description="`SNR = Pr − (N + I) = ${link.receivedPower} − (${loss.effectiveNoiseAndInterferenceDbm}) = ${link.snr} dB`"
      />

      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="带宽">{{ link.bandwidth }} MHz</el-descriptions-item>
        <el-descriptions-item label="调制方式">{{ link.modulation }}</el-descriptions-item>
        <el-descriptions-item label="编码方式">{{ link.coding }}</el-descriptions-item>
        <el-descriptions-item label="质量模型">{{ link.qualityModelVersion }}</el-descriptions-item>
        <el-descriptions-item label="等效噪声与干扰">{{ loss.effectiveNoiseAndInterferenceDbm }} dBm</el-descriptions-item>
        <el-descriptions-item label="固定帧">{{ telemetryStore.frame.frameId }} @ {{ telemetryStore.frame.simulationTime }} s</el-descriptions-item>
      </el-descriptions>

      <p class="quality-example__boundary">
        数据来自仿真固定帧；浏览器只校验输入、结果、模型映射和同帧关系，不在前端复现 SNR/BER 求解算法。
      </p>
    </div>
  </el-card>
</template>

<style scoped>
.quality-example {
  border-color: var(--console-border);
  background: var(--console-bg-elevated);
}

.quality-example__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.quality-example__header h3 {
  margin: var(--space-1) 0 0;
  color: var(--console-text);
  font-size: 1rem;
}

.quality-example__content {
  display: grid;
  gap: var(--space-4);
}

.quality-example__metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
}

.quality-example__metrics article {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background: var(--console-surface);
}

.quality-example__metrics span,
.quality-example__boundary {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.quality-example__metrics strong {
  color: var(--console-cyan);
  font-size: 1.05rem;
  white-space: nowrap;
}

.quality-example__boundary {
  margin: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--console-border);
  line-height: 1.6;
}

@media (max-width: 760px) {
  .quality-example__metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .quality-example__content {
    overflow-x: auto;
  }

  :deep(.el-descriptions__body .el-descriptions__table) {
    min-width: 42rem;
  }
}

@media (max-width: 480px) {
  .quality-example__header {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>

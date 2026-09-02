<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useTelemetryStore } from '../../stores/telemetry'

type LossComponentKey = 'freeSpaceLossDb' | 'systemLossDb' | 'obstructionLossDb' | 'interferenceLossDb'
type DisplayState = 'LOADING' | 'VALIDATING' | 'SUCCESS' | 'EMPTY' | 'ERROR'

const TARGET_LINK_ID = 'L-MW-01'
const LOSS_COMPONENTS: readonly { key: LossComponentKey; label: string }[] = [
  { key: 'freeSpaceLossDb', label: '自由空间损耗' },
  { key: 'systemLossDb', label: '系统损耗' },
  { key: 'obstructionLossDb', label: '遮挡损耗' },
  { key: 'interferenceLossDb', label: '干扰损耗' },
]

const telemetryStore = useTelemetryStore()

const loss = computed(() => (
  telemetryStore.frame?.evidence.losses.find((item) => item.linkId === TARGET_LINK_ID) ?? null
))

const link = computed(() => (
  telemetryStore.frame?.links.find((item) => item.linkId === TARGET_LINK_ID) ?? null
))

const componentTotal = computed(() => {
  const current = loss.value
  if (current === null) return 0
  return LOSS_COMPONENTS.reduce((total, item) => total + current[item.key], 0)
})

const evidenceIssues = computed(() => {
  const frame = telemetryStore.frame
  const currentLoss = loss.value
  if (frame === null || currentLoss === null) return []

  const issues: string[] = []
  if (link.value === null) issues.push(`当前帧缺少链路 ${TARGET_LINK_ID}`)
  if (Math.abs(componentTotal.value - currentLoss.totalPathLossDb) > 1e-9) issues.push('损耗分量合计与总路径损耗不一致')
  if (link.value !== null && Math.abs(link.value.pathLoss - currentLoss.totalPathLossDb) > 1e-9) {
    issues.push('链路结果与损耗证据不一致')
  }
  if (frame.evidence.synchronization.effectiveFrameId !== frame.frameId
    || frame.evidence.synchronization.effectiveSimulationTime !== frame.simulationTime) {
    issues.push('损耗证据与当前帧不一致')
  }
  return issues
})

const displayState = computed<DisplayState>(() => {
  if (telemetryStore.capabilityState === 'LOADING'
    || telemetryStore.capabilityState === 'VALIDATING'
    || telemetryStore.capabilityState === 'ERROR') return telemetryStore.capabilityState
  if (telemetryStore.capabilityState !== 'SUCCESS') return 'EMPTY'
  if (loss.value === null) return 'EMPTY'
  return evidenceIssues.value.length === 0 ? 'SUCCESS' : 'ERROR'
})

const stateLabel = computed(() => ({
  LOADING: '加载中', VALIDATING: '校验中',
  SUCCESS: '算例通过', EMPTY: '暂无数据', ERROR: '证据错误',
})[displayState.value])

const stateType = computed(() => ({
  LOADING: 'info', VALIDATING: 'warning',
  SUCCESS: 'success', EMPTY: 'info', ERROR: 'danger',
} as const)[displayState.value])

const errorMessage = computed(() => (
  evidenceIssues.value.length > 0 ? evidenceIssues.value.join('；') : telemetryStore.resultMessage
))

/**
 * 读取当前损耗分量的展示值。
 * @param key 损耗证据中的分量字段。
 * @returns 对应的 dB 数值；证据缺失时返回 0。
 */
function componentValue(key: LossComponentKey): number {
  return loss.value?.[key] ?? 0
}

/**
 * 重新读取固定帧传播损耗证据。
 * @returns 遥测 Store 的加载结果。
 * @sideEffects 请求本机固定帧接口并替换当前遥测快照。
 */
function reload(): Promise<boolean> {
  return telemetryStore.loadFrame('RUN-001', 'F-00042')
}

onMounted(() => {
  if (telemetryStore.frame === null && telemetryStore.capabilityState === 'EMPTY') void reload()
})
</script>

<template>
  <el-card
    class="loss-example"
    shadow="never"
    aria-labelledby="composite-loss-title"
    data-testid="composite-loss-example"
  >
    <template #header>
      <div class="loss-example__header">
        <div>
          <p class="eyebrow">T-XQ-011 · 传播损耗计算</p>
          <h3 id="composite-loss-title">组合传播损耗固定算例</h3>
        </div>
        <el-tag :type="stateType" effect="dark" data-testid="composite-loss-state">{{ stateLabel }}</el-tag>
      </div>
    </template>

    <el-skeleton v-if="displayState === 'LOADING'" :rows="5" animated />
    <el-alert v-else-if="displayState === 'VALIDATING'" type="warning" :closable="false" show-icon title="正在校验损耗分量、单位和模型版本" />
    <el-result v-else-if="displayState === 'ERROR'" icon="error" title="传播损耗证据不可用" :sub-title="errorMessage">
      <template #extra><el-button type="primary" @click="reload">重新加载</el-button></template>
    </el-result>
    <el-empty v-else-if="displayState === 'EMPTY'" description="当前帧没有 L-MW-01 传播损耗证据">
      <el-button type="primary" @click="reload">加载固定帧</el-button>
    </el-empty>

    <div v-else-if="loss && telemetryStore.frame" class="loss-example__content" :data-frame-id="telemetryStore.frame.frameId">
      <el-alert
        type="success"
        :closable="false"
        show-icon
        title="固定算例一致"
        :description="`${LOSS_COMPONENTS.map((item) => componentValue(item.key)).join(' + ')} = ${loss.totalPathLossDb} dB`"
      />

      <section class="loss-example__formula" aria-label="传播损耗分量公式">
        <template v-for="(item, index) in LOSS_COMPONENTS" :key="item.key">
          <article>
            <span>{{ item.label }}</span>
            <strong>{{ componentValue(item.key) }} dB</strong>
          </article>
          <i v-if="index < LOSS_COMPONENTS.length - 1" aria-hidden="true">+</i>
        </template>
        <i aria-hidden="true">=</i>
        <article class="loss-example__total">
          <span>总路径损耗</span>
          <strong>{{ loss.totalPathLossDb }} dB</strong>
        </article>
      </section>

      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="链路编号">{{ loss.linkId }}</el-descriptions-item>
        <el-descriptions-item label="固定帧">{{ telemetryStore.frame.frameId }} @ {{ telemetryStore.frame.simulationTime }} s</el-descriptions-item>
        <el-descriptions-item label="模型版本">{{ loss.modelVersion }}</el-descriptions-item>
        <el-descriptions-item label="噪声功率">{{ loss.noisePowerDbm }} dBm</el-descriptions-item>
        <el-descriptions-item label="等效噪声与干扰">{{ loss.effectiveNoiseAndInterferenceDbm }} dBm</el-descriptions-item>
        <el-descriptions-item label="链路路径损耗">{{ link?.pathLoss }} dB</el-descriptions-item>
      </el-descriptions>

      <p class="loss-example__boundary">
        数据来自固定帧传播损耗证据；浏览器只校验分量合计、模型版本和同帧关系，不替代仿真计算模块。
      </p>
    </div>
  </el-card>
</template>

<style scoped>
.loss-example {
  border-color: var(--console-border);
  background: var(--console-bg-elevated);
}

.loss-example__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.loss-example__header h3 {
  margin: var(--space-1) 0 0;
  color: var(--console-text);
  font-size: 1rem;
}

.loss-example__content {
  display: grid;
  gap: var(--space-5);
}

.loss-example__formula {
  display: flex;
  align-items: stretch;
  gap: var(--space-2);
  overflow-x: auto;
}

.loss-example__formula article {
  display: grid;
  min-width: 8rem;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background: var(--console-surface);
}

.loss-example__formula span,
.loss-example__boundary {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.loss-example__formula strong {
  color: var(--console-text);
  white-space: nowrap;
}

.loss-example__formula i {
  align-self: center;
  color: var(--console-cyan);
  font-size: 1.1rem;
  font-style: normal;
}

.loss-example__formula .loss-example__total {
  border-color: color-mix(in srgb, var(--console-cyan) 60%, var(--console-border));
}

.loss-example__total strong {
  color: var(--console-cyan);
}

.loss-example__boundary {
  margin: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--console-border);
  line-height: 1.6;
}

@media (max-width: 620px) {
  .loss-example__header {
    align-items: flex-start;
    flex-direction: column;
  }

  :deep(.el-descriptions__body .el-descriptions__table) {
    min-width: 42rem;
  }

  .loss-example__content {
    overflow-x: auto;
  }
}
</style>

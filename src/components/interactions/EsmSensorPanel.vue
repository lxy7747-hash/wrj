<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import type { CapabilityState, DetectionEvent } from '../../contracts/domain-models'
import { useScenarioStore } from '../../stores/scenario'
import { useTelemetryStore } from '../../stores/telemetry'

const SENSOR_ID = 'ESM-01'
const scenarioStore = useScenarioStore()
const telemetryStore = useTelemetryStore()

const sensor = computed(() => (
  scenarioStore.draft?.config.sensors.find((item) => item.id === SENSOR_ID) ?? null
))
const sensorExtension = computed(() => (
  scenarioStore.draft?.uiExtensions.sensors.find((item) => item.sensorId === SENSOR_ID) ?? null
))
const hostPlatform = computed(() => (
  scenarioStore.draft?.config.platforms.find((item) => item.id === sensor.value?.platformId) ?? null
))
const detections = computed(() => telemetryStore.events.filter(
  (event): event is DetectionEvent => event.type === 'DETECTION' && event.sensorId === SENSOR_ID,
))
const detection = computed(() => detections.value[0] ?? null)
const targetPlatform = computed(() => (
  telemetryStore.frame?.platforms.find((item) => item.platformId === detection.value?.targetPlatformId) ?? null
))

const evidenceIssue = computed(() => {
  const currentSensor = sensor.value
  const extension = sensorExtension.value
  const frame = telemetryStore.frame
  if (currentSensor === null || extension === null || frame === null) return null
  if (currentSensor.frequencyRange.min >= currentSensor.frequencyRange.max) return 'ESM 频率范围无效'
  if (currentSensor.detectionRange <= 0) return 'ESM 探测距离无效'
  if (detections.value.length > 1) return '存在重复侦测事件'
  if (detection.value !== null && !extension.enabled) return '停用的 ESM 传感器不能发布侦测事件'
  if (detection.value !== null && targetPlatform.value === null) return '侦测目标不存在'
  if (detection.value !== null
    && (detection.value.frameId !== frame.frameId || detection.value.time !== frame.simulationTime)) {
    return '侦测事件与当前帧不一致'
  }
  return null
})

const displayState = computed<CapabilityState>(() => {
  if (scenarioStore.panelState === 'LOADING' || telemetryStore.capabilityState === 'LOADING') return 'LOADING'
  if (scenarioStore.panelState === 'VALIDATING' || telemetryStore.capabilityState === 'VALIDATING') return 'VALIDATING'
  if (scenarioStore.panelState === 'EXECUTING' || telemetryStore.capabilityState === 'EXECUTING') return 'EXECUTING'
  if (scenarioStore.panelState === 'ERROR' || telemetryStore.capabilityState === 'ERROR') return 'ERROR'
  if (evidenceIssue.value !== null) return 'ERROR'
  if (sensor.value === null || sensorExtension.value === null || telemetryStore.frame === null) return 'EMPTY'
  if (!sensorExtension.value.enabled || detection.value === null) return 'EMPTY'
  return 'SUCCESS'
})

const stateLabel = computed(() => ({
  LOADING: '加载中', VALIDATING: '校验中', EXECUTING: '扫描中',
  SUCCESS: '已检出', EMPTY: '未检出', ERROR: '数据错误',
})[displayState.value])

const stateType = computed(() => ({
  LOADING: 'info', VALIDATING: 'warning', EXECUTING: 'warning',
  SUCCESS: 'success', EMPTY: 'info', ERROR: 'danger',
} as const)[displayState.value])

const emptyMessage = computed(() => (
  sensorExtension.value !== null && !sensorExtension.value.enabled
    ? 'ESM 传感器已停用'
    : '当前帧未检出目标'
))

const errorMessage = computed(() => {
  if (evidenceIssue.value !== null) return evidenceIssue.value
  if (scenarioStore.panelState === 'ERROR') return scenarioStore.resultMessage
  if (telemetryStore.resultFieldPath === null) return telemetryStore.resultMessage
  return `${telemetryStore.resultMessage}（${telemetryStore.resultFieldPath}）`
})

/**
 * 重新读取 ESM 场景配置和固定帧侦测事件。
 * @returns 两项数据均加载成功时返回 `true`。
 * @sideEffects 请求本机 Mock 接口，替换场景草稿与遥测快照，并在成功后连接实时通道。
 */
async function reload(): Promise<boolean> {
  const [scenarioLoaded, frameLoaded] = await Promise.all([
    scenarioStore.loadScenario('SCN-001'),
    telemetryStore.loadFrame('RUN-001', 'F-00042'),
  ])
  if (frameLoaded) telemetryStore.connect()
  return scenarioLoaded && frameLoaded
}

onMounted(() => {
  if (scenarioStore.draft === null || telemetryStore.frame === null) void reload()
})

onBeforeUnmount(() => {
  telemetryStore.disconnectAndReset()
})
</script>

<template>
  <el-card class="esm-panel" shadow="never" aria-labelledby="esm-panel-title" data-testid="esm-sensor-panel">
    <template #header>
      <div class="esm-panel__header">
        <div>
          <p class="eyebrow">T-XQ-014 · ESM 传感器与侦测</p>
          <h3 id="esm-panel-title">ESM 传感器与侦测结果</h3>
        </div>
        <el-tag :type="stateType" effect="dark" data-testid="esm-state">{{ stateLabel }}</el-tag>
      </div>
    </template>

    <el-skeleton v-if="displayState === 'LOADING'" :rows="4" animated />
    <el-alert v-else-if="displayState === 'VALIDATING'" type="warning" :closable="false" show-icon title="正在校验传感器配置和同帧侦测事件" />
    <el-alert v-else-if="displayState === 'EXECUTING'" type="warning" :closable="false" show-icon title="ESM 传感器正在扫描" />
    <el-result v-else-if="displayState === 'ERROR'" icon="error" title="ESM 侦测数据不可用" :sub-title="errorMessage">
      <template #extra><el-button type="primary" @click="reload">重新加载</el-button></template>
    </el-result>
    <el-empty v-else-if="displayState === 'EMPTY'" :description="emptyMessage">
      <el-button type="primary" @click="reload">重新加载</el-button>
    </el-empty>

    <div v-else-if="sensor && sensorExtension && detection && targetPlatform && telemetryStore.frame" class="esm-panel__content">
      <div class="esm-panel__metrics" aria-label="ESM 传感器关键参数">
        <article><span>启用状态</span><strong>已启用</strong></article>
        <article><span>频率范围</span><strong>{{ sensor.frequencyRange.min }}–{{ sensor.frequencyRange.max }} MHz</strong></article>
        <article><span>探测距离</span><strong>{{ sensor.detectionRange / 1000 }} km</strong></article>
        <article><span>探测概率</span><strong>{{ Math.round(sensorExtension.probability * 100) }}%</strong></article>
      </div>

      <el-alert
        v-if="telemetryStore.resultCode === 'DUPLICATE_EVENT'"
        type="info"
        :closable="false"
        show-icon
        title="重复侦测事件已忽略"
      />

      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="传感器">{{ sensor.id }}</el-descriptions-item>
        <el-descriptions-item label="所属平台">{{ hostPlatform?.name ?? sensor.platformId }}</el-descriptions-item>
        <el-descriptions-item label="覆盖方向">{{ sensorExtension.direction === 'OMNI' ? '全向' : `${sensorExtension.direction}°` }}</el-descriptions-item>
        <el-descriptions-item label="事件编号">{{ detection.eventId }}</el-descriptions-item>
        <el-descriptions-item label="侦测目标">{{ targetPlatform.name }}（{{ targetPlatform.platformId }}）</el-descriptions-item>
        <el-descriptions-item label="侦测概率">{{ Math.round(detection.detectionProbability * 100) }}%</el-descriptions-item>
        <el-descriptions-item label="仿真时刻">{{ detection.time }} s</el-descriptions-item>
        <el-descriptions-item label="固定帧">{{ telemetryStore.frame.frameId }}</el-descriptions-item>
        <el-descriptions-item label="去重键">{{ detection.dedupeKey }}</el-descriptions-item>
      </el-descriptions>

      <p class="esm-panel__boundary">
        数据来自场景配置和仿真侦测事件；浏览器只校验配置、目标、概率、时戳与同帧关系，不复现传感器探测算法。
      </p>
    </div>
  </el-card>
</template>

<style scoped>
.esm-panel {
  border-color: var(--console-border);
  background: var(--console-bg-elevated);
}

.esm-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.esm-panel__header h3 {
  margin: var(--space-1) 0 0;
  color: var(--console-text);
  font-size: 1rem;
}

.esm-panel__content {
  display: grid;
  gap: var(--space-4);
}

.esm-panel__metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
}

.esm-panel__metrics article {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background: var(--console-surface);
}

.esm-panel__metrics span,
.esm-panel__boundary {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.esm-panel__metrics strong {
  color: var(--console-teal);
  font-size: 1.05rem;
  white-space: nowrap;
}

.esm-panel__boundary {
  margin: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--console-border);
  line-height: 1.6;
}

@media (max-width: 760px) {
  .esm-panel__metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .esm-panel__content {
    overflow-x: auto;
  }

  :deep(.el-descriptions__body .el-descriptions__table) {
    min-width: 42rem;
  }
}

@media (max-width: 480px) {
  .esm-panel__header {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CapabilityState, DetectionEvent } from '../../contracts/domain-models'
import { PLATFORM_TYPE_LABELS } from '../../features/situation/situation-model'
import { useScenarioStore } from '../../stores/scenario'
import { useSimulationStore } from '../../stores/simulation'
import { useTelemetryStore } from '../../stores/telemetry'

const scenarioStore = useScenarioStore()
const simulationStore = useSimulationStore()
const telemetryStore = useTelemetryStore()

/** 当前选择的传感器；选择项来自当前场景 config.sensors，与 uiExtensions 按 sensor.id 关联。 */
const selectedSensorId = ref('')
const reloadError = ref('')

const sensors = computed(() => scenarioStore.draft?.config.sensors ?? [])
const selectedSensor = computed(() => sensors.value.find((item) => item.id === selectedSensorId.value) ?? null)
const sensorExtension = computed(() => (
  scenarioStore.draft?.uiExtensions.sensors.find((item) => item.sensorId === selectedSensorId.value) ?? null
))
const hostPlatform = computed(() => (
  scenarioStore.draft?.config.platforms.find((item) => item.id === selectedSensor.value?.platformId) ?? null
))
const detections = computed(() => telemetryStore.events.filter(
  (event): event is DetectionEvent => event.type === 'DETECTION' && event.sensorId === selectedSensorId.value,
))
const detection = computed(() => detections.value.at(-1) ?? null)
const sensorStatus = computed(() => telemetryStore.sensorStatuses.find(
  status => status.sensorId === selectedSensorId.value && status.platformId === selectedSensor.value?.platformId,
) ?? null)
const targetPlatform = computed(() => (
  telemetryStore.frame?.platforms.find((item) => item.platformId === detection.value?.targetPlatformId) ?? null
))

/**
 * 目标平台在当前帧平台表中的位置与类型，来源为同帧平台遥测，不是 ESM 测得位置。
 * 缺坐标时保持 null，界面显示“暂无数据”，不用传感器配置或计算值补齐。
 */
const targetPlatformTypeLabel = computed(() => {
  const platform = targetPlatform.value
  return platform === null ? '暂无数据' : PLATFORM_TYPE_LABELS[platform.type] ?? platform.type
})
const targetPlatformPosition = computed(() => {
  const platform = targetPlatform.value
  if (platform === null || !Number.isFinite(platform.longitude) || !Number.isFinite(platform.latitude)) return null
  const altitude = Number.isFinite(platform.altitude) ? `，高度 ${platform.altitude} m` : ''
  return `${platform.longitude.toFixed(4)}°，${platform.latitude.toFixed(4)}°${altitude}`
})

/**
 * ESM 引擎帧可直接携带的目标实测细节字段（DetectionEvent 可选字段，A 已落地）。
 * 缺失时保持 undefined，界面显示“暂无数据”，不以同帧平台值或计算值补齐。
 */
const esmMeasuredPosition = computed(() => {
  const detail = detection.value
  if (detail === null) return null
  const longitude = detail.measuredLongitude
  const latitude = detail.measuredLatitude
  if (typeof longitude !== 'number' || !Number.isFinite(longitude)
    || typeof latitude !== 'number' || !Number.isFinite(latitude)) return null
  const altitude = typeof detail.measuredAltitude === 'number' && Number.isFinite(detail.measuredAltitude)
    ? `，高度 ${detail.measuredAltitude} m`
    : ''
  return `${longitude.toFixed(4)}°，${latitude.toFixed(4)}°${altitude}`
})
const actualFrequencyLabel = computed(() => {
  const value = detection.value?.actualFrequencyMHz
  return typeof value === 'number' && Number.isFinite(value) ? `${value} MHz` : '暂无数据'
})
const receivedSignalStrengthLabel = computed(() => {
  const value = detection.value?.receivedSignalStrengthDbm
  return typeof value === 'number' && Number.isFinite(value) ? `${value} dBm` : '暂无数据'
})

/** 场景变化后保留仍有效的选择，否则退回第一项；无传感器时清空选择。 */
watch(sensors, (items) => {
  if (!items.some((item) => item.id === selectedSensorId.value)) selectedSensorId.value = items[0]?.id ?? ''
}, { immediate: true })

/** 当前运行/帧身份；未知时保持 null，不回退任何默认编号。 */
const currentRunId = computed(() => simulationStore.run?.runId ?? telemetryStore.frame?.runId ?? null)
const pending = computed(() => (
  scenarioStore.panelState === 'LOADING' || scenarioStore.panelState === 'VALIDATING'
  || telemetryStore.capabilityState === 'LOADING' || telemetryStore.capabilityState === 'VALIDATING'
))

/** 按当前 run/场景/sensor/宿主/目标/帧校验证据一致性；不一致时不冒充成功。 */
const evidenceIssue = computed(() => {
  const sensor = selectedSensor.value
  const extension = sensorExtension.value
  const frame = telemetryStore.frame
  if (sensor === null || extension === null || frame === null) return null
  if (hostPlatform.value === null) return 'ESM 宿主平台不存在'
  if (sensor.frequencyRange.min >= sensor.frequencyRange.max) return 'ESM 频率范围无效'
  if (sensor.detectionRange <= 0) return 'ESM 探测距离无效'
  if (detection.value !== null && !extension.enabled) return '停用的 ESM 传感器不能发布侦测事件'
  if (detection.value !== null && targetPlatform.value === null) return '侦测目标不存在'
  if (detection.value !== null
    && (detection.value.frameId !== frame.frameId || detection.value.time !== frame.simulationTime)) {
    return '侦测事件与当前帧不一致'
  }
  return null
})

type FixedEvidenceState = Exclude<CapabilityState, 'EXECUTING'>

/** 空态原因：区分无传感器 / 停用 / 缺扩展 / 未接入 / 暂无该运行数据。 */
const emptyLabel = computed(() => {
  if (sensors.value.length === 0 || selectedSensor.value === null) return '无传感器'
  if (sensorExtension.value === null) return '缺扩展'
  if (!sensorExtension.value.enabled) return '已停用'
  if (telemetryStore.frame === null) return '未接入'
  return '暂无数据'
})

const displayState = computed<FixedEvidenceState>(() => {
  if (pending.value) return scenarioStore.panelState === 'VALIDATING' || telemetryStore.capabilityState === 'VALIDATING' ? 'VALIDATING' : 'LOADING'
  if (scenarioStore.panelState === 'ERROR' && scenarioStore.draft === null) return 'ERROR'
  if (sensors.value.length === 0 || selectedSensor.value === null) return 'EMPTY'
  if (sensorExtension.value === null || !sensorExtension.value.enabled) return 'EMPTY'
  if (telemetryStore.frame === null) return 'EMPTY'
  if (evidenceIssue.value !== null) return 'ERROR'
  if (detection.value === null) return 'EMPTY'
  return 'SUCCESS'
})

const stateLabel = computed(() => {
  if (displayState.value === 'SUCCESS') return detection.value?.detected === false ? '未检出' : '已发现'
  return ({
    LOADING: '加载中', VALIDATING: '校验中', ERROR: '数据错误', EMPTY: emptyLabel.value,
  } as const)[displayState.value]
})
const stateType = computed(() => ({
  LOADING: 'info', VALIDATING: 'warning',
  SUCCESS: 'success', EMPTY: 'info', ERROR: 'danger',
} as const)[displayState.value])

const emptyMessage = computed(() => {
  if (sensors.value.length === 0) return '当前场景未配置 ESM 传感器'
  if (selectedSensor.value === null) return '未选择有效的 ESM 传感器'
  if (sensorExtension.value === null) return '该 ESM 传感器缺少界面扩展配置'
  if (!sensorExtension.value.enabled) return '该 ESM 传感器已停用'
  if (telemetryStore.frame === null) return '当前运行暂无固定 ESM 侦测数据（未接入真实 ESM 遥测）'
  // 无侦测事件时不得写作“未检出”，只有可信 detected=false 才是未检出。
  return '当前帧暂无该传感器侦测数据'
})

const errorMessage = computed(() => {
  if (evidenceIssue.value !== null) return evidenceIssue.value
  if (scenarioStore.panelState === 'ERROR') return scenarioStore.resultMessage
  if (telemetryStore.resultFieldPath === null) return telemetryStore.resultMessage
  return `${telemetryStore.resultMessage}（${telemetryStore.resultFieldPath}）`
})

/**
 * 重新读取当前已校验场景与当前运行的可用帧。
 * @returns 场景与帧均重新加载成功时返回 `true`。
 * @sideEffects 仅在存在已校验场景、运行和帧时发起请求；缺失时保持空态，不回退默认编号或触发运行重置。
 */
async function reload(): Promise<boolean> {
  reloadError.value = ''
  const scenarioId = scenarioStore.currentScenarioId ?? scenarioStore.draft?.config.scenario.id ?? null
  const runId = currentRunId.value
  const frameId = telemetryStore.frame?.frameId ?? null
  if (scenarioId === null || runId === null || frameId === null) {
    reloadError.value = '当前缺少已校验的场景、运行或帧，未发起请求（未接入）。'
    return false
  }
  const [scenarioLoaded, frameLoaded] = await Promise.all([
    scenarioStore.loadScenario(scenarioId),
    telemetryStore.loadFrame(runId, frameId),
  ])
  if (frameLoaded) telemetryStore.connect()
  return scenarioLoaded && frameLoaded
}
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

    <div class="esm-panel__selector">
      <label class="esm-panel__selector-label" for="esm-sensor-select">ESM 传感器</label>
      <el-select
        id="esm-sensor-select"
        v-model="selectedSensorId"
        :disabled="sensors.length === 0 || pending"
        :placeholder="sensors.length === 0 ? '当前场景无 ESM 传感器' : '选择 ESM 传感器'"
        data-testid="esm-sensor-select"
      >
        <el-option
          v-for="item in sensors"
          :key="item.id"
          :label="`${item.id} · ${item.platformId}`"
          :value="item.id"
        />
      </el-select>
      <el-button size="small" :loading="pending" @click="reload">重新加载</el-button>
    </div>

    <el-skeleton v-if="displayState === 'LOADING'" :rows="4" animated />
    <el-alert v-else-if="displayState === 'VALIDATING'" type="warning" :closable="false" show-icon title="正在校验传感器配置和同帧侦测事件" />
    <el-result v-else-if="displayState === 'ERROR'" icon="error" title="ESM 侦测数据不可用" :sub-title="errorMessage">
      <template #extra><el-button type="primary" @click="reload">重新加载</el-button></template>
    </el-result>
    <el-empty v-else-if="displayState === 'EMPTY'" :description="emptyMessage">
      <el-button type="primary" @click="reload">重新加载</el-button>
    </el-empty>

    <div v-else-if="selectedSensor && sensorExtension && detection && telemetryStore.frame" class="esm-panel__content">
      <div class="esm-panel__metrics" aria-label="ESM 传感器关键参数">
        <article><span>启用状态</span><strong>已启用</strong></article>
        <article><span>频率范围</span><strong>{{ selectedSensor.frequencyRange.min }}–{{ selectedSensor.frequencyRange.max }} MHz</strong></article>
        <article><span>探测距离</span><strong>{{ selectedSensor.detectionRange / 1000 }} km</strong></article>
        <article><span>探测概率</span><strong>{{ Math.round(sensorExtension.probability * 100) }}%</strong></article>
      </div>

      <el-alert
        v-if="telemetryStore.resultCode === 'DUPLICATE_EVENT'"
        type="info"
        :closable="false"
        show-icon
        title="重复侦测事件已忽略"
      />

      <el-descriptions :column="2" border size="small" data-testid="esm-target-detail" aria-label="ESM 目标详情（区分来源）">
        <el-descriptions-item label="目标平台类型">{{ targetPlatformTypeLabel }}</el-descriptions-item>
        <el-descriptions-item label="目标位置（同帧平台 · 来源：平台遥测）">{{ targetPlatformPosition ?? '暂无数据' }}</el-descriptions-item>
        <el-descriptions-item label="ESM 测得位置（来源：ESM 遥测）">{{ esmMeasuredPosition ?? '暂无数据' }}</el-descriptions-item>
        <el-descriptions-item label="实际工作频率">{{ actualFrequencyLabel }}</el-descriptions-item>
        <el-descriptions-item label="接收信号强度">{{ receivedSignalStrengthLabel }}</el-descriptions-item>
      </el-descriptions>

      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="传感器">{{ selectedSensor.id }}</el-descriptions-item>
        <el-descriptions-item label="所属平台">{{ hostPlatform?.name ?? selectedSensor?.platformId }}</el-descriptions-item>
        <el-descriptions-item label="覆盖方向">{{ sensorExtension.direction === 'OMNI' ? '全向' : `${sensorExtension.direction}°` }}</el-descriptions-item>
        <el-descriptions-item label="事件编号">{{ detection.eventId }}</el-descriptions-item>
        <el-descriptions-item label="侦测结果">{{ detection.detected === false ? '未发现' : '已发现' }}</el-descriptions-item>
        <el-descriptions-item label="侦测频段">{{ detection.frequencyMinMHz === undefined ? '暂无数据' : `${detection.frequencyMinMHz}–${detection.frequencyMaxMHz} MHz` }}</el-descriptions-item>
        <el-descriptions-item label="侦测目标">{{ targetPlatform?.name ?? detection.targetPlatformId }}（{{ detection.targetPlatformId }}）</el-descriptions-item>
        <el-descriptions-item label="侦测概率">{{ Math.round(detection.detectionProbability * 100) }}%</el-descriptions-item>
        <el-descriptions-item label="仿真时刻">{{ detection.time }} s</el-descriptions-item>
        <el-descriptions-item label="固定帧">{{ telemetryStore.frame.frameId }}</el-descriptions-item>
        <el-descriptions-item label="去重键">{{ detection.dedupeKey }}</el-descriptions-item>
      </el-descriptions>

      <p class="esm-panel__boundary">
        数据来自当前场景配置和同一运行帧的侦测事件。目标位置中的“同帧平台位置”取自平台遥测（类型/经纬度/高度），
        不是 ESM 测得位置；ESM 测得位置、实际工作频率、接收信号强度在引擎未提供时显示“暂无数据”，
        不以同帧平台值、计算值或固定值补齐。浏览器只校验配置、宿主、目标、概率、时戳与同帧关系，不复现传感器探测算法。
      </p>
    </div>
    <el-descriptions v-if="selectedSensor && telemetryStore.frame && (displayState === 'SUCCESS' || displayState === 'EMPTY')" :column="2" border size="small" data-testid="sensor-runtime-status">
      <el-descriptions-item label="工作状态">{{ sensorStatus === null ? '暂无数据' : sensorStatus.active ? '开启' : '关闭' }}</el-descriptions-item>
      <el-descriptions-item label="扫描覆盖">{{ sensorStatus?.scanCoveragePercent === undefined ? '暂无数据' : `${sensorStatus.scanCoveragePercent}%` }}</el-descriptions-item>
    </el-descriptions>
    <p v-if="reloadError" class="esm-panel__reload-error" data-testid="esm-reload-error">{{ reloadError }}</p>
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

.esm-panel__selector {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
  flex-wrap: wrap;
}

.esm-panel__selector-label {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.esm-panel__selector :deep(.el-select) {
  min-width: 16rem;
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
.esm-panel__boundary,
.esm-panel__reload-error {
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

.esm-panel__reload-error {
  margin: var(--space-3) 0 0;
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

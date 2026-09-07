<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue'
import type { BusinessInformationNodeType, Platform, PlatformType, SatelliteType } from '../../contracts/domain-models'
import { PLATFORM_TYPE_DOMAINS } from '../../features/scenarios/scenario-validation'
import WaypointMapPicker, { type WaypointMapPoint } from './WaypointMapPicker.vue'

type PlatformTypeOption = { value: PlatformType, label: string }
type SatelliteTypeOption = { value: SatelliteType, label: string }

const props = defineProps<{
  modelValue: boolean
  platform: Platform | null
  editing: boolean
  error: string
  pending: boolean
  locked: boolean
  businessTypeOptions: readonly PlatformTypeOption[]
  supportingTypeOptions: readonly PlatformTypeOption[]
  satelliteTypeOptions: readonly SatelliteTypeOption[]
  businessTypeCounts: Readonly<Record<BusinessInformationNodeType, number>>
  businessTypeLimits: Readonly<Record<BusinessInformationNodeType, number>>
  deploymentDomainLabels: Record<Platform['category'], string>
}>()

const emit = defineEmits<{
  'update:modelValue': [visible: boolean]
  apply: [platform: Platform, quantity: number]
}>()

const editor = ref<Platform | null>(null)
const waypointPickerVisible = ref(false)
const waypointPickerIndex = ref<number | null>(null)
const waypointPickerPoint = ref<WaypointMapPoint>({ longitude: 0, latitude: 0 })
const quantity = ref(1)

const selectedBusinessType = computed(() => {
  const type = editor.value?.type
  return type !== undefined && Object.hasOwn(props.businessTypeLimits, type)
    ? type as BusinessInformationNodeType
    : null
})
const availableQuantity = computed(() => {
  const type = selectedBusinessType.value
  if (type === null) return 1
  const editingCurrentType = props.editing && props.platform?.type === type ? 1 : 0
  return Math.max(0, props.businessTypeLimits[type] - props.businessTypeCounts[type] + editingCurrentType)
})
const showBatchQuantity = computed(() => !props.editing && editor.value?.type === 'AIRBORNE_MISSION_CLUSTER')
const cannotAdd = computed(() => !props.editing && availableQuantity.value === 0)

/**
 * 同步实体类型对应的卫星子类型和批量数量字段。
 * @param type 当前选择的场景实体类型。
 * @returns 无返回值。
 * @sideEffects 同步部署域、移除非卫星的子类型；不补卫星默认值，非空中无人作业集群恢复单条新增。
 */
function synchronizeTypeFields(type: PlatformType): void {
  if (editor.value === null) return
  editor.value.category = PLATFORM_TYPE_DOMAINS[type]
  if (type !== 'COMMUNICATION_SATELLITE') delete editor.value.satelliteType
  if (type !== 'AIRBORNE_MISSION_CLUSTER') quantity.value = 1
}

function addWaypoint(): void {
  editor.value?.waypoints.push({ longitude: 0, latitude: 0, altitude: 0, speed: 0, arrivalTime: 0 })
}

function openWaypointPicker(index: number): void {
  const waypoint = editor.value?.waypoints[index]
  if (waypoint === undefined) return
  waypointPickerIndex.value = index
  waypointPickerPoint.value = { longitude: waypoint.longitude, latitude: waypoint.latitude }
  waypointPickerVisible.value = true
}

function applyWaypointMapPoint(point: WaypointMapPoint): void {
  if (waypointPickerIndex.value === null) return
  const waypoint = editor.value?.waypoints[waypointPickerIndex.value]
  if (waypoint === undefined) return
  waypoint.longitude = point.longitude
  waypoint.latitude = point.latitude
  waypoint.altitude = 0
  waypointPickerVisible.value = false
}

function resetWaypointPicker(): void {
  waypointPickerVisible.value = false
  waypointPickerIndex.value = null
}

function removeWaypoint(index: number): void {
  editor.value?.waypoints.splice(index, 1)
}

function apply(): void {
  if (editor.value !== null && !cannotAdd.value) emit('apply', editor.value, quantity.value)
}

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  editor.value = props.platform === null ? null : structuredClone(toRaw(props.platform))
  quantity.value = 1
  if (editor.value !== null) synchronizeTypeFields(editor.value.type)
  resetWaypointPicker()
}, { immediate: true })
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    class="platform-editor-dialog"
    :title="editing ? '编辑场景实体' : '新增场景实体'"
    width="min(880px, calc(100vw - 2rem))"
    destroy-on-close
    append-to-body
    data-testid="platform-dialog"
    @update:model-value="emit('update:modelValue', $event)"
    @closed="resetWaypointPicker"
  >
    <el-alert v-if="error" class="platform-feedback" type="error" :closable="false" :title="error" show-icon />
    <el-form v-if="editor" class="platform-editor-form" :model="editor" label-position="top" :disabled="pending || locked">
      <section class="platform-editor-section" aria-labelledby="platform-basic-title">
        <h4 id="platform-basic-title" class="platform-editor-section__title">基本信息</h4>
        <div class="platform-editor-grid">
          <el-form-item label="场景实体 ID">
            <el-input v-model="editor.id" :disabled="editing" data-testid="platform-id" />
          </el-form-item>
          <el-form-item label="名称">
            <el-input v-model="editor.name" data-testid="platform-name" />
          </el-form-item>
          <el-form-item label="场景实体类型">
            <el-select v-model="editor.type" placeholder="请选择场景实体类型" style="width: 100%" data-testid="platform-type" @change="synchronizeTypeFields">
              <el-option-group label="信息节点">
                <el-option v-for="option in businessTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-option-group>
              <el-option-group label="支撑实体（不计入50个信息节点）">
                <el-option v-for="option in supportingTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-option-group>
            </el-select>
            <span v-if="selectedBusinessType" class="platform-editor-field__hint">
              当前 {{ businessTypeCounts[selectedBusinessType] }} / {{ businessTypeLimits[selectedBusinessType] }} 个
            </span>
          </el-form-item>
          <el-form-item v-if="editor.type === 'COMMUNICATION_SATELLITE'" label="卫星类型">
            <el-select v-model="editor.satelliteType" placeholder="请选择卫星类型" style="width: 100%" data-testid="platform-satellite-type">
              <el-option v-for="option in satelliteTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="showBatchQuantity" label="新增数量">
            <el-input-number v-model="quantity" :min="availableQuantity === 0 ? 0 : 1" :max="availableQuantity" :disabled="cannotAdd" :precision="0" controls-position="right" data-testid="platform-quantity" />
            <span class="platform-editor-field__hint">该类型还可新增 {{ availableQuantity }} 个，批量节点可在新增后逐个编辑。</span>
          </el-form-item>
          <el-form-item label="部署域">
            <el-input :model-value="deploymentDomainLabels[editor.category]" readonly data-testid="platform-category" />
          </el-form-item>
        </div>
      </section>

      <section class="platform-editor-section" aria-labelledby="platform-position-title">
        <h4 id="platform-position-title" class="platform-editor-section__title">初始位置</h4>
        <div class="position-grid">
          <el-form-item label="经度（°）"><el-input-number v-model="editor.initialPosition.longitude" :min="-180" :max="180" controls-position="right" data-testid="platform-longitude" /></el-form-item>
          <el-form-item label="纬度（°）"><el-input-number v-model="editor.initialPosition.latitude" :min="-90" :max="90" controls-position="right" data-testid="platform-latitude" /></el-form-item>
          <el-form-item label="高度（m）"><el-input-number v-model="editor.initialPosition.altitude" :min="0" controls-position="right" data-testid="platform-altitude" /></el-form-item>
        </div>
      </section>

      <section class="platform-editor-section" aria-labelledby="platform-relation-title">
        <h4 id="platform-relation-title" class="platform-editor-section__title">关联资源</h4>
        <div class="position-grid">
          <el-form-item label="链路">
            <el-input :model-value="editor.linkIds.join(', ')" readonly placeholder="由链路端点自动生成" data-testid="platform-link-ids" />
          </el-form-item>
          <el-form-item label="传感器">
            <el-input :model-value="editor.sensorIds.join(', ')" readonly placeholder="由传感器归属自动生成" data-testid="platform-sensor-ids" />
          </el-form-item>
          <el-form-item label="干扰器">
            <el-input :model-value="editor.jammerIds.join(', ')" readonly placeholder="由干扰设备归属自动生成" data-testid="platform-jammer-ids" />
          </el-form-item>
        </div>
      </section>

      <section class="platform-editor-section" aria-labelledby="platform-waypoint-title">
        <div class="waypoint-heading">
          <h4 id="platform-waypoint-title" class="platform-editor-section__title">航点配置（{{ editor.waypoints.length }}）</h4>
          <el-button size="small" :disabled="pending || locked" data-testid="add-waypoint" @click="addWaypoint">新增航点</el-button>
        </div>
        <el-table :data="editor.waypoints" empty-text="暂无航点" data-testid="waypoint-table">
          <el-table-column label="经度（°）" min-width="130"><template #default="{ row, $index }"><el-input-number v-model="row.longitude" :min="-180" :max="180" controls-position="right" :data-testid="`waypoint-longitude-${$index}`" /></template></el-table-column>
          <el-table-column label="纬度（°）" min-width="130"><template #default="{ row, $index }"><el-input-number v-model="row.latitude" :min="-90" :max="90" controls-position="right" :data-testid="`waypoint-latitude-${$index}`" /></template></el-table-column>
          <el-table-column label="高度（m）" min-width="130"><template #default="{ row, $index }"><el-input-number v-model="row.altitude" :min="0" controls-position="right" :data-testid="`waypoint-altitude-${$index}`" /></template></el-table-column>
          <el-table-column label="速度（m/s）" min-width="130"><template #default="{ row, $index }"><el-input-number v-model="row.speed" :min="0" controls-position="right" :data-testid="`waypoint-speed-${$index}`" /></template></el-table-column>
          <el-table-column label="到达时间（s）" min-width="140"><template #default="{ row, $index }"><el-input-number v-model="row.arrivalTime" :min="0" controls-position="right" :data-testid="`waypoint-arrival-${$index}`" /></template></el-table-column>
          <el-table-column label="操作" width="140">
            <template #default="{ $index }">
              <el-button link type="primary" :disabled="pending || locked" :data-testid="`pick-waypoint-${$index}`" @click="openWaypointPicker($index)">地图选点</el-button>
              <el-button link type="danger" :disabled="pending || locked" :data-testid="`delete-waypoint-${$index}`" @click="removeWaypoint($index)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </el-form>
    <template #footer>
      <el-button data-testid="cancel-platform" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="pending || locked || cannotAdd" data-testid="apply-platform" @click="apply">确认</el-button>
    </template>
  </el-dialog>

  <WaypointMapPicker
    v-model="waypointPickerVisible"
    :longitude="waypointPickerPoint.longitude"
    :latitude="waypointPickerPoint.latitude"
    @confirm="applyWaypointMapPoint"
  />
</template>

<style scoped>
.platform-feedback {
  margin-bottom: 1rem;
}

.platform-editor-grid,
.position-grid {
  display: grid;
  gap: 0 1rem;
}

.platform-editor-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.platform-editor-form {
  display: grid;
  gap: 0.5rem;
}

.platform-editor-field__hint {
  display: block;
  margin-top: 0.25rem;
  color: var(--console-text-muted);
  font-size: 12px;
  line-height: 1.4;
}

.platform-editor-section {
  min-width: 0;
}

.platform-editor-section__title {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0 0 0.375rem;
  color: var(--console-cyan);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
}

.platform-editor-section__title::after {
  flex: 1;
  border-top: 1px solid var(--console-border);
  content: '';
}

.platform-editor-form :deep(.el-form-item) {
  margin-bottom: 0.375rem;
}

.platform-editor-form :deep(.el-form-item__label) {
  margin-bottom: 0.25rem;
  line-height: 1.25rem;
}

.platform-editor-form :deep(.el-input-number) {
  width: 100%;
}

.platform-editor-form :deep(.el-select__wrapper .el-tag) {
  --el-tag-bg-color: rgb(13 48 65 / 90%);
  --el-tag-border-color: var(--console-border-strong);
  --el-tag-text-color: var(--console-text);
}

.position-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.waypoint-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.375rem;
}

.waypoint-heading .platform-editor-section__title {
  flex: 1;
  margin-bottom: 0;
}

:global(.platform-editor-dialog .el-dialog__close) {
  color: var(--console-text);
}

:global(.platform-editor-dialog .el-dialog__headerbtn:hover .el-dialog__close) {
  color: var(--console-cyan);
}

@media (max-width: 960px) {
  .platform-editor-grid,
  .position-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 600px) {
  .platform-editor-grid,
  .position-grid {
    grid-template-columns: 1fr;
  }
}
</style>

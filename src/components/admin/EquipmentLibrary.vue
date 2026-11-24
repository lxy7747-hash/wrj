<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { EquipmentParameter } from '../../contracts/domain-models'
import type { EquipmentHistoryDetails, EquipmentRecreateParameters } from '../../features/admin/equipment-history-contract'
import { EQUIPMENT_LINK_TYPES, equipmentDataRateOptions, equipmentLinkIssues, equipmentModulations } from '../../features/admin/equipment-link-rules'
import { FIBER_DATA_RATE_MBPS, formatDataRate } from '../../features/scenarios/link-calc-defaults'
import { useAdminStore } from '../../stores/admin'
import EquipmentRelations from './EquipmentRelations.vue'

const store = useAdminStore()
const feedback = computed(() => store.maintenance.equipment)
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(feedback.value.state))
const editor = ref<EquipmentParameter | null>(null)
const viewing = ref<EquipmentParameter | null>(null)
const creating = ref(false)
const parameterIssues = computed(() => editor.value ? equipmentLinkIssues(editor.value) : {})
const modulationOptions = computed(() => equipmentModulations(editor.value?.type ?? ''))
const modulationError = computed(() => parameterIssues.value.modulation ?? '')
const dataRateOptions = computed(() => equipmentDataRateOptions(editor.value?.type ?? ''))
const dataRateError = computed(() => parameterIssues.value.dataRateMbps ?? '')
const parameterInvalid = computed(() => Object.keys(parameterIssues.value).length > 0)
const confirming = ref(false)
// 历史/核验/重建：按需加载，避免查看详情时额外请求影响既有流程。
const history = ref<EquipmentHistoryDetails | null>(null)
const historyPending = ref(false)
const deletedQuery = ref('')
const deletedDetails = ref<EquipmentHistoryDetails | null>(null)
const deletedPending = ref(false)
const verification = ref({ coveredTargets: '', evidenceSummary: '', conclusion: '' })
const recreate = ref<(EquipmentRecreateParameters & { expectedHistoryVersion: number }) | null>(null)
const recreateId = ref('')
const recreating = ref(false)
const query = ref('')
const selectedType = ref('')
const equipmentTypes = Object.keys(EQUIPMENT_LINK_TYPES)
const frequency = ref<number | null>(null)
const types = computed(() => [...new Set(store.equipment.map(row => row.type))])
const filtered = computed(() => store.equipment.filter(row => (!selectedType.value || row.type === selectedType.value)
  && (!query.value.trim() || `${row.equipmentId} ${row.type} ${row.modulation ?? ''}`.toLowerCase().includes(query.value.trim().toLowerCase()))
  && (frequency.value === null || (row.frequencyMinMHz !== null && row.frequencyMaxMHz !== null && frequency.value >= row.frequencyMinMHz && frequency.value <= row.frequencyMaxMHz))))

watch(() => [feedback.value.state, feedback.value.message] as const, ([state, message]) => {
  if (state === 'ERROR' && message && editor.value === null) ElMessage.error(message)
})

async function remove(row: EquipmentParameter): Promise<void> {
  if (pending.value || confirming.value || row.readOnly) return
  const record = { ...row }
  const epoch = store.maintenanceEpoch
  confirming.value = true
  try {
    await ElMessageBox.confirm(`确认删除装备“${row.equipmentId}”？删除后不可恢复。`, '删除装备参数', { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' })
    if (epoch !== store.maintenanceEpoch) return
    if (await store.deleteEquipment(record)) {
      ElMessage.success(feedback.value.message)
      store.maintenance.equipment.message = ''
      await store.loadMaintenance('equipment')
    }
  } catch { /* 取消或关闭确认框不发送删除请求。 */ }
  finally { confirming.value = false }
}

function edit(row?: EquipmentParameter): void {
  if (row?.readOnly) return
  creating.value = !row
  editor.value = row ? { ...row } : { equipmentId: '', type: '', frequencyMinMHz: null,
    frequencyMaxMHz: null, modulation: null, berThreshold: null, bandwidthMHz: null, txPowerW: null, dataRateMbps: null, active: true, readOnly: false, version: 1 }
  store.maintenance.equipment.message = ''
  store.maintenance.equipment.fieldPath = ''
}

async function save(): Promise<void> {
  if (!editor.value || parameterInvalid.value) return
  const record = { ...editor.value, modulation: editor.value.modulation?.trim() || null }
  if (await store.saveEquipment(record, creating.value)) {
    editor.value = null
    ElMessage.success(feedback.value.message)
    store.maintenance.equipment.message = ''
  }
}

async function toggleActive(row: EquipmentParameter): Promise<void> {
  if (pending.value || row.readOnly) return
  const active = row.active !== false
  if (await store.saveEquipment({ ...row, active: !active }, false)) {
    ElMessage.success(active ? '装备参数已停用。' : '装备参数已恢复启用。')
    store.maintenance.equipment.message = ''
  }
}

function band(row: EquipmentParameter): string {
  return row.frequencyMinMHz === null ? '暂无数据' : `${row.frequencyMinMHz}～${row.frequencyMaxMHz} MHz`
}

async function loadHistory(id: string): Promise<void> {
  historyPending.value = true
  history.value = await store.loadEquipmentHistory(id)
  historyPending.value = false
}

async function queryDeleted(): Promise<void> {
  if (!deletedQuery.value.trim()) return
  deletedPending.value = true
  deletedDetails.value = await store.loadEquipmentHistory(deletedQuery.value.trim())
  deletedPending.value = false
}

async function submitVerification(): Promise<void> {
  if (!viewing.value) return
  const saved = await store.recordEquipmentVerification(viewing.value.equipmentId, { ...verification.value })
  if (saved) {
    ElMessage.success('核验依据已保存。')
    verification.value = { coveredTargets: '', evidenceSummary: '', conclusion: '' }
    await loadHistory(viewing.value.equipmentId)
  }
}

function openRecreate(details: EquipmentHistoryDetails): void {
  const latest = details.history[0]
  recreateId.value = details.equipmentId
  recreate.value = {
    expectedHistoryVersion: Math.max(0, ...details.history.map(row => row.version)),
    type: latest?.type ?? '', frequencyMinMHz: latest?.frequencyMinMHz ?? null, frequencyMaxMHz: latest?.frequencyMaxMHz ?? null,
    modulation: latest?.modulation ?? null, berThreshold: latest?.berThreshold ?? null,
    bandwidthMHz: latest?.bandwidthMHz ?? null, txPowerW: latest?.txPowerW ?? null, dataRateMbps: latest?.dataRateMbps ?? null,
  }
}

async function submitRecreate(): Promise<void> {
  if (!recreate.value) return
  const { expectedHistoryVersion, ...parameters } = recreate.value
  recreating.value = true
  const saved = await store.recreateEquipment(recreateId.value, { expectedHistoryVersion, parameters })
  recreating.value = false
  if (saved) {
    ElMessage.success(`装备已重建为版本 ${saved.version}。`)
    recreate.value = null
    deletedDetails.value = null
    await store.loadMaintenance('equipment')
  }
}

onMounted(() => { void store.loadMaintenance('equipment') })
onBeforeUnmount(() => store.resetMaintenance())
</script>

<template>
  <section class="param-db-card" data-testid="equipment-library" aria-label="装备参数库">
    <div class="equipment-toolbar">
      <el-form inline class="equipment-filters" aria-label="装备筛选">
        <el-form-item label="关键字"><el-input v-model="query" clearable placeholder="编号、类型、调制" data-testid="equipment-query" /></el-form-item>
        <el-form-item label="类型"><el-select v-model="selectedType" clearable placeholder="全部类型"><el-option v-for="type in types" :key="type" :value="type" :label="type" /></el-select></el-form-item>
        <el-form-item label="频段包含（MHz）"><el-input-number v-model="frequency" :min="0" data-testid="equipment-band-filter" /></el-form-item>
      </el-form>
      <header class="card-header">
        <el-button :disabled="pending" @click="store.loadMaintenance('equipment')">刷新</el-button>
        <el-button type="primary" :disabled="pending" data-testid="equipment-create" @click="edit()">新增装备</el-button>
      </header>
    </div>
    <el-table v-loading="pending" :data="filtered" row-key="equipmentId" border empty-text="暂无数据" data-testid="equipment-table">
      <el-table-column prop="equipmentId" label="编号" min-width="130" />
      <el-table-column prop="type" label="类型" min-width="130" />
      <el-table-column label="默认频段" min-width="150"><template #default="{ row }">{{ band(row) }}</template></el-table-column>
      <el-table-column label="调制方式"><template #default="{ row }">{{ row.modulation ?? '暂无数据' }}</template></el-table-column>
      <el-table-column label="发射带宽（MHz）" min-width="120"><template #default="{ row }">{{ row.bandwidthMHz ?? '暂无数据' }}</template></el-table-column>
      <el-table-column label="发射功率（W）" min-width="110"><template #default="{ row }">{{ row.txPowerW ?? '暂无数据' }}</template></el-table-column>
      <el-table-column label="数据速率" min-width="120"><template #default="{ row }">{{ row.dataRateMbps == null ? '暂无数据' : formatDataRate(row.dataRateMbps) }}</template></el-table-column>
      <el-table-column label="误码率阈值" min-width="140"><template #default="{ row }">{{ row.berThreshold ?? '暂无数据' }}</template></el-table-column>
      <el-table-column prop="version" label="版本" width="75" />
      <el-table-column label="状态" width="85"><template #default="{ row }">{{ row.active === false ? '已停用' : '已启用' }}</template></el-table-column>
      <el-table-column label="只读" width="75"><template #default="{ row }">{{ row.readOnly ? '是' : '否' }}</template></el-table-column>
      <el-table-column label="操作" width="250"><template #default="{ row }">
        <el-button link @click="viewing = { ...row }">查看</el-button>
        <el-button link :disabled="pending || row.readOnly" @click="edit(row)">编辑</el-button>
        <el-button link :disabled="pending || row.readOnly" @click="toggleActive(row)">{{ row.active === false ? '恢复' : '停用' }}</el-button>
        <el-button link type="danger" :disabled="pending || confirming || row.readOnly" @click="remove(row)">删除</el-button>
      </template></el-table-column>
    </el-table>
    <p class="equipment-note">保存后会更新引用该装备的场景参数，留空不覆盖原值，也不会自动改选频率。场景锁定或参数不符合要求时不会保存，历史归档不受影响。</p>
    <div class="equipment-history-query" data-testid="equipment-history-query">
      <el-input v-model="deletedQuery" placeholder="输入装备编号查询历史/已删除记录" style="width: 280px" data-testid="equipment-deleted-query" />
      <el-button :loading="deletedPending" data-testid="equipment-deleted-search" @click="queryDeleted">查询历史/已删除</el-button>
    </div>
    <el-dialog :model-value="viewing !== null" title="查看参数详情" width="min(900px, calc(100vw - 32px))" @close="viewing = null">
      <el-descriptions v-if="viewing" :column="1" border>
        <el-descriptions-item label="编号">{{ viewing.equipmentId }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ viewing.type }}</el-descriptions-item>
        <el-descriptions-item label="默认频段">{{ band(viewing) }}</el-descriptions-item>
        <el-descriptions-item label="调制方式">{{ viewing.modulation ?? '暂无数据' }}</el-descriptions-item>
        <el-descriptions-item label="发射带宽（MHz）">{{ viewing.bandwidthMHz ?? '暂无数据' }}</el-descriptions-item>
        <el-descriptions-item label="发射功率（W）">{{ viewing.txPowerW ?? '暂无数据' }}</el-descriptions-item>
        <el-descriptions-item label="数据速率">{{ viewing.dataRateMbps == null ? '暂无数据' : formatDataRate(viewing.dataRateMbps) }}</el-descriptions-item>
        <el-descriptions-item label="误码率阈值">{{ viewing.berThreshold ?? '暂无数据' }}</el-descriptions-item>
        <el-descriptions-item label="版本">{{ viewing.version }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ viewing.active === false ? '已停用' : '已启用' }}</el-descriptions-item>
        <el-descriptions-item label="只读">{{ viewing.readOnly ? '是' : '否' }}</el-descriptions-item>
      </el-descriptions>
      <EquipmentRelations v-if="viewing" :equipment="viewing" />
      <div v-if="viewing" class="equipment-history" data-testid="equipment-history">
        <el-button :loading="historyPending" data-testid="equipment-history-load" @click="loadHistory(viewing.equipmentId)">加载历史与核验</el-button>
        <template v-if="history">
          <el-alert v-if="history.pendingVerification" type="warning" :closable="false" title="历史引用待核验：禁止删除、允许停用；需提交有效核验依据且最新引用复检为零后才解锁。" />
          <el-descriptions v-if="history.verification" :column="1" border>
            <el-descriptions-item label="核验覆盖">{{ history.verification.coveredTargets }}</el-descriptions-item>
            <el-descriptions-item label="核验依据">{{ history.verification.evidenceSummary }}</el-descriptions-item>
            <el-descriptions-item label="核验结论">{{ history.verification.conclusion }}</el-descriptions-item>
            <el-descriptions-item label="核验人/时间">{{ history.verification.operator }} · {{ history.verification.verifiedAt }}</el-descriptions-item>
          </el-descriptions>
          <h4>发布引用（历史）</h4>
          <el-table :data="history.publishedReferences" size="small" empty-text="暂无数据">
            <el-table-column prop="targetType" label="目标类型" /><el-table-column prop="targetId" label="目标" />
            <el-table-column prop="targetVersion" label="目标版本" /><el-table-column prop="equipmentVersion" label="设备版本" />
            <el-table-column prop="sourceSummary" label="来源摘要" min-width="180" />
          </el-table>
          <h4>删除/重建事件</h4>
          <el-table :data="history.lifecycle" size="small" empty-text="暂无数据">
            <el-table-column prop="eventType" label="事件" /><el-table-column prop="version" label="版本" />
            <el-table-column prop="operator" label="操作者" /><el-table-column prop="occurredAt" label="时间" min-width="180" />
          </el-table>
          <el-form v-if="history.pendingVerification" inline aria-label="提交核验依据">
            <el-form-item label="覆盖目标"><el-input v-model="verification.coveredTargets" data-testid="equipment-verify-targets" /></el-form-item>
            <el-form-item label="依据摘要"><el-input v-model="verification.evidenceSummary" data-testid="equipment-verify-evidence" /></el-form-item>
            <el-form-item label="结论"><el-input v-model="verification.conclusion" data-testid="equipment-verify-conclusion" /></el-form-item>
            <el-button data-testid="equipment-verify-submit" @click="submitVerification">提交核验</el-button>
          </el-form>
        </template>
      </div>
      <template #footer><el-button @click="viewing = null">关闭</el-button></template>
    </el-dialog>
    <el-dialog :model-value="editor !== null" :title="creating ? '新增装备参数' : '编辑装备参数'" width="min(760px, calc(100vw - 32px))" top="5vh" :close-on-click-modal="false" :close-on-press-escape="!pending" :show-close="!pending" @close="editor = null">
      <el-form v-if="editor" class="equipment-editor" label-position="top" @submit.prevent="save">
        <p class="equipment-editor__hint">带 * 的字段为必填项，其余参数可留空。</p>
        <section class="equipment-editor__section" aria-labelledby="equipment-basic-title">
          <h3 id="equipment-basic-title">基本信息</h3>
          <div class="equipment-editor__grid">
            <el-form-item label="编号" required><el-input v-model="editor.equipmentId" :disabled="!creating || pending" placeholder="请输入装备编号" data-testid="equipment-id" maxlength="64" /></el-form-item>
            <el-form-item label="类型" required>
              <el-select :model-value="editor.type" :disabled="pending" clearable placeholder="请选择装备类型" data-testid="equipment-type" @update:model-value="editor.type = $event || ''">
                <el-option v-if="editor.type && !equipmentTypes.some(type => type === editor?.type)" :value="editor.type" :label="`${editor.type}（原有类型）`" disabled />
                <el-option v-for="type in equipmentTypes" :key="type" :value="type" :label="type" />
              </el-select>
            </el-form-item>
          </div>
        </section>
        <section class="equipment-editor__section" aria-labelledby="equipment-communication-title">
          <h3 id="equipment-communication-title">通信参数</h3>
          <div class="equipment-editor__grid">
            <el-form-item label="频率下限（MHz）" :error="parameterIssues.frequencyMinMHz"><el-input-number :model-value="editor.frequencyMinMHz" :disabled="pending" controls-position="right" placeholder="未配置" data-testid="equipment-frequency-min" @update:model-value="editor.frequencyMinMHz = $event ?? null" /></el-form-item>
            <el-form-item label="频率上限（MHz）" :error="parameterIssues.frequencyMaxMHz"><el-input-number :model-value="editor.frequencyMaxMHz" :disabled="pending" controls-position="right" placeholder="未配置" data-testid="equipment-frequency-max" @update:model-value="editor.frequencyMaxMHz = $event ?? null" /></el-form-item>
            <el-form-item :label="EQUIPMENT_LINK_TYPES[editor.type] === 'LASER' ? '光调制方式' : '调制方式'" :error="modulationError">
              <el-select :model-value="editor.modulation" :disabled="pending" clearable placeholder="未配置" data-testid="equipment-modulation" @update:model-value="editor.modulation = $event || null">
                <el-option v-if="editor.modulation && !modulationOptions.includes(editor.modulation)" :label="`${editor.modulation}（原有值）`" :value="editor.modulation" disabled />
                <el-option v-for="value in modulationOptions" :key="value" :label="value" :value="value" />
              </el-select>
            </el-form-item>
            <el-form-item label="发射带宽（MHz）" :error="parameterIssues.bandwidthMHz"><el-input-number :model-value="editor.bandwidthMHz ?? null" :disabled="pending" controls-position="right" placeholder="未配置" data-testid="equipment-bandwidth" @update:model-value="editor.bandwidthMHz = $event ?? null" /></el-form-item>
            <el-form-item :label="EQUIPMENT_LINK_TYPES[editor.type] === 'LASER' ? '激光光功率（W）' : '发射功率（W）'" :error="parameterIssues.txPowerW"><el-input-number :model-value="editor.txPowerW ?? null" :disabled="pending" controls-position="right" placeholder="未配置" data-testid="equipment-power" @update:model-value="editor.txPowerW = $event ?? null" /></el-form-item>
            <el-form-item :label="dataRateOptions ? '数据速率' : '数据速率（Mbps）'" :error="dataRateError">
              <el-select v-if="dataRateOptions" :model-value="editor.dataRateMbps ?? null" :disabled="pending" clearable placeholder="未配置" data-testid="equipment-data-rate" @update:model-value="editor.dataRateMbps = $event ?? null">
                <el-option v-if="editor.dataRateMbps != null && !dataRateOptions.some(option => option.value === editor?.dataRateMbps)" :value="editor.dataRateMbps" :label="`${formatDataRate(editor.dataRateMbps)}（不适用，请重新选择）`" disabled />
                <el-option v-for="option in dataRateOptions" :key="option.value" :value="option.value" :label="option.label" />
              </el-select>
              <el-input-number v-else :model-value="editor.dataRateMbps ?? null" :disabled="pending" controls-position="right" placeholder="未配置" data-testid="equipment-data-rate" @update:model-value="editor.dataRateMbps = $event ?? null" />
              <small v-if="EQUIPMENT_LINK_TYPES[editor.type] === 'MICROWAVE'">仅支持所列固定速率，未配置可留空。</small>
              <small v-else-if="EQUIPMENT_LINK_TYPES[editor.type] === 'SAT'">按天通／神通选择，引用时与实际卫星核对。</small>
              <small v-else-if="EQUIPMENT_LINK_TYPES[editor.type] === 'DATALINK'">档位标明适用波段与方向，引用时按实际链路核对。</small>
              <small v-else-if="EQUIPMENT_LINK_TYPES[editor.type] === 'FIBER'">{{ FIBER_DATA_RATE_MBPS.min }}～{{ FIBER_DATA_RATE_MBPS.max }} Mbps。</small>
              <small v-else-if="EQUIPMENT_LINK_TYPES[editor.type] === 'LASER'">大于 0 Mbps，与激光链路介质传输速率一致。</small>
            </el-form-item>
          </div>
        </section>
        <section class="equipment-editor__section" aria-labelledby="equipment-quality-title">
          <h3 id="equipment-quality-title">质量阈值</h3>
          <div class="equipment-editor__grid">
            <el-form-item label="误码率阈值" :error="parameterIssues.berThreshold"><el-input-number :model-value="editor.berThreshold" :disabled="pending" :step="0.000001" controls-position="right" placeholder="未配置" data-testid="equipment-threshold" @update:model-value="editor.berThreshold = $event ?? null" /></el-form-item>
          </div>
        </section>
        <el-alert v-if="feedback.state === 'ERROR' && feedback.message" :title="`${feedback.message}${feedback.fieldPath ? `（${feedback.fieldPath}）` : ''}`" type="error" :closable="false" />
      </el-form>
      <template #footer><el-button :disabled="pending" @click="editor = null">取消</el-button><el-button type="primary" :loading="pending" :disabled="parameterInvalid" data-testid="equipment-save" @click="save">保存</el-button></template>
    </el-dialog>
    <el-dialog :model-value="deletedDetails !== null" title="装备历史与已删除查询" width="min(920px, calc(100vw - 32px))" @close="deletedDetails = null">
      <template v-if="deletedDetails">
        <el-alert v-if="deletedDetails.deleted" type="info" :closable="false" title="该装备当前记录已删除，以下为只读参数历史与生命周期事件；不会出现在可选设备列表。" />
        <el-alert v-if="deletedDetails.pendingVerification" type="warning" :closable="false" title="历史引用待核验：禁止删除、允许停用。" />
        <h4>参数历史</h4>
        <el-table :data="deletedDetails.history" size="small" empty-text="暂无数据">
          <el-table-column prop="version" label="版本" /><el-table-column prop="type" label="类型" />
          <el-table-column label="频段（MHz）"><template #default="{ row }">{{ row.frequencyMinMHz === null ? '暂无数据' : `${row.frequencyMinMHz}～${row.frequencyMaxMHz}` }}</template></el-table-column>
        </el-table>
        <h4>发布引用（历史）</h4>
        <el-table :data="deletedDetails.publishedReferences" size="small" empty-text="暂无数据">
          <el-table-column prop="targetType" label="目标类型" /><el-table-column prop="targetId" label="目标" /><el-table-column prop="targetVersion" label="目标版本" />
        </el-table>
        <h4>删除/重建事件</h4>
        <el-table :data="deletedDetails.lifecycle" size="small" empty-text="暂无数据">
          <el-table-column prop="eventType" label="事件" /><el-table-column prop="version" label="版本" /><el-table-column prop="operator" label="操作者" />
        </el-table>
      </template>
      <template #footer>
        <el-button v-if="deletedDetails && deletedDetails.deleted && deletedDetails.history.length" data-testid="equipment-recreate-open" @click="openRecreate(deletedDetails)">重建为下一版本</el-button>
        <el-button @click="deletedDetails = null">关闭</el-button>
      </template>
    </el-dialog>
    <el-dialog :model-value="recreate !== null" title="重建装备" width="min(760px, calc(100vw - 32px))" @close="recreate = null">
      <el-form v-if="recreate" class="equipment-editor" label-position="top">
        <p class="equipment-editor__hint">重建后生成新版本，不恢复旧引用，也不会解除待核验。</p>
        <el-form-item label="最新历史版本"><el-input-number :model-value="recreate.expectedHistoryVersion" disabled data-testid="equipment-recreate-expected" /></el-form-item>
        <el-form-item label="类型"><el-input v-model="recreate.type" data-testid="equipment-recreate-type" /></el-form-item>
        <el-form-item label="频率下限（MHz）"><el-input-number :model-value="recreate.frequencyMinMHz ?? null" controls-position="right" @update:model-value="recreate.frequencyMinMHz = $event ?? null" /></el-form-item>
        <el-form-item label="频率上限（MHz）"><el-input-number :model-value="recreate.frequencyMaxMHz ?? null" controls-position="right" @update:model-value="recreate.frequencyMaxMHz = $event ?? null" /></el-form-item>
        <el-form-item label="调制方式"><el-input :model-value="recreate.modulation ?? ''" @update:model-value="recreate.modulation = $event || null" /></el-form-item>
        <el-form-item label="误码率阈值"><el-input-number :model-value="recreate.berThreshold ?? null" :step="0.000001" controls-position="right" @update:model-value="recreate.berThreshold = $event ?? null" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="recreate = null">取消</el-button><el-button type="primary" :loading="recreating" data-testid="equipment-recreate-submit" @click="submitRecreate">重建</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.param-db-card { border: 1px solid var(--el-border-color); border-radius: 8px; padding: 16px; }
.equipment-toolbar { display: flex; align-items: center; gap: 20px; margin-bottom: 16px; }
.equipment-filters { display: flex; align-items: center; gap: 20px; flex: 1; min-width: 0; max-width: 850px; }
.equipment-filters :deep(.el-form-item) { flex: 1; min-width: 0; margin: 0; }
.equipment-filters :deep(.el-form-item__content) { min-width: 0; }
.equipment-filters :deep(.el-select), .equipment-filters :deep(.el-input-number) { width: 100%; }
.card-header { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-left: auto; flex-shrink: 0; }
.card-header h3 { margin: 0 auto 0 0; font-size: 18px; font-weight: 500; }
.equipment-note { color: var(--el-text-color-secondary); font-size: 13px; }
.equipment-editor {
  max-height: calc(90dvh - 150px);
  overflow-y: auto;
  padding: 0 8px 2px 0;
}
.equipment-editor__hint {
  margin: 0 0 16px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.equipment-editor__section + .equipment-editor__section {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--el-border-color-light);
}
.equipment-editor__section h3 {
  margin: 0 0 12px;
  color: var(--el-text-color-primary);
  font-size: 14px;
  font-weight: 600;
}
.equipment-editor__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 24px;
}
.equipment-editor :deep(.el-form-item) { margin-bottom: 0; }
.equipment-editor :deep(.el-input-number) { width: 100%; }
.equipment-editor :deep(.el-input__inner) { text-align: left; }
.equipment-editor :deep(.el-alert) { margin-top: 16px; }
@media (max-width: 600px) {
  .equipment-editor__grid { grid-template-columns: minmax(0, 1fr); }
}
</style>

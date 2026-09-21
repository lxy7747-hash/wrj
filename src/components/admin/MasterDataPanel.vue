<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { MasterData, MasterDataContent, MasterDataEntry, MasterDataReference, MasterDataTarget } from '../../contracts/domain-models'
import { MASTER_DATA_KINDS } from '../../features/admin/admin-contract'
import { useAdminStore } from '../../stores/admin'
import DataExchangeStateTag from '../data-exchange/DataExchangeStateTag.vue'

type EditableMasterData = MasterData & { content: MasterDataContent }
const WRITABLE_KINDS = ['COMMUNICATION_SYSTEM', 'PARAMETER_DICTIONARY', 'ENUMERATION'] as const
const VALUE_TYPES = ['TEXT', 'NUMBER', 'BOOLEAN'] as const
const store = useAdminStore()
const query = ref('')
const kind = ref('')
const editor = ref<EditableMasterData | null>(null)
const creating = ref(false)
const detailsOpen = ref(false)
const selectedVersion = ref(1)
const selectedTargetKey = ref('')
const feedback = computed(() => store.maintenance.master)
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(feedback.value.state))
const detailsPending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(store.masterDetailsState))
const rows = computed(() => store.masterData.filter((item) => (!kind.value || item.kind === kind.value)
  && `${item.dataId} ${item.content?.name ?? ''} ${MASTER_DATA_KINDS[item.kind] ?? item.kind}`.toLowerCase().includes(query.value.trim().toLowerCase())))
const details = computed(() => store.masterDetails)
const selectedTarget = computed(() => store.masterTargets.find((target) => targetKey(target) === selectedTargetKey.value))
const selectedHistory = computed(() => details.value?.history.find((item) => item.version === selectedVersion.value))
const canRegisterReference = computed(() => selectedTarget.value !== undefined && selectedHistory.value?.active === true && details.value?.history[0]?.active === true)

function emptyContent(): MasterDataContent { return { name: '', description: '', entries: [] } }
function emptyEntry(): MasterDataEntry { return { key: '', valueType: 'TEXT', value: '' } }
function targetKey(target: MasterDataTarget): string { return `${target.targetType}:${target.targetId}:${target.targetVersion}` }

/** 深拷贝编辑副本，旧版仅元数据记录不会在打开弹框时被静默补齐内容。 */
function edit(row?: MasterData): void {
  creating.value = row === undefined
  const source = row === undefined ? undefined : toRaw(row)
  editor.value = source
    ? { ...structuredClone(source), content: source.content ? structuredClone(toRaw(source.content)) : emptyContent() }
    : { dataId: '', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true, content: emptyContent() }
}
function addEntry(): void { editor.value?.content.entries.push(emptyEntry()) }
function removeEntry(index: number): void { editor.value?.content.entries.splice(index, 1) }
function changeValueType(entry: MasterDataEntry, valueType: MasterDataEntry['valueType']): void {
  entry.valueType = valueType
  entry.value = valueType === 'TEXT' ? '' : valueType === 'NUMBER' ? 0 : false
  delete entry.unit
  delete entry.minimum
  delete entry.maximum
}
function setTextValue(entry: MasterDataEntry, value: string): void { entry.value = value }
function setNumberValue(entry: MasterDataEntry, value: number | undefined): void { entry.value = value ?? Number.NaN }

async function save(): Promise<void> {
  if (editor.value && await store.saveMasterData({ ...editor.value, dataId: editor.value.dataId.trim(), kind: editor.value.kind.trim() }, creating.value)) {
    editor.value = null
    showSuccessMessage()
  }
}
function showSuccessMessage(): void {
  if (!feedback.value.message) return
  ElMessage.success(feedback.value.message)
  store.maintenance.master.message = ''
}
async function remove(row: MasterData): Promise<void> {
  const epoch = store.maintenanceEpoch
  try {
    await ElMessageBox.confirm(`确认删除“${row.dataId}”？已有引用的数据不能删除。`, '删除主数据', { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' })
    if (epoch === store.maintenanceEpoch && await store.runMaintenanceAction('DELETE', row.dataId)) showSuccessMessage()
  } catch { /* 取消确认时不提交请求。 */ }
}
async function openDetails(row: MasterData): Promise<void> {
  detailsOpen.value = true
  selectedVersion.value = row.version
  selectedTargetKey.value = ''
  await store.loadMasterDetails(row.dataId)
}
function closeDetails(): void { detailsOpen.value = false; store.clearMasterDetails() }
async function registerReference(): Promise<void> {
  const target = selectedTarget.value
  const current = details.value
  const history = selectedHistory.value
  if (!target || !current || !history || !canRegisterReference.value) return
  const reference: MasterDataReference = { dataId: current.dataId, dataVersion: selectedVersion.value, targetType: target.targetType, targetId: target.targetId, targetVersion: target.targetVersion }
  const epoch = store.masterDetailsEpoch
  try {
    await ElMessageBox.confirm('确认登记此主数据版本与目标版本的历史引用？该登记不会自动应用参数，历史关系不会自动解除。', '登记主数据引用', { confirmButtonText: '确认登记', cancelButtonText: '取消', type: 'warning' })
  } catch { return }
  if (epoch !== store.masterDetailsEpoch) return
  if (await store.registerMasterReference(reference)) {
    ElMessage.success('已登记历史引用关系，参数不会自动应用到目标。')
    selectedTargetKey.value = ''
    store.masterDetailsMessage = ''
  }
}
onMounted(() => { void store.loadMaintenance('master') })
onBeforeUnmount(() => { store.clearMasterDetails(); store.resetMaintenance() })
</script>

<template>
  <section id="cap-jcsj" class="maintenance-card" aria-label="主数据管理" data-testid="master-data-panel">
    <header class="maintenance-toolbar">
      <h3>主数据管理</h3>
      <DataExchangeStateTag :state="feedback.state" />
      <el-button :disabled="pending" @click="store.loadMaintenance('master')">刷新</el-button>
      <el-button type="primary" :disabled="pending" data-testid="master-create" @click="edit()">新增主数据</el-button>
    </header>
    <el-form inline class="maintenance-toolbar" @submit.prevent>
      <el-form-item label="检索"><el-input v-model="query" clearable placeholder="编号、名称或类型" aria-label="主数据检索" /></el-form-item>
      <el-form-item label="类型"><el-select v-model="kind" style="width: 160px" aria-label="主数据类型筛选"><el-option label="全部类型" value="" /><el-option v-for="(label, value) in MASTER_DATA_KINDS" :key="value" :label="label" :value="value" /></el-select></el-form-item>
    </el-form>
    <el-alert v-if="feedback.message" :title="feedback.message" :type="feedback.state === 'ERROR' ? 'error' : 'info'" :closable="false" data-testid="master-feedback" />
    <el-table v-loading="pending" :data="rows" row-key="dataId" stripe empty-text="暂无匹配的主数据" data-testid="master-table">
      <el-table-column prop="dataId" label="编号" min-width="140" />
      <el-table-column label="名称" min-width="150"><template #default="{ row }">{{ row.content?.name ?? '旧版记录（仅元数据）' }}</template></el-table-column>
      <el-table-column label="类型" min-width="130"><template #default="{ row }">{{ MASTER_DATA_KINDS[row.kind] ?? row.kind }}</template></el-table-column>
      <el-table-column prop="version" label="版本" width="80" />
      <el-table-column prop="referenceCount" label="引用数量" width="100" />
      <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.active ? 'success' : 'info'">{{ row.active ? '启用' : '停用' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="190" fixed="right"><template #default="{ row }">
        <el-button link type="primary" :disabled="pending" @click="openDetails(row)">查看</el-button>
        <el-button link type="primary" :disabled="pending" @click="edit(row)">编辑</el-button>
        <el-button link type="danger" :disabled="pending" @click="remove(row)">删除</el-button>
      </template></el-table-column>
    </el-table>
    <p class="maintenance-note">主数据保存实际内容和版本；引用数量由服务端根据已登记的历史关系维护。装备具体参数请在“装备参数库”维护。</p>

    <el-dialog :model-value="editor !== null" :title="creating ? '新增主数据' : '编辑主数据'" width="min(720px, 94vw)" :close-on-click-modal="false" @close="editor = null">
      <el-form v-if="editor" label-position="top" @submit.prevent="save">
        <el-alert v-if="editor.kind === 'DEVICE'" type="warning" title="旧版设备主数据只保留读取兼容；新的装备参数请在装备参数库维护。" :closable="false" />
        <el-form-item label="编号" required><el-input v-model="editor.dataId" :disabled="!creating || pending" data-testid="master-id" /></el-form-item>
        <el-form-item label="类型" required><el-select v-model="editor.kind" :disabled="pending || editor.kind === 'DEVICE'" aria-label="编辑主数据类型"><el-option v-for="value in WRITABLE_KINDS" :key="value" :label="MASTER_DATA_KINDS[value]" :value="value" /></el-select></el-form-item>
        <el-form-item label="名称" required><el-input v-model="editor.content.name" :disabled="pending || editor.kind === 'DEVICE'" maxlength="80" show-word-limit data-testid="master-name" /></el-form-item>
        <el-form-item label="说明"><el-input v-model="editor.content.description" type="textarea" :rows="2" :disabled="pending || editor.kind === 'DEVICE'" maxlength="1000" show-word-limit /></el-form-item>
        <el-form-item label="状态"><el-switch v-model="editor.active" active-text="启用" inactive-text="停用" :disabled="pending || editor.kind === 'DEVICE'" /></el-form-item>
        <el-descriptions :column="2"><el-descriptions-item label="当前版本">{{ editor.version }}</el-descriptions-item><el-descriptions-item label="引用数量">{{ editor.referenceCount }}</el-descriptions-item></el-descriptions>
        <section class="master-entries" aria-label="主数据参数条目">
          <header><strong>参数条目</strong><el-button link type="primary" :disabled="pending || editor.kind === 'DEVICE'" @click="addEntry">新增条目</el-button></header>
          <el-empty v-if="editor.content.entries.length === 0" description="请添加至少一项真实参数" :image-size="52" />
          <article v-for="(entry, index) in editor.content.entries" :key="index" class="master-entry">
            <el-input v-model="entry.key" placeholder="参数键，如 frequencyMHz" aria-label="参数键" :disabled="pending || editor.kind === 'DEVICE'" />
            <el-select :model-value="entry.valueType" aria-label="参数值类型" :disabled="pending || editor.kind === 'DEVICE'" @update:model-value="changeValueType(entry, $event)"><el-option v-for="valueType in VALUE_TYPES" :key="valueType" :label="valueType" :value="valueType" /></el-select>
            <el-input v-if="entry.valueType === 'TEXT'" :model-value="String(entry.value)" placeholder="文本值" :disabled="pending || editor.kind === 'DEVICE'" @update:model-value="setTextValue(entry, $event)" />
            <el-input-number v-else-if="entry.valueType === 'NUMBER'" :model-value="typeof entry.value === 'number' ? entry.value : undefined" :disabled="pending || editor.kind === 'DEVICE'" controls-position="right" @update:model-value="setNumberValue(entry, $event)" />
            <el-switch v-else v-model="entry.value" active-text="是" inactive-text="否" :disabled="pending || editor.kind === 'DEVICE'" />
            <template v-if="entry.valueType === 'NUMBER'">
              <el-input v-model="entry.unit" placeholder="单位（可选）" :disabled="pending || editor.kind === 'DEVICE'" />
              <el-input-number v-model="entry.minimum" placeholder="最小值" :disabled="pending || editor.kind === 'DEVICE'" controls-position="right" />
              <el-input-number v-model="entry.maximum" placeholder="最大值" :disabled="pending || editor.kind === 'DEVICE'" controls-position="right" />
            </template>
            <el-button link type="danger" :disabled="pending || editor.kind === 'DEVICE'" @click="removeEntry(index)">移除</el-button>
          </article>
        </section>
        <el-alert v-if="feedback.state === 'ERROR'" type="error" :title="feedback.message" :closable="false" />
      </el-form>
      <template #footer><el-button :disabled="pending" @click="editor = null">取消</el-button><el-button type="primary" :disabled="pending || editor?.kind === 'DEVICE'" :loading="pending" data-testid="master-save" @click="save">保存</el-button></template>
    </el-dialog>

    <el-dialog :model-value="detailsOpen" title="主数据版本与引用记录" width="min(760px, 94vw)" @close="closeDetails">
      <DataExchangeStateTag :state="store.masterDetailsState" />
      <el-alert v-if="store.masterDetailsMessage" :title="store.masterDetailsMessage" :type="store.masterDetailsState === 'ERROR' ? 'error' : 'info'" :closable="false" data-testid="master-details-feedback" />
      <template v-if="details">
        <el-descriptions :column="2" border><el-descriptions-item label="编号">{{ details.dataId }}</el-descriptions-item><el-descriptions-item label="历史版本">{{ details.history.length }}</el-descriptions-item></el-descriptions>
        <h4>版本历史</h4>
        <el-table :data="details.history" size="small" data-testid="master-history-table">
          <el-table-column type="expand"><template #default="{ row }"><el-descriptions :column="1" size="small" border><el-descriptions-item label="说明">{{ row.content?.description || '旧版记录未保存内容。' }}</el-descriptions-item><el-descriptions-item label="参数条目"><pre>{{ JSON.stringify(row.content?.entries ?? [], null, 2) }}</pre></el-descriptions-item></el-descriptions></template></el-table-column>
          <el-table-column prop="version" label="版本" width="90" /><el-table-column label="名称" min-width="160"><template #default="{ row }">{{ row.content?.name ?? '旧版记录（仅元数据）' }}</template></el-table-column><el-table-column prop="referenceCount" label="引用数量" width="100" /><el-table-column label="状态" width="80"><template #default="{ row }">{{ row.active ? '启用' : '停用' }}</template></el-table-column>
        </el-table>
        <h4>已登记引用</h4>
        <el-table :data="details.references" size="small" empty-text="暂无引用记录" data-testid="master-reference-table"><el-table-column prop="dataVersion" label="主数据版本" width="110" /><el-table-column prop="targetType" label="目标类型" width="100" /><el-table-column prop="targetId" label="目标编号" min-width="150" /><el-table-column prop="targetVersion" label="目标版本" width="100" /></el-table>
        <section class="master-reference-form" aria-label="登记主数据引用">
          <h4>登记版本引用</h4>
          <p>登记只保留“主数据版本—目标版本”的历史关系，不会自动应用参数；历史关系不会因目标后续变化而自动解除。</p>
          <el-select v-model="selectedVersion" aria-label="主数据版本" :disabled="detailsPending"><el-option v-for="item in details.history" :key="item.version" :disabled="!item.active" :label="`版本 ${item.version}${item.active ? '' : '（已停用）'}`" :value="item.version" /></el-select>
          <el-select v-model="selectedTargetKey" aria-label="引用目标" placeholder="选择实际场景或模板" :disabled="detailsPending || !details.history[0]?.active"><el-option v-for="target in store.masterTargets" :key="targetKey(target)" :label="`${target.targetType === 'SCENARIO' ? '场景' : '模板'} · ${target.name}（${target.targetId} / ${target.targetVersion}）`" :value="targetKey(target)" /></el-select>
          <el-button type="primary" :disabled="!canRegisterReference || detailsPending" @click="registerReference">登记引用</el-button>
        </section>
      </template>
      <template #footer><el-button @click="closeDetails">关闭</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.master-entries { display: grid; gap: 10px; margin-top: 12px; }
.master-entries > header, .master-reference-form { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.master-entries > header strong { margin-right: auto; }
.master-entry { display: grid; grid-template-columns: minmax(120px, 1.1fr) minmax(100px, .8fr) minmax(130px, 1fr) auto; gap: 8px; align-items: center; }
.master-reference-form { margin-top: 16px; align-items: end; }
.master-reference-form h4, .master-reference-form p { width: 100%; margin: 0; }
.master-reference-form p { color: var(--el-text-color-secondary); font-size: 13px; }
@media (max-width: 760px) { .master-entry { grid-template-columns: 1fr 1fr; } }
</style>

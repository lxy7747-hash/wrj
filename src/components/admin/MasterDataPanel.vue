<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { MasterData } from '../../contracts/domain-models'
import { MASTER_DATA_KINDS } from '../../features/admin/admin-contract'
import { useAdminStore } from '../../stores/admin'
import DataExchangeStateTag from '../data-exchange/DataExchangeStateTag.vue'

const store = useAdminStore()
const query = ref('')
const kind = ref('')
const editor = ref<MasterData | null>(null)
const creating = ref(false)
const feedback = computed(() => store.maintenance.master)
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(feedback.value.state))
const rows = computed(() => store.masterData.filter((item) => (!kind.value || item.kind === kind.value)
  && `${item.dataId} ${MASTER_DATA_KINDS[item.kind] ?? item.kind}`.toLowerCase().includes(query.value.trim().toLowerCase())))

/** 打开独立编辑副本；不传行时创建版本 1、零引用的数据。 */
function edit(row?: MasterData): void {
  creating.value = row === undefined
  editor.value = row ? { ...row } : { dataId: '', kind: 'DEVICE', version: 1, referenceCount: 0, active: true }
}

/** 保存当前副本，失败时保留表单和字段提示。 */
async function save(): Promise<void> {
  if (editor.value && await store.saveMasterData({ ...editor.value, dataId: editor.value.dataId.trim(), kind: editor.value.kind.trim() }, creating.value)) editor.value = null
}

/** 二次确认后删除所选数据；引用规则由服务端复验。 */
async function remove(row: MasterData): Promise<void> {
  const epoch = store.maintenanceEpoch
  try {
    await ElMessageBox.confirm(`确认删除“${row.dataId}”？已有引用的数据不能删除。`, '删除主数据', { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' })
    if (epoch === store.maintenanceEpoch) await store.runMaintenanceAction('DELETE', row.dataId)
  } catch { /* 取消确认时不提交请求。 */ }
}

onMounted(() => { void store.loadMaintenance('master') })
onBeforeUnmount(() => store.resetMaintenance())
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
      <el-form-item label="检索"><el-input v-model="query" clearable placeholder="编号或类型" aria-label="主数据检索" /></el-form-item>
      <el-form-item label="类型"><el-select v-model="kind" style="width: 160px" aria-label="主数据类型筛选"><el-option label="全部类型" value="" /><el-option v-for="(label, value) in MASTER_DATA_KINDS" :key="value" :label="label" :value="value" /></el-select></el-form-item>
    </el-form>
    <el-alert :title="feedback.message" :type="feedback.state === 'ERROR' ? 'error' : 'info'" :closable="false" data-testid="master-feedback" />
    <el-table v-loading="pending" :data="rows" row-key="dataId" stripe empty-text="暂无匹配的主数据" data-testid="master-table">
      <el-table-column prop="dataId" label="编号" min-width="140" />
      <el-table-column label="类型" min-width="130"><template #default="{ row }">{{ MASTER_DATA_KINDS[row.kind] ?? row.kind }}</template></el-table-column>
      <el-table-column prop="version" label="版本" width="80" />
      <el-table-column prop="referenceCount" label="引用数量" width="100" />
      <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.active ? 'success' : 'info'">{{ row.active ? '启用' : '停用' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }">
        <el-button link type="primary" :disabled="pending" @click="edit(row)">编辑</el-button>
        <el-button link type="danger" :disabled="pending" @click="remove(row)">删除</el-button>
      </template></el-table-column>
    </el-table>
    <p class="maintenance-note">引用数量由系统维护；每次更新递增版本，操作记录可在“操作审计日志”查看。</p>
    <el-dialog :model-value="editor !== null" :title="creating ? '新增主数据' : '编辑主数据'" width="min(520px, 94vw)" :close-on-click-modal="false" @close="editor = null">
      <el-form v-if="editor" label-position="top" @submit.prevent="save">
        <el-form-item label="编号" required><el-input v-model="editor.dataId" :disabled="!creating || pending" data-testid="master-id" /></el-form-item>
        <el-form-item label="类型" required><el-select v-model="editor.kind" filterable allow-create default-first-option :disabled="pending" aria-label="编辑主数据类型"><el-option v-for="(label, value) in MASTER_DATA_KINDS" :key="value" :label="label" :value="value" /></el-select></el-form-item>
        <el-form-item label="状态"><el-switch v-model="editor.active" active-text="启用" inactive-text="停用" :disabled="pending" /></el-form-item>
        <el-descriptions :column="2"><el-descriptions-item label="当前版本">{{ editor.version }}</el-descriptions-item><el-descriptions-item label="引用数量">{{ editor.referenceCount }}</el-descriptions-item></el-descriptions>
        <el-alert v-if="feedback.state === 'ERROR'" type="error" :title="feedback.message" :closable="false" />
      </el-form>
      <template #footer><el-button :disabled="pending" @click="editor = null">取消</el-button><el-button type="primary" :loading="pending" data-testid="master-save" @click="save">保存</el-button></template>
    </el-dialog>
  </section>
</template>

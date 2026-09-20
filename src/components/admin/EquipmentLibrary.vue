<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { EquipmentParameter } from '../../contracts/domain-models'
import { useAdminStore } from '../../stores/admin'

const store = useAdminStore()
const feedback = computed(() => store.maintenance.equipment)
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(feedback.value.state))
const editor = ref<EquipmentParameter | null>(null)
const viewing = ref<EquipmentParameter | null>(null)
const creating = ref(false)

function edit(row?: EquipmentParameter): void {
  if (row?.readOnly) return
  creating.value = !row
  editor.value = row ? { ...row } : { equipmentId: '', type: '', frequencyMinMHz: null,
    frequencyMaxMHz: null, modulation: null, berThreshold: null, readOnly: false, version: 1 }
  store.maintenance.equipment.message = ''
  store.maintenance.equipment.fieldPath = ''
}

async function save(): Promise<void> {
  if (!editor.value) return
  const record = { ...editor.value, modulation: editor.value.modulation?.trim() || null }
  if (await store.saveEquipment(record, creating.value)) {
    editor.value = null
    ElMessage.success(feedback.value.message)
    store.maintenance.equipment.message = ''
  }
}

function band(row: EquipmentParameter): string {
  return row.frequencyMinMHz === null ? '未配置' : `${row.frequencyMinMHz}～${row.frequencyMaxMHz} MHz`
}

onMounted(() => { void store.loadMaintenance('equipment') })
onBeforeUnmount(() => store.resetMaintenance())
</script>

<template>
  <section class="param-db-card" data-testid="equipment-library" aria-label="装备参数库">
    <header class="card-header">
      <h3>装备基础参数库</h3>
      <el-button :disabled="pending" @click="store.loadMaintenance('equipment')">刷新</el-button>
      <el-button type="primary" :disabled="pending" data-testid="equipment-create" @click="edit()">新增装备</el-button>
    </header>
    <el-alert v-if="feedback.message && editor === null" :title="feedback.message" :type="feedback.state === 'ERROR' ? 'error' : 'info'" :closable="false" data-testid="equipment-feedback" />
    <el-table v-loading="pending" :data="store.equipment" row-key="equipmentId" border empty-text="暂无装备参数，请由管理员新增。" data-testid="equipment-table">
      <el-table-column prop="equipmentId" label="编号" min-width="130" />
      <el-table-column prop="type" label="类型" min-width="130" />
      <el-table-column label="默认频段" min-width="150"><template #default="{ row }">{{ band(row) }}</template></el-table-column>
      <el-table-column label="默认调制"><template #default="{ row }">{{ row.modulation ?? '未配置' }}</template></el-table-column>
      <el-table-column label="失效阈值（BER）" min-width="140"><template #default="{ row }">{{ row.berThreshold ?? '未配置' }}</template></el-table-column>
      <el-table-column prop="version" label="版本" width="75" />
      <el-table-column label="只读" width="75"><template #default="{ row }">{{ row.readOnly ? '是' : '否' }}</template></el-table-column>
      <el-table-column label="操作" width="120"><template #default="{ row }">
        <el-button link @click="viewing = { ...row }">查看</el-button>
        <el-button link :disabled="pending || row.readOnly" @click="edit(row)">编辑</el-button>
      </template></el-table-column>
    </el-table>
    <p class="equipment-note">保存默认参数，不自动修改已创建场景。未配置的频段、调制或阈值请留空。</p>
    <el-dialog :model-value="viewing !== null" title="查看参数详情" width="520px" @close="viewing = null">
      <el-descriptions v-if="viewing" :column="1" border>
        <el-descriptions-item label="编号">{{ viewing.equipmentId }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ viewing.type }}</el-descriptions-item>
        <el-descriptions-item label="默认频段">{{ band(viewing) }}</el-descriptions-item>
        <el-descriptions-item label="默认调制">{{ viewing.modulation ?? '未配置' }}</el-descriptions-item>
        <el-descriptions-item label="失效阈值（BER）">{{ viewing.berThreshold ?? '未配置' }}</el-descriptions-item>
        <el-descriptions-item label="版本">{{ viewing.version }}</el-descriptions-item>
        <el-descriptions-item label="只读">{{ viewing.readOnly ? '是' : '否' }}</el-descriptions-item>
      </el-descriptions>
      <template #footer><el-button @click="viewing = null">关闭</el-button></template>
    </el-dialog>
    <el-dialog :model-value="editor !== null" :title="creating ? '新增装备参数' : '编辑装备参数'" width="560px" :close-on-click-modal="false" :close-on-press-escape="!pending" :show-close="!pending" @close="editor = null">
      <el-form v-if="editor" label-position="top" @submit.prevent="save">
        <el-form-item label="编号" required><el-input v-model="editor.equipmentId" :disabled="!creating || pending" data-testid="equipment-id" maxlength="64" /></el-form-item>
        <el-form-item label="类型" required><el-input v-model="editor.type" :disabled="pending" data-testid="equipment-type" maxlength="100" /></el-form-item>
        <el-form-item label="频率下限（MHz）"><el-input-number :model-value="editor.frequencyMinMHz" :disabled="pending" data-testid="equipment-frequency-min" @update:model-value="editor.frequencyMinMHz = $event ?? null" /></el-form-item>
        <el-form-item label="频率上限（MHz）"><el-input-number :model-value="editor.frequencyMaxMHz" :disabled="pending" data-testid="equipment-frequency-max" @update:model-value="editor.frequencyMaxMHz = $event ?? null" /></el-form-item>
        <el-form-item label="默认调制"><el-input v-model="editor.modulation" :disabled="pending" clearable data-testid="equipment-modulation" maxlength="32" /></el-form-item>
        <el-form-item label="失效阈值（BER）"><el-input-number :model-value="editor.berThreshold" :disabled="pending" :min="0" :max="1" :step="0.00001" data-testid="equipment-threshold" @update:model-value="editor.berThreshold = $event ?? null" /></el-form-item>
        <el-alert v-if="feedback.state === 'ERROR' && feedback.message" :title="`${feedback.message}${feedback.fieldPath ? `（${feedback.fieldPath}）` : ''}`" type="error" :closable="false" />
      </el-form>
      <template #footer><el-button :disabled="pending" @click="editor = null">取消</el-button><el-button type="primary" :loading="pending" data-testid="equipment-save" @click="save">保存</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.param-db-card { border: 1px solid var(--el-border-color); border-radius: 8px; padding: 16px; }
.card-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.card-header h3 { margin: 0 auto 0 0; font-size: 18px; font-weight: 500; }
.equipment-note { color: var(--el-text-color-secondary); font-size: 13px; }
</style>

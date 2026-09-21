<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { EquipmentDetails, EquipmentParameter, EquipmentReference } from '../../contracts/domain-models'
import { isEquipmentDetails } from '../../features/admin/equipment-contract'
import { apiFetch } from '../../features/shared/api-fetch'
import { useAuthStore } from '../../stores/auth'

const props = defineProps<{ equipment: EquipmentParameter }>()
const auth = useAuthStore()
const details = ref<EquipmentDetails | null>(null)
const pending = ref(false)
const error = ref('')
const sceneId = ref('')
const linkId = ref('')
let epoch = 0
let controller: AbortController | undefined
const origin = import.meta.env.VITE_MOCK_ORIGIN ?? 'http://127.0.0.1:4173'
async function request(reference?: EquipmentReference, remove = false): Promise<void> {
  controller?.abort()
  controller = new AbortController()
  const current = ++epoch
  const abort = controller
  const timer = setTimeout(() => abort.abort(), 10_000)
  pending.value = true
  error.value = ''
  details.value = null
  try {
    const response = await apiFetch(`${origin}/api/v1/admin/equipment/${encodeURIComponent(props.equipment.equipmentId)}/${reference ? 'reference' : 'details'}`, {
      signal: controller.signal, headers: { 'X-Demo-Role': auth.role, 'Content-Type': 'application/json' },
      ...(reference ? { method: 'PUT', body: JSON.stringify({ reference, remove }) } : {}),
    })
    const body = await response.json()
    if (current !== epoch) return
    if (!response.ok || body.ok !== true) throw new Error(body.error?.message ?? '装备引用与版本读取失败。')
    if (!isEquipmentDetails(body.data) || [...body.data.history, ...body.data.references].some(row => row.equipmentId !== props.equipment.equipmentId)) throw new Error('装备引用与版本响应不正确。')
    details.value = body.data
    if (reference) ElMessage.success(remove ? '引用已解除。' : '引用版本已登记；未修改场景参数。')
  } catch (reason) { if (current === epoch) error.value = reason instanceof Error ? reason.message : '读取失败，请重试。' }
  finally { clearTimeout(timer); if (current === epoch) pending.value = false }
}
function bind(): void {
  if (!sceneId.value.trim() || !linkId.value.trim()) { error.value = '请填写已有场景编号和链路编号。'; return }
  void request({ equipmentId: props.equipment.equipmentId, equipmentVersion: props.equipment.version, scenarioId: sceneId.value.trim(), linkId: linkId.value.trim() })
}
watch(() => props.equipment, () => { sceneId.value = ''; linkId.value = ''; void request() }, { immediate: true })
watch(() => auth.principal?.userId, () => { ++epoch; controller?.abort(); details.value = null; pending.value = false }, { flush: 'sync' })
onBeforeUnmount(() => { ++epoch; controller?.abort() })
</script>

<template>
  <section v-loading="pending" aria-label="装备引用与版本" data-testid="equipment-relations">
    <el-alert v-if="error" type="error" :title="error" :closable="false" />
    <el-button :disabled="pending" @click="request()">重新加载引用与版本</el-button>
    <h4>场景引用</h4>
    <el-table :data="details?.references ?? []" empty-text="暂无数据">
      <el-table-column prop="scenarioId" label="场景编号" /><el-table-column prop="linkId" label="链路编号" />
      <el-table-column prop="equipmentVersion" label="引用版本" />
      <el-table-column label="更新影响"><template #default="{ row }">{{ row.equipmentVersion === equipment.version ? '当前引用版本' : `保留旧引用 v${row.equipmentVersion}；下次保存装备时同步` }}</template></el-table-column>
      <el-table-column label="操作"><template #default="{ row }"><el-button link :disabled="pending" @click="request(row, true)">解除引用</el-button></template></el-table-column>
    </el-table>
    <el-form inline aria-label="登记装备引用">
      <el-form-item label="场景编号"><el-input v-model="sceneId" placeholder="已有场景编号" /></el-form-item>
      <el-form-item label="链路编号"><el-input v-model="linkId" placeholder="已有链路编号" /></el-form-item>
      <el-button :disabled="pending || equipment.readOnly" @click="bind">登记当前版本引用</el-button>
    </el-form>
    <p>登记本身不覆盖场景；之后保存装备会同步已登记链路与引用版本。有引用时不能删除装备，历史归档不变。</p>
    <h4>版本历史</h4>
    <el-table :data="details?.history ?? []" empty-text="暂无数据">
      <el-table-column prop="version" label="版本" /><el-table-column prop="type" label="类型" />
      <el-table-column label="频段（MHz）"><template #default="{ row }">{{ row.frequencyMinMHz === null ? '暂无数据' : `${row.frequencyMinMHz}～${row.frequencyMaxMHz}` }}</template></el-table-column>
      <el-table-column v-for="field in [{ key: 'bandwidthMHz', label: '带宽（MHz）' }, { key: 'txPowerW', label: '功率（W）' }, { key: 'dataRateMbps', label: '速率（Mbps）' }]" :key="field.key" :label="field.label"><template #default="{ row }">{{ row[field.key] ?? '暂无数据' }}</template></el-table-column>
    </el-table>
  </section>
</template>

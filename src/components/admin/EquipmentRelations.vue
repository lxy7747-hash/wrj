<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { EquipmentDetails, EquipmentParameter, EquipmentReference, ScenarioDraft } from '../../contracts/domain-models'
import { isEquipmentDetails } from '../../features/admin/equipment-contract'
import { formatDataRate } from '../../features/scenarios/link-calc-defaults'
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
/** 已保存场景，仅用于选择登记目标；读取失败时保留手工输入，不阻断引用查看。 */
const scenes = ref<ScenarioDraft[]>([])
const sceneLinks = computed(() => scenes.value.find(scene => scene.config.scenario.id === sceneId.value)?.config.links ?? [])
function inBand(frequency: number): boolean {
  const { frequencyMinMHz: min, frequencyMaxMHz: max } = props.equipment
  return min === null || max === null || (frequency >= min && frequency <= max)
}
async function loadScenes(): Promise<void> {
  try {
    const response = await apiFetch(`${origin}/api/v1/scenarios`, { headers: { 'X-Demo-Role': auth.role } })
    const body = await response.json()
    scenes.value = response.ok && body.ok === true && Array.isArray(body.data) ? body.data : []
  } catch { scenes.value = [] }
}
watch(sceneId, () => { if (!sceneLinks.value.some(link => link.id === linkId.value)) linkId.value = '' })
function bind(): void {
  if (props.equipment.active === false) { error.value = '装备已停用，不能登记新引用。'; return }
  if (!sceneId.value.trim() || !linkId.value.trim()) { error.value = '请填写已有场景编号和链路编号。'; return }
  void request({ equipmentId: props.equipment.equipmentId, equipmentVersion: props.equipment.version, scenarioId: sceneId.value.trim(), linkId: linkId.value.trim() })
}
watch(() => props.equipment, () => { sceneId.value = ''; linkId.value = ''; void request() }, { immediate: true })
void loadScenes()
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
      <template v-if="scenes.length">
        <el-form-item label="场景"><el-select v-model="sceneId" filterable placeholder="选择已保存场景" style="width: 220px" data-testid="reference-scene"><el-option v-for="scene in scenes" :key="scene.config.scenario.id" :value="scene.config.scenario.id" :label="`${scene.config.scenario.name}（${scene.config.scenario.id}）`" :disabled="scene.locked" /></el-select></el-form-item>
        <el-form-item label="链路"><el-select v-model="linkId" filterable :disabled="!sceneId" placeholder="选择场景中的链路" style="width: 260px" data-testid="reference-link"><el-option v-for="link in sceneLinks" :key="link.id" :value="link.id" :label="`${link.id}｜${link.type}｜${link.frequency} MHz${inBand(link.frequency) ? '' : '（频率不在装备范围）'}`" /></el-select></el-form-item>
      </template>
      <template v-else>
        <el-form-item label="场景编号"><el-input v-model="sceneId" placeholder="已有场景编号" /></el-form-item>
        <el-form-item label="链路编号"><el-input v-model="linkId" placeholder="已有链路编号" /></el-form-item>
      </template>
      <el-button :disabled="pending || equipment.readOnly || equipment.active === false" @click="bind">登记当前版本引用</el-button>
    </el-form>
    <p>选择使用该装备的场景链路并登记，即建立引用。登记本身不覆盖场景；之后保存参数会同步已登记链路与引用版本。停用装备保留既有引用和历史，但不能登记新引用；有引用时不能删除装备。</p>
    <h4>版本历史</h4>
    <el-table :data="details?.history ?? []" empty-text="暂无数据">
      <el-table-column prop="version" label="版本" /><el-table-column prop="type" label="类型" />
      <el-table-column label="频段（MHz）"><template #default="{ row }">{{ row.frequencyMinMHz === null ? '暂无数据' : `${row.frequencyMinMHz}～${row.frequencyMaxMHz}` }}</template></el-table-column>
      <el-table-column v-for="field in [{ key: 'bandwidthMHz', label: '发射带宽（MHz）' }, { key: 'txPowerW', label: '发射功率（W）' }, { key: 'dataRateMbps', label: '数据速率' }]" :key="field.key" :label="field.label"><template #default="{ row }">{{ row[field.key] == null ? '暂无数据' : field.key === 'dataRateMbps' ? formatDataRate(row[field.key]) : row[field.key] }}</template></el-table-column>
    </el-table>
  </section>
</template>

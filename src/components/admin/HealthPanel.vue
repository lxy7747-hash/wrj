<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAdminStore } from '../../stores/admin'
import DataExchangeStateTag from '../data-exchange/DataExchangeStateTag.vue'

const store = useAdminStore()
const status = ref('')
const feedback = computed(() => store.maintenance.health)
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(feedback.value.state))
const components = { ui: '前端界面', engine: '仿真引擎', database: '数据库', channel: '通信通道' }
const rows = computed(() => store.health === null ? [] : Object.entries(store.health).map(([key, value]) => ({
  name: components[key as keyof typeof components], state: value,
  label: value === 'HEALTHY' ? '正常' : '尚未接入',
})).filter((row) => !status.value || row.state === status.value))

onMounted(() => { void store.loadMaintenance('health') })
onBeforeUnmount(() => store.resetMaintenance())
</script>

<template>
  <section class="maintenance-card" aria-label="系统运行状态" data-testid="health-panel">
    <header class="maintenance-toolbar"><h3>系统运行状态</h3><DataExchangeStateTag :state="feedback.state" /><el-button :disabled="pending" @click="store.loadMaintenance('health')">刷新状态</el-button></header>
    <p class="maintenance-note">引擎、数据库与通信通道的实际运行状态将在接入后提供。</p>
    <el-form inline><el-form-item label="状态"><el-select v-model="status" style="width: 180px" aria-label="运行状态筛选"><el-option label="全部状态" value="" /><el-option label="正常" value="HEALTHY" /><el-option label="尚未接入" value="NOT_CONNECTED_BY_DESIGN" /></el-select></el-form-item></el-form>
    <el-alert :title="feedback.message" :type="feedback.state === 'ERROR' ? 'error' : 'info'" :closable="false" />
    <el-table v-loading="pending" :data="rows" stripe empty-text="暂无匹配组件" data-testid="health-table"><el-table-column prop="name" label="组件" /><el-table-column label="状态"><template #default="{ row }"><el-tag :type="row.state === 'HEALTHY' ? 'success' : 'info'">{{ row.label }}</el-tag></template></el-table-column></el-table>
  </section>
</template>

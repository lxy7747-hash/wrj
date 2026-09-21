<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useDataExchangeStore } from '../../stores/data-exchange'
import { formatDateTime } from '../../features/shared/date-time'
import DataExchangeStateTag from '../data-exchange/DataExchangeStateTag.vue'

const store = useDataExchangeStore()
const status = ref('')
const pending = computed(() => store.monitorState === 'LOADING')
let timer: ReturnType<typeof setInterval> | undefined
type HealthState = 'HEALTHY' | 'ERROR' | 'UNKNOWN'
interface HealthRow { name: string; state: HealthState; label: string; checkedAt: string | null; detail: string }
const rows = computed<HealthRow[]>(() => {
  const snapshot = store.monitor
  const checkedAt = snapshot?.checkedAt ?? null
  const labels = { HEALTHY: '检查通过', ERROR: '异常', UNKNOWN: '暂无数据' }
  const row = (name: string, state: HealthState, detail: string): HealthRow => ({ name, state, label: labels[state], checkedAt, detail })
  const result = [
    row('本机监测服务', snapshot?.service ?? 'UNKNOWN', '仅表示本次监测接口可响应，不代表仿真引擎正在运行。'),
    row('主数据库', snapshot?.database ?? 'UNKNOWN', '仅检查场景、模板、账号、审计所在主库的可读性、必需表及 quick_check。'),
    row('文件读取记录库', snapshot?.recordStorage ?? 'UNKNOWN', '检查记录库查询及最近写入结果；记录失败不改变原文件读取结果。'),
  ]
  const operations = { INITIAL_NODES: '最近初始节点读取', POSITIONS: '最近位置读取', LOCAL_REPLAY: '最近文件回放读取' } as const
  for (const [operation, name] of Object.entries(operations)) {
    // 接口按序号倒序返回最近 50 条；旧成功不能覆盖同类更新的失败记录。
    const record = snapshot?.records.find(item => item.operation === operation)
    result.push({ name, state: record ? record.status === 'SUCCESS' ? 'HEALTHY' : 'ERROR' : 'UNKNOWN',
      label: record ? record.status === 'SUCCESS' ? '读取成功' : '读取失败' : '暂无数据',
      checkedAt: record?.completedAt ?? null,
      detail: record ? `${record.fileName}；${record.status === 'SUCCESS' ? `${record.recordCount} 条有效记录，${record.issueCount} 条异常记录` : 'LOCAL_READ_FAILED：读取失败，请检查来源文件'}；耗时 ${record.durationMs} ms`
        : '最近 50 条记录中没有该类读取证据，不主动读取文件或推进位置游标。',
    })
  }
  for (const name of ['装备／角色权限／归档数据库', '仿真引擎', '通信通道']) {
    result.push({ name, state: 'UNKNOWN', label: '暂无数据', checkedAt: null, detail: '当前监测接口未提供该项证据，不能由主库或接口状态推断。' })
  }
  return result
})
const filteredRows = computed(() => rows.value.filter(row => !status.value || row.state === status.value))
const panelState = computed(() => pending.value ? 'LOADING' : store.monitorState === 'ERROR' || rows.value.some(row => row.state === 'ERROR')
  ? 'ERROR' : store.monitor === null ? 'EMPTY' : 'SUCCESS')

onMounted(() => {
  store.clearMonitor()
  void store.loadMonitor()
  timer = setInterval(() => { void store.loadMonitor() }, 5000)
})
onBeforeUnmount(() => { clearInterval(timer); store.clearMonitor() })
</script>

<template>
  <section class="maintenance-card" aria-label="系统运行状态" data-testid="health-panel">
    <header class="maintenance-toolbar"><h3>系统运行状态</h3><DataExchangeStateTag :state="panelState" /><el-button :disabled="pending" @click="store.loadMonitor()">刷新状态</el-button></header>
    <p class="maintenance-note" data-testid="health-observed-at">每 5 秒刷新；观测时间：{{ store.monitor ? formatDateTime(store.monitor.checkedAt) : '暂无数据' }}。文件项显示最近读取记录，不代表此刻文件仍可读或链路质量正常。</p>
    <el-form inline><el-form-item label="状态"><el-select v-model="status" style="width: 180px" aria-label="运行状态筛选"><el-option label="全部状态" value="" /><el-option label="检查通过／读取成功" value="HEALTHY" /><el-option label="异常／读取失败" value="ERROR" /><el-option label="暂无数据" value="UNKNOWN" /></el-select></el-form-item></el-form>
    <el-alert v-if="store.monitorMessage" :title="store.monitorMessage" type="error" :closable="false" data-testid="health-feedback" />
    <el-table v-loading="pending" :data="filteredRows" stripe empty-text="暂无匹配组件" data-testid="health-table">
      <el-table-column prop="name" label="组件／读取操作" min-width="180" />
      <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="row.state === 'HEALTHY' ? 'success' : row.state === 'ERROR' ? 'danger' : 'info'">{{ row.label }}</el-tag></template></el-table-column>
      <el-table-column label="观测／读取完成时间" min-width="180"><template #default="{ row }">{{ row.checkedAt ? formatDateTime(row.checkedAt) : '暂无数据' }}</template></el-table-column>
      <el-table-column prop="detail" label="依据与范围" min-width="330" />
    </el-table>
  </section>
</template>

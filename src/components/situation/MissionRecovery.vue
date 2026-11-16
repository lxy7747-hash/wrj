<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { MissionRecoveryStatus } from '../../contracts/domain-models'
import { apiFetch } from '../../features/shared/api-fetch'
import { resolveMockOrigin, useAuthStore } from '../../stores/auth'

const props = defineProps<{ refreshKey?: string }>()
const emit = defineEmits<{ resolved: [] }>()
const auth = useAuthStore()
const records = ref<MissionRecoveryStatus[]>([])
const pending = ref(false)
const canStop = computed(() => auth.role === 'ADMIN' && auth.authorize('SIMULATION_CONTROL').allowed)
const lifetime = new AbortController()
let timer: ReturnType<typeof setTimeout> | undefined
let epoch = 0
onBeforeUnmount(() => { epoch++; clearTimeout(timer); lifetime.abort() })

async function request(runId?: string): Promise<MissionRecoveryStatus[]> {
  const response = await apiFetch(`${resolveMockOrigin()}/api/v1/simulations/recovery${runId ? '/stop' : ''}`, {
    signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(runId ? 45000 : 15000)]),
    headers: { 'X-Demo-Role': auth.role, 'Content-Type': 'application/json' },
    ...(runId ? { method: 'POST', body: JSON.stringify({ runId }) } : {}),
  })
  const body = await response.json()
  if (!response.ok || body.ok !== true) throw new Error(body.error?.message ?? '遗留运行检查失败。')
  if (!Array.isArray(body.data) || !body.data.every((row: MissionRecoveryStatus) => row && typeof row.message === 'string'
    && typeof row.canStop === 'boolean' && (row.runId === undefined || typeof row.runId === 'string')
    && (row.scenarioId === undefined || typeof row.scenarioId === 'string')
    && (row.pid === undefined || Number.isSafeInteger(row.pid)))) throw new Error('遗留运行响应无效。')
  return body.data
}

async function refresh(): Promise<void> {
  clearTimeout(timer)
  const current = ++epoch
  if (auth.runtimeMode !== 'LOCAL' || !auth.principal) { records.value = []; return }
  if (pending.value) return
  try {
    const next = await request()
    if (current !== epoch || lifetime.signal.aborted) return
    const resolved = records.value.length > 0 && next.length === 0
    records.value = next
    if (resolved) emit('resolved')
  } catch { /* 普通控制请求仍返回错误；已有恢复信息保留并重试。 */ }
  finally {
    if (current === epoch && !lifetime.signal.aborted && records.value.length) timer = setTimeout(refresh, 5000)
  }
}

async function stop(record: MissionRecoveryStatus): Promise<void> {
  if (!canStop.value || !record.canStop || !record.runId || pending.value) return
  pending.value = true
  try {
    await ElMessageBox.confirm(`确认停止场景 ${record.scenarioId ?? ''} 的遗留 Mission 运行？已产生的文件会保留。`, '停止遗留运行', { type: 'warning', confirmButtonText: '停止运行', cancelButtonText: '取消' })
  } catch { pending.value = false; void refresh(); return }
  if (lifetime.signal.aborted || !canStop.value) { pending.value = false; return }
  ++epoch
  clearTimeout(timer)
  try {
    records.value = await request(record.runId)
    if (lifetime.signal.aborted) return
    ElMessage.success('遗留运行已停止，场景已解锁。')
    emit('resolved')
  } catch (error) {
    if (!lifetime.signal.aborted) ElMessage.error(error instanceof Error ? error.message : '停止失败，已保留运行锁。')
  } finally { pending.value = false; if (!lifetime.signal.aborted) void refresh() }
}

watch(() => [auth.principal?.userId, auth.runtimeMode, props.refreshKey], () => { void refresh() }, { immediate: true })
</script>

<template>
  <div v-if="records.length" class="mission-recovery" role="status" data-testid="mission-recovery">
    <div v-for="(record, index) in records" :key="record.runId ?? index" class="mission-recovery__row">
      <span>{{ record.scenarioId }}：{{ record.message }}</span>
      <el-button v-if="record.canStop && canStop" type="danger" size="small" :loading="pending" :disabled="pending" @click="stop(record)">停止遗留运行</el-button>
      <span v-else-if="record.canStop">请管理员停止遗留运行。</span>
      <el-button size="small" :disabled="pending" @click="refresh">重新检查</el-button>
    </div>
  </div>
</template>

<style scoped>
.mission-recovery { min-width: 0; font-size: 0.8rem; color: var(--el-color-warning); }
.mission-recovery__row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.mission-recovery__row span { overflow-wrap: anywhere; }
</style>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiFetch } from '../../features/shared/api-fetch'
import { isMissionResultRecord, type MissionResultRecord } from '../../features/results/mission-result'
import { resolveMockOrigin, useAuthStore } from '../../stores/auth'
import { useSimulationStore } from '../../stores/simulation'
import { formatDateTime } from '../../features/shared/date-time'

const props = defineProps<{ startedAt?: string; status?: string; view?: 'report' | 'replay'; refreshing?: boolean }>()
const emit = defineEmits<{ refresh: [] }>()
const auth = useAuthStore()
const simulation = useSimulationStore()
const route = useRoute()
const router = useRouter()
const records = ref<MissionResultRecord[] | null>(null)
const selected = ref('')
const loading = ref(false)
const error = ref('')
let epoch = 0
const current = computed(() => records.value?.find(r => r.resultId === selected.value))
function syncSelected() {
  selected.value = typeof route.query.resultId === 'string' ? route.query.resultId
    : props.view === 'replay' && route.query.source === 'file' ? 'file'
    : props.view ? '' : records.value?.find(r => r.startedAt === props.startedAt)?.resultId ?? ''
  if (props.view !== 'replay' || route.path !== '/replays' || selected.value || route.query.archiveId || !records.value) return
  const sceneId = simulation.selectedScene?.config.scenario.id ?? simulation.readSelectedSceneId()
  const matches = sceneId ? records.value.filter(r => r.scenarioId === sceneId) : records.value
  const latest = matches.find(r => r.runId && r.runId === simulation.run?.runId) ?? matches[0]
  if (latest) void router.replace({ path: route.path, query: { resultId: latest.resultId } })
  else if (!sceneId && !records.value.length) void router.replace({ path: route.path, query: { source: 'file' } })
}
async function load() {
  const request = ++epoch
  if (auth.runtimeMode !== 'LOCAL') return
  loading.value = true
  error.value = ''
  try {
    const response = await apiFetch(`${resolveMockOrigin()}/api/v1/mission-results`, { headers: { 'X-Demo-Role': auth.role } })
    const payload = await response.json()
    if (!response.ok || !Array.isArray(payload.data) || !payload.data.every(isMissionResultRecord)) throw new Error(payload.error?.message ?? '运行结果目录加载失败。')
    if (request !== epoch) return
    records.value = payload.data
    syncSelected()
  } catch (e) { if (request === epoch) { records.value = null; selected.value = ''; error.value = e instanceof Error ? e.message : '运行结果目录加载失败。' } }
  finally { if (request === epoch) loading.value = false }
}
function select(id: string) {
  selected.value = id
  if (props.view) void router.push({ path: route.path, query: id === 'file' ? { source: 'file' } : { resultId: id } })
}
function refresh() { void load(); emit('refresh') }
watch(() => [auth.runtimeMode, props.startedAt, props.status], () => { void load() }, { immediate: true })
watch(() => [route.query.resultId, route.query.archiveId, route.query.source], syncSelected)
onBeforeUnmount(() => { epoch++ })
</script>

<template>
  <div v-if="auth.runtimeMode === 'LOCAL'" class="mission-results" aria-label="仿真运行结果">
    <span>运行结果</span>
    <el-select :model-value="selected" :loading="loading" aria-label="选择仿真运行结果" placeholder="选择已完成的运行" style="width: 24rem; max-width: 100%" @update:model-value="select">
      <el-option v-if="view === 'replay'" value="file" label="本机日志文件" />
      <el-option v-for="record in records" :key="record.resultId" :value="record.resultId"
        :label="`${record.scenarioName} · 修订 ${record.revision} · ${formatDateTime(record.completedAt)}`" />
    </el-select>
    <el-button :loading="loading || refreshing" @click="refresh">{{ view === 'report' ? '刷新报告' : '刷新结果' }}</el-button>
    <el-button v-if="current && view !== 'replay'" @click="router.push({ path: '/replays', query: { resultId: current.resultId } })">查看回放</el-button>
    <el-button v-if="current && view !== 'report'" @click="router.push({ path: '/reports', query: { resultId: current.resultId } })">查看报告／下载</el-button>
    <span v-if="error" role="alert">{{ error }}</span>
    <span v-else-if="!loading && records?.length === 0">暂无已完成的运行结果</span>
  </div>
</template>

<style scoped>
.mission-results { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 10px; min-width: 0; }
</style>

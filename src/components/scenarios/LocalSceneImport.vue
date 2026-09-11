<script setup lang="ts">
import { apiFetch } from '../../features/shared/api-fetch'

import { computed, onBeforeUnmount, ref, toRaw, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { PlatformType, ValidationIssue } from '../../contracts/domain-models'
import { buildLocalSceneImport, type LocalNodeChoice, type LocalSceneImport as ImportInput } from '../../features/scenarios/local-scene-import'
import { BUSINESS_INFORMATION_NODE_TYPES, SUPPORTING_ENTITY_TYPES } from '../../features/scenarios/scenario-validation'
import { PLATFORM_TYPE_LABELS } from '../../features/situation/situation-model'
import { isInitialNodeSnapshot, type InitialNodeSnapshot } from '../../features/situation/initial-nodes'
import { unwrapSuccessData } from '../../stores/api-envelope'
import { resolveMockOrigin, useAuthStore } from '../../stores/auth'
import { useScenarioStore } from '../../stores/scenario'

const store = useScenarioStore()
const auth = useAuthStore()
const visible = ref(false)
const loading = ref(false)
const confirming = ref(false)
const message = ref('')
const initial = ref<InitialNodeSnapshot | null>(null)
const nodes = ref<LocalNodeChoice[]>([])
const errors = ref<ValidationIssue[]>([])
let request: AbortController | null = null
let context = { requestEpoch: -1, scriptEpoch: -1, localImportEpoch: -1 }
const disabled = computed(() => !store.draft || store.draft.locked
  || ['LOADING', 'VALIDATING', 'EXECUTING'].includes(store.panelState)
  || !auth.principal || !auth.permissions.includes('SCENARIO_DRAFT_WRITE'))
const typeOptions = [...BUSINESS_INFORMATION_NODE_TYPES, ...SUPPORTING_ENTITY_TYPES].map(value => ({ value, label: PLATFORM_TYPE_LABELS[value] }))
// 仅匹配语义明确的文件类型；中继等无法确定所属类型的记录仍由用户选择。
const sourceTypes: Record<string, PlatformType> = {
  Drone_MISSION_AIRCRAFT: 'AIRBORNE_MISSION_CLUSTER',
  Command_Vehicle_PLATFORM: 'REAR_COMMAND_NODE',
}
const selected = computed(() => nodes.value.filter(node => node.selected))
const updated = computed(() => selected.value.filter(row => existing(row)).length)
const nodeErrors = computed(() => new Map(nodes.value.map(row => [row.sourceId, inspectNode(row)])))

function existing(row: LocalNodeChoice) {
  return store.draft?.config.platforms.find(node => node.id === row.targetId)
}
function inspectNode(row: LocalNodeChoice): string {
  if (!initial.value || !store.draft) return ''
  if (!row.type) return '请选择场景类型'
  return buildLocalSceneImport(toRaw(store.draft.config), input([{ ...row, selected: true }])).errors.map(error => error.message).join('；')
}
function chooseType(row: LocalNodeChoice, value: PlatformType): void {
  row.type = value
  row.selected = !inspectNode(row)
  errors.value = []
}

function clear(): void {
  store.invalidateLocalFileImport()
  request?.abort()
  request = null
  loading.value = false
  initial.value = null
  nodes.value = []
  errors.value = []
  message.value = ''
}

/** 场景只读取初始坐标；实时位置仍由地图消费，不覆盖用户草稿。 */
async function load(): Promise<void> {
  if (disabled.value || confirming.value) return
  clear()
  visible.value = true
  loading.value = true
  context = { requestEpoch: store.requestEpoch, scriptEpoch: store.scriptEpoch, localImportEpoch: store.localImportEpoch }
  const current = new AbortController()
  request = current
  const timeout = setTimeout(() => current.abort(), 10_000)
  try {
    const read = async (path: string) => {
      const response = await apiFetch(`${resolveMockOrigin()}/api/v1/situation/${path}`, {
        headers: { 'X-Demo-Role': auth.role }, signal: current.signal,
      })
      if (!response.ok) throw new Error('本地文件读取失败，请检查本机服务和文件后重试。')
      return unwrapSuccessData(await response.json())
    }
    const source = await read('initial-nodes')
    if (request !== current) return
    if (!isInitialNodeSnapshot(source)) throw new Error('本地文件响应格式不正确，未保留旧预览。')
    if (source === null) { message.value = '尚未配置初始日志，请先配置本机数据来源。'; return }
    initial.value = source
    nodes.value = source.nodes.map(node => ({ sourceId: node.platformId, selected: false, targetId: node.platformId, useLatest: false,
      type: store.draft?.config.platforms.find(p => p.id === node.platformId)?.type ?? sourceTypes[node.type],
    }))
    nodes.value.forEach(row => { row.selected = !inspectNode(row) })
  } catch (error) {
    if (request === current) message.value = current.signal.aborted ? '读取超时，请重新加载。' : error instanceof Error ? error.message : '读取失败，请重试。'
  } finally {
    clearTimeout(timeout)
    if (request === current) { loading.value = false; request = null }
  }
}

function input(choices = nodes.value): ImportInput {
  return { initial: toRaw(initial.value!), positions: null, nodes: choices.map(row => ({ ...toRaw(row) })), links: [] }
}

async function apply(): Promise<void> {
  if (disabled.value || loading.value || confirming.value || !initial.value || !store.draft) return
  const candidate = structuredClone(input())
  const result = buildLocalSceneImport(toRaw(store.draft.config), candidate)
  errors.value = result.errors
  if (!result.config) return
  const expected = { ...context }
  const count = candidate.nodes.filter(node => node.selected).length
  const updated = candidate.nodes.filter(node => node.selected && store.draft!.config.platforms.some(p => p.id === node.targetId.trim())).length
  confirming.value = true
  try {
    await ElMessageBox.confirm(`将新增 ${count - updated} 个节点、更新 ${updated} 个节点的初始位置，其他配置保留，导入后仍需手动保存。`, '确认导入本地数据', { confirmButtonText: '导入草稿', cancelButtonText: '取消', type: 'warning' })
    if (!visible.value || expected.requestEpoch !== store.requestEpoch || expected.scriptEpoch !== store.scriptEpoch
      || expected.localImportEpoch !== store.localImportEpoch) return
    errors.value = store.applyLocalFileImport(candidate, expected.requestEpoch, expected.scriptEpoch, expected.localImportEpoch)
    if (errors.value.length) return
    visible.value = false
    clear()
    ElMessage.success('节点已导入草稿，请手动保存。链路请在“链路配置”中添加。')
  } catch { /* 用户取消时保留预览，不写入草稿。 */ }
  finally { confirming.value = false }
}

// 导入资格属于加载时的会话和草稿；离页、编辑、重载或锁定立即淘汰预览及在途请求。
watch(() => [store.requestEpoch, store.scriptEpoch, store.draft, store.draft?.locked, auth.principal], () => {
  if (visible.value) { clear(); message.value = '草稿、会话或配置锁已变化，请重新加载导入预览。' }
}, { flush: 'sync' })
onBeforeUnmount(() => { visible.value = false; clear() })
watch(visible, value => { if (!value) clear() }, { flush: 'sync' })
</script>

<template>
  <el-button :disabled="disabled" data-testid="open-local-scene-import" @click="load">从本地数据导入</el-button>
  <el-dialog v-model="visible" title="本地数据导入" width="min(840px, calc(100vw - 2rem))" top="6vh" destroy-on-close append-to-body class="local-scene-import" data-testid="local-scene-import" @close="clear">
    <p v-if="loading" role="status">正在读取本地文件快照…</p>
    <el-alert v-if="message" :title="message" type="warning" :closable="false" data-testid="local-import-message" />
    <template v-if="initial">
      <p data-testid="local-import-summary">{{ initial.fileName }}：新增 {{ selected.length - updated }} 个 · 更新 {{ updated }} 个 · 未导入 {{ nodes.length - selected.length }} 个</p>
      <p class="import-hint">使用初始坐标，同 ID 节点仅更新位置。实时位置仍用于地图；链路参数在“链路配置”中添加。</p>
      <div data-testid="local-import-nodes">
        <div v-for="row in nodes" :key="row.sourceId" class="import-row">
          <el-checkbox v-model="row.selected" :disabled="confirming || !!nodeErrors.get(row.sourceId)" :aria-label="`导入节点 ${row.sourceId}`" />
          <div class="import-node-name">{{ row.sourceId }}<small>{{ initial.nodes.find(n => n.platformId === row.sourceId)?.type }}</small></div>
          <div>
            <span v-if="existing(row) || sourceTypes[initial.nodes.find(n => n.platformId === row.sourceId)!.type]">{{ PLATFORM_TYPE_LABELS[row.type!] }}</span>
            <el-select v-else :model-value="row.type" :options="typeOptions" :disabled="confirming" placeholder="请选择场景类型" :aria-label="`场景类型 ${row.sourceId}`" @update:model-value="chooseType(row, $event)" />
            <el-select v-if="row.type === 'COMMUNICATION_SATELLITE' && !existing(row)" v-model="row.satelliteType" :disabled="confirming" placeholder="请选择卫星类型" :aria-label="`卫星类型 ${row.sourceId}`" @update:model-value="row.selected = !inspectNode(row)"><el-option label="天通卫星" value="TIANTONG" /><el-option label="神通卫星" value="SHENTONG" /></el-select>
          </div>
          <span :class="{ 'import-error': nodeErrors.get(row.sourceId) }">{{ nodeErrors.get(row.sourceId) || (row.selected ? (existing(row) ? '更新位置' : '新增') : '不导入') }}</span>
        </div>
      </div>
      <ul v-if="errors.length" role="alert" data-testid="local-import-errors"><li v-for="(error, index) in errors" :key="index">{{ error.fieldPath }}：{{ error.message }}</li></ul>
    </template>
    <template #footer><el-button :disabled="confirming" @click="visible = false">取消</el-button><el-button :disabled="loading || confirming || disabled" @click="load">重新读取</el-button><el-button type="primary" :disabled="loading || confirming || disabled || !selected.length" data-testid="apply-local-scene-import" @click="apply">导入草稿</el-button></template>
  </el-dialog>
</template>

<style scoped>
.import-row { display: grid; grid-template-columns: 24px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr); gap: 12px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--el-border-color); }
.import-node-name { overflow-wrap: anywhere; }
.import-node-name small { display: block; color: var(--el-text-color-secondary); }
.import-hint { color: var(--el-text-color-secondary); }
.import-error { color: var(--el-color-warning); }
</style>
<style>
.local-scene-import .el-dialog__body { max-height: 70vh; overflow: auto; }
</style>

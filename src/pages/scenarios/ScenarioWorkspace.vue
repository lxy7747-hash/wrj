<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ScenarioDraft } from '../../contracts/domain-models'
import { createScenarioSnapshot, scenarioSnapshotId } from '../../features/scenarios/scenario-snapshot'
import { saveScriptText } from '../../features/scenarios/script-file'
import { useScenarioStore } from '../../stores/scenario'
import { useAuthStore } from '../../stores/auth'
import { useSimulationStore } from '../../stores/simulation'
import ScenarioEditor from './scenarios.vue'

const store = useScenarioStore()
const auth = useAuthStore()
const router = useRouter()
const simulationStore = useSimulationStore()
const editing = ref(false)
const selecting = ref(false)
const templateDialog = ref(false)
const templateId = ref('')
const templateName = ref('')
const busy = computed(() => selecting.value || ['LOADING', 'VALIDATING', 'EXECUTING'].includes(store.listState))
const canWrite = computed(() => auth.authorize('SCENARIO_DRAFT_WRITE').allowed)
const sceneSelectionDisabled = computed(() => busy.value || simulationStore.pending || simulationStore.selectingScene
  || simulationStore.run?.configLocked || ['RUNNING', 'PAUSED'].includes(simulationStore.uiStatus))
let active = true
const selectionLifetime = new AbortController()
onBeforeUnmount(() => { active = false; selectionLifetime.abort() })

async function mayLeave(): Promise<boolean> {
  if (!editing.value || !store.dirty) return true
  try {
    await ElMessageBox.confirm('当前场景有未保存修改，离开将丢弃这些修改。', '返回场景列表', { confirmButtonText: '丢弃并离开', cancelButtonText: '继续编辑', type: 'warning' })
    return true
  } catch { return false }
}

async function showList(): Promise<void> {
  if (!await mayLeave() || !active) return
  editing.value = false
  store.resetToSafeEmpty()
  await store.loadScenes()
}

function create(): void {
  store.resetToSafeEmpty()
  if (store.createScenario()) editing.value = true
}

async function open(scene: ScenarioDraft, copy = false): Promise<void> {
  selecting.value = true
  store.resetToSafeEmpty()
  try {
    const loaded = await store.loadScenario(scene.config.scenario.id)
    if (!active || !auth.principal) return
    if (!loaded) {
      ElMessage.error(store.resultMessage)
      await store.loadScenes()
      return
    }
    const current = store.draft!
    if (copy && !store.prepareSceneCopy(current.config, current.uiExtensions, `${current.config.scenario.name} 副本`)) return
    editing.value = true
  } finally { selecting.value = false }
}

async function selectScene(scene: ScenarioDraft): Promise<void> {
  if (sceneSelectionDisabled.value || !auth.principal) return
  const epoch = store.requestEpoch
  selecting.value = true
  try {
    const selected = await simulationStore.selectScene(scene.config.scenario.id, selectionLifetime.signal)
    if (!active || !auth.principal || epoch !== store.requestEpoch) return
    if (!selected) {
      ElMessage.error(simulationStore.resultMessage)
      return
    }
    await router.push('/situation')
  } finally { selecting.value = false }
}

async function remove(scene: ScenarioDraft): Promise<void> {
  const epoch = store.requestEpoch
  try {
    await ElMessageBox.confirm(`确认删除场景“${scene.config.scenario.name}”？此操作不可撤销，场景模板不会删除。`, '删除场景', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
    if (!active || epoch !== store.requestEpoch || !canWrite.value) return
    if (await store.deleteScene(scene)) ElMessage.success('场景已删除。')
  } catch { /* 取消不删除。 */ }
}

const jsonFile = ref<HTMLInputElement | null>(null)
const importError = ref('')

/** 将完整可编辑场景保存为本地 UTF-8 JSON 文件，不包含服务器修订和运行状态。 */
function exportJson(scene: ScenarioDraft): void {
  // 表格行来自 Pinia 的深度响应式集合；先在边界解除 Proxy，再交给可复用的纯快照构造器。
  const text = `${JSON.stringify(createScenarioSnapshot(toRaw(scene)), null, 2)}\n`
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${scene.config.scenario.id}.json`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  ElMessage.success(`场景已导出为 ${link.download}。`)
}

/** 导入已经保存；脚本失败不回滚场景，失效流程不继续写文件或提示。 */
async function generateImportedScript(): Promise<{ ok: true; path: string } | { ok: false; message: string } | null> {
  const draft = store.draft
  if (!draft) return { ok: false, message: '导入结果缺少场景草稿。' }
  const epoch = store.requestEpoch
  const userId = auth.principal?.userId
  const configVersion = `${draft.config.scenario.id}-v${draft.revision}`
  const current = () => active && epoch === store.requestEpoch && userId === auth.principal?.userId
    && canWrite.value && store.draft === draft && !store.dirty && !draft.locked
  let generated = await store.generateScriptPreview()
  if (!current()) return null
  if (!generated && store.scriptResultCode === 'CONFIRMATION_REQUIRED') {
    const scriptEpoch = store.scriptEpoch
    try {
      await ElMessageBox.confirm(`${store.scriptResultMessage} 是否继续生成？`, '脚本预览警告', {
        confirmButtonText: '本次继续', cancelButtonText: '取消', type: 'warning',
      })
    } catch {
      return current() && scriptEpoch === store.scriptEpoch ? { ok: false, message: '已取消生成。' } : null
    }
    if (!current() || scriptEpoch !== store.scriptEpoch) return null
    generated = await store.generateScriptPreview(true)
    if (!current()) return null
  }
  const script = store.script
  if (!generated || !script) return { ok: false, message: store.scriptResultMessage || '脚本预览生成失败。' }
  if (script.scenarioId !== draft.config.scenario.id || script.configVersion !== configVersion) {
    return { ok: false, message: '脚本版本与导入场景不一致。' }
  }
  const scriptEpoch = store.scriptEpoch
  try {
    const path = await saveScriptText(script)
    return current() && scriptEpoch === store.scriptEpoch ? { ok: true, path } : null
  } catch (error) {
    return current() && scriptEpoch === store.scriptEpoch
      ? { ok: false, message: error instanceof Error ? error.message : 'TXT 写入失败。' } : null
  }
}

/** 读取本地 JSON 文件并按完整场景快照导入；校验失败保留原场景，错误定位到字段路径。 */
async function importJson(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !canWrite.value) return
  importError.value = ''
  if (file.size > 4 * 1024 * 1024) { importError.value = '场景 JSON 文件不能超过 4 MiB。'; return }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) }
  catch { importError.value = '文件不是有效的 UTF-8 文本。'; return }
  if (!active) return
  const existing = (() => { try { return scenarioSnapshotId(JSON.parse(text)) } catch { return undefined } })()
  if (existing && store.scenes.some(scene => scene.config.scenario.id === existing)) {
    try {
      await ElMessageBox.confirm(`场景编号 ${existing} 已存在，导入将以文件内容覆盖该场景（可在编辑页撤销）。`, '导入场景 JSON', { type: 'warning', confirmButtonText: '覆盖导入', cancelButtonText: '取消' })
    } catch { return }
  }
  selecting.value = true
  try {
    const imported = await store.importScenarioSnapshot(text)
    if (!active) return
    if (!imported) {
      const fieldPath = store.validation.errors[0]?.fieldPath
      importError.value = `${store.resultMessage}${fieldPath ? `（字段：${fieldPath.replace(/^items\[0\]\./, '')}）` : ''}`
      store.resetToSafeEmpty()
      return
    }
    const name = store.draft?.config.scenario.name ?? ''
    const result = await generateImportedScript()
    if (!active || !result) return
    if (result.ok) ElMessage.success(`已导入场景“${name}”，TXT 已生成：${result.path}`)
    else ElMessage.warning(`已导入场景“${name}”，但 TXT 未生成：${result.message} 可进入场景点击“保存”重试。`)
    store.resetToSafeEmpty()
  } finally {
    selecting.value = false
    await store.loadScenes()
  }
}

async function chooseTemplate(): Promise<void> {
  templateId.value = ''
  templateName.value = ''
  templateDialog.value = true
  await store.loadTemplates()
}

async function fromTemplate(): Promise<void> {
  if (!templateId.value || !templateName.value.trim()) return
  selecting.value = true
  const id = templateId.value
  const name = templateName.value.trim()
  store.resetToSafeEmpty()
  try {
    if (await store.copyTemplate(id, name) && active) {
      templateDialog.value = false
      ElMessage.success('已从模板创建场景。')
      await showList()
    }
  } finally { selecting.value = false }
}

onBeforeRouteLeave(async to => {
  if (to.path === '/login') return true
  if (!await mayLeave()) return false
  if (store.dirty) store.resetToSafeEmpty()
  return true
})
onMounted(() => { void store.loadScenes() })
</script>

<template>
  <ScenarioEditor v-if="editing" managed @saved="showList" @back="showList" />
  <section v-else class="page scene-list" aria-label="场景配置" data-testid="scene-list">
    <header class="scene-list__toolbar">
      <h2>场景列表</h2>
      <el-button :disabled="busy" @click="store.loadScenes()">刷新</el-button>
      <el-button :disabled="busy || !canWrite" data-testid="scene-import-json" @click="jsonFile?.click()">导入 JSON 文件</el-button>
      <input ref="jsonFile" type="file" accept=".json,application/json" hidden aria-label="选择场景 JSON 文件" data-testid="scene-import-file" @change="importJson">
      <el-button :disabled="busy || !canWrite" data-testid="scene-from-template" @click="chooseTemplate">从模板创建</el-button>
      <el-button type="primary" :disabled="busy || !canWrite" data-testid="scene-create" @click="create">新建场景</el-button>
    </header>
    <el-alert v-if="store.listState === 'ERROR'" type="error" :closable="false" :title="store.listMessage" show-icon />
    <el-alert v-if="importError" type="error" :title="`场景 JSON 导入失败：${importError}`" show-icon data-testid="scene-import-error" @close="importError = ''" />
    <p v-if="store.listState === 'LOADING'" role="status">正在加载场景列表…</p>
    <el-empty v-else-if="store.listState === 'EMPTY'" description="暂无场景，请新建场景或从模板创建。" />
    <el-table v-else :data="store.scenes" stripe row-key="config.scenario.id" data-testid="scene-table">
      <el-table-column type="index" label="序号" width="70" />
      <el-table-column prop="config.scenario.name" label="场景名称" min-width="220" />
      <el-table-column prop="revision" label="修订" width="90" />
      <el-table-column label="节点 / 链路" width="140"><template #default="{ row }">{{ row.config.platforms.length }} / {{ row.config.links.length }}</template></el-table-column>
      <el-table-column label="状态" width="130"><template #default="{ row }"><el-tag :type="row.locked ? 'warning' : 'success'">{{ row.locked ? '运行中 · 已锁定' : '已保存' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="310" fixed="right"><template #default="{ row }">
        <el-button link type="primary" :disabled="sceneSelectionDisabled" :data-testid="`scene-select-${row.config.scenario.id}`" @click="selectScene(row)">选用场景</el-button>
        <el-button link type="primary" :disabled="busy" :data-testid="`scene-edit-${row.config.scenario.id}`" @click="open(row)">{{ row.locked ? '查看' : '编辑' }}</el-button>
        <el-button link type="primary" :disabled="busy || !canWrite" :data-testid="`scene-copy-${row.config.scenario.id}`" @click="open(row, true)">复制</el-button>
        <el-button link type="primary" :disabled="busy" :data-testid="`scene-export-${row.config.scenario.id}`" @click="exportJson(row)">导出</el-button>
        <el-button link type="danger" :disabled="busy || row.locked || !canWrite" :data-testid="`scene-delete-${row.config.scenario.id}`" @click="remove(row)">删除</el-button>
      </template></el-table-column>
    </el-table>
    <el-dialog v-model="templateDialog" class="scenario-dialog" title="从模板创建场景" width="min(480px, calc(100vw - 2rem))" :close-on-click-modal="!selecting" :show-close="!selecting">
      <el-form label-position="top">
        <el-form-item label="场景模板"><el-select v-model="templateId" :loading="store.templateState === 'LOADING'" :disabled="selecting" placeholder="请选择场景模板" data-testid="scene-template-select">
          <el-option v-for="item in store.templates" :key="item.templateId" :label="item.name" :value="item.templateId" />
        </el-select></el-form-item>
        <el-form-item label="新场景名称"><el-input v-model="templateName" :disabled="selecting" data-testid="scene-template-name" /></el-form-item>
      </el-form>
      <el-alert v-if="store.templateState === 'ERROR'" type="error" :title="store.templateResultMessage" :closable="false" />
      <el-empty v-else-if="store.templateState === 'EMPTY'" description="暂无场景模板" />
      <template #footer><el-button :disabled="selecting" @click="templateDialog = false">取消</el-button><el-button type="primary" :loading="selecting" :disabled="!templateId || !templateName.trim() || !canWrite" data-testid="scene-template-confirm" @click="fromTemplate">创建场景</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.scene-list { display: grid; gap: 16px; align-content: start; }
.scene-list__toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.scene-list__toolbar h2 { margin: 0 auto 0 0; font-size: 20px; }
</style>

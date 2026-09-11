<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ScenarioDraft } from '../../contracts/domain-models'
import { useScenarioStore } from '../../stores/scenario'
import { useAuthStore } from '../../stores/auth'
import ScenarioEditor from './scenarios.vue'

const store = useScenarioStore()
const auth = useAuthStore()
const editing = ref(false)
const selecting = ref(false)
const templateDialog = ref(false)
const templateId = ref('')
const templateName = ref('')
const busy = computed(() => selecting.value || ['LOADING', 'VALIDATING', 'EXECUTING'].includes(store.listState))
const canWrite = computed(() => auth.authorize('SCENARIO_DRAFT_WRITE').allowed)
let active = true
onBeforeUnmount(() => { active = false })

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

async function remove(scene: ScenarioDraft): Promise<void> {
  const epoch = store.requestEpoch
  try {
    await ElMessageBox.confirm(`确认删除场景“${scene.config.scenario.name}”？此操作不可撤销，场景模板不会删除。`, '删除场景', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
    if (!active || epoch !== store.requestEpoch || !canWrite.value) return
    if (await store.deleteScene(scene)) ElMessage.success('场景已删除。')
  } catch { /* 取消不删除。 */ }
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
      <el-button :disabled="busy || !canWrite" data-testid="scene-from-template" @click="chooseTemplate">从模板创建</el-button>
      <el-button type="primary" :disabled="busy || !canWrite" data-testid="scene-create" @click="create">新建场景</el-button>
    </header>
    <el-alert v-if="store.listState === 'ERROR'" type="error" :closable="false" :title="store.listMessage" show-icon />
    <p v-if="store.listState === 'LOADING'" role="status">正在加载场景列表…</p>
    <el-empty v-else-if="store.listState === 'EMPTY'" description="暂无场景，请新建场景或从模板创建。" />
    <el-table v-else :data="store.scenes" stripe row-key="config.scenario.id" data-testid="scene-table">
      <el-table-column type="index" label="序号" width="70" />
      <el-table-column prop="config.scenario.name" label="场景名称" min-width="220" />
      <el-table-column prop="revision" label="修订" width="90" />
      <el-table-column label="节点 / 链路" width="140"><template #default="{ row }">{{ row.config.platforms.length }} / {{ row.config.links.length }}</template></el-table-column>
      <el-table-column label="状态" width="130"><template #default="{ row }"><el-tag :type="row.locked ? 'warning' : 'success'">{{ row.locked ? '运行中 · 已锁定' : '已保存' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="250" fixed="right"><template #default="{ row }">
        <el-button link type="primary" :disabled="busy" :data-testid="`scene-edit-${row.config.scenario.id}`" @click="open(row)">{{ row.locked ? '查看' : '编辑' }}</el-button>
        <el-button link type="primary" :disabled="busy || !canWrite" :data-testid="`scene-copy-${row.config.scenario.id}`" @click="open(row, true)">复制</el-button>
        <el-button link type="danger" :disabled="busy || row.locked || !canWrite" :data-testid="`scene-delete-${row.config.scenario.id}`" @click="remove(row)">删除</el-button>
      </template></el-table-column>
    </el-table>
    <el-dialog v-model="templateDialog" title="从模板创建场景" width="480px" :close-on-click-modal="!selecting" :show-close="!selecting">
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

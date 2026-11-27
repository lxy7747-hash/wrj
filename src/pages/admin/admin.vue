<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import type { ScenarioTemplate } from '../../contracts/domain-models'
import AccountManagement from '../../components/admin/AccountManagement.vue'
import AuditLog from '../../components/admin/AuditLog.vue'
import EquipmentLibrary from '../../components/admin/EquipmentLibrary.vue'
import MasterDataPanel from '../../components/admin/MasterDataPanel.vue'
import BackupRestoreWizard from '../../components/admin/BackupRestoreWizard.vue'
import ArchivePanel from '../../components/admin/ArchivePanel.vue'
import HealthPanel from '../../components/admin/HealthPanel.vue'
import TemplateLibrary from '../../components/scenarios/TemplateLibrary.vue'
import TemplateDetailsDialog from '../../components/admin/TemplateDetailsDialog.vue'
import { useScenarioStore } from '../../stores/scenario'
import { useAuthStore } from '../../stores/auth'
import { canVisitMenu } from '../../features/admin/access-control'

const scenarioStore = useScenarioStore()
const {
  draft,
  templates,
  dirty,
  scenes,
  listState,
  listMessage,
  templateState,
  templateResultMessage,
  lastConfirmation,
} = storeToRefs(scenarioStore)
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const basicDataVisible = computed(() => ['master-data', 'equipment-library'].includes(String(route.query.section)))
const canViewEquipment = computed(() => canVisitMenu(auth.principal, '/admin?section=equipment-library'))
const canViewMasterData = computed(() => canVisitMenu(auth.principal, '/admin?section=master-data'))
const basicCategory = computed(() => {
  const requested = route.query.section === 'equipment-library' ? 'equipment' : route.query.category
  if (requested === 'equipment' && canViewEquipment.value) return 'equipment'
  if (requested === 'master' && canViewMasterData.value) return 'master'
  return canViewEquipment.value ? 'equipment' : canViewMasterData.value ? 'master' : ''
})

function selectBasicCategory(category: string | number): void {
  if ((category === 'equipment' && canViewEquipment.value) || (category === 'master' && canViewMasterData.value)) {
    void router.replace({ path: '/admin', query: { ...route.query, section: 'master-data', category } })
  }
}

/**
 * 判断当前是否显示系统管理中的场景模板维护页面。
 * @returns 路由查询参数选中场景模板维护时返回 `true`。
 */
const templateMaintenanceVisible = computed(() => route.query.section === 'scenario-templates')
const canMaintainTemplates = computed(() => auth.permissions.includes('OFFICIAL_TEMPLATE_MAINTAIN'))

/**
 * 判断当前是否显示操作审计日志页面。
 * @returns 路由查询参数选中操作审计日志时返回 `true`。
 */
const auditLogsVisible = computed(() => route.query.section === 'audit-logs')

/**
 * 判断场景模板维护是否处于不可重复操作阶段。
 * @returns 模板正在加载、校验或执行时返回 `true`。
 */
const templateFile = ref<HTMLInputElement | null>(null)
const readingTemplate = ref(false)
const templatePending = computed(() => readingTemplate.value || ['LOADING', 'VALIDATING', 'EXECUTING'].includes(templateState.value))
const templateEdit = ref<{ target: ScenarioTemplate | null; sourceKey: string; name: string } | null>(null)
const canReadScenes = computed(() => canVisitMenu(auth.principal, '/scenarios'))
const sourceListPending = computed(() => canReadScenes.value && listState.value === 'LOADING')
const sceneSources = computed(() => {
  const saved = canReadScenes.value ? scenes.value.map(scene => {
    const { id, name } = scene.config.scenario
    const repeated = scenes.value.some(other => other !== scene && other.config.scenario.name === name)
    return { key: `saved:${id}`, label: `${name}${repeated ? `（${id}）` : ''} · 修订 ${scene.revision}`, scene }
  }) : []
  const current = draft.value
  if (!current) return saved
  const suffix = dirty.value || current.revision === 0 ? '当前未保存草稿' : '当前场景'
  return [{ key: 'current', label: `${current.config.scenario.name} · ${suffix}`, scene: current }, ...saved]
})
const selectedSource = computed(() => sceneSources.value.find(source => source.key === templateEdit.value?.sourceKey)?.scene)
const templateDetails = ref<ScenarioTemplate | null>(null)
const templateExport = ref<{ title: string; filename: string; json: string } | null>(null)

/**
 * 加载模板列表；新建模板只使用用户已选择的场景，不隐式读取默认编号。
 * @returns 所有必要读取结束后兑现且不返回值的 Promise。
 * @sideEffects 仅在数据尚未加载时调用场景 Store，不重复读取已有投影。
 */
async function loadTemplateMaintenance(): Promise<void> {
  const requests: Promise<boolean>[] = []
  if (!scenarioStore.templatesLoaded) requests.push(scenarioStore.loadTemplates())
  await Promise.all(requests)
}

function openTemplateSource(target: ScenarioTemplate | null): void {
  if (templatePending.value) return
  if (templateState.value === 'ERROR') {
    scenarioStore.$patch({ templateState: 'EMPTY', templateResultCode: 'EMPTY', templateResultMessage: '' })
  }
  templateEdit.value = { target, sourceKey: draft.value ? 'current' : '', name: target?.name ?? '' }
  suggestTemplateName()
  if (canReadScenes.value && !sourceListPending.value) void scenarioStore.loadScenes()
}

function suggestTemplateName(): void {
  const edit = templateEdit.value
  const source = selectedSource.value
  if (edit && !edit.target && !edit.name.trim() && source) edit.name = `${source.config.scenario.name} 模板`
}

async function saveTemplateSource(): Promise<void> {
  const edit = templateEdit.value
  const source = selectedSource.value
  if (!edit || !source || !edit.name.trim() || templatePending.value || sourceListPending.value) return
  const saved = edit.target
    ? await scenarioStore.updateTemplate(edit.target.templateId, edit.target.name, source)
    : await scenarioStore.createTemplate(edit.name, source.config, source.uiExtensions)
  if (saved && templateEdit.value === edit) {
    templateEdit.value = null
    ElMessage.success(templateResultMessage.value)
  }
}

/**
 * 复制已有模板为新模板；读取源模板完整详情，不依赖当前场景草稿。
 * @param template 作为复制来源的模板。
 * @returns 操作结束后无返回值。
 * @sideEffects 确认名称后新建模板；源模板及其历史引用保持不变。
 */
async function duplicateTemplate(template: ScenarioTemplate): Promise<void> {
  let name: string
  try {
    ({ value: name } = await ElMessageBox.prompt(`将复制“${template.name}”的完整场景配置为新模板。`, '复制场景模板', {
      confirmButtonText: '复制',
      cancelButtonText: '取消',
      inputValue: `${template.name} 副本`,
      inputValidator: (value) => value.trim() !== '' || '请输入模板名称。',
    }))
  } catch {
    return
  }
  const source = await scenarioStore.loadTemplate(template.templateId)
  if (source === undefined) return
  if (await scenarioStore.createTemplate(name, source.config, source.uiExtensions)) ElMessage.success(templateResultMessage.value)
}

async function importTemplate(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || templatePending.value) return
  if (templateState.value === 'ERROR') {
    scenarioStore.$patch({ templateState: 'EMPTY', templateResultCode: 'EMPTY', templateResultMessage: '' })
  }

  const epoch = scenarioStore.requestEpoch
  const current = () => templateMaintenanceVisible.value && scenarioStore.requestEpoch === epoch
  readingTemplate.value = true
  try {
    const buffer = await file.arrayBuffer().catch(() => null)
    if (!current()) return
    if (buffer === null) {
      ElMessage.error(`无法读取模板文件“${file.name}”。`)
      return
    }

    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      ElMessage.error(`“${file.name}”不是有效的 UTF-8 文件。`)
      return
    }
    if (!text.trim()) {
      ElMessage.error(`模板文件“${file.name}”为空。`)
      return
    }
    if (await scenarioStore.importTemplate(text) && current()) {
      ElMessage.success(`已导入模板文件“${file.name}”。`)
    }
  } finally {
    readingTemplate.value = false
  }
}

async function viewTemplate(templateId: string): Promise<void> {
  const template = await scenarioStore.loadTemplate(templateId)
  if (template && templateMaintenanceVisible.value) templateDetails.value = template
}

async function exportTemplate(template: ScenarioTemplate): Promise<void> {
  const json = await scenarioStore.exportTemplate(template.templateId)
  if (json === undefined || !templateMaintenanceVisible.value) return
  const selected = scenarioStore.selectedTemplate
  const exported = selected?.templateId === template.templateId ? selected : template
  const safeName = `${exported.templateId}-v${exported.version}`.replace(/[^a-zA-Z0-9_-]/g, '_')
  templateExport.value = { title: `导出预览 · ${exported.name}`, filename: `${safeName}.json`, json }
}

function downloadTemplateJson(): void {
  const preview = templateExport.value
  if (!preview) return
  const url = URL.createObjectURL(new Blob([preview.json], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = preview.filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

async function deleteTemplate(templateId: string): Promise<void> {
  if (await scenarioStore.deleteTemplate(templateId)) ElMessage.success(templateResultMessage.value)
}

watch(templateMaintenanceVisible, (visible) => {
  if (visible) void loadTemplateMaintenance()
  else {
    templateEdit.value = null
    templateDetails.value = null
    templateExport.value = null
  }
}, { immediate: true })
</script>

<template>
  <section v-if="templateMaintenanceVisible" class="page admin-page template-maintenance-page" aria-label="场景模板维护">
    <TemplateLibrary
      :can-maintain="canMaintainTemplates"
      :allow-apply="false"
      :pending="templatePending"
      :draft-locked="draft?.locked ?? false"
      :templates="templates"
      :state="templateState"
      :result-message="templateEdit ? '' : templateResultMessage"
      :selected-template="null"
      :last-confirmation="lastConfirmation"
      @create="openTemplateSource(null)"
      @import="templateFile?.click()"
      @refresh="scenarioStore.loadTemplates"
      @load="viewTemplate"
      @duplicate="duplicateTemplate"
      @update="openTemplateSource"
      @export="exportTemplate"
      @delete="deleteTemplate"
    />
    <input ref="templateFile" type="file" accept=".json,application/json" hidden
      aria-label="选择模板 JSON 文件" data-testid="template-import-file" @change="importTemplate">

    <el-dialog
      :model-value="templateEdit !== null"
      :title="templateEdit?.target ? '更新场景模板' : '新建场景模板'"
      width="min(540px, calc(100vw - 2rem))"
      append-to-body
      :close-on-click-modal="false"
      :close-on-press-escape="!templatePending"
      :show-close="!templatePending"
      @update:model-value="!$event && (templateEdit = null)"
    >
      <el-form v-if="templateEdit" label-position="top" data-testid="template-source-dialog" @submit.prevent="saveTemplateSource">
        <el-form-item v-if="templateEdit.target" label="目标模板">
          <span>{{ templateEdit.target.name }} · 版本 {{ templateEdit.target.version }}</span>
        </el-form-item>
        <el-form-item label="场景来源" required>
          <el-select
            v-model="templateEdit.sourceKey"
            placeholder="请选择场景"
            filterable
            :loading="sourceListPending"
            :disabled="templatePending"
            style="width: 100%"
            data-testid="template-source-select"
            @change="suggestTemplateName"
          >
            <el-option v-for="source in sceneSources" :key="source.key" :label="source.label" :value="source.key" />
          </el-select>
        </el-form-item>
        <el-alert v-if="canReadScenes && listState === 'ERROR'" type="error" :closable="false" :title="listMessage">
          <el-button link type="primary" :disabled="templatePending" @click="scenarioStore.loadScenes()">重试</el-button>
        </el-alert>
        <p v-else-if="!sourceListPending && sceneSources.length === 0" class="maintenance-note">
          {{ canReadScenes ? '暂无已保存场景。' : '当前账号无场景列表访问权限。' }}
        </p>
        <el-form-item v-if="!templateEdit.target" label="模板名称" required>
          <el-input v-model="templateEdit.name" :disabled="templatePending" data-testid="template-source-name" />
        </el-form-item>
        <p v-else class="maintenance-note">更新会以所选场景替换模板内容，并生成新版本。</p>
        <el-alert v-if="templateState === 'ERROR' && templateResultMessage" type="error" :closable="false" :title="templateResultMessage" />
      </el-form>
      <template #footer>
        <el-button :disabled="templatePending" @click="templateEdit = null">取消</el-button>
        <el-button
          type="primary"
          :loading="templatePending"
          :disabled="!selectedSource || !templateEdit?.name.trim() || sourceListPending"
          data-testid="save-template-source"
          @click="saveTemplateSource"
        >{{ templateEdit?.target ? '更新' : '新建' }}</el-button>
      </template>
    </el-dialog>

    <TemplateDetailsDialog :template="templateDetails" @close="templateDetails = null" />

    <el-dialog :model-value="templateExport !== null" :title="templateExport?.title ?? '导出预览'" width="min(760px, calc(100vw - 2rem))" append-to-body
      @update:model-value="!$event && (templateExport = null)">
      <pre v-if="templateExport" class="template-json" data-testid="template-export-preview" tabindex="0" aria-label="模板 JSON 预览">{{ templateExport.json }}</pre>
      <template #footer>
        <el-button data-testid="close-template-export" @click="templateExport = null">关闭</el-button>
        <el-button type="primary" data-testid="download-template-json" @click="downloadTemplateJson">下载 JSON</el-button>
      </template>
    </el-dialog>
  </section>

  <section v-else-if="basicDataVisible" class="page admin-page basic-data-page" aria-label="基础数据管理" data-testid="basic-data-management">
    <h2 class="basic-data-title">基础数据管理</h2>
    <el-tabs :model-value="basicCategory" aria-label="基础数据分类" @update:model-value="selectBasicCategory">
      <el-tab-pane v-if="canViewEquipment" label="设备参数" name="equipment">
        <EquipmentLibrary v-if="basicCategory === 'equipment'" />
      </el-tab-pane>
      <el-tab-pane v-if="canViewMasterData" label="通用基础数据" name="master">
        <MasterDataPanel v-if="basicCategory === 'master'" :show-title="false" />
      </el-tab-pane>
    </el-tabs>
    <el-empty v-if="!basicCategory" description="当前账号没有基础数据访问权限" />
  </section>

  <section v-else-if="auditLogsVisible" class="page admin-page" aria-label="操作审计日志">
    <AuditLog />
  </section>

  <section v-else-if="route.query.section === 'database-backup'" class="page admin-page"><BackupRestoreWizard /></section>
  <section v-else-if="route.query.section === 'simulation-data'" class="page admin-page"><ArchivePanel /></section>
  <section v-else-if="route.query.section === 'runtime-status'" class="page admin-page"><HealthPanel /></section>

  <section v-else class="page admin-page" aria-label="账号管理">
    <AccountManagement />
  </section>
</template>

<style scoped>
.admin-page {
  display: grid;
  min-width: 0;
  gap: var(--space-4, 1rem);
  padding-top: var(--space-3, 0.75rem) !important;
}

.template-maintenance-page { align-content: start; }

.maintenance-note {
  margin: 0 0 0.85rem;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.template-json {
  max-height: 55vh;
  margin: 0;
  overflow: auto;
  padding: 0.9rem;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
  font-size: 12px;
  line-height: 1.55;
}

.basic-data-page { align-content: start; }
.basic-data-title { margin: 0; font-size: 18px; }

.admin-page :deep(.maintenance-card) { display: grid; gap: 16px; min-width: 0; padding: 16px; border: 1px solid var(--el-border-color); border-radius: 8px; align-content: start; }
.admin-page :deep(.maintenance-toolbar) { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.admin-page :deep(.maintenance-toolbar h3) { margin: 0 auto 0 0; font-size: 18px; }
.admin-page :deep(.maintenance-toolbar .el-form-item) { margin: 0; }
.admin-page :deep(.maintenance-result) { display: grid; gap: 14px; }
.admin-page :deep(.maintenance-note) { margin: 0; color: var(--el-text-color-secondary); font-size: 13px; }

@media (max-width: 560px) {
  .admin-page {
    gap: var(--space-3, 0.75rem);
  }
}
</style>

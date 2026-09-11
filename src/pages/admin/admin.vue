<script setup lang="ts">
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute } from 'vue-router'
import type { ScenarioTemplate } from '../../contracts/domain-models'
import AccountManagement from '../../components/admin/AccountManagement.vue'
import AuditLog from '../../components/admin/AuditLog.vue'
import EquipmentLibrary from '../../components/admin/EquipmentLibrary.vue'
import MasterDataPanel from '../../components/admin/MasterDataPanel.vue'
import BackupRestoreWizard from '../../components/admin/BackupRestoreWizard.vue'
import ArchivePanel from '../../components/admin/ArchivePanel.vue'
import HealthPanel from '../../components/admin/HealthPanel.vue'
import TemplateLibrary from '../../components/scenarios/TemplateLibrary.vue'
import { useScenarioStore } from '../../stores/scenario'

const scenarioStore = useScenarioStore()
const {
  draft,
  templates,
  selectedTemplate,
  templateState,
  templateResultMessage,
  lastConfirmation,
} = storeToRefs(scenarioStore)
const route = useRoute()

/**
 * 判断当前是否显示系统管理中的场景模板维护页面。
 * @returns 路由查询参数选中场景模板维护时返回 `true`。
 */
const templateMaintenanceVisible = computed(() => route.query.section === 'scenario-templates')

/**
 * 判断当前是否显示装备参数库页面。
 * @returns 路由查询参数选中装备参数库时返回 `true`。
 */
const equipmentLibraryVisible = computed(() => route.query.section === 'equipment-library')

/**
 * 判断当前是否显示操作审计日志页面。
 * @returns 路由查询参数选中操作审计日志时返回 `true`。
 */
const auditLogsVisible = computed(() => route.query.section === 'audit-logs')

/**
 * 判断场景模板维护是否处于不可重复操作阶段。
 * @returns 模板正在加载、校验或执行时返回 `true`。
 */
const templatePending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(templateState.value))

/**
 * 加载模板列表；新建模板只使用用户已选择的场景，不隐式读取默认编号。
 * @returns 所有必要读取结束后兑现且不返回值的 Promise。
 * @sideEffects 仅在数据尚未加载时调用场景 Store，不重复读取已有投影。
 */
async function loadTemplateMaintenance(): Promise<void> {
  const requests: Promise<boolean>[] = []
  if (templateState.value === 'EMPTY' && templates.value.length === 0) requests.push(scenarioStore.loadTemplates())
  await Promise.all(requests)
}

/**
 * 提示管理员输入模板名称并新建官方模板。
 * @returns 操作结束后无返回值。
 * @sideEffects 确认输入后调用模板新建动作；取消不改变模板库。
 */
async function createTemplate(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('模板将保存当前完整场景草稿。', '新建场景模板', {
      confirmButtonText: '新建',
      cancelButtonText: '取消',
      inputValue: draft.value === null ? '' : `${draft.value.config.scenario.name} 模板`,
      inputValidator: (name) => name.trim() !== '' || '请输入模板名称。',
    })
    if (await scenarioStore.createTemplate(value)) ElMessage.success(templateResultMessage.value)
  } catch {
    // 用户取消输入时保持模板库不变。
  }
}

/**
 * 从 JSON 文本导入官方模板。
 * @returns 操作结束后无返回值。
 * @sideEffects 确认输入后调用模板导入动作，不访问真实文件。
 */
async function importTemplate(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('粘贴包含 name、config 及可选 uiExtensions 的模板 JSON。', '导入场景模板', {
      confirmButtonText: '导入',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputPlaceholder: '{ "name": "模板名称", "config": { ... } }',
      inputValidator: (text) => text.trim() !== '' || '请输入模板 JSON。',
    })
    if (await scenarioStore.importTemplate(value)) ElMessage.success(templateResultMessage.value)
  } catch {
    // 用户取消输入时保持模板库不变。
  }
}

/**
 * 使用当前场景草稿更新指定官方模板。
 * @param template 待更新的官方模板。
 * @returns 操作结束后无返回值。
 * @sideEffects 确认后调用模板更新动作；取消不改变模板库。
 */
async function updateTemplate(template: ScenarioTemplate): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认使用当前场景草稿更新“${template.name}”？`, '更新场景模板', {
      confirmButtonText: '更新',
      cancelButtonText: '取消',
      type: 'warning',
    })
    if (await scenarioStore.updateTemplate(template.templateId, template.name)) ElMessage.success(templateResultMessage.value)
  } catch {
    // 用户取消更新时保持模板版本不变。
  }
}

/**
 * 生成指定官方模板的 JSON 预览。
 * @param template 待导出的官方模板。
 * @returns 操作结束后无返回值。
 * @sideEffects 调用模板导出动作并通过 Element Plus 展示内存预览，不创建文件。
 */
async function exportTemplate(template: ScenarioTemplate): Promise<void> {
  const preview = await scenarioStore.exportTemplate(template.templateId)
  if (preview === undefined) return
  await ElMessageBox.alert(preview, `导出预览 · ${template.name}`, {
    confirmButtonText: '关闭',
  })
}

async function deleteTemplate(templateId: string): Promise<void> {
  if (await scenarioStore.deleteTemplate(templateId)) ElMessage.success(templateResultMessage.value)
}

watch(templateMaintenanceVisible, (visible) => {
  if (visible) void loadTemplateMaintenance()
}, { immediate: true })
</script>

<template>
  <section v-if="templateMaintenanceVisible" class="page admin-page" aria-label="场景模板维护">
    <TemplateLibrary
      :can-maintain="true"
      :allow-apply="false"
      :pending="templatePending"
      :draft-available="draft !== null"
      :draft-locked="draft?.locked ?? false"
      :templates="templates"
      :state="templateState"
      :result-message="templateResultMessage"
      :selected-template="selectedTemplate"
      :last-confirmation="lastConfirmation"
      @create="createTemplate"
      @import="importTemplate"
      @load="scenarioStore.loadTemplate"
      @update="updateTemplate"
      @export="exportTemplate"
      @delete="deleteTemplate"
    />
  </section>

  <section v-else-if="equipmentLibraryVisible" class="page admin-page">
    <EquipmentLibrary />
  </section>

  <section v-else-if="auditLogsVisible" class="page admin-page" aria-label="操作审计日志">
    <AuditLog />
  </section>

  <section v-else-if="route.query.section === 'master-data'" class="page admin-page"><MasterDataPanel /></section>
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
}

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

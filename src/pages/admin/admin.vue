<script setup lang="ts">
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessageBox } from 'element-plus'
import { useRoute } from 'vue-router'
import type { ScenarioTemplate } from '../../contracts/domain-models'
import AccountManagement from '../../components/admin/AccountManagement.vue'
import AuditLog from '../../components/admin/AuditLog.vue'
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
 * 判断当前是否显示操作审计日志空态页面。
 * @returns 路由查询参数选中操作审计日志时返回 `true`。
 */
const auditLogsVisible = computed(() => route.query.section === 'audit-logs')

/**
 * 判断场景模板维护是否处于不可重复操作阶段。
 * @returns 模板正在加载、校验或执行时返回 `true`。
 */
const templatePending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(templateState.value))

/**
 * 加载场景模板维护所需的当前场景和官方模板列表。
 * @returns 所有必要读取结束后兑现且不返回值的 Promise。
 * @sideEffects 仅在数据尚未加载时调用场景 Store，不重复读取已有投影。
 */
async function loadTemplateMaintenance(): Promise<void> {
  const requests: Promise<boolean>[] = []
  if (draft.value === null) requests.push(scenarioStore.loadScenario())
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
    const { value } = await ElMessageBox.prompt('模板将保存当前完整场景草稿。', '新建官方模板', {
      confirmButtonText: '新建',
      cancelButtonText: '取消',
      inputValue: draft.value === null ? '' : `${draft.value.config.scenario.name} 模板`,
      inputValidator: (name) => name.trim() !== '' || '请输入模板名称。',
    })
    await scenarioStore.createTemplate(value)
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
    const { value } = await ElMessageBox.prompt('粘贴只包含 name 和 config 的模板 JSON。', '导入官方模板', {
      confirmButtonText: '导入',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputPlaceholder: '{ "name": "模板名称", "config": { ... } }',
      inputValidator: (text) => text.trim() !== '' || '请输入模板 JSON。',
    })
    await scenarioStore.importTemplate(value)
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
    await ElMessageBox.confirm(`确认使用当前场景草稿更新“${template.name}”？`, '更新官方模板', {
      confirmButtonText: '更新',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await scenarioStore.updateTemplate(template.templateId, template.name)
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

watch(templateMaintenanceVisible, (visible) => {
  if (visible) void loadTemplateMaintenance()
}, { immediate: true })
</script>

<template>
  <section v-if="templateMaintenanceVisible" class="page admin-page" aria-labelledby="template-maintenance-title">
    <header class="admin-header">
      <div class="admin-header__copy">
        <p class="eyebrow">系统管理 / 模板与参数</p>
        <h2 id="template-maintenance-title">场景模板维护</h2>
        <p class="admin-header__description">维护官方场景模板及其版本，模板内容取自当前场景草稿。</p>
      </div>
    </header>

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
      @delete="scenarioStore.deleteTemplate"
    />
  </section>

  <section v-else-if="auditLogsVisible" class="page admin-page" aria-labelledby="audit-logs-title">
    <AuditLog />
  </section>

  <section v-else class="page admin-page" aria-labelledby="admin-title">
    <AccountManagement />
  </section>
</template>

<style scoped>
.admin-page {
  display: grid;
  min-width: 0;
  gap: var(--space-4, 1rem);
}

.admin-header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5, 1.5rem);
  padding-bottom: var(--space-4, 1rem);
  border-bottom: 1px solid var(--console-border);
}

.admin-header__copy {
  min-width: 0;
}

.admin-header__description {
  margin: 0;
  color: var(--console-text-muted);
  font-size: 0.88rem;
}

@media (max-width: 980px) {
  .admin-header {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 560px) {
  .admin-page {
    gap: var(--space-3, 0.75rem);
  }

  .admin-header {
    gap: var(--space-3, 0.75rem);
  }
}
</style>

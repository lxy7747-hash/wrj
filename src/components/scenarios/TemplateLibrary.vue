<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CapabilityState, ConfirmationContext, ScenarioTemplate } from '../../contracts/domain-models'

const props = withDefaults(defineProps<{
  canMaintain: boolean
  allowApply?: boolean
  pending: boolean
  draftLocked: boolean
  templates: ScenarioTemplate[]
  state: CapabilityState
  resultMessage: string
  selectedTemplate: ScenarioTemplate | null
  lastConfirmation: ConfirmationContext | null
}>(), {
  allowApply: true,
})

const emit = defineEmits<{
  create: []
  import: []
  refresh: []
  load: [templateId: string]
  copy: [template: ScenarioTemplate]
  duplicate: [template: ScenarioTemplate]
  update: [template: ScenarioTemplate]
  export: [template: ScenarioTemplate]
  delete: [templateId: string]
}>()

const keyword = ref('')
const query = computed(() => keyword.value.trim().toLowerCase())
const visibleTemplates = computed(() => {
  if (!props.canMaintain || !query.value) return props.templates
  return props.templates.filter(template =>
    template.name.toLowerCase().includes(query.value) || template.templateId.toLowerCase().includes(query.value))
})

const confirmationStateLabels: Record<ConfirmationContext['state'], string> = {
  CLOSED: '已完成',
  AWAITING_CONFIRMATION: '等待确认',
  CONFIRMED: '已确认',
  CANCELLED: '已取消',
  EXPIRED: '已过期',
  ERROR: '失败',
}
</script>

<template>
  <section class="console-panel scenario-section" :aria-labelledby="canMaintain ? undefined : 'scenario-template-title'" data-testid="template-library">
    <div class="section-heading">
      <div v-if="canMaintain" class="template-search-row">
        <el-input v-model="keyword" clearable placeholder="搜索模板名称或编号" aria-label="搜索模板名称或编号" data-testid="template-search" />
        <span role="status" class="template-count">{{ query ? `${visibleTemplates.length} / ${templates.length} 个模板` : `共 ${templates.length} 个模板` }}</span>
      </div>
      <div v-else id="scenario-template-title" class="platform-counts" aria-label="模板库权限和数量">
        <el-tag type="info">场景配置使用</el-tag>
        <el-tag>模板 {{ templates.length }}</el-tag>
      </div>
      <div v-if="canMaintain" class="platform-actions">
        <el-button :disabled="pending" data-testid="refresh-templates" @click="emit('refresh')">刷新</el-button>
        <el-button :disabled="pending" data-testid="import-template" @click="emit('import')">导入 JSON</el-button>
        <el-button type="primary" :disabled="pending" data-testid="create-template" @click="emit('create')">新建模板</el-button>
      </div>
    </div>

    <el-alert
      v-if="state === 'ERROR' && resultMessage"
      class="platform-feedback"
      type="error"
      :closable="false"
      :title="resultMessage"
      show-icon
      data-testid="template-feedback"
    />
    <div v-if="state === 'LOADING' && (!canMaintain || !templates.length)" class="console-placeholder" aria-live="polite">正在加载场景模板…</div>
    <el-empty v-else-if="templates.length === 0 && state !== 'ERROR'" description="模板库暂无数据" />
    <el-table v-else :data="visibleTemplates" :aria-busy="pending" row-key="templateId" empty-text="没有匹配的模板" stripe data-testid="template-table">
      <el-table-column v-if="!canMaintain" prop="templateId" label="模板 ID" min-width="130" />
      <el-table-column prop="name" label="模板名称" min-width="220" show-overflow-tooltip />
      <el-table-column prop="version" label="版本" width="80" />
      <el-table-column v-if="!canMaintain" label="类型" width="90"><template #default>场景模板</template></el-table-column>
      <el-table-column prop="referenceCount" label="历史引用" width="90" />
      <el-table-column label="操作" fixed="right" :width="canMaintain ? 310 : 210">
        <template #default="{ row }">
          <el-button link type="primary" :disabled="pending" :data-testid="`load-template-${row.templateId}`" @click="emit('load', row.templateId)">查看详情</el-button>
          <el-button v-if="allowApply" link type="primary" :disabled="pending || draftLocked" :data-testid="`copy-template-${row.templateId}`" @click="emit('copy', row)">应用到当前场景</el-button>
          <template v-if="canMaintain">
            <el-button link type="primary" :disabled="pending" :data-testid="`duplicate-template-${row.templateId}`" @click="emit('duplicate', row)">复制</el-button>
            <el-button link type="primary" :disabled="pending" :data-testid="`update-template-${row.templateId}`" @click="emit('update', row)">更新</el-button>
            <el-button link type="primary" :disabled="pending" :data-testid="`export-template-${row.templateId}`" @click="emit('export', row)">导出</el-button>
            <el-tooltip v-if="row.referenceCount > 0" content="已有历史引用，无法删除" placement="top">
              <span class="template-delete"><el-button link type="danger" disabled :data-testid="`delete-template-${row.templateId}`">删除</el-button></span>
            </el-tooltip>
            <el-popconfirm v-else title="确认删除该场景模板？" confirm-button-text="删除" cancel-button-text="取消" @confirm="emit('delete', row.templateId)">
              <template #reference><el-button link type="danger" :disabled="pending" :data-testid="`delete-template-${row.templateId}`">删除</el-button></template>
            </el-popconfirm>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <el-descriptions v-if="selectedTemplate" class="template-detail" :column="3" border title="模板详情" data-testid="template-detail">
      <el-descriptions-item label="模板 ID">{{ selectedTemplate.templateId }}</el-descriptions-item>
      <el-descriptions-item label="版本">{{ selectedTemplate.version }}</el-descriptions-item>
      <el-descriptions-item label="历史引用">{{ selectedTemplate.referenceCount }}</el-descriptions-item>
      <el-descriptions-item label="场景名称">{{ selectedTemplate.config.scenario.name }}</el-descriptions-item>
      <el-descriptions-item label="节点">{{ selectedTemplate.config.platforms.length }}</el-descriptions-item>
      <el-descriptions-item label="链路 / 干扰">{{ selectedTemplate.config.links.length }} / {{ selectedTemplate.config.jammers.length }}</el-descriptions-item>
    </el-descriptions>

    <el-descriptions v-if="lastConfirmation" class="template-detail" :column="2" border title="最近确认记录" data-testid="latest-confirmation">
      <el-descriptions-item label="确认编号">{{ lastConfirmation.confirmationId }}</el-descriptions-item>
      <el-descriptions-item label="最终状态">{{ confirmationStateLabels[lastConfirmation.state] }}</el-descriptions-item>
    </el-descriptions>
  </section>
</template>

<style scoped>
.scenario-section {
  padding: 1.1rem;
}

.section-heading,
.platform-counts,
.platform-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.section-heading {
  justify-content: space-between;
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--console-border);
}

.section-heading,
.platform-counts,
.platform-actions,
.template-search-row {
  flex-wrap: wrap;
}

.platform-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.template-count {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.template-search-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.template-search-row .el-input {
  width: min(100%, 290px);
}

.template-delete {
  display: inline-block;
  margin-left: 12px;
}

.template-detail {
  margin-top: 1rem;
}

.platform-feedback {
  margin-bottom: 1rem;
}
</style>

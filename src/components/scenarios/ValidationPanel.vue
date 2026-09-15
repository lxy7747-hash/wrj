<script setup lang="ts">
import { computed } from 'vue'
import type { CapabilityState, ValidationIssue, ValidationResult } from '../../contracts/domain-models'

const props = defineProps<{
  pending: boolean
  panelState: CapabilityState
  resultMessage: string
  validation: ValidationResult
  completed: boolean
}>()

const emit = defineEmits<{
  locate: [issue: ValidationIssue]
}>()

const issues = computed(() => [...props.validation.errors, ...props.validation.warnings])
</script>

<template>
  <section class="console-panel scenario-section validation-panel" aria-label="场景整体校验" data-testid="validation-panel">
    <div class="section-heading">
<!--      <div>-->
<!--        <p class="section-kicker">参数校验与冲突检测</p>-->
<!--        <h3 id="scenario-validation-title">场景整体校验</h3>-->
<!--      </div>-->
      <div class="platform-counts" aria-label="校验问题数量">
        <el-tag :type="validation.errors.length > 0 ? 'danger' : 'success'">错误 {{ validation.errors.length }}</el-tag>
        <el-tag :type="validation.warnings.length > 0 ? 'warning' : 'success'">警告 {{ validation.warnings.length }}</el-tag>
      </div>
    </div>

    <el-alert v-if="pending" type="info" :closable="false" title="正在校验当前完整场景…" show-icon />
    <el-alert
      v-else-if="panelState === 'ERROR' && issues.length === 0"
      type="error"
      :closable="false"
      :title="resultMessage"
      data-testid="validation-request-error"
      show-icon
    />
    <el-empty v-else-if="!completed && issues.length === 0" description="点击“保存”时会自动检查配置。" />
    <el-result v-else-if="issues.length === 0" icon="success" title="配置检查通过" sub-title="有未保存修改时，请点击“保存”；已保存则可进入脚本预览。" />
    <div v-else class="validation-panel__results">
      <el-alert
        :type="validation.errors.length > 0 ? 'error' : 'warning'"
        :closable="false"
        :title="resultMessage"
        show-icon
      />
      <ul class="validation-panel__list" aria-label="场景校验问题">
        <li v-for="(issue, index) in issues" :key="`${issue.severity}-${issue.code}-${issue.fieldPath}`">
          <button
            type="button"
            class="validation-issue"
            :data-testid="`locate-validation-issue-${index}`"
            @click="emit('locate', issue)"
          >
            <el-tag :type="issue.severity === 'ERROR' ? 'danger' : 'warning'" size="small">
              {{ issue.severity === 'ERROR' ? '错误' : '警告' }}
            </el-tag>
            <code>{{ issue.fieldPath }}</code>
            <span>{{ issue.message }}</span>
            <strong>定位</strong>
          </button>
        </li>
      </ul>
      <p v-if="validation.errors.length === 0 && validation.warnings.length > 0" class="validation-panel__notice">
        警告不阻断保存；生成脚本前需要完成一次确认。
      </p>
    </div>
  </section>
</template>

<style scoped>
.scenario-section {
  padding: 1.1rem;
}

.section-heading,
.platform-counts {
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

.section-heading h3,
.section-kicker {
  margin: 0;
}

.section-kicker {
  margin-bottom: 0.25rem;
  color: var(--console-cyan);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.platform-counts {
  flex-wrap: wrap;
}

.validation-panel__results,
.validation-panel__list {
  display: grid;
}

.validation-panel__results {
  gap: 0.875rem;
}

.validation-panel__list {
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.validation-issue {
  display: grid;
  width: 100%;
  grid-template-columns: auto minmax(12rem, 0.75fr) minmax(16rem, 1.5fr) auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--console-border);
  border-radius: 6px;
  background: color-mix(in srgb, var(--console-panel) 88%, transparent);
  color: var(--console-text);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.validation-issue:hover,
.validation-issue:focus-visible {
  border-color: var(--console-cyan);
  outline: none;
}

.validation-issue code,
.validation-issue strong {
  color: var(--console-cyan);
}

.validation-panel__notice {
  margin: 0;
  color: var(--console-text-muted);
}
</style>

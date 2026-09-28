<script setup lang="ts">
import { computed } from 'vue'
import { formatDateTime } from '../../features/shared/date-time'
import type { CapabilityState, ScriptContract, ValidationResult } from '../../contracts/domain-models'

const props = defineProps<{
  state: CapabilityState
  resultMessage: string
  script: ScriptContract | null
  preflight: ValidationResult
  locked: boolean
  dirty: boolean
  preflightPassed: boolean
}>()

const emit = defineEmits<{
  generate: []
  preflight: []
}>()

const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(props.state))
const issues = computed(() => [...props.preflight.errors, ...props.preflight.warnings])

/** 从脚本字段路径读取一基行号和列号。 */
function scriptLocation(fieldPath: string): string {
  const location = /^preview\[(\d+):(\d+)\]$/.exec(fieldPath)
  return location === null ? '—' : `${location[1]}:${location[2]}`
}
</script>

<template>
  <section class="console-panel scenario-section" aria-label="脚本预览及预检" data-testid="script-preview-panel">
<!--    <div class="section-heading">-->
<!--      <div>-->
<!--        <p class="section-kicker">T-XQ-008</p>-->
<!--        <h3 id="scenario-script-title">脚本预览及预检</h3>-->
<!--      </div>-->
<!--    </div>-->
    <el-alert v-if="resultMessage && state !== 'EMPTY'" :title="resultMessage" :type="state === 'ERROR' ? 'error' : 'info'" :closable="false" show-icon />
    <p class="script-guidance" data-testid="script-next-step">
      {{ preflightPassed ? '预检已通过；保存场景时由本机服务写入 TXT，不会启动真实 AFSIM。' : script ? '下一步：点击“执行预检”。如重新生成预览，需要重新预检。' : dirty ? '请先点击上方“保存”，生成 TXT 后可执行预检。' : '场景已保存：点击“保存”可重新生成 TXT。生成预览不会启动仿真。' }}
    </p>
    <div class="platform-actions">
      <el-tooltip content="请先保存草稿" placement="top" :disabled="!dirty">
        <span class="script-action-tooltip">
          <el-button :type="script === null ? 'primary' : 'default'" :loading="pending" :disabled="locked || dirty" data-testid="generate-script" @click="emit('generate')">生成脚本预览</el-button>
        </span>
      </el-tooltip>
      <el-button :type="script !== null && !preflightPassed ? 'primary' : 'default'" :loading="pending" :disabled="script === null" data-testid="preflight-script" @click="emit('preflight')">执行预检</el-button>
    </div>
    <template v-if="script">
      <el-descriptions :column="2" border>
        <el-descriptions-item label="目标版本">{{ script.target }}</el-descriptions-item>
        <el-descriptions-item label="配置版本">{{ script.configVersion }}</el-descriptions-item>
        <el-descriptions-item label="校验和">{{ script.checksum }}</el-descriptions-item>
        <el-descriptions-item label="脚本编号">{{ script.scriptId }}</el-descriptions-item>
        <el-descriptions-item label="生成时间">{{ formatDateTime(script.generatedTime) }}</el-descriptions-item>
      </el-descriptions>
      <pre class="scenario-script-preview" data-testid="script-preview">{{ script.preview }}</pre>
    </template>
    <el-table v-if="issues.length" :data="issues" stripe data-testid="preflight-issues">
      <el-table-column prop="severity" label="级别" width="90" />
      <el-table-column prop="code" label="代码" min-width="180" />
      <el-table-column label="行:列" width="90"><template #default="{ row }">{{ scriptLocation(row.fieldPath) }}</template></el-table-column>
      <el-table-column prop="message" label="问题" min-width="280" />
    </el-table>
  </section>
</template>

<style scoped>
.scenario-section {
  padding: 1.1rem;
}

.script-guidance {
  color: var(--console-text-muted);
  line-height: 1.6;
}

.section-heading,
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

.platform-actions {
  flex-wrap: wrap;
  margin-top: 1rem;
}

.script-action-tooltip {
  display: inline-flex;
}

.scenario-script-preview {
  max-height: 32rem;
  margin: 1rem 0 0;
  padding: 1rem;
  overflow: auto;
  border: 1px solid var(--console-border);
  border-radius: 4px;
  background: var(--console-bg-elevated);
  color: var(--console-text);
  font: 12px/1.6 Consolas, monospace;
  white-space: pre;
}
</style>

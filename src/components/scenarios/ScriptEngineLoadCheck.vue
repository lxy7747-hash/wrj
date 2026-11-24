<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { checkScriptPackageEngineLoad, type ScriptEngineLoadCheckResult } from '../../features/scenarios/script-file'
import {
  extractScriptPackageEngineCheckRequest,
  type ScriptPackagePreflightResult,
} from '../../features/scenarios/script-package-preflight'

const props = defineProps<{
  files: readonly File[]
  preflight: ScriptPackagePreflightResult
}>()

const checking = ref(false)
const errorMessage = ref('')
const result = shallowRef<ScriptEngineLoadCheckResult | null>(null)
let sequence = 0

watch(() => props.preflight, () => {
  sequence += 1
  checking.value = false
  errorMessage.value = ''
  result.value = null
}, { flush: 'sync' })

const canRun = computed(() =>
  props.files.length > 0
  && props.preflight.identity !== null
  && props.preflight.entryState === 'present',
)

const statusMeta = computed(() => {
  const current = result.value
  if (!current) return null
  return current.passed
    ? { type: 'success' as const, title: '引擎加载检查通过' }
    : { type: 'error' as const, title: '引擎加载检查未通过' }
})

const linkCalcLabel = computed(() => {
  const current = result.value
  if (!current) return '—'
  if (current.linkCalcChecked && current.linkCalcSupported) return '已校验通过'
  if (!current.linkCalcSupported) return '未安装（占位检查）'
  return '未通过'
})

const platformCountLabel = computed(() => {
  const current = result.value
  if (!current) return '—'
  const configured = current.expected.configuredPlatforms
  return configured === null ? `${current.loaded.platforms}（脚本 ${current.expected.platforms}）` : `${current.loaded.platforms} / ${configured}`
})

async function runCheck(): Promise<void> {
  if (!canRun.value || checking.value) return
  const ticket = ++sequence
  checking.value = true
  errorMessage.value = ''
  try {
    const payload = await extractScriptPackageEngineCheckRequest(props.files, props.preflight)
    if (ticket !== sequence) return
    const data = await checkScriptPackageEngineLoad(payload)
    if (ticket !== sequence) return
    result.value = data
  } catch (error) {
    if (ticket !== sequence) return
    result.value = null
    errorMessage.value = error instanceof Error ? error.message : '引擎加载检查失败。'
  } finally {
    if (ticket === sequence) checking.value = false
  }
}

defineExpose({ checking, result, runCheck })
</script>

<template>
  <section class="engine-load-check" aria-label="仿真引擎加载检查" data-testid="engine-load-check">
    <div class="engine-load-check__bar">
      <strong>仿真引擎加载检查</strong>
      <el-button
        type="primary"
        plain
        size="small"
        :loading="checking"
        :disabled="!canRun"
        data-testid="run-engine-load-check"
        @click="runCheck"
      >
        {{ result ? '重新执行加载检查' : '执行引擎加载检查' }}
      </el-button>
    </div>

    <p v-if="checking" class="engine-load-check__note" role="status">正在调用本机 AFSIM 引擎加载脚本包并核对平台与设备数量…</p>

    <el-alert
      v-if="errorMessage"
      type="error"
      :title="errorMessage"
      :closable="false"
      show-icon
      data-testid="engine-load-check-error"
    />

    <div v-if="result && statusMeta" class="engine-load-check__result" data-testid="engine-load-check-result">
      <el-alert
        :type="statusMeta.type"
        :title="`${statusMeta.title} · 耗时 ${result.elapsedMs} ms${result.cached ? '（缓存命中）' : ''}${result.engineVersion ? ` · ${result.engineVersion}` : ''}`"
        :closable="false"
        show-icon
      />

      <dl class="engine-load-check__overview" data-testid="engine-load-check-overview">
        <div>
          <dt>语法与输入解析</dt>
          <dd>{{ result.syntaxPassed ? '通过（无语法错误）' : '失败' }}</dd>
        </div>
        <div>
          <dt>LinkCalc 插件</dt>
          <dd>{{ linkCalcLabel }}</dd>
        </div>
        <div>
          <dt>平台数量（实载 / 场景）</dt>
          <dd>{{ platformCountLabel }}</dd>
        </div>
        <div>
          <dt>设备数量（通信 / 传感 / 干扰）</dt>
          <dd>{{ result.loaded.comms }} / {{ result.loaded.sensors }} / {{ result.loaded.weapons }}</dd>
        </div>
      </dl>

      <ul v-if="result.errors.length" class="engine-load-check__issues" aria-label="引擎加载错误明细" data-testid="engine-load-check-issues">
        <li v-for="(item, index) in result.errors" :key="`err-${index}`" class="is-error">错误 · {{ item }}</li>
      </ul>

      <template v-if="result.platforms.length">
        <h4 class="engine-load-check__subtitle">引擎实载平台与设备明细（{{ result.platforms.length }} 个平台）</h4>
        <div class="engine-load-check__table-wrap" role="region" aria-label="引擎实载平台明细" tabindex="0" data-testid="engine-load-check-platforms">
          <table>
            <thead>
              <tr>
                <th scope="col">平台实例</th>
                <th scope="col">平台类型</th>
                <th scope="col">通信设备</th>
                <th scope="col">传感器</th>
                <th scope="col">干扰武器</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="platform in result.platforms" :key="platform.name">
                <th scope="row"><code>{{ platform.name }}</code></th>
                <td><code>{{ platform.type }}</code></td>
                <td>{{ platform.commCount }}</td>
                <td>{{ platform.sensorCount }}</td>
                <td>{{ platform.weaponCount }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.engine-load-check {
  display: grid;
  gap: var(--space-3);
  margin: var(--space-3) 0;
  padding: var(--space-3);
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background: var(--console-bg-elevated);
}

.engine-load-check__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.engine-load-check__bar > strong {
  color: var(--console-text);
  font-size: 0.9375rem;
}

.engine-load-check__note {
  margin: 0;
  color: var(--console-text-muted);
  font-size: 0.8125rem;
  line-height: 1.5;
}

.engine-load-check__result {
  display: grid;
  gap: var(--space-3);
}

.engine-load-check__overview {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
  margin: 0;
}

.engine-load-check__overview > div {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background: var(--console-surface);
}

.engine-load-check__overview dt {
  color: var(--console-text-muted);
  font-size: 0.75rem;
}

.engine-load-check__overview dd {
  margin: var(--space-1) 0 0;
  color: var(--console-text);
  font-weight: 600;
  font-size: 0.875rem;
}

.engine-load-check__issues {
  margin: 0;
  padding: var(--space-2) var(--space-3) var(--space-2) 1.5rem;
  max-height: 10rem;
  overflow: auto;
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background: var(--console-surface);
  font-size: 0.8125rem;
  line-height: 1.55;
}

.engine-load-check__issues .is-error { color: var(--el-color-danger); }
.engine-load-check__issues .is-warning { color: var(--el-color-warning); }

.engine-load-check__subtitle {
  margin: 0;
  color: var(--console-text);
  font-size: 0.875rem;
}

.engine-load-check__table-wrap {
  max-height: min(16rem, 30vh);
  overflow: auto;
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background: var(--console-surface);
}

.engine-load-check__table-wrap table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.8125rem;
}

.engine-load-check__table-wrap th,
.engine-load-check__table-wrap td {
  padding: var(--space-2) var(--space-3);
  text-align: left;
  border-bottom: 1px solid var(--console-border);
  white-space: nowrap;
}

.engine-load-check__table-wrap thead th {
  position: sticky;
  top: 0;
  background: var(--console-surface-raised);
  color: var(--console-text-muted);
  font-weight: 600;
}

.engine-load-check__table-wrap tbody th {
  font-weight: 500;
  color: var(--console-text);
}

@media (max-width: 720px) {
  .engine-load-check__overview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

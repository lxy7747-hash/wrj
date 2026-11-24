<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { inspectScriptPackageFolder, type ScriptGenerationReceipt, type ScriptPackagePreflightResult } from '../../features/scenarios/script-package-preflight'
import ScriptEngineLoadCheck from './ScriptEngineLoadCheck.vue'

const props = defineProps<{
  receipt: ScriptGenerationReceipt | null
  currentScene: { scenarioId: string; revision: number; dirty: boolean } | null
}>()
const visible = defineModel<boolean>({ required: true })
const folderInput = ref<HTMLInputElement | null>(null)
const checking = ref(false)
const result = shallowRef<ScriptPackagePreflightResult | null>(null)
const selectedFiles = shallowRef<readonly File[]>([])
const preflightMode = computed(() => checking.value || result.value !== null)
let preflightSequence = 0

const entryLabels: Record<ScriptPackagePreflightResult['entryState'], string> = {
  unchecked: '未检查',
  missing: '文件缺失',
  unreadable: '无法读取',
  empty: '无脚本内容',
  present: '有脚本内容',
}
const fileStatuses = {
  unchecked: { label: '未完成', type: 'info' },
  missing: { label: '文件缺失', type: 'danger' },
  unreadable: { label: '无法读取', type: 'danger' },
  error: { label: '有错误', type: 'danger' },
  warning: { label: '待确认', type: 'warning' },
  checked: { label: '已检查', type: 'success' },
} as const

function fileStatus(file: ScriptPackagePreflightResult['scriptFiles'][number]) {
  if (file.state !== 'checked') return fileStatuses[file.state]
  const isEmptyEntry = result.value?.entryState === 'empty' && file.path === result.value.identity?.entry
  if (isEmptyEntry || file.referenceErrors || file.structureErrors) return fileStatuses.error
  return file.referenceWarnings ? fileStatuses.warning : fileStatuses.checked
}

const preflightRows = computed(() => (result.value?.scriptFiles ?? []).map(file => ({ ...file, status: fileStatus(file) })))
const preflightSummary = computed(() => {
  const checked = preflightRows.value.filter(file => file.state === 'checked')
  return {
    hasCheckedFiles: checked.length > 0,
    references: checked.reduce((sum, file) => sum + file.references, 0),
    closedBlocks: checked.reduce((sum, file) => sum + file.closedBlocks, 0),
    incomplete: preflightRows.value.some(file => file.state !== 'checked'),
  }
})

const sceneNote = computed(() => {
  const identity = result.value?.identity
  const current = props.currentScene
  if (!identity || !current) return ''
  if (identity.scenarioId !== current.scenarioId) return '所选脚本包属于其他场景。'
  if (current.revision === 0) return '当前场景尚未保存。'
  if (identity.revision !== current.revision) return `当前场景为修订 ${current.revision}。`
  return current.dirty ? '当前场景有未保存的修改。' : ''
})

watch(() => props.receipt, () => {
  preflightSequence++
  result.value = null
  selectedFiles.value = []
  checking.value = false
}, { flush: 'sync' })

function openFolderPicker(): void {
  if (!checking.value) folderInput.value?.click()
}

defineExpose({ checking, openFolderPicker })

async function preflightFolder(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length || checking.value) return

  const sequence = ++preflightSequence
  result.value = null
  selectedFiles.value = files
  checking.value = true
  visible.value = true
  try {
    const checked = await inspectScriptPackageFolder(files)
    if (preflightSequence === sequence) result.value = checked
  } catch {
    if (preflightSequence === sequence) result.value = {
      folder: '', identity: null, entryState: 'unchecked', filesExpected: 0, filesPresent: 0, referencesChecked: 0, scriptFiles: [],
      errors: ['读取所选文件夹失败，请重新选择。'], warnings: [],
    }
  } finally {
    if (preflightSequence === sequence) checking.value = false
  }
}
</script>

<template>
  <input
    ref="folderInput"
    type="file"
    webkitdirectory
    multiple
    hidden
    aria-label="选择生成包所在文件夹"
    data-testid="script-preflight-folder-input"
    @change="preflightFolder"
  />
  <el-dialog
    v-model="visible"
    class="scenario-dialog script-generation-dialog"
    :class="{ 'script-preflight-dialog': preflightMode }"
    :title="preflightMode ? '脚本包结构预检' : '脚本生成成功'"
    :width="preflightMode ? 'min(920px, calc(100vw - 2rem))' : 'min(720px, calc(100vw - 2rem))'"
    :top="preflightMode ? '1rem' : undefined"
    data-testid="script-generation-receipt"
    destroy-on-close
  >
    <template v-if="receipt && !preflightMode">
      <dl class="script-generation-details">
        <div><dt>脚本路径</dt><dd><code>{{ receipt.path }}</code></dd></div>
        <div><dt>场景版本号</dt><dd><code>{{ receipt.version }}</code></dd></div>
      </dl>
      <p class="script-preflight-note">可在编辑页点击「执行预检」，选择脚本路径所在的生成包根目录。</p>
      <h4 class="script-generation-log-title">生成日志</h4>
      <ul class="script-generation-receipt-log" data-testid="script-generation-receipt-log">
        <li v-for="(line, index) in receipt.log" :key="index">{{ line }}</li>
      </ul>
    </template>
    <p v-if="checking" class="script-preflight-note" role="status">正在检查所选文件夹…</p>
    <section v-if="result" class="script-folder-preflight" aria-label="结构预检结果" data-testid="script-folder-preflight-result">
      <el-alert
        :title="result.errors.length ? '结构预检有错误' : result.warnings.length ? '结构预检有待确认项' : '结构预检通过'"
        :type="result.errors.length ? 'error' : result.warnings.length ? 'warning' : 'success'"
        :closable="false"
        show-icon
      />
      <p v-if="result.folder" class="script-preflight-note">所选文件夹 {{ result.folder }}</p>
      <dl v-if="result.identity" class="script-generation-details script-preflight-identity">
        <div><dt>所选场景</dt><dd><code>{{ result.identity.scenarioId }}</code></dd></div>
        <div><dt>所选修订</dt><dd>{{ result.identity.revision }}</dd></div>
        <div><dt>入口文件</dt><dd><code>{{ result.identity.entry }}</code></dd></div>
      </dl>
      <p v-if="sceneNote" class="script-preflight-note">{{ sceneNote }}</p>
      <dl class="script-preflight-overview" data-testid="script-preflight-overview">
        <div><dt>入口状态</dt><dd>{{ entryLabels[result.entryState] }}</dd></div>
        <div><dt>清单文件</dt><dd>{{ result.filesExpected ? `${result.filesPresent} / ${result.filesExpected}` : '未统计' }}</dd></div>
        <div><dt>包含引用</dt><dd>{{ preflightSummary.hasCheckedFiles ? `${preflightSummary.references} 条` : '未统计' }}</dd></div>
        <div><dt>配对定义块</dt><dd>{{ preflightSummary.closedBlocks ? `${preflightSummary.closedBlocks} 个` : preflightSummary.hasCheckedFiles ? '未发现' : '未统计' }}</dd></div>
      </dl>
      <p v-if="preflightSummary.incomplete && preflightSummary.hasCheckedFiles" class="script-preflight-note">引用和定义块数量来自已完成检查的文件。</p>
      <ScriptEngineLoadCheck :files="selectedFiles" :preflight="result" />
      <ul v-if="result.errors.length || result.warnings.length" class="script-generation-receipt-log script-preflight-issues" aria-label="预检问题" tabindex="0">
        <li v-for="(issue, index) in result.errors" :key="`error-${index}`">{{ issue }}</li>
        <li v-for="(issue, index) in result.warnings" :key="`warning-${index}`">待确认 · {{ issue }}</li>
      </ul>
      <template v-if="preflightRows.length">
        <h4 class="script-generation-log-title">TXT 文件明细（{{ preflightRows.length }} 个）</h4>
        <div class="script-preflight-files" role="region" aria-label="TXT 文件明细" tabindex="0" data-testid="script-preflight-script-files">
          <table>
            <thead>
              <tr><th scope="col">文件</th><th scope="col">包含引用</th><th scope="col">配对定义块</th><th scope="col">状态</th></tr>
            </thead>
            <tbody>
              <tr v-for="file in preflightRows" :key="file.path">
                <th scope="row"><code>{{ file.path }}</code></th>
                <td>{{ file.state === 'checked' ? file.references : '—' }}</td>
                <td>{{ file.state === 'checked' && file.closedBlocks ? file.closedBlocks : '—' }}</td>
                <td><el-tag :type="file.status.type" size="small">{{ file.status.label }}</el-tag></td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>
    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
:global(.el-dialog.script-generation-dialog) {
  --el-dialog-bg-color: var(--console-surface);
  --el-dialog-border-radius: var(--console-radius);
  border: 1px solid var(--console-border);
}

:global(.script-generation-dialog .el-dialog__title) { color: var(--console-text); font-weight: 600; }
:global(.el-dialog.script-preflight-dialog) { display: flex; flex-direction: column; max-height: calc(100dvh - 2rem); }
:global(.script-preflight-dialog > .el-dialog__body) { min-height: 0; overflow: auto; }
:global(.script-preflight-dialog > :is(.el-dialog__header, .el-dialog__footer)) { flex-shrink: 0; }
.script-generation-details { margin: 0; border: 1px solid var(--console-border); border-radius: var(--console-radius); }
.script-generation-details > div { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: var(--space-3); padding: var(--space-3); }
.script-generation-details > div + div { border-top: 1px solid var(--console-border); }
.script-generation-details dt, .script-generation-receipt-log, .script-preflight-note { color: var(--console-text-muted); }
.script-generation-details dd { margin: 0; color: var(--console-text); overflow-wrap: anywhere; }
.script-generation-log-title { margin: var(--space-4) 0 var(--space-2); color: var(--console-text); }
.script-generation-receipt-log { margin: 0; padding: var(--space-2) var(--space-3); background: var(--console-bg); border-radius: var(--console-radius); list-style: none; overflow-wrap: anywhere; }
.script-generation-receipt-log li { padding-block: var(--space-1); }
.script-preflight-note { margin: var(--space-2) 0; overflow-wrap: anywhere; }
.script-folder-preflight { margin-top: var(--space-3); }
.script-preflight-identity, .script-preflight-overview { display: grid; gap: var(--space-2); }
.script-preflight-identity { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.script-preflight-identity > div { display: block; }
.script-preflight-identity > div + div { border-top: 0; border-left: 1px solid var(--console-border); }
.script-preflight-overview { grid-template-columns: repeat(4, minmax(0, 1fr)); margin: var(--space-3) 0; }
.script-preflight-overview > div { padding: var(--space-2) var(--space-3); background: var(--console-bg); border-radius: var(--console-radius); }
.script-preflight-overview dt { color: var(--console-text-muted); }
.script-preflight-overview dd, .script-preflight-identity dd { margin: var(--space-1) 0 0; }
.script-preflight-overview dd { color: var(--console-text); font-weight: 600; }
.script-preflight-issues { max-height: min(12rem, 26vh); overflow: auto; }
.script-preflight-files { max-height: min(20rem, 34vh); overflow: auto; border: 1px solid var(--console-border); border-radius: var(--console-radius); color: var(--console-text); }
.script-preflight-files table { width: 100%; border-collapse: separate; border-spacing: 0; }
.script-preflight-files th, .script-preflight-files td { padding: var(--space-2) var(--space-3); text-align: left; }
.script-preflight-files thead th { position: sticky; top: 0; background: var(--console-surface-raised); color: var(--console-text-muted); white-space: nowrap; }
.script-preflight-files tbody th { width: 55%; font-weight: 400; overflow-wrap: anywhere; }
.script-preflight-files tbody td { white-space: nowrap; }
.script-preflight-files tbody tr + tr > * { border-top: 1px solid var(--console-border); }

@media (max-width: 640px) {
  .script-preflight-identity { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .script-preflight-identity > div { display: grid; }
  .script-preflight-identity > div + div { border-top: 1px solid var(--console-border); border-left: 0; }
  .script-preflight-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .script-preflight-files th, .script-preflight-files td { padding-inline: var(--space-2); }
}
</style>

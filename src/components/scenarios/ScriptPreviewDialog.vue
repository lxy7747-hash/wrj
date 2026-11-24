<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import type { ScenarioDraft, ScriptContract } from '../../contracts/domain-models'
import { readScriptAcceptanceReview, type ScriptAcceptanceEntry } from '../../features/scenarios/script-execution-status'
import { formatValidationFieldLabel } from '../../features/scenarios/validation-field-labels'

const props = defineProps<{ script: ScriptContract | null; draft: ScenarioDraft | null }>()
const visible = defineModel<boolean>({ required: true })
const tab = ref('source')
const definitionTab = ref('platform')
const scroller = ref<HTMLElement | null>(null)
const location = shallowRef<ScriptAcceptanceEntry['location']>(null)

const groupLabels = {
  platform: '平台定义',
  communication: '通信定义',
  sensor: '传感器定义',
  jammer: '干扰定义',
  timeline: '时序定义',
} satisfies Record<ScriptAcceptanceEntry['group'], string>
const statusLabels = {
  emitted: '已写入脚本',
  retainedSnapshot: '仅保留快照',
  dependencyUnconfirmed: '依赖待确认',
} satisfies Record<ScriptAcceptanceEntry['status'], string>
const text = computed(() => props.script?.preview ?? '')
const review = computed(() => readScriptAcceptanceReview(text.value))
const groups = computed(() => Object.entries(groupLabels).map(([key, label]) => ({
  key, label, rows: review.value?.filter(row => row.group === key) ?? [],
})))
const lineNumbers = computed(() => text.value.split(/\r\n?|\n/).map((_, index) => index + 1).join('\n'))

function lineLabel(line: number, target: NonNullable<ScriptAcceptanceEntry['location']>): string {
  return target.endPreviewLine === undefined ? String(line) : `${line}–${line + target.endPreviewLine - target.previewLine}`
}

function sourceParts(source: string) {
  return source.split(/^(\/\/ ===== [^\r\n]+ =====\r?)$/m).map((content, index) => ({
    content, heading: index % 2 === 1, target: false,
  }))
}

const parts = computed(() => {
  if (!location.value) return sourceParts(text.value)
  // Keep the line endings in the split so selecting a location does not change the copied text.
  const lines = text.value.split(/(\r\n|\r|\n)/)
  const index = (location.value.previewLine - 1) * 2
  const end = ((location.value.endPreviewLine ?? location.value.previewLine) - 1) * 2
  if (lines[index] === undefined || lines[end] === undefined) return sourceParts(text.value)
  return [
    ...sourceParts(lines.slice(0, index).join('')),
    { content: lines.slice(index, end + 1).join(''), heading: false, target: true },
    ...sourceParts(lines.slice(end + 1).join('')),
  ]
})

watch([visible, text], () => {
  tab.value = 'source'
  definitionTab.value = 'platform'
  location.value = null
})

async function jumpToSource(target: NonNullable<ScriptAcceptanceEntry['location']>): Promise<void> {
  location.value = target
  tab.value = 'source'
  await nextTick()
  const viewport = scroller.value
  const line = viewport?.querySelector<HTMLElement>('.script-preview-target-line')
  if (!viewport || !line || location.value !== target) return
  const top = line.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  viewport.scrollTop += top - viewport.clientHeight / 3
  viewport.scrollLeft = 0
  viewport.focus({ preventScroll: true })
}
</script>

<template>
  <el-dialog
    v-model="visible"
    class="scenario-dialog script-preview-dialog"
    title="脚本预览"
    width="min(1080px, calc(100vw - 2rem))"
    data-testid="script-preview-dialog"
    destroy-on-close
  >
    <div v-if="script && draft" class="script-preview-viewer">
      <div class="script-preview-meta">
        <span class="script-preview-scene" :title="draft.config.scenario.name">{{ draft.config.scenario.name }}</span>
        <span>修订 {{ draft.revision }}</span>
        <span class="script-preview-checksum" :title="script.checksum">校验和 {{ script.checksum }}</span>
      </div>
      <el-tabs v-model="tab" class="script-preview-tabs">
        <el-tab-pane label="脚本原文" name="source">
          <p v-if="location" class="script-preview-location" role="status">
            {{ location.fileName }} 第 {{ lineLabel(location.fileLine, location) }} 行 · 预览第 {{ lineLabel(location.previewLine, location) }} 行
          </p>
          <div ref="scroller" class="script-preview-scroll" data-testid="script-preview-scroll" role="region" aria-label="脚本文本" tabindex="0">
            <div class="script-preview-lines">
              <pre class="script-preview-gutter" aria-hidden="true" v-text="lineNumbers" />
              <pre class="standalone-script-preview" data-testid="standalone-script-preview"><code><span v-for="(part, index) in parts" :key="index" :class="{ 'script-preview-section': part.heading, 'script-preview-target-line': part.target }" :data-testid="part.target ? 'script-preview-target-line' : undefined" v-text="part.content" /></code></pre>
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane label="验收核对" name="acceptance" lazy>
          <div class="script-review" data-testid="script-acceptance-review">
            <p class="script-review-note">TXT 行号定位脚本定义，清单行号定位生成记录。目标引擎加载未验证。</p>
            <el-tabs v-model="definitionTab" class="script-definition-tabs">
              <el-tab-pane v-for="group in groups" :key="group.key" :label="group.label" :name="group.key" lazy>
                <section class="script-review-group" :data-testid="`script-acceptance-group-${group.key}`" :aria-label="group.label">
                  <p v-if="review === null" class="script-review-note">本次预览未提供可读取的生成清单。</p>
                  <p v-else-if="!group.rows.length" class="script-review-note">本次生成清单未记录此分组。</p>
                  <ul v-else class="script-review-list">
                    <li v-for="(row, index) in group.rows" :key="index" class="script-review-row">
                      <div class="script-review-description">
                        <strong>{{ row.fieldPath === 'references.entry' ? '入口引用' : formatValidationFieldLabel(row.fieldPath, draft.config) }}</strong>
                        <p>{{ row.detail }}</p>
                      </div>
                      <span class="script-review-state" :class="`is-${row.status}`">{{ statusLabels[row.status] }}</span>
                      <el-button v-if="row.location" link type="primary" data-testid="script-acceptance-source" @click="jumpToSource(row.location)">
                        {{ row.location.fileName === 'mapping.json' ? '清单 ' : '' }}{{ row.location.fileName }}:{{ lineLabel(row.location.fileLine, row.location) }}
                      </el-button>
                      <span v-else class="script-review-note">位置未记录</span>
                    </li>
                  </ul>
                </section>
              </el-tab-pane>
            </el-tabs>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
    <template #footer><el-button class="script-preview-close" @click="visible = false">关闭</el-button></template>
  </el-dialog>
</template>

<style scoped>
:global(.el-dialog.script-preview-dialog) {
  --el-dialog-bg-color: var(--console-surface);
  --el-dialog-border-radius: var(--console-radius);
  border: 1px solid var(--console-border);
}

:global(.script-preview-dialog .el-dialog__title) { color: var(--console-text); font-weight: 600; }
:global(.script-preview-dialog > .el-dialog__body) { display: flex; overflow: hidden; }

.script-preview-close {
  --el-button-bg-color: var(--console-surface-raised);
  --el-button-border-color: var(--console-border);
  --el-button-text-color: var(--console-text);
  --el-button-hover-bg-color: var(--console-surface-raised);
  --el-button-hover-border-color: var(--console-cyan);
  --el-button-hover-text-color: var(--console-cyan);
}

.script-preview-viewer {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background: var(--console-bg);
}

.script-preview-meta {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--console-border);
  color: var(--console-text-muted);
  background: var(--console-surface-raised);
  white-space: nowrap;
}

.script-preview-scene { flex: 1 1 12rem; overflow: hidden; color: var(--console-text); font-weight: 600; text-overflow: ellipsis; }
.script-preview-checksum { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.script-preview-tabs { display: flex; flex-direction: column; min-height: 0; }
.script-preview-tabs :deep(.el-tabs__header) { flex: none; margin: 0; padding-inline: var(--space-4); }
.script-preview-tabs :deep(.el-tabs__item) { color: var(--console-text-muted); }
.script-preview-tabs :deep(.el-tabs__item.is-active),
.script-preview-tabs :deep(.el-tabs__item:hover) { color: var(--console-cyan); }
.script-preview-tabs :deep(.el-tabs__active-bar) { background-color: var(--console-cyan); }
.script-preview-tabs :deep(.el-tabs__nav-wrap)::after { background-color: var(--console-border); }
.script-preview-tabs :deep(.el-tabs__content) { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.script-preview-tabs :deep(.el-tab-pane) { display: flex; min-height: 0; flex-direction: column; max-height: min(62dvh, 42rem); }
.script-preview-location { flex: none; margin: 0; padding: var(--space-2) var(--space-4); color: var(--console-cyan); }
.script-preview-scroll, .script-review-group { min-height: 0; overflow: auto; overscroll-behavior: contain; }
.script-preview-scroll:focus-visible { outline: 1px solid var(--console-cyan); outline-offset: -1px; }
.script-preview-lines { display: flex; min-width: 100%; width: max-content; }

.script-preview-lines pre {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  font: 0.8125rem/1.65 Consolas, 'SFMono-Regular', ui-monospace, monospace;
  tab-size: 4;
  white-space: pre;
}

.script-preview-gutter {
  position: sticky;
  left: 0;
  min-width: 3rem;
  border-right: 1px solid var(--console-border);
  color: var(--console-text-muted);
  background: var(--console-bg-elevated);
  text-align: right;
  user-select: none;
}

.standalone-script-preview { color: var(--console-text); }
.standalone-script-preview code { font: inherit; }
.script-preview-section { color: var(--console-cyan); font-weight: 600; }
.script-preview-target-line { background: var(--console-surface-raised); color: var(--console-cyan); }

.script-review, .script-definition-tabs { display: flex; min-height: 0; flex-direction: column; }
.script-review > .script-review-note { flex: none; padding: var(--space-3) var(--space-4); }
.script-definition-tabs :deep(.el-tabs__header) { background: var(--console-bg-elevated); }
.script-definition-tabs :deep(.el-tabs__item) { height: 36px; padding-inline: var(--space-3); }
.script-review-group { padding: var(--space-3) var(--space-4); }
.script-review-note { margin: 0; color: var(--console-text-muted); }
.script-review-list { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--console-border); }
.script-review-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: start;
  gap: var(--space-2) var(--space-4);
  padding-block: var(--space-3);
  border-bottom: 1px solid var(--console-border);
}
.script-review-description { color: var(--console-text); overflow-wrap: anywhere; }
.script-review-description p { margin: var(--space-1) 0 0; color: var(--console-text-muted); }
.script-review-state { color: var(--console-text-muted); white-space: nowrap; }
.script-review-state.is-emitted { color: var(--console-teal); }
.script-review-state.is-dependencyUnconfirmed { color: var(--console-amber); }
.script-review-row > button { justify-self: start; }

@media (max-width: 560px) {
  .script-definition-tabs :deep(.el-tabs__header) { padding-inline: var(--space-2); }
  .script-definition-tabs :deep(.el-tabs__item) { padding-inline: var(--space-1); font-size: var(--console-font-size-min); }
  .script-review-row { grid-template-columns: auto minmax(0, 1fr); }
  .script-review-description { grid-column: 1 / -1; }
}
</style>

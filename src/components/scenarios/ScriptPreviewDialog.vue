<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import type { ScenarioDraft, ScriptContract } from '../../contracts/domain-models'
import { readScriptAcceptanceReview, type ScriptAcceptanceEntry } from '../../features/scenarios/script-execution-status'
import {
  annotateScriptParameterLine,
  annotateScriptSectionLines,
  type ScriptCommentCategory,
  type ScriptCommentMode,
  type ScriptLineAnnotation,
} from '../../features/scenarios/script-inline-comments'
import type { ScriptGenerationReceipt } from '../../features/scenarios/script-package-preflight'
import { formatValidationFieldLabel } from '../../features/scenarios/validation-field-labels'

interface ScriptSection {
  id: string
  name: string
  description: string
  isSnapshot: boolean
  startLine: number
  endLine: number
  lineCount: number
  content: string
  tokens: string[]
}

interface ScriptParameters {
  line: number
  name: string
  prefix: string
  indent: string
  value: unknown
}

const SECTION_DESCRIPTIONS: Record<string, string> = {
  'scenario.txt': '入口引导',
  'comm_SimSetup.txt': '仿真时序与输出',
  'comm_PerDefinition.txt': '通信与天线定义',
  'comm_platform_INS.txt': '平台与运动实例',
  'comm_platform_REAR.txt': '后方指挥与链路计算',
  'comm_platform_MISSION_UAV.txt': '任务无人机平台',
  'comm_platform_COMMAND_VEHICLE.txt': '集群指挥车平台',
  'comm_platform_JAMMER.txt': '干扰平台定义',
  'comm_platform_SAT.txt': '卫星平台定义',
  'observers.txt': '事件观测记录',
  'ad_hoc_comm.txt': '自组网通信',
  'mapping.json': '生成映射快照',
  'input.json': '配置参数快照',
}

const LOG_INITIAL_COUNT = 50
const TEXT_INITIAL_LINES = 2500
const SNAPSHOT_INITIAL_LINES = 1000
const JUMP_WINDOW_RADIUS = 150
const REVIEW_INITIAL_ROWS = 100

const props = defineProps<{
  script: ScriptContract | null
  draft: ScenarioDraft | null
  receipt?: ScriptGenerationReceipt | null
}>()
const visible = defineModel<boolean>({ required: true })
const tab = ref('source')
const definitionTab = ref('platform')
const acceptanceVisited = ref(false)
const logExpanded = ref(true)
const logVisibleCount = ref(LOG_INITIAL_COUNT)
const activeSectionId = ref('')
const sliceStart = ref(1)
const sliceEnd = ref(TEXT_INITIAL_LINES)
const commentMode = ref<ScriptCommentMode>('all')
const focusedCommentCategory = ref<ScriptCommentCategory | null>(null)
const groupVisibleCounts = ref<Record<string, number>>({})
const scroller = ref<HTMLElement | null>(null)
const location = shallowRef<ScriptAcceptanceEntry['location']>(null)
const openParameters = shallowRef<{
  line: number
  category: ScriptCommentCategory
  lines: Array<{ text: string; comment: string | undefined }>
} | null>(null)
const showParameterComments = computed(() =>
  commentMode.value === 'all' || commentMode.value === openParameters.value?.category,
)

const commentModeOptions: Array<{ value: ScriptCommentMode; label: string }> = [
  { value: 'all', label: '中文注释：全部' },
  { value: 'platform', label: '注释：仅平台定义' },
  { value: 'motion', label: '注释：仅运动定义' },
  { value: 'communication', label: '注释：仅通信定义' },
  { value: 'sensor', label: '注释：仅传感器定义' },
  { value: 'jammer', label: '注释：仅干扰定义' },
  { value: 'timeline', label: '注释：仅时序定义' },
  { value: 'off', label: '中文注释：关闭' },
]

const groupLabels = {
  platform: '平台定义',
  motion: '运动定义',
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

function parseSections(source: string): ScriptSection[] {
  if (!source) return []
  const tokens = source.split(/(\r\n|\r|\n)/)
  const totalLines = Math.floor(tokens.length / 2) + 1
  const headers: Array<{ lineIndex: number; name: string }> = []
  for (let lineIndex = 0; lineIndex < totalLines; lineIndex += 1) {
    const match = /^\/\/ ===== ([^\r\n]+) =====$/u.exec(tokens[lineIndex * 2] ?? '')
    if (match) headers.push({ lineIndex, name: match[1]!.trim() })
  }
  if (!headers.length) {
    return [{
      id: 'section-0',
      name: '脚本原文',
      description: '',
      isSnapshot: false,
      startLine: 1,
      endLine: totalLines,
      lineCount: totalLines,
      content: source,
      tokens,
    }]
  }
  const ranges: Array<{ name: string; startIdx: number; endIdx: number; isLast: boolean }> = []
  if (headers[0]!.lineIndex > 0) {
    ranges.push({ name: '脚本内容', startIdx: 0, endIdx: headers[0]!.lineIndex - 1, isLast: false })
  }
  headers.forEach((header, index) => {
    const nextStart = headers[index + 1]?.lineIndex ?? totalLines
    ranges.push({
      name: header.name,
      startIdx: header.lineIndex,
      endIdx: nextStart - 1,
      isLast: index === headers.length - 1,
    })
  })
  return ranges.map((range, index) => {
    const sliceTokens = range.isLast
      ? tokens.slice(range.startIdx * 2)
      : tokens.slice(range.startIdx * 2, range.endIdx * 2 + 1)
    const content = sliceTokens.join('')
    const lineCount = range.endIdx - range.startIdx + 1
    return {
      id: `section-${index}-${range.name}`,
      name: range.name,
      description: SECTION_DESCRIPTIONS[range.name] ?? '',
      isSnapshot: /\.json$/iu.test(range.name),
      startLine: range.startIdx + 1,
      endLine: range.endIdx + 1,
      lineCount,
      content,
      tokens: sliceTokens,
    }
  })
}

const sections = computed(() => parseSections(text.value))
const scriptSections = computed(() => sections.value.filter(section => !section.isSnapshot))
const snapshotSections = computed(() => sections.value.filter(section => section.isSnapshot))

function initialLineCap(section: ScriptSection): number {
  return section.isSnapshot ? SNAPSHOT_INITIAL_LINES : TEXT_INITIAL_LINES
}

function defaultSection(list: ScriptSection[]): ScriptSection | undefined {
  if (!list.length) return undefined
  if (list.length > 1 && list[0]!.name === 'scenario.txt') {
    return list.find(section => section.name === 'comm_SimSetup.txt') ?? list[0]
  }
  return list[0]
}

const activeSection = computed(() =>
  sections.value.find(section => section.id === activeSectionId.value) ?? defaultSection(sections.value) ?? null,
)

function selectSection(section: ScriptSection): void {
  activeSectionId.value = section.id
  sliceStart.value = 1
  sliceEnd.value = Math.min(section.lineCount, initialLineCap(section))
  location.value = null
  openParameters.value = null
  focusedCommentCategory.value = null
  if (scroller.value) {
    scroller.value.scrollTop = 0
    scroller.value.scrollLeft = 0
  }
}

function showAllSectionLines(): void {
  const section = activeSection.value
  if (!section) return
  sliceStart.value = 1
  sliceEnd.value = section.lineCount
}

const visibleReceiptLogs = computed(() => props.receipt ? props.receipt.log.slice(0, logVisibleCount.value) : [])
const remainingReceiptLogs = computed(() => props.receipt ? Math.max(0, props.receipt.log.length - logVisibleCount.value) : 0)

function showAllReceiptLogs(): void {
  if (props.receipt) logVisibleCount.value = props.receipt.log.length
}

// 验收核对仅在切到对应页签后才解析 mapping.json，避免打开原文弹窗时阻塞主线程。
const review = computed(() => (acceptanceVisited.value ? readScriptAcceptanceReview(text.value) : null))
const groups = computed(() => Object.entries(groupLabels).map(([key, label]) => {
  const rows = review.value?.filter(row => row.group === key) ?? []
  const limit = groupVisibleCounts.value[key] ?? REVIEW_INITIAL_ROWS
  return {
    key,
    label,
    total: rows.length,
    rows: rows.slice(0, limit),
    remaining: Math.max(0, rows.length - limit),
  }
}))

function showAllGroupRows(key: string, total: number): void {
  groupVisibleCounts.value = { ...groupVisibleCounts.value, [key]: total }
}

const visibleRange = computed(() => {
  const section = activeSection.value
  if (!section) return { start: 1, end: 0 }
  const start = Math.max(1, Math.min(sliceStart.value, section.lineCount))
  const end = Math.max(start, Math.min(sliceEnd.value, section.lineCount))
  return { start, end }
})

const lineNumbers = computed(() => {
  const section = activeSection.value
  if (!section) return ''
  const { start, end } = visibleRange.value
  const numbers: string[] = []
  for (let line = start; line <= end; line += 1) {
    numbers.push(String(section.startLine + line - 1))
    if (openParameters.value?.line === line) {
      numbers.push('\n'.repeat(openParameters.value.lines.length - 1))
    }
  }
  return numbers.join('\n')
})

function lineLabel(line: number, target: NonNullable<ScriptAcceptanceEntry['location']>): string {
  return target.endPreviewLine === undefined ? String(line) : `${line}–${line + target.endPreviewLine - target.previewLine}`
}

interface RenderRun {
  kind: 'raw' | 'line'
  text: string
  eol: string
  heading: boolean
  annotation: ScriptLineAnnotation | null
  parameters?: ScriptParameters
}

interface RenderSegment {
  target: boolean
  trailingEol: string
  runs: RenderRun[]
}

const sectionAnnotations = computed<Array<ScriptLineAnnotation | null>>(() => {
  const section = activeSection.value
  if (!section || section.isSnapshot || commentMode.value === 'off') return []
  const rawLines: string[] = []
  for (let line = 0; line < section.lineCount; line += 1) {
    rawLines.push(section.tokens[line * 2] ?? '')
  }
  return annotateScriptSectionLines(section.name, rawLines, props.draft?.config)
})

function readParameters(text: string, line: number): ScriptParameters | undefined {
  const match = /^(\s*)(hot_link_ret|hot_link_fw|port_params|natural_environment|jammer_param)(\s+)([\[{].*)$/u.exec(text)
  if (!match) return undefined
  const [, indent, name, separator, json] = match
  if (indent === undefined || name === undefined || separator === undefined || json === undefined) return undefined
  try {
    return { line, name, prefix: indent + name + separator, indent, value: JSON.parse(json) }
  } catch {
    return undefined
  }
}

function toggleParameters(parameters: ScriptParameters): void {
  if (openParameters.value?.line === parameters.line) {
    openParameters.value = null
    return
  }
  openParameters.value = {
    line: parameters.line,
    category: parameters.name === 'jammer_param' ? 'jammer' : 'communication',
    lines: JSON.stringify(parameters.value, null, 2).split('\n').map(line => ({
      text: '\n' + parameters.indent + '  ' + line,
      comment: annotateScriptParameterLine(parameters.name, line),
    })),
  }
}

function buildSegmentRuns(
  section: ScriptSection,
  fromLine: number,
  toLine: number,
  includeLastEol: boolean,
  annotations: readonly (ScriptLineAnnotation | null)[],
  mode: ScriptCommentMode,
): RenderRun[] {
  const runs: RenderRun[] = []
  let plainBuffer = ''
  const flushPlain = () => {
    if (!plainBuffer) return
    runs.push({ kind: 'raw', text: plainBuffer, eol: '', heading: false, annotation: null })
    plainBuffer = ''
  }
  for (let line = fromLine; line <= toLine; line += 1) {
    const idx = line - 1
    const lineText = section.tokens[idx * 2] ?? ''
    const hasEol = line < toLine || includeLastEol
    const eol = hasEol ? (section.tokens[idx * 2 + 1] ?? '') : ''
    const heading = /^\/\/ ===== [^\r\n]+ =====$/u.test(lineText)
    const rawAnnotation = mode === 'off' ? null : (annotations[idx] ?? null)
    const annotation = rawAnnotation && (mode === 'all' || rawAnnotation.category === mode) ? rawAnnotation : null
    const parameters = section.isSnapshot ? undefined : readParameters(lineText, line)
    if (!heading && !annotation && !parameters) {
      plainBuffer += lineText + eol
      continue
    }
    flushPlain()
    runs.push({ kind: 'line', text: lineText, eol, heading, annotation, parameters })
  }
  flushPlain()
  return runs
}

const renderSegments = computed<RenderSegment[]>(() => {
  const section = activeSection.value
  if (!section) return []
  const { start, end } = visibleRange.value
  const mode = section.isSnapshot ? 'off' : commentMode.value
  const annotations = sectionAnnotations.value
  const target = location.value
  const hasTarget = target && target.previewLine >= section.startLine && target.previewLine <= section.endLine
  if (!hasTarget) {
    return [{
      target: false,
      trailingEol: '',
      runs: buildSegmentRuns(section, start, end, end === section.lineCount, annotations, mode),
    }]
  }
  const localStart = target.previewLine - section.startLine + 1
  const localEnd = (target.endPreviewLine ?? target.previewLine) - section.startLine + 1
  if (localStart < start || localEnd > end) {
    return [{
      target: false,
      trailingEol: '',
      runs: buildSegmentRuns(section, start, end, end === section.lineCount, annotations, mode),
    }]
  }
  const segments: RenderSegment[] = []
  if (localStart > start) {
    segments.push({
      target: false,
      trailingEol: '',
      runs: buildSegmentRuns(section, start, localStart - 1, true, annotations, mode),
    })
  }
  const afterTargetEol = localEnd < end || end === section.lineCount ? (section.tokens[(localEnd - 1) * 2 + 1] ?? '') : ''
  segments.push({
    target: true,
    trailingEol: afterTargetEol,
    runs: buildSegmentRuns(section, localStart, localEnd, false, annotations, mode),
  })
  if (localEnd < end) {
    segments.push({
      target: false,
      trailingEol: '',
      runs: buildSegmentRuns(section, localEnd + 1, end, end === section.lineCount, annotations, mode),
    })
  }
  return segments
})

function resetViewerState(): void {
  tab.value = 'source'
  definitionTab.value = 'platform'
  acceptanceVisited.value = false
  logExpanded.value = true
  logVisibleCount.value = LOG_INITIAL_COUNT
  commentMode.value = 'all'
  focusedCommentCategory.value = null
  groupVisibleCounts.value = {}
  location.value = null
  openParameters.value = null
  const initial = defaultSection(sections.value)
  activeSectionId.value = initial?.id ?? ''
  sliceStart.value = 1
  sliceEnd.value = initial ? Math.min(initial.lineCount, initialLineCap(initial)) : TEXT_INITIAL_LINES
}

watch([visible, text, () => props.receipt], () => {
  resetViewerState()
}, { immediate: true })

watch(tab, nextTab => {
  if (nextTab === 'acceptance') acceptanceVisited.value = true
})

async function copyText(content: string, label: string): Promise<void> {
  if (!content) return
  try {
    await navigator.clipboard.writeText(content)
    ElMessage.success(`已复制${label}。`)
  } catch {
    ElMessage.warning('浏览器未授权剪贴板访问，请直接在原文区域选中复制。')
  }
}

async function jumpToSource(
  target: NonNullable<ScriptAcceptanceEntry['location']>,
  group?: ScriptCommentCategory,
): Promise<void> {
  const matched = sections.value.find(section => target.previewLine >= section.startLine && target.previewLine <= section.endLine)
  if (matched) {
    activeSectionId.value = matched.id
    const localStart = target.previewLine - matched.startLine + 1
    const localEnd = (target.endPreviewLine ?? target.previewLine) - matched.startLine + 1
    const cap = initialLineCap(matched)
    if (localEnd <= cap) {
      sliceStart.value = 1
      sliceEnd.value = Math.min(matched.lineCount, cap)
    } else {
      sliceStart.value = Math.max(1, localStart - JUMP_WINDOW_RADIUS)
      sliceEnd.value = Math.min(matched.lineCount, localEnd + JUMP_WINDOW_RADIUS)
    }
  }
  focusedCommentCategory.value = group ?? null
  if (group && commentMode.value !== 'off' && commentMode.value !== 'all' && commentMode.value !== group) {
    commentMode.value = group
  }
  location.value = target
  openParameters.value = null
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
    :title="receipt ? '脚本生成成功 · 脚本预览' : '脚本预览'"
    :top="receipt ? '4vh' : '5vh'"
    width="min(1140px, calc(100vw - 2rem))"
    data-testid="script-preview-dialog"
    destroy-on-close
  >
    <div v-if="script && draft" class="script-preview-viewer" :class="{ 'has-receipt': Boolean(receipt) }">
      <section
        v-if="receipt"
        class="script-preview-receipt"
        data-testid="script-generation-receipt"
        aria-label="脚本生成结果"
      >
        <div class="script-preview-receipt-head">
          <div class="script-preview-receipt-status">
            <span class="script-preview-receipt-badge">脚本生成成功</span>
            <span class="script-preview-receipt-hint">可在编辑页点击「执行预检」校验本地生成包根目录。</span>
          </div>
          <el-button
            link
            type="primary"
            class="script-preview-log-toggle"
            data-testid="toggle-generation-log"
            @click="logExpanded = !logExpanded"
          >
            {{ logExpanded ? '收起生成日志' : '展开生成日志' }}（{{ receipt.log.length }}）
          </el-button>
        </div>
        <dl class="script-preview-receipt-details">
          <div class="is-path"><dt>脚本路径</dt><dd><code :title="receipt.path">{{ receipt.path }}</code></dd></div>
          <div><dt>场景版本号</dt><dd><code>{{ receipt.version }}</code></dd></div>
        </dl>
        <div v-if="logExpanded" class="script-preview-receipt-log-wrap">
          <span class="script-preview-receipt-log-label">生成日志</span>
          <ul class="script-preview-receipt-log" data-testid="script-generation-receipt-log">
            <li v-for="(line, index) in visibleReceiptLogs" :key="index">{{ line }}</li>
            <li v-if="remainingReceiptLogs > 0" class="script-preview-receipt-more">
              <button type="button" class="script-review-link" data-testid="show-all-generation-log" @click="showAllReceiptLogs">
                展开剩余 {{ remainingReceiptLogs }} 条日志（共 {{ receipt.log.length }} 条）
              </button>
            </li>
          </ul>
        </div>
      </section>
      <div class="script-preview-meta">
        <span class="script-preview-scene" :title="draft.config.scenario.name">{{ draft.config.scenario.name }}</span>
        <span>修订 {{ draft.revision }}</span>
        <span class="script-preview-checksum" :title="script.checksum">校验和 {{ script.checksum }}</span>
      </div>
      <el-tabs v-model="tab" class="script-preview-tabs">
        <el-tab-pane label="脚本原文" name="source">
          <div class="script-preview-workspace" :class="{ 'has-sidebar': sections.length > 1 }">
            <aside v-if="sections.length > 1" class="script-preview-sidebar" aria-label="脚本文件列表" data-testid="script-preview-files">
              <div v-if="scriptSections.length" class="script-preview-file-group">
                <span class="script-preview-file-heading">脚本文件（{{ scriptSections.length }}）</span>
                <button
                  v-for="section in scriptSections"
                  :key="section.id"
                  type="button"
                  class="script-preview-file-item"
                  :class="{ 'is-active': activeSection?.id === section.id }"
                  :data-testid="`script-file-${section.name}`"
                  @click="selectSection(section)"
                >
                  <span class="script-preview-file-name" :title="section.name">{{ section.name }}</span>
                  <span class="script-preview-file-meta">
                    <span v-if="section.description">{{ section.description }}</span>
                    <span>{{ section.lineCount }} 行</span>
                  </span>
                </button>
              </div>
              <div v-if="snapshotSections.length" class="script-preview-file-group">
                <span class="script-preview-file-heading">快照文件（{{ snapshotSections.length }}）</span>
                <button
                  v-for="section in snapshotSections"
                  :key="section.id"
                  type="button"
                  class="script-preview-file-item"
                  :class="{ 'is-active': activeSection?.id === section.id }"
                  :data-testid="`script-file-${section.name}`"
                  @click="selectSection(section)"
                >
                  <span class="script-preview-file-name" :title="section.name">{{ section.name }}</span>
                  <span class="script-preview-file-meta">
                    <span v-if="section.description">{{ section.description }}</span>
                    <span>{{ section.lineCount }} 行</span>
                  </span>
                </button>
              </div>
            </aside>

            <div class="script-preview-code-pane">
              <div v-if="activeSection" class="script-preview-code-bar">
                <div class="script-preview-code-title">
                  <strong>{{ activeSection.name }}</strong>
                  <span v-if="activeSection.description" class="script-preview-code-desc">{{ activeSection.description }}</span>
                  <span class="script-preview-code-lines">
                    第 {{ activeSection.startLine }}–{{ activeSection.endLine }} 行（共 {{ activeSection.lineCount }} 行）
                  </span>
                </div>
                <div class="script-preview-code-actions">
                  <select
                    v-if="!activeSection.isSnapshot"
                    v-model="commentMode"
                    class="script-comment-select"
                    aria-label="前端中文注释筛选"
                    title="仅前端展示中文注释，不影响真实脚本文件与复制内容"
                    data-testid="script-comment-mode"
                  >
                    <option v-for="opt in commentModeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                  </select>
                  <button
                    type="button"
                    class="script-review-link"
                    data-testid="copy-current-script"
                    @click="copyText(activeSection.content, activeSection.name)"
                  >
                    复制当前文件
                  </button>
                  <button
                    v-if="sections.length > 1"
                    type="button"
                    class="script-review-link"
                    data-testid="copy-all-script"
                    @click="copyText(text, '全部脚本')"
                  >
                    复制全部
                  </button>
                </div>
              </div>
              <p v-if="location" class="script-preview-location" role="status">
                {{ location.fileName }} 第 {{ lineLabel(location.fileLine, location) }} 行 · 预览第 {{ lineLabel(location.previewLine, location) }} 行
              </p>
              <div v-if="activeSection && visibleRange.start > 1" class="script-preview-slice-bar">
                <span>当前展示第 {{ visibleRange.start }}–{{ visibleRange.end }} 行（前面已省略 {{ visibleRange.start - 1 }} 行以保持流畅）</span>
                <button type="button" class="script-review-link" data-testid="show-all-section-lines" @click="showAllSectionLines">
                  显示本文件全部 {{ activeSection.lineCount }} 行
                </button>
              </div>
              <div ref="scroller" class="script-preview-scroll" data-testid="script-preview-scroll" role="region" aria-label="脚本文本" tabindex="0">
                <div class="script-preview-lines">
                  <pre class="script-preview-gutter" aria-hidden="true" v-text="lineNumbers" />
                  <pre class="standalone-script-preview" data-testid="standalone-script-preview"><code><template v-for="(segment, segIndex) in renderSegments" :key="segIndex"><span :class="{ 'script-preview-target-line': segment.target }" :data-testid="segment.target ? 'script-preview-target-line' : undefined"><template v-for="(run, runIndex) in segment.runs" :key="runIndex"><template v-if="run.kind === 'raw'">{{ run.text }}</template><template v-else><span v-if="run.annotation?.placement === 'before'" class="script-inline-badge" :class="[`is-${run.annotation.category}`, { 'is-focused': focusedCommentCategory === run.annotation.category }]" :data-comment="run.annotation.comment" data-testid="script-inline-comment" aria-hidden="true" /><template v-if="run.parameters">{{ run.parameters.prefix }}<span hidden>{{ run.text.slice(run.parameters.prefix.length) }}</span><button type="button" class="script-review-link script-parameters-toggle" :data-script-parameters="run.parameters.name" :aria-expanded="openParameters?.line === run.parameters.line" :aria-label="`${openParameters?.line === run.parameters.line ? '收起' : '展开'} ${run.parameters.name} 参数`" :data-label="openParameters?.line === run.parameters.line ? '▾ 收起参数' : '▸ 展开参数'" @click="toggleParameters(run.parameters)" /></template><span v-else :class="{ 'script-preview-section': run.heading }" v-text="run.text" /><span v-if="run.annotation?.placement === 'after'" class="script-inline-comment" :class="[`is-${run.annotation.category}`, { 'is-focused': focusedCommentCategory === run.annotation.category }]" :data-comment="run.annotation.comment" data-testid="script-inline-comment" aria-hidden="true" /><span v-if="run.parameters && openParameters?.line === run.parameters.line" class="script-parameters-body" data-testid="script-parameters-body"><template v-for="(field, fieldIndex) in openParameters.lines" :key="fieldIndex">{{ field.text }}<span v-if="showParameterComments && field.comment" class="script-inline-comment" :data-comment="field.comment" data-testid="script-parameter-comment" aria-hidden="true" /></template></span>{{ run.eol }}</template></template></span>{{ segment.trailingEol }}</template></code></pre>
                </div>
              </div>
              <div v-if="activeSection && visibleRange.end < activeSection.lineCount" class="script-preview-slice-bar is-bottom">
                <span>已展示 {{ visibleRange.end - visibleRange.start + 1 }} / {{ activeSection.lineCount }} 行（剩余 {{ activeSection.lineCount - visibleRange.end }} 行按需加载）</span>
                <button type="button" class="script-review-link" data-testid="show-all-section-lines" @click="showAllSectionLines">
                  显示本文件全部 {{ activeSection.lineCount }} 行
                </button>
              </div>
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
                  <p v-else-if="!group.total" class="script-review-note">本次生成清单未记录此分组。</p>
                  <ul v-else class="script-review-list">
                    <li v-for="(row, index) in group.rows" :key="index" class="script-review-row">
                      <div class="script-review-description">
                        <strong>{{ row.fieldPath === 'references.entry' ? '入口引用' : formatValidationFieldLabel(row.fieldPath, draft.config) }}</strong>
                        <p>{{ row.detail }}</p>
                      </div>
                      <span class="script-review-state" :class="`is-${row.status}`">{{ statusLabels[row.status] }}</span>
                      <button
                        v-if="row.location"
                        type="button"
                        class="script-review-link"
                        data-testid="script-acceptance-source"
                        @click="jumpToSource(row.location, row.group)"
                      >
                        {{ row.location.fileName === 'mapping.json' ? '清单 ' : '' }}{{ row.location.fileName }}:{{ lineLabel(row.location.fileLine, row.location) }}
                      </button>
                      <span v-else class="script-review-note">位置未记录</span>
                    </li>
                    <li v-if="group.remaining > 0" class="script-review-more">
                      <button type="button" class="script-review-link" @click="showAllGroupRows(group.key, group.total)">
                        显示剩余 {{ group.remaining }} 条记录（共 {{ group.total }} 条）
                      </button>
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

.script-preview-receipt {
  display: grid;
  flex: none;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--console-border);
  background: color-mix(in srgb, var(--console-teal) 8%, var(--console-surface-raised));
}

.script-preview-receipt-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
}

.script-preview-receipt-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  min-width: 0;
}

.script-preview-receipt-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--space-2);
  border: 1px solid color-mix(in srgb, var(--console-teal) 55%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--console-teal) 16%, transparent);
  color: var(--console-teal);
  font-size: var(--console-font-size-min);
  font-weight: 600;
  white-space: nowrap;
}

.script-preview-receipt-hint {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.script-preview-log-toggle {
  flex: none;
  font-size: var(--console-font-size-min);
}

.script-preview-receipt-details {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-5);
  margin: 0;
}

.script-preview-receipt-details > div {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.script-preview-receipt-details > div.is-path {
  flex: 1 1 24rem;
}

.script-preview-receipt-details dt {
  flex: none;
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.script-preview-receipt-details dd {
  margin: 0;
  min-width: 0;
  color: var(--console-text);
  overflow-wrap: anywhere;
}

.script-preview-receipt-details code {
  font: 0.8125rem/1.45 Consolas, 'SFMono-Regular', ui-monospace, monospace;
}

.script-preview-receipt-log-wrap {
  display: grid;
  gap: var(--space-1);
}

.script-preview-receipt-log-label {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
  font-weight: 600;
}

.script-preview-receipt-log {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  max-height: 6.5rem;
  overflow: auto;
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background: var(--console-bg);
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
  line-height: 1.5;
  list-style: none;
  overflow-wrap: anywhere;
}

.script-preview-receipt-log li + li {
  margin-top: 2px;
}

.script-preview-receipt-more {
  padding-top: var(--space-1);
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
.script-preview-viewer.has-receipt .script-preview-tabs :deep(.el-tab-pane) { max-height: min(50dvh, 34rem); }

.script-preview-workspace {
  display: flex;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.script-preview-sidebar {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: var(--space-3);
  width: 236px;
  padding: var(--space-3) var(--space-2);
  border-right: 1px solid var(--console-border);
  background: var(--console-bg-elevated);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.script-preview-file-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.script-preview-file-heading {
  padding: 0 var(--space-2) var(--space-1);
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
  font-weight: 600;
}

.script-preview-file-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--console-radius);
  background: transparent;
  color: var(--console-text);
  text-align: left;
  cursor: pointer;
}

.script-preview-file-item:hover {
  background: var(--console-surface-raised);
}

.script-preview-file-item.is-active {
  border-color: color-mix(in srgb, var(--console-cyan) 45%, transparent);
  background: color-mix(in srgb, var(--console-cyan) 12%, var(--console-surface-raised));
}

.script-preview-file-name {
  overflow: hidden;
  font: 600 0.8125rem/1.35 Consolas, 'SFMono-Regular', ui-monospace, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.script-preview-file-item.is-active .script-preview-file-name {
  color: var(--console-cyan);
}

.script-preview-file-meta {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  color: var(--console-text-muted);
  font-size: 0.75rem;
}

.script-preview-code-pane {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}

.script-preview-code-bar {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--console-border);
  background: var(--console-surface-raised);
  font-size: var(--console-font-size-min);
}

.script-preview-code-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: var(--console-text);
}

.script-preview-code-desc,
.script-preview-code-lines {
  color: var(--console-text-muted);
}

.script-preview-code-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-3);
}

.script-preview-slice-bar {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--console-border);
  background: var(--console-bg-elevated);
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.script-preview-slice-bar.is-bottom {
  border-top: 1px solid var(--console-border);
  border-bottom: none;
}

.script-preview-location { flex: none; margin: 0; padding: var(--space-2) var(--space-4); color: var(--console-cyan); font-size: var(--console-font-size-min); }
.script-preview-scroll, .script-review-group { min-height: 0; flex: 1; overflow: auto; overscroll-behavior: contain; }
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
.script-parameters-toggle { margin-inline: 0.25rem; }
.script-parameters-toggle::before { content: attr(data-label); }
.script-parameters-body { color: var(--console-text-muted); }

.script-comment-select {
  height: 26px;
  padding: 0 var(--space-2);
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background: var(--console-bg);
  color: var(--console-text);
  font-size: var(--console-font-size-min);
  cursor: pointer;
}

.script-comment-select:focus-visible {
  outline: 1px solid var(--console-cyan);
}

.script-inline-comment::after {
  content: attr(data-comment);
  color: var(--console-text-muted);
  opacity: 0.82;
  font-style: italic;
  user-select: none;
  pointer-events: none;
}

.script-inline-comment.is-focused::after {
  color: var(--console-cyan);
  opacity: 0.96;
}

.script-inline-badge::before {
  content: attr(data-comment);
  display: inline-block;
  margin-right: 0.5rem;
  padding: 0 0.35rem;
  border: 1px solid color-mix(in srgb, var(--console-cyan) 38%, transparent);
  border-radius: 3px;
  background: color-mix(in srgb, var(--console-cyan) 12%, var(--console-surface-raised));
  color: var(--console-cyan);
  font-size: 0.75rem;
  line-height: 1.4;
  user-select: none;
  pointer-events: none;
}

.script-inline-badge.is-jammer::before {
  border-color: color-mix(in srgb, var(--console-amber) 45%, transparent);
  background: color-mix(in srgb, var(--console-amber) 14%, var(--console-surface-raised));
  color: var(--console-amber);
}

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

.script-review-link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--console-cyan);
  font: inherit;
  font-size: var(--console-font-size-min);
  cursor: pointer;
  white-space: nowrap;
}

.script-review-link:hover {
  text-decoration: underline;
}

.script-review-more {
  padding-block: var(--space-3);
  text-align: center;
}

@media (max-width: 720px) {
  .script-preview-workspace.has-sidebar {
    flex-direction: column;
  }
  .script-preview-sidebar {
    width: auto;
    max-height: 8rem;
    border-right: none;
    border-bottom: 1px solid var(--console-border);
  }
}

@media (max-width: 560px) {
  .script-definition-tabs :deep(.el-tabs__header) { padding-inline: var(--space-2); }
  .script-definition-tabs :deep(.el-tabs__item) { padding-inline: var(--space-1); font-size: var(--console-font-size-min); }
  .script-review-row { grid-template-columns: auto minmax(0, 1fr); }
  .script-review-description { grid-column: 1 / -1; }
}
</style>

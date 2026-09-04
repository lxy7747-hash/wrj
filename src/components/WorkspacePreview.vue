<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '../stores/auth'

interface WorkspacePreview {
  eyebrow: string
  summary: string
  variant: 'map' | 'form' | 'queue' | 'report' | 'timeline' | 'network' | 'matrix'
  regions: readonly { title: string; description: string }[]
}

type WorkspaceRouteName =
  | 'situation'
  | 'reports'
  | 'blueprint'
  | 'admin-data-exchange'
  | 'traceability'

const WORKSPACE_PREVIEWS: Record<WorkspaceRouteName, WorkspacePreview> = {
  situation: {
    eyebrow: '态势主界面',
    summary: '规划中的综合态势空间将集中呈现场景、通联关系与观察信息。',
    variant: 'map',
    regions: [
      { title: '态势画布', description: '将容纳地理背景、节点分布与通联拓扑。' },
      { title: '场景图层', description: '将按信息类别组织可见范围与对象分组。' },
      { title: '观察摘要', description: '将汇集选中对象与关联事件的上下文。' },
    ],
  },
  reports: {
    eyebrow: '报表中心',
    summary: '规划中的分析空间将组合指标摘要、图表区域与报告章节。',
    variant: 'report',
    regions: [
      { title: '指标摘要', description: '将归纳评估口径与关键观察维度。' },
      { title: '趋势与分布', description: '将承载按时间和类别组织的图表区域。' },
      { title: '对比分析', description: '将并列呈现可比较的任务结果。' },
      { title: '报告章节', description: '将按主题组织结论与依据。' },
    ],
  },
  blueprint: {
    eyebrow: '资源模板库',
    summary: '规划中的资源空间将以目录、关系网络与接口边界组织模板资产。',
    variant: 'network',
    regions: [
      { title: '模板目录', description: '将按资源类别与用途组织模板。' },
      { title: '资源关系', description: '将展示模板、能力与依赖之间的结构。' },
      { title: '接口边界', description: '将说明资源输入、输出与约束。' },
      { title: '版本说明', description: '将汇集模板沿革与适用范围。' },
    ],
  },
  'admin-data-exchange': {
    eyebrow: '数据交换与接口',
    summary: '规划中的交换空间将分层描述数据契约、通道边界与流向关系。',
    variant: 'network',
    regions: [
      { title: '数据契约', description: '将组织交换格式、字段与校验边界。' },
      { title: '交换通道', description: '将描述系统内外的数据流向。' },
      { title: '接口目录', description: '将汇集接口职责与依赖关系。' },
      { title: '边界说明', description: '将标明安全范围与异常处理约束。' },
    ],
  },
  traceability: {
    eyebrow: '可追溯性',
    summary: '规划中的追溯空间将连接需求、设计、实现与验收证据。',
    variant: 'matrix',
    regions: [
      { title: '追溯矩阵', description: '将按来源与目标交叉组织映射关系。' },
      { title: '证据链路', description: '将串联设计依据、实现位置与验收材料。' },
      { title: '覆盖说明', description: '将汇总缺口、边界与后续补充方向。' },
    ],
  },
}

const route = useRoute()
const auth = useAuthStore()

/**
 * 读取当前路由声明的展示标题。
 * @returns 当前工作区路由标题。
 * @remarks 只读取路由元数据，不修改状态且无其他副作用。
 */
const title = computed(() => route.meta.title)

/**
 * 解析当前工作区路由对应的信息架构预览。
 * @returns 匹配的只读预览定义；无法匹配时安全回退到态势预览。
 * @remarks 只读取路由元数据，不执行导航、不请求数据，也不修改状态。
 */
const preview = computed<WorkspacePreview>(() => (
  WORKSPACE_PREVIEWS[String(route.name) as WorkspaceRouteName] ?? WORKSPACE_PREVIEWS.situation
))
</script>

<template>
  <section class="page workspace-page" :aria-labelledby="`page-${String(route.name)}`">
    <el-alert
      v-if="auth.lastDenial"
      class="denial-alert"
      type="error"
      :closable="false"
      show-icon
      data-testid="route-denial"
      title="PERMISSION_DENIED"
      :description="`当前 ${auth.role} 角色不能进入用户与角色管理；已返回能力蓝图。缺少权限：${auth.lastDenial.permission}`"
    />

    <header class="workspace-header">
      <div class="workspace-heading">
        <p class="eyebrow">业务工作区 · {{ preview.eyebrow }}</p>
        <h2 :id="`page-${String(route.name)}`">{{ title }}</h2>
        <p class="route-path">{{ route.path }}</p>
        <p class="workspace-summary">{{ preview.summary }}</p>
      </div>

      <div class="principal-line" aria-label="当前访问身份">
        <span>当前用户：{{ auth.principal?.username }}</span>
        <el-tag>{{ auth.role }}</el-tag>
      </div>
    </header>

    <el-alert
      class="construction-alert"
      type="info"
      :closable="false"
      title="功能建设中"
      description="该模块正在建设，当前仅展示规划中的信息区域，不提供业务操作。"
    />

    <section
      class="preview-shell"
      :class="`preview-shell--${preview.variant}`"
      :aria-label="`${preview.eyebrow}规划信息架构`"
      data-testid="workspace-preview"
      :data-preview-variant="preview.variant"
    >
      <header class="preview-shell__header">
        <div>
          <p class="preview-shell__label">规划区域</p>
          <h3>{{ preview.eyebrow }}信息架构预览</h3>
        </div>
        <p>以下结构仅表达未来页面的信息分区。</p>
      </header>

      <div class="preview-layout">
        <article
          v-for="(region, index) in preview.regions"
          :key="region.title"
          class="preview-region"
          :class="`preview-region--${index + 1}`"
        >
          <div class="preview-region__copy">
            <h4>{{ region.title }}</h4>
            <p>{{ region.description }}</p>
          </div>
          <div class="preview-decoration" aria-hidden="true">
            <span class="preview-decoration__line preview-decoration__line--primary"></span>
            <span class="preview-decoration__line preview-decoration__line--secondary"></span>
            <span class="preview-decoration__line preview-decoration__line--tertiary"></span>
            <i class="preview-decoration__node preview-decoration__node--start"></i>
            <i class="preview-decoration__node preview-decoration__node--middle"></i>
            <i class="preview-decoration__node preview-decoration__node--end"></i>
          </div>
        </article>
      </div>
    </section>
  </section>
</template>

<style scoped>
.workspace-page {
  --workspace-accent: var(--console-cyan);
  min-width: 0;
  overflow: hidden;
}

.denial-alert {
  margin-bottom: var(--space-4);
}

.workspace-header,
.preview-shell__header {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
}

.workspace-heading {
  min-width: 0;
}

.route-path {
  overflow-wrap: anywhere;
  margin: 0;
  color: var(--console-cyan);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.78rem;
}

.workspace-summary {
  max-width: 46rem;
  margin: var(--space-3) 0 0;
  color: var(--console-text-muted);
  font-size: 0.92rem;
  line-height: 1.75;
}

.principal-line {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  max-width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  color: var(--console-text-muted);
  background: var(--console-bg-elevated);
  font-size: 0.78rem;
}

.construction-alert {
  margin-top: var(--space-5);
}

.preview-shell {
  min-width: 0;
  margin-top: var(--space-5);
  overflow: hidden;
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  background:
    linear-gradient(rgba(66, 216, 255, 0.02) 1px, transparent 1px),
    linear-gradient(90deg, rgba(66, 216, 255, 0.02) 1px, transparent 1px),
    var(--console-bg-elevated);
  background-size: 1.5rem 1.5rem;
}

.preview-shell--form {
  --workspace-accent: var(--console-teal);
}

.preview-shell--queue,
.preview-shell--timeline {
  --workspace-accent: var(--console-amber);
}

.preview-shell--report,
.preview-shell--matrix {
  --workspace-accent: #8ca8ff;
}

.preview-shell__header {
  align-items: flex-end;
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--console-border);
  background: color-mix(in srgb, var(--console-surface-raised) 84%, transparent);
}

.preview-shell__label {
  margin: 0 0 var(--space-1);
  color: var(--workspace-accent);
  font-size: var(--console-font-size-min);
  font-weight: 700;
  letter-spacing: 0.16em;
}

.preview-shell__header h3 {
  margin: 0;
  color: var(--console-text);
  font-size: clamp(1rem, 2vw, 1.18rem);
}

.preview-shell__header > p {
  max-width: 24rem;
  margin: 0;
  color: var(--console-text-dim);
  font-size: var(--console-font-size-min);
  line-height: 1.55;
  text-align: right;
}

.preview-layout {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  padding: var(--space-4);
}

.preview-region {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 9.5rem;
  align-content: space-between;
  gap: var(--space-4);
  overflow: hidden;
  padding: var(--space-4);
  border: 1px solid color-mix(in srgb, var(--console-border) 88%, transparent);
  border-radius: calc(var(--console-radius) - 2px);
  background: color-mix(in srgb, var(--console-surface) 92%, transparent);
}

.preview-region h4 {
  margin: 0;
  color: var(--console-text);
  font-size: 0.86rem;
}

.preview-region p {
  max-width: 32rem;
  margin: var(--space-2) 0 0;
  color: var(--console-text-muted);
  font-size: 0.76rem;
  line-height: 1.65;
}

.preview-decoration {
  position: relative;
  min-width: 0;
  height: 3.25rem;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--workspace-accent) 15%, var(--console-border));
  border-radius: 4px;
  background: color-mix(in srgb, var(--console-bg) 76%, transparent);
}

.preview-decoration__line {
  position: absolute;
  display: block;
  height: 1px;
  background: color-mix(in srgb, var(--workspace-accent) 48%, transparent);
  transform-origin: left center;
}

.preview-decoration__line--primary {
  top: 44%;
  left: 12%;
  width: 76%;
}

.preview-decoration__line--secondary {
  top: 26%;
  left: 21%;
  width: 38%;
  transform: rotate(18deg);
}

.preview-decoration__line--tertiary {
  top: 72%;
  left: 52%;
  width: 28%;
  transform: rotate(-20deg);
}

.preview-decoration__node {
  position: absolute;
  display: block;
  width: 0.55rem;
  height: 0.55rem;
  border: 1px solid var(--workspace-accent);
  border-radius: 50%;
  background: var(--console-bg-elevated);
}

.preview-decoration__node--start {
  top: calc(44% - 0.28rem);
  left: 12%;
}

.preview-decoration__node--middle {
  top: calc(38% - 0.28rem);
  left: 50%;
}

.preview-decoration__node--end {
  top: calc(44% - 0.28rem);
  right: 12%;
}

.preview-shell--map .preview-region--1,
.preview-shell--timeline .preview-region--1,
.preview-shell--queue .preview-region--2,
.preview-shell--matrix .preview-region--1 {
  grid-column: 1 / -1;
}

.preview-shell--map .preview-region--1 {
  min-height: 14rem;
}

.preview-shell--map .preview-region--1 .preview-decoration,
.preview-shell--timeline .preview-region--1 .preview-decoration {
  height: 6rem;
  background:
    radial-gradient(circle at 25% 38%, color-mix(in srgb, var(--workspace-accent) 22%, transparent) 0 0.22rem, transparent 0.26rem),
    radial-gradient(circle at 68% 64%, color-mix(in srgb, var(--workspace-accent) 22%, transparent) 0 0.22rem, transparent 0.26rem),
    linear-gradient(rgba(66, 216, 255, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(66, 216, 255, 0.05) 1px, transparent 1px),
    color-mix(in srgb, var(--console-bg) 76%, transparent);
  background-size: auto, auto, 1rem 1rem, 1rem 1rem, auto;
}

.preview-shell--form .preview-decoration__node,
.preview-shell--report .preview-decoration__node,
.preview-shell--matrix .preview-decoration__node {
  display: none;
}

.preview-shell--form .preview-decoration,
.preview-shell--report .preview-decoration {
  border: 0;
  background: transparent;
}

.preview-shell--form .preview-decoration__line,
.preview-shell--report .preview-decoration__line {
  left: 0;
  height: 0.58rem;
  border-radius: 2px;
  background: color-mix(in srgb, var(--workspace-accent) 11%, var(--console-surface-raised));
  transform: none;
}

.preview-shell--form .preview-decoration__line--primary,
.preview-shell--report .preview-decoration__line--primary {
  top: 0;
  width: 100%;
}

.preview-shell--form .preview-decoration__line--secondary,
.preview-shell--report .preview-decoration__line--secondary {
  top: 1.25rem;
  width: 72%;
}

.preview-shell--form .preview-decoration__line--tertiary,
.preview-shell--report .preview-decoration__line--tertiary {
  top: 2.5rem;
  width: 88%;
}

.preview-shell--queue .preview-decoration {
  height: 4.5rem;
  border: 0;
  border-radius: 0;
  background:
    linear-gradient(var(--console-border), var(--console-border)) 0 33% / 100% 1px no-repeat,
    linear-gradient(var(--console-border), var(--console-border)) 0 66% / 100% 1px no-repeat;
}

.preview-shell--queue .preview-decoration__line,
.preview-shell--queue .preview-decoration__node {
  display: none;
}

.preview-shell--timeline .preview-decoration__line--primary {
  top: 50%;
  left: 5%;
  width: 90%;
}

.preview-shell--timeline .preview-decoration__line--secondary,
.preview-shell--timeline .preview-decoration__line--tertiary {
  display: none;
}

.preview-shell--timeline .preview-decoration__node--start,
.preview-shell--timeline .preview-decoration__node--middle,
.preview-shell--timeline .preview-decoration__node--end {
  top: calc(50% - 0.28rem);
}

.preview-shell--timeline .preview-decoration__node--start {
  left: 5%;
}

.preview-shell--timeline .preview-decoration__node--end {
  right: 5%;
}

.preview-shell--network .preview-region--2,
.preview-shell--network .preview-region--3 {
  min-height: 12rem;
}

.preview-shell--matrix .preview-region--1 .preview-decoration {
  height: 6.5rem;
  background:
    linear-gradient(var(--console-border) 1px, transparent 1px),
    linear-gradient(90deg, var(--console-border) 1px, transparent 1px),
    color-mix(in srgb, var(--console-bg) 76%, transparent);
  background-size: 25% 50%;
}

.preview-shell--matrix .preview-region--1 .preview-decoration__line {
  display: none;
}

@media (max-width: 720px) {
  .workspace-header,
  .preview-shell__header {
    align-items: stretch;
    flex-direction: column;
  }

  .principal-line {
    width: fit-content;
  }

  .preview-shell__header > p {
    text-align: left;
  }

  .preview-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .preview-shell .preview-region {
    grid-column: auto;
  }
}

@media (max-width: 420px) {
  .preview-shell__header,
  .preview-layout,
  .preview-region {
    padding: var(--space-3);
  }

  .preview-region {
    min-height: 8.5rem;
  }
}
</style>

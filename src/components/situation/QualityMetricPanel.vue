<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SituationLinkView } from '../../features/situation/situation-model'
import { formatBer, LINK_TYPE_LABELS, qualityNodeOptionLabel } from '../../features/situation/situation-model'
import type { RuntimeLinkQualityView } from '../../features/situation/runtime-quality-view'
import { RUNTIME_STATUS_LABELS, runtimeDecisionReason } from '../../features/situation/runtime-quality-view'
import { reportLinkLabel } from '../../features/reports/report-link-label'
import type { SituationMapNode } from '../../features/situation/initial-nodes'
import { nodeCategory } from '../../config/map.config'

type QualityLink = Pick<SituationLinkView, 'linkId' | 'sourceName' | 'destinationName'>
  & Partial<Pick<SituationLinkView, 'snrDb' | 'ber' | 'updatedAt' | 'ageMs' | 'detailed' | 'type'>>
  & { runtimeQuality?: RuntimeLinkQualityView | null }
const props = defineProps<{
  links: QualityLink[]
  nodes: string[]
  sourceKey: string
  selectedLinkId?: string
  nodePlatforms?: readonly Pick<SituationMapNode, 'platformId' | 'name' | 'type'>[]
}>()
const node = ref('')
const linkId = ref('')
const windowMs = ref(0)
const linkType = ref('')
const nodeLabels = computed(() => new Map(props.nodes.map((name, index) => {
  const platform = props.nodePlatforms?.find(item => item.name === name || item.platformId === name)
  return [name, qualityNodeOptionLabel(name, index, platform?.platformId, platform && nodeCategory(platform))]
})))
const nodeLabel = (name: string) => nodeLabels.value.get(name) ?? '未知节点'
/** 只列出当前数据中实际出现的体制；缺少体制的链路在选择类型后不显示。 */
const linkTypes = computed(() => [...new Set(props.links.flatMap(link => link.type ? [link.type] : []))])
const rows = computed(() => props.links.filter(link => {
  const ageMs = link.runtimeQuality ? link.runtimeQuality.ageMs : link.ageMs
  return (!node.value || link.sourceName === node.value || link.destinationName === node.value)
    && (!linkId.value || link.linkId === linkId.value) && (!linkType.value || link.type === linkType.value)
    && (ageMs === undefined || ageMs === null || ageMs <= windowMs.value)
}))
watch(() => props.sourceKey, () => { node.value = ''; linkId.value = ''; windowMs.value = 0; linkType.value = '' })
function metricText(value: number | null | undefined, digits: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '暂无数据'
}
function berText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatBer(value) : '暂无数据'
}
watch(() => props.selectedLinkId, selected => {
  node.value = ''
  linkId.value = props.links.some(link => link.linkId === selected) ? selected! : ''
}, { immediate: true })
</script>

<template>
  <section class="quality-metric-panel quality-card-panel" aria-label="实时质量指标" data-testid="quality-metric-panel">
    <el-form label-position="top" class="quality-filters quality-card-filters">
      <el-form-item label="节点">
        <el-select v-model="node" clearable placeholder="全部节点">
          <el-option v-for="name in nodes" :key="name" :value="name" :label="nodeLabel(name)" />
        </el-select>
      </el-form-item>
      <el-form-item label="链路类型"><el-select v-model="linkType" clearable placeholder="全部类型" data-testid="quality-link-type"><el-option v-for="type in linkTypes" :key="type" :value="type" :label="LINK_TYPE_LABELS[type]" /></el-select></el-form-item>
      <details class="quality-card-advanced">
        <summary>更多筛选<span v-if="linkId || windowMs">（已应用）</span></summary>
        <el-form-item label="链路">
          <el-select v-model="linkId" clearable placeholder="全部链路">
            <el-option v-for="(link, index) in links" :key="link.linkId" :value="link.linkId"
              :label="reportLinkLabel(link.linkId, index, link.type, [nodeLabel(link.sourceName), nodeLabel(link.destinationName)])" />
          </el-select>
        </el-form-item>
        <el-form-item label="时间窗口"><el-select v-model="windowMs"><el-option label="当前时刻" :value="0" /><el-option label="最近1秒" :value="1000" /><el-option label="最近5秒" :value="5000" /></el-select></el-form-item>
        <p>时间筛选只适用于时效已知的数据。「暂无数据」表示没有测量值。</p>
      </details>
    </el-form>
    <div v-if="rows.length" class="quality-card-list" role="list" aria-label="链路质量摘要">
      <article v-for="row in rows" :key="`${sourceKey}:${row.linkId}`" class="quality-card" role="listitem" :data-link-id="row.linkId">
        <header class="quality-card-heading">
          <strong>{{ row.sourceName }} → {{ row.destinationName }}</strong>
          <el-tag v-if="row.runtimeQuality?.assessment" :type="row.runtimeQuality.assessment.status === 'UP' ? 'success' : row.runtimeQuality.assessment.status === 'DEGRADED' ? 'warning' : row.runtimeQuality.assessment.status === 'DOWN' ? 'danger' : 'info'" :title="runtimeDecisionReason(row.runtimeQuality.assessment.reason)">{{ RUNTIME_STATUS_LABELS[row.runtimeQuality.assessment.status] }}</el-tag>
        </header>
        <dl class="quality-card-metrics">
          <div><dt>干信比 GXB（dB）</dt><dd data-metric="jsrDb">{{ metricText(row.runtimeQuality ? row.runtimeQuality.measurement.quality.gxbDb : row.detailed?.jsrDb, 2) }}</dd></div>
          <div><dt>误码率</dt><dd>{{ berText(row.runtimeQuality ? row.runtimeQuality.measurement.quality.ber : row.ber) }}</dd></div>
          <div><dt>发射辐射功率（dBW）</dt><dd>{{ metricText(row.runtimeQuality?.measurement.quality.inputTrace.eirpDbw, 2) }}</dd></div>
          <div><dt>距离（m）</dt><dd>{{ metricText(row.runtimeQuality ? row.runtimeQuality.measurement.distanceMeters : row.detailed?.distance, 2) }}</dd></div>
        </dl>
      </article>
    </div>
    <p v-else>暂无数据</p>
  </section>
</template>

<style scoped>
.quality-metric-panel { height: 100%; font-size: 12px; color: var(--console-text); }
.quality-metric-panel p { margin: 6px 0; color: var(--el-text-color-secondary); }
</style>
<style scoped src="./quality-cards.css"></style>

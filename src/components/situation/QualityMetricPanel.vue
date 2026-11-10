<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SituationLinkView } from '../../features/situation/situation-model'
import { formatBer, LINK_TYPE_LABELS } from '../../features/situation/situation-model'
import { reportTime } from '../../features/reports/local-report'
import type { RuntimeLinkQualityView } from '../../features/situation/runtime-quality-view'
import { RUNTIME_STATUS_LABELS, runtimeDecisionReason } from '../../features/situation/runtime-quality-view'

type QualityLink = Pick<SituationLinkView, 'linkId' | 'sourceName' | 'destinationName'>
  & Partial<Pick<SituationLinkView, 'snrDb' | 'ber' | 'updatedAt' | 'ageMs' | 'detailed' | 'type'>>
  & { runtimeQuality?: RuntimeLinkQualityView | null }
const props = defineProps<{ links: QualityLink[]; nodes: string[]; sourceKey: string; selectedLinkId?: string }>()
const node = ref('')
const linkId = ref('')
const windowMs = ref(0)
const linkType = ref('')
/** 只列出当前数据中实际出现的体制；缺少体制的链路在选择类型后不显示。 */
const linkTypes = computed(() => [...new Set(props.links.flatMap(link => link.type ? [link.type] : []))])
const rows = computed(() => props.links.filter(link => {
  const ageMs = link.runtimeQuality ? link.runtimeQuality.ageMs : link.ageMs
  return (!node.value || link.sourceName === node.value || link.destinationName === node.value)
    && (!linkId.value || link.linkId === linkId.value) && (!linkType.value || link.type === linkType.value)
    && (ageMs === undefined || ageMs === null || ageMs <= windowMs.value)
}))
watch(() => props.sourceKey, () => { node.value = ''; linkId.value = ''; windowMs.value = 0; linkType.value = '' })
/** 引擎可选提供的质量扩展字段；缺省显示“暂无数据”，有值后直接展示。 */
const OPTIONAL_METRIC_COLUMNS = [
  { key: 'jsrDb', label: '干信比 GXB（dB）', digits: 2 },
  { key: 'latencyMs', label: '时延（ms）', digits: 1 },
  { key: 'availabilityPercent', label: '可用率（%）', digits: 1 },
] as const
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
      <el-form-item label="节点"><el-select v-model="node" clearable placeholder="全部节点"><el-option v-for="name in nodes" :key="name" :label="name" :value="name" /></el-select></el-form-item>
      <el-form-item label="链路类型"><el-select v-model="linkType" clearable placeholder="全部类型" data-testid="quality-link-type"><el-option v-for="type in linkTypes" :key="type" :value="type" :label="LINK_TYPE_LABELS[type]" /></el-select></el-form-item>
      <details class="quality-card-advanced">
        <summary>更多筛选<span v-if="linkId || windowMs">（已应用）</span></summary>
        <el-form-item label="链路"><el-select v-model="linkId" clearable placeholder="全部链路"><el-option v-for="link in links" :key="link.linkId" :value="link.linkId" :label="`${link.sourceName} → ${link.destinationName}`" /></el-select></el-form-item>
        <el-form-item label="时间窗口"><el-select v-model="windowMs"><el-option label="当前时刻" :value="0" /><el-option label="最近1秒" :value="1000" /><el-option label="最近5秒" :value="5000" /></el-select></el-form-item>
        <p>时间窗口筛选年龄已知的测量；年龄未知时保留源时刻。未提供的指标显示“暂无数据”，不代表当前时刻已有测量。</p>
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
          <div><dt>BER</dt><dd>{{ berText(row.runtimeQuality ? row.runtimeQuality.measurement.quality.ber : row.ber) }}</dd></div>
          <div><dt>接收功率（dBm）</dt><dd>{{ row.runtimeQuality ? row.runtimeQuality.measurement.quality.receivedPowerDbm ?? '暂无数据' : row.detailed?.receivedPower ?? '暂无数据' }}</dd></div>
          <div><dt>距离（m）</dt><dd>{{ metricText(row.runtimeQuality ? row.runtimeQuality.measurement.distanceMeters : row.detailed?.distance, 2) }}</dd></div>
        </dl>
        <details class="quality-card-details">
          <summary>详细参数</summary>
          <dl class="quality-card-fields">
            <div><dt>链路编号</dt><dd>{{ row.linkId }}</dd></div>
            <div><dt>链路类型</dt><dd>{{ row.type ? LINK_TYPE_LABELS[row.type] : '暂无数据' }}</dd></div>
            <div><dt>源时刻</dt><dd>{{ row.runtimeQuality ? reportTime(row.runtimeQuality.simulationTime) : Number.isFinite(row.updatedAt) ? reportTime(row.updatedAt) : '暂无数据' }}</dd></div>
            <div><dt>SNR（dB）</dt><dd>{{ metricText(row.runtimeQuality ? row.runtimeQuality.measurement.quality.snrDb : row.snrDb, 2) }}</dd></div>
            <div><dt>路径损耗（dB）</dt><dd>{{ metricText(row.runtimeQuality ? row.runtimeQuality.measurement.losses.totalLossDb : row.detailed?.pathLoss, 2) }}</dd></div>
            <div v-for="column in OPTIONAL_METRIC_COLUMNS.filter(column => column.key !== 'jsrDb')" :key="column.key"><dt>{{ column.label }}</dt><dd :data-metric="column.key">{{ metricText(row.runtimeQuality ? null : row.detailed?.[column.key], column.digits) }}</dd></div>
            <div v-if="row.runtimeQuality?.assessment"><dt>状态原因</dt><dd>{{ runtimeDecisionReason(row.runtimeQuality.assessment.reason) }}</dd></div>
          </dl>
        </details>
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

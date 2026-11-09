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
  <section class="quality-metric-panel" aria-label="实时质量指标" data-testid="quality-metric-panel">
    <el-form label-position="top" class="quality-filters">
      <el-form-item label="节点"><el-select v-model="node" clearable placeholder="全部节点"><el-option v-for="name in nodes" :key="name" :label="name" :value="name" /></el-select></el-form-item>
      <el-form-item label="链路"><el-select v-model="linkId" clearable placeholder="全部链路"><el-option v-for="link in links" :key="link.linkId" :value="link.linkId" :label="`${link.sourceName} → ${link.destinationName}`" /></el-select></el-form-item>
      <el-form-item label="时间窗口"><el-select v-model="windowMs"><el-option label="当前时刻" :value="0" /><el-option label="最近1秒" :value="1000" /><el-option label="最近5秒" :value="5000" /></el-select></el-form-item>
      <el-form-item label="链路类型"><el-select v-model="linkType" clearable placeholder="全部类型" data-testid="quality-link-type"><el-option v-for="type in linkTypes" :key="type" :value="type" :label="LINK_TYPE_LABELS[type]" /></el-select></el-form-item>
    </el-form>
    <el-table :data="rows" empty-text="暂无数据" height="100%">
      <el-table-column label="链路" min-width="200"><template #default="{ row }">{{ row.sourceName }} → {{ row.destinationName }}</template></el-table-column>
      <el-table-column label="源时刻" min-width="100"><template #default="{ row }">{{ row.runtimeQuality ? reportTime(row.runtimeQuality.simulationTime) : Number.isFinite(row.updatedAt) ? reportTime(row.updatedAt) : '暂无数据' }}</template></el-table-column>
      <el-table-column label="SNR（dB）" min-width="100"><template #default="{ row }">{{ metricText(row.runtimeQuality ? row.runtimeQuality.measurement.quality.snrDb : row.snrDb, 2) }}</template></el-table-column>
      <el-table-column label="BER" min-width="100"><template #default="{ row }">{{ berText(row.runtimeQuality ? row.runtimeQuality.measurement.quality.ber : row.ber) }}</template></el-table-column>
      <el-table-column label="接收功率（dBm）" min-width="140"><template #default="{ row }">{{ row.runtimeQuality ? row.runtimeQuality.measurement.quality.receivedPowerDbm ?? '暂无数据' : row.detailed?.receivedPower ?? '暂无数据' }}</template></el-table-column>
      <el-table-column label="路径损耗（dB）" min-width="130"><template #default="{ row }">{{ metricText(row.runtimeQuality ? row.runtimeQuality.measurement.losses.totalLossDb : row.detailed?.pathLoss, 2) }}</template></el-table-column>
      <el-table-column v-for="column in OPTIONAL_METRIC_COLUMNS" :key="column.key" :label="column.label" min-width="110">
        <template #default="{ row }">{{ metricText(row.runtimeQuality ? (column.key === 'jsrDb' ? row.runtimeQuality.measurement.quality.gxbDb : null) : row.detailed?.[column.key], column.digits) }}</template>
      </el-table-column>
      <el-table-column v-if="links.some(link => link.runtimeQuality?.assessment)" label="质量状态" min-width="110">
        <template #default="{ row }"><el-tag v-if="row.runtimeQuality?.assessment" :type="row.runtimeQuality.assessment.status === 'UP' ? 'success' : row.runtimeQuality.assessment.status === 'DEGRADED' ? 'warning' : row.runtimeQuality.assessment.status === 'DOWN' ? 'danger' : 'info'" :title="runtimeDecisionReason(row.runtimeQuality.assessment.reason)">{{ RUNTIME_STATUS_LABELS[row.runtimeQuality.assessment.status] }}</el-tag><span v-else>暂无数据</span></template>
      </el-table-column>
    </el-table>
    <p>时间窗口筛选年龄已知的测量；年龄未知时保留源时刻。未提供的指标显示“暂无数据”，不代表当前时刻已有测量。</p>
  </section>
</template>

<style scoped>
.quality-metric-panel { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; }
.quality-metric-panel > .el-table { flex: 1; min-height: 0; }
.quality-filters { display: grid; flex: 0 0 auto; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.quality-filters :deep(.el-form-item) { min-width: 0; margin-bottom: 8px; }
p { flex: 0 0 auto; font-size: 12px; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
</style>

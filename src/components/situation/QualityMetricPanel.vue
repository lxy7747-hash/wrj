<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SituationLinkView } from '../../features/situation/situation-model'
import { formatBer } from '../../features/situation/situation-model'
import { reportTime } from '../../features/reports/local-report'

type QualityLink = Pick<SituationLinkView, 'linkId' | 'sourceName' | 'destinationName'>
  & Partial<Pick<SituationLinkView, 'snrDb' | 'ber' | 'updatedAt' | 'ageMs' | 'detailed'>>
const props = defineProps<{ links: QualityLink[]; nodes: string[]; sourceKey: string; selectedLinkId?: string }>()
const node = ref('')
const linkId = ref('')
const windowMs = ref(0)
const rows = computed(() => props.links.filter(link => (!node.value || link.sourceName === node.value || link.destinationName === node.value)
  && (!linkId.value || link.linkId === linkId.value) && (link.ageMs === undefined || link.ageMs <= windowMs.value)))
watch(() => props.sourceKey, () => { node.value = ''; linkId.value = ''; windowMs.value = 0 })
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
    </el-form>
    <el-table :data="rows" empty-text="暂无数据" height="100%">
      <el-table-column label="链路" min-width="200"><template #default="{ row }">{{ row.sourceName }} → {{ row.destinationName }}</template></el-table-column>
      <el-table-column label="源时刻" min-width="100"><template #default="{ row }">{{ Number.isFinite(row.updatedAt) ? reportTime(row.updatedAt) : '暂无数据' }}</template></el-table-column>
      <el-table-column label="SNR（dB）" min-width="100"><template #default="{ row }">{{ Number.isFinite(row.snrDb) ? row.snrDb.toFixed(2) : '暂无数据' }}</template></el-table-column>
      <el-table-column label="BER" min-width="100"><template #default="{ row }">{{ Number.isFinite(row.ber) ? formatBer(row.ber) : '暂无数据' }}</template></el-table-column>
      <el-table-column label="接收功率（dBm）" min-width="140"><template #default="{ row }">{{ row.detailed?.receivedPower ?? '暂无数据' }}</template></el-table-column>
      <el-table-column v-for="label in ['干信比（dB）', '时延（ms）', '可用率（%）']" :key="label" :label="label" min-width="110"><template #default>暂无数据</template></el-table-column>
    </el-table>
    <p>时间窗口仅筛选已有测量；未提供测量的链路保留展示，各指标显示“暂无数据”，不代表当前时刻已有测量。</p>
  </section>
</template>

<style scoped>
.quality-metric-panel { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; }
.quality-metric-panel > .el-table { flex: 1; min-height: 0; }
.quality-filters { display: grid; flex: 0 0 auto; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.quality-filters :deep(.el-form-item:last-child) { grid-column: 1 / -1; }
.quality-filters :deep(.el-form-item) { min-width: 0; margin-bottom: 8px; }
p { flex: 0 0 auto; font-size: 12px; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
</style>

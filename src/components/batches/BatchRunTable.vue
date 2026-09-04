<script setup lang="ts">
import type { BatchRunResult } from '../../contracts/domain-models'

const props = defineProps<{
  runs: BatchRunResult[]
  selectedRunId: string | null
}>()

const emit = defineEmits<{
  select: [runId: string]
}>()

/** 将运行状态转换为中文标签。 */
function statusLabel(status: BatchRunResult['status']): string {
  return status === 'COMPLETED' ? '已完成' : '失败'
}

/**
 * 返回当前选中行的样式名称。
 * @param row Element Plus 表格传入的运行行。
 */
function rowClassName({ row }: { row: BatchRunResult }): string {
  return row.runId === props.selectedRunId ? 'is-selected' : ''
}

/**
 * 转发用户选择的运行行。
 * @param row 被点击的运行结果。
 */
function selectRow(row: BatchRunResult): void {
  emit('select', row.runId)
}
</script>

<template>
  <el-table
    data-testid="batch-run-table"
    :data="runs"
    height="100%"
    :row-class-name="rowClassName"
    @row-click="selectRow"
  >
    <el-table-column prop="runId" label="运行编号" min-width="105" fixed="left" />
    <el-table-column prop="reportId" label="报告编号" min-width="105" />
    <el-table-column prop="powerW" label="功率（W）" min-width="90" />
    <el-table-column prop="distanceKm" label="距离（km）" min-width="100" />
    <el-table-column prop="connectivityRate" label="连通率（%）" min-width="110" />
    <el-table-column prop="connectivityDurationS" label="连通时长（s）" min-width="125" />
    <el-table-column prop="avgSnrDb" label="平均 SNR（dB）" min-width="125" />
    <el-table-column prop="minSnrDb" label="最小 SNR（dB）" min-width="125" />
    <el-table-column prop="avgBer" label="平均 BER" min-width="105" />
    <el-table-column prop="maxBer" label="最大 BER" min-width="105" />
    <el-table-column prop="switchCount" label="切换次数" min-width="90" />
    <el-table-column prop="interferenceDurationS" label="受扰时长（s）" min-width="115" />
    <el-table-column label="状态" min-width="85" fixed="right">
      <template #default="scope">
        <el-tag :type="scope.row.status === 'COMPLETED' ? 'success' : 'danger'" effect="plain">
          {{ statusLabel(scope.row.status) }}
        </el-tag>
      </template>
    </el-table-column>
  </el-table>
</template>

<style scoped>
:deep(.el-table__row) {
  cursor: pointer;
}

:deep(.el-table__row.is-selected td.el-table__cell) {
  background: color-mix(in srgb, var(--console-cyan) 14%, var(--console-surface));
}
</style>

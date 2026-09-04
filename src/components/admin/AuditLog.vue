<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { AuditRecord, Role } from '../../contracts/domain-models'
import { type AuditFilters, useAdminStore } from '../../stores/admin'

const adminStore = useAdminStore()
const {
  auditRecords,
  auditState,
  auditResultCode,
  auditResultMessage,
  auditConfirmation,
  auditExportStatus,
} = storeToRefs(adminStore)

const timeRange = ref<[Date, Date] | null>(null)
const actor = ref('')
const role = ref<Role | ''>('')
const module = ref('')
const result = ref<AuditRecord['result'] | ''>('')

const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(auditState.value))

function selectedFilters(): AuditFilters {
  return {
    ...(timeRange.value === null ? {} : {
      from: timeRange.value[0].toISOString(),
      to: timeRange.value[1].toISOString(),
    }),
    ...(actor.value.trim() === '' ? {} : { actor: actor.value.trim() }),
    ...(role.value === '' ? {} : { role: role.value }),
    ...(module.value.trim() === '' ? {} : { module: module.value.trim() }),
    ...(result.value === '' ? {} : { result: result.value }),
  }
}

function queryAudit(): void {
  void adminStore.loadAudit(selectedFilters())
}

function exportAudit(): void {
  void adminStore.exportAudit(selectedFilters())
}

function confirmExport(): void {
  void adminStore.confirmAuditExport()
}

function cancelExport(): void {
  adminStore.cancelAuditExport()
}

function tableRowClassName({ row }: { row: AuditRecord }): string {
  return row.result === 'SUCCESS' ? '' : 'risk-row'
}

onMounted(queryAudit)
</script>

<template>
  <div class="audit-log-card" data-testid="audit-log-panel">
    <h3 id="audit-logs-title" class="audit-title">操作审计日志</h3>

    <div class="filter-bar" aria-label="审计筛选条件">
      <el-date-picker
        v-model="timeRange"
        class="filter-time-range"
        type="datetimerange"
        range-separator="~"
        start-placeholder="开始时间"
        end-placeholder="结束时间"
      />
      <el-input v-model="actor" class="filter-field--actor" aria-label="用户" placeholder="用户" clearable />
      <el-select v-model="role" class="filter-field--fixed" aria-label="角色" placeholder="全部角色">
        <el-option label="全部角色" value="" />
        <el-option label="管理员（ADMIN）" value="ADMIN" />
        <el-option label="操作员（OPERATOR）" value="OPERATOR" />
      </el-select>
      <el-input v-model="module" class="filter-field--module" aria-label="模块" placeholder="模块" clearable />
      <el-select v-model="result" class="filter-field--result" aria-label="结果" placeholder="全部结果">
        <el-option label="全部结果" value="" />
        <el-option label="成功" value="SUCCESS" />
        <el-option label="已拒绝" value="DENIED" />
        <el-option label="错误" value="ERROR" />
      </el-select>
      <el-button type="primary" :loading="pending" @click="queryAudit">查询</el-button>
      <el-button :loading="pending" @click="exportAudit">确认并验证导出</el-button>
    </div>

    <p v-if="auditState === 'LOADING'" data-testid="audit-state">正在准备审计查询…</p>
    <p v-else-if="auditState === 'VALIDATING'" data-testid="audit-state">正在校验审计响应…</p>
    <p v-else-if="auditState === 'EXECUTING'" data-testid="audit-state">正在执行审计操作…</p>
    <el-alert
      v-else-if="auditState === 'ERROR'"
      data-testid="audit-error"
      type="error"
      :closable="false"
      :title="`${auditResultCode}：${auditResultMessage}`"
    />
    <el-empty v-else-if="auditState === 'EMPTY'" data-testid="audit-empty" :description="auditResultMessage" />
    <el-table
      v-else
      data-testid="audit-table"
      :data="auditRecords"
      stripe
      :row-class-name="tableRowClassName"
      style="width: 100%"
    >
      <el-table-column prop="occurredAt" label="时间" />
      <el-table-column prop="actor" label="用户" />
      <el-table-column prop="role" label="角色" />
      <el-table-column prop="module" label="模块" />
      <el-table-column prop="action" label="操作" />
      <el-table-column prop="objectId" label="操作对象" />
      <el-table-column prop="result" label="结果" />
    </el-table>

    <el-descriptions
      v-if="auditExportStatus !== null"
      data-testid="audit-export-status"
      title="导出验证结果"
      :column="1"
      border
    >
      <el-descriptions-item label="数据分级">{{ auditExportStatus.classification }}</el-descriptions-item>
      <el-descriptions-item label="水印">{{ auditExportStatus.watermark }}</el-descriptions-item>
      <el-descriptions-item label="验证时间">{{ auditExportStatus.verifiedAt }}</el-descriptions-item>
    </el-descriptions>

    <el-dialog
      :model-value="auditConfirmation !== null"
      title="确认导出审计日志"
      width="460px"
      @update:model-value="(visible: boolean) => { if (!visible) cancelExport() }"
    >
      <p>将按当前筛选条件验证审计日志导出，本阶段不会生成真实文件。</p>
      <template #footer>
        <el-button @click="cancelExport">取消</el-button>
        <el-button
          type="primary"
          data-testid="confirm-audit-export"
          :loading="pending"
          @click="confirmExport"
        >
          确认导出
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.audit-log-card {
  display: grid;
  gap: 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 10px;
  align-content: start;
}

.audit-title {
  margin: 0;
  padding: 0 0 10px 10px;
  border-bottom: 1px solid #1e3448;
  font-size: 18px;
  font-weight: 500;
}

.filter-bar {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) 150px 250px 200px 200px auto auto;
  gap: 12px;
  align-items: center;
}

.filter-field--fixed {
  width: 250px;
}

.filter-field--actor {
  width: 150px;
}

.filter-field--module,
.filter-field--result {
  width: 200px;
}

.filter-bar :deep(.filter-time-range) {
  width: 100%;
}

:deep(.risk-row) {
  background-color: #fff2f2 !important;
}

:deep(.risk-row td) {
  color: #e53935;
}

@media (max-width: 1500px) {
  .filter-bar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

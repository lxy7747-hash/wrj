<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { storeToRefs } from 'pinia'
import type { AuditRecord, Role } from '../../contracts/domain-models'
import { type AuditFilters, useAdminStore } from '../../stores/admin'
import { formatDateTime } from '../../features/shared/date-time'
import { formatAction, formatModule, formatObject, roleLabels, resultLabels } from '../../features/admin/audit-labels'

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

let active = true
onBeforeUnmount(() => {
  active = false
  if (auditConfirmation.value !== null) adminStore.cancelAuditExport()
})

async function confirmExport(): Promise<void> {
  if (!await adminStore.confirmAuditExport() || !active || auditExportStatus.value === null) return
  const result = auditExportStatus.value
  let url: string | undefined
  const link = document.createElement('a')
  try {
    url = URL.createObjectURL(new Blob(['\uFEFF', result.content], { type: 'text/plain;charset=utf-8' }))
    link.href = url
    link.download = result.fileName
    document.body.append(link)
    link.click()
    ElMessage.success(`已发起下载，共 ${result.recordCount} 条审计记录。`)
  } catch {
    ElMessage.error('下载未能启动，请重新发起导出。')
  } finally {
    link.remove()
    if (url !== undefined) URL.revokeObjectURL(url)
  }
}

function cancelExport(): void {
  adminStore.cancelAuditExport()
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
      <el-button :loading="pending" @click="exportAudit">导出日志</el-button>
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
      :row-class-name="({ row }: { row: AuditRecord }) => row.result === 'SUCCESS' ? '' : 'risk-row'"
      style="width: 100%"
    >
      <el-table-column prop="occurredAt" label="时间" min-width="180" :formatter="(row: AuditRecord) => formatDateTime(row.occurredAt)" />
      <el-table-column prop="actor" label="用户" />
      <el-table-column prop="role" label="角色" :formatter="(row: AuditRecord) => roleLabels[row.role]" />
      <el-table-column prop="module" label="模块" :formatter="formatModule" />
      <el-table-column prop="action" label="操作" :formatter="formatAction" />
      <el-table-column prop="objectId" label="操作对象" :formatter="formatObject" />
      <el-table-column prop="result" label="结果" :formatter="(row: AuditRecord) => resultLabels[row.result]" />
    </el-table>

    <el-descriptions
      v-if="auditExportStatus !== null"
      data-testid="audit-export-status"
      title="导出文件信息"
      :column="1"
      border
    >
      <el-descriptions-item label="文件">{{ auditExportStatus.fileName }}</el-descriptions-item>
      <el-descriptions-item label="记录数量">{{ auditExportStatus.recordCount }}</el-descriptions-item>
      <el-descriptions-item label="数据分级">内部使用</el-descriptions-item>
      <el-descriptions-item label="水印">{{ auditExportStatus.watermark }}</el-descriptions-item>
      <el-descriptions-item label="验证时间">{{ formatDateTime(auditExportStatus.verifiedAt) }}</el-descriptions-item>
    </el-descriptions>

    <el-dialog
      :model-value="auditConfirmation !== null"
      title="确认导出审计日志"
      width="460px"
      @update:model-value="(visible: boolean) => { if (!visible) cancelExport() }"
    >
      <p>将按发起导出时的筛选条件下载 TXT 日志。文件为开发验证用明文，尚未加密，请妥善保管。</p>
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

:deep(.risk-row td) {
  color: #e53935;
}

@media (max-width: 1500px) {
  .filter-bar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

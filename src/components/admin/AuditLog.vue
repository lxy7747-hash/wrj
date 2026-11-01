<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { storeToRefs } from 'pinia'
import type { AuditRecord, Role } from '../../contracts/domain-models'
import { type AuditFilters, useAdminStore } from '../../stores/admin'
import { formatDateTime } from '../../features/shared/date-time'
import { auditActionOptions, formatAction, formatModule, formatObject, roleLabels, resultLabels } from '../../features/admin/audit-labels'

const adminStore = useAdminStore()
const {
  auditRecords,
  auditState,
  auditResultCode,
  auditResultMessage,
  auditConfirmation,
  auditExportStatus,
  auditPage,
  auditPageSize,
  auditSortOrder,
  auditTotal,
} = storeToRefs(adminStore)

const timeRange = ref<[Date, Date] | null>(null)
const actor = ref('')
const role = ref<Role | ''>('')
const module = ref('')
const result = ref<AuditRecord['result'] | ''>('')
const action = ref('')
const actionOptions = computed(() => {
  const options = new Map(auditActionOptions.map(option => [option.value, option]))
  for (const record of auditRecords.value) {
    if (!options.has(record.action)) options.set(record.action, { value: record.action, label: formatAction(record) })
  }
  return [...options.values()]
})

const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(auditState.value))
const selectedAuditIds = ref<string[]>([])
const deleteConfirming = ref(false)
const operationPending = computed(() => pending.value || deleteConfirming.value)

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
    ...(action.value.trim() === '' ? {} : { action: action.value.trim() }),
  }
}

function queryAudit(): void {
  selectedAuditIds.value = []
  void adminStore.loadAudit(selectedFilters(), {
    page: 1,
    pageSize: auditPageSize.value,
    sortOrder: auditSortOrder.value,
  })
}

function exportAudit(): void {
  void adminStore.exportAudit(selectedFilters())
}

let active = true
onBeforeUnmount(() => {
  active = false
  selectedAuditIds.value = []
  if (auditConfirmation.value !== null) adminStore.cancelAuditExport()
})

function loadAuditPage(page: number, pageSize = auditPageSize.value, sortOrder = auditSortOrder.value): void {
  selectedAuditIds.value = []
  void adminStore.loadAudit(adminStore.auditFilters, { page, pageSize, sortOrder })
}

function changeAuditPage(page: number): void {
  loadAuditPage(page)
}

function changeAuditPageSize(pageSize: number): void {
  loadAuditPage(1, pageSize)
}

function sortAudit({ prop, order }: { prop?: string, order?: 'ascending' | 'descending' | null }): void {
  if (prop !== 'occurredAt') return
  loadAuditPage(1, auditPageSize.value, order === 'ascending' ? 'asc' : 'desc')
}

function updateAuditSelection(rows: AuditRecord[]): void {
  selectedAuditIds.value = rows.map(row => row.auditId)
}

async function deleteAudits(auditIds: string[]): Promise<void> {
  if (auditIds.length === 0 || operationPending.value) return
  const ids = [...auditIds]
  const requestEpoch = adminStore.requestEpoch
  deleteConfirming.value = true
  try {
    await ElMessageBox.confirm(
      `确认删除选中的 ${ids.length} 条审计日志？删除后不可恢复。`,
      '删除审计日志',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    )
    if (!active || requestEpoch !== adminStore.requestEpoch) return
    if (await adminStore.deleteAudit(ids) && active && requestEpoch === adminStore.requestEpoch) {
      selectedAuditIds.value = []
      ElMessage.success(`已删除 ${ids.length} 条审计日志。`)
    }
  } catch {
    // 用户取消确认时不发请求，也不显示误导性的操作结果。
  } finally {
    deleteConfirming.value = false
  }
}

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
      <el-select :model-value="action" class="filter-field--action" aria-label="操作类型" placeholder="全部操作类型" filterable clearable allow-create default-first-option data-testid="audit-action-filter" @update:model-value="action = $event ?? ''">
        <el-option label="全部操作类型" value="" />
        <el-option v-for="option in actionOptions" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>
      <el-button type="primary" :loading="pending" :disabled="deleteConfirming" @click="queryAudit">查询</el-button>
      <el-button :loading="pending" :disabled="deleteConfirming" @click="exportAudit">导出日志</el-button>
    </div>

    <div class="audit-actions">
      <el-button
        type="danger"
        data-testid="audit-delete-selected"
        :disabled="selectedAuditIds.length === 0 || operationPending"
        :loading="deleteConfirming"
        @click="deleteAudits(selectedAuditIds)"
      >
        删除选中（{{ selectedAuditIds.length }}）
      </el-button>
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
      :default-sort="{ prop: 'occurredAt', order: auditSortOrder === 'asc' ? 'ascending' : 'descending' }"
      @selection-change="updateAuditSelection"
      @sort-change="sortAudit"
    >
      <el-table-column type="selection" width="48" />
      <el-table-column prop="occurredAt" label="时间" min-width="180" sortable="custom" :sort-orders="['descending', 'ascending']" :formatter="(row: AuditRecord) => formatDateTime(row.occurredAt)" />
      <el-table-column prop="actor" label="用户" />
      <el-table-column prop="role" label="角色" :formatter="(row: AuditRecord) => roleLabels[row.role]" />
      <el-table-column prop="module" label="模块" :formatter="formatModule" />
      <el-table-column prop="action" label="操作" :formatter="formatAction" />
      <el-table-column prop="objectId" label="操作对象" :formatter="formatObject" />
      <el-table-column prop="result" label="结果" :formatter="(row: AuditRecord) => resultLabels[row.result]" />
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="{ row }: { row: AuditRecord }">
          <el-button
            link
            type="danger"
            :data-testid="`delete-audit-${row.auditId}`"
            :disabled="operationPending"
            @click="deleteAudits([row.auditId])"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-if="auditState === 'SUCCESS'"
      data-testid="audit-pagination"
      :current-page="auditPage"
      :page-size="auditPageSize"
      :page-sizes="[20, 50, 100]"
      :total="auditTotal"
      layout="total, sizes, prev, pager, next"
      @update:current-page="changeAuditPage"
      @update:page-size="changeAuditPageSize"
    />

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
  grid-template-columns: minmax(260px, 1fr) 150px 200px 180px 140px 200px auto auto;
  gap: 12px;
  align-items: center;
}

.filter-field--fixed {
  width: 200px;
}

.filter-field--actor {
  width: 150px;
}

.filter-field--module,
.filter-field--action {
  width: 200px;
}

.filter-field--result { width: 140px; }

.filter-bar :deep(.filter-time-range) {
  width: 100%;
}

.audit-actions {
  display: flex;
  justify-content: flex-end;
}

:deep(.risk-row td) {
  color: #e53935;
}

@media (max-width: 1800px) {
  .filter-bar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

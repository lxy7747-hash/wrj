<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useAdminStore } from '../../stores/admin'
import { formatDateTime } from '../../features/shared/date-time'
import DataExchangeStateTag from '../data-exchange/DataExchangeStateTag.vue'

const store = useAdminStore()
const selectedBackupId = ref('')
const feedback = computed(() => store.maintenance.backup)
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(feedback.value.state))
const restore = computed(() => store.restoreResult)

watch(selectedBackupId, () => store.clearRestoreResult())

/** 确认备份或恢复；取消或离开当前页面后不执行请求。 */
async function execute(operation: 'BACKUP' | 'RESTORE'): Promise<void> {
  const labels = { BACKUP: '创建备份', RESTORE: '恢复备份' }
  const targetId = selectedBackupId.value
  const epoch = store.maintenanceEpoch
  try {
    await ElMessageBox.confirm(operation === 'RESTORE'
      ? `确认从“${targetId}”恢复？系统将先保留恢复前备份，完整性校验失败时终止恢复。`
      : `确认${labels[operation]}？当前阶段仅验证流程，不生成实际文件。`, labels[operation], { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning' })
    if (epoch === store.maintenanceEpoch) await store.runMaintenanceAction(operation, targetId)
  } catch { /* 用户取消时保留当前记录。 */ }
}

onMounted(() => { void store.loadMaintenance('backup') })
onBeforeUnmount(() => store.resetMaintenance())
</script>

<template>
  <section id="cap-bfhf" class="maintenance-card" aria-label="数据库备份与恢复" data-testid="backup-panel">
    <header class="maintenance-toolbar"><h3>数据库备份 / 恢复</h3><DataExchangeStateTag :state="feedback.state" /><el-button :disabled="pending" @click="store.loadMaintenance('backup')">刷新记录</el-button><el-button type="primary" :disabled="pending" data-testid="backup-create" @click="execute('BACKUP')">创建备份</el-button></header>
    <p class="maintenance-note">当前验证备份与恢复流程，不读写实际数据库或备份文件。</p>
    <el-alert v-if="feedback.message" :title="feedback.message" :type="feedback.state === 'ERROR' ? 'error' : 'info'" :closable="false" data-testid="backup-feedback" />
    <el-table v-loading="pending" :data="store.backups" row-key="backupId" stripe empty-text="暂无备份记录" data-testid="backup-table">
      <el-table-column prop="backupId" label="备份编号" min-width="190" />
      <el-table-column prop="createdAt" label="创建时间" min-width="180"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
      <el-table-column label="完整性" width="110"><template #default="{ row }"><el-tag :type="row.status === 'VALID_FIXTURE' ? 'success' : 'danger'">{{ row.status === 'VALID_FIXTURE' ? '校验通过' : '校验失败' }}</el-tag></template></el-table-column>
      <el-table-column prop="checksum" label="校验和" min-width="180" />
      <el-table-column label="操作" width="120" fixed="right"><template #default="{ row }"><el-button link type="primary" :disabled="pending" @click="selectedBackupId = row.backupId">选择恢复</el-button></template></el-table-column>
    </el-table>
    <el-form inline class="maintenance-toolbar" @submit.prevent>
      <el-form-item label="恢复来源"><el-select v-model="selectedBackupId" style="width: 260px" :disabled="pending" placeholder="请选择备份" aria-label="恢复来源"><el-option v-for="backup in store.backups" :key="backup.backupId" :label="backup.backupId" :value="backup.backupId" /></el-select></el-form-item>
      <el-button type="warning" :disabled="pending || !selectedBackupId || !store.backups.some((item) => item.backupId === selectedBackupId)" data-testid="backup-restore" @click="execute('RESTORE')">恢复所选备份</el-button>
    </el-form>
    <div v-if="restore" class="maintenance-result" data-testid="restore-result">
      <el-steps :active="restore.result === 'SUCCESS' ? 3 : restore.integrityValid ? 2 : 1" :process-status="restore.result === 'FAILURE' ? 'error' : 'success'" finish-status="success" simple>
        <el-step title="恢复前备份" /><el-step title="完整性校验" /><el-step :title="restore.rolledBack ? '失败回滚' : '受控恢复'" />
      </el-steps>
      <el-progress :percentage="restore.progress" :status="restore.result === 'SUCCESS' ? 'success' : 'exception'" />
      <el-descriptions :column="2" border><el-descriptions-item label="恢复前备份">{{ restore.prebackupId }}</el-descriptions-item><el-descriptions-item label="完整性校验">{{ restore.integrityValid ? '通过' : '失败，恢复未开始' }}</el-descriptions-item><el-descriptions-item label="结果">{{ restore.result === 'SUCCESS' ? '成功' : '失败' }}</el-descriptions-item><el-descriptions-item label="回滚">{{ restore.rolledBack ? '已回滚' : '无需回滚' }}</el-descriptions-item></el-descriptions>
    </div>
  </section>
</template>

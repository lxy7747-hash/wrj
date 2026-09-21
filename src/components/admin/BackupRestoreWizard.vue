<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { useAdminStore } from '../../stores/admin'
import { useAuthStore } from '../../stores/auth'
import { formatDateTime } from '../../features/shared/date-time'
import DataExchangeStateTag from '../data-exchange/DataExchangeStateTag.vue'
import type { BackupPlan } from '../../contracts/domain-models'

const store = useAdminStore()
const auth = useAuthStore()
const router = useRouter()
const selectedBackupId = ref('')
const backupName = ref('手动备份')
const plan = ref<BackupPlan>({ version: 1, enabled: false, name: '定时备份', intervalMinutes: 1440 })
const feedback = computed(() => store.maintenance.backup)
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(feedback.value.state))
const restore = computed(() => store.restoreResult)

watch(selectedBackupId, () => store.clearRestoreResult())
watch(() => store.backupPlanStatus, value => { if (value) plan.value = { ...value.plan } })

async function savePlan(): Promise<void> {
  const epoch = store.maintenanceEpoch
  const value = { ...plan.value }
  try {
    await ElMessageBox.confirm(value.enabled ? `确认启用备份计划？服务运行时每 ${value.intervalMinutes} 分钟执行一次，不自动删除历史备份。` : '确认保存并停用备份计划？已有备份保留。', '保存备份计划', { confirmButtonText: '确认保存', cancelButtonText: '取消', type: 'warning' })
    if (epoch !== store.maintenanceEpoch) return
    if (await store.saveBackupPlan(value)) ElMessage.success('备份计划已保存。')
  } catch { /* 取消不保存或启用计划。 */ }
}

function reload(): void { void store.loadMaintenance('backup'); void store.loadBackupPlan() }

/** 确认备份或恢复；取消或离开当前页面后不执行请求。 */
async function execute(operation: 'BACKUP' | 'RESTORE'): Promise<void> {
  const labels = { BACKUP: '创建备份', RESTORE: '恢复备份' }
  const targetId = selectedBackupId.value
  const name = backupName.value
  if (operation === 'BACKUP' && (!name.trim() || name.length > 80)) { ElMessage.error('请输入 1～80 字的备份名称。'); return }
  const epoch = store.maintenanceEpoch
  try {
    await ElMessageBox.confirm(operation === 'RESTORE'
      ? `确认从“${targetId}”恢复备份范围内的场景、模板、账号、装备、角色权限、主数据、历史归档和白名单配置？审计与文件读取记录保留。系统先创建恢复前备份，校验失败不恢复，写入失败整体回滚。成功后需重新登录。`
      : `确认创建“${name}”备份？包含全部业务数据库及事件／位置文件路径，不包含源 CSV、密码环境变量或密钥。账号库内的密码散列属于恢复所需数据，备份未加密，请妥善保管。纯 Mock 不生成文件。`, labels[operation], { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning' })
    if (epoch !== store.maintenanceEpoch) return
    const succeeded = await store.runMaintenanceAction(operation, targetId, operation === 'BACKUP' ? name : undefined)
    if (epoch !== store.maintenanceEpoch || !succeeded) return
    ElMessage.success(feedback.value.message)
    if (operation === 'RESTORE' && restore.value?.generated) {
      auth.resetToSafeEmpty()
      await router.replace('/login')
    }
  } catch { /* 用户取消时保留当前记录。 */ }
}

onMounted(reload)
onBeforeUnmount(() => store.resetMaintenance())
</script>

<template>
  <section id="cap-bfhf" class="maintenance-card" aria-label="数据库备份与恢复" data-testid="backup-panel">
    <header class="maintenance-toolbar"><h3>数据库备份 / 恢复</h3><DataExchangeStateTag :state="feedback.state" /><el-input v-model="backupName" aria-label="备份名称" maxlength="80" style="width: 220px" :disabled="pending" /><el-button :disabled="pending || store.backupPlanPending" @click="reload">刷新记录</el-button><el-button type="primary" :disabled="pending" data-testid="backup-create" @click="execute('BACKUP')">创建备份</el-button></header>
    <p class="maintenance-note">系统备份包含场景、模板、账号、装备、角色权限、主数据、历史归档，以及事件／位置文件路径白名单；不备份源 CSV、凭据环境变量或密钥，不回退审计和文件读取记录。旧主库备份保留查看，不作为完整系统恢复来源。备份未加密，仅限非敏感开发数据。</p>
    <el-alert v-if="feedback.message && feedback.state !== 'SUCCESS'" :title="feedback.message" :type="feedback.state === 'ERROR' ? 'error' : 'info'" :closable="false" data-testid="backup-feedback" />
    <el-table v-loading="pending" :data="store.backups" row-key="backupId" stripe empty-text="暂无备份记录" data-testid="backup-table">
      <el-table-column prop="backupId" label="备份编号" min-width="190" />
      <el-table-column prop="name" label="备份名称" min-width="140"><template #default="{ row }">{{ row.name || '历史备份' }}</template></el-table-column>
      <el-table-column prop="createdAt" label="创建时间" min-width="180"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
      <el-table-column label="完整性" width="110"><template #default="{ row }"><el-tag :type="row.status === 'VALID' || row.status === 'VALID_FIXTURE' ? 'success' : 'danger'">{{ row.status === 'VALID' || row.status === 'VALID_FIXTURE' ? '校验通过' : '校验失败' }}</el-tag></template></el-table-column>
      <el-table-column label="范围" width="150"><template #default="{ row }">{{ row.status.endsWith('_FIXTURE') ? 'Mock 流程' : row.format === 'SYSTEM_SQLITE_V1' ? '全部业务库＋白名单配置' : '旧主库备份' }}</template></el-table-column>
      <el-table-column prop="checksum" label="校验和" min-width="180" />
      <el-table-column label="操作" width="120" fixed="right"><template #default="{ row }"><el-button link type="primary" :disabled="pending || row.format === 'MAIN_SQLITE_V1'" @click="selectedBackupId = row.backupId">选择恢复</el-button></template></el-table-column>
    </el-table>
    <el-form inline class="maintenance-toolbar" @submit.prevent>
      <el-form-item label="恢复来源"><el-select v-model="selectedBackupId" style="width: 260px" :disabled="pending" placeholder="请选择备份" aria-label="恢复来源"><el-option v-for="backup in store.backups" :key="backup.backupId" :label="backup.backupId" :value="backup.backupId" :disabled="backup.format === 'MAIN_SQLITE_V1'" /></el-select></el-form-item>
      <el-button type="warning" :disabled="pending || !selectedBackupId || !store.backups.some((item) => item.backupId === selectedBackupId)" data-testid="backup-restore" @click="execute('RESTORE')">恢复所选备份</el-button>
    </el-form>
    <div v-if="restore" class="maintenance-result" data-testid="restore-result">
      <el-steps :active="restore.result === 'SUCCESS' ? 3 : restore.integrityValid ? 2 : 1" :process-status="restore.result === 'FAILURE' ? 'error' : 'success'" finish-status="success" simple>
        <el-step title="恢复前备份" /><el-step title="完整性校验" /><el-step :title="restore.rolledBack ? '失败回滚' : '受控恢复'" />
      </el-steps>
      <el-progress :percentage="restore.progress" :status="restore.result === 'SUCCESS' ? 'success' : 'exception'" />
      <el-descriptions :column="2" border><el-descriptions-item label="恢复前备份">{{ restore.prebackupId }}</el-descriptions-item><el-descriptions-item label="完整性校验">{{ restore.integrityValid ? '通过' : '失败，恢复未开始' }}</el-descriptions-item><el-descriptions-item label="结果">{{ restore.result === 'SUCCESS' ? '成功' : '失败' }}</el-descriptions-item><el-descriptions-item label="回滚">{{ restore.rolledBack ? '已回滚' : '无需回滚' }}</el-descriptions-item></el-descriptions>
    </div>
    <section aria-label="备份计划" data-testid="backup-plan">
      <h4>备份计划</h4>
      <el-alert v-if="store.backupPlanError" :title="store.backupPlanError" type="error" :closable="false" />
      <el-form inline @submit.prevent="savePlan">
        <el-form-item label="启用"><el-switch v-model="plan.enabled" aria-label="启用备份计划" :disabled="store.backupPlanPending || !store.backupPlanStatus" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="plan.name" aria-label="计划名称" maxlength="80" :disabled="store.backupPlanPending || !store.backupPlanStatus" /></el-form-item>
        <el-form-item label="间隔（分钟）"><el-input-number v-model="plan.intervalMinutes" aria-label="备份间隔" :min="60" :max="10080" :step="60" :precision="0" :disabled="store.backupPlanPending || !store.backupPlanStatus" /></el-form-item>
        <el-button :loading="store.backupPlanPending" :disabled="pending || !store.backupPlanStatus" data-testid="backup-plan-save" @click="savePlan">保存计划</el-button>
      </el-form>
      <p class="maintenance-note">{{ store.backupPlanStatus?.nextRunAt ? `下次执行：${formatDateTime(store.backupPlanStatus.nextRunAt)}` : '计划未启用。' }} 仅在后端运行期间执行；停机错过的周期启动后补执行一次，不自动删除旧备份。以下展示最近 20 次，完整执行记录保留。</p>
      <el-table :data="store.backupPlanStatus?.executions ?? []" empty-text="暂无执行记录" data-testid="backup-executions">
        <el-table-column label="开始时间" min-width="170"><template #default="{ row }">{{ formatDateTime(row.startedAt) }}</template></el-table-column>
        <el-table-column label="结果" width="90"><template #default="{ row }">{{ row.result === 'SUCCESS' ? '成功' : '失败' }}</template></el-table-column>
        <el-table-column prop="backupId" label="备份编号" min-width="190" />
        <el-table-column prop="message" label="执行说明" min-width="220" />
      </el-table>
    </section>
  </section>
</template>

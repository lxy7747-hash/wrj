<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { APP_CONFIG } from '../../config/app.config'
import { useAdminStore } from '../../stores/admin'
import { useAuthStore } from '../../stores/auth'
import { formatDateTime } from '../../features/shared/date-time'
import type { BackupRecord } from '../../contracts/domain-models'

const store = useAdminStore()
const auth = useAuthStore()
const router = useRouter()
const backupName = ref('手动备份')
const searchKeyword = ref('')
const onlyRestorable = ref(false)

const feedback = computed(() => store.maintenance.backup)
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(feedback.value.state))
const restore = computed(() => store.restoreResult)
const sortedBackups = computed(() => [...store.backups].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.backupId.localeCompare(b.backupId)))
const restorableCount = computed(() => sortedBackups.value.filter(isRestorable).length)
const filteredBackups = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()
  return sortedBackups.value.filter(backup => {
    if (onlyRestorable.value && !isRestorable(backup)) return false
    if (!keyword) return true
    return (backup.name || '历史备份').toLowerCase().includes(keyword)
      || backup.backupId.toLowerCase().includes(keyword)
  })
})
function isRestorable(backup: BackupRecord): boolean { return backup.status !== 'INVALID' && backup.format !== 'MAIN_SQLITE_V1' }
function backupScopeLabel(backup: BackupRecord): string {
  if (backup.status.endsWith('_FIXTURE')) return 'Mock 演示'
  if (backup.format === 'SYSTEM_SQLITE_V2') return '四库备份'
  if (backup.format === 'SYSTEM_SQLITE_V1') return '历史六库备份'
  return '旧主库备份'
}
const backupScopeSummary = '场景、模板、账号、角色权限、历史归档和运行配置'

function reload(): void { void store.loadMaintenance('backup') }

async function removeBackup(backup: BackupRecord): Promise<void> {
  if (pending.value) return
  const epoch = store.maintenanceEpoch
  try {
    await ElMessageBox.confirm(
      `确认删除备份“${backup.name || '历史备份'}”（${backup.backupId}）？删除后磁盘快照文件将一并清理，无法恢复。`,
      '删除备份',
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' },
    )
    if (epoch !== store.maintenanceEpoch) return
    const deleted = await store.deleteBackup(backup.backupId)
    if (epoch !== store.maintenanceEpoch || !deleted) return
    ElMessage.success('备份记录已删除。')
  } catch { /* 取消删除 */ }
}

/** 确认备份或恢复；取消或离开当前页面后不执行请求。 */
async function execute(backup?: BackupRecord): Promise<void> {
  if (pending.value || (backup && !isRestorable(backup))) return
  const targetId = backup?.backupId ?? ''
  const name = backupName.value
  if (!backup && (!name.trim() || name.length > 80)) { ElMessage.error('请输入 1～80 字的备份名称。'); return }
  const epoch = store.maintenanceEpoch
  const masterDataClause = APP_CONFIG.systemManagement.showMasterData ? '装备和通用基础数据保留现状；' : ''
  const backupMasterDataClause = APP_CONFIG.systemManagement.showMasterData ? '\n装备和通用基础数据保留在原库。' : ''
  const message = backup ? [
    `备份名称：${backup.name || '历史备份'}`,
    `创建时间：${formatDateTime(backup.createdAt)}`,
    `恢复范围：${backupScopeSummary}`,
    '',
    `• ${masterDataClause}审计与文件读取记录保留；`,
    '• 账号及密码将恢复到备份时的状态，之后新增的账号可能消失，请确认掌握备份中的管理员账号和密码；',
    '• 系统将先自动创建恢复前备份，校验失败不执行恢复，写入失败整体回滚；成功后需重新登录。',
  ].join('\n') : [
    `备份名称：${name}`,
    `备份范围：${backupScopeSummary}${backupMasterDataClause}`,
    '',
    '备份文件含账号验证信息，未加密，请妥善保管。',
  ].join('\n')
  try {
    await ElMessageBox.confirm(message, backup ? '恢复备份' : '创建备份', {
      confirmButtonText: '确认执行',
      cancelButtonText: '取消',
      type: 'warning',
      customClass: 'br-confirmation',
    })
    if (epoch !== store.maintenanceEpoch || pending.value) return
    if (backup && !store.backups.some(row => row.backupId === targetId && isRestorable(row))) return
    const succeeded = await store.runMaintenanceAction(backup ? 'RESTORE' : 'BACKUP', targetId, backup ? undefined : name)
    if (epoch !== store.maintenanceEpoch || !succeeded) return
    ElMessage.success(feedback.value.message)
    if (backup && restore.value?.generated) {
      ElMessage.info({ message: `已自动保留恢复前备份：${restore.value.prebackupId}`, duration: 8000 })
      auth.resetToSafeEmpty()
      await router.replace('/login')
    }
  } catch { /* 用户取消时保留当前记录。 */ }
}

onMounted(reload)
onBeforeUnmount(() => store.resetMaintenance())
</script>

<template>
  <section id="cap-bfhf" class="backup-page" aria-label="数据库备份与恢复" data-testid="backup-panel">
    <div class="maintenance-card br-card">
      <header class="br-header">
        <div class="br-header__title">
          <div class="br-header__row">
            <h3>数据库备份 / 恢复</h3>
            <el-tag size="small" type="info" effect="plain">共 {{ sortedBackups.length }} 条</el-tag>
            <el-tag size="small" type="success" effect="plain">可恢复 {{ restorableCount }} 条</el-tag>
          </div>
          <p class="maintenance-note">
            新备份包含{{ backupScopeSummary }}。操作审计记录始终保留。
          </p>
        </div>
        <div class="br-header__actions">
          <el-input
            v-model="backupName"
            aria-label="备份名称"
            placeholder="输入备份名称，如：发布前快照"
            maxlength="80"
            class="br-name-input"
            :disabled="pending"
          >
            <template #prepend>备份名称</template>
          </el-input>
          <el-button :disabled="pending" @click="reload">刷新记录</el-button>
          <el-button type="primary" :loading="pending" :disabled="pending" data-testid="backup-create" @click="execute()">创建备份</el-button>
        </div>
      </header>

      <el-alert v-if="feedback.state === 'ERROR' && feedback.message" :title="feedback.message" type="error" :closable="false" show-icon data-testid="backup-feedback" />

      <div class="br-filter-bar">
        <el-input
          v-model="searchKeyword"
          clearable
          size="small"
          placeholder="搜索备份名称或编号"
          aria-label="搜索备份"
          class="br-search-input"
        />
        <el-checkbox v-model="onlyRestorable" data-testid="filter-restorable">仅显示可恢复备份</el-checkbox>
      </div>

      <el-table
        v-loading="pending"
        element-loading-text="正在加载数据。"
        :data="filteredBackups"
        row-key="backupId"
        stripe
        border
        size="small"
        empty-text="暂无备份记录"
        data-testid="backup-table"
      >
        <el-table-column prop="backupId" label="备份编号" min-width="180" show-overflow-tooltip>
          <template #default="{ row }"><code class="br-mono">{{ row.backupId }}</code></template>
        </el-table-column>
        <el-table-column prop="name" label="备份名称" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.name || '历史备份' }}</template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="168">
          <template #default="{ row }"><span class="br-time">{{ formatDateTime(row.createdAt) }}</span></template>
        </el-table-column>
        <el-table-column label="完整性" width="100" align="center">
          <template #default="{ row }">
            <el-tooltip
              :disabled="row.status === 'VALID' || row.status === 'VALID_FIXTURE'"
              content="文件缺失、损坏或 SHA-256 校验和不匹配，不可用于恢复"
              placement="top"
            >
              <el-tag size="small" :type="row.status === 'VALID' || row.status === 'VALID_FIXTURE' ? 'success' : 'danger'">
                {{ row.status === 'VALID' || row.status === 'VALID_FIXTURE' ? '校验通过' : '校验失败' }}
              </el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="范围" width="116">
          <template #default="{ row }">{{ backupScopeLabel(row) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="144" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              :disabled="pending || !isRestorable(row)"
              @click="execute(row)"
            >恢复</el-button>
            <el-button
              link
              type="danger"
              :disabled="pending"
              :data-testid="`delete-backup-${row.backupId}`"
              @click="removeBackup(row)"
            >删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="restore" class="maintenance-result" data-testid="restore-result">
        <el-steps :active="restore.result === 'SUCCESS' ? 3 : restore.integrityValid ? 2 : 1" :process-status="restore.result === 'FAILURE' ? 'error' : 'success'" finish-status="success" simple>
          <el-step title="恢复前备份" /><el-step title="完整性校验" /><el-step :title="restore.rolledBack ? '失败回滚' : '受控恢复'" />
        </el-steps>
        <el-progress :percentage="restore.progress" :status="restore.result === 'SUCCESS' ? 'success' : 'exception'" />
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="恢复前备份"><code class="br-mono">{{ restore.prebackupId }}</code></el-descriptions-item>
          <el-descriptions-item label="完整性校验">{{ restore.integrityValid ? '通过' : '失败，恢复未开始' }}</el-descriptions-item>
          <el-descriptions-item label="结果">{{ restore.result === 'SUCCESS' ? '成功' : '失败' }}</el-descriptions-item>
          <el-descriptions-item label="回滚">{{ restore.rolledBack ? '已回滚' : '无需回滚' }}</el-descriptions-item>
        </el-descriptions>
      </div>
    </div>
  </section>
</template>

<style scoped>
.backup-page {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.br-card {
  background: var(--el-fill-color-blank);
}

.br-header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  align-items: flex-start;
  justify-content: space-between;
}

.br-header__title {
  display: grid;
  gap: 6px;
  min-width: 0;
  flex: 1 1 320px;
}

.br-header__row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.br-header__row h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.br-header__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.br-header__actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.br-name-input {
  width: 280px;
}

.br-filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.br-search-input {
  width: 240px;
}

.br-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.br-time {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

:global(.br-confirmation .el-message-box__message p) {
  white-space: pre-line;
}
</style>

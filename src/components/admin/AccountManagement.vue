<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import type { Role, User } from '../../contracts/domain-models'
import { useAdminStore } from '../../stores/admin'
import { useAuthStore } from '../../stores/auth'
import RoleProfiles from './RoleProfiles.vue'

const admin = useAdminStore()
const showRoleProfiles = ref(false)
const auth = useAuthStore()
onMounted(() => { void admin.refreshUsers() })
const { users, panelState, resultCode, resultMessage } = storeToRefs(admin)

/**
 * 指示用户管理面板当前是否正处于不可重复提交的处理阶段。
 * @returns 加载、校验或执行中返回 `true`，其他状态返回 `false`。
 * @remarks 只读取 Store 面板状态，不修改界面状态或发起网络请求。
 */
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(panelState.value))

/**
 * 从当前用户投影实时汇总账号指标。
 * @returns 用户总数、管理员数和启用账号数。
 * @remarks 只读取 `users`，不缓存业务数据、不修改 Store，也不发起网络请求。
 */
const userSummary = computed(() => ({
  total: users.value.length,
  administrators: users.value.filter((user) => user.role === 'ADMIN').length,
  active: users.value.filter((user) => user.status === 'ACTIVE').length,
  activeAdministrators: users.value.filter((user) => user.role === 'ADMIN' && user.status === 'ACTIVE').length,
}))

function adminProtection(user: User): string | undefined {
  if (user.role !== 'ADMIN') return undefined
  if (user.userId === auth.principal?.userId) return '当前登录管理员不能切换角色或禁用自己'
  if (userSummary.value.activeAdministrators <= 1) return '必须保留至少一个启用的管理员'
  return undefined
}

const createForm = reactive<{ username: string; role: Role; status: User['status'] }>({
  username: '',
  role: 'OPERATOR',
  status: 'ACTIVE',
})
const pendingDelete = ref<User | null>(null)
const initialPassword = ref('')
const createDialogVisible = ref(false)
const createError = ref('')

function resetCreateForm(): void {
  Object.assign(createForm, { username: '', role: 'OPERATOR', status: 'ACTIVE' })
  initialPassword.value = ''
  createError.value = ''
}
watch(createDialogVisible, (visible) => {
  if (!visible) resetCreateForm()
})
const roleLabels: Record<Role, string> = {
  OPERATOR: '操作员（OPERATOR）',
  ADMIN: '管理员（ADMIN）',
}
const statusLabels: Record<User['status'], string> = {
  ACTIVE: '启用（ACTIVE）',
  DISABLED: '禁用（DISABLED）',
  LOCKED: '锁定（LOCKED）',
}
const rolePermissions = [
  {
    role: roleLabels.OPERATOR,
    permissions: 'BUSINESS_READ、SCENARIO_DRAFT_WRITE、SIMULATION_CONTROL、ORDINARY_REPORT_EXPORT',
  },
  {
    role: roleLabels.ADMIN,
    permissions: 'OPERATOR 全部权限，以及模板、主数据、用户角色、备份恢复、审计、完整配置与三级报告权限',
  },
]

/**
 * 提交创建用户表单；成功关闭弹窗，失败保留表单并显示原因。
 * @returns 表单提交完成后兑现且不返回值的 Promise。
 * @sideEffects 调用用户管理 Store；结束后清空密码，关闭时重置表单。
 */
async function createUser(): Promise<void> {
  if (pending.value) return
  createError.value = ''
  const created = await admin.createUser(createForm.username, createForm.role, createForm.status, initialPassword.value)
  initialPassword.value = ''
  if (created) {
    createDialogVisible.value = false
    ElMessage.success(resultMessage.value)
  }
  else createError.value = resultMessage.value
}

async function updateUser(user: User, operation: 'UPDATE' | 'ENABLE' | 'DISABLE', next: User): Promise<void> {
  if (pending.value || (operation !== 'ENABLE' && adminProtection(user))) return
  const epoch = admin.requestEpoch
  const updated = await admin.mutateUser(user, operation, next)
  if (epoch !== admin.requestEpoch) return
  if (!updated) {
    ElMessage.error(resultMessage.value)
    return
  }
  ElMessage.success(operation === 'UPDATE'
    ? `用户 ${user.username} 已切换为${roleLabels[next.role]}。`
    : resultMessage.value)
}

/**
 * 打开指定用户的删除确认区域。
 * @param user 待删除的用户。
 * @returns 无返回值。
 * @sideEffects 将 `pendingDelete` 更新为指定用户。
 */
function requestDelete(user: User): void {
  if (pending.value || user.userId === auth.principal?.userId) return
  pendingDelete.value = user
}

/**
 * 取消当前删除请求并关闭确认区域。
 * @returns 无返回值。
 * @sideEffects 将 `pendingDelete` 重置为空。
 */
function cancelDelete(): void {
  pendingDelete.value = null
}

/**
 * 提交当前待确认用户的删除请求。
 * @returns 删除请求结束后兑现且不返回值的 Promise；没有待确认用户时立即兑现。
 * @sideEffects 调用用户管理 Store 更新列表与结果状态，并关闭删除确认区域。
 */
async function confirmDelete(): Promise<void> {
  const user = pendingDelete.value
  if (user === null || pending.value || user.userId === auth.principal?.userId) return
  const deleted = await admin.mutateUser(user, 'DELETE', user)
  if (deleted) ElMessage.success(resultMessage.value)
  pendingDelete.value = null
}
</script>

<template>
  <div class="account-management">
    <el-dialog
      v-model="createDialogVisible"
      title="创建用户"
      width="min(480px, calc(100vw - 32px))"
      :show-close="!pending"
      :close-on-click-modal="!pending"
      :close-on-press-escape="!pending"
    >
      <el-form class="create-form" label-position="top" :model="createForm" :disabled="pending" @submit.prevent="createUser">
        <el-form-item label="用户名">
          <el-input v-model="createForm.username" data-testid="create-username" autocomplete="off" />
        </el-form-item>
        <el-form-item label="初始密码">
          <el-input v-model="initialPassword" type="password" show-password autocomplete="new-password" placeholder="6–32 位" :minlength="6" :maxlength="32" data-testid="create-password" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="createForm.role" data-testid="create-role">
            <el-option :label="roleLabels.OPERATOR" value="OPERATOR" />
            <el-option :label="roleLabels.ADMIN" value="ADMIN" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="createForm.status" data-testid="create-status">
            <el-option :label="statusLabels.ACTIVE" value="ACTIVE" />
            <el-option :label="statusLabels.DISABLED" value="DISABLED" />
            <el-option :label="statusLabels.LOCKED" value="LOCKED" />
          </el-select>
        </el-form-item>
        <el-alert v-if="createError" type="error" :title="createError" :closable="false" data-testid="create-user-error" />
        <div class="create-actions">
          <el-button :disabled="pending" data-testid="cancel-create-user" @click="createDialogVisible = false">取消</el-button>
          <el-button native-type="submit" type="primary" :loading="pending" data-testid="create-user">
            创建用户
          </el-button>
        </div>
      </el-form>
    </el-dialog>

    <section class="console-panel console-section" aria-labelledby="user-list-title">
      <div class="section-heading section-heading--toolbar">
        <div>
          <p class="section-kicker">账号目录</p>
          <h3 id="user-list-title">用户列表</h3>
        </div>
        <div class="section-heading__actions">
          <div class="summary-strip" aria-label="用户摘要">
            <span class="console-chip"><b>{{ userSummary.total }}</b> 用户总数</span>
            <span class="console-chip"><b>{{ userSummary.administrators }}</b> 管理员</span>
            <span class="console-chip summary-chip--active"><b>{{ userSummary.active }}</b> 已启用</span>
          </div>
          <div class="panel-toolbar">
            <el-button @click="showRoleProfiles = true">角色权限配置</el-button>
            <el-button type="primary" :disabled="pending" data-testid="open-create-user" @click="createDialogVisible = true">创建用户</el-button>
          </div>
        </div>
      </div>

      <div class="console-table-frame table-scroll" tabindex="0" aria-label="用户列表，可横向滚动">
        <el-table class="admin-table" :data="users" row-key="userId" data-testid="user-role-panel">
          <el-table-column prop="username" label="用户" min-width="120" />
          <el-table-column label="角色" min-width="180">
            <template #default="scope">{{ roleLabels[scope.row.role as Role] }}</template>
          </el-table-column>
          <el-table-column label="状态" min-width="180">
            <template #default="scope">{{ statusLabels[scope.row.status as User['status']] }}</template>
          </el-table-column>
          <el-table-column label="操作" min-width="330">
            <template #default="scope">
              <el-button
                size="small"
                :disabled="pending || !!adminProtection(scope.row)"
                :title="adminProtection(scope.row)"
                @click="updateUser(scope.row, 'UPDATE', { ...scope.row, role: scope.row.role === 'ADMIN' ? 'OPERATOR' : 'ADMIN' })"
              >
                切换角色
              </el-button>
              <el-button
                v-if="scope.row.status === 'DISABLED'"
                size="small"
                :disabled="pending"
                @click="updateUser(scope.row, 'ENABLE', { ...scope.row, status: 'ACTIVE' })"
              >
                启用
              </el-button>
              <el-button
                v-else
                size="small"
                :disabled="pending || !!adminProtection(scope.row)"
                :title="adminProtection(scope.row)"
                @click="updateUser(scope.row, 'DISABLE', { ...scope.row, status: 'DISABLED' })"
              >
                禁用
              </el-button>
              <el-button
                size="small"
                type="danger"
                plain
                :disabled="pending || scope.row.userId === auth.principal?.userId"
                :title="scope.row.userId === auth.principal?.userId ? '当前登录账号不能删除自己' : undefined"
                @click="requestDelete(scope.row)"
              >
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <el-dialog
      v-if="pendingDelete"
      :model-value="true"
      title="确认删除用户"
      width="min(420px, calc(100vw - 32px))"
      :show-close="!pending"
      :close-on-click-modal="!pending"
      :close-on-press-escape="!pending"
      aria-describedby="delete-confirmation-description"
      data-testid="delete-confirmation"
      @update:model-value="(visible: boolean) => { if (!visible) cancelDelete() }"
    >
      <p id="delete-confirmation-description">
        确定删除用户“{{ pendingDelete.username }}”吗？删除后该账号将无法登录。
      </p>
      <template #footer>
        <el-button data-testid="cancel-delete" :disabled="pending" @click="cancelDelete">取消</el-button>
        <el-button
          data-testid="confirm-delete"
          type="danger"
          :loading="pending"
          @click="confirmDelete"
        >
          确认删除
        </el-button>
      </template>
    </el-dialog>

    <section class="console-panel console-section" aria-labelledby="permission-map-title">
      <div class="section-heading">
        <div>
          <p class="section-kicker">RBAC 基线</p>
          <h3 id="permission-map-title">角色与权限映射</h3>
        </div>
        <span class="section-note">权限范围由当前角色合同定义</span>
      </div>
      <div class="console-table-frame table-scroll" tabindex="0" aria-label="角色权限映射，可横向滚动">
        <el-table class="permission-table" :data="rolePermissions" data-testid="role-permission-map">
          <el-table-column prop="role" label="角色" width="180" />
          <el-table-column prop="permissions" label="可见权限映射" min-width="560" />
        </el-table>
      </div>
    </section>

    <el-dialog
      v-model="showRoleProfiles"
      title="角色权限配置"
      width="min(1100px, calc(100vw - 32px))"
      :close-on-click-modal="false"
      destroy-on-close
    >
      <RoleProfiles v-if="showRoleProfiles" :users="users" />
      <template #footer>
        <el-button @click="showRoleProfiles = false">关闭</el-button>
      </template>
    </el-dialog>
    <section v-if="panelState === 'ERROR'" class="result-section" aria-label="操作结果">
      <div class="result-section__label">最近操作结果</div>
      <el-alert
        class="panel-result"
        :closable="false"
        :type="panelState === 'ERROR' ? 'error' : 'info'"
        :title="`结果代码：${resultCode}`"
        :description="resultMessage"
      />
    </section>
  </div>
</template>

<style scoped>
.account-management {
  display: grid;
  min-width: 0;
  gap: var(--space-3, 0.75rem);
}

.summary-strip {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-start;
  align-items: center;
  gap: var(--space-2, 0.5rem);
}

.summary-strip .console-chip {
  min-height: 1.75rem;
  padding: 0 var(--space-2, 0.5rem);
  color: var(--console-text-muted);
  font-weight: 500;
  font-size: var(--console-font-size-min, 12px);
  letter-spacing: 0.02em;
}

.summary-strip b {
  color: var(--console-cyan);
  font-family: Consolas, "SFMono-Regular", monospace;
  font-size: 0.875rem;
}

.summary-strip .summary-chip--active {
  border-color: color-mix(in srgb, var(--console-teal) 55%, var(--console-border));
}

.summary-chip--active b {
  color: var(--console-teal);
}

.console-section {
  min-width: 0;
  padding: var(--space-4, 1rem);
  box-shadow: none;
}

.section-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4, 1rem);
  margin-bottom: var(--space-3, 0.75rem);
}

.section-heading--toolbar {
  flex-wrap: wrap;
  gap: var(--space-3, 0.75rem);
}

.section-heading__actions {
  display: flex;
  align-items: center;
  gap: var(--space-3, 0.75rem);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.section-heading h3 {
  margin: 0.15rem 0 0;
  color: var(--console-text);
  font-size: 1rem;
}

.section-kicker {
  margin: 0;
  color: var(--console-cyan);
  font-size: var(--console-font-size-min);
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.section-note {
  color: var(--console-text-dim);
  font-size: var(--console-font-size-min);
  text-align: right;
}

.panel-toolbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2, 0.5rem);
}

.create-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: end;
  gap: var(--space-3, 0.75rem);
}

.create-form :deep(.el-form-item) {
  display: grid;
  min-width: 0;
  margin: 0;
}

.create-form :deep(.el-form-item__label) {
  height: auto;
  justify-content: flex-start;
  padding: 0 0 var(--space-2, 0.5rem);
  color: var(--console-text-muted);
  font-size: 0.75rem;
  line-height: 1.2;
}

.create-form :deep(.el-form-item__content),
.create-form :deep(.el-select) {
  min-width: 0;
  width: 100%;
}

.create-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2, 0.5rem);
}

.table-scroll {
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-color: var(--console-border-strong) var(--console-bg-elevated);
}

.admin-table {
  min-width: 50.5rem;
}

.permission-table {
  min-width: 46rem;
}

.result-section {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: stretch;
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  overflow: hidden;
  background: var(--console-bg-elevated);
}

.result-section__label {
  display: grid;
  padding: var(--space-3, 0.75rem) var(--space-4, 1rem);
  place-items: center;
  border-right: 1px solid var(--console-border);
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
  font-weight: 700;
  letter-spacing: 0.08em;
}

.panel-result {
  min-width: 0;
  border: 0;
  border-radius: 0;
}

@media (max-width: 560px) {
  .account-management {
    gap: var(--space-2, 0.5rem);
  }

  .summary-strip {
    display: grid;
    width: 100%;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .summary-strip .console-chip {
    min-width: 0;
    justify-content: center;
    padding: 0 var(--space-1, 0.25rem);
    font-size: var(--console-font-size-min);
  }

  .console-section {
    padding: var(--space-3, 0.75rem);
  }

  .section-heading,
  .section-heading--toolbar {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }

  .section-heading__actions {
    width: 100%;
    justify-content: space-between;
    gap: var(--space-2, 0.5rem);
  }

  .section-note {
    text-align: left;
  }

  .panel-toolbar {
    width: 100%;
    justify-content: flex-end;
  }

  .result-section {
    grid-template-columns: minmax(0, 1fr);
  }

  .result-section__label {
    justify-content: start;
    border-right: 0;
    border-bottom: 1px solid var(--console-border);
  }
}
</style>

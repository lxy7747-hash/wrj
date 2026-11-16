<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import type { AccessControlConfig, Role, User } from '../../contracts/domain-models'
import { useAdminStore } from '../../stores/admin'
import { resolveMockOrigin, useAuthStore } from '../../stores/auth'
import { apiFetch } from '../../features/shared/api-fetch'
import { isAccessControlConfig } from '../../features/admin/access-control'
import RoleProfiles from './RoleProfiles.vue'

const admin = useAdminStore()
const showRoleProfiles = ref(false)
const auth = useAuthStore()
onMounted(() => { void admin.refreshUsers(); void refreshRoleConfig() })
const { users, panelState, resultCode, resultMessage } = storeToRefs(admin)
const roleConfig = ref<AccessControlConfig | null>(null)
const roleError = ref('')
let roleEpoch = 0
let roleController: AbortController | undefined
async function refreshRoleConfig(): Promise<void> {
  const current = ++roleEpoch
  roleController?.abort()
  const controller = new AbortController()
  roleController = controller
  const timer = setTimeout(() => controller.abort(), 10_000)
  roleConfig.value = null
  roleError.value = ''
  try {
    const response = await apiFetch(`${resolveMockOrigin()}/api/v1/admin/access-control`, { signal: controller.signal, headers: { 'X-Demo-Role': auth.role } })
    const body = await response.json()
    if (current !== roleEpoch) return
    if (!response.ok || body.ok !== true || !isAccessControlConfig(body.data, 'read')) throw new Error('自定义角色读取失败，请重试。')
    roleConfig.value = body.data
    if (filters.profileId && !roleConfig.value!.profiles.some(profile => profile.profileId === filters.profileId)) filters.profileId = ''
  } catch { if (current === roleEpoch) roleError.value = '自定义角色读取失败，请重试。' }
  finally { clearTimeout(timer) }
}
function clearRoleConfig(): void {
  roleEpoch++
  roleController?.abort()
  roleConfig.value = null
  roleError.value = ''
}
watch(() => auth.principal?.userId, clearRoleConfig, { flush: 'sync' })
onBeforeUnmount(clearRoleConfig)
const profileIdFor = (user: User) => roleConfig.value?.assignments.find(item => item.userId === user.userId)?.profileId
function profileLabel(user: User): string {
  if (!roleConfig.value) return roleError.value ? '读取失败' : '加载中…'
  const profile = roleConfig.value.profiles.find(item => item.profileId === profileIdFor(user))
  if (!profile) return '未分配（使用基础权限）'
  return `${profile.name}（${profile.profileId}）${profile.baseRole !== user.role ? ' · 身份不匹配，请重新分配' : ''}`
}
const filters = reactive<{ username: string; role: Role | ''; status: User['status'] | ''; profileId: string }>({ username: '', role: '', status: '', profileId: '' })
const filteredUsers = computed(() => users.value.filter(user =>
  (user.displayName ?? user.username).toLowerCase().includes(filters.username.trim().toLowerCase())
  && (!filters.role || user.role === filters.role)
  && (!filters.profileId || profileIdFor(user) === filters.profileId)
  && (!filters.status || user.status === filters.status)))

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

const createForm = reactive<{ username: string; displayName: string; role: Role; status: User['status'] }>({
  username: '',
  displayName: '',
  role: 'OPERATOR',
  status: 'ACTIVE',
})
const pendingDelete = ref<User | null>(null)
const initialPassword = ref('')
const createDialogVisible = ref(false)
const createError = ref('')

function resetCreateForm(): void {
  Object.assign(createForm, { username: '', displayName: '', role: 'OPERATOR', status: 'ACTIVE' })
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
    permissions: 'OPERATOR 全部权限，以及模板、通用数据、用户角色、备份恢复、审计、完整配置与三级报告权限',
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
  const created = await admin.createUser(createForm.username, createForm.role, createForm.status, initialPassword.value, createForm.displayName)
  initialPassword.value = ''
  if (created) {
    void refreshRoleConfig()
    createDialogVisible.value = false
    ElMessage.success(resultMessage.value)
  }
  else createError.value = resultMessage.value
}

const editingUser = ref<User | null>(null)
const editForm = reactive<{ username: string; displayName: string; role: Role; status: User['status'] }>({ username: '', displayName: '', role: 'OPERATOR', status: 'ACTIVE' })
const editError = ref('')
/** 当前登录管理员或最后一个启用管理员只允许修改用户名和登录账号，角色和状态保持锁定。 */
const editProtection = computed(() => editingUser.value ? adminProtection(editingUser.value) : undefined)
// 合并启用入口后，仍允许恢复其他已禁用管理员，不开放降权或锁定。
const restoreOnly = computed(() => !!editProtection.value && editingUser.value?.status === 'DISABLED'
  && editingUser.value.userId !== auth.principal?.userId)

function openEdit(user: User): void {
  if (pending.value) return
  editingUser.value = user
  Object.assign(editForm, { username: user.username, displayName: user.displayName ?? user.username, role: user.role, status: user.status })
  editError.value = ''
}

/**
 * 提交用户修改表单；成功关闭弹窗，失败保留表单并显示原因。
 * @returns 提交结束后兑现且不返回值的 Promise。
 * @sideEffects 调用用户管理 Store 的 UPDATE 操作；服务端同时撤销该用户现有会话，重新登录后权限按新角色生效。
 */
async function submitEdit(): Promise<void> {
  const user = editingUser.value
  if (user === null || pending.value) return
  editError.value = ''
  const next: User = { ...user, username: editForm.username, displayName: editForm.displayName, role: editForm.role, status: editForm.status }
  if (next.displayName === (user.displayName ?? user.username) && next.username === user.username && next.role === user.role && next.status === user.status) {
    editingUser.value = null
    return
  }
  const updated = await admin.mutateUser(user, 'UPDATE', next)
  if (updated) {
    void refreshRoleConfig()
    editingUser.value = null
    ElMessage.success(resultMessage.value)
  }
  else editError.value = resultMessage.value
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
  if (deleted) { void refreshRoleConfig(); ElMessage.success(resultMessage.value) }
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
          <el-input v-model="createForm.displayName" data-testid="create-display-name" maxlength="64" autocomplete="off" />
        </el-form-item>
        <el-form-item label="登录账号">
          <el-input v-model="createForm.username" data-testid="create-username" maxlength="64" autocomplete="off" />
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

      <el-form inline class="user-filters" aria-label="账号筛选" @submit.prevent>
        <el-form-item label="用户名"><el-input v-model="filters.username" clearable aria-label="筛选用户名" /></el-form-item>
        <el-form-item label="角色"><el-select v-model="filters.role" aria-label="筛选角色"><el-option label="全部角色" value="" /><el-option v-for="(label, role) in roleLabels" :key="role" :label="label" :value="role" /></el-select></el-form-item>
        <el-form-item label="状态"><el-select v-model="filters.status" aria-label="筛选状态"><el-option label="全部状态" value="" /><el-option v-for="(label, status) in statusLabels" :key="status" :label="label" :value="status" /></el-select></el-form-item>
        <el-form-item label="自定义角色"><el-select v-model="filters.profileId" aria-label="筛选自定义角色" :disabled="!roleConfig"><el-option label="全部自定义角色" value="" /><el-option v-for="profile in roleConfig?.profiles ?? []" :key="profile.profileId" :label="`${profile.name}（${profile.profileId}）`" :value="profile.profileId" /></el-select></el-form-item>
        <el-form-item><el-button @click="Object.assign(filters, { username: '', role: '', status: '', profileId: '' })">重置筛选</el-button></el-form-item>
      </el-form>
      <p v-if="roleError" role="alert">{{ roleError }} <el-button link type="primary" @click="refreshRoleConfig">重试角色读取</el-button></p>
      <p>切换基础角色会解除该账号的自定义角色绑定；修改用户名、登录账号或启用、禁用不影响绑定。</p>
      <div class="console-table-frame table-scroll" tabindex="0" aria-label="用户列表，可横向滚动">
        <el-table class="admin-table" :data="filteredUsers" row-key="userId" empty-text="暂无匹配账号" data-testid="user-role-panel">
          <el-table-column label="用户名" min-width="120"><template #default="{ row }">{{ row.displayName ?? row.username }}</template></el-table-column>
          <el-table-column prop="username" label="登录账号" min-width="120" />
          <el-table-column label="角色" min-width="180">
            <template #default="scope">{{ roleLabels[scope.row.role as Role] }}</template>
          </el-table-column>
          <el-table-column label="状态" min-width="180">
            <template #default="scope">{{ statusLabels[scope.row.status as User['status']] }}</template>
          </el-table-column>
          <el-table-column label="自定义角色" min-width="240">
            <template #default="scope">{{ profileLabel(scope.row) }}</template>
          </el-table-column>
          <el-table-column label="操作" min-width="180">
            <template #default="scope">
              <el-button
                size="small"
                type="primary"
                plain
                :disabled="pending"
                :data-testid="`edit-user-${scope.row.userId}`"
                @click="openEdit(scope.row)"
              >
                修改
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
      :model-value="editingUser !== null"
      title="修改用户"
      width="min(480px, calc(100vw - 32px))"
      :show-close="!pending"
      :close-on-click-modal="!pending"
      :close-on-press-escape="!pending"
      data-testid="edit-user-dialog"
      @update:model-value="(visible: boolean) => { if (!visible) editingUser = null }"
    >
      <el-form class="create-form" label-position="top" :model="editForm" :disabled="pending" @submit.prevent="submitEdit">
        <el-form-item label="用户名">
          <el-input v-model="editForm.displayName" data-testid="edit-display-name" maxlength="64" autocomplete="off" />
        </el-form-item>
        <el-form-item label="登录账号">
          <el-input v-model="editForm.username" data-testid="edit-username" maxlength="64" autocomplete="off" />
        </el-form-item>
        <el-form-item label="基础角色">
          <el-select v-model="editForm.role" :disabled="!!editProtection" data-testid="edit-role">
            <el-option :label="roleLabels.OPERATOR" value="OPERATOR" />
            <el-option :label="roleLabels.ADMIN" value="ADMIN" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="editForm.status" :disabled="!!editProtection && !restoreOnly" data-testid="edit-status">
            <el-option :label="statusLabels.ACTIVE" value="ACTIVE" />
            <el-option :label="statusLabels.DISABLED" value="DISABLED" :disabled="restoreOnly" />
            <el-option :label="statusLabels.LOCKED" value="LOCKED" :disabled="restoreOnly" />
          </el-select>
        </el-form-item>
        <p v-if="editProtection" class="section-note edit-note">{{ editProtection }}，{{ restoreOnly ? '基础角色不可修改，状态仅可恢复为启用' : '基础角色和状态不可修改' }}。</p>
        <p class="section-note edit-note">保存后该用户现有登录会话失效，重新登录后按新角色和状态生效。</p>
        <el-alert v-if="editError" type="error" :title="editError" :closable="false" data-testid="edit-user-error" />
        <div class="create-actions">
          <el-button :disabled="pending" @click="editingUser = null">取消</el-button>
          <el-button native-type="submit" type="primary" :loading="pending" data-testid="save-user">保存</el-button>
        </div>
      </el-form>
    </el-dialog>

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
          <h3 id="permission-map-title">角色与权限映射</h3>
        </div>
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
      <RoleProfiles v-if="showRoleProfiles" :users="users" @saved="refreshRoleConfig" />
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

.edit-note {
  margin: 0;
  text-align: left;
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
.user-filters :deep(.el-select), .user-filters :deep(.el-input) { width: 200px; }

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

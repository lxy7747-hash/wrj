<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { CapabilityState, Role, User } from '../contracts/domain-models'
import { useAdminStore } from '../stores/admin'

const admin = useAdminStore()
const { users, panelState, resultCode, resultMessage } = storeToRefs(admin)

/**
 * 指示用户管理面板当前是否正处于不可重复提交的处理阶段。
 * @returns 加载、校验或执行中返回 `true`，其他状态返回 `false`。
 * @remarks 只读取 Store 面板状态，不修改 UI 状态或发起网络请求。
 */
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(panelState.value))

/**
 * 从当前用户投影实时汇总控制台顶部的账号指标。
 * @returns 用户总数、管理员数和启用账号数。
 * @remarks 只读取 `users`，不缓存业务数据、不修改 Store，也不发起网络请求。
 */
const userSummary = computed(() => ({
  total: users.value.length,
  administrators: users.value.filter((user) => user.role === 'ADMIN').length,
  active: users.value.filter((user) => user.status === 'ACTIVE').length,
}))

const createForm = reactive<{ username: string; role: Role; status: User['status'] }>({
  username: '',
  role: 'OPERATOR',
  status: 'ACTIVE',
})
const pendingDelete = ref<User | null>(null)
const roleLabels: Record<Role, string> = {
  OPERATOR: '操作员（OPERATOR）',
  ADMIN: '管理员（ADMIN）',
}
const statusLabels: Record<User['status'], string> = {
  ACTIVE: '启用（ACTIVE）',
  DISABLED: '禁用（DISABLED）',
  LOCKED: '锁定（LOCKED）',
}
const panelStateLabels: Record<CapabilityState, string> = {
  LOADING: '加载中（LOADING）',
  VALIDATING: '校验中（VALIDATING）',
  EXECUTING: '执行中（EXECUTING）',
  SUCCESS: '成功（SUCCESS）',
  EMPTY: '暂无用户（EMPTY）',
  ERROR: '失败（ERROR）',
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
 * 提交创建用户表单，并在创建成功后清空用户名输入框。
 * @returns 表单提交完成后兑现且不返回值的 Promise。
 * @sideEffects 调用用户管理 Store；成功时更新用户列表并清空 `createForm.username`。
 */
async function createUser(): Promise<void> {
  const created = await admin.createUser(createForm.username, createForm.role, createForm.status)
  if (created) createForm.username = ''
}

/**
 * 打开指定用户的删除确认区域。
 * @param user 待删除的用户。
 * @returns 无返回值。
 * @sideEffects 将 `pendingDelete` 更新为指定用户。
 */
function requestDelete(user: User): void {
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
  if (user === null) return
  await admin.mutateUser(user, 'DELETE', user)
  pendingDelete.value = null
}
</script>

<template>
  <section class="page admin-page" aria-labelledby="admin-title">
    <header class="admin-header">
      <div class="admin-header__copy">
        <p class="eyebrow">系统管理 / 访问控制</p>
        <h2 id="admin-title">用户与角色管理</h2>
        <p class="admin-header__description">管理系统用户、角色及账号状态。</p>
      </div>
      <div class="summary-strip" aria-label="用户摘要">
        <span class="console-chip"><b>{{ userSummary.total }}</b> 用户总数</span>
        <span class="console-chip"><b>{{ userSummary.administrators }}</b> 管理员</span>
        <span class="console-chip summary-chip--active"><b>{{ userSummary.active }}</b> 已启用</span>
      </div>
    </header>

    <section class="console-panel console-section" aria-labelledby="create-user-title">
      <div class="section-heading">
        <div>
          <p class="section-kicker">账号录入</p>
          <h3 id="create-user-title">创建用户</h3>
        </div>
        <span class="section-note">新账号将按所选角色与状态提交</span>
      </div>
      <el-form class="create-form" :inline="true" :model="createForm" @submit.prevent="createUser">
        <el-form-item label="用户名">
          <el-input v-model="createForm.username" data-testid="create-username" autocomplete="off" />
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
        <el-button native-type="submit" type="primary" :loading="pending" data-testid="create-user">
          创建用户
        </el-button>
      </el-form>
    </section>

    <section class="console-panel console-section" aria-labelledby="user-list-title">
      <div class="section-heading section-heading--toolbar">
        <div>
          <p class="section-kicker">账号目录</p>
          <h3 id="user-list-title">用户列表</h3>
        </div>
        <div class="panel-toolbar">
          <el-tag :type="panelState === 'ERROR' ? 'danger' : panelState === 'SUCCESS' ? 'success' : 'info'">
            {{ panelStateLabels[panelState] }}
          </el-tag>
          <el-button type="primary" :loading="pending" @click="admin.refreshUsers">刷新用户</el-button>
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
                :disabled="pending"
                @click="admin.mutateUser(scope.row, 'UPDATE', { ...scope.row, role: scope.row.role === 'ADMIN' ? 'OPERATOR' : 'ADMIN' })"
              >
                切换角色
              </el-button>
              <el-button
                v-if="scope.row.status === 'DISABLED'"
                size="small"
                :disabled="pending"
                @click="admin.mutateUser(scope.row, 'ENABLE', { ...scope.row, status: 'ACTIVE' })"
              >
                启用
              </el-button>
              <el-button
                v-else
                size="small"
                :disabled="pending"
                @click="admin.mutateUser(scope.row, 'DISABLE', { ...scope.row, status: 'DISABLED' })"
              >
                禁用
              </el-button>
              <el-button
                size="small"
                type="danger"
                plain
                :disabled="pending"
                @click="requestDelete(scope.row)"
              >
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <section
      v-if="pendingDelete"
      class="delete-confirmation"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-confirmation-title"
      aria-describedby="delete-confirmation-description"
      data-testid="delete-confirmation"
    >
      <p class="section-kicker section-kicker--danger">破坏性操作</p>
      <h3 id="delete-confirmation-title">确认删除用户</h3>
      <p id="delete-confirmation-description">
        即将删除用户 {{ pendingDelete.username }}（{{ pendingDelete.userId }}）。请确认是否继续。
      </p>
      <el-button data-testid="cancel-delete" :disabled="pending" @click="cancelDelete">取消</el-button>
      <el-button
        data-testid="confirm-delete"
        type="danger"
        :loading="pending"
        @click="confirmDelete"
      >
        确认删除
      </el-button>
    </section>

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

    <section class="result-section" aria-label="操作结果">
      <div class="result-section__label">最近操作结果</div>
      <el-alert
        class="panel-result"
        :closable="false"
        :type="panelState === 'ERROR' ? 'error' : 'info'"
        :title="`结果代码：${resultCode}`"
        :description="resultMessage"
      />
    </section>
  </section>
</template>

<style scoped>
.admin-page {
  display: grid;
  min-width: 0;
  gap: var(--space-4, 1rem);
}

.admin-header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5, 1.5rem);
  padding-bottom: var(--space-4, 1rem);
  border-bottom: 1px solid var(--console-border);
}

.admin-header__copy {
  min-width: 0;
}

.admin-header__description {
  margin: 0;
  color: var(--console-text-muted);
  font-size: 0.88rem;
}

.summary-strip {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2, 0.5rem);
}

.summary-strip .console-chip {
  min-height: 2.25rem;
  padding: 0 var(--space-3, 0.75rem);
  color: var(--console-text-muted);
  font-weight: 500;
  letter-spacing: 0.02em;
}

.summary-strip b {
  color: var(--console-cyan);
  font-family: Consolas, "SFMono-Regular", monospace;
  font-size: 1rem;
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
  margin-bottom: var(--space-4, 1rem);
}

.section-heading h3,
.delete-confirmation h3 {
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

.section-kicker--danger {
  color: var(--console-danger);
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
  grid-template-columns: minmax(10rem, 1.35fr) minmax(10rem, 1fr) minmax(10rem, 1fr) auto;
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

.create-form > :deep(.el-button) {
  min-width: 7.5rem;
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

.delete-confirmation {
  padding: var(--space-4, 1rem);
  border: 1px solid color-mix(in srgb, var(--console-danger) 68%, var(--console-border));
  border-left-width: 3px;
  border-radius: var(--console-radius);
  background: color-mix(in srgb, var(--console-danger) 8%, var(--console-bg-elevated));
}

.delete-confirmation p:not(.section-kicker) {
  margin: var(--space-2, 0.5rem) 0 var(--space-3, 0.75rem);
  color: var(--console-text-muted);
  font-size: 0.82rem;
  line-height: 1.65;
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

@media (max-width: 980px) {
  .admin-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .summary-strip {
    justify-content: flex-start;
  }

  .create-form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .admin-page {
    gap: var(--space-3, 0.75rem);
  }

  .admin-header {
    gap: var(--space-3, 0.75rem);
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

  .section-note {
    text-align: left;
  }

  .panel-toolbar {
    width: 100%;
    justify-content: space-between;
  }

  .create-form {
    grid-template-columns: minmax(0, 1fr);
  }

  .create-form > :deep(.el-button) {
    width: 100%;
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

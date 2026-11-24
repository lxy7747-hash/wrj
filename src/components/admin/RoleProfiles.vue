<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AccessControlConfig, Permission, Role, RoleProfile, User } from '../../contracts/domain-models'
import { isAccessControlConfig, isRoleProfile, MENU_LABELS, OPERATOR_PERMISSION_KEYS, PERMISSION_LABELS } from '../../features/admin/access-control'
import { apiFetch } from '../../features/shared/api-fetch'
import { resolveMockOrigin, useAuthStore } from '../../stores/auth'
import { APP_CONFIG } from '../../config/app.config'

const props = defineProps<{ users: User[] }>()
const emit = defineEmits<{ saved: [] }>()
const auth = useAuthStore()
const config = ref<AccessControlConfig | null>(null)
const savedSnapshot = ref('')
const error = ref('')
const editorError = ref('')
const pending = ref(false)
const editor = ref<RoleProfile | null>(null)
const editingId = ref<string | null>(null)
const userSearch = ref('')
let epoch = 0
let controller: AbortController | undefined

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: '管理员',
  OPERATOR: '操作员',
}
const HIDDEN_MENU_PATHS = new Set(['/blueprint', '/traceability', '/interactions'])
const MASTER_DATA_MENU_PATHS = new Set(['/admin?section=equipment-library', '/admin?section=master-data'])

const permissions = computed(() => {
  const list = editor.value?.baseRole === 'OPERATOR' ? [...OPERATOR_PERMISSION_KEYS] : Object.keys(PERMISSION_LABELS) as Permission[]
  return APP_CONFIG.systemManagement.showMasterData ? list : list.filter(key => key !== 'MASTER_DATA_MAINTAIN')
})
const visiblePermissions = (list: Permission[]) =>
  APP_CONFIG.systemManagement.showMasterData ? list : list.filter(key => key !== 'MASTER_DATA_MAINTAIN')
const visibleMenuPaths = (list: string[]) =>
  list.filter(path => !HIDDEN_MENU_PATHS.has(path) && (APP_CONFIG.systemManagement.showMasterData || !MASTER_DATA_MENU_PATHS.has(path)))

const menus = computed(() => {
  const visibility: Record<string, boolean> = {
    '/reports': APP_CONFIG.showReports,
    '/blueprint': false,
    '/traceability': false,
    '/interactions': false,
    '/admin?section=equipment-library': APP_CONFIG.systemManagement.showMasterData,
    '/admin?section=master-data': APP_CONFIG.systemManagement.showMasterData,
    '/admin?section=database-backup': APP_CONFIG.systemManagement.showDatabaseBackup,
    '/admin?section=simulation-data': APP_CONFIG.systemManagement.showSimulationData,
    '/admin?section=runtime-status': APP_CONFIG.systemManagement.showRuntimeStatus,
    '/admin/data-exchange': APP_CONFIG.systemManagement.showDataExchange,
  }
  return Object.entries(MENU_LABELS).filter(([path]) => visibility[path] !== false
    && (editor.value?.baseRole === 'ADMIN' || !path.startsWith('/admin') || path === '/admin/data-exchange' || path === '/admin?section=scenario-templates'))
})

const ownProfileId = computed(() => config.value?.assignments.find(row => row.userId === auth.principal?.userId)?.profileId)

const hasUnsavedChanges = computed(() => {
  if (!config.value || !savedSnapshot.value) return false
  return JSON.stringify(config.value) !== savedSnapshot.value
})

const filteredUsers = computed(() => {
  const keyword = userSearch.value.trim().toLowerCase()
  if (!keyword) return props.users
  return props.users.filter(user =>
    (user.displayName ?? user.username).toLowerCase().includes(keyword)
    || user.username.toLowerCase().includes(keyword))
})

const assignedCountByProfile = computed(() => {
  const counts = new Map<string, number>()
  for (const row of config.value?.assignments ?? []) {
    counts.set(row.profileId, (counts.get(row.profileId) ?? 0) + 1)
  }
  return counts
})

const totalAssignedUsers = computed(() => config.value?.assignments.length ?? 0)

function isRequiredPermission(permission: Permission): boolean {
  if (!editor.value) return false
  return permission === 'BUSINESS_READ' || (editor.value.baseRole === 'ADMIN' && permission === 'USER_ROLE_MAINTAIN')
}

function isRequiredMenu(path: string): boolean {
  return editor.value?.baseRole === 'ADMIN' && path === '/admin'
}

function profilesForRole(role: Role): RoleProfile[] {
  return config.value?.profiles.filter(item => item.baseRole === role) ?? []
}

function generateProfileId(): void {
  if (!editor.value || editingId.value !== null) return
  const prefix = editor.value.baseRole === 'ADMIN' ? 'ADMIN_ROLE' : 'OP_ROLE'
  const existing = new Set((config.value?.profiles ?? []).map(item => item.profileId))
  let index = 1
  while (existing.has(`${prefix}_${index}`)) index++
  editor.value.profileId = `${prefix}_${index}`
  editorError.value = ''
}

function selectAllPermissions(): void {
  if (!editor.value) return
  const preservedHidden = editor.value.permissions.filter(item => !permissions.value.includes(item))
  editor.value.permissions = [...new Set([...preservedHidden, ...permissions.value])]
}

function resetMinimalPermissions(): void {
  if (!editor.value) return
  const preservedHidden = editor.value.permissions.filter(item => !permissions.value.includes(item))
  const minimal: Permission[] = editor.value.baseRole === 'ADMIN'
    ? ['BUSINESS_READ', 'USER_ROLE_MAINTAIN']
    : ['BUSINESS_READ']
  editor.value.permissions = [...new Set([...preservedHidden, ...minimal])]
}

function selectAllMenus(): void {
  if (!editor.value) return
  const visiblePaths = menus.value.map(([path]) => path)
  const preservedHidden = editor.value.menuPaths.filter(path => !visiblePaths.includes(path))
  editor.value.menuPaths = [...new Set([...preservedHidden, ...visiblePaths])]
}

function resetMinimalMenus(): void {
  if (!editor.value) return
  const visiblePaths = menus.value.map(([path]) => path)
  const preservedHidden = editor.value.menuPaths.filter(path => !visiblePaths.includes(path))
  const minimal = editor.value.baseRole === 'ADMIN' ? ['/situation', '/admin'] : ['/situation']
  editor.value.menuPaths = [...new Set([...preservedHidden, ...minimal])]
}

async function request(save = false): Promise<void> {
  if (pending.value || (save && !config.value)) return
  if (save && !isAccessControlConfig(config.value)) { error.value = '请为每个角色至少保留一个当前可用菜单后再保存。'; return }
  const current = ++epoch
  controller?.abort()
  const abort = new AbortController()
  controller = abort
  const timer = setTimeout(() => abort.abort(), 10_000)
  const payload = save ? JSON.stringify(config.value) : undefined
  pending.value = true
  error.value = ''
  try {
    const response = await apiFetch(`${resolveMockOrigin()}/api/v1/admin/access-control`, {
      signal: abort.signal, headers: { 'X-Demo-Role': auth.role, 'Content-Type': 'application/json' },
      ...(save ? { method: 'PUT', body: payload } : {}),
    })
    const body = await response.json()
    if (current !== epoch) return
    if (!response.ok || body.ok !== true) throw new Error(body.error?.message ?? '角色配置请求失败。')
    if (!isAccessControlConfig(body.data, save ? 'write' : 'read')) throw new Error('角色配置响应不正确。')
    config.value = body.data
    savedSnapshot.value = JSON.stringify(body.data)
    if (save) { emit('saved'); ElMessage.success('角色配置已保存，受影响账号需重新登录。') }
  } catch (reason) { if (current === epoch) { if (!save) { config.value = null; savedSnapshot.value = '' } error.value = reason instanceof Error ? reason.message : '角色配置请求失败。' } }
  finally { clearTimeout(timer); if (current === epoch) pending.value = false }
}

function edit(profile?: RoleProfile): void {
  editingId.value = profile?.profileId ?? null
  editorError.value = ''
  editor.value = profile ? structuredClone(toRaw(profile)) : { profileId: '', name: '', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: ['/situation'] }
}

function closeEditor(): void {
  editor.value = null
  editorError.value = ''
}

function validateEditor(draft: RoleProfile): string | null {
  const id = draft.profileId.trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return '角色编号须为 1–64 位，仅支持字母、数字、下划线和短横线。'
  }
  if (config.value?.profiles.some(row => row.profileId === id && row.profileId !== editingId.value)) {
    return `角色编号“${id}”已存在，请更换其他编号。`
  }
  if (!draft.name.trim() || draft.name.length > 64) {
    return '请输入角色名称（1–64 位，不能全为空白）。'
  }
  if (!draft.permissions.includes('BUSINESS_READ')) {
    return '操作权限必须保留“业务查看”。'
  }
  if (draft.menuPaths.length === 0) {
    return '请至少勾选一个菜单权限。'
  }
  if (draft.baseRole === 'ADMIN') {
    if (!draft.permissions.includes('USER_ROLE_MAINTAIN')) {
      return '管理员角色必须保留“账号与角色维护”权限。'
    }
    if (!draft.menuPaths.includes('/admin')) {
      return '管理员角色必须保留“账号管理”菜单。'
    }
  }
  if (!isRoleProfile(draft)) {
    return '请检查角色编号、名称、权限和菜单；必须保留业务查看，管理员还须保留账号管理权限与菜单。'
  }
  return null
}

function confirmEdit(): void {
  if (!config.value || !editor.value) return
  editor.value.profileId = editor.value.profileId.trim()
  const message = validateEditor(editor.value)
  if (message) {
    editorError.value = message
    return
  }
  const next = structuredClone(toRaw(editor.value))
  const existingIndex = config.value.profiles.findIndex(row => row.profileId === editingId.value)
  if (existingIndex >= 0) {
    config.value.profiles = config.value.profiles.map((row, idx) => idx === existingIndex ? next : row)
  } else {
    config.value.profiles = [...config.value.profiles, next]
  }
  closeEditor()
  error.value = ''
}

function assign(user: User, profileId: string): void {
  if (!config.value || user.userId === auth.principal?.userId) return
  config.value.assignments = config.value.assignments.filter(row => row.userId !== user.userId)
  if (profileId) config.value.assignments.push({ userId: user.userId, profileId })
}

async function save(): Promise<void> {
  const current = epoch
  try {
    await ElMessageBox.confirm('保存后将立即按新配置限制权限，受影响账号需重新登录。确认保存？', '保存角色权限', { type: 'warning', confirmButtonText: '确认保存', cancelButtonText: '取消' })
    if (current === epoch) await request(true)
  } catch { /* 取消不写入。 */ }
}

function remove(profileId: string): void {
  if (!config.value || config.value.assignments.some(row => row.profileId === profileId)) return
  config.value.profiles = config.value.profiles.filter(row => row.profileId !== profileId)
}

function changeBase(): void {
  if (!editor.value) return
  editor.value.permissions = editor.value.baseRole === 'ADMIN' ? ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'] : ['BUSINESS_READ']
  editor.value.menuPaths = editor.value.baseRole === 'ADMIN' ? ['/situation', '/admin'] : ['/situation']
  editorError.value = ''
}

defineExpose({ hasUnsavedChanges })

watch(() => auth.principal?.userId, () => { ++epoch; controller?.abort(); config.value = null; savedSnapshot.value = ''; editor.value = null; editorError.value = ''; pending.value = false }, { flush: 'sync' })
onMounted(() => { void request() })
onBeforeUnmount(() => { ++epoch; controller?.abort() })
</script>

<template>
  <section class="role-profiles" aria-label="自定义角色与菜单权限" data-testid="role-profiles" v-loading="pending">
    <header class="rp-header">
      <div class="rp-header__title">
        <div class="rp-header__row">
          <h3>自定义角色与菜单权限</h3>
          <el-tag v-if="hasUnsavedChanges" type="warning" effect="light" size="small" data-testid="unsaved-role-changes">有未保存的更改</el-tag>
          <el-tag v-else-if="config" type="success" effect="plain" size="small">已同步</el-tag>
        </div>
        <p class="rp-hint">
          自定义角色仅可收窄基础角色权限，未分配账号保持原有权限；全部调整完成后请点击底部“保存权限配置”生效。
        </p>
      </div>
      <div class="rp-header__actions">
        <el-button :disabled="pending" @click="request()">重新加载</el-button>
        <el-button :disabled="pending || !config" @click="edit()">新增角色</el-button>
      </div>
    </header>

    <el-alert v-if="error" type="error" :title="error" :closable="false" show-icon />

    <div class="rp-card">
      <div class="rp-card__head">
        <div>
          <h4>角色列表</h4>
          <span class="rp-card__meta">共 {{ config?.profiles.length ?? 0 }} 个自定义角色</span>
        </div>
      </div>
      <el-table :data="config?.profiles ?? []" empty-text="暂无数据" border stripe size="small" class="rp-table">
        <el-table-column prop="name" label="角色名称" min-width="140" />
        <el-table-column prop="profileId" label="编号" width="140">
          <template #default="{ row }"><code class="rp-code">{{ row.profileId }}</code></template>
        </el-table-column>
        <el-table-column label="基础角色" width="96">
          <template #default="{ row }">
            <el-tag :type="row.baseRole === 'ADMIN' ? 'primary' : 'info'" size="small" effect="light">
              {{ ROLE_LABELS[row.baseRole as Role] ?? row.baseRole }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="权限" min-width="210">
          <template #default="{ row }">
            <div class="rp-tag-list">
              <el-tag v-for="key in visiblePermissions(row.permissions)" :key="key" size="small" type="info" effect="plain">
                {{ PERMISSION_LABELS[key] }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="菜单" min-width="230">
          <template #default="{ row }">
            <div v-if="visibleMenuPaths(row.menuPaths).length > 0" class="rp-tag-list">
              <el-tag v-for="path in visibleMenuPaths(row.menuPaths)" :key="path" size="small" effect="plain">
                {{ MENU_LABELS[path] }}
              </el-tag>
            </div>
            <el-tag v-else type="warning" size="small" effect="light">未配置可用菜单</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="已分配" width="84" align="center">
          <template #default="{ row }">
            <span class="rp-count">{{ assignedCountByProfile.get(row.profileId) ?? 0 }} 人</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-tooltip
              :disabled="row.profileId !== ownProfileId"
              content="不能编辑当前登录管理员正在使用的角色"
              placement="top"
            >
              <span class="rp-action-wrap">
                <el-button link type="primary" :disabled="pending || row.profileId === ownProfileId" @click="edit(row)">编辑</el-button>
              </span>
            </el-tooltip>
            <el-tooltip
              :disabled="!(assignedCountByProfile.get(row.profileId) ?? 0)"
              :content="`该角色已分配给 ${assignedCountByProfile.get(row.profileId) ?? 0} 个账号，请先在下方解除分配后再删除`"
              placement="top"
            >
              <span class="rp-action-wrap">
                <el-button link type="danger" :disabled="pending || config?.assignments.some(item => item.profileId === row.profileId)" @click="remove(row.profileId)">删除</el-button>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="rp-card">
      <div class="rp-card__head">
        <div>
          <h4>账号分配</h4>
          <span class="rp-card__meta">已分配 {{ totalAssignedUsers }} / {{ users.length }} 个账号（仅可分配与基础身份一致的角色）</span>
        </div>
        <el-input
          v-if="users.length > 0"
          v-model="userSearch"
          clearable
          size="small"
          placeholder="搜索用户名或登录账号"
          aria-label="搜索分配账号"
          class="rp-search"
        />
      </div>
      <el-table :data="filteredUsers" empty-text="暂无数据" border stripe size="small" class="rp-table">
        <el-table-column label="用户名" min-width="130">
          <template #default="{ row }">{{ row.displayName ?? row.username }}</template>
        </el-table-column>
        <el-table-column prop="username" label="登录账号" min-width="130" />
        <el-table-column label="基础身份" width="104">
          <template #default="{ row }">
            <el-tag :type="row.role === 'ADMIN' ? 'primary' : 'info'" size="small" effect="light">
              {{ ROLE_LABELS[row.role as Role] ?? row.role }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="自定义角色" min-width="260">
          <template #default="{ row }">
            <div class="rp-assign-cell">
              <el-select
                size="small"
                :model-value="config?.assignments.find(item => item.userId === row.userId)?.profileId ?? ''"
                :disabled="pending || !config || row.userId === auth.principal?.userId"
                :placeholder="profilesForRole(row.role).length === 0 ? '使用原有权限（上方暂无可选角色）' : '使用原有权限'"
                @update:model-value="assign(row, $event)"
              >
                <el-option value="" label="使用原有权限" />
                <el-option
                  v-for="profile in profilesForRole(row.role)"
                  :key="profile.profileId"
                  :value="profile.profileId"
                  :label="`${profile.name}（${profile.profileId}）`"
                />
              </el-select>
              <span v-if="row.userId === auth.principal?.userId" class="rp-self-note">当前登录账号不可调整</span>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <footer class="rp-footer">
      <span v-if="hasUnsavedChanges" class="rp-footer__note">存在未保存的更改，保存后立即按新配置限制权限。</span>
      <el-button type="primary" :disabled="pending || !config" @click="save">保存权限配置</el-button>
    </footer>

    <el-dialog
      :model-value="editor !== null"
      :title="editingId ? '编辑自定义角色' : '新增自定义角色'"
      width="min(760px, calc(100vw - 32px))"
      append-to-body
      :close-on-click-modal="false"
      @close="closeEditor"
    >
      <el-form v-if="editor" label-position="top" class="rp-editor-form">
        <div class="rp-editor-grid">
          <el-form-item label="名称" required>
            <el-input v-model="editor.name" data-testid="profile-name" maxlength="64" placeholder="例如：值班操作员" />
          </el-form-item>
          <el-form-item label="角色编号" required>
            <div class="rp-id-row">
              <el-input
                v-model="editor.profileId"
                :disabled="editingId !== null"
                data-testid="profile-id"
                maxlength="64"
                placeholder="字母、数字、_ 或 -，如 OP_WATCH"
              />
              <el-button v-if="editingId === null" plain data-testid="generate-profile-id" @click="generateProfileId">自动生成</el-button>
            </div>
          </el-form-item>
        </div>

        <el-form-item label="基础角色">
          <div class="rp-base-row">
            <el-select
              v-model="editor.baseRole"
              :disabled="!!editingId && !!config?.assignments.some(row => row.profileId === editingId)"
              @change="changeBase"
            >
              <el-option label="操作员" value="OPERATOR" />
              <el-option label="管理员" value="ADMIN" />
            </el-select>
            <span class="rp-field-hint">
              {{ editor.baseRole === 'ADMIN' ? '管理员角色须保留“业务查看”、“账号与角色维护”权限及“账号管理”菜单。' : '操作员角色须保留“业务查看”权限，且至少勾选一个菜单。' }}
            </span>
          </div>
        </el-form-item>

        <el-form-item>
          <template #label>
            <div class="rp-group-label">
              <span>操作权限</span>
              <span class="rp-group-actions">
                <el-button link type="primary" size="small" @click="selectAllPermissions">全选</el-button>
                <el-button link size="small" @click="resetMinimalPermissions">仅保留必选</el-button>
              </span>
            </div>
          </template>
          <el-checkbox-group v-model="editor.permissions" class="rp-check-grid">
            <el-checkbox
              v-for="permission in permissions"
              :key="permission"
              :value="permission"
              :disabled="isRequiredPermission(permission)"
            >{{ PERMISSION_LABELS[permission] }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>

        <el-form-item>
          <template #label>
            <div class="rp-group-label">
              <span>菜单权限</span>
              <span class="rp-group-actions">
                <el-button link type="primary" size="small" @click="selectAllMenus">全选</el-button>
                <el-button link size="small" @click="resetMinimalMenus">仅保留必选</el-button>
              </span>
            </div>
          </template>
          <el-checkbox-group v-model="editor.menuPaths" aria-label="菜单权限" class="rp-check-grid">
            <el-checkbox
              v-for="[path, label] in menus"
              :key="path"
              :value="path"
              :disabled="isRequiredMenu(path)"
            >{{ label }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>

        <el-alert v-if="editorError" :title="editorError" type="error" :closable="false" show-icon data-testid="profile-editor-error" />
      </el-form>
      <template #footer>
        <div class="rp-dialog-footer">
          <span class="rp-footer-note">确认后加入草稿列表，返回外层点击“保存权限配置”后生效。</span>
          <div class="rp-footer-buttons">
            <el-button @click="closeEditor">取消</el-button>
            <el-button type="primary" @click="confirmEdit">确认配置</el-button>
          </div>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.role-profiles {
  display: grid;
  gap: 16px;
}

.rp-header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  align-items: flex-start;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.rp-header__title {
  display: grid;
  gap: 4px;
  min-width: 0;
  flex: 1 1 320px;
}

.rp-header__row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.rp-header__title h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.rp-hint {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.rp-header__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.rp-header__actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.rp-card {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-blank);
}

.rp-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}

.rp-card__head h4 {
  display: inline;
  margin: 0 8px 0 0;
  font-size: 14px;
  font-weight: 600;
}

.rp-card__meta {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.rp-search {
  width: 220px;
}

.rp-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.rp-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.rp-count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.rp-action-wrap {
  display: inline-flex;
}

.rp-action-wrap + .rp-action-wrap {
  margin-left: 8px;
}

.rp-assign-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.rp-assign-cell :deep(.el-select) {
  width: 240px;
}

.rp-self-note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.rp-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.rp-footer__note {
  margin-right: auto;
  font-size: 12px;
  color: var(--el-color-warning-dark-2, var(--el-color-warning));
}

.rp-editor-form {
  display: grid;
  gap: 4px;
}

.rp-editor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
}

.rp-id-row {
  display: flex;
  gap: 8px;
  width: 100%;
}

.rp-base-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  width: 100%;
}

.rp-base-row :deep(.el-select) {
  width: 160px;
}

.rp-field-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.4;
}

.rp-group-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.rp-group-actions {
  display: inline-flex;
  gap: 8px;
}

.rp-check-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px 12px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-light);
}

.rp-check-grid :deep(.el-checkbox) {
  margin-right: 0;
  height: auto;
  padding: 2px 0;
}

.rp-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.rp-footer-note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.rp-footer-buttons {
  display: inline-flex;
  gap: 8px;
}

@media (max-width: 640px) {
  .rp-editor-grid {
    grid-template-columns: 1fr;
  }

  .rp-check-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

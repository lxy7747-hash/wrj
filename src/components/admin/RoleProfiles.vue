<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AccessControlConfig, Permission, RoleProfile, User } from '../../contracts/domain-models'
import { isAccessControlConfig, isRoleProfile, MENU_LABELS, OPERATOR_PERMISSION_KEYS, PERMISSION_LABELS } from '../../features/admin/access-control'
import { apiFetch } from '../../features/shared/api-fetch'
import { useAuthStore } from '../../stores/auth'

defineProps<{ users: User[] }>()
const auth = useAuthStore()
const config = ref<AccessControlConfig | null>(null)
const error = ref('')
const pending = ref(false)
const editor = ref<RoleProfile | null>(null)
const editingId = ref<string | null>(null)
let epoch = 0
let controller: AbortController | undefined
const permissions = computed(() => editor.value?.baseRole === 'OPERATOR' ? OPERATOR_PERMISSION_KEYS : Object.keys(PERMISSION_LABELS) as Permission[])
const menus = computed(() => Object.entries(MENU_LABELS).filter(([path]) => editor.value?.baseRole === 'ADMIN' || !path.startsWith('/admin') || path === '/admin/data-exchange'))
const ownProfileId = computed(() => config.value?.assignments.find(row => row.userId === auth.principal?.userId)?.profileId)
async function request(save = false): Promise<void> {
  if (pending.value || (save && !config.value)) return
  const current = ++epoch
  controller?.abort()
  const abort = new AbortController()
  controller = abort
  const timer = setTimeout(() => abort.abort(), 10_000)
  const payload = save ? JSON.stringify(config.value) : undefined
  pending.value = true
  error.value = ''
  try {
    const response = await apiFetch(`${import.meta.env.VITE_MOCK_ORIGIN ?? 'http://127.0.0.1:4173'}/api/v1/admin/access-control`, {
      signal: abort.signal, headers: { 'X-Demo-Role': auth.role, 'Content-Type': 'application/json' },
      ...(save ? { method: 'PUT', body: payload } : {}),
    })
    const body = await response.json()
    if (current !== epoch) return
    if (!response.ok || body.ok !== true) throw new Error(body.error?.message ?? '角色配置请求失败。')
    if (!isAccessControlConfig(body.data)) throw new Error('角色配置响应不正确。')
    config.value = body.data
    if (save) ElMessage.success('角色配置已保存，受影响账号需重新登录。')
  } catch (reason) { if (current === epoch) { if (!save) config.value = null; error.value = reason instanceof Error ? reason.message : '角色配置请求失败。' } }
  finally { clearTimeout(timer); if (current === epoch) pending.value = false }
}
function edit(profile?: RoleProfile): void {
  editingId.value = profile?.profileId ?? null
  editor.value = profile ? structuredClone(toRaw(profile)) : { profileId: '', name: '', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: ['/situation'] }
}
function confirmEdit(): void {
  if (!config.value || !editor.value) return
  if (!isRoleProfile(editor.value) || config.value.profiles.some(row => row.profileId === editor.value?.profileId && row.profileId !== editingId.value)) {
    error.value = '请检查角色编号、名称、权限和菜单；必须保留业务查看，管理员还须保留账号管理权限与菜单。'; return
  }
  config.value.profiles = [...config.value.profiles.filter(row => row.profileId !== editingId.value), structuredClone(toRaw(editor.value))]
  editor.value = null
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
}
watch(() => auth.principal?.userId, () => { ++epoch; controller?.abort(); config.value = null; editor.value = null; pending.value = false }, { flush: 'sync' })
onMounted(() => { void request() })
onBeforeUnmount(() => { ++epoch; controller?.abort() })
</script>

<template>
  <section class="role-profiles" aria-label="自定义角色与菜单权限" data-testid="role-profiles" v-loading="pending">
    <header><h3>自定义角色与菜单权限</h3><el-button :disabled="pending" @click="request()">重新加载</el-button><el-button :disabled="pending || !config" @click="edit()">新增角色</el-button><el-button type="primary" :disabled="pending || !config" @click="save">保存权限配置</el-button></header>
    <p>未分配自定义角色的账号保持原有权限。角色只收窄基础权限；菜单授权不会开启全局配置中隐藏的模块。分配不会改变账号的 ADMIN／OPERATOR 身份。</p>
    <el-alert v-if="error" type="error" :title="error" :closable="false" />
    <el-table :data="config?.profiles ?? []" empty-text="暂无数据">
      <el-table-column prop="name" label="角色名称" /><el-table-column prop="profileId" label="编号" /><el-table-column prop="baseRole" label="基础角色" />
      <el-table-column label="权限"><template #default="{ row }">{{ row.permissions.map((key: Permission) => PERMISSION_LABELS[key]).join('、') }}</template></el-table-column>
      <el-table-column label="菜单"><template #default="{ row }">{{ row.menuPaths.map((path: string) => MENU_LABELS[path]).join('、') }}</template></el-table-column>
      <el-table-column label="操作"><template #default="{ row }"><el-button link :disabled="pending || row.profileId === ownProfileId" @click="edit(row)">编辑</el-button><el-button link type="danger" :disabled="pending || config?.assignments.some(item => item.profileId === row.profileId)" @click="remove(row.profileId)">删除</el-button></template></el-table-column>
    </el-table>
    <h4>账号分配</h4>
    <el-table :data="users" empty-text="暂无数据"><el-table-column prop="username" label="账号" /><el-table-column prop="role" label="基础身份" /><el-table-column label="自定义角色"><template #default="{ row }">
      <el-select :model-value="config?.assignments.find(item => item.userId === row.userId)?.profileId ?? ''" :disabled="pending || !config || row.userId === auth.principal?.userId" @update:model-value="assign(row, $event)">
        <el-option value="" label="使用原有权限" /><el-option v-for="profile in config?.profiles.filter(item => item.baseRole === row.role) ?? []" :key="profile.profileId" :value="profile.profileId" :label="profile.name" />
      </el-select>
    </template></el-table-column></el-table>
    <el-dialog :model-value="editor !== null" :title="editingId ? '编辑自定义角色' : '新增自定义角色'" width="min(720px, calc(100vw - 32px))" append-to-body @close="editor = null">
      <el-form v-if="editor" label-position="top">
        <el-form-item label="角色编号"><el-input v-model="editor.profileId" :disabled="editingId !== null" data-testid="profile-id" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="editor.name" data-testid="profile-name" maxlength="64" /></el-form-item>
        <el-form-item label="基础角色"><el-select v-model="editor.baseRole" :disabled="!!editingId && !!config?.assignments.some(row => row.profileId === editingId)" @change="changeBase"><el-option label="操作员" value="OPERATOR" /><el-option label="管理员" value="ADMIN" /></el-select></el-form-item>
        <el-form-item label="操作权限"><el-checkbox-group v-model="editor.permissions"><el-checkbox v-for="permission in permissions" :key="permission" :value="permission">{{ PERMISSION_LABELS[permission] }}</el-checkbox></el-checkbox-group></el-form-item>
        <el-form-item label="菜单权限"><el-checkbox-group v-model="editor.menuPaths"><el-checkbox v-for="[path, label] in menus" :key="path" :value="path">{{ label }}</el-checkbox></el-checkbox-group></el-form-item>
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
      </el-form>
      <template #footer><el-button @click="editor = null">取消</el-button><el-button type="primary" @click="confirmEdit">确认配置</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.role-profiles { padding: 16px; border: 1px solid var(--el-border-color); border-radius: 8px; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; } h3 { margin-right: auto; }
p { color: var(--el-text-color-secondary); font-size: 12px; }
</style>

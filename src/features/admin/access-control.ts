import type { AccessControlConfig, Permission, Principal, RoleProfile } from '../../contracts/domain-models'
import { isAdminObject, isAdminText } from './admin-contract'

export const PERMISSION_LABELS: Record<Permission, string> = {
  BUSINESS_READ: '业务查看', SCENARIO_DRAFT_WRITE: '场景编辑', SIMULATION_CONTROL: '仿真控制', ORDINARY_REPORT_EXPORT: '普通报告导出',
  OFFICIAL_TEMPLATE_MAINTAIN: '模板维护', MASTER_DATA_MAINTAIN: '装备与主数据维护', USER_ROLE_MAINTAIN: '账号与角色维护',
  BACKUP_RESTORE: '备份恢复', AUDIT_READ: '审计查询', FULL_CONFIG_EXPORT: '完整配置导出', BATCH_LEVEL_III_EXPORT: '三级报告导出',
}
export const MENU_LABELS: Record<string, string> = {
  '/situation': '态势主界面', '/scenarios': '场景配置', '/reports': '评估报表', '/replays': '历史回放', '/batches': '批量仿真',
  '/blueprint': '能力蓝图', '/interactions': '感知、干扰与选路', '/traceability': '需求追踪', '/admin/data-exchange': '数据交换与接口',
  '/admin': '账号管理', '/admin?section=equipment-library': '装备参数库', '/admin?section=scenario-templates': '场景模板维护',
  '/admin?section=audit-logs': '操作审计日志', '/admin?section=master-data': '主数据管理', '/admin?section=database-backup': '备份恢复',
  '/admin?section=simulation-data': '仿真数据管理', '/admin?section=runtime-status': '系统运行状态',
}
export const OPERATOR_PERMISSION_KEYS: Permission[] = ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE', 'SIMULATION_CONTROL', 'ORDINARY_REPORT_EXPORT']
export function validMenuPaths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(path => typeof path === 'string' && Object.hasOwn(MENU_LABELS, path)) && new Set(value).size === value.length
}
export function isRoleProfile(value: unknown): value is RoleProfile {
  if (!isAdminObject(value, ['profileId', 'name', 'baseRole', 'permissions', 'menuPaths']) || typeof value.profileId !== 'string'
    || !/^[A-Za-z0-9_-]{1,64}$/.test(value.profileId) || !isAdminText(value.name) || value.name.length > 64
    || !['ADMIN', 'OPERATOR'].includes(String(value.baseRole)) || typeof value.baseRole !== 'string'
    || !Array.isArray(value.permissions) || !value.permissions.every(p => typeof p === 'string' && Object.hasOwn(PERMISSION_LABELS, p))
    || new Set(value.permissions).size !== value.permissions.length || !value.permissions.includes('BUSINESS_READ') || !validMenuPaths(value.menuPaths)) return false
  if (value.baseRole === 'OPERATOR') return value.permissions.every(p => OPERATOR_PERMISSION_KEYS.includes(p))
    && value.menuPaths.every(path => !path.startsWith('/admin') || path === '/admin/data-exchange')
  // 管理员配置保留账号治理入口，防止角色编辑造成全系统管理员失联。
  return value.permissions.includes('USER_ROLE_MAINTAIN') && value.menuPaths.includes('/admin')
}
export function isAccessControlConfig(value: unknown): value is AccessControlConfig {
  if (!isAdminObject(value, ['version', 'profiles', 'assignments']) || !Number.isSafeInteger(value.version) || Number(value.version) < 1
    || !Array.isArray(value.profiles) || !value.profiles.every(isRoleProfile) || value.profiles.length > 100
    || new Set(value.profiles.map(p => p.profileId)).size !== value.profiles.length
    || !Array.isArray(value.assignments) || value.assignments.length > 1000) return false
  const profiles = value.profiles
  return value.assignments.every(row => isAdminObject(row, ['userId', 'profileId']) && isAdminText(row.userId) && profiles.some((p: RoleProfile) => p.profileId === row.profileId))
    && new Set(value.assignments.map(row => row.userId)).size === value.assignments.length
}
export function canVisitMenu(principal: Principal | null, path: string): boolean {
  return principal !== null && (principal.menuPaths === undefined || principal.menuPaths.includes(path))
}

import type { AuditRecord, Role } from '../../contracts/domain-models'

export const roleLabels: Record<Role, string> = { ADMIN: '管理员', OPERATOR: '操作员' }
const moduleLabels: Record<string, string> = {
  AUTHENTICATION: '登录认证', USER_MANAGEMENT: '账号管理',
  SCENARIO_CONFIGURATION: '场景配置', SIMULATION_CONTROL: '仿真控制',
  SCRIPT_GENERATION: '脚本生成', REPORTING: '报告管理',
  AUDIT: '操作审计', CONFIRMATION: '操作确认', SYSTEM: '系统管理',
}
export const resultLabels: Record<AuditRecord['result'], string> = { SUCCESS: '成功', DENIED: '已拒绝', ERROR: '错误' }
const objectCategories: Record<string, string> = {
  AUTH_LOGIN: '账号', AUTH_LOGOUT: '账号', USER_: '账号',
  SCENARIO_: '场景', TEMPLATE_: '场景模板',
  SIMULATION_JAMMER_: '干扰设备', SIMULATION_: '仿真运行',
  SCRIPT_PREVIEW: '场景', SCRIPT_PREFLIGHT: '脚本',
  BATCH_: '仿真批次', REPLAY_: '回放', REPORT_: '报告',
  MASTER_DATA_: '主数据', THRESHOLD_: '阈值配置', BACKUP_: '备份',
}

export function formatModule(row: AuditRecord): string {
  const label = moduleLabels[row.module]
  return typeof label === 'string' ? label : row.module
}

export function formatObject(row: AuditRecord): string {
  if (!row.objectId) return '未指定对象'
  const label = row.objectId === 'AUDIT-LOG' ? '操作审计日志'
    : row.objectId === 'FULL-CONFIG' ? '完整配置'
      : Object.entries(objectCategories).find(([prefix]) => row.action.startsWith(prefix))?.[1]
  // 历史记录只提供对象编号，不用当前实体名称替代历史身份。
  return label ? `${label}（${row.objectId}）` : row.objectId
}

const actionLabels: Record<string, string> = {
  AUTH_LOGIN: '登录',
  AUTH_LOGOUT: '退出登录',
  AUTH_PERMISSIONS: '查询账号权限',
  AUTH_LOGIN_RATE_LIMITED: '登录尝试超出限制',
  AUTH_SESSION_DENIED: '会话鉴权拒绝',
  AUTH_LOOPBACK_DENIED: '非允许来源访问拒绝',
  AUTH_WS_DENIED: '实时连接鉴权拒绝',
  USER_LIST: '查询用户列表',
  USER_CREATE: '创建用户',
  USER_UPDATE: '修改用户',
  USER_ENABLE: '启用用户',
  USER_DISABLE: '禁用用户',
  USER_DELETE: '删除用户',
  THRESHOLD_UPDATE: '修改阈值',
  SCENARIO_LIST: '查询场景列表',
  SCENARIO_CREATE: '新建场景',
  SCENARIO_READ: '读取场景',
  SCENARIO_UPDATE: '保存场景配置',
  SCENARIO_DELETE: '删除场景',
  SCENARIO_VALIDATE: '校验场景',
  SCENARIO_IMPORT: '导入场景',
  SCENARIO_UNDO: '撤销场景修改',
  SCENARIO_RESET: '重置场景',
  SCENARIO_CONTRACT_READ: '查询场景数据规范',
  TEMPLATE_LIST: '查询场景模板列表',
  TEMPLATE_CREATE: '创建场景模板',
  TEMPLATE_READ: '读取场景模板',
  TEMPLATE_UPDATE: '修改场景模板',
  TEMPLATE_COPY: '复制场景模板',
  TEMPLATE_DELETE: '删除场景模板',
  SCRIPT_PREVIEW: '生成脚本预览',
  SCRIPT_PREFLIGHT: '执行脚本预检',
  SIMULATION_LIST: '查询仿真列表',
  SIMULATION_CREATE: '创建仿真',
  SIMULATION_READ: '读取仿真状态',
  SIMULATION_FRAME_READ: '读取仿真帧',
  SIMULATION_EVENT_LIST: '查询仿真事件',
  SIMULATION_COMMAND: '执行仿真控制指令',
  SIMULATION_CLOSED_LOOP: '执行干扰闭环',
  SIMULATION_JAMMER_COMMAND: '执行干扰设备指令',
  SIMULATION_JAMMER_SYNC: '同步干扰设备参数',
  BATCH_LIST: '查询仿真批次列表',
  BATCH_CREATE: '创建仿真批次',
  BATCH_READ: '读取仿真批次',
  BATCH_COMMAND: '执行批次控制指令',
  REPLAY_LIST: '查询回放列表',
  REPLAY_READ: '读取回放',
  REPLAY_COMMAND: '执行回放控制指令',
  REPORT_LIST: '查询报告列表',
  REPORT_READ: '读取报告',
  REPORT_EXPORT: '验证报告导出',
  CONFIRMATION_CREATE: '创建操作确认',
  CONFIRMATION_CONFIRM: '确认操作',
  MASTER_DATA_LIST: '查询主数据列表',
  MASTER_DATA_CREATE: '新增主数据',
  MASTER_DATA_UPDATE: '修改主数据',
  MASTER_DATA_DELETE: '删除主数据',
  BACKUP_LIST: '查询备份列表',
  BACKUP_CREATE: '创建备份',
  BACKUP_RESTORE: '恢复备份',
  ARCHIVE_LIST: '查询仿真归档',
  HEALTH_READ: '查询系统运行状态',
  FULL_CONFIG_EXPORT: '验证完整配置导出',
  AUDIT_LIST: '查询操作审计日志',
  AUDIT_EXPORT: '导出审计日志',
  METADATA_READ: '查询能力元数据',
  INTERFACE_LIST: '查询接口列表',
  FRONTEND_CONTRACT_LIST: '查询前端接口规范',
  CSV_CONTRACT_LIST: '查询 CSV 数据规范',
  INITIAL_NODES_READ: '读取初始节点',
  POSITIONS_READ: '读取节点实时位置',
  LOCAL_REPLAY_READ: '读取本地回放',
}

export function formatAction(row: AuditRecord): string {
  const label = actionLabels[row.action]
  return typeof label === 'string' ? label : row.action
}

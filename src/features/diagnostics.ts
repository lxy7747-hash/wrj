import type { ApiErrorCode } from '../contracts/domain-models'

/** 冻结错误码的中文处理说明，仅供界面诊断查询，不替代服务端校验。 */
export const ERROR_GUIDANCE: Record<ApiErrorCode, string> = {
  INVALID_REQUEST: '请求结构错误，请检查输入。', VALIDATION_FAILED: '参数校验未通过，请按字段提示修正。',
  NOT_FOUND: '对象不存在，请刷新目录。', CONFLICT: '对象状态冲突，请刷新后重试。',
  INVALID_CREDENTIALS: '用户名或密码错误。', ACCOUNT_LOCKED: '账号已锁定，请联系管理员。',
  PERMISSION_DENIED: '权限不足，请使用有权限的账号。', LAST_ADMIN_GUARD: '不能删除或降级最后一位管理员。',
  CONFIRMATION_REQUIRED: '请先完成二次确认。', CONFIRMATION_EXPIRED: '确认已失效，请重新发起。',
  CONFIG_LOCKED: '运行期间配置已锁定，请先停止运行。', INVALID_TRANSITION: '当前状态不支持此操作。',
  NODE_LIMIT_EXCEEDED: '信息节点数量超出上限。', DUPLICATE_EVENT: '重复事件已忽略。',
  VERSION_CONFLICT: '数据版本已变化，请刷新。', FRAME_MISMATCH: '帧编号或时刻不一致，请重新同步。',
  HEADER_INVALID: 'CSV 表头不符合合同。', TYPE_INVALID: '字段类型错误，请按合同修正。',
  ENCODING_INVALID: '文本编码不符合合同。', ATOMIC_REPLACE_FAILED: '替换失败，原数据未覆盖。',
  START_FAILED: '启动失败，请查看启动结果。', TIMEOUT: '响应超时，请重试。',
  EXIT_NONZERO: '进程返回异常退出码，请查看错误详情。', CORRUPT_FIXTURE: '模拟数据损坏，请恢复基线。',
  OUT_OF_RANGE: '参数超出允许范围。', DEVICE_DISABLED: '设备已停用。',
  LOOPBACK_ONLY: '仅允许访问本机回环地址。', TOPIC_FORBIDDEN: '该消息主题未获允许。',
  SEQUENCE_GAP: '消息序号不连续，请重新同步。', INTERNAL_FIXTURE_ERROR: '模拟数据投影失败，请重试。',
}

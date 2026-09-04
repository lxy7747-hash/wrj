import { defineStore } from 'pinia'
import type {
  ApiFailure,
  AuditRecord,
  AuditRequest,
  CapabilityState,
  ConfirmationContext,
  DeleteResult,
  ExportStatus,
  PageMeta,
  Role,
  User,
  UserRoleCommand,
} from '../contracts/domain-models'
import { resolveMockOrigin, useAuthStore } from './auth'

const USER_KEYS = new Set(['userId', 'username', 'role', 'status', 'lastLoginAt'])
const AUDIT_KEYS = new Set(['auditId', 'actor', 'role', 'module', 'action', 'objectId', 'result', 'occurredAt', 'immutableFixture'])
const META_KEYS = new Set(['requestId', 'generatedAt', 'page', 'pageSize', 'total'])
const CONFIRMATION_KEYS = new Set(['confirmationId', 'state', 'actor', 'role', 'createdAt', 'expiresAt'])
const EXPORT_STATUS_KEYS = new Set(['objectId', 'generated', 'classification', 'watermark', 'verifiedAt'])

export type AuditFilters = Omit<AuditRequest, 'export' | 'confirmationId'>

/**
 * 创建首次刷新前展示的确定性用户初始投影。
 *
 * @returns 包含基线管理员和操作员账号的新数组。
 * @remarks 纯工厂函数，不访问网络，也不暴露共享可变数组。
 */
function initialUsers(): User[] {
  return [
    { userId: 'USR-ADMIN', username: 'admin', role: 'ADMIN', status: 'ACTIVE' },
    { userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', status: 'ACTIVE' },
  ]
}

class InvalidResponseError extends Error {
  /**
   * 创建用户管理响应违反合同时使用的标记错误。
   *
   * @returns 初始化后的无效响应错误实例。
   * @remarks 只设置当前 Error 对象的消息，不修改 Store 状态。
   */
  constructor() {
    super('用户数据格式不正确。')
  }
}

class InvalidAuditResponseError extends Error {
  constructor() {
    super('审计日志响应格式不正确。')
  }
}

const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/**
 * 按公历闰年规则计算指定月份的有效天数。
 *
 * @param year 从 RFC 3339 时间戳解析出的四位年份。
 * @param month 从 1 开始的月份。
 * @returns 月份天数；非二月且月份超出查找范围时返回 -1。
 * @remarks 纯算术计算，不读取系统时钟或修改状态。
 */
function daysInMonth(year: number, month: number): number {
  if (month !== 2) {
    return MONTH_LENGTHS[month - 1] ?? -1
  }

  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  return isLeapYear ? 29 : 28
}

/**
 * 校验 RFC 3339 日期时间形状并拒绝不存在的日历日期。
 *
 * @param value User 响应中的候选时间戳字符串。
 * @returns 时间戳是否同时满足允许的语法和日历范围。
 * @remarks 纯校验函数，以算术代替系统时间 API，不产生副作用。
 */
function isRfc3339DateTime(value: string): boolean {
  // RFC 3339 ABNF is case-insensitive, so its specification explicitly permits lowercase t/z.
  // Hour/minute/second/offset ranges are bounded by the shape regex; the calendar day is
  // checked against the real month length via pure arithmetic, because V8 parsing would
  // roll impossible values like 2026-02-30 forward instead of rejecting them.
  const match = RFC3339_DATE_TIME.exec(value)
  if (match === null) return false

  const [, yearText, monthText, dayText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  if (month < 1 || month > 12) return false

  return day >= 1 && day <= daysInMonth(year, month)
}

/**
 * 从未知响应载荷中读取最小类型化错误合同。
 *
 * @param payload 用户管理服务返回的已解析响应体。
 * @returns 必填字段存在时返回 API 失败对象，否则返回 undefined。
 * @remarks 纯边界校验函数，不访问网络或修改 Store。
 */
function readFailure(payload: unknown): ApiFailure | undefined {
  if (typeof payload !== 'object' || payload === null || (payload as { ok?: unknown }).ok !== false) return undefined
  const error = (payload as { error?: { code?: unknown; message?: unknown } }).error
  if (typeof error?.code !== 'string' || typeof error.message !== 'string') return undefined
  return payload as ApiFailure
}

/**
 * 从成功 API 信封中提取业务数据。
 *
 * @param payload 用户管理服务返回的已解析响应体。
 * @returns 信封中的 data；载荷不是成功信封时返回 undefined。
 * @remarks 纯适配函数，不访问网络或修改 Store。
 */
function unwrapData(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || (payload as { ok?: unknown }).ok !== true) return undefined
  return (payload as { data?: unknown }).data
}

/**
 * 校验与权威 OpenAPI User schema 等价的闭合运行时形状。
 *
 * @param value 服务响应中的候选用户值。
 * @returns 必填字段、可选时间戳和闭合键集合是否均符合 User 合同。
 * @remarks 纯校验函数，不访问网络或修改 Store。
 */
export function isUser(value: unknown): value is User {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.some((key) => !USER_KEYS.has(key))) return false

  const candidate = value as Partial<User>
  return typeof candidate.userId === 'string'
    && candidate.userId.length >= 1
    && typeof candidate.username === 'string'
    && (candidate.role === 'ADMIN' || candidate.role === 'OPERATOR')
    && (candidate.status === 'ACTIVE' || candidate.status === 'DISABLED' || candidate.status === 'LOCKED')
    && (candidate.lastLoginAt === undefined
      || (typeof candidate.lastLoginAt === 'string' && isRfc3339DateTime(candidate.lastLoginAt)))
}

/**
 * 从成功信封中读取并校验完整用户集合。
 *
 * @param payload 已解析的用户列表响应载荷。
 * @returns 校验通过的用户数组；信封或任一用户无效时返回 undefined。
 * @remarks 纯适配函数，不克隆或修改响应数据。
 */
function readUsers(payload: unknown): User[] | undefined {
  const data = unwrapData(payload)
  return Array.isArray(data) && data.every(isUser) ? data : undefined
}

/**
 * 从成功信封中读取并校验单个用户。
 *
 * @param payload 已解析的用户变更响应载荷。
 * @returns 校验通过的用户；信封或用户形状无效时返回 undefined。
 * @remarks 纯适配函数，不修改响应数据或 Store 状态。
 */
function readUser(payload: unknown): User | undefined {
  const data = unwrapData(payload)
  return isUser(data) ? data : undefined
}

/**
 * 从成功信封中读取闭合的删除结果合同。
 *
 * @param payload 已解析的删除响应载荷。
 * @returns 校验通过的删除结果；键或值违反合同时返回 undefined。
 * @remarks 纯适配函数，不访问网络或修改 Store。
 */
function readDeleteResult(payload: unknown): DeleteResult | undefined {
  const data = unwrapData(payload)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  if (Object.keys(data).some((key) => key !== 'deleted' && key !== 'objectId')) return undefined
  const candidate = data as Partial<DeleteResult>
  return typeof candidate.deleted === 'boolean'
    && typeof candidate.objectId === 'string'
    && candidate.objectId.length >= 1
    ? candidate as DeleteResult
    : undefined
}

function isPageMeta(value: unknown): value is PageMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (Object.keys(value).some((key) => !META_KEYS.has(key)) || Object.keys(value).length !== META_KEYS.size) return false
  const meta = value as Partial<PageMeta>
  return typeof meta.requestId === 'string'
    && meta.requestId.length > 0
    && typeof meta.generatedAt === 'string'
    && isRfc3339DateTime(meta.generatedAt)
    && Number.isInteger(meta.page)
    && (meta.page ?? 0) >= 1
    && Number.isInteger(meta.pageSize)
    && (meta.pageSize ?? 0) >= 1
    && Number.isInteger(meta.total)
    && (meta.total ?? -1) >= 0
}

function readStrictData(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  if (Object.keys(payload).sort().join(',') !== 'data,meta,ok') return undefined
  const envelope = payload as { ok?: unknown; data?: unknown; meta?: unknown }
  return envelope.ok === true && isPageMeta(envelope.meta) ? envelope.data : undefined
}

export function isAuditRecord(value: unknown): value is AuditRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.some((key) => !AUDIT_KEYS.has(key))) return false
  const record = value as Partial<AuditRecord>
  return typeof record.auditId === 'string'
    && record.auditId.length > 0
    && typeof record.actor === 'string'
    && record.actor.length > 0
    && (record.role === 'ADMIN' || record.role === 'OPERATOR')
    && typeof record.module === 'string'
    && record.module.length > 0
    && typeof record.action === 'string'
    && record.action.length > 0
    && (record.objectId === undefined || (typeof record.objectId === 'string' && record.objectId.length > 0))
    && (record.result === 'SUCCESS' || record.result === 'DENIED' || record.result === 'ERROR')
    && typeof record.occurredAt === 'string'
    && isRfc3339DateTime(record.occurredAt)
    && record.immutableFixture === true
}

function readAuditRecords(payload: unknown): AuditRecord[] | undefined {
  const data = readStrictData(payload)
  return Array.isArray(data) && data.every(isAuditRecord) ? data : undefined
}

function readConfirmation(payload: unknown, state: ConfirmationContext['state']): ConfirmationContext | undefined {
  const data = readStrictData(payload)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  if (Object.keys(data).some((key) => !CONFIRMATION_KEYS.has(key)) || Object.keys(data).length !== CONFIRMATION_KEYS.size) return undefined
  const context = data as Partial<ConfirmationContext>
  return typeof context.confirmationId === 'string'
    && context.confirmationId.length > 0
    && context.state === state
    && typeof context.actor === 'string'
    && context.actor.length > 0
    && context.role === 'ADMIN'
    && typeof context.createdAt === 'string'
    && isRfc3339DateTime(context.createdAt)
    && typeof context.expiresAt === 'string'
    && isRfc3339DateTime(context.expiresAt)
    ? context as ConfirmationContext
    : undefined
}

function readExportStatus(payload: unknown): ExportStatus | undefined {
  const data = readStrictData(payload)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  if (Object.keys(data).some((key) => !EXPORT_STATUS_KEYS.has(key)) || Object.keys(data).length !== EXPORT_STATUS_KEYS.size) return undefined
  const status = data as Partial<ExportStatus>
  return typeof status.objectId === 'string'
    && status.objectId.length > 0
    && status.generated === false
    && (status.classification === 'INTERNAL' || status.classification === 'LEVEL_II' || status.classification === 'LEVEL_III')
    && typeof status.watermark === 'string'
    && typeof status.verifiedAt === 'string'
    && isRfc3339DateTime(status.verifiedAt)
    ? status as ExportStatus
    : undefined
}

export const useAdminStore = defineStore('admin', {
  state: () => ({
    users: initialUsers(),
    panelState: 'SUCCESS' as CapabilityState,
    resultCode: 'READY',
    resultMessage: '用户列表已就绪。',
    auditRecords: [] as AuditRecord[],
    auditFilters: {} as AuditFilters,
    auditState: 'EMPTY' as CapabilityState,
    auditResultCode: 'EMPTY',
    auditResultMessage: '暂无审计记录。',
    auditConfirmation: null as ConfirmationContext | null,
    auditExportFilters: {} as AuditFilters,
    auditExportStatus: null as ExportStatus | null,
  }),

  actions: {
    /**
     * 将请求或合同校验异常转换为统一的面板错误状态。
     * @param error 捕获到的异常或服务端失败响应。
     * @param fallback 无法从异常中读取消息时使用的中文提示。
     * @returns 无返回值。
     * @sideEffects 将面板状态设为 `ERROR`，并更新结果代码和结果消息。
     */
    showPanelError(error: unknown, fallback: string): void {
      const failure = error as ApiFailure
      this.panelState = 'ERROR'
      this.resultCode = error instanceof InvalidResponseError
        ? 'INVALID_RESPONSE'
        : failure.error?.code ?? 'NETWORK_ERROR'
      this.resultMessage = failure.error?.message ?? (error instanceof Error ? error.message : fallback)
    },

    /**
     * 从本机开发服务刷新用户列表，并在写入前校验完整响应合同。
     * @returns 刷新流程结束后兑现且不返回值的 Promise。
     * @sideEffects 依次更新面板状态；成功时替换用户列表，失败时保留原列表并记录错误。
     */
    async refreshUsers(): Promise<void> {
      this.panelState = 'LOADING'
      try {
        const auth = useAuthStore()
        // 该内部请求头仅传递角色提示，服务端仍独立执行权限校验。
        const response = await fetch(`${resolveMockOrigin()}/api/v1/admin/users`, {
          headers: { 'X-Demo-Role': auth.role },
        })
        this.panelState = 'VALIDATING'
        const payload: unknown = await response.json().catch(() => undefined)
        if (!response.ok) throw readFailure(payload) ?? new InvalidResponseError()
        const data = readUsers(payload)
        if (data === undefined) throw new InvalidResponseError()

        this.users = data
        this.panelState = data.length === 0 ? 'EMPTY' : 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = '用户列表已刷新。'
      } catch (error) {
        this.showPanelError(error, '用户刷新失败。')
      }
    },

    /**
     * 向本机开发服务提交用户创建、更新、启停或删除命令，并校验返回对象。
     * @param user 当前操作定位使用的用户。
     * @param operation 冻结合同定义的用户操作类型。
     * @param next 非删除操作提交的目标用户数据；删除操作仍传入当前用户以保持合同形状。
     * @returns 操作成功时为 `true`，请求失败或响应无效时为 `false`。
     * @sideEffects 更新六态面板状态和结果信息；成功时增补、替换或移除用户，失败时保留原列表。
     */
    async mutateUser(user: User, operation: UserRoleCommand['operation'], next: User): Promise<boolean> {
      this.panelState = 'LOADING'
      await Promise.resolve()
      this.panelState = 'VALIDATING'
      const command: UserRoleCommand = { operation, user: next }

      try {
        await Promise.resolve()
        this.panelState = 'EXECUTING'
        const auth = useAuthStore()
        const collectionUrl = `${resolveMockOrigin()}/api/v1/admin/users`
        const memberUrl = `${collectionUrl}/${encodeURIComponent(user.userId)}`
        const method = operation === 'CREATE' ? 'POST' : operation === 'DELETE' ? 'DELETE' : 'PUT'
        const response = await fetch(operation === 'CREATE' ? collectionUrl : memberUrl, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Demo-Role': auth.role,
          },
          ...(operation === 'DELETE' ? {} : { body: JSON.stringify(command) }),
        })
        this.panelState = 'VALIDATING'
        const payload: unknown = await response.json().catch(() => undefined)
        if (!response.ok) throw readFailure(payload) ?? new InvalidResponseError()

        if (operation === 'DELETE') {
          const deleted = readDeleteResult(payload)
          if (deleted === undefined || !deleted.deleted || deleted.objectId !== user.userId) {
            throw new InvalidResponseError()
          }
          this.users = this.users.filter((candidate) => candidate.userId !== deleted.objectId)
        } else {
          const updated = readUser(payload)
          if (updated === undefined) throw new InvalidResponseError()
          this.users = operation === 'CREATE'
            ? [...this.users, updated]
            : this.users.map((candidate) => candidate.userId === updated.userId ? updated : candidate)
        }
        this.panelState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        const operationLabel: Record<UserRoleCommand['operation'], string> = {
          CREATE: '创建',
          UPDATE: '更新',
          ENABLE: '启用',
          DISABLE: '禁用',
          DELETE: '删除',
        }
        this.resultMessage = `用户 ${user.username} 已${operationLabel[operation]}。`
        return true
      } catch (error) {
        this.showPanelError(error, '用户变更失败。')
        return false
      }
    },

    /**
     * 校验创建表单并通过统一用户变更流程创建用户。
     * @param usernameInput 用户输入的用户名，提交前会移除首尾空白。
     * @param role 冻结合同定义的用户角色。
     * @param status 冻结合同定义的账号状态。
     * @returns 创建成功时为 `true`，本地校验或服务端处理失败时为 `false`。
     * @sideEffects 更新面板状态与结果信息；服务端创建成功时向用户列表追加新用户。
     */
    async createUser(usernameInput: string, role: Role, status: User['status']): Promise<boolean> {
      const username = usernameInput.trim()
      this.panelState = 'VALIDATING'
      if (username.length === 0) {
        this.panelState = 'ERROR'
        this.resultCode = 'VALIDATION_FAILED'
        this.resultMessage = '用户名：请输入用户名。'
        return false
      }

      const user: User = {
        userId: `USR-${username}`,
        username,
        role,
        status,
      }
      return this.mutateUser(user, 'CREATE', user)
    },

    /** Loads immutable audit records using the closed administrator filter contract. */
    async loadAudit(filters: AuditFilters = {}): Promise<boolean> {
      this.auditState = 'LOADING'
      await Promise.resolve()
      this.auditState = 'VALIDATING'
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== '') query.set(key, value)
      }
      try {
        await Promise.resolve()
        this.auditState = 'EXECUTING'
        const response = await fetch(`${resolveMockOrigin()}/api/v1/admin/audit${query.size === 0 ? '' : `?${query}`}`, {
          headers: { 'X-Demo-Role': useAuthStore().role },
        })
        this.auditState = 'VALIDATING'
        const payload: unknown = await response.json().catch(() => undefined)
        if (!response.ok) throw readFailure(payload) ?? new InvalidAuditResponseError()
        const records = readAuditRecords(payload)
        if (records === undefined) throw new InvalidAuditResponseError()
        this.auditRecords = records
        this.auditFilters = { ...filters }
        this.auditState = records.length === 0 ? 'EMPTY' : 'SUCCESS'
        this.auditResultCode = 'SUCCESS'
        this.auditResultMessage = records.length === 0 ? '没有符合条件的审计记录。' : `已加载 ${records.length} 条审计记录。`
        return true
      } catch (error) {
        this.auditRecords = []
        this.showAuditError(error, '审计日志加载失败。')
        return false
      }
    },

    /** Creates an AUDIT_EXPORT confirmation for the currently displayed filter values. */
    async exportAudit(filters: AuditFilters = {}): Promise<boolean> {
      this.auditState = 'EXECUTING'
      this.auditConfirmation = null
      this.auditExportFilters = { ...filters }
      this.auditExportStatus = null
      try {
        const headers = { 'Content-Type': 'application/json', 'X-Demo-Role': useAuthStore().role }
        const createdResponse = await fetch(`${resolveMockOrigin()}/api/v1/confirmations`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ action: 'AUDIT_EXPORT', objectId: 'AUDIT-LOG' }),
        })
        this.auditState = 'VALIDATING'
        const createdPayload: unknown = await createdResponse.json().catch(() => undefined)
        if (!createdResponse.ok) throw readFailure(createdPayload) ?? new InvalidAuditResponseError()
        const created = readConfirmation(createdPayload, 'AWAITING_CONFIRMATION')
        if (created === undefined) throw new InvalidAuditResponseError()
        this.auditConfirmation = created
        this.auditState = 'SUCCESS'
        this.auditResultCode = 'CONFIRMATION_REQUIRED'
        this.auditResultMessage = '请确认当前筛选条件后导出审计日志。'
        return true
      } catch (error) {
        this.auditConfirmation = null
        this.auditExportFilters = {}
        this.showAuditError(error, '审计日志导出申请失败。')
        return false
      }
    },

    /** Confirms the pending AUDIT_EXPORT request and consumes it exactly once. */
    async confirmAuditExport(): Promise<boolean> {
      const created = this.auditConfirmation
      if (created === null || created.state !== 'AWAITING_CONFIRMATION') return false
      this.auditState = 'EXECUTING'
      try {
        const headers = { 'Content-Type': 'application/json', 'X-Demo-Role': useAuthStore().role }
        const confirmedResponse = await fetch(`${resolveMockOrigin()}/api/v1/confirmations/${encodeURIComponent(created.confirmationId)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ confirm: true }),
        })
        this.auditState = 'VALIDATING'
        const confirmedPayload: unknown = await confirmedResponse.json().catch(() => undefined)
        if (!confirmedResponse.ok) throw readFailure(confirmedPayload) ?? new InvalidAuditResponseError()
        const confirmed = readConfirmation(confirmedPayload, 'CONFIRMED')
        if (confirmed === undefined) throw new InvalidAuditResponseError()
        this.auditConfirmation = confirmed

        this.auditState = 'EXECUTING'
        const exportResponse = await fetch(`${resolveMockOrigin()}/api/v1/admin/audit/export`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...this.auditExportFilters, export: true, confirmationId: confirmed.confirmationId }),
        })
        this.auditState = 'VALIDATING'
        const exportPayload: unknown = await exportResponse.json().catch(() => undefined)
        if (!exportResponse.ok) throw readFailure(exportPayload) ?? new InvalidAuditResponseError()
        const status = readExportStatus(exportPayload)
        if (status === undefined || status.objectId !== 'AUDIT-LOG') throw new InvalidAuditResponseError()
        this.auditExportStatus = status
        this.auditConfirmation = null
        this.auditExportFilters = {}
        this.auditState = 'SUCCESS'
        this.auditResultCode = 'SUCCESS'
        this.auditResultMessage = '审计日志导出验证通过，未生成文件。'
        return true
      } catch (error) {
        this.auditConfirmation = null
        this.auditExportFilters = {}
        this.auditExportStatus = null
        this.showAuditError(error, '审计日志导出失败。')
        return false
      }
    },

    /** Cancels a pending audit export without consuming its confirmation context. */
    cancelAuditExport(): void {
      this.auditConfirmation = null
      this.auditExportFilters = {}
      this.auditState = this.auditRecords.length === 0 ? 'EMPTY' : 'SUCCESS'
      this.auditResultCode = 'CANCELLED'
      this.auditResultMessage = '已取消审计日志导出。'
    },

    /** Converts audit request or contract failures into a stable safe error projection. */
    showAuditError(error: unknown, fallback: string): void {
      const failure = error as ApiFailure
      this.auditState = 'ERROR'
      this.auditResultCode = error instanceof InvalidAuditResponseError
        ? 'INVALID_RESPONSE'
        : failure.error?.code ?? 'NETWORK_ERROR'
      this.auditResultMessage = failure.error?.message ?? (error instanceof Error ? error.message : fallback)
    },

    /**
     * 清空用户列表并恢复安全的空状态。
     * @returns 无返回值。
     * @sideEffects 清空用户列表，并将面板状态、结果代码和消息重置为空态。
     */
    resetToSafeEmpty(): void {
      this.users = []
      this.panelState = 'EMPTY'
      this.resultCode = 'EMPTY'
      this.resultMessage = '用户列表已清空。'
      this.auditRecords = []
      this.auditState = 'EMPTY'
      this.auditResultCode = 'EMPTY'
      this.auditResultMessage = '暂无审计记录。'
      this.auditConfirmation = null
      this.auditExportFilters = {}
      this.auditExportStatus = null
    },
  },
})

import { createServer, type Server as HttpServer } from 'node:http'
import express, { type NextFunction, type Request, type Response, type RequestHandler } from 'express'
import { portParameterTargets } from '../src/features/scenarios/port-parameter-source.js'
import type {
  AuditRequest,
  AuditRecord,
  AuditDeleteRequest,
  AuditDeleteResult,
  AccessControlConfig,
  Principal,
  Permission,
  ConfirmationAction,
  ExportStatus,
  LoginRequest,
  PageMeta,
  PreflightRequest,
  Report,
  ReportExportRequest,
  LocalReportFilter,
  ReportExportResult,
  ResetRequest,
  ResetResult,
  Role,
  ScriptPreviewRequest,
  ScriptContract,
  ScenarioDraft,
  QualityDataset,
  QualityScope,
  TaskPhase,
  TaskId,
  SimulationRun,
  User,
  UserRoleCommand,
} from '../src/contracts/domain-models.js'
import {
  AuthProjection,
  isManagedUsername,
  type ProjectionFailure,
  type ProjectionResult,
} from './auth/projection.js'
import { failure, success } from './http/envelope.js'
import { assertLoopbackRequest, assertLanRequest, validatePublicOrigin } from './http/loopback.js'
import { ScenarioProjection, type ScenarioStorage } from './scenarios/projection.js'
import { createMemoryParameterSourceCoordinator, parameterCatalog } from './scenarios/parameter-sources.js'
import { type SimulationProjectionResult } from './simulations/projection.js'
import { SimulationRegistry } from './simulations/registry.js'
import type { MissionExecution, MissionOutcome, MissionProcess, MissionRuntimeControl } from './simulations/mission-execution.js'
import { ScriptProjection } from './scripts/projection.js'
import { MissionGenerationError } from './scripts/mission-generator.js'
import { MockProjection } from './state/projection.js'
import { ConfirmationProjection, type ConfirmationClock } from './confirmations/projection.js'
import { TemplateProjection, type TemplateStorage } from './templates/projection.js'
import { attachRealtimeServer, type RealtimeController } from './ws/realtime.js'
import type { RealtimeJournalStore } from './ws/realtime-journal.js'
import { inspectScenarioConfig } from '../src/features/scenarios/scenario-validation.js'
import { scenarioSnapshotId } from '../src/features/scenarios/scenario-snapshot.js'
import { ReplayProjection, type ReplayResult } from './replays/projection.js'
import { AdminProjection, type AdminResult, type BackupStorage, type EquipmentStorage, type MasterDataStorage } from './admin/projection.js'
import { isBackupPlan } from '../src/features/admin/backup-plan.js'
import { isAdminText, isMasterReference } from '../src/features/admin/admin-contract.js'
import { isEquipmentReference } from '../src/features/admin/equipment-contract.js'
import { equipmentTypeIssue } from '../src/features/admin/equipment-link-rules.js'
import { isAccessControlConfig } from '../src/features/admin/access-control.js'
import type { InitialNodeSnapshot } from '../src/features/situation/initial-nodes.js'
import type { LocalMonitorSnapshot } from '../src/features/data-exchange/local-monitor.js'
import type { PositionSnapshot } from '../src/features/situation/position-updates.js'
import type { LocalReplaySnapshot } from '../src/features/replays/local-replay.js'
import type { LocalReportExportResult } from '../src/contracts/domain-models.js'
import { isLocalReport, isLocalReportExport, parseLocalReportFilter } from '../src/features/reports/local-report.js'
import type { AuthSqliteStorage } from './local/auth-sqlite.js'
import { buildAuditExport } from './auth/audit-export.js'
import type { LocalArchiveStorage } from './local/archive-sqlite.js'
import { isLocalArchiveId } from '../src/features/admin/local-archive.js'
import { isMissionResultId, type MissionResultParameterComparison, type MissionResultRecord, type MissionResultSnapshot } from '../src/features/results/mission-result.js'
import type { MissionResults } from './local/mission-results.js'
import type { RunQualityStore } from './local/run-quality.js'
import { QualityImportError } from '../src/features/data-exchange/quality-records.js'
import { attachQualityReport, baseQualityReportId, qualityReportSha256 } from '../src/features/reports/quality-report.js'

export interface MockServerOptions {
  port?: number
  /** 只有真实账号库入口可以启用内网部署；未配置时保持本机 Mock 边界。 */
  publicOrigin?: string
  host?: string
  site?: RequestHandler
  confirmationClock?: ConfirmationClock
  /** 仅由本机启动入口注入；纯 Mock 默认不访问文件系统。 */
  loadInitialNodes?: () => Promise<InitialNodeSnapshot>
  /** 本机追加位置读取器；纯 Mock 不配置、不访问真实文件。 */
  loadPositions?: () => Promise<PositionSnapshot>
  /** 读取本机真实文件回放快照，与 Mock 回放及实时位置游标隔离。 */
  loadLocalReplay?: () => Promise<LocalReplaySnapshot>
  /** 存在此入口即为真实报告模式；无文件或失败不能回退 Mock。 */
  loadLocalReport?: () => Promise<Report | null>
  exportLocalReport?: (report: Report, format: 'HTML' | 'PDF' | 'CSV', actor: string, source?: MissionResultRecord, comparisons?: MissionResultParameterComparison[], filter?: LocalReportFilter) => Promise<LocalReportExportResult>
  missionResults?: MissionResults
  /** 规范质量文件的持久接入，缺省不访问文件系统。 */
  runQualityStore?: RunQualityStore
  /** 可选本机场景存储；纯 Mock 不导入 SQLite，也不触碰磁盘。连接由调用方管理。 */
  scenarioStorage?: ScenarioStorage
  templateStorage?: TemplateStorage
  authStorage?: AuthSqliteStorage
  backupStorage?: BackupStorage
  equipmentStorage?: EquipmentStorage
  /** 本机独立通用数据存储；纯 Mock 继续使用冻结只读夹具。 */
  masterDataStorage?: MasterDataStorage
  archiveStorage?: LocalArchiveStorage
  accessControlStorage?: { load(): AccessControlConfig; save(config: AccessControlConfig, expected: number): boolean }
  loadExchangeMonitor?: () => LocalMonitorSnapshot
  /** 本机 TXT 落盘；纯 Mock 不写入文件，也不返回虚构路径。 */
  writeScriptText?: (script: ScriptContract, revision: number, draft: ScenarioDraft) => Promise<string>
  /** 仅本机入口执行生成包；纯 Mock 继续使用确定性控制投影。 */
  missionExecution?: MissionExecution
  /** 本地入口注入磁盘日志；纯Mock继续只使用有界内存，不导入文件能力。 */
  realtimeJournal?: RealtimeJournalStore
  /** 本地用UUID避免重启复用运行身份；纯Mock保留原确定性编号。 */
  createRunId?: () => SimulationRun['runId']
}

export interface MockServer {
  httpServer: HttpServer
  projection: MockProjection
  /**
   * Returns a detached copy of authentication audit records.
   *
   * @returns Deep-cloned audit records safe for caller mutation.
   * @remarks Reads authentication state without mutating it.
   */
  auditSnapshot(): AuditRecord[]
  /**
   * Closes realtime and HTTP listeners idempotently.
   *
   * @returns The shared promise that settles when both listeners have closed.
   * @remarks Initiates listener shutdown only on the first call.
   */
  close(): Promise<void>
}

const P1_GENERATED_AT = '2026-08-06T08:00:00Z' as const
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/**
 * Computes the valid day count for a calendar month using Gregorian leap-year rules.
 *
 * @param year - Four-digit year parsed from an RFC 3339 timestamp.
 * @param month - One-based month number.
 * @returns The month's day count, or -1 for an out-of-range non-February month.
 * @remarks This pure calculation uses no system clock and mutates no server state.
 */
function daysInMonth(year: number, month: number): number {
  if (month !== 2) {
    return MONTH_LENGTHS[month - 1] ?? -1
  }

  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  return isLeapYear ? 29 : 28
}

/**
 * Validates RFC 3339 date-time syntax and real Gregorian calendar dates.
 *
 * @param value - Candidate timestamp supplied in a user contract.
 * @returns Whether the value satisfies both the accepted syntax and calendar ranges.
 * @remarks This pure validator uses arithmetic only and performs no I/O or state mutation.
 */
function isRfc3339DateTime(value: string): boolean {
  // Mirrors the client-side closed validator. Hour/minute/second/offset ranges are bounded
  // by the shape regex; the calendar day is checked against the real month length via pure
  // arithmetic (the no-side-effect gate forbids system time APIs), so impossible values
  // such as 2026-02-30 are rejected instead of rolled forward.
  const match = RFC3339_DATE_TIME.exec(value)
  if (match === null) return false

  const [, yearText, monthText, dayText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  if (month < 1 || month > 12) return false

  return day >= 1 && day <= daysInMonth(year, month)
}

/** Converts a validated RFC 3339 timestamp to a timezone-neutral sortable scalar. */
function rfc3339Scalar(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (match === null) return Number.NaN
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const priorYear = year - 1
  let days = priorYear * 365 + Math.floor(priorYear / 4) - Math.floor(priorYear / 100) + Math.floor(priorYear / 400)
  for (let currentMonth = 1; currentMonth < month; currentMonth += 1) days += daysInMonth(year, currentMonth)
  days += day - 1
  const offset = match[8]?.toUpperCase() === 'Z'
    ? 0
    : (match[9] === '-' ? -1 : 1) * (Number(match[10]) * 60 + Number(match[11]))
  return days * 86_400
    + Number(match[4]) * 3_600
    + (Number(match[5]) - offset) * 60
    + Number(match[6])
    + Number(`0.${match[7] ?? '0'}`)
}

/**
 * Builds deterministic pagination metadata for P1 HTTP envelopes.
 *
 * @param requestId - Stable request identifier assigned by the route adapter.
 * @param total - Total result count represented by the response.
 * @param pageSize - Page size represented by the response.
 * @returns A first-page metadata object with the frozen generated timestamp.
 * @remarks This pure factory performs no response writes or state mutation.
 */
function pageMeta(requestId: string, total = 1, pageSize = 1): PageMeta {
  return { requestId, generatedAt: P1_GENERATED_AT, page: 1, pageSize, total }
}

/**
 * Reads the closed development role hint from an HTTP request.
 *
 * @param req - Express request containing the internal role header.
 * @returns ADMIN or OPERATOR when valid, otherwise undefined.
 * @remarks Reads request headers only; it does not authorize, audit, or write a response.
 */
function readDemoRole(req: Request): Role | undefined {
  const value = req.get('X-Demo-Role')
  return value === 'ADMIN' || value === 'OPERATOR' ? value : undefined
}

/** Returns the deterministic principal name represented by a validated role hint. */
const authenticatedUsers = new WeakMap<Request, User>()
function actorForRequest(req: Request, role: Role): string {
  return authenticatedUsers.get(req)?.username ?? (role === 'ADMIN' ? 'admin' : 'operator')
}
function confirmationOwner(req: Request): { id: string; name: string } | undefined {
  const user = authenticatedUsers.get(req)
  return user ? { id: user.userId, name: user.username } : undefined
}

/**
 * Validates the closed reset confirmation body.
 *
 * @param value - Unknown JSON request body.
 * @returns Whether the body contains only `confirm: true`.
 * @remarks This pure validator performs no I/O or state mutation.
 */
function isResetRequest(value: unknown): value is ResetRequest {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as Record<string, unknown>).confirm === true
}

const CONFIRMATION_ACTIONS = new Set<ConfirmationAction>([
  'SCENARIO_WARNING_CONTINUE',
  'OFFICIAL_TEMPLATE_DELETE',
  'SIMULATION_STOP',
  'BACKUP_RESTORE',
  'FULL_CONFIG_EXPORT',
  'AUDIT_EXPORT',
  'MASTER_DATA_DELETE',
])

/**
 * Validates an object against exact required and optional key sets.
 *
 * @param value - Candidate JSON value.
 * @param required - Keys that must all be present.
 * @param optional - Additional keys permitted by the closed shape.
 * @returns Whether the value is a non-array object with exactly the allowed key vocabulary.
 * @remarks This pure shape validator does not inspect field values or mutate inputs.
 */
function isStrictObject(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const keys = Object.keys(value)
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key))
}

/**
 * 校验二次确认创建请求。
 * @param value 未受信任的请求体。
 * @returns 动作和对象编号满足闭合合同时返回 `true`。
 * @remarks 只校验结构，不创建确认上下文。
 */
function isConfirmationRequest(value: unknown): value is { action: ConfirmationAction; objectId: string } {
  return isStrictObject(value, ['action', 'objectId'])
    && typeof value.action === 'string'
    && CONFIRMATION_ACTIONS.has(value.action as ConfirmationAction)
    && typeof value.objectId === 'string'
    && value.objectId.length > 0
}

/** 校验只允许 `confirm: true` 的确认决定请求。 */
function isConfirmRequest(value: unknown): value is { confirm: true } {
  return isStrictObject(value, ['confirm']) && value.confirm === true
}

/** 校验模板复制请求中的非空名称。 */
function isCopyTemplateRequest(value: unknown): value is { name: string; scenarioId?: string } {
  return isStrictObject(value, ['name'], ['scenarioId'])
    && typeof value.name === 'string'
    && value.name.trim().length > 0
    && (value.scenarioId === undefined || (typeof value.scenarioId === 'string' && value.scenarioId.startsWith('SCN-')))
}

/** 校验脚本预览请求中的场景编号和可选警告确认编号。 */
function isScriptPreviewRequest(value: unknown): value is ScriptPreviewRequest {
  return isStrictObject(value, ['scenarioId'], ['warningConfirmationId'])
    && typeof value.scenarioId === 'string'
    && value.scenarioId.startsWith('SCN-')
    && (value.warningConfirmationId === undefined
      || (typeof value.warningConfirmationId === 'string' && value.warningConfirmationId.length > 0))
}

/** 校验脚本预检请求中的非空校验和。 */
function isPreflightRequest(value: unknown): value is PreflightRequest {
  return isStrictObject(value, ['checksum'])
    && typeof value.checksum === 'string'
    && value.checksum.length > 0
}

/** 校验报表导出请求的闭合字段、格式和路径编号一致性。 */
function isReportExportRequest(value: unknown, reportId: string): value is ReportExportRequest {
  return isStrictObject(value, ['reportId', 'format'], ['confirmationId', 'filter', 'qualitySha256'])
    && value.reportId === reportId
    && (value.format === 'HTML' || value.format === 'PDF' || value.format === 'CSV')
    && (value.confirmationId === undefined
      || (typeof value.confirmationId === 'string' && value.confirmationId.length > 0))
    && (value.filter === undefined || parseLocalReportFilter(value.filter) !== null)
    && (value.qualitySha256 === undefined || (typeof value.qualitySha256 === 'string' && /^[a-f0-9]{64}$/.test(value.qualitySha256)))
}

const AUDIT_RESULTS = new Set<AuditRecord['result']>(['SUCCESS', 'DENIED', 'ERROR'])

/** Validates the shared audit filters and their closed field vocabulary. */
function isAuditRequest(value: unknown, exportRequest = false): value is AuditRequest {
  const optional = ['from', 'to', 'actor', 'role', 'module', 'action', 'result']
  if (!isStrictObject(value, exportRequest ? ['export'] : [], exportRequest
    ? [...optional, 'confirmationId']
    : optional)) return false
  const request = value as AuditRequest
  if (exportRequest && request.export !== true) return false
  if (request.from !== undefined && (typeof request.from !== 'string' || !isRfc3339DateTime(request.from))) return false
  if (request.to !== undefined && (typeof request.to !== 'string' || !isRfc3339DateTime(request.to))) return false
  if (request.from !== undefined && request.to !== undefined && rfc3339Scalar(request.from) > rfc3339Scalar(request.to)) return false
  if (request.actor !== undefined && (typeof request.actor !== 'string' || request.actor.length === 0)) return false
  if (request.role !== undefined && request.role !== 'ADMIN' && request.role !== 'OPERATOR') return false
  if (request.module !== undefined && (typeof request.module !== 'string' || request.module.length === 0)) return false
  if (request.action !== undefined && (typeof request.action !== 'string' || request.action.length === 0)) return false
  if (request.result !== undefined && !AUDIT_RESULTS.has(request.result)) return false
  return request.confirmationId === undefined
    || (typeof request.confirmationId === 'string' && request.confirmationId.length > 0)
}

function isAuditDeleteRequest(value: unknown): value is AuditDeleteRequest {
  return isStrictObject(value, ['auditIds']) && Array.isArray(value.auditIds)
    && value.auditIds.length >= 1 && value.auditIds.length <= 100
    && value.auditIds.every(id => typeof id === 'string' && id.trim().length > 0)
    && new Set(value.auditIds).size === value.auditIds.length
}

/** Projects a query string into the closed audit filter contract. */
interface AuditListQuery {
  filters: AuditRequest
  page: number
  pageSize: number
  sortOrder: 'asc' | 'desc'
}

function auditRequestFromQuery(req: Request): AuditListQuery | undefined {
  const allowed = ['from', 'to', 'actor', 'role', 'module', 'action', 'result', 'page', 'pageSize', 'sortOrder']
  if (Object.keys(req.query).some(key => !allowed.includes(key))) return undefined
  const request: Record<string, unknown> = {}
  for (const key of ['from', 'to', 'actor', 'role', 'module', 'action', 'result'] as const) {
    if (req.query[key] !== undefined) request[key] = req.query[key]
  }
  const page = req.query.page === undefined ? 1 : Number(req.query.page)
  const pageSize = req.query.pageSize === undefined ? 20 : Number(req.query.pageSize)
  const sortOrder = req.query.sortOrder === undefined ? 'desc' : req.query.sortOrder
  if (!isAuditRequest(request)
    || typeof req.query.page === 'object' || typeof req.query.pageSize === 'object'
    || !Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    || (sortOrder !== 'asc' && sortOrder !== 'desc')) return undefined
  return { filters: request, page, pageSize, sortOrder }
}

/** Applies the exact audit filters without mutating the append-only projection. */
function filterAudit(records: AuditRecord[], filters: AuditRequest): AuditRecord[] {
  const from = filters.from === undefined ? undefined : rfc3339Scalar(filters.from)
  const to = filters.to === undefined ? undefined : rfc3339Scalar(filters.to)
  return records.filter((record) => {
    const occurredAt = rfc3339Scalar(record.occurredAt)
    return (from === undefined || occurredAt >= from)
      && (to === undefined || occurredAt <= to)
      && (filters.actor === undefined || record.actor === filters.actor)
      && (filters.role === undefined || record.role === filters.role)
      && (filters.module === undefined || record.module === filters.module)
      && (filters.action === undefined || record.action === filters.action)
      && (filters.result === undefined || record.result === filters.result)
  })
}

/** Orders by absolute RFC 3339 time and uses the immutable ID to break timestamp ties. */
function sortAudit(records: AuditRecord[], sortOrder: 'asc' | 'desc'): AuditRecord[] {
  const direction = sortOrder === 'asc' ? 1 : -1
  return [...records].sort((left, right) => {
    const byTime = rfc3339Scalar(left.occurredAt) - rfc3339Scalar(right.occurredAt)
    return byTime === 0 ? direction * left.auditId.localeCompare(right.auditId) : direction * byTime
  })
}

/**
 * Validates the closed username/password-fixture login transport shape.
 *
 * @param value - Unknown login request body.
 * @returns Whether both exact wire fields exist and contain strings.
 * @remarks This pure boundary validator does not authenticate or mutate state.
 */
function isLoginShape(value: unknown): value is Record<'username' | 'passwordFixture', string> {
  return isStrictObject(value, ['username', 'passwordFixture'])
    && typeof value.username === 'string'
    && typeof value.passwordFixture === 'string' && value.passwordFixture.length > 0 && value.passwordFixture.length <= 128
    && value.username.trim().length > 0 && value.username.length <= 64
}

/**
 * Validates the closed User schema used by user-management commands.
 *
 * @param value - Unknown user value from an HTTP request.
 * @returns Whether required fields, role/status literals, and optional timestamp are valid.
 * @remarks This pure boundary validator performs no audit, response write, or state mutation.
 */
function isUser(value: unknown): value is User {
  return isStrictObject(value, ['userId', 'username', 'role', 'status'], ['lastLoginAt'])
    && typeof value.userId === 'string'
    && value.userId.length > 0
    && typeof value.username === 'string'
    && (value.role === 'ADMIN' || value.role === 'OPERATOR')
    && (value.status === 'ACTIVE' || value.status === 'DISABLED' || value.status === 'LOCKED')
    && (value.lastLoginAt === undefined
      || (typeof value.lastLoginAt === 'string' && isRfc3339DateTime(value.lastLoginAt)))
}

/**
 * Validates a closed user-role command and its nested user.
 *
 * @param value - Unknown command body from a user-management request.
 * @returns Whether operation, user, and optional confirmation identifier satisfy the contract.
 * @remarks This pure validator does not authorize the command or mutate projection state.
 */
function isUserRoleCommand(value: unknown): value is UserRoleCommand {
  return isStrictObject(value, ['operation', 'user'], ['confirmationId', 'password'])
    && (value.password === undefined || (value.operation === 'CREATE' && typeof value.password === 'string' && value.password.trim().length > 0 && value.password.length >= 6 && value.password.length <= 32))
    && (
      value.operation === 'CREATE'
      || value.operation === 'UPDATE'
      || value.operation === 'DELETE'
      || value.operation === 'ENABLE'
      || value.operation === 'DISABLE'
    )
    && isUser(value.user)
    && (value.confirmationId === undefined
      || (typeof value.confirmationId === 'string' && value.confirmationId.length > 0))
}

/**
 * Converts a projection failure into the canonical HTTP error envelope.
 *
 * @param res - Express response used to emit the failure.
 * @param result - Projection success/failure union returned by domain logic.
 * @param requestId - Stable identifier included in response metadata.
 * @returns Whether the result was a failure and a response was sent.
 * @remarks On failure, writes the configured HTTP status and JSON envelope exactly once; on
 * success, leaves the response untouched for the caller to serialize.
 */
function sendProjectionFailure<T>(
  res: Response,
  result: ProjectionResult<T>,
  requestId: string,
): result is ProjectionFailure {
  if (result.ok) {
    return false
  }

  res.status(result.status).json(failure(result.code, result.status, {
    requestId,
    generatedAt: P1_GENERATED_AT,
    ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
  }))
  return true
}

/**
 * 将仿真投影错误转换为统一 API 失败信封。
 * @param res 接收错误状态和信封的 Express 响应。
 * @param result 仿真投影返回的成功或失败结果。
 * @param requestId 当前仿真操作的固定请求编号。
 * @returns 失败并已写出响应时返回 `true`，成功时返回 `false`。
 * @remarks 只在失败分支写响应，不修改仿真或场景投影。
 */
function sendSimulationFailure<T>(
  res: Response,
  result: SimulationProjectionResult<T>,
  requestId: string,
): result is Extract<SimulationProjectionResult<T>, { ok: false }> {
  if (result.ok) return false
  res.status(result.status).json(failure(result.code, result.status, {
    requestId,
    generatedAt: P1_GENERATED_AT,
    message: result.message,
    ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
  }))
  return true
}

/** 将回放投影错误转换为统一 API 失败信封。 */
function sendReplayFailure<T>(
  res: Response,
  result: ReplayResult<T>,
  requestId: string,
): result is Extract<ReplayResult<T>, { ok: false }> {
  if (result.ok) return false
  res.status(result.status).json(failure(result.code, result.status, {
    requestId,
    generatedAt: P1_GENERATED_AT,
    message: result.message,
    ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
  }))
  return true
}

/**
 * Requires a valid internal role hint and records malformed/missing hints as denied.
 *
 * @param req - Express request containing the role header.
 * @param res - Express response used for a denial envelope.
 * @param auth - Authentication projection that owns audit records.
 * @param action - Stable action name associated with the request.
 * @param objectId - Optional affected object identifier.
 * @returns The validated role, or undefined after denying the request.
 * @remarks Invalid input appends a DENIED audit record and sends a 403 response.
 */
function requireDemoRole(
  req: Request,
  res: Response,
  auth: AuthProjection,
  action: string,
  objectId?: string,
): Role | undefined {
  const role = readDemoRole(req)
  if (role !== undefined) {
    return role
  }

  auth.recordDenied(req.get('X-Demo-Role') ?? 'anonymous', 'OPERATOR', action, objectId)
  res.status(403).json(failure('PERMISSION_DENIED', 403, {
    requestId: `REQ-P1-${action}`,
    generatedAt: P1_GENERATED_AT,
  }))
  return undefined
}

/**
 * Enforces administrator-only access after validating the role hint.
 *
 * @param req - Express request evaluated for administrator access.
 * @param res - Express response used for denial envelopes.
 * @param auth - Authentication projection that owns audit records.
 * @param action - Stable action name associated with the request.
 * @param objectId - Optional affected object identifier.
 * @returns True only for ADMIN; false after any rejection response.
 * @remarks Missing/invalid or OPERATOR roles append a denial audit and send a 403 response.
 */
function requireAdmin(
  req: Request,
  res: Response,
  auth: AuthProjection,
  action: string,
  objectId?: string,
): boolean {
  const role = requireDemoRole(req, res, auth, action, objectId)
  if (role === undefined) {
    return false
  }
  if (role === 'OPERATOR') {
    auth.recordDenied(actorForRequest(req, role), role, action, objectId)
    res.status(403).json(failure('PERMISSION_DENIED', 403, {
      requestId: `REQ-P1-${action}`,
      generatedAt: P1_GENERATED_AT,
    }))
    return false
  }
  return true
}

/** 按确认动作授权角色；场景警告允许具备场景写权限的操作员继续。 */
function requireConfirmationPermission(
  req: Request,
  role: Role,
  action: ConfirmationAction,
  objectId: string,
  res: Response,
  auth: AuthProjection,
): boolean {
  const allowed = role === 'ADMIN'
    || (action === 'SCENARIO_WARNING_CONTINUE'
      && auth.permissionSet(role).permissions.includes('SCENARIO_DRAFT_WRITE'))
    || (action === 'SIMULATION_STOP'
      && auth.permissionSet(role).permissions.includes('SIMULATION_CONTROL'))
  if (allowed) return true

  auth.recordDenied(actorForRequest(req, role), role, 'CONFIRMATION_CREATE', objectId)
  res.status(403).json(failure('PERMISSION_DENIED', 403, {
    requestId: 'REQ-P2-CONFIRMATION-CREATE',
    generatedAt: P1_GENERATED_AT,
  }))
  return false
}

/**
 * Creates and starts the loopback-only HTTP and realtime development server.
 *
 * @param options - Optional listener configuration; port zero requests an ephemeral port.
 * @returns Server handles, deterministic projections, audit snapshots, and idempotent close API.
 * @throws RangeError when the configured port is outside the valid integer range.
 * @remarks Allocates fresh in-memory projections, registers HTTP/WS handlers, and starts listening
 * on 127.0.0.1; it does not create durable storage or bind a non-loopback interface.
 */
export function createMockServer(options: MockServerOptions = {}): MockServer {
  const port = options.port ?? 0
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('Mock server port must be an integer from 0 through 65535.')
  }

  const publicOrigin = options.publicOrigin === undefined ? undefined : validatePublicOrigin(options.publicOrigin)
  if (publicOrigin && !options.authStorage) throw new Error('内网部署必须使用真实账号数据库。')
  const projection = new MockProjection()
  const auth = new AuthProjection(options.authStorage)
  let admin!: AdminProjection
  const memoryParameterSources = !options.scenarioStorage && !options.equipmentStorage && !options.masterDataStorage
  const scenarios = new ScenarioProjection(options.scenarioStorage, memoryParameterSources ? createMemoryParameterSourceCoordinator({
    equipment: () => admin.listEquipment(),
    equipmentHistory: id => admin.equipmentDetails(id).history,
    masterData: () => admin.listMasterData(),
    masterHistory: id => admin.masterDataDetails(id).history,
    setEquipmentReference: (reference, remove) => admin.setEquipmentReference(reference, remove),
    addMasterReference: reference => {
      const result = admin.addMasterDataReference(reference)
      if (!result.ok) throw new Error(result.message)
    },
  }) : undefined)
  const simulations = new SimulationRegistry(scenarios, options.missionExecution?.maxParallelTasks ?? 1, options.createRunId)
  const missionSafety = (taskId?: string) => options.missionExecution?.safetyStatus?.(taskId) ?? null
  const unresolvedMission = missionSafety()
  if (unresolvedMission?.scenarioId) scenarios.setLocked(unresolvedMission.scenarioId, true)
  interface MissionSlot {
    taskId: string
    qualityDraft?: ScenarioDraft
    mission?: MissionProcess
    positions?: { runId: string; read: NonNullable<MissionProcess['readPositions']> }
    /** 本次运行的控制台日志读取入口与超时设置；进程结束后仍保留，供排查查看。 */
    consoleLog?: { runId: string; read: NonNullable<MissionProcess['readConsoleLog']>; timeoutMs?: number }
    starting?: Promise<MissionProcess>
    stopping: boolean
    controlling?: boolean
    completedWhileStopping?: MissionOutcome
  }
  const missions = new Map<string, MissionSlot>()
  const sameQualityScope = (left: QualityScope, right: QualityScope) => ['taskId', 'runId', 'scenarioId', 'revision', 'startedAt']
    .every(key => left[key as keyof QualityScope] === right[key as keyof QualityScope])
  const qualityContext = (runId: string) => {
    const result = simulations.get(runId)
    if (!result.ok || !result.data.startedAt) return null
    const saved = scenarios.get(result.data.scenarioId)
    const draft = missions.get(runId)?.qualityDraft ?? (!options.missionExecution && saved.ok ? saved.data : null)
    if (!draft || draft.config.scenario.id !== result.data.scenarioId) return null
    const scope: QualityScope = { taskId: result.data.taskId, runId, scenarioId: result.data.scenarioId,
      revision: draft.revision, startedAt: result.data.startedAt }
    return { scope, draft }
  }
  const reportWithQuality = async (report: Report, record?: MissionResultRecord, phases?: TaskPhase[], filter?: LocalReportFilter, requestedReportId?: string): Promise<Report> => {
    if (!options.runQualityStore || !record?.runId || !record.taskId) return report
    const sourceSha256 = requestedReportId === undefined ? undefined : qualityReportSha256(requestedReportId)
    const dataset = await options.runQualityStore.load(record.runId, sourceSha256)
    if (!dataset) {
      if (sourceSha256) throw new Error('QUALITY_VERSION_NOT_FOUND')
      return report
    }
    if (!sameQualityScope(dataset.scope, { taskId: record.taskId, runId: record.runId, scenarioId: record.scenarioId,
      revision: record.revision, startedAt: record.startedAt })) throw new Error('质量来源与运行结果版本不一致。')
    return attachQualityReport(report, dataset, filter, phases)
  }
  const hasMissions = () => [...missions.values()].some(slot => slot.mission || slot.starting)
  let closing = false
  const confirmations = new ConfirmationProjection(options.confirmationClock ?? (options.authStorage ? {
    now: () => options.authStorage!.time(),
    expiresAt: created => options.authStorage!.expiresAt(created),
  } : undefined))
  const templates = new TemplateProjection(options.templateStorage)
  const scripts = new ScriptProjection()
  const replays = new ReplayProjection()
  admin = new AdminProjection(options.backupStorage, options.equipmentStorage, options.masterDataStorage, scenarios)
  let accessControl: AccessControlConfig = { version: 1, profiles: [], assignments: [] }
  const readAccessControl = () => options.accessControlStorage?.load() ?? structuredClone(accessControl)
  class RetiredBatchProfileError extends Error {}
  const principalForUser = (user: Pick<User, 'userId' | 'username' | 'role'>): Principal => {
    const config = readAccessControl()
    const assignment = config.assignments.find(row => row.userId === user.userId)
    const profile = config.profiles.find(row => row.profileId === assignment?.profileId)
    const base = { userId: user.userId, username: user.username, role: user.role, permissions: auth.permissionSet(user.role).permissions }
    if (!assignment) return base
    if (!profile || profile.baseRole !== user.role) throw new Error('角色配置与账号身份不一致，请管理员重新分配。')
    if (profile.menuPaths.length === 0) throw new RetiredBatchProfileError('该角色仅保留已下线的批次权限，请管理员重新分配。')
    return { ...base, permissions: profile.permissions.filter(permission => base.permissions.includes(permission)), menuPaths: [...profile.menuPaths] }
  }
  const app = express()
  app.disable('x-powered-by')
  app.set('strict routing', true)

  let realtime: RealtimeController

  /**
   * Rejects non-loopback/CORS origins before adding response headers.
   *
   * @param req - Incoming Express request.
   * @param res - Response receiving either LOOPBACK_ONLY or CORS headers.
   * @param next - Middleware continuation for allowed requests.
   * @returns Nothing.
   * @remarks May send a 403 response; otherwise mutates response headers and continues routing.
   */
  app.use((req, res, next) => {
    const decision = publicOrigin ? assertLanRequest(req, publicOrigin) : assertLoopbackRequest(req)
    if (!decision.allowed) {
      if (options.authStorage) auth.recordDenied('anonymous', 'OPERATOR', 'AUTH_LOOPBACK_DENIED')
      res.status(403).json(failure('LOOPBACK_ONLY', 403, { message: decision.message }))
      return
    }

    if (decision.origin) res.setHeader('Access-Control-Allow-Origin', decision.origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Demo-Role, X-Confirmation-Id')
    res.setHeader('Vary', 'Origin')
    if (req.path === '/api/v1/auth/login') {
      res.setHeader('X-Auth-Mode', options.authStorage ? 'sqlite' : 'mock')
      res.setHeader('Access-Control-Expose-Headers', 'X-Auth-Mode')
    }
    next()
  })

  // 仅本机/部署入口注入文件与地图服务，纯 Mock 不引入文件或外部请求能力。
  if (options.site) app.use(options.site)

  /**
   * Responds to allowed API preflight requests.
   *
   * @param _req - Preflight request, unused after outer loopback validation.
   * @param res - Response receiving the 204 status.
   * @returns Nothing.
   * @remarks Sends a 204 response and performs no projection mutation.
   */
  app.options(/^\/api(?:\/.*)?$/, (_req, res) => {
    res.sendStatus(204)
  })

  // SQLite 模式统一验证会话；不接受浏览器提供的身份或角色作为授权依据。
  app.use('/api', (req, res, next) => {
    if (!options.authStorage) { next(); return }
    res.setHeader('Cache-Control', 'no-store')
    if (req.path === '/v1/auth/login' || req.path === '/v1/auth/logout' || req.path === '/v1/auth/session') { next(); return }
    const user = options.authStorage.currentUser(req.headers.cookie)
    if (!user) {
      // 无有效会话时不能信任角色头、用户名或请求体来归属审计身份。
      auth.recordDenied('anonymous', 'OPERATOR', 'AUTH_SESSION_DENIED')
      res.status(401).json(failure('INVALID_CREDENTIALS', 401, { message: '登录已失效，请重新登录。' }))
      return
    }
    authenticatedUsers.set(req, user)
    req.headers['x-demo-role'] = user.role
    next()
  })

  /**
   * Applies administrator RBAC before every user-management endpoint.
   *
   * @param req - User-management request used to derive action and object identity.
   * @param res - Response used when access is denied.
   * @param next - Continuation invoked only after administrator authorization.
   * @returns Nothing.
   * @remarks May append a denial audit and send 403; successful authorization continues routing.
   */
  app.use('/api/v1/admin/users', (req, res, next) => {
    const action = req.method === 'GET'
      ? 'USER_LIST'
      : req.method === 'POST'
        ? 'USER_CREATE'
        : req.method === 'DELETE'
          ? 'USER_DELETE'
          : 'USER_UPDATE'
    const objectId = req.path === '/' ? undefined : req.path.slice(1)
    if (requireAdmin(req, res, auth, action, objectId)) {
      next()
    }
  })

  // A 50-node full-scale scenario is approximately 17KB, exceeding 16KB but within this P0 local bound.
  const normalJson = express.json({ strict: true, limit: '256kb' })
  const qualityJson = express.json({ strict: true, limit: '8mb' })
  app.use((req, res, next) => (req.method === 'POST' && /^\/api\/v1\/simulations\/[^/]+\/quality$/.test(req.path)
    ? qualityJson : normalJson)(req, res, next))

  // 自定义角色只能收窄基础角色；服务端逐请求重新读取，不依赖前端隐藏按钮授权。
  app.use('/api/v1', (req, res, next) => {
    const user = authenticatedUsers.get(req)
    if (!user) { next(); return }
    try {
      const principal = principalForUser(user)
      if (!principal.menuPaths || req.path.startsWith('/auth/')) { next(); return }
      const path = req.path
      let permission: Permission = 'BUSINESS_READ'
      let menu: string | undefined
      if (path.startsWith('/admin/')) {
        permission = path.startsWith('/admin/equipment') || path.startsWith('/admin/master-data') ? 'MASTER_DATA_MAINTAIN'
          : path.startsWith('/admin/audit') ? 'AUDIT_READ'
            : /\/admin\/(?:backup|restore)/.test(path) ? 'BACKUP_RESTORE'
              : path.startsWith('/admin/config') ? 'FULL_CONFIG_EXPORT' : 'USER_ROLE_MAINTAIN'
        menu = path.startsWith('/admin/equipment') ? '/admin?section=equipment-library'
          : path.startsWith('/admin/local-archives') ? '/admin?section=simulation-data'
          : path.startsWith('/admin/audit') ? '/admin?section=audit-logs'
            : path.startsWith('/admin/master-data') ? '/admin?section=master-data'
              : /\/admin\/(?:backup|restore)/.test(path) ? '/admin?section=database-backup' : '/admin'
      } else if ((path.startsWith('/archives/') || path.startsWith('/mission-results')) && !principal.menuPaths.some(item => ['/reports', '/replays', '/admin?section=simulation-data'].includes(item))) {
        res.status(403).json(failure('PERMISSION_DENIED', 403))
        return
      } else if (path.startsWith('/reports')) {
        menu = '/reports'
        if (req.method !== 'GET') {
          const reportId = /^\/reports\/([^/]+)\/export$/.exec(path)?.[1]
          // 本机/归档报告合同固定为 LEVEL_II；纯 Mock 则按服务端报告快照判级。
          const report = options.loadLocalReport || req.query.archiveId !== undefined || req.query.resultId !== undefined
            ? undefined : projection.snapshot().report.reportId === reportId ? projection.snapshot().report : undefined
          permission = 'ORDINARY_REPORT_EXPORT'
        }
      } else if (path.startsWith('/scenarios')) {
        menu = '/scenarios'
        // 态势页只读恢复已登记运行的场景；不授予场景目录、未关联场景或编辑权限。
        const sceneRead = req.method === 'GET' ? /^\/scenarios\/([^/]+)$/.exec(path) : null
        if (sceneRead && principal.menuPaths.includes('/situation')
          && simulations.list().some(run => run.scenarioId === decodeURIComponent(sceneRead[1]!))) menu = '/situation'
        if (req.method !== 'GET') permission = 'SCENARIO_DRAFT_WRITE'
      } else if (path.startsWith('/templates') && req.method === 'GET') {
        menu = principal.menuPaths.includes('/scenarios') ? '/scenarios' : '/admin?section=scenario-templates'
      } else if (path.startsWith('/simulations')) {
        menu = '/situation'
        if (req.method !== 'GET') permission = 'SIMULATION_CONTROL'
        else if (/\/quality\/files\//.test(path)) permission = 'ORDINARY_REPORT_EXPORT'
      } else if (path.startsWith('/replays')) {
        menu = '/replays'
      } else if (req.method !== 'GET') {
        if (/^\/(?:scenarios|scripts)/.test(path)) { permission = 'SCENARIO_DRAFT_WRITE'; menu = '/scenarios' }
        if (/^\/templates\/[^/]+\/copy$/.test(path)) { permission = 'SCENARIO_DRAFT_WRITE'; menu = '/scenarios' }
        else if (path.startsWith('/templates')) { permission = 'OFFICIAL_TEMPLATE_MAINTAIN'; menu = '/admin?section=scenario-templates' }
        if (/^\/(?:simulations|tasks)/.test(path)) permission = 'SIMULATION_CONTROL'
        if (path.startsWith('/confirmations') && req.body?.action) {
          const byAction: Partial<Record<ConfirmationAction, Permission>> = {
            SCENARIO_WARNING_CONTINUE: 'SCENARIO_DRAFT_WRITE', SIMULATION_STOP: 'SIMULATION_CONTROL', OFFICIAL_TEMPLATE_DELETE: 'OFFICIAL_TEMPLATE_MAINTAIN',
            MASTER_DATA_DELETE: 'MASTER_DATA_MAINTAIN', BACKUP_RESTORE: 'BACKUP_RESTORE', FULL_CONFIG_EXPORT: 'FULL_CONFIG_EXPORT', AUDIT_EXPORT: 'AUDIT_READ',
          }
          permission = byAction[req.body.action as ConfirmationAction] ?? 'BUSINESS_READ'
        }
        if (path === '/reset') permission = 'USER_ROLE_MAINTAIN'
      }
      if (!principal.permissions.includes(permission) || (menu && !principal.menuPaths.includes(menu))) {
        auth.recordDenied(user.username, user.role, 'AUTH_PROFILE_DENIED')
        res.status(403).json(failure('PERMISSION_DENIED', 403, { message: '当前角色没有此操作或菜单权限。' })); return
      }
      next()
    } catch (error) {
      const message = error instanceof RetiredBatchProfileError ? error.message : '角色配置不可用，请联系管理员。'
      auth.recordDenied(user.username, user.role, 'AUTH_PROFILE_DENIED')
      res.status(403).json(failure('PERMISSION_DENIED', 403, { message }))
    }
  })

  // 重启后的未结清真实运行不能依赖内存锁；损坏记录无法确定场景时保守阻断全部场景写入。
  app.use('/api/v1', (req, res, next) => {
    const safety = missionSafety()
    if (!safety || req.method === 'GET') { next(); return }
    const path = req.path
    let target: unknown
    if (path === '/scenarios') target = req.body?.config?.scenario?.id
    else if (path === '/scenarios/import') target = scenarioSnapshotId(req.body?.items?.[0])
    else if (path.startsWith('/scenarios/')) target = path.split('/')[2]
    else if (/^\/templates\/[^/]+\/copy$/.test(path)) target = req.body?.scenarioId ?? 'SCN-001'
    else if (path === '/reset' || path === '/admin/restore'
      || path.startsWith('/admin/equipment/') || path.startsWith('/admin/master-data/')) target = safety.scenarioId
    else { next(); return }
    if (safety.scenarioId && target !== safety.scenarioId) { next(); return }
    res.status(409).json(failure('CONFIG_LOCKED', 409, { message: safety.message }))
  })

  /**
   * Validates login input and delegates authentication to the projection.
   *
   * @param req - Request containing the closed login body.
   * @param res - Response receiving a typed success or failure envelope.
   * @returns Nothing.
   * @remarks Records every terminal login outcome and writes exactly one HTTP response.
   */
  app.post('/api/v1/auth/login', async (req, res) => {
    const requestId = 'REQ-P1-AUTH-LOGIN'
    if (!isLoginShape(req.body)) {
      auth.recordError('anonymous', 'OPERATOR', 'AUTH_LOGIN')
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId,
        generatedAt: P1_GENERATED_AT,
      }))
      return
    }

    if (!options.authStorage && req.body.username !== 'admin' && req.body.username !== 'operator' && req.body.username !== 'locked') {
      auth.recordError(req.body.username, 'OPERATOR', 'AUTH_LOGIN')
      res.status(401).json(failure('INVALID_CREDENTIALS', 401, {
        requestId,
        generatedAt: P1_GENERATED_AT,
      }))
      return
    }

    if (options.authStorage && !options.authStorage.allowLogin()) {
      auth.recordDenied(req.body.username, 'OPERATOR', 'AUTH_LOGIN_RATE_LIMITED')
      res.setHeader('Retry-After', '60')
      res.status(429).json(failure('INVALID_REQUEST', 429, { message: '登录尝试过于频繁，请一分钟后重试。' }))
      return
    }
    options.authStorage?.revokeSession(req.headers.cookie)
    const result = await auth.login(req.body as LoginRequest)
    if (sendProjectionFailure(res, result, requestId)) {
      return
    }
    if (options.authStorage && result.data.principal) {
      try {
        result.data.principal = principalForUser(result.data.principal)
      } catch (error) {
        if (error instanceof RetiredBatchProfileError) {
          auth.recordDenied(req.body.username, result.data.principal.role, 'AUTH_PROFILE_DENIED')
          res.status(403).json(failure('PERMISSION_DENIED', 403, { requestId, generatedAt: P1_GENERATED_AT, message: error.message }))
          return
        }
        throw error
      }
      const token = options.authStorage.issueSession(result.data.principal.userId)
      res.setHeader('Set-Cookie', `wrj_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${publicOrigin?.startsWith('https:') ? '; Secure' : ''}`)
      result.data.sessionCreated = true
    }
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  app.get('/api/v1/auth/session', (req, res) => {
    const user = options.authStorage?.currentUser(req.headers.cookie)
    res.setHeader('X-Auth-Mode', options.authStorage ? 'sqlite' : 'mock')
    res.setHeader('Access-Control-Expose-Headers', 'X-Auth-Mode')
    if (user) {
      try {
        res.status(200).json(success({ authenticated: true, sessionCreated: true, principal: principalForUser(user) }, pageMeta('REQ-AUTH-SESSION')))
      } catch (error) {
        if (error instanceof RetiredBatchProfileError) {
          auth.recordDenied(user.username, user.role, 'AUTH_PROFILE_DENIED')
          res.status(403).json(failure('PERMISSION_DENIED', 403, { message: error.message }))
        } else throw error
      }
      return
    }
    const data = { authenticated: false, sessionCreated: false }
    res.status(200).json(success(data, pageMeta('REQ-AUTH-SESSION')))
  })

  app.post('/api/v1/auth/logout', (req, res) => {
    const user = options.authStorage?.currentUser(req.headers.cookie)
    if (!isStrictObject(req.body, ['confirm']) || req.body.confirm !== true) {
      if (options.authStorage) auth.recordError(user?.username ?? 'anonymous', user?.role ?? 'OPERATOR', 'AUTH_LOGOUT', user?.userId)
      res.status(400).json(failure('INVALID_REQUEST', 400, { fieldPath: 'confirm' }))
      return
    }
    options.authStorage?.revokeSession(req.headers.cookie)
    realtime?.revalidateSessions()
    if (options.authStorage) {
      if (user) auth.recordSuccess(user.username, user.role, 'AUTH_LOGOUT', user.userId)
      else auth.recordDenied('anonymous', 'OPERATOR', 'AUTH_LOGOUT')
    }
    res.setHeader('Set-Cookie', `wrj_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${publicOrigin?.startsWith('https:') ? '; Secure' : ''}`)
    res.status(200).json(success({ authenticated: false, sessionCreated: false }, pageMeta('REQ-AUTH-LOGOUT')))
  })

  /**
   * Returns the permission projection for a validated role hint.
   *
   * @param req - Request containing the internal role header.
   * @param res - Response receiving permissions or a denial envelope.
   * @returns Nothing.
   * @remarks Appends a SUCCESS/DENIED audit record and writes exactly one response.
   */
  app.get('/api/v1/auth/permissions', (req, res) => {
    const requestId = 'REQ-P1-AUTH-PERMISSIONS'
    const role = requireDemoRole(req, res, auth, 'AUTH_PERMISSIONS')
    if (role === undefined) {
      return
    }

    auth.recordSuccess(actorForRequest(req, role), role, 'AUTH_PERMISSIONS')
    const user = authenticatedUsers.get(req)
    const principal = user ? principalForUser(user) : undefined
    res.status(200).json(success(principal ? { role, permissions: principal.permissions, ...(principal.menuPaths ? { menuPaths: principal.menuPaths } : {}) } : auth.permissionSet(role), pageMeta(requestId)))
  })

  /** 返回既有合同声明的能力、决策和路由目录，不执行业务操作。 */
  for (const section of ['capabilities', 'decisions', 'routes'] as const) {
    app.get(`/api/v1/meta/${section}`, (req, res) => {
      const requestId = `REQ-P8-META-${section}`
      if (requireDemoRole(req, res, auth, 'METADATA_READ') === undefined) return
      const items = projection.snapshot().metadata[section]
      res.status(200).json(success(items, pageMeta(requestId, items.length, items.length)))
    })
  }

  /** 本机只读监控扩展；纯 Mock 返回 null，不伪造健康或文件读取记录。 */
  app.get('/api/v1/data-exchange/monitor', (req, res) => {
    if (requireDemoRole(req, res, auth, 'EXCHANGE_MONITOR_READ') === undefined) return
    if (Object.keys(req.query).length > 0) {
      res.status(400).json(failure('INVALID_REQUEST', 400, { message: '监控接口不接受文件路径或查询参数。' }))
      return
    }
    try {
      res.status(200).json(success(options.loadExchangeMonitor?.() ?? null, pageMeta('REQ-EXCHANGE-MONITOR')))
    } catch {
      res.status(503).json(failure('START_FAILED', 503, { message: '本机监控读取失败，请稍后重试。' }))
    }
  })

  /** 返回七类接口的确定性元数据。 */
  app.get('/api/v1/meta/interfaces', (req, res) => {
    const requestId = 'REQ-P5-INTERFACES'
    if (requireDemoRole(req, res, auth, 'INTERFACE_LIST') === undefined) return
    const interfaces = projection.snapshot().metadata.interfaces
    res.status(200).json(success(interfaces, pageMeta(requestId, interfaces.length, interfaces.length)))
  })

  /** 返回场景配置 1.0 的字段合同。 */
  app.get('/api/v1/contracts/scenario-config', (req, res) => {
    const requestId = 'REQ-P5-SCENARIO-CONTRACT'
    if (requireDemoRole(req, res, auth, 'SCENARIO_CONTRACT_READ') === undefined) return
    res.status(200).json(success(projection.snapshot().contracts.scenarioConfig, pageMeta(requestId)))
  })

  /** 返回五个前端规范数据结构合同。 */
  app.get('/api/v1/contracts/frontend-types', (req, res) => {
    const requestId = 'REQ-P5-FRONTEND-CONTRACTS'
    if (requireDemoRole(req, res, auth, 'FRONTEND_CONTRACT_LIST') === undefined) return
    const contracts = projection.snapshot().contracts.frontendTypes
    res.status(200).json(success(contracts, pageMeta(requestId, contracts.length, contracts.length)))
  })

  /** 返回五类 canonical CSV 合同，不执行文件读写。 */
  app.get('/api/v1/contracts/csv', (req, res) => {
    const requestId = 'REQ-P5-CSV-CONTRACTS'
    if (requireDemoRole(req, res, auth, 'CSV_CONTRACT_LIST') === undefined) return
    const contracts = projection.snapshot().contracts.csv
    res.status(200).json(success(contracts, pageMeta(requestId, contracts.length, contracts.length)))
  })

  /** 只读返回本机配置的初始节点，不接受客户端文件路径或改动当前 Mock 投影。 */
  app.get('/api/v1/situation/initial-nodes', async (req, res) => {
    if (requireDemoRole(req, res, auth, 'INITIAL_NODES_READ') === undefined) return
    if (Object.keys(req.query).length > 0) {
      res.status(400).json(failure('INVALID_REQUEST', 400, { message: '此接口不接受文件路径或查询参数。' }))
      return
    }
    try {
      const snapshot = options.loadInitialNodes ? await options.loadInitialNodes() : null
      res.status(200).json(success(snapshot, pageMeta('REQ-INITIAL-NODES', 1, 1)))
    } catch {
      // 文件错误可能含有本机绝对路径，不直接透传给浏览器。
      res.status(503).json(failure('START_FAILED', 503, {
        message: '初始节点读取失败，请检查本机日志路径、文件完整性及初始坐标后重试。', retryable: true,
      }))
    }
  })

  /** 只读获取追加位置的最新快照；游标由本机读取器维护，不接受客户端文件路径。 */
  app.get('/api/v1/situation/positions', async (req, res) => {
    if (requireDemoRole(req, res, auth, 'POSITIONS_READ') === undefined) return
    if (Object.keys(req.query).length > 0) {
      res.status(400).json(failure('INVALID_REQUEST', 400, { message: '此接口不接受文件路径或查询参数。' }))
      return
    }
    try {
      const snapshot = options.loadPositions ? await options.loadPositions() : null
      res.status(200).json(success(snapshot, pageMeta('REQ-POSITIONS', 1, 1)))
    } catch {
      res.status(503).json(failure('START_FAILED', 503, {
        message: '追加位置读取失败，请检查本机位置文件、表头及编码。', retryable: true,
      }))
    }
  })

  /** 只读获取当前文件历史；固定路由放在带 replayId 的路由之前。 */
  app.get('/api/v1/replays/local-file', async (req, res) => {
    if (requireDemoRole(req, res, auth, 'LOCAL_REPLAY_READ') === undefined) return
    if (Object.keys(req.query).length > 0) {
      res.status(400).json(failure('INVALID_REQUEST', 400, { message: '此接口不接受文件路径或查询参数。' }))
      return
    }
    try {
      const snapshot = options.loadLocalReplay ? await options.loadLocalReplay() : null
      res.status(200).json(success(snapshot, pageMeta('REQ-LOCAL-REPLAY', 1, 1)))
    } catch {
      res.status(503).json(failure('START_FAILED', 503, {
        message: '文件回放读取失败，请检查两个文件的路径、表头、编码及写入状态后重新加载。', retryable: true,
      }))
    }
  })

  /** 返回每个已登记任务的当前运行。 */
  app.get('/api/v1/simulations', (req, res) => {
    const requestId = 'REQ-P3-SIMULATION-LIST'
    if (requireDemoRole(req, res, auth, 'SIMULATION_LIST') === undefined) return
    const runs = simulations.list()
    res.status(200).json(success(runs, pageMeta(requestId, runs.length, Math.max(1, runs.length))))
  })

  /** 在容量内创建任务运行；同任务和场景保持单实例。 */
  app.post('/api/v1/simulations', (req, res) => {
    const requestId = 'REQ-P3-SIMULATION-CREATE'
    const role = requireDemoRole(req, res, auth, 'SIMULATION_CREATE')
    if (role === undefined) return
    const safety = missionSafety()
    if (safety) { res.status(409).json(failure('INVALID_TRANSITION', 409, { message: safety.message })); return }
    const result = simulations.create(req.body)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SIMULATION_CREATE')
      sendSimulationFailure(res, result, requestId)
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'SIMULATION_CREATE', result.data.runId)
    for (const [id, slot] of missions) if (slot.taskId === result.data.taskId) missions.delete(id)
    realtime.publishRuntimeState(result.data)
    res.status(201).json(success(result.data, pageMeta(requestId)))
  })

  /** 返回指定仿真运行的 UI 与规范状态投影。 */
  app.get('/api/v1/simulations/:runId', (req, res) => {
    const runId = req.params.runId
    const requestId = 'REQ-P3-SIMULATION-GET'
    if (requireDemoRole(req, res, auth, 'SIMULATION_READ', runId) === undefined) return
    const result = simulations.get(runId)
    if (sendSimulationFailure(res, result, requestId)) return
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  app.get('/api/v1/simulations/:runId/quality', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (requireDemoRole(req, res, auth, 'QUALITY_READ', req.params.runId) === undefined) return
    if (Object.keys(req.query).length) { res.status(400).json(failure('INVALID_REQUEST', 400)); return }
    if (!options.runQualityStore) { res.status(409).json(failure('INVALID_TRANSITION', 409, { message: '当前入口未配置规范质量文件接入。' })); return }
    const run = simulations.get(req.params.runId)
    if (sendSimulationFailure(res, run, 'REQ-QUALITY-GET')) return
    const context = qualityContext(req.params.runId)
    if (!context) { res.status(409).json(failure('INVALID_TRANSITION', 409, { message: '当前运行没有可核对的启动时间或场景版本。' })); return }
    try {
      const dataset = await options.runQualityStore.load(req.params.runId)
      if (dataset && !sameQualityScope(dataset.scope, context.scope)) { res.status(409).json(failure('VERSION_CONFLICT', 409, { message: '质量文件与当前运行版本不一致。' })); return }
      res.json(success(dataset, pageMeta('REQ-QUALITY-GET')))
    } catch { res.status(503).json(failure('START_FAILED', 503, { message: '质量文件不可读或校验失败，未使用其他数据替代。' })) }
  })

  app.post('/api/v1/simulations/:runId/quality', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const role = requireDemoRole(req, res, auth, 'QUALITY_IMPORT', req.params.runId)
    if (role === undefined) return
    if (Object.keys(req.query).length) { res.status(400).json(failure('INVALID_REQUEST', 400)); return }
    if (!options.runQualityStore) { res.status(409).json(failure('INVALID_TRANSITION', 409, { message: '当前入口未配置规范质量文件接入。' })); return }
    const run = simulations.get(req.params.runId)
    if (sendSimulationFailure(res, run, 'REQ-QUALITY-IMPORT')) return
    const context = qualityContext(req.params.runId)
    if (!context) { res.status(409).json(failure('INVALID_TRANSITION', 409, { message: '请先启动所选场景的运行，再导入对应质量数据。' })); return }
    const userId = authenticatedUsers.get(req)?.userId
    const canPublish = () => {
      const current = qualityContext(req.params.runId)
      if (closing || !current || !sameQualityScope(current.scope, context.scope)) return false
      if (!options.authStorage) return true
      const user = options.authStorage.currentUser(req.headers.cookie)
      if (!user || user.userId !== userId) return false
      try {
        const principal = principalForUser(user)
        return principal.permissions.includes('SIMULATION_CONTROL') && (!principal.menuPaths || principal.menuPaths.includes('/situation'))
      } catch { return false }
    }
    try {
      const dataset = await options.runQualityStore.import(req.body, context.scope, context.draft.config, canPublish)
      realtime.publishQualityDataset(dataset)
      auth.recordSuccess(actorForRequest(req, role), role, 'QUALITY_IMPORT', req.params.runId)
      res.json(success(dataset, pageMeta('REQ-QUALITY-IMPORT')))
    } catch (error) {
      auth.recordError(actorForRequest(req, role), role, 'QUALITY_IMPORT', req.params.runId)
      if (!canPublish()) { res.status(409).json(failure('VERSION_CONFLICT', 409, { message: '接收期间运行或登录状态已改变，请重新加载。' })); return }
      if (error instanceof QualityImportError) {
        const issue = error.issues[0]
        res.status(422).json(failure('VALIDATION_FAILED', 422, { message: issue?.message ?? '质量文件不符合合同。', fieldPath: issue?.fieldPath ?? 'request' }))
      } else res.status(503).json(failure('START_FAILED', 503, { message: '质量文件接收或写盘失败，未替换已发布数据。', retryable: true }))
    }
  })

  app.get('/api/v1/simulations/:runId/quality/files/:fileName', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const role = requireDemoRole(req, res, auth, 'QUALITY_EXPORT', req.params.runId)
    if (role === undefined) return
    const sourceSha256 = req.query.sourceSha256
    if (Object.keys(req.query).some(key => key !== 'sourceSha256') || (sourceSha256 !== undefined
      && (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)))) { res.status(400).json(failure('INVALID_REQUEST', 400)); return }
    const context = qualityContext(req.params.runId)
    if (!context || !options.runQualityStore) { res.status(409).json(failure('INVALID_TRANSITION', 409)); return }
    try {
      const dataset = await options.runQualityStore.load(req.params.runId, sourceSha256 as string | undefined)
      if (!dataset || !sameQualityScope(dataset.scope, context.scope)) { res.status(409).json(failure('VERSION_CONFLICT', 409)); return }
      const file = await options.runQualityStore.getFile(req.params.runId, req.params.fileName, dataset.source.sha256)
      if (!file) { res.status(404).json(failure('NOT_FOUND', 404, { message: '该文件未提供；缺测项不会生成替代文件。' })); return }
      auth.recordSuccess(actorForRequest(req, role), role, 'QUALITY_EXPORT', req.params.runId)
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Quality-Source-Sha256')
      res.setHeader('X-Quality-Source-Sha256', dataset.source.sha256)
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.type('application/octet-stream')
      res.download(file.filePath, req.params.fileName)
    } catch { res.status(503).json(failure('START_FAILED', 503, { message: '规范质量文件导出失败。' })) }
  })

  /** 读取指定本地 mission 本次独占输出的最新位置；不接受浏览器提供文件路径。 */
  app.get('/api/v1/simulations/:runId/positions', async (req, res) => {
    const runId = req.params.runId
    const requestId = 'REQ-MISSION-POSITIONS'
    // Position snapshots are append-only during a live run and must never be reused by a browser/proxy cache.
    res.setHeader('Cache-Control', 'no-store')
    if (requireDemoRole(req, res, auth, 'SIMULATION_READ', runId) === undefined) return
    if (Object.keys(req.query).length > 0) {
      res.status(400).json(failure('INVALID_REQUEST', 400, { message: '此接口不接受文件路径或查询参数。' }))
      return
    }
    const run = simulations.get(runId)
    if (sendSimulationFailure(res, run, requestId)) return
    const binding = missions.get(runId)?.positions
    if (!binding || binding.runId !== runId) {
      res.status(409).json(failure('INVALID_TRANSITION', 409, { message: '当前运行未关联本地 mission 输出。' }))
      return
    }
    try {
      const snapshot = await binding.read()
      if (snapshot === null || missions.get(runId)?.positions !== binding) {
        res.status(409).json(failure('INVALID_TRANSITION', 409, { message: '当前运行未关联本地 mission 输出。' }))
        return
      }
      res.status(200).json(success(snapshot, pageMeta(requestId)))
    } catch {
      res.status(503).json(failure('START_FAILED', 503, {
        message: '本次仿真位置读取失败，请检查本次输出文件、表头及写入状态。', retryable: true,
      }))
    }
  })

  /** 返回指定运行和帧编号对应的确定性遥测帧。 */
  /** 读取本次 mission 控制台日志（stdout/stderr）尾部；路径由服务端运行目录决定，不接受浏览器参数。 */
  app.get('/api/v1/simulations/:runId/console', async (req, res) => {
    const runId = req.params.runId
    const requestId = 'REQ-MISSION-CONSOLE'
    res.setHeader('Cache-Control', 'no-store')
    if (requireDemoRole(req, res, auth, 'SIMULATION_READ', runId) === undefined) return
    if (Object.keys(req.query).length > 0) {
      res.status(400).json(failure('INVALID_REQUEST', 400, { message: '此接口不接受文件路径或查询参数。' }))
      return
    }
    const run = simulations.get(runId)
    if (sendSimulationFailure(res, run, requestId)) return
    const binding = missions.get(runId)?.consoleLog
    if (!binding || binding.runId !== runId) {
      res.status(409).json(failure('INVALID_TRANSITION', 409, { message: '当前运行未关联本地 mission 控制台日志。' }))
      return
    }
    try {
      const log = await binding.read()
      res.status(200).json(success({ ...log, timeoutMs: binding.timeoutMs ?? null }, pageMeta(requestId)))
    } catch {
      res.status(503).json(failure('START_FAILED', 503, { message: '本次 mission 控制台日志读取失败。', retryable: true }))
    }
  })

  app.get('/api/v1/simulations/:runId/frames/:frameId', (req, res) => {
    const { runId, frameId } = req.params
    const requestId = 'REQ-P3-FRAME-GET'
    if (requireDemoRole(req, res, auth, 'SIMULATION_FRAME_READ', frameId) === undefined) return
    const result = simulations.getFrame(runId, frameId)
    if (sendSimulationFailure(res, result, requestId)) return
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 返回指定运行的同帧侦测与链路切换事件。 */
  app.get('/api/v1/simulations/:runId/events', (req, res) => {
    const runId = req.params.runId
    const requestId = 'REQ-P3-EVENT-LIST'
    if (requireDemoRole(req, res, auth, 'SIMULATION_EVENT_LIST', runId) === undefined) return
    const result = simulations.listEvents(runId)
    if (sendSimulationFailure(res, result, requestId)) return
    res.status(200).json(success(result.data, pageMeta(requestId, result.data.length, Math.max(1, result.data.length))))
  })

  /** 执行一次同目标同帧的侦测、启扰与链路劣化闭环。 */
  app.post('/api/v1/simulations/:runId/events', (req, res) => {
    const runId = req.params.runId
    const requestId = 'REQ-P4-CLOSED-LOOP'
    const role = requireDemoRole(req, res, auth, 'SIMULATION_CLOSED_LOOP', runId)
    if (role === undefined) return
    if (!auth.permissionSet(role).permissions.includes('SIMULATION_CONTROL')) {
      auth.recordDenied(actorForRequest(req, role), role, 'SIMULATION_CLOSED_LOOP', runId)
      res.status(403).json(failure('PERMISSION_DENIED', 403, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: '当前账号没有闭环控制权限。',
      }))
      return
    }
    const result = simulations.runClosedLoop(runId, req.body)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SIMULATION_CLOSED_LOOP', runId)
      sendSimulationFailure(res, result, requestId)
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'SIMULATION_CLOSED_LOOP', runId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /**
   * 执行开始、暂停、继续、单步、停止或倍速命令。
   * @remarks STOP 在状态校验后消费绑定运行和角色的一次性确认，其余命令不创建确认上下文。
   */
  app.post('/api/v1/simulations/:runId/commands', async (req, res) => {
    const runId = req.params.runId
    const requestId = 'REQ-P3-SIMULATION-COMMAND'
    const role = requireDemoRole(req, res, auth, 'SIMULATION_COMMAND', runId)
    if (role === undefined) return
    const selectedRun = simulations.get(runId)
    const slot = missions.get(runId) ?? { taskId: selectedRun.ok ? selectedRun.data.taskId : '', stopping: false } as MissionSlot
    const safety = missionSafety(selectedRun.ok ? selectedRun.data.taskId : undefined)
    if (safety && req.body?.command === 'START') {
      res.status(409).json(failure('INVALID_TRANSITION', 409, { message: safety.message }))
      return
    }
    if (slot.starting || slot.stopping || slot.controlling || closing) {
      auth.recordError(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
      res.status(409).json(failure('INVALID_TRANSITION', 409, { message: 'mission 正在启动或停止，请稍后重试。' }))
      return
    }

    const inspected = simulations.inspectCommand(runId, req.body)
    if (!inspected.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
      sendSimulationFailure(res, inspected, requestId)
      return
    }
    const command = inspected.data
    if (options.missionExecution && command.command !== 'START' && command.command !== 'STOP') {
      if (!slot.mission?.control) {
        auth.recordError(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
        res.status(409).json(failure('INVALID_TRANSITION', 409, { message: '本机 mission 尚未接入暂停、继续、单步和倍速控制，未执行此命令。' }))
        return
      }
      slot.controlling = true
      try {
        await slot.mission.control(command as MissionRuntimeControl)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'mission 未确认运行中控制命令。'
        auth.recordError(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
        res.status(503).json(failure('START_FAILED', 503, { message }))
        return
      } finally { slot.controlling = false }
    }
    if (options.missionExecution && command.command === 'START' && command.mode !== 'INTERACTIVE_SINGLE') {
      auth.recordError(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
      res.status(409).json(failure('INVALID_TRANSITION', 409, { message: '本机 mission 当前只支持所选场景的单次执行。' }))
      return
    }
    if (options.missionExecution && command.command === 'START') {
      const run = simulations.get(runId)
      const draft = run.ok ? scenarios.get(run.data.scenarioId) : run
      if (sendSimulationFailure(res, draft, requestId) || !draft.ok) {
        auth.recordError(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
        return
      }
      try {
        missions.set(runId, slot)
        slot.qualityDraft = structuredClone(draft.data)
        slot.starting = options.missionExecution.start(draft.data, runId, run.ok ? run.data.taskId : undefined)
        const process = await slot.starting
        slot.positions = process.readPositions ? { runId, read: process.readPositions.bind(process) } : undefined
        slot.consoleLog = process.readConsoleLog ? { runId, read: process.readConsoleLog.bind(process), timeoutMs: process.timeoutMs } : undefined
        slot.mission = process
        slot.completedWhileStopping = undefined
        const started = simulations.startMission(runId, process.pid, process.startedAt)
        void process.dataFailure?.then(message => {
          if (slot.mission !== process || closing) return
          realtime.publishRuntimeState(simulations.markMissionStopUncertain(runId, message))
          auth.recordError(actorForRequest(req, role), role, 'SIMULATION_CSV_WRITE', runId)
        })
        void process.completed.then(outcome => {
          if (slot.mission !== process || closing) return
          if (slot.stopping) { slot.completedWhileStopping = outcome; return }
          slot.mission = undefined
          const safety = missionSafety(slot.taskId)
          const finished = safety ? simulations.markMissionStopUncertain(runId, safety.message) : simulations.finishMission(runId, outcome)
          realtime.publishRuntimeState(finished)
          if (finished.uiStatus === 'ERROR') auth.recordError(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
        })
        auth.recordSuccess(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
        realtime.publishRuntimeState(started)
        res.status(200).json(success(started, pageMeta(requestId)))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'mission 启动失败，请检查本机配置。'
        const safety = missionSafety(slot.taskId)
        realtime.publishRuntimeState(safety
          ? simulations.markMissionStopUncertain(runId, message)
          : simulations.finishMission(runId, { code: null, errorMessage: message }))
        auth.recordError(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
        res.status(error instanceof MissionGenerationError ? 422 : 503).json(failure(
          error instanceof MissionGenerationError ? 'VALIDATION_FAILED' : 'START_FAILED',
          error instanceof MissionGenerationError ? 422 : 503,
          { message, ...(error instanceof MissionGenerationError ? { fieldPath: error.fieldPath } : {}) },
        ))
      } finally { slot.starting = undefined }
      return
    }
    let stopConfirmed = false
    if (command.command === 'STOP') {
      if (command.confirmationId === undefined) {
        auth.recordError(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
        res.status(428).json(failure('CONFIRMATION_REQUIRED', 428, {
          requestId,
          generatedAt: P1_GENERATED_AT,
          message: '停止仿真前需要二次确认。',
        }))
        return
      }
      const confirmed = confirmations.consume(command.confirmationId, 'SIMULATION_STOP', runId, role, confirmationOwner(req)?.id)
      if (!confirmed.ok) {
        auth.recordError(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
        res.status(confirmed.status).json(failure(confirmed.code, confirmed.status, {
          requestId,
          generatedAt: P1_GENERATED_AT,
          message: confirmed.message,
        }))
        return
      }
      stopConfirmed = true
    }

    if (slot.mission && command.command === 'STOP') {
      slot.stopping = true
      try {
        await slot.mission.stop()
        slot.mission = undefined
      } catch (error) {
        const message = error instanceof Error ? error.message : 'mission 停止失败。'
        if (slot.completedWhileStopping && !missionSafety(slot.taskId)) {
          slot.mission = undefined
          realtime.publishRuntimeState(simulations.finishMission(runId, slot.completedWhileStopping))
        } else {
          realtime.publishRuntimeState(simulations.markMissionStopUncertain(runId, message))
        }
        auth.recordError(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
        res.status(503).json(failure('START_FAILED', 503, { message }))
        return
      } finally {
        slot.stopping = false
        if (slot.mission && slot.completedWhileStopping && !missionSafety(slot.taskId)) {
          slot.mission = undefined
          realtime.publishRuntimeState(simulations.finishMission(runId, slot.completedWhileStopping))
        }
        slot.completedWhileStopping = undefined
      }
    }

    const result = simulations.command(runId, command, stopConfirmed)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
      sendSimulationFailure(res, result, requestId)
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'SIMULATION_COMMAND', runId)
    realtime.publishRuntimeState(result.data)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 按任务执行 RF 干扰机启停和参数设置，并返回确定性生效帧。 */
  app.post('/api/v1/tasks/:taskId/jammers/:jammerId/commands', (req, res) => {
    const { taskId, jammerId } = req.params
    const requestId = 'REQ-P4-JAMMER-COMMAND'
    const role = requireDemoRole(req, res, auth, 'SIMULATION_JAMMER_COMMAND', jammerId)
    if (role === undefined) return
    if (!auth.permissionSet(role).permissions.includes('SIMULATION_CONTROL')) {
      auth.recordDenied(actorForRequest(req, role), role, 'SIMULATION_JAMMER_COMMAND', jammerId)
      res.status(403).json(failure('PERMISSION_DENIED', 403, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: '当前账号没有干扰控制权限。',
      }))
      return
    }

    const result = simulations.controlJammer(taskId, jammerId, req.body)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SIMULATION_JAMMER_COMMAND', jammerId)
      sendSimulationFailure(res, result, requestId)
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'SIMULATION_JAMMER_COMMAND', jammerId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 在明确仿真帧边界同步一版干扰参数，并发布规范设备状态。 */
  app.post('/api/v1/tasks/:taskId/jammers/:jammerId/parameters', (req, res) => {
    const { taskId, jammerId } = req.params
    const requestId = 'REQ-P4-JAMMER-SYNC'
    const role = requireDemoRole(req, res, auth, 'SIMULATION_JAMMER_SYNC', jammerId)
    if (role === undefined) return
    if (!auth.permissionSet(role).permissions.includes('SIMULATION_CONTROL')) {
      auth.recordDenied(actorForRequest(req, role), role, 'SIMULATION_JAMMER_SYNC', jammerId)
      res.status(403).json(failure('PERMISSION_DENIED', 403, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: '当前账号没有干扰参数同步权限。',
      }))
      return
    }
    const result = simulations.syncJammerParameters(taskId, jammerId, req.body)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SIMULATION_JAMMER_SYNC', jammerId)
      sendSimulationFailure(res, result, requestId)
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'SIMULATION_JAMMER_SYNC', jammerId)
    realtime.publishJammerStatus(result.data.jammerStatus, result.data.effectiveFrameId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /**
   * 返回指定场景草稿；本机持久化模式的默认入口读取当前工作场景。
   * @param req 包含角色提示和场景编号的请求。
   * @param res 接收场景草稿或类型化错误的响应。
   * @returns 无返回值。
   * @remarks 只读取场景投影，不修改草稿修订号。
   */
  app.get('/api/v1/scenarios', (req, res) => {
    if (requireDemoRole(req, res, auth, 'SCENARIO_LIST') === undefined) return
    try {
      const items = scenarios.list()
      res.status(200).json(success(items, pageMeta('REQ-SCENARIOS-LIST', items.length, Math.max(1, items.length))))
    } catch {
      res.status(503).json(failure('ATOMIC_REPLACE_FAILED', 503, { message: '场景列表读取失败，请重试。' }))
    }
  })

  // Must precede /:scenarioId. This shares scenario-read access and does not expose admin mutation routes.
  app.get('/api/v1/scenarios/parameter-catalog', (req, res) => {
    if (requireDemoRole(req, res, auth, 'SCENARIO_PARAMETER_CATALOG') === undefined) return
    try {
      res.status(200).json(success(parameterCatalog(admin.listEquipment(), admin.listMasterData()), pageMeta('REQ-SCENARIO-PARAMETER-CATALOG')))
    } catch {
      res.status(503).json(failure('ATOMIC_REPLACE_FAILED', 503, { message: '参数来源目录读取失败，请检查本机数据存储。', retryable: true }))
    }
  })

  app.post('/api/v1/scenarios', (req, res) => {
    const role = requireDemoRole(req, res, auth, 'SCENARIO_CREATE')
    if (role === undefined) return
    const result = scenarios.create(req.body)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SCENARIO_CREATE')
      res.status(result.status).json(failure(result.code, result.status, { message: result.message, fieldPath: result.fieldPath }))
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'SCENARIO_CREATE', result.data.config.scenario.id)
    res.status(201).json(success(result.data, pageMeta('REQ-SCENARIOS-CREATE')))
  })

  app.delete('/api/v1/scenarios/:scenarioId', (req, res) => {
    const role = requireDemoRole(req, res, auth, 'SCENARIO_DELETE', req.params.scenarioId)
    if (role === undefined) return
    const revision = req.query.expectedRevision
    const result = scenarios.delete(req.params.scenarioId, { expectedRevision: typeof revision === 'string' && /^\d+$/.test(revision) ? Number(revision) : undefined })
    if (!result.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SCENARIO_DELETE', req.params.scenarioId)
      res.status(result.status).json(failure(result.code, result.status, { message: result.message, fieldPath: result.fieldPath }))
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'SCENARIO_DELETE', req.params.scenarioId)
    res.status(200).json(success(result.data, pageMeta('REQ-SCENARIOS-DELETE')))
  })

  app.get('/api/v1/scenarios/:scenarioId', (req, res) => {
    const scenarioId = req.params.scenarioId
    const requestId = 'REQ-P2-SCENARIO-GET'
    if (requireDemoRole(req, res, auth, 'SCENARIO_READ', scenarioId) === undefined) return

    const result = scenarios.get(scenarioId)
    if (!result.ok) {
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
      }))
      return
    }
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /**
   * 校验指定场景草稿并返回全部字段问题。
   * @param req 包含角色提示、场景编号和完整规范配置的请求。
   * @param res 接收校验结果或类型化请求错误的响应。
   * @returns 无返回值。
   * @remarks 校验不修改场景草稿；配置锁定时直接拒绝。
   */
  app.post('/api/v1/scenarios/:scenarioId/validate', (req, res) => {
    const scenarioId = req.params.scenarioId
    const requestId = 'REQ-P2-SCENARIO-VALIDATE'
    const role = requireDemoRole(req, res, auth, 'SCENARIO_VALIDATE', scenarioId)
    if (role === undefined) return

    const result = scenarios.validate(scenarioId, req.body)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SCENARIO_VALIDATE', scenarioId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'SCENARIO_VALIDATE', scenarioId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /**
   * 保存指定场景的基础、环境、时序、平台、航点、链路和干扰设备参数。
   * @param req 包含角色提示、场景编号、完整配置和界面扩展的请求。
   * @param res 接收更新后草稿或字段校验错误的响应。
   * @returns 无返回值。
   * @remarks 校验通过时递增场景草稿修订号。
   */
  app.put('/api/v1/scenarios/:scenarioId', (req, res) => {
    const scenarioId = req.params.scenarioId
    const requestId = 'REQ-P2-SCENARIO-PUT'
    const role = requireDemoRole(req, res, auth, 'SCENARIO_UPDATE', scenarioId)
    if (role === undefined) return

    const result = scenarios.save(scenarioId, req.body)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SCENARIO_UPDATE', scenarioId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'SCENARIO_UPDATE', scenarioId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 撤销当前场景最近一次已持久化操作并恢复完整快照。 */
  app.post('/api/v1/scenarios/:scenarioId/undo', (req, res) => {
    const scenarioId = req.params.scenarioId
    const requestId = 'REQ-P2-SCENARIO-UNDO'
    const role = requireDemoRole(req, res, auth, 'SCENARIO_UNDO', scenarioId)
    if (role === undefined) return
    const result = scenarios.undo(scenarioId, req.body)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SCENARIO_UNDO', scenarioId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'SCENARIO_UNDO', scenarioId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 将当前场景重置为冻结 SCN-001 快照，不触发全局 Mock reset。 */
  app.post('/api/v1/scenarios/:scenarioId/reset', (req, res) => {
    const scenarioId = req.params.scenarioId
    const requestId = 'REQ-P2-SCENARIO-RESET'
    const role = requireDemoRole(req, res, auth, 'SCENARIO_RESET', scenarioId)
    if (role === undefined) return
    const result = scenarios.resetDraft(scenarioId, req.body)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SCENARIO_RESET', scenarioId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'SCENARIO_RESET', scenarioId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 原子校验并导入场景配置 1.0 快照，只替换临时工作场景。 */
  app.post('/api/v1/scenarios/import', (req, res) => {
    const requestId = 'REQ-P2-SCENARIO-IMPORT'
    const role = requireDemoRole(req, res, auth, 'SCENARIO_IMPORT')
    if (role === undefined) return
    const result = scenarios.importSnapshots(req.body)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SCENARIO_IMPORT')
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'SCENARIO_IMPORT')
    res.status(200).json(success(result.data, pageMeta(requestId, result.data.imported, result.data.imported)))
  })

  /**
   * 返回当前内存模板库。
   * @param req 包含角色提示的请求。
   * @param res 接收模板列表或权限错误的响应。
   * @returns 无返回值。
   * @remarks 两种角色均可读取，返回值为投影副本。
   */
  app.get('/api/v1/templates', (req, res) => {
    const requestId = 'REQ-P2-TEMPLATES-LIST'
    if (requireDemoRole(req, res, auth, 'TEMPLATE_LIST') === undefined) return
    try {
      const result = templates.list()
      res.status(200).json(success(result, pageMeta(requestId, result.length, Math.max(1, result.length))))
    } catch {
      res.status(503).json(failure('ATOMIC_REPLACE_FAILED', 503, { requestId, message: '模板数据库读取失败，请稍后重试。' }))
    }
  })

  /**
   * 新建或导入官方模板。
   * @param req 包含管理员角色及模板名称、配置的请求。
   * @param res 接收新模板或类型化错误的响应。
   * @returns 无返回值。
   * @remarks 使用注入的模板存储；操作员在进入请求体处理前即被拒绝。
   */
  app.post('/api/v1/templates', (req, res) => {
    const requestId = 'REQ-P2-TEMPLATE-CREATE'
    if (!requireAdmin(req, res, auth, 'TEMPLATE_CREATE')) return
    const result = templates.create(req.body)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'TEMPLATE_CREATE')
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRequest(req, 'ADMIN'), 'ADMIN', 'TEMPLATE_CREATE', result.data.templateId)
    res.status(201).json(success(result.data, pageMeta(requestId)))
  })

  /**
   * 返回指定模板详情。
   * @param req 包含角色提示和模板编号的请求。
   * @param res 接收模板详情或未找到错误的响应。
   * @returns 无返回值。
   */
  app.get('/api/v1/templates/:templateId', (req, res) => {
    const templateId = req.params.templateId
    const requestId = 'REQ-P2-TEMPLATE-GET'
    if (requireDemoRole(req, res, auth, 'TEMPLATE_READ', templateId) === undefined) return
    const result = templates.get(templateId)
    if (!result.ok) {
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
      }))
      return
    }
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /**
   * 使用当前配置更新官方模板版本。
   * @param req 包含管理员角色、模板编号和完整配置的请求。
   * @param res 接收递增版本后的模板或类型化错误的响应。
   * @returns 无返回值。
   */
  app.put('/api/v1/templates/:templateId', (req, res) => {
    const templateId = req.params.templateId
    const requestId = 'REQ-P2-TEMPLATE-UPDATE'
    if (!requireAdmin(req, res, auth, 'TEMPLATE_UPDATE', templateId)) return
    const result = templates.update(templateId, req.body)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'TEMPLATE_UPDATE', templateId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRequest(req, 'ADMIN'), 'ADMIN', 'TEMPLATE_UPDATE', templateId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /**
   * 将模板复制到当前临时工作场景。
   * @param req 包含角色提示、模板编号和临时场景名称的请求。
   * @param res 接收复制后的场景草稿或类型化错误的响应。
   * @returns 无返回值。
   * @remarks 两种角色均可复制；成功时替换场景投影中的当前草稿。
   */
  app.post('/api/v1/templates/:templateId/copy', (req, res) => {
    const templateId = req.params.templateId
    const requestId = 'REQ-P2-TEMPLATE-COPY'
    if (requireDemoRole(req, res, auth, 'TEMPLATE_COPY', templateId) === undefined) return
    if (!isCopyTemplateRequest(req.body)) {
      res.status(422).json(failure('VALIDATION_FAILED', 422, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: '模板复制请求结构不正确。',
        fieldPath: 'name',
      }))
      return
    }
    const template = templates.get(templateId)
    if (!template.ok) {
      res.status(template.status).json(failure(template.code, template.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: template.message,
      }))
      return
    }
    const result = scenarios.copyTemplate(template.data.config, req.body.name, template.data.uiExtensions, req.body.scenarioId)
    if (!result.ok) {
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    res.status(201).json(success(result.data, pageMeta(requestId)))
  })

  /** 校验当前已保存场景并生成确定性 AFSIM 内存脚本预览。 */
  app.post('/api/v1/scripts/preview', (req, res) => {
    const requestId = 'REQ-P2-SCRIPT-PREVIEW'
    const role = requireDemoRole(req, res, auth, 'SCRIPT_PREVIEW')
    if (role === undefined) return
    if (!isScriptPreviewRequest(req.body)) {
      auth.recordError(actorForRequest(req, role), role, 'SCRIPT_PREVIEW')
      res.status(422).json(failure('VALIDATION_FAILED', 422, { requestId, generatedAt: P1_GENERATED_AT, fieldPath: 'request' }))
      return
    }
    const draft = scenarios.get(req.body.scenarioId)
    if (!draft.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SCRIPT_PREVIEW', req.body.scenarioId)
      res.status(422).json(failure('VALIDATION_FAILED', 422, { requestId, generatedAt: P1_GENERATED_AT, message: draft.message, fieldPath: 'scenarioId' }))
      return
    }
    const validation = inspectScenarioConfig(draft.data.config, 'write').result
    if (validation.errors.length > 0) {
      const issue = validation.errors[0]!
      auth.recordError(actorForRequest(req, role), role, 'SCRIPT_PREVIEW', req.body.scenarioId)
      res.status(422).json(failure('VALIDATION_FAILED', 422, { requestId, generatedAt: P1_GENERATED_AT, message: issue.message, fieldPath: issue.fieldPath }))
      return
    }
    if (validation.warnings.length > 0) {
      if (req.body.warningConfirmationId === undefined) {
        auth.recordError(actorForRequest(req, role), role, 'SCRIPT_PREVIEW', req.body.scenarioId)
        res.status(428).json(failure('CONFIRMATION_REQUIRED', 428, { requestId, generatedAt: P1_GENERATED_AT, message: '场景存在校验警告，生成脚本前需要一次性确认。' }))
        return
      }
      const confirmation = confirmations.consume(
        req.body.warningConfirmationId,
        'SCENARIO_WARNING_CONTINUE',
        req.body.scenarioId,
        role,
        confirmationOwner(req)?.id,
        draft.data.revision,
      )
      if (!confirmation.ok) {
        auth.recordError(actorForRequest(req, role), role, 'SCRIPT_PREVIEW', req.body.scenarioId)
        res.status(confirmation.status).json(failure(confirmation.code, confirmation.status, { requestId, generatedAt: P1_GENERATED_AT, message: confirmation.message }))
        return
      }
    }
    try {
      const script = scripts.preview(draft.data)
      auth.recordSuccess(actorForRequest(req, role), role, 'SCRIPT_PREVIEW', req.body.scenarioId)
      res.status(200).json(success(script, pageMeta(requestId)))
    } catch (error) {
      auth.recordError(actorForRequest(req, role), role, 'SCRIPT_PREVIEW', req.body.scenarioId)
      if (error instanceof MissionGenerationError) {
        res.status(422).json(failure('VALIDATION_FAILED', 422, { requestId, generatedAt: P1_GENERATED_AT, message: error.message, fieldPath: error.fieldPath }))
        return
      }
      res.status(500).json(failure('INTERNAL_ERROR', 500, { requestId, generatedAt: P1_GENERATED_AT, message: '脚本预览生成失败。' }))
    }
  })

  /** 本机扩展：只落盘服务端已生成且仍匹配已保存场景的文本。 */
  app.post('/api/v1/scripts/:scriptId/local-file', async (req, res) => {
    const role = requireDemoRole(req, res, auth, 'SCRIPT_FILE_WRITE', req.params.scriptId)
    if (role === undefined) return
    if (!isPreflightRequest(req.body) || Object.keys(req.query).length > 0) {
      res.status(400).json(failure('INVALID_REQUEST', 400, { message: '只允许提交脚本校验和。', fieldPath: 'checksum' }))
      return
    }
    const script = scripts.get(req.params.scriptId)
    const draft = script ? scenarios.get(script.scenarioId) : undefined
    if (!script || script.checksum !== req.body.checksum || !draft?.ok || draft.data.locked
      || script.configVersion !== `${script.scenarioId}-v${draft.data.revision}`) {
      res.status(409).json(failure('VALIDATION_FAILED', 409, { message: '脚本已失效或场景已锁定，请重新保存生成。', fieldPath: 'scriptId' }))
      return
    }
    if (!options.writeScriptText) {
      res.status(503).json(failure('START_FAILED', 503, { message: '当前为纯 Mock 服务，未启用本机 TXT 写入。' }))
      return
    }
    try {
      const path = await options.writeScriptText(script, draft.data.revision, draft.data)
      auth.recordSuccess(actorForRequest(req, role), role, 'SCRIPT_FILE_WRITE', script.scenarioId)
      res.status(200).json(success({ scriptId: script.scriptId, configVersion: script.configVersion, path }, pageMeta('REQ-SCRIPT-FILE')))
    } catch (error) {
      auth.recordError(actorForRequest(req, role), role, 'SCRIPT_FILE_WRITE', script.scenarioId)
      if (error instanceof MissionGenerationError) {
        res.status(422).json(failure('VALIDATION_FAILED', 422, { message: error.message, fieldPath: error.fieldPath }))
        return
      }
      res.status(503).json(failure('START_FAILED', 503, { message: 'TXT 写入失败，请检查 output/scripts 目录权限及磁盘空间后重试。', retryable: true }))
    }
  })

  /** 对已生成脚本执行校验和、结构、版本和路径预检。 */
  app.post('/api/v1/scripts/:scriptId/preflight', (req, res) => {
    const scriptId = req.params.scriptId
    const requestId = 'REQ-P2-SCRIPT-PREFLIGHT'
    const role = requireDemoRole(req, res, auth, 'SCRIPT_PREFLIGHT', scriptId)
    if (role === undefined) return
    if (!isPreflightRequest(req.body)) {
      auth.recordError(actorForRequest(req, role), role, 'SCRIPT_PREFLIGHT', scriptId)
      res.status(422).json(failure('VALIDATION_FAILED', 422, { requestId, generatedAt: P1_GENERATED_AT, fieldPath: 'checksum' }))
      return
    }
    const result = scripts.preflight(scriptId, req.body.checksum)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, role), role, 'SCRIPT_PREFLIGHT', scriptId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'SCRIPT_PREFLIGHT', scriptId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 真实执行结果与固定文件回放分开查询，失败时不能回退到其他来源。 */
  app.get('/api/v1/mission-results', async (req, res) => {
    if (requireDemoRole(req, res, auth, 'REPORT_RESULT_LIST') === undefined) return
    try {
      if (Object.keys(req.query).length) { res.status(400).json(failure('INVALID_REQUEST', 400)); return }
      const records = await options.missionResults?.list() ?? []
      res.json(success(records, pageMeta('REQ-MISSION-RESULT-LIST', records.length, Math.max(1, records.length))))
    } catch { res.status(503).json(failure('START_FAILED', 503, { message: '运行结果读取失败，请检查结果快照。' })) }
  })

  app.get('/api/v1/mission-results/:resultId', async (req, res) => {
    if (requireDemoRole(req, res, auth, 'REPORT_RESULT_READ', req.params.resultId) === undefined) return
    try {
      if (!isMissionResultId(req.params.resultId) || Object.keys(req.query).length) { res.status(400).json(failure('INVALID_REQUEST', 400)); return }
      const snapshot = await options.missionResults?.get(req.params.resultId)
      if (!snapshot) { res.status(404).json(failure('NOT_FOUND', 404, { message: '未找到指定运行结果，未切换到其他文件。' })); return }
      const report = await reportWithQuality(snapshot.report, snapshot.record, snapshot.parameters?.phases)
      res.json(success({ ...snapshot, report }, pageMeta('REQ-MISSION-RESULT-GET')))
    } catch { res.status(503).json(failure('START_FAILED', 503, { message: '运行结果损坏或不可读，未切换到其他文件。' })) }
  })

  /** 返回当前历史回放目录。 */
  app.get('/api/v1/replays', (req, res) => {
    const requestId = 'REQ-P6-REPLAY-LIST'
    if (requireDemoRole(req, res, auth, 'REPLAY_LIST') === undefined) return
    const records = replays.list()
    res.status(200).json(success(records, pageMeta(requestId, records.length, records.length)))
  })

  /** 返回指定回放的只读运行引用与游标。 */
  app.get('/api/v1/replays/:replayId', (req, res) => {
    const replayId = req.params.replayId
    const requestId = 'REQ-P6-REPLAY-GET'
    if (requireDemoRole(req, res, auth, 'REPLAY_READ', replayId) === undefined) return
    const result = replays.get(replayId)
    if (sendReplayFailure(res, result, requestId)) return
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 执行仅改变回放游标和播放状态的命令。 */
  app.post('/api/v1/replays/:replayId/commands', (req, res) => {
    const replayId = req.params.replayId
    const requestId = 'REQ-P6-REPLAY-COMMAND'
    const role = requireDemoRole(req, res, auth, 'REPLAY_COMMAND', replayId)
    if (role === undefined) return
    const result = replays.command(replayId, req.body)
    if (sendReplayFailure(res, result, requestId)) {
      auth.recordError(actorForRequest(req, role), role, 'REPLAY_COMMAND', replayId)
      return
    }
    auth.recordSuccess(actorForRequest(req, role), role, 'REPLAY_COMMAND', replayId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 返回单次仿真报告和批量聚合报告目录。 */
  app.get('/api/v1/reports', async (req, res) => {
    const requestId = 'REQ-P3-REPORT-LIST'
    if (requireDemoRole(req, res, auth, 'REPORT_LIST') === undefined) return
    if (options.loadLocalReport) {
      try {
        const report = await options.loadLocalReport()
        if (report !== null && !isLocalReport(report)) throw new Error('invalid local report')
        const reports = report ? [report] : []
        res.status(200).json(success(reports, pageMeta(requestId, reports.length, reports.length)))
      } catch {
        res.status(503).json(failure('START_FAILED', 503, { message: '本地报告读取失败，请检查事件和位置文件的路径、格式及写入状态后重试。', retryable: true }))
      }
      return
    }
    const report = projection.snapshot().report
    res.status(200).json(success([report], pageMeta(requestId, 1, 1)))
  })

  /** 返回指定的确定性报告，不把另一个来源的数据混入当前报告。 */
  app.get('/api/v1/reports/:reportId', async (req, res) => {
    const reportId = req.params.reportId
    const requestId = 'REQ-P3-REPORT-GET'
    if (requireDemoRole(req, res, auth, 'REPORT_READ', reportId) === undefined) return
    if (options.loadLocalReport) {
      try {
        const report = await options.loadLocalReport()
        if (report !== null && !isLocalReport(report)) throw new Error('invalid local report')
        if (!report || report.reportId !== reportId) {
          res.status(409).json(failure('CONFLICT', 409, { message: '来源文件已变化或当前报告不可用，请重新加载报告目录。', retryable: true }))
          return
        }
        res.status(200).json(success(report, pageMeta(requestId)))
      } catch {
        res.status(503).json(failure('START_FAILED', 503, { message: '本地报告读取失败，不使用演示报告代替。', retryable: true }))
      }
      return
    }
    const report = projection.snapshot().report
    if (report.reportId !== reportId) {
      res.status(404).json(failure('NOT_FOUND', 404, { requestId, generatedAt: P1_GENERATED_AT }))
      return
    }
    res.status(200).json(success(report, pageMeta(requestId)))
  })

  /** Exact result filtering is index-only: current files and legacy snapshots stay readable but cannot be guessed from summary metadata. */
  app.get('/api/v1/reports/:reportId/filter', async (req, res) => {
    const reportId = req.params.reportId
    if (requireDemoRole(req, res, auth, 'REPORT_READ', reportId) === undefined) return
    const resultId = req.query.resultId
    const filterKeys = ['resultId', 'nodeId', 'linkId', 'stage', 'from', 'to']
    const raw: Record<string, unknown> = {}
    for (const key of ['nodeId', 'linkId', 'stage']) if (typeof req.query[key] === 'string') raw[key] = req.query[key]
    for (const key of ['from', 'to']) if (typeof req.query[key] === 'string') raw[key] = Number(req.query[key])
    if (typeof resultId !== 'string' || !isMissionResultId(resultId) || Object.entries(req.query).some(([key, item]) => !filterKeys.includes(key) || typeof item !== 'string')
      || ['from', 'to'].some(key => key in req.query && typeof req.query[key] === 'string' && req.query[key].trim() === '')) {
      res.status(422).json(failure('VALIDATION_FAILED', 422, { message: '筛选来源或条件无效。' })); return
    }
    const filter = parseLocalReportFilter(raw as LocalReportFilter)
    if (!filter) { res.status(422).json(failure('VALIDATION_FAILED', 422, { message: '筛选来源或条件无效。' })); return }
    if (!options.missionResults?.filter) { res.status(409).json(failure('FILTER_UNSUPPORTED', 409, { message: '该历史结果没有完整筛选索引，请重新生成结果。' })); return }
    try {
      const result = await options.missionResults.filter(resultId, baseQualityReportId(reportId), filter)
      const snapshot = await options.missionResults.get(resultId)
      if (!snapshot) throw new Error('FILTER_NOT_FOUND')
      const report = await reportWithQuality(result.report, snapshot.record, snapshot.parameters?.phases, filter, reportId)
      res.status(200).json(success({ ...result, report }, pageMeta('REQ-REPORT-FILTER')))
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      if (code === 'FILTER_NOT_FOUND') res.status(404).json(failure('NOT_FOUND', 404))
      else if (code === 'QUALITY_VERSION_NOT_FOUND') res.status(409).json(failure('VERSION_CONFLICT', 409, { message: '指定质量报告版本不可用，请重新加载。' }))
      else if (code === 'FILTER_INVALID') res.status(422).json(failure('VALIDATION_FAILED', 422, { message: '筛选值不属于本次结果。' }))
      else res.status(409).json(failure('FILTER_UNSUPPORTED', 409, { message: '该历史结果没有完整筛选索引，请重新生成结果。' }))
    }
  })

  /**
   * 本机入口导出真实文件；未注入本机能力的纯 Mock 保持无文件验证。
   * @remarks 三级批量报告仅允许管理员在消费一次性确认后验证。
   */
  app.post('/api/v1/reports/:reportId/export', async (req, res) => {
    const reportId = req.params.reportId
    const requestId = 'REQ-P3-REPORT-EXPORT'
    const role = requireDemoRole(req, res, auth, 'REPORT_EXPORT', reportId)
    if (role === undefined) return
    if (!isReportExportRequest(req.body, reportId)) {
      res.status(422).json(failure('VALIDATION_FAILED', 422, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        fieldPath: 'request',
      }))
      return
    }

    const archiveId = req.query.archiveId
    const resultId = req.query.resultId
    const download = req.query.download
    if (Object.keys(req.query).some(key => !['archiveId', 'resultId', 'download'].includes(key))
      || (archiveId !== undefined && !isLocalArchiveId(archiveId))
      || (resultId !== undefined && !isMissionResultId(resultId))
      || (archiveId !== undefined && resultId !== undefined) || (download !== undefined && download !== '1')) {
      res.status(422).json(failure('VALIDATION_FAILED', 422, { message: '归档编号不正确。', fieldPath: 'archiveId' }))
      return
    }
    if (options.loadLocalReport || archiveId !== undefined || resultId !== undefined) {
      if (!auth.permissionSet(role).permissions.includes('ORDINARY_REPORT_EXPORT')) {
        res.status(403).json(failure('PERMISSION_DENIED', 403))
        return
      }
      if (req.body.format !== 'HTML' && req.body.format !== 'PDF' && req.body.format !== 'CSV') {
        res.status(422).json(failure('VALIDATION_FAILED', 422, { message: '本地报告当前仅支持 HTML、PDF、CSV 真实导出。', fieldPath: 'format' }))
        return
      }
      try {
        const snapshot = typeof resultId === 'string' ? await options.missionResults?.get(resultId) : undefined
        let report = resultId !== undefined ? snapshot?.report ?? null
          : archiveId !== undefined ? options.archiveStorage?.get(archiveId)?.report ?? null : await options.loadLocalReport!()
        if (report !== null && !isLocalReport(report)) throw new Error('invalid local report')
        if (!report || baseQualityReportId(report.reportId) !== baseQualityReportId(reportId)) {
          res.status(409).json(failure('CONFLICT', 409, { message: '来源文件已变化，请重新加载后导出，避免导出与页面不一致。', retryable: true }))
          return
        }
        if (req.body.filter !== undefined) {
          if (typeof resultId !== 'string' || !options.missionResults?.filter) {
            res.status(409).json(failure('FILTER_UNSUPPORTED', 409, { message: '该报告没有完整筛选索引，请重新生成结果。' })); return
          }
          try { report = (await options.missionResults.filter(resultId, baseQualityReportId(reportId), req.body.filter)).report }
          catch { res.status(409).json(failure('FILTER_UNSUPPORTED', 409, { message: '筛选索引不可用或条件无效，请重新生成结果。' })); return }
        }
        if (!options.exportLocalReport) throw new Error('export unavailable')
        let comparisons: MissionResultParameterComparison[] = []
        if (snapshot) {
          // 同一场景最多读取 12 次完成结果；无参数快照的旧结果保留可导出性，但不伪造比较值。
          try {
            const records = await options.missionResults?.list() ?? []
            const candidateIds = [snapshot.record.resultId, ...records.filter(record => record.scenarioId === snapshot.record.scenarioId).map(record => record.resultId)]
            const resolved = await Promise.all([...new Set(candidateIds)].slice(0, 12).map(id => options.missionResults!.get(id)))
            comparisons = resolved.flatMap(candidate => candidate?.parameters === undefined ? [] : [{ record: candidate.record, parameters: candidate.parameters }])
          } catch { comparisons = [] }
        }
        report = await reportWithQuality(report, snapshot?.record, snapshot?.parameters?.phases, req.body.filter, reportId)
        if (report.reportId !== reportId || report.localEvidence?.quality?.source.sha256 !== req.body.qualitySha256) {
          res.status(409).json(failure('VERSION_CONFLICT', 409, { message: '质量来源已变化，请重新加载报告后导出。' }))
          return
        }
        const result = await options.exportLocalReport(report, req.body.format, actorForRequest(req, role), snapshot?.record, comparisons, req.body.filter)
        if (!isLocalReportExport(result) || result.reportId !== reportId || result.format !== req.body.format) throw new Error('invalid export')
        auth.recordSuccess(actorForRequest(req, role), role, 'REPORT_EXPORT', reportId)
        if (download === '1') {
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('X-Content-Type-Options', 'nosniff')
          res.setHeader('Content-Security-Policy', 'sandbox')
          // 跨源（UI 5173 → API 4173）时浏览器脚本须能读到附件头，saveDownload 依赖它确认是合法附件。
          res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
          res.download(result.filePath, `${snapshot?.record.resultId ?? reportId}.${result.format.toLowerCase()}`, error => {
            if (error && !res.headersSent) res.status(503).json(failure('START_FAILED', 503, { message: '报告下载失败，请重试。' }))
          })
          return
        }
        res.status(200).json(success(result, pageMeta(requestId)))
      } catch {
        auth.recordError(actorForRequest(req, role), role, 'REPORT_EXPORT', reportId)
        res.status(503).json(failure('ATOMIC_REPLACE_FAILED', 503, { message: '报告生成或落盘失败，未报告导出成功，请检查文件及输出目录后重试。', retryable: true }))
      }
      return
    }
    const snapshot = projection.snapshot()
    const report = snapshot.report
    if (report.reportId !== reportId) {
      res.status(404).json(failure('NOT_FOUND', 404, { requestId, generatedAt: P1_GENERATED_AT }))
      return
    }

    if (!auth.permissionSet(role).permissions.includes('ORDINARY_REPORT_EXPORT')) {
      res.status(403).json(failure('PERMISSION_DENIED', 403, { requestId, generatedAt: P1_GENERATED_AT }))
      return
    }

    const result: ReportExportResult = {
      reportId: report.reportId,
      generated: false,
      status: 'FIXTURE_SUCCESS',
      watermark: '仅供验证 · 未生成文件',
      verifiedAt: report.classification === 'LEVEL_III'
        ? snapshot.clock.levelThreeVerifiedAt
        : snapshot.clock.reportGeneratedAt,
    }
    res.status(200).json(success(result, pageMeta(requestId)))
  })

  /**
   * 创建受控操作的一次性确认上下文。
   * @param req 包含管理员角色、动作和对象编号的请求。
   * @param res 接收等待确认上下文或请求错误的响应。
   * @returns 无返回值。
   */
  app.post('/api/v1/confirmations', (req, res) => {
    const requestId = 'REQ-P2-CONFIRMATION-CREATE'
    const role = requireDemoRole(req, res, auth, 'CONFIRMATION_CREATE')
    if (role === undefined) return
    if (!isConfirmationRequest(req.body)) {
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        fieldPath: 'request',
      }))
      return
    }
    if (!requireConfirmationPermission(req, role, req.body.action, req.body.objectId, res, auth)) return
    const scenario = req.body.action === 'SCENARIO_WARNING_CONTINUE' ? scenarios.get(req.body.objectId) : undefined
    if (scenario && !scenario.ok) {
      res.status(scenario.status).json(failure(scenario.code, scenario.status, {
        requestId, generatedAt: P1_GENERATED_AT, message: scenario.message,
      }))
      return
    }
    const result = confirmations.create(req.body.action, req.body.objectId, role, confirmationOwner(req), scenario?.ok ? scenario.data.revision : undefined)
    res.status(201).json(success(result, pageMeta(requestId)))
  })

  /**
   * 确认一次等待中的上下文。
   * @param req 包含管理员角色、确认编号和 `confirm: true` 的请求。
   * @param res 接收确认结果或失效错误的响应。
   * @returns 无返回值。
   */
  app.post('/api/v1/confirmations/:confirmationId', (req, res) => {
    const confirmationId = req.params.confirmationId
    const requestId = 'REQ-P2-CONFIRMATION-CONFIRM'
    const role = requireDemoRole(req, res, auth, 'CONFIRMATION_CONFIRM', confirmationId)
    if (role === undefined) return
    if (!isConfirmRequest(req.body)) {
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        fieldPath: 'confirm',
      }))
      return
    }
    const result = confirmations.confirm(confirmationId, role, confirmationOwner(req)?.id)
    if (!result.ok) {
      if (result.code === 'PERMISSION_DENIED') {
        auth.recordDenied(actorForRequest(req, role), role, 'CONFIRMATION_CONFIRM', confirmationId)
      }
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
      }))
      return
    }
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /**
   * 经一次性确认后删除未被引用的官方模板。
   * @param req 包含管理员角色、模板编号和确认编号头的请求。
   * @param res 接收删除结果、确认错误或引用冲突的响应。
   * @returns 无返回值。
   * @remarks 先确认目标存在，再消费确认，最后重新检查引用并执行原子删除。
   */
  app.delete('/api/v1/templates/:templateId', (req, res) => {
    const templateId = req.params.templateId
    const requestId = 'REQ-P2-TEMPLATE-DELETE'
    if (!requireAdmin(req, res, auth, 'TEMPLATE_DELETE', templateId)) return
    const template = templates.get(templateId)
    if (!template.ok) {
      res.status(template.status).json(failure(template.code, template.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: template.message,
      }))
      return
    }
    const confirmationId = req.get('X-Confirmation-Id')
    if (confirmationId === undefined || confirmationId === '') {
      res.status(428).json(failure('CONFIRMATION_REQUIRED', 428, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: '删除官方模板前需要二次确认。',
      }))
      return
    }
    const confirmation = confirmations.consume(confirmationId, 'OFFICIAL_TEMPLATE_DELETE', templateId, 'ADMIN', confirmationOwner(req)?.id)
    if (!confirmation.ok) {
      res.status(confirmation.status).json(failure(confirmation.code, confirmation.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: confirmation.message,
      }))
      return
    }
    const result = templates.delete(templateId)
    if (!result.ok) {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'TEMPLATE_DELETE', templateId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRequest(req, 'ADMIN'), 'ADMIN', 'TEMPLATE_DELETE', templateId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 统一记录系统维护结果并返回既有成功或错误信封。 */
  function finishAdmin<T>(res: Response, action: string, result: AdminResult<T>, objectId?: string, status = 200): void {
    const requestId = `REQ-P7-${action}`
    if (!result.ok) {
      auth.recordError(actorForRequest(res.req, 'ADMIN'), 'ADMIN', action, objectId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId, generatedAt: P1_GENERATED_AT, message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRequest(res.req, 'ADMIN'), 'ADMIN', action, objectId)
    const total = Array.isArray(result.data) ? result.data.length : 1
    res.status(status).json(success(result.data, pageMeta(requestId, total, Math.max(1, total))))
  }

  /** 消费与动作、对象及管理员绑定的一次性确认；失败同样写入审计。 */
  function confirmAdmin(res: Response, confirmationId: unknown, action: ConfirmationAction, objectId: string): boolean {
    const result = !isAdminText(confirmationId)
      ? { ok: false as const, code: 'CONFIRMATION_REQUIRED' as const, status: 428, message: '执行此操作前需要二次确认。' }
      : confirmations.consume(confirmationId, action, objectId, 'ADMIN', confirmationOwner(res.req)?.id)
    if (result.ok) return true
    finishAdmin(res, action, result, objectId)
    return false
  }

  /** 装备参数为空库起步；权限由服务端独立校验。 */
  app.get('/api/v1/admin/access-control', (req, res) => {
    if (!requireAdmin(req, res, auth, 'USER_ROLE_CONFIG_READ')) return
    try { finishAdmin(res, 'USER_ROLE_CONFIG_READ', { ok: true, data: readAccessControl() }) }
    catch { finishAdmin(res, 'USER_ROLE_CONFIG_READ', { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '角色配置读取失败。' }) }
  })
  app.put('/api/v1/admin/access-control', (req, res) => {
    const action = 'USER_ROLE_CONFIG_SAVE'
    if (!requireAdmin(req, res, auth, action)) return
    if (!isAccessControlConfig(req.body)) { finishAdmin(res, action, { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '角色、权限、菜单或分配关系不正确。', fieldPath: 'accessControl' }); return }
    try {
      const users = auth.usersSnapshot()
      const old = readAccessControl()
      const input = req.body
      const actorId = authenticatedUsers.get(req)?.userId ?? 'USR-ADMIN'
      const oldOwn = old.assignments.find(row => row.userId === actorId)
      const newOwn = input.assignments.find(row => row.userId === actorId)
      if (JSON.stringify(oldOwn) !== JSON.stringify(newOwn)
        || (oldOwn && JSON.stringify(old.profiles.find(row => row.profileId === oldOwn.profileId)) !== JSON.stringify(input.profiles.find(row => row.profileId === oldOwn.profileId)))) {
        finishAdmin(res, action, { ok: false, code: 'PERMISSION_DENIED', status: 403, message: '不能修改当前登录管理员自身的角色配置。' }); return
      }
      if (input.assignments.some(row => users.find(user => user.userId === row.userId)?.role !== input.profiles.find(profile => profile.profileId === row.profileId)?.baseRole)) {
        finishAdmin(res, action, { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '角色基础身份必须与被分配账号一致。', fieldPath: 'assignments' }); return
      }
      const saved = { ...input, version: input.version + 1 }
      if (input.version !== old.version || (options.accessControlStorage && !options.accessControlStorage.save(saved, old.version))) {
        finishAdmin(res, action, { ok: false, code: 'VERSION_CONFLICT', status: 409, message: '角色配置已变化，请重新加载。' }); return
      }
      accessControl = structuredClone(saved)
      // 只撤销权限实际变化的账号会话，未分配账号保持原有行为。
      for (const user of users) {
        const profile = (config: AccessControlConfig) => config.profiles.find(p => p.profileId === config.assignments.find(a => a.userId === user.userId)?.profileId)
        if (JSON.stringify(profile(old)) !== JSON.stringify(profile(saved))) options.authStorage?.revokeUser(user.userId)
      }
      realtime?.revalidateSessions()
      finishAdmin(res, action, { ok: true, data: saved })
    } catch { finishAdmin(res, action, { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '角色配置保存未确认，请重新加载核实。' }) }
  })

  app.get('/api/v1/admin/equipment/:equipmentId/details', (req, res) => {
    if (!requireAdmin(req, res, auth, 'MASTER_DATA_EQUIPMENT_DETAILS')) return
    try { finishAdmin(res, 'MASTER_DATA_EQUIPMENT_DETAILS', { ok: true, data: admin.equipmentDetails(req.params.equipmentId) }) }
    catch { finishAdmin(res, 'MASTER_DATA_EQUIPMENT_DETAILS', { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '装备引用与版本读取失败。' }) }
  })

  app.put('/api/v1/admin/equipment/:equipmentId/reference', (req, res) => {
    const action = 'MASTER_DATA_EQUIPMENT_REFERENCE'
    if (!requireAdmin(req, res, auth, action)) return
    if (!isStrictObject(req.body, ['reference', 'remove']) || typeof req.body.remove !== 'boolean'
      || !isEquipmentReference(req.body.reference) || req.body.reference.equipmentId !== req.params.equipmentId) {
      finishAdmin(res, action, { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '引用参数不正确。', fieldPath: 'reference' }); return
    }
    const reference = req.body.reference
    try {
      if (!req.body.remove) {
        const equipment = admin.listEquipment().find(row => row.equipmentId === reference.equipmentId)
        const scene = scenarios.get(reference.scenarioId)
        if (!equipment || !scene.ok || !scene.data.config.links.some(link => link.id === reference.linkId)) {
          finishAdmin(res, action, { ok: false, code: 'NOT_FOUND', status: 404, message: '装备、场景或链路不存在。' }); return
        }
        if (equipment.active === false) {
          finishAdmin(res, action, { ok: false, code: 'CONFLICT', status: 409, message: '装备已停用，不能登记新引用。' }); return
        }
        if (equipment.version !== reference.equipmentVersion || scene.data.locked) {
          finishAdmin(res, action, { ok: false, code: 'CONFLICT', status: 409, message: '装备版本已变化或场景已锁定，请刷新后重试。' }); return
        }
        const typeIssue = equipmentTypeIssue(equipment.type, scene.data.config.links.find(link => link.id === reference.linkId)!.type)
        if (typeIssue) {
          finishAdmin(res, action, { ok: false, code: 'VALIDATION_FAILED', status: 422, message: typeIssue, fieldPath: 'reference.linkId' }); return
        }
      } else {
        const scene = scenarios.get(reference.scenarioId)
        if (scene.ok && scene.data.locked) { finishAdmin(res, action, { ok: false, code: 'CONFIG_LOCKED', status: 409, message: '场景已锁定，不能解除引用。' }); return }
        if (scene.ok && (scene.data.config.links.some(link => link.id === reference.linkId
          && link.parameterSource?.kind === 'EQUIPMENT' && link.parameterSource.sourceId === reference.equipmentId)
          || portParameterTargets(scene.data.config).some(target => target.id === reference.linkId
            && target.parameters.parameterSource?.kind === 'EQUIPMENT' && target.parameters.parameterSource.sourceId === reference.equipmentId))) {
          finishAdmin(res, action, { ok: false, code: 'CONFLICT', status: 409, message: '链路仍使用该装备参数，请先在链路中取消引用并保存场景。', fieldPath: 'reference.linkId' }); return
        }
      }
      admin.setEquipmentReference(reference, req.body.remove)
      finishAdmin(res, action, { ok: true, data: admin.equipmentDetails(reference.equipmentId) }, reference.equipmentId)
    } catch { finishAdmin(res, action, { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '装备引用保存失败，请重新加载。' }) }
  })

  app.get('/api/v1/admin/equipment', (req, res) => {
    if (!requireAdmin(req, res, auth, 'MASTER_DATA_EQUIPMENT_LIST')) return
    try { finishAdmin(res, 'MASTER_DATA_EQUIPMENT_LIST', { ok: true, data: admin.listEquipment() }) }
    catch { finishAdmin(res, 'MASTER_DATA_EQUIPMENT_LIST', { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '装备参数读取失败，未回退到演示数据。' }) }
  })

  for (const method of ['post', 'put'] as const) {
    app[method](`/api/v1/admin/equipment${method === 'put' ? '/:equipmentId' : ''}`, (req, res) => {
      const id = 'equipmentId' in req.params ? req.params.equipmentId : undefined
      let action = method === 'post' ? 'MASTER_DATA_EQUIPMENT_CREATE' : 'MASTER_DATA_EQUIPMENT_UPDATE'
      if (!requireAdmin(req, res, auth, action, id)) return
      try {
        const existing = id === undefined ? undefined : admin.listEquipment().find(row => row.equipmentId === id)
        if (existing && typeof req.body?.active === 'boolean' && (existing.active !== false) !== req.body.active) {
          action = req.body.active ? 'MASTER_DATA_EQUIPMENT_ENABLE' : 'MASTER_DATA_EQUIPMENT_DISABLE'
        }
        finishAdmin(res, action, admin.saveEquipment(req.body, id), id ?? (isAdminText(req.body?.equipmentId) ? req.body.equipmentId : undefined), method === 'post' ? 201 : 200)
      }
      catch { finishAdmin(res, action, { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '装备参数保存失败，请稍后重试。' }, id) }
    })
  }

  app.delete('/api/v1/admin/equipment/:equipmentId', (req, res) => {
    const id = req.params.equipmentId
    const action = 'MASTER_DATA_EQUIPMENT_DELETE'
    if (!requireAdmin(req, res, auth, action, id)) return
    const version = req.query.expectedVersion
    if (typeof version !== 'string' || !/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(Number(version)) || Object.keys(req.query).length !== 1) {
      finishAdmin(res, action, { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '删除须携带有效的当前版本。', fieldPath: 'expectedVersion' }, id)
      return
    }
    // 使用独立对象命名空间，通用数据删除确认不能用于装备删除。
    if (!confirmAdmin(res, req.get('X-Confirmation-Id'), 'MASTER_DATA_DELETE', `EQUIPMENT:${id}:${version}`)) return
    try { finishAdmin(res, action, admin.deleteEquipment(id, Number(version)), id) }
    catch { finishAdmin(res, action, { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '装备参数删除失败，请刷新后核实。' }, id) }
  })

  /** 读取通用数据；权限由服务端独立校验。 */
  app.get('/api/v1/admin/master-data', (req, res) => {
    if (!requireAdmin(req, res, auth, 'MASTER_DATA_LIST')) return
    try { finishAdmin(res, 'MASTER_DATA_LIST', { ok: true, data: admin.listMasterData() }) }
    catch { finishAdmin(res, 'MASTER_DATA_LIST', { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '通用数据读取失败，未回退到演示数据。' }) }
  })

  /** 返回当前可登记的真实场景、模板及其版本；不把通用数据自动应用到目标。 */
  app.get('/api/v1/admin/master-data/targets', (req, res) => {
    const action = 'MASTER_DATA_TARGET_LIST'
    if (!requireAdmin(req, res, auth, action)) return
    try {
      const targets = [
        ...scenarios.list().map(draft => ({ targetType: 'SCENARIO' as const, targetId: draft.config.scenario.id,
          targetVersion: String(draft.revision), name: draft.config.scenario.name })),
        ...templates.list().map(template => ({ targetType: 'TEMPLATE' as const, targetId: template.templateId,
          targetVersion: template.version, name: template.name })),
      ]
      finishAdmin(res, action, { ok: true, data: targets })
    } catch { finishAdmin(res, action, { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '引用目标读取失败，请重新加载。' }) }
  })

  /** 返回版本快照与已登记关系；旧 fixture 的引用数不被伪造成详细关系。 */
  app.get('/api/v1/admin/master-data/:dataId/details', (req, res) => {
    const action = 'MASTER_DATA_DETAILS'
    if (!requireAdmin(req, res, auth, action, req.params.dataId)) return
    try {
      const details = admin.masterDataDetails(req.params.dataId)
      if (details.history.length === 0) {
        finishAdmin(res, action, { ok: false, code: 'NOT_FOUND', status: 404, message: '通用数据不存在。' }, req.params.dataId)
        return
      }
      finishAdmin(res, action, { ok: true, data: details }, req.params.dataId)
    } catch { finishAdmin(res, action, { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '通用数据历史读取失败，请重新加载。' }, req.params.dataId) }
  })

  /** 显式登记已选通用数据版本和当前目标版本，登记不会修改场景或模板配置。 */
  app.put('/api/v1/admin/master-data/:dataId/reference', (req, res) => {
    const action = 'MASTER_DATA_REFERENCE'
    const dataId = req.params.dataId
    if (!requireAdmin(req, res, auth, action, dataId)) return
    if (!isMasterReference(req.body) || req.body.dataId !== dataId) {
      finishAdmin(res, action, { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '通用数据引用参数不正确。', fieldPath: 'request' }, dataId)
      return
    }
    const reference = req.body
    try {
      if (reference.targetType === 'SCENARIO') {
        const scene = scenarios.get(reference.targetId)
        if (!scene.ok) {
          finishAdmin(res, action, { ok: false, code: 'NOT_FOUND', status: 404, message: '引用场景不存在。', fieldPath: 'targetId' }, dataId)
          return
        }
        if (scene.data.locked) {
          finishAdmin(res, action, { ok: false, code: 'CONFIG_LOCKED', status: 409, message: '场景已锁定，不能登记引用。' }, dataId)
          return
        }
        if (reference.targetVersion !== String(scene.data.revision)) {
          finishAdmin(res, action, { ok: false, code: 'VERSION_CONFLICT', status: 409, message: '场景版本已变化，请重新加载后登记。', fieldPath: 'targetVersion' }, dataId)
          return
        }
      } else {
        const template = templates.get(reference.targetId)
        if (!template.ok) {
          finishAdmin(res, action, { ok: false, code: 'NOT_FOUND', status: 404, message: '引用模板不存在。', fieldPath: 'targetId' }, dataId)
          return
        }
        if (reference.targetVersion !== template.data.version) {
          finishAdmin(res, action, { ok: false, code: 'VERSION_CONFLICT', status: 409, message: '模板版本已变化，请重新加载后登记。', fieldPath: 'targetVersion' }, dataId)
          return
        }
      }
      finishAdmin(res, action, admin.addMasterDataReference(reference), dataId)
    } catch { finishAdmin(res, action, { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '通用数据引用保存失败，请重新加载。' }, dataId) }
  })

  /** 创建通用数据；真实存储与纯 Mock 共用内容、版本和引用数量校验。 */
  app.post('/api/v1/admin/master-data', (req, res) => {
    if (!requireAdmin(req, res, auth, 'MASTER_DATA_CREATE')) return
    try { finishAdmin(res, 'MASTER_DATA_CREATE', admin.saveMasterData(req.body), isAdminText(req.body?.data?.dataId) ? req.body.data.dataId : undefined, 201) }
    catch { finishAdmin(res, 'MASTER_DATA_CREATE', { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '通用数据保存失败，请稍后重试。' }) }
  })

  /** 按路径编号和期望版本更新通用数据。 */
  app.put('/api/v1/admin/master-data/:dataId', (req, res) => {
    if (!requireAdmin(req, res, auth, 'MASTER_DATA_UPDATE', req.params.dataId)) return
    try { finishAdmin(res, 'MASTER_DATA_UPDATE', admin.saveMasterData(req.body, req.params.dataId), req.params.dataId) }
    catch { finishAdmin(res, 'MASTER_DATA_UPDATE', { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '通用数据保存失败，请稍后重试。' }, req.params.dataId) }
  })

  /** 删除前消费确认，并重新校验服务器持有的引用数量。 */
  app.delete('/api/v1/admin/master-data/:dataId', (req, res) => {
    const dataId = req.params.dataId
    if (!requireAdmin(req, res, auth, 'MASTER_DATA_DELETE', dataId)) return
    if (!confirmAdmin(res, req.get('X-Confirmation-Id'), 'MASTER_DATA_DELETE', dataId)) return
    try { finishAdmin(res, 'MASTER_DATA_DELETE', admin.deleteMasterData(dataId), dataId) }
    catch { finishAdmin(res, 'MASTER_DATA_DELETE', { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '通用数据删除失败，请重新加载核实。' }, dataId) }
  })

  /** 返回可供恢复选择的备份目录。 */
  app.get('/api/v1/admin/backups', (req, res) => {
    if (!requireAdmin(req, res, auth, 'BACKUP_LIST')) return
    try { finishAdmin(res, 'BACKUP_LIST', { ok: true, data: admin.listBackups() }) }
    catch { finishAdmin(res, 'BACKUP_LIST', { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '备份目录读取失败，未回退到演示记录。' }) }
  })

  /** 校验并执行备份；确认不能用于恢复操作。 */
  app.post('/api/v1/admin/backup', (req, res) => {
    if (!requireAdmin(req, res, auth, 'BACKUP_CREATE')) return
    if (!isStrictObject(req.body, ['operation'], ['backupId', 'confirmationId', 'name']) || req.body.operation !== 'BACKUP'
      || (req.body.name !== undefined && (!isAdminText(req.body.name) || req.body.name.length > 80))
      || (req.body.backupId !== undefined && !isAdminText(req.body.backupId))) {
      finishAdmin(res, 'BACKUP_CREATE', { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '备份请求不正确。', fieldPath: 'request' })
      return
    }
    if (!confirmAdmin(res, req.body.confirmationId, 'BACKUP_RESTORE', `BACKUP:${req.body.backupId ?? 'NEW'}`)) return
    finishAdmin(res, 'BACKUP_CREATE', admin.backup(req.body.backupId as string | undefined, req.body.name as string | undefined))
  })

  app.get('/api/v1/admin/backup-plan', (req, res) => {
    if (!requireAdmin(req, res, auth, 'BACKUP_PLAN_READ')) return
    try { finishAdmin(res, 'BACKUP_PLAN_READ', { ok: true, data: admin.backupPlan() }) }
    catch { finishAdmin(res, 'BACKUP_PLAN_READ', { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '备份计划读取失败。' }) }
  })
  app.put('/api/v1/admin/backup-plan', (req, res) => {
    if (!requireAdmin(req, res, auth, 'BACKUP_PLAN_UPDATE')) return
    if (!isBackupPlan(req.body)) { finishAdmin(res, 'BACKUP_PLAN_UPDATE', { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '备份计划参数不正确。', fieldPath: 'plan' }); return }
    try { finishAdmin(res, 'BACKUP_PLAN_UPDATE', admin.saveBackupPlan(req.body)) }
    catch { finishAdmin(res, 'BACKUP_PLAN_UPDATE', { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '备份计划保存失败，请刷新核实。' }) }
  })

  /** 恢复结果包含预备份和完整性证据；损坏数据不会开始恢复。 */
  app.post('/api/v1/admin/restore', (req, res) => {
    if (!requireAdmin(req, res, auth, 'BACKUP_RESTORE')) return
    if (hasMissions()) {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'BACKUP_RESTORE')
      res.status(409).json(failure('INVALID_TRANSITION', 409, { message: '请先停止 mission，再恢复备份。' }))
      return
    }
    if (!isStrictObject(req.body, ['operation', 'backupId'], ['confirmationId']) || req.body.operation !== 'RESTORE' || !isAdminText(req.body.backupId)) {
      finishAdmin(res, 'BACKUP_RESTORE', { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '恢复请求不正确。', fieldPath: 'backupId' })
      return
    }
    if (!confirmAdmin(res, req.body.confirmationId, 'BACKUP_RESTORE', `RESTORE:${req.body.backupId}`)) return
    const result = admin.restore(req.body.backupId)
    if (result.ok && result.data.generated && result.data.result === 'SUCCESS') {
      options.authStorage?.revokeAllSessions()
      realtime.reset()
      simulations.reset()
      missions.clear()
      scenarios.reset()
      templates.reset()
      confirmations.reset()
      scripts.reset()
      replays.reset()
    }
    if (result.ok && result.data.result === 'FAILURE') {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'BACKUP_RESTORE', req.body.backupId)
      res.status(200).json(success(result.data, pageMeta('REQ-P7-BACKUP_RESTORE')))
      return
    }
    finishAdmin(res, 'BACKUP_RESTORE', result, req.body.backupId)
  })

  /** 管理员主动登记真实文件快照，不推断场景或运行归属。 */
  app.get('/api/v1/admin/local-archives', (req, res) => {
    if (!requireAdmin(req, res, auth, 'ARCHIVE_LIST')) return
    try {
      const records = options.archiveStorage?.list() ?? []
      res.status(200).json(success(records, pageMeta('REQ-LOCAL-ARCHIVE-LIST', records.length, records.length)))
    } catch {
      res.status(503).json(failure('START_FAILED', 503, { message: '归档目录校验失败，请检查归档库完整性。', retryable: true }))
    }
  })

  app.post('/api/v1/admin/local-archives', async (req, res) => {
    if (!requireAdmin(req, res, auth, 'ARCHIVE_CREATE')) return
    if (!isStrictObject(req.body, ['name']) || typeof req.body.name !== 'string' || !req.body.name.trim() || req.body.name.length > 80) {
      res.status(422).json(failure('VALIDATION_FAILED', 422, { message: '请输入不超过 80 字的归档名称。', fieldPath: 'name' }))
      return
    }
    try {
      if (!options.archiveStorage || !options.loadLocalReplay || !options.loadLocalReport) throw new Error('archive unavailable')
      const [replay, report] = await Promise.all([options.loadLocalReplay(), options.loadLocalReport()])
      if (!report) throw new Error('no local report')
      const record = options.archiveStorage.register(req.body.name.trim(), actorForRequest(req, 'ADMIN'), replay, report)
      auth.recordSuccess(actorForRequest(req, 'ADMIN'), 'ADMIN', 'ARCHIVE_CREATE', record.archiveId)
      res.status(201).json(success(record, pageMeta('REQ-LOCAL-ARCHIVE-CREATE')))
    } catch {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'ARCHIVE_CREATE')
      res.status(503).json(failure('START_FAILED', 503, { message: '归档失败：真实数据未配置、来源已变化或归档库不可用，请刷新后重试。', retryable: true }))
    }
  })

  /** 回放和评估读取同一份已校验的持久化快照，不回退最新文件或演示夹具。 */
  app.get('/api/v1/archives/:archiveId', (req, res) => {
    if (requireDemoRole(req, res, auth, 'ARCHIVE_READ') === undefined) return
    if (!isLocalArchiveId(req.params.archiveId)) {
      res.status(422).json(failure('VALIDATION_FAILED', 422, { message: '归档编号不正确。', fieldPath: 'archiveId' }))
      return
    }
    try {
      const snapshot = options.archiveStorage?.get(req.params.archiveId)
      if (!snapshot) {
        res.status(404).json(failure('NOT_FOUND', 404, { message: '归档不存在，不使用其他数据代替。', fieldPath: 'archiveId' }))
        return
      }
      res.status(200).json(success(snapshot, pageMeta('REQ-LOCAL-ARCHIVE-READ')))
    } catch {
      res.status(503).json(failure('START_FAILED', 503, { message: '归档数据损坏或存储不可用，请检查归档库。', retryable: true }))
    }
  })

  app.get('/api/v1/admin/archives', (req, res) => {
    if (!requireAdmin(req, res, auth, 'ARCHIVE_LIST')) return
    finishAdmin(res, 'ARCHIVE_LIST', { ok: true, data: [projection.snapshot().archive] })
  })

  /** 读取健康状态合同；未接入的依赖保持明确的未接入状态。 */
  app.get('/api/v1/admin/health', (req, res) => {
    if (!requireAdmin(req, res, auth, 'HEALTH_READ')) return
    finishAdmin(res, 'HEALTH_READ', { ok: true, data: projection.snapshot().diagnostics })
  })

  /** 验证管理员完整配置导出；不创建文件。 */
  app.post('/api/v1/admin/config/export', (req, res) => {
    if (!requireAdmin(req, res, auth, 'FULL_CONFIG_EXPORT')) return
    if (!isStrictObject(req.body, ['format'], ['confirmationId']) || req.body.format !== 'JSON') {
      finishAdmin(res, 'FULL_CONFIG_EXPORT', { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '完整配置仅支持 JSON 格式。', fieldPath: 'format' })
      return
    }
    if (!confirmAdmin(res, req.body.confirmationId, 'FULL_CONFIG_EXPORT', 'FULL-CONFIG')) return
    const result: ExportStatus = { objectId: 'FULL-CONFIG', generated: false, classification: 'INTERNAL', watermark: '内部使用 · admin · FULL-CONFIG', verifiedAt: P1_GENERATED_AT }
    finishAdmin(res, 'FULL_CONFIG_EXPORT', { ok: true, data: result }, 'FULL-CONFIG')
  })

  /** Returns the immutable audit projection after applying validated administrator filters. */
  app.get('/api/v1/admin/audit', (req, res) => {
    const requestId = 'REQ-P7-AUDIT-LIST'
    if (!requireAdmin(req, res, auth, 'AUDIT_LIST')) return
    const filters = auditRequestFromQuery(req)
    if (filters === undefined) {
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        fieldPath: 'query',
      }))
      return
    }
    const records = sortAudit(filterAudit(auth.auditSnapshot(), filters.filters), filters.sortOrder)
    const start = (filters.page - 1) * filters.pageSize
    res.status(200).json(success(records.slice(start, start + filters.pageSize), {
      ...pageMeta(requestId, records.length, filters.pageSize), page: filters.page,
    }))
  })

  /** Deletes only a fully-resolved audit selection and leaves an AUDIT_DELETE evidence record. */
  app.post('/api/v1/admin/audit/delete', (req, res) => {
    const requestId = 'REQ-P7-AUDIT-DELETE'
    if (!requireAdmin(req, res, auth, 'AUDIT_DELETE', 'AUDIT-LOG')) return
    if (!isAuditDeleteRequest(req.body)) {
      res.status(400).json(failure('INVALID_REQUEST', 400, { requestId, generatedAt: P1_GENERATED_AT, fieldPath: 'auditIds' }))
      return
    }
    try {
      const result = auth.deleteAudit(actorForRequest(req, 'ADMIN'), req.body.auditIds)
      if (!result.ok) {
        res.status(404).json(failure(result.code, result.status, { requestId, generatedAt: P1_GENERATED_AT, fieldPath: 'auditIds' }))
        return
      }
      res.status(200).json(success<AuditDeleteResult>(result.data, pageMeta(requestId)))
    } catch {
      res.status(500).json(failure('INTERNAL_ERROR', 500, { requestId, generatedAt: P1_GENERATED_AT }))
    }
  })

  /** 按同一查询规则导出确认后的只读快照，不在服务器写入临时文件。 */
  app.post('/api/v1/admin/audit/export', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const requestId = 'REQ-P7-AUDIT-EXPORT'
    if (!requireAdmin(req, res, auth, 'AUDIT_EXPORT', 'AUDIT-LOG')) return
    if (!isAuditRequest(req.body, true)) {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'AUDIT_EXPORT', 'AUDIT-LOG')
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        fieldPath: 'request',
      }))
      return
    }
    if (req.body.confirmationId === undefined) {
      auth.recordDenied(actorForRequest(req, 'ADMIN'), 'ADMIN', 'AUDIT_EXPORT', 'AUDIT-LOG')
      res.status(428).json(failure('CONFIRMATION_REQUIRED', 428, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: '导出操作审计日志前需要二次确认。',
      }))
      return
    }
    const confirmation = confirmations.consume(req.body.confirmationId, 'AUDIT_EXPORT', 'AUDIT-LOG', 'ADMIN', confirmationOwner(req)?.id)
    if (!confirmation.ok) {
      auth.recordDenied(actorForRequest(req, 'ADMIN'), 'ADMIN', 'AUDIT_EXPORT', 'AUDIT-LOG')
      res.status(confirmation.status).json(failure(confirmation.code, confirmation.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: confirmation.message,
      }))
      return
    }
    try {
      const actor = actorForRequest(req, 'ADMIN')
      const verifiedAt = options.authStorage?.time() ?? P1_GENERATED_AT
      const records = filterAudit(auth.auditSnapshot(), req.body)
      const result = buildAuditExport(records, req.body, actor, verifiedAt, req.body.confirmationId)
      // 先记录本次导出，再返回文件；本次操作不混入刚取得的导出快照。
      auth.recordSuccess(actor, 'ADMIN', 'AUDIT_EXPORT', 'AUDIT-LOG')
      res.status(200).json(success(result, { ...pageMeta(requestId), generatedAt: verifiedAt }))
    } catch {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'AUDIT_EXPORT', 'AUDIT-LOG')
      res.status(400).json(failure('INVALID_REQUEST', 400, { requestId, message: '审计日志导出失败，请检查存储后重新发起确认。' }))
    }
  })

  /**
   * Returns the current detached user snapshot.
   *
   * @param req - Authorized administrator request.
   * @param res - Response receiving the paginated user envelope.
   * @returns Nothing.
   * @remarks Appends a USER_LIST success audit and writes one response without exposing references.
   */
  app.get('/api/v1/admin/users', (req, res) => {
    const requestId = 'REQ-P1-USERS-LIST'
    const users = auth.usersSnapshot()
    auth.recordSuccess(actorForRequest(req, 'ADMIN'), 'ADMIN', 'USER_LIST')
    res.status(200).json(success(users, pageMeta(requestId, users.length, Math.max(1, users.length))))
  })

  /**
   * Validates and executes an administrator user-creation command.
   *
   * @param req - Authorized request containing a CREATE command.
   * @param res - Response receiving the created user or typed failure.
   * @returns Nothing.
   * @remarks May mutate the user projection and always records the terminal creation outcome.
   */
  app.post('/api/v1/admin/users', (req, res) => {
    const requestId = 'REQ-P1-USERS-CREATE'
    if (!isManagedUsername(req.body?.user?.username)) {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'USER_CREATE')
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId, generatedAt: P1_GENERATED_AT, fieldPath: 'user.username', message: '用户名须为 1–64 位，且不能包含首尾空格。',
      }))
      return
    }
    if (req.body?.operation === 'CREATE' && typeof req.body.password === 'string' && !req.body.password.trim()) {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'USER_CREATE')
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId, generatedAt: P1_GENERATED_AT, fieldPath: 'password', message: '密码不能全为空白。',
      }))
      return
    }
    if (!isUserRoleCommand(req.body) || req.body.operation !== 'CREATE') {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'USER_CREATE')
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        fieldPath: 'operation',
      }))
      return
    }

    const result = auth.create(req.body, actorForRequest(req, 'ADMIN'))
    if (sendProjectionFailure(res, result, requestId)) {
      return
    }
    res.status(201).json(success(result.data, pageMeta(requestId)))
  })

  /**
   * Validates path/body ownership and executes update, enable, or disable.
   *
   * @param req - Authorized request containing path identity and a user-role command.
   * @param res - Response receiving the updated user or typed failure.
   * @returns Nothing.
   * @remarks May replace one projected user and records every terminal mutation outcome.
   */
  app.put('/api/v1/admin/users/:userId', (req, res) => {
    const userId = req.params.userId
    const requestId = 'REQ-P1-USERS-UPDATE'
    if (req.body?.operation === 'UPDATE' && !isManagedUsername(req.body?.user?.username)) {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'USER_UPDATE', userId)
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId, generatedAt: P1_GENERATED_AT, fieldPath: 'user.username', message: '用户名须为 1–64 位，且不能包含首尾空格。',
      }))
      return
    }
    if (!isUserRoleCommand(req.body)) {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'USER_UPDATE', userId)
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId,
        generatedAt: P1_GENERATED_AT,
      }))
      return
    }
    if (req.body.user.userId !== userId) {
      auth.recordError(actorForRequest(req, 'ADMIN'), 'ADMIN', 'USER_UPDATE', userId)
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        fieldPath: 'user.userId',
      }))
      return
    }

    const result = auth.update(userId, req.body, actorForRequest(req, 'ADMIN'), confirmationOwner(req)?.id)
    realtime?.revalidateSessions()
    if (sendProjectionFailure(res, result, requestId)) {
      return
    }
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /**
   * Executes guarded deletion for the path-owned user identifier.
   *
   * @param req - Authorized request containing the target userId.
   * @param res - Response receiving the deletion result or typed failure.
   * @returns Nothing.
   * @remarks May remove one projected user after admin guards and records the terminal outcome.
   */
  app.delete('/api/v1/admin/users/:userId', (req, res) => {
    const userId = req.params.userId
    const requestId = 'REQ-P1-USERS-DELETE'
    const result = auth.delete(userId, actorForRequest(req, 'ADMIN'), confirmationOwner(req)?.id)
    realtime?.revalidateSessions()
    if (sendProjectionFailure(res, result, requestId)) {
      return
    }
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /**
   * Validates and executes a deterministic reset.
   *
   * @param req - Request containing role authorization and reset confirmation.
   * @param res - Response receiving the reset transcript or typed rejection.
   * @returns Nothing.
   * @remarks On success resets realtime and authentication projections before writing the response.
   */
  app.post('/api/v1/reset', (req, res) => {
    if (!requireAdmin(req, res, auth, 'SCENARIO_RESET')) return
    const role = 'ADMIN'

    if (!isResetRequest(req.body)) {
      res.status(400).json(failure('INVALID_REQUEST', 400, { fieldPath: 'confirm' }))
      return
    }

    if (hasMissions()) {
      auth.recordError(actorForRequest(req, role), role, 'SCENARIO_RESET')
      res.status(409).json(failure('INVALID_TRANSITION', 409, { message: '请先停止 mission，再执行全局重置。' }))
      return
    }
    // 本机场景只重载数据库，不用全局演示 reset 覆盖用户已保存配置。
    try {
      templates.reset()
      scenarios.reset()
    } catch {
      res.status(503).json(failure('ATOMIC_REPLACE_FAILED', 503, { message: '场景或模板数据库读取失败，未执行全局重置。' }))
      return
    }
    const result: ResetResult = realtime.reset()
    auth.reset()
    simulations.reset()
    missions.clear()
    confirmations.reset()
    scripts.reset()
    replays.reset()
    admin.reset()
    res.status(200).json(success(result, {
      requestId: result.requestId,
      generatedAt: result.generatedAt,
      page: 1,
      pageSize: 1,
      total: 1,
    }))
  })

  /**
   * Handles unmatched API routes with the canonical not-found envelope.
   *
   * @param _req - Unmatched API request.
   * @param res - Response receiving the 404 envelope.
   * @returns Nothing.
   * @remarks Sends one response and performs no projection mutation.
   */
  app.use('/api', (_req, res) => {
    res.status(404).json(failure('NOT_FOUND', 404))
  })

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const parserErrorType = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined
    const parserStatus = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
    const parserClientError = typeof parserErrorType === 'string'
      && typeof parserStatus === 'number' && parserStatus >= 400 && parserStatus < 500
      && ['entity.parse.failed', 'entity.too.large', 'entity.verify.failed', 'request.aborted',
        'request.size.invalid', 'charset.unsupported', 'encoding.unsupported', 'parameters.too.many']
        .includes(parserErrorType)
    if (parserClientError && options.authStorage && ['/api/v1/auth/login', '/api/v1/auth/logout'].includes(req.path)) {
      const user = options.authStorage.currentUser(req.headers.cookie)
      auth.recordError(user?.username ?? 'anonymous', user?.role ?? 'OPERATOR', req.path.endsWith('/login') ? 'AUTH_LOGIN' : 'AUTH_LOGOUT', user?.userId)
    }
    if (parserClientError) {
      const message = parserErrorType === 'entity.too.large' ? '请求体超过 256 KB 限制。'
        : parserErrorType === 'entity.parse.failed' ? '请求 JSON 格式不正确。' : '请求体无法解析。'
      res.status(400).json(failure('INVALID_REQUEST', 400, { message }))
      return
    }
    res.status(500).json(failure('INTERNAL_ERROR', 500, { message: '服务端处理失败，请稍后重试。' }))
  })

  const httpServer = createServer(app)
  realtime = attachRealtimeServer(httpServer, projection, (taskId?: TaskId) => simulations.current(taskId), options.authStorage
    ? request => {
      const allowed = options.authStorage!.currentUser(request.headers.cookie) !== undefined
      if (!allowed) auth.recordDenied('anonymous', 'OPERATOR', 'AUTH_WS_DENIED')
      return allowed
    } : undefined, publicOrigin, undefined, { journal: options.realtimeJournal })
  httpServer.listen(port, publicOrigin ? options.host ?? '0.0.0.0' : '127.0.0.1')
  if (options.authStorage) httpServer.once('close', options.authStorage.watchSessions(() => realtime?.revalidateSessions()))

  let closePromise: Promise<void> | undefined
  let realtimeClosed = false
  let httpClosed = false
  return {
    httpServer,
    projection,
    /**
     * Returns a detached authentication audit snapshot.
     *
     * @returns Deep-cloned audit records safe for caller mutation.
     * @remarks Reads state without mutating it.
     */
    auditSnapshot: () => auth.auditSnapshot(),
    /**
     * Closes realtime and HTTP listeners idempotently.
     *
     * @returns The shared shutdown promise.
     * @remarks 并发调用共享结果；失败后可重试未完成步骤，成功步骤不重复执行。
     */
    close: () => {
      closing = true
      closePromise ??= (async () => {
        const errors: unknown[] = []
        const stopped = await Promise.allSettled([...missions.values()].map(async slot => {
          await slot.starting?.catch(() => undefined)
          await slot.mission?.stop()
          slot.mission = undefined
        }))
        for (const result of stopped) if (result.status === 'rejected') errors.push(result.reason)
        if (!realtimeClosed) {
          try { await realtime.close(); realtimeClosed = true } catch (error) { errors.push(error) }
        }
        // 进程或 WS 清理失败也必须关闭 HTTP；close 事件仅在在途请求结束后释放存储。
        if (!httpClosed) {
          try {
            await new Promise<void>((resolve, rejectClose) => {
              httpServer.close(error => error === undefined ? resolve() : rejectClose(error))
            })
            httpClosed = true
          } catch (error) { errors.push(error) }
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) throw new AggregateError(errors, '服务关闭存在多个清理错误。')
      })().catch(error => { closePromise = undefined; throw error })
      return closePromise
    },
  }
}

import { createServer, type Server as HttpServer } from 'node:http'
import express, { type NextFunction, type Request, type Response } from 'express'
import type {
  AuditRequest,
  AuditRecord,
  ConfirmationAction,
  ExportStatus,
  LoginRequest,
  PageMeta,
  PreflightRequest,
  Report,
  ReportExportRequest,
  ReportExportResult,
  ResetRequest,
  ResetResult,
  Role,
  ScriptPreviewRequest,
  User,
  UserRoleCommand,
} from '../src/contracts/domain-models.js'
import {
  AuthProjection,
  type ProjectionFailure,
  type ProjectionResult,
} from './auth/projection.js'
import { failure, success } from './http/envelope.js'
import { assertLoopbackRequest } from './http/loopback.js'
import { ScenarioProjection } from './scenarios/projection.js'
import { SimulationProjection, type SimulationProjectionResult } from './simulations/projection.js'
import { ScriptProjection } from './scripts/projection.js'
import { MockProjection } from './state/projection.js'
import { ConfirmationProjection, type ConfirmationClock } from './confirmations/projection.js'
import { TemplateProjection } from './templates/projection.js'
import { attachRealtimeServer, type RealtimeController } from './ws/realtime.js'
import { inspectScenarioConfig } from '../src/features/scenarios/scenario-validation.js'
import { BatchReplayProjection, type BatchReplayResult } from './batch-replay/projection.js'
import { AdminProjection, type AdminResult } from './admin/projection.js'
import { isAdminText } from '../src/features/admin/admin-contract.js'

export interface MockServerOptions {
  port?: number
  confirmationClock?: ConfirmationClock
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
function actorForRole(role: Role): 'admin' | 'operator' {
  return role === 'ADMIN' ? 'admin' : 'operator'
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
  'BATCH_LEVEL_III_EXPORT',
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
function isCopyTemplateRequest(value: unknown): value is { name: string } {
  return isStrictObject(value, ['name'])
    && typeof value.name === 'string'
    && value.name.trim().length > 0
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
  return isStrictObject(value, ['reportId', 'format'], ['confirmationId'])
    && value.reportId === reportId
    && (value.format === 'HTML' || value.format === 'PDF' || value.format === 'CSV')
    && (value.confirmationId === undefined
      || (typeof value.confirmationId === 'string' && value.confirmationId.length > 0))
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

/** Projects a query string into the closed audit filter contract. */
function auditRequestFromQuery(req: Request): AuditRequest | undefined {
  const request: Record<string, unknown> = {}
  for (const key of ['from', 'to', 'actor', 'role', 'module', 'action', 'result'] as const) {
    if (req.query[key] !== undefined) request[key] = req.query[key]
  }
  return isAuditRequest(request) ? request : undefined
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
    && typeof value.passwordFixture === 'string'
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
  return isStrictObject(value, ['operation', 'user'], ['confirmationId'])
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

/** 将批次或回放投影错误转换为统一 API 失败信封。 */
function sendBatchReplayFailure<T>(
  res: Response,
  result: BatchReplayResult<T>,
  requestId: string,
): result is Extract<BatchReplayResult<T>, { ok: false }> {
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
    auth.recordDenied('operator', role, action, objectId)
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

  auth.recordDenied('operator', role, 'CONFIRMATION_CREATE', objectId)
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

  const projection = new MockProjection()
  const auth = new AuthProjection()
  const scenarios = new ScenarioProjection()
  const simulations = new SimulationProjection(scenarios)
  const confirmations = new ConfirmationProjection(options.confirmationClock)
  const templates = new TemplateProjection()
  const scripts = new ScriptProjection()
  const batchReplay = new BatchReplayProjection()
  const admin = new AdminProjection()
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
    const decision = assertLoopbackRequest(req)
    if (!decision.allowed) {
      res.status(403).json(failure('LOOPBACK_ONLY', 403, { message: decision.message }))
      return
    }

    res.setHeader('Access-Control-Allow-Origin', decision.origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Demo-Role, X-Confirmation-Id')
    res.setHeader('Vary', 'Origin')
    next()
  })

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
  app.use(express.json({ strict: true, limit: '256kb' }))

  /**
   * Validates login input and delegates authentication to the projection.
   *
   * @param req - Request containing the closed login body.
   * @param res - Response receiving a typed success or failure envelope.
   * @returns Nothing.
   * @remarks Records every terminal login outcome and writes exactly one HTTP response.
   */
  app.post('/api/v1/auth/login', (req, res) => {
    const requestId = 'REQ-P1-AUTH-LOGIN'
    if (!isLoginShape(req.body)) {
      auth.recordError('anonymous', 'OPERATOR', 'AUTH_LOGIN')
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId,
        generatedAt: P1_GENERATED_AT,
      }))
      return
    }

    if (req.body.username !== 'admin' && req.body.username !== 'operator' && req.body.username !== 'locked') {
      auth.recordError(req.body.username, 'OPERATOR', 'AUTH_LOGIN')
      res.status(401).json(failure('INVALID_CREDENTIALS', 401, {
        requestId,
        generatedAt: P1_GENERATED_AT,
      }))
      return
    }

    const result = auth.login(req.body as LoginRequest)
    if (sendProjectionFailure(res, result, requestId)) {
      return
    }
    res.status(200).json(success(result.data, pageMeta(requestId)))
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

    auth.recordSuccess(role === 'ADMIN' ? 'admin' : 'operator', role, 'AUTH_PERMISSIONS')
    res.status(200).json(success(auth.permissionSet(role), pageMeta(requestId)))
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

  /** 返回三个 canonical CSV 合同，不执行文件读写。 */
  app.get('/api/v1/contracts/csv', (req, res) => {
    const requestId = 'REQ-P5-CSV-CONTRACTS'
    if (requireDemoRole(req, res, auth, 'CSV_CONTRACT_LIST') === undefined) return
    const contracts = projection.snapshot().contracts.csv
    res.status(200).json(success(contracts, pageMeta(requestId, contracts.length, contracts.length)))
  })

  /** 返回当前确定性仿真运行列表。 */
  app.get('/api/v1/simulations', (req, res) => {
    const requestId = 'REQ-P3-SIMULATION-LIST'
    if (requireDemoRole(req, res, auth, 'SIMULATION_LIST') === undefined) return
    const runs = simulations.list()
    res.status(200).json(success(runs, pageMeta(requestId, runs.length, Math.max(1, runs.length))))
  })

  /** 创建单实例仿真运行并锁定场景配置。 */
  app.post('/api/v1/simulations', (req, res) => {
    const requestId = 'REQ-P3-SIMULATION-CREATE'
    const role = requireDemoRole(req, res, auth, 'SIMULATION_CREATE')
    if (role === undefined) return
    const result = simulations.create(req.body)
    if (!result.ok) {
      auth.recordError(actorForRole(role), role, 'SIMULATION_CREATE')
      sendSimulationFailure(res, result, requestId)
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'SIMULATION_CREATE', result.data.runId)
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

  /** 返回指定运行和帧编号对应的确定性遥测帧。 */
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
      auth.recordDenied(actorForRole(role), role, 'SIMULATION_CLOSED_LOOP', runId)
      res.status(403).json(failure('PERMISSION_DENIED', 403, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: '当前账号没有闭环控制权限。',
      }))
      return
    }
    const result = simulations.runClosedLoop(runId, req.body)
    if (!result.ok) {
      auth.recordError(actorForRole(role), role, 'SIMULATION_CLOSED_LOOP', runId)
      sendSimulationFailure(res, result, requestId)
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'SIMULATION_CLOSED_LOOP', runId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /**
   * 执行开始、暂停、继续、单步、停止或倍速命令。
   * @remarks STOP 在状态校验后消费绑定运行和角色的一次性确认，其余命令不创建确认上下文。
   */
  app.post('/api/v1/simulations/:runId/commands', (req, res) => {
    const runId = req.params.runId
    const requestId = 'REQ-P3-SIMULATION-COMMAND'
    const role = requireDemoRole(req, res, auth, 'SIMULATION_COMMAND', runId)
    if (role === undefined) return

    const inspected = simulations.inspectCommand(runId, req.body)
    if (!inspected.ok) {
      auth.recordError(actorForRole(role), role, 'SIMULATION_COMMAND', runId)
      sendSimulationFailure(res, inspected, requestId)
      return
    }
    const command = inspected.data
    let stopConfirmed = false
    if (command.command === 'STOP') {
      if (command.confirmationId === undefined) {
        auth.recordError(actorForRole(role), role, 'SIMULATION_COMMAND', runId)
        res.status(428).json(failure('CONFIRMATION_REQUIRED', 428, {
          requestId,
          generatedAt: P1_GENERATED_AT,
          message: '停止仿真前需要二次确认。',
        }))
        return
      }
      const confirmed = confirmations.consume(command.confirmationId, 'SIMULATION_STOP', runId, role)
      if (!confirmed.ok) {
        auth.recordError(actorForRole(role), role, 'SIMULATION_COMMAND', runId)
        res.status(confirmed.status).json(failure(confirmed.code, confirmed.status, {
          requestId,
          generatedAt: P1_GENERATED_AT,
          message: confirmed.message,
        }))
        return
      }
      stopConfirmed = true
    }

    const result = simulations.command(runId, command, stopConfirmed)
    if (!result.ok) {
      auth.recordError(actorForRole(role), role, 'SIMULATION_COMMAND', runId)
      sendSimulationFailure(res, result, requestId)
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'SIMULATION_COMMAND', runId)
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
      auth.recordDenied(actorForRole(role), role, 'SIMULATION_JAMMER_COMMAND', jammerId)
      res.status(403).json(failure('PERMISSION_DENIED', 403, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: '当前账号没有干扰控制权限。',
      }))
      return
    }

    const result = simulations.controlJammer(taskId, jammerId, req.body)
    if (!result.ok) {
      auth.recordError(actorForRole(role), role, 'SIMULATION_JAMMER_COMMAND', jammerId)
      sendSimulationFailure(res, result, requestId)
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'SIMULATION_JAMMER_COMMAND', jammerId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 在明确仿真帧边界同步一版干扰参数，并发布规范设备状态。 */
  app.post('/api/v1/tasks/:taskId/jammers/:jammerId/parameters', (req, res) => {
    const { taskId, jammerId } = req.params
    const requestId = 'REQ-P4-JAMMER-SYNC'
    const role = requireDemoRole(req, res, auth, 'SIMULATION_JAMMER_SYNC', jammerId)
    if (role === undefined) return
    if (!auth.permissionSet(role).permissions.includes('SIMULATION_CONTROL')) {
      auth.recordDenied(actorForRole(role), role, 'SIMULATION_JAMMER_SYNC', jammerId)
      res.status(403).json(failure('PERMISSION_DENIED', 403, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: '当前账号没有干扰参数同步权限。',
      }))
      return
    }
    const result = simulations.syncJammerParameters(taskId, jammerId, req.body)
    if (!result.ok) {
      auth.recordError(actorForRole(role), role, 'SIMULATION_JAMMER_SYNC', jammerId)
      sendSimulationFailure(res, result, requestId)
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'SIMULATION_JAMMER_SYNC', jammerId)
    realtime.publishJammerStatus(result.data.jammerStatus, result.data.effectiveFrameId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /**
   * 返回指定场景的当前内存草稿。
   * @param req 包含角色提示和场景编号的请求。
   * @param res 接收场景草稿或类型化错误的响应。
   * @returns 无返回值。
   * @remarks 只读取场景投影，不修改草稿修订号。
   */
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
      auth.recordError(actorForRole(role), role, 'SCENARIO_VALIDATE', scenarioId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'SCENARIO_VALIDATE', scenarioId)
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
      auth.recordError(actorForRole(role), role, 'SCENARIO_UPDATE', scenarioId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'SCENARIO_UPDATE', scenarioId)
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
      auth.recordError(actorForRole(role), role, 'SCENARIO_UNDO', scenarioId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'SCENARIO_UNDO', scenarioId)
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
      auth.recordError(actorForRole(role), role, 'SCENARIO_RESET', scenarioId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'SCENARIO_RESET', scenarioId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 原子校验并导入场景配置 1.0 快照，只替换临时工作场景。 */
  app.post('/api/v1/scenarios/import', (req, res) => {
    const requestId = 'REQ-P2-SCENARIO-IMPORT'
    const role = requireDemoRole(req, res, auth, 'SCENARIO_IMPORT')
    if (role === undefined) return
    const result = scenarios.importSnapshots(req.body)
    if (!result.ok) {
      auth.recordError(actorForRole(role), role, 'SCENARIO_IMPORT')
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'SCENARIO_IMPORT')
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
    const result = templates.list()
    res.status(200).json(success(result, pageMeta(requestId, result.length, Math.max(1, result.length))))
  })

  /**
   * 新建或导入官方模板。
   * @param req 包含管理员角色及模板名称、配置的请求。
   * @param res 接收新模板或类型化错误的响应。
   * @returns 无返回值。
   * @remarks 只写入内存模板库；操作员在进入请求体处理前即被拒绝。
   */
  app.post('/api/v1/templates', (req, res) => {
    const requestId = 'REQ-P2-TEMPLATE-CREATE'
    if (!requireAdmin(req, res, auth, 'TEMPLATE_CREATE')) return
    const result = templates.create(req.body)
    if (!result.ok) {
      auth.recordError('admin', 'ADMIN', 'TEMPLATE_CREATE')
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess('admin', 'ADMIN', 'TEMPLATE_CREATE', result.data.templateId)
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
      auth.recordError('admin', 'ADMIN', 'TEMPLATE_UPDATE', templateId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess('admin', 'ADMIN', 'TEMPLATE_UPDATE', templateId)
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
    const result = scenarios.copyTemplate(template.data.config, req.body.name)
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
      auth.recordError(actorForRole(role), role, 'SCRIPT_PREVIEW')
      res.status(422).json(failure('VALIDATION_FAILED', 422, { requestId, generatedAt: P1_GENERATED_AT, fieldPath: 'request' }))
      return
    }
    const draft = scenarios.get(req.body.scenarioId)
    if (!draft.ok) {
      auth.recordError(actorForRole(role), role, 'SCRIPT_PREVIEW', req.body.scenarioId)
      res.status(422).json(failure('VALIDATION_FAILED', 422, { requestId, generatedAt: P1_GENERATED_AT, message: draft.message, fieldPath: 'scenarioId' }))
      return
    }
    const validation = inspectScenarioConfig(draft.data.config).result
    if (validation.errors.length > 0) {
      const issue = validation.errors[0]!
      auth.recordError(actorForRole(role), role, 'SCRIPT_PREVIEW', req.body.scenarioId)
      res.status(422).json(failure('VALIDATION_FAILED', 422, { requestId, generatedAt: P1_GENERATED_AT, message: issue.message, fieldPath: issue.fieldPath }))
      return
    }
    if (validation.warnings.length > 0) {
      if (req.body.warningConfirmationId === undefined) {
        auth.recordError(actorForRole(role), role, 'SCRIPT_PREVIEW', req.body.scenarioId)
        res.status(428).json(failure('CONFIRMATION_REQUIRED', 428, { requestId, generatedAt: P1_GENERATED_AT, message: '场景存在校验警告，生成脚本前需要一次性确认。' }))
        return
      }
      const confirmation = confirmations.consume(
        req.body.warningConfirmationId,
        'SCENARIO_WARNING_CONTINUE',
        req.body.scenarioId,
        role,
      )
      if (!confirmation.ok) {
        auth.recordError(actorForRole(role), role, 'SCRIPT_PREVIEW', req.body.scenarioId)
        res.status(confirmation.status).json(failure(confirmation.code, confirmation.status, { requestId, generatedAt: P1_GENERATED_AT, message: confirmation.message }))
        return
      }
    }
    auth.recordSuccess(actorForRole(role), role, 'SCRIPT_PREVIEW', req.body.scenarioId)
    res.status(200).json(success(scripts.preview(draft.data), pageMeta(requestId)))
  })

  /** 对已生成脚本执行校验和、结构、版本和路径预检。 */
  app.post('/api/v1/scripts/:scriptId/preflight', (req, res) => {
    const scriptId = req.params.scriptId
    const requestId = 'REQ-P2-SCRIPT-PREFLIGHT'
    const role = requireDemoRole(req, res, auth, 'SCRIPT_PREFLIGHT', scriptId)
    if (role === undefined) return
    if (!isPreflightRequest(req.body)) {
      auth.recordError(actorForRole(role), role, 'SCRIPT_PREFLIGHT', scriptId)
      res.status(422).json(failure('VALIDATION_FAILED', 422, { requestId, generatedAt: P1_GENERATED_AT, fieldPath: 'checksum' }))
      return
    }
    const result = scripts.preflight(scriptId, req.body.checksum)
    if (!result.ok) {
      auth.recordError(actorForRole(role), role, 'SCRIPT_PREFLIGHT', scriptId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'SCRIPT_PREFLIGHT', scriptId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 返回当前确定性批次目录。 */
  app.get('/api/v1/batches', (req, res) => {
    const requestId = 'REQ-P6-BATCH-LIST'
    if (requireDemoRole(req, res, auth, 'BATCH_LIST') === undefined) return
    const batches = batchReplay.listBatches()
    res.status(200).json(success(batches, pageMeta(requestId, batches.length, batches.length)))
  })

  /** 校验批量参数并创建 BATCH-001 排队投影。 */
  app.post('/api/v1/batches', (req, res) => {
    const requestId = 'REQ-P6-BATCH-CREATE'
    const role = requireDemoRole(req, res, auth, 'BATCH_CREATE')
    if (role === undefined) return
    const result = batchReplay.createBatch(req.body)
    if (sendBatchReplayFailure(res, result, requestId)) {
      auth.recordError(actorForRole(role), role, 'BATCH_CREATE')
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'BATCH_CREATE', result.data.batchId)
    res.status(201).json(success(result.data, pageMeta(requestId)))
  })

  /** 返回批次与固定 12 行运行/报告对照详情。 */
  app.get('/api/v1/batches/:batchId', (req, res) => {
    const batchId = req.params.batchId
    const requestId = 'REQ-P6-BATCH-GET'
    if (requireDemoRole(req, res, auth, 'BATCH_READ', batchId) === undefined) return
    const result = batchReplay.getBatch(batchId)
    if (sendBatchReplayFailure(res, result, requestId)) return
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 执行批次 START 或 CANCEL 命令。 */
  app.post('/api/v1/batches/:batchId/commands', (req, res) => {
    const batchId = req.params.batchId
    const requestId = 'REQ-P6-BATCH-COMMAND'
    const role = requireDemoRole(req, res, auth, 'BATCH_COMMAND', batchId)
    if (role === undefined) return
    const result = batchReplay.commandBatch(batchId, req.body)
    if (sendBatchReplayFailure(res, result, requestId)) {
      auth.recordError(actorForRole(role), role, 'BATCH_COMMAND', batchId)
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'BATCH_COMMAND', batchId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 返回当前历史回放目录。 */
  app.get('/api/v1/replays', (req, res) => {
    const requestId = 'REQ-P6-REPLAY-LIST'
    if (requireDemoRole(req, res, auth, 'REPLAY_LIST') === undefined) return
    const replays = batchReplay.listReplays()
    res.status(200).json(success(replays, pageMeta(requestId, replays.length, replays.length)))
  })

  /** 返回指定回放的只读运行引用与游标。 */
  app.get('/api/v1/replays/:replayId', (req, res) => {
    const replayId = req.params.replayId
    const requestId = 'REQ-P6-REPLAY-GET'
    if (requireDemoRole(req, res, auth, 'REPLAY_READ', replayId) === undefined) return
    const result = batchReplay.getReplay(replayId)
    if (sendBatchReplayFailure(res, result, requestId)) return
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 执行仅改变回放游标和播放状态的命令。 */
  app.post('/api/v1/replays/:replayId/commands', (req, res) => {
    const replayId = req.params.replayId
    const requestId = 'REQ-P6-REPLAY-COMMAND'
    const role = requireDemoRole(req, res, auth, 'REPLAY_COMMAND', replayId)
    if (role === undefined) return
    const result = batchReplay.commandReplay(replayId, req.body)
    if (sendBatchReplayFailure(res, result, requestId)) {
      auth.recordError(actorForRole(role), role, 'REPLAY_COMMAND', replayId)
      return
    }
    auth.recordSuccess(actorForRole(role), role, 'REPLAY_COMMAND', replayId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 返回单次仿真报告和批量聚合报告目录。 */
  app.get('/api/v1/reports', (req, res) => {
    const requestId = 'REQ-P3-REPORT-LIST'
    if (requireDemoRole(req, res, auth, 'REPORT_LIST') === undefined) return
    const snapshot = projection.snapshot()
    const reports: Report[] = [snapshot.report, snapshot.batchAggregateReport]
    res.status(200).json(success(reports, pageMeta(requestId, reports.length, reports.length)))
  })

  /** 返回指定的确定性报告，不把另一个来源的数据混入当前报告。 */
  app.get('/api/v1/reports/:reportId', (req, res) => {
    const reportId = req.params.reportId
    const requestId = 'REQ-P3-REPORT-GET'
    if (requireDemoRole(req, res, auth, 'REPORT_READ', reportId) === undefined) return
    const snapshot = projection.snapshot()
    const report = [snapshot.report, snapshot.batchAggregateReport]
      .find((candidate) => candidate.reportId === reportId)
    if (report === undefined) {
      res.status(404).json(failure('NOT_FOUND', 404, { requestId, generatedAt: P1_GENERATED_AT }))
      return
    }
    res.status(200).json(success(report, pageMeta(requestId)))
  })

  /**
   * 校验报表导出权限并返回“未生成文件”的固定结果。
   * @remarks 三级批量报告仅允许管理员在消费一次性确认后验证；本接口不写文件。
   */
  app.post('/api/v1/reports/:reportId/export', (req, res) => {
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

    const snapshot = projection.snapshot()
    const report = [snapshot.report, snapshot.batchAggregateReport]
      .find((candidate) => candidate.reportId === reportId)
    if (report === undefined) {
      res.status(404).json(failure('NOT_FOUND', 404, { requestId, generatedAt: P1_GENERATED_AT }))
      return
    }

    if (report.classification === 'LEVEL_III') {
      if (role !== 'ADMIN' || !auth.permissionSet(role).permissions.includes('BATCH_LEVEL_III_EXPORT')) {
        auth.recordDenied('operator', role, 'REPORT_EXPORT', reportId)
        res.status(403).json(failure('PERMISSION_DENIED', 403, { requestId, generatedAt: P1_GENERATED_AT }))
        return
      }
      if (req.body.confirmationId === undefined) {
        res.status(428).json(failure('CONFIRMATION_REQUIRED', 428, {
          requestId,
          generatedAt: P1_GENERATED_AT,
          message: '验证三级批量报告导出前需要二次确认。',
        }))
        return
      }
      const confirmed = confirmations.consume(req.body.confirmationId, 'BATCH_LEVEL_III_EXPORT', reportId, role)
      if (!confirmed.ok) {
        res.status(confirmed.status).json(failure(confirmed.code, confirmed.status, {
          requestId,
          generatedAt: P1_GENERATED_AT,
          message: confirmed.message,
        }))
        return
      }
    } else if (!auth.permissionSet(role).permissions.includes('ORDINARY_REPORT_EXPORT')) {
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
    if (!requireConfirmationPermission(role, req.body.action, req.body.objectId, res, auth)) return
    const result = confirmations.create(req.body.action, req.body.objectId, role)
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
    const result = confirmations.confirm(confirmationId, role)
    if (!result.ok) {
      if (result.code === 'PERMISSION_DENIED') {
        auth.recordDenied(role === 'ADMIN' ? 'admin' : 'operator', role, 'CONFIRMATION_CONFIRM', confirmationId)
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
    const confirmation = confirmations.consume(confirmationId, 'OFFICIAL_TEMPLATE_DELETE', templateId, 'ADMIN')
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
      auth.recordError('admin', 'ADMIN', 'TEMPLATE_DELETE', templateId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess('admin', 'ADMIN', 'TEMPLATE_DELETE', templateId)
    res.status(200).json(success(result.data, pageMeta(requestId)))
  })

  /** 统一记录系统维护结果并返回既有成功或错误信封。 */
  function finishAdmin<T>(res: Response, action: string, result: AdminResult<T>, objectId?: string, status = 200): void {
    const requestId = `REQ-P7-${action}`
    if (!result.ok) {
      auth.recordError('admin', 'ADMIN', action, objectId)
      res.status(result.status).json(failure(result.code, result.status, {
        requestId, generatedAt: P1_GENERATED_AT, message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    auth.recordSuccess('admin', 'ADMIN', action, objectId)
    const total = Array.isArray(result.data) ? result.data.length : 1
    res.status(status).json(success(result.data, pageMeta(requestId, total, Math.max(1, total))))
  }

  /** 消费与动作、对象及管理员绑定的一次性确认；失败同样写入审计。 */
  function confirmAdmin(res: Response, confirmationId: unknown, action: ConfirmationAction, objectId: string): boolean {
    const result = !isAdminText(confirmationId)
      ? { ok: false as const, code: 'CONFIRMATION_REQUIRED' as const, status: 428, message: '执行此操作前需要二次确认。' }
      : confirmations.consume(confirmationId, action, objectId, 'ADMIN')
    if (result.ok) return true
    finishAdmin(res, action, result, objectId)
    return false
  }

  /** 读取主数据；权限由服务端独立校验。 */
  app.get('/api/v1/admin/master-data', (req, res) => {
    if (!requireAdmin(req, res, auth, 'MASTER_DATA_LIST')) return
    finishAdmin(res, 'MASTER_DATA_LIST', { ok: true, data: admin.listMasterData() })
  })

  /** 创建主数据；版本及引用数量由内存投影校验。 */
  app.post('/api/v1/admin/master-data', (req, res) => {
    if (!requireAdmin(req, res, auth, 'MASTER_DATA_CREATE')) return
    finishAdmin(res, 'MASTER_DATA_CREATE', admin.saveMasterData(req.body), isAdminText(req.body?.data?.dataId) ? req.body.data.dataId : undefined, 201)
  })

  /** 按路径编号和期望版本更新主数据。 */
  app.put('/api/v1/admin/master-data/:dataId', (req, res) => {
    if (!requireAdmin(req, res, auth, 'MASTER_DATA_UPDATE', req.params.dataId)) return
    finishAdmin(res, 'MASTER_DATA_UPDATE', admin.saveMasterData(req.body, req.params.dataId), req.params.dataId)
  })

  /** 删除前消费确认，并重新校验服务器持有的引用数量。 */
  app.delete('/api/v1/admin/master-data/:dataId', (req, res) => {
    const dataId = req.params.dataId
    if (!requireAdmin(req, res, auth, 'MASTER_DATA_DELETE', dataId)) return
    if (!confirmAdmin(res, req.get('X-Confirmation-Id'), 'MASTER_DATA_DELETE', dataId)) return
    finishAdmin(res, 'MASTER_DATA_DELETE', admin.deleteMasterData(dataId), dataId)
  })

  /** 返回可供恢复选择的备份目录。 */
  app.get('/api/v1/admin/backups', (req, res) => {
    if (!requireAdmin(req, res, auth, 'BACKUP_LIST')) return
    finishAdmin(res, 'BACKUP_LIST', { ok: true, data: admin.listBackups() })
  })

  /** 校验并执行备份的内存流程；确认不能用于恢复操作。 */
  app.post('/api/v1/admin/backup', (req, res) => {
    if (!requireAdmin(req, res, auth, 'BACKUP_CREATE')) return
    if (!isStrictObject(req.body, ['operation'], ['backupId', 'confirmationId']) || req.body.operation !== 'BACKUP'
      || (req.body.backupId !== undefined && !isAdminText(req.body.backupId))) {
      finishAdmin(res, 'BACKUP_CREATE', { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '备份请求不正确。', fieldPath: 'request' })
      return
    }
    if (!confirmAdmin(res, req.body.confirmationId, 'BACKUP_RESTORE', `BACKUP:${req.body.backupId ?? 'NEW'}`)) return
    finishAdmin(res, 'BACKUP_CREATE', admin.backup(req.body.backupId as string | undefined))
  })

  /** 恢复结果包含预备份和完整性证据；损坏数据不会开始恢复。 */
  app.post('/api/v1/admin/restore', (req, res) => {
    if (!requireAdmin(req, res, auth, 'BACKUP_RESTORE')) return
    if (!isStrictObject(req.body, ['operation', 'backupId'], ['confirmationId']) || req.body.operation !== 'RESTORE' || !isAdminText(req.body.backupId)) {
      finishAdmin(res, 'BACKUP_RESTORE', { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '恢复请求不正确。', fieldPath: 'backupId' })
      return
    }
    if (!confirmAdmin(res, req.body.confirmationId, 'BACKUP_RESTORE', `RESTORE:${req.body.backupId}`)) return
    const result = admin.restore(req.body.backupId)
    if (result.ok && result.data.result === 'FAILURE') {
      auth.recordError('admin', 'ADMIN', 'BACKUP_RESTORE', req.body.backupId)
      res.status(200).json(success(result.data, pageMeta('REQ-P7-BACKUP_RESTORE')))
      return
    }
    finishAdmin(res, 'BACKUP_RESTORE', result, req.body.backupId)
  })

  /** 读取任务、场景、运行、回放、报告的统一归档关系。 */
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
    const records = filterAudit(auth.auditSnapshot(), filters)
    res.status(200).json(success(records, pageMeta(requestId, records.length, Math.max(1, records.length))))
  })

  /** Validates a confirmed audit export and returns classification evidence without creating a file. */
  app.post('/api/v1/admin/audit/export', (req, res) => {
    const requestId = 'REQ-P7-AUDIT-EXPORT'
    if (!requireAdmin(req, res, auth, 'AUDIT_EXPORT', 'AUDIT-LOG')) return
    if (!isAuditRequest(req.body, true)) {
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        fieldPath: 'request',
      }))
      return
    }
    if (req.body.confirmationId === undefined) {
      res.status(428).json(failure('CONFIRMATION_REQUIRED', 428, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: '导出操作审计日志前需要二次确认。',
      }))
      return
    }
    const confirmation = confirmations.consume(req.body.confirmationId, 'AUDIT_EXPORT', 'AUDIT-LOG', 'ADMIN')
    if (!confirmation.ok) {
      res.status(confirmation.status).json(failure(confirmation.code, confirmation.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: confirmation.message,
      }))
      return
    }
    const result: ExportStatus = {
      objectId: 'AUDIT-LOG',
      generated: false,
      classification: 'INTERNAL',
      watermark: '内部使用 · admin · AUDIT-LOG',
      verifiedAt: P1_GENERATED_AT,
    }
    res.status(200).json(success(result, pageMeta(requestId)))
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
    auth.recordSuccess('admin', 'ADMIN', 'USER_LIST')
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
    if (!isUserRoleCommand(req.body) || req.body.operation !== 'CREATE') {
      auth.recordError('admin', 'ADMIN', 'USER_CREATE')
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        fieldPath: 'operation',
      }))
      return
    }

    const result = auth.create(req.body)
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
    if (!isUserRoleCommand(req.body)) {
      auth.recordError('admin', 'ADMIN', 'USER_UPDATE', userId)
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId,
        generatedAt: P1_GENERATED_AT,
      }))
      return
    }
    if (req.body.user.userId !== userId) {
      auth.recordError('admin', 'ADMIN', 'USER_UPDATE', userId)
      res.status(400).json(failure('INVALID_REQUEST', 400, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        fieldPath: 'user.userId',
      }))
      return
    }

    const result = auth.update(userId, req.body)
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
    const result = auth.delete(userId)
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
    if (readDemoRole(req) === undefined) {
      res.status(403).json(failure('PERMISSION_DENIED', 403))
      return
    }

    if (!isResetRequest(req.body)) {
      res.status(400).json(failure('INVALID_REQUEST', 400, { fieldPath: 'confirm' }))
      return
    }

    const result: ResetResult = realtime.reset()
    auth.reset()
    scenarios.reset()
    simulations.reset()
    confirmations.reset()
    templates.reset()
    scripts.reset()
    batchReplay.reset()
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

  /**
   * Converts JSON parsing failures into the canonical invalid-request response.
   *
   * @param error - Parser error propagated by Express.
   * @param _req - Request associated with the parser error.
   * @param res - Response receiving the invalid-request envelope.
   * @param _next - Express error continuation, intentionally unused because this handler responds.
   * @returns Nothing.
   * @remarks Sends one 400 JSON response and does not mutate projections.
   */
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const details = error instanceof Error ? error.message : 'Unknown JSON parsing error.'
    res.status(400).json(failure('INVALID_REQUEST', 400, { details }))
  })

  const httpServer = createServer(app)
  realtime = attachRealtimeServer(httpServer, projection, () => simulations.list()[0])
  httpServer.listen(port, '127.0.0.1')

  let closePromise: Promise<void> | undefined
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
     * @remarks Starts listener shutdown on the first call and reuses its outcome thereafter.
     */
    close: () => {
      closePromise ??= realtime.close().then(() => new Promise<void>((resolve, rejectClose) => {
        httpServer.close((error) => {
          if (error === undefined) {
            resolve()
          } else {
            rejectClose(error)
          }
        })
      }))
      return closePromise
    },
  }
}

import { createServer, type Server as HttpServer } from 'node:http'
import express, { type NextFunction, type Request, type Response } from 'express'
import type {
  AuditRecord,
  LoginRequest,
  PageMeta,
  ResetRequest,
  ResetResult,
  Role,
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
import { MockProjection } from './state/projection.js'
import { attachRealtimeServer, type RealtimeController } from './ws/realtime.js'

export interface MockServerOptions {
  port?: number
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Demo-Role')
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
   * 保存指定场景的基础、环境、时序、平台、航点、链路和干扰设备参数。
   * @param req 包含角色提示、场景编号、完整配置和界面扩展的请求。
   * @param res 接收更新后草稿或字段校验错误的响应。
   * @returns 无返回值。
   * @remarks 校验通过时递增场景草稿修订号，传感器、输出和信息需求区段保持不变。
   */
  app.put('/api/v1/scenarios/:scenarioId', (req, res) => {
    const scenarioId = req.params.scenarioId
    const requestId = 'REQ-P2-SCENARIO-PUT'
    if (requireDemoRole(req, res, auth, 'SCENARIO_UPDATE', scenarioId) === undefined) return

    const result = scenarios.save(scenarioId, req.body)
    if (!result.ok) {
      res.status(result.status).json(failure(result.code, result.status, {
        requestId,
        generatedAt: P1_GENERATED_AT,
        message: result.message,
        ...(result.fieldPath === undefined ? {} : { fieldPath: result.fieldPath }),
      }))
      return
    }
    res.status(200).json(success(result.data, pageMeta(requestId)))
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
  realtime = attachRealtimeServer(httpServer, projection)
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

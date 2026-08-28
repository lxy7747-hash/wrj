import type {
  ApiErrorCode,
  AuditRecord,
  AuthResult,
  Iso8601Utc,
  LoginRequest,
  Permission,
  Principal,
  Role,
  User,
  UserRoleCommand,
} from '../../src/contracts/domain-models.js'
import { loadFixtureProjection } from '../fixtures/source.js'

const DEFAULT_LOGIN_PASSWORD = '123456'
const CURRENT_ADMIN_ID = 'USR-ADMIN'

const OPERATOR_PERMISSIONS: readonly Permission[] = [
  'BUSINESS_READ',
  'SCENARIO_DRAFT_WRITE',
  'SIMULATION_CONTROL',
  'ORDINARY_REPORT_EXPORT',
]

const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...OPERATOR_PERMISSIONS,
  'OFFICIAL_TEMPLATE_MAINTAIN',
  'MASTER_DATA_MAINTAIN',
  'USER_ROLE_MAINTAIN',
  'BACKUP_RESTORE',
  'AUDIT_READ',
  'FULL_CONFIG_EXPORT',
  'BATCH_LEVEL_III_EXPORT',
]

export interface PermissionSet {
  role: Role
  permissions: readonly Permission[]
}

export interface ProjectionFailure {
  ok: false
  code: ApiErrorCode
  status: 400 | 401 | 404 | 409 | 423
  fieldPath?: string
}

export interface ProjectionSuccess<T> {
  ok: true
  data: T
}

export type ProjectionResult<T> = ProjectionSuccess<T> | ProjectionFailure

interface AuthRuntimeState {
  users: User[]
  audit: AuditRecord[]
  nextAuditSequence: number
  occurredAt: Iso8601Utc
}

/**
 * Reconstructs the mutable authentication projection from deterministic source fixtures.
 *
 * @returns A fresh runtime state with independent user/audit arrays and reset audit sequencing.
 * @remarks Loads fixture data but performs no persistence, network, clock, or process side effects.
 */
function createRuntimeState(): AuthRuntimeState {
  const fixture = loadFixtureProjection()
  return {
    users: fixture.principals,
    audit: fixture.audit,
    nextAuditSequence: 1,
    occurredAt: fixture.epoch,
  }
}

/**
 * Resolves the immutable permission vocabulary assigned to a role.
 *
 * @param role - Closed ADMIN or OPERATOR role from the authentication contract.
 * @returns The role's shared read-only permission list.
 * @remarks This pure lookup does not mutate projection state.
 */
function permissionsForRole(role: Role): readonly Permission[] {
  return role === 'ADMIN' ? ADMIN_PERMISSIONS : OPERATOR_PERMISSIONS
}

/**
 * Projects a user record into the principal shape returned by authentication.
 *
 * @param user - Valid in-memory user whose identity and role are projected.
 * @returns A new principal containing the user's identifiers and role permissions.
 * @remarks This pure adapter does not mutate the supplied user or runtime state.
 */
function principalFor(user: User): Principal {
  return {
    userId: user.userId,
    username: user.username,
    role: user.role,
    permissions: permissionsForRole(user.role),
  }
}

/**
 * Infers the safe audit role used before a username has resolved to a stored user.
 *
 * @param username - Username supplied to the login boundary.
 * @returns ADMIN only for the frozen admin account name; otherwise OPERATOR.
 * @remarks This pure inference does not authorize access or mutate projection state.
 */
function inferredRole(username: string): Role {
  return username === 'admin' ? 'ADMIN' : 'OPERATOR'
}

export class AuthProjection {
  private runtimeState = createRuntimeState()

  /**
   * Restores all authentication users, audit records, and deterministic counters from fixtures.
   *
   * @returns Nothing.
   * @remarks Replaces the complete in-memory runtime state and performs no external persistence.
   */
  reset(): void {
    this.runtimeState = createRuntimeState()
  }

  /**
   * Returns an isolated snapshot of the current user projection.
   *
   * @returns A deep-cloned user list safe for response serialization and caller mutation.
   * @remarks Reads state without mutating it or exposing internal references.
   */
  usersSnapshot(): User[] {
    return structuredClone(this.runtimeState.users)
  }

  /**
   * Returns an isolated snapshot of the append-only audit projection.
   *
   * @returns A deep-cloned audit list safe for inspection by tests and server adapters.
   * @remarks Reads state without mutating it or exposing internal references.
   */
  auditSnapshot(): AuditRecord[] {
    return structuredClone(this.runtimeState.audit)
  }

  /**
   * Builds the permission response associated with a requested role.
   *
   * @param role - Role whose frozen permission set is requested.
   * @returns A deep-cloned role and permission projection.
   * @remarks Performs no authorization decision and does not mutate runtime state.
   */
  permissionSet(role: Role): PermissionSet {
    return structuredClone({ role, permissions: permissionsForRole(role) })
  }

  /**
   * Authenticates a frozen development login request against the in-memory user projection.
   *
   * @param request - Closed username and password-fixture request received from the HTTP adapter.
   * @returns A principal-bearing success or a typed locked/invalid-credentials failure.
   * @remarks Updates last-login time for a successful user and appends a SUCCESS/ERROR audit
   * record for every attempt; it never creates a browser session or external persistence.
   */
  login(request: LoginRequest): ProjectionResult<AuthResult> {
    const role = inferredRole(request.username)
    if (request.username === 'locked') {
      this.appendAudit(request.username, role, 'AUTH_LOGIN', undefined, 'ERROR')
      return { ok: false, code: 'ACCOUNT_LOCKED', status: 423 }
    }

    const user = this.runtimeState.users.find((candidate) => candidate.username === request.username)
    if (user?.status === 'LOCKED') {
      this.appendAudit(request.username, user.role, 'AUTH_LOGIN', user.userId, 'ERROR')
      return { ok: false, code: 'ACCOUNT_LOCKED', status: 423 }
    }

    if (
      user === undefined
      || user.status !== 'ACTIVE'
      || request.passwordFixture !== DEFAULT_LOGIN_PASSWORD
    ) {
      this.appendAudit(request.username, user?.role ?? role, 'AUTH_LOGIN', user?.userId, 'ERROR')
      return { ok: false, code: 'INVALID_CREDENTIALS', status: 401 }
    }

    user.lastLoginAt = this.runtimeState.occurredAt
    this.appendAudit(user.username, user.role, 'AUTH_LOGIN', user.userId, 'SUCCESS')
    // P1 is intentionally stateless: a successful fixture login never creates persistence.
    return {
      ok: true,
      data: {
        authenticated: true,
        principal: principalFor(user),
        sessionCreated: false,
      },
    }
  }

  /**
   * Creates a unique user from a validated user-role command.
   *
   * @param command - CREATE command containing the complete user record.
   * @returns A cloned created user or a typed conflict failure.
   * @remarks Appends the user on success and records a SUCCESS/ERROR audit outcome.
   */
  create(command: UserRoleCommand): ProjectionResult<User> {
    const user = structuredClone(command.user)
    const duplicate = this.runtimeState.users.some(
      (candidate) => candidate.userId === user.userId || candidate.username === user.username,
    ) || user.username === 'locked'
    if (duplicate) {
      this.appendAudit('admin', 'ADMIN', 'USER_CREATE', user.userId, 'ERROR')
      return { ok: false, code: 'CONFLICT', status: 409 }
    }

    this.runtimeState.users.push(user)
    this.appendAudit('admin', 'ADMIN', 'USER_CREATE', user.userId, 'SUCCESS')
    return { ok: true, data: structuredClone(user) }
  }

  /**
   * Applies an update, enable, or disable command to an existing user.
   *
   * @param userId - Path-owned identifier of the user being changed.
   * @param command - Validated user-role operation and target user data.
   * @returns The cloned updated user or a typed request, not-found, conflict, or admin-guard failure.
   * @remarks Replaces the in-memory user only after all guards pass and appends an audit record for
   * every terminal outcome; no external persistence occurs.
   */
  update(userId: string, command: UserRoleCommand): ProjectionResult<User> {
    const index = this.runtimeState.users.findIndex((candidate) => candidate.userId === userId)
    if (index < 0) {
      this.appendAudit('admin', 'ADMIN', `USER_${command.operation}`, userId, 'ERROR')
      return { ok: false, code: 'NOT_FOUND', status: 404 }
    }

    const current = this.runtimeState.users[index]
    if (current === undefined) {
      throw new Error('User index disappeared from the in-memory projection.')
    }

    let next: User
    switch (command.operation) {
      case 'UPDATE':
        next = structuredClone(command.user)
        break
      case 'ENABLE':
        next = { ...current, status: 'ACTIVE' }
        break
      case 'DISABLE':
        next = { ...current, status: 'DISABLED' }
        break
      default:
        this.appendAudit('admin', 'ADMIN', `USER_${command.operation}`, userId, 'ERROR')
        return { ok: false, code: 'INVALID_REQUEST', status: 400, fieldPath: 'operation' }
    }

    const duplicateUsername = this.runtimeState.users.some(
      (candidate) => candidate.userId !== userId && candidate.username === next.username,
    ) || next.username === 'locked'
    if (duplicateUsername) {
      this.appendAudit('admin', 'ADMIN', `USER_${command.operation}`, userId, 'ERROR')
      return { ok: false, code: 'CONFLICT', status: 409 }
    }

    if (this.violatesAdminGuard(current, next)) {
      this.appendAudit('admin', 'ADMIN', `USER_${command.operation}`, userId, 'DENIED')
      return { ok: false, code: 'LAST_ADMIN_GUARD', status: 409 }
    }

    this.runtimeState.users[index] = next
    this.appendAudit('admin', 'ADMIN', `USER_${command.operation}`, userId, 'SUCCESS')
    return { ok: true, data: structuredClone(next) }
  }

  /**
   * Deletes an existing user while preserving the current/last administrator invariant.
   *
   * @param userId - Identifier of the user selected for deletion.
   * @returns A typed deletion result or a not-found/admin-guard failure.
   * @remarks Removes one in-memory user only after guard approval and records the outcome in audit.
   */
  delete(userId: string): ProjectionResult<{ deleted: boolean; objectId: string }> {
    const index = this.runtimeState.users.findIndex((candidate) => candidate.userId === userId)
    if (index < 0) {
      this.appendAudit('admin', 'ADMIN', 'USER_DELETE', userId, 'ERROR')
      return { ok: false, code: 'NOT_FOUND', status: 404 }
    }

    const current = this.runtimeState.users[index]
    if (current === undefined) {
      throw new Error('User index disappeared from the in-memory projection.')
    }
    if (this.violatesAdminGuard(current, undefined)) {
      this.appendAudit('admin', 'ADMIN', 'USER_DELETE', userId, 'DENIED')
      return { ok: false, code: 'LAST_ADMIN_GUARD', status: 409 }
    }

    this.runtimeState.users.splice(index, 1)
    this.appendAudit('admin', 'ADMIN', 'USER_DELETE', userId, 'SUCCESS')
    return { ok: true, data: { deleted: true, objectId: userId } }
  }

  /**
   * Records an authorization denial produced by an outer HTTP/RBAC adapter.
   *
   * @param actor - Username or boundary label associated with the denied request.
   * @param role - Role evaluated for the request.
   * @param action - Stable action name used in the audit record.
   * @param objectId - Optional affected object identifier.
   * @returns Nothing.
   * @remarks Appends one DENIED record and advances the deterministic audit sequence.
   */
  recordDenied(actor: string, role: Role, action: string, objectId?: string): void {
    this.appendAudit(actor, role, action, objectId, 'DENIED')
  }

  /**
   * Records a successful operation produced by an outer HTTP adapter.
   *
   * @param actor - Username associated with the successful request.
   * @param role - Role used for the request.
   * @param action - Stable action name used in the audit record.
   * @param objectId - Optional affected object identifier.
   * @returns Nothing.
   * @remarks Appends one SUCCESS record and advances the deterministic audit sequence.
   */
  recordSuccess(actor: string, role: Role, action: string, objectId?: string): void {
    this.appendAudit(actor, role, action, objectId, 'SUCCESS')
  }

  /**
   * Records a validation or execution error produced by an outer HTTP adapter.
   *
   * @param actor - Username or boundary label associated with the failed request.
   * @param role - Role associated with the failed request.
   * @param action - Stable action name used in the audit record.
   * @param objectId - Optional affected object identifier.
   * @returns Nothing.
   * @remarks Appends one ERROR record and advances the deterministic audit sequence.
   */
  recordError(actor: string, role: Role, action: string, objectId?: string): void {
    this.appendAudit(actor, role, action, objectId, 'ERROR')
  }

  /**
   * Checks whether a proposed user transition would remove protected administrator authority.
   *
   * @param current - Existing user before the proposed transition.
   * @param next - Proposed replacement, or undefined for deletion.
   * @returns Whether the transition targets the current administrator or last active administrator.
   * @remarks This pure guard reads runtime users but does not mutate users or audit state.
   */
  private violatesAdminGuard(current: User, next: User | undefined): boolean {
    if (current.role !== 'ADMIN') {
      return false
    }

    const removesAdminAuthority = next === undefined
      || next.role !== 'ADMIN'
      || next.status !== 'ACTIVE'
    if (!removesAdminAuthority) {
      return false
    }

    const activeAdminCount = this.runtimeState.users.filter(
      (candidate) => candidate.role === 'ADMIN' && candidate.status === 'ACTIVE',
    ).length
    // The fixture's current administrator is never deleted/demoted; no operation may remove the last active admin.
    return current.userId === CURRENT_ADMIN_ID || activeAdminCount <= 1
  }

  /**
   * Appends one deterministic immutable audit record.
   *
   * @param actor - Username or boundary label responsible for the operation.
   * @param role - Role associated with the operation.
   * @param action - Stable audited action name.
   * @param objectId - Optional affected object identifier.
   * @param result - SUCCESS, ERROR, or DENIED terminal outcome.
   * @returns Nothing.
   * @remarks Advances the in-memory audit sequence and mutates only the audit projection.
   */
  private appendAudit(
    actor: string,
    role: Role,
    action: string,
    objectId: string | undefined,
    result: AuditRecord['result'],
  ): void {
    const auditId = `AUD-P1-${String(this.runtimeState.nextAuditSequence).padStart(4, '0')}`
    this.runtimeState.nextAuditSequence += 1
    this.runtimeState.audit.push({
      auditId,
      actor,
      role,
      action,
      ...(objectId === undefined ? {} : { objectId }),
      result,
      occurredAt: this.runtimeState.occurredAt,
      immutableFixture: true,
    })
  }
}

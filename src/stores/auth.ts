import { defineStore } from 'pinia'
import type {
  ApiFailure,
  ApiResult,
  AuthResult,
  CapabilityState,
  LoginRequest,
  Permission,
  Principal,
  RbacDecision,
  Role,
} from '../contracts/domain-models'

const DEFAULT_MOCK_ORIGIN = 'http://127.0.0.1:4173'
const AUTH_SESSION_KEY = 'wrj.auth.principal'

type AuthFeedbackCode =
  | 'SUCCESS'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'PERMISSION_DENIED'

interface PermissionSet {
  role: Role
  permissions: Permission[]
}

/** Credentials accepted by the application-facing authentication API. */
export interface LoginCredentials {
  username: string
  password: string
}

const PERMISSIONS: readonly Permission[] = [
  'BUSINESS_READ',
  'SCENARIO_DRAFT_WRITE',
  'SIMULATION_CONTROL',
  'ORDINARY_REPORT_EXPORT',
  'OFFICIAL_TEMPLATE_MAINTAIN',
  'MASTER_DATA_MAINTAIN',
  'USER_ROLE_MAINTAIN',
  'BACKUP_RESTORE',
  'AUDIT_READ',
  'FULL_CONFIG_EXPORT',
  'BATCH_LEVEL_III_EXPORT',
]

/**
 * Checks whether an unknown value is a permission from the closed RBAC vocabulary.
 *
 * @param value - Candidate value returned by the authentication service.
 * @returns Whether the value is a supported permission.
 * @remarks This pure validator performs no network access and does not mutate store state.
 */
function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
}

/**
 * Validates a principal and its complete permission list at the network boundary.
 *
 * @param value - Candidate principal from a login response.
 * @returns Whether the candidate conforms to the closed principal contract.
 * @remarks This pure validator performs no network access and does not mutate store state.
 */
function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Principal>
  return typeof candidate.userId === 'string'
    && typeof candidate.username === 'string'
    && (candidate.role === 'ADMIN' || candidate.role === 'OPERATOR')
    && Array.isArray(candidate.permissions)
    && candidate.permissions.every(isPermission)
}

/**
 * 校验待持久化值是否为仅含必要身份字段的安全投影。
 *
 * @param value - 从会话存储解析出的候选身份投影。
 * @returns 候选值是否通过主体校验且没有额外字段。
 * @remarks 此纯校验不访问存储、不执行网络请求，也不修改 Store 状态。
 */
function isStoredPrincipal(value: unknown): value is Principal {
  if (!isPrincipal(value)) return false
  const keys = Object.keys(value)
  return keys.length === 4
    && keys.every((key) => ['userId', 'username', 'role', 'permissions'].includes(key))
}

/**
 * 清除当前标签页中持久化的身份投影。
 *
 * @returns 无返回值。
 * @remarks 无参数；会尝试删除 sessionStorage 项，存储不可用或抛错时静默失败，且不修改 Store 状态。
 */
function clearStoredPrincipal(): void {
  try {
    if (typeof window !== 'undefined') window.sessionStorage.removeItem(AUTH_SESSION_KEY)
  } catch {
    // 浏览器禁用或隔离会话存储时，认证与退出流程仍继续使用内存状态。
  }
}

/**
 * 将已校验主体写入当前标签页的安全身份投影。
 *
 * @param principal - 登录或权限刷新成功后得到的主体。
 * @returns 无返回值。
 * @remarks 仅写入 userId、username、role、permissions；主体无效或存储抛错时会尽力清除旧值，且不修改 Store 状态。
 */
function storePrincipal(principal: unknown): void {
  if (!isPrincipal(principal)) {
    clearStoredPrincipal()
    return
  }

  const projection: Principal = {
    userId: principal.userId,
    username: principal.username,
    role: principal.role,
    permissions: [...principal.permissions],
  }
  try {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(projection))
    }
  } catch {
    clearStoredPrincipal()
  }
}

/**
 * 同步恢复当前标签页中经过严格校验的身份投影。
 *
 * @returns 有效主体的防御性副本；无数据、数据损坏或存储不可用时返回 null。
 * @remarks 无参数；异常或不合规数据会被尽力删除，不执行网络请求，也不修改 Store 状态。
 */
function restoreStoredPrincipal(): Principal | null {
  try {
    if (typeof window === 'undefined') return null
    const serialized = window.sessionStorage.getItem(AUTH_SESSION_KEY)
    if (serialized === null) return null
    const candidate: unknown = JSON.parse(serialized)
    if (!isStoredPrincipal(candidate)) {
      clearStoredPrincipal()
      return null
    }
    return {
      userId: candidate.userId,
      username: candidate.username,
      role: candidate.role,
      permissions: [...candidate.permissions],
    }
  } catch {
    clearStoredPrincipal()
    return null
  }
}

/**
 * Determines whether a hostname identifies a supported loopback interface.
 *
 * @param hostname - Hostname parsed from a configured service origin.
 * @returns Whether the hostname is an IPv4, IPv6, or named loopback host.
 * @remarks This pure check performs no network access and does not mutate store state.
 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

/**
 * Resolves and validates the configured development service origin.
 *
 * @param candidate - Optional origin override; defaults to `VITE_MOCK_ORIGIN`.
 * @returns A normalized HTTP(S) loopback origin.
 * @throws When the supplied origin is malformed, credential-bearing, or non-loopback.
 * @remarks Resolution performs no network access and does not mutate authentication state.
 */
export function resolveMockOrigin(candidate = import.meta.env.VITE_MOCK_ORIGIN): string {
  const origin = candidate?.trim() || DEFAULT_MOCK_ORIGIN
  let url: URL

  try {
    url = new URL(origin)
  } catch {
    throw new Error('VITE_MOCK_ORIGIN must be a valid loopback URL.')
  }

  if (!['http:', 'https:'].includes(url.protocol) || !isLoopbackHost(url.hostname) || url.username || url.password) {
    throw new Error('VITE_MOCK_ORIGIN must use an HTTP(S) loopback origin.')
  }

  return url.origin
}

/**
 * Validates the minimum error fields required from a failed API response.
 *
 * @param value - Candidate response payload.
 * @returns Whether the payload is a typed API failure.
 * @remarks This pure validator performs no network access and does not mutate store state.
 */
function isApiFailure(value: unknown): value is ApiFailure {
  return typeof value === 'object'
    && value !== null
    && (value as { ok?: unknown }).ok === false
    && typeof (value as { error?: { code?: unknown } }).error?.code === 'string'
    && typeof (value as { error?: { message?: unknown } }).error?.message === 'string'
}

/**
 * Validates a login result, including authentication cross-field and no-session invariants.
 *
 * @param value - Candidate authentication result.
 * @returns Whether success has a principal without a reason, or failure has no principal and at
 * most one supported reason, with `sessionCreated` always false.
 * @remarks This pure validator performs no network access and does not mutate store state.
 */
function isAuthResult(value: unknown): value is AuthResult {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { authenticated?: unknown; principal?: unknown; reason?: unknown; sessionCreated?: unknown }
  if (typeof candidate.authenticated !== 'boolean' || candidate.sessionCreated !== false) return false
  const supportedReason = candidate.reason === undefined
    || candidate.reason === 'INVALID_CREDENTIALS'
    || candidate.reason === 'ACCOUNT_LOCKED'
  if (!supportedReason) return false
  if (candidate.authenticated) {
    return candidate.reason === undefined && isPrincipal(candidate.principal)
  }
  return candidate.principal === undefined
}

/**
 * Reads a valid authentication result from either a bare or enveloped response.
 *
 * @param value - Parsed response payload.
 * @returns The validated authentication result, or `undefined` for malformed input.
 * @remarks This pure adapter performs no network access and does not mutate store state.
 */
function readAuthResult(value: unknown): AuthResult | undefined {
  if (isAuthResult(value)) return value
  if (typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true) {
    const data = (value as ApiResult<AuthResult> & { data?: unknown }).data
    return isAuthResult(data) ? data : undefined
  }
  return undefined
}

/**
 * Reads a validated role-permission projection from a bare or enveloped response.
 *
 * @param value - Parsed permissions response payload.
 * @returns A defensive copy of the permission set, or `undefined` for malformed input.
 * @remarks This pure adapter performs no network access and does not mutate store state.
 */
function readPermissionSet(value: unknown): PermissionSet | undefined {
  const data = typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true
    ? (value as { data?: unknown }).data
    : value

  if (typeof data !== 'object' || data === null) return undefined
  const candidate = data as { role?: unknown; permissions?: unknown }
  if ((candidate.role !== 'ADMIN' && candidate.role !== 'OPERATOR')
    || !Array.isArray(candidate.permissions)
    || !candidate.permissions.every(isPermission)) {
    return undefined
  }

  return {
    role: candidate.role,
    permissions: [...candidate.permissions],
  }
}

/**
 * Narrows an application username to the frozen development transport vocabulary.
 *
 * @param username - Trimmed username entered by the user.
 * @returns Whether the username can be represented by the private wire contract.
 * @remarks This pure validator performs no network access and does not mutate store state.
 */
function isLoginUsername(username: string): username is LoginRequest['username'] {
  return username === 'admin' || username === 'operator' || username === 'locked'
}

/**
 * Maps product credentials to the private frozen login request after fail-closed validation.
 *
 * @param credentials - Application-facing username and password values.
 * @returns A wire request for supported, non-empty credentials; otherwise `undefined`.
 * @remarks The mapping does not persist credentials, perform network access, or mutate store state.
 */
function toLoginRequest(credentials: LoginCredentials): LoginRequest | undefined {
  const username = credentials.username.trim()
  if (!isLoginUsername(username) || !credentials.password.trim()) return undefined
  return { username, passwordFixture: credentials.password }
}

/**
 * Verifies that a successful result belongs to the username and role of the current request.
 *
 * @param result - Semantically valid authentication result returned by the service.
 * @param request - Private wire request created for the current login attempt.
 * @returns Whether the result is an authenticated principal bound to this request.
 * @remarks This pure validator performs no network access and does not mutate store state; locked
 * accounts can never produce a successful bound result.
 */
function isAuthResultForRequest(
  result: AuthResult,
  request: LoginRequest,
): result is AuthResult & { authenticated: true; principal: Principal } {
  if (!result.authenticated || result.principal === undefined || request.username === 'locked') return false
  const expectedRole: Role = request.username === 'admin' ? 'ADMIN' : 'OPERATOR'
  return result.principal.username === request.username && result.principal.role === expectedRole
}

export const useAuthStore = defineStore('auth', {
  state: () => {
    const principal = restoreStoredPrincipal()
    return {
      principal,
      role: principal?.role ?? 'OPERATOR' as Role,
      permissions: principal === null ? [] as Permission[] : [...principal.permissions],
      authState: principal === null ? 'EMPTY' as CapabilityState : 'SUCCESS' as CapabilityState,
      lastResult: null as AuthResult | null,
      lastDenial: null as RbacDecision | null,
      lastCode: null as AuthFeedbackCode | null,
      lastMessage: '',
    }
  },

  actions: {
    /**
     * 通过冻结的开发传输合同验证应用凭据。
     *
     * @param credentials - 用户输入的用户名和密码，仅支持固定用户名进入网络请求。
     * @returns 校验通过的认证结果，或按安全关闭策略生成的未认证结果。
     * @remarks 依次更新认证阶段并对有效输入发起一次回环 POST；成功时替换内存主体并持久化
     * 安全身份投影，失败时恢复 OPERATOR 基线并清除会话投影，且绝不持久化密码。
     */
    async login(credentials: LoginCredentials): Promise<AuthResult> {
      clearStoredPrincipal()
      this.authState = 'LOADING'
      this.principal = null
      this.role = 'OPERATOR'
      this.permissions = []
      this.lastResult = null
      this.lastDenial = null
      this.lastCode = null
      this.lastMessage = ''

      // Yield between the three visible phases so assistive UI and tests can observe the contract order.
      await Promise.resolve()
      this.authState = 'VALIDATING'

      const request = toLoginRequest(credentials)
      if (request === undefined) {
        const result: AuthResult = {
          authenticated: false,
          reason: 'INVALID_CREDENTIALS',
          sessionCreated: false,
        }
        this.lastResult = result
        this.lastCode = 'INVALID_CREDENTIALS'
        this.lastMessage = '请输入有效的用户名和密码。'
        this.authState = 'ERROR'
        clearStoredPrincipal()
        return result
      }

      this.role = request.username === 'admin' ? 'ADMIN' : 'OPERATOR'

      await Promise.resolve()
      this.authState = 'EXECUTING'

      try {
        const response = await fetch(`${resolveMockOrigin()}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })
        const payload: unknown = await response.json().catch(() => undefined)
        const result = readAuthResult(payload)

        if (response.ok && result !== undefined && isAuthResultForRequest(result, request)) {
          this.principal = result.principal
          this.role = result.principal.role
          this.permissions = [...result.principal.permissions]
          this.lastResult = result
          this.lastCode = 'SUCCESS'
          this.lastMessage = '登录成功。'
          this.authState = 'SUCCESS'
          storePrincipal(this.principal)
          return result
        }

        const failureCode = isApiFailure(payload) ? payload.error.code : result?.reason
        if (failureCode !== 'INVALID_CREDENTIALS' && failureCode !== 'ACCOUNT_LOCKED') {
          const rejected: AuthResult = { authenticated: false, sessionCreated: false }
          this.principal = null
          this.role = 'OPERATOR'
          this.permissions = []
          this.lastResult = rejected
          this.lastCode = 'INVALID_RESPONSE'
          this.lastMessage = isApiFailure(payload) ? payload.error.message : '登录响应不符合约定。'
          this.authState = 'ERROR'
          clearStoredPrincipal()
          return rejected
        }

        const reason = failureCode === 'ACCOUNT_LOCKED' ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS'
        const rejected: AuthResult = result ?? {
          authenticated: false,
          reason,
          sessionCreated: false,
        }
        this.principal = null
        this.role = 'OPERATOR'
        this.permissions = []
        this.lastResult = rejected
        this.lastCode = reason
        this.lastMessage = isApiFailure(payload) ? payload.error.message : reason
        this.authState = 'ERROR'
        clearStoredPrincipal()
        return rejected
      } catch {
        const result: AuthResult = { authenticated: false, sessionCreated: false }
        this.principal = null
        this.role = 'OPERATOR'
        this.permissions = []
        this.lastResult = result
        this.lastCode = 'NETWORK_ERROR'
        this.lastMessage = '认证服务暂时不可用，请稍后重试。'
        this.authState = 'ERROR'
        clearStoredPrincipal()
        return result
      }
    },

    /**
     * 刷新当前已认证角色的权限。
     *
     * @returns 接受与当前角色匹配的权限集时返回 true，否则返回 false。
     * @remarks 无参数；主体存在时发起一次回环 GET，成功时更新内存主体及会话投影，响应无效、
     * 无主体或传输失败时清除全部认证能力和会话投影。
     */
    async refreshPermissions(): Promise<boolean> {
      if (this.principal === null) {
        this.resetToSafeEmpty()
        return false
      }

      this.authState = 'EXECUTING'
      try {
        const response = await fetch(`${resolveMockOrigin()}/api/v1/auth/permissions`, {
          method: 'GET',
          headers: { 'X-Demo-Role': this.role },
        })
        const payload: unknown = await response.json().catch(() => undefined)
        const permissionSet = readPermissionSet(payload)
        if (!response.ok || permissionSet === undefined || permissionSet.role !== this.role) {
          const message = isApiFailure(payload) ? payload.error.message : '权限响应不符合约定。'
          this.resetToSafeEmpty()
          this.authState = 'ERROR'
          this.lastCode = 'INVALID_RESPONSE'
          this.lastMessage = message
          return false
        }

        this.permissions = [...permissionSet.permissions]
        this.principal = { ...this.principal, role: permissionSet.role, permissions: this.permissions }
        this.authState = 'SUCCESS'
        this.lastCode = 'SUCCESS'
        this.lastMessage = '权限已更新。'
        storePrincipal(this.principal)
        return true
      } catch {
        this.resetToSafeEmpty()
        this.authState = 'ERROR'
        this.lastCode = 'NETWORK_ERROR'
        this.lastMessage = '权限服务暂时不可用，请稍后重试。'
        return false
      }
    },

    /**
     * Evaluates whether the current in-memory principal may use a permission.
     *
     * @param permission - Permission required by the attempted application action.
     * @returns A typed allow or `PERMISSION_DENIED` decision.
     * @remarks Performs no network access; a denial updates visible feedback and `lastDenial`,
     * while an allow clears the previous denial. No credential or session state is persisted.
     */
    authorize(permission: Permission): RbacDecision {
      const adminOnlyDenied = permission === 'USER_ROLE_MAINTAIN' && this.role !== 'ADMIN'
      const allowed = this.principal !== null && this.permissions.includes(permission) && !adminOnlyDenied
      const decision: RbacDecision = allowed
        ? { allowed: true, permission }
        : { allowed: false, permission, reason: 'PERMISSION_DENIED' }

      this.lastDenial = allowed ? null : decision
      if (!allowed) {
        this.lastCode = 'PERMISSION_DENIED'
        this.lastMessage = `当前 ${this.role} 角色缺少 ${permission} 权限。`
      }
      return decision
    },

    /**
     * 清除全部内存认证、授权状态和会话身份投影。
     *
     * @returns 无返回值。
     * @remarks 无参数；不执行网络请求，恢复安全的 OPERATOR 基线，并尽力删除 sessionStorage
     * 中的身份投影，不访问 Cookie 或 localStorage。
     */
    resetToSafeEmpty(): void {
      this.principal = null
      this.role = 'OPERATOR'
      this.permissions = []
      this.authState = 'EMPTY'
      this.lastResult = null
      this.lastDenial = null
      this.lastCode = null
      this.lastMessage = ''
      clearStoredPrincipal()
    },
  },
})

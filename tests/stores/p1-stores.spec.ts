import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ApiFailure,
  ApiSuccess,
  PageMeta,
  Principal,
  User,
} from '../../src/contracts/domain-models'
import { isUser, useAdminStore } from '../../src/stores/admin'
import { resolveMockOrigin, useAuthStore } from '../../src/stores/auth'

const DEFAULT_LOGIN_PASSWORD = '123456'

const META: PageMeta = {
  requestId: 'REQ-P1-STORE',
  generatedAt: '2026-08-06T08:00:00Z',
  page: 1,
  pageSize: 1,
  total: 1,
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}

function success<T>(data: T): ApiSuccess<T> {
  return { ok: true, data, meta: META }
}

function apiFailure(code: ApiFailure['error']['code'], message: string): ApiFailure {
  return {
    ok: false,
    error: { code, message, retryable: false, correlationId: `CORR-${code}` },
    meta: { requestId: META.requestId, generatedAt: META.generatedAt },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('P1 store coverage: admin', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('validates the closed User schema with RFC 3339 timestamps', () => {
    const base: User = { userId: 'USR-X', username: 'x', role: 'OPERATOR', status: 'ACTIVE' }
    for (const lastLoginAt of [
      '2026-08-06T08:00:00Z',
      '2026-08-06t08:00:00z',
      '2026-08-06T08:00:00+08:00',
      '2026-08-06T08:00:00.123Z',
      '2024-02-29T00:00:00Z',
      '2000-02-29T00:00:00Z',
      '2026-02-28T00:00:00Z',
    ]) {
      expect(isUser({ ...base, lastLoginAt })).toBe(true)
    }

    for (const lastLoginAt of [
      '2026-02-30T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-00-01T00:00:00Z',
      '2026-01-00T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '1900-02-29T00:00:00Z',
      'garbage',
    ]) {
      expect(isUser({ ...base, lastLoginAt })).toBe(false)
    }

    expect(isUser({ ...base, userId: '' })).toBe(false)
    expect(isUser({ ...base, role: 'ROOT' as never })).toBe(false)
    expect(isUser({ ...base, status: 'BANNED' as never })).toBe(false)
    expect(isUser({ ...base, lastLoginAt: 42 as never })).toBe(false)
  })

  it('reaches EMPTY when the mock returns an empty user list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(success([]))))
    const admin = useAdminStore()

    await admin.refreshUsers()

    expect(admin.panelState).toBe('EMPTY')
    expect(admin.resultCode).toBe('SUCCESS')
  })

  it('covers the six-state lifecycle across refresh, mutation, empty, and error outcomes', async () => {
    const refreshResponse = deferred<Response>()
    const refreshPayload = deferred<ReturnType<typeof success<User[]>>>()
    const mutationResponse = deferred<Response>()
    const mutationPayload = deferred<ReturnType<typeof success<User>>>()
    const fetchSpy = vi.fn()
      .mockReturnValueOnce(refreshResponse.promise)
      .mockReturnValueOnce(mutationResponse.promise)
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: {}, meta: META }))
    vi.stubGlobal('fetch', fetchSpy)
    const admin = useAdminStore()

    expect(admin.panelState).toBe('SUCCESS')

    const refresh = admin.refreshUsers()
    expect(admin.panelState).toBe('LOADING')
    refreshResponse.resolve({ ok: true, json: () => refreshPayload.promise } as Response)
    await Promise.resolve()
    expect(admin.panelState).toBe('VALIDATING')
    refreshPayload.resolve(success([]))
    await refresh
    expect(admin.panelState).toBe('EMPTY')

    const operator: User = {
      userId: 'USR-OPERATOR',
      username: 'operator',
      role: 'OPERATOR',
      status: 'ACTIVE',
    }
    const promoted: User = { ...operator, role: 'ADMIN' }
    const mutation = admin.mutateUser(operator, 'UPDATE', promoted)
    expect(admin.panelState).toBe('LOADING')
    await Promise.resolve()
    expect(admin.panelState).toBe('VALIDATING')
    await Promise.resolve()
    expect(admin.panelState).toBe('EXECUTING')
    mutationResponse.resolve({ ok: true, json: () => mutationPayload.promise } as Response)
    await Promise.resolve()
    expect(admin.panelState).toBe('VALIDATING')
    mutationPayload.resolve(success(promoted))
    await mutation
    expect(admin.panelState).toBe('SUCCESS')

    await admin.refreshUsers()
    expect(admin.panelState).toBe('ERROR')
    expect(admin.resultCode).toBe('INVALID_RESPONSE')
  })

  it('surfaces a typed API failure code and message from refreshUsers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      apiFailure('PERMISSION_DENIED', '权限头无效'),
      false,
    )))
    const admin = useAdminStore()

    await admin.refreshUsers()

    expect(admin.panelState).toBe('ERROR')
    expect(admin.resultCode).toBe('PERMISSION_DENIED')
    expect(admin.resultMessage).toBe('权限头无效')
  })

  it('rejects malformed failure envelopes and non-array user payloads', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: { code: 'X' } }, false))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: {}, meta: META }))
    vi.stubGlobal('fetch', fetchSpy)
    const admin = useAdminStore()

    await admin.refreshUsers()
    expect(admin.panelState).toBe('ERROR')
    expect(admin.resultCode).toBe('INVALID_RESPONSE')

    await admin.refreshUsers()
    expect(admin.panelState).toBe('ERROR')
    expect(admin.resultCode).toBe('INVALID_RESPONSE')
  })

  it('maps UPDATE success and rejects extra keys in DELETE results', async () => {
    const original: User = { userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', status: 'ACTIVE' }
    const promoted: User = { ...original, role: 'ADMIN' }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(success(promoted)))
      .mockResolvedValueOnce(jsonResponse(success({ deleted: true, objectId: 'USR-OPERATOR', extra: 1 })))
    vi.stubGlobal('fetch', fetchSpy)
    const admin = useAdminStore()

    await expect(admin.mutateUser(original, 'UPDATE', promoted)).resolves.toBe(true)
    expect(admin.users).toContainEqual(promoted)

    await expect(admin.mutateUser(promoted, 'DELETE', promoted)).resolves.toBe(false)
    expect(admin.panelState).toBe('ERROR')
    expect(admin.resultCode).toBe('INVALID_RESPONSE')
    expect(admin.users).toContainEqual(promoted)
  })

  it('rejects an invalid user shape in a CREATE response and localizes empty input', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(success({ userId: 'USR-BAD', secret: true })))
    vi.stubGlobal('fetch', fetchSpy)
    const admin = useAdminStore()

    await expect(admin.createUser('ok-name', 'OPERATOR', 'ACTIVE')).resolves.toBe(false)
    expect(admin.resultCode).toBe('INVALID_RESPONSE')

    await expect(admin.createUser('   ', 'OPERATOR', 'ACTIVE')).resolves.toBe(false)
    expect(admin.resultCode).toBe('VALIDATION_FAILED')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the users response body cannot be parsed', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(new Error('bad json')) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(new Error('bad json')) } as unknown as Response)
    vi.stubGlobal('fetch', fetchSpy)
    const admin = useAdminStore()

    await admin.refreshUsers()
    expect(admin.panelState).toBe('ERROR')
    expect(admin.resultCode).toBe('INVALID_RESPONSE')

    const operator: User = { userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', status: 'ACTIVE' }
    await expect(admin.mutateUser(operator, 'DELETE', operator)).resolves.toBe(false)
    expect(admin.panelState).toBe('ERROR')
    expect(admin.resultCode).toBe('INVALID_RESPONSE')
  })

  it('resets the user projection to a safe empty state', () => {
    const admin = useAdminStore()
    admin.resetToSafeEmpty()

    expect(admin.$state).toMatchObject({
      users: [],
      panelState: 'EMPTY',
      resultCode: 'EMPTY',
    })
  })
})

describe('P1 store coverage: auth', () => {
  const AUTH_SESSION_KEY = 'wrj.auth.principal'
  const ADMIN_PRINCIPAL: Principal = {
    userId: 'USR-ADMIN',
    username: 'admin',
    role: 'ADMIN',
    permissions: ['BUSINESS_READ'],
  }
  const OPERATOR_PRINCIPAL: Principal = {
    userId: 'USR-OPERATOR',
    username: 'operator',
    role: 'OPERATOR',
    permissions: ['BUSINESS_READ'],
  }

  beforeEach(() => {
    sessionStorage.clear()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it('accepts a bare AuthResult payload without an envelope', async () => {
    const result = { authenticated: true, principal: ADMIN_PRINCIPAL, sessionCreated: false }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(result)))
    const auth = useAuthStore()

    await auth.login({ username: 'admin', password: DEFAULT_LOGIN_PASSWORD })

    expect(auth.authState).toBe('SUCCESS')
    expect(auth.principal).toEqual(ADMIN_PRINCIPAL)
    expect(JSON.parse(sessionStorage.getItem(AUTH_SESSION_KEY) ?? 'null')).toEqual(ADMIN_PRINCIPAL)
    expect(sessionStorage).toHaveLength(1)
    const persisted = sessionStorage.getItem(AUTH_SESSION_KEY) ?? ''
    expect(persisted).not.toContain(DEFAULT_LOGIN_PASSWORD)
    expect(persisted).not.toContain('password')
    expect(persisted).not.toContain('passwordFixture')
    expect(persisted).not.toContain('token')
  })

  it('restores a valid safe principal projection synchronously', () => {
    sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(ADMIN_PRINCIPAL))

    const auth = useAuthStore()

    expect(auth.$state).toMatchObject({
      principal: ADMIN_PRINCIPAL,
      role: 'ADMIN',
      permissions: ADMIN_PRINCIPAL.permissions,
      authState: 'SUCCESS',
      lastResult: null,
      lastCode: null,
    })
  })

  it('fails closed and removes damaged or structurally abnormal principal projections', () => {
    for (const serialized of [
      '{bad json',
      JSON.stringify({ ...ADMIN_PRINCIPAL, permissions: ['UNKNOWN_PERMISSION'] }),
      JSON.stringify({ ...ADMIN_PRINCIPAL, token: 'must-not-survive' }),
    ]) {
      sessionStorage.setItem(AUTH_SESSION_KEY, serialized)
      setActivePinia(createPinia())

      const auth = useAuthStore()

      expect(auth.principal).toBeNull()
      expect(auth.role).toBe('OPERATOR')
      expect(auth.permissions).toEqual([])
      expect(auth.authState).toBe('EMPTY')
      expect(sessionStorage.getItem(AUTH_SESSION_KEY)).toBeNull()
    }
  })

  it('clears the persisted projection when reset to a safe empty state', () => {
    sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(ADMIN_PRINCIPAL))
    const auth = useAuthStore()

    auth.resetToSafeEmpty()

    expect(auth.principal).toBeNull()
    expect(auth.role).toBe('OPERATOR')
    expect(auth.permissions).toEqual([])
    expect(auth.authState).toBe('EMPTY')
    expect(sessionStorage.getItem(AUTH_SESSION_KEY)).toBeNull()
  })

  it('accepts a request-bound OPERATOR success response', async () => {
    const result = { authenticated: true, principal: OPERATOR_PRINCIPAL, sessionCreated: false }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(success(result))))
    const auth = useAuthStore()

    await auth.login({ username: 'operator', password: DEFAULT_LOGIN_PASSWORD })

    expect(auth.authState).toBe('SUCCESS')
    expect(auth.principal).toEqual(OPERATOR_PRINCIPAL)
    expect(auth.role).toBe('OPERATOR')
  })

  it('rejects cross-field and request-binding inconsistencies fail-closed', async () => {
    const cases = [
      {
        credentials: { username: 'operator' as const, password: DEFAULT_LOGIN_PASSWORD },
        result: { authenticated: true, principal: ADMIN_PRINCIPAL, sessionCreated: false },
      },
      {
        credentials: { username: 'admin' as const, password: DEFAULT_LOGIN_PASSWORD },
        result: {
          authenticated: true,
          principal: { ...ADMIN_PRINCIPAL, username: 'operator' },
          sessionCreated: false,
        },
      },
      {
        credentials: { username: 'admin' as const, password: DEFAULT_LOGIN_PASSWORD },
        result: {
          authenticated: false,
          principal: ADMIN_PRINCIPAL,
          reason: 'INVALID_CREDENTIALS',
          sessionCreated: false,
        },
      },
      {
        credentials: { username: 'admin' as const, password: DEFAULT_LOGIN_PASSWORD },
        result: {
          authenticated: true,
          principal: ADMIN_PRINCIPAL,
          reason: 'INVALID_CREDENTIALS',
          sessionCreated: false,
        },
      },
    ]
    const fetchSpy = vi.fn()
    for (const testCase of cases) {
      fetchSpy.mockResolvedValueOnce(jsonResponse(success(testCase.result)))
    }
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()

    for (const testCase of cases) {
      await auth.login(testCase.credentials)

      expect(auth.lastCode).toBe('INVALID_RESPONSE')
      expect(auth.principal).toBeNull()
      expect(auth.permissions).toEqual([])
      expect(auth.role).toBe('OPERATOR')
      expect(auth.authState).toBe('ERROR')
    }
  })

  it('rejects malformed principals, unknown reasons, and non-boolean authenticated flags', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(success({
        authenticated: true,
        principal: { userId: 'USR-X', username: 'x', role: 'ADMIN', permissions: 'nope' },
        sessionCreated: false,
      })))
      .mockResolvedValueOnce(jsonResponse(success({
        authenticated: true,
        principal: ADMIN_PRINCIPAL,
        sessionCreated: false,
        reason: 'WEIRD',
      })))
      .mockResolvedValueOnce(jsonResponse(success({
        authenticated: 'yes',
        principal: ADMIN_PRINCIPAL,
        sessionCreated: false,
      })))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await auth.login({ username: 'admin', password: DEFAULT_LOGIN_PASSWORD })
      expect(auth.authState).toBe('ERROR')
      expect(auth.lastCode).toBe('INVALID_RESPONSE')
      expect(auth.principal).toBeNull()
    }
  })

  it('treats non-credential API failure codes as invalid responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      apiFailure('VALIDATION_FAILED', '字段无效'),
      false,
    )))
    const auth = useAuthStore()

    await auth.login({ username: 'admin', password: DEFAULT_LOGIN_PASSWORD })

    expect(auth.authState).toBe('ERROR')
    expect(auth.lastCode).toBe('INVALID_RESPONSE')
    expect(auth.lastMessage).toBe('字段无效')
  })

  it('restores the safe OPERATOR role after every ADMIN login failure class', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse(apiFailure('INVALID_CREDENTIALS', '密码不正确'), false))
      .mockResolvedValueOnce(jsonResponse(success({
        authenticated: true,
        principal: ADMIN_PRINCIPAL,
        sessionCreated: true,
      })))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()

    for (const expectedCode of ['INVALID_CREDENTIALS', 'INVALID_RESPONSE', 'NETWORK_ERROR'] as const) {
      await auth.login({ username: 'admin', password: DEFAULT_LOGIN_PASSWORD })

      expect(auth.authState).toBe('ERROR')
      expect(auth.lastCode).toBe(expectedCode)
      expect(auth.principal).toBeNull()
      expect(auth.permissions).toEqual([])
      expect(auth.role).toBe('OPERATOR')
    }
  })

  it('refuses permission refresh without a principal and resets safely', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()

    await expect(auth.refreshPermissions()).resolves.toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(auth.authState).toBe('EMPTY')
    expect(auth.principal).toBeNull()
  })

  it('fails closed when the auth response body cannot be parsed', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(new Error('bad json')) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(new Error('bad json')) } as unknown as Response)
    vi.stubGlobal('fetch', fetchSpy)
    const auth = useAuthStore()

    await auth.login({ username: 'admin', password: DEFAULT_LOGIN_PASSWORD })
    expect(auth.authState).toBe('ERROR')
    expect(auth.lastCode).toBe('INVALID_RESPONSE')

    auth.$patch({ principal: ADMIN_PRINCIPAL, role: 'ADMIN', permissions: ['BUSINESS_READ'] })
    await expect(auth.refreshPermissions()).resolves.toBe(false)
    expect(auth.authState).toBe('ERROR')
    expect(auth.lastCode).toBe('INVALID_RESPONSE')
  })

  it('resolves the default loopback origin and trims candidates', () => {
    expect(resolveMockOrigin()).toBe('http://127.0.0.1:4173')
    expect(resolveMockOrigin('  http://127.0.0.1:4173/  ')).toBe('http://127.0.0.1:4173')
  })
})

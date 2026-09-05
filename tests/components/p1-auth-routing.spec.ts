import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import App from '../../src/App.vue'
import AdminPage from '../../src/pages/admin/admin.vue'
import AdminDataExchangePage from '../../src/pages/admin-data-exchange/admin-data-exchange.vue'
import BatchesPage from '../../src/pages/batches/batches.vue'
import BlueprintPage from '../../src/pages/blueprint/blueprint.vue'
import InteractionsPage from '../../src/pages/interactions/interactions.vue'
import LoginPage from '../../src/pages/login/login.vue'
import ReplaysPage from '../../src/pages/replays/replays.vue'
import ReportsPage from '../../src/pages/reports/reports.vue'
import ScenariosPage from '../../src/pages/scenarios/scenarios.vue'
import SituationPage from '../../src/pages/situation/situation.vue'
import TraceabilityPage from '../../src/pages/traceability/traceability.vue'
import type {
  ApiErrorCode,
  ApiFailure,
  ApiSuccess,
  AuthResult,
  PageMeta,
  Permission,
  Principal,
  Role,
  User,
  TelemetryFrame,
} from '../../src/contracts/domain-models'
import { createAppRouter, requireAdmin, requirePrincipal, routeRecords } from '../../src/router'
import { resolveMockOrigin, useAuthStore } from '../../src/stores/auth'
import { useTelemetryStore } from '../../src/stores/telemetry'

const DEFAULT_LOGIN_PASSWORD = '123456'

const META: PageMeta = {
  requestId: 'REQ-P1-TEST',
  generatedAt: '2026-08-06T08:00:00Z',
  page: 1,
  pageSize: 1,
  total: 1,
}

const OPERATOR: Principal = {
  userId: 'USR-OPERATOR',
  username: 'operator',
  role: 'OPERATOR',
  permissions: ['BUSINESS_READ'],
}

const ADMIN: Principal = {
  userId: 'USR-ADMIN',
  username: 'admin',
  role: 'ADMIN',
  permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'],
}

function response(body: unknown, ok = true): Response {
  return {
    ok,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response
}

function success<T>(data: T): ApiSuccess<T> {
  return { ok: true, data, meta: META }
}

function failure(code: 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED', message: string): ApiFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: false,
      correlationId: `CORR-${code}`,
    },
    meta: { requestId: META.requestId, generatedAt: META.generatedAt },
  }
}

function apiFailure(code: ApiErrorCode, message: string): ApiFailure {
  return {
    ok: false,
    error: { code, message, retryable: false, correlationId: `CORR-${code}` },
    meta: { requestId: META.requestId, generatedAt: META.generatedAt },
  }
}

function permissionSuccess(role: Role, permissions: Permission[]) {
  return success({ role, permissions })
}

async function mountAt(
  component: typeof LoginPage | typeof AdminPage | typeof InteractionsPage,
  path: '/login' | '/admin' | '/interactions',
) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore(pinia)
  if (path === '/admin') {
    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
  } else if (path === '/interactions') {
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    useTelemetryStore(pinia).$patch({
      frame: structuredClone(fixtureSource.frame) as unknown as TelemetryFrame,
      capabilityState: 'SUCCESS',
    })
  }
  const router = createAppRouter(createMemoryHistory(), pinia)
  await router.push(path)
  const wrapper = mount(component, { global: { plugins: [pinia, router, ElementPlus] } })
  return { auth, router, wrapper }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('P1 authentication and routing', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('defines exactly the frozen 11 named routes', async () => {
    expect(routeRecords).toHaveLength(11)
    expect(routeRecords.map(({ name, path, beforeEnter, meta }) => ({ name, path, beforeEnter, meta }))).toEqual([
      { name: 'login', path: '/login', beforeEnter: undefined, meta: { title: '登录', guard: 'public', layout: 'standalone' } },
      { name: 'situation', path: '/situation', beforeEnter: requirePrincipal, meta: { title: '态势展示', guard: 'principal', layout: 'workspace' } },
      { name: 'scenarios', path: '/scenarios', beforeEnter: requirePrincipal, meta: { title: '场景管理', guard: 'principal', layout: 'workspace' } },
      { name: 'batches', path: '/batches', beforeEnter: requirePrincipal, meta: { title: '批量仿真', guard: 'principal', layout: 'workspace' } },
      { name: 'reports', path: '/reports', beforeEnter: requirePrincipal, meta: { title: '报告分析', guard: 'principal', layout: 'workspace' } },
      { name: 'replays', path: '/replays', beforeEnter: requirePrincipal, meta: { title: '历史回放', guard: 'principal', layout: 'workspace' } },
      { name: 'admin', path: '/admin', beforeEnter: requireAdmin, meta: { title: '用户与角色', guard: 'admin', layout: 'workspace' } },
      { name: 'blueprint', path: '/blueprint', beforeEnter: requirePrincipal, meta: { title: '能力蓝图', guard: 'principal', layout: 'workspace' } },
      { name: 'admin-data-exchange', path: '/admin/data-exchange', beforeEnter: requirePrincipal, meta: { title: '数据交换与接口', guard: 'principal', layout: 'workspace' } },
      { name: 'traceability', path: '/traceability', beforeEnter: requirePrincipal, meta: { title: '需求追踪', guard: 'principal', layout: 'workspace' } },
      { name: 'interactions', path: '/interactions', beforeEnter: requirePrincipal, meta: { title: '感知、干扰与选路', guard: 'principal', layout: 'workspace' } },
    ])
    expect(routeRecords[0]?.component).toBe(LoginPage)

    const lazyComponents = routeRecords.slice(1).map((record) => record.component)
    const pageComponents = [SituationPage, ScenariosPage, BatchesPage, ReportsPage, ReplaysPage, AdminPage, BlueprintPage, AdminDataExchangePage, TraceabilityPage, InteractionsPage]
    expect(lazyComponents.every((component) => typeof component === 'function')).toBe(true)
    await Promise.all(lazyComponents.map(async (component, index) => {
      expect((await (component as () => Promise<{ default: unknown }>)()).default).toBe(pageComponents[index])
    }))
  })

  it('redirects unknown and protected routes to login without a principal', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter(createMemoryHistory(), pinia)

    await router.push('/reports')
    expect(router.currentRoute.value.path).toBe('/login')

    await router.push('/not-a-route')
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('redirects anonymous admin access to login through the injected-pinia global guard', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter(createMemoryHistory(), pinia)

    await router.push('/admin')
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('enforces guards through per-route hooks when no explicit pinia is injected', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    const router = createAppRouter(createMemoryHistory())

    await router.push('/reports')
    expect(router.currentRoute.value.path).toBe('/login')

    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    await router.push('/admin')
    expect(router.currentRoute.value.path).toBe('/blueprint')
    expect(auth.lastDenial?.reason).toBe('PERMISSION_DENIED')

    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions], lastDenial: null })
    await router.push('/admin')
    expect(router.currentRoute.value.path).toBe('/admin')
  })

  it('denies OPERATOR admin access visibly, allows shared data exchange, and allows ADMIN', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    const router = createAppRouter(createMemoryHistory(), pinia)

    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    await router.push('/admin')

    expect(router.currentRoute.value.path).toBe('/blueprint')
    expect(auth.lastDenial).toEqual({
      allowed: false,
      permission: 'USER_ROLE_MAINTAIN',
      reason: 'PERMISSION_DENIED',
    })

    const wrapper = mount(App, {
      global: { plugins: [pinia, router, ElementPlus] },
    })
    expect(wrapper.get('[data-testid="route-denial"]').text()).toContain('PERMISSION_DENIED')

    await router.push('/admin/data-exchange')
    expect(router.currentRoute.value.path).toBe('/admin/data-exchange')

    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions], lastDenial: null })
    await router.push('/admin')
    expect(router.currentRoute.value.path).toBe('/admin')
  })

  it('authenticates credentials with the frozen wire body and a safe session projection', async () => {
    const auth = useAuthStore()
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem')
    const cookieSpy = vi.spyOn(Document.prototype, 'cookie', 'set')
    const result: AuthResult = { authenticated: true, principal: ADMIN, sessionCreated: false }
    const fetchSpy = vi.fn().mockResolvedValue(response(success(result)))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(auth.login({ username: 'admin', password: DEFAULT_LOGIN_PASSWORD })).resolves.toEqual(result)

    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:4173/api/v1/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'admin', passwordFixture: DEFAULT_LOGIN_PASSWORD }),
    }))
    expect(auth.authState).toBe('SUCCESS')
    expect(auth.principal).toEqual(ADMIN)
    expect(auth.lastCode).toBe('SUCCESS')
    expect(storageSpy).toHaveBeenCalledTimes(1)
    expect(storageSpy).toHaveBeenCalledWith('wrj.auth.principal', JSON.stringify(ADMIN))
    const persisted = sessionStorage.getItem('wrj.auth.principal') ?? ''
    expect(JSON.parse(persisted)).toEqual(ADMIN)
    expect(persisted).not.toContain(DEFAULT_LOGIN_PASSWORD)
    expect(persisted).not.toContain('password')
    expect(persisted).not.toContain('passwordFixture')
    expect(persisted).not.toContain('token')
    expect(cookieSpy).not.toHaveBeenCalled()
    sessionStorage.clear()
  })

  it('exposes the ordered LOADING, VALIDATING, EXECUTING login phases', async () => {
    const auth = useAuthStore()
    const observed: string[] = []
    auth.$subscribe((_mutation, state) => observed.push(state.authState), { flush: 'sync' })
    const result: AuthResult = { authenticated: true, principal: ADMIN, sessionCreated: false }
    const fetchSpy = vi.fn().mockImplementation(() => {
      expect(auth.authState).toBe('EXECUTING')
      return Promise.resolve(response(success(result)))
    })
    vi.stubGlobal('fetch', fetchSpy)

    await auth.login({ username: 'admin', password: DEFAULT_LOGIN_PASSWORD })
    const stateChanges = observed.filter((state, index) => state !== observed[index - 1])
    expect(stateChanges).toEqual(['LOADING', 'VALIDATING', 'EXECUTING', 'SUCCESS'])
  })

  it.each([
    ['INVALID_CREDENTIALS', 401, '密码不正确'],
    ['ACCOUNT_LOCKED', 423, '用户已锁定'],
  ] as const)('surfaces %s as a typed login failure', async (code, _status, message) => {
    const auth = useAuthStore()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(failure(code, message), false)))

    const result = await auth.login({
      username: code === 'ACCOUNT_LOCKED' ? 'locked' : 'operator',
      password: DEFAULT_LOGIN_PASSWORD,
    })

    expect(result).toEqual({ authenticated: false, reason: code, sessionCreated: false })
    expect(auth.principal).toBeNull()
    expect(auth.authState).toBe('ERROR')
    expect(auth.lastCode).toBe(code)
    expect(auth.lastMessage).toBe(message)
  })

  it('fails closed on transport errors and rejects non-loopback configuration', async () => {
    const auth = useAuthStore()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    await expect(auth.login({ username: 'operator', password: DEFAULT_LOGIN_PASSWORD }))
      .resolves.toEqual({ authenticated: false, sessionCreated: false })
    expect(auth.authState).toBe('ERROR')
    expect(auth.lastCode).toBe('NETWORK_ERROR')
    expect(() => resolveMockOrigin('https://example.com')).toThrow(/loopback/)
  })

  it('clears the principal to safe empty when permission refresh fails', async () => {
    const auth = useAuthStore()
    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Permissions offline')))

    await expect(auth.refreshPermissions()).resolves.toBe(false)
    expect(auth.principal).toBeNull()
    expect(auth.permissions).toEqual([])
    expect(auth.authState).toBe('ERROR')
    expect(auth.lastCode).toBe('NETWORK_ERROR')
  })

  it.each([
    [{ username: '', password: DEFAULT_LOGIN_PASSWORD }, 'empty username'],
    [{ username: 'unknown', password: DEFAULT_LOGIN_PASSWORD }, 'unsupported username'],
    [{ username: 'operator', password: '  ' }, 'empty password'],
  ])('rejects $1 without a request and resets prior state', async (credentials) => {
    const auth = useAuthStore()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    auth.$patch({ principal: ADMIN, permissions: [...ADMIN.permissions], lastDenial: {
      allowed: false,
      permission: 'BUSINESS_READ',
      reason: 'PERMISSION_DENIED',
    } })

    await expect(auth.login(credentials)).resolves.toEqual({
      authenticated: false,
      reason: 'INVALID_CREDENTIALS',
      sessionCreated: false,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(auth.role).toBe('OPERATOR')
    expect(auth.lastDenial).toBeNull()

    auth.resetToSafeEmpty()
    expect(auth.$state).toMatchObject({
      principal: null,
      role: 'OPERATOR',
      permissions: [],
      authState: 'EMPTY',
      lastResult: null,
      lastCode: null,
    })
  })

  it('fails closed for malformed login and permission envelopes', async () => {
    const auth = useAuthStore()
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, data: { authenticated: true, sessionCreated: true }, meta: META }))
      .mockResolvedValueOnce(response(apiFailure('PERMISSION_DENIED', '权限头无效'), false))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(auth.login({ username: 'admin', password: DEFAULT_LOGIN_PASSWORD }))
      .resolves.toEqual({ authenticated: false, sessionCreated: false })
    expect(auth.lastCode).toBe('INVALID_RESPONSE')

    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    await expect(auth.refreshPermissions()).resolves.toBe(false)
    expect(auth.principal).toBeNull()
    expect(auth.lastCode).toBe('INVALID_RESPONSE')
    expect(auth.lastMessage).toBe('权限头无效')
  })

  it('authenticates ADMIN independently before refreshing ADMIN permissions', async () => {
    const auth = useAuthStore()
    const loginResult: AuthResult = { authenticated: true, principal: ADMIN, sessionCreated: false }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(success(loginResult)))
      .mockResolvedValueOnce(response(permissionSuccess('ADMIN', [
        'BUSINESS_READ',
        'USER_ROLE_MAINTAIN',
      ])))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(auth.login({ username: 'admin', password: DEFAULT_LOGIN_PASSWORD })).resolves.toEqual(loginResult)
    await expect(auth.refreshPermissions()).resolves.toBe(true)
    expect(fetchSpy).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:4173/api/v1/auth/permissions', {
      method: 'GET',
      headers: { 'X-Demo-Role': 'ADMIN' },
    })
    expect(auth.principal).toMatchObject({ userId: 'USR-ADMIN', username: 'admin', role: 'ADMIN' })
    expect(auth.authState).toBe('SUCCESS')

    expect(auth.authorize('USER_ROLE_MAINTAIN')).toEqual({
      allowed: true,
      permission: 'USER_ROLE_MAINTAIN',
    })
    expect(auth.lastDenial).toBeNull()
  })

  it('rejects role-mismatched permissions and OPERATOR admin-only authorization', async () => {
    const auth = useAuthStore()
    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(permissionSuccess('ADMIN', ['BUSINESS_READ']))))

    expect(auth.authorize('USER_ROLE_MAINTAIN')).toMatchObject({
      allowed: false,
      reason: 'PERMISSION_DENIED',
    })
    await expect(auth.refreshPermissions()).resolves.toBe(false)
    expect(auth.principal).toBeNull()
    expect(auth.lastCode).toBe('INVALID_RESPONSE')
  })

  it('covers loopback variants and direct route guards', () => {
    expect(resolveMockOrigin('http://localhost:4173/path')).toBe('http://localhost:4173')
    expect(resolveMockOrigin('https://[::1]:4173')).toBe('https://[::1]:4173')
    expect(() => resolveMockOrigin('not a url')).toThrow(/valid loopback URL/)
    expect(() => resolveMockOrigin('ftp://127.0.0.1')).toThrow(/HTTP\(S\) loopback/)
    expect(() => resolveMockOrigin('http://user:password@127.0.0.1')).toThrow(/HTTP\(S\) loopback/)

    const auth = useAuthStore()
    expect((requirePrincipal as unknown as () => unknown)()).toEqual({ path: '/login' })
    expect((requireAdmin as unknown as () => unknown)()).toEqual({ path: '/login' })

    auth.$patch({ principal: OPERATOR, role: 'OPERATOR', permissions: [...OPERATOR.permissions] })
    expect((requirePrincipal as unknown as () => unknown)()).toBe(true)
    expect((requireAdmin as unknown as () => unknown)()).toEqual({ path: '/blueprint' })
    expect(auth.lastDenial?.reason).toBe('PERMISSION_DENIED')

    auth.$patch({ principal: ADMIN, role: 'ADMIN', permissions: [...ADMIN.permissions] })
    expect((requireAdmin as unknown as () => unknown)()).toBe(true)
  })

  it('submits LoginPage and enters the protected workspace after success', async () => {
    const result: AuthResult = {
      authenticated: true,
      principal: {
        userId: 'USR-OPERATOR',
        username: 'operator',
        role: 'OPERATOR',
        permissions: ['BUSINESS_READ'],
      },
      sessionCreated: false,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(success(result))))
    const { auth, router, wrapper } = await mountAt(LoginPage, '/login')

    await wrapper.get('input[data-testid="login-username"]').setValue('operator')
    await wrapper.get('input[data-testid="login-password"]').setValue(DEFAULT_LOGIN_PASSWORD)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(auth.authState).toBe('SUCCESS')
    expect(router.currentRoute.value.path).toBe('/situation')
  })

  it('shows stable code plus fixed Chinese LoginPage validation feedback and stays on login', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { router, wrapper } = await mountAt(LoginPage, '/login')

    await wrapper.get('input[data-testid="login-username"]').setValue('operator')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(fetchSpy).not.toHaveBeenCalled()
    const feedback = wrapper.get('[data-testid="auth-feedback"]')
    expect(feedback.get('.el-alert__title').text()).toBe('登录失败')
    expect(feedback.get('.el-alert__description').text()).toBe('用户名或密码错误，请重新输入。')
    expect(feedback.text()).not.toContain('INVALID_CREDENTIALS')
    expect(router.currentRoute.value.path).toBe('/login')
    expect(wrapper.text()).not.toMatch(/夹具|演示|P0|P1|Mock|页面外壳|shell/i)
  })

  it.each([
    ['INVALID_CREDENTIALS', '内部凭据校验细节', '用户名或密码错误，请重新输入。'],
    ['ACCOUNT_LOCKED', '内部账号锁定细节', '账号已锁定，请联系管理员。'],
  ] as const)('shows stable %s code with safe Chinese feedback and no server details', async (code, message, description) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(failure(code, message), false)))
    const { router, wrapper } = await mountAt(LoginPage, '/login')

    await wrapper.get('input[data-testid="login-username"]').setValue('operator')
    await wrapper.get('input[data-testid="login-password"]').setValue(DEFAULT_LOGIN_PASSWORD)
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const feedback = wrapper.get('[data-testid="auth-feedback"]')
    expect(feedback.get('.el-alert__title').text()).toBe('登录失败')
    expect(feedback.get('.el-alert__description').text()).toBe(description)
    expect(feedback.text()).not.toContain(code)
    expect(feedback.text()).not.toContain(message)
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('需求追踪沿用共享退出入口，不再展示建设占位', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({
      principal: {
        userId: 'USR-OPERATOR',
        username: 'operator',
        role: 'OPERATOR',
        permissions: ['BUSINESS_READ'],
      },
      role: 'OPERATOR',
      permissions: ['BUSINESS_READ'],
    })
    const router = createAppRouter(createMemoryHistory(), pinia)
    await router.push('/blueprint')

    const wrapper = mount(TraceabilityPage, { global: { plugins: [pinia, router, ElementPlus] } })
    expect(wrapper.text()).toContain('需求追踪')
    expect(wrapper.text()).not.toContain('功能建设中')
    expect(wrapper.find('[data-testid="logout"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders AdminPage with formal Chinese labels and no validation-stage terminology', async () => {
    const { wrapper } = await mountAt(AdminPage, '/admin')
    await flushPromises()

    expect(wrapper.get('[aria-label="账号管理"]').attributes('aria-label')).toBe('账号管理')
    expect(wrapper.get('[data-testid="create-user"]').text()).toBe('创建用户')
    expect(wrapper.get('[data-testid="user-role-panel"]').text()).toContain('管理员（ADMIN）')
    expect(wrapper.get('[data-testid="user-role-panel"]').text()).toContain('启用（ACTIVE）')
    expect(wrapper.text()).not.toMatch(/夹具|演示|demo|P0|P1|Mock|页面外壳|shell|本机 Mock|UserRolePanel/i)
  })

  it('refreshes and enables users through the AdminPage adapter', async () => {
    const disabled: User = {
      userId: 'USR-OPERATOR',
      username: 'operator',
      role: 'OPERATOR',
      status: 'DISABLED',
    }
    const enabled: User = { ...disabled, status: 'ACTIVE' }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(success([disabled])))
      .mockResolvedValueOnce(response(success(enabled)))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountAt(AdminPage, '/admin')

    const refreshButton = wrapper.findAll('button').find((button) => button.text().includes('刷新用户'))
    expect(refreshButton).toBeDefined()
    await refreshButton!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('DISABLED')

    const enableButton = wrapper.findAll('button').find((button) => button.text().includes('启用'))
    expect(enableButton).toBeDefined()
    await enableButton!.trigger('click')
    await flushPromises()
    const [mutationUrl, mutationInit] = fetchSpy.mock.calls.at(-1) as [string, RequestInit]
    const mutation = JSON.parse(String(mutationInit.body)) as { operation: string; user: User }
    expect(mutationUrl).toBe(`http://127.0.0.1:4173/api/v1/admin/users/${mutation.user.userId}`)
    expect(mutationInit.method).toBe('PUT')
    expect(mutation.operation).toBe('ENABLE')
    expect(wrapper.text()).toContain('ACTIVE')
    expect(wrapper.text()).toContain('结果代码：SUCCESS')
  })

  it('creates with POST, exposes role permissions, and deletes with DELETE through AdminPage', async () => {
    const created: User = {
      userId: 'USR-reviewer',
      username: 'reviewer',
      role: 'OPERATOR',
      status: 'ACTIVE',
    }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(success(created)))
      .mockImplementationOnce((url: string) => {
        const objectId = decodeURIComponent(url.split('/').at(-1) ?? '')
        return Promise.resolve(response(success({ deleted: true, objectId })))
      })
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountAt(AdminPage, '/admin')

    await flushPromises()
    expect(wrapper.get('[data-testid="role-permission-map"]').text()).toContain('BUSINESS_READ')
    await wrapper.get('input[data-testid="create-username"]').setValue('reviewer')
    await wrapper.get('form.create-form').trigger('submit')
    await flushPromises()

    expect(fetchSpy).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:4173/api/v1/admin/users', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ operation: 'CREATE', user: created }),
    }))
    expect(wrapper.text()).toContain('reviewer')

    const operatorRow = wrapper.findAll('.el-table__body tbody tr').find((row) => row.text().includes('operator'))
    const deleteButton = operatorRow?.findAll('button').find((button) => button.text().trim() === '删除')
    expect(deleteButton).toBeDefined()
    await deleteButton!.trigger('click')
    await flushPromises()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="delete-confirmation"]').attributes('role')).toBe('alertdialog')
    expect(wrapper.get('[data-testid="delete-confirmation"]').text()).toContain('USR-OPERATOR')
    await wrapper.get('[data-testid="confirm-delete"]').trigger('click')
    await flushPromises()

    const [deleteUrl, deleteInit] = fetchSpy.mock.calls.at(-1) as [string, RequestInit]
    expect(deleteUrl).toBe('http://127.0.0.1:4173/api/v1/admin/users/USR-OPERATOR')
    expect(deleteInit.method).toBe('DELETE')
    expect(deleteInit.body).toBeUndefined()
    expect(wrapper.get('[data-testid="user-role-panel"]').text()).not.toContain('operator')
  })

  it('localizes empty create input and preserves users for an invalid DELETE result', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(response(success({
      deleted: true,
      objectId: 'USR-WRONG',
    })))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountAt(AdminPage, '/admin')

    await wrapper.get('form.create-form').trigger('submit')
    await flushPromises()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('VALIDATION_FAILED')
    expect(wrapper.text()).toContain('用户名')

    const operatorRow = wrapper.findAll('.el-table__body tbody tr').find((row) => row.text().includes('operator'))
    const deleteButton = operatorRow?.findAll('button').find((button) => button.text().trim() === '删除')
    await deleteButton!.trigger('click')
    await flushPromises()

    expect(fetchSpy).not.toHaveBeenCalled()
    const confirmationText = wrapper.get('[data-testid="delete-confirmation"]').text()
    expect(confirmationText).toContain('确认删除用户')
    expect(confirmationText).not.toMatch(/夹具|演示|demo|P0|P1|Mock|页面外壳|shell|本机 Mock|UserRolePanel/i)
    await wrapper.get('[data-testid="cancel-delete"]').trigger('click')
    expect(wrapper.find('[data-testid="delete-confirmation"]').exists()).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()

    await deleteButton!.trigger('click')
    await wrapper.get('[data-testid="confirm-delete"]').trigger('click')
    await flushPromises()

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4173/api/v1/admin/users/USR-OPERATOR',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(wrapper.text()).toContain('INVALID_RESPONSE')
    expect(wrapper.get('[data-testid="user-role-panel"]').text()).toContain('operator')
  })

  it('shows AdminPage refresh and last-admin mutation failures', async () => {
    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new Error('Users offline'))
      .mockResolvedValueOnce(response(apiFailure('LAST_ADMIN_GUARD', '不能变更最后一个管理员'), false))
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountAt(AdminPage, '/admin')

    const refreshButton = wrapper.findAll('button').find((button) => button.text().includes('刷新用户'))
    await refreshButton!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('NETWORK_ERROR')
    expect(wrapper.text()).toContain('Users offline')

    const roleButton = wrapper.findAll('button').find((button) => button.text().includes('切换角色'))
    await roleButton!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('LAST_ADMIN_GUARD')
    expect(wrapper.text()).toContain('不能变更最后一个管理员')
  })

  it.each([
    ['invalid role', { userId: 'USR-BROKEN', username: 'broken', role: 'ROOT', status: 'ACTIVE' }],
    ['empty userId', { userId: '', username: 'broken', role: 'OPERATOR', status: 'ACTIVE' }],
    ['malformed lastLoginAt', {
      userId: 'USR-BROKEN',
      username: 'broken',
      role: 'OPERATOR',
      status: 'ACTIVE',
      lastLoginAt: '2026-02-30T25:61:61Z',
    }],
    ['additional property', {
      userId: 'USR-BROKEN',
      username: 'broken',
      role: 'OPERATOR',
      status: 'ACTIVE',
      secret: 'must-not-cross-the-contract',
    }],
  ])('keeps the prior AdminPage projection for %s', async (_caseName, invalidUser) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(success([invalidUser]))))
    const { wrapper } = await mountAt(AdminPage, '/admin')

    const refreshButton = wrapper.findAll('button').find((button) => button.text().includes('刷新用户'))
    await refreshButton!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('INVALID_RESPONSE')
    expect(wrapper.text()).toContain('admin')
    expect(wrapper.text()).not.toContain('broken')
  })

  it('shows AdminPage LOADING then VALIDATING while a refresh response is pending', async () => {
    const fetchResult = deferred<Response>()
    const jsonResult = deferred<ReturnType<typeof success<User[]>>>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(fetchResult.promise))
    const { wrapper } = await mountAt(AdminPage, '/admin')
    const refreshButton = wrapper.findAll('button').find((button) => button.text().includes('刷新用户'))

    void refreshButton!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('LOADING')

    fetchResult.resolve({ ok: true, json: () => jsonResult.promise } as Response)
    await flushPromises()
    expect(wrapper.text()).toContain('VALIDATING')

    jsonResult.resolve(success([{
      userId: 'USR-OPERATOR',
      username: 'operator',
      role: 'OPERATOR',
      status: 'ACTIVE',
    }]))
    await flushPromises()
    expect(wrapper.text()).toContain('SUCCESS')
  })

  it('keeps fixed calculation evidence on the authoritative interactions route', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { wrapper } = await mountAt(InteractionsPage, '/interactions')

    expect(wrapper.text()).toContain('感知、干扰与选路')
    expect(wrapper.text()).toContain('ESM 传感器与侦测结果')
    expect(wrapper.text()).toContain('干扰控制')
    expect(wrapper.text()).toContain('干扰最小通道')
    expect(wrapper.text()).toContain('误码最低稳定链路')
    expect(wrapper.text()).toContain('链路切换记录')
    expect(wrapper.get('[data-testid="composite-loss-example"]')).toBeTruthy()
    expect(wrapper.get('[data-testid="snr-ber-example"]')).toBeTruthy()
    expect(wrapper.text()).not.toMatch(/P0|P1|Mock|夹具|demo|gallery|passwordFixture|T-JK/i)
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:4173/api/v1/scenarios/SCN-001',
      'http://127.0.0.1:4173/api/v1/simulations/RUN-001/frames/F-00042',
      'http://127.0.0.1:4173/api/v1/simulations/RUN-001/events',
    ])
  })
})

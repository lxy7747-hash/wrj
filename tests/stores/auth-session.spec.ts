import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '../../src/stores/auth'
import { useAdminStore } from '../../src/stores/admin'
import { apiFetch, onSessionExpired } from '../../src/features/shared/api-fetch'

const principal = { userId: 'USR-NEW', username: 'new-admin', role: 'ADMIN', permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'] }
const success = (data: unknown) => new Response(JSON.stringify({ ok: true, data, meta: { requestId: 'REQ-1', generatedAt: '2026-09-11T00:00:00Z', page: 1, pageSize: 1, total: 1 } }), { headers: { 'X-Auth-Mode': 'sqlite' } })
const session = () => success({ authenticated: true, sessionCreated: true, principal })
beforeEach(() => { sessionStorage.clear(); setActivePinia(createPinia()) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); onSessionExpired(() => {}); sessionStorage.clear() })

it('server-verified menu restrictions survive session projection and block direct navigation', async () => {
  const limited = { ...principal, menuPaths: ['/reports', '/admin'] }
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => success({ authenticated: true, sessionCreated: true, principal: limited })))
  const auth = useAuthStore()
  await auth.restoreSession()
  expect(auth.principal?.menuPaths).toEqual(limited.menuPaths)
  expect(JSON.parse(sessionStorage.getItem('wrj.auth.principal')!).menuPaths).toEqual(limited.menuPaths)
  const { createAppRouter } = await import('../../src/router')
  const { createMemoryHistory } = await import('vue-router')
  const router = createAppRouter(createMemoryHistory())
  await router.push('/scenarios')
  expect(router.currentRoute.value.path).toBe('/reports')
  expect(auth.lastCode).toBe('PERMISSION_DENIED')
  await router.push('/admin?section=equipment-library')
  expect(router.currentRoute.value.path).toBe('/reports')
  await router.push('/admin')
  expect(router.currentRoute.value.path).toBe('/admin')
})

it.each(['request', 'body'] as const)('bounds startup while %s hangs and ignores its late success', async phase => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  sessionStorage.setItem('wrj.auth.principal', JSON.stringify(principal))
  let finish!: () => void
  const body = { authenticated: true, sessionCreated: true, principal }
  const fetchSpy = vi.fn().mockImplementation(() => phase === 'request'
    ? new Promise<Response>(resolve => { finish = () => resolve(session()) })
    : Promise.resolve({ ok: true, headers: new Headers({ 'X-Auth-Mode': 'sqlite' }),
      json: () => new Promise(resolve => { finish = () => resolve({ ok: true, data: body }) }),
    } as Response))
  vi.stubGlobal('fetch', fetchSpy)
  const auth = useAuthStore()
  const mount = vi.fn()
  const startup = auth.restoreSession().finally(mount)
  await vi.advanceTimersByTimeAsync(4999)
  expect(mount).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(mount).toHaveBeenCalledOnce()
  await startup
  expect(auth.principal).toBeNull()
  expect(auth.permissions).toEqual([])
  expect(auth.runtimeMode).toBe('UNKNOWN')
  expect(sessionStorage.getItem('wrj.auth.principal')).toBeNull()
  expect(fetchSpy.mock.calls[0]![1].signal.aborted).toBe(true)
  finish()
  await vi.advanceTimersByTimeAsync(1)
  expect(auth.principal).toBeNull()
  expect(sessionStorage.getItem('wrj.auth.principal')).toBeNull()
  expect(auth.runtimeMode).toBe('UNKNOWN')
  expect(vi.getTimerCount()).toBe(0)
})

it('首次恢复失败后本机登录重新识别模式，不保留 Mock 假设', async () => {
  const fetchSpy = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(async () => session())
  vi.stubGlobal('fetch', fetchSpy)
  const auth = useAuthStore()
  expect(auth.runtimeMode).toBe('UNKNOWN')
  await auth.restoreSession()
  expect(auth.runtimeMode).toBe('UNKNOWN')
  expect((await auth.login({ username: 'new-admin', password: 'test-password-123!' })).authenticated).toBe(true)
  expect(auth.runtimeMode).toBe('LOCAL')
})

it.each([null, 'unrecognized', 'mock', 'sqlite'])('恢复及登录只接受明确模式头 %s', async mode => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    const response = session()
    if (mode === null) response.headers.delete('X-Auth-Mode')
    else response.headers.set('X-Auth-Mode', mode)
    return response
  }))
  const auth = useAuthStore()
  const expected = mode === 'mock' ? 'MOCK' : mode === 'sqlite' ? 'LOCAL' : 'UNKNOWN'
  await auth.restoreSession()
  expect(auth.runtimeMode).toBe(expected)
  await auth.login({ username: 'new-admin', password: 'test-password-123!' })
  expect(auth.runtimeMode).toBe(expected)
  auth.resetToSafeEmpty()
  expect(auth.runtimeMode).toBe('UNKNOWN')
})

it('accepts a SQLite administrator without a fixed username and restores only a server-verified session', async () => {
  const fetchSpy = vi.fn().mockImplementation(async () => session())
  vi.stubGlobal('fetch', fetchSpy)
  const auth = useAuthStore()
  expect((await auth.login({ username: 'new-admin', password: 'test-password-123!' })).authenticated).toBe(true)
  expect(auth.principal).toEqual(principal)
  expect(JSON.stringify(sessionStorage)).not.toContain('test-password')
  setActivePinia(createPinia())
  const restored = useAuthStore()
  await restored.restoreSession()
  expect(restored.principal).toEqual(principal)
  expect(restored.runtimeMode).toBe('LOCAL')
  expect(fetchSpy).toHaveBeenLastCalledWith('http://127.0.0.1:4173/api/v1/auth/session', { credentials: 'include', signal: expect.any(AbortSignal) })
  fetchSpy.mockResolvedValueOnce(success({ authenticated: false, sessionCreated: false }))
  await restored.restoreSession()
  expect(restored.principal).toBeNull()
})

it('rejects whitespace on account creation but preserves valid password spaces and existing long passwords on login', async () => {
  const fetchSpy = vi.fn().mockImplementation(async () => session())
  vi.stubGlobal('fetch', fetchSpy)
  const admin = useAdminStore()
  const before = JSON.stringify(admin.users)
  expect(await admin.createUser('blank', 'OPERATOR', 'ACTIVE', '      ')).toBe(false)
  expect(admin.resultMessage).toContain('不能全为空白')
  expect(JSON.stringify(admin.users)).toBe(before)
  expect(fetchSpy).not.toHaveBeenCalled()
  const auth = useAuthStore()
  for (const password of ['  secret  ', ` ${'p'.repeat(126)} `]) {
    expect((await auth.login({ username: 'new-admin', password })).authenticated).toBe(true)
    expect(JSON.parse(fetchSpy.mock.calls.at(-1)![1].body).passwordFixture).toBe(password)
  }
})

it('invalidates pending login/session responses on reset', async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done })))
  const auth = useAuthStore()
  const login = auth.login({ username: 'new-admin', password: 'test-password-123!' })
  await vi.waitFor(() => expect(resolve).toBeDefined())
  auth.resetToSafeEmpty()
  resolve(session())
  await login
  expect(auth.principal).toBeNull()
  const restore = auth.restoreSession()
  auth.resetToSafeEmpty()
  resolve(session())
  await restore
  expect(auth.principal).toBeNull()
})

it('logs out with credentials and rejects network failure without restoring local identity', async () => {
  const fetchSpy = vi.fn().mockImplementationOnce(async () => session()).mockRejectedValueOnce(new Error('offline'))
  vi.stubGlobal('fetch', fetchSpy)
  const auth = useAuthStore()
  await auth.restoreSession()
  await expect(auth.logout()).rejects.toThrow('offline')
  expect(auth.principal).toBeNull()
  expect(fetchSpy).toHaveBeenLastCalledWith('http://127.0.0.1:4173/api/v1/auth/logout', expect.objectContaining({ credentials: 'include', method: 'POST' }))
})

it('handles current-session 401 but ignores stale-session and public login failures', async () => {
  const expired = vi.fn()
  onSessionExpired(expired)
  let resolve!: (response: Response) => void
  const fetchSpy = vi.fn(() => new Promise<Response>(done => { resolve = done }))
  vi.stubGlobal('fetch', fetchSpy)
  const old = apiFetch('/api/v1/scenarios')
  useAuthStore().resetToSafeEmpty()
  resolve(new Response('', { status: 401 }))
  await old
  expect(expired).not.toHaveBeenCalled()
  fetchSpy.mockImplementation(async () => new Response('', { status: 401 }))
  await apiFetch('/api/v1/auth/login')
  await apiFetch('/api/v1/auth/session')
  expect(expired).not.toHaveBeenCalled()
  await apiFetch('/api/v1/scenarios')
  expect(expired).toHaveBeenCalledOnce()
})

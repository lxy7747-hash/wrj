import { expect, test, type Page } from '@playwright/test'

const DEFAULT_LOGIN_PASSWORD = '123456'
const AUTH_SESSION_KEY = 'wrj.auth.principal'

interface ConsoleAudit {
  errors: string[]
  http404s: string[]
  nonLoopbackHosts: Set<string>
}

function auditConsole(page: Page): ConsoleAudit {
  const audit: ConsoleAudit = { errors: [], http404s: [], nonLoopbackHosts: new Set() }

  page.on('console', (message) => {
    if (message.type() === 'error') {
      audit.errors.push(message.text())
    }
  })
  page.on('pageerror', (error) => {
    audit.errors.push(String(error))
  })
  page.on('response', (response) => {
    if (response.status() === 404) {
      audit.http404s.push(response.url())
    }
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.protocol !== 'data:' && url.hostname !== '127.0.0.1') {
      audit.nonLoopbackHosts.add(url.hostname)
    }
  })

  return audit
}

/**
 * 通过可见表单登录有效固定用户并校验传输请求。
 *
 * @param page - 用于导航、表单输入、请求捕获和存储检查的 Playwright 页面。
 * @param username - 要认证的有效 ADMIN 或 OPERATOR 固定用户名。
 * @returns 导航到态势工作区并完成安全存储校验后无返回值。
 * @remarks 会执行浏览器导航和一次登录网络请求，断言仅 sessionStorage 保存必要身份投影。
 */
async function loginAs(page: Page, username: 'admin' | 'operator'): Promise<void> {
  await page.goto('/login')
  await page.getByTestId('login-username').fill(username)
  await page.getByTestId('login-password').fill(DEFAULT_LOGIN_PASSWORD)
  const loginRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/v1/auth/login')
  await page.getByTestId('login-submit').click()
  expect((await loginRequest).postDataJSON()).toEqual({ username, passwordFixture: DEFAULT_LOGIN_PASSWORD })
  await page.waitForURL('**/situation')
  const storage = await page.evaluate((sessionKey) => ({
    localStorage: { ...localStorage },
    sessionKeys: Object.keys(sessionStorage),
    serializedPrincipal: sessionStorage.getItem(sessionKey),
  }), AUTH_SESSION_KEY)
  expect(storage.localStorage).toEqual({})
  expect(storage.sessionKeys).toEqual([AUTH_SESSION_KEY])
  expect(storage.serializedPrincipal).not.toBeNull()
  const principal = JSON.parse(storage.serializedPrincipal ?? '{}') as Record<string, unknown>
  expect(Object.keys(principal).sort()).toEqual(['permissions', 'role', 'userId', 'username'])
  expect(principal).toMatchObject({
    username,
    role: username === 'admin' ? 'ADMIN' : 'OPERATOR',
  })
  expect(principal.permissions).toEqual(expect.any(Array))
  expect(storage.serializedPrincipal).not.toContain(DEFAULT_LOGIN_PASSWORD)
  expect(storage.serializedPrincipal).not.toContain('password')
  expect(storage.serializedPrincipal).not.toContain('passwordFixture')
  expect(storage.serializedPrincipal).not.toContain('token')
  expect(await page.context().cookies()).toEqual([])
}

test('root path redirects to login without console errors or 404s', async ({ page }) => {
  const audit = auditConsole(page)

  await page.goto('/')
  await page.waitForURL('**/login')
  await expect(page.getByTestId('login-submit')).toBeVisible()

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

for (const credentials of [
  { username: 'operator', password: 'WRONG_PASSWORD', code: 'INVALID_CREDENTIALS', status: 401, feedback: '用户名或密码错误，请重新输入。' },
  { username: 'locked', password: DEFAULT_LOGIN_PASSWORD, code: 'ACCOUNT_LOCKED', status: 423, feedback: '账号已锁定，请联系管理员。' },
] as const) {
  test(`${credentials.code} remains on the formal login form`, async ({ page }) => {
    const audit = auditConsole(page)
    await page.goto('/login')
    await page.getByTestId('login-username').fill(credentials.username)
    await page.getByTestId('login-password').fill(credentials.password)
    const loginRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/v1/auth/login')

    await page.getByTestId('login-submit').click()

    expect((await loginRequest).postDataJSON()).toEqual({
      username: credentials.username,
      passwordFixture: credentials.password,
    })
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByTestId('auth-feedback')).toContainText(credentials.feedback)
    expect(audit.errors).toEqual([
      expect.stringContaining(`server responded with a status of ${credentials.status}`),
    ])
    expect(audit.http404s).toEqual([])
    expect([...audit.nonLoopbackHosts]).toEqual([])
  })
}

test('ADMIN login enters the workspace and reaches the user-role panel', async ({ page }) => {
  const audit = auditConsole(page)

  await loginAs(page, 'admin')
  await expect(page.getByRole('heading', { name: '态势主界面' })).toBeVisible()

  await page.getByRole('link', { name: '用户与角色' }).click()
  await page.waitForURL('**/admin')
  await expect(page.getByTestId('user-role-panel')).toBeVisible()
  await expect(page.getByTestId('role-permission-map')).toContainText('BUSINESS_READ')

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('session identity survives reload and logout stays anonymous after reload', async ({ page }) => {
  const audit = auditConsole(page)

  await loginAs(page, 'operator')
  await page.reload()
  await page.waitForURL('**/situation')
  await expect(page.getByRole('heading', { name: '态势主界面' })).toBeVisible()
  await expect(page.getByTestId('identity-username')).toContainText('operator')

  await page.getByTestId('logout').click()
  await page.waitForURL('**/login')
  await page.reload()
  await page.waitForURL('**/login')
  await expect(page.getByTestId('login-submit')).toBeVisible()
  expect(await page.evaluate(() => ({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
  }))).toEqual({ localStorage: {}, sessionStorage: {} })
  expect(await page.context().cookies()).toEqual([])

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('OPERATOR is denied admin access with visible PERMISSION_DENIED evidence', async ({ page }) => {
  const audit = auditConsole(page)

  await loginAs(page, 'operator')
  await expect(page.getByRole('link', { name: '用户与角色', exact: true })).toHaveCount(0)
  await page.evaluate(() => {
    window.history.pushState({}, '', '/admin')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await page.waitForURL('**/blueprint')

  await expect(page.getByTestId('route-denial')).toContainText('PERMISSION_DENIED')

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

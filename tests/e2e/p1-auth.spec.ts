import { expect, test, type Page } from '@playwright/test'

const DEFAULT_LOGIN_PASSWORD = '123456'
const AUTH_SESSION_KEY = 'wrj.auth.principal'

interface ConsoleAudit {
  errors: string[]
  http404s: string[]
  nonLoopbackHosts: Set<string>
}

interface WorkspaceRoute {
  path: string
  navLabel: string
  title: string
}

const SHARED_WORKSPACE_ROUTES: readonly WorkspaceRoute[] = [
  { path: '/situation', navLabel: '态势主界面', title: '态势主界面' },
  { path: '/scenarios', navLabel: '场景配置', title: '场景管理' },
  { path: '/batches', navLabel: '仿真批次', title: '批量仿真' },
  { path: '/reports', navLabel: '报表中心', title: '报告分析' },
  { path: '/replays', navLabel: '回放复盘', title: '历史回放' },
  { path: '/blueprint', navLabel: '资源模板库', title: '能力蓝图' },
  { path: '/admin/data-exchange', navLabel: '数据交换与接口', title: '数据交换与接口' },
  { path: '/traceability', navLabel: '可追溯性', title: '需求追踪' },
  { path: '/interactions', navLabel: '交互管理', title: '交互管理' },
]

const ADMIN_WORKSPACE_ROUTE: WorkspaceRoute = {
  path: '/admin',
  navLabel: '用户与角色',
  title: '用户与角色管理',
}

const PROTECTED_WORKSPACE_ROUTES = [
  ...SHARED_WORKSPACE_ROUTES,
  ADMIN_WORKSPACE_ROUTE,
] as const

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

async function visitWorkspaceRouteFromNavigation(page: Page, route: WorkspaceRoute): Promise<void> {
  const navigation = page.getByRole('navigation', { name: '主导航' })
  const link = navigation.getByRole('link', { name: route.navLabel, exact: true })

  await link.click()
  await page.waitForURL((url) => url.pathname === route.path)

  expect(new URL(page.url()).pathname).toBe(route.path)
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(navigation).toBeVisible()
  await expect(page.getByTestId('identity-panel')).toBeVisible()
  await expect(page.getByRole('heading', { name: route.title, exact: true })).toBeVisible()
  await expect(link).toHaveAttribute('aria-current', 'page')
}

test('anonymous access keeps login public and redirects every protected route', async ({ page }) => {
  const audit = auditConsole(page)

  await page.goto('/login')
  await expect(page.getByTestId('login-submit')).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)

  await page.goto('/')
  await page.waitForURL('**/login')
  await expect(page.getByTestId('login-submit')).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)

  for (const route of PROTECTED_WORKSPACE_ROUTES) {
    await page.goto(route.path)
    await page.waitForURL('**/login')
    await expect(page.getByTestId('login-submit')).toBeVisible()
    await expect(page.locator('.app-shell')).toHaveCount(0)
  }

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

test('ADMIN can navigate every workspace route from the main navigation', async ({ page }) => {
  const audit = auditConsole(page)

  await loginAs(page, 'admin')
  for (const route of PROTECTED_WORKSPACE_ROUTES) {
    await visitWorkspaceRouteFromNavigation(page, route)
  }

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

test('OPERATOR can navigate shared routes and is denied direct admin access', async ({ page }) => {
  const audit = auditConsole(page)

  await loginAs(page, 'operator')
  await expect(page.getByRole('link', { name: '用户与角色', exact: true })).toHaveCount(0)
  for (const route of SHARED_WORKSPACE_ROUTES) {
    await visitWorkspaceRouteFromNavigation(page, route)
  }

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

test.describe('P2-1 scenario business loop', () => {
  test.use({ timezoneId: 'America/New_York' })

  test('OPERATOR saves Beijing time as UTC and reloads it outside UTC+8', async ({ page }) => {
    const audit = auditConsole(page)
    const putBodies: Array<Record<string, unknown>> = []
    page.on('request', (request) => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/v1/scenarios/SCN-001') {
        putBodies.push(request.postDataJSON() as Record<string, unknown>)
      }
    })

    await loginAs(page, 'operator')
    const loaded = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v1/scenarios/SCN-001')
    await page.getByRole('link', { name: '场景配置', exact: true }).click()
    expect((await loaded).status()).toBe(200)
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('America/New_York')

    const name = page.getByTestId('scenario-name')
    const startTime = page.getByTestId('scenario-start-time').locator('input')
    const nameError = page.getByTestId('scenario-editor')
      .getByText('场景名称为必填项，且不能超过 128 个字符。', { exact: true })
    await expect(page.getByTestId('scenario-id')).toHaveValue('SCN-001')
    await expect(page.getByText('开始时间', { exact: true })).toBeVisible()
    await expect(name).not.toHaveValue('')

    await name.fill('')
    await page.getByTestId('save-scenario').click()
    await expect(nameError).toBeVisible()
    expect(putBodies).toEqual([])

    await name.fill('跨海通联时区验证场景')
    await startTime.fill('2026-08-07 09:30')
    await startTime.press('Enter')
    await expect(nameError).toHaveCount(0)
    await expect(page.locator('.scenario-feedback')).toHaveCount(0)

    const saved = page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === '/api/v1/scenarios/SCN-001')
    await page.getByTestId('save-scenario').click()
    expect((await saved).status()).toBe(200)
    expect(putBodies).toHaveLength(1)
    expect(putBodies[0]).toMatchObject({
      scenario: {
        name: '跨海通联时区验证场景',
        startTime: '2026-08-07T01:30:00Z',
      },
    })

    const reloaded = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v1/scenarios/SCN-001')
    await page.reload()
    expect((await reloaded).status()).toBe(200)
    await expect(name).toHaveValue('跨海通联时区验证场景')
    await expect(startTime).toHaveValue('2026-08-07 09:30')

    expect(audit.errors).toEqual([])
    expect(audit.http404s).toEqual([])
    expect([...audit.nonLoopbackHosts]).toEqual([])
  })
})

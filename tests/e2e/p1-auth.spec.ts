import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { ApiSuccess, ScenarioConfig, ScenarioDraft } from '../../src/contracts/domain-models'

const DEFAULT_LOGIN_PASSWORD = '123456'
const AUTH_SESSION_KEY = 'wrj.auth.principal'
const MOCK_ORIGIN = 'http://127.0.0.1:4173'
const UI_ORIGIN = 'http://127.0.0.1:5173'
const SCENARIO_PATH = '/api/v1/scenarios/SCN-001'

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
  { path: '/scenarios', navLabel: '场景配置', title: '场景标识' },
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

async function resetMock(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${MOCK_ORIGIN}/api/v1/reset`, {
    headers: { Origin: UI_ORIGIN, 'X-Demo-Role': 'ADMIN' },
    data: { confirm: true },
  })
  expect(response.status()).toBe(200)
}

async function loadScenarioDraft(request: APIRequestContext): Promise<ScenarioDraft> {
  const response = await request.get(`${MOCK_ORIGIN}${SCENARIO_PATH}`, {
    headers: { Origin: UI_ORIGIN, 'X-Demo-Role': 'OPERATOR' },
  })
  expect(response.status()).toBe(200)
  return ((await response.json()) as ApiSuccess<ScenarioDraft>).data
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
      config: {
        scenario: {
          name: '跨海通联时区验证场景',
          startTime: '2026-08-07T01:30:00Z',
        },
      },
      uiExtensions: { jammers: expect.any(Array), sensors: [] },
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

test.describe('P2-2 platform and waypoint acceptance', () => {
  test('OPERATOR adds and edits a platform waypoint, saves, and reloads it', async ({ page, request }) => {
    await resetMock(request)
    const audit = auditConsole(page)

    await loginAs(page, 'operator')
    const loaded = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === SCENARIO_PATH)
    await page.getByRole('link', { name: '场景配置', exact: true }).click()
    expect((await loaded).status()).toBe(200)
    await page.getByRole('tab', { name: '平台与航点' }).click()

    await page.getByTestId('add-business-platform').click()
    await page.getByTestId('platform-name').fill('E2E 新增业务节点')
    await page.getByTestId('platform-longitude').locator('input').fill('120.25')
    await page.getByTestId('platform-latitude').locator('input').fill('24.35')
    await page.getByTestId('platform-altitude').locator('input').fill('1200')
    await page.getByTestId('add-waypoint').click()
    await page.getByTestId('waypoint-longitude-0').locator('input').fill('120.5')
    await page.getByTestId('waypoint-latitude-0').locator('input').fill('24.5')
    await page.getByTestId('waypoint-altitude-0').locator('input').fill('1500')
    await page.getByTestId('waypoint-speed-0').locator('input').fill('60')
    await page.getByTestId('waypoint-arrival-0').locator('input').fill('300')
    await page.getByTestId('apply-platform').click()

    const addedRow = page.getByTestId('platform-table').getByRole('row').filter({ hasText: 'E2E 新增业务节点' })
    await expect(addedRow).toContainText('1')
    await addedRow.getByRole('button', { name: '编辑' }).click()
    await page.getByTestId('platform-name').fill('E2E 已编辑业务节点')
    await page.getByTestId('waypoint-longitude-0').locator('input').fill('120.75')
    await page.getByTestId('waypoint-latitude-0').locator('input').fill('24.75')
    await page.getByTestId('waypoint-altitude-0').locator('input').fill('1800')
    await page.getByTestId('waypoint-speed-0').locator('input').fill('75')
    await page.getByTestId('waypoint-arrival-0').locator('input').fill('450')
    await page.getByTestId('apply-platform').click()

    const savedResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === SCENARIO_PATH)
    await page.getByTestId('save-scenario').click()
    const saved = await savedResponse
    expect(saved.status()).toBe(200)
    const savedDraft = ((await saved.json()) as ApiSuccess<ScenarioDraft>).data
    expect(savedDraft.revision).toBe(5)
    expect(savedDraft.config.platforms.at(-1)).toMatchObject({
      id: 'PLAT-001',
      name: 'E2E 已编辑业务节点',
      initialPosition: { longitude: 120.25, latitude: 24.35, altitude: 1200 },
      waypoints: [{ longitude: 120.75, latitude: 24.75, altitude: 1800, speed: 75, arrivalTime: 450 }],
    })

    const reloadedResponse = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === SCENARIO_PATH)
    await page.reload()
    const reloaded = await reloadedResponse
    expect(reloaded.status()).toBe(200)
    const reloadedDraft = ((await reloaded.json()) as ApiSuccess<ScenarioDraft>).data
    expect(reloadedDraft).toEqual(savedDraft)
    await page.getByRole('tab', { name: '平台与航点' }).click()
    const reloadedRow = page.getByTestId('platform-table').getByRole('row').filter({ hasText: 'E2E 已编辑业务节点' })
    await expect(reloadedRow).toContainText('PLAT-001')
    await expect(reloadedRow).toContainText('1')
    await reloadedRow.getByRole('button', { name: '编辑' }).click()
    await expect(page.getByTestId('platform-longitude').locator('input')).toHaveValue('120.25')
    await expect(page.getByTestId('waypoint-longitude-0').locator('input')).toHaveValue('120.75')
    await expect(page.getByTestId('waypoint-arrival-0').locator('input')).toHaveValue('450')

    expect(audit.errors).toEqual([])
    expect(audit.http404s).toEqual([])
    expect([...audit.nonLoopbackHosts]).toEqual([])
  })

  test('real mock accepts exactly 50 business nodes and atomically rejects node 51', async ({ request }) => {
    await resetMock(request)
    const baseline = await loadScenarioDraft(request)
    const fiftyConfig = structuredClone(baseline.config)
    const source = structuredClone(fiftyConfig.platforms[3]!)
    for (let index = 0; index < 44; index += 1) {
      fiftyConfig.platforms.push({
        ...structuredClone(source),
        id: `E2E-LIMIT-${String(index + 1).padStart(3, '0')}`,
        name: `E2E 容量节点 ${index + 1}`,
        linkIds: [],
        sensorIds: [],
        jammerIds: [],
      })
    }

    const acceptedResponse = await request.put(`${MOCK_ORIGIN}${SCENARIO_PATH}`, {
      headers: { Origin: UI_ORIGIN, 'X-Demo-Role': 'OPERATOR' },
      data: { config: fiftyConfig, uiExtensions: baseline.uiExtensions },
    })
    expect(acceptedResponse.status()).toBe(200)
    const acceptedDraft = ((await acceptedResponse.json()) as ApiSuccess<ScenarioDraft>).data
    expect(acceptedDraft.revision).toBe(baseline.revision + 1)
    expect(acceptedDraft.config.platforms.filter((platform) => (
      !['COMMUNICATION_SATELLITE', 'GROUND_JAMMER_DETECTION_STATION'].includes(platform.type)
    ))).toHaveLength(50)
    expect(await loadScenarioDraft(request)).toEqual(acceptedDraft)

    const fiftyOneConfig: ScenarioConfig = structuredClone(acceptedDraft.config)
    fiftyOneConfig.platforms.push({
      ...structuredClone(source),
      id: 'E2E-LIMIT-045',
      name: 'E2E 第 51 个容量节点',
      linkIds: [],
      sensorIds: [],
      jammerIds: [],
    })
    const rejectedResponse = await request.put(`${MOCK_ORIGIN}${SCENARIO_PATH}`, {
      headers: { Origin: UI_ORIGIN, 'X-Demo-Role': 'OPERATOR' },
      data: { config: fiftyOneConfig, uiExtensions: acceptedDraft.uiExtensions },
    })
    expect(rejectedResponse.status()).toBe(422)
    expect(await rejectedResponse.json()).toMatchObject({
      ok: false,
      error: { code: 'NODE_LIMIT_EXCEEDED', fieldPath: 'platforms' },
    })

    const afterRejection = await loadScenarioDraft(request)
    expect(afterRejection.revision).toBe(acceptedDraft.revision)
    expect(afterRejection).toEqual(acceptedDraft)
  })
})

test('P2-3 OPERATOR edits a link across validation, associations, save, and reload', async ({ page, request }) => {
  await resetMock(request)
  const audit = auditConsole(page)

  await loginAs(page, 'operator')
  const loaded = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  expect((await loaded).status()).toBe(200)
  await page.getByRole('tab', { name: '链路配置' }).click()
  await page.getByTestId('add-link').click()
  await expect(page.getByTestId('link-dialog')).toBeVisible()

  const frequency = page.getByTestId('link-frequency').locator('input')
  const bandwidth = page.getByTestId('link-bandwidth').locator('input')
  const addedRow = page.getByTestId('link-table').getByRole('row').filter({ hasText: 'L-CFG-001' })
  await frequency.fill('0')
  await page.getByTestId('apply-link').click()
  await expect(page.getByTestId('link-dialog')).toBeVisible()
  await expect(page.getByText('链路频率必须大于 0 MHz。', { exact: true })).toBeVisible()
  await expect(addedRow).toHaveCount(0)
  await frequency.fill('4500')
  await bandwidth.fill('0')
  await page.getByTestId('apply-link').click()
  await expect(page.getByTestId('link-dialog')).toBeVisible()
  await expect(page.getByText('链路带宽必须大于 0 MHz。', { exact: true })).toBeVisible()
  await expect(addedRow).toHaveCount(0)
  await bandwidth.fill('20')
  await page.getByTestId('apply-link').click()
  await expect(page.getByTestId('link-dialog')).toHaveCount(0)
  await expect(addedRow).toHaveCount(1)
  await addedRow.getByRole('button', { name: '编辑' }).click()
  await page.getByTestId('link-target').click()
  await page.getByRole('option', { name: '空中无人作业节点 U02（AIR-02）', exact: true }).click()
  await frequency.fill('915.125')
  await bandwidth.fill('5.125')
  await page.getByTestId('link-power').locator('input').fill('42')
  await page.getByTestId('link-data-rate').locator('input').fill('64')
  await page.getByTestId('apply-link').click()
  await expect(page.getByTestId('link-dialog')).toHaveCount(0)

  await page.getByRole('tab', { name: '平台与航点' }).click()
  const platformTable = page.getByTestId('platform-table')
  const sourceRow = platformTable.getByRole('row').filter({ hasText: '后方指挥节点' })
  await sourceRow.getByRole('button', { name: '编辑' }).click()
  await expect(page.getByTestId('platform-link-ids')).toHaveValue(/L-CFG-001/)
  await page.getByTestId('cancel-platform').click()
  const previousTargetRow = platformTable.getByRole('row').filter({ hasText: '高空前出中继节点' })
  await previousTargetRow.getByRole('button', { name: '编辑' }).click()
  await expect(page.getByTestId('platform-link-ids')).not.toHaveValue(/L-CFG-001/)
  await page.getByTestId('cancel-platform').click()
  const targetRow = platformTable.getByRole('row').filter({ hasText: '空中无人作业节点 U02' })
  await targetRow.getByRole('button', { name: '编辑' }).click()
  await expect(page.getByTestId('platform-link-ids')).toHaveValue(/L-CFG-001/)
  await page.getByTestId('cancel-platform').click()

  const savedResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.getByTestId('save-scenario').click()
  const saved = await savedResponse
  expect(saved.status()).toBe(200)
  const savedDraft = ((await saved.json()) as ApiSuccess<ScenarioDraft>).data
  expect(savedDraft.config.links.at(-1)).toMatchObject({
    id: 'L-CFG-001',
    sourcePlatformId: 'CMD-01',
    targetPlatformId: 'AIR-02',
    frequency: 915.125,
    bandwidth: 5.125,
    txPower: 42,
    dataRate: 64,
  })
  expect(savedDraft.config.platforms.find((platform) => platform.id === 'CMD-01')?.linkIds).toContain('L-CFG-001')
  expect(savedDraft.config.platforms.find((platform) => platform.id === 'AIR-02')?.linkIds).toContain('L-CFG-001')
  expect(savedDraft.config.platforms.find((platform) => platform.id === 'UAV-01')?.linkIds).not.toContain('L-CFG-001')

  const reloadedResponse = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.reload()
  const reloaded = await reloadedResponse
  expect(reloaded.status()).toBe(200)
  expect(((await reloaded.json()) as ApiSuccess<ScenarioDraft>).data).toEqual(savedDraft)
  await page.getByRole('tab', { name: '链路配置' }).click()
  const reloadedRow = page.getByTestId('link-table').getByRole('row').filter({ hasText: 'L-CFG-001' })
  await expect(reloadedRow).toContainText('AIR-02')
  await expect(reloadedRow).toContainText('915.125')
  await expect(reloadedRow).toContainText('5.125')
  await page.getByRole('tab', { name: '平台与航点' }).click()
  await platformTable.getByRole('row').filter({ hasText: '空中无人作业节点 U02' }).getByRole('button', { name: '编辑' }).click()
  await expect(page.getByTestId('platform-link-ids')).toHaveValue(/L-CFG-001/)

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P2-4 OPERATOR persists jammer parameters, extensions, associations, and independent switches', async ({ page, request }) => {
  await resetMock(request)
  const audit = auditConsole(page)

  await loginAs(page, 'operator')
  const loaded = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  expect((await loaded).status()).toBe(200)
  await page.getByRole('tab', { name: '干扰设备' }).click()

  await expect(page.getByTestId('toggle-jammer-JAM-WB-01-TX')).toHaveClass(/is-checked/)
  await expect(page.getByTestId('toggle-jammer-JAM-SPOT-01-TX')).not.toHaveClass(/is-checked/)
  await page.getByTestId('toggle-jammer-JAM-SPOT-01-TX').click()
  await expect(page.getByTestId('toggle-jammer-JAM-SPOT-01-TX')).toHaveClass(/is-checked/)
  await expect(page.getByTestId('toggle-jammer-JAM-WB-01-TX')).toHaveClass(/is-checked/)

  await page.getByTestId('add-jammer').click()
  const frequency = page.getByTestId('jammer-frequency').locator('input')
  const bandwidth = page.getByTestId('jammer-bandwidth').locator('input')
  await frequency.fill('0')
  await page.getByTestId('apply-jammer').click()
  await expect(page.getByText('干扰频率必须大于 0 MHz。', { exact: true })).toBeVisible()
  await frequency.fill('0.0001')
  await bandwidth.fill('0')
  await page.getByTestId('apply-jammer').click()
  await expect(page.getByText('干扰带宽必须大于 0 MHz。', { exact: true })).toBeVisible()
  await bandwidth.fill('0.0002')
  await page.getByTestId('jammer-type').click()
  await page.getByRole('option', { name: '瞄准式', exact: true }).click()
  await page.getByTestId('jammer-platform').click()
  await page.getByRole('option', { name: '后方指挥节点（CMD-01）', exact: true }).click()
  await page.getByTestId('jammer-power').locator('input').fill('0')
  await page.getByTestId('jammer-range').locator('input').fill('0')
  await page.getByTestId('jammer-direction').locator('input').fill('270')
  await page.getByTestId('jammer-duration').locator('input').fill('90')
  await page.getByTestId('apply-jammer').click()

  const addedRow = page.getByTestId('jammer-table').getByRole('row').filter({ hasText: 'JAM-CFG-001' })
  await expect(addedRow).toContainText('瞄准式')
  await expect(addedRow).toContainText('270')
  await addedRow.getByRole('button', { name: '编辑' }).click()
  await page.getByTestId('jammer-platform').click()
  await page.getByRole('option', { name: '空中无人作业节点 U02（AIR-02）', exact: true }).click()
  await page.getByTestId('jammer-direction').locator('input').fill('360')
  await page.getByTestId('jammer-duration').locator('input').fill('120')
  await page.getByTestId('apply-jammer').click()

  await page.getByTestId('delete-jammer-0').click()
  await page.getByRole('button', { name: '删除', exact: true }).last().click()
  await expect(page.getByTestId('jammer-table').getByRole('row').filter({ hasText: 'JAM-WB-01-TX' })).toHaveCount(0)

  await page.getByRole('tab', { name: '平台与航点' }).click()
  const platformTable = page.getByTestId('platform-table')
  await platformTable.getByRole('row').filter({ hasText: '空中无人作业节点 U02' }).getByRole('button', { name: '编辑' }).click()
  await expect(page.getByTestId('platform-jammer-ids')).toHaveValue(/JAM-CFG-001/)
  await page.getByTestId('cancel-platform').click()
  await platformTable.getByRole('row').filter({ hasText: '后方指挥节点' }).getByRole('button', { name: '编辑' }).click()
  await expect(page.getByTestId('platform-jammer-ids')).not.toHaveValue(/JAM-CFG-001/)
  await page.getByTestId('cancel-platform').click()

  const savedResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.getByTestId('save-scenario').click()
  const saved = await savedResponse
  expect(saved.status()).toBe(200)
  const savedDraft = ((await saved.json()) as ApiSuccess<ScenarioDraft>).data
  expect(savedDraft.config.jammers.find((jammer) => jammer.id === 'JAM-CFG-001')).toEqual({
    id: 'JAM-CFG-001',
    platformId: 'AIR-02',
    type: 'SPOT',
    defaultPower: 0,
    frequency: 0.0001,
    bandwidth: 0.0002,
    autoDetect: false,
    detectionRange: 0,
  })
  expect(savedDraft.config.jammers.some((jammer) => jammer.id === 'JAM-WB-01-TX')).toBe(false)
  expect(savedDraft.uiExtensions.jammers.find((extension) => extension.jammerId === 'JAM-CFG-001')).toEqual({
    jammerId: 'JAM-CFG-001',
    direction: 360,
    duration: 120,
    enabled: true,
  })
  expect(new Set(savedDraft.uiExtensions.jammers.map((extension) => extension.jammerId))).toEqual(
    new Set(savedDraft.config.jammers.map((jammer) => jammer.id)),
  )
  expect(savedDraft.config.jammers.every((jammer) => !('direction' in jammer) && !('duration' in jammer) && !('enabled' in jammer))).toBe(true)

  const reloadedResponse = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.reload()
  expect((await reloadedResponse).status()).toBe(200)
  expect(await loadScenarioDraft(request)).toEqual(savedDraft)
  await page.getByRole('tab', { name: '干扰设备' }).click()
  const reloadedRow = page.getByTestId('jammer-table').getByRole('row').filter({ hasText: 'JAM-CFG-001' })
  await expect(reloadedRow).toContainText('AIR-02')
  await expect(reloadedRow).toContainText('360')
  await expect(page.getByTestId('toggle-jammer-JAM-CFG-001')).toHaveClass(/is-checked/)

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

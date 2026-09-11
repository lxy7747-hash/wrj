import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { ApiSuccess, ConfirmationContext, DetectionEvent, ScenarioConfig, ScenarioDraft, ScenarioTemplate, SwitchEvent, TelemetryFrame } from '../../src/contracts/domain-models'

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
  titleRole?: 'heading' | 'region'
  hidden?: boolean
}

const SHARED_WORKSPACE_ROUTES: readonly WorkspaceRoute[] = [
  { path: '/situation', navLabel: '态势主界面', title: '态势主界面' },
  { path: '/scenarios', navLabel: '场景配置', title: '场景配置', titleRole: 'region' },
  { path: '/batches', navLabel: '批量仿真', title: '批量仿真', hidden: true },
  { path: '/reports', navLabel: '报表中心', title: '报告分析', titleRole: 'region' },
  { path: '/replays', navLabel: '历史回放', title: '历史回放' },
  { path: '/blueprint', navLabel: '能力与追踪', title: '能力蓝图', hidden: true },
]

const ADMIN_WORKSPACE_ROUTE: WorkspaceRoute = {
  path: '/admin',
  navLabel: '系统管理',
  title: '账号管理',
  titleRole: 'region',
}

const OPERATOR_SYSTEM_ROUTE: WorkspaceRoute = {
  path: '/admin/data-exchange',
  navLabel: '系统管理',
  title: '数据交换与接口',
}

const PROTECTED_WORKSPACE_PATHS = [
  ...SHARED_WORKSPACE_ROUTES.map((route) => route.path),
  ADMIN_WORKSPACE_ROUTE.path,
  OPERATOR_SYSTEM_ROUTE.path,
  '/traceability',
  '/interactions',
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

async function openInteractions(page: Page): Promise<void> {
  // 一级菜单已隐藏，直接访问保留的蓝图路由，再验证二级导航。
  await page.goto('/blueprint')
  await page.getByRole('menuitem', { name: '感知、干扰与选路', exact: true }).click()
  await page.waitForURL('**/interactions')
}

/**
 * 可见页面通过菜单进入，隐藏页面验证入口不存在后直接访问，保留全部路由覆盖。
 * @param page 已登录的浏览器页面。
 * @param route 目标路由、菜单名称及页面断言信息。
 * @returns 导航和页面检查完成后无返回值。
 */
async function visitWorkspaceRoute(page: Page, route: WorkspaceRoute): Promise<void> {
  const navigation = page.getByRole('navigation', { name: '主导航' })
  const link = navigation.getByRole('link', { name: route.navLabel, exact: true })

  if (route.hidden) {
    await expect(link).toHaveCount(0)
    await page.goto(route.path)
  } else {
    await link.click()
  }
  await page.waitForURL((url) => url.pathname === route.path)

  expect(new URL(page.url()).pathname).toBe(route.path)
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(navigation).toBeVisible()
  await expect(page.getByTestId('identity-panel')).toBeVisible()
  if (route.path === '/batches') {
    await expect(page.getByTestId('batch-run-table')).toBeVisible()
    await expect(page.locator('#batches-title')).toHaveCount(0)
  } else if (route.path === '/replays') {
    await expect(page.getByTestId('replay-timeline')).toBeVisible()
    await expect(page.locator('#replays-title')).toHaveCount(0)
  } else {
    await expect(page.getByRole(route.titleRole ?? 'heading', { name: route.title, exact: true })).toBeVisible()
  }
  if (!route.hidden) await expect(link).toHaveAttribute('aria-current', 'page')
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

test.beforeEach(async ({ request }) => {
  await resetMock(request)
})

test('anonymous access keeps login public and redirects every protected route', async ({ page }) => {
  const audit = auditConsole(page)

  await page.goto('/login')
  await expect(page.getByTestId('login-submit')).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)

  await page.goto('/')
  await page.waitForURL('**/login')
  await expect(page.getByTestId('login-submit')).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)

  for (const path of PROTECTED_WORKSPACE_PATHS) {
    await page.goto(path)
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

test('管理员可使用当前菜单并直接访问隐藏页面', async ({ page }) => {
  const audit = auditConsole(page)

  await loginAs(page, 'admin')
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link')).toHaveCount(5)
  for (const route of [...SHARED_WORKSPACE_ROUTES, ADMIN_WORKSPACE_ROUTE]) {
    await visitWorkspaceRoute(page, route)
  }

  await expect(page.getByRole('complementary', { name: '系统管理导航' })).toContainText('主数据管理')
  await expect(page.getByRole('complementary', { name: '系统管理导航' })).toContainText('数据交换与接口')
  await expect(page.getByTestId('user-role-panel')).toBeVisible()
  await expect(page.getByTestId('role-permission-map')).toContainText('BUSINESS_READ')

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P7 ADMIN maintains master data and rejects dot path identifiers', async ({ page }) => {
  const audit = auditConsole(page)
  await loginAs(page, 'admin')
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '系统管理' }).click()
  await page.getByRole('menuitem', { name: '主数据管理', exact: true }).click()
  const panel = page.getByTestId('master-data-panel')
  await expect(panel.getByTestId('master-table')).toContainText('MW-COMM')
  await panel.getByTestId('master-create').click()
  const createDialog = page.getByRole('dialog', { name: '新增主数据', exact: true })
  for (const dataId of ['.', '..']) {
    await createDialog.getByTestId('master-id').fill(dataId)
    await createDialog.getByTestId('master-save').click()
    await expect(createDialog.getByRole('alert')).toContainText('请填写有效编号')
  }
  await createDialog.getByTestId('master-id').fill('DEVICE-P7-E2E')
  const created = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/admin/master-data')
  await createDialog.getByTestId('master-save').click()
  expect((await created).status()).toBe(201)
  await expect(createDialog).not.toBeVisible()
  const row = panel.getByTestId('master-table').locator('.el-table__row').filter({ hasText: 'DEVICE-P7-E2E' })
  await expect(row).toContainText('启用')
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  const editDialog = page.getByRole('dialog', { name: '编辑主数据', exact: true })
  await expect(editDialog.getByTestId('master-id')).toBeDisabled()
  await editDialog.locator('.el-switch').click()
  await expect(editDialog.getByRole('switch')).not.toBeChecked()
  const updated = page.waitForResponse((response) => response.request().method() === 'PUT'
    && new URL(response.url()).pathname === '/api/v1/admin/master-data/DEVICE-P7-E2E')
  await editDialog.getByTestId('master-save').click()
  const updateResponse = await updated
  expect(updateResponse.status()).toBe(200)
  expect(await updateResponse.json()).toMatchObject({ data: { dataId: 'DEVICE-P7-E2E', version: 2, active: false } })
  await expect(editDialog).not.toBeVisible()
  await panel.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(row).toContainText('停用')
  await expect(row.locator('td').nth(2)).toHaveText('2')
  await row.getByRole('button', { name: '删除', exact: true }).click()
  const deleted = page.waitForResponse((response) => response.request().method() === 'DELETE'
    && new URL(response.url()).pathname === '/api/v1/admin/master-data/DEVICE-P7-E2E')
  await page.getByRole('dialog', { name: '删除主数据', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click()
  expect((await deleted).status()).toBe(200)
  await expect(row).toHaveCount(0)
  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P7 ADMIN restores backups, exports configuration and opens an archived report', async ({ page }) => {
  const audit = auditConsole(page)
  await loginAs(page, 'admin')
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '系统管理' }).click()
  await page.getByRole('menuitem', { name: '数据库备份 / 恢复', exact: true }).click()
  const panel = page.getByTestId('backup-panel')
  await expect(panel.getByTestId('backup-table')).toContainText('PREBACKUP-002')
  await panel.getByTestId('backup-create').click()
  const backedUp = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/admin/backup')
  await page.getByRole('dialog', { name: '创建备份', exact: true }).getByRole('button', { name: '确认执行' }).click()
  expect((await backedUp).status()).toBe(200)
  await expect(panel.getByTestId('backup-table')).toContainText('BACKUP-P7-001')

  for (const [backupId, result, integrityValid, rolledBack] of [
    ['PREBACKUP-002', 'SUCCESS', true, false],
    ['BACKUP-CORRUPT-001', 'FAILURE', false, false],
    ['BACKUP-ROLLBACK-001', 'FAILURE', true, true],
  ] as const) {
    await panel.getByTestId('backup-table').locator('.el-table__row').filter({ hasText: backupId })
      .getByRole('button', { name: '选择恢复' }).click()
    await expect(panel.getByTestId('restore-result')).toHaveCount(0)
    await expect(panel.getByTestId('backup-feedback')).toContainText('恢复来源已切换')
    await panel.getByTestId('backup-restore').click()
    const restored = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/admin/restore')
    await page.getByRole('dialog', { name: '恢复备份', exact: true }).getByRole('button', { name: '确认执行' }).click()
    const restoreResponse = await restored
    expect(restoreResponse.request().postDataJSON()).toMatchObject({ operation: 'RESTORE', backupId })
    expect(restoreResponse.status()).toBe(200)
    expect(await restoreResponse.json()).toMatchObject({ data: { result, integrityValid, rolledBack, generated: false } })
    await expect(panel.getByTestId('restore-result')).toContainText(result === 'SUCCESS' ? '成功' : rolledBack ? '已回滚' : '失败，恢复未开始')
  }

  await expect(panel.getByTestId('full-config-export')).toHaveCount(0)
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  await page.getByTestId('open-scenario-operations').click()
  const exportPanel = page.getByTestId('scenario-config-export')
  await expect(exportPanel).toContainText('不校验或导出当前场景内容')
  await exportPanel.getByTestId('full-config-export').click()
  const exported = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/admin/config/export')
  await page.getByRole('dialog', { name: '完整配置导出流程演示', exact: true }).getByRole('button', { name: '确认执行' }).click()
  const exportResponse = await exported
  expect(exportResponse.status()).toBe(200)
  const exportBody = await exportResponse.json()
  expect(exportBody).toMatchObject({ data: { objectId: 'FULL-CONFIG', classification: 'INTERNAL', generated: false } })
  await expect(exportPanel).toContainText('完整配置导出流程验证通过；未校验或导出当前场景内容，未生成实际文件。')
  await expect(exportPanel.getByTestId('full-config-result')).toContainText(exportBody.data.watermark)
  await expect(exportPanel.getByTestId('full-config-result')).toContainText(exportBody.data.verifiedAt)

  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '系统管理' }).click()
  await page.getByRole('menuitem', { name: '仿真数据管理', exact: true }).click()
  const archive = page.getByTestId('archive-panel')
  await archive.getByRole('textbox', { name: '归档检索' }).fill('RPT-001')
  await archive.getByTestId('archive-table').getByRole('button', { name: '详情', exact: true }).click()
  for (const id of ['TASK-001', 'SCN-001', 'RUN-001', 'REPLAY-001', 'RPT-001']) {
    await expect(page.getByTestId('archive-detail')).toContainText(id)
  }
  await page.getByRole('dialog', { name: '归档关联详情' }).getByRole('button', { name: '查看关联报告' }).click()
  await page.waitForURL('**/reports?reportId=RPT-001')
  await expect(page.getByTestId('report-tabs')).toHaveAttribute('data-report-id', 'RPT-001')
  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P7 ADMIN filters and confirms audit export while OPERATOR remains denied', async ({ page }) => {
  const audit = auditConsole(page)
  await loginAs(page, 'admin')
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '系统管理' }).click()
  await page.getByRole('menuitem', { name: '操作审计日志' }).click()
  await page.waitForURL('**/admin?section=audit-logs')
  await expect(page.getByRole('heading', { name: '操作审计日志' })).toBeVisible()
  await expect(page.getByTestId('audit-table')).toContainText('THRESHOLD_UPDATE')

  await page.getByRole('textbox', { name: '用户' }).fill('admin')
  await page.getByRole('textbox', { name: '模块' }).fill('SCENARIO_CONFIGURATION')
  const filteredResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'GET'
      && url.pathname === '/api/v1/admin/audit'
      && url.searchParams.get('actor') === 'admin'
      && url.searchParams.get('module') === 'SCENARIO_CONFIGURATION'
  })
  await page.getByRole('button', { name: '查询' }).click()
  expect((await filteredResponse).status()).toBe(200)
  await expect(page.getByTestId('audit-table')).toContainText('SCENARIO_CONFIGURATION')

  const confirmationCreated = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/confirmations')
  await page.getByRole('button', { name: '确认并验证导出' }).click()
  expect((await confirmationCreated).status()).toBe(201)
  await expect(page.getByRole('dialog', { name: '确认导出审计日志' })).toBeVisible()

  const confirmationAccepted = page.waitForResponse((response) => response.request().method() === 'POST'
    && /^\/api\/v1\/confirmations\/[^/]+$/.test(new URL(response.url()).pathname))
  const exported = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/admin/audit/export')
  await page.getByTestId('confirm-audit-export').click()
  expect((await confirmationAccepted).status()).toBe(200)
  expect((await exported).status()).toBe(200)
  await expect(page.getByTestId('audit-export-status')).toContainText('INTERNAL')
  await expect(page.getByTestId('audit-export-status')).toContainText('内部使用 · admin · AUDIT-LOG')
  await expect(page.getByTestId('audit-export-status')).toContainText('2026-08-06T08:00:00Z')

  await page.getByTestId('logout').click()
  await loginAs(page, 'operator')
  await page.goto('/admin?section=audit-logs')
  await page.waitForURL('**/blueprint')
  await expect(page.getByTestId('route-denial')).toContainText('PERMISSION_DENIED')

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

test('操作员可使用当前菜单和隐藏页面且禁止越权访问', async ({ page }) => {
  const audit = auditConsole(page)

  await loginAs(page, 'operator')
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link')).toHaveCount(5)
  await expect(page.getByRole('link', { name: '需求追踪矩阵', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '弹窗交互', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '登录页', exact: true })).toHaveCount(0)
  for (const route of [...SHARED_WORKSPACE_ROUTES, OPERATOR_SYSTEM_ROUTE]) {
    await visitWorkspaceRoute(page, route)
  }
  await expect(page.getByRole('complementary', { name: '系统管理导航' })).toContainText('账号管理')
  await expect(page.getByRole('complementary', { name: '系统管理导航' }).getByRole('menuitem', { name: '数据交换与接口', exact: true })).toBeVisible()

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

test('P5 OPERATOR validates data exchange and seven interface contracts', async ({ page }) => {
  const audit = auditConsole(page)
  await loginAs(page, 'operator')
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '系统管理' }).click()
  await page.waitForURL('**/admin/data-exchange')

  await expect(page.getByTestId('exchange-monitor')).toBeVisible()
  await expect(page.locator('.monitor-status')).toHaveCount(6)
  await page.getByTestId('open-exchange-tools').click()

  const csvCard = page.getByTestId('csv-contract-card')
  await expect(csvCard).toBeVisible()
  await csvCard.getByRole('button', { name: '加载合同示例' }).click()
  await csvCard.getByRole('button', { name: '校验 CSV' }).click()
  await expect(csvCard).toContainText('CSV 合同校验通过，共 1 行数据')
  await expect(csvCard).toContainText('目标文件：未改变')

  const jsonCard = page.getByTestId('scenario-json-panel')
  const scenarioResponse = page.waitForResponse((response) => new URL(response.url()).pathname === SCENARIO_PATH)
  await jsonCard.getByRole('button', { name: '加载当前场景' }).click()
  expect((await scenarioResponse).status()).toBe(200)
  await jsonCard.getByRole('button', { name: '解析 JSON' }).click()
  await expect(jsonCard).toContainText('场景 JSON 解析通过')
  await expect(jsonCard).toContainText('SCN-001')

  const websocketCard = page.getByTestId('websocket-contract-card')
  await websocketCard.getByRole('button', { name: '连接通道' }).click()
  await expect(websocketCard).toContainText('已订阅')
  await expect(websocketCard).toContainText('F-00042')
  await expect(websocketCard.locator('.el-table__row')).toHaveCount(5)

  const processCard = page.getByTestId('process-contract-card')
  await processCard.getByRole('button', { name: '检查进程管理合同' }).click()
  await expect(processCard).toContainText('已退出')
  await expect(processCard).toContainText('资源释放已释放')
  await expect(processCard).toContainText('真实进程未启动')

  const interfaceTable = page.getByTestId('interface-contract-table')
  await expect(interfaceTable.locator('.interface-item')).toHaveCount(7)
  await expect(interfaceTable).toContainText('3 类外部 + 4 类内部')
  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P3-3 OPERATOR reads the F-00042 same-frame link calculation contract', async ({ page }) => {
  const audit = auditConsole(page)

  await loginAs(page, 'operator')
  const frameResponse = page.waitForResponse((response) => (
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v1/simulations/RUN-001/frames/F-00042'
  ))
  await page.goto('/blueprint')
  expect((await frameResponse).status()).toBe(200)

  const contract = page.getByTestId('link-calculator-contract')
  await expect(contract).toBeVisible()
  await expect(contract.getByTestId('link-contract-state')).toContainText('同帧通过')
  await expect(contract).toContainText('F-00042')
  await expect(contract).toContainText('L-MW-01')
  await expect(contract).toContainText('高空前出中继节点')
  await expect(contract).toContainText('地面无人集群指挥车')
  await expect(contract).toContainText('4500 MHz')
  await expect(contract).toContainText('3.2e-7')

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P3-4 OPERATOR verifies the F-00042 composite propagation loss example', async ({ page }) => {
  const audit = auditConsole(page)

  await loginAs(page, 'operator')
  const frameResponse = page.waitForResponse((response) => (
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v1/simulations/RUN-001/frames/F-00042'
  ))
  await openInteractions(page)
  expect((await frameResponse).status()).toBe(200)

  const example = page.getByTestId('composite-loss-example')
  await expect(example).toBeVisible()
  await expect(example.getByTestId('composite-loss-state')).toContainText('算例通过')
  await expect(example).toContainText('120 + 12 + 5 + 5.5 = 142.5 dB')
  await expect(example).toContainText('COMPOSITE-LOSS-1.0')
  await expect(example).toContainText('F-00042 @ 42 s')

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P3-5 OPERATOR verifies the F-00042 SNR and BER calculation evidence', async ({ page }) => {
  const audit = auditConsole(page)

  await loginAs(page, 'operator')
  const frameResponse = page.waitForResponse((response) => (
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v1/simulations/RUN-001/frames/F-00042'
  ))
  await openInteractions(page)
  expect((await frameResponse).status()).toBe(200)

  const example = page.getByTestId('snr-ber-example')
  await expect(example).toBeVisible()
  await expect(example.getByTestId('snr-ber-state')).toContainText('算例通过')
  await expect(example).toContainText('-84 dBm')
  await expect(example).toContainText('-104 dBm')
  await expect(example).toContainText('18.62 dB')
  await expect(example).toContainText('3.2e-7')
  await expect(example).toContainText('QPSK')
  await expect(example).toContainText('SNBER-1.2')

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P4-1 OPERATOR reads ESM configuration and one deduplicated detection', async ({ page }) => {
  const audit = auditConsole(page)

  await loginAs(page, 'operator')
  await openInteractions(page)

  const panel = page.getByTestId('esm-sensor-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('esm-state')).toContainText('已检出')
  await expect(panel).toContainText('ESM-01')
  await expect(panel).toContainText('2000–5000 MHz')
  await expect(panel).toContainText('150 km')
  await expect(panel).toContainText('高空前出中继节点（UAV-01）')
  await expect(panel).toContainText('95%')
  await expect(panel).toContainText('42 s')
  await expect(panel).toContainText('重复侦测事件已忽略')

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P4-2 OPERATOR executes RF jammer control and sees the effective frame', async ({ page }) => {
  const audit = auditConsole(page)

  await loginAs(page, 'operator')
  await openInteractions(page)

  const panel = page.getByTestId('rf-jammer-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('2180–2220 MHz')
  await expect(panel).toContainText('72 W')
  const commandResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/tasks/TASK-001/jammers/JAM-WB-01-TX/commands'
  ))
  await panel.getByRole('button', { name: '执行命令' }).click()
  const command = await commandResponse
  expect(command.status()).toBe(200)
  expect(command.request().postDataJSON()).toMatchObject({ duration: 120 })

  await expect(panel.getByTestId('rf-state')).toContainText('执行成功')
  await expect(panel).toContainText('任务手动启扰，生效帧 F-00042。')
  await expect(panel).toContainText('72 W / 2200 MHz / 120 s')
  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P4-3～P4-7 OPERATOR completes closed-loop, synchronization, routing and switch review', async ({ page }) => {
  const audit = auditConsole(page)
  await loginAs(page, 'operator')
  await openInteractions(page)

  const closedLoop = page.getByTestId('closed-loop-panel')
  const firstLoop = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/simulations/RUN-001/events')
  await closedLoop.getByRole('button', { name: '执行闭环' }).click()
  expect((await firstLoop).status()).toBe(200)
  await expect(closedLoop.getByTestId('closed-loop-state')).toContainText('闭环完成')
  await expect(closedLoop).toContainText('DET-042 · F-00042')
  await expect(closedLoop).toContainText('L-DL-03 · 劣化')

  const duplicateLoop = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/simulations/RUN-001/events')
  await closedLoop.getByRole('button', { name: '执行闭环' }).click()
  expect((await duplicateLoop).status()).toBe(409)
  await expect(closedLoop).toContainText('同一目标同一帧已完成闭环处理。')

  const synchronization = page.getByTestId('jammer-sync-panel')
  const syncResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/tasks/TASK-001/jammers/JAM-WB-01-TX/parameters')
  await synchronization.getByRole('button', { name: '同步参数' }).click()
  const synchronized = await syncResponse
  expect(synchronized.status()).toBe(200)
  expect(synchronized.request().postDataJSON()).toMatchObject({ parameters: { duration: 120 } })
  await expect(synchronization.getByTestId('jammer-sync-state')).toContainText('同步完成')
  await expect(synchronization).toContainText('v5')
  await expect(synchronization).toContainText('F-00042')

  const forward = page.getByTestId('forward-route-ranking')
  const reverse = page.getByTestId('reverse-route-ranking')
  await expect(forward).toContainText('L-MW-01')
  await expect(forward).toContainText('干扰影响最小')
  await expect(reverse).toContainText('L-LASER-04')
  await expect(reverse).toContainText('链路不可用或未连通')

  const switches = page.getByTestId('switch-decision-panel')
  await expect(switches).toContainText('接受 1')
  await expect(switches).toContainText('拒绝 1')
  await expect(switches).toContainText('切换冷却期未结束')
  expect(audit.errors).toEqual([
    'Failed to load resource: the server responded with a status of 409 (Conflict)',
  ])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P3-6 OPERATOR reads the controlled L-DL-03 state evidence', async ({ page }) => {
  const audit = auditConsole(page)
  const frameResponse = page.waitForResponse((response) => (
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v1/simulations/RUN-001/frames/F-00042'
  ))

  await loginAs(page, 'operator')
  expect((await frameResponse).status()).toBe(200)

  const telemetryPanel = page.getByLabel('链路、干扰与事件', { exact: true })
  const degradedLink = telemetryPanel.locator('tr[data-link-id="L-DL-03"]')
  await expect(degradedLink.locator('.link-status')).toHaveText('劣化')
  await degradedLink.click()

  const dialog = page.locator('.link-quality-dialog')
  await expect(dialog).toContainText('规范状态中断')
  await expect(dialog).toContainText('阈值版本LLZT-1.0')
  await expect(dialog).toContainText('稳定帧数3')
  await expect(dialog).toContainText('判定依据误码率超过阈值并满足稳定帧条件')

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P3-7 OPERATOR reads the fixed link candidate snapshot and empty state', async ({ page }) => {
  const audit = auditConsole(page)
  await page.routeWebSocket(/\/ws\/v1(?:\?|$)/, () => {})
  const frameResponse = page.waitForResponse((response) => (
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v1/simulations/RUN-001/frames/F-00042'
  ))
  const eventsResponse = page.waitForResponse((response) => (
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v1/simulations/RUN-001/events'
  ))

  await loginAs(page, 'operator')
  expect((await frameResponse).status()).toBe(200)
  const eventsPayload = await (await eventsResponse).json() as ApiSuccess<Array<DetectionEvent | SwitchEvent>>
  const switchEventIds = new Set(eventsPayload.data
    .filter((event) => event.type === 'LINK_SWITCH')
    .map((event) => event.eventId))
  await page.getByTestId('open-link-candidates').click()

  const dialog = page.locator('.link-candidate-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('TASK-001')
  await expect(dialog).toContainText('F-00042')
  await expect(dialog).toContainText('42 s')
  await expect(dialog).toContainText('候选数量4 条')
  await expect(dialog.locator('[data-candidate-id]')).toHaveCount(4)
  const microwave = dialog.locator('[data-candidate-id="L-MW-01"]')
  await expect(microwave).toContainText('前向')
  await expect(microwave).toContainText('正常')
  await expect(microwave).toContainText('可用')
  await expect(microwave).toContainText('3.2e-7')
  await expect(microwave).toContainText('1.38 dB')
  await expect(microwave).toContainText('连续 5 帧')

  await page.route('**/api/v1/simulations/RUN-001/frames/F-00042', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as ApiSuccess<TelemetryFrame>
    body.data.evidence.routeCandidates = []
    body.data.evidence.routeDecisions = []
    body.data.eventIds = body.data.eventIds.filter((eventId) => !switchEventIds.has(eventId))
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/v1/simulations/RUN-001/events', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as ApiSuccess<Array<DetectionEvent | SwitchEvent>>
    body.data = body.data.filter((event) => event.type !== 'LINK_SWITCH')
    await route.fulfill({ response, json: body })
  })
  const emptyFrameResponse = page.waitForResponse((response) => (
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v1/simulations/RUN-001/frames/F-00042'
  ))
  const emptyEventsResponse = page.waitForResponse((response) => (
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/v1/simulations/RUN-001/events'
  ))
  await page.reload()
  const emptyPayload = await (await emptyFrameResponse).json() as ApiSuccess<TelemetryFrame>
  const emptyEventsPayload = await (await emptyEventsResponse).json() as ApiSuccess<Array<DetectionEvent | SwitchEvent>>
  expect(emptyPayload.data.evidence.routeCandidates).toHaveLength(0)
  expect(emptyPayload.data.eventIds.some((eventId) => switchEventIds.has(eventId))).toBe(false)
  expect(emptyEventsPayload.data.some((event) => event.type === 'LINK_SWITCH')).toBe(false)
  await page.getByTestId('open-link-candidates').click()
  await expect(page.locator('.link-candidate-dialog')).toContainText('当前帧没有候选链路')
  await expect(page.locator('.link-candidate-dialog [data-candidate-id]')).toHaveCount(0)

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P3 reports atomically switch sources and enforce Level II/III export paths', async ({ page }) => {
  const audit = auditConsole(page)
  await loginAs(page, 'operator')
  const reportList = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/reports')
  await page.getByRole('link', { name: '报表中心', exact: true }).click()
  expect((await reportList).status()).toBe(200)
  await expect(page.getByRole('region', { name: '报告分析', exact: true })).toBeVisible()
  await expect(page.getByTestId('report-tabs')).toHaveAttribute('data-report-id', 'RPT-001')
  await expect(page.getByTestId('report-tabs')).toContainText('RUN-001 · T+0～7200 s')
  await page.getByRole('tab', { name: '时序曲线', exact: true }).click()
  await expect(page.getByRole('img', { name: 'L-MW-01 snrDb 时序曲线', exact: true })).toBeVisible()
  await expect(page.getByTestId('report-time-series-table').locator('.el-table__row')).toHaveCount(3)

  const batchLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/reports/RPT-BATCH-001')
  await page.getByTestId('report-source').click()
  await page.getByRole('option', { name: /RPT-BATCH-001/ }).click()
  expect((await batchLoaded).status()).toBe(200)
  await expect(page.getByTestId('report-tabs')).toHaveAttribute('data-report-id', 'RPT-BATCH-001')
  await expect(page.getByTestId('report-tabs')).toContainText('BATCH-001 · 12 次确定性运行')
  await page.getByTestId('report-export').click()
  await expect(page.getByText('当前账号没有三级批量报告导出权限。', { exact: true })).toBeVisible()

  const ordinaryLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/reports/RPT-001')
  await page.getByTestId('report-source').click()
  await page.getByRole('option', { name: /RPT-001 · 单次仿真/ }).click()
  expect((await ordinaryLoaded).status()).toBe(200)
  const ordinaryExport = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/reports/RPT-001/export')
  await page.getByTestId('report-export').click()
  expect((await ordinaryExport).status()).toBe(200)
  await expect(page.locator('.reports-page__export-result')).toContainText('未生成文件')

  const adminPage = await page.context().newPage()
  const adminAudit = auditConsole(adminPage)
  await loginAs(adminPage, 'admin')
  await adminPage.getByRole('link', { name: '报表中心', exact: true }).click()
  await adminPage.getByTestId('report-tabs').waitFor()
  await adminPage.getByTestId('report-source').click()
  await adminPage.getByRole('option', { name: /RPT-BATCH-001/ }).click()
  await expect(adminPage.getByTestId('report-tabs')).toHaveAttribute('data-report-id', 'RPT-BATCH-001')
  await adminPage.getByTestId('report-export').click()
  const dialog = adminPage.getByRole('dialog', { name: '确认验证三级批量报告导出' })
  await expect(dialog).toBeVisible()
  const aggregateExport = adminPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/reports/RPT-BATCH-001/export')
  await dialog.getByTestId('confirm-report-export').click()
  expect((await aggregateExport).status()).toBe(200)
  await expect(adminPage.locator('.reports-page__export-result')).toContainText('2026-08-06T10:08:00Z')

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
  expect(adminAudit.errors).toEqual([])
  expect(adminAudit.http404s).toEqual([])
  expect([...adminAudit.nonLoopbackHosts]).toEqual([])
  await adminPage.close()
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
    const nameError = page.locator('.el-form-item').filter({ has: name })
      .getByText('场景名称为必填项，且不能超过 128 个字符。', { exact: true })
    await expect(page.getByTestId('scenario-id')).toHaveValue('SCN-001')
    await expect(page.getByText('开始时间', { exact: true })).toBeVisible()
    await expect(name).not.toHaveValue('')

    await name.fill('')
    await page.getByTestId('save-scenario').click()
    await expect(page.getByTestId('validation-panel')).toBeVisible()
    await page.getByTestId('locate-validation-issue-0').click()
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
      uiExtensions: { jammers: expect.any(Array), sensors: expect.any(Array) },
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
  test('批量新增至类型上限并显式配置卫星，保存重载保持数量和部署域', async ({ page }) => {
    const audit = auditConsole(page)
    await loginAs(page, 'operator')
    await page.getByRole('link', { name: '场景配置', exact: true }).click()
    await page.getByRole('tab', { name: '节点配置' }).click()
    await page.getByTestId('add-platform').click()
    await page.getByTestId('platform-type').click()
    await page.getByRole('option', { name: '后方指挥节点', exact: true }).click()
    await expect(page.getByTestId('platform-category')).toHaveValue('地面')
    await expect(page.getByTestId('apply-platform')).toBeDisabled()
    await page.getByTestId('platform-type').click()
    await page.getByRole('option', { name: '空中无人作业集群', exact: true }).click()
    await expect(page.getByTestId('platform-category')).toHaveValue('空中')
    await expect(page.getByTestId('platform-quantity').locator('input')).toHaveAttribute('max', '44')
    await page.getByTestId('platform-name').fill('E2E 批量集群')
    await page.getByTestId('platform-quantity').locator('input').fill('44')
    await page.getByTestId('apply-platform').click()
    const table = page.getByTestId('platform-table')
    await expect(table.getByRole('row').filter({ hasText: 'E2E 批量集群' })).toHaveCount(44)

    await page.getByTestId('add-platform').click()
    await page.getByTestId('platform-type').click()
    await page.getByRole('option', { name: '地面干扰设备', exact: true }).click()
    await expect(page.getByTestId('platform-category')).toHaveValue('地面')
    await expect(page.getByTestId('platform-satellite-type')).toBeHidden()
    await page.getByTestId('platform-type').click()
    await page.getByRole('option', { name: '通信卫星', exact: true }).click()
    await expect(page.getByTestId('platform-category')).toHaveValue('天基')
    await page.getByTestId('apply-platform').click()
    await expect(page.getByTestId('platform-dialog')).toContainText('请选择天通卫星或神通卫星。')
    await page.getByTestId('platform-satellite-type').click()
    await page.getByRole('option', { name: '神通卫星', exact: true }).click()
    await page.getByTestId('platform-name').fill('E2E 神通配置')
    await page.getByTestId('apply-platform').click()
    const savedResponse = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === SCENARIO_PATH)
    await page.getByTestId('save-scenario').click()
    const saved = await savedResponse
    expect(saved.status()).toBe(200)
    const snapshot = ((await saved.json()) as ApiSuccess<ScenarioDraft>).data
    const airborne = snapshot.config.platforms.filter(({ type }) => type === 'AIRBORNE_MISSION_CLUSTER')
    expect(airborne).toHaveLength(47)
    expect(airborne.every(({ category }) => category === 'air')).toBe(true)
    expect(snapshot.config.platforms.filter(({ type }) => type === 'REAR_COMMAND_NODE')).toHaveLength(1)
    expect(snapshot.config.platforms.find(({ name }) => name === 'E2E 神通配置')).toMatchObject({ type: 'COMMUNICATION_SATELLITE', satelliteType: 'SHENTONG', category: 'space' })
    const reloadedResponse = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === SCENARIO_PATH)
    await page.reload()
    expect(((await (await reloadedResponse).json()) as ApiSuccess<ScenarioDraft>).data).toEqual(snapshot)
    await page.getByRole('tab', { name: '节点配置' }).click()
    await expect(table.getByRole('row').filter({ hasText: 'E2E 批量集群' })).toHaveCount(44)
    await expect(table.getByRole('row').filter({ hasText: 'E2E 神通配置' })).toContainText('神通卫星')
    expect(audit.errors).toEqual([])
    expect(audit.http404s).toEqual([])
    expect([...audit.nonLoopbackHosts]).toEqual([])
  })

  test('OPERATOR adds and edits a platform waypoint, saves, and reloads it', async ({ page, request }) => {
    const audit = auditConsole(page)

    await loginAs(page, 'operator')
    const loaded = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === SCENARIO_PATH)
    await page.getByRole('link', { name: '场景配置', exact: true }).click()
    expect((await loaded).status()).toBe(200)
    await page.getByRole('tab', { name: '节点配置' }).click()

    await page.getByTestId('add-platform').click()
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
    await page.getByRole('tab', { name: '节点配置' }).click()
    const reloadedRow = page.getByTestId('platform-table').getByRole('row').filter({ hasText: 'E2E 已编辑业务节点' })
    await expect(reloadedRow).not.toContainText('PLAT-001')
    await page.getByRole('checkbox', { name: '显示编号', exact: true }).check()
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
  const audit = auditConsole(page)

  await loginAs(page, 'operator')
  const loaded = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  expect((await loaded).status()).toBe(200)
  await page.getByRole('checkbox', { name: '显示编号', exact: true }).check()
  await page.getByRole('tab', { name: '链路配置' }).click()
  await page.getByTestId('add-link').click()
  await expect(page.getByTestId('link-dialog')).toBeVisible()
  await expect(page.getByTestId('link-business-fields')).toBeVisible()
  await expect(page.getByTestId('demand-direction')).toHaveCount(0)
  await page.getByTestId('demand-volume-unit').click()
  await page.getByRole('option', { name: 'MB', exact: true }).click()
  await page.getByTestId('demand-volume').locator('input').fill('3')

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

  await page.getByRole('tab', { name: '节点配置' }).click()
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
  expect(savedDraft.config.informationDemand.find(item => item.linkId === 'L-CFG-001')).toMatchObject({
    sourcePlatformId: 'CMD-01', destinationPlatformIds: ['AIR-02'], direction: 'FORWARD', volumeMb: 3,
  })
  expect(savedDraft.config.platforms.find((platform) => platform.id === 'AIR-02')?.linkIds).toContain('L-CFG-001')
  expect(savedDraft.config.platforms.find((platform) => platform.id === 'UAV-01')?.linkIds).not.toContain('L-CFG-001')

  const reloadedResponse = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.reload()
  const reloaded = await reloadedResponse
  expect(reloaded.status()).toBe(200)
  expect(((await reloaded.json()) as ApiSuccess<ScenarioDraft>).data).toEqual(savedDraft)
  await page.getByRole('checkbox', { name: '显示编号', exact: true }).check()
  await page.getByRole('tab', { name: '链路配置' }).click()
  const reloadedRow = page.getByTestId('link-table').getByRole('row').filter({ hasText: 'L-CFG-001' })
  await expect(reloadedRow).toContainText('AIR-02')
  await expect(reloadedRow).toContainText('915.125')
  await expect(reloadedRow).toContainText('5.125')
  await page.getByRole('tab', { name: '节点配置' }).click()
  await platformTable.getByRole('row').filter({ hasText: '空中无人作业节点 U02' }).getByRole('button', { name: '编辑' }).click()
  await expect(page.getByTestId('platform-link-ids')).toHaveValue(/L-CFG-001/)

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P2-4 OPERATOR persists jammer parameters, extensions, associations, and independent switches', async ({ page, request }) => {
  const audit = auditConsole(page)
  const baseline = await loadScenarioDraft(request)
  baseline.config.platforms.push({ ...structuredClone(baseline.config.platforms.find(platform => platform.id === 'STN-01')!),
    id: 'AJ-001', name: '机载干扰平台', type: 'AIRBORNE_JAMMER_PLATFORM', category: 'air', jammerIds: [], sensorIds: [] })
  expect((await request.put(`${MOCK_ORIGIN}${SCENARIO_PATH}`, { headers: { Origin: UI_ORIGIN, 'X-Demo-Role': 'OPERATOR' },
    data: { config: baseline.config, uiExtensions: baseline.uiExtensions } })).status()).toBe(200)

  await loginAs(page, 'operator')
  const loaded = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  expect((await loaded).status()).toBe(200)
  await page.getByRole('checkbox', { name: '显示编号', exact: true }).check()
  await page.getByRole('tab', { name: '干扰设备' }).click()

  await expect(page.getByTestId('toggle-jammer-JAM-WB-01-TX')).toHaveClass(/is-checked/)
  await expect(page.getByTestId('toggle-jammer-JAM-SPOT-01-TX')).toHaveCount(0)
  await expect(page.getByTestId('toggle-jammer-JAM-WB-01-TX')).toHaveClass(/is-checked/)

  await page.getByTestId('add-jammer').click()
  await expect(page.getByTestId('jammer-platform')).not.toContainText('后方指挥节点')
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
  await expect(page.getByRole('option', { name: '后方指挥节点（CMD-01）', exact: true })).toHaveCount(0)
  await page.getByRole('option', { name: '地面固定式干扰侦测站（STN-01）', exact: true }).click()
  await page.getByTestId('jammer-power').locator('input').fill('0')
  await page.getByTestId('jammer-range').locator('input').fill('1')
  await page.getByTestId('jammer-direction').locator('input').fill('270')
  await page.getByTestId('jammer-duration').locator('input').fill('90')
  await page.getByTestId('apply-jammer').click()

  const addedRow = page.getByTestId('jammer-table').getByRole('row').filter({ hasText: 'JAM-CFG-001' })
  await expect(addedRow).toContainText('瞄准式')
  await expect(addedRow).toContainText('270')
  await page.getByTestId('toggle-jammer-JAM-CFG-001').click()
  await expect(page.getByTestId('toggle-jammer-JAM-CFG-001')).not.toHaveClass(/is-checked/)
  await expect(page.getByTestId('toggle-jammer-JAM-WB-01-TX')).toHaveClass(/is-checked/)
  await page.getByTestId('toggle-jammer-JAM-CFG-001').click()
  await addedRow.getByRole('button', { name: '编辑' }).click()
  await page.getByTestId('jammer-platform').click()
  await page.getByRole('option', { name: '机载干扰平台（AJ-001）', exact: true }).click()
  await page.getByTestId('jammer-direction').locator('input').fill('360')
  await page.getByTestId('jammer-duration').locator('input').fill('120')
  await page.getByTestId('apply-jammer').click()

  await page.getByTestId('delete-jammer-0').click()
  await page.getByRole('button', { name: '删除', exact: true }).last().click()
  await expect(page.getByTestId('jammer-table').getByRole('row').filter({ hasText: 'JAM-WB-01-TX' })).toHaveCount(0)

  await page.getByRole('tab', { name: '节点配置' }).click()
  const platformTable = page.getByTestId('platform-table')
  await platformTable.getByRole('row').filter({ hasText: '机载干扰平台' }).getByRole('button', { name: '编辑' }).click()
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
    platformId: 'AJ-001',
    type: 'SPOT',
    defaultPower: 0,
    frequency: 0.0001,
    bandwidth: 0.0002,
    autoDetect: false,
    detectionRange: 1852,
    triggerTimeS: 300,
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
  await page.getByRole('checkbox', { name: '显示编号', exact: true }).check()
  await page.getByRole('tab', { name: '干扰设备' }).click()
  const reloadedRow = page.getByTestId('jammer-table').getByRole('row').filter({ hasText: 'JAM-CFG-001' })
  await expect(reloadedRow).toContainText('AJ-001')
  await expect(reloadedRow).toContainText('360')
  await expect(page.getByTestId('toggle-jammer-JAM-CFG-001')).toHaveClass(/is-checked/)

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P2-5 OPERATOR validates warnings and locates an invalid time step', async ({ page, request }) => {
  const audit = auditConsole(page)

  await loginAs(page, 'operator')
  const loaded = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  expect((await loaded).status()).toBe(200)

  const validate = page.getByTestId('validate-scenario')
  const warningResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${SCENARIO_PATH}/validate`)
  await validate.click()
  expect((await warningResponse).status()).toBe(200)
  const validationPanel = page.getByTestId('validation-panel')
  await expect(validationPanel).toContainText('当前雨衰值未匹配设备默认值，生成脚本前需要确认。')

  await page.getByTestId('workflow-config').click()
  const timeStep = page.getByTestId('scenario-time-step').locator('input')
  await timeStep.fill('-1')
  const errorResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${SCENARIO_PATH}/validate`)
  await validate.click()
  expect((await errorResponse).status()).toBe(200)

  const timeStepIssue = validationPanel.getByRole('button').filter({ hasText: 'scenario.timeStep' })
  await expect(timeStepIssue).toContainText('时间步长必须大于 0 秒。')
  await timeStepIssue.click()
  await expect(timeStep).toBeFocused()

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P2-6 maintains templates in system management and applies them in scenario configuration', async ({ page, request }) => {
  const audit = auditConsole(page)
  const baseline = await loadScenarioDraft(request)

  await loginAs(page, 'admin')
  await page.getByRole('link', { name: '系统管理', exact: true }).click()
  const scenarioLoaded = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  const templatesLoaded = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/v1/templates')
  await page.getByRole('menuitem', { name: '场景模板维护', exact: true }).click()
  expect((await scenarioLoaded).status()).toBe(200)
  expect((await templatesLoaded).status()).toBe(200)
  await expect(page.getByLabel('场景模板维护', { exact: true })).toBeVisible()
  await expect(page.getByTestId('template-library')).not.toContainText('应用到当前场景')

  const messageBox = page.locator('.el-message-box')
  const createdName = 'E2E 管理员模板'
  await page.getByTestId('create-template').click()
  await messageBox.locator('input').fill(createdName)
  const createdResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/templates')
  await messageBox.getByRole('button', { name: '新建', exact: true }).click()
  expect((await createdResponse).status()).toBe(201)
  await expect(page.getByTestId('template-table')).toContainText(createdName)
  await expect(page.locator('.el-message--success').filter({ hasText: createdName })).toBeVisible()
  await expect(page.getByTestId('template-feedback')).toHaveCount(0)

  const importedName = 'E2E 导入模板'
  await page.getByTestId('import-template').click()
  await messageBox.locator('textarea').fill(JSON.stringify({ name: importedName, config: baseline.config }))
  const importedResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/templates')
  await messageBox.getByRole('button', { name: '导入', exact: true }).click()
  expect((await importedResponse).status()).toBe(201)
  await expect(page.getByTestId('template-table')).toContainText(importedName)

  const detailResponse = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/v1/templates/TPL-SCN-002')
  await page.getByTestId('load-template-TPL-SCN-002').click()
  expect((await detailResponse).status()).toBe(200)
  await expect(page.getByTestId('template-detail')).toContainText('TPL-SCN-002')
  await expect(page.getByTestId('template-feedback')).toHaveCount(0)

  await page.getByTestId('update-template-TPL-SCN-002').click()
  const updatedResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
    && new URL(response.url()).pathname === '/api/v1/templates/TPL-SCN-002')
  await messageBox.getByRole('button', { name: '更新', exact: true }).click()
  expect((await updatedResponse).status()).toBe(200)
  await expect(page.getByTestId('template-table').getByRole('row').filter({ hasText: createdName })).toContainText('2')

  const exportedResponse = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/v1/templates/TPL-SCN-002')
  await page.getByTestId('export-template-TPL-SCN-002').click()
  expect((await exportedResponse).status()).toBe(200)
  await expect(messageBox).toContainText(`"name": "${createdName}"`)
  await messageBox.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(messageBox).toHaveCount(0)

  await page.getByTestId('delete-template-TPL-SCN-003').click()
  const deleteConfirmation = page.locator('.el-popconfirm').filter({ hasText: '确认删除该场景模板？' })
  await expect(deleteConfirmation).toBeVisible()
  const deletedResponse = page.waitForResponse((response) => response.request().method() === 'DELETE'
    && new URL(response.url()).pathname === '/api/v1/templates/TPL-SCN-003')
  await deleteConfirmation.getByRole('button', { name: '删除', exact: true }).click()
  expect((await deletedResponse).status()).toBe(200)
  await expect(page.getByTestId('template-table')).not.toContainText(importedName)
  await expect(page.getByTestId('latest-confirmation')).toContainText(/CONF-P2-\d{3}/)
  await expect(page.getByTestId('latest-confirmation')).toContainText('已完成')

  const adminHeaders = { Origin: UI_ORIGIN, 'X-Demo-Role': 'ADMIN' }
  const beforeReferencedDelete = await request.get(`${MOCK_ORIGIN}/api/v1/templates/TPL-SCN-001`, { headers: adminHeaders })
  expect(beforeReferencedDelete.status()).toBe(200)
  const beforeTemplate = ((await beforeReferencedDelete.json()) as ApiSuccess<ScenarioTemplate>).data
  const confirmationResponse = await request.post(`${MOCK_ORIGIN}/api/v1/confirmations`, {
    headers: adminHeaders,
    data: { action: 'OFFICIAL_TEMPLATE_DELETE', objectId: 'TPL-SCN-001' },
  })
  expect(confirmationResponse.status()).toBe(201)
  const confirmation = ((await confirmationResponse.json()) as ApiSuccess<ConfirmationContext>).data
  const confirmedResponse = await request.post(`${MOCK_ORIGIN}/api/v1/confirmations/${confirmation.confirmationId}`, {
    headers: adminHeaders,
    data: { confirm: true },
  })
  expect(confirmedResponse.status()).toBe(200)
  const referencedDelete = await request.delete(`${MOCK_ORIGIN}/api/v1/templates/TPL-SCN-001`, {
    headers: { ...adminHeaders, 'X-Confirmation-Id': confirmation.confirmationId },
  })
  expect(referencedDelete.status()).toBe(409)
  const afterReferencedDelete = await request.get(`${MOCK_ORIGIN}/api/v1/templates/TPL-SCN-001`, { headers: adminHeaders })
  expect(afterReferencedDelete.status()).toBe(200)
  expect(((await afterReferencedDelete.json()) as ApiSuccess<ScenarioTemplate>).data).toEqual(beforeTemplate)
  await expect(page.getByTestId('template-table')).toContainText('跨海通联演示官方基线')

  await page.getByTestId('logout').click()
  await page.waitForURL('**/login')
  await loginAs(page, 'operator')
  const operatorScenarioLoaded = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  expect((await operatorScenarioLoaded).status()).toBe(200)
  const operatorTemplatesLoaded = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/v1/templates')
  await page.getByTestId('open-scenario-templates').click()
  expect((await operatorTemplatesLoaded).status()).toBe(200)

  await expect(page.getByTestId('create-template')).toHaveCount(0)
  await expect(page.getByTestId('import-template')).toHaveCount(0)
  await expect(page.getByTestId('update-template-TPL-SCN-001')).toHaveCount(0)
  await expect(page.getByTestId('export-template-TPL-SCN-001')).toHaveCount(0)
  await expect(page.getByTestId('delete-template-TPL-SCN-001')).toHaveCount(0)
  await expect(page.getByTestId('load-template-TPL-SCN-001')).toBeVisible()
  await expect(page.getByTestId('copy-template-TPL-SCN-001')).toBeVisible()
  await expect(page.getByTestId('load-template-TPL-SCN-001')).toHaveText('查看详情')
  await expect(page.getByTestId('copy-template-TPL-SCN-001')).toHaveText('应用到当前场景')

  const operatorDetailResponse = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/v1/templates/TPL-SCN-001')
  await page.getByTestId('load-template-TPL-SCN-001').click()
  expect((await operatorDetailResponse).status()).toBe(200)
  await page.getByTestId('copy-template-TPL-SCN-001').click()
  await messageBox.locator('input').fill('E2E 操作员场景')
  const operatorCopyResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/templates/TPL-SCN-001/copy')
  await messageBox.getByRole('button', { name: '应用', exact: true }).click()
  expect((await operatorCopyResponse).status()).toBe(201)
  await expect(page.locator('.el-message--success').filter({ hasText: 'E2E 操作员场景' })).toBeVisible()
  await expect(page.getByTestId('template-feedback')).toHaveCount(0)

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P2-7 OPERATOR persists full data parameters and completes import, undo, and reset', async ({ page, request }) => {
  const audit = auditConsole(page)
  const baseline = await loadScenarioDraft(request)

  await loginAs(page, 'operator')
  const loaded = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  expect((await loaded).status()).toBe(200)
  await page.getByRole('tab', { name: '传感器与输出' }).click()

  await page.getByTestId('sensor-frequency-min-0').locator('input').fill('2100')
  await page.getByTestId('sensor-frequency-max-0').locator('input').fill('5200')
  await page.getByTestId('sensor-range-0').locator('input').fill('160000')
  await page.getByTestId('sensor-direction-mode-0').click()
  await page.getByRole('option', { name: '定向', exact: true }).click()
  await page.getByTestId('sensor-direction-0').locator('input').fill('90')
  await page.getByTestId('sensor-probability-0').locator('input').fill('0.88')
  await page.getByTestId('sensor-enabled-0').click()
  await page.getByTestId('output-directory').fill('./tasks/TASK-001/e2e-full')
  await page.getByTestId('output-write-interval').locator('input').fill('2')
  await page.getByTestId('output-events').click()
  await page.getByRole('tab', { name: '链路配置' }).click()
  await page.getByTestId('edit-link-0').click()
  await expect(page.getByTestId('link-dialog')).toBeVisible()
  await expect(page.getByTestId('information-demand-table')).toHaveCount(0)
  await expect(page.getByTestId('link-legacy-demand')).toHaveCount(0)
  await page.getByTestId('link-direction').click()
  await page.getByRole('option', { name: '前向', exact: true }).click()
  await page.getByTestId('demand-type').click()
  await page.getByRole('option', { name: '目标指令', exact: true }).click()
  await page.getByTestId('demand-volume-unit').click()
  await page.getByRole('option', { name: 'MB', exact: true }).click()
  await page.getByTestId('demand-volume').locator('input').fill('3')
  await page.getByTestId('demand-frequency').locator('input').fill('2')
  await expect(page.getByTestId('demand-id')).toHaveCount(0)
  await expect(page.getByTestId('demand-enabled')).toHaveCount(0)
  await expect(page.getByTestId('demand-priority')).toHaveCount(0)
  await page.getByTestId('demand-latency').locator('input').fill('250')
  await page.getByTestId('demand-rate').locator('input').fill('6')
  await page.getByTestId('apply-link').click()
  await expect(page.getByTestId('link-dialog')).toHaveCount(0)

  const savedResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.getByTestId('save-scenario').click()
  expect((await savedResponse).status()).toBe(200)

  const reloadedResponse = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.reload()
  expect((await reloadedResponse).status()).toBe(200)
  await page.getByRole('tab', { name: '传感器与输出' }).click()
  await expect(page.getByTestId('sensor-frequency-min-0').locator('input')).toHaveValue('2100')
  await expect(page.getByTestId('sensor-direction-mode-0')).toContainText('定向')
  await expect(page.getByTestId('sensor-direction-0').locator('input')).toHaveValue('90')
  await expect(page.getByTestId('output-directory')).toHaveValue('./tasks/TASK-001/e2e-full')
  await expect(page.getByTestId('output-write-interval').locator('input')).toHaveValue('2')
  await page.getByRole('tab', { name: '链路配置' }).click()
  await page.getByTestId('edit-link-0').click()
  await expect(page.getByTestId('demand-type')).toContainText('目标指令')
  await expect(page.getByTestId('demand-volume').locator('input')).toHaveValue('3')
  await expect(page.getByTestId('demand-volume-unit')).toContainText('MB')
  await page.getByTestId('cancel-link').click()

  const persisted = await loadScenarioDraft(request)
  expect(persisted.config.sensors[0]).toMatchObject({ frequencyRange: { min: 2100, max: 5200 }, detectionRange: 160000 })
  expect(persisted.uiExtensions.sensors[0]).toMatchObject({ direction: 90, probability: 0.88, enabled: false })
  expect(persisted.config.output).toEqual({
    directory: './tasks/TASK-001/e2e-full',
    writeInterval: 2,
    linkQualityEnabled: true,
    eventsEnabled: false,
    linkSwitchEnabled: true,
  })
  expect(persisted.config.informationDemand.find(item => item.linkId === baseline.config.links[0]!.id)).toMatchObject({
    informationType: '目标指令', direction: 'FORWARD', volumeMb: 3, frequencyHz: 2, priority: 'NORMAL', maxLatencyMs: 250, minDataRateMbps: 6,
  })

  await page.getByTestId('open-scenario-operations').click()
  const importedConfig = structuredClone(persisted.config)
  importedConfig.output.directory = './tasks/TASK-001/e2e-import'
  await page.getByTestId('import-scenario-snapshot').click()
  const messageBox = page.locator('.el-message-box')
  await messageBox.locator('textarea').fill(JSON.stringify(importedConfig))
  const importedResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/scenarios/import')
  await messageBox.getByRole('button', { name: '导入场景', exact: true }).click()
  expect((await importedResponse).status()).toBe(200)
  await expect(page.getByTestId('scenario-json-preview')).toContainText('./tasks/TASK-001/e2e-import')

  await page.getByTestId('undo-scenario').click()
  const undoneResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${SCENARIO_PATH}/undo`)
  await page.locator('.el-message-box').getByRole('button', { name: '撤销', exact: true }).click()
  expect((await undoneResponse).status()).toBe(200)
  await expect(page.getByTestId('scenario-json-preview')).toContainText('./tasks/TASK-001/e2e-full')

  await page.getByTestId('reset-scenario').click()
  const resetResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${SCENARIO_PATH}/reset`)
  await page.locator('.el-message-box').getByRole('button', { name: '重置场景', exact: true }).click()
  expect((await resetResponse).status()).toBe(200)
  await expect(page.getByTestId('scenario-json-preview')).toContainText(baseline.config.output.directory)

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P2-8 OPERATOR blocks errors, confirms warnings, previews, and locates preflight issues', async ({ page, request }) => {
  const audit = auditConsole(page)
  await loginAs(page, 'operator')
  const loaded = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  expect((await loaded).status()).toBe(200)

  await page.getByTestId('scenario-time-step').locator('input').fill('6')
  await page.getByTestId('save-scenario').click()
  await expect(page.getByTestId('validation-panel')).toBeVisible()
  await page.getByTestId('validation-panel').getByRole('button').filter({ hasText: 'output.writeInterval' }).click()
  await expect(page.getByLabel('输出参数').getByText('输出写入间隔不能小于场景时间步长。', { exact: true })).toBeVisible()
  await expect(page.getByTestId('workflow-script')).toBeDisabled()
  await expect(page.getByTestId('script-preview-panel')).toHaveCount(0)

  const restored = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.reload()
  expect((await restored).status()).toBe(200)
  await expect(page.getByRole('tab')).toHaveCount(5)
  await expect(page.getByTestId('scenario-next-step')).toContainText('当前草稿已保存')
  await expect(page.getByTestId('next-script')).toHaveCount(0)
  await expect(page.getByTestId('workflow-script')).toBeDisabled()
  await page.getByTestId('next-validation').click()
  await expect(page.getByTestId('next-script')).toBeDisabled()
  await expect(page.getByTestId('save-scenario')).toBeDisabled()
  const validationFinished = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${SCENARIO_PATH}/validate`)
  await page.getByTestId('validate-scenario').click()
  expect((await validationFinished).status()).toBe(200)
  await expect(page.getByTestId('next-script')).toBeEnabled()
  await page.getByTestId('next-script').click()

  const confirmationRequired = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/scripts/preview'
    && response.status() === 428)
  await page.getByTestId('generate-script').click()
  expect((await confirmationRequired).status()).toBe(428)
  const messageBox = page.locator('.el-message-box')
  await expect(messageBox).toContainText('场景存在校验警告，生成脚本前需要一次性确认。')

  const previewReady = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/scripts/preview'
    && response.status() === 200)
  await messageBox.getByRole('button', { name: '本次继续', exact: true }).click()
  expect((await previewReady).status()).toBe(200)
  await expect(page.getByTestId('script-preview')).toContainText('# AFSIM 2.9.0 场景脚本预览；仅内存生成')
  await expect(page.getByTestId('script-next-step')).toContainText('点击“执行预检”')

  let upstreamPreflightPassed = false
  await page.route('**/api/v1/scripts/*/preflight', async (route) => {
    const response = await route.fetch()
    const payload = await response.json() as ApiSuccess<{ valid: boolean; errors: unknown[]; warnings: unknown[] }>
    upstreamPreflightPassed = response.status() === 200 && payload.data.valid
    await route.fulfill({
      response,
      json: {
        ...payload,
        data: {
          valid: false,
          errors: [{ severity: 'ERROR', code: 'SCRIPT_VERSION_INVALID', message: '第 2 行，第 1 列：版本错误。', fieldPath: 'preview[2:1]' }],
          warnings: [],
        },
      },
    })
  })
  await page.getByTestId('preflight-script').click()
  await expect(page.getByTestId('preflight-issues')).toContainText('SCRIPT_VERSION_INVALID')
  await expect(page.getByTestId('preflight-issues')).toContainText('2:1')
  expect(upstreamPreflightPassed).toBe(true)

  await page.unroute('**/api/v1/scripts/*/preflight')
  await page.getByTestId('preflight-script').click()
  await expect(page.getByTestId('scenario-next-step')).toContainText('本页流程已完成')
  await expect(page.getByTestId('script-next-step')).toContainText('不会写入本地文件或启动真实 AFSIM')
  await page.screenshot({ path: test.info().outputPath('scenario-workflow-preflight.png') })
  await page.getByTestId('workflow-config').click()
  await page.getByTestId('scenario-name').fill('流程回归：修改后重新生成')
  await expect(page.getByTestId('scenario-next-step')).toContainText('未保存修改')
  await expect(page.getByTestId('workflow-script')).toBeDisabled()
  await expect(page.getByTestId('script-preview')).toHaveCount(0)
  await page.getByTestId('next-validation').click()
  await expect(page.getByTestId('next-script')).toBeDisabled()

  expect(audit.errors).toEqual([
    'Failed to load resource: the server responded with a status of 428 (Precondition Required)',
  ])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P3-1/P3-2 OPERATOR controls a run and reads one realtime telemetry frame', async ({ page, request }) => {
  const audit = auditConsole(page)
  const runLoaded = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/v1/simulations')
  const waitForCommand = (command: string) => page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/simulations/RUN-001/commands'
    && response.request().postDataJSON().command === command)

  await loginAs(page, 'operator')
  expect((await runLoaded).status()).toBe(200)
  const toolbar = page.getByLabel('仿真控制', { exact: true })
  await expect(toolbar.getByTestId('simulation-feedback')).toContainText('场景配置未锁定')
  await expect(toolbar.getByTestId('engine-resource')).toContainText('模拟进程资源已释放')
  const footer = page.locator('.situation-footer')
  await expect(footer).toContainText('实时已订阅')
  await expect(footer).not.toContainText('固定帧')
  await expect(footer).not.toContainText('数据时刻')
  await expect(footer).toHaveAttribute('data-frame-id', 'F-00042')
  const telemetryPanel = page.getByLabel('链路、干扰与事件', { exact: true })
  await expect(telemetryPanel).toContainText('DET-042 · F-00042')
  await expect(telemetryPanel).toContainText('SW-003 · F-00042')
  const degradedLink = telemetryPanel.locator('tr[data-link-id="L-DL-03"]')
  await expect(degradedLink).toContainText('7.10')
  await expect(degradedLink).toContainText('2.4e-4')
  await expect(page.getByLabel('当前帧指标').locator('select')).toHaveCount(0)
  await expect(telemetryPanel.locator('tr[data-link-id]')).toHaveCount(10)
  await expect(page.getByLabel('当前帧指标').locator('.metric-panel__item span')).toHaveText([
    '在线业务信息节点', '正常链路', '劣化链路', '中断链路',
  ])
  await expect(page.getByLabel('当前帧指标')).toContainText('劣化链路1')
  await degradedLink.click()
  const linkDialog = page.locator('.link-quality-dialog')
  await expect(linkDialog.locator('[data-frame-id="F-00042"]')).toBeVisible()
  await expect(linkDialog).toContainText('信噪比 SNR7.10 dB')
  await expect(linkDialog).toContainText('误码率 BER2.4e-4')
  await linkDialog.locator('.el-dialog__headerbtn').click()
  await expect(linkDialog).not.toBeVisible()

  const remotePage = await page.context().newPage()
  const remoteAudit = auditConsole(remotePage)
  const remoteRunLoaded = remotePage.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/v1/simulations')
  const waitForRemoteCommand = (command: string) => remotePage.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/simulations/RUN-001/commands'
    && response.request().postDataJSON().command === command)
  await loginAs(remotePage, 'operator')
  expect((await remoteRunLoaded).status()).toBe(200)
  const remoteToolbar = remotePage.getByLabel('仿真控制', { exact: true })
  const remoteCreated = remotePage.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/simulations')
  const remoteStarted = waitForRemoteCommand('START')
  await remoteToolbar.getByTestId('simulation-start').click()
  expect((await remoteCreated).status()).toBe(201)
  expect((await remoteStarted).status()).toBe(200)
  await expect(toolbar.getByText('运行中', { exact: true })).toBeVisible()
  await expect(toolbar.getByTestId('simulation-feedback')).toContainText('场景配置已锁定')
  expect((await loadScenarioDraft(request)).locked).toBe(true)

  await remoteToolbar.getByTestId('simulation-stop').click()
  const remoteStopDialog = remotePage.getByRole('dialog', { name: '确认停止仿真' })
  const remoteStopped = waitForRemoteCommand('STOP')
  await remoteStopDialog.getByTestId('confirm-stop').click()
  expect((await remoteStopped).status()).toBe(200)
  await expect(toolbar.getByText('已停止', { exact: true })).toBeVisible()
  await expect(toolbar.getByTestId('simulation-feedback')).toContainText('场景配置未锁定')
  expect((await loadScenarioDraft(request)).locked).toBe(false)
  expect(remoteAudit.errors).toEqual([])
  expect(remoteAudit.http404s).toEqual([])
  expect([...remoteAudit.nonLoopbackHosts]).toEqual([])
  await remotePage.close()

  const created = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/simulations')
  const started = waitForCommand('START')
  await toolbar.getByTestId('simulation-start').click()
  expect((await created).status()).toBe(201)
  expect((await started).status()).toBe(200)
  await expect(toolbar.getByText('运行中', { exact: true })).toBeVisible()
  await expect(toolbar.getByTestId('simulation-feedback')).toContainText('场景配置已锁定 · 仿真已开始。')
  await expect(toolbar.getByTestId('engine-resource')).toContainText('模拟进程 2900')
  expect((await loadScenarioDraft(request)).locked).toBe(true)

  const paused = waitForCommand('PAUSE')
  await toolbar.getByTestId('simulation-pause').click()
  expect((await paused).status()).toBe(200)
  await expect(toolbar.getByText('已暂停', { exact: true })).toBeVisible()

  const stepped = waitForCommand('STEP')
  await toolbar.getByTestId('simulation-step').click()
  expect((await stepped).status()).toBe(200)
  await expect(toolbar.getByTestId('simulation-clock')).toHaveText('T+ 00:00:01')

  await toolbar.getByTestId('simulation-stop').click()
  const stopDialog = page.getByRole('dialog', { name: '确认停止仿真' })
  await expect(stopDialog).toBeVisible()
  const confirmationCreated = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/confirmations')
  const confirmationAccepted = page.waitForResponse((response) => response.request().method() === 'POST'
    && /^\/api\/v1\/confirmations\/[^/]+$/.test(new URL(response.url()).pathname))
  const stopped = waitForCommand('STOP')
  await stopDialog.getByTestId('confirm-stop').click()
  expect((await confirmationCreated).status()).toBe(201)
  expect((await confirmationAccepted).status()).toBe(200)
  expect((await stopped).status()).toBe(200)
  await expect(stopDialog).toHaveCount(0)
  await expect(toolbar.getByText('已停止', { exact: true })).toBeVisible()
  await expect(toolbar.getByTestId('simulation-feedback')).toContainText('场景配置未锁定 · 仿真已停止，场景配置已解锁。')
  await expect(toolbar.getByTestId('engine-resource')).toContainText('模拟进程资源已释放')
  expect((await loadScenarioDraft(request)).locked).toBe(false)

  const scenarioLoaded = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === SCENARIO_PATH)
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  expect((await scenarioLoaded).status()).toBe(200)
  await expect(page.getByTestId('scenario-name')).toBeEnabled()

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

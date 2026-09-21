import { expect, test } from '@playwright/test'

// 真实监测器只读取本用例临时数据库；不连接正式账号库或占用 4173。
const { tsImport } = await import('tsx/esm/' + 'api')
const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/' + 'promises')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { once } = await import('node:' + 'events')
const { DatabaseSync } = await import('node:' + 'sqlite')
const { createMockServer } = await tsImport('../../server/app.ts', import.meta.url)
const { LocalExchangeMonitor } = await tsImport('../../server/local/exchange-monitor.ts', import.meta.url)

test('系统状态读取真实监测、最近文件记录、故障及恢复，离页停止刷新', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-health-browser-'))
  const databasePath = join(directory, 'main.db')
  const db = new DatabaseSync(databasePath)
  for (const table of ['scenarios', 'scenario_templates', 'users', 'audit_logs']) db.exec(`CREATE TABLE ${table}(id TEXT)`)
  const monitor = new LocalExchangeMonitor(databasePath)
  const server = createMockServer({ port: 0, loadExchangeMonitor: () => monitor.snapshot() })
  let monitorRequests = 0
  const errors: string[] = []
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    await page.route('**/api/v1/**', async route => {
      const source = new URL(route.request().url())
      if (source.pathname === '/api/v1/data-exchange/monitor') monitorRequests++
      const response = await route.fetch({ url: `${origin}${source.pathname}${source.search}`, headers: { ...route.request().headers(), origin: 'http://127.0.0.1:5173' } })
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(page.url()).origin } })
    })
    await page.routeWebSocket('**/ws/v1', () => {})
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    const file = join(directory, 'positions.csv')
    await writeFile(file, 'real temporary record')
    await monitor.read('POSITIONS', file, () => readFile(file, 'utf8'), () => ({ recordCount: 1, issueCount: 0 }))
    await page.goto('/login')
    await page.getByTestId('login-username').fill('admin')
    await page.getByTestId('login-password').fill('123456')
    await page.getByTestId('login-submit').click()
    await page.waitForURL('**/situation')
    await page.goto('/admin?section=runtime-status')
    const table = page.getByTestId('health-table')
    const row = (name: string) => table.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) })
    await expect(row('主数据库')).toContainText('检查通过')
    await expect(row('最近位置读取')).toContainText('positions.csv')
    await expect(row('仿真引擎')).toContainText('暂无数据')
    await expect(row('装备／角色权限／归档数据库')).toContainText('暂无数据')
    await expect(page.getByTestId('health-observed-at')).toContainText('每 5 秒刷新')
    const count = monitorRequests
    await expect.poll(() => monitorRequests, { timeout: 8000 }).toBeGreaterThan(count)
    db.exec('DROP TABLE users')
    await rm(file)
    await expect(monitor.read('POSITIONS', file, () => readFile(file, 'utf8'), () => ({ recordCount: 1, issueCount: 0 }))).rejects.toThrow()
    await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await expect(row('主数据库')).toContainText('异常')
    await expect(row('最近位置读取')).toContainText('LOCAL_READ_FAILED')
    await expect(page.getByTestId('health-feedback')).toContainText('SQLite 检查失败')
    await page.locator('.el-select').filter({ has: page.getByRole('combobox', { name: '运行状态筛选' }) }).click()
    await page.getByRole('option', { name: '异常／读取失败', exact: true }).click()
    await expect(table.locator('.el-table__row')).toHaveCount(2)
    db.exec('CREATE TABLE users(id TEXT)')
    await writeFile(file, 'recovered')
    await monitor.read('POSITIONS', file, () => readFile(file, 'utf8'), () => ({ recordCount: 1, issueCount: 0 }))
    await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await expect(table).toContainText('暂无匹配组件')
    await expect(page.getByTestId('health-feedback')).toHaveCount(0)
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '场景配置', exact: true }).click()
    await expect(page).toHaveURL(/\/scenarios$/)
    const afterLeaving = monitorRequests
    // 跨过完整轮询周期，证明离页清理；不是用等待掩盖请求竞态。
    await page.waitForTimeout(5500)
    expect(monitorRequests).toBe(afterLeaving)
    expect(errors).toEqual([])
  } finally {
    await page.close()
    await server.close()
    monitor.close()
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})

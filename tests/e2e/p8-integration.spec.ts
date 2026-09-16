import { expect, test } from '@playwright/test'

const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }

test('P8 全局重置、目录定位与十一条路由双视口验收', async ({ page, request }, testInfo) => {
  /** 保存实际截图文件并挂入机器报告，便于逐页复核。 */
  async function screenshot(name: string): Promise<void> {
    const path = testInfo.outputPath(`${name}.png`)
    await page.screenshot({ path })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  const errors: string[] = []
  const requests: string[] = []
  const failures: string[] = []
  const sockets: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('request', (request) => requests.push(request.url()))
  page.on('response', (response) => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`) })
  page.on('websocket', (socket) => sockets.push(socket.url()))
  await request.post('http://127.0.0.1:4173/api/v1/reset', { headers, data: { confirm: true } })
  await page.goto('/login')
  await screenshot('login')
  await page.getByTestId('login-username').fill('admin')
  await page.getByTestId('login-password').fill('123456')
  await page.getByTestId('login-submit').click()
  await page.waitForURL('**/situation')

  for (const path of ['/situation', '/scenarios', '/batches', '/reports', '/replays', '/admin', '/blueprint', '/admin/data-exchange', '/traceability', '/interactions']) {
    await page.goto(path)
    await expect(page.locator('.app-shell')).toBeVisible()
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible()
    // 等待实际页面数据而非固定休眠；已有分阶段 E2E 继续承担每页完整业务操作。
    if (path === '/blueprint') {
      await expect(page.getByTestId('capability-card')).toHaveCount(29)
      await expect(page.getByTestId('interface-anchor')).toHaveCount(7)
      await expect(page.getByTestId('decision-table').locator('.el-table__row')).toHaveCount(8)
    } else if (path === '/traceability') {
      await expect(page.getByTestId('traceability-table').locator('.el-table__row')).toHaveCount(36)
    } else if (path === '/admin/data-exchange') {
      await page.getByTestId('open-exchange-tools').click()
      await expect(page.getByTestId('interface-contract-table').locator('.interface-item')).toHaveCount(7)
      await page.getByRole('dialog', { name: '接口工具' }).getByRole('button', { name: '关闭此对话框' }).click()
    } else if (path === '/batches') {
      await expect(page.getByTestId('batch-run-table').locator('.el-table__row')).toHaveCount(12)
    } else if (path === '/situation') {
      await expect(page.locator('.offline-map')).toBeVisible()
    } else if (path === '/scenarios') {
      await expect(page.getByTestId('scene-list')).toBeVisible()
      await expect(page.getByTestId('scene-edit-SCN-001')).toBeVisible()
      await expect(page.getByTestId('scenario-id')).toHaveCount(0)
    } else if (path === '/reports') {
      await expect(page.getByTestId('report-tabs')).toHaveAttribute('data-report-id', 'RPT-001')
    } else if (path === '/replays') {
      await expect(page.getByText('暂无本地回放数据，请配置数据文件后重新加载。', { exact: true })).toBeVisible()
      await expect(page.getByTestId('replay-timeline')).toHaveCount(0)
    } else if (path === '/admin') {
      await expect(page.getByTestId('user-role-panel')).toBeVisible()
    }
    const navigation = page.getByRole('navigation', { name: '主导航' })
    const box = await navigation.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(testInfo.project.use.viewport!.width)
    await screenshot(path.slice(1).replaceAll('/', '-'))
  }

  await page.getByTestId('reset-all').click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(requests.filter((url) => url.endsWith('/api/v1/reset'))).toHaveLength(0)
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.getByTestId('reset-all').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const confirm = dialog.getByRole('button', { name: '确认重置', exact: true })
    await confirm.focus(); await page.keyboard.press('Enter')
    await expect(page.getByTestId('reset-feedback')).toContainText('模拟数据已恢复基线', { timeout: 15_000 })
    expect(requests.filter((url) => url.endsWith('/api/v1/reset'))).toHaveLength(cycle + 1)
  }
  await page.getByText('状态示例与错误目录', { exact: true }).click()
  await expect(page.getByTestId('error-catalog').locator('.el-table__row')).toHaveCount(30)
  await page.getByRole('radio', { name: '失败', exact: true }).focus()
  await page.keyboard.press('Space')
  await expect(page.getByText('状态示例：失败', { exact: true })).toBeVisible()

  await page.goto('/traceability')
  await expect(page.getByTestId('traceability-table').locator('.el-table__row')).toHaveCount(36)
  await page.getByRole('textbox', { name: '筛选需求或接口' }).fill('参数校验')
  await expect(page.getByTestId('traceability-table').locator('.el-table__row')).toHaveCount(1)
  await page.getByRole('link', { name: '查看说明', exact: true }).click()
  await page.waitForURL('**/blueprint#cap-csjy')
  await expect(page.locator('#cap-csjy')).toBeInViewport()
  await page.locator('#cap-csjy').getByRole('link', { name: '进入功能' }).click()
  await page.waitForURL('**/scenarios')
  expect(errors).toEqual([])
  expect(failures).toEqual([])
  expect([...requests, ...sockets].filter((url) => !url.startsWith('data:') && new URL(url).hostname !== '127.0.0.1')).toEqual([])
  await testInfo.attach('network-audit', { body: JSON.stringify({ errors, failures, requests, sockets }, null, 2), contentType: 'application/json' })
})

test('P8 重置失败清空业务面板并允许从头重试', async ({ page }) => {
  await page.goto('/login')
  await page.getByTestId('login-username').fill('operator')
  await page.getByTestId('login-password').fill('123456')
  await page.getByTestId('login-submit').click()
  await page.waitForURL('**/situation')
  await page.goto('/interactions')
  // 使用成功 HTTP 中的损坏业务载荷验证 fail-closed，不产生预期外控制台资源错误。
  await page.route('**/api/v1/reset', (route) => route.fulfill({ json: { ok: true, data: { nextSequence: 2 } } }))
  await page.getByTestId('reset-all').click()
  await page.getByRole('button', { name: '确认重置', exact: true }).click()
  await expect(page.getByTestId('reset-feedback')).toContainText('已清空全部业务投影')
  await expect(page.locator('.interactions-page__evidence')).toHaveCount(0)
  await page.unroute('**/api/v1/reset')
  await page.getByRole('button', { name: '重试重置', exact: true }).click()
  await page.getByRole('button', { name: '确认重置', exact: true }).click()
  await expect(page.getByTestId('reset-feedback')).toContainText('模拟数据已恢复基线')
  await page.route('**/api/v1/auth/permissions', (route) => route.fulfill({ json: { ok: true, data: {} } }))
  await page.getByTestId('reset-all').click()
  await page.getByRole('button', { name: '确认重置', exact: true }).click()
  await expect(page.getByTestId('reset-feedback')).toContainText('权限失败')
  await expect(page.locator('.interactions-page__evidence')).toHaveCount(0)
  await expect(page.getByRole('link', { name: '身份已失效，请重新登录' })).toBeVisible()
  await expect(page.getByTestId('reset-all')).toBeDisabled()
})

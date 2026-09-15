import { expect, test } from '@playwright/test'

test('所选场景刷新和跨页返回保留抽屉，恢复失败仍重试原编号，退出清理选择', async ({ page, request, baseURL }) => {
  const mockOrigin = test.info().config.metadata.mockOrigin ?? 'http://127.0.0.1:4173'
  const headers = { Origin: baseURL!, 'X-Demo-Role': 'ADMIN' }
  const session = await request.get(`${mockOrigin}/api/v1/auth/session`, { headers })
  expect(session.headers()['x-auth-mode']).toBe('mock')
  const uiProxyOrigin = test.info().config.metadata.uiProxyOrigin
  if (uiProxyOrigin) {
    await page.route(`${baseURL}/**`, async route => {
      const url = route.request().url().replace(baseURL!, uiProxyOrigin)
      await route.fulfill({ response: await route.fetch({ url }) })
    })
  }
  expect((await request.post(`${mockOrigin}/api/v1/reset`, { headers, data: { confirm: true } })).ok()).toBe(true)
  const response = await request.get(`${mockOrigin}/api/v1/scenarios/SCN-001`, { headers })
  expect(response.ok()).toBe(true)
  const draft = (await response.json()).data
  draft.config.scenario.id = 'SCN-REFRESH'
  draft.config.scenario.name = '刷新恢复回归场景'
  for (const platform of draft.config.platforms) {
    if (platform.type === 'COMMUNICATION_SATELLITE') platform.satelliteType = 'TIANTONG'
  }
  expect((await request.post(`${mockOrigin}/api/v1/scenarios`, { headers,
    data: { config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: 0 },
  })).status()).toBe(201)

  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto('/login')
  await page.getByTestId('login-username').fill('operator')
  await page.getByTestId('login-password').fill('123456')
  await page.getByTestId('login-submit').click()
  await page.waitForURL('**/situation')
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  await page.getByTestId('scene-select-SCN-REFRESH').click()
  await page.waitForURL('**/situation')

  const panel = page.locator('.telemetry-panel')
  const verifyScene = async () => {
    await expect(page.getByTestId('saved-scene-preview')).toBeVisible()
    await expect(panel).toBeVisible()
    await expect(panel.locator('tr[data-link-id]')).toHaveCount(draft.config.links.length)
    await expect(panel.getByText('全链路状态', { exact: true })).toBeVisible()
    await expect(panel.getByText('干扰 / 侦测设备', { exact: true })).toBeVisible()
    await expect(panel.getByText('同帧事件', { exact: true })).toBeVisible()
    await expect(page.getByTestId(`focus-node-${draft.config.platforms[0].id}`)).toBeVisible()
    await expect(panel.locator('tr[data-link-id="L-MW-01"] td').nth(4)).toHaveText('暂无数据')
  }
  await verifyScene()
  await page.reload()
  await verifyScene()
  await page.getByTestId('toggle-telemetry-panel').click()
  await expect(panel).toHaveAttribute('data-collapsed', 'true')
  await page.getByTestId('toggle-telemetry-panel').click()
  await expect(panel).toHaveAttribute('data-collapsed', 'false')
  await panel.locator('tr[data-link-id="L-MW-01"]').click()
  await expect(page.getByTestId('link-detail-configured')).toContainText('规范状态暂无数据')
  await page.locator('.link-quality-dialog .el-dialog__headerbtn').click()
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  await page.getByRole('link', { name: '态势主界面', exact: true }).click()
  await verifyScene()
  await page.reload()
  await verifyScene()
  await page.getByTestId('simulation-start').click()
  await expect(page.getByTestId('simulation-pause')).toBeEnabled()
  await page.reload()
  await verifyScene()
  await expect(page.getByTestId('simulation-pause')).toBeEnabled()
  await page.getByTestId('simulation-pause').click()
  await expect(page.getByTestId('simulation-step')).toBeEnabled()
  await page.getByTestId('simulation-stop').click()
  await page.getByTestId('confirm-stop').click()
  await expect(page.getByTestId('simulation-start')).toBeEnabled()
  await page.reload()
  await verifyScene()

  // 用损坏的成功响应覆盖恢复失败，不引入额外 HTTP 资源错误，也不修改 Store。
  const sceneUrl = `${mockOrigin}/api/v1/scenarios/SCN-REFRESH`
  let retries = 0
  await page.route(sceneUrl, async route => {
    retries += 1
    await route.fulfill({ json: { ok: true, data: {} } })
  })
  await page.reload()
  await expect(page.locator('.telemetry-empty')).toContainText('场景 SCN-REFRESH 加载失败')
  await expect(panel).toHaveCount(0)
  await page.getByRole('button', { name: '重新加载', exact: true }).click()
  await expect.poll(() => retries).toBe(2)
  await expect(page.locator('.telemetry-empty')).toContainText('场景 SCN-REFRESH 加载失败')
  await page.unroute(sceneUrl)
  await page.getByRole('button', { name: '重新加载', exact: true }).click()
  await verifyScene()

  await page.getByTestId('logout').click()
  await page.waitForURL('**/login')
  expect(await page.evaluate(() => sessionStorage.getItem('wrj.simulation.selectedScene'))).toBeNull()
  expect(errors).toEqual([])
})

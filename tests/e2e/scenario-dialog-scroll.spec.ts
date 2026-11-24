import { expect, test, type Page } from '@playwright/test'

const { tsImport } = await import('tsx/esm/' + 'api')
const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { once } = await import('node:' + 'events')
const { createMockServer } = await tsImport('../../server/app.ts', import.meta.url)
const { ScenarioSqliteStorage } = await tsImport('../../server/local/scenario-sqlite.ts', import.meta.url)
const { ScenarioProjection } = await tsImport('../../server/scenarios/projection.ts', import.meta.url)

async function routeApi(page: Page, origin: string): Promise<void> {
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`, headers: { ...route.request().headers(), origin: 'http://127.0.0.1:5173' } })
    await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(page.url()).origin } })
  })
  await page.routeWebSocket('**/ws/v1*', () => {})
}

async function login(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByTestId('login-username').fill('operator')
  await page.getByTestId('login-password').fill('123456')
  await page.getByTestId('login-submit').click()
  await page.waitForURL('**/situation')
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  await page.getByTestId('scene-edit-SCN-001').click()
  await page.getByRole('tab', { name: '节点配置', exact: true }).click()
}

async function assertDialogFits(page: Page, selector: string): Promise<void> {
  await expect(page.locator(selector)).toBeVisible()
  const fits = await page.locator(selector).evaluate(dialog => {
    const rect = dialog.getBoundingClientRect()
    const body = dialog.querySelector<HTMLElement>('.el-dialog__body')
    const header = dialog.querySelector<HTMLElement>('.el-dialog__header')
    const footer = dialog.querySelector<HTMLElement>('.el-dialog__footer')
    const overlay = dialog.closest('.el-overlay-dialog')!
    return {
      bodyOverflow: body ? getComputedStyle(body).overflowY : '',
      overlayFits: overlay.scrollHeight <= overlay.clientHeight && overlay.scrollWidth <= overlay.clientWidth,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      headerTop: header?.getBoundingClientRect().top,
      footerBottom: footer?.getBoundingClientRect().bottom,
    }
  })
  expect(fits.top).toBeGreaterThanOrEqual(0)
  expect(fits.bottom).toBeLessThanOrEqual(fits.viewportHeight)
  expect(fits.left).toBeGreaterThanOrEqual(0)
  expect(fits.right).toBeLessThanOrEqual(fits.viewportWidth)
  expect(fits.headerTop).toBeGreaterThanOrEqual(fits.top)
  expect(fits.footerBottom).toBeLessThanOrEqual(fits.bottom)
  expect(fits.overlayFits).toBe(true)
  expect(fits.bodyOverflow).toMatch(/auto|scroll/)
}

async function addRoutePoints(page: Page, list: 'waypoint' | 'loiter-waypoint', count: number): Promise<void> {
  await page.getByTestId(`add-${list}`).click()
  const map = page.getByTestId('waypoint-map')
  await expect(map).toHaveClass(/leaflet-container/)
  const box = await map.boundingBox()
  if (!box) throw new Error('航点地图未显示')
  const confirm = page.getByTestId('confirm-waypoint-batch')
  for (let index = 0; index < count; index += 1) {
    if (index === 0) await map.press('Enter')
    else await map.click({ position: {
      x: Math.round(box.width / 2 + (index % 4) * 30),
      y: Math.round(box.height / 2 + Math.floor(index / 4) * 30),
    } })
    await expect(page.getByTestId('waypoint-batch-status')).toContainText(`本次已选 ${index + 1} 个点`)
    if (list === 'loiter-waypoint' && index === 0) await expect(confirm).toBeDisabled()
  }
  await expect(map.locator('.waypoint-map-dialog__number--added')).toHaveCount(count)
  await assertDialogFits(page, '.waypoint-map-dialog.el-dialog')
  await confirm.click()
  await expect(page.getByTestId('waypoint-map-dialog')).toBeHidden()
}

test('场景配置长表单只在弹框内部滚动，头尾操作保持可见', async ({ page }, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-scenario-dialog-scroll-'))
  const scenes = new ScenarioSqliteStorage(join(directory, 'scenarios.db'))
  const baseline = new ScenarioProjection().get('SCN-001')
  if (!baseline.ok) throw new Error('缺少测试基准场景')
  scenes.save(baseline.data, undefined)
  const server = createMockServer({ port: 0, scenarioStorage: scenes })
  const errors: string[] = []
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const address = server.httpServer.address()
    if (!address || typeof address === 'string') throw new Error('场景测试 Mock 未暴露 TCP 端口')
    await routeApi(page, `http://127.0.0.1:${address.port}`)
    page.on('pageerror', error => errors.push(error.message))
    await login(page)

    // AIR-01 同时支持普通、盘旋航点及返航路线，全部经由公开编辑动作添加。
    await page.getByTestId('edit-platform-3').click()
    const platformDialog = '.platform-editor-dialog.el-dialog'
    const longitude = page.getByTestId('waypoint-longitude-0').locator('input')
    const altitude = page.getByTestId('waypoint-altitude-0').locator('input')
    const originalLongitude = await longitude.inputValue()
    const originalAltitude = await altitude.inputValue()
    await page.getByTestId('add-waypoint').click()
    const existingPoint = page.getByTitle('拖动第 1 个航点', { exact: true })
    await existingPoint.click()
    const status = page.getByTestId('waypoint-batch-status')
    await expect(status).toContainText('本次已选 0 个点')
    const marker = await existingPoint.boundingBox()
    if (!marker) throw new Error('已有航点标记未显示')
    const x = marker.x + marker.width / 2
    const y = marker.y + marker.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 30, y, { steps: 5 })
    await page.mouse.up()
    await expect(status).toContainText('已移动 1 个已有点')
    await expect(status).toContainText('本次已选 0 个点')
    await expect(longitude).toHaveValue(originalLongitude)
    await page.getByTestId('confirm-waypoint-batch').click()
    await expect(longitude).not.toHaveValue(originalLongitude)
    await expect(altitude).toHaveValue(originalAltitude)
    await expect(page.getByTestId('waypoint-map-dialog')).toBeHidden()

    await addRoutePoints(page, 'waypoint', 8)
    await addRoutePoints(page, 'loiter-waypoint', 6)
    await page.getByTestId('return-enabled').click()
    for (let index = 0; index < 6; index += 1) await page.getByTestId('add-return-waypoint').click()
    await expect(page.getByTestId('return-table')).toBeVisible()
    await assertDialogFits(page, platformDialog)

    const beforeScroll = await page.locator(platformDialog).evaluate(dialog => ({
      headerTop: dialog.querySelector('.el-dialog__header')!.getBoundingClientRect().top,
      footerBottom: dialog.querySelector('.el-dialog__footer')!.getBoundingClientRect().bottom,
      scrollTop: dialog.querySelector<HTMLElement>('.el-dialog__body')!.scrollTop,
      scrollHeight: dialog.querySelector<HTMLElement>('.el-dialog__body')!.scrollHeight,
      clientHeight: dialog.querySelector<HTMLElement>('.el-dialog__body')!.clientHeight,
    }))
    expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.clientHeight)
    await page.locator(`${platformDialog} .el-dialog__body`).evaluate(body => { body.scrollTop = body.scrollHeight })
    const afterScroll = await page.locator(platformDialog).evaluate(dialog => ({
      headerTop: dialog.querySelector('.el-dialog__header')!.getBoundingClientRect().top,
      footerBottom: dialog.querySelector('.el-dialog__footer')!.getBoundingClientRect().bottom,
      scrollTop: dialog.querySelector<HTMLElement>('.el-dialog__body')!.scrollTop,
    }))
    expect(afterScroll.scrollTop).toBeGreaterThan(beforeScroll.scrollTop)
    expect(afterScroll.headerTop).toBeCloseTo(beforeScroll.headerTop, 0)
    expect(afterScroll.footerBottom).toBeCloseTo(beforeScroll.footerBottom, 0)
    await page.screenshot({ path: testInfo.outputPath('scenario-dialog-scroll.png'), fullPage: true })
    await page.getByTestId('cancel-platform').click()

    // 同一共享约束也覆盖链路、干扰设备，并确认关闭后可再次正常打开。
    await page.getByRole('tab', { name: '链路配置', exact: true }).click()
    await page.getByTestId('edit-link-0').click()
    await assertDialogFits(page, '.link-editor-dialog.el-dialog')
    await page.getByTestId('cancel-link').click()
    await page.getByTestId('edit-link-0').click()
    await expect(page.getByTestId('link-dialog')).toBeVisible()
    await page.getByTestId('cancel-link').click()

    await page.getByRole('tab', { name: '干扰设备', exact: true }).click()
    await page.getByTestId('edit-jammer-0').click()
    await assertDialogFits(page, '.link-editor-dialog.el-dialog')
    await page.getByTestId('cancel-jammer').click()
    expect(errors).toEqual([])
  } finally {
    await page.close()
    await server.close()
    scenes.close()
    await rm(directory, { recursive: true, force: true })
  }
})

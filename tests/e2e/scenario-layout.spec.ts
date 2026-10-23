import { expect, test } from '@playwright/test'

test('场景页签切换和缩放不触发尺寸循环，表格保留内部横向滚动', async ({ page, request }, testInfo) => {
  const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
  expect((await request.post('http://127.0.0.1:4173/api/v1/reset', { headers, data: { confirm: true } })).ok()).toBe(true)
  // 浏览器的布局循环通过 window.error 通知；仅 pageerror/console 监听可能漏掉它。
  await page.addInitScript(() => {
    const warnings: string[] = []
    Object.assign(window, { resizeObserverWarnings: warnings })
    window.addEventListener('error', event => {
      if (event.message.includes('ResizeObserver')) warnings.push(event.message)
    })
  })
  await page.goto('/login')
  await page.getByTestId('login-username').fill('operator')
  await page.getByTestId('login-password').fill('123456')
  await page.getByTestId('login-submit').click()
  await page.waitForURL('**/situation')
  await page.getByRole('link', { name: '场景配置', exact: true }).click()
  await page.getByTestId('scene-edit-SCN-001').click()

  const viewport = testInfo.project.use.viewport!
  for (const width of [viewport.width, viewport.width - 37, 960]) {
    await page.setViewportSize({ width, height: viewport.height })
    for (const [tab, tableId] of [
      ['节点配置', 'platform-table'], ['链路配置', 'link-table'],
      ['干扰设备', 'jammer-table'], ['传感器', 'sensor-table'],
      ['节点配置', 'platform-table'], ['链路配置', 'link-table'],
    ] as const) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      const table = page.getByTestId(tableId)
      await expect(table).toBeVisible()
      // 等布局及 ResizeObserver 通知越过绘制边界，不用固定休眠掩盖竞态。
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      expect(await page.evaluate(() => (window as unknown as { resizeObserverWarnings: string[] }).resizeObserverWarnings), `${tab}, width=${width}`).toEqual([])
      const size = await table.evaluate(element => ({
        width: element.getBoundingClientRect().width,
        available: element.parentElement!.clientWidth - parseFloat(getComputedStyle(element.parentElement!).paddingLeft)
          - parseFloat(getComputedStyle(element.parentElement!).paddingRight),
        scrollWidth: element.querySelector('.el-scrollbar__wrap')!.scrollWidth,
        clientWidth: element.querySelector('.el-scrollbar__wrap')!.clientWidth,
      }))
      expect(size.width).toBeLessThanOrEqual(size.available + 1)
      if (tableId === 'jammer-table' && width === 960) expect(size.scrollWidth).toBeGreaterThan(size.clientWidth)
    }
  }
})

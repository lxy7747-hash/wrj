import { expect, test } from '@playwright/test'
import { LOCAL_REPLAY } from '../fixtures/local-replay'

const { tsImport } = await import('tsx/esm/' + 'api')
const { once } = await import('node:' + 'events')
const { createMockServer } = await tsImport('../../server/app.ts', import.meta.url)

test('批量仿真入口和API已移除，普通报告与本地回放仍可使用', async ({ page, request }) => {
  const server = createMockServer({ port: 0 })
  const errors: string[] = []
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url())
      const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`, headers: { ...route.request().headers(), origin: 'http://127.0.0.1:5173' } })
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(page.url()).origin } })
    })
    await page.routeWebSocket('**/ws/v1', () => {})
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/login')
    await page.getByTestId('login-username').fill('admin')
    await page.getByTestId('login-password').fill('123456')
    await page.getByTestId('login-submit').click()
    await page.waitForURL('**/situation')
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '批量仿真', exact: true })).toHaveCount(0)
    await page.goto('/batches')
    await expect(page).not.toHaveURL(/\/batches(?:\?|$)/)
    await expect(page.locator('.batches-page')).toHaveCount(0)

    const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
    expect((await request.get(`${origin}/api/v1/batches`, { headers })).status()).toBe(404)
    const reports = await request.get(`${origin}/api/v1/reports`, { headers })
    expect(reports.ok()).toBe(true)
    expect((await reports.json()).data).toEqual([expect.objectContaining({ reportId: 'RPT-001' })])
    await page.goto('/reports')
    await expect(page.getByTestId('report-tabs')).toHaveAttribute('data-report-id', 'RPT-001')
    await expect(page.getByTestId('local-batch-report')).toHaveCount(0)
    await page.getByRole('tab', { name: '时序曲线', exact: true }).click()
    await expect(page.getByTestId('report-time-series-table').locator('.el-table__row')).toHaveCount(3)

    const replay = structuredClone(LOCAL_REPLAY)
    replay.durationS = 60
    replay.tracks[1]!.positions[1]!.time = 60
    await page.route('**/api/v1/replays/local-file', route => route.fulfill({ json: { ok: true, data: replay } }))
    await page.goto('/replays')
    const play = page.getByTestId('replay-play')
    const cursor = page.locator('.replay-controls__slider span').first()
    await expect(play).toHaveText('播放')
    await expect(cursor).toHaveText('00:00:00')
    await play.click()
    await expect(play).toHaveText('暂停')
    await expect(cursor).not.toHaveText('00:00:00', { timeout: 4_000 })
    await play.click()
    await expect(play).toHaveText('播放')
    expect(errors).toEqual([])
  } finally {
    await page.close()
    await server.close()
  }
})

import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const PASSWORD = '123456'
const REPLAY_FIXTURE = {
  replayId: 'REPLAY-001', runId: 'RUN-001', state: 'PAUSED', durationS: 7200,
  currentTimeS: 2537, eventIds: ['DET-042', 'SW-003', 'SW-004'],
} as const

interface BrowserAudit {
  errors: string[]
  http404s: string[]
  nonLoopbackHosts: Set<string>
}

/** 记录 P6 页面产生的控制台错误、404 和非回环请求。 */
function auditBrowser(page: Page): BrowserAudit {
  const audit: BrowserAudit = { errors: [], http404s: [], nonLoopbackHosts: new Set() }
  page.on('console', (message) => { if (message.type() === 'error') audit.errors.push(message.text()) })
  page.on('pageerror', (error) => audit.errors.push(String(error)))
  page.on('response', (response) => { if (response.status() === 404) audit.http404s.push(response.url()) })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.protocol !== 'data:' && url.hostname !== '127.0.0.1') audit.nonLoopbackHosts.add(url.hostname)
  })
  return audit
}

/** 通过正式登录表单进入工作区。 */
async function login(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByTestId('login-username').fill('operator')
  await page.getByTestId('login-password').fill(PASSWORD)
  await page.getByTestId('login-submit').click()
  await page.waitForURL('**/situation')
}

/** 在每个浏览器场景前恢复冻结的批次和回放投影。 */
async function resetMock(request: APIRequestContext): Promise<void> {
  const response = await request.post('http://127.0.0.1:4173/api/v1/reset', {
    headers: { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' },
    data: { confirm: true },
  })
  expect(response.ok()).toBe(true)
}

test('P6 批量任务、聚合报告与只读回放主链', async ({ page, request }) => {
  const audit = auditBrowser(page)
  await resetMock(request)
  await login(page)

  await page.getByRole('link', { name: '批量仿真', exact: true }).click()
  await page.waitForURL('**/batches')
  await expect(page.getByTestId('batch-powers')).toHaveAttribute('readonly', '')
  await expect(page.getByTestId('batch-distances')).toHaveAttribute('readonly', '')
  await expect(page.getByTestId('batch-run-table').locator('.el-table__row')).toHaveCount(12)
  await expect(page.getByText('BATCH-001', { exact: true }).first()).toBeVisible()

  await page.getByTestId('batch-create').click()
  await expect(page.getByText('已排队', { exact: true })).toBeVisible()
  await page.getByTestId('batch-start').click()
  await expect(page.getByText('已完成', { exact: true }).first()).toBeVisible()
  await expect(page.getByTestId('batch-run-table').locator('.el-table__row')).toHaveCount(12)

  await page.getByRole('button', { name: '查看聚合报告' }).click()
  await page.waitForURL(/\/reports\?reportId=RPT-BATCH-001/)
  await expect(page.getByTestId('report-tabs')).toHaveAttribute('data-report-id', 'RPT-BATCH-001')

  await page.getByRole('link', { name: '历史回放', exact: true }).click()
  await page.waitForURL('**/replays')
  await expect(page.getByText('只读快照 · RUN-001 · F-00042')).toBeVisible()
  await expect(page.getByTestId('replay-timeline').locator('.replay-timeline__events button')).toHaveCount(3)
  await expect(page.getByTestId('replay-event-detail')).toContainText('SW-004')
  await page.getByTestId('replay-play').click()
  await expect(page.getByTestId('replay-play')).toHaveText('暂停')
  const cursor = page.locator('.replay-controls__slider span').first()
  await expect(cursor).not.toHaveText('00:42:17', { timeout: 3_000 })
  const paused = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/replays/REPLAY-001/commands'
    && response.request().postDataJSON().command === 'PAUSE')
  await page.getByTestId('replay-play').click()
  const pauseResponse = await paused
  expect(pauseResponse.status()).toBe(200)
  await pauseResponse.finished()
  await expect(page.getByTestId('replay-play')).toHaveText('播放')
  const pausedTime = await cursor.textContent()
  await page.waitForTimeout(1_100)
  await expect(cursor).toHaveText(pausedTime ?? '')
  await page.getByTestId('replay-timeline').getByRole('button', { name: /DET-042/ }).click()
  await expect(page.getByTestId('replay-event-detail')).toContainText('DET-042')

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P6 播放中跨页返回续播，重复进入后暂停不再推进', async ({ page, request }) => {
  const audit = auditBrowser(page)
  const commands: string[] = []
  page.on('request', (outgoing) => {
    if (outgoing.method() === 'POST' && new URL(outgoing.url()).pathname === '/api/v1/replays/REPLAY-001/commands') {
      commands.push(outgoing.postDataJSON().command)
    }
  })
  await resetMock(request)
  await login(page)
  await page.getByRole('link', { name: '历史回放', exact: true }).click()
  const play = page.getByTestId('replay-play')
  const cursor = page.locator('.replay-controls__slider span').first()
  await expect(play).toHaveText('播放')
  await play.click()
  await expect(play).toHaveText('暂停')
  await expect(cursor).not.toHaveText('00:42:17', { timeout: 4_000 })
  for (let visit = 0; visit < 2; visit += 1) {
    await page.getByRole('link', { name: '批量仿真', exact: true }).click()
    await page.waitForURL('**/batches')
    const commandsAfterLeaving = commands.length
    await page.waitForTimeout(1_100)
    expect(commands).toHaveLength(commandsAfterLeaving)
    expect(commands).not.toContain('PAUSE')
    await page.getByRole('link', { name: '历史回放', exact: true }).click()
    await expect(play).toHaveText('暂停')
    const resumedAt = await cursor.textContent()
    await expect(cursor).not.toHaveText(resumedAt!, { timeout: 4_000 })
  }
  const paused = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/replays/REPLAY-001/commands'
    && response.request().postDataJSON().command === 'PAUSE')
  await play.click()
  expect((await paused).status()).toBe(200)
  await expect(play).toHaveText('播放')
  const pausedAt = await cursor.textContent()
  const commandsAfterPausing = commands.length
  await page.waitForTimeout(1_100)
  await expect(cursor).toHaveText(pausedAt!)
  expect(commands).toHaveLength(commandsAfterPausing)
  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P6 历史回放明确呈现空态和损坏态', async ({ page, request }) => {
  const audit = auditBrowser(page)
  await resetMock(request)
  await login(page)
  await page.route('**/api/v1/replays', async (route) => {
    await route.fulfill({ json: { ok: true, data: [], meta: { requestId: 'REQ-P6-EMPTY', generatedAt: '2026-08-06T08:00:00Z', page: 1, pageSize: 1, total: 0 } } })
  })
  await page.getByRole('link', { name: '历史回放', exact: true }).click()
  await expect(page.getByText('暂无可用回放记录')).toBeVisible()

  await page.unroute('**/api/v1/replays')
  await page.route('**/api/v1/replays/REPLAY-001', async (route) => {
    await route.fulfill({ json: {
      ok: true,
      data: { ...REPLAY_FIXTURE, currentTimeS: 9000 },
      meta: { requestId: 'REQ-P6-CORRUPT', generatedAt: '2026-08-06T08:00:00Z', page: 1, pageSize: 1, total: 1 },
    } })
  })
  await page.getByRole('link', { name: '态势主界面', exact: true }).click()
  await page.getByRole('link', { name: '历史回放', exact: true }).click()
  await expect(page.getByText('回放数据损坏')).toBeVisible()

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

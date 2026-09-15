import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { LOCAL_REPLAY } from '../fixtures/local-replay'

const PASSWORD = '123456'
// 测试替身只提供本地文件接口样本，不恢复产品中的演示回退。
const FILE_REPLAY = structuredClone(LOCAL_REPLAY)
FILE_REPLAY.durationS = 60
FILE_REPLAY.tracks[1]!.positions[1]!.time = 60

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

  // 菜单隐藏不等于删除功能，仍通过保留路由验证批量业务主链。
  await expect(page.getByRole('link', { name: '批量仿真', exact: true })).toHaveCount(0)
  await page.goto('/batches')
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

  await page.route('**/api/v1/replays/local-file', (route) => route.fulfill({ json: { ok: true, data: FILE_REPLAY } }))
  await page.getByRole('link', { name: '历史回放', exact: true }).click()
  await page.waitForURL('**/replays')
  await expect(page.getByText('文件回放 · 00:00:00')).toBeVisible()
  await expect(page.getByTestId('replay-event-detail')).toContainText('位置记录')
  await expect(page.getByTestId('replay-timeline').locator('.replay-timeline__events button')).toHaveCount(0)
  await expect(page.getByText('SW-004')).toHaveCount(0)
  await page.getByTestId('replay-play').click()
  await expect(page.getByTestId('replay-play')).toHaveText('暂停')
  const cursor = page.locator('.replay-controls__slider span').first()
  await expect(cursor).not.toHaveText('00:00:00', { timeout: 4_000 })
  await page.getByTestId('replay-play').click()
  await expect(page.getByTestId('replay-play')).toHaveText('播放')
  const pausedTime = await cursor.textContent()
  await page.waitForTimeout(1_100)
  await expect(cursor).toHaveText(pausedTime ?? '')
  await page.getByRole('slider', { name: '回放进度' }).press('End')
  await expect(cursor).toHaveText('00:01:00')
  await page.getByRole('slider', { name: '回放进度' }).press('Home')
  await expect(cursor).toHaveText('00:00:00')

  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P6 本地回放离页清理，重复进入重新加载后播放与暂停正常', async ({ page, request }) => {
  const audit = auditBrowser(page)
  await resetMock(request)
  await login(page)
  const replayRequests: string[] = []
  page.on('request', (outgoing) => {
    const path = new URL(outgoing.url()).pathname
    if (path.startsWith('/api/v1/replays')) replayRequests.push(path)
  })
  await page.route('**/api/v1/replays/local-file', (route) => route.fulfill({ json: { ok: true, data: FILE_REPLAY } }))
  await page.getByRole('link', { name: '历史回放', exact: true }).click()
  const play = page.getByTestId('replay-play')
  const cursor = page.locator('.replay-controls__slider span').first()
  for (let visit = 0; visit < 2; visit += 1) {
    await expect(play).toHaveText('播放')
    await expect(cursor).toHaveText('00:00:00')
    await play.click()
    await expect(play).toHaveText('暂停')
    await expect(cursor).not.toHaveText('00:00:00', { timeout: 4_000 })
    await page.getByRole('link', { name: '报表中心', exact: true }).click()
    const requestsAfterLeaving = replayRequests.length
    await page.waitForTimeout(1_100)
    expect(replayRequests).toHaveLength(requestsAfterLeaving)
    await page.getByRole('link', { name: '历史回放', exact: true }).click()
  }
  await expect(play).toHaveText('播放')
  await play.click()
  await expect(cursor).not.toHaveText('00:00:00', { timeout: 4_000 })
  await play.click()
  await expect(play).toHaveText('播放')
  const pausedAt = await cursor.textContent()
  await page.waitForTimeout(1_100)
  await expect(cursor).toHaveText(pausedAt!)
  expect(replayRequests).toEqual(Array(3).fill('/api/v1/replays/local-file'))
  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

test('P6 未配置和损坏的本地回放只提示异常，不加载演示数据，重试可恢复', async ({ page, request }) => {
  const audit = auditBrowser(page)
  await resetMock(request)
  await login(page)
  const replayRequests: string[] = []
  page.on('request', (outgoing) => {
    const path = new URL(outgoing.url()).pathname
    if (path.startsWith('/api/v1/replays') || path.includes('/frames/') || path.endsWith('/events')) replayRequests.push(path)
  })
  let data: unknown = null
  await page.route('**/api/v1/replays/local-file', (route) => route.fulfill({ json: { ok: true, data } }))
  await page.getByRole('link', { name: '历史回放', exact: true }).click()
  await expect(page.getByText('暂无本地回放数据，请配置数据文件后重新加载。')).toBeVisible()
  await expect(page.getByTestId('replay-play')).toHaveCount(0)
  expect(replayRequests).toEqual(['/api/v1/replays/local-file'])

  data = { ...FILE_REPLAY, durationS: -1 }
  await page.locator('.replays-page__header').getByRole('button', { name: '重新加载' }).click()
  await expect(page.getByText('回放数据损坏', { exact: true })).toBeVisible()
  await expect(page.getByText('历史回放数据格式不正确。')).toBeVisible()
  await expect(page.getByTestId('replay-play')).toHaveCount(0)

  data = FILE_REPLAY
  await page.locator('.el-result').getByRole('button', { name: '重新加载' }).click()
  await expect(page.getByTestId('replay-play')).toBeVisible()
  await expect(page.getByText('F-00042')).toHaveCount(0)
  expect(replayRequests).toEqual(Array(3).fill('/api/v1/replays/local-file'))
  expect(audit.errors).toEqual([])
  expect(audit.http404s).toEqual([])
  expect([...audit.nonLoopbackHosts]).toEqual([])
})

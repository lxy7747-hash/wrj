import { expect, test } from '@playwright/test'
import type { Report } from '../../src/contracts/domain-models'
import { INITIAL_LOG, POSITION_CSV } from '../fixtures/local-replay'

// 使用项目已有 tsx 加载服务端 ESM/JSON，不将 Node 模块加入浏览器 TS 工程。
const { tsImport } = await import('tsx/esm/' + 'api')
const { mkdtemp, writeFile, rm } = await import('node:fs/' + 'promises')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { once } = await import('node:' + 'events')
const { default: WebSocket } = await import('w' + 's')
const { createMockServer } = await tsImport('../../server/app.ts', import.meta.url)
const { ArchiveSqliteStorage } = await tsImport('../../server/local/archive-sqlite.ts', import.meta.url)
const { readLocalReplay } = await tsImport('../../server/local/afsim-replay-reader.ts', import.meta.url)
const { readLocalReport, exportLocalReport } = await tsImport('../../server/local/report-file.ts', import.meta.url)

let directory: string
let store: InstanceType<typeof ArchiveSqliteStorage>
let server: ReturnType<typeof createMockServer>
let origin: string

test.beforeEach(async ({ page }) => {
  directory = await mkdtemp(join(tmpdir(), 'wrj-archive-browser-'))
  const events = join(directory, 'events.csv'), positions = join(directory, 'position.csv')
  await writeFile(events, INITIAL_LOG); await writeFile(positions, POSITION_CSV)
  store = new ArchiveSqliteStorage(join(directory, 'archives.db'))
  server = createMockServer({ port: 0, archiveStorage: store,
    loadLocalReplay: () => readLocalReplay(events, positions), loadLocalReport: () => readLocalReport(events, positions),
    exportLocalReport: (report: Report, format: 'HTML' | 'CSV', actor: string) => exportLocalReport(directory, report, format, actor) })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('test server address missing')
  origin = `http://127.0.0.1:${address.port}`
  // 浏览器走真实 HTTP/SQLite，只重定向到本用例临时纯 Mock；不访问正式账号库或数据文件。
  await page.route('**/api/v1/**', async route => {
    const source = new URL(route.request().url())
    const response = await route.fetch({ url: `${origin}${source.pathname}${source.search}`, headers: { ...route.request().headers(), origin: 'http://127.0.0.1:5173' } })
    await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(page.url()).origin } })
  })
  await page.routeWebSocket('**/ws/v1', socket => {
    const upstream = new WebSocket(`${origin.replace('http:', 'ws:')}/ws/v1`, { headers: { Origin: 'http://127.0.0.1:5173' } })
    upstream.on('message', (data: { toString(): string }) => socket.send(data.toString()))
    socket.onMessage(data => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data) })
    socket.onClose(() => upstream.close())
    upstream.on('close', () => socket.close())
    upstream.on('error', () => socket.close())
  })
})
test.afterEach(async () => { await server.close(); store.close(); await rm(directory, { recursive: true, force: true }) })

test('真实快照登记后源文件变化，归档回放和评估仍同源，重载和导出保持一致', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto('/login')
  await page.getByTestId('login-username').fill('admin')
  await page.getByTestId('login-password').fill('123456')
  await page.getByTestId('login-submit').click()
  await page.waitForURL('**/situation')
  await page.goto('/admin?section=simulation-data')
  await expect(page.getByTestId('archive-table')).toContainText('暂无数据')
  await page.getByTestId('archive-create').click()
  await page.getByTestId('archive-name').fill('浏览器真实快照甲')
  await page.getByTestId('archive-save').click()
  await expect(page.getByTestId('archive-table')).toContainText('浏览器真实快照甲')
  const record = store.list()[0]!
  await writeFile(join(directory, 'position.csv'), POSITION_CSV + '10,A,-80,33,21,20,175\n')
  await page.getByTestId('archive-create').click()
  await page.getByTestId('archive-name').fill('浏览器真实快照乙')
  await page.getByTestId('archive-save').click()
  await expect(page.getByTestId('archive-table').locator('.el-table__row')).toHaveCount(2)
  await page.getByLabel('归档检索').fill('快照甲')
  await page.getByTestId('archive-table').getByRole('button', { name: '历史回放', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/replays\\?archiveId=${record.archiveId}$`))
  await expect(page.getByTestId('replay-archive-source')).toContainText(record.archiveId)
  await expect(page.getByRole('slider', { name: '回放进度' })).toHaveAttribute('aria-valuemax', '3')
  await page.reload()
  await expect(page.getByRole('slider', { name: '回放进度' })).toHaveAttribute('aria-valuemax', '3')
  await page.goto('/admin?section=simulation-data')
  await page.getByLabel('归档检索').fill('快照甲')
  await page.getByTestId('archive-table').getByRole('button', { name: '评估报表', exact: true }).click()
  await expect(page.getByTestId('report-archive-source')).toContainText(record.archiveId)
  await page.reload()
  await expect(page.getByTestId('report-archive-source')).toContainText(record.archiveId)
  await page.getByTestId('report-export').click()
  await expect(page.getByTestId('local-report-export-result')).toContainText(record.reportId)
  expect(errors).toEqual([])
})

test('操作员不可管理归档；非法归档响应显示错误而非最新文件', async ({ page }) => {
  await page.goto('/login')
  await page.getByTestId('login-username').fill('operator')
  await page.getByTestId('login-password').fill('123456')
  await page.getByTestId('login-submit').click()
  await page.waitForURL('**/situation')
  await page.goto('/admin?section=simulation-data')
  await expect(page).toHaveURL(/\/blueprint/)
  await expect(page.getByTestId('archive-panel')).toHaveCount(0)
  await page.route('**/api/v1/archives/**', route => route.fulfill({ json: { ok: true, data: {}, meta: {} } }))
  await page.goto(`/reports?archiveId=ARCH-LOCAL-${'0'.repeat(64)}`)
  await expect(page.getByText('报告加载失败', { exact: true })).toBeVisible()
  await expect(page.getByTestId('local-report')).toHaveCount(0)
})

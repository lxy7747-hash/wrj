import { expect, test } from '@playwright/test'

const { tsImport } = await import('tsx/esm/' + 'api')
const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { createMockServer } = await tsImport('../../server/app.ts', import.meta.url)
const { AuthSqliteStorage } = await tsImport('../../server/local/auth-sqlite.ts', import.meta.url)

test('审计日志默认最新在前，支持时间排序、分页与确认后单条和批量删除', async ({ page }, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-audit-browser-'))
  const password = 'Temporary-audit-password-2026!'
  const storage = new AuthSqliteStorage(join(directory, 'auth.db'), password)
  for (let index = 0; index < 25; index++) storage.appendAudit({
    actor: `auditor-${String(index).padStart(3, '0')}`, role: 'ADMIN', module: 'BROWSER-AUDIT', action: 'AUDIT_LIST',
    objectId: `SAMPLE-${index}`, result: 'SUCCESS', occurredAt: `2026-10-28T08:00:${String(index).padStart(2, '0')}Z`, immutableFixture: true,
  })
  const server = createMockServer({ port: 0, authStorage: storage })
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
    await page.getByTestId('login-password').fill(password)
    await page.getByTestId('login-submit').click()
    await page.waitForURL('**/situation')
    await page.goto('/admin?section=audit-logs')
    await page.getByRole('textbox', { name: '模块', exact: true }).fill('BROWSER-AUDIT')
    await page.getByRole('button', { name: '查询', exact: true }).click()
    const rows = page.getByTestId('audit-table').locator('.el-table__row')
    const pagination = page.getByTestId('audit-pagination')
    await expect(rows).toHaveCount(20)
    await expect(rows.first()).toContainText('auditor-024')
    await expect(pagination).toContainText('25')
    await pagination.locator('.btn-next').click()
    await expect(rows).toHaveCount(5)
    await expect(rows.first()).toContainText('auditor-004')
    await page.getByTestId('audit-table').getByRole('columnheader', { name: '时间' }).click()
    await expect(rows).toHaveCount(20)
    await expect(rows.first()).toContainText('auditor-000')

    const firstId = storage.readAudit().find((record: { actor: string }) => record.actor === 'auditor-000')!.auditId
    await page.getByTestId(`delete-audit-${firstId}`).click()
    let dialog = page.getByRole('dialog').filter({ hasText: '确认删除' })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    expect(storage.readAudit().some((record: { auditId: string }) => record.auditId === firstId)).toBe(true)
    await page.getByTestId(`delete-audit-${firstId}`).click()
    dialog = page.getByRole('dialog').filter({ hasText: '确认删除' })
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(rows.first()).toContainText('auditor-001')
    expect(storage.readAudit().some((record: { auditId: string }) => record.auditId === firstId)).toBe(false)
    await rows.nth(0).locator('.el-checkbox').click()
    await rows.nth(1).locator('.el-checkbox').click()
    await page.getByTestId('audit-delete-selected').click()
    dialog = page.getByRole('dialog').filter({ hasText: '确认删除' })
    await expect(dialog).toContainText('2')
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(rows.first()).toContainText('auditor-003')
    expect(storage.readAudit().filter((record: { module: string }) => record.module === 'BROWSER-AUDIT')).toHaveLength(22)
    expect(storage.readAudit().filter((record: { action: string }) => record.action === 'AUDIT_DELETE')).toHaveLength(2)
    await page.reload()
    await page.getByRole('textbox', { name: '模块', exact: true }).fill('BROWSER-AUDIT')
    await page.getByRole('button', { name: '查询', exact: true }).click()
    await expect(rows.first()).toContainText('auditor-024')
    await expect(pagination).toContainText('22')
    const box = await page.getByTestId('audit-log-panel').boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(testInfo.project.use.viewport!.width)
    expect(errors).toEqual([])
  } finally {
    await page.close()
    await server.close()
    storage.close()
    await rm(directory, { recursive: true, force: true })
  }
})

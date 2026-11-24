import { expect, test } from '@playwright/test'

const { tsImport } = await import('tsx/esm/' + 'api')
const { once } = await import('node:' + 'events')
const { writeFileSync } = await import('node:' + 'fs')
const { join } = await import('node:' + 'path')
const { createMockServer } = await tsImport('../../server/app.ts', import.meta.url)
const { createBackupFixture, BACKUP_TEST_PASSWORD } = await tsImport('../fixtures/system-backup.ts', import.meta.url)

test('SQLite 业务备份、损坏拒绝和恢复时保留现有通用数据', async ({ page }) => {
  const f = createBackupFixture()
  const server = createMockServer({ port: 0, backupStorage: f.backup, authStorage: f.auth, scenarioStorage: f.scenario,
    templateStorage: f.template, equipmentStorage: f.equipment, masterDataStorage: f.master, accessControlStorage: f.access, archiveStorage: f.archive })
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
    page.on('console', message => {
      if (message.type() !== 'error') return
      // 此备份用例未配置 Mission 文件，仅排除这两个读取端点的已知 409。
      const missingMissionData = /^http:\/\/127\.0\.0\.1:4173\/api\/v1\/simulations\/[^/]+\/(?:quality|positions)$/.test(message.location().url)
      if (missingMissionData && message.text() === 'Failed to load resource: the server responded with a status of 409 (Conflict)') return
      errors.push(message.text())
    })
    const login = async () => {
      await page.goto('/login')
      await page.getByTestId('login-username').fill('admin')
      await page.getByTestId('login-password').fill(BACKUP_TEST_PASSWORD)
      await page.getByTestId('login-submit').click()
      await page.waitForURL('**/situation')
    }
    await login()
    await page.goto('/admin?section=database-backup')
    const panel = page.getByTestId('backup-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('backup-table')).toContainText('暂无备份记录')
    await panel.getByRole('textbox', { name: '备份名称', exact: true }).fill('恢复演练')
    await panel.getByTestId('backup-create').click()
    await page.getByRole('dialog', { name: '创建备份', exact: true }).getByRole('button', { name: '确认执行' }).click()
    const row = panel.getByTestId('backup-table').locator('.el-table__row').filter({ hasText: '恢复演练' })
    await expect(row).toContainText('校验通过')
    await expect(row).toContainText('四库备份')
    const backupId = f.backup.listBackups().find((item: { name: string }) => item.name === '恢复演练').backupId
    await page.goto('/admin?section=master-data&category=master')
    const masterRow = page.getByTestId('master-table').locator('.el-table__row').filter({ hasText: 'DICT-TEST' })
    await masterRow.getByRole('button', { name: '编辑', exact: true }).click()
    const edit = page.getByRole('dialog', { name: '编辑通用数据', exact: true })
    await edit.getByTestId('master-name').fill('备份之后修改')
    await edit.getByTestId('master-save').click()
    await expect(edit).not.toBeVisible()
    await expect(masterRow).toContainText('备份之后修改')
    const scene = f.scenario.load('SCN-001')!
    const updatedScene = {
      ...scene,
      config: { ...scene.config, scenario: { ...scene.config.scenario, name: '备份之后修改场景' } },
      revision: scene.revision + 1,
    }
    expect(f.scenario.save(updatedScene, { id: 'SCN-001', revision: scene.revision })).toBe(true)
    const corrupt = f.backup.backup('BROKEN-BROWSER', '损坏演练')
    expect(corrupt.ok).toBe(true)
    writeFileSync(join(f.backup.directory, 'BROKEN-BROWSER.system.db'), 'broken')
    await page.goto('/admin?section=database-backup')
    const damaged = panel.getByTestId('backup-table').locator('.el-table__row').filter({ hasText: '损坏演练' })
    await expect(damaged).toContainText('校验失败')
    await expect(damaged.getByRole('button', { name: '恢复', exact: true })).toBeDisabled()
    await expect(panel.getByRole('combobox', { name: '恢复来源' })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: '恢复所选备份' })).toHaveCount(0)
    await expect(panel.getByText('已选目标', { exact: false })).toHaveCount(0)
    expect(f.master.load()[0].content.name).toBe('备份之后修改')
    await row.getByRole('button', { name: '恢复', exact: true }).click()
    const restoreDialog = page.getByRole('dialog', { name: '恢复备份', exact: true })
    await expect(restoreDialog).toContainText('备份名称：恢复演练')
    await expect(restoreDialog).toContainText(`创建时间：${await row.locator('.br-time').innerText()}`)
    await expect(restoreDialog).toContainText('恢复范围：场景、模板、账号、角色权限、历史归档和运行配置')
    await expect(restoreDialog).toContainText('请确认掌握备份中的管理员账号和密码')
    expect(f.scenario.load('SCN-001')?.revision).toBe(updatedScene.revision)
    await restoreDialog.getByRole('button', { name: '确认执行' }).click()
    await page.waitForURL('**/login')
    await login()
    await page.goto('/admin?section=master-data&category=master')
    await expect(masterRow).toContainText('备份之后修改')
    expect(f.master.load()[0].version).toBe(2)
    expect(f.scenario.load('SCN-001')).toEqual(scene)
    expect(f.master.details('DICT-TEST').references).toHaveLength(1)
    expect(f.archive.get(f.archived.archiveId)).not.toBeNull()
    expect(f.backup.listBackups().some((item: { backupId: string }) => item.backupId === backupId)).toBe(true)
    expect(errors).toEqual([])
  } finally { await page.close(); await server.close(); f.close() }
})

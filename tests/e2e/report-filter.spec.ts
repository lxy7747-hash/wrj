import { expect, test } from '@playwright/test'
import type { Report, LocalReportFilter } from '../../src/contracts/domain-models'
import type { MissionResultRecord, MissionResultParameterComparison } from '../../src/features/results/mission-result'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { POSITION_CSV } from '../fixtures/local-replay'

const { tsImport } = await import('tsx/esm/' + 'api')
const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/' + 'promises')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { once } = await import('node:' + 'events')
const { createMockServer } = await tsImport('../../server/app.ts', import.meta.url)
const { LocalMissionResults } = await tsImport('../../server/local/mission-results.ts', import.meta.url)
const { ScenarioProjection } = await tsImport('../../server/scenarios/projection.ts', import.meta.url)
const { exportLocalReport } = await tsImport('../../server/local/report-file.ts', import.meta.url)

test('报告统一筛选经真实HTTP刷新全部统计，HTML/PDF下载沿用范围并包含图表', async ({ page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'wrj-report-filter-browser-'))
  const entry = join(root, 'entry'), output = join(entry, 'data')
  await mkdir(output, { recursive: true })
  const draft = new ScenarioProjection().get('SCN-001').data
  await writeFile(join(entry, 'mapping.json'), JSON.stringify({ scenarioId: draft.config.scenario.id, revision: draft.revision,
    output: { resolvedDirectory: 'data' }, devices: [{ linkId: 'L-FILE', source: { platformId: 'A', deviceId: 'tx' }, target: { platformId: 'B', deviceId: 'rx' }, relay: null }] }))
  await writeFile(join(output, 'scenario_events.csv'), REPORT_EVENT_CSV + '\n')
  await writeFile(join(output, 'position.csv'), POSITION_CSV)
  const results = new LocalMissionResults(join(root, 'results'))
  await results.capture(entry, draft, '2026-10-27T00:00:00Z', '2026-10-27T00:00:10Z')
  const record = (await results.list())[0]!
  const server = createMockServer({ port: 0, missionResults: results,
    exportLocalReport: (...args: [Report, 'HTML' | 'PDF' | 'CSV', string, MissionResultRecord?, MissionResultParameterComparison[]?, LocalReportFilter?]) => exportLocalReport(join(root, 'exports'), ...args) })
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
    await page.getByTestId('login-username').fill('operator')
    await page.getByTestId('login-password').fill('123456')
    await page.getByTestId('login-submit').click()
    await page.waitForURL('**/situation')
    await page.goto(`/reports?resultId=${record.resultId}`)
    const form = page.getByRole('form', { name: '报告统一筛选' })
    await expect(page.getByTestId('report-applied-filter')).toContainText('全部数据')
    await form.locator('.el-select').filter({ has: page.getByRole('combobox', { name: '节点', exact: true }) }).click()
    await page.getByRole('option', { name: 'A', exact: true }).click()
    await form.getByRole('spinbutton', { name: '开始时刻（秒）' }).fill('1')
    await form.getByRole('spinbutton', { name: '结束时刻（秒）' }).fill('3')
    await form.getByRole('button', { name: '应用精确筛选' }).click()
    await expect(page.getByTestId('report-applied-filter')).toContainText('节点 A；1～3 秒')
    await expect(page.locator('.el-table[aria-label="汇总"]').locator('tr').filter({ hasText: '有效位置记录' })).toContainText('2')
    await page.getByRole('tab', { name: '柱状图', exact: true }).click()
    await expect(page.getByText('筛选范围事件记录数')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('filtered-report.png'), fullPage: true })
    for (const format of ['HTML', 'PDF']) {
      await page.locator('.el-select').filter({ has: page.getByRole('combobox', { name: '导出格式' }) }).click()
      await page.getByRole('option', { name: format, exact: true }).click()
      const pending = page.waitForEvent('download')
      await page.getByTestId('report-export').click()
      const file = await pending
      await file.saveAs(testInfo.outputPath(`filtered.${format.toLowerCase()}`))
      const bytes = await readFile((await file.path())!)
      if (format === 'HTML') {
        expect(bytes.toString()).toContain('节点=A； 时间=1～3 秒')
        expect(bytes.toString().match(/<svg /g)).toHaveLength(2)
      } else expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    }
    expect(errors).toEqual([])
  } finally {
    await page.close(); await server.close(); await rm(root, { recursive: true, force: true })
  }
})

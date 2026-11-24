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
const { readLocalReplay } = await tsImport('../../server/local/afsim-replay-reader.ts', import.meta.url)
const { fileReceptionScenarioId, playbackFileSource } = await tsImport('../../src/features/situation/file-reception.ts', import.meta.url)
const { snapshotMissionResultParameters } = await tsImport('../../src/features/results/mission-result.ts', import.meta.url)

for (const reference of [false, true]) test(`报告统一筛选经真实HTTP刷新统计，HTML/PDF下载沿用范围；项目参考快照=${reference}`, async ({ page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'wrj-report-filter-browser-'))
  const entry = join(root, 'entry'), output = join(entry, 'data')
  await mkdir(output, { recursive: true })
  const draft = new ScenarioProjection().get('SCN-001').data
  const linkId = 'c_forward_relay_mission_uav_02'
  await writeFile(join(entry, 'mapping.json'), JSON.stringify({ scenarioId: draft.config.scenario.id, revision: draft.revision,
    output: { resolvedDirectory: 'data' }, devices: [{ linkId, source: { platformId: 'A', deviceId: 'tx' }, target: { platformId: 'B', deviceId: 'rx' }, relay: null }] }))
  await writeFile(join(output, 'scenario_events.csv'), REPORT_EVENT_CSV + '\n')
  await writeFile(join(output, 'position.csv'), POSITION_CSV)
  const results = new LocalMissionResults(join(root, 'results'))
  if (reference) {
    draft.config.scenario.phases = [{ id: 'PH-1', name: '前段', startTimeS: 0, endTimeS: 5 }, { id: 'PH-2', name: '后段', startTimeS: 5, endTimeS: 10 }]
    const fileSource = playbackFileSource(await readLocalReplay(join(output, 'scenario_events.csv'), join(output, 'position.csv')))
    await results.captureFileReception(join(output, 'scenario_events.csv'), join(output, 'position.csv'), {
      runId: 'RUN-REFERENCE', taskId: 'TASK-001', scenarioId: fileReceptionScenarioId(fileSource), fileSource, startedAt: '2026-10-27T00:00:00Z',
    }, '2026-10-27T00:00:10Z', 10, { ...snapshotMissionResultParameters(draft), source: 'PROJECT_REFERENCE' })
  } else {
    const historicalDraft = structuredClone(draft)
    historicalDraft.config.platforms.push({
      ...historicalDraft.config.platforms[0]!, id: 'PLAT-REPORT-HISTORY', name: '历史测试节点',
      linkIds: [], sensorIds: [], jammerIds: [],
    })
    await results.capture(entry, historicalDraft, '2026-10-26T00:00:00Z', '2026-10-26T00:00:10Z')
    await results.capture(entry, draft, '2026-10-27T00:00:00Z', '2026-10-27T00:00:10Z')
  }
  const records = await results.list()
  const record = records[0]!
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
    await expect(page.getByTestId('report-metric-cards')).toBeVisible()
    await expect(page.getByTestId('report-metric-cards').locator('h4')).toHaveCount(5)
    await expect(page.getByRole('tab', { name: '节点与位置', exact: true })).toBeHidden()
    await expect(page.getByTestId('report-evidence-load')).toBeHidden()
    await expect(page.getByRole('tab', { name: /运行参数对比/ })).toHaveCount(0)
    const comparison = page.getByRole('button', { name: '运行参数对比', exact: true })
    const comparisonDialog = page.getByRole('dialog', { name: '运行参数对比', exact: true })
    await expect(comparison).toBeVisible()
    await expect(comparisonDialog).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath('report-simplified.png'), fullPage: true })
    await comparison.click()
    await expect(comparisonDialog).toBeVisible()
    const differenceStatus = comparisonDialog.getByTestId('run-parameter-difference-status')
    const fullParameters = comparisonDialog.getByTestId('run-parameter-full')
    if (reference) {
      await expect(differenceStatus).toHaveText('没有同场景的历史参数快照可对比。')
      const parameterTable = fullParameters.getByTestId('completed-result-parameter-comparison')
      await expect(parameterTable).toBeVisible()
      await expect(parameterTable).toContainText('本次运行')
      await expect(parameterTable).toContainText(record.resultId)
      await expect(parameterTable).toContainText('项目参考配置')
      await expect(parameterTable).toContainText('未确认引擎实际执行版本')
    } else {
      await expect(differenceStatus).toHaveText('共 1 项差异')
      const differences = comparisonDialog.getByTestId('run-parameter-differences')
      await expect(differences.getByRole('columnheader')).toHaveCount(2)
      const referenceColumn = differences.getByTestId('run-parameter-reference')
      const currentColumn = differences.getByTestId('run-parameter-current')
      await expect(referenceColumn).toContainText('对照运行')
      await expect(referenceColumn).toContainText(records[1]!.resultId)
      await expect(referenceColumn).toContainText('运行时保存的配置')
      await expect(currentColumn).toContainText('本次运行')
      await expect(currentColumn).toContainText(record.resultId)
      await expect(currentColumn).toContainText('运行时保存的配置')
      const platformCount = draft.config.platforms.length
      const countCells = differences.getByRole('row', { name: /节点数/ }).getByRole('cell')
      await expect(countCells).toHaveCount(2)
      await expect(countCells).toContainText(['节点数', '节点数'])
      await expect(countCells.locator('.comparison-value')).toHaveText([String(platformCount + 1), String(platformCount)])
      await expect(fullParameters).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath('parameter-differences.png'), animations: 'disabled' })
      const [left, right] = await Promise.all([countCells.nth(0).boundingBox(), countCells.nth(1).boundingBox()])
      expect(left!.x).toBeLessThan(right!.x)
      expect(left!.y).toBeCloseTo(right!.y, 0)
      const unchanged = differences.getByRole('row', { name: /链路数/ })
      await expect(unchanged).toHaveCount(0)
      const showAll = comparisonDialog.getByRole('checkbox', { name: '显示全部参数', exact: true })
      await expect(showAll).not.toBeChecked()
      await comparisonDialog.getByText('显示全部参数', { exact: true }).click()
      await expect(showAll).toBeChecked()
      const linkCount = String(draft.config.links.length)
      await expect(unchanged.locator('.comparison-value')).toHaveText([linkCount, linkCount])
    }
    await page.keyboard.press('Escape')
    await expect(comparisonDialog).toBeHidden()
    const form = page.getByRole('form', { name: '报告统一筛选' })
    if (reference) {
      await expect(page.getByTestId('report-reference-parameters')).toContainText('未确认引擎实际执行版本')
      await form.locator('.el-select').filter({ has: page.getByRole('combobox', { name: '任务阶段', exact: true }) }).click()
      await page.getByRole('option', { name: 'PH-1', exact: true }).click()
      await form.getByRole('button', { name: '应用精确筛选' }).click()
      await expect(page.getByTestId('report-applied-filter')).toContainText('阶段 PH-1')
    } else {
      const linkLabel = 'C 波段数传链路 · 前向 · 中继节点与任务无人机 02'
      await form.locator('.el-select').filter({ has: page.getByRole('combobox', { name: '链路', exact: true }) }).click()
      await page.getByRole('option', { name: linkLabel, exact: true }).click()
      const filterRequest = page.waitForRequest(request => request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/filter'))
      await form.getByRole('button', { name: '应用精确筛选' }).click()
      expect(new URL((await filterRequest).url()).searchParams.get('linkId')).toBe(linkId)
      await expect(page.getByTestId('report-applied-filter')).toContainText(linkLabel)
    }
    await form.getByRole('button', { name: '重置', exact: true }).click()
    await expect(page.getByTestId('report-applied-filter')).toContainText('全部数据')
    await form.locator('.el-select').filter({ has: page.getByRole('combobox', { name: '节点', exact: true }) }).click()
    await page.getByRole('option', { name: 'A', exact: true }).click()
    await form.getByRole('spinbutton', { name: '开始时刻（秒）' }).fill('1')
    await form.getByRole('spinbutton', { name: '结束时刻（秒）' }).fill('3')
    await page.getByRole('button', { name: '应用精确筛选' }).click()
    await expect(page.getByTestId('report-applied-filter')).toContainText('节点 A；1～3 秒')
    await page.getByRole('tab', { name: '柱状图', exact: true }).click()
    const barCharts = page.getByTestId('report-bar-charts')
    await expect(barCharts.getByText('五项评估指标', { exact: true })).toBeVisible()
    await expect(barCharts.locator('.report-chart')).toHaveCount(5)
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
        expect(bytes.toString()).toContain('同场景已完成运行参数对比')
        if (reference) expect(bytes.toString()).toContain('未确认引擎实际执行版本')
        expect(bytes.toString()).toContain('节点=A； 时间=1～3 秒')
        expect(bytes.toString().match(/<svg /g)).toHaveLength(2)
      } else expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    }
    expect(errors).toEqual([])
  } finally {
    await page.close(); await server.close(); await rm(root, { recursive: true, force: true })
  }
})

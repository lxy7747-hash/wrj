import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { LocalReportFilter, Report } from '../../src/contracts/domain-models'
import type { MissionResultParameterComparison, MissionResultRecord } from '../../src/features/results/mission-result'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { POSITION_CSV } from '../fixtures/local-replay'

const { tsImport } = await import('tsx/esm/' + 'api')
const { mkdir, mkdtemp, rm, writeFile } = await import('node:' + 'fs/promises')
const { join, resolve } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { createMockServer } = await tsImport('../../server/app.ts', import.meta.url)
const { LocalMissionResults } = await tsImport('../../server/local/mission-results.ts', import.meta.url)
const { ScenarioProjection } = await tsImport('../../server/scenarios/projection.ts', import.meta.url)
const { exportLocalReport } = await tsImport('../../server/local/report-file.ts', import.meta.url)

const fixtureRoot = resolve('output/functional-readiness/fixtures')
const at = '2026-10-27T00:00:00Z'

type Fixture = {
  root: string
  origin: string
  resultId: string
  server: Awaited<ReturnType<typeof createMockServer>>
}

/** Build one indexed result without launching an engine. */
async function createFixture(): Promise<Fixture> {
  await mkdir(fixtureRoot, { recursive: true })
  const root = await mkdtemp(join(fixtureRoot, 'readiness-'))
  const draft = new ScenarioProjection().get('SCN-001').data
  draft.config.scenario.phases = [
    { id: 'EARLY', name: '前段', startTimeS: 0, endTimeS: 5 },
    { id: 'LATE', name: '后段', startTimeS: 5, endTimeS: 10 },
  ]
  const entry = join(root, 'entry'), output = join(entry, 'data'), results = new LocalMissionResults(join(root, 'results'))
  await mkdir(output, { recursive: true })
  await writeFile(join(entry, 'mapping.json'), JSON.stringify({ scenarioId: 'SCN-001', revision: draft.revision,
    output: { resolvedDirectory: 'data' }, devices: [{ linkId: 'L-FILE', source: { platformId: 'A', deviceId: 'tx' }, target: { platformId: 'B', deviceId: 'rx' }, relay: null }] }))
  await writeFile(join(output, 'scenario_events.csv'), REPORT_EVENT_CSV + '\n')
  await writeFile(join(output, 'position.csv'), POSITION_CSV)

  await results.capture(entry, draft, at, at, () => true, { runId: 'RUN-READINESS', taskId: 'TASK-READINESS' })
  const captured = (await results.list())[0]!
  const server = createMockServer({
    port: 0,
    missionResults: results,
    exportLocalReport: (...args: [Report, 'HTML' | 'PDF' | 'CSV', string, MissionResultRecord?, MissionResultParameterComparison[]?, LocalReportFilter?]) => exportLocalReport(join(root, 'exports'), ...args),
  })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('functional readiness mock server did not expose a TCP port')
  return { root, origin: `http://127.0.0.1:${address.port}`, resultId: captured.resultId, server }
}

async function routeApi(page: Page, origin: string): Promise<void> {
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`, headers: { ...route.request().headers(), origin: 'http://127.0.0.1:5173' } })
    await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(page.url()).origin } })
  })
  await page.routeWebSocket('**/ws/v1', () => {})
}

async function login(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByTestId('login-username').fill('admin')
  await page.getByTestId('login-password').fill('123456')
  await page.getByTestId('login-submit').click()
  await page.waitForURL('**/situation')
}

function assertViewportFits(page: Page): Promise<void> {
  return expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test('真实模式功能就绪：阶段与原生 ESM 保存，单次报告按阶段筛选', async ({ page, request }) => {
  const fixture = await createFixture()
  const browserErrors: string[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  try {
    page.setDefaultTimeout(7_000)
    await routeApi(page, fixture.origin)
    await login(page)

    await page.goto('/scenarios')
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const phaseEditor = page.getByTestId('task-phase-editor')
    await expect(phaseEditor).toBeVisible()
    await phaseEditor.getByRole('button', { name: '添加任务阶段' }).click()
    await page.getByTestId('new-phase-id').fill('EARLY')
    await page.getByTestId('new-phase-name').fill('前段')
    await page.getByTestId('new-phase-start').locator('input').fill('0')
    await page.getByTestId('new-phase-end').locator('input').fill('5')
    await page.getByTestId('confirm-task-phase').click()

    await page.locator('#tab-data').click()
    const nativeToggle = page.getByTestId('native-esm-enabled-ESM-01')
    await expect(nativeToggle).toBeVisible()
    await nativeToggle.click()
    await page.getByTestId('native-esm-sensitivity-ESM-01').locator('input').fill('-180')
    await page.getByTestId('native-esm-threshold-ESM-01').locator('input').fill('3')
    await page.getByTestId('native-esm-dwell-ESM-01').locator('input').fill('1')
    await page.getByTestId('native-esm-revisit-ESM-01').locator('input').fill('2')
    await expect(page.getByTestId('sensor-probability-0').locator('input')).toBeDisabled()
    await expect(page.getByTestId('sensor-range-0').locator('input')).toBeDisabled()
    await assertViewportFits(page)

    const saved = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/v1/scenarios/SCN-001')
    await page.getByTestId('save-scenario').click()
    expect((await saved).ok()).toBe(true)
    const persisted = await request.get(`${fixture.origin}/api/v1/scenarios/SCN-001`, { headers: { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' } })
    const savedDraft = (await persisted.json()).data
    expect(savedDraft.config.scenario.phases).toEqual([{ id: 'EARLY', name: '前段', startTimeS: 0, endTimeS: 5 }])
    expect(savedDraft.uiExtensions.sensors.find((item: { sensorId: string }) => item.sensorId === 'ESM-01').esm).toEqual({ sensitivityDbw: -180, detectionThresholdDb: 3, dwellTimeS: 1, revisitTimeS: 2 })

    await page.goto(`/reports?resultId=${fixture.resultId}`)
    const singleFilter = page.getByRole('form', { name: '报告统一筛选' })
    await expect(singleFilter).toBeVisible()
    await singleFilter.locator('.el-select').filter({ has: page.getByRole('combobox', { name: '任务阶段', exact: true }) }).click()
    await page.getByRole('option', { name: 'EARLY', exact: true }).click()
    await singleFilter.getByRole('button', { name: '应用精确筛选' }).click()
    await expect(page.getByTestId('report-applied-filter')).toContainText('阶段 EARLY')
    await assertViewportFits(page)

    expect(browserErrors).toEqual([])
  } finally {
    await page.close()
    await fixture.server.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

import { expect, test, request as pwRequest } from '@playwright/test'

// T4/T5 final browser acceptance: real login cookie, file import through the preserved HTTP API
// into a real running simulation frozen context, dual-source (native archive + CSV file-set) report,
// applied-filter, pagination, series continuation, real download (download=1) HTML/PDF; plus a
// deterministic browser race across source/report switches.
// Uses only isolated services started here on an ephemeral port; never touches 4173/5173.

const { tsImport } = await import('tsx/esm/' + 'api')
const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/' + 'promises')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { once } = await import('node:' + 'events')
const { createMockServer } = await tsImport('../../server/app.ts', import.meta.url)
const { AuthSqliteStorage } = await tsImport('../../server/local/auth-sqlite.ts', import.meta.url)
const { ScenarioSqliteStorage } = await tsImport('../../server/local/scenario-sqlite.ts', import.meta.url)
const { ScenarioProjection } = await tsImport('../../server/scenarios/projection.ts', import.meta.url)
const { LocalMissionResults } = await tsImport('../../server/local/mission-results.ts', import.meta.url)
const { createRunEvidenceStore } = await tsImport('../../server/local/run-evidence.ts', import.meta.url)
const { createEngineFrameArchive } = await tsImport('../../server/local/engine-frame-archive.ts', import.meta.url)
const { exportEvidenceReport } = await tsImport('../../server/local/report-file.ts', import.meta.url)
const { REPORT_EVENT_CSV } = await tsImport('../fixtures/local-report-csv.ts', import.meta.url)

const PASSWORD = 'Test-only-final-evidence-2026!'
const ARTIFACTS = join('output', 'gnzb-final-20261111-2117', 'browser')
const CSV_ROWS = 1200, NATIVE_ROWS = 1200, END_S = 12000
const HEADER = 'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'

function nativeFrame(scope: Record<string, string>, link: Record<string, unknown>, index: number, frameId: number) {
  const value = index === 5000 ? 919 : index === 4800 ? -319 : index === 5999 ? 27 : (index % 19) - 9
  return { kind: 'ENGINE_FRAME', runId: scope.runId, engineEpoch: 0, frameId, simulationTime: index * 2,
    modelVersion: 'isolated', modulation: null, jammers: [], routing: { switches: [], alarms: [] }, events: [], initRouting: null,
    links: [{ linkId: 'SEG-1', linkIds: [link.id], sourceName: link.sourcePlatformId, sourcePlatformId: link.sourcePlatformId, sourcePort: 'tx',
      targetName: link.targetPlatformId, targetPlatformId: link.targetPlatformId, targetPort: 'rx', status: 'UP', engineStatus: 'AVAILABLE', error: null, distanceM: 10,
      losses: { freeSpaceDb: null, seaMultipathDb: null, atmosphericDb: null, cloudRainDb: null, jammingDb: null, totalDb: null },
      quality: { gxbDb: value, ber: 0.0001, rxPowerDbw: null, rxPowerDbm: null },
      inputTrace: { eirpDbw: null, gtDbk: null, dataRateMbps: null, frequencyGHz: null, jammers: [] } }] }
}

async function evidenceServer(seedFileSet = false) {
  const root: string = await mkdtemp(join(tmpdir(), 'wrj-final-browser-'))
  const auth = new AuthSqliteStorage(join(root, 'auth.db'), PASSWORD)
  const scenes = new ScenarioSqliteStorage(join(root, 'scenarios.db'))
  const initial = new ScenarioProjection().get('SCN-001')
  const draft = initial.data
  draft.config.scenario.duration = END_S
  draft.config.scenario.timeStep = 1
  draft.config.scenario.phases = [{ id: 'EARLY', name: '前段', startTimeS: 0, endTimeS: 1000 }, { id: 'LATE', name: '后段', startTimeS: 1000, endTimeS: END_S }]
  expect(scenes.save(draft, undefined)).toBe(true)
  const results = new LocalMissionResults(join(root, 'results'))
  const evidence = createRunEvidenceStore(join(root, 'evidence'), () => '2026-11-11T12:00:00Z')
  const archive = createEngineFrameArchive(join(root, 'native'), () => '2026-11-11T12:00:00Z')
  const server = createMockServer({ port: 0, authStorage: auth, scenarioStorage: scenes, missionResults: results,
    runEvidenceStore: evidence, engineFrameArchive: archive,
    exportReportEvidence: (input: Parameters<typeof exportEvidenceReport>[1]) => exportEvidenceReport(join(root, 'exports'), input) })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  const api = await pwRequest.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: 'http://127.0.0.1:5173' } })
  const login = await api.post('/api/v1/auth/login', { data: { username: 'admin', passwordFixture: PASSWORD } })
  expect(login.status()).toBe(200)
  const created = await api.post('/api/v1/simulations', { data: { taskId: 'TASK-001', scenarioId: draft.config.scenario.id } })
  expect(created.status()).toBe(201)
  const runId = (await created.json()).data.runId as string
  const started = await api.post(`/api/v1/simulations/${runId}/commands`, { data: { command: 'START', mode: 'INTERACTIVE_SINGLE' } })
  expect(started.status()).toBe(200)
  const scope = { taskId: 'TASK-001', runId, scenarioId: draft.config.scenario.id, revision: draft.revision, startedAt: (await started.json()).data.startedAt as string }
  const link = draft.config.links[0] as Record<string, unknown>
  const s = String(link.sourcePlatformId), t = String(link.targetPlatformId)
  const entry = join(root, 'entry'), data = join(entry, 'data'); await mkdir(data, { recursive: true })
  await writeFile(join(entry, 'mapping.json'), JSON.stringify({ scenarioId: scope.scenarioId, revision: scope.revision,
    output: { resolvedDirectory: 'data' }, devices: [{ linkId: link.id, source: { platformId: s, deviceId: 'tx' }, target: { platformId: t, deviceId: 'rx' }, relay: null }] }))
  const log = String(REPORT_EVENT_CSV).replaceAll(',A,', `,${s},`).replaceAll(',B,', `,${t},`).replace('10,SIMULATION_COMPLETE', `${END_S},SIMULATION_COMPLETE`)
  await writeFile(join(data, 'scenario_events.csv'), `${log}\n`)
  await writeFile(join(data, 'position.csv'), `TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n0,${s},119,25,3000,0,90\n0,${t},120,26,0,0,90\n${END_S},${s},119,25,3000,0,90\n`)
  const completed = new Date(Date.parse(scope.startedAt) + END_S * 1000).toISOString()
  await results.capture(entry, draft, scope.startedAt, completed, () => true, { taskId: scope.taskId, runId: scope.runId })
  const record = (await results.list())[0]!
  const snapshot = await results.get(record.resultId)
  const session = await archive.begin(scope, { [String(link.id)]: { type: link.type, sourcePlatformId: s, targetPlatformId: t } })
  for (let i = 0; i < NATIVE_ROWS; i += 1) await session.append(nativeFrame(scope, link, i, i * 6))
  await session.close()
  expect(session.failure()).toBeNull()
  const csvPath = join(root, 'link_state.csv')
  await writeFile(csvPath, [HEADER, ...Array.from({ length: CSV_ROWS }, (_, i) => `${scope.taskId},1.1,${i * 2},${s},${t},${link.type},UP,${i % 17 - 8},0.0001,-70`)].join('\n'))
  if (seedFileSet) {
    await evidence.import({ files: [{ fileName: 'link_state.csv', text: await readFile(csvPath, 'utf8') }] },
      scope as never, { scenario: { id: scope.scenarioId, timeStep: 1 }, platforms: [{ id: s }, { id: t }],
        links: [{ id: link.id, type: link.type, sourcePlatformId: s, targetPlatformId: t, enabled: true }], linkSettings: {} } as never)
  }
  await mkdir(ARTIFACTS, { recursive: true })
  return { root, server, api, origin, scope, link, record, reportId: snapshot.report.reportId as string, csvPath, archive, auth, scenes }
}

test('T4 保留文件接口→双源报告→筛选/分页/续段/真实下载HTML+PDF', async ({ page }, info) => {
  const ctx = await evidenceServer()
  const { root, server, api, origin, record, reportId } = ctx
  const calls: string[] = []
  try {
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url()); calls.push(`${route.request().method()} ${url.pathname}${url.search}`)
      const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`, headers: { ...route.request().headers(), origin: 'http://127.0.0.1:5173' }, timeout: 120000 })
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(page.url()).origin } })
    })
    await page.routeWebSocket('**/ws/v1', ws => { ws.onMessage(() => {}) })
    await page.route('**/tiles/**', r => r.abort())
    await page.goto('/login')
    await page.getByTestId('login-username').fill('admin')
    await page.getByTestId('login-password').fill(PASSWORD)
    await page.getByTestId('login-submit').click()
    await page.waitForURL('**/situation')

    await page.getByRole('tab', { name: '质量指标' }).first().click()
    await expect(page.getByTestId('quality-import-button')).toHaveCount(0)
    await expect(page.getByTestId('evidence-import-button')).toHaveCount(0)
    await expect(page.getByTestId('quality-import-input')).toHaveCount(0)
    await expect(page.getByTestId('evidence-import-input')).toHaveCount(0)
    const imported = await api.post(`/api/v1/simulations/${ctx.scope.runId}/evidence-import`, {
      data: { files: [{ fileName: 'link_state.csv', text: await readFile(ctx.csvPath, 'utf8') }] },
    })
    expect(imported.status(), await imported.text()).toBe(200)
    const receipt = (await imported.json()).data
    expect(receipt.association).toBe('USER_SELECTED_RUN')
    expect(receipt.files[0].rows).toBe(CSV_ROWS)
    const csvSha = receipt.bundleSha256 as string

    // Open the report for this result → dual source.
    await page.goto(`/reports?resultId=${record.resultId}`)
    const panel = page.getByTestId('report-evidence')
    await expect(panel).toBeHidden()
    await expect(page.getByRole('button', { name: '应用精确筛选', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '排障工具与全量导出' }).click()
    await expect(panel).toBeVisible({ timeout: 30000 })
    await panel.getByTestId('report-evidence-load').click()
    const sourceSelect = panel.locator('.report-evidence__bar .el-select').first()
    await sourceSelect.click()
    const options = page.getByRole('option')
    const optionLabels = await options.allInnerTexts()
    expect(optionLabels.some(t => t.includes('原生帧归档'))).toBe(true)
    expect(optionLabels.some(t => t.includes('文件集'))).toBe(true)

    // --- NATIVE archive source first (forced > default budget → multi segment) ---
    await page.getByRole('option', { name: /原生帧归档/ }).first().click()
    await expect(panel.getByTestId('report-evidence-totals')).toContainText('segments 1200')
    let nseg = 0
    const nNext = panel.getByRole('button', { name: '曲线下一段' })
    await expect(nNext).toBeVisible({ timeout: 20000 })
    while (await nNext.count()) { await nNext.click(); await page.waitForTimeout(120); if (++nseg > 60) break }
    expect(nseg).toBeGreaterThan(0)
    const [natHtml] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: '导出证据 HTML' }).click()])
    const natHtmlText = await readFile((await natHtml.path())!, 'utf8')
    expect(natHtmlText).toContain('报告证据'); expect(natHtmlText).toContain('原始 1200')
    await natHtml.saveAs(join(ARTIFACTS, 'T4-native.html'))
    const [natPdf] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: '导出证据 PDF' }).click()])
    const natPdfBuf = await readFile((await natPdf.path())!); expect(natPdfBuf.subarray(0, 5).toString()).toBe('%PDF-'); await natPdf.saveAs(join(ARTIFACTS, 'T4-native.pdf'))

    // --- In-place switch to CSV file-set source (NO page reload; catalog must keep both options) ---
    await sourceSelect.click()
    const optionsAfter = await page.getByRole('option').allInnerTexts()
    expect(optionsAfter.some(t => t.includes('文件集'))).toBe(true)
    expect(optionsAfter.some(t => t.includes('原生帧归档'))).toBe(true)
    await page.getByRole('option', { name: /文件集/ }).first().click()
    await expect(panel.getByTestId('report-evidence-totals')).toContainText('state 1200')
    const rows = panel.getByTestId('report-evidence-rows').locator('tbody tr')
    await expect(rows).toHaveCount(200)
    const firstId = await rows.first().innerText()
    await panel.getByRole('button', { name: '下一页' }).click()
    await expect(rows).toHaveCount(200)
    await expect.poll(async () => rows.first().innerText()).not.toBe(firstId)
    let seg = 0
    const nextSeg = panel.getByRole('button', { name: '曲线下一段' })
    await expect(nextSeg).toBeVisible({ timeout: 20000 })
    while (await nextSeg.count()) { await nextSeg.click(); await page.waitForTimeout(120); if (++seg > 60) break }
    expect(seg).toBeGreaterThan(0)
    const [csvHtml] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: '导出证据 HTML' }).click()])
    const csvHtmlText = await readFile((await csvHtml.path())!, 'utf8')
    expect(csvHtmlText).toContain('报告证据'); expect(csvHtmlText).toContain('state')
    await csvHtml.saveAs(join(ARTIFACTS, 'T4-fileset.html'))
    const [csvPdf] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: '导出证据 PDF' }).click()])
    const csvPdfBuf = await readFile((await csvPdf.path())!); expect(csvPdfBuf.subarray(0, 5).toString()).toBe('%PDF-'); await csvPdf.saveAs(join(ARTIFACTS, 'T4-fileset.pdf'))
    // A→B→A: switch back to native in place; both options still present, native totals win.
    await sourceSelect.click()
    expect((await page.getByRole('option').allInnerTexts()).some(t => t.includes('原生帧归档'))).toBe(true)
    await page.getByRole('option', { name: /原生帧归档/ }).first().click()
    await expect(panel.getByTestId('report-evidence-totals')).toContainText('segments 1200')
    await info.attach('T4-native.html', { body: natHtmlText, contentType: 'text/html' })
    await info.attach('T4-fileset.html', { body: csvHtmlText, contentType: 'text/html' })
    expect(calls.some(c => c.includes('/evidence-import'))).toBe(false)
    expect(calls.some(c => c.includes(`sourceSha256=${csvSha}`))).toBe(true)
  } finally {
    await page.close(); await api.dispose(); await server.close(); ctx.auth.close(); ctx.scenes.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('T5 浏览器竞态：切源后旧 overview 晚到不覆盖新来源', async ({ page }) => {
  const ctx = await evidenceServer(true)
  const { root, server, api, origin, record } = ctx
  const errors: string[] = []
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  let gated = false
  try {
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url())
      const isOverview = url.pathname.endsWith(`/reports/${encodeURIComponent(ctx.reportId)}/evidence`) && url.searchParams.has('sourceSha256')
      if (isOverview && !gated) { gated = true; await held }
      const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`, headers: { ...route.request().headers(), origin: 'http://127.0.0.1:5173' }, timeout: 120000 })
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(page.url()).origin } })
    })
    await page.routeWebSocket('**/ws/v1', ws => { ws.onMessage(() => {}) })
    await page.route('**/tiles/**', r => r.abort())
    page.on('pageerror', e => errors.push(e.message))
    await page.goto('/login')
    await page.getByTestId('login-username').fill('admin')
    await page.getByTestId('login-password').fill(PASSWORD)
    await page.getByTestId('login-submit').click()
    await page.waitForURL('**/situation')
    await page.goto(`/reports?resultId=${record.resultId}`)
    const panel = page.getByTestId('report-evidence')
    await expect(panel).toBeHidden()
    await expect(page.getByRole('button', { name: '应用精确筛选', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '排障工具与全量导出' }).click()
    await expect(panel).toBeVisible({ timeout: 30000 })
    await panel.getByTestId('report-evidence-load').click()
    const sourceSelect = panel.locator('.report-evidence__bar .el-select').first()
    const totals = panel.getByTestId('report-evidence-totals')
    // 选原生：其 overview 被屏障扣住（旧请求在途）。
    await sourceSelect.click(); await page.getByRole('option', { name: /原生帧归档/ }).first().click()
    await expect.poll(() => gated, { timeout: 8000 }).toBe(true)
    // 在旧 overview 未返回时原地切到文件集（新请求）；目录仍应保留两项。
    await page.keyboard.press('Escape'); await page.waitForTimeout(200)
    await sourceSelect.click()
    await page.getByRole('option', { name: /文件集/ }).first().click({ timeout: 15000 })
    await expect(totals).toContainText('state 1200')
    // 释放旧原生 overview（旧 epoch），不得覆盖新文件集来源。
    release(); await page.waitForTimeout(600)
    await expect(totals).toContainText('state 1200')
    await expect(totals).not.toContainText('segments 1200')
    expect(errors).toEqual([])
  } finally {
    release()
    await page.close(); await api.dispose(); await server.close(); ctx.auth.close(); ctx.scenes.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('T6 浏览器竞态：切来源后旧 rows 迟到失败不污染新来源明细与错误提示', async ({ page }, info) => {
  const ctx = await evidenceServer(true)
  const { root, server, api, origin, record } = ctx
  const errors: string[] = []
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  let gated = false
  try {
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url())
      // 仅扣住第一次（文件集）明细请求；切换来源后的新 rows 正常放行。
      if (url.pathname.endsWith('/evidence/rows') && !gated) {
        gated = true; await held
        await route.fulfill({ status: 500, headers: { 'access-control-allow-origin': new URL(page.url()).origin, 'content-type': 'application/json' },
          body: JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'SIMULATED_OLD_ROWS_FAILURE', retryable: false, correlationId: 'C' },
            meta: { requestId: 'R', generatedAt: '2026-11-11T12:00:00Z' } }) })
        return
      }
      const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`, headers: { ...route.request().headers(), origin: 'http://127.0.0.1:5173' }, timeout: 120000 })
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(page.url()).origin } })
    })
    await page.routeWebSocket('**/ws/v1', ws => { ws.onMessage(() => {}) })
    await page.route('**/tiles/**', r => r.abort())
    page.on('pageerror', e => errors.push(e.message))
    await page.goto('/login')
    await page.getByTestId('login-username').fill('admin')
    await page.getByTestId('login-password').fill(PASSWORD)
    await page.getByTestId('login-submit').click()
    await page.waitForURL('**/situation')
    await page.goto(`/reports?resultId=${record.resultId}`)
    const panel = page.getByTestId('report-evidence')
    await expect(panel).toBeHidden()
    await expect(page.getByRole('button', { name: '应用精确筛选', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '排障工具与全量导出' }).click()
    await expect(panel).toBeVisible({ timeout: 30000 })
    await panel.getByTestId('report-evidence-load').click()
    const sourceSelect = panel.locator('.report-evidence__bar .el-select').first()
    const totals = panel.getByTestId('report-evidence-totals')
    // 选文件集：其明细请求被扣住（旧上下文在途）。
    await sourceSelect.click(); await page.getByRole('option', { name: /文件集/ }).first().click()
    await expect.poll(() => gated, { timeout: 8000 }).toBe(true)
    // 未释放旧明细前原地切到原生来源；新上下文先完成。
    await page.keyboard.press('Escape'); await page.waitForTimeout(200)
    await sourceSelect.click(); await page.getByRole('option', { name: /原生帧归档/ }).first().click()
    await expect(totals).toContainText('segments 1200')
    // 释放旧文件集明细（迟到失败），不得覆盖新来源明细，也不得冒出旧错误提示。
    release(); await page.waitForTimeout(700)
    await expect(totals).toContainText('segments 1200')
    await expect(totals).not.toContainText('state 1200')
    await expect(panel.getByTestId('report-evidence-message')).toHaveCount(0)
    expect(errors).toEqual([])
    await info.attach('T6-rows-race.txt', { body: `gated=${gated}`, contentType: 'text/plain' })
  } finally {
    release()
    await page.close(); await api.dispose(); await server.close(); ctx.auth.close(); ctx.scenes.close()
    await rm(root, { recursive: true, force: true })
  }
})

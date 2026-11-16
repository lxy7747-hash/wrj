import { expect, test } from '@playwright/test'

// 06→09 联调浏览器验收：真实登录 Cookie + 真实 HTTP（page.route 转发到用例内隔离服务），
// 驱动报告页“报告证据”面板：加载/选来源/明细翻页/曲线/导出 HTML+PDF（全筛选时段，含末点 2398）。
// 不触碰真实 4173/5173 实例；导出文件写到本用例临时目录并回读校验。

const { tsImport } = await import('tsx/esm/' + 'api')
const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/' + 'promises')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { once } = await import('node:' + 'events')
const { createMockServer } = await tsImport('../../server/app.ts', import.meta.url)
const { LocalMissionResults } = await tsImport('../../server/local/mission-results.ts', import.meta.url)
const { ScenarioProjection } = await tsImport('../../server/scenarios/projection.ts', import.meta.url)
const { createRunEvidenceStore } = await tsImport('../../server/local/run-evidence.ts', import.meta.url)
const { exportEvidenceReport } = await tsImport('../../server/local/report-file.ts', import.meta.url)
const { REPORT_EVENT_CSV } = await tsImport('../fixtures/local-report-csv.ts', import.meta.url)
const { POSITION_CSV } = await tsImport('../fixtures/local-replay.ts', import.meta.url)

const ROWS = 1200
const LAST_TIME = (ROWS - 1) * 2 // 2398

test('报告证据 06→09：选来源/明细翻页/曲线，导出 HTML+PDF 覆盖全时段含末点 2398', async ({ page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'wrj-report-evidence-e2e-'))
  const exportsDir = join(root, 'exports')
  const artifacts = join('output', 'r6b_evidence')
  await mkdir(artifacts, { recursive: true })
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
  const RUN_ID = 'RUN-E2E-1', TASK_ID = 'TASK-1'
  // 仅扩大报告时间窗口，使 1200 点（0..2398 秒）落在证据窗口内；并补 runId/taskId 供证据来源绑定。
  const missionResults = {
    list: () => results.list(),
    filter: async () => { throw new Error('FILTER_UNSUPPORTED') },
    get: async (id: string) => {
      const snapshot = await results.get(id)
      return snapshot ? { ...snapshot, record: { ...snapshot.record, runId: RUN_ID, taskId: TASK_ID }, report: { ...snapshot.report, localEvidence: { ...snapshot.report.localEvidence, startTimeS: 0, endTimeS: LAST_TIME + 2 } } } : null
    },
  }

  const scope = { taskId: TASK_ID, runId: RUN_ID, scenarioId: record.scenarioId, revision: record.revision, startedAt: record.startedAt }
  const config = { scenario: { id: record.scenarioId, timeStep: 1 }, platforms: [{ id: 'A' }, { id: 'B' }],
    links: [{ id: 'L-1', type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B', enabled: true }], linkSettings: {} }
  const header = 'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'
  const stateCsv = [header, ...Array.from({ length: ROWS }, (_, index) => `${TASK_ID},1.1,${index * 2},A,B,MICROWAVE,UP,${index % 17 + 1},0.0001,-70`)].join('\n')
  const store = createRunEvidenceStore(join(root, 'evidence'), () => '2026-01-01T00:01:00.000Z')
  const bundle = await store.import({ files: [{ fileName: 'link_state.csv', text: stateCsv }] }, scope, config)

  const server = createMockServer({ port: 0, missionResults, runEvidenceStore: store,
    exportReportEvidence: (input: Parameters<typeof exportEvidenceReport>[1]) => exportEvidenceReport(exportsDir, input) })
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

    const panel = page.getByTestId('report-evidence')
    await expect(panel).toBeHidden()
    await page.getByRole('button', { name: '排障工具与全量导出' }).click()
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await panel.getByTestId('report-evidence-load').click()

    // 选来源（仅一个文件集批次）→ 加载全量统计/明细/曲线。
    const sourceSelect = panel.locator('.report-evidence__bar .el-select').first()
    await expect(sourceSelect).toBeVisible()
    await sourceSelect.click()
    await page.getByRole('option').first().click()

    await expect(panel.getByTestId('report-evidence-totals')).toContainText('state 1200')
    await expect(panel.getByTestId('report-evidence-totals')).toContainText('当前筛选明细：1200 条')
    await expect(panel).toContainText('共 1200 条')
    const rowsLocator = panel.getByTestId('report-evidence-rows').locator('tbody tr')
    await expect(rowsLocator).toHaveCount(200)
    const firstId = await rowsLocator.first().innerText()
    await panel.getByRole('button', { name: '下一页' }).click()
    await expect(rowsLocator).toHaveCount(200)
    await expect.poll(async () => rowsLocator.first().innerText()).not.toBe(firstId)

    // 曲线存在，且有界分段可续取到末段（“曲线下一段”逐段追加为多个有界图，不无限塞入单图）。
    await expect(panel.locator('svg').first()).toBeVisible()
    const nextSegment = panel.getByRole('button', { name: '曲线下一段' })
    let segments = 0
    while (await nextSegment.count()) {
      await nextSegment.click()
      await page.waitForTimeout(150)
      segments += 1
      if (segments > 80) break
    }
    expect(segments).toBeGreaterThan(0)
    expect(await panel.locator('svg').count()).toBeGreaterThan(1)
    await expect(panel).toContainText('第2段')

    // 导出 HTML：download=1 触发真实浏览器下载事件，保存后回读校验（中文/来源/全量计数/末点 2398）。
    const [htmlDownload] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByRole('button', { name: '导出证据 HTML' }).click(),
    ])
    const htmlFilePath = await htmlDownload.path()
    const html = await readFile(htmlFilePath!, 'utf8')
    expect(html).toContain('报告证据')
    expect(html).toContain('state')
    expect(html).toContain('1200')
    expect(html).toContain('2398')
    await htmlDownload.saveAs(join(artifacts, 'evidence.html'))
    await testInfo.attach('evidence-export.html', { body: html, contentType: 'text/html' })

    // 导出 PDF：download=1 真实浏览器下载事件，保存回读 %PDF 与体量（PDF 视觉由 pdfium 单独渲染检查）。
    const [pdfDownload] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByRole('button', { name: '导出证据 PDF' }).click(),
    ])
    const pdfFilePath = await pdfDownload.path()
    const pdf = await readFile(pdfFilePath!)
    expect(pdf.length).toBeGreaterThan(1000)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    await pdfDownload.saveAs(join(artifacts, 'evidence.pdf'))
    await testInfo.attach('evidence-export.pdf', { body: pdf, contentType: 'application/pdf' })

    expect(errors).toEqual([])
    expect(bundle.bundleSha256).toMatch(/^[a-f0-9]{64}$/)
  } finally {
    await page.close(); await server.close(); await rm(root, { recursive: true, force: true })
  }
})

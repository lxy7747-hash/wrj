import { expect, test, type Page } from '@playwright/test'

const { tsImport } = await import('tsx/esm/' + 'api')
const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { once } = await import('node:' + 'events')
const { createMockServer } = await tsImport('../../server/app.ts', import.meta.url)
const { EquipmentSqliteStorage } = await tsImport('../../server/local/equipment-sqlite.ts', import.meta.url)
const { MasterDataSqliteStorage } = await tsImport('../../server/local/master-data-sqlite.ts', import.meta.url)
const { ScenarioSqliteStorage } = await tsImport('../../server/local/scenario-sqlite.ts', import.meta.url)
const { ScenarioProjection } = await tsImport('../../server/scenarios/projection.ts', import.meta.url)

async function chooseSource(page: Page, label: RegExp): Promise<void> {
  await page.getByTestId('link-parameter-select').click()
  await page.getByRole('option', { name: label }).click()
}

async function confirmDeleteLink(page: Page, index: number): Promise<void> {
  await page.getByTestId(`delete-link-${index}`).click()
  const confirmation = page.locator('.el-popconfirm').filter({ hasText: '确认删除该链路及其业务配置？' })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: '删除', exact: true }).click()
}

test('场景链路选择设备、字典和枚举后自动填参并原子保存来源，重载与删除保护一致', async ({ page, request }) => {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-link-parameters-browser-'))
  const scenePath = join(directory, 'scenarios.db')
  const equipmentPath = join(directory, 'equipment.db')
  const masterDataPath = join(directory, 'master-data.db')
  const scenes = new ScenarioSqliteStorage(scenePath, { equipmentPath, masterDataPath })
  const equipment = new EquipmentSqliteStorage(equipmentPath, scenePath)
  const master = new MasterDataSqliteStorage(masterDataPath)
  const original = new ScenarioProjection().get('SCN-001')
  if (!original.ok) throw new Error('缺少测试基准场景')
  scenes.save(original.data, undefined)
  const server = createMockServer({ port: 0, equipmentStorage: equipment, masterDataStorage: master, scenarioStorage: scenes })
  const errors: string[] = []
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
    const eq = await request.post(`${origin}/api/v1/admin/equipment`, { headers, data: {
      equipmentId: 'EQ-SCENE-BROWSER', type: '微波通信设备', frequencyMinMHz: null, frequencyMaxMHz: null,
      bandwidthMHz: 5, txPowerW: 30, dataRateMbps: 80, modulation: 'QPSK', berThreshold: 0.00001, active: true, readOnly: false, version: 1,
    } })
    expect(eq.status()).toBe(201)
    const incompatible = await request.post(`${origin}/api/v1/admin/equipment`, { headers, data: {
      equipmentId: 'EQ-INCOMPATIBLE-BROWSER', type: '微波通信设备', frequencyMinMHz: 9999, frequencyMaxMHz: 10000,
      bandwidthMHz: 5, txPowerW: 30, dataRateMbps: 80, modulation: 'QPSK', berThreshold: 0.00001, active: true, readOnly: false, version: 1,
    } })
    expect(incompatible.status()).toBe(201)
    const satellite = await request.post(`${origin}/api/v1/admin/equipment`, { headers, data: {
      equipmentId: 'EQ-SATELLITE-BROWSER', type: '卫星通信设备', frequencyMinMHz: null, frequencyMaxMHz: null,
      bandwidthMHz: 5, txPowerW: 30, dataRateMbps: 0.016, modulation: 'QPSK', berThreshold: 0.00001, active: true, readOnly: false, version: 1,
    } })
    expect(satellite.status()).toBe(201)
    const duplicated = await request.post(`${origin}/api/v1/admin/master-data`, { headers, data: { operation: 'CREATE', data: {
      dataId: 'DICT-EQUIPMENT-DUPLICATE', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
      content: { name: '重复设备参数测试', description: '', entries: [{ key: 'bandwidthMHz', valueType: 'NUMBER', value: 5 }] },
    } } })
    expect(duplicated.status()).toBe(422)
    expect((await duplicated.json()).error.fieldPath).toBe('data.content.entries[0].key')
    for (const data of [
      { dataId: 'DICT-SCENE-BROWSER', kind: 'PARAMETER_DICTIONARY', content: { name: '卫星字典', description: '', entries: [
        { key: 'noiseFigureDb', valueType: 'NUMBER', value: 6, unit: 'dB' }, { key: 'ignoredField', valueType: 'NUMBER', value: 99 },
      ] } },
      { dataId: 'ENUM-SCENE-BROWSER', kind: 'ENUMERATION', content: { name: '调制选项', description: '', entries: [
        { key: 'modulation.BPSK', valueType: 'TEXT', value: 'BPSK' }, { key: 'modulation.QPSK', valueType: 'TEXT', value: 'QPSK' },
      ] } },
    ]) {
      const response = await request.post(`${origin}/api/v1/admin/master-data`, { headers, data: { operation: 'CREATE', data: { ...data, version: 1, referenceCount: 0, active: true } } })
      expect(response.status()).toBe(201)
    }
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url())
      const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`, headers: { ...route.request().headers(), origin: headers.Origin } })
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': new URL(page.url()).origin } })
    })
    let subscribed!: () => void
    const realtimeReady = new Promise<void>(resolve => { subscribed = resolve })
    await page.routeWebSocket('**/ws/v1*', socket => {
      socket.onMessage(message => {
        const request = JSON.parse(message.toString())
        if (request.type === 'subscribe') {
          socket.send(JSON.stringify({ type: 'subscribed', schemaVersion: '1.0', taskId: request.taskId, topics: request.topics, lastSequence: 0, nextSequence: 1 }))
          subscribed()
        }
      })
    })
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/login')
    await page.getByTestId('login-username').fill('operator')
    await page.getByTestId('login-password').fill('123456')
    await page.getByTestId('login-submit').click()
    await page.waitForURL('**/situation')
    await realtimeReady
    await page.getByRole('link', { name: '场景配置', exact: true }).click()
    await page.getByTestId('scene-edit-SCN-001').click()
    await page.getByTestId('scenario-name').fill('仅保留在本地的场景修改')
    const executionRequests: string[] = []
    let linkSaveRequests = 0
    page.on('request', request => {
      if (request.method() === 'POST' && /\/scripts\/|\/simulations\/.*\/commands/.test(new URL(request.url()).pathname)) executionRequests.push(request.url())
      if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/v1/scenarios/SCN-001') linkSaveRequests += 1
    })
    const saveLink = async () => {
      const saved = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/v1/scenarios/SCN-001')
      await page.getByTestId('apply-link').click()
      expect((await saved).status()).toBe(200)
      await expect(page.getByTestId('apply-link')).toBeHidden()
    }
    await page.getByRole('tab', { name: '链路配置', exact: true }).click()
    await page.getByTestId('edit-link-0').click()
    await page.getByTestId('link-parameter-refresh').click()
    await page.getByTestId('link-parameter-select').click()
    const satelliteForMicrowave = page.getByRole('option', { name: /EQ-SATELLITE-BROWSER.*类型不匹配/ })
    await expect(satelliteForMicrowave).toBeDisabled()
    await expect(satelliteForMicrowave).toHaveAttribute('title', '设备类型与当前链路类型不一致，不能引用。')
    await expect(page.getByRole('option', { name: /EQ-SCENE-BROWSER/, exact: false })).toBeEnabled()
    await page.keyboard.press('Escape')
    await page.getByTestId('link-type').click()
    await page.getByRole('option', { name: '卫星链路', exact: true }).click()
    await page.getByTestId('link-parameter-select').click()
    await expect(page.getByRole('option', { name: /EQ-SATELLITE-BROWSER/, exact: false })).toBeEnabled()
    await expect(page.getByRole('option', { name: /EQ-SCENE-BROWSER.*类型不匹配/ })).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.getByTestId('cancel-link').click()
    await page.getByTestId('edit-link-0').click()
    await page.getByTestId('link-parameter-refresh').click()
    await chooseSource(page, /EQ-INCOMPATIBLE-BROWSER/)
    await expect(page.getByTestId('link-parameter-selection-error')).toContainText('当前链路频率不在装备支持范围')
    await expect(page.getByTestId('link-parameter-applied')).toHaveCount(0)
    await expect(page.getByTestId('apply-link')).toBeDisabled()
    expect(linkSaveRequests).toBe(0)
    await chooseSource(page, /EQ-SCENE-BROWSER/)
    await expect(page.getByTestId('link-parameter-preview')).toContainText('发射带宽：5')
    await expect(page.getByTestId('link-parameter-preview')).toContainText('数据速率：80 Mbps')
    await expect(page.getByTestId('link-data-rate')).toHaveValue('80 Mbps')
    await expect(page.getByTestId('link-parameter-apply')).toHaveCount(0)
    await expect(page.getByTestId('link-bandwidth').locator('input')).toHaveValue('5')
    await page.getByTestId('cancel-link').click()
    await page.getByTestId('edit-link-0').click()
    await expect(page.getByTestId('link-parameter-applied')).toHaveCount(0)
    await page.getByTestId('link-parameter-refresh').click()
    await chooseSource(page, /EQ-SCENE-BROWSER/)
    await expect(page.getByTestId('link-bandwidth').locator('input')).toHaveValue('5')
    await saveLink()
    expect(scenes.load('SCN-001')!.config.links[0].parameterSource?.sourceId).toBe('EQ-SCENE-BROWSER')
    expect(equipment.details('EQ-SCENE-BROWSER').references).toHaveLength(1)
    await page.getByTestId('edit-link-0').click()
    await expect(page.getByTestId('link-parameter-applied')).toContainText('EQ-SCENE-BROWSER · v1')
    await expect(page.getByTestId('link-parameter-select')).toContainText('微波通信设备 · EQ-SCENE-BROWSER')
    await expect(page.getByTestId('link-parameter-select')).not.toContainText(/ · v\d+/)
    await expect(page.getByTestId('link-bandwidth').locator('input')).toHaveValue('5')
    await page.getByTestId('cancel-link').click()
    const savesBeforeReferencedDelete = linkSaveRequests
    await confirmDeleteLink(page, 0)
    await expect(page.getByText('该链路仍引用基础数据，请先编辑链路，取消引用并保存后再删除。', { exact: true })).toBeVisible()
    await expect(page.getByTestId('edit-link-0')).toBeVisible()
    expect(linkSaveRequests).toBe(savesBeforeReferencedDelete)

    await page.getByTestId('edit-link-1').click()
    await page.getByTestId('link-parameter-refresh').click()
    await chooseSource(page, /DICT-SCENE-BROWSER/)
    await expect(page.getByTestId('link-parameter-preview')).toContainText('ignoredField：不是受支持的链路参数字段')
    await expect(page.getByTestId('link-noise-figure').locator('input')).toHaveValue('6')
    await saveLink()
    expect(master.details('DICT-SCENE-BROWSER').references).toHaveLength(1)
    await page.getByTestId('edit-link-1').click()
    await expect(page.getByTestId('link-parameter-applied')).toContainText('DICT-SCENE-BROWSER · v1')
    await expect(page.getByTestId('link-parameter-select')).toContainText('卫星字典 · DICT-SCENE-BROWSER')
    await expect(page.getByTestId('link-noise-figure').locator('input')).toHaveValue('6')
    await page.getByTestId('cancel-link').click()
    await page.getByTestId('edit-link-2').click()
    await page.getByTestId('link-parameter-refresh').click()
    await chooseSource(page, /EQ-SATELLITE-BROWSER/)
    await expect(page.getByTestId('link-parameter-preview')).toContainText('数据速率：16 kbps')
    await saveLink()
    await page.getByTestId('edit-link-2').click()
    await expect(page.getByTestId('link-parameter-applied')).toContainText('EQ-SATELLITE-BROWSER · v1')
    await page.getByTestId('cancel-link').click()
    await page.getByTestId('edit-link-2').click()
    await page.getByTestId('link-parameter-refresh').click()
    await chooseSource(page, /ENUM-SCENE-BROWSER/)
    await expect(page.getByTestId('link-parameter-apply')).toHaveCount(0)
    await page.getByTestId('link-parameter-entry').click()
    await page.getByRole('option', { name: 'modulation.QPSK：QPSK', exact: true }).click()
    await expect(page.getByTestId('link-modulation')).toContainText('QPSK')
    await saveLink()
    await page.getByTestId('edit-link-2').click()
    await expect(page.getByTestId('link-parameter-applied')).toContainText('ENUM-SCENE-BROWSER · v1')
    await expect(page.getByTestId('link-parameter-select')).toContainText('调制选项 · ENUM-SCENE-BROWSER')
    await expect(page.getByTestId('link-modulation')).toContainText('QPSK')
    await page.getByTestId('cancel-link').click()
    const persisted = scenes.load('SCN-001')!
    expect(persisted.config.links[0]).toMatchObject({ bandwidth: 5, txPower: 30, dataRate: 80, parameterSource: { kind: 'EQUIPMENT', sourceId: 'EQ-SCENE-BROWSER', sourceVersion: 1 } })
    expect(persisted.config.links[1]).toMatchObject({ noiseFigureDb: 6, bandwidth: original.data.config.links[1].bandwidth, parameterSource: { kind: 'MASTER_DATA', sourceId: 'DICT-SCENE-BROWSER' } })
    expect(persisted.config.links[2]).toMatchObject({ modulation: 'QPSK', parameterSource: { entryKey: 'modulation.QPSK' } })
    expect(equipment.details('EQ-SCENE-BROWSER').references).toHaveLength(1)
    expect(master.details('DICT-SCENE-BROWSER').references).toHaveLength(1)
    expect(persisted.config.scenario.name).toBe(original.data.config.scenario.name)
    await page.locator('#tab-scenario').click()
    await expect(page.getByTestId('scenario-name')).toHaveValue('仅保留在本地的场景修改')
    expect(executionRequests).toEqual([])
    for (const [objectId, path] of [
      ['EQUIPMENT:EQ-SCENE-BROWSER:1', 'equipment/EQ-SCENE-BROWSER?expectedVersion=1'],
      ['DICT-SCENE-BROWSER', 'master-data/DICT-SCENE-BROWSER'],
    ]) {
      const created = await request.post(`${origin}/api/v1/confirmations`, { headers, data: { action: 'MASTER_DATA_DELETE', objectId } })
      expect(created.ok()).toBe(true)
      const id = (await created.json()).data.confirmationId
      expect((await request.post(`${origin}/api/v1/confirmations/${id}`, { headers, data: { confirm: true } })).ok()).toBe(true)
      expect((await request.delete(`${origin}/api/v1/admin/${path}`, { headers: { ...headers, 'X-Confirmation-Id': id } })).status()).toBe(409)
    }
    await page.reload()
    await page.getByTestId('scene-edit-SCN-001').click()
    await page.getByRole('tab', { name: '链路配置', exact: true }).click()
    await page.getByTestId('edit-link-0').click()
    await expect(page.getByTestId('link-parameter-applied')).toContainText('EQ-SCENE-BROWSER · v1')
    await expect(page.getByTestId('link-parameter-select')).toContainText('微波通信设备 · EQ-SCENE-BROWSER')
    await expect(page.getByTestId('link-data-rate')).toHaveValue('80 Mbps')
    await expect(page.getByTestId('link-bandwidth').locator('input')).toHaveValue('5')
    await page.getByTestId('cancel-link').click()
    await page.getByTestId('edit-link-1').click()
    await expect(page.getByTestId('link-parameter-select')).toContainText('卫星字典 · DICT-SCENE-BROWSER')
    await expect(page.getByTestId('link-noise-figure').locator('input')).toHaveValue('6')
    await page.getByTestId('cancel-link').click()
    await page.getByTestId('edit-link-2').click()
    await expect(page.getByTestId('link-parameter-select')).toContainText('调制选项 · ENUM-SCENE-BROWSER')
    await expect(page.getByTestId('link-modulation')).toContainText('QPSK')
    await page.getByTestId('cancel-link').click()
    await page.getByTestId('edit-link-0').click()
    await page.getByTestId('link-parameter-clear').click()
    await saveLink()
    expect(scenes.load('SCN-001')!.config.links[0].parameterSource).toBeUndefined()
    const savesBeforeUnreferencedDelete = linkSaveRequests
    await confirmDeleteLink(page, 0)
    await expect(page.locator('[data-testid^="edit-link-"]')).toHaveCount(original.data.config.links.length - 1)
    expect(linkSaveRequests).toBe(savesBeforeUnreferencedDelete)
    expect(executionRequests).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await page.close()
    await server.close()
    scenes.close()
    equipment.close()
    master.close()
    await rm(directory, { recursive: true, force: true })
  }
})

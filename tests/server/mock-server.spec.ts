import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ApiSuccess, AuditRecord, ConfirmationAction, ConfirmationContext, MasterData, Report, ScenarioDraft, ScenarioTemplate, ScriptContract, ValidationResult } from '../../src/contracts/domain-models'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'

const ORIGIN = 'http://127.0.0.1:5173'

describe('链路补项保存与快照', () => {
  it('新字段经 PUT、回读、模板和导入保留，重置后可撤销恢复', async () => {
    const { baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }
    const path = '/api/v1/scenarios/SCN-001'
    const original = ((await request(baseUrl).get(path).set(headers).expect(200)).body as ApiSuccess<ScenarioDraft>).data
    const config = structuredClone(original.config)
    config.linkSettings = readLinkSettings(config)
    const [disabledLink, enabledLink] = config.links.filter(link => link.type === 'MICROWAVE')
    disabledLink!.enabled = false
    enabledLink!.enabled = true
    config.linkSettings.switchCooldownS = 12
    config.linkSettings.priority = ['SAT', 'DATALINK', 'MICROWAVE', 'LASER']
    const satellite = config.platforms.find(p => p.type === 'COMMUNICATION_SATELLITE')!
    const link = config.links.find(l => l.type === 'SAT')!
    Object.assign(link, { antennaGainCorrectionDb: -2, coding: 'UNCODED', antiJammingGainDb: 6, spatialIsolationDb: 3, relayPlatformId: satellite.id })
    const saved = ((await request(baseUrl).put(path).set(headers).send({ config, uiExtensions: original.uiExtensions }).expect(200)).body as ApiSuccess<ScenarioDraft>).data
    expect(saved.config.linkSettings).toEqual(config.linkSettings)
    expect(saved.config.links).toEqual(config.links)
    expect(saved.config.links.find(link => link.id === disabledLink!.id)?.enabled).toBe(false)
    expect(saved.config.links.find(link => link.id === enabledLink!.id)?.enabled).toBe(true)
    expect(((await request(baseUrl).get(path).set(headers).expect(200)).body as ApiSuccess<ScenarioDraft>).data).toEqual(saved)
    const template = await request(baseUrl).post('/api/v1/templates').set(headers).send({ name: '链路配置模板', config: saved.config }).expect(201)
    expect((template.body as ApiSuccess<ScenarioTemplate>).data.config).toEqual(saved.config)
    const imported = await request(baseUrl).post('/api/v1/scenarios/import').set(headers).send({ items: [saved.config] }).expect(200)
    const importedDraft = (imported.body as ApiSuccess<{ drafts: ScenarioDraft[] }>).data.drafts[0]!
    expect(importedDraft.config).toEqual(saved.config)
    const reset = await request(baseUrl).post(`${path}/reset`).set(headers).send({ expectedRevision: importedDraft.revision }).expect(200)
    const resetDraft = (reset.body as ApiSuccess<ScenarioDraft>).data
    expect(resetDraft.config.linkSettings).toBeUndefined()
    const undone = await request(baseUrl).post(`${path}/undo`).set(headers).send({ expectedRevision: resetDraft.revision }).expect(200)
    expect((undone.body as ApiSuccess<ScenarioDraft>).data.config).toEqual(saved.config)
    const invalid = structuredClone(saved.config)
    invalid.links.find(l => l.id === link.id)!.relayPlatformId = config.platforms[0]!.id
    const rejected = await request(baseUrl).put(path).set(headers).send({ config: invalid, uiExtensions: original.uiExtensions }).expect(422)
    expect((rejected.body as { error: { fieldPath: string } }).error.fieldPath).toMatch(/relayPlatformId$/)
    expect(((await request(baseUrl).get(path).set(headers).expect(200)).body as ApiSuccess<ScenarioDraft>).data.config).toEqual(saved.config)
    const cleared = structuredClone(saved.config)
    cleared.links.find(l => l.id === link.id)!.coding = null
    const clearedResult = await request(baseUrl).put(path).set(headers).send({ config: cleared, uiExtensions: original.uiExtensions }).expect(200)
    expect((clearedResult.body as ApiSuccess<ScenarioDraft>).data.config.links.find(l => l.id === link.id)?.coding).toBeNull()
    const reloaded = await request(baseUrl).get(path).set(headers).expect(200)
    expect((reloaded.body as ApiSuccess<ScenarioDraft>).data.config).toEqual(cleared)
  })
})

describe('卫星子类型写入边界', () => {
  it('旧卫星可读取，但即使完成警告确认也不能绕过子类型校验生成脚本', async () => {
    const { baseUrl, server } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }
    const original = await request(baseUrl).get('/api/v1/scenarios/SCN-001').set(headers).expect(200)
    const legacy = structuredClone((original.body as ApiSuccess<ScenarioDraft>).data)
    const index = legacy.config.platforms.findIndex(({ type }) => type === 'COMMUNICATION_SATELLITE')
    delete legacy.config.platforms[index]!.satelliteType
    // 模拟历史存储读取，不能通过已经收紧的 PUT 人为写入非法新数据。
    const modulePath = '../../server/scenarios/' + 'projection.js'
    const { ScenarioProjection } = await import(modulePath) as {
      ScenarioProjection: { prototype: { get(scenarioId: string): unknown } }
    }
    const read = vi.spyOn(ScenarioProjection.prototype, 'get').mockReturnValue({ ok: true, data: legacy })
    try {
      const loaded = await request(baseUrl).get('/api/v1/scenarios/SCN-001').set(headers).expect(200)
      expect((loaded.body as ApiSuccess<ScenarioDraft>).data).toEqual(legacy)
      const confirmation = await request(baseUrl).post('/api/v1/confirmations').set(headers)
        .send({ action: 'SCENARIO_WARNING_CONTINUE', objectId: 'SCN-001' }).expect(201)
      const { confirmationId } = (confirmation.body as ApiSuccess<ConfirmationContext>).data
      await request(baseUrl).post(`/api/v1/confirmations/${confirmationId}`).set(headers).send({ confirm: true }).expect(200)
      const preview = await request(baseUrl).post('/api/v1/scripts/preview').set(headers)
        .send({ scenarioId: 'SCN-001', warningConfirmationId: confirmationId }).expect(422)
      expect(preview.body).toMatchObject({ ok: false, error: {
        code: 'VALIDATION_FAILED', fieldPath: `platforms[${index}].satelliteType`,
        message: '通信卫星必须选择天通卫星或神通卫星。',
      } })
      expect(preview.body).not.toHaveProperty('data')
      expect(legacy.config.platforms[index]).not.toHaveProperty('satelliteType')
      expect(server.auditSnapshot()).toContainEqual(expect.objectContaining({ action: 'SCRIPT_PREVIEW', result: 'ERROR' }))
    } finally {
      read.mockRestore()
    }
  })

  it.each([undefined, 'UNKNOWN'])('PUT、导入和模板维护拒绝子类型 %s 且不改变服务端草稿', async (satelliteType) => {
    const { baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }
    const read = async () => (await request(baseUrl).get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body as ApiSuccess<ScenarioDraft>
    const original = (await read()).data
    const config = structuredClone(original.config)
    const index = config.platforms.findIndex(({ type }) => type === 'COMMUNICATION_SATELLITE')
    delete config.platforms[index]!.satelliteType
    if (satelliteType !== undefined) config.platforms[index]!.satelliteType = satelliteType as never
    const put = await request(baseUrl).put('/api/v1/scenarios/SCN-001').set(headers).send({ config, uiExtensions: original.uiExtensions }).expect(422)
    expect(put.body).toMatchObject({ error: { fieldPath: `platforms[${index}].satelliteType` } })
    const imported = await request(baseUrl).post('/api/v1/scenarios/import').set(headers).send({ items: [config] }).expect(422)
    expect(imported.body).toMatchObject({ error: { fieldPath: `items[0].platforms[${index}].satelliteType` } })
    await request(baseUrl).post('/api/v1/templates').set(headers).send({ name: '非法卫星模板', config }).expect(422)
    await request(baseUrl).put('/api/v1/templates/TPL-SCN-001').set(headers).send({ name: '非法卫星模板', config }).expect(422)
    expect((await read()).data).toEqual(original)
  })
})

describe('P8 元数据与确定性重置', () => {
  const headers = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }

  it('三个新增目录兑现既有合同，拒绝匿名并允许两种角色读取', async () => {
    const { baseUrl } = await startServer()
    for (const [section, count] of [['capabilities', 29], ['decisions', 8], ['routes', 11]] as const) {
      await request(baseUrl).get(`/api/v1/meta/${section}`).set('Origin', ORIGIN).expect(403)
      for (const role of ['ADMIN', 'OPERATOR']) {
        const result = await request(baseUrl).get(`/api/v1/meta/${section}`).set({ ...headers, 'X-Demo-Role': role }).expect(200)
        expect((result.body as { data: unknown[] }).data).toHaveLength(count)
      }
    }
  })

  it('修改草稿、运行、回放、确认和 WS 序号后，reset 恢复同一条完整响应链', async () => {
    const { baseUrl, wsUrl, server } = await startServer()
    const get = async (path: string) => (await request(baseUrl).get(`/api/v1/${path}`).set(headers).expect(200)).body
    const reset = () => request(baseUrl).post('/api/v1/reset').set(headers).send({ confirm: true }).expect(200)
    const read = async () => ({
      scene: await get('scenarios/SCN-001'), run: await get('simulations'), frame: await get('simulations/RUN-001/frames/F-00042'),
      events: await get('simulations/RUN-001/events'), replay: await get('replays/REPLAY-001'), report: await get('reports/RPT-001'),
      archive: await get('admin/archives'), batch: await get('batches/BATCH-001'), source: server.projection.snapshot(),
    })
    const firstReset = await reset()
    const first = await read()
    const frame = (first.frame as { data: { frameId: string; simulationTime: number } }).data
    expect(frame).toMatchObject({ frameId: 'F-00042', simulationTime: 42 })
    const client = await openWebSocket(wsUrl, { role: 'ADMIN' })
    const initial = nextJsonMessages(client, 2)
    client.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['runtime.state'], lastSequence: 0 }))
    const initialMessages = await initial
    const draft = (first.scene as ApiSuccess<ScenarioDraft>).data
    const config = structuredClone(draft.config); config.scenario.name = 'P8 临时修改'
    await request(baseUrl).put('/api/v1/scenarios/SCN-001').set(headers).send({ config, uiExtensions: draft.uiExtensions }).expect(200)
    const broadcast = nextJsonMessage(client)
    await request(baseUrl).post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
    expect(await broadcast).toMatchObject({ sequence: 2 })
    await request(baseUrl).post('/api/v1/replays/REPLAY-001/commands').set(headers).send({ command: 'SEEK', value: 20 }).expect(200)
    const confirmation = await request(baseUrl).post('/api/v1/confirmations').set(headers).send({ action: 'FULL_CONFIG_EXPORT', objectId: 'FULL-CONFIG' }).expect(201)
    client.close()
    const secondReset = await reset()
    expect(secondReset.body).toEqual(firstReset.body)
    expect(await read()).toEqual(first)
    const confirmationId = (confirmation.body as ApiSuccess<ConfirmationContext>).data.confirmationId
    await request(baseUrl).post(`/api/v1/confirmations/${confirmationId}`).set(headers).send({ confirm: true }).expect(409)
    const nextClient = await openWebSocket(wsUrl, { role: 'ADMIN' })
    const nextInitial = nextJsonMessages(nextClient, 2)
    nextClient.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['runtime.state'], lastSequence: 0 }))
    expect(await nextInitial).toEqual(initialMessages)
    nextClient.close()
  })
})

describe('P7 系统维护接口', () => {
  const headers = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }
  const master: MasterData = { dataId: 'DEVICE-P7', kind: 'DEVICE', version: 1, referenceCount: 0, active: true }

  it('独立限制每条维护接口的角色，禁止绕过页面权限', async () => {
    const { baseUrl } = await startServer()
    for (const role of ['', 'OPERATOR', 'UNKNOWN']) {
      for (const [method, path] of [
        ['get', 'master-data'], ['post', 'master-data'], ['put', 'master-data/MW-COMM'], ['delete', 'master-data/MW-COMM'],
        ['get', 'backups'], ['post', 'backup'], ['post', 'restore'], ['get', 'archives'], ['get', 'health'], ['post', 'config/export'],
      ] as const) {
        const call = request(baseUrl)[method](`/api/v1/admin/${path}`).set('Origin', ORIGIN)
        if (role) call.set('X-Demo-Role', role)
        await call.expect(403)
      }
    }
  })

  it('主数据创建、版本更新、引用保护和删除均保持服务端约束', async () => {
    const { baseUrl, server } = await startServer()
    const collection = '/api/v1/admin/master-data'
    const initial = await request(baseUrl).get(collection).set(headers).expect(200)
    await request(baseUrl).post(collection).set(headers).send({ operation: 'CREATE', data: master }).expect(201)
    await request(baseUrl).post(collection).set(headers).send({ operation: 'CREATE', data: master }).expect(409)
    const updated = await request(baseUrl).put(`${collection}/${master.dataId}`).set(headers).send({ operation: 'UPDATE', data: { ...master, active: false } }).expect(200)
    expect(updated.body).toMatchObject({ data: { version: 2, active: false } })
    await request(baseUrl).put(`${collection}/${master.dataId}`).set(headers).send({ operation: 'UPDATE', data: master }).expect(409)
    await request(baseUrl).put(`${collection}/MISSING`).set(headers).send({ operation: 'UPDATE', data: { ...master, dataId: 'MISSING' } }).expect(404)
    await request(baseUrl).put(`${collection}/WRONG`).set(headers).send({ operation: 'UPDATE', data: master }).expect(422)
    for (const body of [{}, { operation: 'CREATE', data: { ...master, dataId: 3 } }, { operation: 'CREATE', data: { ...master, dataId: 'NEW', version: 2 } }, { operation: 'CREATE', data: { ...master, dataId: 'NEW', referenceCount: 1 } }, { operation: 'CREATE', data: master, confirmationId: '' }]) {
      await request(baseUrl).post(collection).set(headers).send(body).expect(422)
    }
    await request(baseUrl).put(`${collection}/MW-COMM`).set(headers).send({ operation: 'UPDATE', data: { ...master, dataId: 'MW-COMM', version: 4 } }).expect(422)
    await request(baseUrl).delete(`${collection}/${master.dataId}`).set(headers).expect(428)
    const protectedId = await confirmMaintenance(baseUrl, 'MASTER_DATA_DELETE', 'MW-COMM')
    await request(baseUrl).delete(`${collection}/MW-COMM`).set(headers).set('X-Confirmation-Id', protectedId).expect(409)
    const missingId = await confirmMaintenance(baseUrl, 'MASTER_DATA_DELETE', 'MISSING')
    await request(baseUrl).delete(`${collection}/MISSING`).set(headers).set('X-Confirmation-Id', missingId).expect(404)
    const id = await confirmMaintenance(baseUrl, 'MASTER_DATA_DELETE', master.dataId)
    const deleted = await request(baseUrl).delete(`${collection}/${master.dataId}`).set(headers).set('X-Confirmation-Id', id).expect(200)
    expect(deleted.body).toMatchObject({ data: { deleted: true, objectId: master.dataId } })
    await request(baseUrl).delete(`${collection}/${master.dataId}`).set(headers).set('X-Confirmation-Id', id).expect(409)
    expect((await request(baseUrl).get(collection).set(headers).expect(200)).body).toEqual(initial.body)
    expect(server.auditSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'MASTER_DATA_UPDATE', result: 'SUCCESS' }),
      expect.objectContaining({ action: 'MASTER_DATA_DELETE', objectId: 'MW-COMM', result: 'ERROR' }),
    ]))
  })

  it('备份、完整性失败、恢复回滚与完整配置导出使用独立确认并可重置', async () => {
    const { baseUrl, server } = await startServer()
    const initial = await request(baseUrl).get('/api/v1/admin/backups').set(headers).expect(200)
    const id = await confirmMaintenance(baseUrl, 'BACKUP_RESTORE', 'BACKUP:NEW')
    await request(baseUrl).post('/api/v1/admin/restore').set(headers).send({ operation: 'RESTORE', backupId: 'PREBACKUP-002', confirmationId: id }).expect(409)
    const backup = await request(baseUrl).post('/api/v1/admin/backup').set(headers).send({ operation: 'BACKUP', confirmationId: id }).expect(200)
    expect(backup.body).toMatchObject({ data: { backupId: 'BACKUP-P7-001', status: 'VALID_FIXTURE' } })
    await request(baseUrl).post('/api/v1/admin/backup').set(headers).send({ operation: 'BACKUP', confirmationId: id }).expect(409)
    const duplicate = await confirmMaintenance(baseUrl, 'BACKUP_RESTORE', 'BACKUP:PREBACKUP-002')
    await request(baseUrl).post('/api/v1/admin/backup').set(headers).send({ operation: 'BACKUP', backupId: 'PREBACKUP-002', confirmationId: duplicate }).expect(409)
    for (const [backupId, result, rolledBack, integrityValid] of [
      ['BACKUP-P7-001', 'SUCCESS', false, true], ['BACKUP-CORRUPT-001', 'FAILURE', false, false], ['BACKUP-ROLLBACK-001', 'FAILURE', true, true],
    ] as const) {
      const confirmationId = await confirmMaintenance(baseUrl, 'BACKUP_RESTORE', `RESTORE:${backupId}`)
      const restored = await request(baseUrl).post('/api/v1/admin/restore').set(headers).send({ operation: 'RESTORE', backupId, confirmationId }).expect(200)
      expect(restored.body).toMatchObject({ data: { prebackupId: 'PREBACKUP-002', result, rolledBack, integrityValid, progress: integrityValid ? 100 : 0, generated: false } })
    }
    const missing = await confirmMaintenance(baseUrl, 'BACKUP_RESTORE', 'RESTORE:MISSING')
    await request(baseUrl).post('/api/v1/admin/restore').set(headers).send({ operation: 'RESTORE', backupId: 'MISSING', confirmationId: missing }).expect(404)
    const exportId = await confirmMaintenance(baseUrl, 'FULL_CONFIG_EXPORT', 'FULL-CONFIG')
    const exported = await request(baseUrl).post('/api/v1/admin/config/export').set(headers).send({ format: 'JSON', confirmationId: exportId }).expect(200)
    expect(exported.body).toMatchObject({ data: { objectId: 'FULL-CONFIG', generated: false, classification: 'INTERNAL' } })
    const resetId = await confirmMaintenance(baseUrl, 'BACKUP_RESTORE', 'BACKUP:NEW')
    expect(server.auditSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'BACKUP_RESTORE', result: 'ERROR' })]))
    await request(baseUrl).post('/api/v1/reset').set(headers).send({ confirm: true }).expect(200)
    expect((await request(baseUrl).get('/api/v1/admin/backups').set(headers).expect(200)).body).toEqual(initial.body)
    await request(baseUrl).post('/api/v1/admin/backup').set(headers).send({ operation: 'BACKUP', confirmationId: resetId }).expect(409)
  })

  it('拒绝创建点路径编号并保留原主数据目录', async () => {
    const { baseUrl } = await startServer()
    const collection = '/api/v1/admin/master-data'
    const initial = await request(baseUrl).get(collection).set(headers).expect(200)
    for (const dataId of ['.', '..']) {
      const rejected = await request(baseUrl).post(collection).set(headers)
        .send({ operation: 'CREATE', data: { ...master, dataId } }).expect(422)
      expect(rejected.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    }
    expect((await request(baseUrl).get(collection).set(headers).expect(200)).body).toEqual(initial.body)
  })

  it('拒绝维护写入的无效形状、缺失确认和已过期确认', async () => {
    let now = '2026-08-06T08:00:00Z'
    const { baseUrl } = await startServer({ confirmationClock: { now: () => now, expiresAt: () => '2026-08-06T08:05:00Z' } })
    for (const [path, body] of [
      ['backup', {}], ['backup', { operation: 'RESTORE' }], ['backup', { operation: 'BACKUP', backupId: '' }],
      ['restore', {}], ['restore', { operation: 'BACKUP', backupId: 'A' }], ['restore', { operation: 'RESTORE', backupId: '' }],
      ['config/export', {}], ['config/export', { format: 'XML' }],
    ]) await request(baseUrl).post(`/api/v1/admin/${path}`).set(headers).send(body).expect(422)
    for (const [path, body] of [
      ['backup', { operation: 'BACKUP' }], ['restore', { operation: 'RESTORE', backupId: 'PREBACKUP-002' }], ['config/export', { format: 'JSON' }],
    ]) await request(baseUrl).post(`/api/v1/admin/${path}`).set(headers).send(body).expect(428)
    const id = await confirmMaintenance(baseUrl, 'BACKUP_RESTORE', 'BACKUP:NEW')
    now = '2026-08-06T08:06:00Z'
    await request(baseUrl).post('/api/v1/admin/backup').set(headers).send({ operation: 'BACKUP', confirmationId: id }).expect(409)
    const archive = await request(baseUrl).get('/api/v1/admin/archives').set(headers).expect(200)
    expect(archive.body).toMatchObject({ data: [{ taskId: 'TASK-001', scenarioId: 'SCN-001', runId: 'RUN-001', replayId: 'REPLAY-001', reportId: 'RPT-001' }] })
    const health = await request(baseUrl).get('/api/v1/admin/health').set(headers).expect(200)
    expect(health.body).toMatchObject({ data: { ui: 'HEALTHY', engine: 'NOT_CONNECTED_BY_DESIGN', database: 'NOT_CONNECTED_BY_DESIGN', channel: 'NOT_CONNECTED_BY_DESIGN' } })
  })
})


/** 为系统维护操作建立并确认与对象绑定的一次性上下文。 */
async function confirmMaintenance(baseUrl: string, action: ConfirmationAction, objectId: string): Promise<string> {
  const headers = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }
  const created = await request(baseUrl).post('/api/v1/confirmations').set(headers).send({ action, objectId }).expect(201)
  const id = (created.body as { data: ConfirmationContext }).data.confirmationId
  await request(baseUrl).post(`/api/v1/confirmations/${id}`).set(headers).send({ confirm: true }).expect(200)
  return id
}

interface MockProjectionInstance {
  snapshot(): unknown
  reset(): unknown
  nextSequence(taskId: string, topic: string): number
}

interface ListenerAddress {
  address: string
  family: string
  port: number
}

interface HttpServerInstance {
  listening: boolean
  once(event: string, listener: (...args: unknown[]) => void): unknown
  address(): ListenerAddress | string | null
  close(callback: (error?: Error) => void): this
}

interface IsolatedHttpServerInstance extends HttpServerInstance {
  listen(port: number, host: string): this
  removeAllListeners(): this
}

interface MockServerInstance {
  httpServer: HttpServerInstance
  projection: MockProjectionInstance
  auditSnapshot(): AuditRecord[]
  close(): Promise<void>
}

interface HttpResponse {
  body: unknown
  headers: Record<string, string | string[] | undefined>
}

interface RequestChain {
  set(name: string, value: string): this
  set(fields: Record<string, string>): this
  send(body: unknown): this
  expect(status: number): Promise<HttpResponse>
}

interface RequestClient {
  delete(path: string): RequestChain
  get(path: string): RequestChain
  options(path: string): RequestChain
  post(path: string): RequestChain
  put(path: string): RequestChain
}

interface WebSocketClient {
  once(event: string, listener: (...args: unknown[]) => void): this
  send(data: string | Uint8Array): void
  close(): void
}

interface WebSocketConstructor {
  new (url: string, options: { origin: string; headers?: Record<string, string> }): WebSocketClient
}

interface RealtimeControllerInstance {
  activeClientCount(): number
  publishJammerStatus(status: { time: number; jammerId: string; platformId: string; targetPlatform?: string; power: number; frequency: number; bandwidth: number; active: boolean }, frameId: `F-${string}`): void
  invalidateForReset(): void
  close(): Promise<void>
}

type LoopbackDecision =
  | { allowed: true; peerAddress: '127.0.0.1'; origin: string }
  | { allowed: false; code: 'LOOPBACK_ONLY'; message: string }

let createMockServer: (options?: {
  port?: number
  confirmationClock?: { now(): string; expiresAt(createdAt: string): string }
}) => MockServerInstance
let assertLoopbackRequest: (request: {
  headers: { host?: string; origin?: string }
  socket: { remoteAddress?: string }
}) => LoopbackDecision
let request: (baseUrl: string) => RequestClient
let WebSocket: WebSocketConstructor
let createHttpServer: () => IsolatedHttpServerInstance
let MockProjectionConstructor: new () => MockProjectionInstance
let attachRealtimeServer: (
  httpServer: IsolatedHttpServerInstance,
  projection: MockProjectionInstance,
) => RealtimeControllerInstance
let currentServer: MockServerInstance | undefined

beforeAll(async () => {
  const appModulePath = '../../server/' + 'app.js'
  const loopbackModulePath = '../../server/http/' + 'loopback.js'
  const projectionModulePath = '../../server/state/' + 'projection.js'
  const realtimeModulePath = '../../server/ws/' + 'realtime.js'
  const httpModulePath = 'node:' + 'http'
  const supertestModulePath = 'super' + 'test'
  const wsModulePath = 'w' + 's'
  const appModule = await import(appModulePath) as { createMockServer: typeof createMockServer }
  const loopbackModule = await import(loopbackModulePath) as {
    assertLoopbackRequest: typeof assertLoopbackRequest
  }
  const projectionModule = await import(projectionModulePath) as {
    MockProjection: typeof MockProjectionConstructor
  }
  const realtimeModule = await import(realtimeModulePath) as {
    attachRealtimeServer: typeof attachRealtimeServer
  }
  const httpModule = await import(httpModulePath) as { createServer: typeof createHttpServer }
  const supertestModule = await import(supertestModulePath) as { default: typeof request }
  const wsModule = await import(wsModulePath) as { WebSocket: WebSocketConstructor }

  ;({ createMockServer } = appModule)
  ;({ assertLoopbackRequest } = loopbackModule)
  ;({ MockProjection: MockProjectionConstructor } = projectionModule)
  ;({ attachRealtimeServer } = realtimeModule)
  ;({ createServer: createHttpServer } = httpModule)
  ;({ default: request } = supertestModule)
  ;({ WebSocket } = wsModule)
})

function waitForEvent(target: HttpServerInstance | WebSocketClient, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.once(event, () => resolve())
    target.once('error', (error) => reject(error))
  })
}

async function startServer(options: {
  confirmationClock?: { now(): string; expiresAt(createdAt: string): string }
} = {}): Promise<{ server: MockServerInstance; baseUrl: string; wsUrl: string }> {
  const server = createMockServer({ port: 0, ...options })
  currentServer = server
  if (!server.httpServer.listening) {
    await waitForEvent(server.httpServer, 'listening')
  }

  const address = server.httpServer.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP listener address.')
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws/v1`,
  }
}

async function openWebSocket(
  wsUrl: string,
  options: { origin?: string; role?: string } = {},
): Promise<WebSocketClient> {
  const headers = options.role === undefined ? undefined : { 'X-Demo-Role': options.role }
  const client = new WebSocket(wsUrl, {
    origin: options.origin ?? ORIGIN,
    ...(headers === undefined ? {} : { headers }),
  })
  await waitForEvent(client, 'open')
  return client
}

function nextJsonMessage(client: WebSocketClient): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    client.once('message', (...args) => {
      try {
        resolve(JSON.parse(String(args[0])) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    client.once('error', reject)
  })
}

/** 收集指定数量的连续 WebSocket JSON 消息。 */
function nextJsonMessages(client: WebSocketClient, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = []
    const listen = (): void => {
      client.once('message', (...args) => {
        try {
          messages.push(JSON.parse(String(args[0])) as Record<string, unknown>)
          if (messages.length === count) {
            resolve(messages)
          } else {
            listen()
          }
        } catch (error) {
          reject(error)
        }
      })
    }
    listen()
    client.once('error', reject)
  })
}

function nextClose(client: WebSocketClient): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    client.once('close', (...args) => resolve({ code: args[0] as number, reason: String(args[1]) }))
  })
}

async function expectRejected(
  wsUrl: string,
  expectedCode: string,
  options: { origin?: string; role?: string; payload?: unknown },
): Promise<void> {
  const client = new WebSocket(wsUrl, {
    origin: options.origin ?? ORIGIN,
    ...(options.role === undefined ? {} : { headers: { 'X-Demo-Role': options.role } }),
  })
  const messagePromise = nextJsonMessage(client)
  const closePromise = nextClose(client)
  await waitForEvent(client, 'open')
  if (options.payload !== undefined) {
    client.send(typeof options.payload === 'string' ? options.payload : JSON.stringify(options.payload))
  }

  const [message, closed] = await Promise.all([messagePromise, closePromise])
  expect(message).toMatchObject({
    type: 'rejected',
    code: expectedCode,
    closeCode: 1008,
  })
  expect(closed.code).toBe(1008)
}

afterEach(async () => {
  const server = currentServer
  currentServer = undefined
  if (server !== undefined) {
    await server.close()
  }
})

describe('P0 deterministic mock server', () => {
  it.each([-1, 0.5, 65_536])('rejects invalid listener port %s', (port) => {
    expect(() => createMockServer({ port })).toThrow(RangeError)
    expect(() => createMockServer({ port })).toThrow(
      'Mock server port must be an integer from 0 through 65535.',
    )
  })

  it('binds its listener explicitly to 127.0.0.1', async () => {
    const { server } = await startServer()
    const address = server.httpServer.address()
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP listener address.')
    }

    expect(address.address).toBe('127.0.0.1')
    expect(address.family).toBe('IPv4')
  })

  it('normalizes only the IPv4-mapped loopback peer', () => {
    const headers = { host: '127.0.0.1:4173', origin: ORIGIN }

    expect(assertLoopbackRequest({ headers, socket: { remoteAddress: '::ffff:127.0.0.1' } })).toEqual({
      allowed: true,
      peerAddress: '127.0.0.1',
      origin: ORIGIN,
    })
    expect(assertLoopbackRequest({ headers, socket: { remoteAddress: '::1' } })).toMatchObject({
      allowed: false,
      code: 'LOOPBACK_ONLY',
    })

    expect(assertLoopbackRequest({
      headers: { host: '127.0.0.1', origin: ORIGIN },
      socket: { remoteAddress: '127.0.0.1' },
    })).toEqual({ allowed: true, peerAddress: '127.0.0.1', origin: ORIGIN })
    for (const host of ['127.0.0.1:0', '127.0.0.1:65536']) {
      expect(assertLoopbackRequest({
        headers: { host, origin: ORIGIN },
        socket: { remoteAddress: '127.0.0.1' },
      })).toMatchObject({ allowed: false, code: 'LOOPBACK_ONLY' })
    }
  })

  it('memoizes close across repeated calls', async () => {
    const { server } = await startServer()

    const firstClose = server.close()
    const secondClose = server.close()

    expect(secondClose).toBe(firstClose)
    await expect(firstClose).resolves.toBeUndefined()
  })

  it('rejects close when the underlying HTTP listener is already closed', async () => {
    const { server } = await startServer()
    await new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => error === undefined ? resolve() : reject(error))
    })

    try {
      await expect(server.close()).rejects.toThrow('Server is not running')
    } finally {
      currentServer = undefined
    }
  })

  it('surfaces a repeated realtime close callback error without leaking listeners', async () => {
    const httpServer = createHttpServer()
    const controller = attachRealtimeServer(httpServer, new MockProjectionConstructor())

    try {
      await expect(controller.close()).resolves.toBeUndefined()
      await expect(controller.close()).rejects.toThrow('The server is not running')
    } finally {
      httpServer.removeAllListeners()
    }
  })

  it('returns deterministic reset envelopes across repeated cycles', async () => {
    const { baseUrl } = await startServer()
    const sendReset = () => request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ confirm: true })

    const first = await sendReset().expect(200)
    const second = await sendReset().expect(200)

    expect(first.body).toEqual({
      ok: true,
      data: {
        requestId: 'REQ-RESET-001',
        generatedAt: '2026-08-06T08:00:00Z',
        nextSequence: 1,
      },
      meta: {
        requestId: 'REQ-RESET-001',
        generatedAt: '2026-08-06T08:00:00Z',
        page: 1,
        pageSize: 1,
        total: 1,
      },
    })
    expect(second.body).toEqual(first.body)
  })

  it('returns the complete P5 contract catalogue without file or process side effects', async () => {
    const { baseUrl } = await startServer()
    const get = (path: string) => request(baseUrl)
      .get(path)
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')

    const [scenario, frontend, csv, interfaces] = await Promise.all([
      get('/api/v1/contracts/scenario-config').expect(200),
      get('/api/v1/contracts/frontend-types').expect(200),
      get('/api/v1/contracts/csv').expect(200),
      get('/api/v1/meta/interfaces').expect(200),
    ])

    expect(scenario.body).toMatchObject({ ok: true, data: { name: 'ScenarioConfig', version: '1.0' } })
    const frontendData = (frontend.body as { data: unknown[] }).data
    const csvData = (csv.body as { data: Array<{ name: string }> }).data
    const interfaceData = (interfaces.body as { data: Array<{ kind: string }> }).data
    expect(frontendData).toHaveLength(5)
    expect(csvData).toHaveLength(3)
    expect(csvData.map((item) => item.name)).toEqual(['link_quality.csv', 'events.csv', 'link_switch.csv'])
    expect(interfaceData).toHaveLength(7)
    expect(interfaceData.filter((item) => item.kind === '外部')).toHaveLength(3)
    expect(interfaceData.filter((item) => item.kind === '内部')).toHaveLength(4)

    for (const path of [
      '/api/v1/contracts/scenario-config',
      '/api/v1/contracts/frontend-types',
      '/api/v1/contracts/csv',
      '/api/v1/meta/interfaces',
    ]) {
      const denied = await request(baseUrl).get(path).set('Origin', ORIGIN).expect(403)
      expect(denied.body).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    }
  })

  it('returns typed errors for invalid reset requests and unmatched API routes', async () => {
    const { baseUrl } = await startServer()

    const invalidBody = await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send({ confirm: false })
      .expect(400)
    expect(invalidBody.body).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })

    const missingRole = await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .send({ confirm: true })
      .expect(403)
    expect(missingRole.body).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })

    const invalidOrigin = await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', 'http://example.test')
      .set('X-Demo-Role', 'ADMIN')
      .send({ confirm: true })
      .expect(403)
    expect(invalidOrigin.body).toMatchObject({ ok: false, error: { code: 'LOOPBACK_ONLY' } })

    const missingRoute = await request(baseUrl)
      .get('/api/v1/not-found')
      .set('Origin', ORIGIN)
      .expect(404)
    expect(missingRoute.body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('加载、校验、完整保存并全局重置场景草稿', async () => {
    const { server, baseUrl } = await startServer()
    const load = () => request(baseUrl)
      .get('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')

    const loaded = await load().expect(200)
    const original = (loaded.body as { data: ScenarioDraft }).data
    expect(original).toMatchObject({
      revision: 4,
      config: { scenario: { name: '跨海通联演示', duration: 1200, environment: {
        simClockSpeed: 2, transmissionDistance: 300, rainCloudAttenuation: 'lightRain', multipathEnabled: true,
      } } },
      uiExtensions: {
        jammers: [{ jammerId: 'JAM-WB-01-TX' }, { jammerId: 'JAM-SPOT-01-TX' }],
        sensors: [{ sensorId: 'ESM-01', type: 'ESM' }],
      },
    })

    const changed = structuredClone(original.config)
    changed.scenario.name = '台海通联验证场景'
    changed.scenario.environment.humidityPercent = 75
    changed.scenario.environment.simClockSpeed = 3
    changed.scenario.environment.transmissionDistance = 350
    changed.scenario.environment.rainCloudAttenuation = 'heavyRain'
    const saved = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: changed, uiExtensions: original.uiExtensions })
      .expect(200)
    expect((saved.body as { data: ScenarioDraft }).data).toMatchObject({
      revision: 5,
      config: { scenario: { name: '台海通联验证场景', environment: {
        humidityPercent: 75, simClockSpeed: 3, transmissionDistance: 350, rainCloudAttenuation: 'heavyRain',
      } } },
    })
    const reloaded = await load().expect(200)
    expect((reloaded.body as { data: ScenarioDraft }).data.config).toEqual(changed)
    expect((reloaded.body as { data: ScenarioDraft }).data.config.platforms).toEqual(original.config.platforms)

    const invalid = structuredClone(changed)
    invalid.scenario.environment.humidityPercent = 101
    const rejected = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send({ config: invalid, uiExtensions: original.uiExtensions })
      .expect(422)
    expect(rejected.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'scenario.environment.humidityPercent' },
    })

    const platformMutation = structuredClone(changed)
    platformMutation.platforms[0]!.name = '后方指挥节点（更新）'
    const platformSaved = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: platformMutation, uiExtensions: original.uiExtensions })
      .expect(200)
    const platformSavedDraft = (platformSaved.body as { data: ScenarioDraft }).data
    expect(platformSavedDraft.revision).toBe(6)
    expect(platformSavedDraft.config.platforms[0]?.name).toBe('后方指挥节点（更新）')

    const linkMutation = structuredClone(platformSavedDraft.config)
    linkMutation.links[0]!.frequency = 4600
    const linkSaved = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: linkMutation, uiExtensions: original.uiExtensions })
      .expect(200)
    const linkSavedDraft = (linkSaved.body as { data: ScenarioDraft }).data
    expect(linkSavedDraft.revision).toBe(7)
    expect(linkSavedDraft.config.links[0]?.frequency).toBe(4600)

    const jammerMutation = structuredClone(linkSavedDraft.config)
    jammerMutation.jammers[0]!.defaultPower = 0
    jammerMutation.jammers[0]!.detectionRange = 0
    jammerMutation.jammers[0]!.frequency = 0.0001
    jammerMutation.jammers[0]!.bandwidth = Number.MIN_VALUE
    const jammerSaved = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: jammerMutation, uiExtensions: original.uiExtensions })
      .expect(200)
    const jammerSavedDraft = (jammerSaved.body as { data: ScenarioDraft }).data
    expect(jammerSavedDraft.revision).toBe(8)
    expect(jammerSavedDraft.config.jammers[0]).toMatchObject({
      defaultPower: 0,
      detectionRange: 0,
      frequency: 0.0001,
      bandwidth: Number.MIN_VALUE,
    })

    const invalidJammer = structuredClone(jammerMutation)
    invalidJammer.jammers[0]!.detectionRange = -1
    const invalidJammerRejected = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: invalidJammer, uiExtensions: original.uiExtensions })
      .expect(422)
    expect(invalidJammerRejected.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'jammers[0].detectionRange' },
    })

    const invalidPower = structuredClone(jammerMutation)
    invalidPower.jammers[0]!.defaultPower = -1
    const invalidPowerRejected = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: invalidPower, uiExtensions: original.uiExtensions })
      .expect(422)
    expect(invalidPowerRejected.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'jammers[0].defaultPower' },
    })

    const invalidLink = structuredClone(linkMutation)
    invalidLink.links[0]!.bandwidth = 0
    const invalidLinkRejected = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: invalidLink, uiExtensions: original.uiExtensions })
      .expect(422)
    expect(invalidLinkRejected.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'links[0].bandwidth' },
    })

    const overLimit = structuredClone(linkMutation)
    const sourcePlatform = structuredClone(overLimit.platforms[3]!)
    for (let index = 0; index < 45; index += 1) {
      overLimit.platforms.push({
        ...structuredClone(sourcePlatform),
        id: `LIMIT-${String(index + 1).padStart(3, '0')}`,
        name: `容量测试节点 ${index + 1}`,
        linkIds: [],
        sensorIds: [],
        jammerIds: [],
      })
    }
    const limitRejected = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: overLimit, uiExtensions: original.uiExtensions })
      .expect(422)
    expect(limitRejected.body).toMatchObject({
      ok: false,
      error: { code: 'NODE_LIMIT_EXCEEDED', fieldPath: 'platforms' },
    })

    const completeMutation = structuredClone(jammerSavedDraft.config)
    completeMutation.sensors[0]!.detectionRange = 120000
    completeMutation.output.directory = './scene-output'
    completeMutation.informationDemand[0]!.maxLatencyMs = 800
    const completeExtensions = structuredClone(original.uiExtensions)
    completeExtensions.sensors[0]!.probability = 0.8
    const completeSaved = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: completeMutation, uiExtensions: completeExtensions })
      .expect(200)
    expect((completeSaved.body as { data: ScenarioDraft }).data).toMatchObject({
      revision: 9,
      config: {
        sensors: [{ detectionRange: 120000 }],
        output: { directory: './scene-output' },
        informationDemand: [{ maxLatencyMs: 800 }],
      },
      uiExtensions: { sensors: [{ probability: 0.8 }] },
    })

    expect(server.auditSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: 'operator', module: 'SCENARIO_CONFIGURATION', action: 'SCENARIO_UPDATE', result: 'SUCCESS' }),
      expect.objectContaining({ actor: 'admin', module: 'SCENARIO_CONFIGURATION', action: 'SCENARIO_UPDATE', result: 'ERROR' }),
    ]))

    await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send({ confirm: true })
      .expect(200)
    const reset = await load().expect(200)
    expect((reset.body as { data: ScenarioDraft }).data).toMatchObject({
      revision: 4,
      config: { scenario: { name: '跨海通联演示', environment: { humidityPercent: 80 } } },
    })
  })

  it('原子导入完整场景快照并支持场景级撤销和重置', async () => {
    const { baseUrl } = await startServer()
    const load = (scenarioId = 'SCN-001') => request(baseUrl)
      .get(`/api/v1/scenarios/${scenarioId}`)
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
    const original = ((await load().expect(200)).body as { data: ScenarioDraft }).data
    const importedConfig = structuredClone(original.config)
    importedConfig.scenario.id = 'SCN-IMPORT'
    importedConfig.scenario.name = '导入快照场景'

    const importedResponse = await request(baseUrl)
      .post('/api/v1/scenarios/import')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ items: [importedConfig] })
      .expect(200)
    const imported = (importedResponse.body as { data: { imported: number; rejected: number; drafts: ScenarioDraft[] } }).data
    expect(imported).toMatchObject({ imported: 1, rejected: 0, drafts: [{ config: { scenario: { id: 'SCN-IMPORT' } } }] })

    const undone = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-IMPORT/undo')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ expectedRevision: imported.drafts[0]!.revision })
      .expect(200)
    const undoneDraft = (undone.body as { data: ScenarioDraft }).data
    expect(undoneDraft.config.scenario.id).toBe('SCN-001')

    const changed = structuredClone(undoneDraft.config)
    changed.scenario.name = '待重置场景'
    const saved = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: changed, uiExtensions: undoneDraft.uiExtensions })
      .expect(200)
    const savedDraft = (saved.body as { data: ScenarioDraft }).data
    const reset = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-001/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ expectedRevision: savedDraft.revision })
      .expect(200)
    expect((reset.body as { data: ScenarioDraft }).data.config.scenario.name).toBe(original.config.scenario.name)

    const invalidConfig = structuredClone(original.config)
    invalidConfig.output.directory = ''
    await request(baseUrl)
      .post('/api/v1/scenarios/import')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ items: [importedConfig, invalidConfig] })
      .expect(422)
    expect(((await load().expect(200)).body as { data: ScenarioDraft }).data.config.scenario.id).toBe('SCN-001')
  })

  it('按 T-XQ-008 阻断错误、一次确认警告并执行脚本预检', async () => {
    const { server, baseUrl } = await startServer()
    const roleHeaders = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }

    const blocked = await request(baseUrl)
      .post('/api/v1/scripts/preview')
      .set(roleHeaders)
      .send({ scenarioId: 'SCN-001' })
      .expect(428)
    expect(blocked.body).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } })

    const awaitingResponse = await request(baseUrl)
      .post('/api/v1/confirmations')
      .set(roleHeaders)
      .send({ action: 'SCENARIO_WARNING_CONTINUE', objectId: 'SCN-001' })
      .expect(201)
    const awaiting = (awaitingResponse.body as { data: ConfirmationContext }).data
    await request(baseUrl)
      .post(`/api/v1/confirmations/${awaiting.confirmationId}`)
      .set(roleHeaders)
      .send({ confirm: true })
      .expect(200)

    const previewResponse = await request(baseUrl)
      .post('/api/v1/scripts/preview')
      .set(roleHeaders)
      .send({ scenarioId: 'SCN-001', warningConfirmationId: awaiting.confirmationId })
      .expect(200)
    const script = (previewResponse.body as { data: ScriptContract }).data
    expect(script).toMatchObject({ target: 'AFSIM 2.9.0', scenarioId: 'SCN-001', configVersion: 'SCN-001-v4' })
    expect(script.preview).toContain(`output path=`)

    const preflight = await request(baseUrl)
      .post(`/api/v1/scripts/${script.scriptId}/preflight`)
      .set(roleHeaders)
      .send({ checksum: script.checksum })
      .expect(200)
    expect(preflight.body).toMatchObject({ ok: true, data: { valid: true, errors: [], warnings: [] } })
    await request(baseUrl)
      .post(`/api/v1/scripts/${script.scriptId}/preflight`)
      .set(roleHeaders)
      .send({ checksum: 'FNV1A-MOCK-WRONG' })
      .expect(422)
    await request(baseUrl)
      .post('/api/v1/scripts/preview')
      .set(roleHeaders)
      .send({ scenarioId: 'SCN-001', warningConfirmationId: awaiting.confirmationId })
      .expect(409)
    expect(server.auditSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: 'SCRIPT_GENERATION', action: 'SCRIPT_PREVIEW', result: 'SUCCESS' }),
      expect.objectContaining({ module: 'SCRIPT_GENERATION', action: 'SCRIPT_PREVIEW', result: 'ERROR' }),
      expect.objectContaining({ module: 'SCRIPT_GENERATION', action: 'SCRIPT_PREFLIGHT', result: 'SUCCESS' }),
      expect.objectContaining({ module: 'SCRIPT_GENERATION', action: 'SCRIPT_PREFLIGHT', result: 'ERROR' }),
    ]))
  })

  it('拒绝场景快照和脚本端点的损坏请求、冲突及未知对象', async () => {
    const { baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }
    const original = ((await request(baseUrl).get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body as { data: ScenarioDraft }).data

    await request(baseUrl).post('/api/v1/scenarios/SCN-001/undo').set(headers).send({}).expect(422)
    await request(baseUrl).post('/api/v1/scenarios/SCN-001/undo').set(headers).send({ expectedRevision: original.revision }).expect(409)
    await request(baseUrl).post('/api/v1/scenarios/SCN-MISSING/undo').set(headers).send({ expectedRevision: 1 }).expect(404)
    await request(baseUrl).post('/api/v1/scenarios/SCN-001/reset').set(headers).send({ expectedRevision: 0 }).expect(409)
    await request(baseUrl).post('/api/v1/scenarios/SCN-MISSING/reset').set(headers).send({ expectedRevision: 1 }).expect(404)
    await request(baseUrl).post('/api/v1/scenarios/import').set(headers).send({}).expect(422)
    await request(baseUrl).post('/api/v1/scenarios/import').set(headers).send({ items: [] }).expect(422)
    await request(baseUrl).post('/api/v1/scenarios/import').set(headers).send({ items: [{ ...original.config, output: null }] }).expect(422)
    const secondConfig = structuredClone(original.config)
    secondConfig.scenario.id = 'SCN-SECOND'
    await request(baseUrl).post('/api/v1/scenarios/import').set(headers).send({ items: [original.config, secondConfig] }).expect(422)
    await request(baseUrl).post('/api/v1/scripts/preview').set(headers).send({}).expect(422)
    await request(baseUrl).post('/api/v1/scripts/preview').set(headers).send({ scenarioId: 'SCN-MISSING' }).expect(422)
    await request(baseUrl).post('/api/v1/scripts/SCRIPT-MISSING/preflight').set(headers).send({}).expect(422)
    await request(baseUrl).post('/api/v1/scripts/SCRIPT-MISSING/preflight').set(headers).send({ checksum: 'FNV1A-MOCK-MISSING' }).expect(422)
  })

  it('拒绝未携带角色的场景撤销、脚本预览和预检', async () => {
    const { baseUrl } = await startServer()
    await request(baseUrl).post('/api/v1/scenarios/SCN-001/undo').set('Origin', ORIGIN).send({ expectedRevision: 4 }).expect(403)
    await request(baseUrl).post('/api/v1/scripts/preview').set('Origin', ORIGIN).send({ scenarioId: 'SCN-001' }).expect(403)
    await request(baseUrl).post('/api/v1/scripts/SCRIPT-MISSING/preflight').set('Origin', ORIGIN).send({ checksum: 'FNV1A-MOCK-MISSING' }).expect(403)
  })

  it('返回完整场景校验结果且不修改草稿', async () => {
    const { baseUrl } = await startServer()
    const loaded = await request(baseUrl)
      .get('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .expect(200)
    const original = (loaded.body as { data: ScenarioDraft }).data

    const warningResponse = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-001/validate')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: original.config })
      .expect(200)
    expect((warningResponse.body as { data: ValidationResult }).data).toMatchObject({
      valid: true,
      errors: [],
      warnings: [{ severity: 'WARNING', fieldPath: 'scenario.environment.rainLossDbPerKm' }],
    })

    const invalid = structuredClone(original.config)
    invalid.links[0]!.txPower = -1
    const invalidResponse = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-001/validate')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send({ config: invalid })
      .expect(200)
    expect((invalidResponse.body as { data: ValidationResult }).data).toMatchObject({
      valid: false,
      errors: [{ severity: 'ERROR', fieldPath: 'links[0].txPower' }],
    })

    const malformed = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-001/validate')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: original.config, extra: true })
      .expect(422)
    expect(malformed.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', fieldPath: 'request' } })

    const mismatchedConfig = structuredClone(original.config)
    mismatchedConfig.scenario.id = 'SCN-OTHER'
    const mismatched = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-001/validate')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: mismatchedConfig })
      .expect(200)
    expect((mismatched.body as { data: ValidationResult }).data).toMatchObject({
      valid: false,
      errors: [{ code: 'SCENARIO_ID_MISMATCH', fieldPath: 'scenario.id' }],
    })

    const missing = await request(baseUrl)
      .post('/api/v1/scenarios/SCN-UNKNOWN/validate')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: original.config })
      .expect(404)
    expect(missing.body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })

    const afterValidation = await request(baseUrl)
      .get('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .expect(200)
    expect((afterValidation.body as { data: ScenarioDraft }).data).toEqual(original)
  })

  it('按角色完成模板七类动作并保护被引用模板', async () => {
    const { baseUrl } = await startServer()
    const operator = (chain: RequestChain) => chain.set('Origin', ORIGIN).set('X-Demo-Role', 'OPERATOR')
    const admin = (chain: RequestChain) => chain.set('Origin', ORIGIN).set('X-Demo-Role', 'ADMIN')
    const originalDraft = ((await operator(request(baseUrl).get('/api/v1/scenarios/SCN-001')).expect(200)).body as { data: ScenarioDraft }).data

    await request(baseUrl).get('/api/v1/templates').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).get('/api/v1/templates/TPL-SCN-001').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).post('/api/v1/templates/TPL-SCN-001/copy').set('Origin', ORIGIN).send({ name: '副本' }).expect(403)
    await operator(request(baseUrl).put('/api/v1/templates/TPL-SCN-001'))
      .send({ name: '越权更新', config: originalDraft.config })
      .expect(403)
    await operator(request(baseUrl).post('/api/v1/confirmations'))
      .send({ action: 'OFFICIAL_TEMPLATE_DELETE', objectId: 'TPL-SCN-001' })
      .expect(403)
    await operator(request(baseUrl).post('/api/v1/confirmations/CONF-NOT-FOUND')).send({ confirm: true }).expect(409)
    await admin(request(baseUrl).post('/api/v1/confirmations/CONF-NOT-FOUND')).send({ confirm: true }).expect(409)
    await operator(request(baseUrl).delete('/api/v1/templates/TPL-SCN-001')).expect(403)
    await admin(request(baseUrl).delete('/api/v1/templates/TPL-NOT-FOUND')).expect(404)

    const listed = await operator(request(baseUrl).get('/api/v1/templates')).expect(200)
    expect((listed.body as { data: ScenarioTemplate[] }).data).toMatchObject([
      { templateId: 'TPL-SCN-001', version: '4', official: true, referenceCount: 2 },
    ])
    await operator(request(baseUrl).post('/api/v1/templates'))
      .send({ name: '操作员越权模板', config: originalDraft.config })
      .expect(403)

    const operatorConfirmationResponse = await operator(request(baseUrl).post('/api/v1/confirmations'))
      .send({ action: 'SCENARIO_WARNING_CONTINUE', objectId: 'SCN-001' })
      .expect(201)
    const operatorConfirmation = (operatorConfirmationResponse.body as { data: ConfirmationContext }).data
    expect(operatorConfirmation.role).toBe('OPERATOR')
    await operator(request(baseUrl).post(`/api/v1/confirmations/${operatorConfirmation.confirmationId}`))
      .send({ confirm: true })
      .expect(200)

    const createdResponse = await admin(request(baseUrl).post('/api/v1/templates'))
      .send({ name: '台海验证模板', config: originalDraft.config })
      .expect(201)
    const created = (createdResponse.body as { data: ScenarioTemplate }).data
    expect(created).toMatchObject({ templateId: 'TPL-SCN-002', version: '1', referenceCount: 0 })
    await admin(request(baseUrl).post('/api/v1/templates'))
      .send({ name: created.name, config: originalDraft.config })
      .expect(409)
    await admin(request(baseUrl).post('/api/v1/templates'))
      .send({ name: '', config: originalDraft.config })
      .expect(422)
    await admin(request(baseUrl).post('/api/v1/templates'))
      .send({ name: '多余字段模板', config: originalDraft.config, extra: true })
      .expect(422)
    const invalidTemplateConfig = structuredClone(originalDraft.config)
    invalidTemplateConfig.links[0]!.txPower = -1
    await admin(request(baseUrl).post('/api/v1/templates'))
      .send({ name: '非法配置模板', config: invalidTemplateConfig })
      .expect(422)

    const updatedResponse = await admin(request(baseUrl).put(`/api/v1/templates/${created.templateId}`))
      .send({ name: '台海验证模板 V2', config: originalDraft.config })
      .expect(200)
    expect((updatedResponse.body as { data: ScenarioTemplate }).data).toMatchObject({ version: '2', name: '台海验证模板 V2' })
    await admin(request(baseUrl).put(`/api/v1/templates/${created.templateId}`))
      .send({ name: '跨海通联演示官方基线', config: originalDraft.config })
      .expect(409)
    await admin(request(baseUrl).put('/api/v1/templates/TPL-NOT-FOUND'))
      .send({ name: '不存在', config: originalDraft.config })
      .expect(404)

    const copiedResponse = await operator(request(baseUrl).post(`/api/v1/templates/${created.templateId}/copy`))
      .send({ name: '操作员临时场景' })
      .expect(201)
    expect((copiedResponse.body as { data: ScenarioDraft }).data.config.scenario.name).toBe('操作员临时场景')
    expect(((await operator(request(baseUrl).get('/api/v1/scenarios/SCN-001')).expect(200)).body as { data: ScenarioDraft }).data.config.scenario.name)
      .toBe('操作员临时场景')
    await operator(request(baseUrl).post(`/api/v1/templates/${created.templateId}/copy`)).send({ name: '' }).expect(422)
    await operator(request(baseUrl).post('/api/v1/templates/TPL-NOT-FOUND/copy')).send({ name: '临时场景' }).expect(404)

    await admin(request(baseUrl).delete(`/api/v1/templates/${created.templateId}`)).expect(428)
    await admin(request(baseUrl).delete(`/api/v1/templates/${created.templateId}`))
      .set('X-Confirmation-Id', 'CONF-NOT-FOUND')
      .expect(409)
    await admin(request(baseUrl).post('/api/v1/confirmations')).send({ action: 'UNKNOWN', objectId: created.templateId }).expect(400)
    const confirmationResponse = await admin(request(baseUrl).post('/api/v1/confirmations'))
      .send({ action: 'OFFICIAL_TEMPLATE_DELETE', objectId: created.templateId })
      .expect(201)
    const confirmation = (confirmationResponse.body as { data: ConfirmationContext }).data
    expect(confirmation.state).toBe('AWAITING_CONFIRMATION')
    await admin(request(baseUrl).post(`/api/v1/confirmations/${confirmation.confirmationId}`)).send({ confirm: false }).expect(400)
    await operator(request(baseUrl).post(`/api/v1/confirmations/${confirmation.confirmationId}`)).send({ confirm: true }).expect(403)
    await admin(request(baseUrl).post(`/api/v1/confirmations/${confirmation.confirmationId}`)).send({ confirm: true }).expect(200)
    await admin(request(baseUrl).post(`/api/v1/confirmations/${confirmation.confirmationId}`)).send({ confirm: true }).expect(409)
    await admin(request(baseUrl).delete('/api/v1/templates/TPL-SCN-001'))
      .set('X-Confirmation-Id', confirmation.confirmationId)
      .expect(409)
    await admin(request(baseUrl).delete(`/api/v1/templates/${created.templateId}`))
      .set('X-Confirmation-Id', confirmation.confirmationId)
      .expect(200)
    await admin(request(baseUrl).get(`/api/v1/templates/${created.templateId}`)).expect(404)

    const referencedConfirmationResponse = await admin(request(baseUrl).post('/api/v1/confirmations'))
      .send({ action: 'OFFICIAL_TEMPLATE_DELETE', objectId: 'TPL-SCN-001' })
      .expect(201)
    const referencedConfirmation = (referencedConfirmationResponse.body as { data: ConfirmationContext }).data
    await admin(request(baseUrl).post(`/api/v1/confirmations/${referencedConfirmation.confirmationId}`)).send({ confirm: true }).expect(200)
    const rejectedDelete = await admin(request(baseUrl).delete('/api/v1/templates/TPL-SCN-001'))
      .set('X-Confirmation-Id', referencedConfirmation.confirmationId)
      .expect(409)
    expect(rejectedDelete.body).toMatchObject({ error: { code: 'CONFLICT', fieldPath: 'referenceCount' } })
    expect((await admin(request(baseUrl).get('/api/v1/templates/TPL-SCN-001')).expect(200)).body)
      .toMatchObject({ data: { referenceCount: 2 } })
  })

  it('确认上下文到期后接口拒绝继续确认', async () => {
    let now = '2026-08-06T08:00:00Z'
    const { baseUrl } = await startServer({
      confirmationClock: { now: () => now, expiresAt: () => '2026-08-06T08:05:00Z' },
    })
    const create = await request(baseUrl).post('/api/v1/confirmations')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ action: 'SCENARIO_WARNING_CONTINUE', objectId: 'SCN-001' })
      .expect(201)
    const context = (create.body as { data: ConfirmationContext }).data

    now = context.expiresAt
    const expired = await request(baseUrl).post(`/api/v1/confirmations/${context.confirmationId}`)
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ confirm: true })
      .expect(409)
    expect(expired.body).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } })
  })

  it('直接 PUT 忽略客户端链路和干扰设备反向关联并持久化规范结果', async () => {
    const { baseUrl } = await startServer()
    const load = () => request(baseUrl)
      .get('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
    const original = (await load().expect(200)).body as { data: ScenarioDraft }
    const inconsistent = structuredClone(original.data.config)
    inconsistent.links[0]!.targetPlatformId = 'AIR-02'
    inconsistent.jammers[0]!.platformId = 'AIR-01'
    inconsistent.platforms.forEach((platform) => {
      platform.linkIds = ['CLIENT-OWNED']
      platform.jammerIds = ['CLIENT-OWNED']
    })

    const response = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: inconsistent, uiExtensions: original.data.uiExtensions })
      .expect(200)
    const saved = (response.body as { data: ScenarioDraft }).data
    expect(saved.revision).toBe(original.data.revision + 1)
    saved.config.platforms.forEach((platform) => {
      expect(platform.linkIds).toEqual(saved.config.links
        .filter((link) => link.sourcePlatformId === platform.id || link.targetPlatformId === platform.id)
        .map((link) => link.id))
      expect(platform.jammerIds).toEqual(saved.config.jammers
        .filter((jammer) => jammer.platformId === platform.id)
        .map((jammer) => jammer.id))
    })
    expect((await load().expect(200)).body).toMatchObject({ data: saved })

    const malformed = structuredClone(saved.config)
    delete (malformed.platforms[0] as unknown as Record<string, unknown>).name
    const rejected = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: malformed, uiExtensions: saved.uiExtensions })
      .expect(422)
    expect(rejected.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'platforms[0]' },
    })
    expect((await load().expect(200)).body).toMatchObject({ data: saved })
  })

  it('按设备 ID 原子保存界面扩展并拒绝不匹配和越界字段', async () => {
    const { baseUrl } = await startServer()
    const load = () => request(baseUrl)
      .get('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
    const original = ((await load().expect(200)).body as { data: ScenarioDraft }).data

    const malformedWrapper = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: original.config })
      .expect(422)
    expect(malformedWrapper.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'request' },
    })

    const mismatchedIdConfig = structuredClone(original.config)
    mismatchedIdConfig.scenario.id = 'SCN-OTHER'
    const mismatchedId = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: mismatchedIdConfig, uiExtensions: original.uiExtensions })
      .expect(422)
    expect(mismatchedId.body).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', fieldPath: 'scenario.id' },
    })
    expect(((await load().expect(200)).body as { data: ScenarioDraft }).data).toEqual(original)

    const changedExtensions = structuredClone(original.uiExtensions)
    changedExtensions.jammers.reverse()
    changedExtensions.jammers.find((extension) => extension.jammerId === 'JAM-SPOT-01-TX')!.direction = 360
    changedExtensions.jammers.find((extension) => extension.jammerId === 'JAM-WB-01-TX')!.enabled = false
    changedExtensions.sensors[0]!.probability = 0.8

    const savedResponse = await request(baseUrl)
      .put('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ config: original.config, uiExtensions: changedExtensions })
      .expect(200)
    const saved = (savedResponse.body as { data: ScenarioDraft }).data
    expect(saved.revision).toBe(original.revision + 1)
    expect(saved.uiExtensions).toEqual(changedExtensions)

    const invalidCases = [
      {
        fieldPath: 'uiExtensions.jammers',
        uiExtensions: { ...changedExtensions, jammers: [changedExtensions.jammers[0]] },
      },
      {
        fieldPath: 'uiExtensions.jammers[0].duration',
        uiExtensions: {
          ...changedExtensions,
          jammers: [{ ...changedExtensions.jammers[0]!, duration: -1 }, changedExtensions.jammers[1]],
        },
      },
      {
        fieldPath: 'uiExtensions.sensors[0]',
        uiExtensions: { ...changedExtensions, sensors: [{ sensorId: 'ESM-01' }] },
      },
    ]
    for (const invalid of invalidCases) {
      const rejected = await request(baseUrl)
        .put('/api/v1/scenarios/SCN-001')
        .set('Origin', ORIGIN)
        .set('X-Demo-Role', 'OPERATOR')
        .send({ config: saved.config, uiExtensions: invalid.uiExtensions })
        .expect(422)
      expect(rejected.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', fieldPath: invalid.fieldPath } })
      expect(((await load().expect(200)).body as { data: ScenarioDraft }).data).toEqual(saved)
    }
  })

  it('rejects missing roles and unknown scenario identifiers', async () => {
    const { baseUrl } = await startServer()

    const denied = await request(baseUrl)
      .get('/api/v1/scenarios/SCN-001')
      .set('Origin', ORIGIN)
      .expect(403)
    expect(denied.body).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })

    const missing = await request(baseUrl)
      .get('/api/v1/scenarios/SCN-NOT-FOUND')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .expect(404)
    expect(missing.body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('returns a typed error with parser details for malformed strict JSON', async () => {
    const { baseUrl } = await startServer()

    const response = await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400)

    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', details: expect.any(String) },
    })
  })

  it('accepts JSON bodies above 16KB and reaches reset validation', async () => {
    const { baseUrl } = await startServer()
    const body = { confirm: false, padding: 'x'.repeat(17_000) }
    const bodyLength = JSON.stringify(body).length
    expect(bodyLength).toBeGreaterThan(16 * 1024)
    expect(bodyLength).toBeLessThan(256 * 1024)

    const response = await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send(body)
      .expect(400)

    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', fieldPath: 'confirm' },
    })
  })

  it.each(['GET', 'PUT', 'DELETE'] as const)(
    'preflights arbitrary API paths for %s',
    async (method) => {
      const { baseUrl } = await startServer()

      const response = await request(baseUrl)
        .options(`/api/arbitrary/${method.toLowerCase()}/path`)
        .set('Origin', ORIGIN)
        .set('Access-Control-Request-Method', method)
        .set('Access-Control-Request-Headers', 'content-type,x-demo-role')
        .expect(204)

      expect(response.headers['access-control-allow-origin']).toBe(ORIGIN)
      expect(response.headers['access-control-allow-methods']).toBe(
        'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      )
      expect(response.headers['access-control-allow-headers']).toBe('Content-Type, X-Demo-Role, X-Confirmation-Id')
      expect(response.headers.vary).toBe('Origin')
    },
  )

  it('rejects invalid-origin preflight before setting CORS headers', async () => {
    const { baseUrl } = await startServer()

    const rejected = await request(baseUrl)
      .options('/api/arbitrary/delete/path')
      .set('Origin', 'http://127.0.0.1:5174')
      .set('Access-Control-Request-Method', 'DELETE')
      .expect(403)
    expect(rejected.body).toMatchObject({ ok: false, error: { code: 'LOOPBACK_ONLY' } })
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined()
    expect(rejected.headers['access-control-allow-methods']).toBeUndefined()
  })

  it('accepts one canonical WebSocket subscription and emits initial topic snapshots', async () => {
    const { wsUrl } = await startServer()
    const client = await openWebSocket(wsUrl, { role: 'ADMIN' })
    const messagePromise = nextJsonMessages(client, 5)

    client.send(JSON.stringify({
      type: 'subscribe',
      schemaVersion: '1.0',
      taskId: 'TASK-001',
      topics: ['simulation.frame', 'runtime.state', 'jammer.event', 'switch.event'],
      lastSequence: 0,
    }))

    const messages = await messagePromise
    expect(messages[0]).toEqual({
      type: 'subscribed',
      schemaVersion: '1.0',
      taskId: 'TASK-001',
      topics: ['simulation.frame', 'runtime.state', 'jammer.event', 'switch.event'],
      lastSequence: 0,
      nextSequence: 1,
    })
    expect(messages[1]).toMatchObject({
      type: 'event', topic: 'simulation.frame', sequence: 1, frameId: 'F-00042', payload: { frameId: 'F-00042' },
    })
    expect(messages[2]).toMatchObject({
      type: 'event', topic: 'runtime.state', sequence: 1, payload: { status: 'COMPLETED' },
    })
    expect(messages[3]).toMatchObject({
      type: 'event', topic: 'jammer.event', sequence: 1, frameId: 'F-00042',
      simulationTime: 42, payload: { eventId: 'DET-042', type: 'DETECTION', sensorId: 'ESM-01' },
    })
    expect(messages[4]).toMatchObject({
      type: 'event', topic: 'switch.event', sequence: 1, frameId: 'F-00042',
      simulationTime: 42, payload: { eventId: 'SW-003', type: 'LINK_SWITCH', decision: 'ACCEPTED' },
    })
    const closePromise = nextClose(client)
    client.close()
    await closePromise
  })

  it('replays one cached topic envelope to later clients without creating a sequence gap', async () => {
    const { baseUrl, wsUrl } = await startServer()
    const firstClient = await openWebSocket(wsUrl, { role: 'OPERATOR' })
    const firstInitial = nextJsonMessages(firstClient, 2)
    firstClient.send(JSON.stringify({
      type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['runtime.state'], lastSequence: 0,
    }))
    const firstMessages = await firstInitial

    const secondClient = await openWebSocket(wsUrl, { role: 'OPERATOR' })
    const secondInitial = nextJsonMessages(secondClient, 2)
    secondClient.send(JSON.stringify({
      type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['runtime.state'], lastSequence: 0,
    }))
    const secondMessages = await secondInitial

    expect(firstMessages[1]).toMatchObject({ topic: 'runtime.state', sequence: 1, payload: { status: 'COMPLETED' } })
    expect(secondMessages[1]).toEqual(firstMessages[1])

    const firstBroadcast = nextJsonMessage(firstClient)
    const secondBroadcast = nextJsonMessage(secondClient)
    await request(baseUrl)
      .post('/api/v1/simulations')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
      .expect(201)
    await expect(firstBroadcast).resolves.toMatchObject({ topic: 'runtime.state', sequence: 2, payload: { status: 'IDLE' } })
    await expect(secondBroadcast).resolves.toMatchObject({ topic: 'runtime.state', sequence: 2, payload: { status: 'IDLE' } })

    firstClient.close()
    secondClient.close()
  })

  it('accepts the native-browser role query adapter on the canonical WebSocket path', async () => {
    const { wsUrl } = await startServer()
    const client = await openWebSocket(`${wsUrl}?role=OPERATOR`)
    const messagesPromise = nextJsonMessages(client, 2)
    client.send(JSON.stringify({
      type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['link.metric'], lastSequence: 0,
    }))
    const messages = await messagesPromise
    expect(messages[0]).toMatchObject({ type: 'subscribed', topics: ['link.metric'] })
    expect(messages[1]).toMatchObject({ topic: 'link.metric', frameId: 'F-00042' })
    expect((messages[1]?.payload as Array<{ linkType: string }>)[0]).toMatchObject({ linkType: 'MICROWAVE' })
    client.close()
  })

  it('publishes runtime.state after a successful REST control mutation', async () => {
    const { baseUrl, wsUrl } = await startServer()
    const client = await openWebSocket(wsUrl, { role: 'OPERATOR' })
    const initialMessages = nextJsonMessages(client, 2)
    client.send(JSON.stringify({
      type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['runtime.state'], lastSequence: 0,
    }))
    await initialMessages

    const runtimeMessage = nextJsonMessage(client)
    await request(baseUrl)
      .post('/api/v1/simulations')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
      .expect(201)
    await expect(runtimeMessage).resolves.toMatchObject({
      topic: 'runtime.state', sequence: 2, payload: { status: 'IDLE' },
    })
    client.close()
  })

  it('destroys upgrades for non-canonical WebSocket paths', async () => {
    const { wsUrl } = await startServer()
    const client = new WebSocket(wsUrl.replace('/ws/v1', '/ws/not-canonical'), {
      origin: ORIGIN,
      headers: { 'X-Demo-Role': 'ADMIN' },
    })
    const closePromise = nextClose(client)
    const errorPromise = new Promise<void>((resolve, reject) => {
      client.once('error', () => resolve())
      client.once('open', () => reject(new Error('Non-canonical WebSocket path opened.')))
    })

    await expect(errorPromise).resolves.toBeUndefined()
    await expect(closePromise).resolves.toMatchObject({ code: 1006 })
  })

  it('tracks active clients through reset invalidation', async () => {
    const httpServer = createHttpServer()
    const controller = attachRealtimeServer(httpServer, new MockProjectionConstructor())

    try {
      httpServer.listen(0, '127.0.0.1')
      await waitForEvent(httpServer, 'listening')

      const address = httpServer.address()
      if (address === null || typeof address === 'string') {
        throw new Error('Expected a TCP listener address.')
      }

      expect(controller.activeClientCount()).toBe(0)
      const client = await openWebSocket(`ws://127.0.0.1:${address.port}/ws/v1`, { role: 'ADMIN' })
      expect(controller.activeClientCount()).toBe(1)
      const initialMessages = nextJsonMessages(client, 3)
      client.send(JSON.stringify({
        type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['runtime.state', 'jammer.event'], lastSequence: 0,
      }))
      await expect(initialMessages).resolves.toEqual([
        expect.objectContaining({ type: 'subscribed' }),
        expect.objectContaining({ topic: 'runtime.state', sequence: 1, payload: expect.objectContaining({ status: 'COMPLETED' }) }),
        expect.objectContaining({ topic: 'jammer.event', sequence: 1, payload: expect.objectContaining({ eventId: 'DET-042' }) }),
      ])
      const statusMessage = nextJsonMessage(client)
      controller.publishJammerStatus({
        time: 42, jammerId: 'JAM-WB-01-TX', platformId: 'STN-01', targetPlatform: 'UAV-01',
        power: 70, frequency: 2200, bandwidth: 40, active: true,
      }, 'F-00042')
      await expect(statusMessage).resolves.toMatchObject({ topic: 'jammer.event', sequence: 2, payload: { power: 70 } })
      const closePromise = nextClose(client)

      controller.invalidateForReset()
      expect(controller.activeClientCount()).toBe(0)
      await expect(closePromise).resolves.toMatchObject({ code: 1008, reason: 'RESET' })
    } finally {
      try {
        await controller.close()
      } finally {
        if (httpServer.listening) {
          await new Promise<void>((resolve, reject) => {
            httpServer.close((error) => error === undefined ? resolve() : reject(error))
          })
        }
        httpServer.removeAllListeners()
      }
    }
  })

  it('rejects a second subscription on an already subscribed client', async () => {
    const { wsUrl } = await startServer()
    const client = await openWebSocket(wsUrl, { role: 'OPERATOR' })
    const firstMessagePromise = nextJsonMessage(client)
    const subscription = {
      type: 'subscribe',
      schemaVersion: '1.0',
      taskId: 'TASK-001',
      topics: ['simulation.frame'],
    }

    client.send(JSON.stringify(subscription))
    await expect(firstMessagePromise).resolves.toMatchObject({ type: 'subscribed' })

    const secondMessagePromise = nextJsonMessage(client)
    const closePromise = nextClose(client)
    client.send(JSON.stringify(subscription))

    await expect(secondMessagePromise).resolves.toMatchObject({
      type: 'rejected',
      code: 'INVALID_ENVELOPE',
      closeCode: 1008,
    })
    await expect(closePromise).resolves.toMatchObject({ code: 1008 })
  })

  it('rejects binary subscriptions and duplicate topics', async () => {
    const { wsUrl } = await startServer()
    const binaryClient = await openWebSocket(wsUrl, { role: 'ADMIN' })
    const binaryMessagePromise = nextJsonMessage(binaryClient)
    const binaryClosePromise = nextClose(binaryClient)
    binaryClient.send(new Uint8Array([1, 2, 3]))

    await expect(binaryMessagePromise).resolves.toMatchObject({
      type: 'rejected',
      code: 'INVALID_ENVELOPE',
    })
    await expect(binaryClosePromise).resolves.toMatchObject({ code: 1008 })

    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'ADMIN',
      payload: {
        type: 'subscribe',
        schemaVersion: '1.0',
        taskId: 'TASK-001',
        topics: ['simulation.frame', 'simulation.frame'],
      },
    })
  })

  it('rejects invalid WebSocket origin, role, topic, and envelope with close 1008', async () => {
    const { wsUrl } = await startServer()

    await expectRejected(wsUrl, 'LOOPBACK_ONLY', { origin: 'http://127.0.0.1:5174', role: 'ADMIN' })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', { role: 'VIEWER' })
    await expectRejected(wsUrl, 'TOPIC_FORBIDDEN', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe',
        schemaVersion: '1.0',
        taskId: 'TASK-001',
        topics: ['node.state'],
      },
    })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe',
        schemaVersion: '2.0',
        taskId: 'TASK-001',
        topics: ['simulation.frame'],
      },
    })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe',
        schemaVersion: '1.0',
        taskId: 'TASK- ',
        topics: ['simulation.frame'],
      },
    })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', { role: 'OPERATOR', payload: null })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', { role: 'OPERATOR', payload: [] })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', { role: 'OPERATOR', payload: '{' })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['simulation.frame'], extra: true,
      },
    })
  })

  it('rejects unknown tasks, unsupported resume gaps, and unsafe sequences', async () => {
    const { wsUrl } = await startServer()

    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe',
        schemaVersion: '1.0',
        taskId: 'TASK-NOT-IN-FIXTURE',
        topics: ['simulation.frame'],
      },
    })
    await expectRejected(wsUrl, 'SEQUENCE_GAP', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe',
        schemaVersion: '1.0',
        taskId: 'TASK-001',
        topics: ['simulation.frame'],
        lastSequence: 1,
      },
    })
    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'OPERATOR',
      payload: {
        type: 'subscribe',
        schemaVersion: '1.0',
        taskId: 'TASK-001',
        topics: ['simulation.frame'],
        lastSequence: 9_007_199_254_740_992,
      },
    })
  })

  it('rejects oversized subscriptions without terminating the server', async () => {
    const { baseUrl, wsUrl } = await startServer()

    await expectRejected(wsUrl, 'INVALID_ENVELOPE', {
      role: 'OPERATOR',
      payload: 'x'.repeat(16_385),
    })

    const transportLimitedClient = await openWebSocket(wsUrl, { role: 'OPERATOR' })
    const transportClosePromise = nextClose(transportLimitedClient)
    transportLimitedClient.send('x'.repeat(65_537))
    await expect(transportClosePromise).resolves.toMatchObject({ code: 1009 })

    await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send({ confirm: true })
      .expect(200)
  })

  it('invalidates old WebSockets and resets projection sequence ownership', async () => {
    const { server, baseUrl, wsUrl } = await startServer()
    const client = await openWebSocket(wsUrl, { role: 'OPERATOR' })
    const acknowledgementPromise = nextJsonMessage(client)
    client.send(JSON.stringify({
      type: 'subscribe',
      schemaVersion: '1.0',
      taskId: 'TASK-001',
      topics: ['simulation.frame'],
    }))
    await acknowledgementPromise

    expect(server.projection.nextSequence('TASK-001', 'simulation.frame')).toBe(2)
    expect(server.projection.nextSequence('TASK-001', 'simulation.frame')).toBe(3)

    const closePromise = nextClose(client)
    await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send({ confirm: true })
      .expect(200)

    await expect(closePromise).resolves.toMatchObject({ code: 1008, reason: 'RESET' })
    expect(server.projection.nextSequence('TASK-001', 'simulation.frame')).toBe(1)
  })

  it('returns P3 same-frame telemetry and events through role-protected REST routes', async () => {
    const { baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }
    const frame = await request(baseUrl)
      .get('/api/v1/simulations/RUN-001/frames/F-00042')
      .set(headers)
      .expect(200)
    expect(frame.body).toMatchObject({ ok: true, data: { frameId: 'F-00042', runId: 'RUN-001', simulationTime: 42 } })

    const events = await request(baseUrl)
      .get('/api/v1/simulations/RUN-001/events')
      .set(headers)
      .expect(200)
    expect(events.body).toMatchObject({ ok: true, data: [{ frameId: 'F-00042' }, { frameId: 'F-00042' }, { frameId: 'F-00042' }], meta: { total: 3 } })

    await request(baseUrl).get('/api/v1/simulations/RUN-001/frames/F-MISSING').set(headers).expect(404)
    await request(baseUrl).get('/api/v1/simulations/RUN-MISSING/events').set(headers).expect(404)
    await request(baseUrl).get('/api/v1/simulations/RUN-001/events').set('Origin', ORIGIN).expect(403)
  })

  it('executes P3 simulation commands and keeps the scenario lock lifecycle consistent', async () => {
    const { server, baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }

    const initialRuns = await request(baseUrl).get('/api/v1/simulations').set(headers).expect(200)
    expect((initialRuns.body as { data: Array<{ uiStatus: string }> }).data[0]?.uiStatus).toBe('COMPLETED')

    const created = await request(baseUrl)
      .post('/api/v1/simulations')
      .set(headers)
      .send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
      .expect(201)
    expect(created.body).toMatchObject({ data: { runId: 'RUN-001', uiStatus: 'IDLE', configLocked: true } })

    const lockedScenario = await request(baseUrl).get('/api/v1/scenarios/SCN-001').set(headers).expect(200)
    expect((lockedScenario.body as { data: ScenarioDraft }).data.locked).toBe(true)
    await request(baseUrl)
      .post('/api/v1/scenarios/SCN-001/validate')
      .set(headers)
      .send({ config: (lockedScenario.body as { data: ScenarioDraft }).data.config })
      .expect(409)

    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'START', mode: 'INTERACTIVE_SINGLE' })
      .expect(200)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'PAUSE' })
      .expect(200)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'STEP', stepCount: 1 })
      .expect(200)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'STOP' })
      .expect(428)

    const awaitingResponse = await request(baseUrl)
      .post('/api/v1/confirmations')
      .set(headers)
      .send({ action: 'SIMULATION_STOP', objectId: 'RUN-001' })
      .expect(201)
    const awaiting = (awaitingResponse.body as { data: ConfirmationContext }).data
    await request(baseUrl)
      .post(`/api/v1/confirmations/${awaiting.confirmationId}`)
      .set(headers)
      .send({ confirm: true })
      .expect(200)
    const stopped = await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'STOP', confirmationId: awaiting.confirmationId })
      .expect(200)
    expect(stopped.body).toMatchObject({
      data: {
        uiStatus: 'STOPPED',
        configLocked: false,
        canonical: { status: 'IDLE', currentTime: 0, progress: 0 },
      },
    })

    const unlockedScenario = await request(baseUrl).get('/api/v1/scenarios/SCN-001').set(headers).expect(200)
    expect((unlockedScenario.body as { data: ScenarioDraft }).data.locked).toBe(false)

    await request(baseUrl)
      .post('/api/v1/simulations')
      .set({ Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' })
      .send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
      .expect(201)
    expect(server.auditSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: 'SIMULATION_CONTROL', action: 'SIMULATION_CREATE', result: 'SUCCESS' }),
      expect.objectContaining({ module: 'SIMULATION_CONTROL', action: 'SIMULATION_COMMAND', result: 'SUCCESS' }),
      expect.objectContaining({ module: 'SIMULATION_CONTROL', action: 'SIMULATION_COMMAND', result: 'ERROR' }),
    ]))
  })

  it('returns typed P3 simulation permission, request, lookup, transition and confirmation errors', async () => {
    const { baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }

    await request(baseUrl).get('/api/v1/simulations').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).post('/api/v1/simulations').set('Origin', ORIGIN).send({}).expect(403)
    await request(baseUrl).get('/api/v1/simulations/RUN-001').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).post('/api/v1/simulations/RUN-001/commands').set('Origin', ORIGIN).send({ command: 'PAUSE' }).expect(403)

    await request(baseUrl).post('/api/v1/simulations').set(headers).send({}).expect(422)
    await request(baseUrl).get('/api/v1/simulations/RUN-MISSING').set(headers).expect(404)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-MISSING/commands')
      .set(headers)
      .send({ command: 'PAUSE' })
      .expect(404)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'PAUSE' })
      .expect(409)

    await request(baseUrl)
      .post('/api/v1/simulations')
      .set(headers)
      .send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
      .expect(201)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'START', mode: 'INTERACTIVE_SINGLE' })
      .expect(200)
    await request(baseUrl)
      .post('/api/v1/simulations/RUN-001/commands')
      .set(headers)
      .send({ command: 'STOP', confirmationId: 'CONF-MISSING' })
      .expect(409)
  })

  it('执行 P4 RF 干扰控制并返回参数拒绝原因', async () => {
    const { server, baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }
    const command = { enabled: true, frequency: 2200, bandwidth: 40, power: 72, direction: 360, duration: 1200 }
    const successResponse = await request(baseUrl)
      .post('/api/v1/tasks/TASK-001/jammers/JAM-WB-01-TX/commands')
      .set(headers)
      .send(command)
      .expect(200)
    expect(successResponse.body).toMatchObject({
      ok: true,
      data: { executionStatus: 'SUCCESS', effectiveFrameId: 'F-00042', reason: '任务手动启扰' },
    })

    const outOfRange = await request(baseUrl)
      .post('/api/v1/tasks/TASK-001/jammers/JAM-WB-01-TX/commands')
      .set(headers)
      .send({ ...command, power: 73 })
      .expect(422)
    expect(outOfRange.body).toMatchObject({ error: { code: 'OUT_OF_RANGE', fieldPath: 'power' } })
    const unavailable = await request(baseUrl)
      .post('/api/v1/tasks/TASK-001/jammers/JAM-SPOT-01-TX/commands')
      .set(headers)
      .send(command)
      .expect(409)
    expect(unavailable.body).toMatchObject({ error: { code: 'DEVICE_DISABLED', fieldPath: 'jammerId' } })
    await request(baseUrl)
      .post('/api/v1/tasks/TASK-001/jammers/JAM-WB-01-TX/commands')
      .set('Origin', ORIGIN)
      .send(command)
      .expect(403)
    expect(server.auditSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: 'SIMULATION_CONTROL', action: 'SIMULATION_JAMMER_COMMAND', result: 'SUCCESS' }),
      expect.objectContaining({ module: 'SIMULATION_CONTROL', action: 'SIMULATION_JAMMER_COMMAND', result: 'ERROR' }),
    ]))
  })

  it('执行 P4 闭环幂等和干扰参数版本同步', async () => {
    const { server, baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }
    const context = { frameId: 'F-00042', detectionEventId: 'DET-042', targetPlatformId: 'UAV-01', affectedLinkId: 'L-DL-03' }
    const closedLoop = await request(baseUrl).post('/api/v1/simulations/RUN-001/events').set(headers).send(context).expect(200)
    expect(closedLoop.body).toMatchObject({ data: { jammerId: 'JAM-WB-01-TX', linkStatus: 'DEGRADED', effectiveFrameId: 'F-00042' } })
    await request(baseUrl).post('/api/v1/simulations/RUN-001/events').set(headers).send(context).expect(409)
    await request(baseUrl).post('/api/v1/simulations/RUN-MISSING/events').set(headers).send(context).expect(404)
    await request(baseUrl).post('/api/v1/simulations/RUN-001/events').set(headers).send({}).expect(422)
    await request(baseUrl).post('/api/v1/simulations/RUN-001/events').set('Origin', ORIGIN).send(context).expect(403)

    const parameters = { enabled: true, frequency: 2200, bandwidth: 40, power: 72, direction: 360, duration: 1200 }
    const synchronized = await request(baseUrl)
      .post('/api/v1/tasks/TASK-001/jammers/JAM-WB-01-TX/parameters')
      .set(headers)
      .send({ version: 5, effectiveFrameId: 'F-00042', parameters })
      .expect(200)
    expect(synchronized.body).toMatchObject({ data: { parameterVersion: 5, nodeParameterVersion: 5, engineParameterVersion: 5, uiParameterVersion: 5 } })
    await request(baseUrl)
      .post('/api/v1/tasks/TASK-001/jammers/JAM-WB-01-TX/parameters')
      .set(headers)
      .send({ version: 5, effectiveFrameId: 'F-00042', parameters })
      .expect(409)
    await request(baseUrl)
      .post('/api/v1/tasks/TASK-001/jammers/JAM-WB-01-TX/parameters')
      .set(headers)
      .send({ version: 6, effectiveFrameId: 'F-00043', parameters })
      .expect(409)
    await request(baseUrl)
      .post('/api/v1/tasks/TASK-001/jammers/JAM-WB-01-TX/parameters')
      .set(headers)
      .send({})
      .expect(422)
    await request(baseUrl)
      .post('/api/v1/tasks/TASK-001/jammers/JAM-WB-01-TX/parameters')
      .set('Origin', ORIGIN)
      .send({ version: 6, effectiveFrameId: 'F-00042', parameters })
      .expect(403)
    expect(server.auditSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'SIMULATION_CLOSED_LOOP', result: 'SUCCESS' }),
      expect.objectContaining({ action: 'SIMULATION_JAMMER_SYNC', result: 'SUCCESS' }),
    ]))
  })

  it('提供 P3 单次与批量报告读取，并执行分级导出验证', async () => {
    const { baseUrl } = await startServer()
    const operatorHeaders = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }
    const adminHeaders = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }

    const list = await request(baseUrl).get('/api/v1/reports').set(operatorHeaders).expect(200)
    expect(list.body).toMatchObject({
      ok: true,
      data: [{ reportId: 'RPT-001', classification: 'LEVEL_II' }, { reportId: 'RPT-BATCH-001', classification: 'LEVEL_III' }],
      meta: { total: 2 },
    })
    const report = await request(baseUrl).get('/api/v1/reports/RPT-001').set(operatorHeaders).expect(200)
    const reportBody = report.body as ApiSuccess<Report>
    expect(reportBody.data.timeSeries).toMatchObject([
      { linkId: 'L-MW-01', sourcePlatformId: 'UAV-01', targetPlatformId: 'GCC-01' },
    ])
    expect(reportBody.data.timeSeries?.[0].points).toHaveLength(3)
    await request(baseUrl).get('/api/v1/reports/RPT-BATCH-001').set(operatorHeaders).expect(200)
    await request(baseUrl).get('/api/v1/reports/RPT-MISSING').set(operatorHeaders).expect(404)
    await request(baseUrl).get('/api/v1/reports').set('Origin', ORIGIN).expect(403)

    const ordinary = await request(baseUrl)
      .post('/api/v1/reports/RPT-001/export')
      .set(operatorHeaders)
      .send({ reportId: 'RPT-001', format: 'HTML' })
      .expect(200)
    expect(ordinary.body).toMatchObject({
      data: { reportId: 'RPT-001', generated: false, status: 'FIXTURE_SUCCESS', verifiedAt: '2026-08-06T10:06:30Z' },
    })

    await request(baseUrl)
      .post('/api/v1/reports/RPT-BATCH-001/export')
      .set(operatorHeaders)
      .send({ reportId: 'RPT-BATCH-001', format: 'CSV' })
      .expect(403)
    await request(baseUrl)
      .post('/api/v1/reports/RPT-BATCH-001/export')
      .set(adminHeaders)
      .send({ reportId: 'RPT-BATCH-001', format: 'PDF' })
      .expect(428)

    const awaitingResponse = await request(baseUrl)
      .post('/api/v1/confirmations')
      .set(adminHeaders)
      .send({ action: 'BATCH_LEVEL_III_EXPORT', objectId: 'RPT-BATCH-001' })
      .expect(201)
    const awaiting = (awaitingResponse.body as { data: ConfirmationContext }).data
    await request(baseUrl)
      .post(`/api/v1/confirmations/${awaiting.confirmationId}`)
      .set(adminHeaders)
      .send({ confirm: true })
      .expect(200)
    const aggregate = await request(baseUrl)
      .post('/api/v1/reports/RPT-BATCH-001/export')
      .set(adminHeaders)
      .send({ reportId: 'RPT-BATCH-001', format: 'PDF', confirmationId: awaiting.confirmationId })
      .expect(200)
    expect(aggregate.body).toMatchObject({
      data: { reportId: 'RPT-BATCH-001', generated: false, verifiedAt: '2026-08-06T10:08:00Z' },
    })
    await request(baseUrl)
      .post('/api/v1/reports/RPT-BATCH-001/export')
      .set(adminHeaders)
      .send({ reportId: 'RPT-BATCH-001', format: 'PDF', confirmationId: awaiting.confirmationId })
      .expect(409)
  })

  it('拒绝 P3 报告导出的无角色、无效请求和未知报告', async () => {
    const { baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }
    await request(baseUrl)
      .post('/api/v1/reports/RPT-001/export')
      .set('Origin', ORIGIN)
      .send({ reportId: 'RPT-001', format: 'HTML' })
      .expect(403)
    for (const body of [
      {},
      { reportId: 'RPT-WRONG', format: 'HTML' },
      { reportId: 'RPT-001', format: 'DOCX' },
      { reportId: 'RPT-001', format: 'HTML', confirmationId: '' },
      { reportId: 'RPT-001', format: 'HTML', extra: true },
    ]) {
      await request(baseUrl).post('/api/v1/reports/RPT-001/export').set(headers).send(body).expect(422)
    }
    await request(baseUrl)
      .post('/api/v1/reports/RPT-MISSING/export')
      .set(headers)
      .send({ reportId: 'RPT-MISSING', format: 'CSV' })
      .expect(404)
  })

  it('filters immutable audit records for ADMIN and rejects invalid roles and filters', async () => {
    const { baseUrl } = await startServer()
    const adminHeaders = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }
    const records = await request(baseUrl).get('/api/v1/admin/audit').set(adminHeaders).expect(200)
    expect(records.body).toMatchObject({
      data: [{
        auditId: 'AUD-001',
        actor: 'admin',
        role: 'ADMIN',
        module: 'SCENARIO_CONFIGURATION',
        result: 'SUCCESS',
        immutableFixture: true,
      }],
      meta: { total: 1 },
    })

    const filtered = await request(baseUrl)
      .get('/api/v1/admin/audit?actor=admin&role=ADMIN&module=SCENARIO_CONFIGURATION&result=SUCCESS&from=2026-08-06T08%3A00%3A00Z&to=2026-08-06T09%3A00%3A00Z')
      .set(adminHeaders)
      .expect(200)
    expect((filtered.body as { data: unknown[] }).data).toHaveLength(1)
    const empty = await request(baseUrl).get('/api/v1/admin/audit?module=REPORTING').set(adminHeaders).expect(200)
    expect(empty.body).toMatchObject({ data: [], meta: { total: 0, pageSize: 1 } })

    await request(baseUrl).get('/api/v1/admin/audit').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).get('/api/v1/admin/audit').set({ Origin: ORIGIN, 'X-Demo-Role': 'ROOT' }).expect(403)
    await request(baseUrl).get('/api/v1/admin/audit').set({ Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }).expect(403)
    await request(baseUrl).get('/api/v1/admin/audit?role=ROOT').set(adminHeaders).expect(400)
    await request(baseUrl).get('/api/v1/admin/audit?from=invalid').set(adminHeaders).expect(400)
    await request(baseUrl)
      .get('/api/v1/admin/audit?from=2026-08-07T00%3A00%3A00Z&to=2026-08-06T00%3A00%3A00Z')
      .set(adminHeaders)
      .expect(400)
  })

  it('consumes AUDIT_EXPORT confirmation once and returns read-only classification evidence', async () => {
    const { baseUrl } = await startServer()
    const adminHeaders = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }
    await request(baseUrl)
      .post('/api/v1/admin/audit/export')
      .set(adminHeaders)
      .send({ export: true })
      .expect(428)
    await request(baseUrl)
      .post('/api/v1/admin/audit/export')
      .set({ Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' })
      .send({ export: true })
      .expect(403)
    await request(baseUrl)
      .post('/api/v1/admin/audit/export')
      .set({ Origin: ORIGIN, 'X-Demo-Role': 'ROOT' })
      .send({ export: true })
      .expect(403)
    await request(baseUrl)
      .post('/api/v1/admin/audit/export')
      .set(adminHeaders)
      .send({ export: false })
      .expect(400)

    const created = await request(baseUrl)
      .post('/api/v1/confirmations')
      .set(adminHeaders)
      .send({ action: 'AUDIT_EXPORT', objectId: 'AUDIT-LOG' })
      .expect(201)
    const context = (created.body as { data: ConfirmationContext }).data
    await request(baseUrl)
      .post(`/api/v1/confirmations/${context.confirmationId}`)
      .set(adminHeaders)
      .send({ confirm: true })
      .expect(200)
    const exported = await request(baseUrl)
      .post('/api/v1/admin/audit/export')
      .set(adminHeaders)
      .send({ export: true, confirmationId: context.confirmationId, module: 'SCENARIO_CONFIGURATION' })
      .expect(200)
    expect(exported.body).toMatchObject({
      data: {
        objectId: 'AUDIT-LOG',
        generated: false,
        classification: 'INTERNAL',
        watermark: '内部使用 · admin · AUDIT-LOG',
        verifiedAt: '2026-08-06T08:00:00Z',
      },
    })
    await request(baseUrl)
      .post('/api/v1/admin/audit/export')
      .set(adminHeaders)
      .send({ export: true, confirmationId: context.confirmationId })
      .expect(409)
  })

  it('提供 P6 固定批次的创建、控制和 12 行结果', async () => {
    const { server, baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }
    const listed = await request(baseUrl).get('/api/v1/batches').set(headers).expect(200)
    expect(listed.body).toMatchObject({ data: [{ batchId: 'BATCH-001', state: 'COMPLETED' }] })
    const detail = await request(baseUrl).get('/api/v1/batches/BATCH-001').set(headers).expect(200)
    expect((detail.body as { data: { runs: unknown[] } }).data.runs).toHaveLength(12)

    const created = await request(baseUrl)
      .post('/api/v1/batches')
      .set(headers)
      .send({ scenarioId: 'SCN-001', powersW: [50, 100, 150, 200], distancesKm: [80, 100, 120], deterministicOrder: true })
      .expect(201)
    expect(created.body).toMatchObject({ data: { state: 'QUEUED' } })
    await request(baseUrl).get('/api/v1/batches/BATCH-001').set(headers).expect(409)
    const started = await request(baseUrl)
      .post('/api/v1/batches/BATCH-001/commands')
      .set(headers)
      .send({ command: 'START' })
      .expect(200)
    expect(started.body).toMatchObject({ data: { state: 'COMPLETED' } })
    expect(server.auditSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'BATCH_CREATE', result: 'SUCCESS' }),
      expect.objectContaining({ action: 'BATCH_COMMAND', result: 'SUCCESS' }),
    ]))
  })

  it('拒绝 P6 批次的无角色、无效请求、未知编号和非法迁移', async () => {
    const { baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }
    await request(baseUrl).get('/api/v1/batches').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).post('/api/v1/batches').set('Origin', ORIGIN).send({}).expect(403)
    await request(baseUrl).get('/api/v1/batches/BATCH-001').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).post('/api/v1/batches/BATCH-001/commands').set('Origin', ORIGIN).send({ command: 'START' }).expect(403)
    await request(baseUrl).post('/api/v1/batches').set(headers).send({}).expect(422)
    await request(baseUrl).post('/api/v1/batches').set(headers)
      .send({ scenarioId: 'SCN-001', powersW: [50], distancesKm: [80], deterministicOrder: true }).expect(422)
    await request(baseUrl).post('/api/v1/batches').set(headers)
      .send({ scenarioId: 'SCN-001', powersW: [1, 2, 3], distancesKm: [4, 5, 6, 7], deterministicOrder: true }).expect(422)
    await request(baseUrl).get('/api/v1/batches/BATCH-MISSING').set(headers).expect(404)
    await request(baseUrl).post('/api/v1/batches/BATCH-MISSING/commands').set(headers).send({ command: 'START' }).expect(404)
    await request(baseUrl).post('/api/v1/batches/BATCH-001/commands').set(headers).send({ command: 'BAD' }).expect(422)
    await request(baseUrl).post('/api/v1/batches/BATCH-001/commands').set(headers).send({ command: 'START' }).expect(409)
  })

  it('提供 P6 只读回放命令并在全局重置后恢复游标', async () => {
    const { baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }
    const listed = await request(baseUrl).get('/api/v1/replays').set(headers).expect(200)
    expect(listed.body).toMatchObject({ data: [{ replayId: 'REPLAY-001', runId: 'RUN-001' }] })
    await request(baseUrl).get('/api/v1/replays/REPLAY-001').set(headers).expect(200)
    await request(baseUrl).post('/api/v1/replays/REPLAY-001/commands').set(headers).send({ command: 'PLAY' }).expect(200)
    await request(baseUrl).post('/api/v1/replays/REPLAY-001/commands').set(headers).send({ command: 'SEEK', value: 2539 }).expect(200)
    const paused = await request(baseUrl).post('/api/v1/replays/REPLAY-001/commands').set(headers).send({ command: 'PAUSE' }).expect(200)
    expect(paused.body).toMatchObject({ data: { currentTimeS: 2539, state: 'PAUSED' } })
    const moved = await request(baseUrl).post('/api/v1/replays/REPLAY-001/commands').set(headers).send({ command: 'SEEK', value: 42 }).expect(200)
    expect(moved.body).toMatchObject({ data: { currentTimeS: 42, state: 'PAUSED' } })
    await request(baseUrl).post('/api/v1/reset').set({ Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }).send({ confirm: true }).expect(200)
    const restored = await request(baseUrl).get('/api/v1/replays/REPLAY-001').set(headers).expect(200)
    expect(restored.body).toMatchObject({ data: { currentTimeS: 2537, state: 'PAUSED' } })
  })

  it('拒绝 P6 回放的无角色、未知编号、无效命令和非法迁移', async () => {
    const { baseUrl } = await startServer()
    const headers = { Origin: ORIGIN, 'X-Demo-Role': 'OPERATOR' }
    await request(baseUrl).get('/api/v1/replays').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).get('/api/v1/replays/REPLAY-001').set('Origin', ORIGIN).expect(403)
    await request(baseUrl).post('/api/v1/replays/REPLAY-001/commands').set('Origin', ORIGIN).send({ command: 'PLAY' }).expect(403)
    await request(baseUrl).get('/api/v1/replays/REPLAY-MISSING').set(headers).expect(404)
    await request(baseUrl).post('/api/v1/replays/REPLAY-MISSING/commands').set(headers).send({ command: 'PLAY' }).expect(404)
    await request(baseUrl).post('/api/v1/replays/REPLAY-001/commands').set(headers).send({ command: 'BAD' }).expect(422)
    await request(baseUrl).post('/api/v1/replays/REPLAY-001/commands').set(headers).send({ command: 'PAUSE' }).expect(409)
  })
})

// @vitest-environment node
// B1 / L02 / V04：发布引用与目标发布的扩展失败测试。
// 覆盖一次发布≥2条来源引用、第一条新增成功第二条失败；SQLite 与内存分支；不同类型目标
// （RUN / TEMPLATE 新建 / SCENARIO 复制）真实 HTTP 入口；只撤销本次新增、保留旧引用；
// 失败无半目标、重试成功。ARCHIVE 走真实 onPublished/onDiscarded 所用的登记 helper。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioDraft } from '../../src/contracts/domain-models'
import { EQUIPMENT } from '../fixtures/equipment'

const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { EquipmentSqliteStorage } = await import('../../server/local/' + 'equipment-sqlite.js')
const { ScenarioSqliteStorage } = await import('../../server/local/' + 'scenario-sqlite.js')
const { TemplateSqliteStorage } = await import('../../server/local/' + 'template-sqlite.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { AdminProjection } = await import('../../server/admin/' + 'projection.js')
const { registerPublishedParameterSources } = await import('../../server/local/' + 'equipment-publish.js')
const { SimulationProjection } = await import('../../server/simulations/' + 'projection.js')
const { default: request } = await import('super' + 'test')

const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })

async function setupSqlite(createRunId?: () => string) {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-publish-rollback-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const scenePath = join(directory, 'scenarios.db'), equipmentPath = join(directory, 'equipment.db')
  const scenarioStorage = new ScenarioSqliteStorage(scenePath, { equipmentPath, masterDataPath: join(directory, 'master.db') })
  const equipmentStorage = new EquipmentSqliteStorage(equipmentPath, scenePath)
  cleanups.push(() => { equipmentStorage.close(); scenarioStorage.close() })
  const server = (await import('../../server/' + 'app.js')).createMockServer({ port: 0, scenarioStorage, equipmentStorage, ...(createRunId === undefined ? {} : { createRunId }) })
  cleanups.push(() => server.close())
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  await api.post('/api/v1/admin/equipment').set(headers).send(EQUIPMENT).expect(201)
  return { api, equipmentStorage, scenarioStorage, server }
}
/** 显式注入真实 TemplateSqliteStorage 的 SQLite 分支；用于模板目标持久化提交失败链路。 */
async function setupSqliteWithTemplates() {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-publish-tpl-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const scenePath = join(directory, 'scenarios.db'), equipmentPath = join(directory, 'equipment.db')
  const scenarioStorage = new ScenarioSqliteStorage(scenePath, { equipmentPath, masterDataPath: join(directory, 'master.db') })
  const equipmentStorage = new EquipmentSqliteStorage(equipmentPath, scenePath)
  const templateStorage = new TemplateSqliteStorage(scenePath)
  cleanups.push(() => { templateStorage.close(); equipmentStorage.close(); scenarioStorage.close() })
  const server = (await import('../../server/' + 'app.js')).createMockServer({ port: 0, scenarioStorage, equipmentStorage, templateStorage })
  cleanups.push(() => server.close())
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  await api.post('/api/v1/admin/equipment').set(headers).send(EQUIPMENT).expect(201)
  return { api, equipmentStorage, scenarioStorage, templateStorage, server }
}
async function setupMemory() {
  const server = (await import('../../server/' + 'app.js')).createMockServer({ port: 0 })
  cleanups.push(() => server.close())
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  // 内存分支需先把装备写入内存投影，登记时的存在性校验才会通过。
  await api.post('/api/v1/admin/equipment').set(headers).send(EQUIPMENT).expect(201)
  return { api }
}

/** 两条 MICROWAVE 链路各带一条 EQUIPMENT 参数来源：一次发布产生两条不同来源引用。 */
function twoLinkDraft(id = 'SCN-001'): ScenarioDraft {
  const draft = new ScenarioProjection().get('SCN-001').data
  draft.config.scenario.id = id
  Object.assign(draft.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
  const links = draft.config.links.filter((link: { type: string }) => link.type === 'MICROWAVE')
  links.slice(0, 2).forEach((link: { frequency: number; modulation: string; berThreshold: number; parameterSource?: unknown }) => {
    link.frequency = 150; link.modulation = 'QPSK'; link.berThreshold = EQUIPMENT.berThreshold as number
    link.parameterSource = { kind: 'EQUIPMENT', sourceId: EQUIPMENT.equipmentId, sourceVersion: 1, fields: ['modulation', 'berThreshold'] }
  })
  return draft
}
async function createScenario(api: ReturnType<typeof request>, draft: ScenarioDraft) {
  const created = await api.post('/api/v1/scenarios').set(headers).send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: 0 })
  if (created.status !== 201) throw new Error(`scenario create ${created.status}: ${JSON.stringify(created.body)}`)
}
/** 让本次运行在引用全部登记成功后的目标提交阶段一次性抛出（模拟提交/持久化失败）。 */
function failRunTargetCommitOnce() {
  const original = SimulationProjection.prototype.create
  let fired = false
  SimulationProjection.prototype.create = function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args as never) as { ok?: boolean }
    if (!fired && result && result.ok) { fired = true; throw new Error('AUDIT run target commit failure') }
    return result
  }
  return () => { SimulationProjection.prototype.create = original }
}
/** 让本次发布第二条引用登记失败；返回恢复函数。 */
function failSecondReference() {
  const original = AdminProjection.prototype.addPublishedReference
  let calls = 0
  AdminProjection.prototype.addPublishedReference = function (reference: Parameters<typeof original>[0]) {
    calls += 1
    if (calls === 2) throw new Error('AUDIT second published reference failure')
    return original.call(this, reference)
  }
  return () => { AdminProjection.prototype.addPublishedReference = original }
}

describe('B1 发布引用多引用失败回滚', () => {
  it('RUN：两条来源第一条成功第二条失败→503，无新引用、无残留运行，重试 201；其他目标旧引用保留', async () => {
    const { api, equipmentStorage } = await setupSqlite()
    await createScenario(api, twoLinkDraft())
    const before = (await api.get('/api/v1/simulations').set(headers).expect(200)).body.data
    // 预置一条指向其他目标的既有引用，验证不会被误删
    const admin = new AdminProjection(undefined, equipmentStorage)
    admin.capturePublishedParameterSources(twoLinkDraft().config, { targetType: 'TEMPLATE', targetId: 'TPL-SEED', targetVersion: '1' }, 'admin')
    const seeded = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)
    expect(seeded.length).toBe(2)
    const restore = failSecondReference()
    let failed: { status: number }
    try { failed = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }) } finally { restore() }
    expect(failed!.status).toBe(503)
    // 只保留预置引用，本次新增全部撤销
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)).toEqual(seeded)
    expect((await api.get('/api/v1/simulations').set(headers).expect(200)).body.data).toEqual(before)
    // 重试成功
    const retry = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
    expect(retry.status).toBe(201)
    const after = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)
    expect(after.filter((row: { targetType: string }) => row.targetType === 'RUN')).toHaveLength(2)
    expect(after.filter((row: { targetId: string }) => row.targetId === 'TPL-SEED')).toHaveLength(2)
  })

  it('TEMPLATE 新建：两条来源第二条失败→503，无半模板、无新引用，重试 201', async () => {
    const { api, equipmentStorage } = await setupSqlite()
    const draft = twoLinkDraft()
    const restore = failSecondReference()
    let failed: { status: number }
    try { failed = await api.post('/api/v1/templates').set(headers).send({ name: '多来源模板', config: draft.config, uiExtensions: draft.uiExtensions }) } finally { restore() }
    expect(failed!.status).toBe(503)
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)).toEqual([])
    const names = (await api.get('/api/v1/templates').set(headers).expect(200)).body.data.map((t: { name: string }) => t.name)
    expect(names).not.toContain('多来源模板')
    const retry = await api.post('/api/v1/templates').set(headers).send({ name: '多来源模板', config: draft.config, uiExtensions: draft.uiExtensions })
    expect(retry.status).toBe(201)
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId).filter((row: { targetType: string }) => row.targetType === 'TEMPLATE')).toHaveLength(2)
  })

  it('SCENARIO 复制：两条来源第二条失败→503，场景未被半写，重试 201', async () => {
    const { api, equipmentStorage } = await setupSqlite()
    const draft = twoLinkDraft()
    const template = await api.post('/api/v1/templates').set(headers).send({ name: '复制模板', config: draft.config, uiExtensions: draft.uiExtensions }).expect(201)
    const templateId = template.body.data.templateId
    // 复制会写入默认目标场景 SCN-001（SQLite 起始为空），失败后不应留下半写场景
    expect((await api.get('/api/v1/scenarios/SCN-001').set(headers)).status).toBe(404)
    const refsBefore = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)
    const restore = failSecondReference()
    let failed: { status: number }
    try { failed = await api.post(`/api/v1/templates/${templateId}/copy`).set(headers).send({ name: '复制场景' }) } finally { restore() }
    expect(failed!.status).toBe(503)
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)).toEqual(refsBefore)
    expect((await api.get('/api/v1/scenarios/SCN-001').set(headers)).status).toBe(404)
    const retry = await api.post(`/api/v1/templates/${templateId}/copy`).set(headers).send({ name: '复制场景' })
    expect(retry.status).toBe(201)
    expect((await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data.config.scenario.id).toBe('SCN-001')
  })

  it('RUN：两条来源登记全部成功后目标提交(create)一次性失败→503，引用撤销、运行不残留，重试 201', async () => {
    const { api, equipmentStorage } = await setupSqlite()
    await createScenario(api, twoLinkDraft())
    const before = (await api.get('/api/v1/simulations').set(headers).expect(200)).body.data
    const restore = failRunTargetCommitOnce()
    let failed: { status: number }
    try { failed = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }) } finally { restore() }
    expect(failed!.status).toBe(503)
    // 引用全部登记成功后目标提交失败：本次新增引用被撤销，不残留
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)).toEqual([])
    expect((await api.get('/api/v1/simulations').set(headers).expect(200)).body.data).toEqual(before)
    const retry = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
    expect(retry.status).toBe(201)
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId).filter((row: { targetType: string }) => row.targetType === 'RUN')).toHaveLength(2)
  })

  it('内存分支 RUN：第二条引用登记失败即回滚→503，无残留运行与场景锁，重试 201', async () => {
    const { api } = await setupMemory()
    await createScenario(api, twoLinkDraft('SCN-MEM'))
    const beforeScene = (await api.get('/api/v1/scenarios/SCN-MEM').set(headers).expect(200)).body.data
    const beforeRuns = (await api.get('/api/v1/simulations').set(headers).expect(200)).body.data
    const restore = failSecondReference()
    let failed: { status: number }
    // 内存分支使用与 SQLite 相同的注入点：第二条来源引用登记失败，验证回滚分支不残留运行与场景锁
    try { failed = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-MEM' }) } finally { restore() }
    expect(failed!.status).toBe(503)
    const afterRuns = (await api.get('/api/v1/simulations').set(headers).expect(200)).body.data
    expect(afterRuns).toEqual(beforeRuns)
    expect(afterRuns.some((run: { scenarioId: string }) => run.scenarioId === 'SCN-MEM')).toBe(false)
    expect((await api.get('/api/v1/scenarios/SCN-MEM').set(headers).expect(200)).body.data).toEqual(beforeScene)
    const retry = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-MEM' })
    expect(retry.status).toBe(201)
  })

  it('ARCHIVE 登记 helper：第二条失败只撤销本次新增，保留既有其他目标引用', async () => {
    const { equipmentStorage } = await setupSqlite()
    const admin = new AdminProjection(undefined, equipmentStorage)
    admin.capturePublishedParameterSources(twoLinkDraft().config, { targetType: 'TEMPLATE', targetId: 'TPL-KEEP', targetVersion: '1' }, 'admin')
    const seed = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)
    let calls = 0
    expect(() => registerPublishedParameterSources(twoLinkDraft().config, { targetType: 'ARCHIVE', targetId: 'RESULT-1', targetVersion: '1' }, new Date().toISOString(),
      (reference: Parameters<typeof equipmentStorage.addPublishedReference>[0]) => { calls += 1; if (calls === 2) throw new Error('AUDIT archive second ref failure'); return equipmentStorage.addPublishedReference(reference) },
      (reference: Parameters<typeof equipmentStorage.removePublishedReference>[0]) => equipmentStorage.removePublishedReference(reference))).toThrow('AUDIT archive second ref failure')
    // 只保留既有引用；本次 ARCHIVE 新增被撤销
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)).toEqual(seed)
  })

  it('B3 失败审计：运行/模板失败只记失败、不先记成功；成功重试记录正确', async () => {
    const { api, server } = await setupSqlite()
    await createScenario(api, twoLinkDraft())
    const restoreRun = failSecondReference()
    let failed: { status: number }
    try { failed = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }) } finally { restoreRun() }
    expect(failed!.status).toBe(503)
    const runAudit = server.auditSnapshot().filter((record: { action: string }) => record.action === 'SIMULATION_CREATE')
    expect(runAudit.some((r: { result: string; actor: string }) => r.result === 'ERROR' && r.actor === 'admin')).toBe(true)
    expect(runAudit.some((r: { result: string }) => r.result === 'SUCCESS')).toBe(false)

    const draft = twoLinkDraft()
    const restoreTemplate = failSecondReference()
    let failedTemplate: { status: number }
    try { failedTemplate = await api.post('/api/v1/templates').set(headers).send({ name: '审计模板', config: draft.config, uiExtensions: draft.uiExtensions }) } finally { restoreTemplate() }
    expect(failedTemplate!.status).toBe(503)
    const templateAudit = server.auditSnapshot().filter((record: { action: string }) => record.action === 'TEMPLATE_CREATE')
    expect(templateAudit.some((r: { result: string }) => r.result === 'ERROR')).toBe(true)
    expect(templateAudit.some((r: { result: string }) => r.result === 'SUCCESS')).toBe(false)

    const retry = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
    expect(retry.status).toBe(201)
    expect(server.auditSnapshot().some((record: { action: string; result: string; objectId?: string }) => record.action === 'SIMULATION_CREATE' && record.result === 'SUCCESS' && record.objectId === retry.body.data.runId)).toBe(true)

    // 模板复制（沿用 TEMPLATE_COPY，审计对象为源 templateId）：失败只记 ERROR，无提前 SUCCESS；重试记 SUCCESS
    const template = await api.post('/api/v1/templates').set(headers).send({ name: '复制审计模板', config: twoLinkDraft().config, uiExtensions: twoLinkDraft().uiExtensions }).expect(201)
    const templateId = template.body.data.templateId as string
    const restoreCopy = failSecondReference()
    let copyFailed: { status: number }
    try { copyFailed = await api.post(`/api/v1/templates/${templateId}/copy`).set(headers).send({ name: '复制审计场景', scenarioId: 'SCN-COPY' }) } finally { restoreCopy() }
    expect(copyFailed!.status).toBe(503)
    const copyAudit = server.auditSnapshot().filter((record: { action: string }) => record.action === 'TEMPLATE_COPY')
    expect(copyAudit.some((r: { result: string; actor: string }) => r.result === 'ERROR' && r.actor === 'admin')).toBe(true)
    expect(copyAudit.some((r: { result: string }) => r.result === 'SUCCESS')).toBe(false)
    const copyRetry = await api.post(`/api/v1/templates/${templateId}/copy`).set(headers).send({ name: '复制审计场景', scenarioId: 'SCN-COPY' })
    expect(copyRetry.status).toBe(201)
    expect(server.auditSnapshot().some((record: { action: string; result: string; objectId?: string }) => record.action === 'TEMPLATE_COPY' && record.result === 'SUCCESS' && record.objectId === templateId)).toBe(true)
    // 内部补偿不得冒充用户删除（实际动作名为 SCENARIO_DELETE / TEMPLATE_DELETE）
    expect(server.auditSnapshot().some((record: { action: string }) => ['SCENARIO_DELETE', 'TEMPLATE_DELETE', 'DELETE'].includes(record.action))).toBe(false)
  })

  it('B3 SCENARIO COPY 目标持久化失败：真实 SQLite save 注入→503、目标不存在、旧引用保留、TEMPLATE_COPY ERROR；重试成功 SUCCESS', async () => {
    const { api, equipmentStorage, scenarioStorage, server } = await setupSqlite()
    const draft = twoLinkDraft()
    const template = await api.post('/api/v1/templates').set(headers).send({ name: '目标持久化模板', config: draft.config, uiExtensions: draft.uiExtensions }).expect(201)
    const templateId = template.body.data.templateId as string
    const refsBefore = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)
    const auditCopyBefore = server.auditSnapshot().filter((row: { action: string }) => row.action === 'TEMPLATE_COPY').length
    let injected = false
    const saveSpy = vi.spyOn(scenarioStorage, 'save').mockImplementationOnce(() => { injected = true; throw new Error('AUDIT temporary scenario save failure') })
    let failed: { status: number; body: { error?: { code?: string } } }
    try { failed = await api.post(`/api/v1/templates/${templateId}/copy`).set(headers).send({ name: '持久化失败副本', scenarioId: 'SCN-PERSIST-COPY' }) } finally { saveSpy.mockRestore() }
    expect(injected).toBe(true)
    expect(failed!.status).toBe(503)
    expect(failed!.body.error?.code).toBe('ATOMIC_REPLACE_FAILED')
    // 目标未创建、旧引用不变、无本次残留引用
    expect((await api.get('/api/v1/scenarios/SCN-PERSIST-COPY').set(headers)).status).toBe(404)
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)).toEqual(refsBefore)
    // 本次请求审计增量：源模板 ERROR，且无本次 SUCCESS
    const delta = server.auditSnapshot().filter((row: { action: string }) => row.action === 'TEMPLATE_COPY').slice(auditCopyBefore)
    expect(delta).toEqual(expect.arrayContaining([expect.objectContaining({ actor: 'admin', role: 'ADMIN', action: 'TEMPLATE_COPY', objectId: templateId, result: 'ERROR' })]))
    expect(delta.some((row: { result: string }) => row.result === 'SUCCESS')).toBe(false)
    // 去掉故障后重试成功：目标存在、引用完整、存在正确 SUCCESS
    const retry = await api.post(`/api/v1/templates/${templateId}/copy`).set(headers).send({ name: '持久化失败副本', scenarioId: 'SCN-PERSIST-COPY' })
    expect(retry.status).toBe(201)
    expect((await api.get('/api/v1/scenarios/SCN-PERSIST-COPY').set(headers)).status).toBe(200)
    expect(server.auditSnapshot().some((row: { action: string; result: string; objectId?: string }) => row.action === 'TEMPLATE_COPY' && row.result === 'SUCCESS' && row.objectId === templateId)).toBe(true)
  })

  it('B1 TEMPLATE 真实 SQLite 目标提交失败：注入 TemplateSqliteStorage.save→503、无半模板、引用回滚、ERROR 审计，重试成功且引用完整', async () => {
    const { api, equipmentStorage, templateStorage, server } = await setupSqliteWithTemplates()
    const draft = twoLinkDraft()
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)).toEqual([])
    // 记录预览 templateId（测试侧 spy，不改变行为）；失败审计 objectId 必须等于它。
    const { TemplateProjection } = await import('../../server/templates/' + 'projection.js')
    let previewTemplateId = ''
    const originalPreview = TemplateProjection.prototype.previewCreate
    vi.spyOn(TemplateProjection.prototype, 'previewCreate').mockImplementation(function (this: unknown, value: unknown) {
      const preview = originalPreview.call(this as never, value)
      if (preview.ok) previewTemplateId = preview.data.templateId
      return preview
    } as never)
    let injected = false
    const saveSpy = vi.spyOn(templateStorage, 'save').mockImplementationOnce(() => { injected = true; throw new Error('AUDIT template save failure') })
    let failed: { status: number; body: { error?: { code?: string } } }
    try { failed = await api.post('/api/v1/templates').set(headers).send({ name: '模板持久化失败', config: draft.config, uiExtensions: draft.uiExtensions }) } finally { saveSpy.mockRestore() }
    expect(injected).toBe(true)
    expect(failed!.status).toBe(503)
    // 无半模板、本次新增引用撤销
    expect((await api.get('/api/v1/templates').set(headers).expect(200)).body.data).toEqual([])
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)).toEqual([])
    // 恰好一条 ERROR：actor/role/action/objectId/result 全核对，且无本次虚假 SUCCESS
    const failedAudits = server.auditSnapshot().filter((row: { action: string }) => row.action === 'TEMPLATE_CREATE')
    expect(failedAudits).toHaveLength(1)
    expect(failedAudits[0]).toMatchObject({ actor: 'admin', role: 'ADMIN', action: 'TEMPLATE_CREATE', objectId: previewTemplateId, result: 'ERROR' })
    expect(previewTemplateId).not.toBe('')
    // 恢复后重试：模板与两条来源引用完整
    const retry = await api.post('/api/v1/templates').set(headers).send({ name: '模板持久化失败', config: draft.config, uiExtensions: draft.uiExtensions })
    expect(retry.status).toBe(201)
    const list = (await api.get('/api/v1/templates').set(headers).expect(200)).body.data
    expect(list).toHaveLength(1)
    expect(list[0].templateId).toBe(retry.body.data.templateId)
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId).filter((row: { targetType: string }) => row.targetType === 'TEMPLATE')).toHaveLength(2)
    const successAudits = server.auditSnapshot().filter((row: { action: string; result: string }) => row.action === 'TEMPLATE_CREATE' && row.result === 'SUCCESS')
    expect(successAudits).toHaveLength(1)
    expect(successAudits[0]).toMatchObject({ actor: 'admin', role: 'ADMIN', objectId: retry.body.data.templateId, result: 'SUCCESS' })
  })

  it('B1 COPY 已有目标保存失败：原对象/内容/revision 不变、原引用保留；重试成功且引用完整', async () => {
    const { api, equipmentStorage, scenarioStorage } = await setupSqlite()
    await createScenario(api, twoLinkDraft())
    const before = (await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data
    const template = await api.post('/api/v1/templates').set(headers).send({ name: '已有目标模板', config: twoLinkDraft().config, uiExtensions: twoLinkDraft().uiExtensions }).expect(201)
    const templateId = template.body.data.templateId as string
    const refsBefore = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)
    let injected = false
    const saveSpy = vi.spyOn(scenarioStorage, 'save').mockImplementationOnce(() => { injected = true; throw new Error('AUDIT existing target save failure') })
    let failed: { status: number }
    try { failed = await api.post(`/api/v1/templates/${templateId}/copy`).set(headers).send({ name: '已有目标副本', scenarioId: 'SCN-001' }) } finally { saveSpy.mockRestore() }
    expect(injected).toBe(true)
    expect(failed!.status).toBe(503)
    // 原对象、内容、revision 不变；原引用保留
    const after = (await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data
    expect(after.revision).toBe(before.revision)
    expect(after.config.scenario.name).toBe(before.config.scenario.name)
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)).toEqual(refsBefore)
    // 重试成功：revision 前进一版，SCENARIO 引用完整（2 条，无重复）
    const retry = await api.post(`/api/v1/templates/${templateId}/copy`).set(headers).send({ name: '已有目标副本', scenarioId: 'SCN-001' })
    expect(retry.status).toBe(201)
    expect(retry.body.data.revision).toBe(before.revision + 1)
    expect(retry.body.data.config.scenario.name).toBe('已有目标副本')
    const scenarioRefs = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId).filter((row: { targetType: string; targetId: string }) => row.targetType === 'SCENARIO' && row.targetId === 'SCN-001')
    expect(scenarioRefs).toHaveLength(2)
    expect(new Set(scenarioRefs.map((row: { sourceSummary: string }) => row.sourceSummary)).size).toBe(2)
  })

  /** 真实写入后返回 ID 错配（revision 保持真实值），触发既有补偿分支。 */
  function armCopyIdMismatch(hit: { value: boolean; written?: unknown }, probe?: () => unknown) {
    const original = ScenarioProjection.prototype.copyTemplate
    vi.spyOn(ScenarioProjection.prototype, 'copyTemplate').mockImplementationOnce(function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this as never, args as never)
      if (!result.ok) return result
      hit.value = true
      // 命中证据：原实现真实写入完成后、返回错配结果之前，立即读一次真实存储
      hit.written = probe?.()
      return { ...result, data: { ...result.data, config: { ...result.data.config, scenario: { ...result.data.config.scenario, id: 'SCN-MISMATCH' } } } }
    } as never)
  }

  it('B3-1a 新建目标已写入后 ID 错配：补偿删除目标、撤销本次引用、旧引用保留、仅 1 条 TEMPLATE_COPY/ERROR；重试成功', async () => {
    const { api, equipmentStorage, scenarioStorage, server } = await setupSqliteWithTemplates()
    const draft = twoLinkDraft()
    const template = await api.post('/api/v1/templates').set(headers).send({ name: '错配新建源', config: draft.config, uiExtensions: draft.uiExtensions }).expect(201)
    const templateId = template.body.data.templateId as string
    const refsBefore = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)
    const hit: { value: boolean; written?: unknown } = { value: false }
    armCopyIdMismatch(hit, () => scenarioStorage.list())
    const failed = await api.post(`/api/v1/templates/${templateId}/copy`).set(headers).send({ name: '错配新目标', scenarioId: 'SCN-MISMATCH-NEW' })
    expect(hit.value).toBe(true)
    // 命中证据：补偿前真实存储中已有本次写入的目标（revision 1）
    expect((hit.written as Array<{ revision: number }>).map(draft => draft.revision)).toContain(1)
    expect(failed.status).toBe(503)
    // 新建目标已被补偿删除；本次引用撤销；旧引用保留
    expect((await api.get('/api/v1/scenarios/SCN-MISMATCH-NEW').set(headers)).status).toBe(404)
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)).toEqual(refsBefore)
    // 审计：恰好 1 条 TEMPLATE_COPY/ERROR（源 templateId），无内部删除、无 ARCHIVE
    const audits = server.auditSnapshot()
    const copyAudits = audits.filter((row: { action: string }) => row.action === 'TEMPLATE_COPY')
    expect(copyAudits).toHaveLength(1)
    expect(copyAudits[0]).toMatchObject({ actor: 'admin', role: 'ADMIN', action: 'TEMPLATE_COPY', objectId: templateId, result: 'ERROR' })
    expect(audits.some((row: { action: string }) => ['SCENARIO_DELETE', 'TEMPLATE_DELETE', 'ARCHIVE'].includes(row.action))).toBe(false)
    // 重试成功：目标存在、SUCCESS 一条、引用完整且无重复
    const retry = await api.post(`/api/v1/templates/${templateId}/copy`).set(headers).send({ name: '错配新目标', scenarioId: 'SCN-MISMATCH-NEW' })
    expect(retry.status).toBe(201)
    expect((await api.get('/api/v1/scenarios/SCN-MISMATCH-NEW').set(headers)).status).toBe(200)
    const retryAudits = server.auditSnapshot().filter((row: { action: string; result: string }) => row.action === 'TEMPLATE_COPY')
    expect(retryAudits.filter((row: { result: string }) => row.result === 'SUCCESS')).toHaveLength(1)
    expect(retryAudits.filter((row: { result: string }) => row.result === 'SUCCESS')[0]).toMatchObject({ objectId: templateId, result: 'SUCCESS' })
    const scenarioRefs = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId).filter((row: { targetType: string; targetId: string }) => row.targetType === 'SCENARIO' && row.targetId === 'SCN-MISMATCH-NEW')
    expect(scenarioRefs).toHaveLength(2)
    expect(new Set(scenarioRefs.map((row: { sourceSummary: string }) => row.sourceSummary)).size).toBe(2)
  })

  it('B3-1b 已有草稿已写入后 ID 错配：补偿 undo 回复制前 revision/内容、撤销本次引用、无删除审计；重试成功', async () => {
    const { api, equipmentStorage, scenarioStorage, server } = await setupSqliteWithTemplates()
    await createScenario(api, twoLinkDraft('SCN-EXIST'))
    const before = (await api.get('/api/v1/scenarios/SCN-EXIST').set(headers).expect(200)).body.data
    const template = await api.post('/api/v1/templates').set(headers).send({ name: '错配草稿源', config: twoLinkDraft().config, uiExtensions: twoLinkDraft().uiExtensions }).expect(201)
    const templateId = template.body.data.templateId as string
    const refsBefore = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)
    const hit: { value: boolean; written?: unknown } = { value: false }
    armCopyIdMismatch(hit, () => scenarioStorage.list())
    const failed = await api.post(`/api/v1/templates/${templateId}/copy`).set(headers).send({ name: '错配草稿副本', scenarioId: 'SCN-EXIST' })
    expect(hit.value).toBe(true)
    // 命中证据：补偿前真实存储中已有本次写入的草稿（复制后 revision）
    expect((hit.written as Array<{ revision: number }>).map(draft => draft.revision)).toContain(before.revision + 1)
    expect(failed.status).toBe(503)
    // 补偿走既有 undo（追加恢复修订）：内容回复制前，但 revision 前进两版（复制+1、undo+1）；
    // 02/03 规则不可回退历史修订号，此处不回退计数，属既有语义而非缺陷。
    const after = (await api.get('/api/v1/scenarios/SCN-EXIST').set(headers).expect(200)).body.data
    expect(after.revision).toBe(before.revision + 2)
    expect(after.config.scenario.name).toBe(before.config.scenario.name)
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)).toEqual(refsBefore)
    // 审计：恰好 1 条 TEMPLATE_COPY/ERROR，无内部删除、无 ARCHIVE
    const audits = server.auditSnapshot()
    const copyAudits = audits.filter((row: { action: string }) => row.action === 'TEMPLATE_COPY')
    expect(copyAudits).toHaveLength(1)
    expect(copyAudits[0]).toMatchObject({ actor: 'admin', role: 'ADMIN', action: 'TEMPLATE_COPY', objectId: templateId, result: 'ERROR' })
    expect(audits.some((row: { action: string }) => ['SCENARIO_DELETE', 'TEMPLATE_DELETE', 'ARCHIVE'].includes(row.action))).toBe(false)
    // 重试成功：revision 前进一版、SUCCESS 一条、SCENARIO 引用完整
    const retry = await api.post(`/api/v1/templates/${templateId}/copy`).set(headers).send({ name: '错配草稿副本', scenarioId: 'SCN-EXIST' })
    expect(retry.status).toBe(201)
    expect(retry.body.data.revision).toBe(after.revision + 1)
    expect(retry.body.data.config.scenario.name).toBe('错配草稿副本')
    const scenarioRefs = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId).filter((row: { targetType: string; targetId: string }) => row.targetType === 'SCENARIO' && row.targetId === 'SCN-EXIST')
    expect(scenarioRefs).toHaveLength(2)
    expect(server.auditSnapshot().filter((row: { action: string; result: string }) => row.action === 'TEMPLATE_COPY' && row.result === 'SUCCESS')).toHaveLength(1)
  })
})


describe('B1-2c 真实 HTTP 发布提交失败：只撤新增、旧引用 createdAt 保留、重试无重复', () => {
  it('B1-2c RUN 固定 runId：旧引用完整匹配去重，目标提交失败只撤 R_new；重试集合恰为旧 3 + 新 1', async () => {
    const { api, equipmentStorage } = await setupSqlite(() => 'RUN-DEDUP')
    // 先经真实 HTTP 升到 v2（当前版本 2、历史 v1），再建引用 v2 的草稿场景
    const updated = await api.put(`/api/v1/admin/equipment/${EQUIPMENT.equipmentId}`).set(headers).send({ ...structuredClone(EQUIPMENT) })
    expect(updated.status).toBe(200)
    expect(updated.body.data.version).toBe(2)
    const draft = twoLinkDraft()
    for (const link of draft.config.links) if (link.parameterSource?.kind === 'EQUIPMENT') link.parameterSource.sourceVersion = 2
    await createScenario(api, draft)
    const target = { targetType: 'RUN' as const, targetId: 'RUN-DEDUP', targetVersion: '1' }
    const summaryOld = 'links[L-MW-01].parameterSource fields=modulation,berThreshold'
    const summaryNew = 'links[L-MW-05].parameterSource fields=modulation,berThreshold'
    const T0 = '2020-01-01T00:00:00.000Z'
    equipmentStorage.addPublishedReference({ equipmentId: EQUIPMENT.equipmentId, equipmentVersion: 2, ...target, sourceSummary: summaryOld, createdAt: T0 } as never)
    equipmentStorage.addPublishedReference({ equipmentId: EQUIPMENT.equipmentId, equipmentVersion: 2, ...target, sourceSummary: 'links[L-OTHER].parameterSource fields=modulation', createdAt: T0 } as never)
    equipmentStorage.addPublishedReference({ equipmentId: EQUIPMENT.equipmentId, equipmentVersion: 1, ...target, sourceSummary: summaryNew, createdAt: T0 } as never)
    const seeded = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)
    expect(seeded).toHaveLength(3)
    const beforeRuns = (await api.get('/api/v1/simulations').set(headers).expect(200)).body.data
    const restore = failRunTargetCommitOnce()
    let failed: { status: number }
    try { failed = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }) } finally { restore() }
    expect(failed!.status).toBe(503)
    // 只撤销本次新增（与旧引用完全一致的那条被去重，不重复登记）；旧 3 条 createdAt 仍 T0
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)).toEqual(seeded)
    expect(equipmentStorage.publishedReferences(EQUIPMENT.equipmentId).every((row: { createdAt: string }) => row.createdAt === T0)).toBe(true)
    expect((await api.get('/api/v1/simulations').set(headers).expect(200)).body.data).toEqual(beforeRuns)
    // 重试成功：集合恰为旧 3 + 新 1，无重复无遗漏
    const retry = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
    expect(retry.status).toBe(201)
    const after = equipmentStorage.publishedReferences(EQUIPMENT.equipmentId)
    expect(after).toHaveLength(4)
    expect(after.filter((row: { createdAt: string }) => row.createdAt === T0)).toHaveLength(3)
    expect(after.filter((row: { sourceSummary: string; equipmentVersion: number }) => row.sourceSummary === summaryNew && row.equipmentVersion === 1)).toHaveLength(1)
    expect(new Set(after.map((row: { equipmentVersion: number; sourceSummary: string }) => `${row.equipmentVersion}|${row.sourceSummary}`)).size).toBe(4)
  })
})










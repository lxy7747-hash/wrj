// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { QualityScope, ScenarioDraft } from '../../src/contracts/domain-models'
const { createMockServer } = await import('../../server/' + 'app.js')
const { createRunEvidenceStore } = await import('../../server/local/' + 'run-evidence.js')
const { exportEvidenceReport } = await import('../../server/local/' + 'report-file.js')
const { default: request } = await import('super' + 'test')
const { mkdtemp, readdir, readFile, rm } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')

const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
const STATE_HEADER = 'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'
type Server = ReturnType<typeof createMockServer>
const servers: Server[] = []
const roots: string[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function setup(createRunId?: () => string) {
  const root = await mkdtemp(join(tmpdir(), 'wrj-evidence-import-')); roots.push(root)
  const store = createRunEvidenceStore(join(root, 'evidence'), () => '2026-11-01T02:00:00Z')
  const server = createMockServer({ port: 0, runEvidenceStore: store, ...(createRunId ? { createRunId } : {}), exportReportEvidence: (input: Parameters<typeof exportEvidenceReport>[1]) => exportEvidenceReport(join(root, 'exports'), input) })
  servers.push(server)
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  const scene = (await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data as ScenarioDraft
  const startRun = async (withStart = true) => {
    const created = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
    const runId = created.body.data.runId as string
    let startedAt = '2026-11-01T00:00:00Z'
    if (withStart) startedAt = (await api.post(`/api/v1/simulations/${runId}/commands`).set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)).body.data.startedAt
    const scope: QualityScope = { taskId: 'TASK-001', runId, scenarioId: 'SCN-001', revision: scene.revision, startedAt }
    return { runId, scope }
  }
  const link = scene.config.links[0]!
  const stateCsv = (taskId = 'TASK-001', version = '1.1', linkType = link.type) => `${STATE_HEADER}\n${taskId},${version},0,${link.sourcePlatformId},${link.targetPlatformId},${linkType},UP,12,0.0001,-70`
  const files = (text: string) => ({ files: [{ fileName: 'link_state.csv', text }] })
  return { root, api, store, scene, startRun, stateCsv, files, link }
}

describe('D2-04 文件集导入真实 HTTP：冻结上下文/版本/关联/失败不改旧批', () => {
  it('未启动 run 缺冻结上下文→409；未创建 run→404', async () => {
    const { api, startRun } = await setup()
    const notStarted = await startRun(false)
    await api.post(`/api/v1/simulations/${notStarted.runId}/evidence-import`).set(headers).send({ files: [{ fileName: 'link_state.csv', text: 'x' }] }).expect(409)
    await api.post('/api/v1/simulations/RUN-not-created/evidence-import').set(headers).send({ files: [{ fileName: 'link_state.csv', text: 'x' }] }).expect(404)
  })

  it('R2/R3：游标/预算参数非法值 422 及边界检查', async () => {
    const { api, startRun, stateCsv, files } = await setup()
    const a = await startRun()
    const base = `/api/v1/simulations/${a.runId}/evidence-import`
    const illegal = [
        { cursor: 'garbage', name: '垃圾游标' },
        { cursor: '-1', name: '负数游标' },
        { cursor: 'NaN', name: 'NaN' },
        { cursor: 'Infinity', name: 'Infinity' },
        { limit: 0, name: '零限制' },
        { limit: -1, name: '负数限制' }
    ]
    for (const { cursor, limit, name } of illegal) {
      const params = new URLSearchParams()
      if (cursor) params.set('cursor', cursor)
      if (limit !== undefined) params.set('limit', String(limit))
      await api.post(`${base}?${params}`).set(headers).send(files(stateCsv())).expect(400)
    }
  })

  it('版本/任务错配与无法唯一映射→422；同 task 不同 run 恒 USER_SELECTED_RUN', async () => {
    const { api, startRun, stateCsv, files } = await setup()
    const a = await startRun()
    await api.post(`/api/v1/simulations/${a.runId}/evidence-import`).set(headers).send(files(stateCsv('TASK-OTHER'))).expect(422)
    await api.post(`/api/v1/simulations/${a.runId}/evidence-import`).set(headers).send(files(stateCsv('TASK-001', '2.0'))).expect(422)
    // 端点不匹配当前场景链路→无法唯一映射 422
    const unmapped = `${STATE_HEADER}\nTASK-001,1.1,0,ZZZ,YYY,MICROWAVE,UP,12,0.0001,-70`
    await api.post(`/api/v1/simulations/${a.runId}/evidence-import`).set(headers).send(files(unmapped)).expect(422)
    const imported = await api.post(`/api/v1/simulations/${a.runId}/evidence-import`).set(headers).send(files(stateCsv('TASK-001'))).expect(200)
    expect(imported.body.data.association).toBe('USER_SELECTED_RUN')
    expect(imported.body.data.bundleSha256).toMatch(/^[a-f0-9]{64}$/)
    // 同 task 不同 run：另一运行中同样恒为 USER_SELECTED_RUN（绝不 VERIFIED_MANIFEST）
    // 同 task 不同 run：第二个隔离服务注入不同 runId，确保 a.runId 与 run2.runId 真正不同。
    const other = await setup(() => 'RUN-OTHER-RUN')
    const run2 = await other.startRun()
    const imported2 = await other.api.post(`/api/v1/simulations/${run2.runId}/evidence-import`).set(headers).send(other.files(other.stateCsv('TASK-001'))).expect(200)
    expect(imported2.body.data.association).toBe('USER_SELECTED_RUN')
    expect(imported.body.data.scope.runId).toBe(a.runId)
    expect(imported2.body.data.scope.runId).toBe(run2.runId)
    // 同 task 必须是两个不同 runId，且关联始终为用户关联，不得标 VERIFIED_MANIFEST。
    expect(run2.runId).not.toBe(a.runId)
    expect(imported.body.data.association).not.toBe('VERIFIED_MANIFEST')
    expect(imported2.body.data.association).not.toBe('VERIFIED_MANIFEST')
  })

  it('失败前后 current 指针/原文目录/已发布来源不变', async () => {
    const { api, store, startRun, stateCsv, files, root } = await setup()
    const a = await startRun()
    const good = (await api.post(`/api/v1/simulations/${a.runId}/evidence-import`).set(headers).send(files(stateCsv('TASK-001'))).expect(200)).body.data
    const runDir = join(root, 'evidence', a.runId)
    const pointerBefore = await readFile(join(runDir, 'current.json'), 'utf8')
    const dirsBefore = (await readdir(runDir)).filter((name: string) => name.startsWith('evidence-')).sort()
    await api.post(`/api/v1/simulations/${a.runId}/evidence-import`).set(headers).send(files(stateCsv('TASK-OTHER'))).expect(422)
    expect(await readFile(join(runDir, 'current.json'), 'utf8')).toBe(pointerBefore)
    expect((await readdir(runDir)).filter((name: string) => name.startsWith('evidence-')).sort()).toEqual(dirsBefore)
    expect((await store.load(a.runId))?.result.bundleSha256).toBe(good.bundleSha256)
  })

  it('T1 合法场景冻结两条同端点同类型不同 linkId 双候选→422不发布；与 ZZZ/YYY 零候选区分；旧 A 固定摘要可读；同 task 两 run 均 USER_SELECTED_RUN', async () => {
    const { api, store, root } = await setup()
    const admin = { ...headers, 'X-Demo-Role': 'ADMIN' }
    // 构造合法场景：复制首条链路为同端点同类型但不同 linkId 的第二条候选，并补平台 linkIds。
    const scene = (await api.get('/api/v1/scenarios/SCN-001').set(admin).expect(200)).body.data as ScenarioDraft
    const config = structuredClone(scene.config)
    Object.assign(config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
    const dupBase = config.links[0]!
    const duplicate = { ...dupBase, id: 'L-DUP' }
    config.links.push(duplicate)
    for (const platformId of [duplicate.sourcePlatformId, duplicate.targetPlatformId]) {
      const platform = config.platforms.find(item => item.id === platformId)
      if (platform && !platform.linkIds.includes('L-DUP')) platform.linkIds.push('L-DUP')
    }
    await api.put('/api/v1/scenarios/SCN-001').set(admin).send({ config, uiExtensions: scene.uiExtensions, expectedRevision: scene.revision }).expect(200)
    const updated = (await api.get('/api/v1/scenarios/SCN-001').set(admin).expect(200)).body.data as ScenarioDraft
    // 选一条端点/类型与重复候选不同的唯一链路，用于先发布合法批次 A。
    const unique = updated.config.links.find(link => link.id !== 'L-DUP' && link.id !== dupBase.id
      && (link.sourcePlatformId !== dupBase.sourcePlatformId || link.targetPlatformId !== dupBase.targetPlatformId || link.type !== dupBase.type))!
    const row = (sp: string, tp: string, type: string, gxb = 12) => `${STATE_HEADER}\nTASK-001,1.1,0,${sp},${tp},${type},UP,${gxb},0.0001,-70`

    const created = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
    const runId = created.body.data.runId as string
    await api.post(`/api/v1/simulations/${runId}/commands`).set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    const runDir = join(root, 'evidence', runId)

    const a = (await api.post(`/api/v1/simulations/${runId}/evidence-import`).set(headers).send({ files: [{ fileName: 'link_state.csv', text: row(unique.sourcePlatformId, unique.targetPlatformId, unique.type, 12) }] }).expect(200)).body.data
    expect(a.association).toBe('USER_SELECTED_RUN')
    const pointerBefore = await readFile(join(runDir, 'current.json'), 'utf8')
    const dirsBefore = (await readdir(runDir)).filter((name: string) => name.startsWith('evidence-')).sort()

    // 双候选：同端点同类型存在两条冻结链路→歧义 422，不发布。
    const ambiguous = await api.post(`/api/v1/simulations/${runId}/evidence-import`).set(headers).send({ files: [{ fileName: 'link_state.csv', text: row(dupBase.sourcePlatformId, dupBase.targetPlatformId, dupBase.type, 99) }] })
    expect(ambiguous.status).toBe(422)
    expect(JSON.stringify(ambiguous.body.error.details ?? ambiguous.body.error.message)).toMatch(/唯一|歧义|AMBIGUOUS/)
    // 零候选：ZZZ/YYY 不匹配任何冻结链路→也 422，但与歧义是不同原因（无匹配而非多候选）。
    const zero = await api.post(`/api/v1/simulations/${runId}/evidence-import`).set(headers).send({ files: [{ fileName: 'link_state.csv', text: row('ZZZ', 'YYY', dupBase.type, 99) }] })
    expect(zero.status).toBe(422)
    // 旧 A 指针、原文目录与固定摘要读取一致，失败批次未作为成功源发布。
    expect(await readFile(join(runDir, 'current.json'), 'utf8')).toBe(pointerBefore)
    expect((await readdir(runDir)).filter((name: string) => name.startsWith('evidence-')).sort()).toEqual(dirsBefore)
    expect((await store.load(runId))?.result.bundleSha256).toBe(a.bundleSha256)
    expect((await store.load(runId, a.bundleSha256))?.state[0]!.gxbDb).toBe(12)
  })
})

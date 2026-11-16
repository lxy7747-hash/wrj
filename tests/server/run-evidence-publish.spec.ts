// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QualityConfig } from '../../src/features/data-exchange/quality-records'
import type { QualityScope, ScenarioDraft } from '../../src/contracts/domain-models'

// 可控等效 IO：包装 fs.promises 的 writeFile/rename，用于在写盘阶段插入真实暂停或一次性失败。
const io = vi.hoisted(() => ({
  hook: null as null | ((op: 'writeFile' | 'rename', path: string, phase: 'before' | 'after') => Promise<void> | void),
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal() as {
    writeFile: (path: unknown, data: unknown, options?: unknown) => Promise<unknown>
    rename: (from: unknown, to: unknown) => Promise<unknown>
  }
  return {
    ...actual,
    writeFile: async (path: unknown, data: unknown, options?: unknown) => {
      await io.hook?.('writeFile', String(path), 'before')
      const result = await actual.writeFile(path, data, options)
      await io.hook?.('writeFile', String(path), 'after')
      return result
    },
    rename: async (from: unknown, to: unknown) => {
      await io.hook?.('rename', String(to), 'before')
      const result = await actual.rename(from, to)
      await io.hook?.('rename', String(to), 'after')
      return result
    },
  }
})

const { createRunEvidenceStore } = await import('../../server/local/' + 'run-evidence.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { AuthSqliteStorage } = await import('../../server/local/' + 'auth-sqlite.js')
const { ScenarioSqliteStorage } = await import('../../server/local/' + 'scenario-sqlite.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { EvidenceImportError } = await import('../../src/features/data-exchange/evidence-contract.js')
const { default: request } = await import('super' + 'test')
const { mkdtemp, readFile, readdir, rm, writeFile } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { DatabaseSync } = await import('node:' + 'sqlite')

const headers = { Origin: 'http://127.0.0.1:5173' }
const PASSWORD = 'Test-only-password-2026!'
const roots: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
beforeEach(() => { io.hook = null })
afterEach(async () => { io.hook = null; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const scope: QualityScope = { taskId: 'TASK-1', runId: 'RUN-1', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' }
const config = { scenario: { id: 'SCN-1', timeStep: 1 }, platforms: [{ id: 'A' }, { id: 'B' }], links: [{ id: 'L-1', type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B', enabled: true }], linkSettings: {} } as unknown as QualityConfig
const STATE_HEADER = 'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'
const stateCsv = (gxb: number) => `${STATE_HEADER}\nTASK-1,1.1,0,A,B,MICROWAVE,UP,${gxb},0.0001,-70`
const pack = (text: string) => ({ files: [{ fileName: 'link_state.csv', text }] })
async function storeDir() { const root = await mkdtemp(join(tmpdir(), 'wrj-evidence-publish-')); roots.push(root); return root }
async function generations(runRoot: string): Promise<string[]> { try { return (await readdir(runRoot)).filter((name: string) => name.startsWith('evidence-')).sort() } catch { return [] } }

/** 在匹配的写盘/改名操作处暂停；release 后继续。 */
function barrier(match: (op: 'writeFile' | 'rename', path: string) => boolean, phase: 'before' | 'after' = 'after') {
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const hit = new Promise<void>(resolve => { reached = resolve })
  io.hook = async (op, path, current) => { if (current === phase && match(op, path)) { reached(); await gate } }
  return { reached: hit, release: () => { io.hook = null; release() } }
}
/** 在匹配操作处一次性抛错，模拟写盘或指针替换阶段失败。 */
function failAt(match: (op: 'writeFile' | 'rename', path: string) => boolean, phase: 'before' | 'after' = 'before') {
  io.hook = (op, path, current) => { if (current === phase && match(op, path)) throw new Error('injected-io-failure') }
}

describe('D2-05 证据发布：写盘后撤权/写盘失败/指针替换失败/并发/上下文失效', () => {
  it('canPublish 在写盘后发布前翻转→拒绝发布、无半批、旧 A 指针与原文保留', async () => {
    const root = await storeDir()
    const store = createRunEvidenceStore(join(root, 'evidence'), () => '2026-11-01T02:00:00Z')
    const first = await store.import(pack(stateCsv(12)), scope, config)
    const runRoot = join(root, 'evidence', 'RUN-1')
    const pointerBefore = await readFile(join(runRoot, 'current.json'), 'utf8')
    const dirsBefore = await generations(runRoot)
    let calls = 0
    await expect(store.import(pack(stateCsv(99)), scope, config, () => (++calls < 2))).rejects.toBeInstanceOf(EvidenceImportError)
    expect((await store.load('RUN-1'))?.result.bundleSha256).toBe(first.bundleSha256)
    expect((await store.load('RUN-1'))?.state[0]!.gxbDb).toBe(12)
    expect(await readFile(join(runRoot, 'current.json'), 'utf8')).toBe(pointerBefore)
    expect(await generations(runRoot)).toEqual(dirsBefore)
  })

  it('已有 A 时部分原文写完后 bundle.json 写失败→无半批、无悬空指针、A 可读且失败批次未发布', async () => {
    const root = await storeDir()
    const store = createRunEvidenceStore(join(root, 'evidence'), () => '2026-11-01T02:00:00Z')
    const first = await store.import(pack(stateCsv(12)), scope, config)
    const runRoot = join(root, 'evidence', 'RUN-1')
    const pointerBefore = await readFile(join(runRoot, 'current.json'), 'utf8')
    const dirsBefore = await generations(runRoot)
    failAt((op, path) => op === 'writeFile' && path.endsWith('bundle.json'))
    await expect(store.import(pack(stateCsv(99)), scope, config)).rejects.toThrow()
    io.hook = null
    expect(await readFile(join(runRoot, 'current.json'), 'utf8')).toBe(pointerBefore)
    expect(await generations(runRoot)).toEqual(dirsBefore)
    expect((await store.load('RUN-1'))?.result.bundleSha256).toBe(first.bundleSha256)
    expect((await store.load('RUN-1'))?.state[0]!.gxbDb).toBe(12)
    // 无遗留 .evidence- 临时目录或 .current- 指针
    const leftovers = (await readdir(runRoot)).filter((name: string) => name.startsWith('.evidence-') || name.startsWith('.current-'))
    expect(leftovers).toEqual([])
  })

  it('current 指针 rename 替换阶段失败→旧指针保留、新批次目录回滚、A 可读', async () => {
    const root = await storeDir()
    const store = createRunEvidenceStore(join(root, 'evidence'), () => '2026-11-01T02:00:00Z')
    const first = await store.import(pack(stateCsv(12)), scope, config)
    const runRoot = join(root, 'evidence', 'RUN-1')
    const pointerBefore = await readFile(join(runRoot, 'current.json'), 'utf8')
    const dirsBefore = await generations(runRoot)
    failAt((op, path) => op === 'rename' && path.endsWith('current.json'))
    await expect(store.import(pack(stateCsv(99)), scope, config)).rejects.toThrow()
    io.hook = null
    expect(await readFile(join(runRoot, 'current.json'), 'utf8')).toBe(pointerBefore)
    expect(await generations(runRoot)).toEqual(dirsBefore)
    expect((await store.load('RUN-1'))?.result.bundleSha256).toBe(first.bundleSha256)
    expect((await store.load('RUN-1'))?.state[0]!.gxbDb).toBe(12)
    const leftovers = (await readdir(runRoot)).filter((name: string) => name.startsWith('.current-'))
    expect(leftovers).toEqual([])
  })

  it('两个合法并发导入依次成功、两固定摘要均可读且不混合', async () => {
    const root = await storeDir()
    const store = createRunEvidenceStore(join(root, 'evidence'), () => '2026-11-01T02:00:00Z')
    const [a, b] = await Promise.all([store.import(pack(stateCsv(21)), scope, config), store.import(pack(stateCsv(22)), scope, config)])
    expect(a.bundleSha256).not.toBe(b.bundleSha256)
    expect((await store.load('RUN-1', a.bundleSha256))?.state[0]!.gxbDb).toBe(21)
    expect((await store.load('RUN-1', b.bundleSha256))?.state[0]!.gxbDb).toBe(22)
    // 当前指针指向后完成的一个完整批次，不混合。
    const latest = await store.load('RUN-1')
    expect([a.bundleSha256, b.bundleSha256]).toContain(latest?.result.bundleSha256)
    expect([21, 22]).toContain(latest?.state[0]!.gxbDb)
  })

  async function authServer(root: string) {
    const authDirectory = await mkdtemp(join(tmpdir(), 'wrj-evidence-auth-')); roots.push(authDirectory)
    const storage = new AuthSqliteStorage(join(authDirectory, 'app.db'), PASSWORD)
    cleanups.push(() => storage.close())
    const store = createRunEvidenceStore(join(root, 'evidence'), () => '2026-11-01T02:00:00Z')
    const server = createMockServer({ port: 0, authStorage: storage, runEvidenceStore: store })
    cleanups.push(() => server.close())
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    const login = await api.post('/api/v1/auth/login').set(headers).send({ username: 'admin', passwordFixture: PASSWORD }).expect(200)
    const cookie = login.headers['set-cookie'][0].split(';')[0] as string
    const asUser = { ...headers, Cookie: cookie, 'X-Demo-Role': 'ADMIN' }
    const scene = (await api.get('/api/v1/scenarios/SCN-001').set(asUser).expect(200)).body.data as ScenarioDraft
    return { api, storage, store, asUser, scene }
  }

  it('真实 Cookie：入口认证后进入写盘并用 barrier 暂停，此时撤销会话→放行后复检拒绝、旧 A 指针与原文保留；随后新请求 401', async () => {
    const root = await storeDir()
    const { api, storage, store, asUser, scene } = await authServer(root)
    const created = await api.post('/api/v1/simulations').set(asUser).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
    const runId = created.body.data.runId as string
    const startedAt = (await api.post(`/api/v1/simulations/${runId}/commands`).set(asUser).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)).body.data.startedAt
    const link = scene.config.links[0]!
    const csv = (gxb: number) => `${STATE_HEADER}\nTASK-001,1.1,0,${link.sourcePlatformId},${link.targetPlatformId},${link.type},UP,${gxb},0.0001,-70`
    const first = await api.post(`/api/v1/simulations/${runId}/evidence-import`).set(asUser).send({ files: [{ fileName: 'link_state.csv', text: csv(12) }] }).expect(200)
    const runRoot = join(root, 'evidence', runId)
    const pointerBefore = await readFile(join(runRoot, 'current.json'), 'utf8')
    const dirsBefore = await generations(runRoot)

    const gate = barrier((op, path) => op === 'writeFile' && path.endsWith('bundle.json'), 'after')
    const pending = (async () => await api.post(`/api/v1/simulations/${runId}/evidence-import`).set(asUser).send({ files: [{ fileName: 'link_state.csv', text: csv(99) }] }))()
    await gate.reached
    storage.revokeAllSessions()
    gate.release()
    const blocked = await pending
    expect(blocked.status).toBe(409)
    expect(await readFile(join(runRoot, 'current.json'), 'utf8')).toBe(pointerBefore)
    expect(await generations(runRoot)).toEqual(dirsBefore)
    const scopeReal: QualityScope = { taskId: 'TASK-001', runId, scenarioId: 'SCN-001', revision: scene.revision, startedAt }
    expect((await store.load(scopeReal.runId))?.result.bundleSha256).toBe(first.body.data.bundleSha256)
    expect((await store.load(scopeReal.runId))?.state[0]!.gxbDb).toBe(12)
    // 请求前 401 仅作补充：会话已撤销后的新请求在入口即被拒。
    await api.post(`/api/v1/simulations/${runId}/evidence-import`).set(asUser).send({ files: [{ fileName: 'link_state.csv', text: csv(12) }] }).expect(401)
  })

  it('服务端冻结 context 失效（写入 barrier 期间场景修订变化）→复检拒绝，旧 A 保留', async () => {
    const root = await storeDir()
    const scenePath = join(root, 'scenarios.db')
    const scenarioStorage = new ScenarioSqliteStorage(scenePath)
    cleanups.push(() => scenarioStorage.close())
    const store = createRunEvidenceStore(join(root, 'evidence'), () => '2026-11-01T02:00:00Z')
    const server = createMockServer({ port: 0, scenarioStorage, runEvidenceStore: store })
    cleanups.push(() => server.close())
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    const admin = { ...headers, 'X-Demo-Role': 'ADMIN' }
    const base = new ScenarioProjection().get('SCN-001').data
    Object.assign(base.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
    await api.post('/api/v1/scenarios').set(admin).send({ config: base.config, uiExtensions: base.uiExtensions, expectedRevision: 0 }).expect(201)
    const scene = (await api.get('/api/v1/scenarios/SCN-001').set(admin).expect(200)).body.data as ScenarioDraft
    const created = await api.post('/api/v1/simulations').set(admin).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
    const runId = created.body.data.runId as string
    const startedAt = (await api.post(`/api/v1/simulations/${runId}/commands`).set(admin).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)).body.data.startedAt
    const link = scene.config.links[0]!
    const csv = (gxb: number) => `${STATE_HEADER}\nTASK-001,1.1,0,${link.sourcePlatformId},${link.targetPlatformId},${link.type},UP,${gxb},0.0001,-70`
    const first = await api.post(`/api/v1/simulations/${runId}/evidence-import`).set(admin).send({ files: [{ fileName: 'link_state.csv', text: csv(12) }] }).expect(200)
    const runRoot = join(root, 'evidence', runId)
    const pointerBefore = await readFile(join(runRoot, 'current.json'), 'utf8')
    const dirsBefore = await generations(runRoot)

    const gate = barrier((op, path) => op === 'writeFile' && path.endsWith('bundle.json'), 'after')
    const pending = (async () => await api.post(`/api/v1/simulations/${runId}/evidence-import`).set(admin).send({ files: [{ fileName: 'link_state.csv', text: csv(99) }] }))()
    await gate.reached
    // 期间修改保存场景修订号，使冻结 qualityContext 与当前不一致。
    const db = new DatabaseSync(scenePath)
    try { db.prepare("UPDATE scenarios SET revision = revision + 1 WHERE id = 'SCN-001'").run() } finally { db.close() }
    gate.release()
    const blocked = await pending
    expect(blocked.status).toBe(409)
    expect(await readFile(join(runRoot, 'current.json'), 'utf8')).toBe(pointerBefore)
    expect(await generations(runRoot)).toEqual(dirsBefore)
    const scopeReal: QualityScope = { taskId: 'TASK-001', runId, scenarioId: 'SCN-001', revision: scene.revision, startedAt }
    expect((await store.load(scopeReal.runId))?.result.bundleSha256).toBe(first.body.data.bundleSha256)
    expect((await store.load(scopeReal.runId))?.state[0]!.gxbDb).toBe(12)
  })
})

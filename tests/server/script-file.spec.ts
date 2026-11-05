// @vitest-environment node
import { expect, it, vi } from 'vitest'
const { createMockServer } = await import('../../server/' + 'app.js')
const { writeScriptText, writeMissionPackage } = await import('../../server/local/' + 'script-file.js')
const { resolveMissionOutputDirectory } = await import('../../server/local/' + 'mission-runner.js')
import { createTemplateScenario } from '../fixtures/template-scenario'
const { default: request } = await import('super' + 'test')
const { mkdtemp, readFile, writeFile, rm, readdir } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join, dirname, resolve } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }

it('保存场景 → Node 生成 → 写入真实 UTF-8 TXT；拒绝路径注入/旧修订/锁定/未授权，重复生成不覆盖旧文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-script-test-'))
  const writer = vi.fn((script, revision, draft) => writeScriptText(directory, script, revision, draft))
  const server = createMockServer({ writeScriptText: writer })
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    const draft = (await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data
    Object.assign(draft.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
    draft.config.scenario.name = '落盘测试场景'
    for (const platform of draft.config.platforms) if (platform.type === 'COMMUNICATION_SATELLITE') platform.satelliteType = 'TIANTONG'
    // 激光链路不写入新模板脚本，会产生需要确认的警告；本用例直接生成脚本，去掉激光链路。
    draft.config.links = draft.config.links.filter((link: { type: string }) => link.type !== 'LASER')
    for (const platform of draft.config.platforms) platform.linkIds = platform.linkIds.filter((id: string) => draft.config.links.some((link: { id: string }) => link.id === id))
    const saved = (await api.put('/api/v1/scenarios/SCN-001').set(headers)
      .send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: draft.revision }).expect(200)).body.data
    const script = (await api.post('/api/v1/scripts/preview').set(headers).send({ scenarioId: 'SCN-001' }).expect(200)).body.data
    const endpoint = `/api/v1/scripts/${script.scriptId}/local-file`
    await api.post(endpoint).set({ Origin: headers.Origin }).send({ checksum: script.checksum }).expect(403)
    await api.post(endpoint).set(headers).send({ checksum: script.checksum, path: '../outside.txt' }).expect(400)
    await api.post(endpoint).set(headers).send({ checksum: 'WRONG' }).expect(409)
    await api.post('/api/v1/scripts/MISSING/local-file').set(headers).send({ checksum: script.checksum }).expect(409)
    expect(writer).not.toHaveBeenCalled()
    const file = (await api.post(endpoint).set(headers).send({ checksum: script.checksum }).expect(200)).body.data
    const contents = await readFile(file.path, 'utf8')
    expect(file).toMatchObject({ scriptId: script.scriptId, configVersion: `SCN-001-v${saved.revision}` })
    expect(file.path.startsWith(directory)).toBe(true)
    expect(file.path.endsWith('comm_SimSetup.txt')).toBe(true)
    expect(contents).toContain('include_once comm_platform_INS.txt')
    const packageRoot = dirname(file.path)
    const metadata = join(packageRoot, 'metadata')
    const templateFiles = (await readdir(new URL('../fixtures/afsim-template-20261101/', import.meta.url))).filter((name: string) => name.endsWith('.txt')).sort()
    const packageEntries: { name: string; isFile(): boolean; isDirectory(): boolean }[] = await readdir(packageRoot, { withFileTypes: true })
    expect(packageEntries.filter(item => item.isFile()).map(item => item.name).sort()).toEqual(templateFiles)
    expect(packageEntries.filter(item => item.isDirectory()).map(item => item.name).sort()).toEqual(['metadata', 'output'])
    expect((await readdir(metadata)).sort()).toEqual(['README.txt', `SCN-001-r${saved.revision}.txt`, 'input.json', 'mapping.json', 'scenario.txt'].sort())
    const preview = await readFile(join(metadata, 'scenario.txt'), 'utf8')
    expect(preview).toContain('落盘测试场景')
    expect(preview).toContain('include_once ../comm_SimSetup.txt')
    expect(resolve(metadata, '../comm_SimSetup.txt')).toBe(file.path)
    expect(await readFile(join(metadata, `SCN-001-r${saved.revision}.txt`), 'utf8')).toContain(script.preview)
    expect(JSON.parse(await readFile(join(metadata, 'input.json'), 'utf8'))).toEqual(saved)
    const mapping = JSON.parse(await readFile(join(metadata, 'mapping.json'), 'utf8'))
    expect(mapping.entry).toBe('comm_SimSetup.txt')
    expect(mapping.scriptFiles.sort()).toEqual(templateFiles)
    for (const name of templateFiles) {
      const content = await readFile(join(packageRoot, name), 'utf8')
      for (const match of content.matchAll(/^\s*include_once\s+(\S+)/gmu)) {
        expect(templateFiles).toContain(match[1])
        expect(await readFile(join(packageRoot, match[1]!), 'utf8')).not.toBe('')
      }
    }
    const second = (await api.post(endpoint).set(headers).send({ checksum: script.checksum }).expect(200)).body.data
    expect(second.path).not.toBe(file.path)
    expect(await readFile(file.path, 'utf8')).toBe(contents)
    expect(await readFile(join(metadata, 'scenario.txt'), 'utf8')).toBe(preview)
    await api.put('/api/v1/scenarios/SCN-001').set(headers)
      .send({ config: saved.config, uiExtensions: saved.uiExtensions, expectedRevision: saved.revision }).expect(200)
    await api.post(endpoint).set(headers).send({ checksum: script.checksum }).expect(409)
    const latest = (await api.post('/api/v1/scripts/preview').set(headers).send({ scenarioId: 'SCN-001' }).expect(200)).body.data
    await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
    await api.post(`/api/v1/scripts/${latest.scriptId}/local-file`).set(headers).send({ checksum: latest.checksum }).expect(409)
    expect(writer).toHaveBeenCalledTimes(2)
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('运行包仍可按原有映射定位输出目录，保存包分目录不影响执行读取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-script-runtime-'))
  try {
    const draft = createTemplateScenario()
    const entry = await writeMissionPackage(directory, draft)
    const packageRoot = dirname(entry)
    expect(entry.endsWith('comm_SimSetup.txt')).toBe(true)
    expect(JSON.parse(await readFile(join(packageRoot, 'input.json'), 'utf8'))).toEqual(draft)
    expect((await readdir(packageRoot))).not.toContain('metadata')
    expect(await resolveMissionOutputDirectory(entry)).toBe(join(packageRoot, 'output'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('仅提供预览时保留单 TXT 写入兼容', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-script-preview-'))
  try {
    const entry = await writeScriptText(directory, { scenarioId: 'SCN-PREVIEW', preview: 'preview only' }, 1)
    expect(entry.endsWith('SCN-PREVIEW-r1.txt')).toBe(true)
    expect(await readdir(dirname(entry))).toEqual(['SCN-PREVIEW-r1.txt'])
    expect(await readFile(entry, 'utf8')).toContain('preview only')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it.each([false, true])('未启用本机写入或磁盘失败不返回伪造路径（启用=%s）', async enabled => {
  const server = createMockServer(enabled ? { writeScriptText: async () => { throw new Error('disk failure') } } : {})
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    const draft = (await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data
    Object.assign(draft.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
    for (const platform of draft.config.platforms) if (platform.type === 'COMMUNICATION_SATELLITE') platform.satelliteType = 'TIANTONG'
    // 激光链路不写入新模板脚本，会产生需要确认的警告；本用例直接生成脚本，去掉激光链路。
    draft.config.links = draft.config.links.filter((link: { type: string }) => link.type !== 'LASER')
    for (const platform of draft.config.platforms) platform.linkIds = platform.linkIds.filter((id: string) => draft.config.links.some((link: { id: string }) => link.id === id))
    await api.put('/api/v1/scenarios/SCN-001').set(headers)
      .send({ config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: draft.revision }).expect(200)
    const script = (await api.post('/api/v1/scripts/preview').set(headers).send({ scenarioId: 'SCN-001' }).expect(200)).body.data
    const failed = await api.post(`/api/v1/scripts/${script.scriptId}/local-file`).set(headers).send({ checksum: script.checksum }).expect(503)
    expect(failed.body.ok).toBe(false)
    expect(failed.body.data).toBeUndefined()
  } finally { await server.close() }
})

it('独占目录内写入失败补偿，不删除其他文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-script-cleanup-'))
  try {
    await writeFile(join(directory, 'keep.txt'), '保留')
    await expect(writeScriptText(directory, { scenarioId: 'x'.repeat(300), preview: 'test' }, 1)).rejects.toThrow()
    expect(await readdir(directory)).toEqual(['keep.txt'])
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('保留')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

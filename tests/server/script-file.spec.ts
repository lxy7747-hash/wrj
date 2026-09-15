// @vitest-environment node
import { expect, it, vi } from 'vitest'
const { createMockServer } = await import('../../server/' + 'app.js')
const { writeScriptText } = await import('../../server/local/' + 'script-file.js')
const { default: request } = await import('super' + 'test')
const { mkdtemp, readFile, writeFile, rm, readdir } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }

it('保存场景 → Node 生成 → 写入真实 UTF-8 TXT；拒绝路径注入/旧修订/锁定/未授权，重复生成不覆盖旧文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-script-test-'))
  const writer = vi.fn((script, revision) => writeScriptText(directory, script, revision))
  const server = createMockServer({ writeScriptText: writer })
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    const draft = (await api.get('/api/v1/scenarios/SCN-001').set(headers).expect(200)).body.data
    draft.config.scenario.name = '落盘测试场景'
    draft.config.scenario.environment.rainLossDbPerKm = 0.08
    for (const platform of draft.config.platforms) if (platform.type === 'COMMUNICATION_SATELLITE') platform.satelliteType = 'TIANTONG'
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
    expect(file.path.endsWith(`SCN-001-r${saved.revision}.txt`)).toBe(true)
    expect(contents).toContain('落盘测试场景')
    expect(contents).toContain(script.preview)
    expect(contents).toContain('未经真实 AFSIM 运行验证')
    const second = (await api.post(endpoint).set(headers).send({ checksum: script.checksum }).expect(200)).body.data
    expect(second.path).not.toBe(file.path)
    expect(await readFile(file.path, 'utf8')).toBe(contents)
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

it.each([false, true])('未启用本机写入或磁盘失败不返回伪造路径（启用=%s）', async enabled => {
  const server = createMockServer(enabled ? { writeScriptText: async () => { throw new Error('disk failure') } } : {})
  try {
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
    const draft = (await api.get('/api/v1/scenarios/SCN-001').set(headers)).body.data
    draft.config.scenario.environment.rainLossDbPerKm = 0.08
    for (const platform of draft.config.platforms) if (platform.type === 'COMMUNICATION_SATELLITE') platform.satelliteType = 'TIANTONG'
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

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
const { mkdtemp, rm, writeFile, mkdir } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join, resolve } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { createServer } = await import('node:' + 'net')
const { default: request } = await import('super' + 'test')
const { WebSocket } = await import('w' + 's')
const { default: nodeProcess } = await import('node:' + 'process')
// 与现有 server 测试一致：通过动态路径避免前端 composite 编译重复纳入服务端与启动器源码。
const { createMockServer } = await import('../../server/' + 'app.js')
const { AuthSqliteStorage } = await import('../../server/local/' + 'auth-sqlite.js')
const { assertLoopbackRequest, readDeploymentAccess } = await import('../../server/http/' + 'loopback.js')
const deployment = await import('../../scripts/' + 'deployment-config.mjs')
const launcher = await import('../../scripts/' + 'start-deployment.mjs')
const { resolveOutputRoot, resolveScriptOutputRoot } = await import('../../server/local/' + 'output-root.js')
const { readEngineConfig } = await import('../../server/local/' + 'engine-config.js')

const password = 'Deploy-test-password-2026!'
const lanHost = '192.168.50.10'
let root: string
const cleanup: Array<() => void | Promise<void>> = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wrj-deploy-test-'))
  // 点击“开始”始终运行本机 mission：所有合法部署配置都要求包内存在 afsim/Release/mission.exe。
  await mkdir(join(root, 'afsim', 'Release'), { recursive: true })
  await writeFile(join(root, 'afsim', 'Release', 'mission.exe'), '')
})
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  await rm(root, { recursive: true, force: true })
})

const valid = 'LISTEN_HOST=0.0.0.0\nDEPLOY_HOST=192.168.50.10\nUI_PORT=5173\nAPI_PORT=4173\nMAP_PORT=4174\n'

describe('deployment.env 解析与校验', () => {
  it('缺少配置文件时保持原有仅本机模式', async () => {
    const config = await deployment.readDeploymentConfig(root, [])
    expect(config).toEqual({
      configured: false, lan: false, listenHost: '127.0.0.1', deployHost: '127.0.0.1', uiPort: 5173, apiPort: 4173, mapPort: 4174,
    })
    expect(readEngineConfig(deployment.apiAccessEnv(config)).realUrl).toBe('ws://127.0.0.1:8080/ws/v1')
  })

  it.each(['192.168.50.10', '192.168.50.20'])('LinkCalc 连接跟随 DEPLOY_HOST=%s，覆盖遗留开发地址而不使用监听地址', async host => {
    await writeFile(join(root, 'deployment.env'), valid.replace(lanHost, host))
    const config = await deployment.readDeploymentConfig(root, [host])
    const env = { realUrl: 'ws://192.168.1.48:8080/ws/v1', ...deployment.apiAccessEnv(config) }
    expect(readEngineConfig(env).realUrl).toBe(`ws://${host}:8080/ws/v1`)
    expect(config.listenHost).toBe('0.0.0.0')
  })

  it('合法局域网配置：相对启动器目录读取，允许 BOM、CRLF 与注释', async () => {
    await writeFile(join(root, 'deployment.env'), `﻿# 注释\r\n${valid.replace(/\n/g, '\r\n')}`)
    expect(await deployment.readDeploymentConfig(root, ['127.0.0.1', lanHost])).toEqual({
      configured: true, lan: true, listenHost: '0.0.0.0', deployHost: lanHost, uiPort: 5173, apiPort: 4173, mapPort: 4174,
    })
    expect(deployment.runtimeConfigBody({ apiPort: 4173, mapPort: 4174, deployHost: lanHost })).toBe('{"apiPort":4173,"mapPort":4174}')
  })

  it.each([
    ['非法 IP', valid.replace('192.168.50.10', '192.168.50.300'), '不是有效的 IPv4'],
    ['DEPLOY_HOST 为 0.0.0.0', valid.replace('DEPLOY_HOST=192.168.50.10', 'DEPLOY_HOST=0.0.0.0'), '不能填写 0.0.0.0'],
    ['域名', valid.replace('192.168.50.10', 'wrj.local'), '不是有效的 IPv4'],
    ['IPv6', valid.replace('LISTEN_HOST=0.0.0.0', 'LISTEN_HOST=::'), '监听地址'],
    ['端口越界', valid.replace('UI_PORT=5173', 'UI_PORT=65536'), '1–65535'],
    ['端口为 0', valid.replace('MAP_PORT=4174', 'MAP_PORT=0'), '1–65535'],
    ['端口非整数', valid.replace('API_PORT=4173', 'API_PORT=41.5'), '1–65535'],
    ['端口重复', valid.replace('MAP_PORT=4174', 'MAP_PORT=4173'), '互不相同'],
    ['缺少配置项', valid.replace('MAP_PORT=4174\n', ''), '缺少配置项'],
    ['重复配置项', `${valid}UI_PORT=5174\n`, '重复'],
    ['未知配置项', `${valid}VITE_HOST=1.2.3.4\n`, '不支持的配置项'],
    ['格式错误', `${valid}abc\n`, '格式错误'],
    ['局域网监听却填回环地址', valid.replace('192.168.50.10', '127.0.0.1'), '真实 IPv4'],
    ['监听地址与部署地址不一致', valid.replace('LISTEN_HOST=0.0.0.0', 'LISTEN_HOST=192.168.50.11'), 'LISTEN_HOST 必须'],
    ['不是本机网卡地址', valid.replace('192.168.50.10', '192.168.50.99'), '不是本机当前的 IPv4'],
  ])('文件存在但%s时明确报错，不回退', async (_label, text, message) => {
    await writeFile(join(root, 'deployment.env'), text)
    await expect(deployment.readDeploymentConfig(root, ['127.0.0.1', lanHost])).rejects.toThrow(message)
    await expect(deployment.readDeploymentConfig(root, ['127.0.0.1', lanHost])).rejects.toThrow('deployment.env 配置错误')
  })

  it('仅本机配置可使用其他回环地址，传给接口服务的变量与服务端校验一致', async () => {
    await writeFile(join(root, 'deployment.env'), 'LISTEN_HOST=127.0.0.2\nDEPLOY_HOST=127.0.0.2\nUI_PORT=6173\nAPI_PORT=6174\nMAP_PORT=6175\n')
    const config = await deployment.readDeploymentConfig(root, [])
    expect(config).toMatchObject({ configured: true, lan: false, deployHost: '127.0.0.2' })
    const env = deployment.apiAccessEnv(config)
    expect(readDeploymentAccess(env, Number(env.MOCK_PORT))).toEqual({ deployHost: '127.0.0.2', listenHost: '127.0.0.2', uiPort: 6173, apiPort: 6174 })
  })

  it('服务端拒绝不完整或非法的来源配置，未配置时保持 undefined', () => {
    expect(readDeploymentAccess({}, 4173)).toBeUndefined()
    expect(() => readDeploymentAccess({ WRJ_DEPLOY_HOST: lanHost }, 4173)).toThrow('部署配置不完整')
    const base = { WRJ_DEPLOY_HOST: lanHost, WRJ_LISTEN_HOST: '0.0.0.0', WRJ_UI_PORT: '5173' }
    expect(() => readDeploymentAccess({ ...base, WRJ_DEPLOY_HOST: '0.0.0.0' }, 4173)).toThrow('不能为 0.0.0.0')
    expect(() => readDeploymentAccess({ ...base, WRJ_LISTEN_HOST: '10.0.0.1' }, 4173)).toThrow('WRJ_LISTEN_HOST')
    expect(() => readDeploymentAccess({ ...base, WRJ_UI_PORT: '70000' }, 4173)).toThrow('WRJ_UI_PORT')
    expect(() => readDeploymentAccess(base, 5173)).toThrow('不能相同')
  })

  it('端口被占用时报告原因，不终止占用进程', async () => {
    const holder = createServer()
    holder.listen(0, '127.0.0.1')
    await once(holder, 'listening')
    cleanup.push(() => new Promise<void>(resolve => holder.close(() => resolve())))
    const address = holder.address()
    if (!address || typeof address === 'string') throw new Error('Missing listener')
    await expect(launcher.assertPortFree('127.0.0.1', address.port, '接口')).rejects.toThrow('启动器不会终止其他进程')
    expect(holder.listening).toBe(true)
  })

  it('启动前校验失败时退出且不启动任何服务', async () => {
    await writeFile(join(root, 'deployment.env'), valid.replace('UI_PORT=5173', 'UI_PORT=abc'))
    const errors: string[] = []
    const previousExitCode = nodeProcess.exitCode
    const result = await launcher.startDeployment(root, { log: () => {}, error: (message: string) => errors.push(message) })
    nodeProcess.exitCode = previousExitCode
    expect(result.config).toBeUndefined()
    expect(errors.join('\n')).toContain('UI_PORT=abc')
  })
})

describe('可选运行路径与任务模式', () => {
  it('合法可选路径生效并按绝对路径解析', async () => {
    const dataDir = join(root, 'custom-data')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'scenarios.db'), '')
    const outputRoot = join(root, 'custom-output')
    const scriptOutputRoot = join(root, 'custom-scripts')
    const missionExe = join(root, 'mission.exe')
    await writeFile(missionExe, '')
    await writeFile(join(root, 'deployment.env'), `${valid}OUTPUT_ROOT=${outputRoot}\nSCRIPT_OUTPUT_ROOT=${scriptOutputRoot}\nDATA_DIR=${dataDir}\nMISSION_EXE_PATH=${missionExe}\n`)
    const config = await deployment.readDeploymentConfig(root, ['127.0.0.1', lanHost])
    expect(config).toMatchObject({ outputRoot: resolve(outputRoot), scriptOutputRoot: resolve(scriptOutputRoot), dataDir: resolve(dataDir), missionExe: resolve(missionExe) })
  })

  it('可选值为空时使用包内默认目录', async () => {
    await writeFile(join(root, 'deployment.env'), `${valid}OUTPUT_ROOT=\nSCRIPT_OUTPUT_ROOT=\nDATA_DIR=\nMISSION_EXE_PATH=\n`)
    const config = await deployment.readDeploymentConfig(root, ['127.0.0.1', lanHost])
    expect(config).toMatchObject({ outputRoot: undefined, scriptOutputRoot: undefined, dataDir: undefined, missionExe: undefined })
  })

  it.each([
    ['相对 OUTPUT_ROOT', 'OUTPUT_ROOT=output\n', '必须为绝对路径'],
    ['相对 SCRIPT_OUTPUT_ROOT', 'SCRIPT_OUTPUT_ROOT=scripts\n', '必须为绝对路径'],
    ['相对 MISSION_EXE_PATH', 'MISSION_EXE_PATH=mission.exe\n', '必须为绝对路径'],
  ])('%s 被拒绝', async (_label, extra, message) => {
    await writeFile(join(root, 'deployment.env'), `${valid}${extra}`)
    await expect(deployment.readDeploymentConfig(root, ['127.0.0.1', lanHost])).rejects.toThrow(message)
  })

  it('脚本输出目录指向已有文件时拒绝启动', async () => {
    const scriptOutputRoot = join(root, 'not-a-directory.txt')
    await writeFile(scriptOutputRoot, '')
    await writeFile(join(root, 'deployment.env'), `${valid}SCRIPT_OUTPUT_ROOT=${scriptOutputRoot}\n`)
    await expect(deployment.readDeploymentConfig(root, ['127.0.0.1', lanHost])).rejects.toThrow('不是目录')
  })

  it('DATA_DIR 缺少 scenarios.db、mission 程序不存在或包内 mission 缺失时拒绝启动', async () => {
    const dataDir = join(root, 'empty-data')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(root, 'deployment.env'), `${valid}DATA_DIR=${dataDir}\n`)
    await expect(deployment.readDeploymentConfig(root, ['127.0.0.1', lanHost])).rejects.toThrow('缺少 scenarios.db')
    await writeFile(join(root, 'deployment.env'), `${valid}MISSION_EXE_PATH=${join(root, 'missing.exe')}\n`)
    await expect(deployment.readDeploymentConfig(root, ['127.0.0.1', lanHost])).rejects.toThrow('不存在或不是文件')
    await rm(join(root, 'afsim', 'Release', 'mission.exe'))
    await writeFile(join(root, 'deployment.env'), valid)
    await expect(deployment.readDeploymentConfig(root, ['127.0.0.1', lanHost])).rejects.toThrow('afsim/Release/mission.exe')
  })

  it('MISSION_OUTPUT_DIR 接受运行包内相对子目录并归一化，空值使用场景默认', async () => {
    for (const [raw, expected] of [['output', 'output'], ['out/events', 'out/events'], ['out\\events', 'out/events']] as const) {
      await writeFile(join(root, 'deployment.env'), `${valid}MISSION_OUTPUT_DIR=${raw}\n`)
      const config = await deployment.readDeploymentConfig(root, ['127.0.0.1', lanHost])
      expect(config.missionOutputDir).toBe(expected)
    }
    await writeFile(join(root, 'deployment.env'), `${valid}MISSION_OUTPUT_DIR=\n`)
    expect((await deployment.readDeploymentConfig(root, ['127.0.0.1', lanHost])).missionOutputDir).toBeUndefined()
  })

  it.each([
    ['绝对路径', 'C:\\out'],
    ['盘符相对', 'C:out'],
    ['根路径', '/out'],
    ['反斜杠根路径', '\\out'],
    ['上级目录', '..\\escape'],
    ['中间上级目录', 'a/../b'],
    ['空段', 'a//b'],
    ['末尾分隔符', 'out/'],
    ['点段', 'a/./b'],
  ])('MISSION_OUTPUT_DIR 为%s时拒绝', async (_label, value) => {
    await writeFile(join(root, 'deployment.env'), `${valid}MISSION_OUTPUT_DIR=${value}\n`)
    await expect(deployment.readDeploymentConfig(root, ['127.0.0.1', lanHost])).rejects.toThrow('MISSION_OUTPUT_DIR')
  })

  it('输出根目录与脚本目录解析，非法值不回退', () => {
    expect(resolveOutputRoot(undefined, join(root, 'fallback'))).toBe(resolve(join(root, 'fallback')))
    expect(resolveOutputRoot(join(root, 'custom'), join(root, 'fallback'))).toBe(resolve(join(root, 'custom')))
    expect(() => resolveOutputRoot('relative/output', join(root, 'fallback'))).toThrow('绝对路径')
    expect(resolveScriptOutputRoot(undefined, join(root, 'scripts'))).toBe(resolve(join(root, 'scripts')))
    expect(resolveScriptOutputRoot(join(root, 'custom-scripts'), join(root, 'scripts'))).toBe(resolve(join(root, 'custom-scripts')))
    expect(() => resolveScriptOutputRoot('relative/scripts', join(root, 'scripts'))).toThrow('WRJ_SCRIPT_OUTPUT_ROOT 必须为绝对路径')
  })
})

describe('分端口部署的来源边界', () => {
  const access = { deployHost: lanHost, listenHost: '0.0.0.0', uiPort: 5173, apiPort: 4173 }
  const lanOrigin = `http://${lanHost}:5173`
  const lanApiHost = `${lanHost}:4173`
  const requestLike = (host: string | undefined, origin: string | undefined, remoteAddress: string) => ({ headers: { host, origin }, socket: { remoteAddress } })

  it('局域网来源与 Host 必须同时精确匹配；未知来源、错误 Host、缺少 Origin 一律拒绝', () => {
    expect(assertLoopbackRequest(requestLike(lanApiHost, lanOrigin, '192.168.50.21'), access)).toMatchObject({ allowed: true, origin: lanOrigin })
    expect(assertLoopbackRequest(requestLike(lanApiHost, lanOrigin, '::ffff:192.168.50.21'), access)).toMatchObject({ allowed: true, peerAddress: '192.168.50.21' })
    for (const [host, origin] of [
      [lanApiHost, 'http://192.168.50.11:5173'],
      [lanApiHost, `http://${lanHost}:5174`],
      [lanApiHost, `https://${lanHost}:5173`],
      [lanApiHost, 'null'],
      [lanApiHost, undefined],
      ['192.168.50.11:4173', lanOrigin],
      [`${lanHost}:4174`, lanOrigin],
      [undefined, lanOrigin],
    ] as const) {
      expect(assertLoopbackRequest(requestLike(host, origin, '192.168.50.21'), access)).toMatchObject({ allowed: false, code: 'LOOPBACK_ONLY' })
    }
  })

  it('保留本机来源，但本机来源仍要求回环对端和规范回环 Host', () => {
    expect(assertLoopbackRequest(requestLike('127.0.0.1:4173', 'http://127.0.0.1:5173', '127.0.0.1'), access)).toMatchObject({ allowed: true })
    expect(assertLoopbackRequest(requestLike('127.0.0.1:4173', 'http://127.0.0.1:5173', '192.168.50.21'), access).allowed).toBe(false)
    expect(assertLoopbackRequest(requestLike(lanApiHost, 'http://127.0.0.1:5173', '127.0.0.1'), access).allowed).toBe(false)
    // 页面端口变化后，旧的 5173 本机来源不再放行。
    const moved = { ...access, uiPort: 6000 }
    expect(assertLoopbackRequest(requestLike('127.0.0.1:4173', 'http://127.0.0.1:5173', '127.0.0.1'), moved).allowed).toBe(false)
    expect(assertLoopbackRequest(requestLike('127.0.0.1:4173', 'http://127.0.0.1:6000', '127.0.0.1'), moved).allowed).toBe(true)
  })

  it('回环部署地址只允许回环对端；未配置时保持原有 127.0.0.1:5173 边界', () => {
    const local = { deployHost: '127.0.0.2', listenHost: '127.0.0.2', uiPort: 5173, apiPort: 4173 }
    expect(assertLoopbackRequest(requestLike('127.0.0.2:4173', 'http://127.0.0.2:5173', '127.0.0.1'), local).allowed).toBe(true)
    expect(assertLoopbackRequest(requestLike('127.0.0.2:4173', 'http://127.0.0.2:5173', '192.168.50.21'), local).allowed).toBe(false)
    expect(assertLoopbackRequest(requestLike(lanApiHost, lanOrigin, '192.168.50.21')).allowed).toBe(false)
    expect(assertLoopbackRequest(requestLike('127.0.0.1:4173', 'http://127.0.0.1:5173', '127.0.0.1')).allowed).toBe(true)
  })

  async function start(serverAccess = { deployHost: '127.0.0.1', listenHost: '127.0.0.1', uiPort: 5173, apiPort: 0 }) {
    await mkdir(join(root, 'db'), { recursive: true })
    const auth = new AuthSqliteStorage(join(root, 'db', 'scenarios.db'), password)
    cleanup.push(() => auth.close())
    const server = createMockServer({ port: 0, authStorage: auth, access: serverAccess })
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    cleanup.push(() => server.close())
    const address = server.httpServer.address()
    if (!address || typeof address === 'string') throw new Error('Missing listener')
    return { server, address, api: request(server.httpServer) }
  }

  it('分端口部署必须使用账号库，且不能与单入口内网模式混用', () => {
    expect(() => createMockServer({ port: 0, access })).toThrow('真实账号数据库')
  })

  it('按配置地址监听；OPTIONS、实际请求、凭据 CORS 与认证规则一致', async () => {
    // 测试只绑定 127.0.0.1，以请求头模拟局域网来源，避免在测试中开放网络端口。
    const { address, api } = await start({ ...access, listenHost: '127.0.0.1' })
    expect(address.address).toBe('127.0.0.1')
    const headers = { Host: lanApiHost, Origin: lanOrigin }
    const preflight = await api.options('/api/v1/auth/login').set(headers).expect(204)
    expect(preflight.headers['access-control-allow-origin']).toBe(lanOrigin)
    expect(preflight.headers['access-control-allow-credentials']).toBe('true')
    await api.options('/api/v1/auth/login').set({ Host: lanApiHost, Origin: 'http://evil.example' }).expect(403)
    await api.get('/api/v1/scenarios').set(headers).expect(401)
    await api.get('/api/v1/scenarios').set({ ...headers, 'X-Demo-Role': 'ADMIN' }).expect(401)
    await api.get('/api/v1/auth/session').set({ Host: lanApiHost }).expect(403)
    await api.get('/api/v1/auth/session').set({ ...headers, 'X-Forwarded-Host': lanApiHost, Host: 'evil.example' }).expect(403)
    const login = await api.post('/api/v1/auth/login').set(headers).send({ username: 'admin', passwordFixture: password }).expect(200)
    expect(login.headers['access-control-allow-origin']).toBe(lanOrigin)
    expect(login.headers['access-control-allow-origin']).not.toBe('*')
    const cookie = login.headers['set-cookie'][0].split(';')[0]
    expect((await api.get('/api/v1/auth/session').set({ ...headers, Cookie: cookie }).expect(200)).body.data.authenticated).toBe(true)
    await api.get('/api/v1/auth/session').set({ Host: lanApiHost, Origin: 'http://192.168.50.11:5173', Cookie: cookie }).expect(403)
  })

  it('WebSocket 升级采用同一来源规则，并且仍需要有效会话', async () => {
    const { address, api } = await start({ ...access, listenHost: '127.0.0.1' })
    const headers = { Host: lanApiHost, Origin: lanOrigin }
    const login = await api.post('/api/v1/auth/login').set(headers).send({ username: 'admin', passwordFixture: password }).expect(200)
    const cookie = login.headers['set-cookie'][0].split(';')[0]
    const connect = (origin: string, withCookie = true) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/v1?role=ADMIN`, { origin, headers: { Host: lanApiHost, ...(withCookie ? { Cookie: cookie } : {}) } })
      cleanup.push(() => ws.terminate())
      return ws
    }
    const ok = connect(lanOrigin)
    await once(ok, 'open')
    const acknowledgement = once(ok, 'message')
    ok.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['runtime.state'] }))
    expect(JSON.parse(String((await acknowledgement)[0])).type).toBe('subscribed')
    const foreign = connect('http://192.168.50.11:5173')
    expect(JSON.parse(String((await once(foreign, 'message'))[0])).code).toBe('LOOPBACK_ONLY')
    const anonymous = connect(lanOrigin, false)
    expect(JSON.parse(String((await once(anonymous, 'message'))[0])).type).toBe('rejected')
  })
})

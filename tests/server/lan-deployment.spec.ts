// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createServer } = await import('node:' + 'http')
const { once } = await import('node:' + 'events')
const { default: request } = await import('super' + 'test')
const { WebSocket } = await import('w' + 's')
// 与现有 server 测试一致：前端测试项目不将服务器源码重复纳入 composite 编译。
const { createMockServer } = await import('../../server/' + 'app.js')
const { AuthSqliteStorage } = await import('../../server/local/' + 'auth-sqlite.js')
const { createLanSite } = await import('../../server/local/' + 'lan-site.js')
const { readLanConfig } = await import('../../server/local/' + 'lan-config.js')
const { assertLanRequest, validatePublicOrigin } = await import('../../server/http/' + 'loopback.js')

const origin = 'http://wrj.test:8080'
const host = 'wrj.test:8080'
const password = 'Lan-test-password-2026!'
let root: string
let webRoot: string
const cleanup: Array<() => void | Promise<void>> = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wrj-lan-test-'))
  webRoot = join(root, 'dist')
  await mkdir(webRoot)
  await writeFile(join(webRoot, 'index.html'), '<meta name="wrj-deployment" content="lan"><main>LAN SITE</main>')
  await writeFile(join(webRoot, 'app.js'), 'console.log("site")')
  await writeFile(join(root, 'mission.exe'), 'test-only; never executed')
})
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  await rm(root, { recursive: true, force: true })
})

async function start(tilePort = 1, publicOrigin = origin) {
  const auth = new AuthSqliteStorage(join(root, 'scenarios.db'), password)
  cleanup.push(() => auth.close())
  const server = createMockServer({ port: 0, host: '127.0.0.1', publicOrigin, authStorage: auth, site: createLanSite(webRoot, tilePort) })
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  cleanup.push(() => server.close())
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener')
  return { server, api: request(server.httpServer), base: `http://127.0.0.1:${address.port}` }
}

describe('内网发布入口', () => {
  it('不允许纯 Mock 配置打开内网入口', () => {
    expect(() => createMockServer({ publicOrigin: origin })).toThrow('真实账号数据库')
  })

  it('同源页面、刷新路由和静态资源可用；未认证 API 保持保护且不落入 SPA', async () => {
    const { api } = await start()
    expect((await api.get('/situation').set('Host', host).expect(200)).text).toContain('LAN SITE')
    await api.get('/app.js').set('Host', host).expect(200)
    await api.get('/missing.js').set('Host', host).expect(404)
    await api.get('/.env.server').set('Host', host).expect(404)
    await api.get('/api/v1/scenarios').set('Host', host).expect(401)
    const session = await api.get('/api/v1/auth/session').set('Host', host).expect(200)
    expect(session.body.data.authenticated).toBe(false)
    const login = await api.post('/api/v1/auth/login').set({ Host: host, Origin: origin }).send({ username: 'admin', passwordFixture: password }).expect(200)
    const cookie = login.headers['set-cookie'][0].split(';')[0]
    expect(login.headers['set-cookie'][0]).not.toContain('Secure')
    expect((await api.get('/api/v1/auth/session').set({ Host: host, Cookie: cookie })).body.data.authenticated).toBe(true)
    const missing = await api.get('/api/missing').set({ Host: host, Cookie: cookie }).expect(404)
    expect(missing.text).not.toContain('LAN SITE')
  })

  it('拒绝错误 Host、外站来源和不带 Origin 的写入；不信任伪造转发头', async () => {
    const { api } = await start()
    await api.get('/').set('Host', 'evil.example').expect(403)
    await api.get('/').set({ Host: host, Origin: 'http://evil.example', 'X-Forwarded-Host': host }).expect(403)
    await api.post('/api/v1/auth/login').set('Host', host).send({ username: 'admin', passwordFixture: password }).expect(403)
    await api.options('/api/v1/auth/login').set({ Host: host, Origin: origin }).expect(204)
    await api.options('/api/v1/auth/login').set({ Host: host, Origin: 'null' }).expect(403)
  })

  it('HTTPS 入口的登录和注销 Cookie 都带 Secure', async () => {
    const { api } = await start(1, 'https://wrj.test:8080')
    const headers = { Host: host, Origin: 'https://wrj.test:8080' }
    const login = await api.post('/api/v1/auth/login').set(headers).send({ username: 'admin', passwordFixture: password }).expect(200)
    expect(login.headers['set-cookie'][0]).toContain('; Secure')
    const logout = await api.post('/api/v1/auth/logout').set(headers).send({ confirm: true }).expect(200)
    expect(logout.headers['set-cookie'][0]).toContain('; Secure')
  })

  it('地图固定代理到本机、保留瓦片响应且不转发会话；上游故障明确返回 503', async () => {
    let receivedCookie: string | undefined
    const tiles = createServer((req: { headers: { cookie?: string } }, res: { writeHead(code: number, headers: Record<string, string>): void; end(value: string): void }) => {
      receivedCookie = req.headers.cookie
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf', ETag: 'tile-test' })
      res.end('tile-bytes')
    })
    tiles.listen(0, '127.0.0.1')
    await once(tiles, 'listening')
    const address = tiles.address()
    if (!address || typeof address === 'string') throw new Error('Missing tile listener')
    cleanup.push(() => new Promise<void>(resolve => tiles.close(() => resolve())))
    const { api } = await start(address.port)
    const result = await api.get('/tiles/china-taiwan-260823/1/0/0').set({ Host: host, Cookie: 'wrj_session=private' }).expect(200)
    expect(result.headers.etag).toBe('tile-test')
    expect(receivedCookie).toBeUndefined()
    await api.get('/tiles/unknown/1/0/0').set('Host', host).expect(404)
    await new Promise<void>(resolve => tiles.close(() => resolve()))
    await api.get('/tiles/taiwan-strait-satellite/1/0/0').set('Host', host).expect(503)
  })

  it('WebSocket 必须同时拥有部署来源和有效会话，角色参数不能代替登录', async () => {
    const { api, base } = await start()
    const login = await api.post('/api/v1/auth/login').set({ Host: host, Origin: origin }).send({ username: 'admin', passwordFixture: password })
    const cookie = login.headers['set-cookie'][0].split(';')[0]
    const connect = (cookieHeader?: string, source = origin) => {
      const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws/v1?role=ADMIN`, { origin: source, headers: { Host: host, ...(cookieHeader ? { Cookie: cookieHeader } : {}) } })
      cleanup.push(() => ws.terminate())
      return ws
    }
    const valid = connect(cookie)
    await once(valid, 'open')
    const acknowledgement = once(valid, 'message')
    valid.send(JSON.stringify({ type: 'subscribe', schemaVersion: '1.0', taskId: 'TASK-001', topics: ['runtime.state'] }))
    expect(JSON.parse(String((await acknowledgement)[0])).type).toBe('subscribed')
    const anonymous = connect()
    expect(JSON.parse(String((await once(anonymous, 'message'))[0])).type).toBe('rejected')
    const foreign = connect(cookie, 'http://evil.example')
    expect(JSON.parse(String((await once(foreign, 'message'))[0])).code).toBe('LOOPBACK_ONLY')
  })
})

describe('内网配置校验', () => {
  const env = () => ({ WRJ_PUBLIC_ORIGIN: origin, WRJ_WEB_ROOT: webRoot, WRJ_OUTPUT_ROOT: join(root, 'output'), SCENARIO_DB_PATH: join(root, 'scenarios.db'), MISSION_EXECUTABLE_PATH: join(root, 'mission.exe') })
  it('允许完整发布目录，拒绝端口冲突、缺少配置和公开目录中的私有数据', async () => {
    expect((await readLanConfig(env())).port).toBe(8080)
    await expect(readLanConfig({ ...env(), WRJ_MAP_PORT: '8080' })).rejects.toThrow('相同端口')
    await expect(readLanConfig({ ...env(), WRJ_PUBLIC_ORIGIN: '' })).rejects.toThrow('必须配置')
    await expect(readLanConfig({ ...env(), WRJ_OUTPUT_ROOT: join(webRoot, 'output') })).rejects.toThrow('公开目录')
    await expect(readLanConfig({ ...env(), SCENARIO_DB_PATH: join(webRoot, 'private.db') })).rejects.toThrow('公开目录')
    await expect(readLanConfig({ ...env(), WRJ_WEB_ROOT: 'relative' })).rejects.toThrow('绝对路径')
  })
  it('仅网页部署无需仿真程序，同时保持数据库和输出目录隔离', async () => {
    const webOnly = { ...env(), WRJ_WEB_ONLY: '1' }
    delete (webOnly as { MISSION_EXECUTABLE_PATH?: string }).MISSION_EXECUTABLE_PATH
    expect((await readLanConfig(webOnly)).executable).toBeUndefined()
    await expect(readLanConfig({ ...webOnly, SCENARIO_DB_PATH: join(webRoot, 'private.db') })).rejects.toThrow('公开目录')
    await expect(readLanConfig({ ...webOnly, WRJ_WEB_ONLY: 'yes' })).rejects.toThrow('只能设置为 1')
  })
  it('拒绝普通开发构建，避免发布后浏览器访问自己的 localhost', async () => {
    await writeFile(join(webRoot, 'index.html'), '<main>ordinary build</main>')
    await expect(readLanConfig(env())).rejects.toThrow('build:lan')
  })
  it('入口拒绝路径和凭据，WS 即使是 GET 也不能缺少来源', () => {
    expect(validatePublicOrigin(`${origin}/`)).toBe(origin)
    for (const value of [`${origin}/path`, 'http://user:pass@wrj.test', `${origin}?q=x`, 'file:///tmp/app']) expect(() => validatePublicOrigin(value)).toThrow()
    expect(assertLanRequest({ method: 'GET', headers: { host }, socket: {} }, origin).allowed).toBe(true)
    expect(assertLanRequest({ method: 'GET', headers: { host }, socket: {} }, origin, true).allowed).toBe(false)
  })
})

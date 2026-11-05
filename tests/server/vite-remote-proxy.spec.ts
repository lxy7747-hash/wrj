// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
const { EventEmitter, once } = await import('node:' + 'events')
const { createServer } = await import('node:' + 'http')
const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { WebSocket, WebSocketServer } = await import('w' + 's')
const { createServer: createViteServer } = await import('vi' + 'te')
const { createRemoteProxy } = await import('../../scripts/' + 'vite-remote-proxy.ts')
const { assertLanRequest } = await import('../../server/http/' + 'loopback.ts')

const target = 'http://192.168.1.49:8080'
const localOrigin = 'http://127.0.0.1:5173'
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})

function events(prefix: string) {
  const options = createRemoteProxy(target)[prefix]
  const proxy = new EventEmitter()
  options.configure(proxy, options)
  return proxy
}

describe('远程开发代理', () => {
  it.each(['', 'ftp://example.com', 'file:///tmp/service', `${target}/api`, 'http://user:secret@example.com', `${target}?a=1`, `${target}#path`])('拒绝非法目标 %s', value => {
    expect(() => createRemoteProxy(value)).toThrow()
  })

  it('三个入口使用同一目标和 Host 改写，仅 WS 启用升级', () => {
    const proxy = createRemoteProxy(target)
    expect(Object.keys(proxy)).toEqual(['/api', '/ws', '/tiles'])
    for (const options of Object.values(proxy) as Array<{ target: string; changeOrigin: boolean }>) {
      expect(options).toMatchObject({ target, changeOrigin: true })
    }
    expect(proxy['/ws'].ws).toBe(true)
    expect(proxy['/api'].ws).toBeUndefined()
    expect(proxy['/tiles'].ws).toBeUndefined()
    expect(createRemoteProxy('https://wrj.example/')['/api'].target).toBe('https://wrj.example')
  })

  it.each(['/api', '/ws', '/tiles'])('%s 只在来源合法时改写 HTTP Origin；无 Origin 的 GET 可通过', prefix => {
    const proxy = events(prefix)
    for (const origin of [localOrigin, 'http://localhost:5173', undefined]) {
      const outgoing = { setHeader: vi.fn(), destroy: vi.fn() }
      proxy.emit('proxyReq', outgoing, { method: 'GET', headers: { origin } }, {})
      expect(outgoing.setHeader).toHaveBeenCalledWith('origin', target)
      expect(outgoing.destroy).not.toHaveBeenCalled()
    }
    for (const origin of ['http://foreign.example', 'null', '', target]) {
      const outgoing = { setHeader: vi.fn(), destroy: vi.fn() }
      const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() }
      proxy.emit('proxyReq', outgoing, { headers: { origin } }, response)
      expect(response.writeHead).toHaveBeenCalledWith(403, expect.any(Object))
      expect(response.end).toHaveBeenCalledOnce()
      expect(outgoing.destroy).toHaveBeenCalledOnce()
      expect(outgoing.setHeader).not.toHaveBeenCalled()
    }
  })

  it('WS 来源合法时改写 Origin，外站来源销毁两端请求且不改写', () => {
    const proxy = events('/ws')
    const outgoing = { setHeader: vi.fn(), destroy: vi.fn() }
    const socket = { destroy: vi.fn() }
    proxy.emit('proxyReqWs', outgoing, { headers: { origin: localOrigin } }, socket)
    expect(outgoing.setHeader).toHaveBeenCalledWith('origin', target)
    expect(socket.destroy).not.toHaveBeenCalled()
    outgoing.setHeader.mockClear()
    proxy.emit('proxyReqWs', outgoing, { headers: { origin: 'http://foreign.example' } }, socket)
    expect(outgoing.destroy).toHaveBeenCalledOnce()
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(outgoing.setHeader).not.toHaveBeenCalled()
  })

  it('远程模式不启动本机地图，普通开发保留地图，preview 不继承代理', async () => {
    const { default: configure } = await import('../../vite.config' + '.ts')
    vi.stubEnv('VITE_API_TARGET', target)
    const remote = configure({ command: 'serve', mode: 'remote' })
    expect(remote.server.host).toBe('127.0.0.1')
    expect(remote.server.proxy['/ws'].ws).toBe(true)
    expect(remote.plugins.filter(Boolean).map((plugin: { name: string }) => plugin.name)).not.toContain('wrj-versatiles')
    const preview = configure({ command: 'serve', mode: 'remote', isPreview: true })
    expect(preview.server.proxy).toBeUndefined()
    expect(preview.preview.proxy).toEqual({})
    vi.stubEnv('VITE_API_TARGET', '')
    const local = configure({ command: 'serve', mode: 'development' })
    expect(local.server.proxy).toBeUndefined()
    expect(local.plugins.filter(Boolean).map((plugin: { name: string }) => plugin.name)).toContain('wrj-versatiles')
    expect(() => configure({ command: 'serve', mode: 'remote' })).toThrow('.env.remote.local')
  })

  it('真实 HTTP/WS 转发保持 Cookie 和瓦片；外站请求不会到达上游', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-remote-proxy-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    let upstreamOrigin = ''
    const received: Array<{ url: string; host?: string; origin?: string; cookie?: string }> = []
    const upstream = createServer((req: { url: string; method: string; headers: Record<string, string>; socket: object }, res: { writeHead(status: number, headers?: Record<string, string>): void; end(body: string): void }) => {
      received.push({ url: req.url, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie })
      if (!assertLanRequest(req, upstreamOrigin).allowed) { res.writeHead(403); res.end('denied'); return }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'wrj_session=proxy-test; Path=/; HttpOnly; SameSite=Strict' })
      res.end(JSON.stringify(received.at(-1)))
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`
    cleanup.push(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()) }))
    const sockets = new WebSocketServer({ noServer: true })
    cleanup.push(() => new Promise<void>(resolve => { for (const client of sockets.clients) client.terminate(); sockets.close(() => resolve()) }))
    upstream.on('upgrade', (req: { url: string; method: string; headers: Record<string, string>; socket: object }, socket: { destroy(): void }, head: unknown) => {
      received.push({ url: req.url, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie })
      if (!assertLanRequest(req, upstreamOrigin, true).allowed) { socket.destroy(); return }
      sockets.handleUpgrade(req, socket, head, (client: { send(value: string): void }) => client.send(JSON.stringify(received.at(-1))))
    })
    const vite = await createViteServer({ configFile: false, root, logLevel: 'silent', appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0, proxy: createRemoteProxy(upstreamOrigin) } })
    cleanup.push(() => vite.close())
    await vite.listen()
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`
    for (const path of ['/api/v1/login', '/tiles/china-taiwan-260823/1/0/0']) {
      const denied = await fetch(base + path, { headers: { Origin: 'http://foreign.example' }, signal: AbortSignal.timeout(3000) })
      expect(denied.status).toBe(403)
      await denied.text()
    }
    expect(received).toHaveLength(0)
    const login = await fetch(`${base}/api/v1/login`, { method: 'POST', headers: { Origin: localOrigin } })
    expect(login.status).toBe(200)
    expect(login.headers.get('set-cookie')).toContain('SameSite=Strict')
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    expect(await login.json()).toMatchObject({ host: new URL(upstreamOrigin).host, origin: upstreamOrigin })
    const session = await fetch(`${base}/api/v1/session`, { headers: { Cookie: cookie } })
    expect(await session.json()).toMatchObject({ cookie, origin: upstreamOrigin })
    const tile = await fetch(`${base}/tiles/china-taiwan-260823/1/0/0`)
    expect(await tile.json()).toMatchObject({ url: '/tiles/china-taiwan-260823/1/0/0', host: new URL(upstreamOrigin).host })
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/v1', { origin: localOrigin, headers: { Cookie: cookie } })
    cleanup.push(() => ws.terminate())
    const message = once(ws, 'message')
    expect(JSON.parse(String((await message)[0]))).toMatchObject({ url: '/ws/v1', origin: upstreamOrigin, cookie })
    const before = received.length
    const foreign = new WebSocket(base.replace('http:', 'ws:') + '/ws/v1', { origin: 'http://foreign.example' })
    cleanup.push(() => foreign.terminate())
    await new Promise<void>(resolve => foreign.once('error', () => resolve()))
    expect(received).toHaveLength(before)
  })
})

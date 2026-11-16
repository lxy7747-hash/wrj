// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const { once } = await import('node:' + 'events')
const { connect } = await import('node:' + 'net')
const { createMockServer } = await import('../../server/' + 'app.js')

describe('HTTP 服务正常关闭', () => {
  it('浏览器只预连接、未发送 HTTP 请求时也能关闭', async () => {
    const server = createMockServer({ port: 0 })
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const socket = connect(server.httpServer.address().port, '127.0.0.1')
    try {
      await once(socket, 'connect')
      let closed = false
      const closing = server.close().then(() => { closed = true })
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 })
      await closing
    } finally {
      socket.destroy()
      await server.close()
    }
  })

  it('关闭空连接时仍等待已接收的请求结束', async () => {
    let release!: () => void
    const gate = new Promise<null>(resolve => { release = () => resolve(null) })
    const loadLocalReport = vi.fn(() => gate)
    const server = createMockServer({ port: 0, loadLocalReport })
    if (!server.httpServer.listening) await once(server.httpServer, 'listening')
    const port = server.httpServer.address().port
    const idle = connect(port, '127.0.0.1')
    let response: Promise<globalThis.Response> | undefined
    try {
      await once(idle, 'connect')
      response = fetch(`http://127.0.0.1:${port}/api/v1/reports`, { headers: { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR', Connection: 'close' } })
      await vi.waitFor(() => expect(loadLocalReport).toHaveBeenCalledOnce())
      let closed = false
      const closing = server.close().then(() => { closed = true })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(closed).toBe(false)
      release()
      const completed = await response
      expect(completed.status).toBe(200)
      expect((await completed.json()).data).toEqual([])
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 })
      await closing
    } finally {
      release()
      idle.destroy()
      await response?.catch(() => undefined)
      await server.close()
    }
  })
})

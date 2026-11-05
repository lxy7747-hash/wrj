import type { ProxyOptions } from 'vite'
import { validatePublicOrigin, VITE_ORIGINS } from '../server/http/loopback.ts'

/** 仅开发入口使用同源代理；先校验浏览器来源，再改写上游 Host/Origin。 */
export function createRemoteProxy(target: string): Record<string, ProxyOptions> {
  const origin = validatePublicOrigin(target)
  const configure: NonNullable<ProxyOptions['configure']> = proxy => {
    proxy.on('proxyReq', (outgoing, request, response) => {
      if (request.headers.origin !== undefined && !VITE_ORIGINS.has(request.headers.origin)) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('请求来源不在允许范围内。')
        outgoing.destroy()
        return
      }
      outgoing.setHeader('origin', origin)
    })
    proxy.on('proxyReqWs', (outgoing, request, socket) => {
      if (request.headers.origin !== undefined && !VITE_ORIGINS.has(request.headers.origin)) {
        outgoing.destroy()
        socket.destroy()
        return
      }
      outgoing.setHeader('origin', origin)
    })
  }
  return Object.fromEntries(['/api', '/ws', '/tiles'].map(prefix => [prefix, {
    target: origin, changeOrigin: true, ...(prefix === '/ws' ? { ws: true } : {}), configure,
  }]))
}

import { request as httpRequest } from 'node:http'
import { pipeline } from 'node:stream'
import { join } from 'node:path'
import express, { type RequestHandler } from 'express'

/** 只公开前端构建目录；地图固定转发到本机服务，不接受客户端指定上游。 */
export function createLanSite(webRoot: string, tilePort: number): RequestHandler {
  const router = express.Router()
  router.use('/tiles', (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.sendStatus(405); return }
    if (!/^\/tiles\/(china-taiwan-260823|taiwan-strait-satellite)\//.test(req.originalUrl)) {
      res.sendStatus(404); return
    }
    const headers: Record<string, string> = {}
    for (const name of ['range', 'if-none-match', 'if-modified-since', 'accept-encoding']) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: tilePort, method: req.method, path: req.originalUrl, headers }, response => {
      res.status(response.statusCode ?? 502)
      for (const name of ['content-type', 'content-length', 'content-encoding', 'cache-control', 'etag', 'last-modified', 'accept-ranges', 'content-range', 'vary']) {
        const value = response.headers[name]
        if (value !== undefined) res.setHeader(name, value)
      }
      pipeline(response, res, () => upstream.destroy())
    })
    upstream.setTimeout(15_000, () => upstream.destroy(new Error('地图服务响应超时。')))
    upstream.on('error', () => {
      if (!res.headersSent) res.status(503).json({ ok: false, message: '地图服务暂时不可用。' })
      else res.destroy()
    })
    res.once('close', () => upstream.destroy())
    upstream.end()
  })
  const staticFiles = express.static(webRoot, { dotfiles: 'deny', index: false, fallthrough: true })
  router.use((req, res, next) => {
    // 缺失 API/WS 不能落入 SPA；只从构建目录提供静态文件。
    if (/^\/(api|ws)(\/|$)/.test(req.path)) { next(); return }
    staticFiles(req, res, error => {
      if (error) { next(error); return }
      if (!['GET', 'HEAD'].includes(req.method) || !req.accepts('html') || req.path.split('/').some(part => part.includes('.'))) {
        res.sendStatus(404); return
      }
      res.setHeader('Cache-Control', 'no-store')
      res.sendFile(join(webRoot, 'index.html'))
    })
  })
  return router
}

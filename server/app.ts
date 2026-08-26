import { createServer, type Server as HttpServer } from 'node:http'
import express, { type NextFunction, type Request, type Response } from 'express'
import type { ResetRequest, ResetResult, Role } from '../src/contracts/domain-models.js'
import { failure, success } from './http/envelope.js'
import { assertLoopbackRequest, VITE_ORIGIN } from './http/loopback.js'
import { MockProjection } from './state/projection.js'
import { attachRealtimeServer, type RealtimeController } from './ws/realtime.js'

export interface MockServerOptions {
  port?: number
}

export interface MockServer {
  httpServer: HttpServer
  projection: MockProjection
  close(): Promise<void>
}

function readDemoRole(req: Request): Role | undefined {
  const value = req.get('X-Demo-Role')
  return value === 'ADMIN' || value === 'OPERATOR' ? value : undefined
}

function isResetRequest(value: unknown): value is ResetRequest {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as Record<string, unknown>).confirm === true
}

export function createMockServer(options: MockServerOptions = {}): MockServer {
  const port = options.port ?? 0
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('Mock server port must be an integer from 0 through 65535.')
  }

  const projection = new MockProjection()
  const app = express()
  app.disable('x-powered-by')
  app.set('strict routing', true)

  let realtime: RealtimeController

  app.use((req, res, next) => {
    const decision = assertLoopbackRequest(req)
    if (!decision.allowed) {
      res.status(403).json(failure('LOOPBACK_ONLY', 403, { message: decision.message }))
      return
    }

    res.setHeader('Access-Control-Allow-Origin', VITE_ORIGIN)
    res.setHeader('Access-Control-Allow-Methods', 'POST')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Demo-Role')
    res.setHeader('Vary', 'Origin')
    next()
  })

  app.options('/api/v1/reset', (_req, res) => {
    res.sendStatus(204)
  })

  app.use(express.json({ strict: true, limit: '16kb' }))

  app.post('/api/v1/reset', (req, res) => {
    if (readDemoRole(req) === undefined) {
      res.status(403).json(failure('PERMISSION_DENIED', 403))
      return
    }

    if (!isResetRequest(req.body)) {
      res.status(400).json(failure('INVALID_REQUEST', 400, { fieldPath: 'confirm' }))
      return
    }

    const result: ResetResult = realtime.reset()
    res.status(200).json(success(result, {
      requestId: result.requestId,
      generatedAt: result.generatedAt,
      page: 1,
      pageSize: 1,
      total: 1,
    }))
  })

  app.use('/api', (_req, res) => {
    res.status(404).json(failure('NOT_FOUND', 404))
  })

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const details = error instanceof Error ? error.message : 'Unknown JSON parsing error.'
    res.status(400).json(failure('INVALID_REQUEST', 400, { details }))
  })

  const httpServer = createServer(app)
  realtime = attachRealtimeServer(httpServer, projection)
  httpServer.listen(port, '127.0.0.1')

  let closePromise: Promise<void> | undefined
  return {
    httpServer,
    projection,
    close: () => {
      closePromise ??= realtime.close().then(() => new Promise<void>((resolve, rejectClose) => {
        httpServer.close((error) => {
          if (error === undefined) {
            resolve()
          } else {
            rejectClose(error)
          }
        })
      }))
      return closePromise
    },
  }
}

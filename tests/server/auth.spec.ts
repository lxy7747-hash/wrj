import { afterEach, beforeAll, describe, expect, it } from 'vitest'

const ORIGIN = 'http://127.0.0.1:5173'
const DEFAULT_LOGIN_PASSWORD = '123456'

type Role = 'ADMIN' | 'OPERATOR'
type UserStatus = 'ACTIVE' | 'DISABLED' | 'LOCKED'
type UserOperation = 'CREATE' | 'UPDATE' | 'DELETE' | 'ENABLE' | 'DISABLE'

interface User {
  userId: string
  username: string
  role: Role
  status: UserStatus
  lastLoginAt?: string
}

interface HttpServerInstance {
  listening: boolean
  once(event: string, listener: (...args: unknown[]) => void): unknown
  address(): { port: number } | string | null
}

interface MockServerInstance {
  httpServer: HttpServerInstance
  auditSnapshot(): Array<Record<string, unknown>>
  close(): Promise<void>
}

interface HttpResponse {
  body: any
  headers: Record<string, string | string[] | undefined>
}

interface RequestChain {
  set(name: string, value: string): this
  send(body: unknown): this
  expect(status: number): Promise<HttpResponse>
}

interface RequestClient {
  get(path: string): RequestChain
  post(path: string): RequestChain
  put(path: string): RequestChain
  delete(path: string): RequestChain
}

let createMockServer: (options?: { port?: number }) => MockServerInstance
let request: (baseUrl: string) => RequestClient
let currentServer: MockServerInstance | undefined

beforeAll(async () => {
  const appModulePath = '../../server/' + 'app.js'
  const supertestModulePath = 'super' + 'test'
  const appModule = await import(appModulePath) as { createMockServer: typeof createMockServer }
  const supertestModule = await import(supertestModulePath) as { default: typeof request }
  ;({ createMockServer } = appModule)
  ;({ default: request } = supertestModule)
})

async function startServer(): Promise<{ server: MockServerInstance; baseUrl: string }> {
  const server = createMockServer({ port: 0 })
  currentServer = server
  if (!server.httpServer.listening) {
    await new Promise<void>((resolve, reject) => {
      server.httpServer.once('listening', () => resolve())
      server.httpServer.once('error', reject)
    })
  }

  const address = server.httpServer.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP listener address.')
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

function asAdmin(baseUrl: string) {
  return {
    get: (path: string) => request(baseUrl).get(path).set('Origin', ORIGIN).set('X-Demo-Role', 'ADMIN'),
    post: (path: string) => request(baseUrl).post(path).set('Origin', ORIGIN).set('X-Demo-Role', 'ADMIN'),
    put: (path: string) => request(baseUrl).put(path).set('Origin', ORIGIN).set('X-Demo-Role', 'ADMIN'),
    delete: (path: string) => request(baseUrl).delete(path).set('Origin', ORIGIN).set('X-Demo-Role', 'ADMIN'),
  }
}

function command(operation: UserOperation, user: User): { operation: UserOperation; user: User } {
  return { operation, user }
}

afterEach(async () => {
  const server = currentServer
  currentServer = undefined
  if (server !== undefined) {
    await server.close()
  }
})

describe('P1 in-memory authentication boundary', () => {
  it('accepts login from the named loopback UI origin', async () => {
    const { baseUrl } = await startServer()

    const response = await request(baseUrl)
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ username: 'admin', passwordFixture: DEFAULT_LOGIN_PASSWORD })
      .expect(200)

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  it.each([
    ['admin', 'USR-ADMIN', 'ADMIN'],
    ['operator', 'USR-OPERATOR', 'OPERATOR'],
  ] as const)('authenticates the active %s fixture without creating a session', async (username, userId, role) => {
    const { baseUrl } = await startServer()

    const response = await request(baseUrl)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ username, passwordFixture: DEFAULT_LOGIN_PASSWORD })
      .expect(200)

    expect(response.body).toMatchObject({
      ok: true,
      data: {
        authenticated: true,
        principal: { userId, username, role, permissions: expect.any(Array) },
        sessionCreated: false,
      },
      meta: {
        requestId: 'REQ-P1-AUTH-LOGIN',
        generatedAt: '2026-08-06T08:00:00Z',
        page: 1,
        pageSize: 1,
        total: 1,
      },
    })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers.authorization).toBeUndefined()
  })

  it('rejects bad, unknown, and malformed credential fixtures deterministically', async () => {
    const { baseUrl } = await startServer()

    const retiredPassword = await request(baseUrl)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ username: 'admin', passwordFixture: 'VALID_FIXTURE' })
      .expect(401)
    expect(retiredPassword.body).toMatchObject({ ok: false, error: { code: 'INVALID_CREDENTIALS' } })

    const unknown = await request(baseUrl)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ username: 'unknown', passwordFixture: DEFAULT_LOGIN_PASSWORD })
      .expect(401)
    expect(unknown.body).toMatchObject({ ok: false, error: { code: 'INVALID_CREDENTIALS' } })

    const extraProperty = await request(baseUrl)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ username: 'admin', passwordFixture: DEFAULT_LOGIN_PASSWORD, persist: true })
      .expect(400)
    expect(extraProperty.body).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('returns ACCOUNT_LOCKED before evaluating the locked fixture password', async () => {
    const { baseUrl } = await startServer()

    const response = await request(baseUrl)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ username: 'locked', passwordFixture: 'WRONG' })
      .expect(423)

    expect(response.body).toMatchObject({ ok: false, error: { code: 'ACCOUNT_LOCKED' } })
  })

  it('resolves role permissions and denies a missing or invalid demo role', async () => {
    const { baseUrl } = await startServer()

    const admin = await request(baseUrl)
      .get('/api/v1/auth/permissions')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .expect(200)
    expect(admin.body.data).toMatchObject({
      role: 'ADMIN',
      permissions: expect.arrayContaining(['USER_ROLE_MAINTAIN', 'AUDIT_READ', 'BUSINESS_READ']),
    })
    expect(new Set(admin.body.data.permissions).size).toBe(admin.body.data.permissions.length)

    const operator = await request(baseUrl)
      .get('/api/v1/auth/permissions')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .expect(200)
    expect(operator.body.data).toEqual({
      role: 'OPERATOR',
      permissions: [
        'BUSINESS_READ',
        'SCENARIO_DRAFT_WRITE',
        'SIMULATION_CONTROL',
        'ORDINARY_REPORT_EXPORT',
      ],
    })

    for (const role of [undefined, 'VIEWER']) {
      const chain = request(baseUrl).get('/api/v1/auth/permissions').set('Origin', ORIGIN)
      if (role !== undefined) {
        chain.set('X-Demo-Role', role)
      }
      const denied = await chain.expect(403)
      expect(denied.body).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    }
  })

  it('denies OPERATOR direct user-management calls and records audit evidence', async () => {
    const { server, baseUrl } = await startServer()
    expect(server.auditSnapshot()).toHaveLength(1)

    const denied = await request(baseUrl)
      .get('/api/v1/admin/users')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .expect(403)

    expect(denied.body).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(server.auditSnapshot().at(-1)).toEqual({
      auditId: 'AUD-P1-0001',
      actor: 'operator',
      role: 'OPERATOR',
      module: 'USER_MANAGEMENT',
      action: 'USER_LIST',
      result: 'DENIED',
      occurredAt: '2026-08-06T08:00:00Z',
      immutableFixture: true,
    })

    const malformed = await request(baseUrl)
      .post('/api/v1/admin/users')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'OPERATOR')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(403)
    expect(malformed.body).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(server.auditSnapshot().at(-1)).toMatchObject({
      auditId: 'AUD-P1-0002',
      action: 'USER_CREATE',
      result: 'DENIED',
    })
  })

  it('creates, disables, enables, and updates users in the current projection', async () => {
    const { baseUrl } = await startServer()
    const admin = asAdmin(baseUrl)
    const reviewer: User = {
      userId: 'USR-REVIEWER',
      username: 'reviewer',
      role: 'OPERATOR',
      status: 'ACTIVE',
    }

    await admin.post('/api/v1/admin/users').send(command('CREATE', reviewer)).expect(201)

    const disabled = await admin.put('/api/v1/admin/users/USR-REVIEWER')
      .send(command('DISABLE', reviewer))
      .expect(200)
    expect(disabled.body.data).toEqual({ ...reviewer, status: 'DISABLED' })

    const enabled = await admin.put('/api/v1/admin/users/USR-REVIEWER')
      .send(command('ENABLE', { ...reviewer, status: 'DISABLED' }))
      .expect(200)
    expect(enabled.body.data).toEqual(reviewer)

    const promoted = await admin.put('/api/v1/admin/users/USR-REVIEWER')
      .send(command('UPDATE', { ...reviewer, role: 'ADMIN' }))
      .expect(200)
    expect(promoted.body.data).toEqual({ ...reviewer, role: 'ADMIN' })

    const users = await admin.get('/api/v1/admin/users').expect(200)
    expect(users.body.meta).toMatchObject({ page: 1, pageSize: 3, total: 3 })
    expect(users.body.data).toContainEqual({ ...reviewer, role: 'ADMIN' })
  })

  it('maps disabled and locked fixture-user states to the correct login denial', async () => {
    const { baseUrl } = await startServer()
    const admin = asAdmin(baseUrl)
    const operator: User = {
      userId: 'USR-OPERATOR',
      username: 'operator',
      role: 'OPERATOR',
      status: 'ACTIVE',
    }

    await admin.put('/api/v1/admin/users/USR-OPERATOR')
      .send(command('DISABLE', operator))
      .expect(200)
    await request(baseUrl)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ username: 'operator', passwordFixture: DEFAULT_LOGIN_PASSWORD })
      .expect(401)

    await admin.put('/api/v1/admin/users/USR-OPERATOR')
      .send(command('UPDATE', { ...operator, status: 'LOCKED' }))
      .expect(200)
    const locked = await request(baseUrl)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ username: 'operator', passwordFixture: DEFAULT_LOGIN_PASSWORD })
      .expect(423)
    expect(locked.body).toMatchObject({ ok: false, error: { code: 'ACCOUNT_LOCKED' } })
  })

  it('rejects duplicate, unknown, operation, and URL/body ownership conflicts', async () => {
    const { baseUrl } = await startServer()
    const admin = asAdmin(baseUrl)
    const duplicate: User = {
      userId: 'USR-DUPLICATE',
      username: 'operator',
      role: 'OPERATOR',
      status: 'ACTIVE',
    }

    const conflict = await admin.post('/api/v1/admin/users')
      .send(command('CREATE', duplicate))
      .expect(409)
    expect(conflict.body).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })

    const unknown = await admin.delete('/api/v1/admin/users/USR-UNKNOWN').expect(404)
    expect(unknown.body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })

    const wrongOperation = await admin.post('/api/v1/admin/users')
      .send(command('UPDATE', { ...duplicate, username: 'new-user' }))
      .expect(400)
    expect(wrongOperation.body).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', fieldPath: 'operation' },
    })

    const retarget = await admin.put('/api/v1/admin/users/USR-OPERATOR')
      .send(command('UPDATE', {
        userId: 'USR-ADMIN',
        username: 'operator',
        role: 'OPERATOR',
        status: 'ACTIVE',
      }))
      .expect(400)
    expect(retarget.body).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', fieldPath: 'user.userId' },
    })
  })

  it('covers reserved identities, update conflicts, no-op admin updates, and successful deletion', async () => {
    const { baseUrl } = await startServer()
    const admin = asAdmin(baseUrl)
    const fixtureAdmin: User = {
      userId: 'USR-ADMIN',
      username: 'admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    }
    const fixtureOperator: User = {
      userId: 'USR-OPERATOR',
      username: 'operator',
      role: 'OPERATOR',
      status: 'ACTIVE',
    }
    const secondAdmin: User = {
      userId: 'USR-SECOND-ADMIN',
      username: 'second-admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    }

    await admin.post('/api/v1/admin/users')
      .send(command('CREATE', { ...fixtureOperator, username: 'unique-name' }))
      .expect(409)
    await admin.post('/api/v1/admin/users')
      .send(command('CREATE', {
        userId: 'USR-LOCKED-NAME',
        username: 'locked',
        role: 'OPERATOR',
        status: 'ACTIVE',
      }))
      .expect(409)

    await admin.post('/api/v1/admin/users').send(command('CREATE', secondAdmin)).expect(201)

    const unchangedAdmin = await admin.put('/api/v1/admin/users/USR-ADMIN')
      .send(command('UPDATE', fixtureAdmin))
      .expect(200)
    expect(unchangedAdmin.body.data).toEqual(fixtureAdmin)

    const duplicateUpdate = await admin.put('/api/v1/admin/users/USR-OPERATOR')
      .send(command('UPDATE', { ...fixtureOperator, username: 'admin' }))
      .expect(409)
    expect(duplicateUpdate.body).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })

    const unknownUpdate = await admin.put('/api/v1/admin/users/USR-UNKNOWN')
      .send(command('UPDATE', {
        userId: 'USR-UNKNOWN',
        username: 'unknown',
        role: 'OPERATOR',
        status: 'ACTIVE',
      }))
      .expect(404)
    expect(unknownUpdate.body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })

    const invalidUpdateOperation = await admin.put('/api/v1/admin/users/USR-OPERATOR')
      .send(command('DELETE', fixtureOperator))
      .expect(400)
    expect(invalidUpdateOperation.body).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', fieldPath: 'operation' },
    })

    const deletedOperator = await admin.delete('/api/v1/admin/users/USR-OPERATOR').expect(200)
    expect(deletedOperator.body.data).toEqual({ deleted: true, objectId: 'USR-OPERATOR' })

    const deletedSecondAdmin = await admin.delete('/api/v1/admin/users/USR-SECOND-ADMIN').expect(200)
    expect(deletedSecondAdmin.body.data).toEqual({
      deleted: true,
      objectId: 'USR-SECOND-ADMIN',
    })
  })

  it('protects the current and last active administrator from demotion, disable, and deletion', async () => {
    const { baseUrl } = await startServer()
    const admin = asAdmin(baseUrl)
    const fixtureAdmin: User = {
      userId: 'USR-ADMIN',
      username: 'admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    }

    for (const attempt of [
      admin.put('/api/v1/admin/users/USR-ADMIN').send(command('UPDATE', {
        ...fixtureAdmin,
        role: 'OPERATOR',
      })),
      admin.put('/api/v1/admin/users/USR-ADMIN').send(command('DISABLE', fixtureAdmin)),
      admin.delete('/api/v1/admin/users/USR-ADMIN'),
    ]) {
      const response = await attempt.expect(409)
      expect(response.body).toMatchObject({ ok: false, error: { code: 'LAST_ADMIN_GUARD' } })
    }

    const users = await admin.get('/api/v1/admin/users').expect(200)
    expect(users.body.data).toContainEqual(fixtureAdmin)
  })

  it.each([
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-01T00:00:00Z',
    '2026-01-00T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '1900-02-29T00:00:00Z',
    'garbage',
  ] as const)('rejects the impossible lastLoginAt timestamp %s', async (lastLoginAt) => {
    const { baseUrl } = await startServer()
    const admin = asAdmin(baseUrl)

    const rejected = await admin.post('/api/v1/admin/users')
      .send(command('CREATE', {
        userId: `USR-BAD-${lastLoginAt.slice(0, 4)}`,
        username: `bad-${lastLoginAt.slice(0, 4)}`,
        role: 'OPERATOR',
        status: 'ACTIVE',
        lastLoginAt,
      }))
      .expect(400)

    expect(rejected.body).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('accepts canonical and lowercase RFC 3339 lastLoginAt timestamps', async () => {
    const { baseUrl } = await startServer()
    const admin = asAdmin(baseUrl)

    await admin.post('/api/v1/admin/users')
      .send(command('CREATE', {
        userId: 'USR-TIMESTAMP',
        username: 'timestamp-user',
        role: 'OPERATOR',
        status: 'ACTIVE',
        lastLoginAt: '2026-08-06T08:00:00Z',
      }))
      .expect(201)

    await admin.post('/api/v1/admin/users')
      .send(command('CREATE', {
        userId: 'USR-TIMESTAMP-2',
        username: 'timestamp-user-2',
        role: 'OPERATOR',
        status: 'ACTIVE',
        lastLoginAt: '2024-02-29t00:00:00z',
      }))
      .expect(201)

    await admin.post('/api/v1/admin/users')
      .send(command('CREATE', {
        userId: 'USR-TIMESTAMP-3',
        username: 'timestamp-user-3',
        role: 'OPERATOR',
        status: 'ACTIVE',
        lastLoginAt: '2000-02-29T00:00:00Z',
      }))
      .expect(201)
  })

  it('restores fixture users and clears mutable audit additions on reset', async () => {    const { server, baseUrl } = await startServer()
    const admin = asAdmin(baseUrl)
    const operator: User = {
      userId: 'USR-OPERATOR',
      username: 'operator',
      role: 'OPERATOR',
      status: 'ACTIVE',
    }

    await admin.put('/api/v1/admin/users/USR-OPERATOR')
      .send(command('DISABLE', operator))
      .expect(200)
    expect(server.auditSnapshot().length).toBeGreaterThan(1)

    await request(baseUrl)
      .post('/api/v1/reset')
      .set('Origin', ORIGIN)
      .set('X-Demo-Role', 'ADMIN')
      .send({ confirm: true })
      .expect(200)

    expect(server.auditSnapshot()).toEqual([{
      auditId: 'AUD-001',
      actor: 'admin',
      role: 'ADMIN',
      module: 'SCENARIO_CONFIGURATION',
      action: 'THRESHOLD_UPDATE',
      objectId: 'MW-COMM',
      result: 'SUCCESS',
      occurredAt: '2026-08-06T08:04:00Z',
      immutableFixture: true,
    }])

    const users = await admin.get('/api/v1/admin/users').expect(200)
    expect(users.body.data).toEqual([
      { userId: 'USR-ADMIN', username: 'admin', role: 'ADMIN', status: 'ACTIVE' },
      { userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', status: 'ACTIVE' },
    ])
  })
})

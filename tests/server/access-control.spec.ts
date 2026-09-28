// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { isAccessControlConfig, isRoleProfile, canVisitMenu } from '../../src/features/admin/access-control'

const { mkdtemp, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { once } = await import('node:' + 'events')
const { AuthSqliteStorage } = await import('../../server/local/' + 'auth-sqlite.js')
const { AccessControlSqliteStorage } = await import('../../server/local/' + 'access-control-sqlite.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { default: request } = await import('super' + 'test')
const cleanups: Array<() => unknown> = []
const password = 'Only-test-password-2026'
const headers = { Origin: 'http://127.0.0.1:5173' }
const profile = { profileId: 'READ', name: '只读态势', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: ['/situation'] }
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function start() {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-access-test-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const auth = new AuthSqliteStorage(join(directory, 'auth.db'), password)
  const file = join(directory, 'access.db')
  const access = new AccessControlSqliteStorage(file)
  cleanups.push(() => auth.close(), () => access.close())
  const server = createMockServer({ port: 0, authStorage: auth, accessControlStorage: access })
  cleanups.push(() => server.close())
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const api = request(`http://127.0.0.1:${server.httpServer.address().port}`)
  const login = async (username: string) => {
    const result = await api.post('/api/v1/auth/login').set(headers).send({ username, passwordFixture: password }).expect(200)
    return { cookie: result.headers['set-cookie'][0].split(';')[0], principal: result.body.data.principal }
  }
  return { api, login, access, auth, file }
}

describe('兼容角色配置与服务端权限', () => {
  it('已注册接口按角色、操作权限和页面菜单共同收窄', async () => {
    const { api, login, access, auth } = await start()
    const users = [
      { userId: 'USR-VIEW', username: 'view-only', role: 'OPERATOR' as const },
      { userId: 'USR-SCENE-ONLY', username: 'scene-only', role: 'OPERATOR' as const },
      { userId: 'USR-BATCH-READ', username: 'batch-reader', role: 'OPERATOR' as const },
      { userId: 'USR-REPORT-READ', username: 'report-viewer', role: 'OPERATOR' as const },
      { userId: 'USR-ADMIN-SCOPE', username: 'admin-scope', role: 'ADMIN' as const },
    ]
    for (const user of users) auth.save({ ...user, status: 'ACTIVE' }, password)
    auth.save({ userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', status: 'ACTIVE' }, password)
    const profiles = [
      { profileId: 'VIEW', name: '仅态势查看', baseRole: 'OPERATOR' as const, permissions: ['BUSINESS_READ' as const], menuPaths: ['/situation'] },
      { profileId: 'SCENE-ONLY', name: '仅场景编辑', baseRole: 'OPERATOR' as const, permissions: ['BUSINESS_READ' as const, 'SCENARIO_DRAFT_WRITE' as const], menuPaths: ['/scenarios'] },
      { profileId: 'BATCH-READ', name: '仅批次查看', baseRole: 'OPERATOR' as const, permissions: ['BUSINESS_READ' as const], menuPaths: ['/batches'] },
      { profileId: 'REPORT-READ', name: '仅报告查看', baseRole: 'OPERATOR' as const, permissions: ['BUSINESS_READ' as const], menuPaths: ['/reports'] },
      { profileId: 'ADMIN-SCOPE', name: '仅账号管理', baseRole: 'ADMIN' as const, permissions: ['BUSINESS_READ' as const, 'USER_ROLE_MAINTAIN' as const], menuPaths: ['/admin'] },
    ]
    expect(access.save({ version: 2, profiles, assignments: users.map((user, index) => ({ userId: user.userId, profileId: profiles[index]!.profileId })) }, 1)).toBe(true)
    const roleHeaders = async (username: string) => ({ ...headers, Cookie: (await login(username)).cookie })
    const admin = await roleHeaders('admin')
    const operator = await roleHeaders('operator')
    const view = await roleHeaders('view-only')
    const scene = await roleHeaders('scene-only')
    const batchReader = await roleHeaders('batch-reader')
    const reportReader = await roleHeaders('report-viewer')
    const scopedAdmin = await roleHeaders('admin-scope')

    for (const path of ['/api/v1/scenarios', '/api/v1/templates', '/api/v1/reports', '/api/v1/simulations', '/api/v1/batches', '/api/v1/replays', '/api/v1/mission-results']) {
      await api.get(path).set(admin).expect(200)
      await api.get(path).set(operator).expect(200)
    }
    await api.post('/api/v1/scripts/preview').set(admin).send({}).expect(422)
    await api.post('/api/v1/scripts/preview').set(operator).send({}).expect(422)
    await api.post('/api/v1/simulations').set(admin).send({}).expect(422)
    await api.post('/api/v1/simulations').set(operator).send({}).expect(422)
    const deniedReads = ['/api/v1/scenarios', '/api/v1/templates', '/api/v1/reports', '/api/v1/batches', '/api/v1/replays', '/api/v1/mission-results']
    expect(await Promise.all(deniedReads.map(async path => [path, (await api.get(path).set(view)).status]))).toEqual(deniedReads.map(path => [path, 403]))
    await api.get('/api/v1/simulations').set(view).expect(200)
    await api.post('/api/v1/simulations').set(view).send({}).expect(403)
    await api.post('/api/v1/batches').set(view).send({}).expect(403)
    await api.post('/api/v1/replays/REPLAY-001/commands').set(view).send({}).expect(403)
    await api.post('/api/v1/scripts/preview').set(view).send({}).expect(403)
    await api.post('/api/v1/templates/TPL-SCN-001/copy').set(view).send({ name: '副本' }).expect(403)
    await api.post('/api/v1/scripts/preview').set(scene).send({}).expect(422)
    await api.get('/api/v1/templates').set(scene).expect(200)
    await api.get('/api/v1/scenarios').set(scene).expect(200)
    await api.get('/api/v1/simulations').set(scene).expect(403)
    await api.get('/api/v1/batches').set(batchReader).expect(200)
    await api.post('/api/v1/batches').set(batchReader).send({}).expect(403)
    await api.get('/api/v1/reports').set(reportReader).expect(200)
    await api.get('/api/v1/mission-results').set(reportReader).expect(200)
    await api.post('/api/v1/reports/RPT-001/export').set(reportReader).send({ reportId: 'RPT-001', format: 'PDF' }).expect(403)
    await api.get('/api/v1/admin/users').set(operator).expect(403)
    await api.get('/api/v1/admin/users').set(admin).expect(200)
    await api.get('/api/v1/admin/audit').set(operator).expect(403)
    await api.get('/api/v1/admin/audit').set(admin).expect(200)
    await api.post('/api/v1/templates').set(operator).send({}).expect(403)
    await api.post('/api/v1/templates').set(admin).send({}).expect(422)
    await api.get('/api/v1/admin/users').set(scopedAdmin).expect(200)
    await api.get('/api/v1/admin/audit').set(scopedAdmin).expect(403)
    await api.get('/api/v1/admin/master-data').set(scopedAdmin).expect(403)
    await api.post('/api/v1/templates').set(scopedAdmin).send({}).expect(403)
    await api.post('/api/v1/reports/RPT-001/export').set(scopedAdmin).send({ reportId: 'RPT-001', format: 'PDF' }).expect(403)
  })

  it('场景读取按菜单限制、模板复制按草稿权限；报告等级只取服务端报告', async () => {
    const { api, login, access, auth } = await start()
    const users = [
      { userId: 'USR-NO-SCENE', username: 'no-scene', role: 'OPERATOR' as const },
      { userId: 'USR-SCENE', username: 'scene-writer', role: 'OPERATOR' as const },
      { userId: 'USR-REPORT', username: 'report-reader', role: 'ADMIN' as const },
      { userId: 'USR-LEVEL3', username: 'level3-reader', role: 'ADMIN' as const },
    ]
    for (const user of users) auth.save({ ...user, status: 'ACTIVE' }, password)
    const profiles = [
      { profileId: 'NO-SCENE', name: '无场景菜单', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: ['/situation'] },
      { profileId: 'SCENE', name: '场景编辑', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'], menuPaths: ['/scenarios'] },
      { profileId: 'REPORT', name: '普通报告', baseRole: 'ADMIN', permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN', 'ORDINARY_REPORT_EXPORT'], menuPaths: ['/reports', '/admin'] },
      { profileId: 'LEVEL3', name: '三级报告', baseRole: 'ADMIN', permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN', 'BATCH_LEVEL_III_EXPORT'], menuPaths: ['/reports', '/admin'] },
    ]
    expect(access.save({ version: 2, profiles, assignments: users.map((user, index) => ({ userId: user.userId, profileId: profiles[index]!.profileId })) }, 1)).toBe(true)
    const denied = { ...headers, Cookie: (await login('no-scene')).cookie }
    await api.get('/api/v1/scenarios').set(denied).expect(403)
    await api.get('/api/v1/scenarios/SCN-001').set(denied).expect(403)
    const writer = { ...headers, Cookie: (await login('scene-writer')).cookie }
    await api.get('/api/v1/scenarios').set(writer).expect(200)
    await api.get('/api/v1/scenarios/SCN-001').set(writer).expect(200)
    await api.post('/api/v1/templates/TPL-SCN-001/copy').set(writer).send({ name: '场景副本' }).expect(201)
    await api.delete('/api/v1/templates/TPL-SCN-001').set(writer).expect(403)
    const ordinary = { ...headers, Cookie: (await login('report-reader')).cookie }
    await api.post('/api/v1/reports/RPT-BATCH-001/export').set(ordinary)
      .send({ reportId: 'RPT-BATCH-001', format: 'PDF' }).expect(403)
    await api.post('/api/v1/reports/RPT-BATCH-001/export').set(ordinary)
      .send({ reportId: 'RPT-BATCH-001', format: 'PDF', classification: 'LEVEL_II' }).expect(403)
    await api.post('/api/v1/reports/RPT-001/export').set(ordinary)
      .send({ reportId: 'RPT-001', format: 'PDF', classification: 'LEVEL_III' }).expect(422)
    const level3 = { ...headers, Cookie: (await login('level3-reader')).cookie }
    await api.post('/api/v1/reports/RPT-BATCH-001/export').set(level3)
      .send({ reportId: 'RPT-BATCH-001', format: 'PDF' }).expect(428)
  })

  it('空配置保持既有权限，显式分配后撤销旧会话并按菜单及操作收窄，持久化可重读', async () => {
    const { api, login, access, auth, file } = await start()
    expect(access.load()).toEqual({ version: 1, profiles: [], assignments: [] })
    const admin = await login('admin')
    expect(admin.principal.menuPaths).toBeUndefined()
    const adminHeaders = { ...headers, Cookie: admin.cookie }
    await api.post('/api/v1/admin/users').set(adminHeaders).send({ operation: 'CREATE', user: { userId: 'USR-READ', username: 'reader', role: 'OPERATOR', status: 'ACTIVE' }, password }).expect(201)
    const old = await login('reader')
    const config = { version: 1, profiles: [profile], assignments: [{ userId: 'USR-READ', profileId: 'READ' }] }
    const saved = await api.put('/api/v1/admin/access-control').set(adminHeaders).send(config).expect(200)
    expect(saved.body.data.version).toBe(2)
    expect((await api.get('/api/v1/auth/session').set({ ...headers, Cookie: old.cookie })).body.data.authenticated).toBe(false)
    const reader = await login('reader')
    expect(reader.principal.permissions).toEqual(['BUSINESS_READ'])
    expect(reader.principal.menuPaths).toEqual(['/situation'])
    const readerHeaders = { ...headers, Cookie: reader.cookie }
    await api.put('/api/v1/scenarios/SCN-001').set(readerHeaders).send({}).expect(403)
    await api.get('/api/v1/reports').set(readerHeaders).expect(403)
    await api.get('/api/v1/admin/access-control').set(readerHeaders).expect(403)
    expect((await api.get('/api/v1/auth/permissions').set(readerHeaders)).body.data.permissions).toEqual(['BUSINESS_READ'])
    expect((await api.get('/api/v1/auth/session').set(adminHeaders)).body.data.principal).toEqual(admin.principal)
    await api.put('/api/v1/admin/access-control').set(adminHeaders).send(config).expect(409)
    await api.put('/api/v1/admin/access-control').set(adminHeaders).send({ ...config, version: 2, profiles: [{ ...profile, permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'] }] }).expect(422)
    await api.put('/api/v1/admin/access-control').set(adminHeaders).send({ ...config, version: 2, assignments: [{ userId: 'MISSING', profileId: 'READ' }] }).expect(422)
    const own = auth.list().find((user: { username: string }) => user.username === 'admin')
    await api.put('/api/v1/admin/access-control').set(adminHeaders).send({ ...config, version: 2, assignments: [{ userId: own.userId, profileId: 'READ' }] }).expect(403)
    const reopened = new AccessControlSqliteStorage(file)
    try { expect(reopened.load()).toEqual(saved.body.data) } finally { reopened.close() }
    expect(access.save(saved.body.data, 1)).toBe(false)
  })

  it('角色合同拒绝越权、未知及重复菜单；旧主体兼容，新主体准确限制', () => {
    expect(isRoleProfile(profile)).toBe(true)
    for (const change of [{ menuPaths: ['/admin'] }, { menuPaths: ['/missing'] }, { menuPaths: ['/situation', '/situation'] }, { permissions: [] }, { permissions: ['BUSINESS_READ', 'BACKUP_RESTORE'] }, { baseRole: ['OPERATOR'] }, { name: ' ' }]) expect(isRoleProfile({ ...profile, ...change })).toBe(false)
    expect(isRoleProfile({ ...profile, baseRole: 'ADMIN', permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'], menuPaths: ['/admin'] })).toBe(true)
    expect(isRoleProfile({ ...profile, baseRole: 'ADMIN' })).toBe(false)
    expect(isAccessControlConfig({ version: 1, profiles: [profile, profile], assignments: [] })).toBe(false)
    expect(isAccessControlConfig({ version: 1, profiles: [profile], assignments: [{ userId: 'U', profileId: 'MISSING' }] })).toBe(false)
    expect(canVisitMenu(null, '/situation')).toBe(false)
    const principal = { userId: 'U', username: 'u', role: 'OPERATOR' as const, permissions: [] }
    expect(canVisitMenu(principal, '/reports')).toBe(true)
    expect(canVisitMenu({ ...principal, menuPaths: ['/situation'] }, '/reports')).toBe(false)
  })
})

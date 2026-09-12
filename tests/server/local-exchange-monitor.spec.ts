// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import type { FileReadRecord } from '../../src/features/data-exchange/local-monitor'
const { DatabaseSync } = await import('node:' + 'sqlite')
const { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } = await import('node:' + 'fs')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { once } = await import('node:' + 'events')
const { default: request } = await import('super' + 'test')
const { LocalExchangeMonitor } = await import('../../server/local/' + 'exchange-monitor.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { isLocalMonitorSnapshot } = await import('../../src/features/data-exchange/local-monitor')
const directories: string[] = []
const monitors: InstanceType<typeof LocalExchangeMonitor>[] = []
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function open(path: string) {
  const monitor = new LocalExchangeMonitor(path)
  monitors.push(monitor)
  return monitor
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wrj-monitor-'))
  directories.push(dir)
  const path = join(dir, 'test.db')
  const db = new DatabaseSync(path)
  for (const name of ['scenarios', 'scenario_templates', 'users', 'audit_logs']) db.exec(`CREATE TABLE ${name}(id TEXT)`)
  db.close()
  return { dir, path, monitor: open(path) }
}

it('真实只读检查不创建丢失的数据库，空库、损坏及缺表不报健康', () => {
  const { path, monitor } = setup()
  const before = readFileSync(path)
  expect(monitor.snapshot()).toMatchObject({ service: 'HEALTHY', database: 'HEALTHY', records: [] })
  expect(readFileSync(path)).toEqual(before)
  const db = new DatabaseSync(path)
  db.exec('DROP TABLE users')
  db.close()
  expect(monitor.snapshot().database).toBe('ERROR')
  writeFileSync(path, 'broken')
  expect(monitor.snapshot().database).toBe('ERROR')
  rmSync(path)
  expect(monitor.snapshot().database).toBe('ERROR')
  expect(existsSync(path)).toBe(false)
})

it('成功/失败均持久化，重开库延续序号；页面最近 50 条但历史不删除、主库不变', async () => {
  const { dir, path, monitor } = setup()
  const before = readFileSync(path)
  const file = join(dir, 'positions.csv')
  writeFileSync(file, 'one\ntwo')
  const read = () => monitor.read('POSITIONS', file, async () => readFileSync(file, 'utf8'), (value: string) => ({ recordCount: value.split('\n').length, issueCount: 1 }))
  expect(await read()).toBe('one\ntwo')
  expect(monitor.snapshot().records[0]).toMatchObject({ fileName: 'positions.csv', status: 'SUCCESS', recordCount: 2, issueCount: 1, errorCode: null })
  rmSync(file)
  await expect(read()).rejects.toThrow()
  expect(monitor.snapshot().records[0]).toMatchObject({ status: 'ERROR', recordCount: null, issueCount: null, errorCode: 'LOCAL_READ_FAILED' })
  for (let i = 0; i < 51; i++) await monitor.read('INITIAL_NODES', file, async () => [], (value: unknown[]) => ({ recordCount: value.length, issueCount: 0 }))
  const snapshot = monitor.snapshot()
  expect(snapshot.records).toHaveLength(50)
  expect(isLocalMonitorSnapshot(snapshot)).toBe(true)
  expect(JSON.stringify(snapshot)).not.toContain(dir)
  monitor.close()
  monitor.close()
  const reopened = open(path)
  expect(reopened.snapshot().records).toEqual(snapshot.records)
  await reopened.read('LOCAL_REPLAY', file, async () => [], () => ({ recordCount: 0, issueCount: 0 }))
  expect(reopened.snapshot().records[0]?.sequence).toBe(54)
  const stored = new DatabaseSync(join(dir, 'exchange-records.db'), { readOnly: true })
  try {
    expect(stored.prepare('SELECT COUNT(*) AS count FROM exchange_records').get()?.count).toBe(54)
    expect(stored.prepare('SELECT status, error_code FROM exchange_records WHERE sequence = 2').get()).toMatchObject({ status: 'ERROR', error_code: 'LOCAL_READ_FAILED' })
  } finally { stored.close() }
  expect(readFileSync(path)).toEqual(before)
})

it('写锁失败不覆盖读取结果和原始异常，监控明确报错；锁解除后继续持久化', async () => {
  const { dir, monitor } = setup()
  const db = new DatabaseSync(join(dir, 'exchange-records.db'))
  try {
    db.exec('BEGIN IMMEDIATE')
    expect(await monitor.read('POSITIONS', 'file.csv', async () => 3, (value: number) => ({ recordCount: value, issueCount: 0 }))).toBe(3)
    expect(monitor.snapshot()).toMatchObject({ database: 'HEALTHY', recordStorage: 'ERROR', records: [] })
    const failure = new Error('original read failed')
    await expect(monitor.read('POSITIONS', 'file.csv', async () => { throw failure }, () => ({ recordCount: 0, issueCount: 0 }))).rejects.toBe(failure)
    db.exec('ROLLBACK')
    await monitor.read('POSITIONS', 'file.csv', async () => 4, (value: number) => ({ recordCount: value, issueCount: 0 }))
    expect(monitor.snapshot()).toMatchObject({ recordStorage: 'HEALTHY', records: [{ recordCount: 4 }] })
    db.exec('DROP TABLE exchange_records')
    expect(monitor.snapshot()).toMatchObject({ database: 'HEALTHY', recordStorage: 'ERROR', records: [] })
  } finally { db.close() }
})

it('并发读取按完成顺序落库，不重复序号；未完成读取不生成记录', async () => {
  const { path, monitor } = setup()
  let finish!: (value: number) => void
  const pending = monitor.read('POSITIONS', 'slow.csv', () => new Promise<number>(resolve => { finish = resolve }), (value: number) => ({ recordCount: value, issueCount: 0 }))
  expect(monitor.snapshot().records).toEqual([])
  await monitor.read('INITIAL_NODES', 'fast.csv', async () => 7, (value: number) => ({ recordCount: value, issueCount: 0 }))
  finish(8)
  await pending
  const another = open(path)
  expect(another.snapshot().records.map((row: FileReadRecord) => [row.sequence, row.fileName])).toEqual([[2, 'slow.csv'], [1, 'fast.csv']])
})

it('损坏的记录库拒绝启动而不是回退演示或清空历史', () => {
  const { dir, path, monitor } = setup()
  monitor.close()
  const recordsPath = join(dir, 'exchange-records.db')
  writeFileSync(recordsPath, 'corrupt database')
  expect(() => open(path)).toThrow()
  expect(readFileSync(recordsPath, 'utf8')).toBe('corrupt database')
  expect(() => open('relative.db')).toThrow('绝对路径')
  expect(() => open(recordsPath)).toThrow('不能作为场景主库')
})

it('本机监控接口按身份只读访问，纯 Mock 返回 null，异常不泄露路径', async () => {
  const { monitor } = setup()
  let broken = false
  const server = createMockServer({ loadExchangeMonitor: () => { if (broken) throw new Error('secret path'); return monitor.snapshot() } })
  const mock = createMockServer()
  try {
    for (const current of [server, mock]) if (!current.httpServer.listening) await once(current.httpServer, 'listening')
    const api = request(server.httpServer)
    const read = (url: string) => api.get(url).set('Origin', 'http://127.0.0.1:5173')
    const url = '/api/v1/data-exchange/monitor'
    for (const role of ['ADMIN', 'OPERATOR']) {
      const response = await read(url).set('X-Demo-Role', role).expect(200)
      expect(isLocalMonitorSnapshot(response.body.data)).toBe(true)
      expect(response.body.data.database).toBe('HEALTHY')
    }
    await read(url).expect(403)
    await read(url).set('X-Demo-Role', 'INVALID').expect(403)
    await read(`${url}?path=outside`).set('X-Demo-Role', 'OPERATOR').expect(400)
    broken = true
    const response = await read(url).set('X-Demo-Role', 'OPERATOR').expect(503)
    expect(JSON.stringify(response.body)).not.toContain('secret path')
    expect((await request(mock.httpServer).get(url).set('Origin', 'http://127.0.0.1:5173').set('X-Demo-Role', 'OPERATOR').expect(200)).body.data).toBeNull()
  } finally { await server.close(); await mock.close() }
})

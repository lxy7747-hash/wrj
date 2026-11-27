// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'

const { spawnSync } = await import('node:' + 'child_process')
const { EventEmitter, once } = await import('node:' + 'events')
const { createServer } = await import('node:' + 'http')
const { default: process } = await import('node:' + 'process')
const { setImmediate: nextTurn } = await import('node:' + 'timers/promises')
const { WebSocketServer } = await import('w' + 's')
const { EngineSnapshotClient } = await import('../../server/local/' + 'engine-snapshot-client.js')
const { createMissionConnectionLog, inspectMissionListener } = await import('../../server/local/' + 'mission-startup-diagnostics.js')
const run = { runId: 'RUN-STARTUP', taskId: 'TASK-STARTUP' }
const prefix = '[Mission启动诊断] '
function capture() {
  const entries: Array<Record<string, unknown>> = []
  return { entries, report: (line: string) => entries.push(JSON.parse(line.slice(prefix.length))) }
}
afterEach(() => vi.restoreAllMocks())

it('首连被拒、重试遇到 HTTP 503、随后握手成功，逐次记入本次运行日志', async () => {
  const http = createServer()
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const port = http.address().port
  await new Promise<void>(resolve => http.close(() => resolve()))
  const ws = new WebSocketServer({ noServer: true })
  let upgrades = 0
  http.on('upgrade', (request: unknown, socket: { end(data: string): void }, head: unknown) => {
    if (++upgrades === 1) socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    else ws.handleUpgrade(request, socket, head, (peer: unknown) => ws.emit('connection', peer, request))
  })
  const { entries, report } = capture()
  const address = `ws://127.0.0.1:${port}/ws/v1`
  const client = new EngineSnapshotClient(address + '?token=private-test-value', vi.fn(), vi.fn(), undefined, async () => false)
  try {
    client.start(run, {}, process.pid, report)
    await vi.waitFor(() => expect(entries).toContainEqual(expect.objectContaining({
      ...run, event: '引擎链路推送连接失败', ws: address, pid: process.pid, process: '运行中', attempt: 1,
      code: 'ECONNREFUSED', error: expect.stringContaining('ECONNREFUSED'),
    })), { timeout: 5_000 })
    await vi.waitFor(() => expect(entries).toContainEqual(expect.objectContaining({
      event: '端口监听采样', listener: process.platform === 'win32' ? `本机 TCP ${port} 未监听` : expect.any(String),
    })), { timeout: 5_000 })
    http.listen(port, '127.0.0.1')
    await once(http, 'listening')
    await vi.waitFor(() => expect(client.diagnostics.connected).toBe(true), { timeout: 7_000 })
    const refused = entries.find(entry => String(entry.error).includes('503'))
    const connected = entries.find(entry => entry.event === 'WebSocket 已连接')
    expect(Number(refused?.attempt)).toBeGreaterThan(1)
    expect(Number(connected?.attempt)).toBeGreaterThan(Number(refused?.attempt))
    expect(JSON.stringify(entries)).not.toContain('private-test-value')
    expect(upgrades).toBe(2)
  } finally {
    client.stop(run.runId)
    for (const socket of ws.clients) socket.terminate()
    await new Promise<void>(resolve => ws.close(() => resolve()))
    if (http.listening) await new Promise<void>(resolve => http.close(() => resolve()))
  }
})

it('慢握手之后卡在首帧，限频窗口结束后更新监听 PID，全程只有一次 TCP 连接', async () => {
  const http = createServer(), ws = new WebSocketServer({ noServer: true })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const port = http.address().port
  const { entries, report } = capture()
  const events = new EventEmitter(), connections = vi.fn()
  const client = new EngineSnapshotClient(`ws://127.0.0.1:${port}/ws`, vi.fn(), (line: string) => {
    report(line)
    const entry = entries.at(-1)!
    events.emit(entry.event, entry)
  }, undefined, async () => false)
  http.on('connection', connections)
  const upgrade = once(http, 'upgrade')
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  try {
    client.start(run, {}, process.pid)
    const [request, peer, head] = await upgrade
    const firstSample = once(events, '端口监听采样')
    await vi.advanceTimersByTimeAsync(5_000)
    await firstSample
    expect(entries.some(entry => entry.event === '仍在等待 WebSocket 握手')).toBe(true)
    const opened = once(events, 'WebSocket 已连接')
    ws.handleUpgrade(request, peer, head, (socket: unknown) => ws.emit('connection', socket, request))
    await opened
    await vi.advanceTimersByTimeAsync(5_000)
    expect(entries).toContainEqual(expect.objectContaining({
      event: '已连接，仍在等待首个完整帧', pid: process.pid, process: '运行中', attempt: 1,
    }))
    expect(entries.filter(entry => entry.event === '端口监听采样')).toHaveLength(1)
    const refreshed = once(events, '端口监听采样')
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await refreshed)[0]).toMatchObject({
      listener: process.platform === 'win32' ? expect.stringContaining(`127.0.0.1:${port} PID=${process.pid}`) : expect.any(String),
    })
    expect(connections).toHaveBeenCalledOnce()
    client.stop(run.runId)
    const count = entries.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(entries).toHaveLength(count)
  } finally {
    client.stop(run.runId)
    vi.useRealTimers()
    for (const socket of ws.clients) socket.terminate()
    await new Promise<void>(resolve => ws.close(() => resolve()))
    await new Promise<void>(resolve => http.close(() => resolve()))
  }
})

it('监听表查询限频且不并发，能区分进程退出、权限不足，忽略已结束运行的迟到结果', async () => {
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
  expect(child.status).toBe(0)
  let now = Date.now(), active = true
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  let complete!: (value: string) => void
  const pending = () => new Promise<string>(resolve => { complete = resolve })
  const inspect = vi.fn().mockImplementationOnce(pending)
    .mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' })).mockImplementationOnce(pending)
  const { entries, report } = capture()
  const notify = createMissionConnectionLog(run, child.pid, new URL('ws://localhost:8080/ws'), report, () => active, inspect)
  notify(1, '失败', {}, true)
  now += 15_000
  notify(2, '失败', {}, true)
  expect(inspect).toHaveBeenCalledTimes(1)
  complete('未监听')
  await nextTurn()
  notify(3, '失败', {}, true)
  await nextTurn()
  expect(entries).toContainEqual(expect.objectContaining({ attempt: 3, process: '已退出', listener: '监听状态未知（EACCES）' }))
  notify(4, '失败', {}, true)
  expect(inspect).toHaveBeenCalledTimes(2)
  now += 10_000
  notify(5, '失败', {}, true)
  active = false
  complete('迟到结果')
  await nextTurn()
  expect(entries.filter(entry => entry.event === '失败')).toHaveLength(5)
  expect(entries.some(entry => entry.listener === '迟到结果')).toBe(false)
  await expect(inspectMissionListener(new URL('wss://engine.invalid/ws'))).resolves.toContain('无法在本机核实 TCP 443')
})

// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../../server/ws/realtime.js', { spy: true })
const { attachRealtimeServer } = await import('../../server/ws/' + 'realtime.js')
const { createMockServer } = await import('../../server/' + 'app.js')
const { once } = await import('node:' + 'events')
const { default: request } = await import('super' + 'test')
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
afterEach(() => vi.restoreAllMocks())

it.each(['mission', 'realtime', 'both'])('%s 关闭失败仍关闭 HTTP，保留错误，重试仅处理失败步骤', async failure => {
  const missionError = new Error('mission stop failed')
  const realtimeError = new Error('realtime close failed')
  const stop = vi.fn().mockResolvedValue(undefined)
  if (failure !== 'realtime') stop.mockRejectedValueOnce(missionError)
  const completed = new Promise(() => {})
  const server = createMockServer({ port: 0, missionExecution: { start: async () => ({
    pid: 9876, startedAt: '2026-09-24T00:00:00Z', entryPath: 'test/mission.txt', completed, stop,
  }) } })
  const controller = vi.mocked(attachRealtimeServer).mock.results.at(-1)!.value
  const originalClose = controller.close.bind(controller)
  const realtimeClose = vi.spyOn(controller, 'close').mockImplementation(originalClose)
  if (failure !== 'mission') realtimeClose.mockRejectedValueOnce(realtimeError)
  const drained = vi.fn()
  server.httpServer.once('close', drained)
  try {
    await once(server.httpServer, 'listening')
    const api = request(server.httpServer)
    const created = await api.post('/api/v1/simulations').set(headers).send({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).expect(201)
    await api.post(`/api/v1/simulations/${created.body.data.runId}/commands`).set(headers).send({ command: 'START', mode: 'INTERACTIVE_SINGLE' }).expect(200)
    const first = server.close()
    expect(server.close()).toBe(first)
    if (failure === 'both') await expect(first).rejects.toMatchObject({ errors: [missionError, realtimeError] })
    else await expect(first).rejects.toBe(failure === 'mission' ? missionError : realtimeError)
    expect(server.httpServer.listening).toBe(false)
    expect(drained).toHaveBeenCalledOnce()
    await expect(server.close()).resolves.toBeUndefined()
    await expect(server.close()).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(failure === 'realtime' ? 1 : 2)
    expect(realtimeClose).toHaveBeenCalledTimes(failure === 'mission' ? 1 : 2)
    expect(drained).toHaveBeenCalledOnce()
  } finally { await server.close() }
})

it('HTTP 在途请求结束后才触发存储释放', async () => {
  let finish!: (value: unknown) => void
  const pending = new Promise(resolve => { finish = resolve })
  const loadInitialNodes = vi.fn(() => pending)
  const server = createMockServer({ port: 0, loadInitialNodes })
  const released = vi.fn()
  server.httpServer.once('close', released)
  try {
    await once(server.httpServer, 'listening')
    const response = request(server.httpServer).get('/api/v1/situation/initial-nodes').set(headers).then((value: unknown) => value)
    // 确认请求已进入处理器，再开始关闭，不能仅靠等待时间猜测在途状态。
    await vi.waitFor(() => expect(loadInitialNodes).toHaveBeenCalledOnce())
    const closing = server.close()
    await vi.waitFor(() => expect(server.httpServer.listening).toBe(false))
    expect(released).not.toHaveBeenCalled()
    finish(null)
    await response
    await closing
    expect(released).toHaveBeenCalledOnce()
  } finally { finish(null); await server.close() }
})

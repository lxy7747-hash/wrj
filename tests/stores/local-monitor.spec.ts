import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useDataExchangeStore } from '../../src/stores/data-exchange'
import { isLocalMonitorSnapshot, type LocalMonitorSnapshot } from '../../src/features/data-exchange/local-monitor'

const snapshot = (): LocalMonitorSnapshot => ({ service: 'HEALTHY', database: 'HEALTHY', recordStorage: 'HEALTHY', checkedAt: '2026-09-12T00:00:00Z', records: [{
  sequence: 1, operation: 'POSITIONS', fileName: 'positions.csv', completedAt: '2026-09-12T00:00:00Z', durationMs: 2,
  status: 'SUCCESS', recordCount: 3, issueCount: 0, errorCode: null,
}] })
const response = (data: unknown) => new Response(JSON.stringify({ ok: true, data }))
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('公开动作展示真实、数据库异常及纯 Mock 状态；网络失败清除旧记录', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response(snapshot()))
    .mockResolvedValueOnce(response({ ...snapshot(), database: 'ERROR' })).mockResolvedValueOnce(response(null))
    .mockRejectedValueOnce(new Error('network'))
  vi.stubGlobal('fetch', fetcher)
  const store = useDataExchangeStore()
  expect(await store.loadMonitor()).toBe(true)
  expect(store.monitor?.records).toHaveLength(1)
  expect(await store.loadMonitor()).toBe(true)
  expect(store.monitorMessage).toContain('SQLite 检查失败')
  expect(await store.loadMonitor()).toBe(true)
  expect(store.monitor).toBeNull()
  expect(await store.loadMonitor()).toBe(false)
  expect(store.monitorState).toBe('ERROR')
  expect(store.monitor).toBeNull()
})

it('记录库故障单独展示，不将主库正常误认为写记录成功', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ ...snapshot(), recordStorage: 'ERROR' }))
    .mockResolvedValueOnce(response(snapshot())))
  const store = useDataExchangeStore()
  expect(await store.loadMonitor()).toBe(true)
  expect(store.monitor?.database).toBe('HEALTHY')
  expect(store.monitorMessage).toContain('交换记录存储异常')
  expect(await store.loadMonitor()).toBe(true)
  expect(store.monitorMessage).toBe('')
})

it.each([
  (v: any) => { v.database = ['HEALTHY'] },
  (v: any) => { v.recordStorage = ['HEALTHY'] },
  (v: any) => { v.records[0].operation = ['POSITIONS'] },
  (v: any) => { v.database = 'UNKNOWN' },
  (v: any) => { v.recordStorage = 'UNKNOWN' },
  (v: any) => { delete v.recordStorage },
  (v: any) => { v.extra = true },
  (v: any) => { v.records[0].sequence = 0 },
  (v: any) => { v.records.push(v.records[0]) },
  (v: any) => { v.records[0].fileName = 'C:/secret/file' },
  (v: any) => { v.records[0].durationMs = -1 },
  (v: any) => { v.records[0].recordCount = 1.2 },
  (v: any) => { v.records[0].errorCode = 'FAKE' },
  (v: any) => { v.records[0].completedAt = '2027-01-01T00:00:00Z' },
  (v: any) => { v.records[0].operation = 'OTHER' },
  (v: any) => { v.records = new Array(51).fill(v.records[0]) },
])('非法响应被正式加载入口拒绝，不保留旧成功数据 %#', async mutate => {
  const value = snapshot()
  mutate(value)
  expect(isLocalMonitorSnapshot(value)).toBe(false)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(snapshot())).mockResolvedValueOnce(response(value)))
  const store = useDataExchangeStore()
  await store.loadMonitor()
  expect(await store.loadMonitor()).toBe(false)
  expect(store.monitor).toBeNull()
  expect(store.monitorState).toBe('ERROR')
})

it.each(['request', 'body'] as const)('%s 挂起有界超时，重试成功后迟到响应不回写', async phase => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let finish!: () => void
  const old = snapshot()
  old.database = 'ERROR'
  const fetcher = vi.fn().mockResolvedValueOnce(response(snapshot()))
    .mockImplementationOnce(() => phase === 'request'
      ? new Promise<Response>(resolve => { finish = () => resolve(response(old)) })
      : Promise.resolve({ ok: true, json: () => new Promise(resolve => { finish = () => resolve({ ok: true, data: old }) }) }))
    .mockResolvedValueOnce(response(snapshot()))
  vi.stubGlobal('fetch', fetcher)
  const store = useDataExchangeStore()
  expect(await store.loadMonitor()).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  const pending = store.loadMonitor()
  await vi.advanceTimersByTimeAsync(4999)
  expect(store.monitorState).toBe('LOADING')
  expect(await store.loadMonitor()).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await pending).toBe(false)
  expect(store.monitorState).toBe('ERROR')
  expect(store.monitor).toBeNull()
  expect(store.monitorMessage).toContain('重试')
  expect(fetcher.mock.calls[1]![1].signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  expect(await store.loadMonitor()).toBe(true)
  finish()
  await flushPromises()
  expect(store.monitor).toEqual(snapshot())
  expect(store.monitorState).toBe('SUCCESS')
  expect(store.monitorMessage).toBe('')
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  ['request', 'clearMonitor'], ['body', 'clearMonitor'],
  ['request', 'resetToSafeEmpty'], ['body', 'resetToSafeEmpty'],
] as const)('%s 挂起时 %s 立即释放请求和计时器，迟到失败不污染重试', async (phase, action) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let reject!: (error: Error) => void
  const fetcher = vi.fn().mockImplementationOnce(() => phase === 'request'
    ? new Promise<Response>((_, fail) => { reject = fail })
    : Promise.resolve({ ok: true, json: () => new Promise((_, fail) => { reject = fail }) }))
    .mockResolvedValueOnce(response(snapshot()))
  vi.stubGlobal('fetch', fetcher)
  const store = useDataExchangeStore()
  const pending = store.loadMonitor()
  await flushPromises()
  store[action]()
  await flushPromises()
  expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  expect(await pending).toBe(false)
  expect(store.monitorState).toBe('EMPTY')
  expect(store.monitor).toBeNull()
  expect(store.monitorMessage).toBe('')
  expect(await store.loadMonitor()).toBe(true)
  reject(new Error('late'))
  await flushPromises()
  expect(store.monitor).toEqual(snapshot())
  expect(store.monitorState).toBe('SUCCESS')
  expect(vi.getTimerCount()).toBe(0)
})

it.each([false, true])('离页/登出清空后迟到响应不回写，轮询不重入（失败=%s）', async failed => {
  let finish!: (value: Response) => void
  let reject!: (error: Error) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve, fail) => { finish = resolve; reject = fail })))
  const store = useDataExchangeStore()
  const pending = store.loadMonitor()
  expect(await store.loadMonitor()).toBe(false)
  store.resetToSafeEmpty()
  if (failed) reject(new Error('late')); else finish(response(snapshot()))
  expect(await pending).toBe(false)
  expect(store.monitor).toBeNull()
  expect(store.monitorState).toBe('EMPTY')
})

it('解析响应期间离页也使请求失效；错误记录必须闭合', async () => {
  let resolve!: (value: unknown) => void
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(done => { resolve = done }) }))
  const store = useDataExchangeStore()
  const pending = store.loadMonitor()
  await flushPromises()
  store.clearMonitor()
  resolve({ ok: true, data: snapshot() })
  expect(await pending).toBe(false)
  const value = snapshot()
  Object.assign(value.records[0]!, { status: 'ERROR', recordCount: null, issueCount: null, errorCode: 'LOCAL_READ_FAILED' })
  expect(isLocalMonitorSnapshot(value)).toBe(true)
  value.records[0]!.recordCount = 1
  expect(isLocalMonitorSnapshot(value)).toBe(false)
})

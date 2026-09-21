import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HealthPanel from '../../src/components/admin/HealthPanel.vue'
import { useDataExchangeStore } from '../../src/stores/data-exchange'
import type { LocalMonitorSnapshot } from '../../src/features/data-exchange/local-monitor'

const snapshot = (): LocalMonitorSnapshot => ({ service: 'HEALTHY', database: 'HEALTHY', recordStorage: 'HEALTHY', checkedAt: '2026-09-21T00:00:00Z', records: [{
  sequence: 1, operation: 'POSITIONS', fileName: 'position.csv', completedAt: '2026-09-20T23:59:00Z', durationMs: 2,
  status: 'SUCCESS', recordCount: 3, issueCount: 1, errorCode: null,
}] })
const response = (data: unknown) => new Response(JSON.stringify({ ok: true, data }))
let wrapper: VueWrapper | undefined
async function mounted() { wrapper = mount(HealthPanel, { global: { plugins: [ElementPlus] } }); await flushPromises() }
function row(name: string) { return wrapper!.findAll('.el-table__row').find(item => item.find('td').text() === name)! }
async function refresh() { await wrapper!.findAll('button').find(item => item.text() === '刷新状态')!.trigger('click'); await flushPromises() }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.useRealTimers(); vi.unstubAllGlobals() })

describe('系统状态使用正式本机监测入口', () => {
  it('显示真实观测范围、最近读取时刻和未知项，按状态筛选；不调用旧 health 或读取源文件', async () => {
    const fetcher = vi.fn().mockImplementation(async () => response(snapshot()))
    vi.stubGlobal('fetch', fetcher)
    await mounted()
    expect(row('主数据库').text()).toContain('检查通过')
    expect(row('最近位置读取').text()).toContain('3 条有效记录，1 条异常记录')
    expect(row('最近位置读取').text()).toContain('2026-09-21 07:59:00')
    expect(wrapper!.get('[data-testid="health-observed-at"]').text()).toContain('2026-09-21 08:00:00')
    expect(row('仿真引擎').text()).toContain('暂无数据')
    expect(row('装备／角色权限／归档数据库').text()).toContain('暂无数据')
    expect(wrapper!.find('[data-testid="health-feedback"]').exists()).toBe(false)
    wrapper!.getComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', 'HEALTHY')
    await flushPromises()
    expect(wrapper!.findAll('.el-table__row')).toHaveLength(4)
    wrapper!.getComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', 'ERROR')
    await flushPromises()
    expect(wrapper!.text()).toContain('暂无匹配组件')
    await refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith('/api/v1/data-exchange/monitor'))).toBe(true)
  })

  it('最近失败覆盖同类旧成功，空记录及未监测项目不误报；数据库故障可恢复', async () => {
    const bad = snapshot()
    bad.database = bad.recordStorage = 'ERROR'
    bad.records.unshift({ ...bad.records[0]!, sequence: 2, completedAt: bad.checkedAt, status: 'ERROR', recordCount: null, issueCount: null, errorCode: 'LOCAL_READ_FAILED' })
    const fetcher = vi.fn().mockResolvedValueOnce(response(bad)).mockResolvedValue(response({ ...snapshot(), records: [] }))
    vi.stubGlobal('fetch', fetcher)
    await mounted()
    expect(row('最近位置读取').text()).toContain('读取失败')
    expect(row('最近位置读取').text()).toContain('LOCAL_READ_FAILED')
    expect(row('最近位置读取').text()).not.toContain('3 条有效记录')
    expect(row('主数据库').text()).toContain('异常')
    expect(wrapper!.get('[data-testid="health-feedback"]').text()).toContain('交换记录存储异常')
    await refresh()
    expect(row('主数据库').text()).toContain('检查通过')
    expect(row('最近位置读取').text()).toContain('暂无数据')
    expect(wrapper!.find('[data-testid="health-feedback"]').exists()).toBe(false)
  })

  it.each(['network', 'invalid', 'mock'] as const)('%s 不保留旧成功状态，错误与无证据区分显示', async kind => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(snapshot()))
    if (kind === 'network') fetcher.mockRejectedValue(new Error('offline'))
    else fetcher.mockResolvedValue(response(kind === 'mock' ? null : { ...snapshot(), database: ['HEALTHY'] }))
    vi.stubGlobal('fetch', fetcher)
    await mounted()
    await refresh()
    expect(row('主数据库').text()).toContain('暂无数据')
    expect(wrapper!.text()).not.toContain('position.csv')
    expect(wrapper!.find('[data-testid="health-feedback"]').exists()).toBe(kind !== 'mock')
    expect(useDataExchangeStore().monitorState).toBe(kind === 'mock' ? 'SUCCESS' : 'ERROR')
  })

  it('每五秒刷新，挂起请求不重入、超时后可重试；离页停止轮询', async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockImplementation(async () => response(snapshot()))
    vi.stubGlobal('fetch', fetcher)
    await mounted()
    expect(useDataExchangeStore().monitorState).toBe('LOADING')
    expect(wrapper!.findAll('button').find(item => item.text() === '刷新状态')!.attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(4999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5001)
    await flushPromises()
    expect(useDataExchangeStore().monitorState).toBe('SUCCESS')
    expect(fetcher.mock.calls.length).toBeGreaterThan(1)
    wrapper!.unmount(); wrapper = undefined
    const count = fetcher.mock.calls.length
    await vi.advanceTimersByTimeAsync(15000)
    expect(fetcher).toHaveBeenCalledTimes(count)
    expect(useDataExchangeStore().monitor).toBeNull()
  })

  it('离页取消在途请求，迟到响应不能恢复状态；返回只启动一轮轮询', async () => {
    let resolve!: (value: Response) => void
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(done => { resolve = done }))
      .mockImplementation(async () => response(snapshot()))
    vi.stubGlobal('fetch', fetcher)
    await mounted()
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal
    wrapper!.unmount(); wrapper = undefined
    resolve(response(snapshot()))
    await flushPromises()
    expect(signal.aborted).toBe(true)
    expect(useDataExchangeStore().monitorState).toBe('EMPTY')
    expect(useDataExchangeStore().monitor).toBeNull()
    await mounted()
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})

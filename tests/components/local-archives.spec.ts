import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import ElementPlus, { ElMessage } from 'element-plus'
import ArchivePanel from '../../src/components/admin/ArchivePanel.vue'
import ReportsPage from '../../src/pages/reports/reports.vue'
import ReplaysPage from '../../src/pages/replays/replays.vue'
import { useAdminStore } from '../../src/stores/admin'
import { useAuthStore } from '../../src/stores/auth'
import { useReportStore } from '../../src/stores/report'
import { useReplayStore } from '../../src/stores/replay'
import { LOCAL_ARCHIVE } from '../fixtures/local-archive'
import { LOCAL_EXPORT } from '../fixtures/local-report'

vi.mock('../../src/components/situation/OfflineSituationMap.vue', () => ({ default: { template: '<div />' } }))
const success = (data: unknown): Response => ({ ok: true, json: async () => ({ ok: true, data,
  meta: { requestId: 'REQ-ARCH', generatedAt: '2026-09-21T00:00:00Z', page: 1, pageSize: 1, total: 1 } }) }) as Response
let wrapper: VueWrapper | undefined
beforeEach(() => { setActivePinia(createPinia()); useAuthStore().role = 'ADMIN' })
afterEach(() => { wrapper?.unmount(); wrapper = undefined; ElMessage.closeAll(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function mounted(component = ArchivePanel as object, path = '/admin?section=simulation-data') {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push(path)
  wrapper = mount(component, { global: { plugins: [ElementPlus, router] } })
  await flushPromises()
  return router
}
async function click(name: string) {
  await wrapper!.findAll('button').find(button => button.text() === name)!.trigger('click')
  await flushPromises()
}
describe('真实归档用户流程', () => {
  it('空库登记、列表、筛选、详情、回放与报告跳转通过正式 Store', async () => {
    const spy = vi.fn().mockResolvedValueOnce(success([])).mockResolvedValueOnce(success(LOCAL_ARCHIVE.record)).mockResolvedValue(success([LOCAL_ARCHIVE.record]))
    vi.stubGlobal('fetch', spy)
    const message = vi.spyOn(ElMessage, 'success')
    const router = await mounted()
    expect(wrapper!.get('[data-testid="archive-table"]').text()).toContain('暂无数据')
    await click('登记当前快照')
    await wrapper!.get('[data-testid="archive-name"]').setValue('真实测试快照')
    await click('确认登记')
    expect(JSON.parse(spy.mock.calls[1]![1].body)).toEqual({ name: '真实测试快照' })
    expect(message).toHaveBeenCalledTimes(1)
    expect(wrapper!.get('[data-testid="archive-table"]').text()).toContain('真实测试快照')
    await wrapper!.get('input[aria-label="归档检索"]').setValue('missing')
    expect(wrapper!.get('[data-testid="archive-table"]').text()).toContain('暂无数据')
    await wrapper!.get('input[aria-label="归档检索"]').setValue('')
    await click('详情')
    expect(wrapper!.get('[data-testid="archive-detail"]').text()).toContain(LOCAL_ARCHIVE.record.eventFile.sha256)
    await click('关闭')
    await click('历史回放')
    expect(router.currentRoute.value.query.archiveId).toBe(LOCAL_ARCHIVE.record.archiveId)
    expect(router.currentRoute.value.path).toBe('/replays')
    await click('评估报表')
    expect(router.currentRoute.value.path).toBe('/reports')
    await click('刷新归档')
    expect(spy.mock.calls.at(-1)![0]).toContain('/admin/local-archives')
  })
  it.each(['invalid', 'duplicate', 'failure', 'operator'])('坏响应或权限失败清空旧目录：%s', async mode => {
    const store = useAdminStore()
    const spy = vi.fn().mockResolvedValue(success([LOCAL_ARCHIVE.record])); vi.stubGlobal('fetch', spy)
    expect(await store.loadLocalArchives()).toBe(true)
    if (mode === 'operator') useAuthStore().role = 'OPERATOR'
    else if (mode === 'failure') spy.mockRejectedValue(new Error('offline'))
    else spy.mockResolvedValue(success(mode === 'invalid' ? [{}] : [LOCAL_ARCHIVE.record, LOCAL_ARCHIVE.record]))
    expect(await store.loadLocalArchives()).toBe(false)
    expect(store.localArchives).toEqual([])
    expect(store.maintenance.archive.state).toBe('ERROR')
  })
  it('登记失败保留错误，可取消及关闭弹框；不显示成功浮层', async () => {
    const spy = vi.fn().mockResolvedValueOnce(success([LOCAL_ARCHIVE.record])).mockResolvedValue(success({}))
    vi.stubGlobal('fetch', spy)
    const message = vi.spyOn(ElMessage, 'success')
    await mounted()
    await click('详情')
    wrapper!.findAllComponents({ name: 'ElDialog' })[1]!.vm.$emit('close')
    await flushPromises()
    await click('登记当前快照')
    await wrapper!.get('[data-testid="archive-name"]').setValue('失败快照')
    await click('确认登记')
    expect(wrapper!.text()).toContain('归档登记响应格式不正确')
    expect(message).not.toHaveBeenCalled()
    await click('取消')
    await click('登记当前快照')
    wrapper!.findAllComponents({ name: 'ElDialog' })[0]!.vm.$emit('update:modelValue', false)
    await flushPromises()
    expect(wrapper!.findAllComponents({ name: 'ElDialog' })[0]!.props('modelValue')).toBe(false)
  })
  it('离页或登出后迟到登记不会继续查目录或回写', async () => {
    let resolve!: (response: Response) => void
    const spy = vi.fn(() => new Promise<Response>(done => { resolve = done })); vi.stubGlobal('fetch', spy)
    const store = useAdminStore(), pending = store.loadLocalArchives('在途')
    expect(await store.loadLocalArchives()).toBe(false)
    store.resetToSafeEmpty()
    resolve(success(LOCAL_ARCHIVE.record))
    expect(await pending).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(store.localArchives).toEqual([])
  })
  it('回放和报告重载保持归档来源，报告导出携带归档编号', async () => {
    const spy = vi.fn().mockResolvedValue(success(LOCAL_ARCHIVE)); vi.stubGlobal('fetch', spy)
    await mounted(ReplaysPage, `/replays?archiveId=${LOCAL_ARCHIVE.record.archiveId}`)
    expect(wrapper!.get('[data-testid="replay-archive-source"]').text()).toContain(LOCAL_ARCHIVE.record.archiveId)
    expect(useReplayStore().localSnapshot).toEqual(LOCAL_ARCHIVE.replay)
    await click('重新加载')
    expect(spy.mock.calls.every(([url]) => String(url).includes(`/archives/${LOCAL_ARCHIVE.record.archiveId}`))).toBe(true)
    wrapper!.unmount(); wrapper = undefined
    await mounted(ReportsPage, `/reports?archiveId=${LOCAL_ARCHIVE.record.archiveId}`)
    expect(wrapper!.get('[data-testid="report-archive-source"]').text()).toContain(LOCAL_ARCHIVE.record.archiveId)
    await click('重新加载')
    expect(useReportStore().selectedReport).toEqual(LOCAL_ARCHIVE.report)
    spy.mockResolvedValue(success(LOCAL_EXPORT))
    expect(await useReportStore().requestExport('HTML')).toBe(true)
    expect(spy.mock.calls.at(-1)![0]).toContain(`?archiveId=${LOCAL_ARCHIVE.record.archiveId}`)
  })
  it('切回当前报告后，迟到归档响应不恢复旧来源', async () => {
    let resolve!: (response: Response) => void
    const spy = vi.fn().mockImplementationOnce(() => new Promise<Response>(done => { resolve = done }))
      .mockResolvedValue(success([]))
    vi.stubGlobal('fetch', spy)
    const store = useReportStore()
    const pending = store.loadArchive(LOCAL_ARCHIVE.record.archiveId)
    expect(await store.load()).toBe(true)
    resolve(success(LOCAL_ARCHIVE))
    expect(await pending).toBe(false)
    expect(store.archiveId).toBeNull()
    expect(store.selectedReport).toBeNull()
    expect(store.capabilityState).toBe('EMPTY')
  })
  it('错误归档不保留旧报告或回放，不读取最新数据回退', async () => {
    const spy = vi.fn().mockResolvedValue(success(LOCAL_ARCHIVE)); vi.stubGlobal('fetch', spy)
    const reports = useReportStore(), replay = useReplayStore()
    expect(await reports.loadArchive(LOCAL_ARCHIVE.record.archiveId)).toBe(true)
    expect(await replay.loadLocalFile(LOCAL_ARCHIVE.record.archiveId)).toBe(true)
    spy.mockResolvedValue(success({ ...LOCAL_ARCHIVE, record: { ...LOCAL_ARCHIVE.record, archiveId: `ARCH-LOCAL-${'e'.repeat(64)}` } }))
    expect(await reports.loadArchive(LOCAL_ARCHIVE.record.archiveId)).toBe(false)
    expect(await replay.loadLocalFile(LOCAL_ARCHIVE.record.archiveId)).toBe(false)
    expect(reports.selectedReport).toBeNull()
    expect(replay.localSnapshot).toBeNull()
    expect(reports.capabilityState).toBe('ERROR')
    expect(replay.state).toBe('ERROR')
  })
})

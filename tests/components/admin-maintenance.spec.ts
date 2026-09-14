import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import MasterDataPanel from '../../src/components/admin/MasterDataPanel.vue'
import BackupRestoreWizard from '../../src/components/admin/BackupRestoreWizard.vue'
import ArchivePanel from '../../src/components/admin/ArchivePanel.vue'
import HealthPanel from '../../src/components/admin/HealthPanel.vue'
import ScenarioConfigExport from '../../src/components/scenarios/ScenarioConfigExport.vue'
import { useAdminStore } from '../../src/stores/admin'
import { useAuthStore } from '../../src/stores/auth'

let wrapper: VueWrapper | undefined

/** 根据中文按钮文字操作当前面板，避免依赖布局顺序。 */
async function click(text: string): Promise<void> {
  const button = wrapper!.findAll('button').find((item) => item.text() === text)
  expect(button).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}

describe('P7 系统管理面板', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.spyOn(useAdminStore(), 'loadMaintenance').mockResolvedValue(true)
  })
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; ElMessage.closeAll(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it.each([true, false])('主数据保存与删除通过真实 Store 反馈，成功=%s', async success => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    useAuthStore().role = 'ADMIN'
    const master = { dataId: 'DEVICE-FEEDBACK', kind: 'DEVICE', version: 1, referenceCount: 0, active: true }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-FEEDBACK', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: 1 },
    }) }) as Response
    const context = { confirmationId: 'CONF-MASTER', actor: 'admin', role: 'ADMIN', createdAt: fixtures.epoch, expiresAt: '2026-08-06T08:05:00Z' }
    const fetchMock = vi.fn().mockResolvedValueOnce(response([master]))
      .mockResolvedValueOnce(response(success ? { ...master, version: 2 } : {}))
      .mockResolvedValueOnce(response({ ...context, state: 'AWAITING_CONFIRMATION' }))
      .mockResolvedValueOnce(response({ ...context, state: 'CONFIRMED' }))
      .mockResolvedValueOnce(response({ deleted: success, objectId: master.dataId }))
      .mockResolvedValueOnce(response([]))
    vi.stubGlobal('fetch', fetchMock)
    const message = vi.spyOn(ElMessage, 'success')
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="master-feedback"]').exists()).toBe(false)
    expect(message).not.toHaveBeenCalled()
    await click('编辑')
    await click('保存')
    if (success) {
      expect(message).toHaveBeenCalledTimes(1)
      expect(message).toHaveBeenLastCalledWith('主数据已保存，当前版本 2。')
      expect(store.maintenance.master).toMatchObject({ state: 'SUCCESS', message: '' })
      expect(wrapper.find('[data-testid="master-feedback"]').exists()).toBe(false)
    } else {
      expect(wrapper.get('[data-testid="master-feedback"]').text()).toContain('保存结果与当前主数据不一致。')
      expect(message).not.toHaveBeenCalled()
      await click('取消')
    }
    await click('删除')
    if (success) {
      expect(message).toHaveBeenCalledTimes(2)
      expect(message).toHaveBeenLastCalledWith('主数据已删除。')
      expect(store.maintenance.master).toMatchObject({ state: 'SUCCESS', message: '' })
      expect(wrapper.find('[data-testid="master-feedback"]').exists()).toBe(false)
      expect(store.masterData).toEqual([])
    } else {
      expect(wrapper.get('[data-testid="master-feedback"]').text()).toContain('删除结果与当前对象不一致。')
      expect(message).not.toHaveBeenCalled()
      expect(store.masterData).toEqual([master])
    }
    await click('刷新')
    expect(wrapper.get('[data-testid="master-feedback"]').text()).toBe('暂无记录。')
    expect(message).toHaveBeenCalledTimes(success ? 2 : 0)
  })

  it('主数据空消息不渲染空白提示条', async () => {
    useAdminStore().maintenance.master = { state: 'EMPTY', message: '', fieldPath: '' }
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="master-feedback"]').exists()).toBe(false)
  })

  it.each([
    { section: 'master', component: MasterDataPanel, data: fixtures.masterData, content: 'MW-COMM', refresh: '刷新' },
    { section: 'backup', component: BackupRestoreWizard, data: fixtures.backups, content: 'PREBACKUP-002', refresh: '刷新记录' },
    { section: 'archive', component: ArchivePanel, data: [fixtures.archive], content: fixtures.archive.archiveId, refresh: '刷新归档' },
    { section: 'health', component: HealthPanel, data: fixtures.diagnostics, content: '前端界面', refresh: '刷新状态' },
  ] as const)('$section 加载成功不显示常驻提示，加载中和失败仍可见', async ({ section, component, data, content, refresh }) => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    useAuthStore().role = 'ADMIN'
    let resolveLoad!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveLoad = resolve }))
      .mockRejectedValueOnce(new Error('offline')))
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/admin')
    wrapper = mount(component, { global: { plugins: [ElementPlus, router] } })
    await flushPromises()
    expect(wrapper.get(`[data-testid="${section}-feedback"]`).text()).toContain('正在加载数据。')
    resolveLoad({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-MAINTENANCE', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: Array.isArray(data) ? data.length : 1 },
    }) } as Response)
    await flushPromises()
    expect(store.maintenance[section].state).toBe('SUCCESS')
    expect(store.maintenance[section].message).toBe('')
    expect(wrapper.find(`[data-testid="${section}-feedback"]`).exists()).toBe(false)
    expect(wrapper.get(`[data-testid="${section}-table"]`).text()).toContain(content)
    await click(refresh)
    expect(store.maintenance[section].state).toBe('ERROR')
    expect(wrapper.get(`[data-testid="${section}-feedback"]`).text()).toContain('系统管理服务暂时不可用，请稍后重试。')
  })

  it('主数据列表筛选、独立编辑、新增与删除确认复用既有组件', async () => {
    const store = useAdminStore()
    store.masterData = structuredClone(fixtures.masterData)
    const save = vi.spyOn(store, 'saveMasterData').mockResolvedValueOnce(false).mockResolvedValue(true)
    const run = vi.spyOn(store, 'runMaintenanceAction').mockResolvedValue(true)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(wrapper.text()).toContain('MW-COMM')
    await wrapper.get('input[aria-label="主数据检索"]').setValue('missing')
    expect(wrapper.text()).toContain('暂无匹配的主数据')
    await wrapper.get('input[aria-label="主数据检索"]').setValue('')
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'DEVICE')
    await flushPromises()
    expect(wrapper.text()).toContain('暂无匹配的主数据')
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', '')
    await flushPromises()
    await click('编辑')
    expect(wrapper.get('[data-testid="master-id"]').attributes('disabled')).toBeDefined()
    await click('保存')
    expect(save).toHaveBeenLastCalledWith(fixtures.masterData[0], false)
    await click('取消')
    await click('新增主数据')
    await wrapper.get('[data-testid="master-id"]').setValue(' DEVICE-P7 ')
    await click('保存')
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ dataId: 'DEVICE-P7', version: 1, referenceCount: 0 }), true)
    await click('删除')
    expect(run).not.toHaveBeenCalled()
    await click('删除')
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledWith('DELETE', 'MW-COMM')
    await click('刷新')
    expect(store.loadMaintenance).toHaveBeenCalledWith('master')
  })

  it('备份选择、取消操作和恢复证据不再包含配置导出入口', async () => {
    const store = useAdminStore()
    store.backups = structuredClone(fixtures.backups) as typeof store.backups
    const run = vi.spyOn(store, 'runMaintenanceAction').mockResolvedValue(true)
    vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    wrapper = mount(BackupRestoreWizard, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('创建备份')
    expect(wrapper.get('[data-testid="backup-table"]').text()).toContain('2026-08-06 18:08:00')
    expect(run).not.toHaveBeenCalled()
    await click('创建备份')
    expect(run).toHaveBeenLastCalledWith('BACKUP', '')
    await click('选择恢复')
    await click('恢复所选备份')
    expect(run).toHaveBeenLastCalledWith('RESTORE', 'PREBACKUP-002')
    store.restoreResult = { prebackupId: 'PREBACKUP-002', integrityValid: false, result: 'FAILURE', progress: 0, rolledBack: false, generated: false }
    await flushPromises()
    expect(wrapper.get('[data-testid="restore-result"]').text()).toContain('失败，恢复未开始')
    store.restoreResult = { ...store.restoreResult, integrityValid: true, progress: 100, rolledBack: true }
    await flushPromises()
    expect(wrapper.get('[data-testid="restore-result"]').text()).toContain('已回滚')
    store.restoreResult = { ...store.restoreResult, result: 'SUCCESS', rolledBack: false }
    expect(wrapper.find('[data-testid="full-config-export"]').exists()).toBe(false)
    await click('刷新记录')
    expect(store.loadMaintenance).toHaveBeenCalledWith('backup')
  })

  it('完整配置导出流程演示明确不导出当前场景，保留确认、分级、水印和时间', async () => {
    const store = useAdminStore()
    useAuthStore().role = 'ADMIN'
    const context = { confirmationId: 'CONF-EXPORT', actor: 'admin', role: 'ADMIN', createdAt: fixtures.epoch, expiresAt: '2026-08-06T08:05:00Z' }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-EXPORT', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: 1 },
    }) }) as Response
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ...context, state: 'AWAITING_CONFIRMATION' }))
      .mockResolvedValueOnce(response({ ...context, state: 'CONFIRMED' }))
      .mockResolvedValueOnce(response({ objectId: 'FULL-CONFIG', generated: false, classification: 'INTERNAL', watermark: '内部使用', verifiedAt: fixtures.epoch }))
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    wrapper = mount(ScenarioConfigExport, { global: { plugins: [ElementPlus] } })
    expect(wrapper.text()).toContain('不校验或导出当前场景内容')
    await click('确认并验证导出')
    expect(fetchMock).not.toHaveBeenCalled()
    await click('确认并验证导出')
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('不校验或导出当前场景内容'), '完整配置导出流程演示', expect.any(Object))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ action: 'FULL_CONFIG_EXPORT', objectId: 'FULL-CONFIG' })
    expect(fetchMock.mock.calls[2]![0]).toContain('/api/v1/admin/config/export')
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual({ format: 'JSON', confirmationId: 'CONF-EXPORT' })
    expect(store.fullConfigExport?.generated).toBe(false)
    expect(wrapper.text()).toContain('完整配置导出流程验证通过；未校验或导出当前场景内容，未生成实际文件。')
    for (const text of ['内部使用', '2026-08-06 16:00:00']) expect(wrapper.get('[data-testid="full-config-result"]').text()).toContain(text)
    expect(store.fullConfigExport?.verifiedAt).toBe(fixtures.epoch)
    for (const [classification, label] of [['INTERNAL', '内部使用'], ['LEVEL_II', '二级'], ['LEVEL_III', '三级']] as const) {
      store.fullConfigExport = { ...store.fullConfigExport!, classification }
      await flushPromises()
      expect(wrapper.get('[data-testid="full-config-result"] .el-descriptions__content').text()).toBe(label)
    }
  })

  it('场景配置导出对操作员隐藏，离页后迟到的确认不触发请求', async () => {
    const auth = useAuthStore()
    auth.role = 'OPERATOR'
    const run = vi.spyOn(useAdminStore(), 'runMaintenanceAction').mockResolvedValue(true)
    wrapper = mount(ScenarioConfigExport, { global: { plugins: [ElementPlus] } })
    expect(wrapper.find('[data-testid="full-config-export"]').exists()).toBe(false)
    auth.role = 'ADMIN'
    await flushPromises()
    let confirm!: () => void
    vi.spyOn(ElMessageBox, 'confirm').mockImplementation(() => new Promise(resolve => { confirm = () => resolve('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>) }))
    await click('确认并验证导出')
    wrapper.unmount()
    wrapper = undefined
    confirm()
    await flushPromises()
    expect(run).not.toHaveBeenCalled()
  })

  it('真实恢复成功后切换来源清除旧结果和成功反馈', async () => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    useAuthStore().$patch({ role: 'ADMIN' })
    const context = {
      confirmationId: 'CONF-P7', actor: 'admin', role: 'ADMIN',
      createdAt: fixtures.epoch, expiresAt: '2026-08-06T08:05:00Z',
    }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({
      ok: true, data, meta: { requestId: 'REQ-P7', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: 1 },
    }) }) as Response
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(fixtures.backups))
      .mockResolvedValueOnce(response({ ...context, state: 'AWAITING_CONFIRMATION' }))
      .mockResolvedValueOnce(response({ ...context, state: 'CONFIRMED' }))
      .mockResolvedValueOnce(response({ prebackupId: 'PREBACKUP-002', integrityValid: true, progress: 100, result: 'SUCCESS', rolledBack: false, generated: false }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    wrapper = mount(BackupRestoreWizard, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('选择恢复')
    await click('恢复所选备份')
    expect(store.restoreResult?.result).toBe('SUCCESS')
    expect(wrapper.get('[data-testid="restore-result"]').text()).toContain('成功')

    wrapper.getComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', 'BACKUP-CORRUPT-001')
    await flushPromises()
    expect(store.restoreResult).toBeNull()
    expect(wrapper.find('[data-testid="restore-result"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="backup-feedback"]').text()).not.toContain('验证通过')
    expect(store.maintenance.backup.state).toBe('EMPTY')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('归档详情复用索引编号并可进入关联报告', async () => {
    const store = useAdminStore()
    store.archives = [fixtures.archive] as typeof store.archives
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/admin?section=simulation-data')
    wrapper = mount(ArchivePanel, { global: { plugins: [ElementPlus, router] } })
    await flushPromises()
    await wrapper.get('input[aria-label="归档检索"]').setValue('missing')
    expect(wrapper.text()).toContain('暂无匹配归档')
    await wrapper.get('input[aria-label="归档检索"]').setValue('RPT-001')
    await click('详情')
    for (const value of Object.values(fixtures.archive).filter((item) => item !== 'INDEXED')) expect(wrapper.get('[data-testid="archive-detail"]').text()).toContain(value)
    await click('关闭')
    await click('详情')
    await click('查看关联报告')
    expect(router.currentRoute.value.fullPath).toBe('/reports?reportId=RPT-001')
    await click('刷新归档')
    expect(store.loadMaintenance).toHaveBeenCalledWith('archive')
  })

  it('健康状态显示接口四个组件，不把未接入标成健康', async () => {
    const store = useAdminStore()
    wrapper = mount(HealthPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(wrapper.text()).toContain('暂无匹配组件')
    store.health = fixtures.diagnostics as typeof store.health
    await flushPromises()
    expect(wrapper.findAll('.el-table__row')).toHaveLength(4)
    wrapper.getComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', 'NOT_CONNECTED_BY_DESIGN')
    await flushPromises()
    expect(wrapper.findAll('.el-table__row')).toHaveLength(3)
    expect(wrapper.get('[data-testid="health-table"]').text()).not.toContain('前端界面')
    await click('刷新状态')
    expect(store.loadMaintenance).toHaveBeenCalledWith('health')
  })
})

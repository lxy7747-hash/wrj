import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import MasterDataPanel from '../../src/components/admin/MasterDataPanel.vue'
import BackupRestoreWizard from '../../src/components/admin/BackupRestoreWizard.vue'
import ArchivePanel from '../../src/components/admin/ArchivePanel.vue'
import HealthPanel from '../../src/components/admin/HealthPanel.vue'
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
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals() })

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

  it('备份选择、取消操作、恢复证据与配置导出中文结果', async () => {
    const store = useAdminStore()
    store.backups = structuredClone(fixtures.backups) as typeof store.backups
    const run = vi.spyOn(store, 'runMaintenanceAction').mockResolvedValue(true)
    vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    wrapper = mount(BackupRestoreWizard, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('创建备份')
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
    store.fullConfigExport = { objectId: 'FULL-CONFIG', generated: false, classification: 'INTERNAL', watermark: '内部使用', verifiedAt: fixtures.epoch }
    await click('确认并验证导出')
    expect(run).toHaveBeenLastCalledWith('EXPORT', 'PREBACKUP-002')
    expect(wrapper.get('[data-testid="full-config-result"]').text()).toContain('内部使用')
    for (const [classification, label] of [['INTERNAL', '内部使用'], ['LEVEL_II', '二级'], ['LEVEL_III', '三级']] as const) {
      store.fullConfigExport = { ...store.fullConfigExport, classification }
      await flushPromises()
      expect(wrapper.get('[data-testid="full-config-result"] .el-descriptions__content').text()).toBe(label)
    }
    await click('刷新记录')
    expect(store.loadMaintenance).toHaveBeenCalledWith('backup')
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

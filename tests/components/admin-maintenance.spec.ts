import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import MasterDataPanel from '../../src/components/admin/MasterDataPanel.vue'
import BackupRestoreWizard from '../../src/components/admin/BackupRestoreWizard.vue'
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
    vi.spyOn(useAdminStore(), 'loadBackupPlan').mockResolvedValue(true)
  })
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; ElMessage.closeAll(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it.each([true, false])('主数据保存与删除通过真实 Store 反馈，成功=%s', async success => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    useAuthStore().role = 'ADMIN'
    const master = { dataId: 'DICT-FEEDBACK', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
      content: { name: '反馈字典', description: '', entries: [{ key: 'sample', valueType: 'TEXT' as const, value: 'value' }] } }
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

  it('主数据列表筛选、内容编辑、新增与删除确认复用既有组件', async () => {
    const store = useAdminStore()
    const writable = { dataId: 'DICT-UI', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
      content: { name: '界面参数', description: '', entries: [{ key: 'sample', valueType: 'TEXT' as const, value: 'value' }] } }
    store.masterData = [writable]
    const save = vi.spyOn(store, 'saveMasterData').mockResolvedValueOnce(false).mockResolvedValue(true)
    const run = vi.spyOn(store, 'runMaintenanceAction').mockResolvedValue(true)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(wrapper.text()).toContain('DICT-UI')
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
    expect(save).toHaveBeenLastCalledWith(writable, false)
    await click('取消')
    await click('新增主数据')
    await wrapper.get('[data-testid="master-id"]').setValue(' DEVICE-P7 ')
    await wrapper.get('[data-testid="master-name"]').setValue('新增字典')
    await click('新增条目')
    await wrapper.get('input[aria-label="参数键"]').setValue('enabled')
    await click('保存')
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ dataId: 'DEVICE-P7', version: 1, referenceCount: 0, content: expect.objectContaining({ name: '新增字典' }) }), true)
    await click('删除')
    expect(run).not.toHaveBeenCalled()
    await click('删除')
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledWith('DELETE', 'DICT-UI')
    await click('刷新')
    expect(store.loadMaintenance).toHaveBeenCalledWith('master')
  })

  it('主数据编辑副本支持数值和布尔条目切换，取消不污染原记录', async () => {
    const store = useAdminStore()
    const source = { dataId: 'DICT-TYPES', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
      content: { name: '类型测试', description: '', entries: [{ key: 'enabled', valueType: 'TEXT' as const, value: 'original' }] } }
    store.masterData = [structuredClone(source)]
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('编辑')
    const valueType = wrapper.findAllComponents({ name: 'ElSelect' }).find((component) => component.find('input[aria-label="参数值类型"]').exists())
    expect(valueType).toBeDefined()
    valueType!.vm.$emit('update:modelValue', 'NUMBER')
    await flushPromises()
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' }).length).toBeGreaterThan(0)
    valueType!.vm.$emit('update:modelValue', 'BOOLEAN')
    await flushPromises()
    expect(wrapper.text()).toContain('是')
    await click('取消')
    expect(store.masterData).toEqual([source])
  })

  it('主数据内容编辑支持文本、数值范围、布尔值和移除条目，数值清空不能保存', async () => {
    const store = useAdminStore()
    useAuthStore().role = 'ADMIN'
    const source = { dataId: 'DICT-ENTRY', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
      content: { name: '条目字典', description: '', entries: [{ key: 'mode', valueType: 'TEXT' as const, value: 'original' }] } }
    store.masterData = [structuredClone(source)]
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('编辑')
    await click('新增条目')
    const keys = wrapper.findAll('input[aria-label="参数键"]')
    await keys[keys.length - 1]!.setValue('retryLimit')
    const texts = wrapper.findAll('input[placeholder="文本值"]')
    await texts[texts.length - 1]!.setValue('three')
    const typeSelectors = wrapper.findAllComponents({ name: 'ElSelect' }).filter((component) => component.find('input[aria-label="参数值类型"]').exists())
    typeSelectors[typeSelectors.length - 1]!.vm.$emit('update:modelValue', 'NUMBER')
    await flushPromises()
    const numbers = wrapper.findAllComponents({ name: 'ElInputNumber' })
    numbers[0]!.vm.$emit('update:modelValue', 3)
    numbers[1]!.vm.$emit('update:modelValue', 0)
    numbers[2]!.vm.$emit('update:modelValue', 10)
    await wrapper.get('input[placeholder="单位（可选）"]').setValue('次')
    await flushPromises()
    numbers[0]!.vm.$emit('update:modelValue', undefined)
    await click('保存')
    expect(store.maintenance.master.state).toBe('ERROR')
    expect(fetchMock).not.toHaveBeenCalled()
    typeSelectors[typeSelectors.length - 1]!.vm.$emit('update:modelValue', 'BOOLEAN')
    await flushPromises()
    const switches = wrapper.findAllComponents({ name: 'ElSwitch' })
    switches[switches.length - 1]!.vm.$emit('update:modelValue', true)
    await click('移除')
    expect(wrapper.findAll('input[aria-label="参数键"]')).toHaveLength(1)
    await click('取消')
    expect(store.masterData).toEqual([source])
  })

  it('主数据详情显示实际历史和引用，确认后才登记并更新引用数量', async () => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    useAuthStore().role = 'ADMIN'
    const master = { dataId: 'DICT-DETAIL', kind: 'PARAMETER_DICTIONARY', version: 2, referenceCount: 0, active: true,
      content: { name: '版本字典', description: '当前版本。', entries: [{ key: 'mode', valueType: 'TEXT' as const, value: 'current' }] } }
    const historical = { ...master, version: 1, content: { ...master.content, description: '历史版本。', entries: [{ key: 'mode', valueType: 'TEXT' as const, value: 'history' }] } }
    const target = { targetType: 'SCENARIO' as const, targetId: 'SCN-DETAIL', targetVersion: '7', name: '详情场景' }
    const reference = { dataId: master.dataId, dataVersion: 1, targetType: target.targetType, targetId: target.targetId, targetVersion: target.targetVersion }
    const registered = { dataId: master.dataId, history: [{ ...master, referenceCount: 1 }, historical], references: [reference] }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-MASTER-DETAIL', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: Array.isArray(data) ? data.length : 1 },
    }) }) as Response
    const fetchMock = vi.fn().mockResolvedValueOnce(response([master])).mockResolvedValueOnce(response({ dataId: master.dataId, history: [master, historical], references: [] }))
      .mockResolvedValueOnce(response([target])).mockResolvedValueOnce(response(registered))
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValueOnce('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const message = vi.spyOn(ElMessage, 'success')
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('查看')
    const details = wrapper.findAll('[role="dialog"]').find((dialog) => dialog.isVisible())!
    await details.get('.el-table__expand-icon').trigger('click')
    await flushPromises()
    expect(details.text()).toContain('当前版本。')
    expect(details.get('[data-testid="master-history-table"]').text()).toContain('版本字典')
    expect(details.get('[data-testid="master-reference-table"]').text()).toContain('暂无引用记录')
    const selects = wrapper.findAllComponents({ name: 'ElSelect' })
    const versionSelect = selects.find((component) => component.find('input[aria-label="主数据版本"]').exists())
    const targetSelect = selects.find((component) => component.find('input[aria-label="引用目标"]').exists())
    expect(versionSelect).toBeDefined()
    expect(targetSelect).toBeDefined()
    versionSelect!.vm.$emit('update:modelValue', 1)
    targetSelect!.vm.$emit('update:modelValue', 'SCENARIO:SCN-DETAIL:7')
    await flushPromises()
    await click('登记引用')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await click('登记引用')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(wrapper.get('[data-testid="master-reference-table"]').text()).toContain('SCN-DETAIL')
    expect(store.masterData[0]?.referenceCount).toBe(1)
    expect(message).toHaveBeenCalledTimes(1)
    await click('关闭')
    expect(store.masterDetails).toBeNull()
    expect(store.masterTargets).toEqual([])
  })

  it('关闭主数据详情会使在途引用登记失效，迟到响应不会登记', async () => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    useAuthStore().role = 'ADMIN'
    const master = { dataId: 'DICT-LATE', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
      content: { name: '迟到字典', description: '', entries: [{ key: 'mode', valueType: 'TEXT' as const, value: 'current' }] } }
    const target = { targetType: 'SCENARIO' as const, targetId: 'SCN-LATE', targetVersion: '3', name: '迟到场景' }
    const reference = { dataId: master.dataId, dataVersion: 1, targetType: target.targetType, targetId: target.targetId, targetVersion: target.targetVersion }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-MASTER-LATE', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: Array.isArray(data) ? data.length : 1 },
    }) }) as Response
    let resolve!: (value: Response) => void
    const deferred = new Promise<Response>((res) => { resolve = res })
    const fetchMock = vi.fn().mockResolvedValueOnce(response([master])).mockResolvedValueOnce(response({ dataId: master.dataId, history: [master], references: [] }))
      .mockResolvedValueOnce(response([target])).mockReturnValueOnce(deferred)
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const message = vi.spyOn(ElMessage, 'success')
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('查看')
    const selects = wrapper.findAllComponents({ name: 'ElSelect' })
    selects.find((component) => component.find('input[aria-label="引用目标"]').exists())!.vm.$emit('update:modelValue', 'SCENARIO:SCN-LATE:3')
    await flushPromises()
    const register = wrapper.findAll('button').find((button) => button.text() === '登记引用')
    await register!.trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    await click('关闭')
    resolve(response({ dataId: master.dataId, history: [{ ...master, referenceCount: 1 }], references: [reference] }))
    await flushPromises()
    expect(store.masterDetails).toBeNull()
    expect(store.masterData[0]?.referenceCount).toBe(0)
    expect(message).not.toHaveBeenCalled()
  })

  it('备份选择、取消操作和恢复证据不再包含配置导出入口', async () => {
    const store = useAdminStore()
    store.backups = structuredClone(fixtures.backups) as typeof store.backups
    const run = vi.spyOn(store, 'runMaintenanceAction').mockResolvedValue(true)
    vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/admin')
    wrapper = mount(BackupRestoreWizard, { global: { plugins: [ElementPlus, router] } })
    await flushPromises()
    await click('创建备份')
    expect(wrapper.get('[data-testid="backup-table"]').text()).toContain('2026-08-06 18:08:00')
    expect(run).not.toHaveBeenCalled()
    await click('创建备份')
    expect(run).toHaveBeenLastCalledWith('BACKUP', '', '手动备份')
    await click('选择恢复')
    await click('恢复所选备份')
    expect(run).toHaveBeenLastCalledWith('RESTORE', 'PREBACKUP-002', undefined)
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

  it('Mock 恢复成功后切换来源清除旧结果和成功反馈', async () => {
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
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/admin')
    wrapper = mount(BackupRestoreWizard, { global: { plugins: [ElementPlus, router] } })
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

  it('SQLite 恢复通过正式 Store 流程执行确认，成功清空身份并提示重新登录', async () => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    const auth = useAuthStore()
    auth.$patch({ principal: { userId: 'USR-ADMIN', username: 'admin', role: 'ADMIN', permissions: ['BACKUP_RESTORE'] }, role: 'ADMIN' })
    const backup = { backupId: 'BACKUP-SQLITE', status: 'VALID', checksum: 'A'.repeat(64), createdAt: fixtures.epoch }
    const context = { confirmationId: 'CONF-SQLITE', actor: 'admin', role: 'ADMIN', createdAt: fixtures.epoch, expiresAt: '2026-08-06T08:05:00Z' }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-SQLITE', generatedAt: fixtures.epoch, page: 1, pageSize: 1, total: 1 },
    }) }) as Response
    const fetchMock = vi.fn().mockResolvedValueOnce(response([backup]))
      .mockResolvedValueOnce(response({ ...context, state: 'AWAITING_CONFIRMATION' }))
      .mockResolvedValueOnce(response({ ...context, state: 'CONFIRMED' }))
      .mockResolvedValueOnce(response({ prebackupId: 'PREBACKUP-SQLITE', integrityValid: true, progress: 100, result: 'SUCCESS', rolledBack: false, generated: true }))
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const message = vi.spyOn(ElMessage, 'success').mockReturnValue({ close: vi.fn() })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/admin')
    wrapper = mount(BackupRestoreWizard, { global: { plugins: [ElementPlus, router] } })
    await flushPromises()
    expect(wrapper.get('[data-testid="backup-table"]').text()).toContain('旧主库备份')
    await click('选择恢复')
    await click('恢复所选备份')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await click('恢复所选备份')
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('审计与文件读取记录保留'), '恢复备份', expect.anything())
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ operation: 'RESTORE', backupId: 'BACKUP-SQLITE', confirmationId: 'CONF-SQLITE' })
    expect(auth.principal).toBeNull()
    expect(router.currentRoute.value.path).toBe('/login')
    expect(message).toHaveBeenCalledWith('SQLite 数据已恢复，审计记录保留，请重新登录。')
  })


})
